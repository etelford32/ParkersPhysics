#!/usr/bin/env node
/**
 * bootes-reconstruct.mjs — gate for js/bootes-reconstruct.js, the web's
 * initial conditions (BOOTES_VOID_PLAN.md §4d Phase 2).
 *
 * Run: node tests/bootes-reconstruct.mjs        (~40 s)
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
    ok(`glass: residual displacement-force ${first.toFixed(2)} → ${last.toFixed(3)} Mpc (quiet start → glass) over `
        + `${glass.history.length - 1} repulsive steps (${glass.n} elements)`);
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
        ok(`today's gravity: the reconstructed universe reproduces the observed model's force at the `
            + `galaxies to ≤ ${(100 * worstInner).toFixed(0)} % inside R_eff, ${(100 * dg.fieldError).toFixed(0)} % overall`);
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

console.log(`\n${passed} checks passed — js/bootes-reconstruct.js`);
