/**
 * tests/upper-atmosphere-camera-rig.mjs — gate for the camera-rig kernel
 *   node tests/upper-atmosphere-camera-rig.mjs
 *
 * What is pinned: the lens numbers mean what they say; pan and swivel never
 * carry the pivot out of bounds and a swivel never moves the picture
 * sideways; keyboard orbit holds range and clamps at the axis; and every
 * limb view frames what it claims — the band top, the band bottom AND the
 * ground limb inside the frame, the band filling at least the stated
 * fraction of it, the site ON the camera's limb, and a level horizon.
 */
import assert from 'node:assert/strict';
import {
    RIG, DRAG_TOOLS, rigVec, clampFov, focalLengthMm, fovForFocalMm, frameHeightAt,
    pivotLimit, clampPivot, liftAboveSurface, panPivot, swivelTarget, polarAngle,
    orbitAround, dollyToward, limbSites, limbCameraAltKm, tangentElevation, limbViewPose, describeRig,
} from '../js/upper-atmosphere-camera-rig.js';
import { latLonToScene, R_EARTH_KM } from '../js/upper-atmosphere-column.js';
import { ATMOSPHERIC_LAYER_SCHEMA } from '../js/upper-atmosphere-layers.js';
import { pointsOfInterest } from '../js/upper-atmosphere-explore-model.js';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const { dot, sub, len, norm, cross } = rigVec;
const DEG = Math.PI / 180;
const angDeg = (a, b) => { const A = norm(a), B = norm(b); return Math.atan2(len(cross(A, B)), dot(A, B)) / DEG; };

console.log('\n── lens ──');

t('focal length is the 35 mm equivalent of the VERTICAL fov and inverts', () => {
    near(focalLengthMm(2 * Math.atan(12 / 50) / DEG), 50, 1e-9, '50 mm');
    near(focalLengthMm(40), 12 / Math.tan(20 * DEG), 1e-12);
    for (const f of [3, 10, 40, 75]) near(fovForFocalMm(focalLengthMm(f)), f, 1e-9, `fov ${f}`);
    assert.equal(clampFov(0.1), RIG.fovMinDeg);
    assert.equal(clampFov(170), RIG.fovMaxDeg);
    assert.equal(clampFov('x'), RIG.fovDefaultDeg);
    near(frameHeightAt(2, 90), 4, 1e-12, 'a 90° frame at range 2 is 4 tall');
    assert.deepEqual([...DRAG_TOOLS], ['orbit', 'pan', 'swivel']);
});

console.log('\n── pivot bound, pan, swivel ──');

t('the pivot bound is the rig limit, or just past the camera', () => {
    near(pivotLimit([0, 0, 3.2]), RIG.pivotLimitRe, 1e-12);
    near(pivotLimit([0, 0, 20]), 20 + RIG.pivotMarginRe, 1e-12);
    const c = clampPivot({ position: [0, 0, 3], target: [9, 0, 0] });
    assert.equal(c.shifted, true);
    near(len(c.target), RIG.pivotLimitRe, 1e-12, 'pivot pulled back to the bound');
    // Camera and pivot move by the SAME vector — the view does not rotate.
    near(angDeg(sub(c.target, c.position), sub([9, 0, 0], [0, 0, 3])), 0, 1e-9);
    const inside = clampPivot({ position: [0, 0, 3], target: [1, 1, 1] });
    assert.equal(inside.shifted, false);
});

t('a pan of one frame height moves the pivot by the frame height at its depth, and cannot escape', () => {
    const pos = [0, 0, 3.2], tgt = [0, 0, 0];
    const out = panPivot({ position: pos, target: tgt, right: [1, 0, 0], screenUp: [0, 1, 0], dxFrac: 0.25, fovDeg: 40 });
    near(out.target[0], 0.25 * frameHeightAt(3.2, 40), 1e-12);
    near(out.position[0] - pos[0], out.target[0] - tgt[0], 1e-12, 'camera rides with the pivot');
    let s = { position: pos, target: tgt };
    for (let i = 0; i < 400; i++) s = panPivot({ ...s, right: [1, 0, 0], screenUp: [0, 1, 0], dxFrac: 0.5, fovDeg: 40 });
    assert.ok(len(s.target) <= pivotLimit(s.position) + 1e-9, `pivot ${len(s.target)} escaped`);
});

t('swivel turns the sightline about the camera: right is right, up is up, camera fixed', () => {
    const pos = [0, 0, 3], tgt = [0, 0, 0], up = [0, 1, 0];
    const r = swivelTarget({ position: pos, target: tgt, up, yawRad: 10 * DEG });
    const f = norm(sub(r, pos));
    // Looking −Z with +Y up, right is +X.
    assert.ok(f[0] > 0, `turned right (fx ${f[0]})`);
    near(angDeg(f, [0, 0, -1]), 10, 1e-9, 'by exactly the yaw');
    const u = swivelTarget({ position: pos, target: tgt, up, pitchRad: 7 * DEG });
    const fu = norm(sub(u, pos));
    assert.ok(fu[1] > 0, 'pitched up');
    near(angDeg(fu, [0, 0, -1]), 7, 1e-9);
    near(len(sub(u, pos)), 3, 1e-12, 'range kept when the bound allows');
    // Never flips through the zenith.
    const z = swivelTarget({ position: pos, target: tgt, up, pitchRad: 3 });
    assert.ok(angDeg(sub(z, pos), up) >= RIG.polarMinRad / DEG - 1e-9, 'clamped short of the zenith');
});

t('a swivel that would push the pivot out of bounds SHORTENS it along the sightline (no sideways jump)', () => {
    const pos = [0, 0, 5.5], tgt = [0, 0, 0], up = [0, 1, 0];
    // Turn round to look away from Earth: at range 5.5 the pivot would sit at r = 11.
    const r = swivelTarget({ position: pos, target: tgt, up, yawRad: Math.PI });
    const f = norm(sub(r, pos));
    near(angDeg(f, [0, 0, 1]), 0, 1e-6, 'looking straight out');
    assert.ok(len(r) <= pivotLimit(pos) + 1e-9, `pivot ${len(r)} within ${pivotLimit(pos)}`);
    near(angDeg(sub(r, pos), f), 0, 1e-9, 'pivot on the new sightline');
});

console.log('\n── keyboard orbit, dolly, floor ──');

t('orbitAround holds range, turns about the axis, and clamps at the poles', () => {
    const pos = [0, 0, 3], tgt = [0, 0, 0], up = [0, 1, 0];
    const a = orbitAround({ position: pos, target: tgt, up, dAzRad: 30 * DEG });
    near(len(a), 3, 1e-12);
    near(angDeg(a, pos), 30, 1e-9);
    near(a[1], 0, 1e-12, 'azimuth only');
    const p = orbitAround({ position: pos, target: tgt, up, dPolarRad: -10 });
    near(polarAngle(p, tgt, up), RIG.polarMinRad, 1e-9, 'clamped at the pole');
    // About an off-centre pivot with a tilted up (a limb view's orbit frame).
    const up2 = norm([1, 1, 0]), tg2 = [0.7, 0.7, 0], ps2 = [0.7, 0.7, 0.5];
    const b = orbitAround({ position: ps2, target: tg2, up: up2, dAzRad: 1.0 });
    near(len(sub(b, tg2)), 0.5, 1e-12, 'range about the pivot');
    near(dot(sub(b, tg2), up2), dot(sub(ps2, tg2), up2), 1e-12, 'height along the axis kept');
});

t('dolly clamps and the surface floor lifts radially', () => {
    const d = dollyToward({ position: [0, 0, 3], target: [0, 0, 0], factor: 0.5 });
    near(d[2], 1.5, 1e-12);
    const c = dollyToward({ position: [0, 0, 3], target: [0, 0, 0], factor: 100, maxDist: 28 });
    near(c[2], 28, 1e-12);
    const f = liftAboveSurface([0.5, 0, 0]);
    near(len(f), RIG.surfaceFloorRe, 1e-12);
    near(angDeg(f, [1, 0, 0]), 0, 1e-12);
    assert.deepEqual(liftAboveSurface([0, 0, 2]), [0, 0, 2]);
});

console.log('\n── limb views ──');

const ssp = { subSolarLatDeg: 9.5, subSolarLonDeg: -37 };
const pois = pointsOfInterest({ ...ssp, f107Sfu: 150, ap: 27 });
const sites = limbSites({ ...ssp, pois });

t('limb sites: four local times from the sub-solar point, three from the model', () => {
    const ids = sites.map((s) => s.id);
    for (const id of ['noon', 'dusk', 'midnight', 'dawn', 'bulge', 'trough', 'aurora']) assert.ok(ids.includes(id), id);
    const by = Object.fromEntries(sites.map((s) => [s.id, s]));
    near(by.noon.lonDeg, -37, 1e-9);
    near(by.dusk.lonDeg, 53, 1e-9, 'dusk is 90° EAST of noon');
    near(by.dawn.lonDeg, -127, 1e-9);
    near(Math.abs(by.midnight.lonDeg), 143, 1e-9);
    const poi = pois.find((p) => p.id === 'aurora');
    near(by.aurora.latDeg, poi.latDeg, 1e-12, 'aurora site IS the model POI');
    // Without POIs only the four local-time sites exist — nothing is invented.
    assert.equal(limbSites(ssp).length, 4);
});

const bands = [
    ...ATMOSPHERIC_LAYER_SCHEMA.map((L) => ({ id: L.id, minKm: L.minKm, maxKm: L.maxKm })),
    { id: 'whole', minKm: 80, maxKm: 2000 },
];

t('every layer at every site: band top, bottom and the ground limb are in the USABLE frame (above the chrome); the band fills its share', () => {
    const R = RIG.limbReserveBottom;
    for (const s of sites) {
        for (const b of bands) {
            const v = limbViewPose({ latDeg: s.latDeg, lonDeg: s.lonDeg, minKm: b.minKm, maxKm: b.maxKm });
            const F = v.fovDeg * DEG;
            const e = v.elevations;
            const lo = e.centre - 0.5 * F + R * F, hi = e.centre + 0.5 * F;   // the usable strip
            for (const [k, el] of [['top', e.top], ['bottom', e.bottom], ['ground', e.ground]]) {
                assert.ok(el > lo && el < hi, `${s.id}/${b.id}: ${k} outside the usable frame (${(el / DEG).toFixed(2)}° vs [${(lo / DEG).toFixed(2)}, ${(hi / DEG).toFixed(2)}])`);
            }
            // The band fills the stated share of the usable frame unless holding
            // the ground in view needs a wider lens (then band + ground + 18 %).
            const share = (e.top - e.bottom) / ((1 - R) * F);
            const expected = Math.min(RIG.limbFill, (e.top - e.bottom) / ((e.top - Math.min(e.ground, e.bottom)) * 1.18));
            if (v.fovDeg > RIG.fovMinDeg + 1e-9) near(share, expected, 1e-9, `${s.id}/${b.id}: band share`);
            assert.ok(share > 0.33, `${s.id}/${b.id}: band only ${share.toFixed(2)} of the usable frame`);
            assert.ok(v.fovDeg >= RIG.fovMinDeg && v.fovDeg <= RIG.fovMaxDeg);
        }
    }
    // Without the reserve the content is centred in the whole frame.
    const v0 = limbViewPose({ latDeg: 0, lonDeg: 0, minKm: 250, maxKm: 600, reserveBottom: 0 });
    near(v0.elevations.centre, 0.5 * (v0.elevations.top + Math.min(v0.elevations.ground, v0.elevations.bottom)), 1e-12);
});

t('a limb view stands ABOVE the band, puts the site ON its limb at mid-height, and levels the horizon', () => {
    for (const s of sites) {
        for (const b of bands) {
            const v = limbViewPose({ latDeg: s.latDeg, lonDeg: s.lonDeg, minKm: b.minKm, maxKm: b.maxKm });
            const P = latLonToScene(s.latDeg, s.lonDeg);
            near(angDeg(v.up, P), 0, 1e-9, 'up is the site radial');
            const alt = (len(v.position) - 1) * R_EARTH_KM;
            near(alt, limbCameraAltKm(b.maxKm), 1e-6, `${b.id}: camera altitude`);
            assert.ok(alt > b.maxKm, `${b.id}: camera above the band it frames (${alt.toFixed(0)} km)`);
            // On the tangent line of the mid-height sphere at P ⇒ the site is on the limb at mid-height.
            const rMid = 1 + 0.5 * (b.minKm + b.maxKm) / R_EARTH_KM;
            near(dot(v.position, P), rMid, 1e-12, 'camera in the tangent plane at the mid-height');
            const right = norm(cross(v.forward, v.up));
            near(dot(right, P), 0, 1e-12, 'right ⟂ local vertical (level limb)');
            near(angDeg(sub(v.target, v.position), v.forward), 0, 1e-9, 'pivot on the sightline');
            near(len(sub(v.target, v.position)), v.standoffRe, 1e-9, 'pivot at the tangent range');
        }
    }
});

t('the tangent elevations are the real tangent rays (checked against brute-force geometry)', () => {
    const rMid = 1 + 170 / R_EARTH_KM, d = 0.33;
    near(tangentElevation(rMid, rMid, d), 0, 1e-12, 'mid-height ray is horizontal');
    for (const hKm of [0, 50, 250, 450]) {          // the camera is at ~500 km
        const r = 1 + hKm / R_EARTH_KM;
        // Sweep elevations and find the one whose ray just grazes radius r.
        const C = [-d, rMid];                         // (ĥ, P̂) plane coordinates
        let lo = -0.6, hi = 0.9;
        const minR = (e) => {                          // closest approach of the ray at elevation e
            const u = [Math.cos(e), Math.sin(e)];
            const t0 = Math.max(0, -(C[0] * u[0] + C[1] * u[1]));   // forward rays only
            return Math.hypot(C[0] + t0 * u[0], C[1] + t0 * u[1]);
        };
        for (let i = 0; i < 80; i++) { const m = 0.5 * (lo + hi); if (minR(m) < r) lo = m; else hi = m; }
        near(tangentElevation(r, rMid, d), 0.5 * (lo + hi), 1e-9, `${hKm} km`);
    }
    near(limbCameraAltKm(85), 400, 1e-12, 'the ISS floor');
    near(limbCameraAltKm(2000), 2250, 1e-12);
    // An explicit camera altitude is honoured, but never inside the band.
    const v = limbViewPose({ latDeg: 0, lonDeg: 0, minKm: 250, maxKm: 600, camAltKm: 300 });
    assert.ok(v.camAltKm > 600);
});

t('thinner / lower layers get longer lenses; the mesosphere is a super-telephoto', () => {
    const at = (b) => limbViewPose({ latDeg: 0, lonDeg: 0, minKm: b.minKm, maxKm: b.maxKm });
    const views = bands.map(at);
    assert.ok(views[0].fovDeg < 5, `mesosphere fov ${views[0].fovDeg}`);
    for (let i = 1; i < 5; i++) {
        assert.ok(views[i].standoffRe > views[i - 1].standoffRe, `${bands[i].id}: stands further back`);
    }
    // At the pole the heading falls back to east instead of an undefined north.
    const pole = limbViewPose({ latDeg: 89.5, lonDeg: 10, minKm: 100, maxKm: 200 });
    assert.equal(pole.headingDeg, 90);
    assert.ok(pole.position.every(Number.isFinite));
});

t('describeRig reports altitude, the pivot and the lens', () => {
    const d = describeRig({ position: [0, 1 + 400 / R_EARTH_KM, 0], target: [0, 1, 0], fovDeg: 40 });
    near(d.altKm, 400, 1e-9);
    near(d.latDeg, 90, 1e-9);
    near(d.pivotRangeKm, 400, 1e-9);
    near(d.pivotAltKm, 0, 1e-9);
    near(d.focalMm, focalLengthMm(40), 1e-12);
});

console.log(`\n${fail ? '✗' : '✓'} upper-atmosphere-camera-rig: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
