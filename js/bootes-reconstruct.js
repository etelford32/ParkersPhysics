/**
 * bootes-reconstruct.js — the web's initial conditions, reconstructed
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no fetch, no Worker. Phase 2 of BOOTES_VOID_PLAN.md §4d:
 * find a smooth, nearly uniform early universe that the N-body kernel
 * (js/bootes-nbody.js) evolves INTO the observed model web, so the galaxy
 * tracker's N-body mode can run the PAST as well as the future.
 * `node tests/bootes-reconstruct.mjs` pins every step.
 *
 * WHY NOT JUST RUN THE N-BODY BACKWARDS
 * ─────────────────────────────────────
 * Gravity amplifies forward. Integrated backwards it amplifies the other way:
 * every error in today's field — and every grain of the particle sampling —
 * grows into the past, and the "initial conditions" that come out are noise.
 * The well-posed version of the question is not "where was this particle"
 * but "which SMOOTH early state evolves into today's field", and that is what
 * this module answers, in three steps.
 *
 * 1. THE LAGRANGIAN GLASS. A uniform quiet-start sphere (the same zoom layout
 *    the forecast uses) relaxed under REPULSIVE gravity with overdamped
 *    steps, x ← x − r·F/(4πGρ̄₀), until no particle feels a force: a glass,
 *    the standard pre-initial load of cosmological N-body (White 1994;
 *    Baugh et al. 1995). A glass has no preferred directions and almost no
 *    residual force, so discreteness noise does not grow into fake structure.
 *    The quiet start alone does NOT qualify: relaxed directly, its lattice
 *    rearranged sideways by ~2 Mpc (measured) — grain motion with no physics
 *    in it, which then poisoned every displacement built on top of it.
 *
 * 2. GRAVITATIONAL MATCHING. The glass flows toward today's matter, each
 *    element pushed by the gravity of the DIFFERENCE between the observed
 *    field and its own current field:
 *        x ← x + r·[F_obs(x) − F_now(x)] / (4πGρ̄₀)
 *    In linear theory F/(4πGρ̄₀) IS the displacement (∇·ψ = −δ and
 *    ∇·F = −4πGρ̄₀δ), so this is the Zel'dovich relation iterated to its
 *    fixed point: the elements stop when their own field reproduces the
 *    observed one at the elements' resolution. Each element keeps its
 *    identity, so its Lagrangian position q (where it sat in the glass) and
 *    its observed position X are both known. The flow is curl-free and
 *    smooth because it is a sum of gravitational fields — the property that
 *    makes it a near-least-action map (Peebles 1989; Brenier et al. 2003)
 *    rather than an arbitrary assignment. For a spherical void it is EXACT:
 *    the matched Lagrangian radius of every shell is the one mass
 *    conservation demands (gated against the tracker's shell table).
 *    The web's 802 heavy particles are NOT carried over one-for-one — their
 *    mass is taken up by whichever glass elements flowed into them, because
 *    the early universe had no 10¹⁵ M☉ points in it, only a slightly denser
 *    patch. That is what makes the result an initial condition.
 *
 * 3. 2LPT INITIAL CONDITIONS at a_init (js/bootes-lpt.js, the default since
 *    plan §4f): the matched displacement ψ = X − q is split into its linear
 *    part s₁ and the second-order part D₂ₒs₂[s₁] that grew as D₁² (inverted
 *    by fixed point), and both are laid down — x = q + d₁s₁ + d₂s₂,
 *    u = aH(d₁′s₁ + d₂′s₂). Zel'dovich ICs (`ics: 'za'`, positions
 *    q + (D_i/D_obs)ψ, velocities a·H·f·(D_i/D_obs)ψ) scale the second-order
 *    part back as if it were linear, over-counting it ~7× at z = 9: measured
 *    on the page, 2LPT took today's gravity in the void's core 7.4 → 2.7 %
 *    (60–90 Mpc 7.1 → 4.1 %) and changed nothing on the wall — so the wall's
 *    error is RESOLUTION, not order. In a planted-CLUSTER twin Zel'dovich does
 *    better (3.4 vs 4.7 %), by cancellation: its double-counted collapse
 *    offsets the softened integrator's own ~3.5 % linear-growth deficit,
 *    which 2LPT exposes (its amplitude sits at 0.965 for either sign of δ).
 *    That deficit is now REMOVED (js/bootes-softgrowth.js, plan §4g): s₁ is
 *    laid down as T(k)⁻¹s₁, the integrator's own softened-growth transfer
 *    deconvolved up to kh ≈ 3 — void twin 4.0 → 1.7 %, cluster forward miss
 *    4.6 → 3.1 % (Zel'dovich 3.3), page 60–90 Mpc 4.1 → 3.0 %.
 *    And NOTHING is iterated on top. Forward "shooting" (re-run,
 *    feed the miss back into ψ) was built and MEASURED out: it drives the
 *    elements onto their matched positions (0.03 Mpc rms) while making the
 *    initial field WORSE — in the twin test (plant a known initial field, run
 *    it forward, reconstruct) the recovered field's error went 9 % → 21–25 %
 *    smoothed at the resolution, 41 % → 149 % unsmoothed, because softening
 *    makes sub-resolution modes respond weakly and the shots amplify them to
 *    chase grain noise in the target. Smoothing the correction or dropping
 *    the gain to 1 did not rescue it. The element-level miss it chased
 *    (~3 Mpc) is grain — the observed smooth matter is a quiet-start lattice
 *    no glass reproduces particle for particle — and the FIELD is what the
 *    reconstruction claims (`fieldMatch`, gated): on the page, today's
 *    gravity is reproduced to 3–4 % in the void's core (2LPT; 7–9 % with
 *    Zel'dovich ICs), ≤ 8 % inside R_eff, 20 % just outside it and
 *    35–42 % out on the clumpy wall, where the elements' ~24 Mpc resolution
 *    cannot rebuild the web's ~11 Mpc nodes (2LPT moved the core, not this).
 *    FIELD FEEDBACK (re-run, then push ψ by the gravity the evolved state
 *    still lacks) was also built and measured out: it improved today's field
 *    (16 → 10 % on the gate layout) and, in the twin test, the recovered
 *    initial field at a void-like amplitude (8.1 → 6.4 %) — but at δ ≈ 1 it
 *    made the initial field WORSE, erratically (15 → 39 % after one pass,
 *    20 % after two). Improving today's match while corrupting the past is
 *    over-fitting, and nothing on the page could tell the reader which they
 *    were looking at. 2LPT (above) is the nonlinear-aware inverse that DID
 *    survive measurement; a Bayesian forward model with a prior that
 *    regularises the shooting is the next one.
 *
 * a_init = 0.1 (z = 9, 0.55 Gyr) ON PURPOSE: from z = 19 the same pipeline
 * converged at ~0.6 per shot against ~0.4 from z = 9 — 15× of growth turns
 * the glass's residual grain into tangential scatter the shots must chase
 * (measured). z = 9 is before the tracker's time axis begins (1 Gyr), so the
 * whole drawn history is covered.
 *
 * THE GALAXIES are massless and do not enter steps 1–3. Each is given the
 * matched elements' displacement field interpolated at its observed position
 * as a first guess, then shot on its own through the stored run (test-only
 * replays, cheap and bitwise-reproducible) until it lands where it is seen.
 *
 * WHAT THIS IS NOT, stated where it is used
 * ─────────────────────────────────────────
 *  - It reconstructs the page's MODEL web, which is itself a seeded synthetic
 *    realisation. With a real density field in its place (BOOTES_VOID_PLAN.md
 *    §6) the same code would reconstruct the real one.
 *  - The past is ONE of many compatible with today: the smooth, curl-free,
 *    near-least-action one. Structure below the elements' resolution
 *    (spline h = 24 Mpc on the page's uniform 12 Mpc layout) is not
 *    recoverable, and the web's
 *    nodes come out as dense patches of elements, not points.
 *  - Matter beyond the sampled sphere (2.6 R_eff) is the mean: the far web
 *    has no past here.
 */

import {
    COSMOLOGY, growthFactor, growthRate, hubbleKmsMpc, meanMatterDensityMsunMpc3,
} from './bootes-void-model.js';
import {
    G_MPC, buildTree, treeForce, quietSphere, splinePerParticle, createSimulation, buildSchedule,
    meanSphereForce,
    replayTestParticles, DEFAULT_THETA, DEFAULT_LEAF,
} from './bootes-nbody.js';
import { invert2LPT, lptGrowth, lptState, secondOrderDisplacement } from './bootes-lpt.js';
import { deconvolutionKernel, deconvolveGrowth } from './bootes-softgrowth.js';

/**
 * The page's reconstruction, in ONE place (worker, runner and gate read it).
 * Measured on the page configuration in tests/bootes-reconstruct.mjs.
 */
export const RECON_CONFIG = Object.freeze({
    /**
     * The reconstruction's OWN element layout: UNIFORM 12 Mpc out to 2.6 R_eff
     * (~35 000 elements), not the forecast's zoom. Measured: with the zoom's
     * outskirts coarsening to 24 Mpc (h → 48 Mpc) the matched field missed the
     * web's 11 Mpc clumps by 50–66 % beyond 1.6 R_eff, where most galaxies sit;
     * uniform 14 Mpc still missed by 29 %; uniform 12 Mpc holds ≤ 10 %.
     */
    layout: (rEffMpc) => ({ radius: 2.6 * rEffMpc, spacing: 12, refineRadius: Infinity }),
    aInit: 0.1,
    glassIterations: 40,
    matchIterations: 30,
    rate: 0.7,
    stepsToObs: 30,
    stepsAfterObs: 24,
    testShots: 4,
    seed: 11,
    /** 'za' (Zel'dovich) or '2lpt' (js/bootes-lpt.js) — see §3 of the header. */
    ics: '2lpt',
    lptIterations: 4,
    /**
     * Taper κ of the softened-growth deconvolution (js/bootes-softgrowth.js,
     * plan §4g): s₁ is laid down as T(k)⁻¹s₁ up to kh ≈ κ so the softened
     * integrator grows it into today's field. null switches it off (A/B).
     * 2LPT only — on Zel'dovich ICs it un-hides their double-counted collapse.
     */
    growthKappa: 3,
});

const fourPiGRho = (cosmo) => 4 * Math.PI * G_MPC * meanMatterDensityMsunMpc3(cosmo);
/** The radius smooth matter within which counts as "on" a web node. */
export const NODE_RADIUS_MPC = 20;
const rmsOf = (arr, n) => {
    let s = 0;
    for (let k = 0; k < arr.length; k++) s += arr[k] * arr[k];
    return Math.sqrt(s / n);
};

// ── 1. The glass ────────────────────────────────────────────────────────────

/**
 * A uniform quiet sphere relaxed into a glass. Returns positions, masses and
 * the residual |F|/(4πGρ̄₀) rms (Mpc) — the displacement the remaining force
 * would still ask for; ~0.04 Mpc after 40 steps on a 14 Mpc layout.
 */
export function buildGlass({
    radius, spacing, refineRadius = Infinity, seed = RECON_CONFIG.seed, softening = null,
    iterations = RECON_CONFIG.glassIterations, rate = RECON_CONFIG.rate,
    theta = DEFAULT_THETA, leafSize = DEFAULT_LEAF, cosmo = COSMOLOGY, onProgress = null,
}) {
    const rho = meanMatterDensityMsunMpc3(cosmo);
    const k4 = fourPiGRho(cosmo);
    const qs = quietSphere({ deltaFn: () => 0, radius, spacing, refineRadius, rho, seed });
    const n = qs.mass.length;
    // Each element is smoothed at TWICE ITS OWN cell size — the zoom's spacing
    // grows outward, and one global h left the outskirts grainy enough to
    // trap galaxies (they stalled at 0.5–10 Mpc from their targets beyond
    // 1.6 R_eff; measured). The element keeps its h as it moves.
    const soft = softening ?? splinePerParticle(
        Float64Array.from(qs.cellSize, (c) => 2 * c), 2 * Math.max(...qs.cellSize));
    const sim = createSimulation({
        pos: qs.pos, vel: new Float64Array(3 * n), mass: qs.mass, group: new Uint8Array(n),
        nMassive: n, aStart: 1, softening: [soft, soft], background: { radius, rho },
        theta, leafSize, cosmo,
    });
    const history = [forceRms(sim, n) / k4];          // [0] is the quiet start itself
    for (let it = 0; it < iterations; it++) {
        // Repulsive: move AGAINST the peculiar force.
        for (let k = 0; k < 3 * n; k++) sim.x[k] -= rate * (sim.fBg[k] + sim.fWeb[k]) / k4;
        sim.refreshForces();
        history.push(forceRms(sim, n) / k4);
        onProgress?.(it + 1, iterations);
    }
    return {
        pos: Float64Array.from(sim.x), mass: qs.mass, n, softening: soft, radius, spacing,
        residual: history[history.length - 1] ?? forceRms(sim, n) / k4, history,
    };
}

function forceRms(sim, n) {
    let s = 0;
    for (let k = 0; k < 3 * n; k++) {
        const f = sim.fBg[k] + sim.fWeb[k];
        s += f * f;
    }
    return Math.sqrt(s / n);
}

// ── 2. Gravitational matching ───────────────────────────────────────────────

/**
 * Flow the glass onto the observed field. `observed` is { pos, mass, group,
 * softening: [smooth, web] } — the forecast's own representation (the
 * smooth matter on its spline, the web on the probe's Plummer ε). Only the
 * part inside the glass's radius is matched; the far web has no past here.
 * Returns the matched positions X and the residual history (rms
 * |ΔF|/(4πGρ̄₀), Mpc).
 */
export function matchObserved({
    glass, observed, iterations = RECON_CONFIG.matchIterations, rate = RECON_CONFIG.rate,
    theta = DEFAULT_THETA, leafSize = DEFAULT_LEAF, cosmo = COSMOLOGY, onProgress = null,
}) {
    const k4 = fourPiGRho(cosmo);
    const R = glass.radius;
    // The observed trees, built ONCE: the target does not move.
    const inside = [[], []];
    const nObs = observed.mass.length;
    for (let i = 0; i < nObs; i++) {
        const r = Math.hypot(observed.pos[3 * i], observed.pos[3 * i + 1], observed.pos[3 * i + 2]);
        if (r < R) inside[observed.group[i] ? 1 : 0].push(i);
    }
    const obsTrees = inside.map((m, g) => buildTree(observed.pos, observed.mass, Int32Array.from(m), {
        leafSize, hsoft: observed.softening[g].kind === 'spline-per-particle' ? observed.softening[g].h : null,
    }));
    const n = glass.n;
    // The elements' own field: no mean subtraction on either side — both
    // are the same total mass inside R, so the means cancel in the difference.
    const sim = createSimulation({
        pos: glass.pos, vel: new Float64Array(3 * n), mass: glass.mass, group: new Uint8Array(n),
        nMassive: n, aStart: 1, softening: [glass.softening, glass.softening], background: null,
        theta, leafSize, cosmo,
    });
    const fo = new Float64Array(3);
    const history = [];
    for (let it = 0; it < iterations; it++) {
        let r2 = 0;
        for (let i = 0; i < n; i++) {
            const o = 3 * i;
            fo[0] = fo[1] = fo[2] = 0;
            treeForce(obsTrees[0], sim.x[o], sim.x[o + 1], sim.x[o + 2], theta, observed.softening[0], fo);
            treeForce(obsTrees[1], sim.x[o], sim.x[o + 1], sim.x[o + 2], theta, observed.softening[1], fo);
            for (let d = 0; d < 3; d++) {
                const df = (fo[d] - sim.fBg[o + d]) / k4;
                r2 += df * df;
                sim.x[o + d] += rate * df;
            }
        }
        sim.refreshForces();
        history.push(Math.sqrt(r2 / n));
        onProgress?.(it + 1, iterations);
    }
    return { X: Float64Array.from(sim.x), history, obsTrees, observed };
}

// ── 3. Zel'dovich initial conditions; the galaxies ────────────────────────

/**
 * Zel'dovich state at aInit for Lagrangian positions q and an a_obs-scaled
 * displacement ψ: x = q + (D_i/D_obs)ψ, u = a·H·f·(D_i/D_obs)ψ (km/s).
 */
export function zeldovichState(q, psi, aInit, aObs, cosmo = COSMOLOGY) {
    const zi = 1 / aInit - 1;
    const ratio = growthFactor(zi, cosmo) / growthFactor(1 / aObs - 1, cosmo);
    const vk = aInit * hubbleKmsMpc(zi, cosmo) * growthRate(zi, cosmo, { exact: true }) * ratio;
    const pos = new Float64Array(q.length), vel = new Float64Array(q.length);
    for (let k = 0; k < q.length; k++) {
        pos[k] = q[k] + ratio * psi[k];
        vel[k] = vk * psi[k];
    }
    return { pos, vel, ratio };
}

/** Two schedules back to back: frame `a.steps` of the result is a.a[end]. */
export function concatSchedules(a, b) {
    const cat = (x, y) => { const o = new Float64Array(x.length + y.length); o.set(x); o.set(y, x.length); return o; };
    return {
        steps: a.steps + b.steps,
        N: cat(a.N, b.N.subarray(1)),
        a: cat(a.a, b.a.subarray(1)),
        kick1: cat(a.kick1, b.kick1),
        kick2: cat(a.kick2, b.kick2),
        drift: cat(a.drift, b.drift),
        cosmo: a.cosmo,
        obsFrame: a.steps,
    };
}

/**
 * How well the reconstructed universe reproduces TODAY's gravity: the
 * peculiar force of the elements at z_obs against the observed model's, at
 * `points` (comoving Mpc). Both sides subtract their own kernel-smoothed mean
 * sphere. Returns the relative rms error overall and in radial bins of
 * `binMpc` — the claim the reconstruction makes, and the one it is gated on.
 */
export function fieldMatch({
    match, elements, mass, softening, radius, points, binMpc = 30,
    theta = DEFAULT_THETA, leafSize = DEFAULT_LEAF, cosmo = COSMOLOGY,
}) {
    const rho = meanMatterDensityMsunMpc3(cosmo);
    const n = mass.length;
    const recTree = buildTree(elements, mass, Int32Array.from({ length: n }, (_, i) => i), {
        leafSize, hsoft: softening.kind === 'spline-per-particle' ? softening.h : null,
    });
    const sphRec = meanSphereForce(radius, rho, softening);
    const obs = match.observed;
    const sphObs = meanSphereForce(radius, rho, obs.softening[0]);
    const bins = new Map();
    let E = 0, T = 0;
    for (let p = 0; p < points.length / 3; p++) {
        const x = points[3 * p], y = points[3 * p + 1], z = points[3 * p + 2];
        const r = Math.hypot(x, y, z);
        if (!(r > 0) || r >= radius) continue;
        const a = new Float64Array(3), b = new Float64Array(3);
        treeForce(recTree, x, y, z, theta, softening, a);
        treeForce(match.obsTrees[0], x, y, z, theta, obs.softening[0], b);
        treeForce(match.obsTrees[1], x, y, z, theta, obs.softening[1], b);
        const sa = -sphRec(r) / r, sb = -sphObs(r) / r;
        const p3 = [x, y, z];
        let e = 0, t = 0;
        for (let d = 0; d < 3; d++) {
            const fa = a[d] + sa * p3[d], fb = b[d] + sb * p3[d];
            e += (fa - fb) ** 2; t += fb * fb;
        }
        const k = Math.floor(r / binMpc) * binMpc;
        if (!bins.has(k)) bins.set(k, { e: 0, t: 0, n: 0 });
        const B = bins.get(k);
        B.e += e; B.t += t; B.n++;
        E += e; T += t;
    }
    return {
        overall: Math.sqrt(E / T),
        bins: [...bins].sort((u, v) => u[0] - v[0])
            .map(([r0, B]) => ({ r0, r1: r0 + binMpc, rel: Math.sqrt(B.e / B.t), n: B.n })),
    };
}

/**
 * Smooth matter within `radiusMpc` of each of `centres` (Float64Array 3k,
 * one position per node), summed — for every frame of a run. The nodes are
 * tracked as massless markers in the reconstruction (their mass is in the
 * elements), so this is "how much matter has gathered around where the web's
 * nodes are going to be / are".
 */
export function matterNearMarkers(snapshots, mass, markerFrames, nMarkers, radiusMpc = NODE_RADIUS_MPC) {
    const out = new Float64Array(snapshots.length);
    const r2 = radiusMpc * radiusMpc;
    snapshots.forEach((x, f) => {
        let total = 0;
        for (let k = 0; k < nMarkers; k++) {
            const o = (f * nMarkers + k) * 3;
            const cx = markerFrames[o], cy = markerFrames[o + 1], cz = markerFrames[o + 2];
            for (let i = 0; i < mass.length; i++) {
                const dx = x[3 * i] - cx, dy = x[3 * i + 1] - cy, dz = x[3 * i + 2] - cz;
                if (dx * dx + dy * dy + dz * dz < r2) total += mass[i];
            }
        }
        out[f] = total;
    });
    return out;
}

/**
 * First guess for a massless galaxy's ψ: the matched elements' ψ, weighted by
 * a Gaussian of width `widthMpc` around the galaxy's observed position (the
 * elements' own resolution — finer would read the grain, coarser would wash
 * the web out). A uniform grid hash keeps it O(N · neighbours).
 */
export function interpolateDisplacement(points, X, psi, widthMpc) {
    const n = X.length / 3;
    const cell = 2 * widthMpc;
    const key = (i, j, k) => `${i},${j},${k}`;
    const grid = new Map();
    for (let e = 0; e < n; e++) {
        const kk = key(Math.floor(X[3 * e] / cell), Math.floor(X[3 * e + 1] / cell), Math.floor(X[3 * e + 2] / cell));
        if (!grid.has(kk)) grid.set(kk, []);
        grid.get(kk).push(e);
    }
    const m = points.length / 3;
    const out = new Float64Array(3 * m);
    const inv2s2 = 1 / (2 * widthMpc * widthMpc);
    for (let p = 0; p < m; p++) {
        const x = points[3 * p], y = points[3 * p + 1], z = points[3 * p + 2];
        const ci = Math.floor(x / cell), cj = Math.floor(y / cell), ck = Math.floor(z / cell);
        let W = 0, sx = 0, sy = 0, sz = 0;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
            const list = grid.get(key(ci + di, cj + dj, ck + dk));
            if (!list) continue;
            for (const e of list) {
                const dx = X[3 * e] - x, dy = X[3 * e + 1] - y, dz = X[3 * e + 2] - z;
                const w = Math.exp(-(dx * dx + dy * dy + dz * dz) * inv2s2);
                W += w; sx += w * psi[3 * e]; sy += w * psi[3 * e + 1]; sz += w * psi[3 * e + 2];
            }
        }
        if (W > 1e-12) { out[3 * p] = sx / W; out[3 * p + 1] = sy / W; out[3 * p + 2] = sz / W; }
    }
    return out;
}

/**
 * Shoot massless galaxies through a stored run: find each one's Lagrangian
 * start so its test-only replay lands on its observed position at
 * `schedule.obsFrame`. Galaxies cannot perturb the matter, so each shot is a
 * cheap replay and every galaxy converges independently.
 *
 * The update moves the START (q), with ψ — and so the growing-mode velocity —
 * held at the interpolated first guess. Shifting q shifts a test particle's
 * whole path almost one-for-one (it rides a smooth field), so a gain of 1 is
 * well-conditioned. Updating ψ with q pinned to the target was the first
 * version: the landing point then moves only by (1 − R)ψ with R ≈ 1, and the
 * shots barely converged.
 * Returns the ICs, the replay record of the last shot, and the residuals.
 */
export function shootGalaxies({
    snapshots, schedule, mass, group, nMassive, softening, background, targets, psi0,
    aObs, shots = RECON_CONFIG.testShots, gain = 1,
    theta = DEFAULT_THETA, leafSize = DEFAULT_LEAF, cosmo = COSMOLOGY, onProgress = null,
}) {
    const m = targets.length / 3;
    const psi = Float64Array.from(psi0);
    const q = new Float64Array(3 * m);
    for (let k = 0; k < 3 * m; k++) q[k] = targets[k] - psi[k];
    const f = schedule.obsFrame;
    const aInit = schedule.a[0];
    const residuals = [];
    let rec = null, ic = null;
    for (let shot = 0; shot <= shots; shot++) {
        ic = zeldovichState(q, psi, aInit, aObs, cosmo);
        rec = replayTestParticles({
            snapshots, schedule, mass, group, nMassive, points: ic.pos, velocities: ic.vel,
            softening, background, theta, leafSize, cosmo,
        });
        const res = new Float64Array(3 * m);
        for (let p = 0; p < m; p++) {
            for (let d = 0; d < 3; d++) res[3 * p + d] = targets[3 * p + d] - rec.pos[(f * m + p) * 3 + d];
        }
        residuals.push(rmsOf(res, m));
        onProgress?.(shot + 1, shots + 1);
        if (shot === shots) break;
        for (let k = 0; k < 3 * m; k++) q[k] += gain * res[k];
    }
    return { pos0: ic.pos, vel0: ic.vel, q, psi, rec, residuals };
}

// ── The whole pipeline ──────────────────────────────────────────────────────

/**
 * Reconstruct, then run the reconstructed universe from aInit through aObs
 * to aEnd, and fly the galaxies (`testPoints`, observed positions) through
 * it. `observed` is the forecast's massive state (buildInitialConditions
 * output); `config` its zoom layout ({ radius, spacing, refineRadius }).
 * Returns everything the runner serves, in the forecast run's shape
 * (frame-major typed arrays), plus the diagnostics the page prints.
 * `nodeMarkers` = { from, count }: which test points are the web's nodes,
 * for the per-frame matter-on-the-nodes history.
 * `onProgress(stage, done, total)` names the stage.
 */
export function reconstructRun({
    observed, config, testPoints, aObs, aEnd, nodeMarkers = null, cosmo = COSMOLOGY,
    sim = { theta: DEFAULT_THETA, leafSize: DEFAULT_LEAF }, recon = RECON_CONFIG, onProgress = null,
}) {
    const t0 = Date.now();
    const glass = buildGlass({
        radius: config.radius, spacing: config.spacing, refineRadius: config.refineRadius,
        seed: recon.seed, iterations: recon.glassIterations, rate: recon.rate, cosmo, ...sim,
        onProgress: (d, t) => onProgress?.('glass', d, t),
    });
    const match = matchObserved({
        glass, observed, iterations: recon.matchIterations, rate: recon.rate, cosmo, ...sim,
        onProgress: (d, t) => onProgress?.('match', d, t),
    });
    const rho = meanMatterDensityMsunMpc3(cosmo);
    const background = { radius: glass.radius, rho };
    const psi = new Float64Array(match.X.length);
    for (let k = 0; k < psi.length; k++) psi[k] = match.X[k] - glass.pos[k];
    // The final run, through the observed epoch to the end of the axis.
    const schedule = concatSchedules(
        buildSchedule({ aStart: recon.aInit, aEnd: aObs, steps: recon.stepsToObs, cosmo }),
        buildSchedule({ aStart: aObs, aEnd, steps: recon.stepsAfterObs, cosmo }));
    const n = glass.n;
    const group = new Uint8Array(n);
    // The ICs. 2LPT splits the matched Ψ into its linear part s₁ and the
    // second-order part D₂ₒs₂ that grew as D₁², and lays both down at aInit;
    // the galaxies' first guess then reads s₁ (their shots absorb the rest).
    let ic, lpt = null, galaxyPsi = psi;
    if ((recon.ics ?? 'za') === '2lpt') {
        onProgress?.('2lpt', 0, 1);
        const growth = lptGrowth(recon.aInit, aObs, cosmo);
        const h = 2 * glass.spacing;
        const inv = invert2LPT(glass.pos, psi, {
            d2Obs: growth.d2Obs, iterations: recon.lptIterations ?? 4,
            volume: Float64Array.from(glass.mass, (m) => m / rho),
            hsoft: Float64Array.from(glass.mass, () => h), h, ...sim,
        });
        let s1 = inv.s1, s2f = inv.s2, corr = 0;
        if (recon.growthKappa != null) {
            // The softened integrator grows mode k to T(k) < 1 of the ideal;
            // lay s₁ down as T⁻¹s₁ so it lands on today's field (plan §4g).
            const volume = Float64Array.from(glass.mass, (m) => m / rho);
            const ker = deconvolutionKernel({ h, aInit: recon.aInit, aObs, kappa: recon.growthKappa, cosmo });
            s1 = deconvolveGrowth(glass.pos, inv.s1, volume, ker);
            s2f = secondOrderDisplacement(glass.pos, s1, { volume, hsoft: Float64Array.from(glass.mass, () => h), h, ...sim });
            for (let k = 0; k < psi.length; k++) corr += (s1[k] - inv.s1[k]) ** 2;
        }
        ic = lptState(glass.pos, s1, s2f, recon.aInit, growth, cosmo);
        let s2 = 0;
        for (let k = 0; k < psi.length; k++) s2 += (growth.d2Obs * s2f[k]) ** 2;
        lpt = { history: inv.history, secondOrderRmsMpc: Math.sqrt(s2 / n), growthCorrectionRmsMpc: Math.sqrt(corr / n) };
        galaxyPsi = s1;
        onProgress?.('2lpt', 1, 1);
    } else {
        ic = zeldovichState(glass.pos, psi, recon.aInit, aObs, cosmo);
    }
    const run = createSimulation({
        pos: ic.pos, vel: ic.vel, mass: glass.mass, group, nMassive: n, aStart: recon.aInit,
        softening: [glass.softening, glass.softening], background, cosmo, ...sim,
    });
    const snapshots = [Float64Array.from(run.x)];
    for (let s = 0; s < schedule.steps; s++) {
        run.step(schedule, s);
        snapshots.push(Float64Array.from(run.x));
        onProgress?.('run', s + 1, schedule.steps);
    }
    // Today's gravity, reconstructed vs observed, at the galaxies.
    const field = fieldMatch({
        match, elements: snapshots[schedule.obsFrame], mass: glass.mass, softening: glass.softening,
        radius: glass.radius, points: testPoints, cosmo, ...sim,
    });
    let disp = 0;
    for (let k = 0; k < psi.length; k++) disp += psi[k] * psi[k];
    // The galaxies.
    const psi0 = interpolateDisplacement(testPoints, match.X, galaxyPsi, 2 * glass.spacing);
    const gal = shootGalaxies({
        snapshots, schedule, mass: glass.mass, group, nMassive: n,
        softening: [glass.softening, glass.softening], background, targets: testPoints, psi0,
        aObs, shots: recon.testShots, cosmo, ...sim,
        onProgress: (d, t) => onProgress?.('galaxies', d, t),
    });
    const nTest = testPoints.length / 3;
    const testPos = Float32Array.from(gal.rec.pos);
    const markers = nodeMarkers
        ? matterNearMarkers(snapshots, glass.mass,
            sliceRows(gal.rec.pos, nTest, nodeMarkers.from, nodeMarkers.count), nodeMarkers.count)
        : null;
    return {
        frames: schedule.steps + 1, nTest, N: schedule.N, a: schedule.a, obsFrame: schedule.obsFrame,
        testPos, rec: { ...gal.rec, split: false }, nRec: nTest, accreted: markers,
        snapshots, schedule, mass: glass.mass, group, nMassive: n,
        softening: [glass.softening, glass.softening], background,
        matched: match.X, psi: galaxyPsi, spacing: glass.spacing,
        diagnostics: {
            elements: n,
            aInit: recon.aInit,
            glassResidualMpc: glass.residual,
            matchResidualMpc: match.history[match.history.length - 1],
            displacementRmsMpc: Math.sqrt(disp / n),
            ics: recon.ics ?? 'za',
            secondOrderRmsMpc: lpt ? lpt.secondOrderRmsMpc : 0,
            lptHistory: lpt ? lpt.history : null,
            growthKappa: lpt && recon.growthKappa != null ? recon.growthKappa : null,
            growthCorrectionRmsMpc: lpt ? lpt.growthCorrectionRmsMpc : 0,
            fieldError: field.overall,
            fieldBins: field.bins,
            galaxyResidualsMpc: gal.residuals,
            seconds: (Date.now() - t0) / 1000,
        },
    };
}

/** Rows [from, from+count) of every frame of a frame-major 3-vector array. */
function sliceRows(arr, rowsPerFrame, from, count) {
    const frames = arr.length / (rowsPerFrame * 3);
    const out = new Float64Array(frames * count * 3);
    for (let f = 0; f < frames; f++) {
        out.set(arr.subarray((f * rowsPerFrame + from) * 3, (f * rowsPerFrame + from + count) * 3), f * count * 3);
    }
    return out;
}
