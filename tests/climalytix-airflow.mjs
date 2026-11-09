#!/usr/bin/env node
/**
 * climalytix-airflow.mjs — node gate for js/climalytix/airflow.js.
 *
 *   · a westerly (u > 0) is FROM 270°, a southerly (v > 0) FROM 180° — the
 *     sign trap, both axes
 *   · displace moves exactly u·Δt east and v·Δt north in METRES, with cos φ —
 *     NEGATIVE CONTROL: without cos φ the 60° east–west distance is 2× off
 *   · windAt is exact on a planar field and interpolates linearly in time,
 *     null outside the nodes and on a gap corner
 *   · particles in a uniform westerly all move east by the compressed
 *     distance, never leave the data box, are reborn on gaps, and the system
 *     is deterministic per seed
 *   · streamlines in a solid-body vortex stay on their circle (midpoint rule)
 *   · the rose bins by FROM direction, counts calms, and the pollution rose's
 *     per-sector mean is exact
 *
 *   node tests/climalytix-airflow.mjs
 */

import assert from 'node:assert/strict';
import {
    windAt, displace, fromDirection, createFlow, streamlines, windRose, prevailing, fieldBox,
    speed01, pollutionRose, compressionFor, compressionLabel, FLOW_COMPRESSION, FLOW_COMPRESSIONS, FLOW_TARGET_PX_S, CALM_MS,
} from '../js/climalytix/airflow.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
console.log('climalytix airflow');

const M_PER_DEG = 111_320;
const R_EARTH_M = 6_371_000;

/** A field over a 3° window around (40, −105), nt times, wind from fn(lat, lon, t). */
function field(fn, { nt = 3, latN = 43, lonW = -108, d = 0.25, n = 25 } = {}) {
    const plane = n * n, u = new Array(nt * plane), v = new Array(nt * plane);
    for (let t = 0; t < nt; t++) for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const w = fn(latN - i * d, lonW + j * d, t);
        u[t * plane + i * n + j] = w.u; v[t * plane + i * n + j] = w.v;
    }
    return { latN, lonW, dlat: d, dlon: d, nRows: n, nCols: n, u, v };
}

ok('direction is where the wind blows FROM: westerly 270°, southerly 180°, NE 45°', () => {
    assert.equal(fromDirection(5, 0), 270);
    assert.equal(fromDirection(-5, 0), 90);
    assert.equal(fromDirection(0, 5), 180);
    assert.equal(fromDirection(0, -5), 0);
    assert.ok(Math.abs(fromDirection(-3, -3) - 45) < 1e-9, 'blowing to the SW = from the NE');
});

ok('displace: exact metres in each axis, with cos φ — NEGATIVE CONTROL without it', () => {
    const e = displace(0, 0, 10, 0, 3600);
    assert.ok(Math.abs(e.lon * M_PER_DEG - 36_000) < 1e-6 && e.lat === 0, 'equator: 36 km east');
    const n = displace(60, 10, 0, 10, 3600);
    assert.ok(Math.abs((n.lat - 60) * M_PER_DEG - 36_000) < 1e-6 && n.lon === 10, '36 km north');
    // At 60° a degree of longitude is half as wide: 36 km east is twice the degrees.
    const h = displace(60, 10, 10, 0, 3600);
    const metres = (h.lon - 10) * M_PER_DEG * Math.cos(60 * Math.PI / 180);
    assert.ok(Math.abs(metres - 36_000) < 1e-6, `${metres}`);
    const bad = displace(60, 10, 10, 0, 3600, { cosLat: false });
    const badM = (bad.lon - 10) * M_PER_DEG * Math.cos(60 * Math.PI / 180);
    assert.ok(Math.abs(badM - 18_000) < 1e-6, 'control: cos-blind moves half the distance');
    // The degree is the equatorial one map-view's scale bar uses (111.32 km);
    // the mean-radius degree is 0.11 % shorter — far below a drawn streak.
    assert.ok(Math.abs(M_PER_DEG - R_EARTH_M * Math.PI / 180) / M_PER_DEG < 2e-3);
});

ok('windAt: exact on a planar field, linear in time, null outside and on a gap corner', () => {
    const f = field((lat, lon, t) => ({ u: 2 + (lon + 105) + t, v: -1 + 0.5 * (lat - 40) }));
    const w = windAt(f, 1, 40.1, -104.93);
    assert.ok(Math.abs(w.u - (2 + 0.07 + 1)) < 1e-9 && Math.abs(w.v - (-1 + 0.05)) < 1e-9);
    const h = windAt(f, 1.25, 40.1, -104.93);
    assert.ok(Math.abs(h.u - (2 + 0.07 + 1.25)) < 1e-9, 'fractional time interpolates');
    assert.equal(windAt(f, 1, 43.5, -105), null, 'north of the nodes');
    assert.equal(windAt(f, 3, 40, -105), null, 'past the last time');
    f.u[1 * 625 + 12 * 25 + 12] = null;                        // node (40, −105) at t=1
    assert.equal(windAt(f, 1, 40.1, -104.9), null, 'a gap corner');
    assert.ok(windAt(f, 0, 40.1, -104.9), 'other times unaffected');
});

ok('particles in a uniform westerly all move east by the compressed distance, deterministically', () => {
    const f = field(() => ({ u: 10, v: 0 }));
    const a = createFlow(f, { count: 200, seed: 3, lifeS: [100, 100] });
    const before = a.particles.map((p) => ({ ...p }));
    a.step(0.05, 0);                                          // 0.05 wall s = 180 s of air
    let moved = 0;
    a.particles.forEach((p, k) => {
        if (p.born) return;
        moved++;
        assert.equal(p.lat, before[k].lat);
        const metres = (p.lon - before[k].lon) * M_PER_DEG * Math.cos(p.lat * Math.PI / 180);
        assert.ok(Math.abs(metres - 10 * 0.05 * FLOW_COMPRESSION) < 1e-6, `${metres}`);
    });
    assert.ok(moved > 190, `${moved} moved (the rest were reborn at the east edge)`);
    const b = createFlow(f, { count: 200, seed: 3, lifeS: [100, 100] });
    b.step(0.05, 0);
    assert.deepEqual(b.particles.map((p) => [p.lat, p.lon]), a.particles.map((p) => [p.lat, p.lon]), 'same seed, same frame');
    const c = createFlow(f, { count: 200, seed: 4, lifeS: [100, 100] });
    assert.notDeepEqual(c.particles.map((p) => p.lat), b.particles.map((p) => p.lat), 'another seed differs');
});

ok('particles never leave the data box, and are reborn on gaps and at end of life', () => {
    const f = field((lat, lon) => ({ u: 30 * Math.sin(lat), v: 30 * Math.cos(lon) }));
    const box = fieldBox(f);
    const flow = createFlow(f, { count: 400, seed: 9 });
    for (let k = 0; k < 200; k++) {
        flow.step(1 / 30, 1);
        for (const p of flow.particles) {
            assert.ok(p.lat <= box.north && p.lat >= box.south && p.lon >= box.west && p.lon <= box.east);
        }
    }
    // Every node at t = 2 a gap: every particle is reborn each step and none moves.
    const g = field(() => ({ u: 5, v: 5 }));
    for (let k = 2 * 625; k < 3 * 625; k++) g.u[k] = null;
    const flow2 = createFlow(g, { count: 50, seed: 2 });
    flow2.step(0.1, 2);
    assert.ok(flow2.particles.every((p) => p.born && p.prevLat === p.lat), 'reborn, no streak across the map');
});

ok('streamlines of a solid-body vortex stay on their circle (midpoint rule)', () => {
    // Rotation about (40, −105) in metres: u = −ω y, v = ω x.
    const omega = 2e-5;
    const f = field((lat, lon) => {
        const y = (lat - 40) * M_PER_DEG, x = (lon + 105) * M_PER_DEG * Math.cos(lat * Math.PI / 180);
        return { u: -omega * y, v: omega * x };
    });
    const lines = streamlines(f, 0, { n: 6, steps: 20, stepS: 1200 });
    assert.ok(lines.length > 10);
    for (const l of lines) {
        const r = l.pts.map((p) => Math.hypot((p.lat - 40) * M_PER_DEG, (p.lon + 105) * M_PER_DEG * Math.cos(p.lat * Math.PI / 180)));
        const drift = Math.abs(r[r.length - 1] - r[0]) / Math.max(r[0], 1);
        assert.ok(drift < 0.03 || r[0] < 20_000, `radius drift ${(drift * 100).toFixed(2)} %`);
    }
});

ok('rose: binned by FROM direction, calms counted, pollution-rose means exact', () => {
    // 6 westerlies (u>0), 3 southerlies, 1 calm.
    const u = [5, 5, 6, 7, 3, 9, 0, 0, 0, 0.1];
    const v = [0, 0, 0, 0, 0, 0, 4, 4, 4, 0.1];
    const pm = [10, 20, 30, 40, 50, 60, 5, 5, 8, 99];
    const r = windRose(u, v, { value: pm });
    assert.equal(r.n, 10);
    assert.equal(r.calm, 1);
    assert.ok(Math.abs(r.freq[12] - 0.6) < 1e-12, 'W sector (index 12) holds the westerlies');
    assert.ok(Math.abs(r.freq[8] - 0.3) < 1e-12, 'S sector (index 8) holds the southerlies');
    assert.equal(r.freq[4], 0, 'nothing from the east — the sign trap would put them here');
    assert.equal(r.mean[12], 35);
    assert.equal(r.mean[8], 6);
    assert.equal(r.mean[0], null);
    assert.deepEqual(prevailing(r), { name: 'W', deg: 270, freq: 0.6 });
    // Speed classes: 3 m/s is in class 1 (2–5), 9 in class 3 (8–12).
    assert.equal(r.counts[12][1], 1);
    assert.equal(r.counts[12][3], 1);
    assert.ok(CALM_MS > 0.1 * Math.SQRT2);
    assert.equal(speed01(30, 0), 1);
});

ok('compression follows the zoom: 10 m/s crosses ~45 px/s, from a fixed list, labelled', () => {
    for (const pxPerM of [1 / 500, 1 / 2000, 1 / 8000, 1 / 30000]) {
        const c = compressionFor(pxPerM);
        assert.ok(FLOW_COMPRESSIONS.includes(c));
        const pxS = 10 * c * pxPerM;
        assert.ok(pxS > FLOW_TARGET_PX_S / 2 && pxS < FLOW_TARGET_PX_S * 2, `${pxS.toFixed(1)} px/s at 1/${1 / pxPerM}`);
    }
    assert.equal(compressionLabel(3600), '1 s = 1 h');
    assert.equal(compressionLabel(900), '1 s = 15 min');
    assert.equal(compressionLabel(86400), '1 s = 24 h');
});

ok('a flow REGION keeps every particle inside both the region and the data box', () => {
    const f = field(() => ({ u: 8, v: 3 }));
    const region = { north: 41, south: 39, west: -106, east: -100 };      // east part runs off the box
    const flow = createFlow(f, { count: 300, seed: 5, region });
    for (let k = 0; k < 100; k++) {
        flow.step(1 / 30, 0);
        for (const p of flow.particles) {
            assert.ok(p.lat <= 41 && p.lat >= 39 && p.lon >= -106 && p.lon <= fieldBox(f).east, `${p.lat},${p.lon}`);
        }
    }
    assert.equal(createFlow(f, { region: { north: 10, south: 0, west: 0, east: 10 } }).particles.length, 0, 'no overlap: no particles');
});

ok('pollution rose: only hours with wind AND value; dirtiest/cleanest need ≥ 2 hours', () => {
    // 3 NW hours dirty (30), 3 S hours clean (5), 1 E hour very dirty but alone, 2 hours with no PM.
    const u = [3, 3, 3, 0, 0, 0, -4, 3, 0];
    const v = [-3, -3, -3, 4, 4, 4, 0, -3, 4];
    const pm = [30, 30, 30, 5, 5, 5, 90, null, null];
    const r = pollutionRose(u, v, pm);
    assert.equal(r.hours, 7);
    assert.equal(r.n, 7, 'hours without a value are not counted at all');
    assert.deepEqual(r.dirtiest, { name: 'NW', sector: 14, mean: 30, hours: 3 }, 'the lone 90 from the E is an anecdote');
    assert.deepEqual(r.cleanest, { name: 'S', sector: 8, mean: 5, hours: 3 });
    assert.equal(r.mean[4], 90, 'but its mean is still reported');
    assert.equal(pollutionRose([1], [1], [null]), null);
});

console.log(`\n${passed} passed`);
