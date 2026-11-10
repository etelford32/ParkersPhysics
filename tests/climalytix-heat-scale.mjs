/**
 * Node gate for js/climalytix/heat-scale.js — which colour of the ONE
 * temperature ramp a value is drawn in.
 *
 * The bug it answers (first real GFS run, 2026-11-09): a ±4° window held
 * 38–73 °F, one sixth of a ramp built for the whole planet — at 62 % over the
 * ground it was an olive-brown wash, not a heat map. What is pinned:
 *   · 'absolute' is EarthView's bytes exactly (≡ map-view heatColor)
 *   · 'fit' is monotonic, keeps the SIDE of freezing, keeps 0 °C on the pivot
 *     when the view straddles it, and reserves the pivot colour otherwise
 *   · NEGATIVE CONTROL: a naive full-ramp stretch draws +3 °C in polar violet
 *   · the fit actually buys contrast on the real run's range
 *   · the key is painted by the same function and its ticks are round values
 *     in the reader's unit
 *   · a fit over nothing is 'absolute', never a stretch of nothing
 */
import assert from 'node:assert/strict';
import { heatScale, runRange, scaleColor, keyPixels, keyFrac, keyTicks, FIT, SCALE_MODES } from '../js/climalytix/heat-scale.js';
import { heatColor } from '../js/climalytix/map-view.js';
import { buildTempLUTPixels, tempToRampFrac } from '../js/temp-ramp.js';

const LUT = buildTempLUTPixels();
const col = (sc, t) => { const o = new Uint8ClampedArray(4); scaleColor(sc, t, LUT, o, 0); return [...o]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const f2c = (f) => (f - 32) / 1.8;

assert.deepEqual([...SCALE_MODES], ['fit', 'absolute']);

// ── absolute ≡ the map's (and EarthView's) own colour, seam included ────────
{
    const abs = heatScale('absolute', { min: 3, max: 23 });
    assert.equal(abs.mode, 'absolute');
    for (const t of [-60, -41.3, -10, -0.2, 0, 0.6, 7.5, 22, 36, 50, 61]) {
        assert.deepEqual(col(abs, t), [...heatColor(t, LUT)], `absolute ${t} °C is the shared ramp's own bytes`);
    }
}

// ── a fit over nothing is absolute ──────────────────────────────────────────
for (const r of [null, undefined, { min: NaN, max: 4 }, { min: 1, max: Infinity }]) {
    assert.equal(heatScale('fit', r).mode, 'absolute');
}
assert.equal(runRange(null), null);
assert.equal(runRange({ values: [null, NaN] }), null);
assert.deepEqual(runRange({ values: [4, null, -2.5, NaN, 19] }), { min: -2.5, max: 19 }, 'every lead, gaps skipped (a null is not 0)');
assert.deepEqual(runRange({ values: [null, 7] }), { min: 7, max: 7 });

// ── fit: the three guarantees, on each kind of view ─────────────────────────
const VIEWS = { warm: { min: 3.3, max: 22.8 }, cold: { min: -31, max: -6 }, straddle: { min: f2c(20), max: f2c(73) } };
for (const [name, r] of Object.entries(VIEWS)) {
    const sc = heatScale('fit', r);
    assert.equal(sc.mode, 'fit');
    let prev = -Infinity;
    for (let k = 0; k <= 200; k++) {
        const t = r.min + (k / 200) * (r.max - r.min);
        const rc = sc.rampC(t);
        assert.ok(rc >= prev - 1e-12, `${name}: monotonic at ${t}`);
        prev = rc;
        if (t > 0) assert.ok(rc > 0, `${name}: ${t} °C is above freezing and stays on the warm arm (got ${rc})`);
        if (t < 0) assert.ok(rc < 0, `${name}: ${t} °C is below freezing and stays on the cold arm (got ${rc})`);
        assert.ok(rc <= FIT.warmTopC + 1e-9 && rc >= FIT.coldBottomC - 1e-9, `${name}: short of the ramp's extremes`);
    }
    // Out-of-range values clamp to the ends (a later run frame is never off the key).
    assert.equal(sc.rampC(r.min - 50), sc.rampC(r.min));
    assert.equal(sc.rampC(r.max + 50), sc.rampC(r.max));
}
{
    const w = heatScale('fit', VIEWS.warm), c = heatScale('fit', VIEWS.cold), s = heatScale('fit', VIEWS.straddle);
    assert.equal(w.rampC(VIEWS.warm.min), FIT.warmStartC, 'a warm view starts past the pivot: pale cyan is reserved for real freezing');
    assert.equal(w.rampC(VIEWS.warm.max), FIT.warmTopC);
    assert.equal(c.rampC(VIEWS.cold.max), FIT.coldEndC);
    assert.equal(c.rampC(VIEWS.cold.min), FIT.coldBottomC);
    assert.equal(s.rampC(0), 0, 'a view that straddles freezing keeps 0 °C on the pivot');
    assert.ok(Math.abs(s.rampC(-1e-9)) < 1e-6 && Math.abs(s.rampC(1e-9)) < 1e-6, 'continuous through freezing');
    // The seam is drawn from the TRUE temperature in fit mode too.
    assert.ok(col(s, 0)[0] > LUT[Math.round(tempToRampFrac(0) * 255) * 4], 'freezing seam brightens 0 °C');
}

// ── NEGATIVE CONTROL: a naive stretch over the whole ramp lies about cold ───
{
    const r = VIEWS.warm;
    const naive = { rampC: (t) => -60 + ((t - r.min) / (r.max - r.min)) * 110 };
    assert.ok(naive.rampC(r.min) < -40, 'the naive stretch draws +3 °C in polar-night violet — the rule above is what prevents it');
    assert.ok(heatScale('fit', r).rampC(r.min) > 0);
}

// ── it buys contrast: the real run's coldest and warmest pixel ──────────────
{
    const frame = { min: f2c(38), max: f2c(73) };                 // what the first real map showed
    const abs = heatScale('absolute', null), fit = heatScale('fit', frame);
    const dAbs = dist(col(abs, frame.min), col(abs, frame.max)), dFit = dist(col(fit, frame.min), col(fit, frame.max));
    assert.ok(dFit > 1.5 * dAbs, `fit separates the view's ends more than absolute (${dFit.toFixed(0)} vs ${dAbs.toFixed(0)})`);
}

// ── a nearly uniform field is not stretched into noise ──────────────────────
{
    const sc = heatScale('fit', { min: 14.9, max: 15.1 });
    assert.ok(Math.abs((sc.hi - sc.lo) - FIT.minSpanC) < 1e-9);
    assert.ok(sc.rampC(15.1) - sc.rampC(14.9) < 2, '0.2 °C of real range moves the colour by a sliver, not the whole ramp');
}

// ── the key: same function, the range's own ticks ───────────────────────────
{
    const sc = heatScale('fit', VIEWS.straddle);
    const px = keyPixels(sc, LUT, 256);
    assert.equal(px.length, 256 * 4);
    const at = (k) => [px[k * 4], px[k * 4 + 1], px[k * 4 + 2]];
    const bare = (t) => { const i = Math.round(tempToRampFrac(sc.rampC(t)) * 255) * 4; return [LUT[i], LUT[i + 1], LUT[i + 2]]; };
    assert.deepEqual(at(0), bare(sc.lo));
    assert.deepEqual(at(255), bare(sc.hi));
    assert.deepEqual([...keyPixels(heatScale('absolute', null), LUT)], [...LUT], 'the absolute key is the ramp');
    assert.equal(keyFrac(sc, sc.lo), 0);
    assert.equal(keyFrac(sc, sc.hi), 1);
    assert.equal(keyFrac(heatScale('absolute', null), 10), tempToRampFrac(10));
    const F = { toDisplay: (c) => c * 1.8 + 32, fromDisplay: (d) => f2c(d) };
    const ticks = keyTicks(sc, F);
    assert.deepEqual(ticks.map((t) => t.label), ['30°', '40°', '50°', '60°', '70°'], 'round °F for a °F reader');
    for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i].frac > ticks[i - 1].frac);
    const C = { toDisplay: (c) => c, fromDisplay: (d) => d };
    assert.deepEqual(keyTicks(sc, C).map((t) => t.label), ['-5°', '0°', '5°', '10°', '15°', '20°'], 'and round °C for a °C reader — 0° included');
}

console.log('climalytix-heat-scale: absolute ≡ shared ramp, fit guarantees, contrast, key + ticks passed');
