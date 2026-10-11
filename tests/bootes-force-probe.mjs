#!/usr/bin/env node
/**
 * bootes-force-probe.mjs — gate for js/bootes-force-probe.js.
 *
 * Run: node tests/bootes-force-probe.mjs
 *
 * The probe adds up what the two existing kernels say, so every check here is
 * an IDENTITY against those kernels — never a remembered number. If the probe
 * and the kernels ever disagree about the same quantity, the reader sees two
 * different answers on one page (the probe card and the Test 4 chart), and
 * nothing would throw.
 *
 *   1. The probe's one-pass web sum IS web.externalGravityAt / externalTidalAt.
 *   2. Split identity: void (δ⁻) + smooth wall (δ⁺) = the full profile's field.
 *   3. Contributors partition the particles; Σ vectors = web; Σ shares = 1.
 *   4. Linear velocity of the void term IS radialVelocityKms(..., linear).
 *   5. g_web = −∇Φ_web, and T_web = −∂g/∂x_phys ÷ 4πGρ̄(z), by finite
 *      differences across the probe's own outputs — two independent chains,
 *      with every (1+z) power in play.
 *   6. tr T = δ for the spherical part (Poisson), and the T-web class at the
 *      void centre is 'void'.
 *   7. voidShare matches counterfactualAt — the probe and Test 4 agree.
 *   8. Streamlines run outward in the void's field and stop at a point sink.
 *   9. A z mismatch between web and probe is refused (the (1+z)² scar).
 */

import assert from 'node:assert/strict';

import {
    COSMOLOGY, MPC_M, createVoidProfile, splitProfile, voidGravityVector,
    radialVelocityKms, fourPiGRhoM,
} from '../js/bootes-void-model.js';
import { createCosmicWeb, counterfactualAt } from '../js/bootes-web-model.js';
import { voidRedshift, resolvedAnchors } from '../js/bootes-void-data.js';
import {
    probeAt, webStructures, radialSweep, traceStreamline, twebClass, accelerationField,
    velocityPerAcceleration, toKmsPerGyr, DEFAULT_TWEB_THRESHOLD,
} from '../js/bootes-force-probe.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-300);
const vecRel = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    / Math.max(Math.hypot(...a), Math.hypot(...b), 1e-300);

const Z = voidRedshift();
const anchors = resolvedAnchors();
const profile = createVoidProfile();
const rEff = profile.params.rvMpc;
const { deficit, wall } = splitProfile(profile);
const web = createCosmicWeb({ voidProfile: profile, anchors, seed: 20260907, clumpiness: 0.65, z: Z });
const opts = { voidProfile: profile, web, z: Z, anchors };

// A handful of probe points: centre, inside, on the wall, outside, off-axis.
const POINTS = [
    [0, 0, 0],
    [20, -10, 5],
    [0.6 * rEff, 0.3 * rEff, -0.2 * rEff],
    [rEff * 0.7, -rEff * 0.7, 0.1 * rEff],
    [-1.4 * rEff, 0.2 * rEff, 0.9 * rEff],
    [2.1 * rEff, 0, 0],
];

// ── 1. The inlined web sum is the web kernel ────────────────────────────────
{
    for (const p of POINTS) {
        const pr = probeAt(p, opts);
        assert.ok(vecRel(pr.forces.web.vector, web.externalGravityAt(p)) < 1e-12,
            `web gravity at ${p} disagrees with web.externalGravityAt`);
        const T = web.externalTidalAt(p);
        const err = Math.max(...T.map((v, i) => Math.abs(v - pr.tidal.webTensor[i])))
            / Math.max(...T.map(Math.abs));
        assert.ok(err < 1e-12, `web tidal at ${p} disagrees with web.externalTidalAt (${err})`);
    }
    ok('the probe\'s one-pass web sum equals externalGravityAt and externalTidalAt to 1e-12');
}

// ── 2. Split identity ───────────────────────────────────────────────────────
{
    for (const p of POINTS.slice(1)) {
        const pr = probeAt(p, opts);
        const full = voidGravityVector(p, [0, 0, 0], profile, { z: Z });
        assert.ok(vecRel(pr.forces.smooth.vector, full) < 1e-9,
            `void + smooth wall ≠ full profile at ${p}`);
        // A = void + web and B = web, by construction, and clumping = web − wall.
        const s = pr.forces;
        for (let i = 0; i < 3; i++) {
            assert.ok(Math.abs(s.A.vector[i] - s.void.vector[i] - s.web.vector[i])
                <= 1e-12 * s.A.magnitude + 1e-30, 'A ≠ void + web');
            assert.ok(Math.abs(s.clumping.vector[i] - (s.web.vector[i] - s.wall.vector[i]))
                <= 1e-12 * (s.web.magnitude + s.wall.magnitude) + 1e-30, 'clumping ≠ web − wall');
        }
        // radial² + tangential² = magnitude².
        for (const k of ['void', 'wall', 'web', 'A', 'clumping']) {
            const c = s[k];
            assert.ok(rel(Math.hypot(c.radial, c.tangential), c.magnitude) < 1e-9,
                `${k}: radial/tangential split does not recompose`);
        }
    }
    // The void term is purely radial and points OUTWARD — less pull, not a push.
    const pr = probeAt(POINTS[2], opts);
    assert.ok(pr.forces.void.radial > 0, 'the void term must point away from the centre');
    assert.ok(pr.forces.void.tangential / pr.forces.void.magnitude < 1e-9,
        'the void term must have no tangential part');
    ok('void (δ⁻) + smooth wall (δ⁺) reproduces the full profile; A, B and clumping recompose');
}

// ── 3. Contributors ─────────────────────────────────────────────────────────
{
    const groups = webStructures(web);
    const seen = new Set();
    for (const g of groups) for (const i of g.particles) {
        assert.ok(!seen.has(i), `particle ${i} is in two structures`);
        seen.add(i);
    }
    assert.equal(seen.size, web.particles.length, 'structures must cover every particle');
    assert.ok(!groups.some(g => g.kind === 'other'),
        'every particle should join a node or a filament (an "other" group means the '
        + 'offset-identity join in webStructures broke)');
    assert.equal(groups.filter(g => g.kind === 'node').length, web.nodes.length,
        'one group per model node');
    assert.equal(groups.filter(g => g.kind === 'filament').length, web.filaments.length,
        'one group per filament');
    const mass = groups.reduce((s, g) => s + g.massMsun, 0);
    assert.ok(rel(mass, web.totalMassMsun) < 1e-12, 'structure masses must sum to the web mass');

    for (const p of POINTS) {
        const pr = probeAt(p, opts);
        const sum = pr.contributors.all.reduce((s, c) =>
            [s[0] + c.vector[0], s[1] + c.vector[1], s[2] + c.vector[2]], [0, 0, 0]);
        assert.ok(vecRel(sum, pr.forces.web.vector) < 1e-10, 'Σ contributors ≠ web force');
        const shares = pr.contributors.all.reduce((s, c) => s + c.share, 0);
        assert.ok(Math.abs(shares - 1) < 1e-10, `Σ projected shares = ${shares}, must be 1`);
        assert.ok(pr.checks.contributors < 1e-10 && pr.checks.shares < 1e-10
            && pr.checks.trace < 1e-9, `live identity residuals too large: ${JSON.stringify(pr.checks)}`);
        const top = pr.contributors.top;
        for (let i = 1; i < top.length; i++) {
            assert.ok(top[i - 1].magnitude >= top[i].magnitude, 'top contributors must be ranked');
        }
    }
    ok(`contributors partition ${web.particles.length} particles into ${groups.length} structures; `
        + 'Σ = web force, Σ projected shares = 1');
}

// ── 4. Velocity ─────────────────────────────────────────────────────────────
{
    for (const r of [10, 40, rEff * 0.5, rEff, rEff * 1.6]) {
        const p = [r * 0.6, r * 0.8, 0];
        const pr = probeAt(p, opts);
        const expect = radialVelocityKms(r, deficit, { z: Z, linear: true });
        assert.ok(rel(pr.velocity.void.radial, expect) < 1e-9,
            `linear void velocity at r=${r}: ${pr.velocity.void.radial} vs ${expect}`);
    }
    // Total velocity = the same factor times the total acceleration.
    const pr = probeAt(POINTS[3], opts);
    const k = velocityPerAcceleration(Z) / 1000;
    assert.ok(rel(pr.velocity.A.magnitude, pr.forces.A.magnitude * k) < 1e-12);
    ok('v = 2fg / (3Ωm H) reproduces radialVelocityKms(linear) for the void to 1e-9');
}

// ── 5. g = −∇Φ and T = −∂g/∂x, across the two chains ────────────────────────
{
    // Off any particle, so the softened field is smooth on the stencil.
    const p = [0.83 * rEff, -0.41 * rEff, 0.27 * rEff];
    const h = 0.02;                                       // comoving Mpc
    const dPhys = h * MPC_M / (1 + Z);                    // the stencil in metres, physical
    const unit = fourPiGRhoM(Z);
    const base = probeAt(p, opts);
    const gWeb = base.forces.web.vector;
    let worstG = 0;
    let worstT = 0;
    const tScale = Math.max(...base.tidal.webTensor.map(Math.abs));
    for (let j = 0; j < 3; j++) {
        const pp = [...p]; pp[j] += h;
        const pm = [...p]; pm[j] -= h;
        const Pp = probeAt(pp, opts);
        const Pm = probeAt(pm, opts);
        // Φ is in km²/s².
        const dPhi = (Pp.potential.web - Pm.potential.web) * 1e6 / (2 * dPhys);
        worstG = Math.max(worstG, Math.abs(-dPhi - gWeb[j]) / Math.hypot(...gWeb));
        for (let i = 0; i < 3; i++) {
            const dg = (Pp.forces.web.vector[i] - Pm.forces.web.vector[i]) / (2 * dPhys);
            const T = -dg / unit;
            worstT = Math.max(worstT, Math.abs(T - base.tidal.webTensor[i * 3 + j]) / tScale);
        }
    }
    assert.ok(worstG < 1e-5, `g_web ≠ −∇Φ_web (worst relative error ${worstG})`);
    assert.ok(worstT < 1e-5, `T_web ≠ −∂g/∂x / 4πGρ̄ (worst relative error ${worstT})`);

    // And the void's analytic Φ against its analytic g (radial only, one-sided
    // of the wall kink).
    const r = 0.5 * rEff;
    const q = [r, 0, 0];
    const hr = 0.2;
    const Pp = probeAt([r + hr, 0, 0], opts);
    const Pm = probeAt([r - hr, 0, 0], opts);
    const dPhiV = (Pp.potential.void - Pm.potential.void) * 1e6 / (2 * hr * MPC_M / (1 + Z));
    const gV = probeAt(q, opts).forces.void.radial;
    assert.ok(rel(-dPhiV, gV) < 2e-3, `void g ≠ −dΦ/dr: ${-dPhiV} vs ${gV}`);
    assert.ok(probeAt(q, opts).potential.void > 0, 'a void is a potential HILL: Φ_void > 0');
    ok(`g = −∇Φ (${worstG.toExponential(1)}) and T = −∂g/∂x_phys ÷ 4πGρ̄ `
        + `(${worstT.toExponential(1)}) hold across the probe's own outputs`);
}

// ── 6. Tidal trace and the T-web class ──────────────────────────────────────
{
    for (const p of POINTS.slice(1)) {
        const pr = probeAt(p, opts);
        const tv = pr.tidal.voidTensor;
        const tw = pr.tidal.smoothWallTensor;
        const r = Math.hypot(...p);
        const trace = tv[0] + tv[4] + tv[8] + tw[0] + tw[4] + tw[8];
        assert.ok(Math.abs(trace - profile.deltaAt(r)) < 1e-9,
            `tr(T_void + T_wall) = ${trace} ≠ δ(r) = ${profile.deltaAt(r)}`);
    }
    const centre = probeAt([0, 0, 0], opts);
    assert.equal(centre.tidal.twebSmooth.name, 'void',
        'the smooth model at the void centre must classify as a T-web void');
    assert.equal(centre.radialUnit, null, 'there is no radial direction at the centre');
    assert.equal(centre.forces.void.magnitude, 0, 'the void exerts nothing at its own centre');
    assert.deepEqual(twebClass([0.5, 0.3, -0.1]).name, 'filament');
    assert.deepEqual(twebClass([0.5, 0.3, 0.25]).name, 'knot');
    assert.deepEqual(twebClass([0.1, 0.0, -0.1]).name, 'void');
    assert.equal(twebClass([0.5, 0.1, 0], 0).name, 'filament', 'λ_th = 0 counts every strictly positive eigenvalue');
    assert.equal(centre.tidal.tweb.threshold, DEFAULT_TWEB_THRESHOLD);
    // The eigen-axes are an orthonormal triad and rod accelerations carry the sign.
    for (const ax of centre.tidal.axes) {
        assert.ok(Math.abs(Math.hypot(...ax.vector) - 1) < 1e-9);
        assert.equal(ax.sense, ax.lambda > 0 ? 'squeeze' : 'stretch');
        assert.ok(Math.sign(ax.rodKmsPerGyr) === -Math.sign(ax.lambda) || ax.lambda === 0);
    }
    ok('tr(T_void + T_wall) = δ(r); the void centre classifies as a T-web void');
}

// ── 7. The probe and Test 4 agree ───────────────────────────────────────────
{
    for (const p of POINTS.slice(1)) {
        const pr = probeAt(p, opts);
        const cf = counterfactualAt(p, { voidProfile: profile, web, z: Z });
        assert.ok(Math.abs(pr.voidShare - cf.voidShare) < 1e-12,
            `voidShare ${pr.voidShare} vs counterfactualAt ${cf.voidShare}`);
    }
    const sweep = radialSweep([1, 1, 0], { voidProfile: profile, web, z: Z, rMaxMpc: 2.6 * rEff, samples: 30 });
    for (const s of sweep) {
        assert.ok(Math.abs(s.A - s.void - s.web) <= 1e-9 * (Math.abs(s.A) + Math.abs(s.web) + 1e-9));
    }
    assert.ok(sweep[5].void > 0, 'the void term along a ray is outward');
    ok('the probe\'s void share equals counterfactualAt; the radial sweep recomposes A = void + web');
}

// ── 8. Streamlines ──────────────────────────────────────────────────────────
{
    // Void alone: outward and monotone, leaving the modelled sphere.
    const fieldV = (q) => voidGravityVector(q, [0, 0, 0], deficit, { z: Z });
    const s = traceStreamline([10, 5, 0], fieldV, { stepMpc: 4, rMaxMpc: 2 * rEff });
    const radii = s.forward.points.map(q => Math.hypot(...q));
    for (let i = 1; i < radii.length; i++) assert.ok(radii[i] > radii[i - 1], 'void streamline must run outward');
    assert.equal(s.forward.reason, 'range');
    // Backward it falls into the centre (where g → 0 and the direction reverses).
    assert.ok(['sink', 'weak'].includes(s.backward.reason), `backward: ${s.backward.reason}`);
    // accelerationField('A') is void + web, bound at the web's z.
    const fA = accelerationField({ voidProfile: profile, web, z: Z });
    const q = POINTS[3];
    assert.ok(vecRel(fA(q), probeAt(q, opts).forces.A.vector) < 1e-12, 'accelerationField(A) ≠ probe A');
    // A single point mass is a sink.
    const sink = [50, 0, 0];
    const fieldP = (q) => {
        const d = [sink[0] - q[0], sink[1] - q[1], sink[2] - q[2]];
        const r2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 + 1;
        return d.map(c => c / (r2 * Math.sqrt(r2)));
    };
    const t = traceStreamline([0, 10, 0], fieldP, { stepMpc: 2 });
    assert.equal(t.forward.reason, 'sink');
    const end = t.forward.points.at(-1);
    assert.ok(Math.hypot(end[0] - 50, end[1], end[2]) < 2.5, 'the streamline ends at the sink');
    ok('streamlines run outward through the void and terminate on a point sink');
}

// ── 9. Refusals ─────────────────────────────────────────────────────────────
{
    assert.throws(() => probeAt([1, 2, 3], { voidProfile: profile, web, z: 0 }), /z=/,
        'a probe at a different z than its web must be refused');
    assert.throws(() => probeAt([1, 2, 3], { voidProfile: profile }), /required/);
    assert.ok(Math.abs(toKmsPerGyr(1) - 3.1556952e13) < 1);
    // Default options come from the model's cosmology.
    assert.equal(probeAt([5, 5, 5], opts).z, Z);
    void COSMOLOGY;
    ok('mismatched redshift and missing inputs are refused');
}

console.log(`\n${passed} checks passed — js/bootes-force-probe.js`);
