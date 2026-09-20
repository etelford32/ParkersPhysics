/**
 * star-collider/inspiral.js — post-Newtonian inspiral + gravitational waves (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * The analytic half of the collider. Two point masses (plus their tidal
 * deformabilities and aligned spins) spiral together under gravitational
 * radiation reaction; this module integrates that and returns the orbital
 * frequency track, the time to merger, the GW cycle count and the strain a
 * detector at distance D would see.
 *
 * THE EQUATION. TaylorT4 — the ratio of the 3.5PN energy flux to the 3PN
 * binding-energy derivative, re-expanded and truncated (Buonanno, Iyer,
 * Ochsner, Pan & Sathyaprakash 2009, PRD 80, 084043, eq. 3.6):
 *
 *   dx/dt = (64 η / 5 M) x⁵ [ 1 + a₂x + a₃x^{3/2} + a₄x² + a₅x^{5/2}
 *                              + a₆x³ + a₇x^{7/2} + (39/8) Λ̃ x⁵ ]
 *   dφ/dt = x^{3/2} / M
 *
 * with x = (M ω)^{2/3} the PN parameter (ω orbital, f_GW = ω/π), η = μ/M
 * the symmetric mass ratio. The 1.5PN coefficient carries the leading
 * spin–orbit term for ALIGNED spins (Kidder 1995): aligned spins delay the
 * merger (the orbital hang-up). Spin–spin (2PN) and precession are NOT
 * modelled; the page says "aligned, leading order".
 *
 * THE TIDAL TERM was re-derived here rather than copied (see the derivation
 * in tests/star-collider-inspiral.mjs's header): the Newtonian tidal
 * potential with the deformation energy included is V = −(3/2) λ₁ m₂²/r⁶,
 * which gives E(x) = −½Mηx[1 − 9(m₂/m₁)λ̂₁x⁵] and
 * F(x) = (32/5)η²x⁵[1 + 6(m₁+3m₂)/m₁ λ̂₁x⁵] (Flanagan & Hinderer 2008),
 * and their ratio has the coefficient 6(m₁ + 12m₂)/m₁ · λ̂₁, whose sum over
 * both bodies is (39/8)Λ̃ with the standard
 *   Λ̃ = (16/13) [ (m₁ + 12 m₂) m₁⁴ Λ₁ + (m₂ + 12 m₁) m₂⁴ Λ₂ ] / M⁵.
 * That (m₁ + 12m₂) is the same weight the GW170817 papers use, which is
 * the check on the derivation. Only the leading (5PN) tidal order is kept.
 *
 * WHERE IT STOPS. The series is asymptotic and the point-particle picture
 * ends before the bodies touch, so the track terminates at the FIRST of:
 * the Schwarzschild ISCO x = 1/6 (f_ISCO = 4397 Hz · M☉/M), contact
 * (1PN harmonic separation (M/x)[1 − (1 − η/3)x] ≤ R₁ + R₂), or dx/dt
 * turning negative (the series breaking). Which one ended it is reported (`endReason`), because
 * a BNS ending at contact and a BBH ending at ISCO are different claims.
 *
 * ECCENTRIC WIDE BINARIES. The real pulsar binaries in the catalog are
 * hours-period, eccentric, and 10⁸ years from merger — no PN integration
 * is going to march through that. Peters (1964) gives the merger time of
 * an eccentric orbit in closed form as a quadrature over e; that is
 * `mergerTimePeters`, and it is pinned against the Hulse–Taylor pulsar's
 * published 300 Myr.
 *
 * Units: geometric (G = c = 1, M☉) inside; the public API takes M☉, km,
 * Hz, Mpc and returns seconds/Hz/strain.
 */

import { GEOM_KM, GEOM_S } from './eos.js';

const EULER_GAMMA = 0.5772156649015329;
const MPC_KM = 3.0856775814913673e19;
/** Geometric length units per megaparsec. */
export const MPC_GEOM = MPC_KM / GEOM_KM;

/** Chirp mass (M☉). */
export function chirpMass(m1, m2) { return (m1 * m2) ** 0.6 / (m1 + m2) ** 0.2; }
/** Symmetric mass ratio η = m₁m₂/M². */
export function symmetricMassRatio(m1, m2) { return m1 * m2 / (m1 + m2) ** 2; }
/** Mass-weighted tidal deformability Λ̃ (Favata 2014 / Wade+ 2014). */
export function combinedTidal(m1, m2, l1, l2) {
    const M = m1 + m2;
    return (16 / 13) * ((m1 + 12 * m2) * m1 ** 4 * l1 + (m2 + 12 * m1) * m2 ** 4 * l2) / M ** 5;
}
/** Effective aligned spin χ_eff. */
export function effectiveSpin(m1, m2, chi1, chi2) { return (m1 * chi1 + m2 * chi2) / (m1 + m2); }

/** GW frequency (Hz) at PN parameter x for total mass M (M☉). */
export function gwFrequencyHz(x, M) { return x ** 1.5 / (Math.PI * M * GEOM_S); }
/** PN parameter x at GW frequency f (Hz). */
export function xAtGwFrequency(fHz, M) { return (Math.PI * M * GEOM_S * fHz) ** (2 / 3); }
/** Schwarzschild ISCO GW frequency, Hz. */
export function iscoFrequencyHz(M) { return gwFrequencyHz(1 / 6, M); }
/** Newtonian GW frequency at a separation (km) for total mass M. */
export function gwFrequencyAtSeparationHz(aKm, M) {
    const a = aKm / GEOM_KM;
    return Math.sqrt(M / a ** 3) / Math.PI / GEOM_S;
}

/** The TaylorT4 bracket, x-dependent part only. */
export function taylorT4Bracket(x, eta, deltaSpin, lambdaTilde) {
    const a2 = -(743 / 336 + 11 * eta / 4);
    const a3 = 4 * Math.PI + deltaSpin;
    const a4 = 34103 / 18144 + 13661 * eta / 2016 + 59 * eta * eta / 18;
    const a5 = -(4159 / 672 + 189 * eta / 8) * Math.PI;
    const a6 = 16447322263 / 139708800 - 1712 * EULER_GAMMA / 105 + 16 * Math.PI ** 2 / 3
        - (856 / 105) * Math.log(16 * x)
        + (-56198689 / 217728 + 451 * Math.PI ** 2 / 48) * eta
        + 541 * eta * eta / 896 - 5605 * eta ** 3 / 2592;
    const a7 = (-4415 / 4032 + 358675 * eta / 6048 + 91495 * eta * eta / 1512) * Math.PI;
    const sx = Math.sqrt(x);
    return 1 + a2 * x + a3 * x * sx + a4 * x * x + a5 * x * x * sx + a6 * x ** 3 + a7 * x ** 3 * sx
        + (39 / 8) * lambdaTilde * x ** 5;
}

/** Leading spin–orbit correction to the 1.5PN coefficient (aligned spins). */
export function spinOrbitDelta(m1, m2, chi1, chi2) {
    const M = m1 + m2, eta = symmetricMassRatio(m1, m2);
    const X1 = m1 / M, X2 = m2 / M;
    return -((113 * X1 * X1 + 75 * eta) * chi1 + (113 * X2 * X2 + 75 * eta) * chi2) / 12;
}

/**
 * Integrate the inspiral.
 *
 * @param {object} p
 *   m1, m2        masses, M☉
 *   lambda1/2     dimensionless tidal deformabilities (0 for a black hole)
 *   chi1/2        aligned dimensionless spins
 *   r1Km/r2Km     radii (km) for the contact criterion (0 for a black hole)
 *   fStartHz      starting GW frequency
 *   distanceMpc   for the strain
 *   tailSeconds   how much of the end to sample densely for h(t)
 *   maxSteps      guard
 * @returns {object} track, tail, summary numbers. Times in seconds from start.
 */
export function inspiral(p) {
    const {
        m1, m2, lambda1 = 0, lambda2 = 0, chi1 = 0, chi2 = 0,
        r1Km = 0, r2Km = 0, fStartHz = 30, distanceMpc = 40,
        tailSeconds = 0.05, maxSteps = 200000,
    } = p;
    const M = m1 + m2;
    const eta = symmetricMassRatio(m1, m2);
    const lambdaTilde = combinedTidal(m1, m2, lambda1, lambda2);
    const dSpin = spinOrbitDelta(m1, m2, chi1, chi2);
    const D = distanceMpc * MPC_GEOM;
    // Contact uses the 1PN harmonic-coordinate separation r = (M/x)[1 − (1 − η/3)x]
    // (Blanchet 2014 eq. 227). The Newtonian M/x puts a 1.4+1.4 SLy pair's
    // contact at x = 0.177, PAST the test-particle ISCO, which would label
    // every neutron-star merger "isco"; at 1PN contact lands at x ≈ 0.15
    // (f_GW ≈ 1.37 kHz), on the low side of the 1.5–2 kHz the numerical
    // relativity merger frequencies sit at, and the page says so.
    const rContact = (r1Km + r2Km) / GEOM_KM;
    const xContact = rContact > 0 ? M / (rContact + (1 - eta / 3) * M) : Infinity;
    const xIsco = 1 / 6;
    const xEnd = Math.min(xIsco, xContact);

    const x0 = xAtGwFrequency(fStartHz, M);
    if (!(x0 < xEnd)) {
        return { valid: false, reason: 'start frequency is already past the end of the inspiral',
            M, eta, chirpMass: chirpMass(m1, m2), lambdaTilde, xEnd, x0, endReason: 'none' };
    }

    const xdot = (x) => (64 * eta / (5 * M)) * x ** 5 * taylorT4Bracket(x, eta, dSpin, lambdaTilde);
    const phidot = (x) => x ** 1.5 / M;

    // Pass 1: coarse adaptive march recording the (t, x, φ) track.
    const track = [];
    let t = 0, x = x0, phi = 0, steps = 0, endReason = 'isco';
    let lastXdot = xdot(x);
    track.push({ t, x, phi });
    while (x < xEnd && steps < maxSteps) {
        const k1x = lastXdot, k1p = phidot(x);
        if (!(k1x > 0)) { endReason = 'series'; break; }
        const dt = 0.01 * x / k1x; // ≤1 % of x per step (~350 steps for a full BNS inspiral)
        const x2 = x + 0.5 * dt * k1x; const k2x = xdot(x2), k2p = phidot(x2);
        const x3 = x + 0.5 * dt * k2x; const k3x = xdot(x3), k3p = phidot(x3);
        const x4 = x + dt * k3x;       const k4x = xdot(x4), k4p = phidot(x4);
        const xn = x + dt / 6 * (k1x + 2 * k2x + 2 * k3x + k4x);
        const pn = phi + dt / 6 * (k1p + 2 * k2p + 2 * k3p + k4p);
        if (xn >= xEnd) {
            // Land exactly on xEnd by linear interpolation of this step.
            const f = (xEnd - x) / (xn - x);
            t += f * dt; x = xEnd; phi += f * (pn - phi);
            endReason = xEnd === xContact && xContact < xIsco ? 'contact' : 'isco';
            track.push({ t, x, phi });
            break;
        }
        t += dt; x = xn; phi = pn; steps++;
        lastXdot = xdot(x);
        track.push({ t, x, phi });
    }
    if (steps >= maxSteps) endReason = 'steps';
    const tEnd = t;
    const nCycles = phi / Math.PI;      // GW cycles = 2 × orbits
    const hAmp = (xx) => 4 * eta * M * xx / D;

    // Pass 2: dense waveform over the last `tailSeconds` (or the whole track if shorter).
    const tailGeom = tailSeconds / GEOM_S;
    const tTail0 = Math.max(0, tEnd - tailGeom);
    // find state at tTail0 by interpolating the track in x (monotonic in t)
    let i = 0;
    while (i < track.length - 1 && track[i + 1].t < tTail0) i++;
    const a = track[i], b = track[Math.min(i + 1, track.length - 1)];
    const f = b.t > a.t ? (tTail0 - a.t) / (b.t - a.t) : 0;
    let xt = a.x + f * (b.x - a.x), pt = a.phi + f * (b.phi - a.phi), tt = tTail0;
    const tail = { t: [], hPlus: [], hCross: [], f: [] };
    const nTail = 2400;
    const dtSample = Math.max((tEnd - tTail0) / nTail, 1e-9);
    let nextSample = tTail0;
    let guard = 0;
    const pushSample = () => {
        tail.t.push((tt - tTail0) * GEOM_S);
        tail.hPlus.push(hAmp(xt) * Math.cos(2 * pt));
        tail.hCross.push(hAmp(xt) * Math.sin(2 * pt));
        tail.f.push(gwFrequencyHz(xt, M));
    };
    while (xt < xEnd && tt < tEnd && guard < 2000000) {
        if (tt >= nextSample) { pushSample(); nextSample += dtSample; }
        const period = 2 * Math.PI / phidot(xt);   // orbital period
        const dt = Math.min(period / 24, dtSample, tEnd - tt);
        const k1x = xdot(xt), k1p = phidot(xt);
        if (!(k1x > 0) || !(dt > 0)) break;
        const x2 = xt + 0.5 * dt * k1x; const k2x = xdot(x2), k2p = phidot(x2);
        const x3 = xt + 0.5 * dt * k2x; const k3x = xdot(x3), k3p = phidot(x3);
        const x4 = xt + dt * k3x;       const k4x = xdot(x4), k4p = phidot(x4);
        xt += dt / 6 * (k1x + 2 * k2x + 2 * k3x + k4x);
        pt += dt / 6 * (k1p + 2 * k2p + 2 * k3p + k4p);
        tt += dt;
        guard++;
    }
    if (tail.t.length === 0) pushSample();

    return {
        valid: true,
        M, eta, chirpMass: chirpMass(m1, m2), massRatio: Math.min(m1, m2) / Math.max(m1, m2),
        lambdaTilde, chiEff: effectiveSpin(m1, m2, chi1, chi2),
        x0, xEnd, endReason,
        fStartHz, fEndHz: gwFrequencyHz(xEnd, M), fIscoHz: iscoFrequencyHz(M),
        fContactHz: Number.isFinite(xContact) ? gwFrequencyHz(Math.min(xContact, 1), M) : null,
        timeToMergerS: tEnd * GEOM_S,
        gwCycles: nCycles,
        orbits: nCycles / 2,
        strainAtEnd: hAmp(xEnd),
        strainAtStart: hAmp(x0),
        distanceMpc,
        track: decimate(track, 800).map(s => ({ tS: s.t * GEOM_S, x: s.x, fHz: gwFrequencyHz(s.x, M), h: hAmp(s.x) })),
        tail,
        tailStartS: tTail0 * GEOM_S,
    };
}

function decimate(arr, n) {
    if (arr.length <= n) return arr;
    const out = [];
    for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * (arr.length - 1) / (n - 1))]);
    return out;
}

/**
 * Newtonian (leading-order) time from GW frequency f to coalescence, seconds.
 * The 3.5PN track above is shorter than this by a few percent at the end.
 */
export function newtonianTimeToMerger(m1, m2, fHz) {
    const Mc = chirpMass(m1, m2) * GEOM_S; // seconds
    return (5 / 256) * (Math.PI * fHz) ** (-8 / 3) * Mc ** (-5 / 3);
}

/**
 * Peters (1964) merger time for an eccentric orbit, seconds.
 *   T = (12/19) c₀⁴/β ∫₀^{e₀} e^{29/19} [1 + 121e²/304]^{1181/2299} / (1 − e²)^{3/2} de
 * with β = (64/5) m₁m₂M (geometric) and c₀ from a₀ and e₀.
 * Circular limit: T = a⁴ / (4β).
 */
export function mergerTimePeters({ m1, m2, aKm, e = 0 }) {
    const M = m1 + m2;
    const beta = (64 / 5) * m1 * m2 * M;
    const a0 = aKm / GEOM_KM;
    if (e < 1e-6) return a0 ** 4 / (4 * beta) * GEOM_S;
    const c0 = a0 * (1 - e * e) / (e ** (12 / 19) * (1 + 121 * e * e / 304) ** (870 / 2299));
    const g = (ee) => ee ** (29 / 19) * (1 + 121 * ee * ee / 304) ** (1181 / 2299) / (1 - ee * ee) ** 1.5;
    // Simpson on [0, e], n even.
    const n = 400, h = e / n;
    let s = g(0) + g(e);
    for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * g(i * h);
    const integral = s * h / 3;
    return (12 / 19) * c0 ** 4 / beta * integral * GEOM_S;
}

/** Semi-major axis (km) from the orbital period (s) and total mass (M☉). */
export function semiMajorAxisKm(periodS, M) {
    const P = periodS / GEOM_S;
    return Math.cbrt(M * P * P / (4 * Math.PI * Math.PI)) * GEOM_KM;
}

/** Seconds → a compact human string. */
export function formatDuration(s) {
    if (!Number.isFinite(s)) return '—';
    const yr = 3.15576e7;
    if (s >= 1e9 * yr) return `${(s / (1e9 * yr)).toPrecision(3)} Gyr`;
    if (s >= 1e6 * yr) return `${(s / (1e6 * yr)).toPrecision(3)} Myr`;
    if (s >= 1e3 * yr) return `${(s / (1e3 * yr)).toPrecision(3)} kyr`;
    if (s >= yr) return `${(s / yr).toPrecision(3)} yr`;
    if (s >= 86400) return `${(s / 86400).toPrecision(3)} d`;
    if (s >= 3600) return `${(s / 3600).toPrecision(3)} h`;
    if (s >= 60) return `${(s / 60).toPrecision(3)} min`;
    if (s >= 1) return `${s.toPrecision(3)} s`;
    if (s >= 1e-3) return `${(s * 1e3).toPrecision(3)} ms`;
    return `${(s * 1e6).toPrecision(3)} µs`;
}
