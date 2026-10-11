/**
 * upper-atmosphere-sat-attitude.mjs — attitude, shadow and ground track
 * ═══════════════════════════════════════════════════════════════════════════
 * js/upper-atmosphere-sat-attitude.js is PURE. Pins:
 *   • every mode's basis is orthonormal and right-handed; nadir / LVLH put
 *     −Z on the velocity and +Y radial out; inertial puts +Y on the Sun and
 *     −Z 90° from it; tumble turns with time about an axis seeded by the id
 *     (two ids, two axes) and is the nadir frame at t = 0;
 *   • arrayAlpha turns the array normal onto the Sun's projection and its
 *     cosIncidence is the component a single gimbal can reach;
 *   • illumination: behind the planet is umbra, the near-side sunlit, the
 *     penumbra band is 2 Sun radii wide and the fraction climbs 0 → 1 across
 *     it; the sun-side limb is lit (a cylindrical test would be wrong there);
 *   • beta: the Sun on the orbit normal is β = 90°, in-plane 0°; the critical
 *     beta at the ISS radius is ~69.7° (the textbook ~70°); eclipse-free
 *     above it;
 *   • subSatellite agrees with the column kernel's sceneToLatLon (the
 *     page's one frame) at Greenwich, 90°E, the poles and a random point;
 *   • groundTrackSamples: past reversed into time order, future forward,
 *     every point on the surface sphere, a propagator that fails ends the
 *     side; nextShadowEvent finds the entry on a circular orbit crossing the
 *     shadow and null on an eclipse-free one.
 *
 * Run: node tests/upper-atmosphere-sat-attitude.mjs
 */
import assert from 'node:assert/strict';
import * as A from '../js/upper-atmosphere-sat-attitude.js';
import { sceneToLatLon } from '../js/upper-atmosphere-column.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const crossV = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

console.log('upper-atmosphere-sat-attitude');

const R = 1 + 420 / 6371;
const pos = [R * 0.6, R * 0.5, -R * Math.sqrt(1 - 0.36 - 0.25)];
const vel = [-0.4, 0.9, 0.7];
const sun = [1, 0.2, 0.1].map((v, _, a) => v / Math.hypot(...a));

ok('bases: orthonormal + right-handed for every family; nadir puts −Z on v and +Y on r; inertial +Y on the Sun', () => {
    for (const family of Object.keys(A.ATTITUDE_MODES)) {
        const b = A.attitudeBasis({ family, pos, vel, sunDir: sun, tS: 37, id: family });
        for (const v of [b.x, b.y, b.z]) near(len(v), 1, 1e-12, family);
        near(dot(b.x, b.y), 0, 1e-12); near(dot(b.y, b.z), 0, 1e-12); near(dot(b.x, b.z), 0, 1e-12);
        near(dot(crossV(b.x, b.y), b.z), 1, 1e-12, `${family} right-handed`);
    }
    const L = A.lvlh(pos, vel);
    for (const family of ['iss', 'starlink', 'iridium', 'generic']) {
        const b = A.attitudeBasis({ family, pos, vel, sunDir: sun });
        near(dot(b.z, L.along), -1, 1e-12, `${family} −Z = ram`);
        near(dot(b.y, L.up), 1, 1e-12, `${family} +Y = radial`);
    }
    const h = A.attitudeBasis({ family: 'hubble', pos, vel, sunDir: sun });
    near(dot(h.y, sun), 1, 1e-12, 'arrays on the Sun');
    near(dot(h.z, sun), 0, 1e-12, 'tube 90° off the Sun');
    assert.equal(h.mode.id, 'inertial');
});

ok('tumble: the nadir frame at t = 0, turned at the mode rate, about an axis that differs by id', () => {
    const n = A.attitudeBasis({ family: 'generic', pos, vel, sunDir: sun });
    const t0 = A.attitudeBasis({ family: 'debris', pos, vel, sunDir: sun, tS: 0, id: 'a' });
    near(dot(t0.z, n.z), 1, 1e-12); near(dot(t0.y, n.y), 1, 1e-12);
    const t1 = A.attitudeBasis({ family: 'debris', pos, vel, sunDir: sun, tS: 10, id: 'a' });
    assert.ok(dot(t1.z, n.z) < 0.999, 'turned after 10 s');
    const t2 = A.attitudeBasis({ family: 'debris', pos, vel, sunDir: sun, tS: 10, id: 'b' });
    assert.ok(Math.abs(dot(t1.axis, t2.axis)) < 0.99, 'another id, another axis');
    near(len(t1.axis), 1, 1e-12);
    assert.deepEqual(A.attitudeBasis({ family: 'debris', pos, vel, sunDir: sun, tS: 10, id: 'a' }).axis, t1.axis, 'deterministic');
    assert.equal(n.axis, null);
    // The hash separates neighbouring ids (FNV alone put 'a' and 'b' 0.004 apart).
    assert.ok(Math.abs(A.hash01('a') - A.hash01('b')) > 0.05);
    assert.ok(Math.abs(A.hash01(70003) - A.hash01(70004)) > 0.05);
    assert.ok(A.hash01('x') >= 0 && A.hash01('x') < 1);
    // The rocket body turns slower than debris.
    const r1 = A.attitudeBasis({ family: 'rocket', pos, vel, sunDir: sun, tS: 10, id: 'a' });
    assert.ok(dot(r1.z, n.z) > dot(t1.z, n.z));
    // Orthonormal still after the rotation.
    near(dot(t1.x, t1.y), 0, 1e-12); near(len(t1.z), 1, 1e-12);
});

ok('arrayAlpha: the normal lands on the Sun\'s projection; cosIncidence is the reachable component', () => {
    const b = A.attitudeBasis({ family: 'starlink', pos, vel, sunDir: sun });
    const sb = A.toBody(sun, b);
    const { alphaRad, cosIncidence } = A.arrayAlpha(sb);
    const normal = [0, Math.cos(alphaRad), Math.sin(alphaRad)];
    near(dot(normal, sb), cosIncidence, 1e-12, 'normal · sun = cosIncidence');
    near(cosIncidence, Math.hypot(sb[1], sb[2]), 1e-12);
    assert.ok(cosIncidence <= 1 && cosIncidence >= 0);
    assert.deepEqual(A.arrayAlpha([1, 0, 0]), { alphaRad: 0, cosIncidence: 0 });   // Sun on the axis: nothing to gain
    near(A.arrayAlpha([0, 0, 1]).alphaRad, Math.PI / 2, 1e-12);
});

ok('illumination: umbra behind the planet, sunlit in front, the penumbra band 2 Sun-radii wide, the sun-side limb lit', () => {
    const s = [1, 0, 0];
    assert.equal(A.illumination([1.07, 0, 0], s).state, 'sunlit');
    assert.equal(A.illumination([-1.07, 0, 0], s).state, 'umbra');
    assert.equal(A.illumination([-1.07, 0, 0], s).fraction, 0);
    // The edge of the shadow at r = 1.07: the Earth's angular radius there.
    const r = 1.07, rhoE = Math.asin(1 / r), rhoS = A.SUN_ANGULAR_RADIUS;
    const at = (theta) => { const p = [-r * Math.cos(theta), r * Math.sin(theta), 0]; return A.illumination(p, s); };
    assert.equal(at(rhoE - rhoS - 1e-4).state, 'umbra');
    assert.equal(at(rhoE + rhoS + 1e-4).state, 'sunlit');
    const mid = at(rhoE);
    assert.equal(mid.state, 'penumbra');
    near(mid.fraction, 0.5, 1e-6, 'half-lit at the geometric edge');
    assert.ok(at(rhoE - 0.6 * rhoS).fraction < at(rhoE + 0.6 * rhoS).fraction, 'climbs across the band');
    near(mid.earthRadDeg, rhoE * 180 / Math.PI, 1e-9);
    // On the sun-side limb (x = 0 plane, toward +x half): lit. A cylinder
    // test alone cannot tell this side from the other.
    assert.equal(A.illumination([0.01, 1.07, 0], s).state, 'sunlit');
    assert.equal(A.illumination([0.5, 0, 0], s).state, 'umbra', 'inside the planet: dark');
});

ok('beta: on the normal 90°, in-plane 0°, ISS critical ≈ 69.7°, eclipse-free above it', () => {
    const p = [1.066, 0, 0], v = [0, 0.001, 0];          // normal = +z
    near(A.betaAngle(p, v, [0, 0, 1]).betaDeg, 90, 1e-9);
    near(A.betaAngle(p, v, [0, 0, -1]).betaDeg, -90, 1e-9);
    near(A.betaAngle(p, v, [0, 1, 0]).betaDeg, 0, 1e-9);
    const b = A.betaAngle(p, v, [0, 1, 0]);
    near(b.criticalDeg, 69.75, 0.1, 'textbook ~70° at ISS altitude');
    assert.equal(b.eclipseFree, false);
    const hi = A.betaAngle(p, v, [0, Math.cos(75 * Math.PI / 180), Math.sin(75 * Math.PI / 180)]);
    near(hi.betaDeg, 75, 1e-9);
    assert.equal(hi.eclipseFree, true);
});

ok('subSatellite agrees with the column kernel\'s frame (Greenwich, 90°E, the poles, a random point)', () => {
    for (const p of [[1.1, 0, 0], [0, 0, -1.1], [0, 1.1, 0], [0, -1.1, 0], [0.7, 0.4, 0.55], [-0.3, -0.8, 0.5]]) {
        const mine = A.subSatellite(p);
        const rl = sceneToLatLon(p);
        near(mine.latDeg, rl.latDeg, 1e-9, `lat of ${p}`);
        const dl = ((mine.lonDeg - rl.lonDeg + 540) % 360) - 180;
        near(dl, 0, 1e-9, `lon of ${p}`);
    }
    near(A.subSatellite([1.1, 0, 0]).lonDeg, 0, 1e-12);
    near(A.subSatellite([0, 0, -1.1]).lonDeg, 90, 1e-12, '−Z is 90°E');
    near(A.subSatellite([0, 1.1, 0]).latDeg, 90, 1e-12);
    near(A.subSatellite([1.1, 0, 0]).altKm, 0.1 * 6371, 1e-9);
    near(len(A.subSatellite([0.7, 0.4, 0.55]).surface), 1, 1e-12);
});

ok('groundTrackSamples and nextShadowEvent on a circular orbit crossing the shadow', () => {
    // A 90-minute equatorial orbit in the x–y plane; the Sun at +x.
    const T = 5400e3, r = 1.066;
    const positionAt = (ms) => { const a = 2 * Math.PI * ms / T; return [r * Math.cos(a), r * Math.sin(a), 0]; };
    const g = A.groundTrackSamples({ positionAt, nowMs: 0, pastS: 600, futureS: 1200, stepS: 60 });
    assert.equal(g.past.length, 10); assert.equal(g.future.length, 20);
    for (const q of [...g.past, ...g.future]) near(len(q), 1.0015, 1e-12, 'on the surface sphere');
    // Past is in time order: the last past point is the one nearest now.
    const ang = (q) => Math.atan2(q[1], q[0]);
    assert.ok(ang(g.past[g.past.length - 1]) > ang(g.past[0]) || ang(g.past[0]) < 0);
    assert.ok(ang(g.future[0]) > 0 && ang(g.future[0]) < ang(g.future[1]));
    near(g.now.lonDeg, 0, 1e-12); near(g.now.latDeg, 0, 1e-12);
    // A propagator that fails ends that side.
    const g2 = A.groundTrackSamples({ positionAt: (ms) => (ms > 300e3 ? null : positionAt(ms)), nowMs: 0, pastS: 600, futureS: 1200, stepS: 60 });
    assert.equal(g2.future.length, 5); assert.equal(g2.past.length, 10);
    // Shadow: at angle 0 the craft is sunward; it enters the shadow near a = π − ρE.
    const ev = A.nextShadowEvent({ positionAt, nowMs: 0, sunDir: [1, 0, 0], stepS: 10, horizonS: 7200 });
    assert.equal(ev.kind, 'enter'); assert.equal(ev.from, 'sunlit');
    const expectS = (Math.PI - Math.asin(1 / r) - A.SUN_ANGULAR_RADIUS) / (2 * Math.PI) * 5400;
    near(ev.inS, expectS, 12, 'entry within a step of the geometry');
    // From inside the shadow the next event is the exit.
    const ev2 = A.nextShadowEvent({ positionAt, nowMs: T / 2, sunDir: [1, 0, 0], stepS: 10 });
    assert.equal(ev2.kind, 'exit');
    // Eclipse-free (Sun on the orbit normal): null.
    assert.equal(A.nextShadowEvent({ positionAt, nowMs: 0, sunDir: [0, 0, 1], stepS: 30 }), null);
});

ok('glint: 1 on the mirror direction, Gaussian off it, 0 unlit or back-facing; the tracking-array flare Sun', () => {
    const n = [0, 1, 0];
    const L = [Math.sin(0.5), Math.cos(0.5), 0];                 // 28.6° from the normal
    const R = [-Math.sin(0.5), Math.cos(0.5), 0];                // its mirror
    near(A.glint({ normal: n, sunDir: L, toCamera: R }).value, 1, 1e-12, 'on the mirror ray');
    const off = A.glint({ normal: n, sunDir: L, toCamera: [-Math.sin(0.5 + 0.03), Math.cos(0.5 + 0.03), 0], sigmaDeg: 1.5 });
    near(off.thetaDeg, 0.03 * 180 / Math.PI, 1e-9);
    near(off.value, Math.exp(-(off.thetaDeg ** 2) / 1.5 ** 2), 1e-12);
    assert.ok(A.glint({ normal: n, sunDir: L, toCamera: R, sigmaDeg: 0.5 }).value === 1 && off.value < 1);
    assert.equal(A.glint({ normal: n, sunDir: [0, -1, 0], toCamera: R }).value, 0, 'unlit face');
    assert.equal(A.glint({ normal: n, sunDir: L, toCamera: [0, -1, 0] }).value, 0, 'camera behind the face');
    assert.equal(A.glint({ normal: n, sunDir: L, toCamera: [1, 0.001, 0] }).value < 1e-6, true, 'far off the mirror ray');
    // A tracking array: the Sun at the camera mirrored in X makes the flare
    // land on the camera once the array has tracked.
    const vBody = [0.4, 0.5, 0.768];
    const sBody = A.trackingArrayFlareSun(vBody);
    near(len(sBody), 1, 1e-12);
    const alpha = A.arrayAlpha(sBody).alphaRad;
    const nTracked = [0, Math.cos(alpha), Math.sin(alpha)];
    near(A.glint({ normal: nTracked, sunDir: sBody, toCamera: vBody }).value, 1, 1e-9, 'flare on the camera');
    // The unmirrored Sun (the gate's negative control) does not.
    const nCtl = (() => { const a = A.arrayAlpha(vBody).alphaRad; return [0, Math.cos(a), Math.sin(a)]; })();
    assert.ok(A.glint({ normal: nCtl, sunDir: vBody, toCamera: vBody }).value < 1e-6);
});

console.log(`\n${passed} passed`);
