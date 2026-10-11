#!/usr/bin/env node
/**
 * bootes-softgrowth.mjs — gate for js/bootes-softgrowth.js, the softened
 * integrator's own linear growth and its deconvolution (BOOTES_VOID_PLAN.md
 * §4g).
 *
 * Run: node tests/bootes-softgrowth.mjs        (~30 s)
 *
 *   1. THE KERNEL IS THE INTEGRATOR'S: the tree's spline-softened pull of one
 *      element is the Newtonian pull of the mass inside r of the SAME density
 *      kernel splineKernelFT transforms; ŵ(0) = 1 and ŵ ≈ 1 − k²⟨r²⟩/6.
 *   2. T(k): exactly 1 with the full force, falling with k as ŵ does.
 *   3. THE DECONVOLUTION OPERATOR: the tabulated radial kernel integrates to
 *      zero and returns the full 1/T − 1 at long wavelengths; applied on the
 *      glass in difference form it returns that response for a plane wave.
 *   4. THE INTEGRATOR FOLLOWS IT: curl-free waves run on the glass fall short
 *      of ideal growth in T(k)'s order, and deconvolved ICs close the gap
 *      (the residual is the test window spreading the field onto the taper).
 *   5. THE VOID TWIN: plant a spherical linear void, run it forward, rebuild
 *      it from a DIFFERENT glass — with the deconvolution the recovered linear
 *      field's amplitude is right and both errors drop well below 2LPT alone.
 */

import assert from 'node:assert/strict';

import { meanMatterDensityMsunMpc3 } from '../js/bootes-void-model.js';
import { voidRedshift } from '../js/bootes-void-data.js';
import * as NB from '../js/bootes-nbody.js';
import * as RC from '../js/bootes-reconstruct.js';
import * as L from '../js/bootes-lpt.js';
import * as SG from '../js/bootes-softgrowth.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

const A_OBS = 1 / (1 + voidRedshift());
const A_INIT = 0.1;
const rho = meanMatterDensityMsunMpc3();
const SIM = NB.PAGE_CONFIG.sim;
const growth = L.lptGrowth(A_INIT, A_OBS);
const H = 28;

// ── 1. The kernel is the integrator's ───────────────────────────────────────
{
    const Wd = (r) => {
        const u = r / H;
        return u >= 1 ? 0 : (8 / (Math.PI * H ** 3)) * (u < 0.5 ? 1 - 6 * u * u + 6 * u ** 3 : 2 * (1 - u) ** 3);
    };
    const massInside = (r) => {
        let s = 0;
        const n = 4000, dr = r / n;
        for (let i = 0; i < n; i++) { const x = (i + 0.5) * dr; s += Wd(x) * 4 * Math.PI * x * x * dr; }
        return s;
    };
    const m = 1e14;
    let worst = 0;
    for (const r of [3, 8, 14, 20, 27, 35]) {
        const out = new Float64Array(3);
        NB.directForce(Float64Array.from([0, 0, 0]), Float64Array.from([m]), Int32Array.from([0]), r, 0, 0, NB.spline(H), out);
        const want = NB.G_MPC * m * Math.min(1, massInside(r)) / (r * r);
        worst = Math.max(worst, Math.abs(-out[0] / want - 1));
    }
    assert.ok(worst < 1e-4, `spline pull vs enclosed kernel mass: ${worst}`);
    let r2 = 0;
    for (let i = 0; i < 4000; i++) { const x = (i + 0.5) * H / 4000; r2 += Wd(x) * 4 * Math.PI * x ** 4 * H / 4000; }
    const k = 0.01;
    const small = Math.abs(SG.splineKernelFT(k, H) - (1 - k * k * r2 / 6)) / (k * k * r2 / 6);
    assert.ok(SG.splineKernelFT(0, H) === 1 && small < 0.01, `ŵ small-k: ${small} of the k² term`);
    ok(`the kernel is the integrator's: the tree's softened pull is the enclosed mass of the transformed `
        + `density to ${worst.toExponential(1)}; ŵ = 1 − k²⟨r²⟩/6 at small k`);
}

// ── 2. T(k) ─────────────────────────────────────────────────────────────────
{
    const t1 = SG.softenedTransfer(1, A_INIT, A_OBS, growth);
    assert.ok(Math.abs(t1 - 1) < 1e-6, `T with the full force = ${t1}`);
    const page = [200, 80, 60].map(l => SG.softenedTransfer(SG.splineKernelFT(2 * Math.PI / l, 24), A_INIT, A_OBS, growth));
    assert.ok(page[0] > page[1] && page[1] > page[2] && page[2] > 0.7 && page[0] < 1, `T on the page ${page}`);
    ok(`T(k): ${t1.toFixed(7)} with the full force; on the page (h = 24 Mpc) T = `
        + `${page.map(v => v.toFixed(3)).join(' / ')} at λ = 200 / 80 / 60 Mpc`);
}

// ── 3. The deconvolution operator ───────────────────────────────────────────
const R = 140;
const glass = RC.buildGlass({ radius: R, spacing: 14, refineRadius: Infinity, seed: 3, ...SIM });
const vol = Float64Array.from(glass.mass, (m) => m / rho);
const ker = SG.deconvolutionKernel({ h: H, aInit: A_INIT, aObs: A_OBS, kappa: RC.RECON_CONFIG.growthKappa });
const radiusOf = (i) => Math.hypot(glass.pos[3 * i], glass.pos[3 * i + 1], glass.pos[3 * i + 2]);
{
    let integral = 0;
    ker.K.forEach((v, j) => { integral += v * 4 * Math.PI * (j * ker.dr) ** 2 * ker.dr; });
    const response = (k) => {
        let s = 0;
        ker.K.forEach((v, j) => { const r = j * ker.dr, x = k * r; s += v * ((x ? Math.sin(x) / x : 1) - 1) * 4 * Math.PI * r * r * ker.dr; });
        return s;
    };
    const full = (k) => 1 / SG.softenedTransfer(SG.splineKernelFT(k, H), A_INIT, A_OBS, growth) - 1;
    const long = response(2 * Math.PI / 200) / full(2 * Math.PI / 200);
    assert.ok(Math.abs(integral) < 1e-3 && Math.abs(long - 1) < 0.015, `kernel: ∫K = ${integral}, long-wave response ${long}`);
    let worst = 0;
    for (const lam of [200, 120, 80]) {
        const k = 2 * Math.PI / lam;
        const s = new Float64Array(3 * glass.n);
        for (let i = 0; i < glass.n; i++) s[3 * i] = Math.sin(k * glass.pos[3 * i] + 0.3);
        const c = SG.applyRadialKernel(glass.pos, s, vol, ker);
        let num = 0, den = 0;
        for (let i = 0; i < glass.n; i++) {
            if (radiusOf(i) > 0.5 * R) continue;
            num += c[3 * i] * s[3 * i]; den += s[3 * i] ** 2;
        }
        // Absolute, as a fraction of the field: the sphere's rim sits inside
        // the kernel's 6h range even here, and its continuation (s outside =
        // s at the point) shaves the longest wave's correction most.
        worst = Math.max(worst, Math.abs(num / den - response(k)));
    }
    assert.ok(worst < 0.003, `glass convolution vs kernel response: ${worst}`);
    ok(`the operator: ∫K = ${integral.toExponential(1)}, ${(100 * long).toFixed(1)} % of 1/T − 1 at λ = 200 Mpc; `
        + `on the glass a plane wave gets that response to ${(100 * worst).toFixed(2)} % of the field, rim included`);
}

// ── 4. The integrator follows T(k) ──────────────────────────────────────────
const sch = NB.buildSchedule({ aStart: A_INIT, aEnd: A_OBS, steps: 30 });
const forward = (ic) => {
    const s = NB.createSimulation({
        pos: ic.pos, vel: ic.vel, mass: glass.mass, group: new Uint8Array(glass.n), nMassive: glass.n,
        aStart: A_INIT, softening: [glass.softening, glass.softening], background: { radius: R, rho }, ...SIM,
    });
    for (let k = 0; k < sch.steps; k++) s.step(sch, k);
    return s.x;
};
{
    const W = (r) => { const x = r / (0.85 * R); return x >= 1 ? 0 : (1 - x * x) ** 3; };
    const n = [0.48, 0.6, 0.64].map(v => v / Math.hypot(0.48, 0.6, 0.64));
    const rows = [];
    for (const lam of [200, 120, 80]) {
        const k = 2 * Math.PI / lam, A = Math.min(1.5, 0.15 / k);
        const pot = (x, y, z) => (A / k) * Math.cos(k * (n[0] * x + n[1] * y + n[2] * z)) * W(Math.hypot(x, y, z));
        const psi = new Float64Array(3 * glass.n);
        for (let i = 0; i < glass.n; i++) {
            const x = glass.pos[3 * i], y = glass.pos[3 * i + 1], z = glass.pos[3 * i + 2], e = 1e-3;
            psi[3 * i] = -(pot(x + e, y, z) - pot(x - e, y, z)) / (2 * e);
            psi[3 * i + 1] = -(pot(x, y + e, z) - pot(x, y - e, z)) / (2 * e);
            psi[3 * i + 2] = -(pot(x, y, z + e) - pot(x, y, z - e)) / (2 * e);
        }
        const grown = (field) => {
            const x = forward(RC.zeldovichState(glass.pos, field, A_INIT, A_OBS));
            let num = 0, den = 0;
            for (let i = 0; i < glass.n; i++) {
                if (radiusOf(i) > 0.5 * R) continue;
                for (let d = 0; d < 3; d++) { num += (x[3 * i + d] - glass.pos[3 * i + d]) * psi[3 * i + d]; den += psi[3 * i + d] ** 2; }
            }
            return num / den;
        };
        rows.push({
            lam, T: SG.softenedTransfer(SG.splineKernelFT(k, H), A_INIT, A_OBS, growth),
            plain: grown(psi), dec: grown(SG.deconvolveGrowth(glass.pos, psi, vol, ker)),
        });
    }
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        assert.ok(r.plain < r.T + 0.005, `plain growth ${r.plain} vs T ${r.T} at λ ${r.lam}`);
        if (i) assert.ok(r.plain < rows[i - 1].plain, 'shorter waves fall further short');
        assert.ok(r.dec > r.plain + 0.5 * (1 - r.plain), `deconvolution closes the gap at λ ${r.lam}: ${r.plain} → ${r.dec}`);
    }
    assert.ok(Math.abs(rows[0].dec - 1) < 0.02, `λ = 200 Mpc deconvolved ${rows[0].dec}`);
    ok(`the integrator follows T(k): curl-free waves grow to ${rows.map(r => r.plain.toFixed(3)).join(' / ')} of `
        + `ideal at λ = ${rows.map(r => r.lam).join(' / ')} Mpc, in T's order (T = ${rows.map(r => r.T.toFixed(3)).join(' / ')} `
        + `for the bare wave; the window spreads it onto higher k); deconvolved ICs reach ${rows.map(r => r.dec.toFixed(3)).join(' / ')}`);
}

// ── 5. The void twin ────────────────────────────────────────────────────────
{
    const opts = (g) => ({ volume: Float64Array.from(g.mass, (m) => m / rho), hsoft: new Float64Array(g.n).fill(H), h: H, ...SIM });
    const psiTrue = (x, y, z) => { const e = 0.5 * Math.exp(-(x * x + y * y + z * z) / (2 * 40 * 40)); return [e * x, e * y, e * z]; };
    const gA = RC.buildGlass({ radius: R, spacing: 14, refineRadius: Infinity, seed: 29, ...SIM });
    const s1A = new Float64Array(3 * gA.n);
    for (let i = 0; i < gA.n; i++) s1A.set(psiTrue(gA.pos[3 * i], gA.pos[3 * i + 1], gA.pos[3 * i + 2]), 3 * i);
    const icA = L.lptState(gA.pos, s1A, L.secondOrderDisplacement(gA.pos, s1A, opts(gA)), A_INIT, growth);
    const sA = NB.createSimulation({
        pos: icA.pos, vel: icA.vel, mass: gA.mass, group: new Uint8Array(gA.n), nMassive: gA.n,
        aStart: A_INIT, softening: [gA.softening, gA.softening], background: { radius: R, rho }, ...SIM,
    });
    for (let k = 0; k < sch.steps; k++) sA.step(sch, k);
    const m = RC.matchObserved({
        glass, ...SIM,
        observed: { pos: Float64Array.from(sA.x), mass: gA.mass, group: new Uint8Array(gA.n), softening: [gA.softening, NB.plummer(1)] },
    });
    const psiRec = m.X.map((v, k) => v - glass.pos[k]);
    const truth = new Float64Array(3 * glass.n);
    for (let i = 0; i < glass.n; i++) truth.set(psiTrue(glass.pos[3 * i], glass.pos[3 * i + 1], glass.pos[3 * i + 2]), 3 * i);
    const sm = (f) => RC.interpolateDisplacement(glass.pos, glass.pos, f, 28);
    const cmp = (u, v) => {
        const a = sm(u), b = sm(v);
        let e2 = 0, t2 = 0, r2 = 0;
        for (let i = 0; i < glass.n; i++) {
            if (radiusOf(i) > 0.7 * R) continue;
            for (let d = 0; d < 3; d++) { e2 += (a[3 * i + d] - b[3 * i + d]) ** 2; t2 += b[3 * i + d] ** 2; r2 += a[3 * i + d] ** 2; }
        }
        return { rel: Math.sqrt(e2 / t2), amp: Math.sqrt(r2 / t2) };
    };
    const inv = L.invert2LPT(glass.pos, psiRec, { d2Obs: growth.d2Obs, iterations: 4, ...opts(glass) });
    const dec = SG.deconvolveGrowth(glass.pos, inv.s1, vol, ker);
    const fwdMiss = (s1) => {
        const x = forward(L.lptState(glass.pos, s1, L.secondOrderDisplacement(glass.pos, s1, opts(glass)), A_INIT, growth));
        return cmp(x.map((v, k) => v - glass.pos[k]), psiRec).rel;
    };
    const before = cmp(inv.s1, truth), after = cmp(dec, truth);
    const fb = fwdMiss(inv.s1), fa = fwdMiss(dec);
    assert.ok(Math.abs(after.amp - 1) < 0.015 && after.rel < 0.6 * before.rel, `twin: ${JSON.stringify({ before, after })}`);
    assert.ok(fa < 0.6 * fb, `forward miss ${fb} → ${fa}`);
    ok(`the void twin (δ_L = −1.5): recovered linear field ${(100 * before.rel).toFixed(1)} → ${(100 * after.rel).toFixed(1)} % `
        + `(amplitude ${before.amp.toFixed(3)} → ${after.amp.toFixed(3)}); run forward it lands within `
        + `${(100 * fb).toFixed(1)} → ${(100 * fa).toFixed(1)} % of today's displacement`);
}

console.log(`\n${passed} checks passed — js/bootes-softgrowth.js`);
