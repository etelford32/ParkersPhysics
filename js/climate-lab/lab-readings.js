/**
 * climate-lab/lab-readings.js — station observation → instrument readings.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE (`nowMs` is always a parameter). The bench renderer draws exactly what
 * this returns and computes nothing, so every number on a tile is node-
 * testable against a fixture — tests/climate-lab.mjs.
 *
 * Every instrument returns the same shape, which is what lets the bench be
 * customised (hide / reorder) without per-tile layout code:
 *
 *   { id, ok, missing?,
 *     primary: { label, q, v } | null,          q = a lab-units quantity
 *     rows:    [{ label, q?, v?, text?, signed? }],
 *     status:  { label, tone, icon } | null,    tone ∈ good|caution|warning|serious|critical|neutral
 *     spark:   { q, values, t, nowIdx, kind: 'line'|'bars', label } | null,
 *     meter:   { kind: 'range'|'fill', v, min, max, lo?, hi? } | null,
 *     visual:  { kind: 'compass'|'layers', … } | null,
 *     method:  'one-line provenance / formula' }
 *
 * Values are SI (lab-physics conventions); lab-units converts on the way out.
 * Status chips always carry an icon AND a label — a colour never says
 * "danger" on its own (the dataviz status rule).
 */

import {
    apparentTempC, wetBulbStullC, absoluteHumidityGm3, mixingRatioGkg, vpdHpa,
    airDensityKgM3, densityAltitudeM, stationPressureFromMslHpa, cloudBaseLclM,
    tendencyFromSeries, beaufort, uvCategory, dewPointComfort, visibilityClass,
    windShift, degreeDays, dewPointC, ISA,
} from './lab-physics.js';
import { computeAdvisories, heatIndexF, windChillF, frostRisk, cToF, fToC } from '../composite-indices.js';
import { solarPosition, compass16 } from '../sun-altitude.js';
import { categoryForAqi } from '../aqi-scale.js';
import { hourIndexAt, dayRowAt, hourlyWindow } from './lab-feed.js';

const HOUR = 3_600_000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const TONE_ICON = Object.freeze({
    good: '●', neutral: '○', caution: '▲', warning: '▲', serious: '◆', critical: '✖',
});
const status = (label, tone = 'neutral') => ({ label, tone, icon: TONE_ICON[tone] || '○' });

/** Sum of an hourly channel over (fromMs, toMs]; null if no sample exists. */
function sumWindow(H, key, fromMs, toMs) {
    let s = 0, n = 0;
    H.t.forEach((t, i) => {
        if (t != null && t > fromMs && t <= toMs && isNum(H[key][i])) { s += H[key][i]; n++; }
    });
    return n ? s : null;
}
function extremeWindow(H, key, fromMs, toMs, pickMax = true) {
    let best = null, at = null;
    H.t.forEach((t, i) => {
        const v = H[key][i];
        if (t == null || t <= fromMs || t > toMs || !isNum(v)) return;
        if (best == null || (pickMax ? v > best : v < best)) { best = v; at = t; }
    });
    return best == null ? null : { v: best, t: at };
}
function valueNear(H, key, ms) {
    let best = null, bestDt = Infinity;
    H.t.forEach((t, i) => {
        if (t == null || !isNum(H[key][i])) return;
        const dt = Math.abs(t - ms);
        if (dt < bestDt) { bestDt = dt; best = H[key][i]; }
    });
    return bestDt <= 90 * 60_000 ? best : null;
}

/**
 * The station's "now": the model's 15-minute `current` block where it has a
 * value, else the hourly sample at or before now. Returned in SI.
 */
export function currentConditions(obs, nowMs) {
    const i = hourIndexAt(obs, nowMs);
    const C = obs.current || {}, H = obs.hourly;
    const pick = (k) => (isNum(C[k]) ? C[k] : (i >= 0 && isNum(H[k]?.[i]) ? H[k][i] : null));
    const cur = {};
    for (const k of Object.keys(H)) if (k !== 't') cur[k] = pick(k);
    cur.pop = i >= 0 ? H.pop[i] : null;       // probability is hourly-only
    if (!isNum(cur.dewC) && isNum(cur.tempC) && isNum(cur.rhPct)) cur.dewC = dewPointC(cur.tempC, cur.rhPct);
    // Station pressure: the model's surface_pressure; when absent, the ISA
    // reduction from MSL + elevation — and `stationDerived` says so.
    cur.stationDerived = false;
    if (!isNum(cur.stationHpa) && isNum(cur.mslHpa) && isNum(obs.station?.elevationM)) {
        cur.stationHpa = stationPressureFromMslHpa(cur.mslHpa, obs.station.elevationM);
        cur.stationDerived = true;
    }
    return cur;
}

// ── Instruments ─────────────────────────────────────────────────────────────

function thermo(ctx) {
    const { cur, day, H, win } = ctx;
    if (!isNum(cur.tempC)) return null;
    const app = apparentTempC(cur.tempC, cur.rhPct, cur.windMs);
    const t24 = valueNear(H, 'tempC', ctx.nowMs - 24 * HOUR);
    const rows = [
        { label: 'Feels like', q: 'temp', v: app.valueC,
          note: app.method === 'heat-index' ? 'NWS heat index' : app.method === 'wind-chill' ? 'NWS wind chill' : 'air temperature' },
        { label: 'Today high / low', text: null, pair: [{ q: 'temp', v: day?.highC }, { q: 'temp', v: day?.lowC }] },
    ];
    if (isNum(t24)) rows.push({ label: 'vs 24 h ago', q: 'tempDelta', v: cur.tempC - t24, signed: true });
    return {
        primary: { label: 'Air temperature', q: 'temp', v: cur.tempC },
        rows,
        status: null,
        spark: { q: 'temp', label: 'Temperature', kind: 'line', ...win('tempC') },
        // Scale = today's range padded 25 % each side (and stretched to hold
        // "now" if it is outside the forecast range), so the day reads as a
        // segment on a track rather than filling it.
        meter: isNum(day?.highC) && isNum(day?.lowC)
            ? (() => {
                const pad = Math.max(1, (day.highC - day.lowC) * 0.25);
                return { kind: 'range', v: cur.tempC, lo: day.lowC, hi: day.highC,
                    min: Math.min(day.lowC - pad, cur.tempC), max: Math.max(day.highC + pad, cur.tempC) };
            })()
            : null,
        method: 'Feels-like: NWS Rothfusz heat index / 2001 wind chill (composite-indices.js)',
    };
}

function hygro(ctx) {
    const { cur } = ctx;
    if (!isNum(cur.rhPct)) return null;
    const comfort = dewPointComfort(cur.dewC);
    const tone = !comfort ? 'neutral' : comfort.level >= 4 ? 'serious' : comfort.level >= 2 ? 'caution' : 'good';
    return {
        primary: { label: 'Relative humidity', q: 'pct', v: cur.rhPct },
        rows: [
            { label: 'Dew point', q: 'temp', v: cur.dewC },
            { label: 'Dew-point depression', q: 'tempDelta', v: isNum(cur.tempC) && isNum(cur.dewC) ? cur.tempC - cur.dewC : null },
        ],
        status: comfort ? status(comfort.label, tone) : null,
        spark: { q: 'pct', label: 'Humidity', kind: 'line', ...ctx.win('rhPct') },
        meter: { kind: 'fill', v: cur.rhPct, min: 0, max: 100 },
        method: 'Comfort from dew point, on the °F bands US forecasters use',
    };
}

function baro(ctx) {
    const { cur, H } = ctx;
    if (!isNum(cur.mslHpa)) return null;
    const tend = tendencyFromSeries(H.t, H.mslHpa, ctx.nowMs);
    const arrow = !tend ? '' : tend.trend === 'rising' ? '↗' : tend.trend === 'falling' ? '↘' : '→';
    const tone = !tend ? 'neutral'
        : tend.trend === 'falling' && (tend.rate === 'quickly' || tend.rate === 'very rapidly') ? 'warning'
        : 'neutral';
    const hint = !tend ? null
        : tend.trend === 'falling' && tend.rate !== 'slowly' ? 'Falling pressure often precedes unsettled weather'
        : tend.trend === 'rising' && tend.rate !== 'slowly' ? 'Rising pressure usually brings settling weather'
        : null;
    return {
        primary: { label: 'Sea-level pressure', q: 'pressure', v: cur.mslHpa },
        rows: [
            { label: '3-hour change', q: 'pressure', v: tend?.deltaHpa ?? null, signed: true },
            { label: cur.stationDerived ? 'Station pressure (ISA est.)' : 'Station pressure', q: 'pressure', v: cur.stationHpa },
            ...(hint ? [{ label: 'Reading', text: hint }] : []),
        ],
        status: tend ? status(`${arrow} ${tend.label}`, tone) : null,
        spark: { q: 'pressure', label: 'Pressure', kind: 'line', ...ctx.win('mslHpa') },
        meter: null,
        method: 'Tendency over 3 h in UK Met Office terms (steady < 0.1 · slowly ≤ 1.5 · quickly > 3.5 hPa)',
    };
}

function anemo(ctx) {
    const { cur, H } = ctx;
    if (!isNum(cur.windMs)) return null;
    const bf = beaufort(cur.windMs);
    const next12 = [];
    H.t.forEach((t, i) => { if (t != null && t >= ctx.nowMs && t <= ctx.nowMs + 12 * HOUR) next12.push(H.windDir[i]); });
    const shift = windShift(next12);
    const tone = !bf ? 'neutral' : bf.force >= 10 ? 'critical' : bf.force >= 8 ? 'serious' : bf.force >= 6 ? 'caution' : 'good';
    return {
        primary: { label: 'Wind speed', q: 'wind', v: cur.windMs },
        rows: [
            { label: 'Gusts', q: 'wind', v: cur.gustMs },
            { label: 'From', text: isNum(cur.windDir) ? `${compass16(cur.windDir)} · ${Math.round(cur.windDir)}°` : '—' },
            ...(shift ? [{ label: 'Next 12 h', text: shift.kind === 'steady' ? 'Direction steady'
                : `${shift.kind === 'veering' ? 'Veering' : 'Backing'} ${Math.round(Math.abs(shift.netDeg))}°` }] : []),
        ],
        status: bf ? status(`Force ${bf.force} · ${bf.name}`, tone) : null,
        spark: { q: 'wind', label: 'Wind speed', kind: 'line', ...ctx.win('windMs') },
        visual: { kind: 'compass', dirDeg: cur.windDir, speedMs: cur.windMs, gustMs: cur.gustMs },
        method: 'Beaufort force on WMO 10 m thresholds; veering = clockwise shift',
    };
}

function rain(ctx) {
    const { H, day, nowMs } = ctx;
    const next24 = sumWindow(H, 'precipMm', nowMs, nowMs + 24 * HOUR);
    const past24 = sumWindow(H, 'precipMm', nowMs - 24 * HOUR, nowMs);
    const popMax = extremeWindow(H, 'pop', nowMs, nowMs + 24 * HOUR, true);
    if (next24 == null && past24 == null && !popMax) return null;
    const p = popMax?.v;
    const st = !isNum(p) ? null
        : p >= 80 ? status('Rain very likely', 'warning')
        : p >= 50 ? status('Rain likely', 'caution')
        : p >= 20 ? status('Rain possible', 'neutral')
        : status('Dry', 'good');
    return {
        primary: { label: 'Expected next 24 h', q: 'precip', v: next24 },
        rows: [
            { label: 'Peak chance, 24 h', q: 'pct', v: p ?? null },
            { label: 'Fell, past 24 h', q: 'precip', v: past24 },
            { label: 'Today’s total', q: 'precip', v: day?.precipMm ?? null },
        ],
        status: st,
        spark: { q: 'precip', label: 'Hourly precipitation', kind: 'bars', ...ctx.win('precipMm') },
        meter: null,
        method: 'Model precipitation (hourly sums); chance = hourly probability of ≥ 0.1 mm',
    };
}

function sun(ctx) {
    const { cur, day, obs, nowMs } = ctx;
    const pos = isNum(obs.station?.lat) ? solarPosition(new Date(nowMs), obs.station.lat, obs.station.lon) : null;
    if (!isNum(cur.uvi) && !isNum(cur.swWm2) && !pos) return null;
    const cat = uvCategory(cur.uvi);
    const tone = !cat ? 'neutral' : ['good', 'caution', 'warning', 'serious', 'critical'][cat.level];
    return {
        primary: { label: 'UV index', q: 'uvi', v: cur.uvi },
        rows: [
            { label: 'Solar irradiance', q: 'wm2', v: cur.swWm2 },
            { label: 'Sun elevation', text: pos ? `${pos.altitudeDeg.toFixed(1)}° · ${compass16(pos.azimuthDeg)}` : '—' },
            { label: 'Today’s peak UV', q: 'uvi', v: day?.uviMax ?? null },
            { label: 'Sunshine today', q: 'hours', v: day?.sunshineS ?? null },
        ],
        status: cat ? status(`${cat.label} UV`, tone) : null,
        spark: { q: 'wm2', label: 'Solar irradiance', kind: 'line', ...ctx.win('swWm2') },
        meter: isNum(cur.uvi) ? { kind: 'fill', v: Math.min(cur.uvi, 12), min: 0, max: 12 } : null,
        method: 'WHO UV categories; sun position NOAA/Meeus (sun-altitude.js)',
    };
}

function sky(ctx) {
    const { cur } = ctx;
    if (!isNum(cur.cloudPct) && !isNum(cur.visM)) return null;
    const vis = visibilityClass(cur.visM, cur.rhPct);
    const lcl = cloudBaseLclM(cur.tempC, cur.dewC);
    const tone = !vis ? 'neutral' : vis.level >= 3 ? 'serious' : vis.level === 2 ? 'caution' : 'good';
    return {
        primary: { label: 'Cloud cover', q: 'pct', v: cur.cloudPct },
        rows: [
            { label: 'Visibility', q: 'distance', v: cur.visM },
            { label: 'Cumulus base (est.)', q: 'height', v: lcl.valueM },
        ],
        status: vis ? status(vis.id === 'good' || vis.id === 'moderate' ? `${vis.label} visibility` : vis.label, tone) : null,
        spark: { q: 'pct', label: 'Cloud cover', kind: 'line', ...ctx.win('cloudPct') },
        visual: { kind: 'layers', low: cur.cloudLow, mid: cur.cloudMid, high: cur.cloudHigh },
        method: 'Cumulus base ≈ 125 m × (T − Td) (Espy / Lawrence 2005) — not a ceilometer reading',
    };
}

function psychro(ctx) {
    const { cur } = ctx;
    if (!isNum(cur.tempC) || !isNum(cur.rhPct)) return null;
    const tw = wetBulbStullC(cur.tempC, cur.rhPct);
    const st = !tw.valid ? status('Outside fit range', 'neutral')
        : tw.valueC >= 31 ? status('Extreme heat stress', 'critical')
        : tw.valueC >= 28 ? status('High heat stress', 'serious')
        : tw.valueC >= 26 ? status('Heat stress caution', 'caution')
        : null;
    return {
        primary: { label: 'Wet-bulb temperature', q: 'temp', v: tw.valueC },
        rows: [
            { label: 'Vapour-pressure deficit', q: 'vpd', v: vpdHpa(cur.tempC, cur.rhPct) },
            { label: 'Absolute humidity', q: 'gm3', v: absoluteHumidityGm3(cur.tempC, cur.rhPct) },
            { label: 'Mixing ratio', q: 'gkg', v: mixingRatioGkg(cur.tempC, cur.rhPct, cur.stationHpa) },
        ],
        status: st,
        spark: null,
        meter: null,
        method: 'Stull 2011 wet-bulb (valid RH 5–99 %, −20…50 °C); Tetens vapour pressure',
    };
}

function density(ctx) {
    const { cur } = ctx;
    if (!isNum(cur.tempC) || !isNum(cur.stationHpa)) return null;
    const rho = airDensityKgM3(cur.tempC, cur.rhPct, cur.stationHpa);
    const da = densityAltitudeM(rho);
    return {
        primary: { label: 'Air density', q: 'kgm3', v: rho },
        rows: [
            { label: 'Density altitude', q: 'height', v: da },
            { label: 'vs ISA sea level', q: 'pct', v: (rho / ISA.RHO0 - 1) * 100, signed: true },
            { label: 'Station elevation', q: 'height', v: ctx.obs.station?.elevationM ?? null },
        ],
        status: null,
        spark: null,
        meter: null,
        method: cur.stationDerived
            ? 'Moist-air density at station pressure REDUCED from sea level via ISA — an estimate'
            : 'Moist-air density ρ = p_d/(R_d T) + e/(R_v T) at station pressure; ISA density altitude',
    };
}

function air(ctx) {
    const a = ctx.air;
    if (!a || !isNum(a.aqi)) return null;
    const cat = categoryForAqi(a.aqi);
    const toneFor = { good: 'good', moderate: 'caution', sensitive: 'warning', unhealthy: 'serious', very: 'critical', hazardous: 'critical' };
    const hourly = Array.isArray(a.aqiHourly) ? a.aqiHourly : [];
    const lo = ctx.nowMs - 24 * HOUR, hi = ctx.nowMs + 24 * HOUR;
    const pts = hourly.filter((p) => isNum(p?.time) && p.time >= lo && p.time <= hi);
    let nowIdx = -1;
    pts.forEach((p, i) => { if (p.time <= ctx.nowMs) nowIdx = i; });
    const pol = a.pollutants || {};
    return {
        primary: { label: 'US AQI', q: 'index', v: a.aqi },
        rows: [
            { label: 'PM2.5', q: 'ugm3', v: pol.pm25 ?? null },
            { label: 'Ozone', q: 'ugm3', v: pol.ozone ?? null },
            ...(a.aqiDominant ? [{ label: 'Driver', text: String(a.aqiDominant).toUpperCase().replace('_', ' ') }] : []),
        ],
        status: cat ? status(cat.name, toneFor[cat.key] || 'neutral') : null,
        spark: pts.length > 2 ? { q: 'index', label: 'US AQI', kind: 'line', values: pts.map((p) => p.aqi ?? null), t: pts.map((p) => p.time), nowIdx } : null,
        meter: { kind: 'fill', v: Math.min(a.aqi, 300), min: 0, max: 300 },
        method: `CAMS model (not a monitor) · ${a.aqiMethod === 'nowcast' ? 'EPA NowCast' : 'EPA 24-h composite'}${a.stale ? ' · STALE' : ''}`,
    };
}

function hazard(ctx) {
    const { cur, H, nowMs } = ctx;
    if (!isNum(cur.tempC)) return null;
    const adv = computeAdvisories({ tempC: cur.tempC, rhPct: cur.rhPct, windMs: cur.windMs, dewC: cur.dewC });
    // Forecast peaks over the next 24 h, from the same NWS formulas.
    let hiMax = null, wcMin = null, frost = 'none';
    H.t.forEach((t, i) => {
        if (t == null || t <= nowMs || t > nowMs + 24 * HOUR) return;
        const tc = H.tempC[i]; if (!isNum(tc)) return;
        const tf = cToF(tc);
        if (tf >= 80 && isNum(H.rhPct[i])) {
            const hiF = heatIndexF(tf, H.rhPct[i]);
            if (isNum(hiF) && (hiMax == null || hiF > hiMax)) hiMax = hiF;
        }
        if (tf <= 50 && isNum(H.windMs[i]) && H.windMs[i] * 2.23694 > 3) {
            const wc = windChillF(tf, H.windMs[i] * 2.23694);
            if (isNum(wc) && (wcMin == null || wc < wcMin)) wcMin = wc;
        }
        const f = frostRisk(tc, H.dewC[i]);
        const rank = { none: 0, watch: 1, advisory: 2, warning: 3 };
        if (rank[f] > rank[frost]) frost = f;
    });
    const sevTone = { danger: 'critical', warning: 'serious', caution: 'caution', info: 'neutral' };
    const top = adv[0];
    const rows = adv.slice(0, 3).map((a) => ({ label: a.label, text: `${a.value}${a.units ? ' ' + a.units : ''} · ${a.severity}` }));
    if (isNum(hiMax)) rows.push({ label: 'Peak heat index, 24 h', q: 'temp', v: fToC(hiMax) });
    if (isNum(wcMin)) rows.push({ label: 'Lowest wind chill, 24 h', q: 'temp', v: fToC(wcMin) });
    if (frost !== 'none') rows.push({ label: 'Frost/freeze, 24 h', text: frost === 'warning' ? 'Hard freeze' : frost === 'advisory' ? 'Freeze' : 'Frost likely' });
    if (!rows.length) rows.push({ label: 'Now', text: 'No heat, cold, fire or frost thresholds crossed' });
    return {
        primary: null,
        rows,
        status: top ? status(top.label, sevTone[top.severity] || 'neutral')
            : frost !== 'none' ? status('Frost/freeze ahead', 'caution')
            : status('All clear', 'good'),
        spark: null,
        meter: null,
        method: 'NWS heat index & wind chill, Fosberg FFWI, Hot-Dry-Windy, NWS frost thresholds',
    };
}

function degree(ctx) {
    const { day } = ctx;
    const dd = degreeDays(day?.highC, day?.lowC);
    if (!dd) return null;
    return {
        primary: { label: 'Growing degree days (base 10 °C)', q: 'dd', v: dd.gdd },
        rows: [
            { label: 'Heating degree days', q: 'dd', v: dd.hdd },
            { label: 'Cooling degree days', q: 'dd', v: dd.cdd },
            { label: 'Reference evapotranspiration', q: 'precip', v: day?.et0Mm ?? null },
        ],
        status: null,
        spark: null,
        meter: null,
        method: 'Mean-temperature method on today’s forecast high/low; HDD/CDD base 65 °F; ET₀ FAO-56',
    };
}

function soil(ctx) {
    const { cur, day } = ctx;
    if (!isNum(cur.soilTempC) && !isNum(cur.soilMoist)) return null;
    return {
        primary: { label: 'Soil surface temperature', q: 'temp', v: cur.soilTempC },
        rows: [
            { label: 'Soil moisture, 0–1 cm', q: 'volpct', v: cur.soilMoist },
            { label: 'Evapotranspiration today', q: 'precip', v: day?.et0Mm ?? null },
            { label: 'Rain today', q: 'precip', v: day?.precipMm ?? null },
        ],
        status: null,
        spark: { q: 'temp', label: 'Soil temperature', kind: 'line', ...ctx.win('soilTempC') },
        meter: null,
        method: 'Model land-surface scheme (not a probe in the ground); ET₀ FAO-56 Penman–Monteith',
    };
}

const BUILDERS = Object.freeze({ thermo, hygro, baro, anemo, rain, sun, sky, psychro, density, air, hazard, degree, soil });

/**
 * Build every instrument reading for the station at `nowMs`.
 * @param {object} obs     normalizeLabResponse() output
 * @param {object} opts    { nowMs, air? (AirQualityFeed state) }
 * @returns {{ at:number, cur:object, day:object|null, readings: Record<string, object> }}
 */
export function buildReadings(obs, { nowMs, air = null } = {}) {
    if (!obs?.hourly || !isNum(nowMs)) return { at: nowMs, cur: null, day: null, readings: {} };
    const H = obs.hourly;
    const cur = currentConditions(obs, nowMs);
    const day = dayRowAt(obs, nowMs);
    const W = hourlyWindow(obs, nowMs - 24 * HOUR, nowMs + 24 * HOUR) || { t: [] };
    let nowIdx = -1;
    W.t.forEach((t, i) => { if (t <= nowMs) nowIdx = i; });
    const win = (key) => ({ values: W[key] || [], t: W.t, nowIdx });
    const ctx = { obs, H, cur, day, nowMs, win, air };
    const readings = {};
    for (const [id, fn] of Object.entries(BUILDERS)) {
        let r = null;
        try { r = fn(ctx); } catch (e) { r = null; }
        readings[id] = r ? { id, ok: true, ...r }
            : { id, ok: false, missing: id === 'air' ? 'Air-quality feed unavailable' : 'Not in this station’s feed' };
    }
    return { at: nowMs, cur, day, readings };
}

export { cToF, fToC };
