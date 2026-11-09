#!/usr/bin/env node
/**
 * climalytix-series.mjs — node gate for js/climalytix/series.js, the SiteSeries
 * contract and the agg-aware resampler (CLIMALYTIX_PLAN.md §4.1).
 *
 * Every expectation is closed-form. Each rule in the module header has a
 * check here that would fail if the rule were dropped:
 *   gaps stay gaps · agg is required · sum/max/min/mean each aggregate their
 *   own way · never upsample · a sparse bucket is a gap · buckets are
 *   station-local · alignment is by instant, not by index.
 *
 *   node tests/climalytix-series.mjs
 */

import assert from 'node:assert/strict';
import {
    makeSeries, resample, alignToGrid, valueAt, seriesExtent, localOrigin,
    bucketIndex, num, HOUR_MS, DAY_MS, KINDS, AGGS,
} from '../js/climalytix/series.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const base = (over = {}) => ({
    id: 'test.x', variable: 'x', label: 'X', quantity: 'temp',
    kind: 'observed', agg: 'mean', cadenceMs: HOUR_MS, t: [], v: [], ...over,
});
const T0 = Date.UTC(2026, 0, 1);   // a UTC midnight

console.log('climalytix series');

ok('num() never coerces a gap to 0', () => {
    assert.equal(num(null), null);
    assert.equal(num(undefined), null);
    assert.equal(num(NaN), null);
    assert.equal(num('3'), null);
    assert.equal(num(0), 0);
    assert.equal(Number(null), 0, 'the trap this guard exists for');
});

ok('makeSeries refuses a series without an agg, or with an unknown kind', () => {
    assert.throws(() => makeSeries(base({ agg: undefined })), /agg is required/);
    assert.throws(() => makeSeries(base({ agg: 'median' })), /agg is required/);
    assert.throws(() => makeSeries(base({ kind: 'guess' })), /unknown kind/);
    assert.throws(() => makeSeries(base({ cadenceMs: 0 })), /cadenceMs/);
    assert.ok(KINDS.includes('reanalysis') && AGGS.includes('sum'));
});

ok('samples are sorted by instant; duplicates keep the last; nulls are gaps', () => {
    const s = makeSeries(base({
        t: [T0 + 2 * HOUR_MS, T0, T0 + HOUR_MS, T0 + HOUR_MS, null],
        v: [3, 1, 99, 2, 7],
    }));
    assert.deepEqual(Array.from(s.t), [T0, T0 + HOUR_MS, T0 + 2 * HOUR_MS]);
    assert.deepEqual(Array.from(s.v), [1, 2, 3]);
    const g = makeSeries(base({ t: [T0, T0 + HOUR_MS], v: [null, 5] }));
    assert.ok(Number.isNaN(g.v[0]), 'null becomes NaN inside');
    assert.equal(valueAt(g, T0), null, 'and null at the boundary — never 0');
    assert.equal(valueAt(g, T0 + HOUR_MS), 5);
    assert.equal(valueAt(g, T0 + 30 * 60_000), null, 'no interpolation');
    assert.deepEqual(seriesExtent(g), { n: 2, finite: 1, gaps: 1, t0: T0, t1: T0 + HOUR_MS });
});

// 48 hourly samples with value = hour index (0..47).
const hours = Array.from({ length: 48 }, (_, i) => T0 + i * HOUR_MS);
const vals = hours.map((_, i) => i);

ok('each agg aggregates its own way (UTC day buckets)', () => {
    const exp = {
        mean: [11.5, 35.5],                       // mean of 0..23 and 24..47
        sum: [276, 852],                          // Σ0..23, Σ24..47
        max: [23, 47],
        min: [0, 24],
    };
    for (const agg of AGGS) {
        const r = resample(makeSeries(base({ agg, t: hours, v: vals })), { stepMs: DAY_MS });
        assert.deepEqual(Array.from(r.t), [T0, T0 + DAY_MS], `${agg}: bucket starts`);
        assert.deepEqual(Array.from(r.v), exp[agg], `${agg}: values`);
        assert.equal(r.cadenceMs, DAY_MS);
        assert.equal(r.agg, agg, 'metadata carried');
    }
});

ok('never upsample: a finer step returns the series itself', () => {
    const daily = makeSeries(base({ cadenceMs: DAY_MS, t: [T0, T0 + DAY_MS], v: [1, 2] }));
    assert.equal(resample(daily, { stepMs: HOUR_MS }), daily);
    assert.equal(resample(daily, { stepMs: DAY_MS }), daily);
});

ok('a sparse bucket is a gap, so a partial sum never reads as a dry day', () => {
    // Day 1 has only 6 of 24 hours (25 % < 75 % coverage).
    const t = [...hours.slice(0, 6), ...hours.slice(24)];
    const v = [...vals.slice(0, 6), ...vals.slice(24)];
    const r = resample(makeSeries(base({ agg: 'sum', t, v })), { stepMs: DAY_MS });
    assert.ok(Number.isNaN(r.v[0]), 'sparse day is a gap');
    assert.equal(r.v[1], 852);
    // Gaps inside the arrays count against coverage too.
    const holes = vals.map((x, i) => (i < 24 && i % 2 ? null : x));
    const r2 = resample(makeSeries(base({ agg: 'sum', t: hours, v: holes })), { stepMs: DAY_MS });
    assert.ok(Number.isNaN(r2.v[0]), '12 of 24 finite is below 75 %');
    const r3 = resample(makeSeries(base({ agg: 'sum', t: hours, v: holes })), { stepMs: DAY_MS, minCoverage: 0.5 });
    assert.equal(r3.v[0], 132, 'Σ of even hours 0..22 at a 50 % floor');
});

ok('day buckets follow the SITE’s local midnight, not UTC', () => {
    // A site at UTC−7: local midnight is 07:00 UTC.
    const origin = localOrigin(-7 * 3600);
    assert.equal(origin, 7 * HOUR_MS);
    const k7 = bucketIndex(T0 + 7 * HOUR_MS, DAY_MS, origin);
    assert.equal(bucketIndex(T0 + 6 * HOUR_MS, DAY_MS, origin), k7 - 1, '06:00 UTC is still the previous local day');
    assert.equal(bucketIndex(T0 + 30 * HOUR_MS, DAY_MS, origin), k7, '06:00 UTC next day is the same local day');
    assert.equal(bucketIndex(T0, DAY_MS, 0) + 1, bucketIndex(T0 + DAY_MS, DAY_MS, 0), 'UTC control: midnight edges');
    const r = resample(makeSeries(base({ agg: 'max', t: hours, v: vals })), { stepMs: DAY_MS, originMs: origin, minCoverage: 0.25 });
    assert.equal(r.t[1], T0 + 7 * HOUR_MS, 'bucket starts at local midnight');
    assert.equal(r.v[1], 30, 'local day 0 covers UTC hours 7..30');
    assert.equal(localOrigin(null), 0, 'no offset is UTC, and +0 not -0');
});

ok('alignToGrid places samples by INSTANT, not array position', () => {
    const a = makeSeries(base({ id: 'a.x', agg: 'sum', t: hours, v: vals }));
    // b starts 24 h later and has a different length — index alignment would mis-pair.
    const b = makeSeries(base({ id: 'b.x', cadenceMs: DAY_MS, t: [T0 + DAY_MS], v: [5] }));
    const g = alignToGrid([a, b], { from: T0, to: T0 + 2 * DAY_MS, stepMs: DAY_MS });
    assert.deepEqual(Array.from(g.t), [T0, T0 + DAY_MS]);
    assert.deepEqual(Array.from(g.columns[0]), [276, 852]);
    assert.ok(Number.isNaN(g.columns[1][0]), 'b has nothing on day 0');
    assert.equal(g.columns[1][1], 5, 'b lands on the day its instant names');
    assert.throws(() => alignToGrid([a], { from: 1, to: 1, stepMs: DAY_MS }), /from < to/);
});

ok('resample honours a window without changing values', () => {
    const r = resample(makeSeries(base({ agg: 'mean', t: hours, v: vals })), { stepMs: DAY_MS, from: T0 + DAY_MS });
    assert.deepEqual(Array.from(r.t), [T0 + DAY_MS]);
    assert.deepEqual(Array.from(r.v), [35.5]);
    const w = resample(makeSeries(base({ t: hours, v: vals })), { stepMs: HOUR_MS, from: T0 + 2 * HOUR_MS, to: T0 + 4 * HOUR_MS });
    assert.deepEqual(Array.from(w.v), [2, 3], 'native-step window slice');
});

console.log(`\n${passed} passed`);
