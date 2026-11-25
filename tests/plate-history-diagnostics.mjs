/**
 * tests/plate-history-diagnostics.mjs — what the kernel MEASURES, held to oracles we did not write.
 *
 *  1. Merdith et al. (2021) SM3a/SM3b — their published ridge length, trench length, crust
 *     production and consumption every 1 Myr, 0–1000 Ma. NOTE the version gap: those tables
 *     were computed on THEIR v1.0 (Sept 2020); we bake Cao et al.'s 1.8 Ga model, which carries
 *     the 2023 corrections (transforms relabelled as subduction, some OCEANIC plate velocities
 *     and ridge layouts changed — ReadMe_SM2_MER21++_alterations.txt). Lengths therefore agree
 *     closely and rates less closely; the bounds below are the measured agreement with margin,
 *     and each has a negative control that must fail.
 *  2. Bird (2003) PB2002 — an INDEPENDENT present-day boundary model (baked for the Inner Earth
 *     page): our 0 Ma ridges and trenches must lie on Bird's spreading ridges and subduction
 *     zones; a 10°-rotated control must not.
 *  3. Rotation seams: no frame's RMS plate speed exceeds 250 mm/yr (the fastest present-day
 *     plates move ~100); the GPlates-naive stage across a seam (the control) does.
 *  4. The supercontinent index's peaks fall inside the literature windows for Pangaea, Rodinia
 *     and Nuna (js/plate-history/geotime.js, unverified, wide) — a PLAUSIBILITY check; the
 *     index knows no names or dates. Control: continents left unreconstructed are flat.
 *  5. data/plate-history/series.json is exactly what the kernel computes now (not stale).
 *
 * Run: node tests/plate-history-diagnostics.mjs
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRotationModel, unit, qMul, qConj, qEulerVector } from '../js/plate-history/rotations.js';
import { decodeFrames, decodeShapes, boundariesAt, shapesAt, rotateLine } from '../js/plate-history/frames.js';
import { boundaryStats, speedStats, supercontinentIndex } from '../js/plate-history/diagnostics.js';
import { LITERATURE_SUPERCONTINENTS } from '../js/plate-history/geotime.js';
import { buildSeries } from '../scripts/build-plate-history-series.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gzJson = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ROOT, f))).toString('utf8'));
const rotDoc = gzJson('data/plate-history/rotations.json.gz');
const framesDoc = gzJson('data/plate-history/frames.json.gz');
const shapesDoc = gzJson('data/plate-history/continents.json.gz');
const model = createRotationModel(rotDoc);
const fr = decodeFrames(framesDoc);
const { continents } = decodeShapes(shapesDoc);

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
const corr = (x, y) => {
    const n = x.length, mx = x.reduce((p, q) => p + q) / n, my = y.reduce((p, q) => p + q) / n;
    let s = 0, sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { s += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
    return s / Math.sqrt(sx * sy);
};

// ── 5 first: the committed series is the kernel's (everything below reads it) ──
const fresh = buildSeries({ rotDoc, framesDoc, shapesDoc });
const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/plate-history/series.json'), 'utf8'));
check(JSON.stringify(fresh.rows) === JSON.stringify(committed.rows), 'data/plate-history/series.json is exactly what the kernel computes (run scripts/build-plate-history-series.mjs if not)');
const S = fresh.rows;

// ── 1. Merdith SM3 tables ──
const csv = (f) => fs.readFileSync(path.join(ROOT, 'data/plate-history/published', f), 'utf8').trim().split('\n').slice(1).map((l) => l.split(',').map(Number));
const sub = new Map(csv('SM3a_SUB_stats.csv').map((r) => [r[0], r]));
const mor = new Map(csv('SM3b_MOR_stats.csv').map((r) => [r[0], r]));
const rows = S.filter((r) => r.t <= 1000 && sub.has(r.t) && mor.has(r.t));
function compare(name, ours, theirs, { ratio: [lo, hi], minCorr }) {
    const a = rows.map(ours), b = rows.map(theirs);
    const m = median(a.map((x, i) => x / b[i])), c = corr(a, b);
    check(m >= lo && m <= hi && c >= minCorr, `${name}: median ratio to Merdith ${m.toFixed(3)} (in [${lo}, ${hi}]), correlation ${c.toFixed(3)} (≥ ${minCorr}) over ${rows.length} frames`);
    return { m, c };
}
compare('ridge length', (r) => r.ridgeKm, (r) => mor.get(r.t)[1], { ratio: [0.92, 1.08], minCorr: 0.9 });
compare('trench length', (r) => r.trenchKm, (r) => sub.get(r.t)[1], { ratio: [0.92, 1.08], minCorr: 0.75 });
compare('crust consumption', (r) => r.consumptionKm2PerMa, (r) => sub.get(r.t)[2], { ratio: [0.9, 1.1], minCorr: 0.9 });
compare('crust production', (r) => r.productionKm2PerMa, (r) => mor.get(r.t)[2], { ratio: [0.75, 1.0], minCorr: 0.65 });
{   // Controls.
    const a = rows.map((r) => r.ridgeKm + r.ridgeTransformKm), b = rows.map((r) => mor.get(r.t)[1]);
    const m = median(a.map((x, i) => x / b[i]));
    check(m > 1.1, `control — counting transform offsets as ridge reads ${m.toFixed(3)}× Merdith (must exceed 1.1)`);
    const lag = 20; // frames = 100 Myr
    const x = rows.slice(lag).map((r) => r.consumptionKm2PerMa), y = rows.slice(0, -lag).map((r) => sub.get(r.t)[2]);
    const c = corr(x, y);
    check(c < 0.6, `control — consumption shifted by 100 Myr correlates ${c.toFixed(3)} (must fall below 0.6)`);
}

// ── 2. Bird PB2002 at 0 Ma ──
{
    const bird = gzJson('data/earth-interior/plates-pb2002.json.gz').steps;
    const k = bird.scale;
    const ours = boundariesAt(model, fr, 0).segs;
    const arcs = (types) => {
        const out = [];
        for (const s of ours) if (types.includes(s.type)) for (let j = 0; j + 5 < s.xyz.length; j += 3) out.push([s.xyz.slice(j, j + 3), s.xyz.slice(j + 3, j + 6)]);
        return out;
    };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const angTo = (p, [a, b]) => {
        // Angular distance from p to the great-circle ARC a→b.
        const n = cross(a, b), nn = Math.hypot(...n);
        const da = Math.acos(Math.min(1, dot(p, a))), db = Math.acos(Math.min(1, dot(p, b)));
        if (nn < 1e-12) return Math.min(da, db);
        const u = n.map((x) => x / nn), off = Math.asin(Math.min(1, Math.abs(dot(p, u))));
        const proj = p.map((x, i) => x - dot(p, u) * u[i]);
        const inside = dot(cross(a, proj), u) >= 0 && dot(cross(proj, b), u) >= 0;
        return inside ? off : Math.min(da, db);
    };
    const nearest = (p, set) => { let m = Infinity; for (const s of set) m = Math.min(m, angTo(p, s)); return m * 6371; };
    const classOf = (i) => bird.classes[bird.cls[i]];
    const birdMid = (i) => { const a = unit(bird.lat1[i] * k, bird.lon1[i] * k), b = unit(bird.lat2[i] * k, bird.lon2[i] * k); const m = [a[0] + b[0], a[1] + b[1], a[2] + b[2]], n = Math.hypot(...m); return m.map((x) => x / n); };
    const idx = (cls) => [...Array(bird.lon1.length).keys()].filter((i) => classOf(i) && String(classOf(i)).endsWith(cls));
    const ridgeArcs = arcs(['MidOceanRidge']), trenchArcs = arcs(['SubductionZone']);
    for (const [label, cls, set] of [['spreading ridge (Bird OSR)', 'SR', ridgeArcs], ['subduction zone (Bird SUB)', 'SUB', trenchArcs]]) {
        const ii = idx(cls).filter((_, n) => n % 3 === 0);
        if (!ii.length) { check(false, `Bird steps of class *${cls} found`); continue; }
        const d = ii.map((i) => nearest(birdMid(i), set));
        const p50 = median(d), p80 = [...d].sort((a, b) => a - b)[Math.floor(0.8 * d.length)];
        check(p50 < 30 && p80 < 120, `0 Ma ${label}: our boundary lies a median ${p50.toFixed(1)} km (p80 ${p80.toFixed(0)} km) from Bird's, over ${ii.length} steps`);
        // Control: our boundaries turned 10° about the spin axis (half-angle 5° in the quaternion).
        const q = [Math.cos(5 * Math.PI / 180), 0, 0, Math.sin(5 * Math.PI / 180)];
        const turned = set.map(([a, b]) => [rotateLine(q, [Math.asin(a[2]) * 180 / Math.PI, Math.atan2(a[1], a[0]) * 180 / Math.PI]), rotateLine(q, [Math.asin(b[2]) * 180 / Math.PI, Math.atan2(b[1], b[0]) * 180 / Math.PI])]);
        const dc = median(ii.map((i) => nearest(birdMid(i), turned)));
        check(dc > 150, `control — the same boundaries turned 10° sit a median ${dc.toFixed(0)} km from Bird's (must exceed 150)`);
    }
}

// ── 3. Rotation seams ──
{
    const worst = S.reduce((a, r) => (r.rmsSpeedMmYr > a.rmsSpeedMmYr ? r : a));
    check(worst.rmsSpeedMmYr < 250, `no frame's RMS plate speed exceeds 250 mm/yr (worst ${worst.rmsSpeedMmYr} at ${worst.t} Ma)`);
    // Control: the GPlates stage [t, t+1] straight across the 1000 Ma seam between the two files.
    const frame = fr.frames.find((f) => f.t === 1000);
    const naive = { eulerVector: (pid, t) => qEulerVector(qMul(model.total(pid, t), qConj(model.total(pid, t + 1))), 1) };
    const ctl = speedStats(naive, fr, frame, 1000).rms;
    check(ctl > 500, `control — the naive stage across the 1000 Ma file seam reads an RMS of ${ctl.toFixed(0)} mm/yr (must exceed 500)`);
    // The plate the naive stage throws hardest at 1000 Ma must have its velocity taken from a side.
    const worstPlate = frame.plates.map((p) => p.p).reduce((a, p) => (Math.hypot(...naive.eulerVector(p, 1000)) > Math.hypot(...naive.eulerVector(a, 1000)) ? p : a));
    const iv = model.velocityInterval(worstPlate, 1000);
    check(iv.side !== 'gplates' && model.seams(worstPlate, 999, 1001).length > 0,
        `plate ${worstPlate} has a seam at the 1000 Ma file join and its velocity there is taken from the ${iv.side} side`);
    // The model's OLDEST EDGE: past validToMa every plate sits at identity, so a stage reaching
    // past it reads a plate as stopped (measured: RMS ~0 at 1800 Ma before the edge rule).
    const edge = S.find((r) => r.t === fr.tMaxMa), before = S.find((r) => r.t === fr.tMaxMa - 5);
    check(model.velocityInterval(101, fr.tMaxMa).side === 'younger' && Math.abs(edge.rmsSpeedMmYr - before.rmsSpeedMmYr) < 0.2 * before.rmsSpeedMmYr,
        `at the model's oldest edge (${fr.tMaxMa} Ma) velocities come from the younger side: RMS ${edge.rmsSpeedMmYr} vs ${before.rmsSpeedMmYr} mm/yr 5 Myr later`);
    const plain = model.velocityInterval(101, 123.4);
    check(plain.side === 'gplates' && plain.young === 123.4 && plain.old === 124.4, 'away from a seam the interval is GPlates\' [t, t + 1] exactly');
}

// ── 4. Supercontinents ──
{
    const argmax = (a, b) => S.filter((r) => r.t >= a && r.t <= b).reduce((x, r) => (r.supercontinentIndex > x.supercontinentIndex ? r : x));
    const windows = { Pangaea: [0, 400], Rodinia: [600, 1100], 'Nuna (Columbia)': [1100, 1800] };
    for (const lit of LITERATURE_SUPERCONTINENTS) {
        const [a, b] = windows[lit.name];
        const pk = argmax(a, b);
        check(pk.t <= lit.assembled + 25 && pk.t >= lit.brokeUp - 25,
            `${lit.name}: the index's ${a}–${b} Ma maximum (${pk.supercontinentIndex.toFixed(2)} at ${pk.t} Ma) falls in the literature window ${lit.assembled}–${lit.brokeUp} Ma (±25)`);
    }
    // Control: continents left at their present positions give a flat index.
    const flat = [0, 300, 800, 1400].map((t) => supercontinentIndex(continents.filter((c) => c.begin >= t && t >= c.end).map((c) => ({ shape: c, xyz: rotateLine([1, 0, 0, 0], c.pts) }))).index);
    const placedPangaea = supercontinentIndex(shapesAt(model, continents, 300)).index;
    check(placedPangaea - flat[1] > 0.15, `control — unreconstructed continents at 300 Ma index ${flat[1].toFixed(2)} vs ${placedPangaea.toFixed(2)} reconstructed (the reconstruction must add > 0.15)`);
}

// ── sanity on the frames ──
{
    const t0 = fr.frames[0];
    check(t0.raster.every((v) => v === 255 || v < t0.plates.length), 'every raster cell indexes a plate of its frame (or none)');
    // The model's own topology fails to close at a few instants (853–855.1 Ma: Σ area 1.037 and
    // 47 % of the globe in no plate). Those frames are KEPT as the model resolves them and the page
    // labels the gap; only frames the bake's own meta flags may exceed 2 %, and there may be one.
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/plate-history/meta.json'), 'utf8'));
    const flagged = new Set(meta.topologyChecks.filter((c) => c.unassigned > 0.02 * t0.raster.length).map((c) => c.t));
    const gaps = S.filter((r) => r.noPlateFrac > 0.02);
    check(gaps.every((r) => flagged.has(r.t)) && gaps.length <= 1,
        `frames with > 2 % of the globe in no plate: ${gaps.map((r) => `${r.t} Ma (${(100 * r.noPlateFrac).toFixed(1)} %)`).join(', ') || 'none'} — each flagged by the bake's meta, at most one`);
    check(S.filter((r) => r.noPlateFrac <= 0.02).every((r) => r.noPlateFrac < 0.005), 'every other frame covers > 99.5 % of the globe');
    const s0 = boundaryStats(model, boundariesAt(model, fr, 0).segs, 0);
    check(s0.unknownPolarityKm < 0.05 * s0.trenchKm, `trench polarity known for ${(100 * (1 - s0.unknownPolarityKm / s0.trenchKm)).toFixed(1)} % of 0 Ma trench length`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall plate-history diagnostics gates passed');
process.exit(fails ? 1 : 0);
