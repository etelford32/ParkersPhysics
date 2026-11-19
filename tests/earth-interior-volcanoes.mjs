// tests/earth-interior-volcanoes.mjs — the quake ↔ volcano proximity join, on the REAL catalogue.
// Run: node tests/earth-interior-volcanoes.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeCatalog, matchActivity } from '../js/volcano-engine.js';
import { volcanoNearQuake, quakesNearVolcano, liveVolcanoRows, NEAR_KM, NEAR_DEPTH_KM } from '../js/earth-interior/volcano-quakes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cat = decodeCatalog(JSON.parse(readFileSync(join(ROOT, 'data/volcanoes/volcanoes-catalog.json'), 'utf8')));
let n = 0;
const ok = (m) => { n++; console.log(`  ✓ ${m}`); };
const byName = (s) => cat.volcanoes.find((v) => v.name === s);
// An INDEPENDENT great-circle distance (unit-vector dot product, not the engine's haversine).
const R = 6371.0088;
const vec = (la, lo) => { const a = la * Math.PI / 180, b = lo * Math.PI / 180; return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)]; };
const gc = (a, b) => { const p = vec(a.lat, a.lon), q = vec(b.lat, b.lon); return R * Math.acos(Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])); };

console.log('Inner Earth — quakes near volcanoes');

{
    const kil = byName('Kilauea');
    assert.ok(kil, 'Kīlauea is in the catalogue');
    // A shallow quake 12 km north of the summit.
    const q = { id: 'a', lat: kil.lat + 12 / 111.2, lon: kil.lon, depthKm: 3, timeMs: 1 };
    const hit = volcanoNearQuake(q, cat.volcanoes);
    assert.ok(hit, 'a quake 12 km from Kīlauea is near a volcano');
    assert.ok(Math.abs(hit.km - gc(q, hit.volcano)) < 0.01, `distance ${hit.km} vs independent ${gc(q, hit.volcano)}`);
    // The answer is the NEAREST Holocene volcano, checked by brute force with the independent distance.
    const brute = cat.volcanoes.filter((v) => groupOfName(v) !== 'inactive')
        .map((v) => ({ v, d: gc(q, v) })).sort((a, b) => a.d - b.d)[0];
    assert.equal(hit.volcano.i, brute.v.i, `nearest is ${brute.v.name}, join said ${hit.volcano.name}`);
    ok(`a shallow quake 12 km from Kīlauea joins ${hit.volcano.name} at ${hit.km.toFixed(1)} km (independent distance, brute-force nearest)`);
}
// Written out here (not read from the engine) so the gate is independent of GROUPS.
function groupOfName(v) { return ({ erupting: 'active', recent: 'active', historical: 'active', dormant: 'dormant', uncertain: 'dormant' })[v.status] ?? 'inactive'; }

{
    const etna = byName('Etna');
    // Just inside and just outside the radius; and a DEEP event right under it (not "near": slab, not edifice).
    const at = (km, depthKm) => ({ id: `k${km}`, lat: etna.lat + km / 111.195, lon: etna.lon, depthKm, timeMs: km });
    assert.ok(volcanoNearQuake(at(NEAR_KM - 0.5, 5), cat.volcanoes)?.volcano, 'inside the radius');
    const far = volcanoNearQuake(at(NEAR_KM + 25, 5), cat.volcanoes);
    assert.ok(!far || far.volcano.i !== etna.i, 'outside the radius is not Etna');
    assert.equal(volcanoNearQuake(at(3, NEAR_DEPTH_KM + 60), cat.volcanoes), null, 'a deep hypocentre under a volcano is not near it');
    // NEGATIVE CONTROL: without the depth rule the deep event WOULD join — so the rule is doing the work.
    assert.ok(volcanoNearQuake({ ...at(3, NEAR_DEPTH_KM + 60), depthKm: undefined }, cat.volcanoes), 'unknown depth falls back to the surface rule');
    ok(`radius ${NEAR_KM} km and depth ≤ ${NEAR_DEPTH_KM} km both bite (inside/outside/deep, with the depth rule's control)`);
}

{
    // Pleistocene ("inactive") volcanoes never claim a quake.
    const pleist = cat.volcanoes.find((v) => groupOfName(v) === 'inactive');
    const q = { id: 'p', lat: pleist.lat, lon: pleist.lon, depthKm: 2, timeMs: 0 };
    const hit = volcanoNearQuake(q, cat.volcanoes);
    assert.ok(!hit || hit.volcano.i !== pleist.i, 'an inactive volcano is never the join');
    // quakesNearVolcano: newest first, radius obeyed, deep ones skipped.
    const v = byName('Kilauea');
    const qs = [
        { id: '1', lat: v.lat, lon: v.lon + 0.05, depthKm: 2, timeMs: 10 },
        { id: '2', lat: v.lat, lon: v.lon + 0.10, depthKm: 2, timeMs: 30 },
        { id: '3', lat: v.lat + 1, lon: v.lon, depthKm: 2, timeMs: 20 },
        { id: '4', lat: v.lat, lon: v.lon, depthKm: 90, timeMs: 40 },
    ];
    assert.deepEqual(quakesNearVolcano(v, qs).map((x) => x.quake.id), ['2', '1']);
    ok('inactive volcanoes never claim a quake; quakesNearVolcano keeps the radius, drops deep events, newest first');
}

{
    // The live rows come from the ENGINE's own join (matchActivity), sorted by colour code.
    const kil = byName('Kilauea'), etna = byName('Etna'), fuego = byName('Fuego');
    const { live } = matchActivity(cat, [
        { source: 'usgs-hans', num: kil.num, colorCode: 'ORANGE', alertLevel: 'WATCH' },
        { source: 'eonet', name: 'Etna Volcano', lat: etna.lat, lon: etna.lon, startedAt: '2026-01-02T00:00:00Z' },
        { source: 'usgs-hans', num: fuego.num, colorCode: 'RED' },
    ]);
    const rows = liveVolcanoRows(live, [{ id: 'x', lat: etna.lat, lon: etna.lon + 0.05, depthKm: 4, timeMs: 1 }]);
    assert.deepEqual(rows.map((r) => r.volcano.name), ['Fuego', 'Kilauea', 'Etna']);
    assert.equal(rows[2].openSince, '2026-01-02T00:00:00Z');
    assert.equal(rows[2].nearbyQuakes, 1);
    assert.deepEqual(rows[1].sources, ['USGS']);
    ok('live rows: the engine\'s matchActivity join, RED > ORANGE > event, open-since and nearby-quake counts carried');
}

console.log(`${n} checks passed`);
