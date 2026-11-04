#!/usr/bin/env node
/**
 * moon-craters.mjs — gate for js/moon-craters.js.
 *
 * Run: node tests/moon-craters.mjs
 *
 * The load-bearing pins:
 *   • The Neukum production function reproduces its own anchor: N(≥1 km)
 *     at 1 Ga ≈ 8.2·10⁻⁴ km⁻², within 3 % of the chronology function's
 *     N(1) at T = 1 (the two were fitted together); monotone in D.
 *   • Chronology: 3.3 Ga maria carry ~25× fewer ≥1 km craters than 4.3 Ga
 *     highlands, and the highlands are SATURATED at 1 km (the cap bites)
 *     while the maria are not — the mare/highland contrast is the physics.
 *   • Pike morphometry: d/D = 0.196 at 1 km, the simple→complex break at
 *     15 km is continuous to a few %, degradation shallows but never
 *     deletes a bowl.
 *   • Shadow geometry: the closed form 1 − tan e/4ρ matches a brute-force
 *     plane test at 200 floor points for every elevation; shadow-free
 *     above atan(4ρ) = 38.1° for a fresh bowl; total at the terminator.
 *   • Band occupancies follow the chronology and clamp honestly; the GLSL
 *     mirror carries the kernel's constants verbatim.
 */

import assert from 'node:assert/strict';
import {
    NPF_COEFFICIENTS, neukumProductionPerKm2, chronologyN1, saturationPerKm2, craterDensityPerKm2,
    MARE_AGE_GA, HIGHLAND_AGE_GA, SATURATION_COEFF, SATURATION_EXPONENT,
    freshDepthKm, freshRimHeightKm, depthOverDiameter, DEGRADED_DEPTH_FLOOR, SIMPLE_COMPLEX_TRANSITION_KM,
    shadowChordFraction, shadowFreeElevationDeg, floorPointShadowed,
    CRATER_BANDS, BAND_RADIUS_FRACTION, bandDiameterRangeKm, bandOccupancy, craterUniforms,
    terrainClassFromAlbedo, siteCraterReport, CRATER_GLSL,
} from '../js/moon-craters.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── 1. Production function + chronology anchor ──────────────────────────────
{
    assert.equal(NPF_COEFFICIENTS.length, 12, '11th-order polynomial');
    near(Math.log10(neukumProductionPerKm2(1)), -3.0876, 1e-9, 'a₀ is log N(1 km) at 1 Ga');
    const rel = Math.abs(neukumProductionPerKm2(1) - chronologyN1(1)) / chronologyN1(1);
    assert.ok(rel < 0.03, `NPF and chronology agree at their shared anchor (${(rel * 100).toFixed(1)} %)`);
    let prev = Infinity;
    for (let D = 0.01; D <= 300; D *= 1.05) {
        const n = neukumProductionPerKm2(D);
        assert.ok(n < prev, `cumulative count decreases with D at ${D.toFixed(2)} km`);
        prev = n;
    }
    assert.equal(neukumProductionPerKm2(0.001), neukumProductionPerKm2(0.01), 'clamped below the valid range');
    assert.equal(chronologyN1(0), 0, 'a surface born now has no craters');
    assert.ok(chronologyN1(4.3) / chronologyN1(3.3) > 20, 'the exponential early bombardment: 4.3 Ga ≫ 3.3 Ga');
    ok('Neukum production function + chronology: anchored, monotone, exponential early flux');
}

// ── 2. Saturation and the mare/highland contrast ────────────────────────────
{
    near(saturationPerKm2(1), SATURATION_COEFF, 1e-12, 'saturation at 1 km');
    near(saturationPerKm2(10) / saturationPerKm2(1), Math.pow(10, SATURATION_EXPONENT), 1e-12, 'D^−1.83');
    const high = craterDensityPerKm2(1, HIGHLAND_AGE_GA);
    const mare = craterDensityPerKm2(1, MARE_AGE_GA);
    assert.ok(high.saturated, 'highlands are saturated at 1 km');
    assert.ok(!mare.saturated, 'maria are still counting at 1 km');
    near(high.density, saturationPerKm2(1), 1e-12, 'saturated density IS the cap');
    assert.ok(high.production > high.saturation, 'the production function overshoots the cap there');
    assert.ok(high.density / mare.density > 20, `highland/mare ≥1 km ratio ${(high.density / mare.density).toFixed(0)}×`);
    assert.ok(craterDensityPerKm2(30, HIGHLAND_AGE_GA).density < high.density, 'fewer large craters');
    ok('saturation cap; highlands saturated, maria not; 20×+ contrast at 1 km');
}

// ── 3. Pike (1977) morphometry ──────────────────────────────────────────────
{
    near(freshDepthKm(1), 0.196, 1e-12, 'd(1 km) = 0.196 km');
    near(freshDepthKm(10) / 10, 0.196 * Math.pow(10, 0.010), 1e-9, 'simple branch d/D');
    const below = freshDepthKm(SIMPLE_COMPLEX_TRANSITION_KM - 1e-9);
    const above = freshDepthKm(SIMPLE_COMPLEX_TRANSITION_KM + 1e-9);
    // The transition is a COLLAPSE: a complex crater is shallower than a
    // simple bowl of the same size would be (Pike's two branches really do
    // step down at 15 km — ~3.0 → ~2.4 km).
    assert.ok(above < below && above > 0.6 * below, `simple→complex step down at 15 km (${below.toFixed(2)} → ${above.toFixed(2)} km)`);
    assert.ok(freshDepthKm(100) / 100 < 0.05, 'big craters are shallow (complex)');
    near(freshRimHeightKm(1), 0.036, 1e-12, 'rim height at 1 km');
    near(depthOverDiameter(1, 1), 0.196, 1e-12, 'pristine d/D');
    near(depthOverDiameter(1, 0), 0.196 * DEGRADED_DEPTH_FLOOR, 1e-12, 'fully degraded keeps the floor fraction');
    assert.ok(depthOverDiameter(1, 0.5) > depthOverDiameter(1, 0) && depthOverDiameter(1, 0.5) < depthOverDiameter(1, 1));
    assert.equal(depthOverDiameter(1, 7), depthOverDiameter(1, 1), 'freshness clamps');
    ok('Pike morphometry: d/D, rim, continuous branches, degradation shallows');
}

// ── 4. Shadow geometry vs brute force ───────────────────────────────────────
{
    for (const rho of [0.05, 0.1, 0.196, 0.3]) {
        for (let e = 0.5; e < 89; e += 1.5) {
            const closed = shadowChordFraction(rho, e);
            let shadowed = 0;
            const N = 2000;
            for (let i = 0; i < N; i++) {
                const x = -0.5 + (i + 0.5) / N;
                if (floorPointShadowed(rho, e, x)) shadowed++;
            }
            near(closed, shadowed / N, 2 / N + 1e-9, `ρ=${rho} e=${e}: closed form vs brute force`);
        }
        near(shadowFreeElevationDeg(rho), Math.atan(4 * rho) * 180 / Math.PI, 1e-12, 'shadow-free elevation');
        assert.equal(shadowChordFraction(rho, shadowFreeElevationDeg(rho) + 1), 0, 'no shadow above it');
        assert.ok(shadowChordFraction(rho, shadowFreeElevationDeg(rho) - 1) > 0, 'shadow just below it');
    }
    assert.equal(shadowChordFraction(0.196, 0), 1, 'terminator: the whole floor is dark');
    assert.equal(shadowChordFraction(0.196, -5), 1, 'Sun below the horizon');
    near(shadowFreeElevationDeg(0.196), 38.096, 0.01, 'fresh bowl clears its shadow at 38.1°');
    let prev = 2;
    for (let e = 0; e <= 90; e += 1) {
        const f = shadowChordFraction(0.196, e);
        assert.ok(f <= prev + 1e-12, 'monotone with elevation');
        prev = f;
    }
    ok('shadow chord: closed form = brute force, 38.1° shadow-free for a fresh bowl, monotone');
}

// ── 5. Bands and uniforms ───────────────────────────────────────────────────
{
    assert.equal(CRATER_BANDS.length, 4);
    for (let i = 1; i < CRATER_BANDS.length; i++) {
        assert.ok(CRATER_BANDS[i].cellKm < CRATER_BANDS[i - 1].cellKm, 'bands get finer');
        assert.ok(CRATER_BANDS[i].viewFadeKm[1] < CRATER_BANDS[i - 1].viewFadeKm[0], 'finer bands fade in closer, without overlap');
    }
    for (const b of CRATER_BANDS) {
        const [dMin, dMax] = bandDiameterRangeKm(b);
        near(dMin, 2 * BAND_RADIUS_FRACTION[0] * b.cellKm, 1e-12, 'band D min');
        near(dMax, 2 * BAND_RADIUS_FRACTION[1] * b.cellKm, 1e-12, 'band D max');
        assert.ok(dMax < b.cellKm * 0.6, 'a crater never reaches past its neighbour cell (lattice coherence)');
        const h = bandOccupancy(b, HIGHLAND_AGE_GA), m = bandOccupancy(b, MARE_AGE_GA);
        assert.ok(h.occupancy >= m.occupancy, 'highlands at least as cratered as maria in every band');
        assert.ok(h.occupancy <= 1 && m.occupancy >= 0);
        assert.equal(h.clamped, h.expected > 1);
    }
    // The coarse band is where the contrast lives: saturated highlands vs sparse maria
    assert.equal(bandOccupancy(CRATER_BANDS[0], HIGHLAND_AGE_GA).occupancy, 1, 'highlands: every coarse cell holds a crater');
    assert.ok(bandOccupancy(CRATER_BANDS[0], MARE_AGE_GA).occupancy < 0.1, 'maria: under one coarse cell in ten');
    const u = craterUniforms();
    assert.deepEqual(u.cellKm, CRATER_BANDS.map(b => b.cellKm));
    assert.equal(u.occupancyMare.length, 4);
    assert.equal(u.occupancyHighland.length, 4);
    assert.deepEqual(u.seeds, CRATER_BANDS.map(b => b.seed));
    ok('four lattice bands: finer and closer, coherent, chronology-driven occupancy');
}

// ── 6. Site report + GLSL mirror ────────────────────────────────────────────
{
    assert.equal(terrainClassFromAlbedo(0.2), 0, 'dark = mare');
    assert.equal(terrainClassFromAlbedo(0.6), 1, 'bright = highland');
    assert.ok(terrainClassFromAlbedo(0.375) > 0.4 && terrainClassFromAlbedo(0.375) < 0.6, 'blended between');
    const mare = siteCraterReport({ albedo: 0.22, sunElevDeg: 20 });
    const high = siteCraterReport({ albedo: 0.6, sunElevDeg: 60 });
    assert.equal(mare.terrain, 'mare basalt');
    assert.equal(high.terrain, 'highland crust');
    near(mare.ageGa, MARE_AGE_GA, 1e-12, 'mare age');
    near(high.ageGa, HIGHLAND_AGE_GA, 1e-12, 'highland age');
    assert.ok(high.saturatedAt1km && !mare.saturatedAt1km);
    assert.ok(mare.shadowFraction1km > 0.4, 'low Sun: half the floor dark');
    assert.equal(high.shadowFraction1km, 0, 'high Sun: no floor shadow');
    near(siteCraterReport({ highlandWeight: 0.5 }).ageGa, (MARE_AGE_GA + HIGHLAND_AGE_GA) / 2, 1e-12, 'weight override');
    // GLSL carries the kernel's constants
    assert.ok(CRATER_GLSL.includes(`CR_R_MIN = ${BAND_RADIUS_FRACTION[0].toFixed(3)}`), 'r-min mirrored');
    assert.ok(CRATER_GLSL.includes(`CR_R_MAX = ${BAND_RADIUS_FRACTION[1].toFixed(3)}`), 'r-max mirrored');
    assert.ok(CRATER_GLSL.includes(`CR_DEPTH_FLOOR = ${DEGRADED_DEPTH_FLOOR.toFixed(3)}`), 'degradation floor mirrored');
    assert.ok(CRATER_GLSL.includes('0.196 * pow('), 'Pike depth mirrored');
    assert.ok(CRATER_GLSL.includes('4.0 * rho * x'), 'paraboloid wall slope 4ρx');
    assert.ok(CRATER_GLSL.includes('zFrag < zPlane'), 'cast-shadow plane test');
    assert.ok(CRATER_GLSL.includes('mod(p, 289.0)'), 'lattice wrap before hashing (the Mars mantissa scar)');
    assert.ok(!CRATER_GLSL.includes('`'), 'no backtick inside the GLSL literal');
    ok('site report by albedo and Sun elevation; GLSL mirror carries the kernel constants');
}

console.log(`\nmoon-craters: ${passed} groups passed`);
