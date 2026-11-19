/**
 * geoelectric.js — surface geoelectric field from magnetometer data through a
 * 1-D ground column. Pure kernel. Gate: `tests/earth-interior-geoelectric.mjs`.
 * Plan: `INNER_EARTH_PLAN.md` §8 P1.
 *
 * ── WHAT THIS IS, HONESTLY ───────────────────────────────────────────────
 * The plane-wave method of NERC TPL-007: the ground is a 1-D layer cake
 * (`conductivity.js` `layeredImpedance`), the source is a vertically incident
 * plane wave, and for a 1-D Earth
 *        E_north =  Z · B_east / μ₀        E_east = −Z · B_north / μ₀ .
 * It is EXACT for that idealisation and wrong in the ways the idealisation is
 * wrong: no 3-D ground (coasts, basins, the real reason sites differ by 10×),
 * no source structure (an electrojet overhead is not a plane wave), and a
 * column chosen BY ID (USGS's region polygons are not baked). Every number
 * this produces is "E for this column under this B", and consumers say so.
 *
 * ── HOW THE TIME SERIES IS COMPUTED ──────────────────────────────────────
 * Once per column an EXACTLY causal kernel w (V/km per nT of field change)
 * is built for B piecewise linear between samples (see the kernel section:
 * two FFT versions were tried first and measured wrong). E is a DIRECT
 * convolution E[n] = Σ_{j<L} w[j]·ΔB[n−j], so the two errors are explicit:
 *   • MEMORY TRUNCATION — the step response left at lag L
 *     (`kernel.tailVkmPerNt`), dropped and gated small.
 *   • HISTORY — the ground remembers (a half-space's step response decays only
 *     as t^-1/2), so the first `warmupSamples` of a segment lack history they
 *     need; they are FLAGGED, and the gate measures how long that is.
 * A constant field gives exactly zero E (only increments enter), so the
 * observatory baseline — absolute level, the thing TIGA's placeholder
 * baseline gets wrong — does not enter at all. E depends only on CHANGE.
 *
 * Gaps are not invented. A gap up to `maxBridgeSamples` is bridged linearly
 * and every bridged sample is flagged; a longer gap ends the segment and the
 * next one restarts its warm-up. Unknown E is null, never 0.
 */

import { MU0, layeredImpedance, GRAYVER_2017, layersFromModel } from './conductivity.js';
import { GROUND_MODELS } from './ground-models.js';

/** Causal memory kept (samples; 12 h at 60 s) and the warm-up flagged at a segment start. */
export const KERNEL_KEEP = 720;
// Measured (gate F4): the missing pre-segment history still contributes, as a
// fraction of rms |E|, after 120 min: 3–7 % (BR1 17 %); 240 min: ≤ 5 % (BR1
// 11 %); 360 min: ≤ 3 % (BR1 6 %). 240 is the flag; the nowcast asks for 720.
export const WARMUP_SAMPLES = 240;
export const MAX_BRIDGE_SAMPLES = 5;

// ── Ground columns ──────────────────────────────────────────────────────────

/** Grayver 2017 as a LAND column: the 7 kS ocean layer replaced by the crust below it. */
const GRAYVER_LAND = layersFromModel([[0, GRAYVER_2017[1][1]], ...GRAYVER_2017.slice(2)]);

/** Every column the kernel knows, by id → layers [{sigma, thicknessM}], last a half-space. */
export function groundColumn(id) {
    if (id === 'GRAYVER-GLOBAL') return layersFromModel(GRAYVER_2017);
    if (id === 'GRAYVER-LAND') return GRAYVER_LAND;
    const m = GROUND_MODELS.find((g) => g.id === id);
    if (!m) return null;
    return [...m.layers.map((l) => ({ sigma: l.sigma, thicknessM: l.thicknessM })),
            { sigma: m.halfspaceSigma, thicknessM: Infinity }];
}

/** Metadata for a column id (name, provenance, licence tier). */
export function groundColumnInfo(id) {
    if (id === 'GRAYVER-LAND' || id === 'GRAYVER-GLOBAL') {
        return {
            id, kind: 'global',
            name: id === 'GRAYVER-LAND' ? 'Global mantle average, land (Grayver et al. 2017)' : 'Global mantle average incl. 7 kS ocean (Grayver et al. 2017)',
            source: 'Grayver et al. 2017, GRL 44:6074 (via ChaosMagPy 0.16)', license: 'cite the paper', tier: 'A',
            note: 'A GLOBAL average: no local ground. Use only where no regional column applies.',
        };
    }
    const m = GROUND_MODELS.find((g) => g.id === id);
    return m ? { id, kind: m.kind, name: m.name, source: m.source, license: m.license, tier: m.tier } : null;
}

export const GROUND_COLUMN_IDS = Object.freeze(['GRAYVER-LAND', 'GRAYVER-GLOBAL', ...GROUND_MODELS.map((g) => g.id)]);

// ── The discrete kernel ─────────────────────────────────────────────────────
//
// TWO FFT VERSIONS OF THIS WERE BUILT FIRST AND BOTH MEASURED WRONG — read
// before "simplifying" back to an FFT:
//   1. Z sampled on the coarse grid → inverse FFT: a BAND-LIMITED kernel. Z
//      grows as √f up to Nyquist, so the kernel rings on both sides of lag 0
//      (18–34 % of its energy at negative lags) and its causal half gave a
//      half-space step response of the wrong sign, 9× the analytic size.
//   2. A 16× oversampled grid with B piecewise linear: causal, but the
//      aliased tail of G ∝ f^(−3/2) converges only as K^(−1/2), leaving a
//      CONSTANT offset in the step response (−0.2× analytic at 2 h for K = 16).
//
// What is used instead is exact for B PIECEWISE LINEAR between samples (what
// 1-minute data supports, and causal): E(t_n) = Σ_m (ΔB_m/dt)·[R(t_n−t_{m−1})
// − R(t_n−t_m)], with R the RAMP response (E for B rising at 1 nT/s), from the
// causal sine transform
//        R(t) = (2/π) ∫₀^∞ Im Z(ω) / (μ₀ ω²) · sin(ωt) dω ,
// which converges absolutely at both ends (Im Z ~ ω^½ at low and high ω). It
// is integrated by FILON quadrature — the integrand's smooth part linear on a
// dense log grid, the sine integrated exactly — so oscillation at large ωt
// costs nothing. A uniform half-space has R = (2/μ₀)·√(μ₀t/(πσ)) exactly; the
// gate holds the quadrature to that.

/** Log grid for the sine transform: ω from 1e−10 to 1e4 rad/s. Converged in the gate. */
export const RAMP_GRID_POINTS = 6000;
const W_MIN = 1e-10, W_MAX = 1e4;

const KERNELS = new Map();

/** R(t_j) for t_j = j·dt, j = 0..n, in V/km per (nT/s). */
export function rampResponse(layers, dtS, n, { points = RAMP_GRID_POINTS } = {}) {
    const scale = 1e-9 / MU0 * 1e3 * (2 / Math.PI);
    const w = new Float64Array(points), q = new Float64Array(points);
    for (let i = 0; i < points; i++) {
        w[i] = W_MIN * Math.pow(W_MAX / W_MIN, i / (points - 1));
        const z = layeredImpedance(layers, 2 * Math.PI / w[i]);
        q[i] = z.im / (w[i] * w[i]);
    }
    // Low tail [0, W_MIN]: Im Z ≈ c·ω^½ there (the deep half-space), so
    // ∫₀^{W_MIN} c ω^(−3/2) sin(ωt) dω ≈ c·t·2·W_MIN^½ for W_MIN·t ≪ 1.
    const cLow = q[0] * Math.pow(w[0], 1.5);
    // High tail [W_MAX, ∞): q ≈ c ω^(−3/2); |tail| ≤ c·W_MAX^(−3/2)/t, dropped (gated).
    const R = new Float64Array(n + 1);
    for (let j = 1; j <= n; j++) {
        const t = j * dtS;
        let sum = cLow * t * 2 * Math.sqrt(W_MIN);
        for (let i = 0; i < points - 1; i++) {
            const a = w[i], b = w[i + 1], beta = (q[i + 1] - q[i]) / (b - a), alpha = q[i] - beta * a;
            const F = (x) => -(alpha + beta * x) * Math.cos(x * t) / t + beta * Math.sin(x * t) / (t * t);
            sum += F(b) - F(a);
        }
        R[j] = sum * scale;
    }
    return R;
}

/**
 * The causal kernel w[j], V/km per nT: E_north[n] = Σ_j w[j]·ΔB_east[n−j],
 * ΔB_m = B_m − B_{m−1}. w[j] = (R((j+1)dt) − R(j·dt))/dt.
 * Returns { w, dtS, tailVkmPerNt }: the step response still standing at the
 * last kept lag, i.e. what truncating the memory there drops.
 */
export function impulseResponse(layers, dtS = 60, { keep = KERNEL_KEEP, points = RAMP_GRID_POINTS } = {}) {
    const key = `${dtS}|${keep}|${points}|${JSON.stringify(layers)}`;
    if (KERNELS.has(key)) return KERNELS.get(key);
    const R = rampResponse(layers, dtS, keep + 1, { points });
    const w = new Float64Array(keep);
    for (let j = 0; j < keep; j++) w[j] = (R[j + 1] - R[j]) / dtS;
    const out = { w, dtS, tailVkmPerNt: w[keep - 1] };
    KERNELS.set(key, out);
    return out;
}

/** E (V/km) at sample n after B rises 1 nT linearly over the sample before 0 — i.e. w itself. */
export function stepResponse(layers, dtS = 60, opts) {
    return impulseResponse(layers, dtS, opts).w;
}

// ── Series handling ─────────────────────────────────────────────────────────

/**
 * Split a series with nulls into contiguous segments, bridging short gaps.
 * Returns { segments: [{ start, end }] (end exclusive), values: Float64Array, bridged: Uint8Array }.
 */
export function segmentSeries(values, maxBridge = MAX_BRIDGE_SAMPLES) {
    const n = values.length, v = new Float64Array(n).fill(NaN), bridged = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (Number.isFinite(values[i])) v[i] = values[i];
    const segments = [];
    let start = -1, lastGood = -1;
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(v[i])) continue;
        if (start < 0) start = i;
        else if (i - lastGood - 1 > maxBridge) { segments.push({ start, end: lastGood + 1 }); start = i; }
        else if (i - lastGood > 1) {
            for (let j = lastGood + 1; j < i; j++) {
                v[j] = v[lastGood] + (v[i] - v[lastGood]) * (j - lastGood) / (i - lastGood);
                bridged[j] = 1;
            }
        }
        lastGood = i;
    }
    if (start >= 0) segments.push({ start, end: lastGood + 1 });
    return { segments, values: v, bridged };
}

/**
 * Direct causal convolution of w with the field's INCREMENTS inside one
 * segment. The field is held constant before the segment's first sample (no
 * history is invented), so the first increment is at start+1.
 */
function convolve(w, x, start, end) {
    const out = new Float64Array(end - start);
    for (let n = start; n < end; n++) {
        let s = 0;
        const jmax = Math.min(n - start - 1, w.length - 1);
        for (let j = 0; j <= jmax; j++) s += w[j] * (x[n - j] - x[n - j - 1]);
        out[n - start] = s;
    }
    return out;
}

/**
 * The surface geoelectric field for one site.
 * @param {object} p
 * @param {(number|null)[]} p.bNorthNt  geographic-north field (USGS X), nT
 * @param {(number|null)[]} p.bEastNt   geographic-east field (USGS Y), nT
 * @param {object[]|string} p.column    layers, or a ground-column id
 * @param {number} [p.dtS=60]
 * @returns {{ eNorthVkm, eEastVkm, eMagVkm: (number|null)[], warmup, bridged: Uint8Array,
 *            segments, kernel }}
 */
export function geoelectricSeries({ bNorthNt, bEastNt, column, dtS = 60, warmupSamples = WARMUP_SAMPLES, maxBridge = MAX_BRIDGE_SAMPLES }) {
    const layers = typeof column === 'string' ? groundColumn(column) : column;
    if (!layers) throw new Error(`geoelectric: unknown ground column ${column}`);
    if (bNorthNt.length !== bEastNt.length) throw new Error('geoelectric: component lengths differ');
    const n = bNorthNt.length;
    // A sample is usable only if BOTH components are present.
    const both = (i) => Number.isFinite(bNorthNt[i]) && Number.isFinite(bEastNt[i]);
    const sx = segmentSeries(bNorthNt.map((v, i) => (both(i) ? v : null)), maxBridge);
    const sy = segmentSeries(bEastNt.map((v, i) => (both(i) ? v : null)), maxBridge);
    const kernel = impulseResponse(layers, dtS);
    const eN = new Array(n).fill(null), eE = new Array(n).fill(null), eM = new Array(n).fill(null);
    const warmup = new Uint8Array(n);
    for (const { start, end } of sx.segments) {
        const exN = convolve(kernel.w, sy.values, start, end);       //  E_north =  w ∗ ΔB_east
        const exE = convolve(kernel.w, sx.values, start, end);       //  E_east  = −w ∗ ΔB_north
        for (let i = start; i < end; i++) {
            const a = exN[i - start], b = -exE[i - start];
            eN[i] = a; eE[i] = b; eM[i] = Math.hypot(a, b);
            if (i - start < warmupSamples) warmup[i] = 1;
        }
    }
    const bridged = new Uint8Array(n);
    for (let i = 0; i < n; i++) bridged[i] = sx.bridged[i] | sy.bridged[i];
    return { eNorthVkm: eN, eEastVkm: eE, eMagVkm: eM, warmup, bridged, segments: sx.segments, kernel };
}

// ── NERC TPL-007 planning context ───────────────────────────────────────────

/**
 * TPL-007-4 Attachment 1 Table 3: published β (benchmark, supplemental) per
 * USGS/NRCan 1-D model. Values via greglucas/bezpy `tpl007.py` (MIT), which
 * cites the standard. These are the standard's numbers, used as-is.
 */
export const TPL007_BETA = Object.freeze({
    AK1A: [0.56, 0.51], AK1B: [0.56, 0.51], AP1: [0.33, 0.30], AP2: [0.82, 0.78],
    BR1: [0.22, 0.22], CL1: [0.76, 0.73], CO1: [0.27, 0.25], CP1: [0.81, 0.77],
    CP2: [0.95, 0.86], FL1: [0.76, 0.73], CS1: [0.41, 0.37], IP1: [0.94, 0.90],
    IP2: [0.28, 0.25], IP3: [0.93, 0.90], IP4: [0.41, 0.35], NE1: [0.81, 0.77],
    PB1: [0.62, 0.55], PB2: [0.46, 0.39], PT1: [1.17, 1.19], SL1: [0.53, 0.49],
    SU1: [0.93, 0.90], BOU: [0.28, 0.24],
});
export const TPL007_BENCHMARK_VKM = 8;
export const TPL007_SUPPLEMENTAL_VKM = 12;

/** TPL-007-4 eq. 3: α = 0.001·e^{0.115·|L|}, clipped to [0.1, 1]; L = geomagnetic latitude (deg). */
export function tpl007Alpha(geomagLatDeg) {
    if (!Number.isFinite(geomagLatDeg)) return NaN;
    return Math.min(1, Math.max(0.1, 0.001 * Math.exp(0.115 * Math.abs(geomagLatDeg))));
}

/**
 * The TPL-007 planning field for a site, if the column has a published β:
 * E_benchmark = 8·α·β, E_supplemental = 12·α·β (V/km). null without a β —
 * a β is never invented for a column the standard does not tabulate.
 */
export function tpl007Planning(columnId, geomagLatDeg) {
    const beta = TPL007_BETA[columnId];
    if (!beta) return null;
    const alpha = tpl007Alpha(geomagLatDeg);
    return { alpha, betaBenchmark: beta[0], betaSupplemental: beta[1],
             benchmarkVkm: TPL007_BENCHMARK_VKM * alpha * beta[0],
             supplementalVkm: TPL007_SUPPLEMENTAL_VKM * alpha * beta[1] };
}
