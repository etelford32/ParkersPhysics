/**
 * climate-lab/lab-units.js — display units for the Climate Lab.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. The lab kernel (lab-physics.js) works in one unit system (°C, hPa,
 * m/s, mm, m); THIS is the only place a value changes units, and it only
 * happens on the way to the screen. Nothing downstream of `fmt` is ever fed
 * back into a formula.
 *
 * TWO KINDS OF TEMPERATURE. An absolute temperature converts with an offset
 * (°F = °C·9/5 + 32); a temperature DIFFERENCE — an anomaly, a dew-point
 * depression, a degree-day — converts with the scale factor alone. Pushing an
 * anomaly of +3 °C through the absolute formula prints "+37 °F", which is the
 * bug this split exists to prevent; `tempDelta` is its own quantity.
 *
 * Presets are the common reader expectations; `custom` lets a user mix them
 * (the aviation habit of °C with knots and feet is the canonical example).
 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Every convertible quantity: the SI unit the kernel speaks, and per display
 * unit the forward conversion, symbol and default decimals.
 */
export const QUANTITIES = Object.freeze({
    temp: {
        label: 'Temperature',
        units: {
            C: { sym: '°C', dp: 1, to: (c) => c },
            F: { sym: '°F', dp: 0, to: (c) => c * 9 / 5 + 32 },
        },
    },
    tempDelta: {
        label: 'Temperature difference',
        units: {
            C: { sym: '°C', dp: 1, to: (d) => d },
            F: { sym: '°F', dp: 1, to: (d) => d * 9 / 5 },
        },
    },
    // Degree days are temperature DIFFERENCES integrated over a day: scale
    // factor only, never the +32 offset.
    dd: {
        label: 'Degree days',
        units: {
            C: { sym: '°C·d', dp: 1, to: (d) => d },
            F: { sym: '°F·d', dp: 1, to: (d) => d * 9 / 5 },
        },
    },
    wind: {
        label: 'Wind speed',
        units: {
            ms:  { sym: 'm/s',  dp: 1, to: (v) => v },
            kmh: { sym: 'km/h', dp: 0, to: (v) => v * 3.6 },
            mph: { sym: 'mph',  dp: 0, to: (v) => v * 2.236936 },
            kn:  { sym: 'kn',   dp: 0, to: (v) => v * 1.943844 },
        },
    },
    pressure: {
        label: 'Pressure',
        units: {
            hPa:  { sym: 'hPa',  dp: 1, to: (p) => p },
            inHg: { sym: 'inHg', dp: 2, to: (p) => p * 0.02952998 },
            mmHg: { sym: 'mmHg', dp: 0, to: (p) => p * 0.7500617 },
            kPa:  { sym: 'kPa',  dp: 2, to: (p) => p / 10 },
        },
    },
    precip: {
        label: 'Precipitation',
        units: {
            mm: { sym: 'mm', dp: 1, to: (mm) => mm },
            in: { sym: 'in', dp: 2, to: (mm) => mm / 25.4 },
        },
    },
    distance: {
        label: 'Visibility',
        units: {
            km: { sym: 'km', dp: 1, to: (m) => m / 1000 },
            mi: { sym: 'mi', dp: 1, to: (m) => m / 1609.344 },
        },
    },
    height: {
        label: 'Height',
        units: {
            m:  { sym: 'm',  dp: 0, to: (m) => m },
            ft: { sym: 'ft', dp: 0, to: (m) => m / 0.3048 },
        },
    },
    // ── Single-unit quantities: the same number for every reader. VPD is
    //    quoted in kPa because that is the horticultural convention it is
    //    read against, whatever the pressure preference.
    pct:    { label: 'Percent',            units: { pct:  { sym: '%',     dp: 0, to: (v) => v } } },
    index:  { label: 'Index',              units: { idx:  { sym: '',      dp: 0, to: (v) => v } } },
    uvi:    { label: 'UV index',           units: { uvi:  { sym: '',      dp: 1, to: (v) => v } } },
    gm3:    { label: 'Absolute humidity',  units: { gm3:  { sym: 'g/m³',  dp: 1, to: (v) => v } } },
    gkg:    { label: 'Mixing ratio',       units: { gkg:  { sym: 'g/kg',  dp: 1, to: (v) => v } } },
    kgm3:   { label: 'Density',            units: { kgm3: { sym: 'kg/m³', dp: 3, to: (v) => v } } },
    wm2:    { label: 'Irradiance',         units: { wm2:  { sym: 'W/m²',  dp: 0, to: (v) => v } } },
    vpd:    { label: 'Vapour-pressure deficit', units: { kPa: { sym: 'kPa', dp: 2, to: (hPa) => hPa / 10 } } },
    hours:  { label: 'Duration',           units: { h:    { sym: 'h',     dp: 1, to: (s) => s / 3600 } } },
    deg:    { label: 'Angle',              units: { deg:  { sym: '°',     dp: 0, to: (v) => v } } },
    volpct: { label: 'Soil moisture',      units: { vol:  { sym: '% vol', dp: 0, to: (f) => f * 100 } } },
    ugm3:   { label: 'Concentration',      units: { ugm3: { sym: 'µg/m³', dp: 0, to: (v) => v } } },
});

/** Named unit systems. `auto` resolves per locale in `resolveUnits`. */
export const PRESETS = Object.freeze({
    metric:   { label: 'Metric',     temp: 'C', wind: 'kmh', pressure: 'hPa',  precip: 'mm', distance: 'km', height: 'm' },
    imperial: { label: 'Imperial',   temp: 'F', wind: 'mph', pressure: 'inHg', precip: 'in', distance: 'mi', height: 'ft' },
    si:       { label: 'Scientific', temp: 'C', wind: 'ms',  pressure: 'hPa',  precip: 'mm', distance: 'km', height: 'm' },
    aviation: { label: 'Aviation',   temp: 'C', wind: 'kn',  pressure: 'hPa',  precip: 'mm', distance: 'km', height: 'ft' },
});

/** Regions whose public weather copy is in US customary units. */
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM', 'PR', 'GU', 'AS', 'VI', 'MP', 'UM']);

/** Best-effort locale → preset id. Pure given its input (tests pass one). */
export function localePreset(locale) {
    const tag = String(locale || '');
    const m = tag.match(/[-_]([A-Za-z]{2})\b/);
    const region = m ? m[1].toUpperCase() : (tag.toLowerCase() === 'en' ? 'US' : '');
    return IMPERIAL_REGIONS.has(region) ? 'imperial' : 'metric';
}

/**
 * Resolve a stored unit preference into a concrete per-quantity map.
 * @param {{preset?:string, overrides?:object}} pref
 * @param {string} [locale]  navigator.language, for the `auto` preset
 * @returns {{temp,wind,pressure,precip,distance,height, tempDelta, preset}}
 */
export function resolveUnits(pref, locale) {
    const presetId = pref?.preset && pref.preset !== 'auto' && PRESETS[pref.preset]
        ? pref.preset
        : (pref?.preset === 'custom' ? 'custom' : localePreset(locale));
    const base = PRESETS[presetId === 'custom' ? localePreset(locale) : presetId] || PRESETS.metric;
    const out = { preset: presetId };
    for (const q of ['temp', 'wind', 'pressure', 'precip', 'distance', 'height']) {
        const o = presetId === 'custom' ? pref?.overrides?.[q] : null;
        out[q] = (o && QUANTITIES[q].units[o]) ? o : base[q];
    }
    out.tempDelta = out.temp;   // a difference always follows its absolute scale
    out.dd = out.temp;
    return out;
}

/**
 * Convert an SI value for display.
 * @returns {{ value:number, text:string, sym:string }}  text is '—' when missing
 */
export function fmt(quantity, valueSI, units, { dp = null, signed = false } = {}) {
    const q = QUANTITIES[quantity];
    const u = q?.units[units?.[quantity]] || (q && Object.values(q.units)[0]);
    if (!u || !isNum(valueSI)) return { value: NaN, text: '—', sym: u?.sym ?? '' };
    const v = u.to(valueSI);
    const d = dp ?? u.dp;
    let text = v.toFixed(d);
    if (text === '-0' || /^-0\.0+$/.test(text)) text = text.slice(1);   // no "−0.0"
    if (signed && v > 0 && Number(text) !== 0) text = '+' + text;
    return { value: v, text: text.replace('-', '−'), sym: u.sym };
}

/** "12.3 °C" convenience wrapper; a thin space separates value and unit. */
export function fmtText(quantity, valueSI, units, opts) {
    const r = fmt(quantity, valueSI, units, opts);
    return r.text === '—' ? '—' : `${r.text} ${r.sym}`;
}


/**
 * Inverse of the display conversion: a number typed in the reader's unit →
 * the kernel's SI value. Every conversion in QUANTITIES is affine
 * (y = a·x + b), so the inverse is exact: x = (y − b) / a.
 */
export function fromDisplay(quantity, displayValue, units) {
    const q = QUANTITIES[quantity];
    const u = q?.units[units?.[quantity]] || (q && Object.values(q.units)[0]);
    if (!u || !isNum(displayValue)) return NaN;
    const b = u.to(0), a = u.to(1) - b;
    return a === 0 ? NaN : (displayValue - b) / a;
}
