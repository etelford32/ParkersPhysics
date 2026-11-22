/**
 * chicxulub/reconstruct.js — the BACKWARD model: crater → impactor → orbit.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. Node-gated by tests/chicxulub.mjs.
 *
 * §1 THE IMPACTOR. A crater's size fixes ONE combination of the impactor's
 * properties — roughly L^0.78 v^0.44 ρ^⅓ sin^⅓θ — so size and speed trade off
 * along a curve and the crater alone cannot separate them. Two more pieces of
 * evidence cut across that curve:
 *
 *   · the global iridium layer counts the impactor's MASS (if all of its
 *     iridium ended up spread over the planet);
 *   · the population of bodies that could have done it sets what speeds are
 *     plausible (a main-belt asteroid arrives at ~12–30 km/s).
 *
 * THEY DISAGREE. With every gram of iridium counted, the layer weighs a ~7 km
 * body, and a body that small needs comet-like speed to dig this crater —
 * which the ruthenium isotopes rule out. The reconstruction therefore carries
 * the deposited fraction `fDep` as an UNKNOWN and reports it: at asteroid
 * speeds the layer holds only part of the impactor's iridium. Both readings
 * are returned (`scenario: 'asteroid'` and `'all-iridium'`); the page shows
 * both and never blends them.
 *
 * The posterior is a deterministic grid sum (no sampling, no seed).
 *
 * §2 THE TRAJECTORY. The crater's asymmetry gives the last seconds of flight:
 * the angle to the ground and the compass direction. Running that backwards:
 *
 *   ground velocity  →  add Earth's spin  →  the exact two-body hyperbola out
 *   of Earth's gravity (v∞ and its direction — Earth's pull bends the path by
 *   a known angle)  →  add Earth's own orbital velocity  →  a heliocentric orbit.
 *
 * The last two steps need to know which way the impact site was FACING — the
 * local time of day — and that is not recorded anywhere. So the answer is a
 * FAMILY of orbits, one per hour of the day, and the family is the result:
 * some hours give an ordinary asteroid orbit, some a comet's, some no bound
 * orbit at all. `orbitFamily` maps it.
 *
 * WHAT THE TRAJECTORY ASSUMES, AND SAYS: present-day site coordinates (the
 * Yucatán's 66 Ma latitude and rotation are in OPEN_DATA), today's obliquity
 * and a circular 1 au orbit for Earth (neither is knowable 66 Myr back — the
 * Solar System is chaotic past ~50 Myr), and the published "from the
 * northeast" read as azimuth 45° ± 30°.
 */

import {
    transientDiameter, finalDiameter, impactorMass, kineticEnergy, iridiumFluence,
    R_EARTH, MU_EARTH, V_ESC,
} from './impact-model.js';

const RAD = Math.PI / 180;

// ── §1 priors and likelihoods ───────────────────────────────────────────────
/**
 * Impact-speed prior for ASTEROIDS at Earth: v∞ Rayleigh-distributed with
 * mode 13 km/s, giving a mean impact speed near 20 km/s. A stand-in for the
 * real distribution (Nesvorný et al. 2021 — in OPEN_DATA), recalled, not fitted.
 */
export const SPEED_PRIOR = Object.freeze({ vInfModeKms: 13, verified: false });
export function asteroidSpeedDensity(vKms) {
    const vesc = V_ESC / 1000;
    if (!(vKms > vesc)) return 0;
    const vinf = Math.sqrt(vKms * vKms - vesc * vesc), s = SPEED_PRIOR.vInfModeKms;
    // p(v) = p(v∞) dv∞/dv
    return vinf / (s * s) * Math.exp(-vinf * vinf / (2 * s * s)) * (vKms / vinf);
}
/** Random impacts: p(θ) ∝ sin 2θ (Gilbert 1893; Shoemaker 1962) — most likely 45°. */
export function angleDensity(angleDeg) { return Math.sin(2 * angleDeg * RAD); }

const gauss = (x, mu, sigma) => Math.exp(-0.5 * ((x - mu) / sigma) ** 2);
/** Flat between lo and hi with Gaussian shoulders. */
const plateau = (x, lo, hi, sigma) => (x < lo ? gauss(x, lo, sigma) : x > hi ? gauss(x, hi, sigma) : 1);

export const DEFAULTS = Object.freeze({
    // The crater likelihood is on the FINAL diameter, in log space. The scaling
    // law predicts the TOPOGRAPHIC rim, so the centre is the measured inner rim
    // (140–170 km); the width covers that range and the law's own scatter.
    // WHICH RING IS THE RIM IS THE LARGEST SYSTEMATIC HERE: `craterKm: 190`
    // (the outer ring) is the stated alternative and the report prints both.
    // MEASURED: the three published hydrocode impactors come out at 131–147 km
    // on this law — at the inner rim, well short of the outer ring.
    craterKm: 155, craterLogSigma: 0.12,
    angleLo: 45, angleHi: 60, angleSigma: 8,
    fluence: 55, fluenceSigma: 3,
    fluenceModelLogSigma: 0.12,   // abundance + layer-sampling uncertainty
    abundanceNgG: 595,            // CM
    targetDensity: 2700,
    grid: Object.freeze({
        diameterKm: [3, 30, 82], speedKms: [11.3, 72, 90],
        angleDeg: [20, 90, 15], density: [1400, 2700, 6],
    }),
});

function axis([lo, hi, n], log = false) {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const f = n === 1 ? 0.5 : i / (n - 1);
        out[i] = log ? lo * (hi / lo) ** f : lo + (hi - lo) * f;
    }
    return out;
}
function quantiles(samples, weights, qs) {
    const idx = Array.from(samples.keys()).sort((a, b) => samples[a] - samples[b]);
    let total = 0; for (const w of weights) total += w;
    const out = []; let acc = 0, k = 0;
    for (const q of qs) {
        while (k < idx.length - 1 && acc + weights[idx[k]] < q * total) acc += weights[idx[k++]];
        out.push(samples[idx[k]]);
    }
    return out;
}

/**
 * The posterior over (diameter, speed, angle, density).
 *   scenario 'asteroid'     speed prior = asteroids; fDep is DERIVED per cell
 *                           (the fraction of the body's Ir the layer holds) and
 *                           cells needing fDep > 1 are penalised by the Ir likelihood.
 *   scenario 'all-iridium'  fDep = 1 imposed, speed prior flat — what the
 *                           crater and the layer say with no population prior.
 *   scenario 'crater-only'  the crater and the angle alone (the degeneracy).
 * `useAngle: false` drops the published trajectory and keeps the sin 2θ prior.
 */
export function reconstructImpactor({ scenario = 'asteroid', useAngle = true, ...over } = {}) {
    const o = { ...DEFAULTS, ...over };
    const Ls = axis(o.grid.diameterKm, true), vs = axis(o.grid.speedKms, true);
    const ths = axis(o.grid.angleDeg), rhos = axis(o.grid.density);
    const N = Ls.length * vs.length * ths.length * rhos.length;
    const S = { L: new Float64Array(N), v: new Float64Array(N), th: new Float64Array(N), rho: new Float64Array(N),
                mass: new Float64Array(N), energy: new Float64Array(N), fDep: new Float64Array(N),
                crater: new Float64Array(N), w: new Float64Array(N) };
    const LvMap = new Float64Array(Ls.length * vs.length);
    let k = 0, best = -1, bestK = 0;
    for (let i = 0; i < Ls.length; i++) for (let j = 0; j < vs.length; j++) {
        for (let a = 0; a < ths.length; a++) for (let b = 0; b < rhos.length; b++, k++) {
            const L = Ls[i], v = vs[j], th = ths[a], rho = rhos[b];
            const Dfr = finalDiameter(transientDiameter({ diameterM: L * 1000, speed: v * 1000, angleDeg: th, density: rho, targetDensity: o.targetDensity })) / 1000;
            const mass = impactorMass(L * 1000, rho);
            const fullIr = iridiumFluence({ massKg: mass, abundanceNgG: o.abundanceNgG, fDep: 1 });
            // log-uniform grid in L and v ⇒ multiply by L·v for a flat prior in each
            let w = L * v * gauss(Math.log(Dfr), Math.log(o.craterKm), o.craterLogSigma) * angleDensity(th);
            if (useAngle) w *= plateau(th, o.angleLo, o.angleHi, o.angleSigma);
            const irSigma = Math.hypot(o.fluenceSigma / o.fluence, o.fluenceModelLogSigma);
            let fDep = Math.min(1, o.fluence / fullIr);
            if (scenario === 'asteroid') {
                w *= asteroidSpeedDensity(v);
                // fDep ≤ 1 is free; a body too small to supply the layer is penalised
                if (fullIr < o.fluence) w *= gauss(Math.log(fullIr), Math.log(o.fluence), irSigma);
            } else if (scenario === 'all-iridium') {
                fDep = 1;
                w *= gauss(Math.log(fullIr), Math.log(o.fluence), irSigma);
            }
            S.L[k] = L; S.v[k] = v; S.th[k] = th; S.rho[k] = rho; S.mass[k] = mass;
            S.energy[k] = kineticEnergy(mass, v * 1000); S.fDep[k] = fDep; S.crater[k] = Dfr; S.w[k] = w;
            LvMap[i * vs.length + j] += w;
            if (w > best) { best = w; bestK = k; }
        }
    }
    const q = (arr) => { const [lo, med, hi] = quantiles(arr, S.w, [0.16, 0.5, 0.84]); return { lo, med, hi }; };
    let peak = 0; for (const x of LvMap) if (x > peak) peak = x;
    return {
        scenario, useAngle, options: o,
        diameterKm: q(S.L), speedKms: q(S.v), angleDeg: q(S.th), density: q(S.rho),
        massKg: q(S.mass), energyJ: q(S.energy), fDep: q(S.fDep), craterKm: q(S.crater),
        best: { diameterKm: S.L[bestK], speedKms: S.v[bestK], angleDeg: S.th[bestK], density: S.rho[bestK], fDep: S.fDep[bestK] },
        map: { diameters: Ls, speeds: vs, density: LvMap.map((x) => x / (peak || 1)) },
    };
}

/** The crater's degeneracy curve: the speed (km/s) each diameter needs to dig `craterKm`. */
export function speedForCrater(diameterKm, { craterKm = DEFAULTS.craterKm, angleDeg = 55, density = 2200, targetDensity = 2700 } = {}) {
    let lo = 0.5, hi = 500;
    const D = (v) => finalDiameter(transientDiameter({ diameterM: diameterKm * 1000, speed: v * 1000, angleDeg, density, targetDensity })) / 1000;
    if (D(lo) > craterKm || D(hi) < craterKm) return null;
    for (let i = 0; i < 60; i++) { const mid = Math.sqrt(lo * hi); if (D(mid) < craterKm) lo = mid; else hi = mid; }
    return Math.sqrt(lo * hi);
}

// ── §2 the trajectory, backwards ────────────────────────────────────────────
export const V_EARTH_ORBIT = 29_784.7;        // m/s, circular at 1 au
export const AU_M = 1.495978707e11;
export const MU_SUN = 1.32712440018e20;
export const OBLIQUITY_DEG = 23.44;
export const OMEGA_EARTH = 7.2921159e-5;      // rad/s
export const A_JUPITER_AU = 5.2044;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const add = (a, b, s = 1) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const rotX = (v, ang) => { const c = Math.cos(ang), s = Math.sin(ang); return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]]; };

/**
 * The incoming asymptote of the hyperbola through state (r, v) about a body of
 * parameter mu. Exact two-body: with ê the eccentricity direction and
 * q̂ = ĥ × ê, velocity at true anomaly ν is (μ/h)(−sin ν ê + (e + cos ν) q̂);
 * the incoming asymptote is ν → −ν∞ with cos ν∞ = −1/e.
 * Returns { vInf: [x,y,z], speed, bendDeg } or null if the state is bound.
 */
export function incomingAsymptote(r, v, mu = MU_EARTH) {
    const rn = norm(r), v2 = dot(v, v);
    const vinf2 = v2 - 2 * mu / rn;
    if (!(vinf2 > 0)) return null;
    const h = cross(r, v), hn = norm(h);
    // A purely radial arrival has no angular momentum: the path is a straight
    // line through the centre and is not bent at all.
    if (hn < 1e-9 * rn * Math.sqrt(v2)) {
        const s = Math.sqrt(vinf2 / v2);
        return { vInf: scale(v, s), speed: Math.sqrt(vinf2), bendDeg: 0, eccentricity: 1 };
    }
    const ev = add(scale(r, (v2 - mu / rn) / mu), v, -dot(r, v) / mu);
    const e = norm(ev);
    const eh = scale(ev, 1 / e), qh = cross(scale(h, 1 / hn), eh);
    const sinNu = Math.sqrt(1 - 1 / (e * e));
    const vInf = add(scale(eh, mu / hn * sinNu), qh, mu / hn * (e - 1 / e));
    const speed = norm(vInf);
    const bendDeg = Math.acos(Math.max(-1, Math.min(1, dot(vInf, v) / (speed * Math.sqrt(v2))))) / RAD;
    return { vInf, speed, bendDeg, eccentricity: e };
}

/** Heliocentric elements from a state in the ECLIPTIC frame (m, m/s). */
export function heliocentricElements(r, v) {
    const rn = norm(r), v2 = dot(v, v);
    const energy = v2 / 2 - MU_SUN / rn;
    const h = cross(r, v), hn = norm(h);
    const ev = add(scale(r, (v2 - MU_SUN / rn) / MU_SUN), v, -dot(r, v) / MU_SUN);
    const e = norm(ev), incDeg = Math.acos(h[2] / hn) / RAD;
    // true anomaly at this point: before perihelion (inbound) is negative
    const nuDeg = Math.sign(dot(r, v) || 1) * Math.acos(Math.max(-1, Math.min(1, dot(ev, r) / (e * rn || 1)))) / RAD;
    if (energy >= 0) return { bound: false, e, incDeg, nuDeg, qAu: hn * hn / MU_SUN / (1 + e) / AU_M, aAu: null, QAu: null, tisserand: null, vHelioKms: Math.sqrt(v2) / 1000 };
    const a = -MU_SUN / (2 * energy) / AU_M;
    const tisserand = A_JUPITER_AU / a + 2 * Math.cos(incDeg * RAD) * Math.sqrt(a / A_JUPITER_AU * (1 - e * e));
    return { bound: true, aAu: a, e, incDeg, nuDeg, qAu: a * (1 - e), QAu: a * (1 + e), tisserand, vHelioKms: Math.sqrt(v2) / 1000 };
}

/** A name for the orbit. Thresholds are the usual Tisserand classes. */
export function classifyOrbit(el) {
    if (!el.bound) return 'unbound';
    if (el.incDeg > 90) return 'retrograde';
    if (el.tisserand < 2) return 'long-period-like';
    if (el.tisserand < 3) return 'jupiter-family-like';
    return 'asteroidal';
}
export const ORBIT_CLASSES = Object.freeze(['asteroidal', 'jupiter-family-like', 'long-period-like', 'retrograde', 'unbound']);

/**
 * One backward trajectory.
 *   speedKms       speed at the ground
 *   angleDeg       angle to the horizontal
 *   fromAzimuthDeg compass bearing the impactor came FROM (45 = from the NE)
 *   latDeg         site latitude
 *   localHour      local solar time at the site (0–24) — the unknown
 *   sunLonDeg      the Sun's ecliptic longitude: 0 March equinox, 90 June solstice
 */
export function backtrack({ speedKms, angleDeg, fromAzimuthDeg = 45, latDeg, localHour, sunLonDeg = 30, obliquityDeg = OBLIQUITY_DEG, spin = true }) {
    const v = speedKms * 1000, th = angleDeg * RAD, az = fromAzimuthDeg * RAD, phi = latDeg * RAD, eps = obliquityDeg * RAD;
    // local velocity, east/north/up: travelling AWAY from the bearing it came from, and down
    const vE = -v * Math.cos(th) * Math.sin(az), vN = -v * Math.cos(th) * Math.cos(az), vU = -v * Math.sin(th);
    // the Sun in equatorial coordinates, then the site's right ascension from the local time
    const sunEcl = [Math.cos(sunLonDeg * RAD), Math.sin(sunLonDeg * RAD), 0];
    const sunEq = rotX(sunEcl, eps);
    const alpha = Math.atan2(sunEq[1], sunEq[0]) + (localHour - 12) * 15 * RAD;
    const up = [Math.cos(phi) * Math.cos(alpha), Math.cos(phi) * Math.sin(alpha), Math.sin(phi)];
    const east = [-Math.sin(alpha), Math.cos(alpha), 0];
    const north = [-Math.sin(phi) * Math.cos(alpha), -Math.sin(phi) * Math.sin(alpha), Math.cos(phi)];
    const r0 = scale(up, R_EARTH);
    let v0 = add(add(scale(east, vE), north, vN), up, vU);
    if (spin) v0 = add(v0, east, OMEGA_EARTH * R_EARTH * Math.cos(phi));
    const asym = incomingAsymptote(r0, v0);
    if (!asym) return { bound: true, geocentric: null, orbit: null, cls: 'captured' };
    const vInfEcl = rotX(asym.vInf, -eps);
    // the radiant: where in the sky it came FROM
    const from = scale(vInfEcl, -1 / asym.speed);
    const radiant = { eclLonDeg: (Math.atan2(from[1], from[0]) / RAD + 360) % 360, eclLatDeg: Math.asin(from[2]) / RAD,
                      decDeg: Math.asin(-asym.vInf[2] / asym.speed) / RAD };
    const rEarth = scale(sunEcl, -AU_M);
    const vEarth = [V_EARTH_ORBIT * Math.sin(sunLonDeg * RAD), -V_EARTH_ORBIT * Math.cos(sunLonDeg * RAD), 0];
    const orbit = heliocentricElements(rEarth, add(vEarth, vInfEcl));
    // angle between where it came from and the Sun (0 = out of the Sun, 180 = from the night side)
    const elongationDeg = Math.acos(Math.max(-1, Math.min(1, dot(from, sunEcl)))) / RAD;
    return { geocentric: { vInfKms: asym.speed / 1000, bendDeg: asym.bendDeg }, radiant, elongationDeg, orbit, cls: classifyOrbit(orbit) };
}

/**
 * The family: one orbit per local hour, and how the classes split when the
 * unknowns (speed, angle, bearing, season) are spread over their ranges.
 */
export function orbitFamily({ latDeg, speedKms = 20, angleDeg = 55, fromAzimuthDeg = 45, sunLonDeg = 30, hours = 96 } = {}) {
    const rows = [];
    for (let i = 0; i < hours; i++) {
        const localHour = i * 24 / hours;
        rows.push({ localHour, ...backtrack({ speedKms, angleDeg, fromAzimuthDeg, latDeg, localHour, sunLonDeg }) });
    }
    const share = Object.fromEntries(ORBIT_CLASSES.map((c) => [c, rows.filter((r) => r.cls === c).length / rows.length]));
    return { rows, share };
}

/** Class of orbit over (local hour × impact speed) — the page's map. */
export function orbitMap({ latDeg, angleDeg = 55, fromAzimuthDeg = 45, sunLonDeg = 30, hours = 48, speeds = [12, 14, 16, 18, 20, 22, 25, 30, 40, 55, 70] } = {}) {
    return speeds.map((speedKms) => ({
        speedKms,
        cells: Array.from({ length: hours }, (_, i) => {
            const b = backtrack({ speedKms, angleDeg, fromAzimuthDeg, latDeg, localHour: i * 24 / hours, sunLonDeg });
            return { localHour: i * 24 / hours, cls: b.cls, incDeg: b.orbit?.incDeg ?? null, aAu: b.orbit?.aAu ?? null, QAu: b.orbit?.QAu ?? null };
        }),
    }));
}

/**
 * Which local hours allow a main-belt-like orbit, with the trajectory's own
 * uncertainties spread out (angle 45–60°, bearing ±30°, speed from the
 * impactor posterior, season across boreal spring). A deterministic grid.
 * "Main-belt-like" = asteroidal class, aphelion between 1.8 and 4.5 au,
 * inclination under 35° — the delivered-from-the-belt population.
 */
export function hourConstraint({ latDeg, speeds, speedWeights, angles = [45, 50, 55, 60], azimuths = [15, 30, 45, 60, 75], sunLons = [0, 30, 60, 90], hours = 48 } = {}) {
    const beltLike = new Float64Array(hours), any = new Float64Array(hours);
    for (let s = 0; s < speeds.length; s++) for (const angleDeg of angles) for (const fromAzimuthDeg of azimuths) for (const sunLonDeg of sunLons) {
        const w = (speedWeights?.[s] ?? 1) * angleDensity(angleDeg);
        for (let i = 0; i < hours; i++) {
            const b = backtrack({ speedKms: speeds[s], angleDeg, fromAzimuthDeg, latDeg, localHour: i * 24 / hours, sunLonDeg });
            any[i] += w;
            const o = b.orbit;
            if (b.cls === 'asteroidal' && o.QAu > 1.8 && o.QAu < 4.5 && o.incDeg < 35) beltLike[i] += w;
        }
    }
    const frac = Array.from(beltLike, (x, i) => x / any[i]);
    const overall = beltLike.reduce((a, b) => a + b, 0) / any.reduce((a, b) => a + b, 0);
    let bestI = 0; frac.forEach((f, i) => { if (f > frac[bestI]) bestI = i; });
    return { hours: Array.from({ length: hours }, (_, i) => i * 24 / hours), fraction: frac, overall, bestHour: bestI * 24 / hours };
}
