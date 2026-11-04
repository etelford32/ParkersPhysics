/**
 * Vercel Node Cron: /api/cron/weather-cell-stats — daily 03:05 UTC (vercel.json)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The 30-day per-cell percentile pass, run OUT of Postgres
 * (SUPABASE_OFFLOAD_PLAN.md Phase A2). Reads the archived weather frames
 * from R2, computes the statistics with the PURE port in
 * api/_lib/weather-cell-stats.js (which mirrors the SQL pass's frame
 * selection and arithmetic — see its header), and replaces
 * public.weather_cell_stats in ONE transaction via
 * replace_weather_cell_stats() with stats_source = 'r2'.
 *
 * Five minutes before the pg_cron 'weather-cell-stats-daily' job (03:10),
 * which then sees fresh R2 stats and skips (returns −1). If this run fails
 * or is skipped, that job is the fallback for as long as Postgres still
 * holds 30 days — and Postgres only stops holding them once this has
 * succeeded (trim_weather_grid_cache's r2_ready gate). So a broken R2 pass
 * leaves the stats computed the old way, never computed over one day.
 *
 * COVERAGE GATE: until the archive holds ≥ COVERAGE_MIN of the frames the
 * SQL pass would have used, and reaches back to the start of the window,
 * this writes nothing and reports `skipped: 'coverage'` on its heartbeat.
 * That is the expected state for the first days after the archive starts.
 *
 * Auth: x-vercel-cron, or Authorization: Bearer ${CRON_SECRET}.
 * Query: ?dry=1 computes and reports, writes nothing.
 */

import { fetchWithTimeout } from '../_lib/responses.js';
import { R2_CONFIGURED, getGzText, mapLimit } from '../_lib/r2-archive.js';
import {
    WINDOW_DAYS, selectStatsFrames, expectedStatsFrames, createCellAccumulator,
} from '../_lib/weather-cell-stats.js';

export const config = { runtime: 'nodejs', maxDuration: 60 };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const CRON_SECRET  = process.env.CRON_SECRET || '';

const PIPELINE     = 'weather_cell_stats';
export const COVERAGE_MIN = 0.9;
const REACH_SLACK_H = 6;            // the oldest selected frame may start this late
const H = 3_600_000;

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
async function sbGet(path) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`, { timeoutMs: 15_000, headers: sbHeaders() });
    if (!res.ok) throw new Error(`GET ${path.split('?')[0]} ${res.status}`);
    return res.json();
}
async function rpc(name, args = {}, timeoutMs = 20_000) {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: 'POST', timeoutMs, headers: sbHeaders(), body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`rpc ${name} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

/** PURE: does the archive cover the window well enough to replace the SQL pass? */
export function coverageVerdict(selected, { newestMs, nowMs, windowDays = WINDOW_DAYS }) {
    const need = Math.ceil(expectedStatsFrames(windowDays) * COVERAGE_MIN);
    const oldest = selected.length ? Date.parse(selected[0].fetched_at) : NaN;
    const windowStart = Math.max(nowMs - windowDays * 24 * H, newestMs - 30 * 24 * H);
    const reaches = Number.isFinite(oldest) && oldest <= windowStart + REACH_SLACK_H * H;
    return { ok: selected.length >= need && reaches, have: selected.length, need, reaches };
}

async function run(request) {
    const started = Date.now();
    if (!isAuthorized(request)) return { status: 401, body: { error: 'unauthorized' } };
    if (!SUPABASE_URL || !SUPABASE_KEY) return { status: 503, body: { ok: false, reason: 'supabase_not_configured' } };
    if (!R2_CONFIGURED) {
        try { await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: 'r2_not_configured' }); } catch { /* best-effort */ }
        return { status: 503, body: { ok: false, reason: 'r2_not_configured' } };
    }
    const dry = queryParam(request, 'dry') === '1';
    try {
        const newest = (await sbGet('weather_grid_cache?select=fetched_at&order=fetched_at.desc&limit=1'))[0];
        if (!newest) return { status: 200, body: { ok: true, skipped: 'no-frames' } };
        const newestMs = Date.parse(newest.fetched_at);
        const since = encodeURIComponent(new Date(started - (WINDOW_DAYS + 1) * 24 * H).toISOString());
        let index = [];
        for (let offset = 0; ; offset += 1000) {
            const page = await sbGet(`weather_grid_archive?select=fetched_at,r2_key&fetched_at=gte.${since}&order=fetched_at.asc&limit=1000&offset=${offset}`);
            index = index.concat(page);
            if (page.length < 1000) break;
        }
        const selected = selectStatsFrames(index, { newestMs, nowMs: started });
        const cov = coverageVerdict(selected, { newestMs, nowMs: started });
        if (!cov.ok) {
            const tag = `skipped:coverage ${cov.have}/${cov.need}${cov.reaches ? '' : ' (window start not archived yet)'}`;
            if (!dry) { try { await rpc('record_pipeline_success', { p_name: PIPELINE, p_source: tag }); } catch { /* best-effort */ } }
            return { status: 200, body: { ok: true, skipped: 'coverage', ...cov } };
        }

        const acc = createCellAccumulator();
        let missing = 0;
        await mapLimit(selected, 12, async (f) => {
            const text = await getGzText(f.r2_key, { timeoutMs: 15_000 });
            if (text == null) { missing++; return; }
            acc.addFrame(JSON.parse(text).payload);   // parsed, folded in, dropped
        });
        const used = selected.length - missing;
        if (used < cov.need) {
            throw new Error(`only ${used} of ${selected.length} archived frames readable (need ${cov.need})`);
        }
        const rows = acc.rows();
        if (dry) {
            return { status: 200, body: { ok: true, dry: true, frames: used, cells: rows.length, sample: rows.slice(0, 2), dur_ms: Date.now() - started } };
        }
        const written = await rpc('replace_weather_cell_stats', {
            p_rows: rows, p_window_days: WINDOW_DAYS, p_decimate: 1,
            p_frames: used, p_history_end: newest.fetched_at,
        }, 30_000);
        try { await rpc('record_pipeline_success', { p_name: PIPELINE, p_source: `r2 ${used} frames · ${written} cells` }); } catch { /* best-effort */ }
        return { status: 200, body: { ok: true, frames: used, missing, cells: written, dur_ms: Date.now() - started } };
    } catch (e) {
        const reason = String(e?.message ?? e).slice(0, 400);
        try { await rpc('record_pipeline_failure', { p_name: PIPELINE, p_reason: reason }); } catch { /* best-effort */ }
        return { status: 502, body: { ok: false, reason } };
    }
}

export default async function handler(req, res) {
    const { status, body } = await run(req);
    if (res && typeof res.status === 'function') { res.status(status).json(body); return; }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
