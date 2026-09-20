#!/usr/bin/env node
/**
 * star-collider-remnant.mjs — the aftermath fits against the events they were fitted to.
 *
 *   node tests/star-collider-remnant.mjs
 *
 * GW150914 and GW190521 pin the black-hole fits; GW170817's ejecta budget and
 * kilonova pin the neutron-star side; the NSBH branch is checked for the two
 * things it must do (swallow a GW200105-like system, disrupt a light, fast-
 * spinning one). Each tolerance is the fit's own quoted accuracy.
 */

import assert from 'node:assert/strict';
import { createEos } from '../js/star-collider/eos.js';
import { massRadiusSequence, starAtMass, thresholdMass } from '../js/star-collider/tov.js';
import {
    kerrIsco, iscoEnergy, horizonRadius, bbhRemnant, bnsOutcome, bnsDynamicalEjecta, bnsDiskMass,
    nsbhOutcome, wdOutcome, rocheLobeFraction, kilonovaComponent, kilonova, bolometricMagnitudes,
    rProcessHeating, magneticInteraction, classifyPair,
} from '../js/star-collider/remnant.js';

let passed = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); passed++; };
const within = (v, target, rel, what) =>
    assert.ok(Math.abs(v - target) <= rel * Math.abs(target), `${what}: ${v} vs ${target} (±${(rel * 100).toFixed(1)} %)`);

ok('Kerr ISCO: 6M at χ=0, 1M at χ→1 prograde, 9M retrograde; E_ISCO(0) = √(8/9)', () => {
    within(kerrIsco(0), 6, 1e-12, 'r_isco(0)');
    within(kerrIsco(0.9999), 1, 0.1, 'r_isco(1)'); // approaches 1 slowly: 1.08 at χ = 0.9999
    within(kerrIsco(-0.9999), 9, 0.02, 'r_isco(−1)');
    within(iscoEnergy(0), Math.sqrt(8 / 9), 1e-12, 'E_isco');
    within(horizonRadius(0), 2, 1e-12, 'r_+(0)');
    within(horizonRadius(1), 1, 1e-12, 'r_+(1)');
});

ok('GW150914: 36 + 29 → 62 M☉ with spin 0.67 (χ_eff ≈ 0)', () => {
    const r = bbhRemnant(36, 29, 0, 0);
    within(r.finalMass, 62, 0.02, 'M_f');
    within(r.finalSpin, 0.67, 0.04, 'χ_f');
    within(r.radiatedMass, 3.0, 0.1, 'E_rad');
    assert.ok(r.radiatedErg > 5e54 && r.radiatedErg < 6e54, `E_rad = ${r.radiatedErg} erg`);
});

ok('equal-mass aligned spins: χ_f ≈ 0.83 and E_rad ≈ 6.7 % at χ = 0.5, 9.4 % at 0.8; GW190521 → ~142 M☉', () => {
    within(bbhRemnant(30, 30, 0.5, 0.5).finalSpin, 0.83, 0.03, 'χ_f');
    within(bbhRemnant(30, 30, 0.5, 0.5).radiatedFraction, 0.067, 0.05, 'E_rad(0.5)');
    within(bbhRemnant(30, 30, 0.8, 0.8).radiatedFraction, 0.094, 0.05, 'E_rad(0.8)');
    // GW190521's spins are in-plane (precessing); the aligned components are ~0.
    const g = bbhRemnant(85, 66, 0, 0);
    within(g.finalMass, 142, 0.03, 'M_f GW190521');
    assert.ok(g.radiatedMass > 6 && g.radiatedMass < 10, `E_rad = ${g.radiatedMass}`);
});

// ── BNS ─────────────────────────────────────────────────────────────────────
const sly = createEos('SLy'), slySeq = massRadiusSequence(sly, 40);
const mpa1 = createEos('MPA1'), mpa1Seq = massRadiusSequence(mpa1, 40);
const ms1 = createEos('MS1'), ms1Seq = massRadiusSequence(ms1, 40);
const star = (eos, seq, m) => starAtMass(eos, m, seq);

const eng = createEos('ENG'), engSeq = massRadiusSequence(eng, 40);

ok('GW170817 on SLy is a marginal prompt collapse; on ENG hypermassive; on MPA1 supramassive; on MS1 stable', () => {
    const a = bnsOutcome(star(sly, slySeq, 1.46), star(sly, slySeq, 1.27), slySeq.mmax, thresholdMass(slySeq.mmax));
    assert.equal(a.fate, 'prompt collapse'); assert.equal(a.marginal, true);
    const e = bnsOutcome(star(eng, engSeq, 1.46), star(eng, engSeq, 1.27), engSeq.mmax, thresholdMass(engSeq.mmax));
    assert.equal(e.fate, 'hypermassive neutron star');
    // MPA1's M_max is 2.46, so 2.73 M☉ sits under the 1.2 M_max rigid-rotation
    // limit: a long-lived supramassive remnant — one of the ways GW170817's
    // blue kilonova argued AGAINST the stiffest EOSs.
    const b = bnsOutcome(star(mpa1, mpa1Seq, 1.46), star(mpa1, mpa1Seq, 1.27), mpa1Seq.mmax, thresholdMass(mpa1Seq.mmax));
    assert.equal(b.fate, 'supramassive neutron star');
    const c = bnsOutcome(star(ms1, ms1Seq, 1.46), star(ms1, ms1Seq, 1.27), ms1Seq.mmax, thresholdMass(ms1Seq.mmax));
    assert.equal(c.fate, 'stable neutron star');
    // A light pair on SLy: supramassive.
    const d = bnsOutcome(star(sly, slySeq, 1.1), star(sly, slySeq, 1.1), slySeq.mmax, thresholdMass(slySeq.mmax));
    assert.equal(d.fate, 'supramassive neutron star');
});

ok('GW170817-like ejecta budget: dynamical 10⁻³–10⁻², disk 10⁻²–10⁻¹, total wind+dyn ~0.01–0.06 M☉', () => {
    const s1 = star(mpa1, mpa1Seq, 1.46), s2 = star(mpa1, mpa1Seq, 1.27);
    const dyn = bnsDynamicalEjecta(s1, s2), disk = bnsDiskMass(s1, s2);
    assert.ok(dyn > 1e-3 && dyn < 1.5e-2, `M_dyn = ${dyn}`);
    assert.ok(disk > 1e-2 && disk < 0.2, `M_disk = ${disk}`);
    const o = bnsOutcome(s1, s2, mpa1Seq.mmax, thresholdMass(mpa1Seq.mmax));
    assert.ok(o.ejecta.total > 0.008 && o.ejecta.total < 0.06, `total ejecta ${o.ejecta.total}`);
    // Softer (more compact) stars throw out MORE dynamical ejecta (shock-driven) and leave less disk.
    const t1 = star(sly, slySeq, 1.46), t2 = star(sly, slySeq, 1.27);
    assert.ok(bnsDiskMass(t1, t2) < disk, 'compact stars → smaller disk');
});

ok('asymmetric BNS makes more dynamical ejecta than symmetric at the same total mass', () => {
    const sym = bnsDynamicalEjecta(star(sly, slySeq, 1.36), star(sly, slySeq, 1.36));
    const asym = bnsDynamicalEjecta(star(sly, slySeq, 1.6), star(sly, slySeq, 1.12));
    assert.ok(asym > sym, `${asym} vs ${sym}`);
});

// ── NSBH ────────────────────────────────────────────────────────────────────
ok('GW200105-like (8.9 + 1.9 M☉, χ ≈ 0) is swallowed; 5 + 1.4 with χ = 0.9 is disrupted', () => {
    const ns19 = star(sly, slySeq, 1.9);
    const sw = nsbhOutcome(8.9, 0, ns19);
    assert.equal(sw.disrupted, false);
    assert.equal(sw.ejecta.total, 0);
    const ns14 = star(sly, slySeq, 1.4);
    const d = nsbhOutcome(5, 0.9, ns14);
    assert.equal(d.disrupted, true);
    assert.ok(d.remnantBaryonMass > 0.05 && d.remnantBaryonMass < 0.4, `M_rem = ${d.remnantBaryonMass}`);
    assert.ok(d.ejecta.dynamical > 0.005 && d.ejecta.dynamical < 0.1, `M_dyn = ${d.ejecta.dynamical}`);
    assert.ok(d.ejecta.dynamical <= d.remnantBaryonMass, 'ejecta ≤ remnant');
    // Spin matters: the same system with χ = 0 keeps less outside.
    const d0 = nsbhOutcome(5, 0, ns14);
    assert.ok(d0.remnantBaryonMass < d.remnantBaryonMass, 'spin increases the disrupted mass');
});

// ── WD ──────────────────────────────────────────────────────────────────────
ok('Roche lobe: Eggleton fraction is 0.38 at q = 1; Sirius B is disrupted by Cyg X-1 well outside ISCO', () => {
    within(rocheLobeFraction(1), 0.379, 0.01, 'r_L/a');
    const o = wdOutcome({ M: 1.018, R: 5840 }, { M: 21.2, kind: 'bh', chi: 0.95 });
    assert.equal(o.disrupted, true);
    assert.ok(o.aRlofKm > 1e4 && o.aRlofKm < 4e4, `a_RLOF = ${o.aRlofKm}`);
    assert.ok(o.fGwRlofHz > 0.01 && o.fGwRlofHz < 0.5, `f_GW = ${o.fGwRlofHz} Hz (LISA band)`);
    const ww = wdOutcome({ M: 1.018, R: 5840 }, { M: 0.6, kind: 'wd', R: 8500 });
    assert.ok(ww.fate.includes('over the Chandrasekhar'), ww.fate);
});

// ── Kilonova ────────────────────────────────────────────────────────────────
ok('r-process heating is 2×10¹⁰ erg/g/s at one day', () => {
    within(rProcessHeating(86400), 2e10, 1e-9, 'q̇(1 d)');
});

ok('a 0.02 M☉ blue + 0.04 M☉ red kilonova at 40 Mpc peaks near 10⁴² erg/s within ~1 day (AT2017gfo)', () => {
    const blue = kilonovaComponent({ mass: 0.02, v: 0.27, kappa: 0.5 });
    const red = kilonovaComponent({ mass: 0.04, v: 0.15, kappa: 10 });
    assert.ok(blue.tPeakDays > 0.3 && blue.tPeakDays < 2, `blue peak at ${blue.tPeakDays} d`);
    assert.ok(red.tPeakDays > 3 && red.tPeakDays < 12, `red peak at ${red.tPeakDays} d`);
    assert.ok(blue.peakL > 3e41 && blue.peakL < 3e42, `blue L_pk = ${blue.peakL}`);
    assert.ok(red.peakL > 3e40 && red.peakL < 8e41, `red L_pk = ${red.peakL}`); // one-zone: ~2× under AT2017gfo's red component
    assert.ok(blue.tempAtPeak > 5000 && blue.tempAtPeak < 15000, `blue T = ${blue.tempAtPeak}`);
    assert.ok(red.tempAtPeak < blue.tempAtPeak, 'red is cooler at peak');
    const kn = kilonova({ dynamical: 0.04, wind: 0.02, vWind: 0.27, vDynamical: 0.15 }, 40);
    assert.ok(kn.peakL > 3e41 && kn.peakL < 3e42, `total L_pk = ${kn.peakL}`);
    const m = bolometricMagnitudes(kn.peakL, 40);
    assert.ok(m.absolute < -14 && m.absolute > -17, `M_bol = ${m.absolute}`);
    assert.ok(m.apparent > 16 && m.apparent < 19.5, `m_bol = ${m.apparent} (AT2017gfo peaked ~17.5)`);
});

ok('peak time scales as √(M κ / v): four times the mass → twice the peak time', () => {
    const a = kilonovaComponent({ mass: 0.01, v: 0.1, kappa: 1 });
    const b = kilonovaComponent({ mass: 0.04, v: 0.1, kappa: 1 });
    within(b.tPeakDays / a.tPeakDays, 2, 0.25, 't_pk ratio');
});

ok('zero ejecta → no light, no NaN', () => {
    const kn = kilonova({ dynamical: 0, wind: 0 }, 40);
    assert.equal(kn.visible, false);
    assert.equal(kn.peakL, 0);
});

// ── Magnetar ────────────────────────────────────────────────────────────────
ok('SGR 1806−20 spins down at ~10³⁴–10³⁵ erg/s; magnetic vs gravity at contact is ~10⁻⁶', () => {
    const m = magneticInteraction({ B: 2e15, rKm: 12, periodS: 7.55, M: 1.4, mComp: 1.4, B2: 2e15, r2Km: 12, aKm: 24 });
    assert.ok(m.spinDownErgS > 1e34 && m.spinDownErgS < 3e35, `L_sd = ${m.spinDownErgS}`);
    assert.ok(m.magneticEnergyErg > 1e47 && m.magneticEnergyErg < 1e49, `E_B = ${m.magneticEnergyErg}`);
    assert.ok(m.magneticToGravity < 1e-4 && m.magneticToGravity > 1e-9, `ratio = ${m.magneticToGravity}`);
});

ok('pair classification', () => {
    assert.equal(classifyPair('ns', 'ns'), 'bns');
    assert.equal(classifyPair('bh', 'ns'), 'nsbh');
    assert.equal(classifyPair('ns', 'bh'), 'nsbh');
    assert.equal(classifyPair('wd', 'bh'), 'wdbh');
    assert.equal(classifyPair('bh', 'bh'), 'bbh');
});

console.log(`✅ star-collider-remnant: ${passed} checks passed`);
