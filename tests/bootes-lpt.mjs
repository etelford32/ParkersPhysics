#!/usr/bin/env node
/**
 * bootes-lpt.mjs — gate for js/bootes-lpt.js, second-order Lagrangian
 * perturbation theory for the reconstruction's initial conditions
 * (BOOTES_VOID_PLAN.md §4f).
 *
 * Run: node tests/bootes-lpt.mjs        (~15 s)
 *
 *   1. GROWTH: the ODE's D₁ is the growth INTEGRAL in bootes-void-model.js
 *      (an independent calculation), and its D₂, f₂ sit on the literature
 *      fits −(3/7)D₁²Ω_m^(−1/143) and 2Ω_m^(6/11).
 *   2. SPHERICAL COLLAPSE, independently: a top-hat shell integrated exactly
 *      (Newton + Λ, RK4 in ln a) gives δ = Δ + c₂Δ² with c₂ ≈ 17/21, and the
 *      2LPT map with D₂ from (1) reproduces it — its error is third order,
 *      Zel'dovich's is second.
 *   3. THE GRADIENT is exact for a linear field on the glass, rim included.
 *   4. THE POISSON SOLVE: a uniform invariant inside a ball gives s₂ = S q/3
 *      inside and S R³ q/(3|q|³) outside (isolated boundary), and a single
 *      plane wave — exactly one-dimensional, where Zel'dovich is exact — has
 *      no second-order displacement.
 *   5. THE INVERSE closes: Ψ = s₁ + D₂ₒs₂[s₁] is reproduced from the s₁ it
 *      returns, and the fixed point contracts geometrically.
 *   6. THE VOID TWIN: plant a spherical linear void, run it forward with the
 *      N-body, reconstruct from a DIFFERENT glass — 2LPT recovers the planted
 *      linear field with less than Zel'dovich's error, and run forward its
 *      ICs land closer to today. (A planted CLUSTER is the measured
 *      exception: Zel'dovich's double-counted collapse there happens to
 *      cancel the softened integrator's own linear-growth deficit — see the
 *      plan; the page's reconstruction is decided on the void + web, §4f.
 *      That deficit is deconvolved out by js/bootes-softgrowth.js, §4g, which
 *      closes the cluster gap on the forward claim.)
 */

import assert from 'node:assert/strict';

import {
    COSMOLOGY, growthFactor, omegaMatterAt, meanMatterDensityMsunMpc3,
} from '../js/bootes-void-model.js';
import { voidRedshift } from '../js/bootes-void-data.js';
import * as NB from '../js/bootes-nbody.js';
import * as RC from '../js/bootes-reconstruct.js';
import * as L from '../js/bootes-lpt.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

const Z = voidRedshift();
const A_OBS = 1 / (1 + Z);
const A_INIT = 0.1;
const rho = meanMatterDensityMsunMpc3();
const SIM = NB.PAGE_CONFIG.sim;

// ── 1. Growth ───────────────────────────────────────────────────────────────
{
    const as = [0.05, 0.1, 0.3, 0.6, A_OBS, 1];
    const g = L.growthODE([...as, 1]);
    const g1 = g[g.length - 1];
    let worstD = 0, worstD2 = 0, worstF2 = 0;
    as.forEach((a, i) => {
        const z = 1 / a - 1;
        worstD = Math.max(worstD, Math.abs(g[i].D1 / g1.D1 / growthFactor(z) - 1));
        const d1 = g[i].D1 / g1.D1, d2 = g[i].D2 / (g1.D1 * g1.D1);
        worstD2 = Math.max(worstD2, Math.abs(d2 / L.d2Fit(d1, z) - 1));
        worstF2 = Math.max(worstF2, Math.abs(g[i].dD2 / g[i].D2 / L.f2Fit(z) - 1));
    });
    assert.ok(worstD < 1e-6, `D₁ ODE vs integral: ${worstD}`);
    assert.ok(worstD2 < 0.003 && worstF2 < 0.006, `D₂ fit ${worstD2}, f₂ fit ${worstF2}`);
    const gr = L.lptGrowth(A_INIT, A_OBS);
    assert.ok(Math.abs(gr.d1 - growthFactor(1 / A_INIT - 1) / growthFactor(Z)) < 1e-6, 'normalised d₁');
    assert.ok(gr.d2Obs < -0.42 && gr.d2Obs > -0.44, `D₂(a_obs) = ${gr.d2Obs}`);
    ok(`growth: the ODE's D₁ is the growth integral to ${worstD.toExponential(1)}; D₂ and f₂ sit on `
        + `−(3/7)D₁²Ω_m^(−1/143) and 2Ω_m^(6/11) to ${(100 * worstD2).toFixed(2)} % / ${(100 * worstF2).toFixed(2)} %`);
}

// ── 2. Spherical collapse, independently ────────────────────────────────────
{
    const { omegaM: Om, omegaLambda: OL } = COSMOLOGY;
    const ai = 1e-4;
    const Dobs = L.growthODE([A_OBS])[0].D1;
    // A top-hat of comoving Lagrangian radius 1 (H0 = 1 units): Newton + Λ.
    // Start in the linear growing mode at ai (D ∝ a there to 1e-12).
    const exactDelta = (Delta) => {
        const e = Delta * (ai / Dobs) / 3;             // linear displacement / q at ai
        let lna = Math.log(ai);
        const H = (lna) => Math.sqrt(Om * Math.exp(-3 * lna) + OL);
        let y = [ai * (1 - e), ai * (1 - 2 * e) * H(lna)];   // R, dR/dt
        const rhs = (lna, y) => {
            const h = H(lna);
            return [y[1] / h, (-0.5 * Om / (y[0] * y[0]) + OL * y[0]) / h];
        };
        const target = Math.log(A_OBS), n = 40000, dh = (target - lna) / n;
        for (let s = 0; s < n; s++) {
            const k1 = rhs(lna, y);
            const k2 = rhs(lna + dh / 2, [y[0] + dh / 2 * k1[0], y[1] + dh / 2 * k1[1]]);
            const k3 = rhs(lna + dh / 2, [y[0] + dh / 2 * k2[0], y[1] + dh / 2 * k2[1]]);
            const k4 = rhs(lna + dh, [y[0] + dh * k3[0], y[1] + dh * k3[1]]);
            y = [y[0] + dh / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
                y[1] + dh / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])];
            lna += dh;
        }
        return (A_OBS / y[0]) ** 3 - 1;
    };
    const d2o = L.lptGrowth(A_INIT, A_OBS).d2Obs;
    // s₁ = −(Δ/3)q ⇒ S = Δ²/3 ⇒ s₂ = (Δ²/9) q.
    const lpt = (Delta) => (1 / (1 - Delta / 3 + d2o * Delta * Delta / 9)) ** 3 - 1;
    const za = (Delta) => (1 / (1 - Delta / 3)) ** 3 - 1;
    const d = 0.05;
    const ep = exactDelta(d), em = exactDelta(-d);
    const c2 = (ep + em) / (2 * d * d);              // the cubic cancels
    const c2Expect = 17 / 21 * Math.pow(omegaMatterAt(Z), -1 / 143);
    assert.ok(Math.abs(c2 / c2Expect - 1) < 0.01, `c₂ = ${c2} vs ${c2Expect}`);
    const eL = Math.max(Math.abs(lpt(d) - ep), Math.abs(lpt(-d) - em));
    const eZ = Math.max(Math.abs(za(d) - ep), Math.abs(za(-d) - em));
    assert.ok(eL < 0.1 * eZ, `2LPT ${eL} vs ZA ${eZ}`);
    ok(`spherical collapse: an exact Newton + Λ shell gives δ = Δ + ${c2.toFixed(4)}Δ² `
        + `(17/21 · Ω_m^(−1/143) = ${c2Expect.toFixed(4)}); at |Δ| = ${d} the 2LPT map misses it by `
        + `${eL.toExponential(1)}, Zel'dovich by ${eZ.toExponential(1)}`);
}

// The glass the remaining checks run on.
const R = 140;
const glass = RC.buildGlass({ radius: R, spacing: 14, refineRadius: Infinity, seed: 3, ...SIM });
const H = 28;
const totalMass = glass.mass.reduce((a, b) => a + b, 0);
const opts = {
    volume: Float64Array.from(glass.mass, (m) => m / rho),
    hsoft: new Float64Array(glass.n).fill(H), h: H, ...SIM,
};
const radiusOf = (i) => Math.hypot(glass.pos[3 * i], glass.pos[3 * i + 1], glass.pos[3 * i + 2]);

// ── 3. The gradient ─────────────────────────────────────────────────────────
{
    const M = [[0.10, -0.03, 0.02], [0.05, -0.07, 0.04], [-0.01, 0.06, 0.12]];
    const s = new Float64Array(3 * glass.n);
    for (let i = 0; i < glass.n; i++) {
        for (let c = 0; c < 3; c++) {
            s[3 * i + c] = 1.5 + M[c][0] * glass.pos[3 * i] + M[c][1] * glass.pos[3 * i + 1] + M[c][2] * glass.pos[3 * i + 2];
        }
    }
    const g = L.lsqGradient(glass.pos, s, H);
    const want = [M[0][0], M[1][1], M[2][2], (M[0][1] + M[1][0]) / 2, (M[0][2] + M[2][0]) / 2, (M[1][2] + M[2][1]) / 2];
    let worst = 0;
    for (let i = 0; i < glass.n; i++) for (let c = 0; c < 6; c++) worst = Math.max(worst, Math.abs(g[6 * i + c] - want[c]));
    assert.ok(worst < 1e-10, `linear field gradient: ${worst}`);
    ok(`the gradient: a linear field's symmetrised gradient is recovered exactly at all ${glass.n} `
        + `elements, rim included (worst ${worst.toExponential(1)})`);
}

// ── 4. The Poisson solve ────────────────────────────────────────────────────
{
    // Uniform S inside a ball of radius Rb (the elements carry it); isolated.
    const Rb = 90, S0 = 0.02;
    const S = Float64Array.from({ length: glass.n }, (_, i) => (radiusOf(i) < Rb ? S0 : 0));
    let Vb = 0;
    for (let i = 0; i < glass.n; i++) if (S[i]) Vb += opts.volume[i];
    const s2 = L.poissonGradient(glass.pos, S, opts.volume, opts.hsoft, SIM);
    let worstIn = 0, worstOut = 0;
    for (let i = 0; i < glass.n; i++) {
        const r = radiusOf(i);
        let coef;
        if (r < Rb - 2 * H) coef = S0 / 3;
        else if (r > Rb + 2 * H) coef = S0 * Vb / (4 * Math.PI) / (r * r * r);
        else continue;
        for (let c = 0; c < 3; c++) {
            const e = Math.abs(s2[3 * i + c] - coef * glass.pos[3 * i + c]) / (S0 * Rb / 3);
            if (r < Rb) worstIn = Math.max(worstIn, e); else worstOut = Math.max(worstOut, e);
        }
    }
    assert.ok(worstIn < 0.03 && worstOut < 0.03, `uniform ball: inside ${worstIn}, outside ${worstOut}`);
    // A single plane wave: ∂sᵢ/∂qⱼ has rank one, so S ≡ 0 and s₂ ≡ 0.
    const k = 2 * Math.PI / 90;
    const s1 = new Float64Array(3 * glass.n);
    for (let i = 0; i < glass.n; i++) {
        const ph = k * (0.6 * glass.pos[3 * i] + 0.8 * glass.pos[3 * i + 1]);
        s1[3 * i] = 0.6 * 4 * Math.sin(ph); s1[3 * i + 1] = 0.8 * 4 * Math.sin(ph);
    }
    const p = L.secondOrderDisplacement(glass.pos, s1, opts);
    const spherical = L.secondOrderDisplacement(glass.pos, glass.pos.map(v => -v * 4 * k / 3), opts);
    let pp = 0, ss = 0;
    for (let q = 0; q < p.length; q++) { pp += p[q] * p[q]; ss += spherical[q] * spherical[q]; }
    const ratio = Math.sqrt(pp / ss);
    assert.ok(ratio < 0.02, `plane wave s₂ / spherical s₂ of the same strain: ${ratio}`);
    ok(`the Poisson solve: a uniform source ball gives s₂ = Sq/3 inside (${(100 * worstIn).toFixed(1)} %) and `
        + `the isolated SR³q/3|q|³ outside (${(100 * worstOut).toFixed(1)} %); a plane wave has none `
        + `(${(100 * ratio).toFixed(2)} % of a spherical strain's)`);
}

// ── 5. The inverse closes ───────────────────────────────────────────────────
{
    const psi = new Float64Array(3 * glass.n);
    for (let i = 0; i < glass.n; i++) {
        const x = glass.pos[3 * i], y = glass.pos[3 * i + 1], z = glass.pos[3 * i + 2];
        const e = 0.35 * Math.exp(-(x * x + y * y + z * z) / (2 * 40 * 40));
        const w = 2.5 * Math.sin(2 * Math.PI * y / 110) * Math.exp(-(x * x + z * z) / (2 * 60 * 60));
        psi[3 * i] = e * x; psi[3 * i + 1] = e * y + w; psi[3 * i + 2] = e * z;
    }
    const d2Obs = L.lptGrowth(A_INIT, A_OBS).d2Obs;
    const inv = L.invert2LPT(glass.pos, psi, { d2Obs, iterations: 5, ...opts });
    let e2 = 0, p2 = 0;
    for (let k = 0; k < psi.length; k++) {
        e2 += (inv.s1[k] + d2Obs * inv.s2[k] - psi[k]) ** 2;
        p2 += psi[k] ** 2;
    }
    const closure = Math.sqrt(e2 / p2);
    const h = inv.history;
    assert.ok(closure < 1e-4, `inverse closure ${closure}`);
    assert.ok(h[3] < 0.2 * h[1] && h[4] < h[3], `fixed point contracts: ${h}`);
    ok(`the inverse closes: s₁ + D₂ₒs₂[s₁] reproduces Ψ to ${closure.toExponential(1)}; per-pass `
        + `change ${h.map(v => v.toFixed(4)).join(' → ')} Mpc`);
}

// ── 6. The void twin ────────────────────────────────────────────────────────
{
    const growth = L.lptGrowth(A_INIT, A_OBS);
    const SIG = 40, DL0 = -1.5;                // linear central contrast at z_obs
    const psiTrue = (x, y, z) => {
        const e = (-DL0 / 3) * Math.exp(-(x * x + y * y + z * z) / (2 * SIG * SIG));
        return [e * x, e * y, e * z];
    };
    // The truth: a different glass with 2LPT ICs of the planted field.
    const gA = RC.buildGlass({ radius: R, spacing: 14, refineRadius: Infinity, seed: 29, ...SIM });
    const optsA = { ...opts, volume: Float64Array.from(gA.mass, (m) => m / rho), hsoft: new Float64Array(gA.n).fill(H) };
    const s1A = new Float64Array(3 * gA.n);
    for (let i = 0; i < gA.n; i++) s1A.set(psiTrue(gA.pos[3 * i], gA.pos[3 * i + 1], gA.pos[3 * i + 2]), 3 * i);
    const icA = L.lptState(gA.pos, s1A, L.secondOrderDisplacement(gA.pos, s1A, optsA), A_INIT, growth);
    const sch = NB.buildSchedule({ aStart: A_INIT, aEnd: A_OBS, steps: 30 });
    const fwd = (pos, vel, g) => {
        const s = NB.createSimulation({
            pos, vel, mass: g.mass, group: new Uint8Array(g.n), nMassive: g.n, aStart: A_INIT,
            softening: [g.softening, g.softening], background: { radius: R, rho }, ...SIM,
        });
        for (let k = 0; k < sch.steps; k++) s.step(sch, k);
        return s.x;
    };
    const xA = fwd(icA.pos, icA.vel, gA);
    // The reconstruction sees only the final particles.
    const m = RC.matchObserved({
        glass, ...SIM,
        observed: { pos: Float64Array.from(xA), mass: gA.mass, group: new Uint8Array(gA.n), softening: [gA.softening, NB.plummer(1)] },
    });
    const psiRec = m.X.map((v, k) => v - glass.pos[k]);
    const inv = L.invert2LPT(glass.pos, psiRec, { d2Obs: growth.d2Obs, iterations: 4, ...opts });
    const truth = new Float64Array(3 * glass.n);
    for (let i = 0; i < glass.n; i++) truth.set(psiTrue(glass.pos[3 * i], glass.pos[3 * i + 1], glass.pos[3 * i + 2]), 3 * i);
    const sm = (f) => RC.interpolateDisplacement(glass.pos, glass.pos, f, 28);
    const rel = (u, v) => {
        const a = sm(u), b = sm(v);
        let e2 = 0, t2 = 0;
        for (let i = 0; i < glass.n; i++) {
            if (radiusOf(i) > 0.7 * R) continue;
            for (let d = 0; d < 3; d++) { e2 += (a[3 * i + d] - b[3 * i + d]) ** 2; t2 += b[3 * i + d] ** 2; }
        }
        return Math.sqrt(e2 / t2);
    };
    const recZA = rel(psiRec, truth), recL = rel(inv.s1, truth);
    const za = RC.zeldovichState(glass.pos, psiRec, A_INIT, A_OBS);
    const lp = L.lptState(glass.pos, inv.s1, inv.s2, A_INIT, growth);
    const disp = (x) => x.map((v, k) => v - glass.pos[k]);
    const fwdZA = rel(disp(fwd(za.pos, za.vel, glass)), psiRec);
    const fwdL = rel(disp(fwd(lp.pos, lp.vel, glass)), psiRec);
    assert.ok(recL < 0.75 * recZA, `recovered linear field: 2LPT ${recL} vs ZA ${recZA}`);
    assert.ok(fwdL < 0.75 * fwdZA, `forward: 2LPT ${fwdL} vs ZA ${fwdZA}`);
    ok(`the void twin (δ_L = ${DL0}): 2LPT recovers the planted linear field to ${(100 * recL).toFixed(1)} % `
        + `(Zel'dovich ${(100 * recZA).toFixed(1)} %), and run forward its ICs land within `
        + `${(100 * fwdL).toFixed(1)} % of today's displacement (Zel'dovich ${(100 * fwdZA).toFixed(1)} %)`);
}

console.log(`\n${passed} checks passed — js/bootes-lpt.js`);
