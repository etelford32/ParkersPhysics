/**
 * upper-atmosphere-sat-view.mjs — the close-up's geometry
 * ═══════════════════════════════════════════════════════════════════════════
 * js/upper-atmosphere-sat-view.js is PURE. Pins:
 *   • the LVLH basis is orthonormal and right-handed (along × cross = up),
 *     along is the velocity with its radial part removed, and a degenerate
 *     velocity still gives a frame;
 *   • the default chase pose stands BEHIND the target (eye − pos against
 *     the velocity) and ABOVE the orbit plane, at exactly `dist`, looking
 *     at the target with up = radial; chaseFromEye inverts it (round trip)
 *     so a chase can start exactly where a fly-in left the camera;
 *   • the zoom ladder is logarithmic and clamped; a drag wraps az and
 *     clamps el; the ease factor is frame-rate independent;
 *   • the model holds its angular size below MODEL_REF_R (span/dist is
 *     constant there) and is its artistic size beyond; floored;
 *   • the near plane is the globe's own rule when there is no chase and
 *     tightens to 0.2 × the chase range when there is, never below 2e-4;
 *   • the altitude tour: next higher / next lower, ties and self skipped,
 *     wraps at both ends, null on an empty list;
 *   • model families from catalogue strings.
 *
 * Run: node tests/upper-atmosphere-sat-view.mjs
 */
import assert from 'node:assert/strict';
import * as V from '../js/upper-atmosphere-sat-view.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} vs ${b}`);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

console.log('upper-atmosphere-sat-view');

// A 400 km circular orbit point at 51.6°, moving roughly east-north.
const R = 1 + 420 / 6371;
const pos = [R * 0.6, R * 0.5, -R * Math.sqrt(1 - 0.36 - 0.25)];
const vel = [-0.0004, 0.0009, 0.0007];   // R⊕/s (not tangent on purpose: the basis removes the radial part)

ok('LVLH basis: orthonormal, right-handed, along ⟂ radial, degenerate velocity still framed', () => {
    const b = V.lvlhBasis(pos, vel);
    for (const v of [b.up, b.along, b.cross]) near(len(v), 1, 1e-12, 'unit');
    near(dot(b.up, b.along), 0, 1e-12); near(dot(b.up, b.cross), 0, 1e-12); near(dot(b.along, b.cross), 0, 1e-12);
    // along × cross = up
    const c = [b.along[1] * b.cross[2] - b.along[2] * b.cross[1], b.along[2] * b.cross[0] - b.along[0] * b.cross[2], b.along[0] * b.cross[1] - b.along[1] * b.cross[0]];
    near(dot(c, b.up), 1, 1e-12, 'handedness');
    // along is the velocity's tangential part
    const vt = sub(vel, b.up.map((u) => u * dot(vel, b.up)));
    near(dot(b.along, vt) / len(vt), 1, 1e-12, 'along ∥ tangential v');
    // zero / radial velocity: still a frame
    const b0 = V.lvlhBasis(pos, [0, 0, 0]);
    const br = V.lvlhBasis(pos, pos.map((x) => x * 3));
    for (const b of [b0, br]) { near(len(b.along), 1, 1e-12); near(dot(b.along, b.up), 0, 1e-12); }
    near(len(V.lvlhBasis([0, 2, 0], [0, 0, 0]).along), 1, 1e-12, 'polar position');
});

ok('chase pose: behind and above at exactly dist, up = radial; chaseFromEye round-trips', () => {
    const p = V.chasePose({ pos, vel, dist: 0.03 });
    const off = sub(p.eye, p.target);
    near(len(off), 0.03, 1e-12, 'distance exact');
    assert.ok(dot(off, p.basis.along) < 0, 'behind: against the velocity');
    assert.ok(dot(off, p.basis.up) > 0, 'above the orbit plane');
    near(dot(off, p.basis.cross), 0, 1e-12, 'in the orbit plane at az = π');
    near(dot(off, p.basis.up) / 0.03, Math.sin(V.CHASE.elDefault), 1e-12, 'elevation');
    assert.deepEqual(p.up, p.basis.up);
    assert.deepEqual(p.target, pos);
    // Round trip, including an off-axis pose.
    for (const q of [{ az: Math.PI, el: 0.32, dist: 0.03 }, { az: 0.7, el: -0.4, dist: 0.2 }, { az: -2.5, el: 1.1, dist: 0.002 }]) {
        const e = V.chasePose({ pos, vel, ...q }).eye;
        const back = V.chaseFromEye(e, pos, vel);
        near(back.dist, q.dist, 1e-12); near(back.el, q.el, 1e-9);
        near(Math.atan2(Math.sin(back.az - q.az), Math.cos(back.az - q.az)), 0, 1e-9, 'az');
    }
    // An eye ON the target: defaults, at the minimum range.
    const z = V.chaseFromEye(pos, pos, vel);
    assert.deepEqual([z.az, z.el, z.dist], [V.CHASE.azDefault, V.CHASE.elDefault, V.CHASE.minR]);
    // Out-of-range eyes clamp into the ladder.
    assert.equal(V.chaseFromEye(pos.map((x) => x * 3), pos, vel).dist, V.CHASE.maxR);
});

ok('zoom is logarithmic and clamped; drag wraps az and clamps el; ease is dt-aware', () => {
    const d1 = V.zoomDistance(0.03, 1), d2 = V.zoomDistance(d1, 1);
    near(d1 / 0.03, d2 / d1, 1e-12, 'same ratio per notch');
    near(d1, 0.03 / V.CHASE.zoomNotch, 1e-12);
    assert.equal(V.zoomDistance(0.03, 100), V.CHASE.minR);
    assert.equal(V.zoomDistance(0.03, -100), V.CHASE.maxR);
    assert.equal(V.scaleDistance(0.03, 0), 0.03);
    near(V.scaleDistance(0.03, 0.82), 0.0246, 1e-12);
    const o = V.orbitBy(3.0, 1.0, -100, 100);
    assert.ok(o.az > -Math.PI && o.az <= Math.PI, 'az wrapped');
    near(o.az, 3.0 + 100 * V.CHASE.dragSens - 2 * Math.PI, 1e-12);
    assert.equal(o.el, V.CHASE.elMax);
    assert.equal(V.orbitBy(0, 0, 0, -1e6).el, V.CHASE.elMin);
    near(V.easeK(0.1, 0.1), 1 - Math.exp(-1), 1e-12);
    assert.equal(V.easeK(0, 0.1), 0);
    near(V.easeK(0.05, 0.1) + (1 - V.easeK(0.05, 0.1)) * V.easeK(0.05, 0.1), V.easeK(0.1, 0.1), 1e-12, 'two half steps = one step');
    near(V.angleTowards(3.0, -3.0, 1), 3.0 + (2 * Math.PI - 6.0), 1e-12, 'shortest way round');
});

ok('the model holds its angular size inside MODEL_REF_R and is artistic-size beyond; floored', () => {
    assert.equal(V.modelScale(0.5), 1);
    assert.equal(V.modelScale(V.MODEL_REF_R), 1);
    const span = 0.04;
    const a = span * V.modelScale(0.04) / 0.04, b = span * V.modelScale(0.004) / 0.004;
    near(a, b, 1e-12, 'constant span/dist below the reference');
    assert.equal(V.modelScale(1e-9), V.MODEL_MIN_SCALE);
    assert.equal(V.modelScale(NaN), 1);
});

ok('near plane: the globe\'s rule alone, tightened by the chase range, floored at 2e-4', () => {
    near(V.nearPlaneFor(2.2), 0.01, 1e-15);            // orbit view: the old 0.01 exactly
    near(V.nearPlaneFor(0.02), 0.005, 1e-15);          // 127 km up: 0.25 × altitude
    near(V.nearPlaneFor(0.001), 0.002, 1e-15);         // the floor without a chase
    near(V.nearPlaneFor(0.066, 0.0015), 3e-4, 1e-15);  // 10 km behind a station: 0.2 × range
    near(V.nearPlaneFor(0.066, 1e-6), 2e-4, 1e-15);    // the chase floor
    near(V.nearPlaneFor(0.066, 0.5), 0.01, 1e-15);     // a wide chase changes nothing
});

ok('altitude tour: next higher / lower, self and ties skipped, wraps, null when empty', () => {
    const list = [{ id: 'a', altKm: 420 }, { id: 'b', altKm: 550 }, { id: 'c', altKm: 550 }, { id: 'd', altKm: 780 }, { id: 'e', altKm: 35786 }];
    assert.equal(V.altitudeNeighbour(list, { id: 'a', altKm: 420 }, 1).id, 'b');
    assert.equal(V.altitudeNeighbour(list, { id: 'b', altKm: 550 }, 1).id, 'd');       // the tie is not "higher"
    assert.equal(V.altitudeNeighbour(list, { id: 'd', altKm: 780 }, -1).altKm, 550);
    assert.equal(V.altitudeNeighbour(list, { id: 'e', altKm: 35786 }, 1).id, 'a');     // wrap to the lowest
    assert.equal(V.altitudeNeighbour(list, { id: 'a', altKm: 420 }, -1).id, 'e');      // wrap to the highest
    assert.equal(V.altitudeNeighbour(list, { id: null, altKm: 600 }, 1).id, 'd');       // no current id
    assert.equal(V.altitudeNeighbour([], {}, 1), null);
    assert.equal(V.altitudeNeighbour([{ id: 'x', altKm: NaN }], {}, 1), null);
});

ok('fly-in duration is log in distance and bounded; speed; model families', () => {
    assert.equal(V.flyInDuration(0), 0.9);
    assert.ok(V.flyInDuration(0.5) > V.flyInDuration(0.05));
    assert.equal(V.flyInDuration(1e9), 2.2);
    near(V.speedKmS([0.001, 0, 0]), 6.371, 1e-12);
    assert.equal(V.modelFamily({ noradId: 25544, name: 'ISS (ZARYA)', group: 'stations' }), 'iss');
    assert.equal(V.modelFamily({ noradId: 20580, name: 'HST', group: 'science' }), 'hubble');
    assert.equal(V.modelFamily({ name: 'STARLINK-30321', group: 'starlink' }), 'starlink');
    assert.equal(V.modelFamily({ name: 'CZ-2D R/B', group: 'active' }), 'rocket');
    assert.equal(V.modelFamily({ name: 'FENGYUN 1C DEB', group: 'fengyun-1c-debris' }), 'debris');
    assert.equal(V.modelFamily({ name: 'ONEWEB-0012', group: 'oneweb' }), 'iridium');
    assert.equal(V.modelFamily({ name: 'TIANGONG', group: 'stations' }), 'iss');
    assert.equal(V.modelFamily({ name: 'LANDSAT 9', group: 'resource' }), 'generic');
    assert.equal(V.modelFamily({}), 'generic');
    for (const f of ['iss', 'hubble', 'starlink', 'iridium', 'rocket', 'debris', 'generic']) assert.ok(V.TRUE_SPAN_M[f] > 0, f);
});

ok('the safe frame: docks wall off their side, a too-small box falls back to the stage', () => {
    const stage = { w: 1000, h: 700 };
    const docks = [
        { x: 640, y: 12, w: 348, h: 460 },     // the camera dock, right
        { x: 12, y: 500, w: 420, h: 110 },     // the render dock, bottom-left
        { x: 12, y: 630, w: 976, h: 58 },      // the time dock, bottom
        { x: 12, y: 12, w: 60, h: 440 },       // the altitude column, left
    ];
    const c = V.safeCentre(stage, docks);
    assert.deepEqual(c.box, { left: 72, right: 640, top: 0, bottom: 500 });
    assert.deepEqual([c.cx, c.cy], [356, 250]);
    // Nothing over the stage: the centre.
    assert.deepEqual([V.safeCentre(stage, []).cx, V.safeCentre(stage, []).cy], [500, 350]);
    // A phone where the camera dock spans the width: it is a top band; the
    // horizontal box is the whole width; the vertical holds.
    const phone = V.safeCentre({ w: 390, h: 700 }, [{ x: 12, y: 12, w: 366, h: 300 }, { x: 0, y: 600, w: 390, h: 100 }]);
    assert.deepEqual(phone.box, { left: 0, right: 390, top: 312, bottom: 600 });
    // A narrow strip (the 742 px stage: column to 131, dock from 371 = 240 px,
    // under the floor) is widened ABOUT ITS CENTRE, not abandoned: the centre
    // stays at 251, left of the dock (the old fallback put it ON the dock's edge).
    const strip = V.safeCentre({ w: 742, h: 720 }, [{ x: 371, y: 13, w: 360, h: 268 }, { x: 13, y: 497, w: 718, h: 118 }, { x: 13, y: 15, w: 118, h: 468 }]);
    assert.equal(strip.cx, 251);
    near(strip.box.right - strip.box.left, 0.35 * 742, 1e-9);
    // Two side docks leaving a 100 px strip: widened to the floor about 510.
    const two = V.safeCentre({ w: 1000, h: 700 }, [{ x: 560, y: 0, w: 400, h: 700 }, { x: 0, y: 0, w: 460, h: 700 }]);
    assert.deepEqual([two.box.left, two.box.right, two.cx], [335, 685, 510]);
    // Degenerate rects are ignored.
    assert.deepEqual(V.safeCentre(stage, [null, { x: 0, y: 0, w: 0, h: 0 }]).box, { left: 0, right: 1000, top: 0, bottom: 700 });
});

ok('the arc flight: exact ends, never through the planet, lifted by the angle, straight for a local hop', () => {
    const R = 1 + 550 / 6371;
    const p0 = [R, 0, 0], p1 = [-R * 0.9, 0.1, 0.05];      // nearly opposite sides of the shell
    const sp = V.arcSpec(p0, p1, [R - 0.03, 0, 0], [-R * 0.88, 0.1, 0.05]);
    assert.equal(sp.straight, false);
    assert.deepEqual(V.arcAt(sp, 0).eye, p0);
    assert.deepEqual(V.arcAt(sp, 1).eye, p1);
    let minR = Infinity, maxR = 0;
    for (let i = 0; i <= 200; i++) { const r = len(V.arcAt(sp, i / 200).eye); minR = Math.min(minR, r); maxR = Math.max(maxR, r); }
    assert.ok(minR >= Math.min(sp.r0, sp.r1) - 1e-9, 'never below the lower end: ' + minR);
    near(maxR, (sp.r0 + sp.r1) / 2 + sp.bulge, 0.02, 'lifted by the bulge');
    assert.ok(sp.bulge > 0.9 && sp.bulge < 1.2, 'a ~180° hop pulls out ~1.1 R⊕');
    // The look point sweeps too and stays near the shell.
    const mid = V.arcAt(sp, 0.5);
    near(len(mid.look), (sp.lr0 + sp.lr1) / 2, 1e-9);
    // Exactly antipodal still has a path.
    const anti = V.arcSpec([R, 0, 0], [-R, 0, 0], [R, 0, 0], [-R, 0, 0]);
    assert.ok(Number.isFinite(V.arcAt(anti, 0.5).eye[0]) && len(V.arcAt(anti, 0.5).eye) > R);
    // A local hop (1°) is the plain lerp — no loop.
    const q1 = [R * Math.cos(0.017), R * Math.sin(0.017), 0];
    const loc = V.arcSpec(p0, q1, p0, q1);
    assert.equal(loc.straight, true);
    assert.equal(loc.bulge, 0);
    near(len(V.arcAt(loc, 0.5).eye), R * Math.cos(0.0085), 1e-9, 'the chord');
    assert.ok(sp.length > loc.length);
});

console.log(`\n${passed} passed`);
