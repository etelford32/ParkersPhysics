/**
 * Vercel Edge Function: /api/climalytix/marine?lat=&lon=
 *
 * Hourly sea state for the sea cell nearest one site — significant wave
 * height / period / direction, swell, wind-wave, sea-surface temperature and
 * modelled sea level (tide included) — one past day and five ahead. It feeds
 * climalytix.html's Coast card (js/climalytix/coast.js does the physics).
 *
 * BOOTSTRAP SOURCE, said in the body: Open-Meteo's Marine API, free tier,
 * non-commercial. Model output for an offshore cell, not a measurement at a
 * beach and not a tide gauge (US gauges are /api/ocean/tides).
 *
 * The pure half (snap, validate, URL, normalise) is
 * js/climalytix/marine-request.js, node-gated by tests/climalytix-coast.mjs.
 * The upstream variable names are UNVERIFIED (egress-blocked at build time):
 * the body self-reports `field_map` / `missing`, and a 4xx on the full list is
 * retried once with the core wave variables only.
 *
 * NEVER A 5xx FOR A DEGRADED ANSWER (CLAUDE.md §8): no sea here, an upstream
 * failure or a refusal is a 200 with `freshness: 'expired'` + `reasons`.
 * There is no passthrough URL parameter — the client names a site, nothing else.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { parseMarineQuery, buildMarineUrl, normalizeMarine, degradedMarine } from '../../js/climalytix/marine-request.js';

export const config = { runtime: 'edge' };

const CACHE_TTL = 1800;      // wave models update a few times a day; half an hour keeps "now" honest
const CACHE_SWR = 3600;

export default async function handler(req) {
    const url = new URL(req.url);
    const q = parseMarineQuery({ lat: url.searchParams.get('lat'), lon: url.searchParams.get('lon') });
    if (q.error) return jsonError('bad_request', q.error, { status: 400 });

    const now = Date.now();
    const degraded = (reason) => jsonOk(degradedMarine(q, reason, now), { maxAge: 120, swr: 0 });
    let up = null, coreOnly = false;
    try {
        let res = await fetchWithTimeout(buildMarineUrl(q), { timeoutMs: 12_000 });
        if (res.status >= 400 && res.status < 500) {
            // An unknown variable name refuses the whole request: ask again for the core wave fields.
            coreOnly = true;
            res = await fetchWithTimeout(buildMarineUrl(q, { coreOnly: true }), { timeoutMs: 12_000 });
        }
        if (!res.ok) return degraded(res.status >= 400 && res.status < 500 ? 'no_marine_data_here' : `upstream HTTP ${res.status}`);
        up = await res.json();
    } catch (e) {
        return degraded(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'upstream timeout' : 'upstream unreachable');
    }
    const body = normalizeMarine(up, q, now);
    if (!body) return degraded('no_marine_data_here');
    if (coreOnly) body.core_only = true;
    return jsonOk(body, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
