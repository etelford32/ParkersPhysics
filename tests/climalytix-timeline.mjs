#!/usr/bin/env node
/**
 * climalytix-timeline.mjs — node gate for js/climalytix/timeline-model.js.
 *
 * Pins the grammar the module header promises: aggregation (never thinning)
 * on long windows with the bucket named, past solid / future dashed, gaps
 * break lines, colour only through classes, readouts read null for gaps.
 *
 *   node tests/climalytix-timeline.mjs
 */

import assert from 'node:assert/strict';
import {
    RANGES, BUCKET_LADDER, MAX_BUCKETS, chooseStep, windowFor, niceTicks,
    panelModel, panelSvg, timeTicks, readoutAt, msAtX, tickDecimals, SLOT_COUNT,
} from '../js/climalytix/timeline-model.js';
import { makeSeries, HOUR_MS, DAY_MS } from '../js/climalytix/series.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const NOW = Date.UTC(2026, 10, 8, 12);

const hourly = (from, n, f, over = {}) => makeSeries({
    id: 'station.tempC', variable: 'tempC', label: 'Temp', quantity: 'temp',
    kind: 'forecast', agg: 'mean', cadenceMs: HOUR_MS,
    t: Array.from({ length: n }, (_, i) => from + i * HOUR_MS),
    v: Array.from({ length: n }, (_, i) => f(i)), ...over,
});

console.log('climalytix timeline');

ok('chooseStep keeps every preset within the bucket budget, smallest step first', () => {
    assert.equal(chooseStep(2 * DAY_MS).ms, HOUR_MS);
    assert.equal(chooseStep(30 * DAY_MS).ms, HOUR_MS, '720 hourly buckets fit');
    assert.equal(chooseStep(365 * DAY_MS).ms, DAY_MS);
    assert.equal(chooseStep(86 * 365 * DAY_MS).ms, 30 * DAY_MS, '85 years → 30-day buckets');
    for (const [id, r] of Object.entries(RANGES)) {
        if (r.pastMs == null) continue;
        const span = r.pastMs + r.futureMs;
        assert.ok(span / chooseStep(span).ms <= MAX_BUCKETS, `${id} within budget`);
    }
    assert.equal(chooseStep(1e15).ms, BUCKET_LADDER[BUCKET_LADDER.length - 1].ms, 'ladder top caps it');
});

ok('windowFor: presets straddle now; "all" starts at the earliest sample', () => {
    const w = windowFor('7d', NOW);
    assert.equal(w.from, NOW - 4 * DAY_MS);
    assert.equal(w.to, NOW + 3 * DAY_MS);
    assert.equal(windowFor('all', NOW, Date.UTC(1991, 0, 1)).from, Date.UTC(1991, 0, 1));
    assert.equal(windowFor('bogus', NOW).rangeId, '30d');
});

ok('niceTicks are 1-2-5 steps that cover the range', () => {
    assert.deepEqual(niceTicks(0, 10, 4), [0, 2, 4, 6, 8, 10]);
    assert.deepEqual(niceTicks(-3.2, 7.9, 4), [-2, 0, 2, 4, 6]);
    assert.deepEqual(niceTicks(1001, 1029, 4), [1005, 1010, 1015, 1020, 1025]);
    assert.ok(niceTicks(5, 5).length >= 2, 'a flat line still gets an axis');
});

const from = NOW - 2 * DAY_MS, to = NOW + 2 * DAY_MS;
const base = { from, to, nowMs: NOW, stepMs: HOUR_MS, width: 600, height: 120, utcOffsetS: 0 };

ok('past solid, future dashed: the run breaks exactly at now', () => {
    const s = hourly(from, 96, (i) => i);
    const m = panelModel([s], base);
    const runs = m.lines[0].runs;
    assert.equal(runs.length, 2);
    assert.equal(runs[0].future, false);
    assert.equal(runs[1].future, true);
    assert.deepEqual(runs[1].pts[0], runs[0].pts[runs[0].pts.length - 1], 'the dashed run starts where the solid one ends — no visual gap at now');
    const svg = panelSvg(m, { slotOf: () => 2, title: 'Temp' });
    assert.equal((svg.match(/cx-proj/g) || []).length, 1);
    assert.match(svg, /class="cx-line cx-s2"/);
    assert.doesNotMatch(svg, /stroke=|fill="#/, 'no colour in attributes — classes only');
    assert.match(svg, /class="cx-now"/);
});

ok('a gap breaks the line instead of bridging it', () => {
    const s = hourly(from, 48, (i) => (i >= 10 && i < 14 ? null : i));
    const m = panelModel([s], { ...base, to: NOW });
    assert.equal(m.lines[0].runs.length, 2, 'two runs around the 4-hour hole');
    const xs = m.lines[0].runs.flatMap((r) => r.pts.map((p) => p[0]));
    assert.equal(new Set(xs).size, xs.length, 'no point drawn twice');
});

ok('long windows AGGREGATE by the series’ agg (a max stays a max)', () => {
    const tmax = makeSeries({
        id: 'era5.tmax', variable: 'tmax', label: 'High', quantity: 'temp', kind: 'reanalysis', agg: 'max',
        cadenceMs: DAY_MS, t: Array.from({ length: 60 }, (_, i) => Date.UTC(2026, 0, 1) + i * DAY_MS),
        v: Array.from({ length: 60 }, (_, i) => (i === 17 ? 40 : 10)),
    });
    const m = panelModel([tmax], { ...base, from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 2, 2), nowMs: NOW, stepMs: 30 * DAY_MS });
    const ys = m.lines[0].pts.map((p) => p.y);
    assert.deepEqual(ys, [40, 10], 'the 40° spike survives the 30-day bucket');
    assert.equal(m.lines[0].drawnMs, 30 * DAY_MS);
});

ok('toDisplay converts at the edge; ticks are in display units', () => {
    const s = hourly(from, 48, () => 0);
    const m = panelModel([s], { ...base, to: NOW, toDisplay: (c) => c * 9 / 5 + 32 });
    assert.ok(m.lines[0].pts.every((p) => p.y === 32));
    assert.ok(m.yTicks.some((t) => t.v === 32) || m.yTicks.length >= 2);
});

ok('empty window says so', () => {
    const m = panelModel([hourly(from - 10 * DAY_MS, 3, () => 1)], base);
    assert.equal(m.hasData, false);
    assert.match(panelSvg(m), /No data in this window/);
});

ok('readoutAt reads the bucket containing the instant; gaps read null', () => {
    const s = hourly(from, 96, (i) => (i === 50 ? null : i));
    const m = panelModel([s], base);
    const r1 = readoutAt([m], from + 10 * HOUR_MS + 1);
    assert.equal(r1[0].y, 10);
    assert.equal(r1[0].future, false);
    const r2 = readoutAt([m], from + 50 * HOUR_MS + 5);
    assert.equal(r2[0].y, null, 'a gap is null, not 0');
    assert.equal(readoutAt([m], NOW + HOUR_MS)[0].future, true);
    assert.ok(Math.abs(msAtX(m, m.nowX) - NOW) < 1, 'msAtX inverts the x map');
});

ok('timeTicks pick a readable unit for each span', () => {
    const days = timeTicks(from, to, 600);
    assert.ok(days.length >= 3 && days.length <= 9);
    const years = timeTicks(Date.UTC(1991, 0, 1), NOW, 600);
    assert.ok(years.every((k) => /^\d{4}$/.test(k.label)), 'multi-decade axis is labelled in years');
    assert.ok(years.every((k, i, a) => i === 0 || k.x > a[i - 1].x), 'ticks increase left to right');
    const months = timeTicks(NOW - 365 * DAY_MS, NOW, 600);
    assert.ok(months.length >= 3, `a 1-year window gets several labels, got ${months.length}`);
    assert.ok(months.every((k) => /^\d{4}-\d{2}$/.test(k.label)));
});

ok('every SUM in a panel is drawn per the SAME bucket (no mm/h beside mm/day)', () => {
    const day0 = Date.UTC(2026, 10, 5);
    const daily = makeSeries({
        id: 'era5.precip', variable: 'precip', label: 'Daily total', quantity: 'precip', kind: 'reanalysis', agg: 'sum',
        cadenceMs: DAY_MS, t: [day0, day0 + DAY_MS], v: [24, 48],
    });
    const hourlyRain = makeSeries({
        id: 'station.precipMm', variable: 'precipMm', label: 'Hourly', quantity: 'precip', kind: 'forecast', agg: 'sum',
        cadenceMs: HOUR_MS, t: Array.from({ length: 48 }, (_, i) => day0 + i * HOUR_MS), v: Array(48).fill(1),
    });
    const m = panelModel([daily, hourlyRain], { ...base, from: day0, to: day0 + 2 * DAY_MS, stepMs: HOUR_MS });
    assert.equal(m.stepMs, DAY_MS, 'the panel steps at the coarsest summed cadence');
    assert.deepEqual(m.lines[1].pts.map((p) => p.y), [24, 24], 'the hourly series is drawn as DAILY sums');
    assert.equal(m.lines[1].drawnMs, DAY_MS);
    // Negative control: a MEAN panel keeps the finer step.
    const meanPanel = panelModel([hourly(day0, 48, () => 1)], { ...base, from: day0, to: day0 + 2 * DAY_MS, stepMs: HOUR_MS });
    assert.equal(meanPanel.stepMs, HOUR_MS);
});

ok('a series too short for the zoom says so instead of "No data"', () => {
    const fourDays = hourly(NOW - 2 * DAY_MS, 96, () => 5);
    const m = panelModel([fourDays], { ...base, from: NOW - 3650 * DAY_MS, to: NOW + 3 * DAY_MS, stepMs: 30 * DAY_MS });
    assert.equal(m.hasData, false);
    assert.equal(m.tooShort, true);
    assert.equal(m.lines[0].tooShort.spanMs, 96 * HOUR_MS);
    assert.match(panelSvg(m), /Too short to show at this zoom/);
    const none = panelModel([hourly(NOW - 400 * DAY_MS, 3, () => 1)], { ...base, from: NOW - DAY_MS, to: NOW, stepMs: HOUR_MS });
    assert.equal(none.tooShort, false, 'genuinely empty is still "No data"');
});

ok('tick decimals come from the tick spacing', () => {
    assert.equal(tickDecimals([{ v: -1 }, { v: -0.5 }]), 1, '0.5 spacing needs a decimal');
    assert.equal(tickDecimals([0, 0.2]), 1);
    assert.equal(tickDecimals([0, 0.05]), 2);
    assert.equal(tickDecimals([1000, 1010]), 0);
    assert.equal(tickDecimals([5]), 0);
    const labels = niceTicks(-1.2, 1.4, 4).map((v) => v.toFixed(tickDecimals(niceTicks(-1.2, 1.4, 4))));
    assert.equal(new Set(labels).size, labels.length, 'no duplicate labels');
});

ok('every slot the catalog can hand out reaches the SVG unclamped', () => {
    const m = panelModel([hourly(from, 96, (i) => i)], base);
    for (let k = 0; k < SLOT_COUNT; k++) {
        assert.match(panelSvg(m, { slotOf: () => k }), new RegExp(`class="cx-line cx-s${k}"`), `slot ${k}`);
    }
    assert.match(panelSvg(m, { slotOf: () => SLOT_COUNT + 3 }), new RegExp(`cx-s${SLOT_COUNT - 1}"`), 'out of range clamps to the last');
});

console.log(`\n${passed} passed`);
