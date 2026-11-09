/**
 * Vercel Edge Function: /api/climalytix/aq-field?lat=&lon=
 *
 * The air-quality FIELD around a site for the Climalytix location map:
 * CAMS global PM2.5 / O₃ / NO₂ / dust / AOD on a 0.5° window (±4°) at
 * 3-hourly instants, one day back and five ahead. The pure half is
 * js/climalytix/aq-field.js (grid, the ONE Open-Meteo chunker, the
 * by-instant normaliser); this file only fetches.
 *
 * BOOTSTRAP SOURCE (CLIMALYTIX_PLAN.md §0): Open-Meteo's free air-quality
 * API, badged `role: 'bootstrap'` on the page until our own CAMS ingest
 * replaces it. Upstream down / a chunk failing / no values ⇒ 200 +
 * `freshness: 'expired'` + `reasons`, `fields: null` — never a partial
 * field, never a 5xx (status.html scores the freshness). Bad input is a 400.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { parseSite } from '../../js/climalytix/point-tile.js';
import { aqGrid, aqRequestUrls, aqFieldBody, degradedAq } from '../../js/climalytix/aq-field.js';
import { mergeChunks } from '../../js/open-meteo-request.js';

export const config = { runtime: 'edge' };

const CACHE = { maxAge: 3600, swr: 1800 };
const SHORT = { maxAge: 120, swr: 0 };

export default async function handler(req) {
    const url = new URL(req.url);
    const q = parseSite({ lat: url.searchParams.get('lat'), lon: url.searchParams.get('lon') });
    if (q.error) return jsonError('bad_request', q.error, { status: 400 });
    const now = Date.now();
    const grid = aqGrid(q.lat, q.lon);
    try {
        const chunks = await Promise.all(aqRequestUrls(grid).map(async ({ url: u, start, end }) => {
            const r = await fetchWithTimeout(u, { timeoutMs: 15_000, headers: { Accept: 'application/json' } });
            if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
            const j = await r.json();
            if (j?.error) throw new Error(`upstream: ${String(j.reason || 'error').slice(0, 80)}`);
            const arr = Array.isArray(j) ? j : [j];
            if (arr.length !== end - start + 1) throw new Error(`upstream returned ${arr.length} of ${end - start + 1} locations`);
            return arr;
        }));
        const body = aqFieldBody(grid, mergeChunks(chunks, grid.lats.length), { nowMs: now, site: q });
        return jsonOk(body, body.freshness === 'fresh' ? CACHE : SHORT);
    } catch (e) {
        return jsonOk(degradedAq(q, `upstream_failed: ${String(e?.message || e).slice(0, 120)}`, now), SHORT);
    }
}
