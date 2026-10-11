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
 *  Nonlinear mode (the default):
 *   8. The shell table reproduces the EXACT Ωm = 1 parametric solution, and
 *      its linear limit; Bernardeau's closed form is MEASURED against it (so
 *      a "simplification" back to the formula fails here).
 *   9. At z_obs a nonlinear track sits where the galaxy is observed, feels
 *      exactly the probe's force, and its local δ from shell spacing IS the
 *      profile's δ (mass conservation).
 *  10. a·dx/dt of the nonlinear path IS its reported velocity; the outflow
 *      beats linear theory inside the void; the paths CURVE (linear ones are
 *      exactly straight).
 *  11. The bulk motion equals the per-galaxy motion.
 *  12. Shell crossing: never in the void interior; fires inside a thin dense
 *      wall, EARLIER without dark energy (Λ stalls the growth that drives it).
 */

import assert from 'node:assert/strict';

import {
    hubbleKmsMpc, hubbleSI, GYR_S, createVoidProfile, growthFactor, buildProfile, COSMOLOGY,
} from '../js/bootes-void-model.js';
import { createCosmicWeb } from '../js/bootes-web-model.js';
import { voidRedshift, resolvedAnchors } from '../js/bootes-void-data.js';
import { probeAt, toKmsPerGyr } from '../js/bootes-force-probe.js';
import {
    cosmicTimeAtA, cosmicTimeGyr, scaleFactorAtTime, epochScalings, epochAt,
    buildTimeline, trackGalaxy, displacementField, displacedPositions, positionAt,
    KMS_TO_MPC_PER_GYR, shellTable, bernardeauDeltaNL, bulkMotion,
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
    const tr = trackGalaxy([0.45 * rEff, 0.2 * rEff, -0.1 * rEff], { voidProfile: profile, web, zObs: Z, timeline: tl, mode: 'linear' });
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
    const tr = trackGalaxy(x, { voidProfile: profile, web, zObs: Z, timeline: tl, mode: 'linear' });
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
    const tr = trackGalaxy([0.5 * rEff, 0, 0], { voidProfile: profile, web, zObs: Z, timeline: tl, mode: 'linear' });
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
        const tr = trackGalaxy(p, { voidProfile: profile, web, zObs: Z, timeline: tl, mode: 'linear' });
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

// ── 8. The shell table ──────────────────────────────────────────────────────
const table = shellTable({ zObs: Z });
{
    const eds = { ...COSMOLOGY, omegaM: 1, omegaLambda: 0 };
    const te = shellTable({ zObs: 0, cosmo: eds });
    let worst = 0;
    for (const th of [0.5, 1, 2, 3, 4]) {
        // Underdense parametric solution (Ωm = 1): exact.
        const S = Math.sinh(th) - th;
        const C = Math.cosh(th) - 1;
        const dL = -(3 / 20) * Math.pow(6 * S, 2 / 3);
        const dNL = 4.5 * S * S / (C ** 3) - 1;
        worst = Math.max(worst, Math.abs((1 + te.state(dL, 1).deltaNL) / (1 + dNL) - 1));
    }
    assert.ok(worst < 2e-3, `shell table vs the exact Ωm = 1 solution: worst (1+Δ) error ${worst}`);
    // Linear limit at every epoch: Δ_NL → Δ_L·D/D_obs for small amplitude.
    for (const t of [3, 8, cosmicTimeGyr(Z), 18]) {
        const ep = epochAt(t, Z);
        const tiny = -0.01;
        const got = table.state(tiny, ep.a).deltaNL;
        assert.ok(Math.abs(got / (tiny * ep.D) - 1) < 0.01, `linear limit at t=${t}: ${got} vs ${tiny * ep.D}`);
    }
    // Inversion round-trips at z_obs.
    for (const d of [-0.05, -0.3, -0.6, -0.85]) {
        const L = table.invert(d);
        assert.ok(Math.abs(table.state(L, 1 / (1 + Z)).deltaNL - d) < 1e-6, `invert(${d})`);
    }
    // Bernardeau's ν = 3/2 form, measured: close near zero, off by >1 % past
    // Δ_L = −1. If the table were silently replaced by the formula, this fails.
    const aObs = 1 / (1 + Z);
    const err = (L) => Math.abs((1 + bernardeauDeltaNL(L)) / (1 + table.state(L, aObs).deltaNL) - 1);
    assert.ok(err(-0.2) < 0.003, `Bernardeau near Δ_L = −0.2: ${err(-0.2)}`);
    assert.ok(err(-1) > 0.005 && err(-5) > 0.03, `Bernardeau should be measurably off deep in the void: ${err(-1)}, ${err(-5)}`);
    ok(`shell ODE matches the exact Ωm = 1 solution to ${worst.toExponential(1)}; Bernardeau is off ${(err(-1) * 100).toFixed(1)} % at Δ_L = −1, ${(err(-5) * 100).toFixed(1)} % at −5`);
}

// ── 9. Nonlinear at z_obs ───────────────────────────────────────────────────
const tlNL = buildTimeline({ zObs: Z, samples: 50 });
const nlOpts = { voidProfile: profile, web, zObs: Z, timeline: tlNL, table };
{
    const epObs = epochAt(cosmicTimeGyr(Z), Z);
    for (const x of [[5, 3, 1], [0.4 * rEff, 0.2 * rEff, 0], [0.9 * rEff, -0.3 * rEff, 0.2 * rEff], [1.6 * rEff, 0, 0]]) {
        const tr = trackGalaxy(x, nlOpts);
        assert.equal(tr.mode, 'nonlinear');
        const s = tr.at(epObs);
        const pr = probeAt(x, { voidProfile: profile, web, z: Z });
        assert.ok(Math.hypot(...s.positionMpc.map((c, i) => c - x[i])) < 1e-4, `position at z_obs (${x})`);
        assert.ok(rel(s.gA, toKmsPerGyr(pr.forces.A.magnitude)) < 1e-6, `g at z_obs: ${s.gA} vs probe`);
        assert.ok(Math.abs(s.voidShare - pr.voidShare) < 1e-6, 'void share at z_obs');
        const r = Math.hypot(...x);
        assert.ok(Math.abs(s.delta - profile.deltaAt(r)) < 2e-3, `local δ from shell spacing at r=${r}: ${s.delta} vs ${profile.deltaAt(r)}`);
        assert.ok(Math.abs(s.deltaEnclosed - profile.integratedAt(r)) < 1e-6, 'Δ(<r) at z_obs');
    }
    ok('at z_obs the nonlinear track is where the galaxy is, with the probe\'s force and the profile\'s own δ and Δ');
}

// ── 10. Derivative, outflow, curvature ──────────────────────────────────────
{
    const x = [0.45 * rEff, 0.2 * rEff, -0.1 * rEff];
    const tr = trackGalaxy(x, nlOpts);
    let worst = 0;
    for (const t of [4, 9, cosmicTimeGyr(Z), 15]) {
        const h = 2e-3;
        const pp = tr.at(epochAt(t + h, Z)).positionMpc;
        const pm = tr.at(epochAt(t - h, Z)).positionMpc;
        const ep = epochAt(t, Z);
        const fd = pp.map((c, i) => (c - pm[i]) / (2 * h) * ep.a / KMS_TO_MPC_PER_GYR);
        worst = Math.max(worst, rel(Math.hypot(...fd), tr.at(ep).vKms));
    }
    // The table is bilinear in ln a, so its y' and the slope of its own
    // interpolant differ at O(grid); 0.5 % is that, measured at 0.25 %.
    assert.ok(worst < 5e-3, `a·dx/dt vs reported speed, nonlinear: worst ${worst}`);

    const lin = trackGalaxy(x, { ...nlOpts, mode: 'linear' });
    const epObs = epochAt(cosmicTimeGyr(Z), Z);
    assert.ok(tr.at(epObs).vKms > lin.at(epObs).vKms * 1.03,
        `nonlinear outflow must beat linear inside the void: ${tr.at(epObs).vKms} vs ${lin.at(epObs).vKms}`);

    // Straightness: max distance of the path from its own chord.
    const bend = (track) => {
        const P = track.samples.map(q => q.positionMpc);
        const a = P[0], b = P[P.length - 1];
        const ab = b.map((c, i) => c - a[i]);
        const L = Math.hypot(...ab);
        let m = 0;
        for (const p of P) {
            const ap = p.map((c, i) => c - a[i]);
            const cr = [ap[1] * ab[2] - ap[2] * ab[1], ap[2] * ab[0] - ap[0] * ab[2], ap[0] * ab[1] - ap[1] * ab[0]];
            m = Math.max(m, Math.hypot(...cr) / L);
        }
        return m;
    };
    const xw = [0.85 * rEff, -0.35 * rEff, 0.25 * rEff];             // near the lumpy wall
    const bNL = bend(trackGalaxy(xw, nlOpts));
    const bLin = bend(trackGalaxy(xw, { ...nlOpts, mode: 'linear' }));
    assert.ok(bLin < 1e-9, `linear paths are straight lines: ${bLin}`);
    // The bow is REAL BUT SMALL (measured ~6 kpc over ~10 Mpc of travel):
    // shell expansion and the linear web drift grow on similar clocks, so
    // their sum stays close to a line. Gate it at 1 kpc — ten thousand times
    // the linear mode's exactly-zero — and quote it honestly on the page.
    assert.ok(bNL > 1e-3, `nonlinear paths curve near the wall: ${bNL} Mpc`);
    ok(`nonlinear a·dx/dt = v to ${worst.toExponential(1)}; outflow +${((tr.at(epObs).vKms / lin.at(epObs).vKms - 1) * 100).toFixed(0)} % over linear; path bows ${(bNL * 1000).toFixed(1)} kpc (linear: straight)`);
}

// ── 11. Bulk = per-galaxy ───────────────────────────────────────────────────
{
    const pts = [[12, -4, 7], [0.7 * rEff, 0.3 * rEff, -0.2 * rEff], [-1.2 * rEff, 0.4 * rEff, 0]];
    const bulk = bulkMotion(pts, { voidProfile: profile, web, zObs: Z, table });
    for (const t of [2, 9, 17]) {
        const ep = epochAt(t, Z);
        const out = bulk.positionsAt(ep);
        pts.forEach((p, i) => {
            const want = trackGalaxy(p, nlOpts).at(ep).positionMpc;
            for (let k = 0; k < 3; k++) assert.ok(Math.abs(out[i * 3 + k] - want[k]) < 1e-3, `bulk ≠ track at t=${t}`);
        });
    }
    ok('the stage\'s bulk nonlinear motion equals each galaxy\'s own track');
}

// ── 12. Shell crossing ──────────────────────────────────────────────────────
{
    const tl = buildTimeline({ zObs: Z, samples: 40 });
    // The page's own void: no shell crosses anywhere in the window.
    for (const r of [10, 40, 70, 85, 92, 100, 130]) {
        const tr = trackGalaxy([r, 0, 0], { ...nlOpts, timeline: tl });
        assert.ok(!tr.samples.some(q => q.shellCrossed), `unexpected crossing at r=${r}`);
    }
    // A void bounded by a thin dense wall: the wall's shells DO cross.
    const walled = buildProfile(r => (r < 50 ? -0.8 : (r < 51 ? 3 : 0)),
        { deltaC: -0.8, rsMpc: 50, rvMpc: 50, alpha: 2, beta: 9 });
    const firstCross = (cosmo, zObs, tEnd, aMax) => {
        const tab = shellTable({ zObs, cosmo, aMax });
        const tlx = buildTimeline({ zObs, samples: 80, tEndGyr: tEnd, cosmo });
        const w = createCosmicWeb({ voidProfile: walled, z: zObs, clumpiness: 0, cosmo });
        const inWall = trackGalaxy([50.5, 0, 0], { voidProfile: walled, web: w, zObs, timeline: tlx, table: tab, cosmo });
        const inside = trackGalaxy([45, 0, 0], { voidProfile: walled, web: w, zObs, timeline: tlx, table: tab, cosmo });
        assert.ok(!inside.samples.some(q => q.shellCrossed), 'the void interior never crosses');
        const i = inWall.samples.findIndex(q => q.shellCrossed);
        return i < 0 ? null : inWall.samples[i].a ?? tlx.epochs[i].a;
    };
    const aLCDM = firstCross(COSMOLOGY, Z, 19.8, 2.2);
    const aEdS = firstCross({ ...COSMOLOGY, omegaM: 1, omegaLambda: 0 }, 0, 30, 4);
    assert.ok(aEdS != null, 'the wall\'s shells must cross in an Ωm = 1 universe');
    assert.ok(aLCDM == null || aLCDM > aEdS, `Λ must delay the crossing: ΛCDM a=${aLCDM}, EdS a=${aEdS}`);
    ok(`shell crossing: none in the page's void; a thin wall crosses at a = ${aEdS.toFixed(2)} with Ωm = 1, `
        + (aLCDM == null ? 'not within the window in ΛCDM' : `a = ${aLCDM.toFixed(2)} in ΛCDM`));
}

console.log(`\n${passed} checks passed — js/bootes-void-tracker.js`);
