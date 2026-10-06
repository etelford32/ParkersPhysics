/**
 * tests/temperature-lab-model.mjs — the Planetary Temperature Lab's scorecards
 *
 *   node tests/temperature-lab-model.mjs
 *
 * Every snapshot here is SYNTHETIC and built from the shipped normals
 * themselves (a planet exactly at its normal, then one cell nudged), so each
 * expected outcome is known in closed form. Gates (plan §2.9 / §3):
 *   • a planet at its normal has ~0 anomaly and ~0 in its top/bottom deciles
 *   • R5: "most above normal" ranks by RARITY — a small departure where the
 *     climate is steady outranks a bigger one where it is variable — and the
 *     raw-degree order would have put them the other way round
 *   • rows are separated by ≥ 1500 km
 *   • a null stays null: never in a card, never in coverage or a share
 *   • the Antarctic plateau is reported at its real −7x °C, not the texture's
 *     −60 clamp
 *   • a fallback source in the window is DISCLOSED
 *   • surface: 'ocean' / 'all' change the universe and nothing else
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CELLS, cellCentre, cellIndex, cellSurface, dailyNormal, parseNormalsAsset } from '../js/temperature-normals.js';
import { buildLabModel, greatCircleKm, nearestPlace, SEPARATION_KM } from '../js/temperature-lab-model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (n) => parseNormalsAsset(new Uint8Array(readFileSync(join(ROOT, 'assets', 'temperature', n))));
const assets = {
    daily: load('normals-1991-2020.bin'),
    quantiles: load('quantiles-1991-2020.bin'),
    records: load('records-1991-2020.bin'),
};
let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('temperature-lab-model.mjs');

const FRAME_TO = '2026-07-15T12:00:00.000Z';
const MID = Date.parse(FRAME_TO) - 11.5 * 3600e3;

/** A planet sitting exactly on its 1991–2020 normal. */
function normalPlanet() {
    const snap = { frame_to: FRAME_TO, frame_from: '2026-07-14T13:00:00.000Z', n_frames: 24,
                   sources: { 'open-meteo:72x36': 24 },
                   t24max: [], t24min: [], t24mean: [], tnow: [], prev24mean: [] };
    for (let c = 0; c < CELLS; c++) {
        const dn = dailyNormal(assets.daily, c, MID);
        snap.t24max.push(dn.tmax.mean); snap.t24min.push(dn.tmin.mean);
        snap.t24mean.push(dn.tmean.mean); snap.tnow.push(dn.tmean.mean); snap.prev24mean.push(dn.tmean.mean);
    }
    return snap;
}

ok('a planet at its normal: anomaly ≈ 0, deciles ≈ 0, full coverage', () => {
    const m = buildLabModel(normalPlanet(), assets);
    assert.ok(Math.abs(m.planet.anomalyK) < 1e-9);
    assert.ok(Math.abs(m.planet.landAnomalyK) < 1e-9);
    assert.ok(Math.abs(m.planet.coverage - 1) < 1e-12);
    assert.ok(m.planet.landTopDecile < 0.02 && m.planet.landBottomDecile < 0.02,
        `the mean sits mid-distribution: top ${m.planet.landTopDecile}, bottom ${m.planet.landBottomDecile}`);
    assert.equal(m.planet.decileExpected, 0.10);
    assert.equal(m.disclosure.fallbackSource, false);
    assert.equal(m.windowMidpoint, new Date(MID).toISOString());
    for (const k of ['hottest', 'coldest', 'above', 'below', 'swings']) assert.ok(m.cards[k].length > 0, k);
});

ok('R5: rarity beats raw degrees — a steady place\'s small departure outranks a variable place\'s big one', () => {
    const snap = normalPlanet();
    const steady = cellIndex(2.5, 22.5);       // Congo basin: tiny day-to-day spread
    const wild = cellIndex(62.5, 127.5);       // Yakutia: large spread
    const sd = (c) => dailyNormal(assets.daily, c, MID).tmean.sd;
    assert.ok(cellSurface(assets.daily, steady).landPct >= 50 && cellSurface(assets.daily, wild).landPct >= 50);
    assert.ok(sd(steady) * 3 < sd(wild), `σ steady ${sd(steady)} vs wild ${sd(wild)}`);
    snap.t24mean[steady] += 2.6 * sd(steady);      // small in K, rare
    snap.t24mean[wild] += 1.4 * sd(wild);          // large in K, ordinary-ish
    const kSteady = snap.t24mean[steady] - dailyNormal(assets.daily, steady, MID).tmean.mean;
    const kWild = snap.t24mean[wild] - dailyNormal(assets.daily, wild, MID).tmean.mean;
    assert.ok(kWild > kSteady, 'the raw-degree order puts the variable place first');
    const above = buildLabModel(snap, assets).cards.above;
    const iS = above.findIndex(r => r.cell === steady), iW = above.findIndex(r => r.cell === wild);
    assert.equal(iS, 0, 'the rarer departure leads the card');
    assert.ok(iW > iS, 'and the bigger-in-degrees one ranks below it');
    assert.ok(above[0].percentile > 98 && above[0].cls === 'much-above');
    assert.ok(Math.abs(above[0].anomalyK - kSteady) < 1e-9, 'ΔT rides beside the rarity');
});

ok(`rows are at least ${SEPARATION_KM} km apart in every card`, () => {
    const snap = normalPlanet();
    const a = cellIndex(27.5, 2.5), b = cellIndex(27.5, 7.5);   // neighbours in the Sahara
    snap.t24max[a] += 9; snap.t24max[b] += 8.5;
    const m = buildLabModel(snap, assets);
    for (const card of Object.values(m.cards)) {
        for (let x = 0; x < card.length; x++) for (let y = x + 1; y < card.length; y++) {
            assert.ok(greatCircleKm(card[x].lat, card[x].lon, card[y].lat, card[y].lon) >= SEPARATION_KM);
        }
    }
    assert.equal(m.cards.hottest[0].cell, a);
    assert.ok(!m.cards.hottest.some(r => r.cell === b), 'the neighbour is folded away');
});

ok('a null stays null: never ranked, never in coverage or a share', () => {
    const snap = normalPlanet();
    const gone = cellIndex(27.5, 2.5);
    snap.t24max[gone] = null; snap.t24min[gone] = null; snap.t24mean[gone] = null; snap.prev24mean[gone] = null;
    const m = buildLabModel(snap, assets);
    for (const card of Object.values(m.cards)) assert.ok(!card.some(r => r.cell === gone));
    assert.equal(m.grid.anomalyK[gone], null);
    assert.equal(m.grid.percentile[gone], null);
    assert.ok(m.planet.coverage < 1);
    // and a whole-planet outage is reported as no coverage, not as a zero anomaly
    const empty = buildLabModel({ frame_to: FRAME_TO, sources: {} }, assets);
    assert.equal(empty.planet.coverage, 0);
    assert.equal(empty.planet.anomalyK, null);
    assert.equal(empty.planet.landTopDecile, null);
    for (const card of Object.values(empty.cards)) assert.equal(card.length, 0);
});

ok('the Antarctic plateau is reported at its real value, not the −60 °C texture clamp', () => {
    const snap = normalPlanet();
    const plateau = cellIndex(-77.5, 102.5);
    snap.t24min[plateau] = -78.4;
    const m = buildLabModel(snap, assets);
    assert.equal(m.cards.coldest[0].cell, plateau);
    assert.equal(m.cards.coldest[0].valueC, -78.4);
    assert.equal(m.planet.coldest.valueC, -78.4);
});

ok('a fallback source in the window is disclosed, with the tag', () => {
    const snap = normalPlanet();
    snap.sources = { 'met-norway:72x36': 20, 'open-meteo:72x36': 4 };
    const d = buildLabModel(snap, assets).disclosure;
    assert.equal(d.fallbackSource, true);
    assert.deepEqual(d.fallbackTags, ['met-norway:72x36']);
    assert.match(d.note, /understates extremes/);
    assert.match(d.liveField, /not station observations/);
    assert.match(d.record, /1991–2020 in ERA5/);
});

ok('surface: land (default) / ocean / all change the universe and nothing else', () => {
    const snap = normalPlanet();
    const land = buildLabModel(snap, assets);
    const ocean = buildLabModel(snap, assets, { surface: 'ocean' });
    const all = buildLabModel(snap, assets, { surface: 'all', top: 5 });
    assert.ok(land.cards.hottest.every(r => r.landPct >= 50));
    assert.ok(ocean.cards.hottest.every(r => r.landPct < 50));
    assert.equal(all.cards.above.length, 5);
    assert.equal(land.planet.anomalyK, ocean.planet.anomalyK, 'the planet strip is universe-independent');
});

ok('swings rank |Δ day-over-day| and carry the signed change', () => {
    const snap = normalPlanet();
    const front = cellIndex(42.5, -97.5);       // US Great Plains
    snap.prev24mean[front] = snap.t24mean[front] + 14;     // a 14 K drop
    const s = buildLabModel(snap, assets).cards.swings;
    assert.equal(s[0].cell, front);
    assert.ok(Math.abs(s[0].changeK + 14) < 1e-9);
    assert.match(s[0].region, /Great Plains/);
});

ok('nearestPlace names a city within 300 km, and says nothing beyond it', () => {
    assert.match(nearestPlace(40.5, -74.5).name, /New York/);
    assert.equal(nearestPlace(-47.5, -127.5), null, 'the empty South Pacific has no city to borrow');
    const { lat, lon } = cellCentre(cellIndex(51.5, -0.5));
    assert.ok(nearestPlace(lat, lon).km <= 300);
});

ok('a snapshot without frame_to is refused', () => {
    assert.throws(() => buildLabModel({}, assets), /frame_to/);
});

console.log(`\n${passed} passed`);
