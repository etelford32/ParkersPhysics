/**
 * tests/geo-regions.mjs — js/geo-regions.js, the shared region labeller
 *
 *   node tests/geo-regions.mjs
 *
 * The table and the clusterer were MOVED from api/weather/extremes.js so the
 * Planetary Temperature Lab can import them in the browser (api/ is not served
 * statically). The move must change nothing: the hashes below were captured
 * from the inline copy BEFORE the move, over every one of the 2592 grid-cell
 * centres and a fixed cluster input, and must keep matching.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { REGIONS, clusterCells, labelRegion, lonDelta } from '../js/geo-regions.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('geo-regions.mjs');
const sha = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

const pts = [];
for (let lat = -87.5; lat <= 87.5; lat += 5) for (let lon = -177.5; lon <= 177.5; lon += 5) pts.push([lat, lon]);

ok('every grid-cell label is identical to the pre-move inline copy', () => {
    assert.equal(pts.length, 2592);
    assert.equal(sha(pts.map(([a, b]) => labelRegion(a, b))), '91b1b258813e44e344079f974571cd48e707f7b82982bff66d617481a74cf082');
});

ok('the clusterer is identical to the pre-move inline copy', () => {
    const items = pts.filter((_, k) => k % 37 === 0).map(([lat, lon], k) => ({ lat, lon, sev: (k % 3) + 1, t: k }));
    assert.equal(sha([clusterCells(items), clusterCells(items, 15, 3)]), 'd64d70d9a5f15e0e0be32134a9a74d104bd3fa845184932e100931ae0835a436');
});

ok('known places, first match wins, and the antimeridian wraps', () => {
    assert.equal(labelRegion(25, 0), 'Sahara & North Africa');
    assert.equal(labelRegion(31, 48), 'Middle East & Arabia');
    assert.equal(labelRegion(-80, 100), 'Antarctica');
    assert.equal(labelRegion(40, 15), 'Mediterranean', 'a specific sea before the continent box');
    assert.equal(labelRegion(45, 170), 'North Pacific');
    assert.equal(labelRegion(45, -170), 'North Pacific');
    assert.equal(lonDelta(179, -179), 2);
    assert.ok(REGIONS.length > 40);
});

console.log(`\n${passed} passed`);
