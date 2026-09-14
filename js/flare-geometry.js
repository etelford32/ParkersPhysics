/**
 * flare-geometry.js — the ONE copy of solar flare-site geometry (PURE).
 * ═══════════════════════════════════════════════════════════════════════════
 * Where a flare IS on the Sun, which way it FACES, how it CO-ROTATES, and
 * how its arcade and eruption are oriented in the local tangent frame. Every
 * renderer that draws flare activity — sun.html's photosphere shader, AR
 * slots, marker groups and the 3D arcade (`js/flare-arcade.js`), the
 * solar-system orrery, the 2D flare modeler — reads its geometry from here.
 * No DOM, no three.js, no fetch, no ambient time: `tests/flare-geometry.mjs`
 * pins every rule below, several of them against three.js's own matrix math
 * so the frame conventions cannot silently diverge from what the renderer
 * actually does with them.
 *
 * WHY THIS FILE EXISTS (2026-09-13). Four copies of "where is the flare"
 * disagreed with each other, measured before this module was written:
 *   · sunFS rotated the photosphere and the AR spots EAST (+lon decreasing)
 *     while every 3D marker group rotated WEST, at 1.8× the rate
 *     (0.004·2π vs 0.014 rad per sim unit) — markers left their sunspots
 *     within ~10 s of model-mode time;
 *   · the ribbons compared against a Stonyhurst longitude that never
 *     rotated at all;
 *   · `js/swpc-feed.js` parsed "N12W19" with EAST positive, so every
 *     SWPC-driven flare on sun.html and the orrery fired on the mirror
 *     side of the disk;
 *   · the orrery placed Carrington longitudes as if they were Stonyhurst
 *     and ignored where Earth was, and spun the Sun retrograde relative
 *     to the planets' orbits.
 * Each of these is now one function here, one test there.
 *
 * ── Frames ─────────────────────────────────────────────────────────────────
 *   SUN FRAME (sun.html, the sphere's object space): +y is the rotation
 *   axis (solar north), +z points at the sub-Earth observer, +x is solar
 *   WEST (image-right in every SDO frame). Heliographic (lat, lon) is
 *   Stonyhurst with W positive — the NOAA convention "N12W19" — and maps to
 *   (cos lat sin lon, sin lat, cos lat cos lon), so lon = atan2(x, z).
 *   Solar rotation is prograde about +y: a disk-centre feature moves toward
 *   +x. That is three.js `makeRotationY(+θ)` — `rotateY()` here is pinned
 *   equal to it.
 *
 *   HELIOCENTRIC SCENE (solar-system.html): y up, azimuth measured from +x
 *   toward +z (its `latLonToVec3`). Stonyhurst longitude is measured from
 *   the sub-Earth meridian, so a site's azimuth is Earth's azimuth plus the
 *   longitude, counted in the sense the drawn Sun spins (`spinSign`).
 *   NOAA's `carrington_longitude` is NOT Stonyhurst: subtract L0, the
 *   Carrington longitude of the central meridian (`solarEphemeris(date)
 *   .l0Deg`, Meeus ch. 29, pinned to his worked example AND to L0 = 0 at
 *   the start of Carrington rotation 1).
 *
 * ── Rotation ───────────────────────────────────────────────────────────────
 *   The sim frame rotates by ONE equatorial angle (`u_rotAngle` on
 *   sun.html, accumulated at SIM_ROT_RATE·u_rot per sim unit) and every
 *   latitude turns by that angle times the Snodgrass factor
 *   (`diffRotFactor`, sun-observed.js — the same fit sunFS carries inline).
 *   A Stonyhurst location is a position at sim epoch t = 0 (page load);
 *   `siteLonAt` is where it is now, `epochLonFor` is its inverse for a
 *   location observed NOW that must be stored in epoch coordinates.
 *
 * ── The PIL prior ──────────────────────────────────────────────────────────
 *   When no field atlas supplies the real polarity-inversion line (that is
 *   sun.html without `?debug=field`, and always on the orrery), the arcade
 *   and the ribbons are oriented by Joy's law: a bipole's axis is tilted
 *   from east–west by ≈ 0.5 × latitude with the leading (western) spot
 *   equatorward (Hale et al. 1919), and the PIL runs perpendicular to that
 *   axis. It is a PRIOR and is labelled as such by consumers; real
 *   footpoint pairs from `js/flare-ribbons.js` override it loop by loop.
 *
 * ── Ribbon / arcade laws ───────────────────────────────────────────────────
 *   The ribbon separation, width, along-PIL envelope and decay MIRROR the
 *   legacy fallback in sunFS (RIBBON below); `tests/flare-geometry.mjs`
 *   reads sun.html and fails if the shader's literals drift from these. The
 *   arcade is the 3D counterpart of those ribbons: loops straddle the PIL at
 *   the ribbon separation, sheared strong-to-weak as reconnection proceeds
 *   (Aulanier et al. 2012), apex over the PIL. Heights are in R☉ and are
 *   the DRAWN heights — sized to read on a 1-R☉ sphere, not radiometry.
 */

import { diffRotFactor, solarEphemeris } from './sun-observed.js';

export const DEG = Math.PI / 180;
export const TWO_PI = Math.PI * 2;

/** Equatorial sim-frame rotation rate: rad per sim unit per unit `u_rot` (sunFS `rotLon`). */
export const SIM_ROT_RATE = 0.014;
export const SUN_SIDEREAL_DAYS = 25.38;
export const SUN_SYNODIC_DAYS = 27.2753;
/** Sidereal angular velocity of the Sun's equator, rad/s. */
export const OMEGA_SUN_SIDEREAL = TWO_PI / (SUN_SIDEREAL_DAYS * 86400);
export const AU_KM = 1.495978707e8;

// ── Small vector helpers (arrays, not three.js) ───────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function unit(a) {
    const n = norm(a) || 1;
    return [a[0] / n, a[1] / n, a[2] / n];
}
export const vec = Object.freeze({ dot, cross, norm, scale, add, unit });

// ═══════════════════════════════════════════════════════════════════════════
//  Stonyhurst strings
// ═══════════════════════════════════════════════════════════════════════════

/**
 * "N12W19" → { latDeg: 12, lonDeg: 19 }; "S05E34" → { latDeg: -5, lonDeg: -34 }.
 * WEST IS POSITIVE (heliographic convention; NOAA prints W as +). Returns
 * null for anything else — callers must not fall back to (0, 0), which is
 * disk centre and reads as an Earth-directed event.
 */
export function parseStonyhurst(s) {
    // Unanchored on purpose: NOAA / DONKI sometimes append a region number
    // ("N12W19 (AR 14101)"); the feed's old regex tolerated that, so does this.
    const m = String(s ?? '').toUpperCase().match(/([NS])\s*(\d{1,2})\s*([EW])\s*(\d{1,3})(?!\d)/);
    if (!m) return null;
    const lat = (m[1] === 'N' ? 1 : -1) * Number(m[2]);
    const lon = (m[3] === 'W' ? 1 : -1) * Number(m[4]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { latDeg: lat, lonDeg: lon };
}

/** Inverse of parseStonyhurst (rounded to whole degrees, zero-padded). */
export function formatStonyhurst(latDeg, lonDeg) {
    const la = Math.round(Math.abs(latDeg)), lo = Math.round(Math.abs(lonDeg));
    return `${latDeg < 0 ? 'S' : 'N'}${String(la).padStart(2, '0')}${lonDeg < 0 ? 'E' : 'W'}${String(lo).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Sun frame (sun.html)
// ═══════════════════════════════════════════════════════════════════════════

/** Unit vector for heliographic (lat, lon) radians: +y north, +z sub-Earth, +x west. */
export function stonyhurstToUnit(latRad, lonRad) {
    const cl = Math.cos(latRad);
    return [cl * Math.sin(lonRad), Math.sin(latRad), cl * Math.cos(lonRad)];
}

/** Inverse of stonyhurstToUnit for any non-zero vector. */
export function unitToStonyhurst(v) {
    const r = norm(v) || 1;
    return {
        latRad: Math.asin(Math.max(-1, Math.min(1, v[1] / r))),
        lonRad: Math.atan2(v[0], v[2]),
    };
}

/**
 * Rotation about +y by `ang` — EXACTLY three.js Matrix4.makeRotationY(ang):
 * x' = c·x + s·z, z' = −s·x + c·z. Positive ang carries +z toward +x, i.e.
 * a disk-centre feature moves WEST. This is the Sun's prograde spin.
 */
export function rotateY(v, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

/** Equatorial rotation angle accumulated over `tSim` sim units at multiplier `uRot`. */
export function rotationAngle(tSim, uRot = 1) {
    return tSim * SIM_ROT_RATE * uRot;
}

/** How far a site at `latRad` has turned when the equator has turned `eqAngle`. */
export function siteRotation(eqAngle, latRad) {
    return eqAngle * diffRotFactor(latRad);
}

/** Current longitude of a site whose epoch (t = 0) longitude was `lonRad0`. */
export function siteLonAt(lonRad0, eqAngle, latRad) {
    return lonRad0 + siteRotation(eqAngle, latRad);
}

/** Epoch longitude for a site observed at `lonRadNow` when the equator has turned `eqAngle`. */
export function epochLonFor(lonRadNow, eqAngle, latRad) {
    return lonRadNow - siteRotation(eqAngle, latRad);
}

/** Current unit position of an epoch-frame site. */
export function sitePositionAt(latRad, lonRad0, eqAngle) {
    return stonyhurstToUnit(latRad, siteLonAt(lonRad0, eqAngle, latRad));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Local tangent frame + the PIL prior
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Orthonormal right-handed frame at a site: `radial` (outward), `east`
 * (∂/∂lon, the direction of rotation), `north` (∂/∂lat). east × north = radial.
 */
export function localFrame(latRad, lonRad) {
    const sl = Math.sin(latRad), cl = Math.cos(latRad);
    const so = Math.sin(lonRad), co = Math.cos(lonRad);
    return {
        radial: [cl * so, sl, cl * co],
        east:   [co, 0, -so],
        north:  [-sl * so, cl, -sl * co],
    };
}

/**
 * Joy's law tilt of a bipole axis, radians, measured from local east toward
 * local north. ≈ 0.5 × |lat| with the sign that puts the LEADING (western)
 * spot equatorward: negative in the north (west end dips south), positive
 * in the south. Zero on the equator.
 */
export function joyTiltRad(latRad) {
    return -Math.sign(latRad) * 0.5 * Math.abs(latRad);
}

/** Bipole axis (following → leading spot) in the tangent plane, unit. */
export function bipoleAxis(latRad, lonRad) {
    const f = localFrame(latRad, lonRad);
    const g = joyTiltRad(latRad);
    return add(scale(f.east, Math.cos(g)), scale(f.north, Math.sin(g)));
}

/**
 * The PIL prior: perpendicular to the Joy's-law bipole axis, as an angle from
 * local east toward local north, wrapped to (−π/2, π/2].
 */
export function pilAngleRad(latRad) {
    let a = joyTiltRad(latRad) + Math.PI / 2;
    while (a > Math.PI / 2) a -= Math.PI;
    while (a <= -Math.PI / 2) a += Math.PI;
    return a;
}

/**
 * Tangent frame with the PIL laid in: `pilAxis` runs along the inversion
 * line, `loopAxis` crosses it (pilAxis rotated +90° about `radial`). Arcade
 * loops run along loopAxis; ribbons run along pilAxis at ±separation along
 * loopAxis. `pilAngle` defaults to the Joy's-law prior.
 */
export function tangentFrame(latRad, lonRad, pilAngle = pilAngleRad(latRad)) {
    const f = localFrame(latRad, lonRad);
    const c = Math.cos(pilAngle), s = Math.sin(pilAngle);
    return {
        ...f,
        pilAngle,
        pilAxis:  add(scale(f.east, c), scale(f.north, s)),
        loopAxis: add(scale(f.east, -s), scale(f.north, c)),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Ribbon / arcade / plume laws
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Legacy-fallback ribbon constants, MIRRORED from sunFS (sun.html, the
 * "Legacy fallback" branch of the flare-ribbon section). `t` is u_flare_t,
 * sim units since onset. Units: radians of arc on the unit sphere.
 */
export const RIBBON = Object.freeze({
    SEP0: 0.020, SEP_RATE: 2.5e-5,          // half-separation across the PIL
    WID0: 0.005, WID_RATE: 6.0e-6,          // ribbon width
    ALONG_VAR0: 0.10, ALONG_VAR_RATE: 4.0e-5, // variance of the along-PIL envelope
    DECAY_T: 175.0,                         // e-folding of the ribbon brightness
});
export const ribbonSeparation = (t) => RIBBON.SEP0 + t * RIBBON.SEP_RATE;
export const ribbonWidth      = (t) => RIBBON.WID0 + t * RIBBON.WID_RATE;
export const ribbonAlongSigma = (t) => Math.sqrt(RIBBON.ALONG_VAR0 + t * RIBBON.ALONG_VAR_RATE);
export const ribbonDecay      = (t) => Math.exp(-t / RIBBON.DECAY_T);

/** GOES class → drawn-size factor. Ordered A < B < C < M < X; unknown reads as M. */
export const CLASS_FACTOR = Object.freeze({ A: 0.35, B: 0.45, C: 0.60, M: 0.85, X: 1.15 });
export function classFactor(cls) {
    const k = String(cls ?? 'M').trim()[0]?.toUpperCase();
    return CLASS_FACTOR[k] ?? CLASS_FACTOR.M;
}

/**
 * Arcade shear (radians of footpoint offset along the PIL per unit
 * separation): strong at onset, relaxing toward near-potential as the
 * post-flare arcade cools. Complex (δ) regions start more sheared.
 */
export function arcadeShear(t, complex = false) {
    return (complex ? 0.75 : 0.45) * Math.exp(-t / 250) + 0.12;
}

/** Drawn apex height above the photosphere, R☉. Grows with the ribbon separation and the class. */
export function arcadeHeight(t, cls = 'M') {
    return 2 * ribbonSeparation(t) * (0.6 + 0.7 * classFactor(cls));
}

/**
 * Post-flare arcade loops as polylines in the SUN FRAME (epoch coordinates —
 * the caller rotates by `siteRotation`). Without `pairs`, `n` loops are laid
 * along the PIL over ±0.6σ of the ribbon envelope, footpoints at
 * ±ribbonSeparation(t) across it and sheared along it; with `pairs` (the
 * atlas's conjugate footpoints, `{ a, b, apexR? }`) each pair is one loop.
 * Each loop: { pts: [[x,y,z]…], footA, footB, apexR, along, weight } with
 * footA on the +loopAxis side and `weight` the ribbon envelope at `along`.
 */
export function arcadeLoops({
    latRad, lonRad, pilAngle, t = 0, cls = 'M', n = 9, complex = false,
    pairs = null, samples = 24,
} = {}) {
    const frame = tangentFrame(latRad, lonRad, pilAngle);
    const h = arcadeHeight(t, cls);
    const out = [];
    const loopFrom = (fa, fb, apexR, along, weight) => {
        const a = unit(fa), b = unit(fb);
        const cosw = Math.max(-1, Math.min(1, dot(a, b)));
        const w = Math.acos(cosw);
        const sw = Math.sin(w);
        const pts = [];
        for (let i = 0; i <= samples; i++) {
            const u = i / samples;
            // Great-circle interpolation between the footpoints…
            const p = sw < 1e-9
                ? a
                : add(scale(a, Math.sin((1 - u) * w) / sw), scale(b, Math.sin(u * w) / sw));
            // …lifted by a sine profile so the apex sits over the midpoint.
            const r = 1 + (apexR - 1) * Math.sin(Math.PI * u);
            pts.push(scale(unit(p), r));
        }
        return { pts, footA: a, footB: b, apexR, along, weight };
    };

    if (pairs && pairs.length) {
        for (const pr of pairs) {
            if (!pr?.a || !pr?.b) continue;
            const apexR = Number.isFinite(pr.apexR) && pr.apexR > 1 ? pr.apexR : 1 + h;
            const mid = unit(add(pr.a, pr.b));
            const along = dot(add(mid, scale(frame.radial, -1)), frame.pilAxis);
            // Keep footA on the +loopAxis side so consumers can tell the sides apart.
            const sideA = dot(pr.a, frame.loopAxis) >= dot(pr.b, frame.loopAxis);
            out.push(loopFrom(sideA ? pr.a : pr.b, sideA ? pr.b : pr.a, apexR, along, 1));
        }
        return out;
    }

    const sep = ribbonSeparation(t);
    const sigma = ribbonAlongSigma(t);
    const shear = arcadeShear(t, complex);
    const span = 0.6 * sigma;
    for (let i = 0; i < n; i++) {
        const along = n === 1 ? 0 : -span + (2 * span * i) / (n - 1);
        // Each loop's feet are equal-and-opposite offsets from ITS OWN
        // midpoint on the PIL, in the tangent frame at that midpoint — so the
        // two feet normalise identically and the apex (their bisector) sits
        // on the PIL exactly, not to first order.
        const mid   = unit(add(frame.radial, scale(frame.pilAxis, along)));
        const pilM  = unit(add(frame.pilAxis, scale(mid, -dot(mid, frame.pilAxis))));
        const loopM = cross(mid, pilM);              // radial × pil = loop (right-handed)
        const fa = add(add(mid, scale(loopM,  sep)), scale(pilM,  shear * sep));
        const fb = add(add(mid, scale(loopM, -sep)), scale(pilM, -shear * sep));
        const weight = Math.exp(-(along * along) / (sigma * sigma));
        out.push(loopFrom(fa, fb, 1 + h, along, weight));
    }
    return out;
}

/**
 * The eruptive plume: a jet along the site's radial that rises from the
 * photosphere, widens, and fades. Returns radii in R☉ and an opacity
 * envelope in [0, 1]. Faster and farther for bigger classes; the front
 * caps at `rMax` so a stale flare cannot fill the whole scene.
 */
export function plumeState(t, cls = 'M') {
    const cf = classFactor(cls);
    const v = 0.06 * cf;                      // R☉ per sim unit
    const rMax = 1 + 2.4 * cf;
    const front = Math.min(rMax, 1 + v * Math.max(0, t));
    const length = 0.35 + 0.6 * cf * Math.min(1, Math.max(0, t) / 30);
    const tail = Math.max(1, front - length);
    const radius = 0.03 + 0.05 * cf * Math.min(1, Math.max(0, t) / 40);
    const alpha = t <= 0 ? 0 : (1 - Math.exp(-t / 3)) * Math.exp(-t / (60 * cf));
    return { front, tail, radius, alpha, rMax };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Earth view — how the activity is ANGLED to the observer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Viewing geometry of a site from Earth with the solar axis tilted by B0
 * (the same tilt sunFS applies to read the observed frame: μ = y·sin B0 +
 * z·cos B0). `profileFraction` = sin of the angle from disk centre — 0 means
 * the arcade is seen face-on (its height is invisible), 1 means side-on at
 * the limb, where loops and plumes read as height above the limb.
 */
export function earthViewGeometry(latRad, lonRad, b0Rad = 0) {
    const p = stonyhurstToUnit(latRad, lonRad);
    const mu = p[1] * Math.sin(b0Rad) + p[2] * Math.cos(b0Rad);
    const clamped = Math.max(-1, Math.min(1, mu));
    return {
        mu: clamped,
        nearSide: clamped > 0,
        limbAngleRad: Math.acos(clamped),
        profileFraction: Math.sqrt(Math.max(0, 1 - clamped * clamped)),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Heliocentric scene (solar-system.html)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Unit direction of a Stonyhurst site in a y-up heliocentric scene whose
 * azimuth runs from +x toward +z and where Earth sits at `earthAzRad`.
 * `spinSign` is the sense in which the DRAWN Sun spins in that azimuth
 * (+1: azimuth increasing) — west is by definition the direction of
 * rotation, so a W-longitude site is that far AHEAD of Earth's azimuth.
 * The 7.25° axis tilt is not modelled here (the orrery draws the axis as +y).
 */
export function heliocentricSiteDirection({ latRad = 0, lonRad = 0, earthAzRad = 0, spinSign = 1 } = {}) {
    const az = earthAzRad + Math.sign(spinSign || 1) * lonRad;
    const cl = Math.cos(latRad);
    return [cl * Math.cos(az), Math.sin(latRad), cl * Math.sin(az)];
}

/** Azimuth (from +x toward +z) of a scene vector. */
export function heliocentricAzimuth(v) {
    return Math.atan2(v[2], v[0]);
}

/**
 * Object-space azimuth that lands at world azimuth `worldAzRad` inside a
 * mesh rotated by `meshRotY` about +y. three.js makeRotationY(θ) maps
 * azimuth φ → φ − θ, so the object needs φ + θ. (The orrery used to
 * subtract — the sign the test pins against Object3D.localToWorld.)
 */
export function objectAzimuthForWorld(worldAzRad, meshRotY) {
    return worldAzRad + meshRotY;
}

/** Carrington longitude → Stonyhurst, degrees in (−180, 180], given the central-meridian L0. */
export function carringtonToStonyhurstDeg(lonCarrDeg, l0Deg) {
    let d = ((lonCarrDeg - l0Deg) % 360 + 540) % 360 - 180;
    if (d === -180) d = 180;
    return d;
}

/** Carrington longitude of the central meridian, degrees — the ONE ephemeris (Meeus ch. 29). */
export function centralMeridianL0Deg(date = new Date()) {
    return solarEphemeris(date).l0Deg;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Parker connection — which longitudes can reach Earth along the field
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stonyhurst W-longitude of Earth's Parker-spiral footpoint on the Sun:
 * Ω⊙ r / v_sw (≈ 61° at 400 km/s and 1 AU). Flares near it are
 * magnetically well connected — the classic west-hemisphere SEP bias.
 */
export function parkerFootpointLonDeg(vSwKms = 400, rAU = 1) {
    const v = Math.max(50, Number(vSwKms) || 400);
    return (OMEGA_SUN_SIDEREAL * rAU * AU_KM / v) / DEG;
}

/** Gaussian connectivity score in [0, 1], peaking at the footpoint longitude. */
export function magneticConnectivity(lonDeg, vSwKms = 400, sigmaDeg = 30) {
    const d = lonDeg - parkerFootpointLonDeg(vSwKms);
    return Math.exp(-(d * d) / (sigmaDeg * sigmaDeg));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Cone basis (eruption / CME particle cones)
// ═══════════════════════════════════════════════════════════════════════════

/** Orthonormal right-handed basis { axis, u, v } about a direction: v = axis × u. */
export function coneBasis(axisIn) {
    const axis = unit(axisIn);
    const helper = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = unit(cross(helper, axis));
    const v = cross(axis, u);
    return { axis, u, v };
}

// ═══════════════════════════════════════════════════════════════════════════
//  2D disk (star2d.html and the canvas renderers): north up, west right
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Where a site falls on a 2D disk drawn with north up and west to the
 * right, in unit-radius disk coordinates with CANVAS y (down). `angle` is
 * the canvas angle of the site from the disk centre (0 = right, −π/2 = up),
 * which is also the direction a radial jet from that site leaves the disk.
 */
export function siteOnDisk2D(latRad, lonRad) {
    const p = stonyhurstToUnit(latRad, lonRad);
    return { x: p[0], y: -p[1], angle: Math.atan2(-p[1], p[0]), visible: p[2] > 0, mu: p[2] };
}
