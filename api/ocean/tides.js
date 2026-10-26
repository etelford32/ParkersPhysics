/**
 * NOAA CO-OPS tide gauges.
 *
 *   ?mode=stations                         global marker catalogue
 *   ?lat=37.8&lon=-122.5&hours=72         nearest gauge + live tide data
 *
 * Degradation (2026-10-26, EARTHVIEW_LOD_UX_PLAN.md Phase 0.8): an upstream
 * failure is a 200 with `freshness: 'stale'`, never a 503 — the stations
 * catalogue becomes the flagged reference markers in
 * js/ocean-reference-stations.js (the ONE copy, shared with the browser
 * layer), a point request becomes `available: false` + `reason`. status.html
 * then scores the row amber instead of red, and the Layers-panel toggle keeps
 * working. Client errors (bad coordinates) stay 400.
 */

import { jsonError, jsonOk, fetchWithTimeout, isoTag } from '../_lib/responses.js';
import { finiteOrNull, haversineKm, roundTo, validCoordinates } from '../_lib/ocean.js';
import { referenceStationsPayload, unavailablePayload } from '../../js/ocean-reference-stations.js';

const SOURCE_URL = 'https://tidesandcurrents.noaa.gov/';
// A degraded answer is cached briefly so recovery shows within a reload.
const STALE_MAX_AGE = 60;

export const config = { runtime: 'edge' };

const COOPS_DATA = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const COOPS_STATIONS = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels';
const SOURCE = 'NOAA CO-OPS';
const DATUM = 'MLLW';
const MAX_STATION_DISTANCE_KM = 500;

function isTidal(station) {
    return station?.tidal === true || String(station?.tidal).toLowerCase() === 'true';
}

export function normalizeStations(stations) {
    return (stations ?? []).flatMap(station => {
        if (!isTidal(station)) return [];
        const lat = finiteOrNull(station.lat);
        const lon = finiteOrNull(station.lng ?? station.lon);
        if (!validCoordinates(lat, lon)) return [];
        return [{
            id: String(station.id),
            name: String(station.name ?? station.id),
            state: station.state ? String(station.state) : null,
            lat,
            lon,
        }];
    });
}

export function chooseNearestStation(stations, lat, lon) {
    let nearest = null;
    for (const station of stations ?? []) {
        const distanceKm = haversineKm(lat, lon, station.lat, station.lon);
        if (!nearest || distanceKm < nearest.distance_km) {
            nearest = { ...station, distance_km: distanceKm };
        }
    }
    return nearest;
}

export function normalizePredictions(rows, includeType = false) {
    return (rows ?? []).flatMap(row => {
        const height = finiteOrNull(row.v);
        const time = isoTag(row.t);
        if (height === null || !time || !Number.isFinite(Date.parse(time))) return [];
        const result = { time, height_m: height };
        if (includeType) result.type = row.type === 'H' ? 'high' : 'low';
        return [result];
    });
}

export function interpolatePrediction(points, targetTime) {
    const target = typeof targetTime === 'number' ? targetTime : Date.parse(targetTime);
    if (!Number.isFinite(target) || !points?.length) return null;
    const samples = points
        .map(p => ({ t: Date.parse(p.time), v: finiteOrNull(p.height_m) }))
        .filter(p => Number.isFinite(p.t) && p.v !== null)
        .sort((a, b) => a.t - b.t);
    if (!samples.length || target < samples[0].t || target > samples.at(-1).t) return null;
    for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1], b = samples[i];
        if (target > b.t) continue;
        if (b.t === a.t) return a.v;
        const f = (target - a.t) / (b.t - a.t);
        return a.v + (b.v - a.v) * f;
    }
    return samples.at(-1).v;
}

async function fetchJson(url) {
    const response = await fetchWithTimeout(url, {
        timeoutMs: 9000,
        headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body?.error) throw new Error(body.error.message ?? 'CO-OPS returned an error');
    return body;
}

function productUrl(stationId, product, extra = {}) {
    return `${COOPS_DATA}?${new URLSearchParams({
        station: stationId,
        product,
        datum: DATUM,
        time_zone: 'gmt',
        units: 'metric',
        application: 'ParkersPhysics',
        format: 'json',
        ...extra,
    })}`;
}

export default async function handler(request) {
    const url = new URL(request.url);
    const stationsMode = url.searchParams.get('mode') === 'stations';
    // Validate the client's own input BEFORE touching NOAA, so a bad request
    // is a 400 whether or not the upstream is up.
    const latRaw = url.searchParams.get('lat');
    const lonRaw = url.searchParams.get('lon');
    const lat = latRaw == null || latRaw === '' ? NaN : Number(latRaw);
    const lon = lonRaw == null || lonRaw === '' ? NaN : Number(lonRaw);
    if (!stationsMode && !validCoordinates(lat, lon)) {
        return jsonError('invalid_coordinates', 'lat and lon are required and must be valid degrees', {
            status: 400, source: SOURCE,
        });
    }
    try {
        const stationBody = await fetchJson(COOPS_STATIONS);
        const stations = normalizeStations(stationBody.stations);
        if (!stations.length) throw new Error('CO-OPS station catalogue was empty');

        if (stationsMode) {
            return jsonOk({
                source: SOURCE,
                source_url: SOURCE_URL,
                freshness: 'live',
                count: stations.length,
                stations,
                disclaimer: 'Not for navigation.',
            }, { maxAge: 86400, swr: 3600 });
        }

        const nearest = chooseNearestStation(stations, lat, lon);
        if (!nearest || nearest.distance_km > MAX_STATION_DISTANCE_KM) {
            return jsonOk({
                source: SOURCE,
                available: false,
                reason: 'no_nearby_station',
                nearest_station: nearest ? { ...nearest, distance_km: roundTo(nearest.distance_km, 1) } : null,
                max_distance_km: MAX_STATION_DISTANCE_KM,
                disclaimer: 'Not for navigation.',
            });
        }

        const hours = Math.max(24, Math.min(120, Math.round(Number(url.searchParams.get('hours')) || 72)));
        const beginDate = new Date().toISOString().slice(0, 10).replaceAll('-', '');
        const requests = await Promise.allSettled([
            fetchJson(productUrl(nearest.id, 'water_level', { date: 'latest' })),
            fetchJson(productUrl(nearest.id, 'predictions', { begin_date: beginDate, range: String(hours), interval: 'h' })),
            fetchJson(productUrl(nearest.id, 'predictions', { begin_date: beginDate, range: String(hours), interval: 'hilo' })),
        ]);
        const observedRow = requests[0].status === 'fulfilled' ? requests[0].value.data?.[0] : null;
        const observedHeight = finiteOrNull(observedRow?.v);
        const observedTime = isoTag(observedRow?.t);
        const hourly = requests[1].status === 'fulfilled' ? normalizePredictions(requests[1].value.predictions) : [];
        const extremes = requests[2].status === 'fulfilled' ? normalizePredictions(requests[2].value.predictions, true) : [];
        const predictedNow = observedTime ? interpolatePrediction(hourly, observedTime) : null;
        const residual = observedHeight !== null && predictedNow !== null ? observedHeight - predictedNow : null;
        if (observedHeight === null && !hourly.length && !extremes.length) throw new Error('All CO-OPS products were unavailable');

        return jsonOk({
            source: SOURCE,
            source_url: SOURCE_URL,
            freshness: 'live',
            available: true,
            station: { ...nearest, distance_km: roundTo(nearest.distance_km, 1), datum: DATUM },
            observed: observedHeight === null ? null : {
                time: observedTime,
                height_m: observedHeight,
                sigma_m: finiteOrNull(observedRow?.s),
                quality: observedRow?.q ? String(observedRow.q) : null,
            },
            predicted_now_m: roundTo(predictedNow, 3),
            residual_m: roundTo(residual, 3),
            hourly,
            extremes,
            units: { height: 'm', datum: DATUM, time: 'UTC' },
            disclaimer: 'Not for navigation.',
        }, { maxAge: 300, swr: 120 });
    } catch (error) {
        // Degraded, not dead: 200 + freshness: 'stale' (header note).
        const body = stationsMode
            ? referenceStationsPayload('tides', { source: SOURCE, source_url: SOURCE_URL, detail: error.message })
            : unavailablePayload({ source: SOURCE, detail: error.message, extra: { source_url: SOURCE_URL } });
        return jsonOk(body, { maxAge: STALE_MAX_AGE, swr: 0 });
    }
}
