/**
 * upper-atmosphere-column.mjs — gate for the atmosphere FIELD + COLUMN kernel
 * ═══════════════════════════════════════════════════════════════════════════
 * Run: node tests/upper-atmosphere-column.mjs
 *
 * What this actually protects (each of these is a claim the page makes on
 * screen, so a failure here means the page is lying):
 *
 *   1. MEAN PRESERVATION. Turning the spatial field on must not move the
 *      global numbers the page already reports. Both spatial terms are
 *      area-mean-preserving by construction; this is the test that keeps
 *      them that way. A future session that "improves" the bulge by
 *      scaling it up will fail here, which is the point.
 *   2. THE BULGE LAGS. Jacchia's −37° hour-angle term puts the maximum at
 *      ~14 LST, not at noon. That lag is the physics; a symmetric bulge
 *      would be a cosine, not a thermosphere.
 *   3. THE COLUMN IS RIGHT. The numerical ray integral is checked against
 *      the analytic Chapman limb path √(2πrH), which is an independent
 *      derivation. This is what makes limb brightening honest instead of
 *      a tuned glow.
 *   4. QUADRATIC SAMPLING EARNS ITS KEEP. Pinned against uniform sampling
 *      so nobody "simplifies" the node spacing back to linear.
 */

import assert from 'node:assert/strict';
import {
    jacchiaDiurnalRatio, diurnalMeanRatio, diurnalFactor,
    auroralHeatingRawK, auroralHeatingK, auroralMeanK,
    magneticLatitude, exosphereTempField, densityFieldAt,
    airglowAt, AIRGLOW_LAYERS, rayColumn, limbPathEquivalentKm,
    airglowColumn, buildAtmosphereLUT, probeProfile,
    tangentAltitudeKm, localSolarTime, bulgeLocalSolarTime,
    diurnalContrast, R_EARTH_KM, MODEL_FLOOR_KM, MODEL_CEIL_KM,
} from '../js/upper-atmosphere-column.js';
import { density, exosphereTempK } from '../js/upper-atmosphere-engine.js';

let pass = 0, fail = 0;
function t(name, fn) {
    try { fn(); pass++; console.log(`  ✓ ${name}`); }
    catch (e) { fail++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}
const DEG = Math.PI / 180;

// Area-weighted global mean of any f(lat, lst) on the sphere.
function areaMean(f, nLat = 180, nLst = 96) {
    let num = 0, den = 0;
    for (let i = 0; i < nLat; i++) {
        const lat = -90 + (i + 0.5) * (180 / nLat);
        const w = Math.cos(lat * DEG);
        for (let j = 0; j < nLst; j++) {
            num += w * f(lat, (j + 0.5) * (24 / nLst));
            den += w;
        }
    }
    return num / den;
}

console.log('\n── 1. engine TinfK override is transparent ──');

t('density() without TinfK is unchanged', () => {
    const a = density({ altitudeKm: 400, f107Sfu: 150, ap: 15 });
    const b = density({ altitudeKm: 400, f107Sfu: 150, ap: 15, TinfK: null });
    assert.equal(a.rho, b.rho);
    assert.equal(a.T, b.T);
});

t('density(TinfK = exosphereTempK(...)) reproduces the default exactly', () => {
    for (const [f, ap] of [[70, 0], [150, 15], [230, 180], [300, 400]]) {
        const dflt = density({ altitudeKm: 420, f107Sfu: f, ap });
        const over = density({
            altitudeKm: 420, f107Sfu: f, ap, TinfK: exosphereTempK(f, ap),
        });
        assert.equal(over.rho, dflt.rho, `f107=${f} ap=${ap}`);
    }
});

t('a higher T∞ inflates the thermosphere (density rises at 400 km)', () => {
    const cool = density({ altitudeKm: 400, f107Sfu: 150, ap: 15, TinfK: 900 });
    const warm = density({ altitudeKm: 400, f107Sfu: 150, ap: 15, TinfK: 1400 });
    assert.ok(warm.rho > cool.rho * 1.5,
        `expected clear inflation, got ${(warm.rho / cool.rho).toFixed(2)}×`);
});

console.log('\n── 2. Jacchia diurnal ratio ──');

t('ratio never dips below 1 — T_c IS the night minimum', () => {
    // This is the τ-wrap gate. Unwrapped, τ runs past −180° near local
    // midnight, cos³(τ/2) goes negative and the night side comes out
    // COLDER than T_c — which contradicts the definition of T_c and
    // inverts the pre-dawn minimum. Measured before the fix: 0.9953 at
    // lat −40°, LST 0 h, decl 23.44°.
    let worst = Infinity, where = null;
    for (let lat = -90; lat <= 90; lat += 2) {
        for (let lst = 0; lst < 24; lst += 0.25) {
            for (const decl of [-23.44, -12, 0, 12, 23.44]) {
                const r = jacchiaDiurnalRatio(lat, lst, decl);
                assert.ok(r <= 1.3001,
                    `ratio ${r} above the 1.3 ceiling at lat=${lat} lst=${lst}`);
                if (r < worst) { worst = r; where = { lat, lst, decl }; }
            }
        }
    }
    assert.ok(worst >= 1 - 1e-12,
        `minimum ratio ${worst.toFixed(6)} < 1 at ${JSON.stringify(where)} — `
      + `τ is not being wrapped into (−180°, 180°].`);
});

t('THE BULGE LAGS THE SUN — max sits at ~14 LST, not 12', () => {
    const lstMax = bulgeLocalSolarTime(0, 0);
    assert.ok(lstMax > 13 && lstMax < 15.5,
        `bulge peak at ${lstMax.toFixed(2)} h — expected ~14 h. `
      + `If this drifted to 12 the −37° hour-angle term was dropped.`);
});

t('minimum sits pre-dawn at ~2.9 h LST and touches exactly 1.0', () => {
    let worst = Infinity, worstL = null;
    for (let lst = 0; lst < 24; lst += 0.01) {
        const v = jacchiaDiurnalRatio(0, lst, 0);
        if (v < worst) { worst = v; worstL = lst; }
    }
    assert.ok(worstL > 2 && worstL < 4,
        `minimum at ${worstL.toFixed(2)} h — expected ~2.9 h (the hour angle `
      + `where τ reaches −180° and cos(τ/2) vanishes)`);
    assert.ok(Math.abs(worst - 1) < 1e-6,
        `minimum ratio ${worst} — should touch T_c exactly`);
});

t('MEAN PRESERVING: area mean of diurnalFactor is 1.0', () => {
    for (const decl of [-23.44, -10, 0, 12, 23.44]) {
        const m = areaMean((lat, lst) => diurnalFactor(lat, lst, decl));
        assert.ok(Math.abs(m - 1) < 2e-3,
            `decl=${decl}: mean ${m.toFixed(6)} ≠ 1. The T∞ field must not `
          + `move the page's global numbers.`);
    }
});

t('diurnalMeanRatio caches without changing its answer', () => {
    const a = diurnalMeanRatio(11.3);
    const b = diurnalMeanRatio(11.3);
    assert.equal(a, b);
    assert.ok(a > 1.0 && a < 1.3);
});

console.log('\n── 3. auroral redistribution ──');

t('raw heating peaks at the statistical oval, both hemispheres', () => {
    const at67 = auroralHeatingRawK(67, 200);
    assert.ok(at67 > auroralHeatingRawK(0, 200) * 50, 'oval must dominate the equator');
    assert.ok(at67 > auroralHeatingRawK(90, 200), 'oval, not the pole');
    assert.ok(Math.abs(auroralHeatingRawK(-67, 200) - at67) < 1e-9,
        'both ovals heat equally');
});

t('heating saturates in Ap rather than growing without bound', () => {
    const g5   = auroralHeatingRawK(67, 400);
    const g5x2 = auroralHeatingRawK(67, 800);
    assert.ok(g5 > 250, `G5 peak ΔT∞ ${g5.toFixed(0)} K — expected > 250 K`);
    assert.ok(g5x2 / g5 < 1.25, 'must saturate, not scale linearly');
});

t('ZERO MEAN: the auroral term redistributes, it does not add', () => {
    for (const ap of [0, 15, 80, 200, 400]) {
        const m = areaMean((lat) => auroralHeatingK(lat, ap), 720, 1);
        assert.ok(Math.abs(m) < 0.5,
            `ap=${ap}: mean ΔT∞ ${m.toFixed(3)} K ≠ 0. The engine's 3·Ap `
          + `term already carries the GLOBAL Ap response — a second one `
          + `here double-counts it.`);
    }
});

t('quiet time still has some auroral structure', () => {
    assert.ok(auroralHeatingRawK(67, 15) > 20, 'Joule heating never fully stops');
});

console.log('\n── 4. magnetic latitude (dipole coordinate, not a field value) ──');

t('dipole pole maps to +90° magnetic latitude', () => {
    assert.ok(Math.abs(magneticLatitude(80.65, -72.68) - 90) < 1e-6);
});

t('magnetic latitude is offset from geographic — that is the whole point', () => {
    // Northern Europe sits at lower magnetic latitude than Hudson Bay at
    // the same geographic latitude; this asymmetry is what puts the oval
    // over Canada rather than on a parallel.
    const hudson = magneticLatitude(60, -85);
    const norway = magneticLatitude(60, 10);
    assert.ok(hudson > norway + 5,
        `Hudson Bay (${hudson.toFixed(1)}°) should be well poleward of `
      + `Norway (${norway.toFixed(1)}°) magnetically`);
});

t('stays inside ±90', () => {
    for (let lat = -90; lat <= 90; lat += 7) {
        for (let lon = -180; lon < 180; lon += 13) {
            const m = magneticLatitude(lat, lon);
            assert.ok(m >= -90.001 && m <= 90.001, `${m} at ${lat},${lon}`);
        }
    }
});

console.log('\n── 5. the T∞ field and the density field ──');

t('MEAN PRESERVING end-to-end: field T∞ averages to exosphereTempK', () => {
    for (const [f107, ap] of [[150, 15], [230, 400], [70, 0]]) {
        const m = areaMean((lat, lst) => exosphereTempField({
            latDeg: lat, lonDeg: 0, localSolarTimeHr: lst,
            sunDeclDeg: 0, f107Sfu: f107, ap,
        }).Tinf);
        const want = exosphereTempK(f107, ap);
        assert.ok(Math.abs(m - want) / want < 5e-3,
            `f107=${f107} ap=${ap}: field mean ${m.toFixed(1)} K vs global `
          + `${want.toFixed(1)} K`);
    }
});

t('afternoon bulge is denser than pre-dawn at 400 km', () => {
    const c = diurnalContrast({ altKm: 400, latDeg: 0, sunDeclDeg: 0 });
    assert.ok(c.ratio > 1.5,
        `day/night ρ ratio ${c.ratio.toFixed(2)} — the observed thermospheric `
      + `contrast at 400 km is a factor of a few`);
    assert.ok(c.ratio < 12, `ratio ${c.ratio.toFixed(2)} implausibly large`);
});

t('the contrast GROWS with altitude (it is a temperature effect)', () => {
    const lo = diurnalContrast({ altKm: 200, latDeg: 0 }).ratio;
    const hi = diurnalContrast({ altKm: 600, latDeg: 0 }).ratio;
    assert.ok(hi > lo,
        `contrast must grow with altitude: 200 km ${lo.toFixed(2)} → `
      + `600 km ${hi.toFixed(2)}`);
});

t('rhoRatio is the local drag multiplier against the global model', () => {
    const hot = densityFieldAt({
        altKm: 400, latDeg: 0, localSolarTimeHr: 14, sunDeclDeg: 0,
        f107Sfu: 150, ap: 15,
    });
    const cold = densityFieldAt({
        altKm: 400, latDeg: 0, localSolarTimeHr: 4, sunDeclDeg: 0,
        f107Sfu: 150, ap: 15,
    });
    assert.ok(hot.rhoRatio > 1 && cold.rhoRatio < 1,
        `afternoon ${hot.rhoRatio.toFixed(2)}× / pre-dawn `
      + `${cold.rhoRatio.toFixed(2)}× must straddle 1`);
    assert.ok(Math.abs(hot.rho / hot.rhoGlobal - hot.rhoRatio) < 1e-12);
});

t('the ISOLATED auroral term inflates the oval at 400 km', () => {
    // rhoRatio carries the diurnal factor too, so read the auroral term on
    // its own: same point, same global T∞, ΔT∞ switched off and on.
    const isolate = (ap) => {
        const Tg = exosphereTempK(150, ap);
        const dT = auroralHeatingRawK(67, ap);
        const off = density({ altitudeKm: 400, f107Sfu: 150, ap, TinfK: Tg });
        const on  = density({ altitudeKm: 400, f107Sfu: 150, ap, TinfK: Tg + dT });
        return on.rho / off.rho;
    };
    assert.ok(isolate(15) < 1.3, `quiet-time oval should be near-neutral, got ${isolate(15).toFixed(2)}×`);
    assert.ok(isolate(200) > 1.5,
        `strong-storm auroral enhancement ${isolate(200).toFixed(2)}× — the `
      + `Gannon-anchored target is ~1.6–1.7×`);
    assert.ok(isolate(400) > 1.4, `G5 oval enhancement ${isolate(400).toFixed(2)}×`);
    // The contrast RELAXES at extreme Ap while absolute density keeps
    // climbing — the scale height grows with T∞ so heating loses leverage.
    // Documented in the module header; asserted here so nobody "fixes" it.
    assert.ok(isolate(400) < isolate(200),
        'auroral-to-global contrast should ease at extreme Ap (scale-height '
      + 'saturation), even though absolute density keeps rising');
    const absQuiet = density({ altitudeKm: 400, f107Sfu: 150, ap: 200 }).rho;
    const absStorm = density({ altitudeKm: 400, f107Sfu: 150, ap: 400 }).rho;
    assert.ok(absStorm > absQuiet, 'absolute density must still rise with Ap');
});

t('the oval is denser than the equator at matched local time', () => {
    const at = (lat, lon) => densityFieldAt({
        altKm: 400, latDeg: lat, lonDeg: lon, localSolarTimeHr: 22,
        sunDeclDeg: 0, f107Sfu: 150, ap: 300,
    });
    const oval = at(67, -90);      // over Hudson Bay: high magnetic latitude
    const eq   = at(0, -90);
    assert.ok(oval.rho > eq.rho,
        `night-side oval (${oval.rho.toExponential(2)}) should exceed the `
      + `night-side equator (${eq.rho.toExponential(2)}) during a storm`);
    assert.ok(oval.auroralK > 200, `oval ΔT∞ ${oval.auroralK.toFixed(0)} K`);
    assert.ok(eq.auroralK < 0, 'the zero-mean term must be negative off-oval');
});

console.log('\n── 6. airglow ──');

t('green line peaks at 97 km and is sharp', () => {
    const peak = airglowAt(97).byLayer['o-green'];
    assert.ok(peak > airglowAt(70).byLayer['o-green'] * 100);
    assert.ok(peak > airglowAt(130).byLayer['o-green'] * 100);
});

t('the visible airglow band sits at 85–100 km', () => {
    let best = 0, bestAlt = 0;
    for (let h = 80; h <= 2000; h += 1) {
        const v = airglowAt(h, { visibleOnly: true }).total;
        if (v > best) { best = v; bestAlt = h; }
    }
    assert.ok(bestAlt >= 85 && bestAlt <= 100,
        `visible airglow peak at ${bestAlt} km — expected the 85–100 km band`);
});

t('red line is broad and much fainter than the band below it', () => {
    const red = AIRGLOW_LAYERS.find(l => l.id === 'o-red');
    assert.ok(red.fwhmKm > 50, 'the F-region red line is broad');
    assert.ok(airglowAt(250).total < airglowAt(90).total,
        'the 250 km glow must be far fainter than the 90 km band');
});

t('every non-visible layer is flagged so consumers can disclose false colour', () => {
    const uv = AIRGLOW_LAYERS.find(l => l.id === 'geocorona');
    assert.equal(uv.visible, false);
    assert.match(uv.note, /FALSE COLOUR/i,
        'the geocorona note must say the colour is invented');
    for (const L of AIRGLOW_LAYERS) {
        assert.equal(typeof L.visible, 'boolean', `${L.id} missing visible flag`);
    }
});

t('visibleOnly drops the UV/IR layers', () => {
    assert.ok(airglowAt(1400, { visibleOnly: true }).total
            < airglowAt(1400).total,
        'the geocorona must vanish from the visible-only sum');
});

t('storm brightens the aurorally-coupled lines and leaves OH alone', () => {
    const quiet = airglowAt(97, { ap: 5 });
    const storm = airglowAt(97, { ap: 400 });
    assert.ok(storm.byLayer['o-green'] > quiet.byLayer['o-green'] * 1.5);
    assert.equal(airglowAt(87, { ap: 400 }).byLayer['oh-meinel'],
                 airglowAt(87, { ap: 5 }).byLayer['oh-meinel']);
});

console.log('\n── 7. the column integral — why the limb is bright ──');

t('tangent altitude geometry', () => {
    // Looking straight down from 500 km: tangent altitude is the sub-point.
    assert.ok(Math.abs(tangentAltitudeKm(500, 0) + R_EARTH_KM) < 1e-6);
    // Grazing angle from 500 km that just touches the surface.
    const graze = Math.asin(R_EARTH_KM / (R_EARTH_KM + 500));
    assert.ok(Math.abs(tangentAltitudeKm(500, graze)) < 1e-6);
    // Looking further off-axis than the grazing angle → above the limb.
    assert.ok(tangentAltitudeKm(500, graze + 0.05) > 0);
});

t('NUMERICAL COLUMN ≈ ANALYTIC CHAPMAN √(2πrH)', () => {
    for (const h of [150, 250, 400, 700, 1100]) {
        const num = rayColumn({ tangentAltKm: h, f107Sfu: 150, ap: 15 });
        const ana = limbPathEquivalentKm(h, { f107Sfu: 150, ap: 15 });
        const err = Math.abs(num.pathEquivKm - ana) / ana;
        assert.ok(err < 0.15,
            `${h} km: numeric ${num.pathEquivKm.toFixed(0)} km vs Chapman `
          + `${ana.toFixed(0)} km — ${(err * 100).toFixed(1)}% apart. These `
          + `are independent derivations; a large gap means the sampling or `
          + `the geometry is wrong.`);
    }
});

t('LIMB BRIGHTENING IS REAL: a 400 km limb ray carries ~10³ km of atmosphere', () => {
    const p = limbPathEquivalentKm(400);
    assert.ok(p > 900 && p < 2600,
        `limb path equivalent ${p.toFixed(0)} km — this factor over the local `
      + `scale height IS the bright band on the limb`);
    const rec = density({ altitudeKm: 400, f107Sfu: 150, ap: 15 });
    assert.ok(p / rec.H_km > 15,
        `limb ray should traverse well over 15 scale heights, got `
      + `${(p / rec.H_km).toFixed(1)}`);
});

t('column falls monotonically with tangent altitude', () => {
    let prev = Infinity;
    for (let h = 100; h <= 1500; h += 100) {
        const c = rayColumn({ tangentAltKm: h }).columnKgM2;
        assert.ok(c < prev, `column rose from ${h - 100} to ${h} km`);
        prev = c;
    }
});

t('UNIFORM SAMPLING BEATS IMPORTANCE SAMPLING — measured, do not "optimise"', () => {
    // Euler-Maclaurin: the integrand decays smoothly to zero at both ends,
    // so equally spaced trapezoid loses its boundary terms and converges
    // superalgebraically. Quadratic spacing about the tangent point looks
    // like textbook importance sampling for an exponential integrand and
    // is 1-2 orders of magnitude WORSE. This test is the receipt.
    for (const hT of [90, 400]) {
        const ref = rayColumn({ tangentAltKm: hT, steps: 6000 }).columnKgM2;
        const uni = rayColumn({ tangentAltKm: hT, steps: 64 }).columnKgM2;
        const uErr = Math.abs(uni - ref) / ref;

        // Same node count, spaced quadratically about the tangent point.
        const rT = R_EARTH_KM + hT, rC = R_EARTH_KM + MODEL_CEIL_KM;
        const sMax = Math.sqrt(rC * rC - rT * rT);
        let acc = 0, sPrev = 0;
        let rhoPrev = density({ altitudeKm: hT, f107Sfu: 150, ap: 15 }).rho;
        for (let i = 1; i <= 64; i++) {
            const f = i / 64;
            const s = sMax * f * f;
            const h = Math.sqrt(rT * rT + s * s) - R_EARTH_KM;
            const rho = density({
                altitudeKm: Math.min(Math.max(h, MODEL_FLOOR_KM), MODEL_CEIL_KM),
                f107Sfu: 150, ap: 15,
            }).rho;
            acc += 0.5 * (rho + rhoPrev) * (s - sPrev);
            sPrev = s; rhoPrev = rho;
        }
        const qErr = Math.abs(2 * acc * 1000 - ref) / ref;

        assert.ok(uErr < 0.001,
            `${hT} km: uniform 64-step is ${(uErr * 100).toFixed(3)}% off — `
          + `expected better than 0.1%`);
        assert.ok(uErr < qErr,
            `${hT} km: uniform (${(uErr * 100).toFixed(3)}%) must beat `
          + `quadratic (${(qErr * 100).toFixed(3)}%)`);
    }
});

t('64 steps is enough — doubling changes the column by < 0.1%', () => {
    for (const hT of [90, 250, 900]) {
        const a = rayColumn({ tangentAltKm: hT, steps: 64 }).columnKgM2;
        const b = rayColumn({ tangentAltKm: hT, steps: 128 }).columnKgM2;
        assert.ok(Math.abs(a - b) / b < 1e-3,
            `${hT} km: 64 vs 128 steps differ by ${((a / b - 1) * 100).toFixed(3)}%`);
    }
});

t('airglow column concentrates on the emitting band', () => {
    const onBand = airglowColumn({ tangentAltKm: 95 }).brightness;
    const above  = airglowColumn({ tangentAltKm: 400 }).brightness;
    assert.ok(onBand > above * 5,
        `a ray tangent to the 90 km band must be far brighter than one at `
      + `400 km (${onBand.toFixed(0)} vs ${above.toFixed(0)})`);
});

t('airglow column colour on the band reads green-ish', () => {
    const { rgb } = airglowColumn({ tangentAltKm: 96, visibleOnly: true });
    assert.ok(rgb[1] > rgb[2], 'green channel should exceed blue on the band');
});

console.log('\n── 8. renderer LUT ──');

t('LUT shape and normalisation', () => {
    const lut = buildAtmosphereLUT({ bins: 64 });
    assert.equal(lut.data.length, 64 * 2 * 4);
    assert.ok(lut.logRhoMax > lut.logRhoMin);
    // Row 0 alpha spans the full 0..1 normalised range.
    assert.ok(Math.abs(lut.data[3] - 1) < 1e-9, 'floor bin should be the densest');
    assert.ok(Math.abs(lut.data[(63) * 4 + 3]) < 1e-9, 'ceiling bin should be 0');
    for (let i = 0; i < 64 * 2 * 4; i++) {
        assert.ok(Number.isFinite(lut.data[i]), `non-finite LUT entry at ${i}`);
        assert.ok(lut.data[i] >= -1e-9 && lut.data[i] <= 1 + 1e-9,
            `LUT entry ${i} = ${lut.data[i]} outside 0..1`);
    }
});

t('LUT COLOUR IS THE COMPOSITION PROFILE, not a palette', () => {
    const lut = buildAtmosphereLUT({ bins: 128 });
    const at = (km) => {
        const i = Math.round((km - lut.minKm) / (lut.maxKm - lut.minKm) * (lut.bins - 1));
        return [lut.data[i * 4], lut.data[i * 4 + 1], lut.data[i * 4 + 2]];
    };
    const low  = at(120);    // N₂/O₂ dominated → blue-ish
    const high = at(1800);   // H/He dominated → warm
    assert.ok(low[2] > low[0], 'the lower thermosphere should read blue (N₂/O₂)');
    assert.ok(high[0] > high[2], 'the exosphere should read warm (H/He)');
});

t('storm LUT is denser aloft than the quiet LUT', () => {
    const quiet = buildAtmosphereLUT({ f107Sfu: 70,  ap: 0,   bins: 64 });
    const storm = buildAtmosphereLUT({ f107Sfu: 230, ap: 400, bins: 64 });
    assert.ok(storm.logRhoMax - storm.logRhoMin < quiet.logRhoMax - quiet.logRhoMin,
        'an inflated thermosphere has a SHALLOWER log-density span across '
      + 'the band — that is what "puffed up" means');
});

t('probeProfile is log-spaced and finite', () => {
    const p = probeProfile({ n: 40 });
    assert.equal(p.length, 40);
    assert.ok(Math.abs(p[0].altKm - MODEL_FLOOR_KM) < 1e-6);
    assert.ok(Math.abs(p.at(-1).altKm - MODEL_CEIL_KM) < 1e-6);
    // Log spacing → the first gap is far smaller than the last.
    assert.ok((p[1].altKm - p[0].altKm) * 5 < (p.at(-1).altKm - p.at(-2).altKm));
    for (const s of p) {
        assert.ok(Number.isFinite(s.rho) && s.rho > 0, `bad rho at ${s.altKm}`);
        assert.ok(Number.isFinite(s.T) && s.T > 0, `bad T at ${s.altKm}`);
    }
});

console.log('\n── 9. solar geometry ──');

t('local solar time is 12 h at the sub-solar meridian', () => {
    assert.ok(Math.abs(localSolarTime(40, 40) - 12) < 1e-9);
    assert.ok(Math.abs(localSolarTime(-140, 40) - 0) < 1e-9
           || Math.abs(localSolarTime(-140, 40) - 24) < 1e-9);
});

t('local solar time wraps cleanly across the dateline', () => {
    for (let lon = -180; lon <= 180; lon += 7) {
        const lst = localSolarTime(lon, 170);
        assert.ok(lst >= 0 && lst < 24, `lst=${lst} at lon=${lon}`);
    }
});

console.log(`\n${fail === 0 ? '✓' : '✗'} upper-atmosphere-column: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
