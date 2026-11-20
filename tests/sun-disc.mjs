/**
 * tests/sun-disc.mjs — pins js/sun-disc.js
 *
 *   node tests/sun-disc.mjs
 *
 * The limb's COLOUR is derived (grey atmosphere + Eddington–Barbier), its
 * LUMINANCE stays the measured polynomial, and the two must not interfere:
 * check 3 is the identity that keeps every photometric gate on the page valid.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    C2_M_K, LAMBDA_RGB_M, LUMA, PALETTE_DECODE_GAMMA, MU_FLOOR,
    greyTemperature, limbDarkeningEB, limbChroma, limbLuminanceNL, decodePick,
    GRANULE_MM, GRANULE_RSUN, GRANULE_FREQ, GRANULE_CONTRAST, RSUN_MM,
    detailWeight, screenScaleAt, frameScale, DISC_GLSL,
} from '../js/sun-disc.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
const lum = (c) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
console.log('sun-disc.mjs');

ok('the grey atmosphere: T(τ = ⅔) is T_eff, and it cools upward', () => {
    assert.ok(Math.abs(greyTemperature(2 / 3, 5778) - 5778) < 1e-9);
    assert.ok(Math.abs(greyTemperature(0, 5778) / 5778 - Math.pow(0.5, 0.25)) < 1e-12);     // the boundary temperature
    assert.ok(greyTemperature(0.1, 5778) < greyTemperature(1, 5778));
});

ok('Eddington–Barbier darkening: 1 at disc centre, monotone, and BLUE DARKENS MORE THAN RED', () => {
    for (const l of LAMBDA_RGB_M) {
        assert.ok(Math.abs(limbDarkeningEB(1, l) - 1) < 1e-12);
        let prev = 2;
        for (let mu = 1; mu >= 0.05; mu -= 0.05) { const v = limbDarkeningEB(mu, l); assert.ok(v < prev + 1e-12); prev = v; }
    }
    for (const mu of [0.8, 0.5, 0.2, 0.1]) {
        const [r, g, b] = LAMBDA_RGB_M.map((l) => limbDarkeningEB(mu, l));
        assert.ok(r > g && g > b, `μ=${mu}: ${r} ${g} ${b}`);
    }
    // Independent arithmetic for one value: 549 nm, μ → the floor.
    const x = (T) => C2_M_K / (549e-9 * T);
    const want = (Math.exp(x(greyTemperature(1, 5778))) - 1) / (Math.exp(x(greyTemperature(MU_FLOOR, 5778))) - 1);
    assert.ok(Math.abs(limbDarkeningEB(0, 549e-9) - want) < 1e-12, 'the extreme limb is held at MU_FLOOR');
});

ok('IDENTITY: the chroma never changes luminance — for any base colour', () => {
    for (const base of [[1, 1, 1], decodePick([1.00, 0.83, 0.40]), [0.3, 0.9, 0.2], [1, 0.28, 0.02]]) {
        for (const mu of [1, 0.9, 0.6, 0.3, 0.1, 0.0]) {
            const c = limbChroma(mu, base);
            const tinted = base.map((v, i) => v * c[i]);
            assert.ok(Math.abs(lum(tinted) - lum(base)) < 1e-12, `μ=${mu} base=${base}`);
        }
    }
    assert.deepEqual(limbChroma(1, [1, 0.6, 0.2]).map((v) => +v.toFixed(12)), [1, 1, 1], 'no tint at disc centre');
});

ok('the limb is redder: B/R of the tint falls toward the limb, by a physically modest amount', () => {
    const ratio = (mu) => { const c = limbChroma(mu); return c[2] / c[0]; };
    assert.ok(ratio(0.5) < 1 && ratio(0.2) < ratio(0.5) && ratio(0.05) < ratio(0.2));
    assert.ok(ratio(0.05) > 0.60 && ratio(0.05) < 0.85, `B/R at the limb ${ratio(0.05)}`);
    assert.ok(Math.abs(ratio(0.2) - 0.867 / 1.069) < 0.005, 'the measured tint at μ = 0.2: red ×1.07, blue ×0.87');
    // NEGATIVE CONTROL — the grey law the page had: no colour change at all.
    const grey = (mu) => [1, 1, 1].map(() => limbLuminanceNL(mu));
    assert.equal(grey(0.1)[2] / grey(0.1)[0], 1);
});

ok('the derivation agrees with observation well enough to trust its COLOUR — and not well enough to replace the polynomial', () => {
    for (const mu of [0.8, 0.5, 0.2]) {
        const model = limbDarkeningEB(mu, 549e-9), observed = limbLuminanceNL(mu);
        const err = Math.abs(model - observed) / observed;
        console.log(`    μ=${mu}: grey model ${model.toFixed(3)} vs Neckel & Labs ${observed.toFixed(3)} (${(err * 100).toFixed(1)} %)`);
        // Measured 0.6 %, 8.7 %, 14.7 %; the bound is that, not a wish.
        assert.ok(err < 0.16, `μ=${mu}: ${model} vs ${observed}`);
        assert.ok(model < observed, 'always on the over-darkening side');
    }
    assert.ok(limbDarkeningEB(0.5, 549e-9) < limbLuminanceNL(0.5), 'the grey model over-darkens (the real photosphere is not grey) — which is why luminance stays the polynomial');
});

ok('the palette decode turns the pick named "golden" into gold on an sRGB display', () => {
    const pick = [1.00, 0.83, 0.40];
    const lin = decodePick(pick);
    const enc = (v) => Math.pow(v, 1 / PALETTE_DECODE_GAMMA);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(enc(lin[i]) - pick[i]) < 1e-12);
    // Without the decode the display shows the pick ENCODED a second time: paler.
    const shown = pick.map(enc);
    assert.ok(shown[2] > pick[2] + 0.2, 'undecoded, blue is lifted and the colour washes out');
});

ok('granulation constants are the stated megametres', () => {
    assert.ok(Math.abs(GRANULE_RSUN * RSUN_MM - GRANULE_MM) < 1e-12);
    assert.ok(Math.abs(GRANULE_FREQ * GRANULE_RSUN - 1) < 0.002);
    assert.ok(GRANULE_CONTRAST > 0.03 && GRANULE_CONTRAST < 0.10);
});

ok('detail is shown only past the frame\'s own resolution', () => {
    const frame = frameScale(0.465, 1024);                       // an HMI 1024 frame: R☉ per frame pixel
    assert.ok(Math.abs(1 / frame - 476.16) < 0.01);
    assert.equal(detailWeight(frame * 2, frame), 0, 'screen coarser than the frame: nothing');
    assert.equal(detailWeight(frame, frame), 0, 'one screen pixel per frame pixel: still nothing');
    assert.equal(detailWeight(frame * 0.5, frame), 1, 'magnified 2×: all of it');
    let prev = -1;
    for (let r = 1.2; r >= 0.3; r -= 0.02) { const w = detailWeight(frame * r, frame); assert.ok(w >= prev); prev = w; }
    assert.equal(detailWeight(NaN, frame), 0);
    // At the hero framing (≈ 6.7 R☉, 30° lens, 670 px) the frame is NOT being magnified.
    assert.equal(detailWeight(screenScaleAt(6.7, 30, 670), frame), 0);
    // Close in (2.0 R☉) it is.
    assert.ok(detailWeight(screenScaleAt(2.0, 30, 670), frame) > 0.5);
});

ok('the GLSL is generated from these constants and sunFS uses it at BOTH places the limb is applied', () => {
    const num = (x) => { const t = String(x); return /[.e]/.test(t) ? t : t + '.0'; };
    for (const v of [C2_M_K, ...LAMBDA_RGB_M, MU_FLOOR, GRANULE_FREQ, GRANULE_CONTRAST, PALETTE_DECODE_GAMMA]) assert.ok(DISC_GLSL.includes(num(v)), `DISC_GLSL carries ${v}`);
    assert.ok(!DISC_GLSL.includes('`'));
    const html = readFileSync(new URL('../sun.html', import.meta.url), 'utf8');
    const a = html.indexOf('const sunFS = /* glsl */'), b = html.indexOf('sunLOD.addLevel');
    const src = html.slice(a, b);
    assert.ok(src.includes('${DISC_GLSL}'), 'sunFS includes the kernel');
    assert.ok(/col \*= limb \* limbChroma\(/.test(src), 'the model path tints its limb darkening');
    assert.ok(/limb \* limbChroma\([^)]*\) \* obsRel/.test(src), 'the observed path tints its limb darkening');
    assert.ok(/return discDecode\(/.test(src), 'the palette is decoded');
    // The luminance law in sunFS is still the polynomial this file mirrors.
    for (const c of ['0.36459', '1.06147', '1.01793', '1.01203', '0.70623', '0.25007']) assert.ok(src.includes(c), `Neckel & Labs coefficient ${c}`);
});

console.log(`${passed} checks passed (sun-disc)`);
