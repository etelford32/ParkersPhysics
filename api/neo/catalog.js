/**
 * Vercel Edge Function: /api/neo/catalog?tier=pha|bright|all
 *
 * The near-Earth object POPULATION for solar-system.html: osculating orbital
 * elements for every catalogued NEO in the requested tier, plus the near-Earth
 * comets and the interstellar visitors, as compact rows the browser propagates
 * itself (js/neo-orbits.js, off-thread in js/neo-worker.js).
 *
 * ── Why a tiered route ─────────────────────────────────────────────────────
 * JPL's SBDB query API answers a whole population in one request, but the
 * whole population is ~38 000 objects ≈ 3.5 MB of rows. The page wants the
 * 2 500 potentially hazardous asteroids on screen within a second, the
 * ≥140 m class (~12 000) by default, and the full catalogue only when asked.
 * Three tiers, three cache keys, one code path. Tier names are the ONLY
 * client input; every upstream URL is rebuilt from the frozen tables in
 * api/_lib/neo-sources.js — no passthrough (the /api/mars/tiles SSRF story).
 *
 * ── Degradation ────────────────────────────────────────────────────────────
 * Comets and interstellar extras fail independently and are merely absent.
 * If the asteroid query itself fails the route still answers 200, with
 * `freshness:'stale'`, `degraded_reason`, and whatever the other groups
 * returned — status.html renders that amber, and the page says "population
 * unavailable" instead of drawing a stale invention. The route's
 * `groups.*.field_map` / `unmapped` blocks are the self-report that settles
 * the (unverified, egress-blocked at build time) SBDB schema in production.
 *
 * Cache: s-maxage=86400 / swr=86400. Osculating elements are refreshed by JPL
 * on a ~daily cadence and a day of staleness moves nothing on this page.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import {
    CATALOG_TIERS, DEFAULT_TIER,
    sbdbAsteroidUrl, sbdbCometUrl, sbdbInterstellarUrl,
    parseSbdbQuery, composeCatalogResponse,
} from '../_lib/neo-sources.js';

export const config = { runtime: 'edge' };

const CACHE_TTL = 86_400;
const CACHE_SWR = 86_400;
// The full-population query is the largest single upstream body in this
// stack (~6 MB from JPL); give it the Horizons budget, not the 10 s default.
const SBDB_TIMEOUT_MS = 24_000;

async function fetchGroup(url, opts) {
    let res;
    try {
        res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' }, timeoutMs: SBDB_TIMEOUT_MS });
    } catch (e) {
        return { ok: false, reason: `unreachable: ${e.message || 'fetch failed'}`, records: [], count: 0 };
    }
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, records: [], count: 0 };
    let json;
    try { json = await res.json(); } catch (e) { return { ok: false, reason: `unparseable: ${e.message}`, records: [], count: 0 }; }
    return parseSbdbQuery(json, opts);
}

export default async function handler(request) {
    const url = new URL(request.url);
    const tier = url.searchParams.get('tier') || DEFAULT_TIER;
    if (!CATALOG_TIERS[tier]) {
        return jsonError('unknown_tier', `tier must be one of ${Object.keys(CATALOG_TIERS).join('|')}`, { status: 400, maxAge: 300 });
    }

    const [asteroids, comets, interstellar] = await Promise.all([
        fetchGroup(sbdbAsteroidUrl(tier), { kind: 'a' }),
        fetchGroup(sbdbCometUrl(), { kind: 'c' }),
        fetchGroup(sbdbInterstellarUrl(), { interstellar: true }),
    ]);

    const body = composeCatalogResponse({ tier, asteroids, comets, interstellar });
    // A degraded body is cached briefly so recovery is visible within minutes.
    return jsonOk(body, body.freshness === 'live'
        ? { maxAge: CACHE_TTL, swr: CACHE_SWR }
        : { maxAge: 300, swr: 600 });
}
