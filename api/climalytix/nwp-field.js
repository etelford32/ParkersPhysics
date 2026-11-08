/**
 * Vercel Edge Function: /api/climalytix/nwp-field?lat=&lon=[&half=3][&grid=0p25]
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
    parseSite, fieldPlan, readField, fieldBody, degradedNwp, FIELD_HALF_DEG_DEFAULT, FIELD_HALF_DEG_MAX,
} from '../../js/climalytix/point-tile.js';

export const config = { runtime: 'edge' };

const FIELD_VAR = 'tempC';
const FIELD_CONCURRENCY = 12;

function degraded(q, grid, reason, now) {
    const b = degradedNwp(q, grid, reason, now);
    return { ...b, var: FIELD_VAR, values: null };
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
    const now = Date.now();
    const short = { maxAge: 120, swr: 0 };
    if (!R2_CONFIGURED) return jsonOk(degraded(q, grid, 'r2_not_configured', now), short);

    let man;
    try {
        man = await manifestFor(grid, now);
    } catch (e) {
        return jsonOk(degraded(q, grid, `manifest_read_failed: ${String(e?.message || e).slice(0, 120)}`, now), short);
    }
    if (!man) return jsonOk(degraded(q, grid, 'no_run_published', now), short);

    try {
        const plan = fieldPlan(man, { lat: q.lat, lon: q.lon, halfDeg: half });
        const bodies = await mapLimit(plan.segments, FIELD_CONCURRENCY, (seg) => getRange(seg.key, seg.range));
        const body = fieldBody(man, plan, FIELD_VAR, readField(man, plan, FIELD_VAR, bodies), { nowMs: now, site: q });
        return jsonOk(body, body.freshness === 'fresh' ? { maxAge: CACHE_TTL, swr: CACHE_SWR } : short);
    } catch (e) {
        return jsonOk(degraded(q, grid, `tile_read_failed: ${String(e?.message || e).slice(0, 120)}`, now), short);
    }
}
