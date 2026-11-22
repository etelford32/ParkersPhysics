/**
 * chicxulub.mjs — node gate for the Chicxulub reconstruction kernels
 * ═══════════════════════════════════════════════════════════════════════════
 *   node tests/chicxulub.mjs
 *
 * The scaling coefficients are RECALLED (SCALING.verified === false), so this
 * gate checks what does not depend on trusting them:
 *   1. the evidence table — every row sourced and flagged, ranges ordered, the
 *      iridium bookkeeping against a published total;
 *   2. the forward model's identities (exponents, round trips, one mass formula
 *      with js/neo-space.js);
 *   3. ballistic flight against the flat-Earth limit and energy conservation;
 *   4. published impactors land on the observed crater and magnitude band;
 *   5. the inversion — determinism, the size–speed degeneracy, the iridium
 *      conflict, the rim-choice sensitivity (each with its control);
 *   6. the escape hyperbola against a numerical integration of the same path,
 *      with "no gravity" as the negative control;
 *   7. the heliocentric step's sign conventions (noon = from the Sun, dawn =
 *      the leading side) — a mirrored frame gives a plausible, wrong orbit;
 *   8. the climate box: the exact step, the darkness it is anchored on, and
 *      the measured over-cooling of a mixed-layer box.
 */

import * as O from '../js/chicxulub/observations.js';
import * as M from '../js/chicxulub/impact-model.js';
import * as R from '../js/chicxulub/reconstruct.js';
import { impactEnergy } from '../js/neo-space.js';
import { EBM_HEAT_CAPACITY, EBM_FEEDBACK } from '../js/volcano-engine.js';

let checks = 0, failed = 0;
function ok(cond, msg) { checks++; if (!cond) { failed++; console.error(`  ✗ ${msg}`); } return cond; }
function section(t) { console.log(`\n${t}`); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

// ── 1 ───────────────────────────────────────────────────────────────────────
section('1. evidence table');
{
    const rows = O.allRows();
    ok(rows.length >= 35, `at least 35 rows (${rows.length})`);
    for (const r of rows) {
        ok(typeof r.source === 'string' && r.source.length > 5, `${r.group}/${r.key}: has a source`);
        ok(r.verified === 'search' || r.verified === false, `${r.group}/${r.key}: verified is 'search' or false`);
        if (r.lo != null && r.hi != null) ok(r.lo < r.hi, `${r.group}/${r.key}: lo < hi`);
        if (r.lo != null && r.hi != null && typeof r.value === 'number') ok(r.value >= r.lo && r.value <= r.hi, `${r.group}/${r.key}: value inside its range`);
    }
    const unverified = rows.filter((r) => r.verified === false).length;
    console.log(`  ${rows.length} rows, ${rows.length - unverified} search-confirmed, ${unverified} recalled`);
    ok(unverified > 0 && unverified < rows.length, 'both kinds present (nothing silently promoted)');
    // 55 ng/cm² over the Earth is ~2.8e11 g of iridium (a published total: ~2.75e11 g)
    const irG = O.IRIDIUM.fluenceNgCm2.value * 1e-9 * O.EARTH_AREA_CM2;
    ok(rel(irG, 2.75e11) < 0.03, `global Ir mass ${irG.toExponential(3)} g ≈ 2.75e11 g`);
    ok(near(M.A_EARTH * 1e4, O.EARTH_AREA_CM2, 1e8), 'one Earth area in both modules');
    ok(O.CRATER.transientCavityDiameterKm.verified === false && !('transientKm' in R.DEFAULTS), 'the unverified transient cavity is not a constraint');
    ok(O.CLIMATE_TARGETS.find((c) => c.id === 'dust').massTg === null, 'the unconfirmed dust mass is empty, not guessed');
}

// ── 2 ───────────────────────────────────────────────────────────────────────
section('2. forward identities');
{
    ok(M.SCALING.verified === false, 'scaling coefficients are flagged as recalled');
    const base = { diameterM: 14e3, speed: 20e3, angleDeg: 60, density: 2200 };
    const D0 = M.transientDiameter(base);
    ok(rel(M.transientDiameter({ ...base, diameterM: 28e3 }) / D0, 2 ** 0.78) < 1e-12, 'D_tc ∝ L^0.78');
    ok(rel(M.transientDiameter({ ...base, speed: 40e3 }) / D0, 2 ** 0.44) < 1e-12, 'D_tc ∝ v^0.44');
    ok(rel(M.transientDiameter({ ...base, density: 2200 * 8 }) / D0, 2) < 1e-12, 'D_tc ∝ ρ^⅓');
    ok(rel(M.transientDiameter({ ...base, angleDeg: 30 }) / M.transientDiameter({ ...base, angleDeg: 90 }), Math.cbrt(0.5)) < 1e-12, 'D_tc ∝ sin^⅓θ');
    ok(rel(M.transientFromFinal(M.finalDiameter(D0)), D0) < 1e-12, 'final ↔ transient round trip');
    ok(M.finalDiameter(2000) === 2500, 'a simple crater is 1.25 × its transient');
    ok(M.finalDiameter(D0) > 1.25 * D0, 'a complex crater widens more than a simple one');
    const mine = M.kineticEnergy(M.impactorMass(14e3, 2200), 20e3), theirs = impactEnergy(14, 20, 2200);
    ok(rel(mine, theirs.joules) < 1e-12, 'same kinetic energy as js/neo-space.js impactEnergy');
    ok(rel(M.diameterFromMass(M.impactorMass(14e3, 2200), 2200), 14e3) < 1e-12, 'mass ↔ diameter round trip');
    ok(near(M.V_ESC, 11186, 5), `escape speed ${M.V_ESC.toFixed(0)} m/s`);
    ok(M.vInfinity(M.V_ESC * 0.99) === 0 && rel(M.vInfinity(20e3) ** 2, 20e3 ** 2 - M.V_ESC ** 2) < 1e-12, 'v∞² = v² − v_esc²');
    const fl = M.iridiumFluence({ massKg: 5e14, abundanceNgG: 595, fDep: 0.4 });
    ok(rel(M.massFromIridium({ fluenceNgCm2: fl, abundanceNgG: 595, fDep: 0.4 }), 5e14) < 1e-12, 'iridium ↔ mass round trip');
    ok(M.ejectaThickness(100e3, 40e3) === null, 'no ejecta thickness inside the transient cavity');
    ok(rel(M.ejectaThickness(100e3, 2000e3) / M.ejectaThickness(100e3, 1000e3), 1 / 8) < 1e-12, 'ejecta ∝ r⁻³');
    ok(rel(M.greatCircle(0, 0, 0, 90), Math.PI / 2 * M.R_EARTH) < 1e-12, 'great circle: a quarter of the equator');
}

// ── 3 ───────────────────────────────────────────────────────────────────────
section('3. ballistic flight');
{
    const r = 10e3, b = M.ballisticFlight(r);
    ok(rel(b.speed, Math.sqrt(M.G0 * r)) < 0.005, `flat-Earth limit: v = √(g r) (${b.speed.toFixed(1)} vs ${Math.sqrt(M.G0 * r).toFixed(1)})`);
    ok(rel(b.timeS, Math.sqrt(2 * r / M.G0)) < 0.005, `flat-Earth limit: T = √(2r/g) (${b.timeS.toFixed(2)} s)`);
    ok(rel(b.apogeeM, r / 4) < 0.01, 'flat-Earth limit: apex = r/4');
    let prev = M.ballisticFlight(100e3), mono = true;
    for (let km = 200; km <= 20000; km += 200) {
        const x = M.ballisticFlight(km * 1000);
        if (!(x.speed > prev.speed && x.timeS > prev.timeS && x.speed < M.V_ESC)) mono = false;
        prev = x;
    }
    ok(mono, 'speed and flight time grow with range and stay below escape, to the antipode');
    // flat-Earth formula as the NEGATIVE CONTROL at 3000 km: the sphere matters
    const far = M.ballisticFlight(3000e3);
    ok(rel(far.timeS, Math.sqrt(2 * 3000e3 / M.G0)) > 0.15, `at 3000 km the flat-Earth time is off by ${(rel(far.timeS, Math.sqrt(6000e3 / M.G0)) * 100).toFixed(0)} %`);
    ok(far.apogeeM > 400e3, `3000 km ejecta leaves the atmosphere (apogee ${(far.apogeeM / 1000).toFixed(0)} km)`);
}

// ── 4 ───────────────────────────────────────────────────────────────────────
section('4. published impactors through the laws');
{
    for (const p of O.PUBLISHED_IMPACTORS) {
        const w = M.forward({ diameterKm: p.diameterKm, speedKms: p.speedKms, angleDeg: p.angleDeg, density: p.density });
        ok(w.finalKm > 125 && w.finalKm < 200, `${p.label}: final crater ${w.finalKm.toFixed(0)} km in 125–200`);
        ok(w.seismicM > 9.5 && w.seismicM < 11, `${p.label}: Mw ${w.seismicM.toFixed(1)} in the published 10–11 band (±0.5)`);
        ok(w.energyJ > 1e23 && w.energyJ < 1e24, `${p.label}: energy ${w.energyJ.toExponential(1)} J`);
        ok(w.iridiumNgCm2 > 3 * O.IRIDIUM.fluenceNgCm2.value, `${p.label}: carries ${(w.iridiumNgCm2 / 55).toFixed(0)}× the layer's iridium`);
    }
    // negative control: the body the iridium layer weighs, at an asteroid's speed, digs too small a crater
    const m = M.massFromIridium({ fluenceNgCm2: 55, abundanceNgG: 595 });
    const small = M.forward({ diameterKm: M.diameterFromMass(m, 2200) / 1000, speedKms: 20, angleDeg: 55 });
    ok(small.finalKm < 110, `the iridium-mass body at 20 km/s: ${small.finalKm.toFixed(0)} km crater (too small)`);
}

// ── 5 ───────────────────────────────────────────────────────────────────────
section('5. the impactor, backwards');
{
    const a = R.reconstructImpactor({ scenario: 'asteroid' }), a2 = R.reconstructImpactor({ scenario: 'asteroid' });
    ok(Object.is(a.diameterKm.med, a2.diameterKm.med) && Object.is(a.energyJ.hi, a2.energyJ.hi), 'deterministic');
    ok(rel(a.craterKm.med, R.DEFAULTS.craterKm) < 0.08, `posterior crater ${a.craterKm.med.toFixed(0)} km sits on the constraint`);
    ok(a.diameterKm.lo < 17 && a.diameterKm.hi > 14, `asteroid diameter ${a.diameterKm.lo.toFixed(1)}–${a.diameterKm.hi.toFixed(1)} km overlaps the hydrocodes' 12–17`);
    ok(a.speedKms.med > 13 && a.speedKms.med < 25, `asteroid speed ${a.speedKms.med.toFixed(1)} km/s`);
    ok(a.fDep.hi < 0.5, `at asteroid speeds the layer holds < half the iridium (${a.fDep.lo.toFixed(2)}–${a.fDep.hi.toFixed(2)})`);
    ok(a.angleDeg.lo >= 35 && a.angleDeg.hi <= 65, 'angle posterior follows the published trajectory');

    const c = R.reconstructImpactor({ scenario: 'crater-only' });
    ok(c.speedKms.hi / c.speedKms.lo > 2.5, `crater alone leaves speed open (${c.speedKms.lo.toFixed(0)}–${c.speedKms.hi.toFixed(0)} km/s)`);
    ok(c.speedKms.hi / c.speedKms.lo > 1.5 * a.speedKms.hi / a.speedKms.lo, 'the population prior is what narrows the speed');

    const ir = R.reconstructImpactor({ scenario: 'all-iridium' });
    ok(ir.speedKms.lo > 45, `all the iridium in the layer ⇒ ≥ ${ir.speedKms.lo.toFixed(0)} km/s (comet speed)`);
    ok(ir.diameterKm.hi < a.diameterKm.lo, 'the two readings do not overlap in size');
    const vNeed = R.speedForCrater(7.4);
    ok(vNeed > 55, `a 7.4 km body needs ${vNeed.toFixed(0)} km/s`);
    ok(rel(M.forward({ diameterKm: 7.4, speedKms: vNeed, angleDeg: 55 }).finalKm, R.DEFAULTS.craterKm) < 1e-6, 'speedForCrater inverts the forward law');

    const outer = R.reconstructImpactor({ scenario: 'asteroid', craterKm: 190 });
    ok(outer.diameterKm.med > 1.1 * a.diameterKm.med, `outer ring as the rim: ${outer.diameterKm.med.toFixed(1)} km vs ${a.diameterKm.med.toFixed(1)} km`);
    const noAngle = R.reconstructImpactor({ scenario: 'asteroid', useAngle: false });
    ok(noAngle.angleDeg.hi - noAngle.angleDeg.lo > a.angleDeg.hi - a.angleDeg.lo, 'without the published trajectory the angle is wider');

    let s = 0; for (let v = 11.2; v < 120; v += 0.01) s += R.asteroidSpeedDensity(v) * 0.01;
    ok(near(s, 1, 0.01), `speed prior integrates to 1 (${s.toFixed(3)})`);
    let mean = 0; for (let v = 11.2; v < 120; v += 0.01) mean += v * R.asteroidSpeedDensity(v) * 0.01;
    ok(mean > 17 && mean < 23, `mean asteroid impact speed ${mean.toFixed(1)} km/s`);
    ok(R.SPEED_PRIOR.verified === false, 'the speed prior is flagged as recalled');
}

// ── 6 ───────────────────────────────────────────────────────────────────────
section('6. the escape hyperbola');
{
    // integrate the SAME path backwards in time with RK4 and compare the far velocity
    const integrateBack = (r, v, seconds) => {
        let s = [...r, ...v.map((x) => -x)];                       // time reversal
        const f = (y) => { const d = Math.hypot(y[0], y[1], y[2]), k = -M.MU_EARTH / d ** 3; return [y[3], y[4], y[5], k * y[0], k * y[1], k * y[2]]; };
        let t = 0;
        while (t < seconds) {
            const d = Math.hypot(s[0], s[1], s[2]), dt = Math.min(seconds - t, 0.002 * d / Math.hypot(s[3], s[4], s[5]) + 0.01);
            const k1 = f(s), k2 = f(s.map((x, i) => x + dt / 2 * k1[i])), k3 = f(s.map((x, i) => x + dt / 2 * k2[i])), k4 = f(s.map((x, i) => x + dt * k3[i]));
            s = s.map((x, i) => x + dt / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])); t += dt;
        }
        return { r: s.slice(0, 3), v: s.slice(3).map((x) => -x) };
    };
    const ang = (a, b) => Math.acos(Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b)))) * 180 / Math.PI;
    for (const [speed, elev] of [[12e3, 55], [20e3, 45], [30e3, 60], [12e3, 20]]) {
        const th = elev * Math.PI / 180;
        const r0 = [M.R_EARTH, 0, 0], v0 = [-speed * Math.sin(th), speed * Math.cos(th) * 0.6, speed * Math.cos(th) * 0.8];
        const a = R.incomingAsymptote(r0, v0);
        ok(rel(a.speed ** 2, speed ** 2 - 2 * M.MU_EARTH / M.R_EARTH) < 1e-12, `${speed / 1000} km/s, ${elev}°: |v∞|² = v² − 2μ/r`);
        const far = integrateBack(r0, v0, 40 * 86400);
        ok(Math.hypot(...far.r) > 400 * M.R_EARTH, 'integration reached far from Earth');
        const miss = ang(a.vInf, far.v);
        ok(miss < 0.05, `asymptote matches the integrated path to ${miss.toFixed(4)}°`);
        // NEGATIVE CONTROL: ignoring Earth's gravity (straight line) misses by the bend angle
        ok(near(ang(v0, far.v), a.bendDeg, 0.05), `no-gravity control is off by the bend, ${a.bendDeg.toFixed(1)}°`);
    }
    const slow = R.incomingAsymptote([M.R_EARTH, 0, 0], [-12e3 * Math.sin(1), 12e3 * Math.cos(1), 0]);
    const fast = R.incomingAsymptote([M.R_EARTH, 0, 0], [-30e3 * Math.sin(1), 30e3 * Math.cos(1), 0]);
    ok(slow.bendDeg > 5 * fast.bendDeg, `slow arrivals bend more (${slow.bendDeg.toFixed(1)}° vs ${fast.bendDeg.toFixed(1)}°)`);
    ok(R.incomingAsymptote([M.R_EARTH, 0, 0], [0, 9e3, 0]) === null, 'a bound state has no asymptote');
    const radial = R.incomingAsymptote([M.R_EARTH, 0, 0], [-20e3, 0, 0]);
    ok(radial.bendDeg === 0 && rel(radial.speed, M.vInfinity(20e3)) < 1e-12 && radial.vInf[0] < 0, 'an exactly vertical arrival is not bent (zero angular momentum handled)');
    const nearRadial = R.incomingAsymptote([M.R_EARTH, 0, 0], [-20e3, 20, 0]);
    ok(nearRadial.bendDeg < 0.01 && rel(nearRadial.speed, radial.speed) < 1e-6, 'and the general branch joins it continuously');
}

// ── 7 ───────────────────────────────────────────────────────────────────────
section('7. heliocentric conventions');
{
    const circ = R.heliocentricElements([-R.AU_M, 0, 0], [0, -R.V_EARTH_ORBIT, 0]);
    ok(circ.bound && near(circ.aAu, 1, 1e-4) && circ.e < 1e-4 && circ.incDeg < 1e-6, 'Earth\'s own state is a circular 1 au orbit, i = 0 (prograde)');
    ok(near(circ.tisserand, R.A_JUPITER_AU + 2 * Math.sqrt(1 / R.A_JUPITER_AU), 1e-3), 'Tisserand of that orbit');
    ok(R.heliocentricElements([-R.AU_M, 0, 0], [0, -43e3, 0]).bound === false, 'faster than 42.1 km/s at 1 au is unbound');
    ok(R.heliocentricElements([-R.AU_M, 0, 0], [0, R.V_EARTH_ORBIT, 0]).incDeg > 179, 'reversed velocity is retrograde');

    const P = { speedKms: 20, angleDeg: 90, latDeg: 0, sunLonDeg: 0, obliquityDeg: 0, spin: false };
    const noon = R.backtrack({ ...P, localHour: 12 }), midnight = R.backtrack({ ...P, localHour: 0 });
    ok(noon.elongationDeg < 0.01, `vertical at noon comes out of the Sun (${noon.elongationDeg.toFixed(3)}°)`);
    ok(midnight.elongationDeg > 179.99, 'vertical at midnight comes from the anti-Sun');
    const vinf = M.vInfinity(20e3) / 1000, vE = R.V_EARTH_ORBIT / 1000;
    const dawn = R.backtrack({ ...P, localHour: 6 }), dusk = R.backtrack({ ...P, localHour: 18 });
    // dawn is the LEADING side: a vertical impactor there met Earth head-on
    ok(near(dawn.orbit.vHelioKms, vE - vinf, 0.01), `dawn = leading side: heliocentric speed ${dawn.orbit.vHelioKms.toFixed(2)} = ${vE.toFixed(2)} − ${vinf.toFixed(2)}`);
    ok(near(dusk.orbit.vHelioKms, vE + vinf, 0.01), 'dusk = trailing side: it caught Earth up');
    ok(dusk.cls === 'unbound' && dawn.cls === 'asteroidal', 'at 20 km/s: overtaking ⇒ unbound, head-on ⇒ a bound inner orbit');
    ok(dawn.orbit.QAu < 1.001 && dusk.orbit.qAu < 1.001, 'both orbits pass through 1 au');
    const h0 = R.backtrack({ speedKms: 20, angleDeg: 55, latDeg: 21.3, localHour: 0 }), h24 = R.backtrack({ speedKms: 20, angleDeg: 55, latDeg: 21.3, localHour: 24 });
    ok(near(h0.orbit.e, h24.orbit.e, 1e-9), '24 h periodic');
    // Earth's spin is a small correction, not zero
    const spun = R.backtrack({ speedKms: 20, angleDeg: 55, latDeg: 21.3, localHour: 10 }), still = R.backtrack({ speedKms: 20, angleDeg: 55, latDeg: 21.3, localHour: 10, spin: false });
    const d = Math.abs(spun.geocentric.vInfKms - still.geocentric.vInfKms);
    ok(d > 0.01 && d < 0.5, `Earth's spin changes v∞ by ${d.toFixed(2)} km/s`);
    // a steep arrival from the NE at 21°N comes from the northern sky
    ok(spun.radiant.decDeg > 20 && spun.radiant.decDeg < 70, `radiant declination ${spun.radiant.decDeg.toFixed(0)}°N`);

    const lat = O.CRATER.centre.latDeg;
    const slowFam = R.orbitFamily({ latDeg: lat, speedKms: 12 }), fastFam = R.orbitFamily({ latDeg: lat, speedKms: 30 });
    ok(slowFam.share.asteroidal === 1, 'at 12 km/s every hour gives an asteroidal orbit (no constraint)');
    ok(fastFam.share.unbound > 0.3, `at 30 km/s ${(fastFam.share.unbound * 100).toFixed(0)} % of hours are unbound`);
    ok(near(Object.values(fastFam.share).reduce((a, b) => a + b, 0), 1, 1e-12), 'class shares sum to 1');
    const speeds = [14, 17, 20, 24, 28, 34];
    const hc = R.hourConstraint({ latDeg: lat, speeds, speedWeights: speeds.map(R.asteroidSpeedDensity), hours: 24 });
    ok(hc.overall > 0.1 && hc.overall < 0.5, `main-belt-like for ${(hc.overall * 100).toFixed(0)} % of the unknowns`);
    const pre = hc.fraction[4], day = hc.fraction[10];
    ok(day > 5 * pre, `mid-morning ${(day * 100).toFixed(0)} % vs pre-dawn ${(pre * 100).toFixed(0)} %`);
    const map = R.orbitMap({ latDeg: lat });
    ok(map.length === 11 && map[0].cells.length === 48 && map.every((r) => r.cells.every((c) => R.ORBIT_CLASSES.includes(c.cls))), 'orbit map is complete');
}

// ── 8 ───────────────────────────────────────────────────────────────────────
section('8. climate box');
{
    const soot = O.CLIMATE_TARGETS.find((c) => c.id === 'soot');
    const tau0 = M.opticalDepth(soot.massTg, soot.agent);
    ok(rel(tau0, 15000e12 / M.A_EARTH * 10) < 1e-12 && tau0 > 100, `15 000 Tg of soot is optical depth ${tau0.toFixed(0)}`);
    ok(M.EXTINCTION_M2_G.verified === false, 'extinction coefficients are flagged as recalled');
    const life = M.lifetimeFromDarkness(tau0, soot.darkYears);
    const run = M.impactWinter({ tau0, lifetimeYr: life });
    ok(near(run.darkYears, soot.darkYears, 0.05), `the box's darkness ends at ${run.darkYears?.toFixed(2)} yr (anchored on the published ${soot.darkYears})`);
    ok(M.lifetimeFromDarkness(1, 2) === null, 'a load too thin to be dark has no anchor');
    ok(run.light[0] < 1e-100 && run.light[run.light.length - 1] > 0.999, 'pitch dark at first, clear by year 30');
    // exact step: constant forcing ⇒ T(t) = (F/λ)(1 − e^(−λt/C))
    const dark = M.impactWinter({ tau0: 1e6, lifetimeYr: 1e9, years: 5 });
    const exact = -M.ABSORBED_SOLAR / EBM_FEEDBACK * (1 - Math.exp(-EBM_FEEDBACK * 5 / EBM_HEAT_CAPACITY));
    ok(rel(dark.T[dark.T.length - 1], exact) < 1e-9, 'exact exponential step under constant darkness');
    // MEASURED: a mixed-layer box over-cools several-fold against the GCM
    ok(run.peakCoolingK > 2 * soot.peakCoolingK, `mixed-layer box: −${run.peakCoolingK.toFixed(0)} K vs the GCM's −${soot.peakCoolingK} K (pinned as measured)`);
    const dep = M.impliedOceanDepth({ tau0, lifetimeYr: life, targetCoolingK: soot.peakCoolingK });
    ok(near(M.impactWinter({ tau0, lifetimeYr: life, heatCapacity: dep.heatCapacity, years: 40 }).peakCoolingK, soot.peakCoolingK, 0.01), 'impliedOceanDepth lands on the target');
    ok(dep.oceanDepthM > 150 && dep.oceanDepthM < 1500, `equivalent ocean layer ${dep.oceanDepthM.toFixed(0)} m`);
    ok(near(M.OCEAN_W_YR_PER_M * 60, EBM_HEAT_CAPACITY, 1.5), 'the volcano engine\'s C is ~60 m of ocean on this conversion');
    const co2 = M.co2Forcing(425);
    ok(near(co2.addedPpm, 54.4, 0.5) && co2.forcingWm2 > 0.3 && co2.forcingWm2 < 0.7, `425 Gt CO₂ = +${co2.addedPpm.toFixed(0)} ppm, +${co2.forcingWm2.toFixed(2)} W/m²`);
    const re = M.reentryHeating();
    ok(re.solarConstants > 5 && re.solarConstants < 50, `re-entry upper bound ${re.solarConstants.toFixed(0)} × the Sun`);
}

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) process.exit(1);
