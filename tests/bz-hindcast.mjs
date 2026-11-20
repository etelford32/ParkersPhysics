/**
 * tests/bz-hindcast.mjs — gate for js/bz/hindcast.js and the committed archive hindcast
 * (BZ_ENGINE_PLAN.md §20).
 *
 *   node tests/bz-hindcast.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { arrivedWind, runWindow, hindcastDst, bootstrapSkill, verdictFromInterval, rng, HINDCAST_DEFAULTS } from '../js/bz/hindcast.js';
import { integrateDst } from '../js/ring-current-model.js';
import { l1LagMinutes } from '../js/geomag/geospace.js';
import { hindcastTable } from '../js/bz/page-model.js';
import { build } from '../scripts/bz-hindcast.mjs';

let checks = 0;
const ok = (name) => { checks++; console.log(`  ✓ ${name}`); };
const HOUR = 3600e3, MIN = 60e3, T0 = Date.parse('2026-08-01T00:00:00Z');

// ── 1. arrival ordering: the delay is geospace's, overtaken wind is dropped, gaps are not filled ──
{
    const N = 600, speed = Array(N).fill(400), density = Array(N).fill(5), bz = Array.from({ length: N }, (_, i) => Math.sin(i / 40));
    const w = arrivedWind({ t0Ms: T0, speed, density, bz });
    assert.equal(w.length, N); assert.equal(w.overtaken, 0);
    assert.equal(w.arrival[0] - w.seen[0], l1LagMinutes(400) * MIN, 'the one delay rule');
    for (let i = 1; i < w.length; i++) assert.ok(w.arrival[i] > w.arrival[i - 1]);
    // a fast stream behind slow wind overtakes it: the overtaken minutes go, order stays strict
    const sp2 = speed.map((v, i) => (i >= 300 ? 800 : v));
    const w2 = arrivedWind({ t0Ms: T0, speed: sp2, density, bz });
    assert.ok(w2.overtaken > 20, `${w2.overtaken} overtaken`);
    for (let i = 1; i < w2.length; i++) assert.ok(w2.arrival[i] > w2.arrival[i - 1]);
    // gaps: no Bz ⇒ no sample; no plasma (mag_only) ⇒ the last speed is held, never 400 by default
    const bz3 = bz.slice(); for (let i = 100; i < 160; i++) bz3[i] = null;
    const sp3 = speed.map((v, i) => (i >= 200 && i < 260 ? null : 520));
    const w3 = arrivedWind({ t0Ms: T0, speed: sp3, density, bz: bz3 });
    assert.equal(w3.length, N - 60);
    assert.ok(!Array.from(w3.seen).some((t) => t >= T0 + 100 * MIN && t < T0 + 160 * MIN));
    assert.ok(Array.from(w3.v).every((v) => v === 520), 'held speed, not a nominal one');
    assert.equal(arrivedWind({ t0Ms: T0, speed: Array(50).fill(null), density, bz }).length, 0, 'no speed at all ⇒ no wind');
    ok('arrivedWind: geospace delay, strict arrival order, overtaken dropped, gaps stay gaps');
}

// ── a planted world: Dst IS the model's own response to a known wind ───────────────────────────
function planted({ days = 12, storm = true } = {}) {
    const N = days * 1440, r = rng(7), speed = [], density = [], bz = [];
    for (let i = 0; i < N; i++) {
        const day = i / 1440, inStorm = storm && ((day > 3 && day < 3.5) || (day > 7.2 && day < 8));
        speed.push(inStorm ? 600 : 420); density.push(inStorm ? 12 : 5);
        bz.push(inStorm ? -14 + 3 * Math.sin(i / 30) : 1.5 * Math.sin(i / 200) + (r() - 0.5));
    }
    const wind = arrivedWind({ t0Ms: T0, speed, density, bz });
    const samples = Array.from({ length: wind.length }, (_, i) => ({ t: wind.arrival[i], v: wind.v[i], n: wind.n[i], bz: wind.bz[i] }));
    const first = Math.ceil(samples[0].t / HOUR) * HOUR;
    const run = integrateDst(samples.filter((s) => s.t >= first), -8, { model: 'obm' });
    const dst = []; let k = 0;
    for (let h = first; h < run[run.length - 1].t; h += HOUR) { while (k + 1 < run.length && run[k + 1].t <= h) k++; dst.push([h, run[k].dst]); }
    return { archive: { t0Ms: T0, speed, density, bz, dst }, wind };
}

// ── 2. with the measured wind the model reproduces its own world; persistence does not ─────────
const P = planted();
{
    const h = hindcastDst(P.archive, { bootstrapN: 200 });
    const m = h.drivers['measured/stamp'];
    assert.ok(m.windows > 30 && m.disturbed_windows > 3, `${m.windows} windows, ${m.disturbed_windows} disturbed`);
    for (const L of [1, 3, 6, 12, 24]) {
        assert.ok(m.all[L].rmse_nt < 0.5, `lead ${L} h: rmse ${m.all[L].rmse_nt}`);
        assert.ok(m.all[L].skill > 0.99, `lead ${L} h: skill ${m.all[L].skill}`);
        assert.equal(m.all[L].verdict, 'ahead');
        assert.ok(m.all[L].skill_ci95[0] <= m.all[L].skill && m.all[L].skill <= m.all[L].skill_ci95[1] + 1e-12, 'the interval holds its point');
    }
    // the same result twice: the bootstrap is seeded
    assert.deepEqual(hindcastDst(P.archive, { bootstrapN: 200 }).drivers['measured/stamp'].all[6], m.all[6]);
    ok(`planted world: measured-wind skill ${m.all[6].skill.toFixed(4)} at 6 h over ${m.windows} windows; deterministic`);
}

// ── 3. the frozen driver is the forecast, and it must be WORSE where the wind changes ──────────
{
    const h = hindcastDst(P.archive, { bootstrapN: 200 });
    const f = h.drivers['frozen/stamp'], m = h.drivers['measured/stamp'];
    assert.ok(f.all[1].rmse_nt < 1.5, 'inside the L1 horizon the frozen driver still has real wind');
    assert.ok(f.disturbed[12].rmse_nt > 5 * m.disturbed[12].rmse_nt + 1, `frozen ${f.disturbed[12].rmse_nt} vs measured ${m.disturbed[12].rmse_nt}`);
    // direct: a frozen window never reads wind measured after its anchor
    const anchor = P.archive.dst[80][0];
    const dstAt = (ms) => new Map(P.archive.dst).get(ms);
    const a = runWindow({ wind: P.wind, dstAt, anchorMs: anchor, opts: { driver: 'frozen' } });
    const future = { ...P.wind, bz: Float64Array.from(P.wind.bz, (v, i) => (P.wind.seen[i] > anchor ? v - 50 : v)) };
    const b = runWindow({ wind: future, dstAt, anchorMs: anchor, opts: { driver: 'frozen' } });
    assert.deepEqual(b.leads, a.leads, 'changing only the FUTURE wind does not change a frozen forecast');
    const c = runWindow({ wind: future, dstAt, anchorMs: anchor, opts: { driver: 'measured' } });
    const d = runWindow({ wind: P.wind, dstAt, anchorMs: anchor, opts: { driver: 'measured' } });
    assert.notDeepEqual(c.leads, d.leads, 'negative control: the measured driver does read it');
    ok('frozen driver: causal to the bit, right inside the L1 horizon, wrong once the wind changes');
}

// ── 4. a quiet world: no claim of a win when there is nothing to beat ──────────────────────────
{
    const Q = planted({ storm: false });
    const h = hindcastDst(Q.archive, { bootstrapN: 200 });
    assert.equal(h.drivers['measured/stamp'].disturbed_windows, 0);
    assert.equal(h.drivers['measured/stamp'].disturbed[6].n, 0);
    assert.equal(h.drivers['measured/stamp'].disturbed[6].verdict, 'unscored', 'an empty class is unscored, never level or ahead');
    assert.equal(h.drivers['measured/stamp'].disturbed[6].skill, null);
    ok('quiet world: the disturbed class is empty and says so');
}

// ── 5. windows that cannot be judged are skipped and counted ───────────────────────────────────
{
    const G = planted();
    for (let i = 2000; i < 6000; i++) G.archive.bz[i] = null;
    const h = hindcastDst(G.archive, { bootstrapN: 50 });
    assert.ok(h.skipped.thin_wind >= 8, `skipped ${JSON.stringify(h.skipped)}`);
    assert.ok(h.drivers['measured/stamp'].windows < hindcastDst(P.archive, { bootstrapN: 50 }).drivers['measured/stamp'].windows);
    ok(`gaps: ${h.skipped.thin_wind} windows skipped for thin wind, none scored on held values`);
}

// ── 6. the verdict comes from the interval ─────────────────────────────────────────────────────
{
    assert.equal(verdictFromInterval(0.3, { lo: 0.1, hi: 0.5 }), 'ahead');
    assert.equal(verdictFromInterval(0.3, { lo: -0.1, hi: 0.5 }), 'level', 'a positive point with an interval through zero is NOT a win');
    assert.equal(verdictFromInterval(-0.4, { lo: -0.9, hi: -0.1 }), 'behind');
    assert.equal(verdictFromInterval(0.9, null), 'unscored'); assert.equal(verdictFromInterval(null, { lo: 0, hi: 1 }), 'unscored');
    assert.equal(bootstrapSkill([{ anchorMs: 0, leads: { 1: { err: 1, perr: 2 } } }], 1), null, 'too few days ⇒ no interval');
    const a = rng(5), b = rng(5); assert.equal(a(), b());
    ok('verdicts: ahead/behind only when the whole interval is on one side');
}

// ── 7. the committed result IS this code on the committed archive ──────────────────────────────
{
    const file = fileURLToPath(new URL('../data/bz/hindcast-dst.json', import.meta.url));
    const committed = readFileSync(file, 'utf8'), fresh = build();
    assert.equal(committed, `${JSON.stringify(fresh, null, 1)}\n`, 'data/bz/hindcast-dst.json is stale — run node scripts/bz-hindcast.mjs');
    const r = JSON.parse(committed);
    assert.equal(r.archive.days, 131); assert.match(r.archive.source, /REAL production data/);
    assert.equal(r.archive.sha256.length, 64);
    const m = r.drivers['measured/stamp'], f = r.drivers['frozen/stamp'];
    assert.ok(m.windows > 480 && m.disturbed_windows > 80);
    // What was measured (plan §20) — pinned so a change to the model or the scoring is seen:
    assert.equal(m.disturbed[3].verdict, 'ahead'); assert.equal(m.disturbed[12].verdict, 'ahead');
    assert.equal(m.quiet[24].verdict, 'behind'); assert.ok(m.all[24].bias_nt < -10, 'the model drifts negative over a quiet day');
    assert.equal(f.all[6].verdict, 'behind'); assert.equal(f.all[24].verdict, 'behind');
    assert.notEqual(f.all[1].verdict, 'ahead', 'as a forecast it has not shown a win at any lead');
    assert.ok(r.drivers['measured/stamp'].all[1].skill < 0 && r.drivers['measured/centre'].all[1].skill > 0, 'the 1-hour answer flips with the time-stamp convention');
    assert.equal(r.not_hindcast.length, 2);
    // the page's table is that file, row for row
    const t = hindcastTable(r);
    assert.deepEqual(t.rows.map((x) => x.lead_h), HINDCAST_DEFAULTS.leadsH);
    assert.equal(t.rows.find((x) => x.lead_h === 3).given.verdict, m.all[3].verdict);
    assert.equal(t.rows.find((x) => x.lead_h === 3).storm.skill, m.disturbed[3].skill);
    assert.equal(t.rows.find((x) => x.lead_h === 6).forecast.verdict, 'behind');
    assert.equal(hindcastTable(null).rows.length, 0);
    ok(`real archive: ${m.windows} windows over ${r.archive.days} days; given the wind, ahead in storms (3 h ${m.disturbed[3].skill}); as a forecast, behind from 6 h (${f.all[6].skill})`);
}
console.log(`\nbz-hindcast: ${checks} checks passed`);
