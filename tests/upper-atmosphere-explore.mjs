/**
 * tests/upper-atmosphere-explore.mjs — gate for the explore kernel
 *   node tests/upper-atmosphere-explore.mjs
 */
import assert from 'node:assert/strict';
import {
    EXPLORE, vec, localEastNorth, headingDegOf, compass8,
    orbitalSpeedKmS, cruiseSpeedKmS, greatCircleStep, turnHeading,
    stateFromPose, stateFromLatLon, explorePose, exploreStep, describeState,
    cameraPath, transitionFovGain, divePath, climbPath,
    BOUNDARIES, membraneWeight, boundaryCrossings, gridLevel,
    apToKp, troughLocalSolarTime, lonAtLocalSolarTime, exobaseAltitudeKm,
    magneticMidnightPoint, groundDistanceKm, pointsOfInterest, auroraCurtain, AURORA_CURTAIN,
    MILESTONES, milestonesReached, isAtPoi, gaugeFraction, gaugeAltitude,
    R_EARTH_KM,
} from '../js/upper-atmosphere-explore-model.js';
import {
    latLonToScene, sceneToLatLon, jacchiaDiurnalRatio, bulgeLocalSolarTime,
    localSolarTime, magneticLatitude,
} from '../js/upper-atmosphere-column.js';
import { ATMOSPHERIC_LAYER_SCHEMA } from '../js/upper-atmosphere-layers.js';
import { kpToAp } from '../js/upper-atmosphere-engine.js';
import { pointPhysics } from '../js/upper-atmosphere-physics.js';
import { auroralOvalLatBand } from '../js/upper-atmosphere-aurora-physics.js';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const { dot, len, norm, cross } = vec;
// atan2(|a×b|, a·b): accurate near 0°, where acos(a·b) is limited to ~1e-6°.
const angDeg = (a, b) => { const A = norm(a), B = norm(b); return Math.atan2(len(cross(A, B)), dot(A, B)) * 180 / Math.PI; };
const hdgDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

console.log('\n── frames ──');

t('local east/north match the canonical frame (east = −Z at Greenwich) and headings read as a compass', () => {
    const { east, north } = localEastNorth([1, 0, 0]);
    near(east[2], -1, 1e-12, 'east'); near(north[1], 1, 1e-12, 'north');
    assert.equal(localEastNorth([0, 1, 0]).east, null, 'undefined at the pole');
    const st = stateFromLatLon({ latDeg: 30, lonDeg: 40, altKm: 300, headingDeg: 123 });
    near(headingDegOf(st.u, st.h), 123, 1e-9, 'heading round-trip');
    assert.equal(compass8(0), 'N'); assert.equal(compass8(92), 'E'); assert.equal(compass8(225), 'SW');
});

t('pose ⇄ state round-trips: up is the local radial, pitch and heading survive', () => {
    const st = stateFromLatLon({ latDeg: -12, lonDeg: 150, altKm: 250, headingDeg: 300, pitchDeg: -7 });
    const pose = explorePose(st);
    near(len(pose.position), 1 + 250 / R_EARTH_KM, 1e-12, 'radius');
    near(dot(pose.up, norm(pose.position)), 1, 1e-12, 'up = radial');
    const back = stateFromPose(pose.position, pose.forward);
    near(back.altKm, 250, 1e-6); near(back.pitchRad * 180 / Math.PI, -7, 1e-9);
    near(headingDegOf(back.u, back.h), 300, 1e-9);
    // Looking straight down has no horizontal part: the state still completes.
    const down = stateFromPose([0, 0, 1.05], [0, 0, -1]);
    assert.ok(Number.isFinite(down.h[0]) && Math.abs(dot(down.h, down.u)) < 1e-12);
});

console.log('\n── flight on the sphere ──');

t('flying forward holds altitude and stays on the great circle; east along the equator stays on the equator', () => {
    let st = stateFromLatLon({ latDeg: 0, lonDeg: 10, altKm: 300, headingDeg: 90, pitchDeg: 0 });
    for (let i = 0; i < 200; i++) st = exploreStep(st, { forward: 1 }, 0.05);
    near(st.altKm, 300, 1e-9, 'altitude held at pitch 0');
    const d = describeState(st);
    near(d.latDeg, 0, 1e-9, 'still on the equator');
    // 10 s at 1.2 × 300 km/s = 3600 km of ground at r = R + 300.
    const dLon = 3600 / (R_EARTH_KM + 300) * 180 / Math.PI;
    near(d.lonDeg, 10 + dLon, 1e-6, 'longitude advanced by the cruise distance');
    near(d.headingDeg, 90, 1e-6, 'still heading east');
});

t('a full great circle comes home, and flying over the pole comes down the other side heading south', () => {
    let st = stateFromLatLon({ latDeg: 20, lonDeg: -60, altKm: 500, headingDeg: 37, pitchDeg: 0 });
    const u0 = st.u.slice();
    const circ = 2 * Math.PI * (R_EARTH_KM + 500);
    const v = cruiseSpeedKmS(500);
    const n = 400, dt = circ / v / n;
    for (let i = 0; i < n; i++) st = exploreStep(st, { forward: 1 }, dt);
    assert.ok(angDeg(st.u, u0) < 1e-6, `circumnavigation closes (${angDeg(st.u, u0)}°)`);
    let p = stateFromLatLon({ latDeg: 80, lonDeg: 0, altKm: 200, headingDeg: 0, pitchDeg: 0 });
    // 20° of arc north: over the pole to 80° on the far meridian.
    const steps = 100, arc = 20 * Math.PI / 180 * (R_EARTH_KM + 200);
    for (let i = 0; i < steps; i++) p = exploreStep(p, { forward: 1 }, arc / cruiseSpeedKmS(200) / steps);
    const d = describeState(p);
    near(d.latDeg, 80, 1e-6, 'latitude'); near(Math.abs(d.lonDeg), 180, 1e-6, 'far meridian');
    near(hdgDiff(d.headingDeg, 180), 0, 1e-6, 'now heading south');
    assert.ok(Math.abs(dot(p.h, p.u)) < 1e-12, 'heading stays tangent');
});

t('fly-where-you-look descends in log-altitude and cannot pass the floor; Q/E climb at the log rate', () => {
    let st = stateFromLatLon({ latDeg: 0, lonDeg: 0, altKm: 400, headingDeg: 90, pitchDeg: -90 + 5 });
    const pitch = st.pitchRad;
    const s1 = exploreStep(st, { forward: 1 }, 0.5);
    const expect = 400 * Math.exp(EXPLORE.cruisePerKm * Math.sin(pitch) * 0.5);
    near(s1.altKm, expect, 1e-9, 'log-altitude descent');
    for (let i = 0; i < 400; i++) st = exploreStep(st, { forward: 1, boost: true }, 0.1);
    near(st.altKm, EXPLORE.floorKm, 1e-9, 'clamped to the floor');
    let c = stateFromLatLon({ latDeg: 0, lonDeg: 0, altKm: 100, headingDeg: 0, pitchDeg: 0 });
    c = exploreStep(c, { climb: 1 }, 1);
    near(c.altKm, 100 * Math.exp(EXPLORE.climbLogRate), 1e-9, 'climb rate');
    for (let i = 0; i < 100; i++) c = exploreStep(c, { climb: 1, boost: true }, 0.5);
    near(c.altKm, EXPLORE.ceilKm, 1e-9, 'clamped to the ceiling');
});

t('turning and mouse-look: A/D turn at the rate, pitch clamps, positive turn is to the RIGHT', () => {
    let st = stateFromLatLon({ latDeg: 10, lonDeg: 0, altKm: 300, headingDeg: 0, pitchDeg: 0 });
    st = exploreStep(st, { turn: 1 }, 1);
    near(describeState(st).headingDeg, EXPLORE.turnRateDeg, 1e-6, 'north → east is a right turn');
    st = exploreStep(st, { dPitchRad: 10 }, 0);
    near(st.pitchRad * 180 / Math.PI, EXPLORE.pitchLimitDeg, 1e-9, 'pitch clamp');
    const h2 = turnHeading([0, 1, 0], [1, 0, 0], Math.PI / 2);
    near(dot(h2, [0, 0, -1]), 1, 1e-12, 'turn right of north at (0,0) is east');
});

t('cruise speed is ∝ altitude and is reported against the orbital speed', () => {
    near(cruiseSpeedKmS(400), 480, 1e-9); near(cruiseSpeedKmS(100), 120, 1e-9);
    near(cruiseSpeedKmS(400, { boost: true }), 1920, 1e-9);
    near(cruiseSpeedKmS(400, { crawl: true }), 96, 1e-9);
    near(orbitalSpeedKmS(400), 7.67, 0.01, 'v_circ at 400 km');
    near(cruiseSpeedKmS(5), cruiseSpeedKmS(EXPLORE.floorKm), 1e-12, 'floor-clamped');
});

console.log('\n── transitions ──');

function checkPath(path, from, to, label) {
    const a = path.at(0), b = path.at(1);
    for (let i = 0; i < 3; i++) {
        near(a.position[i], from.pos[i], 1e-12, `${label} start pos`);
        near(b.position[i], to.pos[i], 1e-12, `${label} end pos`);
    }
    assert.ok(angDeg(a.forward, from.fwd) < 1e-9, `${label} start forward`);
    assert.ok(angDeg(b.forward, to.fwd) < 1e-9, `${label} end forward`);
    assert.ok(angDeg(b.up, to.up) < 1e-9, `${label} end up`);
    const altMin = Math.min((len(from.pos) - 1) * R_EARTH_KM, (len(to.pos) - 1) * R_EARTH_KM);
    let prev = null, maxTurn = 0;
    for (let i = 0; i <= 400; i++) {
        const p = path.at(i / 400);
        assert.ok(p.position.every(Number.isFinite) && p.forward.every(Number.isFinite) && p.up.every(Number.isFinite), `${label} finite at ${i}`);
        near(len(p.forward), 1, 1e-9, `${label} |fwd|`);
        const alt = (len(p.position) - 1) * R_EARTH_KM;
        assert.ok(alt >= altMin - 1e-6, `${label} dips to ${alt} km below the lower end ${altMin}`);
        assert.ok(Math.abs(dot(p.forward, norm(p.up))) < 0.9999, `${label} forward ∥ up at ${i}`);
        if (prev) maxTurn = Math.max(maxTurn, angDeg(prev.forward, p.forward));
        prev = p;
    }
    return maxTurn;
}

t('a dive from the orbit view lands exactly on its destination, level, never below it on the way', () => {
    const from = { pos: [0, 0.65 * 3.4, 3.4], fwd: norm([0, -0.65 * 3.4, -3.4]), up: [0, 1, 0] };
    const path = divePath({ fromPos: from.pos, fromFwd: from.fwd, fromUp: from.up,
        latDeg: -30, lonDeg: 140, altKm: 200, pitchDeg: -8 });
    const pose = explorePose(path.endState);
    const maxTurn = checkPath(path, from, { pos: pose.position, fwd: pose.forward, up: pose.up }, 'dive');
    assert.ok(maxTurn < 6, `view turns smoothly (max ${maxTurn.toFixed(2)}° per 1/400 of the path)`);
    near(describeState(path.endState).pitchDeg, -8, 1e-9);
    // Arrives heading along the direction of travel.
    const s1 = path.at(0.999).position, s2 = path.at(1).position;
    const travel = vec.tangent(vec.norm([s2[0] - s1[0], s2[1] - s1[1], s2[2] - s1[2]]), norm(s2));
    assert.ok(angDeg(travel, path.endState.h) < 2, 'arrives flying forward');
    assert.ok(path.durationSec >= 2.5 && path.durationSec <= 9);
});

t('dives survive the degenerate cases: straight down onto the sub-camera point, and to the antipode', () => {
    const pos = [0, 0, 3.2], fwd = [0, 0, -1], up = [0, 1, 0];
    const ll = sceneToLatLon(norm(pos));
    const down = divePath({ fromPos: pos, fromFwd: fwd, fromUp: up, ...ll, altKm: 300 });
    checkPath(down, { pos, fwd, up }, (() => { const p = explorePose(down.endState); return { pos: p.position, fwd: p.forward, up: p.up }; })(), 'straight down');
    near(down.arcDeg, 0, 1e-6);
    const anti = divePath({ fromPos: pos, fromFwd: [1, 0, 0], fromUp: up,
        latDeg: -ll.latDeg, lonDeg: ll.lonDeg + 180, altKm: 300 });
    near(anti.arcDeg, 180, 1e-6);
    checkPath(anti, { pos, fwd: [1, 0, 0], up }, (() => { const p = explorePose(anti.endState); return { pos: p.position, fwd: p.forward, up: p.up }; })(), 'antipode');
});

t('the climb out rises radially over the same ground and hands OrbitControls a +Y-up view of the centre', () => {
    const st = stateFromLatLon({ latDeg: 40, lonDeg: -100, altKm: 180, headingDeg: 45, pitchDeg: -5 });
    const pose = explorePose(st);
    const path = climbPath({ fromPos: pose.position, fromFwd: pose.forward, fromUp: pose.up, distance: 3.4 });
    const end = path.at(1);
    near(len(end.position), 3.4, 1e-12);
    assert.ok(angDeg(end.position, pose.position) < 1e-9, 'same ground');
    assert.ok(angDeg(end.forward, [-end.position[0], -end.position[1], -end.position[2]]) < 1e-9, 'looks at the centre');
    assert.ok(dot(end.up, [0, 1, 0]) > 0.5, 'screen-up is north-ish (+Y)');
    for (let i = 0; i <= 50; i++) near(angDeg(path.at(i / 50).position, pose.position), 0, 1e-9, 'radial');
    checkPath(path, { pos: pose.position, fwd: pose.forward, up: pose.up }, { pos: end.position, fwd: end.forward, up: end.up }, 'climb');
});

t('the FOV kick is 1 at both ends and peaks mid-path', () => {
    near(transitionFovGain(0), 1, 1e-12); near(transitionFovGain(1), 1, 1e-12);
    assert.ok(transitionFovGain(0.5) > 1.15 && transitionFovGain(0.5) < 1.3);
});

console.log('\n── boundaries ──');

t('boundaries come from the layer schema, plus the Kármán line and the ceiling, lowest first', () => {
    const kms = BOUNDARIES.map(b => b.km);
    for (let i = 0; i < ATMOSPHERIC_LAYER_SCHEMA.length - 1; i++) {
        assert.ok(kms.includes(ATMOSPHERIC_LAYER_SCHEMA[i].maxKm), `layer top ${ATMOSPHERIC_LAYER_SCHEMA[i].maxKm}`);
    }
    assert.ok(kms.includes(100) && kms.includes(2000));
    assert.deepEqual(kms, [...kms].sort((a, b) => a - b));
});

t('crossings name what you enter, in travel order, in both directions', () => {
    const down = boundaryCrossings(700, 90);
    assert.deepEqual(down.map(c => c.boundary.km), [600, 250, 100]);
    assert.equal(down[0].entered, 'Upper Thermosphere');
    assert.equal(down[1].entered, 'Lower Thermosphere');
    assert.match(down[2].entered, /atmosphere/);
    const up = boundaryCrossings(84, 101);
    assert.deepEqual(up.map(c => c.boundary.km), [85, 100]);
    assert.equal(up[0].entered, 'Lower Thermosphere');
    assert.equal(up.every(c => c.direction === 'up'), true);
    assert.deepEqual(boundaryCrossings(300, 300), []);
    assert.equal(boundaryCrossings(2100, 1900)[0].entered, 'the model domain');
});

t('a membrane is prominent near its altitude and gone from the default orbit view', () => {
    near(membraneWeight(250, 250), 1, 1e-12);
    assert.ok(membraneWeight(300, 250) > 0.8);
    assert.ok(membraneWeight(600, 250) < 0.05);
    for (const b of BOUNDARIES) assert.ok(membraneWeight(14000, b.km) < 1e-6, `${b.id} visible from orbit`);
});

t('the membrane grid refines as the camera closes on it, and stays within the ladder', () => {
    let prev = Infinity;
    for (const dh of [800, 300, 100, 30, 5, 0]) {
        const L = gridLevel(250 + dh, 250);
        assert.ok(L <= prev, `coarser when nearer at Δh ${dh}`);
        assert.ok(L >= -2 && L <= 4);
        prev = L;
    }
    // Cells ≈ 3 × (Δh + 40 km) across: 20 km above → ~1.6° (log₂ ≈ 0.7).
    near(2 ** gridLevel(270, 250), (3 * 60) / (R_EARTH_KM * Math.PI / 180), 1e-9);
    near(gridLevel(260, 250), gridLevel(240, 250), 1e-12, 'symmetric about the surface');
});

t('milestones fire once on the way through', () => {
    assert.deepEqual(milestonesReached(120, 95).map(m => m.id), ['karman']);
    assert.deepEqual(milestonesReached(90, EXPLORE.floorKm).map(m => m.id), ['floor']);
    assert.deepEqual(milestonesReached(1900, 2000).map(m => m.id), ['ceiling']);
    assert.deepEqual(milestonesReached(EXPLORE.floorKm, EXPLORE.floorKm), []);
    assert.equal(MILESTONES.length, 3);
});

console.log('\n── points of interest ──');

t('apToKp inverts the engine table', () => {
    for (const kp of [0, 1.5, 3, 5.2, 7, 8.9]) near(apToKp(kpToAp(kp)), kp, 1e-6, `Kp ${kp}`);
    near(apToKp(0), 0, 0); near(apToKp(1000), 9, 0);
});

const SUN = { subSolarLatDeg: 18.5, subSolarLonDeg: -45 };
const pois = pointsOfInterest({ ...SUN, f107Sfu: 150, ap: 27 });
const byId = Object.fromEntries(pois.map(p => [p.id, p]));

t('the bulge sits where the page\'s Jacchia term peaks, the trough where it bottoms', () => {
    const b = byId.bulge, tr = byId.trough;
    const lstB = localSolarTime(b.lonDeg, SUN.subSolarLonDeg);
    near(lstB, bulgeLocalSolarTime(SUN.subSolarLatDeg, SUN.subSolarLatDeg), 1e-6, 'bulge LST');
    assert.ok(lstB > 13 && lstB < 15.5, `bulge LST ${lstB}`);
    near(b.latDeg, SUN.subSolarLatDeg, 1e-12, 'bulge latitude = declination');
    // It is the maximum of the ratio across the planet.
    const rB = jacchiaDiurnalRatio(b.latDeg, lstB, SUN.subSolarLatDeg);
    for (let lat = -80; lat <= 80; lat += 10) for (let lst = 0; lst < 24; lst += 1) {
        assert.ok(jacchiaDiurnalRatio(lat, lst, SUN.subSolarLatDeg) <= rB + 1e-9);
    }
    const lstT = localSolarTime(tr.lonDeg, SUN.subSolarLonDeg);
    near(lstT, troughLocalSolarTime(-SUN.subSolarLatDeg, SUN.subSolarLatDeg), 1e-6);
    assert.ok(lstT > 1.5 && lstT < 5, `trough LST ${lstT}`);
    assert.ok(jacchiaDiurnalRatio(tr.latDeg, lstT, SUN.subSolarLatDeg) < rB);
});

t('the aurora POI is on the oval centre at MAGNETIC midnight, and moves equatorward with Ap', () => {
    const a = byId.aurora;
    const band = auroralOvalLatBand(apToKp(27), 0);
    near(magneticLatitude(a.latDeg, a.lonDeg), (band.eq + band.pw) / 2 - 5, 1e-6, 'magnetic latitude (5° equatorward of the centre)');
    // It looks toward the magnetic pole, where the curtains are.
    const st = stateFromLatLon({ latDeg: a.latDeg, lonDeg: a.lonDeg, altKm: a.altKm, headingDeg: a.headingDeg, pitchDeg: 0 });
    const pole = latLonToScene(80.65, -72.68);
    assert.ok(dot(st.h, vec.tangent(pole, st.u)) > 0.999, 'heading poleward');
    // Night side of the planet.
    const p = latLonToScene(a.latDeg, a.lonDeg), s = latLonToScene(SUN.subSolarLatDeg, SUN.subSolarLonDeg);
    assert.ok(dot(p, s) < 0.2, 'anti-sunward');
    const storm = pointsOfInterest({ ...SUN, ap: 300 }).find(x => x.id === 'aurora');
    assert.ok(magneticLatitude(storm.latDeg, storm.lonDeg) < magneticLatitude(a.latDeg, a.lonDeg) - 3);
    const mm = magneticMidnightPoint(70, 0, 0);
    near(magneticLatitude(mm.latDeg, mm.lonDeg), 70, 1e-9);
});

t('auroral curtains ride the page\'s oval: magnetic latitude matches, midnight is anti-sunward and brightest, MLT runs east', () => {
    const c = auroraCurtain({ kp: 4, subSolarLatDeg: SUN.subSolarLatDeg, subSolarLonDeg: SUN.subSolarLonDeg, samples: 96 });
    assert.equal(c.length, 96);
    for (const p of c) {
        const band = auroralOvalLatBand(4, p.mltHr);
        near(magneticLatitude(p.latDeg, p.lonDeg), (band.eq + band.pw) / 2, 1e-6, `mag lat at MLT ${p.mltHr}`);
    }
    const s = latLonToScene(SUN.subSolarLatDeg, SUN.subSolarLonDeg);
    const sunward = c.map(p => dot(p.u, s));
    const i0 = 0, i12 = 48;
    assert.ok(sunward[i0] < sunward[i12], 'MLT 0 is further from the Sun than MLT 12');
    assert.ok(c[i0].intensity > c[i12].intensity, 'midnight brighter than noon');
    // MLT 6 is EAST of MLT 0 around the dipole: a positive rotation about its axis.
    const d = latLonToScene(80.65, -72.68);
    const step = cross(c[0].u, c[24].u);
    assert.ok(dot(step, d) > 0, 'MLT increases eastward');
    const south = auroraCurtain({ kp: 4, hemisphere: -1, samples: 8, ...SUN });
    assert.ok(south.every(p => magneticLatitude(p.latDeg, p.lonDeg) < -55), 'southern oval');
    const storm = auroraCurtain({ kp: 8, samples: 8, ...SUN });
    const quiet = auroraCurtain({ kp: 1, samples: 8, ...SUN });
    assert.ok(storm[0].magLatDeg < quiet[0].magLatDeg - 5 && storm[0].intensity > quiet[0].intensity);
    assert.ok(AURORA_CURTAIN.bottomKm < AURORA_CURTAIN.topKm);
});

t('the exobase is where the engine\'s λ equals its scale height, and rises with solar activity', () => {
    const quiet = exobaseAltitudeKm({ f107Sfu: 70, ap: 4 });
    const active = exobaseAltitudeKm({ f107Sfu: 250, ap: 50 });
    assert.ok(quiet > 300 && quiet < 1000, `quiet exobase ${quiet}`);
    near(pointPhysics({ altitudeKm: quiet, f107Sfu: 70, ap: 4 }).knudsen, 1, 1e-6, 'Kn = 1');
    assert.ok(active > quiet + 50, `active ${active} vs quiet ${quiet}`);
    near(byId.exobase.altKm, exobaseAltitudeKm({ f107Sfu: 150, ap: 27 }), 1e-9);
});

t('airglow and geocorona POIs sit on the night side at their table\'s altitudes; every POI is in the band', () => {
    const s = latLonToScene(SUN.subSolarLatDeg, SUN.subSolarLonDeg);
    for (const id of ['green-airglow', 'geocorona']) {
        const p = byId[id];
        assert.ok(dot(latLonToScene(p.latDeg, p.lonDeg), s) < -0.99, `${id} anti-solar`);
    }
    near(localSolarTime(byId['red-airglow'].lonDeg, SUN.subSolarLonDeg), 22, 1e-9);
    for (const p of pois) {
        assert.ok(p.altKm >= EXPLORE.floorKm && p.altKm <= EXPLORE.ceilKm, `${p.id} ${p.altKm}`);
        assert.ok(p.placedBy && p.blurb && Array.isArray(p.facts), `${p.id} disclosed`);
        assert.ok(Number.isFinite(p.latDeg) && Number.isFinite(p.lonDeg));
    }
    assert.equal(byId.iss, undefined, 'no ISS without a live state');
    const withIss = pointsOfInterest({ ...SUN, iss: { latDeg: 10, lonDeg: 20, altKm: 418, headingDeg: 50 } });
    assert.equal(withIss.find(p => p.id === 'iss').altKm, 418);
});

t('finding a POI needs ground distance AND altitude; the gauge is log and inverts', () => {
    const b = byId.bulge;
    assert.equal(isAtPoi({ latDeg: b.latDeg, lonDeg: b.lonDeg, altKm: 400 }, b), true);
    assert.equal(isAtPoi({ latDeg: b.latDeg, lonDeg: b.lonDeg, altKm: 120 }, b), false, 'too low');
    assert.equal(isAtPoi({ latDeg: b.latDeg + 10, lonDeg: b.lonDeg, altKm: 400 }, b), false, '1100 km away');
    near(groundDistanceKm(0, 0, 0, 90), R_EARTH_KM * Math.PI / 2, 1e-6);
    near(gaugeFraction(80), 0, 1e-12); near(gaugeFraction(2000), 1, 1e-12);
    near(gaugeAltitude(gaugeFraction(333)), 333, 1e-9);
    near(gaugeFraction(400), Math.log(5) / Math.log(25), 1e-12, 'log scale');
    near(lonAtLocalSolarTime(18, 0), 90, 1e-12);
});

console.log(`\n${fail ? '✗' : '✓'} upper-atmosphere-explore: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
