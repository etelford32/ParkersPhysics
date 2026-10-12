/**
 * bootes-nbody.js — a self-gravitating Boötes Void, forward in time
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no fetch, no ambient time, no three.js, no Worker. The page
 * runs it inside js/bootes/nbody-worker.js; `node tests/bootes-nbody.mjs`
 * runs it directly and pins every claim below.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The galaxy tracker's nonlinear mode (js/bootes-void-tracker.js) evolves the
 * void's SPHERICAL part exactly, but the cosmic web's lumpy pull rides on top
 * in LINEAR theory, and the web's own masses never move. This kernel removes
 * both limits for the FUTURE: every particle — the void's smooth matter and
 * the web's 802 mass particles — gravitates on every other in the expanding
 * ΛCDM background, so the web's pull is fully nonlinear and the web itself
 * responds (nodes accrete, filaments contract).
 *
 * THE EQUATIONS (comoving x in Mpc, canonical momentum p = a·u in km/s, where
 * u = a dx/dt is the peculiar velocity; N = ln a is the time variable)
 *
 *     dx/dN = p / (a² H)                 H in km/s/Mpc
 *     dp/dN = F(x) / (a H)
 *     F(x)  = Σ_j G m_j (x_j − x) / (|x_j − x|² + ε²)^{3/2}  −  F̄(x)
 *
 * F is the COMOVING force sum; the physical peculiar acceleration is F/a²
 * (a separation d_com is a·d_com physically — the same (1+z)² that
 * js/bootes-void-model.js `pointGravityVector` carries, by the same route).
 * F̄ is the pull of the MEAN density over the region the particles sample,
 * subtracted so only the PECULIAR force acts: the background's own pull is
 * what the expansion already is. F̄ is not the textbook −(4π/3)Gρ̄x — it is
 * the force of a Plummer-SOFTENED uniform sphere of the sampled radius,
 * integrated in closed form shell by shell (`softenedSphereForce`), so a
 * uniform particle sphere feels zero force everywhere INCLUDING its softened
 * edge. With the textbook term the edge particles were pushed by a spurious
 * ~ε-wide force no physics put there.
 *
 * The integrator is kick-drift-kick leapfrog in N with the drift and kick
 * coefficients ∫dN/(a²H) and ∫dN/(aH) integrated exactly over each sub-step
 * (Quinn et al. 1997) — symplectic in the comoving Hamiltonian, so the
 * expansion is not a source of step-size error.
 *
 * GRAVITY is a Barnes–Hut octree (leaf buckets, monopole about the centre of
 * mass, opening angle θ with the COM-offset safety term of Salmon & Warren
 * 1994: a node is accepted only if d > s/θ + |COM − centre|). The tree is
 * built per mass GROUP — group 0 the void's smooth matter, group 1 the web —
 * so the force on every particle splits EXACTLY into "the void's matter"
 * (group 0 minus the mean: the probe's deficit) and "the web" (group 1), the
 * same decomposition the force probe reports.
 *
 * TEST PARTICLES. The page's tracer galaxies are massless: they are walked
 * against the trees but never inserted. A galaxy cannot perturb the matter,
 * and `replayTestParticles` can therefore re-fly any new point through a
 * finished run's stored snapshots and land BITWISE on what an inline run
 * would have given (gated).
 *
 * INITIAL CONDITIONS (`buildInitialConditions`) are the OBSERVED state at
 * z_obs: a quiet start (concentric shells of Fibonacci directions, each shell
 * randomly rotated, masses carrying the density so positions carry no noise)
 * sampling ρ̄(1 + δ⁻), plus the web's own particles, with velocities from
 * the SAME two pieces the tracker uses — the exact spherical shell flow
 * (shellTable) plus the clumped part's linear growing mode. At z_obs the
 * N-body and the nonlinear tracker therefore agree by construction; after it
 * they part, and that difference IS the nonlinear web.
 *
 * WHAT THIS IS NOT, stated where it is used
 * ─────────────────────────────────────────
 *  - A forecast run starts at z_obs. The PAST is js/bootes-reconstruct.js:
 *    initial conditions at z = 9 found by matching a glass to today's field,
 *    run forward with this same kernel (BOOTES_VOID_PLAN.md §4e). Never
 *    integrate this kernel backwards instead — gravity amplifies every error
 *    into the past.
 *  - Collisionless matter only: no gas, no star formation, no feedback.
 *  - Softened at ε (the web's own particle spacing, ~11 Mpc): structure
 *    below ε is not resolved, and a node is a softened blob, not a cluster.
 *  - Matter beyond the sampled sphere (2.6 R_eff) is the MEAN, held fixed:
 *    web particles out there move, but nothing accretes onto them.
 *  - The particle masses are ~10¹⁴ M☉ — a galaxy is a TEST PARTICLE in this
 *    field, not a resolved halo.
 */

import {
    COSMOLOGY, G_SI, MPC_M, MSUN_KG, hubbleKmsMpc, growthRate, growthFactor,
    meanMatterDensityMsunMpc3, splitProfile, voidGravityVector, gravityRadialSI,
} from './bootes-void-model.js';
import { mulberry32 } from './bootes-web-model.js';
import { velocityPerAcceleration } from './bootes-force-probe.js';

/** G in Mpc (km/s)² / M☉. */
export const G_MPC = G_SI * MSUN_KG / (MPC_M * 1e6);

/** (km/s)²/Mpc → m/s². */
export const ACC_TO_SI = 1e6 / MPC_M;

export const DEFAULT_THETA = 0.6;
export const DEFAULT_LEAF = 8;

/**
 * Chebyshev-accelerated step sizes for a relaxation whose modes respond with
 * gains in [wMin, 1] (plan §4j): rate_j = 1/λ_j at the n Chebyshev nodes of
 * that interval, so the product Π(1 − rate_j·w) is the smallest polynomial on
 * it. Ordered largest, smallest, next largest, … so no stretch of large steps
 * runs unchecked (the transient a large step puts on the w ≈ 1 modes is taken
 * back by the next small one). A wMin of 0.15 or below grew the residual
 * transiently and dragged the profile; 0.25 converged monotonically.
 */
export function chebyshevRates(n, wMin) {
    const r = [];
    for (let j = 1; j <= n; j++) {
        r.push(1 / ((1 + wMin) / 2 + (1 - wMin) / 2 * Math.cos(Math.PI * (2 * j - 1) / (2 * n))));
    }
    r.sort((a, b) => a - b);
    const out = [];
    while (r.length) { out.push(r.pop()); if (r.length) out.push(r.shift()); }
    return out;
}

/**
 * The page's run, in one place so the worker, the panel and the gate cannot
 * drift apart. Measured on that configuration (tests/bootes-nbody.mjs):
 * ~36 000 massive particles + ~3 500 galaxies, ~0.6 s per step in V8 plus
 * ~13 s for the 20 relaxation passes (~30 s a run, in a Worker);
 * θ = 0.5 with quadrupoles keeps the force error at ~0.6 % of the rms
 * peculiar force; 24 steps are converged (6 steps are already within ~1 %).
 *   radius 2.6 R_eff   the smooth matter is sampled to where the tracers are
 *   spacing 12 Mpc     UNIFORM to the rim (plan §4i — the zoom it replaced
 *                      coarsened to 24 Mpc cells and its grain outweighed
 *                      the model's field on the wall)
 *   spline h = 24 Mpc  (2× spacing) — the smooth matter's resolution
 *   relax 20 passes    the quiet start's non-spherical grain relaxed away,
 *                      its profile kept (`createRelaxer`); the step sizes are
 *                      the Chebyshev schedule over [0.25, 1] (plan §4j)
 */
export const PAGE_CONFIG = Object.freeze({
    // UNIFORM 12 Mpc to the rim (plan §4i): the zoom that coarsened to 24 Mpc
    // cells beyond 1.3 R_eff sampled the wall's field 172–629 % off the exact
    // model (it is small there: the void and its wall nearly cancel).
    ic: (rEffMpc) => ({ radius: 2.6 * rEffMpc, spacing: 12, refineRadius: Infinity, seed: 7 }),
    // …and its lattice grain RELAXED away before the run (`createRelaxer`).
    // The step sizes are a Chebyshev schedule (plan §4j): a fixed 0.7 left the
    // grain the softening barely feels — the floor that IS the rim's error.
    relax: Object.freeze({ iterations: 20, rates: Object.freeze(chebyshevRates(20, 0.25)) }),
    sim: Object.freeze({ theta: 0.5, leafSize: 16 }),
    steps: 24,
});

// ── Barnes–Hut octree ───────────────────────────────────────────────────────

/**
 * Build an octree over the particles listed in `members` (indices into the
 * flat `pos` (3n) and `mass` (n) arrays). Flat typed arrays, children stored
 * contiguously, nodes allocated breadth-first so every child index exceeds
 * its parent's — which is what lets the mass moments be filled in ONE reverse
 * sweep.
 */
export function buildTree(pos, mass, members, { leafSize = DEFAULT_LEAF, hsoft = null } = {}) {
    const n = members.length;
    const perm = Int32Array.from(members);
    let cap = Math.max(64, Math.ceil(n / 2) + 16);
    let cx = new Float64Array(cap), cy = new Float64Array(cap), cz = new Float64Array(cap);
    let gx = new Float64Array(cap), gy = new Float64Array(cap), gz = new Float64Array(cap);
    let half = new Float64Array(cap), m = new Float64Array(cap), off = new Float64Array(cap);
    // Traceless quadrupole about the COM: Q_ij = Σ m (3 s_i s_j − s² δ_ij),
    // stored as xx, yy, xy, xz, yz (zz = −xx − yy).
    let q = new Float64Array(cap * 5);
    let start = new Int32Array(cap), end = new Int32Array(cap);
    let child = new Int32Array(cap), nChild = new Int32Array(cap);
    const grow = () => {
        const nc = cap * 2;
        const g64 = (a) => { const b = new Float64Array(nc); b.set(a); return b; };
        const g32 = (a) => { const b = new Int32Array(nc); b.set(a); return b; };
        cx = g64(cx); cy = g64(cy); cz = g64(cz); gx = g64(gx); gy = g64(gy); gz = g64(gz);
        half = g64(half); m = g64(m); off = g64(off);
        { const b = new Float64Array(nc * 5); b.set(q); q = b; }
        start = g32(start); end = g32(end); child = g32(child); nChild = g32(nChild);
        cap = nc;
    };
    if (n === 0) {
        return { count: 0, perm, cx, cy, cz, m, q, half, off, start, end, child, nChild, pos, mass, hsoft, hmax: null };
    }

    // Root cube: the bounding box, made cubic and padded so no particle sits
    // exactly on a face.
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n; k++) {
        const i = perm[k] * 3;
        for (let d = 0; d < 3; d++) {
            const v = pos[i + d];
            if (v < lo[d]) lo[d] = v;
            if (v > hi[d]) hi[d] = v;
        }
    }
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 1e-6);
    let count = 1;
    gx[0] = 0.5 * (lo[0] + hi[0]); gy[0] = 0.5 * (lo[1] + hi[1]); gz[0] = 0.5 * (lo[2] + hi[2]);
    half[0] = 0.5 * span * 1.0001;
    start[0] = 0; end[0] = n; child[0] = -1; nChild[0] = 0;

    const tmp = new Int32Array(n);
    const oct = new Uint8Array(n);
    const counts = new Int32Array(8);
    const offs = new Int32Array(8);
    for (let node = 0; node < count; node++) {
        const s = start[node], e = end[node];
        // A minimum cell size stops coincident particles splitting forever.
        if (e - s <= leafSize || half[node] < 1e-7) continue;
        counts.fill(0);
        const ox = gx[node], oy = gy[node], oz = gz[node];
        for (let k = s; k < e; k++) {
            const i = perm[k] * 3;
            const o = (pos[i] >= ox ? 1 : 0) | (pos[i + 1] >= oy ? 2 : 0) | (pos[i + 2] >= oz ? 4 : 0);
            oct[k] = o;
            counts[o]++;
        }
        let acc = s;
        for (let o = 0; o < 8; o++) { offs[o] = acc; acc += counts[o]; }
        const cursor = Int32Array.from(offs);
        for (let k = s; k < e; k++) tmp[cursor[oct[k]]++] = perm[k];
        for (let k = s; k < e; k++) perm[k] = tmp[k];
        const h = half[node] * 0.5;
        child[node] = count;
        let made = 0;
        for (let o = 0; o < 8; o++) {
            if (!counts[o]) continue;
            if (count >= cap) grow();
            const c = count++;
            gx[c] = ox + ((o & 1) ? h : -h);
            gy[c] = oy + ((o & 2) ? h : -h);
            gz[c] = oz + ((o & 4) ? h : -h);
            half[c] = h;
            start[c] = offs[o]; end[c] = offs[o] + counts[o];
            child[c] = -1; nChild[c] = 0;
            made++;
        }
        nChild[node] = made;
    }

    // Moments, children before parents.
    for (let node = count - 1; node >= 0; node--) {
        let M = 0, X = 0, Y = 0, Z = 0;
        if (child[node] < 0) {
            for (let k = start[node]; k < end[node]; k++) {
                const j = perm[k];
                const mj = mass[j];
                M += mj; X += mj * pos[j * 3]; Y += mj * pos[j * 3 + 1]; Z += mj * pos[j * 3 + 2];
            }
        } else {
            for (let c = child[node]; c < child[node] + nChild[node]; c++) {
                M += m[c]; X += m[c] * cx[c]; Y += m[c] * cy[c]; Z += m[c] * cz[c];
            }
        }
        m[node] = M;
        if (M > 0) { cx[node] = X / M; cy[node] = Y / M; cz[node] = Z / M; }
        else { cx[node] = gx[node]; cy[node] = gy[node]; cz[node] = gz[node]; }
        off[node] = Math.hypot(cx[node] - gx[node], cy[node] - gy[node], cz[node] - gz[node]);
        // Quadrupole: particles in a leaf, the parallel-axis sum otherwise.
        let qxx = 0, qyy = 0, qxy = 0, qxz = 0, qyz = 0;
        const addPoint = (mj, sx, sy, sz) => {
            const s2 = sx * sx + sy * sy + sz * sz;
            qxx += mj * (3 * sx * sx - s2); qyy += mj * (3 * sy * sy - s2);
            qxy += mj * 3 * sx * sy; qxz += mj * 3 * sx * sz; qyz += mj * 3 * sy * sz;
        };
        if (child[node] < 0) {
            for (let k = start[node]; k < end[node]; k++) {
                const j = perm[k];
                addPoint(mass[j], pos[j * 3] - cx[node], pos[j * 3 + 1] - cy[node], pos[j * 3 + 2] - cz[node]);
            }
        } else {
            for (let c = child[node]; c < child[node] + nChild[node]; c++) {
                addPoint(m[c], cx[c] - cx[node], cy[c] - cy[node], cz[c] - cz[node]);
                qxx += q[5 * c]; qyy += q[5 * c + 1]; qxy += q[5 * c + 2]; qxz += q[5 * c + 3]; qyz += q[5 * c + 4];
            }
        }
        q[5 * node] = qxx; q[5 * node + 1] = qyy; q[5 * node + 2] = qxy;
        q[5 * node + 3] = qxz; q[5 * node + 4] = qyz;
    }
    // Per-particle softening: the largest h in each cell, children first.
    let hmax = null;
    if (hsoft) {
        hmax = new Float64Array(count);
        for (let node = count - 1; node >= 0; node--) {
            let h = 0;
            if (child[node] < 0) {
                for (let k = start[node]; k < end[node]; k++) h = Math.max(h, hsoft[perm[k]]);
            } else {
                for (let c = child[node]; c < child[node] + nChild[node]; c++) h = Math.max(h, hmax[c]);
            }
            hmax[node] = h;
        }
    }
    return { count, perm, cx, cy, cz, m, q, half, off, start, end, child, nChild, pos, mass, hsoft, hmax };
}

const STACK = new Int32Array(1 << 14);

/**
 * A softening kernel, per SOURCE group.
 *   { kind: 'plummer', eps }  — the web. IDENTICAL to js/bootes-void-model.js
 *       `pointGravityVector`, so the N-body's web force at z_obs is the force
 *       probe's web force (gated) and the tracker modes join continuously.
 *   { kind: 'spline', h }     — the void's smooth matter. Gadget-2's cubic
 *       spline (Springel 2005): EXACTLY Newtonian beyond h. NOT Plummer here,
 *       and that is measured, not taste: a Plummer kernel's density tail falls
 *       only as r⁻⁵, so its second moment diverges and smoothing a void with
 *       it weakens the deficit's pull by ~ε²·ln — 4 % at ε = 4.8 Mpc and 26 %
 *       at ε = 12 Mpc in a full-history run, against the exact shell solution.
 *       A compact kernel changes nothing beyond h, so a spherical void keeps
 *       Gauss's law to O(h²∇²δ).
 * Each source is smoothed at its own resolution ("source softening"), so the
 * pair force between the two groups is not exactly antisymmetric and total
 * Newton's third law holds only to the tree's accuracy (measured, gated).
 */
export const plummer = (eps) => Object.freeze({ kind: 'plummer', eps });
export const spline = (h) => Object.freeze({ kind: 'spline', h });
/**
 * Spline softening PER SOURCE PARTICLE: `h` is a Float64Array indexed like
 * the mass array, `hEdge` the h the mean sphere is smoothed with at its rim.
 * For a zoom whose spacing grows outward, a single h is either too coarse in
 * the core or below the spacing in the outskirts — and below the spacing the
 * field is grainy enough to trap a test particle (measured: galaxies beyond
 * 1.6 R_eff did not converge in the reconstruction until h followed spacing).
 */
export const splinePerParticle = (h, hEdge) => Object.freeze({ kind: 'spline-per-particle', h, hEdge });

/**
 * Comoving force sum at (x, y, z): Σ G m K(d) d, (km/s)²/Mpc, monopole +
 * quadrupole on accepted nodes. Adds into out[o..o+2] (so per-group sums
 * compose). A particle sitting on itself contributes exactly zero (d = 0),
 * so no self-exclusion is needed.
 */
export function treeForce(tree, x, y, z, theta, soft, out, o = 0) {
    if (!tree.count) return out;
    const { cx, cy, cz, m, q, half, off, start, end, child, nChild, perm, pos, mass } = tree;
    if (soft.kind === 'spline-per-particle') {
        return treeForcePerParticle(tree, x, y, z, theta, out, o);
    }
    const invTheta = 1 / theta;
    const isPlummer = soft.kind === 'plummer';
    const e2 = isPlummer ? soft.eps * soft.eps : 0;
    const h = isPlummer ? 0 : soft.h;
    const h2 = h * h, hinv = h ? 1 / h : 0, hinv3 = hinv * hinv * hinv;
    let fx = 0, fy = 0, fz = 0;
    let sp = 0;
    STACK[sp++] = 0;
    while (sp) {
        const node = STACK[--sp];
        const dx = cx[node] - x, dy = cy[node] - y, dz = cz[node] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const crit = 2 * half[node] * invTheta + off[node];
        if (d2 > crit * crit) {
            // Monopole.
            let fac, quadOk = true, r2q;
            if (isPlummer) { r2q = d2 + e2; fac = 1 / (r2q * Math.sqrt(r2q)); }
            else if (d2 >= h2) { r2q = d2; fac = 1 / (d2 * Math.sqrt(d2)); }
            else { fac = splineFac(Math.sqrt(d2) * hinv, hinv3); quadOk = false; }
            const f = G_MPC * m[node] * fac;
            fx += f * dx; fy += f * dy; fz += f * dz;
            if (quadOk) {
                // Quadrupole (dx points AT the node), Plummer-softened by
                // r² → r² + ε²; for the spline, only where it is Newtonian:
                //   g_Q = G [ −Q·dx / r⁵ + (5/2)(dxᵀQdx) dx / r⁷ ]
                const ir2 = 1 / r2q;
                const ir5 = fac * ir2;
                const b = 5 * node;
                const qxx = q[b], qyy = q[b + 1], qxy = q[b + 2], qxz = q[b + 3], qyz = q[b + 4];
                const qzz = -qxx - qyy;
                const Qx = qxx * dx + qxy * dy + qxz * dz;
                const Qy = qxy * dx + qyy * dy + qyz * dz;
                const Qz = qxz * dx + qyz * dy + qzz * dz;
                const quad = 2.5 * (dx * Qx + dy * Qy + dz * Qz) * ir5 * ir2;
                fx += G_MPC * (quad * dx - Qx * ir5);
                fy += G_MPC * (quad * dy - Qy * ir5);
                fz += G_MPC * (quad * dz - Qz * ir5);
            }
        } else if (child[node] < 0) {
            for (let k = start[node]; k < end[node]; k++) {
                const j = perm[k];
                const ex = pos[j * 3] - x, ey = pos[j * 3 + 1] - y, ez = pos[j * 3 + 2] - z;
                const r2 = ex * ex + ey * ey + ez * ez;
                let fac;
                if (isPlummer) { const r2s = r2 + e2; fac = 1 / (r2s * Math.sqrt(r2s)); }
                else if (r2 >= h2) fac = 1 / (r2 * Math.sqrt(r2));
                else fac = splineFac(Math.sqrt(r2) * hinv, hinv3);
                const f = G_MPC * mass[j] * fac;
                fx += f * ex; fy += f * ey; fz += f * ez;
            }
        } else {
            for (let c = child[node]; c < child[node] + nChild[node]; c++) STACK[sp++] = c;
        }
    }
    out[o] += fx; out[o + 1] += fy; out[o + 2] += fz;
    return out;
}

/**
 * The per-particle spline walk: every SOURCE carries its own h (`hsoft`, the
 * zoom's local spacing × 2). A cell is accepted as a multipole only when the
 * field point lies outside the largest h it contains — so every accepted
 * interaction is exactly Newtonian and the quadrupole always applies — and a
 * leaf is summed with each source's own kernel.
 */
function treeForcePerParticle(tree, x, y, z, theta, out, o) {
    const { cx, cy, cz, m, q, half, off, start, end, child, nChild, perm, pos, mass, hsoft, hmax } = tree;
    const invTheta = 1 / theta;
    let fx = 0, fy = 0, fz = 0;
    let sp = 0;
    STACK[sp++] = 0;
    while (sp) {
        const node = STACK[--sp];
        const dx = cx[node] - x, dy = cy[node] - y, dz = cz[node] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const crit = 2 * half[node] * invTheta + off[node];
        if (d2 > crit * crit && d2 >= hmax[node] * hmax[node]) {
            const ir2 = 1 / d2;
            const fac = ir2 * Math.sqrt(ir2);
            const f = G_MPC * m[node] * fac;
            const ir5 = fac * ir2;
            const b = 5 * node;
            const qxx = q[b], qyy = q[b + 1], qxy = q[b + 2], qxz = q[b + 3], qyz = q[b + 4];
            const qzz = -qxx - qyy;
            const Qx = qxx * dx + qxy * dy + qxz * dz;
            const Qy = qxy * dx + qyy * dy + qyz * dz;
            const Qz = qxz * dx + qyz * dy + qzz * dz;
            const quad = 2.5 * (dx * Qx + dy * Qy + dz * Qz) * ir5 * ir2;
            fx += f * dx + G_MPC * (quad * dx - Qx * ir5);
            fy += f * dy + G_MPC * (quad * dy - Qy * ir5);
            fz += f * dz + G_MPC * (quad * dz - Qz * ir5);
        } else if (child[node] < 0) {
            for (let k = start[node]; k < end[node]; k++) {
                const j = perm[k];
                const ex = pos[j * 3] - x, ey = pos[j * 3 + 1] - y, ez = pos[j * 3 + 2] - z;
                const r2 = ex * ex + ey * ey + ez * ez;
                const h = hsoft[j];
                let fac;
                if (r2 >= h * h) fac = 1 / (r2 * Math.sqrt(r2));
                else { const hi = 1 / h; fac = splineFac(Math.sqrt(r2) * hi, hi * hi * hi); }
                const f = G_MPC * mass[j] * fac;
                fx += f * ex; fy += f * ey; fz += f * ez;
            }
        } else {
            for (let c = child[node]; c < child[node] + nChild[node]; c++) STACK[sp++] = c;
        }
    }
    out[o] += fx; out[o + 1] += fy; out[o + 2] += fz;
    return out;
}

/** Gadget-2 spline force factor inside h (force = G m · fac · d). */
function splineFac(u, hinv3) {
    return u < 0.5
        ? hinv3 * (10.666666666667 + u * u * (32.0 * u - 38.4))
        : hinv3 * (21.333333333333 - 48.0 * u + 38.4 * u * u
            - 10.666666666667 * u * u * u - 0.066666666667 / (u * u * u));
}

/** The same sum by brute force — the oracle the tree is gated against. */
export function directForce(pos, mass, members, x, y, z, soft, out, o = 0) {
    if (soft.kind === 'spline-per-particle') {
        let fx = 0, fy = 0, fz = 0;
        for (let k = 0; k < members.length; k++) {
            const j = members[k];
            const ex = pos[j * 3] - x, ey = pos[j * 3 + 1] - y, ez = pos[j * 3 + 2] - z;
            const r2 = ex * ex + ey * ey + ez * ez;
            const h = soft.h[j];
            let fac;
            if (r2 >= h * h) fac = 1 / (r2 * Math.sqrt(r2));
            else { const hi = 1 / h; fac = splineFac(Math.sqrt(r2) * hi, hi * hi * hi); }
            const f = G_MPC * mass[j] * fac;
            fx += f * ex; fy += f * ey; fz += f * ez;
        }
        out[o] += fx; out[o + 1] += fy; out[o + 2] += fz;
        return out;
    }
    const isPlummer = soft.kind === 'plummer';
    const e2 = isPlummer ? soft.eps * soft.eps : 0;
    const h = isPlummer ? 0 : soft.h;
    const hinv = h ? 1 / h : 0, hinv3 = hinv * hinv * hinv;
    let fx = 0, fy = 0, fz = 0;
    for (let k = 0; k < members.length; k++) {
        const j = members[k];
        const ex = pos[j * 3] - x, ey = pos[j * 3 + 1] - y, ez = pos[j * 3 + 2] - z;
        const r2 = ex * ex + ey * ey + ez * ez;
        let fac;
        if (isPlummer) { const r2s = r2 + e2; fac = 1 / (r2s * Math.sqrt(r2s)); }
        else if (r2 >= h * h) fac = 1 / (r2 * Math.sqrt(r2));
        else fac = splineFac(Math.sqrt(r2) * hinv, hinv3);
        const f = G_MPC * mass[j] * fac;
        fx += f * ex; fy += f * ey; fz += f * ez;
    }
    out[o] += fx; out[o + 1] += fy; out[o + 2] += fz;
    return out;
}

/** Gadget-2's spline density kernel W(r; h), normalised to unit mass. */
export function splineDensity(r, h) {
    const u = r / h;
    if (u >= 1) return 0;
    const k = 8 / (Math.PI * h * h * h);
    return u < 0.5 ? k * (1 - 6 * u * u + 6 * u * u * u) : k * 2 * (1 - u) ** 3;
}

// ── The mean-density subtraction ────────────────────────────────────────────

/**
 * Radial comoving force (negative = inward) of a uniform sphere of comoving
 * density `rho` and radius R, smoothed by the source group's kernel — so a
 * uniform particle sphere feels zero peculiar force everywhere, INCLUDING its
 * smoothed edge. Dispatches on the kernel.
 */
export function meanSphereForce(R, rho, soft, opts) {
    if (soft.kind === 'plummer') return softenedSphereForce(R, rho, soft.eps, opts);
    // Per-particle h: the smoothing that matters is the rim's.
    return splineSphereForce(R, rho, soft.kind === 'spline-per-particle' ? soft.hEdge : soft.h, opts);
}

/**
 * Spline-smoothed uniform sphere. A spline-softened force IS the Newtonian
 * force of the density convolved with W, so F(r) = −G M_s(<r) / r² with
 * ρ_s(r) = ρ ∫ W(s) · (fraction of the s-sphere about r inside R) d³s — the
 * fraction is the spherical-cap area (R² − (r − s)²) / (4rs). Exactly
 * −(4π/3)Gρr wherever r < R − h.
 */
export function splineSphereForce(R, rho, h, { nodes = 2400 } = {}) {
    const rTop = R + h;
    const dr = rTop / nodes;
    const ks = 64;
    const rhoS = new Float64Array(nodes + 1);
    for (let i = 0; i <= nodes; i++) {
        const r = i * dr;
        if (r + h <= R) { rhoS[i] = rho; continue; }
        let sum = 0;
        const ds = h / ks;
        for (let k = 0; k <= ks; k++) {
            const sk = k * ds;
            const w = (k === 0 || k === ks) ? 1 : (k % 2 ? 4 : 2);
            let frac;
            if (r + sk <= R) frac = 1;
            else if (r - sk >= R) frac = 0;
            else frac = r > 0 ? (R * R - (r - sk) * (r - sk)) / (4 * r * sk) : 1;
            sum += w * 4 * Math.PI * sk * sk * splineDensity(sk, h) * frac;
        }
        rhoS[i] = rho * sum * ds / 3;
    }
    const M = new Float64Array(nodes + 1);
    for (let i = 1; i <= nodes; i++) {
        const ra = (i - 1) * dr, rb = i * dr;
        M[i] = M[i - 1] + 0.5 * (4 * Math.PI * ra * ra * rhoS[i - 1] + 4 * Math.PI * rb * rb * rhoS[i]) * dr;
    }
    const Mtot = (4 / 3) * Math.PI * rho * R ** 3;
    return (r) => {
        if (r <= 0) return 0;
        if (r + h <= R) return -(4 / 3) * Math.PI * G_MPC * rho * r;
        if (r >= rTop) return -G_MPC * Mtot / (r * r);
        const x = r / dr;
        const i = Math.min(nodes - 1, Math.floor(x));
        const t = x - i;
        return -G_MPC * (M[i] + t * (M[i + 1] - M[i])) / (r * r);
    };
}

/**
 * Radial comoving force of a Plummer-softened uniform sphere of comoving
 * density `rho` (M☉/Mpc³) and radius R, as a function r → F_r (negative =
 * inward). Built from the closed-form potential of a softened thin shell,
 *
 *     Φ_s(r) = −(G M_s / 2rR′) [√((r+R′)² + ε²) − √((r−R′)² + ε²)],
 *
 * differentiated analytically and integrated over R′ ∈ [0, R] by Simpson.
 * Tabulated on [0, 3R]; beyond, the softened point mass (exact to O(R²/r²)
 * of a quantity that is already 1/r² small).
 */
export function softenedSphereForce(R, rho, eps, { nodes = 1600, panels = 600 } = {}) {
    const rTop = 3 * R;
    const dr = rTop / nodes;
    const table = new Float64Array(nodes + 1);
    const e2 = eps * eps;
    const h = R / panels;
    const Mtot = (4 / 3) * Math.PI * rho * R * R * R;
    for (let i = 1; i <= nodes; i++) {
        const r = i * dr;
        let sum = 0;
        for (let k = 1; k <= panels; k++) {             // R′ = 0 contributes 0
            const Rp = k * h;
            const w = k === panels ? 1 : (k % 2 ? 4 : 2);
            const A = Math.sqrt((r + Rp) * (r + Rp) + e2);
            const B = Math.sqrt((r - Rp) * (r - Rp) + e2);
            // dΦ_s/dr per unit G·dM_s, with dM_s = 4πρR′²dR′:
            //   (A − B)/(2r²R′) − ((r+R′)/A − (r−R′)/B)/(2rR′)
            const dPhi = (A - B) / (2 * r * r * Rp) - ((r + Rp) / A - (r - Rp) / B) / (2 * r * Rp);
            sum += w * 4 * Math.PI * rho * Rp * Rp * dPhi;
        }
        table[i] = -G_MPC * sum * h / 3;
    }
    return (r) => {
        if (r <= 0) return 0;
        if (r >= rTop) return -G_MPC * Mtot * r / Math.pow(r * r + e2, 1.5);
        const x = r / dr;
        const i = Math.floor(x);
        const t = x - i;
        return table[i] + t * (table[i + 1] - table[i]);
    };
}

// ── Time integration ────────────────────────────────────────────────────────

/** ∫ f(a) dN over [N0, N1] by Simpson (smooth integrand: 8 panels is ~1e-12). */
function integrateN(N0, N1, f, panels = 8) {
    const h = (N1 - N0) / panels;
    let s = 0;
    for (let k = 0; k <= panels; k++) {
        const w = (k === 0 || k === panels) ? 1 : (k % 2 ? 4 : 2);
        s += w * f(Math.exp(N0 + k * h));
    }
    return s * h / 3;
}

/**
 * KDK step schedule, uniform in N = ln a. For each step: the two half-kick
 * coefficients ∫dN/(aH) and the drift coefficient ∫dN/(a²H) (Mpc per km/s).
 */
export function buildSchedule({ aStart, aEnd, steps, cosmo = COSMOLOGY }) {
    const N0 = Math.log(aStart), N1 = Math.log(aEnd);
    const H = (a) => hubbleKmsMpc(1 / a - 1, cosmo);
    const kickF = (a) => 1 / (a * H(a));
    const driftF = (a) => 1 / (a * a * H(a));
    const N = new Float64Array(steps + 1);
    const kick1 = new Float64Array(steps), kick2 = new Float64Array(steps), drift = new Float64Array(steps);
    for (let s = 0; s <= steps; s++) N[s] = N0 + (N1 - N0) * s / steps;
    for (let s = 0; s < steps; s++) {
        const mid = 0.5 * (N[s] + N[s + 1]);
        kick1[s] = integrateN(N[s], mid, kickF);
        kick2[s] = integrateN(mid, N[s + 1], kickF);
        drift[s] = integrateN(N[s], N[s + 1], driftF);
    }
    const a = Float64Array.from(N, Math.exp);
    return { steps, N, a, kick1, kick2, drift, cosmo };
}

/** Sorted radii + cumulative mass, for the spherical solver. */
function sphericalShells(x, mass, members) {
    const n = members.length;
    const r = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const j = members[k];
        r[k] = Math.hypot(x[3 * j], x[3 * j + 1], x[3 * j + 2]);
    }
    const order = Array.from({ length: n }, (_, k) => k).sort((a, b) => r[a] - r[b]);
    const rs = new Float64Array(n), cum = new Float64Array(n + 1);
    order.forEach((k, idx) => { rs[idx] = r[k]; cum[idx + 1] = cum[idx] + mass[members[k]]; });
    return {
        /** Mass strictly inside r, plus HALF of any mass exactly at r. */
        enclosed(R) {
            let lo = 0, hi = n;
            while (lo < hi) { const mid = (lo + hi) >> 1; if (rs[mid] < R) lo = mid + 1; else hi = mid; }
            let top = lo;
            while (top < n && rs[top] === R) top++;
            return cum[lo] + 0.5 * (cum[top] - cum[lo]);
        },
    };
}

/**
 * A simulation over `nMassive` massive particles followed by `nTest`
 * massless ones, all in flat arrays:
 *   pos  Float64Array 3(nMassive + nTest)   comoving Mpc
 *   vel  Float64Array 3(…)                  peculiar u, km/s, at aStart
 *   mass Float64Array nMassive              M☉
 *   group Uint8Array nMassive               0 = void's matter, 1 = web
 * `background` = { radius, rho } — the mean-density sphere to subtract.
 */
export function createSimulation({
    pos, vel, mass, group, nMassive, aStart, softening, theta = DEFAULT_THETA,
    leafSize = DEFAULT_LEAF, background = null, cosmo = COSMOLOGY, solver = 'tree',
}) {
    const n = pos.length / 3;
    const [soft0, soft1] = softening;
    if (solver !== 'tree' && solver !== 'spherical') throw new Error(`unknown solver ${solver}`);
    const x = Float64Array.from(pos);
    const p = new Float64Array(3 * n);
    for (let k = 0; k < 3 * n; k++) p[k] = aStart * vel[k];
    const fBg = new Float64Array(3 * n);           // group 0 − mean
    const fWeb = new Float64Array(3 * n);          // group 1
    const members = [[], []];
    for (let i = 0; i < nMassive; i++) members[group[i] ? 1 : 0].push(i);
    const memberArrays = members.map(a => Int32Array.from(a));
    const sphere = background ? meanSphereForce(background.radius, background.rho, soft0) : null;
    let a = aStart;

    function trees() {
        if (solver === 'spherical') return memberArrays.map(mem => sphericalShells(x, mass, mem));
        return memberArrays.map((mem, g) => buildTree(x, mass, mem, {
            leafSize, hsoft: softening[g].kind === 'spline-per-particle' ? softening[g].h : null,
        }));
    }

    /** Forces on particles [from, to) against the given trees. */
    function forces(tr, from = 0, to = n) {
        if (solver === 'spherical') return sphericalForces(tr, from, to);
        for (let i = from; i < to; i++) {
            const o = 3 * i;
            fBg[o] = fBg[o + 1] = fBg[o + 2] = 0;
            fWeb[o] = fWeb[o + 1] = fWeb[o + 2] = 0;
            treeForce(tr[0], x[o], x[o + 1], x[o + 2], theta, soft0, fBg, o);
            treeForce(tr[1], x[o], x[o + 1], x[o + 2], theta, soft1, fWeb, o);
            if (sphere) {
                const r = Math.hypot(x[o], x[o + 1], x[o + 2]);
                if (r > 0) {
                    const s = -sphere(r) / r;            // minus the mean's pull
                    fBg[o] += s * x[o]; fBg[o + 1] += s * x[o + 1]; fBg[o + 2] += s * x[o + 2];
                }
            }
        }
    }

    /**
     * The SPHERICAL solver: Gauss's law on the particles' own enclosed mass,
     * unsoftened, minus the mean — no tree, no kernel, no discreteness noise.
     * It exists so the INTEGRATOR (schedule, kick/drift coefficients, ICs,
     * mean subtraction) can be gated against the exact shell ODE from z ≈ 19
     * with nothing else in the way; the tree is gated separately.
     */
    function sphericalForces(tr, from, to) {
        const R = background ? background.radius : Infinity;
        const rho = background ? background.rho : 0;
        for (let i = from; i < to; i++) {
            const o = 3 * i;
            const r = Math.hypot(x[o], x[o + 1], x[o + 2]);
            // A particle stands for the mass across its own stratum, half of
            // which lies inside it: `enclosed` counts half of any mass AT r,
            // the particle's own included. Excluding it instead (the point-
            // mass habit) shifted a z = 19 shell's end radius by 0.1 %.
            const enc = (k) => tr[k].enclosed(r);
            const mBar = (4 / 3) * Math.PI * rho * Math.min(r, R) ** 3;
            const s0 = r > 0 ? -G_MPC * (enc(0) - mBar) / (r * r * r) : 0;
            const s1 = r > 0 ? -G_MPC * enc(1) / (r * r * r) : 0;
            for (let d = 0; d < 3; d++) { fBg[o + d] = s0 * x[o + d]; fWeb[o + d] = s1 * x[o + d]; }
        }
    }

    let current = trees();
    forces(current);

    function kick(coef) {
        for (let k = 0; k < 3 * n; k++) p[k] += (fBg[k] + fWeb[k]) * coef;
    }
    function drift(coef) {
        for (let k = 0; k < 3 * n; k++) x[k] += p[k] * coef;
    }

    return {
        n, nMassive, x, p, fBg, fWeb, mass, group, softening, theta,
        get a() { return a; },
        get trees() { return current; },
        /**
         * Rebuild the trees and every force at the CURRENT positions, with no
         * dynamics — the reconstruction's relaxation moves `x` itself.
         */
        refreshForces() {
            current = trees();
            forces(current);
        },
        /** One KDK step `s` of `schedule`. */
        step(schedule, s) {
            kick(schedule.kick1[s]);
            drift(schedule.drift[s]);
            a = schedule.a[s + 1];
            current = trees();
            forces(current);
            kick(schedule.kick2[s]);
        },
        /**
         * One KDK step for the TEST half only, against a given massive
         * snapshot (the replay path). Same arithmetic, in the same order, as
         * `step` performs on a test particle — so the two agree bit for bit.
         */
        stepTestOnly(schedule, s, massiveNext) {
            const lo = 3 * nMassive, hi = 3 * n;
            const c1 = schedule.kick1[s], dc = schedule.drift[s], c2 = schedule.kick2[s];
            for (let k = lo; k < hi; k++) p[k] += (fBg[k] + fWeb[k]) * c1;
            for (let k = lo; k < hi; k++) x[k] += p[k] * dc;
            x.set(massiveNext);
            a = schedule.a[s + 1];
            current = trees();
            forces(current, nMassive, n);
            for (let k = lo; k < hi; k++) p[k] += (fBg[k] + fWeb[k]) * c2;
        },
        /** Peculiar velocity u = p / a, km/s, of particle i. */
        velocity(i) { return [p[3 * i] / a, p[3 * i + 1] / a, p[3 * i + 2] / a]; },
        /** Physical peculiar acceleration of particle i, m/s², split. */
        acceleration(i) {
            const k = ACC_TO_SI / (a * a), o = 3 * i;
            const bg = [fBg[o] * k, fBg[o + 1] * k, fBg[o + 2] * k];
            const web = [fWeb[o] * k, fWeb[o + 1] * k, fWeb[o + 2] * k];
            return { total: bg.map((c, j) => c + web[j]), void: bg, web };
        },
    };
}

/**
 * Enclosed-contrast measurer for one snapshot: Δ(<r) about the origin from
 * the massive particles, plus the implicit mean beyond the sampled sphere.
 */
export function enclosedContrast(x, mass, nMassive, { rho, radius }) {
    const r = new Float64Array(nMassive);
    for (let i = 0; i < nMassive; i++) r[i] = Math.hypot(x[3 * i], x[3 * i + 1], x[3 * i + 2]);
    const order = Array.from(r.keys()).sort((i, j) => r[i] - r[j]);
    const rs = new Float64Array(nMassive), cum = new Float64Array(nMassive);
    let acc = 0;
    order.forEach((i, k) => { acc += mass[i]; rs[k] = r[i]; cum[k] = acc; });
    return (R) => {
        let lo = 0, hi = nMassive;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (rs[mid] <= R) lo = mid + 1; else hi = mid; }
        const M = lo ? cum[lo - 1] : 0;
        const vol = (4 / 3) * Math.PI * R * R * R;
        const implicit = R > radius ? (4 / 3) * Math.PI * rho * (R ** 3 - radius ** 3) : 0;
        return (M + implicit) / (rho * vol) - 1;
    };
}

/**
 * Run a simulation through a schedule, recording a frame at every step.
 *   record         Int32Array of TEST-particle indices (0-based among tests)
 *                  whose velocity, split acceleration and Δ(<r) are kept.
 *   keepSnapshots  keep every massive snapshot (Float64) for replays.
 *   accretion      { nodes: Int32Array of massive indices, radiusMpc } —
 *                  smooth mass near those nodes, per frame.
 * Returns plain typed arrays, so a worker can transfer them.
 *
 * `createRun` is the same thing one step at a time (the worker reports
 * progress between steps; the no-Worker fallback yields to the page between
 * them); `runSimulation` drives it to the end.
 */
export function createRun(sim, schedule, {
    record = new Int32Array(0), keepSnapshots = false, background = null,
    webIndices = null, accretion = null,
} = {}) {
    const { nMassive, n } = sim;
    const nTest = n - nMassive;
    const frames = schedule.steps + 1;
    const testPos = new Float32Array(frames * nTest * 3);
    const web = webIndices ?? Int32Array.from(
        Array.from({ length: nMassive }, (_, i) => i).filter(i => sim.group[i] === 1));
    const webPos = new Float32Array(frames * web.length * 3);
    const nr = record.length;
    const rec = {
        pos: new Float64Array(frames * nr * 3),
        vel: new Float64Array(frames * nr * 3),
        gVoid: new Float64Array(frames * nr * 3),
        gWeb: new Float64Array(frames * nr * 3),
        deltaEnc: new Float64Array(frames * nr),
    };
    const snapshots = keepSnapshots ? [] : null;
    const accreted = accretion ? new Float64Array(frames) : null;

    const capture = (f) => {
        const x = sim.x;
        for (let t = 0; t < nTest; t++) {
            const o = 3 * (nMassive + t);
            testPos[(f * nTest + t) * 3] = x[o];
            testPos[(f * nTest + t) * 3 + 1] = x[o + 1];
            testPos[(f * nTest + t) * 3 + 2] = x[o + 2];
        }
        for (let w = 0; w < web.length; w++) {
            const o = 3 * web[w];
            webPos[(f * web.length + w) * 3] = x[o];
            webPos[(f * web.length + w) * 3 + 1] = x[o + 1];
            webPos[(f * web.length + w) * 3 + 2] = x[o + 2];
        }
        if (nr) {
            const enc = background ? enclosedContrast(x, sim.mass, nMassive, background) : null;
            for (let k = 0; k < nr; k++) {
                const i = nMassive + record[k];
                const o = (f * nr + k) * 3;
                const v = sim.velocity(i);
                const g = sim.acceleration(i);
                for (let d = 0; d < 3; d++) {
                    rec.pos[o + d] = x[3 * i + d];
                    rec.vel[o + d] = v[d];
                    rec.gVoid[o + d] = g.void[d];
                    rec.gWeb[o + d] = g.web[d];
                }
                rec.deltaEnc[f * nr + k] = enc
                    ? enc(Math.hypot(x[3 * i], x[3 * i + 1], x[3 * i + 2])) : NaN;
            }
        }
        if (accreted) {
            const m = massNearNodes(x, sim.mass, sim.group, nMassive, accretion.nodes, accretion.radiusMpc);
            accreted[f] = m.reduce((acc, v) => acc + v, 0);
        }
        if (snapshots) snapshots.push(Float64Array.from(x.subarray(0, 3 * nMassive)));
    };

    capture(0);
    let s = 0;
    return {
        get done() { return s >= schedule.steps; },
        get stepsDone() { return s; },
        /** Advance one step; returns true while more remain. */
        step() {
            if (s >= schedule.steps) return false;
            sim.step(schedule, s);
            s++;
            capture(s);
            return s < schedule.steps;
        },
        result() {
            return {
                frames, nTest, N: schedule.N, a: schedule.a,
                testPos, webPos, webIndices: web, record, rec, snapshots, accreted,
            };
        },
    };
}

export function runSimulation(sim, schedule, opts = {}) {
    const run = createRun(sim, schedule, opts);
    while (run.step()) opts.onProgress?.(run.stepsDone, schedule.steps);
    if (schedule.steps) opts.onProgress?.(run.stepsDone, schedule.steps);
    return run.result();
}

/**
 * Fly new massless particles through a finished run's stored snapshots. The
 * trees are rebuilt from the SAME positions the run used, so the result is
 * bitwise what an inline run would have produced for them (gated).
 */
export function replayTestParticles({
    snapshots, schedule, mass, group, nMassive, points, velocities, softening, theta = DEFAULT_THETA,
    leafSize = DEFAULT_LEAF, background = null, cosmo = COSMOLOGY,
}) {
    const nT = points.length / 3;
    const pos = new Float64Array(3 * (nMassive + nT));
    pos.set(snapshots[0]);
    pos.set(points, 3 * nMassive);
    const vel = new Float64Array(3 * (nMassive + nT));
    vel.set(velocities, 3 * nMassive);
    // A simulation whose massive half is OVERWRITTEN from the snapshots each
    // step: its own massive integration is never used, only its test half.
    const sim = createSimulation({
        pos, vel, mass, group, nMassive, aStart: schedule.a[0], softening, theta, leafSize, background, cosmo,
    });
    const record = Int32Array.from({ length: nT }, (_, i) => i);
    const frames = schedule.steps + 1;
    const out = {
        pos: new Float64Array(frames * nT * 3), vel: new Float64Array(frames * nT * 3),
        gVoid: new Float64Array(frames * nT * 3), gWeb: new Float64Array(frames * nT * 3),
        deltaEnc: new Float64Array(frames * nT),
    };
    const capture = (f, massive) => {
        const enc = background ? enclosedContrast(massive, mass, nMassive, background) : null;
        for (let k = 0; k < nT; k++) {
            const i = nMassive + record[k];
            const v = sim.velocity(i);
            const g = sim.acceleration(i);
            for (let d = 0; d < 3; d++) {
                out.pos[(f * nT + k) * 3 + d] = sim.x[3 * i + d];
                out.vel[(f * nT + k) * 3 + d] = v[d];
                out.gVoid[(f * nT + k) * 3 + d] = g.void[d];
                out.gWeb[(f * nT + k) * 3 + d] = g.web[d];
            }
            out.deltaEnc[f * nT + k] = enc
                ? enc(Math.hypot(sim.x[3 * i], sim.x[3 * i + 1], sim.x[3 * i + 2])) : NaN;
        }
    };
    capture(0, snapshots[0]);
    for (let s = 0; s < schedule.steps; s++) {
        sim.stepTestOnly(schedule, s, snapshots[s + 1]);
        capture(s + 1, snapshots[s + 1]);
    }
    return out;
}

// ── Initial conditions ──────────────────────────────────────────────────────

/** A uniformly random rotation matrix (Shoemake's quaternion method). */
function randomRotation(rng) {
    const u1 = rng(), u2 = rng(), u3 = rng();
    const q0 = Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2);
    const q1 = Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2);
    const q2 = Math.sqrt(u1) * Math.sin(2 * Math.PI * u3);
    const q3 = Math.sqrt(u1) * Math.cos(2 * Math.PI * u3);
    return [
        1 - 2 * (q2 * q2 + q3 * q3), 2 * (q1 * q2 - q0 * q3), 2 * (q1 * q3 + q0 * q2),
        2 * (q1 * q2 + q0 * q3), 1 - 2 * (q1 * q1 + q3 * q3), 2 * (q2 * q3 - q0 * q1),
        2 * (q1 * q3 - q0 * q2), 2 * (q2 * q3 + q0 * q1), 1 - 2 * (q1 * q1 + q2 * q2),
    ];
}

/**
 * Quiet-start sphere: concentric shells, each a Fibonacci set of directions
 * under its own random rotation, every particle in a shell carrying an equal
 * share of that shell's mass 4πρ̄∫(1+δ)r²dr and sitting at its own stratum
 * of the shell's mass profile. The density lives in the
 * masses and the positions carry no Poisson noise — a random-position sphere
 * of this size has ~10 % shot noise per cell, which would seed spurious
 * structure faster than the physics grows real structure.
 *
 * Spacing s0 inside `refineRadius`, growing ∝ r beyond it (a zoom: the void
 * and its wall are resolved, the outskirts coarser). Returns flat arrays and
 * each particle's observed radius and shell index.
 */
export function quietSphere({
    deltaFn, radius, spacing, refineRadius = Infinity, rho, seed = 1, minPerShell = 6,
    stratify = true,
}) {
    const rng = mulberry32(seed);
    const edges = [0];
    while (edges[edges.length - 1] < radius) {
        const r = edges[edges.length - 1];
        const s = spacing * Math.max(1, (r + 0.5 * spacing) / refineRadius);
        edges.push(r + s);
    }
    // Fold a thin last shell into its neighbour rather than leave a sliver.
    edges[edges.length - 1] = radius;
    if (edges.length > 2 && radius - edges[edges.length - 2] < 0.4 * spacing) edges.splice(edges.length - 2, 1);

    const pos = [], mass = [], shellR = [], shellId = [], cellSize = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let k = 0; k + 1 < edges.length; k++) {
        const ra = edges[k], rb = edges[k + 1];
        const vol = (4 / 3) * Math.PI * (rb ** 3 - ra ** 3);
        // The shell's CUMULATIVE mass on a fine sub-grid (trapezoid in r):
        // particles are placed by inverse CDF in MASS, so the enclosed mass at
        // every particle is the profile's to O(1/K). Placing them uniformly
        // in VOLUME treated each shell as uniform inside: across the void's
        // steep wall (β = 9) that put 0.9 % too much mass inside r = 80 Mpc,
        // and an exact spherical solver then missed the shell ODE by 11 % of
        // the displacement from z = 19 — the error was the IC, not the force.
        const sub = 64, hs = (rb - ra) / sub;
        const cumM = new Float64Array(sub + 1);
        for (let j = 1; j <= sub; j++) {
            const r1 = ra + (j - 1) * hs, r2 = ra + j * hs;
            cumM[j] = cumM[j - 1] + 0.5 * hs * 4 * Math.PI * rho
                * ((1 + deltaFn(r1)) * r1 * r1 + (1 + deltaFn(r2)) * r2 * r2);
        }
        const M = cumM[sub];
        const radiusAtMass = (fm) => {
            const target = fm * M;
            let j = 1;
            while (j < sub && cumM[j] < target) j++;
            const t = (target - cumM[j - 1]) / ((cumM[j] - cumM[j - 1]) || 1);
            // Linear in r³ inside the sub-cell (density ≈ constant there).
            const r1 = ra + (j - 1) * hs, r2 = ra + j * hs;
            return Math.cbrt(r1 ** 3 + t * (r2 ** 3 - r1 ** 3));
        };
        const s = rb - ra;
        const K = Math.max(minPerShell, Math.round(vol / (s * s * s)));
        const R = randomRotation(rng);
        // Radii STRATIFIED through the shell's mass (one stratum per
        // particle, shuffled against the Fibonacci order), not stacked on one
        // radius. Stacking every particle of a shell on a single sphere is a
        // midpoint-rule quadrature of the radial mass distribution, and with
        // a softened kernel it is BIASED: measured, a uniform quiet sphere
        // stacked that way pulled 5.8 % weaker than the continuum it stands
        // for at r = 20 Mpc (s = 8), ∝ (s/r)², independent of ε — an outward
        // push that drove a full-history run 10–30 % past the exact shell
        // solution. Stratified, the bias averages away and the residual is
        // small, unbiased graininess.
        const strata = Array.from({ length: K }, (_, i) => i);
        for (let i = K - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [strata[i], strata[j]] = [strata[j], strata[i]];
        }
        for (let i = 0; i < K; i++) {
            const y = 1 - (2 * i + 1) / K;
            const ring = Math.sqrt(Math.max(0, 1 - y * y));
            const th = golden * i;
            const d = [Math.cos(th) * ring, y, Math.sin(th) * ring];
            const rk = radiusAtMass(stratify ? (strata[i] + 0.5) / K : 0.5);
            pos.push(
                rk * (R[0] * d[0] + R[1] * d[1] + R[2] * d[2]),
                rk * (R[3] * d[0] + R[4] * d[1] + R[5] * d[2]),
                rk * (R[6] * d[0] + R[7] * d[1] + R[8] * d[2]));
            mass.push(M / K);
            shellR.push(rk);
            shellId.push(k);
            cellSize.push(s);
        }
    }
    return {
        pos: Float64Array.from(pos), mass: Float64Array.from(mass),
        radius0: Float64Array.from(shellR), shell: Int32Array.from(shellId),
        cellSize: Float64Array.from(cellSize),
        edges: Float64Array.from(edges),
    };
}

/**
 * The spherical flow: for any observed radius, the shell's linear amplitude
 * and its state at any a, from the tracker's shell table. Tabulated once on
 * a radial grid so 16 000 particles do not each run a bisection.
 */
export function sphericalFlow(voidProfile, table, { rMax, nodes = 1200, cosmo = COSMOLOGY } = {}) {
    const dr = rMax / nodes;
    const dL = new Float64Array(nodes + 1);
    const y0 = new Float64Array(nodes + 1);
    for (let i = 0; i <= nodes; i++) {
        const r = Math.max(i * dr, 1e-3);
        const D = voidProfile.integratedAt(r);
        dL[i] = table.invert(D);
        y0[i] = Math.cbrt(1 / (1 + D));
    }
    const lerp = (arr, r) => {
        const x = Math.min(nodes, Math.max(0, r / dr));
        const i = Math.min(nodes - 1, Math.floor(x));
        const t = x - i;
        return arr[i] + t * (arr[i + 1] - arr[i]);
    };
    /** Comoving radius and peculiar radial speed (km/s) at a, for observed r. */
    function at(rObs, a) {
        if (rObs >= rMax) return { r: rObs, u: 0 };
        const q = rObs / lerp(y0, rObs);
        const st = table.state(lerp(dL, rObs), a);
        const r = q * st.y;
        return { r, u: a * hubbleKmsMpc(1 / a - 1, cosmo) * r * st.w, q, y: st.y };
    }
    return { at, rMax };
}

/**
 * Linear growing-mode velocity of the CLUMPED part (web minus smooth wall) at
 * many points, km/s: u = 2f g / (3Ωm H) with the SAME f the force probe and
 * the tracker use at z_obs (`velocityPerAcceleration`, γ = 0.55) — so an
 * N-body galaxy and a tracker galaxy leave z_obs with the same velocity, to
 * interpolation (gated). The web sum is written out
 * with the SAME arithmetic as `pointGravityVector` (gated equal to the force
 * probe) but without allocating per particle.
 */
export function clumpVelocities(points, { voidProfile, web, zObs, cosmo = COSMOLOGY }) {
    const { wall } = splitProfile(voidProfile);
    const n = points.length / 3;
    const out = new Float64Array(3 * n);
    const vk = velocityPerAcceleration(zObs, cosmo) / 1000;
    const eps = web.softeningMpc;
    const parts = web.particles;
    const P = new Float64Array(parts.length * 3), Mw = new Float64Array(parts.length);
    parts.forEach((p, j) => { P.set(p.offsetMpc, 3 * j); Mw[j] = p.massMsun; });
    const zf = 1 + zObs;
    for (let i = 0; i < n; i++) {
        const x = points[3 * i], y = points[3 * i + 1], z = points[3 * i + 2];
        let gx = 0, gy = 0, gz = 0;
        for (let j = 0; j < Mw.length; j++) {
            const dx = P[3 * j] - x, dy = P[3 * j + 1] - y, dz = P[3 * j + 2] - z;
            const r2 = dx * dx + dy * dy + dz * dz + eps * eps;
            const r = Math.sqrt(r2);
            const rPhysM = r * MPC_M / zf;
            const g = G_SI * (Mw[j] * MSUN_KG) / (rPhysM * rPhysM);
            gx += g * dx / r; gy += g * dy / r; gz += g * dz / r;
        }
        const w = voidGravityVector([x, y, z], [0, 0, 0], wall, { z: zObs, cosmo });
        out[3 * i] = (gx - w[0]) * vk;
        out[3 * i + 1] = (gy - w[1]) * vk;
        out[3 * i + 2] = (gz - w[2]) * vk;
    }
    return out;
}

/**
 * Position and peculiar velocity at `aStart` of particles OBSERVED at
 * `points` (comoving, z_obs): each rides its own spherical shell (the exact
 * flow) plus the clumped part's linear growing mode. The ONE definition of a
 * particle's initial state — `buildInitialConditions` uses it for every
 * particle, and the panel uses it for a galaxy tracked after a run finished,
 * so a replayed galaxy starts exactly as an inline one would have.
 */
export function observedState(points, { voidProfile, web = null, table, zObs, aStart = null, cosmo = COSMOLOGY }) {
    const n = points.length / 3;
    const aObs = 1 / (1 + zObs);
    const a0 = aStart ?? aObs;
    const flow = sphericalFlow(voidProfile, table, { rMax: voidProfile.params.rvMpc * 5.9, cosmo });
    const clump = web ? clumpVelocities(points, { voidProfile, web, zObs, cosmo }) : new Float64Array(3 * n);
    // Clump velocity rides the linear growing mode from z_obs to a0.
    const vScale = a0 === aObs ? 1 : clumpScale(a0, aObs, cosmo);
    const pos = new Float64Array(3 * n), vel = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
        const o = 3 * i;
        const r = Math.hypot(points[o], points[o + 1], points[o + 2]);
        const st = flow.at(r, a0);
        const s = r > 1e-9 ? st.r / r : 1;
        const ur = r > 1e-9 ? st.u / r : 0;
        for (let d = 0; d < 3; d++) {
            const unit = points[o + d];
            pos[o + d] = unit * s;
            vel[o + d] = unit * ur + clump[o + d] * vScale;
        }
    }
    return { pos, vel };
}

/**
 * The observed state at z_obs, ready for `createSimulation`:
 *   massive = quiet-start ρ̄(1+δ⁻) inside `radius` (group 0) + the web (group 1)
 *   tests   = `testPoints` (Float64Array 3k), massless
 * Velocities = exact spherical shell flow (full profile) + linear clumped part.
 * `aStart` defaults to the observed epoch; any other a maps every particle
 * along its own shell (used by the full-history gate).
 */
export function buildInitialConditions({
    voidProfile, web = null, table, zObs, testPoints = new Float64Array(0),
    radius, spacing = 12, refineRadius = Infinity, seed = 7, aStart = null,
    deltaFn = null, splineH = null, cosmo = COSMOLOGY,
}) {
    const rho = meanMatterDensityMsunMpc3(cosmo);
    const aObs = 1 / (1 + zObs);
    const a0 = aStart ?? aObs;
    // With a web, the smooth matter is the DEFICIT only — the web carries the
    // wall. Without one, the smooth matter is the whole profile.
    const smooth = deltaFn ?? (web
        ? (r) => Math.min(voidProfile.deltaAt(r), 0)
        : (r) => voidProfile.deltaAt(r));
    const qs = quietSphere({ deltaFn: smooth, radius, spacing, refineRadius, rho, seed });
    const nBg = qs.mass.length;
    const nWeb = web ? web.particles.length : 0;
    const nMassive = nBg + nWeb;
    const nTest = testPoints.length / 3;
    const n = nMassive + nTest;
    const pos = new Float64Array(3 * n);
    const mass = new Float64Array(nMassive);
    const group = new Uint8Array(nMassive);
    pos.set(qs.pos, 0);
    mass.set(qs.mass, 0);
    for (let j = 0; j < nWeb; j++) {
        pos.set(web.particles[j].offsetMpc, 3 * (nBg + j));
        mass[nBg + j] = web.particles[j].massMsun;
        group[nBg + j] = 1;
    }
    pos.set(testPoints, 3 * nMassive);

    const st = observedState(pos, { voidProfile, web, table, zObs, aStart: a0, cosmo });
    pos.set(st.pos);
    const vel = st.vel;
    return {
        pos, vel, mass, group, nMassive, nBackground: nBg, nWeb, nTest,
        aStart: a0,
        // The smooth matter's spline reaches h = 2× its own spacing by
        // default; the web stays on the probe's Plummer ε.
        softening: [spline(splineH ?? 2 * spacing), plummer(web ? web.softeningMpc : 0.6 * spacing)],
        background: { radius, rho }, radiusObs: qs.radius0, shell: qs.shell, edges: qs.edges,
    };
}

// ── Relaxing away the quiet start's grain (plan §4i) ──────────────────────

/**
 * The radial tables a smooth particle's velocity needs where it ends up, as
 * plain typed arrays so they can be built on the page and sent to a Worker
 * (the profile, the web and the shell table cannot be): the spherical shell
 * flow and the smooth wall's pull — the two pieces `observedState` evaluates
 * besides the web's own particles, which come with the initial conditions.
 */
export function relaxTables({ voidProfile, web = null, table, zObs, rMax, nodes = 2400, cosmo = COSMOLOGY }) {
    const aObs = 1 / (1 + zObs);
    const { wall } = splitProfile(voidProfile);
    const flow = sphericalFlow(voidProfile, table, { rMax: voidProfile.params.rvMpc * 5.9, cosmo });
    const dr = rMax / nodes;
    const uFlow = new Float64Array(nodes + 1), gWall = new Float64Array(nodes + 1);
    for (let i = 0; i <= nodes; i++) {
        const r = Math.max(i * dr, 1e-3);
        uFlow[i] = flow.at(r, aObs).u;
        gWall[i] = gravityRadialSI(r, wall, { z: zObs, cosmo });
    }
    return {
        aObs, zObs, dr, nodes, uFlow, gWall,
        eps: web ? web.softeningMpc : 0, vk: velocityPerAcceleration(zObs, cosmo) / 1000,
    };
}

function tableAt(arr, dr, nodes, r) {
    const x = Math.min(nodes, Math.max(0, r / dr));
    const i = Math.min(nodes - 1, Math.floor(x));
    const t = x - i;
    return arr[i] + t * (arr[i + 1] - arr[i]);
}

/**
 * Relax away the GRAIN of the smooth matter's quiet start, keeping its
 * profile, then give every moved particle the velocity `observedState` would
 * give it where it now sits. Steppable (`step()` → false when done) so the
 * no-Worker path can yield between passes.
 *
 * The model's smooth field is the void's deficit — purely RADIAL — and the
 * quiet start already carries its radial part exactly (mass-stratified
 * shells: the enclosed mass at every particle is the profile's to 0.007 %).
 * What it gets wrong is everything else: the lattice's grain, a fixed force
 * noise that outside the void, where the void and its wall nearly cancel,
 * was LARGER than the model's field (plan §4i). So each pass takes the
 * particles' own peculiar field, subtracts its SHELL-AVERAGED radial part
 * (the monopole, in thin radial bins) and moves every particle against what
 * is left, r·F_grain/4πGρ̄₀ — repulsive glass relaxation (the reconstruction's
 * step 1) restricted to the non-spherical part, so each shell keeps its mass.
 *
 * MEASURED REJECTION: the first version relaxed the whole field onto the
 * analytic deficit field. The particles' field and that table differ by a
 * UNIFORM ~0.7 % (softening + tree), which no arrangement can remove; every
 * pass pushed mass outward to try, and 20 passes bent the enclosed contrast
 * by up to 0.11 (−0.62 for −0.56 at 20 Mpc) while the residual it was
 * minimising fell nicely. Matching the spherical part to an independent
 * table re-derives what the quiet start already has exactly — so it doesn't.
 *
 * TWO ADDITIONS (plan §4j), each because the rim's error was this grain:
 *  - STEP SIZES. A fixed rate shrinks a grain mode by (1 − rate·ŵ) per pass,
 *    ŵ the softened force's response to it. Modes near the softening scale
 *    (ŵ ~ 0.3) barely felt 0.7, and their leftover force was a FLAT floor
 *    (~150 (km/s)²/Mpc from 120 Mpc to the rim) that the vanishing field there
 *    turned into 20 %. The default is a Chebyshev schedule over ŵ ∈ [0.25, 1]
 *    (`chebyshevRates`): the same 20 passes take the floor to ~80.
 *  - THE MONOPOLE PIN. Subtracting each shell's average radial force does not
 *    stop the mass moving radially at second order, and larger steps moved
 *    it more (Δ(<r) drifted 0.016 at rate 0.7, 0.022 at 1.5, 0.12 at an
 *    aggressive schedule). After every pass each particle is put back at the
 *    radius where the QUIET START had the same enclosed mass (rank by radius,
 *    interpolate the start's cumulative mass) — only |x| changes, never the
 *    direction, so the grain relaxation is untouched and the profile is the
 *    quiet start's to ~1e-4 by construction, whatever the steps are.
 *
 * The particles move ~1 Mpc rms — enough that their velocities must follow
 * (a stale velocity near a clump is ~10 km/s, the size of the whole 6 Gyr
 * effect), so they are recomputed with the SAME arithmetic as
 * `clumpVelocities` + the shell flow.
 */
export function createRelaxer({
    pos, vel, mass, group, nBackground, softening, background, aStart, tables,
    iterations = PAGE_CONFIG.relax.iterations, rates = PAGE_CONFIG.relax.rates, rate = null,
    pinMonopole = true, binMpc = 2,
    theta = DEFAULT_THETA, leafSize = DEFAULT_LEAF, cosmo = COSMOLOGY,
}) {
    if (Math.abs(aStart - tables.aObs) > 1e-12) throw new Error('relax: the observed state must start at z_obs');
    const nB = nBackground;
    const k4 = 4 * Math.PI * G_MPC * meanMatterDensityMsunMpc3(cosmo);
    const { dr, nodes } = tables;
    const sim = createSimulation({
        pos: Float64Array.from(pos.subarray(0, 3 * nB)), vel: new Float64Array(3 * nB),
        mass: Float64Array.from(mass.subarray(0, nB)), group: new Uint8Array(nB), nMassive: nB, aStart: 1,
        softening: [softening[0], softening[0]], background, theta, leafSize, cosmo,
    });
    const nBins = Math.ceil(1.2 * background.radius / binMpc) + 1;
    const fr = new Float64Array(nBins), wb = new Float64Array(nBins);
    const grain = new Float64Array(3 * nB);
    const measure = () => {
        fr.fill(0); wb.fill(0);
        for (let i = 0; i < nB; i++) {
            const o = 3 * i, x = sim.x[o], y = sim.x[o + 1], z = sim.x[o + 2];
            const r = Math.hypot(x, y, z);
            if (r < 1e-9) continue;
            const b = Math.min(nBins - 1, Math.floor(r / binMpc));
            fr[b] += sim.mass[i] * ((sim.fBg[o] + sim.fWeb[o]) * x + (sim.fBg[o + 1] + sim.fWeb[o + 1]) * y
                + (sim.fBg[o + 2] + sim.fWeb[o + 2]) * z) / r;
            wb[b] += sim.mass[i];
        }
        let s = 0;
        for (let i = 0; i < nB; i++) {
            const o = 3 * i, x = sim.x[o], y = sim.x[o + 1], z = sim.x[o + 2];
            const r = Math.hypot(x, y, z);
            const b = Math.min(nBins - 1, Math.floor(r / binMpc));
            const mono = r > 1e-9 && wb[b] > 0 ? fr[b] / wb[b] / r : 0;
            grain[o] = sim.fBg[o] + sim.fWeb[o] - mono * x;
            grain[o + 1] = sim.fBg[o + 1] + sim.fWeb[o + 1] - mono * y;
            grain[o + 2] = sim.fBg[o + 2] + sim.fWeb[o + 2] - mono * z;
            s += grain[o] ** 2 + grain[o + 1] ** 2 + grain[o + 2] ** 2;
        }
        return Math.sqrt(s / nB) / k4;
    };
    // A fixed `rate` (the old relaxer, kept as the A/B) overrides the schedule.
    const steps = rate != null ? [rate] : rates;
    // The monopole pin: the radii the quiet start drew, sorted, with the
    // enclosed mass at each (mid-particle, so equal masses land on the start's
    // own radii exactly).
    const order0 = Array.from({ length: nB }, (_, i) => i);
    const rad = (P, i) => Math.hypot(P[3 * i], P[3 * i + 1], P[3 * i + 2]);
    const r0s = new Float64Array(nB), c0 = new Float64Array(nB);
    {
        const rr = order0.map((i) => rad(sim.x, i));
        const ord = order0.slice().sort((a, b) => rr[a] - rr[b]);
        let c = 0;
        ord.forEach((i, k) => { c += sim.mass[i]; r0s[k] = rr[i]; c0[k] = c - 0.5 * sim.mass[i]; });
    }
    const pin = () => {
        const rr = order0.map((i) => rad(sim.x, i));
        const ord = order0.slice().sort((a, b) => rr[a] - rr[b]);
        let c = 0, j = 0;
        for (const i of ord) {
            c += sim.mass[i];
            const cm = c - 0.5 * sim.mass[i];
            while (j < nB - 2 && c0[j + 1] < cm) j++;
            const t = Math.max(0, Math.min(1, (cm - c0[j]) / (c0[j + 1] - c0[j])));
            const target = r0s[j] + t * (r0s[j + 1] - r0s[j]);
            const s = rr[i] > 1e-9 ? target / rr[i] : 1;
            sim.x[3 * i] *= s; sim.x[3 * i + 1] *= s; sim.x[3 * i + 2] *= s;
        }
    };
    const history = [measure()];
    let done = 0;
    return {
        get stepsDone() { return done; },
        iterations,
        history,
        step() {
            if (done >= iterations) return false;
            const rk = steps[done % steps.length];
            for (let k = 0; k < 3 * nB; k++) sim.x[k] -= rk * grain[k] / k4;
            if (pinMonopole) pin();
            sim.refreshForces();
            history.push(measure());
            done++;
            return done < iterations;
        },
        /** The relaxed state: positions and velocities, every other particle untouched. */
        result() {
            const outPos = Float64Array.from(pos), outVel = Float64Array.from(vel);
            outPos.set(sim.x, 0);
            const webIdx = [];
            for (let j = nB; j < mass.length; j++) if (group[j]) webIdx.push(j);
            const eps2 = tables.eps * tables.eps, zf = 1 + tables.zObs;
            let shift = 0;
            for (let i = 0; i < nB; i++) {
                const o = 3 * i, x = sim.x[o], y = sim.x[o + 1], z = sim.x[o + 2];
                for (let d = 0; d < 3; d++) shift += (sim.x[o + d] - pos[o + d]) ** 2;
                const r = Math.hypot(x, y, z);
                const ur = r > 1e-9 ? tableAt(tables.uFlow, dr, nodes, r) / r : 0;
                // The clumped part — written as in `clumpVelocities`.
                let gx = 0, gy = 0, gz = 0;
                for (const j of webIdx) {
                    const dx = pos[3 * j] - x, dy = pos[3 * j + 1] - y, dz = pos[3 * j + 2] - z;
                    const rr = Math.sqrt(dx * dx + dy * dy + dz * dz + eps2);
                    const rPhysM = rr * MPC_M / zf;
                    const g = G_SI * (mass[j] * MSUN_KG) / (rPhysM * rPhysM);
                    gx += g * dx / rr; gy += g * dy / rr; gz += g * dz / rr;
                }
                const w = r > 1e-9 ? tableAt(tables.gWall, dr, nodes, r) / r : 0;
                outVel[o] = x * ur + (gx - w * x) * tables.vk;
                outVel[o + 1] = y * ur + (gy - w * y) * tables.vk;
                outVel[o + 2] = z * ur + (gz - w * z) * tables.vk;
            }
            return { pos: outPos, vel: outVel, shiftRmsMpc: Math.sqrt(shift / nB), history: history.slice() };
        },
    };
}

function clumpScale(a, aObs, cosmo) {
    // [a H f D](a) / [a H f D](aObs) — linear growing-mode velocity ratio.
    const zz = 1 / a - 1, zo = 1 / aObs - 1;
    const g = (z) => {
        const ai = 1 / (1 + z);
        return ai * hubbleKmsMpc(z, cosmo) * growthRate(z, cosmo, { exact: true });
    };
    return g(zz) / g(zo) * growthFactor(zz, cosmo) / growthFactor(zo, cosmo);
}

/**
 * How much smooth matter sits within `radiusMpc` of each web node in a
 * snapshot — the "do nodes accrete?" diagnostic. Returns M☉ per node.
 */
export function massNearNodes(x, mass, group, nMassive, nodeIndices, radiusMpc) {
    const out = new Float64Array(nodeIndices.length);
    const r2 = radiusMpc * radiusMpc;
    nodeIndices.forEach((ni, k) => {
        const cx = x[3 * ni], cy = x[3 * ni + 1], cz = x[3 * ni + 2];
        let m = 0;
        for (let i = 0; i < nMassive; i++) {
            if (group[i]) continue;
            const dx = x[3 * i] - cx, dy = x[3 * i + 1] - cy, dz = x[3 * i + 2] - cz;
            if (dx * dx + dy * dy + dz * dz < r2) m += mass[i];
        }
        out[k] = m;
    });
    return out;
}

// ── Reading a finished run ──────────────────────────────────────────────────

/**
 * Where scale factor `a` falls between a run's frames. A binary search on the
 * frames' own ln a — a reconstruction run is two uniform segments with
 * different steps (z = 9 → z_obs, then z_obs → the end), so assuming one
 * uniform spacing would misplace every frame after the join.
 */
export function locateFrame(N, a) {
    const n = N.length;
    const x = Math.log(a);
    const inside = x >= N[0] - 1e-9 && x <= N[n - 1] + 1e-9;
    if (x <= N[0]) return { i: 0, t: 0, inside };
    if (x >= N[n - 1]) return { i: n - 2, t: 1, inside };
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (N[mid] <= x) lo = mid; else hi = mid; }
    return { i: lo, t: (x - N[lo]) / (N[lo + 1] - N[lo]), inside };
}

/**
 * Rows `[from, from + count)` of a frame-major array (`stride` values per
 * row) interpolated at `loc`, into `out`. Linear in ln a between frames:
 * the run is converged at a quarter of its steps (gated), so the frames are
 * far denser than the motion's curvature.
 */
export function interpolateRows(arr, rowsPerFrame, stride, loc, out, from = 0, count = rowsPerFrame) {
    const { i, t } = loc;
    const A = (i * rowsPerFrame + from) * stride, B = ((i + 1) * rowsPerFrame + from) * stride;
    for (let k = 0; k < count * stride; k++) out[k] = arr[A + k] + t * (arr[B + k] - arr[A + k]);
    return out;
}

/**
 * One tracked galaxy's sample at epoch `ep` from a run's record — the same
 * fields the tracker's samples carry, so the panel draws either without
 * knowing which made it. What the N-body cannot say, it does not: no T-web
 * class and no local δ (the field is particles, not a profile), and the
 * spherical-shell flags do not apply.
 *   rec      { pos, vel, gVoid, gWeb, deltaEnc } (frame-major), `nRec` rows
 *   k        this galaxy's row
 */
export function recordSampleAt(rec, nRec, k, N, ep, toKmsPerGyr) {
    const loc = locateFrame(N, ep.a);
    const v3 = (arr) => interpolateRows(arr, nRec, 3, loc, new Array(3), k, 1);
    const pos = v3(rec.pos), vel = v3(rec.vel), gv = v3(rec.gVoid), gw = v3(rec.gWeb);
    const dEnc = interpolateRows(rec.deltaEnc, nRec, 1, loc, new Array(1), k, 1)[0];
    const g = [gv[0] + gw[0], gv[1] + gw[1], gv[2] + gw[2]];
    const mag = (v) => Math.hypot(v[0], v[1], v[2]);
    const r = mag(pos);
    const radial = (v) => (r > 1e-9 ? (v[0] * pos[0] + v[1] * pos[1] + v[2] * pos[2]) / r : 0);
    const mv = mag(gv), mw = mag(gw);
    // A reconstruction's matter is one population (the web's mass is in the
    // elements), so it has no void/web split to report — say so, not 100 %.
    const split = rec.split !== false;
    return {
        tGyr: ep.tGyr, z: ep.z,
        positionMpc: pos,
        rMpc: r,
        gA: toKmsPerGyr(mag(g)),
        gVoid: split ? toKmsPerGyr(mv) : NaN,
        gWeb: split ? toKmsPerGyr(mw) : NaN,
        gRadial: toKmsPerGyr(radial(g)),
        voidShare: split ? ((mv + mw) > 0 ? mv / (mv + mw) : 0) : NaN,
        vKms: mag(vel),
        vRadialKms: radial(vel),
        delta: NaN,
        deltaEnclosed: dEnc,
        tidal: [NaN, NaN, NaN],
        tweb: { name: 'N-body', count: NaN },
        linearOk: true,
        shellCrossed: false,
        nbody: true,
    };
}
