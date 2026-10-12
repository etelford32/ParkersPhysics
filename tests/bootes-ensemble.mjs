#!/usr/bin/env node
/**
 * bootes-ensemble.mjs — gate for js/bootes-ensemble.js, the posterior
 * ensemble of reconstructed pasts (BOOTES_VOID_PLAN.md §4m).
 *
 * Run: node tests/bootes-ensemble.mjs        (~4 min)
 *
 *   1. THE STATISTICS: mean and unbiased spread in closed form; members that
 *      disagree on their points are refused.
 *   2. THE CALIBRATION METRIC on draws whose answer is known: an ensemble
 *      drawn from the truth's own distribution scores R ≈ 1 and ~68 %
 *      coverage; an UNDER-dispersed one (its draws halved — the negative
 *      control) scores R ≈ 2 and fails.
 *   3. THE PIPELINE, end to end on a planted twin: N reconstructRun members,
 *      each with its own glass and its own draw of the target's grain, from
 *      the last frame of a known history. The ensemble MEAN must beat one
 *      member at every epoch. The SPREAD samples the discreteness noise only,
 *      so it is a LOWER BOUND on the error, and at this gate's coarser
 *      resolution (h = 28 Mpc) the method's own resolution-limited bias —
 *      common to every member, so no resampling can see it — makes the truth
 *      miss the mean by 1.4–3× the spread (plan §4m; at the page's scale it
 *      is 0.9–1.3×). That SHORTFALL is gated on purpose, the TIGA rule: it
 *      must be ≥ 1 (an over-dispersed ensemble is a bug too) and inside the
 *      recorded band, so a change that moves it must update the record —
 *      and "fixing" it by widening the spread fails.
 */

import assert from 'node:assert/strict';

import { meanMatterDensityMsunMpc3 } from '../js/bootes-void-model.js';
import { mulberry32, createCosmicWeb } from '../js/bootes-web-model.js';
import {
    PROFILE_PRESETS, DEFAULT_BIAS, voidRedshift, effectiveRadiusMpc, resolvedAnchors,
} from '../js/bootes-void-data.js';
import { createVoidProfile, matterContrastFromGalaxy } from '../js/bootes-void-model.js';
import { shellTable } from '../js/bootes-void-tracker.js';
import * as NB from '../js/bootes-nbody.js';
import * as RC from '../js/bootes-reconstruct.js';
import * as FM from '../js/bootes-forward-model.js';
import * as EN from '../js/bootes-ensemble.js';
import { invert2LPT, lptGrowth, lptState, secondOrderDisplacement } from '../js/bootes-lpt.js';
import { deconvolutionKernel, deconvolveGrowth } from '../js/bootes-softgrowth.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

// ── 1. The statistics ───────────────────────────────────────────────────────
{
    const a = Float64Array.from([1, 2, 3, 4, 5, 6]);
    const same = EN.ensembleStats([a, a, a]);
    assert.ok(same.mean.every((v, k) => v === a[k]) && same.variance.every((v) => v === 0), 'identical members');
    const d = 0.5;
    const lo = a.map((v) => v - d), hi = a.map((v) => v + d);
    const two = EN.ensembleStats([lo, hi]);
    // Unbiased (N − 1 = 1): each component contributes (d² + d²)/1, three per point.
    assert.ok(two.mean.every((v, k) => Math.abs(v - a[k]) < 1e-15) && two.variance.every((v) => Math.abs(v - 6 * d * d) < 1e-12),
        `two members: ${two.variance}`);
    // The coverage threshold: F(3, ∞) is χ²₃/3 (68.27 % at 1.1756) and F(2, 2)'s median is exactly 1.
    assert.ok(Math.abs(EN.fQuantile(0.6827, 3, 1e7) - 1.1756) < 2e-4 && Math.abs(EN.fQuantile(0.5, 2, 2) - 1) < 1e-9,
        'F quantiles');
    assert.throws(() => EN.ensembleStats([a]), /two members/);
    assert.throws(() => EN.ensembleStats([a, a.subarray(0, 3)]), /disagree/);
    ok('the statistics: mean and unbiased spread in closed form; F quantiles hit χ²₃/3 at large dof and F(2, 2)\'s median of 1; one member, or members on different points, are refused');
}

// ── 2. The calibration metric ───────────────────────────────────────────────
{
    const rng = mulberry32(17);
    const gauss = () => { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); };
    const n = 20000, N = 4, sigma = 3;
    const mu = Float64Array.from({ length: 3 * n }, () => 10 * gauss());
    const truth = mu.map((v) => v + sigma * gauss());
    const draws = (scale) => Array.from({ length: N }, () => mu.map((v) => v + scale * sigma * gauss()));
    const good = EN.calibration(draws(1), truth, () => 'all').all;
    const tight = EN.calibration(draws(0.5), truth, () => 'all').all;
    assert.ok(Math.abs(good.ratio - 1) < 0.03 && Math.abs(good.coverage - 0.68) < 0.02, `calibrated: ${JSON.stringify(good)}`);
    assert.ok(tight.ratio > 1.7 && tight.coverage < 0.35, `under-dispersed control: ${JSON.stringify(tight)}`);
    ok(`the calibration metric: draws from the truth's own distribution score R = ${good.ratio.toFixed(3)}, `
        + `coverage ${(100 * good.coverage).toFixed(1)} % (68 % is calibrated); the negative control with its draws halved `
        + `scores R = ${tight.ratio.toFixed(2)}, coverage ${(100 * tight.coverage).toFixed(0)} %`);
}

// ── 3. The pipeline on a planted twin ───────────────────────────────────────
{
    const t0 = Date.now();
    const Z = voidRedshift(), A_OBS = 1 / (1 + Z);
    const rEff = effectiveRadiusMpc();
    const rho = meanMatterDensityMsunMpc3();
    const SIM = NB.PAGE_CONFIG.sim;
    const preset = PROFILE_PRESETS['hsw-supervoid'];
    const profile = createVoidProfile({
        deltaC: matterContrastFromGalaxy(preset.centralGalaxyContrast, DEFAULT_BIAS),
        rvMpc: rEff, rsMpc: rEff * preset.rsFraction, alpha: preset.alpha, beta: preset.beta,
    });
    const web = createCosmicWeb({ voidProfile: profile, anchors: resolvedAnchors(), seed: 20260907, clumpiness: 0.65, z: Z });
    const table = shellTable({ zObs: Z });
    const R = 1.6 * rEff, cfg = { radius: R, spacing: 14, refineRadius: Infinity }, h = 28;
    const recon = { ...RC.RECON_CONFIG, stepsAfterObs: 2, testShots: 1 };
    // THE TRUTH: the observed model matched on a well-relaxed glass, its 2LPT
    // past laid down at z = 19 and run forward (as tests/bootes-reconstruct.mjs
    // check 10), with snapshots at the reconstruction's own three epochs.
    const obs = NB.buildInitialConditions({ voidProfile: profile, web, table, zObs: Z, radius: R, spacing: 12, refineRadius: Infinity, seed: 7 });
    const gT = RC.buildGlass({ ...cfg, seed: 31, iterations: 120, ...SIM });
    const XT = RC.matchObserved({ glass: gT, observed: { pos: obs.pos, mass: obs.mass, group: obs.group, softening: obs.softening }, ...SIM }).X;
    const vol = Float64Array.from(gT.mass, (m) => m / rho), hs = Float64Array.from(gT.mass, () => h);
    const gz = lptGrowth(0.05, A_OBS);
    const inv = invert2LPT(gT.pos, XT.map((v, k) => v - gT.pos[k]), { d2Obs: gz.d2Obs, iterations: 4, volume: vol, hsoft: hs, h, ...SIM });
    const s1T = deconvolveGrowth(gT.pos, inv.s1, vol, deconvolutionKernel({ h, aInit: 0.05, aObs: A_OBS, kappa: 3 }));
    const icT = lptState(gT.pos, s1T, secondOrderDisplacement(gT.pos, s1T, { volume: vol, hsoft: hs, h, ...SIM }), 0.05, gz);
    const rng = mulberry32(99);
    const pts = [];
    while (pts.length < 3 * 600) {
        const p = [(2 * rng() - 1) * R, (2 * rng() - 1) * R, (2 * rng() - 1) * R], r = Math.hypot(...p);
        if (r > 10 && r < 0.9 * R) pts.push(...p);
    }
    const testPoints = Float64Array.from(pts);
    const aEnd = A_OBS * 1.02;
    // The members' three epochs (the schedule is the same for every member).
    const probe = RC.concatSchedules(
        NB.buildSchedule({ aStart: recon.aInit, aEnd: A_OBS, steps: recon.stepsToObs }),
        NB.buildSchedule({ aStart: A_OBS, aEnd, steps: recon.stepsAfterObs }));
    let near = 0;
    for (let f = 1; f < probe.a.length; f++) if (Math.abs(probe.a[f] - 0.2) < Math.abs(probe.a[near] - 0.2)) near = f;
    const EP = [probe.a[0], probe.a[near], probe.a[probe.obsFrame]];
    const truthSim = NB.createSimulation({
        pos: icT.pos, vel: icT.vel, mass: gT.mass, group: new Uint8Array(gT.n), nMassive: gT.n, aStart: 0.05,
        softening: [gT.softening, gT.softening], background: { radius: R, rho }, ...SIM,
    });
    const truthF = [];
    let a = 0.05;
    for (const e of EP) {
        const sch = NB.buildSchedule({ aStart: a, aEnd: e, steps: Math.max(3, Math.round(13 * Math.log(e / a))) });
        for (let s = 0; s < sch.steps; s++) truthSim.step(sch, s);
        a = e;
        truthF.push(FM.fieldAtPoints({ sources: [{ pos: Float64Array.from(truthSim.x), mass: gT.mass, softening: gT.softening }],
            radius: R, points: testPoints, meanSoftening: gT.softening, ...SIM }));
    }
    const observed = { pos: Float64Array.from(truthSim.x), mass: gT.mass, group: new Uint8Array(gT.n), softening: [gT.softening, NB.plummer(1)] };
    // The target's grain on the data: the truth glass's own, at the members' data points.
    const P = FM.dataPoints({ radius: R, n: recon.forwardModel.points, seed: recon.forwardModel.pointSeed });
    const targetNoise = FM.rmsVector(FM.fieldAtPoints({ sources: [{ pos: gT.pos, mass: gT.mass, softening: gT.softening }],
        radius: R, points: P, meanSoftening: gT.softening, ...SIM }));
    const N = EN.ENSEMBLE_CONFIG.members;
    const members = [];
    for (let k = 1; k <= N; k++) {
        const run = RC.reconstructRun({
            observed, config: cfg, testPoints, aObs: A_OBS, aEnd, sim: SIM, recon, targetNoise,
            member: EN.memberSeeds(k),
        });
        assert.ok(run.past.a.every((v, i) => Math.abs(v - EP[i]) < 1e-12), `member epochs ${run.past.a} vs ${EP}`);
        assert.ok(run.diagnostics.member.glassSeed === EN.memberSeeds(k).glassSeed && run.diagnostics.forwardModel.noiseDraw > 0);
        members.push(run.past.fields);
    }
    const regionOf = (i) => (Math.hypot(testPoints[3 * i], testPoints[3 * i + 1], testPoints[3 * i + 2]) < rEff ? 'in' : 'out');
    const scores = EP.map((_, e) => EN.calibration(members.map((m) => m[e]), truthF[e], regionOf));
    if (process.env.DEBUG) console.log(JSON.stringify(scores, null, 1), (Date.now() - t0) / 1000);
    // Measured 2026-10-12: R = 1.37 / 1.45 (z = 9), 1.62 / 1.87 (z ≈ 4), 1.76 / 3.11 (today), inside / outside.
    const BAND = { in: [1.0, 2.3], out: [1.0, 3.8] };
    for (const sc of scores) {
        for (const reg of ['in', 'out']) {
            const s = sc[reg];
            assert.ok(s.ratio >= BAND[reg][0] && s.ratio <= BAND[reg][1], `shortfall ${reg}: ${JSON.stringify(s)}`);
            assert.ok(s.mean < s.single, `the mean must beat one member (${reg}): ${JSON.stringify(s)}`);
        }
    }
    const f = (s) => `R ${s.in.ratio.toFixed(2)} / ${s.out.ratio.toFixed(2)}, cover ${(100 * s.in.coverage).toFixed(0)} / ${(100 * s.out.coverage).toFixed(0)} %`;
    ok(`the pipeline on a planted twin: ${N} reconstructRun members, each with its own glass and its own draw of the target's `
        + `grain; the spread is a LOWER BOUND, the truth missing the mean by — z = 9 ${f(scores[0])}; z ≈ 4 ${f(scores[1])}; today ${f(scores[2])} `
        + `(inside / outside R_eff; R = 1 is calibrated, gated inside the recorded band); the mean beats one member everywhere (z = 9: ${(100 * scores[0].in.single).toFixed(1)} → `
        + `${(100 * scores[0].in.mean).toFixed(1)} % inside, ${(100 * scores[0].out.single).toFixed(1)} → ${(100 * scores[0].out.mean).toFixed(1)} % outside)`);
}

console.log(`\n${passed} checks passed — js/bootes-ensemble.js`);
