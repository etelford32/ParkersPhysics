#!/usr/bin/env node
/**
 * moon-exosphere-model.mjs — gate for js/moon-exosphere-model.js.
 *
 * Run: node tests/moon-exosphere-model.mjs
 *
 * The load-bearing pins:
 *   • Everything derives from the INTERIOR kernel's gravity: escape speed
 *     ~2.37 km/s, and the exact identity λ_Jeans = R/H.
 *   • The escape hierarchy that explains the observations: H₂/He escape
 *     thermally in days; suprathermal Na/K sit in the tail-forming band
 *     (that is why the sodium tail exists); Ar/Ne are bound and die by
 *     photoionization instead.
 *   • Day/night shapes: non-condensables peak at NIGHT (n ∝ T^(-5/2)),
 *     condensable Ar peaks in the pre-dawn bulge, photon-made Na/K peak
 *     by DAY.
 *   • The whole atmosphere weighs of order tonnes — thin enough that the
 *     word "exosphere" is doing all the work.
 *   • Sodium sources sum to exactly 1 at quiet; the magnetotail removes
 *     (nearly all of) the sputtering share; showers boost only the
 *     impact channel; Geminids peak ≈ ×3 on that channel.
 *   • The magnetotail window is ~4 days centred on full moon, periodic.
 */

import assert from 'node:assert/strict';
import { R_MOON_KM } from '../js/moon-interior-model.js';
import {
    SURFACE_G_MS2, ESCAPE_V_MS, DAY_K, NIGHT_K,
    SPECIES, scaleHeightKm, jeansLambda, escapeRegime, speciesProfile,
    totalMassKg,
    QUIET_SODIUM_FRACTIONS, TAIL_SPUTTER_RESIDUAL, sodiumSources,
    SODIUM_PHOTOION_LIFETIME_HR,
    SYNODIC_MONTH_DAYS, FULL_MOON_AGE_DAYS, inMagnetotail,
    METEOR_SHOWERS, impactVaporBoost, activeShower,
    surfaceTemperatureK, effectivePoolingExponent, localDensityCm3, HODGES_EXPONENT,
    SUNRISE_RELEASE_HOUR, hopProfile, thermalSpeedMS, hopHeightKm, hopTimeS, residenceTimeS,
} from '../js/moon-exosphere-model.js';

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };
const near = (a, b, tol, msg) =>
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`);

// ── 1. Derived from the interior kernel's gravity ────────────────────────────
{
    near(SURFACE_G_MS2, 1.62, 0.02, 'gravity inherited from interior kernel');
    near(ESCAPE_V_MS, 2372, 15, 'escape speed √(2gR) ≈ 2.37 km/s');
    // λ = R/H exactly, for any species/temperature
    for (const s of SPECIES) {
        for (const tK of [NIGHT_K, DAY_K, 1200]) {
            const lam = jeansLambda(s.amu, tK);
            const rOverH = R_MOON_KM / scaleHeightKm(s.amu, tK);
            assert.ok(Math.abs(lam - rOverH) / lam < 1e-12,
                `λ = R/H identity for ${s.key} at ${tK} K`);
        }
    }
    ok('escape speed and the exact λ = R/H identity');
}

// ── 2. Scale heights: light is puffy ─────────────────────────────────────────
{
    const hHe = scaleHeightKm(4.0026, DAY_K);
    const hAr = scaleHeightKm(39.96, DAY_K);
    assert.ok(hHe > 400 && hHe < 600, `He day scale height ~500 km (got ${hHe.toFixed(0)})`);
    assert.ok(hAr > 40 && hAr < 60, `Ar day scale height ~50 km (got ${hAr.toFixed(0)})`);
    assert.ok(hHe / hAr > 9 && hHe / hAr < 11, 'mass ratio sets the puffiness ratio');
    // Suprathermal Na is far puffier than thermal Na — the PSD signature
    const naPSD = scaleHeightKm(22.99, 1200);
    const naTh = scaleHeightKm(22.99, DAY_K);
    assert.ok(naPSD / naTh > 2.5, 'PSD sodium ~3× puffier than thermalized sodium');
    ok(`scale heights: He ${hHe.toFixed(0)} km, Ar ${hAr.toFixed(0)} km, Na(PSD) ${naPSD.toFixed(0)} km`);
}

// ── 3. The escape hierarchy that explains the observations ───────────────────
{
    const p = Object.fromEntries(SPECIES.map(s => [s.key, speciesProfile(s.key)]));
    assert.equal(p.h2.regime, 'escapes in days', 'H₂ escapes thermally');
    assert.equal(p.he.regime, 'escapes in days', 'He escapes thermally');
    assert.equal(p.na.regime, 'partial escape — feeds the tail', 'suprathermal Na feeds the tail');
    assert.equal(p.k.regime, 'partial escape — feeds the tail', 'suprathermal K feeds the (fainter) tail');
    assert.equal(p.ar.regime, 'bound (lost by photoionization)', 'Ar bound; ionization is its sink');
    assert.equal(p.ne.regime, 'bound (lost by photoionization)', 'Ne bound; ionization is its sink');
    assert.ok(p.na.lambda > 4 && p.na.lambda < 10, `Na λ ≈ 6.5 (got ${p.na.lambda.toFixed(1)})`);
    assert.equal(speciesProfile('nope'), null, 'unknown species → null');
    ok('escape regimes: H₂/He gone in days, Na/K tail-forming, Ar/Ne ionization-bound');
}

// ── 4. Day/night shapes ──────────────────────────────────────────────────────
{
    for (const s of SPECIES) {
        assert.ok(s.dayCm3 > 0 && s.nightCm3 > 0, `${s.key} densities positive`);
        if (s.condensable) {
            assert.ok(s.sunriseCm3 > s.dayCm3 && s.dayCm3 > s.nightCm3,
                `${s.key}: pre-dawn bulge > day > (condensed) night`);
        } else if (s.suprathermalK) {
            assert.ok(s.dayCm3 > s.nightCm3, `${s.key}: photon-made, dayside`);
        } else {
            assert.ok(s.nightCm3 > s.dayCm3, `${s.key}: non-condensable concentrates at night`);
        }
    }
    // Night total ~10⁵ cm⁻³, day total ~10⁴ — the canonical figures
    const nightTot = SPECIES.reduce((a, s) => a + s.nightCm3, 0);
    const dayTot = SPECIES.reduce((a, s) => a + s.dayCm3, 0);
    assert.ok(nightTot > 5e4 && nightTot < 5e5, `night total ~10⁵ cm⁻³ (got ${nightTot.toExponential(1)})`);
    assert.ok(dayTot > 5e3 && dayTot < 5e4, `day total ~10⁴ cm⁻³ (got ${dayTot.toExponential(1)})`);
    ok('LACE/LADEE day-night shapes; totals at the canonical orders');
}

// ── 5. The whole atmosphere weighs tonnes ────────────────────────────────────
{
    const m = totalMassKg();
    assert.ok(m > 1e3 && m < 1e5, `total mass in the 1–100 t band (got ${(m / 1e3).toFixed(1)} t)`);
    ok(`total gas aloft ≈ ${(m / 1e3).toFixed(1)} tonnes`);
}

// ── 6. Sodium sources: quiet, tail, showers ──────────────────────────────────
{
    const F = QUIET_SODIUM_FRACTIONS;
    near(F.psd + F.sputter + F.impact, 1, 1e-12, 'quiet fractions sum to exactly 1');
    near(sodiumSources().total, 1, 1e-12, 'quiet total is exactly 1');

    const tail = sodiumSources({ inTail: true });
    near(tail.total, 1 - F.sputter * (1 - TAIL_SPUTTER_RESIDUAL), 1e-12,
        'magnetotail removes the free-solar-wind sputtering share');
    assert.ok(tail.total < 1, 'tail passage dims the sodium source');
    near(tail.psd, F.psd, 1e-12, 'PSD unaffected by the tail (sunlight still arrives)');

    const storm = sodiumSources({ swFactor: 3 });
    assert.ok(storm.total > 1 && storm.sputter === F.sputter * 3, 'solar-wind storm boosts sputtering only');

    const shower = sodiumSources({ showerBoost: 3 });
    near(shower.total, 1 + F.impact * 2, 1e-12, 'shower boosts only the impact channel');

    assert.ok(SODIUM_PHOTOION_LIFETIME_HR > 12 && SODIUM_PHOTOION_LIFETIME_HR < 120,
        'photoionization lifetime in the quiet-Sun literature band');
    ok('sodium source budget: partitioned, tail-aware, shower-aware');
}

// ── 7. Magnetotail window ────────────────────────────────────────────────────
{
    assert.ok(inMagnetotail(FULL_MOON_AGE_DAYS), 'inside at full moon');
    assert.ok(inMagnetotail(FULL_MOON_AGE_DAYS + 1.9), 'inside near window edge');
    assert.ok(!inMagnetotail(FULL_MOON_AGE_DAYS + 2.1), 'outside past window edge');
    assert.ok(!inMagnetotail(0), 'outside at new moon');
    assert.ok(!inMagnetotail(7.4), 'outside at first quarter');
    assert.equal(inMagnetotail(FULL_MOON_AGE_DAYS + SYNODIC_MONTH_DAYS),
        inMagnetotail(FULL_MOON_AGE_DAYS), 'periodic in the synodic month');
    assert.equal(inMagnetotail(-SYNODIC_MONTH_DAYS / 2), true, 'negative ages wrap');
    ok('magnetotail: ~4-day window centred on full moon, periodic');
}

// ── 8. Meteor shower calendar ────────────────────────────────────────────────
{
    assert.equal(METEOR_SHOWERS.length, 7, 'seven annual showers');
    const geminids = impactVaporBoost(Date.UTC(2026, 11, 14));
    assert.ok(geminids >= 2.8, `Geminids peak ≈ ×3 (got ${geminids.toFixed(2)})`);
    const quiet = impactVaporBoost(Date.UTC(2026, 2, 20));   // Mar 20 — no shower near
    near(quiet, 1, 0.02, 'quiet date ≈ ×1');
    const leonids = impactVaporBoost(Date.UTC(2026, 10, 17));
    assert.ok(leonids >= 2.3, `Leonids peak ≈ ×2.5 (got ${leonids.toFixed(2)})`);
    // Boost decays away from the peak, symmetric-ish
    assert.ok(impactVaporBoost(Date.UTC(2026, 11, 14)) > impactVaporBoost(Date.UTC(2026, 11, 20)),
        'boost decays after the peak');
    // Date object input accepted
    near(impactVaporBoost(new Date(Date.UTC(2026, 2, 20))), quiet, 1e-12, 'Date input = ms input');
    // activeShower names the nearest peak
    assert.equal(activeShower(Date.UTC(2026, 11, 14)).name, 'Geminids', 'activeShower finds Geminids');
    assert.ok(activeShower(Date.UTC(2026, 2, 20)).contrib < 0.02, 'quiet date: negligible contribution');
    ok('shower calendar: Geminids ×3, Leonids ×2.5, quiet dates ×1');
}

// ── 9. Surface temperature map and the T^(−5/2) pooling ─────────────────────
{
    near(surfaceTemperatureK(0), DAY_K, 1e-9, 'sub-solar temperature');
    near(surfaceTemperatureK(60), DAY_K * Math.pow(0.5, 0.25), 1e-9, 'radiative cos^{1/4} law at 60°');
    assert.equal(surfaceTemperatureK(90), NIGHT_K, 'terminator at the night floor');
    assert.equal(surfaceTemperatureK(150), NIGHT_K, 'deep night');
    let prev = Infinity;
    for (let chi = 0; chi <= 180; chi += 1) {
        const T = surfaceTemperatureK(chi);
        assert.ok(T <= prev + 1e-9, 'monotone decreasing with zenith angle');
        prev = T;
    }
    // The species table's own day/night ratios imply exponents near Hodges' 5/2
    for (const k of ['he', 'ne', 'h2']) {
        const g = effectivePoolingExponent(k);
        assert.ok(g > 1.5 && g < 3.0, `${k}: effective pooling exponent ${g.toFixed(2)} near ${HODGES_EXPONENT}`);
    }
    assert.ok(Number.isNaN(effectivePoolingExponent('ar')), 'no pooling exponent for a condensable');
    assert.ok(Number.isNaN(effectivePoolingExponent('na')), 'nor for a suprathermal species');
    ok('surface temperature map; table day/night ratios imply Hodges-class exponents');
}

// ── 10. Local density per species: anchored on the table at both ends ───────
{
    for (const k of ['he', 'ne', 'h2']) {
        const s = SPECIES.find(x => x.key === k);
        near(localDensityCm3(k, 0, 12), s.dayCm3, 1e-6, `${k} noon = table day value`);
        near(localDensityCm3(k, 180, 0), s.nightCm3, 1e-6, `${k} deep night = table night value`);
        assert.ok(localDensityCm3(k, 60, 12) > s.dayCm3, 'pools as the ground cools toward the terminator');
    }
    const ar = SPECIES.find(x => x.key === 'ar');
    near(localDensityCm3('ar', 30, 12), ar.dayCm3, 1e-6, 'argon by day');
    assert.ok(localDensityCm3('ar', 120, 0) < ar.dayCm3, 'argon depleted at midnight');
    assert.ok(localDensityCm3('ar', 120, 0) >= ar.nightCm3, '…but never below the night floor');
    const peak = localDensityCm3('ar', 95, SUNRISE_RELEASE_HOUR);
    assert.ok(peak > 0.9 * ar.sunriseCm3 && peak < 1.2 * ar.sunriseCm3, `pre-dawn bulge peaks at the LACE value (${peak.toExponential(2)})`);
    assert.ok(peak > localDensityCm3('ar', 120, 2), 'the bulge is the night maximum');
    assert.ok(localDensityCm3('ar', 60, 9) < 0.5 * peak, 'and it has drained by mid-morning');
    const na = SPECIES.find(x => x.key === 'na');
    near(localDensityCm3('na', 0, 12), na.dayCm3, 1e-9, 'Na noon');
    near(localDensityCm3('na', 60, 12), na.nightCm3 + (na.dayCm3 - na.nightCm3) * 0.5, 1e-9, 'Na ∝ cos χ');
    near(localDensityCm3('na', 120, 0), na.nightCm3, 1e-9, 'Na night floor');
    assert.ok(Number.isNaN(localDensityCm3('xe', 0, 12)), 'unknown species → NaN');
    ok('local density: thermal pooling, argon dawn release, dayside sodium — all anchored on the table');
}

// ── 11. Hop kinematics: the scale-height identity ───────────────────────────
{
    for (const [amu, T] of [[4.0026, 100], [22.99, 1200], [2.016, 390], [39.96, 250]]) {
        const h = hopProfile(amu, T);
        near(h.heightKm, scaleHeightKm(amu, T), 1e-9, 'apex of a most-probable-speed launch = scale height');
        near(h.timeS, 2 * thermalSpeedMS(amu, T) / SURFACE_G_MS2, 1e-9, 'flight time 2v/g');
        near(h.rangeKm, 2 * h.heightKm, 1e-9, '45° range = 2 × apex');
        assert.equal(h.escapes, thermalSpeedMS(amu, T) >= ESCAPE_V_MS);
    }
    near(hopHeightKm(1000), 1e6 / (2 * SURFACE_G_MS2) / 1e3, 1e-9, 'v²/2g');
    near(hopTimeS(1000), 2000 / SURFACE_G_MS2, 1e-9, '2v/g');
    assert.ok(hopProfile(22.99, 1200).heightKm > 200, 'suprathermal sodium hops hundreds of km');
    assert.ok(hopProfile(4.0026, 100).heightKm < 150, 'cold helium stays low');
    // Adsorption residence: Arrhenius, days below 100 K, sub-second above 150 K
    assert.ok(residenceTimeS(100) > 86400, 'adsorbed for days at 100 K');
    assert.ok(residenceTimeS(150) < 1, 'free within a second at 150 K');
    for (let T = 60; T < 400; T += 5) assert.ok(residenceTimeS(T) > residenceTimeS(T + 5), 'monotone in T');
    ok('hop kinematics: apex = H identity, 2v/g, Arrhenius residence');
}

console.log(`\nmoon-exosphere-model: ${passed} groups passed`);
