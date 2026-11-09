/**
 * Vercel Edge Function: /api/climalytix/archive?lat=&lon=&from=YYYY
 *
 * Daily ERA5 / ERA5-Land reanalysis for one site since `from` (default 1991,
 * minimum 1940) — the long record Climalytix's Explore timeline, climatology
 * and extremes stand on (CLIMALYTIX_PLAN.md §5). The existing
 * /api/weather/forecast?type=archive caps at 365 days for temp-forecast.js
 * and stays as it is.
 *
 * BOOTSTRAP SOURCE, said in the body: Open-Meteo's historical API, whose free
 * tier is non-commercial. The plan's §17 data engine replaces it; nothing
 * paid may be built on this route.
 *
 * The pure half (snap, validate, URL, normalise) is
 * js/climalytix/archive-request.js — shared with the browser so both ask for
 * one snapped site and one cache key — node-gated by
 * tests/climalytix-archive.mjs.
 *
 * NEVER A 5xx FOR A DEGRADED ANSWER (CLAUDE.md §8): an upstream failure is a
 * 200 with `freshness: 'expired'`, `daily: null` and the reason, so
 * status.html scores it amber instead of a healthy 200. Bad input is a 400.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import {
    parseArchiveQuery, buildArchiveUrl, normalizeArchive, degradedArchive,
} from '../../js/climalytix/archive-request.js';

export const config = { runtime: 'edge' };

// Reanalysis for dates older than a week never changes; the newest days
// refresh once a day. 12 h at the edge, a day of stale-while-revalidate.
const CACHE_TTL = 43_200;
const CACHE_SWR = 86_400;

export default async function handler(req) {
    const url = new URL(req.url);
    const q = parseArchiveQuery({
        lat: url.searchParams.get('lat'),
        lon: url.searchParams.get('lon'),
        from: url.searchParams.get('from'),
    });
    if (q.error) return jsonError('bad_request', q.error, { status: 400 });

    const now = Date.now();
    let up;
    try {
        // 85 years of daily rows is a large single upstream call; give it room.
        const res = await fetchWithTimeout(buildArchiveUrl(q, now), { timeoutMs: 20_000 });
        if (!res.ok) {
            return jsonOk(degradedArchive(q, `upstream HTTP ${res.status}`, now), { maxAge: 120, swr: 0 });
        }
        up = await res.json();
    } catch (e) {
        const reason = e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'upstream timeout' : 'upstream unreachable';
        return jsonOk(degradedArchive(q, reason, now), { maxAge: 120, swr: 0 });
    }

    const body = normalizeArchive(up, q, now);
    if (!body) return jsonOk(degradedArchive(q, 'upstream returned no daily rows', now), { maxAge: 120, swr: 0 });
    return jsonOk(body, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
