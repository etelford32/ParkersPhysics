/**
 * spaceship-designer-mission.js — PURE "where can it go from here?" kernel for
 * the Space Ship Designer. No DOM; node-tested by tests/spaceship-designer.mjs.
 *
 * After the guided ascent the vehicle sits in a parking orbit with some Δv
 * still aboard (`remaining_dv_kms`, the rocket equation on what is left in its
 * tanks). This module turns that into destinations, with every number DERIVED
 * — patched conics + Hohmann transfers between circular, coplanar orbits:
 *
 *   departure   Δv₁ = √(v∞₁² + 2μ₁/r₁) − √(μ₁/r₁)      (burn at the parking orbit)
 *   capture     Δv₂ = √(v∞₂² + 2μ₂/r₂) − √(μ₂/r₂)      (into a LOW circular orbit)
 *   time        π·√(a_t³/μ_parent)                       (half the transfer ellipse)
 *   window      synodic period 1 / |1/T₁ − 1/T₂|          (how often the geometry recurs)
 *
 * Three topologies cover every pair the designer can launch from:
 *   siblings    both orbit the same parent (Earth→Mars about the Sun, Titan→Enceladus about Saturn)
 *   to a moon   the destination orbits the origin (Earth→Moon): Hohmann out to its distance
 *   to parent   the origin orbits the destination (Moon→Earth): drop to a low parent orbit
 * plus "escape" (C3 = 0: (√2 − 1)·v_circ) and, from Earth, GEO.
 *
 * The node gate pins the textbook figures this reproduces: LEO→TLI 3.13 km/s,
 * lunar orbit insertion 0.82, LEO→Mars transfer 3.61, Earth escape 3.22,
 * GTO 2.44 + GEO circularisation 1.47, Earth–Mars Hohmann 259 days.
 *
 * WHAT IT IGNORES (and the page says so): plane changes and launch-site
 * inclination, non-circular / non-coplanar planetary orbits, gravity losses of
 * finite burns, and AEROCAPTURE — a destination with an atmosphere can shed
 * most of its capture Δv by aerobraking, which is why the capture column is
 * marked for those bodies rather than dropped.
 */

import { LAUNCH_BODIES } from './launch-physics.js';

const AU = 149_597_870.7;           // km
const MU_SUN = 1.32712440018e11;    // km³/s²

// Orbit of each body about its parent (semi-major axis, km) and the extra
// bodies that only appear as parents. Mean orbital elements (JPL).
export const ORBITS = {
    mercury:   { parent: 'sun',     a: 0.387098 * AU },
    venus:     { parent: 'sun',     a: 0.723332 * AU },
    earth:     { parent: 'sun',     a: 1.000001 * AU },
    mars:      { parent: 'sun',     a: 1.523679 * AU },
    moon:      { parent: 'earth',   a: 384_400 },
    europa:    { parent: 'jupiter', a: 671_100 },
    titan:     { parent: 'saturn',  a: 1_221_870 },
    enceladus: { parent: 'saturn',  a: 237_948 },
};
const PARENTS = {
    sun:     { name: 'Sun',     mu: MU_SUN },
    jupiter: { name: 'Jupiter', mu: 1.26686534e8, R_km: 71_492 },
    saturn:  { name: 'Saturn',  mu: 3.7931187e7,  R_km: 60_268 },
};

/** Low-orbit altitude assumed at a destination (km): just above its atmosphere. */
export function lowOrbitAltKm(bodyId) {
    const b = LAUNCH_BODIES[bodyId];
    if (!b) return 200;
    if (!(b.rho0_kg_m3 > 1e-5)) return Math.max(20, b.R_km * 0.03);
    return Math.ceil((b.H_km * Math.log(b.rho0_kg_m3 / 1e-5) + 20) / 10) * 10;
}

const muOf = (id) => LAUNCH_BODIES[id]?.mu_km3s2 ?? PARENTS[id]?.mu;
const nameOf = (id) => LAUNCH_BODIES[id]?.name ?? PARENTS[id]?.name ?? id;
const vCirc = (mu, r) => Math.sqrt(mu / r);
const hyperbolicBurn = (vInf, mu, r) => Math.sqrt(vInf * vInf + 2 * mu / r) - Math.sqrt(mu / r);
const period = (mu, a) => 2 * Math.PI * Math.sqrt((a * a * a) / mu);

/** Hohmann between two circular orbits r1 → r2 about μ: burn speeds + time. */
export function hohmann(mu, r1, r2) {
    const at = (r1 + r2) / 2;
    const v1 = vCirc(mu, r1), v2 = vCirc(mu, r2);
    const vp = Math.sqrt(mu * (2 / r1 - 1 / at)), va = Math.sqrt(mu * (2 / r2 - 1 / at));
    return { dv1: Math.abs(vp - v1), dv2: Math.abs(v2 - va), vDepart: vp, vArrive: va, v1, v2,
             tof_s: Math.PI * Math.sqrt((at * at * at) / mu) };
}

/**
 * One destination's budget from a circular parking orbit at `parkAltKm` over
 * `origin`. Returns null for a pair this kernel does not model.
 * { id, name, kind, depart_kms, capture_kms, total_kms, tof_days, window_days|null, aero }
 */
export function transferBudget(origin, parkAltKm, dest) {
    const o = LAUNCH_BODIES[origin];
    if (!o) return null;
    const muO = o.mu_km3s2, r1 = o.R_km + parkAltKm;

    if (dest === 'escape') {
        const v = vCirc(muO, r1);
        return { id: 'escape', name: `Escape ${o.name}`, kind: 'escape',
                 depart_kms: (Math.SQRT2 - 1) * v, capture_kms: 0, total_kms: (Math.SQRT2 - 1) * v,
                 tof_days: null, window_days: null, aero: false };
    }
    if (dest === 'geo' && origin === 'earth') {
        const rGeo = 42_164;
        const h = hohmann(muO, r1, rGeo);
        return { id: 'geo', name: 'Geostationary orbit', kind: 'orbit',
                 depart_kms: h.dv1, capture_kms: h.dv2, total_kms: h.dv1 + h.dv2,
                 tof_days: h.tof_s / 86400, window_days: null, aero: false };
    }

    const d = LAUNCH_BODIES[dest];
    if (!d || dest === origin) return null;
    const muD = d.mu_km3s2, r2 = d.R_km + lowOrbitAltKm(dest);
    const aero = d.rho0_kg_m3 > 1e-5;
    const oo = ORBITS[origin], od = ORBITS[dest];

    // Siblings: both orbit the same parent.
    if (oo && od && oo.parent === od.parent) {
        const muP = muOf(oo.parent);
        const h = hohmann(muP, oo.a, od.a);
        const dep = hyperbolicBurn(h.dv1, muO, r1);
        const cap = hyperbolicBurn(h.dv2, muD, r2);
        const syn = 1 / Math.abs(1 / period(muP, oo.a) - 1 / period(muP, od.a));
        return { id: dest, name: d.name, kind: 'transfer', depart_kms: dep, capture_kms: cap,
                 total_kms: dep + cap, tof_days: h.tof_s / 86400, window_days: syn / 86400, aero,
                 vinf_depart_kms: h.dv1, vinf_arrive_kms: h.dv2 };
    }
    // Destination is a moon of the origin (Earth → Moon).
    if (od && od.parent === origin) {
        const h = hohmann(muO, r1, od.a);
        const vMoon = vCirc(muO, od.a);
        const vInf = Math.abs(vMoon - h.vArrive);
        const cap = hyperbolicBurn(vInf, muD, r2);
        return { id: dest, name: d.name, kind: 'transfer', depart_kms: h.dv1, capture_kms: cap,
                 total_kms: h.dv1 + cap, tof_days: h.tof_s / 86400, window_days: null, aero,
                 vinf_arrive_kms: vInf };
    }
    // Destination is the origin's parent (Moon → Earth): fall to a low orbit there.
    if (oo && oo.parent === dest) {
        const h = hohmann(muD, oo.a, r2);                 // from the moon's orbit down to low parent orbit
        const vMoon = vCirc(muD, oo.a);
        const vInf = Math.abs(vMoon - h.vDepart);
        const dep = hyperbolicBurn(vInf, muO, r1);
        return { id: dest, name: d.name, kind: 'return', depart_kms: dep, capture_kms: h.dv2,
                 total_kms: dep + h.dv2, tof_days: h.tof_s / 86400, window_days: null, aero,
                 vinf_depart_kms: vInf };
    }
    return null;
}

/** The destinations offered from each launch body, in display order. */
export const DESTINATIONS = {
    earth:     ['geo', 'moon', 'mars', 'venus', 'mercury', 'escape'],
    moon:      ['earth', 'escape'],
    mars:      ['earth', 'venus', 'escape'],
    venus:     ['earth', 'mars', 'mercury', 'escape'],
    mercury:   ['venus', 'earth', 'escape'],
    titan:     ['enceladus', 'escape'],
    enceladus: ['titan', 'escape'],
    europa:    ['escape'],
};

/**
 * Every destination's budget against the Δv still aboard.
 *   reach: 'orbit'  — departure + capture both fit
 *          'flyby'  — the departure fits (arrive, but cannot stop)
 *          'aero'   — only by aerocapturing at a destination with air
 *          'no'
 */
export function missionOptions(origin, parkAltKm, dvLeftKms) {
    return (DESTINATIONS[origin] || ['escape']).map((id) => {
        const b = transferBudget(origin, parkAltKm, id);
        if (!b) return null;
        const reach = dvLeftKms >= b.total_kms ? 'orbit'
            : (b.aero && dvLeftKms >= b.depart_kms) ? 'aero'
            : dvLeftKms >= b.depart_kms ? 'flyby' : 'no';
        return { ...b, reach, margin_kms: dvLeftKms - b.total_kms };
    }).filter(Boolean);
}

export { nameOf as bodyName };
