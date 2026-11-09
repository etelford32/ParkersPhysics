/**
 * Node gate for js/sun-precise.js — the Sun to arcseconds.
 *
 * Published worked examples, not remembered outputs of this code:
 *   · Meeus, Astronomical Algorithms 2nd ed., Example 25.b (1992 Oct 13.0 TD):
 *     Earth L = 19.907372°, R = 0.99760775 AU; apparent λ = 199°54′21.818″;
 *     apparent α = 13h13m30.749s, δ = −7°47′01.74″; Δψ = +15.908″
 *   · NREL SPA (Reda & Andreas 2004), the paper's test case: 2003-10-17
 *     12:30:30 at UTC−7, 39.742476° N 105.1786° W, 1830.14 m, 820 mbar, 11 °C,
 *     ΔT 67 s → topocentric zenith 50.11162°, azimuth 194.34024°,
 *     α′ = 202.22704°, δ′ = −9.316179°
 * Then identities, and the MEASURED error of the everyday routine it does not
 * replace (js/sun-altitude.js) — the reason this module exists.
 */
import assert from 'node:assert/strict';
import { sunGeocentric, solarPositionPrecise, refractionDeg, deltaTSeconds, nutation, REFRACTION_FLOOR_DEG, SOLAR_PARALLAX_ARCSEC } from '../js/sun-precise.js';
import { solarPosition } from '../js/sun-altitude.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const AS = 1 / 3600;
const wrap = (d) => ((d + 540) % 360) - 180;

// ── Meeus 25.b ──────────────────────────────────────────────────────────────
{
    const g = sunGeocentric(2448908.5, { deltaTSec: 0 });
    near(g.earthLonDeg, 19.907372, 0.5 * AS, 'Earth heliocentric longitude');
    near(g.distanceAU, 0.99760775, 2e-6, 'radius vector');
    near(g.earthLatArcsec, -0.644, 0.05, 'Earth heliocentric latitude, arcsec');
    near(g.dPsiArcsec, 15.908, 0.5, 'nutation in longitude (four-term series: 0.5″)');
    near(g.obliquityDeg, 23 + 26 / 60 + 24.524 / 3600, 0.2 * AS, 'true obliquity');
    near(g.apparentLonDeg, 199 + 54 / 60 + 21.818 / 3600, 0.6 * AS, 'apparent longitude');
    near(g.raDeg, 15 * (13 + 13 / 60 + 30.749 / 3600), 1 * AS, 'apparent right ascension');
    near(g.decDeg, -(7 + 47 / 60 + 1.74 / 3600), 0.6 * AS, 'apparent declination');
}

// ── NREL SPA's test case ────────────────────────────────────────────────────
{
    const p = solarPositionPrecise(Date.UTC(2003, 9, 17, 19, 30, 30), 39.742476, -105.1786,
        { elevationM: 1830.14, pressureHpa: 820, temperatureC: 11, deltaTSec: 67 });
    near(90 - p.altitudeDeg, 50.11162, 2 * AS, 'topocentric zenith angle (refracted)');
    near(p.azimuthDeg, 194.34024, 2 * AS, 'azimuth, eastward from north');
    near(p.rightAscensionDeg, 202.22704, 2 * AS, 'topocentric right ascension');
    near(p.declinationDeg, -9.316179, 2 * AS, 'topocentric declination');
    near(p.hourAngleDeg, 11.105902, 3 * AS, 'topocentric local hour angle');
    // Refraction and parallax are both IN that agreement: without either it fails.
    const airless = solarPositionPrecise(Date.UTC(2003, 9, 17, 19, 30, 30), 39.742476, -105.1786, { elevationM: 1830.14, deltaTSec: 67, refraction: false });
    assert.ok(Math.abs((90 - airless.altitudeDeg) - 50.11162) > 30 * AS, 'NEGATIVE CONTROL: without refraction the zenith angle misses by tens of arcseconds');
    assert.equal(airless.altitudeDeg, airless.geometricAltitudeDeg);
}

// ── parallax: the Sun on the horizon is lowered by its horizontal parallax ──
{
    // Equator at an equinox noon vs six hours later: parallax 0 overhead, ~8.8″ at the horizon.
    const t = Date.UTC(2026, 2, 20, 12, 7);
    const lon0 = -solarPositionPrecise(t, 0, 0, { refraction: false }).hourAngleDeg;      // Sun on this meridian
    const over = solarPositionPrecise(t, 0, lon0, { refraction: false });
    const rim = solarPositionPrecise(t, 0, lon0 + 90, { refraction: false });
    const g = sunGeocentric(over.jd);
    const geoAlt = (lon) => Math.asin(Math.cos(g.decDeg * Math.PI / 180) * Math.cos(wrap(g.gastDeg + lon - g.raDeg) * Math.PI / 180)) * 180 / Math.PI;
    near(over.geometricAltitudeDeg - geoAlt(lon0), 0, 0.5 * AS, 'no parallax toward the zenith');
    near((geoAlt(lon0 + 90) - rim.geometricAltitudeDeg) / AS, SOLAR_PARALLAX_ARCSEC / g.distanceAU, 0.3, 'the full horizontal parallax at the horizon, arcsec');
}

// ── refraction ──────────────────────────────────────────────────────────────
near(refractionDeg(0), 0.48, 0.03, 'about 29′ at the horizon (standard atmosphere)');
near(refractionDeg(45) / AS, 59, 4, 'about 1′ at 45°');
assert.ok(refractionDeg(90) < 1 * AS, 'none at the zenith');
assert.equal(refractionDeg(REFRACTION_FLOOR_DEG - 0.01), 0, 'none once the whole disc is below the horizon');
near(refractionDeg(10, { pressureHpa: 505 }), refractionDeg(10) / 2, 1e-12, 'proportional to pressure');
for (let e = -0.8; e < 89; e += 0.7) assert.ok(refractionDeg(e) >= refractionDeg(e + 0.7) - 1e-12, 'monotone: more air, more bending');
{
    // The apparent Sun rises before the geometric one: at geometric −0.4° it is already up.
    let t = Date.UTC(2026, 10, 10, 13, 0), p;
    for (let k = 0; k < 600; k++) { p = solarPositionPrecise(t + k * 30_000, 40, -105.3); if (p.geometricAltitudeDeg > -0.4) break; }
    assert.ok(p.geometricAltitudeDeg < 0 && p.altitudeDeg > 0, `geometric ${p.geometricAltitudeDeg.toFixed(3)}° is below the horizon, apparent ${p.altitudeDeg.toFixed(3)}° above`);
}

// ── identities ──────────────────────────────────────────────────────────────
{
    const t = Date.UTC(2026, 5, 21, 18, 3);
    for (const [lat, lon] of [[40, -105], [-33.9, 151.2], [69.6, 18.9], [0, 0]]) {
        const p = solarPositionPrecise(t, lat, lon, { refraction: false });
        const s = Math.sin(lat * Math.PI / 180) * Math.sin(p.declinationDeg * Math.PI / 180)
            + Math.cos(lat * Math.PI / 180) * Math.cos(p.declinationDeg * Math.PI / 180) * Math.cos(p.hourAngleDeg * Math.PI / 180);
        near(p.geometricAltitudeDeg, Math.asin(s) * 180 / Math.PI, 1e-9, 'altitude from the topocentric δ and H');
        assert.ok(p.azimuthDeg >= 0 && p.azimuthDeg < 360);
        assert.ok((p.hourAngleDeg > 0) === (p.azimuthDeg > 180), 'past the meridian ⇔ in the west');
    }
    // The solstice Sun stands near +23.44°; the distance runs 0.983–1.017 AU with perihelion in early January.
    near(solarPositionPrecise(Date.UTC(2026, 5, 21, 8, 0), 0, 0).declinationDeg, 23.44, 0.01, 'June solstice declination');
    const peri = sunGeocentric(Date.UTC(2026, 0, 3, 17) / 86_400_000 + 2440587.5).distanceAU, aph = sunGeocentric(Date.UTC(2026, 6, 6, 17) / 86_400_000 + 2440587.5).distanceAU;
    near(peri, 0.9833, 0.0003, 'perihelion distance'); near(aph, 1.0166, 0.0003, 'aphelion distance');
    near(deltaTSeconds(Date.UTC(2026, 10, 9) / 86_400_000 + 2440587.5), 75, 5, 'ΔT now (the polynomial; the measured value is ~69 s, a 0.25″ difference)');
    near(nutation(0).eps0 * 180 / Math.PI, 23.4392911, 1e-7, 'mean obliquity at J2000');
    assert.equal(sunGeocentric(2461000.25), sunGeocentric(2461000.25), 'the geocentric part is cached per instant');
}

// ── what the everyday routine is off by (it is NOT replaced; this is why this module exists) ──
{
    let alt = 0, az = 0;
    for (let d = 0; d < 366; d += 2) for (let h = 0; h < 24; h += 3) {
        const t = new Date(Date.UTC(2026, 0, 1 + d, h, 7));
        const a = solarPosition(t, 40, -105.3), b = solarPositionPrecise(t, 40, -105.3, { refraction: false });
        alt = Math.max(alt, Math.abs(a.altitudeDeg - b.geometricAltitudeDeg));
        if (Math.abs(b.geometricAltitudeDeg) < 60) az = Math.max(az, Math.abs(wrap(a.azimuthDeg - b.azimuthDeg)));
    }
    assert.ok(alt > 0.005 && alt < 0.03, `sun-altitude.js altitude is within ${alt.toFixed(4)}° of this (its header says ~1′) — and has no refraction`);
    assert.ok(az > 0.005 && az < 0.05, `…and its azimuth within ${az.toFixed(4)}°`);
    console.log(`  everyday routine vs precise over 2026 at 40° N: altitude ≤ ${(alt * 60).toFixed(1)}′, azimuth ≤ ${(az * 60).toFixed(1)}′, plus up to ${(refractionDeg(0) * 60).toFixed(0)}′ of refraction it does not model`);
}

// ── the Climalytix map and its terrain kernel read THIS Sun (source text: one import each) ──
{
    const { readFileSync } = await import('node:fs');
    for (const f of ['js/climalytix/map.js', 'js/climalytix/terrain.js']) {
        const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
        assert.match(src, /import \{ solarPositionPrecise as solarPosition \} from '\.\.\/sun-precise\.js';/, `${f} imports the precise Sun`);
        assert.doesNotMatch(src, /from '\.\.\/sun-altitude\.js'/, `${f} no longer reads the ~1′ routine`);
    }
}

console.log('sun-precise: ok');
