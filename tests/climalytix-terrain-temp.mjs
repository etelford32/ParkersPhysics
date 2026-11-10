/**
 * Node gate for js/climalytix/terrain-temp.js — GFS 2 m temperature brought
 * down to the real ground: T = T_gfs + Γ·(z_dem − z_gfs).
 *
 *   · the model's surface height from its own two pressures reproduces the
 *     ICAO standard atmosphere (to 0.15 %: 0.1 m at 1 500 m, 4.5 m at 4 500 m)
 *   · the lapse fit recovers a PLANTED Γ, including an inversion, exactly on
 *     noiseless data and closely under noise
 *   · NEGATIVE CONTROL: without the horizontal terms a west–east temperature
 *     gradient across rising ground is read as a lapse rate
 *   · too little relief / too few nodes ⇒ the standard −6.5, and it says why
 *   · an absurd fit is clamped to physical bounds, and the raw value is kept
 *   · the correction: a valley 800 m below the model surface is warmer by
 *     Γ·Δz; a gap in any input is a gap out (never 0); flat ground at the
 *     model's own height is untouched
 */
import assert from 'node:assert/strict';
import {
    modelElevationM, fitLapse, downscaleT, downscaleGrid, lapseText,
    STANDARD_LAPSE_K_PER_KM, LAPSE_BOUNDS, MIN_SPAN_M, MIN_NODES,
} from '../js/climalytix/terrain-temp.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

// ── model height: ICAO standard atmosphere (p0 1013.25 hPa, T0 15 °C, −6.5 K/km) ──
const icaoP = (z) => 1013.25 * (1 - 0.0065 * z / 288.15) ** 5.25588;
for (const z of [0, 250, 1500, 3000, 4500]) {
    near(modelElevationM(1013.25, icaoP(z), 15 - 0.0065 * z), z, 1 + 0.0015 * z, `ICAO ${z} m`);   // 4.5 m at 4 500 m: the layer-mean approximation
}
assert.ok(modelElevationM(1000, 1012, 10) < 0, 'ground below sea level is a negative height, not clamped');
for (const bad of [[NaN, 900, 5], [1013, 0, 5], [1013, 900, null], [-1, 900, 5]]) {
    assert.ok(Number.isNaN(modelElevationM(...bad)), `a missing input is NaN: ${bad}`);
}

// ── a synthetic window: ground rising to the west, a planted Γ and a planted W–E gradient ──
let seed = 7;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
function window({ gamma, dTdx = 0, dTdy = 0, noise = 0, zOf = (x) => 1500 + 900 * Math.max(0, -x) + 300 * rnd(), n = 33 }) {
    const nodes = [];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const x = -4 + 8 * j / (n - 1), y = -4 + 8 * i / (n - 1), z = zOf(x, y);
        nodes.push({ x, y, z, t: 20 + dTdx * x + dTdy * y + gamma * z / 1000 + noise * (rnd() - 0.5) });
    }
    return nodes;
}
for (const gamma of [-6.5, -9.1, -2.0, 3.2]) {                          // +3.2 = a night inversion
    const fit = fitLapse(window({ gamma, dTdx: 0.9, dTdy: -0.4 }));
    assert.equal(fit.source, 'fitted');
    near(fit.gamma, gamma, 1e-6, `planted Γ ${gamma}, noiseless`);
    near(fit.r2, 1, 1e-9, 'a plane fits a plane');
    assert.equal(fit.n, 33 * 33);
}
near(fitLapse(window({ gamma: -6.5, dTdx: 0.9, noise: 1.5 })).gamma, -6.5, 0.4, 'Γ under ±0.75 K of noise');
{
    // NEGATIVE CONTROL: warm plains east, cold high ground west — the one-variable
    // fit books the west–east gradient as lapse rate.
    const nodes = window({ gamma: -6.5, dTdx: 1.2 });
    const naive = fitLapse(nodes, { horizontal: false });
    const full = fitLapse(nodes);
    near(full.gamma, -6.5, 1e-6, 'with horizontal terms');
    assert.ok(Math.abs(naive.raw - (-6.5)) > 1.5, `without them the lapse is wrong by ${(naive.raw + 6.5).toFixed(2)} K/km`);
}

// ── when the window cannot say ──────────────────────────────────────────────
{
    const flat = fitLapse(window({ gamma: -6.5, zOf: () => 200 + (MIN_SPAN_M - 50) * rnd() }));
    assert.equal(flat.source, 'standard');
    assert.equal(flat.gamma, STANDARD_LAPSE_K_PER_KM);
    assert.match(flat.reason, /too little relief/);
    assert.match(lapseText(flat), /standard −6\.5 K\/km \(too little relief in view\)/);
    const few = fitLapse(window({ gamma: -6.5 }).slice(0, MIN_NODES - 1));
    assert.equal(few.source, 'standard');
    assert.match(few.reason, /too few/);
    assert.equal(fitLapse([]).source, 'standard');
    assert.equal(fitLapse(null).source, 'standard');
    // Gaps are dropped, never counted as 0 °C at 0 m.
    const holes = window({ gamma: -6.5 }).map((p, k) => (k % 3 ? p : { ...p, t: NaN }));
    near(fitLapse(holes).gamma, -6.5, 1e-6, 'gaps skipped');
    // Collinear ground (every node the same height pattern in one column) is singular → standard.
    const sing = Array.from({ length: 40 }, (_, k) => ({ x: 0, y: 0, z: 1000 + 30 * k, t: 5 }));
    assert.equal(fitLapse(sing).source, 'standard');
}
{
    const wild = fitLapse(window({ gamma: -25 }));
    assert.equal(wild.gamma, LAPSE_BOUNDS.min, 'clamped to the dry adiabat');
    near(wild.raw, -25, 1e-6, 'the raw fit is kept for the record');
    assert.equal(fitLapse(window({ gamma: 12 })).gamma, LAPSE_BOUNDS.max);
}
assert.match(lapseText(fitLapse(window({ gamma: 3.2 }))), /^\+3\.2 K\/km fitted from this run’s 1,089 nodes in view — an inversion/);
assert.match(lapseText(fitLapse(window({ gamma: -6.5 }))), /^−6\.5 K\/km fitted/);

// ── the correction ──────────────────────────────────────────────────────────
near(downscaleT(10, 2400, 1600, -6.5), 15.2, 1e-9, 'a valley 800 m below the model surface is 5.2 K warmer');
near(downscaleT(10, 2400, 3600, -6.5), 2.2, 1e-9, 'a summit 1 200 m above it is 7.8 K colder');
near(downscaleT(-3, 1800, 1500, +4), -4.2, 1e-9, 'under an inversion the valley is COLDER');
assert.equal(downscaleT(10, 2400, 2400, -6.5), 10);
assert.ok(Number.isNaN(downscaleT(10, NaN, 1600, -6.5)));
{
    const dem = { latN: 41, lonW: -106, dlat: 0.5, dlon: 0.5, nRows: 3, nCols: 3,
        values: Float32Array.from([3000, 3000, 3000, 2000, NaN, 2000, 1000, 1000, 1000]) };
    const g = downscaleGrid(dem, { tAt: (lat) => (lat === 41 ? null : 10), zModelAt: () => 2000, gamma: -6.5 });
    assert.ok([0, 1, 2].every((k) => Number.isNaN(g.values[k])), 'a model gap is a gap (never 0 °C)');
    assert.ok(Number.isNaN(g.values[4]), 'a DEM gap is a gap');
    assert.equal(g.values[3], 10);
    near(g.values[6], 16.5, 1e-5, '1 000 m below ⇒ +6.5 K');
    assert.deepEqual([g.correction.min, +g.correction.max.toFixed(4)], [0, 6.5]);
    assert.deepEqual([g.nRows, g.nCols, g.latN, g.dlon], [3, 3, 41, 0.5], 'the result is in the DEM grid');
    assert.equal(downscaleGrid(dem, { tAt: () => null, zModelAt: () => 2000, gamma: -6.5 }).correction, null);
}

console.log('climalytix-terrain-temp: model height (ICAO), lapse fit + negative control, fallbacks, correction passed');
