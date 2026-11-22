/**
 * tests/bz-forecast-join.mjs — gate for js/bz/forecast-join.js (BZ_ENGINE_PLAN.md B7).
 * The rope forecast is the REAL shared provider on the committed WASM with injected
 * fixture CMEs (no network) — the join must add nothing to it and hide nothing from it.
 *
 *   node tests/bz-forecast-join.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { computeFluxRopeForecast } from '../js/flux-rope-forecast.js';
import { ropeSeries, joinForecast, scoreRope, arrivalSeries, JOIN_STATUS } from '../js/bz/forecast-join.js';

let checks = 0;
const ok = (name) => { checks++; console.log(`  ✓ ${name}`); };
const wasm = await readFile(fileURLToPath(new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url)));
const NOW = Date.parse('2026-07-20T12:00:00Z');
const CME = { timeIso: '2026-07-19T06:00:00Z', speedKms: 1250, lonDeg: 4, latDeg: -3, halfAngleDeg: 42, earthDirected: true };
const DELAY = 50; // minutes

/** A flux trace like /api/bz/flux's: one row a minute, L1 time = arrival − delay, up to `newestL1`. */
function trace(nowMs, { newestL1AgoMin = 5, minutes = 240, bz = (t) => 2 * Math.sin(t / 1.1e6) } = {}) {
    const rows = [];
    for (let k = minutes; k >= newestL1AgoMin; k--) {
        const seen = nowMs - k * 60e3, arrives = seen + DELAY * 60e3;
        rows.push([new Date(arrives).toISOString(), arrives > nowMs ? 'F' : 'E', 10, 1, 12, Math.round(bz(seen) * 100) / 100, DELAY]);
    }
    return { columns: ['arrives', 'kind', 'milan_kv', 'sigma_kv', 'newell_scaled_kv', 'bz_nt', 'delay_min'], rows };
}

const fc = await computeFluxRopeForecast({ sources: { cmes: [CME], rtsw: null, wasm }, nowMs: NOW });
const rope = ropeSeries(fc);

// ── 1. the adapter adds nothing ───────────────────────────────────────────
{
    assert.equal(rope.state, 'ok');
    assert.equal(rope.launchMs, fc.launchMs); assert.equal(rope.n, fc.grid.n); assert.equal(rope.dtMs, fc.grid.dtS * 1000);
    for (const k of ['p5', 'p25', 'p50', 'p75', 'p95']) for (const i of [0, 40, 200, rope.n - 1]) assert.equal(rope.fan[k][i], fc.fan.bzPct[k][i]);
    assert.equal(rope.conditioned, false, 'no L1 data was injected, so the fan IS the prior');
    assert.equal(ropeSeries(null).state, 'pending');
    assert.equal(ropeSeries({ idle: true, reason: 'cme-train-passed' }).state, 'idle');
    assert.equal(ropeSeries({ idle: true, failed: true, reason: 'DONKI 503' }).state, 'failed', 'a failed provider is not an idle one');
    ok('ropeSeries: the provider\'s numbers, copied; pending / idle / failed kept apart');
}

// ── 2. the join: measurement wins, the rope starts strictly after it ──────
const tr = trace(NOW);
const j = joinForecast({ trace: tr, rope, nowMs: NOW });
{
    assert.equal(j.status, 'joined');
    const { arrived, transit } = arrivalSeries(tr, NOW);
    assert.ok(arrived.length && transit.length);
    assert.ok(arrived.every((p) => p.t <= NOW) && transit.every((p) => p.t > NOW), 'split by arrival time against the clock given');
    assert.equal(j.l1HorizonMs, transit[transit.length - 1].t);
    assert.equal(j.l1HorizonMs, NOW + (DELAY - 5) * 60e3, 'the horizon is the newest L1 minute plus the delay');
    assert.ok(j.prior.length > 50);
    assert.ok(j.prior[0].t > j.l1HorizonMs, 'no rope point inside the L1 horizon');
    assert.ok(j.prior.every((p) => p.p95 - p.p5 > 0), 'every drawn point is one where the ensemble says something');
    assert.ok(j.prior[j.prior.length - 1].t <= NOW + 24 * 3600e3);
    for (let i = 1; i < j.prior.length; i++) assert.equal((j.prior[i].t - j.prior[i - 1].t) % rope.dtMs, 0, 'the rope grid is never resampled');
    ok(`join: ${arrived.length} arrived · ${transit.length} in transit · ${j.prior.length} rope points, all after the L1 horizon`);
}

// ── 3. the time shift is exactly the engine's delay; values are the fan's ─
{
    for (const p of [j.prior[0], j.prior[17], j.prior[j.prior.length - 1]]) {
        assert.equal(p.t - p.l1Time, DELAY * 60e3);
        const i = (p.l1Time - rope.launchMs) / rope.dtMs;
        assert.ok(Number.isInteger(i));
        for (const k of ['p5', 'p25', 'p50', 'p75', 'p95']) assert.equal(p[k], rope.fan[k][i]);
        assert.ok(p.p5 <= p.p25 && p.p25 <= p.p50 && p.p50 <= p.p75 && p.p75 <= p.p95);
    }
    // negative control: a different delay moves every rope point by exactly the difference.
    const tr2 = trace(NOW); for (const r of tr2.rows) r[6] = DELAY + 20;
    const j2 = joinForecast({ trace: tr2, rope, nowMs: NOW });
    assert.equal(j2.prior[5].t - j2.prior[5].l1Time, (DELAY + 20) * 60e3);
    assert.equal(j.rope.arrivalP50Ms, rope.arrivalP50Ms + DELAY * 60e3, 'the arrival window moves with it');
    ok('each rope point sits one propagation delay after its L1 time, with the fan\'s own percentiles');
}

// ── 4. the seam is reported, not smoothed ─────────────────────────────────
{
    assert.ok(j.seam);
    const last = arrivalSeries(tr, NOW).transit.at(-1);
    assert.equal(j.seam.l1_bz_nt, last.bz);
    assert.ok(Math.abs(j.seam.step_nt - (j.seam.rope_p50_nt - last.bz)) < 1e-12);
    assert.equal(typeof j.seam.l1_inside_rope_band, 'boolean');
    // A planted L1 value far outside the band must be reported as outside.
    const far = joinForecast({ trace: trace(NOW, { bz: () => 400 }), rope, nowMs: NOW });
    assert.equal(far.seam.l1_inside_rope_band, false);
    assert.ok(far.prior.every((p, i) => p.p50 === j.prior[i].p50), 'and the rope is not pulled toward it');
    ok(`seam: L1 ${j.seam.l1_bz_nt} nT → rope ${j.seam.rope_p50_nt.toFixed(2)} nT (step ${j.seam.step_nt.toFixed(2)}), reported`);
}

// ── 4b. before the CME reaches L1 in any member, the rope is SILENT, not calm ──
{
    const early = NOW - 24 * 3600e3; // 6 h after launch: nothing can have arrived
    const je = joinForecast({ trace: trace(early), rope, nowMs: early, horizonH: 6 });
    assert.equal(je.prior.length, 0, 'no flat 0 nT line is drawn');
    assert.ok(je.silentSteps > 10); assert.equal(je.status, 'rope_beyond'); assert.equal(je.seam, null);
    const se = scoreRope({ rope, l1: { t0: rope.launchMs, step_s: 60, bz: Array(360).fill(-3) }, nowMs: early });
    assert.equal(se.status, 'too_few_points', 'and nothing is scored there');
    ok(`silent before arrival: ${je.silentSteps} steps not drawn, not scored`);
}

// ── 5. no rope, no forecast — and three different reasons ─────────────────
{
    const idle = joinForecast({ trace: tr, rope: ropeSeries({ idle: true, reason: 'no-earth-directed-cme' }), nowMs: NOW });
    assert.equal(idle.status, 'no_rope'); assert.equal(idle.prior.length, 0); assert.equal(idle.seam, null);
    assert.ok(idle.transit.length > 0, 'the L1-based forecast is untouched');
    const passed = joinForecast({ trace: tr, rope: ropeSeries({ idle: true, reason: 'cme-train-passed' }), nowMs: NOW });
    assert.equal(passed.status, 'train_passed'); assert.equal(passed.prior.length, 0);
    const down = joinForecast({ trace: tr, rope: ropeSeries({ idle: true, failed: true, reason: 'HTTP 503' }), nowMs: NOW });
    assert.equal(down.status, 'rope_down'); assert.equal(down.prior.length, 0);
    assert.equal(joinForecast({ trace: tr, rope: null, nowMs: NOW }).status, 'pending');
    assert.notEqual(JOIN_STATUS.no_rope, JOIN_STATUS.rope_down);
    // No delay from the engine ⇒ the rope cannot be placed ⇒ it is not drawn.
    const noDelay = joinForecast({ trace: { columns: [], rows: [] }, rope, nowMs: NOW });
    assert.equal(noDelay.status, 'rope_down'); assert.equal(noDelay.prior.length, 0);
    // A rope whose grid ended before the window: in flight on paper, nothing to draw.
    const late = joinForecast({ trace: trace(NOW + 30 * 86400e3), rope, nowMs: NOW + 30 * 86400e3 });
    assert.equal(late.status, 'rope_beyond'); assert.equal(late.prior.length, 0);
    ok('idle / passed / failed / pending / no-delay / out-of-window: never a quiet line past the horizon');
}

// ── 6. the score: the UNCONDITIONED prior, against truth, beside Bz = 0 ───
{
    const t0 = rope.launchMs, minutes = Math.floor((NOW - t0) / 60e3);
    const series = (f) => ({ t0, step_s: 60, bz: Array.from({ length: minutes }, (_, k) => f(t0 + k * 60e3)) });
    const p50At = (t) => rope.prior.p50[Math.min(rope.n - 1, Math.round((t - t0) / rope.dtMs))];
    // (a) truth = the prior's own median on its grid ⇒ zero error, every point inside both bands.
    const perfect = scoreRope({ rope, l1: series(p50At), nowMs: NOW });
    assert.equal(perfect.status, 'scored');
    assert.ok(perfect.rmse_nt < 1e-9, `rmse ${perfect.rmse_nt}`);
    assert.equal(perfect.coverage50, 1); assert.equal(perfect.coverage90, 1);
    const happened = Math.floor((NOW - t0 - rope.dtMs / 2) / rope.dtMs) + 1;
    let speaking = 0; for (let i = 0; i < happened; i++) if (rope.prior.p95[i] - rope.prior.p5[i] > 1e-6) speaking++;
    assert.equal(perfect.n, speaking, 'only grid steps that have fully happened AND where the forecast says something');
    assert.ok(speaking < happened, 'the fixture has silent steps before the CME reaches L1');
    // (b) truth = 0 everywhere ⇒ the control is exact and the forecast cannot beat it.
    const zero = scoreRope({ rope, l1: series(() => 0), nowMs: NOW });
    assert.equal(zero.rmse_zero_nt, 0); assert.equal(zero.skill_vs_zero, null, 'no skill is claimed against a control with zero error');
    // (c) truth = the opposite sign of the forecast ⇒ behind its control.
    const anti = scoreRope({ rope, l1: series((t) => -p50At(t) - 3), nowMs: NOW });
    assert.ok(anti.skill_vs_zero < 0, `skill ${anti.skill_vs_zero}`);
    // (d) a gap is a gap: knock out the truth under half the grid steps.
    const holed = series(p50At); for (let k = 0; k < holed.bz.length; k++) if (Math.floor(k / 15) % 2) holed.bz[k] = null;
    const g = scoreRope({ rope, l1: holed, nowMs: NOW });
    assert.ok(g.n < perfect.n && g.n > 0); assert.ok(g.rmse_nt < 1e-9);
    // (e) too little truth ⇒ not scored, never a number.
    const few = scoreRope({ rope, l1: { t0, step_s: 60, bz: holed.bz.slice(0, 60) }, nowMs: NOW });
    assert.equal(few.status, 'too_few_points'); assert.equal(few.rmse_nt, null);
    assert.equal(scoreRope({ rope: ropeSeries({ idle: true }), l1: series(() => 0), nowMs: NOW }).status, 'no_rope');
    assert.equal(perfect.conditioned_rmse_nt, null, 'no in-sample number when nothing was conditioned');
    ok(`score: exact on its own median (n = ${perfect.n}); behind when anti-correlated (${anti.skill_vs_zero.toFixed(2)}); gaps skipped; thin truth unscored`);
}

// ── 7. the conditioned fan is never what is scored ────────────────────────
{
    const samples = [];
    for (let t = fc.launchMs; t < NOW; t += 60e3) samples.push({ t, bz: -4, v: 420 });
    const rtsw = { samples, length: samples.length, tStart: samples[0].t, tEnd: samples.at(-1).t, at: (t) => samples[Math.min(samples.length - 1, Math.max(0, Math.round((t - samples[0].t) / 60e3)))] };
    const fc2 = await computeFluxRopeForecast({ sources: { cmes: [CME], rtsw, wasm }, nowMs: NOW });
    const r2 = ropeSeries(fc2);
    assert.equal(r2.conditioned, true);
    const s = scoreRope({ rope: r2, l1: { t0: fc.launchMs, step_s: 60, bz: samples.map(() => -4) }, nowMs: NOW });
    assert.equal(s.status, 'scored');
    assert.ok(s.conditioned_rmse_nt != null, 'the conditioned error is reported');
    const swapped = scoreRope({ rope: { ...r2, prior: { ...r2.prior, p50: r2.fan.p50 } }, l1: { t0: fc.launchMs, step_s: 60, bz: samples.map(() => -4) }, nowMs: NOW });
    assert.ok(Math.abs(swapped.rmse_nt - s.conditioned_rmse_nt) < 1e-12, 'negative control: scoring the fan reproduces the in-sample number');
    assert.notEqual(s.rmse_nt, s.conditioned_rmse_nt, 'so the verdict number is the prior\'s, not the fan\'s');
    ok(`the verdict uses the eruption-only prior (${s.rmse_nt.toFixed(2)} nT); the conditioned fan (${s.conditioned_rmse_nt.toFixed(2)} nT) is labelled in-sample`);
}

// ── 8. purity ─────────────────────────────────────────────────────────────
{
    const src = readFileSync(fileURLToPath(new URL('../js/bz/forecast-join.js', import.meta.url)), 'utf8');
    assert.ok(!/^import /m.test(src), 'no imports: it owns no physics');
    assert.ok(!/Date\.now|document\.|window\.|fetch\(/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
    ok('forecast-join.js imports nothing and reads no clock');
}
console.log(`\nbz-forecast-join: ${checks} checks passed`);
