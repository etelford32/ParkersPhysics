/**
 * spaceship-designer-flight.js — PURE flight-playback kernel for the Space Ship
 * Designer. No DOM, no three.js: node-tested by tests/spaceship-designer.mjs.
 *
 * The ascent itself is computed once by launch-physics.simulateAscent (via
 * spaceship-designer-engine.runAscent). This module turns that trajectory into
 * what the 3D view needs, frame by frame:
 *
 *   sampleTrajectory(traj, t)  — interpolated state at flight time t
 *   poseAt(sample, R_m)        — where the vehicle IS in the scene and which way
 *                                it POINTS: true metres over a true-radius
 *                                planet (no altitude compression — the planet
 *                                curving away under the vehicle is the point)
 *   flightEvents(result, design, body) — staging + fairing jettison times
 *   playbackRate(t, events, burn)      — the time warp
 *
 * SCENE FRAME (shared with spaceship-designer-3d.js): the pad is the origin,
 * +Y is local vertical at the pad, +X is downrange (due east — the launch that
 * collects the full rotation assist), and the planet's centre is (0, −R, 0).
 * A vehicle at altitude h and ground-track distance s sits at polar angle
 * θ = s/R from the pad's vertical, and points `pitch` above ITS local
 * horizontal — so its axis makes the angle θ + (π/2 − pitch) with +Y.
 */

/** Keys that are categorical (never interpolated — taken from the nearer sample). */
const DISCRETE = new Set(['stage', 'coasting', 'boundaryLayer', 'regime', 'nozzleState', 'separated']);

/**
 * State at flight time t (seconds after liftoff). Numeric keys present in both
 * bracketing samples are interpolated linearly; categorical keys come from the
 * nearer sample. Outside the trajectory the end samples are returned (copied).
 */
export function sampleTrajectory(traj, t) {
    if (!traj?.length) return null;
    if (t <= traj[0].t) return { ...traj[0] };
    const last = traj[traj.length - 1];
    if (t >= last.t) return { ...last };
    // Binary search — the trajectory is ~500–3000 samples and this runs per frame.
    let lo = 0, hi = traj.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (traj[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = traj[lo], b = traj[hi];
    const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
    const near = f < 0.5 ? a : b;
    const out = { t };
    for (const k of Object.keys(a)) {
        if (k === 't') continue;
        const va = a[k], vb = b[k];
        if (!DISCRETE.has(k) && typeof va === 'number' && typeof vb === 'number'
            && Number.isFinite(va) && Number.isFinite(vb)) {
            out[k] = va + (vb - va) * f;
        } else {
            out[k] = near[k];
        }
    }
    return out;
}

/**
 * Scene pose of the vehicle's aft reference point (stage 1's skin base) for a
 * trajectory sample. Returns { x, y, z, rotZ, axis:[x,y], up:[x,y], theta }.
 *   rotZ — rotation about +Z to apply to a +Y-up model (negative = toward +X).
 *   axis — the vehicle's nose direction in the scene (unit, z = 0).
 *   up   — local vertical under the vehicle (unit, z = 0).
 * `baseY` lifts the whole flight by the launch-mount height so the vehicle
 * leaves the mount, not the ground under it.
 */
export function poseAt(sample, R_m, baseY = 0) {
    const alt = Math.max(0, (sample?.alt_km || 0) * 1000);
    const s = (sample?.downrange_km || 0) * 1000;
    const pitch = ((sample?.pitch_deg ?? 90) * Math.PI) / 180;
    const theta = s / R_m;
    const r = R_m + alt + baseY;
    const x = r * Math.sin(theta);
    // r·cosθ − R loses nothing in doubles; written as (R+h)cosθ − R explicitly.
    const y = r * Math.cos(theta) - R_m;
    const tilt = theta + (Math.PI / 2 - pitch);
    return {
        x, y, z: 0,
        rotZ: -tilt,
        axis: [Math.sin(tilt), Math.cos(tilt)],
        up: [Math.sin(theta), Math.cos(theta)],
        theta,
    };
}

/**
 * The rotation that carries the planet's own (equirect-mapped) frame onto the
 * scene frame at the pad: the surface point (lat, lon) lands on +Y (up), local
 * EAST on +X (downrange) and local NORTH on −Z. Returned as the three scene-
 * frame ROWS (E, U, −N) of a proper rotation (det +1), so a planet-frame
 * vector v maps to (E·v, U·v, −N·v). The planet frame is three.js
 * SphereGeometry's: (lat φ, lon λ) sits at P = (cosφ cosλ, sinφ, −cosφ sinλ)
 * with u = (λ + 180°)/360°, which is the equirect texture convention.
 */
export function padBasis(latDeg, lonDeg) {
    const f = (latDeg * Math.PI) / 180, l = (lonDeg * Math.PI) / 180;
    const U = [Math.cos(f) * Math.cos(l), Math.sin(f), -Math.cos(f) * Math.sin(l)];
    const E = [-Math.sin(l), 0, -Math.cos(l)];
    const N = [-Math.sin(f) * Math.cos(l), Math.cos(f), Math.sin(f) * Math.sin(l)];
    return { E, U, Nneg: N.map((x) => -x) };
}

/**
 * Discrete events the view stages on the flight clock.
 *   staging — from simulateAscent's staging_events: stage `stage` burns out at
 *             t and (if another stage follows) is jettisoned.
 *   fairing — the payload fairing / launch-escape tower is jettisoned once
 *             dynamic pressure has fallen below FAIRING_Q_KPA (10 Pa) above
 *             20 km — the free-molecular-heating criterion real vehicles fly
 *             to within a few km. On an airless world it goes as soon as the
 *             vehicle clears 2 km (there is nothing to protect it from).
 *             Never for a capsule-less spaceplane nose. Visual only: the
 *             fairing's mass is not in the ascent (it is inside `dryFrac`).
 */
export const FAIRING_Q_KPA = 0.01;
export function flightEvents(result, design, body) {
    const ev = [];
    const nStages = design?.stages?.length || 0;
    for (const e of result?.staging_events || []) {
        if (e.stage < nStages) ev.push({ t: e.t, kind: 'staging', stage: e.stage });
        else ev.push({ t: e.t, kind: 'meco', stage: e.stage });
    }
    const nose = design?.payload?.nosecone || 'ogive';
    if (nose !== 'spaceplane') {
        const airless = !(body?.rho0_kg_m3 > 1e-6);
        const hit = (result?.trajectory || []).find((p) => airless
            ? p.alt_km > 2
            : (p.alt_km > 20 && (p.q_kPa ?? 1) < FAIRING_Q_KPA));
        if (hit) ev.push({ t: hit.t, kind: 'fairing' });
    }
    return ev.sort((a, b) => a.t - b.t);
}

/**
 * Playback speed (flight seconds per wall second) at flight time t.
 *   • Real time for the first REALTIME_S — the vehicle clearing the tower is
 *     the shot people came for, and at 25× it is gone in a frame.
 *   • Eases up to a cruise rate that plays the whole burn in ~CRUISE_WALL_S.
 *   • Drops to EVENT_RATE from 1.5 s before to 8 s after every staging and
 *     fairing event, so separation is watchable instead of a one-frame pop.
 * Pure function of t, so a flight replays identically.
 */
export const REALTIME_S = 4;
export const CRUISE_WALL_S = 24;
export const EVENT_RATE = 2.5;
export function playbackRate(t, events, burnS) {
    const cruise = Math.min(60, Math.max(6, (burnS || 300) / CRUISE_WALL_S));
    const ramp = smooth01((t - REALTIME_S) / 14);
    let rate = 1 + (cruise - 1) * ramp;
    for (const e of events || []) {
        if (e.kind !== 'staging' && e.kind !== 'fairing') continue;
        const d = t - e.t;
        if (d > -1.5 && d < 8) rate = Math.min(rate, EVENT_RATE);
        else if (d > -6 && d <= -1.5) rate = Math.min(rate, EVENT_RATE + (cruise - EVENT_RATE) * smooth01((-1.5 - d) / 4.5));
        else if (d >= 8 && d < 14) rate = Math.min(rate, EVENT_RATE + (cruise - EVENT_RATE) * smooth01((d - 8) / 6));
    }
    return rate;
}

/** Wall-clock seconds the whole burn takes to play (dt-integrated). For tests + the UI. */
export function playbackDuration(burnS, events, dt = 1 / 60) {
    let t = 0, wall = 0;
    while (t < burnS && wall < 600) { t += playbackRate(t, events, burnS) * dt; wall += dt; }
    return wall;
}

/**
 * Flight-relevant ambient for the view: pressure fraction p/p₀ at altitude on
 * the body's exponential atmosphere (0 on an airless world). Drives the sky
 * colour, fog, star visibility and whether the exhaust leaves a trail.
 */
export function airFraction(body, alt_m) {
    if (!(body?.p0_pa > 0) || !(body?.rho0_kg_m3 > 1e-6)) return 0;
    return Math.exp(-Math.max(0, alt_m) / ((body.H_km || 8.5) * 1000));
}

function smooth01(x) { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); }
