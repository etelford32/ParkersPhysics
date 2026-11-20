/**
 * tests/bz-column.mjs — gate for the Bz engine's B4 (BZ_ENGINE_PLAN.md):
 * js/bz/sheath.js, geo-filter.js (with an OSSE), column.js,
 * js/bz-engine-provider.js and api/bz/column.js.
 *
 *   node tests/bz-column.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { perpShockRatio, upstreamMach, noseJump, SHEATH_DEFAULTS } from '../js/bz/sheath.js';
import { runFilter, scoreFilter, regressors, COEFF_NAMES, FILTER_DEFAULTS } from '../js/bz/geo-filter.js';
import { buildColumn, RUNG_ORDER } from '../js/bz/column.js';
import { createBzProvider, BZ_COLUMN_PATH } from '../js/bz-engine-provider.js';
import { analyzeFlux } from '../js/bz/flux-analysis.js';
import { analyzeGeo } from '../js/bz/geo-analysis.js';
import { newellNative } from '../js/bz/flux.js';
import { newellCoupling } from '../js/ring-current-model.js';
import { normalizeL1Mag, normalizeEphem, normalizeL1Plasma, normalizeGeoMag, FEEDS } from '../js/bz/feeds.js';
import { GOES_SLOTS, igrfEpn, meadEpn, arrivedValue } from '../js/bz/geo-residual.js';
import { boundaryModel, NOMINAL_WIND } from '../js/geomag/geospace.js';
import { rng, unitNormal, plantedField, plantedFeeds } from './helpers/bz-planted-wind.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (name) => { checks++; console.log(`  ✓ ${name}`); };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} ± ${tol}`);

// ── 1. the shock jump: exact, pinned by its two limits ────────────────────
{
    const g = 5 / 3;
    for (const M of [1.5, 3, 8, 30]) {
        close(perpShockRatio(M, 1e9), (g + 1) * M * M / ((g - 1) * M * M + 2), 1e-6, `gas-dynamic limit at M = ${M}`);
    }
    close(perpShockRatio(1e4, 1), 4, 1e-3, 'strong-shock limit is (γ+1)/(γ−1) = 4');
    // X = 1 exactly at a fast Mach number of 1: M_s² = 1 + 2/(γβ).
    for (const beta of [0.1, 1, 10]) {
        const Mc = Math.sqrt(1 + 2 / (g * beta));
        assert.equal(perpShockRatio(Mc * 0.999, beta), null, 'sub-fast flow is not a shock');
        const X = perpShockRatio(Mc * 1.001, beta);
        assert.ok(X > 1 && X < 1.01, `just super-fast at β = ${beta}: X = ${X}`);
    }
    assert.ok(perpShockRatio(8, 0.3) < perpShockRatio(8, 3), 'a magnetised upstream compresses less');
    assert.equal(perpShockRatio(NaN, 1), null);
    assert.equal(perpShockRatio(8, 0), null);

    const m = upstreamMach({ speedKms: 400, densityCc: 5, protonTempK: 6e4, btNt: 5 });
    close(m.alfvenKms, 21.812 * 5 / Math.sqrt(5), 1e-9);
    close(m.soundKms, Math.sqrt(g * 8254.4 * 2e5) / 1000, 1e-9);
    close(m.beta, 3.4699e-5 * 5 * 2e5 / 25, 1e-9);
    close(m.alfven ** 2, (g * m.beta / 2) * m.sonic ** 2, 1e-3 * m.alfven ** 2, 'M_A² = (γβ/2) M_s²: the three constants agree');
    close(m.fast, 1 / Math.hypot(1 / m.sonic, 1 / m.alfven), 1e-9);
    assert.equal(m.electronTempK, SHEATH_DEFAULTS.electronTempK, 'the assumed electron temperature travels with the result');
    assert.equal(upstreamMach({ speedKms: 400, densityCc: 5, protonTempK: 6e4, btNt: 0 }), null);

    const j = noseJump({ bxNt: -4, byNt: 2, bzNt: -3 }, { speedKms: 400, densityCc: 5, protonTempK: 6e4, btNt: Math.hypot(4, 2, 3) });
    assert.ok(j.ratio > 2.5 && j.ratio < 4);
    assert.equal(j.bxNt, -4, 'the normal component is unchanged');
    close(j.bzNt, -3 * j.ratio, 1e-12); close(j.byNt, 2 * j.ratio, 1e-12);
    close(Math.atan2(j.byNt, j.bzNt), Math.atan2(2, -3), 1e-12, 'the clock angle is preserved across the nose');
    assert.equal(j.is_lower_bound_at_magnetopause, true);
    assert.equal(noseJump({ bxNt: 0, byNt: 0, bzNt: -1 }, { speedKms: 30, densityCc: 5, protonTempK: 6e4, btNt: 5 }), null, 'sub-fast wind ⇒ no shock, no jump');
    const src = readFileSync(join(ROOT, 'js', 'bz', 'sheath.js'), 'utf8');
    assert.match(src, /NOT BUILT/, 'the header says the SWMF-fitted transfer is not built');
    ok(`Rankine–Hugoniot: gas-dynamic and strong-shock limits, X = 1 at fast Mach 1, tangential ×${j.ratio.toFixed(2)}, normal unchanged`);
}

// ── 2. one Newell implementation ──────────────────────────────────────────
{
    for (const [v, by, bz] of [[400, 0, -5], [650, 3, -8], [380, -2, 1]]) assert.equal(newellNative(v, by, bz), newellCoupling(v, by, bz));
    assert.equal(newellNative(400, NaN, -5), null, 'a missing By is a gap here');
    assert.ok(newellCoupling(400, NaN, -5) > 0, '…where the shared function reads it as 0');
    ok('flux.js delegates Newell to ring-current-model.js; only the gap rule differs');
}

// ── 3. the filter: an OSSE with planted coefficients ──────────────────────
function osse({ days = 3, gain = 12, scramble = false, noDriver = false, seed = 31 } = {}) {
    const R = rng(seed), n = days * 1440, t0 = Date.parse('2026-11-17T00:00:00Z');
    const truth = [-25, 8, -3, 2, 1, gain];
    const t = new Float64Array(n), y = new Float64Array(n), lt = new Float64Array(n), drv = new Float64Array(n);
    // Driver: √P excursions that step every few hours.
    let d = 0;
    const dser = new Float64Array(n);
    for (let i = 0; i < n; i++) { if (i % 170 === 0) d = 0.6 * R.g(); dser[i] = d; }
    let ar = 0;
    for (let i = 0; i < n; i++) {
        t[i] = t0 + i * 60e3; lt[i] = ((i / 60) % 24);
        ar = Math.exp(-1 / 20) * ar + Math.sqrt(1 - Math.exp(-2 / 20)) * R.g();      // 20-min correlated error, 1 nT
        const h = regressors(lt[i], dser[i]);
        y[i] = h.reduce((a, x, k) => a + x * truth[k], 0) + ar + 0.3 * R.g();
        drv[i] = dser[i];
    }
    if (scramble) drv.reverse();
    if (noDriver) drv.fill(NaN);
    for (let i = 1000; i < 1060; i++) y[i] = NaN;                                      // an arcjet block
    return { s: { t, y, localTimeH: lt, driver: drv }, truth };
}
{
    const { s, truth } = osse();
    const full = runFilter(s), ctrl = runFilter(s, { pinGain: true });
    for (let k = 0; k < 5; k++) close(full.x[k], truth[k], 1.5, `coefficient ${COEFF_NAMES[k]}`);
    close(full.x[5], truth[5], 1.5, 'the planted gain');
    assert.equal(ctrl.x[5], 0, 'the control\'s gain is pinned at exactly 0');
    assert.equal(ctrl.sigmaX[5], 0);
    const sc = scoreFilter(s, full, ctrl);
    assert.ok(sc.n > 3000);
    assert.ok(sc.skill_vs_harmonics_only > 0.9, `knowing the driver is worth ${sc.skill_vs_harmonics_only.toFixed(2)}`);
    assert.ok(sc.skill_vs_persistence > 0.5, `beats 30-min persistence by ${sc.skill_vs_persistence.toFixed(2)}`);
    // The planted error is 1.04 nT; the filter also chases some of the correlated part, which has
    // decorrelated by the time the 30-min-ahead prediction lands — so a little above it.
    assert.ok(sc.rmse > 1.0 && sc.rmse < 1.6, `rmse ${sc.rmse.toFixed(2)} nT against 1.04 nT of planted noise`);
    // CALIBRATION, PINNED: the errors are 20-min correlated and the filter assumes white noise.
    // The measured coverage of the stated 1σ is what it is; the gate fixes the band so that
    // "improving" it by widening the bars fails here.
    assert.ok(sc.coverage68 > 0.60 && sc.coverage68 < 0.80, `1σ coverage ${(sc.coverage68 * 100).toFixed(0)} %`);
    assert.ok(full.pred[20] !== full.pred[20], 'no prediction before a state leadMin old exists');
    assert.ok(full.pred[1030] === full.pred[1030], 'a prediction is still made THROUGH an excluded block');
    ok(`OSSE: coefficients recovered (gain ${full.x[5].toFixed(1)} vs 12), skill ${sc.skill_vs_harmonics_only.toFixed(2)} over harmonics-only, 1σ covers ${(sc.coverage68 * 100).toFixed(0)} %`);

    // Negative control 1: the driver at the wrong times earns nothing.
    const bad = osse({ scramble: true });
    const fb = runFilter(bad.s), cb = runFilter(bad.s, { pinGain: true });
    const sb = scoreFilter(bad.s, fb, cb);
    assert.ok(sb.skill_vs_harmonics_only < 0.05, `scrambled driver skill ${sb.skill_vs_harmonics_only.toFixed(3)}`);
    assert.ok(Math.abs(fb.x[5]) < 2.5, 'and no gain is learned from it');
    // Negative control 2: a truth with NO wind response gives a gain consistent with zero.
    const zero = osse({ gain: 0 });
    const fz = runFilter(zero.s);
    assert.ok(Math.abs(fz.x[5]) < 3 * fz.sigmaX[5] + 0.5, `gain ${fz.x[5].toFixed(2)} ± ${fz.sigmaX[5].toFixed(2)} when the truth has none`);
    // Missing driver: the gain is never touched, and its uncertainty never shrinks.
    const nd = osse({ noDriver: true });
    const fn = runFilter(nd.s);
    assert.equal(fn.x[5], 0);
    assert.ok(fn.sigmaX[5] >= FILTER_DEFAULTS.prior[5], 'no driver ⇒ the gain stays at its prior');
    assert.deepEqual(regressors(6, NaN), [1, 0, 1, -1, 0, 0].map((v, i) => (i === 1 || i === 4 ? regressors(6, NaN)[i] : v)));
    close(regressors(6, 0.5)[2], 1, 1e-12); assert.equal(regressors(6, 0.5)[5], 0.5);
    ok('negative controls: a scrambled driver earns no skill; no response ⇒ gain ≈ 0; a missing driver leaves the gain at its prior');

    // Causality: deleting the future changes nothing before it.
    const cut = { t: s.t.subarray(0, 2000), y: s.y.subarray(0, 2000), localTimeH: s.localTimeH.subarray(0, 2000), driver: s.driver.subarray(0, 2000) };
    const fc = runFilter(cut);
    for (let i = 0; i < 2000; i += 97) assert.equal(fc.pred[i] === fc.pred[i] ? fc.pred[i] : 'nan', full.pred[i] === full.pred[i] ? full.pred[i] : 'nan');
    ok('the filter is causal: predictions before a cut are bit-identical with the future deleted');
}

// ── 4. the column ─────────────────────────────────────────────────────────
const NOW = Date.parse('2026-11-20T14:20:00Z');
function plantAll() {
    const f = plantedFeeds({ field: plantedField(11, 1440), normal: unitNormal(20), speedKms: 420,
        densityCc: (i) => (i > 500 && i < 800 ? 14 : 5), nowMs: NOW });
    const mag = normalizeL1Mag(f.mag, { nowMs: NOW }), ephem = normalizeEphem(f.eph, { nowMs: NOW }), plasma = normalizeL1Plasma(f.wind, { nowMs: NOW });
    const flux = analyzeFlux({ mag, ephem, plasma, nowMs: NOW });
    const w = flux._series, R = rng(21), rows = [];
    const r0 = w.arrivalMs.map((_, i) => boundaryModel({ speedKms: w.speed[i], densityCc: w.density[i], bzNt: w.bz[i] }).r0Re);
    for (const [name, slot] of Object.entries(GOES_SLOTS)) {
        const cur = { i: 0 };
        for (let i = 0; i < 1438; i++) {
            const t = NOW - 120e3 - (1437 - i) * 60e3, date = new Date(t), ig = igrfEpn(slot.lonEastDeg, date);
            const r = arrivedValue(w.arrivalMs, r0, t, 5 * 60e3, 30 * 60e3, cur);
            const m = meadEpn(r === r ? r : boundaryModel(NOMINAL_WIND).r0Re, slot.lonEastDeg, date);
            rows.push({ time_tag: date.toISOString(), satellite: Number(name.slice(5)), He: ig.he + m.he + 0.3 * R.g(),
                Hp: ig.hp + m.hp - 24 + 0.3 * R.g(), Hn: ig.hn + m.hn + 0.3 * R.g(), total: 100, arcjet_flag: false });
        }
    }
    return { f, flux, rows, geoNorm: normalizeGeoMag(rows, { nowMs: NOW }) };
}
const P = plantAll();
{
    const geo = analyzeGeo({ geo: P.geoNorm, wind: P.flux._series, nowMs: NOW });
    const c = buildColumn({ flux: P.flux, geo, nowMs: NOW });
    assert.deepEqual(c.rungs.map((r) => r.id), RUNG_ORDER, 'every rung, top to bottom, including the ones not built');
    const by = Object.fromEntries(c.rungs.map((r) => [r.id, r]));
    for (const r of c.rungs) {
        assert.ok(['MEASURED', 'ESTIMATED', 'FORECAST', 'NOT_BUILT', 'NOT_AVAILABLE'].includes(r.kind), `${r.id}: has a kind`);
        assert.ok(typeof r.basis === 'string' && r.basis.length > 5, `${r.id}: says where its numbers come from`);
        assert.ok(Array.isArray(r.caveats), `${r.id}: carries its caveats`);
    }
    assert.equal(by.l1.kind, 'MEASURED');
    assert.equal(by.bow_shock.kind, 'ESTIMATED');
    assert.equal(by.bow_shock.forecast.kind, 'FORECAST');
    assert.ok(by.bow_shock.forecast.horizon_min > 30);
    assert.equal(by.sheath.kind, 'ESTIMATED');
    close(by.sheath.values.bz_nt, by.bow_shock.values.bz_nt * by.sheath.values.compression_ratio, 0.05, 'the sheath Bz is the shock Bz times the ratio');
    assert.ok(by.sheath.caveats[0].includes('LOWER bound'));
    assert.equal(by.magnetopause.kind, 'ESTIMATED');
    assert.ok(by.magnetopause.values.standoff_re > 7 && by.magnetopause.values.standoff_re < 13);
    assert.equal(by.geosynchronous.kind, 'MEASURED');
    assert.equal(by.geosynchronous.satellites.length, 2);
    for (const s of by.geosynchronous.satellites) {
        assert.equal(s.measured.kind, 'MEASURED');
        assert.equal(s.forecast.kind, 'FORECAST');
        assert.ok(s.forecast.sigma_nt > 0, 'a forecast never travels without its σ');
        assert.equal(s.forecast.lead_min, 30);
    }
    for (const id of ['ring_current', 'leo', 'e_region', 'ground', 'subsurface']) {
        assert.equal(by[id].kind, 'NOT_BUILT'); assert.equal(by[id].values, null); assert.match(by[id].basis, /planned for B5/);
    }
    assert.deepEqual(c.unverified.slice().sort(), ['mead_coefficients', 'siscoe_hill_coefficients']);
    assert.ok(by.magnetopause.caveats.some((x) => x.includes('UNVERIFIED')), 'the flag sits on the rung that uses the coefficients');
    assert.equal(c.summary.kinds.NOT_BUILT, 5);
    assert.equal(c.summary.bz_l1_nt, by.l1.values.bz_nt);
    // No rung smuggles a number in without a kind beside it.
    const walk = (o, path) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === 'forecast' && v) assert.equal(v.kind, 'FORECAST', `${path}.forecast is tagged`); walk(v, `${path}.${k}`); } };
    walk(c.rungs, 'rungs');
    ok('column: ten rungs in order, each with kind + basis + caveats; forecasts carry σ; unverified coefficients flagged where used');

    // Degraded inputs: the ladder keeps its shape and says what is missing.
    const noGeo = buildColumn({ flux: P.flux, geo: null, nowMs: NOW });
    assert.equal(noGeo.rungs.find((r) => r.id === 'geosynchronous').kind, 'NOT_AVAILABLE');
    assert.equal(noGeo.rungs.length, RUNG_ORDER.length);
    const nothing = buildColumn({ flux: null, geo: null, nowMs: NOW });
    assert.deepEqual(nothing.rungs.map((r) => r.id), RUNG_ORDER);
    assert.equal(nothing.rungs.filter((r) => r.kind === 'NOT_AVAILABLE').length, 5);
    assert.equal(nothing.summary.bz_l1_nt, null, 'no data ⇒ null, never 0');
    assert.deepEqual(nothing.unverified, []);
    ok('column degrades by rung: a dead feed is NOT_AVAILABLE with its reason, the ladder keeps all ten rungs');
}

// ── 5. the provider ───────────────────────────────────────────────────────
{
    const published = [];
    let mode = 'ok', calls = 0, t = 1000;
    const body = { freshness: 'fresh', data: { rungs: [{ id: 'l1' }], summary: {} } };
    const p = createBzProvider({ now: () => t, publish: (s) => published.push(s),
        fetchImpl: async (path) => { calls++; assert.equal(path, BZ_COLUMN_PATH);
            if (mode === 'ok') return { ok: true, json: async () => body };
            if (mode === 'shape') return { ok: true, json: async () => ({ hello: 1 }) };
            if (mode === '503') return { ok: false, status: 503 };
            throw new Error('offline'); } });
    const [a, b] = await Promise.all([p.refresh(), p.refresh()]);
    assert.equal(calls, 1, 'concurrent refreshes share one request');
    assert.equal(a, b);
    assert.equal(a.ok, true); assert.equal(a.stale, false); assert.equal(a.column.rungs.length, 1);
    t = 2000; mode = 'offline';
    const down = await p.refresh();
    assert.equal(down.ok, false);
    assert.equal(down.freshness, 'expired', 'a failed fetch is published as down');
    assert.equal(down.stale, true);
    assert.equal(down.column.rungs.length, 1, 'the last good column is kept, labelled stale');
    assert.equal(down.lastGoodAt, 1000);
    assert.equal(down.error, 'offline');
    mode = '503'; assert.equal((await p.refresh()).error, 'HTTP 503');
    mode = 'shape'; assert.equal((await p.refresh()).error, 'unexpected response shape');
    assert.equal(published.length, 4);
    assert.equal(p.state(), published[3]);
    const cold = createBzProvider({ publish: () => {}, fetchImpl: async () => { throw new Error('x'); } });
    const c = await cold.refresh();
    assert.equal(c.column, null); assert.equal(c.stale, false, 'never had data ⇒ nothing to call stale');
    ok('provider: one request per refresh wave; a failure is published as down with the last good column marked stale');
}

// ── 6. the route ──────────────────────────────────────────────────────────
{
    const src = readFileSync(join(ROOT, 'api', 'bz', 'column.js'), 'utf8');
    assert.match(src, /from '\.\.\/\.\.\/js\/bz\/column\.js'/);
    assert.ok(!/jsonError\('upstream_unavailable'/.test(src));
    assert.equal(FEEDS['geo-mag'].candidates[0].id, 'goes-primary-7d', 'the 7-day file is tried first');
    const real = globalThis.fetch, realNow = Date.now;
    try {
        Date.now = () => NOW;
        const { default: handler } = await import('../api/bz/column.js');
        const serve = (omit = []) => async (u) => {
            const s = String(u);
            if (s.includes('magnetometers-7-day')) return new Response('nope', { status: 404 });           // 7-day absent: the 1-day files carry on
            if (s.includes('goes/primary') && !omit.includes('geo')) return Response.json(P.rows.filter((r) => r.satellite === 19));
            if (s.includes('goes/secondary') && !omit.includes('geo')) return Response.json(P.rows.filter((r) => r.satellite === 18));
            if (s.includes('rtsw_mag_1m') && !omit.includes('l1')) return Response.json(P.f.mag);
            if (s.includes('rtsw_wind_1m') && !omit.includes('l1') && !omit.includes('wind')) return Response.json(P.f.wind);
            if (s.includes('ephemerides') && !omit.includes('l1')) return Response.json(P.f.eph);
            return new Response('no', { status: 404 });
        };
        globalThis.fetch = serve();
        const full = await (await handler(new Request('https://x.test/api/bz/column'))).json();
        assert.equal(full.freshness, 'fresh');
        assert.deepEqual(full.data.rungs.map((r) => r.id), RUNG_ORDER);
        assert.equal(full.feeds.geo_mag, 'goes-primary-1d+goes-secondary-1d', 'reports which GOES files answered');
        assert.ok(JSON.stringify(full).length < 12000, `the column is ${JSON.stringify(full).length} bytes`);
        assert.equal(full.data.rungs[0]._series, undefined);
        assert.ok(!JSON.stringify(full).includes('_series'), 'the internal hand-off never leaves the server');

        globalThis.fetch = serve(['wind']);
        const noWind = await (await handler(new Request('https://x.test/api/bz/column'))).json();
        assert.equal(noWind.freshness, 'stale');
        assert.deepEqual(noWind.reasons, ['no_plasma']);
        const nw = Object.fromEntries(noWind.data.rungs.map((r) => [r.id, r.kind]));
        assert.equal(nw.l1, 'MEASURED'); assert.equal(nw.bow_shock, 'NOT_AVAILABLE'); assert.equal(nw.geosynchronous, 'MEASURED');

        globalThis.fetch = serve(['geo']);
        const noGeo = await (await handler(new Request('https://x.test/api/bz/column'))).json();
        assert.equal(noGeo.freshness, 'stale');
        assert.deepEqual(noGeo.reasons, ['goes_mag_unavailable']);

        globalThis.fetch = serve(['geo', 'l1']);
        const dead = await handler(new Request('https://x.test/api/bz/column'));
        assert.equal(dead.status, 200);
        const db = await dead.json();
        assert.equal(db.freshness, 'expired');
        assert.equal(db.data.rungs.length, RUNG_ORDER.length, 'even with everything down the ladder is returned, every rung saying why');
    } finally { globalThis.fetch = real; Date.now = realNow; }
    ok('route: full ladder; plasma or GOES down ⇒ stale with the rung NOT_AVAILABLE; everything down ⇒ expired, ladder intact');
}

console.log(`\nbz-column: ${checks} checks passed`);
