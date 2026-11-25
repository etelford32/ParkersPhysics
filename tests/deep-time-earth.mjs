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

let checks = 0, failed = 0;
const ok = (c, m) => { checks++; if (!c) failed++; console.log(`  ${c ? '✓' : '✗'} ${m}`); };
const section = (t) => console.log(`\n${t}`);
const load = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const model = PR.createModel(load('../data/paleo/muller2019-rotations.json'));
const plates = PL.decodePlates(load('../data/paleo/muller2019-plates.json'));

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
    // re-measure from the fixture; the page's printed numbers must be these
    const O = load('./fixtures/paleo/pygplates-oracle.json');
    let n = 0, worst = 0, refused = 0;
    for (const [plate, age, r] of O.rotations) {
        const t = model.total(plate, age);
        if (!r) { if (!t) refused++; continue; }
        const q = PR.quatFromPole(r[0], r[1], r[2]), d = PR.quatMul(PR.quatConj(q), t.q);
        worst = Math.max(worst, 2 * Math.atan2(Math.hypot(d[1], d[2], d[3]), Math.abs(d[0])) * 180 / Math.PI); n++;
    }
    const agree = O.partition.filter(([lat, lon, id]) => (PL.plateAt(plates, lat, lon)?.plate ?? null) === id).length;
    const C = M.ORACLE_CHECK;
    ok(C.pygplates === O.meta.pygplates && C.rotations === n && C.refusals === refused && worst <= C.worstDeg * 1.05 && worst >= C.worstDeg * 0.5,
        `printed: ${C.rotations} rotations within ${C.worstDeg}°, ${C.refusals} refusals — measured: ${n}, ${worst.toExponential(2)}°, ${refused}`);
    ok(C.points === O.partition.length && C.partitionAgree === agree, `printed: ${C.partitionAgree}/${C.points} plate lookups agree — measured: ${agree}`);
    let sw = 0;
    for (const [k, v] of Object.entries(O.sites)) sw = Math.max(sw, PR.angularDistance(v.lat, v.lon, PALEO_SITES[k].at66.latDeg, PALEO_SITES[k].at66.lonDeg));
    ok(sw <= C.sitesDeg * 1.05 && sw >= C.sitesDeg * 0.5, `printed: sites within ${C.sitesDeg}° — measured ${sw.toExponential(2)}°`);
}

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) process.exit(1);
