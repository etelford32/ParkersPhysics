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

import {
    G0, SCALING, ballisticFlight, R_EARTH, SEISMIC_SPEED, SOUND_SPEED, tsunamiAt,
    opticalDepth, lifetimeFromDarkness, lightFraction, impactWinter, impliedOceanDepth, DARK_THRESHOLD,
} from './impact-model.js';
import { CRATER, CLIMATE_TARGETS } from './observations.js';

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
    sootSpreadS: 5 * 86400,  // soot from the fires circles the planet in about this long (e-fold)
    softLogS: 3,             // the slider is linear in time below ~this, logarithmic above
});

export const REFERENCE = Object.freeze({ everestKm: 8.849, cruiseKm: 11, karmanKm: 100 });
export const APPROACH_S = 20;
export const END_S = 900;                       // the LOCAL scene: crater in place
export const YEAR_S = 3.156e7;
export const LONG_END_S = 30 * YEAR_S;          // the whole clock: to the recovery
export const HALF_CIRCUMFERENCE_KM = Math.PI * R_EARTH / 1000;   // crater → antipode
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
    for (let km = 20; km <= 19900; km *= 1.05) { const f = ballisticFlight(km * 1000); if (!f) break; r.push(km); T.push(f.timeS); }
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
    if (t >= T[T.length - 1]) return HALF_CIRCUMFERENCE_KM;
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

// ── the planet ──────────────────────────────────────────────────────────────
/**
 * How far each front has travelled from the crater along the ground (km), up
 * to the antipode. Speeds are impact-model.js's own: first strong shaking at
 * SEISMIC_SPEED, the air blast at the speed of sound, the tsunami at the
 * shallow-water speed past its published anchor, and falling debris at the
 * exact ballistic flight time (launch taken as t = 0).
 */
export function frontsAt(t) {
    const cap = (km) => ({ km: Math.max(0, Math.min(HALF_CIRCUMFERENCE_KM, km)), done: km >= HALF_CIRCUMFERENCE_KM });
    if (!(t > 0)) return { seismic: cap(0), debris: cap(0), blast: cap(0), tsunami: cap(0) };
    const anchor = tsunamiAt(1), far = tsunamiAt(1e7);          // inside the anchor; well outside it
    const aKm = 220, aS = aKm * 1000 / (1 / anchor.arrivalS);   // anchor: 220 km at aS seconds
    const wave = t <= aS ? aKm * t / aS : aKm + (t - aS) * far.speedMs / 1000;
    return {
        seismic: cap(SEISMIC_SPEED * t / 1000), debris: cap(landingRadiusKm(t)),
        blast: cap(SOUND_SPEED * t / 1000), tsunami: cap(wave),
    };
}
/** Seconds for a front to travel `km` from the crater (default: to the antipode). */
export function frontArrivalS(name, km = HALF_CIRCUMFERENCE_KM) {
    let lo = 1, hi = 40 * 86400;
    for (let i = 0; i < 60; i++) { const mid = Math.sqrt(lo * hi); if (frontsAt(mid)[name].km >= km) hi = mid; else lo = mid; }
    return hi;
}
/**
 * Debris launched at 45° takes ever longer to reach the far side (the last
 * stretch needs near-escape speed and days aloft), so "most of the planet" is
 * the useful mark: 90 % of the way to the antipode.
 */
export const DEBRIS_MOST_KM = 0.9 * HALF_CIRCUMFERENCE_KM;

let _climate = null;
/**
 * The dark years, from the soot scenario of the evidence table: the light
 * curve is anchored on the published duration of darkness, and the
 * temperature is the box with the ocean depth the published cooling implies
 * (impact-model.js §7). One run, cached.
 */
export function climateTrack() {
    if (_climate) return _climate;
    const soot = CLIMATE_TARGETS.find((c) => c.id === 'soot');
    const tau0 = opticalDepth(soot.massTg, soot.agent), lifeYr = lifetimeFromDarkness(tau0, soot.darkYears);
    const deep = impliedOceanDepth({ tau0, lifetimeYr: lifeYr, targetCoolingK: soot.peakCoolingK });
    const run = impactWinter({ tau0, lifetimeYr: lifeYr, heatCapacity: deep.heatCapacity, years: LONG_END_S / YEAR_S });
    // when the spreading soot first makes it dark (light < threshold)
    let lo = 1, hi = YEAR_S;
    const lightAt = (t) => 1 - (1 - lightFraction(tau0, lifeYr, t / YEAR_S)) * (1 - Math.exp(-t / SKETCH.sootSpreadS));
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (lightAt(mid) < DARK_THRESHOLD) hi = mid; else lo = mid; }
    return (_climate = {
        tau0, lifeYr, oceanDepthM: deep.oceanDepthM, run, lightAt, targetCoolingK: soot.peakCoolingK,
        darkStartS: hi, darkEndS: run.darkYears * YEAR_S, coldestS: run.peakAtYr * YEAR_S, coldestK: run.peakCoolingK,
        recoveredS: (run.recoveredYr ?? LONG_END_S / YEAR_S) * YEAR_S,
    });
}
/** Sunlight at the ground (0–1) and the global temperature change (K) at time t. */
export function skyAt(t) {
    const c = climateTrack();
    if (!(t > 0)) return { light: 1, tempK: 0 };
    const yr = Math.min(t, LONG_END_S) / YEAR_S, { t: ts, T } = c.run, n = ts.length - 1;
    const f = Math.min(n, yr / ts[n] * n), i = Math.min(n - 1, Math.floor(f));
    return { light: c.lightAt(t), tempK: T[i] + (T[i + 1] - T[i]) * (f - i) };
}
/**
 * How the stage shades the planet (DISPLAY quantities, 0–1): `dim` follows the
 * square root of the sunlight and never falls below 0.45, so the darkest years
 * are drawn dim, not black; `cold` is the cooling as a share of the deepest.
 */
export function skyShade(t) {
    const sky = skyAt(t), c = climateTrack();
    return { dim: 0.45 + 0.55 * Math.sqrt(Math.max(0, Math.min(1, sky.light))), cold: Math.max(0, Math.min(1, -sky.tempK / c.targetCoolingK)), light: sky.light };
}

// ── the clock ───────────────────────────────────────────────────────────────
// One slider for everything: the approach is linear, and after contact time is
// "soft-logarithmic" — linear for the first few seconds, logarithmic beyond —
// so seconds, hours and decades each get room. Exact inverse below.
const SPLIT = 0.2;
const LOGSPAN = Math.log(1 + LONG_END_S / SKETCH.softLogS);
/** Slider 0–1 → seconds since contact. */
export function sliderToTime(s) {
    const u = Math.max(0, Math.min(1, s));
    return u < SPLIT ? -APPROACH_S * (1 - u / SPLIT) : SKETCH.softLogS * Math.expm1(LOGSPAN * (u - SPLIT) / (1 - SPLIT));
}
export function timeToSlider(t) {
    if (t <= 0) return SPLIT * (1 + Math.max(-APPROACH_S, t) / APPROACH_S);
    return SPLIT + (1 - SPLIT) * Math.log1p(Math.min(LONG_END_S, t) / SKETCH.softLogS) / LOGSPAN;
}
export function formatClock(t) {
    const a = Math.abs(t), sign = t < 0 ? '−' : '+';
    if (a < 60) return `T${sign}${a < 10 ? a.toFixed(1) : Math.round(a)} s`;
    if (a < 3600) return `T${sign}${Math.floor(a / 60)} min ${String(Math.floor(a % 60)).padStart(2, '0')} s`;
    if (a < 2 * 86400) return `T${sign}${Math.floor(a / 3600)} h ${String(Math.floor(a % 3600 / 60)).padStart(2, '0')} min`;
    if (a < YEAR_S) return `T${sign}${Math.round(a / 86400)} days`;
    return `T${sign}${(a / YEAR_S).toFixed(1)} years`;
}
/** Which scale the stage should be showing. */
export function chapterAt(t) { return t <= 0 ? 'approach' : t <= END_S ? 'crater' : 'planet'; }

export const PHASES = Object.freeze(['approach', 'atmosphere', 'contact', 'excavation', 'collapse', 'aftermath', 'fallout', 'waves', 'dusk', 'darkness', 'winter']);
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
    if (t <= END_S) return { id: 'aftermath', title: 'The crater',
        text: `A basin ${(2 * tl.finalRadiusKm).toFixed(0)} km across and about ${tl.finalDepthKm.toFixed(1)} km deep, with a ring of peaks ${(2 * tl.peakRingRadiusKm).toFixed(0)} km across. The sea is already pouring back in.` };
    const fr = frontsAt(t), c = climateTrack(), sky = skyAt(t), pct = (x) => (x < 0.001 ? 'less than 0.1' : x < 0.1 ? (x * 100).toFixed(1) : Math.round(x * 100));
    if (fr.debris.km < DEBRIS_MOST_KM) return { id: 'fallout', title: 'Debris falls around the world',
        text: `Rock thrown out of the crater is coming down ${Math.round(fr.debris.km / 100) * 100} km away, re-entering fast enough to glow. The ground has already shaken ${fr.seismic.done ? 'everywhere' : `out to ${Math.round(fr.seismic.km / 100) * 100} km`}.` };
    if (!fr.tsunami.done) return { id: 'waves', title: 'The slow waves',
        text: `The air blast has gone ${fr.blast.done ? 'right round the planet' : `${Math.round(fr.blast.km / 100) * 100} km`}; the tsunami is ${Math.round(fr.tsunami.km / 100) * 100} km out and still crossing the oceans.` };
    if (t < c.darkStartS) return { id: 'dusk', title: 'The sky closes',
        text: `Soot from the fires is spreading through the upper air. Sunlight at the ground is down to ${pct(sky.light)} %.` };
    if (t < c.darkEndS) return { id: 'darkness', title: 'Darkness',
        text: `Too dark for plants to grow: ${pct(sky.light)} % of normal sunlight. The planet has cooled by ${Math.abs(sky.tempK).toFixed(1)} °C and is still cooling.` };
    // The box has ONE heat reservoir, sized to match the published PEAK cooling; that makes its
    // recovery far too slow (decades). The clock stops at 30 years and the text says so.
    return { id: 'winter', title: 'The long winter',
        text: `The sky has cleared to ${pct(sky.light)} % of normal, but the oceans have given up their heat: ${Math.abs(sky.tempK).toFixed(1)} °C colder than before${t < c.coldestS ? ', and not yet at its coldest' : ''}. How fast it warms again is beyond this simple model.` };
}

/** The moments worth a mark on the slider, in order. */
export function timelineEvents(tl) {
    const c = climateTrack();
    return [
        { t: 0, id: 'contact', label: 'impact' },
        { t: tl.formS, id: 'bowl', label: 'bowl open' },
        { t: tl.collapseEndS, id: 'crater', label: 'crater formed' },
        { t: frontArrivalS('debris', DEBRIS_MOST_KM), id: 'debris', label: 'debris over most of the planet' },
        { t: frontArrivalS('tsunami'), id: 'tsunami', label: 'tsunami across the oceans' },
        { t: frontArrivalS('blast'), id: 'blast', label: 'blast round the planet' },
        { t: c.darkStartS, id: 'dark', label: 'dark' },
        { t: c.darkEndS, id: 'light', label: 'light returns' },
        { t: c.coldestS, id: 'coldest', label: 'coldest' },
    ].sort((a, b) => a.t - b.t).map((e) => ({ ...e, slider: timeToSlider(e.t) }));
}
