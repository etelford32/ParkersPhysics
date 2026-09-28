/**
 * upper-atmosphere-explore-model.js — exploring the whole upper atmosphere
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE kernel for the page's EXPLORE mode. No THREE, no DOM, no ambient
 * time. Node-tested by `tests/upper-atmosphere-explore.mjs`. Vectors are
 * plain [x, y, z] arrays in the canonical scene frame (`latLonToScene`:
 * +X Greenwich, +Y north, −Z = 90°E; 1 unit = 1 R⊕).
 *
 * Five things live here, each the ONE copy the renderer draws:
 *
 *   1. FLIGHT ON THE SPHERE (`exploreStep`). The free-fly camera moves in
 *      straight lines, so at 200 km "forward" leaves the atmosphere in a
 *      few hundred km. Explore flies ALONG the sphere: position is a unit
 *      vector u plus an altitude, heading is a tangent h ⟂ u that is
 *      parallel-transported along each great-circle step, and up is always
 *      the local radial — the horizon stays level anywhere, poles included
 *      (there is no lat/lon in the state, so there is no pole singularity).
 *      W flies where you LOOK: ground motion ∝ cos(pitch), and the vertical
 *      part is taken in log-altitude, so diving at the floor slows
 *      exponentially instead of hitting it.
 *
 *   2. SPEED ∝ ALTITUDE (`cruiseSpeedKmS`). A navigation speed, not a
 *      physical one: 1.2 × altitude per second keeps the apparent motion of
 *      the ground constant from 80 to 2000 km (the Google-Earth law). The
 *      HUD prints it next to the circular orbital speed so nobody mistakes
 *      "480 km/s at 400 km" for something a spacecraft does.
 *
 *   3. TRANSITIONS (`cameraPath`). One path function for a dive from orbit
 *      into the band and for the climb back out: position slerps along a
 *      great circle while altitude interpolates in LOG space (so the path
 *      can never pass below min(start, end) — no chord through the planet),
 *      and the view turns from wherever it was, to the ground below the
 *      destination, to the destination's horizon. Both ends are exact.
 *
 *   4. BOUNDARIES (`BOUNDARIES`, `boundaryCrossings`, `membraneWeight`),
 *      derived from `ATMOSPHERIC_LAYER_SCHEMA` so a renamed or moved layer
 *      moves its boundary, plus the Kármán line and the model ceiling.
 *
 *   5. POINTS OF INTEREST (`pointsOfInterest`), each PLACED BY THE MODEL:
 *      the diurnal bulge and the pre-dawn trough where the page's own
 *      Jacchia term puts them, the auroral oval where the page's own oval
 *      band puts it for the live Kp, the exobase at the altitude where the
 *      engine's mean free path equals its scale height, and so on. None of
 *      them is a hand-typed coordinate, so none of them can drift away from
 *      what the render is drawing.
 */

import {
    latLonToScene, sceneToLatLon, R_EARTH_KM, MODEL_FLOOR_KM, MODEL_CEIL_KM,
    jacchiaDiurnalRatio, bulgeLocalSolarTime, diurnalContrast,
    magneticLatitude, auroralHeatingK, DIPOLE_POLE, AIRGLOW_LAYERS,
} from './upper-atmosphere-column.js';
import { ATMOSPHERIC_LAYER_SCHEMA, layerForAltitude } from './upper-atmosphere-layers.js';
import { pointPhysics } from './upper-atmosphere-physics.js';
import { auroralOvalLatBand } from './upper-atmosphere-aurora-physics.js';
import { kpToAp } from './upper-atmosphere-engine.js';

const DEG = Math.PI / 180;
const MU_KM3_S2 = 398600.4418;

export { R_EARTH_KM, MODEL_FLOOR_KM, MODEL_CEIL_KM };

/** Explore-mode tuning. Speeds are NAVIGATION speeds (see header §2). */
export const EXPLORE = Object.freeze({
    floorKm:       MODEL_FLOOR_KM + 0.5,   // same half-km margin as the transit
    ceilKm:        MODEL_CEIL_KM,
    cruisePerKm:   1.2,                    // km/s of cruise per km of altitude
    boost:         4,                      // Shift
    crawl:         0.2,                    // Ctrl / Alt
    turnRateDeg:   55,                     // A/D, degrees per second
    climbLogRate:  0.8,                    // Q/E: d ln(alt)/dt per second
    pitchLimitDeg: 85,
});

// ─────────────────────────────────────────────────────────────────────────
// Vector helpers (plain arrays)
// ─────────────────────────────────────────────────────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
function norm(a) {
    const l = len(a);
    return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
};
const smootherstep = (x) => {
    const t = clamp(x, 0, 1);
    return t * t * t * (t * (t * 6 - 15) + 10);
};
/** Rodrigues rotation of v about the unit axis k by angle a. */
function rotate(v, k, a) {
    const c = Math.cos(a), s = Math.sin(a);
    const kv = cross(k, v), kd = dot(k, v);
    return [
        v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
        v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
        v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
    ];
}
/** Component of v perpendicular to the unit u, normalised (or null). */
function tangent(v, u) {
    const t = sub(v, scale(u, dot(v, u)));
    const l = len(t);
    return l > 1e-9 ? scale(t, 1 / l) : null;
}

export const vec = Object.freeze({ dot, cross, len, norm, rotate, tangent });

/**
 * Local east / north at a unit position. East is the direction of
 * increasing longitude in `latLonToScene` (−Z at Greenwich). At a pole,
 * where east is undefined, returns nulls.
 */
export function localEastNorth(u) {
    const east = tangent(cross([0, 1, 0], u), u);
    if (!east) return { east: null, north: null };
    return { east, north: cross(u, east) };
}

/** Compass heading (degrees, 0 = north, 90 = east) of tangent h at u; null at a pole. */
export function headingDegOf(u, h) {
    const { east, north } = localEastNorth(u);
    if (!east) return null;
    const d = Math.atan2(dot(h, east), dot(h, north)) / DEG;
    return (d + 360) % 360;
}

/** 8-point compass label for a heading. */
export function compass8(headingDeg) {
    if (!Number.isFinite(headingDeg)) return '—';
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((headingDeg % 360) + 360) % 360 / 45) % 8];
}

// ─────────────────────────────────────────────────────────────────────────
// 1. Flight on the sphere
// ─────────────────────────────────────────────────────────────────────────

/** Circular orbital speed at an altitude, km/s. */
export function orbitalSpeedKmS(altKm) {
    return Math.sqrt(MU_KM3_S2 / (R_EARTH_KM + Math.max(0, altKm)));
}

/** Navigation cruise speed at an altitude, km/s. */
export function cruiseSpeedKmS(altKm, { boost = false, crawl = false } = {}) {
    const a = clamp(Number.isFinite(altKm) ? altKm : EXPLORE.floorKm, EXPLORE.floorKm, EXPLORE.ceilKm);
    return EXPLORE.cruisePerKm * a * (boost ? EXPLORE.boost : 1) * (crawl ? EXPLORE.crawl : 1);
}

/**
 * Move the unit position u along the unit tangent m by `angle` radians of
 * great circle; m is parallel-transported with it (the direction of travel
 * at the new point).
 */
export function greatCircleStep(u, m, angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return {
        u: norm(add(scale(u, c), scale(m, s))),
        m: norm(sub(scale(m, c), scale(u, s))),
    };
}

/** Turn the tangent heading h about the local vertical u; positive = to the right. */
export function turnHeading(h, u, angle) {
    const right = cross(h, u);            // forward × up = right
    return norm(add(scale(h, Math.cos(angle)), scale(right, Math.sin(angle))));
}

/**
 * Explore state from a camera pose. `forward` straight up or down has no
 * horizontal part; the heading then falls back to local north (east at a
 * pole) so the state is always complete.
 *
 * @returns {{ u:number[], h:number[], altKm:number, pitchRad:number }}
 */
export function stateFromPose(position, forward) {
    const r = len(position);
    const u = norm(position);
    const f = norm(forward);
    let h = tangent(f, u);
    if (!h) {
        const { north } = localEastNorth(u);
        h = north || tangent([1, 0, 0], u) || [0, 0, 1];
    }
    return {
        u, h,
        altKm: (r - 1) * R_EARTH_KM,
        pitchRad: Math.asin(clamp(dot(f, u), -1, 1)),
    };
}

/** Explore state at a geographic point, heading and pitch. */
export function stateFromLatLon({ latDeg, lonDeg, altKm, headingDeg = 90, pitchDeg = -6 }) {
    const u = latLonToScene(latDeg, lonDeg);
    const { east, north } = localEastNorth(u);
    const H = headingDeg * DEG;
    const h = east
        ? norm(add(scale(east, Math.sin(H)), scale(north, Math.cos(H))))
        : (tangent([1, 0, 0], u) || [0, 0, 1]);
    return { u, h, altKm, pitchRad: pitchDeg * DEG };
}

/** Camera pose for an explore state: position, forward, up (= local radial). */
export function explorePose(state) {
    const { u, h, altKm, pitchRad } = state;
    const r = 1 + altKm / R_EARTH_KM;
    const c = Math.cos(pitchRad), s = Math.sin(pitchRad);
    return {
        position: scale(u, r),
        forward: norm(add(scale(h, c), scale(u, s))),
        up: u.slice(),
    };
}

/**
 * One explore step.
 *
 * @param {{u,h,altKm,pitchRad}} state
 * @param {object} input
 *   forward  −1…1   W / S (flies along the LOOK direction, see header)
 *   turn     −1…1   A / D (+ = right)
 *   climb    −1…1   Q / E (+ = up), in log-altitude
 *   boost, crawl    Shift, Ctrl/Alt
 *   dYawRad, dPitchRad   mouse-look deltas accumulated since the last step
 * @param {number} dt  seconds of REAL time
 * @returns {{u,h,altKm,pitchRad, speedKmS:number, groundSpeedKmS:number, climbKmS:number}}
 */
export function exploreStep(state, input = {}, dt = 0) {
    let { u, h, altKm, pitchRad } = state;
    const t = Math.max(0, Number.isFinite(dt) ? dt : 0);
    const boostF = (input.boost ? EXPLORE.boost : 1) * (input.crawl ? EXPLORE.crawl : 1);

    // Look / turn.
    const yaw = clamp(input.turn || 0, -1, 1) * EXPLORE.turnRateDeg * DEG * t + (input.dYawRad || 0);
    if (yaw) h = turnHeading(h, u, yaw);
    const lim = EXPLORE.pitchLimitDeg * DEG;
    pitchRad = clamp(pitchRad + (input.dPitchRad || 0), -lim, lim);

    const alt0 = clamp(altKm, EXPLORE.floorKm, EXPLORE.ceilKm);
    const v = cruiseSpeedKmS(alt0, input);
    const fwd = clamp(input.forward || 0, -1, 1);
    let ground = 0, dLnAlt = 0;
    if (fwd && t > 0) {
        ground = v * Math.cos(pitchRad) * fwd * t;                 // km over the ground
        const r = R_EARTH_KM + alt0;
        const step = greatCircleStep(u, h, ground / r);
        u = step.u; h = step.m;
        // Vertical part of "fly where you look", in log-altitude: v/alt is
        // constant (= cruisePerKm × boost), so this is exact for the speed law.
        dLnAlt += (v / alt0) * Math.sin(pitchRad) * fwd * t;
    }
    const climb = clamp(input.climb || 0, -1, 1);
    if (climb && t > 0) dLnAlt += EXPLORE.climbLogRate * boostF * climb * t;
    let alt1 = alt0 * Math.exp(dLnAlt);
    alt1 = clamp(alt1, EXPLORE.floorKm, EXPLORE.ceilKm);

    // Keep the frame exact against rounding drift.
    h = tangent(h, u) || h;
    return {
        u, h, altKm: alt1, pitchRad,
        speedKmS: v,
        groundSpeedKmS: t > 0 ? Math.abs(ground) / t : 0,
        climbKmS: t > 0 ? (alt1 - alt0) / t : 0,
    };
}

/** Where an explore state is, for readouts. */
export function describeState(state) {
    const ll = sceneToLatLon(state.u);
    return {
        latDeg: ll.latDeg, lonDeg: ll.lonDeg, altKm: state.altKm,
        headingDeg: headingDegOf(state.u, state.h),
        pitchDeg: state.pitchRad / DEG,
    };
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Transitions: one path for the dive in and the climb out
// ─────────────────────────────────────────────────────────────────────────

/**
 * A camera path between two poses.
 *
 * @param {object} o
 * @param {number[]} o.fromPos, o.fromFwd, o.fromUp
 * @param {number[]} o.toPos,   o.toFwd,   o.toUp
 * @param {number[]|null} [o.aimAt]   world point the view turns to in the
 *        middle of the path (the ground under a dive's destination), or
 *        null to blend straight from start to end view (the climb out).
 * @returns {{ arcDeg:number, durationSec:number, at:(s:number)=>{position:number[],forward:number[],up:number[],altKm:number} }}
 */
export function cameraPath({ fromPos, fromFwd, fromUp, toPos, toFwd, toUp, aimAt = null }) {
    const r0 = len(fromPos), r1 = len(toPos);
    const u0 = norm(fromPos), u1 = norm(toPos);
    const alt0 = Math.max(1e-3, (r0 - 1) * R_EARTH_KM);
    const alt1 = Math.max(1e-3, (r1 - 1) * R_EARTH_KM);
    const arc = Math.acos(clamp(dot(u0, u1), -1, 1));

    // Rotation axis carrying u0 to u1. Degenerate at 0 (no travel) and at π
    // (antipodal: any great circle works; take the one along the current
    // view so the camera sets off the way it is facing).
    let k = cross(u0, u1);
    if (len(k) < 1e-9) {
        const along = tangent(fromFwd, u0) || localEastNorth(u0).north || tangent([1, 0, 0], u0);
        k = cross(u0, along);
    }
    k = norm(k);
    const travel = arc > 1e-6;
    const descending = alt1 < alt0;

    // The end view expressed in the local travel frame at u1, so it can be
    // rebuilt at every point along the path (transported with the camera)
    // and lands EXACTLY on toFwd / toUp at s = 1.
    const frameAt = (u) => {
        const t = travel ? norm(cross(k, u)) : null;
        return t ? { t, u, s: cross(t, u) } : null;
    };
    const f1 = frameAt(u1);
    const inFrame = (v, F) => [dot(v, F.t), dot(v, F.u), dot(v, F.s)];
    const outFrame = (c, F) => add(add(scale(F.t, c[0]), scale(F.u, c[1])), scale(F.s, c[2]));
    const fwdC = f1 ? inFrame(toFwd, f1) : null;
    const upC = f1 ? inFrame(toUp, f1) : null;

    const arcDeg = arc / DEG;
    const durationSec = clamp(2.2 + 0.9 * Math.abs(Math.log(alt0 / alt1)) + 0.02 * arcDeg, 2.5, 9);

    function at(sIn) {
        const s = clamp(sIn, 0, 1);
        if (s >= 1) {
            return { position: toPos.slice(), forward: norm(toFwd), up: norm(toUp), altKm: alt1 };
        }
        if (s <= 0) {
            return { position: fromPos.slice(), forward: norm(fromFwd), up: norm(fromUp), altKm: alt0 };
        }
        const eArc = smootherstep(s);
        const eAlt = descending ? 1 - Math.pow(1 - s, 2.2) : Math.pow(s, 2.2);
        const u = travel ? norm(rotate(u0, k, arc * eArc)) : u0;
        const altKm = Math.exp(Math.log(alt0) + (Math.log(alt1) - Math.log(alt0)) * eAlt);
        const position = scale(u, 1 + altKm / R_EARTH_KM);

        const F = frameAt(u);
        const endFwd = F ? norm(outFrame(fwdC, F)) : norm(toFwd);
        const endUp = F ? norm(outFrame(upC, F)) : norm(toUp);

        const wStart = 1 - smoothstep(0, 0.35, s);
        const wLevel = smoothstep(0.55, 1, s);
        const wAim = aimAt ? Math.max(0, 1 - wStart - wLevel) : 0;
        let dAim = null;
        if (wAim > 0) dAim = norm(sub(aimAt, position));
        // Without an aim point the two ends share the whole blend.
        const ws = aimAt ? wStart : 1 - smoothstep(0, 1, s);
        const wl = aimAt ? wLevel : 1 - ws;
        let f = scale(norm(fromFwd), ws);
        f = add(f, scale(endFwd, wl));
        if (dAim) f = add(f, scale(dAim, wAim));
        let forward = len(f) > 1e-6 ? norm(f) : (dAim || endFwd);

        const wUp = smoothstep(0.1, 0.9, s);
        let up = add(scale(norm(fromUp), 1 - wUp), scale(endUp, wUp));
        if (len(up) < 1e-6) up = u;
        up = norm(up);
        return { position, forward, up, altKm };
    }
    return { arcDeg, durationSec, alt0, alt1, at };
}

/** Field-of-view gain over a transition: a speed cue, back to 1 at both ends. */
export function transitionFovGain(s) {
    const x = Math.sin(Math.PI * clamp(s, 0, 1));
    return 1 + 0.22 * x * x;
}

/**
 * The dive into the band: from any camera pose to (lat, lon, alt), arriving
 * level with the horizon along `headingDeg` (default: the direction of
 * travel, so the camera arrives flying forward) at `pitchDeg`.
 */
export function divePath({ fromPos, fromFwd, fromUp, latDeg, lonDeg, altKm, headingDeg = null, pitchDeg = -8 }) {
    const alt = clamp(altKm, EXPLORE.floorKm, EXPLORE.ceilKm);
    const u1 = latLonToScene(latDeg, lonDeg);
    const u0 = norm(fromPos);
    let heading = headingDeg;
    if (!Number.isFinite(heading)) {
        const k = cross(u0, u1);
        const travelDir = len(k) > 1e-6 ? norm(cross(norm(k), u1)) : null;
        const cur = tangent(fromFwd, u1);
        heading = headingDegOf(u1, travelDir || cur || localEastNorth(u1).north || [0, 0, 1]);
        if (!Number.isFinite(heading)) heading = 0;
    }
    const st = stateFromLatLon({ latDeg, lonDeg, altKm: alt, headingDeg: heading, pitchDeg });
    const pose = explorePose(st);
    const path = cameraPath({
        fromPos, fromFwd, fromUp,
        toPos: pose.position, toFwd: pose.forward, toUp: pose.up,
        aimAt: u1,                          // the ground under the destination
    });
    return { ...path, target: { latDeg, lonDeg, altKm: alt, headingDeg: heading, pitchDeg }, endState: st };
}

/**
 * The climb out to the orbit view over the same ground: radially up to
 * `distance` R⊕ from the centre, looking at the planet with +Y up (what
 * OrbitControls expects to take over).
 */
export function climbPath({ fromPos, fromFwd, fromUp, distance = 3.4 }) {
    const u0 = norm(fromPos);
    const toPos = scale(u0, distance);
    const toFwd = scale(u0, -1);
    // +Y projected onto the view plane; at a pole use the camera's own up.
    const toUp = tangent([0, 1, 0], toFwd) || tangent(fromUp, toFwd) || [1, 0, 0];
    return cameraPath({ fromPos, fromFwd, fromUp, toPos, toFwd, toUp, aimAt: null });
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Boundaries
// ─────────────────────────────────────────────────────────────────────────

/**
 * Every surface worth marking, lowest first. Layer boundaries come from
 * the canonical schema (the top of every layer but the last); the Kármán
 * line and the model ceiling are named lines, not layer edges.
 */
export const BOUNDARIES = Object.freeze((() => {
    const out = [];
    for (let i = 0; i < ATMOSPHERIC_LAYER_SCHEMA.length - 1; i++) {
        const below = ATMOSPHERIC_LAYER_SCHEMA[i], above = ATMOSPHERIC_LAYER_SCHEMA[i + 1];
        out.push(Object.freeze({
            km: below.maxKm, id: `${below.id}|${above.id}`, kind: 'layer',
            name: `${below.name} ⇄ ${above.name}`,
            below: below.name, above: above.name, colorHex: above.colorLow,
        }));
    }
    out.push(Object.freeze({
        // Softer than white: from just under it the whole sky is this grid
        // seen edge-on, and a marker must not drown the airglow it sits in.
        km: 100, id: 'karman', kind: 'line', name: 'Kármán line',
        below: null, above: null, colorHex: 0x7fb8d8,
    }));
    out.push(Object.freeze({
        km: MODEL_CEIL_KM, id: 'ceiling', kind: 'edge', name: 'Model ceiling',
        below: null, above: null, colorHex: 0x9aa8ff,
    }));
    return out.sort((a, b) => a.km - b.km);
})());

/**
 * How visible a boundary's marker is from a camera altitude: a Gaussian in
 * LOG altitude, so a boundary is prominent while you are near it and gone
 * when you are far (from the default ~14 000 km orbit view every weight is
 * below 1e-6 and the pass is skipped).
 */
export function membraneWeight(camAltKm, boundaryKm, sigma = 0.3) {
    if (!(camAltKm > 0) || !(boundaryKm > 0)) return 0;
    const d = Math.log(camAltKm / boundaryKm);
    return Math.exp(-(d * d) / (2 * sigma * sigma));
}

/**
 * Membrane grid level: log₂ of the grid spacing in degrees, so the cells
 * stay a few times the camera's height above the surface (≈ 3 × (Δh +
 * 40 km)). The shader draws 2^floor(L) and 2^(floor(L)+1) and blends by
 * the fraction, so the grid refines smoothly on the way down.
 */
export function gridLevel(camAltKm, boundaryKm) {
    const h = Math.abs((Number.isFinite(camAltKm) ? camAltKm : boundaryKm) - boundaryKm) + 40;
    const deg = (3 * h) / (R_EARTH_KM * DEG);
    return clamp(Math.log2(deg), -2, 4);
}

/**
 * Boundaries crossed moving from `prevKm` to `altKm`, in travel order.
 * Each entry names what you are entering (the layer at the new altitude).
 */
export function boundaryCrossings(prevKm, altKm) {
    if (!Number.isFinite(prevKm) || !Number.isFinite(altKm) || prevKm === altKm) return [];
    const up = altKm > prevKm;
    const hits = BOUNDARIES.filter(b => (prevKm - b.km) * (altKm - b.km) < 0
        || (up ? (prevKm < b.km && altKm === b.km) : (prevKm > b.km && altKm === b.km)));
    hits.sort((a, b) => up ? a.km - b.km : b.km - a.km);
    return hits.map(b => {
        const probe = up ? b.km + 1e-6 : b.km - 1e-6;
        const L = layerForAltitude(probe);
        let entered;
        if (b.id === 'ceiling') entered = up ? 'above the model (2000 km)' : 'the model domain';
        else if (b.id === 'karman') entered = up ? 'space (by the FAI definition)' : 'the atmosphere (by the FAI definition)';
        else entered = L?.name ?? '—';
        return { boundary: b, direction: up ? 'up' : 'down', entered };
    });
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Points of interest — each placed by the model
// ─────────────────────────────────────────────────────────────────────────

const wrapLon = (lon) => ((lon + 180) % 360 + 360) % 360 - 180;

/** Inverse of the engine's Kp → Ap table (bisection; the table stays ONE copy). */
export function apToKp(ap) {
    if (!Number.isFinite(ap) || ap <= 0) return 0;
    if (ap >= kpToAp(9)) return 9;
    let lo = 0, hi = 9;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (kpToAp(mid) < ap) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

/** Local solar time of the Jacchia MINIMUM at a latitude (counterpart of bulgeLocalSolarTime). */
export function troughLocalSolarTime(latDeg = 0, sunDeclDeg = 0) {
    let best = 0, bestV = Infinity;
    for (let i = 0; i < 288; i++) {
        const lst = i * (24 / 288);
        const v = jacchiaDiurnalRatio(latDeg, lst, sunDeclDeg);
        if (v < bestV) { bestV = v; best = lst; }
    }
    return best;
}

/** Longitude where local solar time is `lstHr`, given the sub-solar longitude. */
export function lonAtLocalSolarTime(lstHr, subSolarLonDeg) {
    return wrapLon(subSolarLonDeg + (lstHr - 12) * 15);
}

/**
 * The exobase: the altitude where the engine's mean free path equals its
 * own scale height (Kn = λ/H = 1). Above it a molecule's next collision is,
 * on average, farther away than the air's e-folding length, so it flies
 * ballistic arcs. Bisection on the page's ONE density model.
 */
export function exobaseAltitudeKm({ f107Sfu = 150, ap = 15 } = {}) {
    const kn = (a) => pointPhysics({ altitudeKm: a, f107Sfu, ap }).knudsen;
    let lo = 150, hi = MODEL_CEIL_KM;
    if (!(kn(lo) < 1) || !(kn(hi) > 1)) return null;
    for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (kn(mid) < 1) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

/**
 * The point at magnetic latitude `magLatDeg` on the MAGNETIC MIDNIGHT
 * meridian (the anti-sunward side of the centred dipole). The auroral oval
 * is fattest and furthest equatorward there.
 */
export function magneticMidnightPoint(magLatDeg, subSolarLatDeg, subSolarLonDeg) {
    const d = latLonToScene(DIPOLE_POLE.latDeg, DIPOLE_POLE.lonDeg);
    const antiSun = scale(latLonToScene(subSolarLatDeg, subSolarLonDeg), -1);
    const m = tangent(antiSun, d) || tangent([1, 0, 0], d);
    const phi = magLatDeg * DEG;
    const p = norm(add(scale(d, Math.sin(phi)), scale(m, Math.cos(phi))));
    return sceneToLatLon(p);
}

/**
 * Auroral curtain geometry: the centre line of the page's own oval band
 * (`auroralOvalLatBand`, the same parameterisation the magnetic cascade
 * draws) sampled around magnetic local time for one hemisphere.
 *
 * MLT 0 is the anti-sunward meridian of the centred dipole and MLT grows
 * EASTWARD (a positive rotation about the dipole axis, as longitude grows
 * about +Y in the canonical frame). Intensity is SYMBOLIC — a midnight-
 * weighted shape scaled with Kp — and is disclosed as such; the curtains'
 * vertical extent follows the emission heights (green 557.7 nm low, red
 * 630 nm high), not a brightness model.
 *
 * @returns {Array<{mltHr:number, magLatDeg:number, latDeg:number, lonDeg:number, u:number[], intensity:number}>}
 */
export const AURORA_CURTAIN = Object.freeze({ bottomKm: 100, topKm: 300, samples: 360 });

export function auroraCurtain({ kp = 3, subSolarLatDeg = 0, subSolarLonDeg = 0, hemisphere = 1, samples = AURORA_CURTAIN.samples } = {}) {
    const hemi = hemisphere < 0 ? -1 : 1;
    const d = latLonToScene(DIPOLE_POLE.latDeg, DIPOLE_POLE.lonDeg);
    const antiSun = scale(latLonToScene(subSolarLatDeg, subSolarLonDeg), -1);
    const mm = tangent(antiSun, d) || tangent([1, 0, 0], d);
    const k = clamp(kp, 0, 9);
    const out = [];
    for (let i = 0; i < samples; i++) {
        const mlt = (i / samples) * 24;
        const band = auroralOvalLatBand(k, mlt);
        const magLat = hemi * (band.eq + band.pw) / 2;
        const m = rotate(mm, d, mlt * 15 * DEG);
        const phi = magLat * DEG;
        const u = norm(add(scale(d, Math.sin(phi)), scale(m, Math.cos(phi))));
        const ll = sceneToLatLon(u);
        // Brightest around magnetic midnight, never zero on the dayside:
        // cos²(π·MLT/24) is 1 at 0 h and 0 at 12 h.
        const mid = Math.cos((mlt / 24) * Math.PI);
        const intensity = (0.3 + 0.7 * (k / 9)) * (0.35 + 0.65 * mid * mid);
        out.push({ mltHr: mlt, magLatDeg: magLat, latDeg: ll.latDeg, lonDeg: ll.lonDeg, u, intensity });
    }
    return out;
}

/** Ground distance (km) between two geographic points on the mean sphere. */
export function groundDistanceKm(lat1, lon1, lat2, lon2) {
    const a = latLonToScene(lat1, lon1), b = latLonToScene(lat2, lon2);
    return Math.acos(clamp(dot(a, b), -1, 1)) * R_EARTH_KM;
}

/**
 * The live points of interest.
 *
 * @param {object} o
 * @param {number} o.subSolarLatDeg   solar declination
 * @param {number} o.subSolarLonDeg
 * @param {number} [o.f107Sfu=150]
 * @param {number} [o.ap=15]
 * @param {{latDeg,lonDeg,altKm,headingDeg}|null} [o.iss]  live ISS state, if known
 * @returns {Array<{id,name,latDeg,lonDeg,altKm,headingDeg,pitchDeg,colorHex,blurb,facts,placedBy}>}
 */
export function pointsOfInterest({ subSolarLatDeg = 0, subSolarLonDeg = 0, f107Sfu = 150, ap = 15, iss = null } = {}) {
    const decl = subSolarLatDeg;
    const kp = apToKp(ap);
    const out = [];

    // Diurnal bulge and pre-dawn trough — the page's own Jacchia term.
    const lstMax = bulgeLocalSolarTime(decl, decl);
    const lstMin = troughLocalSolarTime(-decl, decl);
    const contrast = diurnalContrast({ altKm: 400, latDeg: decl, sunDeclDeg: decl, f107Sfu, ap });
    out.push({
        id: 'bulge', name: 'Diurnal density bulge',
        latDeg: decl, lonDeg: lonAtLocalSolarTime(lstMax, subSolarLonDeg), altKm: 400,
        headingDeg: 270, pitchDeg: -10, colorHex: 0xffb057,
        placedBy: 'peak of the Jacchia diurnal term at the solar declination',
        blurb: 'The afternoon side of the thermosphere, heated all day and '
             + 'swollen. It lags the Sun by about two hours, so it sits EAST '
             + 'of the sub-solar point.',
        facts: [
            ['local solar time', `${lstMax.toFixed(1)} h`],
            ['vs pre-dawn at 400 km', `×${contrast.ratio.toFixed(2)} density`],
            ['T∞ here', `${Math.round(contrast.TinfHot)} K`],
        ],
    });
    out.push({
        id: 'trough', name: 'Pre-dawn density trough',
        latDeg: -decl, lonDeg: lonAtLocalSolarTime(lstMin, subSolarLonDeg), altKm: 400,
        headingDeg: 90, pitchDeg: -10, colorHex: 0x6fa8ff,
        placedBy: 'minimum of the Jacchia diurnal term',
        blurb: 'The coldest, thinnest thermosphere on the planet, just '
             + 'before dawn in the opposite hemisphere to the Sun. A satellite '
             + 'here feels the least drag of its whole orbit.',
        facts: [
            ['local solar time', `${lstMin.toFixed(1)} h`],
            ['T∞ here', `${Math.round(contrast.TinfCold)} K`],
        ],
    });

    // Auroral oval — the page's own oval band for the live Kp, at magnetic midnight.
    const band = auroralOvalLatBand(kp, 0);
    const mLat = (band.eq + band.pw) / 2;
    // The viewpoint sits 5° of magnetic latitude EQUATORWARD of the oval's
    // centre, looking toward the magnetic pole, so the curtains rise ahead
    // instead of the camera arriving inside one.
    const ovalPt = magneticMidnightPoint(mLat - 5, decl, subSolarLonDeg);
    const uOval = latLonToScene(ovalPt.latDeg, ovalPt.lonDeg);
    const towardPole = tangent(latLonToScene(DIPOLE_POLE.latDeg, DIPOLE_POLE.lonDeg), uOval);
    out.push({
        id: 'aurora', name: 'Auroral oval (magnetic midnight)',
        latDeg: ovalPt.latDeg, lonDeg: ovalPt.lonDeg, altKm: 140,
        headingDeg: towardPole ? headingDegOf(uOval, towardPole) : null, pitchDeg: 2, colorHex: 0x7dffb0,
        placedBy: 'the page\'s oval band at MLT 0 for Kp from the live Ap',
        blurb: 'Where precipitating electrons and Joule heating dump '
             + 'magnetospheric energy into the thermosphere. It moves '
             + 'equatorward as Kp rises. The curtains ahead are the oval '
             + 'drawn at the green (low) and red (high) emission heights; '
             + 'their brightness and folds are symbolic.',
        facts: [
            ['Kp (from Ap)', kp.toFixed(1)],
            ['oval edges (mag lat)', `${band.eq.toFixed(0)}°–${band.pw.toFixed(0)}°`],
            ['Joule ΔT∞ here', `${auroralHeatingK(mLat, ap) >= 0 ? '+' : ''}${Math.round(auroralHeatingK(mLat, ap))} K`],
        ],
    });

    // Airglow — the page's own emission table, viewed on the night side.
    const green = AIRGLOW_LAYERS.find(L => L.id === 'o-green');
    const red = AIRGLOW_LAYERS.find(L => L.id === 'o-red');
    const geo = AIRGLOW_LAYERS.find(L => L.id === 'geocorona');
    const antiLat = -decl, antiLon = wrapLon(subSolarLonDeg + 180);
    if (green) out.push({
        id: 'green-airglow', name: 'Green airglow layer',
        latDeg: antiLat, lonDeg: antiLon, altKm: 130,
        headingDeg: 90, pitchDeg: -3, colorHex: 0x6bff9e,
        placedBy: `the ${green.label} peak (${green.peakKm} km) on the night side`,
        blurb: green.note,
        facts: [['peak', `${green.peakKm} km`], ['wavelength', `${green.nm} nm`]],
    });
    if (red) out.push({
        id: 'red-airglow', name: 'Red-line F region',
        latDeg: 0, lonDeg: lonAtLocalSolarTime(22, subSolarLonDeg), altKm: 320,
        headingDeg: 270, pitchDeg: -8, colorHex: 0xff5a64,
        placedBy: `the ${red.label} peak (${red.peakKm} km), before local midnight`,
        blurb: red.note,
        facts: [['peak', `${red.peakKm} km`], ['wavelength', `${red.nm} nm`]],
    });

    // Exobase — where the engine's λ equals its scale height.
    const exo = exobaseAltitudeKm({ f107Sfu, ap });
    if (Number.isFinite(exo)) {
        const ph = pointPhysics({ altitudeKm: exo, f107Sfu, ap });
        out.push({
            id: 'exobase', name: 'Exobase',
            latDeg: decl, lonDeg: wrapLon(subSolarLonDeg), altKm: exo,
            headingDeg: 0, pitchDeg: -6, colorHex: 0xc58cff,
            placedBy: 'bisection for mean free path = scale height in the engine',
            blurb: 'Below here the air is a gas; above it, a spray of '
                 + 'independent ballistic atoms. Its height breathes with '
                 + 'the Sun: a hotter thermosphere lifts it.',
            facts: [
                ['altitude', `${Math.round(exo)} km`],
                ['λ = H', `${ph.mfp_km.toFixed(0)} km`],
                ['dominant', ph.dominant],
            ],
        });
    }

    // Geocorona — the H exosphere at the ceiling over the night side.
    if (geo) out.push({
        id: 'geocorona', name: 'Hydrogen geocorona',
        latDeg: antiLat, lonDeg: antiLon, altKm: 1900,
        headingDeg: 90, pitchDeg: -25, colorHex: 0x8c9cff,
        placedBy: 'the model ceiling over the anti-solar point',
        blurb: geo.note,
        facts: [['dominant', pointPhysics({ altitudeKm: 1900, f107Sfu, ap }).dominant],
                ['colour', 'FALSE — far ultraviolet']],
    });

    // The ISS — live, when the page has it.
    if (iss && Number.isFinite(iss.latDeg) && Number.isFinite(iss.lonDeg)) {
        out.push({
            id: 'iss', name: 'Alongside the ISS',
            latDeg: iss.latDeg, lonDeg: iss.lonDeg, altKm: clamp(iss.altKm ?? 420, EXPLORE.floorKm, EXPLORE.ceilKm),
            headingDeg: Number.isFinite(iss.headingDeg) ? iss.headingDeg : null,
            pitchDeg: -4, colorHex: 0xffffff,
            placedBy: 'the page\'s live ISS probe',
            blurb: 'The station flies through the upper thermosphere at '
                 + '7.7 km/s and loses about 2 km of altitude a month to the '
                 + 'drag you are looking at.',
            facts: [['altitude', `${Math.round(iss.altKm ?? 420)} km`]],
        });
    }
    return out;
}

/** Milestones: reached by crossing an altitude, anywhere on the planet. */
export const MILESTONES = Object.freeze([
    Object.freeze({ id: 'karman', name: 'Crossed the Kármán line', km: 100 }),
    Object.freeze({ id: 'floor', name: 'Reached the 80 km model floor', km: EXPLORE.floorKm, reach: 'down' }),
    Object.freeze({ id: 'ceiling', name: 'Reached the 2000 km model ceiling', km: EXPLORE.ceilKm, reach: 'up' }),
]);

/** Milestones reached by an altitude move (a crossing, or arriving at the floor/ceiling). */
export function milestonesReached(prevKm, altKm) {
    if (!Number.isFinite(prevKm) || !Number.isFinite(altKm)) return [];
    return MILESTONES.filter(m => {
        if (m.reach === 'down') return altKm <= m.km + 0.5 && prevKm > m.km + 0.5;
        if (m.reach === 'up') return altKm >= m.km - 0.5 && prevKm < m.km - 0.5;
        return (prevKm - m.km) * (altKm - m.km) < 0;
    });
}

/**
 * Has a camera at (lat, lon, alt) found this point of interest? Within
 * 600 km of ground distance and ±35 % in altitude (log).
 */
export function isAtPoi(cam, poi, { groundKm = 600, lnAlt = 0.35 } = {}) {
    if (!cam || !poi) return false;
    const g = groundDistanceKm(cam.latDeg, cam.lonDeg, poi.latDeg, poi.lonDeg);
    return g <= groundKm && Math.abs(Math.log(Math.max(1e-3, cam.altKm) / poi.altKm)) <= lnAlt;
}

/** Fraction of the altitude gauge (0 at the floor, 1 at the ceiling), log scale. */
export function gaugeFraction(altKm) {
    const lo = Math.log(MODEL_FLOOR_KM), hi = Math.log(MODEL_CEIL_KM);
    return clamp((Math.log(Math.max(1e-3, altKm)) - lo) / (hi - lo), 0, 1);
}
/** Inverse of `gaugeFraction`. */
export function gaugeAltitude(fraction) {
    const lo = Math.log(MODEL_FLOOR_KM), hi = Math.log(MODEL_CEIL_KM);
    return Math.exp(lo + clamp(fraction, 0, 1) * (hi - lo));
}
