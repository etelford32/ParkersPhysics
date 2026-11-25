/**
 * paleo-rotations.mjs — the gate for js/paleo/rotations.js and the baked
 * Müller et al. 2019 plate model (data/paleo/, scripts/build-paleo-model.py).
 *
 * The kernel is checked four ways:
 *   1. IDENTITIES — every file row reproduced exactly, slerp on the geodesic,
 *      round trips, rigid distances, refusals;
 *   2. the model's own CROSSOVERS, measured (two unsynchronised ones in the
 *      Indian Ocean are pinned as found);
 *   3. an INDEPENDENT DATASET — the model's last few Myr of relative motion
 *      against Bird's PB2002 present-day Euler poles (data/earth-interior/),
 *      a different model built from different data, with the sign flipped as
 *      the negative control;
 *   4. the REFERENCE IMPLEMENTATION — pyGPlates (EarthByte's own library) run
 *      on the same files by scripts/paleo_oracle.py: every plate's total
 *      rotation at 16 ages, its refusals, the plate partition of 4000 points
 *      (js/paleo/plates.js) and the Chicxulub sites at 66 Ma.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as PR from '../js/paleo/rotations.js';
import * as PB from '../js/earth-interior/plates.js';
import * as PL from '../js/paleo/plates.js';
import { PALEO_SITES } from '../js/chicxulub/paleo-sites.js';

let checks = 0, failed = 0;
const ok = (c, m) => { checks++; if (!c) failed++; console.log(`  ${c ? '✓' : '✗'} ${m}`); };
const section = (t) => console.log(`\n${t}`);
const load = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const rot = load('../data/paleo/muller2019-rotations.json');
const { sites } = load('../data/paleo/muller2019-sites.json');
const coast = load('../data/paleo/muller2019-coastlines.json');
const M = PR.createModel(rot);
// angle of the rotation between two quaternions, by atan2 (acos near 1 loses half the digits)
const qAngle = (a, b) => { const d = PR.quatMul(PR.quatConj(a), b); return 2 * Math.atan2(Math.hypot(d[1], d[2], d[3]), Math.abs(d[0])) * 180 / Math.PI; };

section('1. the bake');
ok(rot.meta.licence === 'CC BY-SA 4.0' && /^[0-9a-f]{64}$/.test(rot.meta.sha256), 'licence and the pinned archive hash travel with the data');
ok(rot.sequences.length > 900 && rot.sequences.every(([m, f, r]) => m !== 999 && Number.isInteger(f) && r.every((x) => x.length === 4)), `${rot.sequences.length} sequences, metadata rows (plate 999) dropped`);
ok(coast.lines.length > 1000 && /NOT palaeo-shorelines/.test(coast.meta.note), `${coast.lines.length} coastline parts, labelled as today's shorelines carried back`);
ok(sites.chicxulub.plate === 2004 && sites.beloc.plate === 2048 && sites.beloc.hits.length === 2 && sites.beloc.rule === 'smallest polygon',
    'crater on the Yucatán block (2004); Beloc in two overlapping polygons, the smaller terrane taken and both recorded');

section('2. identities');
{
    let rows = 0, worst = 0;
    for (const [moving, , R] of rot.sequences) {
        for (const [age, lat, lon, ang] of R) {
            const r = M.relative(moving, age);
            if (!r || r.sequence.rows[0].lat === undefined) continue;
            if (r.sequence.fixed !== rot.sequences.find((s) => s[0] === moving && s[2].some((x) => x[0] === age && x[1] === lat && x[2] === lon && x[3] === ang))?.[1]) continue;   // shadowed by an earlier sequence at a crossover
            worst = Math.max(worst, qAngle(r.q, PR.quatFromPole(lat, lon, ang))); rows++;
        }
    }
    ok(rows > 4000 && worst < 1e-9, `every row the model selects is reproduced exactly at its own age (${rows} rows, worst ${worst.toExponential(1)}°)`);
    // slerp: the midpoint is half-way along the geodesic between two rows
    const seq = rot.sequences.find((s) => s[0] === 101);
    const [a, b] = [seq[2][6], seq[2][7]], mid = (a[0] + b[0]) / 2;
    const qa = PR.quatFromPole(a[1], a[2], a[3]), qb = PR.quatFromPole(b[1], b[2], b[3]), qm = M.relative(101, mid).q;
    ok(Math.abs(qAngle(qa, qm) - qAngle(qm, qb)) < 1e-9 && Math.abs(qAngle(qa, qm) + qAngle(qm, qb) - qAngle(qa, qb)) < 1e-9, 'interpolation is the geodesic in rotation space (midpoint equidistant, path additive)');
    // present day: every site is where it is today
    ok(Object.values(sites).every((s) => { const p = M.reconstruct(s.lat, s.lon, s.plate, 0); return PR.angularDistance(p.lat, p.lon, s.lat, s.lon) < 1e-9; }), 'at 0 Ma every site is where it is today');
    // round trip and rigidity
    const t = M.total(101, 66);
    const back = PR.latLonOf(PR.rotate(PR.quatConj(t.q), PR.rotate(t.q, PR.unitVector(37, -104.5))));
    ok(PR.angularDistance(back.lat, back.lon, 37, -104.5) < 1e-9, 'reconstruct then un-rotate returns the point');
    const r1 = M.reconstruct(37, -104.5, 101, 66), r2 = M.reconstruct(46, -103.4, 101, 66);
    ok(Math.abs(PR.angularDistance(r1.lat, r1.lon, r2.lat, r2.lon) - PR.angularDistance(37, -104.5, 46, -103.4)) < 1e-9, 'two points on one plate keep their distance (rigid)');
    const viaNam = M.reconstruct(21.33, -89.5, 101, 66), viaYct = M.reconstruct(21.33, -89.5, 2004, 66);
    ok(PR.angularDistance(viaNam.lat, viaNam.lon, viaYct.lat, viaYct.lon) < 1e-9, 'the Yucatán block (fixed to North America since 130 Ma) moves exactly with it at 66 Ma');
    ok(M.reconstruct(21.33, -89.5, 2004, 300) === null && M.reconstruct(0, 0, 123456, 10) === null, 'refuses an age past the model and a plate it does not contain');
    const rel = M.total(2048, 66, 101), abs = M.total(2048, 66), nam = M.total(101, 66);
    ok(qAngle(PR.quatMul(nam.q, rel.q), abs.q) < 1e-9, 'a rotation relative to another plate composes back to the absolute one');
    const b0 = PR.reconstructBearing(M, 21.33, -89.5, 45, 2004, 66), b1 = PR.reconstructBearing(M, 21.33, -89.5, 135, 2004, 66);
    ok(Math.abs(((b1 - b0 + 540) % 360) - 180 - 90) < 0.01, 'a rigid rotation turns every bearing at a point by the same angle');
}

section('3. the model\'s crossovers');
{
    const x = M.crossovers(), big = x.filter((c) => c.jumpDeg > 0.01);
    ok(x.length > 200 && big.length === 2 && big.every((c) => c.age === 45 && [663, 727].includes(c.plate)),
        `${x.length} crossovers; all but two agree to 0.01° — plates ${big.map((c) => `${c.plate} (${c.jumpDeg.toFixed(1)}°)`).join(', ')} at 45 Ma jump (Indian Ocean, measured, not ours to fix)`);
    const ours = x.filter((c) => [101, 2004, 104, 2048, 2007, 714, 715, 701].includes(c.plate));
    ok(ours.every((c) => c.jumpDeg < 1e-3), `the chains Chicxulub uses have no crossover jump (${ours.length} checked)`);
}

section('4. against an independent dataset: PB2002 present-day relative motion');
{
    const pb = PB.decodePlates(JSON.parse(zlib.gunzipSync(fs.readFileSync(new URL('../data/earth-interior/plates-pb2002.json.gz', import.meta.url)))));
    const rel = (a, b) => { const wa = PB.eulerVector(pb.byId.get(a)), wb = PB.eulerVector(pb.byId.get(b)); return [wa[0] - wb[0], wa[1] - wb[1], wa[2] - wb[2]]; };
    const pairs = [
        { m: [2007, 101], b: ['CA', 'NA'], at: [19, -80], name: 'Caribbean–North America (Cayman trough)' },
        { m: [101, 301], b: ['NA', 'EU'], at: [45, -28], name: 'North America–Eurasia (mid-Atlantic)' },
        { m: [201, 701], b: ['SA', 'AF'], at: [-20, -13], name: 'South America–Africa (mid-Atlantic)' },
    ];
    for (const p of pairs) {
        const w = M.meanVelocity(p.m[0], p.m[1], 5), v = PB.plateVelocity(w, ...p.at), vb = PB.plateVelocity(rel(...p.b), ...p.at);
        const daz = Math.abs(((v.azimuth - vb.azimuth + 540) % 360) - 180);
        ok(daz < 10 && v.speed / vb.speed > 0.8 && v.speed / vb.speed < 1.25,
            `${p.name}: model ${v.speed.toFixed(1)} mm/yr at ${v.azimuth.toFixed(0)}°, PB2002 ${vb.speed.toFixed(1)} at ${vb.azimuth.toFixed(0)}° (Δ ${daz.toFixed(0)}°)`);
        const flipped = PB.plateVelocity(w.map((x) => -x), ...p.at);
        ok(Math.abs(((flipped.azimuth - vb.azimuth + 540) % 360) - 180) > 150, '  negative control: the reconstruction rotation NOT inverted points the opposite way');
    }
}

section('5. what Chicxulub gets');
{
    const c = M.reconstruct(sites.chicxulub.lat, sites.chicxulub.lon, 2004, 66.04);
    ok(Math.abs(c.lat - 21.95) < 0.01 && Math.abs(c.lon + 74.53) < 0.01, `crater at 66.04 Ma: ${c.lat.toFixed(2)}°N ${(-c.lon).toFixed(2)}°W in the mantle frame (today 21.33°N 89.50°W) — measured, pinned`);
    const b = M.reconstruct(sites.beloc.lat, sites.beloc.lon, 2048, 66.04);
    const dToday = PR.angularDistance(21.33, -89.5, 18.4, -72.6) * Math.PI / 180 * 6371, d66 = PR.angularDistance(c.lat, c.lon, b.lat, b.lon) * Math.PI / 180 * 6371;
    ok(d66 < 0.7 * dToday, `Beloc: ${d66.toFixed(0)} km from the crater at 66 Ma, ${dToday.toFixed(0)} km today — the Caribbean plate has carried it east`);
}

section('6. against the reference implementation: pyGPlates');
{
    const O = load('./fixtures/paleo/pygplates-oracle.json');
    ok(/^1\./.test(O.meta.pygplates) && O.meta.rotationFile === rot.meta.file, `the oracle ran pyGPlates ${O.meta.pygplates} on the same rotation file`);
    let n = 0, worst = 0, worstAt = null, onlyUs = 0, onlyThem = 0, both = 0;
    for (const [plate, age, r] of O.rotations) {
        const t = M.total(plate, age);
        if (!r && !t) { both++; continue; }
        if (!r) { onlyUs++; continue; }       // we answer where pyGPlates refuses
        if (!t) { onlyThem++; continue; }     // we refuse where pyGPlates answers
        const a = qAngle(t.q, PR.quatFromPole(r[0], r[1], r[2]));
        n++; if (a > worst) { worst = a; worstAt = [plate, age]; }
    }
    ok(n > 12000 && worst < 5e-4, `${n} plate/age rotations agree to ${worst.toExponential(1)}° (≈ ${(worst * 111195).toFixed(0)} m; worst plate ${worstAt[0]} at ${worstAt[1]} Ma, a crossover age)`);
    ok(onlyUs === 0 && onlyThem === 0 && both > 3000, `refusals identical: ${both} plate/ages refused by both, none by only one`);
    // the crossover rule: plate 555 at 230 Ma has two sequences, and the first dead-ends (355 has no rotation)
    const c = M.candidates(555, 230);
    ok(c.length === 2 && c[0].fixed === 355 && !M.total(355, 230) && M.total(555, 230).chain[1] === 521,
        'negative control: first-sequence-wins WITHOUT fall-through refuses plate 555 at 230 Ma, which pyGPlates answers through 521');

    const plates = PL.decodePlates(load('../data/paleo/muller2019-plates.json'));
    const edge = (lat, lon, ps) => {
        let best = 1e9; const k = Math.cos(lat * Math.PI / 180);
        for (const p of ps) for (const r of p.rings) for (let i = 1; i < r.length; i++) {
            const ax = (r[i - 1][0] - lon) * k, ay = r[i - 1][1] - lat, dx = (r[i][0] - r[i - 1][0]) * k, dy = r[i][1] - r[i - 1][1], L = dx * dx + dy * dy;
            const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
            best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
        }
        return best;
    };
    let agree = 0, sameAge = 0, far = 0, ageFar = 0;
    const miss = [];
    for (const [lat, lon, id, from] of O.partition) {
        const r = PL.plateAt(plates, lat, lon);
        if ((r ? r.plate : null) === id) {
            agree++;
            if (r === null || r.fromAge === from) sameAge++;
            else if (edge(lat, lon, plates.static.filter((p) => p.plate === id)) > 2 * plates.meta.toleranceDeg) ageFar++;
        }
        else { miss.push([lat, lon, id, r && r.plate]); if (edge(lat, lon, plates.static.filter((p) => p.plate === id || p.plate === r?.plate)) > 2 * plates.meta.toleranceDeg) far++; }
    }
    const share = agree / O.partition.length;
    ok(share > 0.995 && far === 0, `plate partition: ${agree}/${O.partition.length} points (${(100 * share).toFixed(2)} %) get pyGPlates' plate; all ${miss.length} misses lie within 2× the ${plates.meta.toleranceDeg}° simplification of a boundary`);
    ok(sameAge / agree > 0.995 && ageFar === 0, `and the same piece of crust: its appearance age matches on ${sameAge}/${agree}; every other one is within 2× the simplification of a seam between two polygons of that plate`);
    // overlap order: Beloc is inside 2048 AND 973; pyGPlates takes 2048 — the highest id; the lowest-id rule would not
    const b = PL.plateAt(plates, sites.beloc.lat, sites.beloc.lon);
    ok(Object.values(O.sites).every((v, i) => v.partitionPlate === PL.plateAt(plates, Object.values(sites)[i].lat, Object.values(sites)[i].lon).plate)
        && b.hits.length === 2 && O.sites.beloc.partitionPlate === 2048 && b.hits[b.hits.length - 1].plate === 973,
        'every Chicxulub site gets pyGPlates\' plate; negative control: at Beloc (2048 over 973) the lowest-id rule would pick 973');

    let sw = 0;
    for (const [k, v] of Object.entries(O.sites)) sw = Math.max(sw, PR.angularDistance(v.lat, v.lon, PALEO_SITES[k].at66.latDeg, PALEO_SITES[k].at66.lonDeg));
    ok(sw < 2e-4, `the Chicxulub sites at 66.04 Ma match pyGPlates to ${sw.toExponential(1)}° (the site table rounds to 1e-4°)`);
}

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) process.exit(1);
