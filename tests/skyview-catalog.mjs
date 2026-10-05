/**
 * Gate for data/skyview/sky-catalog.json + js/skyview/sky-catalog.js.
 *
 *   - DRIFT: the baked galaxy-map section must equal a fresh extraction from
 *     the CURRENT galactic-map.html (scripts/build-skyview-catalog.mjs's own
 *     functions, run against the page). Edit the map, re-run the baker.
 *   - THE MAP'S POSITIONS: every galaxy-map star with a pinned Hipparcos
 *     identity (GALACTIC_HIP) must sit within 0.2° of that star. Ten did not
 *     until 2026-10-05 (ε Eri 8.7°, η Eri 17°, Pollux 1.4°…), which put them in
 *     the wrong part of a visitor's sky and the wrong place in the 3D map.
 *   - Known anchors: Sirius is the brightest star at its Hipparcos place;
 *     Sgr A* is a landmark at the galactic centre; the Milky Way raster is
 *     brightest toward Sagittarius and empty at the galactic poles.
 *   - evaluateSky at a fixed instant: ranked strictly by margin, nothing below
 *     the horizon ranked, landmarks never ranked, and a dark-sky night ranks
 *     naked-eye objects first.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    extractGalacticCatalog, buildGalacticRecords, GALACTIC_HIP, CATALOG_VERSION,
} from '../scripts/build-skyview-catalog.mjs';
import { unpackCatalog, evaluateSky, starLabel, bvToRgb, RANK_STAR_MAG } from '../js/skyview/sky-catalog.js';
import {
    angularSeparationDeg, galacticToEquatorial, skyFrame, jdFromMs,
} from '../js/skyview/sky-engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/skyview/sky-catalog.json'), 'utf8'));
const html = fs.readFileSync(path.join(ROOT, 'galactic-map.html'), 'utf8');

assert.equal(json.version, CATALOG_VERSION);

// ── Drift against the live galaxy map ───────────────────────────────────────
{
    const fresh = buildGalacticRecords(extractGalacticCatalog(html), json.stars, json.dsos);
    assert.deepEqual(JSON.parse(JSON.stringify(fresh)), json.galactic,
        'data/skyview/sky-catalog.json is stale against galactic-map.html — run `node scripts/build-skyview-catalog.mjs`');
}

// ── The map's own star positions ────────────────────────────────────────────
{
    const idx = new Map(json.stars.hip.map((h, i) => [h, i]));
    const bad = [];
    for (const g of json.galactic) {
        const hip = GALACTIC_HIP[g.id];
        if (hip == null) continue;
        assert.equal(g.hip, hip, `${g.id} carries its pinned identity`);
        const i = idx.get(hip);
        const sep = angularSeparationDeg(g.ra, g.dec, json.stars.ra[i], json.stars.dec[i]);
        if (sep > 0.2) bad.push(`${g.id} ${sep.toFixed(2)}°`);
    }
    assert.deepEqual(bad, [], `galactic-map.html star positions off by > 0.2°: ${bad.join(', ')}`);
    // Every pinned id must still exist on the map (a renamed id would silently drop the check).
    const ids = new Set(json.galactic.map((g) => g.id));
    for (const id of Object.keys(GALACTIC_HIP)) assert.ok(ids.has(id), `GALACTIC_HIP.${id} is on the map`);
}

// ── Unpack + anchors ────────────────────────────────────────────────────────
const cat = unpackCatalog(json);
{
    assert.ok(cat.stars.n > 5000, 'the full naked-eye sky (V ≲ 6)');
    assert.equal(cat.stars.hip[0], 32349, 'Sirius is the brightest star');
    assert.equal(starLabel(cat.starNames, 32349), 'Sirius');
    assert.ok(Math.abs(cat.stars.ra[0] - 101.287) < 0.01 && Math.abs(cat.stars.dec[0] + 16.716) < 0.01, 'Sirius position');
    for (let i = 1; i < cat.stars.n; i++) assert.ok(cat.stars.mag[i] >= cat.stars.mag[i - 1], 'stars sorted brightest first');
    assert.equal(cat.constellations.length, 89, '88 IAU constellations (Serpens in two parts)');
    assert.ok(cat.constellations.every((c) => c.lineVecs.length > 0), 'every constellation has a figure');
    assert.ok(cat.dsos.find((d) => d.id === 'M31' && d.kind === 'galaxy'), 'M31 is a galaxy');
    assert.ok(cat.dsos.find((d) => d.name === 'Large Magellanic Cloud'), 'the LMC is named');
    assert.ok(!cat.dsos.some((d, i) => cat.dsos.some((e, j) => j > i && angularSeparationDeg(d.ra, d.dec, e.ra, e.dec) < 0.05 && d.kind === e.kind)),
        'no duplicated deep-sky object');
    const sgr = cat.galactic.find((g) => g.id === 'sgr_a');
    assert.ok(sgr && sgr.hip == null && sgr.dso == null, 'Sgr A* is a landmark, not a "visible" object');
    const gc = galacticToEquatorial(0, 0);
    assert.ok(angularSeparationDeg(sgr.ra, sgr.dec, gc.raDeg, gc.decDeg) < 0.01, 'Sgr A* sits at the galactic centre');
    assert.ok(cat.galactic.find((g) => g.id === 'sirius').link === 'sirius.html', 'map page links survive');
    for (const g of cat.galactic) assert.ok(Number.isFinite(g.ra) && Number.isFinite(g.dec), `${g.id} has a sky position`);

    const mw = cat.milkyWay;
    const at = (ra, dec) => mw.grid[Math.min(mw.height - 1, Math.floor((90 - dec) / (180 / mw.height))) * mw.width + Math.floor(ra) % mw.width];
    // The galactic centre ITSELF sits behind a dust lane (level 1–2 here, as on
    // the real sky); the brightest contour is the Large Sagittarius Star Cloud
    // a few degrees east, at RA ≈ 270°. Both are asserted, so neither a raster
    // that is blank there nor one that fills the dust lane passes.
    let peak = 0;
    for (let ra = 266; ra <= 276; ra++) for (let dec = -32; dec <= -26; dec++) peak = Math.max(peak, at(ra, dec));
    assert.equal(peak, mw.levels, 'the Sagittarius Star Cloud is the brightest contour');
    assert.ok(at(gc.raDeg, gc.decDeg) < mw.levels, 'the galactic centre is dust-obscured');
    const ngp = galacticToEquatorial(0, 90), sgp = galacticToEquatorial(0, -90);
    assert.equal(at(ngp.raDeg, ngp.decDeg), 0, 'nothing at the north galactic pole');
    assert.equal(at(sgp.raDeg, sgp.decDeg), 0, 'nothing at the south galactic pole');

    const blue = bvToRgb(-0.3), red = bvToRgb(1.8);
    assert.ok(blue[2] > blue[0] && red[0] > red[2], 'B−V colours: hot stars blue, cool stars red');
}

// ── evaluateSky ─────────────────────────────────────────────────────────────
{
    // Denver, a moonless-enough October night (Moon set 2026-10-05 ~03 UT? use 05:30 UT, Sun −30°).
    const f = skyFrame(jdFromMs(Date.parse('2026-10-05T05:30:00Z')), 39.74, -104.99);
    const sky = evaluateSky(cat, f, { skyQuality: 'dark' });
    assert.ok(sky.env.sunAltDeg < -18, 'it is astronomically dark');
    assert.equal(sky.starAlt.length, cat.stars.n, 'every catalogue star is placed');
    const r = sky.ranked;
    assert.ok(r.length > 100, 'plenty to rank on a dark night');
    for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].vis.margin >= r[i].vis.margin, 'ranked by margin');
    assert.ok(r.every((o) => o.altDeg > 0), 'nothing below the horizon is ranked');
    assert.ok(!r.some((o) => o.kind === 'landmark'), 'landmarks are never ranked');
    assert.ok(r.slice(0, 10).every((o) => o.vis.margin > 0), 'the top 10 are all naked-eye visible');
    assert.ok(r.every((o) => o.kind !== 'star' || o.mag <= RANK_STAR_MAG), 'star candidates respect the cut');
    assert.ok(sky.landmarks.length > 40, 'galaxy-map landmarks are placed');
    const vega = r.find((o) => o.hip === 91262);
    assert.ok(vega && vega.galactic?.id === 'vega' && vega.galactic.link === 'vega.html', 'Vega carries its galaxy-map record');

    // Midday: the Sun is first and almost nothing else clears the limit.
    const noon = evaluateSky(cat, skyFrame(jdFromMs(Date.parse('2026-10-05T19:00:00Z')), 39.74, -104.99));
    assert.equal(noon.env.regime, 'day');
    assert.equal(noon.ranked[0].id, 'sun', 'the Sun tops the daytime list');
    assert.ok(noon.ranked.filter((o) => o.vis.margin >= 0).length <= 3, 'daylight hides nearly everything');
}

console.log('skyview-catalog.mjs — all assertions passed');
