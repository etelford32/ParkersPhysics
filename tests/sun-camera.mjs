/**
 * tests/sun-camera.mjs — pins js/sun-camera.js (framing, flights, shots)
 *
 *   node tests/sun-camera.mjs
 *
 * The four rules in the kernel header are each asserted here, and the first
 * carries its NEGATIVE CONTROL: a Cartesian lerp between two poses on
 * opposite sides of the Sun (what sun.html's flyToRegion did) is shown to
 * pass through the photosphere, and the spherical flight is shown not to.
 */
import assert from 'node:assert/strict';
import {
    DEG, HERO_FOV_DEG, LEGACY_FOV_DEG, HERO_FILL, MIN_DISTANCE, MAX_DISTANCE_CORONAGRAPH,
    fitDistance, fillAt, equivalentDistance, safeFrame, heroFraming,
    sphToVec, vecToSph, shortAngle, makePose, poseFromCamera, posePosition, ease, lerpPose,
    sampleFlight, flightDuration, Flight, hop, hopSeconds,
    heroPose, approachShot, limbPanShot, flareShot, FLARE_FILL, FLARE_MIN_R, eruptionShot, ERUPTION_FILL, coronaShot, orbitShot, cinematicOrder, SHOT_TITLES,
} from '../js/sun-camera.js';
import { observerBasis, OFF_AXIS_FULL_DEG } from '../js/sun-offlimb.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
console.log('sun-camera.mjs');

ok('fitDistance is exact for a sphere and inverts fillAt', () => {
    for (const fov of [13, 30, 50]) for (const fill of [0.2, 0.6, 0.9]) {
        const d = fitDistance({ fovDeg: fov, fill });
        // Independent check: the silhouette half-angle is asin(1/d).
        assert.ok(near(Math.tan(Math.asin(1 / d)) / Math.tan(fov * DEG / 2), fill, 1e-12));
        assert.ok(near(fillAt({ fovDeg: fov, d }), fill, 1e-12));
    }
    // A bigger sphere needs proportionally more distance.
    assert.ok(near(fitDistance({ fovDeg: 30, fill: 0.5, radius: 6 }), 6 * fitDistance({ fovDeg: 30, fill: 0.5 }), 1e-9));
});

ok('the longer lens keeps the framing and hides less of the off-limb ring', () => {
    const dOld = 3.5, dNew = equivalentDistance(dOld, LEGACY_FOV_DEG, HERO_FOV_DEG);
    assert.ok(near(fillAt({ fovDeg: LEGACY_FOV_DEG, d: dOld }), fillAt({ fovDeg: HERO_FOV_DEG, d: dNew }), 1e-12));
    // The sphere's silhouette hides plane-of-sky radii below D/√(D²−1) (sun-offlimb.js KNOWN LIMIT).
    const hidden = (d) => d / Math.sqrt(d * d - 1) - 1;
    assert.ok(dNew > 5.5 && hidden(dNew) < 0.016 && hidden(dOld) > 0.04, `${dNew} ${hidden(dNew)} ${hidden(dOld)}`);
});

ok('safeFrame trims docked chrome, ignores a dialog, and never collapses', () => {
    const vp = { w: 1280, h: 720 };
    const s = safeFrame(vp, [
        { left: 0, top: 0, right: 1280, bottom: 82 },        // nav + status strip
        { left: 12, top: 94, right: 221, bottom: 394 },      // left info panel
        { left: 12, top: 558, right: 356, bottom: 720 },     // Sun Watch dock
        { left: 975, top: 94, right: 1268, bottom: 124 },    // right buttons
    ]);
    assert.equal(s.top, 124); assert.equal(s.right, 1280);
    assert.ok(s.left >= 221 && s.left <= 356, `left ${s.left}`);
    assert.ok(s.w > 800 && s.h > 400);
    assert.ok(near(s.offsetX, s.cx - 640) && near(s.offsetY, s.cy - 360));
    // A centred dialog must not move the Sun.
    const d = safeFrame(vp, [{ left: 400, top: 200, right: 880, bottom: 560 }]);
    assert.deepEqual([d.left, d.top, d.right, d.bottom], [0, 0, 1280, 720]);
    // A phone with a bottom sheet: the axis that collapsed gives back.
    const p = safeFrame({ w: 390, h: 760 }, [{ left: 0, top: 0, right: 390, bottom: 310 }, { left: 0, top: 500, right: 390, bottom: 760 }]);
    assert.equal(p.h, 760);
    // …and a sheet that covers the middle of the screen is a dialog: only the bar above it trims.
    const q = safeFrame({ w: 390, h: 760 }, [{ left: 0, top: 0, right: 390, bottom: 100 }, { left: 0, top: 240, right: 390, bottom: 760 }]);
    assert.deepEqual([q.top, q.bottom], [100, 760]);
    // No chrome ⇒ whole viewport, zero offset.
    const n = safeFrame(vp, []);
    assert.ok(n.offsetX === 0 && n.offsetY === 0 && n.w === 1280);
});

ok('heroFraming: the disc is HERO_FILL of the safe rectangle\'s shorter side', () => {
    const vp = { w: 1280, h: 720 };
    const s = safeFrame(vp, [{ left: 0, top: 0, right: 1280, bottom: 124 }, { left: 0, top: 124, right: 356, bottom: 720 }]);
    const h = heroFraming(vp, s);
    const diameterPx = 2 * fillAt({ fovDeg: h.fovDeg, d: h.distance }) * (vp.h / 2);
    assert.ok(near(diameterPx, HERO_FILL * Math.min(s.w, s.h), 1e-6), `${diameterPx}`);
    assert.ok(h.distance > MIN_DISTANCE);
});

ok('spherical ↔ Cartesian round-trips in the page\'s own convention', () => {
    // az is Stonyhurst longitude: +x is WEST; el is latitude; the Earth line is +z.
    assert.ok(near(sphToVec(0, 0, 6)[2], 6) && near(sphToVec(Math.PI / 2, 0, 1)[0], 1) && near(sphToVec(0, Math.PI / 2, 1)[1], 1));
    for (const [az, el, r] of [[0.3, 0.2, 5], [-2.9, -0.7, 1.4], [3.1, 1.2, 60]]) {
        const s = vecToSph(sphToVec(az, el, r));
        assert.ok(near(shortAngle(s.az, az), 0, 1e-12) && near(s.el, el, 1e-12) && near(s.r, r, 1e-9));
    }
    assert.ok(near(shortAngle(3.0, -3.0), 2 * Math.PI - 6, 1e-12));     // the short way crosses ±π
    const p = poseFromCamera([0, 0.6, 5.9], [0, 0, 0], 30);
    assert.ok(near(posePosition(p)[1], 0.6, 1e-12));
});

ok('RULE 1: a flight never dips below its nearer endpoint — and a Cartesian lerp does', () => {
    const a = makePose({ az: 0, el: 0.1, r: 3.0 }), b = makePose({ az: Math.PI * 0.94, el: -0.2, r: 3.2 });
    let minSph = Infinity, minCart = Infinity;
    const pa = posePosition(a), pb = posePosition(b);
    for (let i = 0; i <= 400; i++) {
        const u = i / 400;
        minSph = Math.min(minSph, lerpPose(a, b, u).r);
        minCart = Math.min(minCart, Math.hypot(...[0, 1, 2].map((k) => pa[k] + (pb[k] - pa[k]) * u)));
    }
    assert.ok(minSph >= 3.0 - 1e-9, `spherical min ${minSph}`);
    assert.ok(minCart < 1.0, `NEGATIVE CONTROL: the Cartesian path should pass through the Sun, min ${minCart}`);
    // log-r: the midpoint of a 3 → 48 pull-back is the geometric mean.
    assert.ok(near(lerpPose(makePose({ r: 3 }), makePose({ r: 48 }), 0.5).r, 12, 1e-9));
});

ok('RULES 2 + 3: a Flight is one-shot, time-based, ends exactly on its last pose, and cancels', () => {
    const a = makePose({ az: 0, r: 6 }), b = makePose({ az: 1, r: 3, target: [0.5, 0, 0], fov: 20 });
    const keys = hop(a, b, 2);
    assert.equal(flightDuration(keys), 2);
    const f = new Flight(keys, { startS: 100 });
    assert.deepEqual(f.sample(100).pose, a);
    const mid = f.sample(101);
    assert.ok(!mid.done && near(mid.progress, 0.5) && near(mid.pose.az, 0.5, 1e-12));     // smootherstep(½) = ½
    const end = f.sample(102);
    assert.ok(end.done && near(end.pose.az, 1) && near(end.pose.r, 3) && near(end.pose.fov, 20));
    assert.ok(f.sample(500).done);
    // Same instant ⇒ same pose, however many frames were drawn in between (no per-frame state).
    assert.deepEqual(new Flight(keys, { startS: 100 }).sample(100.7).pose, f.sample(100.7).pose);
    f.cancel();
    assert.deepEqual(f.sample(100.5), { pose: null, done: true, progress: 1 });
    // Ease has zero slope at both ends.
    assert.ok(ease(0) === 0 && ease(1) === 1 && (ease(1e-3) - ease(0)) / 1e-3 < 1e-4);
    assert.ok(hopSeconds(a, a) >= 1.1 && hopSeconds(a, makePose({ az: 3, r: 60 })) <= 4.5);
});

ok('every shot starts from the caller\'s pose, is strictly time-ordered, and stays outside the Sun', () => {
    const from = makePose({ az: 0.4, el: 0.1, r: 4, fov: 30 });
    const basis = observerBasis(0.08);
    const hero = heroPose({ b0Rad: 0.08, distance: 6.2 });
    const shots = {
        approach: approachShot(from, hero),
        limb: limbPanShot(from, { basis }),
        flare: flareShot(from, { site: sphToVec(0.5, 0.25, 1), earth: basis.normal, cls: 'X' }),
        corona: coronaShot(from, { b0Rad: 0.08 }),
        orbit: orbitShot(from, {}),
    };
    for (const [name, keys] of Object.entries(shots)) {
        assert.deepEqual(keys[0].pose, from, `${name} starts where the camera is`);
        for (let i = 1; i < keys.length; i++) assert.ok(keys[i].t > keys[i - 1].t, `${name} key ${i} time`);
        const T = flightDuration(keys);
        for (let i = 0; i <= 300; i++) {
            const p = sampleFlight(keys, T * i / 300);
            assert.ok(p.r >= MIN_DISTANCE - 1e-9 && p.r <= MAX_DISTANCE_CORONAGRAPH + 1e-9, `${name} r ${p.r}`);
            assert.ok(Number.isFinite(p.az + p.el + p.fov + p.target[0] + p.target[1] + p.target[2]), `${name} finite`);
            assert.ok(p.fov > 5 && p.fov < 60);
        }
        assert.ok(SHOT_TITLES[name], `${name} has a title`);
    }
    assert.deepEqual(shots.approach[shots.approach.length - 1].pose, hero);
});

ok('the limb pan stays where the observed ring is at full weight, and its target rides the limb', () => {
    const b0 = -0.1, basis = observerBasis(b0);
    const keys = limbPanShot(makePose({ r: 6, el: b0 }), { basis });
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (const k of keys.slice(1)) {
        const dir = sphToVec(k.pose.az, k.pose.el, 1);
        const sep = Math.acos(Math.min(1, dot(dir, basis.normal))) / DEG;
        assert.ok(sep < OFF_AXIS_FULL_DEG, `camera ${sep.toFixed(2)}° off the Sun–Earth line`);
        const t = k.pose.target;
        assert.ok(Math.abs(dot(t, basis.normal)) < 1e-9, 'target is in the plane of sky');
        assert.ok(near(Math.hypot(...t), 1.04, 1e-9), 'target is just above the limb');
    }
    // PA 90° is the EAST limb, which is −x on the sky.
    const east = limbPanShot(makePose({ r: 6 }), { basis: observerBasis(0), pa0: 90 * DEG, pa1: 91 * DEG });
    assert.ok(east[1].pose.target[0] < -1.0);
});

ok('the flare shot looks at the site from the Earth side, never past the Earth line', () => {
    const earth = observerBasis(0.05).normal;
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (const [lon, lat] of [[10, 5], [45, 20], [-70, -15], [88, 10], [0, 3]]) {
        const site = sphToVec(lon * DEG, lat * DEG, 1);
        const keys = flareShot(makePose({ r: 6 }), { site, earth, cls: 'M' });
        const arrive = keys[1].pose;
        const cam = sphToVec(arrive.az, arrive.el, 1);
        const sepSite = Math.acos(Math.min(1, dot(site, earth)));
        const camFromSite = Math.acos(Math.min(1, dot(cam, site)));
        const camFromEarth = Math.acos(Math.min(1, dot(cam, earth)));
        assert.ok(camFromSite > 4 * DEG, `oblique, not straight down (${lon},${lat})`);
        assert.ok(camFromSite <= 52 * DEG + 1e-9);
        if (sepSite > 6 * DEG) assert.ok(camFromEarth <= sepSite + 1e-9, `(${lon},${lat}) camera is between the site and Earth`);
        assert.ok(near(Math.hypot(...arrive.target), 1.012, 1e-9) && dot(arrive.target, site) > 1.0);
    }
    const x = flareShot(makePose({ r: 6 }), { site: sphToVec(0.5, 0.2, 1), earth, cls: 'X' })[1].pose;
    const c = flareShot(makePose({ r: 6 }), { site: sphToVec(0.5, 0.2, 1), earth, cls: 'C' })[1].pose;
    assert.ok(x.r > c.r, 'a bigger flare is framed wider');
});

ok('with the flare\'s own length the shot is DERIVED: that length fills FLARE_FILL of the frame', () => {
    const earth = observerBasis(0.05).normal;
    const site = sphToVec(30 * DEG, 12 * DEG, 1);
    const frac = (pose, len) => {
        const cam = posePosition(pose);
        const D = Math.hypot(cam[0] - pose.target[0], cam[1] - pose.target[1], cam[2] - pose.target[2]);
        return len / (2 * D * Math.tan(pose.fov * DEG / 2));
    };
    for (const [cls, len] of [['X', 0.2185], ['M', 0.1615]]) {
        const p = flareShot(makePose({ r: 6 }), { site, earth, cls, length: len })[1].pose;
        assert.ok(near(frac(p, len), FLARE_FILL, 1e-9), `${cls}: ${frac(p, len)}`);
        // NEGATIVE CONTROL — the typed distance framed a real-size flare at a fraction of that.
        const legacy = flareShot(makePose({ r: 6 }), { site, earth, cls })[1].pose;
        assert.ok(frac(legacy, len) < 0.75 * FLARE_FILL, `${cls} legacy fill ${frac(legacy, len)}`);
    }
    // A small flare at the limb would put the camera in the arcade: it is held off.
    const limb = flareShot(makePose({ r: 6 }), { site: sphToVec(85 * DEG, 5 * DEG, 1), earth, cls: 'C', length: 0.114 });
    assert.ok(limb[1].pose.r >= FLARE_MIN_R - 1e-12 && limb[2].pose.r >= MIN_DISTANCE);
});

ok('the corona pull-back distances are derived from the lens and the instruments\' reach', () => {
    const keys = coronaShot(makePose({ r: 6 }), { fov: 30, c2Reach: 6, c3Reach: 30, fill: 0.86 });
    const d2 = keys[1].pose.r, d3 = keys[keys.length - 1].pose.r;
    assert.ok(near(fillAt({ fovDeg: 30, d: d2, radius: 6 }), 0.86, 1e-9));
    assert.ok(near(fillAt({ fovDeg: 30, d: d3, radius: 30 }), 0.86, 1e-9));
    assert.ok(d3 <= MAX_DISTANCE_CORONAGRAPH);
});

ok('the running order skips shots whose subject is absent', () => {
    assert.deepEqual(cinematicOrder({}), ['approach', 'orbit']);
    assert.deepEqual(cinematicOrder({ offLimb: true, coronagraph: true, flare: true }), ['approach', 'flare', 'limb', 'orbit', 'corona']);
});

ok('the eruption shot pulls back WITH the rope: the surface-to-apex span holds ERUPTION_FILL, never runs ahead, then returns', () => {
    const earth = observerBasis(0.05).normal, site = sphToVec(30 * DEG, 12 * DEG, 1), from = makePose({ r: 6 });
    const length = 0.2185, fadeR = 2.5;
    // A rope that sits for 6 s, then climbs at 0.12 R☉ per second.
    const apexAt = (s) => 1.045 + Math.max(0, s - 6) * 0.12;
    const keys = eruptionShot(from, { site, earth, cls: 'X', length, apexAt, maxApexR: fadeR });
    const close0 = flareShot(from, { site, earth, cls: 'X', length });
    assert.deepEqual(keys[0].pose, from); assert.deepEqual(keys[1].pose, close0[1].pose, 'it arrives on the flare close-up');
    for (let i = 1; i < keys.length; i++) assert.ok(keys[i].t > keys[i - 1].t, `key ${i} time`);
    const follow = keys.slice(3, -1);          // after: where it was, the close-up, the hold
    assert.ok(follow.length > 8, `${follow.length} follow keys`);
    const dist = (p) => { const c = posePosition(p); return Math.hypot(c[0] - p.target[0], c[1] - p.target[1], c[2] - p.target[2]); };
    let rPrev = 0, held = 0;
    for (const k of follow) {
        assert.ok(k.pose.r >= rPrev - 1e-12, 'the camera never moves IN during the eruption'); rPrev = k.pose.r;
        const h = Math.min(fadeR, apexAt(k.t)) - 1;
        const fill = h / (2 * dist(k.pose) * Math.tan(k.pose.fov * DEG / 2));
        assert.ok(fill <= ERUPTION_FILL + 1e-9, `the rope never outgrows the frame (fill ${fill.toFixed(3)} at t=${k.t.toFixed(1)})`);
        // Once the rope is taller than the close-up can hold, the camera–target distance is exactly the one that keeps the fill.
        if (dist(k.pose) > dist(keys[1].pose) + 1e-6) { assert.ok(near(fill, ERUPTION_FILL, 1e-9), `while pulling back the span is held at ERUPTION_FILL (${fill})`); held++; }
        assert.ok(near(Math.hypot(...k.pose.target), 1.012 + 0.5 * h, 1e-9), 'it looks at the middle of the span');
        assert.ok(k.pose.r <= MAX_DISTANCE_CORONAGRAPH);
    }
    assert.ok(held > 5, 'the pull-back is actually exercised');
    // It stops following where the rope has faded, and comes back down to the arcade.
    assert.ok(apexAt(follow[follow.length - 1].t) >= fadeR - 1e-9, 'the follow ends when the apex reaches maxApexR');
    assert.deepEqual(keys[keys.length - 1].pose, flareShot(from, { site, earth, cls: 'X', length, seconds: 3 })[2].pose, 'it ends on the flare shot\'s settled close-up');
    // The whole flight stays outside the Sun.
    const T = flightDuration(keys);
    for (let i = 0; i <= 300; i++) { const p = sampleFlight(keys, T * i / 300); assert.ok(p.r >= MIN_DISTANCE - 1e-9 && Number.isFinite(p.r + p.az + p.el)); }
    // NEGATIVE CONTROL: a rope that never rises is never followed out — the camera stays at the close-up distance.
    const still = eruptionShot(from, { site, earth, cls: 'X', length, apexAt: () => 1.045, maxApexR: fadeR, seconds: 20 });
    assert.ok(still.slice(3, -1).every((k) => near(dist(k.pose), dist(still[1].pose), 1e-9)), 'no rise, no pull-back: the camera stays the close-up\'s distance from what it looks at');
});

console.log(`${passed} checks passed (sun-camera)`);
