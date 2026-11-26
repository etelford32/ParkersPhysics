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
import * as SM from '../js/chicxulub/scene-model.js';
import fs from 'node:fs';
import * as C from '../js/chicxulub/constraints.js';
import * as CL from '../js/chicxulub/collapse.js';
import * as PS from '../js/chicxulub/paleo-sites.js';
import { execFileSync } from 'node:child_process';
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

// ── 9 ───────────────────────────────────────────────────────────────────────
section('9. the 3-D scene kernel');
{
    const b = R.reconstructImpactor({ scenario: 'asteroid' });
    const fwd = M.forward({ diameterKm: b.diameterKm.med, speedKms: b.speedKms.med, angleDeg: b.angleDeg.med, density: b.density.med });
    const tl = SM.timeline(fwd, { fromAzimuthDeg: 45 });
    ok(SM.SKETCH.verified === false, 'the collapse sketch is flagged as a sketch');
    ok(rel(tl.transientRadiusKm * 2, fwd.transientKm) < 1e-12 && rel(tl.finalRadiusKm * 2, fwd.finalKm) < 1e-12 && rel(tl.transientDepthKm, fwd.transientDepthKm) < 1e-12, 'crater sizes are the forward model\'s');
    ok(rel(tl.fireballKm, fwd.fireballKm) < 1e-12, 'fireball radius is the forward model\'s');
    ok(tl.contactS < tl.atmosphereS && tl.atmosphereS < 20 && tl.formS > 30 && tl.formS < 200 && tl.collapseEndS < SM.END_S, `clock: bury ${tl.contactS.toFixed(1)} s < air ${tl.atmosphereS.toFixed(1)} s; bowl ${tl.formS.toFixed(0)} s; collapse done ${tl.collapseEndS.toFixed(0)} s`);
    ok(tl.diameterKm > SM.REFERENCE.everestKm && tl.diameterKm > SM.REFERENCE.cruiseKm, 'the body is taller than Everest and than cruise altitude');

    // the body: straight line at the reconstructed speed, angle and bearing
    const a = SM.impactorState(tl, -10), c = SM.impactorState(tl, -4);
    const d = Math.hypot(a.east - c.east, a.north - c.north, a.up - c.up);
    ok(rel(d, 6 * tl.speedKms) < 1e-12, 'it covers speed × time');
    ok(near(Math.atan2(a.up - c.up, Math.hypot(a.east - c.east, a.north - c.north)) * 180 / Math.PI, tl.angleDeg, 1e-9), 'at the reconstructed angle to the ground');
    ok(a.east > 0 && a.north > 0 && near(a.east, a.north, 1e-9), 'coming from the north-east');
    const dir = SM.travelDirection(tl);
    ok(near(Math.hypot(dir.east, dir.north, dir.up), 1, 1e-12) && dir.east < 0 && dir.north < 0 && dir.up < 0, 'travel direction is a unit vector pointing south-west and down');
    const touch = SM.impactorState(tl, 0);
    ok(near(touch.up, tl.diameterKm / 2, 1e-12) && touch.east === 0 && touch.remaining === 1, 't = 0 is first contact, at the centre');
    ok(SM.impactorState(tl, tl.contactS).remaining === 0 && SM.impactorState(tl, tl.contactS / 2).remaining === 0.5, 'consumed over the contact time');
    ok(!SM.impactorState(tl, -SM.APPROACH_S).inAtmosphere && SM.impactorState(tl, -tl.atmosphereS * 0.5).inAtmosphere, 'enters the air at 100 km');
    let lo = 9, hi = 0; for (let i = 0; i < 4000; i++) { const u = Math.cos(i * 2.399) , v = Math.sin(i * 2.399), z = 1 - 2 * (i + 0.5) / 4000, q = Math.sqrt(1 - z * z); const f = SM.lumpiness(q * u, q * v, z); lo = Math.min(lo, f); hi = Math.max(hi, f); }
    ok(lo > 0.75 && hi < 1.25 && hi - lo > 0.1, `rock shape factor ${lo.toFixed(2)}–${hi.toFixed(2)} (lumpy, bounded)`);
    ok(SM.lumpiness(0.3, 0.4, 0.5, 66) === SM.lumpiness(0.3, 0.4, 0.5, 66), 'deterministic shape');

    // the ground
    ok(SM.surfaceHeightKm(tl, 0, -5) === 0 && SM.craterRadiusKm(tl, -5) === 0, 'undisturbed before contact');
    ok(near(SM.surfaceHeightKm(tl, 0, tl.formS - 1e-9), -tl.transientDepthKm, 1e-6), 'the bowl reaches the transient depth');
    ok(near(SM.craterRadiusKm(tl, tl.formS), tl.transientRadiusKm, 1e-9) && near(SM.craterRadiusKm(tl, SM.END_S), tl.finalRadiusKm, 1e-9), 'radius: transient at formation, final at the end');
    let mono = true, prev = 0; for (let t = 0.5; t <= SM.END_S; t += 0.5) { const r = SM.craterRadiusKm(tl, t); if (r < prev - 1e-12) mono = false; prev = r; }
    ok(mono, 'the hole never shrinks');
    // continuity in time at the two seams, everywhere
    let jump = 0; for (let r = 0; r <= 300; r += 1.5) for (const ts of [tl.formS, tl.collapseEndS]) jump = Math.max(jump, Math.abs(SM.surfaceHeightKm(tl, r, ts - 1e-6) - SM.surfaceHeightKm(tl, r, ts + 1e-6)));
    ok(jump < 1e-3, `no jump in the ground at either seam (${jump.toExponential(1)} km)`);
    // continuity in space
    let step = 0; for (const t of [5, 40, tl.formS, 150, 250, 600]) for (let r = 0; r < 300; r += 0.05) step = Math.max(step, Math.abs(SM.surfaceHeightKm(tl, r + 0.05, t) - SM.surfaceHeightKm(tl, r, t)));
    ok(step < 0.6, `no cliff taller than ${step.toFixed(2)} km per 50 m of ground`);
    ok(Math.abs(SM.surfaceHeightKm(tl, 440, 600)) < 0.02, 'far ground is undisturbed');
    const end = (r) => SM.surfaceHeightKm(tl, r, SM.END_S);
    ok(near(end(tl.finalRadiusKm), tl.finalRimKm, 1e-9) && end(0) < 0 && near(end(0), -tl.finalDepthKm, 0.01), `final: rim +${tl.finalRimKm.toFixed(2)} km at the final radius, floor −${tl.finalDepthKm.toFixed(2)} km`);
    ok(end(tl.peakRingRadiusKm) - end(tl.peakRingRadiusKm - 15) > 0.3 && end(tl.peakRingRadiusKm) - end(tl.peakRingRadiusKm + 15) > 0.2, 'a peak ring stands on the floor at the measured radius');
    ok(near(tl.peakRingRadiusKm * 2, O.CRATER.peakRingDiameterKm.value, 1e-9), 'peak ring diameter is the measured one');
    const mid = (tl.formS + tl.collapseEndS) / 2;
    ok(SM.surfaceHeightKm(tl, 0, mid) > 0 && SM.surfaceHeightKm(tl, 0, mid) < tl.transientDepthKm, `the centre rebounds above the surface mid-collapse (+${SM.surfaceHeightKm(tl, 0, mid).toFixed(1)} km) and falls back`);
    ok(rel(SM.curvatureDropKm(100), 0.785) < 0.01, 'Earth curves 0.78 km in 100 km');

    // the sky
    ok(SM.landingRadiusKm(10) === 0 && SM.landingRadiusKm(SM.END_S) > 2000, 'debris front starts at the crater and is past 2000 km in 15 min');
    for (const km of [100, 500, 1500]) { const T = M.ballisticFlight(km * 1000).timeS; ok(rel(SM.landingRadiusKm(T), km) < 0.01, `landing front at ${T.toFixed(0)} s is ${km} km (inverse of the flight time)`); }
    const cu = SM.curtainState(tl, 30);
    ok(cu.visible && near(cu.baseKm, SM.craterRadiusKm(tl, 30), 1e-9) && cu.topKm > cu.baseKm, 'the curtain stands on the rim and leans outward');
    ok(!SM.curtainState(tl, 0.1).visible && !SM.curtainState(tl, SM.END_S).visible, 'no curtain before the body is buried, none once it has left the scene');
    const fb = SM.fireballState(tl, 400);
    ok(near(fb.radiusKm, tl.fireballKm, 1e-3) && SM.fireballState(tl, 5).radiusKm < tl.fireballKm * 0.5 && fb.opacity < 0.1, 'fireball grows to its radius and fades');

    // the clock: one slider from the approach to thirty years
    let worst = 0; for (let s = 0; s <= 1.0001; s += 0.005) worst = Math.max(worst, Math.abs(SM.timeToSlider(SM.sliderToTime(s)) - Math.min(1, s)));
    ok(worst < 1e-9, 'slider ↔ time round trip');
    ok(SM.sliderToTime(0) === -SM.APPROACH_S && rel(SM.sliderToTime(1), SM.LONG_END_S) < 1e-9 && Math.abs(SM.sliderToTime(SM.timeToSlider(0))) < 1e-9, 'slider spans approach → 30 years, with contact inside it');
    let incr = true; for (let s = 0.005; s <= 1; s += 0.005) if (!(SM.sliderToTime(s) > SM.sliderToTime(s - 0.005))) incr = false;
    ok(incr, 'time increases along the whole slider');
    const share = (a, b) => SM.timeToSlider(b) - SM.timeToSlider(a);
    ok(share(0, 900) > 0.15 && share(900, 2 * 86400) > 0.15 && share(2 * 86400, SM.LONG_END_S) > 0.2, `seconds, hours and years each get room (${[share(0, 900), share(900, 172800), share(172800, SM.LONG_END_S)].map((x) => (x * 100).toFixed(0) + ' %').join(' / ')})`);
    ok(SM.chapterAt(-3) === 'approach' && SM.chapterAt(60) === 'crater' && SM.chapterAt(SM.END_S) === 'crater' && SM.chapterAt(3600) === 'planet', 'chapters: approach → crater → planet');
    const cl = SM.climateTrack();
    const ids = [-15, -3, tl.contactS / 2, 30, 200, 800, 3600, 20 * 3600, 10 * 86400, SM.YEAR_S, 5 * SM.YEAR_S].map((t) => SM.phaseAt(tl, t).id);
    ok(ids.join() === SM.PHASES.join(), `phases in order: ${ids.join(' → ')}`);
    ok(SM.formatClock(-12.34) === 'T−12 s' && SM.formatClock(3.21) === 'T+3.2 s' && SM.formatClock(230) === 'T+3 min 50 s' && SM.formatClock(30000) === 'T+8 h 20 min' && SM.formatClock(5e6) === 'T+58 days' && SM.formatClock(1.2e8) === 'T+3.8 years', 'clock text from seconds to years');

    // the planet: four fronts at the timeline's own speeds, stopping at the antipode
    const f0 = SM.frontsAt(0), f1 = SM.frontsAt(1000);
    ok(Object.values(f0).every((x) => x.km === 0 && !x.done), 'no front before contact');
    ok(near(f1.seismic.km, M.SEISMIC_SPEED, 1e-9) && near(f1.blast.km, M.SOUND_SPEED, 1e-9), 'shaking and blast travel at impact-model\'s speeds');
    ok(near(f1.debris.km, SM.landingRadiusKm(1000), 1e-12) && f1.seismic.km > f1.debris.km && f1.debris.km > f1.blast.km && f1.blast.km > f1.tsunami.km, 'order at 1000 s: shaking, debris, blast, tsunami');
    for (const km of [500, 3000, 12000]) ok(rel(SM.frontsAt(M.tsunamiAt(km * 1000).arrivalS).tsunami.km, km) < 1e-6 && rel(SM.frontsAt(M.effectsAt(fwd, km).seismic.arrivalS).seismic.km, km) < 1e-9, `fronts invert Step 3's arrival times at ${km} km`);
    let fmono = true, pf = SM.frontsAt(1); for (let t = 2; t < 4e5; t *= 1.07) { const f = SM.frontsAt(t); for (const k of Object.keys(f)) if (f[k].km < pf[k].km - 1e-9 || f[k].km > SM.HALF_CIRCUMFERENCE_KM) fmono = false; pf = f; }
    ok(fmono, 'no front goes backwards or past the antipode');
    ok(near(SM.HALF_CIRCUMFERENCE_KM, 20015, 1) && SM.frontsAt(4e5).tsunami.done && SM.frontsAt(4e5).blast.done, 'everything has crossed the planet within five days');
    ok(rel(SM.frontsAt(SM.frontArrivalS('blast')).blast.km, SM.HALF_CIRCUMFERENCE_KM) < 1e-6 && near(SM.frontArrivalS('blast') / 3600, 16.85, 0.05), 'the blast reaches the far side in 16.8 h');
    ok(rel(SM.landingRadiusKm(SM.frontArrivalS('debris', SM.DEBRIS_MOST_KM)), SM.DEBRIS_MOST_KM) < 1e-3, 'debris mark is the exact flight time to 90 % of the way');

    // the sky: anchored on the published darkness, cooling to the published depth
    ok(SM.skyAt(-5).light === 1 && SM.skyAt(-5).tempK === 0 && SM.skyAt(3600).light > 0.97, 'clear before impact and still clear an hour after');
    ok(cl.darkStartS > 5 * 86400 && cl.darkStartS < 60 * 86400 && near(cl.darkEndS / SM.YEAR_S, 2, 0.05), `dark from day ${(cl.darkStartS / 86400).toFixed(0)} to year ${(cl.darkEndS / SM.YEAR_S).toFixed(1)}`);
    ok(SM.skyAt((cl.darkStartS + cl.darkEndS) / 2).light < M.DARK_THRESHOLD && SM.skyAt(cl.darkEndS * 1.6).light > 0.5, 'below the photosynthesis threshold inside that window, bright after it');
    ok(near(cl.coldestK, cl.targetCoolingK, 0.05) && near(SM.skyAt(cl.coldestS).tempK, -cl.coldestK, 0.05) && cl.coldestS > cl.darkEndS, `coldest (−${cl.coldestK.toFixed(1)} K) after the light returns`);
    ok(SM.skyAt(SM.LONG_END_S).tempK < -1, `the one-reservoir box is still ${(-SM.skyAt(SM.LONG_END_S).tempK).toFixed(1)} K cold at 30 yr — recovery is NOT claimed (pinned as measured)`);
    ok(!SM.PHASES.includes('recovery'), 'no recovery phase is offered');
    {   // the two-layer box: same cold, exact heat budget, and (measured) still no recovery
        const soot = O.CLIMATE_TARGETS.find((c) => c.id === 'soot');
        const tau0 = M.opticalDepth(soot.massTg, soot.agent), lifetimeYr = M.lifetimeFromDarkness(tau0, soot.darkYears);
        const Ct = M.impliedOceanDepth({ tau0, lifetimeYr, targetCoolingK: soot.peakCoolingK }).heatCapacity;
        const one = M.impactWinter({ tau0, lifetimeYr, heatCapacity: Ct, years: 30 });
        const run = (g, extra = {}) => M.impactWinterLayered({ tau0, lifetimeYr, totalHeatCapacity: Ct, years: 30, stableExchange: g, ...extra });
        const mid = run(M.LAYERED.stableExchange), end = (r) => r.T[r.T.length - 1];
        ok(Math.abs(mid.peakCoolingK - one.peakCoolingK) < 0.05 && Math.abs(mid.peakAtYr - one.peakAtYr) < 0.05, 'two layers cool exactly as the one box does (mixed while the surface is the colder)');
        ok(mid.heatBalanceError < 1e-9, 'two layers: heat stored = heat in, to rounding');
        ok(near(mid.restratifiedYr, mid.peakAtYr, 0.01) && mid.T.every((v, i) => v >= mid.Tdeep[i] - 1e-12), 'the surface is never colder than the water under it, and floats from the coldest moment on');
        ok(Math.abs(end(run(1e4, { dt: 1 / 20000 })) - end(one)) < 0.05, 'infinite exchange is the one box again');
        const [gLo, gHi] = M.LAYERED.exchangeRange, a = end(run(gLo)), b = end(run(gHi));
        ok(a > b && b > end(one) && a < -M.LAYERED.recoveredWithinK && run(gLo).recoveredYr == null,
            `MEASURED: a second ocean layer does not give a recovery — ${a.toFixed(1)} … ${b.toFixed(1)} K at 30 yr (one box ${end(one).toFixed(1)})`);
        const cut = run(0, { years: 40 });
        ok(cut.recoveredYr > 10 && cut.recoveredYr < 20, `even cut off from the deep water the surface needs ${cut.recoveredYr.toFixed(0)} yr — the limit is C_s/λ, not the deep ocean`);
        ok(M.LAYERED.verified === false, 'the exchange coefficient is flagged unverified');
    }
    const sh = SM.skyShade(cl.darkStartS * 3);
    ok(sh.dim >= 0.45 && sh.dim < 0.5 && SM.skyShade(-1).dim === 1 && near(SM.skyShade(cl.coldestS).cold, 1, 0.01), 'display shade: dim never below 0.45, cold tracks the cooling');
    const evs = SM.timelineEvents(tl);
    ok(evs.length === 9 && evs.every((e, i) => i === 0 || (e.t >= evs[i - 1].t && e.slider >= evs[i - 1].slider)) && evs[0].id === 'contact' && evs.every((e) => near(SM.sliderToTime(e.slider), e.t, 1e-6 * Math.max(1, e.t))), 'nine marks, in order, each at its own slider position');

    // the renderer holds no physics: no scaling-law call, no typed crater number
    const src = fs.readFileSync(new URL('../js/chicxulub/stage.js', import.meta.url), 'utf8');
    ok(!/impact-model|reconstruct\.js|Math\.sqrt|Math\.pow|\*\* ?0\.\d/.test(src), 'stage.js imports no physics kernel and has no power law of its own');
    ok(/camera\.up/.test(src) === false || !/camera\.up\.set/.test(src), 'stage.js never moves camera.up');
}

// ── 10 ──────────────────────────────────────────────────────────────────────
section('10. constraints: fit, tests, and the system of variables');
{
    ok(R.EJECTA_FIT.length === 2 && R.EJECTA_FIT.every((e) => e.distanceKm > 500 && e.logSigma > 0.5), 'two ejecta sections are fitted, each with a stated factor-of-two-or-more width');
    ok(!R.EJECTA_FIT.some((e) => e.name.startsWith('Beloc')), 'Beloc (distance at the time unknown) is NOT fitted');
    const withE = R.reconstructImpactor({ scenario: 'asteroid' }), noE = R.reconstructImpactor({ scenario: 'asteroid', useEjecta: false });
    ok(withE.diameterKm.hi - withE.diameterKm.lo < noE.diameterKm.hi - noE.diameterKm.lo, `the ejecta narrow the diameter (${(withE.diameterKm.hi - withE.diameterKm.lo).toFixed(1)} vs ${(noE.diameterKm.hi - noE.diameterKm.lo).toFixed(1)} km wide)`);

    const f = C.fit(), f2 = C.fit();
    ok(Object.is(f.chi2, f2.chi2) && C.PARAM_KEYS.every((k) => Object.is(f.vars[k], f2.vars[k])), 'the fit is deterministic');
    ok(f.dof === C.FITTED.length - C.PARAMS.length && f.dof === 2, `${C.FITTED.length} fitted rows, ${C.PARAMS.length} variables, ${f.dof} degrees of freedom`);
    ok(f.chi2 < 2 * f.dof + 2, `best fit χ² = ${f.chi2.toFixed(2)} on ${f.dof} dof — the fitted evidence is mutually consistent`);
    ok(f.rows.filter((r) => r.group === 'fitted').every((r) => Math.abs(r.z) < 1.5), 'no fitted row is more than 1.5σ off');
    ok(C.PARAMS.every((p) => f.vars[p.key] > p.lo * 1.001 && f.vars[p.key] < p.hi * 0.999), 'the best fit is inside every bound');
    // it is a minimum: every single-variable nudge raises χ²
    let isMin = true; for (const p of C.PARAMS) for (const k of [0.97, 1.03]) if (C.evaluate({ ...f.vars, [p.key]: f.vars[p.key] * k }).chi2 < f.chi2 - 1e-9) isMin = false;
    ok(isMin, 'no ±3 % step in any variable lowers χ²');
    // the grid posterior and the fit agree
    // the best-fitting POINT sits at the slow, large end of a skewed valley; the grid posterior's median is further along it.
    // They are two summaries of one surface: the fit must lie inside the posterior's size range and at its slow edge.
    ok(f.vars.diameterKm > withE.diameterKm.lo && f.vars.diameterKm < withE.diameterKm.hi && f.vars.speedKms > 0.9 * withE.speedKms.lo && f.vars.speedKms < withE.speedKms.med,
        `fit (${f.vars.diameterKm.toFixed(1)} km, ${f.vars.speedKms.toFixed(1)} km/s) vs grid posterior (${withE.diameterKm.med.toFixed(1)} km, ${withE.speedKms.med.toFixed(1)} km/s): same valley`);
    const ev = C.evaluate(f.vars);
    ok(near(ev.chi2, f.chi2, 1e-12) && near(ev.chi2, ev.rows.filter((r) => r.group === 'fitted').reduce((s, r) => s + r.z * r.z, 0), 1e-12), 'χ² is the sum of the fitted rows\' z²');
    ok(C.evaluate(f.vars, { use: ['rim'] }).chi2 < ev.chi2 + 1e-12, 'a subset of rows gives a smaller χ²');

    // held-out rows are predictions, and they are reported as they fall
    const held = Object.fromEntries(f.rows.filter((r) => r.group === 'held').map((r) => [r.id, r.z]));
    ok(Object.keys(held).length === 5, 'five held-out rows');
    ok(held.outerRing < -2, `the outer ring as the rim is ${held.outerRing.toFixed(1)}σ off — the law describes the inner rim (pinned as measured)`);
    ok(Math.abs(held.peakRing) < 2 && Math.abs(held.quake) < 2 && Math.abs(held.energy) < 2, `peak ring ${held.peakRing.toFixed(1)}σ, quake ${held.quake.toFixed(1)}σ, energy ${held.energy.toFixed(1)}σ — predicted within 2σ`);
    ok(Math.abs(held.beloc) < 1, `Beloc, at its 66 Ma distance from the plate model, is predicted within 1σ (${held.beloc.toFixed(1)}σ; at today's distance it missed by −1.7σ — §12)`);
    // NEGATIVE CONTROL: fitting the outer ring instead breaks the ejecta rows
    const outer = M.forward({ diameterKm: f.vars.diameterKm * (190 / f.pred.finalKm) ** (1 / (M.SCALING.finalExp * M.SCALING.expL)), speedKms: f.vars.speedKms, angleDeg: f.vars.angleDeg, density: f.vars.density });
    const eOuter = C.evaluate({ ...f.vars, diameterKm: outer.input.diameterKm });
    ok(near(eOuter.pred.finalKm, 190, 0.5) && eOuter.rows.find((r) => r.id === 'ejecta1').z > 1.5 && eOuter.chi2 > f.chi2 + 4, `scaled to a 190 km rim, the Raton layer is ${eOuter.rows.find((r) => r.id === 'ejecta1').z.toFixed(1)}σ too thick`);

    // sensitivities against the scaling law's own exponents
    const el = C.elasticity(f.vars), an = C.analyticExponents(f.vars.angleDeg);
    let worst = 0; for (const r of el) for (const k of C.PARAM_KEYS) worst = Math.max(worst, Math.abs(r.d[k] - an[r.key][k]));
    ok(worst < 1e-5, `numerical sensitivities match the analytic exponents (worst ${worst.toExponential(1)})`);
    ok(near(el.find((r) => r.key === 'ejecta0').d.diameterKm, 4 * 0.78, 1e-5) && near(el.find((r) => r.key === 'finalKm').d.speedKms, 1.13 * 0.44, 1e-5), 'debris ∝ L^3.12, crater ∝ v^0.50');

    // the eigen-solver, then the stiff and sloppy directions
    const eg = C.symmetricEigen([[2, 1, 0], [1, 2, 0], [0, 0, 5]]);
    ok(near(eg[0].value, 5, 1e-12) && near(eg[1].value, 3, 1e-12) && near(eg[2].value, 1, 1e-12) && near(Math.abs(eg[1].vector[0]), Math.SQRT1_2, 1e-9), 'Jacobi eigen-solver on a known matrix');
    const st = C.stiffness(f.vars);
    ok(st.modes.length === 5 && st.modes.every((m, i) => i === 0 || m.value <= st.modes[i - 1].value) && st.modes.every((m) => near(Object.values(m.weights).reduce((s, x) => s + x * x, 0), 1, 1e-9)), 'five orthonormal directions, stiffest first');
    ok(near(st.modes.reduce((s, m) => s + m.value, 0), st.fisher.reduce((s, r, i) => s + r[i], 0), 1e-6 * st.fisher[0][0]), 'eigenvalues sum to the trace');
    ok(Math.abs(st.modes[0].weights.diameterKm) > 0.8 && st.modes[0].freedom < 0.06, `stiffest direction is the size (±${(st.modes[0].freedom * 100).toFixed(0)} %)`);
    const soft = st.modes.at(-1);
    ok(Math.abs(soft.weights.fDep) > 0.7 && soft.freedom > 1, `sloppiest direction is the iridium share traded against size and speed (free by a factor ${Math.exp(soft.freedom).toFixed(1)})`);
    ok(st.modes[0].value / soft.value > 500, 'three orders of magnitude between stiff and sloppy');
    // the sloppy direction really is cheap to move along, the stiff one is not
    const step = (m, a) => Object.fromEntries(C.PARAMS.map((p) => [p.key, f.vars[p.key] * Math.exp(a * m.weights[p.key])]));
    const dSoft = [0.3, -0.3].map((a) => C.evaluate(step(soft, a)).chi2 - f.chi2), dStiff = [0.3, -0.3].map((a) => C.evaluate(step(st.modes[0], a)).chi2 - f.chi2);
    ok(dSoft.every((d) => d > -1e-6 && d < 0.5) && dStiff.every((d) => d > 20), `a 0.3 step costs Δχ² ${dSoft.map((d) => d.toFixed(2)).join(' / ')} along the sloppy direction and ${dStiff.map((d) => d.toFixed(0)).join(' / ')} along the stiff one`);
    // the fit is a minimum along EVERY eigen-direction, not just along the axes (coordinate descent alone stalled here)
    ok(st.modes.every((m) => [0.05, -0.05, 0.2, -0.2].every((a) => C.evaluate(step(m, a)).chi2 >= f.chi2 - 1e-7)), 'no step along any eigen-direction lowers χ²');
    // NEGATIVE CONTROL: without the population prior, the size–speed trade-off opens right up
    const noSpeed = C.stiffness(f.vars, { use: C.FITTED.filter((r) => r.id !== 'speed').map((r) => r.id) });
    ok(noSpeed.modes.at(-1).freedom > 3 * soft.freedom, `drop the speed prior and the loosest direction is ${(noSpeed.modes.at(-1).freedom / soft.freedom).toFixed(0)}× looser`);

    // profiles: every variable is bounded by the evidence, and contains the fit
    for (const k of C.PARAM_KEYS) {
        const pr = C.profile(k, { n: 25 });
        ok(pr.pinned && pr.lo <= f.vars[k] * 1.08 && pr.hi >= f.vars[k] * 0.92 && near(pr.min, f.chi2, 0.15), `${k}: Δχ² ≤ 1 over ${pr.lo.toPrecision(3)}–${pr.hi.toPrecision(3)}`);
    }
    const pm = C.pairMap('diameterKm', 'speedKms', f.vars, { n: 24 });
    let lowest = Infinity; for (const c of pm.chi2) lowest = Math.min(lowest, c);
    ok(pm.chi2.length === 576 && lowest >= f.chi2 - 1e-9 && lowest < f.chi2 + 0.6, 'the pair map\'s floor is the fit');
    // with the iridium share held, the iridium row pins the size and the size–speed trade-off is hidden (the first page draft)
    const pmHeld = C.pairMap('diameterKm', 'speedKms', f.vars, { n: 24, freeIridium: false });
    const widthOf = (m) => { const cols = new Set(); for (let i = 0; i < m.n; i++) for (let j = 0; j < m.n; j++) if (m.chi2[i * m.n + j] <= f.chi2 + 1) cols.add(i); return cols.size; };
    ok(pm.freeIridium && !pmHeld.freeIridium && widthOf(pm) >= 2 * widthOf(pmHeld), `iridium share free: the good region spans ${widthOf(pm)} size columns; held: ${widthOf(pmHeld)}`);
    ok(!C.pairMap('diameterKm', 'fDep', f.vars, { n: 8 }).freeIridium, 'the share is not re-adjusted when it is one of the axes');

    // leave-one-out and tension
    const loo = C.leaveOneOut(f);
    ok(loo.length === C.FITTED.length, 'one refit per fitted row');
    const by = Object.fromEntries(loo.map((l) => [l.id, l]));
    ok(Math.abs(by.rim.predictedZ) < 1.5 && Math.abs(by.ejecta0.predictedZ) < 1.5 && Math.abs(by.ejecta1.predictedZ) < 1.5, `rim and both ejecta sections are each predicted by the others (${by.rim.predictedZ.toFixed(1)}, ${by.ejecta0.predictedZ.toFixed(1)}, ${by.ejecta1.predictedZ.toFixed(1)}σ)`);
    ok(by.iridium.loosens === 'fDep', 'the iridium row is the only thing that fixes the iridium share');
    ok(Math.abs(by.angle.predictedZ) > 3, `nothing else constrains the angle (${by.angle.predictedZ.toFixed(1)}σ without the published trajectory)`);
    const tt = C.tensionTable();
    ok(tt.length === 21 && tt[0].chi2 < 2, `no pair of fitted rows is in conflict (worst pair χ² ${tt[0].chi2.toFixed(2)}: ${tt[0].a} + ${tt[0].b})`);
    ok(near(C.unitToParam('speedKms', C.paramToUnit('speedKms', 23)), 23, 1e-9), 'variable ↔ slider round trip');
    // every fitted row responds to at least one variable (no decorative rows)
    ok(st.J.every((row) => row.some((x) => Math.abs(x) > 1e-3)), 'every fitted row moves with at least one variable');
}

section('11. crater collapse: a depth-averaged Bingham layer (MEASURED OUT — the record, unused by the page)');
{
    const dtc = M.transientFromFinal(155e3), L = 16500;
    const run = (o = {}) => CL.collapseRun(dtc, { impactorM: L, ...o });
    const base = run();
    ok(base.massError < 1e-12, `staggered scheme conserves mass (${base.massError.toExponential(1)})`);
    ok(base.frozenAtS > 300 && base.frozenAtS < 900 * 1.5, `the collapse freezes in minutes (${(base.frozenAtS / 60).toFixed(1)} min)`);
    ok(base.peakUpliftKm > 20, `the central uplift overshoots tens of km above the surface (${base.peakUpliftKm.toFixed(0)} km)`);
    ok(near(CL.calibratedYield(), CL.cavityStress(M.SCALING.simpleToComplexKm * 1000 / 1.25), 1e-12), 'the yield strength is the D_c cavity\'s own static stress (one calibration)');
    const still = CL.collapseRun(dtc, { yieldPa: CL.cavityStress(dtc) * 1.05, ejectaRim: false });
    ok(still.steps === 1 && still.etaKm.every((v, i) => Math.fround(v) === still.frames[0].etaKm[i]) && still.peakUpliftKm < 0, 'a cavity held by more than its own stress does not move at all (frozen state is exact)');
    // the three measured failures
    const up = [240, 480, 960].map((n) => run({ cells: n }).peakUpliftKm);
    ok(up[2] / up[0] > 1.3, `FAILURE 1: the central uplift does not converge with the grid (${up.map((u) => u.toFixed(0)).join(' / ')} km)`);
    const ringOverEdge = [1, 1.5].map((rf) => { const m = run({ fluidisedRadii: rf }).morphology; const ring = m.peaks.filter((p) => p.rKm > 0.05 * m.rimRadiusKm).sort((a, b) => b.prominenceKm - a.prominenceKm)[0]; return ring ? ring.rKm / (rf * dtc / 2000) : NaN; });
    ok(ringOverEdge.every((x) => x > 1 && x < 1.4), `FAILURE 2: a ring sits at the assumed fluidised edge (× ${ringOverEdge.map((x) => x.toFixed(2)).join(', ')}), so it is the parameter, not a prediction`);
    ok(base.morphology.finalDiameterKm > 2.5 * 155, `FAILURE 3: a rigid-base layer draws down a basin ${base.morphology.finalDiameterKm.toFixed(0)} km wide (measured 155)`);
    ok(CL.COLLAPSE.verified === false && !fs.readFileSync(new URL('../js/chicxulub-page.js', import.meta.url), 'utf8').includes('collapse.js'), 'rheology flagged unverified; the page does not use this model');
}

section('12. the geography at 66 Ma (plate model: js/paleo/rotations.js, gated by tests/paleo-rotations.mjs)');
{
    let fresh = true;
    try { execFileSync(process.execPath, [new URL('../scripts/build-chicxulub-paleo.mjs', import.meta.url).pathname, '--check'], { stdio: 'pipe' }); } catch { fresh = false; }
    ok(fresh, 'js/chicxulub/paleo-sites.js is exactly what the plate model gives (regenerate with scripts/build-chicxulub-paleo.mjs)');
    const P = PS.PALEO_SITES;
    ok(P.chicxulub.today.latDeg === O.CRATER.centre.latDeg && P.chicxulub.today.lonDeg === O.CRATER.centre.lonDeg, 'the bake used the evidence table\'s crater centre');
    ok(O.EJECTA_SITES.every((s) => { const k = { Beloc: 'beloc', 'El Mimbral': 'el-mimbral', 'Raton Basin': 'raton', Tanis: 'tanis' }[s.name.split(',')[0]]; return P[k].today.latDeg === s.latDeg && P[k].today.lonDeg === s.lonDeg; }), '…and its ejecta-site coordinates');
    const same = ['el-mimbral', 'raton', 'tanis'].every((k) => Math.abs(P[k].distance66Km - P[k].distanceTodayKm) < 0.5);
    ok(same && P['el-mimbral'].chain.includes(101) && P.chicxulub.chain.includes(101), 'the fitted ejecta sites ride the crater\'s own plate: their distances are unchanged, so the fit is untouched');
    ok(P.beloc.distance66Km < 0.65 * P.beloc.distanceTodayKm, `Beloc was ${P.beloc.distance66Km.toFixed(0)} km from the crater, not ${P.beloc.distanceTodayKm.toFixed(0)}`);
    const t = C.evaluate(C.fit().vars), bel = t.rows.find((r) => r.id === 'beloc');
    const today = C.predict(C.fit().vars).ejectaBelocToday;
    const zToday = Math.log(today / O.EJECTA_SITES.find((s) => s.name.startsWith('Beloc')).thicknessM) / Math.log(3);
    ok(Math.abs(bel.z) < 1 && zToday < -1.3, `HELD-OUT Beloc, at its 66 Ma distance: z ${bel.z.toFixed(2)}; at today's distance it was ${zToday.toFixed(2)} — a prediction, never fitted`);
    ok(Math.abs(R.TRAJECTORY_SITE.latDeg - P.chicxulub.at66.latDeg) < 1e-12 && Math.abs(R.TRAJECTORY_SITE.bearingShiftDeg - PS.PALEO_BEARING_SHIFT_DEG) < 1e-12, 'the trajectory reads the 66 Ma latitude and bearing turn');
    ok(PS.PALEO_BEARINGS.every(([b, b66]) => Math.abs(((b66 - b - PS.PALEO_BEARING_SHIFT_DEG + 540) % 360) - 180) < 0.01), 'every bearing turns by the same angle (a rigid rotation)');
    const hcP = R.hourConstraint({ latDeg: R.TRAJECTORY_SITE.latDeg, azimuthShiftDeg: R.TRAJECTORY_SITE.bearingShiftDeg, speeds: [14, 20, 28], speedWeights: [14, 20, 28].map(R.asteroidSpeedDensity), hours: 24 });
    const hcT = R.hourConstraint({ latDeg: R.TRAJECTORY_SITE.todayLatDeg, speeds: [14, 20, 28], speedWeights: [14, 20, 28].map(R.asteroidSpeedDensity), hours: 24 });
    ok(Math.abs(hcP.overall - hcT.overall) < 0.05 && hcP.bestHour === hcT.bestHour, `the orbit answer barely moves with the 66 Ma geography (main-belt share ${(hcP.overall * 100).toFixed(0)} % vs ${(hcT.overall * 100).toFixed(0)} % today; best hour ${hcP.bestHour} h both) — measured`);
    ok(/mantle/.test(PS.PALEO_MODEL.frame) && !O.OPEN_DATA.some((s) => /palaeolatitude and rotation/.test(s)), 'the frame is disclosed as the mantle\'s; OPEN_DATA now asks for the spin-axis position instead');
}

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) process.exit(1);
