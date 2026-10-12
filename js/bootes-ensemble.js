/**
 * bootes-ensemble.js — a posterior ensemble of reconstructed pasts
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no fetch, no Worker. The reconstruction (js/bootes-
 * reconstruct.js + js/bootes-forward-model.js) returns ONE past: the MAP fit.
 * This turns it into a sampled posterior (BOOTES_VOID_PLAN.md §4m).
 * `node tests/bootes-ensemble.mjs` pins every step.
 *
 * RANDOMISED MAXIMUM LIKELIHOOD
 * ─────────────────────────────
 * For a near-linear problem with Gaussian noise, re-fitting with every
 * noise source redrawn yields samples of the posterior (Kitanidis 1995;
 * Oliver et al. 1996). The reconstruction's noise is DISCRETENESS, and it
 * has two independent sources, so each member redraws both:
 *  - the ELEMENTS' grain: a member builds its own glass from its own seed —
 *    a fresh realisation of exactly the grain the fit's σ_elements stands
 *    for;
 *  - the TARGET's grain: a member adds to the data the field of another
 *    bare glass at the data points, scaled to σ_target — a fresh
 *    realisation of the noise the likelihood says the data carry.
 * The band-limit prior is flat inside the band and a point mass outside, so
 * it has nothing to redraw (and the spread says nothing about modes above
 * the band — stated where it is printed).
 *
 * MEASURED on the page-scale planted twin (4 members, gravity at the
 * tracers, core / wall / out — plan §4m): the ensemble MEAN beats one member
 * at every epoch (z = 9 3.1 / 10.1 / 28.8 → 2.3 / 7.8 / 21.7 %), and the
 * SPREAD is calibrated — the truth sits inside its 1σ for 64–84 % of points
 * (68 % is calibrated) and |mean − truth| / (σ √(1 + 1/N)) = 0.85–1.33.
 *
 * WHAT IT IS NOT
 * ──────────────
 *  - It does not sample MODEL error: the void profile, the web model, the
 *    tracer bias. The bias band (b ± 20 %) is the page's separate statement
 *    of the dominant systematic.
 *  - N is small (each member is a full reconstruction), so the spread is
 *    itself uncertain by ~1/√(2(N−1)) — ±41 % at N = 4. The page says N.
 */

/** The page's ensemble, in one place. */
export const ENSEMBLE_CONFIG = Object.freeze({
    members: 4,
    glassSeedBase: 101,
    noiseSeedBase: 201,
});

/** Member k's two noise realisations (k = 1 … N). */
export function memberSeeds(k, config = ENSEMBLE_CONFIG) {
    return { glassSeed: config.glassSeedBase + k, noiseSeed: config.noiseSeedBase + k };
}

/**
 * Per-point ensemble mean and UNBIASED spread of N fields (each a
 * Float64Array of 3-vectors at the same points). `variance[i]` is the summed
 * per-component variance |σ|² at point i.
 */
export function ensembleStats(fields) {
    const N = fields.length;
    if (N < 2) throw new Error('ensemble: need at least two members');
    const len = fields[0].length;
    for (const f of fields) if (f.length !== len) throw new Error('ensemble: members disagree on the points');
    const n = len / 3;
    const mean = new Float64Array(len);
    for (const f of fields) for (let k = 0; k < len; k++) mean[k] += f[k] / N;
    const variance = new Float64Array(n);
    for (const f of fields) {
        for (let i = 0; i < n; i++) {
            let s = 0;
            for (let d = 0; d < 3; d++) s += (f[3 * i + d] - mean[3 * i + d]) ** 2;
            variance[i] += s / (N - 1);
        }
    }
    return { N, mean, variance };
}

/**
 * The page's summary: per region (inside / outside `rSplit`), the rms spread
 * as a fraction of the rms ensemble-mean field there.
 */
export function spreadSummary(fields, points, rSplit) {
    const { N, mean, variance } = ensembleStats(fields);
    const acc = [[0, 0, 0], [0, 0, 0]];
    for (let i = 0; i < variance.length; i++) {
        const r = Math.hypot(points[3 * i], points[3 * i + 1], points[3 * i + 2]);
        const A = acc[r < rSplit ? 0 : 1];
        A[0] += variance[i];
        A[1] += mean[3 * i] ** 2 + mean[3 * i + 1] ** 2 + mean[3 * i + 2] ** 2;
        A[2]++;
    }
    const rel = (A) => (A[2] && A[1] > 0 ? Math.sqrt(A[0] / A[1]) : NaN);
    return { N, inside: rel(acc[0]), outside: rel(acc[1]), points: [acc[0][2], acc[1][2]] };
}

/** ln Γ (Lanczos, g = 7). */
function lnGamma(x) {
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
        -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
    x -= 1;
    let a = c[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised incomplete beta I_x(a, b) (continued fraction, Lentz). */
function incompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(1 - x, b, a);
    const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x)) / a;
    let f = 1, c = 1, d = 0;
    for (let i = 0; i <= 400; i++) {
        const m = Math.floor(i / 2);
        const num = i === 0 ? 1 : i % 2 === 0
            ? (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m))
            : -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
        d = 1 + num * d; d = Math.abs(d) < 1e-300 ? 1e-300 : d; d = 1 / d;
        c = 1 + num / c; c = Math.abs(c) < 1e-300 ? 1e-300 : c;
        const cd = c * d;
        f *= cd;
        if (Math.abs(1 - cd) < 1e-14) break;
    }
    return front * (f - 1);
}

/** The q-quantile of Fisher's F(d1, d2) (bisection on its CDF). */
export function fQuantile(q, d1, d2) {
    const cdf = (x) => incompleteBeta(d1 * x / (d1 * x + d2), d1 / 2, d2 / 2);
    let lo = 0, hi = 1;
    while (cdf(hi) < q) hi *= 2;
    for (let i = 0; i < 100; i++) { const m = 0.5 * (lo + hi); if (cdf(m) < q) lo = m; else hi = m; }
    return 0.5 * (lo + hi);
}

/**
 * Score an ensemble against a KNOWN truth (the planted twin): per region,
 * the typical member's error, the mean's error, the spread (all relative to
 * the rms truth), the calibration ratio R = |mean − truth| / (σ √(1 + 1/N))
 * (1 for a calibrated ensemble — the mean of N draws misses by σ²(1 + 1/N)),
 * and the coverage: the share of points whose miss is inside its own 1σ.
 * With σ itself ESTIMATED from N members, the per-point statistic
 * (|x̄ − t|²/3) / (s²(1 + 1/N)/3) is F(3, 3(N − 1)), not χ²₃/3 — so the
 * 68 % threshold is that F's quantile (1.18 only as N → ∞; measured on
 * calibrated draws, the χ²₃ threshold read 63 % at N = 4).
 */
export function calibration(fields, truth, regionOf) {
    const { N, mean, variance } = ensembleStats(fields);
    const threshold = fQuantile(0.6827, 3, 3 * (N - 1));
    const regions = new Map();
    for (let i = 0; i < variance.length; i++) {
        const key = regionOf(i);
        if (key == null) continue;
        if (!regions.has(key)) regions.set(key, { t: 0, single: 0, meanErr: 0, var: 0, cover: 0, n: 0 });
        const A = regions.get(key);
        let tt = 0, me = 0, se = 0;
        for (let d = 0; d < 3; d++) {
            const T = truth[3 * i + d];
            tt += T * T;
            me += (mean[3 * i + d] - T) ** 2;
            for (const f of fields) se += (f[3 * i + d] - T) ** 2 / N;
        }
        A.t += tt; A.meanErr += me; A.single += se; A.var += variance[i]; A.n++;
        if (me <= variance[i] * (1 + 1 / N) * threshold) A.cover++;
    }
    const out = {};
    for (const [key, A] of regions) {
        out[key] = {
            single: Math.sqrt(A.single / A.t),
            mean: Math.sqrt(A.meanErr / A.t),
            spread: Math.sqrt(A.var / A.t),
            ratio: Math.sqrt(A.meanErr / (A.var * (1 + 1 / N))),
            coverage: A.cover / A.n,
            points: A.n,
        };
    }
    return out;
}
