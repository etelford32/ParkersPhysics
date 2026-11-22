/**
 * chicxulub/scene-model.js — what the 3-D stage draws, as numbers (PURE).
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no ambient time. Node-gated by tests/chicxulub.mjs §9.
 * js/chicxulub/stage.js is a renderer of this module and computes no physics.
 *
 * Units: kilometres and seconds. t = 0 is FIRST CONTACT with the ground.
 * Local frame: east, north, up from the crater centre.
 *
 * WHAT IS PHYSICS AND WHAT IS A SKETCH — the split the stage must keep saying:
 *
 *   FROM THE RECONSTRUCTION   the body's size, speed, angle and bearing; the
 *       transient and final crater diameters and depths (impact-model.js);
 *       how long the body takes to cross the atmosphere and to bury itself;
 *       where thrown-out rock is landing at time t (the exact ballistic flight
 *       of impact-model.js, inverted); the fireball's final radius.
 *   MEASURED                  the peak ring's radius and relief.
 *   A SKETCH (`SKETCH`, verified:false)   everything about HOW the hole gets
 *       from one shape to the next: the growth law of the bowl, the time the
 *       collapse takes, the height the centre rebounds to, the curtain's
 *       height and the fireball's growth and fading. Real crater collapse is
 *       a shock-physics calculation; this is an interpolation between the
 *       two shapes the scaling laws give, timed to the published picture
 *       (the peak ring in place within about ten minutes). It shows the
 *       ORDER and the SCALE of events, not their dynamics.
 *
 * The approach is a straight line: over the last 20 s Earth's gravity changes
 * the velocity by < 0.2 km/s and the direction by a fraction of a degree.
 * The body is not slowed or broken by the air (impact-model.js header).
 */

import { G0, SCALING, ballisticFlight, R_EARTH } from './impact-model.js';
import { CRATER } from './observations.js';

const RAD = Math.PI / 180;

export const SKETCH = Object.freeze({
    verified: false,
    formCoeff: 0.8,          // transient crater forms in c·√(D_tc/g)
    growthExp: 0.4,          // bowl radius and depth ∝ t^0.4 while it opens
    collapseCoeff: 2.5,      // collapse lasts c·√(D_final/g) more
    upliftFraction: 0.8,     // centre rebounds by this × the transient depth, then falls back
    upliftWidth: 0.28,       // … over this fraction of the transient radius
    transientRimRatio: 1 / 14.1,   // transient rim height / diameter (Collins et al. 2005, recalled)
    finalDepthCoeff: 0.4, finalDepthExp: 0.3,   // final depth, km = 0.4 D_final^0.3 (recalled)
    rimCoeff: 0.07,          // final rim height = 0.07 D_tc⁴ / D_final³ (recalled)
    peakRingWidthKm: 6,
    curtainSlope: 0.55,      // curtain height / its base radius
    curtainMaxKm: 140,
    fireballRiseS: 18, fireballFadeS: 150,
    meltGlowS: 240,
});

export const REFERENCE = Object.freeze({ everestKm: 8.849, cruiseKm: 11, karmanKm: 100 });
export const APPROACH_S = 20;
export const END_S = 900;
export const SCENE_RADIUS_KM = 460;

const smooth = (x) => { const u = Math.max(0, Math.min(1, x)); return u * u * (3 - 2 * u); };

/** The clock and the sizes of one impact, from a forward() bundle. */
export function timeline(fwd, { fromAzimuthDeg = 45 } = {}) {
    const { diameterKm, speedKms, angleDeg } = fwd.input;
    const sinT = Math.sin(angleDeg * RAD);
    const Dtc = fwd.transientKm, Dfr = fwd.finalKm;
    const formS = SKETCH.formCoeff * Math.sqrt(Dtc * 1000 / G0);
    const collapseEndS = formS + SKETCH.collapseCoeff * Math.sqrt(Dfr * 1000 / G0);
    return {
        diameterKm, speedKms, angleDeg, fromAzimuthDeg,
        contactS: diameterKm / (speedKms * sinT),                // time to bury its own diameter
        atmosphereS: REFERENCE.karmanKm / (speedKms * sinT),     // 100 km → ground
        formS, collapseEndS,
        transientRadiusKm: Dtc / 2, transientDepthKm: Dtc * SCALING.depthRatio,
        transientRimKm: Dtc * SKETCH.transientRimRatio,
        finalRadiusKm: Dfr / 2,
        finalDepthKm: SKETCH.finalDepthCoeff * Dfr ** SKETCH.finalDepthExp,
        finalRimKm: SKETCH.rimCoeff * Dtc ** 4 / Dfr ** 3,
        peakRingRadiusKm: Math.min(CRATER.peakRingDiameterKm.value / 2, 0.7 * Dfr / 2),
        peakRingReliefKm: 0.4,                                   // measured: up to 400 m
        fireballKm: fwd.fireballKm,
        energyJ: fwd.energyJ,
    };
}

// ── the body ────────────────────────────────────────────────────────────────
/**
 * Centre of the impactor at time t (east, north, up — km) and how much of it
 * is left. Before contact it flies a straight line; from contact it keeps
 * going down while it is consumed over `contactS`.
 */
export function impactorState(tl, t) {
    const th = tl.angleDeg * RAD, az = tl.fromAzimuthDeg * RAD, R = tl.diameterKm / 2;
    const d = -t * tl.speedKms;                                   // distance still to fly (negative after contact)
    const remaining = t <= 0 ? 1 : Math.max(0, 1 - t / tl.contactS);
    return {
        east: d * Math.cos(th) * Math.sin(az), north: d * Math.cos(th) * Math.cos(az), up: R + d * Math.sin(th),
        altitudeKm: Math.max(0, d * Math.sin(th)), remaining,
        inAtmosphere: t <= 0 && d * Math.sin(th) < REFERENCE.karmanKm,
        radiusKm: R,
    };
}
/** Unit vector the body travels along (east, north, up). */
export function travelDirection(tl) {
    const th = tl.angleDeg * RAD, az = tl.fromAzimuthDeg * RAD;
    return { east: -Math.cos(th) * Math.sin(az), north: -Math.cos(th) * Math.cos(az), up: -Math.sin(th) };
}
/**
 * A lumpy rock: radius factor for a unit direction, deterministic in `seed`.
 * A SHAPE FOR THE EYE — nothing is known about the real body's shape.
 */
export function lumpiness(x, y, z, seed = 66) {
    const s = seed * 0.37;
    const a = Math.sin(2.1 * x + 1.3 * y + s) * Math.cos(1.7 * z - 0.6 * x + 2 * s);
    const b = Math.sin(4.3 * y - 2.2 * z + 3 * s) * Math.cos(3.9 * x + 1.1 * z - s);
    const c = Math.sin(8.7 * x + 7.1 * y - 6.3 * z + 5 * s);
    return 1 + 0.11 * a + 0.06 * b + 0.022 * c;
}

// ── the ground ──────────────────────────────────────────────────────────────
function transientProfile(r, tl, grow) {
    const Rt = tl.transientRadiusKm * grow, dt = tl.transientDepthKm * grow, hr = tl.transientRimKm * grow;
    if (!(Rt > 0)) return 0;
    if (r < Rt) return -dt * (1 - (r / Rt) ** 2) + hr * (r / Rt) ** 6;      // bowl, turning up into the lip
    return hr * (Rt / r) ** 3;                                               // the lip and the blanket beyond it
}
function finalProfile(r, tl) {
    const Rf = tl.finalRadiusKm, dF = tl.finalDepthKm, hr = tl.finalRimKm;
    if (r >= Rf) return hr * (Rf / r) ** 3;
    const wall = smooth((r - 0.8 * Rf) / (0.2 * Rf));                        // floor → rim crest
    const ring = tl.peakRingReliefKm * Math.exp(-(((r - tl.peakRingRadiusKm) / SKETCH.peakRingWidthKm) ** 2));
    return -dF * (1 - wall) + hr * wall + ring * (1 - wall);
}
/** How far the collapse has run, 0 → 1. */
export function collapseProgress(tl, t) { return smooth((t - tl.formS) / (tl.collapseEndS - tl.formS)); }
/** Radius of the open hole at time t (km): the growing bowl, then the widening crater. */
export function craterRadiusKm(tl, t) {
    if (t <= 0) return 0;
    if (t < tl.formS) return tl.transientRadiusKm * (t / tl.formS) ** SKETCH.growthExp;
    return tl.transientRadiusKm + (tl.finalRadiusKm - tl.transientRadiusKm) * collapseProgress(tl, t);
}
/** Height of the ground (km, negative = down) at distance r from the centre, at time t. */
export function surfaceHeightKm(tl, rKm, t) {
    if (t <= 0) return 0;
    if (t < tl.formS) return transientProfile(rKm, tl, (t / tl.formS) ** SKETCH.growthExp);
    if (t >= tl.collapseEndS) return finalProfile(rKm, tl);
    const s = collapseProgress(tl, t);
    const uplift = SKETCH.upliftFraction * tl.transientDepthKm * Math.sin(Math.PI * s)
        * Math.exp(-((rKm / (SKETCH.upliftWidth * tl.transientRadiusKm)) ** 2));
    return (1 - s) * transientProfile(rKm, tl, 1) + s * finalProfile(rKm, tl) + uplift;
}
/** Drop of a spherical Earth's surface below the tangent plane at distance r (km). */
export function curvatureDropKm(rKm) { return rKm * rKm / (2 * R_EARTH / 1000); }
/** How hot the crater floor looks, 0–1 (a display quantity). */
export function meltGlow(tl, t) { return t <= 0 ? 0 : Math.exp(-t / SKETCH.meltGlowS); }

// ── the sky ─────────────────────────────────────────────────────────────────
let _landing = null;
function landingTable() {
    if (_landing) return _landing;
    const r = [], T = [];
    for (let km = 20; km <= 6000; km *= 1.06) { const f = ballisticFlight(km * 1000); if (!f) break; r.push(km); T.push(f.timeS); }
    return (_landing = { r, T });
}
/**
 * Distance (km) at which thrown-out rock is LANDING at time t: the inverse of
 * the exact ballistic flight time. Launch is taken as t = 0 (the excavation
 * itself lasts ~a minute, so this leads the real front by up to that much).
 */
export function landingRadiusKm(t) {
    const { r, T } = landingTable();
    if (!(t > T[0])) return 0;
    if (t >= T[T.length - 1]) return r[r.length - 1];
    let lo = 0, hi = T.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= t) lo = mid; else hi = mid; }
    return r[lo] + (r[hi] - r[lo]) * (t - T[lo]) / (T[hi] - T[lo]);
}
/** The ejecta curtain: an outward-leaning cone standing on `baseKm`. */
export function curtainState(tl, t) {
    if (t <= tl.contactS) return { visible: false, baseKm: 0, heightKm: 0, topKm: 0, opacity: 0 };
    const baseKm = Math.max(craterRadiusKm(tl, t), landingRadiusKm(t));
    const heightKm = Math.min(SKETCH.curtainMaxKm, SKETCH.curtainSlope * baseKm);
    const thin = Math.min(1, (tl.transientRadiusKm / baseKm) ** 1.5);
    return { visible: baseKm < SCENE_RADIUS_KM * 1.1, baseKm, heightKm, topKm: baseKm + heightKm, opacity: 0.55 * thin + 0.08 };
}
/** The fireball: grows to its scaling-law radius, then fades. */
export function fireballState(tl, t) {
    if (t <= 0) return { radiusKm: 0, opacity: 0 };
    const radiusKm = tl.fireballKm * (1 - Math.exp(-t / SKETCH.fireballRiseS));
    return { radiusKm, opacity: Math.exp(-t / SKETCH.fireballFadeS) };
}

// ── the clock ───────────────────────────────────────────────────────────────
const SPLIT = 0.22, POWER = 2.4;
/** Slider 0–1 → seconds: the approach is linear, the aftermath stretches. */
export function sliderToTime(s) {
    const u = Math.max(0, Math.min(1, s));
    return u < SPLIT ? -APPROACH_S * (1 - u / SPLIT) : END_S * ((u - SPLIT) / (1 - SPLIT)) ** POWER;
}
export function timeToSlider(t) {
    if (t <= 0) return SPLIT * (1 + Math.max(-APPROACH_S, t) / APPROACH_S);
    return SPLIT + (1 - SPLIT) * (Math.min(END_S, t) / END_S) ** (1 / POWER);
}
export function formatClock(t) {
    const a = Math.abs(t), sign = t < 0 ? '−' : '+';
    if (a < 60) return `T${sign}${a < 10 ? a.toFixed(1) : Math.round(a)} s`;
    return `T${sign}${Math.floor(a / 60)} min ${String(Math.round(a % 60)).padStart(2, '0')} s`;
}

export const PHASES = Object.freeze(['approach', 'atmosphere', 'contact', 'excavation', 'collapse', 'aftermath']);
/** Which part of the event t falls in, with the sentence the stage shows. */
export function phaseAt(tl, t) {
    const st = impactorState(tl, t);
    if (t <= 0 && !st.inAtmosphere) return { id: 'approach', title: 'Approach',
        text: `A ${tl.diameterKm.toFixed(0)} km body, ${st.altitudeKm.toFixed(0)} km up, closing at ${tl.speedKms.toFixed(0)} km/s from the north-east.` };
    if (t <= 0) return { id: 'atmosphere', title: 'Through the air',
        text: `It crosses the whole atmosphere in ${tl.atmosphereS.toFixed(1)} s. The air cannot slow it: the body is taller than Everest and is still in space when its front touches the sea.` };
    if (t <= tl.contactS) return { id: 'contact', title: 'Contact',
        text: `In ${tl.contactS.toFixed(1)} s the body buries itself. It and the rock under it turn to vapour and melt.` };
    if (t < tl.formS) return { id: 'excavation', title: 'The hole opens',
        text: `A bowl ${(2 * craterRadiusKm(tl, t)).toFixed(0)} km across and growing. It will reach ${(2 * tl.transientRadiusKm).toFixed(0)} km wide and ${tl.transientDepthKm.toFixed(0)} km deep in about ${Math.round(tl.formS)} s.` };
    if (t < tl.collapseEndS) return { id: 'collapse', title: 'The hole collapses',
        text: `The bowl is too deep to stand. Its floor rebounds, the walls slump inward, and the centre rises and falls back outward to leave the peak ring.` };
    return { id: 'aftermath', title: 'The crater',
        text: `A basin ${(2 * tl.finalRadiusKm).toFixed(0)} km across and about ${tl.finalDepthKm.toFixed(1)} km deep, with a ring of peaks ${(2 * tl.peakRingRadiusKm).toFixed(0)} km across. The sea is already pouring back in.` };
}
