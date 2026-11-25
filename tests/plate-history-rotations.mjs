/**
 * tests/plate-history-rotations.mjs — js/plate-history/rotations.js against pygplates 1.0.
 *
 * The oracle (tests/fixtures/plate-history/pygplates-oracle.json, written by
 * scripts/plate_history_oracle.py from the SAME pinned model zip) is pygplates' own answer; our
 * kernel is an independent implementation of the PLATES4 hierarchy read from the BAKED
 * data/plate-history/rotations.json.gz. Each rule that was once wrong has a negative control
 * that must FAIL:
 *   • slerp, not linear interpolation of quaternions;
 *   • a BROKEN circuit holds the plate at identity (it is not "relative to the anchor");
 *   • the 999 comment lines inside a sequence do not end it (Laurentia 1480–1600 Ma — checked
 *     on the baked data: the sequence must span the comment gap).
 *
 * Run: node tests/plate-history-rotations.mjs
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRotationModel, qAngleBetween, unit, qRotate } from '../js/plate-history/rotations.js';
import { decodeShapes, existsAt } from '../js/plate-history/frames.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gzJson = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, f))).toString('utf8'));
const rotDoc = gzJson('data/plate-history/rotations.json.gz');
const oracle = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/fixtures/plate-history/pygplates-oracle.json'), 'utf8'));

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const DEG = 180 / Math.PI;

function worstTotal(model, rows = oracle.totals) {
    let worst = 0, at = null;
    for (const r of rows) {
        const d = qAngleBetween(model.total(r.p, r.t), r.q) * DEG;
        if (d > worst) { worst = d; at = r; }
    }
    return { worst, at };
}

// 1. Total rotations, every pair.
const model = createRotationModel(rotDoc);
{
    const { worst, at } = worstTotal(model);
    check(worst < 1e-7, `total rotation of ${oracle.totals.length} (plate, time) pairs within 1e-7° of pygplates (worst ${worst.toExponential(2)}° at ${at?.p} ${at?.t} Ma)`);
}

// 2. Negative control: linear (nlerp) interpolation.
{
    const { worst } = worstTotal(createRotationModel(rotDoc, { interp: 'nlerp' }));
    check(worst > 1e-4, `control — nlerp interpolation misses by ${worst.toExponential(2)}° (must exceed 1e-4°)`);
}

// 3. Negative control: a broken circuit treated as the anchor.
{
    const { worst } = worstTotal(createRotationModel(rotDoc, { brokenCircuit: 'skip' }));
    check(worst > 1, `control — "skip a broken ancestor" misses by ${worst.toFixed(2)}° (must exceed 1°)`);
}

// 4. The 999 comment gap: Laurentia's 101→000 sequence must SPAN 1480 → 1600 Ma in the bake.
{
    const spans = rotDoc.seqs.filter((s) => s.m === 101 && s.f === 0).some((s) => Math.min(...s.t) <= 1480 && Math.max(...s.t) >= 1600);
    check(spans, 'baked Laurentia (101→000) sequence spans the commented 1480–1600 Ma poles');
    const pins = oracle.totals.filter((r) => [101, 201, 714].includes(r.p) && r.t > 1480 && r.t < 1600);
    const { worst } = worstTotal(model, pins);
    check(pins.length >= 15 && worst < 1e-7, `${pins.length} pinned rotations inside the comment gap match pygplates (worst ${worst.toExponential(2)}°)`);
    // Control: cut the sequence at the gap, as the first parser did.
    const cut = { anchor: 0, seqs: rotDoc.seqs.flatMap((s) => {
        if (!(s.m === 101 && s.f === 0 && Math.min(...s.t) <= 1480 && Math.max(...s.t) >= 1600)) return [s];
        const k = s.t.findIndex((t) => t > 1480);
        const part = (a, b) => ({ m: s.m, f: s.f, t: s.t.slice(a, b), lat: s.lat.slice(a, b), lon: s.lon.slice(a, b), a: s.a.slice(a, b) });
        return [part(0, k), part(k)];
    }) };
    const w2 = worstTotal(createRotationModel(cut), pins).worst;
    check(w2 > 1, `control — a sequence cut at the comment lines misses by ${w2.toFixed(1)}° (must exceed 1°)`);
}

// 5. Velocities (stage t+1 → t), km/Myr ≡ mm/yr.
{
    let worst = 0;
    for (const v of oracle.velocities) {
        const u = model.velocity(v.p, v.t, v.lat, v.lon);
        worst = Math.max(worst, Math.hypot(u.east - v.east, u.north - v.north));
    }
    check(worst < 0.01, `plate velocity at ${oracle.velocities.length} points within 0.01 mm/yr of pygplates (worst ${worst.toExponential(2)})`);
    // Control: the stage the other way round (t → t+1) flips every vector.
    let flipped = 0;
    for (const v of oracle.velocities) {
        const u = model.velocity(v.p, v.t, v.lat, v.lon);
        if (Math.hypot(v.east, v.north) > 1 && (-u.east * v.east - u.north * v.north) > 0) flipped++;
    }
    check(flipped === 0, 'no velocity points backwards in time (sign of the stage rotation)');
}

// 6. End to end: whole continent FEATURES reconstructed by pygplates vs our baked polygon
//    carried by our kernel — the plate id, the valid-time window and the composition. Matched
//    on each ring's FIRST vertex (the baker's simplification always keeps it; 0.01° quantum).
{
    const shapes = decodeShapes(gzJson('data/plate-history/continents.json.gz')).continents;
    const ang = (a, b) => { const u = unit(a[0], a[1]), v = unit(b[0], b[1]); return Math.atan2(Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]), u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) * DEG; };
    // Plate, name, begin time and first vertex: a few features share all but the begin time.
    const find = (r) => shapes.find((s) => s.plate === r.p && s.name === r.name && s.begin === r.begin && ang([s.pts[0], s.pts[1]], r.present) < 0.01);
    let matched = 0, alive = 0, worst = 0, worstCtl = 0;
    for (const r of oracle.reconstructed) {
        const s = find(r);
        if (!s) continue;
        matched++;
        if (existsAt(s, r.t)) alive++;
        const q = model.total(s.plate, r.t), v = qRotate(q, unit(s.pts[0], s.pts[1]));
        const at = [Math.asin(v[2]) * DEG, Math.atan2(v[1], v[0]) * DEG];
        worst = Math.max(worst, ang(at, r.at));
        worstCtl = Math.max(worstCtl, ang([s.pts[0], s.pts[1]], r.at));
    }
    check(matched === oracle.reconstructed.length, `${matched}/${oracle.reconstructed.length} reconstructed features matched to a baked polygon by plate, name, begin time and first vertex`);
    check(alive === matched, `every one exists at its reconstruction time under our valid-time rule (${alive}/${matched})`);
    check(worst < 0.01, `reconstructed first vertices within 0.01° of pygplates (worst ${worst.toExponential(2)}°; 0.01° is the bake's coordinate quantum)`);
    check(worstCtl > 20, `control — unreconstructed polygons miss by ${worstCtl.toFixed(1)}° (must exceed 20°)`);
    let absentMatched = 0, wronglyAlive = 0;
    for (const r of oracle.absent) {
        const s = find(r);
        if (!s) continue;
        absentMatched++;
        if (existsAt(s, r.t)) wronglyAlive++;
    }
    check(absentMatched >= 0.9 * oracle.absent.length && wronglyAlive === 0,
        `${absentMatched}/${oracle.absent.length} features pygplates omits at their time are absent in ours too (${wronglyAlive} wrongly present)`);
}

// 7. Sanity: identity at the anchor and for an unknown plate; a rotation is a rotation.
{
    check(qAngleBetween(model.total(0, 500), [1, 0, 0, 0]) === 0, 'anchor plate 0 is the identity');
    check(qAngleBetween(model.total(424242, 100), [1, 0, 0, 0]) === 0, 'an unknown plate is held at the identity');
    const v = qRotate(model.total(101, 250), unit(40, -100));
    check(Math.abs(Math.hypot(...v) - 1) < 1e-12, 'rotated vectors stay unit length');
}

console.log(fails ? `\n${fails} FAILED` : '\nall plate-history rotation gates passed');
process.exit(fails ? 1 : 0);
