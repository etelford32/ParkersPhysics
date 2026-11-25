/**
 * deep-time-earth.mjs — the gate for js/deep-time/page-model.js, the numbers
 * deep-time-earth.html prints. Every position it reports must be the plate
 * kernel's (js/paleo/rotations.js, itself gated against pyGPlates in
 * tests/paleo-rotations.mjs); this file checks the page model asks the right
 * questions and says no where the model has no answer.
 */
import fs from 'node:fs';
import * as PR from '../js/paleo/rotations.js';
import * as PL from '../js/paleo/plates.js';
import * as M from '../js/deep-time/page-model.js';
import { PALEO_SITES } from '../js/chicxulub/paleo-sites.js';
import { measureAgainstOracle } from './helpers/paleo-oracle.mjs';

let checks = 0, failed = 0;
const ok = (c, m) => { checks++; if (!c) failed++; console.log(`  ${c ? '✓' : '✗'} ${m}`); };
const section = (t) => console.log(`\n${t}`);
const load = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const model = PR.createModel(load('../data/paleo/muller2019-rotations.json'));
const plates = PL.decodePlates(load('../data/paleo/muller2019-plates.json'));
const m21 = PR.createModel(load('../data/paleo/merdith2021-rotations.json'));
const plates21 = PL.decodePlates(load('../data/paleo/merdith2021-plates.json'));

section('1. the bake the page reads');
ok(plates.static.length > 2000 && plates.continents.length > 500, `${plates.static.length} static polygons, ${plates.continents.length} continental polygons`);
ok(plates.meta.licence === 'CC BY-SA 4.0' && /not palaeo-shorelines/.test(plates.meta.note), 'licence travels with the polygons; continents are labelled as crust outlines, not shorelines');
ok(plates.static.every((p) => p.rings.every((r) => r.length >= 4 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1])), 'every ring decodes closed (the delta code round-trips)');

section('2. what a point report says');
{
    const c = M.CHICXULUB, r = M.pointReport(model, plates, c.lat, c.lon, c.ageMa);
    const s = PALEO_SITES.chicxulub.at66;
    ok(r.ok && r.plate === 2004 && PR.angularDistance(r.then.lat, r.then.lon, s.latDeg, s.lonDeg) < 2e-4, `Chicxulub at 66.04 Ma: ${M.formatLatLon(r.then)} — the Chicxulub page's site table, same kernel`);
    ok(r.continental && r.band === 'tropics', 'Yucatán is continental crust and was in the tropics');
    const today = M.pointReport(model, plates, c.lat, c.lon, 0);
    ok(today.ok && today.movedKm < 1e-6, 'at 0 Ma a point is where it is today (moved 0 km)');
    // the mid-Atlantic ridge axis: crust there is young, so it has no position long ago
    const ridge = M.pointReport(model, plates, 0.5, -24.0, 100);
    ok(!ridge.ok && ridge.reason === 'not-formed' && ridge.fromAge < 20, `ocean floor near the mid-Atlantic ridge (formed ${ridge.fromAge} Ma) is reported NOT FORMED at 100 Ma, never placed`);
    const old = M.pointReport(model, plates, 40, -100, 300);
    ok(!old.ok && old.reason === 'beyond-model', 'past 250 Ma the report refuses (the model ends there)');
}

section('3. tracks and clicks');
{
    const t = M.trackSamples(model, plates, 51.51, -0.13, 1);
    ok(t && t.points[0].age === 0 && t.points.at(-1).age === t.maxAge && t.points.every((p, i) => !i || p.age > t.points[i - 1].age), `London's track: ${t.points.length} samples, today → ${t.maxAge} Ma, ages increasing`);
    ok(t.points.every((p) => { const q = model.reconstruct(51.51, -0.13, t.plate, p.age); return PR.angularDistance(q.lat, q.lon, p.lat, p.lon) < 1e-9; }), 'every track sample IS the kernel\'s reconstruction (nothing interpolated in the page model)');
    const young = M.trackSamples(model, plates, 0.5, -24.0, 1);
    ok(young.maxAge < 20 && young.points.at(-1).age === young.maxAge, `a young-crust track stops where the crust formed (${young.maxAge} Ma)`);
    // a click inverts exactly: reconstruct → unit vector → presentPointOf → today's point
    let worst = 0;
    for (const [lat, lon] of [[51.51, -0.13], [-33.87, 151.21], [21.33, -89.5], [-1.29, 36.82], [64.15, -21.94]]) {
        const h = PL.plateAt(plates, lat, lon);
        for (const age of [10, 66.04, 150, 249]) {
            if (age > M.reachOf(model, h).maxAge) continue;
            const q = model.reconstruct(lat, lon, h.plate, age), back = M.presentPointOf(model, h.plate, PR.unitVector(q.lat, q.lon), age);
            worst = Math.max(worst, PR.angularDistance(lat, lon, back.lat, back.lon));
        }
    }
    ok(worst < 1e-9, `a click at any age maps back to its present-day point (worst ${worst.toExponential(1)}°)`);
    const bad = model.reconstruct(51.51, -0.13, 301, 100);
    ok(PR.angularDistance(bad.lat, bad.lon, 51.51, -0.13) > 5, 'negative control: without inverting the rotation the click lands > 5° from the point it hit');
}

section('4. display furniture');
{
    ok(M.PERIODS.every((p, i) => p.from > p.to && (!i || Math.abs(M.PERIODS[i - 1].from - p.to) < 1e-9)) && M.PERIODS.at(-1).from > M.AGE_MAX && M.PERIODS_VERIFIED === false,
        'periods tile 0 → past 250 Ma with no gap, and are flagged as written from memory');
    const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const L = [0, 5, 20, 40, 80, 120, 160, 200].map((a) => lum(M.crustColor(a)));
    ok(L.every((v, i) => !i || v < L[i - 1]), 'seafloor ramp: older is always darker up to 200 Myr, then held (one hue, monotone lightness)');
    const ch = M.latitudeChart(M.trackSamples(model, plates, -33.87, 151.21, 1), 340, 170);
    ok(ch && ch.lo <= -60 && ch.hi >= -30 && /^M[\d.]+,[\d.]+(L[\d.]+,[\d.]+)+$/.test(ch.path), `Sydney's latitude chart spans ${ch.lo}° to ${ch.hi}° (it was far south: Australia moved north)`);
    ok(M.formatAge(0) === 'Today' && M.formatAge(66.04) === '66 million years ago' && M.formatLon(-89.5) === '89.5°W' && M.formatLon(190) === '170.0°W', 'formatting');
}

section('5. what the page says about the pyGPlates check');
{
    // re-measured with the SAME helper the plate gate uses; the page's printed numbers must be these
    const C = M.ORACLE_CHECK;
    const runs = {
        muller2019: [model, plates, load('./fixtures/paleo/pygplates-oracle.json')],
        merdith2021: [m21, plates21, load('./fixtures/paleo/pygplates-oracle-merdith2021.json')],
    };
    for (const [id, [mdl, pl, O]] of Object.entries(runs)) {
        const got = measureAgainstOracle(mdl, pl, O), p = C[id];
        const near = (a, b) => b > 0 && a <= b * 1.05 && a >= b * 0.5;
        ok(O.meta.pygplates === C.pygplates && got.off === p.off && near(got.offDeg, p.offDeg) && got.at === p.at && near(got.atDeg, p.atDeg)
            && got.refusedBoth === p.refusedBoth && got.points === p.points && got.agree === p.agree && got.atAllowed === got.at,
            `${id}: printed ${p.off} + ${p.at} rotations (${p.offDeg} / ${p.atDeg}°), ${p.refusedBoth} refusals, ${p.agree}/${p.points} plates — measured ${got.off} + ${got.at} (${got.offDeg.toExponential(1)} / ${got.atDeg.toExponential(1)}°), ${got.refusedBoth}, ${got.agree}/${got.points}`);
    }
    const O = load('./fixtures/paleo/pygplates-oracle.json');
    let sw = 0;
    for (const [k, v] of Object.entries(O.sites)) sw = Math.max(sw, PR.angularDistance(v.lat, v.lon, PALEO_SITES[k].at66.latDeg, PALEO_SITES[k].at66.lonDeg));
    ok(sw <= C.sitesDeg * 1.05 && sw >= C.sitesDeg * 0.5, `printed: sites within ${C.sitesDeg}° — measured ${sw.toExponential(2)}°`);
}

section('6. the second model, and what the comparison may claim');
{
    const A = { model, plates }, B = { model: m21, plates: plates21 };
    const c = M.CHICXULUB, cmp = M.compareModels(A, B, c.lat, c.lon, c.ageMa);
    ok(cmp.a.ok && cmp.b.ok && cmp.a.plate === 2004 && cmp.b.plate === 205,
        `each model puts Chicxulub on ITS OWN plate (Müller ${cmp.a.plate}, Merdith ${cmp.b.plate}) — the comparison never assumes the ids match`);
    ok(cmp.dLatDeg > 2.5 && cmp.dLatDeg < 3.5, `at 66 Ma Merdith (palaeomagnetic) puts the crater ${cmp.dLatDeg.toFixed(2)}° further north than Müller (mantle): ${M.formatLat(cmp.b.then.lat)} vs ${M.formatLat(cmp.a.then.lat)}, ${Math.round(cmp.apartKm)} km apart`);
    const now = M.compareModels(A, B, 51.51, -0.13, 0);
    ok(now.dLatDeg === 0 && now.apartKm < 1e-6, 'today both models agree exactly (they share the present)');
    const young = M.compareModels(A, B, 0.5, -24.0, 100);
    ok(!young.a.ok && young.dLatDeg === null, 'where a model has no position (crust not formed), there is no difference to report — never a number');
    const sample = M.spreadSample(A, B, 1500);
    const s0 = M.spreadAt(sample, A, B, 0), s66 = M.spreadAt(sample, A, B, 66), s200 = M.spreadAt(sample, A, B, 200);
    ok(sample.length > 300 && s0.medianDLat === 0 && s0.medianKm < 1e-6, `${sample.length} sampled continental points; at 0 Ma the spread is exactly zero`);
    ok(s66.medianDLat > 0.5 && s200.medianDLat > s66.medianDLat * 0.5 && s66.n > 300 && s200.n > 300,
        `the models' continents differ by a median ${s66.medianDLat.toFixed(1)}° in latitude at 66 Ma (90th pct ${s66.p90DLat.toFixed(1)}°) and ${s200.medianDLat.toFixed(1)}° at 200 Ma (${s200.p90DLat.toFixed(1)}°)`);
    const ch = M.latitudeChart(M.trackSamples(model, plates, c.lat, c.lon, 1), 340, 170, { second: M.trackSamples(m21, plates21, c.lat, c.lon, 1) });
    ok(ch.path2 && ch.lo <= Math.min(cmp.a.then.lat, cmp.b.then.lat) && /^M/.test(ch.path2), 'the latitude chart carries both tracks on ONE axis (the range covers both)');
    // the longitude alignment: a planted pure turn about the pole is recovered exactly, and it changes no latitude
    const planted = [[{ lat: 10, lon: 20 }, { lat: 10, lon: 37 }], ...Array.from({ length: 30 }, (_, i) => [{ lat: i - 15, lon: i * 7 - 100 }, { lat: i - 15, lon: i * 7 - 83 }])];
    ok(Math.abs(M.longitudeShift(planted) - 17) < 1e-9 && M.longitudeShift(planted.slice(0, 5)) === null, 'longitudeShift recovers a planted 17° turn about the pole, and refuses a thin sample');
    ok(Math.abs(M.longitudeShift([...Array(25)].map((_, i) => [{ lat: 0, lon: 175 }, { lat: 0, lon: -175 }])) - 10) < 1e-9, 'it is a CIRCULAR mean: 175°E → 175°W is a 10° shift, not −350°');
    const cmp66 = M.compareModels(A, B, c.lat, c.lon, c.ageMa, s66.lonShiftDeg);
    ok(s66.lonShiftDeg != null && Math.abs(s66.lonShiftDeg) > 5 && cmp66.apartKmAligned < cmp66.apartKm && cmp66.dLatDeg === cmp.dLatDeg,
        `at 66 Ma the second model sits ${s66.lonShiftDeg.toFixed(1)}° of longitude off the first; aligned, Chicxulub is ${Math.round(cmp66.apartKmAligned)} km apart instead of ${Math.round(cmp66.apartKm)}, its latitude difference unchanged`);
    ok(s66.medianKmAligned < s66.medianKm, `aligned, the continents' median separation at 66 Ma falls from ${Math.round(s66.medianKm)} to ${Math.round(s66.medianKmAligned)} km — most of the raw distance was the longitude convention`);
    const table = M.lonShiftTable(sample, A, B, 2);
    ok(table.ages.length === 126 && Math.abs(M.shiftAt(table, 0)) < 1e-9 && Math.abs(M.shiftAt(table, 66) - M.spreadAt(sample, A, B, 66).lonShiftDeg) < 0.2,
        'the shift table is zero today and its interpolation lands within 0.2° of the exact shift at 66 Ma');
    ok(M.SECOND_MODEL.files.every((f) => fs.existsSync(new URL('../' + f, import.meta.url))) && fs.existsSync(new URL('../' + M.SECOND_MODEL.coastFile, import.meta.url)), 'the second model\'s files exist where the page fetches them');
}

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) process.exit(1);
