/**
 * Vercel Edge Function: /api/bz/feeds?feed=<id>[&meta=1][&samples=N]
 *
 * The Bz engine's raw-observation relay (BZ_ENGINE_PLAN.md phase B0). ALL of
 * the logic — the candidate URL lists, the field resolution, the normalisers,
 * the freshness rule — lives in the PURE module js/bz/feeds.js; this file only
 * supplies a bounded fetch and shapes the response. Read that header first.
 *
 *   feed     one of FEED_IDS (l1-mag · l1-mag-fast · l1-ephem · geo-mag ·
 *            ground-1s). Anything else is a 400. There is NO passthrough URL
 *            parameter: every upstream URL is rebuilt from the frozen
 *            catalogue (that is this route's whole SSRF story).
 *   meta=1   probe EVERY candidate in parallel and return the report only
 *            (shape, cadence, spacecraft, field_map, unmapped keys) — the one
 *            production request that settles an UNVERIFIED feed:
 *              curl '…/api/bz/feeds?feed=l1-mag&meta=1' | jq .candidates
 *   samples  how many trailing samples per spacecraft to return on the data
 *            path (default 180, max 1440).
 *
 * NEVER a 5xx for an upstream failure: a total miss is 200 +
 * freshness:'expired' + reasons, so status.html scores it red instead of
 * reading a dead feed as a broken route.
 *
 * NOTE: NOAA's WAF 403s some server-side calls to services.swpc.noaa.gov
 * (api/health.js). On 2026-11-20 these JSON files answered the edge normally;
 * if they ever 403, the candidate report says so per URL and the same
 * js/bz/feeds.js runs browser-direct as the fallback.
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { FEEDS, FEED_IDS, runFeed, summarize } from '../../js/bz/feeds.js';

export const config = { runtime: 'edge' };

const DEFAULT_SAMPLES = 180;
const MAX_SAMPLES = 1440;

async function fetchJson(url) {
    let res;
    try {
        res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' }, timeoutMs: 9000 });
    } catch (e) {
        return { ok: false, status: null, error: String(e?.name === 'TimeoutError' ? 'timeout' : (e?.message ?? e)).slice(0, 120) };
    }
    const contentType = res.headers.get('content-type');
    if (!res.ok) return { ok: false, status: res.status, contentType, error: `HTTP ${res.status}` };
    // A 200 that is not JSON is an error page (the DONKI lesson) — say so.
    let body;
    try { body = await res.json(); }
    catch { return { ok: false, status: res.status, contentType, error: 'not JSON' }; }
    return { ok: true, status: res.status, contentType, body };
}

/** Keep only the trailing `n` samples of each spacecraft / satellite. */
function trimSamples(data, n) {
    if (!data) return data;
    const out = { ...data };
    for (const group of ['spacecraft', 'satellites']) {
        if (!data[group]) continue;
        out[group] = {};
        for (const [k, v] of Object.entries(data[group])) {
            out[group][k] = { ...v, samples: (v.samples ?? []).slice(-n) };
        }
    }
    return out;
}

export default async function handler(req) {
    const url = new URL(req.url);
    const feedId = url.searchParams.get('feed') ?? '';
    if (!FEED_IDS.includes(feedId)) {
        return jsonError('bad_feed', `feed must be one of: ${FEED_IDS.join(', ')}`, { status: 400 });
    }
    const meta = url.searchParams.get('meta') === '1';
    const samples = Math.min(Math.max(Number(url.searchParams.get('samples')) || DEFAULT_SAMPLES, 1), MAX_SAMPLES);
    const feed = FEEDS[feedId];
    const nowMs = Date.now();

    let out;
    try {
        out = await runFeed(feedId, { fetchJson, nowMs, meta });
    } catch (e) {
        return jsonError('internal', String(e?.message ?? e).slice(0, 160), { status: 500 });
    }

    const body = {
        source: `${feed.upstream} via Vercel Edge`,
        feed: feedId,
        label: feed.label,
        verified: feed.verified,
        freshness: out.freshness,
        ...(out.reasons.length ? { reasons: out.reasons } : {}),
        age_seconds: out.data?.age_s ?? null,
        source_id: out.source_id,
        candidates: out.candidates,
        data: out.data
            ? { updated: new Date(nowMs - (out.data.age_s ?? 0) * 1000).toISOString(),
                ...(meta ? summarize(out.data) : trimSamples(out.data, samples)) }
            : null,
    };
    const ttl = Math.max(30, Math.min(feed.cadence_s, 300));
    return jsonOk(body, { maxAge: out.data ? ttl : 60, swr: 60 });
}
