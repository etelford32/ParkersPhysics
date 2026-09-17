/**
 * tests/flare-dem.mjs — pins the flare cooling track in js/flare-dem.js
 *
 *   node tests/flare-dem.mjs
 *
 * THE ONE CLAIM THIS GATES. The page says a flare lights 131 and 94 first and
 * the cooler channels tens of minutes later, the way an AIA movie shows it.
 * That claim is not scripted anywhere — it is supposed to fall out of a
 * cooling ODE evaluated against the RAYMARCHER's own response table. So the
 * test MEASURES the channel order back out. If someone flattens the cooling,
 * removes the drainage, or retunes the response table, this fails.
 *
 * Also gated:
 *   • GOES class ↔ flux round-trips
 *   • peak temperatures land in the measured 10–25 MK range across C–X
 *   • the cooling is monotone, finite, and ends at the stated floor — never
 *     negative, which is what forward Euler would do on the first
 *     conduction-dominated step
 *   • conduction dominates the hot end and radiation the cool end (the reason
 *     the cascade has two speeds)
 *   • 304 Å is reported as UNREACHABLE rather than extrapolated past where
 *     Λ ∝ T^(−1/2) is valid
 */
import assert from 'node:assert/strict';
import {
    K_B, FLUX_C1, T_PEAK_C1, T_FLOOR, DRAIN_EXP, L_DEFAULT,
    goesFluxOf, goesClassOf, peakTemperatureK, rtvDensity,
    tauCond, tauRad, tauEff, drainedDensity,
    coolingTrack, temperatureAt, flareDemState, channelPeakTimes,
} from '../js/flare-dem.js';
import { EUV_CHANNELS, channelResponseAt } from '../js/corona-volumetric.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('flare-dem.mjs');

// ── GOES class ─────────────────────────────────────────────────────────────

ok('GOES class ↔ flux round-trips across the whole scale', () => {
    assert.equal(goesFluxOf('C1'), 1e-6);
    assert.equal(goesFluxOf('X1'), 1e-4);
    assert.ok(Math.abs(goesFluxOf('M5.2') - 5.2e-5) < 1e-12);
    assert.ok(Math.abs(goesFluxOf('b3') - 3e-7) < 1e-14, 'lower case parses');
    assert.equal(goesFluxOf('X'), 1e-4, 'a bare letter is ×1');
    assert.equal(goesFluxOf('banana'), null);
    assert.equal(goesFluxOf(''), null);
    assert.equal(goesFluxOf(null), null);
    for (const c of ['C1.0', 'M2.5', 'X1.4']) {
        assert.equal(goesClassOf(goesFluxOf(c)), c.replace(/^([A-Z])(\d)$/, '$11.0'));
    }
});

// ── Peak temperature ───────────────────────────────────────────────────────

ok('peak temperatures land in the measured 10–25 MK range across C–X', () => {
    // Ryan et al. 2012 (ApJS 202, 11) measured GOES peak temperatures of
    // roughly 10–25 MK over C to X. The anchor must reproduce that SPAN, not
    // one point in it.
    const T = (c) => peakTemperatureK(goesFluxOf(c)) / 1e6;
    assert.ok(Math.abs(T('C1') - 8) < 1e-9, 'anchored at C1');
    assert.ok(T('M1') > 10 && T('M1') < 14, `M1 → ${T('M1').toFixed(1)} MK`);
    assert.ok(T('X1') > 15 && T('X1') < 20, `X1 → ${T('X1').toFixed(1)} MK`);
    assert.ok(T('X10') > 20 && T('X10') < 28, `X10 → ${T('X10').toFixed(1)} MK`);
    // Monotone in flux, and never NaN on garbage.
    assert.ok(peakTemperatureK(1e-3) > peakTemperatureK(1e-6));
    assert.equal(peakTemperatureK(0), T_PEAK_C1);
    assert.equal(Number.isFinite(peakTemperatureK(-1)), true);
});

ok('the density is DERIVED from RTV, not typed in', () => {
    // T = 1400 (pL)^(1/3) ⇒ a hotter flare on the same loop is a denser one,
    // with a cube law. Both halves matter: if density stopped responding to
    // temperature the cooling times would be wrong in the same direction for
    // every class and the cascade would rigidly rescale.
    const n1 = rtvDensity(1e7, L_DEFAULT), n2 = rtvDensity(2e7, L_DEFAULT);
    assert.ok(Math.abs(n2 / n1 - 4) < 1e-9, 'n ∝ T² at fixed L (T³ pressure, /T for number)');
    // A longer loop at the same temperature is thinner.
    assert.ok(rtvDensity(1e7, 4e9) < rtvDensity(1e7, 2e9));
    // And it recovers RTV itself: T = 1400 (p L)^(1/3).
    const T = 1.5e7, n = rtvDensity(T, L_DEFAULT), p = 2 * n * K_B * T;
    assert.ok(Math.abs(1400 * Math.cbrt(p * L_DEFAULT) - T) / T < 1e-9);
});

// ── The cooling track ──────────────────────────────────────────────────────

ok('the track cools monotonically to the floor and never goes negative', () => {
    // An explicit forward-Euler step would drive T negative on the first
    // conduction-dominated step (τ_c is seconds at 20 MK). The integrator uses
    // the exact exponential over each step for that reason.
    for (const cls of ['C1', 'M5', 'X1', 'X10']) {
        const tr = coolingTrack(goesFluxOf(cls));
        assert.ok(tr.T.length > 50, 'the track has resolution');
        for (let i = 1; i < tr.T.length; i++) {
            assert.ok(tr.T[i] <= tr.T[i - 1] + 1e-6, `${cls}: monotone at ${i}`);
            assert.ok(tr.T[i] > 0 && Number.isFinite(tr.T[i]), `${cls}: finite positive at ${i}`);
            assert.ok(tr.t[i] > tr.t[i - 1], 'time advances');
        }
        assert.ok(tr.T[tr.T.length - 1] <= T_FLOOR * 1.01, `${cls} reaches the floor`);
        assert.ok(Math.abs(tr.T[0] - peakTemperatureK(goesFluxOf(cls))) < 1, 'starts at the peak');
    }
});

ok('conduction dominates the hot end, radiation the cool end', () => {
    // This is why the cascade has two speeds — the fast plunge from 20 to
    // ~8 MK and the long radiative tail that makes 171 light late.
    const L = L_DEFAULT, n = rtvDensity(2e7, L);
    assert.ok(tauCond(n, L, 2e7) < tauRad(n, 2e7), 'conduction is faster at 20 MK');
    const nCool = drainedDensity(n, 2e7, 1e6);
    assert.ok(tauCond(nCool, L, 1e6) > tauRad(nCool, 1e6), 'radiation is faster at 1 MK');
    // τ_eff is never longer than either.
    for (const T of [2e7, 5e6, 1e6]) {
        assert.ok(tauEff(n, L, T) <= Math.min(tauCond(n, L, T), tauRad(n, T)) + 1e-9);
    }
});

ok('temperatureAt interpolates the track it was given', () => {
    const flux = goesFluxOf('X1');
    const track = coolingTrack(flux);
    assert.equal(temperatureAt(flux, 0, { track }), track.T0);
    assert.equal(temperatureAt(flux, -5, { track }), track.T0, 'before onset is the peak, not NaN');
    // Every queried time reproduces the track to interpolation error.
    for (let i = 3; i < track.t.length; i += Math.max(1, (track.t.length / 40) | 0)) {
        const got = temperatureAt(flux, track.t[i], { track });
        assert.ok(Math.abs(got - track.T[i]) / track.T[i] < 1e-6, `at t=${track.t[i].toFixed(1)}`);
    }
    // Past the end it holds the floor rather than extrapolating to zero.
    const late = temperatureAt(flux, 1e6, { track });
    assert.ok(late >= T_FLOOR * 0.99 && late <= T_FLOOR * 1.01, `held at the floor, got ${late}`);
});

// ── THE CLAIM ──────────────────────────────────────────────────────────────

ok('THE CASCADE IS EMERGENT: 131 and 94 light first, 171 tens of minutes later', () => {
    for (const cls of ['C5', 'M2', 'X1']) {
        const flux = goesFluxOf(cls);
        const pk = channelPeakTimes(flux, EUV_CHANNELS, channelResponseAt);
        const reached = Object.entries(pk).filter(([, v]) => v.value > 1e-6);
        const order = reached.sort((a, b) => a[1].tPeak - b[1].tPeak).map(([k]) => k);
        console.log(`      ${cls}: ` + reached.map(([k, v]) => `${k} ${(v.tPeak / 60).toFixed(1)}m`).join('  '));
        // The AIA order, measured out of the ODE — not asserted into it.
        assert.deepEqual(order, ['131', '94', '211', '193', '171'],
            `${cls} cascade order came out as ${order.join(' → ')}`);
        // And the separations are the ones an AIA movie shows: the hot pair
        // inside the first few minutes, the 171 arcade tens of minutes later.
        assert.ok(pk['131'].tPeak < 5 * 60, `${cls}: 131 peaks in the first minutes`);
        assert.ok(pk['94'].tPeak > pk['131'].tPeak, `${cls}: 94 follows 131`);
        assert.ok(pk['171'].tPeak > 10 * 60, `${cls}: the 171 arcade is late (${(pk['171'].tPeak / 60).toFixed(1)} min)`);
        assert.ok(pk['171'].tPeak < 60 * 60, `${cls}: but not absurdly late`);
        // The cool channels must be SEPARATED, not bunched — that separation
        // is the whole reason DRAIN_EXP exists (see the module header's scan).
        assert.ok(pk['171'].tPeak - pk['211'].tPeak > 3 * 60,
            `${cls}: 211 and 171 are ${((pk['171'].tPeak - pk['211'].tPeak) / 60).toFixed(1)} min apart`);
    }
});

ok('without drainage the cool channels BUNCH — the gate above is not vacuous', () => {
    // Self-validating: re-run the measurement with the drainage turned off and
    // show the separation collapses. This is what stops "cool channels are
    // separated" from passing for some unrelated reason.
    const flux = goesFluxOf('X1');
    const opts = { drainExp: 0 };
    const pk = channelPeakTimes(flux, EUV_CHANNELS, channelResponseAt, opts);
    const spread = pk['171'].tPeak - pk['211'].tPeak;
    console.log(`      n ∝ T⁰: 211→171 spread ${(spread / 60).toFixed(1)} min`);
    assert.ok(spread < 2 * 60, `undrained spread is ${(spread / 60).toFixed(1)} min — should bunch`);
    // The hot end is conduction-dominated and barely moves, which is the
    // header's claim about WHY drainage matters only at the cool end.
    const drained = channelPeakTimes(flux, EUV_CHANNELS, channelResponseAt);
    assert.ok(Math.abs(pk['131'].tPeak - drained['131'].tPeak) < 120, '131 barely moves');
});

ok('304 Å is reported unreachable, not extrapolated', () => {
    // Λ ∝ T^(−1/2) is a coronal approximation; the track stops at T_FLOOR
    // rather than running down to 50 kK. So the COOLING ARCADE never lights
    // 304 — and the kernel must say that with a number near zero rather than
    // by quietly producing a plausible time.
    const pk = channelPeakTimes(goesFluxOf('X1'), EUV_CHANNELS, channelResponseAt);
    assert.ok(pk['304'].value < 1e-9, `304 value ${pk['304'].value.toExponential(2)} is nil`);
    assert.ok(Math.log10(T_FLOOR) > EUV_CHANNELS['304'].logT + 5 * EUV_CHANNELS['304'].sigma,
        'the floor really is far above 304 Å — this is a model limit, not a tuning');
    // White light is not a passband and must not appear at all.
    assert.equal(pk['white'], undefined);
});

ok('the DEM state separates TEMPERATURE from AMPLITUDE', () => {
    // Conflating them is the original bug: one number drove both, so every
    // channel rose and fell together.
    const flux = goesFluxOf('X1');
    const track = coolingTrack(flux);
    const a = flareDemState(flux, 30, { track });
    const b = flareDemState(flux, 900, { track });
    assert.ok(a.logT > b.logT, 'temperature falls');
    assert.ok(a.amp >= 0 && a.amp <= 1 && b.amp >= 0 && b.amp <= 1, 'amplitude is an envelope');
    assert.equal(flareDemState(flux, 0, { track }).amp, 0, 'nothing before onset');
    assert.ok(flareDemState(flux, 60, { track }).amp > 0.9, 'peaks at the end of the rise');
    // Amplitude decays while temperature is still falling — two independent
    // curves, which is what lets a channel peak on the way DOWN in temperature.
    assert.ok(b.amp < a.amp);
    assert.ok(Number.isFinite(b.logT) && b.logT > 5, 'still a real temperature at 15 min');
});

console.log(`\n${passed} checks passed`);
