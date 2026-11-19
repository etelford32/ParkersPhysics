/**
 * prem.js — the Preliminary Reference Earth Model as a pure, testable kernel.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no fetch, no ambient time. Gate:
 * `tests/earth-interior-prem.mjs`. Plan: `INNER_EARTH_PLAN.md`.
 *
 * ── WHAT THIS IS, HONESTLY ───────────────────────────────────────────────
 * Dziewonski & Anderson (1981), PEPI 25:297, Table 1, ISOTROPIC version:
 * density, Vp, Vs and the two quality factors as piecewise polynomials in
 * x = r / a (a = 6371 km), evaluated exactly. PREM is a ONE-DIMENSIONAL
 * REFERENCE: a spherical average fitted to normal modes and travel times. It
 * has no lateral structure at all: no slabs, no plumes, no continents. Every
 * consumer that draws it must say "reference model". Lateral structure comes
 * from CRUST1.0 / Slab2 / tomography, layered ON TOP of this through
 * `column.js`, never by editing these coefficients.
 *
 * Two choices are explicit options rather than silent defaults:
 *   • `ocean` (default true): DA81's 3 km global ocean (6368–6371 km). The
 *     ObsPy/TauP table used as the gate's oracle omits it and runs the upper
 *     crust to the surface; `ocean:false` reproduces that variant.
 *   • `side` at a discontinuity ('below' default | 'above'). A first-order
 *     jump has two values; picking one silently is how a 2-km/s error gets
 *     into a ray tracer.
 *
 * DA81's 24.4–220 km region is transversely ANISOTROPIC. The values here are
 * DA81's own isotropic equivalent (the same values TauP's prem.nd carries).
 * Anything that needs Vsh ≠ Vsv must add the anisotropic table, not
 * reinterpret this one.
 *
 * Integrals (mass, moment of inertia, gravity, pressure) are Gauss–Legendre
 * per region. The integrands are polynomials of degree ≤ 9 in r inside a
 * region, so 5-point GL is EXACT; there is no step-size tuning to drift.
 */

export const R_EARTH_KM = 6371;
export const G_NEWTON = 6.6743e-11;                 // CODATA 2018
/** GM⊕ (IERS 2010, incl. atmosphere) / G — the mass PREM must reproduce. */
export const EARTH_MASS_MEASURED_KG = 3.986004418e14 / G_NEWTON;
/** Observed mean moment-of-inertia factor C̄/(M a²) — the second integral. */
export const MOI_MEASURED = 0.3307;

// Coefficients in powers of x: [c0, c1, c2, c3]. ρ g/cm³, V km/s.
const r = (name, rInnerKm, rOuterKm, rho, vp, vs, qMu, qKappa, state) =>
    Object.freeze({ name, rInnerKm, rOuterKm, rho, vp, vs, qMu, qKappa, state });

/** The 13 regions, centre → surface (DA81 Table 1, isotropic). */
export const PREM_REGIONS = Object.freeze([
    r('Inner core',      0,      1221.5, [13.0885, 0, -8.8381],                [11.2622, 0, -6.3640],                   [3.6678, 0, -4.4475],                  84.6, 1327.7, 'solid'),
    r('Outer core',      1221.5, 3480,   [12.5815, -1.2638, -3.6426, -5.5281], [11.0487, -4.0362, 4.8023, -13.5732],    [0],                                    Infinity, 57823, 'fluid'),
    r('D″',              3480,   3630,   [7.9565, -6.4761, 5.5283, -3.0807],   [15.3891, -5.3181, 5.5242, -2.5514],     [6.9254, 1.4672, -2.0834, 0.9783],     312, 57823, 'solid'),
    r('Lower mantle',    3630,   5600,   [7.9565, -6.4761, 5.5283, -3.0807],   [24.9520, -40.4673, 51.4832, -26.6419],  [11.1671, -13.7818, 17.4575, -9.2777], 312, 57823, 'solid'),
    r('Top lower mantle',5600,   5701,   [7.9565, -6.4761, 5.5283, -3.0807],   [29.2766, -23.6027, 5.5242, -2.5514],    [22.3459, -17.2473, -2.0834, 0.9783],  312, 57823, 'solid'),
    r('Transition zone 670–600', 5701, 5771, [5.3197, -1.4836],               [19.0957, -9.8672],                      [9.9839, -4.9324],                      143, 57823, 'solid'),
    r('Transition zone 600–400', 5771, 5971, [11.2494, -8.0298],              [39.7027, -32.6166],                     [22.3512, -18.5856],                    143, 57823, 'solid'),
    r('Transition zone 400–220', 5971, 6151, [7.1089, -3.8045],               [20.3926, -12.2569],                     [8.9496, -4.4597],                      143, 57823, 'solid'),
    r('Low-velocity zone', 6151, 6291,   [2.6910, 0.6924],                     [4.1875, 3.9382],                        [2.1519, 2.3481],                       80, 57823, 'solid'),
    r('Lid',             6291,   6346.6, [2.6910, 0.6924],                     [4.1875, 3.9382],                        [2.1519, 2.3481],                       600, 57823, 'solid'),
    r('Lower crust',     6346.6, 6356,   [2.900],                              [6.800],                                 [3.900],                                600, 57823, 'solid'),
    r('Upper crust',     6356,   6368,   [2.600],                              [5.800],                                 [3.200],                                600, 57823, 'solid'),
    r('Ocean',           6368,   6371,   [1.020],                              [1.450],                                 [0],                                    0, 57823, 'fluid'),
]);

/** Depths (km) of every region boundary, surface first. */
export const BOUNDARY_DEPTHS_KM = Object.freeze(
    PREM_REGIONS.slice(1).map((g) => +(R_EARTH_KM - g.rInnerKm).toFixed(3)).reverse());

const poly = (c, x) => { let s = 0; for (let i = c.length - 1; i >= 0; i--) s = s * x + c[i]; return s; };

function regionsFor(ocean) {
    if (ocean) return PREM_REGIONS;
    // TauP variant: the upper crust continues to the surface.
    const out = PREM_REGIONS.slice(0, -1).map((g) => g);
    const uc = out[out.length - 1];
    out[out.length - 1] = Object.freeze({ ...uc, rOuterKm: R_EARTH_KM });
    return Object.freeze(out);
}
const REGIONS_OCEAN = PREM_REGIONS;
const REGIONS_DRY = regionsFor(false);

/** Index of the region holding r. At a boundary, `side` picks which. */
export function regionIndex(rKm, { ocean = true, side = 'below' } = {}) {
    const R = ocean ? REGIONS_OCEAN : REGIONS_DRY;
    if (!(rKm >= 0 && rKm <= R_EARTH_KM)) return -1;
    for (let i = 0; i < R.length; i++) {
        const g = R[i];
        if (side === 'above' ? (rKm >= g.rInnerKm && rKm < g.rOuterKm) : (rKm > g.rInnerKm && rKm <= g.rOuterKm)) return i;
    }
    return side === 'above' ? R.length - 1 : 0;   // r = a (above) or r = 0 (below)
}

/**
 * PREM at radius r (km). Returns SI-adjacent units: ρ kg/m³, Vp/Vs km/s,
 * μ and K in GPa. Out of range → null (never a clamped value).
 */
export function premAt(rKm, opts = {}) {
    const ocean = opts.ocean ?? true;
    const i = regionIndex(rKm, { ocean, side: opts.side ?? 'below' });
    if (i < 0) return null;
    const g = (ocean ? REGIONS_OCEAN : REGIONS_DRY)[i];
    const x = rKm / R_EARTH_KM;
    const rho = poly(g.rho, x) * 1000;
    const vp = poly(g.vp, x), vs = poly(g.vs, x);
    const muGPa = rho * (vs * 1e3) ** 2 / 1e9;
    const kGPa = rho * ((vp * 1e3) ** 2 - (4 / 3) * (vs * 1e3) ** 2) / 1e9;
    return { rKm, depthKm: R_EARTH_KM - rKm, region: g.name, regionIndex: i, state: g.state,
             rhoKgM3: rho, vpKmS: vp, vsKmS: vs, qMu: g.qMu, qKappa: g.qKappa, muGPa, kGPa };
}

// ── Exact integration ───────────────────────────────────────────────────────
const GL_X = [-0.9061798459386640, -0.5384693101056831, 0, 0.5384693101056831, 0.9061798459386640];
const GL_W = [0.2369268850561891, 0.4786286704993665, 0.5688888888888889, 0.4786286704993665, 0.2369268850561891];

/** ∫_{a}^{b} f(r) dr inside ONE region (f polynomial ⇒ exact). r in metres. */
function gl(f, a, b) {
    const h = 0.5 * (b - a), m = 0.5 * (a + b);
    let s = 0;
    for (let k = 0; k < 5; k++) s += GL_W[k] * f(m + h * GL_X[k]);
    return s * h;
}

/** Density (kg/m³) at r metres inside region g. */
const rhoIn = (g, rM) => poly(g.rho, rM / (R_EARTH_KM * 1e3)) * 1000;

/** Cumulative M, I and p on 5-km nodes; every sub-interval integrated exactly. */
function buildProfile(ocean, stepKm = 5) {
    const R = ocean ? REGIONS_OCEAN : REGIONS_DRY;
    const rKm = [0], massKg = [0], momentKgM2 = [0];
    let M = 0, I = 0;
    for (const g of R) {
        const n = Math.max(1, Math.ceil((g.rOuterKm - g.rInnerKm) / stepKm));
        for (let j = 1; j <= n; j++) {
            const aM = (g.rInnerKm + (j - 1) * (g.rOuterKm - g.rInnerKm) / n) * 1e3;
            const bM = (g.rInnerKm + j * (g.rOuterKm - g.rInnerKm) / n) * 1e3;
            M += gl((s) => 4 * Math.PI * rhoIn(g, s) * s * s, aM, bM);
            I += gl((s) => (8 * Math.PI / 3) * rhoIn(g, s) * s ** 4, aM, bM);
            rKm.push(bM / 1e3); massKg.push(M); momentKgM2.push(I);
        }
    }
    // Pressure: p(a) = 0, dp/dr = −ρ g. Inside a sub-interval M(s) is a
    // polynomial too (M(a) + ∫ρ 4πr²), so a nested GL keeps it exact.
    const N = rKm.length;
    const pPa = new Float64Array(N);
    let segRegion = [];
    for (const g of R) {
        const n = Math.max(1, Math.ceil((g.rOuterKm - g.rInnerKm) / stepKm));
        for (let j = 0; j < n; j++) segRegion.push(g);
    }
    for (let k = N - 2; k >= 0; k--) {
        const g = segRegion[k];
        const aM = rKm[k] * 1e3, bM = rKm[k + 1] * 1e3, Ma = massKg[k];
        const dp = gl((s) => {
            const Ms = Ma + gl((t) => 4 * Math.PI * rhoIn(g, t) * t * t, aM, s);
            return s > 0 ? rhoIn(g, s) * G_NEWTON * Ms / (s * s) : 0;
        }, aM, bM);
        pPa[k] = pPa[k + 1] + dp;
    }
    return { rKm: Float64Array.from(rKm), massKg: Float64Array.from(massKg),
             momentKgM2: Float64Array.from(momentKgM2), pPa };
}

const PROFILE = { true: buildProfile(true), false: buildProfile(false) };

function sample(tab, key, rKm) {
    const r = tab.rKm, v = tab[key];
    if (!(rKm >= 0 && rKm <= R_EARTH_KM)) return NaN;
    let lo = 0, hi = r.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r[m] <= rKm) lo = m; else hi = m; }
    const t = r[hi] === r[lo] ? 0 : (rKm - r[lo]) / (r[hi] - r[lo]);
    return v[lo] + (v[hi] - v[lo]) * t;
}

/** Total mass (kg). Exact. */
export const premMassKg = ({ ocean = true } = {}) => {
    const t = PROFILE[ocean]; return t.massKg[t.massKg.length - 1];
};

/** C̄/(M a²). Exact. */
export function momentOfInertiaFactor({ ocean = true } = {}) {
    const t = PROFILE[ocean], n = t.massKg.length - 1;
    return t.momentKgM2[n] / (t.massKg[n] * (R_EARTH_KM * 1e3) ** 2);
}

/** Enclosed mass M(r), kg. Exact at the 5-km nodes, linear between them. */
export const enclosedMassKg = (rKm, { ocean = true } = {}) => sample(PROFILE[ocean], 'massKg', rKm);

/** Gravity g(r) = G M(r) / r², m/s². */
export function gravityMS2(rKm, opts = {}) {
    if (rKm === 0) return 0;
    const M = enclosedMassKg(rKm, opts);
    return G_NEWTON * M / (rKm * 1e3) ** 2;
}

/** Hydrostatic pressure, GPa (p = 0 at the surface). */
export const pressureGPa = (rKm, { ocean = true } = {}) => sample(PROFILE[ocean], 'pPa', rKm) / 1e9;

/**
 * What counts as a JUMP. DA81 prints its coefficients to 4 decimals, so the
 * SECOND-order boundaries (600, 771, 2741 km: the polynomial changes, the
 * value does not) mismatch by up to 1.4×10⁻⁴ km/s, which is rounding, not
 * structure (measured; the gate pins it). The smallest real jump (CMB to 15 km)
 * is ≥ 76 kg/m³ and ≥ 0.16 km/s, so these thresholds sit three decades
 * clear of both.
 */
export const JUMP_RHO_KGM3 = 1;
export const JUMP_V_KMS = 1e-3;

/** Every region boundary: depth, first-order or not, and the values on both sides. */
export function discontinuities({ ocean = true } = {}) {
    const R = ocean ? REGIONS_OCEAN : REGIONS_DRY;
    const out = [];
    for (let i = 1; i < R.length; i++) {
        const rb = R[i].rInnerKm;
        const below = premAt(rb, { ocean, side: 'below' }), above = premAt(rb, { ocean, side: 'above' });
        const jump = Math.abs(above.rhoKgM3 - below.rhoKgM3) > JUMP_RHO_KGM3
                  || Math.abs(above.vpKmS - below.vpKmS) > JUMP_V_KMS
                  || Math.abs(above.vsKmS - below.vsKmS) > JUMP_V_KMS;
        out.push({ rKm: rb, depthKm: +(R_EARTH_KM - rb).toFixed(3), between: [R[i - 1].name, R[i].name], firstOrder: jump, below, above });
    }
    return out;
}

/** Whole-column profile for the probe / charts (pure numbers). */
export function profileAt(rKm, opts = {}) {
    const p = premAt(rKm, opts);
    if (!p) return null;
    return { ...p, gravityMS2: gravityMS2(rKm, opts), pressureGPa: pressureGPa(rKm, opts),
             enclosedMassKg: enclosedMassKg(rKm, opts) };
}
