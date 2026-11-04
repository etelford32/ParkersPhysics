/**
 * js/frequency-analysis.js — PURE numerical frequency analysis (NAFF).
 * Gate: `node tests/frequency-analysis.mjs`. No DOM, no time, no I/O.
 *
 * Laskar's Numerical Analysis of Fundamental Frequencies (Laskar 1990,
 * Icarus 88, 266; Laskar, Froeschlé & Celletti 1992): decompose a uniformly
 * sampled complex signal z(t) into quasi-periodic terms Σ A_k e^{i ν_k t} by
 *
 *   1. weighting with the order-1 Hann window χ(τ) = 1 + cos πτ, τ ∈ [−1, 1]
 *      (mean 1 — so a pure term's windowed projection IS its amplitude),
 *   2. locating the strongest line with a zero-padded FFT (coarse),
 *   3. refining ν by golden-section maximisation of |⟨z, e^{iνt}⟩_χ| — the
 *      Hann window makes this converge like T⁻⁴ instead of the FFT's T⁻¹,
 *      which is the whole point: frequencies good to a tiny fraction of a bin,
 *   4. subtracting A e^{iνt} and repeating.
 *
 * Terms are subtracted sequentially WITHOUT Gram–Schmidt orthogonalisation,
 * then REFINED: each term is added back to the residual (all others removed),
 * re-measured and subtracted again. The first sequential pass carries the
 * leakage of the not-yet-removed lines into each frequency (measured on a
 * 4-cycle record: 1.7e-4 relative); `refine` passes remove it. Lines closer
 * than ~2 bins remain the documented limitation.
 *
 * Time is CENTRED on the window midpoint, so a term's phase is referred to the
 * middle of the record (the least-correlated reference for amplitude/phase).
 */

const TWO_PI = 2 * Math.PI;

/** In-place iterative radix-2 complex FFT (length must be a power of two). */
export function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
        const ang = -TWO_PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
        for (let i = 0; i < n; i += len) {
            let cr = 1, ci = 0;
            for (let k = 0; k < len / 2; k++) {
                const a = i + k, b = a + len / 2;
                const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr; im[b] = im[a] - ti;
                re[a] += tr; im[a] += ti;
                const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
            }
        }
    }
}

/** Order-1 Hann weights χ_k = 1 − cos(2πk/(N−1)) (mean ≈ 1). */
export function hannWindow(n) {
    const w = new Float64Array(n);
    for (let k = 0; k < n; k++) w[k] = 1 - Math.cos((TWO_PI * k) / (n - 1));
    return w;
}

/**
 * Windowed projection ⟨z, e^{iνt}⟩_χ = Σ χ_k z_k e^{−iν t_k} / Σ χ_k with
 * t_k centred. For z = A e^{iνt} this returns A (up to the window's leakage).
 */
export function project(re, im, w, nu, dt) {
    const n = re.length, c = (n - 1) / 2;
    // e^{iνt} by RECURRENCE (one rotation per sample) instead of a cos/sin
    // pair per sample — the projection is the inner loop of every golden-
    // section step, and trig was its whole cost. Rounding drift over 10⁴
    // rotations is ~1e-13, far below anything the analysis resolves.
    const t0 = -c * dt;
    let cs = Math.cos(nu * t0), sn = Math.sin(nu * t0);
    const dc = Math.cos(nu * dt), ds = Math.sin(nu * dt);
    let sr = 0, si = 0, sw = 0;
    for (let k = 0; k < n; k++) {
        // z · e^{−iνt}
        const zr = re[k], zi = im ? im[k] : 0;
        sr += w[k] * (zr * cs + zi * sn);
        si += w[k] * (zi * cs - zr * sn);
        sw += w[k];
        const ncs = cs * dc - sn * ds; sn = sn * dc + cs * ds; cs = ncs;
    }
    return { re: sr / sw, im: si / sw };
}
const mag = (p) => Math.hypot(p.re, p.im);

function goldenMax(f, a, b, iters = 44) {   // 0.618^44 ≈ 6e-10 of the bracket
    const g = (Math.sqrt(5) - 1) / 2;
    let c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
    for (let k = 0; k < iters; k++) {
        if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
        else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
    }
    return (a + b) / 2;
}

/**
 * NAFF: the `terms` strongest quasi-periodic components of z.
 * @param {ArrayLike<number>} re, im  samples (im may be null for a real signal)
 * @param {number} dt                 sample spacing (any time unit)
 * @param {{ terms?: number, pad?: number }} [opts]
 * @returns {Array<{ nu:number, amp:number, re:number, im:number, phase:number }>}
 *          ν in rad per unit of dt, strongest first.
 */
export function naff(re, im, dt, { terms = 3, pad = 4, refine = 2 } = {}) {
    const n = re.length;
    if (n < 16) return [];
    const zr = Float64Array.from(re), zi = im ? Float64Array.from(im) : new Float64Array(n);
    const w = hannWindow(n);
    let m = 1; while (m < n * pad) m <<= 1;
    const out = [];
    for (let t = 0; t < terms; t++) {
        const fr = new Float64Array(m), fi = new Float64Array(m);
        for (let k = 0; k < n; k++) { fr[k] = w[k] * zr[k]; fi[k] = w[k] * zi[k]; }
        fft(fr, fi);
        let best = 0, bestP = -1;
        for (let k = 0; k < m; k++) { const p = fr[k] * fr[k] + fi[k] * fi[k]; if (p > bestP) { bestP = p; best = k; } }
        const bin = best > m / 2 ? best - m : best;
        const nu0 = (TWO_PI * bin) / (m * dt), dnu = TWO_PI / (m * dt);
        const nu = goldenMax((v) => mag(project(zr, zi, w, v, dt)), nu0 - dnu, nu0 + dnu);
        const A = project(zr, zi, w, nu, dt);
        const amp = mag(A);
        if (!(amp > 0)) break;
        out.push({ nu, amp, re: A.re, im: A.im, phase: Math.atan2(A.im, A.re) });
        addTerm(zr, zi, nu, A, dt, -1);
    }
    // Refinement: re-measure every term against the residual of all the others.
    for (let pass = 0; pass < refine; pass++) {
        for (const term of out) {
            addTerm(zr, zi, term.nu, term, dt, +1);
            const dnu = TWO_PI / (m * dt);
            const nu = goldenMax((v) => mag(project(zr, zi, w, v, dt)), term.nu - dnu, term.nu + dnu);
            const A = project(zr, zi, w, nu, dt);
            Object.assign(term, { nu, amp: mag(A), re: A.re, im: A.im, phase: Math.atan2(A.im, A.re) });
            addTerm(zr, zi, nu, A, dt, -1);
        }
    }
    return out.sort((a, b) => b.amp - a.amp);
}

/** z += sign · A e^{iνt} (t centred). */
function addTerm(zr, zi, nu, A, dt, sign) {
    const n = zr.length, c = (n - 1) / 2;
    let cs = Math.cos(-nu * c * dt), sn = Math.sin(-nu * c * dt);
    const dc = Math.cos(nu * dt), ds = Math.sin(nu * dt);
    for (let k = 0; k < n; k++) {
        zr[k] += sign * (A.re * cs - A.im * sn);
        zi[k] += sign * (A.re * sn + A.im * cs);
        const ncs = cs * dc - sn * ds; sn = sn * dc + cs * ds; cs = ncs;
    }
}

/** Frequency resolution of a record: one Fourier bin, 2π / span. */
export function binWidth(n, dt) { return TWO_PI / ((n - 1) * dt); }
