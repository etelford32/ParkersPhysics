/**
 * climate-lab/lab-physics.js — the Climate Lab's derived-quantity kernel.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE: no DOM, no fetch, no ambient time. Every instrument tile on the
 * dashboard's Climate Lab prints numbers that come from here or from the
 * modules this file imports — the renderers draw, they never compute.
 *
 * ONE COPY OF EACH FORMULA. Dew point, saturation vapour pressure, VPD,
 * heat index, wind chill, the Fosberg/HDW fire indices and the frost
 * classifier ALREADY live in js/composite-indices.js (earth.html's hover
 * readout uses them) and are imported below, never re-derived. The UV/AQI
 * chip states and moon phase live in js/verdict-engine.js; the EPA AQI
 * table in js/aqi-scale.js. What this file adds is only what no other
 * module had (grep'd 2026-09-24): wet-bulb, humidity ratios, moist-air
 * density + density altitude, the convective cloud-base estimate, the
 * barometric tendency class, Beaufort force, WHO UV categories, wind
 * veering/backing, degree days, a climatological percentile, and the
 * gap-aware sparkline geometry the tiles draw.
 *
 * UNITS: every input and output is SI-flavoured — °C, %, hPa, m/s, mm, m —
 * and unit conversion for DISPLAY happens once, in lab-units.js. Keeping the
 * kernel in one unit system is what stops a °F reading from being fed into a
 * °C formula (the classic silent failure: a plausible-looking wrong number).
 *
 * VALIDITY IS REPORTED, NOT HIDDEN. Empirical fits (Stull's wet-bulb, the
 * Espy cloud-base rule) carry the range they were fitted on; functions that
 * leave it say so in their return value instead of extrapolating quietly.
 */

import {
    dewPointC, satVaporHpa, vpdHpa, heatIndexF, windChillF, cToF, fToC,
} from '../composite-indices.js';

export { dewPointC, satVaporHpa, vpdHpa };

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── Physical constants ─────────────────────────────────────────────────────
/** Specific gas constant of dry air, J/(kg·K). */
export const R_DRY = 287.058;
/** Specific gas constant of water vapour, J/(kg·K). */
export const R_VAPOR = 461.495;
/** ISA sea-level temperature (K), lapse rate (K/m), density (kg/m³). */
export const ISA = Object.freeze({ T0: 288.15, L: 0.0065, RHO0: 1.225, P0: 1013.25 });
/** g·M/(R·L) for the ISA troposphere — the barometric exponent. */
const ISA_EXP = 5.25588;
const KELVIN = 273.15;

// ── Temperature-humidity ───────────────────────────────────────────────────

/**
 * Apparent ("feels like") temperature, °C, via the NWS operational pair:
 * heat index above ~80 °F, 2001 wind chill at or below 50 °F with wind,
 * otherwise the air temperature itself. Delegates to composite-indices.js so
 * the dashboard and EarthView's hover readout can never disagree.
 * Returns { valueC, method: 'heat-index'|'wind-chill'|'air' }.
 */
export function apparentTempC(tempC, rhPct, windMs) {
    if (!isNum(tempC)) return { valueC: NaN, method: 'air' };
    const tF = cToF(tempC);
    if (isNum(rhPct) && tF >= 80) {
        const hi = heatIndexF(tF, rhPct);
        if (isNum(hi) && hi > tF) return { valueC: fToC(hi), method: 'heat-index' };
    }
    if (isNum(windMs) && tF <= 50) {
        const mph = windMs * 2.23694;
        if (mph > 3) {
            const wc = windChillF(tF, mph);
            if (isNum(wc) && wc < tF) return { valueC: fToC(wc), method: 'wind-chill' };
        }
    }
    return { valueC: tempC, method: 'air' };
}

/**
 * Wet-bulb temperature, °C — Stull (2011, J. Appl. Meteor. Climatol. 50,
 * 2267) closed-form fit at standard sea-level pressure. Stull quotes it for
 * RH 5–99 % and T −20…50 °C with a mean absolute error of ~0.3 °C; outside
 * that box the fit is not defined, so `valid` goes false and callers should
 * disclose rather than print a confident number.
 * @returns {{ valueC:number, valid:boolean }}
 */
export function wetBulbStullC(tempC, rhPct) {
    if (!isNum(tempC) || !isNum(rhPct)) return { valueC: NaN, valid: false };
    const T = tempC, RH = clamp(rhPct, 0, 100);
    const tw = T * Math.atan(0.151977 * Math.sqrt(RH + 8.313659))
             + Math.atan(T + RH)
             - Math.atan(RH - 1.676331)
             + 0.00391838 * Math.pow(RH, 1.5) * Math.atan(0.023101 * RH)
             - 4.686035;
    const valid = RH >= 5 && RH <= 99 && T >= -20 && T <= 50;
    // A wet bulb can never read above the dry bulb; the fit can overshoot by
    // a hair at RH→100, so pin it rather than print a physical impossibility.
    return { valueC: Math.min(tw, T), valid };
}

/** Actual vapour pressure e (hPa) from T and RH, on the same Tetens curve. */
export function vaporPressureHpa(tempC, rhPct) {
    if (!isNum(tempC) || !isNum(rhPct)) return NaN;
    return satVaporHpa(tempC) * clamp(rhPct, 0, 100) / 100;
}

/**
 * Mixing ratio w (g of vapour per kg of dry air). Needs STATION pressure —
 * the pressure the air parcel is actually at — not the sea-level-reduced
 * value a barometer app prints.
 */
export function mixingRatioGkg(tempC, rhPct, stationHpa) {
    const e = vaporPressureHpa(tempC, rhPct);
    if (!isNum(e) || !isNum(stationHpa) || stationHpa <= e) return NaN;
    return 621.97 * e / (stationHpa - e);
}

/** Absolute humidity ρ_v (g of water vapour per m³ of air). */
export function absoluteHumidityGm3(tempC, rhPct) {
    const e = vaporPressureHpa(tempC, rhPct);
    if (!isNum(e)) return NaN;
    return (e * 100) / (R_VAPOR * (tempC + KELVIN)) * 1000;
}

/**
 * Moist-air density (kg/m³) as the sum of the dry and vapour partial
 * densities: ρ = p_d/(R_d·T) + e/(R_v·T). Humid air is LESS dense than dry
 * air at the same T and p (water, 18 g/mol, displaces N₂/O₂ at ~29) — the
 * counter-intuitive fact the density-altitude readout exists to show.
 * `stationHpa` must be station pressure (see mixingRatioGkg).
 */
export function airDensityKgM3(tempC, rhPct, stationHpa) {
    if (!isNum(tempC) || !isNum(stationHpa)) return NaN;
    const e = isNum(rhPct) ? vaporPressureHpa(tempC, rhPct) : 0;
    const T = tempC + KELVIN;
    const pd = (stationHpa - e) * 100;
    return pd / (R_DRY * T) + (e * 100) / (R_VAPOR * T);
}

/**
 * Density altitude (m): the ISA altitude whose standard density equals the
 * air's actual density. Inverts the ISA troposphere ρ/ρ₀ = (1 − L·h/T₀)^(n−1),
 * n = g·M/(R·L) = 5.25588. This is what an aircraft wing, a drone rotor or a
 * rocket's sea-level-rated engine actually "feels".
 */
export function densityAltitudeM(densityKgM3) {
    if (!isNum(densityKgM3) || densityKgM3 <= 0) return NaN;
    return (ISA.T0 / ISA.L) * (1 - Math.pow(densityKgM3 / ISA.RHO0, 1 / (ISA_EXP - 1)));
}

/**
 * Station pressure (hPa) reduced from mean-sea-level pressure and elevation
 * using the ISA barometric relation. Used ONLY when the feed does not carry
 * a surface-pressure channel; the caller must disclose that it is a standard-
 * atmosphere reduction (it ignores the actual column temperature).
 */
export function stationPressureFromMslHpa(mslHpa, elevationM) {
    if (!isNum(mslHpa) || !isNum(elevationM)) return NaN;
    return mslHpa * Math.pow(1 - ISA.L * elevationM / ISA.T0, ISA_EXP);
}

/**
 * Convective cloud-base estimate (m above ground) from the dew-point
 * depression: z ≈ 125 m × (T − T_d) (Espy's rule; Lawrence 2005, BAMS 86,
 * 225 gives 125 m/°C). It is the lifting condensation level of a surface
 * parcel — the base of CUMULUS if convection happens — not a ceilometer
 * reading of whatever stratus deck is overhead. `kind` says so.
 */
export function cloudBaseLclM(tempC, dewC) {
    if (!isNum(tempC) || !isNum(dewC)) return { valueM: NaN, kind: 'lcl' };
    return { valueM: Math.max(0, 125 * (tempC - dewC)), kind: 'lcl' };
}

// ── Classifiers ─────────────────────────────────────────────────────────────

/**
 * Barometric tendency over a 3-hour window, classed with the UK Met Office
 * shipping-forecast terms (the only published, numeric set in common use):
 *   steady  < 0.1 hPa · slowly 0.1–1.5 · (plain) 1.6–3.5 ·
 *   quickly 3.6–6.0 · very rapidly > 6.0 hPa per 3 h.
 * @param {number} deltaHpa  p(now) − p(now − 3 h)
 */
export function pressureTendency(deltaHpa) {
    if (!isNum(deltaHpa)) return null;
    const a = Math.abs(deltaHpa);
    const trend = a < 0.1 ? 'steady' : deltaHpa > 0 ? 'rising' : 'falling';
    const rate = a < 0.1 ? '' : a <= 1.5 ? 'slowly' : a <= 3.5 ? '' : a <= 6.0 ? 'quickly' : 'very rapidly';
    const label = trend === 'steady' ? 'Steady'
        : `${trend[0].toUpperCase()}${trend.slice(1)}${rate ? ' ' + rate : ''}`;
    return { deltaHpa, trend, rate, label };
}

/**
 * The 3-hour tendency from an hourly series. `times` are epoch ms, `values`
 * hPa (nulls allowed — a gap is not a zero). Finds the sample nearest `atMs`
 * and the one nearest 3 h earlier; returns null if either is missing or more
 * than 45 min from where it should be.
 */
export function tendencyFromSeries(times, values, atMs) {
    if (!Array.isArray(times) || !Array.isArray(values) || !isNum(atMs)) return null;
    const pick = (target) => {
        let best = -1, bestDt = Infinity;
        for (let i = 0; i < times.length; i++) {
            if (!isNum(values[i]) || !isNum(times[i])) continue;
            const dt = Math.abs(times[i] - target);
            if (dt < bestDt) { bestDt = dt; best = i; }
        }
        return bestDt <= 45 * 60_000 ? best : -1;
    };
    const i1 = pick(atMs), i0 = pick(atMs - 3 * 3_600_000);
    if (i1 < 0 || i0 < 0 || i0 === i1) return null;
    return pressureTendency(values[i1] - values[i0]);
}

const BEAUFORT = Object.freeze([
    // [upper bound m/s (exclusive), force, name] — WMO 10 m wind.
    [0.5, 0, 'Calm'], [1.6, 1, 'Light air'], [3.4, 2, 'Light breeze'],
    [5.5, 3, 'Gentle breeze'], [8.0, 4, 'Moderate breeze'], [10.8, 5, 'Fresh breeze'],
    [13.9, 6, 'Strong breeze'], [17.2, 7, 'Near gale'], [20.8, 8, 'Gale'],
    [24.5, 9, 'Strong gale'], [28.5, 10, 'Storm'], [32.7, 11, 'Violent storm'],
    [Infinity, 12, 'Hurricane force'],
]);

/** Beaufort force from 10 m wind speed (m/s). */
export function beaufort(windMs) {
    if (!isNum(windMs) || windMs < 0) return null;
    for (const [hi, force, name] of BEAUFORT) {
        if (windMs < hi) return { force, name };
    }
    return null;
}

/** WHO / WMO UV-index exposure categories (Global Solar UV Index, 2002). */
export function uvCategory(uvi) {
    if (!isNum(uvi) || uvi < 0) return null;
    const u = Math.round(uvi * 10) / 10;
    if (u < 3)  return { id: 'low',       label: 'Low',       level: 0 };
    if (u < 6)  return { id: 'moderate',  label: 'Moderate',  level: 1 };
    if (u < 8)  return { id: 'high',      label: 'High',      level: 2 };
    if (u < 11) return { id: 'very-high', label: 'Very high', level: 3 };
    return { id: 'extreme', label: 'Extreme', level: 4 };
}

/**
 * Dew-point comfort, on the °F bands US forecasters use in public copy
 * (≤ 50 dry · 50–55 comfortable · 55–60 humid · 60–65 sticky · 65–70 muggy ·
 * 70–75 oppressive · ≥ 75 miserable). Converted here, never re-banded in °C,
 * so a metric reader sees the same boundary a US forecaster would.
 */
export function dewPointComfort(dewC) {
    if (!isNum(dewC)) return null;
    const f = cToF(dewC);
    if (f < 50) return { id: 'dry',        label: 'Dry',        level: 0 };
    if (f < 55) return { id: 'comfortable', label: 'Comfortable', level: 0 };
    if (f < 60) return { id: 'humid',      label: 'Humid',      level: 1 };
    if (f < 65) return { id: 'sticky',     label: 'Sticky',     level: 2 };
    if (f < 70) return { id: 'muggy',      label: 'Muggy',      level: 3 };
    if (f < 75) return { id: 'oppressive', label: 'Oppressive', level: 4 };
    return { id: 'miserable', label: 'Miserable', level: 5 };
}

/**
 * Horizontal visibility class. WMO defines FOG as visibility < 1 km; between
 * 1 and 5 km the obscuration is MIST when the air is near saturation and
 * HAZE when it is dry (dust/smoke/aerosol) — so RH decides the word.
 */
export function visibilityClass(visM, rhPct) {
    if (!isNum(visM) || visM < 0) return null;
    if (visM < 1000) return { id: 'fog', label: 'Fog', level: 3 };
    if (visM < 5000) {
        const wet = isNum(rhPct) && rhPct >= 80;
        return wet ? { id: 'mist', label: 'Mist', level: 2 } : { id: 'haze', label: 'Haze', level: 2 };
    }
    if (visM < 10000) return { id: 'moderate', label: 'Moderate', level: 1 };
    return { id: 'good', label: visM >= 20000 ? 'Excellent' : 'Good', level: 0 };
}

/**
 * Net wind-direction change across a forecast window. Successive
 * differences are wrapped to (−180°, 180°] and SUMMED (a plain last−first
 * difference misreads 350°→10° as a 340° swing). Positive = clockwise =
 * VEERING; negative = BACKING. A shift under 20° is reported as steady —
 * forecast directions wobble by that much in light, variable wind.
 */
export function windShift(dirsDeg) {
    const d = (dirsDeg || []).filter(isNum);
    if (d.length < 2) return null;
    let net = 0;
    for (let i = 1; i < d.length; i++) {
        let step = ((d[i] - d[i - 1]) % 360 + 540) % 360 - 180;
        if (step === -180) step = 180;
        net += step;
    }
    const kind = Math.abs(net) < 20 ? 'steady' : net > 0 ? 'veering' : 'backing';
    return { netDeg: net, kind };
}

/**
 * Degree days by the mean-temperature method: max(0, (Tmax+Tmin)/2 − base).
 * Growing degree days use a 10 °C base (the common corn/generic crop base);
 * heating/cooling degree days use 65 °F = 18.333 °C, the US energy-sector
 * convention. Returned in °C·day — lab-units converts to °F·day (× 9/5).
 */
export function degreeDays(highC, lowC) {
    if (!isNum(highC) || !isNum(lowC)) return null;
    const mean = (highC + lowC) / 2;
    const base = fToC(65);
    return {
        meanC: mean,
        gdd: Math.max(0, mean - 10),
        hdd: Math.max(0, base - mean),
        cdd: Math.max(0, mean - base),
    };
}

/**
 * Where a value sits in a climatological sample (e.g. this calendar day's
 * high in each of the last N years). Percentile uses MID-RANK for ties
 * (so a value equal to the whole sample reads 50th, not 0th or 100th), and
 * the tercile/decile words follow NOAA CPC's outlook language. A sample
 * smaller than `minN` returns null — a percentile of four numbers is noise
 * dressed as a statistic, and the tile says "not enough history" instead.
 */
export function climatePosition(value, samples, { minN = 8 } = {}) {
    const xs = (samples || []).filter(isNum).sort((a, b) => a - b);
    if (!isNum(value) || xs.length < minN) return null;
    const n = xs.length;
    const mean = xs.reduce((s, x) => s + x, 0) / n;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
    let below = 0, equal = 0;
    for (const x of xs) { if (x < value) below++; else if (x === value) equal++; }
    const percentile = 100 * (below + 0.5 * equal) / n;
    const cls = percentile < 10 ? 'much-below'
        : percentile < 100 / 3 ? 'below'
        : percentile <= 200 / 3 ? 'near'
        : percentile <= 90 ? 'above' : 'much-above';
    return {
        n, mean, sd, anomaly: value - mean,
        z: sd > 0 ? (value - mean) / sd : 0,
        percentile, cls,
        beyondRecord: value > xs[n - 1] ? 'high' : value < xs[0] ? 'low' : null,
        min: xs[0], max: xs[n - 1],
    };
}

// ── Sparkline geometry ─────────────────────────────────────────────────────

/**
 * Map a series onto a w×h box. Returns one {x, y, v, i} per sample, or null
 * where the sample is missing — a GAP IS NOT A ZERO (the pollution lab's
 * scar: `Number(null)` is 0 and finite). `domain` lets several tiles share
 * one scale; otherwise the series' own min/max with a small pad is used and
 * a flat series is centred instead of dividing by zero.
 */
export function sparkPoints(values, { w = 120, h = 32, pad = 3, domain = null } = {}) {
    const vs = Array.isArray(values) ? values : [];
    const finite = vs.filter(isNum);
    if (!finite.length) return { points: vs.map(() => null), min: NaN, max: NaN };
    let lo = domain ? domain[0] : Math.min(...finite);
    let hi = domain ? domain[1] : Math.max(...finite);
    if (!(hi > lo)) { lo -= 1; hi += 1; }
    const n = vs.length;
    const xOf = (i) => n === 1 ? w / 2 : pad + (i / (n - 1)) * (w - 2 * pad);
    const yOf = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
    return {
        points: vs.map((v, i) => isNum(v) ? { x: xOf(i), y: yOf(v), v, i } : null),
        min: lo, max: hi,
    };
}

/** SVG path `d` for sparkPoints output, breaking the line at every gap. */
export function sparkPath(points) {
    let d = '', pen = false;
    for (const p of points || []) {
        if (!p) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        pen = true;
    }
    return d;
}
