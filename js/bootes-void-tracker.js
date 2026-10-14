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
 * THE DYNAMICS — two modes, and the default is the NONLINEAR one
 * ──────────────────────────────────────────────────────────────
 * mode 'nonlinear' (default, 2026-10-11). The void's SPHERICAL part — the full
 * profile δ⁻ + δ⁺, which is what the enclosed mass of every shell sees — is
 * evolved EXACTLY: each mass shell obeys Newton's shell equation in ΛCDM,
 *
 *     y'' + (2 − (3/2)Ωm(a)) y' = −(Ωm(a)/2)(y⁻² − y),   y = r/q = (1+Δ)^(−1/3)
 *
 * (N = ln a; the Λ terms cancel between the shell and the background — derived
 * in `shellTable`). It is integrated ONCE per page into a table over linear
 * amplitude Δ_L and time, and each galaxy's shell is found by INVERTING the
 * table at z_obs: the profile is the NONLINEAR state we observe, so its linear
 * amplitude is solved for, not assumed. The closed form most papers quote
 * (Bernardeau 1994, ν = 3/2) was MEASURED against this table and is 1 % off at
 * Δ_L = −1 and 6 % off at −5 — the void centre lives in that range, which is
 * why the ODE and not the formula is the kernel. The gate pins the table
 * against the EXACT parametric solution that exists for Ωm = 1.
 *
 * The CLUMPED part — web minus the smooth wall, i.e. what is not spherical —
 * stays linear (Zel'dovich) and rides on top. The two grow on different
 * clocks (y(t) is not linear in D), so a galaxy's path is no longer a
 * straight line — but the bow is SMALL (measured ~6 kpc over ~10 Mpc of
 * travel near the wall), because both clocks are monotone and similar. The
 * gate pins it at > 1 kpc against the linear mode's exactly-zero; the page
 * does not oversell it. Gravity on the shell is
 * Gauss's law with the shell's own NONLINEAR enclosed contrast,
 * g = −(1/2)Ωm H² Δ_NL a r — exact while no shell has crossed it, and
 * `shellCrossed` reports, per sample, when one has (two neighbouring shells
 * swapping order — the event that builds the wall, and where any spherical
 * model stops).
 *
 * At z_obs both modes put the galaxy where it is observed with the force the
 * probe measures there (gated). The VELOCITY differs: nonlinear expansion is
 * faster than linear theory says (the page's Test 1 shows the ~9 % spherical
 * correction at Δ = −0.4; the ODE gives it exactly, without the fit).
 *
 * mode 'linear' — the original, kept as the A/B reference. Linear theory says
 * how every field at z_obs scales with time, and that mode uses exactly those
 * scalings and nothing else:
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
 * WHAT EACH MODE GETS WRONG, stated where it is used
 * ──────────────────────────────────────────────────
 *  - linear: at z_obs the void's matter contrast reaches ≈ −0.6 at the
 *    centre — past where linear theory is accurate. `linearOk` flags samples
 *    with |Δ| > 0.5, and every path is a straight Zel'dovich line.
 *  - nonlinear: exact for the SPHERICAL part until shell crossing; the
 *    clumped (non-spherical) part is still first order, evaluated at the
 *    displaced position and scaled. Not an N-body — the web's own masses do
 *    not respond to the void. Disclosed on the card. The tracker's third mode
 *    removes that for the FUTURE: js/bootes-nbody.js.
 *  - Both: the clumped web's excess mass grows linearly (∝ D) with time.
 *  - The cosmology neglects radiation (as the model kernel does), so t₀ comes
 *    out 13.792 Gyr against Planck's 13.787 (0.04 %); nothing here lives at
 *    z > 100.
 */

import {
    COSMOLOGY, MPC_M, GYR_S, hubbleSI, hubbleKmsMpc, growthFactor, growthRate,
    omegaMatterAt, splitProfile, voidGravityVector, symmetricEigen,
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

// ── The nonlinear spherical shell table ─────────────────────────────────────

/**
 * Integrate the shell equation for a grid of linear amplitudes and tabulate
 * y = r/q and w = dln y/dN against N = ln a.
 *
 * DERIVATION, because the Λ cancellation is the whole trick. A shell of
 * Lagrangian (comoving) radius q encloses M = (4/3)πρ̄₀q³(1+Δ_i)… — to first
 * order the mean mass, which is what the growing-mode start below sets up. Its
 * physical radius R = a q y obeys R̈ = −GM/R² + (Λ/3)R, the background obeys
 * ä = −(4/3)πGρ̄₀/a² + (Λ/3)a. Substituting R = aqy, the (Λ/3) terms cancel
 * exactly and, with N = ln a and dlnH/dN = −(3/2)Ωm(a) (flat, no radiation):
 *
 *     y'' + (2 − (3/2)Ωm) y' = −(Ωm/2)(y⁻² − y)
 *
 * Mass conservation inside the shell gives 1 + Δ_NL = y⁻³. Growing-mode start
 * at a_i = 10⁻³ (Ωm = 1 to 1e-9 there): y = 1 − Δ_i/3, y' = −f_i Δ_i/3 with
 * Δ_i = Δ_L,obs · D(a_i)/D(a_obs).
 *
 * Grid: Δ_L,obs ∈ [lMin, 0] uniform in ln(1 − Δ_L) (dense near 0, where most
 * of the volume is), N uniform from ln aMin to ln aMax. RK4 with `sub` steps
 * per N cell. Bilinear lookup.
 */
export function shellTable({
    zObs, cosmo = COSMOLOGY, aMin = 0.05, aMax = 2.2, nN = 420, nL = 220,
    lMin = -12, sub = 4, aStart = 1e-3,
} = {}) {
    const aObs = 1 / (1 + zObs);
    const Nlo = Math.log(aMin);
    const Nhi = Math.log(aMax);
    const dN = (Nhi - Nlo) / (nN - 1);
    const uMax = Math.log(1 - lMin);
    const Lgrid = new Float64Array(nL);
    for (let i = 0; i < nL; i++) Lgrid[i] = 1 - Math.exp(uMax * i / (nL - 1));   // 0 → lMin
    const Y = new Float64Array(nL * nN);
    const W = new Float64Array(nL * nN);
    const Di = growthFactor(1 / aStart - 1, cosmo);
    const Do = growthFactor(zObs, cosmo);
    const fi = growthRate(1 / aStart - 1, cosmo, { exact: true });
    const om = (N) => omegaMatterAt(1 / Math.exp(N) - 1, cosmo);
    const rhs = (N, y, yp) => {
        const m = om(N);
        return [yp, -(2 - 1.5 * m) * yp - 0.5 * m * (1 / (y * y) - y)];
    };
    const step = (N, y, yp, h) => {
        const k1 = rhs(N, y, yp);
        const k2 = rhs(N + h / 2, y + h / 2 * k1[0], yp + h / 2 * k1[1]);
        const k3 = rhs(N + h / 2, y + h / 2 * k2[0], yp + h / 2 * k2[1]);
        const k4 = rhs(N + h, y + h * k3[0], yp + h * k3[1]);
        return [y + h / 6 * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
            yp + h / 6 * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])];
    };
    for (let i = 0; i < nL; i++) {
        const dI = Lgrid[i] * Di / Do;
        let y = 1 - dI / 3;
        let yp = -fi * dI / 3;
        let N = Math.log(aStart);
        // Run-in to the first table node, in steps no coarser than the table's.
        const nRun = Math.max(sub, Math.ceil((Nlo - N) / (dN / sub)));
        const hRun = (Nlo - N) / nRun;
        for (let k = 0; k < nRun; k++) { [y, yp] = step(N, y, yp, hRun); N += hRun; }
        for (let j = 0; j < nN; j++) {
            if (j > 0) {
                const h = dN / sub;
                for (let k = 0; k < sub; k++) { [y, yp] = step(N, y, yp, h); N += h; }
            }
            Y[i * nN + j] = y;
            W[i * nN + j] = yp / y;
        }
    }

    // Bilinear lookup in (u = ln(1 − Δ_L), N).
    const locate = (dL, a) => {
        const u = Math.log(1 - Math.min(0, Math.max(lMin, dL)));
        let fi_ = u / uMax * (nL - 1);
        fi_ = Math.max(0, Math.min(nL - 1 - 1e-9, fi_));
        let fj = (Math.log(a) - Nlo) / dN;
        fj = Math.max(0, Math.min(nN - 1 - 1e-9, fj));
        const i = Math.floor(fi_), j = Math.floor(fj);
        return { i, j, ti: fi_ - i, tj: fj - j };
    };
    const lerp2 = (T, { i, j, ti, tj }) => {
        const a00 = T[i * nN + j], a01 = T[i * nN + j + 1];
        const a10 = T[(i + 1) * nN + j], a11 = T[(i + 1) * nN + j + 1];
        return (a00 * (1 - tj) + a01 * tj) * (1 - ti) + (a10 * (1 - tj) + a11 * tj) * ti;
    };
    const state = (dL, a) => {
        const loc = locate(dL, a);
        const y = lerp2(Y, loc);
        return { y, w: lerp2(W, loc), deltaNL: 1 / (y * y * y) - 1 };
    };
    // Inversion at z_obs: Δ_NL is monotone in Δ_L, so bisection on the
    // interpolated column is exact to the table's own accuracy.
    const invert = (deltaNLobs) => {
        if (!(deltaNLobs < 0)) return deltaNLobs;          // not a void shell: linear
        let lo = lMin, hi = 0;
        for (let k = 0; k < 60; k++) {
            const mid = 0.5 * (lo + hi);
            if (state(mid, aObs).deltaNL < deltaNLobs) lo = mid; else hi = mid;
        }
        return 0.5 * (lo + hi);
    };
    return { zObs, aObs, aMin, aMax, lMin, nN, nL, state, invert };
}

/** Bernardeau (1994) ν = 3/2 closed form — kept only so the gate can MEASURE it. */
export function bernardeauDeltaNL(deltaL, nu = 1.5) {
    return Math.pow(1 - deltaL / nu, -nu) - 1;
}

// ── Tracking ────────────────────────────────────────────────────────────────

const clumpOf = (pr) => ({
    g: pr.forces.web.vector.map((c, i) => c - pr.forces.wall.vector[i]),
    T: pr.tidal.webTensor.map((c, i) => c - pr.tidal.smoothWallTensor[i]),
});

/**
 * Follow one galaxy, observed at comoving `xObs` (Mpc from the void centre),
 * across the timeline.
 *
 * mode 'nonlinear' needs `table` (shellTable for this z_obs). mode 'linear'
 * is the original Zel'dovich tracker: ψ from the probe's LINEAR total velocity,
 * fields scaled from z_obs.
 */
export function trackGalaxy(xObs, {
    voidProfile, web, zObs, timeline, cosmo = COSMOLOGY,
    twebThreshold = DEFAULT_TWEB_THRESHOLD, mode = 'nonlinear', table = null,
} = {}) {
    const opts = { voidProfile, web, z: zObs, cosmo, topN: 0, twebThreshold };
    const here = probeAt(xObs, opts);
    let at;
    let lagrangian;
    let extra = {};
    if (mode === 'linear' || !table) {
        const psi = displacementFromVelocity(here.velocity.A.vector, zObs, cosmo);
        const vObs = here.velocity.A.vector;
        at = (ep) => sampleLinear(ep, xObs, psi, vObs, opts);
        lagrangian = positionAt(xObs, psi, 0);
        extra = { psi, vObsKms: vObs };
    } else {
        const shell = shellOf(xObs, voidProfile, table);
        const clump = clumpOf(here);
        const vk = velocityPerAcceleration(zObs, cosmo) / 1000;
        const vClumpObs = clump.g.map(c => c * vk);
        const psiC = displacementFromVelocity(vClumpObs, zObs, cosmo);
        at = (ep) => sampleNonlinear(ep, shell, psiC, vClumpObs, opts, table, voidProfile);
        lagrangian = shell.unit.map((c, i) => c * shell.q - psiC[i]);
        extra = { shell, psiClump: psiC };
    }
    return {
        xObs: [...xObs], mode: (mode === 'linear' || !table) ? 'linear' : 'nonlinear',
        lagrangianMpc: lagrangian,
        samples: timeline.epochs.map(at),
        at,
        ...extra,
    };
}

/** A galaxy's spherical shell: radius, unit vector, Lagrangian q, Δ_L at z_obs. */
function shellOf(xObs, voidProfile, table) {
    const r = Math.hypot(xObs[0], xObs[1], xObs[2]);
    const unit = r > 1e-9
        ? xObs.map(c => c / Math.hypot(xObs[0], xObs[1], xObs[2]))
        : [0, 0, 1];
    const dObs = voidProfile.integratedAt(Math.max(r, 1e-6));
    const yObs = Math.cbrt(1 / (1 + dObs));
    return { rObs: r, unit, q: r / yObs, deltaObs: dObs, deltaLObs: table.invert(dObs) };
}

function sampleLinear(ep, xObs, psi, vObs, opts) {
    const pos = positionAt(xObs, psi, ep.D);
    const pr = probeAt(pos, opts);
    const g = ep.gravity;
    const values = pr.tidal.axes.map(a => a.lambda * ep.tidal);
    const v = [vObs[0] * ep.velocity, vObs[1] * ep.velocity, vObs[2] * ep.velocity];
    const r = pr.rMpc;
    const vRad = r > 1e-9 ? (v[0] * pos[0] + v[1] * pos[1] + v[2] * pos[2]) / r : 0;
    const deltaEnclosed = opts.voidProfile.integratedAt(r) * ep.D;
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
        delta: pr.deltaLocal * ep.D,
        deltaEnclosed,
        tidal: values,
        tweb: twebClass(values, opts.twebThreshold),
        linearOk: Math.abs(deltaEnclosed) <= 0.5 && Math.abs(pr.deltaLocal * ep.D) <= 0.5,
        shellCrossed: false,
    };
}

const SHELL_DR = 0.2;          // Mpc: neighbour spacing for local δ and crossing

function sampleNonlinear(ep, shell, psiC, vClumpObs, opts, table, voidProfile) {
    const { cosmo } = opts;
    const st = table.state(shell.deltaLObs, ep.a);
    const rSph = shell.q * st.y;
    const pos = shell.unit.map((c, i) => c * rSph + (ep.D - 1) * psiC[i]);
    const pr = probeAt(pos, opts);
    const clump = clumpOf(pr);

    // Spherical part: Gauss's law on the shell's own nonlinear Δ.
    const H = hubbleSI(ep.z, cosmo);
    const om = omegaMatterAt(ep.z, cosmo);
    const gSph = -0.5 * om * H * H * st.deltaNL * ep.a * rSph * MPC_M;   // m/s², + outward
    const gSphV = shell.unit.map(c => c * gSph);
    const gClumpV = clump.g.map(c => c * ep.gravity);
    const gA = gSphV.map((c, i) => c + gClumpV[i]);
    // The smooth wall at this position, scaled — so the deficit/web split the
    // probe reports survives into the nonlinear mode (exact at z_obs).
    const gWallV = pr.forces.wall.vector.map(c => c * ep.gravity);
    const gVoidV = gSphV.map((c, i) => c - gWallV[i]);
    const gWebV = pr.forces.web.vector.map(c => c * ep.gravity);
    const mag = (v) => Math.hypot(v[0], v[1], v[2]);

    // Velocity: the shell's own expansion + the linear clumped drift.
    const vSph = ep.a * hubbleKmsMpc(ep.z, cosmo) * rSph * st.w;               // km/s
    const v = shell.unit.map((c, i) => c * vSph + vClumpObs[i] * ep.velocity);
    const r = Math.hypot(pos[0], pos[1], pos[2]);
    const vRad = r > 1e-9 ? (v[0] * pos[0] + v[1] * pos[1] + v[2] * pos[2]) / r : 0;

    // Local δ and shell crossing from the two neighbouring shells:
    //   1 + δ = d(q³)/d(r³)  — mass conservation, exact.
    const lo = shellOf(shell.unit.map(c => c * Math.max(0, shell.rObs - SHELL_DR)), voidProfile, table);
    const hi = shellOf(shell.unit.map(c => c * (shell.rObs + SHELL_DR)), voidProfile, table);
    const rLo = lo.q * table.state(lo.deltaLObs, ep.a).y;
    const rHi = hi.q * table.state(hi.deltaLObs, ep.a).y;
    const crossed = !(rHi > rLo);
    const deltaLocal = crossed ? NaN : (hi.q ** 3 - lo.q ** 3) / (rHi ** 3 - rLo ** 3) - 1;

    // Tidal: exact spherical tensor on (δ_NL, Δ_NL) + the linear clumped part.
    const radial = deltaLocal - (2 / 3) * st.deltaNL;
    const tang = st.deltaNL / 3;
    const n = shell.unit;
    const anis = radial - tang;
    const Tsph = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        Tsph.push(anis * n[i] * n[j] + (i === j ? tang : 0));
    }
    const T = Tsph.map((c, k) => c + clump.T[k] * ep.tidal);
    const values = Number.isFinite(deltaLocal) ? symmetricEigen(T).values : [NaN, NaN, NaN];

    const mv = mag(gVoidV);
    const mw = mag(gWebV);
    return {
        tGyr: ep.tGyr, z: ep.z,
        positionMpc: pos,
        rMpc: r,
        gA: toKmsPerGyr(mag(gA)),
        gVoid: toKmsPerGyr(mv),
        gWeb: toKmsPerGyr(mw),
        gRadial: toKmsPerGyr(r > 1e-9 ? (gA[0] * pos[0] + gA[1] * pos[1] + gA[2] * pos[2]) / r : 0),
        voidShare: (mv + mw) > 0 ? mv / (mv + mw) : 0,
        vKms: mag(v),
        vRadialKms: vRad,
        delta: deltaLocal,
        deltaEnclosed: st.deltaNL,
        deltaLinear: shell.deltaLObs * ep.D,
        tidal: values,
        tweb: Number.isFinite(values[0]) ? twebClass(values, opts.twebThreshold) : { name: 'crossed', count: NaN },
        linearOk: true,
        shellCrossed: crossed,
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

/**
 * Many points at once (the stage's tracers + web nodes), in either mode, as
 * `{ positionsAt(ep, out) }`. Nonlinear: each point rides its own spherical
 * shell (table lookup) plus the linear clumped displacement; linear: the old
 * x_obs + (D − 1)ψ. ψ for the clumped part comes from (web − smooth wall).
 */
export function bulkMotion(points, { voidProfile, web, zObs, cosmo = COSMOLOGY, mode = 'nonlinear', table = null }) {
    const n = points.length;
    if (mode === 'linear' || !table) {
        const psi = displacementField(points, { voidProfile, web, zObs, cosmo });
        return {
            mode: 'linear',
            positionsAt: (ep, out) => displacedPositions(points, psi, ep.D, out),
        };
    }
    const { wall } = splitProfile(voidProfile);
    const vk = velocityPerAcceleration(zObs, cosmo) / 1000;
    const k = vk / ((1 / (1 + zObs)) * hubbleKmsMpc(zObs, cosmo) * fExact(zObs, cosmo));
    const psi = new Float64Array(n * 3);
    const unit = new Float64Array(n * 3);
    const q = new Float64Array(n);
    const dL = new Float64Array(n);
    points.forEach((p, i) => {
        const gw = web.externalGravityAt(p);
        const gs = voidGravityVector(p, [0, 0, 0], wall, { z: zObs, cosmo });
        for (let c = 0; c < 3; c++) psi[i * 3 + c] = (gw[c] - gs[c]) * k;
        const sh = shellOf(p, voidProfile, table);
        unit.set(sh.unit, i * 3);
        q[i] = sh.q;
        dL[i] = sh.deltaLObs;
    });
    return {
        mode: 'nonlinear',
        positionsAt(ep, out = new Float32Array(n * 3)) {
            const s = ep.D - 1;
            for (let i = 0; i < n; i++) {
                const r = q[i] * table.state(dL[i], ep.a).y;
                for (let c = 0; c < 3; c++) out[i * 3 + c] = unit[i * 3 + c] * r + s * psi[i * 3 + c];
            }
            return out;
        },
    };
}
