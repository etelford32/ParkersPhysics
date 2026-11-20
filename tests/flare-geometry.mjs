// flare-geometry.mjs — gate for js/flare-geometry.js, the ONE copy of
// flare-site geometry. Pins the frame conventions against three.js's own
// Matrix4 / Object3D math (so "rotation sense" is a measurement, not a
// belief), the Carrington ephemeris against Meeus's worked example AND the
// definition (L0 = 0 at the start of CR 1), and the ribbon/arcade laws
// against the literals sunFS carries inline.
//
//   node tests/flare-geometry.mjs

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as THREE from '../js/vendor/three-0.160.0/three.module.js';
import { arcadeExposure, AEC_TARGET, AEC_FLOOR, AEC_FILL, STRAND_LIGHT, HOT_FUZZ } from '../js/flare-arcade.js';
import { readFileSync as _readArcade } from 'node:fs';
import {
    diffRotFactor, slotRotAngle, solarEphemeris, heliographicToVec, REAL_TIME_ROT_MUL,
} from '../js/sun-observed.js';
import {
    DEG, SIM_ROT_RATE, OMEGA_SUN_SIDEREAL, SUN_SIDEREAL_DAYS, SUN_SYNODIC_DAYS, AU_KM, vec,
    parseStonyhurst, formatStonyhurst,
    stonyhurstToUnit, unitToStonyhurst, rotateY, rotationAngle, siteRotation,
    siteLonAt, epochLonFor, sitePositionAt,
    localFrame, joyTiltRad, bipoleAxis, pilAngleRad, tangentFrame,
    RIBBON, RIBBON_LEN_LEGACY, ribbonLength0, ribbonSeparation, ribbonWidth, ribbonAlongSigma, ribbonDecay,
    CLASS_FACTOR, classFactor, arcadeShear, arcadeHeight, arcadeLoops, plumeState,
    earthViewGeometry,
    heliocentricSiteDirection, heliocentricAzimuth, objectAzimuthForWorld,
    carringtonToStonyhurstDeg, centralMeridianL0Deg,
    parkerFootpointLonDeg, magneticConnectivity, coneBasis, siteOnDisk2D,
} from '../js/flare-geometry.js';

let failures = 0, passes = 0;
async function ok(label, fn) {
    try { await fn(); passes++; console.log(`  ok  ${label}`); }
    catch (e) { failures++; console.error(`FAIL  ${label}\n      ${e.message}`); }
}
const close = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg} ${a} vs ${b} (eps ${eps})`);
const vclose = (a, b, eps = 1e-9, msg = '') => { for (let i = 0; i < 3; i++) close(a[i], b[i], eps, `${msg}[${i}]`); };

// ── Stonyhurst strings ───────────────────────────────────────────────────
await ok('parseStonyhurst: W is POSITIVE, E negative, S negative; junk is null (never disk centre)', () => {
    assert.deepEqual(parseStonyhurst('N12W19'), { latDeg: 12, lonDeg: 19 });
    assert.deepEqual(parseStonyhurst('S05E34'), { latDeg: -5, lonDeg: -34 });
    assert.deepEqual(parseStonyhurst(' n07 e02 '), { latDeg: 7, lonDeg: -2 });
    assert.deepEqual(parseStonyhurst('N12W19 (AR 14101)'), { latDeg: 12, lonDeg: 19 }, 'trailing text tolerated (the feed relied on it)');
    assert.equal(parseStonyhurst(''), null);
    assert.equal(parseStonyhurst('—'), null);
    assert.equal(parseStonyhurst(null), null);
    assert.equal(parseStonyhurst('N95W10'), null);
    assert.equal(formatStonyhurst(12, 19), 'N12W19');
    assert.equal(formatStonyhurst(-5, -34), 'S05E34');
    const rt = parseStonyhurst(formatStonyhurst(-21, 77));
    assert.deepEqual(rt, { latDeg: -21, lonDeg: 77 });
});

// ── Sun frame ────────────────────────────────────────────────────────────
await ok('stonyhurstToUnit: disk centre +z, W90 +x, N pole +y; matches sun-observed heliographicToVec; round-trips', () => {
    vclose(stonyhurstToUnit(0, 0), [0, 0, 1]);
    vclose(stonyhurstToUnit(0, 90 * DEG), [1, 0, 0]);
    vclose(stonyhurstToUnit(90 * DEG, 0), [0, 1, 0]);
    for (const [la, lo] of [[12, 19], [-40, -120], [70, 175], [0, 0]]) {
        vclose(stonyhurstToUnit(la * DEG, lo * DEG), heliographicToVec(la, lo), 1e-12, 'vs heliographicToVec');
        const back = unitToStonyhurst(stonyhurstToUnit(la * DEG, lo * DEG));
        close(back.latRad, la * DEG, 1e-12); close(back.lonRad, lo * DEG, 1e-12);
    }
});

await ok('rotateY IS three.js makeRotationY (random vectors, both signs)', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 40; k++) {
        const v = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
        const ang = (rnd() * 2 - 1) * Math.PI;
        const w = new THREE.Vector3(...v).applyMatrix4(new THREE.Matrix4().makeRotationY(ang));
        vclose(rotateY(v, ang), [w.x, w.y, w.z], 1e-12, `k=${k}`);
    }
});

await ok('rotation SENSE: +angle carries disk centre toward +x (WEST) — the Sun spins prograde about +y', () => {
    // Independent derivation: v = ω × r with ω along +y (north), r = +z (disk centre).
    const vel = vec.cross([0, 1, 0], [0, 0, 1]);
    vclose(vel, [1, 0, 0]);
    const moved = sitePositionAt(0, 0, 0.3);
    assert.ok(moved[0] > 0, 'x grows (west)');
    close(unitToStonyhurst(moved).lonRad, 0.3, 1e-12, 'lon increased by the angle');
    vclose(moved, rotateY([0, 0, 1], 0.3), 1e-12);
    // A group with rotation.y = +angle does the same thing (the marker groups' path).
    const g = new THREE.Group(); g.rotation.y = 0.3;
    const child = new THREE.Object3D(); child.position.set(0, 0, 1); g.add(child); g.updateMatrixWorld(true);
    const wp = child.getWorldPosition(new THREE.Vector3());
    vclose([wp.x, wp.y, wp.z], moved, 1e-12, 'group path');
});

await ok('differential rotation: equator turns the full angle, 60° turns the Snodgrass fraction, mirrors slotRotAngle', () => {
    close(siteRotation(1.0, 0), 1.0);
    const f60 = diffRotFactor(60 * DEG);
    assert.ok(f60 < 1 && f60 > 0.7);
    close(siteRotation(1.0, 60 * DEG), f60);
    close(rotationAngle(123.4, 1.0) * diffRotFactor(15 * DEG), slotRotAngle(123.4, 1.0, 15 * DEG), 1e-12);
    close(rotationAngle(10, 0.5), 10 * SIM_ROT_RATE * 0.5);
});

await ok('epochLonFor inverts siteLonAt at every latitude', () => {
    for (const lat of [0, 0.3, -0.7, 1.2]) {
        const now = siteLonAt(0.4, 2.2, lat);
        close(epochLonFor(now, 2.2, lat), 0.4, 1e-12);
    }
});

await ok('real time: one synodic rotation of the equator takes 27.2753 d at the sim clock rate', () => {
    const radPerSec = rotationAngle(0.6, REAL_TIME_ROT_MUL);   // 0.010 units/frame × 60 fps
    close(radPerSec * SUN_SYNODIC_DAYS * 86400, 2 * Math.PI, 1e-9);
    close(OMEGA_SUN_SIDEREAL * SUN_SIDEREAL_DAYS * 86400, 2 * Math.PI, 1e-12);
});

// ── Local frame + PIL prior ──────────────────────────────────────────────
await ok('localFrame is orthonormal, right-handed (east × north = radial) and matches ∂p/∂lon, ∂p/∂lat', () => {
    for (const [la, lo] of [[0, 0], [14, 30], [-35, -110], [60, 170]]) {
        const lat = la * DEG, lon = lo * DEG;
        const f = localFrame(lat, lon);
        close(vec.norm(f.radial), 1, 1e-12); close(vec.norm(f.east), 1, 1e-12); close(vec.norm(f.north), 1, 1e-12);
        close(vec.dot(f.east, f.north), 0, 1e-12); close(vec.dot(f.east, f.radial), 0, 1e-12); close(vec.dot(f.north, f.radial), 0, 1e-12);
        vclose(vec.cross(f.east, f.north), f.radial, 1e-12, 'handedness');
        const h = 1e-6;
        const dLon = vec.scale(vec.add(stonyhurstToUnit(lat, lon + h), vec.scale(stonyhurstToUnit(lat, lon - h), -1)), 1 / (2 * h));
        const dLat = vec.scale(vec.add(stonyhurstToUnit(lat + h, lon), vec.scale(stonyhurstToUnit(lat - h, lon), -1)), 1 / (2 * h));
        vclose(vec.unit(dLon), f.east, 1e-6, 'east = ∂/∂lon'); vclose(vec.unit(dLat), f.north, 1e-6, 'north = ∂/∂lat');
    }
    const c = localFrame(0, 0);
    vclose(c.east, [1, 0, 0]); vclose(c.north, [0, 1, 0]);
});

await ok("Joy's law: leading (west) spot is EQUATORWARD in both hemispheres, tilt = 0.5·|lat|, zero on the equator", () => {
    close(joyTiltRad(0), 0);
    close(Math.abs(joyTiltRad(20 * DEG)), 10 * DEG, 1e-12);
    for (const la of [15, 30, -15, -30]) {
        const lat = la * DEG, lon = 0.2;
        const axis = bipoleAxis(lat, lon);
        const site = stonyhurstToUnit(lat, lon);
        const west = vec.unit(vec.add(site, vec.scale(axis, 0.05)));
        const east = vec.unit(vec.add(site, vec.scale(axis, -0.05)));
        const latW = unitToStonyhurst(west).latRad, latE = unitToStonyhurst(east).latRad;
        assert.ok(Math.abs(latW) < Math.abs(latE), `lat ${la}: west end closer to the equator (${latW} vs ${latE})`);
        assert.ok(unitToStonyhurst(west).lonRad > unitToStonyhurst(east).lonRad, 'axis points west');
    }
});

await ok('tangentFrame: pilAxis ⟂ bipole axis, loopAxis ⟂ pilAxis, both tangent; prior angle wraps to (−π/2, π/2]', () => {
    for (const la of [0, 14, -40, 60]) {
        const lat = la * DEG, lon = -0.5;
        const tf = tangentFrame(lat, lon);
        close(vec.dot(tf.pilAxis, bipoleAxis(lat, lon)), 0, 1e-12, 'PIL ⟂ axis');
        close(vec.dot(tf.pilAxis, tf.loopAxis), 0, 1e-12);
        close(vec.dot(tf.pilAxis, tf.radial), 0, 1e-12); close(vec.dot(tf.loopAxis, tf.radial), 0, 1e-12);
        vclose(vec.cross(tf.pilAxis, tf.loopAxis), tf.radial, 1e-12, 'pil × loop = radial');
        assert.ok(pilAngleRad(lat) > -Math.PI / 2 && pilAngleRad(lat) <= Math.PI / 2);
    }
    // An explicit PIL angle of 0 puts the PIL along east (the legacy E-W ribbons).
    const ew = tangentFrame(0.3, 0.1, 0);
    vclose(ew.pilAxis, localFrame(0.3, 0.1).east, 1e-12); vclose(ew.loopAxis, localFrame(0.3, 0.1).north, 1e-12);
});

// ── The shape laws are ONE parameter set; the shader holds none ───────────
await ok('sunFS holds NO ribbon law: the page uploads the model\'s numbers every frame (read from sun.html)', async () => {
    const src = await readFile(fileURLToPath(new URL('../sun.html', import.meta.url)), 'utf8');
    // The four laws that used to be typed into the shader and mirrored here.
    for (const [name, re] of [
        ['separation', /float sep\s*=\s*[0-9.]+\s*\+\s*u_flare_t/],
        ['width', /float rWid\s*=\s*[0-9.]+\s*\+\s*u_flare_t/],
        ['along-PIL variance', /float alongVar\s*=\s*[^;]*u_flare_t/],
        ['decay', /float fDecay\s*=\s*exp\(\s*-u_flare_t/],
    ]) assert.ok(!re.test(src), `the shader still carries its own ${name} law`);
    // …and what replaced them: uniforms, written from the model in one place.
    for (const u of ['u_flare_sep', 'u_flare_wid', 'u_flare_alongVar', 'u_flare_decay']) {
        assert.match(src, new RegExp(`uniform float ${u};`), `${u} declared in sunFS`);
        assert.match(src, new RegExp(`uniforms\\.${u}\\.value\\s*=\\s*[^;]*flareModel\\.`), `${u} is fed from the model`);
    }
    assert.match(src, /float sep\s*=\s*u_flare_sep;/); assert.match(src, /float rWid\s*=\s*u_flare_wid;/);
    // The J hook and the handedness too — and the distance function is the kernel's text, interpolated, not retyped.
    assert.match(src, /\$\{FG\.RIBBON_J_GLSL\}/, 'sunFS interpolates the kernel\'s ribbonJ');
    assert.equal((src.match(/vec2 ribbonJ\(/g) || []).length, 0, 'no second, hand-typed ribbonJ in the page');
    assert.match(src, /uniforms\.u_flare_hook\.value\.set\(hk\.s0, hk\.rho, hk\.sweep\)/); assert.match(src, /const hk = flareModel\.ribbonHook\(/);
    assert.match(src, /uniforms\.u_flare_chi\.value\s*=\s*flareSite\.chirality/); assert.match(src, /flareSite\.chirality = FG\.helicityChirality\(latRad\)/);
    assert.ok(!/pow\(\(across [-+] sep\) \/ rWid, 2\.0\)/.test(src), 'pow() of a negative base is undefined in GLSL — the ribbon profile is a product now');
    assert.match(src, /float alongVar\s*=\s*u_flare_alongVar;/); assert.match(src, /float fDecay\s*=\s*u_flare_decay;/);
});

await ok('makeFlareModel: the shipped exports ARE the default model; overrides are deep-merged; a typo throws', async () => {
    const FG = await import('../js/flare-geometry.js');
    assert.deepEqual(FG.FLARE_MODEL.params, FG.FLARE_SHAPE_DEFAULT);
    for (const k of ['ribbonSeparation', 'ribbonWidth', 'ribbonLength0', 'ribbonAlongSigma', 'ribbonDecay', 'arcadeShear', 'arcadeHeight', 'arcadeLoops', 'arcadeShells', 'plumeState', 'classFactor'])
        assert.equal(FG[k], FG.FLARE_MODEL[k], `${k} is the default model's`);
    const m = FG.makeFlareModel({ shear: { onsetDeg: 40 } });
    assert.equal(m.params.shear.onsetDeg, 40);
    assert.equal(m.params.shear.finalDeg, FG.FLARE_SHAPE_DEFAULT.shear.finalDeg, 'the rest of the group is kept');
    assert.deepEqual(m.params.ribbon, FG.FLARE_SHAPE_DEFAULT.ribbon);
    close(Math.atan(m.arcadeShear(0)) / DEG, 40, 1e-9);
    assert.ok(Object.isFrozen(m.params) && Object.isFrozen(m.params.shear) && Object.isFrozen(FG.FLARE_SHAPE_DEFAULT.ribbon));
    assert.throws(() => FG.makeFlareModel({ shear: { onsetDegg: 40 } }), /unknown parameter "shear\.onsetDegg"/);
    assert.throws(() => FG.makeFlareModel({ shear: { onsetDeg: '40' } }), /finite number/);
    assert.throws(() => FG.makeFlareModel({ shear: 40 }), /must be an object/);
    // A model's own tables are views of ITS parameters, not of the default's.
    assert.equal(FG.makeFlareModel({ arcade: { zipT: 11 } }).ARCADE.ZIP_T, 11);
});

await ok('FLARE_SHAPE_V1 reproduces the laws shipped until 2026-11-21 (their closed forms, re-derived here)', async () => {
    const FG = await import('../js/flare-geometry.js');
    const v1 = FG.makeFlareModel(null, FG.FLARE_SHAPE_V1);
    const cf = { C: 0.60, M: 0.85, X: 1.15 };
    for (const t of [0, 1, 60, 175, 300, 630, 800]) {
        for (const c of ['C', 'M', 'X']) {
            close(v1.ribbonSeparation(t, c), 0.020 + t * 2.5e-5, 1e-15, 'separation: linear, the same for every class');
            close(v1.arcadeHeight(t, c), 2 * (0.020 + t * 2.5e-5) * (0.6 + 0.7 * cf[c]), 1e-12, 'height: 2·sep·(0.6 + 0.7·cf)');
            close(v1.ribbonAlongSigma(t, c), 0.095 * cf[c] * Math.sqrt(1 + t / 2500), 1e-15);
        }
        close(v1.ribbonWidth(t), 0.005 + t * 6e-6, 1e-15);
        close(v1.ribbonDecay(t), Math.exp(-t / 175), 1e-15);
        close(v1.arcadeShear(t), 0.45 * Math.exp(-t / 250) + 0.12, 1e-12, 'shear');
        close(v1.arcadeShear(t, true), 0.75 * Math.exp(-t / 250) + 0.12, 1e-12, 'shear, δ region');
    }
    assert.equal(v1.ARCADE.ZIP_T, 45);
    assert.equal(v1.id, 'flare-shape-v1');
});

await ok('the shipped laws: ribbons part fast then slow, bigger flares further; shear relaxes in angle; loops span their feet', async () => {
    const FG = await import('../js/flare-geometry.js');
    const M = FG.FLARE_MODEL, R = M.params.ribbon;
    close(M.ribbonSeparation(0, 'X'), R.sep0, 1e-15);
    close(M.ribbonSeparation(1e6, 'X'), R.sep0 + R.sepGain * M.classFactor('X'), 1e-12, 'saturates at sep0 + sepGain·cf');
    const v = (t) => M.ribbonSeparation(t + 1, 'X') - M.ribbonSeparation(t, 'X');
    assert.ok(v(0) > 5 * v(600) && v(600) > 0, 'decelerating, never reversing');
    assert.ok(M.ribbonSeparation(600, 'C') < M.ribbonSeparation(600, 'M') && M.ribbonSeparation(600, 'M') < M.ribbonSeparation(600, 'X'));
    close(M.arcadeShearAngle(0) / DEG, M.params.shear.onsetDeg, 1e-9);
    close(M.arcadeShearAngle(0, true) / DEG, M.params.shear.onsetComplexDeg, 1e-9);
    close(M.arcadeShearAngle(1e6) / DEG, M.params.shear.finalDeg, 1e-9);
    // Height is a fixed multiple of the loop's own half footpoint chord…
    for (const t of [0, 100, 600]) {
        const chord = M.ribbonSeparation(t, 'X') * Math.hypot(1, M.arcadeShear(t));
        close(M.arcadeHeight(t, 'X') / chord, M.params.height.a + M.params.height.b * M.classFactor('X'), 1e-12);
    }
    // …and still grows monotonically although the shear (and so the chord factor) falls.
    let prev = 0;
    for (let t = 0; t <= 800; t += 10) { const h = M.arcadeHeight(t, 'X'); assert.ok(h > prev, `height falls at t=${t}`); prev = h; }
    for (let t = 0; t <= 800; t += 10) assert.ok(M.arcadeHeight(t, 'X', true) >= M.arcadeHeight(t, 'X') - 1e-15, 'a δ region\'s loops span a longer chord');
});

await ok('ribbon length is class-scaled and of flare size (the legacy constant was 440 Mm for every class)', async () => {
    const FG = await import('../js/flare-geometry.js');
    const RSUN_MM = 695.7, len = (s) => 2 * s * RSUN_MM;          // 1/e point to 1/e point, Mm
    const X = len(ribbonLength0('X')), M = len(ribbonLength0('M')), C = len(ribbonLength0('C'));
    assert.ok(C < M && M < X, 'a bigger flare has longer ribbons');
    assert.ok(X > 100 && X < 250, `X-class ribbons ${X.toFixed(0)} Mm`);
    assert.ok(C > 40 && C < 120, `C-class ribbons ${C.toFixed(0)} Mm`);
    close(ribbonAlongSigma(RIBBON.LEN_GROW_T, 'M') ** 2, 2 * ribbonLength0('M') ** 2, 1e-12, 'σ² doubles in LEN_GROW_T');
    close(ribbonDecay(RIBBON.DECAY_T), Math.exp(-1)); close(ribbonWidth(100), RIBBON.WID0 + 100 * RIBBON.WID_RATE);
    // aspect: length over the full separation half an hour in (630 sim units)
    const aspect = (s, model) => 2 * s / (2 * model.ribbonSeparation(630, 'X'));
    assert.ok(aspect(ribbonLength0('X'), FG.FLARE_MODEL) < 6, 'an X arcade is a few times longer than it is wide');
    // NEGATIVE CONTROL — the constant it replaced, on the laws it shipped with, fails both.
    const v1 = FG.makeFlareModel(null, FG.FLARE_SHAPE_V1);
    assert.ok(len(RIBBON_LEN_LEGACY) > 400, 'legacy: 440 Mm ribbons');
    assert.ok(aspect(RIBBON_LEN_LEGACY, v1) > 8, `legacy: a ${aspect(RIBBON_LEN_LEGACY, v1).toFixed(1)}:1 spine`);
});

// ── Arcade + plume ───────────────────────────────────────────────────────
await ok('classFactor is ordered A < B < C < M < X and unknown reads as M', () => {
    assert.ok(CLASS_FACTOR.A < CLASS_FACTOR.B && CLASS_FACTOR.B < CLASS_FACTOR.C && CLASS_FACTOR.C < CLASS_FACTOR.M && CLASS_FACTOR.M < CLASS_FACTOR.X);
    close(classFactor('x2.2'), CLASS_FACTOR.X); close(classFactor(undefined), CLASS_FACTOR.M); close(classFactor('?'), CLASS_FACTOR.M);
});

await ok('arcade: loops straddle the PIL at the ribbon separation, apex over the PIL at arcadeHeight, feet on the sphere', () => {
    const lat = 14 * DEG, lon = 30 * DEG, t = 60;
    const tf = tangentFrame(lat, lon);
    const loops = arcadeLoops({ latRad: lat, lonRad: lon, t, cls: 'X', n: 7 });
    assert.equal(loops.length, 7);
    const sep = ribbonSeparation(t, 'X'), h = arcadeHeight(t, 'X');
    for (const L of loops) {
        const a = vec.dot(L.footA, tf.loopAxis), b = vec.dot(L.footB, tf.loopAxis);
        assert.ok(a > 0 && b < 0, 'feet on opposite sides of the PIL');
        close(a + b, 0, 1e-9, 'symmetric about the PIL');
        close(a - b, 2 * sep, 0.03 * 2 * sep, 'full separation ≈ 2·ribbonSeparation');
        close(vec.norm(L.pts[0]), 1, 1e-9); close(vec.norm(L.pts[L.pts.length - 1]), 1, 1e-9);
        const rMax = Math.max(...L.pts.map(vec.norm));
        close(rMax, 1 + h, 1e-9, 'apex radius');
        assert.ok(L.pts.every(p => vec.norm(p) >= 1 - 1e-9), 'nothing below the photosphere');
        const apex = L.pts[Math.floor(L.pts.length / 2)];
        close(vec.dot(vec.unit(apex), tf.loopAxis), 0, 1e-6, 'apex over the PIL');
        assert.ok(L.weight > 0 && L.weight <= 1);
    }
    const alongs = loops.map(L => L.along);
    close(alongs[0], -alongs[alongs.length - 1], 1e-12, 'laid symmetrically along the PIL');
    assert.ok(alongs[0] < alongs[1], 'ordered along the PIL');
});

await ok('arcade laws: shear relaxes strong→weak, height grows with time and class; atlas pairs override the prior', () => {
    assert.ok(arcadeShear(0, true) > arcadeShear(0, false));
    assert.ok(arcadeShear(0) > arcadeShear(200) && arcadeShear(200) > arcadeShear(1000));
    assert.ok(arcadeHeight(0, 'X') > arcadeHeight(0, 'M') && arcadeHeight(0, 'M') > arcadeHeight(0, 'C'));
    assert.ok(arcadeHeight(300, 'M') > arcadeHeight(0, 'M'));
    const lat = -10 * DEG, lon = -40 * DEG;
    const tf = tangentFrame(lat, lon);
    const mk = (s) => vec.unit(vec.add(tf.radial, vec.scale(tf.loopAxis, s)));
    const pairs = [{ a: mk(-0.03), b: mk(0.03), apexR: 1.11 }, { b: mk(-0.02), a: mk(0.02) }];
    const loops = arcadeLoops({ latRad: lat, lonRad: lon, pairs, t: 0, cls: 'C' });
    assert.equal(loops.length, 2);
    assert.ok(vec.dot(loops[0].footA, tf.loopAxis) > 0 && vec.dot(loops[1].footA, tf.loopAxis) > 0, 'footA always on the +loopAxis side');
    close(Math.max(...loops[0].pts.map(vec.norm)), 1.11, 1e-9, 'pair apex radius honoured');
    close(Math.max(...loops[1].pts.map(vec.norm)), 1 + arcadeHeight(0, 'C'), 1e-9, 'missing apexR falls back to the law');
});

await ok('plume: rises from the photosphere, caps at rMax, bigger classes reach farther, fades out', () => {
    const p0 = plumeState(0, 'X');
    close(p0.front, 1, 1e-12); close(p0.alpha, 0, 1e-12);
    let prev = 1;
    for (let t = 1; t <= 200; t += 1) {
        const p = plumeState(t, 'X');
        assert.ok(p.front >= prev - 1e-12, 'front never retreats'); prev = p.front;
        assert.ok(p.front <= p.rMax + 1e-12 && p.tail >= 1 && p.tail <= p.front);
    }
    assert.ok(plumeState(200, 'X').front > 2.5, 'X reaches well into space');
    assert.ok(plumeState(200, 'C').front < plumeState(200, 'M').front && plumeState(200, 'M').front < plumeState(200, 'X').front);
    assert.ok(plumeState(200, 'C').rMax < 2.6);
    assert.ok(plumeState(6, 'M').alpha > 0.5 && plumeState(400, 'M').alpha < 0.02, 'rise then fade');
    assert.ok(plumeState(40, 'M').radius > plumeState(2, 'M').radius, 'widens as it rises');
});

// ── Earth view ───────────────────────────────────────────────────────────
await ok('earthViewGeometry: face-on at disk centre, side-on at the limb, far side flagged, B0 tilt matches sunFS', () => {
    const c = earthViewGeometry(0, 0);
    close(c.mu, 1); close(c.profileFraction, 0); assert.ok(c.nearSide);
    const l = earthViewGeometry(0, 90 * DEG);
    close(l.mu, 0, 1e-12); close(l.profileFraction, 1, 1e-12); close(l.limbAngleRad, Math.PI / 2, 1e-12);
    assert.ok(!earthViewGeometry(0, 180 * DEG).nearSide);
    // With B0 = 7°, the sub-Earth point is at lat 7° — μ = 1 there, exactly the q.z that sunFS computes.
    const b0 = 7 * DEG;
    close(earthViewGeometry(b0, 0, b0).mu, 1, 1e-12);
    const p = stonyhurstToUnit(0.4, -0.3);
    const qz = p[1] * Math.sin(b0) + p[2] * Math.cos(b0);
    close(earthViewGeometry(0.4, -0.3, b0).mu, qz, 1e-12);
});

// ── Heliocentric scene ───────────────────────────────────────────────────
await ok('heliocentricSiteDirection: lon 0 points at Earth; W90 is a quarter turn AHEAD in the spin sense; spinSign flips it', () => {
    const earthAz = 1.0;
    const centre = heliocentricSiteDirection({ latRad: 0, lonRad: 0, earthAzRad: earthAz });
    close(heliocentricAzimuth(centre), earthAz, 1e-12);
    const w90 = heliocentricSiteDirection({ latRad: 0, lonRad: 90 * DEG, earthAzRad: earthAz, spinSign: 1 });
    close(heliocentricAzimuth(w90), earthAz + Math.PI / 2, 1e-12);
    const e90 = heliocentricSiteDirection({ latRad: 0, lonRad: -90 * DEG, earthAzRad: earthAz, spinSign: 1 });
    close(heliocentricAzimuth(e90), earthAz - Math.PI / 2, 1e-12);
    const w90r = heliocentricSiteDirection({ latRad: 0, lonRad: 90 * DEG, earthAzRad: earthAz, spinSign: -1 });
    close(heliocentricAzimuth(w90r), earthAz - Math.PI / 2, 1e-12);
    const n30 = heliocentricSiteDirection({ latRad: 30 * DEG, lonRad: 0, earthAzRad: earthAz });
    close(n30[1], Math.sin(30 * DEG), 1e-12); close(vec.norm(n30), 1, 1e-12);
});

await ok('objectAzimuthForWorld: a child placed at it lands at the world azimuth inside a rotated mesh (Object3D pin)', () => {
    for (const rotY of [0.0, 0.7, -2.1, 3.9]) {
        const mesh = new THREE.Object3D(); mesh.rotation.y = rotY;
        const worldAz = 1.3;
        const objAz = objectAzimuthForWorld(worldAz, rotY);
        const child = new THREE.Object3D(); child.position.set(Math.cos(objAz), 0, Math.sin(objAz));
        mesh.add(child); mesh.updateMatrixWorld(true);
        const wp = child.getWorldPosition(new THREE.Vector3());
        close(Math.atan2(wp.z, wp.x), worldAz, 1e-12, `rotY=${rotY}`);
    }
});

await ok('Carrington: L0 = 238.63° at Meeus example 29.a, 0 at the start of CR 1, falls 13.2°/day, CR number wraps with it', () => {
    const ex = solarEphemeris(new Date('1992-10-13T00:00:00Z'));
    close(ex.l0Deg, 238.63, 0.05, 'Meeus 29.a L0'); close(ex.b0Deg, 5.99, 0.02, 'B0'); close(ex.pDeg, 26.27, 0.02, 'P');
    const cr1 = solarEphemeris(new Date('1853-11-09T21:36:00Z'));
    assert.ok(Math.min(cr1.l0Deg, 360 - cr1.l0Deg) < 0.05, `L0 at the CR-1 epoch is 0 (got ${cr1.l0Deg})`);
    assert.equal(cr1.carringtonRotation, 1);
    const a = centralMeridianL0Deg(new Date('2026-09-13T00:00:00Z'));
    const b = centralMeridianL0Deg(new Date('2026-09-14T00:00:00Z'));
    const perDay = ((a - b) % 360 + 540) % 360 - 180;
    close(perDay, 360 / SUN_SYNODIC_DAYS, 0.05, 'daily rate');
    // Around a CR boundary the number steps by one and L0 wraps through 0.
    let stepped = false;
    for (let d = 0; d < 28; d++) {
        const e0 = solarEphemeris(new Date(Date.UTC(2026, 8, 1 + d)));
        const e1 = solarEphemeris(new Date(Date.UTC(2026, 8, 2 + d)));
        if (e1.carringtonRotation === e0.carringtonRotation + 1) {
            stepped = true;
            assert.ok(e1.l0Deg > 300 && e0.l0Deg < 60, `L0 wraps at the CR step (${e0.l0Deg} → ${e1.l0Deg})`);
        }
    }
    assert.ok(stepped, 'one CR boundary in 28 days');
});

await ok('carringtonToStonyhurstDeg: subtracts L0 and wraps to (−180, 180]', () => {
    close(carringtonToStonyhurstDeg(142, 112), 30);
    close(carringtonToStonyhurstDeg(100, 300), 160);
    close(carringtonToStonyhurstDeg(300, 100), -160);
    close(carringtonToStonyhurstDeg(10, 190), 180);
    close(carringtonToStonyhurstDeg(50, 50), 0);
});

// ── Parker connection / cone / 2D ────────────────────────────────────────
await ok('Parker footpoint: ≈61° W at 400 km/s and 1 AU, closer to the meridian for faster wind; connectivity peaks there', () => {
    const f400 = parkerFootpointLonDeg(400);
    close(f400, (OMEGA_SUN_SIDEREAL * AU_KM / 400) / DEG, 1e-9);
    assert.ok(f400 > 55 && f400 < 66, `${f400}`);
    assert.ok(parkerFootpointLonDeg(800) < f400);
    close(magneticConnectivity(f400, 400), 1, 1e-12);
    close(magneticConnectivity(f400 + 20, 400), magneticConnectivity(f400 - 20, 400), 1e-12);
    assert.ok(magneticConnectivity(-60, 400) < 0.01, 'an east-limb flare is poorly connected');
});

await ok('coneBasis is orthonormal and right-handed for any axis, including near the pole', () => {
    for (const ax of [[0, 0, 1], [1, 0, 0], [0, 1, 0.01], [0.3, -0.5, 0.8]]) {
        const { axis, u, v } = coneBasis(ax);
        close(vec.norm(axis), 1, 1e-12); close(vec.norm(u), 1, 1e-12); close(vec.norm(v), 1, 1e-12);
        close(vec.dot(axis, u), 0, 1e-12); close(vec.dot(axis, v), 0, 1e-12); close(vec.dot(u, v), 0, 1e-12);
        vclose(vec.cross(u, v), axis, 1e-12, 'u × v = axis');
    }
});

await ok('siteOnDisk2D: north up, west right, canvas y down; far side invisible; jet angle is the radial', () => {
    const c = siteOnDisk2D(0, 0); close(c.x, 0); close(c.y, 0); assert.ok(c.visible);
    const w = siteOnDisk2D(0, 90 * DEG); close(w.x, 1, 1e-12); close(w.angle, 0, 1e-12);
    const n = siteOnDisk2D(90 * DEG, 0); close(n.y, -1, 1e-12); close(n.angle, -Math.PI / 2, 1e-12);
    const ne = siteOnDisk2D(45 * DEG, 45 * DEG); assert.ok(ne.x > 0 && ne.y < 0 && ne.angle < 0 && ne.angle > -Math.PI / 2, 'upper-right quadrant');
    assert.ok(!siteOnDisk2D(0, 180 * DEG).visible);
});

await ok('arcadeShells: a NESTED arcade from the same laws — newest loops outermost, earliest most sheared', async () => {
    const FG = await import('../js/flare-geometry.js');
    const base = { latRad: 14 * DEG, lonRad: 28 * DEG, pilAngle: FG.pilAngleRad(14 * DEG), cls: 'X', n: 13 };
    const at = (t) => FG.arcadeShells({ ...base, t });
    // A flare does not start with an empty arcade: the central ZIP_CORE is there at onset,
    // one generation, age 0 (not yet faded in), and the ends have not lit.
    const onset = at(0);
    assert.ok(onset.length >= 1 && onset.length < 13, `loops at onset: ${onset.length}`);
    assert.ok(onset.every(L => L.generation === 0 && L.age === 0 && L.alpha === 0), 'onset loops are the first generation, just forming');
    // Nothing before onset; one generation at first; more with time; never more than stations × generations.
    assert.equal(at(-1).length, 0);
    const n5 = at(5).length, n60 = at(60).length, n300 = at(300).length;
    assert.ok(n5 >= 1 && n5 < n60 && n60 < n300, `${n5} ${n60} ${n300}`);
    assert.ok(n300 <= 13 * FG.ARCADE.MAX_GENERATIONS);
    for (const L of at(300)) {
        // Each loop is the kernel's own laws at ITS formation time — nothing new.
        const tau = Math.max(L.tForm, 0);
        const sep = FG.ribbonSeparation(tau, 'X');
        const half = Math.acos(Math.max(-1, Math.min(1, vec.dot(L.footA, L.footB)))) / 2;
        const want = Math.atan(sep * Math.hypot(1, FG.arcadeShear(tau, false)));
        close(half, want, 2e-3, 'footpoint half-separation = ribbonSeparation × √(1 + shear²)');
        // RELAXED height: the law at the loop's formation time, within its own scatter. The loop itself
        // stands taller by exactly the cusp it has not yet retracted — never lower.
        const hr = L.relaxedApexR - 1, h0 = FG.arcadeHeight(tau, 'X');
        assert.ok(Math.abs(hr / h0 - 1) <= FG.ARCADE.HEIGHT_JITTER + 1e-9, `relaxed height ${hr} vs ${h0}`);
        close((L.apexR - 1) / hr, FG.loopHeightFactor(L.age), 1e-12, 'height = relaxed height × the loop\'s own relax factor');
        assert.ok(L.apexR >= L.relaxedApexR - 1e-15);
        assert.ok(L.age > 0 && L.alpha > 0 && L.alpha <= 1);
        for (const p of L.pts) assert.ok(vec.norm(p) >= 1 - 1e-12, 'no point below the photosphere');
        close(vec.norm(L.pts[0]), 1, 1e-12); close(vec.norm(L.pts[L.pts.length - 1]), 1, 1e-12);
    }
    // Within a station: later generations are younger, rooted further apart, and less sheared.
    const st = at(300).filter((L) => L.station === 6).sort((a, b) => a.generation - b.generation);
    assert.ok(st.length >= 4);
    for (let k = 1; k < st.length; k++) {
        assert.ok(st[k].age < st[k - 1].age, 'younger outward');
        assert.ok(vec.dot(st[k].footA, st[k].footB) < vec.dot(st[k - 1].footA, st[k - 1].footB), 'feet further apart');
    }
    assert.ok(FG.arcadeShear(st[0].tForm) > FG.arcadeShear(st[st.length - 1].tForm));
    // The brightening ZIPS along the PIL: the centre lights before the ends.
    const early = at(20), stations = new Set(early.map((L) => L.station));
    assert.ok(stations.has(6) && !stations.has(0) && !stations.has(12), `stations lit at t=20: ${[...stations]}`);
    // The arcade keeps growing as long as the ribbons do (the fixed-cadence version stopped at t ≈ 150).
    const top = (t) => Math.max(...at(t).map((L) => L.apexR - 1));
    assert.ok(top(320) > top(150) * 1.03, `${top(150)} → ${top(320)}`);
    assert.ok(FG.arcadeFormTime(0) === 0 && FG.arcadeFormTime(6) > 300 && FG.arcadeFormTime(6) < 320);
    // DETERMINISTIC: the same flare draws the same arcade, and a loop never changes shape between frames.
    assert.deepEqual(at(200).map((L) => L.pts[12]), at(200).map((L) => L.pts[12]));
    const a = at(200).find((L) => L.station === 4 && L.generation === 2), b = at(260).find((L) => L.station === 4 && L.generation === 2);
    // (its feet do not move; only the along-PIL envelope σ(t) rescales the station spacing slightly)
    close(a.relaxedApexR, b.relaxedApexR, 1e-12, 'a formed loop keeps its RELAXED height');
    assert.ok(b.apexR < a.apexR && b.apexR > b.relaxedApexR, 'and shrinks toward it as it ages, never past it');
    assert.ok(b.cusp < a.cusp, 'its top rounds off');
    close(a.tForm, b.tForm, 1e-12);
    // A different site is a different arcade; float noise in the same site is not.
    assert.equal(FG.arcadeSeed(14 * DEG, 28 * DEG), FG.arcadeSeed(14 * DEG + 1e-9, 28 * DEG - 1e-9));
    assert.notEqual(FG.arcadeSeed(14 * DEG, 28 * DEG), FG.arcadeSeed(15 * DEG, 28 * DEG));
    // NEGATIVE CONTROL: arcadeLoops (one generation) has no spread of heights or ages at all.
    const flat = FG.arcadeLoops({ ...base, t: 300 });
    assert.ok(new Set(flat.map((L) => L.apexR.toFixed(9))).size === 1, 'the single-generation arcade is one height');
    assert.ok(new Set(at(300).map((L) => L.apexR.toFixed(4))).size > 20, 'the nested arcade is not');
});

// ── Cusp-shaped new loops that relax ─────────────────────────────────────
await ok('loop shape by age: pointed and taller when it forms, the round arc when relaxed; v1 loops are the sine lift exactly', async () => {
    const FG = await import('../js/flare-geometry.js');
    const M = FG.FLARE_MODEL, C = M.params.cusp;
    for (const age of [0, 30, 120, 600, Infinity]) {
        close(M.loopProfile(0, age), 0, 1e-12); close(M.loopProfile(1, age), 0, 1e-12); close(M.loopProfile(0.5, age), 1, 1e-12);
        let prev = -1;
        for (let u = 0; u <= 0.5 + 1e-12; u += 0.01) { const v = M.loopProfile(u, age); assert.ok(v > prev - 1e-12, `profile not rising at u=${u}, age ${age}`); prev = v; }
        close(M.loopProfile(0.3, age), M.loopProfile(0.7, age), 1e-12, 'symmetric');
    }
    for (const u of [0.1, 0.25, 0.4]) {
        close(M.loopProfile(u, Infinity), Math.sin(Math.PI * u), 1e-12, 'a relaxed loop is the round arc');
        assert.ok(M.loopProfile(u, 0) < Math.sin(Math.PI * u), 'a new loop is narrower below its tip: a cusp');
    }
    close(M.loopRelax(0), 1); close(M.loopRelax(C.relaxT), Math.exp(-1), 1e-12); assert.equal(M.loopRelax(-5), 1, 'never above 1');
    close(M.loopHeightFactor(0), 1 + C.shrink, 1e-12); close(M.loopHeightFactor(Infinity), 1, 1e-12);
    // One loop followed through time: monotonically shorter and rounder, on fixed feet.
    const base = { latRad: 14 * DEG, lonRad: 28 * DEG, cls: 'X', n: 13, samples: 48 };
    const find = (t) => M.arcadeShells({ ...base, t }).find((L) => L.station === 6 && L.generation === 1);
    let last = null;
    for (const t of [30, 60, 120, 300, 700]) {
        const L = find(t); assert.ok(L, `station 6 generation 1 exists at t=${t}`);
        if (last) { assert.ok(L.apexR < last.apexR && L.cusp < last.cusp); close(vec.dot(L.footA, last.footA), 1, 1e-8, 'its feet stay put (the slow growth of the along-PIL envelope shifts a station by tens of km — measured 45 km over the flare)'); }
        last = L;
    }
    close(last.apexR, last.relaxedApexR, 3e-3 * (last.relaxedApexR - 1), 'by t = 700 it has relaxed');
    // v1: no cusp, no shrinkage — its loops are the pre-change geometry bit for bit.
    const v1 = FG.makeFlareModel(null, FG.FLARE_SHAPE_V1);
    for (const L of v1.arcadeShells({ ...base, t: 200 })) {
        assert.equal(L.apexR, L.relaxedApexR); assert.equal(L.cusp, 0);
        const j = 12, u = j / 48, r = vec.norm(L.pts[j]);
        close(r, 1 + (L.apexR - 1) * Math.sin(Math.PI * u), 1e-15, 'sine lift');
    }
});

// ── J-shaped ribbon ends ─────────────────────────────────────────────────
await ok('ribbonJ: the straight ribbon exactly at sweep 0; distance and arc length agree with brute force on the curve', async () => {
    const FG = await import('../js/flare-geometry.js');
    const sep = 0.03, s0 = 0.08, rho = 0.02;
    for (const [a, c] of [[0, 0.03], [0.05, 0.01], [-0.2, 0.06], [0.3, -0.02]]) {
        const [d, s] = FG.ribbonJ(a, c, sep, s0, rho, 0);
        assert.equal(d, Math.abs(c - sep)); assert.equal(s, a);
    }
    for (const sweepDeg of [60, 120, 170, 250]) {
        const sweep = sweepDeg * DEG;
        // The curve, densely: the line from far left to s0, then the arc.
        const curve = [];
        for (let i = 0; i <= 4000; i++) { const a = -0.5 + (s0 + 0.5) * i / 4000; curve.push([a, sep, a]); }
        for (let i = 1; i <= 4000; i++) { const phi = sweep * i / 4000; curve.push([s0 + rho * Math.sin(phi), sep + rho * (1 - Math.cos(phi)), s0 + rho * phi]); }
        let rnd = 12345;
        const rand = () => ((rnd = Math.imul(rnd, 1103515245) + 12345 >>> 0) / 4294967296);
        for (let k = 0; k < 400; k++) {
            const a = -0.1 + 0.3 * rand(), c = -0.02 + 0.12 * rand();
            // Exact point-to-SEGMENT distance over the polyline (a point-to-vertex search is coarser than the thing it checks).
            let best = Infinity, bs = 0;
            for (let i = 1; i < curve.length; i++) {
                const [x0, y0, t0] = curve[i - 1], [x1, y1, t1] = curve[i];
                const ex = x1 - x0, ey = y1 - y0, L2 = ex * ex + ey * ey;
                const u = L2 > 0 ? Math.min(1, Math.max(0, ((a - x0) * ex + (c - y0) * ey) / L2)) : 0;
                const d = Math.hypot(a - (x0 + u * ex), c - (y0 + u * ey));
                if (d < best) { best = d; bs = t0 + u * (t1 - t0); }
            }
            const [d, s] = FG.ribbonJ(a, c, sep, s0, rho, sweep);
            // The arc is a 4000-gon here: its sagitta (rho·(sweep/4000)²/8) bounds the disagreement.
            close(d, best, 1e-8, `distance at (${a.toFixed(3)}, ${c.toFixed(3)}), sweep ${sweepDeg}`);
            // s is only compared where the nearest point is unambiguous (not near the medial axis between line and arc).
            if (Math.abs(s - bs) > 1e-3) {
                let second = Infinity;
                for (const [x, y, s2] of curve) { if (Math.abs(s2 - bs) < 0.01) continue; const dd = Math.hypot(a - x, c - y); if (dd < second) second = dd; }
                assert.ok(second - best < 1e-3, `arc length at (${a.toFixed(3)}, ${c.toFixed(3)}): ${s} vs ${bs}`);
            }
        }
    }
    // On the curve the distance is 0 and s is the arc length; the hook's tip is at s0 + rho·sweep.
    const sw = 170 * DEG;
    const tip = [s0 + rho * Math.sin(sw), sep + rho * (1 - Math.cos(sw))];
    const [dt, st] = FG.ribbonJ(tip[0], tip[1], sep, s0, rho, sw);
    close(dt, 0, 1e-12); close(st, s0 + rho * sw, 1e-9);
});

await ok('RIBBON_J_GLSL is ribbonJ: the shader text, transliterated to JS, gives the same numbers', async () => {
    const FG = await import('../js/flare-geometry.js');
    const m = /vec2 ribbonJ\(([^)]*)\)\s*\{([\s\S]*?)\n    \}/.exec(FG.RIBBON_J_GLSL);
    assert.ok(m, 'found the GLSL function');
    assert.ok(!FG.RIBBON_J_GLSL.includes('`'), 'no backtick inside the GLSL (it would end the template literal)');
    const args = m[1].split(',').map((x) => x.trim().replace(/^float\s+/, ''));
    let body = m[2]
        .replace(/length\(vec2\(([^()]*(?:\([^()]*\)[^()]*)*)\)\)/g, 'Math.hypot($1)')
        .replace(/\bvec2\(/g, 'V2(')
        .replace(/\b(float|bool)\s+/g, 'let ')
        .replace(/\batan\(/g, 'Math.atan2(').replace(/\b(abs|sin|cos|min|max)\(/g, 'Math.$1(');
    const glsl = new Function(...args, 'const V2 = (x, y) => [x, y];\n' + body);
    let rnd = 777;
    const rand = () => ((rnd = Math.imul(rnd, 1103515245) + 12345 >>> 0) / 4294967296);
    for (let k = 0; k < 2000; k++) {
        const a = -0.3 + 0.6 * rand(), c = -0.1 + 0.25 * rand(), sep = 0.005 + 0.05 * rand(), s0 = 0.02 + 0.1 * rand();
        const rho = k % 7 === 0 ? 0 : 0.005 + 0.03 * rand(), sweep = k % 5 === 0 ? 0 : 4.5 * rand();
        const j = FG.ribbonJ(a, c, sep, s0, rho, sweep), g = glsl(a, c, sep, s0, rho, sweep);
        close(g[0], j[0], 1e-12); close(g[1], j[1], 1e-12);
    }
});

await ok('ribbonCurves: a double-J — hooks at opposite ends, opening away from the PIL; chirality mirrors it; v1 is straight', async () => {
    const FG = await import('../js/flare-geometry.js');
    const M = FG.FLARE_MODEL, lat = 14 * DEG, lon = 28 * DEG, t = 210;
    const tf = FG.tangentFrame(lat, lon);
    const rc = M.ribbonCurves({ latRad: lat, lonRad: lon, t, cls: 'X', chirality: 1, samples: 64 });
    const hk = M.ribbonHook(t, 'X'), sg = M.ribbonAlongSigma(t, 'X'), H = M.params.hook;
    close(hk.s0, H.at * sg, 1e-15); close(hk.rho, H.radius * sg, 1e-15); close(hk.sweep, H.sweepDeg * DEG, 1e-15);
    assert.ok(hk.s0 > M.params.arcade.spanSigma * sg, 'the hooks begin beyond the arcade\'s last loop');
    for (const side of ['plus', 'minus']) for (const q of rc[side]) {
        close(vec.norm(q.p), 1, 1e-12, 'on the photosphere');
        close(vec.dot(q.p, tf.pilAxis), q.a, 1e-12, 'a IS the along-PIL coordinate the shader reads');
        close(vec.dot(q.p, tf.loopAxis), q.c, 1e-12);
        // Every centreline point is ON the analytic curve the shader measures distance to.
        const [d, s] = side === 'plus' ? FG.ribbonJ(q.a, q.c, rc.sep, hk.s0, hk.rho, hk.sweep) : FG.ribbonJ(-q.a, -q.c, rc.sep, hk.s0, hk.rho, hk.sweep);
        close(d, 0, 1e-12); close(s, q.s, 1e-9);
    }
    // The minus ribbon is the plus ribbon turned 180°.
    rc.plus.forEach((q, i) => { close(rc.minus[i].a, -q.a, 1e-15); close(rc.minus[i].c, -q.c, 1e-15); });
    // Hooks: + ribbon's at the +along end and beyond +sep; nothing ever crosses toward the PIL.
    const tipP = rc.plus[rc.plus.length - 1], tipM = rc.minus[rc.minus.length - 1];
    assert.ok(tipP.a > 0 && tipP.c > rc.sep + hk.rho && tipM.a < 0 && tipM.c < -rc.sep - hk.rho);
    assert.ok(rc.plus.every((q) => q.c >= rc.sep - 1e-15) && rc.minus.every((q) => q.c <= -rc.sep + 1e-15), 'a hook opens AWAY from the inversion line');
    // Chirality mirrors along the PIL, and the arcade's shear with it.
    const rm = M.ribbonCurves({ latRad: lat, lonRad: lon, t, cls: 'X', chirality: -1, samples: 64 });
    rc.plus.forEach((q, i) => { close(rm.plus[i].a, -q.a, 1e-15); close(rm.plus[i].c, q.c, 1e-15); });
    const foot = (chi) => { const L = M.arcadeShells({ latRad: lat, lonRad: lon, t, cls: 'X', n: 13, chirality: chi }).find((x) => x.station === 6 && x.generation === 0); return vec.dot(L.footA, tf.pilAxis) - vec.dot(L.footB, tf.pilAxis); };
    assert.ok(foot(1) > 0 && foot(-1) < 0, 'the + ribbon\'s feet are displaced toward ITS hook');
    close(foot(1), -foot(-1), 1e-12);
    assert.equal(FG.helicityChirality(10 * DEG), 1); assert.equal(FG.helicityChirality(-10 * DEG), -1);
    // v1: straight ribbons — no point leaves c = ±sep.
    const v1 = FG.makeFlareModel(null, FG.FLARE_SHAPE_V1).ribbonCurves({ latRad: lat, lonRad: lon, t, cls: 'X' });
    assert.ok(v1.plus.every((q) => q.c === v1.sep) && v1.minus.every((q) => q.c === -v1.sep));
});

// ── The erupting flux rope ───────────────────────────────────────────────
await ok('rope kinematics: h0 at onset, a slow rise, an acceleration peaking at t0, a coast at speed × class; height is the integral of speed', async () => {
    const FG = await import('../js/flare-geometry.js');
    const M = FG.FLARE_MODEL, P = M.params.rope, V = P.speed * M.classFactor('X');
    close(M.ropeApexHeight(0, 'X'), P.h0, 1e-15); close(M.ropeApexHeight(-50, 'X'), P.h0, 1e-15, 'nothing happens before onset');
    close(M.ropeSpeed(P.t0, 'X'), V / 2, 1e-12, 'half the final speed at t0');
    close(M.ropeSpeed(1e5, 'X'), V, 1e-9, 'coasts at speed × classFactor');
    assert.ok(M.ropeSpeed(0, 'X') < 0.1 * V, 'slow at onset');
    assert.ok(M.ropeSpeed(600, 'C') < M.ropeSpeed(600, 'M') && M.ropeSpeed(600, 'M') < M.ropeSpeed(600, 'X'));
    // dh/dt = v, by central differences, across the whole rise.
    for (const t of [1, 60, 180, 400, 900]) close((M.ropeApexHeight(t + 0.01, 'X') - M.ropeApexHeight(t - 0.01, 'X')) / 0.02, M.ropeSpeed(t, 'X'), 1e-8 + 1e-6 * V);
    // The acceleration is largest at t0 and equals V/(4·tau) there.
    const st0 = M.ropeState(P.t0, 'X');
    close(st0.accel, V / (4 * P.tau), 1e-12);
    assert.ok(M.ropeState(P.t0 - 60, 'X').accel < st0.accel && M.ropeState(P.t0 + 60, 'X').accel < st0.accel);
    // State: present from onset, self-similar, gone by fadeR.
    const s1 = M.ropeState(120, 'X');
    assert.ok(s1.active && s1.alpha === 1); close(s1.apexR, 1 + s1.apexH, 1e-15); close(s1.minorR, P.radius * s1.apexH, 1e-15);
    assert.equal(M.ropeState(0, 'X').alpha, 0, 'fades in');
    let tFade = 0; while (M.ropeState(tFade, 'X').apexR < P.fadeR && tFade < 5000) tFade += 5;
    assert.equal(M.ropeState(tFade + 5, 'X').alpha, 0, 'it has faded out by fadeR');
    let prev = 2;
    for (let t = 10; t <= tFade; t += 10) { const a = M.ropeState(t, 'X').alpha; assert.ok(a <= prev + 1e-12, 'presence never comes back'); prev = a; }
    // v1 has no rope at all.
    const v1 = FG.makeFlareModel(null, FG.FLARE_SHAPE_V1);
    assert.ok(!v1.ropeState(100, 'X').active && v1.ropeState(100, 'X').alpha === 0 && v1.ropeSpeed(100, 'X') === 0);
});

await ok('rope geometry: feet at the hooks\' centres, an orthonormal frame, a sigmoid that straightens, twist of the stated turns and hand', async () => {
    const FG = await import('../js/flare-geometry.js');
    const M = FG.FLARE_MODEL, P = M.params.rope, lat = 14 * DEG, lon = 28 * DEG, t = 60, N = 96;
    const tf = FG.tangentFrame(lat, lon);
    const ax = M.ropeAxis({ latRad: lat, lonRad: lon, t, cls: 'X', chirality: 1, samples: N });
    const hk = M.ribbonHook(t, 'X'), sep = M.ribbonSeparation(t, 'X');
    // Feet: on the photosphere, at the centre of each ribbon's hook arc — the + foot under the +across ribbon's hook.
    close(ax.footAC[1][0], P.footAlong * hk.s0, 1e-15); close(ax.footAC[1][1], sep + hk.rho, 1e-15);
    assert.equal(P.footAlong, 1, 'the shipped rope stands at the centre of each hook');
    close(ax.footAC[0][0], -hk.s0, 1e-15); close(ax.footAC[0][1], -(sep + hk.rho), 1e-15);
    for (const f of ax.feet) close(vec.norm(f), 1, 1e-12);
    close(vec.norm(vec.add(ax.pts[0], vec.scale(ax.feet[0], -1))), 0, 1e-12); close(vec.norm(vec.add(ax.pts[N], vec.scale(ax.feet[1], -1))), 0, 1e-12);
    for (const [a, c] of [ax.footAC[1]]) { const [d] = FG.ribbonJ(a, c, sep, hk.s0, hk.rho, hk.sweep); close(d, hk.rho, 1e-12, 'the hook arc passes one radius from the foot: it wraps it'); }
    // Apex: the middle of the axis stands apexH up.
    close(Math.max(...ax.pts.map(vec.norm)), 1 + ax.state.apexH, 2e-4);
    for (const { T, N: Nn, B } of ax.frames) {
        close(vec.norm(T), 1, 1e-12); close(vec.norm(Nn), 1, 1e-12); close(vec.norm(B), 1, 1e-12);
        close(vec.dot(T, Nn), 0, 1e-12); close(vec.dot(vec.cross(Nn, B), T), 1, 1e-12, 'N × B = T');
    }
    close(ax.radius[0], ax.footRadius, 1e-15); close(ax.radius[N], ax.footRadius, 1e-12); close(ax.footRadius, P.footRadius * hk.rho, 1e-15);
    close(Math.max(...ax.radius), Math.max(ax.state.minorR, ax.footRadius), 1e-12);
    // SIGMOID: low in the atmosphere the middle of the axis runs closer to the inversion line than the feet's chord does…
    const ang = (p, q) => Math.abs(Math.atan2(vec.dot(vec.add(q, vec.scale(p, -1)), tf.loopAxis), vec.dot(vec.add(q, vec.scale(p, -1)), tf.pilAxis)));
    const low = M.ropeAxis({ latRad: lat, lonRad: lon, t: 1, cls: 'X', samples: N });
    const chord = ang(low.feet[0], low.feet[1]), mid = ang(low.pts[N / 2 - 2], low.pts[N / 2 + 2]);
    assert.ok(mid < chord - 5 * DEG, `the rope's middle is ${(mid / DEG).toFixed(1)}° from the PIL, its chord ${(chord / DEG).toFixed(1)}°`);
    assert.ok(Math.abs(mid - (1 - P.sigmoid) * chord) < 2.5 * DEG, 'turned back by the stated fraction of the chord\'s angle — not past the inversion line');
    // …and the bend fades as it rises (÷ apex height).
    const bendOf = (tt) => { const a = M.ropeAxis({ latRad: lat, lonRad: lon, t: tt, cls: 'X', samples: N }); const q = a.pts[N / 4]; const p0 = vec.unit(q);
        const f0 = a.feet[0], f1 = a.feet[1]; const lin = vec.unit(vec.add(vec.scale(f0, 0.75), vec.scale(f1, 0.25)));
        // ACROSS the foot-to-foot line only: along it the leg also leans out as the rope rises (the spread), which is not the S.
        const across = vec.unit(vec.cross(tf.radial, vec.add(f1, vec.scale(f0, -1))));
        return Math.abs(vec.dot(vec.add(p0, vec.scale(lin, -1)), across)); };
    assert.ok(bendOf(400) < 0.5 * bendOf(1), 'the S straightens as the rope rises');
    // Chirality mirrors the feet along the PIL.
    const axm = M.ropeAxis({ latRad: lat, lonRad: lon, t, cls: 'X', chirality: -1, samples: N });
    close(axm.footAC[1][0], -ax.footAC[1][0], 1e-15); close(axm.footAC[1][1], ax.footAC[1][1], 1e-15);

    // STRANDS: on the tube, above the photosphere, winding `twist` turns — left-handed for χ = +1.
    const strands = M.ropeStrands({ latRad: lat, lonRad: lon, t: 200, cls: 'X', chirality: 1, n: 18, samples: N });
    const ax2 = M.ropeAxis({ latRad: lat, lonRad: lon, t: 200, cls: 'X', chirality: 1, samples: N });
    assert.equal(strands.length, 18);
    assert.ok(strands.some((s) => s.cool) && strands.some((s) => !s.cool));
    const winding = (S, axis) => {
        let total = 0, prevTh = null;
        for (let i = 4; i <= N - 4; i++) {
            // About the strand's OWN centre line: the axis for a field line, the axis lowered by `offset` of the tube radius for the filament.
            const dvec = vec.add(vec.add(S.pts[i], vec.scale(axis.pts[i], -1)), vec.scale(axis.frames[i].N, S.offset * axis.radius[i]));
            const th = Math.atan2(vec.dot(dvec, axis.frames[i].B), vec.dot(dvec, axis.frames[i].N));
            if (prevTh != null) { let d = th - prevTh; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; total += d; }
            prevTh = th;
        }
        return total / (2 * Math.PI) * N / (N - 8);        // turns, scaled to the whole length
    };
    for (const S of strands) {
        assert.ok(S.pts.every((p) => vec.norm(p) >= 1.0005 - 1e-12), 'no strand dips below the photosphere');
        const i = N / 2, dvec = vec.add(vec.add(S.pts[i], vec.scale(ax2.pts[i], -1)), vec.scale(ax2.frames[i].N, S.offset * ax2.radius[i]));
        close(vec.norm(dvec), ax2.radius[i] * S.shell, 1e-9, 'on its shell of the tube at the apex');
        assert.ok(S.offset + S.shell <= 1 + 1e-12, 'inside the tube');
        assert.ok(S.weight > 0 && S.weight <= 1);
        close(winding(S, ax2), -P.twist, 0.02, 'χ = +1 winds LEFT-handed (negative helicity), `twist` turns');
    }
    // NOT A SPIROGRAPH: the field lines lie on many shells, not two, and are not equally bright.
    const hot = strands.filter((s) => !s.cool), coolS = strands.filter((s) => s.cool);
    assert.ok(new Set(hot.map((s) => s.shell.toFixed(3))).size === hot.length, 'every field line on its own shell');
    assert.ok(Math.max(...hot.map((s) => s.shell)) > 0.9 && Math.min(...hot.map((s) => s.shell)) < 0.5, 'from the core to the skin');
    assert.ok(Math.max(...hot.map((s) => s.weight)) > 1.8 * Math.min(...hot.map((s) => s.weight)), 'uneven brightness');
    // THE FILAMENT RIDES IN THE ROPE'S UNDERSIDE: at the apex every cool strand is BELOW the axis, in a thin bundle.
    for (const S of coolS) {
        assert.equal(S.offset, P.filament);
        assert.ok(vec.norm(S.pts[N / 2]) < vec.norm(ax2.pts[N / 2]) - 0.15 * ax2.radius[N / 2], 'below the axis at the apex');
        assert.ok(S.shell < 0.3, 'a thin bundle');
    }
    // NEGATIVE CONTROL: with `filament` 0 the cool strands are ordinary field lines again, half of them above the axis.
    const noFil = FG.makeFlareModel({ rope: { filament: 0 } }).ropeStrands({ latRad: lat, lonRad: lon, t: 200, cls: 'X', chirality: 1, n: 18, samples: N }).filter((s) => s.cool);
    assert.ok(noFil.every((s) => s.offset === 0 && s.shell >= 0.38) && noFil.some((s) => vec.norm(s.pts[N / 2]) > vec.norm(ax2.pts[N / 2])));

    // THE ROPE WIDENS AS IT RISES, AND ITS FRAME SURVIVES THAT. High up, the legs lean out beyond the feet…
    const angFromSite = (p) => Math.acos(Math.min(1, vec.dot(vec.unit(p), tf.radial)));
    const high = M.ropeAxis({ latRad: lat, lonRad: lon, t: 340, cls: 'X', chirality: 1, samples: N });
    const footAng = Math.max(angFromSite(high.feet[0]), angFromSite(high.feet[1])), legAng = Math.max(...high.pts.map(angFromSite));
    assert.ok(high.state.apexH > 0.7, 'the check is of a risen rope');
    assert.ok(legAng > footAng + 0.6 * P.spread * (high.state.apexH - P.h0) / (high.state.apexH - P.h0 + P.spreadH), `legs lean out: ${(legAng / DEG).toFixed(1)}° vs feet ${(footAng / DEG).toFixed(1)}°`);
    close(vec.norm(high.pts[0]), 1, 1e-12); close(vec.norm(vec.add(high.pts[0], vec.scale(high.feet[0], -1))), 0, 1e-12, 'the feet do not move');
    close(angFromSite(low.pts[N / 4]), angFromSite(FG.makeFlareModel({ rope: { spread: 0 } }).ropeAxis({ latRad: lat, lonRad: lon, t: 1, cls: 'X', samples: N }).pts[N / 4]), 2e-3, 'low down it is still the sigmoid over the inversion line');
    // …and (NEGATIVE CONTROL) with `spread` 0 they never do: the hairpin, whose tube outgrows the gap between its own legs.
    const pin = FG.makeFlareModel({ rope: { spread: 0 } }).ropeAxis({ latRad: lat, lonRad: lon, t: 340, cls: 'X', chirality: 1, samples: N });
    assert.ok(Math.max(...pin.pts.map(angFromSite)) < footAng + 1e-9);
    const gap = (a) => vec.norm(vec.add(a.pts[N / 4], vec.scale(a.pts[3 * N / 4], -1))) - a.radius[N / 4] - a.radius[3 * N / 4];
    assert.ok(gap(high) > 0 && gap(pin) < 0, `legs clear by ${gap(high).toFixed(3)} R☉ (hairpin: ${gap(pin).toFixed(3)})`);
    // The frame turns smoothly all the way down both legs…
    const turn = (a, b) => Math.acos(Math.max(-1, Math.min(1, vec.dot(a, b)))) / DEG;
    let worst = 0; for (let i = 1; i <= N; i++) worst = Math.max(worst, turn(high.frames[i - 1].N, high.frames[i].N));
    assert.ok(worst < 12, `the frame's worst turn between samples is ${worst.toFixed(1)}°`);
    close(vec.dot(high.frames[N / 2].N, vec.unit(high.pts[N / 2])), 1, 1e-6, 'at the apex N is the vertical: −N is the rope\'s underside');
    // …where (NEGATIVE CONTROL) the frame as first written — the vertical made perpendicular to T at every point — FLIPS on a leg that leans out.
    let flip = 0;
    for (let i = 1; i <= N; i++) {
        const nOld = (k) => { const T = high.frames[k].T, up = vec.unit(high.pts[k]); return vec.unit(vec.add(up, vec.scale(T, -vec.dot(up, T)))); };
        flip = Math.max(flip, turn(nOld(i - 1), nOld(i)));
    }
    assert.ok(flip > 90, `the per-point frame turns ${flip.toFixed(0)}° between two samples`);

    const right = M.ropeStrands({ latRad: lat, lonRad: lon, t: 200, cls: 'X', chirality: -1, n: 6, samples: N });
    const axr = M.ropeAxis({ latRad: lat, lonRad: lon, t: 200, cls: 'X', chirality: -1, samples: N });
    close(winding(right[0], axr), P.twist, 0.02, 'χ = −1 winds right-handed');
    // Deterministic: the same flare draws the same rope.
    assert.deepEqual(M.ropeStrands({ latRad: lat, lonRad: lon, t: 200, cls: 'X', n: 6 })[3].pts[40], M.ropeStrands({ latRad: lat, lonRad: lon, t: 200, cls: 'X', n: 6 })[3].pts[40]);
});

await ok('plasma along a loop: it fills from its feet at the evaporation speed, then rains at the rain speed; v1 loops are always full', async () => {
    const FG = await import('../js/flare-geometry.js');
    const M = FG.FLARE_MODEL, F = M.params.flow, V1 = FG.makeFlareModel(null, FG.FLARE_SHAPE_V1);
    // FILL: the front is at evap × age along a leg of the loop's own half-length; twice the length takes twice as long.
    close(M.loopFlow({ age: 10, halfLength: 0.05 }).fill, F.evap * 10 / 0.05, 1e-15);
    close(M.loopFlow({ age: 10, halfLength: 0.10 }).fill, 0.5 * M.loopFlow({ age: 10, halfLength: 0.05 }).fill, 1e-15);
    assert.equal(M.loopFlow({ age: 0, halfLength: 0.05 }).fill, 0, 'a loop that has just formed is lit only at its feet');
    assert.equal(M.loopFlow({ age: 1e6, halfLength: 0.05 }).fill, 2, 'and stays full once filled');
    // RAIN: none before the onset age, all of it one ramp later, and the clumps then travel at the rain speed.
    assert.equal(M.loopFlow({ age: F.rainOnset - 1, halfLength: 0.05 }).rain, 0);
    assert.equal(M.loopFlow({ age: F.rainOnset + F.rainRamp, halfLength: 0.05 }).rain, 1);
    const p0 = M.loopFlow({ age: F.rainOnset + 100, halfLength: 0.05 }), p1 = M.loopFlow({ age: F.rainOnset + 101, halfLength: 0.05 });
    close((p1.rainPhase - p0.rainPhase) / F.clumps * 0.05, F.rain, 1e-12, 'a clump moves rain × Δt along the leg');
    // NEGATIVE CONTROL (v1, the loops as drawn before): always full, never raining — and the gain is then exactly 1.
    for (const age of [0, 5, 300, 900]) { const f = V1.loopFlow({ age, halfLength: 0.05 }); assert.equal(f.fill, 2); assert.equal(f.rain, 0);
        for (const arc of [0, 0.13, 0.5, 0.91, 1]) assert.equal(FG.strandFlowGain(arc, 1, f.fill, f.rain, f.rainPhase, f.clumps), 1); }
    assert.equal(FG.polylineLength([[0, 0, 0], [3, 4, 0], [3, 4, 12]]), 17);

    // THE GAIN (strandFlowGain): mode 0 is 1; a half-filled loop is lit below its front and dark above it, with the front brightest…
    assert.equal(FG.strandFlowGain(0.3, 0, 0.4, 1, 3, 3.5), 1);
    const g = (arc, fill) => FG.strandFlowGain(arc, 1, fill, 0, 0, 3.5);
    close(g(0.05, 0.5), 1, 1e-6, 'lit near the foot'); assert.ok(g(0.5, 0.5) < 1e-6, 'dark at the top');
    assert.ok(g(0.25, 0.5) > 1.5 && g(0.75, 0.5) > 1.5, 'the evaporation front, on both legs');
    close(g(0.2, 0.5), g(0.8, 0.5), 1e-12, 'the two legs fill alike');
    // …and rain clumps move TOWARD THE FEET as the travel grows: the brightest point of a leg is lower later.
    const peak = (phase) => { let best = 0, at = 0; for (let i = 20; i <= 480; i++) { const arc = i / 1000; const v = FG.strandFlowGain(arc, 1, 2, 1, phase, 3.5); if (v > best) { best = v; at = arc; } } return at; };
    assert.ok(peak(0.10) < peak(0.0) && peak(0.20) < peak(0.10), `rain falls: ${peak(0).toFixed(3)} → ${peak(0.1).toFixed(3)} → ${peak(0.2).toFixed(3)}`);
    // The two legs do not rain in step.
    assert.ok(Math.abs(FG.strandFlowGain(0.3, 1, 2, 1, 0.4, 3.5) - FG.strandFlowGain(0.7, 1, 2, 1, 0.4, 3.5)) > 0.05);
    // A sheet (mode 2): blobs move AWAY from the parting point on both sides.
    const peakIn = (phase, lo, hi) => { let best = 0, at = 0; for (let i = 0; i <= 400; i++) { const arc = lo + (hi - lo) * i / 400; const v = FG.strandFlowGain(arc, 2, 0.3, 1, phase, 4); if (v > best) { best = v; at = arc; } } return at; };
    assert.ok(peakIn(0.30, 0.45, 0.70) > peakIn(0.20, 0.45, 0.70), 'above the parting point they move up');
    assert.ok(peakIn(0.30, 0.05, 0.28) < peakIn(0.22, 0.05, 0.28), 'below it they move down');
    // A sheet line fades into both of its ends (a ribbon ends square; its halo must not).
    assert.equal(FG.strandFlowGain(0, 2, 0.3, 1, 1.7, 2), 0); assert.equal(FG.strandFlowGain(1, 2, 0.3, 1, 1.7, 2), 0);
    assert.ok(FG.strandFlowGain(0.5, 2, 0.3, 0, 1.7, 2) === 1, 'and is untouched in between');
});

await ok('STRAND_FLOW_GLSL is strandFlowGain: the shader text, transliterated to JS, gives the same numbers', async () => {
    const FG = await import('../js/flare-geometry.js');
    assert.ok(!FG.STRAND_FLOW_GLSL.includes('`'), 'no backtick inside the GLSL');
    const fn = (name) => {
        const m = new RegExp('float ' + name + '\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n    \\}').exec(FG.STRAND_FLOW_GLSL);
        assert.ok(m, 'found ' + name);
        const args = m[1].split(',').map((x) => x.trim().replace(/^float\s+/, ''));
        const body = m[2].replace(/\bfloat\s+/g, 'let ').replace(/\b(abs|sin|exp|min|max)\(/g, 'Math.$1(');
        return [args, body];
    };
    const [ca, cb] = fn('strandFlowClump'), [ga, gb] = fn('strandFlowGain');
    const prelude = 'const mix = (x, y, a) => x * (1 - a) + y * a; const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };\n';
    const clump = new Function(...ca, cb);
    const gain = new Function('strandFlowClump', ...ga, prelude + gb);
    let rnd = 4242; const rand = () => ((rnd = Math.imul(rnd, 1103515245) + 12345 >>> 0) / 4294967296);
    for (let k = 0; k < 3000; k++) {
        const arc = rand(), mode = k % 3, p1 = mode === 2 ? rand() : 2.2 * rand(), p2 = rand(), p3 = 20 * rand(), kk = 2 + 4 * rand();
        close(gain(clump, arc, mode, p1, p2, p3, kk), FG.strandFlowGain(arc, mode, p1, p2, p3, kk), 1e-12);
        close(clump(p3), FG.strandFlowClump(p3), 1e-15);
    }
    // The strand shader interpolates it and never retypes it.
    const arc = _readArcade(new URL('../js/flare-arcade.js', import.meta.url), 'utf8');
    assert.ok(arc.includes('${flowGlsl}') && arc.includes('FG.STRAND_FLOW_GLSL') && !arc.includes('float strandFlowGain('));
});

await ok('the current sheet: from the arcade\'s top to the rope\'s underside, outflow at the stated speed; none without a rope', async () => {
    const FG = await import('../js/flare-geometry.js');
    const M = FG.FLARE_MODEL, F = M.params.flow, lat = 14 * DEG, lon = 20 * DEG, N = 24;
    for (const t of [120, 200, 300]) {
        const ss = M.sheetState(t, 'X'), st = M.ropeState(t, 'X');
        assert.ok(ss.active && ss.length > 0);
        close(ss.highH, st.apexH - st.minorR, 1e-15, 'its top is the rope\'s underside');
        close(ss.lowH, M.arcadeHeight(t, 'X') * (1 + M.params.cusp.shrink), 1e-15, 'its foot is where the newest, still-pointed loops end');
        const lines = M.sheetStrands({ latRad: lat, lonRad: lon, t, cls: 'X', chirality: 1, n: 7, samples: N });
        assert.equal(lines.length, 7);
        const ax = M.ropeAxis({ latRad: lat, lonRad: lon, t, cls: 'X', chirality: 1, samples: 96 });
        for (const S of lines) {
            close(vec.norm(S.pts[0]), 1 + ss.lowH, 1e-9, 'starts on the arcade\'s top');
            for (let i = 1; i <= N; i++) assert.ok(vec.norm(S.pts[i]) > vec.norm(S.pts[i - 1]), 'rises all the way');
            // It ends ON the rope's tube, on its underside: one tube radius from the axis, toward the Sun.
            let miss = Infinity, bi = 0;
            ax.pts.forEach((p, i) => { const d = Math.abs(vec.norm(vec.add(S.pts[N], vec.scale(p, -1))) - ax.radius[i]); if (d < miss) { miss = d; bi = i; } });
            assert.ok(miss < 1e-9, `ends on the tube (off by ${miss.toExponential(2)})`);
            const off = vec.unit(vec.add(S.pts[N], vec.scale(ax.pts[bi], -1)));
            close(vec.dot(off, ax.frames[bi].N), -1, 1e-9, 'on the underside: straight along −N from the axis');
            assert.ok(bi > 96 * 0.3 && bi < 96 * 0.7, 'under the rope\'s middle, not its legs');
        }
    }
    // Outflow: the pattern's travel × the sheet's length ÷ blobs advances at sheetOut (the integral's own derivative).
    const a = M.sheetState(240, 'X'), b = M.sheetState(240.5, 'X');
    close((b.phase - a.phase) / 0.5 / F.sheetClumps * 0.5 * (a.length + b.length), F.sheetOut, 0.02 * F.sheetOut, 'blobs leave at the stated speed');
    assert.ok(b.phase > a.phase, 'and never run backwards, though the sheet is being stretched');
    // The filament drains: nothing while the rope sits, all of it once it has risen; the travel only grows.
    const d0 = M.ropeDrain({ latRad: lat, lonRad: lon, t: 5, cls: 'X' }), d1 = M.ropeDrain({ latRad: lat, lonRad: lon, t: 260, cls: 'X' }), d2 = M.ropeDrain({ latRad: lat, lonRad: lon, t: 300, cls: 'X' });
    assert.ok(d0.rain < 0.01 && d1.rain === 1 && d2.rainPhase > d1.rainPhase && d1.rainPhase > d0.rainPhase);
    // NEGATIVE CONTROLS: no rope (v1), or no sheet speed — no sheet, no lines, no drainage.
    const V1 = FG.makeFlareModel(null, FG.FLARE_SHAPE_V1);
    assert.equal(V1.sheetState(240, 'X').active, false); assert.equal(V1.sheetStrands({ latRad: lat, lonRad: lon, t: 240, cls: 'X' }).length, 0);
    assert.equal(V1.ropeDrain({ latRad: lat, lonRad: lon, t: 240, cls: 'X' }).rain, 0);
    assert.equal(FG.makeFlareModel({ flow: { sheetOut: 0 } }).sheetState(240, 'X').active, false);
});

await ok('the arcade\'s exposure control: untouched below its target, holds the target above it, never below its floor, never up', async () => {
    const loop = (o) => ({ opacity: 0.5, lenPx: 300, halfPx: 2, x0: 100, x1: 400, y0: 100, y1: 300, ...o });
    // One loop over a big box: far below the target, exposure exactly 1.
    const one = arcadeExposure([loop()]);
    close(one.light, 0.5 * 300 * 2 * STRAND_LIGHT, 1e-9); close(one.areaPx, 300 * 200 * AEC_FILL, 1e-9);
    assert.ok(one.stack < AEC_TARGET); assert.equal(one.exposure, 1);
    // Light adds, the box does not grow: N identical loops stack N-fold.
    const many = arcadeExposure(Array.from({ length: 40 }, () => loop()));
    close(many.stack, 40 * one.stack, 1e-9);
    assert.ok(many.stack > AEC_TARGET);
    close(many.exposure * many.stack, AEC_TARGET, 1e-12, 'stack × exposure = the target');
    // The same arcade seen from twice as far: lengths and widths halve, the box quarters — stacking is unchanged… until
    // the strands hit their pixel floor, where width stops shrinking and the stacking RISES.
    const far = arcadeExposure(Array.from({ length: 40 }, () => loop({ lenPx: 150, halfPx: 1, x0: 0, x1: 150, y0: 0, y1: 100 })));
    close(far.stack, many.stack, 1e-9);
    const floored = arcadeExposure(Array.from({ length: 40 }, () => loop({ lenPx: 150, halfPx: 2, x0: 0, x1: 150, y0: 0, y1: 100 })));
    close(floored.stack, 2 * many.stack, 1e-9);
    // Edge-on: the box collapses to a line and is held at two pixels across, not zero.
    const edge = arcadeExposure([loop({ x0: 200, x1: 200 })]);
    assert.ok(Number.isFinite(edge.stack)); close(edge.areaPx, 2 * 200 * AEC_FILL, 1e-9);
    // The floor, and the gain in the estimate.
    assert.equal(arcadeExposure(Array.from({ length: 4000 }, () => loop())).exposure, AEC_FLOOR);
    close(arcadeExposure([loop()], { gain: 2 }).stack, 2 * one.stack, 1e-12);
    // Nothing drawn: no division by nothing.
    assert.deepEqual(arcadeExposure([]), { stack: 0, exposure: 1, light: 0, areaPx: 0 });
    assert.deepEqual(arcadeExposure([loop({ opacity: 0 })]), { stack: 0, exposure: 1, light: 0, areaPx: 0 });
    // STRAND_LIGHT is the strand shader's own cross-profile × its mean along-loop factor — integrated here from the
    // shader's expressions (found in the source, so a retuned profile fails this until the constant follows).
    const src = _readArcade(new URL('../js/flare-arcade.js', import.meta.url), 'utf8');
    for (const frag of ['exp(-sw * sw * 1.4)', 'exp(-sw * sw * 0.14) * (1.0 - vSide * vSide)', 'core * mix(0.30, 1.0, vFloor) + 0.11 * halo', '(0.30 + 0.70 * along)', '(1.0 + 0.8 * core)', 'mix(0.45, 1.0, sA)', '0.50 + 0.50 * (1.0 - sA * sA)'])
        assert.ok(src.includes(frag), `the strand shader still reads "${frag}"`);
    const K = 4; let cross = 0;
    for (let i = 0; i < 4000; i++) { const side = -1 + (i + 0.5) / 2000, sw = side * K, core = Math.exp(-sw * sw * 1.4), halo = Math.exp(-sw * sw * 0.14) * (1 - side * side); cross += (core + 0.11 * halo) * (1 + 0.8 * core) * (K / 2000); }
    let hot = 0, cool = 0;
    for (let i = 0; i < 1000; i++) { const sA = Math.sin(Math.PI * (i + 0.5) / 1000); hot += (0.30 + 0.70 * (0.45 + 0.55 * sA)) / 1000; cool += (0.30 + 0.70 * (0.50 + 0.50 * (1 - sA * sA))) / 1000; }
    const light = cross * 0.5 * (hot + cool);
    assert.ok(Math.abs(light - STRAND_LIGHT) < 0.06 * STRAND_LIGHT, `STRAND_LIGHT ${STRAND_LIGHT} vs the shader's ${light.toFixed(3)} (cross ${cross.toFixed(3)}, along ${hot.toFixed(3)} hot / ${cool.toFixed(3)} cool)`);
    // Fuzz conserves a strand's light: HOT_FUZZ × wider, ÷ HOT_FUZZ fainter (both in the shader).
    assert.ok(HOT_FUZZ > 1 && src.includes('u_halfW * vFuzz') && src.includes('* vEndOn / vFuzz'));
});

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
