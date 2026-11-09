#!/usr/bin/env node
/**
 * climalytix-convection.mjs — node gate for js/climalytix/convection.js (plan §19 T6).
 *
 *   · the two closed forms are kinetic energy per unit mass: ½·w_max² = CAPE
 *     and ½·w_lid² = |CIN| exactly; no CAPE ⇒ no ceiling
 *   · CIN is read as a LID whichever sign convention the source uses (GFS ≤ 0)
 *   · the lifted-index sign is pinned BOTH ways: negative = unstable,
 *     positive = stable (the classic inversion bug)
 *   · the ingredients check: none / capped / possible / likely, each by its
 *     rule — NEGATIVE CONTROL: a CAPE-only ranking calls a capped 3000 J/kg
 *     column the most dangerous point, the outlook calls it capped
 *   · a strong lift breaks a lid exactly when ½w² ≥ |CIN|
 *   · the paints: CAPE transparent below 100 J/kg; the categorical paint is a
 *     FLAT band per category (no interpolated colour), 'none' transparent
 *
 *   node tests/climalytix-convection.mjs
 */

import assert from 'node:assert/strict';
import {
    parcelCeiling, lidSpeed, capeBand, cinBand, liBand, convectionOutlook, capePaint, outlookPaint,
    CAPE_MIN_JKG, CIN_WEAK_JKG, TRIGGER_MIN_MS, CATEGORIES, OUTLOOK_COLORS, CAPE_FULL_JKG,
} from '../js/climalytix/convection.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
console.log('climalytix convection');

ok('the closed forms are kinetic energy: ½·w_max² = CAPE, ½·w_lid² = |CIN|', () => {
    for (const cape of [100, 1234.5, 4000]) assert.ok(Math.abs(0.5 * parcelCeiling(cape) ** 2 - cape) < 1e-9);
    assert.ok(Math.abs(parcelCeiling(2000) - 63.2456) < 1e-3, '2000 J/kg ⇒ 63 m/s (an upper bound)');
    assert.equal(parcelCeiling(0), 0); assert.equal(parcelCeiling(-5), 0);
    for (const cin of [-12, -150, 0]) assert.ok(Math.abs(0.5 * lidSpeed(cin) ** 2 - Math.abs(cin)) < 1e-9);
    assert.equal(lidSpeed(-50), lidSpeed(50), 'either sign convention is the same lid');
    assert.ok(Number.isNaN(lidSpeed(NaN)));
});

ok('the lifted index sign, both ways: negative is unstable, positive is stable', () => {
    assert.equal(liBand(4), 'stable');
    assert.equal(liBand(0), 'stable');
    assert.equal(liBand(-1.5), 'marginally unstable');
    assert.equal(liBand(-4), 'unstable');
    assert.equal(liBand(-8), 'very unstable');
    assert.notEqual(liBand(-4), liBand(4), 'NEGATIVE CONTROL: |LI| alone cannot tell them apart');
    assert.equal(liBand(NaN), null);
    assert.equal(capeBand(50), 'none'); assert.equal(capeBand(1500), 'moderate'); assert.equal(capeBand(5000), 'extreme');
    assert.equal(cinBand(-10), 'weak lid'); assert.equal(cinBand(-180), 'strong lid'); assert.equal(cinBand(10), 'weak lid');
});

ok('the ingredients check, rule by rule — CAPE-only is the negative control', () => {
    const thermal = (w) => [{ key: 'thermal', label: 'Thermals', w }];
    assert.equal(convectionOutlook({ capeJkg: 60, cinJkg: 0, triggers: thermal(3) }).category, 'none', 'nothing to release');
    assert.equal(convectionOutlook({ capeJkg: 1500, cinJkg: -10, triggers: thermal(2) }).category, 'likely');
    assert.equal(convectionOutlook({ capeJkg: 1500, cinJkg: -10, triggers: thermal(0.5) }).category, 'possible', 'weak lid, weak lift');
    assert.equal(convectionOutlook({ capeJkg: 1500, cinJkg: -10 }).category, 'possible', 'weak lid, no lift known');
    // The capped bomb: more energy, a strong lid, ordinary thermals.
    const capped = { capeJkg: 3000, cinJkg: -180, triggers: thermal(2.5) };
    const open = { capeJkg: 1200, cinJkg: -8, triggers: thermal(2.5) };
    assert.equal(convectionOutlook(capped).category, 'capped');
    assert.equal(convectionOutlook(open).category, 'likely');
    const capeOnly = [capped, open].sort((a, b) => b.capeJkg - a.capeJkg)[0];
    assert.equal(capeOnly, capped, 'NEGATIVE CONTROL: ranking by CAPE alone puts the capped column first');
    assert.equal(convectionOutlook({ capeJkg: 1500, cinJkg: -10, triggers: [] }).best, null);
    assert.equal(convectionOutlook({ capeJkg: NaN, cinJkg: -10 }), null);
    assert.equal(convectionOutlook({ capeJkg: 1500, cinJkg: null }), null);
    assert.equal(CIN_WEAK_JKG, 25); assert.equal(TRIGGER_MIN_MS, 1); assert.equal(CAPE_MIN_JKG, 100);
});

ok('a lift breaks a lid exactly when ½w² ≥ |CIN|; the strongest trigger is the one reported', () => {
    const cin = -60, need = lidSpeed(cin);                                  // ≈ 10.95 m/s
    const at = (w) => convectionOutlook({ capeJkg: 2000, cinJkg: cin, triggers: [{ key: 'oro', w }, { key: 'th', w: 1 }] });
    assert.equal(at(need * 0.999).category, 'capped');
    assert.equal(at(need).category, 'possible');
    assert.equal(at(need).best.key, 'oro');
    assert.equal(at(-30).best.key, 'th', 'sinking air is not a trigger');
});

ok('the paints: CAPE floor + full; the outlook is a flat band per category', () => {
    const px = (fn, v) => { const d = new Uint8ClampedArray(4); fn(v, d, 0); return [...d]; };
    assert.deepEqual(px(capePaint, CAPE_MIN_JKG - 1), [0, 0, 0, 0]);
    assert.deepEqual(px(capePaint, NaN), [0, 0, 0, 0]);
    assert.equal(px(capePaint, CAPE_FULL_JKG)[3], px(capePaint, 9000)[3]);
    assert.ok(px(capePaint, 500)[3] < px(capePaint, 2000)[3]);
    assert.deepEqual(px(outlookPaint, CATEGORIES.indexOf('none')), [0, 0, 0, 0]);
    for (const c of ['capped', 'possible', 'likely']) {
        const [rgb, a] = OUTLOOK_COLORS[c];
        assert.deepEqual(px(outlookPaint, CATEGORIES.indexOf(c)), [...rgb.map((x) => Math.round(x * 255)), Math.round(a * 255)]);
    }
    assert.deepEqual(new Set(['capped', 'possible', 'likely'].map((c) => px(outlookPaint, CATEGORIES.indexOf(c)).join())).size, 3);
});

console.log(`\n${passed} passed`);
