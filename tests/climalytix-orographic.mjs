#!/usr/bin/env node
/**
 * climalytix-orographic.mjs — node gate for js/climalytix/orographic.js
 * (plan §19 T2: forced ascent w = u·∂h/∂x + v·∂h/∂y).
 *
 *   · a uniform wind over a TILTED PLANE gives the closed form at every
 *     interior node, at 0° and 60° latitude (the slope is in metres, so the
 *     cos φ spacing must already be in it)
 *   · wind ALONG the contours gives 0; REVERSING the wind flips the sign
 *     exactly; the gridded field equals the slope/aspect closed form
 *     (`slopeWind`) that the hover uses
 *   · NEGATIVE CONTROL: swapping u and v (the classic east/north mix-up)
 *     gives the wrong answer on a slope that rises only to the north
 *   · gaps stay gaps: no wind ⇒ NaN, a slope gap ⇒ NaN, never 0
 *   · extremes: strongest ascent / descent found where they are, and a box
 *     restricts the search
 *   · the paint: nothing at or under the floor (the ramp starts there),
 *     red up, blue down, full at OROGRAPHIC_FULL_MS, √ ramp; ft/min
 *
 *   node tests/climalytix-orographic.mjs
 */

import assert from 'node:assert/strict';
import { sampleGrid, slopeAspect } from '../js/climalytix/terrain.js';
import {
    slopeWind, orographicGrid, orographicExtremes, orographicPaint, windSide, formatW,
    OROGRAPHIC_FULL_MS, OROGRAPHIC_FLOOR_MS, OROGRAPHIC_UP, OROGRAPHIC_DOWN, OROGRAPHIC_ALPHA, FT_PER_MIN_PER_MS,
} from '../js/climalytix/orographic.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
console.log('climalytix orographic');

const R = 6_371_008.8, M_PER_DEG = Math.PI * R / 180;
const N = 9;
/** A plane h = 1000 + east·x + north·y (x, y metres from the box's SW corner). */
function plane(lat0, east, north, d = 0.01) {
    const box = { north: lat0 + (N - 1) * d / 2, south: lat0 - (N - 1) * d / 2, west: -105, east: -105 + (N - 1) * d };
    return sampleGrid(box, N, N, (lat, lon) => 1000
        + east * (lon + 105) * M_PER_DEG * Math.cos(lat * Math.PI / 180)
        + north * (lat - lat0) * M_PER_DEG);
}
const interior = (fn) => { for (let i = 1; i < N - 1; i++) for (let j = 1; j < N - 1; j++) fn(i * N + j, i, j); };
const uniform = (u, v) => () => ({ u, v });

ok('a uniform wind over a tilted plane gives the closed form, at 0° and 60°', () => {
    for (const lat0 of [0, 60]) {
        const g = plane(lat0, 0.05, 0.12);
        const sa = slopeAspect(g);
        const w = orographicGrid(g, sa, uniform(7, -3));
        // The plane's gradient is (0.05, 0.12) at the centre row exactly; off the centre
        // row the east term carries cos φ(row)/cos φ(sample), a few parts in 10⁴ at 60°.
        interior((k, i) => {
            const want = 7 * 0.05 + -3 * 0.12;
            const tol = lat0 === 0 ? 1e-6 : 5e-4;
            assert.ok(Math.abs(w[k] - want) < tol, `lat0 ${lat0} row ${i}: ${w[k]} vs ${want}`);
        });
    }
});

ok('wind along the contours gives 0; reversing the wind flips the sign exactly', () => {
    const g = plane(40, 0.08, 0.06);
    const sa = slopeAspect(g);
    // ∇h ∝ (0.08, 0.06): the contours run along (−0.06, 0.08).
    const along = orographicGrid(g, sa, uniform(-0.06 * 50, 0.08 * 50));
    interior((k) => assert.ok(Math.abs(along[k]) < 1e-3, `along-contour w ${along[k]}`));
    const fwd = orographicGrid(g, sa, uniform(5, 4)), back = orographicGrid(g, sa, uniform(-5, -4));
    interior((k) => assert.equal(back[k], -fwd[k]));
    interior((k) => assert.ok(fwd[k] > 0, 'blowing up the slope is ascent'));
});

ok('the gridded field equals the slope/aspect closed form the hover uses', () => {
    const g = plane(40, -0.07, 0.15);
    const sa = slopeAspect(g);
    const w = orographicGrid(g, sa, uniform(-4, 9));
    interior((k) => {
        const c = slopeWind(sa.slope[k], sa.aspect[k], -4, 9);
        assert.ok(Math.abs(c - w[k]) < 1e-5, `${c} vs ${w[k]}`);
    });
    assert.equal(slopeWind(0, NaN, 10, 10), 0, 'flat ground is never lifted');
    // A slope rising to the NORTH faces SOUTH (aspect 180): a south wind (v > 0) climbs it.
    assert.ok(Math.abs(slopeWind(10, 180, 0, 8) - 8 * Math.tan(10 * Math.PI / 180)) < 1e-12);
    assert.ok(slopeWind(10, 180, 0, -8) < 0, 'a north wind descends a south-facing slope');
});

ok('NEGATIVE CONTROL: swapping u and v is wrong on a slope that rises only northward', () => {
    const g = plane(40, 0, 0.1);
    const sa = slopeAspect(g);
    const k = 4 * N + 4;
    const right = sa.dzdx[k] * 6 + sa.dzdy[k] * 0;        // a pure WEST wind runs along this slope
    const swapped = sa.dzdx[k] * 0 + sa.dzdy[k] * 6;      // the bug: u read as v
    assert.ok(Math.abs(right) < 1e-9);
    assert.ok(Math.abs(swapped - 0.6) < 1e-6);
    assert.equal(orographicGrid(g, sa, uniform(6, 0))[k], right);
    assert.notEqual(orographicGrid(g, sa, uniform(6, 0))[k], swapped);
});

ok('gaps stay gaps: no wind ⇒ NaN, a slope gap ⇒ NaN, never 0', () => {
    const g = plane(40, 0.1, 0);
    const sa = slopeAspect(g);
    const w = orographicGrid(g, sa, () => null);
    interior((k) => assert.ok(Number.isNaN(w[k])));
    assert.ok(Number.isNaN(orographicGrid(g, sa, uniform(5, 5))[0]), 'the edge node has no Sobel stencil');
    assert.ok(Number.isNaN(orographicGrid(g, sa, () => ({ u: NaN, v: 1 }))[4 * N + 4]));
});

ok('extremes are found where they are; a box restricts the search', () => {
    const g = { latN: 41, lonW: -106, dlat: 0.5, dlon: 0.5, nRows: 3, nCols: 3 };
    const w = Float32Array.from([0.2, NaN, -1.5, 0.1, 2.5, 0, -0.3, 0.4, NaN]);
    const all = orographicExtremes(g, w);
    assert.deepEqual([all.up.w, all.up.lat, all.up.lon], [2.5, 40.5, -105.5]);
    assert.deepEqual([all.down.w, all.down.lat, all.down.lon], [-1.5, 41, -105]);
    assert.equal(all.n, 7);
    const box = orographicExtremes(g, w, { north: 40.6, south: 39.9, west: -106.1, east: -105.6 });
    assert.equal(box.up.w, 0.10000000149011612);
    assert.equal(box.down.w, -0.30000001192092896);
    const none = orographicExtremes(g, Float32Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(none.up, null); assert.equal(none.down, null);
});

ok('the paint: floor, red up, blue down, full at OROGRAPHIC_FULL_MS on a √ ramp', () => {
    const at = (w) => { const d = new Uint8ClampedArray(4); orographicPaint(w, d, 0); return [...d]; };
    assert.deepEqual(at(0), [0, 0, 0, 0]);
    assert.deepEqual(at(OROGRAPHIC_FLOOR_MS / 2), [0, 0, 0, 0]);
    assert.deepEqual(at(NaN), [0, 0, 0, 0]);
    const full = Math.round(255 * OROGRAPHIC_ALPHA);
    assert.deepEqual(at(OROGRAPHIC_FULL_MS), [...OROGRAPHIC_UP.map((c) => Math.round(c * 255)), full]);
    assert.deepEqual(at(-5), [...OROGRAPHIC_DOWN.map((c) => Math.round(c * 255)), full]);
    assert.deepEqual(at(OROGRAPHIC_FLOOR_MS), [0, 0, 0, 0], 'the ramp starts AT the floor: no step');
    const q = OROGRAPHIC_FLOOR_MS + (OROGRAPHIC_FULL_MS - OROGRAPHIC_FLOOR_MS) / 4;
    assert.equal(at(q)[3], Math.round(full * 0.5), '√ ramp: a quarter of the span reads half');
    assert.equal(at(-q)[3], at(q)[3], 'symmetric in sign');
    assert.equal(windSide(1, 12), 'windward, forced up');
    assert.equal(windSide(-1, 12), 'lee, forced down');
    assert.equal(windSide(1, 0.5), 'across the slope');
    assert.equal(formatW(1.27), '+1.3 m/s');
    assert.equal(formatW(-0.234), '−0.23 m/s');
    assert.equal(formatW(1, { feet: true }), `+1.0 m/s (+${Math.round(FT_PER_MIN_PER_MS)} ft/min)`);
    assert.ok(Math.abs(FT_PER_MIN_PER_MS * 0.3048 / 60 - 1) < 1e-9, '1 m/s = 60/0.3048 ft/min');
});

console.log(`\n${passed} passed`);
