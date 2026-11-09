/**
 * Vercel Edge Function: /api/climalytix/dem
 *
 *   GET /api/climalytix/dem              → JSON capability probe (which host answers)
 *   GET /api/climalytix/dem?z=&x=&y=     → one Terrarium elevation tile (PNG), proxied
 *
 * The Climalytix map's Elevation and Sun-exposure layers (CLIMALYTIX_PLAN.md
 * §19 T1) read AWS Terrain Tiles. The pure half — candidate hosts, request
 * validation, the PNG check — is js/climalytix/terrain.js. The client names
 * z/x/y only and the URL is rebuilt from the frozen candidate list: there is
 * no passthrough parameter (the SSRF story, as in api/mars/tiles.js).
 *
 * Tiles are archival elevation and cached immutable for a year at the edge.
 * A tile every host refuses returns the LAST upstream status (404 = a hole the
 * map leaves blank); a 200 that is not a PNG is an error page and is refused.
 * The probe never 5xx's: it answers 200 with `freshness: 'stale'` and the
 * per-candidate result when nothing answers, so status.html flags it.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { DEM_CANDIDATES, DEM_PROBE, DEM_ATTRIBUTION, parseDemTile, demTileUrl, isPng } from '../../js/climalytix/terrain.js';

export const config = { runtime: 'edge' };

const TILE_HEADERS = {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=86400, s-maxage=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
};

async function fetchTile(candidate, t) {
    try {
        const r = await fetchWithTimeout(demTileUrl(candidate, t), { timeoutMs: 12_000 });
        if (!r.ok) return { ok: false, status: r.status };
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (!isPng(bytes)) return { ok: false, status: 502, note: 'not a PNG' };
        return { ok: true, status: 200, bytes };
    } catch (e) {
        return { ok: false, status: 0, note: String(e?.message || e).slice(0, 80) };
    }
}

export default async function handler(req) {
    const url = new URL(req.url);
    const hasTile = ['z', 'x', 'y'].some((k) => url.searchParams.has(k));
    if (!hasTile) {
        const results = await Promise.all(DEM_CANDIDATES.map(async (c) => {
            const r = await fetchTile(c, DEM_PROBE);
            return { id: c.id, ok: r.ok, status: r.status, note: r.note ?? null };
        }));
        const resolved = results.find((r) => r.ok)?.id ?? null;
        return jsonOk({
            resolved, candidates: results, freshness: resolved ? 'fresh' : 'stale',
            reasons: resolved ? [] : ['no_candidate_answered'], attribution: DEM_ATTRIBUTION,
        }, { maxAge: 3600, swr: 600 });
    }
    const t = parseDemTile(Object.fromEntries(url.searchParams));
    if (t.error) return jsonError('bad_request', t.error, { status: 400 });
    let last = { status: 502 };
    for (const c of DEM_CANDIDATES) {
        const r = await fetchTile(c, t);
        if (r.ok) return new Response(r.bytes, { status: 200, headers: { ...TILE_HEADERS, 'X-DEM-Source': c.id } });
        last = r;
    }
    return new Response(null, {
        status: last.status >= 400 ? last.status : 502,
        headers: { 'Cache-Control': 'public, s-maxage=300', 'Access-Control-Allow-Origin': '*' },
    });
}
