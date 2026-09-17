/**
 * api/storms.js — Vercel edge function: active tropical cyclone list (global)
 *
 * Merges two upstream feeds into one normalised worldwide cyclone list:
 *
 *   1. NOAA NHC CurrentStorms.json — authoritative for the Atlantic and
 *      East/Central Pacific. Rich fields (pressure, official movement).
 *   2. NASA EONET v3 severeStorms (JTWC-sourced) — the only keyless public
 *      JSON feed that carries West Pacific typhoons, Indian Ocean and
 *      Southern Hemisphere cyclones. Position/intensity come as a track of
 *      timestamped points; movement is derived from the last two points.
 *
 * NHC wins on overlap (same storm name or position within ~3°).
 *
 * All parsing, merging and health assessment live in the PURE kernel
 * `api/_lib/storms.js` (gate: `node tests/storms-feed.mjs`). This file only
 * fetches and sets headers.
 *
 * Response shape (extra fields are additive — client contract unchanged):
 *   {
 *     updated: ISO string,
 *     count,
 *     freshness: 'live'|'degraded'|'stale',
 *     coverage: 1 | 0.5 | 0,
 *     missingBasins: ['WPAC', ...],
 *     note?: string,
 *     storms: [{ id, name, basin, classification, lat, lon, intensityKt,
 *                pressureHpa, movementDir, movementKt, hemisphere,
 *                source: 'nhc'|'eonet', lastUpdate }],
 *     sources: { nhc: {ok, count, error?}, eonet: {ok, count, error?} }
 *   }
 *
 * ── FAILURE MODE (CLAUDE.md §8) ───────────────────────────────────────
 * A dead upstream is still a 200 — the client must not retry aggressively
 * and the page must not break. But it is NEVER a silent 200: the payload
 * carries a top-level `freshness`, so status.html scores it amber/red
 * instead of green, and the Storm Watch panel can say "feeds down"
 * instead of "no storms". Before 2026-09 both upstreams could fail and
 * this route answered a cheerful `count: 0` with a fresh timestamp, which
 * is indistinguishable from a quiet ocean — see the kernel header.
 *
 * ── CDN CACHE IS FRESHNESS-DEPENDENT ──────────────────────────────────
 * A healthy list caches 30 min (NHC advisories every 3–6 h; EONET updates
 * ~2×/day). A degraded or stale one caches 60 s — caching a total outage
 * for half an hour turns a 10-second upstream blip into a 30-minute
 * blackout for every visitor behind that edge node.
 */

import { buildStormsPayload } from './_lib/storms.js';

export const config = { runtime: 'edge' };

// Both feeds are keyless and CORS-open.
const NHC_URL   = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?category=severeStorms&status=open';

const USER_AGENT = 'ParkerPhysics/1.0 (+https://parkersphysics.com)';

// Per-attempt timeouts. The retry is deliberately SHORTER than the first
// attempt: if the upstream didn't answer in 8 s it is not healthy, and
// two full-length attempts in series would push the whole handler past a
// typical edge invocation budget with both feeds in flight.
const ATTEMPT_TIMEOUT_MS = [8000, 4000];

const CACHE_S = { live: 1800, degraded: 60, stale: 60 };

/**
 * Fetch JSON with one bounded retry. 4xx is NOT retried — a client-side
 * error (bad URL, upstream moved) will fail identically the second time
 * and spending the budget on it only delays the other feed's answer.
 */
async function fetchJson(url) {
    let lastErr = 'unreachable';
    for (let attempt = 0; attempt < ATTEMPT_TIMEOUT_MS.length; attempt++) {
        try {
            const r = await fetch(url, {
                headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
                signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS[attempt]),
            });
            if (!r.ok) {
                lastErr = `HTTP ${r.status}`;
                if (r.status >= 400 && r.status < 500) break;   // permanent — don't retry
                continue;
            }
            return { ok: true, data: await r.json() };
        } catch (err) {
            // Includes AbortError (timeout), DNS/TLS failures, and JSON
            // parse errors — an upstream serving an HTML error page is a
            // failure even though the transport succeeded.
            lastErr = err?.name === 'TimeoutError'
                ? `timeout after ${ATTEMPT_TIMEOUT_MS[attempt]}ms`
                : (err?.message || String(err));
        }
    }
    return { ok: false, error: lastErr };
}

export default async function handler() {
    const nowMs = Date.now();

    // Promise.all is safe here: fetchJson never rejects, it resolves
    // {ok:false}. allSettled would only re-wrap an outcome we already own.
    const [nhcRes, eonetRes] = await Promise.all([
        fetchJson(NHC_URL),
        fetchJson(EONET_URL),
    ]);

    const body   = buildStormsPayload(nhcRes, eonetRes, nowMs);
    const maxAge = CACHE_S[body.freshness] ?? CACHE_S.stale;

    return new Response(JSON.stringify(body), {
        headers: {
            'content-type':  'application/json',
            'cache-control': `public, max-age=${maxAge}, s-maxage=${maxAge}`,
            'access-control-allow-origin': '*',
            // Surfaces the health in the response headers too, so a curl
            // or an edge log line shows it without parsing the body.
            'x-feed-freshness': body.freshness,
        },
    });
}
