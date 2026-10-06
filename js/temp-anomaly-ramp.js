/**
 * temp-anomaly-ramp.js — the single source of truth for temperature-ANOMALY
 * colour (PLANETARY_TEMPERATURE_LAB_PLAN.md §4.6). PURE, three-free,
 * node-gated by tests/temp-anomaly-ramp.mjs.
 *
 * js/temp-ramp.js colours a TEMPERATURE (pivot 0 °C). This colours a
 * DEPARTURE from the 1991–2020 normal (pivot 0 K) and a RARITY (pivot the
 * 50th percentile) — the lab's map, its legend, the EarthView panel's
 * mini-map and the scorecard chips all read the same 256 bytes, so a cell
 * and its key cannot drift apart (the temp-ramp.js rule).
 *
 * The palette is ColorBrewer RdBu-11 reversed (blue = cold, red = warm),
 * which is the diverging scheme ColorBrewer marks colour-blind safe: the
 * two arms differ in LIGHTNESS as well as hue, so under protan/deutan
 * simulation the cold and warm arms stay apart. The gate checks that with
 * the Machado et al. (2009) severity-1 matrices — never assume it.
 *
 * TWO domains, ONE ramp, eleven knots each. The knots are NOT evenly spaced
 * in kelvin: most of the planet sits within ±3 K on any day, and a linear
 * ±12 K scale would paint it all near-white. The compression is disclosed
 * by the legend, whose ticks come from the same knots through
 * `anomalyToFrac` / `percentileToFrac`. The percentile knots put the
 * climatePosition class boundaries (10 / 33⅓ / 66⅔ / 90) exactly on stops,
 * so a class change is a colour step a reader can see.
 */

/** ColorBrewer RdBu-11, reversed: index 0 = most below, 10 = most above. */
export const ANOMALY_RAMP_STOPS = Object.freeze([
    [0x05, 0x30, 0x61],
    [0x21, 0x66, 0xac],
    [0x43, 0x93, 0xc3],
    [0x92, 0xc5, 0xde],
    [0xd1, 0xe5, 0xf0],
    [0xf7, 0xf7, 0xf7],   // neutral — on the normal
    [0xfd, 0xdb, 0xc7],
    [0xf4, 0xa5, 0x82],
    [0xd6, 0x60, 0x4d],
    [0xb2, 0x18, 0x2b],
    [0x67, 0x00, 0x1f],
]);

/** Anomaly (K) at each stop. Symmetric; denser near 0 (see header). */
export const ANOMALY_KNOTS_K = Object.freeze([-12, -8, -5, -3, -1, 0, 1, 3, 5, 8, 12]);

/** Percentile (0–100) at each stop. 10 / 33⅓ / 66⅔ / 90 are class edges. */
export const PERCENTILE_KNOTS = Object.freeze([0, 1, 2.5, 10, 100 / 3, 50, 200 / 3, 90, 97.5, 99, 100]);

export const ANOMALY_LUT_SIZE = 256;

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Piecewise-linear position of `v` along `knots`, as a 0–1 ramp fraction. */
function knotFrac(knots, v) {
    if (!Number.isFinite(v)) return null;
    const n = knots.length - 1;
    if (v <= knots[0]) return 0;
    if (v >= knots[n]) return 1;
    let s = 0;
    while (s < n - 1 && v > knots[s + 1]) s++;
    return (s + (v - knots[s]) / (knots[s + 1] - knots[s])) / n;
}

/** Ramp fraction for an anomaly in kelvin; null for a gap (never 0.5). */
export const anomalyToFrac = (k) => knotFrac(ANOMALY_KNOTS_K, k);
/** Ramp fraction for a percentile 0–100; null for a gap. */
export const percentileToFrac = (p) => knotFrac(PERCENTILE_KNOTS, p);

/** sRGB colour at a ramp fraction, interpolated between stops. */
export function rampColorAt(frac) {
    const f = clamp01(frac) * (ANOMALY_RAMP_STOPS.length - 1);
    const s = Math.min(ANOMALY_RAMP_STOPS.length - 2, Math.floor(f));
    const t = f - s;
    const a = ANOMALY_RAMP_STOPS[s], b = ANOMALY_RAMP_STOPS[s + 1];
    return [0, 1, 2].map(c => Math.round(a[c] + (b[c] - a[c]) * t));
}

/**
 * The 256×1 RGBA LUT every consumer paints from (canvas legend, map cells,
 * a future shader DataTexture). Deterministic from ANOMALY_RAMP_STOPS.
 * @returns {Uint8Array}
 */
export function buildAnomalyLUTPixels() {
    const data = new Uint8Array(ANOMALY_LUT_SIZE * 4);
    for (let i = 0; i < ANOMALY_LUT_SIZE; i++) {
        const [r, g, b] = rampColorAt(i / (ANOMALY_LUT_SIZE - 1));
        data.set([r, g, b, 255], i * 4);
    }
    return data;
}

/** CSS colour for an anomaly (K); `fallback` for a gap. */
export function anomalyCss(k, fallback = 'transparent') {
    const f = anomalyToFrac(k);
    if (f === null) return fallback;
    const [r, g, b] = rampColorAt(f);
    return `rgb(${r},${g},${b})`;
}

/** CSS colour for a percentile; `fallback` for a gap. */
export function percentileCss(p, fallback = 'transparent') {
    const f = percentileToFrac(p);
    if (f === null) return fallback;
    const [r, g, b] = rampColorAt(f);
    return `rgb(${r},${g},${b})`;
}

/** Ink (#000 / #fff) that stays readable over a ramp colour — WCAG luminance. */
export function inkOn([r, g, b]) {
    const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    // contrast vs white (1.05/(L+.05)) beats contrast vs black ((L+.05)/.05) below L ≈ 0.179
    return L > 0.179 ? '#000' : '#fff';
}
