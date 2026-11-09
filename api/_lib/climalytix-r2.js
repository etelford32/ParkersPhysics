/**
 * api/_lib/climalytix-r2.js — the Climalytix point-tile archive in R2, read side.
 *
 * ONE copy of the latest-pointer → manifest lookup (cached per isolate) and
 * of the byte-range GET, shared by /api/climalytix/nwp (a site) and
 * /api/climalytix/nwp-field (an area). The format itself is described in
 * scripts/climalytix_ingest/tiles.py and read by js/climalytix/point-tile.js.
 */
import { getGzText } from './r2-archive.js';
import { getSignedUrl } from './r2-client.js';
import { SCHEMA } from '../../js/climalytix/point-tile.js';

export const NWP_ROOT = 'climalytix/nwp/gfs';
export const GRIDS = new Set(['0p25', '0p50', '1p00']);
const MANIFEST_TTL_MS = 10 * 60_000;
export const CACHE_TTL = 1800;
export const CACHE_SWR = 3600;

let cache = null;   // { grid, at, man }

export function _resetCache() { cache = null; }

export async function manifestFor(grid, now) {
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

export async function getRange(key, [start, end]) {
    const url = await getSignedUrl(key, { expiresIn: 300 });
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal: AbortSignal.timeout(10_000) });
    if (res.status !== 206 && res.status !== 200) throw new Error(`tile range HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // A server that ignores Range answers 200 with the whole object.
    return res.status === 200 ? buf.subarray(start, end) : buf;
}

