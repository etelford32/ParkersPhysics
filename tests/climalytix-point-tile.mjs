#!/usr/bin/env node
/**
 * climalytix-point-tile.mjs — node gate for js/climalytix/point-tile.js.
 *
 * Reads the tile fixture that scripts/climalytix_ingest/tiles.py WROTE from a
 * real GFS 1° message (tests/fixtures/climalytix/tile/, pinned byte-for-byte
 * by tests/climalytix_ingest_test.py) and must reproduce, at every test point
 * and every time, the bilinear values Python computed. var1/var2 of the
 * fixture are the ROW and COLUMN index, so a layout slip reads as a wrong
 * row/column rather than a plausible temperature. Negative controls: a reader
 * with var and time swapped, and one that ignores the halo wrap.
 *
 *   node tests/climalytix-point-tile.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    locate, tileShape, tileKey, stencilRanges, readStencil, siteBody, toSiteSeries,
    runFreshness, RUN_FRESH_S, RUN_STALE_S, fieldPlan, readField, fieldBody, fieldPath,
} from '../js/climalytix/point-tile.js';
import { HOUR_MS } from '../js/climalytix/series.js';

const DIR = new URL('./fixtures/climalytix/tile/', import.meta.url);
const man = JSON.parse(readFileSync(new URL('manifest.json', DIR)));
const { points } = JSON.parse(readFileSync(new URL('expected.json', DIR)));
const tileBytes = (tr, tc) => {
    const p = (v) => String(v).padStart(2, '0');
    return new Uint8Array(readFileSync(new URL(`r${p(tr)}-c${p(tc)}.i16`, DIR)));
};

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const close = (a, b, tol, msg) => {
    if (a == null || b == null) return assert.equal(a, b, msg);
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);
};

function read(p, reader = readStencil) {
    const loc = locate(man, p.lat, p.lon);
    const bytes = tileBytes(loc.tr, loc.tc);
    const { rows, cols } = tileShape(man, loc.tr);
    assert.equal(bytes.byteLength, rows * cols * man.vars.length * man.times.length * 2, 'tile size');
    const [a, b] = stencilRanges(man, loc);
    return { loc, vals: reader(man, loc, bytes.subarray(a[0], a[1]), bytes.subarray(b[0], b[1])) };
}

console.log('climalytix point tiles (JS reader ↔ Python writer)');

ok('every fixture point lands in the tile Python used', () => {
    for (const p of points) {
        const loc = locate(man, p.lat, p.lon);
        assert.deepEqual([loc.tr, loc.tc], p.tile, p.name);
    }
    assert.equal(tileKey(man, 1, 17), 'fixture/t/r01-c17.i16');
});

ok('bilinear values match Python at every point, var and time (incl. the seam and both poles)', () => {
    for (const p of points) {
        const { vals } = read(p);
        man.vars.forEach((v, k) => {
            p.values[k].forEach((want, t) => close(vals[v.id][t], want, 1e-6, `${p.name} ${v.id} t${t}`));
        });
    }
});

ok('a gap corner reads null — never averaged away, never 0', () => {
    const p = points.find((x) => x.name.startsWith('next to the planted gap'));
    const { vals } = read(p);
    assert.equal(vals.tempC[3], null);
    assert.ok(Number.isFinite(vals.tempC[2]));
});

ok('negative control: a reader with var/time transposed fails', () => {
    const swapped = (m, loc, top, bot) => {
        const nv = m.vars.length, nt = m.times.length;
        const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
        const T = dv(top), B = dv(bot);
        const raw = (d, cell, k, t) => d.getInt16(2 * ((cell * nt + t) * nv + k), true);
        const out = {};
        m.vars.forEach((v, k) => {
            out[v.id] = m.times.map((_, t) => {
                const q = [raw(T, 0, k, t), raw(T, 1, k, t), raw(B, 0, k, t), raw(B, 1, k, t)].map((x) => x * v.scale + v.offset);
                return (1 - loc.fy) * ((1 - loc.fx) * q[0] + loc.fx * q[1]) + loc.fy * ((1 - loc.fx) * q[2] + loc.fx * q[3]);
            });
        });
        return out;
    };
    const p = points.find((x) => x.name === 'Boulder');
    const { vals } = read(p, swapped);
    assert.ok(Math.abs(vals.row[0] - p.values[1][0]) > 1, 'the row index comes back wrong');
});

ok('negative control: without the halo wrap the seam stencil reads the wrong column', () => {
    const p = points.find((x) => x.name.startsWith('seam west'));
    const loc = locate(man, p.lat, p.lon);
    assert.equal(loc.c, man.ni - 1, 'the stencil starts in the LAST column');
    // Reading column c+1 without wrapping would ask for column ni, which no
    // tile row-major index holds; the halo puts column 0 there instead.
    const { vals } = read(p);
    close(vals.col[0], p.values[2][0], 1e-9, 'col index blends 359 and 0');
    assert.ok(vals.col[0] < 359, 'blended toward column 0 through the halo');
});

ok('siteBody derives wind from u/v (not from interpolated speed) and keeps gaps', () => {
    const fake = { ...man, source: 'gfs', vars: [
        { id: 'uMs', unit: 'm/s', scale: 1, offset: 0 }, { id: 'vMs', unit: 'm/s', scale: 1, offset: 0 }],
        times: [0, 3 * HOUR_MS, 6 * HOUR_MS], intervalH: { precipMm: 3 } };
    const body = siteBody({ ...fake, dlat: 0.25, dlon: 0.25 }, { nodeLat: 40, nodeLon: 359.9 }, { uMs: [3, null, 0], vMs: [4, 1, -5] },
        { lat: 40, lon: -105, nowMs: man.runMs + 3600_000 });
    assert.deepEqual(body.series.windMs, [5, null, 5]);
    assert.equal(body.series.windDirDeg[2], 0, 'v = −5 is wind FROM the north');
    assert.deepEqual(body.site.stencil, { north: 40, south: 39.75, west: -0.1, east: 0.15 }, 'the box straddles Greenwich');
    assert.equal(body.freshness, 'fresh');
});

ok('precip is stamped at its interval START so a day sum lands in its day', () => {
    const body = { source: 'climalytix-gfs', run: 'r', runMs: 0, grid: '0p25', freshness: 'fresh',
        times: [3 * HOUR_MS, 6 * HOUR_MS], intervalH: { precipMm: 3 },
        series: { precipMm: [1, 2], tempC: [10, null] } };
    const [p, t] = toSiteSeries(body, [
        { id: 'gfs.precipMm', key: 'precipMm', label: 'P', quantity: 'precip', agg: 'sum' },
        { id: 'gfs.tempC', key: 'tempC', label: 'T', quantity: 'temp', agg: 'mean' },
    ]);
    assert.deepEqual([...p.t], [0, 3 * HOUR_MS]);
    assert.deepEqual([...t.t], [3 * HOUR_MS, 6 * HOUR_MS], 'instantaneous values keep their valid time');
    assert.ok(Number.isNaN(t.v[1]), 'a gap is NaN inside a series');
    assert.equal(p.kind, 'forecast');
    assert.equal(p.issuedAt, 0);
});

ok('run freshness bands', () => {
    assert.equal(runFreshness(0, RUN_FRESH_S * 1000).freshness, 'fresh');
    assert.equal(runFreshness(0, RUN_STALE_S * 1000).freshness, 'stale');
    assert.equal(runFreshness(0, RUN_STALE_S * 1000 + 1000).freshness, 'expired');
    assert.throws(() => locate(man, 91, 0), RangeError);
});

function readWindow(lat, lon, halfDeg) {
    const plan = fieldPlan(man, { lat, lon, halfDeg });
    const bodies = plan.segments.map((seg) => {
        const p = (v) => String(v).padStart(2, '0');
        const bytes = new Uint8Array(readFileSync(new URL(`r${p(seg.tr)}-c${p(seg.tc)}.i16`, DIR)));
        return bytes.subarray(seg.range[0], seg.range[1]);
    });
    return { plan, bodies };
}

ok('a field window reads every node from the right row and column (row/col index vars are exact)', () => {
    const { plan, bodies } = readWindow(40.015, -105.27, 3);
    assert.deepEqual(plan.rows, [47, 48, 49, 50, 51, 52], '43°N … 38°N: the window is the site ±3°');
    assert.deepEqual(plan.cols, [252, 253, 254, 255, 256, 257]);
    assert.equal(plan.latN, 43);
    assert.equal(plan.lonW, -108, 'west edge continuous with the site, not 252');
    assert.equal(plan.segments.length, plan.nRows, 'one contiguous range per row inside one tile');
    const row = readField(man, plan, 'row', bodies), col = readField(man, plan, 'col', bodies);
    const plane = plan.nRows * plan.nCols;
    for (let t = 0; t < man.times.length; t++) {
        plan.rows.forEach((r, i) => plan.cols.forEach((c, j) => {
            assert.equal(row[t * plane + i * plan.nCols + j], r + t / 4, `row @${i},${j} t${t}`);
            assert.equal(col[t * plane + i * plan.nCols + j], c, `col @${i},${j}`);
        }));
    }
});

ok('the field reproduces the point reader: bilinear on its nodes = Python’s value at the site', () => {
    const p = points.find((x) => x.name === 'Boulder');
    const { plan, bodies } = readWindow(p.lat, p.lon, 3);
    const temp = readField(man, plan, 'tempC', bodies);
    const y = (plan.latN - p.lat) / man.dlat, x = (p.lon - plan.lonW) / man.dlon;
    const i = Math.floor(y), j = Math.floor(x), fy = y - i, fx = x - j;
    const at = (a, b) => temp[a * plan.nCols + b];
    const v = (1 - fy) * ((1 - fx) * at(i, j) + fx * at(i, j + 1)) + fy * ((1 - fx) * at(i + 1, j) + fx * at(i + 1, j + 1));
    close(v, p.values[0][0], 1e-4, 'Boulder t0 through the field');
});

ok('a window across the grid seam is two segments per row and one continuous field', () => {
    const { plan, bodies } = readWindow(55, 0, 2);
    assert.deepEqual(plan.cols, [358, 359, 0, 1, 2]);
    assert.equal(plan.lonW, -2);
    assert.equal(plan.segments.length, 2 * plan.nRows);
    assert.deepEqual([...new Set(plan.segments.map((s) => s.tc))].sort((a, b) => a - b), [0, 17]);
    const col = readField(man, plan, 'col', bodies);
    assert.deepEqual([...col.slice(0, plan.nCols)], [358, 359, 0, 1, 2]);
    const temp = readField(man, plan, 'tempC', bodies);
    for (let j = 1; j < plan.nCols; j++) assert.ok(Math.abs(temp[j] - temp[j - 1]) < 8, 'no jump at the seam');
});

ok('gaps stay NaN in the field and null on the wire; the path snaps to 0.25°', () => {
    const p = { lat: 29, lon: 101 };               // window = rows 60–62, cols 100–102: tile r03-c05
    const { plan, bodies } = readWindow(p.lat, p.lon, 1);
    const temp = readField(man, plan, 'tempC', bodies);
    const plane = plan.nRows * plan.nCols;
    const i = plan.rows.indexOf(60), j = plan.cols.indexOf(100);
    assert.ok(Number.isNaN(temp[3 * plane + i * plan.nCols + j]), 'planted gap at t3');
    assert.ok(Number.isFinite(temp[2 * plane + i * plan.nCols + j]));
    const body = fieldBody(man, plan, 'tempC', temp, { nowMs: man.runMs, site: { lat: p.lat, lon: p.lon } });
    assert.equal(body.values[3 * plane + i * plan.nCols + j], null);
    assert.equal(body.values.length, man.times.length * plane);
    assert.equal(fieldPath({ lat: 40.015, lon: -105.271 }), '/api/climalytix/nwp-field?lat=40.00&lon=-105.25&half=3');
    assert.throws(() => readField(man, plan, 'nope', bodies), RangeError);
});

ok('the wire keeps each var at its own precision: vertical velocity in mm/s, the rest at 0.1', () => {
    // A synthetic 2-var manifest: tempC at scale 0.01 and DZDT-like w at scale 0.001 (tiles.py GFS_VARS).
    const m2 = { ...man, vars: [{ id: 'tempC', unit: 'degC', scale: 0.01, offset: 0 }, { id: 'wMs700', unit: 'm/s', scale: 0.001, offset: 0 }] };
    const plan = { latN: 40, lonW: -105, nRows: 1, nCols: 2 };
    const t = Float32Array.from([12.3456, -3.21]), w = Float32Array.from([0.0347, -0.0123]);
    const body = fieldBody(m2, plan, 'tempC', t, { nowMs: man.runMs, site: { lat: 40, lon: -105 }, extra: { wMs700: w } });
    assert.deepEqual(body.fields.tempC, [12.3, -3.2], 'temperature still rounds to 0.1');
    assert.deepEqual(body.fields.wMs700, [0.035, -0.012], 'w keeps its 1 mm/s');
    // NEGATIVE CONTROL: at the old 0.1 rounding these would both be 0 (−0 for the second).
    assert.ok(Math.round(0.0347 * 10) / 10 === 0 && Object.is(Math.round(-0.0123 * 10) / 10, -0));
});

console.log(`\n${passed} passed`);
