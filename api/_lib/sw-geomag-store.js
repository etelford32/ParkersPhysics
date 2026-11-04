/**
 * api/_lib/sw-geomag-store.js — the ONE reader of sw_geomag_dataset history.
 *
 * SUPABASE_OFFLOAD_PLAN.md Phase C. Postgres keeps the last ~14 UTC days of
 * the minute dataset (the writer's self-healing window lives there); every
 * older day is a sealed NDJSON file in R2 (api/_lib/r2-archive.js) and
 * trim_sw_geomag_dataset() deletes a day only after its index row exists.
 * Every reader of minute history goes through here so a window that crosses
 * the cutover is answered from both stores without the caller knowing:
 *   - /api/ring-current/dataset (the public window, CSV + JSON)
 *   - api/cron/validation-rerun.js (the flux-rope Bz truth + upstream wind
 *     for real CME arrivals, and the outlook's per-day L1 coverage)
 *
 * Per-day, not per-row: a UTC day is all-in-Postgres or all-in-R2 (the trim
 * deletes whole sealed days; gap minutes are rows). R2 is consulted only for
 * days that START before now − R2_AFTER_DAYS, so recent windows never pay an
 * R2 round trip and behave exactly as before. With the R2 secrets unset this
 * module is the old Postgres read, nothing more.
 *
 * Rows from R2 are the PostgREST JSON that select=* returned when the day
 * was sealed, so both stores hand back the same spellings.
 */

import { fetchWithTimeout } from './responses.js';
import {
    R2_CONFIGURED, getGzText, parseNdjson, daysMissingFrom, mergeByT, mapLimit,
} from './r2-archive.js';

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

/** Days younger than this are always in Postgres (the trim keeps 14). */
export const R2_AFTER_DAYS = 13;
const PAGE_ROWS = 1000;
const DAY_MS = 86_400_000;

const headers = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` });

async function sbGet(path, timeoutMs = 10_000) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, { timeoutMs, headers: headers() });
    if (!res.ok) throw new Error(`dataset query HTTP ${res.status}`);
    return res.json();
}

/** PURE: keep only the columns of a PostgREST select list ('*' keeps all). */
export function project(row, select) {
    if (!select || select === '*') return row;
    const out = {};
    for (const k of select.split(',').map(s => s.trim()).filter(Boolean)) out[k] = row[k];
    return out;
}

/** PURE: which missing days are old enough that R2 may hold them. */
export function r2CandidateDays(missingDays, nowMs) {
    const cutoff = nowMs - R2_AFTER_DAYS * DAY_MS;
    return missingDays.filter(d => Date.parse(`${d}T00:00:00Z`) < cutoff);
}

async function sealedRows(days, { startMs, endMs, endInclusive, where, select }) {
    if (!days.length || !R2_CONFIGURED) return { rows: [], days: [] };
    const idx = await sbGet(`sw_geomag_archive?select=day,r2_key&day=in.(${days.join(',')})`);
    const got = await mapLimit(idx, 4, async (row) => {
        const text = await getGzText(row.r2_key, { timeoutMs: 12_000 });
        return text == null ? [] : parseNdjson(text);
    });
    const rows = [];
    for (const r of got.flat()) {
        const t = Date.parse(r.t);
        if (!(t >= startMs) || (endInclusive ? t > endMs : t >= endMs)) continue;
        if (where && !where(r)) continue;
        rows.push(project(r, select));
    }
    return { rows, days: idx.map(r => r.day) };
}

/**
 * Rows in [startMs, endMs) (or [startMs, endMs] with endInclusive), ascending.
 *
 * @param {object} q
 * @param {string} [q.select='*']      PostgREST select list
 * @param {string} [q.filter='']       extra PostgREST filter, e.g. '&sw_flag=eq.ok'
 * @param {(row)=>boolean} [q.where]   the SAME predicate as `filter`, for R2 rows
 * @returns {Promise<{rows: object[], r2Days: string[]}>}
 */
export async function readSwGeomag({
    startMs, endMs, endInclusive = false, select = '*', filter = '', where = null,
    maxRows = 20_000, nowMs = Date.now(),
}) {
    const a = encodeURIComponent(new Date(startMs).toISOString());
    const b = encodeURIComponent(new Date(endMs).toISOString());
    const sel = select === '*' ? '' : `&select=${select}`;
    let db = [];
    for (let offset = 0; offset < maxRows; offset += PAGE_ROWS) {
        const page = await sbGet(
            `sw_geomag_dataset?t=gte.${a}&t=${endInclusive ? 'lte' : 'lt'}.${b}${filter}${sel}` +
            `&order=t.asc&limit=${PAGE_ROWS}&offset=${offset}`);
        db = db.concat(page);
        if (page.length < PAGE_ROWS) break;
    }
    const want = r2CandidateDays(daysMissingFrom(db, startMs, endMs + (endInclusive ? 1 : 0)), nowMs);
    if (!want.length || !R2_CONFIGURED) return { rows: db, r2Days: [] };
    const sealed = await sealedRows(want, { startMs, endMs, endInclusive, where, select });
    return { rows: mergeByT(db, sealed.rows), r2Days: sealed.days };
}

/**
 * Rows of one sealed UTC day matching `where` — the outlook's coverage count
 * for a day Postgres no longer holds. null when the day is not sealed (or R2
 * is unconfigured), so the caller keeps its own "unknown" handling.
 */
export async function countSealedDay(day, where, { nowMs = Date.now() } = {}) {
    if (!R2_CONFIGURED || !r2CandidateDays([day], nowMs).length) return null;
    const start = Date.parse(`${day}T00:00:00Z`);
    const { rows, days } = await sealedRows([day], { startMs: start, endMs: start + DAY_MS, endInclusive: false, where, select: 't' });
    return days.length ? rows.length : null;
}
