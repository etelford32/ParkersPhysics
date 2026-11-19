/**
 * chaos.js — the CHAOS-8.1 geomagnetic field model (Finlay, Kloss, Olsen et
 * al., DTU Space), time-dependent core field n ≤ 20 and static lithospheric
 * field n = 21–185. PURE: no DOM, no fetch, no ambient time.
 * ═══════════════════════════════════════════════════════════════════════════
 * This module only turns the published coefficients into Gauss coefficients
 * at an instant. EVERY field value goes through js/geomag/igrf.js (the TIGA
 * single-source rule) — `fieldGeocentric(chaosCoeffsAt(m, y), 20, r, θ, φ)`,
 * at the coefficient set's own Legendre stride (`strideOf`).
 *
 * ── TIME ─────────────────────────────────────────────────────────────────
 * The SHC file samples the model's order-6 B-spline (degree-5 pieces) every
 * 0.1 yr, with a BREAK every `step` = 5 samples. On each break interval the
 * spline IS one degree-5 polynomial, and that interval holds exactly 6
 * samples (both ends included), so the 6-point Lagrange polynomial through
 * them reproduces the spline EXACTLY (to the file's 1e-8 nT rounding).
 * ChaosMagPy instead least-squares-fits a B-spline on the same breaks; the
 * two agree because the samples came from that spline, and
 * tests/geomag-chaos.mjs proves it against ChaosMagPy's own numbers. The
 * secular variation is the analytic derivative of the same polynomial.
 * NEGATIVE CONTROL in the gate: piecewise-LINEAR interpolation of the same
 * samples misses the SV by ~10⁻¹ nT/yr — the polynomial is doing the work.
 *
 * Decimal years follow CHAOS's convention (ChaosMagPy leap_year=False):
 * 365.25 days per year from MJD 51544 (2000-01-01 00:00 UT).
 *
 * ── PAST THE LAST DATA ───────────────────────────────────────────────────
 * The data end at `model.end` (2025.10 for 8.1). Beyond it the field is the
 * LINEAR extrapolation along the end-point secular variation — what DTU's own
 * `CHAOS-8.1_core_extrapolated.shc` is, and ChaosMagPy's default. It is a
 * FORECAST, the result says so (`extrapolated`, `yearsPast`), and the
 * gate checks it against DTU's file. Before `model.start` we refuse (null):
 * CHAOS does not cover it and nothing is invented.
 */

const MJD_2000 = 51544;
const MJD_UNIX = 40587;
const DAYS_PER_YEAR = 365.25;

/** CHAOS decimal year of an epoch-ms instant (365.25-day years from 2000.0). */
export function decimalYear(ms) {
    return 2000 + (ms / 86400000 + MJD_UNIX - MJD_2000) / DAYS_PER_YEAR;
}
/** Inverse of decimalYear. */
export function msFromDecimalYear(y) {
    return ((y - 2000) * DAYS_PER_YEAR + MJD_2000 - MJD_UNIX) * 86400000;
}
/** MJD2000 (days since 2000-01-01 00:00 — what ChaosMagPy's synth functions take) of a CHAOS decimal year. */
export function mjd2000FromDecimalYear(y) {
    return (y - 2000) * DAYS_PER_YEAR;
}

/**
 * Decode the baked file (scripts/build-chaos.mjs). `rows[k] = [n, m]` with
 * m < 0 an h coefficient; `samples[k]` is coefficient k's time series, stored
 * as a first value + integer deltas in units of `scale` nT.
 */
export function decodeChaos(baked) {
    const core = baked.core;
    const nT = core.times.length;
    const nC = core.rows.length;
    const data = new Float64Array(nT * nC);          // [t][k]
    for (let k = 0; k < nC; k++) {
        const s = core.samples[k];
        let v = s[0] * core.scale;
        data[k] = v;
        for (let t = 1; t < nT; t++) { v += s[t] * core.scale; data[t * nC + k] = v; }
    }
    return {
        name: baked.name, nmax: core.nmax, order: core.order, step: core.step,
        times: Float64Array.from(core.times), rows: core.rows, data,
        start: core.times[0], end: core.times[nT - 1],
        extrapolated: baked.extrapolated ?? null,
        lithosphere: baked.lithosphere ?? null,
        source: baked.source ?? null,
    };
}

function emptySet(nmax) {
    const g = [], h = [];
    for (let n = 0; n <= nmax; n++) { g.push(new Float64Array(nmax + 1)); h.push(new Float64Array(nmax + 1)); }
    return { g, h };
}

/** Lagrange basis values and derivatives on nodes x at point t. */
function lagrange(x, t) {
    const k = x.length, w = new Float64Array(k), d = new Float64Array(k);
    for (let i = 0; i < k; i++) {
        let p = 1;
        for (let j = 0; j < k; j++) if (j !== i) p *= (t - x[j]) / (x[i] - x[j]);
        w[i] = p;
        let s = 0;
        for (let l = 0; l < k; l++) {
            if (l === i) continue;
            let q = 1 / (x[i] - x[l]);
            for (let j = 0; j < k; j++) if (j !== i && j !== l) q *= (t - x[j]) / (x[i] - x[j]);
            s += q;
        }
        d[i] = s;
    }
    return { w, d };
}

/** The sample indices of the break interval holding year y (clamped inside the data). */
function intervalNodes(model, y) {
    const { step, times } = model;
    const nInt = Math.floor((times.length - 1) / step);
    const t0 = times[0], span = times[times.length - 1] - t0;
    let j = Math.floor(((y - t0) / span) * nInt);
    j = Math.min(Math.max(j, 0), nInt - 1);
    // Guard against float placement right at a break.
    while (j > 0 && y < times[j * step]) j--;
    while (j < nInt - 1 && y > times[(j + 1) * step]) j++;
    const idx = [];
    for (let i = 0; i <= step; i++) idx.push(j * step + i);
    return idx;
}

/**
 * Gauss coefficients and secular variation at decimal year y.
 * @returns {{g,h,sv:{g,h}, year, extrapolated:boolean, yearsPast:number}|null}
 *          nT and nT/yr, indexed [n][m]; null before the model starts.
 */
export function chaosCoeffsAt(model, y, { method = 'spline' } = {}) {
    if (!(y >= model.start - 1e-9)) return null;
    const nC = model.rows.length;
    const out = emptySet(model.nmax), sv = emptySet(model.nmax);
    const vals = new Float64Array(nC), rates = new Float64Array(nC);
    const past = y > model.end;
    const tEval = past ? model.end : y;
    if (method === 'linear') {
        // NEGATIVE CONTROL ONLY: straight lines between 0.1-yr samples.
        const T = model.times;
        let i = 0;
        while (i < T.length - 2 && T[i + 1] < tEval) i++;
        const f = (tEval - T[i]) / (T[i + 1] - T[i]);
        for (let k = 0; k < nC; k++) {
            const a = model.data[i * nC + k], b = model.data[(i + 1) * nC + k];
            vals[k] = a + (b - a) * f; rates[k] = (b - a) / (T[i + 1] - T[i]);
        }
    } else {
        const idx = intervalNodes(model, tEval);
        const x = idx.map((i) => model.times[i]);
        const { w, d } = lagrange(x, tEval);
        for (let k = 0; k < nC; k++) {
            let v = 0, r = 0;
            for (let i = 0; i < idx.length; i++) { const c = model.data[idx[i] * nC + k]; v += w[i] * c; r += d[i] * c; }
            vals[k] = v; rates[k] = r;
        }
    }
    const dt = past ? y - model.end : 0;
    for (let k = 0; k < nC; k++) {
        const [n, m] = model.rows[k];
        const v = vals[k] + rates[k] * dt;
        if (m >= 0) { out.g[n][m] = v; sv.g[n][m] = rates[k]; }
        else { out.h[n][-m] = v; sv.h[n][-m] = rates[k]; }
    }
    return { g: out.g, h: out.h, sv, year: y, extrapolated: past, yearsPast: dt };
}

/** The SV coefficients as a coefficient set (so igrf.js evaluates dB/dt directly). */
export function svSet(c) {
    return { g: c.sv.g, h: c.sv.h };
}

/** The data span and how this instant relates to it, for every label on the page. */
export function coverage(model, y) {
    if (y < model.start) return { state: 'before', yearsPast: 0 };
    if (y <= model.end) return { state: 'data', yearsPast: 0 };
    return { state: 'extrapolated', yearsPast: y - model.end };
}
