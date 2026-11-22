/**
 * js/bz/geo-filter.js — a sequential estimator for the geosynchronous residual (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B4 (§4.8), in the mould of js/geomag/tiga.js. No
 * DOM, no fetch, no ambient time. Gate: tests/bz-column.mjs (incl. an OSSE).
 *
 * ── WHY IT EXISTS ────────────────────────────────────────────────────────
 * B3's first ledger FAILED on real data (plan §14): a fixed magnetopause-
 * current formula scored WORSE than the same formula on a nominal wind,
 * because most of what a GOES magnetometer sees across a day is the tail and
 * ring currents the formula omits. Typing more coefficients in is not the
 * answer. This filter LEARNS the residual's shape from the instrument itself:
 *
 *   Hp_res(t) = c₀ + a₁cos φ + b₁sin φ + a₂cos 2φ + b₂sin 2φ + g·D(t) + ε
 *
 *   φ    = local time as an angle — the harmonics stand in for whatever
 *          quiet-time current systems this satellite sits under;
 *   D(t) = √P_dyn of the wind that has ARRIVED, minus √P_dyn of the nominal
 *          wind — the one physical driver, with ONE gain g (nT per √nPa);
 *   the six coefficients are the STATE, a random walk; the filter is a
 *   Kalman filter on them.
 *
 * Nothing in it is typed from a paper. What it claims is tested where there
 * is truth: a prediction made `leadMin` ahead (state as of t − lead, driver
 * from the wind already in transit) is scored against the magnetometer.
 *
 * ── THE TWO CONTROLS IT IS SCORED AGAINST ────────────────────────────────
 *   persistence     the residual `leadMin` ago;
 *   harmonics-only  the SAME filter with the gain pinned at 0 — if the full
 *                   filter does not beat it, knowing the upstream wind has
 *                   bought nothing at this satellite, and the result says so.
 *
 * ── CALIBRATION IS REPORTED, NOT ASSUMED ─────────────────────────────────
 * The residual's errors are strongly autocorrelated (minutes of the same
 * mis-modelled current), which a Kalman filter with white observation noise
 * does not know: its 1σ is expected to be TOO NARROW. `coverage68` is that
 * measurement. The gate pins the shortfall (the TIGA rule) — widening the
 * bars to hit 68 % must fail it.
 *
 * A MISSING DRIVER is not a zero driver: when no wind has arrived, the row
 * is used with D = 0 and its observation variance inflated ×4, and the gain
 * is not touched by it (its column is 0, so the update cannot move it).
 */

export const FILTER_DEFAULTS = Object.freeze({
    leadMin: 30,
    // Prior 1σ of each coefficient, nT (gain: nT per √nPa). Wide on purpose.
    prior: [40, 15, 15, 8, 8, 20],
    // Random-walk drift, 1σ per DAY — how fast the quiet-time shape may change.
    driftPerDay: [6, 4, 4, 2, 2, 4],
    obsVarFloor: 0.25,       // nT² — instrument + rounding
    obsVarInit: 4,           // nT²
    obsVarTauMin: 360,       // EWMA time for the adaptive observation variance
    missingDriverInflate: 4,
    minScored: 240,
});
export const COEFF_NAMES = Object.freeze(['c0', 'a1', 'b1', 'a2', 'b2', 'gain']);
const NS = 6;

/** The regressor row for a local time (hours) and a driver value. */
export function regressors(localTimeH, driver) {
    const p = 2 * Math.PI * localTimeH / 24;
    return [1, Math.cos(p), Math.sin(p), Math.cos(2 * p), Math.sin(2 * p), driver === driver ? driver : 0];
}

function matVec(P, h) { const o = new Array(NS).fill(0); for (let i = 0; i < NS; i++) for (let j = 0; j < NS; j++) o[i] += P[i * NS + j] * h[j]; return o; }
const dot = (a, b) => { let s = 0; for (let i = 0; i < NS; i++) s += a[i] * b[i]; return s; };

/**
 * Run the filter over one satellite's series.
 *
 * @param {{ t:ArrayLike<number>, y:ArrayLike<number>, localTimeH:ArrayLike<number>, driver:ArrayLike<number> }} s
 *        y = Hp residual (NaN = excluded), driver = NaN where no wind had arrived
 * @param {{ pinGain?: boolean }} [opts] pinGain = the harmonics-only control
 * @returns {{ pred:Float64Array, predSigma:Float64Array, x:number[], sigmaX:number[], obsVar:number, updates:number }}
 *          pred[i] = the prediction for t[i] made with the state at t[i] − leadMin
 */
export function runFilter(s, opts = {}) {
    const o = { ...FILTER_DEFAULTS, ...opts };
    const n = s.t.length;
    const x = new Array(NS).fill(0);
    const P = new Float64Array(NS * NS);
    for (let i = 0; i < NS; i++) P[i * NS + i] = o.prior[i] ** 2;
    if (o.pinGain) P[5 * NS + 5] = 0;
    const qDay = o.driftPerDay.map((d) => d * d);
    if (o.pinGain) qDay[5] = 0;

    const pred = new Float64Array(n).fill(NaN), predSigma = new Float64Array(n).fill(NaN);
    // History of (time, state, covariance) so a prediction can use the state as of t − lead.
    const hist = [];
    let R = o.obsVarInit, updates = 0, tPrev = null, hi = 0;

    for (let i = 0; i < n; i++) {
        const t = s.t[i];
        // ── time update: the coefficients random-walk ────────────────────
        if (tPrev != null) {
            const days = Math.max(0, t - tPrev) / 86400e3;
            for (let k = 0; k < NS; k++) P[k * NS + k] += qDay[k] * days;
        }
        tPrev = t;

        const h = regressors(s.localTimeH[i], s.driver[i]);

        // ── the lead-ahead prediction for THIS minute, from the past ─────
        const want = t - o.leadMin * 60e3;
        while (hi + 1 < hist.length && hist[hi + 1].t <= want) hi++;
        if (hist.length && hist[hi].t <= want && want - hist[hi].t < 15 * 60e3) {
            const past = hist[hi];
            const days = (t - past.t) / 86400e3;
            let v = 0;
            const Ph = matVec(past.P, h);
            v = dot(h, Ph);
            for (let k = 0; k < NS; k++) v += h[k] * h[k] * qDay[k] * days;
            pred[i] = dot(h, past.x);
            predSigma[i] = Math.sqrt(Math.max(0, v) + past.R);
        }

        // ── measurement update ───────────────────────────────────────────
        const y = s.y[i];
        if (y === y) {
            const haveDriver = s.driver[i] === s.driver[i];
            const Rk = haveDriver || o.pinGain ? R : R * o.missingDriverInflate;
            const Ph = matVec(P, h);
            const S = dot(h, Ph) + Rk;
            const innov = y - dot(h, x);
            for (let k = 0; k < NS; k++) x[k] += Ph[k] * innov / S;
            for (let a = 0; a < NS; a++) for (let b = 0; b < NS; b++) P[a * NS + b] -= Ph[a] * Ph[b] / S;
            // Adaptive observation variance: what the innovations say is left over.
            const alpha = 1 / o.obsVarTauMin;
            R = Math.max(o.obsVarFloor, (1 - alpha) * R + alpha * Math.max(0, innov * innov - dot(h, Ph)));
            updates++;
        }
        hist.push({ t, x: x.slice(), P: Float64Array.from(P), R });
        // Keep only what a future lead-ahead read can need.
        if (hist.length > 4 * o.leadMin + 60) { hist.splice(0, hist.length - (2 * o.leadMin + 30)); hi = 0; }
    }
    return { pred, predSigma, x, sigmaX: Array.from({ length: NS }, (_, k) => Math.sqrt(Math.max(0, P[k * NS + k]))), obsVar: R, updates };
}

/**
 * Score lead-ahead predictions against the observation. `skipMin` drops the
 * filter's spin-up from the score (it is still run, causally).
 */
export function scoreFilter(s, run, control, opts = {}) {
    const o = { ...FILTER_DEFAULTS, ...opts };
    const n = s.t.length, lead = o.leadMin * 60e3;
    const t0 = s.t[0] + (opts.skipMin ?? 360) * 60e3;
    let m = 0, se = 0, sc = 0, sp = 0, inside = 0, j = 0;
    for (let i = 0; i < n; i++) {
        const y = s.y[i], p = run.pred[i], c = control.pred[i], sg = run.predSigma[i];
        if (s.t[i] < t0 || !(y === y && p === p && c === c && sg === sg)) continue;
        while (j < n && s.t[j] < s.t[i] - lead) j++;
        const persist = j < n && Math.abs(s.t[j] - (s.t[i] - lead)) < 90e3 ? s.y[j] : NaN;
        if (!(persist === persist)) continue;
        m++; se += (y - p) ** 2; sc += (y - c) ** 2; sp += (y - persist) ** 2;
        if (Math.abs(y - p) <= sg) inside++;
    }
    if (m < o.minScored) return { n: m, rmse: null, rmse_harmonics_only: null, rmse_persistence: null, skill_vs_harmonics_only: null, skill_vs_persistence: null, coverage68: null };
    return { n: m, rmse: Math.sqrt(se / m), rmse_harmonics_only: Math.sqrt(sc / m), rmse_persistence: Math.sqrt(sp / m),
        skill_vs_harmonics_only: sc > 0 ? 1 - se / sc : null, skill_vs_persistence: sp > 0 ? 1 - se / sp : null, coverage68: inside / m };
}
