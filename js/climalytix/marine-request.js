/**
 * climalytix/marine-request.js — the PURE half of /api/climalytix/marine:
 * validate + snap the site, build the upstream URL, normalise the answer.
 * Shared with the browser (it lives in js/, not api/_lib) so both ask for one
 * snapped site and one cache key. Node-gated by tests/climalytix-coast.mjs.
 *
 * BOOTSTRAP SOURCE, said in the body: Open-Meteo's Marine API (wave models —
 * MeteoFrance MFWAM, ECMWF WAM, NCEP GFS-Wave and others, best match per
 * cell — plus a sea-level model that includes the tide). Free tier,
 * non-commercial, exactly like the ERA5 archive route; CLIMALYTIX_PLAN.md
 * §17's data engine replaces it and nothing paid may be built on this route.
 *
 * WHAT IT IS NOT. A wave MODEL cell is tens of kilometres across and sits
 * offshore: it is the sea arriving at the coast, not the surf on one beach.
 * The sea level is a MODEL including tide, not a tide gauge — US sites have
 * real gauges behind /api/ocean/tides and this route does not stand in for
 * them. Every body says so in `note`.
 *
 * THE VARIABLE NAMES ARE UNVERIFIED (the host is egress-blocked at build
 * time), so each quantity resolves from a CANDIDATE LIST and the body
 * self-reports `field_map` / `missing` — the noaa-regions pattern. A quantity
 * the upstream does not send is a null series, never a zero one, and the
 * request RETRIES with only the core wave variables if the full list is
 * refused (an unknown variable name is an HTTP 400 for the whole request).
 */

import { snapCoord, haversineKm } from './archive-request.js';

export const OPEN_METEO_MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
export const MARINE_PAST_DAYS = 1;
export const MARINE_FORECAST_DAYS = 5;
/** A sea cell farther than this from the site is somebody else's sea. */
export const MARINE_MAX_CELL_KM = 60;

/** quantity → upstream names to try, in order. `core` ones are asked for even on the retry. */
export const MARINE_VARIABLES = Object.freeze({
    waveM:        { core: true,  names: ['wave_height'] },
    waveDirDeg:   { core: true,  names: ['wave_direction'] },
    wavePeriodS:  { core: true,  names: ['wave_period'] },
    swellM:       { core: false, names: ['swell_wave_height'] },
    swellDirDeg:  { core: false, names: ['swell_wave_direction'] },
    swellPeriodS: { core: false, names: ['swell_wave_period'] },
    windWaveM:    { core: false, names: ['wind_wave_height'] },
    sstC:         { core: false, names: ['sea_surface_temperature'] },
    seaLevelM:    { core: false, names: ['sea_level_height_msl'] },
});
export const MARINE_UNITS = Object.freeze({
    waveM: 'm', waveDirDeg: 'deg (from)', wavePeriodS: 's', swellM: 'm', swellDirDeg: 'deg (from)', swellPeriodS: 's',
    windWaveM: 'm', sstC: '°C', seaLevelM: 'm above mean sea level',
});

const SOURCE = 'Open-Meteo Marine API (best-match wave model + sea-level model)';
const NOTE = 'Model output for the nearest SEA cell, not a measurement at the beach: waves are the sea arriving offshore, and sea level is a model that includes the tide, not a tide gauge. Bootstrap source until the Climalytix data engine serves this site.';
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Validate + snap. Returns { lat, lon } or { error }. A missing parameter is an error, never 0. */
export function parseMarineQuery({ lat, lon } = {}) {
    const toNum = (x) => (x == null || String(x).trim() === '' ? NaN : Number(x));
    const la = toNum(lat), lo = toNum(lon);
    if (!(isNum(la) && la >= -90 && la <= 90)) return { error: 'lat must be a number in [-90, 90]' };
    if (!(isNum(lo) && lo >= -180 && lo <= 180)) return { error: 'lon must be a number in [-180, 180]' };
    return { lat: snapCoord(la), lon: snapCoord(lo) };
}

/** The same-origin path a client asks for (one canonical cache key). */
export function marinePath({ lat, lon }) {
    return `/api/climalytix/marine?lat=${snapCoord(lat).toFixed(2)}&lon=${snapCoord(lon).toFixed(2)}`;
}

/** The upstream URL. `coreOnly` is the retry after a 4xx on the full variable list. */
export function buildMarineUrl({ lat, lon }, { coreOnly = false } = {}) {
    const names = Object.values(MARINE_VARIABLES).filter((v) => v.core || !coreOnly).flatMap((v) => v.names);
    const p = new URLSearchParams({
        latitude: lat.toFixed(2), longitude: lon.toFixed(2),
        hourly: names.join(','),
        timeformat: 'unixtime', timezone: 'UTC',
        length_unit: 'metric', cell_selection: 'sea',
        past_days: String(MARINE_PAST_DAYS), forecast_days: String(MARINE_FORECAST_DAYS),
    });
    return `${OPEN_METEO_MARINE_URL}?${p}`;
}

/**
 * Upstream JSON → the route's body, or null when there is no sea here (no
 * hourly rows, or not one finite wave height). Instants are epoch ms; every
 * value is a finite number or null.
 */
export function normalizeMarine(up, req, fetchedAtMs) {
    const Hh = up?.hourly;
    if (!Hh || !Array.isArray(Hh.time) || !Hh.time.length) return null;
    const times = Hh.time.map((s) => (isNum(s) ? s * 1000 : null));
    if (times.some((t) => t == null)) return null;
    const series = {}, fieldMap = {}, missing = [];
    for (const [key, spec] of Object.entries(MARINE_VARIABLES)) {
        const name = spec.names.find((n) => Array.isArray(Hh[n]));
        if (!name) { series[key] = times.map(() => null); missing.push(key); continue; }
        fieldMap[key] = name;
        series[key] = times.map((_, i) => (isNum(Hh[name][i]) ? Hh[name][i] : null));
        if (!series[key].some((v) => v != null)) missing.push(key);
    }
    if (!series.waveM.some((v) => v != null)) return null;
    const gLat = isNum(up.latitude) ? up.latitude : null, gLon = isNum(up.longitude) ? up.longitude : null;
    const dist = gLat != null && gLon != null ? +haversineKm(req.lat, req.lon, gLat, gLon).toFixed(1) : null;
    const far = dist != null && dist > MARINE_MAX_CELL_KM;
    return {
        source: SOURCE, role: 'bootstrap', note: NOTE,
        site: { lat: req.lat, lon: req.lon, cell_lat: gLat, cell_lon: gLon, cell_distance_km: dist },
        times, series, units: MARINE_UNITS,
        field_map: fieldMap, missing,
        fetched_at: new Date(fetchedAtMs).toISOString(),
        // A cell that far away is not this coast's sea: say so rather than present it as local.
        freshness: far ? 'stale' : 'live',
        ...(far ? { reasons: ['sea_cell_far'] } : {}),
    };
}

/** The degraded body: 200 + freshness:'expired', never a 5xx (CLAUDE.md §8). */
export function degradedMarine(req, reason, fetchedAtMs) {
    return {
        source: SOURCE, role: 'bootstrap',
        site: req ? { lat: req.lat, lon: req.lon } : null,
        times: null, series: null,
        fetched_at: new Date(fetchedAtMs).toISOString(),
        freshness: 'expired', reasons: [reason],
        note: 'No marine data for this request; nothing is substituted for it.',
    };
}

/** Value of a series at an instant, interpolated between the bracketing hours; a gap either side is a gap. */
export function marineAt(body, key, ms) {
    const t = body?.times, a = body?.series?.[key];
    if (!Array.isArray(t) || !Array.isArray(a) || !(ms >= t[0] && ms <= t[t.length - 1])) return null;
    let i = 0;
    while (i < t.length - 2 && t[i + 1] <= ms) i++;
    const x = a[i], y = a[i + 1];
    if (!isNum(x) || !isNum(y)) return ms === t[i] && isNum(x) ? x : null;
    const w = (ms - t[i]) / (t[i + 1] - t[i]);
    if (/DirDeg$/.test(key)) {                      // a direction is an angle: interpolate the short way round
        const d = ((y - x + 540) % 360) - 180;
        return ((x + d * w) % 360 + 360) % 360;
    }
    return x + (y - x) * w;
}
