/**
 * climalytix/aq-field.js — the location map's AIR-QUALITY field, PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no ambient time (tests/climalytix-aq-field.mjs pins every
 * rule). Shared by the route (api/climalytix/aq-field.js), which fetches, and
 * the page, which draws.
 *
 * THE SOURCE IS A BOOTSTRAP, AND SAYS SO. Surface PM2.5 / O₃ / NO₂ / dust /
 * 550 nm AOD are the Copernicus CAMS global model, read through Open-Meteo's
 * free air-quality API — the same path the rest of the site already uses
 * (api/air-quality/*). Copernicus data allow commercial use with attribution;
 * Open-Meteo's FREE endpoint is non-commercial, so for Climalytix it is the
 * `bootstrap` role (badged on the page, CLIMALYTIX_PLAN.md §0), to be
 * replaced by our own CAMS ingest without changing this layer's contract.
 * It is a MODEL, never relabelled as a measurement: monitors are drawn
 * separately and compared against it.
 *
 * THE GRID is the map's own data window: 0.5° nodes (CAMS global is ~0.4°)
 * within ±4° of the site snapped to the node lattice — 17 × 17 = 289
 * locations, one Open-Meteo request through the ONE chunker
 * (js/open-meteo-request.js `chunkUrl`, which refuses a URL that would 414).
 *
 * THE TIME AXIS is 3-hourly UTC instants (00, 03, … Z) — the same instants a
 * GFS run carries, so the pollution rose can join wind and PM2.5 BY INSTANT.
 * Hours are matched by instant per location, never by array position (the
 * Pollution Lab rule), and a missing hour is a gap (null), never 0. Hourly
 * values at the 3-hourly instants are SAMPLES, not 3-hour means — said in the
 * rail.
 *
 * THE BODY has the nwp-field layout (time,row,col; `fields` per variable;
 * `values` = PM2.5) so the map's sampling and colouring code reads it as is.
 *
 * COLOUR is the EPA category of the PM2.5 sub-index (js/aqi-scale.js — the
 * site's ONE scale and palette), applied AFTER the concentration is
 * interpolated between nodes. The EPA PM2.5 AQI is defined on 24-hour (or
 * NowCast) averages; colouring an HOURLY model value by it is an "AQI-
 * equivalent", and the rail says so. PM2.5 is the one quantity drawn (the
 * Pollution Lab rule: no `aqi/2`, no composite relabelled as PM2.5).
 */

import { chunkRanges, chunkUrl, formatCoord, locationsPerRequest, maxCoordBytes } from '../open-meteo-request.js';
import { aqiFromConcentration, categoryForAqi } from '../aqi-scale.js';

export const AQ_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
export const AQ_STEP_DEG = 0.5;
export const AQ_HALF_DEG = 4;
export const AQ_CADENCE_H = 3;
export const AQ_PAST_DAYS = 1;
export const AQ_FORECAST_DAYS = 5;
export const AQ_VARS = Object.freeze([
    Object.freeze({ id: 'pm25', om: 'pm2_5', unit: 'µg/m³', label: 'PM2.5' }),
    Object.freeze({ id: 'o3', om: 'ozone', unit: 'µg/m³', label: 'Ozone' }),
    Object.freeze({ id: 'no2', om: 'nitrogen_dioxide', unit: 'µg/m³', label: 'NO₂' }),
    Object.freeze({ id: 'dust', om: 'dust', unit: 'µg/m³', label: 'Dust' }),
    Object.freeze({ id: 'aod', om: 'aerosol_optical_depth', unit: '', label: 'AOD 550 nm' }),
]);
export const AQ_SOURCE = 'Copernicus CAMS global (via Open-Meteo’s free air-quality API — bootstrap source)';
/** A monitor is compared with the model only when a field instant is this close. */
export const RESIDUAL_MAX_DT_MS = 1.5 * 3_600_000;

const H = 3_600_000;
const wrap180 = (x) => { const v = ((((x + 180) % 360) + 360) % 360) - 180; return v + 0; };

/** Snap a site to the node lattice; the window's nodes, row-major from the NW corner. */
export function aqGrid(lat, lon, { step = AQ_STEP_DEG, half = AQ_HALF_DEG } = {}) {
    const cLat = Math.round(lat / step) * step, cLon = Math.round(lon / step) * step;
    const n = Math.round(half / step);
    const latN = Math.min(90, cLat + n * step);
    const latS = Math.max(-90, cLat - n * step);
    const nRows = Math.round((latN - latS) / step) + 1, nCols = 2 * n + 1;
    const lonW = cLon - n * step;                 // continuous with the site
    const lats = [], lons = [];
    for (let i = 0; i < nRows; i++) for (let j = 0; j < nCols; j++) {
        lats.push(+(latN - i * step).toFixed(6));
        lons.push(+wrap180(lonW + j * step).toFixed(6));
    }
    return { latN: +latN.toFixed(6), lonW: +lonW.toFixed(6), dlat: step, dlon: step, nRows, nCols, lats, lons,
             centre: { lat: +cLat.toFixed(6), lon: +wrap180(cLon).toFixed(6) } };
}

export function aqQuery() {
    return `hourly=${AQ_VARS.map((v) => v.om).join(',')}&timeformat=unixtime&timezone=GMT`
        + `&domains=cams_global&cell_selection=nearest&past_days=${AQ_PAST_DAYS}&forecast_days=${AQ_FORECAST_DAYS}`;
}

/** The upstream URLs for a grid (in location order), via the ONE chunker. */
export function aqRequestUrls(grid, { base = AQ_URL } = {}) {
    const lats = grid.lats.map(formatCoord), lons = grid.lons.map(formatCoord);
    const query = aqQuery();
    const per = locationsPerRequest({ coordBytes: maxCoordBytes(lats, lons), queryBytes: query.length + 120 });
    return chunkRanges(lats.length, per).map(({ start, end }) => ({
        start, end,
        url: chunkUrl({ base, lats: lats.slice(start, end + 1), lons: lons.slice(start, end + 1), query }),
    }));
}

/** Client path (the snapped centre is the CDN key). */
export function aqPath({ lat, lon }) {
    const g = aqGrid(lat, lon);
    return `/api/climalytix/aq-field?lat=${g.centre.lat.toFixed(2)}&lon=${g.centre.lon.toFixed(2)}`;
}

/**
 * Normalise the merged per-location payloads (grid order) into the field body.
 * Throws when the location count does not match the grid (a half-failed
 * fan-out is never served as a whole field).
 */
export function aqFieldBody(grid, locations, { nowMs, site = null } = {}) {
    if (!Array.isArray(locations) || locations.length !== grid.lats.length) {
        throw new RangeError(`expected ${grid.lats.length} locations, got ${locations?.length}`);
    }
    // The shared 3-hourly axis: every UTC instant on the 3 h lattice that ANY
    // location reports, sorted. Matched per location BY INSTANT.
    const set = new Set();
    for (const loc of locations) {
        for (const s of loc?.hourly?.time || []) {
            const ms = Number(s) * 1000;
            if (Number.isFinite(ms) && ms % (AQ_CADENCE_H * H) === 0) set.add(ms);
        }
    }
    const times = [...set].sort((a, b) => a - b);
    const tIndex = new Map(times.map((ms, k) => [ms, k]));
    const plane = grid.nRows * grid.nCols;
    const fields = Object.fromEntries(AQ_VARS.map((v) => [v.id, new Array(times.length * plane).fill(null)]));
    let filled = 0;
    locations.forEach((loc, p) => {
        const ts = loc?.hourly?.time || [];
        ts.forEach((s, k) => {
            const ti = tIndex.get(Number(s) * 1000);
            if (ti == null) return;
            for (const v of AQ_VARS) {
                const x = loc.hourly[v.om]?.[k];
                // Gaps are NOT zeros: Number(null) is 0 and finite.
                if (x == null || x === '' || !Number.isFinite(Number(x))) continue;
                fields[v.id][ti * plane + p] = Math.round(Number(x) * 100) / 100;
                if (v.id === 'pm25') filled++;
            }
        });
    });
    return {
        source: AQ_SOURCE, role: 'bootstrap', kind: 'model', provider: 'Open-Meteo', dataset: 'CAMS global',
        freshness: filled ? 'fresh' : 'expired', reasons: filled ? [] : ['no_values'],
        site, fetchedMs: nowMs ?? null,
        latN: grid.latN, lonW: grid.lonW, dlat: grid.dlat, dlon: grid.dlon, nRows: grid.nRows, nCols: grid.nCols,
        times, cadenceH: AQ_CADENCE_H, layout: 'time,row,col',
        var: 'pm25', vars: AQ_VARS.map((v) => v.id),
        units: Object.fromEntries(AQ_VARS.map((v) => [v.id, v.unit])),
        fields, values: fields.pm25,
        note: 'CAMS global model (~0.4°), sampled on a 0.5° window at 3-hourly instants. A model, not monitor observations.',
    };
}

/** The degraded answer: 200 + expired + reasons, no partial field. */
export function degradedAq(site, reason, nowMs) {
    return {
        source: AQ_SOURCE, role: 'bootstrap', kind: 'model', freshness: 'expired', reasons: [reason],
        site, fetchedMs: nowMs ?? null, fields: null, values: null, times: [],
    };
}

/** PM2.5 (µg/m³) → its EPA sub-index (AQI-equivalent of an hourly value), or null. */
export function pm25Aqi(pm) {
    return pm == null || !Number.isFinite(pm) ? null : aqiFromConcentration('pm25', pm);
}

/**
 * A heat-image painter: concentration → the EPA category colour of its
 * sub-index, written RGBA into `data` at `o`. The categories are the site's
 * one palette (js/aqi-scale.js AQI_CATEGORIES).
 */
export function pm25Paint(pm, data, o, alpha = 255) {
    const cat = categoryForAqi(pm25Aqi(pm));
    if (!cat) return;
    data[o] = Math.round(cat.rgb[0] * 255); data[o + 1] = Math.round(cat.rgb[1] * 255);
    data[o + 2] = Math.round(cat.rgb[2] * 255); data[o + 3] = alpha;
}

/**
 * Monitors vs the model. monitors: [{ id, name, lat, lon, pm25, validMs }].
 * `sample(t, lat, lon)` is the map's field sampler; `times` the field axis.
 * A monitor is compared only when a field instant lies within
 * RESIDUAL_MAX_DT_MS of its reading. Returns [{ …monitor, model, diff }]
 * (diff = model − observed, µg/m³), plus null-model rows for the rest.
 */
export function residuals(monitors, times, sample, { maxDtMs = RESIDUAL_MAX_DT_MS } = {}) {
    return (monitors || []).map((m) => {
        if (!Number.isFinite(m?.pm25) || !Number.isFinite(m?.validMs) || !times?.length) return { ...m, model: null, diff: null, t: null };
        let best = 0;
        for (let k = 1; k < times.length; k++) if (Math.abs(times[k] - m.validMs) < Math.abs(times[best] - m.validMs)) best = k;
        if (Math.abs(times[best] - m.validMs) > maxDtMs) return { ...m, model: null, diff: null, t: null };
        const model = sample(best, m.lat, m.lon);
        return { ...m, t: best, model, diff: model == null ? null : Math.round((model - m.pm25) * 10) / 10 };
    });
}

/** Summary of residuals with a model value: n, bias (mean diff), mae. */
export function residualSummary(rows) {
    const d = rows.map((r) => r.diff).filter((x) => x != null && Number.isFinite(x));
    if (!d.length) return { n: 0, bias: null, mae: null };
    const bias = d.reduce((a, b) => a + b, 0) / d.length;
    const mae = d.reduce((a, b) => a + Math.abs(b), 0) / d.length;
    return { n: d.length, bias: Math.round(bias * 10) / 10, mae: Math.round(mae * 10) / 10 };
}

/**
 * Join a value series onto another axis BY INSTANT: for each of `onTimes`,
 * the value at exactly that instant in (times, values), else null.
 */
export function alignByInstant(times, values, onTimes) {
    const m = new Map();
    (times || []).forEach((t, k) => m.set(t, values[k]));
    return onTimes.map((t) => { const x = m.get(t); return x == null || !Number.isFinite(x) ? null : x; });
}
