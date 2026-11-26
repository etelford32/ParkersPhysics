/**
 * seawater.js — the ONE copy of the sea-floor page's equation of state (PURE, no imports).
 *
 * A TRANSCRIPTION of Fofonoff & Millard (1983), "Algorithms for computation of fundamental
 * properties of seawater", UNESCO Tech. Pap. Mar. Sci. 44 (EOS-80):
 *   soundSpeed          Chen & Millero (1977), eq. 33–37
 *   adiabaticGradient   Bryden (1973)
 *   potentialTemperature  Fofonoff's 4th-order Runge–Kutta on the adiabatic gradient
 *   depthFromPressure   eq. 25 (Saunders & Fofonoff), standard ocean (S 35, 0 °C)
 * Gated by tests/seafloor-kernels.mjs against tests/fixtures/seafloor/seawater-oracle.json, which
 * python-seawater GENERATED (the same algorithms, written by someone else) — and, more loosely,
 * against TEOS-10 (gsw), a different equation of state: for cold deep water the two sound speeds
 * differ by up to 2.1 m/s at 11 200 dbar (MEASURED in the gate; the known Chen–Millero high-pressure
 * bias) — about 0.13 %, i.e. ~15 m of echo depth at 11 km. `SOUND_SPEED_UNCERTAINTY` carries that
 * and every sounding the page prints quotes it; depth-from-pressure differs by ≤ 1.6 m.
 *
 * Units everywhere: S practical salinity (PSS-78), T in-situ °C (ITS-90), p sea pressure in dbar
 * (0 at the surface), depth m positive DOWN, latitude degrees.
 *
 * Valid for S 0–40, T 0–40 °C, p 0–10 000 dbar (the polynomials' fitted range). The deepest
 * trench floors are at ~11 200 dbar and temperatures down to −1.9 °C occur in polar water: both
 * are a small extrapolation, disclosed on the page (`inFittedRange`).
 */

/** ITS-90 → IPTS-68, the scale the 1983 polynomials were fitted on. */
export const t68 = (t90) => t90 * 1.00024;
const t90 = (t68v) => t68v / 1.00024;

/** Sound speed, m/s. */
export function soundSpeed(S, T, p) {
    const P = p / 10;                         // the UNESCO routines work in bar
    const t = t68(T);
    const Cw = ((((-2.3643e-12 * t + 3.8504e-10) * t - 9.7729e-9) * P
        + ((((1.0405e-12 * t - 2.5335e-10) * t + 2.5974e-8) * t - 1.7107e-6) * t + 3.1260e-5)) * P
        + ((((-6.1185e-10 * t + 1.3621e-7) * t - 8.1788e-6) * t + 6.8982e-4) * t + 0.153563)) * P
        + ((((3.1464e-9 * t - 1.47800e-6) * t + 3.3420e-4) * t - 5.80852e-2) * t + 5.03711) * t
        + 1402.388;
    const A = ((((-3.389e-13 * t + 6.649e-12) * t + 1.100e-10) * P
        + (((7.988e-12 * t - 1.6002e-10) * t + 9.1041e-9) * t - 3.9064e-7)) * P
        + ((((-2.0122e-10 * t + 1.0507e-8) * t - 6.4885e-8) * t - 1.2580e-5) * t + 9.4742e-5)) * P
        + (((-3.21e-8 * t + 2.006e-6) * t + 7.164e-5) * t - 1.262e-2) * t
        + 1.389;
    const B = -1.922e-2 - 4.42e-5 * t + (7.3637e-5 + 1.7945e-7 * t) * P;
    const D = 1.727e-3 - 7.9836e-6 * P;
    return Cw + A * S + B * S * Math.sqrt(S) + D * S * S;
}

/** Adiabatic temperature gradient, °C per dbar (positive: a parcel pushed down warms). */
export function adiabaticGradient(S, T, p) {
    const t = t68(T), ds = S - 35;
    return 3.5803e-5 + (8.5258e-6 + (-6.836e-8 + 6.6228e-10 * t) * t) * t
        + (1.8932e-6 - 4.2393e-8 * t) * ds
        + ((1.8741e-8 + (-6.7795e-10 + (8.733e-12 - 5.4481e-14 * t) * t) * t) + (-1.1351e-10 + 2.7759e-12 * t) * ds) * p
        + (-4.6206e-13 + (1.8676e-14 - 2.1687e-16 * t) * t) * p * p;
}

/**
 * The temperature a parcel (S, T, p) has after moving ADIABATICALLY to pressure pr.
 * pr = 0 gives the classical potential temperature θ; pr > p gives the in-situ temperature the
 * same water would show deeper — the trench-floor continuation the page labels MODEL.
 */
export function potentialTemperature(S, T, p, pr = 0) {
    const dP = pr - p, r2 = Math.SQRT1_2;
    let dth = dP * adiabaticGradient(S, T, p);
    let th = t68(T) + 0.5 * dth;
    let q = dth;
    dth = dP * adiabaticGradient(S, t90(th), p + 0.5 * dP);
    th += (1 - r2) * (dth - q);
    q = (2 - Math.SQRT2) * dth + (-2 + 3 * r2) * q;
    dth = dP * adiabaticGradient(S, t90(th), p + 0.5 * dP);
    th += (1 + r2) * (dth - q);
    q = (2 + Math.SQRT2) * dth + (-2 - 3 * r2) * q;
    dth = dP * adiabaticGradient(S, t90(th), p + dP);
    return t90(th + (dth - 2 * q) / 6);
}

/** Depth (m, positive down) of pressure p (dbar) at a latitude, standard ocean. */
export function depthFromPressure(p, latDeg) {
    const x = Math.sin(Math.abs(latDeg) * Math.PI / 180) ** 2;
    const g = 9.780318 * (1 + (5.2788e-3 + 2.36e-5 * x) * x) + 1.092e-6 * p;
    return ((((-1.82e-15 * p + 2.279e-10) * p - 2.2512e-5) * p + 9.72659) * p) / g;
}

/**
 * Pressure (dbar) at a depth — the EXACT inverse of depthFromPressure by Newton iteration, so a
 * depth → pressure → depth round trip is closed to 1e-6 m (gated). Saunders' (1981) closed form is
 * NOT used: it is 2–3 dbar off the UNESCO relation at trench depth.
 */
export function pressureFromDepth(depthM, latDeg) {
    if (!(depthM > 0)) return 0;
    let p = depthM * 1.0125;
    for (let i = 0; i < 8; i++) {
        const f = depthFromPressure(p, latDeg) - depthM;
        const d = (depthFromPressure(p + 0.5, latDeg) - depthFromPressure(p - 0.5, latDeg));
        const step = f / d;
        p -= step;
        if (Math.abs(step) < 1e-9) break;
    }
    return p;
}

/** True where the 1983 polynomials were actually fitted. */
export const inFittedRange = (S, T, p) => S >= 0 && S <= 40 && T >= 0 && T <= 40 && p >= 0 && p <= 10000;

/** Fractional 1σ-ish uncertainty of soundSpeed at hadal pressure: the measured EOS-80 − TEOS-10 spread. */
export const SOUND_SPEED_UNCERTAINTY = 0.0013;

export const UNITS = Object.freeze({ dbarPerAtm: 10.1325, dbarPerMPa: 100, psiPerDbar: 1.4503774 });
