/**
 * Vercel Edge Function: /api/climalytix/nwp?lat=&lon=[&grid=0p25]
 *
 * One site's forecast from OUR OWN archive — the newest GFS run the ingest
 * worker (scripts/climalytix_ingest/gfs.py, on GitHub Actions) wrote to R2 as
 * point tiles (CLIMALYTIX_PLAN.md §17, P-1). This is the first route that
 * serves Climalytix from the data engine instead of a bootstrap API.
 *
 * Per request: the `latest` pointer and the run manifest (cached in the
 * isolate for MANIFEST_TTL_MS), then TWO byte-range GETs on one tile — the
 * 2×2 bilinear stencil (js/climalytix/point-tile.js, the pure half, gated by
 * tests/climalytix-point-tile.mjs against tiles Python wrote).
 *
 * NEVER A 5xx FOR A DEGRADED ANSWER (CLAUDE.md §8): R2 not configured, no run
 * published yet, or a failed tile read is a 200 with `freshness: 'expired'`,
 * `series: null` and `reasons`; an old run is `stale`/`expired` by AGE
 * (`age_seconds` = now − run time, which status.html reads as the ingest lag).
 * Bad input is a 400.
 */
import { jsonOk, jsonError } from '../_lib/responses.js';
import { R2_CONFIGURED, getGzText } from '../_lib/r2-archive.js';
import { getSignedUrl } from '../_lib/r2-client.js';
import { locate, tileKey, stencilRanges, readStencil, siteBody, parseSite, SCHEMA } from '../../js/climalytix/point-tile.js';

export const config = { runtime: 'edge' };

export const NWP_ROOT = 'climalytix/nwp/gfs';
const GRIDS = new Set(['0p25', '0p50', '1p00']);
const MANIFEST_TTL_MS = 10 * 60_000;
const CACHE_TTL = 1800;
const CACHE_SWR = 3600;

let cache = null;   // { grid, at, man }

export function _resetCache() { cache = null; }

async function manifestFor(grid, now) {
    if (cache && cache.grid === grid && now - cache.at < MANIFEST_TTL_MS) return cache.man;
    const ptr = await getGzText(`${NWP_ROOT}/${grid}/latest.json.gz`);
    if (!ptr) return null;
    const { manifest } = JSON.parse(ptr);
    const text = await getGzText(manifest);
    if (!text) throw new Error(`manifest ${manifest} missing`);
    const man = JSON.parse(text);
    if (man.schema !== SCHEMA) throw new Error(`unknown tile schema ${man.schema}`);
    cache = { grid, at: now, man };
    return man;
}

async function getRange(key, [start, end]) {
    const url = await getSignedUrl(key, { expiresIn: 300 });
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status !== 206 && res.status !== 200) throw new Error(`tile range HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // A server that ignores Range answers 200 with the whole object.
    return res.status === 200 ? buf.subarray(start, end) : buf;
}

function degraded(q, grid, reason, now) {
    return {
        source: 'climalytix-gfs', role: 'archive', grid, freshness: 'expired', reasons: [reason],
        generated_at: new Date(now).toISOString(), site: q, series: null,
        note: 'Our own GFS archive is unavailable for this request; nothing is substituted.',
    };
}

export default async function handler(req) {
    const url = new URL(req.url);
    const q = parseSite({ lat: url.searchParams.get('lat'), lon: url.searchParams.get('lon') });
    if (q.error) return jsonError('bad_request', q.error, { status: 400 });
    const grid = url.searchParams.get('grid') || '0p25';
    if (!GRIDS.has(grid)) return jsonError('bad_request', 'grid must be 0p25, 0p50 or 1p00', { status: 400 });
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
        const loc = locate(man, q.lat, q.lon);
        const key = tileKey(man, loc.tr, loc.tc);
        const [r1, r2] = stencilRanges(man, loc);
        const [top, bottom] = await Promise.all([getRange(key, r1), getRange(key, r2)]);
        const body = siteBody(man, loc, readStencil(man, loc, top, bottom), { ...q, nowMs: now });
        return jsonOk(body, body.freshness === 'fresh' ? { maxAge: CACHE_TTL, swr: CACHE_SWR } : short);
    } catch (e) {
        return jsonOk(degraded(q, grid, `tile_read_failed: ${String(e?.message || e).slice(0, 120)}`, now), short);
    }
}
