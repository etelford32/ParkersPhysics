/**
 * heat-scale.js — which colour of the ONE temperature ramp a value is drawn in. PURE.
 *
 * WHY THIS EXISTS (2026-11-09, first look at the map on a REAL GFS run): the
 * ramp (js/temp-ramp.js) spans −60…+50 °C because EarthView paints the whole
 * planet with it. A Climalytix window is ±4° of latitude: on the first real
 * run the whole view was 38–73 °F, i.e. one sixth of the ramp, pale yellow to
 * amber — and drawn at 62 % over the ground it was an olive-brown wash, not a
 * heat map. Nothing was wrong with the data; the display could not show it.
 *
 * TWO SCALES, ONE RAMP, and the key always shows which:
 *   'absolute'  a value is drawn in its own ramp colour — the SAME bytes as
 *               EarthView (scaleColor ≡ map-view heatColor, gated), so a map
 *               can be compared with the globe or with another site.
 *   'fit'       the range of THIS RUN over THIS WINDOW (every lead, so the
 *               colours do not shift while the timeline is scrubbed) is
 *               stretched along the ramp. It is the same ramp read through a
 *               monotonic map `rampC(t)`, with three guarantees (gated):
 *                 · order is kept — warmer is always further along the ramp
 *                 · the SIDE of freezing is kept — a value above 0 °C is never
 *                   drawn in a cold-arm colour, nor the reverse; a view that
 *                   straddles 0 °C keeps 0 °C on the ramp's pivot
 *                 · the pivot's own pale cyan is reserved for real freezing: a
 *                   view wholly above (below) it starts `warmStartC`
 *                   (`coldEndC`) into its arm
 *               The stretch stops short of the ramp's extremes (`warmTopC`,
 *               `coldBottomC`): deep red means extreme heat on the globe and
 *               must not mean "the warmest valley in a mild afternoon" here.
 *
 * A stretched scale is a DISPLAY choice and is disclosed wherever it is used:
 * the key is repainted through this same function with the range's own ticks,
 * its title says "fit to view", and the rail prints the range. The freezing
 * seam is added from the TRUE temperature in both modes.
 *
 * Node gate: tests/climalytix-heat-scale.mjs.
 */
import { TEMP_LUT_SIZE, tempToRampFrac, FREEZE_SEAM, freezingSeam } from '../temp-ramp.js';

export const SCALE_MODES = Object.freeze(['fit', 'absolute']);
export const FIT = Object.freeze({
    warmStartC: 4,      // a wholly-above-freezing view starts here on the warm arm
    warmTopC: 44,       // …and its warmest value is drawn here (short of "extreme heat")
    coldEndC: -4,
    coldBottomC: -50,
    minSpanC: 6,        // a nearly uniform field is not stretched into noise
});

/** Min/max of a field over EVERY time step (the run's range in the window), or null. */
export function runRange(f) {
    if (!f?.values) return null;
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < f.values.length; k++) {
        const v = f.values[k];
        if (v == null || !Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    return lo <= hi ? { min: lo, max: hi } : null;
}

/**
 * The scale for a mode and a range. `rampC(tC)` is the temperature whose ramp
 * colour tC is drawn in. A 'fit' request with no usable range is 'absolute'
 * (and says so in `mode`) — never a stretch over nothing.
 */
export function heatScale(mode, range) {
    if (mode !== 'fit' || !range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
        return { mode: 'absolute', lo: null, hi: null, rampC: (t) => t };
    }
    let lo = range.min, hi = range.max;
    if (hi - lo < FIT.minSpanC) {
        const mid = (lo + hi) / 2;
        lo = mid - FIT.minSpanC / 2; hi = mid + FIT.minSpanC / 2;
    }
    const clamp = (t) => Math.max(lo, Math.min(hi, t));
    let rampC;
    if (lo >= 0) {
        rampC = (t) => FIT.warmStartC + ((clamp(t) - lo) / (hi - lo)) * (FIT.warmTopC - FIT.warmStartC);
    } else if (hi <= 0) {
        rampC = (t) => FIT.coldBottomC + ((clamp(t) - lo) / (hi - lo)) * (FIT.coldEndC - FIT.coldBottomC);
    } else {
        // Straddles freezing: 0 °C stays on the pivot, each arm takes its own side.
        rampC = (t) => { const c = clamp(t); return c < 0 ? FIT.coldBottomC * (c / lo) : FIT.warmTopC * (c / hi); };
    }
    return { mode: 'fit', lo, hi, rampC };
}

/** Colour of tC on `scale` (+ the freezing seam from the TRUE value) into out[o..o+3]. */
export function scaleColor(scale, tC, lut, out, o) {
    const idx = Math.max(0, Math.min(TEMP_LUT_SIZE - 1, Math.round(tempToRampFrac(scale.rampC(tC)) * (TEMP_LUT_SIZE - 1))));
    const seam = FREEZE_SEAM.gain * 255 * freezingSeam(tC);
    out[o] = lut[idx * 4] + seam;
    out[o + 1] = lut[idx * 4 + 1] + seam;
    out[o + 2] = lut[idx * 4 + 2] + seam;
    out[o + 3] = 255;
}

/** The key's pixels for a scale: `n` RGBA columns across [lo, hi] (fit) or the whole ramp (absolute). */
export function keyPixels(scale, lut, n = TEMP_LUT_SIZE) {
    if (scale.mode !== 'fit') return Uint8ClampedArray.from(lut);
    const out = new Uint8ClampedArray(n * 4);
    for (let k = 0; k < n; k++) {
        // The key shows the SCALE; the seam is a mark on the map, not a colour of the ramp.
        const t = scale.lo + (k / (n - 1)) * (scale.hi - scale.lo);
        const idx = Math.max(0, Math.min(TEMP_LUT_SIZE - 1, Math.round(tempToRampFrac(scale.rampC(t)) * (TEMP_LUT_SIZE - 1))));
        out[k * 4] = lut[idx * 4]; out[k * 4 + 1] = lut[idx * 4 + 1]; out[k * 4 + 2] = lut[idx * 4 + 2]; out[k * 4 + 3] = 255;
    }
    return out;
}

/** Where a temperature sits on the key, 0..1. */
export function keyFrac(scale, tC) {
    if (scale.mode !== 'fit') return tempToRampFrac(tC);
    return Math.max(0, Math.min(1, (tC - scale.lo) / (scale.hi - scale.lo)));
}

/**
 * Round tick values IN THE READER'S UNIT across a fit scale (3–7 of them).
 * `toDisplay`/`fromDisplay` convert °C ↔ the unit. Returns [{ label, frac }].
 */
export function keyTicks(scale, { toDisplay, fromDisplay }) {
    const a = toDisplay(scale.lo), b = toDisplay(scale.hi);
    const step = [1, 2, 5, 10, 20, 50].find((s) => (b - a) / s <= 6) ?? 100;
    const ticks = [];
    for (let d = Math.ceil(a / step) * step; d <= b + 1e-9; d += step) {
        const frac = keyFrac(scale, fromDisplay(d));
        if (frac > 0.04 && frac < 0.96) ticks.push({ label: `${Math.round(d)}°`, frac });
    }
    return ticks;
}
