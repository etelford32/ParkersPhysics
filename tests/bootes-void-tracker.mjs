#!/usr/bin/env node
/**
 * bootes-void-tracker.mjs — gate for js/bootes-void-tracker.js.
 *
 * Run: node tests/bootes-void-tracker.mjs
 *
 * Identities and limits only:
 *   1. The cosmic clock: dt/da = 1/(aH) by finite difference; t ↔ a round-trips;
 *      t₀ lands on Planck 2018's age to the stated radiation-neglect tolerance.
 *   2. Every scaling is exactly 1 at the observed epoch.
 *   3. Matter-era limits: D ∝ a and physical g ∝ (1+z) — the "pulled harder
 *      when young" result is a limit of the formula, not a tuned curve.
 *   4. The Zel'dovich trajectory's own time derivative IS the velocity the
 *      tracker reports (two independent expressions).
 *   5. At z_obs a tracked galaxy agrees exactly with the force probe on it.
 *   6. Void galaxies stream OUTWARD: r(t) increases.
 *   7. The bulk displacement field equals the per-galaxy ψ.
 */

import assert from 'node:assert/strict';

import {
    hubbleKmsMpc, hubbleSI, GYR_S, createVoidProfile, growthFactor,
} from '../js/bootes-void-model.js';
import { createCosmicWeb } from '../js/bootes-web-model.js';
import { voidRedshift, resolvedAnchors } from '../js/bootes-void-data.js';
import { probeAt, toKmsPerGyr } from '../js/bootes-force-probe.js';
import {
    cosmicTimeAtA, cosmicTimeGyr, scaleFactorAtTime, epochScalings, epochAt,
    buildTimeline, trackGalaxy, displacementField, displacedPositions, positionAt,
    KMS_TO_MPC_PER_GYR,
} from '../js/bootes-void-tracker.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);

const Z = voidRedshift();
const profile = createVoidProfile();
const rEff = profile.params.rvMpc;
const web = createCosmicWeb({ voidProfile: profile, anchors: resolvedAnchors(), z: Z });

// ── 1. Clock ────────────────────────────────────────────────────────────────
{
    for (const a of [0.1, 0.5, 0.95, 1, 1.4]) {
        const h = 1e-4 * a;
        const dtda = (cosmicTimeAtA(a + h) - cosmicTimeAtA(a - h)) / (2 * h);
        const expect = 1 / (a * hubbleSI(1 / a - 1)) / GYR_S;
        assert.ok(rel(dtda, expect) < 1e-6, `dt/da at a=${a}: ${dtda} vs ${expect}`);
        assert.ok(rel(scaleFactorAtTime(cosmicTimeAtA(a)), a) < 1e-9, `t↔a round trip at a=${a}`);
    }
    const t0 = cosmicTimeGyr(0);
    // Planck 2018 quotes 13.787 ± 0.020 Gyr INCLUDING radiation; neglecting it
    // makes the universe very slightly older. Allow 0.3 %.
    assert.ok(Math.abs(t0 / 13.787 - 1) < 0.003, `t0 = ${t0} Gyr`);
    const lookback = t0 - cosmicTimeGyr(Z);
    assert.ok(lookback > 0.5 && lookback < 0.9, `light from Boötes left ${lookback} Gyr ago`);
    ok(`dt/da = 1/(aH) to 1e-6; t₀ = ${t0.toFixed(3)} Gyr; Boötes light is ${lookback.toFixed(2)} Gyr old`);
}

// ── 2. Unity at the observed epoch ──────────────────────────────────────────
{
    const s = epochScalings(Z, Z);
    for (const k of ['D', 'gravity', 'tidal', 'velocity']) assert.ok(Math.abs(s[k] - 1) < 1e-12, k);
    ok('every scaling is exactly 1 at z_obs');
}

// ── 3. Matter-era limits ────────────────────────────────────────────────────
{
    const a = epochScalings(30, Z);
    const b = epochScalings(15, Z);
    assert.ok(rel(a.D / b.D, 16 / 31) < 0.01, `D ∝ a in the matter era: ${a.D / b.D} vs ${16 / 31}`);
    assert.ok(rel(a.gravity / b.gravity, 31 / 16) < 0.01,
        `physical peculiar g ∝ (1+z) in the matter era: ${a.gravity / b.gravity} vs ${31 / 16}`);
    // So the void's pull WAS stronger early on, and the velocity grows.
    assert.ok(epochScalings(3, Z).gravity > 1, 'g at z=3 exceeds g at z_obs');
    assert.ok(epochScalings(3, Z).velocity < 1, 'the outflow was slower at z=3');
    assert.ok(epochScalings(3, Z).D < 1, 'the void was shallower at z=3');
    // Λ freezes growth: D grows less from now to +6 Gyr than over the last 6.
    const t0 = cosmicTimeGyr(0);
    const D = (t) => epochAt(t, Z).D;
    assert.ok(D(t0 + 6) - D(t0) < D(t0) - D(t0 - 6), 'dark energy slows growth');
    void growthFactor;
    ok('matter era: D ∝ a and g ∝ (1+z) to 1 % — the void pulled hardest when it was shallowest');
}

// ── 4. Trajectory derivative = reported velocity ────────────────────────────
{
    const tl = buildTimeline({ zObs: Z, samples: 40 });
    const tr = trackGalaxy([0.45 * rEff, 0.2 * rEff, -0.1 * rEff], { voidProfile: profile, web, zObs: Z, timeline: tl });
    for (const t of [4, 9, cosmicTimeGyr(Z), 15]) {
        const h = 1e-3;
        const pp = positionAt(tr.xObs, tr.psi, epochAt(t + h, Z).D);
        const pm = positionAt(tr.xObs, tr.psi, epochAt(t - h, Z).D);
        const ep = epochAt(t, Z);
        // comoving Mpc/Gyr × a → physical Mpc/Gyr → km/s
        const vFd = Math.hypot(pp[0] - pm[0], pp[1] - pm[1], pp[2] - pm[2]) / (2 * h) * ep.a / KMS_TO_MPC_PER_GYR;
        const vRep = tr.at(ep).vKms;
        assert.ok(rel(vFd, vRep) < 1e-4, `t=${t}: dx/dt·a = ${vFd} km/s vs reported ${vRep}`);
    }
    ok('a·dx/dt of the Zel\'dovich path equals the reported peculiar velocity to 1e-4');
}

// ── 5. Agreement with the probe at z_obs ────────────────────────────────────
{
    const tl = buildTimeline({ zObs: Z, samples: 10 });
    const x = [-0.3 * rEff, 0.55 * rEff, 0.2 * rEff];
    const tr = trackGalaxy(x, { voidProfile: profile, web, zObs: Z, timeline: tl });
    const s = tr.at(epochAt(cosmicTimeGyr(Z), Z));
    const pr = probeAt(x, { voidProfile: profile, web, z: Z });
    assert.ok(Math.hypot(...s.positionMpc.map((c, i) => c - x[i])) < 1e-6, 'position at z_obs');
    assert.ok(rel(s.gA, toKmsPerGyr(pr.forces.A.magnitude)) < 1e-6, 'g at z_obs');
    assert.ok(rel(s.vKms, pr.velocity.A.magnitude) < 1e-6, 'v at z_obs');
    ok('at z_obs a tracked galaxy reads exactly what the force probe reads there');
}

// ── 6. Void galaxies stream outward ─────────────────────────────────────────
{
    const tl = buildTimeline({ zObs: Z, samples: 60 });
    const tr = trackGalaxy([0.5 * rEff, 0, 0], { voidProfile: profile, web, zObs: Z, timeline: tl });
    const r = tr.samples.map(s => s.rMpc);
    for (let i = 1; i < r.length; i++) assert.ok(r[i] >= r[i - 1] - 1e-9, `r must not fall: ${r[i - 1]} → ${r[i]}`);
    assert.ok(r[0] < r[r.length - 1], 'a void galaxy ends further out than it started');
    // The physical pull on it falls over cosmic time (matter-era g ∝ 1+z, then Λ).
    assert.ok(tr.samples[0].gA > tr.samples[tr.samples.length - 1].gA, 'g fell over cosmic time');
    // And δ at its position deepens.
    assert.ok(tr.samples[tr.samples.length - 1].delta < tr.samples[0].delta, 'the void deepens around it');
    ok(`a galaxy at 0.5 R_eff drifts ${r[0].toFixed(1)} → ${r[r.length - 1].toFixed(1)} Mpc; its pull falls while the void deepens`);
}

// ── 7. Bulk displacement field ──────────────────────────────────────────────
{
    const tl = buildTimeline({ zObs: Z, samples: 5 });
    const pts = [[10, 20, -5], [0.8 * rEff, 0.1 * rEff, 0.3 * rEff], [-1.5 * rEff, 0, 0.2 * rEff]];
    const psi = displacementField(pts, { voidProfile: profile, web, zObs: Z });
    pts.forEach((p, i) => {
        const tr = trackGalaxy(p, { voidProfile: profile, web, zObs: Z, timeline: tl });
        for (let k = 0; k < 3; k++) {
            assert.ok(Math.abs(psi[i * 3 + k] - tr.psi[k]) <= 1e-9 * Math.hypot(...tr.psi) + 1e-12, 'ψ mismatch');
        }
    });
    const out = displacedPositions(pts, psi, 0.5);
    const want = positionAt(pts[1], [psi[3], psi[4], psi[5]], 0.5);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(out[3 + k] - want[k]) < 1e-4);
    void hubbleKmsMpc;
    ok('the bulk displacement field equals each galaxy\'s own ψ');
}

console.log(`\n${passed} checks passed — js/bootes-void-tracker.js`);
