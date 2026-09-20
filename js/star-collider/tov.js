/**
 * star-collider/tov.js — relativistic stellar structure + tidal response (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * Given an EOS from eos.js, integrates the Tolman–Oppenheimer–Volkoff
 * equations outward from a central density and, ALONGSIDE them, the l = 2
 * even-parity metric perturbation that gives the star its tidal Love number
 * (Hinderer 2008, ApJ 677, 1216; Hinderer, Lackey, Lang & Read 2010).
 * Everything is in geometric units, G = c = 1, mass unit M☉ (eos.js has the
 * conversions).
 *
 *   dm/dr  = 4π r² ε
 *   dp/dr  = −(ε + p)(m + 4π r³ p) / (r (r − 2m))
 *   dMb/dr = 4π r² ρ / √(1 − 2m/r)                       (baryonic mass)
 *   r y'   = −y² − y F(r) − r² Q(r),    y(0) = 2          (tidal, y ≡ r H'/H)
 *
 * with F = [r − 4π r³(ε − p)]/(r − 2m) and
 *      Q = 4π r [5ε + 9p + (ε + p)/c_s² − 6/(4π r²)]/(r − 2m)
 *          − 4 [(m + 4π r³ p)/(r²(1 − 2m/r))]².
 *
 * The apsidal constant then follows from y(R) and C = M/R (Hinderer 2008
 * eq. 23), Λ = (2/3) k2 C⁻⁵ is the dimensionless tidal deformability that
 * enters the gravitational-wave phase, and the moment of inertia comes from
 * the I–Love universal relation (Yagi & Yunes 2013/2017) rather than a
 * Hartle slow-rotation solve — it is EOS-insensitive to ~1 % and that is the
 * point of using it.
 *
 * NUMERICS. RK4 in r with the step tied to the local pressure scale height
 * (`STEP_FRAC · p/|dp/dr|`, capped at `DR_MAX`); the last step lands on the
 * surface pressure by a linear estimate so the radius is not quantised by
 * the step. The surface is where ρ falls to `RHO_SURFACE_CGS` = 10⁶ g/cm³
 * — the outer crust below that is centimetres thick and contributes
 * nothing to M, R or y. ε does go to zero there, so the y(R) surface
 * correction for finite surface density is not needed (it would be
 * 4πR³ε_s/M ≈ 10⁻¹¹).
 *
 * The M_max search brackets the maximum of the M(ρc) sequence by a
 * golden-section search on log ρc; `starAtMass` bisects ρc on the STABLE
 * branch only (ρc < ρc at M_max), so an unattainable mass returns null
 * rather than a star on the unstable branch.
 */

import { createEos, RHO_GEOM, GEOM_KM } from './eos.js';

const PI4 = 4 * Math.PI;
const RHO_SURFACE_CGS = 1e6;
const DR_MAX = 0.01;            // ≈ 15 m
const STEP_FRAC = 0.03;         // fraction of the pressure scale height per step
const R_START = 1e-4;           // ≈ 15 cm

/** Yagi & Yunes (2017 Phys. Rep.) I–Love fit: ln Ī = Σ aᵢ (ln Λ)ⁱ, Ī = I/M³. */
const ILOVE = [1.47, 0.0817, 0.0149, 2.87e-4, -3.64e-5];

/** I/M³ from Λ (geometric; multiply by M³ for I in M☉·(GM☉/c²)²). */
export function iLoveBar(lambda) {
    if (!(lambda > 0)) return NaN;
    const x = Math.log(lambda);
    let s = 0, xp = 1;
    for (const a of ILOVE) { s += a * xp; xp *= x; }
    return Math.exp(s);
}

/** Hinderer 2008 eq. 23 — k2 from the surface y and compactness C. */
export function loveNumberK2(C, y) {
    const l = Math.log(1 - 2 * C);
    const num = (8 * C ** 5 / 5) * (1 - 2 * C) ** 2 * (2 + 2 * C * (y - 1) - y);
    const den = 2 * C * (6 - 3 * y + 3 * C * (5 * y - 8))
        + 4 * C ** 3 * (13 - 11 * y + C * (3 * y - 2) + 2 * C * C * (1 + y))
        + 3 * (1 - 2 * C) ** 2 * (2 - y + 2 * C * (y - 1)) * l;
    return num / den;
}

/**
 * Integrate one star from central rest-mass density ρc (geometric).
 * Returns { M, R, Mb, C, k2, Lambda, y, rhoC, pC, steps, profile? }.
 * `opts.profile = n` records n evenly spaced (r, m, p, ρ) samples.
 */
export function integrateTov(eos, rhoC, opts = {}) {
    const pC = eos.pressure(rhoC);
    const pSurf = eos.pressure(RHO_SURFACE_CGS / RHO_GEOM);
    if (!(pC > pSurf)) return null;

    // State: [m, p, y, Mb]
    const rhs = (r, s, out) => {
        const m = s[0], p = s[1], y = s[2];
        const rho = eos.rhoOfPressure(p);
        const eps = eos.energyDensity(rho);
        const cs2 = eos.soundSpeed2(rho);
        const rm2 = r - 2 * m;
        const dm = PI4 * r * r * eps;
        const dp = -(eps + p) * (m + PI4 * r ** 3 * p) / (r * rm2);
        const F = (r - PI4 * r ** 3 * (eps - p)) / rm2;
        const Q = PI4 * r * (5 * eps + 9 * p + (eps + p) / cs2 - 6 / (PI4 * r * r)) / rm2
            - 4 * ((m + PI4 * r ** 3 * p) / (r * r * (1 - 2 * m / r))) ** 2;
        const dy = (-y * y - y * F - r * r * Q) / r;
        const dMb = PI4 * r * r * rho / Math.sqrt(1 - 2 * m / r);
        out[0] = dm; out[1] = dp; out[2] = dy; out[3] = dMb;
        return dp;
    };

    const epsC = eos.energyDensity(rhoC);
    let r = R_START;
    const s = [PI4 / 3 * r ** 3 * epsC, pC, 2, PI4 / 3 * r ** 3 * rhoC];
    const k1 = [0, 0, 0, 0], k2 = [0, 0, 0, 0], k3 = [0, 0, 0, 0], k4 = [0, 0, 0, 0];
    const tmp = [0, 0, 0, 0];
    let steps = 0;
    const wantProfile = opts.profile | 0;
    const profile = wantProfile ? [] : null;
    let nextSample = 0;

    for (;;) {
        const dp1 = rhs(r, s, k1);
        let dr = Math.min(DR_MAX, STEP_FRAC * s[1] / Math.abs(dp1));
        let last = false;
        if (s[1] + dr * dp1 <= pSurf) {
            dr = (s[1] - pSurf) / Math.abs(dp1) * 0.999;
            last = true;
        }
        if (profile && r >= nextSample) {
            profile.push({ r, m: s[0], p: s[1], rho: eos.rhoOfPressure(s[1]) });
            nextSample += 20 / wantProfile; // ~20 geometric units of radius spread over n samples
        }
        for (let i = 0; i < 4; i++) tmp[i] = s[i] + 0.5 * dr * k1[i];
        rhs(r + 0.5 * dr, tmp, k2);
        for (let i = 0; i < 4; i++) tmp[i] = s[i] + 0.5 * dr * k2[i];
        rhs(r + 0.5 * dr, tmp, k3);
        for (let i = 0; i < 4; i++) tmp[i] = s[i] + dr * k3[i];
        rhs(r + dr, tmp, k4);
        for (let i = 0; i < 4; i++) s[i] += dr / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
        r += dr;
        steps++;
        if (last || s[1] <= pSurf || steps > 200000) break;
    }

    const M = s[0], R = r, C = M / R, y = s[2];
    const k2v = loveNumberK2(C, y);
    const Lambda = (2 / 3) * k2v / C ** 5;
    return {
        M, R, Mb: s[3], C, k2: k2v, Lambda, y, rhoC, pC, steps,
        rKm: R * GEOM_KM,
        rhoCcgs: rhoC * RHO_GEOM,
        Ibar: iLoveBar(Lambda),
        profile,
    };
}

/** Central density (geometric) from a cgs value — the sequence is scanned in cgs for legibility. */
const geo = (rhoCgs) => rhoCgs / RHO_GEOM;

/**
 * The M(ρc) sequence and its maximum. Scans log-spaced central densities
 * from 2×10¹⁴ to 8×10¹⁵ g/cm³, then refines M_max by golden section.
 * Returns { points: [{rhoCcgs, M, R, C, Lambda, k2, stable}], mmax: star,
 *           rhoCmaxCgs }.
 */
export function massRadiusSequence(eos, n = 48) {
    const lo = Math.log(2e14), hi = Math.log(8e15);
    const points = [];
    for (let i = 0; i < n; i++) {
        const rhoCgs = Math.exp(lo + (hi - lo) * i / (n - 1));
        const st = integrateTov(eos, geo(rhoCgs));
        if (st) points.push(st);
    }
    // Bracket the maximum on the grid.
    let iMax = 0;
    for (let i = 1; i < points.length; i++) if (points[i].M > points[iMax].M) iMax = i;
    let a = Math.log(points[Math.max(0, iMax - 1)].rhoCcgs);
    let b = Math.log(points[Math.min(points.length - 1, iMax + 1)].rhoCcgs);
    const phi = (Math.sqrt(5) - 1) / 2;
    const f = (lx) => integrateTov(eos, geo(Math.exp(lx))).M;
    let c = b - phi * (b - a), d = a + phi * (b - a);
    let fc = f(c), fd = f(d);
    for (let it = 0; it < 28; it++) {
        if (fc > fd) { b = d; d = c; fd = fc; c = b - phi * (b - a); fc = f(c); }
        else { a = c; c = d; fc = fd; d = a + phi * (b - a); fd = f(d); }
    }
    const rhoMax = Math.exp((a + b) / 2);
    const mmax = integrateTov(eos, geo(rhoMax));
    for (const p of points) p.stable = p.rhoCcgs <= rhoMax;
    return { points, mmax, rhoCmaxCgs: rhoMax };
}

/**
 * The stable-branch star of gravitational mass M (M☉) for this EOS, or null
 * if M exceeds M_max. Bisection on ρc between the lightest scanned star and
 * the M_max star. `seq` may be passed to skip recomputing the sequence.
 */
export function starAtMass(eos, M, seq = null) {
    const sequence = seq || massRadiusSequence(eos);
    if (!(M > 0) || M > sequence.mmax.M) return null;
    let lo = Math.log(2e14), hi = Math.log(sequence.rhoCmaxCgs);
    let star = null;
    for (let it = 0; it < 60; it++) {
        const mid = 0.5 * (lo + hi);
        star = integrateTov(eos, geo(Math.exp(mid)));
        if (star.M < M) lo = mid; else hi = mid;
        if (Math.abs(star.M - M) < 1e-5) break;
    }
    return star;
}

/** Convenience: build the EOS and the star in one call. */
export function buildNeutronStar(eosId, M, seq = null) {
    const eos = createEos(eosId);
    return starAtMass(eos, M, seq);
}

/** Bauswein+2013 prompt-collapse threshold: M_th = (−3.606 C_max + 2.38) M_max. */
export function thresholdMass(mmaxStar) {
    return (-3.606 * mmaxStar.C + 2.38) * mmaxStar.M;
}
