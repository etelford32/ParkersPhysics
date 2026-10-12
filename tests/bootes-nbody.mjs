#!/usr/bin/env node
/**
 * bootes-nbody.mjs — gate for js/bootes-nbody.js, the self-gravitating
 * forecast behind the galaxy tracker's "N-body" mode.
 *
 * Run: node tests/bootes-nbody.mjs        (~25 s)
 *
 * Every check is against something independent of the N-body code:
 *   1. TREE: Barnes–Hut equals the direct sum exactly when every node is
 *      opened, and to < 1.5 % of the rms PECULIAR force at the page's θ —
 *      peculiar, because the raw sum is dominated by the mean density's pull
 *      and an error quoted against it hides a void-sized mistake.
 *   2. KERNELS: the spline is Newtonian beyond h and its force IS the
 *      Newtonian force of its own density (W integrates to 1); the Plummer
 *      branch is the force probe's `pointGravityVector`, bit for bit in form.
 *   3. MEAN SUBTRACTION: a uniform quiet sphere feels no mean radial force,
 *      at the centre AND across its smoothed edge.
 *   4. QUIET START: the masses carry the profile — enclosed mass at every
 *      particle is the profile's (the 0.9 % volume-stratification error that
 *      sent a z = 19 run 11 % astray stays dead).
 *   5. JOIN AT z_obs: N-body test particles leave z_obs with the nonlinear
 *      tracker's velocity, and feel the probe's web force.
 *   6. FULL HISTORY, exact spherical solver: from z = 19 the integrator lands
 *      every shell on the exact ΛCDM shell ODE (the tracker's table).
 *   7. FORWARD, 3D tree: from z_obs the tree run tracks the shell ODE.
 *   8. LINEAR GROWTH, 3D tree: a broad small perturbation grows as D(a) from
 *      z = 19 (discreteness noise cancelled by a matched uniform run).
 *   9. Galaxies are TEST particles: adding them changes the matter not one
 *      bit, and a replay through stored snapshots equals the inline run.
 *  10. Step convergence and Newton's third law on the page's own configuration.
 *  11. RELAXING THE GRAIN AWAY (plan §4i): the moved particles get exactly
 *      `observedState`'s velocity where they now sit, the field's error
 *      against the EXACT deficit field (force probe) falls several-fold, and
 *      the enclosed contrast is still the profile's — the first version
 *      relaxed onto an analytic table and bent it by 0.11, so this is the
 *      check that guards the design.
 */

import assert from 'node:assert/strict';

import {
    createVoidProfile, matterContrastFromGalaxy, buildProfile, growthFactor, splitProfile, gravityRadialSI,
    meanMatterDensityMsunMpc3, pointGravityVector,
} from '../js/bootes-void-model.js';
import { createCosmicWeb, sampleTracers, mulberry32 } from '../js/bootes-web-model.js';
import {
    PROFILE_PRESETS, DEFAULT_BIAS, voidRedshift, effectiveRadiusMpc, resolvedAnchors,
} from '../js/bootes-void-data.js';
import { probeAt } from '../js/bootes-force-probe.js';
import { shellTable, trackGalaxy, scaleFactorAtTime, cosmicTimeGyr } from '../js/bootes-void-tracker.js';
import * as NB from '../js/bootes-nbody.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const rad = (x, i) => Math.hypot(x[3 * i], x[3 * i + 1], x[3 * i + 2]);

const Z = voidRedshift();
const A_OBS = 1 / (1 + Z);
const rEff = effectiveRadiusMpc();
const preset = PROFILE_PRESETS['hsw-supervoid'];
const profile = createVoidProfile({
    deltaC: matterContrastFromGalaxy(preset.centralGalaxyContrast, DEFAULT_BIAS),
    rvMpc: rEff, rsMpc: rEff * preset.rsFraction, alpha: preset.alpha, beta: preset.beta,
});
const web = createCosmicWeb({ voidProfile: profile, anchors: resolvedAnchors(), seed: 20260907, clumpiness: 0.65, z: Z });
const table = shellTable({ zObs: Z });
const rho = meanMatterDensityMsunMpc3();
const A_END = scaleFactorAtTime(cosmicTimeGyr(0) + 6);
const flow = NB.sphericalFlow(profile, table, { rMax: rEff * 5.9 });

/** A 3-vector of the comoving force on particle i of `sim`. */
const simForce = (sim, i) => [0, 1, 2].map(d => sim.fBg[3 * i + d] + sim.fWeb[3 * i + d]);

// The page's configuration (bootes/nbody-panel.js reads the same numbers).
const tracers = sampleTracers({ voidProfile: profile, web, count: 2400, bias: 1.5, seed: 20260907 + 17 });
const tracerPts = Float64Array.from(tracers.flatMap(t => t.offsetMpc));
const pageIc = NB.buildInitialConditions({
    voidProfile: profile, web, table, zObs: Z, testPoints: tracerPts,
    ...NB.PAGE_CONFIG.ic(rEff),
});

// ── 1. Tree vs direct ───────────────────────────────────────────────────────
{
    const sim = NB.createSimulation({ ...pageIc, ...NB.PAGE_CONFIG.sim });
    const members = [[], []];
    for (let i = 0; i < pageIc.nMassive; i++) members[pageIc.group[i]].push(i);
    const sphere = NB.meanSphereForce(pageIc.background.radius, rho, pageIc.softening[0]);

    // Opening every node reproduces the direct sum to rounding: the tree
    // holds each particle exactly once and the moments are right.
    const tiny = NB.buildTree(sim.x, pageIc.mass, Int32Array.from(members[0]), { leafSize: 16 });
    for (const i of [5, 900, 7000, pageIc.nMassive + 11]) {
        const a = new Float64Array(3), b = new Float64Array(3);
        NB.treeForce(tiny, sim.x[3 * i], sim.x[3 * i + 1], sim.x[3 * i + 2], 1e-6, pageIc.softening[0], a);
        NB.directForce(sim.x, pageIc.mass, members[0], sim.x[3 * i], sim.x[3 * i + 1], sim.x[3 * i + 2], pageIc.softening[0], b);
        const e = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / Math.hypot(...b);
        assert.ok(e < 1e-11, `θ → 0 tree == direct (${e})`);
    }

    // At the page's θ: error against the rms PECULIAR force.
    let s = 7;
    const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const errs = [];
    let rms = 0;
    for (let k = 0; k < 240; k++) {
        const i = Math.floor(rng() * sim.n), o = 3 * i;
        const d = new Float64Array(3);
        NB.directForce(sim.x, pageIc.mass, members[0], sim.x[o], sim.x[o + 1], sim.x[o + 2], pageIc.softening[0], d);
        NB.directForce(sim.x, pageIc.mass, members[1], sim.x[o], sim.x[o + 1], sim.x[o + 2], pageIc.softening[1], d);
        const r = rad(sim.x, i);
        const sub = -sphere(r) / r;
        for (let q = 0; q < 3; q++) d[q] += sub * sim.x[o + q];
        const t = simForce(sim, i);
        errs.push(Math.hypot(d[0] - t[0], d[1] - t[1], d[2] - t[2]));
        rms += d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    }
    rms = Math.sqrt(rms / errs.length);
    errs.sort((a, b) => a - b);
    const med = errs[errs.length >> 1] / rms, p99 = errs[Math.floor(errs.length * 0.99)] / rms;
    assert.ok(med < 0.015 && p99 < 0.04, `tree error vs rms peculiar: median ${med}, p99 ${p99}`);
    ok(`tree: exact at θ→0; at θ = ${NB.PAGE_CONFIG.sim.theta} the error is `
        + `${(100 * med).toFixed(2)} % (median) / ${(100 * p99).toFixed(2)} % (p99) of the rms PECULIAR force`);
}

// ── 2. Kernels ──────────────────────────────────────────────────────────────
{
    const h = 20;
    // ∫W d³x = 1.
    let norm = 0;
    const n = 4000;
    for (let k = 0; k < n; k++) {
        const r = (k + 0.5) * h / n;
        norm += 4 * Math.PI * r * r * NB.splineDensity(r, h) * h / n;
    }
    assert.ok(Math.abs(norm - 1) < 1e-6, `spline W normalised (${norm})`);
    // The spline force IS the Newtonian force of W's enclosed mass.
    const pos = Float64Array.of(0, 0, 0), mass = Float64Array.of(1e14), mem = [0];
    let encl = 0;
    for (let k = 0; k < n; k++) {
        const r = (k + 0.5) * h / n;
        encl += 4 * Math.PI * r * r * NB.splineDensity(r, h) * h / n;
        if (k % 400 !== 399) continue;
        const R = (k + 1) * h / n;
        const f = new Float64Array(3);
        NB.directForce(pos, mass, mem, R, 0, 0, NB.spline(h), f);
        const newton = -NB.G_MPC * 1e14 * encl / (R * R);
        assert.ok(Math.abs(f[0] / newton - 1) < 2e-3, `spline force = Newton(W mass) at r = ${R}: ${f[0] / newton}`);
    }
    for (const R of [h, 1.3 * h, 4 * h]) {
        const f = new Float64Array(3);
        NB.directForce(pos, mass, mem, R, 0, 0, NB.spline(h), f);
        assert.ok(Math.abs(f[0] / (-NB.G_MPC * 1e14 / (R * R)) - 1) < 1e-9, `Newtonian beyond h at ${R}`);
    }
    // Plummer branch, converted to physical m/s² at z_obs, IS pointGravityVector.
    const src = [30, -12, 7], at = [3, 4, -5], eps = web.softeningMpc;
    const f = new Float64Array(3);
    NB.directForce(Float64Array.from(src), Float64Array.of(3e14), [0], ...at, NB.plummer(eps), f);
    const ref = pointGravityVector(at, src, 3e14, eps, Z);
    for (let d = 0; d < 3; d++) {
        const mine = f[d] * NB.ACC_TO_SI / (A_OBS * A_OBS);
        assert.ok(Math.abs(mine / ref[d] - 1) < 1e-12, `Plummer = pointGravityVector (${mine} vs ${ref[d]})`);
    }
    ok('kernels: spline W normalised, its force IS Newton of its own mass and exact beyond h; '
        + 'Plummer IS the probe\'s pointGravityVector at z_obs');
}

// ── 3. Mean subtraction: a uniform sphere feels nothing ─────────────────────
{
    const R = 114, sp = 8;
    const soft = NB.spline(2 * sp);
    const qs = NB.quietSphere({ deltaFn: () => 0, radius: R, spacing: sp, rho, seed: 7 });
    const sphere = NB.meanSphereForce(R, rho, soft);
    const mem = Int32Array.from({ length: qs.mass.length }, (_, i) => i);
    // The interior of the smoothed sphere is exactly −(4π/3)Gρr.
    assert.ok(Math.abs(sphere(50) / (-(4 / 3) * Math.PI * NB.G_MPC * rho * 50) - 1) < 1e-12);
    const worst = [];
    for (const rm of [10, 40, 80, 100, 110, 118, 125]) {
        let acc = 0;
        const T = 120;
        for (let t = 0; t < T; t++) {
            const u = 2 * ((t + 0.5) / T) - 1, ph = t * 2.39996, s = Math.sqrt(1 - u * u);
            const p = [rm * s * Math.cos(ph), rm * s * Math.sin(ph), rm * u];
            const f = new Float64Array(3);
            NB.directForce(qs.pos, qs.mass, mem, ...p, soft, f);
            acc += (f[0] * p[0] + f[1] * p[1] + f[2] * p[2]) / rm;
        }
        const raw = (4 / 3) * Math.PI * NB.G_MPC * rho * Math.min(rm, R) ** 3 / (rm * rm);
        worst.push(Math.abs(acc / T - sphere(rm)) / raw);
    }
    const w = Math.max(...worst);
    assert.ok(w < 2e-3, `uniform sphere mean radial force / raw: ${worst.map(v => v.toExponential(1))}`);
    ok(`mean subtraction: a uniform quiet sphere feels ≤ ${(100 * w).toFixed(3)} % of the raw pull, `
        + 'centre to beyond its smoothed edge');
}

// ── 4. Quiet start carries the profile's mass ───────────────────────────────
{
    const qs = NB.quietSphere({
        deltaFn: (r) => profile.deltaAt(r), radius: 1.3 * rEff, spacing: 8, refineRadius: 0.6 * rEff, rho, seed: 3,
    });
    const order = Array.from(qs.radius0.keys()).sort((i, j) => qs.radius0[i] - qs.radius0[j]);
    let cum = 0, worst = 0;
    order.forEach((i, k) => {
        cum += qs.mass[i];
        const r = qs.radius0[i];
        if (r < 15 || k % 50) return;
        const enclosed = cum - 0.5 * qs.mass[i];
        const want = (4 / 3) * Math.PI * rho * r ** 3 * (1 + profile.integratedAt(r));
        worst = Math.max(worst, Math.abs(enclosed / want - 1));
    });
    assert.ok(worst < 1e-3, `enclosed mass at particles vs profile: ${worst}`);
    ok(`quiet start: enclosed mass at every particle matches the profile to ${(100 * worst).toFixed(3)} %`);
}

// ── 5. The join at z_obs ────────────────────────────────────────────────────
{
    const sim = NB.createSimulation({ ...pageIc, ...NB.PAGE_CONFIG.sim });
    let worstV = 0, worstG = 0;
    for (const k of [0, 37, 400, 1100, 2000, 2900, 3400]) {
        const i = pageIc.nMassive + k;
        const x = tracers[k].offsetMpc;
        const tg = trackGalaxy(x, { voidProfile: profile, web, zObs: Z, timeline: { epochs: [] }, table });
        const sample = tg.at({ tGyr: 0, a: A_OBS, z: Z, D: 1, gravity: 1, tidal: 1, velocity: 1 });
        const v = sim.velocity(i);
        const tv = Math.hypot(v[0], v[1], v[2]);
        worstV = Math.max(worstV, Math.abs(tv - sample.vKms) / Math.max(sample.vKms, 50));
        const pr = probeAt(x, { voidProfile: profile, web, z: Z, topN: 0 });
        const g = sim.acceleration(i).web;
        const e = Math.hypot(...g.map((c, d) => c - pr.forces.web.vector[d])) / pr.forces.web.magnitude;
        worstG = Math.max(worstG, e);
    }
    assert.ok(worstV < 2e-3, `IC speed vs nonlinear tracker at z_obs: ${worstV}`);
    assert.ok(worstG < 0.01, `web force vs probe at z_obs: ${worstG}`);
    ok(`join at z_obs: test galaxies leave with the tracker's speed (≤ ${(100 * worstV).toFixed(2)} %) `
        + `and feel the probe's web force (≤ ${(100 * worstG).toFixed(2)} %, the tree)`);
}

// Shared spherical setup for 6–8: the void alone, no web.
const sphCfg = { voidProfile: profile, table, zObs: Z, radius: 1.25 * rEff, spacing: 8, refineRadius: 0.6 * rEff };
const shellErr = (ic, sim, aStart, aEnd, rLo, rHi) => {
    const bins = new Map();
    for (let i = 0; i < ic.nMassive; i++) {
        const r = ic.radiusObs[i];
        if (r < rLo || r > rHi) continue;
        const b = Math.floor(r / 10);
        const ref = flow.at(r, aEnd).r, r0 = flow.at(r, aStart).r;
        if (!bins.has(b)) bins.set(b, { e: 0, c: 0 });
        const B = bins.get(b);
        B.e += (rad(sim.x, i) - ref) / (ref - r0);
        B.c++;
    }
    return Math.max(...[...bins.values()].map(B => Math.abs(B.e / B.c)));
};

// ── 6. Full history, exact spherical solver ─────────────────────────────────
{
    const a0 = 0.05;
    const ic = NB.buildInitialConditions({ ...sphCfg, aStart: a0 });
    const sim = NB.createSimulation({ ...ic, solver: 'spherical' });
    const sch = NB.buildSchedule({ aStart: a0, aEnd: A_OBS, steps: 60 });
    for (let s = 0; s < sch.steps; s++) sim.step(sch, s);
    const e = shellErr(ic, sim, a0, A_OBS, 10, 1.05 * rEff);
    assert.ok(e < 2e-3, `spherical full history: worst bin ${e}`);
    ok(`full history z = 19 → z_obs (exact spherical solver): every shell on the ΛCDM shell ODE `
        + `to ${(100 * e).toFixed(3)} % of its displacement`);
}

// ── 7. Forward from z_obs, 3D tree ──────────────────────────────────────────
{
    const ic = NB.buildInitialConditions(sphCfg);
    const sim = NB.createSimulation({ ...ic, ...NB.PAGE_CONFIG.sim });
    const sch = NB.buildSchedule({ aStart: A_OBS, aEnd: A_END, steps: 16 });
    for (let s = 0; s < sch.steps; s++) sim.step(sch, s);
    const e = shellErr(ic, sim, A_OBS, A_END, 15, 0.98 * rEff);
    assert.ok(e < 0.015, `3D forward: worst bin ${e}`);
    ok(`forward z_obs → t₀ + 6 Gyr (3D tree): shells track the exact ODE to ${(100 * e).toFixed(2)} % `
        + 'of their displacement');
}

// ── 8. Linear growth ∝ D, 3D tree ───────────────────────────────────────────
{
    const a0 = 0.05, steps = 30, R = 90, sp = 10;
    const mk = (pr) => {
        const ic = NB.buildInitialConditions({
            voidProfile: pr, table, zObs: Z, radius: R, spacing: sp, refineRadius: 50, aStart: a0,
        });
        const start = Float64Array.from(ic.pos);
        const sim = NB.createSimulation({ ...ic, theta: 0.45 });
        const sch = NB.buildSchedule({ aStart: a0, aEnd: A_OBS, steps });
        for (let s = 0; s < steps; s++) sim.step(sch, s);
        return { ic, sim, start };
    };
    const shape = { rvMpc: 60, rsMpc: 60 };
    const P = mk(buildProfile(r => -0.01 * Math.exp(-r * r / (2 * 50 * 50)), shape));
    const U = mk(buildProfile(() => 0, shape));
    // Displacement relative to the uniform run (identical layout ⇒ identical
    // discreteness noise, which is ~30× the signal at z = 19 and cancels).
    let m = 0, pred = 0;
    for (let i = 0; i < P.ic.nMassive; i++) {
        const r = P.ic.radiusObs[i];
        if (r < 20 || r > 60) continue;
        m += (rad(P.sim.x, i) - rad(P.start, i)) - (rad(U.sim.x, i) - rad(U.start, i));
        pred += r - rad(P.start, i);
    }
    const ratio = m / pred;
    assert.ok(Math.abs(ratio - 1) < 0.04, `linear growth ratio ${ratio}`);
    const Dr = growthFactor(1 / A_OBS - 1) / growthFactor(1 / a0 - 1);
    ok(`linear growth: a broad 1 % mode grows ×${Dr.toFixed(2)} (= D) from z = 19 in the 3D tree `
        + `to ${(100 * Math.abs(ratio - 1)).toFixed(1)} %`);
}

// ── 9. Test particles are massless; replay is bitwise ───────────────────────
{
    const small = NB.buildInitialConditions({
        voidProfile: profile, web, table, zObs: Z, testPoints: tracerPts.subarray(0, 300),
        radius: 1.4 * rEff, spacing: 16, refineRadius: rEff,
    });
    const bare = NB.buildInitialConditions({
        voidProfile: profile, web, table, zObs: Z, testPoints: new Float64Array(0),
        radius: 1.4 * rEff, spacing: 16, refineRadius: rEff,
    });
    const sch = NB.buildSchedule({ aStart: A_OBS, aEnd: A_END, steps: 6 });
    const run = NB.runSimulation(NB.createSimulation({ ...small, ...NB.PAGE_CONFIG.sim }), sch, {
        record: Int32Array.from({ length: 300 }, (_, i) => i), keepSnapshots: true, background: small.background,
    });
    const simB = NB.createSimulation({ ...bare, ...NB.PAGE_CONFIG.sim });
    for (let s = 0; s < sch.steps; s++) simB.step(sch, s);
    const last = run.snapshots[run.snapshots.length - 1];
    for (let k = 0; k < last.length; k++) assert.equal(last[k], simB.x[k], `massive coord ${k}`);
    const pts = Float64Array.from(small.pos.subarray(3 * small.nMassive, 3 * small.nMassive + 60));
    const vel = Float64Array.from(small.vel.subarray(3 * small.nMassive, 3 * small.nMassive + 60));
    const rep = NB.replayTestParticles({
        snapshots: run.snapshots, schedule: sch, mass: small.mass, group: small.group,
        nMassive: small.nMassive, points: pts, velocities: vel, softening: small.softening,
        background: small.background, ...NB.PAGE_CONFIG.sim,
    });
    for (let f = 0; f < run.frames; f++) {
        for (let k = 0; k < 20; k++) {
            for (let d = 0; d < 3; d++) {
                assert.equal(rep.pos[(f * 20 + k) * 3 + d], run.rec.pos[(f * 300 + k) * 3 + d], 'replay pos');
                assert.equal(rep.vel[(f * 20 + k) * 3 + d], run.rec.vel[(f * 300 + k) * 3 + d], 'replay vel');
            }
            assert.equal(rep.deltaEnc[f * 20 + k], run.rec.deltaEnc[f * 300 + k], 'replay Δ');
        }
    }
    ok('galaxies are test particles: 300 of them change the matter by 0 bits, and a replay '
        + 'through stored snapshots is bitwise the inline run');
}

// ── 10. The page's own run: step convergence, momentum, Δ(<r) ───────────────
{
    const sub = new Int32Array([0, 100, 500, 1500, 2500, 3300]);
    const runAt = (steps) => {
        const sim = NB.createSimulation({ ...pageIc, ...NB.PAGE_CONFIG.sim });
        const sch = NB.buildSchedule({ aStart: A_OBS, aEnd: A_END, steps });
        const res = NB.runSimulation(sim, sch, { record: sub, background: pageIc.background });
        return { sim, res };
    };
    const coarse = runAt(6), fine = runAt(NB.PAGE_CONFIG.steps);
    // Convergence on the full test field, relative to how far galaxies move.
    const n0 = 3 * pageIc.nMassive;
    let e2 = 0, d2 = 0;
    for (let k = n0; k < coarse.sim.x.length; k++) {
        e2 += (coarse.sim.x[k] - fine.sim.x[k]) ** 2;
        d2 += (fine.sim.x[k] - pageIc.pos[k]) ** 2;
    }
    const conv = Math.sqrt(e2 / d2);
    assert.ok(conv < 0.02, `6 vs ${NB.PAGE_CONFIG.steps} steps: ${conv}`);
    // Newton's third law on the INTERNAL forces (the tree sums with the mean
    // subtraction taken back out — that is an external background, and with
    // a clumped web off-centre it does push the system: total momentum is
    // NOT a conserved quantity here, and was measured drifting 4 %).
    const sim = fine.sim;
    const sphere = NB.meanSphereForce(pageIc.background.radius, rho, pageIc.softening[0]);
    const net = [0, 0, 0];
    let scale = 0;
    for (let i = 0; i < pageIc.nMassive; i++) {
        const r = rad(sim.x, i);
        const f = simForce(sim, i).map((c, d) => c - (-sphere(r) / r) * sim.x[3 * i + d]);
        for (let d = 0; d < 3; d++) net[d] += pageIc.mass[i] * f[d];
        scale += pageIc.mass[i] * Math.hypot(...f);
    }
    const dP = Math.hypot(...net) / scale;
    assert.ok(dP < 5e-3, `Newton III residual ${dP}`);
    // The measured Δ(<r) at frame 0 is the profile's (web carries the wall
    // in clumps, so a few % at the wall is the clumping, not an error).
    const rec = fine.res.rec;
    let worst = 0;
    sub.forEach((t, k) => {
        const r = rad(rec.pos, k);
        if (r < 30 || r > 1.2 * rEff) return;
        worst = Math.max(worst, Math.abs(rec.deltaEnc[k] - profile.integratedAt(r)));
    });
    assert.ok(worst < 0.03, `Δ(<r) at z_obs vs profile: ${worst}`);
    ok(`the page's run: ${NB.PAGE_CONFIG.steps} steps converged (6 steps is ${(100 * conv).toFixed(2)} % of the `
        + `displacement off), internal forces sum to ${dP.toExponential(1)} of Σm|F| (Newton III, to the tree), Δ(<r) at z_obs = the profile ±${worst.toFixed(3)}`);
}

// ── 11. Relaxing the quiet start's grain away ───────────────────────────────
{
    const R = 1.6 * rEff;
    const cfg = { radius: R, spacing: 14, refineRadius: Infinity, seed: 7 };
    const ic = NB.buildInitialConditions({ voidProfile: profile, web, table, zObs: Z, ...cfg });
    const tables = NB.relaxTables({ voidProfile: profile, web, table, zObs: Z, rMax: R * 1.02 });
    assert.throws(() => NB.createRelaxer({ ...ic, aStart: 0.5, tables }), /z_obs/);
    // Zero passes: the table velocities ARE observedState's.
    const zero = NB.createRelaxer({ ...ic, tables, iterations: 0, ...NB.PAGE_CONFIG.sim }).result();
    let e0 = 0, t0 = 0;
    for (let k = 0; k < 3 * ic.nBackground; k++) { e0 += (zero.vel[k] - ic.vel[k]) ** 2; t0 += ic.vel[k] ** 2; }
    const rl = NB.createRelaxer({ ...ic, tables, ...NB.PAGE_CONFIG.sim });
    while (rl.step());
    const out = rl.result();
    // Relaxed: the velocities are observedState's AT THE NEW POSITIONS.
    const fresh = NB.observedState(out.pos.subarray(0, 3 * ic.nBackground), { voidProfile: profile, web, table, zObs: Z });
    let e1 = 0, t1 = 0;
    for (let k = 0; k < 3 * ic.nBackground; k++) { e1 += (out.vel[k] - fresh.vel[k]) ** 2; t1 += fresh.vel[k] ** 2; }
    const vel0 = Math.sqrt(e0 / t0), vel1 = Math.sqrt(e1 / t1);
    assert.ok(vel0 < 1e-5 && vel1 < 1e-4, `velocities: ${vel0}, ${vel1}`);
    // The grain against the EXACT deficit field, at points inside the sphere.
    const { deficit } = splitProfile(profile);
    const conv = A_OBS * A_OBS / NB.ACC_TO_SI;
    const rng = mulberry32(41);
    const probes = [];
    while (probes.length < 600) {
        const p = [(2 * rng() - 1) * R, (2 * rng() - 1) * R, (2 * rng() - 1) * R];
        const r = Math.hypot(...p);
        if (r > 10 && r < 0.95 * R) probes.push(p);
    }
    const grain = (pos) => {
        const n = ic.nBackground;
        const tree = NB.buildTree(pos, ic.mass, Int32Array.from({ length: n }, (_, i) => i), { leafSize: 16 });
        const sph = NB.meanSphereForce(R, rho, ic.softening[0]);
        const acc = { in: [0, 0], out: [0, 0] };
        for (const p of probes) {
            const r = Math.hypot(...p), b = new Float64Array(3);
            NB.treeForce(tree, ...p, 0.5, ic.softening[0], b);
            const gx = conv * gravityRadialSI(r, deficit, { z: Z }) / r;
            const bin = r < 0.6 * R ? acc.in : acc.out;
            for (let d = 0; d < 3; d++) {
                const ex = gx * p[d];
                bin[0] += (b[d] - sph(r) / r * p[d] - ex) ** 2; bin[1] += ex * ex;
            }
        }
        return { in: Math.sqrt(acc.in[0] / acc.in[1]), out: Math.sqrt(acc.out[0] / acc.out[1]) };
    };
    const before = grain(ic.pos), after = grain(out.pos);
    // The core keeps a floor that is the SOFTENING (h = 28 Mpc here, against
    // the bare field), not grain: measured 9.2 → 3.7 % inside, 18.6 → 2.4 %
    // outside on this layout.
    assert.ok(after.in < before.in / 2 && after.out < before.out / 4, `grain: ${JSON.stringify({ before, after })}`);
    // The profile survives: the enclosed contrast of the relaxed smooth matter.
    const rs = Array.from({ length: ic.nBackground }, (_, i) => rad(out.pos, i)).sort((u, v) => u - v);
    const mEach = ic.mass[0];
    let worst = 0;
    for (const r of [30, 60, 90, 120]) {
        let m = 0;
        for (let i = 0; i < ic.nBackground; i++) if (rad(out.pos, i) < r) m += ic.mass[i];
        const d = m / (rho * 4 / 3 * Math.PI * r ** 3) - 1;
        worst = Math.max(worst, Math.abs(d - deficit.integratedAt(r)));
    }
    assert.ok(worst < 0.01 && rs.length === ic.nBackground && mEach > 0, `enclosed contrast after relaxing: ${worst}`);
    // The pin (plan §4j): the relaxed enclosed mass is the QUIET START's, not
    // merely near the profile — compared on the same radii.
    const enclosedDrift = (P) => {
        let w = 0;
        for (const r of [30, 60, 90, 120, 150]) {
            let m0 = 0, m1 = 0;
            for (let i = 0; i < ic.nBackground; i++) {
                if (rad(ic.pos, i) < r) m0 += ic.mass[i];
                if (rad(P, i) < r) m1 += ic.mass[i];
            }
            w = Math.max(w, Math.abs(m1 - m0) / (rho * 4 / 3 * Math.PI * r ** 3));
        }
        return w;
    };
    const pinned = enclosedDrift(out.pos);
    // The A/B: the old relaxer (fixed rate 0.7, no pin) leaves more grain
    // outside — that floor was the rim's error — and lets the mass drift.
    const old = NB.createRelaxer({ ...ic, tables, rate: 0.7, pinMonopole: false, ...NB.PAGE_CONFIG.sim });
    while (old.step());
    const oldOut = old.result(), oldGrain = grain(oldOut.pos), oldDrift = enclosedDrift(oldOut.pos);
    assert.ok(pinned < 2e-3 && oldDrift > 2 * pinned, `pin: Δ(<r) drift ${pinned} (unpinned ${oldDrift})`);
    assert.ok(after.out < 0.8 * oldGrain.out, `schedule: outside grain ${after.out} vs fixed rate ${oldGrain.out}`);
    ok(`relaxing the grain away: ${rl.iterations} passes move the smooth matter ${out.shiftRmsMpc.toFixed(2)} Mpc rms; `
        + `its grain against the exact deficit field ${(100 * before.in).toFixed(1)} → ${(100 * after.in).toFixed(1)} % in the core, `
        + `${(100 * before.out).toFixed(1)} → ${(100 * after.out).toFixed(1)} % outside (a fixed rate 0.7: `
        + `${(100 * oldGrain.out).toFixed(1)} %); velocities are observedState's where the particles `
        + `now sit (${vel1.toExponential(1)}); Δ(<r) still the profile's ±${worst.toFixed(3)} and the quiet start's `
        + `${pinned === 0 ? "exactly" : "±" + pinned.toExponential(1)} (unpinned ±${oldDrift.toExponential(1)})`);
}

// ── 12. The Chebyshev step sizes ───────────────────────────────────────────
{
    const rates = NB.chebyshevRates(20, 0.25);
    let worst = 0, fixed = 0;
    for (let k = 0; k <= 400; k++) {
        const w = 0.25 + 0.75 * k / 400;
        worst = Math.max(worst, Math.abs(rates.reduce((p, r) => p * (1 - r * w), 1)));
        fixed = Math.max(fixed, Math.abs((1 - 0.7 * w) ** 20));
    }
    // The minimax bound on [0.25, 1] is 2·(1/3)^20 ≈ 6e-10.
    assert.ok(rates.length === 20 && worst < 1e-9 && fixed > 0.01, `chebyshev: ${worst} vs fixed ${fixed}`);
    assert.deepEqual([...NB.PAGE_CONFIG.relax.rates], rates);
    // Largest first, then alternating: no two large steps in a row.
    for (let k = 0; k + 1 < rates.length; k += 2) assert.ok(rates[k] > rates[k + 1]);
    ok(`the relaxation's step sizes: 20 Chebyshev rates over ŵ ∈ [0.25, 1] leave any mode there at most `
        + `${worst.toExponential(1)} of itself (a fixed 0.7: ${fixed.toFixed(3)})`);
}

console.log(`\n${passed} checks passed — js/bootes-nbody.js`);
