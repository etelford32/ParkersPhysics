/**
 * glacier-engine.mjs — node gate for Glacier Watch (pairs rules, engine, live route, bake)
 * ═══════════════════════════════════════════════════════════════════════════════════════
 *   node tests/glacier-engine.mjs
 *
 * Pins, in order:
 *   1. js/glacier-pairs.js — ITS_LIVE granule names (real Landsat / Sentinel-2 /
 *      Sentinel-1 names), the short-baseline rule, S3 prefixes, footprints, the
 *      3×3-median sampler and the int16 encoding;
 *   2. THE JOIN: the daily route's reader (api/glaciers/velocity.js samplePairBuffer,
 *      jsfive) on a crop of a REAL 2026-11-06 Columbia pair reproduces the Python
 *      baker's values on the FULL granule EXACTLY, gaps included — so the baked year
 *      and the live tail are one series. Negative control: points moved 600 km (a
 *      wrong-projection granule) are skipped as 'outside', never sampled;
 *   3. js/glacier-engine.js — calendar + hydrological years, the pair-averaged
 *      seasonal expectation against quadrature, outlier flags, the daily series,
 *      the "faster / slower than usual" rule (with a no-signal negative control),
 *      trend fitting, and particle advection (uniform field exact; rigid rotation
 *      conserves radius; parcels stop at the ice edge);
 *   4. THE BAKE (data/glaciers/*.json) — structure, and physics it cannot fake:
 *      every flowline runs DOWNHILL (head above end on the GLO-30 DEM), the two
 *      outlets are fast (> 5 km/yr) and the small mountain glaciers slow;
 *   5. the WGMS mass-balance bake;
 *   6. the daily drivers: Open-Meteo URL building / merge / degree-days / season rank
 *      (js/glacier-weather.js) and the USGS + SNOTEL parsers (api/glaciers/stations.js)
 *      on SYNTHETIC payloads shaped like the documented schemas — both hosts are
 *      egress-blocked at build time, so these pin our parsing, not the live schema
 *      (the route self-reports field_map / unmapped for that);
 *   7. the chart kit's pure helpers;
 *   8. the EarthView layer's inputs: data/glaciers/summary.json is EXACTLY what the engine
 *      computes from the committed archive (stale summary = failure), every state the
 *      engine can emit has a style, pixel picking geometry, the log-compressed flow rate;
 *   9. the weekly refresh gate (scripts/check-glacier-refresh.mjs): every refusal rule with a
 *      planted case, a tolerated single failure LISTED with its older date, same-day re-runs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../js/glacier-pairs.js';
import * as E from '../js/glacier-engine.js';
import { samplePairBuffer } from '../api/glaciers/velocity.js';
import { parseCsv, parseSeries } from '../scripts/build-glacier-massbalance.mjs';
import * as W from '../js/glacier-weather.js';
import { niceTicks, timeTicks, extent } from '../js/glacier-charts.js';
import { buildSummary } from '../scripts/build-glacier-summary.mjs';
import { compareArchives, markdown as refreshMarkdown } from '../scripts/check-glacier-refresh.mjs';
import { flowRate, rayAngle, STATE_STYLE } from '../js/earth-glacier-layer.js';
import { parseUsgs, nearestSnotel, parseAwdbData, STATIONS } from '../api/glaciers/stations.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p));
const readJson = (p) => JSON.parse(read(p).toString('utf8'));

let checks = 0, failed = 0;
function ok(cond, msg) { checks++; if (!cond) { failed++; console.error(`  ✗ ${msg}`); } return cond; }
function section(t) { console.log(`\n${t}`); }
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const rel = (a, b, r = 1e-5) => Math.abs(a - b) <= r * Math.max(1e-12, Math.abs(b));     // Float32 storage: ~1e-7 relative
const D = (s) => Date.parse(s);

section('1. pair rules (js/glacier-pairs.js)');
{
    const L = P.parsePairName('LC09_L1TP_067017_20260107_20260107_02_T1_X_LC08_L1TP_067017_20260320_20260329_02_T1_G0120V02_P061.nc');
    ok(L && L.d1 === D('2026-01-07') && L.d2 === D('2026-03-20') && L.dtDays === 72 && L.validPct === 61 && L.sensor === 'landsatOLI', 'Landsat name → dates from field 4 (not the processing date)');
    const S2 = P.parsePairName('velocity_image_pair/sentinel2/v02/N60W140/S2B_MSIL1C_20261027T211559_N0513_R143_T06VWN_20261027T230415_X_S2B_MSIL1C_20261106T211659_N0513_R143_T06VWN_20261106T212521_G0120V02_P081.nc');
    ok(S2 && S2.d1 === D('2026-10-27') && S2.d2 === D('2026-11-06') && S2.dtDays === 10 && S2.sensor === 'sentinel2', 'Sentinel-2 name (with key path) → first T-stamp of each id');
    const S1 = P.parsePairName('S1A_IW_SLC__1SDH_20190629T101736_20190629T101803_027893_03262D_88C7_X_S1B_IW_SLC__1SDH_20190705T101652_20190705T101719_016997_01FFAC_859F_G0120V02_P000.nc');
    ok(S1 && S1.dtDays === 6 && S1.sensor === 'sentinel1' && S1.validPct === 0, 'Sentinel-1 name');
    ok(P.parsePairName('not_a_granule.nc') === null && P.parsePairName('LC09_L1TP_067017_2026X107_X_y_G0120V02_P061.nc') === null, 'malformed names → null');
    ok(L && !P.isShortBaseline(L), '72-day pair is NOT short-baseline (DT_MAX 64)');
    ok(P.isShortBaseline({ dtDays: 64, validPct: 5 }) && P.isShortBaseline({ dtDays: 1, validPct: 1 }) && !P.isShortBaseline({ dtDays: 0, validPct: 50 }) && !P.isShortBaseline({ dtDays: 10, validPct: 0 }), 'baseline boundaries 1 / 64, P000 rejected');
    ok(JSON.stringify(P.monthStamps(D('2025-11-20'), D('2026-02-03'))) === JSON.stringify(['202511', '202512', '202601', '202602']), 'month stamps cross the year');
    const pre = P.scenePrefixes({ sensor: 'landsatOLI', folder: 'N60W140', key: 'L067017' }, D('2026-11-01'), D('2026-11-08'));
    ok(pre.length === 2 * 2 * 4 && pre.includes('velocity_image_pair/landsatOLI/v02/N60W140/LC09_L1TP_067017_202608'), 'Landsat prefixes reach back DT_MAX days (Aug for a Nov window)');
    const s2 = P.scenePrefixes({ sensor: 'sentinel2', folder: 'N60W140', key: 'T06VWN' }, D('2026-11-01'), D('2026-11-08'));
    ok(s2.every(p => /S2[ABC]_MSIL1C_2026(0[89]|1[01])$/.test(p)) && s2.length === 12, 'S2 prefixes per satellite × month');
    ok(P.keyMatchesScene('a/S2B_MSIL1C_20261027T211559_N0513_R143_T06VWN_x.nc', { sensor: 'sentinel2', key: 'T06VWN' }) && !P.keyMatchesScene('a/S2B_MSIL1C_x_T06VVN_x.nc', { sensor: 'sentinel2', key: 'T06VWN' }) && !P.keyMatchesScene('a/LC08_x.png', { sensor: 'landsatOLI' }), 'S2 keys filtered by MGRS tile; only .nc');
    const spatial = '-149.04\t60.26\n-150.15\t62.32\n-144.46\t62.9\n-143.75\t60.78\n';   // a real .nc.spatial
    ok(P.footprintContains(spatial, -147.08, 61.17) && !P.footprintContains(spatial, -140, 61), 'footprint test on a real .spatial sidecar');
    const g = { nx: 5, ny: 5, x0: 0, y0: 400, dx: 100, dy: -100, data: Int16Array.from({ length: 25 }, (_, k) => k) };
    const v = P.sampleGrid(g, [200, 0, 200], [200, 400, 200]);
    ok(v[0] === 12 && Number.isNaN(v[1]), '3×3 median at an interior pixel; edge pixel → NaN');
    g.data[6] = g.data[7] = g.data[8] = g.data[11] = P.FILL;
    ok(P.sampleGrid(g, [200], [200])[0] === 16, 'fill ignored: median of the 5 valid neighbours');
    g.data[12] = P.FILL;
    ok(Number.isNaN(P.sampleGrid(g, [200], [200])[0]), '< 5 valid of 9 → NaN');
    const rt = E.decodeI16(P.encodeI16([1.4, -2.6, NaN, 40000, -40000]));
    ok(rt[0] === 1 && rt[1] === -3 && Number.isNaN(rt[2]) && rt[3] === 32767 && rt[4] === -32767, 'int16 encode/decode round trip (NaN ↔ −32768, clamp ±32767)');
    ok(P.pairHasCoverage([1, 2, 3, NaN]) && !P.pairHasCoverage([1, 2, NaN, NaN]) && P.pairHasCoverage([...Array(5).fill(1), ...Array(45).fill(NaN)]) && !P.pairHasCoverage([...Array(4).fill(1), ...Array(56).fill(NaN)]), 'coverage rule max(3, 10 %)');
}

section('2. the join — live reader ≡ baker on a real 2026-11-06 pair');
{
    const fx = readJson('fixtures/glaciers/its-live-pair-crop.json');
    const buf = read('fixtures/glaciers/its-live-pair-crop.h5');
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const r = samplePairBuffer(ab, fx.x, fx.y);
    ok(!r.skip, `crop sampled (skip=${r.skip})`);
    let same = true, nBoth = 0, maxd = 0;
    for (let k = 0; k < fx.v.length; k++) {
        const a = r.v?.[k], b = fx.v[k];
        if (Number.isFinite(a) !== (b !== null)) same = false;
        if (Number.isFinite(a) && b !== null) { nBoth++; maxd = Math.max(maxd, Math.abs(a - b)); }
    }
    ok(same && nBoth >= 15 && maxd === 0, `values identical at ${nBoth} points, gaps identical (max |Δ| = ${maxd})`);
    const far = samplePairBuffer(ab, fx.x.map(x => x + 600e3), fx.y);
    ok(far.skip === 'outside', 'NEGATIVE CONTROL: a granule that does not contain the points (wrong projection) is skipped, not sampled');
}

section('3. engine (js/glacier-engine.js)');
{
    ok(near(E.dayOfYear(D('2026-01-01')), 1, 1e-9) && near(E.dayOfYear(D('2026-02-01T12:00Z')), 32.5, 1e-9), 'day of year');
    const n1 = E.hydroYear(D('2025-10-01'), 61), n2 = E.hydroYear(D('2025-09-30'), 61), s1 = E.hydroYear(D('2026-04-02'), -50);
    ok(n1.label === 2026 && n2.label === 2025 && s1.label === 2027 && n1.startMs === D('2025-10-01'), 'hydrological years: Oct 1 north, Apr 1 south, labelled by end year');
    // pair-averaged expectation vs trapezoid quadrature of the point sinusoid
    const v0 = 1000, A = 300, ph = 80, d1 = D('2026-02-10'), d2 = D('2026-03-30');
    let q = 0; const N = 4000;
    for (let i = 0; i <= N; i++) { const w = (i === 0 || i === N) ? 0.5 : 1; q += w * E.seasonalExpected(v0, A, ph, d1 + (d2 - d1) * i / N); }
    q /= N;
    ok(near(E.seasonalExpectedOver(v0, A, ph, d1, d2), q, 1e-3), 'pair-averaged sinusoid = quadrature of the point sinusoid');
    ok(near(E.seasonalExpected(v0, A, ph, D('2026-01-01') + (ph - 1) * E.DAY_MS), v0 + A, 1e-6), 'peak on the phase day');
    ok(E.seasonalExpected(v0, NaN, ph, d1) === v0 && Number.isNaN(E.seasonalExpected(NaN, A, ph, d1)), 'no amplitude → v0; no v0 → NaN');
    // a synthetic glacier: 5 points, flat climatology, pairs every 5 days
    const flat = (x) => Float32Array.from({ length: 5 }, () => x);
    const gl = { flowline: { n: 5 }, climatology: { v0: flat(100), amp: flat(0), phaseDoy: flat(NaN) } };
    const pairs = [];
    for (let k = 0; k < 24; k++) {
        const a = D('2026-06-01') + k * 5 * E.DAY_MS, b = a + 10 * E.DAY_MS;
        pairs.push(E.decodePair({ id: 'p' + k, sensor: 'sentinel2', d1: new Date(a).toISOString(), d2: new Date(b).toISOString(), v: P.encodeI16(flat(k === 7 ? 900 : 120)), e: P.encodeI16(flat(10)) }));
    }
    const rec = E.gaugeRecord(gl, pairs, 2);
    ok(rec.points.length === 24 && rec.points.filter(p => p.outlier).map(p => p.id).join() === 'p7', 'robust outlier flag catches the planted 900 m/yr pair only');
    const ds = E.dailySeries(rec, { fromMs: D('2026-05-01'), toMs: D('2026-09-30'), windowDays: 30 });
    const iJul = ds.t.indexOf(D('2026-07-01'));
    ok(near(ds.v[iJul], 120, 1e-9) && ds.n[iJul] > 0 && ds.v[0] === null && ds.n[0] === 0, 'daily series: weighted mean where pairs exist, null where none (May 1)');
    const now = D('2026-08-15');
    const st = E.currentState(rec, now);
    ok(st.state === 'faster' && near(st.pct, 20, 1e-6), `+20 % planted → "${st.label}"`);
    const pairs0 = pairs.map(p => ({ ...p, v: flat(p.id === 'p7' ? 900 : 100) }));
    ok(E.currentState(E.gaugeRecord(gl, pairs0, 2), now).state === 'normal', 'NEGATIVE CONTROL: no anomaly → "within normal range"');
    ok(E.currentState(E.gaugeRecord(gl, [], 2), now).state === 'unknown', 'no pairs → unknown, never "normal"');
    const merged = E.mergePairs(pairs.slice(0, 3), [pairs[2], { ...pairs[3], id: 'live1' }]);
    ok(merged.length === 4 && merged.filter(p => p.live).length === 1 && merged[3].id === 'live1', 'mergePairs: baked wins on shared ids, new live ids appended in time order');
    const tr = E.linearTrend([2000, 2001, 2002, 2003, 2004, 2005].map(y => ({ year: y, v: 50 + 3 * (y - 2000) })));
    ok(near(tr.slope, 3, 1e-12) && near(tr.r, 1, 1e-12) && E.linearTrend([{ year: 1, v: 1 }]) === null, 'OLS trend exact; < 5 years → null');
    // advection
    const n = 41, field = { nx: n, ny: n, x0: -2000, y0: 2000, dx: 100, dy: -100, vx: new Float32Array(n * n), vy: new Float32Array(n * n), ice: new Float32Array(n * n).fill(1) };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { field.vx[i * n + j] = 200; field.vy[i * n + j] = -50; }
    let p = [0, 0]; const smp = E.fieldSampler(field);
    for (let k = 0; k < 10; k++) p = E.advect(smp, p[0], p[1], 0.5);
    ok(near(p[0], 1000, 1e-6) && near(p[1], -250, 1e-6), 'uniform field: parcel moves exactly v·t');
    const rot = { ...field, vx: new Float32Array(n * n), vy: new Float32Array(n * n) };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const x = -2000 + j * 100, y = 2000 - i * 100; rot.vx[i * n + j] = -0.1 * y; rot.vy[i * n + j] = 0.1 * x; }
    let r = [1000, 0]; const sr = E.fieldSampler(rot);
    for (let k = 0; k < 200; k++) r = E.advect(sr, r[0], r[1], 0.05);
    ok(near(Math.hypot(r[0], r[1]), 1000, 1.0) && near(Math.atan2(r[1], r[0]), 1.0, 1e-3), `rigid rotation: radius kept to ${Math.abs(Math.hypot(r[0], r[1]) - 1000).toFixed(3)} m after 1 rad (RK2)`);
    const edge = { ...field, ice: field.ice.map((_, k) => (k % n) < 25 ? 1 : 0) };
    let e = [0, 0], steps = 0; const se = E.fieldSampler(edge);
    while (e && steps < 100) { e = E.advect(se, e[0], e[1], 0.5); steps++; }
    ok(e === null && steps < 20, `parcel stops at the ice edge (after ${steps} steps)`);
    // the ice body (SIA inversion): a uniform slab on a 5° slope moving at its own SIA speed
    {
        const n3 = 3, sa = Math.sin(5 * Math.PI / 180), rg = E.RHO_ICE * E.G, H0 = 300;
        const us = 2 * E.GLEN_A / (n3 + 1) * (rg * sa) ** n3 * H0 ** (n3 + 1) * E.SEC_PER_YR;
        const nx = 40, ny = 40, dxm = 200, z = new Float32Array(nx * ny), vx = new Float32Array(nx * ny).fill(us), vy = new Float32Array(nx * ny), ice = new Float32Array(nx * ny).fill(1);
        for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) z[i * nx + j] = 3000 - Math.tan(5 * Math.PI / 180) * j * dxm;
        const fld = { nx, ny, dx: dxm, dy: -dxm, vx, vy, ice, z };
        const m = E.iceModel(fld, { tauYieldKPa: 1e6 });
        const k = 20 * nx + 20;
        ok(rel(m.H[k], H0) && rel(m.tau[k], rg * H0 * sa / 1e3) && rel(m.bed[k], z[k] - H0), `SIA inversion recovers a 300 m slab exactly (H ${m.H[k].toFixed(6)} m, τ ${m.tau[k].toFixed(1)} kPa)`);
        ok(rel(m.q[k], 0.8 * us * H0), 'flux per unit width = (n+1)/(n+2) · u_s · H');
        let sumH = 0; for (const h of m.H) sumH += h;
        ok(rel(m.volumeKm3, sumH * dxm * dxm / 1e9) && rel(m.massGt, m.volumeKm3 * 0.917, 1e-12), 'volume = Σ H·cell area; mass = ρ_ice · V');
        const capped = E.iceModel(fld, { tauYieldKPa: 100 });
        ok(rel(capped.H[k], 100e3 / (rg * sa)) && capped.cappedFraction === 1, `plastic cap binds at τ_y = 100 kPa (H ${capped.H[k].toFixed(1)} m)`);
        const off = E.iceModel({ ...fld, ice: new Float32Array(nx * ny) });
        ok(off.volumeKm3 === 0 && off.bed[k] === z[k], 'no ice → no volume, bed = surface');
        const fast = E.iceModel({ ...fld, vx: vx.map(v => v * 16) }, { tauYieldKPa: 1e6 });
        ok(rel(fast.H[k], H0 * 2), '16× the speed → 2× the thickness (H ∝ u^{1/(n+1)})');
    }
    const cb = E.cumulativeBalance([{ year: 1, annual: -0.5 }, { year: 2, annual: null }, { year: 3, annual: 0.2 }]);
    ok(cb.length === 2 && cb[1].cumulative === 0.2 && cb[1].run === 1 && cb[1].since === 3, 'cumulative balance RESTARTS after a gap (a missing year is not zero balance)');
    const cr = E.cumulativeBalance([{ year: 3, annual: 0.1 }, { year: 1, annual: -0.5 }, { year: 2, annual: -0.2 }, { year: 5, annual: -1 }, { year: 6, annual: -1 }]);
    ok(near(cr[2].cumulative, -0.6, 1e-12) && E.latestRun(cr).length === 2 && E.latestRun(cr)[1].cumulative === -2 && E.latestRun(cr)[0].since === 5, 'runs are year-sorted and unbroken; latestRun quotes only the last one');
    // NEGATIVE CONTROL: the old gap-blind sum would have quoted −2.6 for that record
    ok(E.latestRun(cr).at(-1).cumulative !== cr.reduce((a, r) => a + r.annual, 0), 'never the sum across a gap');
}

section('4. the bake (data/glaciers)');
{
    const idx = readJson('../data/glaciers/glaciers.json');
    const G = E.decodeIndex(idx);
    const elev = readJson('../data/glaciers/elevation.json').glaciers;
    ok(G.length >= 25, `${G.length} glaciers (${G.map(g => g.id).join(', ')})`);
    // the index is what glacier-watch.html loads at boot (EarthView reads the ~20 KB summary instead); the
    // budget is PER GLACIER so the list can grow, and the annual series / pairs / field stay in <id>.json
    const idxBytes = fs.statSync(path.join(HERE, '../data/glaciers/glaciers.json')).size;
    ok(idxBytes / G.length < 5000, `index ${(idxBytes / 1024).toFixed(0)} KB = ${(idxBytes / G.length / 1024).toFixed(1)} KB per glacier (budget 4.9 KB each; details stay in <id>.json)`);
    for (const g of G) {
        const f = g.flowline, n = f.n;
        const det = E.decodeDetail(readJson(`../data/glaciers/${g.id}.json`));
        E.attachDetail(g, det);
        const lens = [f.lat, f.lon, f.x, f.y, f.s_m].every(a => a.length === n) && g.climatology.v0.length === n && g.annual.v.every(a => a.length === n);
        ok(lens && n >= 8, `${g.id}: ${n} flowline points, every array length n`);
        ok(f.lat.every(Number.isFinite) && f.lon.every(Number.isFinite) && Math.abs(f.lat[0] - g.lat) < 1 && Math.abs(f.lon[0] - g.lon) < 1.5, `${g.id}: flowline near the glacier`);
        // 0.4 km: Echaurren Norte (~0.2 km²) really is ~0.5 km long; a broken trace (Allalin on a tile edge) was 0.2
        ok(f.length_m > 400 && f.s_m[n - 1] === f.length_m, `${g.id}: flowline ${(f.length_m / 1000).toFixed(1)} km`);
        const v0 = Array.from(g.climatology.v0).filter(Number.isFinite);
        ok(v0.length >= 0.8 * n, `${g.id}: climatology finite at ${v0.length}/${n} points`);
        ok(g.annualSpan?.[0] === g.annual.years[0] && g.annualSpan[1] === g.annual.years.at(-1), `${g.id}: index span matches the detail series`);
        const yrs = g.annual.years, consecutive = yrs.every((y, k) => !k || y === yrs[k - 1] + 1);
        ok(consecutive && yrs[0] <= 2013 && yrs.at(-1) >= 2025 && g.annual.partialLast, `${g.id}: annual ${yrs[0]}–${yrs.at(-1)} consecutive (tile-dependent span — Antarctic composites are labelled to 2026), last year flagged partial`);
        ok(g.scenes.length > 0 && g.scenes.every(s => ['landsatOLI', 'sentinel2', 'sentinel1'].includes(s.sensor)), `${g.id}: ${g.scenes.length} scenes`);
        const z = elev[g.id]?.z_m || [];
        const zh = z.slice(0, 3).filter(v => v !== null), zt = z.slice(-3).filter(v => v !== null);
        ok(zh.length && zt.length && Math.min(...zh) > Math.max(...zt), `${g.id}: flowline runs DOWNHILL (${zh[0]?.toFixed(0)} m → ${zt.at(-1)?.toFixed(0)} m)`);
        const sorted = det.pairs.every((p, k, a) => !k || a[k - 1].d1 <= p.d1);
        const inWin = det.pairs.every(p => p.d2 >= Date.parse(g.pairs_cutoff) && p.d2 <= g.bakedMs && p.dtDays >= 1 && p.dtDays <= P.DT_MAX_DAYS);
        ok(sorted && inWin && det.pairs.length === g.pairs_count, `${g.id}: ${det.pairs.length} pairs (of ${g.pairs_listed} listed), all short-baseline inside the last year`);
        ok(det.field.vx.length === det.field.nx * det.field.ny && det.field.nx <= 160 && det.field.ny <= 160 && det.field.z?.length === det.field.vx.length, `${g.id}: field ${det.field.nx}×${det.field.ny} with a terrain grid`);
        ok(typeof f.traced === 'string' && f.traced.length === n && /^[vt]+$/.test(f.traced), `${g.id}: flowline method recorded (${(f.traced.match(/v/g) || []).length} velocity / ${(f.traced.match(/t/g) || []).length} topography points)`);
        const ice = E.iceModel(det.field, E.iceModelOptions(g.kind));
        const plausible = g.kind === 'land-terminating' ? ice.meanH > 10 && ice.meanH < 400 : ice.meanH > 30 && ice.meanH < 2500;
        ok(ice.volumeKm3 > 0 && plausible && ice.maxH < 4000, `${g.id}: ice body ${ice.volumeKm3.toFixed(2)} km³, mean ${ice.meanH.toFixed(0)} m, max ${ice.maxH.toFixed(0)} m (plastic cap on ${(100 * ice.cappedFraction).toFixed(0)} %)`);
    }
    const fastest = (id) => Math.max(...Array.from(G.find(g => g.id === id).climatology.v0).filter(Number.isFinite));
    ok(fastest('jakobshavn') > 5000 && fastest('columbia') > 5000, `outlets are fast: Jakobshavn ${fastest('jakobshavn').toFixed(0)}, Columbia ${fastest('columbia').toFixed(0)} m/yr`);
    for (const id of ['gulkana', 'south-cascade', 'storglaciaren', 'zongo', 'brewster', 'lemon-creek']) ok(fastest(id) < 400, `${id} is a slow mountain glacier (${fastest(id).toFixed(0)} m/yr)`);
    for (const id of ['helheim', 'pine-island', 'thwaites']) ok(fastest(id) > 1500, `${id} is a fast ice-sheet outlet (${fastest(id).toFixed(0)} m/yr)`);
    const jak = G.find(g => g.id === 'jakobshavn'), jakIce = E.iceModel(E.decodeDetail(readJson('../data/glaciers/jakobshavn.json')).field, E.iceModelOptions(jak.kind));
    const colIce = E.iceModel(E.decodeDetail(readJson('../data/glaciers/columbia.json')).field, E.iceModelOptions('tidewater'));
    ok(jakIce.maxH > 1200 && Math.abs(jakIce.maxH - colIce.maxH) > 100, `ice-sheet outlet is not pinned at the mountain cap (Jakobshavn max ${jakIce.maxH.toFixed(0)} m vs Columbia ${colIce.maxH.toFixed(0)} m)`);
}

section('5. WGMS mass balance');
{
    ok(parseCsv('a,b\n1,"x, y"\n').at(-1)[1] === 'x, y', 'CSV parser keeps quoted commas');
    const s = parseSeries('YEAR,WGMS_ID,POLITICAL_UNIT,NAME,AREA,WINTER_BALANCE,SUMMER_BALANCE,ANNUAL_BALANCE,REMARKS,RGI_ID\n2020,90,US,GULKANA,15.14,1490.0,-1770.0,-280.0,"a, b",RGI60-01.00570\n');
    ok(s.rows[0].annual === -0.28 && s.rows[0].winter === 1.49 && s.rgi === 'RGI60-01.00570', 'mm w.e. → m w.e., REMARKS with commas');
    const mb = readJson('../data/glaciers/massbalance.json').glaciers;
    ok(mb.storglaciaren.starts === 1946 && mb['south-cascade'].starts === 1953, 'record lengths (Storglaciären from 1946)');
    ok(['gulkana', 'aletsch', 'hintereisferner', 'nigardsbreen', 'peyto', 'rhone', 'pasterze'].every(id => mb[id].ends === 2025 && mb[id].release === 'WGMS FoG 2026-02-10'), 'the 2026 release carries the series through the 2025 hydrological year');
    ok(mb.zongo.ends === 2018 && /2022/.test(mb.zongo.release), 'a glacier the newer copy lacks keeps its 2022 series (and its printed gap)');
    const al = mb.aletsch.rows.filter(r => r.annual !== null).map(r => r.year);
    ok(al.includes(1999) && !al.includes(2000) && !al.includes(2019) && al.includes(2020), "Great Aletsch's 2000–2019 gap is WGMS's and is NOT filled");
    const gk = mb.gulkana.rows;
    ok(mb.gulkana.revised > 40 && gk.filter(r => r.revised).every(r => r.winter === null && r.summer === null && Number.isFinite(r.annual_prev)), 'USGS recalibration: revised years keep the earlier value and WITHHOLD the seasonal split (it would no longer add up)');
    const kept = Object.values(mb).filter(Boolean).flatMap(g => g.rows).filter(r => r.winter !== null && r.summer !== null && r.annual !== null);
    const off = kept.filter(r => Math.abs(r.winter + r.summer - r.annual) >= 0.06);
    // two years (Storglaciären 2003, Chhota Shigri 2018) are published that way by WGMS and are UNCHANGED between releases
    ok(kept.length > 250 && off.length <= 0.01 * kept.length && off.every(r => r.src === 'fog-2026' && !r.revised), `kept winter + summer sums to the annual in ${kept.length - off.length}/${kept.length} years; the rest are as published, not merge artefacts`);
    ok(mb.columbia === null && mb.khumbu === null && mb.jakobshavn === null && mb['perito-moreno'] === null, 'no invented series for calving / debris / ice-sheet glaciers');
    const ids = readJson('../data/glaciers/glaciers.json').glaciers.map(g => g.id);
    ok(ids.every(id => id in mb), `every glacier in the index has an EXPLICIT mass-balance entry — a series or a deliberate null (${ids.filter(id => !(id in mb)).join(', ') || 'none missing'})`);
    const all = Object.values(mb).filter(Boolean).flatMap(g => g.rows).filter(r => r.annual !== null);
    ok(all.every(r => r.annual > -6 && r.annual < 4), 'every annual balance in the physical range (−6 … +4 m w.e.)');
}

section('6. daily drivers (weather, gauges, snow)');
{
    const now = D('2026-11-08T12:00Z');
    ok(W.hydroStart(now, 61) === D('2026-10-01') && W.hydroStart(now, -50) === D('2026-04-01') && W.hydroStart(D('2026-09-30'), 61) === D('2025-10-01'), 'hydrological-year start N / S');
    const u = W.weatherUrls([{ lat: 63.27, lon: -145.42, elev: 1700 }, { lat: 63.26, lon: -145.43, elev: 1500.4 }], now);
    ok(u.archive.includes('elevation=1700,1500') && u.archive.includes('start_date=2016-10-01') && u.archive.includes('end_date=2026-11-02') && u.forecast.includes('forecast_days=16'), 'URLs: per-point elevation, ten comparison years, 6-day archive lag');
    const mk = (t0, n, f) => ({ daily: { time: Array.from({ length: n }, (_, i) => new Date(t0 + i * 864e5).toISOString().slice(0, 10)), temperature_2m_mean: Array.from({ length: n }, (_, i) => f(i)), temperature_2m_max: Array(n).fill(null), temperature_2m_min: Array(n).fill(null), precipitation_sum: Array(n).fill(1), snowfall_sum: Array(n).fill(0.5) } });
    const arch = mk(D('2016-10-01'), 3685, i => (i % 365 < 180 ? -5 : 4));      // archive to 2026-11-02, null-free
    const fc = mk(D('2026-11-01'), 23, () => 2);
    const merged = W.parseWeather(arch, fc, now)[0].days;
    const d1101 = merged.find(d => d.t === D('2026-11-01')), d1105 = merged.find(d => d.t === D('2026-11-05'));
    ok(d1101.src === 'archive' && d1105.src === 'forecast' && merged.find(d => d.t === D('2026-11-20')).forecast && !d1101.forecast, 'archive wins where both exist; days after now are forecast');
    const dd = W.degreeDays([{ t: 0, tmean: 3, snow: 1 }, { t: 1, tmean: -2, snow: 2 }, { t: 2, tmean: null, snow: null }, { t: 3, tmean: 1.5, snow: 0 }], 0, 3);
    ok(dd.pdd === 4.5 && dd.snow === 3 && dd.missing === 1 && dd.n === 3, 'positive degree-days skip and count missing days');
    const cmp = W.seasonCompare(merged, now, 61);
    ok(cmp.of === 11 && cmp.past.length === 10 && cmp.rankPdd >= 1 && cmp.rankPdd <= 11, `season compare: this year vs ten (rank ${cmp.rankPdd} of ${cmp.of})`);
    const one = W.parseWeather(mk(D('2026-10-01'), 3, () => 1), null, now);
    ok(one.length === 1 && one[0].days.length === 3, 'single-location response (an object, not an array) normalised');
    // USGS WaterML-JSON (shape per waterservices.usgs.gov docs)
    const usgs = { value: { timeSeries: [{ sourceInfo: { siteName: 'PHELAN C NR PAXSON AK' }, variable: { noDataValue: -999999 }, values: [{ value: [
        { value: '100', dateTime: '2026-07-01T00:00:00.000-08:00' }, { value: '-999999', dateTime: '2026-07-01T00:15:00.000-08:00' }, { value: 'Ice', dateTime: '2026-07-01T00:30:00.000-08:00' }] }] }] } };
    const pu = parseUsgs(usgs);
    ok(pu.site === 'PHELAN C NR PAXSON AK' && pu.points.length === 1 && near(pu.points[0].q_cms, 2.832, 1e-3), 'USGS: cfs → m³/s, nodata and qualifier strings dropped');
    ok(parseUsgs({}).points.length === 0, 'USGS: empty payload → no points, no throw');
    const list = [{ stationTriplet: '1094:AK:SNTL', name: 'Near', latitude: 63.3, longitude: -145.5, elevation: 4000 }, { stationTriplet: '9:AK:SNTL', name: 'Far', latitude: 60, longitude: -140 }, { stationTriplet: '5:AK:SCAN', name: 'Not SNOTEL', latitude: 63.27, longitude: -145.42 }];
    const ns = nearestSnotel(list, 63.27, -145.42);
    ok(ns.stations.length === 1 && ns.stations[0].name === 'Near' && ns.stations[0].km < 10 && ns.field_map.includes('stationTriplet'), 'SNOTEL: nearest within radius, SNTL network only');
    const aw = parseAwdbData([{ stationTriplet: '1094:AK:SNTL', data: [{ stationElement: { elementCode: 'WTEQ' }, values: [{ date: '2026-11-01', value: 2.5, median: 3.1 }, { date: '2026-11-02', value: null }] }] }]);
    ok(aw.byStation['1094:AK:SNTL'].WTEQ.length === 2 && aw.byStation['1094:AK:SNTL'].WTEQ[0].median === 3.1 && aw.byStation['1094:AK:SNTL'].WTEQ[1].v === null, 'AWDB: per-element series with median; nulls kept as null');
    ok(STATIONS.columbia.usgs.length === 0 && STATIONS.gulkana.usgs[0] === '15478040', 'no gauge invented for a tidewater glacier');
    // north arrow + detection
    const PX = [0, 1000, 2000, 0, 1500], PY = [0, 0, 1000, 1000, 400];
    const fl = { x: PX, y: PY, lat: PX.map((x, k) => 60 + 1e-7 * x + 9e-6 * PY[k]) };          // exact plane: north is atan(1e-7 / 9e-6) = 0.6366° east of grid +y
    const nth = E.northInGrid(fl);
    ok(near(Math.atan2(nth[0], nth[1]) * 180 / Math.PI, Math.atan(1e-7 / 9e-6) * 180 / Math.PI, 1e-6), `north from a lat plane: ${(Math.atan2(nth[0], nth[1]) * 180 / Math.PI).toFixed(2)}° east of grid north`);
    const gd = { climatology: { v0: Float32Array.from([1, 1, 1, 400, 400]), pairErr: Float32Array.from([30, 30, 30, 30, 30]) } };
    ok(!E.detectable(gd, 0, 0).ok && E.detectable(gd, 4, 0).ok, 'detectable: v0 must exceed 2× the pair error');
    const und = E.currentState({ points: [] }, now, { detect: { ok: false } });
    ok(und.state === 'undetectable', 'below detection → never "faster/slower/normal"');
}

section('7. chart kit helpers (js/glacier-charts.js)');
{
    ok(JSON.stringify(niceTicks(0, 100, 5)) === JSON.stringify([0, 20, 40, 60, 80, 100]) && JSON.stringify(niceTicks(-0.3, 0.4, 4)) === JSON.stringify([-0.2, 0, 0.2, 0.4]), 'nice ticks');
    const mt = timeTicks(D('2025-11-08'), D('2026-11-11'));
    ok(mt.length >= 6 && mt.every(t => new Date(t.t).getUTCDate() === 1) && mt.some(t => t.label === '2026'), 'month ticks on the 1st, January labelled with its year');
    const yt = timeTicks(D('1984-01-01'), D('2026-01-01'));
    ok(yt.every(t => /^\d{4}$/.test(t.label)) && yt.length <= 10, 'decade-span ticks are years, ≤ 10 of them');
    ok(JSON.stringify(extent([1, NaN, 3], { pad: 0 })) === JSON.stringify([1, 3]) && extent([5, 9], { zero: true })[0] === 0 && JSON.stringify(extent([])) === JSON.stringify([0, 1]), 'extent: NaN skipped, zero anchoring, empty fallback');
}

section('8. EarthView Glaciers layer (summary + pure helpers)');
{
    const idx = readJson('../data/glaciers/glaciers.json');
    const details = Object.fromEntries(idx.glaciers.map(g => [g.id, readJson(`../data/glaciers/${g.id}.json`)]));
    const fresh = buildSummary(idx, details, readJson('../data/glaciers/massbalance.json'));
    const onDisk = readJson('../data/glaciers/summary.json');
    ok(JSON.stringify(fresh) === JSON.stringify(onDisk), 'summary.json is exactly the engine on the committed archive (re-run scripts/build-glacier-summary.mjs after a bake)');
    const bakes = idx.glaciers.map(g => g.baked).sort();
    ok(onDisk.glaciers.length === idx.glaciers.length && onDisk.as_of === bakes.at(-1) && onDisk.as_of_oldest === bakes[0], `summary covers all ${onDisk.glaciers.length} glaciers, stamped as of ${onDisk.as_of} (oldest ${onDisk.as_of_oldest})`);
    ok(onDisk.glaciers.every(g => g.as_of === idx.glaciers.find(q => q.id === g.id).baked), "each glacier carries its OWN bake date (a failed refresh must not wear the new one)");
    const states = new Set(onDisk.glaciers.flatMap(g => g.gauges.map(q => q.state)));
    ok([...states].every(s => STATE_STYLE[s]) && ['faster', 'slower', 'normal', 'undetectable', 'unknown'].every(s => STATE_STYLE[s]), `every engine state has a marker style (${[...states].join(', ')})`);
    ok(STATE_STYLE.undetectable.fill === 0 && STATE_STYLE.unknown.fill === 0 && STATE_STYLE.faster.fill === 1, 'below detection / unknown are HOLLOW — never drawn as a state');
    ok(onDisk.glaciers.every(g => Math.abs(g.lat) <= 90 && Math.abs(g.lon) <= 180 && g.gauges.length === 3), 'markers sit on the flowline; three gauges each');
    ok(near(rayAngle({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0.01, y: 0, z: 1 }), Math.atan(0.01), 1e-12) && rayAngle({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 }) === Infinity, 'pixel-pick angle exact; behind-the-camera never picks');
    ok(flowRate(10000, 60) < flowRate(10000, 10) && flowRate(10, 10) < flowRate(1000, 10) && flowRate(1e6, 10) === flowRate(1e4, 10), 'flow rate: faster ice faster dots, longer lines slower per length, capped at 10 km/yr');
}

section('9. the weekly refresh gate (scripts/check-glacier-refresh.mjs)');
{
    const G = (id, baked, pairs, km) => ({ id, baked, pairs_count: pairs, flowline: { length_m: km * 1000 } });
    const prev = { glaciers: [G('a', '2026-11-01', 100, 10), G('b', '2026-11-01', 80, 5), G('c', '2026-11-01', 5, 2)] };
    const okRun = { glaciers: { a: { ok: true }, b: { ok: true }, c: { ok: true } }, failed: [] };
    const good = compareArchives(prev, { glaciers: [G('a', '2026-11-08', 104, 10.2), G('b', '2026-11-08', 77, 5), G('c', '2026-11-08', 1, 2)] }, okRun);
    ok(good.ok && good.refreshed === 3 && good.asOf === '2026-11-08', 'a healthy weekly refresh passes (a 5-pair glacier falling to 1 is below the collapse floor)');
    const r1 = compareArchives(prev, { glaciers: [G('a', '2026-11-08', 30, 10), G('b', '2026-11-08', 80, 5), G('c', '2026-11-08', 5, 2)] }, okRun);
    ok(!r1.ok && /a: kept pairs collapsed 100 → 30/.test(r1.problems.join()), 'REFUSED: pairs collapsed to < half');
    const r2 = compareArchives(prev, { glaciers: [G('a', '2026-11-08', 100, 14), G('b', '2026-11-08', 80, 5), G('c', '2026-11-08', 5, 2)] }, okRun);
    ok(!r2.ok && /a: flowline length moved/.test(r2.problems.join()), 'REFUSED: a flowline jump > 25 % (re-traced on new inputs)');
    const r3 = compareArchives(prev, { glaciers: [G('a', '2026-11-08', 100, 10), G('b', '2026-11-08', 80, 5)] }, { ...okRun, glaciers: { a: { ok: true }, b: { ok: true } } });
    ok(!r3.ok && /c: missing/.test(r3.problems.join()), 'REFUSED: a glacier vanished from the index');
    const r4 = compareArchives(prev, prev, { glaciers: { a: { ok: false, error: 'TimeoutError' }, b: { ok: false }, c: { ok: false } }, failed: ['a', 'b', 'c'] });
    ok(!r4.ok && /nothing was refreshed/.test(r4.problems.join()) && /3 glaciers failed/.test(r4.problems.join()), 'REFUSED: every bake failed (upstream down) — never a PR of stale entries');
    const w = compareArchives(prev, { glaciers: [G('a', '2026-11-01', 100, 10), G('b', '2026-11-08', 80, 5), G('c', '2026-11-08', 5, 2)] },
        { glaciers: { a: { ok: false, error: 'TimeoutError: listing' }, b: { ok: true }, c: { ok: true } }, failed: ['a'] });
    ok(w.ok && w.warnings.length === 1 && /kept the entry from 2026-11-01/.test(w.warnings[0]) && w.asOfOldest === '2026-11-01', 'one failure under the cap is allowed, LISTED with the date its entry is from');
    ok(/oldest entry 2026-11-01/.test(refreshMarkdown(w)) && /\| a \| failed \|/.test(refreshMarkdown(w)), 'the PR body names the failed glacier and the oldest date');
    const same = compareArchives(prev, prev, okRun);
    ok(same.ok && same.refreshed === 3, 'a same-day re-run counts as refreshed (the report decides, not the date)');
}

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) process.exit(1);
