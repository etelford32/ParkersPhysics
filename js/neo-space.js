/**
 * neo-space.js — PURE geocentric kernel for near-Earth space
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no three.js, no ambient time. Everything `neo-watch.html`
 * knows about WHERE something is relative to Earth, HOW BRIGHT it looks, and
 * WHETHER it is above your horizon lives here and nowhere else.
 *
 * Gate: `node tests/neo-space.mjs` after ANY edit.
 *
 * ── Why a second kernel ───────────────────────────────────────────────────
 * `js/neo-orbits.js` owns the ORBITS — Kepler both branches, the catalogue
 * wire format, the meteor-shower table, and the solar-system orrery's
 * HELIOCENTRIC log scale. It is imported here and never re-derived. What it
 * does not own is the view from the middle of the Earth: a geocentric radial
 * map, the equatorial frame, sidereal time, apparent magnitude, and the
 * observer's horizon. Those are this file.
 *
 * The split is the same one the orrery already makes between its two drawing
 * conventions, moved up a level: there, "Earth-local" was a 20-LD inset on a
 * heliocentric stage; here, geocentric IS the stage and the Sun is just
 * another direction.
 *
 * ── THE ONE PIECE OF SPATIAL DISHONESTY, AND ITS RULER ───────────────────
 * Near-Earth space spans four decades of radius — the ISS at 1.07 R⊕, the
 * geostationary belt at 6.6, the Moon at 60.3, a typical close approach at
 * 500–3 000, the catalogue's useful horizon at ~12 000 (0.5 AU). Drawn
 * linearly with Earth visible at all, everything past the Moon is off screen;
 * drawn linearly with 0.5 AU on screen, Earth is a third of a pixel.
 *
 * So `geoSceneRadius` is LOGARITHMIC in geocentric distance, pinned at two
 * anchors: Earth's surface is 1.0 scene unit (the drawn globe IS 1 R⊕, as on
 * the Stage) and the Moon's mean distance is `MOON_SCENE`. Every other radius
 * falls out — nothing else is tuned, and `GEO_MAP.gain` is DERIVED from those
 * two anchors rather than typed in. The map is disclosed on-stage, carries a
 * live ruler of labelled shells (`SHELLS`), and is REMOVABLE: `trueSceneRadius`
 * is the same quantity drawn linearly, which is what the page's True-scale
 * toggle switches to. That is the Stage's rule (`js/stage/scale.js`) — spatial
 * dishonesty lives in exactly one function, is said out loud, and can be
 * turned off.
 *
 * A pleasant accident worth not breaking: because the map is anchored at the
 * surface, it is nearly TRUE out to the geostationary belt (6.07 units drawn
 * against 6.62 true, 8 % low) and only starts really compressing beyond the
 * Moon. The region an operator cares about is the region least distorted.
 *
 * ── FRAMES: J2000 for the catalogue, OF DATE for pointing ────────────────
 * Three frames meet on this page and mixing them is worth 0.4° — half a
 * degree of "is it above my horizon", and 2.5 lunar distances of flyby
 * geometry at 1 AU (the scar recorded in js/neo-orbits.js):
 *
 *   1. SBDB osculating elements are ecliptic J2000.
 *   2. VSOP87D Earth (`js/horizons.js earthHeliocentric`) and Meeus ch. 47
 *      Moon (`moonGeocentric`) are ecliptic OF DATE.
 *   3. Sidereal time is measured from the equinox OF DATE by definition.
 *
 * This kernel therefore does the conversion ONCE, in one direction: Earth and
 * the Moon are rotated BACK to J2000 (`ofDateToJ2000`, the inverse of the
 * orrery's `toOfDate`), and every geocentric vector, distance, RA/Dec and
 * scene position downstream is J2000 — the frame the catalogue is published
 * in and the frame RA/Dec is quoted in. The single exception is
 * `topocentricAltAz`, which needs the equinox of date to be consistent with
 * GMST and rotates forward again on the way in. The reported RA/Dec is J2000;
 * the reported altitude and azimuth are of date. Both say so.
 *
 * As in the orrery, precession is applied as a pure rotation about the
 * ecliptic pole; the ~47″/century drift of the ecliptic PLANE is dropped
 * (0.02 LD at 1 AU across the page's span).
 *
 * ── SCENE AXES: this stage is equatorial and Y-UP ────────────────────────
 * scene +Y is the north celestial pole, scene +X is the vernal equinox, and
 * the mapping from equatorial (x, y, z) is (x, z, −y) — a rotation, det = +1,
 * NOT the (x, z, y) swap the heliocentric orrery uses, which is a reflection
 * that only works there because that scene has no handed content in it.
 * `tests/neo-space.mjs` pins the determinant, because a mirrored sky puts
 * every RA backwards and looks completely plausible.
 *
 * Y-up also means `camera.up` stays (0,1,0) and OrbitControls NEVER needs
 * rebuilding — the scar that bit the Stage, Mars, the Moon and TIGA. If a
 * future mode ever tilts the camera's up vector, read those headers first.
 *
 * ── WHAT IS MODELLED, AND WHAT IS NOT ────────────────────────────────────
 * Positions are two-body propagation of osculating elements (neo-orbits.js),
 * which is why this page NEVER derives its close-approach LIST: JPL's CAD
 * table (integrated orbits) is the source of truth for when and how close,
 * and `compareApproach` exists precisely to measure — and show — how far the
 * two-body answer drifts from it. Disagreement is the honest output, not a
 * bug to hide.
 *
 * Magnitudes use the IAU two-parameter H, G system, which is a FIT over phase
 * angles below ~120°. Past that the fit is out of range and
 * `apparentMagnitude` says so rather than extrapolating — the same rule
 * js/flare-dem.js follows when it reports 304 unreachable.
 */

import {
    AU_KM, LD_KM, LD_AU, D2R, R2D, J2000,
    precessionLongitudeRad, rotateAboutPole, deriveGeocentric,
    CLASS_LABELS, diameterKmFromH, formatSize, elementsAgeNote,
} from './neo-orbits.js';
import { earthHeliocentric, moonGeocentric } from './horizons.js';

export { AU_KM, LD_KM, LD_AU, J2000 };

/** IUGG mean volumetric radius — the same number js/geo/coords.js draws with. */
export const EARTH_RADIUS_KM = 6371.0088;
/** Geostationary radius (a = (μ T²/4π²)^⅓ for one sidereal day), km from Earth's centre. */
export const GEO_RADIUS_KM = 42_164.0;
/** Mean obliquity at J2000 (IAU 1976), degrees. */
export const OBLIQUITY_J2000_DEG = 23.4392911;
/** Seconds of UT1 in one Julian day — the unit GMST_COEFF is expressed in. */
const SEC_PER_DAY = 86_400;
const TWO_PI = Math.PI * 2;

// ─────────────────────────────────────────────────────────────────────────────
// 1. The radial map — the page's one piece of spatial dishonesty
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scene radius of the Moon's mean distance. This and the drawn Earth radius
 * (1.0) are the ONLY two free numbers in the geocentric map; `gain` below is
 * derived from them. Chosen so the Moon's orbit ring sits comfortably inside
 * a default camera that also frames 0.5 AU.
 */
export const MOON_SCENE = 12;

export const GEO_MAP = Object.freeze({
    earthSceneRadius: 1,
    /** Derived: the gain that puts LD_KM at MOON_SCENE. Never type a value here. */
    gain: (MOON_SCENE - 1) / Math.log(LD_KM / EARTH_RADIUS_KM),
    /** Beyond this the catalogue stops being "near Earth" in any useful sense. */
    maxKm: 0.5 * AU_KM,
});

/**
 * Geocentric distance (km) → scene radius. Logarithmic, anchored at Earth's
 * surface; see the header. Distances at or inside the surface clamp to the
 * drawn globe rather than running to −∞.
 */
export function geoSceneRadius(dKm) {
    if (!(dKm > EARTH_RADIUS_KM)) return GEO_MAP.earthSceneRadius;
    return GEO_MAP.earthSceneRadius + GEO_MAP.gain * Math.log(dKm / EARTH_RADIUS_KM);
}

/** Inverse of `geoSceneRadius` — what a drawn radius means in km. Used by the ruler. */
export function geoSceneToKm(scene) {
    if (!(scene > GEO_MAP.earthSceneRadius)) return EARTH_RADIUS_KM;
    return EARTH_RADIUS_KM * Math.exp((scene - GEO_MAP.earthSceneRadius) / GEO_MAP.gain);
}

/**
 * The same quantity drawn honestly: Earth radii, linearly. This is what the
 * True-scale toggle switches the whole stage to — the compression is a
 * display choice, and a display choice you cannot turn off is a lie.
 */
export function trueSceneRadius(dKm) {
    return dKm / EARTH_RADIUS_KM;
}

/** Volumetric mean radius of the Moon (IAU), km. */
export const MOON_RADIUS_KM = 1737.4;

/**
 * BODIES ARE DRAWN AT TRUE RELATIVE SIZE. Only DISTANCE is compressed.
 *
 * This is the other half of the scale contract and it is what keeps the
 * compression legible: the drawn Earth is 1 R⊕ across, the drawn Moon is
 * 0.2727 of it, and that ratio is real in both display modes. A viewer who
 * knows how big the Moon looks next to Earth has a working ruler for every
 * other body on the stage, which is exactly what a logarithmic RADIUS takes
 * away. Never scale a body to make it easier to see — that is the one knob
 * that would make the ratio a lie, and the sprites and rock meshes already
 * exist for objects too small to draw.
 */
export function bodySceneRadius(radiusKm) {
    return radiusKm / EARTH_RADIUS_KM;
}

/** Ratio by which the log map compresses (or magnifies) a given distance. */
export function compressionAt(dKm) {
    const t = trueSceneRadius(dKm);
    return t > 0 ? geoSceneRadius(dKm) / t : 1;
}

/**
 * The ruler. Named shells with real radii, drawn as rings and labelled, so
 * the compression is legible rather than merely disclosed. `kind` drives the
 * styling; `alwaysOn` shells are the ones that must never be hidden, because
 * they are what makes the map readable at all.
 */
export const SHELLS = Object.freeze([
    { id: 'leo',  label: 'LEO · 400 km',      km: EARTH_RADIUS_KM + 400,  kind: 'orbit', alwaysOn: false },
    { id: 'geo',  label: 'GEO belt',          km: GEO_RADIUS_KM,          kind: 'orbit', alwaysOn: true },
    { id: 'ld1',  label: '1 lunar distance',  km: LD_KM,                  kind: 'ld',    alwaysOn: true },
    { id: 'ld5',  label: '5 LD',              km: 5 * LD_KM,              kind: 'ld',    alwaysOn: true },
    { id: 'ld10', label: '10 LD',             km: 10 * LD_KM,             kind: 'ld',    alwaysOn: false },
    // 0.05 AU is 19.46 LD — INSIDE the 20 LD ring, not outside it. The two
    // rings are a hair apart on purpose: JPL's close-approach table is cut at
    // the first and the orrery's Earth-local frame at the second, and drawing
    // them together is what shows that "20 LD" and "the watch radius" are not
    // the same fence.
    { id: 'au005', label: '0.05 AU · JPL watch', km: 0.05 * AU_KM,      kind: 'far',   alwaysOn: false },
    { id: 'ld20', label: '20 LD',             km: 20 * LD_KM,             kind: 'ld',    alwaysOn: true },
    { id: 'au20', label: '0.2 AU',            km: 0.2 * AU_KM,            kind: 'far',   alwaysOn: true },
]);

/** View horizons the page offers, nearest first. `default` is what it boots with. */
export const HORIZONS = Object.freeze([
    { id: 'ld5',   label: '5 LD',    km: 5 * LD_KM },
    { id: 'ld20',  label: '20 LD',   km: 20 * LD_KM },
    { id: 'au01',  label: '0.1 AU',  km: 0.1 * AU_KM },
    { id: 'au02',  label: '0.2 AU',  km: 0.2 * AU_KM },
    { id: 'au05',  label: '0.5 AU',  km: 0.5 * AU_KM },
]);
export const DEFAULT_HORIZON = 'au02';

// ─────────────────────────────────────────────────────────────────────────────
// 2. Frames
// ─────────────────────────────────────────────────────────────────────────────

/** Ecliptic OF DATE → ecliptic J2000. Inverse of neo-orbits.js `toOfDate`. */
export function ofDateToJ2000(x, y, z, jd) {
    return rotateAboutPole(x, y, z, -precessionLongitudeRad(jd));
}
/** Ecliptic J2000 → ecliptic of date. */
export function j2000ToOfDate(x, y, z, jd) {
    return rotateAboutPole(x, y, z, precessionLongitudeRad(jd));
}

/** Mean obliquity of the ecliptic (degrees) at JD — IAU 1980, valid ±2 millennia. */
export function obliquityDeg(jd) {
    const T = (jd - J2000) / 36525;
    return OBLIQUITY_J2000_DEG - 0.0130042 * T - 1.64e-7 * T * T + 5.04e-7 * T * T * T;
}

/** Ecliptic → equatorial about +x by ε (degrees). */
export function eclipticToEquatorial(x, y, z, epsDeg = OBLIQUITY_J2000_DEG) {
    const e = epsDeg * D2R, c = Math.cos(e), s = Math.sin(e);
    return { x, y: c * y - s * z, z: s * y + c * z };
}
/** Equatorial → ecliptic about +x by −ε. */
export function equatorialToEcliptic(x, y, z, epsDeg = OBLIQUITY_J2000_DEG) {
    const e = epsDeg * D2R, c = Math.cos(e), s = Math.sin(e);
    return { x, y: c * y + s * z, z: -s * y + c * z };
}

/**
 * Equatorial (x toward the equinox, z toward the pole) → SCENE.
 * (x, y, z) → (x, z, −y): a rotation, determinant +1. See the header — the
 * reflection the orrery uses would mirror the sky and look fine doing it.
 */
export function equatorialToScene(x, y, z) { return { x, y: z, z: -y }; }
/** Inverse of `equatorialToScene`. */
export function sceneToEquatorial(x, y, z) { return { x, y: -z, z: y }; }

/**
 * Geocentric ecliptic J2000 vector (AU) → scene position, on whichever radial
 * map is active. Returns the scene point plus the quantities every readout
 * needs, so a caller never recomputes the distance it just drew.
 */
export function geoToScene(gx, gy, gz, { trueScale = false, epsDeg = OBLIQUITY_J2000_DEG } = {}) {
    const dAU = Math.hypot(gx, gy, gz);
    const dKm = dAU * AU_KM;
    const eq = eclipticToEquatorial(gx, gy, gz, epsDeg);
    const s = equatorialToScene(eq.x, eq.y, eq.z);
    const r = trueScale ? trueSceneRadius(dKm) : geoSceneRadius(dKm);
    const k = dAU > 0 ? r / dAU : 0;
    return { x: s.x * k, y: s.y * k, z: s.z * k, dAU, dKm, dLD: dKm / LD_KM, sceneRadius: r };
}

/** Right ascension / declination (degrees, J2000) of a geocentric ecliptic J2000 vector. */
export function raDecFromEclipticJ2000(gx, gy, gz) {
    const eq = eclipticToEquatorial(gx, gy, gz, OBLIQUITY_J2000_DEG);
    const r = Math.hypot(eq.x, eq.y, eq.z);
    if (!(r > 0)) return { raDeg: 0, decDeg: 0, distAU: 0 };
    let ra = Math.atan2(eq.y, eq.x) * R2D;
    if (ra < 0) ra += 360;
    return { raDeg: ra, decDeg: Math.asin(Math.max(-1, Math.min(1, eq.z / r))) * R2D, distAU: r };
}

/** "17h 42.3m +28.4°" — the form an observer actually reads. */
export function formatRaDec(raDeg, decDeg) {
    if (!Number.isFinite(raDeg) || !Number.isFinite(decDeg)) return '—';
    const hTotal = ((raDeg % 360) + 360) % 360 / 15;
    const h = Math.floor(hTotal);
    const m = (hTotal - h) * 60;
    const sign = decDeg < 0 ? '−' : '+';
    return `${h}h ${m.toFixed(1)}m ${sign}${Math.abs(decDeg).toFixed(1)}°`;
}

// ── The drawn Earth's frame ─────────────────────────────────────────────────
//
// The stage is J2000, but the Earth's own rotation is measured from the
// equinox OF DATE (that is what sidereal time IS), so the globe cannot simply
// be spun by GMST inside a J2000 scene: it would sit 0.37° — the accumulated
// general precession — away from the sky drawn around it. That is only ~1 px
// on a 200 px globe, which is exactly why it would never be noticed, and it
// would put the observer's drawn horizon out of step with the altitude and
// azimuth the readouts print beside it.
//
// The fix costs one matrix, because a rotation of every object about the
// ecliptic pole is a rigid rotation OF THE WHOLE SCENE: rather than precess
// 38 000 positions per frame, the page precesses the Earth the other way.
// `earthSceneMatrix` is that rotation, already conjugated into scene axes, so
// a renderer can hang the globe (and everything Earth-fixed) off one group and
// spin the globe by GMST about that group's own +Y.

const mul3 = (A, B) => {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
    return C;
};
const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const rotZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
/** Apply a row-major 3×3 to a vector. */
export function applyMatrix3(m, v) {
    return {
        x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
        y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
        z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
    };
}

/**
 * Equatorial OF DATE → equatorial J2000, as a row-major 3×3. The chain is
 * equatorial(date) → ecliptic(date) → ecliptic(J2000) → equatorial(J2000),
 * i.e. the same three conversions the scalar helpers above make one at a time.
 */
export function ofDateEquatorialToJ2000Matrix(jd) {
    const epsDate = obliquityDeg(jd) * D2R;
    const epsJ2000 = OBLIQUITY_J2000_DEG * D2R;
    const pA = precessionLongitudeRad(jd);
    return mul3(rotX(epsJ2000), mul3(rotZ(-pA), rotX(-epsDate)));
}

/**
 * The same rotation expressed in SCENE axes (S·R·S⁻¹ for the scene basis S).
 * Row-major 3×3, ready to drop into a renderer's object matrix.
 */
export function earthSceneMatrix(jd) {
    const R = ofDateEquatorialToJ2000Matrix(jd);
    // S maps equatorial (x,y,z) → scene (x,z,−y); S⁻¹ maps back. Conjugating a
    // 3×3 by a signed axis permutation is a permutation of its entries, but
    // spelling the multiplication out is what keeps this checkable.
    const S = [1, 0, 0, 0, 0, 1, 0, -1, 0];
    const Sinv = [1, 0, 0, 0, 0, -1, 0, 1, 0];
    return mul3(S, mul3(R, Sinv));
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Sidereal time and the rotating Earth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Greenwich Mean Sidereal Time (radians) at a UT1 Julian Day — IAU 1982,
 * the expression whose constant term IS the defining value at J2000
 * (67310.54841 s = 18h 41m 50.54841s). tests/neo-space.mjs pins that anchor.
 *
 * UT1 − UTC is under 0.9 s by definition, i.e. under 0.004° of Earth
 * rotation; this kernel takes UTC and says so rather than carrying a leap
 * table that would go stale in the repo.
 */
export function gmstRad(jdUt1) {
    const frac = ((jdUt1 - 0.5) % 1 + 1) % 1;              // days elapsed since 0h UT
    const T0 = (Math.floor(jdUt1 - 0.5) + 0.5 - J2000) / 36525;
    // Meeus 12.4's split: the polynomial is evaluated at 0h and the elapsed
    // fraction is added at the sidereal rate, so the enormous secular
    // coefficient never multiplies a fraction of a day.
    let s = 67310.54841
        + (876600 * 3600 + 8640184.812866) * T0
        + 0.093104 * T0 * T0
        - 6.2e-6 * T0 * T0 * T0
        + frac * SEC_PER_DAY * 1.00273790935;
    s = ((s % SEC_PER_DAY) + SEC_PER_DAY) % SEC_PER_DAY;
    return (s / SEC_PER_DAY) * TWO_PI;
}

/**
 * Earth-fixed (lat, lon, altitude) → equatorial OF DATE, in Earth radii.
 * Spherical Earth: the WGS-84 flattening moves a mid-latitude site by ~11 km,
 * which is 0.003 LD — below every distance this page prints, and far below
 * the two-body position error it is added to.
 */
export function observerEquatorialOfDate(latDeg, lonDeg, gmst, altKm = 0) {
    const lat = latDeg * D2R;
    const theta = gmst + lonDeg * D2R;                     // local apparent sidereal angle
    const r = (EARTH_RADIUS_KM + altKm) / EARTH_RADIUS_KM; // Earth radii
    const cl = Math.cos(lat);
    return { x: r * cl * Math.cos(theta), y: r * cl * Math.sin(theta), z: r * Math.sin(lat) };
}

/**
 * Altitude / azimuth of a geocentric ecliptic J2000 vector (AU) from a site.
 *
 * TOPOCENTRIC, not geocentric: the observer's own offset from Earth's centre
 * is subtracted before the angles are taken. That matters more than it looks
 * — the diurnal parallax is 0.95° at one lunar distance and 9.5° at 0.1 LD,
 * which is the difference between "just above your horizon" and "not up".
 *
 * The object is rotated into the equinox OF DATE first, because GMST is
 * measured from that equinox; using the J2000 vector with an of-date sidereal
 * angle is a 0.4° error in 2026 that looks entirely reasonable.
 */
export function topocentricAltAz(gx, gy, gz, { latDeg, lonDeg, altKm = 0 }, jd) {
    const od = j2000ToOfDate(gx, gy, gz, jd);
    const eq = eclipticToEquatorial(od.x, od.y, od.z, obliquityDeg(jd));
    // Everything in Earth radii so the observer offset is O(1).
    const k = AU_KM / EARTH_RADIUS_KM;
    const gmst = gmstRad(jd);
    const obs = observerEquatorialOfDate(latDeg, lonDeg, gmst, altKm);
    const tx = eq.x * k - obs.x, ty = eq.y * k - obs.y, tz = eq.z * k - obs.z;
    const range = Math.hypot(tx, ty, tz);
    if (!(range > 0)) return { altDeg: 0, azDeg: 0, rangeKm: 0, parallaxDeg: 0 };
    // Rotate into the local SEZ frame: S (south), E (east), Z (up).
    const lat = latDeg * D2R;
    const theta = gmst + lonDeg * D2R;
    const sl = Math.sin(lat), cl = Math.cos(lat);
    const st = Math.sin(theta), ct = Math.cos(theta);
    const S =  sl * ct * tx + sl * st * ty - cl * tz;
    const E = -st * tx + ct * ty;
    const Z =  cl * ct * tx + cl * st * ty + sl * tz;
    // Clamp before the arcsine: at the zenith Z/range is 1 up to one ulp, and
    // one ulp over is NaN — a silent hole exactly where the answer matters most.
    const altDeg = Math.asin(Math.max(-1, Math.min(1, Z / range))) * R2D;
    let azDeg = Math.atan2(E, -S) * R2D;
    if (azDeg < 0) azDeg += 360;
    // How much of that angle the observer's own offset is worth.
    const geoRange = Math.hypot(eq.x, eq.y, eq.z) * k;
    const cosSep = (tx * eq.x * k + ty * eq.y * k + tz * eq.z * k) / (range * geoRange);
    return {
        altDeg, azDeg,
        rangeKm: range * EARTH_RADIUS_KM,
        parallaxDeg: Math.acos(Math.max(-1, Math.min(1, cosSep))) * R2D,
    };
}

/** 16-point compass label for an azimuth. */
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compass16(azDeg) {
    if (!Number.isFinite(azDeg)) return '—';
    return COMPASS[Math.round((((azDeg % 360) + 360) % 360) / 22.5) % 16];
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Ephemeris adapters — ONE conversion of the of-date sources to J2000
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Earth's heliocentric position in ecliptic J2000 (AU) at JD, from the page's
 * own VSOP87D series. The rotation out of of-date happens HERE and nowhere
 * else, so a caller can never forget it.
 */
// Single-entry memo. The stage, the propagation request and the readout pass
// all ask for the same instant within one frame, and VSOP87D is a few hundred
// terms; the functions stay pure (same jd in, same object out) and the cache is
// keyed on the argument alone.
let _earthMemo = { jd: NaN, v: null };
export function earthHelioJ2000(jd) {
    if (_earthMemo.jd === jd) return _earthMemo.v;
    const e = earthHeliocentric(jd);
    const j = ofDateToJ2000(e.x_AU, e.y_AU, e.z_AU, jd);
    const v = Object.freeze({ x: j.x, y: j.y, z: j.z, rAU: e.dist_AU });
    _earthMemo = { jd, v };
    return v;
}

/**
 * The Moon's geocentric position in ecliptic J2000 (AU and km) at JD, from
 * the page's own Meeus ch. 47 series (~1° in longitude, ~100 km in distance —
 * which is 0.00026 LD, invisible on this stage but stated because the Moon is
 * drawn as a ruler mark).
 */
let _moonMemo = { jd: NaN, v: null };
export function moonGeoJ2000(jd) {
    if (_moonMemo.jd === jd) return _moonMemo.v;
    const m = moonGeocentric(jd);
    const lon = m.lon_rad, lat = m.lat_rad, r = m.dist_AU;
    const cl = Math.cos(lat);
    const od = { x: r * cl * Math.cos(lon), y: r * cl * Math.sin(lon), z: r * Math.sin(lat) };
    const j = ofDateToJ2000(od.x, od.y, od.z, jd);
    const v = Object.freeze({ x: j.x, y: j.y, z: j.z, distKm: m.dist_km, distAU: m.dist_AU });
    _moonMemo = { jd, v };
    return v;
}

/** Sun's geocentric direction (unit, ecliptic J2000): the anti-Earth direction. */
export function sunGeoDirectionJ2000(jd) {
    const e = earthHelioJ2000(jd);
    const r = Math.hypot(e.x, e.y, e.z) || 1;
    return { x: -e.x / r, y: -e.y / r, z: -e.z / r, distAU: r };
}

/**
 * Sub-solar geographic point (degrees) at JD — where local noon is, and
 * therefore where the drawn terminator falls. Derived from the SAME Earth
 * ephemeris everything else on the stage uses, rather than a second solar
 * series, so the lit hemisphere and the Sun marker cannot disagree.
 */
export function subSolarPoint(jd) {
    const s = sunGeoDirectionJ2000(jd);
    const od = j2000ToOfDate(s.x, s.y, s.z, jd);
    const eq = eclipticToEquatorial(od.x, od.y, od.z, obliquityDeg(jd));
    const dec = Math.asin(Math.max(-1, Math.min(1, eq.z / (Math.hypot(eq.x, eq.y, eq.z) || 1)))) * R2D;
    const ra = Math.atan2(eq.y, eq.x);
    let lon = (ra - gmstRad(jd)) * R2D;
    lon = ((lon + 180) % 360 + 360) % 360 - 180;
    return { latDeg: dec, lonDeg: lon };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4b. The Moon — phase, path, and the apsides of the current orbit
// ─────────────────────────────────────────────────────────────────────────────
//
// The Moon is the stage's ruler mark: it is the one object a visitor already
// has an intuition for, so its distance, its size relative to Earth and its
// phase all have to be right, and all three come from here. `moonGeoJ2000`
// above supplies the position; these supply everything drawn around it.

/** Mean synodic month (new moon to new moon), days. */
export const SYNODIC_MONTH_DAYS = 29.530588853;
/** Mean sidereal month (one circuit against the stars), days. */
export const SIDEREAL_MONTH_DAYS = 27.321661;
/** Mean anomalistic month (perigee to perigee), days. */
export const ANOMALISTIC_MONTH_DAYS = 27.554549;

const PHASE_NAMES = [
    'New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous',
    'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent',
];

/**
 * The Moon's phase at JD.
 *
 *   phaseAngleDeg  the Sun–Moon–Earth angle. 0° is full, 180° is new — note
 *                  the direction, it is the angle AT THE MOON and it is the
 *                  argument of the illumination law, not the elongation.
 *   illuminated    the lit fraction of the disc as seen from Earth,
 *                  (1 + cos α)/2 exactly. This is an identity, not a fit.
 *   elongationDeg  the Sun–Earth–Moon angle, which is what "how far from the
 *                  Sun in the sky" means and what the phase NAME keys off.
 *   waxing         true between new and full. Decided by the sign of the
 *                  Moon's ecliptic longitude minus the Sun's, because the
 *                  elongation alone is symmetric about full and cannot tell
 *                  a waxing gibbous from a waning one.
 *
 * Both bodies come from this module's own adapters, so the phase can never
 * disagree with the positions drawn on the stage.
 */
export function moonPhase(jd) {
    const m = moonGeoJ2000(jd);
    const s = sunGeoDirectionJ2000(jd);           // unit, geocentric, ecliptic J2000
    const mr = Math.hypot(m.x, m.y, m.z) || 1;
    const mu = { x: m.x / mr, y: m.y / mr, z: m.z / mr };

    // Elongation: the angle at EARTH between the Sun and the Moon.
    const cosElong = mu.x * s.x + mu.y * s.y + mu.z * s.z;
    const elongationDeg = Math.acos(Math.max(-1, Math.min(1, cosElong))) * R2D;

    // Phase angle: the angle at the MOON between the Earth and the Sun. The
    // Sun is ~390 Moon-distances away, so its direction from the Moon differs
    // from its direction from Earth by well under a degree — but the whole
    // point of a phase is that small angle near new and full, so it is carried
    // properly rather than approximated by 180° − elongation.
    const sunAU = s.distAU;
    const toSun = { x: s.x * sunAU - m.x, y: s.y * sunAU - m.y, z: s.z * sunAU - m.z };
    const tsr = Math.hypot(toSun.x, toSun.y, toSun.z) || 1;
    const cosPhase = (-mu.x * toSun.x - mu.y * toSun.y - mu.z * toSun.z) / tsr;
    const phaseAngleDeg = Math.acos(Math.max(-1, Math.min(1, cosPhase))) * R2D;
    const illuminated = (1 + Math.cos(phaseAngleDeg * D2R)) / 2;

    // Waxing or waning, from the ecliptic longitude difference.
    const moonLon = Math.atan2(m.y, m.x);
    const sunLon = Math.atan2(s.y, s.x);
    let dLon = ((moonLon - sunLon) * R2D % 360 + 360) % 360;
    const waxing = dLon < 180;
    const ageDays = (dLon / 360) * SYNODIC_MONTH_DAYS;

    // Name from the longitude difference — the octant the Moon is actually in.
    const name = PHASE_NAMES[Math.floor(((dLon + 22.5) % 360) / 45)];

    return {
        phaseAngleDeg, illuminated, elongationDeg, waxing, ageDays, name,
        distKm: m.distKm,
        angularDiameterDeg: 2 * Math.atan(MOON_RADIUS_KM / m.distKm) * R2D,
    };
}

/**
 * The Moon's geocentric path, sampled over `days` from `jd`. Returned in the
 * same ecliptic J2000 frame as everything else, so a renderer maps it with the
 * same `geoToScene` it uses for the Moon itself and the two cannot part
 * company. Default span is one SIDEREAL month, which is the circuit that
 * closes in an inertial frame — a synodic month would leave a visible gap.
 */
export function moonPath(jd, samples = 96, days = SIDEREAL_MONTH_DAYS) {
    const out = [];
    for (let k = 0; k < samples; k++) {
        const t = jd + (k / samples) * days;
        const m = moonGeoJ2000(t);
        out.push({ x: m.x, y: m.y, z: m.z, distKm: m.distKm, jd: t });
    }
    return out;
}

/**
 * Perigee and apogee of the orbit the Moon is on now: the nearest and farthest
 * approach within one anomalistic month of `jd`, refined by the same
 * golden-section search the close-approach code uses.
 *
 * These are worth drawing because the lunar orbit's eccentricity is the thing
 * a circle-drawn "Moon orbit" hides: perigee and apogee differ by about 13 %,
 * which is a visible amount on any honest path and zero on a ring.
 */
export function moonApsides(jd, span = ANOMALISTIC_MONTH_DAYS) {
    const dist = (t) => moonGeoJ2000(t).distKm;
    const neg = (t) => -dist(t);
    const perigee = findApproach(dist, jd + span / 2, span / 2, 120, 1e-4);
    const apogee = findApproach(neg, jd + span / 2, span / 2, 120, 1e-4);
    return {
        perigee: perigee ? { jd: perigee.jd, km: perigee.distAU } : null,
        apogee: apogee ? { jd: apogee.jd, km: -apogee.distAU } : null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Bulk geocentric derivation (the worker's hot loop)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-exported from js/neo-orbits.js, where it lives beside its of-date
 * sibling `deriveFrames`: both are the same allocation-free bulk pass over
 * `propagateColumns` output, and js/neo-worker.js imports it from there so
 * that a worker propagating osculating elements never has to parse the
 * VSOP87D + Meeus series this module brings with it. It is part of the
 * geocentric kernel's surface, so it is exported from here too — and
 * tests/neo-space.mjs is what pins it against the of-date path.
 */
export { deriveGeocentric };

// ─────────────────────────────────────────────────────────────────────────────
// 6. Photometry — how bright it actually looks
// ─────────────────────────────────────────────────────────────────────────────

/** Default slope parameter of the IAU H, G system when a body has no fitted G. */
export const DEFAULT_G = 0.15;
/** The H, G fit is calibrated below this phase angle; past it we refuse to extrapolate. */
export const PHASE_FIT_MAX_DEG = 120;

/**
 * Phase angle α (degrees) at the object, between the Sun and the observer.
 * Taken from the triangle rather than from vectors so it is exact for the
 * distances the caller already has: r (object–Sun), Δ (object–Earth),
 * R (Earth–Sun), all AU.
 */
export function phaseAngleDeg(rHelioAU, dGeoAU, rEarthAU) {
    const denom = 2 * rHelioAU * dGeoAU;
    if (!(denom > 0)) return 0;
    const c = (rHelioAU * rHelioAU + dGeoAU * dGeoAU - rEarthAU * rEarthAU) / denom;
    return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}

/**
 * Apparent visual magnitude in the IAU two-parameter (H, G) system:
 *
 *     V = H + 5 log₁₀(r Δ) − 2.5 log₁₀[(1 − G) Φ₁ + G Φ₂]
 *     Φᵢ = exp(−Aᵢ (tan ½α)^Bᵢ),  A = (3.33, 1.87), B = (0.63, 1.22)
 *
 * Returns `{ mag, phaseDeg, outOfRange }`. Past PHASE_FIT_MAX_DEG the fit is
 * outside its calibration and `mag` is null with `outOfRange` set — the
 * number is not there to be guessed at. Comets are not in this system at all
 * (their brightness is driven by activity, not a phase function), so a caller
 * with no H gets null.
 */
export function apparentMagnitude(H, rHelioAU, dGeoAU, rEarthAU, G = DEFAULT_G) {
    const phaseDeg = phaseAngleDeg(rHelioAU, dGeoAU, rEarthAU);
    if (!Number.isFinite(H) || !(rHelioAU > 0) || !(dGeoAU > 0)) {
        return { mag: null, phaseDeg, outOfRange: false };
    }
    if (phaseDeg >= PHASE_FIT_MAX_DEG) return { mag: null, phaseDeg, outOfRange: true };
    const t = Math.tan(phaseDeg * D2R / 2);
    const p1 = Math.exp(-3.33 * Math.pow(t, 0.63));
    const p2 = Math.exp(-1.87 * Math.pow(t, 1.22));
    const g = Math.max(0, Math.min(1, G));
    const phi = (1 - g) * p1 + g * p2;
    const mag = H + 5 * Math.log10(rHelioAU * dGeoAU) - 2.5 * Math.log10(Math.max(phi, 1e-12));
    return { mag, phaseDeg, outOfRange: false };
}

/** Angular diameter (arcseconds) of a body of diameter `diamKm` at `distKm`. */
export function angularDiameterArcsec(diamKm, distKm) {
    if (!(diamKm > 0) || !(distKm > 0)) return null;
    return 2 * Math.atan(diamKm / (2 * distKm)) * R2D * 3600;
}

/**
 * Apparent motion across the sky (degrees per hour) between two geocentric
 * vectors `dtDays` apart. This is the number that decides whether an object
 * is trackable — a 0.1 LD flyby crosses several degrees an hour and no
 * sidereal-drive telescope will hold it.
 */
export function angularRateDegPerHour(a, b, dtDays) {
    const ra = Math.hypot(a[0], a[1], a[2]), rb = Math.hypot(b[0], b[1], b[2]);
    if (!(ra > 0) || !(rb > 0) || !(dtDays > 0)) return null;
    const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (ra * rb);
    const sep = Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
    return sep / (dtDays * 24);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Close approach — refinement, and the honest comparison against JPL
// ─────────────────────────────────────────────────────────────────────────────

const GOLDEN_INV = (Math.sqrt(5) - 1) / 2;

/**
 * Golden-section minimisation of a unimodal `f(t)` on [a, b] to `tolDays`.
 * Returns `{ t, value, iterations }`. Golden section rather than a derivative
 * method because `f` is a distance whose derivative near the minimum is the
 * small difference of two large velocities — the thing floating point is
 * worst at.
 */
export function refineMinimum(f, a, b, tolDays = 1e-5) {
    let lo = a, hi = b;
    let c = hi - GOLDEN_INV * (hi - lo);
    let d = lo + GOLDEN_INV * (hi - lo);
    let fc = f(c), fd = f(d), it = 0;
    while (hi - lo > tolDays && it < 200) {
        if (fc < fd) { hi = d; d = c; fd = fc; c = hi - GOLDEN_INV * (hi - lo); fc = f(c); }
        else         { lo = c; c = d; fc = fd; d = lo + GOLDEN_INV * (hi - lo); fd = f(d); }
        it++;
    }
    const t = (lo + hi) / 2;
    return { t, value: f(t), iterations: it };
}

/**
 * Find the closest approach of `f(jd) → distance` near `jdCenter`: a coarse
 * scan over ±`spanDays` to bracket the deepest local minimum, then golden
 * section inside that bracket. Returns null when the minimum sits on the edge
 * of the window — an unbracketed minimum is not a minimum, and reporting one
 * anyway is how a search window's own edge becomes a "close approach".
 */
export function findApproach(f, jdCenter, spanDays, coarseSteps = 240, tolDays = 1e-5) {
    const n = Math.max(4, coarseSteps | 0);
    const dt = (2 * spanDays) / n;
    let bestI = -1, bestV = Infinity;
    const vals = new Float64Array(n + 1);
    for (let i = 0; i <= n; i++) {
        vals[i] = f(jdCenter - spanDays + i * dt);
        if (vals[i] < bestV) { bestV = vals[i]; bestI = i; }
    }
    if (bestI <= 0 || bestI >= n) return null;
    const a = jdCenter - spanDays + (bestI - 1) * dt;
    const b = jdCenter - spanDays + (bestI + 1) * dt;
    const r = refineMinimum(f, a, b, tolDays);
    return { jd: r.t, distAU: r.value, bracketDays: dt, coarseMinAU: bestV };
}

/**
 * Compare this page's two-body approach against JPL's integrated one.
 *
 * The output of this function is a DISAGREEMENT, and that is what it is for:
 * the catalogue ships osculating elements, the page propagates them with two
 * bodies, and JPL integrates with all of them plus relativity. Showing the
 * gap is the honest way to draw a flyby at all — the alternative is to draw
 * ours and quote theirs, which reads as one number.
 */
export function compareApproach(ours, jplDistAU, jplJd) {
    if (!ours || !Number.isFinite(jplDistAU)) return null;
    const dDistAU = ours.distAU - jplDistAU;
    const dTimeHours = Number.isFinite(jplJd) ? (ours.jd - jplJd) * 24 : null;
    return {
        oursAU: ours.distAU, jplAU: jplDistAU,
        dDistAU, dDistLD: dDistAU / LD_AU,
        dDistFrac: jplDistAU > 0 ? dDistAU / jplDistAU : null,
        dTimeHours,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Impact energy — the question every visitor actually asks
// ─────────────────────────────────────────────────────────────────────────────

/** Bulk density (kg/m³) by spectral guess. Stony is the default for unknowns. */
export const DENSITY = Object.freeze({ cometary: 600, carbonaceous: 1400, stony: 2600, metallic: 7800 });
const JOULES_PER_MEGATON = 4.184e15;

/**
 * Kinetic energy of an impact, in joules and megatons TNT. `diamKm` and the
 * density are both estimates for almost every object (diameter usually comes
 * from H and an ASSUMED albedo), so the return carries the assumptions it was
 * computed under and the caller is expected to print them.
 */
export function impactEnergy(diamKm, vKms, densityKgM3 = DENSITY.stony) {
    if (!(diamKm > 0) || !(vKms > 0)) return null;
    const rM = diamKm * 500;                                 // radius in metres
    const massKg = densityKgM3 * (4 / 3) * Math.PI * rM * rM * rM;
    const joules = 0.5 * massKg * (vKms * 1000) ** 2;
    return { joules, megatons: joules / JOULES_PER_MEGATON, massKg, densityKgM3 };
}

/** Human comparison for an energy in megatons. Reference events, not a scale. */
export function energyComparison(megatons) {
    if (!Number.isFinite(megatons)) return '—';
    if (megatons < 0.001) return 'below the smallest recorded bolide';
    if (megatons < 0.1)   return `${(megatons * 1000).toFixed(0)} kt — bolide class`;
    if (megatons < 1)     return `${megatons.toFixed(2)} Mt — Chelyabinsk was ~0.5 Mt`;
    if (megatons < 50)    return `${megatons.toFixed(1)} Mt — Tunguska was ~10–15 Mt`;
    if (megatons < 1e5)   return `${(megatons / 1000).toFixed(1)} Gt — regional devastation`;
    return `${(megatons / 1e6).toFixed(1)} Tt — Chicxulub was ~1×10⁸ Mt`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. The object row — ONE derivation of everything a readout shows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything the page knows about one object at one instant, derived once.
 *
 * The live board, the selected-object card, the approach rows and the labels
 * all render from this, so a distance printed in a table and the same distance
 * in the card cannot disagree — the failure mode that made the orrery's flyby
 * labels re-raster per frame with two different numbers on them.
 *
 * `el` is a normalised element record (js/neo-orbits.js `normalizeElements`)
 * or the equivalent metadata the worker ships back. `ctx.geo` is the object's
 * geocentric ecliptic J2000 vector in AU — the worker's `geoframe` output.
 * Everything optional degrades to null rather than to a guess: no observer,
 * no altitude; no H, no magnitude; no previous sample, no sky rate.
 */
export function buildObjectRow(el, ctx) {
    const [gx, gy, gz] = ctx.geo;
    const distAU = Math.hypot(gx, gy, gz);
    const distKm = distAU * AU_KM;
    const rHelioAU = ctx.rHelioAU ?? null;
    const earthRAU = ctx.earthRAU ?? null;

    const rd = raDecFromEclipticJ2000(gx, gy, gz);
    const isComet = !!(el.flags & 4);
    const isPHA = !!(el.flags & 2);
    const isInterstellar = !!(el.flags & 8);

    // Size: a measured diameter when JPL has one, otherwise the standard
    // H → D conversion, which assumes an albedo. Which of the two it is has to
    // travel with the number — a 0.14-albedo estimate and a radar diameter are
    // not the same claim.
    let sizeKm = Number.isFinite(el.diam) ? el.diam : null;
    let sizeSource = sizeKm != null ? 'measured' : null;
    if (sizeKm == null && Number.isFinite(el.H)) {
        sizeKm = diameterKmFromH(el.H);
        sizeSource = 'from H, albedo 0.14 assumed';
    }

    // Brightness. Comets are excluded by construction: their light is driven
    // by activity, not by a phase function over a solid surface.
    let mag = null, phaseDeg = null, magNote = null;
    if (rHelioAU != null && earthRAU != null) {
        if (isComet) {
            phaseDeg = phaseAngleDeg(rHelioAU, distAU, earthRAU);
            magNote = 'comet — brightness is activity-driven, not H,G';
        } else {
            const r = apparentMagnitude(el.H, rHelioAU, distAU, earthRAU);
            mag = r.mag; phaseDeg = r.phaseDeg;
            if (r.outOfRange) magNote = `phase ${r.phaseDeg.toFixed(0)}° — past the H,G fit limit`;
            else if (mag == null) magNote = 'no absolute magnitude published';
        }
    }

    // Where to point, if we know where you are.
    let sky = null;
    if (ctx.observer && Number.isFinite(ctx.observer.latDeg) && Number.isFinite(ctx.observer.lonDeg)) {
        const aa = topocentricAltAz(gx, gy, gz, ctx.observer, ctx.jd);
        sky = { ...aa, compass: compass16(aa.azDeg), up: aa.altDeg > 0 };
    }

    const rateDegPerHour = ctx.prevGeo && ctx.prevDtDays > 0
        ? angularRateDegPerHour([gx, gy, gz], ctx.prevGeo, ctx.prevDtDays)
        : null;

    return {
        index: ctx.index ?? null,
        des: el.des ?? null,
        name: el.name || el.des || 'unnamed',
        cls: el.cls ?? null,
        classLabel: CLASS_LABELS[el.cls] ?? el.cls ?? null,
        flags: el.flags | 0, isPHA, isComet, isInterstellar,
        H: Number.isFinite(el.H) ? el.H : null,
        moid: Number.isFinite(el.moid) ? el.moid : null,
        distAU, distKm, distLD: distKm / LD_KM, distLabel: formatGeoDistance(distKm),
        rHelioAU,
        sizeKm, sizeSource, sizeLabel: sizeKm != null ? formatSize(sizeKm) : '—',
        raDeg: rd.raDeg, decDeg: rd.decDeg, raDecLabel: formatRaDec(rd.raDeg, rd.decDeg),
        mag, magBand: visibilityBand(mag), phaseDeg, magNote,
        sky, rateDegPerHour,
        angularArcsec: angularDiameterArcsec(sizeKm, distKm),
        elementsNote: Number.isFinite(el.epoch) ? elementsAgeNote(el.epoch, ctx.jd) : null,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. Formatting helpers the readouts share
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Geocentric distance, in the unit a human would use at that range: km below
 * a tenth of a lunar distance (the flybys that make the news), LD out to 100,
 * AU beyond.
 */
export function formatGeoDistance(km) {
    if (!Number.isFinite(km)) return '—';
    const ld = km / LD_KM;
    if (ld < 0.1) return `${Math.round(km).toLocaleString('en-US')} km`;
    if (ld < 100) return `${ld < 10 ? ld.toFixed(2) : ld.toFixed(1)} LD`;
    return `${(km / AU_KM).toFixed(3)} AU`;
}

/** Signed hours/days until an instant, as a short relative label. */
export function formatRelativeTime(deltaDays) {
    if (!Number.isFinite(deltaDays)) return '—';
    const past = deltaDays < 0;
    const d = Math.abs(deltaDays);
    let s;
    if (d < 1 / 24) s = `${Math.round(d * 1440)} min`;
    else if (d < 2) s = `${(d * 24).toFixed(1)} h`;
    else s = `${d.toFixed(1)} d`;
    return past ? `${s} ago` : `in ${s}`;
}

/** Naked-eye / binocular / telescope band for an apparent magnitude. */
export function visibilityBand(mag) {
    if (!Number.isFinite(mag)) return null;
    if (mag <= 6.0)  return { id: 'naked-eye', label: 'naked eye' };
    if (mag <= 10.0) return { id: 'binocular', label: 'binoculars' };
    if (mag <= 16.0) return { id: 'amateur',   label: 'amateur telescope' };
    if (mag <= 22.0) return { id: 'survey',    label: 'survey telescope' };
    return { id: 'beyond', label: 'beyond most surveys' };
}
