#!/usr/bin/env node
/**
 * climalytix-slope-wind.mjs — node gate for js/climalytix/slope-wind.js
 * (plan §19 T3: Prandtl (1942) anabatic / katabatic slope winds).
 *
 *   · the profile SATISFIES BOTH PRANDTL ODEs (finite differences at many
 *     heights, day and night constants) with u(0) = 0 and θ′(0) = Δθ
 *   · NEGATIVE CONTROL: the plan's first amplitude √(gK/(θ₀N²Pr)) fails the
 *     momentum equation by orders of magnitude (it is not even a speed)
 *   · the jet peaks at n = πλ/4 with u_max = 0.3224·μ·Δθ (dense scan); the
 *     speed does NOT depend on the slope angle, the thickness goes as
 *     sin^(−½)α (Prandtl's result)
 *   · sign follows Δθ: heating ⇒ upslope, cooling ⇒ downslope; flat ground
 *     has no slope wind; a slope too gentle to spin up is left blank
 *   · the budget: Meinel beam at the zenith is 0.7·S0; air mass is 1 at the
 *     zenith and ~38 at the horizon; cloud damps sunlight and longwave
 *     MONOTONICALLY; the Sun down ⇒ only the longwave loss
 *   · geometry: at noon a south-facing slope gets more sunlight than the
 *     north-facing one and blows UP its own fall line (toward the north); at
 *     night both drain DOWN their fall lines with equal speed
 *   · calibration (a range, not a truth): a sunlit 15° slope runs 1–6 m/s
 *     upslope, a clear night 1–4 m/s downslope; overcast cuts both by > 2×
 *   · the grid equals the pointwise function, gaps stay NaN, extremes found
 *
 *   node tests/climalytix-slope-wind.mjs
 */

import assert from 'node:assert/strict';
import {
    prandtlScales, prandtlProfile, airMass, beamIrradiance, cloudTransmission, surfaceBudget,
    slopeWind, slopeWindGrid, slopeWindExtremes,
    G, PRANDTL_PEAK, SOLAR_CONSTANT, LW_CLEAR, N_DAY, N_NIGHT, K_DAY, K_NIGHT, PR, PERIOD_MAX_S, THETA0_DEFAULT_K,
} from '../js/climalytix/slope-wind.js';
import { sampleGrid, slopeAspect } from '../js/climalytix/terrain.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
console.log('climalytix slope wind (Prandtl)');

const D2R = Math.PI / 180;
const T0 = THETA0_DEFAULT_K;

/** Residuals of K u'' + (g/θ0) sinα θ = 0 and Kh θ'' − (N²θ0/g) sinα u = 0, scaled by each term's size. */
function residuals({ slopeDeg, N, K, dTheta }, mu = null) {
    const sc = prandtlScales({ dTheta, slopeDeg, N, K });
    if (mu != null) sc.mu = mu;
    const sa = Math.sin(slopeDeg * D2R), gamma = N * N * T0 / G;
    const h = sc.lambda * 1e-3;
    let worst = 0;
    for (const f of [0.1, 0.3, 0.6, 0.785, 1.2, 2, 3.5]) {
        const n = f * sc.lambda;
        const p = (x) => prandtlProfile(x, sc, dTheta);
        const a = p(n - h), b = p(n), c = p(n + h);
        const upp = (a.u - 2 * b.u + c.u) / (h * h), tpp = (a.theta - 2 * b.theta + c.theta) / (h * h);
        const m1 = K * upp, m2 = (G / T0) * sa * b.theta;
        const h1 = sc.Kh * tpp, h2 = gamma * sa * b.u;
        const scale1 = Math.abs(m2) + Math.abs(K * dTheta * sc.mu / sc.lambda ** 2) * 1e-3;
        const scale2 = Math.abs(h2) + Math.abs(sc.Kh * dTheta / sc.lambda ** 2) * 1e-3;
        worst = Math.max(worst, Math.abs(m1 + m2) / scale1, Math.abs(h1 - h2) / scale2);
    }
    return worst;
}

ok('the profile satisfies both Prandtl ODEs, with u(0) = 0 and θ′(0) = Δθ', () => {
    for (const c of [
        { slopeDeg: 10, N: N_DAY, K: K_DAY, dTheta: 3 },
        { slopeDeg: 25, N: N_NIGHT, K: K_NIGHT, dTheta: -4 },
        { slopeDeg: 4, N: 0.015, K: 2, dTheta: 1 },
    ]) {
        assert.ok(residuals(c) < 1e-4, `${JSON.stringify(c)}: residual ${residuals(c)}`);
        const sc = prandtlScales(c);
        const z = prandtlProfile(0, sc, c.dTheta);
        assert.ok(z.u === 0, `u(0) = ${z.u}`);   // −0 for Δθ < 0 is still zero
        assert.equal(z.theta, c.dTheta);
    }
});

ok('NEGATIVE CONTROL: the plan\'s first amplitude √(gK/(θ₀N²Pr)) fails the momentum equation', () => {
    const c = { slopeDeg: 10, N: N_DAY, K: K_DAY, dTheta: 3 };
    const wrong = Math.sqrt(G * K_DAY / (T0 * N_DAY * N_DAY * PR));
    assert.ok(residuals(c, wrong) > 1, `residual ${residuals(c, wrong)}`);
    assert.ok(Math.abs(prandtlScales(c).mu - G / (T0 * N_DAY)) < 1e-12);
});

ok('the jet peaks at πλ/4 with 0.3224·μ·Δθ; speed is slope-independent, thickness ∝ sin^(−½)α', () => {
    assert.ok(Math.abs(PRANDTL_PEAK - 0.32239694) < 1e-7);
    const c = { slopeDeg: 12, N: N_NIGHT, K: K_NIGHT, dTheta: -3 };
    const sc = prandtlScales(c);
    let best = { u: 0, n: 0 };
    for (let k = 1; k <= 20000; k++) {
        const n = k * sc.lambda * 3 / 20000;
        const u = prandtlProfile(n, sc, c.dTheta).u;
        if (Math.abs(u) > Math.abs(best.u)) best = { u, n };
    }
    assert.ok(Math.abs(best.n - sc.zJet) < sc.lambda * 2e-4, `${best.n} vs ${sc.zJet}`);
    assert.ok(Math.abs(best.u - sc.uMax) < 1e-9);
    const a = prandtlScales({ ...c, slopeDeg: 5 }), b = prandtlScales({ ...c, slopeDeg: 30 });
    assert.equal(a.uMax, b.uMax, 'Prandtl: speed independent of the slope angle');
    const ratio = a.lambda / b.lambda, want = Math.sqrt(Math.sin(30 * D2R) / Math.sin(5 * D2R));
    assert.ok(Math.abs(ratio - want) < 1e-12);
});

const NOON = { altitudeDeg: 30, azimuthDeg: 180 };
const NIGHT = { altitudeDeg: -40, azimuthDeg: 0 };

ok('sign follows Δθ; flat ground has no slope wind; a too-gentle slope is left blank', () => {
    const day = slopeWind({ slopeDeg: 15, aspectDeg: 180, sun: NOON });
    const night = slopeWind({ slopeDeg: 15, aspectDeg: 180, sun: NIGHT });
    assert.equal(day.regime, 'anabatic'); assert.ok(day.u > 0 && day.dTheta > 0);
    assert.equal(night.regime, 'katabatic'); assert.ok(night.u < 0 && night.dTheta < 0);
    const flat = slopeWind({ slopeDeg: 0, aspectDeg: NaN, sun: NOON });
    assert.equal(flat.regime, 'flat'); assert.equal(flat.u, null);
    // The day cutoff: 2π/(N_DAY·sin α) = PERIOD_MAX_S.
    const cut = Math.asin(2 * Math.PI / (N_DAY * PERIOD_MAX_S)) / D2R;
    assert.ok(Math.abs(cut - 3.33) < 0.01, `${cut}`);
    assert.equal(slopeWind({ slopeDeg: cut - 0.05, aspectDeg: 180, sun: NOON }).regime, 'gentle');
    assert.equal(slopeWind({ slopeDeg: cut + 0.05, aspectDeg: 180, sun: NOON }).regime, 'anabatic');
    assert.equal(slopeWind({ slopeDeg: 2.0, aspectDeg: 180, sun: NIGHT }).regime, 'katabatic', 'N_NIGHT spins up faster');
});

ok('the budget: Meinel beam, Kasten–Young air mass, monotonic cloud damping, longwave only at night', () => {
    assert.ok(Math.abs(airMass(90) - 1) < 1e-3);
    assert.ok(airMass(0.01) > 35 && airMass(0.01) < 40, `${airMass(0.01)}`);
    assert.equal(airMass(0), Infinity, 'a Sun ON the horizon is down: no beam');
    assert.equal(airMass(-1), Infinity);
    assert.ok(Math.abs(beamIrradiance(90) - SOLAR_CONSTANT * 0.7) < 1);
    assert.equal(beamIrradiance(-5), 0);
    assert.equal(cloudTransmission(0), 1); assert.equal(cloudTransmission(1), 0.25);
    let prevSw = Infinity, prevLw = -Infinity;
    for (let c = 0; c <= 1.0001; c += 0.1) {
        const b = surfaceBudget({ incidence: 0.8, sunAltDeg: 40, cloudFrac: c });
        assert.ok(b.sw <= prevSw && b.lw >= prevLw, `cloud ${c}`);
        prevSw = b.sw; prevLw = b.lw;
    }
    const n = surfaceBudget({ incidence: 0, sunAltDeg: -10, cloudFrac: 0 });
    assert.equal(n.sw, 0); assert.equal(n.q, -LW_CLEAR);
});

ok('geometry: noon favours the south-facing slope and blows up its fall line; night drains both equally', () => {
    const s = slopeWind({ slopeDeg: 12, aspectDeg: 180, sun: NOON });      // faces south
    const n = slopeWind({ slopeDeg: 12, aspectDeg: 0, sun: NOON });        // faces north
    assert.ok(s.sw > n.sw && s.u > n.u, `${s.u} vs ${n.u}`);
    assert.equal(s.toward, 0, 'upslope on a south-facing slope blows toward the north');
    const sn = slopeWind({ slopeDeg: 12, aspectDeg: 180, sun: NIGHT });
    const nn = slopeWind({ slopeDeg: 12, aspectDeg: 0, sun: NIGHT });
    assert.equal(sn.u, nn.u, 'no sun ⇒ the aspect does not matter');
    assert.equal(sn.toward, 180); assert.equal(nn.toward, 0);
    // A morning Sun in the east flips an east-facing slope to upslope before a west-facing one.
    const morning = { altitudeDeg: 6, azimuthDeg: 100 };
    assert.equal(slopeWind({ slopeDeg: 25, aspectDeg: 100, sun: morning }).regime, 'anabatic');
    assert.equal(slopeWind({ slopeDeg: 25, aspectDeg: 280, sun: morning }).regime, 'katabatic');
});

ok('calibration (a range, not a truth): typical day and night magnitudes; overcast cuts both > 2×', () => {
    const day = slopeWind({ slopeDeg: 15, aspectDeg: 180, sun: { altitudeDeg: 45, azimuthDeg: 180 } });
    assert.ok(day.u > 1 && day.u < 6, `day ${day.u}`);
    const night = slopeWind({ slopeDeg: 15, aspectDeg: 180, sun: NIGHT });
    assert.ok(-night.u > 1 && -night.u < 4, `night ${night.u}`);
    assert.ok(night.zJet > 2 && night.zJet < 60 && day.zJet > 20 && day.zJet < 200, `jets ${night.zJet} ${day.zJet}`);
    const dayO = slopeWind({ slopeDeg: 15, aspectDeg: 180, sun: { altitudeDeg: 45, azimuthDeg: 180 }, cloudFrac: 1 });
    const nightO = slopeWind({ slopeDeg: 15, aspectDeg: 180, sun: NIGHT, cloudFrac: 1 });
    assert.ok(dayO.u < day.u / 2 && -nightO.u < -night.u / 2, `${dayO.u} ${nightO.u}`);
    // θ0 enters μ: a colder base state blows (slightly) harder.
    const cold = slopeWind({ slopeDeg: 15, aspectDeg: 180, sun: NIGHT, theta0K: 260 });
    assert.ok(cold.u < night.u);
    assert.ok(K_NIGHT < K_DAY && N_NIGHT > N_DAY);
});

ok('the grid equals the pointwise function; gaps stay NaN; extremes are found', () => {
    const N = 9, R = 6_371_008.8, M = Math.PI * R / 180;
    const box = { north: 40.04, south: 39.96, west: -105.04, east: -104.96 };
    const g = sampleGrid(box, N, N, (lat) => 1500 + 0.2 * (lat - 39.96) * M);   // rises north at 0.2: faces south
    const sa = slopeAspect(g);
    const sunAt = () => NOON;
    const r = slopeWindGrid(g, sa, { sunAt, cloudAt: () => 0.3 });
    const k = 4 * N + 4;
    const p = slopeWind({ slopeDeg: sa.slope[k], aspectDeg: sa.aspect[k], sun: NOON, cloudFrac: 0.3 });
    assert.ok(Math.abs(r.u[k] - p.u) < 1e-5 && Math.abs(r.toward[k] - p.toward) < 1e-3);
    assert.ok(Number.isNaN(r.u[0]), 'edge node: no Sobel stencil');
    assert.equal(r.counts.anabatic, (N - 2) * (N - 2));
    const ex = slopeWindExtremes(g, r.u);
    assert.ok(ex.up && ex.up.u > 0 && ex.down === null);
});

console.log(`\n${passed} passed`);
