/**
 * bootes-forward-model.js — a Bayesian forward-model fit of the initial field
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no fetch, no Worker. Used by js/bootes-reconstruct.js after
 * the 2LPT initial conditions are laid down (BOOTES_VOID_PLAN.md §4l).
 * `node tests/bootes-forward-model.mjs` pins every step.
 *
 * WHAT IT FITS
 * ────────────
 * The reconstruction (plan §4e–§4k) inverts a MATCHED state: a glass moved
 * until each element feels the observed force. That state is not one any
 * smooth past evolves into — measured on a self-twin, two thirds of the
 * forward run's miss is matched content the dynamics cannot reach — and on a
 * planted twin the forward run lands CLOSER to the truth than the matched
 * state does. So the data should not be the matched state. Here they are
 * today's observed GRAVITY at fixed random points, and the model is the
 * N-body run itself:
 *
 *     −ln p(s₁ | d) = ½ Σ_points |F[s₁](x_p) − d(x_p)|² / σ²  −  ln π(s₁)
 *
 * F[s₁] the softened N-body run from the 2LPT ICs of s₁ (the page's own
 * integrator, so the fit can never ask for structure it cannot grow).
 *
 *  - NOISE σ. The run cannot reproduce a target's discreteness, nor the
 *    target its own: σ² = σ²_elements + σ²_target, each the rms field of a
 *    glass's (or the relaxed target's) residual grain at the data points.
 *    Measured on the clean-glass planted twin: 41.5 and 53.2 (km/s)²/Mpc,
 *    their difference 65.5 — 1.32 % of the data.
 *  - PRIOR π. A band limit: the correction lives where the elements resolve
 *    the field (k h < κ, the quartic taper the deconvolution already uses);
 *    outside the band the 2LPT estimate is held exactly. Inside it the prior
 *    is flat. That is the regulariser plan §4e asked for: position shooting
 *    and field feedback failed by chasing grain into the past, which lives
 *    above the band.
 *  - STEP. Gauss–Newton with the integrator's own LINEAR RESPONSE as the
 *    Jacobian: a displacement residual Δψ = (d − F)/4πGρ̄₀ (the matching's
 *    relation), carried from the points to each element where the run put it,
 *    band-limited, then deconvolved by T(k) (js/bootes-softgrowth.js — a mode
 *    laid down at a_init grows to T(k) of the ideal). The gain is line-searched
 *    (2, 1, ½): an over-relaxed step halved the iterations on the twin, and 3
 *    overshot (today's core got WORSE against the truth while the misfit fell).
 *  - STOP at the discrepancy principle (χ²_ν ≤ 1: the misfit is down to the
 *    noise), at no descent, or at the iteration cap.
 *
 * WHAT IT IS NOT, stated where it is used
 * ──────────────────────────────────────
 *  - A MAP estimate, not a posterior sample: no uncertainty on the past is
 *    computed here. The planted twin measures the error instead (plan §4l).
 *  - The Jacobian is linear: in collapsed clumps the true response is larger
 *    than T(k), which is why the gain is line-searched and capped at 2.
 *  - The prior is a band limit, not a ΛCDM power spectrum: the page's web is
 *    a model, not a realisation of one.
 */

import { COSMOLOGY, meanMatterDensityMsunMpc3 } from './bootes-void-model.js';
import { mulberry32 } from './bootes-web-model.js';
import {
    G_MPC, buildTree, treeForce, meanSphereForce, createSimulation, buildSchedule,
    DEFAULT_THETA, DEFAULT_LEAF,
} from './bootes-nbody.js';
import { lptGrowth, lptState, secondOrderDisplacement } from './bootes-lpt.js';
import { deconvolutionKernel, deconvolveGrowth } from './bootes-softgrowth.js';
import { interpolateDisplacement } from './bootes-reconstruct.js';

/** n seeded random points uniform inside fill × radius. */
export function dataPoints({ radius, n, seed = 2026, fill = 0.95 }) {
    const rng = mulberry32(seed);
    const out = new Float64Array(3 * n);
    for (let i = 0; i < n;) {
        const x = (2 * rng() - 1) * radius, y = (2 * rng() - 1) * radius, z = (2 * rng() - 1) * radius;
        if (Math.hypot(x, y, z) < fill * radius) { out[3 * i] = x; out[3 * i + 1] = y; out[3 * i + 2] = z; i++; }
    }
    return out;
}

/**
 * The peculiar field of a set of masses at the points — the tree sum minus
 * the kernel-smoothed mean sphere, exactly as `fieldMatch` measures it.
 * `sources` = [{ pos, mass, softening, index? }] (several trees add).
 */
export function fieldAtPoints({
    sources, radius, points, meanSoftening, theta = DEFAULT_THETA, leafSize = DEFAULT_LEAF, cosmo = COSMOLOGY,
}) {
    const rho = meanMatterDensityMsunMpc3(cosmo);
    const trees = sources.map((s) => ({
        s, tree: s.tree ?? buildTree(s.pos, s.mass, s.index ?? Int32Array.from({ length: s.mass.length }, (_, i) => i), {
            leafSize, hsoft: s.softening.kind === 'spline-per-particle' ? s.softening.h : null,
        }),
    }));
    const sph = meanSphereForce(radius, rho, meanSoftening);
    const n = points.length / 3;
    const out = new Float64Array(3 * n);
    const b = new Float64Array(3);
    for (let i = 0; i < n; i++) {
        const x = points[3 * i], y = points[3 * i + 1], z = points[3 * i + 2];
        b[0] = b[1] = b[2] = 0;
        for (const { s, tree } of trees) treeForce(tree, x, y, z, theta, s.softening, b);
        const r = Math.hypot(x, y, z);
        const m = r > 1e-9 ? sph(r) / r : 0;
        out[3 * i] = b[0] - m * x; out[3 * i + 1] = b[1] - m * y; out[3 * i + 2] = b[2] - m * z;
    }
    return out;
}

/** rms |v| of a 3-vector array. */
export function rmsVector(v) {
    let s = 0;
    for (let k = 0; k < v.length; k++) s += v[k] * v[k];
    return Math.sqrt(s / (v.length / 3));
}

/**
 * The band-limit prior as an operator: W(k) = exp(−(kh/κ)⁴), applied on the
 * glass in the deconvolution's DIFFERENCE form (s + ∫W·(s′ − s) = W*s since
 * ∫W = 1) — it keeps constant, linear and quadratic fields exactly, which a
 * Gaussian (Nadaraya–Watson) smoother does not (it biased the void's steep
 * profile by up to −550 (km/s)²/Mpc, plan §4k).
 */
export function bandKernel({ h, kappa, rMax = null, dr = 0.25, kPoints = 600 }) {
    const kMax = Math.pow(30, 1 / 4) * kappa / h;
    const R = rMax ?? 6 * h;
    const nr = Math.ceil(R / dr);
    const K = new Float64Array(nr + 1);
    const dk = kMax / kPoints;
    for (let j = 0; j <= nr; j++) {
        const r = j * dr;
        let s = 0;
        for (let i = 0; i <= kPoints; i++) {
            const k = kMax * i / kPoints, x = k * r;
            const j0 = x < 1e-8 ? 1 : Math.sin(x) / x;
            const w = (i === 0 || i === kPoints) ? 1 : (i % 2 ? 4 : 2);
            s += w * Math.exp(-((k * h / kappa) ** 4)) * j0 * k * k;
        }
        K[j] = s * dk / 3 / (2 * Math.PI * Math.PI);
    }
    return { h, kappa, rMax: R, dr, K };
}

/**
 * The forward model F[s₁]: the 2LPT ICs of (s₁, s₂) at aInit run to aObs by
 * the page's own integrator in `steps` steps; returns the elements at aObs
 * and their peculiar field at `points`.
 */
export function forwardRun({
    glass, s1, s2, aInit, aObs, steps, points, growth = null, cosmo = COSMOLOGY,
    sim = { theta: DEFAULT_THETA, leafSize: DEFAULT_LEAF },
}) {
    const rho = meanMatterDensityMsunMpc3(cosmo);
    const n = glass.n;
    const ic = lptState(glass.pos, s1, s2, aInit, growth ?? lptGrowth(aInit, aObs, cosmo), cosmo);
    const run = createSimulation({
        pos: ic.pos, vel: ic.vel, mass: glass.mass, group: new Uint8Array(n), nMassive: n, aStart: aInit,
        softening: [glass.softening, glass.softening], background: { radius: glass.radius, rho }, cosmo, ...sim,
    });
    const schedule = buildSchedule({ aStart: aInit, aEnd: aObs, steps, cosmo });
    for (let k = 0; k < schedule.steps; k++) run.step(schedule, k);
    const x = Float64Array.from(run.x);
    const field = fieldAtPoints({
        sources: [{ pos: x, mass: glass.mass, softening: glass.softening }], radius: glass.radius,
        points, meanSoftening: glass.softening, cosmo, ...sim,
    });
    return { x, field };
}

/**
 * Fit s₁ to today's observed field. `glass` = { pos, mass, n, softening,
 * radius, spacing }; `s1` the 2LPT (+ softened-growth) estimate it starts
 * from; `data` = { points, field } (the observed peculiar field there);
 * `noise` the per-point rms σ in (km/s)²/Mpc. Returns the fitted s₁ and s₂,
 * the per-iteration history and why it stopped.
 */
export function forwardModelFit({
    glass, s1, aInit, aObs, data, noise, config, cosmo = COSMOLOGY,
    sim = { theta: DEFAULT_THETA, leafSize: DEFAULT_LEAF }, onProgress = null,
}) {
    const t0 = Date.now();
    const rho = meanMatterDensityMsunMpc3(cosmo);
    const k4 = 4 * Math.PI * G_MPC * rho;
    const h = 2 * glass.spacing;
    const volume = Float64Array.from(glass.mass, (m) => m / rho);
    const hsoft = Float64Array.from(glass.mass, () => h);
    const growth = lptGrowth(aInit, aObs, cosmo);
    const band = bandKernel({ h, kappa: config.bandKappa });
    const deconv = deconvolutionKernel({ h, aInit, aObs, kappa: config.growthKappa ?? 3, cosmo });
    const width = config.widthMpc ?? glass.spacing;
    const s2Of = (s) => secondOrderDisplacement(glass.pos, s, { volume, hsoft, h, ...sim });
    const forward = (s, s2) => forwardRun({
        glass, s1: s, s2, aInit, aObs, steps: config.innerSteps, points: data.points, growth, cosmo, sim,
    });
    const chi2 = (field) => {
        let s = 0;
        for (let k = 0; k < field.length; k++) s += (field[k] - data.field[k]) ** 2;
        return s / (field.length / 3) / (noise * noise);
    };
    const dataRms = rmsVector(data.field);
    let cur = { s1: Float64Array.from(s1), s2: s2Of(s1) };
    let out = forward(cur.s1, cur.s2);
    let c2 = chi2(out.field);
    const history = [{ chi2: c2, misfit: Math.sqrt(c2) * noise / dataRms, gain: 0, seconds: (Date.now() - t0) / 1000 }];
    let stoppedBy = 'iterations';
    for (let it = 0; it < config.maxIterations; it++) {
        if (c2 <= (config.chi2Stop ?? 1)) { stoppedBy = 'noise'; break; }
        onProgress?.(it, config.maxIterations);
        // Δψ at the points, carried to each element where the run put it.
        const r = new Float64Array(data.field.length);
        for (let k = 0; k < r.length; k++) r[k] = (data.field[k] - out.field[k]) / k4;
        const atElements = interpolateDisplacement(out.x, data.points, r, width);
        // The prior's band, then the integrator's own growth response.
        const step = deconvolveGrowth(glass.pos, deconvolveGrowth(glass.pos, atElements, volume, band), volume, deconv);
        let accepted = null;
        for (const gain of config.gains) {
            const s1t = new Float64Array(cur.s1.length);
            for (let k = 0; k < s1t.length; k++) s1t[k] = cur.s1[k] + gain * step[k];
            const s2t = s2Of(s1t);
            const o = forward(s1t, s2t);
            const c = chi2(o.field);
            if (c < c2) { accepted = { gain, s1: s1t, s2: s2t, out: o, c2: c }; break; }
        }
        if (!accepted) { stoppedBy = 'no-descent'; break; }
        cur = { s1: accepted.s1, s2: accepted.s2 };
        out = accepted.out;
        c2 = accepted.c2;
        history.push({ chi2: c2, misfit: Math.sqrt(c2) * noise / dataRms, gain: accepted.gain, seconds: (Date.now() - t0) / 1000 });
    }
    if (stoppedBy === 'iterations' && c2 <= (config.chi2Stop ?? 1)) stoppedBy = 'noise';
    onProgress?.(config.maxIterations, config.maxIterations);
    return { s1: cur.s1, s2: cur.s2, history, stoppedBy, noise, dataRms, chi2: c2 };
}
