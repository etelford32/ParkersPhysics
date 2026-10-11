/**
 * upper-atmosphere-sat-view.js — the close-up: how the camera chases one
 * spacecraft, and how big that spacecraft is drawn
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE (plain arrays, no three.js, no DOM, no clock; node-gated by
 * tests/upper-atmosphere-sat-view.mjs). The rules behind
 * js/upper-atmosphere-camera.js's chase follow and the satellite avatars
 * in js/upper-atmosphere-globe.js. Units: scene R⊕ (1 = 6371 km), seconds.
 *
 * THE FRAME IS LVLH. Every pose is expressed in the target's own
 * local-vertical / local-horizontal frame — `up` = radial out, `along` =
 * the velocity with its radial part removed, `cross` = up × along (so
 * along × cross = up: right-handed). A chase camera parked "behind and a
 * little above" therefore stays behind and above as the orbit carries the
 * target round the planet, and a drag that orbits the camera about the
 * target reads the same at every point of the orbit.
 *
 * THE CAMERA TRACKS EXACTLY; ONLY THE USER'S INPUT IS EASED. A LEO
 * target moves 7.7 km/s. At 10 km range an eased position lags it by
 * degrees per frame and the spacecraft slides out of the frame (the
 * star-collider rule: an eased follow trailed its core by 75° of orbit —
 * measured there). So the eye is pos + dist·dir(az, el) with pos the
 * target's position THIS frame, and the easing lives in az/el/dist alone.
 *
 * DISTANCE IS LOGARITHMIC. The useful range runs from ~10 km (the model
 * fills a third of the frame) to ~3800 km (the whole limb and an orbit
 * arc); a wheel notch multiplies by ZOOM_NOTCH so one notch is the same
 * fraction of the view at both ends.
 *
 * THE MODEL IS SYMBOLIC AND SAYS SO. A 109 m station is 1.7e-5 R⊕ — three
 * orders below float32's grain at r = 1.07, and invisible at any range you
 * can also see the planet from. The models are drawn at an artistic span
 * (~0.04 R⊕, satellite-models.js) and `modelScale` HOLDS their angular
 * size below MODEL_REF_R: zooming in past that range keeps the spacecraft
 * the same size in the frame while the planet, the orbit arc and its
 * neighbours grow — which is what makes the zoom read as approach rather
 * than as a wall of hull. The HUD prints the factor and the true span.
 *
 * THE NEAR PLANE MUST FOLLOW THE CHASE DISTANCE. The globe's rule is
 * 0.25 × camera altitude (100 km at a 400 km orbit); a camera 10 km behind
 * a station would clip its own target. `nearPlaneFor` takes both.
 */

export const CHASE = Object.freeze({
    minR: 0.0015,          // 9.6 km
    maxR: 0.6,             // 3800 km
    defaultR: 0.03,        // 190 km
    azDefault: Math.PI,    // behind the target, looking along its velocity
    elDefault: 0.32,       // ~18° above the orbit plane: the limb sits under the target
    elMin: -1.25,
    elMax: 1.45,
    zoomNotch: 1.18,       // one wheel notch
    tauOrbit: 0.14,        // s — easing of the USER's az/el
    tauZoom: 0.18,         // s — easing of the USER's distance
    dragSens: 0.0065,      // rad per px
    keyOrbitRate: 1.6,     // rad/s on A/D, Q/E
    keyZoomRate: 1.4,      // e-folds/s on W/S
});

export const ARTISTIC_SPAN_R = 0.04;  // satellite-models.js draws a spacecraft ~this across (255 km)
export const MODEL_REF_R = 0.08;      // below this range the model holds its angular size
export const MODEL_MIN_SCALE = 0.01;  // and never shrinks below this (a 0.4 km symbol)

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

/**
 * The LVLH basis at a position with a velocity: { up, along, cross }.
 * A velocity that is zero or purely radial (a seeded target before its
 * first step) falls back to the eastward tangent so the frame is always
 * defined.
 */
export function lvlhBasis(pos, vel) {
    const up = unit(pos);
    let t = vel ? [vel[0] - up[0] * dot(vel, up), vel[1] - up[1] * dot(vel, up), vel[2] - up[2] * dot(vel, up)] : [0, 0, 0];
    if (norm(t) < 1e-9) {
        // East on this page's frame (+Y north, −Z = 90°E): north × up.
        t = cross([0, 1, 0], up);
        if (norm(t) < 1e-9) t = [1, 0, 0];
    }
    const along = unit(t);
    return { up, along, cross: cross(up, along) };
}

/** Unit direction from the target toward the eye for an az/el in the LVLH frame. */
export function chaseDirection(az, el, basis) {
    const ce = Math.cos(el), se = Math.sin(el), ca = Math.cos(az), sa = Math.sin(az);
    const { up, along, cross: cr } = basis;
    return [
        ce * (ca * along[0] + sa * cr[0]) + se * up[0],
        ce * (ca * along[1] + sa * cr[1]) + se * up[1],
        ce * (ca * along[2] + sa * cr[2]) + se * up[2],
    ];
}

/** The chase pose: { eye, target, up } for a target at pos moving along vel. */
export function chasePose({ pos, vel, az = CHASE.azDefault, el = CHASE.elDefault, dist = CHASE.defaultR }) {
    const basis = lvlhBasis(pos, vel);
    const d = chaseDirection(az, el, basis);
    return {
        eye: [pos[0] + dist * d[0], pos[1] + dist * d[1], pos[2] + dist * d[2]],
        target: [pos[0], pos[1], pos[2]],
        up: basis.up,
        basis,
    };
}

/**
 * The inverse: the az/el/dist of an eye already standing somewhere near the
 * target (the end of a fly-in), so a chase can begin EXACTLY where the
 * flight left the camera and ease to its defaults — never a snap.
 */
export function chaseFromEye(eye, pos, vel) {
    const basis = lvlhBasis(pos, vel);
    const off = [eye[0] - pos[0], eye[1] - pos[1], eye[2] - pos[2]];
    const dist = norm(off);
    if (dist < 1e-12) return { az: CHASE.azDefault, el: CHASE.elDefault, dist: CHASE.minR };
    const u = [off[0] / dist, off[1] / dist, off[2] / dist];
    const el = Math.asin(clamp(dot(u, basis.up), -1, 1));
    const az = Math.atan2(dot(u, basis.cross), dot(u, basis.along));
    return { az, el: clamp(el, CHASE.elMin, CHASE.elMax), dist: clamp(dist, CHASE.minR, CHASE.maxR) };
}

/** A zoom by `notches` wheel notches (positive = closer), clamped to the range. */
export function zoomDistance(dist, notches) {
    return clamp(dist * Math.pow(CHASE.zoomNotch, -notches), CHASE.minR, CHASE.maxR);
}

/** A zoom by a plain factor (the ± buttons), clamped. */
export function scaleDistance(dist, factor) {
    return clamp(dist * (factor > 0 ? factor : 1), CHASE.minR, CHASE.maxR);
}

/** A drag of (dx, dy) px orbits the camera about the target; el is clamped, az wraps. */
export function orbitBy(az, el, dx, dy, sens = CHASE.dragSens) {
    let a = az - dx * sens;
    a = ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return { az: a, el: clamp(el + dy * sens, CHASE.elMin, CHASE.elMax) };
}

/** Frame-rate independent first-order ease factor. */
export function easeK(dt, tau) { return 1 - Math.exp(-Math.max(0, dt) / Math.max(1e-3, tau)); }

/** The shortest angular step from a toward b (for easing a wrapped azimuth). */
export function angleTowards(a, b, k) {
    let d = b - a;
    d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return a + d * k;
}

/**
 * The avatar's scale at a camera range: 1 beyond MODEL_REF_R (the model is
 * its artistic size and shrinks with distance like anything else), and
 * dist / MODEL_REF_R inside it (a constant angular size), floored.
 */
export function modelScale(dist) {
    if (!(dist > 0)) return 1;
    return clamp(dist / MODEL_REF_R, MODEL_MIN_SCALE, 1);
}

/**
 * The camera's near plane: the globe's own rule (0.25 × altitude, in
 * [0.002, 0.01]) tightened by the chase range when one is set, so the
 * target is never clipped, with a floor that keeps far/near under 5×10⁵.
 */
export function nearPlaneFor(altR, chaseDist = null) {
    let near = clamp(0.25 * altR, 0.002, 0.01);
    if (chaseDist > 0) near = Math.min(near, Math.max(2e-4, 0.2 * chaseDist));
    return near;
}

/**
 * The duration of a fly-in from `fromDist` R⊕ away: 0.9 s next door, 2.2 s
 * from across the stage, on a log so the camera never crawls or lurches.
 */
export function flyInDuration(fromDist) {
    const d = Math.max(0, fromDist || 0);
    return clamp(0.9 + 0.55 * Math.log10(1 + d / 0.05), 0.9, 2.2);
}

/**
 * The next spacecraft by altitude. `list` is [{ id, altKm }], `dir` +1 for
 * the next higher, −1 for the next lower; ties and the current id are
 * skipped; past the top it wraps to the lowest (and vice versa) so the
 * tour never dead-ends. Returns the entry or null for an empty list.
 */
export function altitudeNeighbour(list, { id = null, altKm = 0 } = {}, dir = 1) {
    const rows = (list || []).filter((r) => r && Number.isFinite(r.altKm) && r.id !== id);
    if (!rows.length) return null;
    let best = null;
    for (const r of rows) {
        const ahead = dir > 0 ? r.altKm > altKm : r.altKm < altKm;
        if (!ahead) continue;
        if (!best || (dir > 0 ? r.altKm < best.altKm : r.altKm > best.altKm)) best = r;
    }
    if (best) return best;
    // Wrap: the lowest when climbing past the top, the highest when descending past the bottom.
    return rows.reduce((b, r) => (!b || (dir > 0 ? r.altKm < b.altKm : r.altKm > b.altKm)) ? r : b, null);
}

/** Orbital speed from the velocity vector in R⊕/s, in km/s. */
export const speedKmS = (vel, reKm = 6371) => norm(vel || [0, 0, 0]) * reKm;

/**
 * Which model family stands in for a catalogue object. A name is a
 * catalogue string, so the tests are loose on purpose; the family only
 * picks a silhouette (satellite-models.js), never a number.
 */
export function modelFamily({ noradId = null, name = '', group = '' } = {}) {
    const n = String(name || '').toUpperCase();
    if (noradId === 25544) return 'iss';
    if (noradId === 20580) return 'hubble';
    if (/\bDEB\b|DEBRIS|FRAGMENT/.test(n) || /debris/.test(group)) return 'debris';
    if (/\bR\/B\b|ROCKET BODY|\bAKM\b|\bPAM\b/.test(n)) return 'rocket';
    if (/^STARLINK/.test(n) || group === 'starlink') return 'starlink';
    if (/^IRIDIUM/.test(n) || group === 'iridium') return 'iridium';
    if (/^ONEWEB/.test(n) || group === 'oneweb') return 'iridium';
    if (/^(ISS|TIANGONG|CSS)\b/.test(n) || group === 'stations') return 'iss';
    return 'generic';
}

/** True spans (m) for the disclosure line, by family — order of magnitude, published figures. */
export const TRUE_SPAN_M = Object.freeze({
    iss: 109, hubble: 13, starlink: 3, iridium: 9, rocket: 12, debris: 0.5, generic: 5,
});

/**
 * THE SAFE FRAME. The canvas is full-bleed under floating docks (the camera
 * dock on the right, the render and time docks along the bottom, the
 * altitude column on the left), so a target aimed at the canvas CENTRE can
 * sit under the readout — it did. Given the stage size and the live chrome
 * rects (measured by the page, never typed), the clear box is the stage
 * minus every dock that walls off a side: a rect in the right half taller
 * than a third of the stage pushes the right edge in, one in the left half
 * the left edge, one in the bottom half the bottom, a wide one along the
 * top the top. A box narrower or shorter than `minFrac` of the stage (a
 * phone, every dock expanded) falls back to the whole stage. Returns the
 * centre of the clear box and the box itself.
 */
export function safeCentre(stage, rects = [], { minFrac = 0.35 } = {}) {
    const W = stage.w, H = stage.h;
    let left = 0, right = W, top = 0, bottom = H;
    for (const r of rects || []) {
        if (!r || !(r.w > 0) || !(r.h > 0)) continue;
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        // A wide rect is a band (top or bottom, by its centre) before it is
        // anything else: a phone's camera dock spans the width.
        if (r.w > 0.5 * W) { if (cy > H / 2) bottom = Math.min(bottom, r.y); else top = Math.max(top, r.y + r.h); }
        else if (r.h > 0.3 * H) { if (cx > W / 2) right = Math.min(right, r.x); else left = Math.max(left, r.x + r.w); }
        else if (cy > H / 2) bottom = Math.min(bottom, r.y);
    }
    // A box under the floor is not abandoned for the whole stage (that put
    // the centre on the camera dock's edge at a 742 px stage — measured): it
    // is widened to the floor ABOUT ITS OWN CENTRE, clamped to the stage, so
    // the target still sits in the clear strip rather than under the dock.
    if (right - left < minFrac * W) {
        const c = (left + right) / 2, half = minFrac * W / 2;
        left = clamp(c - half, 0, W - 2 * half); right = left + 2 * half;
    }
    if (bottom - top < minFrac * H) {
        const c = (top + bottom) / 2, half = minFrac * H / 2;
        top = clamp(c - half, 0, H - 2 * half); bottom = top + 2 * half;
    }
    return { cx: (left + right) / 2, cy: (top + bottom) / 2, box: { left, right, top, bottom } };
}

/**
 * THE ARC FLIGHT. A straight fly-in between two spacecraft on opposite
 * sides of the planet is a chord through it (measured: the tour's hop from
 * one Starlink plane to another dived into the Earth and came out the far
 * side). `arcSpec` describes the path from eye p0 to eye p1 instead as a
 * great-circle slerp of the direction with the radius lerped and LIFTED by
 * a bulge ∝ the angle swept (a 180° hop pulls out ~1.1 R⊕ at mid-arc, so
 * the planet turns below); the look point sweeps the same way between l0
 * and l1 so the destination arrives in frame. Below ARC_MIN_ANGLE the path
 * is the plain lerp (a local hop must not loop). `arcAt(spec, k)` is the
 * pose at eased fraction k ∈ [0, 1]; k = 0 and 1 are EXACT.
 */
export const ARC_MIN_ANGLE = 0.03;      // rad: under this a flight is a straight lerp
export const ARC_BULGE_PER_RAD = 0.35;  // R⊕ of lift per radian swept

function slerpDir(a, b, k) {
    const d = clamp(dot(a, b), -1, 1), th = Math.acos(d);
    if (th < 1e-6) return unit([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
    if (Math.PI - th < 1e-6) {
        // Antipodal: pick a perpendicular to turn through.
        let ax = cross(a, [0, 1, 0]); if (norm(ax) < 1e-6) ax = cross(a, [1, 0, 0]);
        ax = unit(ax);
        const c = Math.cos(k * Math.PI), sn = Math.sin(k * Math.PI);
        return [a[0] * c + ax[0] * sn, a[1] * c + ax[1] * sn, a[2] * c + ax[2] * sn];
    }
    const s = Math.sin(th), wa = Math.sin((1 - k) * th) / s, wb = Math.sin(k * th) / s;
    return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
}

export function arcSpec(p0, p1, l0, l1) {
    const r0 = norm(p0), r1 = norm(p1);
    const d0 = unit(p0), d1 = unit(p1);
    const angle = Math.acos(clamp(dot(d0, d1), -1, 1));
    const straight = angle < ARC_MIN_ANGLE || r0 < 1e-9 || r1 < 1e-9;
    return {
        p0: [...p0], p1: [...p1], l0: [...l0], l1: [...l1],
        r0, r1, d0, d1, angle, straight,
        bulge: straight ? 0 : ARC_BULGE_PER_RAD * angle,
        ld0: unit(l0), ld1: unit(l1), lr0: norm(l0), lr1: norm(l1),
        // The path length the duration is sized from: the arc plus the climb.
        length: straight ? norm(sub3(p1, p0)) : angle * (r0 + r1) / 2 + Math.abs(r1 - r0) + 2 * ARC_BULGE_PER_RAD * angle,
    };
}
function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }

export function arcAt(spec, k) {
    const t = clamp(k, 0, 1);
    if (spec.straight) {
        return {
            eye:  [spec.p0[0] + (spec.p1[0] - spec.p0[0]) * t, spec.p0[1] + (spec.p1[1] - spec.p0[1]) * t, spec.p0[2] + (spec.p1[2] - spec.p0[2]) * t],
            look: [spec.l0[0] + (spec.l1[0] - spec.l0[0]) * t, spec.l0[1] + (spec.l1[1] - spec.l0[1]) * t, spec.l0[2] + (spec.l1[2] - spec.l0[2]) * t],
        };
    }
    if (t === 0) return { eye: [...spec.p0], look: [...spec.l0] };
    if (t === 1) return { eye: [...spec.p1], look: [...spec.l1] };
    const d = slerpDir(spec.d0, spec.d1, t);
    const r = spec.r0 + (spec.r1 - spec.r0) * t + spec.bulge * Math.sin(Math.PI * t);
    const ld = slerpDir(spec.ld0, spec.ld1, t);
    const lr = spec.lr0 + (spec.lr1 - spec.lr0) * t;
    return { eye: [d[0] * r, d[1] * r, d[2] * r], look: [ld[0] * lr, ld[1] * lr, ld[2] * lr] };
}
