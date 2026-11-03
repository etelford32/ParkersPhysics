/**
 * earth-moon-gravity.js — PURE kernel for the Earth–Moon gravitational environment
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no three.js, no ambient time. neo-watch.html's Earth–Moon
 * layer (stage), its gravity profile chart and the selected object's location
 * analysis all read THIS file and compute nothing of their own.
 *
 * Gate: `node tests/earth-moon-gravity.mjs` after ANY edit (and the
 * neo-watch browser gate, which checks the stage draws these numbers).
 *
 * ── What it adds to js/neo-space.js ───────────────────────────────────────
 * neo-space.js §5b answers "how far does EARTH's gravity reach against the
 * SUN" (Hill sphere, SOI). It treats the Moon as a ruler. This file puts the
 * Moon's gravity in:
 *
 *   1. THE ACCELERATION BUDGET at any geocentric point — Earth's central pull,
 *      the Moon's PERTURBATION and the Sun's TIDE, each as felt in Earth's
 *      (accelerating) frame. That is the honest set to compare: Earth itself
 *      falls toward the Moon and the Sun, so what moves an object RELATIVE TO
 *      EARTH is the DIFFERENCE between their pull on it and on Earth (the
 *      "indirect" term). Comparing raw μ/r² for the Sun instead would say the
 *      Sun dominates at the ISS, which is true and irrelevant.
 *   2. THE CIRCULAR RESTRICTED THREE-BODY PROBLEM (CR3BP) of the Earth–Moon
 *      pair: the five Lagrange points, their Jacobi constants, the
 *      zero-velocity curves those constants bound, and an object's own Jacobi
 *      constant — which says which "gates" (L1 into the Moon's region, L2 out
 *      of the system, L3, L4/L5) are energetically open to it at all.
 *   3. THE SUN–EARTH L1/L2 points, from the SAME collinear solver with the
 *      Sun–(Earth+Moon) mass parameter. They sit ~1.5 million km out, right on
 *      the Hill sphere neo-space.js already draws — which is not a coincidence:
 *      r_H = a(m/3M)^⅓ IS the leading-order L1/L2 distance, and the gate pins
 *      the agreement.
 *
 * ── THE CR3BP IS AN IDEALISATION, AND EVERY CONSUMER SAYS SO ─────────────
 * Its two assumptions, and what each is worth here:
 *
 *   • A CIRCULAR Earth–Moon orbit. The real one has e ≈ 0.055 (perigee and
 *     apogee differ by 13 %, which the page already draws). `earthMoonFrame`
 *     therefore uses the INSTANTANEOUS separation D and the INSTANTANEOUS
 *     angular rate ω = |r×v|/r² — the "pulsating" frame — so the Lagrange points
 *     ride the real Moon rather than a mean circle. The Moon's radial velocity
 *     (±0.05 km/s against ~1 km/s orbital) is the term dropped; a Jacobi
 *     constant is therefore conserved only approximately in reality.
 *   • NO SUN. Jacobi's integral exists only for two primaries. It is a useful
 *     statement well inside Earth's Hill sphere and none at all outside it,
 *     where the Sun's tide exceeds Earth's own pull (section 1 shows exactly
 *     that crossing). `locationAnalysis` returns `jacobiMeaningful: false`
 *     beyond the Hill radius and the card refuses to read gates from it there.
 *
 * ── UNITS AND FRAMES ──────────────────────────────────────────────────────
 * Inputs are geocentric ecliptic J2000 vectors in km and km/s — the frame
 * neo-space.js puts every object, the Moon and the Sun in. The CR3BP is
 * NON-DIMENSIONAL: length D (the live Earth–Moon distance), time 1/ω,
 * barycentre at the origin, Earth at x = −μ, Moon at x = 1 − μ. The
 * conversion is in exactly two functions (`toRotating`, `rotatingToGeoKm`).
 *
 * ── THE ONE SHADER MIRROR ─────────────────────────────────────────────────
 * The stage's zero-velocity disc evaluates 2Ω per fragment. Its GLSL is
 * `JACOBI_FIELD_GLSL`, written here beside the JS `jacobiField` it mirrors,
 * and `tests/earth-moon-gravity.mjs` TRANSLITERATES the GLSL back to JS and
 * runs it against `jacobiField` — so the two cannot drift. Keep it
 * transliterable: typed `float x =` declarations, sqrt/max only, no arrays.
 */

import {
    MU_EARTH, MU_SUN, EARTH_RADIUS_KM, MOON_RADIUS_KM, AU_KM, LD_KM,
    moonGeoJ2000, earthHelioJ2000, hillRadiusKm,
} from './neo-space.js';

/** GM of the Moon, km³/s² (JPL DE430/DE440 value). */
export const MU_MOON = 4902.800066;
/** GM of the Earth–Moon pair. */
export const MU_EARTH_MOON = MU_EARTH + MU_MOON;
/** CR3BP mass parameter of the Earth–Moon system, μ = m_Moon / (m_Earth + m_Moon). DERIVED. */
export const EM_MU = MU_MOON / MU_EARTH_MOON;
/** CR3BP mass parameter of Sun–(Earth+Moon). DERIVED. */
export const SE_MU = MU_EARTH_MOON / (MU_SUN + MU_EARTH_MOON);

const SEC_PER_DAY = 86_400;
/** Central-difference step for the Moon's velocity, days. Same reasoning as neo-space.js earthVelocityJ2000. */
const MOON_VEL_STEP_DAYS = 0.01;

// ─────────────────────────────────────────────────────────────────────────────
// Small vector helpers (arrays of three numbers)
// ─────────────────────────────────────────────────────────────────────────────
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

// ─────────────────────────────────────────────────────────────────────────────
// 1. The acceleration budget — who actually moves an object relative to Earth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Perturbing acceleration of a third body on a point, AS FELT IN EARTH'S FRAME:
 * its pull on the point minus its pull on Earth. `muKm3s2` is the body's GM,
 * `bodyKm` its geocentric position, `rKm` the point's. km/s².
 *
 * Far from the body this is the TIDE (≈ μ r / d³ × the familiar 2 : −1 pattern);
 * close to the body the direct term wins and it is simply that body's gravity.
 * Returns null on the body's own centre.
 */
export function perturbingAcceleration(muKm3s2, bodyKm, rKm) {
    const d = sub(bodyKm, rKm);
    const dn = norm(d);
    const bn = norm(bodyKm);
    if (!(dn > 0) || !(bn > 0)) return null;
    const direct = scale(d, muKm3s2 / (dn * dn * dn));
    const indirect = scale(bodyKm, -muKm3s2 / (bn * bn * bn));
    return add(direct, indirect);
}

/** Earth's central acceleration at a geocentric point, km/s². */
export function earthAcceleration(rKm) {
    const r = norm(rKm);
    if (!(r > 0)) return null;
    return scale(rKm, -MU_EARTH / (r * r * r));
}

/**
 * The three-term budget at one geocentric point. Every magnitude is km/s².
 *
 *   earth    Earth's own pull
 *   moon     the Moon's perturbation (direct − indirect)
 *   moonDirect  the Moon's raw pull, for the card's "how hard does the Moon pull" line
 *   sun      the Sun's tide
 *   net      |sum of the three vectors| — what the object's geocentric motion feels
 *   dominant 'earth' | 'moon' | 'sun', whichever of the three terms is largest
 *   share    each term's fraction of the sum of magnitudes (for the card's bars)
 */
export function accelerationBudget(rKm, moonKm, sunKm) {
    const aE = earthAcceleration(rKm);
    const aM = perturbingAcceleration(MU_MOON, moonKm, rKm);
    const aS = perturbingAcceleration(MU_SUN, sunKm, rKm);
    if (!aE || !aM || !aS) return null;
    const dm = norm(sub(moonKm, rKm));
    const mag = { earth: norm(aE), moon: norm(aM), sun: norm(aS) };
    const total = mag.earth + mag.moon + mag.sun;
    let dominant = 'earth';
    if (mag.moon > mag[dominant]) dominant = 'moon';
    if (mag.sun > mag[dominant]) dominant = 'sun';
    return {
        earth: mag.earth,
        moon: mag.moon,
        moonDirect: MU_MOON / (dm * dm),
        sun: mag.sun,
        net: norm(add(add(aE, aM), aS)),
        vectors: { earth: aE, moon: aM, sun: aS },
        dominant,
        share: { earth: mag.earth / total, moon: mag.moon / total, sun: mag.sun / total },
    };
}

/** Human labels for `dominant`. */
export const DOMINANT_LABELS = Object.freeze({
    earth: 'Earth’s own pull',
    moon: 'the Moon',
    sun: 'the Sun’s tide',
});

/**
 * Log-spaced samples of the budget along a ray from Earth's centre, for the
 * profile chart. Each term is evaluated along its OWN most telling line:
 *
 *   earth  any direction (it is radial)
 *   moon   along the Earth→Moon line — where the Moon's perturbation is largest
 *   sun    along the Earth→Sun line — where the solar tide is largest (2μ☉r/d³,
 *          twice its value at right angles to the Sun)
 *
 * Samples inside the Moon's own body are null (the Moon is a hole in the
 * curve, not a spike to infinity). Returns { samples, crossings }:
 * `crossings.sunOverEarthKm` is where the solar tide first exceeds Earth's pull
 * (the Hill radius, to first order — gated), `crossings.moonOverEarthKm` where
 * the Moon's perturbation first exceeds Earth's along the Earth–Moon line.
 */
export function gravityProfile({ moonKm, sunKm, minKm = EARTH_RADIUS_KM, maxKm = 0.05 * AU_KM, n = 160 } = {}) {
    const uM = scale(moonKm, 1 / norm(moonKm));
    const uS = scale(sunKm, 1 / norm(sunKm));
    const moonDist = norm(moonKm);
    const samples = [];
    const lmin = Math.log(minKm), lmax = Math.log(maxKm);
    for (let i = 0; i < n; i++) {
        const r = Math.exp(lmin + (lmax - lmin) * (i / (n - 1)));
        const pM = scale(uM, r);
        const pS = scale(uS, r);
        const inMoon = Math.abs(r - moonDist) <= MOON_RADIUS_KM;
        const aM = inMoon ? null : perturbingAcceleration(MU_MOON, moonKm, pM);
        const aS = perturbingAcceleration(MU_SUN, sunKm, pS);
        samples.push({
            rKm: r,
            earth: MU_EARTH / (r * r),
            moon: aM ? norm(aM) : null,
            sun: aS ? norm(aS) : null,
        });
    }
    return { samples, crossings: profileCrossings(samples) };
}

/** First radius (log-interpolated) where `key` exceeds `earth`. */
function firstCrossing(samples, key) {
    for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1], b = samples[i];
        if (a[key] == null || b[key] == null) continue;
        const fa = Math.log(a[key] / a.earth), fb = Math.log(b[key] / b.earth);
        if (fa < 0 && fb >= 0) {
            const t = fa / (fa - fb);
            return Math.exp(Math.log(a.rKm) + t * (Math.log(b.rKm) - Math.log(a.rKm)));
        }
    }
    return null;
}
export function profileCrossings(samples) {
    return {
        sunOverEarthKm: firstCrossing(samples, 'sun'),
        moonOverEarthKm: firstCrossing(samples, 'moon'),
    };
}

/** A readable acceleration: picks the SI prefix so the mantissa is 1–999. */
export function formatAcceleration(kms2) {
    if (!Number.isFinite(kms2)) return '—';
    const ms2 = kms2 * 1000;
    const units = [[1, 'm/s²'], [1e-3, 'mm/s²'], [1e-6, 'µm/s²'], [1e-9, 'nm/s²']];
    for (const [f, u] of units) {
        if (Math.abs(ms2) >= f) {
            const v = ms2 / f;
            return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${u}`;
        }
    }
    return `${(ms2 / 1e-12).toFixed(2)} pm/s²`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The circular restricted three-body problem
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Twice the effective potential, 2Ω, in the rotating PLANE (z = 0):
 *
 *     2Ω = x² + y² + 2(1−μ)/r₁ + 2μ/r₂
 *
 * with r₁, r₂ the distances to the primaries at (−μ, 0) and (1−μ, 0). The Jacobi
 * constant of a particle is C = 2Ω − v², so the curves 2Ω = C are where it would
 * have to stop: ZERO-VELOCITY CURVES, and the region 2Ω < C is forbidden to it.
 * `JACOBI_FIELD_GLSL` below mirrors this line for line.
 */
export function jacobiField(X, Y, mu = EM_MU) {
    const dx1 = X + mu;
    const dx2 = X - 1.0 + mu;
    const r1 = Math.sqrt(dx1 * dx1 + Y * Y);
    const r2 = Math.sqrt(dx2 * dx2 + Y * Y);
    return X * X + Y * Y + 2.0 * (1.0 - mu) / Math.max(r1, 1e-6) + 2.0 * mu / Math.max(r2, 1e-6);
}

/**
 * The shader mirror of `jacobiField`. TRANSLITERATED back to JS and run against
 * it by the gate — change both together, keep the declarations typed.
 */
export const JACOBI_FIELD_GLSL = /* glsl */ `
float emJacobiField(float X, float Y, float mu) {
    float dx1 = X + mu;
    float dx2 = X - 1.0 + mu;
    float r1 = sqrt(dx1 * dx1 + Y * Y);
    float r2 = sqrt(dx2 * dx2 + Y * Y);
    return X * X + Y * Y + 2.0 * (1.0 - mu) / max(r1, 1e-6) + 2.0 * mu / max(r2, 1e-6);
}
`;

/** 2Ω in three dimensions: the z term enters only through r₁ and r₂. */
export function jacobiField3(X, Y, Z, mu = EM_MU) {
    const dx1 = X + mu, dx2 = X - 1 + mu, z2 = Z * Z;
    const r1 = Math.sqrt(dx1 * dx1 + Y * Y + z2);
    const r2 = Math.sqrt(dx2 * dx2 + Y * Y + z2);
    return X * X + Y * Y + 2 * (1 - mu) / r1 + 2 * mu / r2;
}

/** Jacobi constant C = 2Ω − v² of a rotating-frame state (non-dimensional). */
export function jacobiConstant(s, mu = EM_MU) {
    return jacobiField3(s.x, s.y, s.z, mu) - (s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
}

/**
 * The three COLLINEAR equilibria, by Newton on ∂Ω/∂x = 0 along the x-axis:
 *
 *     f(x)  = x − (1−μ)(x+μ)/|x+μ|³ − μ(x−1+μ)/|x−1+μ|³
 *     f'(x) = 1 + 2(1−μ)/|x+μ|³ + 2μ/|x−1+μ|³
 *
 * seeded at the Hill approximation γ = (μ/3)^⅓ for L1/L2 and at −1 − 5μ/12 for
 * L3. f' > 0 everywhere off the primaries, so each segment holds exactly one
 * root and Newton converges in a handful of steps.
 */
export function collinearPoints(mu = EM_MU) {
    const f = (x) => {
        const a = x + mu, b = x - 1 + mu;
        return x - (1 - mu) * a / Math.abs(a) ** 3 - mu * b / Math.abs(b) ** 3;
    };
    const fp = (x) => 1 + 2 * (1 - mu) / Math.abs(x + mu) ** 3 + 2 * mu / Math.abs(x - 1 + mu) ** 3;
    const solve = (x0) => {
        let x = x0;
        for (let i = 0; i < 60; i++) {
            const dx = f(x) / fp(x);
            x -= dx;
            if (Math.abs(dx) < 1e-15) break;
        }
        return x;
    };
    const g = Math.cbrt(mu / 3);
    return {
        L1: solve(1 - mu - g),
        L2: solve(1 - mu + g),
        L3: solve(-1 - 5 * mu / 12),
    };
}

/**
 * All five Lagrange points of a CR3BP with mass parameter μ, in the
 * non-dimensional rotating frame, each with its Jacobi constant C_Li = 2Ω(Li)
 * (a particle AT REST there). Ordered by C, highest first — which is also the
 * order in which the gates open as a particle's energy rises.
 */
const _lpMemo = new Map();
export function lagrangePoints(mu = EM_MU) {
    if (_lpMemo.has(mu)) return _lpMemo.get(mu);
    const c = collinearPoints(mu);
    const s3 = Math.sqrt(3) / 2;
    const pts = [
        { id: 'L1', x: c.L1, y: 0 },
        { id: 'L2', x: c.L2, y: 0 },
        { id: 'L3', x: c.L3, y: 0 },
        { id: 'L4', x: 0.5 - mu, y: s3 },
        { id: 'L5', x: 0.5 - mu, y: -s3 },
    ].map(p => Object.freeze({ ...p, C: jacobiField(p.x, p.y, mu) }));
    const out = Object.freeze(pts);
    _lpMemo.set(mu, out);
    return out;
}

/** What each Earth–Moon Lagrange point IS, for the card. */
export const LAGRANGE_ROLES = Object.freeze({
    L1: 'the gate between Earth’s region and the Moon’s',
    L2: 'the back door out of the Earth–Moon system, behind the Moon',
    L3: 'the far-side door, opposite the Moon',
    L4: 'stable point 60° ahead of the Moon',
    L5: 'stable point 60° behind the Moon',
});

/**
 * Which regions a particle of Jacobi constant C may reach. In the CR3BP the
 * forbidden region shrinks as C falls and opens at each Lagrange point's C in
 * turn: L1 (Earth ↔ Moon), then L2 (out past the Moon), then L3 (out the far
 * side), then L4/L5 (the forbidden region is gone).
 */
export function gateState(C, mu = EM_MU) {
    const byId = Object.fromEntries(lagrangePoints(mu).map(p => [p.id, p.C]));
    const open = {
        L1: C < byId.L1,
        L2: C < byId.L2,
        L3: C < byId.L3,
        L4: C < byId.L4,
    };
    let regime;
    if (!open.L1) regime = 'sealed';
    else if (!open.L2) regime = 'neck';
    else if (!open.L3) regime = 'l2-open';
    else if (!open.L4) regime = 'l3-open';
    else regime = 'open';
    return { open, regime };
}

/**
 * Which REALM a rotating-frame position is in, by the collinear points'
 * geometry: the Moon's realm is closer to the Moon than L1 is (the nearer of
 * its two necks — L2 is 11 % farther out), Earth's realm is closer to Earth
 * than L1 is, everything else is EXTERIOR. Only meaningful
 * together with a gate state: with every gate shut ('sealed') a particle in the
 * exterior realm CANNOT GET IN — a large Jacobi constant far away means "kept
 * out", not "trapped near Earth". That distinction is the first thing a naive
 * reading of C gets wrong.
 */
export function realmOf(x, y, z = 0, mu = EM_MU) {
    const pts = Object.fromEntries(lagrangePoints(mu).map(p => [p.id, p]));
    const r1 = Math.hypot(x + mu, y, z);
    const r2 = Math.hypot(x - 1 + mu, y, z);
    if (r2 <= (1 - mu) - pts.L1.x) return 'moon';
    if (r1 <= pts.L1.x + mu) return 'earth';
    return 'exterior';
}

export const GATE_LABELS = Object.freeze({
    sealed: 'every gate is shut — it cannot leave the realm it is in',
    neck: 'the L1 neck is open: it can pass between Earth and the Moon, but cannot leave the system',
    'l2-open': 'L1 and L2 are open: it can leave the Earth–Moon system behind the Moon',
    'l3-open': 'L1, L2 and L3 are open: only the L4/L5 lobes are still forbidden',
    open: 'every gate is open — no zero-velocity barrier constrains it',
});

/** Hill radius of the Moon against Earth at separation D, km. */
export function moonHillRadiusKm(dKm) {
    return dKm * Math.cbrt(MU_MOON / (3 * MU_EARTH));
}
/** Laplace sphere of influence of the Moon against Earth at separation D, km. */
export function moonSoiRadiusKm(dKm) {
    return dKm * Math.pow(MU_MOON / MU_EARTH, 0.4);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The live Earth–Moon frame
// ─────────────────────────────────────────────────────────────────────────────

/** The Moon's geocentric position (km) and velocity (km/s), ecliptic J2000. */
export function moonState(jd, h = MOON_VEL_STEP_DAYS) {
    const m = moonGeoJ2000(jd);
    const a = moonGeoJ2000(jd - h);
    const b = moonGeoJ2000(jd + h);
    const k = AU_KM / (2 * h * SEC_PER_DAY);
    return {
        posKm: [m.x * AU_KM, m.y * AU_KM, m.z * AU_KM],
        velKms: [(b.x - a.x) * k, (b.y - a.y) * k, (b.z - a.z) * k],
    };
}

/**
 * The instantaneous ("pulsating") rotating frame of the real Earth–Moon pair:
 *
 *   e1   Earth → Moon
 *   e3   the Moon's orbital angular momentum (the orbit normal)
 *   e2   e3 × e1 (the direction the Moon is moving, in the plane)
 *   D    the live separation, km
 *   omega  |r × v| / r², rad/s
 *
 * Built from the page's ONE lunar ephemeris (Meeus ch. 47 via neo-space.js),
 * so a Lagrange point drawn from it cannot disagree with the drawn Moon.
 */
export function earthMoonFrame(jd) {
    const { posKm, velKms } = moonState(jd);
    const D = norm(posKm);
    const e1 = scale(posKm, 1 / D);
    const hv = cross(posKm, velKms);
    const hn = norm(hv);
    const e3 = scale(hv, 1 / hn);
    const e2 = cross(e3, e1);
    return Object.freeze({
        jd, mu: EM_MU, moonKm: posKm, moonVelKms: velKms,
        D, e1, e2, e3, omega: hn / (D * D),
        radialKms: dot(posKm, velKms) / D,
    });
}

/**
 * Geocentric ecliptic J2000 state (km, km/s) → non-dimensional rotating state.
 * Position about the BARYCENTRE (μD along e1 from Earth's centre); velocity is
 * barycentric-inertial minus ω × ρ, in units of Dω.
 */
export function toRotating(frame, rKm, vKms = [0, 0, 0]) {
    const { mu, D, e1, e2, e3, omega, moonKm, moonVelKms } = frame;
    const rho = sub(rKm, scale(moonKm, mu));
    const vb = sub(vKms, scale(moonVelKms, mu));
    const w = scale(e3, omega);
    const vr = sub(vb, cross(w, rho));
    const V = D * omega;
    return {
        x: dot(rho, e1) / D, y: dot(rho, e2) / D, z: dot(rho, e3) / D,
        vx: dot(vr, e1) / V, vy: dot(vr, e2) / V, vz: dot(vr, e3) / V,
    };
}

/** Non-dimensional rotating position → geocentric ecliptic J2000 km. */
export function rotatingToGeoKm(frame, x, y, z = 0) {
    const { mu, D, e1, e2, e3 } = frame;
    const a = (x + mu) * D, b = y * D, c = z * D;
    return [
        e1[0] * a + e2[0] * b + e3[0] * c,
        e1[1] * a + e2[1] * b + e3[1] * c,
        e1[2] * a + e2[2] * b + e3[2] * c,
    ];
}

/**
 * Every Lagrange point the stage draws, in geocentric km, at JD:
 * the five Earth–Moon points in the live frame plus Sun–Earth L1 and L2 along
 * the live Sun line. The Sun–Earth points are placed from Earth's centre; the
 * true secondary is the Earth–Moon BARYCENTRE, 4 670 km away — 0.3 % of their
 * 1.5 million km, invisible on the stage and stated here.
 */
export function lagrangeGeometry(jd, frame = earthMoonFrame(jd)) {
    const em = lagrangePoints(EM_MU).map(p => {
        const geoKm = rotatingToGeoKm(frame, p.x, p.y, 0);
        return Object.freeze({
            id: `EM-${p.id}`, short: p.id, system: 'earth-moon',
            geoKm, distKm: norm(geoKm), C: p.C, role: LAGRANGE_ROLES[p.id],
        });
    });
    const earth = earthHelioJ2000(jd);
    const rAU = Math.hypot(earth.x, earth.y, earth.z);
    const uSun = [-earth.x / rAU, -earth.y / rAU, -earth.z / rAU];
    const se = collinearPoints(SE_MU);
    const rKm = rAU * AU_KM;
    const l1Km = (1 - SE_MU - se.L1) * rKm;
    const l2Km = (se.L2 - (1 - SE_MU)) * rKm;
    const sePts = [
        { id: 'SE-L1', short: 'L1', geoKm: scale(uSun, l1Km), distKm: l1Km,
          role: 'Sun–Earth L1: between Earth and the Sun (SOHO, DSCOVR, the solar-wind monitors)' },
        { id: 'SE-L2', short: 'L2', geoKm: scale(uSun, -l2Km), distKm: l2Km,
          role: 'Sun–Earth L2: behind Earth, away from the Sun (JWST, Gaia)' },
    ].map(p => Object.freeze({ ...p, system: 'sun-earth', C: null }));
    return { frame, earthMoon: em, sunEarth: sePts, all: [...em, ...sePts] };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Where one object sits in all of this
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The selected object's place in the Earth–Moon environment, at one instant.
 *
 *   rKm, vKms   geocentric ecliptic J2000 position (km) and velocity (km/s);
 *               vKms may be null (no velocity → no Jacobi constant, said so)
 *   jd          the instant (frame + Sun are derived from it unless passed)
 *
 * Returns the acceleration budget, distance to the Moon and whether it is
 * inside the Moon's Hill sphere / SOI, the nearest Lagrange point, the Jacobi
 * constant and gate state, and `jacobiMeaningful` — false outside Earth's Hill
 * sphere, where the Sun dominates and the CR3BP says nothing.
 */
export function locationAnalysis({ rKm, vKms = null, jd, frame = null, geometry = null }) {
    const fr = frame || earthMoonFrame(jd);
    const geom = geometry || lagrangeGeometry(jd, fr);
    const earth = earthHelioJ2000(jd);
    const earthRAU = Math.hypot(earth.x, earth.y, earth.z);
    const sunKm = [-earth.x * AU_KM, -earth.y * AU_KM, -earth.z * AU_KM];
    const distKm = norm(rKm);
    const budget = accelerationBudget(rKm, fr.moonKm, sunKm);

    const moonDistKm = norm(sub(rKm, fr.moonKm));
    const moonHillKm = moonHillRadiusKm(fr.D);
    const moonSoiKm = moonSoiRadiusKm(fr.D);

    let nearest = null;
    for (const p of geom.all) {
        const d = norm(sub(rKm, p.geoKm));
        if (!nearest || d < nearest.distKm) nearest = { id: p.id, short: p.short, system: p.system, distKm: d };
    }

    const hillKm = hillRadiusKm(earthRAU);
    const jacobiMeaningful = distKm <= hillKm;
    let jacobi = null, gates = null, rot = null;
    if (vKms && vKms.every(Number.isFinite)) {
        rot = toRotating(fr, rKm, vKms);
        jacobi = jacobiConstant(rot, fr.mu);
        gates = { ...gateState(jacobi, fr.mu), realm: realmOf(rot.x, rot.y, rot.z, fr.mu) };
    }

    return {
        distKm, distLD: distKm / LD_KM,
        budget,
        moonDistKm, moonHillKm, moonSoiKm,
        insideMoonHill: moonDistKm <= moonHillKm,
        insideMoonSoi: moonDistKm <= moonSoiKm,
        nearestLagrange: nearest,
        rotating: rot,
        jacobi, gates,
        jacobiMeaningful,
        earthHillKm: hillKm,
    };
}
