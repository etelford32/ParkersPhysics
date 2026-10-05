/**
 * upper-atmosphere-datum.mjs — the page's one Earth radius and its seam
 * ═══════════════════════════════════════════════════════════════════════════
 * js/upper-atmosphere-datum.js: the page draws and reads density on a 6371 km
 * sphere; SGP4 / CelesTrak / the WASM drag integrator speak WGS-72 altitude.
 * Pins the conversions as INVERSES, pins that both routes to a scene radius
 * agree (catalogue altitude vs the same object's page altitude), that the
 * tracker hand-off scale really is km/6371, and that the datum is the column
 * kernel's own copy (not a fourth 6371 typed in).
 *
 * Run: node tests/upper-atmosphere-datum.mjs
 */
import assert from 'node:assert/strict';
import * as D from '../js/upper-atmosphere-datum.js';
import { R_EARTH_KM } from '../js/upper-atmosphere-column.js';
import { profileToRhoGrid, dragPressureSeries, SGP4_COL } from '../js/upper-atmosphere-trajectory-analysis.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

console.log('upper-atmosphere-datum');

ok('one datum: the column kernel\'s, and WGS-72 for the catalogue', () => {
    assert.equal(D.PAGE_RE_KM, R_EARTH_KM);
    assert.equal(D.PAGE_RE_KM, 6371);
    assert.equal(D.CATALOG_RE_KM, 6378.135);
    near(D.DATUM_OFFSET_KM, 7.135, 1e-9, 'offset');
});

ok('conversions are inverses and meet at the same geocentric radius', () => {
    for (const h of [0, 80, 420, 550, 1200, 20200, 35786]) {
        near(D.pageToCatalogAltKm(D.catalogToPageAltKm(h)), h, 1e-9, 'round trip');
        near(D.sceneToPageAltKm(D.pageAltToScene(h)), h, 1e-9, 'scene round trip');
        // A catalogue altitude and its page altitude are ONE radius.
        near(D.catalogAltToScene(h), D.pageAltToScene(D.catalogToPageAltKm(h)), 1e-12, 'same radius');
        near(D.radiusKmToScene(D.CATALOG_RE_KM + h), D.catalogAltToScene(h), 1e-12, 'geocentric');
    }
    // The bug this module exists for: drawing a catalogue altitude as a page
    // altitude puts the object 7.135 km low.
    near((D.catalogAltToScene(420) - D.pageAltToScene(420)) * D.PAGE_RE_KM, 7.135, 1e-9, 'slip');
});

ok('the tracker hand-off makes its km→scene exactly 1/6371', () => {
    // js/satellite-tracker.js: kmToScene = earthRadius / RE_KM(6378.135).
    near(D.TRACKER_EARTH_RADIUS / 6378.135, 1 / 6371, 1e-15, 'kmToScene');
});

ok('the analyzer seam reads ρ at the satellite\'s real radius', () => {
    // A page profile (indexed by PAGE altitude) with a sharp, recognisable
    // density at 400 km page altitude.
    const samples = [];
    for (let h = 300; h <= 500; h += 1) samples.push({ altitudeKm: h, rho: Math.exp(-(h - 300) / 50) * 1e-11 });
    const g = profileToRhoGrid(samples);
    // Handed to the WASM in ITS convention: page 400 ↔ WGS-72 392.865.
    const i400 = samples.findIndex((s) => s.altitudeKm === 400);
    near(g.alt[i400], 400 - D.DATUM_OFFSET_KM, 1e-9, 'grid altitude');
    assert.equal(g.rho[i400], samples[i400].rho);
    // The panel's q series: a WASM row at WGS-72 altitude 392.865 is the
    // satellite at PAGE altitude 400 → q uses ρ(400), not ρ(392.865).
    const stride = 13, row = new Float64Array(stride);
    row[SGP4_COL.ALT_KM] = 400 - D.DATUM_OFFSET_KM;
    row[SGP4_COL.SPEED] = 7.67;
    const q = dragPressureSeries(row, samples)[0];
    const want = 0.5 * samples[i400].rho * 7670 * 7670;
    near(q / want, 1, 1e-6, 'q at page altitude');
    // NEGATIVE CONTROL: read at the raw WGS-72 altitude it is ~15 % high.
    const wrong = 0.5 * Math.exp(-(400 - D.DATUM_OFFSET_KM - 300) / 50) * 1e-11 * 7670 * 7670;
    assert.ok(wrong / want > 1.12, `control ratio ${wrong / want}`);
});

console.log(`\n${passed} passed`);
