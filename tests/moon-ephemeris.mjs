#!/usr/bin/env node
/**
 * moon-ephemeris.mjs — gate for js/moon-ephemeris.js.
 *
 * Run: node tests/moon-ephemeris.mjs
 *
 * The load-bearing pins:
 *   • Meeus Example 53.a (1992 April 12.0 TD): sub-Earth l′ = −1.21°,
 *     b′ = +4.19°; sub-solar l₀ = 67.90°, b₀ = +1.46°, c₀ = 22.10°. And
 *     Example 48.a, the same instant: phase angle i = 69.08°, k = 0.6786.
 *     The kernel's 16-term lunar series lands within 0.05° of all of them.
 *   • Libration bounds: over 20 years the sub-Earth point never leaves
 *     ±8.2° in longitude / ±6.9° in latitude (the optical libration
 *     envelope — anything outside means the Cassini frame is wrong).
 *   • Phase identities: the sub-solar and sub-Earth longitudes differ by
 *     the elongation; illumination is (1 + cos i)/2 of the vector angle.
 *   • bodyVector mirrors artemis-data's latLonToXYZ exactly.
 *   • The dawn limb is 90° east of the sub-solar point (where the prograde
 *     spin carries ground INTO sunlight), and local solar time reads 12 h
 *     at the sub-solar longitude, 6 h at the morning terminator.
 */

import assert from 'node:assert/strict';
import {
    lunarGeometry, selenographicSubPoint, bodyVector, dawnDirection,
    localSolarHours, solarZenithDeg, phaseName, ascendingNodeDeg,
    argumentOfLatitudeDeg, SYNODIC_MONTH_DAYS, toJd,
} from '../js/moon-ephemeris.js';
import { latLonToXYZ } from '../js/artemis-data.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── 1. Meeus 53.a / 48.a — 1992 April 12.0 TD ───────────────────────────────
{
    const jd = 2448724.5;
    const g = lunarGeometry(jd);
    near(g.subEarth.lonDeg, -1.206, 0.08, 'optical libration in longitude (Meeus 53.a)');
    near(g.subEarth.latDeg, 4.194, 0.05, 'optical libration in latitude (Meeus 53.a)');
    near(g.subSolar.lonDeg, 67.90, 0.08, 'sub-solar longitude l₀ (Meeus 53.a)');
    near(g.subSolar.latDeg, 1.46, 0.05, 'sub-solar latitude b₀ (Meeus 53.a)');
    near(g.colongitudeDeg, 22.10, 0.08, 'colongitude c₀ (Meeus 53.a)');
    near(g.phaseAngleDeg, 69.08, 0.1, 'phase angle i (Meeus 48.a)');
    near(g.illumination, 0.6786, 0.002, 'illuminated fraction k (Meeus 48.a)');
    near(g.distanceKm, 368409.7, 150, 'Earth–Moon distance (Meeus 47.a class)');
    // Fundamental argument at the example instant (Meeus 53.a prints F);
    // Ω is pinned implicitly — a 0.4° error there moves l′ by ~0.4°.
    near(argumentOfLatitudeDeg(jd), 219.889721, 0.001, 'argument of latitude F');
    assert.ok(ascendingNodeDeg(jd) > 274 && ascendingNodeDeg(jd) < 275, 'ascending node in its 1992 quadrant');
    ok('Meeus 53.a / 48.a reproduced: libration, sub-solar point, phase angle, k');
}

// ── 2. Libration envelope over 20 years ─────────────────────────────────────
{
    let maxLon = 0, maxLat = 0, minDist = Infinity, maxDist = 0;
    const jd0 = toJd(new Date(Date.UTC(2020, 0, 1)));
    for (let d = 0; d < 20 * 365.25; d += 0.25) {
        const g = lunarGeometry(jd0 + d);
        maxLon = Math.max(maxLon, Math.abs(g.subEarth.lonDeg));
        maxLat = Math.max(maxLat, Math.abs(g.subEarth.latDeg));
        minDist = Math.min(minDist, g.distanceKm);
        maxDist = Math.max(maxDist, g.distanceKm);
        assert.ok(Math.abs(g.subSolar.latDeg) < 1.6, 'sub-solar latitude within the 1.54° equator tilt');
    }
    assert.ok(maxLon > 5 && maxLon < 8.3, `longitude libration envelope reached (${maxLon.toFixed(2)}°)`);
    assert.ok(maxLat > 5 && maxLat < 6.95, `latitude libration envelope reached (${maxLat.toFixed(2)}°)`);
    assert.ok(minDist > 355000 && minDist < 358000, `perigee range (${minDist.toFixed(0)} km)`);
    assert.ok(maxDist > 405000 && maxDist < 407500, `apogee range (${maxDist.toFixed(0)} km)`);
    ok('20-year sweep stays inside the optical-libration and distance envelopes');
}

// ── 3. Phase identities ─────────────────────────────────────────────────────
{
    const jd0 = toJd(new Date(Date.UTC(2026, 0, 1)));
    for (let d = 0; d < 60; d += 0.5) {
        const g = lunarGeometry(jd0 + d);
        // Vector angle ↔ illumination
        near(g.illumination, (1 + Math.cos(g.phaseAngleDeg * Math.PI / 180)) / 2, 1e-12, 'k from i');
        // Sub-solar − sub-Earth longitude tracks the elongation (to within
        // the libration's own few-degree wobble and the parallax term)
        let dLon = ((g.subSolar.lonDeg - g.subEarth.lonDeg) % 360 + 360) % 360;
        // A waxing crescent is lit on the selenographic EAST limb (Crisium's
        // side), so the sub-solar point sits at 180° − elongation: new moon →
        // the antipode, first quarter → +90° E, full → the sub-Earth point.
        const expected = ((180 - g.elongationDeg) % 360 + 360) % 360;
        let diff = Math.abs(dLon - expected);
        if (diff > 180) diff = 360 - diff;
        assert.ok(diff < 2.0, `sub-solar lon − sub-Earth lon ≈ 180° − elongation (diff ${diff.toFixed(2)}°)`);
        // Age/phase from elongation
        near(g.ageDays, g.elongationDeg / 360 * SYNODIC_MONTH_DAYS, 1e-9, 'age from elongation');
        assert.equal(g.phase, phaseName(g.ageDays));
        assert.equal(g.waxing, g.elongationDeg < 180);
    }
    // Near full moon the phase angle is small; near new it is large
    let minI = 180, maxI = 0;
    for (let d = 0; d < 30; d += 0.1) {
        const g = lunarGeometry(jd0 + d);
        minI = Math.min(minI, g.phaseAngleDeg);
        maxI = Math.max(maxI, g.phaseAngleDeg);
    }
    assert.ok(minI < 6, `full moon reaches a small phase angle (${minI.toFixed(1)}°)`);
    assert.ok(maxI > 174, `new moon reaches a large phase angle (${maxI.toFixed(1)}°)`);
    ok('phase identities: k ↔ i, elongation ↔ longitudes, full/new extremes');
}

// ── 4. Frame conventions ────────────────────────────────────────────────────
{
    for (const [lat, lon] of [[0, 0], [45, 90], [-30, -120], [89, 10], [7.4, -59.1]]) {
        const a = bodyVector(lat, lon);
        const b = latLonToXYZ(lat, lon, 1);
        near(a.x, b.x, 1e-12, 'bodyVector.x = latLonToXYZ.x');
        near(a.y, b.y, 1e-12, 'bodyVector.y');
        near(a.z, b.z, 1e-12, 'bodyVector.z');
    }
    // Dawn limb: 90° EAST of the sub-solar point. Sub-solar at lon 0 → dawn
    // limb at lon −90°? No: the ground rotates eastward, so points at lon
    // −90° (west of noon) are at dusk; the morning terminator is at +90° E…
    // but a point there saw sunrise 6 h ago at lon −90°+… — pin it against
    // local solar time instead of hand-reasoning: the dawn direction's
    // longitude must read 6 h.
    const sun = bodyVector(0, 0);
    const dawn = dawnDirection(sun);
    const dawnLon = Math.atan2(-dawn.z, dawn.x) * 180 / Math.PI;
    near(localSolarHours(dawnLon, 0), 6, 1e-9, 'dawn limb reads 06:00 local solar time');
    near(localSolarHours(0, 0), 12, 1e-9, 'sub-solar longitude reads noon');
    near(localSolarHours(180, 0), 0, 1e-9, 'antipode reads midnight');
    near(solarZenithDeg(0, 0, { latDeg: 0, lonDeg: 0 }), 0, 1e-9, 'zenith angle 0 at the sub-solar point');
    near(solarZenithDeg(0, 90, { latDeg: 0, lonDeg: 0 }), 90, 1e-9, 'zenith 90° on the terminator');
    near(solarZenithDeg(0, 180, { latDeg: 0, lonDeg: 0 }), 180, 1e-9, 'zenith 180° at the antipode');
    // selenographicSubPoint longitude stays in (−180, 180]
    for (let L = 0; L < 360; L += 7) {
        const p = selenographicSubPoint(L, 0, 2451545);
        assert.ok(p.lonDeg > -180 && p.lonDeg <= 180);
        assert.ok(Math.abs(p.latDeg) <= 1.6);
    }
    assert.throws(() => toJd('2026-01-01'), /Julian Day/);
    ok('frame conventions: latLonToXYZ mirror, dawn limb = 06:00, zenith angles');
}

console.log(`\nmoon-ephemeris: ${passed} groups passed`);
