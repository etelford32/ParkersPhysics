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
import {
    diffRotFactor, slotRotAngle, solarEphemeris, heliographicToVec, REAL_TIME_ROT_MUL,
} from '../js/sun-observed.js';
import {
    DEG, SIM_ROT_RATE, OMEGA_SUN_SIDEREAL, SUN_SIDEREAL_DAYS, SUN_SYNODIC_DAYS, AU_KM, vec,
    parseStonyhurst, formatStonyhurst,
    stonyhurstToUnit, unitToStonyhurst, rotateY, rotationAngle, siteRotation,
    siteLonAt, epochLonFor, sitePositionAt,
    localFrame, joyTiltRad, bipoleAxis, pilAngleRad, tangentFrame,
    RIBBON, ribbonSeparation, ribbonWidth, ribbonAlongSigma, ribbonDecay,
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

// ── Ribbon laws mirror sunFS ─────────────────────────────────────────────
await ok('RIBBON constants mirror the sunFS legacy-fallback literals (read from sun.html)', async () => {
    const src = await readFile(fileURLToPath(new URL('../sun.html', import.meta.url)), 'utf8');
    const sep  = src.match(/float sep\s*=\s*([0-9.]+)\s*\+\s*u_flare_t\s*\*\s*([0-9.e-]+)/);
    const wid  = src.match(/float rWid\s*=\s*([0-9.]+)\s*\+\s*u_flare_t\s*\*\s*([0-9.e-]+)/);
    const varr = src.match(/float alongVar\s*=\s*([0-9.]+)\s*\+\s*u_flare_t\s*\*\s*([0-9.e-]+)/);
    const dec  = src.match(/float fDecay\s*=\s*exp\(\s*-u_flare_t\s*\/\s*([0-9.]+)\s*\)/);
    assert.ok(sep && wid && varr && dec, 'all four literals found in sunFS');
    close(+sep[1], RIBBON.SEP0); close(+sep[2], RIBBON.SEP_RATE);
    close(+wid[1], RIBBON.WID0); close(+wid[2], RIBBON.WID_RATE);
    close(+varr[1], RIBBON.ALONG_VAR0); close(+varr[2], RIBBON.ALONG_VAR_RATE);
    close(+dec[1], RIBBON.DECAY_T);
    close(ribbonSeparation(100), 0.020 + 100 * 2.5e-5); close(ribbonWidth(100), 0.005 + 100 * 6e-6);
    close(ribbonAlongSigma(0), Math.sqrt(0.10)); close(ribbonDecay(175), Math.exp(-1));
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
    const sep = ribbonSeparation(t), h = arcadeHeight(t, 'X');
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

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
