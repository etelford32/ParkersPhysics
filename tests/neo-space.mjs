/**
 * Gate for js/neo-space.js — the pure geocentric kernel behind neo-watch.html.
 *
 * Every assertion is an IDENTITY, a DEFINING value, or a cross-check between
 * two independently written code paths. Nothing here is a number remembered
 * from a previous run.
 *
 *   - The radial map hits its two anchors EXACTLY, round-trips through its
 *     own inverse, and is strictly monotonic — a ruler that is not monotonic
 *     draws an object moving inward as it recedes (the orrery's scar).
 *   - equatorialToScene has determinant +1. A reflection here mirrors the
 *     whole sky and looks completely plausible doing it.
 *   - GMST at J2000.0 is the DEFINING value 67310.54841 s, and one solar day
 *     advances it by exactly one sidereal day.
 *   - The sub-solar point is the Sun's own zenith: standing there,
 *     topocentricAltAz must return 90°. That single assertion exercises the
 *     precession rotation, the obliquity of date, GMST and the SEZ rotation
 *     at once — any one of them wrong and it fails.
 *   - Geocentric DISTANCE is frame-independent, so this kernel's J2000
 *     geometry must agree with neo-orbits.js's of-date `deriveFrames` to
 *     floating point. That is the gate against the two kernels drifting.
 *   - The H,G phase function is 1 at zero phase (so V reduces to the textbook
 *     H + 5log₁₀(rΔ)), monotonic in phase, and REFUSED past its 120° fit
 *     limit rather than extrapolated.
 *   - findApproach recovers the analytic minimum of straight-line relative
 *     motion, and returns null when the minimum is on the window edge.
 */
import assert from 'node:assert/strict';
import {
    AU_KM, LD_KM, LD_AU, J2000,
    EARTH_RADIUS_KM, GEO_RADIUS_KM, OBLIQUITY_J2000_DEG, MOON_SCENE, GEO_MAP,
    SHELLS, HORIZONS, DEFAULT_HORIZON,
    geoSceneRadius, geoSceneToKm, trueSceneRadius, compressionAt,
    ofDateToJ2000, j2000ToOfDate, obliquityDeg,
    eclipticToEquatorial, equatorialToEcliptic, equatorialToScene, sceneToEquatorial,
    geoToScene, raDecFromEclipticJ2000, formatRaDec,
    gmstRad, observerEquatorialOfDate, topocentricAltAz, compass16,
    earthHelioJ2000, moonGeoJ2000, sunGeoDirectionJ2000, subSolarPoint,
    deriveGeocentric,
    DEFAULT_G, PHASE_FIT_MAX_DEG, phaseAngleDeg, apparentMagnitude,
    angularDiameterArcsec, angularRateDegPerHour,
    refineMinimum, findApproach, compareApproach,
    applyMatrix3, ofDateEquatorialToJ2000Matrix, earthSceneMatrix, buildObjectRow,
    DENSITY, impactEnergy, energyComparison,
    formatGeoDistance, formatRelativeTime, visibilityBand,
} from '../js/neo-space.js';
import {
    D2R, R2D, precessionLongitudeRad, toOfDate, diameterKmFromH,
    normalizeElements, propagate, prepareColumns, propagateColumns, deriveFrames,
} from '../js/neo-orbits.js';
import { earthHeliocentric, moonGeocentric } from '../js/horizons.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);
const TWO_PI = Math.PI * 2;
const jdOf = (isoish) => Date.parse(isoish) / 86400000 + 2440587.5;
/** Compare two angles in degrees the way a compass does — 359.9° is near 0°. */
const nearAngle = (a, b, tol, msg) => {
    const d = Math.abs(((a - b + 540) % 360) - 180);
    assert.ok(d <= tol, `${msg}: ${a}° vs ${b}° (tol ${tol}°)`);
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. The radial map
// ─────────────────────────────────────────────────────────────────────────────

// Both anchors are exact, and the gain is DERIVED from them — if someone
// types a gain in, one of these two fails.
assert.equal(geoSceneRadius(EARTH_RADIUS_KM), 1, 'Earth surface anchors at 1 scene unit');
near(geoSceneRadius(LD_KM), MOON_SCENE, 1e-12, 'Moon anchors at MOON_SCENE');
near(GEO_MAP.gain, (MOON_SCENE - 1) / Math.log(LD_KM / EARTH_RADIUS_KM), 0, 'gain is derived, not typed');

// Inverse round-trip across the whole drawn range.
for (const km of [EARTH_RADIUS_KM, 7000, GEO_RADIUS_KM, LD_KM, 5 * LD_KM, 20 * LD_KM, 0.05 * AU_KM, 0.5 * AU_KM]) {
    near(geoSceneToKm(geoSceneRadius(km)), km, km * 1e-12, `scene round-trip at ${km} km`);
}
// Inside the globe the map clamps rather than running to −∞.
assert.equal(geoSceneRadius(0), 1, 'zero distance clamps to the drawn globe');
assert.equal(geoSceneRadius(EARTH_RADIUS_KM / 2), 1, 'inside the surface clamps');
assert.equal(geoSceneToKm(0.5), EARTH_RADIUS_KM, 'inverse clamps too');

// Strictly monotonic — the property that makes it a ruler at all.
let prev = -Infinity;
for (let k = 0; k <= 400; k++) {
    const km = EARTH_RADIUS_KM * Math.pow(0.5 * AU_KM / EARTH_RADIUS_KM, k / 400);
    const s = geoSceneRadius(km);
    assert.ok(s > prev, `scene radius must increase with distance (at ${km} km)`);
    prev = s;
}

// True scale is the same quantity, honestly: Earth is 1 there too, and the
// compression is > 1 near the globe (magnified) and < 1 far out.
assert.equal(trueSceneRadius(EARTH_RADIUS_KM), 1, 'true scale draws Earth at 1 too');
assert.ok(compressionAt(GEO_RADIUS_KM) < 1, 'GEO is drawn slightly inside true scale');
assert.ok(compressionAt(0.2 * AU_KM) < 0.01, 'a tenth of an AU is compressed by >100x');
// ...and the pleasant accident the header claims: nearly true at the belt.
near(geoSceneRadius(GEO_RADIUS_KM) / trueSceneRadius(GEO_RADIUS_KM), 1, 0.15,
    'the map stays within 15% of truth out to the geostationary belt');

// The ruler's shells are sorted and inside the drawn range; the horizons too.
for (let i = 1; i < SHELLS.length; i++) assert.ok(SHELLS[i].km > SHELLS[i - 1].km, 'shells ascend');
for (let i = 1; i < HORIZONS.length; i++) assert.ok(HORIZONS[i].km > HORIZONS[i - 1].km, 'horizons ascend');
assert.ok(HORIZONS.some(h => h.id === DEFAULT_HORIZON), 'the default horizon is one of the offered ones');
assert.ok(SHELLS.every(s => s.km <= GEO_MAP.maxKm), 'no shell is drawn beyond the map');

// ─────────────────────────────────────────────────────────────────────────────
// 2. Frames
// ─────────────────────────────────────────────────────────────────────────────

// Ecliptic ↔ equatorial round-trip, and the two definitional directions.
for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.3, -0.7, 0.2]]) {
    const eq = eclipticToEquatorial(v[0], v[1], v[2]);
    const back = equatorialToEcliptic(eq.x, eq.y, eq.z);
    near(back.x, v[0], 1e-15, 'ecliptic round-trip x');
    near(back.y, v[1], 1e-15, 'ecliptic round-trip y');
    near(back.z, v[2], 1e-15, 'ecliptic round-trip z');
    near(Math.hypot(eq.x, eq.y, eq.z), Math.hypot(...v), 1e-15, 'obliquity rotation preserves length');
}
{
    // The vernal equinox is the shared x-axis of both frames.
    const eq = raDecFromEclipticJ2000(1, 0, 0);
    near(eq.raDeg, 0, 1e-12, 'ecliptic +x is RA 0');
    near(eq.decDeg, 0, 1e-12, 'ecliptic +x is Dec 0');
    // The ecliptic pole sits ε from the celestial pole.
    const pole = raDecFromEclipticJ2000(0, 0, 1);
    near(pole.decDeg, 90 - OBLIQUITY_J2000_DEG, 1e-9, 'ecliptic pole is ε from the celestial pole');
    // Ecliptic +y is the solstitial colure: RA 90°, Dec +ε.
    const sol = raDecFromEclipticJ2000(0, 1, 0);
    near(sol.raDeg, 90, 1e-9, 'ecliptic +y is RA 90');
    near(sol.decDeg, OBLIQUITY_J2000_DEG, 1e-9, 'ecliptic +y is Dec +ε');
}

// THE HANDEDNESS GATE. equatorialToScene must be a rotation (det +1); the
// (x, z, y) swap the heliocentric orrery uses is a reflection and would
// mirror every right ascension while looking entirely normal.
{
    const ex = equatorialToScene(1, 0, 0), ey = equatorialToScene(0, 1, 0), ez = equatorialToScene(0, 0, 1);
    const det =
          ex.x * (ey.y * ez.z - ey.z * ez.y)
        - ex.y * (ey.x * ez.z - ey.z * ez.x)
        + ex.z * (ey.x * ez.y - ey.y * ez.x);
    assert.equal(det, 1, 'equatorialToScene must be a rotation, not a reflection');
    // The celestial pole is scene +Y — the reason camera.up never moves.
    near(ez.x, 0, 0, 'the north celestial pole is scene +Y (x)');
    near(ez.y, 1, 0, 'the north celestial pole is scene +Y (y)');
    near(ez.z, 0, 0, 'the north celestial pole is scene +Y (z)');
    for (const v of [[1, 0, 0], [0.2, 0.5, -0.8]]) {
        const s = equatorialToScene(v[0], v[1], v[2]);
        const b = sceneToEquatorial(s.x, s.y, s.z);
        near(b.x, v[0], 0, 'scene round-trip is exact (x)');
        near(b.y, v[1], 0, 'scene round-trip is exact (y)');
        near(b.z, v[2], 0, 'scene round-trip is exact (z)');
    }
}

// Precession round-trip, and agreement with neo-orbits' own forward rotation.
{
    const jd = jdOf('2026-09-18T00:00:00Z');
    const v = { x: 0.6, y: -0.4, z: 0.05 };
    const there = j2000ToOfDate(v.x, v.y, v.z, jd);
    const back = ofDateToJ2000(there.x, there.y, there.z, jd);
    near(back.x, v.x, 1e-15, 'precession round-trip x');
    near(back.y, v.y, 1e-15, 'precession round-trip y');
    near(back.z, v.z, 1e-15, 'precession round-trip z');
    const orrery = toOfDate(v, jd);
    near(there.x, orrery.x, 1e-15, 'j2000ToOfDate is neo-orbits toOfDate');
    near(there.y, orrery.y, 1e-15, 'j2000ToOfDate is neo-orbits toOfDate');
    assert.ok(precessionLongitudeRad(jd) > 0, 'precession accumulates forward of J2000');
}

// Obliquity of date drifts the right way and stays sane over the page's span.
assert.equal(obliquityDeg(J2000), OBLIQUITY_J2000_DEG, 'obliquity at J2000 is the J2000 value');
assert.ok(obliquityDeg(J2000 + 36525) < OBLIQUITY_J2000_DEG, 'obliquity decreases with time');
near(obliquityDeg(J2000 + 36525), OBLIQUITY_J2000_DEG - 0.0130042, 1e-6, 'one century of obliquity drift');

// geoToScene preserves direction and puts the radius on the active map.
{
    const g = geoToScene(0, 0.002, 0.0005);
    const dKm = Math.hypot(0, 0.002, 0.0005) * AU_KM;
    near(Math.hypot(g.x, g.y, g.z), geoSceneRadius(dKm), 1e-12, 'log map radius');
    near(g.dKm, dKm, 1e-6, 'distance is reported alongside');
    near(g.dLD, dKm / LD_KM, 1e-12, 'LD is the same distance');
    const t = geoToScene(0, 0.002, 0.0005, { trueScale: true });
    near(Math.hypot(t.x, t.y, t.z), trueSceneRadius(dKm), 1e-9, 'true-scale radius');
    // Same direction under both maps — the toggle may not move anything sideways.
    const rl = Math.hypot(g.x, g.y, g.z), rt = Math.hypot(t.x, t.y, t.z);
    near(g.x / rl, t.x / rt, 1e-12, 'true scale keeps the direction');
    near(g.y / rl, t.y / rt, 1e-12, 'true scale keeps the direction');
    near(g.z / rl, t.z / rt, 1e-12, 'true scale keeps the direction');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Sidereal time
// ─────────────────────────────────────────────────────────────────────────────

// The DEFINING value: GMST at 2000-01-01 12:00 UT is 18h 41m 50.54841s.
near(gmstRad(J2000) / TWO_PI * 86400, 67310.54841, 1e-4, 'GMST at J2000.0 is the defining value');
// One solar day advances GMST by one sidereal day — i.e. by the extra 3m56s.
{
    const a = gmstRad(J2000), b = gmstRad(J2000 + 1);
    let d = ((b - a) % TWO_PI + TWO_PI) % TWO_PI;
    near(d / TWO_PI * 86400, 0.00273790935 * 86400, 0.02, 'a solar day is a sidereal day plus 3m56s');
}
// Monotonic (mod 2π) across a day, including the 0h boundary the split form
// introduces — a discontinuity there would jump the Earth mesh once a day.
{
    const jd0 = jdOf('2026-09-18T00:00:00Z');
    let last = gmstRad(jd0 - 0.01), wraps = 0;
    for (let k = 1; k <= 400; k++) {
        const g = gmstRad(jd0 - 0.01 + k * 0.0001);
        let d = g - last;
        if (d < 0) { d += TWO_PI; wraps++; }
        assert.ok(d >= 0 && d < 0.01, `GMST steps forward smoothly (step ${d} at k=${k})`);
        last = g;
    }
    assert.ok(wraps <= 1, 'at most one 2π wrap in a fortieth of a day');
}

// The observer vector sits on the surface and carries the site's latitude.
{
    const o = observerEquatorialOfDate(45, 12, 0.7);
    near(Math.hypot(o.x, o.y, o.z), 1, 1e-12, 'observer is one Earth radius out');
    near(Math.asin(o.z) * R2D, 45, 1e-12, 'observer keeps its latitude');
    const p = observerEquatorialOfDate(90, 0, 0);
    near(p.z, 1, 1e-12, 'the pole is on the axis');
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE ONE ASSERTION THAT TIES THE WHOLE POINTING CHAIN TOGETHER
// ─────────────────────────────────────────────────────────────────────────────
//
// Stand at the sub-solar point and the Sun is overhead, by definition. Getting
// 90° out of this requires the precession rotation, the obliquity of date,
// GMST and the SEZ rotation to ALL be right and consistent with each other.
for (const iso of ['2026-03-20T09:00:00Z', '2026-06-21T12:00:00Z', '2026-09-18T00:00:00Z', '2026-12-21T18:30:00Z']) {
    const jd = jdOf(iso);
    const sub = subSolarPoint(jd);
    const s = sunGeoDirectionJ2000(jd);
    const aa = topocentricAltAz(s.x * s.distAU, s.y * s.distAU, s.z * s.distAU,
        { latDeg: sub.latDeg, lonDeg: sub.lonDeg }, jd);
    near(aa.altDeg, 90, 0.02, `the Sun is overhead at its own sub-solar point (${iso})`);
    assert.ok(Math.abs(sub.latDeg) <= 23.5, `sub-solar latitude stays within the tropics (${iso})`);
}
// Solstice declinations are the tropics, to the obliquity.
near(subSolarPoint(jdOf('2026-06-21T12:00:00Z')).latDeg, 23.44, 0.06, 'June solstice sub-solar latitude');
near(subSolarPoint(jdOf('2026-12-21T12:00:00Z')).latDeg, -23.44, 0.06, 'December solstice sub-solar latitude');
// The sub-solar point sweeps west at 15°/hour.
{
    const jd = jdOf('2026-09-18T00:00:00Z');
    const a = subSolarPoint(jd).lonDeg, b = subSolarPoint(jd + 1 / 24).lonDeg;
    let d = ((b - a + 540) % 360) - 180;
    near(d, -15, 0.1, 'the sub-solar point moves 15° west per hour');
}

// Diurnal parallax: the whole reason alt/az is topocentric here. At the
// Moon's distance the observer's own offset is worth about a degree, and
// closer in it is worth a lot more.
{
    const jd = jdOf('2026-09-18T03:00:00Z');
    const m = moonGeoJ2000(jd);
    const sub = subSolarPoint(jd);
    const aa = topocentricAltAz(m.x, m.y, m.z, { latDeg: sub.latDeg, lonDeg: sub.lonDeg }, jd);
    assert.ok(aa.parallaxDeg <= Math.asin(EARTH_RADIUS_KM / m.distKm) * R2D + 1e-9,
        'parallax cannot exceed the horizontal parallax');
    // A body at a tenth of a lunar distance has 10x the parallax of the Moon.
    const close = { x: m.x * 0.1, y: m.y * 0.1, z: m.z * 0.1 };
    const aac = topocentricAltAz(close.x, close.y, close.z, { latDeg: sub.latDeg, lonDeg: sub.lonDeg }, jd);
    assert.ok(aac.parallaxDeg > aa.parallaxDeg * 5, 'parallax grows as the object closes');
    assert.ok(aac.rangeKm < m.distKm * 0.1 + EARTH_RADIUS_KM + 1, 'topocentric range accounts for the observer offset');
}

// Azimuth convention: due north of an equatorial observer reads 0°, and the
// compass label agrees.
{
    const jd = jdOf('2026-09-18T00:00:00Z');
    const g = gmstRad(jd);
    // A far-away point directly over the north pole, seen from the equator.
    const eqOfDate = { x: 0, y: 0, z: 1000 };                       // equatorial of date
    const ecl = equatorialToEcliptic(eqOfDate.x, eqOfDate.y, eqOfDate.z, obliquityDeg(jd));
    const j = ofDateToJ2000(ecl.x, ecl.y, ecl.z, jd);
    const aa = topocentricAltAz(j.x, j.y, j.z, { latDeg: 0, lonDeg: (g * R2D) % 360 }, jd);
    nearAngle(aa.azDeg, 0, 0.2, 'the celestial pole is due north');
    near(aa.altDeg, 0, 0.2, 'and on the horizon from the equator');
    assert.equal(compass16(aa.azDeg), 'N', 'compass label agrees');
}
assert.equal(compass16(90), 'E');
assert.equal(compass16(225), 'SW');

// ─────────────────────────────────────────────────────────────────────────────
// 4b. The drawn Earth's frame
// ─────────────────────────────────────────────────────────────────────────────

// At J2000 the correction is exactly the identity — if it is not, the globe is
// being rotated by something that should have vanished.
{
    const I = earthSceneMatrix(J2000);
    for (let k = 0; k < 9; k++) near(I[k], k % 4 === 0 ? 1 : 0, 1e-12, `identity at J2000 (entry ${k})`);
}
// It stays a rotation: orthonormal rows, determinant +1.
{
    const M = earthSceneMatrix(jdOf('2026-09-18T00:00:00Z'));
    for (let r = 0; r < 3; r++) {
        near(Math.hypot(M[r * 3], M[r * 3 + 1], M[r * 3 + 2]), 1, 1e-12, `row ${r} is a unit vector`);
        for (let q = r + 1; q < 3; q++) {
            const dot = M[r * 3] * M[q * 3] + M[r * 3 + 1] * M[q * 3 + 1] + M[r * 3 + 2] * M[q * 3 + 2];
            near(dot, 0, 1e-12, `rows ${r} and ${q} are orthogonal`);
        }
    }
    const det = M[0] * (M[4] * M[8] - M[5] * M[7])
              - M[1] * (M[3] * M[8] - M[5] * M[6])
              + M[2] * (M[3] * M[7] - M[4] * M[6]);
    near(det, 1, 1e-12, 'the Earth frame correction is a rotation');
    // And it is worth roughly the accumulated precession — small, but not zero.
    const ang = Math.acos(Math.max(-1, Math.min(1, (M[0] + M[4] + M[8] - 1) / 2))) * R2D;
    assert.ok(ang > 0.2 && ang < 0.6, `2026 correction is a few tenths of a degree, got ${ang}°`);
}
// THE GATE: the matrix must be the scalar chain, conjugated into scene axes.
// Build it independently from the one-at-a-time helpers and compare.
{
    const jd = jdOf('2026-09-18T00:00:00Z');
    const M = earthSceneMatrix(jd);
    const R = ofDateEquatorialToJ2000Matrix(jd);
    for (const v of [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0.3, y: -0.6, z: 0.74 }]) {
        // Scalar path: equatorial(date) → ecliptic(date) → ecliptic(J2000) → equatorial(J2000).
        const eclDate = equatorialToEcliptic(v.x, v.y, v.z, obliquityDeg(jd));
        const eclJ = ofDateToJ2000(eclDate.x, eclDate.y, eclDate.z, jd);
        const eqJ = eclipticToEquatorial(eclJ.x, eclJ.y, eclJ.z, OBLIQUITY_J2000_DEG);
        const viaR = applyMatrix3(R, v);
        near(viaR.x, eqJ.x, 1e-12, 'ofDateEquatorialToJ2000Matrix is the scalar chain (x)');
        near(viaR.y, eqJ.y, 1e-12, 'ofDateEquatorialToJ2000Matrix is the scalar chain (y)');
        near(viaR.z, eqJ.z, 1e-12, 'ofDateEquatorialToJ2000Matrix is the scalar chain (z)');
        // Scene path: the conjugated matrix applied to the scene-mapped vector
        // must equal the scene mapping of the corrected vector.
        const sv = equatorialToScene(v.x, v.y, v.z);
        const viaM = applyMatrix3(M, sv);
        const want = equatorialToScene(eqJ.x, eqJ.y, eqJ.z);
        near(viaM.x, want.x, 1e-12, 'earthSceneMatrix is the conjugated rotation (x)');
        near(viaM.y, want.y, 1e-12, 'earthSceneMatrix is the conjugated rotation (y)');
        near(viaM.z, want.z, 1e-12, 'earthSceneMatrix is the conjugated rotation (z)');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Ephemeris adapters — rotations preserve what they must
// ─────────────────────────────────────────────────────────────────────────────
{
    const jd = jdOf('2026-09-18T00:00:00Z');
    const e = earthHelioJ2000(jd), eRaw = earthHeliocentric(jd);
    near(Math.hypot(e.x, e.y, e.z), eRaw.dist_AU, 1e-12, 'the frame rotation preserves Earth distance');
    near(e.rAU, eRaw.dist_AU, 0, 'and reports it');
    const m = moonGeoJ2000(jd), mRaw = moonGeocentric(jd);
    near(Math.hypot(m.x, m.y, m.z) * AU_KM, mRaw.dist_km, 1e-6, 'the frame rotation preserves Moon distance');
    // The rotation is NOT the identity — if someone deletes it, this fails.
    const mOfDate = j2000ToOfDate(m.x, m.y, m.z, jd);
    assert.ok(Math.hypot(mOfDate.x - m.x, mOfDate.y - m.y) > 1e-7,
        'of-date and J2000 differ measurably — the conversion is load-bearing');
    // The Sun direction is the anti-Earth direction, unit length.
    const s = sunGeoDirectionJ2000(jd);
    near(Math.hypot(s.x, s.y, s.z), 1, 1e-12, 'sun direction is a unit vector');
    near(s.x, -e.x / e.rAU, 1e-12, 'and points away from Earth’s heliocentric position');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. THE CROSS-KERNEL GATE: geocentric distance is frame-independent
// ─────────────────────────────────────────────────────────────────────────────
//
// neo-orbits.js computes rGeo in the ecliptic OF DATE (objects rotated
// forward, Earth taken from VSOP87D). This kernel computes it in J2000
// (Earth rotated back). A common rotation preserves distance, so the two must
// agree to floating point. If either side ever drops or double-applies the
// precession, this fails — and it is the only assertion that would.
{
    const jd = jdOf('2026-09-18T00:00:00Z');
    const recs = [
        { des: 'A', e: 0.22, a: 1.08, i: 3.4, om: 41.2, w: 12.7, ma: 200.1, epoch: 2461000.5, H: 21.5, flags: 1 },
        { des: 'B', e: 0.56, a: 1.98, i: 18.9, om: 210.0, w: 301.4, ma: 12.0, epoch: 2461000.5, H: 18.2, flags: 3 },
        { des: 'C', e: 0.09, a: 0.87, i: 7.1, om: 99.9, w: 45.0, ma: 300.0, epoch: 2461000.5, H: 24.0, flags: 1 },
    ];
    const { cols, els } = prepareColumns(recs);
    assert.equal(els.length, 3, 'all three fixtures normalise');
    const helio = new Float64Array(9);
    propagateColumns(cols, jd, helio);

    // Path A — neo-orbits, of date.
    const eOfDate = earthHeliocentric(jd);
    const sceneA = new Float32Array(9), rHelioA = new Float32Array(3), rGeoA = new Float32Array(3);
    deriveFrames(helio, 3, [eOfDate.x_AU, eOfDate.y_AU, eOfDate.z_AU], sceneA, rHelioA, rGeoA, precessionLongitudeRad(jd));

    // Path B — this kernel, J2000.
    const eJ = earthHelioJ2000(jd);
    const geo = new Float64Array(9), rHelioB = new Float64Array(3), rGeoB = new Float64Array(3);
    deriveGeocentric(helio, 3, [eJ.x, eJ.y, eJ.z], geo, rHelioB, rGeoB);

    for (let k = 0; k < 3; k++) {
        near(rGeoB[k], rGeoA[k], 1e-6, `geocentric distance is frame-independent (object ${k})`);
        near(rHelioB[k], rHelioA[k], 1e-6, `heliocentric distance agrees (object ${k})`);
        // And the geocentric vector really is object minus Earth.
        const p = propagate(normalizeElements(recs[k]).el, jd);
        near(geo[k * 3], p.x - eJ.x, 1e-12, 'geocentric x');
        near(geo[k * 3 + 1], p.y - eJ.y, 1e-12, 'geocentric y');
        near(geo[k * 3 + 2], p.z - eJ.z, 1e-12, 'geocentric z');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Photometry
// ─────────────────────────────────────────────────────────────────────────────

// Phase angle from the triangle — the three degenerate configurations.
near(phaseAngleDeg(2, 1, 1), 0, 1e-9, 'collinear, Earth between: zero phase');
near(phaseAngleDeg(1, 1, Math.sqrt(2)), 90, 1e-9, 'right-angle triangle: 90° phase');
near(phaseAngleDeg(1, 1, Math.sqrt(3)), 120, 1e-9, '120° phase');

// At zero phase both Φ terms are 1, so V collapses to the textbook form.
{
    const r = apparentMagnitude(20, 2, 1, 1);
    near(r.phaseDeg, 0, 1e-9, 'zero phase');
    near(r.mag, 20 + 5 * Math.log10(2 * 1), 1e-12, 'V = H + 5log₁₀(rΔ) at zero phase');
    assert.equal(r.outOfRange, false);
}
// Fainter with phase, monotonically.
{
    let last = -Infinity;
    for (const R of [0.001, 0.5, 1.0, 1.2, 1.4, 1.6]) {
        const r = apparentMagnitude(20, 1, 1, R);
        assert.ok(r.mag > last, `magnitude increases with phase angle (R=${R})`);
        last = r.mag;
    }
}
// Past the fit limit the number is refused, not extrapolated. The geometry
// that produces a 140° phase angle: an isoceles triangle with R = |2−2cos140|^½.
{
    const R = Math.sqrt(2 - 2 * Math.cos(140 * D2R));
    const r = apparentMagnitude(20, 1, 1, R);
    near(r.phaseDeg, 140, 1e-9, 'the fixture really is at 140° phase');
    assert.equal(r.mag, null, 'no magnitude past the H,G fit limit');
    assert.equal(r.outOfRange, true, 'and it says why');
    // Just inside the limit it still answers — the refusal is a cliff at the
    // stated place, not a general reluctance.
    const inside = apparentMagnitude(20, 1, 1, Math.sqrt(2 - 2 * Math.cos(119 * D2R)));
    assert.ok(Number.isFinite(inside.mag), 'just inside the fit limit still answers');
    assert.equal(inside.outOfRange, false);
}
// No H (a comet) is a missing input, not an out-of-range one.
{
    const r = apparentMagnitude(null, 1, 1, 1);
    assert.equal(r.mag, null, 'no H, no magnitude');
    assert.equal(r.outOfRange, false, 'and that is not the fit limit');
}
// G is honoured and bounded.
assert.ok(apparentMagnitude(20, 1, 1, 1, 0.5).mag !== apparentMagnitude(20, 1, 1, 1, DEFAULT_G).mag,
    'the slope parameter changes the answer');
assert.ok(Number.isFinite(apparentMagnitude(20, 1, 1, 1, 9).mag), 'an out-of-range G is clamped, not NaN');

// Inverse-square-ish scaling: ten times further (both legs) is 5 magnitudes.
near(apparentMagnitude(20, 10, 10, 10).mag - apparentMagnitude(20, 1, 1, 1).mag,
    5 * Math.log10(100), 1e-9, 'distance scaling is 5log₁₀(rΔ)');

// Angular size and rate.
near(angularDiameterArcsec(1, 384400), 2 * Math.atan(1 / (2 * 384400)) * R2D * 3600, 1e-12, 'angular diameter');
assert.equal(angularDiameterArcsec(0, 1000), null, 'no diameter, no angle');
{
    // Two unit vectors exactly 1° apart, one hour apart in time.
    const a = [1, 0, 0], b = [Math.cos(1 * D2R), Math.sin(1 * D2R), 0];
    near(angularRateDegPerHour(a, b, 1 / 24), 1, 1e-9, 'one degree per hour');
    assert.equal(angularRateDegPerHour(a, b, 0), null, 'zero interval has no rate');
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Close approach
// ─────────────────────────────────────────────────────────────────────────────

// Straight-line relative motion has an analytic minimum; recover it.
{
    const t0 = 2461301.234, d0 = 0.0007, v = 0.003;              // AU/day
    const f = (t) => Math.hypot(d0, v * (t - t0));
    const got = findApproach(f, 2461301.0, 3);
    assert.ok(got, 'a bracketed minimum is found');
    near(got.jd, t0, 1e-5, 'closest-approach time');
    near(got.distAU, d0, 1e-9, 'closest-approach distance');
    assert.ok(got.distAU <= got.coarseMinAU, 'refinement never does worse than the coarse scan');
}
// A monotonic window has no interior minimum, and saying "the edge" would
// turn every search-window boundary into a close approach.
assert.equal(findApproach((t) => t, 2461301, 3), null, 'a monotonic window yields no approach');
assert.equal(findApproach((t) => -t, 2461301, 3), null, 'nor does the other direction');

// refineMinimum on a parabola with a known vertex.
{
    const r = refineMinimum((t) => (t - 7.3) ** 2 + 2, 0, 20, 1e-9);
    near(r.t, 7.3, 1e-6, 'parabola vertex');
    near(r.value, 2, 1e-9, 'parabola minimum');
}

// The comparison against JPL reports a signed disagreement, in the units the
// page prints.
{
    const c = compareApproach({ jd: 2461301.5, distAU: 0.0031 }, 0.0029, 2461301.4);
    near(c.dDistAU, 0.0002, 1e-15, 'signed distance difference');
    near(c.dDistLD, 0.0002 / LD_AU, 1e-12, 'in lunar distances');
    // A Julian Day is ~2.46e6, so a tenth of a day is only good to ~1e-8 d
    // there — the tolerance is the epoch's precision, not the function's.
    near(c.dTimeHours, 0.1 * 24, 1e-6, 'and a signed time difference in hours');
    assert.equal(compareApproach(null, 0.003, 1), null, 'nothing to compare against nothing');
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Impact energy
// ─────────────────────────────────────────────────────────────────────────────

// Chelyabinsk: ~19 m entering at ~19 km/s, ordinary chondrite. The accepted
// yield is ~0.4–0.5 Mt; this is the anchor that says the formula is in the
// right units, not a claim of precision.
{
    const e = impactEnergy(0.019, 19.16, 3300);
    assert.ok(e.megatons > 0.2 && e.megatons < 1.2, `Chelyabinsk-class yield, got ${e.megatons} Mt`);
}
// Scaling identities.
{
    const a = impactEnergy(1, 20), b = impactEnergy(2, 20);
    near(b.joules / a.joules, 8, 1e-9, 'energy goes as diameter cubed');
    const c = impactEnergy(1, 40);
    near(c.joules / a.joules, 4, 1e-9, 'energy goes as speed squared');
    near(impactEnergy(1, 20, DENSITY.metallic).joules / impactEnergy(1, 20, DENSITY.stony).joules,
        DENSITY.metallic / DENSITY.stony, 1e-9, 'and linearly with density');
    assert.equal(impactEnergy(0, 20), null, 'no diameter, no energy');
    assert.equal(impactEnergy(1, 0), null, 'no speed, no energy');
    assert.equal(a.densityKgM3, DENSITY.stony, 'stony is the stated default');
}
assert.match(energyComparison(12), /Tunguska/, 'the 10 Mt band names Tunguska');
assert.match(energyComparison(0.5), /Chelyabinsk/, 'the sub-Mt band names Chelyabinsk');
assert.equal(energyComparison(NaN), '—');

// ─────────────────────────────────────────────────────────────────────────────
// 10. Formatting
// ─────────────────────────────────────────────────────────────────────────────
assert.match(formatGeoDistance(0.05 * LD_KM), /km$/, 'very close reads in km');
assert.match(formatGeoDistance(3.2 * LD_KM), /LD$/, 'near reads in lunar distances');
assert.match(formatGeoDistance(0.4 * AU_KM), /AU$/, 'far reads in AU');
assert.equal(formatGeoDistance(NaN), '—');
assert.match(formatRelativeTime(-0.5), /ago$/, 'the past is past');
assert.match(formatRelativeTime(3), /^in /, 'the future is future');
assert.match(formatRelativeTime(0.02), /min$/, 'minutes under an hour');
assert.equal(formatRaDec(0, 0), '0h 0.0m +0.0°');
assert.match(formatRaDec(180.5, -12.25), /^12h 2\.0m −12\.3°$/, 'RA in hours, Dec signed');
assert.equal(visibilityBand(3).id, 'naked-eye');
assert.equal(visibilityBand(8).id, 'binocular');
assert.equal(visibilityBand(30).id, 'beyond');
assert.equal(visibilityBand(null), null);

// ─────────────────────────────────────────────────────────────────────────────
// 11. The object row — one derivation, and honest nulls
// ─────────────────────────────────────────────────────────────────────────────
{
    const jd = jdOf('2026-09-18T00:00:00Z');
    const el = { des: '99942', name: '99942 Apophis (2004 MN4)', H: 19.7, cls: 'ATE', flags: 3, diam: 0.34, moid: 0.0002, epoch: 2461000.5 };
    const geo = [0.002, -0.0009, 0.0004];
    const row = buildObjectRow(el, { geo, rHelioAU: 1.02, earthRAU: 1.004, jd, index: 7 });
    near(row.distAU, Math.hypot(...geo), 1e-15, 'the row reports the distance it was given');
    near(row.distKm, row.distAU * AU_KM, 1e-6, 'km and AU agree');
    near(row.distLD, row.distKm / LD_KM, 1e-12, 'LD agrees too');
    assert.equal(row.distLabel, formatGeoDistance(row.distKm), 'the label is the same number');
    assert.equal(row.isPHA, true, 'flag 2 is a PHA');
    assert.equal(row.isComet, false);
    assert.equal(row.sizeSource, 'measured', 'a published diameter is reported as measured');
    assert.equal(row.sizeKm, 0.34);
    assert.ok(Number.isFinite(row.mag), 'a magnitude is computed when H and both distances are there');
    assert.equal(row.magBand.id, visibilityBand(row.mag).id, 'the band matches the magnitude');
    assert.equal(row.sky, null, 'no observer, no altitude — not a guessed one');
    assert.equal(row.rateDegPerHour, null, 'no previous sample, no sky rate');
    assert.ok(/two-body|current/.test(row.elementsNote), 'the elements age travels with the row');
    assert.equal(row.index, 7, 'the catalogue index survives');
    // RA/Dec is the kernel's own, not a second derivation.
    const rd = raDecFromEclipticJ2000(...geo);
    near(row.raDeg, rd.raDeg, 0, 'RA is the kernel value');
    assert.equal(row.raDecLabel, formatRaDec(rd.raDeg, rd.decDeg), 'and the label is its format');
}
{
    // No diameter ⇒ estimated from H, and SAID to be estimated.
    const jd = jdOf('2026-09-18T00:00:00Z');
    const row = buildObjectRow({ des: 'X', H: 22, flags: 1, epoch: 2461000.5 },
        { geo: [0.001, 0, 0], rHelioAU: 1, earthRAU: 1, jd });
    assert.match(row.sizeSource, /albedo/, 'an H-derived size discloses the albedo assumption');
    near(row.sizeKm, diameterKmFromH(22), 0, 'and it is the kernel\u2019s own H\u2192D conversion, not a second one');
    // A comet gets no H,G magnitude at all, and says why.
    const comet = buildObjectRow({ des: '109P', H: 13, flags: 5, epoch: 2461000.5 },
        { geo: [0.01, 0, 0], rHelioAU: 1.2, earthRAU: 1, jd });
    assert.equal(comet.mag, null, 'no H,G magnitude for a comet');
    assert.match(comet.magNote, /activity/, 'and it says why');
    assert.equal(comet.isComet, true);
    // No distances at all ⇒ no magnitude and no phase, rather than NaN.
    const bare = buildObjectRow({ des: 'Y', flags: 1 }, { geo: [0.01, 0, 0], jd });
    assert.equal(bare.mag, null);
    assert.equal(bare.phaseDeg, null);
    assert.equal(bare.elementsNote, null, 'no epoch, no age claim');
    assert.equal(bare.sizeKm, null, 'no H and no diameter, no size');
}
{
    // With an observer the row carries a real pointing, and the sky rate comes
    // from two samples the caller supplies.
    const jd = jdOf('2026-09-18T00:00:00Z');
    const m = moonGeoJ2000(jd), m2 = moonGeoJ2000(jd + 1 / 24);
    const row = buildObjectRow({ des: 'MOON', flags: 0 }, {
        geo: [m2.x, m2.y, m2.z], jd: jd + 1 / 24, observer: { latDeg: 51.48, lonDeg: -0.0 },
        prevGeo: [m.x, m.y, m.z], prevDtDays: 1 / 24,
    });
    assert.ok(row.sky && Number.isFinite(row.sky.altDeg), 'an observer produces an altitude');
    assert.equal(row.sky.up, row.sky.altDeg > 0, 'and an up/down flag that agrees with it');
    assert.equal(row.sky.compass, compass16(row.sky.azDeg), 'and a compass label that agrees');
    // The Moon moves ~0.5°/h against the stars; anything near that is right.
    assert.ok(row.rateDegPerHour > 0.3 && row.rateDegPerHour < 0.8,
        `the Moon's sky rate is about half a degree an hour, got ${row.rateDegPerHour}`);
}

console.log('neo-space.mjs — all assertions passed');
