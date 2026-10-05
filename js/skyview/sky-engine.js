/**
 * sky-engine.js — PURE kernel for SkyView (skyview.html): what is in YOUR sky
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no ambient time. Every input is explicit (a Julian Day, a
 * site, an object list) so `node tests/skyview-engine.mjs` can pin it against
 * published worked examples. The page, the renderer and the catalog baker all
 * import THIS copy; nothing re-derives a frame.
 *
 * ── ONE EPHEMERIS, NOT A SECOND ONE ──────────────────────────────────────
 * Sidereal time, precession, the Moon (Meeus ch.47), the Sun and Earth
 * (VSOP87D) all come from `js/neo-space.js` / `js/horizons.js` — the same
 * functions neo-watch.html and the orrery draw with — so SkyView's Moon can
 * never disagree with the site's other Moons. This file adds only what those
 * do not have: the local horizon, the atmosphere, magnitudes and visibility.
 *
 * ── FRAMES (each one was a trap) ─────────────────────────────────────────
 * Catalogue positions are equatorial J2000. The local horizon is OF DATE
 * (sidereal time is measured from the equinox of date — 0.36° of precession
 * in 2026, about a Moon diameter, which is exactly the size of error that
 * looks fine on a chart). `skyFrame` folds precession and the observer into
 * ONE 3×3 matrix (J2000 equatorial → local East/North/Up), so 5 000 stars cost
 * one mat-vec each and no star can be converted by a different path.
 *
 * The PLANET SERIES ARE IN TWO DIFFERENT FRAMES and `PLANET_FRAMES` says
 * which: Mercury/Venus/Mars come from J2000 mean elements (their mean-
 * longitude rates are Meeus Table 31.b's, e.g. Mercury 149472.67″, not the
 * of-date 149474.07″), while Earth and Jupiter–Neptune are VSOP87D, which is
 * the ecliptic OF DATE (Earth's L1 constant 628331966747 and Jupiter's
 * 52993480757 are the of-date rates; js/outer-planets.js's header calls them
 * J2000 — the coefficients say otherwise). Subtracting an of-date Earth from
 * a J2000 Mars is a 0.36° error, so every body is rotated to J2000 FIRST.
 *
 * ── WHAT IS MODELLED, AND WHAT IS NOT ────────────────────────────────────
 * Modelled: precession, topocentric parallax (0.95° for the Moon — the
 * difference between "rising" and "not up yet"), refraction (Saemundsson,
 * standard atmosphere), airmass (Kasten & Young 1989), V-band extinction,
 * planetary magnitudes (Mallama & Hilton 2018, the Astronomical Almanac's own
 * expressions), Saturn's ring tilt, lunar phase.
 * NOT modelled, each below what a naked-eye chart can show: nutation (≤17″),
 * annual aberration (≤20.5″), planetary light time (≤0.02° for Mercury, under
 * its own 0.3° series error), stellar proper motion since the Hipparcos epoch
 * (≤2.6′ for Barnard's Star over 35 yr; ~0 for everything else bright).
 *
 * ── VISIBILITY IS A MODEL AND SAYS SO ────────────────────────────────────
 * "Visible" = brighter, after extinction, than the faintest thing the sky
 * lets you see right now. That limit (`limitingMagnitude`) is an EMPIRICAL
 * twilight + moonlight + light-pollution model, not a radiative-transfer
 * calculation, and the page prints it next to the list. The ranking is the
 * MARGIN in magnitudes (limit − observed magnitude): one number, physically
 * meaningful (each magnitude is ×2.512 in flux), and comparable between a
 * planet, a star and a galaxy. Extended objects pay a stated surface-
 * brightness penalty, because M31's integrated 3.4 is spread over 3°.
 */

import { D2R, R2D, J2000, AU_KM } from '../neo-orbits.js';
import {
    gmstRad, ofDateEquatorialToJ2000Matrix, ofDateToJ2000, eclipticToEquatorial,
    OBLIQUITY_J2000_DEG, earthHelioJ2000, moonGeoJ2000, sunGeoDirectionJ2000,
    moonPhase, observerEquatorialOfDate, EARTH_RADIUS_KM, MOON_RADIUS_KM,
} from '../neo-space.js';
import {
    mercuryHeliocentric, venusHeliocentric, marsHeliocentric, jupiterHeliocentric,
    saturnHeliocentric, uranusHeliocentric, neptuneHeliocentric,
} from '../horizons.js';

export { D2R, R2D, J2000 };

// ─────────────────────────────────────────────────────────────────────────────
// 1. Time and vectors
// ─────────────────────────────────────────────────────────────────────────────

export const MS_PER_DAY = 86_400_000;
/** Julian Day (UTC ≈ UT1, see neo-space gmstRad) from epoch milliseconds. */
export function jdFromMs(ms) { return ms / MS_PER_DAY + 2440587.5; }
export function msFromJd(jd) { return (jd - 2440587.5) * MS_PER_DAY; }

/** RA/Dec (degrees) → unit vector, equatorial axes (x → equinox, z → pole). */
export function raDecToVec(raDeg, decDeg) {
    const a = raDeg * D2R, d = decDeg * D2R, cd = Math.cos(d);
    return [cd * Math.cos(a), cd * Math.sin(a), Math.sin(d)];
}
/** Unit (or any) vector → RA [0,360) / Dec (degrees). */
export function vecToRaDec(v) {
    const r = Math.hypot(v[0], v[1], v[2]) || 1;
    let ra = Math.atan2(v[1], v[0]) * R2D;
    if (ra < 0) ra += 360;
    return { raDeg: ra, decDeg: Math.asin(clamp1(v[2] / r)) * R2D };
}
/** Great-circle separation (degrees). Haversine form: exact near 0°. */
export function angularSeparationDeg(ra1, dec1, ra2, dec2) {
    const p1 = dec1 * D2R, p2 = dec2 * D2R;
    const dp = p2 - p1, dl = (ra2 - ra1) * D2R;
    const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(h))) * R2D;
}
const clamp1 = (x) => Math.max(-1, Math.min(1, x));
const wrap360 = (a) => ((a % 360) + 360) % 360;

// ─────────────────────────────────────────────────────────────────────────────
// 2. Galactic coordinates — the bridge to galactic-map.html
// ─────────────────────────────────────────────────────────────────────────────
//
// The galaxy map stores every object as heliocentric (l, b, distance). This is
// the IAU/Hipparcos rotation (ESA 1997 vol.1 §1.5.3) from ICRS equatorial to
// galactic; its TRANSPOSE takes the map's objects into the sky. Pinned by the
// test against the definitions it encodes: the galactic centre at
// (266.405°, −28.936°) and the north galactic pole at (192.859°, +27.128°).

const GAL = [
    -0.0548755604162154, -0.8734370902348850, -0.4838350155487132,
     0.4941094278755837, -0.4448296299600112,  0.7469822444972189,
    -0.8676661490190047, -0.1980763734312015,  0.4559837761750669,
];

export function equatorialToGalactic(raDeg, decDeg) {
    const v = raDecToVec(raDeg, decDeg);
    const g = [
        GAL[0] * v[0] + GAL[1] * v[1] + GAL[2] * v[2],
        GAL[3] * v[0] + GAL[4] * v[1] + GAL[5] * v[2],
        GAL[6] * v[0] + GAL[7] * v[1] + GAL[8] * v[2],
    ];
    let l = Math.atan2(g[1], g[0]) * R2D;
    if (l < 0) l += 360;
    return { lDeg: l, bDeg: Math.asin(clamp1(g[2])) * R2D };
}

export function galacticToEquatorial(lDeg, bDeg) {
    const l = lDeg * D2R, b = bDeg * D2R, cb = Math.cos(b);
    const g = [cb * Math.cos(l), cb * Math.sin(l), Math.sin(b)];
    // Transpose: equatorial = GALᵀ · galactic.
    return vecToRaDec([
        GAL[0] * g[0] + GAL[3] * g[1] + GAL[6] * g[2],
        GAL[1] * g[0] + GAL[4] * g[1] + GAL[7] * g[2],
        GAL[2] * g[0] + GAL[5] * g[1] + GAL[8] * g[2],
    ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The observer's frame
// ─────────────────────────────────────────────────────────────────────────────

const mul3 = (A, B) => {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
        C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
    return C;
};
const transpose3 = (A) => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]];
const apply3 = (m, x, y, z) => [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z,
];

/**
 * The observer's frame at an instant: ONE row-major 3×3 `m` taking a J2000
 * equatorial unit vector to local (East, North, Up), its inverse `mInv`, and
 * the observer's own position (J2000 equatorial, km) for parallax.
 *
 * Built as  L(φ, LST) · P⁻¹,  P = ofDateEquatorialToJ2000Matrix(jd) from
 * neo-space (orthonormal, so P⁻¹ = Pᵀ). Rows of L, with θ = LST:
 *   E = (−sinθ,        cosθ,        0   )
 *   N = (−sinφ cosθ,  −sinφ sinθ,   cosφ)
 *   U = ( cosφ cosθ,   cosφ sinθ,   sinφ)
 * so the celestial pole lands at altitude φ due north — the first thing the
 * test checks, because a sign slip here mirrors the sky east-for-west and
 * still looks like a sky.
 */
export function skyFrame(jd, latDeg, lonDeg, { altKm = 0 } = {}) {
    const gmst = gmstRad(jd);
    const theta = gmst + lonDeg * D2R;
    const phi = latDeg * D2R;
    const st = Math.sin(theta), ct = Math.cos(theta);
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const L = [
        -st,        ct,       0,
        -sp * ct,  -sp * st,  cp,
         cp * ct,   cp * st,  sp,
    ];
    const P = ofDateEquatorialToJ2000Matrix(jd);
    const m = mul3(L, transpose3(P));
    const obsDate = observerEquatorialOfDate(latDeg, lonDeg, gmst, altKm); // Earth radii, of date
    const obsJ = apply3(P, obsDate.x, obsDate.y, obsDate.z).map((c) => c * EARTH_RADIUS_KM);
    return Object.freeze({
        jd, latDeg, lonDeg, altKm,
        lstDeg: wrap360(theta * R2D),
        m, mInv: transpose3(m),
        observerJ2000Km: obsJ,
    });
}

/** J2000 equatorial unit vector → [E, N, U] in the frame. */
export function toEnu(frame, v) { return apply3(frame.m, v[0], v[1], v[2]); }
/** [E, N, U] → J2000 equatorial unit vector. */
export function fromEnu(frame, enu) { return apply3(frame.mInv, enu[0], enu[1], enu[2]); }

/** ENU → geometric altitude / azimuth (degrees, azimuth from north through east). */
export function enuToAltAz(e, n, u) {
    const r = Math.hypot(e, n, u) || 1;
    let az = Math.atan2(e, n) * R2D;
    if (az < 0) az += 360;
    return { altDeg: Math.asin(clamp1(u / r)) * R2D, azDeg: az };
}
export function altAzToEnu(altDeg, azDeg) {
    const a = altDeg * D2R, z = azDeg * D2R, ca = Math.cos(a);
    return [ca * Math.sin(z), ca * Math.cos(z), Math.sin(a)];
}

/** Geometric (unrefracted) alt/az of a fixed J2000 position. */
export function horizontalOf(frame, raDeg, decDeg) {
    const [e, n, u] = toEnu(frame, raDecToVec(raDeg, decDeg));
    return enuToAltAz(e, n, u);
}

/**
 * Geocentric J2000 equatorial position (km) → TOPOCENTRIC RA/Dec. The
 * observer sits up to one Earth radius off the line to Earth's centre; for the
 * Moon that is ~1°, for Venus at inferior conjunction ~30″, for a star zero.
 */
export function topocentricRaDec(frame, geoKm) {
    const o = frame.observerJ2000Km;
    const v = [geoKm[0] - o[0], geoKm[1] - o[1], geoKm[2] - o[2]];
    const r = Math.hypot(v[0], v[1], v[2]);
    return { ...vecToRaDec(v), rangeKm: r };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The atmosphere
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refraction (degrees) for a TRUE altitude — Saemundsson (Meeus eq. 16.4), with
 * the standard pressure/temperature scaling. 34′ at the horizon, 1′ at 45°.
 * Below −2° nothing on this chart can be refracted into view, and the formula
 * diverges near −5°, so it returns 0 there rather than a number.
 */
export function refractionDeg(trueAltDeg, { pressureHpa = 1010, tempC = 10 } = {}) {
    if (!(trueAltDeg > -2)) return 0;
    const h = Math.min(90, trueAltDeg);
    const Rarcmin = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * D2R);
    const scale = (pressureHpa / 1010) * (283 / (273 + tempC));
    return Math.max(0, Rarcmin * scale) / 60;
}

/**
 * Relative airmass at an APPARENT altitude — Kasten & Young (1989). 1.0 at the
 * zenith, 2.0 at 30°, ~38 at the horizon. Held at the horizon value below 0
 * (nothing below the horizon is ranked as visible, so the value only needs to
 * be finite and large).
 */
export function airmass(appAltDeg) {
    const h = Math.max(0, appAltDeg);
    return 1 / (Math.sin(h * D2R) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
}

/** V-band extinction coefficient (mag per airmass) for a typical clear site. */
export const DEFAULT_EXTINCTION_K = 0.25;

/**
 * Magnitudes lost to the atmosphere RELATIVE TO THE ZENITH. The limiting
 * magnitude below is a zenith figure, so only the excess airmass is charged —
 * otherwise the zenith extinction would be paid twice.
 */
export function extinctionMag(appAltDeg, k = DEFAULT_EXTINCTION_K) {
    return k * (airmass(appAltDeg) - 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. How dark the sky is — the limiting magnitude
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Naked-eye zenith limiting magnitude on a moonless, astronomically dark night,
 * by sky type (roughly Bortle 2 / 4 / 5–6 / 7 / 8–9). The page defaults to
 * suburban because that is where most visitors stand, and lets them change it.
 */
export const SKY_QUALITY = Object.freeze({
    dark:     { id: 'dark',     label: 'Dark site',  limit: 6.5 },
    rural:    { id: 'rural',    label: 'Rural',      limit: 6.0 },
    suburban: { id: 'suburban', label: 'Suburban',   limit: 5.0 },
    urban:    { id: 'urban',    label: 'Urban',      limit: 4.0 },
    city:     { id: 'city',     label: 'City centre', limit: 3.0 },
});
export const DEFAULT_SKY_QUALITY = 'suburban';

/**
 * Twilight ceiling on the limit, by the Sun's (geometric) altitude. An
 * empirical table, not a twilight radiative-transfer model: Venus (−4) is a
 * daytime object for an observer who knows where to look; the first-magnitude
 * stars appear by the end of civil twilight (−6°); fifth-magnitude stars by the
 * end of nautical (−12°); full darkness at −18° hands control to the site.
 */
export const TWILIGHT_LIMIT_TABLE = Object.freeze([
    // [sunAltDeg, limit]  — sorted by DECREASING Sun altitude
    [ 90, -4.0],
    [  0, -4.0],
    [ -2, -1.5],
    [ -4,  0.5],
    [ -6,  2.0],
    [ -9,  3.5],
    [-12,  4.6],
    [-15,  5.6],
    [-18,  7.0],
]);

export function twilightLimit(sunAltDeg) {
    const T = TWILIGHT_LIMIT_TABLE;
    if (!(sunAltDeg < T[0][0])) return T[0][1];
    for (let i = 1; i < T.length; i++) {
        const [h1, m1] = T[i - 1], [h2, m2] = T[i];
        if (sunAltDeg >= h2) return m1 + (m2 - m1) * (sunAltDeg - h1) / (h2 - h1);
    }
    return T[T.length - 1][1];
}

/**
 * Moonlight penalty (magnitudes) on the night limit. Scales with the lit
 * fraction (steeper than linear — the opposition surge makes a full Moon ~10×
 * a quarter Moon) and with the Moon's height. A full Moon high up costs a dark
 * site ~2 mag; it cannot cost a city sky much, because that sky is already
 * bright, so the penalty is capped at the site's headroom above mag 3.
 */
export function moonPenalty({ moonAltDeg, illuminated, siteLimit }) {
    if (!(moonAltDeg > 0) || !(illuminated > 0)) return 0;
    const raw = 2.0 * Math.pow(illuminated, 1.5) * Math.sqrt(Math.sin(moonAltDeg * D2R));
    return Math.min(raw, Math.max(0, siteLimit - 3.0));
}

/**
 * The zenith naked-eye limiting magnitude right now: the twilight ceiling or
 * the (moonlit) site limit, whichever is brighter. Returns the parts so the
 * page can say WHICH is in charge.
 */
export function limitingMagnitude({ sunAltDeg, moonAltDeg = -90, moonIllum = 0, skyQuality = DEFAULT_SKY_QUALITY }) {
    const site = (SKY_QUALITY[skyQuality] ?? SKY_QUALITY[DEFAULT_SKY_QUALITY]).limit;
    const tw = twilightLimit(sunAltDeg);
    const moon = moonPenalty({ moonAltDeg, illuminated: moonIllum, siteLimit: site });
    const night = site - moon;
    const limit = Math.min(tw, night);
    let regime;
    if (sunAltDeg > -0.833) regime = 'day';
    else if (tw < night) regime = sunAltDeg > -6 ? 'civil twilight' : sunAltDeg > -12 ? 'nautical twilight' : 'astronomical twilight';
    else regime = moon > 0.25 ? 'moonlit night' : 'dark night';
    return { limit, twilight: tw, site, moonPenalty: moon, regime };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The solar system, seen from the site
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which ecliptic frame each heliocentric series returns (see header). This
 * table is the ONE place that knowledge lives; `heliocentricJ2000` reads it.
 */
export const PLANET_FRAMES = Object.freeze({
    mercury: { fn: mercuryHeliocentric, frame: 'j2000' },
    venus:   { fn: venusHeliocentric,   frame: 'j2000' },
    mars:    { fn: marsHeliocentric,    frame: 'j2000' },
    jupiter: { fn: jupiterHeliocentric, frame: 'date' },
    saturn:  { fn: saturnHeliocentric,  frame: 'date' },
    uranus:  { fn: uranusHeliocentric,  frame: 'date' },
    neptune: { fn: neptuneHeliocentric, frame: 'date' },
});

export const PLANETS = Object.freeze([
    { id: 'mercury', name: 'Mercury', radiusKm: 2439.7, color: '#b9b2a8' },
    { id: 'venus',   name: 'Venus',   radiusKm: 6051.8, color: '#f3e7c4' },
    { id: 'mars',    name: 'Mars',    radiusKm: 3389.5, color: '#e0784a' },
    { id: 'jupiter', name: 'Jupiter', radiusKm: 69911,  color: '#e8d2b0' },
    { id: 'saturn',  name: 'Saturn',  radiusKm: 58232,  color: '#ead9a6' },
    { id: 'uranus',  name: 'Uranus',  radiusKm: 25362,  color: '#a9e1e6' },
    { id: 'neptune', name: 'Neptune', radiusKm: 24622,  color: '#7d9cf0' },
]);

/** Heliocentric ecliptic J2000 position (AU) of a planet. */
export function heliocentricJ2000(id, jd) {
    const spec = PLANET_FRAMES[id];
    if (!spec) throw new Error(`heliocentricJ2000: unknown planet "${id}"`);
    const p = spec.fn(jd);
    if (spec.frame === 'j2000') return { x: p.x_AU, y: p.y_AU, z: p.z_AU };
    return ofDateToJ2000(p.x_AU, p.y_AU, p.z_AU, jd);
}

/**
 * Apparent V magnitude — Mallama & Hilton (2018), the expressions the
 * Astronomical Almanac uses. r = heliocentric, d = geocentric distance (AU),
 * α = phase angle (deg). Outside each fit's phase range the polynomial is HELD
 * at its edge (the outer planets can never leave theirs from Earth; Mercury and
 * Venus near inferior conjunction can, and are invisible in the glare then).
 */
export function planetMagnitude(id, rAU, dAU, alphaDeg, { ringTiltDeg = 0 } = {}) {
    const dist = 5 * Math.log10(rAU * dAU);
    const a = alphaDeg;
    switch (id) {
        case 'mercury': {
            const x = Math.min(a, 170);
            return -0.613 + dist + 6.3280e-02 * x - 1.6336e-03 * x ** 2 + 3.3644e-05 * x ** 3
                - 3.4265e-07 * x ** 4 + 1.6893e-09 * x ** 5 - 3.0334e-12 * x ** 6;
        }
        case 'venus':
            if (a <= 163.7) {
                return -4.384 + dist - 1.044e-03 * a + 3.687e-04 * a ** 2 - 2.814e-06 * a ** 3 + 8.938e-09 * a ** 4;
            }
            return 236.05828 + dist - 2.81914 * Math.min(a, 179) + 8.39034e-03 * Math.min(a, 179) ** 2;
        case 'mars': {
            const x = Math.min(a, 50);
            return -1.601 + dist + 2.267e-02 * x - 1.302e-04 * x ** 2;
        }
        case 'jupiter': {
            const x = Math.min(a, 12);
            return -9.395 + dist - 3.7e-04 * x + 6.16e-04 * x ** 2;
        }
        case 'saturn': {
            // Globe + rings. β is the ring-plane tilt toward Earth (|B|).
            const sb = Math.sin(Math.min(Math.abs(ringTiltDeg), 27) * D2R);
            const x = Math.min(a, 6.5);
            return -8.914 + dist - 1.825 * sb + 2.6e-02 * x - 0.378 * sb * Math.exp(-2.25 * x);
        }
        case 'uranus': {
            const x = Math.min(a, 3.1);
            return -7.110 + dist + 6.587e-03 * x + 1.045e-04 * x ** 2;
        }
        case 'neptune':
            return -7.00 + dist;
        default:
            return NaN;
    }
}

/** The Moon's V magnitude — Allen's phase law, scaled for distance. */
export function moonMagnitude(alphaDeg, distKm, sunDistAU = 1) {
    const a = Math.abs(alphaDeg);
    return -12.73 + 0.026 * a + 4e-9 * a ** 4 + 5 * Math.log10((distKm / 384_400) * sunDistAU);
}

/** IAU north pole of Saturn (J2000) — for the ring tilt. */
const SATURN_POLE = raDecToVec(40.589, 83.537);

const eclJ2000ToEq = (x, y, z) => eclipticToEquatorial(x, y, z, OBLIQUITY_J2000_DEG);

/**
 * Sun, Moon and the seven planets as TOPOCENTRIC sky objects for a frame.
 * Each carries the same fields the catalogue objects do (raDeg/decDeg J2000,
 * mag, kind) plus the physical extras the card prints.
 */
export function solarSystemObjects(frame) {
    const jd = frame.jd;
    const out = [];
    const earth = earthHelioJ2000(jd);
    const sunDir = sunGeoDirectionJ2000(jd);

    // Sun
    {
        const ecl = { x: sunDir.x * sunDir.distAU * AU_KM, y: sunDir.y * sunDir.distAU * AU_KM, z: sunDir.z * sunDir.distAU * AU_KM };
        const eq = eclJ2000ToEq(ecl.x, ecl.y, ecl.z);
        const t = topocentricRaDec(frame, [eq.x, eq.y, eq.z]);
        out.push({
            id: 'sun', name: 'Sun', kind: 'sun', raDeg: t.raDeg, decDeg: t.decDeg,
            mag: -26.74 + 5 * Math.log10(sunDir.distAU), distAU: sunDir.distAU,
            angDiamArcsec: 2 * Math.atan(695_700 / (sunDir.distAU * AU_KM)) * R2D * 3600,
            color: '#fff4d6',
        });
    }

    // Moon (phase from neo-space so it matches every other Moon on the site)
    {
        const m = moonGeoJ2000(jd);
        const ph = moonPhase(jd);
        const eq = eclJ2000ToEq(m.x * AU_KM, m.y * AU_KM, m.z * AU_KM);
        const t = topocentricRaDec(frame, [eq.x, eq.y, eq.z]);
        out.push({
            id: 'moon', name: 'Moon', kind: 'moon', raDeg: t.raDeg, decDeg: t.decDeg,
            mag: moonMagnitude(ph.phaseAngleDeg, t.rangeKm, sunDir.distAU),
            distKm: t.rangeKm, phaseAngleDeg: ph.phaseAngleDeg, illuminated: ph.illuminated,
            phaseName: ph.name, waxing: ph.waxing, ageDays: ph.ageDays,
            angDiamArcsec: 2 * Math.atan(MOON_RADIUS_KM / t.rangeKm) * R2D * 3600,
            color: '#e9e6dc',
        });
    }

    // Planets
    for (const p of PLANETS) {
        const h = heliocentricJ2000(p.id, jd);
        const g = { x: h.x - earth.x, y: h.y - earth.y, z: h.z - earth.z };
        const rAU = Math.hypot(h.x, h.y, h.z);
        const dAU = Math.hypot(g.x, g.y, g.z);
        // Phase angle at the PLANET between the Sun and Earth.
        const cosA = (h.x * g.x + h.y * g.y + h.z * g.z) / (rAU * dAU);
        const alpha = Math.acos(clamp1(cosA)) * R2D;
        const eq = eclJ2000ToEq(g.x * AU_KM, g.y * AU_KM, g.z * AU_KM);
        const t = topocentricRaDec(frame, [eq.x, eq.y, eq.z]);
        let ringTiltDeg = 0;
        if (p.id === 'saturn') {
            const u = raDecToVec(t.raDeg, t.decDeg);
            ringTiltDeg = Math.asin(clamp1(-(u[0] * SATURN_POLE[0] + u[1] * SATURN_POLE[1] + u[2] * SATURN_POLE[2]))) * R2D;
        }
        // Elongation from the Sun as seen from Earth.
        const gu = [g.x / dAU, g.y / dAU, g.z / dAU];
        const elong = Math.acos(clamp1(gu[0] * sunDir.x + gu[1] * sunDir.y + gu[2] * sunDir.z)) * R2D;
        out.push({
            id: p.id, name: p.name, kind: 'planet', raDeg: t.raDeg, decDeg: t.decDeg,
            mag: planetMagnitude(p.id, rAU, dAU, alpha, { ringTiltDeg }),
            distAU: dAU, helioAU: rAU, phaseAngleDeg: alpha,
            illuminated: (1 + Math.cos(alpha * D2R)) / 2, elongationDeg: elong,
            ringTiltDeg: p.id === 'saturn' ? ringTiltDeg : undefined,
            angDiamArcsec: 2 * Math.atan(p.radiusKm / (dAU * AU_KM)) * R2D * 3600,
            color: p.color,
        });
    }
    return out;
}

/** The Sun's geometric altitude (degrees) — the twilight clock. */
export function sunAltitudeDeg(jd, latDeg, lonDeg) {
    const f = skyFrame(jd, latDeg, lonDeg);
    const s = sunGeoDirectionJ2000(jd);
    const eq = eclJ2000ToEq(s.x, s.y, s.z);
    const [, , u] = toEnu(f, [eq.x, eq.y, eq.z]);
    return Math.asin(clamp1(u)) * R2D;
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Visibility — one margin, in magnitudes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Surface-brightness penalty (mag) for an extended object of size `dimArcmin`.
 * A crude, DISCLOSED proxy: integrated light spread over a large area is
 * harder to see than the same light in a point. Clusters are seen through
 * their brightest stars and pay half. Everything under 10′ pays nothing.
 */
export function extendedPenalty(kind, dimArcmin) {
    if (!(dimArcmin > 10)) return 0;
    const per = (kind === 'open-cluster' || kind === 'asterism') ? 0.5 : 1.0;
    return per * Math.log10(dimArcmin / 10);
}

/**
 * Solar-glare penalty (mag) for an object close to the Sun while the Sun is up
 * or the sky is still bright. Mercury at 12° from a Sun 4° below the horizon
 * is in a much brighter patch of sky than the zenith limit describes.
 */
export function glarePenalty(elongationDeg, sunAltDeg) {
    if (!(elongationDeg < 25) || sunAltDeg < -12) return 0;
    const strength = sunAltDeg > 0 ? 1 : (sunAltDeg + 12) / 12;
    return strength * (25 - elongationDeg) / 4;
}

export const VISIBILITY_STATUS = Object.freeze({
    sun:          { id: 'sun',          label: 'Up — never look directly' },
    easy:         { id: 'easy',         label: 'Easy naked eye' },
    visible:      { id: 'visible',      label: 'Naked eye' },
    binoculars:   { id: 'binoculars',   label: 'Binoculars' },
    telescope:    { id: 'telescope',    label: 'Telescope' },
    below:        { id: 'below',        label: 'Below horizon' },
    nomag:        { id: 'nomag',        label: 'Not visible to the eye' },
});

/** Binoculars (7×50-ish) gain about this many magnitudes over the eye. */
export const BINOCULAR_GAIN = 3.0;

/**
 * Assess one object. `o` needs mag and altDeg — the APPARENT (refracted)
 * altitude, the one sky-catalog's `evaluateSky` writes; optional kind,
 * dimArcmin, elongationDeg (from the Sun). `env` carries limit, sunAltDeg, k.
 */
export function assessVisibility(o, env) {
    if (!(o.altDeg > 0)) {
        return { status: 'below', margin: -Infinity, mObs: NaN };
    }
    if (!Number.isFinite(o.mag)) {
        return { status: 'nomag', margin: -Infinity, mObs: NaN };
    }
    const ext = extinctionMag(o.altDeg, env.k ?? DEFAULT_EXTINCTION_K);
    const pen = extendedPenalty(o.kind, o.dimArcmin)
        + (o.kind === 'sun' ? 0 : glarePenalty(o.elongationDeg ?? 180, env.sunAltDeg));
    const mObs = o.mag + ext;
    const margin = env.limit - mObs - pen;
    let status;
    if (o.kind === 'sun') status = 'sun';
    else if (margin >= 1.5) status = 'easy';
    else if (margin >= 0) status = 'visible';
    else if (margin >= -BINOCULAR_GAIN) status = 'binoculars';
    else status = 'telescope';
    return { status, margin, mObs, extinction: ext, penalty: pen };
}

/**
 * Rank objects by visibility margin (largest first). Objects below the horizon
 * or without a magnitude never rank. Returns NEW objects carrying `rank`.
 */
export function rankByVisibility(objects, n = Infinity) {
    const ranked = objects
        .filter((o) => Number.isFinite(o.vis?.margin))
        .sort((a, b) => b.vis.margin - a.vis.margin || a.mag - b.mag);
    const top = ranked.slice(0, n);
    return top.map((o, i) => ({ ...o, rank: i + 1 }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Rise / transit / set, and "when is it dark"
// ─────────────────────────────────────────────────────────────────────────────

/** Standard altitude of the upper limb at rise/set, with mean refraction. */
export const RISE_ALT = Object.freeze({ star: -0.5667, sun: -0.8333, moon: 0.125 });

/**
 * Find the events of a CONTINUOUS altitude function over [jd0, jd0+spanDays]:
 * every upward and downward crossing of `h0`, plus the culmination (maximum).
 * Sampled at `stepMin` and refined by bisection to ~1 s. Generic on purpose —
 * a star, the Sun and the Moon all go through it, so a moving body cannot get
 * a different rule from a fixed one.
 */
export function horizonEvents(altFn, jd0, { spanDays = 1, h0 = RISE_ALT.star, stepMin = 10 } = {}) {
    const step = stepMin / 1440;
    const n = Math.ceil(spanDays / step);
    let prevJd = jd0, prevAlt = altFn(jd0);
    let rise = null, set = null, transit = null;
    let best = { jd: jd0, alt: prevAlt };
    const refine = (a, b, fa) => {
        for (let i = 0; i < 40; i++) {
            const m = (a + b) / 2, fm = altFn(m) - h0;
            if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m;
            if (b - a < 1e-5) break;
        }
        return (a + b) / 2;
    };
    for (let i = 1; i <= n; i++) {
        const jd = jd0 + i * step;
        const alt = altFn(jd);
        if (alt > best.alt) best = { jd, alt };
        const a0 = prevAlt - h0, a1 = alt - h0;
        if (a0 <= 0 && a1 > 0 && rise == null) rise = refine(prevJd, jd, a0);
        if (a0 > 0 && a1 <= 0 && set == null) set = refine(prevJd, jd, a0);
        prevJd = jd; prevAlt = alt;
    }
    // Golden-section polish of the culmination (unimodal near the max).
    if (best.jd > jd0 && best.jd < jd0 + spanDays) {
        let a = best.jd - step, b = best.jd + step;
        const g = 0.381966;
        for (let i = 0; i < 30; i++) {
            const c = a + g * (b - a), d = b - g * (b - a);
            if (altFn(c) > altFn(d)) b = d; else a = c;
        }
        const t = (a + b) / 2;
        transit = { jd: t, altDeg: altFn(t) };
    } else {
        transit = { jd: best.jd, altDeg: best.alt };
    }
    const all = [];
    for (let i = 0; i <= n; i += 6) all.push(altFn(jd0 + i * step));
    const circumpolar = rise == null && set == null && Math.min(...all) > h0;
    const neverRises = rise == null && set == null && Math.max(...all) < h0;
    return { rise, set, transit, circumpolar, neverRises };
}

/**
 * The next interval of darkness (Sun below `sunLimitDeg`) starting at or after
 * jd0, searched over `spanDays`. Returns null if the Sun never gets that low
 * (summer at high latitude) — the caller then tries a shallower twilight.
 */
export function nextDarkness(jd0, latDeg, lonDeg, { sunLimitDeg = -18, spanDays = 1.5, stepMin = 10 } = {}) {
    const f = (jd) => sunAltitudeDeg(jd, latDeg, lonDeg);
    const now = f(jd0);
    if (now < sunLimitDeg) {
        const ev = horizonEvents(f, jd0, { spanDays, h0: sunLimitDeg, stepMin });
        return { start: jd0, end: ev.rise, alreadyDark: true };
    }
    const ev = horizonEvents(f, jd0, { spanDays, h0: sunLimitDeg, stepMin });
    if (ev.set == null) return null;
    const after = horizonEvents(f, ev.set + 1e-4, { spanDays, h0: sunLimitDeg, stepMin });
    return { start: ev.set, end: after.rise, alreadyDark: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Formatting helpers shared by the page
// ─────────────────────────────────────────────────────────────────────────────

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export function compassPoint(azDeg) {
    if (!Number.isFinite(azDeg)) return '—';
    return COMPASS[Math.round(wrap360(azDeg) / 22.5) % 16];
}
export function formatRa(raDeg) {
    const h = wrap360(raDeg) / 15;
    const hh = Math.floor(h), mm = (h - hh) * 60;
    return `${hh}h ${mm.toFixed(1).padStart(4, '0')}m`;
}
export function formatDec(decDeg) {
    const s = decDeg < 0 ? '−' : '+';
    const a = Math.abs(decDeg), d = Math.floor(a), m = Math.round((a - d) * 60);
    return m === 60 ? `${s}${d + 1}° 00′` : `${s}${d}° ${String(m).padStart(2, '0')}′`;
}
export function formatMag(m) {
    if (!Number.isFinite(m)) return '—';
    return (m < 0 ? '−' : '+') + Math.abs(m).toFixed(1);
}
