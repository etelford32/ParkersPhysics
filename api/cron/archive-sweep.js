/**
 * Vercel Node Cron: /api/cron/archive-sweep — hourly at :40 (vercel.json)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The ONE writer of the R2 archive (SUPABASE_OFFLOAD_PLAN.md Phases B + C).
 * Each run, inside a fixed time budget:
 *
 *   1. WEATHER FRAMES — every weather_grid_cache row with no
 *      weather_grid_archive row is copied to R2 as one gzip object
 *      ({ fetched_at, source, payload }), NEWEST FIRST (range reads benefit
 *      first; the backlog drains over a few runs), and indexed.
 *   2. SEALED DAYS — every complete UTC day of sw_geomag_dataset (ended at
 *      least SEAL_AFTER_H ago, so the writer's 24 h deep rebuild has had its
 *      last pass over it) with no sw_geomag_archive row is written as one
 *      NDJSON gzip, OLDEST FIRST (the trim frees space from the old end),
 *      and indexed.
 *   3. TRIMS — trim_weather_grid_cache() and trim_sw_geomag_dataset(), which
 *      delete only what step 1/2 indexed (supabase-r2-offload-migration.sql).
 *
 * ORDER IS THE SAFETY: R2 PUT → index row → (later) trim. An index row is
 * never written for an upload that failed, so nothing reaches the trims that
 * is not in R2. With the R2 secrets unset this records a failed heartbeat
 * ('r2_archive', reason r2_not_configured) and touches nothing — Postgres
 * keeps behaving exactly as it did before the offload.
 *
 * Egress note: the BACKFILL reads each historical frame out of Supabase once
 * (~48 MB total over the first runs). After that a frame is read once, an
 * hour after it is written, and every range read is served from R2.
 *
 * Auth: x-vercel-cron, or Authorization: Bearer ${CRON_SECRET}.
 * Query: ?dry=1 lists what would be archived without writing.
 */

import { fetchWithTimeout } from '../_lib/responses.js';
import {
    R2_CONFIGURED, putGzText, toNdjson, weatherFrameKey, swGeomagDayKey,
} from '../_lib/r2-archive.js';
import { pressureKindOf } from '../../js/weather-decode.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

const PIPELINE      = 'r2_archive';
const BUDGET_MS     = 45_000;      // stop starting new work after this
const SEAL_AFTER_H  = 26;          // a day is sealed once it ended this long ago
const DAY_MS        = 86_400_000;
const PAGE_ROWS     = 1000;

// Same runtime-shaped header read as refresh-weather-grid.js (Node hands a
// plain object; .get() on it threw and killed archive-forecasts nightly).
function readHeader(request, name) {
    const h = request?.headers;
    if (!h) return '';
    if (typeof h.get === 'function') return h.get(name) ?? '';
    return h[name.toLowerCase()] ?? '';
}
function isAuthorized(request) {
    const hdr = readHeader(request, 'authorization');
    if (CRON_SECRET && hdr === `Bearer ${CRON_SECRET}`) return true;
    return !!readHeader(request, 'x-vercel-cron');
}
function queryParam(request, name) {
    try { return new URL(request.url, 'http://local').searchParams.get(name); }
    catch { return null; }
}

const sbHeaders = () => ({
    apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json',
});
async function sbGet(path, timeoutMs = 15_000) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, { timeoutMs, headers: sbHeaders() });
    if (!res.ok) throw new Error(`GET ${path.split('?')[0]} ${res.status}`);
    return res.json();
}
async function sbGetAll(path) {
    let out = [];
    for (let offset = 0; ; offset += PAGE_ROWS) {
        const page = await sbGet(`${path}&limit=${PAGE_ROWS}&offset=${offset}`);
        out = out.concat(page);
        if (page.length < PAGE_ROWS) return out;
    }
}
async function sbInsert(table, row) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${table}`, {
        method: 'POST', timeoutMs: 10_000,
        headers: { ...sbHeaders(), Prefer: 'resolution=ignore-duplicates,return=minimal' },
        body: JSON.stringify(row),
    });
    if (!res.ok) throw new Error(`insert ${table} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
}
async function rpc(name, args = {}) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: 'POST', timeoutMs: 20_000, headers: sbHeaders(), body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`rpc ${name} ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

// ── PURE planning (node-tested in tests/r2-offload.mjs) ──────────────────

/** fetched_at values present in Postgres but not indexed, NEWEST first. Compared by ms. */
export function framesToArchive(dbTimes, indexedTimes) {
    const have = new Set(indexedTimes.map(t => Date.parse(t)));
    return dbTimes.filter(t => !have.has(Date.parse(t)))
        .sort((a, b) => Date.parse(b) - Date.parse(a));
}

/** Complete, unsealed UTC days from the oldest row's day up to the seal horizon, OLDEST first. */
export function daysToSeal(oldestT, sealedDays, nowMs) {
    if (!oldestT) return [];
    const sealed = new Set(sealedDays);
    const out = [];
    const first = Date.parse(`${new Date(oldestT).toISOString().slice(0, 10)}T00:00:00Z`);
    for (let d = first; d + DAY_MS + SEAL_AFTER_H * 3.6e6 <= nowMs; d += DAY_MS) {
        const day = new Date(d).toISOString().slice(0, 10);
        if (!sealed.has(day)) out.push(day);
    }
    return out;
}

// ── Steps ─────────────────────────────────────────────────────────────────

async function archiveFrames(deadline, dry) {
    const db = await sbGetAll('weather_grid_cache?select=fetched_at&order=fetched_at.asc');
    if (!db.length) return { pending: 0, archived: 0 };
    const idx = await sbGetAll(
        `weather_grid_archive?select=fetched_at&fetched_at=gte.${encodeURIComponent(db[0].fetched_at)}&order=fetched_at.asc`);
    const todo = framesToArchive(db.map(r => r.fetched_at), idx.map(r => r.fetched_at));
    if (dry) return { pending: todo.length, archived: 0 };
    let archived = 0, bytes = 0;
    for (const t of todo) {
        if (Date.now() > deadline) break;
        const rows = await sbGet(
            `weather_grid_cache?select=fetched_at,source,payload&fetched_at=eq.${encodeURIComponent(t)}`, 20_000);
        const row = rows[0];
        if (!row) continue;                          // trimmed meanwhile — nothing to copy
        const key = weatherFrameKey(row.fetched_at);
        const put = await putGzText(key, JSON.stringify(row), { fetched_at: row.fetched_at });
        await sbInsert('weather_grid_archive', {
            fetched_at: row.fetched_at,
            source: row.source ?? null,
            pressure_kind: Array.isArray(row.payload) ? pressureKindOf(row.payload[0]) : null,
            r2_key: put.key, bytes: put.bytes, sha256: put.sha256,
        });
        archived++; bytes += put.bytes;
    }
    return { pending: todo.length - archived, archived, bytes };
}

async function sealDays(deadline, dry, nowMs) {
    const oldest = await sbGet('sw_geomag_dataset?select=t&order=t.asc&limit=1');
    const sealed = await sbGetAll('sw_geomag_archive?select=day&order=day.asc');
    const todo = daysToSeal(oldest[0]?.t, sealed.map(r => r.day), nowMs);
    if (dry) return { pending: todo.length, sealed: 0 };
    let done = 0, bytes = 0;
    for (const day of todo) {
        if (Date.now() > deadline) break;
        const a = encodeURIComponent(`${day}T00:00:00Z`);
        const b = encodeURIComponent(new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString());
        const rows = await sbGetAll(`sw_geomag_dataset?t=gte.${a}&t=lt.${b}&order=t.asc`);
        if (!rows.length) continue;                  // a hole in the record — nothing to seal
        const put = await putGzText(swGeomagDayKey(day), toNdjson(rows), { day, rows: String(rows.length) });
        await sbInsert('sw_geomag_archive', {
            day, r2_key: put.key, rows: rows.length,
            first_t: rows[0].t, last_t: rows[rows.length - 1].t,
            bytes: put.bytes, sha256: put.sha256,
        });
        done++; bytes += put.bytes;
    }
    return { pending: todo.length - done, sealed: done, bytes };
}

// ── Handler ───────────────────────────────────────────────────────────────

async function run(request) {
    const started = Date.now();
    if (!isAuthorized(request)) return { status: 401, body: { error: 'unauthorized' } };
    if (!SUPABASE_URL || !SUPABASE_KEY) return { status: 503, body: { ok: false, reason: 'supabase_not_configured' } };
    if (!R2_CONFIGURED) {
        try { await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: 'r2_not_configured: R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET' }); }
        catch { /* heartbeat best-effort */ }
        return { status: 503, body: { ok: false, reason: 'r2_not_configured' } };
    }
    const dry = queryParam(request, 'dry') === '1';
    const deadline = started + BUDGET_MS;
    const out = { ok: true, dry };
    const errors = {};
    try { out.frames = await archiveFrames(deadline, dry); } catch (e) { errors.frames = String(e?.message ?? e).slice(0, 200); }
    try { out.days = await sealDays(deadline, dry, started); } catch (e) { errors.days = String(e?.message ?? e).slice(0, 200); }
    if (!dry) {
        try { await rpc('trim_weather_grid_cache'); out.trimmedWeather = true; } catch (e) { errors.trimWeather = String(e?.message ?? e).slice(0, 120); }
        try { out.trimmedDatasetRows = await rpc('trim_sw_geomag_dataset'); } catch (e) { errors.trimDataset = String(e?.message ?? e).slice(0, 120); }
    }
    out.dur_ms = Date.now() - started;
    if (Object.keys(errors).length) {
        out.ok = false; out.errors = errors;
        try { await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: JSON.stringify(errors).slice(0, 480) }); }
        catch { /* heartbeat best-effort */ }
        return { status: 502, body: out };
    }
    if (!dry) {
        const tag = `frames +${out.frames?.archived ?? 0} (${out.frames?.pending ?? '?'} left) · days +${out.days?.sealed ?? 0} (${out.days?.pending ?? '?'} left)`;
        try { await rpc('record_pipeline_success', { p_name: PIPELINE, p_source: tag }); }
        catch { /* heartbeat best-effort */ }
    }
    return { status: 200, body: out };
}

// Node runtime hands (req, res); dev-server and tests hand a Request.
export default async function handler(req, res) {
    const { status, body } = await run(req);
    if (res && typeof res.status === 'function') { res.status(status).json(body); return; }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
