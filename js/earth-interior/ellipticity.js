/**
 * ellipticity.js — the Earth is not a sphere: Clairaut's figure and the
 * first-order travel-time correction it implies, for ANY phase and path.
 * Pure kernel. Gate: `tests/earth-interior-phases.mjs` (§E–G).
 *
 * ── THE FIGURE ───────────────────────────────────────────────────────────
 * Rotation flattens every surface of constant density into a spheroid
 *      r = r₀ · (1 − ⅔ ε(r₀) P₂(cos θ)),      θ = geocentric colatitude,
 * whose ellipticity ε(r₀) obeys CLAIRAUT's equation
 *      ε'' + (6ρ/ρ̄r) ε' + (6/r²)(ρ/ρ̄ − 1) ε = 0,     ρ̄(r) = mean density inside r,
 * regular at the centre and closed at the surface by
 *      r ε' + 2ε = (5/2) m,      m = ω²R³/GM.
 * It is integrated here on PREM's own density (RK4, region by region, ε and
 * ε' continuous across every density jump). Gated by the two closed forms
 * (a uniform body: ε = 5m/4, Maclaurin; a point-mass core: ε = m/2, Roche).
 * PREM's HYDROSTATIC surface value comes out near 1/299.6 while the real
 * Earth is 1/298.257 (it is not quite in hydrostatic equilibrium), so the
 * correction uses Clairaut's SHAPE scaled to the observed surface value —
 * stations sit on the real ellipsoid. That is a choice, and it is disclosed.
 *
 * ── THE CORRECTION ───────────────────────────────────────────────────────
 * Map every level surface to a sphere: x = y·(1 − g(y)), g = ⅔ ε P₂. In y
 * the model IS the spherical one (v depends on |y| only, every boundary is
 * a sphere, source and receiver sit at their spherical radii at the SAME
 * geocentric angles). Only the metric changes, |dx| = |dy|(1 − g − r t_r ∂g/∂s),
 * so by Fermat the first-order change of travel time along the spherical ray
 * is
 *      δT = −∫ g dt  −  ∫ σ √(η² − p²) dg,       σ = ±1 up/down the ray.
 * No boundary terms (every boundary is a sphere in y), no table of
 * coefficients: it is evaluated along the phase's own path. Gated against an
 * exact chord on a uniform ellipsoid and against two-point RK4 ray shooting
 * through a flattened smooth model — both independent of this formula.
 *
 * Geographic latitudes are converted with WGS84; Δ and azimuth are geocentric.
 * Not modelled: topography, station elevation, the ocean column at a station,
 * lateral structure.
 */

import { R_EARTH_KM, PREM_REGIONS, premAt, premMassKg, G_NEWTON } from './prem.js';

export const WGS84_F = 1 / 298.257223563;
export const OMEGA_EARTH = 7.2921150e-5;     // rad/s, IERS
const DEG = Math.PI / 180;

/** m = ω²R³/GM for a body (SI inputs: R in km, GM in m³/s²). */
export const rotationParameter = (radiusKm, gm) => OMEGA_EARTH ** 2 * (radiusKm * 1e3) ** 3 / gm;

/**
 * Integrate Clairaut's equation. `rho(rKm, regionIndex)` evaluates region k's
 * OWN law; `regions` are [{ rInnerKm, rOuterKm }] centre outward.
 * Returns { rKm: Float64Array, eps: Float64Array, surface, epsAt(r) } with ε
 * normalised by the surface condition for rotation parameter m.
 */
export function clairaut(rho, regions, m, { stepKm = 2 } = {}) {
    const R = regions.at(-1).rOuterKm;
    const r0 = Math.min(1e-3 * R, regions[0].rOuterKm * 0.5);
    let e = 1, de = 0, I = rho(r0, 0) * r0 ** 3 / 3;              // I = ∫ρ r² dr (ρ̄ = 3I/r³)
    const rs = [0, r0], es = [1, 1];
    const f = (r, k, [eps, dEps, Ii]) => {
        const rh = rho(r, k), rbar = 3 * Ii / r ** 3;
        return [dEps, -(6 * rh / (rbar * r)) * dEps - (6 / (r * r)) * (rh / rbar - 1) * eps, rh * r * r];
    };
    let r = r0;
    for (let k = 0; k < regions.length; k++) {
        const g = regions[k];
        const a = Math.max(g.rInnerKm, r0), b = g.rOuterKm;
        if (b <= a) continue;
        r = a;
        // Near the centre the 6/r terms are stiff: a fixed 2 km step put a spurious dip
        // in ε at 10 km (measured), so the step never exceeds r/20 (at r/5 the dip survived, measured).
        while (r < b - 1e-12) {
            const h = Math.min(stepKm, 0.05 * r, b - r);
            const y = [e, de, I];
            const k1 = f(r, k, y);
            const k2 = f(r + h / 2, k, y.map((v, j) => v + h / 2 * k1[j]));
            const k3 = f(r + h / 2, k, y.map((v, j) => v + h / 2 * k2[j]));
            const k4 = f(r + h, k, y.map((v, j) => v + h * k3[j]));
            e += h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]);
            de += h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]);
            I += h / 6 * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2]);
            r += h; rs.push(r); es.push(e);
        }
    }
    const scale = (2.5 * m) / (R * de + 2 * e);
    const eps = Float64Array.from(es, (v) => v * scale), rKm = Float64Array.from(rs);
    return { rKm, eps, surface: eps.at(-1), epsAt: (x) => interp(rKm, eps, x), meanDensity: 3 * I / R ** 3 };
}

function interp(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    if (x >= xs.at(-1)) return ys.at(-1);
    let a = 0, b = xs.length - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (xs[m] <= x) a = m; else b = m; }
    return ys[a] + (ys[b] - ys[a]) * (x - xs[a]) / (xs[b] - xs[a]);
}

/** PREM's hydrostatic figure (with its ocean: the figure follows the real mass). */
let PREM_FIGURE = null;
export function premFigure() {
    if (PREM_FIGURE) return PREM_FIGURE;
    const regions = PREM_REGIONS;
    const rho = (r, k) => premAt(Math.min(R_EARTH_KM, r), { side: r <= regions[k].rInnerKm + 1e-9 ? 'above' : 'below' }).rhoKgM3;
    const m = rotationParameter(R_EARTH_KM, G_NEWTON * premMassKg());
    const fig = clairaut(rho, regions, m);
    PREM_FIGURE = { ...fig, m, hydrostaticFlattening: fig.surface };
    return PREM_FIGURE;
}

/**
 * The ε(r) the correction uses: PREM's hydrostatic SHAPE scaled so the
 * surface is the observed ellipsoid (WGS84). Returns a function of r (km).
 */
export function observedEllipticity() {
    const fig = premFigure(), k = WGS84_F / fig.surface;
    return (r) => k * fig.epsAt(r);
}

/** Geographic → geocentric latitude on the WGS84 ellipsoid (degrees). */
export const geocentricLatDeg = (latDeg) => Math.atan((1 - WGS84_F) ** 2 * Math.tan(latDeg * DEG)) / DEG;

/**
 * Geocentric path geometry between two geographic points: source colatitude
 * θs, distance Δ and the azimuth ζ (from north, at the source), all radians.
 */
export function pathGeometry(srcLat, srcLon, rcvLat, rcvLon) {
    const p1 = geocentricLatDeg(srcLat) * DEG, p2 = geocentricLatDeg(rcvLat) * DEG, dl = (rcvLon - srcLon) * DEG;
    const cosD = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
    const delta = Math.acos(Math.max(-1, Math.min(1, cosD)));
    const az = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
    return { thetaS: Math.PI / 2 - p1, deltaRad: delta, deltaDeg: delta / DEG, azimuthRad: az, srcLatC: p1 / DEG, rcvLatC: p2 / DEG };
}

/**
 * δT (s) for one ray (a phases.js ray with legs) along a path with source
 * colatitude θs and azimuth ζ. `epsAt(rKm)` is the ellipticity profile.
 * `model` is the phase model whose samplePath the ray belongs to.
 */
export function ellipticityCorrection(ray, model, { thetaS, azimuthRad }, epsAt = observedEllipticity(), { sub = 2, slopeTerm = true } = {}) {
    const { nodes, intervals } = model.samplePath(ray, { sub });
    const cs = Math.cos(thetaS), ss = Math.sin(thetaS), cz = Math.cos(azimuthRad);
    const g = nodes.map((n) => {
        const c = cs * Math.cos(n.deltaRad) + ss * Math.sin(n.deltaRad) * cz;
        return (2 / 3) * epsAt(n.rKm) * 0.5 * (3 * c * c - 1);
    });
    let dT = 0;
    for (let i = 0; i < intervals.length; i++) {
        const iv = intervals[i], ga = g[i], gb = g[i + 1];
        // slopeTerm: false is the gate's NEGATIVE CONTROL (the stretch of the radial metric alone).
        dT -= 0.5 * (ga + gb) * iv.dT + (slopeTerm ? iv.dirSign * iv.q * (gb - ga) : 0);
    }
    return dT;
}
