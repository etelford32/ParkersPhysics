/**
 * Vercel Edge Function: /api/trojans/catalog
 *
 * Every Jupiter Trojan JPL has on file (SBDB orbit class TJN) as osculating
 * elements, plus Jupiter's and Saturn's Sun-centred state vectors from
 * Horizons at the catalogue's own epoch — everything js/trojan-dynamics.js
 * needs to compute resonant angles, L4/L5 membership and libration in
 * Jupiter's frame, and to integrate the swarms forward. Takes NO parameters:
 * the population is one frozen query (the /api/neo/catalog SSRF story).
 *
 * ── Order of operations ────────────────────────────────────────────────────
 * SBDB first, because Horizons must be asked for the epoch SBDB actually
 * used (JPL moves its standard osculating epoch every ~200 days). Then both
 * perturbers in parallel at that epoch.
 *
 * ── Degradation ────────────────────────────────────────────────────────────
 * Never 5xx. No population ⇒ 200 + freshness:'stale' + degraded_reason, and
 * the page draws nothing. Population without Jupiter ⇒ the rows ship (they
 * are real) but freshness is 'stale' and the kernel falls back to mean
 * elements, which it discloses. Saturn alone missing degrades only the
 * N-body run (Jupiter-only perturbation), reported under `sources.saturn`.
 *
 * Cache: a day. Osculating elements change on JPL's ~daily cadence and the
 * perturber vectors are a pure function of the epoch.
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import {
    PERTURBERS, sbdbTrojanUrl, horizonsVectorUrl, parseHorizonsVector,
    parseTrojanQuery, modalEpoch, composeTrojanResponse,
} from '../_lib/trojan-sources.js';

// NODE runtime, not edge: an edge function must START responding within
// 25 s, and this route chains a ~6 MB SBDB body (the NEO route's measured
// worst case) into a Horizons round-trip. 60 s of budget, spent under the
// DEADLINE below so a slow upstream degrades the body instead of the request.
export const config = { runtime: 'nodejs', maxDuration: 60 };

const CACHE_TTL = 86_400;
const CACHE_SWR = 86_400;
const DEADLINE_MS = 50_000;          // whole chain, leaves headroom under maxDuration
const SBDB_TIMEOUT_MS = 30_000;      // per SBDB attempt (capped by what is left)
const HORIZONS_TIMEOUT_MS = 15_000;

async function fetchJson(url, timeoutMs) {
    let res;
    try {
        res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' }, timeoutMs });
    } catch (e) {
        return { ok: false, status: 0, reason: `unreachable: ${e.message || 'fetch failed'}` };
    }
    if (!res.ok) return { ok: false, status: res.status, reason: `HTTP ${res.status}` };
    try { return { ok: true, status: res.status, json: await res.json() }; }
    catch (e) { return { ok: false, status: res.status, reason: `unparseable: ${e.message}` }; }
}

/**
 * Optional query refinements must never take the population down. Ladder:
 * full precision + photometry → default precision + photometry → core only.
 * A step is abandoned only on a 4xx (JPL's "I do not know that parameter");
 * a network error or 5xx is reported as-is.
 */
const LADDER = [
    { fullPrecision: true,  photometry: true,  precision: 'full',    photometryFields: 'requested' },
    { fullPrecision: false, photometry: true,  precision: 'default', photometryFields: 'requested' },
    { fullPrecision: false, photometry: false, precision: 'default', photometryFields: 'dropped' },
];

async function fetchPopulation(deadline) {
    const refused = [];
    for (const step of LADDER) {
        const left = deadline - Date.now() - HORIZONS_TIMEOUT_MS;
        if (left < 5_000) { refused.push(`${step.precision}/${step.photometryFields}: no time left`); break; }
        const r = await fetchJson(sbdbTrojanUrl(step), Math.min(SBDB_TIMEOUT_MS, left));
        if (r.ok) {
            const parsed = parseTrojanQuery(r.json);
            return { sbdb: refused.length ? { ...parsed, refused } : parsed, precision: step.precision, photometry: step.photometryFields };
        }
        if (!(r.status >= 400 && r.status < 500)) return { sbdb: { ok: false, reason: r.reason, records: [] }, precision: step.precision, photometry: step.photometryFields };
        refused.push(`${step.precision}/${step.photometryFields}: ${r.reason}`);
    }
    return { sbdb: { ok: false, reason: `refused at every step (${refused.join('; ')})`, records: [] }, precision: null, photometry: null };
}

async function fetchPerturber(command, jd, deadline) {
    const url = horizonsVectorUrl(command, jd);
    if (!url) return { ok: false, reason: 'no_valid_epoch' };
    const left = Math.min(HORIZONS_TIMEOUT_MS, deadline - Date.now());
    if (left < 2_000) return { ok: false, reason: 'no time left after SBDB' };
    const r = await fetchJson(url, left);
    if (!r.ok) return { ok: false, reason: r.reason };
    return parseHorizonsVector(r.json);
}

async function handler() {
    const deadline = Date.now() + DEADLINE_MS;
    const { sbdb, precision, photometry } = await fetchPopulation(deadline);
    const epochInfo = modalEpoch(sbdb.records ?? []);
    const perturbers = {};
    if (sbdb.ok && epochInfo.epoch != null) {
        const got = await Promise.all(PERTURBERS.map(p => fetchPerturber(p.command, epochInfo.epoch, deadline)));
        PERTURBERS.forEach((p, k) => { perturbers[p.key] = got[k]; });
    }
    const body = composeTrojanResponse({ sbdb, precision, photometry, epochInfo, perturbers });
    return jsonOk(body, body.freshness === 'live'
        ? { maxAge: CACHE_TTL, swr: CACHE_SWR }
        : { maxAge: 300, swr: 600 });
}

/**
 * DUAL-MODE ENTRY. Vercel's Node runtime calls the DEFAULT export as
 * `(req, res)` and IGNORES a returned Response — the request then hangs to
 * the 60 s timeout (measured twice on this route's first previews; adding a
 * named `GET` export did not help, the default export wins). dev-server.mjs
 * and the node gate call `default(request)` with one argument and want the
 * Response back. So: build the Response once; if a Node `res` was passed,
 * copy it through; otherwise return it.
 */
export default async function entry(req, res) {
    const response = await handler();
    if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
        res.statusCode = response.status;
        response.headers.forEach((v, k) => { if (k !== 'content-length') res.setHeader(k, v); });
        res.end(Buffer.from(await response.arrayBuffer()));
        return;
    }
    return response;
}
