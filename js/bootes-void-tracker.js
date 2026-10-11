/**
 * bootes-void-tracker.js — the void's galaxies through cosmic time
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no fetch, no ambient time, no three.js. Every number the
 * galaxy tracker on bootes-void.html draws is computed here, and
 * `node tests/bootes-void-tracker.mjs` pins each relation as an identity.
 *
 * WHAT IS BEING TRACKED — read this before calling anything a "star"
 * ─────────────────────────────────────────────────────────────────
 * Boötes sits ~230 Mpc away. At that distance no individual star or nebula is
 * resolved; what surveys catalogue inside the void are its GALAXIES (≈60 above
 * the survey limits — js/bootes-void-data.js), and the H I and emission-line
 * work on them (Szomoru et al. 1996; Cruzen et al. 2002) finds them gas-rich,
 * blue and actively forming stars — their H II regions ARE the void's nebulae.
 * A galaxy carries its stars and its nebulae with it, so following a galaxy is
 * following them. The tracked objects here are the page's MODEL tracer
 * galaxies (synthetic, seeded — js/bootes-web-model.js `sampleTracers`), never
 * catalogued ones; the page says so beside the tracker.
 *
 * THE DYNAMICS — linear theory, run in time
 * ─────────────────────────────────────────
 * The rest of the page evaluates the void at its OBSERVED epoch, z_obs. Linear
 * theory says how every field there scales with time, and the tracker uses
 * exactly those scalings and nothing else:
 *
 *   density       δ(x, t)  = δ_obs(x) · D(t)/D_obs
 *   tidal (4πGρ̄)  T(x, t)  = T_obs(x) · D(t)/D_obs           (the (1+z) cancel)
 *   gravity       g(x, t)  = g_obs(x) · (1+z)² D / [(1+z_obs)² D_obs]
 *                 — comoving Poisson carries (1+z) in Φ and one more from
 *                   ∇_phys = (1+z)∇_com: the SAME two powers as
 *                   js/bootes-void-model.js `gravityRadialSI`
 *   displacement  x(t) = q + (D/D_obs) ψ,  ψ = v_obs / (a H f)|_obs
 *                 — the Zel'dovich approximation: every galaxy moves on a
 *                   STRAIGHT comoving line through its Lagrangian position q
 *   velocity      v(t) = a H f (D/D_obs) ψ              (km/s, peculiar)
 *
 * THE PHYSICAL RESULT IS NOT THE OBVIOUS ONE, and the tracker exists to show
 * it. The void deepens with time (δ ∝ D), the tidal field grows with it, and
 * the outflow speeds up — but the peculiar ACCELERATION in physical units goes
 * as (1+z)²D, which in the matter era is ∝ (1+z): the void pulled HARDER when
 * the universe was young and dense, even though it was shallower then. Dark
 * energy then freezes D, and every curve flattens. `tests/bootes-void-tracker.mjs`
 * pins both limits.
 *
 * WHAT LINEAR THEORY GETS WRONG HERE, stated where it is used
 * ───────────────────────────────────────────────────────────
 *  - At the observed epoch the void's matter contrast reaches ≈ −0.6 at the
 *    centre — past where linear theory is accurate. The page's Test 1 shows
 *    the spherical quasi-linear correction (≈ +9 % at Δ = −0.4); it has no
 *    honest non-spherical form for a clumped field, so it is not applied.
 *    `linearOk` flags samples with |δ| > 0.5.
 *  - Zel'dovich paths are straight lines. They cross where shells would; real
 *    orbits near the wall do not. The flag is the same one.
 *  - The fields are evaluated at the galaxy's displaced position x(t) and then
 *    scaled — first-order consistent, which is the order the whole tracker is.
 *  - The cosmology neglects radiation (as the model kernel does), so t₀ comes
 *    out 13.792 Gyr against Planck's 13.787 (0.04 %); nothing here lives at
 *    z > 100.
 */

import {
    COSMOLOGY, MPC_M, GYR_S, hubbleSI, hubbleKmsMpc, growthFactor, growthRate,
} from './bootes-void-model.js';
import {
    probeAt, accelerationField, velocityPerAcceleration, twebClass, toKmsPerGyr,
    DEFAULT_TWEB_THRESHOLD,
} from './bootes-force-probe.js';

/** km/s → comoving Mpc per Gyr (at a = 1; divide by a for comoving drift). */
export const KMS_TO_MPC_PER_GYR = GYR_S * 1000 / MPC_M;

// ── Cosmic clock ────────────────────────────────────────────────────────────

const timeCache = new Map();

/**
 * Cosmic time at scale factor a, Gyr:  t(a) = ∫₀^a da' / (a' H(a')).
 *
 * Simpson in √a rather than a: with u = √a, da/(aH) = 2 du/(u H), and the
 * matter-era integrand 2/(u H) ∝ u² is smooth at the origin — in `a` it goes
 * as √a, whose infinite slope at 0 costs Simpson three digits.
 * Works for a > 1 (the future) unchanged.
 */
export function cosmicTimeAtA(a, cosmo = COSMOLOGY) {
    if (!(a > 0)) return 0;
    const key = `${a}|${cosmo.H0_kms_Mpc}|${cosmo.omegaM}`;
    if (timeCache.has(key)) return timeCache.get(key);
    const n = 2048;
    const uMax = Math.sqrt(a);
    const du = uMax / n;
    let sum = 0;
    for (let i = 0; i <= n; i++) {
        const u = i * du;
        const w = (i === 0 || i === n) ? 1 : (i % 2 ? 4 : 2);
        if (u === 0) continue;                        // integrand → 0
        const aa = u * u;
        sum += w * 2 / (u * hubbleSI(1 / aa - 1, cosmo));
    }
    const t = sum * du / 3 / GYR_S;
    if (timeCache.size > 5000) timeCache.clear();
    timeCache.set(key, t);
    return t;
}

export const cosmicTimeGyr = (z, cosmo = COSMOLOGY) => cosmicTimeAtA(1 / (1 + z), cosmo);

/** Inverse of cosmicTimeAtA, by bisection in log a. */
export function scaleFactorAtTime(tGyr, cosmo = COSMOLOGY) {
    let lo = Math.log(1e-4);
    let hi = Math.log(20);
    for (let i = 0; i < 80; i++) {
        const mid = 0.5 * (lo + hi);
        if (cosmicTimeAtA(Math.exp(mid), cosmo) < tGyr) lo = mid; else hi = mid;
    }
    return Math.exp(0.5 * (lo + hi));
}

// ── Linear-theory scalings relative to the observed epoch ───────────────────

const growthCache = new Map();
function growth(z, cosmo) {
    const key = `${z}|${cosmo.omegaM}`;
    let v = growthCache.get(key);
    if (v === undefined) {
        v = growthFactor(z, cosmo);
        if (growthCache.size > 5000) growthCache.clear();
        growthCache.set(key, v);
    }
    return v;
}

/**
 * f = dlnD/dlna, EXACT (differentiated from the same growth integral D comes
 * from), not the γ = 0.55 form the rest of the page quotes. The tracker's
 * velocity has to be the time derivative of its own path, and with the γ form
 * it is not: a·dx/dt and the reported speed disagreed by 4e-4 at t = 4 Gyr
 * (caught by the gate). The γ form is 0.4 % off at z_obs and 2 % off by
 * a = 1.4, which is why it is fine for one epoch and wrong for a time axis.
 */
const fCache = new Map();
function fExact(z, cosmo) {
    const key = `${z}|${cosmo.omegaM}`;
    let v = fCache.get(key);
    if (v === undefined) {
        v = growthRate(z, cosmo, { exact: true });
        if (fCache.size > 5000) fCache.clear();
        fCache.set(key, v);
    }
    return v;
}

/**
 * Every factor that carries a field from z_obs to z. All are 1 at z = z_obs.
 *   D         growth ratio D(z)/D(z_obs)           — δ, ψ-displacement, tidal
 *   gravity   (1+z)² D(z) / [(1+z_obs)² D(z_obs)]  — physical peculiar g
 *   velocity  [a H f D](z) / [a H f D](z_obs)       — peculiar velocity
 */
export function epochScalings(z, zObs, cosmo = COSMOLOGY) {
    const D = growth(z, cosmo) / growth(zObs, cosmo);
    const gravity = ((1 + z) * (1 + z) * D) / ((1 + zObs) * (1 + zObs));
    const vel = (a, zz) => a * hubbleKmsMpc(zz, cosmo) * fExact(zz, cosmo);
    const velocity = vel(1 / (1 + z), z) * D / vel(1 / (1 + zObs), zObs);
    return { D, gravity, tidal: D, velocity };
}

/**
 * Zel'dovich displacement ψ (comoving Mpc) from an observed-epoch linear
 * peculiar velocity (km/s):  ψ = v / (a H f)  at z_obs, f exact (above), so
 * the path's own derivative at z_obs returns exactly the velocity passed in.
 */
export function displacementFromVelocity(vKms, zObs, cosmo = COSMOLOGY) {
    const k = 1 / ((1 / (1 + zObs)) * hubbleKmsMpc(zObs, cosmo) * fExact(zObs, cosmo));
    return [vKms[0] * k, vKms[1] * k, vKms[2] * k];
}

/** Comoving position at growth ratio D:  x = x_obs + (D − 1) ψ. */
export function positionAt(xObs, psi, D) {
    const s = D - 1;
    return [xObs[0] + s * psi[0], xObs[1] + s * psi[1], xObs[2] + s * psi[2]];
}

/**
 * The time axis: `samples` epochs, uniform in cosmic time, from tStartGyr to
 * tEndGyr, each with its z, a and the scalings above. Built once per page load
 * (the cosmology does not change) and shared by every tracked galaxy, so all
 * tracks are sampled at the SAME instants and a chart crosshair means one
 * moment for every line.
 */
export function buildTimeline({
    zObs, tStartGyr = 1, tEndGyr = null, samples = 140, cosmo = COSMOLOGY,
} = {}) {
    const t0 = cosmicTimeGyr(0, cosmo);
    const tEnd = tEndGyr ?? t0 + 6;
    const tObs = cosmicTimeGyr(zObs, cosmo);
    const out = [];
    for (let i = 0; i < samples; i++) {
        const t = tStartGyr + (tEnd - tStartGyr) * i / (samples - 1);
        const a = scaleFactorAtTime(t, cosmo);
        const z = 1 / a - 1;
        out.push({ tGyr: t, a, z, ...epochScalings(z, zObs, cosmo) });
    }
    return { epochs: out, t0Gyr: t0, tObsGyr: tObs, zObs, tStartGyr, tEndGyr: tEnd };
}

/** One epoch at an arbitrary time (for the scrubber, between samples). */
export function epochAt(tGyr, zObs, cosmo = COSMOLOGY) {
    const a = scaleFactorAtTime(tGyr, cosmo);
    const z = 1 / a - 1;
    return { tGyr, a, z, ...epochScalings(z, zObs, cosmo) };
}

// ── Tracking ────────────────────────────────────────────────────────────────

/**
 * Follow one galaxy, observed at comoving `xObs` (Mpc from the void centre),
 * across the timeline.
 *
 * Its displacement ψ comes from the probe's LINEAR total velocity at xObs (the
 * void plus the clumped web, model A), so a tracked galaxy and the force probe
 * placed on it agree at z_obs exactly — the test asserts it. At each epoch the
 * probe is evaluated at the displaced position and its fields are scaled.
 */
export function trackGalaxy(xObs, {
    voidProfile, web, zObs, timeline, cosmo = COSMOLOGY,
    twebThreshold = DEFAULT_TWEB_THRESHOLD,
} = {}) {
    const opts = { voidProfile, web, z: zObs, cosmo, topN: 0, twebThreshold };
    const here = probeAt(xObs, opts);
    const psi = displacementFromVelocity(here.velocity.A.vector, zObs, cosmo);
    const vObs = here.velocity.A.vector;
    const samples = timeline.epochs.map(ep => sampleAt(ep, xObs, psi, vObs, opts));
    return {
        xObs: [...xObs], psi, vObsKms: vObs,
        lagrangianMpc: positionAt(xObs, psi, 0),
        samples,
        at: (ep) => sampleAt(ep, xObs, psi, vObs, opts),
    };
}

function sampleAt(ep, xObs, psi, vObs, opts) {
    const pos = positionAt(xObs, psi, ep.D);
    const pr = probeAt(pos, opts);
    const g = ep.gravity;
    const values = pr.tidal.axes.map(a => a.lambda * ep.tidal);
    const v = [vObs[0] * ep.velocity, vObs[1] * ep.velocity, vObs[2] * ep.velocity];
    const r = pr.rMpc;
    const vRad = r > 1e-9 ? (v[0] * pos[0] + v[1] * pos[1] + v[2] * pos[2]) / r : 0;
    const delta = pr.deltaLocal * ep.D;
    return {
        tGyr: ep.tGyr, z: ep.z,
        positionMpc: pos,
        rMpc: r,
        gA: toKmsPerGyr(pr.forces.A.magnitude) * g,
        gVoid: toKmsPerGyr(pr.forces.void.magnitude) * g,
        gWeb: toKmsPerGyr(pr.forces.web.magnitude) * g,
        gRadial: toKmsPerGyr(pr.forces.A.radial) * g,
        voidShare: pr.voidShare,
        vKms: Math.hypot(v[0], v[1], v[2]),
        vRadialKms: vRad,
        delta,
        tidal: values,
        tweb: twebClass(values, opts.twebThreshold),
        linearOk: Math.abs(delta) <= 0.5,
    };
}

/**
 * ψ for many points at once (the stage's whole tracer field + the web nodes),
 * from the total acceleration field directly — cheaper than a probe per point
 * and the same quantity: ψ = v_lin / (aHf), v_lin = 2fg/(3ΩmH).
 * Returns a Float64Array of 3·n.
 */
export function displacementField(points, { voidProfile, web, zObs, cosmo = COSMOLOGY }) {
    const field = accelerationField({ voidProfile, web, z: zObs, cosmo });
    const vk = velocityPerAcceleration(zObs, cosmo) / 1000;
    const k = vk / ((1 / (1 + zObs)) * hubbleKmsMpc(zObs, cosmo) * fExact(zObs, cosmo));
    const out = new Float64Array(points.length * 3);
    points.forEach((p, i) => {
        const g = field(p);
        out[i * 3] = g[0] * k; out[i * 3 + 1] = g[1] * k; out[i * 3 + 2] = g[2] * k;
    });
    return out;
}

/** Positions of many points at growth ratio D, into `out` (Float32Array, Mpc). */
export function displacedPositions(points, psi, D, out = new Float32Array(points.length * 3)) {
    const s = D - 1;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        out[i * 3] = p[0] + s * psi[i * 3];
        out[i * 3 + 1] = p[1] + s * psi[i * 3 + 1];
        out[i * 3 + 2] = p[2] + s * psi[i * 3 + 2];
    }
    return out;
}
