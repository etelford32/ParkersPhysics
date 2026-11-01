// node tests/launch-camera-layout.mjs — pins the PURE layout rules behind the
// launch planner's 3D canvas (default view per screen + the safe frame).
import assert from 'node:assert/strict';
import { pickDefaultView, safeInsets, framingFor, DEFAULT_VIEW } from '../js/launch-camera-layout.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('default view per screen shape', () => {
    assert.deepEqual(pickDefaultView({ width: 358, height: 477 }), { view: 'threequarter', fov: 40 });  // phone portrait
    assert.deepEqual(pickDefaultView({ width: 760, height: 330 }), { view: 'threequarter', fov: 38 });  // phone landscape
    assert.deepEqual(pickDefaultView({ width: 1010, height: 631 }), DEFAULT_VIEW);                       // laptop
    assert.deepEqual(pickDefaultView({ width: 1920, height: 960 }), { view: 'wide', fov: 34 });         // fullscreen monitor
    assert.deepEqual(pickDefaultView({ width: 0, height: 0 }), DEFAULT_VIEW);                            // collapsed panel
});

test('safe insets: no overlays ⇒ none', () => {
    assert.deepEqual(safeInsets(1000, 600, []), { top: 0, bottom: 0 });
});

test('safe insets: a corner dock clear of the central band costs nothing', () => {
    // Bottom-right dock spanning 72–98 % of the width.
    assert.deepEqual(safeInsets(1000, 600, [{ left: 720, right: 980, top: 550, bottom: 590 }]), { top: 0, bottom: 0 });
});

test('safe insets: bars crossing the band push the frame in from that edge', () => {
    const ins = safeInsets(390, 600, [
        { left: 8, right: 382, top: 8, bottom: 44 },     // views row
        { left: 8, right: 382, top: 50, bottom: 86 },    // toggles row
        { left: 8, right: 382, top: 552, bottom: 592 },  // camera dock
    ]);
    assert.deepEqual(ins, { top: 92, bottom: 54 });
});

test('safe insets are capped at 30 % of the height per edge', () => {
    const ins = safeInsets(400, 400, [{ left: 0, right: 400, top: 0, bottom: 380 - 200 + 100 }]);
    assert.equal(ins.top, 120);
});

test('framing with no insets is the identity', () => {
    const f = framingFor({ width: 1000, height: 600, fovDeg: 38 });
    close(f.fitFovDeg, 38);
    close(f.fitAspect, 1000 / 600);
    assert.equal(f.viewOffsetY, 0);
});

test('framing: same focal length, shorter frame ⇒ tan(fov/2) scales by Hs/H', () => {
    const H = 600, top = 90, bottom = 30;
    const f = framingFor({ width: 1000, height: H, fovDeg: 38, insets: { top, bottom } });
    const Hs = H - top - bottom;
    close(Math.tan(f.fitFovDeg * Math.PI / 360), Math.tan(38 * Math.PI / 360) * Hs / H);
    // Horizontal half-angle is unchanged (the safe rect has the full width).
    close(Math.tan(f.fitFovDeg * Math.PI / 360) * f.fitAspect, Math.tan(38 * Math.PI / 360) * 1000 / H);
    // Principal point moves DOWN by (top − bottom)/2 ⇒ window offset is negative.
    assert.equal(f.viewOffsetY, -30);
});

test('framing never leaves less than 40 % of the frame', () => {
    const f = framingFor({ width: 300, height: 300, fovDeg: 38, insets: { top: 200, bottom: 200 } });
    close(f.safeHeight, 120);
});

console.log(`\n${passed} passed`);
