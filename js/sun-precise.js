/**
 * sun-precise.js — where the Sun is, to arcseconds, for an observer on the ground. PURE.
 *
 * js/sun-altitude.js is the site's everyday Sun: NOAA's simplified series,
 * good to about an arcminute by its own header (measured here: up to ~0.02°
 * against this module over a year), and seventeen modules' gates pin its
 * numbers — it is NOT changed. This is the accurate one, for work where the
 * Sun's direction is the physics: a shadow edge on real terrain moves ~30 m
 * per arcminute of solar altitude at a 10° Sun over a 1 km ridge, and at
 * sunrise the ATMOSPHERE moves the Sun by half a degree — more than its own
 * diameter — which the everyday routine does not model at all.
 *
 * THE CHAIN (Meeus, Astronomical Algorithms 2nd ed.; the same steps as NREL's
 * SPA, Reda & Andreas 2004), each step named so it can be checked:
 *   1. Earth's heliocentric L, B, R  — js/earth-orbit.js vsop87Earth, the
 *      site's ONE Earth (truncated VSOP87D, < 1″). Never a second series.
 *   2. geocentric Sun: λ = L + 180°, β = −B; FK5 correction (Meeus 25.9)
 *   3. nutation Δψ, Δε (Meeus ch. 22, the four largest terms: 0.5″ / 0.1″)
 *      and the mean obliquity (22.2)
 *   4. aberration −20.4898″ / R  ⇒ apparent longitude
 *   5. apparent right ascension and declination (13.3, 13.4)
 *   6. APPARENT sidereal time = neo-space.js gmstRad (the site's one GMST,
 *      IAU 1982) + the equation of the equinoxes Δψ·cos ε
 *   7. diurnal parallax on the WGS-84 ellipsoid at the observer's height
 *      (ch. 40) — 8.8″, the Sun is close enough for it to count
 *   8. altitude and azimuth; then atmospheric REFRACTION (Bennett's formula
 *      scaled by pressure and temperature, as SPA uses it)
 *
 * TIME. The Earth's rotation (step 6) runs on UT, which is what a Date is, to
 * within the 0.9 s UTC is allowed to drift — 0.004° of rotation, the same
 * statement neo-space.js makes. The Earth's ORBIT (step 1) runs on
 * Terrestrial Time, TT = UT + ΔT; ΔT is ~69 s now and is taken from Espenak &
 * Meeus's 2005–2050 polynomial (`deltaTSeconds`), or passed in. A 10 s error
 * in ΔT moves the Sun 0.4″ — it is not the limit.
 *
 * WHAT IT RETURNS. `altitudeDeg` is the APPARENT altitude — refracted, where
 * the light actually arrives from — because that is the direction a shadow is
 * cast along; `geometricAltitudeDeg` is the airless one. Refraction assumes a
 * standard atmosphere unless pressure and temperature are given, and near the
 * horizon the real atmosphere varies by several arcminutes from any formula:
 * below about 2° altitude the honest accuracy is ~0.1°, not arcseconds. Above
 * 10° the whole chain is good to a few arcseconds (gated against Meeus's
 * worked example 25.b and against SPA's published test case).
 *
 * Same call shape as sun-altitude.js solarPosition(date, lat, lon), so a
 * caller swaps one import. `jd` here is the true Julian Day (UT).
 *
 * Node gate: tests/sun-precise.mjs.
 */
import { vsop87Earth } from './earth-orbit.js';
import { gmstRad } from './neo-space.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI, ARCSEC = D2R / 3600;
const J2000 = 2451545.0;
const mod360 = (x) => ((x % 360) + 360) % 360;
const mod180 = (x) => mod360(x + 180) - 180;

export const ABERRATION_ARCSEC = 20.4898;
export const SOLAR_PARALLAX_ARCSEC = 8.794;
export const SUN_SEMIDIAMETER_DEG_AT_1AU = 959.63 / 3600;
export const STANDARD_ATMOSPHERE = Object.freeze({ pressureHpa: 1010, temperatureC: 10 });
/** Below this geometric altitude the Sun is fully set and no refraction is applied (SPA's rule). */
export const REFRACTION_FLOOR_DEG = -(0.26667 + 0.5667);

/** ΔT = TT − UT, seconds. Espenak & Meeus (NASA eclipse polynomials), the 2005–2050 branch, held outside it. */
export function deltaTSeconds(jdUt) {
    const y = 2000 + (jdUt - J2000) / 365.25;
    const t = Math.max(5, Math.min(50, y - 2000));
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
}

/** Nutation in longitude and obliquity (radians) and the mean obliquity, at Julian centuries T (TT) from J2000. */
export function nutation(T) {
    const om = (125.04452 - 1934.136261 * T) * D2R;
    const L = (280.4665 + 36000.7698 * T) * D2R, Lm = (218.3165 + 481267.8813 * T) * D2R;
    const dPsi = (-17.20 * Math.sin(om) - 1.32 * Math.sin(2 * L) - 0.23 * Math.sin(2 * Lm) + 0.21 * Math.sin(2 * om)) * ARCSEC;
    const dEps = (9.20 * Math.cos(om) + 0.57 * Math.cos(2 * L) + 0.10 * Math.cos(2 * Lm) - 0.09 * Math.cos(2 * om)) * ARCSEC;
    const eps0 = (23 + 26 / 60 + 21.448 / 3600 - (46.8150 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600) * D2R;
    return { dPsi, dEps, eps0, eps: eps0 + dEps };
}

/** Bennett's refraction, degrees, for a GEOMETRIC altitude; 0 once the Sun is fully below the horizon. */
export function refractionDeg(geometricAltDeg, { pressureHpa = STANDARD_ATMOSPHERE.pressureHpa, temperatureC = STANDARD_ATMOSPHERE.temperatureC } = {}) {
    if (!(geometricAltDeg >= REFRACTION_FLOOR_DEG)) return 0;
    const e = geometricAltDeg;
    return (pressureHpa / 1010) * (283 / (273 + temperatureC)) * 1.02 / (60 * Math.tan((e + 10.3 / (e + 5.11)) * D2R));
}

// The geocentric part depends on the instant alone; a terrain grid asks for it tens of
// thousands of times at one instant with different coordinates. A tiny cache, keyed by
// the inputs, changes no value.
const geoCache = new Map();
/**
 * The geocentric APPARENT Sun at a UT Julian Day: right ascension, declination, distance,
 * apparent sidereal time at Greenwich, and the intermediate quantities (for the gate).
 */
export function sunGeocentric(jdUt, { deltaTSec = null } = {}) {
    const key = `${jdUt}|${deltaTSec}`;
    const hit = geoCache.get(key);
    if (hit) return hit;
    const dT = deltaTSec ?? deltaTSeconds(jdUt);
    const jde = jdUt + dT / 86400, T = (jde - J2000) / 36525;
    const e = vsop87Earth(jde);
    let lam = e.L_rad + Math.PI, beta = -e.B_rad;
    // FK5 (Meeus 25.9)
    const lp = lam - (1.397 * T + 0.00031 * T * T) * D2R;
    lam -= 0.09033 * ARCSEC;
    beta += 0.03916 * ARCSEC * (Math.cos(lp) - Math.sin(lp));
    const nut = nutation(T);
    const lamApp = lam + nut.dPsi - (ABERRATION_ARCSEC / e.R_AU) * ARCSEC;
    const ra = Math.atan2(Math.sin(lamApp) * Math.cos(nut.eps) - Math.tan(beta) * Math.sin(nut.eps), Math.cos(lamApp));
    const dec = Math.asin(Math.sin(beta) * Math.cos(nut.eps) + Math.cos(beta) * Math.sin(nut.eps) * Math.sin(lamApp));
    const gast = gmstRad(jdUt) + nut.dPsi * Math.cos(nut.eps);
    const out = Object.freeze({
        jdUt, jde, deltaTSec: dT, distanceAU: e.R_AU,
        earthLonDeg: mod360(e.L_rad * R2D), earthLatArcsec: e.B_rad / ARCSEC,
        apparentLonDeg: mod360(lamApp * R2D), latArcsec: beta / ARCSEC,
        dPsiArcsec: nut.dPsi / ARCSEC, dEpsArcsec: nut.dEps / ARCSEC, obliquityDeg: nut.eps * R2D,
        raDeg: mod360(ra * R2D), decDeg: dec * R2D, gastDeg: mod360(gast * R2D),
    });
    if (geoCache.size > 256) geoCache.delete(geoCache.keys().next().value);
    geoCache.set(key, out);
    return out;
}

/**
 * The Sun from (lat, lon) at `date`.
 * @param {Date|number} date  a Date or epoch milliseconds (UT)
 * @param {number} lat  geodetic latitude, degrees +N
 * @param {number} lon  longitude, degrees +E
 * @param {object} [o]
 * @param {number} [o.elevationM=0]
 * @param {number} [o.pressureHpa] @param {number} [o.temperatureC]  for refraction (standard atmosphere if absent)
 * @param {boolean} [o.refraction=true]  false ⇒ altitudeDeg is the geometric (airless) altitude
 * @param {number|null} [o.deltaTSec]
 * @returns {{ altitudeDeg, geometricAltitudeDeg, refractionDeg, azimuthDeg, declinationDeg, rightAscensionDeg,
 *             hourAngleDeg, distanceAU, semidiameterDeg, jd }}
 *   azimuth 0° = north, 90° = east; hour angle + = past the meridian (west); RA/Dec/H are topocentric.
 */
export function solarPositionPrecise(date, lat, lon, o = {}) {
    const ms = typeof date === 'number' ? date : date.getTime();
    const jdUt = ms / 86_400_000 + 2440587.5;
    const g = sunGeocentric(jdUt, { deltaTSec: o.deltaTSec ?? null });
    const phi = lat * D2R, H = mod180(g.gastDeg + lon - g.raDeg) * D2R, dec = g.decDeg * D2R;
    // Diurnal parallax on the ellipsoid (Meeus ch. 40).
    const h = (o.elevationM ?? 0) / 6378140;
    const u = Math.atan(0.99664719 * Math.tan(phi));
    const rs = 0.99664719 * Math.sin(u) + h * Math.sin(phi), rc = Math.cos(u) + h * Math.cos(phi);
    const sp = Math.sin((SOLAR_PARALLAX_ARCSEC / g.distanceAU) * ARCSEC);
    const dRa = Math.atan2(-rc * sp * Math.sin(H), Math.cos(dec) - rc * sp * Math.cos(H));
    const decT = Math.atan2((Math.sin(dec) - rs * sp) * Math.cos(dRa), Math.cos(dec) - rc * sp * Math.cos(H));
    const HT = H - dRa;
    const sinAlt = Math.sin(phi) * Math.sin(decT) + Math.cos(phi) * Math.cos(decT) * Math.cos(HT);
    const geo = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * R2D;
    const az = mod360(Math.atan2(Math.sin(HT), Math.cos(HT) * Math.sin(phi) - Math.tan(decT) * Math.cos(phi)) * R2D + 180);
    const refr = o.refraction === false ? 0 : refractionDeg(geo, o);
    return {
        altitudeDeg: geo + refr, geometricAltitudeDeg: geo, refractionDeg: refr, azimuthDeg: az,
        declinationDeg: decT * R2D, rightAscensionDeg: mod360(g.raDeg + dRa * R2D), hourAngleDeg: mod180(HT * R2D),
        distanceAU: g.distanceAU, semidiameterDeg: SUN_SEMIDIAMETER_DEG_AT_1AU / g.distanceAU, jd: jdUt,
    };
}
