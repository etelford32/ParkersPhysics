/**
 * chicxulub/collapse.js — how the transient cavity becomes the final crater.
 *
 * PURE: no DOM, no fetch, no clock, no randomness. Plan step E.
 *
 * WHAT IT IS. The classic reduced picture of complex-crater collapse
 * (Melosh 1977/1982; Melosh & Ivanov 1999): for a few minutes after the
 * impact the rock under and around the cavity behaves like a fluid with a
 * yield strength (a Bingham material — acoustic fluidisation is the
 * mechanism usually proposed). The cavity's walls slump in, the floor rises,
 * the inflow converges at the centre and OVERSHOOTS into a central uplift,
 * the uplift falls back outward, and everything FREEZES as the driving
 * stresses drop below the yield strength. Whether the frozen surface carries
 * a bowl, a central peak or a ring of peaks — and where the ring is — comes
 * out of that motion. Nothing in this file is told the peak-ring radius.
 * (That was the hope; see MEASURED below for what came out.)
 *
 * THE EQUATIONS. An axisymmetric, depth-averaged layer of fluidised rock of
 * thickness h(r, t) over a rigid base, surface η = h − H:
 *     ∂h/∂t + (1/r) ∂(r h u)/∂r = 0
 *     ∂u/∂t + u ∂u/∂r = −g ∂η/∂r − τ_b / (ρ h)
 *     τ_b = τ_y sgn(u) + 3 ρ ν u / h        (Bingham plug, laminar)
 * on a STAGGERED grid (h at cell centres, u at faces). That choice is
 * load-bearing: a frozen surface held up by the yield strength is not an
 * equilibrium of the inviscid equations, and a collocated scheme (Rusanov,
 * HLL) diffuses h even where u ≡ 0, so the "frozen" crater keeps eroding.
 * Here the mass flux is h·u at a face, so a face whose speed the yield
 * strength has clamped to zero moves nothing — exactly. Mass is conserved to
 * rounding (closed walls at r = 0 and r = R_max; gated).
 *
 * WHAT IT IS NOT, and the page must say so:
 *   • a hydrocode. Depth-averaging a cavity whose depth is a third of its
 *     width is a strong approximation; there is no vertical structure, no
 *     shock, no excavation flow (the cavity starts AT REST — real collapse
 *     begins while it is still growing), no ejecta rim, no layering, no
 *     water, no 3-D asymmetry from the oblique impact.
 *   • calibrated on Chicxulub. The ONE calibration is Earth's simple-to-
 *     complex transition (D_c, already in SCALING, recalled): the yield
 *     strength is the one that just holds up the transient cavity of a crater
 *     of that size, by THIS model's own static criterion. The viscosity is
 *     the acoustic-fluidisation scaling ν = γ_η · c_s · L (recalled,
 *     unverified) and the fluidised depth is a sketch parameter. Each of the
 *     three is varied in `sensitivity`, and the peak ring is HELD OUT.
 *
 * MEASURED 2026-11-23 — IT DOES NOT MAKE A PEAK RING, AND THE PAGE DOES NOT
 * USE IT. Kept as the gate's record (tests/chicxulub.mjs §11), like
 * impactWinterLayered. Three failures, each measured on Chicxulub's 86 km
 * transient cavity:
 *   1. THE CENTRAL UPLIFT DOES NOT CONVERGE: 44.7 / 54.8 / 69.8 km at
 *      240 / 480 / 960 cells. Depth-averaged inflow converging on r = 0 is a
 *      singular jet; the frozen morphology flips between central peak and
 *      flat floor with the grid.
 *   2. WHERE A RING APPEARS, IT SITS AT THE ASSUMED EDGE OF THE FLUIDISED
 *      ZONE (ring radius 1.1–1.3 × `fluidisedRadii`, at 60, 155 and 300 km
 *      craters) — the ring is the parameter, not a prediction. With the
 *      fluidisation everywhere there is no ring at all.
 *   3. THE BASIN IS 3–4× TOO WIDE: a layer over a rigid base can only fill
 *      the cavity from the sides, so it draws the surface down ~0.4 km out to
 *      the domain wall (450–690 km 'rim' diameters).
 * All three are the same limit: a peak ring forms where the collapsing
 * uplift flows OUTWARD OVER the rim material slumping in (the dynamic
 * collapse of the hydrocodes and of IODP Exp. 364's inverted stratigraphy),
 * and a single-valued depth-averaged surface cannot overturn. Step E needs
 * an (r, z) code; see CHICXULUB_PLAN.md. What did hold: mass to 1e-15, a
 * freeze in 5–15 minutes, and an uplift tens of km above the surface.
 *
 * Units: SI inside, km at the API edges where the name says so.
 */

import { SCALING, ejectaThickness } from './impact-model.js';

const G = 9.81;

/**
 * Rheology and geometry. Every entry is a modelling choice, not a
 * measurement; `verified: false` for the recalled ones.
 */
export const COLLAPSE = Object.freeze({
    verified: false,
    targetDensity: 2700,
    // fluidised layer thickness below the pre-impact surface, in transient depths
    layerDepths: 2.0,
    // acoustic fluidisation: ν = γ_η c_s L (Melosh 1979; Wünnemann & Ivanov 2003, recalled)
    gammaEta: 0.015,
    gammaBeta: 300,
    // how far out the rock is fluidised, in transient radii; Infinity = everywhere
    fluidisedRadii: Infinity,
    soundSpeed: 3000,           // m/s, crustal rock
    // transient-cavity shape: paraboloid, depth/diameter from SCALING
    depthRatio: SCALING.depthRatio,
    // the frozen-relief criterion for calling a bump a peak (in transient depths)
    prominence: 0.003,
    cells: 480,
    domainRadii: 8,             // R_max in transient radii
    cfl: 0.4,
    maxTimeS: 3600,
});

/** Transient-cavity geometry for a given transient DIAMETER (m). */
export function cavity(dtcM, { depthRatio = COLLAPSE.depthRatio } = {}) {
    return { radiusM: dtcM / 2, depthM: dtcM * depthRatio };
}

/**
 * The model's own static criterion: the largest basal shear stress the
 * at-rest cavity imposes on its layer, max over r of ρ g h |∂η/∂r|.
 * Above τ_y the cavity cannot stand and collapses; at or below it does not
 * move at all (the solver then returns it untouched — gated).
 */
export function cavityStress(dtcM, { layerDepths = COLLAPSE.layerDepths, rho = COLLAPSE.targetDensity, depthRatio = COLLAPSE.depthRatio } = {}) {
    const { radiusM: R, depthM: d } = cavity(dtcM, { depthRatio });
    const H = layerDepths * d;
    let best = 0;
    for (let k = 1; k <= 2000; k++) {
        const x = k / 2000;                              // r/R
        const h = H - d * (1 - x * x), slope = 2 * d * x / R;
        best = Math.max(best, rho * G * h * slope);
    }
    return best;
}

/**
 * THE ONE CALIBRATION: the yield strength that just holds up the transient
 * cavity of Earth's simple-to-complex transition crater (D_fr = D_c, simple:
 * D_tc = D_c / 1.25). Same criterion as the solver.
 */
export function calibratedYield(opts = {}) {
    return cavityStress(SCALING.simpleToComplexKm * 1000 / 1.25, opts);
}

/** T = γ_β L / c_s: the e-folding time of the fluidising vibrations. */
export function fluidisationDecay(impactorM, { gammaBeta = COLLAPSE.gammaBeta, soundSpeed = COLLAPSE.soundSpeed } = {}) {
    return gammaBeta * impactorM / soundSpeed;
}

/** ν = γ_η c_s L for an impactor of diameter L (m). */
export function fluidisationViscosity(impactorM, { gammaEta = COLLAPSE.gammaEta, soundSpeed = COLLAPSE.soundSpeed } = {}) {
    return gammaEta * soundSpeed * impactorM;
}

/**
 * Run the collapse of a transient cavity of diameter dtcM.
 *   yieldPa     τ_y (default: the D_c calibration)
 *   nu          kinematic viscosity, m²/s (default: from impactorM)
 *   impactorM   for the default viscosity
 *   frames      how many snapshots to keep (evenly spaced in time to the freeze)
 * Returns the frozen profile, the frames, and the diagnostics the page and
 * the gate read. Profiles are in km: { rKm[], etaKm[] }.
 */
export function collapseRun(dtcM, {
    yieldPa, nu, impactorM, layerDepths = COLLAPSE.layerDepths, rho = COLLAPSE.targetDensity,
    depthRatio = COLLAPSE.depthRatio, cells = COLLAPSE.cells, domainRadii = COLLAPSE.domainRadii,
    cfl = COLLAPSE.cfl, maxTimeS = COLLAPSE.maxTimeS, frames = 60, frameEveryS = null, ejectaRim = true,
    decayS, fluidisedRadii = COLLAPSE.fluidisedRadii,
} = {}) {
    const tauY = yieldPa ?? calibratedYield({ layerDepths, rho, depthRatio });
    const visc = nu ?? (impactorM ? fluidisationViscosity(impactorM) : 0);
    const { radiusM: R, depthM: d } = cavity(dtcM, { depthRatio });
    const H = layerDepths * d;
    const N = cells, Rmax = domainRadii * R, dr = Rmax / N;
    const rc = new Float64Array(N), h = new Float64Array(N), u = new Float64Array(N + 1);   // face i sits at i·dr
    for (let i = 0; i < N; i++) {
        rc[i] = (i + 0.5) * dr;
        const x = rc[i] / R;
        h[i] = H - (x < 1 ? d * (1 - x * x) : 0) + (ejectaRim && x >= 1 ? ejectaThickness(dtcM, rc[i]) : 0);
    }
    // fluidisation reaches fully to Rf and falls off as (Rf/r)² beyond (vibration amplitude)
    const Rf = fluidisedRadii * R;
    const fluid = new Float64Array(N + 1);
    for (let f = 0; f <= N; f++) { const r = f * dr; fluid[f] = r <= Rf ? 1 : (Rf / r) ** 2; }
    const mass = () => { let m = 0; for (let i = 0; i < N; i++) m += rc[i] * h[i]; return m * dr; };
    const m0 = mass();
    const everMoved = new Uint8Array(N + 1);
    const decay = decayS ?? (impactorM ? fluidisationDecay(impactorM) : 0);
    const yieldAcc0 = tauY / rho;                    // τ_y/ρ, m²/s² (divide by h for an acceleration)
    const snaps = [], snapAt = [];
    let t = 0, steps = 0, frozenAt = null, peakUplift = { heightM: -Infinity, tS: 0 };
    const capture = () => {
        snapAt.push(t);
        snaps.push(Float32Array.from(h, (v) => (v - H) / 1000));
    };
    capture();
    const hu = new Float64Array(N + 1);
    // Viscous + yield retardation, then the yield clamp: a face the driving
    // stress cannot push past τ_y stops EXACTLY.
    while (t < maxTimeS) {
        let vmax = 0, hmax = 0;
        for (let i = 0; i <= N; i++) vmax = Math.max(vmax, Math.abs(u[i]));
        for (let i = 0; i < N; i++) hmax = Math.max(hmax, h[i]);
        const dt = cfl * dr / (vmax + Math.sqrt(G * hmax));
        // fluidisation decays: the yield strength recovers as the vibrations die
        const fl = decay > 0 ? Math.exp(-(t + 0.5 * dt) / decay) : 0;
        // momentum at interior faces (forward step, then backward for mass)
        const un = Float64Array.from(u);
        for (let f = 1; f < N; f++) {
            const hf = 0.5 * (h[f - 1] + h[f]);
            const grad = (h[f] - h[f - 1]) / dr;
            // upwind self-advection of u
            const uf = u[f];
            const dudr = uf > 0 ? (u[f] - u[f - 1]) / dr : (u[f + 1] - u[f]) / dr;
            let v = uf - dt * (G * grad + uf * dudr);
            v /= 1 + 3 * visc * dt / (hf * hf);
            const stop = dt * yieldAcc0 * (1 - fl * fluid[f]) / hf;
            v = Math.abs(v) <= stop ? 0 : v - Math.sign(v) * stop;
            un[f] = v;
        }
        u.set(un);                                    // u[0] = u[N] = 0: closed walls
        let moving = false;
        for (let f = 1; f < N; f++) {
            if (u[f] !== 0) { moving = true; everMoved[f] = 1; }
            hu[f] = (u[f] > 0 ? h[f - 1] : h[f]) * u[f] * f * dr;     // r_face · h_upwind · u
        }
        for (let i = 0; i < N; i++) h[i] -= dt * (hu[i + 1] - hu[i]) / (rc[i] * dr);
        t += dt; steps++;
        if (h[0] - H > peakUplift.heightM) peakUplift = { heightM: h[0] - H, tS: t };
        if (frameEveryS && t >= snapAt[snapAt.length - 1] + frameEveryS) capture();
        if (!moving && !(decay > 0 && t < 0.05 * decay)) { frozenAt = t; break; }
    }
    if (snapAt[snapAt.length - 1] !== t) capture();
    const etaKm = Array.from(h, (v) => (v - H) / 1000), rKm = Array.from(rc, (v) => v / 1000);
    // thin the frames to the requested count
    let keep = snaps.map((s, i) => i);
    if (keep.length > frames) keep = Array.from({ length: frames }, (_, k) => Math.round(k * (snaps.length - 1) / (frames - 1)));
    let outer = 0;
    for (let f = N; f >= 1; f--) if (everMoved[f]) { outer = f * dr; break; }
    return {
        params: { dtcKm: dtcM / 1000, transientDepthKm: d / 1000, layerKm: H / 1000, yieldPa: tauY, nu: visc, cells: N },
        rKm, etaKm, frozenAtS: frozenAt, steps,
        massError: Math.abs(mass() - m0) / m0,
        peakUpliftKm: peakUplift.heightM / 1000, peakUpliftAtS: peakUplift.tS,
        disturbedRadiusKm: outer / 1000,
        frames: keep.map((i) => ({ tS: snapAt[i], etaKm: Array.from(snaps[i]) })),
        morphology: morphology(rKm, etaKm, d / 1000),
    };
}

/**
 * Read the frozen profile. A PEAK is a local maximum standing at least
 * `prominence` transient depths above the lower of its two flanking minima;
 * the crater RIM is where the surface last comes back up to within that
 * tolerance of the pre-impact level (the edge of the drawn-down basin).
 */
export function morphology(rKm, etaKm, depthKm, { prominence = COLLAPSE.prominence } = {}) {
    const n = etaKm.length, tol = prominence * depthKm;
    // rim: outermost r with η below −tol
    let rim = 0;
    for (let i = n - 1; i >= 0; i--) if (etaKm[i] < -tol) { rim = rKm[i]; break; }
    const peaks = [];
    for (let i = 0; i < n - 1; i++) {
        if (rKm[i] > rim) break;
        const left = i === 0 ? -Infinity : etaKm[i - 1];
        if (!(etaKm[i] > left && etaKm[i] >= etaKm[i + 1])) continue;
        let j = i;
        while (j < n - 1 && etaKm[j + 1] <= etaKm[j] + 1e-15) j++;   // walk down outward
        let minOut = etaKm[j];
        for (let k = j; k < n && rKm[k] <= rim; k++) minOut = Math.min(minOut, etaKm[k]);
        let minIn = etaKm[i];
        for (let k = i; k >= 0; k--) minIn = Math.min(minIn, etaKm[k]);
        const base = i === 0 ? minOut : Math.max(minIn, minOut);
        if (etaKm[i] - base >= tol) peaks.push({ rKm: rKm[i], etaKm: etaKm[i], prominenceKm: etaKm[i] - base });
    }
    const central = peaks.find((p) => p.rKm < 0.05 * Math.max(rim, 1e-9));
    const rings = peaks.filter((p) => p !== central);
    const ring = rings.length ? rings.reduce((a, b) => (b.prominenceKm > a.prominenceKm ? b : a)) : null;
    const kind = !peaks.length ? (rim > 0 ? 'flat-floored' : 'unchanged') : ring && (!central || ring.prominenceKm >= central.prominenceKm) ? 'peak-ring' : 'central-peak';
    return {
        kind, rimRadiusKm: rim, finalDiameterKm: 2 * rim,
        peakRingRadiusKm: ring ? ring.rKm : null, peakRingDiameterKm: ring ? 2 * ring.rKm : null,
        centralPeak: central ?? null, peaks,
        floorDepthKm: -Math.min(...etaKm),
    };
}
