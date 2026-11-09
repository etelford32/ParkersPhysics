#!/usr/bin/env node
/**
 * climalytix-updraft.mjs — node gate for js/climalytix/updraft.js (plan §19 T5).
 *
 *   · level heights: the hypsometric estimate reproduces the ICAO standard
 *     atmosphere's 850 / 700 / 500 hPa altitudes to < 0.2 % — NEGATIVE
 *     CONTROL: an isothermal column at the surface temperature is off by > 1 %
 *     at 500 hPa (the lapse is not decoration)
 *   · the below-ground mask: a level is used only LEVEL_CLEARANCE_HPA above the
 *     surface pressure (Boulder's 840 hPa ground hides 850 hPa; sea level does
 *     not)
 *   · bracket(): instantaneous fields are interpolated between the stamps
 *     around an instant, the analysis included; outside the run is null
 *   · the budget: components are LISTED, sorted by height, never summed — no
 *     `total` anywhere; a below-ground level is a row with no value; the slope
 *     jet's vertical part is u·sin α
 *   · the paint: floor, red up / blue down, full at W_FULL_MS, √ ramp
 *
 *   node tests/climalytix-updraft.mjs
 */

import assert from 'node:assert/strict';
import {
    levelHeightAgl, levelUsable, bracket, verticalMotion, slopeVertical, updraftPaint,
    LEVEL_CLEARANCE_HPA, W_FULL_MS, W_FLOOR_MS, LEVELS, RD, G,
} from '../js/climalytix/updraft.js';
import { OROGRAPHIC_UP, OROGRAPHIC_DOWN } from '../js/climalytix/orographic.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
console.log('climalytix updraft');

/** ICAO standard atmosphere altitude (m) of pressure p below the tropopause. */
const isa = (p) => 288.15 / 0.0065 * (1 - Math.pow(p / 1013.25, 287.05 * 0.0065 / 9.80665));

ok('level heights reproduce the standard atmosphere; an isothermal column does not', () => {
    for (const p of [850, 700, 500]) {
        const z = levelHeightAgl(1013.25, p, 15);
        assert.ok(Math.abs(z - isa(p)) / isa(p) < 0.002, `${p} hPa: ${z} vs ISA ${isa(p)}`);
    }
    assert.ok(Math.abs(isa(700) - 3012) < 2 && Math.abs(isa(500) - 5574) < 2, 'the ISA anchors themselves');
    const isothermal = RD * 288.15 / G * Math.log(1013.25 / 500);
    assert.ok(Math.abs(isothermal - isa(500)) / isa(500) > 0.01, 'NEGATIVE CONTROL: no lapse ⇒ visibly wrong');
    assert.ok(Number.isNaN(levelHeightAgl(NaN, 700, 10)));
    // Over high ground the same level is much closer to the surface.
    assert.ok(levelHeightAgl(840, 700, 10) < 1600 && levelHeightAgl(840, 700, 10) > 1300);
});

ok('the below-ground mask: a level must sit LEVEL_CLEARANCE_HPA above the surface pressure', () => {
    assert.equal(LEVEL_CLEARANCE_HPA, 25);
    assert.equal(levelUsable(840, 850), false, 'Boulder: 850 hPa is underground');
    assert.equal(levelUsable(870, 850), false, 'only 20 hPa above the ground: too close');
    assert.equal(levelUsable(875, 850), true);
    assert.equal(levelUsable(1013, 850), true);
    assert.equal(levelUsable(840, 700), true);
    assert.equal(levelUsable(NaN, 500), false);
    assert.deepEqual(LEVELS.map((l) => l.hPa), [850, 700, 500]);
});

ok('bracket(): instantaneous fields between the stamps around an instant, the analysis included', () => {
    const H = 3_600_000, t = [0, 3 * H, 6 * H];
    assert.deepEqual(bracket(t, 0), { i0: 0, i1: 0, f: 0 }, 'unlike a flux window, the analysis has values');
    assert.deepEqual(bracket(t, 1 * H), { i0: 0, i1: 1, f: 1 / 3 });
    assert.deepEqual(bracket(t, 6 * H), { i0: 1, i1: 2, f: 1 });
    assert.equal(bracket(t, -1), null); assert.equal(bracket(t, 6 * H + 1), null);
});

ok('the budget is a LIST sorted by height — never a sum; underground levels are empty rows', () => {
    const rows = verticalMotion({
        orographicW: 0.8,
        slope: { u: -2, slopeDeg: 12, zJet: 11 },
        thermal: { regime: 'cu', wstar: 2.1, topM: 1500 },
        levels: [
            { hPa: 850, w: 0.4, zAgl: -100, usable: false },
            { hPa: 700, w: 0.12, zAgl: 1450, usable: true },
            { hPa: 500, w: -0.05, zAgl: 3900, usable: true },
        ],
    });
    assert.deepEqual(rows.map((r) => r.key), ['orographic', 'slope', 'gfs700', 'thermal', 'gfs500', 'gfs850']);
    assert.deepEqual(rows.map((r) => r.kind), ['surface', 'slope', 'mean', 'scale', 'mean', 'mean']);
    assert.ok(!('total' in rows) && rows.every((r) => !('total' in r)), 'nothing is ever summed');
    const under = rows.find((r) => r.key === 'gfs850');
    assert.equal(under.w, null); assert.equal(under.note, 'below the ground here');
    const sl = rows.find((r) => r.key === 'slope');
    assert.ok(Math.abs(sl.w - -2 * Math.sin(12 * Math.PI / 180)) < 1e-12);
    assert.equal(sl.label, 'Drainage wind (vertical part)');
    assert.equal(slopeVertical(3, 0), 0);
    assert.deepEqual(verticalMotion({ thermal: { regime: 'none', wstar: 0 } }), [], 'no thermals ⇒ no thermal row');
});

ok('the paint: floor, red up / blue down, full at W_FULL_MS on a √ ramp', () => {
    const at = (w) => { const d = new Uint8ClampedArray(4); updraftPaint(w, d, 0); return [...d]; };
    assert.deepEqual(at(W_FLOOR_MS), [0, 0, 0, 0]);
    assert.deepEqual(at(NaN), [0, 0, 0, 0]);
    assert.deepEqual(at(W_FULL_MS).slice(0, 3), OROGRAPHIC_UP.map((c) => Math.round(c * 255)));
    assert.deepEqual(at(-W_FULL_MS).slice(0, 3), OROGRAPHIC_DOWN.map((c) => Math.round(c * 255)));
    assert.equal(at(W_FULL_MS)[3], at(5)[3]);
    assert.ok(at(0.1)[3] < at(0.3)[3]);
});

console.log(`\n${passed} passed`);
