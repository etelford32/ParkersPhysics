/**
 * tests/flare-realism.mjs — the flare-shape scorecard and its ratchet.
 *
 *   node tests/flare-realism.mjs
 *
 * What it holds:
 *   • the scoring function is what it says (1 in range, falling outside);
 *   • every measurement is re-derived here from the model's own laws — the
 *     scorecard measures the model, it does not restate it;
 *   • every scored row MOVES when some parameter moves (a row nothing can
 *     change is not a target, it is decoration);
 *   • THE RATCHET: the shipped model scores exactly the committed baseline.
 *     Below it → the model got worse; above it → run
 *     `node scripts/flare-realism.mjs --update` so the gain is locked in;
 *   • NEGATIVE CONTROL: the laws shipped until 2026-11-21 (FLARE_SHAPE_V1)
 *     score lower, and fail the rows they are known to fail.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as FG from '../js/flare-geometry.js';
import {
    RSUN_MM, EPOCH, TARGETS, OPEN_TARGETS, measure, scoreValue, scorecard, compareScorecards, baselineOf, formatScorecard,
} from '../js/flare-realism.js';
import { SIM_UNITS_PER_S } from '../js/sun-flare-director.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
console.log('flare-realism.mjs');

const M = FG.FLARE_MODEL;
const V1 = FG.makeFlareModel(null, FG.FLARE_SHAPE_V1);
const sim = (s) => s * SIM_UNITS_PER_S;

ok('scoreValue: 1 inside the range, falling monotonically outside it, 0 a range-width away', () => {
    const lin = { lo: 50, hi: 80, scale: 'lin' };
    for (const v of [50, 62, 80]) assert.equal(scoreValue(v, lin), 1);
    assert.ok(near(scoreValue(35, lin), 0.5) && near(scoreValue(95, lin), 0.5), 'half a range-width out is 0.5');
    assert.equal(scoreValue(20, lin), 0); assert.equal(scoreValue(110, lin), 0);
    const log = { lo: 5, hi: 20, scale: 'log' };
    assert.equal(scoreValue(10, log), 1);
    assert.ok(near(scoreValue(40, log), 0.5) && near(scoreValue(2.5, log), 0.5), 'a log range is symmetric in ratio');
    assert.equal(scoreValue(80, log), 0);
    let prev = 1;
    for (let v = 20; v <= 80; v += 2) { const s = scoreValue(v, log); assert.ok(s <= prev + 1e-12, `not monotone at ${v}`); prev = s; }
    for (const bad of [NaN, Infinity, -Infinity, undefined]) assert.equal(scoreValue(bad, log), 0, `${bad} scores 0`);
    assert.equal(scoreValue(0, log), 0); assert.equal(scoreValue(-3, log), 0);
    // A point range (lo = hi) still has a slope, so a near miss is not a cliff.
    assert.equal(scoreValue(1, { lo: 1, hi: 1 }), 1); assert.ok(scoreValue(0.9, { lo: 1, hi: 1 }) > 0 && scoreValue(0, { lo: 1, hi: 1 }) === 0);
});

ok('targets are well formed: unique ids, a real range, a weight, a source, a measurement behind each', () => {
    const m = measure(M);
    const ids = new Set();
    for (const t of TARGETS) {
        assert.ok(!ids.has(t.id), `duplicate id ${t.id}`); ids.add(t.id);
        assert.ok(Number.isFinite(t.lo) && Number.isFinite(t.hi) && t.lo <= t.hi, `${t.id} range`);
        assert.ok(t.weight > 0, `${t.id} weight`);
        assert.ok(t.scale === 'lin' || t.scale === 'log', `${t.id} scale`);
        if (t.scale === 'log') assert.ok(t.lo > 0, `${t.id}: a log range needs lo > 0`);
        assert.ok(typeof t.source === 'string' && t.source.length > 20, `${t.id} names its source`);
        assert.ok(typeof t.verified === 'boolean', `${t.id} says whether its range was checked against the source`);
        assert.ok(t.key in m && typeof m[t.key] === 'number', `${t.id}: measure() has no "${t.key}"`);
    }
    for (const o of OPEN_TARGETS) { assert.ok(!ids.has(o.id), `${o.id} is both scored and open`); assert.ok(o.what && o.source); }
    assert.ok(OPEN_TARGETS.length >= 1, 'the backlog is written down');
});

ok('measure(): every number re-derived from the model\'s own laws, in physical units', () => {
    for (const model of [M, V1]) {
        const m = measure(model);
        const sepMm = (s, c = 'X') => model.ribbonSeparation(sim(s), c) * RSUN_MM;
        assert.ok(near(m.sepOnsetFullMm, 2 * sepMm(0), 1e-9));
        assert.ok(near(m.sepLateFullMm, 2 * sepMm(EPOCH.late), 1e-9));
        assert.ok(near(m.sepSpeedImpulsiveKms, (sepMm(120) - sepMm(0)) * 1000 / 120, 1e-9), 'km/s of ONE ribbon from the PIL');
        assert.ok(near(m.shearOnsetDeg, Math.atan(model.arcadeShear(0)) / FG.DEG, 1e-9));
        assert.ok(near(m.shearLateDeg, Math.atan(model.arcadeShear(sim(EPOCH.late))) / FG.DEG, 1e-9));
        const t = sim(EPOCH.mid);
        assert.ok(near(m.loopAspect, model.arcadeHeight(t, 'X') / (model.ribbonSeparation(t, 'X') * Math.hypot(1, model.arcadeShear(t))), 1e-9));
        assert.ok(near(m.apexLateMm, model.arcadeHeight(sim(EPOCH.late), 'X') * RSUN_MM, 1e-9));
        assert.ok(near(m.ribbonLengthXMm, 2 * model.ribbonLength0('X') * RSUN_MM, 1e-9));
        assert.ok(near(m.ribbonDecayS, model.params.ribbon.decayT / SIM_UNITS_PER_S, 1e-9));
        const A = model.params.arcade;
        assert.ok(near(m.zipSpeedKms, (1 - A.zipCore) * A.spanSigma * model.ribbonAlongSigma(0, 'X') * RSUN_MM * 1000 / (A.zipT / SIM_UNITS_PER_S), 1e-9));
    }
    // Closed forms the two sets are known by.
    const a = measure(V1), b = measure(M);
    assert.ok(near(a.sepDeceleration, 1, 1e-9), 'v1 separation is linear: no deceleration at all');
    assert.ok(near(a.sepOnsetFullMm, 2 * 0.020 * RSUN_MM, 1e-9) && near(a.shearOnsetDeg, Math.atan(0.57) / FG.DEG, 1e-9));
    assert.equal(a.classOrdered, 0, 'v1: every class had the same ribbon separation');
    assert.ok(near(b.shearOnsetDeg, FG.FLARE_SHAPE_V2.shear.onsetDeg, 1e-9) && b.sepDeceleration > 3 && b.classOrdered === 1);
    // The clock is an input, not a constant buried in the measurements.
    assert.ok(near(measure(M, { simUnitsPerS: 0.7 }).sepSpeedImpulsiveKms / 1, (M.ribbonSeparation(84, 'X') - M.ribbonSeparation(0, 'X')) * RSUN_MM * 1000 / 120, 1e-9));
});

ok('every scored row moves when some parameter moves (no decorative rows)', () => {
    const base = measure(M);
    const leaves = [];
    const walk = (o, path) => { for (const [k, v] of Object.entries(o)) { if (k === 'id') continue; if (v && typeof v === 'object') walk(v, [...path, k]); else if (typeof v === 'number') leaves.push([...path, k]); } };
    walk(FG.FLARE_SHAPE_DEFAULT, []);
    const moved = new Map(TARGETS.map((t) => [t.id, []]));
    for (const path of leaves) {
        const cur = path.reduce((o, k) => o[k], FG.FLARE_SHAPE_DEFAULT);
        for (const f of [0.5, 1.5]) {
            const v = cur === 0 ? (f < 1 ? 0 : 0.01) : cur * f;
            const over = path.reduceRight((acc, k) => ({ [k]: acc }), v);
            let m; try { m = measure(FG.makeFlareModel(over)); } catch { continue; }
            for (const t of TARGETS) if (Math.abs(m[t.key] - base[t.key]) > 1e-9 * Math.max(1, Math.abs(base[t.key]))) moved.get(t.id).push(path.join('.'));
        }
    }
    for (const [id, by] of moved) assert.ok(by.length > 0, `row "${id}" does not respond to any parameter`);
    // …and the parameters that matter are the ones you would expect.
    assert.ok(moved.get('shear_onset').includes('shear.onsetDeg') && !moved.get('shear_onset').includes('ribbon.sep0'));
    assert.ok(moved.get('zip').includes('arcade.zipT') && moved.get('sep_decel').includes('ribbon.sepTau'));
});

ok('scorecard: a weighted mean of the rows; compare and baseline records agree with it', () => {
    const c = scorecard(M);
    let sw = 0, s = 0;
    for (const x of c.metrics) { const t = TARGETS.find((y) => y.id === x.id); sw += t.weight; s += t.weight * scoreValue(x.value, t); assert.equal(x.pass, x.score === 1); }
    assert.ok(near(c.score, s / sw, 1e-12));
    assert.equal(c.rows, TARGETS.length); assert.equal(c.passed, c.metrics.filter((x) => x.pass).length);
    const b = baselineOf(c);
    assert.equal(b.modelId, M.id); assert.deepEqual(Object.keys(b.metrics), TARGETS.map((t) => t.id));
    const cmp = compareScorecards(scorecard(V1), c);
    assert.ok(near(cmp.delta, c.score - scorecard(V1).score, 1e-12));
    assert.ok(cmp.rows.find((r) => r.id === 'shear_onset').delta > 0);
    assert.match(formatScorecard(c), /flare realism — flare-shape-v2: /);
    assert.match(formatScorecard(c), /ranges verified against their source/, 'the printed card says how many ranges are checked');
});

ok('THE RATCHET: the shipped model scores exactly the committed baseline', () => {
    const base = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/flare/realism-baseline.json', import.meta.url)), 'utf8'));
    const c = scorecard(M);
    console.log('\n' + formatScorecard(c).split('\n').map((l) => '    ' + l).join('\n') + '\n');
    assert.ok(c.score >= base.score - 1e-6,
        `the shipped flare model scores ${(c.score * 100).toFixed(1)}, BELOW the baseline ${(base.score * 100).toFixed(1)}. ` +
        'It got worse on the scorecard. Fix it, or — if a target was tightened on purpose — record the new level with `node scripts/flare-realism.mjs --update --force` and say why in the commit.');
    assert.ok(c.score <= base.score + 1e-6,
        `the shipped flare model scores ${(c.score * 100).toFixed(1)}, ABOVE the baseline ${(base.score * 100).toFixed(1)}. Lock the gain in: node scripts/flare-realism.mjs --update`);
    assert.equal(base.modelId, M.id, 'the baseline was recorded for the shipped parameter set');
    // Row by row: a row may not slip even if the total holds (a gain elsewhere must not hide a loss).
    for (const x of c.metrics) {
        assert.ok(x.id in base.metrics, `row "${x.id}" is not in the baseline: run node scripts/flare-realism.mjs --update`);
        assert.ok(x.score >= base.metrics[x.id] - 1e-6, `row "${x.id}" fell from ${base.metrics[x.id]} to ${x.score.toFixed(3)}`);
    }
    assert.deepEqual(Object.keys(base.metrics).sort(), c.metrics.map((x) => x.id).sort(), 'the baseline has rows the scorecard no longer scores');
});

ok('NEGATIVE CONTROL: the laws shipped until 2026-11-21 score lower, on the rows they are known to fail', () => {
    const v1 = scorecard(V1), now = scorecard(M);
    assert.ok(v1.score < now.score - 0.1, `v1 ${(v1.score * 100).toFixed(1)} vs shipped ${(now.score * 100).toFixed(1)}`);
    const row = (c, id) => c.metrics.find((x) => x.id === id);
    for (const id of ['shear_onset', 'shear_late', 'loop_aspect', 'sep_decel', 'sep_onset', 'apex_onset', 'class_order'])
        assert.ok(!row(v1, id).pass, `v1 should miss "${id}" (it reads ${row(v1, id).value})`);
    // The measured values that are the reason for each change, pinned.
    assert.ok(near(row(v1, 'shear_onset').value, 29.68, 0.01), 'v1 loops started 30° sheared — the surveys say 50–80°');
    assert.ok(near(row(v1, 'loop_aspect').value, 2.68, 0.01), 'v1 loops stood 2.7× taller than their half-span');
    assert.ok(near(row(v1, 'sep_onset').value, 27.8, 0.1), 'v1 ribbons appeared 28 Mm apart');
    // A row the two sets agree on stays a pass for both: the control is specific.
    assert.ok(row(v1, 'length_x').pass && row(now, 'length_x').pass);
});

console.log(`${passed} checks passed (flare-realism)`);
