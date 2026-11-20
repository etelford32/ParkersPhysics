/**
 * tests/bz-planet.mjs — gate for js/bz/planet-view.js, the scene model of bz.html's
 * hero canvas, and for the renderer's contract (it draws, it does not compute).
 *
 *   node tests/bz-planet.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VIEW, layout, boundaryCurves, dipoleLines, parcels, geoXRe, sceneModel } from '../js/bz/planet-view.js';
import { boundaryModel, magnetopauseRadiusRe } from '../js/geomag/geospace.js';
import { dipoleTilt } from '../js/geomag/dipole.js';

let checks = 0;
const ok = (name) => { checks++; console.log(`  ✓ ${name}`); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);
const NOW = Date.parse('2026-11-20T18:33:30Z');
const read = (p) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8');

// ── 1. the one map: continuous, monotonic, true scale near Earth ──────────
for (const hasForecast of [false, true]) {
    const L = layout({ l1XRe: 224.9, hasForecast });
    near(L.uOfRe(224.9), L.f0, 1e-12, 'L1 sits at the start of the transit segment');
    near(L.uOfRe(VIEW.NEAR_RE), L.f1, 1e-12, 'no jump where the scale changes');
    near(L.uOfRe(VIEW.TAIL_RE), 1, 1e-12);
    let prev = -1;
    for (let x = 224.9; x >= VIEW.TAIL_RE; x -= 0.37) { const u = L.uOfRe(x); assert.ok(u > prev, 'sunward is always left'); prev = u; }
    // true scale: one R_E is the same fraction of the width anywhere inside NEAR_RE
    near(L.uOfRe(0) - L.uOfRe(1), L.uOfRe(-20) - L.uOfRe(-19), 1e-12);
    near((L.uOfRe(0) - L.uOfRe(1)) * L.rePerUnitNear, 1, 1e-12);
    // the compression is DERIVED from the two spans, not typed
    near(L.compression, ((224.9 - VIEW.NEAR_RE) / (L.f1 - L.f0)) / ((VIEW.NEAR_RE - VIEW.TAIL_RE) / (1 - L.f1)), 1e-12);
    assert.ok(L.compression > 3 && L.compression < 6, `compression ${L.compression}`);
    near(L.uOfHoursAhead(0), L.f0, 1e-12, 'the forecast axis starts at L1'); near(L.uOfHoursAhead(L.forecastHours), 0, 1e-12);
    assert.ok(L.uOfHoursAhead(99) === 0 && L.uOfHoursAhead(-3) === L.f0, 'clamped');
}
assert.ok(layout({ l1XRe: 225, hasForecast: false }).f0 < layout({ l1XRe: 225, hasForecast: true }).f0, 'no forecast ⇒ no room is reserved for one');
ok('layout: one continuous monotonic map; true scale inside 30 R_E; compression derived');

// ── 2. boundaries are geospace.js's, nose first, shock always outside ─────
const wind = { speedKms: 375.6, densityCc: 1.56, bzNt: -2.18 }; // the real 2026-11-20 column
const b = boundaryModel(wind);
{
    const c = boundaryCurves(b);
    near(c.magnetopause[0][0], b.r0Re, 1e-9); near(c.magnetopause[0][1], 0, 1e-9);
    near(c.bowShock[0][0], b.bowNoseRe, 1e-9);
    near(b.r0Re, 13.09, 0.02, 'the standoff the production column printed for this wind');
    near(b.bowNoseRe, 17.85, 0.02, 'and its shock nose');
    assert.ok(c.magnetopause.every(([x]) => x >= VIEW.TAIL_RE) && c.bowShock.every(([x]) => x >= VIEW.TAIL_RE));
    for (const [x, z] of c.bowShock) assert.ok(Math.hypot(x, z) > magnetopauseRadiusRe(Math.atan2(z, x), b.r0Re, b.alpha), 'shock outside the magnetopause');
    // An extreme wind where the two fits cross: the shock is CUT there.
    const ex = boundaryModel({ speedKms: 900, densityCc: 30, bzNt: -30 });
    assert.ok(ex.fitsCrossAtXRe != null && ex.fitsCrossAtXRe < 0);
    const cx = boundaryCurves(ex, { tailRe: -70, zMaxRe: 200 });
    assert.ok(cx.bowShock.every(([x]) => x >= ex.fitsCrossAtXRe), 'never drawn past where the fits cross');
    assert.ok(cx.magnetopause.some(([x]) => x < ex.fitsCrossAtXRe), 'the magnetopause carries on');
    ok(`boundaries: standoff ${b.r0Re.toFixed(2)} R_E, shock nose ${b.bowNoseRe.toFixed(2)} R_E; extreme-wind shock cut at ${ex.fitsCrossAtXRe.toFixed(0)} R_E`);
}

// ── 3. dipole lines: the tilt's sign, the L-shell's meaning, the clip ─────
{
    const d0 = dipoleLines(0, b);
    assert.deepEqual(d0.axis, [0, 1]);
    for (const ln of d0.lines) {
        const pts = ln.segments.flat();
        const far = pts.reduce((m, p) => Math.max(m, Math.hypot(p[0], p[1])), 0);
        near(far, ln.L, 0.01, `an L = ${ln.L} line reaches L at the equator`);
        assert.ok(pts.every((p) => Math.hypot(p[0], p[1]) >= 1 - 1e-9), 'nothing inside the planet');
        assert.ok(pts.every((p) => (ln.side === 'day' ? p[0] >= -1e-9 : p[0] <= 1e-9)));
    }
    const d = dipoleLines(25, b);
    assert.ok(d.axis[0] > 0 && d.axis[1] > 0, '+tilt: the north magnetic pole leans toward the Sun');
    near(Math.hypot(...d.axis), 1, 1e-12);
    // the farthest point of a day-side line lies on the tilted magnetic equator, BELOW the x axis for +tilt
    const day = d.lines.find((l) => l.L === 4 && l.side === 'day').segments.flat();
    const apex = day.reduce((m, p) => (Math.hypot(...p) > Math.hypot(...m) ? p : m));
    near(Math.atan2(apex[1], apex[0]) * 180 / Math.PI, -25, 1.6);
    // a magnetopause pushed inside geosynchronous orbit clips the 6.62 line on the day side
    const squeezed = boundaryModel({ speedKms: 900, densityCc: 40, bzNt: -25 });
    assert.ok(squeezed.r0Re < VIEW.GEO_RE, `standoff ${squeezed.r0Re}`);
    const cl = dipoleLines(0, squeezed).lines.find((l) => l.L === 6.62 && l.side === 'day').segments.flat();
    assert.ok(cl.every((p) => Math.hypot(...p) <= magnetopauseRadiusRe(Math.atan2(Math.abs(p[1]), p[0]), squeezed.r0Re, squeezed.alpha) + 1e-9));
    assert.ok(cl.reduce((m, p) => Math.max(m, Math.hypot(...p)), 0) < 6.6, 'the clipped line never reaches L');
    ok('dipole: axis leans sunward for +tilt, lines reach their L, clipped at the magnetopause and the planet');
}

// ── 4. parcels: the engine's arrival time read back as distance ───────────
const cols = ['arrives', 'kind', 'milan_kv', 'sigma_kv', 'newell_scaled_kv', 'bz_nt', 'delay_min'];
const mk = (minutesAway, delay, bz) => [new Date(NOW + minutesAway * 60e3).toISOString(), 'F', 0, 0, 0, bz, delay];
{
    const trace = { columns: cols, rows: [mk(-10, 58, 1), mk(0.001, 58, -1), mk(29, 58, -2), mk(58, 58, 3), mk(70, 58, 9), mk(31, 58, null)] };
    const p = parcels({ trace, nowMs: NOW, l1XRe: 224.9, noseRe: 17.85, everyMin: 0 });
    assert.equal(p.length, 3, 'arrived, unmeasured (beyond L1) and gap rows are not parcels');
    near(p[0].xRe, 17.85, 0.01, 'arriving now ⇒ at the shock nose');
    near(p[1].xRe, 17.85 + 0.5 * (224.9 - 17.85), 1e-9, 'half the delay left ⇒ halfway');
    near(p[2].xRe, 224.9, 1e-9, 'just measured ⇒ at L1');
    assert.equal(p[2].seenAt, NOW);
    // a minute later every parcel is closer by exactly its own speed
    const p2 = parcels({ trace, nowMs: NOW + 60e3, l1XRe: 224.9, noseRe: 17.85, everyMin: 0 });
    near(p[1].xRe - p2.find((q) => q.arrives === p[1].arrives).xRe, (224.9 - 17.85) / 58, 1e-9);
    // thinning keeps order and never invents
    const dense = { columns: cols, rows: Array.from({ length: 58 }, (_, k) => mk(k + 0.5, 58, k % 2 ? 1 : -1)) };
    const thin = parcels({ trace: dense, nowMs: NOW, l1XRe: 224.9, noseRe: 17.85, everyMin: 2 });
    assert.ok(thin.length >= 28 && thin.length <= 30, `${thin.length} of 58 at one per 2 min`);
    for (let i = 1; i < thin.length; i++) assert.ok(thin[i].xRe > thin[i - 1].xRe);
    assert.ok(thin.every((q) => dense.rows.some((r) => r[5] === q.bz && Date.parse(r[0]) === q.arrives)));
    assert.equal(parcels({ trace: { columns: ['arrives'], rows: [] }, nowMs: NOW, l1XRe: 224.9, noseRe: 17.85 }).length, 0);
    ok('parcels: at the nose when arriving, at L1 when just seen, linear between; gaps and unmeasured rows dropped');
}

// ── 5. GOES by local time ─────────────────────────────────────────────────
near(geoXRe(12), 6.62, 1e-12); near(geoXRe(18), 0, 1e-9); near(geoXRe(0), -6.62, 1e-9); near(geoXRe(9.6), geoXRe(14.4), 1e-9);
ok('GOES: noon is sunward, dusk and dawn are over the planet, midnight is down the tail');

// ── 6. the scene from a column: nothing invented when a rung is missing ───
const column = { rungs: [
    { id: 'l1', kind: 'MEASURED', where: 'SOLAR1, ~224.9 R_E upstream', time: '2026-11-20T18:27:00.000Z', values: { bz_nt: -1.71 }, sigma: { bz_nt: 0.36 } },
    { id: 'bow_shock', kind: 'ESTIMATED', values: { bz_nt: -2.18, speed_kms: 375.6, density_cc: 1.56 } },
    { id: 'sheath', kind: 'ESTIMATED', values: { bz_nt: -6.2, compression_ratio: 2.84 } },
    { id: 'magnetopause', kind: 'ESTIMATED', values: { standoff_re: 13.09, reconnection_rate_kv: 19.2 }, sigma: { reconnection_rate_kv: 2.3 } },
    { id: 'geosynchronous', kind: 'MEASURED', satellites: [{ slot: 'GOES-East', local_time_h: 13.7, measured: { hp_residual_nt: 12.15 } }, { slot: 'GOES-West', local_time_h: 9.6, measured: { hp_residual_nt: 9.38 } }] },
    { id: 'ring_current', kind: 'MEASURED', values: { dst_nt: -4 } },
    { id: 'ground', kind: 'MEASURED', values: { dbdt_peak_nt_s: 0.5, at_station: 'CMO' } },
] };
const fluxTrace = { columns: cols, rows: Array.from({ length: 50 }, (_, k) => mk(k + 1, 58.5, -1 - (k % 5) * 0.3)) };
{
    const s = sceneModel({ column, fluxTrace, nowMs: NOW });
    near(s.boundaries.r0Re, column.rungs[3].values.standoff_re, 0.02, 'the drawn magnetopause IS the column\'s standoff');
    near(s.tiltDeg, dipoleTilt(new Date(NOW)), 1e-12);
    assert.equal(s.l1.xRe, 224.9); assert.equal(s.goes.length, 2); assert.ok(s.parcels.length > 20);
    assert.ok(s.sheath.xRe > s.boundaries.r0Re && s.sheath.xRe < s.boundaries.bowNoseRe, 'the sheath value is drawn in the sheath');
    assert.equal(s.arrowFullNt, VIEW.ARROW_MIN_NT, 'a quiet day is not zoomed into a storm');
    assert.equal(s.forecast.length, 0); assert.equal(s.layout.hasForecast, false);
    assert.ok(s.disclosures[0].includes(s.layout.compression.toFixed(1)), 'the printed compression is the derived one');
    assert.ok(!s.disclosures.some((d) => /forecast/i.test(d)), 'no forecast, no forecast disclosure');
    // storm: the arrow scale follows the data
    const storm = sceneModel({ column, fluxTrace: { columns: cols, rows: [mk(5, 58, -32)] }, nowMs: NOW });
    assert.equal(storm.arrowFullNt, 32);
    // dead L1: no parcels, no L1 marker; dead shock wind: NO boundary (a nominal one would look measured)
    const noL1 = sceneModel({ column: { rungs: column.rungs.map((r) => (r.id === 'l1' ? { id: 'l1', kind: 'NOT_AVAILABLE' } : r)) }, fluxTrace, nowMs: NOW });
    assert.equal(noL1.l1, null); assert.equal(noL1.parcels.length, 0);
    const noWind = sceneModel({ column: { rungs: column.rungs.filter((r) => r.id !== 'bow_shock') }, fluxTrace, nowMs: NOW });
    assert.equal(noWind.boundaries, null); assert.equal(noWind.parcels.length, 0); assert.equal(noWind.magnetopause, null);
    const empty = sceneModel({ column: null, fluxTrace: null, nowMs: NOW });
    assert.equal(empty.boundaries, null); assert.equal(empty.goes.length, 0); assert.ok(empty.dipole.lines.length > 0, 'the planet and its tilt are always drawable');
    // with a joined forecast: room is made, hollow arrows listed, the disclosure appears
    const join = { status: 'joined', statusText: 'x', l1HorizonMs: NOW + 50 * 60e3, endMs: NOW + 24 * 3600e3,
        prior: [{ t: NOW + 65 * 60e3, p5: -20, p50: -8, p95: 3 }, { t: NOW + 10 * 3600e3, p5: -30, p50: -14, p95: 6 }] };
    const sj = sceneModel({ column, fluxTrace, join, nowMs: NOW });
    assert.equal(sj.layout.hasForecast, true); assert.equal(sj.forecast.length, 2);
    near(sj.forecast[0].hoursAhead, 0.25, 1e-9); assert.equal(sj.arrowFullNt, 30, 'the scale holds the widest forecast band, not just its median');
    assert.ok(sj.forecast.every((f) => sj.layout.uOfHoursAhead(f.hoursAhead) < sj.layout.f0), 'every forecast arrow is LEFT of L1');
    assert.ok(sj.parcels.every((p) => sj.layout.uOfRe(p.xRe) >= sj.layout.f0), 'every measured parcel is at or right of L1');
    assert.ok(sj.disclosures.some((d) => /not a measurement/.test(d)));
    for (const st of ['no_rope', 'rope_down', 'pending']) assert.equal(sceneModel({ column, fluxTrace, join: { status: st, prior: [] }, nowMs: NOW }).forecast.length, 0);
    ok('scene: the column\'s standoff, tilt from dipole.js, measured right of L1 and forecast left of it; dead rungs draw nothing');
}

// ── 7. the renderer draws; it does not compute ────────────────────────────
{
    const src = read('../js/bz-planet-canvas.js'), code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports.sort(), ['./bz/page-model.js', './bz/planet-view.js'].sort(), 'the renderer imports only the scene model and the formatters');
    for (const banned of ['magnetopauseRadiusRe', 'bowShockRadiusRe', 'boundaryModel', 'dipoleTilt', 'shueStandoff', 'Math.cos(', 'Math.sin(']) assert.ok(!code.includes(banned), `renderer must not use ${banned}`);
    assert.ok(/prefers-reduced-motion/.test(src), 'motion is optional');
    const model = read('../js/bz/planet-view.js').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!/Date\.now|document\.|window\./.test(model), 'the scene model is pure');
    const html = read('../bz.html');
    assert.ok(html.indexOf('id="bz-planet"') > 0 && html.indexOf('id="bz-planet"') < html.indexOf('id="bz-ladder"'), 'the canvas is the first thing on the page');
    assert.ok(/<canvas id="bz-planet"[^>]*role="img"[^>]*aria-label=/.test(html));
    ok('renderer: draws scene numbers only; canvas leads the page and is labelled');
}
console.log(`\nbz-planet: ${checks} checks passed`);
