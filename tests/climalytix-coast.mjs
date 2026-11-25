#!/usr/bin/env node
/**
 * climalytix-coast.mjs — node gate for js/climalytix/coast.js (shore geometry,
 * wave physics, breaking, tide) and js/climalytix/marine-request.js (the pure
 * half of /api/climalytix/marine), plus the route on a stubbed fetch.
 *
 * The physics is gated on IDENTITIES and limits, not on remembered numbers:
 *   · the dispersion relation ω² = g k tanh(k d), and its deep / shallow limits
 *   · energy flux conserved through shoaling (H² · c_g constant)
 *   · the deep-water flux formula against its own integral definition
 *   · tide extrema of a known sinusoid, in time and height
 *   · a shoreline at a known distance facing a known way, at several
 *     latitudes and orientations
 * The fitted coefficients (Komar–Gaughan, Battjes, Stockdon) are marked
 * unverified in the kernel; here they are checked for the properties any
 * correct version must have (monotonic, right limits, right dimensions).
 * NEGATIVE CONTROLS: no cos φ in the shore fit; the deep-water wavelength used
 * in shallow water; raw-sample tide extrema; a marine body with zeros for gaps.
 *
 *   node tests/climalytix-coast.mjs
 */

import assert from 'node:assert/strict';
import {
    G, RHO_SEA, BREAKER_INDEX, SLOPE_RANGE, COAST_KM, SOURCES, wrap360, angDiff,
    deepWavelength, wavelength, waveSpeeds, energyFlux, shoaling, breakerHeight, breakerDepth, iribarren, breakerType,
    runup2pct, seaState, incidence, windRelation, longshoreDrift, tideExtrema, tideNow, shoreFromGrid, coastWindow, surfReport,
} from '../js/climalytix/coast.js';
import {
    parseMarineQuery, marinePath, buildMarineUrl, normalizeMarine, degradedMarine, marineAt, MARINE_VARIABLES, MARINE_MAX_CELL_KM,
} from '../js/climalytix/marine-request.js';
import { sampleGrid } from '../js/climalytix/terrain.js';
import { marineUpstreamFixture, MOCK_TIDE, MOCK_SEA, MOCK_COAST, mockCoastDem } from './fixtures/climalytix-mocks.mjs';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const okAsync = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };
const near = (a, b, tol, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (±${tol})`);
const rel = (a, b, tol, msg = '') => assert.ok(Math.abs(a / b - 1) <= tol, `${msg} ${a} vs ${b} (rel ${tol})`);
const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 23, 15, 20);

console.log('climalytix coast — waves');

ok('wavelength satisfies the dispersion relation exactly, at every depth', () => {
    for (const T of [4, 8, 12, 18]) for (const d of [0.5, 3, 20, 200, 4000]) {
        const L = wavelength(T, d), k = 2 * Math.PI / L, w = 2 * Math.PI / T;
        rel(G * k * Math.tanh(k * d), w * w, 1e-10, `T=${T} d=${d}`);
    }
});

ok('…with the deep- and shallow-water limits, and never longer than deep water', () => {
    rel(wavelength(10, 5000), deepWavelength(10), 1e-9);
    rel(deepWavelength(10), 156.13, 1e-3, 'g T² / 2π at 10 s');
    rel(wavelength(12, 0.5), 12 * Math.sqrt(G * 0.5), 4e-3, 'shallow: L = T √(g d), to (kd)²/6');
    for (const d of [1, 5, 20, 80]) assert.ok(wavelength(10, d) < deepWavelength(10));
    // NEGATIVE CONTROL: using the deep-water wavelength in 3 m of water breaks the relation badly.
    const k0 = 2 * Math.PI / deepWavelength(10), w = 2 * Math.PI / 10;
    assert.ok(Math.abs(G * k0 * Math.tanh(k0 * 3) / (w * w) - 1) > 0.5);
    for (const bad of [[0, 5], [-1, 5], [10, 0], [NaN, 5], [10, null]]) assert.equal(wavelength(...bad), null);
});

ok('group speed: half the phase speed in deep water, equal to it in shallow water', () => {
    const deep = waveSpeeds(8, 3000), shallow = waveSpeeds(14, 0.4);
    rel(deep.n, 0.5, 1e-9);
    rel(deep.c, G * 8 / (2 * Math.PI), 1e-9);
    rel(shallow.n, 1, 5e-3);
    rel(shallow.c, Math.sqrt(G * 0.4), 2e-3);
});

ok('shoaling conserves energy flux (H² · c_g), dips below 1 and then grows shoreward', () => {
    const T = 10, cg0 = G * T / (4 * Math.PI);
    for (const d of [100, 30, 10, 4, 1.5]) rel(shoaling(T, d) ** 2 * waveSpeeds(T, d).cg, cg0, 1e-10);
    near(shoaling(T, 3000), 1, 1e-6);
    const ks = [40, 25, 15, 8, 4, 2].map((d) => shoaling(T, d));
    assert.ok(Math.min(...ks) < 1, 'the classic dip at intermediate depth');
    assert.ok(ks.at(-1) > 1.2 && ks.at(-1) > ks.at(-2), 'and growth near the beach');
});

ok('deep-water energy flux equals energy density × group speed', () => {
    const Hs = 2, Te = 9;
    const E = RHO_SEA * G * Hs * Hs / 16;                    // J/m², irregular sea
    rel(energyFlux(Hs, Te), E * G * Te / (4 * Math.PI), 1e-12);
    rel(energyFlux(2, 9) / 1000, 0.49 * 2 * 2 * 9, 0.01, 'the 0.49·Hs²·Te kW/m rule of thumb');
    rel(energyFlux(4, 9), 4 * energyFlux(2, 9), 1e-12, 'goes as H²');
    assert.equal(energyFlux(0, 9), null);
    assert.equal(SOURCES.energyFlux.verified, true);
});

ok('breaking: taller and longer waves break higher, in depth Hb / 0.78; coefficients are flagged unverified', () => {
    const Hb = breakerHeight(1.5, 10);
    assert.ok(Hb > 1.5 && Hb < 3, `a 1.5 m, 10 s swell breaks at ${Hb.toFixed(2)} m`);
    assert.ok(breakerHeight(2, 10) > Hb && breakerHeight(1.5, 14) > Hb);
    rel(breakerHeight(3, 10) / breakerHeight(1.5, 10), 2 ** 0.8, 1e-12, 'Hb ∝ H0^(4/5)');
    rel(breakerDepth(Hb), Hb / BREAKER_INDEX, 1e-12);
    // dimensionally a length: scale g, T, H consistently and Hb scales with H
    rel(0.39 * (4 * G) ** 0.2 * ((10 / 2) * 1.5 ** 2) ** 0.4, Hb, 1e-12);
    for (const k of ['breakerHeight', 'breakerClass', 'runup']) assert.equal(SOURCES[k].verified, false, `${k} is from memory and says so`);
});

ok('Iribarren number sorts breakers: gentle slope spills, steep slope surges', () => {
    rel(iribarren(0.05, 1.5, 10), 0.05 / Math.sqrt(1.5 / deepWavelength(10)), 1e-12);
    assert.equal(breakerType(iribarren(0.01, 2, 8)), 'spilling');
    assert.equal(breakerType(iribarren(0.08, 1, 12)), 'plunging');
    assert.equal(breakerType(iribarren(0.5, 0.3, 14)), 'surging');
    assert.equal(breakerType(0.5), 'plunging');
    assert.equal(breakerType(null), null);
    let last = 0;
    for (const s of [0.01, 0.03, 0.1, 0.3]) { const xi = iribarren(s, 1.5, 10); assert.ok(xi > last); last = xi; }
});

ok('run-up grows with wave and slope, is continuous in order of magnitude, and slope-free on a flat beach', () => {
    const r = runup2pct(2, 10, 0.08);
    assert.ok(r > 0.8 && r < 4, `2 m / 10 s on 1:12.5 runs up ${r.toFixed(2)} m`);
    assert.ok(runup2pct(3, 10, 0.08) > r && runup2pct(2, 14, 0.08) > r && runup2pct(2, 10, 0.12) > r);
    assert.equal(runup2pct(3, 8, 0.005), runup2pct(3, 8, 0.008), 'dissipative: the slope drops out');
    rel(runup2pct(3, 8, 0.005), 0.043 * Math.sqrt(3 * deepWavelength(8)), 1e-12);
    assert.equal(runup2pct(null, 10, 0.05), null);
});

ok('sea-state words follow the Douglas scale', () => {
    assert.deepEqual([0, 0.3, 1, 2, 3, 5, 8, 12, 20].map(seaState), ['calm', 'smooth', 'slight', 'moderate', 'rough', 'very rough', 'high', 'very high', 'phenomenal']);
    assert.equal(seaState(null), null);
});

console.log('the shore’s point of view');

ok('a wave FROM the way the coast faces is head-on; from behind it, it is in the lee', () => {
    assert.deepEqual(incidence(270, 270), { angle: 0, fromSea: true });
    assert.deepEqual(incidence(300, 270), { angle: 30, fromSea: true });
    assert.deepEqual(incidence(10, 350), { angle: 20, fromSea: true }, 'across north');
    assert.equal(incidence(90, 270).fromSea, false);
    assert.equal(incidence(null, 270), null);
    assert.equal(angDiff(350, 10), -20);
    assert.equal(wrap360(-90), 270);
});

ok('wind: from the sea is onshore, from the land offshore, along the beach cross-shore', () => {
    assert.equal(windRelation(270, 270), 'onshore');
    assert.equal(windRelation(300, 270), 'onshore');
    assert.equal(windRelation(90, 270), 'offshore');
    assert.equal(windRelation(120, 270), 'offshore');
    assert.equal(windRelation(0, 270), 'cross-shore');
    assert.equal(windRelation(180, 270), 'cross-shore');
    assert.equal(windRelation(null, 270), null);
});

ok('longshore drift runs down-wave along the shore, strongest at 45°, zero head-on and in the lee', () => {
    // Coast faces north; a wave from the NE travels SW, so the drift is to the WEST.
    assert.equal(longshoreDrift(45, 0).towardDeg, 270);
    assert.equal(longshoreDrift(315, 0).towardDeg, 90);
    near(longshoreDrift(45, 0).strength, 1, 1e-12);
    near(longshoreDrift(20, 0).strength, Math.sin(40 * Math.PI / 180), 1e-12);
    assert.equal(longshoreDrift(0, 0).strength, 0);
    assert.deepEqual(longshoreDrift(180, 0), { towardDeg: null, strength: 0 });
    // mirror symmetry for any facing
    for (const n of [0, 77, 190, 301]) assert.equal(wrap360(longshoreDrift(n + 30, n).towardDeg - longshoreDrift(n - 30, n).towardDeg), 180);
});

console.log('tide');

const tideSeries = (step = H) => {
    const times = Array.from({ length: Math.round(72 * H / step) }, (_, i) => NOW - 24 * H + i * step);
    return { times, levels: times.map((t) => MOCK_TIDE.ampM * Math.cos(2 * Math.PI * (t - MOCK_TIDE.tHighMs) / MOCK_TIDE.periodMs)) };
};

ok('highs and lows of a known tide are found to minutes and millimetres from HOURLY data', () => {
    const { times, levels } = tideSeries();
    const ex = tideExtrema(times, levels);
    assert.ok(ex.length >= 10);
    let worstT = 0, worstRaw = 0;
    for (const e of ex) {
        const n = (e.t - MOCK_TIDE.tHighMs) / (MOCK_TIDE.periodMs / 2);
        const exact = MOCK_TIDE.tHighMs + Math.round(n) * MOCK_TIDE.periodMs / 2;
        assert.equal(e.kind, Math.round(n) % 2 === 0 ? 'high' : 'low');
        worstT = Math.max(worstT, Math.abs(e.t - exact));
        near(Math.abs(e.level), MOCK_TIDE.ampM, 0.005, 'height');
        const raw = times.reduce((b, t) => (Math.abs(t - exact) < Math.abs(b - exact) ? t : b), times[0]);
        worstRaw = Math.max(worstRaw, Math.abs(raw - exact));
    }
    assert.ok(worstT < 4 * 60_000, `refined to ${(worstT / 60000).toFixed(1)} min`);
    // NEGATIVE CONTROL: the raw hourly sample is up to half an hour off.
    assert.ok(worstRaw > 15 * 60_000, `raw samples are ${(worstRaw / 60000).toFixed(0)} min off`);
    for (let i = 1; i < ex.length; i++) assert.notEqual(ex[i].kind, ex[i - 1].kind, 'highs and lows alternate');
});

ok('tideNow: level, direction, the next high and low, and the range', () => {
    const { times, levels } = tideSeries();
    const t = tideNow(times, levels, NOW);
    const exact = MOCK_TIDE.ampM * Math.cos(2 * Math.PI * (NOW - MOCK_TIDE.tHighMs) / MOCK_TIDE.periodMs);
    near(t.level, exact, 0.03);
    const slope = -Math.sin(2 * Math.PI * (NOW - MOCK_TIDE.tHighMs) / MOCK_TIDE.periodMs);
    assert.equal(t.trend, slope > 0 ? 'rising' : 'falling');
    assert.ok(t.nextHigh.t > NOW && t.nextLow.t > NOW);
    near(Math.abs(t.nextHigh.t - t.nextLow.t), MOCK_TIDE.periodMs / 2, 6 * 60_000);
    near(t.range, 2 * MOCK_TIDE.ampM, 0.01);
    assert.equal(tideNow(times, levels, times[0] - 1), null, 'outside the series: nothing held');
});

ok('gaps break the search — no extremum is invented across a hole', () => {
    const { times, levels } = tideSeries();
    const holed = levels.map((v, i) => (i % 6 === 3 ? null : v));
    for (const e of tideExtrema(times, holed)) {
        const i = times.findIndex((t) => Math.abs(t - e.t) <= H / 2);
        assert.ok(holed[i - 1] != null && holed[i] != null && holed[i + 1] != null);
    }
    assert.deepEqual(tideExtrema(times, times.map(() => null)), []);
    assert.equal(tideNow(times, times.map(() => null), NOW), null);
    assert.deepEqual(tideExtrema(null, null), []);
});

console.log('where the shore is');

/** A straight coast through `c`, facing `face` (sea on that side), as an elevation function. */
const straight = (c, face) => (lat, lon) => {
    const x = (lon - c.lon) * 111.195 * Math.cos(c.lat * Math.PI / 180), y = (lat - c.lat) * 111.195;
    const seaward = x * Math.sin(face * Math.PI / 180) + y * Math.cos(face * Math.PI / 180);
    return -seaward * 40;                                   // 40 m per km, negative out to sea
};
const gridFor = (site, h, n = 97) => sampleGrid(coastWindow(site), n, n, h);

ok('a straight coast at a known distance, facing a known way — at four latitudes and eight facings', () => {
    for (const lat of [0, 36.95, 60, -45]) for (const face of [0, 45, 90, 135, 180, 225, 270, 315]) {
        const site = { lat, lon: 10 };
        // shoreline 6 km from the site, on the `face` side
        const c = { lat: lat + 6 * Math.cos(face * Math.PI / 180) / 111.195, lon: 10 + 6 * Math.sin(face * Math.PI / 180) / (111.195 * Math.cos(lat * Math.PI / 180)) };
        const s = shoreFromGrid(gridFor(site, straight(c, face)), site);
        assert.equal(s.state, 'coastal', `lat ${lat} face ${face}`);
        assert.equal(s.onWater, false);
        near(s.distanceKm, 6, s.resKm, `distance lat ${lat} face ${face}`);
        assert.ok(Math.abs(angDiff(s.normalDeg, face)) < 4, `facing lat ${lat}: ${s.normalDeg.toFixed(1)} vs ${face}`);
        assert.ok(Math.abs(angDiff(s.bearingDeg, face)) < 12, `bearing to the shore`);
        assert.ok(s.resKm > 0.5 && s.resKm < 1.5);
    }
});

ok('NEGATIVE CONTROL: without cos φ a diagonal coast at 60° N is skewed by tens of degrees', () => {
    const site = { lat: 60, lon: 10 }, face = 45;
    const c = { lat: 60 + 6 * Math.cos(Math.PI / 4) / 111.195, lon: 10 + 6 * Math.sin(Math.PI / 4) / (111.195 * 0.5) };
    const g = gridFor(site, straight(c, face));
    assert.ok(Math.abs(angDiff(shoreFromGrid(g, site).normalDeg, face)) < 4);
    assert.ok(Math.abs(angDiff(shoreFromGrid(g, site, { cosLat: false }).normalDeg, face)) > 12);
});

ok('inland, at sea, and unknown are different answers', () => {
    const site = { lat: 40, lon: -105 };
    const inland = shoreFromGrid(gridFor(site, () => 1600), site);
    assert.equal(inland.state, 'inland');
    assert.equal(inland.distanceKm, null, 'no sea in the window ⇒ no distance, not a guess');
    // far shore: 31 km away is past COAST_KM
    const far = shoreFromGrid(gridFor(site, straight({ lat: 40, lon: -105 - 31 / (111.195 * Math.cos(40 * Math.PI / 180)) }, 270)), site);
    assert.equal(far.state, 'inland');
    near(far.distanceKm, 31, 1);
    assert.ok(COAST_KM < 31);
    // a site on the water
    const sea = shoreFromGrid(gridFor(site, straight({ lat: 40, lon: -105 + 3 / (111.195 * Math.cos(40 * Math.PI / 180)) }, 270)), site);
    assert.equal(sea.onWater, true);
    assert.equal(sea.state, 'coastal');
    near(sea.distanceKm, 3, sea.resKm);
    assert.ok(Math.abs(angDiff(sea.normalDeg, 270)) < 4, 'the coast still faces the sea');
    // mostly holes
    const holes = gridFor(site, (lat) => (lat > 40 ? null : 5));
    assert.equal(shoreFromGrid(holes, site).state === 'unknown' || shoreFromGrid(holes, site).state === 'inland', true);
    assert.equal(shoreFromGrid(gridFor(site, () => null), site).state, 'unknown');
    assert.equal(shoreFromGrid(null, site).state, 'unknown');
    assert.equal(shoreFromGrid(gridFor(site, () => 5), { lat: 'x', lon: 1 }).state, 'unknown');
});

ok('the browser gate’s mock coast reads as designed: facing west, ~4.4 km away', () => {
    const s = shoreFromGrid(gridFor(MOCK_COAST.site, mockCoastDem), MOCK_COAST.site);
    assert.equal(s.state, 'coastal');
    near(s.distanceKm, 0.05 * 111.195 * Math.cos(36.95 * Math.PI / 180), s.resKm);
    assert.ok(Math.abs(angDiff(s.normalDeg, 270)) < 3);
});

ok('the assembled report keeps unknowns unknown', () => {
    const r = surfReport(MOCK_SEA, { normalDeg: 270 }, { fromDeg: 90, speedMs: 4 });
    assert.equal(r.seaState, 'moderate');
    assert.equal(r.reachesShore, true);
    assert.equal(r.wave.angle, 0);
    assert.equal(r.drift.strength, 0);
    assert.equal(r.wind, 'offshore');
    assert.equal(r.perSlope.length, SLOPE_RANGE.length);
    assert.ok(r.runupM[0] < r.runupM[1]);
    rel(r.fluxKwM * 1000, energyFlux(1.5, 10), 1e-12);
    const noShore = surfReport(MOCK_SEA, { normalDeg: null }, { fromDeg: 90 });
    assert.equal(noShore.wave, null);
    assert.equal(noShore.wind, null);
    assert.equal(noShore.drift, null);
    assert.ok(noShore.breakerM > 0, 'breaking needs no shore direction');
    const noSea = surfReport({}, { normalDeg: 270 }, {});
    for (const k of ['seaState', 'wavelengthM', 'fluxKwM', 'breakerM', 'breakerDepthM', 'runupM', 'wave', 'wind']) assert.equal(noSea[k], null, k);
    assert.equal(surfReport({ ...MOCK_SEA, waveDirDeg: 90 }, { normalDeg: 270 }).reachesShore, false);
});

console.log('marine request + route');

ok('a site is validated and snapped; a missing coordinate is an error, never the equator', () => {
    assert.deepEqual(parseMarineQuery({ lat: '36.9512', lon: '-122.0261' }), { lat: 36.95, lon: -122.05 });
    for (const bad of [{}, { lat: '', lon: '1' }, { lat: null, lon: null }, { lat: '91', lon: '0' }, { lat: '0', lon: '181' }, { lat: 'x', lon: '1' }]) {
        assert.ok(parseMarineQuery(bad).error, JSON.stringify(bad));
    }
    assert.equal(marinePath({ lat: 36.9512, lon: -122.0261 }), '/api/climalytix/marine?lat=36.95&lon=-122.05');
});

ok('the upstream URL asks for sea cells, UTC unix times, metric — and the retry asks for less', () => {
    const u = new URL(buildMarineUrl({ lat: 36.95, lon: -122.05 }));
    assert.equal(u.hostname, 'marine-api.open-meteo.com');
    assert.equal(u.searchParams.get('cell_selection'), 'sea');
    assert.equal(u.searchParams.get('timeformat'), 'unixtime');
    assert.equal(u.searchParams.get('timezone'), 'UTC');
    const all = u.searchParams.get('hourly').split(',');
    assert.equal(all.length, Object.values(MARINE_VARIABLES).flatMap((v) => v.names).length);
    const core = new URL(buildMarineUrl({ lat: 36.95, lon: -122.05 }, { coreOnly: true })).searchParams.get('hourly').split(',');
    assert.deepEqual(core, ['wave_height', 'wave_direction', 'wave_period']);
});

ok('normalising keeps gaps as null (zeros are the negative control) and self-reports what was missing', () => {
    const q = { lat: 36.95, lon: -122.05 };
    const up = marineUpstreamFixture(NOW, q, { drop: ['sea_level_height_msl'] });
    up.hourly.wave_height[5] = null;
    up.hourly.sea_surface_temperature = up.hourly.sea_surface_temperature.map(() => null);
    const b = normalizeMarine(up, q, NOW);
    assert.equal(b.role, 'bootstrap');
    assert.equal(b.freshness, 'live');
    assert.equal(b.series.waveM[5], null);
    assert.notEqual(b.series.waveM[5], 0);
    assert.ok(b.series.seaLevelM.every((v) => v === null), 'a variable the upstream did not send is a null series');
    assert.deepEqual(b.missing.sort(), ['seaLevelM', 'sstC']);
    assert.equal(b.field_map.waveM, 'wave_height');
    assert.equal(b.field_map.seaLevelM, undefined);
    assert.equal(b.times.length, 145);
    assert.equal(b.times[1] - b.times[0], H);
    assert.ok(b.site.cell_distance_km > 5 && b.site.cell_distance_km < 9);
    assert.match(b.note, /not a tide gauge/);
});

ok('no sea here, or a sea cell too far away, is said — never presented as this coast', () => {
    const q = { lat: 40, lon: -105 };
    assert.equal(normalizeMarine({ hourly: { time: [] } }, q, NOW), null);
    assert.equal(normalizeMarine({}, q, NOW), null);
    const dry = marineUpstreamFixture(NOW, q);
    dry.hourly.wave_height = dry.hourly.wave_height.map(() => null);
    assert.equal(normalizeMarine(dry, q, NOW), null, 'not one wave height ⇒ no marine data');
    const far = marineUpstreamFixture(NOW, q);
    far.longitude = q.lon - 2;                               // ~170 km away
    const b = normalizeMarine(far, q, NOW);
    assert.equal(b.freshness, 'stale');
    assert.deepEqual(b.reasons, ['sea_cell_far']);
    assert.ok(b.site.cell_distance_km > MARINE_MAX_CELL_KM);
    const d = degradedMarine(q, 'no_marine_data_here', NOW);
    assert.equal(d.freshness, 'expired');
    assert.equal(d.series, null);
    assert.deepEqual(d.reasons, ['no_marine_data_here']);
});

ok('a value “now” is interpolated by instant; directions go the short way round; gaps stay gaps', () => {
    const body = { times: [0, H, 2 * H], series: { waveM: [1, 2, null], waveDirDeg: [350, 10, 30] } };
    near(marineAt(body, 'waveM', H / 2), 1.5, 1e-12);
    near(marineAt(body, 'waveDirDeg', H / 2), 0, 1e-9, '350 → 10 passes through north, not south');
    assert.equal(marineAt(body, 'waveM', 1.5 * H), null);
    assert.equal(marineAt(body, 'waveM', H), 2, 'exactly on a sample beside a gap');
    assert.equal(marineAt(body, 'waveM', -1), null);
    assert.equal(marineAt(body, 'waveM', 3 * H), null);
    assert.equal(marineAt(null, 'waveM', 0), null);
});

await okAsync('the route: 400 on bad input, 200 + expired on every degraded upstream, a core-only retry on a refusal', async () => {
    const { default: handler } = await import('../api/climalytix/marine.js');
    const realFetch = globalThis.fetch;
    const call = async (qs, impl) => {
        const seen = [];
        globalThis.fetch = async (u) => { seen.push(String(u)); return impl(String(u), seen.length); };
        try {
            const res = await handler(new Request(`https://x.test/api/climalytix/marine${qs}`));
            return { status: res.status, body: await res.json(), seen };
        } finally { globalThis.fetch = realFetch; }
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
    assert.equal((await call('', () => json({}))).status, 400);
    assert.equal((await call('?lat=95&lon=0', () => json({}))).status, 400);

    const good = await call('?lat=36.95&lon=-122.05', (u) => json(marineUpstreamFixture(Date.now(), { lat: 36.95, lon: -122.05 })));
    assert.equal(good.status, 200);
    assert.equal(good.body.freshness, 'live');
    assert.equal(good.seen.length, 1);
    assert.ok(good.seen[0].startsWith('https://marine-api.open-meteo.com/v1/marine?'), 'the URL is rebuilt from the site — no passthrough');
    assert.ok(good.body.series.waveM.every((v) => v === 1.5));

    for (const [name, impl, reason] of [
        ['5xx', () => json({}, 503), 'upstream HTTP 503'],
        ['throw', () => { throw new Error('socket'); }, 'upstream unreachable'],
        ['empty', () => json({ hourly: { time: [] } }), 'no_marine_data_here'],
        ['html', () => new Response('<html>', { status: 200 }), 'upstream unreachable'],
    ]) {
        const r = await call('?lat=36.95&lon=-122.05', impl);
        assert.equal(r.status, 200, `${name}: never a 5xx`);
        assert.equal(r.body.freshness, 'expired', name);
        assert.deepEqual(r.body.reasons, [reason], name);
        assert.equal(r.body.series, null);
    }
    // An unknown variable name refuses the whole request: the retry asks for the core three and says so.
    const retry = await call('?lat=36.95&lon=-122.05', (u, n) => (n === 1 ? json({ error: true, reason: 'unknown variable' }, 400)
        : json(marineUpstreamFixture(Date.now(), { lat: 36.95, lon: -122.05 }, { drop: ['swell_wave_height', 'swell_wave_period', 'swell_wave_direction', 'wind_wave_height', 'sea_surface_temperature', 'sea_level_height_msl'] }))));
    assert.equal(retry.seen.length, 2);
    assert.ok(!retry.seen[1].includes('sea_level_height_msl'));
    assert.equal(retry.body.core_only, true);
    assert.equal(retry.body.freshness, 'live');
    assert.ok(retry.body.missing.includes('seaLevelM'));
    // Refused twice ⇒ there is no marine data for this place.
    const twice = await call('?lat=40&lon=-105', () => json({ error: true }, 400));
    assert.deepEqual(twice.body.reasons, ['no_marine_data_here']);
});

console.log(`\n${passed} passed`);
