/**
 * Vercel Edge Function: /api/neo/watch
 *
 * "What is interesting near Earth right now" — three JPL SSD feeds in one
 * hourly-cached body for solar-system.html's Near-Earth Objects panel:
 *
 *   approaches  cad.api — every close approach to Earth from 7 days ago to
 *               60 days ahead inside 0.05 AU (≈19.5 lunar distances). JPL's
 *               integrated orbits, so the approach LIST never depends on the
 *               page's two-body propagation; the page uses the catalogue only
 *               to draw where each object is between the table's rows.
 *   sentry      sentry.api — the impact-risk monitor, trimmed to the 40
 *               highest Palermo-scale entries (Torino > 0 always kept).
 *   fireballs   fireball.api — the last 20 bolides from US Government
 *               sensors: the meteors that actually arrived.
 *
 * Each feed fails independently and says so in `sources.*`. Only the CAD
 * table decides `freshness`: without it the panel has no approach list, which
 * is the one thing this route exists to serve. Never 5xx — a dead JPL must
 * render amber on status.html, not as "the site is broken".
 *
 * No client parameters reach any upstream URL (api/_lib/neo-sources.js builds
 * them from frozen tables and the clock).
 *
 * Cache: s-maxage=3600 / swr=3600. CAD's window slides with the clock; an
 * hour of staleness is well inside the ±day resolution the panel shows.
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import {
    cadUrl, sentryUrl, fireballUrl,
    parseCad, parseSentry, parseFireballs, composeWatchResponse,
} from '../_lib/neo-sources.js';

export const config = { runtime: 'edge' };

const CACHE_TTL = 3_600;
const CACHE_SWR = 3_600;
const TIMEOUT_MS = 15_000;

async function fetchJson(url) {
    let res;
    try {
        res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' }, timeoutMs: TIMEOUT_MS });
    } catch (e) {
        return { ok: false, reason: `unreachable: ${e.message || 'fetch failed'}` };
    }
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    try { return { ok: true, json: await res.json() }; } catch (e) { return { ok: false, reason: `unparseable: ${e.message}` }; }
}

const parseWith = (fetched, parser) => (fetched.ok ? parser(fetched.json) : { ok: false, reason: fetched.reason });

export default async function handler() {
    const nowMs = Date.now();
    const [cadRes, sentryRes, fireRes] = await Promise.all([
        fetchJson(cadUrl(nowMs)),
        fetchJson(sentryUrl()),
        fetchJson(fireballUrl()),
    ]);

    const body = composeWatchResponse({
        cad:       parseWith(cadRes, parseCad),
        sentry:    parseWith(sentryRes, parseSentry),
        fireballs: parseWith(fireRes, parseFireballs),
        nowMs,
    });
    return jsonOk(body, body.freshness === 'live'
        ? { maxAge: CACHE_TTL, swr: CACHE_SWR }
        : { maxAge: 300, swr: 600 });
}
