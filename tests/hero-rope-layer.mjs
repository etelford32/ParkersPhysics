// tests/hero-rope-layer.mjs — the pure half of js/hero-rope-layer.js
// Run: node tests/hero-rope-layer.mjs
import assert from 'node:assert/strict';
import {
    corridorRadius, CORRIDOR_SUN_RE, CORRIDOR_SUN_DRAWN_R, SUN_EXAGGERATION,
    heroBasis, ropePointToHero, mapSurface, passedFade, scrubWindow, buildReplayForecast,
    PASSED_HIDE_AU,
} from '../js/hero-rope-layer.js';
import { stageRadius, EARTH_S, RSUN_KM, AU_KM } from '../js/stage/scale.js';
import { ropeSurfaceGrid } from '../js/stage/model.js';
import { GANNON_FIT } from '../js/flux-rope-presets.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);
const HOUR = 3600e3;

// ── Radial anchors: 0 AU on the drawn Sun, 1 AU exactly on the drawn Earth ──
assert.equal(corridorRadius(0), 0);
near(corridorRadius(1), CORRIDOR_SUN_RE, 1e-9, '1 AU lands on Earth');
// The map IS the Stage's map, rescaled — monotone, and proportional to it.
let prev = -1;
for (let r = 0; r <= 1.4; r += 0.01) {
    const s = corridorRadius(r);
    assert.ok(s > prev, `monotone at ${r}`);
    if (r > 0) near(s / stageRadius(r), CORRIDOR_SUN_RE / EARTH_S, 1e-9, "proportional to stageRadius");
    prev = s;
}
// The disclosed Sun exaggeration is derived, never typed in.
near(SUN_EXAGGERATION, CORRIDOR_SUN_DRAWN_R / corridorRadius(RSUN_KM / AU_KM), 1e-12, 'exaggeration derived');
assert.ok(SUN_EXAGGERATION > 5 && SUN_EXAGGERATION < 40, 'exaggeration in a sane band');

// ── Basis: right-handed, e1 = Sun→Earth, e3 = +y, orthonormal ────────────
const sunDir = [1, 0.12, -0.08];
const n = Math.hypot(...sunDir);
const B = heroBasis(sunDir);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
near(dot(B.e1, sunDir.map((v) => -v / n)), 1, 1e-12, 'e1 is −sunDir');
for (const e of [B.e1, B.e2, B.e3]) near(Math.hypot(...e), 1, 1e-12, 'unit');
near(dot(B.e1, B.e2), 0, 1e-12, 'e1⊥e2'); near(dot(B.e2, B.e3), 0, 1e-12, 'e2⊥e3'); near(dot(B.e1, B.e3), 0, 1e-12, 'e1⊥e3');
const c = cross(B.e1, B.e2);
near(dot(c, B.e3), 1, 1e-12, 'RIGHT-handed: e1×e2 = +e3 (the orrery is the mirrored one, not us)');
assert.ok(B.e3[1] > 0.99, 'e3 is ecliptic north = scene +y');
assert.equal(B.handedness, 1);

// ── Point map: a rope point at 1 AU along +x lands ON Earth (the origin) ──
const sunPos = sunDir.map((v) => v / n * CORRIDOR_SUN_RE);
const earth = ropePointToHero([1, 0, 0], B, sunPos);
near(Math.hypot(...earth), 0, 1e-9, 'Earth-directed apex at 1 AU is at Earth');
const origin = ropePointToHero([0, 0, 0], B, sunPos);
assert.deepEqual(origin, sunPos, '0 AU is the drawn Sun');
// Direction is preserved and radius is the map's.
const q = ropePointToHero([0.3, 0.4, 0], B, sunPos);
const rel = [q[0] - sunPos[0], q[1] - sunPos[1], q[2] - sunPos[2]];
near(Math.hypot(...rel), corridorRadius(0.5), 1e-9, 'radius follows the map');

// ── mapSurface reuses the destination buffer and matches the point map ────
const grid = ropeSurfaceGrid({ frame: { eDir: [1, 0, 0], eP: [0, 1, 0], nHat: [0, 0, 1] }, dAu: 0.8, sigApexAu: 0.1 }, 8, 6);
const dst = new Float32Array(grid.positions.length);
const out = mapSurface(grid.positions, B, sunPos, dst);
assert.equal(out, dst, 'writes in place');
const p0 = ropePointToHero([grid.positions[0], grid.positions[1], grid.positions[2]], B, sunPos);
near(out[0], p0[0], 1e-5, 'vertex 0 x'); near(out[1], p0[1], 1e-5, 'vertex 0 y');

// ── passedFade ────────────────────────────────────────────────────────────
assert.equal(passedFade(0.5), 1); assert.equal(passedFade(1), 1);
assert.equal(passedFade(PASSED_HIDE_AU), 0);
near(passedFade((1 + PASSED_HIDE_AU) / 2), 0.5, 1e-12, 'linear ramp');

// ── Replay forecast shape (stub kernel) ───────────────────────────────────
const calls = [];
const kernel = {
    setRopes: (r) => calls.push(['ropes', r.length]),
    setInteraction: (i) => calls.push(['interaction', i.enabled]),
    apexKmAt: () => 0, sigmaApexKmAt: () => 0,
};
const rf = buildReplayForecast(kernel, GANNON_FIT, { twistTurns: 1, extra: 'default' });
assert.equal(rf.idle, false); assert.equal(rf.replay, true); assert.equal(rf.train, true);
assert.equal(rf.preset.ropes.length, GANNON_FIT.standoffRopes.length);
assert.equal(rf.preset.ropes[0].extra, 'default', 'kernel defaults underlay the fit');
assert.equal(rf.preset.ropes[0].twistTurns, GANNON_FIT.standoffRopes[0].twistTurns, 'fit wins over defaults');
assert.equal(rf.launchMs, Date.parse(GANNON_FIT.launchIso));
assert.deepEqual(calls, [['ropes', 2], ['interaction', true]], 'kernel configured with interaction ON');
assert.equal(rf.summary.observed, true, 'a replay prints the OBSERVED arrival, never a fan it did not run');
near(rf.summary.arrivalP50Ms - rf.launchMs, 43.6 * HOUR, 1, 'SSC +43.6 h');

// ── Scrub window ──────────────────────────────────────────────────────────
const w = scrubWindow(rf);
assert.equal(w.t0, rf.launchMs - 6 * HOUR);
assert.equal(w.t1, rf.summary.arrivalP90Ms + 18 * HOUR);
assert.deepEqual(w.launches, [rf.launchMs, rf.launchMs + 72_900e3]);
assert.equal(w.arrivalMs, rf.summary.arrivalP50Ms);
assert.equal(scrubWindow(null), null);
assert.equal(scrubWindow({ launchMs: NaN }), null);
const noSummary = scrubWindow({ launchMs: 1e12, preset: { ropes: [{ launchOffsetS: 0 }, { launchOffsetS: 3600 }] } });
assert.equal(noSummary.arrivalMs, null, 'no summary → no arrival claimed');
assert.equal(noSummary.t1, 1e12 + 3600e3 + 60 * HOUR + 18 * HOUR, 'nominal transit after the LAST launch');

console.log('hero-rope-layer: all assertions passed');

// ── Storm-driven reveal: the Kp proxy and the conditions sampler ──────────
{
    const { kpProxyFromDst, driverSamples, conditionsSeries, conditionsAt } = await import('../js/hero-rope-layer.js');
    assert.equal(kpProxyFromDst(0), 2); assert.equal(kpProxyFromDst(-20), 2);
    assert.equal(kpProxyFromDst(-50), 5); assert.equal(kpProxyFromDst(-100), 6);
    assert.equal(kpProxyFromDst(-400), 9); assert.equal(kpProxyFromDst(-900), 9);
    near(kpProxyFromDst(-75), 5.5, 1e-12, 'linear between the G bands');
    assert.equal(kpProxyFromDst(NaN), 2, 'no Dst → quiet, never a storm');
    let prevK = 0;
    for (let d = 0; d >= -500; d -= 5) { const k = kpProxyFromDst(d); assert.ok(k >= prevK - 1e-12, 'monotone: deeper Dst never lowers the proxy'); prevK = k; }

    // A live forecast hands its driver through untouched.
    const live = { driver: { samples: [{ t: 0, v: 400, n: 5, bz: 0 }] } };
    assert.equal(driverSamples(live), live.driver.samples);

    // A replay builds one from the kernel's series; V is the arrived rope's
    // apex speed, ambient otherwise.
    const n = 8;
    const stub = {
        maxSteps: 1000,
        series: (t0, dtS, nn) => ({ bz: Float32Array.from({ length: nn }, (_, i) => (i >= 4 ? -30 : 0)) }),
        apexKmAt: (r, tS) => (tS >= 4 * 900 ? 1.5e8 : 1e7),
        apexVKmsAt: () => 700,
    };
    const rf = { kernel: stub, launchMs: 1e12, preset: { ropes: [{ launchOffsetS: 0, wKms: 450 }] } };
    const smp = driverSamples(rf, { dtS: 900, hours: n * 900 / 3600 });
    assert.equal(smp.length, n);
    assert.equal(smp[0].v, 450, 'ambient before arrival'); assert.equal(smp[5].v, 700, 'apex speed once arrived');
    assert.equal(smp[5].bz, -30); assert.equal(smp[3].t, 1e12 + 3 * 900e3);

    const cs = conditionsSeries(rf);
    assert.equal(cs.dst.length, cs.samples.length, 'Dst track on the driver grid');
    assert.ok(cs.samples.length > n, 'production default is the full 120 h horizon');
    const before = conditionsAt(cs, 1e12 + 1 * 900e3);
    const after = conditionsAt(cs, 1e12 + 7 * 900e3);
    assert.equal(before.bz, 0); assert.equal(before.gLevel, 0);
    assert.equal(after.bz, -30); assert.equal(after.v, 700);
    assert.ok(after.dst < before.dst, 'Dst deepens under southward Bz');
    assert.ok(after.kp >= before.kp, 'Kp proxy follows Dst');
    assert.equal(conditionsAt(cs, 1e12 - 1), null, 'outside the window → null, never extrapolated');
    assert.equal(conditionsAt(null, 1e12), null);
    assert.equal(conditionsSeries({ preset: { ropes: [] } }), null, 'no driver, no kernel → null');
}

console.log('hero-rope-layer: reveal assertions passed');
