/**
 * Vercel Edge Function: /api/bz/flux[?minutes=N][&summary=1]
 *
 * Rung 1 of the Bz engine (BZ_ENGINE_PLAN.md phase B2): the fused L1 field
 * carried to the bow-shock nose by a PHASE-FRONT delay (three-spacecraft lags
 * → minimum-variance → flat, each labelled), and the dayside reconnection rate
 * it implies, ordered by arrival time and running past "now" by the delay.
 *
 * All of the analysis is js/bz/flux-analysis.js (PURE). This file fetches
 * three feeds and shapes the response.
 *
 *   curl '…/api/bz/flux?summary=1' | jq '.data.flux.at_bow_shock_now, .data.propagation'
 *
 * Degradation, never a 5xx for an upstream failure:
 *   magnetometers unavailable → 200 + freshness:'expired' + data:null
 *   plasma unavailable        → 200 + freshness:'stale'; the fused field is
 *                               still returned, flux and propagation are null
 *                               (no speed ⇒ no delay and no rate — never a
 *                               nominal 400 km/s dressed as a measurement)
 *   ephemerides unavailable   → 200 + freshness:'stale'; no positions ⇒ no
 *                               delay to a target
 */
import { jsonOk, jsonError } from '../_lib/responses.js';
import { fetchJson } from '../_lib/bz-fetch.js';
import { FEEDS, runFeed, feedFreshness } from '../../js/bz/feeds.js';
import { analyzeFlux } from '../../js/bz/flux-analysis.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
    const url = new URL(req.url);
    const minutes = Math.min(Math.max(Number(url.searchParams.get('minutes')) || 180, 1), 1440);
    const summary = url.searchParams.get('summary') === '1';
    const nowMs = Date.now();

    let mag, ephem, plasma;
    try {
        [mag, ephem, plasma] = await Promise.all([
            runFeed('l1-mag', { fetchJson, nowMs }),
            runFeed('l1-ephem', { fetchJson, nowMs }),
            runFeed('l1-plasma', { fetchJson, nowMs }),
        ]);
    } catch (e) {
        return jsonError('internal', String(e?.message ?? e).slice(0, 160), { status: 500 });
    }

    const base = { source: 'NOAA SWPC RTSW via Vercel Edge · js/bz/flux-analysis.js', model: 'bz-flux-v0' };
    if (!mag.data) {
        return jsonOk({ ...base, freshness: 'expired', reasons: ['l1_mag_unavailable'], age_seconds: null,
            candidates: mag.candidates, data: null }, { maxAge: 60, swr: 60 });
    }

    let data;
    try {
        data = analyzeFlux({ mag: mag.data, ephem: ephem.data, plasma: plasma.data, nowMs, minutes });
    } catch (e) {
        return jsonError('internal', `analysis: ${String(e?.message ?? e).slice(0, 140)}`, { status: 500 });
    }
    if (!data) {
        return jsonOk({ ...base, freshness: 'expired', reasons: ['no_usable_spacecraft'], age_seconds: null, data: null },
            { maxAge: 60, swr: 60 });
    }

    const reasons = [...(data.reasons ?? [])];
    delete data.reasons;
    let freshness = feedFreshness(FEEDS['l1-mag'], { rows: 1, age_s: data.age_s });
    if (freshness !== 'fresh') reasons.push(`newest_fused_minute_${data.age_s}s_old`);
    const degrade = (why) => { reasons.push(why); if (freshness === 'fresh') freshness = 'stale'; };
    if (!plasma.data && !reasons.includes('no_plasma')) degrade('no_plasma');
    else if (reasons.includes('no_plasma') && freshness === 'fresh') freshness = 'stale';
    if (!ephem.data) degrade('ephemerides_unavailable');
    if (data.flux && !data.flux.at_bow_shock_now) degrade('nothing_has_arrived_yet');

    // The plasma feed's schema report rides along until it is settled (feeds.js `verified: null`).
    const plasmaReport = plasma.data ? {
        source_id: plasma.source_id, vectors: plasma.data.vectors, field_map: plasma.data.field_map, unmapped: plasma.data.unmapped,
        spacecraft: Object.fromEntries(Object.entries(plasma.data.spacecraft).map(([k, v]) =>
            [k, { n: v.n, cadence_s: v.cadence_s, last: v.last, speed_valid: v.speed_valid, density_valid: v.density_valid, vector_valid: v.vector_valid }])),
    } : { candidates: plasma.candidates };

    delete data.trace;                       // the L1 trace lives on /api/bz/l1
    delete data._series;                     // internal hand-off to the rungs below
    if (summary) { if (data.flux) delete data.flux.trace; delete data.spectrum; }
    return jsonOk({
        ...base,
        freshness,
        ...(reasons.length ? { reasons } : {}),
        age_seconds: data.age_s,
        plasma_feed: plasmaReport,
        data: { updated: data.latest?.time ?? null, ...data },
    }, { maxAge: 60, swr: 60 });
}
