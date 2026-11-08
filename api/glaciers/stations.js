/**
 * GET /api/glaciers/stations?g=<glacier id>
 *
 * Glacier Watch's in-situ DAILY sources for one glacier:
 *   streamflow — USGS gauges on the glacier's outlet stream (15-min discharge → the
 *                last 7 days, plus daily means for the last 400 days). Outlet discharge
 *                in summer is mostly melt: the most direct daily readout of a glacier
 *                melting that exists. US glaciers only; elsewhere `null` with a reason.
 *   snow       — the nearest NRCS SNOTEL stations (≤ SNOW_RADIUS_KM): daily snow-water
 *                equivalent and depth for the water year, with the station median when
 *                AWDB provides it. US glaciers only.
 *
 * UNVERIFIED (both hosts are egress-blocked from the build sandbox, 2026-11-08): the gauge
 * numbers are CANDIDATE lists tried in order and every JSON field resolves from a candidate
 * list; the response self-reports `gauge_used`, `tried`, `field_map` and `unmapped`. One
 * production request (`curl …/api/glaciers/stations?g=gulkana | jq`) settles them — then
 * record the winners here and trim. The volcano-activity / noaa-regions pattern.
 *
 * Never 5xx for upstream trouble: a dead source is that block's `{ ok:false, error }` and
 * a top-level freshness:'stale' + reasons, so status.html flags it.
 */
import { jsonOk } from '../_lib/responses.js';

export const config = { runtime: 'edge' };

const USGS_IV = 'https://waterservices.usgs.gov/nwis/iv/';
const USGS_DV = 'https://waterservices.usgs.gov/nwis/dv/';
const AWDB = 'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1';
const SNOW_RADIUS_KM = 80;
const CFS_TO_CMS = 0.028316846592;

// Glacier → outlet gauges (candidates, in order) and the states whose SNOTEL network to search.
export const STATIONS = {
    gulkana:         { lat: 63.27, lon: -145.42, usgs: ['15478040'], snotelStates: ['AK'], note: 'Phelan Creek near Paxson — the Gulkana benchmark-glacier outlet' },
    'south-cascade': { lat: 48.36, lon: -121.06, usgs: ['12181090', '12181100'], snotelStates: ['WA'], note: 'South Fork Cascade River at the South Cascade benchmark glacier' },
    columbia:        { lat: 61.17, lon: -147.08, usgs: [], snotelStates: ['AK'], note: 'Tidewater: no outlet stream gauge exists' },
};

const pick = (o, names) => { for (const n of names) if (o && o[n] !== undefined && o[n] !== null) return { name: n, value: o[n] }; return { name: null, value: undefined }; };

async function getJson(url, ms = 9000) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
    try {
        const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        try { return JSON.parse(text); } catch { throw new Error(`non-JSON (${text.slice(0, 40).replace(/\s+/g, ' ')}…)`); }
    } finally { clearTimeout(t); }
}

/** PURE — WaterML-JSON → [{t, q_cms}] + site name. Exported for the node gate. */
export function parseUsgs(json) {
    const ts = json?.value?.timeSeries?.[0];
    if (!ts) return { site: null, points: [] };
    const nodata = Number(ts.variable?.noDataValue ?? -999999);
    const vals = ts.values?.[0]?.value || [];
    const points = [];
    for (const v of vals) {
        const q = Number(v.value), t = Date.parse(v.dateTime);
        if (!Number.isFinite(q) || q === nodata || !Number.isFinite(t)) continue;
        points.push({ t, q_cms: +(q * CFS_TO_CMS).toFixed(3) });
    }
    return { site: ts.sourceInfo?.siteName ?? null, points };
}

async function streamflow(cfg) {
    if (!cfg?.usgs?.length) return { ok: false, error: cfg?.note || 'no outlet gauge for this glacier' };
    const tried = [];
    for (const site of cfg.usgs) {
        tried.push(site);
        try {
            const [iv, dv] = await Promise.all([
                getJson(`${USGS_IV}?format=json&sites=${site}&parameterCd=00060&period=P7D&siteStatus=all`),
                getJson(`${USGS_DV}?format=json&sites=${site}&parameterCd=00060&statCd=00003&period=P400D&siteStatus=all`),
            ]);
            const recent = parseUsgs(iv), daily = parseUsgs(dv);
            if (!recent.points.length && !daily.points.length) continue;
            return { ok: true, gauge_used: site, tried, site_name: recent.site || daily.site, units: 'm³/s', recent: recent.points, daily: daily.points,
                latest: recent.points.at(-1) || daily.points.at(-1) || null, source: 'USGS NWIS (waterservices.usgs.gov)' };
        } catch (e) { tried[tried.length - 1] += ` (${e.message})`; }
    }
    return { ok: false, tried, error: 'no candidate gauge answered with discharge' };
}

const haversineKm = (a, b, c, d) => {
    const R = 6371, r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
};

/** PURE — AWDB station list → nearest SNOTEL within radius. Field names from candidate lists. */
export function nearestSnotel(list, lat, lon, radiusKm = SNOW_RADIUS_KM, k = 2) {
    const used = {};
    const rows = (Array.isArray(list) ? list : list?.stations || []).map(s => {
        const tr = pick(s, ['stationTriplet', 'triplet', 'station_triplet']);
        const la = pick(s, ['latitude', 'lat']), lo = pick(s, ['longitude', 'lon', 'lng']);
        const el = pick(s, ['elevation', 'elev']), nm = pick(s, ['name', 'stationName']);
        for (const p of [tr, la, lo, el, nm]) if (p.name) used[p.name] = true;
        return { triplet: tr.value, name: nm.value ?? null, lat: Number(la.value), lon: Number(lo.value), elev_ft: el.value == null ? null : Number(el.value) };
    }).filter(s => s.triplet && Number.isFinite(s.lat) && Number.isFinite(s.lon) && /:SNTL$/.test(s.triplet));
    const near = rows.map(s => ({ ...s, km: +haversineKm(lat, lon, s.lat, s.lon).toFixed(1) })).filter(s => s.km <= radiusKm).sort((a, b) => a.km - b.km).slice(0, k);
    return { stations: near, field_map: Object.keys(used) };
}

/** PURE — AWDB data → per element [{t, v, median?}] (inches as published). */
export function parseAwdbData(json) {
    const out = {};
    const unmapped = new Set();
    const stations = Array.isArray(json) ? json : json?.data ? [json] : [];
    for (const st of stations) {
        const tr = pick(st, ['stationTriplet', 'triplet']).value;
        for (const el of st.data || []) {
            const code = pick(el.stationElement || el, ['elementCode', 'element']).value;
            if (!code) { unmapped.add('elementCode'); continue; }
            const vals = (el.values || []).map(v => {
                const t = Date.parse(pick(v, ['date', 'dateTime', 'collectionDate']).value);
                const val = Number(pick(v, ['value', 'v']).value);
                const med = pick(v, ['median', 'centralTendency']).value;
                return { t, v: Number.isFinite(val) ? val : null, median: med == null ? null : Number(med) };
            }).filter(r => Number.isFinite(r.t));
            (out[tr] ||= {})[code] = vals;
        }
    }
    return { byStation: out, unmapped: [...unmapped] };
}

async function snow(cfg, nowMs) {
    if (!cfg?.snotelStates?.length) return { ok: false, error: 'no SNOTEL network near this glacier (SNOTEL is US-only)' };
    try {
        const list = await getJson(`${AWDB}/stations?networkCds=SNTL&stateCds=${cfg.snotelStates.join(',')}&activeOnly=true`);
        const near = nearestSnotel(list, cfg.lat, cfg.lon);
        if (!near.stations.length) return { ok: false, error: `no active SNOTEL station within ${SNOW_RADIUS_KM} km`, field_map: near.field_map };
        const d = new Date(nowMs), wyStart = Date.UTC(d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1, 9, 1);
        const begin = new Date(Math.min(wyStart, nowMs - 60 * 864e5)).toISOString().slice(0, 10), end = new Date(nowMs).toISOString().slice(0, 10);
        const data = await getJson(`${AWDB}/data?stationTriplets=${near.stations.map(s => s.triplet).join(',')}&elements=WTEQ,SNWD&duration=DAILY&beginDate=${begin}&endDate=${end}&centralTendencyType=MEDIAN`);
        const parsed = parseAwdbData(data);
        return { ok: true, units: 'inches (SWE, depth) as published by NRCS', water_year_start: new Date(wyStart).toISOString().slice(0, 10),
            stations: near.stations.map(s => ({ ...s, series: parsed.byStation[s.triplet] || {} })),
            field_map: near.field_map, unmapped: parsed.unmapped, source: 'NRCS AWDB REST (SNOTEL)' };
    } catch (e) { return { ok: false, error: e.message }; }
}

export default async function handler(req) {
    const url = new URL(req.url);
    const id = (url.searchParams.get('g') || '').toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(id)) return jsonOk({ error: 'bad_request', detail: 'g=<glacier id> required' }, { status: 400, maxAge: 60 });
    const cfg = STATIONS[id];
    const nowMs = Date.now();
    if (!cfg) return jsonOk({ glacier: id, freshness: 'live', streamflow: { ok: false, error: 'no in-situ network configured for this glacier yet' }, snow: { ok: false, error: 'no in-situ network configured for this glacier yet' } }, { maxAge: 21600 });
    const [q, s] = await Promise.all([streamflow(cfg), snow(cfg, nowMs)]);
    const reasons = [cfg.usgs.length && !q.ok && 'streamflow-unavailable', !s.ok && cfg.snotelStates.length && 'snow-unavailable'].filter(Boolean);
    return jsonOk({ glacier: id, generated: new Date(nowMs).toISOString(), freshness: reasons.length ? 'stale' : 'live', reasons, note: cfg.note, streamflow: q, snow: s },
        reasons.length ? { maxAge: 600, swr: 120 } : { maxAge: 3600, swr: 600 });
}
