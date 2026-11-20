/**
 * api/_lib/bz-ground-fetch.js — the USGS fan-out for the Bz engine's ground
 * rung: per station one 1-second request (the last hour) and one 1-minute
 * request (24 h, for the baseline). Shared by /api/bz/ground and
 * /api/bz/column. Station codes come from the fixed roster in
 * js/geomag/observatories.js; a station that fails is a DROPOUT, not an error.
 *
 * CONCURRENCY IS CAPPED, AND FAILURES ARE DESCRIBED. The first production run
 * (2026-11-20) fired all 28 requests at once and EVERY station came back
 * failed, while the same service had answered single requests minutes
 * earlier — and the route could only say "stations_down", not why. So: at
 * most `CONCURRENCY` requests in flight, a longer timeout for the 1-second
 * payload, and a `diagnostics` tally of what each failure actually was
 * (HTTP status / timeout / not JSON / no usable samples).
 */
import { fetchWithTimeout } from './responses.js';
import { groundSeriesUrl, normalizeGroundSeries } from '../../js/bz/feeds.js';
import { USGS_STATION_IDS } from '../../js/geomag/observatories.js';

export const FAST_WINDOW_S = 3600, SLOW_WINDOW_S = 24 * 3600;
export const CONCURRENCY = 6;
const TIMEOUT_MS = 14000;

async function one(id, sp, win, nowMs) {
    let res;
    try {
        res = await fetchWithTimeout(groundSeriesUrl(id, sp, win, nowMs), { headers: { Accept: 'application/json' }, timeoutMs: TIMEOUT_MS });
    } catch (e) {
        return { series: null, why: e?.name === 'TimeoutError' ? 'timeout' : `fetch:${String(e?.message ?? e).slice(0, 40)}` };
    }
    if (!res.ok) return { series: null, why: `http_${res.status}` };
    let body;
    try { body = await res.json(); } catch { return { series: null, why: 'not_json' }; }
    const series = normalizeGroundSeries(body, { nowMs, station: id });
    return { series, why: series ? null : 'no_usable_samples' };
}

/** Run `tasks` (functions returning promises) at most `limit` at a time, in order. */
export async function mapLimit(tasks, limit) {
    const out = new Array(tasks.length);
    let next = 0;
    const worker = async () => { while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); } };
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
    return out;
}

/** Fetch + normalise every station at both cadences. */
export async function fetchGround(nowMs) {
    const jobs = [];
    for (const id of USGS_STATION_IDS) {
        jobs.push({ id, kind: 'fast', run: () => one(id, 1, FAST_WINDOW_S, nowMs) });
        jobs.push({ id, kind: 'slow', run: () => one(id, 60, SLOW_WINDOW_S, nowMs) });
    }
    const results = await mapLimit(jobs.map((j) => j.run), CONCURRENCY);
    const fast = {}, slow = {}, why = {};
    jobs.forEach((j, i) => {
        const r = results[i];
        if (r.series) (j.kind === 'fast' ? fast : slow)[j.id] = r.series;
        else why[`${j.kind}:${r.why}`] = (why[`${j.kind}:${r.why}`] ?? 0) + 1;
    });
    const failed = USGS_STATION_IDS.filter((id) => !fast[id] && !slow[id]);
    return { fast, slow, failed, diagnostics: { requests: jobs.length, concurrency: CONCURRENCY, failures: why } };
}
