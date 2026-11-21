/**
 * Vercel Edge Function: /api/bz/column
 *
 * The Bz engine's altitude ladder (BZ_ENGINE_PLAN.md phase B4): every rung
 * from L1 to the ground in one object, each tagged MEASURED · ESTIMATED ·
 * FORECAST · NOT_BUILT · NOT_AVAILABLE with its σ, its basis and its caveats.
 * This is the endpoint pages read (through js/bz-engine-provider.js).
 *
 * It fetches four feeds and assembles; ALL analysis is the pure modules
 * (js/bz/flux-analysis.js, geo-analysis.js, column.js).
 *
 *   curl '…/api/bz/column' | jq '.data.rungs[] | {id, kind, values}'
 *
 * Never a 5xx for an upstream failure. A rung whose feed is down is
 * NOT_AVAILABLE with the reason; freshness is 'expired' only when BOTH
 * measured ends (L1 and GOES) are gone, 'stale' when one is, or when the
 * newest L1 minute is old.
 */
import { jsonOk, jsonError } from '../_lib/responses.js';
import { fetchJson } from '../_lib/bz-fetch.js';
import { FEEDS, runFeed, feedFreshness } from '../../js/bz/feeds.js';
import { analyzeFlux } from '../../js/bz/flux-analysis.js';
import { analyzeGeo } from '../../js/bz/geo-analysis.js';
import { buildColumn } from '../../js/bz/column.js';
import { analyzeGround, analyzeRing } from '../../js/bz/ground-analysis.js';
import { fetchGround } from '../_lib/bz-ground-fetch.js';
import { normalizeDst, DST_URL } from '../../js/bz/feeds.js';

export const config = { runtime: 'edge' };

export default async function handler() {
    const nowMs = Date.now();
    let geo, mag, ephem, plasma, g, dstRes;
    try {
        [geo, mag, ephem, plasma, g, dstRes] = await Promise.all([
            runFeed('geo-mag', { fetchJson, nowMs }),
            runFeed('l1-mag', { fetchJson, nowMs }),
            runFeed('l1-ephem', { fetchJson, nowMs }),
            runFeed('l1-plasma', { fetchJson, nowMs }),
            fetchGround(nowMs).catch(() => ({ fast: {}, slow: {}, failed: [], diagnostics: null })),
            fetchJson(DST_URL),
        ]);
    } catch (e) {
        return jsonError('internal', String(e?.message ?? e).slice(0, 160), { status: 500 });
    }

    const reasons = [];
    let flux = null, geoA = null, ground = null, ring = null;
    try {
        if (mag.data) flux = analyzeFlux({ mag: mag.data, ephem: ephem.data, plasma: plasma.data, nowMs, minutes: 1 });
        else reasons.push('l1_mag_unavailable');
        if (flux?.reasons) reasons.push(...flux.reasons);
        if (mag.data && !ephem.data) reasons.push('ephemerides_unavailable');
        if (geo.data) geoA = analyzeGeo({ geo: geo.data, wind: flux?._series ?? null, nowMs, minutes: 1 });
        else reasons.push('goes_mag_unavailable');
        ground = analyzeGround({ fast: g.fast, slow: g.slow, wind: flux?._series ?? null, nowMs });
        if (!ground) reasons.push('ground_unavailable');
        if (g.deadlineHit) reasons.push('usgs_slow');
        const dst = dstRes.ok ? normalizeDst(dstRes.body) : [];
        ring = analyzeRing({ dst, wind: flux?._series ?? null, nowMs });
        if (!ring) reasons.push('dst_unavailable');
    } catch (e) {
        return jsonError('internal', `analysis: ${String(e?.message ?? e).slice(0, 140)}`, { status: 500 });
    }

    const column = buildColumn({ flux, geo: geoA, ground, ring, nowMs });
    const l1Fresh = flux ? feedFreshness(FEEDS['l1-mag'], { rows: 1, age_s: flux.age_s }) : 'expired';
    const geoFresh = geo.data ? feedFreshness(FEEDS['geo-mag'], geo.data) : 'expired';
    let freshness = 'fresh';
    if (l1Fresh === 'expired' && geoFresh === 'expired') freshness = 'expired';
    else if (l1Fresh !== 'fresh' || geoFresh !== 'fresh' || reasons.length) freshness = 'stale';
    if (flux && l1Fresh !== 'fresh') reasons.push(`newest_l1_minute_${flux.age_s}s_old`);

    return jsonOk({
        source: 'NOAA SWPC RTSW + GOES MAG via Vercel Edge · js/bz/column.js',
        model: 'bz-column-v0',
        freshness,
        ...(reasons.length ? { reasons } : {}),
        age_seconds: flux?.age_s ?? geo.data?.age_s ?? null,
        feeds: { l1_mag: mag.source_id, l1_plasma: plasma.source_id, l1_ephem: ephem.source_id, geo_mag: geo.source_id,
            ground_stations: ground ? ground.stations_total : 0, ground_1s: ground ? ground.stations_1s : 0, dst: !!ring,
            ...(g.diagnostics && Object.keys(g.diagnostics.failures).length ? { ground_failures: g.diagnostics.failures } : {}) },
        data: { updated: flux?.latest?.time ?? column.time, ...column },
    }, { maxAge: 60, swr: 60 });
}
