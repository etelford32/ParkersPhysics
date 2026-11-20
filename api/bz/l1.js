/**
 * Vercel Edge Function: /api/bz/l1[?minutes=N][&summary=1]
 *
 * The L1 rung of the Bz engine (BZ_ENGINE_PLAN.md phase B1): the magnetic
 * field at the active L1 spacecraft, FUSED from every spacecraft in SWPC's
 * file after measured arrival-time alignment, with its σ, its flags, the
 * measured lags, the withheld-spacecraft score, band powers and a frame check.
 *
 * This file fetches two feeds and shapes the response. ALL of the analysis is
 * js/bz/l1-analysis.js (PURE) — the browser can run the same function on the
 * same two feeds. Read js/bz/fuse-l1.js's header for what is and is not
 * claimed.
 *
 *   minutes   length of the returned trace (default 180, max 1440)
 *   summary=1 everything except the trace — small enough to read by hand:
 *               curl '…/api/bz/l1?summary=1' | jq '.data.withheld_score, .data.lags'
 *
 * Degradation, never a 5xx for an upstream failure:
 *   magnetometers unavailable → 200 + freshness:'expired' + data:null
 *   ephemerides unavailable   → 200 + freshness:'stale'; lags are still
 *                               MEASURED, only the flat-delay fallback and
 *                               the positions are missing
 */
import { jsonOk, jsonError } from '../_lib/responses.js';
import { fetchJson } from '../_lib/bz-fetch.js';
import { FEEDS, runFeed, feedFreshness } from '../../js/bz/feeds.js';
import { analyzeL1 } from '../../js/bz/l1-analysis.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
    const url = new URL(req.url);
    const minutes = Math.min(Math.max(Number(url.searchParams.get('minutes')) || 180, 1), 1440);
    const summary = url.searchParams.get('summary') === '1';
    const nowMs = Date.now();

    let mag, ephem;
    try {
        [mag, ephem] = await Promise.all([
            runFeed('l1-mag', { fetchJson, nowMs }),
            runFeed('l1-ephem', { fetchJson, nowMs }),
        ]);
    } catch (e) {
        return jsonError('internal', String(e?.message ?? e).slice(0, 160), { status: 500 });
    }

    const base = { source: 'NOAA SWPC RTSW via Vercel Edge · js/bz/l1-analysis.js', model: 'bz-l1-fusion-v0' };
    if (!mag.data) {
        return jsonOk({ ...base, freshness: 'expired', reasons: ['l1_mag_unavailable'], age_seconds: null,
            candidates: mag.candidates, data: null }, { maxAge: 60, swr: 60 });
    }

    let data;
    try {
        data = analyzeL1({ mag: mag.data, ephem: ephem.data, nowMs, minutes });
    } catch (e) {
        return jsonError('internal', `analysis: ${String(e?.message ?? e).slice(0, 140)}`, { status: 500 });
    }
    if (!data) {
        return jsonOk({ ...base, freshness: 'expired', reasons: ['no_usable_spacecraft'], age_seconds: null, data: null },
            { maxAge: 60, swr: 60 });
    }

    const reasons = [];
    let freshness = feedFreshness(FEEDS['l1-mag'], { rows: 1, age_s: data.age_s });
    if (freshness !== 'fresh') reasons.push(`newest_fused_minute_${data.age_s}s_old`);
    if (!ephem.data) { reasons.push('ephemerides_unavailable'); if (freshness === 'fresh') freshness = 'stale'; }
    if (data.spacecraft.length < 2) { reasons.push('single_spacecraft'); if (freshness === 'fresh') freshness = 'stale'; }

    if (summary) delete data.trace;
    return jsonOk({
        ...base,
        freshness,
        ...(reasons.length ? { reasons } : {}),
        age_seconds: data.age_s,
        data: { updated: data.latest?.time ?? null, ...data },
    }, { maxAge: 60, swr: 60 });
}
