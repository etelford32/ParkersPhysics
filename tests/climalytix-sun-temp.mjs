/**
 * Node gate for js/climalytix/sun-temp.js — what a slope's own sunlight and
 * shade do to its air temperature: ΔT = M/h · ∫ ΔQ e^(−(t−t′)/τ) dt′/τ.
 *
 * Identities and closed forms, not remembered numbers:
 *   · FLAT UNSHADED GROUND GETS EXACTLY 0 at every Sun, cloud and wind — the
 *     term is an anomaly from what GFS already heats, never a second Sun.
 *     NEGATIVE CONTROL: the slope's WHOLE budget (no flat-ground subtraction)
 *     warms flat ground by several K
 *   · the radiation is slope-wind.js's own (same beam, cloud law, albedo)
 *   · the memory weights are exact: Σw = 1 − e^(−T/τ), a constant ΔQ comes
 *     back as ΔQ/h times that, and a switched-off ΔQ decays as e^(−t/τ)
 *   · signs and timing: south-facing warmer than north-facing at noon; an
 *     east face leads in the morning and a west face in the afternoon — and
 *     with memory the west face is still warm after the Sun has left it
 *   · a shaded cell loses exactly the flat-ground beam
 *   · sizes land in the observed 2 m range (≈1–2 K), cloud shrinks them, wind
 *     shrinks them, night is 0, and nothing exceeds the cap
 */
import assert from 'node:assert/strict';
import { beamAnomaly, windMixing, memorySamples, sunTempAt, sunTempGrid, effectPaint, EFFECT_FULL_K, EFFECT_FLOOR_K, MEMORY, WIND_MIX_MS, AMP_CAP_K, H_AIR } from '../js/climalytix/sun-temp.js';
import { beamIrradiance, cloudTransmission, surfaceBudget, ALBEDO, H_DAY } from '../js/climalytix/slope-wind.js';
import { incidence, slopeAspect } from '../js/climalytix/terrain.js';
import { shadowGrid } from '../js/climalytix/sun-terrain.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const D2R = Math.PI / 180;
const sunAt = (altitudeDeg, azimuthDeg = 180) => ({ altitudeDeg, azimuthDeg });
assert.equal(H_AIR, H_DAY, 'one transfer coefficient, slope-wind.js\'s');

// ── flat unshaded ground is exactly zero ────────────────────────────────────
for (const alt of [2, 15, 40, 75]) for (const az of [80, 180, 265]) for (const cloudFrac of [0, 0.6, 1]) {
    near(beamAnomaly({ slopeDeg: 0, sun: sunAt(alt, az), cloudFrac }), 0, 1e-9, `flat ground, Sun ${alt}°/${az}°, cloud ${cloudFrac}`);
}
{
    // NEGATIVE CONTROL: the whole budget instead of the anomaly counts the Sun twice.
    const whole = surfaceBudget({ incidence: Math.sin(40 * D2R), sunAltDeg: 40 }).sw / H_AIR;
    assert.ok(whole > 2.5, `adding flat ground's whole absorbed beam would warm it ${whole.toFixed(1)} K on top of GFS`);
}
assert.equal(beamAnomaly({ slopeDeg: 30, aspectDeg: 180, sun: sunAt(-4) }), 0, 'Sun down: no anomaly');
assert.equal(beamAnomaly({ slopeDeg: 30, aspectDeg: 180, sun: sunAt(0) }), 0);
assert.equal(beamAnomaly({ slopeDeg: 30, aspectDeg: 180, sun: null }), 0);

// ── it IS slope-wind.js's radiation ─────────────────────────────────────────
{
    const sun = sunAt(25, 160), slopeDeg = 28, aspectDeg = 170, cloudFrac = 0.4;
    const expect = (1 - ALBEDO) * beamIrradiance(25) * cloudTransmission(0.4) * (incidence(slopeDeg, aspectDeg, 25, 160) - Math.sin(25 * D2R));
    near(beamAnomaly({ slopeDeg, aspectDeg, sun, cloudFrac }), expect, 1e-9, 'beam × cloud × (slope − flat)');
    near(beamAnomaly({ slopeDeg, aspectDeg, sun, cloudFrac, shaded: true }),
        -(1 - ALBEDO) * beamIrradiance(25) * cloudTransmission(0.4) * Math.sin(25 * D2R), 1e-9, 'a shaded cell loses exactly the flat-ground beam');
    near(beamAnomaly({ slopeDeg, aspectDeg, sun, cloudFrac: NaN }), beamAnomaly({ slopeDeg, aspectDeg, sun, cloudFrac: 0 }), 1e-12, 'unknown cloud = clear sky (the upper bound)');
}

// ── signs ───────────────────────────────────────────────────────────────────
{
    const noon = sunAt(30, 180);
    const south = beamAnomaly({ slopeDeg: 25, aspectDeg: 180, sun: noon }), north = beamAnomaly({ slopeDeg: 25, aspectDeg: 0, sun: noon });
    assert.ok(south > 0 && north < 0, 'south-facing gains, north-facing loses, at noon in the northern winter');
    const am = sunAt(15, 120), pm = sunAt(15, 240);
    assert.ok(beamAnomaly({ slopeDeg: 25, aspectDeg: 90, sun: am }) > beamAnomaly({ slopeDeg: 25, aspectDeg: 270, sun: am }), 'east face leads in the morning');
    assert.ok(beamAnomaly({ slopeDeg: 25, aspectDeg: 270, sun: pm }) > beamAnomaly({ slopeDeg: 25, aspectDeg: 90, sun: pm }), 'west face leads in the afternoon');
    // Sizes: the observed 2 m range, not a skin temperature.
    const warm = beamAnomaly({ slopeDeg: 30, aspectDeg: 180, sun: sunAt(20, 180) }) / H_AIR, cold = beamAnomaly({ slopeDeg: 0, sun: sunAt(20, 180), shaded: true }) / H_AIR;
    assert.ok(warm > 0.8 && warm < 2.5, `a steep sun-facing slope under a 20° Sun: +${warm.toFixed(2)} K at equilibrium`);
    assert.ok(cold < -0.7 && cold > -2.0, `shaded ground under the same Sun: ${cold.toFixed(2)} K`);
    assert.ok(Math.abs(beamAnomaly({ slopeDeg: 30, aspectDeg: 180, sun: sunAt(20), cloudFrac: 1 })) < 0.3 * Math.abs(warm * H_AIR), 'overcast removes most of it');
}

// ── wind mixing ─────────────────────────────────────────────────────────────
assert.equal(windMixing(0), 1);
assert.equal(windMixing(null), 1);
assert.equal(windMixing(NaN), 1);
near(windMixing(WIND_MIX_MS), 0.5, 1e-12, 'halved at the mixing speed');
assert.ok(windMixing(20) < windMixing(5) && windMixing(20) > 0);

// ── the memory integral ─────────────────────────────────────────────────────
{
    const H = 3_600_000, t = 1_794_250_000_000 + 17 * 60_000;            // not on a step mark
    const S = memorySamples(t);
    assert.equal(S.length, MEMORY.intervals + 1, 'a partial newest interval + the whole steps');
    assert.equal(S[0].b, t);
    for (let k = 1; k < S.length; k++) {
        assert.equal(S[k].b, S[k - 1].a, 'contiguous, newest first');
        assert.equal(S[k].b - S[k].a, H);
        assert.equal(S[k].at % (H / 2), 0, 'older samples sit on absolute half-hour marks (shared between nearby instants)');
    }
    const span = (t - S.at(-1).a) / 1000;
    near(S.reduce((a, s) => a + s.w, 0), 1 - Math.exp(-span / MEMORY.tauS), 1e-12, 'Σw = 1 − e^(−T/τ): the exact integral of the kernel');
    assert.ok(S.every((s) => s.w > 0) && S.every((s, k) => !k || s.w < S[k - 1].w || k === 1), 'older intervals weigh less');
    // On a mark there is no partial interval.
    assert.equal(memorySamples(Math.floor(t / H) * H).length, MEMORY.intervals);
    // Two instants 20 min apart share every whole-step sample.
    const S2 = memorySamples(t + 20 * 60_000);
    assert.deepEqual(S2.slice(1).map((s) => s.at), S.slice(1).map((s) => s.at));

    // A constant ΔQ comes back as ΔQ/h × (1 − e^(−T/τ)).
    const dq = 180;
    near(sunTempAt(S, S.map(() => dq)), (dq / H_AIR) * (1 - Math.exp(-span / MEMORY.tauS)), 1e-12, 'steady state');
    // Switched off one step ago: what is left is the kernel's tail from then.
    const off = S.map((s) => (s.b <= S[0].a - H ? dq : 0));
    const sinceOff = (t - (S[0].a - H)) / 1000;
    near(sunTempAt(S, off), (dq / H_AIR) * (Math.exp(-sinceOff / MEMORY.tauS) - Math.exp(-span / MEMORY.tauS)), 1e-12, 'decays as e^(−t/τ) after the Sun leaves');
    assert.ok(sunTempAt(S, off) > 0.2 * dq / H_AIR, 'a slope is still warm an hour after it went into shade');
    // Mixing and the cap.
    near(sunTempAt(S, S.map(() => dq), { windMs: WIND_MIX_MS }), 0.5 * sunTempAt(S, S.map(() => dq)), 1e-12, 'a 5 m/s breeze halves it');
    assert.equal(sunTempAt(S, S.map(() => 1e6)), AMP_CAP_K);
    assert.equal(sunTempAt(S, S.map(() => -1e6)), -AMP_CAP_K);
    assert.equal(sunTempAt(S, []), 0, 'a missing sample is no anomaly, not NaN');
}

// ── the grid: a north–south ridge through a morning ─────────────────────────
{
    const N = 81, CELL = 250, d = CELL / 111_195, C = 40;
    const values = new Float32Array(N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) values[i * N + j] = 1500 + Math.max(0, 1200 - 150 * Math.abs(j - C));   // ridge crest along column C
    const g = { latN: (N - 1) / 2 * d, lonW: -(N - 1) / 2 * d, dlat: d, dlon: d, nRows: N, nCols: N, values };
    const sa = slopeAspect(g);
    const morning = sunAt(12, 100);                                       // low Sun in the east-south-east
    const samples = memorySamples(1_794_250_000_000).map((s) => ({ ...s, sun: morning, mask: shadowGrid(g, morning).mask }));
    const out = sunTempGrid(g, sa, { samples });
    const at = (i, j) => out.values[i * N + j];
    assert.equal(out.daylight, true);
    assert.ok(at(40, C + 4) > 0.5, `the east flank faces the morning Sun: +${at(40, C + 4).toFixed(2)} K`);
    assert.ok(at(40, C - 4) < -0.5, `the west flank is in the ridge's shadow: ${at(40, C - 4).toFixed(2)} K`);
    near(at(40, 75), 0, 1e-6, 'the open plain east of the ridge is flat and lit: 0');
    assert.ok(at(40, 24) < -0.3, 'the plain just west of the ridge (its shadow is 1200 m / tan 12° ≈ 5.6 km long) — flat ground, yet colder');
    assert.ok(out.range.min >= -AMP_CAP_K && out.range.max <= AMP_CAP_K);
    assert.ok(out.range.min < 0 && out.range.max > 0);
    // Cloud and wind shrink every cell; neither flips a sign.
    const cloudy = sunTempGrid(g, sa, { samples, cloudAt: () => 0.9 }), windy = sunTempGrid(g, sa, { samples, windAt: () => 10 });
    for (const [i, j] of [[40, C + 4], [40, C - 4], [40, 24]]) {
        const k = i * N + j;
        assert.ok(Math.abs(cloudy.values[k]) < Math.abs(out.values[k]) && Math.sign(cloudy.values[k]) === Math.sign(out.values[k]));
        near(windy.values[k], out.values[k] / 3, 1e-6, '10 m/s ⇒ ÷3');
    }
    // NEGATIVE CONTROL: without cast shadows the plain west of the ridge reads 0 — the shadow is the signal.
    const noShadow = sunTempGrid(g, sa, { samples: samples.map((s) => ({ ...s, mask: null })) });
    near(noShadow.values[40 * N + 24], 0, 1e-6, 'no cast shadow ⇒ the shaded plain is indistinguishable from the lit one');
    // Night: nothing, and it says so.
    const night = sunTempGrid(g, sa, { samples: samples.map((s) => ({ ...s, sun: sunAt(-10), mask: null })) });
    assert.equal(night.daylight, false);
    assert.deepEqual([night.range.min, night.range.max], [0, 0]);
    // No terrain ⇒ no number.
    const holed = { ...g, values: Float32Array.from(values, (v, k) => (k === 40 * N + 60 ? NaN : v)) };
    assert.ok(Number.isNaN(sunTempGrid(holed, slopeAspect(holed), { samples }).values[40 * N + 60]));
}

// ── the effect view's paint ─────────────────────────────────────────────────
{
    const px = (k) => { const d = new Uint8ClampedArray(4); effectPaint(k, d, 0); return [...d]; };
    assert.deepEqual(px(0), [0, 0, 0, 0], 'no effect paints nothing');
    assert.deepEqual(px(EFFECT_FLOOR_K * 0.9), [0, 0, 0, 0]);
    assert.deepEqual(px(NaN), [0, 0, 0, 0]);
    const warm = px(1), cool = px(-1);
    assert.ok(warm[0] > warm[2] && cool[2] > cool[0], 'warmer is gold, cooler is indigo');
    assert.deepEqual(px(1).slice(0, 3), px(0.2).slice(0, 3), 'one colour per sign; strength is alpha');
    assert.ok(px(0.2)[3] < px(0.8)[3] && px(0.8)[3] < px(EFFECT_FULL_K)[3], 'alpha grows with the size of the effect');
    assert.equal(px(EFFECT_FULL_K)[3], px(5)[3], 'full strength at EFFECT_FULL_K');
    assert.equal(px(1)[3], px(-1)[3], 'symmetric');
}

console.log('climalytix-sun-temp: flat-ground identity, radiation reuse, memory integral, signs + timing, ridge grid with shadow control passed');
