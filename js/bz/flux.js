/**
 * js/bz/flux.js — from an upstream field to a magnetic-flux transport rate (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B2 (§2 definitions, §4.5). No DOM, no fetch, no
 * ambient time. Gate: tests/bz-flux.mjs.
 *
 * Bz is a proxy. The quantity the magnetosphere responds to is how much
 * magnetic flux the solar wind OPENS at the dayside magnetopause per second —
 * a voltage. This module turns (v, By, Bz) into that voltage three ways and
 * never averages them: where they disagree, the disagreement IS the
 * uncertainty of the coupling physics.
 *
 * ── PROVENANCE OF EVERY COEFFICIENT ──────────────────────────────────────
 *   MILAN 2012 (Milan, Gosling & Hubert, JGR 117, A03226) — CHECKED 2026-11-20
 *     against a paper that restates it (arXiv:1701.02961):
 *       Φ_D = L_eff(V_X) · V_X · B_YZ · sin^(9/2)(θ/2),
 *       L_eff = 3.8 R_E · (V_X / 4×10⁵ m/s)^(1/3).
 *     A true rate in volts. THE HEADLINE ESTIMATOR.
 *   NEWELL 2007 (Newell et al., JGR 112, A01206) — functional form CHECKED:
 *       dΦ_MP/dt ∝ v^(4/3) · B_T^(2/3) · sin^(8/3)(θ/2).
 *     Newell's function has NO agreed conversion to volts, and this module
 *     does not invent one. It is reported (a) in its native units and (b)
 *     NORMALISED to Milan at one stated reference wind, so that what differs
 *     between the two columns is the functional form alone. (b) is not an
 *     independent estimate of magnitude and is labelled as such.
 *   SISCOE–HILL saturation (Siscoe et al. 2002, JGR 107, 1075) — the FORM
 *     (a harmonic combination of an unsaturated and a saturation potential)
 *     is checked; the NUMERICAL COEFFICIENTS below were transcribed from
 *     memory and could NOT be confirmed against the paper from the build
 *     sandbox. `SISCOE_HILL.verified` is false and every result built on it
 *     says so. Do not print these numbers on a page until someone has the
 *     paper open.
 *
 * THE CLOCK ANGLE is θ = atan2(By, Bz) in GSM: 0 = due north (no dayside
 * opening), π = due south.
 */
import { RE_KM } from './frames.js';

export const MILAN = Object.freeze({ L0_RE: 3.8, V0_MS: 4e5, clockExp: 4.5 });
export const NEWELL = Object.freeze({ vExp: 4 / 3, bExp: 2 / 3, clockExp: 8 / 3 });
/** The wind at which the Newell column is normalised to Milan. A stated choice. */
export const REFERENCE_WIND = Object.freeze({ speedKms: 400, byNt: 0, bzNt: -5 });
/** UNVERIFIED coefficients — see the header. */
export const SISCOE_HILL = Object.freeze({
    verified: false,
    k: 57.6,          // kV per (mV/m · nPa^(-1/6))
    sat: 0.0125,
    xiA: 4.45, xiB: 1.08,   // ξ = xiA − xiB·log10(Σ_P)
    defaultSigmaP: 10,      // S — a round daytime-ish Pedersen conductance, disclosed
});

/** IMF clock angle, radians in [0, π] for the purposes of sin(θ/2); null if no transverse field. */
export function clockAngle(byNt, bzNt) {
    if (!(byNt === byNt && bzNt === bzNt)) return null;
    if (byNt === 0 && bzNt === 0) return null;
    return Math.atan2(byNt, bzNt);
}

/**
 * Dayside reconnection rate, Milan et al. 2012. Volts → returned in kV.
 * @param {number} speedKms  |V_X|, km/s
 * @returns {number|null} kV; null on any missing input (never 0)
 */
export function milanRateKv(speedKms, byNt, bzNt) {
    const th = clockAngle(byNt, bzNt);
    if (!(speedKms > 0)) return null;
    if (th == null) return byNt === 0 && bzNt === 0 ? 0 : null;
    const v = speedKms * 1e3;
    const leff = MILAN.L0_RE * RE_KM * 1e3 * Math.cbrt(v / MILAN.V0_MS);
    const byz = Math.hypot(byNt, bzNt) * 1e-9;
    return leff * v * byz * Math.pow(Math.abs(Math.sin(th / 2)), MILAN.clockExp) / 1e3;
}

/** Newell et al. 2007 coupling function in its NATIVE units (km/s, nT). */
export function newellNative(speedKms, byNt, bzNt) {
    const th = clockAngle(byNt, bzNt);
    if (!(speedKms > 0)) return null;
    if (th == null) return byNt === 0 && bzNt === 0 ? 0 : null;
    return Math.pow(speedKms, NEWELL.vExp) * Math.pow(Math.hypot(byNt, bzNt), NEWELL.bExp)
        * Math.pow(Math.abs(Math.sin(th / 2)), NEWELL.clockExp);
}

const NEWELL_SCALE = milanRateKv(REFERENCE_WIND.speedKms, REFERENCE_WIND.byNt, REFERENCE_WIND.bzNt)
    / newellNative(REFERENCE_WIND.speedKms, REFERENCE_WIND.byNt, REFERENCE_WIND.bzNt);

/**
 * Newell's function scaled so it EQUALS Milan at REFERENCE_WIND. Not an
 * independent magnitude: read the ratio to Milan, not the number.
 */
export function newellMilanEquivalentKv(speedKms, byNt, bzNt) {
    const n = newellNative(speedKms, byNt, bzNt);
    return n == null ? null : n * NEWELL_SCALE;
}

/**
 * Transpolar potential with saturation, Siscoe–Hill form. UNVERIFIED
 * coefficients (SISCOE_HILL.verified === false).
 * @returns {{ unsaturatedKv, saturationKv, potentialKv, saturatedFraction, sigmaP, coefficients_verified:false } | null}
 */
export function siscoeHillKv(speedKms, byNt, bzNt, pdynNPa, sigmaP = SISCOE_HILL.defaultSigmaP) {
    const th = clockAngle(byNt, bzNt);
    if (!(speedKms > 0) || !(pdynNPa > 0) || th == null) return null;
    const eSw = speedKms * Math.hypot(byNt, bzNt) * 1e-3;            // mV/m
    const F = Math.sin(th / 2) ** 2;
    const xi = SISCOE_HILL.xiA - SISCOE_HILL.xiB * Math.log10(sigmaP);
    const unsat = SISCOE_HILL.k * eSw * F * Math.pow(pdynNPa, -1 / 6);
    const sat = SISCOE_HILL.k * Math.cbrt(pdynNPa) / (SISCOE_HILL.sat * xi * sigmaP);
    const pot = unsat > 0 ? (unsat * sat) / (unsat + sat) : 0;
    return { unsaturatedKv: unsat, saturationKv: sat, potentialKv: pot,
        saturatedFraction: unsat > 0 ? 1 - pot / unsat : 0, sigmaP, coefficients_verified: SISCOE_HILL.verified };
}

/**
 * First-order 1σ of the Milan rate from the 1σ of Bz (By and v held): half
 * the spread between Bz ± σ. Returns null when σ is unknown — an unknown
 * uncertainty is not a zero one.
 */
export function milanSigmaKv(speedKms, byNt, bzNt, sigmaBzNt) {
    if (!(sigmaBzNt === sigmaBzNt) || sigmaBzNt == null) return null;
    const a = milanRateKv(speedKms, byNt, bzNt - sigmaBzNt), b = milanRateKv(speedKms, byNt, bzNt + sigmaBzNt);
    return a == null || b == null ? null : Math.abs(a - b) / 2;
}

/**
 * Magnetic flux opened over a series, GWb: ∫ Φ_D dt (1 kV·s = 1 kWb), by the
 * trapezoid rule over consecutive samples no more than maxGapS apart. A
 * longer gap contributes NOTHING and is counted — flux is not assumed to
 * have kept opening while nobody was looking.
 */
export function openedFluxGWb(tMs, rateKv, maxGapS = 180) {
    let wb = 0, coveredS = 0, gaps = 0, prev = -1;
    for (let i = 0; i < tMs.length; i++) {
        if (!(rateKv[i] === rateKv[i]) || rateKv[i] == null) continue;
        if (prev >= 0) {
            const dt = (tMs[i] - tMs[prev]) / 1000;
            if (dt > 0 && dt <= maxGapS) { wb += 0.5 * (rateKv[i] + rateKv[prev]) * 1e3 * dt; coveredS += dt; }
            else if (dt > maxGapS) gaps++;
        }
        prev = i;
    }
    return { gwb: wb / 1e9, covered_s: coveredS, gaps };
}
