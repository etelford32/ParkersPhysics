/**
 * tests/wind-palette.mjs — pins js/wind-palette.js, the ONE wind colour rule.
 *
 * Run: node tests/wind-palette.mjs
 *
 * What it proves:
 *   1. Speed → brightness: relative luminance is strictly increasing in s at
 *      every altitude the page draws (and at two altitudes it does not yet).
 *   2. Altitude → shade: at every fixed s, luminance strictly increases with
 *      altitude — lower is deeper, as the legend says.
 *   3. It is BLUE everywhere: every sample's HSL hue sits in the blue band.
 *      (A second hue at the fast end — the old magenta / amber / gold — is
 *      exactly what this rule replaced.)
 *   4. The pre-mixed closure (`makeWindRamp`) is bit-identical to the direct
 *      call, so the hot loops and the legend cannot drift.
 *   5. The altitude law is anchored to the atmo-scale altitude table
 *      (0 at the ground, 1 at the jet), monotonic, and clamps above it.
 *   6. Out-of-range / non-finite inputs clamp instead of producing NaN
 *      vertex colours.
 */
import assert from 'node:assert/strict';
import {
    windColor, makeWindRamp, altitudeShade, windColorCss, relativeLuminance,
    hueDeg, ALT_TOP_KM, SURFACE_STOPS, TOP_STOPS, WIND_PALETTE_NOTE,
} from '../js/wind-palette.js';
import { LEVEL_ALTITUDE_KM } from '../js/atmo-scale.js';

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}

const ALTS = [LEVEL_ALTITUDE_KM.sfc, LEVEL_ALTITUDE_KM[850], LEVEL_ALTITUDE_KM[500],
              LEVEL_ALTITUDE_KM[250], 3.0, 8.0];
const S = Array.from({ length: 33 }, (_, i) => i / 32);
const HUE_MIN = 185, HUE_MAX = 245;   // the blue band (HSL degrees)

console.log('wind-palette');

check('speed → brightness: luminance strictly increases with s at every altitude', () => {
    for (const alt of ALTS) {
        let prev = -1;
        for (const s of S) {
            const L = relativeLuminance(windColor(s, alt));
            assert.ok(L > prev + 1e-6, `alt ${alt} km: L(${s.toFixed(3)}) = ${L.toFixed(4)} not above ${prev.toFixed(4)}`);
            prev = L;
        }
    }
});

check('altitude → shade: at every s, luminance strictly increases with altitude', () => {
    const drawn = [LEVEL_ALTITUDE_KM.sfc, LEVEL_ALTITUDE_KM[850], LEVEL_ALTITUDE_KM[500], LEVEL_ALTITUDE_KM[250]];
    for (const s of S) {
        let prev = -1;
        for (const alt of drawn) {
            const L = relativeLuminance(windColor(s, alt));
            assert.ok(L > prev + 1e-6, `s ${s.toFixed(3)}: L at ${alt} km = ${L.toFixed(4)} not above ${prev.toFixed(4)}`);
            prev = L;
        }
    }
});

check('the step from the ground to 850 hPa is a VISIBLE shade step (≥ 0.04 luminance at s = 0.5)', () => {
    const a = relativeLuminance(windColor(0.5, LEVEL_ALTITUDE_KM.sfc));
    const b = relativeLuminance(windColor(0.5, LEVEL_ALTITUDE_KM[850]));
    assert.ok(b - a >= 0.04, `ΔL = ${(b - a).toFixed(4)} — the √ law exists to make this step legible`);
});

check('it is blue everywhere: HSL hue in the blue band at every sample', () => {
    for (const alt of ALTS) for (const s of S) {
        const c = windColor(s, alt);
        const h = hueDeg(c);
        assert.ok(Number.isFinite(h), `grey sample at s ${s} alt ${alt}`);
        assert.ok(h >= HUE_MIN && h <= HUE_MAX, `hue ${h.toFixed(1)}° at s ${s.toFixed(3)} alt ${alt} km is outside ${HUE_MIN}–${HUE_MAX}°`);
    }
});

check('blue channel dominates at every sample (no second hue at the fast end)', () => {
    for (const alt of ALTS) for (const s of S) {
        const [r, g, b] = windColor(s, alt);
        assert.ok(b >= g && g >= r, `(${r.toFixed(2)}, ${g.toFixed(2)}, ${b.toFixed(2)}) at s ${s.toFixed(3)} alt ${alt}`);
    }
});

check('makeWindRamp(alt) is bit-identical to windColor(s, alt)', () => {
    for (const alt of ALTS) {
        const ramp = makeWindRamp(alt);
        const a = [0, 0, 0], b = [0, 0, 0];
        for (const s of S) {
            ramp(s, a); windColor(s, alt, b);
            assert.deepEqual(a, b, `alt ${alt} s ${s}`);
        }
    }
});

check('altitudeShade: 0 at the ground, 1 at the jet, monotonic, clamped above', () => {
    assert.ok(altitudeShade(0) === 0);
    assert.ok(Math.abs(altitudeShade(ALT_TOP_KM) - 1) < 1e-12);
    assert.equal(altitudeShade(ALT_TOP_KM * 3), 1);
    assert.equal(altitudeShade(-5), 0);
    assert.equal(altitudeShade(NaN), 0);
    let prev = -1;
    for (let a = 0; a <= ALT_TOP_KM; a += 0.1) {
        const k = altitudeShade(a);
        assert.ok(k > prev, `shade not increasing at ${a}`);
        prev = k;
    }
    assert.equal(ALT_TOP_KM, LEVEL_ALTITUDE_KM[250], 'the shade axis must end at the drawn jet altitude');
});

check('out-of-range and non-finite speeds clamp; every channel stays in [0,1]', () => {
    for (const alt of [0, 20, NaN]) {
        for (const s of [-1, 0, 0.5, 1, 2, NaN, Infinity]) {
            const c = windColor(s, alt);
            for (const v of c) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `(${c}) at s ${s} alt ${alt}`);
        }
        assert.deepEqual(windColor(-1, alt), windColor(0, alt));
        assert.deepEqual(windColor(2, alt), windColor(1, alt));
        assert.deepEqual(windColor(NaN, alt), windColor(0, alt));
    }
});

check('stop tables are three ascending-luminance stops at both ends', () => {
    for (const stops of [SURFACE_STOPS, TOP_STOPS]) {
        assert.equal(stops.length, 3);
        const L = stops.map(relativeLuminance);
        assert.ok(L[0] < L[1] && L[1] < L[2], `stops not ascending: ${L.map(x => x.toFixed(3))}`);
        assert.ok(Object.isFrozen(stops));
    }
});

check('windColorCss renders an rgb() string from the same bytes', () => {
    const css = windColorCss(0.5, LEVEL_ALTITUDE_KM.sfc);
    const c = windColor(0.5, LEVEL_ALTITUDE_KM.sfc);
    assert.equal(css, `rgb(${(c[0] * 255) | 0}, ${(c[1] * 255) | 0}, ${(c[2] * 255) | 0})`);
});

check('the disclosure names both axes', () => {
    assert.match(WIND_PALETTE_NOTE, /Brighter = faster/);
    assert.match(WIND_PALETTE_NOTE, /lower altitude/);
});

console.log('──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
