/**
 * bootes-softgrowth.js — the softened integrator's own linear growth
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no fetch, no Worker. Used by js/bootes-reconstruct.js so the
 * reconstructed initial conditions grow into today's field UNDER THE
 * INTEGRATOR THAT RUNS THEM (BOOTES_VOID_PLAN.md §4g).
 * `node tests/bootes-softgrowth.mjs` pins every step.
 *
 * THE DEFICIT
 * ───────────
 * The N-body softens each element with Gadget-2's compact spline of support
 * h (2 × spacing). For the spline the softened pull of a point mass IS the
 * Newtonian pull of the spline-shaped mass, so a mode of wavenumber k feels
 * the force ŵ_h(k) × the true one, ŵ the kernel's Fourier transform. Its
 * growth then obeys
 *     D″ + (2 + dlnH/dlna) D′ − (3/2) Ω_m(a) ŵ_h(k) D = 0
 * and, started in the IDEAL growing mode at a_init (the ICs we lay down),
 * reaches T(k) = D(a_obs) < 1 instead of 1. On the page (h = 24 Mpc) that is
 * 0.98 at λ = 200 Mpc, 0.88 at 80, 0.80 at 60. MEASURED on the glass with
 * curl-free plane waves (tests/bootes-softgrowth.mjs): the integrator follows
 * this T(k), and none of the shortfall is time-stepping (90 steps = 30) or
 * tree error (θ 0.25 = 0.5). A windowed test field reads lower still, because
 * the window spreads it onto higher k — a sphere of 220 Mpc instead of 140
 * brought λ = 80 Mpc from 0.805 to 0.834 against T = 0.844.
 *
 * THE FIX: deconvolve the ICs by the integrator's own transfer
 * ─────────────────────────────────────────────────────────────
 * Matching (bootes-reconstruct.js step 2) compares SOFTENED fields on both
 * sides, so the matched Ψ is today's displacement. To land on it, the linear
 * part must be laid down as T(k)⁻¹ s₁. The operator is isotropic, so it is a
 * RADIAL CONVOLUTION applied directly on the glass — no grid:
 *     C(q) = ∫ K(|q − q′|) [s₁(q′) − s₁(q)] d³q′,   s₁ ← s₁ + C,
 * K the inverse transform of G(k) = (1/T(k) − 1)·exp(−(k h/κ)⁴). Two
 * choices, each for a reason:
 *  - The DIFFERENCE form: G(0) = 0, so K integrates to zero — a large
 *    positive core and a negative ring. Summed against s₁ itself the
 *    glass's quadrature error times the full field would be the answer;
 *    against the difference it is not. At the sphere's rim the missing
 *    outside is continued as s₁(q), never as zero.
 *  - The TAPER κ: above kh ≈ κ the elements do not constrain the field
 *    (matching sees it through ŵ, which is small there) and 1/T climbs
 *    towards the no-gravity limit — deconvolving there would amplify grain,
 *    the failure mode that rejected position shooting (plan §4e).
 * What is NOT corrected, stated where it is used: the second-order part's
 * own softening deficit (~T on a term that is ~5 % of Ψ), and modes above
 * the taper, which the reconstruction never claimed.
 */

import { COSMOLOGY, omegaMatterAt } from './bootes-void-model.js';
import { lptGrowth } from './bootes-lpt.js';

/** Fourier transform of Gadget-2's spline DENSITY kernel of support h (ŵ(0) = 1). */
export function splineKernelFT(k, h, { panels = 400 } = {}) {
    if (k === 0) return 1;
    let s = 0;
    const dr = h / panels;
    for (let i = 0; i < panels; i++) {
        const u = (i + 0.5) / panels, r = u * h;
        const W = (8 / (Math.PI * h * h * h)) * (u < 0.5 ? 1 - 6 * u * u + 6 * u * u * u : 2 * (1 - u) ** 3);
        const x = k * r;
        s += W * (Math.sin(x) / x) * 4 * Math.PI * r * r * dr;
    }
    return s;
}

/**
 * T(k): the growth a mode reaches at aObs under a force reduced to w·F,
 * started in the IDEAL growing mode at aInit with D₁(a_obs) = 1 normalisation
 * (so T = 1 exactly when w = 1). `growth` is lptGrowth(aInit, aObs).
 */
export function softenedTransfer(w, aInit, aObs, growth, cosmo = COSMOLOGY, { steps = 2000 } = {}) {
    const f = (lna, y) => {
        const o = omegaMatterAt(Math.exp(-lna) - 1, cosmo);
        return [y[1], -(2 - 1.5 * o) * y[1] + 1.5 * o * w * y[0]];
    };
    let lna = Math.log(aInit);
    let y = [growth.d1, growth.dd1];
    const dh = (Math.log(aObs) - lna) / steps;
    for (let s = 0; s < steps; s++) {
        const k1 = f(lna, y);
        const k2 = f(lna + dh / 2, [y[0] + dh / 2 * k1[0], y[1] + dh / 2 * k1[1]]);
        const k3 = f(lna + dh / 2, [y[0] + dh / 2 * k2[0], y[1] + dh / 2 * k2[1]]);
        const k4 = f(lna + dh, [y[0] + dh * k3[0], y[1] + dh * k3[1]]);
        y = [y[0] + dh / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
            y[1] + dh / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])];
        lna += dh;
    }
    return y[0];
}

/**
 * The correction filter G(k) = (1/T(k) − 1)·exp(−(kh/κ)²) and its radial
 * kernel K(r) = (1/2π²)∫G(k) j₀(kr) k² dk, tabulated to rMax.
 */
export function deconvolutionKernel({
    h, aInit, aObs, kappa = 3, power = 4, rMax = null, dr = 0.25, cosmo = COSMOLOGY,
    kPoints = 600,
}) {
    const growth = lptGrowth(aInit, aObs, cosmo);
    const kMax = Math.pow(30, 1 / power) * kappa / h;   // taper is e⁻³⁰ there
    const ks = new Float64Array(kPoints + 1), G = new Float64Array(kPoints + 1), T = new Float64Array(kPoints + 1);
    for (let i = 0; i <= kPoints; i++) {
        const k = kMax * i / kPoints;
        ks[i] = k;
        T[i] = softenedTransfer(splineKernelFT(k, h), aInit, aObs, growth, cosmo, { steps: 400 });
        G[i] = (1 / T[i] - 1) * Math.exp(-((k * h / kappa) ** power));
    }
    const R = rMax ?? 6 * h;
    const nr = Math.ceil(R / dr);
    const K = new Float64Array(nr + 1);
    const dk = kMax / kPoints;
    for (let j = 0; j <= nr; j++) {
        const r = j * dr;
        let s = 0;
        for (let i = 0; i <= kPoints; i++) {
            const k = ks[i], x = k * r;
            const j0 = x < 1e-8 ? 1 : Math.sin(x) / x;
            const wS = (i === 0 || i === kPoints) ? 1 : (i % 2 ? 4 : 2);
            s += wS * G[i] * j0 * k * k;
        }
        K[j] = s * dk / 3 / (2 * Math.PI * Math.PI);
    }
    return { h, kappa, power, rMax: R, dr, K, ks, T, G, growth };
}

/** K(r) by linear interpolation in the table (0 beyond rMax). */
function kernelAt(ker, r) {
    const x = r / ker.dr, i = Math.floor(x);
    if (i >= ker.K.length - 1) return 0;
    const t = x - i;
    return ker.K[i] * (1 - t) + ker.K[i + 1] * t;
}

/**
 * C(q_i) = Σ_j K(r_ij) V_j [s_j − s_i] over neighbours within the kernel's
 * range: the radial convolution on the glass, in difference form.
 */
export function applyRadialKernel(q, s, volume, ker) {
    const n = q.length / 3;
    const cell = ker.rMax;
    const key = (i, j, k) => ((i + 2048) * 4096 + (j + 2048)) * 4096 + (k + 2048);
    const cellOf = (v) => Math.floor(v / cell);
    const grid = new Map();
    for (let e = 0; e < n; e++) {
        const kk = key(cellOf(q[3 * e]), cellOf(q[3 * e + 1]), cellOf(q[3 * e + 2]));
        let list = grid.get(kk);
        if (!list) grid.set(kk, list = []);
        list.push(e);
    }
    const out = new Float64Array(3 * n);
    const r2Max = cell * cell;
    for (let e = 0; e < n; e++) {
        const x = q[3 * e], y = q[3 * e + 1], z = q[3 * e + 2];
        const sx = s[3 * e], sy = s[3 * e + 1], sz = s[3 * e + 2];
        const ci = cellOf(x), cj = cellOf(y), ck = cellOf(z);
        let cx = 0, cy = 0, cz = 0;
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
            const list = grid.get(key(ci + di, cj + dj, ck + dk));
            if (!list) continue;
            for (const j of list) {
                const dx = q[3 * j] - x, dy = q[3 * j + 1] - y, dz = q[3 * j + 2] - z;
                const r2 = dx * dx + dy * dy + dz * dz;
                if (r2 >= r2Max) continue;
                const w = kernelAt(ker, Math.sqrt(r2)) * volume[j];
                cx += w * (s[3 * j] - sx); cy += w * (s[3 * j + 1] - sy); cz += w * (s[3 * j + 2] - sz);
            }
        }
        out[3 * e] = cx; out[3 * e + 1] = cy; out[3 * e + 2] = cz;
    }
    return out;
}

/** s ← s + C: the field the softened integrator grows into s. */
export function deconvolveGrowth(q, s, volume, ker) {
    const c = applyRadialKernel(q, s, volume, ker);
    const out = new Float64Array(s.length);
    for (let k = 0; k < s.length; k++) out[k] = s[k] + c[k];
    return out;
}
