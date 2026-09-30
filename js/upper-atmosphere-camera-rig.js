/**
 * upper-atmosphere-camera-rig.js — the camera RIG: lens, pivot, pan,
 * swivel, keyboard orbit, and the LIMB VIEWS that separate the layers
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE kernel. No THREE, no DOM, no ambient time. Node-tested by
 * `tests/upper-atmosphere-camera-rig.mjs`. Vectors are plain [x, y, z] in
 * the canonical scene frame (`latLonToScene`: +X Greenwich, +Y north,
 * −Z = 90°E; 1 unit = 1 R⊕). `js/upper-atmosphere-camera.js` applies what
 * this module computes; it does no geometry of its own for these moves.
 *
 * Why a rig, and not just OrbitControls with pan switched on:
 *
 *   1. THE LAYERS ARE ONLY SEPARABLE AT THE LIMB. From the default ~3 R⊕
 *      view the whole 50–2000 km band is a 0.3 R⊕ rim; the mesosphere is
 *      35 km of it, about two pixels. Looking ACROSS the atmosphere at the
 *      limb, the same band spans the frame — that is the view every
 *      photograph of the airglow from the ISS is. `limbViewPose` puts the
 *      camera in the tangent plane of a model-placed site, aims it at the
 *      band so the band fills a stated fraction of a TELEPHOTO frame with
 *      the ground limb still in view (the altitude reference), and hands
 *      back an orbit pivot ON the limb with the LOCAL RADIAL as the orbit
 *      axis — so a drag swings the camera around the limb point (every
 *      azimuth keeps the point on the limb) or tilts it up to look down.
 *      That needs OrbitControls rebuilt with a non-+Y up (vendored r160
 *      caches its orbit axis at construction); the controller does that.
 *
 *   2. THE LENS IS A CONTROL. Narrowing the field of view compresses depth
 *      along the sightline and magnifies the band without moving the
 *      camera through it; `focalLengthMm` states it as a 35 mm-equivalent
 *      focal length so the number means something.
 *
 *   3. PAN AND SWIVEL MOVE THE PIVOT, AND THE PIVOT IS BOUNDED. Pan moves
 *      the pivot and the camera together; swivel turns the view about the
 *      camera (a tripod head) by moving the pivot around the camera. Both
 *      keep the pivot within `pivotLimit` of Earth's centre — the TIGA
 *      lesson: an unbounded pan walks the pivot into empty space and every
 *      later drag orbits nothing. A swivel that would put the pivot out of
 *      bounds SHORTENS the pivot distance along the same sightline instead
 *      of moving it sideways, so the picture never jumps.
 */

import { latLonToScene, sceneToLatLon, R_EARTH_KM } from './upper-atmosphere-column.js';

const DEG = Math.PI / 180;

export const RIG = Object.freeze({
    fovMinDeg: 2,             // ~690 mm equivalent: a 35 km layer across the frame
    fovMaxDeg: 90,            // 12 mm equivalent
    fovDefaultDeg: 40,        // the page's historical camera
    pivotLimitRe: 6,          // pan / swivel keep the pivot inside this radius…
    pivotMarginRe: 0.1,       // …or just outside the camera's own radius
    surfaceFloorRe: 1 + 20 / R_EARTH_KM,   // orbit camera never below 20 km
    swivelSens: 0.0035,       // rad per pixel — the fly camera's look sensitivity
    polarMinRad: 0.03,        // keyboard / swivel polar clamp from the orbit axis
    keyOrbitRadS: 1.1,        // arrow keys: orbit rate
    keyPanFracS: 0.6,         // shift+arrows: frame heights per second
    keyZoomPerS: 2.2,         // +/− : distance factor per second
    keyFovPerS: 1.8,          // [ / ] : FOV factor per second
    limbFill: 0.5,            // a limb view makes the band this fraction of the frame…
    limbReserveBottom: 0.22,  // …of the part ABOVE this bottom strip, which the page's
                              // time scrubber and render buttons cover (measured: ~110 of
                              // 500 px on a 1280-wide layout). The ground limb must be
                              // SEEN, so it is framed above the chrome, not under it.
});

/** The drag tools the page offers for the left mouse button / one finger. */
export const DRAG_TOOLS = Object.freeze(['orbit', 'pan', 'swivel']);

// ── Small vector helpers (plain arrays) ────────────────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 0 ? scale(a, 1 / l) : [0, 0, 0]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function rotate(v, k, a) {
    const c = Math.cos(a), s = Math.sin(a);
    const kv = cross(k, v), kd = dot(k, v);
    return [
        v[0] * c + kv[0] * s + k[0] * kd * (1 - c),
        v[1] * c + kv[1] * s + k[1] * kd * (1 - c),
        v[2] * c + kv[2] * s + k[2] * kd * (1 - c),
    ];
}
/** Unit component of v perpendicular to unit u (null when v ∥ u). */
function perp(v, u) {
    const t = sub(v, scale(u, dot(v, u)));
    const l = len(t);
    return l > 1e-12 ? scale(t, 1 / l) : null;
}
/** Any unit vector perpendicular to unit u. */
function anyPerp(u) {
    return perp(Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], u);
}
export const rigVec = Object.freeze({ dot, sub, add, scale, len, norm, cross, rotate, perp });

// ── Lens ───────────────────────────────────────────────────────────────────

/** Clamp a vertical field of view into the rig's range. */
export function clampFov(deg) {
    const d = Number(deg);
    if (!Number.isFinite(d)) return RIG.fovDefaultDeg;
    return Math.min(RIG.fovMaxDeg, Math.max(RIG.fovMinDeg, d));
}

/**
 * 35 mm-equivalent focal length of a VERTICAL field of view (the 24 mm
 * frame height): f = 12 mm / tan(fov/2). 40° ≈ 33 mm; 4° ≈ 344 mm.
 */
export function focalLengthMm(fovDeg) {
    return 12 / Math.tan(0.5 * clampFov(fovDeg) * DEG);
}
export function fovForFocalMm(mm) {
    return clampFov(2 * Math.atan(12 / Math.max(1e-6, mm)) / DEG);
}

/**
 * The world length one frame HEIGHT covers at distance `dist` — what a pan
 * of "one screen" moves the pivot by, so a pan tracks the cursor at the
 * pivot's depth for any lens.
 */
export function frameHeightAt(dist, fovDeg) {
    return 2 * dist * Math.tan(0.5 * clampFov(fovDeg) * DEG);
}

// ── The pivot bound ────────────────────────────────────────────────────────

/** The radius the pivot may reach: the rig limit, or just past the camera. */
export function pivotLimit(position, limitRe = RIG.pivotLimitRe) {
    return Math.max(limitRe, len(position) + RIG.pivotMarginRe);
}

/**
 * Bring a pivot back inside the bound by translating the pivot AND the
 * camera by the same vector (the view does not rotate, the frame slides).
 * Returns { position, target, shifted }.
 */
export function clampPivot({ position, target, limitRe = RIG.pivotLimitRe }) {
    const L = pivotLimit(position, limitRe);
    const r = len(target);
    if (!(r > L)) return { position, target, shifted: false };
    const shift = scale(target, (L - r) / r);     // pulls the target in radially
    return { position: add(position, shift), target: add(target, shift), shifted: true };
}

/** Keep a camera above the surface floor (radially — no sideways motion). */
export function liftAboveSurface(position, floorRe = RIG.surfaceFloorRe) {
    const r = len(position);
    if (!(r < floorRe)) return position;
    if (!(r > 1e-9)) return [0, floorRe, 0];
    return scale(position, floorRe / r);
}

// ── Pan / swivel / keyboard orbit / dolly ──────────────────────────────────

/**
 * Screen-space pan: move the pivot and the camera together by a fraction of
 * the frame height along the camera's right / screen-up vectors. Returns
 * { position, target } after the pivot bound.
 */
export function panPivot({ position, target, right, screenUp, dxFrac = 0, dyFrac = 0, fovDeg = RIG.fovDefaultDeg,
                          limitRe = RIG.pivotLimitRe }) {
    const h = frameHeightAt(len(sub(target, position)), fovDeg);
    const m = add(scale(right, dxFrac * h), scale(screenUp, dyFrac * h));
    const out = clampPivot({ position: add(position, m), target: add(target, m), limitRe });
    return { position: out.position, target: out.target };
}

/**
 * A tripod-head swivel: turn the sightline about the CAMERA by (yaw about
 * `up`, pitch about the camera's right), keeping the camera where it is and
 * moving the pivot. Positive yaw turns RIGHT, positive pitch looks UP. The
 * sightline stays at least `RIG.polarMinRad` from ±up (no flip through the
 * zenith). The pivot distance is kept unless that would carry the pivot out
 * of bounds, in which case it is SHORTENED along the new sightline (never
 * shifted sideways — the picture must not jump). Returns the new target.
 */
export function swivelTarget({ position, target, up, yawRad = 0, pitchRad = 0,
                               limitRe = RIG.pivotLimitRe, minDist = 0.02 }) {
    const u = norm(up);
    const dist = len(sub(target, position));
    let f = norm(sub(target, position));
    if (!(dist > 0)) f = anyPerp(u);
    // Yaw about up (a negative rotation turns right for a right-handed frame).
    f = rotate(f, u, -yawRad);
    // Pitch about the camera's right, clamped away from the zenith / nadir.
    const right = perp(cross(f, u), f) || anyPerp(f);
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(f, u))));   // 0 = looking straight up
    const next = Math.min(Math.PI - RIG.polarMinRad, Math.max(RIG.polarMinRad, theta - pitchRad));
    f = norm(rotate(f, right, theta - next));
    // Fit the pivot distance inside the bound along the new sightline.
    const L = pivotLimit(position, limitRe);
    const pf = dot(position, f);
    const disc = pf * pf - dot(position, position) + L * L;
    let s = Math.max(minDist, dist || minDist);
    if (disc >= 0) s = Math.max(minDist, Math.min(s, -pf + Math.sqrt(disc)));
    else s = minDist;
    return add(position, scale(f, s));
}

/** Angle (rad) of the camera offset from the orbit axis `up`. */
export function polarAngle(position, target, up) {
    const o = norm(sub(position, target));
    return Math.acos(Math.max(-1, Math.min(1, dot(o, norm(up)))));
}

/**
 * Orbit the camera about the pivot by (azimuth about `up`, polar change away
 * from `up`), holding the distance; the polar angle is clamped to
 * [polarMin, π − polarMin] like OrbitControls. Returns the new position.
 */
export function orbitAround({ position, target, up, dAzRad = 0, dPolarRad = 0,
                              polarMin = RIG.polarMinRad, polarMax = Math.PI - RIG.polarMinRad }) {
    const u = norm(up);
    let off = sub(position, target);
    const r = len(off);
    if (!(r > 0)) return position;
    off = rotate(off, u, dAzRad);
    const h = perp(off, u) || anyPerp(u);
    const th = Math.acos(Math.max(-1, Math.min(1, dot(off, u) / r)));
    const next = Math.min(polarMax, Math.max(polarMin, th + dPolarRad));
    const o = add(scale(u, r * Math.cos(next)), scale(h, r * Math.sin(next)));
    return add(target, o);
}

/** Move the camera along the pivot line by `factor` (<1 in, >1 out), clamped. */
export function dollyToward({ position, target, factor, minDist = 0.02, maxDist = Infinity }) {
    const off = sub(position, target);
    const r = len(off);
    if (!(r > 0) || !(factor > 0)) return position;
    const next = Math.min(maxDist, Math.max(minDist, r * factor));
    return add(target, scale(off, next / r));
}

// ── Limb views ─────────────────────────────────────────────────────────────

/**
 * Sites the limb views can be taken over. The four local-time sites come
 * straight from the sub-solar point; `pois` (the explore model's
 * `pointsOfInterest`, already placed by the page's own model) contributes
 * the diurnal bulge, the pre-dawn trough and the auroral oval, so those
 * three are wherever the model says they are right now — never typed.
 */
export function limbSites({ subSolarLatDeg = 0, subSolarLonDeg = 0, pois = [] } = {}) {
    const w = (l) => ((l + 540) % 360) - 180;
    const out = [
        { id: 'noon', name: 'Noon limb', latDeg: subSolarLatDeg, lonDeg: w(subSolarLonDeg),
          placedBy: 'the sub-solar point (local noon)' },
        { id: 'dusk', name: 'Dusk terminator', latDeg: 0, lonDeg: w(subSolarLonDeg + 90),
          placedBy: 'the equator at 18:00 local solar time' },
        { id: 'midnight', name: 'Midnight limb', latDeg: -subSolarLatDeg, lonDeg: w(subSolarLonDeg + 180),
          placedBy: 'the anti-solar point (local midnight)' },
        { id: 'dawn', name: 'Dawn terminator', latDeg: 0, lonDeg: w(subSolarLonDeg - 90),
          placedBy: 'the equator at 06:00 local solar time' },
    ];
    for (const id of ['bulge', 'trough', 'aurora']) {
        const p = (pois || []).find((q) => q?.id === id);
        if (p && Number.isFinite(p.latDeg) && Number.isFinite(p.lonDeg)) {
            out.push({ id, name: p.name, latDeg: p.latDeg, lonDeg: w(p.lonDeg), placedBy: p.placedBy || 'the model' });
        }
    }
    return out;
}

/**
 * Where a limb camera stands: ABOVE the band it frames — never in it. From
 * inside a band a horizontal sightline runs through the band's densest gas
 * on the NEAR side for hundreds of km and the column fills the frame as haze
 * (measured on the first limb screenshots, camera at 89 km framing the
 * mesosphere). From above, every tangent ray's lowest point is its tangent
 * height, so the layers stack by tangent height across the frame — the
 * geometry of every airglow photograph from the ISS (which is why the floor
 * is the ISS's own ~400 km).
 */
export function limbCameraAltKm(maxKm) {
    return Math.max(400, maxKm + 250);
}

/**
 * Elevation (rad) of the ray from camera C TANGENT to the sphere of radius
 * r, in the limb view's vertical plane, measured from the horizontal ĥ
 * (tangent at the aim point) toward the local radial P̂. C = rMid·P̂ − d·ĥ,
 * so the direction to Earth's centre sits at atan2(−rMid, d) and the tangent
 * ray is asin(r/|C|) above it. el(rMid) = 0 exactly (ĥ IS that tangent).
 */
export function tangentElevation(r, rMid, d) {
    const rc = Math.hypot(rMid, d);
    return Math.atan2(-rMid, d) + Math.asin(Math.min(1, r / rc));
}

/**
 * A telephoto view ACROSS the atmosphere at a site's limb, framing the band
 * [minKm, maxKm].
 *
 * Geometry: P̂ is the site's radial, ĥ the look heading (a tangent at P̂,
 * compass `headingDeg`). The camera stands at `limbCameraAltKm` in the
 * site's vertical plane, on the tangent line of the band's MID-height
 * sphere at P̂ (C = rMid·P̂ − d·ĥ, d = √(r_c² − rMid²)) — so the site sits on
 * the camera's limb at exactly the band's mid-height. In that plane the
 * frame is sized from the TANGENT rays (`tangentElevation`) to the band top,
 * the band bottom and the ground (the altitude reference); the band itself
 * fills ≥ `fill` of it unless holding the ground in frame needs a wider
 * lens. Up is P̂, so the limb is level across the frame.
 *
 * @returns {{position:number[], target:number[], up:number[], forward:number[],
 *           fovDeg:number, standoffRe:number, camAltKm:number,
 *           elevations:{top:number,bottom:number,ground:number,centre:number},
 *           latDeg:number, lonDeg:number, headingDeg:number}}
 */
export function limbViewPose({ latDeg, lonDeg, minKm, maxKm, headingDeg = null, fill = RIG.limbFill, camAltKm = null,
                               reserveBottom = RIG.limbReserveBottom }) {
    const P = latLonToScene(latDeg, lonDeg);
    // Heading: north unless the site is within 10° of a pole (east there).
    const hd = Number.isFinite(headingDeg) ? headingDeg : (Math.abs(latDeg) > 80 ? 90 : 0);
    const east = perp(cross([0, 1, 0], P), P) || anyPerp(P);
    const north = cross(P, east);
    const h = norm(add(scale(north, Math.cos(hd * DEG)), scale(east, Math.sin(hd * DEG))));
    const lo = Math.max(0, Math.min(minKm, maxKm)), hi = Math.max(minKm, maxKm);
    const rLo = 1 + lo / R_EARTH_KM, rHi = 1 + hi / R_EARTH_KM, rMid = 0.5 * (rLo + rHi);
    const hCam = Math.max(hi + 1, Number.isFinite(camAltKm) ? camAltKm : limbCameraAltKm(hi));
    const rc = 1 + hCam / R_EARTH_KM;
    const d = Math.sqrt(rc * rc - rMid * rMid);
    const C = add(scale(P, rMid), scale(h, -d));

    const eTop = tangentElevation(rHi, rMid, d);
    const eBot = tangentElevation(rLo, rMid, d);
    const eGnd = tangentElevation(1, rMid, d);
    const low = Math.min(eGnd, eBot), high = eTop;
    // The usable frame is the part above the reserved bottom strip.
    const usable = Math.max(0.3, 1 - reserveBottom);
    const needAll = (high - low) * 1.18 / usable;
    const needBand = (eTop - eBot) / Math.max(0.05, fill) / usable;
    const fov = Math.max(needAll, needBand);
    const fovDeg = clampFov(fov / DEG);
    // Content centred in the usable part: the frame centre sits
    // reserveBottom/2 of a frame BELOW the content centre.
    const centre = 0.5 * (low + high) - 0.5 * reserveBottom * (fovDeg * DEG);
    const fwd = norm(add(scale(h, Math.cos(centre)), scale(P, Math.sin(centre))));
    return {
        position: C,
        target: add(C, scale(fwd, d)),
        up: P,
        forward: fwd,
        fovDeg,
        standoffRe: d,
        camAltKm: hCam,
        elevations: { top: eTop, bottom: eBot, ground: eGnd, centre },
        latDeg, lonDeg, headingDeg: hd,
    };
}

/**
 * Where a camera is, in words the readout prints: altitude, the sub-camera
 * point, and the pivot's range and height. Plain numbers only.
 */
export function describeRig({ position, target, fovDeg }) {
    const r = len(position);
    const ll = sceneToLatLon(position);
    const range = len(sub(target, position));
    return {
        altKm: (r - 1) * R_EARTH_KM,
        latDeg: ll.latDeg, lonDeg: ll.lonDeg,
        pivotRangeKm: range * R_EARTH_KM,
        pivotAltKm: (len(target) - 1) * R_EARTH_KM,
        fovDeg: clampFov(fovDeg),
        focalMm: focalLengthMm(fovDeg),
    };
}
