/**
 * sun-nanoflares.js — the nanoflare population that heats the corona
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE kernel (no DOM, no three, no fetch, no ambient time) behind the
 * nanoflare layer on sun.html. Node-gated by `tests/sun-nanoflares.mjs`.
 *
 * ── Why this is a kernel and not three lines of noise in the shader ────────
 *
 * The photosphere shader already had a "nanoflare" term: a few sites sprinkled
 * inside each active region, each blinking on a pow(sin, 9) clock. It looked
 * alive and it said nothing. Two things were wrong with it as PHYSICS, and
 * both matter for a page whose job is analysing solar behaviour:
 *
 *   1. IT ONLY FIRED INSIDE ACTIVE REGIONS. Parker's (1988) proposal is about
 *      the QUIET corona: the field is braided by convection everywhere, and it
 *      is the ubiquitous small events that do the heating. A nanoflare model
 *      that switches off when the Sun is spotless has inverted the hypothesis.
 *   2. IT HAD NO ENERGY DISTRIBUTION. The one number that decides whether
 *      nanoflares can heat the corona at all is the power-law index α of
 *      dN/dE ∝ E^−α, and the term had no α to report, tune or be wrong about.
 *
 * ── The α = 2 threshold, which is the whole point ─────────────────────────
 *
 * Total power from a bounded power law is ∫ E·(dN/dE) dE ∝ ∫ E^(1−α) dE, so
 * for α < 2 the integral is dominated by its UPPER limit (the big flares carry
 * the energy) and for α > 2 by its LOWER limit (the unresolved small events
 * do). Hudson (1991) put it plainly: nanoflares can only heat the corona if
 * α > 2. The measurements do not settle it —
 *
 *     Crosby et al. 1993  (HXR flares)      α ≈ 1.8
 *     Hannah et al. 2008  (RHESSI micro)    α ≈ 1.7 – 1.8
 *     Aschwanden et al. 2000 (EUV nano)     α ≈ 1.8
 *     Parnell & Jupp 2000 (TRACE nano)      α ≈ 2.0 – 2.1
 *     Krucker & Benz 1998 (EIT nano)        α ≈ 2.3 – 2.6
 *
 * — which is exactly why α belongs on a control and not in a constant. The
 * page draws the population the index implies and reports the heating flux it
 * delivers against the observational requirement, so the user can watch the
 * budget cross the line as they move α through 2.
 *
 * ── Heating requirement (Withbroe & Noyes 1977, Table 1) ──────────────────
 *     quiet Sun      ~3 × 10⁵ erg cm⁻² s⁻¹
 *     coronal hole   ~8 × 10⁵
 *     active region  ~10⁷
 * These are the numbers `heatingBudget` scores against. They are radiative +
 * conductive + wind losses from the corona, i.e. what any heating mechanism
 * has to supply.
 *
 * ── What the renderer takes from here ─────────────────────────────────────
 * The shader cannot run a kernel per fragment, so the split is:
 *   • THIS MODULE owns the statistics — α, the energy bounds, the sampling
 *     transform, the duration scaling, the rate the live data implies, and the
 *     heating budget that comes out.
 *   • THE SHADER owns placement and the lightcurve, and draws energies by
 *     INVERSE-TRANSFORM SAMPLING the same bounded power law from a hash
 *     (`sampleEnergy` below has a three-line GLSL mirror in sunFS, marked as
 *     such — change both together). Because both sides use the same transform,
 *     the population the page actually renders has the α the control says it
 *     has, and `tests/sun-nanoflares.mjs` measures that slope back out of the
 *     sampler rather than trusting it.
 *
 * Energies are in erg throughout (the literature's unit for this problem);
 * 1 erg = 10⁻⁷ J. A "nanoflare" in Parker's sense is ~10²⁴ erg.
 */

// ── Population bounds ──────────────────────────────────────────────────────
// The decade limits of the nanoflare regime as usually quoted. E_MIN is where
// EUV instruments stop resolving events, not where events stop — which is
// precisely why α > 2 vs α < 2 cannot be settled by counting what we can see.
export const E_MIN_ERG = 1e23;
export const E_MAX_ERG = 1e27;

/** Withbroe & Noyes (1977) coronal energy losses, erg cm⁻² s⁻¹. */
export const HEATING_REQUIREMENT = Object.freeze({
    quiet: 3e5,
    hole: 8e5,
    active: 1e7,
});

/** Published α values, for the page's control to anchor its range and labels. */
export const ALPHA_REFERENCES = Object.freeze([
    { alpha: 1.8, label: 'Crosby 1993 · HXR flares' },
    { alpha: 1.75, label: 'Hannah 2008 · RHESSI microflares' },
    { alpha: 1.8, label: 'Aschwanden 2000 · EUV nanoflares' },
    { alpha: 2.05, label: 'Parnell & Jupp 2000 · TRACE' },
    { alpha: 2.45, label: 'Krucker & Benz 1998 · EIT' },
]);

/** Duration–energy scaling T ∝ E^DURATION_BETA, anchored at E_DUR_REF. */
export const DURATION_BETA = 0.33;      // Aschwanden & Parnell 2002, order-of
export const DURATION_REF_S = 60;       // a 10²⁴ erg event lasts ~1 min
export const E_DUR_REF = 1e24;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Inverse-transform sample of a BOUNDED power law dN/dE ∝ E^−α on [eMin,eMax].
 *
 * CDF(E) = (E^(1−α) − eMin^(1−α)) / (eMax^(1−α) − eMin^(1−α)), so
 *   E(u)  = [eMin^(1−α) + u·(eMax^(1−α) − eMin^(1−α))]^(1/(1−α)).
 *
 * ── GLSL MIRROR (sunFS, `nfSampleEnergy`) — change both together ──────────
 *   float nfSampleEnergy(float u, float a, float lmin, float lmax) {
 *       float p  = 1.0 - a;
 *       float A  = exp2(lmin * p), B = exp2(lmax * p);   // log2 bounds
 *       return log2(A + u * (B - A)) / p;                // returns log2(E)
 *   }
 * The shader works in log2(E) because E spans four decades and a float32
 * cannot hold 10²³ and 10²⁷ usefully at once — 10²⁷ is 2^89.7, comfortably
 * inside float range, but the DIFFERENCE B − A loses every bit of the small
 * end. In log space the sampler is exact across the whole range.
 *
 * α = 1 is the removable singularity (the CDF becomes logarithmic); it is
 * handled explicitly rather than left to produce a 0/0.
 */
export function sampleEnergy(u, alpha, eMin = E_MIN_ERG, eMax = E_MAX_ERG) {
    const t = clamp(u, 0, 1 - 1e-12);
    if (Math.abs(alpha - 1) < 1e-9) return eMin * Math.pow(eMax / eMin, t);
    const p = 1 - alpha;
    const A = Math.pow(eMin, p), B = Math.pow(eMax, p);
    return Math.pow(A + t * (B - A), 1 / p);
}

/**
 * Fraction of the population's TOTAL ENERGY carried by events below eSplit.
 *
 *   ∫ E·E^−α dE ∝ E^(2−α)/(2−α)   (α ≠ 2)
 *                 ln E             (α = 2)
 *
 * This is the function that makes the α = 2 threshold visible: sweep α through
 * 2 with eSplit at, say, 10²⁵ erg and watch the answer swing from "the big
 * events carry it" to "the small ones do".
 */
export function energyFractionBelow(eSplit, alpha, eMin = E_MIN_ERG, eMax = E_MAX_ERG) {
    const s = clamp(eSplit, eMin, eMax);
    if (Math.abs(alpha - 2) < 1e-9) {
        return Math.log(s / eMin) / Math.log(eMax / eMin);
    }
    const q = 2 - alpha;
    const f = (x) => Math.pow(x, q);
    const r = (f(s) - f(eMin)) / (f(eMax) - f(eMin));
    return r === 0 ? 0 : r;      // for α > 2 both terms are negative and s = eMin yields −0

}

/** Mean energy per event, erg. Same integrals as above, taken in full. */
export function meanEnergy(alpha, eMin = E_MIN_ERG, eMax = E_MAX_ERG) {
    // <E> = ∫E·E^−α / ∫E^−α over [eMin, eMax].
    const powInt = (expo) => {
        if (Math.abs(expo + 1) < 1e-9) return Math.log(eMax / eMin);
        const k = expo + 1;
        return (Math.pow(eMax, k) - Math.pow(eMin, k)) / k;
    };
    return powInt(1 - alpha) / powInt(-alpha);
}

/** Event duration for an energy, seconds. T ∝ E^β anchored at E_DUR_REF. */
export function durationFor(energyErg, beta = DURATION_BETA) {
    return DURATION_REF_S * Math.pow(Math.max(energyErg, 1) / E_DUR_REF, beta);
}

/**
 * Coronal heating flux delivered by a population, erg cm⁻² s⁻¹.
 * @param {number} rate events per cm² per second
 */
export function heatingFlux(rate, alpha, eMin = E_MIN_ERG, eMax = E_MAX_ERG) {
    return rate * meanEnergy(alpha, eMin, eMax);
}

/** The event rate (cm⁻² s⁻¹) a population needs to meet a heating target. */
export function rateForFlux(flux, alpha, eMin = E_MIN_ERG, eMax = E_MAX_ERG) {
    return flux / meanEnergy(alpha, eMin, eMax);
}

// ── Measuring α back out of a population ──────────────────────────────────
//
// sun.html's default nanoflare driver is a SELF-ORGANIZED CRITICALITY
// avalanche grid, and the whole point of an SOC model is that the power law is
// EMERGENT — it falls out of the avalanche dynamics rather than being dialled
// in. Forcing α on it would delete the physics. So instead the page measures
// the index the avalanches actually produce and scores THAT against the
// heating requirement: a corona that organises itself and then reports whether
// it can pay its own energy bill.
//
// The estimator is a maximum likelihood fit, not a log-log regression on a
// histogram. Binned regression is the classic way to get a power-law index
// wrong (Clauset, Shalizi & Newman 2009 §3): the bins at the sparse end carry
// the most leverage and the least data. The Hill/CSN closed form
// α̂ = 1 + n/Σln(E/E_min) assumes an UNBOUNDED tail, which this population is
// not — there is a hard E_MAX — so the likelihood is maximised numerically
// over the bounded law instead. Sixty ternary-search steps on a unimodal
// function costs nothing and is exact to far better than the spread of the
// published measurements.

/** Log-likelihood of a bounded power law with index α for the given log-energies. */
function boundedLogLik(sumLogE, n, alpha, eMin, eMax) {
    // L = −α·Σln E − n·ln C,  C = ∫ E^−α dE over [eMin, eMax]
    let C;
    if (Math.abs(alpha - 1) < 1e-9) {
        C = Math.log(eMax / eMin);
    } else {
        const p = 1 - alpha;
        C = (Math.pow(eMax, p) - Math.pow(eMin, p)) / p;
    }
    if (!(C > 0) || !Number.isFinite(C)) return -Infinity;
    return -alpha * sumLogE - n * Math.log(C);
}

/** CDF of the bounded power law, for the goodness-of-fit test. */
function boundedCdf(E, alpha, eMin, eMax) {
    if (Math.abs(alpha - 1) < 1e-9) return Math.log(E / eMin) / Math.log(eMax / eMin);
    const p = 1 - alpha;
    const a = Math.pow(eMin, p), b = Math.pow(eMax, p);
    return (Math.pow(E, p) - a) / (b - a);
}

/**
 * Maximum-likelihood α for a sample drawn from a bounded power law.
 *
 * @param {ArrayLike<number>} energies  event energies (values outside the
 *        fitted range are DISCARDED, not clamped — clamping would pile mass on
 *        the bounds and bias the fit toward them)
 * @param {number} [eMin] @param {number} [eMax]
 * @param {object} [opts]
 * @param {boolean} [opts.autoRange]  fit over the range the SAMPLE spans
 *        instead of the nominal one. Required whenever the energies are in
 *        somebody else's units — see AlphaMonitor.
 * @returns {{alpha:number, n:number, ok:boolean, ks:number, eMin:number,
 *            eMax:number, atBound:boolean}}
 *          `ok` = enough events AND the law actually describes them. Below ~50
 *          events the spread on α is wider than the whole range of published
 *          values, and a large `ks` means the sample is not power-law
 *          distributed at all — in either case the caller must not print α.
 */
export function fitAlphaMLE(energies, eMin = E_MIN_ERG, eMax = E_MAX_ERG, opts = {}) {
    let lowest = Infinity, highest = 0, seen = 0;
    for (let i = 0; i < energies.length; i++) {
        const E = energies[i];
        if (!(E > 0)) continue;
        if (E < lowest) lowest = E;
        if (E > highest) highest = E;
        seen++;
    }
    if (opts.autoRange && seen >= 8 && highest > lowest * 1.05) {
        eMin = lowest; eMax = highest;
    }
    const vals = [];
    let sumLogE = 0;
    for (let i = 0; i < energies.length; i++) {
        const E = energies[i];
        if (!(E > 0) || E < eMin || E > eMax) continue;
        sumLogE += Math.log(E);
        vals.push(E);
    }
    const n = vals.length;
    const fail = { alpha: NaN, n, ok: false, ks: 1, eMin, eMax, atBound: false };
    if (n < 8) return fail;

    const LO = 1.02, HI = 3.6;
    let lo = LO, hi = HI;
    for (let it = 0; it < 60; it++) {
        const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
        if (boundedLogLik(sumLogE, n, m1, eMin, eMax) < boundedLogLik(sumLogE, n, m2, eMin, eMax)) lo = m1;
        else hi = m2;
    }
    const alpha = (lo + hi) / 2;
    const atBound = alpha < LO + 0.02 || alpha > HI - 0.02;

    // Kolmogorov–Smirnov distance between the empirical CDF and the fitted law.
    // Without it the estimator answers for ANY sample, including one that is
    // not a power law — and a number with no goodness attached is exactly the
    // kind of confident wrong answer this whole layer is trying not to give.
    vals.sort((a, b) => a - b);
    let ks = 0;
    for (let i = 0; i < n; i++) {
        const F = boundedCdf(vals[i], alpha, eMin, eMax);
        ks = Math.max(ks, Math.abs(F - i / n), Math.abs((i + 1) / n - F));
    }
    return { alpha, n, ks, eMin, eMax, atBound, ok: n >= 50 && ks < 0.09 && !atBound };
}

/**
 * Sliding-window α estimator for a live event stream.
 *
 * Holds the last `capacity` energies in a ring buffer and refits on demand.
 * A ring rather than a running sum because the bounded-law MLE has no
 * incremental form — and because a window that forgets is what makes the
 * number track a Sun whose activity is changing, instead of averaging over
 * everything since page load.
 */
export class AlphaMonitor {
    constructor({ capacity = 4000, eMin = E_MIN_ERG, eMax = E_MAX_ERG } = {}) {
        this.buf = new Float64Array(capacity);
        this.capacity = capacity;
        this.eMin = eMin;
        this.eMax = eMax;
        this.head = 0;
        this.count = 0;
        this.total = 0;          // events ever seen (for the rate)
    }
    push(energyErg) {
        if (!(energyErg > 0)) return;
        this.buf[this.head] = energyErg;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity) this.count++;
        this.total++;
    }
    /**
     * Fit the window.
     *
     * `autoRange` defaults ON, and that is load-bearing for the SOC grid. Its
     * events are released STRESS in the model's own units; the map onto erg is
     * a display convention, and the avalanches span well under one decade of
     * it. Fitting those against the nominal four-decade range measures the
     * convention — it pinned α at the search bound, 3.6, on the first run.
     * A power-law index is invariant under E → cE, so the honest fit is over
     * the range the sample actually occupies.
     */
    fit({ autoRange = true } = {}) {
        const view = this.count === this.capacity ? this.buf : this.buf.subarray(0, this.count);
        return fitAlphaMLE(view, this.eMin, this.eMax, { autoRange });
    }
    reset() { this.head = 0; this.count = 0; this.total = 0; }
}

// ── Live drive ─────────────────────────────────────────────────────────────
//
// The event rate is set by how much free magnetic energy convection is
// braiding into the field, which is not something a browse image measures. The
// page uses the two live proxies it does have, and SAYS they are proxies:
//
//   F10.7  — chromospheric/coronal radio flux, the standard activity index.
//            Quiet Sun floors near 65 sfu; 250+ is a busy maximum. Scaled
//            LINEARLY above the floor: the network flux that feeds quiet-Sun
//            nanoflares is roughly proportional to the excess.
//   AR area — NOAA's reported sunspot areas, in millionths of a hemisphere.
//            Active-region nanoflare rates run orders of magnitude above quiet
//            Sun (the heating requirement itself is ~30× higher), so area
//            enters as a multiplier on the AR term only.
//
// The BASE rate is pinned to the observational requirement rather than to a
// theoretical count: at α = 2.0 the quiet-Sun population is normalised to
// deliver exactly Withbroe & Noyes' 3 × 10⁵ erg cm⁻² s⁻¹. Every other α then
// reports what it would actually deliver at the same event rate, which is the
// comparison the page exists to show.

export const F107_QUIET = 65;      // sfu — the floor of the solar cycle
export const ALPHA_NORM = 2.0;     // α at which the base rate meets the quiet requirement

/**
 * @param {object} o
 * @param {number} [o.f107]      10.7 cm radio flux, sfu
 * @param {number} [o.arAreaMh]  total reported sunspot area, millionths of a hemisphere
 * @param {number} [o.alpha]     power-law index
 * @returns {{alpha:number, rateQuiet:number, rateActive:number, meanErg:number,
 *            fluxQuiet:number, fluxActive:number, budgetQuiet:number,
 *            budgetActive:number, smallEventShare:number, activityFactor:number,
 *            durationRefS:number, canHeat:boolean}}
 */
export function nanoflareState({ f107 = 150, arAreaMh = 0, alpha = 2.0 } = {}) {
    const a = clamp(Number.isFinite(alpha) ? alpha : 2.0, 1.2, 3.0);
    const meanErg = meanEnergy(a);

    // Base rate: the count that meets the quiet requirement at ALPHA_NORM.
    const baseRate = rateForFlux(HEATING_REQUIREMENT.quiet, ALPHA_NORM);

    const f = Number.isFinite(f107) ? f107 : 150;
    const activityFactor = clamp(1 + (f - F107_QUIET) / 120, 0.6, 3.2);
    const areaFactor = 1 + clamp(arAreaMh, 0, 5000) / 600;

    const rateQuiet  = baseRate * activityFactor;
    const rateActive = baseRate * activityFactor * areaFactor * 12;   // AR corona runs far hotter

    const fluxQuiet  = rateQuiet  * meanErg;
    const fluxActive = rateActive * meanErg;

    return {
        alpha: a,
        meanErg,
        rateQuiet,
        rateActive,
        fluxQuiet,
        fluxActive,
        budgetQuiet:  fluxQuiet  / HEATING_REQUIREMENT.quiet,
        budgetActive: fluxActive / HEATING_REQUIREMENT.active,
        // Share of the energy carried by events below 10²⁵ erg — the part no
        // instrument resolves. This crossing 0.5 IS the α = 2 threshold.
        smallEventShare: energyFractionBelow(1e25, a),
        activityFactor,
        durationRefS: DURATION_REF_S,
        canHeat: a > 2.0,
    };
}

/**
 * One line of provenance for the HUD. Never claims the rate is measured — the
 * rate is a normalisation, α is a choice, and only F10.7 and the AR areas come
 * off a wire.
 */
export function nanoflareLabel(state) {
    const pct = (state.smallEventShare * 100).toFixed(0);
    const bud = state.budgetQuiet;
    const verdict = state.alpha > 2
        ? `α>2 · unresolved events carry ${pct}% of the budget`
        : `α<2 · large events carry ${100 - +pct}% of the budget`;
    return `nanoflares α=${state.alpha.toFixed(2)} · ${verdict} · quiet-corona budget ×${bud.toFixed(2)}`;
}

/**
 * Shader-facing packing. Kept here so the uniform layout has ONE definition
 * and the test can assert the shader is fed what the physics says.
 *   x = alpha
 *   y = log2(E_MIN)      (the sampler works in log2 — see sampleEnergy)
 *   z = log2(E_MAX)
 *   w = rate multiplier vs the ALPHA_NORM quiet baseline
 */
export function nanoflareUniform(state) {
    return [
        state.alpha,
        Math.log2(E_MIN_ERG),
        Math.log2(E_MAX_ERG),
        state.rateQuiet / rateForFlux(HEATING_REQUIREMENT.quiet, ALPHA_NORM),
    ];
}
