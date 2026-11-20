/**
 * tests/bz-page.mjs — gate for bz.html's data model (BZ_ENGINE_PLAN.md B6):
 * js/bz/page-model.js, plus the page's static contract.
 *
 *   node tests/bz-page.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KINDS, VERDICTS, SERIES_COLORS, num, relTime, ladderRows, scorecard, chartDomain, traceSeries, fluxSeries, yExtent, ticks, linePath, nearest } from '../js/bz/page-model.js';
import { buildColumn, RUNG_ORDER } from '../js/bz/column.js';
import { analyzeFlux } from '../js/bz/flux-analysis.js';
import { analyzeL1 } from '../js/bz/l1-analysis.js';
import { normalizeL1Mag, normalizeEphem, normalizeL1Plasma } from '../js/bz/feeds.js';
import { SIMULATIONS } from '../js/simulations-catalog.js';
import { unitNormal, plantedField, plantedFeeds } from './helpers/bz-planted-wind.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (name) => { checks++; console.log(`  ✓ ${name}`); };
const NOW = Date.parse('2026-11-20T14:20:00Z');

// ── 1. formatting: a gap is a dash, a minus is a minus ────────────────────
{
    assert.equal(num(null), '—'); assert.equal(num(NaN), '—'); assert.equal(num(undefined), '—'); assert.equal(num(Infinity), '—');
    assert.equal(num(-0.3, 2), '−0.30', 'a true minus sign, not a hyphen');
    assert.equal(num(0.3, 2, { sign: true }), '+0.30');
    assert.equal(num(-0.001, 1), '0.0', 'no "−0.0"');
    assert.equal(num(0, 1, { sign: true }), '0.0', 'zero carries no sign');
    assert.equal(relTime('2026-11-20T15:14:00Z', NOW), 'in 54 min');
    assert.equal(relTime('2026-11-20T14:17:00Z', NOW), '3 min ago');
    assert.equal(relTime('2026-11-20T11:20:00Z', NOW), '3.0 h ago');
    assert.equal(relTime('2026-11-20T14:20:10Z', NOW), 'now');
    assert.equal(relTime('nope', NOW), '');
    ok('num / relTime: gaps are dashes, zero has no sign, times read as a person would say them');
}

// ── 2. the ladder ─────────────────────────────────────────────────────────
const f = plantedFeeds({ field: plantedField(11, 1440), normal: unitNormal(20), speedKms: 420, nowMs: NOW });
const mag = normalizeL1Mag(f.mag, { nowMs: NOW }), ephem = normalizeEphem(f.eph, { nowMs: NOW }), plasma = normalizeL1Plasma(f.wind, { nowMs: NOW });
const flux = analyzeFlux({ mag, ephem, plasma, nowMs: NOW, minutes: 330 });
const l1 = analyzeL1({ mag, ephem, nowMs: NOW, minutes: 260 });
{
    const col = buildColumn({ flux, geo: null, nowMs: NOW });
    const rows = ladderRows(col, NOW);
    assert.deepEqual(rows.map((r) => r.id), RUNG_ORDER, 'every rung of the column is a row, in order');
    for (const r of rows) {
        assert.ok(KINDS[r.kind], `${r.id}: a known kind`);
        assert.ok(r.glyph && r.kindLabel, `${r.id}: a glyph AND a word, never colour alone`);
        assert.ok(r.basis.length > 5, `${r.id}: says where it comes from`);
        assert.ok(!/undefined|NaN|null/.test(r.headline + r.sub + (r.forecast ?? '')), `${r.id}: no leaked undefined/NaN/null — "${r.headline}"`);
    }
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.match(by.l1.headline, /^Bz [+−]?\d+\.\d\d nT ± \d+\.\d\d$/);
    assert.equal(by.l1.kindLabel, 'Measured');
    assert.match(by.bow_shock.forecast, /arriving in \d+ min$/, 'the forecast says when');
    assert.match(by.sheath.sub, /compressed ×\d\.\d/);
    assert.match(by.magnetopause.headline, /kV of flux opening ± /);
    for (const id of ['geosynchronous', 'ring_current', 'e_region', 'ground']) { assert.equal(by[id].headline, '—'); assert.equal(by[id].kindLabel, 'No data'); assert.equal(by[id].time, ''); }
    assert.equal(by.leo.kindLabel, 'Not built');
    assert.equal(by.subsurface.kindLabel, 'Elsewhere'); assert.equal(by.subsurface.href, 'earth-interior.html');
    assert.deepEqual(ladderRows(null, NOW), [], 'no column ⇒ no rows, not a crash');
    assert.equal(new Set(Object.values(KINDS).map((k) => k.glyph)).size, Object.keys(KINDS).length, 'every kind has its own glyph');
    ok('ladder: ten rows, each with glyph + word + basis; missing rungs read "—"; nothing leaks undefined');
}

// ── 3. the scorecard prints losses as losses ──────────────────────────────
{
    // The engine's actual first-day numbers (BZ_ENGINE_PLAN.md §12–§15).
    const sc = scorecard({
        l1: { withheld_score: { SOLAR1: { n: 1349, rmse_nt: 1.159, rmse_unshifted_nt: 1.146, skill_vs_unshifted: -0.023, coverage68: 0.664 },
            ACE: { n: 1327, rmse_nt: 1.378, rmse_unshifted_nt: 1.363, skill_vs_unshifted: -0.022, coverage68: 0.66 } } },
        geo: { satellites: { 'GOES-19': { slot: 'GOES-East', filter: { score: { n: 9460, rmse_nt: 4.74, rmse_persistence_nt: 4.34, skill_vs_persistence: -0.194, coverage68: 0.657 } } } } },
        ring: { model: { score: { hours: 22, rmse_nt: 6.83, rmse_persistence_nt: 8.09, skill_vs_persistence: 0.286 } } },
        ground: { timing_score: { status: 'no_events_in_window', matched: [] } },
    });
    const by = Object.fromEntries(sc.rows.map((r) => [r.id, r]));
    assert.equal(by['l1-SOLAR1'].verdict, 'level', 'skill −0.02 is level, not a win');
    assert.equal(by['geo-GOES-19'].verdict, 'behind', 'losing to persistence is shown as losing');
    assert.equal(by.ring.verdict, 'ahead');
    assert.equal(by.timing.verdict, 'unscored');
    assert.match(by.timing.note, /nothing to time/);
    assert.deepEqual(sc.tally, { ahead: 1, level: 2, behind: 1, unscored: 1 });
    assert.equal(by['geo-GOES-19'].controlName, 'it will be what it was 30 minutes ago');
    for (const r of sc.rows) assert.ok(VERDICTS[r.verdict].glyph && VERDICTS[r.verdict].label);
    assert.deepEqual(scorecard({}).rows, []);
    assert.equal(scorecard({ ring: { model: null } }).rows[0].verdict, 'unscored', 'no model run ⇒ unscored, never a pass');
    ok('scorecard: −0.02 is "level", −0.19 is "behind", +0.29 is "ahead"; nothing unscored is called a pass');
}

// ── 4. chart geometry: one time axis, gaps stay gaps ──────────────────────
{
    const dom = chartDomain(NOW);
    assert.equal(dom.now, NOW); assert.equal(dom.t0, NOW - 3 * 3600e3); assert.ok(dom.t1 > NOW);
    const tr = l1.trace;
    const s = traceSeries(tr, tr.bz, dom);
    assert.ok(s.length > 170 && s.length <= 181, `three hours of minutes inside the domain (${s.length})`);
    assert.ok(s.every((p) => p.t >= dom.t0 && p.t <= dom.t1));
    assert.equal(traceSeries(tr, [1, null, NaN, 4], { t0: -Infinity, t1: Infinity }).filter((p) => p.v == null).length, 2, 'null and NaN are both gaps');
    assert.deepEqual(traceSeries(null, [1], dom), []);

    const fx = fluxSeries(flux.flux.trace, dom);
    assert.ok(fx.estimated.length > 100 && fx.forecast.length > 20);
    assert.ok(fx.estimated.every((p) => p.t <= NOW), 'ESTIMATED is everything that has arrived');
    assert.ok(fx.forecast.slice(1).every((p) => p.t > NOW), 'FORECAST is everything still in transit');
    assert.equal(fx.forecast[0], fx.estimated[fx.estimated.length - 1], 'the two runs share their joining point, so the line is unbroken');
    assert.deepEqual(fluxSeries({ columns: ['x'], rows: [] }, dom), { estimated: [], forecast: [] });

    const [lo, hi] = yExtent([[{ v: 2 }, { v: 5 }, { v: null }]]);
    assert.ok(lo < 0 && hi > 5, 'zero is always on the axis');
    assert.deepEqual(yExtent([[]]), [-0.12, 1.12], 'no data ⇒ a sane empty axis');
    assert.deepEqual(ticks(-3.2, 4.1), [-2, 0, 2, 4]);
    assert.deepEqual(ticks(0, 0.9), [0, 0.2, 0.4, 0.6, 0.8]);
    const d = linePath([{ t: 0, v: 1 }, { t: 1, v: 2 }, { t: 2, v: null }, { t: 3, v: 4 }, { t: 4, v: 5 }], (t) => t * 10, (v) => v);
    assert.equal(d, 'M0.0,1.0L10.0,2.0M30.0,4.0L40.0,5.0', 'the pen lifts at a gap — no line is drawn through missing data');
    assert.equal(nearest([{ t: 0, v: 1 }, { t: 100e3, v: 2 }], 90e3).v, 2);
    assert.equal(nearest([{ t: 0, v: 1 }], 10 * 60e3), null, 'nothing within reach ⇒ no readout');
    assert.equal(nearest([{ t: 0, v: null }], 0), null);
    ok('charts: one shared domain, estimated/forecast split at now and joined, the pen lifts at every gap');
}

// ── 5. the page's static contract ─────────────────────────────────────────
{
    const html = readFileSync(join(ROOT, 'bz.html'), 'utf8');
    const js = readFileSync(join(ROOT, 'js', 'bz-page.js'), 'utf8');
    assert.match(html, /<nav><\/nav>/, 'the canonical nav shell');
    assert.match(html, /initNav\("bz"\)/);
    assert.ok(!/<script type="importmap">/.test(html), 'no three.js on this page — nothing to map');
    for (const id of ['bz-ladder', 'bz-status', 'bz-chart-l1', 'bz-chart-flux', 'bz-chart-geo', 'bz-score-body', 'bz-tip', 'bz-unverified']) assert.ok(html.includes(`id="${id}"`), `#${id}`);
    assert.match(html, /\.bz-tip\[hidden\]\s*\{\s*display:none/, 'an author display would otherwise beat [hidden]');
    assert.match(html, /\.bz-unverified\[hidden\]\s*\{\s*display:none/);
    assert.match(js, /startBzProvider\(\)/, 'the column comes through the ONE provider');
    assert.ok(!/fetch\(['"`]\/api\/bz\/column/.test(js), '…and is never fetched a second way');
    assert.ok(!/Math\.(sin|cos|sqrt|hypot|atan2)\(/.test(js), 'the renderer computes no physics');
    assert.ok(!/AI-powered/i.test(html));
    // Three charts on one shared time axis, plus the 24-hour outlook in the stage card (its own time axis, drawn
    // only when a CME forecast exists) — and no chart is given a second y scale.
    assert.equal((html.match(/class="bz-svg"/g) ?? []).length, 4);
    assert.match(html, /\.bz-outlook\[hidden\]\s*\{\s*display:none/);
    assert.ok(!/yRight|y2Axis|secondAxis/i.test(js));
    // Colours: the validated all-pairs slots, used for identity only.
    assert.deepEqual([...SERIES_COLORS], ['#3987e5', '#d95926', '#199e70']);
    const sim = SIMULATIONS.find((s) => s.id === 'bz');
    assert.ok(sim && sim.href === 'bz.html' && sim.category === 'space-weather', 'filed in the catalogue, so the hub lists it');
    assert.ok(readFileSync(join(ROOT, 'space-weather-hub.html'), 'utf8').includes('bz.html'), 'the generated hub page links it');
    ok('page: canonical nav, one provider, no physics in the renderer, three small multiples, filed on the hub');
}

console.log(`\nbz-page: ${checks} checks passed`);
