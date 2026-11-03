/**
 * moon-ephemeris.js — where the Sun and the Earth are, from the Moon.
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE kernel: no DOM, no three.js, no fetch, no ambient time (every entry
 * point takes a Julian Day or a Date). Gated by tests/moon-ephemeris.mjs.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * Until 2026-11 moon.html lit the Moon from a FIXED vector ("updated from
 * lunar ephemeris" said the comment; it never was), hung the Earth at a
 * fixed direction, and printed a hard-coded 384,400 km while a separate
 * synodic-age formula named the phase. The terminator, the earthshine,
 * the sodium tail's anti-sunward axis and the argon dawn bulge were all
 * drawn against that invented Sun. This module gives the page the real
 * selenographic geometry for the instant it is rendering, and every
 * light-dependent layer reads it.
 *
 * ── WHAT IT COMPUTES, AND FROM WHAT ─────────────────────────────────────
 * The Moon's geocentric ecliptic position comes from js/horizons.js
 * `moonGeocentric` (Meeus ch. 47, the site's ONE lunar position — never
 * re-derive it here); the Sun's from `earthHeliocentric` (VSOP87D). The
 * sub-Earth and sub-solar points are Meeus ch. 53 (Ephemeris for Physical
 * Observations of the Moon): the OPTICAL libration from the Cassini-law
 * orientation of the lunar equator (I = 1.54242° to the ecliptic, node at
 * the orbit's ascending node Ω), with the Sun's selenographic position
 * through the Moon's heliocentric longitude λ_H = λ☉ + 180° + parallax.
 *
 * Two things are deliberately left out and disclosed:
 *   • Physical libration (l″, b″ ≲ 0.04°) — below what the 16-term lunar
 *     series resolves anyway.
 *   • Nutation Δψ (≲ 0.005°) — same reason.
 * Accuracy is set by moonGeocentric (~0.1° typical): the sub-Earth point
 * lands within a few tenths of a degree, the terminator within a pixel at
 * any zoom the page offers.
 *
 * Selenographic longitude is EAST-positive (toward Mare Crisium), latitude
 * north-positive — the same convention as js/artemis-data.js latLonToXYZ,
 * which `bodyVector` mirrors exactly (x = cosφ cosλ, y = sinφ, z = −cosφ sinλ)
 * so a direction from here can be handed to three.js without a frame step.
 */

import { moonGeocentric, earthHeliocentric, jdFromDate } from './horizons.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Inclination of the lunar equator to the ecliptic (Cassini's laws). */
export const LUNAR_EQUATOR_INCLINATION_DEG = 1.54242;
export const SYNODIC_MONTH_DAYS = 29.530588861;
export const MOON_RADIUS_KM = 1737.4;
/** DE430 mean distance; the HUD prints the live value, this is the reference. */
export const MEAN_DISTANCE_KM = 384400;

const norm360 = (deg) => ((deg % 360) + 360) % 360;
const norm180 = (deg) => { const d = norm360(deg); return d > 180 ? d - 360 : d; };

/** Julian Day from a Date, a number (already JD), or undefined (now is NOT a default — callers pass time). */
export function toJd(when) {
    if (typeof when === 'number') return when;
    if (when instanceof Date) return jdFromDate(when);
    throw new TypeError('moon-ephemeris: pass a Date or a Julian Day');
}

/** Longitude of the Moon's mean ascending node, degrees (Meeus 47.7). */
export function ascendingNodeDeg(jd) {
    const T = (jd - 2451545.0) / 36525;
    return norm360(125.0445479 - 1934.1362891 * T + 0.0020754 * T * T
        + T * T * T / 467441 - T * T * T * T / 60616000);
}

/** Moon's mean argument of latitude F, degrees (Meeus 47.5). */
export function argumentOfLatitudeDeg(jd) {
    const T = (jd - 2451545.0) / 36525;
    return norm360(93.2720950 + 483202.0175233 * T - 0.0036539 * T * T
        - T * T * T / 3526000 + T * T * T * T / 863310000);
}

/**
 * Selenographic coordinates of the sub-point of a body whose direction is
 * given as a geocentric-style ecliptic longitude/latitude (Meeus 53.1–53.3,
 * optical libration). For the Earth that is the Moon's own geocentric
 * (λ, β); for the Sun it is the Moon's HELIOCENTRIC direction (see
 * `subSolarPoint`). Returns { latDeg, lonDeg } with lon ∈ (−180, 180].
 */
export function selenographicSubPoint(lambdaDeg, betaDeg, jd) {
    const I = LUNAR_EQUATOR_INCLINATION_DEG * D2R;
    const W = (lambdaDeg - ascendingNodeDeg(jd)) * D2R;
    const beta = betaDeg * D2R;
    const A = Math.atan2(
        Math.sin(W) * Math.cos(beta) * Math.cos(I) - Math.sin(beta) * Math.sin(I),
        Math.cos(W) * Math.cos(beta),
    );
    const lonDeg = norm180(A * R2D - argumentOfLatitudeDeg(jd));
    const latDeg = Math.asin(-Math.sin(W) * Math.cos(beta) * Math.sin(I)
        - Math.sin(beta) * Math.cos(I)) * R2D;
    return { latDeg, lonDeg };
}

/** Unit vector in the body frame for a selenographic lat/lon (the latLonToXYZ convention). */
export function bodyVector(latDeg, lonDeg) {
    const phi = latDeg * D2R;
    const lam = lonDeg * D2R;
    return {
        x: Math.cos(phi) * Math.cos(lam),
        y: Math.sin(phi),
        z: -Math.cos(phi) * Math.sin(lam),
    };
}

/** Phase name from synodic age (days since new moon) — the page's historical bands. */
export function phaseName(ageDays) {
    const a = ((ageDays % SYNODIC_MONTH_DAYS) + SYNODIC_MONTH_DAYS) % SYNODIC_MONTH_DAYS;
    return a < 1.85 ? 'New Moon'
        : a < 7.38 ? 'Waxing Crescent'
        : a < 9.23 ? 'First Quarter'
        : a < 13.77 ? 'Waxing Gibbous'
        : a < 15.77 ? 'Full Moon'
        : a < 22.15 ? 'Waning Gibbous'
        : a < 23.99 ? 'Last Quarter'
        : 'Waning Crescent';
}

/**
 * The whole selenographic picture for one instant.
 * @param {Date|number} when  Date or Julian Day
 * @returns {{
 *   jd, distanceKm, apparentDiameterArcmin,
 *   moon: { lonDeg, latDeg }, sun: { lonDeg },
 *   subEarth: { latDeg, lonDeg },      // optical libration (l′, b′)
 *   subSolar: { latDeg, lonDeg },      // (l₀, b₀)
 *   colongitudeDeg,                    // c₀ = 90° − l₀, the morning terminator's longitude
 *   earthDir: {x,y,z}, sunDir: {x,y,z},   // body-frame unit vectors
 *   phaseAngleDeg,                     // Sun–Moon–Earth angle i
 *   illumination,                      // k = (1 + cos i)/2
 *   elongationDeg,                     // λ_moon − λ_sun, 0 = new, 180 = full
 *   ageDays, phase, waxing,
 * }}
 */
export function lunarGeometry(when) {
    const jd = toJd(when);
    const m = moonGeocentric(jd);
    const e = earthHeliocentric(jd);
    const sunLonDeg = norm360(e.lon + 180);
    const sunDistAu = e.dist_AU;

    // Sub-Earth point: the Moon's own geocentric direction (Meeus 53).
    const subEarth = selenographicSubPoint(m.lon, m.lat, jd);

    // Sub-solar point: the Moon as seen FROM the Sun — λ_H = λ☉ + 180° plus
    // the Earth–Moon parallax term (Δ/R in radians → degrees), β_H = (Δ/R)·β.
    const ratio = m.dist_AU / sunDistAu;
    const lambdaH = sunLonDeg + 180 + ratio * R2D * Math.cos(m.lat_rad) * Math.sin((sunLonDeg - m.lon) * D2R);
    const betaH = ratio * m.lat;
    const subSolar = selenographicSubPoint(lambdaH, betaH, jd);

    const earthDir = bodyVector(subEarth.latDeg, subEarth.lonDeg);
    const sunDir = bodyVector(subSolar.latDeg, subSolar.lonDeg);
    const cosI = Math.max(-1, Math.min(1, earthDir.x * sunDir.x + earthDir.y * sunDir.y + earthDir.z * sunDir.z));
    const phaseAngleDeg = Math.acos(cosI) * R2D;

    const elongationDeg = norm360(m.lon - sunLonDeg);
    const ageDays = elongationDeg / 360 * SYNODIC_MONTH_DAYS;

    return {
        jd,
        distanceKm: m.dist_km,
        apparentDiameterArcmin: 2 * Math.atan(MOON_RADIUS_KM / m.dist_km) * R2D * 60,
        moon: { lonDeg: m.lon, latDeg: m.lat },
        sun: { lonDeg: sunLonDeg },
        subEarth,
        subSolar,
        colongitudeDeg: norm360(90 - subSolar.lonDeg),
        earthDir,
        sunDir,
        phaseAngleDeg,
        illumination: (1 + cosI) / 2,
        elongationDeg,
        ageDays,
        phase: phaseName(ageDays),
        waxing: elongationDeg < 180,
    };
}

/**
 * The dawn (sunrise) limb direction in the body frame: with the spin axis
 * +Y and prograde rotation, a surface point crosses INTO sunlight where the
 * sun vector's eastward neighbour sits — (sunDir × up), which the exosphere
 * renderer used as its cross product before the ephemeris existed. Kept
 * here so the page and the renderer agree on which limb is dawn.
 */
export function dawnDirection(sunDir) {
    // sunDir × (0,1,0) = (−sz, 0, sx)
    const x = -sunDir.z, z = sunDir.x;
    const n = Math.hypot(x, z) || 1;
    return { x: x / n, y: 0, z: z / n };
}

/**
 * Local solar time at a selenographic point, hours (0 = midnight, 6 =
 * sunrise, 12 = noon), from the sub-solar longitude: LST = 12 + (lon − lon☉)/15.
 */
export function localSolarHours(lonDeg, subSolarLonDeg) {
    return ((12 + (lonDeg - subSolarLonDeg) / 15) % 24 + 24) % 24;
}

/** Solar zenith angle at (lat, lon), degrees, from the sub-solar point. */
export function solarZenithDeg(latDeg, lonDeg, subSolar) {
    const p = bodyVector(latDeg, lonDeg);
    const s = bodyVector(subSolar.latDeg, subSolar.lonDeg);
    const c = Math.max(-1, Math.min(1, p.x * s.x + p.y * s.y + p.z * s.z));
    return Math.acos(c) * R2D;
}
