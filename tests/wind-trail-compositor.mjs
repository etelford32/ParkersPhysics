/**
 * tests/wind-trail-compositor.mjs — pins the pure half of
 * js/wind-trail-compositor.js (the knee, its GLSL mirror, the readback maths).
 *
 * Run: node tests/wind-trail-compositor.mjs
 *
 *   1. trailKnee is the IDENTITY below the knee (a lone trail draws as before).
 *   2. Above it the peak channel rises monotonically and never reaches 1 —
 *      the sum has a ceiling, which is the whole point.
 *   3. It is HUE-PRESERVING: channel ratios are unchanged (desat 0), so ten
 *      navy trails saturate to a deep blue, never to white.
 *   4. It IS heroTone with desat 0 — one shoulder on the site, not two.
 *   5. The GLSL carries the same knee constant (interpolated, never retyped)
 *      and the same algebra.
 *   6. trailAlpha is the kneed peak, in [0, 1].
 *   7. halfToFloat decodes binary16 (the readback path on a HalfFloat target).
 *   8. sumStats reports the clip (fracOver1) and the knee's bound (kneedMax ≤ 1).
 */
import assert from 'node:assert/strict';
import {
    trailKnee, trailAlpha, TRAIL_TONE, TRAIL_KNEE_GLSL, halfToFloat, sumStats,
} from '../js/wind-trail-compositor.js';
import { heroTone } from '../js/hero-color.js';

let passed = 0, failed = 0;
function check(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`); }
}
const close = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

console.log('wind-trail-compositor');

check('identity below the knee', () => {
    for (const c of [[0, 0, 0], [0.1, 0.2, 0.5], [0.07, 0.2, TRAIL_TONE.knee], [0.3, 0.3, 0.3]]) {
        assert.deepEqual(trailKnee(c), c);
    }
});

check('above the knee the peak rises monotonically and never reaches 1', () => {
    let prev = 0;
    for (let p = TRAIL_TONE.knee; p < 50; p += 0.05) {
        const out = trailKnee([p * 0.1, p * 0.3, p]);
        const peak = Math.max(...out);
        assert.ok(peak > prev - 1e-12, `not monotone at ${p}`);
        assert.ok(peak < 1, `peak ${peak} reached 1 at ${p}`);
        prev = peak;
    }
    assert.ok(prev > 0.97, `asymptote too low: ${prev}`);
    // continuous at the knee
    const below = trailKnee([0, 0, TRAIL_TONE.knee - 1e-9])[2];
    const above = trailKnee([0, 0, TRAIL_TONE.knee + 1e-9])[2];
    assert.ok(Math.abs(above - below) < 1e-6, 'discontinuous at the knee');
});

check('hue-preserving: channel ratios are unchanged', () => {
    const inputs = [[0.07, 0.20, 0.60], [0.62, 0.86, 1.0], [0.26, 0.54, 0.86]];
    for (const base of inputs) for (const k of [1, 3, 10, 40]) {
        const c = base.map((v) => v * k);
        const o = trailKnee(c);
        const peak = Math.max(...c);
        for (let i = 0; i < 3; i++) {
            assert.ok(close(o[i] / Math.max(...o), c[i] / peak, 1e-9), `ratio drift at ×${k} ch ${i}`);
        }
        // blue stays dominant
        assert.ok(o[2] >= o[1] && o[1] >= o[0]);
    }
});

check('it is heroTone with desat 0', () => {
    for (const c of [[0.1, 0.4, 0.9], [2, 5, 9], [0.5, 0.5, 0.5], [0, 0, 30]]) {
        const a = trailKnee(c);
        const b = heroTone(c, { knee: TRAIL_TONE.knee, desat: 0 });
        assert.deepEqual(a, b);
    }
});

check('negative inputs are clamped to 0, not amplified', () => {
    assert.deepEqual(trailKnee([-1, -0.5, 0.2]), [0, 0, 0.2]);
});

check('GLSL mirror carries the same knee and algebra', () => {
    assert.ok(TRAIL_KNEE_GLSL.includes(`#define TRAIL_KNEE ${TRAIL_TONE.knee.toFixed(4)}`));
    assert.match(TRAIL_KNEE_GLSL, /float np = 1\.0 - d \* d \/ \(peak \+ d - TRAIL_KNEE\);/);
    assert.match(TRAIL_KNEE_GLSL, /return c \* \(np \/ peak\);/);
    assert.ok(!/mix\(/.test(TRAIL_KNEE_GLSL), 'no desaturation term in the trail knee');
    // transliterate the GLSL's algebra and run it against the JS
    const knee = TRAIL_TONE.knee;
    const glslJs = (c) => {
        const peak = Math.max(c[0], c[1], c[2]);
        if (peak <= knee) return c;
        const d = 1 - knee;
        const np = 1 - d * d / (peak + d - knee);
        return c.map((v) => v * (np / peak));
    };
    for (const c of [[0.2, 0.5, 0.9], [1, 2, 4], [0, 0, 12]]) {
        const a = trailKnee(c), b = glslJs(c);
        for (let i = 0; i < 3; i++) assert.ok(close(a[i], b[i], 1e-12), `GLSL ≠ JS at ${c}`);
    }
});

check('trailAlpha is the kneed peak in [0, 1]', () => {
    assert.equal(trailAlpha([0, 0, 0]), 0);
    assert.equal(trailAlpha(trailKnee([0.1, 0.2, 0.5])), 0.5);
    const big = trailAlpha(trailKnee([5, 10, 20]));
    assert.ok(big > 0.9 && big <= 1);
});

check('halfToFloat decodes binary16', () => {
    assert.equal(halfToFloat(0x3c00), 1);
    assert.equal(halfToFloat(0x4000), 2);
    assert.equal(halfToFloat(0xc000), -2);
    assert.equal(halfToFloat(0x0000), 0);
    assert.ok(close(halfToFloat(0x3555), 0.333251953125));
    assert.ok(close(halfToFloat(0x0001), Math.pow(2, -24)));   // smallest subnormal
    assert.equal(halfToFloat(0x7c00), Infinity);
    assert.ok(Number.isNaN(halfToFloat(0x7e00)));
});

check('sumStats reports the clip and the bound', () => {
    const peaks = [0, 0.01, 0.3, 0.5, 0.9, 1.4, 2.5, 6];
    const s = sumStats(peaks);
    assert.equal(s.n, 6);                        // two under the floor
    assert.equal(s.max, 6);
    assert.ok(close(s.fracOver1, 3 / 6));
    assert.ok(s.kneedMax < 1 && s.kneedMax > 0.9);
    const quiet = sumStats([0.1, 0.2, 0.3]);
    assert.equal(quiet.fracOver1, 0);
    assert.equal(quiet.kneedMax, 0.3);
    assert.deepEqual(sumStats([]), { n: 0, p50: 0, p99: 0, max: 0, fracOver1: 0, kneedMax: 0 });
});

console.log('──────────────────────────────');
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
