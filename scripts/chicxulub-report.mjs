#!/usr/bin/env node
/**
 * chicxulub-report.mjs — print the Chicxulub reconstruction (no network).
 *   node scripts/chicxulub-report.mjs
 * Reads only js/chicxulub/*; every number it prints is the kernels'.
 */
import * as O from '../js/chicxulub/observations.js';
import * as M from '../js/chicxulub/impact-model.js';
import * as R from '../js/chicxulub/reconstruct.js';
import * as C from '../js/chicxulub/constraints.js';

const f = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : x.toFixed(d));
const e = (x) => (x == null ? '—' : x.toExponential(2));
const band = (q, d = 1, s = 1) => `${f(q.med * s, d)}  (${f(q.lo * s, d)}–${f(q.hi * s, d)})`;

console.log('══ 1. Published impactors through the scaling laws ══');
console.log('observed: inner rim 140–170 km, outer rim 180–200 km, Ir 55 ± 3 ng/cm²');
for (const p of O.PUBLISHED_IMPACTORS) {
    const w = M.forward({ diameterKm: p.diameterKm, speedKms: p.speedKms, angleDeg: p.angleDeg, density: p.density });
    console.log(`  ${p.label.padEnd(26)} D ${p.diameterKm} km @ ${p.speedKms} km/s ${p.angleDeg}° → transient ${f(w.transientKm, 0)} km, final ${f(w.finalKm, 0)} km, E ${e(w.energyJ)} J, Mw ${f(w.seismicM)}, Ir(all) ${f(w.iridiumNgCm2, 0)} ng/cm²`);
}

console.log('\n══ 2. The impactor, backwards ══');
for (const scenario of ['crater-only', 'all-iridium', 'asteroid']) {
    const r = R.reconstructImpactor({ scenario });
    console.log(`  [${scenario}]`);
    console.log(`     diameter  ${band(r.diameterKm)} km      speed ${band(r.speedKms)} km/s     angle ${band(r.angleDeg, 0)}°`);
    console.log(`     mass      ${e(r.massKg.med)} kg (${e(r.massKg.lo)}–${e(r.massKg.hi)})   energy ${e(r.energyJ.med)} J (${e(r.energyJ.lo)}–${e(r.energyJ.hi)})`);
    console.log(`     Ir in the global layer: ${band(r.fDep, 2)} of the impactor's`);
}
const m55 = M.massFromIridium({ fluenceNgCm2: 55, abundanceNgG: 595 });
const m28 = M.massFromIridium({ fluenceNgCm2: 28, abundanceNgG: 595 });
for (const craterKm of [155, 190]) {
    const r = R.reconstructImpactor({ scenario: 'asteroid', craterKm });
    console.log(`  rim = ${craterKm} km → diameter ${band(r.diameterKm)} km, energy ${e(r.energyJ.med)} J, Ir fraction ${band(r.fDep, 2)}`);
}
console.log(`  iridium alone: 55 ng/cm² → ${e(m55)} kg → ${f(M.diameterFromMass(m55, 2200) / 1000)} km at 2200 kg/m³;  28 ng/cm² → ${f(M.diameterFromMass(m28, 2200) / 1000)} km`);
console.log(`  speed a ${f(M.diameterFromMass(m55, 2200) / 1000)} km body needs for a 155 km crater: ${f(R.speedForCrater(M.diameterFromMass(m55, 2200) / 1000))} km/s`);

console.log('\n══ 3. The trajectory, backwards ══');
const lat = R.TRAJECTORY_SITE.latDeg, azShift = R.TRAJECTORY_SITE.bearingShiftDeg;
console.log(`  site at 66 Ma (plate model): ${f(lat, 2)}°N (today ${f(R.TRAJECTORY_SITE.todayLatDeg, 2)}°N); today's bearings turn ${f(azShift)}° clockwise`);
const ast = R.reconstructImpactor({ scenario: 'asteroid' });
for (const v of [12, 20, 30]) {
    const fam = R.orbitFamily({ latDeg: lat, speedKms: v, fromAzimuthDeg: 45 + azShift });
    const g = fam.rows[0].geocentric;
    console.log(`  v = ${v} km/s: v∞ ${f(g.vInfKms)} km/s, Earth bends the path ${f(g.bendDeg)}°; classes over the day: ` +
        Object.entries(fam.share).filter(([, s]) => s > 0).map(([c, s]) => `${c} ${(s * 100).toFixed(0)}%`).join(', '));
}
const speeds = [14, 17, 20, 24, 28, 34];
const hc = R.hourConstraint({ latDeg: lat, azimuthShiftDeg: azShift, speeds, speedWeights: speeds.map(R.asteroidSpeedDensity) });
console.log(`  main-belt-like orbit possible for ${(hc.overall * 100).toFixed(0)}% of (hour × speed × angle × bearing × season); best local hour ${f(hc.bestHour)} h`);
console.log('  by local hour: ' + hc.hours.filter((_, i) => i % 4 === 0).map((h, i) => `${String(h).padStart(2, '0')}h ${(hc.fraction[i * 4] * 100).toFixed(0)}%`).join('  '));
const ex = R.backtrack({ speedKms: 20, angleDeg: 55, fromAzimuthDeg: 45 + azShift, latDeg: lat, localHour: hc.bestHour });
console.log(`  example at ${f(hc.bestHour)} h, 20 km/s: a ${f(ex.orbit.aAu, 2)} au, e ${f(ex.orbit.e, 2)}, i ${f(ex.orbit.incDeg)}°, q ${f(ex.orbit.qAu, 2)}, Q ${f(ex.orbit.QAu, 2)} au, T_J ${f(ex.orbit.tisserand, 2)} (${ex.cls}); radiant ecliptic lat ${f(ex.radiant.eclLatDeg)}°`);

console.log('\n══ 4. What it did (asteroid-scenario median impactor) ══');
const w = M.forward({ diameterKm: ast.diameterKm.med, speedKms: ast.speedKms.med, angleDeg: ast.angleDeg.med, density: ast.density.med, fDep: ast.fDep.med });
console.log(`  energy ${e(w.energyJ)} J = ${e(w.megatons)} Mt;  transient ${f(w.transientKm, 0)} km × ${f(w.transientDepthKm, 0)} km deep, excavated to ${f(w.excavationDepthKm, 0)} km; final ${f(w.finalKm, 0)} km; melt ${e(w.meltKm3)} km³; Mw ${f(w.seismicM)}; fireball ${f(w.fireballKm, 0)} km`);
for (const s of O.EJECTA_SITES) {
    const r = R.siteDistanceKm(s);          // at 66 Ma where the plate model has the site
    const x = M.effectsAt(w, r);
    console.log(`  ${s.name.padEnd(22)} ${f(r, 0).padStart(5)} km: quake ${f(x.seismic.arrivalS / 60)} min; ejecta ${f(x.ejecta.arrivalS / 60)} min, ${f(x.ejecta.thicknessM * 100, 1)} cm (observed ${s.thicknessM == null ? '—' : f(s.thicknessM * 100, 1) + ' cm'}); blast ${f(x.blast.arrivalS / 3600)} h, ${f(x.blast.windMs, 0)} m/s; tsunami ${f(x.tsunami.heightM, 0)} m`);
}
const re = M.reentryHeating();
console.log(`  re-entering ejecta (3 mm layer): ${f(re.kgM2)} kg/m², ≤ ${f(re.fluxWm2 / 1000)} kW/m² for an hour at the top of the atmosphere (${f(re.solarConstants)} × the Sun) — upper bound`);
console.log('  climate box vs the GCMs:');
for (const c of O.CLIMATE_TARGETS) {
    const tau0 = M.opticalDepth(c.massTg, c.agent);
    if (c.darkYears == null || c.massTg == null) { console.log(`    ${c.agent.padEnd(20)} τ₀ ${f(tau0, 0)}; mass or darkness duration missing — box not run (GCM: −${c.peakCoolingK} K)`); continue; }
    const life = M.lifetimeFromDarkness(tau0, c.darkYears);
    const box = M.impactWinter({ tau0, lifetimeYr: life });
    const dep = M.impliedOceanDepth({ tau0, lifetimeYr: life, targetCoolingK: c.peakCoolingK });
    console.log(`    ${c.agent.padEnd(20)} τ₀ ${f(tau0, 0)}, e-fold ${f(life, 2)} yr → box −${f(box.peakCoolingK)} K at ${f(box.peakAtYr)} yr (GCM −${c.peakCoolingK} K); GCM answer needs ${f(dep?.oceanDepthM, 0)} m of ocean`);
}
const co2 = M.co2Forcing(O.VOLATILES.co2Gt.value);
console.log(`  CO₂: +${f(co2.addedPpm, 0)} ppm on ${co2.backgroundPpm} → +${f(co2.forcingWm2, 2)} W/m² → +${f(co2.forcingWm2 / 1.2, 2)} K afterwards`);

console.log('\n══ 5. Constraints ══');
const fitC = C.fit();
console.log(`  best fit: ${C.PARAMS.map((p) => `${p.label} ${fitC.vars[p.key].toFixed(p.digits)} ${p.unit}`).join(' · ')}   χ² ${f(fitC.chi2, 2)} on ${fitC.dof} dof`);
for (const r of fitC.rows) { const row = C.ROWS.find((q) => q.id === r.id), k = row.scale ?? 1; console.log(`  ${r.group.padEnd(6)} ${row.label.padEnd(36)} model ${Number(r.model * k).toPrecision(3).padStart(9)}  observed ${row.obs == null ? '   prior' : Number(row.obs * k).toPrecision(3).padStart(8)} ${row.unit.padEnd(7)} z ${r.z >= 0 ? '+' : ''}${f(r.z, 2)}`); }
console.log('  what the evidence pins down (stiff → loose):');
for (const m of C.stiffness(fitC.vars).modes) console.log(`    free by ×${Math.exp(m.freedom).toFixed(2).padStart(5)}: ` + C.PARAMS.filter((p) => Math.abs(m.weights[p.key]) > 0.2).map((p) => `${m.weights[p.key] > 0 ? '+' : '−'}${Math.abs(m.weights[p.key]).toFixed(2)} ${p.label}`).join('  '));
for (const k of C.PARAM_KEYS) { const pr = C.profile(k), p = C.PARAMS.find((q) => q.key === k); console.log(`  ${p.label.padEnd(22)} ${pr.lo.toFixed(p.digits)}–${pr.hi.toFixed(p.digits)} ${p.unit} (Δχ² ≤ 1, others re-fitted)`); }
for (const l of C.leaveOneOut(fitC)) console.log(`  without ${l.id.padEnd(8)} → that row predicted at ${l.predictedZ >= 0 ? '+' : ''}${f(l.predictedZ, 1)}σ${l.loosens ? `; leaves ${l.loosens} loose` : ''}`);
