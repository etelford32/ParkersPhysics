/**
 * sky-projection.js — PURE view math for the SkyView chart
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE projection, two framings. Stereographic (conformal: constellations keep
 * their shapes everywhere, and circles on the sky stay circles on screen —
 * which is what lets the horizon be drawn as an exact arc) about a movable
 * centre direction:
 *
 *   'dome'  centre = zenith, north up. The horizon is the rim (ρ = 2). Seen
 *           from BELOW, so EAST IS ON THE LEFT — a planisphere held overhead.
 *           Getting this backwards mirrors the sky and still looks like one.
 *   'look'  centre = (alt, az) the user drags to, screen-up = toward the
 *           zenith. Facing north, east is on the RIGHT, as it is for a person.
 *
 * Both follow from one rule: right = centre × up (in East/North/Up axes).
 * tests/skyview-engine.mjs pins both handednesses.
 *
 * Screen mapping, θ = angle from the centre:  ρ = 2 tan(θ/2), i.e.
 *   X = cx + s · 2(v·r)/(1+cosθ),   Y = cy − s · 2(v·u)/(1+cosθ)
 * and it inverts in closed form (`unproject`). Points within MAX_THETA_DEG of
 * the antipode are not projected: ρ diverges there, and a line segment between
 * two such points can sweep across the whole screen.
 */

import { altAzToEnu, enuToAltAz, D2R, R2D } from './sky-engine.js';

export const MAX_THETA_DEG = 150;
const COS_MAX = Math.cos(MAX_THETA_DEG * D2R);

const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const r = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / r, a[1] / r, a[2] / r]; };

/**
 * Build a view. `fovDeg` is the field across the SHORTER screen dimension
 * (dome mode ignores it and fits the whole hemisphere with `margin` px spare).
 */
export function createView({ mode = 'dome', centerAltDeg = 90, centerAzDeg = 180, fovDeg = 90,
    width, height, margin = 26 }) {
    const cx = width / 2, cy = height / 2;
    let c, u, s;
    if (mode === 'dome') {
        c = [0, 0, 1];
        u = [0, 1, 0];                       // north up
        s = Math.max(10, (Math.min(width, height) / 2 - margin) / 2);   // ρ = 2 at the horizon
    } else {
        const alt = Math.max(-10, Math.min(89.5, centerAltDeg));
        c = altAzToEnu(alt, centerAzDeg);
        // Screen-up: the zenith, made perpendicular to the centre.
        const z = [0, 0, 1];
        const k = dot(z, c);
        u = norm([z[0] - k * c[0], z[1] - k * c[1], z[2] - k * c[2]]);
        const half = Math.max(2, Math.min(170, fovDeg)) / 2;
        s = (Math.min(width, height) / 2) / (2 * Math.tan(half * D2R / 2));
    }
    const r = cross(c, u);
    return Object.freeze({ mode, c, u, r, s, cx, cy, width, height,
        centerAltDeg: mode === 'dome' ? 90 : centerAltDeg, centerAzDeg, fovDeg });
}

/** ENU vector → screen {x, y} or null when too close to the antipode. */
export function project(view, v) {
    const ct = dot(v, view.c);
    if (ct < COS_MAX) return null;
    const k = 2 * view.s / (1 + ct);
    return { x: view.cx + k * dot(v, view.r), y: view.cy - k * dot(v, view.u), cosTheta: ct };
}

export function projectAltAz(view, altDeg, azDeg) {
    return project(view, altAzToEnu(altDeg, azDeg));
}

/** Screen point → ENU unit vector (exact inverse of `project`). */
export function unproject(view, x, y) {
    const a = (x - view.cx) / view.s, b = (view.cy - y) / view.s;
    const rho2 = a * a + b * b;
    const ct = (4 - rho2) / (4 + rho2);
    const w = (1 + ct) / 2;
    const v = [
        view.c[0] * ct + (view.r[0] * a + view.u[0] * b) * w,
        view.c[1] * ct + (view.r[1] * a + view.u[1] * b) * w,
        view.c[2] * ct + (view.r[2] * a + view.u[2] * b) * w,
    ];
    return norm(v);
}

export function unprojectAltAz(view, x, y) {
    const v = unproject(view, x, y);
    return enuToAltAz(v[0], v[1], v[2]);
}

/**
 * The horizon (alt = 0) as a screen circle {x, y, r}. Stereographic maps the
 * horizon great circle to a circle (a line only when it passes through the
 * centre — `createView` keeps the look centre off alt = 0 by clamping to
 * ≥ −10°… and if it lands exactly on it we nudge it). Fitted through three
 * projected points. `groundInside` says which side the ground is on.
 */
export function horizonCircle(view) {
    if (view.mode === 'dome') {
        return { x: view.cx, y: view.cy, r: 2 * view.s, groundInside: false };
    }
    const az0 = view.centerAzDeg;
    const pts = [az0, az0 + 90, az0 - 90].map((az) => {
        const p = project(view, altAzToEnu(0, az));
        return p ?? projectFar(view, altAzToEnu(0, az));
    });
    const circ = circleThrough(pts[0], pts[1], pts[2]);
    if (!circ) return null;
    const g = project(view, altAzToEnu(-5, az0)) ?? projectFar(view, altAzToEnu(-5, az0));
    const inside = Math.hypot(g.x - circ.x, g.y - circ.y) < circ.r;
    return { ...circ, groundInside: inside };
}

/** Project ignoring the antipode guard (only for fitting the horizon circle). */
function projectFar(view, v) {
    const ct = Math.max(-0.999999, dot(v, view.c));
    const k = 2 * view.s / (1 + ct);
    return { x: view.cx + k * dot(v, view.r), y: view.cy - k * dot(v, view.u) };
}

export function circleThrough(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-9) return null;
    const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}

/** Degrees per pixel at the view centre (for label decluttering / scale). */
export function degPerPixelAtCentre(view) { return R2D / view.s; }
