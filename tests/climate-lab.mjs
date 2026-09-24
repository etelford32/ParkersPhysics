#!/usr/bin/env node
/**
 * climate-lab.mjs — node gate for the dashboard's Climate Lab (js/climate-lab/).
 *
 * Covers every PURE layer: the physics kernel against published reference
 * values, display units (and their exact inverses), the prefs store's
 * normaliser, the `lab` feed normaliser (gaps stay null, station-local days),
 * instrument readings and lab watches against the synthetic station in
 * tests/fixtures/climate-lab-fixtures.mjs (whose values are closed-form, so
 * each expectation below is derived, not recorded), the SVG builders, the
 * climate context over a synthetic ERA5 archive, satellite geometry, the
 * Home Base resolution rules, the account write whitelist, and the new
 * `type=lab` parameter set on the weather proxy.
 *
 *   node tests/climate-lab.mjs
 */

import assert from 'node:assert/strict';
import * as P from '../js/climate-lab/lab-physics.js';
import { resolveUnits, fmt, fmtText, fromDisplay, localePreset, QUANTITIES } from '../js/climate-lab/lab-units.js';
import {
    normalizePrefs, visibleInstruments, moveInstrument, INSTRUMENTS, DEFAULT_PREFS, MAX_SATELLITES, MAX_WATCHES,
} from '../js/climate-lab/lab-prefs.js';
import { normalizeLabResponse, hourIndexAt, dayRowAt, hourlyWindow, stationDateKey } from '../js/climate-lab/lab-feed.js';
import { buildReadings } from '../js/climate-lab/lab-readings.js';
import { evaluateWatch, evaluateWatches, newlyTriggered } from '../js/climate-lab/lab-watches.js';
import { sparkSvg, meteogramSvg, skyDomeSvg, stripSvg, compassSvg, layersSvg, meterSvg, niceStep, nextNice } from '../js/climate-lab/lab-charts.js';
import { climateContext, seasonalSamples, positionWords, ordinal } from '../js/climate-lab/lab-climate.js';
import { footprintRadiusDeg, destination, arcDeg, shortSatName, orbitalSpeedKms } from '../js/climate-lab/lab-sat-geo.js';
import { resolveHome, sameLocation, cleanLoc } from '../js/climate-lab/lab-home.js';
import { whitelistPatch, WRITABLE_COLUMNS } from '../js/climate-lab/lab-account.js';
import { normalizeAirQuality } from '../js/air-quality-feed.js';
import { computeAdvisories } from '../js/composite-indices.js';
import { normalizeClimate } from '../js/home-conditions.js';
import { labFixture, airFixture, archiveFixture, STATION } from './fixtures/climate-lab-fixtures.mjs';

let n = 0;
const test = (name, fn) => { fn(); n++; console.log(`  ✓ ${name}`); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b} ± ${tol}, got ${a}`);

const HOUR = 3_600_000;
// 2026-09-24 20:20 UTC = 14:20 MDT. Not on a half hour, so "nearest sample"
// lookups are unambiguous.
const NOW = Date.UTC(2026, 8, 24, 20, 20);
const obs = normalizeLabResponse(labFixture(NOW));
const air = normalizeAirQuality(airFixture(NOW), NOW);

// ── Physics kernel ─────────────────────────────────────────────────────────
test('wet-bulb reproduces Stull 2011’s worked example (20 °C, 50 % → 13.7 °C)', () => {
    const r = P.wetBulbStullC(20, 50);
    near(r.valueC, 13.7, 0.05); assert.equal(r.valid, true);
    assert.equal(P.wetBulbStullC(20, 2).valid, false, 'RH below the fit range is flagged');
    assert.ok(P.wetBulbStullC(30, 100).valueC <= 30, 'wet bulb never exceeds dry bulb');
});
test('moist-air density: ISA sea level is 1.225 kg/m³ and density altitude 0', () => {
    near(P.airDensityKgM3(15, 0, 1013.25), 1.225, 0.001);
    near(P.densityAltitudeM(1.225), 0, 1e-6);
    assert.ok(P.airDensityKgM3(30, 80, 1013.25) < P.airDensityKgM3(30, 0, 1013.25), 'humid air is LESS dense');
    const rho = P.airDensityKgM3(30, 20, 840);
    near(P.densityAltitudeM(rho), 2450, 60, 'hot high-plains day');
});
test('station pressure from MSL follows the ISA barometric relation', () => {
    near(P.stationPressureFromMslHpa(1013.25, 0), 1013.25, 1e-9);
    near(P.stationPressureFromMslHpa(1013.25, 1624), 832.8, 0.5);
});
test('humidity measures are mutually consistent', () => {
    near(P.vaporPressureHpa(20, 100), P.satVaporHpa(20), 1e-9);
    near(P.dewPointC(20, 100), 20, 1e-6);
    near(P.mixingRatioGkg(25, 50, 1013.25), 9.85, 0.05);
    near(P.absoluteHumidityGm3(25, 50), 11.5, 0.1);
    assert.ok(Number.isNaN(P.mixingRatioGkg(25, 50, 10)), 'p ≤ e is undefined, not negative');
});
test('Met Office barometric tendency bands, including the boundaries', () => {
    assert.equal(P.pressureTendency(0.05).label, 'Steady');
    assert.equal(P.pressureTendency(1.5).label, 'Rising slowly');
    assert.equal(P.pressureTendency(-1.6).label, 'Falling');
    assert.equal(P.pressureTendency(-3.5).label, 'Falling');
    assert.equal(P.pressureTendency(-3.6).label, 'Falling quickly');
    assert.equal(P.pressureTendency(6.1).label, 'Rising very rapidly');
    assert.equal(P.pressureTendency(NaN), null);
});
test('Beaufort, UV, dew-point comfort and visibility classes', () => {
    assert.equal(P.beaufort(0.4).force, 0);
    assert.equal(P.beaufort(5.4).force, 3);
    assert.equal(P.beaufort(5.5).force, 4);
    assert.equal(P.beaufort(33).name, 'Hurricane force');
    assert.equal(P.uvCategory(2.9).id, 'low');
    assert.equal(P.uvCategory(3).id, 'moderate');
    assert.equal(P.uvCategory(10.9).id, 'very-high');
    assert.equal(P.uvCategory(11).id, 'extreme');
    assert.equal(P.dewPointComfort((49.9 - 32) * 5 / 9).id, 'dry');
    assert.equal(P.dewPointComfort((65 - 32) * 5 / 9).id, 'muggy', 'bands are the °F ones, converted exactly');
    assert.equal(P.visibilityClass(800, 99).id, 'fog');
    assert.equal(P.visibilityClass(3000, 95).id, 'mist');
    assert.equal(P.visibilityClass(3000, 40).id, 'haze', 'dry obscuration is haze, not mist');
    assert.equal(P.visibilityClass(25000).label, 'Excellent');
});
test('wind shift unwraps across north (350° → 10° is +20°, not −340°)', () => {
    assert.deepEqual(P.windShift([350, 10, 30]), { netDeg: 40, kind: 'veering' });
    assert.equal(P.windShift([30, 350]).kind, 'backing');
    assert.equal(P.windShift([100, 110]).kind, 'steady');
    assert.equal(P.windShift([100]), null);
});
test('degree days use the mean method, HDD/CDD on the 65 °F base', () => {
    const d = P.degreeDays(26, 10);
    near(d.gdd, 8, 1e-9); near(d.hdd, 65 * 0 + (65 - 32) * 5 / 9 - 18, 1e-9); assert.equal(d.cdd, 0);
});
test('climate position: mid-rank ties, CPC words, record flags, minimum sample', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(P.climatePosition(5.5, xs).percentile, 50);
    assert.equal(P.climatePosition(5, xs).percentile, 45, 'a tie counts half');
    assert.equal(P.climatePosition(11, xs).beyondRecord, 'high');
    assert.equal(P.climatePosition(11, xs).cls, 'much-above');
    assert.equal(P.climatePosition(5, xs.slice(0, 5)), null, 'n < 8 is not a statistic');
});
test('sparkline geometry breaks at gaps instead of dropping to zero', () => {
    const { points } = P.sparkPoints([1, 2, null, 4], { w: 100, h: 20, pad: 0 });
    assert.equal(points[2], null);
    assert.equal((P.sparkPath(points).match(/M/g) || []).length, 2);
    const flat = P.sparkPoints([5, 5, 5], { w: 100, h: 20, pad: 0 });
    assert.ok(flat.points.every((p) => Number.isFinite(p.y)), 'a flat series is centred, not NaN');
});

// ── Units ──────────────────────────────────────────────────────────────────
test('unit presets resolve from locale; custom overrides apply per quantity', () => {
    assert.equal(localePreset('en-US'), 'imperial');
    assert.equal(localePreset('en-GB'), 'metric');
    assert.equal(localePreset('en'), 'imperial');
    const imp = resolveUnits({ preset: 'auto' }, 'en-US');
    assert.equal(imp.temp, 'F'); assert.equal(imp.pressure, 'inHg');
    const cus = resolveUnits({ preset: 'custom', overrides: { wind: 'kn', height: 'ft', temp: 'bogus' } }, 'de-DE');
    assert.equal(cus.wind, 'kn'); assert.equal(cus.height, 'ft'); assert.equal(cus.temp, 'C', 'unknown unit falls back');
    assert.equal(cus.dd, 'C');
});
test('temperature DIFFERENCES convert without the +32 offset', () => {
    const imp = resolveUnits({ preset: 'imperial' });
    assert.equal(fmtText('tempDelta', 3, imp, { signed: true }), '+5.4 °F');
    assert.equal(fmt('dd', 5, imp).text, '9.0');
    assert.equal(fmt('temp', 0, imp).text, '32');
});
test('formatting: no negative zero, real minus sign, dash for missing', () => {
    const met = resolveUnits({ preset: 'metric' });
    assert.equal(fmt('temp', -0.04, met).text, '0.0');
    assert.equal(fmt('temp', -3.2, met).text, '−3.2');
    assert.equal(fmt('temp', null, met).text, '—');
    assert.equal(fmtText('pressure', NaN, met), '—');
});
test('fromDisplay is the exact inverse of every display conversion', () => {
    for (const preset of ['metric', 'imperial', 'si', 'aviation']) {
        const u = resolveUnits({ preset });
        for (const q of Object.keys(QUANTITIES)) {
            const d = fmt(q, 12.345, u, { dp: 9 }).value;
            near(fromDisplay(q, d, u), 12.345, 1e-6, `${preset}/${q}`);
        }
    }
});

// ── Prefs ──────────────────────────────────────────────────────────────────
test('normalizePrefs degrades garbage to defaults, field by field', () => {
    const p = normalizePrefs({ units: { preset: 'nope' }, openAt: 'mars', meteogramHours: 5, satellites: 'x', watches: {} });
    assert.equal(p.units.preset, 'auto'); assert.equal(p.openAt, 'home'); assert.equal(p.meteogramHours, 48);
    assert.deepEqual(p.satellites, [...DEFAULT_PREFS.satellites], 'a non-list degrades to the defaults');
    assert.deepEqual(normalizePrefs({ satellites: [] }).satellites, [], 'an emptied list stays empty');
    assert.deepEqual(normalizePrefs(null).satellites, [...DEFAULT_PREFS.satellites]);
    assert.equal(p.passReminder.leadMin, 10); assert.equal(p.passReminder.visibleOnly, true);
});
test('bench order: unknown ids dropped, duplicates collapsed, new instruments appended', () => {
    const p = normalizePrefs({ bench: { order: ['baro', 'ghost', 'baro', 'thermo'], hidden: ['thermo', 'ghost'] } });
    assert.deepEqual(p.bench.order.slice(0, 2), ['baro', 'thermo']);
    assert.equal(p.bench.order.length, INSTRUMENTS.length);
    assert.deepEqual(p.bench.hidden, ['thermo']);
    assert.ok(!visibleInstruments(p).includes('thermo'));
    const m = moveInstrument(p, 'thermo', -1);
    assert.deepEqual(m.bench.order.slice(0, 2), ['thermo', 'baro']);
    assert.deepEqual(moveInstrument(m, 'thermo', -1).bench.order.slice(0, 2), ['thermo', 'baro'], 'no move past the edge');
});
test('satellite list is deduped, integer-only and capped; watches are clamped', () => {
    const p = normalizePrefs({
        satellites: [25544, '25544', -1, 3.5, ...Array.from({ length: 20 }, (_, i) => 1000 + i)],
        watches: [{ kind: 'gust', threshold: 999, horizonH: 7, on: true }, { kind: 'nope' }, ...Array.from({ length: 20 }, (_, i) => ({ kind: 'uv', id: `u${i}` }))],
    });
    assert.equal(p.satellites[0], 25544);
    assert.equal(p.satellites.filter((x) => x === 25544).length, 1);
    assert.equal(p.satellites.length, MAX_SATELLITES);
    assert.equal(p.watches[0].threshold, 90, 'gust clamped to its max');
    assert.equal(p.watches[0].horizonH, 24, 'unknown horizon → 24 h');
    assert.equal(p.watches.length, MAX_WATCHES);
});

// ── Feed normaliser ────────────────────────────────────────────────────────
test('lab feed: epoch-ms times, null gaps preserved, station-local days', () => {
    assert.equal(obs.hourly.t[0] % HOUR, 0);
    assert.equal(obs.hourly.mslHpa[22], null, 'a missing hour stays null, never 0');
    assert.equal(obs.station.utcOffsetS, -21600);
    assert.equal(obs.station.elevationM, 1624);
    assert.equal(dayRowAt(obs, NOW).date, '2026-09-24');
    // 03:00 UTC on the 25th is still the 24th in Denver.
    assert.equal(stationDateKey(Date.UTC(2026, 8, 25, 3), -21600), '2026-09-24');
    assert.equal(obs.hourly.t[hourIndexAt(obs, NOW)], Date.UTC(2026, 8, 24, 20));
    const W = hourlyWindow(obs, NOW - 12 * HOUR, NOW + 48 * HOUR);
    assert.equal(W.t.length, 60);
    assert.equal(normalizeLabResponse({ hourly: {} }), null);
});

// ── Readings (derived from the fixture's closed form) ──────────────────────
const R = buildReadings(obs, { nowMs: NOW, air });
test('thermometer: the current block, today’s range and the 24 h change', () => {
    const t = R.readings.thermo;
    near(t.primary.v, 18 + 8 * Math.sin(2 * Math.PI * 5 / 24), 0.01);
    assert.equal(t.meter.lo, 10); assert.equal(t.meter.hi, 26);
    near(t.rows.find((r) => r.label === 'vs 24 h ago').v, 0, 0.01, 'a periodic day repeats');
});
test('barometer: −0.8 hPa/h over 3 h is −2.4 hPa → “Falling”', () => {
    const b = R.readings.baro;
    near(b.rows[0].v, -2.4, 1e-6);
    assert.match(b.status.label, /Falling$/);
    assert.equal(b.rows[1].v, 835, 'station pressure is the model surface_pressure');
});
test('anemometer: Beaufort 3 and a 55° veer over the next 12 h', () => {
    const a = R.readings.anemo;
    assert.match(a.status.label, /Force 3 · Gentle breeze/);
    assert.ok(a.rows.some((r) => r.text === 'Veering 55°'));
    assert.equal(a.visual.kind, 'compass');
});
test('rain gauge: 3 h × 2 mm ahead, none behind, “very likely”', () => {
    const r = R.readings.rain;
    near(r.primary.v, 6, 1e-9);
    assert.equal(r.rows.find((x) => x.label === 'Fell, past 24 h').v, 0, 'dry hours are a measured 0, not a missing reading');
    assert.equal(r.status.label, 'Rain very likely');
    assert.equal(r.spark.kind, 'bars');
});
test('sky, psychrometer, density, soil and degree-day tiles', () => {
    assert.equal(R.readings.sky.status.label, 'Excellent visibility');
    const lcl = R.readings.sky.rows.find((r) => r.label.startsWith('Cumulus')).v;
    near(lcl, 125 * (R.cur.tempC - R.cur.dewC), 1e-9);
    assert.equal(R.readings.psychro.status, null, 'mild day: no heat-stress chip');
    const rho = R.readings.density.primary.v;
    assert.ok(rho > 0.9 && rho < 1.0, `density ${rho}`);
    const da = R.readings.density.rows[0].v;
    assert.ok(da > 2000 && da < 2800, `density altitude ${da}`);
    near(R.readings.soil.rows[0].v, 0.21, 1e-9);
    near(R.readings.degree.primary.v, 8, 1e-9);
});
test('hazard tile shows composite-indices’ own verdict, plus tonight’s wind chill', () => {
    const h = R.readings.hazard;
    // The lab never re-derives an index: whatever the shared kernel flags
    // (here Hot-Dry-Windy — VPD ≈ 21 hPa × 5 m/s ≈ 106) is what the chip says.
    const adv = computeAdvisories({ tempC: R.cur.tempC, rhPct: R.cur.rhPct, windMs: R.cur.windMs, dewC: R.cur.dewC });
    assert.equal(h.status.label, adv[0]?.label ?? 'All clear');
    assert.ok(h.rows.some((r) => r.label === 'Lowest wind chill, 24 h'));
});
test('air-quality tile reads the NowCast feed state with its EPA category', () => {
    const a = R.readings.air;
    assert.equal(a.ok, true);
    assert.ok(Number.isFinite(a.primary.v));
    assert.ok(a.status.label.length > 0);
    assert.match(a.method, /CAMS model/);
    const none = buildReadings(obs, { nowMs: NOW }).readings.air;
    assert.equal(none.ok, false); assert.match(none.missing, /Air-quality/);
});
test('every status chip carries an icon and a label (never colour alone)', () => {
    for (const r of Object.values(R.readings)) {
        if (!r.ok || !r.status) continue;
        assert.ok(r.status.icon && r.status.label, r.id);
    }
});

// ── Lab watches ────────────────────────────────────────────────────────────
test('watches fire on the fixture’s known events, at the right hour', () => {
    const gust = evaluateWatch({ id: 'g', kind: 'gust', threshold: 8, horizonH: 24, on: true }, obs, { nowMs: NOW });
    assert.equal(gust.state, 'triggered'); assert.equal(gust.firstAt, Date.UTC(2026, 8, 24, 21));
    const heat = evaluateWatch({ id: 'h', kind: 'heat', threshold: 30, horizonH: 24, on: true }, obs, { nowMs: NOW });
    assert.equal(heat.state, 'clear'); near(heat.value, 26, 0.01);
    const pop = evaluateWatch({ id: 'p', kind: 'rain', threshold: 70, horizonH: 12, on: true }, obs, { nowMs: NOW });
    assert.equal(pop.firstAt, Date.UTC(2026, 8, 25, 2));
    const sum = evaluateWatch({ id: 's', kind: 'precip', threshold: 5, horizonH: 24, on: true }, obs, { nowMs: NOW });
    assert.equal(sum.state, 'triggered'); assert.equal(sum.firstAt, Date.UTC(2026, 8, 25, 4)); near(sum.value, 6, 1e-9);
    const aqi = evaluateWatch({ id: 'a', kind: 'aqi', threshold: 100, horizonH: 24, on: true }, obs, { nowMs: NOW, air });
    assert.equal(aqi.state, 'triggered'); assert.equal(aqi.firstAt, Date.UTC(2026, 8, 25, 11));
    const fog = evaluateWatch({ id: 'f', kind: 'fog', threshold: 1000, horizonH: 24, on: true }, obs, { nowMs: NOW });
    assert.equal(fog.state, 'clear'); assert.equal(fog.value, 4000);
    assert.equal(evaluateWatch({ id: 'x', kind: 'aqi', threshold: 1, horizonH: 6, on: true }, obs, { nowMs: NOW }).state, 'nodata');
});
test('disabled watches report off; a triggered episode notifies once', () => {
    const res = evaluateWatches([
        { id: 'g', kind: 'gust', threshold: 8, horizonH: 24, on: true },
        { id: 'u', kind: 'uv', threshold: 8, horizonH: 24, on: false },
    ], obs, { nowMs: NOW });
    assert.equal(res[1].state, 'off');
    const seen = new Set();
    assert.equal(newlyTriggered(res, seen).length, 1);
    assert.equal(newlyTriggered(res, seen).length, 0, 'same episode → silent');
});

// ── Charts ─────────────────────────────────────────────────────────────────
test('sparkline: forecast tail dashed, now-point drawn, empty on < 2 samples', () => {
    const svg = sparkSvg(R.readings.thermo.spark, { units: resolveUnits({ preset: 'metric' }) });
    assert.match(svg, /cl-spark-fc/); assert.match(svg, /cl-spark-dot/);
    assert.ok(!/NaN/.test(svg));
    assert.equal(sparkSvg({ values: [1], t: [0], nowIdx: 0, q: 'temp' }), '');
    assert.match(sparkSvg(R.readings.rain.spark, {}), /cl-spark-bar/);
});
test('meteogram: one shared time axis, gaps break the pressure line, no NaN', () => {
    const W = hourlyWindow(obs, NOW - 12 * HOUR, NOW + 48 * HOUR);
    const { svg, layout } = meteogramSvg(W, { nowMs: NOW, utcOffsetS: -21600, units: resolveUnits({ preset: 'metric' }), width: 720 });
    assert.equal(layout.n, 60); assert.equal(layout.xs.length, 60);
    assert.ok(layout.nowX > layout.L && layout.nowX < layout.L + layout.plotW);
    assert.ok(!/NaN|undefined/.test(svg));
    const press = svg.match(/class="cl-mg-press" d="([^"]*)"/)[1];
    assert.equal((press.match(/M/g) || []).length, 2, 'the null hour splits the line');
    assert.match(svg, /class="cl-mg-gust"/);
    assert.match(svg, />Fri</, 'midnight day labels on the STATION clock');
    // No short panel carries more than 3 value labels (they must stay legible).
    for (const id of ['wind', 'press']) {
        const { yT, yB } = layout.extents[id];
        const labels = [...svg.matchAll(/<text class="cl-axis-label" x="40" y="([\d.]+)" text-anchor="end">/g)]
            .map((m) => Number(m[1])).filter((y) => y >= yT - 2 && y <= yB + 4);
        assert.ok(labels.length <= 4, `${id}: ${labels.length} labels`);
    }
    assert.equal(meteogramSvg({ t: [1, 2] }).svg, '');
});
test('sky dome is a sky chart: east plots LEFT of centre, north up', () => {
    const svg = skyDomeSvg([{ azDeg: 90, elDeg: 0 }, { azDeg: 180, elDeg: 45 }, { azDeg: 270, elDeg: 0 }], { size: 168 });
    const ends = [...svg.matchAll(/class="cl-dome-end" cx="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.ok(ends[0] < 84 && ends[1] > 84, 'rise in the east (left), set in the west (right)');
    assert.match(svg, /cl-dome-peak/);
});
test('strip, compass, layers, meter and nice ticks', () => {
    assert.match(stripSvg({ samplesC: [1, 2, 3, 4], valueC: 5, normalC: 2.5, units: resolveUnits({ preset: 'metric' }) }), /cl-strip-today/);
    assert.equal(stripSvg({ samplesC: [1, 2] }), '');
    assert.match(compassSvg({ dirDeg: 270, speedMs: 5 }), /cl-dial-needle/);
    assert.ok(!/cl-dial-needle/.test(compassSvg({ dirDeg: 270, speedMs: 0.2 })), 'calm: no needle');
    assert.equal(layersSvg({}), '');
    assert.match(meterSvg({ kind: 'range', v: 20, min: 10, max: 26, lo: 10, hi: 26 }), /cl-meter-mark/);
    for (const span of [0.3, 1, 7, 10, 23, 180, 4000]) {
        const st = niceStep(span);
        const m = st / Math.pow(10, Math.floor(Math.log10(st)));
        assert.ok([1, 2, 5, 10].some((k) => Math.abs(m - k) < 1e-9), `1-2-5 step for span ${span}: ${st}`);
        assert.ok(span / st >= 1 && span / st <= 10, `2–10 intervals for span ${span}`);
    }
    assert.deepEqual([1, 2, 5, 10, 0.5, 20].map(nextNice), [2, 5, 10, 20, 1, 50]);
});

// ── Climate context ────────────────────────────────────────────────────────
test('climate context ranks today in its own season, from the archive', () => {
    const pts = normalizeClimate(archiveFixture(NOW)).pts;
    const c = climateContext({ pts, stationDate: '2026-09-24', todayHighC: 30, todayLowC: 10, lagDays: 31 });
    assert.ok(c.high.n >= 40 && c.high.n <= 50, `~3 years × 15 days, got ${c.high.n}`);
    assert.ok(c.high.percentile > 90, '30 °C (86 °F) is hot for this synthetic late September');
    assert.equal(positionWords(c.high), 'Much warmer than usual');
    assert.ok(c.normalHighC > 15 && c.normalHighC < 30);
    assert.equal(c.lagDays, 31);
    assert.ok(c.tauDays > 0 && c.sigmaC > 0);
    assert.equal(climateContext({ pts: pts.slice(0, 100), stationDate: '2026-09-24' }), null);
});
test('seasonal samples wrap across New Year', () => {
    const pts = normalizeClimate(archiveFixture(NOW)).pts;
    const jan2 = seasonalSamples(pts, Date.parse('2026-01-02T12:00'), { halfWindow: 7 });
    assert.ok(jan2.length >= 40, `late-December days count toward 2 January (${jan2.length})`);
    assert.equal(ordinal(1), '1st'); assert.equal(ordinal(12), '12th'); assert.equal(ordinal(93), '93rd');
});

// ── Satellite geometry ─────────────────────────────────────────────────────
test('satellite footprint, great circles, names and orbital speed', () => {
    near(footprintRadiusDeg(420), 20.4, 0.2, 'ISS horizon circle');
    assert.ok(footprintRadiusDeg(420, 10) < footprintRadiusDeg(420), 'a 10° mask shrinks it');
    const d = destination(0, 0, 90, 90);
    near(d.lat, 0, 1e-9); near(d.lon, 90, 1e-9);
    near(arcDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 90 }), 90, 1e-9);
    assert.equal(shortSatName('ISS (ZARYA)'), 'ISS');
    assert.equal(shortSatName('NOAA 20 (JPSS-1)'), 'NOAA 20');
    near(orbitalSpeedKms(6798, 6798), 7.66, 0.01);
});

// ── Home Base + account writes ─────────────────────────────────────────────
test('Home resolves account > device > demo, and ~1 km is "the same place"', () => {
    const acct = { lat: 40, lon: -105, city: 'Boulder' }, dev = { lat: 35, lon: 139, city: 'Tokyo' };
    assert.equal(resolveHome({ account: acct, device: dev }).source, 'account');
    assert.equal(resolveHome({ device: dev, demo: acct }).source, 'device');
    assert.equal(resolveHome({ demo: acct }).source, 'demo');
    assert.equal(resolveHome({ account: { lat: 'x', lon: 5 } }).home, null);
    assert.ok(sameLocation(acct, { lat: 40.004, lon: -105.004 }));
    assert.ok(!sameLocation(acct, { lat: 40.03, lon: -105 }));
    assert.equal(cleanLoc({ lat: 95, lon: 0 }), null);
    assert.equal(cleanLoc({ lat: 1, lon: 2 }).city, '1.00, 2.00', 'unnamed places get their coordinates');
});
test('the lab can never write plan, role, Stripe or seat columns', () => {
    const row = whitelistPatch({ plan: 'enterprise', role: 'superadmin', stripe_customer_id: 'x', seats_used: 9, location_lat: 1, notify_aurora: true, temp_low_f: 0 });
    assert.deepEqual(Object.keys(row).sort(), ['location_lat', 'notify_aurora', 'temp_low_f']);
    assert.equal(row.temp_low_f, 0, '0 °F is a real threshold, not "unset"');
    for (const bad of ['plan', 'role', 'subscription_status', 'notify_sat_pass']) assert.ok(!WRITABLE_COLUMNS.has(bad), bad);
});

// ── The weather proxy's `lab` parameter set ────────────────────────────────
const { default: forecastHandler } = await import('../api/weather/forecast.js');
{
    const realFetch = globalThis.fetch;
    let upstream = null;
    globalThis.fetch = async (url) => { upstream = String(url); return new Response('{"hourly":{"time":[]}}', { status: 200 }); };
    try {
        const res = await forecastHandler(new Request('https://x.test/api/weather/forecast?type=lab&lat=40.01549&lon=-105.2705&days=9'));
        test('proxy `type=lab`: SI units, unixtime, one past day, 3 days, both pressures', () => {
            assert.equal(res.status, 200);
            const u = new URL(upstream);
            assert.equal(u.searchParams.get('wind_speed_unit'), 'ms');
            assert.equal(u.searchParams.get('timeformat'), 'unixtime');
            assert.equal(u.searchParams.get('past_days'), '1');
            assert.equal(u.searchParams.get('forecast_days'), '3', 'days is clamped to the lab spec');
            assert.equal(u.searchParams.get('latitude'), '40.015', 'quantised to 3 dp');
            assert.equal(u.searchParams.get('temperature_unit'), null, 'Celsius (the upstream default)');
            for (const v of ['surface_pressure', 'pressure_msl', 'dew_point_2m', 'visibility', 'shortwave_radiation']) {
                assert.ok(u.searchParams.get('hourly').split(',').includes(v), v);
            }
            assert.ok(!u.searchParams.get('current').includes('precipitation_probability'));
            assert.match(res.headers.get('Cache-Control'), /s-maxage=900/);
        });
    } finally { globalThis.fetch = realFetch; }
}

console.log(`climate-lab: ALL PASS (${n} tests)`);
