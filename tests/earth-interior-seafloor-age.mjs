/**
 * tests/earth-interior-seafloor-age.mjs — the baked ocean-floor age (Seton et al. 2020) against
 * oracles we did not write, each with a negative control that must fail:
 *
 *  1. The release's own TEXT twin (age.2020.1.GTS2012.6m.xyz, sampled into
 *     tests/fixtures/earth-interior/seafloor-age-xyz.json by `build-seafloor-age.mjs --fixture`):
 *     a different file of the authors', explicit lon/lat per node, NORTH → SOUTH — while the
 *     binary we bake runs SOUTH → NORTH. On-lattice nodes must match to the 0.05 Myr quantum with
 *     every land/ocean call agreeing; between nodes the interpolator must stay close. Control: the
 *     same grid read with its rows unflipped.
 *  2. An INDEPENDENT age product: Müller et al. (1997), as Bird (2003) tabulates it at each PB2002
 *     oceanic-transform step (data/earth-interior/plates-pb2002.json.gz). Control: our grid turned
 *     180° in longitude.
 *  3. Physics: spreading ridges (Bird's OSR steps) are where sea floor is made, so the grid must
 *     read ~0 there. Control: the row-flipped grid.
 *  4. The area–age distribution and the bake's provenance.
 *
 * Run: node tests/earth-interior-seafloor-age.mjs
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeSeafloorAge, ageAt, nodeAge, nodeAreaKm2, areaAgeDistribution, ageRGBA, ageColor, AGE_RAMP } from '../js/earth-interior/seafloor-age.js';
import { decodePlates } from '../js/earth-interior/plates.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(readFileSync(join(ROOT, 'data/earth-interior/seafloor-age.json'), 'utf8'));
const binGz = readFileSync(join(ROOT, 'data/earth-interior/seafloor-age.bin.gz'));
const g = decodeSeafloorAge(meta, gunzipSync(binGz));
const fx = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/earth-interior/seafloor-age-xyz.json'), 'utf8'));
const bird = decodePlates(JSON.parse(gunzipSync(readFileSync(join(ROOT, 'data/earth-interior/plates-pb2002.json.gz')))));

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const corr = (x, y) => {
    const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
    let s = 0, sx = 0, sy = 0;
    for (let i = 0; i < n; i++) { s += (x[i] - mx) * (y[i] - my); sx += (x[i] - mx) ** 2; sy += (y[i] - my) ** 2; }
    return s / Math.sqrt(sx * sy);
};
// Negative-control grids: rows not flipped (read as if the file ran north → south), and turned 180°.
const flipped = { ...g, ages: new Float32Array(g.ages.length) };
for (let i = 0; i < g.nLat; i++) flipped.ages.set(g.ages.subarray(i * g.nLon, (i + 1) * g.nLon), (g.nLat - 1 - i) * g.nLon);
const turned = { ...g, ages: new Float32Array(g.ages.length) };
for (let i = 0; i < g.nLat; i++) for (let j = 0; j < g.nLon; j++) turned.ages[i * g.nLon + j] = g.ages[i * g.nLon + ((j + g.nLon / 2) % g.nLon)];

// ── provenance ──
check(createHash('sha256').update(binGz).digest('hex') === meta.output.sha256 && binGz.length === meta.output.bytes, 'the baked file matches the hash its meta records');
check(meta.grid.nLat === 901 && meta.grid.nLon === 1800 && meta.grid.stepDeg === 0.2 && meta.grid.rows === 'north→south', 'grid: 1800 × 901 nodes at 0.2°, rows north → south');

// ── 1. the text twin ──
function textTwin(grid) {
    let worst = 0, landMismatch = 0;
    for (const [lat, lon, age] of fx.onLattice) {
        const v = nodeAge(grid, Math.round((90 - lat) / 0.2), Math.round((lon + 180) / 0.2));
        if (age == null || Number.isNaN(v)) { if ((age == null) !== Number.isNaN(v)) landMismatch++; continue; }
        worst = Math.max(worst, Math.abs(v - age));
    }
    return { worst, landMismatch };
}
{
    const t = textTwin(g);
    check(fx.onLattice.length > 5000 && t.worst <= meta.grid.quantumMyr / 2 + 1e-4 && t.landMismatch === 0,
        `${fx.onLattice.length} on-lattice nodes of the text twin: every age within half the ${meta.grid.quantumMyr} Myr quantum (worst ${t.worst.toFixed(4)}), every land/ocean call agrees`);
    const c = textTwin(flipped);
    check(c.worst > 50 && c.landMismatch > 500, `control — the grid with its rows unflipped misses by up to ${c.worst.toFixed(0)} Myr with ${c.landMismatch} land/ocean disagreements`);
    const d = [];
    let coast = 0;
    for (const [lat, lon, age] of fx.between) {
        const v = ageAt(g, lat, lon);
        if (age == null || v == null) { if ((age == null) !== (v == null)) coast++; continue; }
        d.push(Math.abs(v - age));
    }
    check(q(d, 0.5) < 0.1 && q(d, 0.9) < 1 && coast <= 0.02 * fx.between.length,
        `${fx.between.length} nodes BETWEEN the baked lattice: interpolated age within ${q(d, 0.5).toFixed(3)} Myr (median), ${q(d, 0.9).toFixed(2)} (p90); ${coast} coast calls differ (≤ 2 %)`);
}

// ── 2 + 3. Bird's PB2002 steps ──
const D = Math.PI / 180;
const unit = (la, lo) => [Math.cos(la * D) * Math.cos(lo * D), Math.cos(la * D) * Math.sin(lo * D), Math.sin(la * D)];
const midpoint = (s) => { const a = unit(s.lat1, s.lon1), b = unit(s.lat2, s.lon2), m = a.map((x, i) => x + b[i]), n = Math.hypot(...m); return [Math.asin(m[2] / n) / D, Math.atan2(m[1], m[0]) / D]; };
function vsBird(grid, cls) {
    const ours = [], theirs = [], all = [];
    for (const s of bird.steps) {
        if (s.cls !== cls) continue;
        const [la, lo] = midpoint(s), v = ageAt(grid, la, lo);
        if (v == null) continue;
        all.push(v);
        if (s.ageMa != null) { ours.push(v); theirs.push(s.ageMa); }
    }
    return { all, ours, theirs, d: ours.map((v, i) => Math.abs(v - theirs[i])) };
}
{
    const r = vsBird(g, 'OTF');
    const rc = vsBird(turned, 'OTF');
    check(r.ours.length > 800 && q(r.d, 0.5) < 2 && corr(r.ours, r.theirs) > 0.85,
        `oceanic transforms: Seton 2020 vs Müller 1997 (Bird's table) at ${r.ours.length} steps — median |Δ| ${q(r.d, 0.5).toFixed(2)} Myr, correlation ${corr(r.ours, r.theirs).toFixed(3)}`);
    check(corr(rc.ours, rc.theirs) < 0.3, `control — the grid turned 180° correlates ${corr(rc.ours, rc.theirs).toFixed(3)} with Müller 1997 (must fall below 0.3)`);
    const ridge = vsBird(g, 'OSR'), ridgeFlip = vsBird(flipped, 'OSR');
    check(ridge.all.length > 1500 && q(ridge.all, 0.5) < 1.5 && q(ridge.all, 0.8) < 4,
        `spreading ridges (Bird OSR, ${ridge.all.length} steps): the grid reads ${q(ridge.all, 0.5).toFixed(2)} Myr (median), ${q(ridge.all, 0.8).toFixed(2)} (p80) — sea floor is made there`);
    check(q(ridgeFlip.all, 0.5) > 20, `control — the row-flipped grid reads ${q(ridgeFlip.all, 0.5).toFixed(1)} Myr at the same ridges (must exceed 20)`);
}

// ── 4. the area–age distribution ──
{
    const A = areaAgeDistribution(g);
    const sphere = 4 * Math.PI * 6371 ** 2;
    let nodeArea = 0; for (let i = 0; i < g.nLat; i++) nodeArea += g.nLon * nodeAreaKm2(g, i);
    check(Math.abs(nodeArea / sphere - 1) < 1e-9, 'the node cell areas tile the sphere exactly (half cells at the poles)');
    check(A.globeFraction > 0.5 && A.globeFraction < 0.65, `oceanic crust covers ${(100 * A.globeFraction).toFixed(1)} % of the globe (${(A.oceanAreaKm2 / 1e6).toFixed(0)} M km²)`);
    check(A.meanMyr > 55 && A.meanMyr < 75 && A.medianMyr < A.meanMyr, `mean ocean-floor age ${A.meanMyr.toFixed(1)} Myr, median ${A.medianMyr.toFixed(1)} Myr (right-skewed: young floor dominates)`);
    const young = A.bins.slice(0, 5).reduce((s, b) => s + b.areaKm2, 0), mid = A.bins.slice(5, 10).reduce((s, b) => s + b.areaKm2, 0), old = A.bins.slice(10, 15).reduce((s, b) => s + b.areaKm2, 0);
    check(young > mid && mid > old, `area falls with age: 0–50 Myr ${(young / 1e6).toFixed(0)}, 50–100 ${(mid / 1e6).toFixed(0)}, 100–150 ${(old / 1e6).toFixed(0)} M km²`);
    check(A.olderThan[180] < 0.02 && meta.oldestNode.ageMyr > 250 && meta.oldestNode.lat > 30 && meta.oldestNode.lat < 37 && meta.oldestNode.lon > 20 && meta.oldestNode.lon < 36,
        `almost nothing is older than 180 Myr (${(100 * A.olderThan[180]).toFixed(2)} %), and the oldest node (${meta.oldestNode.ageMyr} Myr) is in the eastern Mediterranean (${meta.oldestNode.lat}°N ${meta.oldestNode.lon}°E)`);
}

// ── the overlay ──
{
    const w = 360, h = 180, px = ageRGBA(g, w, h);
    const at = (lat, lon) => { const r = Math.floor((90 - lat) / 180 * h), c = Math.floor((lon + 180) / 360 * w); return px.subarray(4 * (r * w + c), 4 * (r * w + c) + 4); };
    check(at(0.5, 20.5)[3] === 0, 'the overlay is transparent over a continent (central Africa)');
    const pac = at(-30.5, -150.5), young = ageColor(0).map((v) => Math.round(v * 255));
    check(pac[3] > 0 && Math.abs(pac[0] - young[0]) + Math.abs(pac[1] - young[1]) > 40, 'mid-Pacific floor is drawn, and darker than ridge-age floor');
    check(AGE_RAMP.length === 5, 'one age ramp');
}

console.log(fails ? `\n${fails} FAILED` : '\nall seafloor-age gates passed');
process.exit(fails ? 1 : 0);
