#!/usr/bin/env node
/**
 * star-collider-tov.mjs — the neutron-star builder against published stars.
 *
 *   node tests/star-collider-tov.mjs
 *
 * Every EOS in js/star-collider/eos.js carries the sequence numbers the
 * literature publishes for it (M_max, R at 1.4 M☉, Λ at 1.4 M☉). This runs
 * the TOV + tidal integration for each and checks that the piecewise-
 * polytrope transcription reproduces them: a typo in one Γ moves M_max by
 * tenths of a solar mass, which is what this catches. Tolerances are set by
 * what the piecewise fits themselves achieve against the tables they fit
 * (Read+2009 quote ~1–4 % in M and R; Λ is a fifth power of R and inherits
 * five times that).
 */

import assert from 'node:assert/strict';
import { createEos, EOS_IDS, EOS_TABLE, RHO_GEOM, GEOM_KM, GEOM_S, RHO_NUC_CGS } from '../js/star-collider/eos.js';
import {
    integrateTov, massRadiusSequence, starAtMass, loveNumberK2, iLoveBar, thresholdMass,
} from '../js/star-collider/tov.js';

let passed = 0;
const ok = (name, fn) => { fn(); console.log(`  ✓ ${name}`); passed++; };
const within = (v, target, rel, what) =>
    assert.ok(Math.abs(v - target) <= rel * Math.abs(target),
        `${what}: ${v} vs ${target} (±${(rel * 100).toFixed(0)} %)`);

// ── Units ───────────────────────────────────────────────────────────────────
ok('geometric units are what they say', () => {
    within(GEOM_KM, 1.4766, 1e-3, 'G M☉/c² km');
    within(GEOM_S, 4.9255e-6, 1e-3, 'G M☉/c³ s');
    within(RHO_GEOM, 6.176e17, 2e-3, 'density unit g/cm³');
});

// ── EOS sanity ──────────────────────────────────────────────────────────────
ok('SLy pressure at 10¹⁴ g/cm³ is ~4×10³² dyn/cm² (constants read as p/c²)', () => {
    const eos = createEos('SLy');
    const pOverC2 = eos.pressureCgs(1e14);
    const pDyn = pOverC2 * 8.98755e20;
    within(pDyn, 3.6e32, 0.25, 'p(1e14)');
});

// The three SLy crust joins are only as continuous as the published six-digit
// constants make them (~1.5×10⁻⁵ in p); the core joins are exact by
// construction. 2×10⁻⁴ passes the rounding and fails a transcription error.
ok('pressure, energy density and sound speed are continuous across every piece boundary', () => {
    for (const id of EOS_IDS) {
        const eos = createEos(id);
        for (const pc of eos.pieces.slice(1)) {
            const rb = pc.rhoMin;
            const lo = rb * (1 - 1e-9), hi = rb * (1 + 1e-9);
            within(eos.pressureCgs(hi), eos.pressureCgs(lo), 2e-4, `${id} p at ${rb.toExponential(2)}`);
            within(eos.energyDensityCgs(hi), eos.energyDensityCgs(lo), 2e-4, `${id} ε at ${rb.toExponential(2)}`);
            const cs2 = eos.soundSpeed2Cgs(hi);
            assert.ok(cs2 > 0 && cs2 < 1.2, `${id}: c_s² ${cs2} at ${rb.toExponential(2)} is not sub/near-luminal`);
        }
        // ρ(p) inverts p(ρ) on both sides of the crust/core junction.
        for (const rho of [1e8, 1e12, eos.junctionRhoCgs * 1.5, 5e14, 2e15]) {
            within(eos.rhoOfPressureCgs(eos.pressureCgs(rho)), rho, 1e-9, `${id} ρ(p(ρ)) at ${rho}`);
        }
        assert.ok(eos.junctionRhoCgs > 1e13 && eos.junctionRhoCgs < 10 ** 14.7, `${id} junction ${eos.junctionRhoCgs}`);
    }
});

ok('ε ≈ ρ at low density (rest mass dominates) and ε > ρ at 3ρ_nuc', () => {
    const eos = createEos('APR4');
    within(eos.energyDensityCgs(1e10) / 1e10, 1, 1e-2, 'ε/ρ at 1e10');
    assert.ok(eos.energyDensityCgs(3 * RHO_NUC_CGS) > 3 * RHO_NUC_CGS * 1.05, 'ε/ρ at 3ρ_nuc');
});

// ── The Love-number closed form ─────────────────────────────────────────────
// NOTE: the closed form cancels catastrophically as C → 0 (numerator and
// denominator both go as C⁵), so it is evaluated at moderate compactness —
// which is also the only place the solver ever uses it.
ok('k2 reduces to the Newtonian (2−y)/(2(y+3)) at small C, falls with C, and → 0 near the BH limit', () => {
    for (const y of [0.3, 1.0, 1.5]) {
        within(loveNumberK2(0.01, y), (2 - y) / (2 * (y + 3)), 0.06, `k2 Newtonian limit at y=${y}`);
    }
    const ks = [0.05, 0.1, 0.15, 0.2].map(C => loveNumberK2(C, 1.03));
    for (let i = 1; i < ks.length; i++) assert.ok(ks[i] < ks[i - 1] && ks[i] > 0, `k2 sequence ${ks}`);
    const kBh = loveNumberK2(0.49, 2);
    assert.ok(Math.abs(kBh) < 0.02, `k2 near the BH limit should vanish, got ${kBh}`);
});

ok('I–Love relation gives ~1.3×10⁴⁵ g cm² for a Λ = 300, 1.4 M☉ star', () => {
    const Ibar = iLoveBar(300);
    const I = Ibar * 1.4 ** 3 * 1.98847e33 * (GEOM_KM * 1e5) ** 2;
    within(I, 1.36e45, 0.1, 'I');
});

// ── The sequences ───────────────────────────────────────────────────────────
const sequences = {};
ok('every EOS reproduces its published M_max to 2 %, R(1.4) to 4 %, Λ(1.4) to 25 %', () => {
    for (const id of EOS_IDS) {
        const eos = createEos(id);
        const seq = massRadiusSequence(eos, 40);
        sequences[id] = seq;
        const row = EOS_TABLE[id];
        within(seq.mmax.M, row.mmax, 0.02, `${id} M_max`);
        const s14 = starAtMass(eos, 1.4, seq);
        assert.ok(s14, `${id}: no 1.4 M☉ star`);
        within(s14.M, 1.4, 1e-3, `${id} starAtMass hit`);
        within(s14.rKm, row.r14, 0.04, `${id} R(1.4)`);
        within(s14.Lambda, row.lambda14, 0.25, `${id} Λ(1.4)`);
        assert.ok(s14.k2 > 0.05 && s14.k2 < 0.15, `${id} k2 ${s14.k2}`);
        assert.ok(s14.Mb > s14.M && s14.Mb < 1.2 * s14.M, `${id} baryonic mass ${s14.Mb}`);
        assert.ok(seq.mmax.C > 0.2 && seq.mmax.C < 0.34, `${id} C_max ${seq.mmax.C}`);
        console.log(`      ${id.padEnd(5)} M_max ${seq.mmax.M.toFixed(3)}  R(1.4) ${s14.rKm.toFixed(2)} km  Λ(1.4) ${s14.Lambda.toFixed(0)}  k2 ${s14.k2.toFixed(4)}`);
    }
});

ok('the sequence is ordered: stiffer EOS → larger R(1.4), larger Λ', () => {
    const r = (id) => starAtMass(createEos(id), 1.4, sequences[id]);
    const soft = r('WFF1'), mid = r('SLy'), stiff = r('MS1');
    assert.ok(soft.rKm < mid.rKm && mid.rKm < stiff.rKm, 'R ordering');
    assert.ok(soft.Lambda < mid.Lambda && mid.Lambda < stiff.Lambda, 'Λ ordering');
});

ok('stable branch is flagged and starAtMass refuses masses above M_max', () => {
    const seq = sequences.SLy;
    assert.ok(seq.points.some(p => p.stable) && seq.points.some(p => !p.stable), 'both branches present');
    const eos = createEos('SLy');
    assert.equal(starAtMass(eos, seq.mmax.M + 0.05, seq), null);
    assert.ok(starAtMass(eos, 1.0, seq).M > 0.99);
});

ok('Bauswein threshold mass sits above M_max and below 2 M_max', () => {
    for (const id of EOS_IDS) {
        const mth = thresholdMass(sequences[id].mmax);
        assert.ok(mth > sequences[id].mmax.M && mth < 1.6 * sequences[id].mmax.M, `${id} M_th ${mth}`);
    }
    // SLy: M_th ≈ 2.6–2.7 (Bauswein+2013 Table)
    within(thresholdMass(sequences.SLy.mmax), 2.65, 0.04, 'SLy M_th');
});

// SLy's M_max is 2.05 — PSR J0740+6620 at 2.08 M☉ does not fit on it, which is
// a real constraint the page reports, not a solver failure. APR4 carries it.
ok('a 2.08 M☉ star (PSR J0740+6620) exists on the stiffer EOSs and not on SLy; MPA1 lands in NICER\'s 11.4–13.7 km', () => {
    assert.equal(starAtMass(createEos('SLy'), 2.08, sequences.SLy), null, 'SLy should not reach 2.08');
    const inBand = [];
    for (const id of ['APR4', 'ENG', 'MPA1', 'MS1']) {
        const s = starAtMass(createEos(id), 2.08, sequences[id]);
        assert.ok(s, `no 2.08 M☉ star on ${id}`);
        assert.ok(s.rKm > 10 && s.rKm < 15, `${id} R(2.08) = ${s.rKm}`);
        assert.ok(s.Lambda < 150, `${id} Λ(2.08) = ${s.Lambda} — far below the ~300–1400 of a 1.4 M☉ star`);
        if (s.rKm > 11.4 && s.rKm < 13.7) inBand.push(id);
    }
    assert.ok(inBand.includes('MPA1'), `in NICER band: ${inBand}`);
});

ok('a density profile can be sampled', () => {
    const st = integrateTov(createEos('SLy'), 1e15 / RHO_GEOM, { profile: 40 });
    assert.ok(st.profile.length > 10, 'profile samples');
    assert.ok(st.profile[0].rho > st.profile[st.profile.length - 1].rho, 'density falls outward');
});

console.log(`✅ star-collider-tov: ${passed} checks passed`);
