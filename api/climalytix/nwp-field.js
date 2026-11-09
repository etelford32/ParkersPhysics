/**
 * Vercel Edge Function: /api/climalytix/nwp-field?lat=&lon=[&half=3][&grid=0p25][&vars=uMs,vMs]
 *
 * `vars` (default tempC) picks which variables come back; every requested
 * one is in `fields`, the first is also `values` (the original contract).
 * The ranges are the same whatever is asked — a cell carries all variables.
 *
 * The temperature FIELD around a site — every grid node within ±half° — from
 * our own GFS archive (the same R2 point tiles /api/climalytix/nwp reads), for
 * the Climalytix location map's heat layer. All 81 leads come back so the map
 * can follow the timeline's crosshair without another request.
 *
 * Reads: the cached latest → manifest, then ONE byte range per (row, tile)
 * segment (js/climalytix/point-tile.js fieldPlan — a row inside a tile is
 * contiguous), at most FIELD_CONCURRENCY in flight.
 *
 * OUR ARCHIVE ONLY, on purpose (CLIMALYTIX_PLAN.md §17.6): no third-party grid
 * stands in for it. R2 unset / no run / a segment that will not read is a 200
 * with `freshness: 'expired'`, `values: null` and `reasons` — the map then
 * draws no heat and says why. An old run is served and graded by age. Bad
 * input is a 400.
 */
import { jsonOk, jsonError } from '../_lib/responses.js';
import { R2_CONFIGURED, mapLimit } from '../_lib/r2-archive.js';
import { GRIDS, CACHE_TTL, CACHE_SWR, manifestFor, getRange } from '../_lib/climalytix-r2.js';
import {
    parseSite, parseFieldVars, fieldPlan, readField, fieldBody, degradedNwp, FIELD_HALF_DEG_DEFAULT, FIELD_HALF_DEG_MAX, FIELD_HALF_LON_MAX,
} from '../../js/climalytix/point-tile.js';

export const config = { runtime: 'edge' };

const FIELD_CONCURRENCY = 12;

function degraded(q, grid, reason, now, vars = ['tempC']) {
    const b = degradedNwp(q, grid, reason, now);
    return { ...b, var: vars[0], vars, fields: null, values: null };
}

export default async function handler(req) {
    const url = new URL(req.url);
    const q = parseSite({ lat: url.searchParams.get('lat'), lon: url.searchParams.get('lon') });
    if (q.error) return jsonError('bad_request', q.error, { status: 400 });
    const grid = url.searchParams.get('grid') || '0p25';
    if (!GRIDS.has(grid)) return jsonError('bad_request', 'grid must be 0p25, 0p50 or 1p00', { status: 400 });
    const halfRaw = url.searchParams.get('half');
    const half = halfRaw == null ? FIELD_HALF_DEG_DEFAULT : Number(halfRaw);
    if (!Number.isFinite(half) || half < 0.5 || half > FIELD_HALF_DEG_MAX) {
        return jsonError('bad_request', `half must be 0.5–${FIELD_HALF_DEG_MAX} degrees`, { status: 400 });
    }
    const halfLonRaw = url.searchParams.get('halfLon');
    const halfLon = halfLonRaw == null ? half : Number(halfLonRaw);
    if (!Number.isFinite(halfLon) || halfLon < 0.5 || halfLon > FIELD_HALF_LON_MAX) {
        return jsonError('bad_request', `halfLon must be 0.5–${FIELD_HALF_LON_MAX} degrees`, { status: 400 });
    }
    const vars = parseFieldVars(url.searchParams.get('vars'));
    if (vars.error) return jsonError('bad_request', vars.error, { status: 400 });
    const now = Date.now();
    const short = { maxAge: 120, swr: 0 };
    const down = (reason) => jsonOk(degraded(q, grid, reason, now, vars), short);
    if (!R2_CONFIGURED) return down('r2_not_configured');

    let man;
    try {
        man = await manifestFor(grid, now);
    } catch (e) {
        return down(`manifest_read_failed: ${String(e?.message || e).slice(0, 120)}`);
    }
    if (!man) return down('no_run_published');

    try {
        const plan = fieldPlan(man, { lat: q.lat, lon: q.lon, halfDeg: half, halfLon });
        const bodies = await mapLimit(plan.segments, FIELD_CONCURRENCY, (seg) => getRange(seg.key, seg.range));
        const [first, ...rest] = vars;
        const extra = vars.length > 1 || first !== 'tempC'
            ? Object.fromEntries(rest.map((id) => [id, readField(man, plan, id, bodies)])) : null;
        const body = fieldBody(man, plan, first, readField(man, plan, first, bodies), { nowMs: now, site: q, extra });
        return jsonOk(body, body.freshness === 'fresh' ? { maxAge: CACHE_TTL, swr: CACHE_SWR } : short);
    } catch (e) {
        return down(`tile_read_failed: ${String(e?.message || e).slice(0, 120)}`);
    }
}
