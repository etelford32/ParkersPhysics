/**
 * Vercel Edge Function: /api/bz/geo[?minutes=N][&summary=1]
 *
 * Rung 3 of the Bz engine (BZ_ENGINE_PLAN.md phase B3): the GOES-East and
 * GOES-West magnetometers as a RESIDUAL against the internal field, and the
 * engine's first interior ledger — a prediction of that residual from the
 * wind that has ARRIVED (rungs 0–1), scored against the instrument.
 *
 * All analysis is js/bz/geo-analysis.js + flux-analysis.js (PURE).
 *
 *   curl '…/api/bz/geo?summary=1' | jq '.data.satellites[] | {slot, latest, ledger}'
 *
 * Degradation, never a 5xx for an upstream failure:
 *   GOES unavailable      → 200 + freshness:'expired' + data:null
 *   L1 chain unavailable  → 200 + freshness:'stale' + reasons; the MEASURED
 *                           residual is still returned, the ledger is empty
 *                           (no wind ⇒ no prediction, never a nominal one
 *                           presented as live)
 */
import { jsonOk, jsonError } from '../_lib/responses.js';
import { fetchJson } from '../_lib/bz-fetch.js';
import { FEEDS, runFeed, feedFreshness } from '../../js/bz/feeds.js';
import { analyzeFlux } from '../../js/bz/flux-analysis.js';
import { analyzeGeo } from '../../js/bz/geo-analysis.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
    const url = new URL(req.url);
    const minutes = Math.min(Math.max(Number(url.searchParams.get('minutes')) || 180, 1), 1440);
    const summary = url.searchParams.get('summary') === '1';
    const nowMs = Date.now();

    let geo, mag, ephem, plasma;
    try {
        [geo, mag, ephem, plasma] = await Promise.all([
            runFeed('geo-mag', { fetchJson, nowMs }),
            runFeed('l1-mag', { fetchJson, nowMs }),
            runFeed('l1-ephem', { fetchJson, nowMs }),
            runFeed('l1-plasma', { fetchJson, nowMs }),
        ]);
    } catch (e) {
        return jsonError('internal', String(e?.message ?? e).slice(0, 160), { status: 500 });
    }

    const base = { source: 'NOAA GOES MAG + SWPC RTSW via Vercel Edge · js/bz/geo-analysis.js', model: 'bz-geo-v0' };
    if (!geo.data) {
        return jsonOk({ ...base, freshness: 'expired', reasons: ['goes_mag_unavailable'], age_seconds: null,
            candidates: geo.candidates, data: null }, { maxAge: 60, swr: 60 });
    }

    const reasons = [];
    let wind = null, upstream = null;
    try {
        const flux = mag.data ? analyzeFlux({ mag: mag.data, ephem: ephem.data, plasma: plasma.data, nowMs, minutes: 1 }) : null;
        if (flux?._series?.arrivalMs?.length) {
            wind = flux._series;
            upstream = { reference_spacecraft: flux.reference_spacecraft, at_bow_shock_now: flux.flux?.at_bow_shock_now ?? null,
                method_minutes: flux.propagation?.method_minutes ?? null };
        } else reasons.push(!mag.data ? 'l1_mag_unavailable' : (flux?.reasons?.[0] ?? 'no_arrived_wind'));
    } catch (e) {
        reasons.push(`l1_analysis_failed`);
    }

    let data;
    try {
        data = analyzeGeo({ geo: geo.data, wind, nowMs, minutes });
    } catch (e) {
        return jsonError('internal', `analysis: ${String(e?.message ?? e).slice(0, 140)}`, { status: 500 });
    }

    let freshness = feedFreshness(FEEDS['geo-mag'], geo.data);
    if (freshness !== 'fresh') reasons.push(`newest_goes_sample_${geo.data.age_s}s_old`);
    if (!wind && freshness === 'fresh') freshness = 'stale';
    if (!Object.keys(data.satellites).length) { freshness = 'expired'; reasons.push('no_known_satellite'); }
    if (summary) for (const s of Object.values(data.satellites)) delete s.trace;

    return jsonOk({
        ...base,
        freshness,
        ...(reasons.length ? { reasons } : {}),
        age_seconds: geo.data.age_s,
        data: { updated: new Date(nowMs - (geo.data.age_s ?? 0) * 1000).toISOString(), upstream, ...data },
    }, { maxAge: 60, swr: 60 });
}
