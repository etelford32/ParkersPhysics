/**
 * conductivity.js — electrical conductivity of the Earth and the plane-wave
 * impedance it gives, as a pure, testable kernel.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no ambient time. Gate: `tests/earth-interior-prem.mjs`
 * (section C). Plan: `INNER_EARTH_PLAN.md` §8 P1.
 *
 * ── WHAT THIS IS, HONESTLY ───────────────────────────────────────────────
 * GRAYVER_2017 is the global 1-D conductivity profile of Grayver et al.
 * (2017, GRL 44:6074), inverted from satellite + observatory magnetic data.
 * It is a GLOBAL AVERAGE: the top layer is the 7 kS mean ocean conductance
 * spread over 1 km, and the shallow crust is a resistive average. At a real
 * site the top tens of km vary by orders of magnitude (wet sediments vs
 * cratonic shield), and that variation is exactly what makes geoelectric
 * hazard local. So `column.js` (P1) will replace the top layers per site.
 * This profile is the MANTLE below them.
 *
 * `layeredImpedance` is the standard 1-D magnetotelluric recursion for a
 * stack of uniform layers over a half-space under a vertically incident plane
 * wave (Wait 1953; the NERC TPL-007 benchmark method). It is exact for that
 * idealisation. It is NOT a 3-D model: coast effects, lateral contrasts and a
 * non-planar source (the auroral electrojet) are absent, and every consumer
 * must say so.
 *
 * Convention: e^{+iωt}. Z = E/H in ohms (H = B/μ₀). The surface electric
 * field for a horizontal field B is E = Z·B/μ₀ in V/m.
 */

export const MU0 = 4e-7 * Math.PI;

/**
 * Grayver et al. 2017: [depth to the TOP of the layer, km; σ, S/m].
 * GENERATED from ChaosMagPy 0.16 `lib/Earth_conductivity.dat` (never typed by
 * hand — five hand-typed rows were wrong once); the gate checks every row
 * against the byte-pinned fixture of that file.
 */
export const GRAYVER_2017 = Object.freeze([
    [0, 7], [1, 0.0002258505181], [10, 0.0002300043494], [22, 0.0002467308811],
    [37, 0.0002971504977], [52, 0.0004164700344], [65, 0.0006525989493],
    [80, 0.001142292034], [95, 0.002142944398], [112, 0.00416244864],
    [132, 0.008305126583], [155, 0.01604748379], [180, 0.02832674342],
    [210, 0.04343537883], [245, 0.05713617533], [280, 0.06781208082],
    [320, 0.07669171609], [360, 0.08645067971], [400, 0.09896647522],
    [440, 0.1198745701], [490, 0.1635300279], [550, 0.2716671224],
    [600, 0.5297014807], [660, 1.026451136], [730, 1.35285022],
    [800, 1.429460733], [880, 1.441169054], [980, 1.446636682],
    [1080, 1.461772762], [1190, 1.481617611], [1300, 1.540456721],
    [1400, 1.60095963], [1500, 2.107276831], [1600, 2.561250576],
    [1700, 2.978558186], [1800, 3.301925981], [1900, 3.506691788],
    [2000, 3.644103242], [2100, 3.682761591], [2200, 3.703778436],
    [2300, 3.707901746], [2400, 3.697769525], [2500, 3.693743273],
    [2600, 3.688096839], [2700, 3.682981594], [2800, 3.674064006],
    [2900, 100000],
].map((row) => Object.freeze(row)));

/** σ (S/m) at depth (km): piecewise constant from the layer tops. */
export function sigmaAt(depthKm, model = GRAYVER_2017) {
    if (!(depthKm >= 0)) return NaN;
    let s = model[0][1];
    for (const [top, sig] of model) { if (depthKm >= top) s = sig; else break; }
    return s;
}

/** Conductance ∫σ dz (S) between two depths (km). */
export function conductanceS(topKm, bottomKm, model = GRAYVER_2017) {
    let sum = 0;
    for (let i = 0; i < model.length; i++) {
        const a = model[i][0], b = i + 1 < model.length ? model[i + 1][0] : Infinity;
        const lo = Math.max(a, topKm), hi = Math.min(b, bottomKm);
        if (hi > lo) sum += model[i][1] * (hi - lo) * 1e3;
    }
    return sum;
}

/** Skin depth δ = √(2 / ωμ₀σ), metres. */
export const skinDepthM = (sigma, periodS) => Math.sqrt(2 / ((2 * Math.PI / periodS) * MU0 * sigma));

/**
 * Turn the depth table into layers for the recursion: [{ sigma, thicknessM }],
 * the last layer a half-space (thicknessM = Infinity).
 */
export function layersFromModel(model = GRAYVER_2017) {
    return model.map(([top, sigma], i) => ({
        sigma,
        thicknessM: i + 1 < model.length ? (model[i + 1][0] - top) * 1e3 : Infinity,
    }));
}

// ── Minimal complex arithmetic (pure, allocation-light) ─────────────────────
const C = (re, im = 0) => ({ re, im });
const add = (a, b) => C(a.re + b.re, a.im + b.im);
const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
const csqrt = (a) => {
    const m = Math.hypot(a.re, a.im);
    const re = Math.sqrt((m + a.re) / 2), im = Math.sign(a.im || 1) * Math.sqrt((m - a.re) / 2);
    return C(re, im);
};
const cexp = (a) => { const e = Math.exp(a.re); return C(e * Math.cos(a.im), e * Math.sin(a.im)); };
/** tanh for Re z ≥ 0, written so a thick layer (Re z → ∞) gives 1, not NaN. */
const ctanh = (z) => { const e = cexp(C(-2 * z.re, -2 * z.im)); return div(C(1 - e.re, -e.im), C(1 + e.re, e.im)); };

/**
 * Surface impedance Z(ω) of a layered Earth (ohms, complex).
 * layers: [{ sigma S/m, thicknessM }], the last one a half-space.
 */
export function layeredImpedance(layers, periodS) {
    const iwmu = C(0, (2 * Math.PI / periodS) * MU0);
    const n = layers.length;
    const kOf = (s) => csqrt(C(0, iwmu.im * s));          // k = √(iωμ₀σ)
    const etaOf = (k) => div(iwmu, k);                     // intrinsic impedance
    let Z = etaOf(kOf(layers[n - 1].sigma));
    for (let j = n - 2; j >= 0; j--) {
        const k = kOf(layers[j].sigma), eta = etaOf(k);
        const t = ctanh(mul(k, C(layers[j].thicknessM, 0)));
        Z = mul(eta, div(add(Z, mul(eta, t)), add(eta, mul(Z, t))));
    }
    return Z;
}

/** |Z|, phase (deg) and apparent resistivity ρa = |Z|²/(ωμ₀) (Ω·m). */
export function impedanceSummary(layers, periodS) {
    const Z = layeredImpedance(layers, periodS);
    const mag = Math.hypot(Z.re, Z.im);
    return { re: Z.re, im: Z.im, magOhm: mag, phaseDeg: Math.atan2(Z.im, Z.re) * 180 / Math.PI,
             apparentResistivityOhmM: mag * mag / ((2 * Math.PI / periodS) * MU0) };
}

/** Surface E amplitude (V/km) for a horizontal B amplitude (nT) at one period. */
export function geoelectricVPerKm(layers, periodS, bNT) {
    const { magOhm } = impedanceSummary(layers, periodS);
    return magOhm * (bNT * 1e-9 / MU0) * 1e3;
}
