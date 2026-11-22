#!/usr/bin/env node
/**
 * flare-realism.mjs — score the flare-shape model, try a candidate, sweep a parameter.
 *
 *   node scripts/flare-realism.mjs                      the shipped model's scorecard, the v1 reference, the backlog
 *   node scripts/flare-realism.mjs --try '{"shear":{"onsetDeg":70}}'
 *                                                       a candidate (overrides on the shipped set) against the shipped model
 *   node scripts/flare-realism.mjs --sweep shear.onsetDeg=40:80:9
 *                                                       one parameter, lo:hi:steps, with the rows that leave their range
 *   node scripts/flare-realism.mjs --base v1 …          start from the v1 set instead of the shipped one
 *   node scripts/flare-realism.mjs --update             move the committed baseline to the shipped model's score
 *                                                       (refuses to LOWER it; --force overrides, and says so)
 *   node scripts/flare-realism.mjs --json               the shipped scorecard as JSON
 *
 * The scoring is js/flare-realism.js; the parameters are js/flare-geometry.js
 * (FLARE_SHAPE_V2). The loop: add or tighten a target → watch the score fall →
 * find parameters that recover it here → change the shipped set → --update.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as FG from '../js/flare-geometry.js';
import { scorecard, compareScorecards, formatScorecard, baselineOf, OPEN_TARGETS } from '../js/flare-realism.js';

const BASELINE = fileURLToPath(new URL('../tests/fixtures/flare/realism-baseline.json', import.meta.url));
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const baseSet = opt('--base') === 'v1' ? FG.FLARE_SHAPE_V1 : FG.FLARE_SHAPE_DEFAULT;
const shipped = FG.makeFlareModel(null, baseSet);
const card = scorecard(shipped);
const pct = (x) => (x * 100).toFixed(1);
const readBaseline = () => { try { return JSON.parse(readFileSync(BASELINE, 'utf8')); } catch { return null; } };

if (flag('--json')) { console.log(JSON.stringify(card, null, 2)); process.exit(0); }

if (opt('--try')) {
    let over;
    try { over = JSON.parse(opt('--try')); } catch (e) { console.error(`--try needs JSON overrides: ${e.message}`); process.exit(2); }
    const cand = scorecard(FG.makeFlareModel({ id: 'candidate', ...over }, baseSet));
    const cmp = compareScorecards(card, cand);
    console.log(`${card.modelId} ${pct(card.score)}  →  candidate ${pct(cand.score)}   (${cmp.delta >= 0 ? '+' : ''}${(cmp.delta * 100).toFixed(1)})`);
    for (const r of cmp.rows) {
        if (r.from === r.to) continue;
        const d = r.delta === 0 ? '   =' : (r.delta > 0 ? '  up' : 'DOWN');
        console.log(`  ${d}  ${r.label.padEnd(44)} ${String(+r.from.toFixed(3)).padStart(9)} → ${String(+r.to.toFixed(3)).padEnd(9)} ${r.unit.padEnd(5)} score ${r.scoreFrom.toFixed(2)} → ${r.scoreTo.toFixed(2)}`);
    }
    process.exit(0);
}

if (opt('--sweep')) {
    const m = /^([\w.]+)=(-?[\d.eE+-]+):(-?[\d.eE+-]+):(\d+)$/.exec(opt('--sweep'));
    if (!m) { console.error('--sweep needs path=lo:hi:steps, e.g. shear.onsetDeg=40:80:9'); process.exit(2); }
    const [, path, lo, hi, n] = m; const N = Math.max(2, +n);
    const cur = path.split('.').reduce((o, k) => o?.[k], baseSet);
    if (typeof cur !== 'number') { console.error(`no numeric parameter "${path}" in ${baseSet.id}`); process.exit(2); }
    console.log(`sweep ${path} (shipped ${cur}) on ${baseSet.id}`);
    for (let i = 0; i < N; i++) {
        const v = +lo + (+hi - +lo) * i / (N - 1);
        const over = path.split('.').reduceRight((acc, k) => ({ [k]: acc }), v);
        const c = scorecard(FG.makeFlareModel({ id: 'sweep', ...over }, baseSet));
        const off = c.metrics.filter((x) => !x.pass).map((x) => `${x.id} ${x.score.toFixed(2)}`).join(', ');
        console.log(`  ${String(+v.toPrecision(5)).padStart(10)}  ${pct(c.score).padStart(6)}  ${'█'.repeat(Math.round(c.score * 40))}${off ? '   ' + off : ''}`);
    }
    process.exit(0);
}

if (flag('--update')) {
    if (baseSet !== FG.FLARE_SHAPE_DEFAULT) { console.error('--update records the SHIPPED model; drop --base'); process.exit(2); }
    const old = readBaseline(), next = baselineOf(card);
    if (old && next.score < old.score - 1e-9 && !flag('--force')) {
        console.error(`refusing to lower the baseline: ${pct(old.score)} → ${pct(next.score)}. The model got worse on the scorecard. (--force to record it anyway.)`);
        process.exit(1);
    }
    if (old && next.score < old.score - 1e-9) console.warn(`FORCED: baseline lowered ${pct(old.score)} → ${pct(next.score)}`);
    writeFileSync(BASELINE, JSON.stringify({ ...next, recorded: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
    console.log(`baseline: ${old ? pct(old.score) : '—'} → ${pct(next.score)}  (${BASELINE})`);
    process.exit(0);
}

console.log(formatScorecard(card));
const base = readBaseline();
console.log(base ? `\nbaseline ${pct(base.score)} (${base.modelId}, recorded ${base.recorded}) — ${card.score > base.score + 1e-9 ? 'ABOVE it: run --update' : card.score < base.score - 1e-9 ? 'BELOW it' : 'at it'}` : '\nno baseline recorded yet: run --update');
if (baseSet === FG.FLARE_SHAPE_DEFAULT) {
    const v1 = scorecard(FG.makeFlareModel(null, FG.FLARE_SHAPE_V1));
    console.log(`reference ${v1.modelId}: ${pct(v1.score)}  (${v1.passed} of ${v1.rows} rows in range) — the laws shipped until 2026-11-21`);
}
console.log('\nnot scored yet (the backlog — each becomes a row when the kernel can produce it):');
for (const o of OPEN_TARGETS) console.log(`  · ${o.id.padEnd(15)} ${o.what}`);
