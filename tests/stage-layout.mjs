/**
 * stage-layout.mjs — the rules behind the stage windows
 * ═══════════════════════════════════════════════════════════════════════════
 * js/stage-layout.js: the layout document, corner anchoring, clamping, and
 * the ONE gate that says who gets their arrangement remembered. Pins:
 *   • normalize drops unknown ids, bad numbers and empty entries; a
 *     document with nothing in it is "home";
 *   • anchors: a rect near each corner anchors to THAT corner, the offsets
 *     round-trip exactly, and re-placing on a stage of another size keeps
 *     the panel the same distance from its corner (the point of anchoring);
 *   • clamping keeps MIN_VISIBLE_PX of a panel inside the stage, however
 *     far it was dragged or however small the stage became;
 *   • the memory gate is dashboard-sync's tier gate, plan by plan.
 *
 * Run: node tests/stage-layout.mjs
 */
import assert from 'node:assert/strict';
import * as L from '../js/stage-layout.js';
import { tierAllowsSync } from '../js/dashboard-sync.js';
import { ALL_PLAN_IDS, PAID_PLAN_IDS } from '../js/tier-config.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

console.log('stage-layout');

ok('normalize: unknown ids, bad numbers and empty entries are dropped; garbage is home', () => {
    const ids = ['hud', 'dock'];
    assert.deepEqual(L.normalizeStageLayout(null, ids), { v: 1, panels: {} });
    assert.deepEqual(L.normalizeStageLayout('x', ids), { v: 1, panels: {} });
    assert.deepEqual(L.normalizeStageLayout({ panels: { nope: { w: 10 } } }, ids), { v: 1, panels: {} });
    const d = L.normalizeStageLayout({ panels: {
        hud: { anchor: 'tr', dx: 12, dy: 'bad', w: 300, open: false },
        dock: { anchor: 'xx', dx: 1, dy: 2, h: -5, open: true },
    } }, ids);
    // hud: the anchor needs BOTH offsets, so it is dropped; w and open stay.
    assert.deepEqual(d.panels.hud, { w: 300, open: false });
    // dock: nothing valid survives → no entry.
    assert.equal(d.panels.dock, undefined);
    assert.equal(L.isHomeLayout(d), false);
    assert.equal(L.isHomeLayout(L.normalizeStageLayout({ panels: {} }, ids)), true);
    assert.equal(L.isHomeLayout(null), true);
});

ok('anchors: nearest corner, exact round trip, and the same distance from the corner on another stage', () => {
    const stage = { w: 1000, h: 700 };
    const cases = [
        [{ left: 20, top: 30, w: 200, h: 100 }, 'tl', 20, 30],
        [{ left: 760, top: 30, w: 200, h: 100 }, 'tr', 40, 30],
        [{ left: 20, top: 560, w: 200, h: 100 }, 'bl', 20, 40],
        [{ left: 760, top: 560, w: 200, h: 100 }, 'br', 40, 40],
    ];
    for (const [rect, anchor, dx, dy] of cases) {
        const e = L.anchorFromRect(rect, stage);
        assert.deepEqual(e, { anchor, dx, dy });
        assert.deepEqual(L.placeFromAnchor(e, stage, { w: rect.w, h: rect.h }), rect);
        assert.deepEqual(L.roundTrip(rect, stage), rect);
        // Another stage: the panel keeps its distance from ITS corner.
        const small = { w: 600, h: 500 };
        const p = L.placeFromAnchor(e, small, { w: rect.w, h: rect.h });
        const back = L.anchorFromRect(p, small);
        assert.deepEqual(back, { anchor, dx, dy });
    }
});

ok('clamping keeps MIN_VISIBLE_PX inside the stage', () => {
    const stage = { w: 500, h: 400 };
    const far = L.clampRect({ left: 900, top: -900, w: 200, h: 100 }, stage);
    assert.equal(far.left, 500 - L.MIN_VISIBLE_PX);
    assert.equal(far.top, L.MIN_VISIBLE_PX - 100);
    // A tiny panel: the minimum is its own size.
    const tiny = L.clampRect({ left: -50, top: 600, w: 20, h: 20 }, stage);
    assert.deepEqual([tiny.left, tiny.top], [0, 380]);
    // A placed anchor on a stage that shrank below the panel still shows it.
    const p = L.placeFromAnchor({ anchor: 'br', dx: 10, dy: 10 }, { w: 100, h: 100 }, { w: 300, h: 200 });
    assert.ok(p.left + p.w >= L.MIN_VISIBLE_PX && p.left <= 100 - L.MIN_VISIBLE_PX);
    assert.deepEqual(L.clampSize({ w: 10, h: 5000 }, { minW: 120, minH: 24, maxH: 900 }), { w: 120, h: 900 });
    assert.deepEqual(L.clampSize({}, {}), { w: undefined, h: undefined });
});

ok('withPanel merges, drops undefineds, treats open:true as home, and removes on null', () => {
    let d = L.withPanel(null, 'hud', { w: 300 });
    assert.deepEqual(d, { v: 1, panels: { hud: { w: 300 } } });
    d = L.withPanel(d, 'hud', { open: false, h: undefined });
    assert.deepEqual(d.panels.hud, { w: 300, open: false });
    d = L.withPanel(d, 'hud', { open: true });
    assert.deepEqual(d.panels.hud, { w: 300 });
    d = L.withPanel(d, 'hud', { w: undefined });
    assert.equal(d.panels.hud, undefined);
    d = L.withPanel(L.withPanel(null, 'a', { w: 1 }), 'a', null);
    assert.equal(L.isHomeLayout(d), true);
});

ok('the memory gate is dashboard-sync\'s tier gate: paid plans, tester, admins', () => {
    for (const plan of ALL_PLAN_IDS) {
        assert.equal(L.layoutMemoryAllowed(plan, 'user'), tierAllowsSync(plan, 'user'), plan);
        if (plan !== 'tester') assert.equal(L.layoutMemoryAllowed(plan, 'user'), PAID_PLAN_IDS.has(plan), `${plan} paid ⇔ remembered`);
    }
    assert.equal(L.layoutMemoryAllowed('free', 'user'), false);
    assert.equal(L.layoutMemoryAllowed('basic', 'user'), true);
    assert.equal(L.layoutMemoryAllowed('tester', 'user'), true);
    assert.equal(L.layoutMemoryAllowed('free', 'admin'), true);
    assert.equal(L.layoutMemoryAllowed(undefined, undefined), false);
});

console.log(`\n${passed} passed`);
