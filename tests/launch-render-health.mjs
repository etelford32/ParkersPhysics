// node tests/launch-render-health.mjs — pins the PURE verdicts the launch
// planner's 3D canvas uses to judge its own frame (js/launch-render-health.js).
// The page reports the same verdict to telemetry, and the browser gates read
// it back through api.health — one definition for a visitor and for CI.
import assert from 'node:assert/strict';
import { frameHealth, occlusionVerdict, OCCLUSION_LIMIT, HEALTH_LIMITS } from '../js/launch-render-health.js';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (e) { console.error(`  FAIL ${name}\n${e.stack}`); process.exitCode = 1; }
}

// W×H RGBA frame from a per-pixel colour function.
function frame(W, H, px) {
    const data = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const [r, g, b] = px(x, y);
        const i = (y * W + x) * 4;
        data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
    }
    return { data, width: W, height: H };
}
// A night pad: dark sky gradient, a lit grey deck, a white vehicle.
const nightPad = (x, y, W = 320, H = 200) => {
    if (x > 150 && x < 170 && y > 30 && y < 150) return [225, 226, 230];      // vehicle
    if (y > 140) return [70 + (x % 7), 72, 80];                               // deck
    return [18 + (y >> 3), 16 + (y >> 3), 30];                                // sky
};

test('a night-pad frame is ok, and its numbers sit clear of every threshold', () => {
    const h = frameHealth(frame(320, 200, nightPad));
    assert.equal(h.verdict, 'ok');
    assert.ok(h.std > HEALTH_LIMITS.minStd * 4, `spread ${h.std}`);
    assert.ok(h.mean > HEALTH_LIMITS.minMean * 4, `mean ${h.mean}`);
    assert.ok(h.clipFrac < HEALTH_LIMITS.maxClipFrac / 4);
});

test('nothing drew (incomplete framebuffer) ⇒ black', () => {
    assert.equal(frameHealth(frame(320, 200, () => [0, 0, 0])).verdict, 'black');
});

test('one flat colour (sky or clear colour only) ⇒ blank', () => {
    assert.equal(frameHealth(frame(320, 200, () => [24, 22, 38])).verdict, 'blank');
});

test('a whited-out frame (tone map / bloom failure) ⇒ washed-out', () => {
    const h = frameHealth(frame(320, 200, (x, y) => (y < 120 ? [255, 255, 255] : nightPad(x, y))));
    assert.equal(h.verdict, 'washed-out');
});

test('drew but unlit ⇒ dark', () => {
    const h = frameHealth(frame(320, 200, (x, y) => (x > 150 && x < 170 ? [14, 14, 14] : [1, 1, 2])));
    assert.equal(h.verdict, 'dark');
});

test('a missing or short buffer is no-frame, never ok', () => {
    assert.equal(frameHealth({}).verdict, 'no-frame');
    assert.equal(frameHealth({ data: new Uint8Array(10), width: 320, height: 200 }).verdict, 'no-frame');
});

test('row order does not matter (readPixels returns bottom-up)', () => {
    const a = frameHealth(frame(320, 200, nightPad));
    const b = frameHealth(frame(320, 200, (x, y) => nightPad(x, 199 - y)));
    assert.equal(a.verdict, b.verdict);
    assert.ok(Math.abs(a.mean - b.mean) < 1.5);
});

test('occlusion: fraction of the vehicle-reaching rays hidden behind something else', () => {
    assert.deepEqual(occlusionVerdict({ visible: 90, occluded: 10 }), { reached: 100, frac: 0.1, ok: true, reason: null });
    const bad = occlusionVerdict({ visible: 80, occluded: 20 });
    assert.equal(bad.ok, false);
    assert.equal(bad.reason, 'occluded');
    assert.equal(occlusionVerdict({ visible: 0, occluded: 0 }).reason, 'vehicle-not-in-view');
    assert.ok(OCCLUSION_LIMIT > 0 && OCCLUSION_LIMIT < 0.25);
});

console.log(`\n${passed} passed`);
