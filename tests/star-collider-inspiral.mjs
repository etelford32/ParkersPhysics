#!/usr/bin/env node
/**
 * star-collider-inspiral.mjs — the post-Newtonian inspiral against known answers.
 *
 *   node tests/star-collider-inspiral.mjs
 *
 * THE TIDAL COEFFICIENT, derived (so a future edit can re-check it rather
 * than trust a memory). Body 1 with tidal deformability λ₁ in the field of
 * point mass m₂ at separation r:
 *   E_ij = −∂ᵢ∂ⱼ(m₂/r) ⇒ E_ij E_ij = 6 m₂²/r⁶,
 *   Q_ij = −λ₁ E_ij (adiabatic), V_int = ½ Q_ij E_ij = −½ λ₁ E², internal
 *   deformation energy +¼ λ₁ E² ⇒ V_tidal = −¼ λ₁ E² = −(3/2) λ₁ m₂²/r⁶.
 * Circular orbits: ω² = (M/r³)[1 + 9 (m₂/m₁) λ₁/r⁵];
 *   E = −½ μM/r + 3 λ₁ m₂²/r⁶ ⇒ E(x) = −½ μ x [1 − 9 (m₂/m₁) λ̂₁ x⁵],
 * matching Flanagan & Hinderer 2008. The system quadrupole gains the
 * induced one: Q_tot = (μ r² + 3λ₁m₂/r³)(nn − δ/3) ⇒
 *   F = (32/5) η² x⁵ [1 + 6 (m₁ + 3m₂)/m₁ λ̂₁ x⁵].
 * dx/dt = −F/(dE/dx) ⇒ (64η/5M) x⁵ [1 + 6 (m₁ + 12 m₂)/m₁ λ̂₁ x⁵], and with
 * λ̂₁ = Λ₁ X₁⁵ the sum over both bodies is 6·(13/16)·Λ̃ = (39/8) Λ̃.
 */

import assert from 'node:assert/strict';
import {
    chirpMass, symmetricMassRatio, combinedTidal, gwFrequencyHz, xAtGwFrequency, iscoFrequencyHz,
    taylorT4Bracket, spinOrbitDelta, inspiral, newtonianTimeToMerger, mergerTimePeters, semiMajorAxisKm,
    gwFrequencyAtSeparationHz, formatDuration, MPC_GEOM,
} from '../js/star-collider/inspiral.js';

let passed = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); passed++; };
const within = (v, target, rel, what) =>
    assert.ok(Math.abs(v - target) <= rel * Math.abs(target), `${what}: ${v} vs ${target} (±${(rel * 100).toFixed(1)} %)`);

const YR = 3.15576e7;

ok('chirp mass of GW170817 (1.46 + 1.27) is 1.186', () => {
    within(chirpMass(1.46, 1.27), 1.186, 3e-3, 'M_chirp');
    within(symmetricMassRatio(1.4, 1.4), 0.25, 1e-12, 'η equal-mass');
});

ok('Λ̃ reduces to Λ for equal masses and equal deformabilities', () => {
    within(combinedTidal(1.4, 1.4, 300, 300), 300, 1e-12, 'Λ̃');
    // Heavier body dominates less: weight (m₁ + 12 m₂) m₁⁴.
    const lt = combinedTidal(1.6, 1.2, 100, 800);
    assert.ok(lt > 100 && lt < 800, `Λ̃ mixed = ${lt}`);
});

ok('frequency ↔ x round-trips and the ISCO frequency is 4397 Hz / M', () => {
    const x = xAtGwFrequency(100, 2.8);
    within(gwFrequencyHz(x, 2.8), 100, 1e-9, 'round trip');
    within(iscoFrequencyHz(1), 4397, 1e-3, 'f_ISCO(1 M☉)');
    within(iscoFrequencyHz(65), 4397 / 65, 1e-3, 'f_ISCO(65 M☉)');
});

ok('TaylorT4 bracket is 1 at x → 0, tidal term is (39/8)Λ̃ x⁵, aligned spins slow the chirp', () => {
    within(taylorT4Bracket(1e-6, 0.25, 0, 0), 1, 1e-4, 'x→0');
    const dTidal = taylorT4Bracket(0.1, 0.25, 0, 400) - taylorT4Bracket(0.1, 0.25, 0, 0);
    within(dTidal, (39 / 8) * 400 * 0.1 ** 5, 1e-12, 'tidal increment');
    const d = spinOrbitDelta(1.4, 1.4, 0.5, 0.5);
    assert.ok(d < 0, `aligned spin-orbit δ = ${d} should be negative`);
    assert.ok(taylorT4Bracket(0.05, 0.25, d, 0) < taylorT4Bracket(0.05, 0.25, 0, 0), 'hang-up');
});

ok('1.4 + 1.4 M☉ from 10 Hz takes ~1000 s to merge (Newtonian 999 s; PN ~1 % longer)', () => {
    within(newtonianTimeToMerger(1.4, 1.4, 10), 999, 0.01, 'Newtonian');
    const r = inspiral({ m1: 1.4, m2: 1.4, fStartHz: 10, r1Km: 11.7, r2Km: 11.7, distanceMpc: 40, tailSeconds: 0.02 });
    assert.ok(r.valid, 'valid');
    // At x ≈ 0.006 the 1PN coefficient (−743/336 − 11η/4 ≈ −2.9) beats the
    // 1.5PN tail (+4π x^{3/2}), so the PN inspiral from 10 Hz is ~1 % LONGER
    // than the Newtonian estimate, not shorter.
    within(r.timeToMergerS, 999, 0.03, 'PN time to merger');
    assert.ok(r.timeToMergerS > 999, 'the 1PN term lengthens the inspiral at low frequency');
    assert.ok(r.gwCycles > 15000 && r.gwCycles < 17500, `GW cycles from 10 Hz = ${r.gwCycles}`);
    assert.equal(r.endReason, 'contact', 'a BNS ends at contact');
    assert.ok(r.fEndHz > 1200 && r.fEndHz < 1800, `contact f_GW = ${r.fEndHz}`);
    assert.ok(r.strainAtEnd > 1e-22 && r.strainAtEnd < 1e-21, `h at 40 Mpc = ${r.strainAtEnd}`);
    assert.ok(r.tail.hPlus.length > 200, 'tail sampled');
    const hmax = Math.max(...r.tail.hPlus.map(Math.abs));
    within(hmax, r.strainAtEnd, 0.15, 'tail amplitude reaches the end strain');
    assert.ok(r.tail.f[0] < r.tail.f[r.tail.f.length - 1], 'chirp: f rises through the tail');
});

ok('tides shorten the inspiral: Λ = 1400 merges sooner than Λ = 0 from 300 Hz', () => {
    const base = { m1: 1.4, m2: 1.4, fStartHz: 300, r1Km: 0, r2Km: 0, tailSeconds: 0.01 };
    const a = inspiral({ ...base, lambda1: 0, lambda2: 0 });
    const b = inspiral({ ...base, lambda1: 1400, lambda2: 1400 });
    assert.ok(b.timeToMergerS < a.timeToMergerS, `${b.timeToMergerS} vs ${a.timeToMergerS}`);
    // ~1.5 GW cycles from 300 Hz for Λ̃ = 1400 — the same order the GW170817
    // analyses quote for the tidal dephasing over the last ~1000 cycles.
    assert.ok(a.gwCycles - b.gwCycles > 0.8 && a.gwCycles - b.gwCycles < 4, `Λ̃=1400 removes ${a.gwCycles - b.gwCycles} cycles from 300 Hz`);
});

ok('a 36 + 29 M☉ binary (GW150914) ends at ISCO near 68 Hz and chirps for ~0.2 s from 30 Hz', () => {
    const r = inspiral({ m1: 36, m2: 29, fStartHz: 30, distanceMpc: 410, tailSeconds: 0.2 });
    assert.equal(r.endReason, 'isco');
    within(r.fEndHz, 4397 / 65, 1e-3, 'f_ISCO');
    assert.ok(r.timeToMergerS > 0.12 && r.timeToMergerS < 0.35, `t_merge from 30 Hz = ${r.timeToMergerS}`);
    assert.ok(r.strainAtEnd > 3e-22 && r.strainAtEnd < 3e-21, `h at 410 Mpc = ${r.strainAtEnd}`);
});

ok('Hulse–Taylor: a from P_b = 7.75 h is 1.95×10⁶ km and Peters gives ~300 Myr', () => {
    const a = semiMajorAxisKm(27906.98, 1.4398 + 1.3886);
    within(a, 1.95e6, 0.01, 'a');
    const t = mergerTimePeters({ m1: 1.4398, m2: 1.3886, aKm: a, e: 0.6171 });
    within(t / (1e6 * YR), 300, 0.05, 'T_merge Myr');
    // Circular limit sanity: e = 0 is much longer (1.6 Gyr).
    const tc = mergerTimePeters({ m1: 1.4398, m2: 1.3886, aKm: a, e: 0 });
    within(tc / (1e9 * YR), 1.64, 0.03, 'circular T_merge Gyr');
});

ok('Double pulsar: 85 Myr', () => {
    const a = semiMajorAxisKm(8834.5, 1.3381 + 1.2489);
    const t = mergerTimePeters({ m1: 1.3381, m2: 1.2489, aKm: a, e: 0.0878 });
    within(t / (1e6 * YR), 85, 0.06, 'T_merge Myr');
});

ok('helpers: separation → f_GW, distance unit, duration formatting', () => {
    // 1.4+1.4 at 100 km: ω = √(M/a³) → f_GW = ω/π
    const f = gwFrequencyAtSeparationHz(100, 2.8);
    assert.ok(f > 150 && f < 250, `f_GW(100 km) = ${f}`); // GW170817 was at ~200 Hz when the stars were 100 km apart
    within(MPC_GEOM, 2.09e19, 1e-2, 'Mpc in geometric units');
    assert.equal(formatDuration(300e6 * YR), '300 Myr');
    assert.equal(formatDuration(0.0025), '2.50 ms');
});

ok('an invalid start (past ISCO) is reported, not thrown', () => {
    const r = inspiral({ m1: 30, m2: 30, fStartHz: 500 });
    assert.equal(r.valid, false);
});

console.log(`✅ star-collider-inspiral: ${passed} checks passed`);
