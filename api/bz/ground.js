/**
 * Vercel Edge Function: /api/bz/ground[?summary=1]
 *
 * The ground rung of the Bz engine (BZ_ENGINE_PLAN.md phase B5): the USGS
 * observatory network at ONE SECOND — dB/dt with its minute-product
 * under-read, pulsation bands, per-station equivalent current, the regional
 * electrojet proxy, sudden impulses and the timing score against the
 * pressure jumps the engine predicted — plus the ring-current rung (hourly Dst
 * beside the site's Dst model driven by the arrived wind).
 *
 * All analysis is js/bz/ground-analysis.js (PURE). This file fans out the
 * fetches: per station one 1-second request (the last hour) and one 1-minute
 * request (24 h, for the baseline). Station codes come from the fixed roster
 * in js/geomag/observatories.js; there is no passthrough parameter.
 *
 * A station that fails is a DROPOUT, not an error (the TIGA rule). Never a
 * 5xx for an upstream failure: no station at all → 200 + freshness:'expired'.
 */
import { jsonOk, jsonError } from '../_lib/responses.js';
import { fetchJson } from '../_lib/bz-fetch.js';
import { fetchGround } from '../_lib/bz-ground-fetch.js';
import { runFeed, normalizeDst, DST_URL } from '../../js/bz/feeds.js';
import { analyzeFlux } from '../../js/bz/flux-analysis.js';
import { analyzeGround, analyzeRing } from '../../js/bz/ground-analysis.js';

export const config = { runtime: 'edge' };

export default async function handler(req) {
    const summary = new URL(req.url).searchParams.get('summary') === '1';
    const nowMs = Date.now();
    let g, mag, ephem, plasma, dstRes;
    try {
        [g, mag, ephem, plasma, dstRes] = await Promise.all([
            fetchGround(nowMs),
            runFeed('l1-mag', { fetchJson, nowMs }),
            runFeed('l1-ephem', { fetchJson, nowMs }),
            runFeed('l1-plasma', { fetchJson, nowMs }),
            fetchJson(DST_URL),
        ]);
    } catch (e) {
        return jsonError('internal', String(e?.message ?? e).slice(0, 160), { status: 500 });
    }

    const reasons = [];
    let wind = null, ground = null, ring = null;
    try {
        const flux = mag.data ? analyzeFlux({ mag: mag.data, ephem: ephem.data, plasma: plasma.data, nowMs, minutes: 1 }) : null;
        wind = flux?._series?.arrivalMs?.length ? flux._series : null;
        if (!wind) reasons.push('no_arrived_wind');
        ground = analyzeGround({ fast: g.fast, slow: g.slow, wind, nowMs });
        const dst = dstRes.ok ? normalizeDst(dstRes.body) : [];
        if (!dst.length) reasons.push('dst_unavailable');
        ring = analyzeRing({ dst, wind, nowMs });
    } catch (e) {
        return jsonError('internal', `analysis: ${String(e?.message ?? e).slice(0, 140)}`, { status: 500 });
    }
    if (g.failed.length) reasons.push(`stations_down:${g.failed.join(',')}`);

    const base = { source: 'USGS Geomagnetism Program + NOAA SWPC via Vercel Edge · js/bz/ground-analysis.js', model: 'bz-ground-v0' };
    if (!ground) {
        return jsonOk({ ...base, freshness: 'expired', reasons: ['no_ground_station', ...reasons], age_seconds: null, data: { ring_current: ring } }, { maxAge: 60, swr: 60 });
    }
    let freshness = ground.latency_s != null && ground.latency_s <= 900 ? 'fresh' : (ground.latency_s <= 6 * 3600 ? 'stale' : 'expired');
    if (freshness === 'fresh' && (ground.stations_1s === 0 || reasons.length)) freshness = 'stale';
    if (ground.stations_1s === 0) reasons.push('no_1s_data');
    if (summary) ground.stations = ground.stations.map(({ iaga, dipole_lat, zone, delta_nt, dbdt_peak_nt_s, dbdt_underread }) => ({ iaga, dipole_lat, zone, north_nt: delta_nt.north, dbdt_peak_nt_s, dbdt_underread }));

    return jsonOk({
        ...base, freshness, ...(reasons.length ? { reasons } : {}),
        age_seconds: ground.latency_s,
        data: { updated: new Date(nowMs - (ground.latency_s ?? 0) * 1000).toISOString(), ground, ring_current: ring },
    }, { maxAge: 60, swr: 60 });
}
