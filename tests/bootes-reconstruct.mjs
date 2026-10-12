#!/usr/bin/env node
/**
 * bootes-reconstruct.mjs — gate for js/bootes-reconstruct.js, the web's
 * initial conditions (BOOTES_VOID_PLAN.md §4d Phase 2).
 *
 * Run: node tests/bootes-reconstruct.mjs        (~3 min)
 *
 *   1. PER-PARTICLE SOFTENING: the tree equals the direct sum when every cell
 *      is opened, and each source is smoothed at its OWN h.
 *   2. THE FRAME CLOCK on a two-segment run: every frame's own a lands on it.
 *   3. THE GLASS is quiet: the repulsive relaxation drives the residual force
 *      down by > 10× to a few hundredths of a Mpc.
 *   4. SPHERICAL IDENTITY: matching a lone void (no web) puts every shell back
 *      at the Lagrangian radius mass conservation demands — the tracker's
 *      shell table, an independent calculation.
 *   5. TWIN EXPERIMENT: plant a KNOWN initial field, run it forward with the
 *      N-body, reconstruct from a DIFFERENT glass — the recovered initial
 *      field matches the planted one at the elements' resolution.
 *   6. THE ICs ARE INITIAL: at z = 9 the reconstructed state is a consistent
 *      linear growing mode (its own gravity IS 4πGρ̄₀ × its displacement) —
 *      no 10¹⁵ M☉ points left in the early universe.
 *   7. TODAY'S GRAVITY: the reconstructed universe, run forward, reproduces
 *      the observed model's force field at the galaxies.
 *   8. GALAXIES land where they are observed, and each is independent of the
 *      others (a galaxy shot alone is bitwise the same galaxy shot in a crowd).
 *   9. THE NODES GREW: matter around where the web's nodes end up rises from
 *      z = 9 to today.
 *  10. THE PAST, against a planted truth (plan §4k): the observed model is
 *      matched on a near-grain-free glass, its 2LPT past laid down at z = 19
 *      and run forward with snapshots — a known history. The pipeline sees
 *      only its last frame and must recover its GRAVITY at z = 9 and z = 4,
 *      not just today's; and the glass's Chebyshev schedule must beat the
 *      fixed-rate glass it replaced at z = 9 (its grain is 4–11 % of the
 *      z = 9 signal at page scale).
 *  11. THE BAYESIAN FORWARD MODEL (plan §4l), on the same twin: fitting the
 *      initial field to today's field at seeded points must improve the
 *      recovered PAST at every epoch, inside and outside R_eff, against the
 *      truth — today's fit alone is not the claim.
 */

import assert from 'node:assert/strict';

import {
    createVoidProfile, matterContrastFromGalaxy, meanMatterDensityMsunMpc3, growthFactor,
} from '../js/bootes-void-model.js';
import { createCosmicWeb, sampleTracers, mulberry32 } from '../js/bootes-web-model.js';
import {
    PROFILE_PRESETS, DEFAULT_BIAS, voidRedshift, effectiveRadiusMpc, resolvedAnchors,
} from '../js/bootes-void-data.js';
import { shellTable, scaleFactorAtTime, cosmicTimeGyr } from '../js/bootes-void-tracker.js';
import * as NB from '../js/bootes-nbody.js';
import * as RC from '../js/bootes-reconstruct.js';
import { invert2LPT, lptGrowth, lptState, secondOrderDisplacement } from '../js/bootes-lpt.js';
import { deconvolutionKernel, deconvolveGrowth } from '../js/bootes-softgrowth.js';
import * as FM from '../js/bootes-forward-model.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

const Z = voidRedshift();
const A_OBS = 1 / (1 + Z);
const A_END = scaleFactorAtTime(cosmicTimeGyr(0) + 6);
const rEff = effectiveRadiusMpc();
const rho = meanMatterDensityMsunMpc3();
const k4 = 4 * Math.PI * NB.G_MPC * rho;
const preset = PROFILE_PRESETS['hsw-supervoid'];
const profile = createVoidProfile({
    deltaC: matterContrastFromGalaxy(preset.centralGalaxyContrast, DEFAULT_BIAS),
    rvMpc: rEff, rsMpc: rEff * preset.rsFraction, alpha: preset.alpha, beta: preset.beta,
});
const web = createCosmicWeb({ voidProfile: profile, anchors: resolvedAnchors(), seed: 20260907, clumpiness: 0.65, z: Z });
const table = shellTable({ zObs: Z });
const SIM = NB.PAGE_CONFIG.sim;
// A reduced layout so the gate runs in seconds; the page's own is measured
// in BOOTES_VOID_PLAN.md §4d.
const CFG = { radius: 1.6 * rEff, spacing: 14, refineRadius: rEff };

// ── 1. Per-particle softening ───────────────────────────────────────────────
{
    const rng = mulberry32(3);
    const n = 600;
    const pos = Float64Array.from({ length: 3 * n }, () => (rng() - 0.5) * 120);
    const mass = Float64Array.from({ length: n }, () => 1e13 * (0.5 + rng()));
    const h = Float64Array.from({ length: n }, () => 4 + 20 * rng());
    const soft = NB.splinePerParticle(h, 24);
    const members = Int32Array.from({ length: n }, (_, i) => i);
    const tree = NB.buildTree(pos, mass, members, { leafSize: 8, hsoft: h });
    for (const p of [[0, 0, 0], [10, -3, 7], [55, 40, -20]]) {
        const a = new Float64Array(3), b = new Float64Array(3);
        NB.treeForce(tree, ...p, 1e-6, soft, a);
        NB.directForce(pos, mass, members, ...p, soft, b);
        const e = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / Math.hypot(...b);
        assert.ok(e < 1e-11, `per-particle tree == direct (${e})`);
    }
    // Each source keeps its own kernel: inside h₁ but outside h₂ at the same
    // distance, source 1 is softened and source 2 is Newtonian.
    const two = Float64Array.of(10, 0, 0, -10, 0, 0);
    const m2 = Float64Array.of(1e14, 1e14);
    const hh = NB.splinePerParticle(Float64Array.of(20, 5), 20);
    const f = new Float64Array(3);
    NB.directForce(two, m2, [1], 0, 0, 0, hh, f);
    assert.ok(Math.abs(f[0] / (-NB.G_MPC * 1e14 / 100) - 1) < 1e-12, 'h = 5 source is Newtonian at 10 Mpc');
    const g = new Float64Array(3);
    NB.directForce(two, m2, [0], 0, 0, 0, hh, g);
    assert.ok(g[0] / (NB.G_MPC * 1e14 / 100) < 0.99, 'h = 20 source is softened at 10 Mpc');
    ok('per-particle spline softening: tree == direct at θ → 0, and each source keeps its own h');
}

// ── 2. The frame clock on a two-segment run ─────────────────────────────────
{
    const sch = RC.concatSchedules(
        NB.buildSchedule({ aStart: 0.1, aEnd: A_OBS, steps: 30 }),
        NB.buildSchedule({ aStart: A_OBS, aEnd: A_END, steps: 24 }));
    assert.equal(sch.obsFrame, 30);
    assert.ok(Math.abs(sch.a[sch.obsFrame] - A_OBS) < 1e-12);
    for (let f = 0; f < sch.a.length - 1; f++) {
        const loc = NB.locateFrame(sch.N, sch.a[f]);
        assert.ok(Math.abs(loc.i + loc.t - f) < 1e-9, `frame ${f} located at ${loc.i}+${loc.t}`);
    }
    ok('the frame clock: every frame of a two-segment (z = 9 → z_obs → end) run lands on itself');
}

// ── 3. The glass ────────────────────────────────────────────────────────────
const glass = RC.buildGlass({ ...CFG, ...SIM });
{
    const first = glass.history[0], last = glass.residual;
    assert.ok(last < 0.07 && last < first / 10, `glass residual ${first} → ${last} Mpc`);
    // The A/B: the fixed-rate glass the Chebyshev schedule replaced (plan §4k).
    const fixed = RC.buildGlass({ ...CFG, ...SIM, rate: 0.7 });
    assert.ok(last < 0.7 * fixed.residual, `glass schedule: ${last} vs fixed rate ${fixed.residual}`);
    ok(`glass: residual displacement-force ${first.toFixed(2)} → ${last.toFixed(3)} Mpc (quiet start → glass) over `
        + `${glass.history.length - 1} repulsive Chebyshev steps (${glass.n} elements; a fixed rate 0.7: ${fixed.residual.toFixed(3)})`);
}

// ── 4. Spherical identity ───────────────────────────────────────────────────
{
    const obs = NB.buildInitialConditions({ voidProfile: profile, table, zObs: Z, ...CFG, seed: 7 });
    const m = RC.matchObserved({
        glass, observed: { pos: obs.pos, mass: obs.mass, group: obs.group, softening: obs.softening }, ...SIM,
    });
    const flow = NB.sphericalFlow(profile, table, { rMax: 5.9 * rEff });
    const bins = new Map();
    for (let i = 0; i < glass.n; i++) {
        const r = Math.hypot(m.X[3 * i], m.X[3 * i + 1], m.X[3 * i + 2]);
        // The interior: inside 20 Mpc a bin holds a handful of elements, and
        // the void's β = 9 wall at 0.95 R_eff is steeper than the elements'
        // h = 28 Mpc resolves (10 % there, measured — resolution, not error).
        if (r < 20 || r > 0.85 * rEff) continue;
        const qr = Math.hypot(glass.pos[3 * i], glass.pos[3 * i + 1], glass.pos[3 * i + 2]);
        const want = flow.at(r, A_OBS).q;
        const b = Math.floor(r / 20);
        if (!bins.has(b)) bins.set(b, { e: 0, c: 0 });
        bins.get(b).e += (qr - want) / (r - want);
        bins.get(b).c++;
    }
    const worst = Math.max(...[...bins.values()].filter(B => B.c >= 20).map(B => Math.abs(B.e / B.c)));
    if (process.env.DEBUG) console.log([...bins].sort((a, b) => a[0] - b[0]).map(([b, B]) => `${b * 20}:${(B.e / B.c).toFixed(3)}(${B.c})`).join(" "));
    assert.ok(worst < 0.06, `spherical Lagrangian radii: worst bin ${worst}`);
    ok(`spherical identity: matching puts every void shell back at its mass-conserving Lagrangian `
        + `radius to ${(100 * worst).toFixed(1)} % of its displacement`);
}

// ── 5. Twin experiment ──────────────────────────────────────────────────────
{
    const R = 140;
    const cfg = { radius: R, spacing: 14, refineRadius: Infinity };
    const rng = mulberry32(5);
    const waves = [];
    for (let i = 0; i < 10; i++) {
        const u = 2 * rng() - 1, ph = 2 * Math.PI * rng(), s = Math.sqrt(1 - u * u);
        const k = 2 * Math.PI / (80 + 120 * rng());
        waves.push({ kx: k * s * Math.cos(ph), ky: k * s * Math.sin(ph), kz: k * u, ph: 2 * Math.PI * rng(), A: 1 / k });
    }
    const W = (r) => { const x = r / (0.85 * R); return x >= 1 ? 0 : (1 - x * x) ** 3; };
    const pot = (x, y, z) => waves.reduce((acc, w) => acc + w.A * Math.cos(w.kx * x + w.ky * y + w.kz * z + w.ph), 0)
        * W(Math.hypot(x, y, z));
    const grad = (x, y, z) => {
        const h = 1e-3;
        return [-(pot(x + h, y, z) - pot(x - h, y, z)) / (2 * h), -(pot(x, y + h, z) - pot(x, y - h, z)) / (2 * h),
            -(pot(x, y, z + h) - pot(x, y, z - h)) / (2 * h)];
    };
    let s2 = 0;
    for (let i = 0; i < 2000; i++) {
        const r = R * Math.cbrt(rng()), u = 2 * rng() - 1, ph = 6.283 * rng(), s = Math.sqrt(1 - u * u);
        const v = grad(r * s * Math.cos(ph), r * s * Math.sin(ph), r * u);
        s2 += v[0] ** 2 + v[1] ** 2 + v[2] ** 2;
    }
    const norm = 3 / Math.sqrt(s2 / 2000);           // 3 Mpc rms across the sphere
    const psiTrue = (x, y, z) => grad(x, y, z).map(v => v * norm);

    // The truth: a different glass, displaced by the planted field, run forward.
    const gA = RC.buildGlass({ ...cfg, seed: 3, ...SIM });
    const psiA = new Float64Array(3 * gA.n);
    for (let i = 0; i < gA.n; i++) psiA.set(psiTrue(gA.pos[3 * i], gA.pos[3 * i + 1], gA.pos[3 * i + 2]), 3 * i);
    const icA = RC.zeldovichState(gA.pos, psiA, 0.1, A_OBS);
    const simA = NB.createSimulation({
        pos: icA.pos, vel: icA.vel, mass: gA.mass, group: new Uint8Array(gA.n), nMassive: gA.n,
        aStart: 0.1, softening: [gA.softening, gA.softening], background: { radius: R, rho }, ...SIM,
    });
    const sch = NB.buildSchedule({ aStart: 0.1, aEnd: A_OBS, steps: 30 });
    for (let s = 0; s < sch.steps; s++) simA.step(sch, s);

    // The reconstruction sees only the final particles.
    const gB = RC.buildGlass({ ...cfg, seed: 17, ...SIM });
    const m = RC.matchObserved({
        glass: gB, ...SIM,
        observed: { pos: Float64Array.from(simA.x), mass: gA.mass, group: new Uint8Array(gA.n),
            softening: [gA.softening, NB.plummer(1)] },
    });
    const psiRec = new Float64Array(3 * gB.n);
    for (let k = 0; k < psiRec.length; k++) psiRec[k] = m.X[k] - gB.pos[k];
    const truth = new Float64Array(3 * gB.n);
    for (let i = 0; i < gB.n; i++) truth.set(psiTrue(gB.pos[3 * i], gB.pos[3 * i + 1], gB.pos[3 * i + 2]), 3 * i);
    // Compared at the elements' resolution (2 × spacing) — the grain is not
    // a claim the reconstruction makes.
    const sm = (f) => RC.interpolateDisplacement(gB.pos, gB.pos, f, 28);
    const a = sm(psiRec), b = sm(truth);
    let e2 = 0, t2 = 0, r2 = 0, dot = 0;
    for (let i = 0; i < gB.n; i++) {
        if (Math.hypot(gB.pos[3 * i], gB.pos[3 * i + 1], gB.pos[3 * i + 2]) > 0.7 * R) continue;
        for (let d = 0; d < 3; d++) {
            const u = a[3 * i + d], v = b[3 * i + d];
            e2 += (u - v) ** 2; t2 += v * v; r2 += u * u; dot += u * v;
        }
    }
    const rel = Math.sqrt(e2 / t2), corr = dot / Math.sqrt(t2 * r2);
    assert.ok(rel < 0.15 && corr > 0.97, `twin: rel ${rel}, corr ${corr}`);
    ok(`twin experiment: a planted initial field is recovered from a DIFFERENT glass to `
        + `${(100 * rel).toFixed(1)} % (correlation ${corr.toFixed(3)}) at the elements' resolution`);
}

// ── 6–9. The pipeline on the void + web ─────────────────────────────────────
{
    const obs = NB.buildInitialConditions({ voidProfile: profile, web, table, zObs: Z, ...CFG, seed: 7 });
    const tracers = sampleTracers({ voidProfile: profile, web, count: 2400, bias: 1.5, seed: 20260907 + 17 })
        .filter(t => t.radiusMpc < CFG.radius).slice(0, 240);
    const pts = Float64Array.from([...tracers.flatMap(t => t.offsetMpc), ...web.nodes.flatMap(nd => nd.offsetMpc)]);
    const run = RC.reconstructRun({
        observed: { pos: obs.pos.subarray(0, 3 * obs.nMassive), mass: obs.mass, group: obs.group, softening: obs.softening },
        config: CFG, testPoints: pts, aObs: A_OBS, aEnd: A_END, sim: SIM,
        nodeMarkers: { from: tracers.length, count: web.nodes.length },
    });
    const dg = run.diagnostics;

    // 6. The ICs are a linear growing mode: at z = 9 the elements' own peculiar
    //    gravity IS 4πGρ̄₀ × their displacement from the glass.
    {
        const x0 = run.snapshots[0];
        const sim0 = NB.createSimulation({
            pos: x0, vel: new Float64Array(x0.length), mass: run.mass, group: run.group, nMassive: run.nMassive,
            aStart: 0.1, softening: run.softening, background: run.background, ...SIM,
        });
        let dot = 0, ff = 0, dd = 0;
        for (let i = 0; i < run.nMassive; i++) {
            if (Math.hypot(glass.pos[3 * i], glass.pos[3 * i + 1], glass.pos[3 * i + 2]) > 0.8 * CFG.radius) continue;
            for (let d = 0; d < 3; d++) {
                const k = 3 * i + d;
                const f = (sim0.fBg[k] + sim0.fWeb[k]) / k4;
                const dsp = x0[k] - glass.pos[k];
                dot += f * dsp; ff += f * f; dd += dsp * dsp;
            }
        }
        const corr = dot / Math.sqrt(ff * dd), amp = Math.sqrt(ff / dd);
        const ratio = growthFactor(1 / 0.1 - 1) / growthFactor(1 / A_OBS - 1);
        assert.ok(corr > 0.85 && Math.abs(amp - 1) < 0.25, `z = 9 linearity: corr ${corr}, amp ${amp}`);
        assert.ok(Math.sqrt(dd / run.nMassive) < 0.25 * CFG.spacing, 'z = 9 displacements are small');
        ok(`the ICs are initial: at z = 9 the elements' own gravity is 4πGρ̄₀ × their displacement `
            + `(correlation ${corr.toFixed(2)}, amplitude ${amp.toFixed(2)}); D(z=9)/D(z_obs) = ${ratio.toFixed(3)}`);
    }

    // 7. Today's gravity.
    {
        const inner = dg.fieldBins.filter(b => b.r1 <= rEff);
        const worstInner = Math.max(...inner.map(b => b.rel));
        assert.ok(worstInner < 0.15 && dg.fieldError < 0.2, `field match: inner ${worstInner}, overall ${dg.fieldError}`);
        // Each bin also carries its miss and its field in (km/s)²/Mpc, and
        // rel IS their ratio (plan §4j: the rim is read against `field`).
        for (const b of dg.fieldBins) assert.ok(Math.abs(b.abs - b.rel * b.field) <= 1e-9 * b.field, `bin ${b.r0}`);
        // The page's ICs are 2LPT (js/bootes-lpt.js, tests/bootes-lpt.mjs);
        // measured on this layout the void interior went 7.5 → 3.4 % (§4f).
        assert.equal(dg.ics, '2lpt');
        // …and laid down through the softened integrator's own transfer
        // (js/bootes-softgrowth.js, tests/bootes-softgrowth.mjs, plan §4g).
        assert.equal(dg.growthKappa, RC.RECON_CONFIG.growthKappa);
        assert.ok(dg.growthCorrectionRmsMpc > 0.05 * dg.secondOrderRmsMpc, 'growth correction applied');
        assert.ok(dg.fieldBins[0].rel < 0.06, `2LPT void interior ${dg.fieldBins[0].rel}`);
        ok(`today's gravity: the reconstructed universe (2LPT ICs, softened-growth deconvolved) reproduces the observed model's force at the `
            + `galaxies to ${(100 * dg.fieldBins[0].rel).toFixed(1)} % in the void's core, ≤ ${(100 * worstInner).toFixed(0)} % inside R_eff, `
            + `${(100 * dg.fieldError).toFixed(0)} % overall`);
    }

    // 8. Galaxies.
    {
        const g = dg.galaxyResidualsMpc;
        assert.ok(g[g.length - 1] < 0.1 && g[g.length - 1] < g[0] / 10, `galaxy residuals ${g}`);
        // Independence: re-shoot three galaxies alone; bitwise the crowd's.
        const pick = [3, 50, 120];
        const sub = Float64Array.from(pick.flatMap(i => [pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]]));
        const psi0 = Float64Array.from(pick.flatMap(i => [0, 0, 0]));
        const crowdPsi0 = new Float64Array(pts.length);
        const crowd = RC.shootGalaxies({
            snapshots: run.snapshots, schedule: run.schedule, mass: run.mass, group: run.group,
            nMassive: run.nMassive, softening: run.softening, background: run.background,
            targets: pts, psi0: crowdPsi0, aObs: A_OBS, shots: 1, ...SIM,
        });
        const alone = RC.shootGalaxies({
            snapshots: run.snapshots, schedule: run.schedule, mass: run.mass, group: run.group,
            nMassive: run.nMassive, softening: run.softening, background: run.background,
            targets: sub, psi0, aObs: A_OBS, shots: 1, ...SIM,
        });
        const m = pts.length / 3;
        pick.forEach((i, k) => {
            for (let d = 0; d < 3; d++) {
                assert.equal(alone.rec.pos[(run.schedule.obsFrame * 3 + k) * 3 + d],
                    crowd.rec.pos[(run.schedule.obsFrame * m + i) * 3 + d], 'galaxy independence');
            }
        });
        ok(`galaxies: shot to within ${(1000 * g[g.length - 1]).toFixed(0)} kpc rms of where they are `
            + `observed (from ${g[0].toFixed(2)} Mpc), each independent of the others to the bit`);
    }

    // 9. The nodes grew.
    {
        const acc = run.accreted;
        const start = acc[0], now = acc[run.obsFrame], end = acc[acc.length - 1];
        assert.ok(now > 1.1 * start && end >= now * 0.98, `node matter ${start} → ${now} → ${end}`);
        ok(`the nodes grew: matter within ${RC.NODE_RADIUS_MPC} Mpc of where the web's nodes end up rises `
            + `${(100 * (now / start - 1)).toFixed(0)} % from z = 9 to z_obs, then ${(100 * (end / now - 1)).toFixed(1)} % more`);
    }
}

// ── 10. The past, against a planted truth ──────────────────────────────────
{
    const R = 1.6 * rEff, cfg = { radius: R, spacing: 14, refineRadius: Infinity }, h = 28;
    const EP = [0.1, 0.2, A_OBS];
    // The pipeline's own ICs: 2LPT inverse + softened-growth deconvolution.
    const lptICs = (gl, X, aI) => {
        const vol = Float64Array.from(gl.mass, (m) => m / rho), hs = Float64Array.from(gl.mass, () => h);
        const g = lptGrowth(aI, A_OBS);
        const psi = X.map((v, k) => v - gl.pos[k]);
        const inv = invert2LPT(gl.pos, psi, { d2Obs: g.d2Obs, iterations: 4, volume: vol, hsoft: hs, h, ...SIM });
        const s1 = deconvolveGrowth(gl.pos, inv.s1, vol, deconvolutionKernel({ h, aInit: aI, aObs: A_OBS, kappa: 3 }));
        const s2 = secondOrderDisplacement(gl.pos, s1, { volume: vol, hsoft: hs, h, ...SIM });
        return lptState(gl.pos, s1, s2, aI, g);
    };
    const evolve = (gl, ic, a0) => {
        const sim = NB.createSimulation({
            pos: ic.pos, vel: ic.vel, mass: gl.mass, group: new Uint8Array(gl.n), nMassive: gl.n, aStart: a0,
            softening: [gl.softening, gl.softening], background: { radius: gl.radius, rho }, ...SIM,
        });
        const out = {};
        let a = a0;
        for (const e of EP) {
            if (e > a) {
                const sch = NB.buildSchedule({ aStart: a, aEnd: e, steps: Math.max(3, Math.round(13 * Math.log(e / a))) });
                for (let s = 0; s < sch.steps; s++) sim.step(sch, s);
                a = e;
            }
            out[e] = Float64Array.from(sim.x);
        }
        return out;
    };
    // THE TRUTH: the observed model matched on a well-relaxed glass, its past
    // laid down at z = 19 (not the pipeline's z = 9) and evolved.
    const obs = NB.buildInitialConditions({ voidProfile: profile, web, table, zObs: Z, radius: R, spacing: 12, refineRadius: Infinity, seed: 7 });
    const gT = RC.buildGlass({ ...cfg, seed: 31, iterations: 120, ...SIM });
    const XT = RC.matchObserved({ glass: gT, observed: { pos: obs.pos, mass: obs.mass, group: obs.group, softening: obs.softening }, ...SIM }).X;
    const truth = evolve(gT, lptICs(gT, XT, 0.05), 0.05);
    const rng = mulberry32(99);
    const pts = [];
    while (pts.length < 500) {
        const p = [(2 * rng() - 1) * R, (2 * rng() - 1) * R, (2 * rng() - 1) * R], r = Math.hypot(...p);
        if (r > 10 && r < 0.9 * R) pts.push(p);
    }
    const fieldOf = (P, gl) => {
        const t = NB.buildTree(P, gl.mass, Int32Array.from({ length: gl.n }, (_, i) => i), { leafSize: 16, hsoft: gl.softening.h });
        const sp = NB.meanSphereForce(gl.radius, rho, gl.softening);
        return pts.map(([x, y, z]) => {
            const b = new Float64Array(3);
            NB.treeForce(t, x, y, z, 0.5, gl.softening, b);
            const r = Math.hypot(x, y, z), s = sp(r) / r;
            return [b[0] - s * x, b[1] - s * y, b[2] - s * z];
        });
    };
    // Relative gravity error, inside R_eff and outside it.
    const score = (F, T) => {
        const acc = [[0, 0], [0, 0]];
        pts.forEach((p, i) => {
            const k = Math.hypot(...p) < rEff ? 0 : 1;
            for (let d = 0; d < 3; d++) { acc[k][0] += (F[i][d] - T[i][d]) ** 2; acc[k][1] += T[i][d] ** 2; }
        });
        return acc.map(([e, t]) => Math.sqrt(e / t));
    };
    const tF = Object.fromEntries(EP.map((e) => [e, fieldOf(truth[e], gT)]));
    const observedTruth = { pos: truth[A_OBS], mass: gT.mass, group: new Uint8Array(gT.n), softening: [gT.softening, NB.plummer(1)] };
    // The forward model's data: the truth's field today at seeded points; its
    // noise: the two glasses' grain there (plan §4l).
    const P = FM.dataPoints({ radius: R, n: 8000, seed: 2026 });
    const field = FM.fieldAtPoints({ sources: [{ pos: truth[A_OBS], mass: gT.mass, softening: gT.softening }], radius: R, points: P, meanSoftening: gT.softening });
    const grain = (gl) => FM.rmsVector(FM.fieldAtPoints({ sources: [{ pos: gl.pos, mass: gl.mass, softening: gl.softening }], radius: R, points: P, meanSoftening: gl.softening }));
    let fitInfo = null;
    const recover = (glassOpts, { forward = false } = {}) => {
        const gB = RC.buildGlass({ ...cfg, seed: 23, ...SIM, ...glassOpts });
        const X = RC.matchObserved({ glass: gB, observed: observedTruth, ...SIM }).X;
        let ic = lptICs(gB, X, 0.1);
        if (forward) {
            const vol = Float64Array.from(gB.mass, (m) => m / rho), hs = Float64Array.from(gB.mass, () => h);
            const g = lptGrowth(0.1, A_OBS);
            const inv = invert2LPT(gB.pos, X.map((v, k) => v - gB.pos[k]), { d2Obs: g.d2Obs, iterations: 4, volume: vol, hsoft: hs, h, ...SIM });
            const s1 = deconvolveGrowth(gB.pos, inv.s1, vol, deconvolutionKernel({ h, aInit: 0.1, aObs: A_OBS, kappa: 3 }));
            const fit = FM.forwardModelFit({
                glass: gB, s1, aInit: 0.1, aObs: A_OBS, data: { points: P, field }, noise: Math.hypot(grain(gB), grain(gT)),
                config: RC.RECON_CONFIG.forwardModel, sim: SIM,
            });
            fitInfo = fit;
            ic = lptState(gB.pos, fit.s1, fit.s2, 0.1, g);
        }
        const sn = evolve(gB, ic, 0.1);
        return Object.fromEntries(EP.map((e) => [e, score(fieldOf(sn[e], gB), tF[e])]));
    };
    const now = recover({}), old = recover({ rate: 0.7 }), fwd = recover({}, { forward: true });
    const z9 = now[0.1], z4 = now[0.2], z0 = now[A_OBS];
    assert.ok(z9[0] < 0.07 && z9[1] < 0.2 && z4[0] < 0.045 && z0[0] < 0.025 && z0[1] < 0.07, `past: ${JSON.stringify(now)}`);
    assert.ok(z9[0] < old[0.1][0] && z9[1] < old[0.1][1], `glass schedule at z = 9: ${z9} vs fixed ${old[0.1]}`);
    // The Bayesian forward model (plan §4l) must improve the PAST, not just
    // today's fit: every epoch, both regions, against the truth.
    for (const e of EP) for (const k of [0, 1]) assert.ok(fwd[e][k] < now[e][k], `forward model at a = ${e}, region ${k}: ${fwd[e][k]} vs ${now[e][k]}`);
    const m = fitInfo.history.map((x) => x.misfit);
    for (let i = 1; i < m.length; i++) assert.ok(m[i] < m[i - 1], `forward-model misfit must fall: ${m}`);
    const pc = (v) => `${(100 * v[0]).toFixed(1)} / ${(100 * v[1]).toFixed(1)} %`;
    ok(`the past, against a planted truth (z = 19 start, reconstructed from its last frame only): gravity inside / `
        + `outside R_eff recovered to ${pc(z9)} at z = 9, ${pc(z4)} at z = 4, ${pc(z0)} today `
        + `(the fixed-rate glass: ${pc(old[0.1])} at z = 9)`);
    ok(`the Bayesian forward model on top: ${m.length - 1} Gauss–Newton steps take the misfit to today's field `
        + `${(100 * m[0]).toFixed(1)} → ${(100 * m[m.length - 1]).toFixed(1)} % (χ²_ν ${fitInfo.chi2.toFixed(2)}, stopped by ${fitInfo.stoppedBy}) and `
        + `the recovered past to ${pc(fwd[0.1])} at z = 9, ${pc(fwd[0.2])} at z = 4, ${pc(fwd[A_OBS])} today`);
}

console.log(`\n${passed} checks passed — js/bootes-reconstruct.js`);
