#!/usr/bin/env node
/**
 * weather-cube.mjs — gates js/weather-cube.js (EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md §3.3).
 *
 *   1. Stencil geometry: exact at cell centres, wraps the antimeridian,
 *      clamps at the outer rows.
 *   2. RESOLVER PARITY — the render path is the oracle until T3 replaces it:
 *      for a sweep of instants across observed → nowcast → seam → NWP, the
 *      cube's t2m at every sampled cell centre equals what the REAL
 *      WeatherFrameResolver dispatches into its scratch buffer (driven with
 *      the real WeatherHistory + ForecastPaintProvider and an identity
 *      decode). NEGATIVE CONTROL: a cube with the seam blend disabled must
 *      DIFFER from the resolver inside the seam window, so the parity check
 *      can see the seam at all.
 *   3. Collision rule: an observation overwrites a forecast row at the same
 *      hour key.
 *   4. Gaps are null, never 0; held (out-of-range) samples are null in a
 *      series and flagged in sample().
 *   5. Provenance labels and coverage runs (observed → nowcast → nwp, gap split).
 *   6. Derived variables (wind, direction convention, cloud total, dew point).
 *   7. Version-cached index: no rebuild without a data change; a same-hour
 *      replacement (sizes unchanged) DOES invalidate.
 *   8. Speed: a 21-day hourly series of five variables stays well under a
 *      frame budget.
 */

import assert from 'node:assert/strict';

// ── Minimal globals (same shims as tests/weather-forecast-smoke.mjs) ─────────
globalThis.indexedDB = {
    open() {
        const req = {};
        queueMicrotask(() => req.onerror?.({ target: { error: new Error('no IDB in node') } }));
        return req;
    },
};
globalThis.document = {
    _l: new Map(),
    addEventListener(t, f) { (this._l.get(t) ?? this._l.set(t, new Set()).get(t)).add(f); },
    removeEventListener(t, f) { this._l.get(t)?.delete(f); },
    dispatchEvent(ev) { for (const f of this._l.get(ev.type) ?? []) f(ev); },
    hidden: false,
};
globalThis.CustomEvent = class { constructor(type, init = {}) { this.type = type; this.detail = init.detail ?? null; } };

const { WeatherCube, stencil, PROVENANCE, SEAM_BLEND_MS, MAX_INTERP_GAP_MS } = await import('../js/weather-cube.js');
const { WeatherHistory } = await import('../js/weather-history.js');
const { ForecastPaintProvider } = await import('../js/weather-forecast.js');
const { WeatherFrameResolver } = await import('../js/weather-frame-resolver.js');
const { TEX_W, TEX_H } = await import('../js/weather-decode.js');
const { dewPointC } = await import('../js/composite-indices.js');

const W = 72, H = 36, N = W * H, C = 9;
const HOUR = 3_600_000;
// Frame times far from the wall clock: the cube takes no ambient time, and
// the resolver's live bypass must never be in play.
const T0 = Date.UTC(2020, 0, 1, 0);

let pass = 0, fail = 0;
async function check(name, fn) {
    try { await fn(); pass++; console.log('  ✓', name); }
    catch (e) { fail++; console.error('  ✗', name); console.error('    ', e.stack || e.message); }
}

const centreLat = (j) => -90 + 2.5 + j * 5;
const centreLon = (i) => -180 + 2.5 + i * 5;

/** A frame whose every channel is a smooth, distinct function of (cell, seed). */
function frame(seed, fill = null) {
    const c = new Float32Array(N * C);
    for (let ch = 0; ch < C; ch++) {
        for (let k = 0; k < N; k++) {
            const j = Math.floor(k / W), i = k % W;
            c[ch * N + k] = fill ?? (10 * ch + Math.sin(i * 0.3 + seed) * 5 + Math.cos(j * 0.2 - seed) * 3 + seed * 0.7);
        }
    }
    // keep physical ranges sane where derived vars read them
    for (let k = 0; k < N; k++) {
        c[2 * N + k] = 40 + 20 * Math.sin(k + seed);          // RH %
        for (const ch of [5, 6, 7]) c[ch * N + k] = 50 + 40 * Math.sin(k * 0.1 + seed + ch); // cloud %
        c[8 * N + k] = Math.max(0, Math.sin(k * 0.05 + seed)); // precip
    }
    return c;
}

async function freshHistory() {
    const h = new WeatherHistory();
    await h.open();               // no IDB → in-memory mode, _ready = true
    return h;
}

// Identity decode: the resolver lerps whatever trio we hand it, so putting
// each cell's raw T at texel k·4 makes its scratch buffer directly comparable
// to cube.sample('t2m') at that cell's centre.
const TEXF = TEX_W * TEX_H * 4;
function identityDecode(coarse) {
    const weatherBuf = new Float32Array(TEXF);
    for (let k = 0; k < N; k++) weatherBuf[k * 4] = coarse[k];
    return { weatherBuf, windBuf: new Float32Array(TEXF), cloudBuf: new Float32Array(TEXF) };
}

function denseFrom(startT, hours, seedBase) {
    const horizons = [], frames = {}, target_ms = {};
    for (let h = 0; h <= hours; h++) {
        horizons.push(h);
        frames[h] = frame(seedBase + h * 0.37);
        target_ms[h] = startT + h * HOUR;
    }
    return { horizons, frames, target_ms, issued_ms: startT, gridW: W, gridH: H, model_id: 'rk2-test' };
}

/**
 * The shared world: 24 observed hours T0..T0+23h, a 24 h nowcast issued at
 * the last observation, and NWP rows from the issue hour to +72 h.
 */
async function world() {
    const history = await freshHistory();
    for (let h = 0; h < 24; h++) history.ingest({ t: T0 + h * HOUR, source: 'open-meteo:72x36', gridW: W, gridH: H, coarse: frame(h) });
    const issued = T0 + 23 * HOUR;
    for (let h = 0; h <= 72; h++) history.ingestForecast({ t: issued + h * HOUR, source: 'open-meteo-fc', gridW: W, gridH: H, coarse: frame(100 + h * 0.5) });
    const provider = new ForecastPaintProvider({
        forecaster: { forecastDense() { return null; } },
        history, decode: identityDecode, maxHorizonH: 24,
    });
    provider._applyDense(denseFrom(issued, 24, 50));
    return { history, provider, issued };
}

console.log('weather-cube');

await check('stencil: exact at centres, wraps the antimeridian, clamps at the poles', () => {
    const st = stencil(centreLat(10), centreLon(20), W, H);
    const wSum = st.w.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(wSum - 1) < 1e-12);
    assert.equal(st.k[0], 10 * W + 20);
    assert.ok(Math.abs(st.w[0] - 1) < 1e-12, `centre weight ${st.w[0]}`);
    // Halfway between the last column (177.5°) and the first (−177.5°).
    const wrap = stencil(centreLat(5), 180, W, H);
    assert.deepEqual([wrap.k[0] % W, wrap.k[1] % W], [W - 1, 0]);
    assert.ok(Math.abs(wrap.w[0] - 0.5) < 1e-9 && Math.abs(wrap.w[1] - 0.5) < 1e-9);
    // −180 and +180 are the same place.
    assert.deepEqual(stencil(0, -180, W, H).k, stencil(0, 180, W, H).k);
    // Beyond the outermost centre the row clamps (no extrapolation).
    const pole = stencil(90, 0, W, H);
    assert.equal(Math.floor(pole.k[2] / W), H - 1);
    assert.ok(pole.w[0] + pole.w[1] < 1e-12, 'all weight on the top row');
});

await check('RESOLVER PARITY: cube t2m == WeatherFrameResolver scratch across observed → nowcast → seam → NWP', async () => {
    const { history, provider, issued } = await world();
    const feed = { weatherBuffer: new Float32Array(TEXF), windBuffer: new Float32Array(TEXF), cloudBuffer: new Float32Array(TEXF), meta: {}, _decodeCoarse: identityDecode };
    const resolver = new WeatherFrameResolver({ feed, history, forecastProvider: provider, minRepaintMs: 0 });
    const cube = new WeatherCube({ history, nowcast: provider });
    const cells = [0, 1, 73, 500, 1300, 2000, N - 1];
    const edge = issued + 24 * HOUR;
    const ts = [];
    for (let m = 30; m < 23 * 60; m += 97) ts.push(T0 + m * 60_000);                // observed
    for (let m = 7; m < 20 * 60; m += 83) ts.push(issued + m * 60_000);             // nowcast
    for (let m = 1; m < SEAM_BLEND_MS / 60_000; m += 13) ts.push(edge - SEAM_BLEND_MS + m * 60_000); // seam
    for (let m = 1; m < 40 * 60; m += 151) ts.push(edge + m * 60_000);              // NWP beyond
    let compared = 0;
    for (const t of ts) {
        resolver._dispatchReplay(t);
        for (const k of cells) {
            const j = Math.floor(k / W), i = k % W;
            const s = cube.sample('t2m', centreLat(j), centreLon(i), t);
            const want = resolver._weatherScratch[k * 4];
            assert.ok(Math.abs(s.value - want) < 1e-4, `t=${(t - T0) / HOUR}h cell ${k}: cube ${s.value} vs resolver ${want}`);
            compared++;
        }
    }
    assert.ok(compared > 300, `compared ${compared}`);
});

await check('NEGATIVE CONTROL: with the seam blend off the cube must disagree with the resolver inside the seam', async () => {
    const { history, provider, issued } = await world();
    const feed = { weatherBuffer: new Float32Array(TEXF), windBuffer: new Float32Array(TEXF), cloudBuffer: new Float32Array(TEXF), meta: {}, _decodeCoarse: identityDecode };
    const resolver = new WeatherFrameResolver({ feed, history, forecastProvider: provider, minRepaintMs: 0 });
    const noSeam = new WeatherCube({ history, nowcast: provider, seamBlendMs: 0 });
    const t = issued + 24 * HOUR - SEAM_BLEND_MS / 4;     // w = 0.75
    resolver._dispatchReplay(t);
    const k = 500, j = Math.floor(k / W), i = k % W;
    const s = noSeam.sample('t2m', centreLat(j), centreLon(i), t);
    assert.ok(Math.abs(s.value - resolver._weatherScratch[k * 4]) > 0.1, 'the parity check would not see a missing seam');
    const withSeam = new WeatherCube({ history, nowcast: provider });
    assert.equal(withSeam.sample('t2m', 0, 0, t).blendW, 0.75);
});

await check('collision: an observation overwrites a forecast row at the same hour', async () => {
    const history = await freshHistory();
    const t = T0 + 5 * HOUR;
    history.ingestForecast({ t, source: 'fc', gridW: W, gridH: H, coarse: frame(0, 99) });
    history.ingest({ t, source: 'obs', gridW: W, gridH: H, coarse: frame(0, 7) });
    const cube = new WeatherCube({ history });
    const s = cube.sample('t2m', 0, 0, t);
    assert.equal(s.value, 7);
    assert.equal(s.provenance, PROVENANCE.OBSERVED);
    assert.equal(s.source, 'obs');
});

await check('gaps are null, never 0; held instants are flagged and nulled in a series', async () => {
    const history = await freshHistory();
    const f = frame(1);
    f[0] = NaN;                                   // T at cell 0 missing
    history.ingest({ t: T0, source: 'obs', gridW: W, gridH: H, coarse: f });
    history.ingest({ t: T0 + HOUR, source: 'obs', gridW: W, gridH: H, coarse: frame(2) });
    // A 6 h hole, then one more frame.
    history.ingest({ t: T0 + 7 * HOUR, source: 'obs', gridW: W, gridH: H, coarse: frame(3) });
    const cube = new WeatherCube({ history });
    assert.equal(cube.sample('t2m', centreLat(0), centreLon(0), T0 + 0.5 * HOUR).value, null, 'NaN corner must give null');
    assert.notEqual(cube.sample('t2m', centreLat(1), centreLon(1), T0 + 0.5 * HOUR).value, null);
    const inHole = cube.sample('t2m', 0, 0, T0 + 4 * HOUR);
    assert.equal(inHole.held, true, 'a gap wider than MAX_INTERP_GAP_MS is held, not interpolated');
    const after = cube.sample('t2m', 0, 0, T0 + 30 * HOUR);
    assert.equal(after.held, true);
    const s = cube.series(['t2m'], 0, 0, T0 - 2 * HOUR, T0 + 9 * HOUR);
    const v = Array.from(s.values.t2m);
    assert.ok(Number.isNaN(v[0]) && Number.isNaN(v[1]), 'before the data: null (NaN), not a frozen frame');
    assert.ok(Number.isFinite(v[2]) && Number.isFinite(v[3]));
    assert.ok(v.slice(4, 9).every(Number.isNaN), 'inside the 6 h hole: null');
    assert.ok(Number.isFinite(v[9]));
    assert.ok(Number.isNaN(v[10]) && Number.isNaN(v[11]), 'after the data: null');
    assert.equal(s.provenance[0], null);
    // hold:true returns the render's frozen value instead.
    assert.ok(Number.isFinite(cube.series(['t2m'], 0, 0, T0 + 30 * HOUR, T0 + 30 * HOUR, { hold: true }).values.t2m[0]));
    assert.ok(MAX_INTERP_GAP_MS >= 2 * HOUR);
});

await check('provenance labels and coverage runs', async () => {
    const { history, provider, issued } = await world();
    const cube = new WeatherCube({ history, nowcast: provider });
    assert.equal(cube.sample('t2m', 0, 0, T0 + 3 * HOUR).provenance, PROVENANCE.OBSERVED);
    assert.equal(cube.sample('t2m', 0, 0, issued).provenance, PROVENANCE.OBSERVED, 'the observation hour stays observed');
    assert.equal(cube.sample('t2m', 0, 0, issued + 5 * HOUR).provenance, PROVENANCE.NOWCAST);
    assert.equal(cube.sample('t2m', 0, 0, issued + 30 * HOUR).provenance, PROVENANCE.NWP);
    const runs = cube.coverage();
    assert.deepEqual(runs.map((r) => r.provenance), ['observed', 'nowcast', 'nwp']);
    assert.equal(runs[0].t0, T0);
    assert.equal(runs[0].t1, issued);
    assert.equal(runs[1].t0, issued, 'nowcast joins the observations edge to edge');
    assert.equal(runs[1].t1, issued + 24 * HOUR);
    assert.equal(runs[2].t0, issued + 24 * HOUR);
    assert.equal(runs[2].t1, issued + 72 * HOUR);
    // A stale observed frame starts its own run.
    const h2 = await freshHistory();
    h2.ingest({ t: T0, source: 'a', gridW: W, gridH: H, coarse: frame(1) });
    h2.ingest({ t: T0 + HOUR, source: 'met-norway:72x36', freshness: 'stale', gridW: W, gridH: H, coarse: frame(2) });
    h2.ingest({ t: T0 + 9 * HOUR, source: 'a', gridW: W, gridH: H, coarse: frame(3) });
    const r2 = new WeatherCube({ history: h2 }).coverage();
    assert.equal(r2.length, 3);
    assert.equal(r2[1].stale, true);
    assert.equal(r2[2].t0, T0 + 9 * HOUR, 'a hole wider than the gap starts a fresh run');
});

await check('derived variables: wind, FROM-direction, cloud total, dew point', async () => {
    const history = await freshHistory();
    const f = frame(0, 0);
    for (let k = 0; k < N; k++) {
        f[0 * N + k] = 20; f[2 * N + k] = 50;     // T, RH
        f[3 * N + k] = 0;  f[4 * N + k] = -5;     // wind blowing toward the south = FROM the north
        f[5 * N + k] = 50; f[6 * N + k] = 50; f[7 * N + k] = 0;
    }
    history.ingest({ t: T0, source: 'obs', gridW: W, gridH: H, coarse: f });
    const cube = new WeatherCube({ history });
    const m = cube.sampleMany(['wind', 'windDirDeg', 'cloudTotal', 'dewpoint'], 40, -100, T0).values;
    assert.ok(Math.abs(m.wind - 5) < 1e-6);
    assert.ok(Math.abs(m.windDirDeg - 0) < 1e-6 || Math.abs(m.windDirDeg - 360) < 1e-6, `dir ${m.windDirDeg}`);
    assert.ok(Math.abs(m.cloudTotal - 75) < 1e-6, `random overlap of 50/50/0 is 75, got ${m.cloudTotal}`);
    assert.ok(Math.abs(m.dewpoint - dewPointC(20, 50)) < 1e-9);
    // A westerly (u > 0) blows FROM 270°.
    for (let k = 0; k < N; k++) { f[3 * N + k] = 4; f[4 * N + k] = 0; }
    history.ingest({ t: T0, source: 'obs', gridW: W, gridH: H, coarse: f });
    assert.ok(Math.abs(cube.sample('windDirDeg', 0, 0, T0).value - 270) < 1e-6);
});

await check('index is rebuilt only on a data change, including a same-hour replacement', async () => {
    const { history, provider } = await world();
    const cube = new WeatherCube({ history, nowcast: provider });
    const v1 = cube.version;
    cube.sample('t2m', 0, 0, T0); cube.coverage();
    assert.equal(cube.version, v1, 'reads must not rebuild');
    history.ingest({ t: T0 + 2 * HOUR, source: 'obs', gridW: W, gridH: H, coarse: frame(0, 42) });   // replaces, sizes unchanged
    assert.ok(cube.version > v1, 'a same-hour replacement must invalidate');
    assert.equal(cube.sample('t2m', 0, 0, T0 + 2 * HOUR).value, 42);
    const v2 = cube.version;
    provider._applyDense(null);
    assert.ok(cube.version > v2, 'a nowcast swap must invalidate');
    assert.equal(cube.stats().nowcastFrames, 0);
});

await check('speed: 21-day hourly series of five variables', async () => {
    const { history, provider } = await world();
    const cube = new WeatherCube({ history, nowcast: provider });
    const vars = ['t2m', 'precip', 'cloudTotal', 'wind', 'mslp'];
    cube.series(vars, 40, -100, T0 - 7 * 24 * HOUR, T0 + 14 * 24 * HOUR);   // warm
    const t0 = performance.now();
    const reps = 20;
    for (let r = 0; r < reps; r++) cube.series(vars, 40 + r, -100, T0 - 7 * 24 * HOUR, T0 + 14 * 24 * HOUR);
    const ms = (performance.now() - t0) / reps;
    console.log(`     ${ms.toFixed(2)} ms per 505-sample series`);
    assert.ok(ms < 8, `series too slow: ${ms.toFixed(2)} ms`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
