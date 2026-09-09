/**
 * bootes/camera-math.js — the camera rig's arithmetic, with no three.js in it
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE. No DOM, no three, no ambient time. Everything here is a function of
 * its arguments, which is what lets `tests/bootes-camera-math.mjs` pin the
 * parts that are easy to get subtly wrong and impossible to notice by eye:
 * the nice-number rounding on the scale bar, the polar clamp that keeps the
 * camera off its own poles, and the viewpoint basis that has to be built from
 * the LINE OF SIGHT rather than from a coordinate axis.
 *
 * WHY A SEPARATE FILE. bootes/camera.js has to import three, so nothing in it
 * can run under node. The bugs, though, are all in the arithmetic — a scale
 * bar that reads "37 Mpc" instead of "20 Mpc", an elevation that flips sign at
 * the zenith, a "perpendicular to the sightline" view that is perpendicular to
 * +Z instead. Splitting them means the arithmetic is gated and the three.js
 * half is only plumbing.
 *
 * THE SIGHTLINE IS NOT AN AXIS, AND THAT IS THE POINT OF `viewpointDirection`.
 * Boötes sits at RA 14ʰ50ᵐ, Dec +46°, so the direction back to the Milky Way
 * is oblique in every coordinate frame this page uses — roughly
 * (0.51, 0.47, −0.72). Two of the five viewpoints are DEFINED relative to it
 * (looking along it, and looking across it), because those are the two framings
 * in which redshift-space distortion is respectively invisible and maximal.
 * Substituting a coordinate axis produces a view that looks entirely plausible
 * and shows the wrong thing, which is the worst kind of wrong for a figure.
 */

/** Clamp helper. */
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Polar angle limits, in radians from +Y.
 *
 * NOT 0 and π. At exactly the pole the azimuth is undefined and the camera's
 * up-vector degenerates: OrbitControls produces a visible roll snap as the
 * spherical coordinate passes through, and keyboard orbit — which steps in
 * fixed increments rather than tracking a pointer — walks straight into it.
 * The 0.04 rad (≈2.3°) standoff is small enough to read as "straight down"
 * and large enough that the basis never degenerates.
 */
export const POLAR_MIN = 0.04;
export const POLAR_MAX = Math.PI - 0.04;

/** Keep a polar angle inside the safe band. */
export const clampPolar = (phi) => clamp(phi, POLAR_MIN, POLAR_MAX);

/** Normalise a 3-vector. Returns [0,1,0] for a degenerate input. */
export function normalise(v) {
    const n = Math.hypot(v[0], v[1], v[2]);
    if (!(n > 1e-12)) return [0, 1, 0];
    return [v[0] / n, v[1] / n, v[2] / n];
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
];

/**
 * A unit vector perpendicular to `axis`, chosen to be as close to world-up as
 * the constraint allows — i.e. the Gram–Schmidt projection of +Y off `axis`.
 *
 * "As close to up as possible" rather than "any perpendicular" because this is
 * a CAMERA placement: an arbitrary perpendicular puts the horizon at a random
 * roll and the view reads as a mistake even when the geometry is right. When
 * the axis IS +Y the projection vanishes and we fall back to +X, which is the
 * only case where an arbitrary choice is unavoidable.
 */
export function perpendicularTo(axis) {
    const a = normalise(axis);
    const up = [0, 1, 0];
    const proj = dot(up, a);
    const rejected = [up[0] - proj * a[0], up[1] - proj * a[1], up[2] - proj * a[2]];
    if (Math.hypot(...rejected) < 1e-6) return [1, 0, 0];
    return normalise(rejected);
}

/**
 * A unit vector perpendicular to `axis` that lies in the HORIZONTAL plane.
 *
 * Used for the "across the sightline" viewpoint. Both this and
 * `perpendicularTo` put the sightline in the screen plane — that is guaranteed
 * by perpendicularity and is the property the viewpoint exists for — but this
 * one also leaves the horizon level, which the Gram-Schmidt version does not:
 * for Boötes' sightline that lands the camera 62° above the plane and the
 * range rings arrive as a steep ellipse. Level reads as deliberate; 62° reads
 * as an accident.
 */
export function horizontalPerpendicularTo(axis) {
    const a = normalise(axis);
    const c = cross(a, [0, 1, 0]);
    if (Math.hypot(c[0], c[1], c[2]) < 1e-6) return [1, 0, 0];
    return normalise(c);
}

/**
 * The named viewpoints.
 *
 * `dir` is where the CAMERA sits, as a unit direction from the void centre;
 * the camera always looks back at the target. `distance` is in units of R_eff.
 * `fovDeg` is per-viewpoint because the inside view is unusable at the 45° the
 * others use — standing in the middle of a void, a narrow lens shows you a
 * patch of wall and no context.
 *
 * `needsLos: true` marks the two that are derived from the sightline rather
 * than from a fixed direction. See the header.
 */
export const VIEWPOINTS = Object.freeze({
    survey: {
        label: 'Three-quarter',
        key: '1',
        distance: 3.9,
        fovDeg: 45,
        hint: 'The default framing. Shows the wall, the filaments and the field together.',
    },
    sightline: {
        label: 'Down the sightline',
        key: '2',
        distance: 3.4,
        fovDeg: 45,
        needsLos: true,
        hint: 'Looking from Earth. This is the projection a redshift survey sees — '
            + 'and the one in which the line-of-sight distortion is invisible.',
    },
    across: {
        label: 'Across the sightline',
        key: '3',
        distance: 3.4,
        fovDeg: 45,
        needsLos: true,
        hint: 'Sightline horizontal in view. Redshift-space elongation, when it is '
            + 'switched on, stretches the void left-to-right from here.',
    },
    pole: {
        label: 'Top-down',
        key: '4',
        distance: 3.6,
        fovDeg: 45,
        hint: 'Straight down onto the range rings — the easiest view for judging distance.',
    },
    inside: {
        label: 'Inside the void',
        key: '5',
        distance: 0.22,
        fovDeg: 78,
        hint: 'Standing near the centre. The wall wraps the whole sky and the outflow '
            + 'points at you from every direction.',
    },
});

export const VIEWPOINT_IDS = Object.keys(VIEWPOINTS);

/**
 * Where the camera goes for a viewpoint, as a unit direction from the centre.
 *
 * `losUnit` points FROM the void TOWARD the observer, matching
 * `losUnitFromVoid()` in js/bootes-void-data.js. So the `sightline` viewpoint
 * places the camera along +los — between us and the void, looking back at it,
 * which is the Earth's-eye framing. Getting that sign backwards puts the
 * camera behind the void looking outward and the render is simply the far
 * side, with nothing to say it.
 */
export function viewpointDirection(id, losUnit) {
    const los = normalise(losUnit ?? [0, 0, 1]);
    switch (id) {
        case 'sightline':
            return los;
        case 'across':
            return horizontalPerpendicularTo(los);
        case 'pole':
            return [0, 1, 0];
        case 'inside':
            // Offset off-axis from the sightline so the observer's direction is
            // not hidden exactly behind the camera.
            return perpendicularTo(los);
        case 'survey':
        default:
            return normalise([0.72, 0.5, 0.78]);
    }
}

/**
 * Spherical (azimuth θ about +Y, polar φ from +Y) for a direction.
 * Matches three's Spherical convention so the two can be mixed freely.
 */
export function sphericalFromDirection(dir) {
    const d = normalise(dir);
    return {
        theta: Math.atan2(d[0], d[2]),
        phi: clampPolar(Math.acos(clamp(d[1], -1, 1))),
    };
}

/** Inverse of the above: a unit direction from θ, φ. */
export function directionFromSpherical(theta, phi) {
    const p = clampPolar(phi);
    const s = Math.sin(p);
    return [s * Math.sin(theta), Math.cos(p), s * Math.cos(theta)];
}

/**
 * Elevation above the graticule plane, in degrees. 0 at the equator, +90 at
 * the north pole. This is what the HUD prints; polar angle is what the maths
 * uses, and the two run in opposite directions, which is exactly the sort of
 * thing that ships inverted.
 */
export const elevationDegFromPolar = (phi) => 90 - (phi * 180) / Math.PI;

/** Azimuth in degrees, wrapped to [0, 360). */
export function azimuthDeg(theta) {
    let deg = (theta * 180) / Math.PI;
    deg %= 360;
    if (deg < 0) deg += 360;
    return deg;
}

/**
 * World height, in Mpc, spanned by the viewport at the target distance.
 *
 *   h = 2 d tan(fov/2)
 *
 * This is the exact figure a perspective camera shows AT THE TARGET PLANE, and
 * "at the target plane" is the whole caveat: nearer things are bigger and
 * further things smaller, so a scale bar drawn from this is only strictly true
 * for objects at the pivot. The void centre IS the pivot in every viewpoint
 * except `inside`, so the bar is honest where it matters and the HUD says the
 * bar applies at the centre.
 */
export function visibleHeightMpc(distanceMpc, fovDeg) {
    return 2 * distanceMpc * Math.tan((fovDeg * Math.PI) / 360);
}

/** Mpc per screen pixel at the target plane. */
export function mpcPerPixel(distanceMpc, fovDeg, viewportHeightPx) {
    if (!(viewportHeightPx > 0)) return 0;
    return visibleHeightMpc(distanceMpc, fovDeg) / viewportHeightPx;
}

/**
 * Round a raw length down to the nearest 1 / 2 / 5 × 10ⁿ.
 *
 * The classic map-scale-bar rounding. It rounds DOWN, never up, so the drawn
 * bar always fits the space it was measured against — a bar rounded up
 * overflows its container at some zoom levels and gets clipped, which turns a
 * scale reference into a lie about scale.
 */
export function niceScaleMpc(rawMpc) {
    if (!(rawMpc > 0) || !Number.isFinite(rawMpc)) return 0;
    const exp = Math.floor(Math.log10(rawMpc));
    const mag = Math.pow(10, exp);
    const norm = rawMpc / mag;
    const step = norm >= 5 ? 5 : norm >= 2 ? 2 : 1;
    return step * mag;
}

/**
 * A scale bar for the current view: a nice round length and the pixel width
 * that represents it, targeting `maxPx` of screen.
 *
 * Returns { mpc, px } with px ≤ maxPx, or null when the view is degenerate.
 */
export function scaleBar(distanceMpc, fovDeg, viewportHeightPx, maxPx = 180) {
    const perPx = mpcPerPixel(distanceMpc, fovDeg, viewportHeightPx);
    if (!(perPx > 0)) return null;
    const mpc = niceScaleMpc(perPx * maxPx);
    if (!(mpc > 0)) return null;
    return { mpc, px: mpc / perPx };
}

/**
 * Which range rings to draw, in units of R_eff.
 *
 * Fixed rather than adaptive. The rings are the reader's ruler, and a ruler
 * whose tick spacing changes as you zoom is not a ruler — the one thing it has
 * to do is stay put so that "the filament is at two rings out" means the same
 * thing before and after a zoom.
 */
export const RANGE_RINGS = Object.freeze([0.5, 1, 1.5, 2, 3]);

/** Cubic ease, for camera tweens. Symmetric, zero velocity at both ends. */
export function easeInOutCubic(t) {
    const x = clamp(t, 0, 1);
    return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Interpolate a camera pose. Position is slerped through SPHERICAL
 * coordinates, not lerped through Cartesian ones.
 *
 * The difference is visible and it is not subtle: a Cartesian lerp between two
 * points on a sphere cuts through the middle, so flying from one side of the
 * void to the other dives through the centre and out again — the wall passes
 * through the camera and the view flashes. Interpolating θ, φ and radius
 * separately keeps the camera on an arc at a controlled distance.
 *
 * θ is interpolated the SHORT way around, which is the other half of the same
 * bug: without the wrap, a flight from 350° to 10° takes the 340° route.
 */
export function interpolatePose(a, b, t) {
    const e = easeInOutCubic(t);
    let dTheta = b.theta - a.theta;
    while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
    return {
        theta: a.theta + dTheta * e,
        phi: clampPolar(a.phi + (b.phi - a.phi) * e),
        // Radius moves geometrically: a linear ramp from 20 Mpc to 400 Mpc
        // spends most of its time far away and arrives in a rush, because
        // apparent size goes as 1/r. The log interpolation makes the approach
        // feel linear, which is what "smooth" means to the eye here.
        radius: a.radius * Math.pow(b.radius / a.radius, e),
        fovDeg: a.fovDeg + (b.fovDeg - a.fovDeg) * e,
        target: [
            a.target[0] + (b.target[0] - a.target[0]) * e,
            a.target[1] + (b.target[1] - a.target[1]) * e,
            a.target[2] + (b.target[2] - a.target[2]) * e,
        ],
    };
}

/**
 * Keyboard bindings. Exported as data so the on-screen help and the handler
 * cannot drift — the help is RENDERED from this table, so a binding that is
 * added without documenting it is impossible.
 */
export const KEY_BINDINGS = Object.freeze([
    { keys: ['←', '→'], action: 'Orbit left / right' },
    { keys: ['↑', '↓'], action: 'Orbit up / down' },
    { keys: ['W', 'S'], action: 'Zoom in / out' },
    { keys: ['A', 'D'], action: 'Orbit left / right' },
    { keys: ['1'], action: 'Three-quarter view' },
    { keys: ['2'], action: 'Down the sightline' },
    { keys: ['3'], action: 'Across the sightline' },
    { keys: ['4'], action: 'Top-down' },
    { keys: ['5'], action: 'Inside the void' },
    { keys: ['R'], action: 'Reset the camera' },
    { keys: ['Space'], action: 'Pause / resume auto-rotate' },
    { keys: ['L'], action: 'Toggle labels' },
]);
