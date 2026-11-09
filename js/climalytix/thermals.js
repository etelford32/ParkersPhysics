/**
 * climalytix/thermals.js — convective thermals (plan §19 T4), PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * A heated surface makes buoyant plumes that rise through the convective
 * boundary layer. Their strength scales with the Deardorff (1970) convective
 * velocity
 *
 *     w* = ( g/θ_v · H/(ρ·c_p) · z_i )^(1/3)            (m/s)
 *
 * from the surface sensible heat flux H (W/m², > 0 = ground heating the air),
 * the boundary-layer depth z_i and the air density ρ = p/(R_d·T_v). They stop
 * at the top of the boundary layer — or, if the rising air saturates first,
 * at the CLOUD BASE, which is the lifting condensation level of surface air.
 * The LCL here is EXACT: Romps (2017, J. Atmos. Sci. 74, 3891) solved it in
 * closed form through the Lambert W function,
 *
 *     T_LCL = c · [W₋₁(RH^(1/a) · c · e^c)]^(−1) · T,    z_LCL = c_pm (T − T_LCL) / g,
 *
 * with a, c built from his saturation-vapour-pressure curve; the gate checks
 * the identity that DEFINES it (a parcel lifted dry-adiabatically to z_LCL is
 * exactly saturated there), against Espy's 125 m/K rule of thumb, and with a
 * wrong exponent as the negative control.
 *
 *   thermal top = min(z_i, z_LCL)      cumulus-topped if z_LCL < z_i ("cu"),
 *                                      otherwise dry "blue" thermals
 *
 * Inputs are OUR GFS archive's: SHTFL (the 3 h MEAN over the step ending at
 * each stamp — idx.py §3), HPBL (the model's own boundary-layer height),
 * PRES (station pressure), 2 m T and dew point. So it is a 25 km field: the
 * ridge or sunny field that actually triggers a thermal is not resolved, and
 * w* is the scale of the updraughts, not a climb rate — a glider climbs at w*
 * minus its own sink. The strength words are the soaring-forecast convention
 * (RASP: under 1 m/s weak, 1–2 moderate, over 2 strong), not a promise.
 */

export const G = 9.80665;
export const RD = 287.04;          // dry air, J kg⁻¹ K⁻¹ (Romps' value)
export const CP = 1005.7;          // J kg⁻¹ K⁻¹ for ρ·c_p
/** Below this mean flux (W/m²) there are no thermals worth drawing: the surface is not driving convection. */
export const H_MIN_WM2 = 20;
/**
 * w* (m/s) at which the paint is full strength, and below which nothing is
 * painted. Full was first 2.5 with alpha to 0.8: a midday High Plains field
 * (w* 2–4 m/s is routine) painted one opaque red slab over the ground — so
 * 3.5, and the alpha stops at 0.65 so the basemap still reads through.
 */
export const WSTAR_FULL = 3.5;
export const WSTAR_FLOOR = 0.4;
export const STRENGTH = Object.freeze([
    { max: 1, label: 'weak' }, { max: 2, label: 'moderate' }, { max: Infinity, label: 'strong' },
]);

// ── Romps (2017) LCL ──────────────────────────────────────────────────────
// Constants exactly as in Romps' published code (lcl.py).
export const ROMPS = Object.freeze({
    Ttrip: 273.16, ptrip: 611.65, E0v: 2.3740e6, ggr: 9.81, rgasa: 287.04, rgasv: 461,
    cva: 719, cvv: 1418, cvl: 4119,
});
const R = ROMPS;
const CPA = R.cva + R.rgasa, CPV = R.cvv + R.rgasv;

/** Saturation vapour pressure over liquid (Pa), Romps' curve. */
export function pvStarLiquid(T) {
    return R.ptrip * Math.pow(T / R.Ttrip, (CPV - R.cvl) / R.rgasv)
        * Math.exp((R.E0v - (R.cvv - R.cvl) * R.Ttrip) / R.rgasv * (1 / R.Ttrip - 1 / T));
}

/** Lambert W, lower branch W₋₁(x) for x ∈ [−1/e, 0): Halley iteration from an asymptotic start. */
export function lambertWm1(x) {
    if (!(x >= -1 / Math.E) || !(x < 0)) return NaN;
    if (x === -1 / Math.E) return -1;
    let w = x < -0.25
        ? -1 - Math.sqrt(2 * (1 + Math.E * x))                           // near the branch point
        : Math.log(-x) - Math.log(-Math.log(-x));                        // near 0⁻
    for (let k = 0; k < 40; k++) {
        const ew = Math.exp(w), f = w * ew - x;
        const d = ew * (w + 1) - (w + 2) * f / (2 * w + 2);
        const step = f / d;
        w -= step;
        if (Math.abs(step) < 1e-15 * Math.abs(w)) break;
    }
    return w;
}

/**
 * Exact LCL of surface air (Romps 2017) from pressure p (Pa), temperature T
 * (K) and dew point Td (K). Returns { zM, TK, rh, qv } — z above the surface.
 * `a` may be overridden (the gate's negative control).
 */
export function lclRomps(p, T, Td, { aOverride = null } = {}) {
    if (!(p > 0) || !(T > 0) || !(Td > 0)) return null;
    const rh = Math.min(1, pvStarLiquid(Td) / pvStarLiquid(T));
    const pv = rh * pvStarLiquid(T);
    const qv = R.rgasa * pv / (R.rgasv * p + (R.rgasa - R.rgasv) * pv);
    const rgasm = (1 - qv) * R.rgasa + qv * R.rgasv;
    const cpm = (1 - qv) * CPA + qv * CPV;
    const a = aOverride ?? (cpm / rgasm + (R.cvl - CPV) / R.rgasv);
    const b = -(R.E0v - (R.cvv - R.cvl) * R.Ttrip) / (R.rgasv * T);
    const c = b / a;
    const TK = rh >= 1 ? T : c * Math.pow(lambertWm1(Math.pow(rh, 1 / a) * c * Math.exp(c)), -1) * T;
    return { zM: cpm * (T - TK) / R.ggr, TK, rh, qv, cpm, rgasm };
}

// ── Deardorff w* ──────────────────────────────────────────────────────────

/** Air density (kg/m³) from pressure (Pa), T (K) and specific humidity. */
export function airDensity(p, T, qv = 0) {
    return p / (RD * T * (1 + 0.608 * qv));
}

/** Deardorff convective velocity (m/s); 0 when the surface is not heating the air. */
export function deardorff({ fluxWm2, ziM, rho, thetaVK }) {
    if (!(fluxWm2 > 0) || !(ziM > 0)) return 0;
    return Math.cbrt(G / thetaVK * (fluxWm2 / (rho * CP)) * ziM);
}

export function strengthLabel(w) {
    return STRENGTH.find((s) => w < s.max).label;
}

/**
 * Thermals at one point from the GFS inputs. Returns
 *   { regime: 'none' | 'cu' | 'blue', wstar, topM (AGL), baseM (cloud base
 *     AGL or null), lclM, ziM, strength }
 * 'none' below H_MIN_WM2 (the surface is not driving convection).
 */
export function thermalAt({ fluxWm2, ziM, psfcHpa, tempC, dewC }) {
    const vals = [fluxWm2, ziM, psfcHpa, tempC, dewC];
    if (!vals.every(Number.isFinite)) return null;
    const T = tempC + 273.15, p = psfcHpa * 100;
    const lcl = lclRomps(p, T, Math.min(dewC, tempC) + 273.15);
    if (!lcl) return null;
    const lclM = lcl.zM;
    if (!(fluxWm2 > H_MIN_WM2) || !(ziM > 0)) {
        return { regime: 'none', wstar: 0, topM: null, baseM: null, lclM, ziM, strength: null };
    }
    const rho = airDensity(p, T, lcl.qv);
    const wstar = deardorff({ fluxWm2, ziM, rho, thetaVK: T * (1 + 0.608 * lcl.qv) });
    const cu = lclM < ziM;
    return {
        regime: cu ? 'cu' : 'blue', wstar, topM: Math.min(ziM, lclM), baseM: cu ? lclM : null,
        lclM, ziM, strength: strengthLabel(wstar),
    };
}

/** Heat-image painter for w*: transparent below the floor, pale gold → orange → red. */
const STOPS = [[1.0, 0.92, 0.55], [1.0, 0.62, 0.22], [0.86, 0.22, 0.16]];
export function thermalPaint(w, data, o) {
    if (!Number.isFinite(w) || w <= WSTAR_FLOOR) return;
    const f = Math.min(1, (w - WSTAR_FLOOR) / (WSTAR_FULL - WSTAR_FLOOR));
    const x = f * (STOPS.length - 1), i = Math.min(STOPS.length - 2, Math.floor(x)), t = x - i;
    for (let c = 0; c < 3; c++) data[o + c] = Math.round(255 * (STOPS[i][c] + (STOPS[i + 1][c] - STOPS[i][c]) * t));
    data[o + 3] = Math.round(255 * (0.2 + 0.45 * Math.sqrt(f)));
}

/**
 * The instant `ms` inside a run with 3-hourly stamps `times`: the flux is the
 * MEAN over (times[i−1], times[i]] so the window containing `ms` is i; the
 * instantaneous fields are interpolated linearly between i−1 and i.
 * Returns { i, f } (f = weight of i) or null outside the run.
 */
export function windowAt(times, ms) {
    if (!times?.length || !Number.isFinite(ms)) return null;
    if (ms <= times[0] || ms > times[times.length - 1]) return null;
    let i = 1;
    while (times[i] < ms) i++;
    return { i, f: (ms - times[i - 1]) / (times[i] - times[i - 1]) };
}
