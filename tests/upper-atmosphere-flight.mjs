/**
 * tests/upper-atmosphere-flight.mjs — gate for the flight-dynamics kernel
 * ═══════════════════════════════════════════════════════════════════════════
 *   node tests/upper-atmosphere-flight.mjs
 *
 * Everything the 3-D flight layer draws and the flight deck prints comes
 * out of js/upper-atmosphere-flight.js, so this is where the physics is
 * proved: frames against the canonical coords.js table, RK4 against the
 * conserved quantities of its own field, J2 against the analytic nodal
 * regression, drag against the Gauss/King-Hele rate, co-rotation against
 * the known equatorial air speed, the LUT sampler against the direct field,
 * and the launch builder against its own inverse.
 */
import assert from 'node:assert/strict';
import {
    MU_KM3_S2, J2, R_EQ_KM, R_EARTH_KM, OMEGA_EARTH, G0, SUTTON_GRAVES_K,
    gmstRad, eciToScene, sceneToEci, eciToGeo, geoToEci,
    gravityAccel, specificEnergy, angularMomentum, atmosphereVelocity, dragAccel,
    circularSpeedKms, headingForInclination,
    createDensitySampler, Flight, integrateFlight, COL, STRIDE, STATUS,
    orbitalElements, launchState, FLIGHT_PRESETS, flightOptionsFromPreset,
    stepSecondsFor, sampleIntervalFor, tleEpochMs,
} from '../js/upper-atmosphere-flight.js';
import { latLonToScene, densityFieldAt, localSolarTime } from '../js/upper-atmosphere-column.js';
import { subSolarPoint } from '../js/sun-altitude.js';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
const DEG = Math.PI / 180;
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b} (tol ${tol})`);
const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);

console.log('\n── 1. frames ──');

t('eciToScene at GMST=0 is the canonical axis swap [x, z, −y]', () => {
    const p = eciToScene([1, 2, 3], 0);
    assert.deepEqual(p.map(v => +v.toFixed(12)), [1, 3, -2]);
});

t('eciToScene ∘ sceneToEci is the identity at arbitrary GMST', () => {
    for (const g of [0, 0.7, 2.9, 5.1]) {
        const r = [4000, -2500, 5100];
        const back = sceneToEci(eciToScene(r, g), g);
        for (let i = 0; i < 3; i++) near(back[i], r[i], 1e-9, `axis ${i}`);
    }
});

t('a point over Greenwich at GMST=0 lands on +X, over 90°E on −Z (coords.js table)', () => {
    const rG = geoToEci({ latDeg: 0, lonDeg: 0, altKm: 0 }, 0);
    const sG = eciToScene(rG, 0).map(v => v / R_EARTH_KM);
    assert.deepEqual(sG.map(v => +v.toFixed(9)), [1, 0, 0]);
    const rE = geoToEci({ latDeg: 0, lonDeg: 90, altKm: 0 }, 0);
    const sE = eciToScene(rE, 0).map(v => v / R_EARTH_KM);
    assert.deepEqual(sE.map(v => +v.toFixed(9)), [0, 0, -1]);
    // And the same through the kernel's own lat/lon → scene.
    const viaKernel = latLonToScene(0, 90);
    assert.deepEqual(viaKernel.map(v => +v.toFixed(9)), [0, 0, -1]);
});

t('geoToEci ∘ eciToGeo round-trips at a non-zero sidereal angle', () => {
    const g = gmstRad(T0);
    for (const site of [{ latDeg: 51.5, lonDeg: -0.1, altKm: 400 }, { latDeg: -33.9, lonDeg: 151.2, altKm: 90 }]) {
        const r = geoToEci(site, g);
        const geo = eciToGeo(r, g);
        near(geo.latDeg, site.latDeg, 1e-9, 'lat');
        near(geo.lonDeg, site.lonDeg, 1e-9, 'lon');
        near(geo.altKm, site.altKm, 1e-6, 'alt');
    }
});

t('the sidereal angle turns the Earth-fixed frame at ω⊕: a fixed ECI point drifts WEST', () => {
    const r = geoToEci({ latDeg: 0, lonDeg: 0, altKm: 400 }, gmstRad(T0));
    const later = eciToGeo(r, gmstRad(T0 + 3600 * 1000));
    // One hour later the ground has turned 15.04° east, so the inertial
    // point sits 15.04° WEST of where it was.
    near(later.lonDeg, -15.04, 0.02, 'ground-relative drift after 1 h');
});

t('scene ↔ lat/lon agrees with the ONE sub-solar convention', () => {
    // The sun vector the globe draws is latLonToScene(subSolarPoint); the
    // kernel's frame must put the same ECI direction there.
    const s = subSolarPoint(new Date(T0));
    const g = gmstRad(T0);
    const rSun = geoToEci({ latDeg: s.lat, lonDeg: s.lon, altKm: 0 }, g);
    const scene = eciToScene(rSun, g).map(v => v / R_EARTH_KM);
    const want = latLonToScene(s.lat, s.lon);
    for (let i = 0; i < 3; i++) near(scene[i], want[i], 1e-9, `axis ${i}`);
});

console.log('\n── 2. forces ──');

t('point-mass gravity at the surface is g₀ to 0.3 %', () => {
    const a = gravityAccel([R_EARTH_KM, 0, 0], [0, 0, 0], false);
    near(Math.hypot(...a) * 1000, 9.82, 0.03, 'g at 6371 km');
});

t('J2 is a ~1e-3 correction and is stronger over the pole than the equator', () => {
    const eq = gravityAccel([7000, 0, 0]), po = gravityAccel([0, 0, 7000]);
    const eq0 = gravityAccel([7000, 0, 0], [0, 0, 0], false);
    const rel = (Math.hypot(...eq) - Math.hypot(...eq0)) / Math.hypot(...eq0);
    assert.ok(Math.abs(rel) > 5e-4 && Math.abs(rel) < 3e-3, `equatorial J2 fraction ${rel}`);
    // Equatorial gravity is INCREASED by the bulge (extra mass in the plane),
    // polar gravity DECREASED.
    assert.ok(Math.hypot(...eq) > Math.hypot(...eq0), 'equator stronger');
    assert.ok(Math.hypot(...po) < Math.hypot(...gravityAccel([0, 0, 7000], [0, 0, 0], false)), 'pole weaker');
});

t('gravityAccel is −∇ of the potential specificEnergy carries (J2 included)', () => {
    const r = [5000, -3000, 3500], eps = 1e-3;
    const U = (p) => specificEnergy(p, [0, 0, 0], true);
    const a = gravityAccel(r);
    for (let i = 0; i < 3; i++) {
        const p1 = r.slice(), p2 = r.slice(); p1[i] += eps; p2[i] -= eps;
        const grad = (U(p1) - U(p2)) / (2 * eps);
        near(a[i], -grad, 1e-9, `component ${i}`);
    }
});

t('the co-rotating air moves at 0.465 km/s on the equator, zero on the pole', () => {
    near(Math.hypot(...atmosphereVelocity([R_EARTH_KM, 0, 0])), OMEGA_EARTH * R_EARTH_KM, 1e-12, 'equator');
    near(OMEGA_EARTH * R_EARTH_KM, 0.4646, 5e-4, 'equatorial air speed on the 6371 km datum');
    near(Math.hypot(...atmosphereVelocity([0, 0, R_EARTH_KM])), 0, 1e-12, 'pole');
});

t('drag: ½ρv²·BC, anti-parallel to the relative wind', () => {
    const out = [0, 0, 0];
    const mag = dragAccel(1e-11, [7.5, 0, 0], 0.02, out);
    // ½ × 1e-11 × 7500² × 0.02 = 5.625e-6 m/s²
    near(mag * 1000, 5.625e-6, 1e-12, 'magnitude');
    assert.ok(out[0] < 0 && out[1] === 0 && out[2] === 0, 'direction');
});

t('a prograde equatorial body feels ~22 % less drag than a retrograde one (~12 % less than still air)', () => {
    const r = [R_EARTH_KM + 400, 0, 0];
    const v = circularSpeedKms(400);
    const rel = (vy) => { const va = atmosphereVelocity(r); return [0 - va[0], vy - va[1], 0]; };
    const pro = dragAccel(1e-12, rel(+v), 0.02), retro = dragAccel(1e-12, rel(-v), 0.02);
    const still = dragAccel(1e-12, [0, v, 0], 0.02);
    const ratio = pro / retro;
    assert.ok(ratio > 0.76 && ratio < 0.80, `pro/retro ${ratio}`);
    assert.ok(pro / still > 0.86 && pro / still < 0.90, `pro/still ${pro / still}`);
});

t('headingForInclination: 51.6° from the equator is 38.4°, SSO is retrograde, unreachable is null', () => {
    near(headingForInclination(51.6, 0), 38.4, 0.05, 'ISS');
    const sso = headingForInclination(98, 0);
    assert.ok(sso > 340 && sso < 360, `SSO heading ${sso}`);
    assert.equal(headingForInclination(20, 45), null, '20° from 45°N');
});

console.log('\n── 3. the density sampler ──');

const sampler = createDensitySampler({ f107Sfu: 180, ap: 60 });

t('LUT sampler reproduces densityFieldAt within 3 % across the band', () => {
    const s = subSolarPoint(new Date(T0));
    let worst = 0;
    for (const alt of [85, 100, 130, 200, 300, 450, 700, 1200, 1900]) {
        for (const [lat, lon] of [[0, 0], [45, 120], [-70, -30], [67, 20]]) {
            const direct = densityFieldAt({
                altKm: alt, latDeg: lat, lonDeg: lon,
                localSolarTimeHr: localSolarTime(lon, s.lon), sunDeclDeg: s.lat,
                f107Sfu: 180, ap: 60,
            }).rho;
            const got = sampler.rhoAt(alt, lat, lon, T0);
            const rel = Math.abs(got / direct - 1);
            worst = Math.max(worst, rel);
            assert.ok(rel < 0.03, `alt ${alt} lat ${lat} lon ${lon}: ${got} vs ${direct} (${(rel * 100).toFixed(2)} %)`);
        }
    }
    console.log(`      worst LUT error ${(worst * 100).toFixed(3)} %`);
});

t('the sampler reads ZERO above the model ceiling and says so', () => {
    assert.equal(sampler.rhoAt(2500, 0, 0, T0), 0);
    assert.equal(sampler.fieldAt(2500, 0, 0, T0).aboveModel, true);
});

t('the field is anisotropic: afternoon side denser than pre-dawn at 400 km', () => {
    const s = subSolarPoint(new Date(T0));
    const hot = sampler.fieldAt(400, 0, s.lon + 30, T0);   // ~14 h LST
    const cold = sampler.fieldAt(400, 0, s.lon - 150, T0); // ~02 h LST
    assert.ok(hot.rho / cold.rho > 1.3, `day/night ${hot.rho / cold.rho}`);
    near(hot.lstHr, 14, 0.01, 'LST');
});

console.log('\n── 4. integration ──');

const vacuumIss = () => {
    const alt = 420, r0 = [R_EARTH_KM + alt, 0, 0];
    const v = circularSpeedKms(alt), inc = 51.6 * DEG;
    return { r0, v0: [0, v * Math.cos(inc), v * Math.sin(inc)], t0Ms: T0, rhoAt: () => 0 };
};

t('RK4 conserves energy and |h| to 1e-9 over ten J2 orbits', () => {
    const f = integrateFlight({ ...vacuumIss(), horizonS: 10 * 5560 });
    assert.equal(f.status, STATUS.HORIZON);
    const e0 = f.data[COL.ENERGY], e1 = f.data[(f.n - 1) * STRIDE + COL.ENERGY];
    near(e1 / e0 - 1, 0, 1e-9, 'energy drift');
    // With J2, |h| is not conserved but h_z is; check that instead.
    const hz = (i) => f.data[i * STRIDE + COL.RX] * f.data[i * STRIDE + COL.VY]
                    - f.data[i * STRIDE + COL.RY] * f.data[i * STRIDE + COL.VX];
    near(hz(f.n - 1) / hz(0) - 1, 0, 1e-9, 'h_z drift');
});

t('a circular vacuum orbit returns to its start after one Kepler period (no J2)', () => {
    const alt = 420, r0 = [R_EARTH_KM + alt, 0, 0];
    const v = circularSpeedKms(alt);
    const P = 2 * Math.PI * Math.sqrt((R_EARTH_KM + alt) ** 3 / MU_KM3_S2);
    const f = integrateFlight({ r0, v0: [0, v, 0], t0Ms: T0, rhoAt: () => 0, j2: false, horizonS: P });
    const o = (f.n - 1) * STRIDE;
    near(f.data[o + COL.RX], r0[0], 0.05, 'x after one period (km)');
    near(f.data[o + COL.RY], 0, 0.05, 'y after one period (km)');
});

t('J2 regresses the node at the analytic rate (−4.9°/day for the ISS orbit)', () => {
    const f = integrateFlight({ ...vacuumIss(), horizonS: 86400 });
    const el0 = f.summary().elementsStart, el1 = f.summary().elementsEnd;
    let dRaan = el1.raanDeg - el0.raanDeg;
    if (dRaan > 180) dRaan -= 360; if (dRaan < -180) dRaan += 360;
    const a = R_EARTH_KM + 420, n = Math.sqrt(MU_KM3_S2 / a ** 3);
    const analytic = -1.5 * n * J2 * (R_EQ_KM / a) ** 2 * Math.cos(51.6 * DEG) * 86400 / DEG;
    near(dRaan, analytic, 0.05, `node regression °/day (analytic ${analytic.toFixed(3)})`);
});

t('drag decays a circular orbit at the Gauss rate da/dt = −2a²/μ · a_d·v', () => {
    const rho = 3e-12, bc = 0.02;
    const f = integrateFlight({ ...vacuumIss(), rhoAt: () => rho, corotate: false, j2: false, horizonS: 5560 });
    const el0 = f.summary().elementsStart, el1 = f.summary().elementsEnd;
    const a = R_EARTH_KM + 420, v = circularSpeedKms(420);
    // King-Hele circular: da/dt = −ρ·BC·v·a·... derive from energy:
    // dε/dt = −½ρ v³ BC (SI) → da/dt = 2a²/μ · dε/dt.
    const aD = 500 * rho * v * v * bc;               // km/s²
    const dadt = -(2 * a * a / MU_KM3_S2) * aD * v;  // km/s
    const expected = dadt * f.tEndS;
    near(el1.aKm - el0.aKm, expected, Math.abs(expected) * 0.02, `Δa over one orbit (km), expected ${expected.toFixed(3)}`);
    // And the recorded DADT column says the same thing in km/day.
    near(f.data[COL.DADT], dadt * 86400, Math.abs(dadt * 86400) * 0.01, 'DADT column');
});

t('dε/dt column equals the finite-difference of ε along a decaying orbit', () => {
    const f = integrateFlight({ ...vacuumIss(), rhoAt: () => 2e-12, horizonS: 3000 });
    const d = f.data;
    let n = 0, errSum = 0;
    for (let i = 2; i < f.n - 2; i++) {
        const t0 = d[(i - 1) * STRIDE + COL.T], t1 = d[(i + 1) * STRIDE + COL.T];
        const fd = (d[(i + 1) * STRIDE + COL.ENERGY] - d[(i - 1) * STRIDE + COL.ENERGY]) / (t1 - t0) * 1e6;
        const rec = d[i * STRIDE + COL.DEDT];
        errSum += Math.abs(fd / rec - 1); n++;
    }
    assert.ok(errSum / n < 0.02, `mean relative error ${errSum / n}`);
    assert.ok(d[COL.DEDT] < 0, 'drag removes energy');
});

t('a capsule reaches the floor with rising heating and g-load, and the floor sample is AT 80 km', () => {
    const p = FLIGHT_PRESETS.find(x => x.id === 'capsule');
    const f = integrateFlight({ ...flightOptionsFromPreset(p, T0), sampler });
    assert.equal(f.status, STATUS.FLOOR, `status ${f.status}`);
    const s = f.summary();
    near(s.minAltKm, 80, 1e-3, 'floor altitude (linear crossing)');
    // Above the 80 km floor an entry has barely begun: ~0.03 g and ~12 W/cm²
    // on a 1 m nose. The real peak lives at 40–60 km, below the model, and
    // the deck must say so rather than print it.
    assert.ok(s.maxHeatWcm2 > 5 && s.maxHeatWcm2 < 50, `peak heating ${s.maxHeatWcm2} W/cm²`);
    assert.ok(s.maxG > 0.02 && s.maxG < 0.2, `peak g ${s.maxG}`);
    assert.ok(s.floor && Number.isFinite(s.floor.latDeg), 'floor point reported');
    assert.ok(s.tEndS > 60 && s.tEndS < 3600, `duration ${s.tEndS}`);
});

t('the suborbital hop comes back down; escape goes unbound; GTO reaches ~35 800 km', () => {
    const hop = integrateFlight({ ...flightOptionsFromPreset(FLIGHT_PRESETS.find(x => x.id === 'hop'), T0), sampler });
    assert.equal(hop.status, STATUS.FLOOR);
    assert.ok(hop.summary().maxAltKm > 180 && hop.summary().maxAltKm < 400, `hop apogee ${hop.summary().maxAltKm}`);
    const esc = integrateFlight({ ...flightOptionsFromPreset(FLIGHT_PRESETS.find(x => x.id === 'escape'), T0), sampler });
    assert.equal(esc.status, STATUS.ESCAPE);
    assert.ok(esc.data[COL.ENERGY] > 0, 'positive energy at launch');
    const gto = integrateFlight({ ...flightOptionsFromPreset(FLIGHT_PRESETS.find(x => x.id === 'gto'), T0), sampler });
    near(gto.summary().maxAltKm, 35786, 900, 'GTO apogee');
});

t('lift is L/D × drag in magnitude and keeps the glider up longer than a ballistic body', () => {
    const p = FLIGHT_PRESETS.find(x => x.id === 'glider');
    const lifting = new Flight({ ...flightOptionsFromPreset(p, T0), sampler });
    const row = lifting.row(0);
    near(row.ALIFT / row.ADRAG, 2.0, 1e-9, 'L/D at launch');
    lifting.run();
    const ballistic = integrateFlight({ ...flightOptionsFromPreset(p, T0), sampler, liftToDrag: 0 });
    assert.equal(lifting.status, STATUS.FLOOR);
    assert.equal(ballistic.status, STATUS.FLOOR);
    // In the 80–2000 km band lift is marginal (~0.1 g at most): it buys
    // seconds before the floor, not a climb. Gate that it buys them at all,
    // and that the load the body feels includes it.
    assert.ok(lifting.tEndS > ballistic.tEndS * 1.05,
        `lifting ${lifting.tEndS.toFixed(0)} s vs ballistic ${ballistic.tEndS.toFixed(0)} s`);
    assert.ok(lifting.summary().maxG > ballistic.summary().maxG * 1.5, 'lift contributes to the load');
});

t('step() honours maxSteps and untilS and resumes exactly where it stopped', () => {
    const f = new Flight({ ...vacuumIss(), horizonS: 4000 });
    const n1 = f.step({ maxSteps: 10 });
    assert.equal(n1, 10);
    f.step({ untilS: 1000 });
    assert.ok(f.tS >= 1000 && f.tS < 1000 + 10, `t ${f.tS}`);
    f.run();
    assert.equal(f.status, STATUS.HORIZON);
    near(f.tEndS, 4000, 1e-9, 'horizon reached exactly');
});

t('sampleAt interpolates between rows and is null outside the flight', () => {
    const f = integrateFlight({ ...vacuumIss(), horizonS: 600 });
    assert.equal(f.sampleAt(-1), null);
    assert.equal(f.sampleAt(601), null);
    const i = 3;
    const ta = f.data[i * STRIDE + COL.T], tb = f.data[(i + 1) * STRIDE + COL.T];
    const mid = f.sampleAt((ta + tb) / 2);
    near(mid[COL.RX], (f.data[i * STRIDE + COL.RX] + f.data[(i + 1) * STRIDE + COL.RX]) / 2, 1e-9, 'x midpoint');
    near(mid[COL.T], (ta + tb) / 2, 1e-12, 't');
});

t('sceneAt places the launch point over the launch site in the canonical frame', () => {
    const site = { latDeg: 25, lonDeg: -140, altKm: 120 };
    const ls = launchState({ ...site, speedKms: 7.8, fpaDeg: -1.6, headingDeg: 70, unixMs: T0 });
    const f = new Flight({ r0: ls.r, v0: ls.v, t0Ms: T0, rhoAt: () => 0, horizonS: 10 });
    const p = f.sceneAt(0);
    const want = latLonToScene(site.latDeg, site.lonDeg).map(v => v * (1 + 120 / R_EARTH_KM));
    for (let i = 0; i < 3; i++) near(p[i], want[i], 1e-9, `axis ${i}`);
});

console.log('\n── 5. launch, elements, presets ──');

t('launchState: east heading at the equator gives a prograde equatorial orbit', () => {
    const ls = launchState({ latDeg: 0, lonDeg: 30, altKm: 400, speedKms: circularSpeedKms(400),
                             fpaDeg: 0, headingDeg: 90, unixMs: T0 });
    const el = orbitalElements(ls.r, ls.v);
    near(el.incDeg, 0, 1e-6, 'inclination');
    near(el.e, 0, 1e-6, 'eccentricity');
    near(el.perigeeAltKm, 400, 1e-3, 'altitude');
    near(el.periodMin, 92.41, 0.05, 'period (6371 km datum)');
});

t('launchState: ISS heading from the equator gives 51.6°, SSO heading gives 98°', () => {
    const iss = launchState({ latDeg: 0, lonDeg: 0, altKm: 420, speedKms: circularSpeedKms(420),
                              headingDeg: headingForInclination(51.6, 0), unixMs: T0 });
    near(orbitalElements(iss.r, iss.v).incDeg, 51.6, 1e-6, 'ISS');
    const sso = launchState({ latDeg: 0, lonDeg: 0, altKm: 800, speedKms: circularSpeedKms(800),
                              headingDeg: headingForInclination(98, 0), unixMs: T0 });
    near(orbitalElements(sso.r, sso.v).incDeg, 98, 1e-6, 'SSO');
});

t('groundRelative adds the rotating ground: 0.465 km/s eastward at the equator', () => {
    const a = launchState({ latDeg: 0, lonDeg: 0, altKm: 100, speedKms: 3, fpaDeg: 0, headingDeg: 90, unixMs: T0 });
    const b = launchState({ latDeg: 0, lonDeg: 0, altKm: 100, speedKms: 3, fpaDeg: 0, headingDeg: 90, unixMs: T0, groundRelative: true });
    near(b.vInertialKms - a.vInertialKms, OMEGA_EARTH * (R_EARTH_KM + 100), 1e-9, 'Δv');
    near(b.vGroundKms, 3, 1e-12, 'ground speed reported');
});

t('orbitalElements recovers an eccentric orbit from its perigee state', () => {
    const rp = R_EARTH_KM + 250, ra = R_EARTH_KM + 35786, a = (rp + ra) / 2;
    const vp = Math.sqrt(MU_KM3_S2 * (2 / rp - 1 / a));
    const el = orbitalElements([rp, 0, 0], [0, vp * Math.cos(7 * DEG), vp * Math.sin(7 * DEG)]);
    near(el.aKm, a, 1e-6, 'a');
    near(el.apogeeAltKm, 35786, 1e-3, 'apogee');
    near(el.incDeg, 7, 1e-9, 'i');
    near(el.nuDeg, 0, 1e-6, 'ν at perigee');
    assert.equal(el.bound, true);
    assert.equal(orbitalElements([7000, 0, 0], [0, 12, 0]).bound, false, 'hyperbolic');
});

t('every preset is finite, reaches its inclination, and speeds are sub-lunar', () => {
    for (const p of FLIGHT_PRESETS) {
        const o = flightOptionsFromPreset(p, T0);
        assert.ok(o.r0.every(Number.isFinite) && o.v0.every(Number.isFinite), p.id);
        assert.ok(p.launch.speedKms > 0 && p.launch.speedKms < 12, `${p.id} speed`);
        assert.ok(p.horizonS > 0 && p.bcM2PerKg > 0, `${p.id} options`);
    }
    const iss = flightOptionsFromPreset(FLIGHT_PRESETS[0], T0);
    near(orbitalElements(iss.r0, iss.v0).incDeg, 51.6, 0.05, 'ISS preset inclination');
});

t('the step schedule tightens with altitude and the sample cadence with it', () => {
    assert.ok(stepSecondsFor(700) > stepSecondsFor(200) && stepSecondsFor(200) > stepSecondsFor(100));
    assert.ok(sampleIntervalFor(700) > sampleIntervalFor(100));
    assert.ok(stepSecondsFor(100) <= sampleIntervalFor(100));
});

t('tleEpochMs reads the ISS TLE epoch (Vallado column convention)', () => {
    // 2026-09-27 12:00 UTC is day 270.5 of 2026.
    const l1 = '1 25544U 98067A   26270.50000000  .00016717  00000-0  30215-3 0  9990';
    assert.equal(tleEpochMs(l1), Date.UTC(2026, 8, 27, 12));
    assert.equal(tleEpochMs('1 25544U 98067A   99001.00000000'), Date.UTC(1999, 0, 1));
    assert.ok(Number.isNaN(tleEpochMs('garbage')));
});

t('Sutton–Graves proxy: 1.7415e-4·√(ρ/R)·v³ — a pinned number', () => {
    const f = new Flight({ r0: [R_EARTH_KM + 100, 0, 0], v0: [0, 7.5, 0], t0Ms: T0,
                           rhoAt: () => 5e-7, corotate: false });
    const want = SUTTON_GRAVES_K * Math.sqrt(5e-7 / 1) * 7500 ** 3 / 1e4;   // W/cm²
    near(f.row(0).HEAT, want, want * 1e-9, 'heat');
    near(f.row(0).GLOAD, 500 * 5e-7 * 7.5 * 7.5 * 0.02 * 1000 / G0, 1e-9, 'g-load');
});

console.log(`\n${fail ? '✗' : '✓'} upper-atmosphere-flight: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
