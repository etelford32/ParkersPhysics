#!/usr/bin/env node
/**
 * earth-interior-prem.mjs — gate for js/earth-interior/prem.js and
 * js/earth-interior/conductivity.js (INNER_EARTH_PLAN.md P0).
 *
 * Run: node tests/earth-interior-prem.mjs
 *
 * Every check is against something the kernel did not produce:
 *   A. PREM vs ObsPy's TauP node table (byte-pinned fixture, independent
 *      transcription of DA81), BOTH sides of every discontinuity.
 *   B. Mass / moment of inertia re-integrated HERE by a different method
 *      (midpoint rule on premAt, not the kernel's Gauss–Legendre), then
 *      against the measured Earth and DA81's own printed values.
 *   C. The jump list, and the size of DA81's coefficient-rounding residue.
 *   D. Fluid layers, elastic moduli, out-of-range and `side` semantics.
 *   E. Grayver 2017 constants vs the byte-pinned ChaosMagPy file.
 *   F. The impedance recursion vs closed forms (half-space, split layer,
 *      thin sheet, deep-layer limit).
 * Each block that can fail silently carries a NEGATIVE CONTROL that must fail.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    R_EARTH_KM, G_NEWTON, EARTH_MASS_MEASURED_KG, MOI_MEASURED, PREM_REGIONS,
    premAt, premMassKg, momentOfInertiaFactor, gravityMS2, pressureGPa,
    enclosedMassKg, discontinuities, profileAt, regionIndex,
} from '../js/earth-interior/prem.js';
import {
    MU0, GRAYVER_2017, sigmaAt, conductanceS, skinDepthM, layersFromModel,
    layeredImpedance, impedanceSummary, geoelectricVPerKm,
} from '../js/earth-interior/conductivity.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures', 'earth-interior');
let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

// ── Fixtures, byte-pinned (see tests/fixtures/earth-interior/SOURCES.md) ─────
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const premNd = readFileSync(join(FIX, 'prem.nd'));
const condDat = readFileSync(join(FIX, 'Earth_conductivity.dat'));
assert.equal(sha(premNd), 'efd8960973133957f14fad0f98e993e0e9236b045d20dda6be61e4bb73917f45', 'prem.nd pin');
assert.equal(sha(condDat), 'd3c593176edcaf8e4def3ba69cbfd7e22e2bf82898adf58f95463f1cbdc556ed', 'Earth_conductivity.dat pin');
ok('both oracle fixtures match their pinned sha256');

// ── A. PREM vs the TauP node table ──────────────────────────────────────────
console.log('A. PREM vs ObsPy TauP prem.nd (ocean:false variant)');
const nodes = premNd.toString('utf8').split('\n').map((l) => l.trim().split(/\s+/).map(Number))
    .filter((p) => p.length >= 4 && p.every(Number.isFinite));
assert.equal(nodes.length, 88, 'node count');
function nodeErrors(evalAt) {
    let worst = 0, where = null, whereTol = 1; const bad = [];
    for (let i = 0; i < nodes.length; i++) {
        const [depth, vp, vs, rho] = nodes[i];
        // In a depth-sorted table a repeated depth's FIRST row is the shallow
        // side (larger r → 'above'), the second the deep side.
        const dupNext = i + 1 < nodes.length && nodes[i + 1][0] === depth;
        const dupPrev = i > 0 && nodes[i - 1][0] === depth;
        const side = dupNext ? 'above' : dupPrev ? 'below' : (depth === 0 ? 'below' : 'below');
        const p = evalAt(R_EARTH_KM - depth, side);
        const e = Math.max(Math.abs(p.vpKmS - vp), Math.abs(p.vsKmS - vs), Math.abs(p.rhoKgM3 / 1000 - rho));
        const tol = depth > 24.4 && depth < 220 ? NODE_TOL_ANISO : NODE_TOL;
        if (e / tol > worst / (where === null ? 1 : whereTol)) { worst = e; where = depth; whereTol = tol; }
        if (e > tol) bad.push(`${depth} km: ${e.toExponential(2)} > ${tol}`);
    }
    return { worst, where, bad };
}
// The table prints 5 decimals and DA81 4-decimal coefficients; together they
// leave up to 1.3e-4 km/s (measured: outer core at 3771 km). In the 24.4–220 km
// band DA81 is transversely ANISOTROPIC and TauP's isotropic equivalent
// differs from DA81's own isotropic polynomials by up to 1.2e-3 km/s
// (measured at 115 km, 0.015 %) — a convention difference, held to its own band.
const NODE_TOL = 2e-4, NODE_TOL_ANISO = 1.5e-3;
const shipped = nodeErrors((r, side) => premAt(r, { ocean: false, side }));
assert.deepEqual(shipped.bad, [], shipped.bad.join('; '));
ok(`all 88 nodes, both sides of every jump: ≤ ${NODE_TOL} km/s (≤ ${NODE_TOL_ANISO} in the anisotropic 24.4–220 km band)`);
{   // NEGATIVE CONTROL: a plausible transcription slip — D″'s Vp polynomial
    // used for the whole lower mantle — must be caught.
    const dpp = PREM_REGIONS.find((g) => g.name === 'D″');
    const poly = (c, x) => c.reduceRight((s, ci) => s * x + ci, 0);
    const slip = nodeErrors((r, side) => {
        const p = premAt(r, { ocean: false, side });
        return p.region === 'Lower mantle' ? { ...p, vpKmS: poly(dpp.vp, r / R_EARTH_KM) } : p;
    });
    assert.ok(slip.bad.length > 10 && slip.worst > 100 * NODE_TOL, `control should fail (got ${slip.worst})`);
    ok(`negative control: D″ Vp coefficients in the lower mantle → error ${slip.worst.toFixed(3)} km/s, caught`);
}

// ── B. Integrals ────────────────────────────────────────────────────────────
console.log('B. mass, moment of inertia, gravity, pressure');
function midpoint(rhoAt, n = 200000) {
    let M = 0, I = 0; const a = R_EARTH_KM * 1e3, h = a / n;
    for (let k = 0; k < n; k++) {
        const s = (k + 0.5) * h, rho = rhoAt(s / 1e3);
        const dV = 4 * Math.PI * s * s * h;
        M += rho * dV; I += (2 / 3) * rho * s * s * dV;
    }
    return { M, moi: I / (M * a * a) };
}
const indep = midpoint((rKm) => premAt(rKm).rhoKgM3);
assert.ok(rel(premMassKg(), indep.M) < 2e-6, `GL vs midpoint mass ${premMassKg()} vs ${indep.M}`);
assert.ok(Math.abs(momentOfInertiaFactor() - indep.moi) < 2e-6, 'GL vs midpoint MoI');
ok(`kernel GL ≡ independent midpoint rule (mass Δ ${rel(premMassKg(), indep.M).toExponential(1)}, MoI Δ ${Math.abs(momentOfInertiaFactor() - indep.moi).toExponential(1)})`);

const M = premMassKg(), moi = momentOfInertiaFactor();
assert.ok(rel(M, EARTH_MASS_MEASURED_KG) < 5e-4, `mass ${M}`);
assert.ok(rel(M, 5.974e24) < 2e-4, 'DA81 printed mass 5.974e24');
ok(`mass ${M.toExponential(4)} kg: ${(rel(M, EARTH_MASS_MEASURED_KG) * 100).toFixed(3)} % from GM⊕/G (measured), DA81 prints 5.974e24`);
assert.ok(Math.abs(moi - 0.3308) < 1e-4, 'DA81 printed 0.3308');
assert.ok(Math.abs(moi - MOI_MEASURED) < 3e-4, 'observed 0.3307');
ok(`C/MR² ${moi.toFixed(5)}: DA81 0.3308, observed ${MOI_MEASURED}`);
{   // NEGATIVE CONTROL: a mantle density on the core (a "no-core" Earth of the
    // same structure above the CMB) must blow the second integral.
    const lm = PREM_REGIONS.find((g) => g.name === 'D″');
    const poly = (c, x) => c.reduceRight((s, ci) => s * x + ci, 0);
    const bad = midpoint((rKm) => rKm < 3480 ? poly(lm.rho, 3480 / R_EARTH_KM) * 1000 : premAt(rKm).rhoKgM3, 20000);
    assert.ok(Math.abs(bad.moi - MOI_MEASURED) > 30 * 3e-4, `control should fail (moi ${bad.moi})`);
    ok(`negative control: mantle-density core → C/MR² ${bad.moi.toFixed(4)}, outside the band`);
}
// DA81 Table II values (cgs in the paper: kbar, cm/s²). Every G-scaled number
// here comes out 0.064–0.066 % ABOVE DA81, uniformly, while the polynomials
// match the node table to 1e-4: one constant offset, i.e. a different G
// (CODATA 2018 here). Measured, so the band is held at 1e-3.
const checks = [
    ['p at the centre (GPa)', pressureGPa(0), 363.85, 1e-3],
    ['p at the ICB (GPa)', pressureGPa(1221.5), 328.85, 1e-3],
    ['p at the CMB (GPa)', pressureGPa(3480), 135.75, 1e-3],
    ['g at the CMB (m/s²)', gravityMS2(3480), 10.6823, 1e-3],
    ['g at the surface (m/s²)', gravityMS2(R_EARTH_KM), 9.8156, 1e-3],
];
for (const [name, got, want, tol] of checks) {
    assert.ok(rel(got, want) < tol, `${name} ${got} vs ${want}`);
    ok(`${name} ${got.toFixed(3)} vs DA81 ${want} (${(rel(got, want) * 100).toFixed(3)} %)`);
}
{
    let monoP = true, prevP = Infinity;
    for (let rKm = 0; rKm <= R_EARTH_KM; rKm += 7) { const p = pressureGPa(rKm); if (p > prevP + 1e-9) monoP = false; prevP = p; }
    assert.ok(monoP && pressureGPa(R_EARTH_KM) === 0, 'pressure monotone, zero at the surface');
    assert.ok(Math.abs(enclosedMassKg(R_EARTH_KM) - M) < 1, 'M(a) = M');
    // g peaks at the CMB — the textbook feature of a dense core.
    let peakR = 0, peak = 0;
    for (let rKm = 10; rKm <= R_EARTH_KM; rKm += 1) { const g = gravityMS2(rKm); if (g > peak) { peak = g; peakR = rKm; } }
    assert.ok(Math.abs(peakR - 3480) <= 1, `g peaks at ${peakR}`);
    ok(`p monotone, 0 at the surface; g peaks AT the CMB (${peakR} km, ${peak.toFixed(2)} m/s²)`);
}

// ── C. Discontinuities ──────────────────────────────────────────────────────
console.log('C. discontinuities');
const disc = discontinuities();
const first = disc.filter((d) => d.firstOrder).map((d) => d.depthKm);
assert.deepEqual(first, [5149.5, 2891, 670, 400, 220, 24.4, 15, 3]);
ok(`first-order jumps: ${first.join(' / ')} km (the oracle's seven + DA81's ocean floor)`);
const second = disc.filter((d) => !d.firstOrder);
assert.deepEqual(second.map((d) => d.depthKm), [2741, 771, 600, 80]);
const residue = Math.max(...second.map((d) => Math.max(Math.abs(d.above.vpKmS - d.below.vpKmS), Math.abs(d.above.vsKmS - d.below.vsKmS))));
assert.ok(residue < 2e-4, `rounding residue ${residue}`);
ok(`second-order boundaries 2741 / 771 / 600 / 80 km continuous to ${residue.toExponential(1)} km/s (DA81's 4-decimal rounding)`);

// ── D. States, moduli, edges ────────────────────────────────────────────────
console.log('D. fluid layers, moduli, edges');
for (let rKm = 0; rKm <= R_EARTH_KM; rKm += 13) {
    const p = premAt(rKm);
    assert.ok(p.kGPa > 0, `K > 0 at ${rKm}`);
    assert.equal(p.vsKmS === 0, p.state === 'fluid', `Vs = 0 ⇔ fluid at ${rKm} (${p.region})`);
    assert.equal(p.muGPa === 0, p.state === 'fluid');
}
ok('Vs = 0 and μ = 0 exactly in the outer core and the ocean, nowhere else; K > 0 everywhere');
assert.equal(premAt(-1), null); assert.equal(premAt(6371.01), null); assert.equal(premAt(NaN), null);
assert.equal(premAt(3480, { side: 'below' }).region, 'Outer core');
assert.equal(premAt(3480, { side: 'above' }).region, 'D″');
assert.equal(premAt(3480, { side: 'below' }).vsKmS, 0);
assert.ok(premAt(3480, { side: 'above' }).vsKmS > 7);
assert.equal(regionIndex(R_EARTH_KM, { side: 'above' }), PREM_REGIONS.length - 1);
ok('out of range → null; `side` picks the fluid core below the CMB and solid D″ above it');
assert.ok(profileAt(5000).pressureGPa > 0 && profileAt(5000).gravityMS2 > 9);
ok('profileAt bundles the column for the probe');

// ── E. Grayver 2017 conductivity ────────────────────────────────────────────
console.log('E. conductivity profile');
const rows = condDat.toString('utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => l.trim().split(/\s+/).map(Number));
assert.equal(rows.length, GRAYVER_2017.length);
rows.forEach(([d, s], i) => { assert.equal(GRAYVER_2017[i][0], d); assert.equal(GRAYVER_2017[i][1], s); });
ok(`all ${rows.length} rows equal the pinned ChaosMagPy file, exactly`);
assert.equal(sigmaAt(0.5), 7); assert.equal(sigmaAt(1), GRAYVER_2017[1][1]);
assert.equal(sigmaAt(3000), 1e5); assert.ok(Number.isNaN(sigmaAt(-1)));
assert.ok(Math.abs(conductanceS(0, 1) - 7000) < 1e-9, 'ocean conductance 7 kS');
ok('σ sampling, 7 kS ocean conductance, core half-space at 2900 km');

// ── F. Plane-wave impedance ─────────────────────────────────────────────────
console.log('F. layered impedance vs closed forms');
for (const [sigma, T] of [[1e-3, 60], [0.1, 600], [3, 86400]]) {
    const w = 2 * Math.PI / T, exact = Math.sqrt(w * MU0 / sigma);   // |√(iωμ₀/σ)|
    const s = impedanceSummary([{ sigma, thicknessM: Infinity }], T);
    assert.ok(rel(s.magOhm, exact) < 1e-12 && Math.abs(s.phaseDeg - 45) < 1e-9);
    assert.ok(rel(s.apparentResistivityOhmM, 1 / sigma) < 1e-12);
}
ok('uniform half-space: |Z| = √(ωμ₀/σ), phase 45°, ρa = 1/σ — exact');
{
    const T = 300, hs = [{ sigma: 0.02, thicknessM: Infinity }];
    const split = [{ sigma: 0.02, thicknessM: 4e3 }, { sigma: 0.02, thicknessM: 11e3 }, { sigma: 0.02, thicknessM: Infinity }];
    const a = layeredImpedance(hs, T), b = layeredImpedance(split, T);
    assert.ok(Math.hypot(a.re - b.re, a.im - b.im) / Math.hypot(a.re, a.im) < 1e-12);
    ok('a half-space split into layers of the same σ has the same Z');
    // Deep-layer limit: a top layer many skin depths thick IS the half-space.
    const top = { sigma: 1e-3, thicknessM: 40 * skinDepthM(1e-3, T) };
    const c = layeredImpedance([top, { sigma: 10, thicknessM: Infinity }], T);
    const d = layeredImpedance([{ sigma: 1e-3, thicknessM: Infinity }], T);
    assert.ok(Math.hypot(c.re - d.re, c.im - d.im) / Math.hypot(d.re, d.im) < 1e-12);
    assert.ok([c.re, c.im].every(Number.isFinite), 'no overflow in a 40-skin-depth layer');
    ok('a top layer 40 skin depths thick reproduces its own half-space (no tanh overflow)');
    // Thin-sheet limit: Z ≈ Z_b / (1 + τ Z_b), τ = σh, valid for h ≪ δ.
    const tau = 7000, zb = layeredImpedance([{ sigma: 0.01, thicknessM: Infinity }], 3600);
    const den = { re: 1 + tau * zb.re, im: tau * zb.im }, q = den.re ** 2 + den.im ** 2;
    const sheet = { re: (zb.re * den.re + zb.im * den.im) / q, im: (zb.im * den.re - zb.re * den.im) / q };
    const thin = layeredImpedance([{ sigma: 7, thicknessM: 1000 }, { sigma: 0.01, thicknessM: Infinity }], 3600);
    const e = Math.hypot(thin.re - sheet.re, thin.im - sheet.im) / Math.hypot(sheet.re, sheet.im);
    assert.ok(e < 0.05, `thin sheet ${e}`);
    ok(`7 kS ocean over 0.01 S/m at 1 h matches the thin-sheet formula to ${(e * 100).toFixed(2)} % (h/δ = ${(1000 / skinDepthM(7, 3600)).toFixed(2)})`);
}
{   // MEASURED, reported (not tuned): what the global model says the ground
    // does to a 100 nT, 10-minute disturbance, and what the ocean term is worth.
    // A site column = a stated top section over Grayver's mantle below it.
    const over = (topSigma, topKm) => layersFromModel([[0, topSigma], ...GRAYVER_2017.filter(([d]) => d >= topKm)]);
    const L = layersFromModel();
    const eOcean = geoelectricVPerKm(L, 600, 100);
    const eLand = geoelectricVPerKm(over(GRAYVER_2017[1][1], 1), 600, 100);
    const shield = geoelectricVPerKm(over(1e-4, 95), 600, 100);      // 95 km of cratonic shield
    const sed = geoelectricVPerKm(over(0.3, 10), 600, 100);          // 10 km of wet sediment
    assert.ok(eLand > 5 * eOcean, 'the ocean conductance must short the field');
    assert.ok(shield > 3 * sed, 'resistive shield must out-field conductive sediment');
    ok(`100 nT @ 600 s: ocean ${eOcean.toFixed(3)} · global land ${eLand.toFixed(3)} · shield ${shield.toFixed(3)} · sediment ${sed.toFixed(3)} V/km (measured)`);
}

console.log(`\nearth-interior-prem: ${passed} checks passed`);
