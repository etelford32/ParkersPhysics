/**
 * bootes-lpt.js — second-order Lagrangian perturbation theory (2LPT)
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no fetch, no Worker. Used by js/bootes-reconstruct.js to turn
 * the matched displacement into initial conditions (BOOTES_VOID_PLAN.md §4f).
 * `node tests/bootes-lpt.mjs` pins every step.
 *
 * WHY
 * ───
 * Gravitational matching (bootes-reconstruct.js step 2) finds the FULL
 * displacement Ψ = X − q that carries the glass onto today's field. The
 * Zel'dovich initial conditions then scale all of Ψ back by D_i/D_obs, which
 * treats every part of it as linear growth. But Ψ is not linear: to second
 * order (Bouchet et al. 1995; Scoccimarro 1998)
 *
 *     x(q, a) = q + D₁(a) s₁(q) + D₂(a) s₂(q),
 *     s₁ = −∇φ₁,   s₂ = ∇φ₂,   ∇²φ₂ = Σ_{i>j} [s₁ᵢ,ᵢ s₁ⱼ,ⱼ − s₁ᵢ,ⱼ s₁ⱼ,ᵢ],
 *     D₂ = −(3/7) D₁² Ω_m^(−1/143) (to < 0.6 %; this module integrates the
 *     exact ODE and gates the fit against it),
 *
 * and the second-order part grows as D₁², so scaled back by D_i/D_obs it is
 * over-counted by D_obs/D_i ≈ 7 at z = 9. The 2LPT inverse removes it:
 * normalising D₁(a_obs) = 1, the matched Ψ is s₁ + D₂(a_obs) s₂[s₁], solved
 * for s₁ by the fixed point s₁ ← Ψ − D₂ₒ s₂[s₁] (|D₂ₒ s₂| ≪ |s₁| contracts it
 * in a few passes). The ICs then carry BOTH orders at a_init, with the
 * growing-mode velocities u = a H (D₁′ s₁ + D₂′ s₂), ′ = d/dln a.
 *
 * HOW, on an irregular glass with no grid
 * ───────────────────────────────────────
 *  - ∂s₁ᵢ/∂qⱼ by LOCAL LEAST SQUARES: each element fits a linear field to its
 *    neighbours' s₁ within `h` (default 2 × spacing — the elements' own
 *    resolution, the same width the galaxies' first guess uses). A linear
 *    fit is unbiased for a linear field even one-sided, so the sphere's rim
 *    needs no special case. The gradient is symmetrised (s₁ is curl-free).
 *  - ∇²φ₂ = S by the N-BODY TREE: S is a source density, so each element
 *    carries "mass" S·V/(4πG) (V = its glass volume) and s₂ = ∇φ₂ is MINUS
 *    the tree's "gravity" of those masses, spline-softened at each element's
 *    own h. S changes sign, and a monopole of mixed sign has no centre, so
 *    the positive and negative parts are separate trees. The boundary is
 *    ISOLATED — S = 0 outside the sampled sphere, which is exactly the
 *    reconstruction's statement that matter beyond it is the mean.
 */

import { COSMOLOGY, hubbleKmsMpc, omegaMatterAt } from './bootes-void-model.js';
import { G_MPC, buildTree, treeForce, DEFAULT_THETA, DEFAULT_LEAF } from './bootes-nbody.js';

// ── Growth: first and second order, by the ODE ──────────────────────────────

/**
 * D₁ and D₂ (and their ln a derivatives) by RK4 in ln a from deep matter
 * domination, where D₁ = a and D₂ = −(3/7) a² exactly:
 *   D″ + (2 + dlnH/dlna) D′ − (3/2) Ω_m(a) D = 0
 *   D₂″ + (2 + dlnH/dlna) D₂′ − (3/2) Ω_m(a) D₂ = −(3/2) Ω_m(a) D₁²
 * Returns raw (unnormalised) values at each requested a.
 */
export function growthODE(aList, cosmo = COSMOLOGY, { aStart = 1e-3, stepsPerEfold = 400 } = {}) {
    const om = (lna) => omegaMatterAt(Math.exp(-lna) - 1, cosmo);
    // dlnH/dlna = −(3/2) Ω_m(a) in flat ΛCDM without radiation.
    const rhs = (lna, y) => {
        const o = om(lna), damp = 2 - 1.5 * o;
        return [y[1], -damp * y[1] + 1.5 * o * y[0], y[3], -damp * y[3] + 1.5 * o * (y[2] - y[0] * y[0])];
    };
    const order = aList.map((a, i) => [a, i]).sort((p, q) => p[0] - q[0]);
    const out = new Array(aList.length);
    let lna = Math.log(aStart);
    let y = [aStart, aStart, -3 / 7 * aStart * aStart, -6 / 7 * aStart * aStart];
    for (const [aT, idx] of order) {
        const target = Math.log(aT);
        const n = Math.max(1, Math.ceil((target - lna) * stepsPerEfold));
        const h = (target - lna) / n;
        for (let s = 0; s < n; s++) {
            const k1 = rhs(lna, y);
            const k2 = rhs(lna + h / 2, y.map((v, j) => v + h / 2 * k1[j]));
            const k3 = rhs(lna + h / 2, y.map((v, j) => v + h / 2 * k2[j]));
            const k4 = rhs(lna + h, y.map((v, j) => v + h * k3[j]));
            y = y.map((v, j) => v + h / 6 * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j]));
            lna += h;
        }
        out[idx] = { a: aT, D1: y[0], dD1: y[1], D2: y[2], dD2: y[3] };
    }
    return out;
}

/**
 * The growth the ICs need, NORMALISED to D₁(a_obs) = 1 (so D₂ scales by
 * 1/D₁(a_obs)², which keeps x = q + D₁s₁ + D₂s₂ invariant):
 * { d1, d2, dd1, dd2 } at aInit and d2Obs at aObs; dd = d/dln a.
 */
export function lptGrowth(aInit, aObs, cosmo = COSMOLOGY) {
    const [gi, go] = growthODE([aInit, aObs], cosmo);
    const n1 = 1 / go.D1, n2 = n1 * n1;
    return {
        d1: gi.D1 * n1, dd1: gi.dD1 * n1, d2: gi.D2 * n2, dd2: gi.dD2 * n2,
        d2Obs: go.D2 * n2, dd2Obs: go.dD2 * n2,
    };
}

/** The literature fits, kept for the gate: D₂ ≈ −(3/7)D₁²Ω_m^(−1/143), f₂ ≈ 2Ω_m^(6/11). */
export const d2Fit = (d1, z, cosmo = COSMOLOGY) => -3 / 7 * d1 * d1 * Math.pow(omegaMatterAt(z, cosmo), -1 / 143);
export const f2Fit = (z, cosmo = COSMOLOGY) => 2 * Math.pow(omegaMatterAt(z, cosmo), 6 / 11);

// ── ∂s/∂q by local least squares ────────────────────────────────────────────

/**
 * The symmetrised gradient of a vector field `s` sampled at Lagrangian
 * positions `q`: for each element, a weighted least-squares linear fit to the
 * neighbours within `h` (weight (1 − r²/h²)²). Returns a Float64Array of 6
 * per element: xx, yy, zz, xy, xz, yz. Elements with too few neighbours to
 * fit (fewer than 6) get zero.
 */
export function lsqGradient(q, s, h) {
    const n = q.length / 3;
    const grid = new Map();
    const key = (i, j, k) => ((i + 2048) * 4096 + (j + 2048)) * 4096 + (k + 2048);   // exact, no collisions
    const cellOf = (v) => Math.floor(v / h);
    for (let e = 0; e < n; e++) {
        const kk = key(cellOf(q[3 * e]), cellOf(q[3 * e + 1]), cellOf(q[3 * e + 2]));
        let list = grid.get(kk);
        if (!list) grid.set(kk, list = []);
        list.push(e);
    }
    const out = new Float64Array(6 * n);
    const h2 = h * h;
    for (let e = 0; e < n; e++) {
        const x = q[3 * e], y = q[3 * e + 1], z = q[3 * e + 2];
        const ci = cellOf(x), cj = cellOf(y), ck = cellOf(z);
        // Normal equations M g = b, per component; M is shared.
        let m00 = 0, m11 = 0, m22 = 0, m01 = 0, m02 = 0, m12 = 0, cnt = 0;
        const b = [0, 0, 0, 0, 0, 0, 0, 0, 0];
        const se = [s[3 * e], s[3 * e + 1], s[3 * e + 2]];
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
            const list = grid.get(key(ci + di, cj + dj, ck + dk));
            if (!list) continue;
            for (const j of list) {
                if (j === e) continue;
                const dx = q[3 * j] - x, dy = q[3 * j + 1] - y, dz = q[3 * j + 2] - z;
                const r2 = dx * dx + dy * dy + dz * dz;
                if (r2 >= h2) continue;
                const t = 1 - r2 / h2, w = t * t;
                m00 += w * dx * dx; m11 += w * dy * dy; m22 += w * dz * dz;
                m01 += w * dx * dy; m02 += w * dx * dz; m12 += w * dy * dz;
                for (let c = 0; c < 3; c++) {
                    const ds = w * (s[3 * j + c] - se[c]);
                    b[3 * c] += ds * dx; b[3 * c + 1] += ds * dy; b[3 * c + 2] += ds * dz;
                }
                cnt++;
            }
        }
        if (cnt < 6) continue;
        // Invert the symmetric 3×3.
        const c00 = m11 * m22 - m12 * m12, c01 = m02 * m12 - m01 * m22, c02 = m01 * m12 - m02 * m11;
        const det = m00 * c00 + m01 * c01 + m02 * c02;
        if (!(Math.abs(det) > 0)) continue;
        const c11 = m00 * m22 - m02 * m02, c12 = m01 * m02 - m00 * m12, c22 = m00 * m11 - m01 * m01;
        const g = new Array(9);
        for (let c = 0; c < 3; c++) {
            const b0 = b[3 * c], b1 = b[3 * c + 1], b2 = b[3 * c + 2];
            g[3 * c] = (c00 * b0 + c01 * b1 + c02 * b2) / det;
            g[3 * c + 1] = (c01 * b0 + c11 * b1 + c12 * b2) / det;
            g[3 * c + 2] = (c02 * b0 + c12 * b1 + c22 * b2) / det;
        }
        // g[3c + j] = ∂s_c/∂q_j
        const o = 6 * e;
        out[o] = g[0]; out[o + 1] = g[4]; out[o + 2] = g[8];
        out[o + 3] = 0.5 * (g[1] + g[3]); out[o + 4] = 0.5 * (g[2] + g[6]); out[o + 5] = 0.5 * (g[5] + g[7]);
    }
    return out;
}

/** S = Σ_{i>j} [sᵢ,ᵢ sⱼ,ⱼ − sᵢ,ⱼ²] for a symmetric gradient (xx, yy, zz, xy, xz, yz). */
export function secondInvariant(grad) {
    const n = grad.length / 6;
    const S = new Float64Array(n);
    for (let e = 0; e < n; e++) {
        const o = 6 * e;
        const xx = grad[o], yy = grad[o + 1], zz = grad[o + 2], xy = grad[o + 3], xz = grad[o + 4], yz = grad[o + 5];
        S[e] = xx * yy + xx * zz + yy * zz - xy * xy - xz * xz - yz * yz;
    }
    return S;
}

// ── ∇²φ₂ = S on the tree ────────────────────────────────────────────────────

/**
 * s₂ = ∇φ₂ with ∇²φ₂ = S, isolated boundary. `volume` is each element's
 * Lagrangian volume (Mpc³), `hsoft` its spline h (Float64Array).
 */
export function poissonGradient(q, S, volume, hsoft, { theta = DEFAULT_THETA, leafSize = DEFAULT_LEAF } = {}) {
    const n = S.length;
    const mass = new Float64Array(n);
    const pos = [], neg = [];
    const k = 1 / (4 * Math.PI * G_MPC);
    for (let e = 0; e < n; e++) {
        mass[e] = Math.abs(S[e]) * volume[e] * k;
        if (S[e] > 0) pos.push(e); else if (S[e] < 0) neg.push(e);
    }
    const tp = buildTree(q, mass, pos, { leafSize, hsoft });
    const tn = buildTree(q, mass, neg, { leafSize, hsoft });
    const soft = { kind: 'spline-per-particle' };
    const out = new Float64Array(3 * n);
    const fp = new Float64Array(3), fn = new Float64Array(3);
    for (let e = 0; e < n; e++) {
        fp.fill(0); fn.fill(0);
        treeForce(tp, q[3 * e], q[3 * e + 1], q[3 * e + 2], theta, soft, fp);
        treeForce(tn, q[3 * e], q[3 * e + 1], q[3 * e + 2], theta, soft, fn);
        // "Gravity" g = −∇φ for positive sources; s₂ = ∇φ₂ = −(g₊ − g₋).
        out[3 * e] = fn[0] - fp[0];
        out[3 * e + 1] = fn[1] - fp[1];
        out[3 * e + 2] = fn[2] - fp[2];
    }
    return out;
}

/** s₂[s₁] on the glass: gradient → invariant → Poisson. */
export function secondOrderDisplacement(q, s1, { volume, hsoft, h, theta, leafSize } = {}) {
    const S = secondInvariant(lsqGradient(q, s1, h));
    return poissonGradient(q, S, volume, hsoft, { theta, leafSize });
}

/**
 * Invert Ψ = s₁ + D₂ₒ s₂[s₁] for s₁ (D₁(a_obs) = 1) by fixed point. Returns
 * { s1, s2, history } — history is the rms change of s₁ per pass (Mpc).
 */
export function invert2LPT(q, psi, { d2Obs, iterations = 4, ...opts }) {
    const n = psi.length / 3;
    let s1 = Float64Array.from(psi), s2 = null;
    const history = [];
    for (let it = 0; it < iterations; it++) {
        s2 = secondOrderDisplacement(q, s1, opts);
        let d = 0;
        for (let k = 0; k < psi.length; k++) {
            const v = psi[k] - d2Obs * s2[k];
            d += (v - s1[k]) ** 2;
            s1[k] = v;
        }
        history.push(Math.sqrt(d / n));
    }
    s2 = secondOrderDisplacement(q, s1, opts);
    return { s1, s2, history };
}

/**
 * The 2LPT state at aInit: x = q + d₁s₁ + d₂s₂, u = aH(d₁′s₁ + d₂′s₂) km/s,
 * with the growth from `lptGrowth` (normalised D₁(a_obs) = 1).
 */
export function lptState(q, s1, s2, aInit, growth, cosmo = COSMOLOGY) {
    const aH = aInit * hubbleKmsMpc(1 / aInit - 1, cosmo);
    const pos = new Float64Array(q.length), vel = new Float64Array(q.length);
    for (let k = 0; k < q.length; k++) {
        pos[k] = q[k] + growth.d1 * s1[k] + growth.d2 * s2[k];
        vel[k] = aH * (growth.dd1 * s1[k] + growth.dd2 * s2[k]);
    }
    return { pos, vel };
}
