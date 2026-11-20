/**
 * tests/bz-ground.mjs — gate for the Bz engine's B5 (BZ_ENGINE_PLAN.md):
 * js/bz/ground.js, ground-analysis.js, the ground/Dst normalisers and
 * api/bz/ground.js, plus the lower rungs of the column.
 *
 *   node tests/bz-ground.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dipoleLatitude, dbdt, equivalentCurrent, electrojetProxy, detectSuddenImpulses, detectPressureJumps, matchImpulses, stationSummary, flagNeighbourOutliers, flagDbdtOutliers, GROUND_DEFAULTS } from '../js/bz/ground.js';
import { analyzeGround, analyzeRing } from '../js/bz/ground-analysis.js';
import { normalizeGroundSeries, groundCoordinates, describeGroundPayload, normalizeDst, groundSeriesUrl, normalizeL1Mag, normalizeEphem, normalizeL1Plasma, DST_URL } from '../js/bz/feeds.js';
import { analyzeFlux } from '../js/bz/flux-analysis.js';
import { buildColumn, RUNG_ORDER } from '../js/bz/column.js';
import { integrateDst } from '../js/ring-current-model.js';
import { dynamicPressureNPa } from '../js/geomag/geospace.js';
import { USGS_STATION_IDS } from '../js/geomag/observatories.js';
import { unitNormal, plantedField, plantedFeeds } from './helpers/bz-planted-wind.mjs';
import { ROSTER, usgsPayload, plantedGround, usgsResponder } from './helpers/bz-planted-ground.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (name) => { checks++; console.log(`  ✓ ${name}`); };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} ± ${tol}`);
const NOW = Date.parse('2026-11-20T14:20:00Z');

// ── 1. normalisers ────────────────────────────────────────────────────────
{
    assert.deepEqual(Object.keys(ROSTER).sort(), [...USGS_STATION_IDS].sort(), 'the planted roster is the engine\'s roster');
    const t = Array.from({ length: 10 }, (_, i) => NOW - (9 - i) * 1000);
    const p = usgsPayload('BOU', ROSTER.BOU, t, [1, 2, 99999, 4, 5, 6, 7, NaN, NaN, NaN], [1, 1, 1, 1, 1, 1, 1, NaN, NaN, NaN]);
    const s = normalizeGroundSeries(p, { nowMs: NOW });
    assert.equal(s.iaga, 'BOU');
    close(s.lat, 40.14, 1e-9); close(s.lon, -105.24, 1e-9, 'east longitude 254.76 is read back as −105.24');
    assert.equal(s.t.length, 7, 'the null padding up to now is cut');
    assert.equal(s.latency_s, 3);
    assert.ok(s.x[2] !== s.x[2], 'the IAGA 99999 fill is a gap');
    assert.equal(s.valid, 6);
    assert.equal(s.cadence_s, 1);
    assert.equal(s.coordinates_from, 'metadata.station.geometry.coordinates');
    // The INTERMAGNET-style layout (coordinates under metadata.intermagnet.imo) reads the same.
    const im = normalizeGroundSeries({ ...p, metadata: { intermagnet: { imo: { iaga_code: 'BOU', name: 'Boulder', coordinates: [254.76, 40.14, 1682] } } } }, { nowMs: NOW, station: 'BOU' });
    close(im.lat, 40.14, 1e-9); close(im.lon, -105.24, 1e-9); assert.equal(im.coordinates_from, 'metadata.intermagnet.imo.coordinates'); assert.equal(im.iaga, 'BOU');
    assert.equal(groundCoordinates({ metadata: { station: { latitude: 21.3, longitude: -158 } } }).from, 'metadata.station.latitude/longitude');
    assert.equal(groundCoordinates({ metadata: { station: { latitude: null, longitude: null } } }), null, 'null is not the equator');
    assert.equal(groundCoordinates({ metadata: { intermagnet: { imo: { coordinates: [254, 140] } } } }), null, 'a latitude of 140° is not a position');
    const shape = describeGroundPayload({ ...p, metadata: { something: { new: 1 } } });
    assert.deepEqual(shape.metadata, ["something"]); assert.equal(shape.coordinates_from, null); assert.deepEqual(shape.values, ["X", "Y", "Z"]); assert.equal(shape.times, 10);
    assert.ok(!JSON.stringify(shape).includes("20000"), 'the description carries structure, never data');
    assert.equal(normalizeGroundSeries({ times: [] }, {}), null);
    assert.equal(normalizeGroundSeries({ ...p, metadata: {} }, {}), null, 'no coordinates in the payload ⇒ no station (never a typed position)');
    assert.equal(normalizeGroundSeries(usgsPayload('X', [1, 2], t, t.map(() => NaN), t.map(() => NaN)), {}), null, 'all-null ⇒ null');
    const u = groundSeriesUrl('BOU', 1, 3600, NOW);
    assert.match(u, /^https:\/\/geomag\.usgs\.gov\/ws\/data\/\?id=BOU&type=variation&elements=X,Y,Z&sampling_period=1&format=json&starttime=2026-11-20T13%3A20%3A00Z&endtime=2026-11-20T14%3A20%3A00Z$/);
    assert.match(groundSeriesUrl('BOU&x=1', 7, 60, NOW), /id=BOU%26&.*sampling_period=60/, 'the code is clipped and escaped; only 1 or 60 is sent');

    const d = normalizeDst([['time_tag', 'dst'], ['2026-11-20 12:00:00', '-18'], ['2026-11-20 13:00:00', '99999'], ['2026-11-20 11:00:00', '-12']]);
    assert.deepEqual(d.map((r) => r.dst), [-12, -18], 'ascending, fill dropped');
    assert.equal(normalizeDst([{ time_tag: '2026-11-20T12:00:00Z', dst: -40 }])[0].dst, -40);
    assert.deepEqual(normalizeDst('nope'), []);
    assert.match(DST_URL, /kyoto-dst\.json$/);
    ok('ground series: coordinates from a candidate list (two layouts), null padding cut, fills are gaps; an unreadable payload is described');
}

// ── 2. geometry: zones are COMPUTED ───────────────────────────────────────
{
    const date = new Date(NOW);
    const lat = (id) => dipoleLatitude(...ROSTER[id], date);
    assert.ok(lat('BRW') > 65 && lat('DED') > 65 && lat('CMO') > 60, `BRW ${lat('BRW').toFixed(1)}°, CMO ${lat('CMO').toFixed(1)}°`);
    assert.ok(lat('HON') > 15 && lat('HON') < 30);
    assert.ok(lat('GUA') > 0 && lat('GUA') < 15);
    assert.ok(lat('BOU') > 45 && lat('BOU') < 52, `Boulder's dipole latitude is ${lat('BOU').toFixed(1)}°, ~8° above its geographic one`);
    ok(`dipole latitudes computed: BRW ${lat('BRW').toFixed(1)}°, CMO ${lat('CMO').toFixed(1)}°, BOU ${lat('BOU').toFixed(1)}°, HON ${lat('HON').toFixed(1)}°`);
}

// ── 3. dB/dt and what a minute product hides ──────────────────────────────
{
    const N = 600, t = new Float64Array(N), x = new Float64Array(N), y = new Float64Array(N);
    const t0 = Math.floor(NOW / 60000) * 60000 - 600000;
    for (let i = 0; i < N; i++) { t[i] = t0 + i * 1000; x[i] = 0.5 * Math.min(10, Math.max(0, i - 300)); y[i] = 0; }   // 0.5 nT/s for 10 s
    const r = dbdt({ t, x, y, cadence_s: 1 });
    close(r.peak_nt_s, 0.5, 1e-9);
    // The ramp starts on a minute boundary, so that minute's MEAN is (22.5 + 250)/60 = 4.5417 nT.
    close(r.peak_1min_nt_s, 272.5 / 60 / 60, 1e-9, 'the step between two minute means');
    close(r.underread, 0.5 / (272.5 / 3600), 1e-6, 'the minute product reads under a sixth of the real rate');
    assert.equal(r.peak_time, t0 + 301000);
    // A gap with a jump across it is NOT a rate.
    const tg = Float64Array.from(t), xg = Float64Array.from(x);
    for (let i = 400; i < N; i++) { tg[i] += 120000; xg[i] += 500; }
    close(dbdt({ t: tg, x: xg, y, cadence_s: 1 }).peak_nt_s, 0.5, 1e-9, 'never differenced across a gap');
    const xn = Float64Array.from(x); xn[305] = NaN;
    assert.ok(dbdt({ t, x: xn, y, cadence_s: 1 }).peak_nt_s <= 0.5 + 1e-9, 'a NaN removes its two differences, it does not bridge them');
    assert.equal(dbdt({ t: t.subarray(0, 30), x: x.subarray(0, 30), y: y.subarray(0, 30), cadence_s: 1 }), null);
    ok('dB/dt: 0.5 nT/s for 10 s reads 0.076 nT/s as a minute product (×6.6 under-read); gaps are never differenced');
}

// ── 4. the equivalent current's sign, against Biot–Savart ─────────────────
{
    // Frame: x north, y east, z DOWN. A sheet at height h carrying J (A/m) eastward.
    const MU0 = 4e-7 * Math.PI, h = 110e3, J = 0.1, W = 4000e3, dx = 5e3;
    let bNorth = 0;
    for (let xs = -W; xs <= W; xs += dx) {
        // an infinite line current I = J·dx along +y at (xs, −h): B at the origin has magnitude μ0 I / 2πr,
        // direction ŷ × r̂ with r from the wire to the origin = (−xs, 0, h).
        const r = Math.hypot(xs, h), I = J * dx;
        bNorth += (MU0 * I / (2 * Math.PI * r)) * (h / r);         // (ŷ × (−xs,0,h)/r)_x = h/r
    }
    assert.ok(bNorth > 0, 'an eastward current overhead makes a NORTHWARD field at the ground');
    close(bNorth, MU0 * J / 2, 0.02 * MU0 * J / 2, 'wide-sheet limit μ0 J / 2');
    const c = equivalentCurrent(bNorth * 1e9, 0, 1);
    close(c.jEastAkm, J * 1e3, 0.02 * J * 1e3, 'the kernel inverts it: A/km back from nT');
    close(c.directionDeg, 90, 1e-9);
    const south = equivalentCurrent(0, 50, 1);
    assert.ok(south.jNorthAkm < 0 && Math.abs(south.jEastAkm) < 1e-9, 'an eastward perturbation means a SOUTHWARD current');
    close(equivalentCurrent(100, 0).magnitudeAkm, (2 / 3) * equivalentCurrent(100, 0, 1).magnitudeAkm, 1e-9, 'the external fraction is a stated factor');
    assert.equal(equivalentCurrent(NaN, 0), null);
    assert.equal(GROUND_DEFAULTS.externalFraction, 2 / 3);
    ok('equivalent current: direction and μ₀J/2 magnitude agree with a Biot–Savart integration of the sheet');

    const p = electrojetProxy([{ iaga: 'CMO', dipLat: 65, dx: -310 }, { iaga: 'BRW', dipLat: 70, dx: 40 }, { iaga: 'BOU', dipLat: 48, dx: -900 }, { iaga: 'DED', dipLat: 70, dx: NaN }]);
    assert.deepEqual(p.stations, ['CMO', 'BRW']);
    assert.equal(p.westward_nt, -310); assert.equal(p.westward_at, 'CMO'); assert.equal(p.eastward_nt, 40);
    assert.equal(electrojetProxy([{ iaga: 'BOU', dipLat: 48, dx: -900 }]).westward_nt, null, 'no auroral station ⇒ no proxy, never a mid-latitude value');
    ok('electrojet proxy: auroral-zone stations only; none ⇒ null');
}

// ── 5. sudden impulses and pressure jumps ─────────────────────────────────
function seriesOf(planted, kind = 'fast') {
    const out = {};
    for (const [id, p] of Object.entries(planted[kind])) out[id] = normalizeGroundSeries(p, { nowMs: NOW, station: id });
    return out;
}
{
    const siAt = NOW - 25 * 60e3;
    const f = seriesOf(plantedGround({ nowMs: NOW, siAtMs: siAt }));
    const list = Object.values(f).map((s) => ({ iaga: s.iaga, dipLat: dipoleLatitude(s.lat, s.lon, new Date(NOW)), t: s.t, x: s.x }));
    const si = detectSuddenImpulses(list);
    assert.equal(si.length, 1);
    close(si[0].time, siAt, 45e3, 'timed to well under a minute');
    close(si[0].step_nt, 12, 1.5);
    assert.ok(si[0].stations.length >= 6 && !si[0].stations.includes('BRW') && !si[0].stations.includes('CMO'), 'read at low/mid latitudes only');
    // No impulse planted ⇒ none found (the CMO burst and the BOU pulsation are not impulses).
    assert.equal(detectSuddenImpulses(Object.values(seriesOf(plantedGround({ nowMs: NOW }))).map((s) => ({ iaga: s.iaga, dipLat: dipoleLatitude(s.lat, s.lon, new Date(NOW)), t: s.t, x: s.x }))).length, 0);
    // A step at ONE station is not a sudden impulse.
    const lone = list.filter((s) => s.iaga === 'HON');
    assert.equal(detectSuddenImpulses(lone).length, 0, 'one station is an instrument, not the magnetosphere');
    ok(`sudden impulse: a planted 12 nT step is found once, within ${Math.round(Math.abs(si[0].time - siAt) / 1000)} s, at ${si[0].stations.length} low/mid stations`);

    const arr = Array.from({ length: 200 }, (_, i) => NOW - (200 - i) * 60e3);
    const sp = arr.map((_, i) => (i < 120 ? 1.0 : 1.6));
    const j = detectPressureJumps(arr, sp);
    assert.equal(j.length, 1); close(j[0].time, arr[120], 60e3); close(j[0].step_sqrt_npa, 0.6, 1e-9);
    assert.equal(detectPressureJumps(arr, arr.map(() => 1)).length, 0);
    assert.equal(detectPressureJumps(arr, sp.map((v, i) => (i % 7 ? v : NaN))).length, 1, 'gaps in the wind do not hide the jump');
    const m = matchImpulses([{ time: arr[120] + 300e3, step_nt: 10, stations: [] }], j);
    assert.equal(m[0].match.error_s, 300);
    assert.equal(matchImpulses([{ time: arr[120] + 300e3, step_nt: -10, stations: [] }], j)[0].match, null, 'a decompression does not match a compression');
    assert.equal(matchImpulses([{ time: arr[120] + 3600e3, step_nt: 10, stations: [] }], j)[0].match, null, 'too far apart is not a match');
    ok('pressure jumps found in the arrived wind; an impulse matches only a jump of the same sign within 20 min');
}

// ── 6. the assembly: planted wind → predicted arrival → ground impulse ────
function plantWind() {
    const f = plantedFeeds({ field: plantedField(11, 1440), normal: unitNormal(20), speedKms: 420, densityCc: (i) => (i > 1350 ? 16 : 5), nowMs: NOW });
    const mag = normalizeL1Mag(f.mag, { nowMs: NOW }), ephem = normalizeEphem(f.eph, { nowMs: NOW }), plasma = normalizeL1Plasma(f.wind, { nowMs: NOW });
    return { f, flux: analyzeFlux({ mag, ephem, plasma, nowMs: NOW }) };
}
const W = plantWind();
const PRED = (() => {
    const s = W.flux._series;
    const j = detectPressureJumps(s.arrivalMs, s.arrivalMs.map((_, i) => Math.sqrt(dynamicPressureNPa(s.density[i], s.speed[i]))));
    return j.filter((q) => q.time < NOW)[0];
})();
{
    assert.ok(PRED && PRED.time < NOW - 10 * 60e3 && PRED.time > NOW - 55 * 60e3, 'the planted density jump has arrived inside the ground window');
    const SHEATH_S = 360;                              // the ground responds six minutes after the predicted nose arrival
    const planted = plantedGround({ nowMs: NOW, siAtMs: PRED.time + SHEATH_S * 1000 });
    const a = analyzeGround({ fast: seriesOf(planted), slow: seriesOf(planted, 'slow'), wind: W.flux._series, nowMs: NOW });
    assert.equal(a.stations_total, 14); assert.equal(a.stations_1s, 14);
    assert.equal(a.timing_score.status, 'scored');
    close(a.timing_score.median_error_s, SHEATH_S, 90, 'the planted sheath delay is recovered as the timing error');
    assert.match(a.timing_score.note, /INCLUDES the sheath/);
    // dB/dt: the CMO burst (2 nT/s for 3 s) is the network peak, and a minute product hides most of it.
    assert.equal(a.dbdt.at_station, 'CMO');
    close(a.dbdt.peak_nt_s, 2, 0.1);
    assert.ok(a.dbdt.minute_product_would_read_nt_s < 0.2, `a minute product reads ${a.dbdt.minute_product_would_read_nt_s} nT/s`);
    assert.ok(a.dbdt.underread_max > 10);
    // The auroral bay shows in the proxy; the pulsation in Pc5 at its station only.
    close(a.electrojet_proxy.westward_nt, -300, 8);   // −300 bay + the 6 nT the planted burst leaves behind assert.equal(a.electrojet_proxy.westward_at, 'CMO');
    assert.match(a.electrojet_proxy.label, /NOT the AL\/AU index/);
    const st = Object.fromEntries(a.stations.map((s) => [s.iaga, s]));
    // The planted wave is 3 nT at 4 mHz (rms 2.12). With the sudden impulse in the same hour the band
    // reads HIGHER — a step is broadband and nothing here removes it. Both are pinned: the clean value
    // on a quiet record, and the fact of the contamination.
    const quietRun = analyzeGround({ fast: seriesOf(plantedGround({ nowMs: NOW })), slow: {}, nowMs: NOW });
    const qst = Object.fromEntries(quietRun.stations.map((s) => [s.iaga, s]));
    close(qst.BOU.pulsation_rms_nt.pc5, 3 / Math.SQRT2, 0.15, 'a 3 nT, 4 mHz wave on a quiet record');
    assert.ok(qst.FRD.pulsation_rms_nt.pc5 < 0.05);
    assert.ok(st.BOU.pulsation_rms_nt.pc5 > qst.BOU.pulsation_rms_nt.pc5 && st.FRD.pulsation_rms_nt.pc5 > 0.5, 'an impulse in the window leaks into the Pc5 band');
    assert.ok(st.FRD.pulsation_rms_nt.pc4 != null && st.FRD.pulsation_rms_nt.pc3 != null, 'at 1 s, Pc4 and Pc3 are resolved');
    assert.equal(st.CMO.zone, 'auroral'); assert.equal(st.HON.zone, 'low-mid');
    assert.equal(st.CMO.equivalent_current.kind, 'ESTIMATED');
    close(st.CMO.equivalent_current.toward_deg, 270, 3, 'a negative bay is a WESTWARD electrojet');
    assert.ok(st.CMO.equivalent_current.a_per_km > 250);
    assert.equal(st.CMO.delta_nt.baseline, 'trailing median, provisional');
    assert.ok(a.latency_s >= 120 && a.latency_s <= 135);
    ok(`assembly: timing error ${a.timing_score.median_error_s} s (planted 360), CMO burst 2 nT/s read as ${a.dbdt.minute_product_would_read_nt_s} by a minute product, bay −300 nT, Pc5 ${st.BOU.pulsation_rms_nt.pc5} nT`);

    // A station whose record has stepped by thousands of nT (measured: FRN, −2766 nT on a quiet day)
    // is flagged and kept out of every network number — it must not own the peak or the proxy.
    const bad = seriesOf(planted), badSlow = seriesOf(planted, 'slow');
    for (let i = 0; i < bad.FRN.x.length; i++) bad.FRN.x[i] -= 2766;
    for (let i = 1500; i < bad.FRN.x.length; i++) bad.FRN.x[i] += 40 * (i % 2);      // and a noisy tail: 40 nT/s
    const b2 = analyzeGround({ fast: bad, slow: badSlow, wind: null, nowMs: NOW });
    assert.deepEqual(b2.suspect_stations, ['FRN']);
    assert.equal(b2.dbdt.at_station, 'CMO', 'the bad record does not own the network peak');
    const frn = b2.stations.find((q) => q.iaga === 'FRN');
    assert.equal(frn.suspect, true); assert.equal(frn.equivalent_current, null);
    assert.ok(frn.delta_nt.north < -2700, 'its number is still shown, flagged — not hidden');
    assert.deepEqual(a.suspect_stations, []);

    // The neighbour test, on the REAL station values of 2026-11-20 18:33 UT (production /api/bz/ground):
    // FRN −245 nT among low/mid stations reading 0–15 nT. Under the absolute threshold; it owned the peak.
    const real = [['BOU', 47.6, -3.2, -3.5], ['BSL', 39.1, 6.2, -14], ['FRD', 47.3, 0.8, -12.8], ['FRN', 43, -244.7, -49.4], ['GUA', 6.3, 0.1, 0.1],
        ['HON', 21.8, 11.6, 6.5], ['SJG', 27.2, 3.7, -5.4], ['TUC', 39.2, -0.7, -0.9], ['NEW', 54.3, -8.7, -0.3], ['SHU', 54.7, 1.6, 7.9],
        ['BRW', 70.2, -57.5, 5.6], ['CMO', 65.7, -9.6, 4.6], ['DED', 70.5, -22.8, 6.5], ['SIT', 60.3, -7.7, 4.7]];
    const mkSt = (rows) => rows.map(([iaga, dipLat, dx, dy]) => ({ iaga, dipLat, dx, dy, suspect: false, zone: dipLat >= 60 ? 'auroral' : (dipLat <= 50 ? 'low-mid' : 'sub-auroral') }));
    const rs = mkSt(real);
    assert.deepEqual(flagNeighbourOutliers(rs), ['FRN'], 'only FRN — and not BRW at −57 nT, which is an auroral station doing its job');
    const f = rs.find((q) => q.iaga === 'FRN');
    assert.equal(f.suspectReason, 'neighbour'); assert.ok(f.neighbour.excess_nt > 200 && f.neighbour.limit_nt === 100);
    // A storm is not a bad record: every low/mid station depressed 250–420 nT ⇒ nobody is flagged, including the deepest.
    const storm = mkSt(real.map(([id, lat, , dy], i) => [id, lat, lat <= 50 ? -250 - 28 * (i % 7) : -900, dy]));
    assert.deepEqual(flagNeighbourOutliers(storm), [], 'the limit grows with the spread of the others');
    // …but one station 2000 nT away from a storm-time network still is (and the 1500 nT absolute rule is separate).
    const stormBad = mkSt(real.map(([id, lat, , dy], i) => [id, lat, id === 'TUC' ? -1400 : (lat <= 50 ? -250 - 28 * (i % 7) : -900), dy]));
    assert.deepEqual(flagNeighbourOutliers(stormBad), ['TUC']);
    // An auroral or sub-auroral station is never judged by this test, whatever it reads.
    assert.deepEqual(flagNeighbourOutliers(mkSt(real.map((r) => (r[0] === 'CMO' || r[0] === 'NEW' ? [r[0], r[1], -1200, 0] : (r[0] === 'FRN' ? [r[0], r[1], -3, 1] : r))))), []);
    // Too few comparable stations ⇒ no test and no flag (negative control: the same FRN value passes untested).
    assert.deepEqual(flagNeighbourOutliers(mkSt(real.filter((r) => ['FRN', 'BOU', 'TUC', 'CMO'].includes(r[0])))), []);
    // Already-flagged stations are neither judged again nor used as anyone's neighbour.
    const pre = mkSt(real); pre.find((q) => q.iaga === 'BSL').suspect = true;
    assert.deepEqual(flagNeighbourOutliers(pre), ['FRN']);
    // End to end: a planted −245 nT offset at FRN leaves the network peak and the E-region maximum to sound stations.
    const off = seriesOf(planted), offSlow = seriesOf(planted, 'slow');
    for (let i = 0; i < off.FRN.x.length; i++) off.FRN.x[i] -= 245;
    for (let i = 1500; i < off.FRN.x.length; i++) off.FRN.x[i] += 9 * (i % 2);
    const b3 = analyzeGround({ fast: off, slow: offSlow, wind: null, nowMs: NOW });
    assert.deepEqual(b3.suspect_stations, ['FRN']); assert.notEqual(b3.dbdt.at_station, 'FRN');
    assert.match(b3.stations.find((q) => q.iaga === 'FRN').suspect_reason, /above the other low\/mid-latitude stations/);
    assert.equal(b3.stations.find((q) => q.iaga === 'FRN').equivalent_current, null);
    ok(`neighbour test: FRN (${Math.round(f.neighbour.excess_nt)} nT above its neighbours, limit 100) flagged on the real 18:33 UT values; a storm, an auroral bay and a thin network are not`);

    // The same test on dB/dt, on the REAL peaks of 2026-11-20 20:22 UT (production /api/bz/ground): FRN's LEVEL
    // was normal (+12.3 nT) so the level test passed it — and its one-second spike owned the network peak.
    const realRate = [['BOU', 47.6, 0.096, -6], ['BSL', 39.1, 0.082, 1.8], ['FRD', 47.3, 0.15, -0.7], ['FRN', 43, 2.544, 12.3], ['GUA', 6.3, 0.061, 6],
        ['HON', 21.8, 0.069, 17.7], ['SJG', 27.2, 0.08, -4.8], ['TUC', 39.2, 0.069, 1.1], ['NEW', 54.3, 0.09, -14], ['SHU', 54.7, 0.128, 0.8],
        ['BRW', 70.2, 0.85, -8.2], ['CMO', 65.7, 0.357, -4.7], ['DED', 70.5, 0.861, -14.4], ['SIT', 60.3, 0.147, -9.1]];
    const mkRate = (rows) => rows.map(([iaga, dipLat, peak, dx]) => ({ iaga, dipLat, dx, dy: 0, suspect: false, dbdt: { peak_nt_s: peak }, zone: dipLat >= 60 ? 'auroral' : (dipLat <= 50 ? 'low-mid' : 'sub-auroral') }));
    const rr = mkRate(realRate);
    assert.deepEqual(flagNeighbourOutliers(rr), [], 'negative control: the LEVEL test alone does not see this fault');
    assert.deepEqual(flagDbdtOutliers(rr), ['FRN'], 'only FRN — not DED or BRW at 0.86, which are auroral stations');
    const fr = rr.find((q) => q.iaga === 'FRN');
    assert.equal(fr.dbdtSuspect, true); assert.equal(fr.suspect, false, 'a spike says nothing against the station\'s level');
    assert.equal(fr.dbdtNeighbour.limit_nt_s, 0.5); assert.ok(fr.dbdtNeighbour.excess_nt_s > 2.4);
    // A sudden impulse reaches every low/mid station together: 1.5–4 nT/s everywhere flags nobody.
    assert.deepEqual(flagDbdtOutliers(mkRate(realRate.map(([id, lat, , dx], i) => [id, lat, lat <= 50 ? 1.5 + 0.4 * (i % 7) : 5, dx]))), []);
    // …but 40 nT/s at one station inside that impulse is still a spike.
    assert.deepEqual(flagDbdtOutliers(mkRate(realRate.map(([id, lat, , dx], i) => [id, lat, id === 'HON' ? 40 : (lat <= 50 ? 1.5 + 0.4 * (i % 7) : 5), dx]))), ['HON']);
    // An auroral or sub-auroral station is never judged; fewer than four comparable stations is no test;
    // a station with no 1-second data has no rate to judge; a station already flagged is not a neighbour.
    assert.deepEqual(flagDbdtOutliers(mkRate(realRate.map((r) => (r[0] === 'CMO' || r[0] === 'SHU' ? [r[0], r[1], 30, r[3]] : (r[0] === 'FRN' ? [r[0], r[1], 0.1, r[3]] : r))))), []);
    assert.deepEqual(flagDbdtOutliers(mkRate(realRate.filter((r) => ['FRN', 'BOU', 'TUC', 'CMO'].includes(r[0])))), []);
    const noFast = mkRate(realRate); noFast.find((q) => q.iaga === 'FRN').dbdt = null;
    assert.deepEqual(flagDbdtOutliers(noFast), []);
    // End to end: a planted one-second spike at FRN (level untouched) no longer owns the network peak,
    // while FRN stays in every level-based number.
    const sp = seriesOf(planted), spSlow = seriesOf(planted, 'slow');
    sp.FRN.x[2000] += 30;
    const b4 = analyzeGround({ fast: sp, slow: spSlow, wind: null, nowMs: NOW });
    assert.deepEqual(b4.suspect_stations, []); assert.deepEqual(b4.dbdt_suspect_stations, ['FRN']);
    assert.notEqual(b4.dbdt.at_station, 'FRN'); assert.equal(b4.dbdt.at_station, a.dbdt.at_station);
    assert.equal(b4.dbdt.peak_nt_s, a.dbdt.peak_nt_s, 'the network peak is what it was without the spike');
    const f4 = b4.stations.find((q) => q.iaga === 'FRN');
    assert.equal(f4.dbdt_suspect, true); assert.ok(f4.dbdt_peak_nt_s > 25, 'its number is still shown');
    assert.match(f4.dbdt_suspect_reason, /kept out of the network peak/);
    assert.ok(f4.equivalent_current, 'and its level-based current is kept');
    assert.deepEqual(a.dbdt_suspect_stations, [], 'the unspiked network flags nobody');
    ok(`dB/dt neighbour test: FRN's ${fr.dbdt.peak_nt_s} nT/s spike flagged on the real 20:22 UT peaks (others' median ${fr.dbdtNeighbour.others_median_nt_s.toFixed(3)}); an impulse and auroral rates are not`);

    // Quiet: nothing to time, and the score says so rather than claiming a pass.
    const quiet = analyzeGround({ fast: seriesOf(plantedGround({ nowMs: NOW })), slow: {}, wind: null, nowMs: NOW });
    assert.equal(quiet.timing_score.status, 'no_wind');
    assert.equal(quiet.sudden_impulses.length, 0);
    assert.equal(quiet.stations[0].delta_nt.north, null, 'no baseline ⇒ no ΔX, never the raw 20 000 nT field');
    assert.equal(quiet.stations[0].equivalent_current, null);
    const q2 = analyzeGround({ fast: seriesOf(plantedGround({ nowMs: NOW })), slow: {}, wind: W.flux._series, nowMs: NOW });
    assert.equal(q2.timing_score.status, 'events_unmatched', 'a predicted jump with no ground impulse is reported, not scored');
    assert.equal(q2.timing_score.median_error_s, null);
    // Minute data only: the rung degrades to ΔX and says it has no 1-second data.
    const slowOnly = analyzeGround({ fast: {}, slow: seriesOf(plantedGround({ nowMs: NOW }), 'slow'), wind: null, nowMs: NOW });
    assert.equal(slowOnly.stations_1s, 0); assert.equal(slowOnly.dbdt, null);
    assert.equal(analyzeGround({ fast: {}, slow: {}, nowMs: NOW }), null);
    ok('degradations: no wind / no impulse / no baseline / no 1-second data are each stated, none is scored');
}

// ── 7. the ring-current rung ──────────────────────────────────────────────
{
    const s = W.flux._series;
    const samples = s.arrivalMs.map((t, i) => ({ t, v: s.speed[i], n: s.density[i], bz: s.bz[i] }));
    const h0 = Math.ceil(s.arrivalMs[0] / 3600e3) * 3600e3;
    const fromAnchor = samples.filter((q) => q.t >= h0);
    const truth = integrateDst(fromAnchor, -22, { model: 'obm' });
    const dst = [];
    for (let t = h0, k = 0; t <= s.arrivalMs[s.arrivalMs.length - 1]; t += 3600e3) {
        while (k + 1 < truth.length && truth[k + 1].t <= t) k++;
        dst.push({ t, dst: t === h0 ? -22 : Math.round(truth[k].dst) });
    }
    const r = analyzeRing({ dst, wind: s, nowMs: NOW });
    assert.equal(r.measured.kind, 'MEASURED');
    assert.equal(r.model.anchor_dst_nt, -22);
    assert.ok(r.model.score.hours >= 15);
    assert.ok(r.model.score.rmse_nt < 0.6, `the engine's wind through the site's Dst model reproduces it (rmse ${r.model.score.rmse_nt} nT)`);
    assert.ok(r.model.score.rmse_nt < r.model.score.rmse_persistence_nt);
    assert.equal(r.model.kind, 'FORECAST', 'the arrived-wind series runs past now, so the newest model value is a forecast');
    assert.match(r.model.name, /integrateDst/);
    // A Dst that does NOT follow the wind is scored as such.
    const off = analyzeRing({ dst: dst.map((d, i) => ({ ...d, dst: i ? d.dst - 40 : d.dst })), wind: s, nowMs: NOW });
    assert.ok(off.model.score.rmse_nt > 30);
    assert.equal(analyzeRing({ dst, wind: null, nowMs: NOW }).model, null, 'no wind ⇒ measurement only');
    assert.equal(analyzeRing({ dst: [], wind: s, nowMs: NOW }), null);
    ok(`ring current: the site's one Dst model on the arrived wind, anchored once — rmse ${r.model.score.rmse_nt} nT vs persistence ${r.model.score.rmse_persistence_nt}`);

    // …and the column's lower rungs.
    const planted = plantedGround({ nowMs: NOW, siAtMs: PRED.time + 360e3 });
    const ground = analyzeGround({ fast: seriesOf(planted), slow: seriesOf(planted, 'slow'), wind: s, nowMs: NOW });
    const c = buildColumn({ flux: W.flux, geo: null, ground, ring: r, nowMs: NOW });
    const by = Object.fromEntries(c.rungs.map((q) => [q.id, q]));
    assert.deepEqual(c.rungs.map((q) => q.id), RUNG_ORDER);
    assert.equal(by.ring_current.kind, 'MEASURED'); assert.equal(by.ring_current.model.kind, 'FORECAST');
    assert.equal(by.leo.kind, 'NOT_BUILT'); assert.match(by.leo.caveats[0], /licence/);
    assert.equal(by.e_region.kind, 'ESTIMATED'); assert.equal(by.e_region.values.at_station, 'CMO');
    assert.ok(by.e_region.caveats.some((x) => /NOT the AL\/AU/.test(x)));
    assert.equal(by.ground.kind, 'MEASURED'); assert.equal(by.ground.values.sudden_impulses, 1);
    assert.equal(by.ground.timing_score.status, 'scored');
    assert.equal(by.subsurface.kind, 'DELEGATED'); assert.match(by.subsurface.caveats[0], /NOT been run on the 1-second series/);
    assert.equal(c.summary.kinds.NOT_BUILT, 1, 'one rung is left unbuilt, and it says why');
    ok('column: ring current measured + modelled, E-region estimated, ground measured, below-ground delegated, LEO not built');
}

// ── 8. the route ──────────────────────────────────────────────────────────
{
    const src = readFileSync(join(ROOT, 'api', 'bz', 'ground.js'), 'utf8');
    assert.ok(!/jsonError\('upstream_unavailable'/.test(src));
    assert.ok(!/searchParams\.get\('(url|id|station)'\)/.test(src), 'no station or URL comes from the query string');
    const real = globalThis.fetch, realNow = Date.now;
    try {
        Date.now = () => NOW;
        const { default: handler } = await import('../api/bz/ground.js');
        const planted = plantedGround({ nowMs: NOW, siAtMs: PRED.time + 360e3 });
        const dstRows = [['time_tag', 'dst'], ...Array.from({ length: 24 }, (_, i) => [new Date(NOW - (23 - i) * 3600e3).toISOString().slice(0, 13).replace('T', ' ') + ':00:00', String(-15 - i)])];
        const serve = (pl, omit = []) => async (u) => {
            const s = String(u);
            const g = usgsResponder(pl)(s);
            if (g) return omit.includes('usgs') ? new Response('down', { status: 503 }) : g;
            if (s.includes('kyoto-dst') && !omit.includes('dst')) return Response.json(dstRows);
            if (s.includes('rtsw_mag_1m') && !omit.includes('l1')) return Response.json(W.f.mag);
            if (s.includes('rtsw_wind_1m') && !omit.includes('l1')) return Response.json(W.f.wind);
            if (s.includes('ephemerides') && !omit.includes('l1')) return Response.json(W.f.eph);
            return new Response('no', { status: 404 });
        };
        globalThis.fetch = serve(planted);
        const full = await (await handler(new Request('https://x.test/api/bz/ground'))).json();
        assert.equal(full.freshness, 'fresh');
        assert.equal(full.data.ground.stations.length, 14);
        assert.equal(full.data.ground.timing_score.status, 'scored');
        assert.equal(full.data.ring_current.measured.dst_nt, -38);
        assert.ok(full.data.ring_current.model);
        const sum = await (await handler(new Request('https://x.test/api/bz/ground?summary=1'))).json();
        assert.ok(JSON.stringify(sum).length < 6500, `the summary is ${JSON.stringify(sum).length} bytes`);
        assert.equal(sum.data.ground.stations[0].pulsation_rms_nt, undefined);

        // Two stations down: dropouts, named, the rest carry on.
        globalThis.fetch = serve(plantedGround({ nowMs: NOW, drop: ['GUA', 'SJG'] }));
        const two = await (await handler(new Request('https://x.test/api/bz/ground?summary=1'))).json();
        assert.equal(two.data.ground.stations_total, 12);
        assert.equal(two.freshness, 'stale');
        assert.ok(two.reasons.includes('stations_down:GUA,SJG'));
        assert.deepEqual(two.upstream.usgs.failures, { 'fast:http_404': 2, 'slow:http_404': 2 }, 'each failure is described, not just counted');
        assert.equal(two.upstream.usgs.coordinates_from, 'metadata.station.geometry.coordinates', 'and the route says where it found the positions');
        assert.equal(two.upstream.usgs.concurrency, 6);

        globalThis.fetch = serve(planted, ['l1', 'dst']);
        const noL1 = await (await handler(new Request('https://x.test/api/bz/ground?summary=1'))).json();
        assert.deepEqual(noL1.reasons, ['no_arrived_wind', 'dst_unavailable']);
        assert.equal(noL1.data.ground.timing_score.status, 'no_wind');
        assert.ok(noL1.data.ground.dbdt.peak_nt_s > 1, 'the measurement survives the L1 chain being down');
        assert.equal(noL1.data.ring_current, null);

        globalThis.fetch = serve(planted, ['usgs']);
        const dead = await handler(new Request('https://x.test/api/bz/ground'));
        assert.equal(dead.status, 200);
        const db = await dead.json();
        assert.equal(db.freshness, 'expired');
        assert.equal(db.reasons[0], 'no_ground_station');
        assert.deepEqual(db.upstream.usgs.failures, { 'fast:http_503': 14, 'slow:http_503': 14 });
        assert.ok(db.data.ring_current.measured, 'Dst is still reported when the magnetometers are down');
    } finally { globalThis.fetch = real; Date.now = realNow; }
    {
        const { mapLimit } = await import('../api/_lib/bz-ground-fetch.js');
        let live = 0, peak = 0;
        const tasks = Array.from({ length: 28 }, (_, i) => async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 2)); live--; return i; });
        assert.deepEqual(await mapLimit(tasks, 6), Array.from({ length: 28 }, (_, i) => i), 'results stay in order');
        assert.equal(peak, 6, 'never more than six requests in flight');
    }
    ok('route: 14 stations at two cadences; dropouts named; L1 down keeps the measurement; USGS down ⇒ expired');
}

console.log(`\nbz-ground: ${checks} checks passed`);
