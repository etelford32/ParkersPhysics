/**
 * Node gate for js/climalytix/cold-pool.js — night cold-air pooling:
 * ΔT = gain · I(t) · clamp(h_rel / depth, ±1).
 *
 * Identities and closed forms, not remembered numbers:
 *   · FLAT GROUND AND A UNIFORM SLOPE GET EXACTLY 0 at every height — the
 *     term is a departure from what GFS already cools, and a high plateau
 *     pools nothing. NEGATIVE CONTROL: the same law on ABSOLUTE height makes
 *     the plateau "a ridge"
 *   · the summed-area box mean ≡ a brute-force mean, gaps left out
 *   · a V-valley's floor sits s·R/2 below its box mean (closed form), a
 *     ridge the same amount above, and the box is the same DISTANCE east–west
 *     as north–south at 60° N
 *   · the inversion is slope-wind.js's own night budget (LW_CLEAR / H_NIGHT),
 *     it is 0 by day, builds after sunset as 1 − e^(−t/τ) and is ERODED by
 *     the Sun as e^(−t/τ_erode). NEGATIVE CONTROL: one passive memory leaves
 *     a pool standing at midday
 *   · cloud and wind only ever weaken it; an unknown one is the upper bound
 *   · floor colder, crest milder, nothing past the cap
 */
import assert from 'node:assert/strict';
import { POOL, INVERSION_CLEAR_K, nightSamples, nightFraction, poolMixing, inversionK, poolDeltaK, relativeHeight, coldPoolGrid } from '../js/climalytix/cold-pool.js';
import { LW_CLEAR, LW_CLOUD, H_NIGHT, surfaceBudget } from '../js/climalytix/slope-wind.js';
import { AMP_CAP_K } from '../js/climalytix/sun-temp.js';
import { sampleGrid } from '../js/climalytix/terrain.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);
const KM = 111.195;

// ── flat ground and a uniform slope are exactly zero ────────────────────────
const box = { north: 40.5, south: 39.5, west: -105.6, east: -104.4 };
const grid = (h, b = box, n = 121) => sampleGrid(b, n, n, h);
for (const z of [0, 1600, 3000]) {
    const g = grid(() => z), hr = relativeHeight(g);
    assert.ok(hr.every((v) => v === 0), `a plain at ${z} m has no relative height`);
    const out = coldPoolGrid(g, hr, { nightFrac: 1 });
    assert.deepEqual([out.range.min, out.range.max], [0, 0], `a plain at ${z} m pools nothing on the clearest, calmest night`);
}
{
    // A uniform north–south slope: interior cells see as much ground above as below.
    const g = grid((lat) => 1000 + 3000 * (lat - 39.5)), hr = relativeHeight(g);
    const k = 60 * g.nCols + 60;
    near(hr[k], 0, 0.01, 'the middle of a uniform slope is level with its surroundings');
    // NEGATIVE CONTROL: absolute height instead of relative height.
    const plateau = grid(() => 3000);
    const wrong = poolDeltaK(plateau.values[0] - 1600, inversionK({ nightFrac: 1 }));
    assert.ok(wrong > 2, `on absolute height a 3000 m plateau would read ${wrong.toFixed(1)} K "milder" — it is flat, the answer is 0`);
}

// ── the box mean is exact ───────────────────────────────────────────────────
{
    const rough = (lat, lon) => 1500 + 400 * Math.sin(lat * 37) * Math.cos(lon * 29) + (lat > 40.2 && lon < -105.3 ? NaN : 0);
    const g = grid(rough, box, 61), hr = relativeHeight(g);
    const ri = Math.max(1, Math.round(POOL.radiusKm / (g.dlat * KM)));
    let worst = 0, gaps = 0;
    for (const [i, j] of [[0, 0], [5, 7], [30, 30], [60, 60], [12, 3], [44, 58], [8, 20]]) {
        const v = g.values[i * g.nCols + j];
        if (!Number.isFinite(v)) { assert.ok(Number.isNaN(hr[i * g.nCols + j]), 'no terrain ⇒ no relative height'); gaps++; continue; }
        const rj = Math.max(1, Math.round(POOL.radiusKm / (g.dlon * KM * Math.cos((g.latN - i * g.dlat) * Math.PI / 180))));
        let s = 0, c = 0;
        for (let a = Math.max(0, i - ri); a <= Math.min(g.nRows - 1, i + ri); a++) for (let b = Math.max(0, j - rj); b <= Math.min(g.nCols - 1, j + rj); b++) {
            const z = g.values[a * g.nCols + b];
            if (Number.isFinite(z)) { s += z; c++; }
        }
        worst = Math.max(worst, Math.abs(hr[i * g.nCols + j] - (v - s / c)));
    }
    assert.ok(worst < 0.02, `summed-area mean ≡ brute force (worst ${worst.toExponential(1)} m)`);
    assert.ok(gaps >= 1, 'the probe set includes a gap');
}

// ── a V-valley and a ridge: closed form ─────────────────────────────────────
{
    // z = s·|distance north of the axis|, s = 0.05 (50 m per km), on a fine grid.
    const s = 50, fine = { north: 40.2, south: 39.8, west: -105.2, east: -104.8 };
    const valley = sampleGrid(fine, 201, 201, (lat) => 1500 + s * Math.abs(lat - 40) * KM);
    const hv = relativeHeight(valley), mid = 100 * 201 + 100;
    const ri = Math.round(POOL.radiusKm / (valley.dlat * KM)), Reff = ri * valley.dlat * KM;
    // Discrete mean of |d| over 2·ri+1 rows: s·dy·ri(ri+1)/(2ri+1).
    const exact = -s * valley.dlat * KM * ri * (ri + 1) / (2 * ri + 1);
    near(hv[mid], exact, 0.05, 'valley floor below its box mean');
    near(hv[mid], -s * Reff / 2, 5, '≈ −s·R/2 (the continuum limit; the discrete box is half a node wider)');
    const ridge = sampleGrid(fine, 201, 201, (lat) => 2500 - s * Math.abs(lat - 40) * KM);
    near(relativeHeight(ridge)[mid], -exact, 0.05, 'a ridge is the valley upside down');
    const inv = inversionK({ nightFrac: 1 });
    const floor = poolDeltaK(hv[mid], inv), crest = poolDeltaK(-hv[mid], inv);
    near(floor, -POOL.gain * inv * Math.min(1, -hv[mid] / POOL.depthM), 1e-9, 'floor ΔT');
    assert.ok(floor < -1 && crest > 1 && near(floor, -crest, 1e-9, 'antisymmetric') === undefined, 'floor colder, crest milder');
    assert.ok(crest - floor > 3 && crest - floor < 10, `floor-to-belt ${(crest - floor).toFixed(1)} K sits in the measured 3–10 K`);
    // Same distance east–west as north–south at 60° N: a valley running N–S reads the same depth.
    const hi = { north: 60.2, south: 59.8, west: 9.6, east: 10.4 };
    const cos = Math.cos(60 * Math.PI / 180);
    const ew = sampleGrid(hi, 201, 201, (lat, lon) => 500 + s * Math.abs(lon - 10) * KM * cos);
    const ns = sampleGrid(hi, 201, 201, (lat) => 500 + s * Math.abs(lat - 60) * KM);
    near(relativeHeight(ew)[mid], relativeHeight(ns)[mid], 3, 'the box is the same distance in both directions at 60° N');
}

// ── the inversion: slope-wind's own budget, an exact memory ─────────────────
assert.equal(INVERSION_CLEAR_K, LW_CLEAR / H_NIGHT, 'one night budget, slope-wind.js\'s');
near(INVERSION_CLEAR_K, -surfaceBudget({ incidence: 0, sunAltDeg: -10 }).q / H_NIGHT, 1e-9, 'the same number the slope-wind layer cools a night slope by');
{
    const t = Date.UTC(2026, 10, 10, 9, 20);
    const smp = nightSamples(t);
    const T = (t - smp[smp.length - 1].a) / 1000;
    assert.ok(T >= POOL.intervals * POOL.stepS, 'the memory reaches back the whole night');
    const down = { altitudeDeg: -20 }, up = { altitudeDeg: 30 };
    assert.equal(nightFraction(smp.map((s) => ({ ...s, sun: up }))), 0, 'broad daylight: no pool');
    near(nightFraction(smp.map((s) => ({ ...s, sun: down }))), 1 - Math.exp(-T / POOL.tauS), 1e-12, 'a whole night: 1 − e^(−T/τ)');
    // Sunset on a step mark `hours` ago: 1 − e^(−t/τ). Sunrise then instead: the night's pool × e^(−t/τ_erode).
    const mark = Math.floor(t / 3_600_000) * 3_600_000, since = mark - 3_600_000, hours = (t - since) / 3_600_000;
    const evening = nightFraction(smp.map((s) => ({ ...s, sun: s.a >= since ? down : up })));
    near(evening, 1 - Math.exp(-hours * 3600 / POOL.tauS), 1e-12, 'builds after sunset as 1 − e^(−t/τ)');
    const before = 1 - Math.exp(-(T - hours * 3600) / POOL.tauS);
    const morning = nightFraction(smp.map((s) => ({ ...s, sun: s.a >= since ? up : down })));
    near(morning, before * Math.exp(-hours * 3600 / POOL.erodeS), 1e-12, 'sunlight erodes it as e^(−t/τ_erode)');
    assert.ok(evening > 0.3 && evening < 0.6, `${hours.toFixed(2)} h after sunset the pool is partly built (${evening.toFixed(2)})`);
    assert.ok(morning > 0.1 && morning < 0.4, `${hours.toFixed(2)} h after sunrise some of it is still there (${morning.toFixed(2)})`);
    // By solar noon it is gone. NEGATIVE CONTROL: one passive 3 h memory leaves a visible pool at noon.
    const noonish = nightFraction(smp.map((s) => ({ ...s, sun: s.a >= mark - 6 * 3_600_000 ? up : down })));
    assert.ok(noonish < 0.005, `six hours of Sun leave ${(100 * noonish).toFixed(2)} % of the pool`);
    const passive = Math.exp(-(t - (mark - 6 * 3_600_000)) / 1000 / POOL.tauS) - Math.exp(-T / POOL.tauS);
    assert.ok(passive > 0.05, `a passive memory would leave ${(100 * passive).toFixed(0)} % standing at midday`);
}
near(inversionK({ nightFrac: 1 }), 4, 1e-9, 'clear, calm, all night: 4 K');
near(inversionK({ nightFrac: 1, cloudFrac: 1 }), 4 * (1 - LW_CLOUD), 1e-9, 'overcast leaves a tenth');
assert.equal(inversionK({ nightFrac: 0 }), 0, 'day: none');
near(poolMixing(POOL.windMs), 0.5, 1e-12, 'half at the mixing speed');
assert.ok(poolMixing(9) < 0.11 && poolMixing(0) === 1 && poolMixing(null) === 1, 'wind flushes a pool; unknown wind is the upper bound');
for (const c of [0, 0.3, 0.7, 1]) for (const u of [0, 1, 3, 8]) {
    assert.ok(inversionK({ nightFrac: 0.8, cloudFrac: c, windMs: u }) <= inversionK({ nightFrac: 0.8 }) + 1e-12, 'cloud and wind only weaken it');
}
assert.equal(inversionK({ nightFrac: 1, cloudFrac: null }), inversionK({ nightFrac: 1, cloudFrac: 0 }), 'unknown cloud = clear sky (upper bound)');

// ── the grid ────────────────────────────────────────────────────────────────
{
    const s = 80, fine = { north: 40.2, south: 39.8, west: -105.2, east: -104.8 };
    const g = sampleGrid(fine, 161, 161, (lat) => 1500 + s * Math.abs(lat - 40) * KM), hr = relativeHeight(g), mid = 80 * 161 + 80;
    const night = coldPoolGrid(g, hr, { nightFrac: 0.9 });
    assert.ok(night.active && night.values[mid] < -2, `valley floor ${night.values[mid].toFixed(2)} K on a clear calm night`);
    near(night.values[40 * 161 + 80], 0, 0.02, 'the uniform flank above it is unchanged');
    assert.ok(night.range.min >= -AMP_CAP_K && night.range.max <= AMP_CAP_K, 'inside the cap');
    const cloudy = coldPoolGrid(g, hr, { nightFrac: 0.9, cloudAt: () => 1 }), windy = coldPoolGrid(g, hr, { nightFrac: 0.9, windAt: () => 9 });
    near(cloudy.values[mid], night.values[mid] * (1 - LW_CLOUD), 1e-6, 'overcast: a tenth');
    near(windy.values[mid], night.values[mid] * poolMixing(9), 1e-6, 'a 9 m/s wind flushes it');
    const day = coldPoolGrid(g, hr, { nightFrac: 0 });
    assert.ok(!day.active && day.range.min === 0 && day.range.max === 0, 'by day there is no pool');
    const dregs = coldPoolGrid(g, hr, { nightFrac: POOL.minFrac / 2 });
    assert.ok(!dregs.active && dregs.range.min === 0, 'a remnant under 1 % is not a pool');
    assert.equal(poolDeltaK(-1e6, 1e3), -AMP_CAP_K, 'the cap holds');
    assert.ok(Number.isNaN(poolDeltaK(NaN, 4)), 'no terrain ⇒ no value');
}

console.log('climalytix-cold-pool: ok');
