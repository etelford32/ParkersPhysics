/**
 * wind-palette.js — the ONE copy of how EarthView colours wind
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURE + THREE-free + DOM-free on purpose, so `node tests/wind-palette.mjs`
 * can pin the ramp without a GL context. Every consumer on earth.html —
 * the surface trails, the three pressure-level trail instances, the arrow
 * field, the vertical profile columns and the wx-panel legend canvases —
 * reads THIS function. Until 2026-10-27 the page carried FIVE private
 * copies of a speed ramp (the trails, an inline mirror in the arrows, an
 * inline mirror in the legend painter, and one closure per pressure level),
 * each a different hue family (blue→white→magenta at the surface, sage→amber
 * at 850 hPa, violet→cyan at 500, crimson→gold at 250): four hues for one
 * quantity, and a change to any of them silently desynchronised the key
 * from the globe.
 *
 * THE RULE (owner request, 2026-10-27)
 * ────────────────────────────────────
 * Wind is BLUE. Two things vary inside that one hue:
 *
 *   • SPEED    → BRIGHTNESS. Faster is lighter. Lightness is monotonic in
 *                speed at every altitude (the dataviz sequential rule: one
 *                hue, light↔dark, never a second hue at the fast end).
 *   • ALTITUDE → SHADE.      Lower is deeper. The 10 m layer is the darkest
 *                navy; the 250 hPa jet is the palest ice-blue. The shade
 *                is a continuous function of REAL altitude (the same table
 *                `js/atmo-scale.js` draws the shells from), so a level
 *                added later gets its shade from the rule, not from a
 *                hand-picked colour.
 *
 * Both axes lift lightness, so a fast surface wind and a slow jet can land
 * near the same lightness. That is accepted on purpose: the levels are
 * separated in GEOMETRY (the exaggeration ramp fans them apart and the
 * profile columns tie them together), speed is carried REDUNDANTLY by arrow
 * length and trail length (the CVD rule wind-column.js already states), and
 * the hue drifts slightly with altitude — indigo-leaning at the ground,
 * cyan-leaning aloft — so the two never coincide exactly. What is NOT
 * acceptable is a second hue family per level: that is what the page had,
 * and it read as four unrelated layers rather than one wind field at four
 * heights.
 *
 * THE NUMBERS
 * ───────────
 * Each end of the altitude axis (surface, jet) is a three-stop ramp over
 * normalised speed s ∈ [0, 1] (s = 0.5 is the legend's middle tick), and
 * the altitude mixes the two stop sets with `altitudeShade(altKm)` — a √
 * law, so the 1.5 km step from the ground to 850 hPa is a visible shade
 * step (0.38 of the way to the jet) rather than a 14 % nudge a viewer
 * cannot see. The √ is a DISPLAY choice and is disclosed in the legend.
 *
 * Values are sRGB 0‥1, written straight into vertex colours exactly as the
 * ramps they replaced were — the trails blend additively, so a deep slow
 * colour is also a DIM one, which is the right reading (a calm reads as
 * calm). `tests/wind-palette.mjs` pins: lightness monotonic in s at every
 * altitude; lightness monotonic in altitude at every s; hue inside the blue
 * band at every sample; the closure form bit-identical to the direct call.
 */

import { LEVEL_ALTITUDE_KM } from './atmo-scale.js';

/** Altitude at which the shade reaches its palest (the jet core). */
export const ALT_TOP_KM = LEVEL_ALTITUDE_KM[250];

// Three-stop ramps (slow / mid / fast) at the two ends of the altitude axis.
// sRGB 0‥1. Chosen so every adjacent pair rises in luminance and every
// stop's hue sits in 200°–245° (HSL) — see the test.
export const SURFACE_STOPS = Object.freeze([
    Object.freeze([0.07, 0.20, 0.60]),   // slow  — deep navy
    Object.freeze([0.15, 0.46, 0.92]),   // mid   — true blue
    Object.freeze([0.62, 0.86, 1.00]),   // fast  — bright sky
]);
export const TOP_STOPS = Object.freeze([
    Object.freeze([0.26, 0.54, 0.86]),   // slow  — mid azure
    Object.freeze([0.52, 0.84, 1.00]),   // mid   — pale cerulean
    Object.freeze([0.90, 0.97, 1.00]),   // fast  — ice
]);

/**
 * Altitude → 0‥1 shade position (0 = darkest, at the ground; 1 = palest,
 * at ALT_TOP_KM and above). Square-root law — see the header.
 */
export function altitudeShade(altKm) {
    const a = Number.isFinite(altKm) ? altKm : 0;
    const f = Math.max(0, Math.min(1, a / ALT_TOP_KM));
    return Math.sqrt(f);
}

/**
 * Colour for normalised speed `s01` (0‥1, the level's own MAX_WIND ceiling)
 * at real altitude `altKm`. Writes [r, g, b] (sRGB 0‥1) into `out` and
 * returns it. Piecewise linear across the three stops; the altitude mix is
 * applied to the stops first, so the ramp at any altitude is itself a
 * three-stop ramp.
 */
export function windColor(s01, altKm, out = [0, 0, 0]) {
    const s = Math.max(0, Math.min(1, Number.isFinite(s01) ? s01 : 0));
    const k = altitudeShade(altKm);
    // Which stop pair the speed falls in, and the blend inside it.
    let i, t;
    if (s < 0.5) { i = 0; t = s / 0.5; }
    else         { i = 1; t = (s - 0.5) / 0.5; }
    const a0 = SURFACE_STOPS[i], a1 = SURFACE_STOPS[i + 1];
    const b0 = TOP_STOPS[i],     b1 = TOP_STOPS[i + 1];
    for (let c = 0; c < 3; c++) {
        const lo = a0[c] + (b0[c] - a0[c]) * k;
        const hi = a1[c] + (b1[c] - a1[c]) * k;
        out[c] = lo + (hi - lo) * t;
    }
    return out;
}

/**
 * A (s01, out) ramp closure for one altitude — the `speedColor` option
 * shape WindParticles takes. Identical output to windColor(s, altKm, out);
 * the closure exists so the hot per-vertex loops carry no altitude lookup.
 */
export function makeWindRamp(altKm) {
    const k = altitudeShade(altKm);
    // Pre-mix the stops once.
    const stops = [0, 1, 2].map(i => [0, 1, 2].map(c =>
        SURFACE_STOPS[i][c] + (TOP_STOPS[i][c] - SURFACE_STOPS[i][c]) * k));
    return (s01, out = [0, 0, 0]) => {
        const s = Math.max(0, Math.min(1, Number.isFinite(s01) ? s01 : 0));
        let i, t;
        if (s < 0.5) { i = 0; t = s / 0.5; }
        else         { i = 1; t = (s - 0.5) / 0.5; }
        const lo = stops[i], hi = stops[i + 1];
        out[0] = lo[0] + (hi[0] - lo[0]) * t;
        out[1] = lo[1] + (hi[1] - lo[1]) * t;
        out[2] = lo[2] + (hi[2] - lo[2]) * t;
        return out;
    };
}

/** `rgb(r, g, b)` CSS string for a ramp sample — the legend painters' helper. */
export function windColorCss(s01, altKm) {
    const c = windColor(s01, altKm);
    return `rgb(${(c[0] * 255) | 0}, ${(c[1] * 255) | 0}, ${(c[2] * 255) | 0})`;
}

/**
 * The legend's disclosure line. One sentence, shown under the wind key,
 * because a colour rule that is not written down beside the key is a
 * guess the reader has to make.
 */
export const WIND_PALETTE_NOTE =
    'Blue = wind. Brighter = faster. Deeper shade = lower altitude ' +
    '(10 m darkest → 250 hPa palest; shade follows √altitude).';

// ── Pure helpers the test uses (exported so the gate measures the SAME
//    quantities a reader would, not a re-derivation) ─────────────────────

/** WCAG relative luminance of an sRGB 0‥1 triple. */
export function relativeLuminance([r, g, b]) {
    const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** HSL hue in degrees (0‥360) of an sRGB 0‥1 triple; NaN for greys. */
export function hueDeg([r, g, b]) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    if (d < 1e-9) return NaN;
    let h;
    if (max === r)      h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else                h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    return h;
}
