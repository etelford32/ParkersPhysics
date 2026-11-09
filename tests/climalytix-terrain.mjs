#!/usr/bin/env node
/**
 * climalytix-terrain.mjs — node gate for js/climalytix/terrain.js (§19 T1).
 *
 *   · Terrarium decode/encode round-trip to 1/256 m, at sea level, a trench
 *     and Everest
 *   · Web-Mercator tile maths: corners exact, round trip exact, tilesFor
 *     covers a box (dateline included)
 *   · slope/aspect on a TILTED PLANE are the closed form, at 0° and 60°
 *     (cos φ spacing) — NEGATIVE CONTROLS: the aspect sign trap (a hill
 *     rising north faces SOUTH) and the forward difference on an 8-bit
 *     staircase
 *   · incidence: flat = sin α exactly; a face square to the Sun = 1; facing
 *     away = 0; Sun down = 0
 *   · the day's ratio: flat = 1 exactly; at 40°N in December an equator-facing
 *     30° slope > 1.5 and a pole-facing one < 0.5; polar night = null
 *   · elevation levels: round in the reader's unit, 4–14 lines, majors every 5th
 *
 *   node tests/climalytix-terrain.mjs
 */

import assert from 'node:assert/strict';
import { DEM_CANDIDATES, parseDemTile, tileSampler, exposureGrid, exposurePaint, EXPOSURE_SHADE, EXPOSURE_SUN, EXPOSURE_FULL_LOG2 } from '../js/climalytix/terrain.js';
import {
    terrariumDecode, terrariumEncode, tileXY, tileLatLon, tilesFor, demZoomFor, sampleGrid,
    slopeAspect, incidence, dailyRatio, elevationLevels, compass16, DEM_MAX_Z,
} from '../js/climalytix/terrain.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
console.log('climalytix terrain');

const R = 6_371_008.8, M_PER_DEG = Math.PI * R / 180;

ok('Terrarium decode/encode round-trips to 1/256 m', () => {
    assert.equal(terrariumDecode(128, 0, 0), 0, 'sea level');
    for (const h of [0, 1650.25, -10_994, 8848.86, 0.5, -0.00390625]) {
        const [r, g, b] = terrariumEncode(h);
        assert.ok([r, g, b].every((c) => c >= 0 && c <= 255), `${h} → ${r},${g},${b}`);
        assert.ok(Math.abs(terrariumDecode(r, g, b) - h) <= 1 / 512, `${h}`);
    }
});

ok('Web-Mercator: corners exact, round trip exact, tilesFor covers a box and wraps the dateline', () => {
    assert.deepEqual(tileXY(0, -180, 3), { x: 0, y: 4 });
    const c = tileLatLon(0, 0, 0);
    assert.ok(Math.abs(c.lat - 85.0511287798) < 1e-9 && c.lon === -180);
    for (const [lat, lon, z] of [[40.015, -105.271, 12], [-33.9, 151.2, 9], [64.1, -21.9, 7]]) {
        const t = tileXY(lat, lon, z), b = tileLatLon(t.x, t.y, z);
        assert.ok(Math.abs(b.lat - lat) < 1e-9 && Math.abs(b.lon - lon) < 1e-9);
    }
    const tiles = tilesFor({ north: 41, south: 39, west: -106, east: -104 }, 8);
    for (const [lat, lon] of [[40, -105], [40.99, -105.99], [39.01, -104.01]]) {
        const t = tileXY(lat, lon, 8);
        assert.ok(tiles.some((q) => q.x === Math.floor(t.x) && q.y === Math.floor(t.y)), `${lat},${lon} covered`);
    }
    const fiji = tilesFor({ north: -16, south: -18, west: 178, east: 182 }, 6);
    assert.ok(fiji.some((q) => q.x === 63) && fiji.some((q) => q.x === 0), 'both sides of 180°');
    assert.equal(demZoomFor(1e9), DEM_MAX_Z, 'capped');
    assert.equal(demZoomFor(256 * 2 ** 7 / 360), 7, 'exactly one tile px per screen px');
});

/** A plane rising `east` m per m eastward and `north` m per m northward, sampled around lat0. */
function plane(lat0, east, north, n = 9, d = 0.01) {
    const box = { north: lat0 + (n - 1) * d / 2, south: lat0 - (n - 1) * d / 2, west: -105, east: -105 + (n - 1) * d };
    return sampleGrid(box, n, n, (lat, lon) => 1000
        + east * (lon + 105) * M_PER_DEG * Math.cos(lat * Math.PI / 180)
        + north * (lat - lat0) * M_PER_DEG);
}

ok('a tilted plane: slope and aspect are the closed form at 0° and 60° (cos φ spacing)', () => {
    for (const lat0 of [0, 60]) {
        const g = plane(lat0, 0.1, 0.1);
        const { slope, aspect } = slopeAspect(g);
        const k = 4 * 9 + 4;
        const want = Math.atan(Math.hypot(0.1, 0.1)) * 180 / Math.PI;
        assert.ok(Math.abs(slope[k] - want) < 0.05, `lat ${lat0}: slope ${slope[k]} vs ${want}`);
        assert.ok(Math.abs(aspect[k] - 225) < 0.2, `lat ${lat0}: rising NE ⇒ faces SW (225), got ${aspect[k]}`);
    }
    // The same rise per DEGREE of longitude is twice as steep in metres at
    // 60° (a degree is half as wide): a cos-blind kernel would read both alike.
    const perDeg = (lat0) => slopeAspect(sampleGrid({ north: lat0 + 0.04, south: lat0 - 0.04, west: -105, east: -104.92 }, 9, 9,
        (lat, lon) => 1000 + 0.1 * (lon + 105) * M_PER_DEG)).slope[40];
    const eq = perDeg(0), hi = perDeg(60);
    assert.ok(Math.abs(Math.tan(eq * Math.PI / 180) - 0.1) < 1e-4, `equator ${eq}`);
    assert.ok(Math.abs(Math.tan(hi * Math.PI / 180) - 0.1 / Math.cos(Math.PI / 3)) < 2e-3, `60°: ${Math.tan(hi * Math.PI / 180)} vs 0.2`);
    assert.equal(compass16(225), 'SW');
});

ok('NEGATIVE CONTROL: the aspect sign trap — a hill rising NORTH faces SOUTH', () => {
    const { aspect } = slopeAspect(plane(40, 0, 0.2));
    assert.ok(Math.abs(aspect[40] - 180) < 0.1, `${aspect[40]}`);
    const east = slopeAspect(plane(40, 0.2, 0)).aspect[40];
    assert.ok(Math.abs(east - 270) < 0.1, `rising east faces WEST: ${east}`);
    const flat = slopeAspect(plane(40, 0, 0));
    assert.equal(flat.slope[40], 0);
    assert.ok(Number.isNaN(flat.aspect[40]), 'flat ground has no aspect');
});

ok('NEGATIVE CONTROL: on an 8-bit staircase Sobel-2 is smooth, the forward difference draws steps', () => {
    // 0.3 m per node rise eastward, quantised to whole metres.
    const g = sampleGrid({ north: 40.1, south: 39.9, west: -105, east: -104.6 }, 41, 21, (lat, lon) => Math.round((lon + 105) / 0.01 * 0.3));
    const rough = (s) => { let a = 0, n = 0; for (let j = 3; j < 37; j++) { a += Math.abs(s[10 * 41 + j + 1] - s[10 * 41 + j]); n++; } return a / n; };
    const sob = rough(slopeAspect(g).slope), fwd = rough(slopeAspect(g, { method: 'forward' }).slope);
    assert.ok(fwd > 1.5 * sob, `forward ${fwd.toFixed(4)} vs sobel ${sob.toFixed(4)}`);
});

ok('incidence: flat = sin α; square to the Sun = 1; facing away = 0; Sun down = 0', () => {
    for (const alt of [5, 30, 72]) assert.ok(Math.abs(incidence(0, NaN, alt, 140) - Math.sin(alt * Math.PI / 180)) < 1e-12);
    assert.ok(Math.abs(incidence(60, 180, 30, 180) - 1) < 1e-12, 'a 60° south face under a 30° southern Sun');
    assert.equal(incidence(80, 0, 20, 180), 0, 'a steep north face, Sun in the south');
    assert.equal(incidence(10, 180, -3, 180), 0, 'Sun below the horizon');
});

ok('the day’s ratio: flat = 1; equator-facing > 1.5 and pole-facing < 0.5 in a 40°N December; polar night null', () => {
    const dec21 = Date.UTC(2026, 11, 21);
    const lon = -105, day0 = dec21 - lon / 15 * 3_600_000;            // local midnight at the site
    assert.ok(Math.abs(dailyRatio(0, NaN, 40, lon, day0) - 1) < 1e-12);
    const south = dailyRatio(30, 180, 40, lon, day0), north = dailyRatio(30, 0, 40, lon, day0);
    assert.ok(south > 1.5 && north < 0.5, `south ${south.toFixed(2)} north ${north.toFixed(2)}`);
    // Southern hemisphere: the NORTH face is the sunny one.
    assert.ok(dailyRatio(30, 0, -40, 150, Date.UTC(2026, 5, 21)) > 1.5);
    assert.equal(dailyRatio(20, 180, 80, 0, Date.UTC(2026, 11, 21)), null, 'polar night');
});

ok('elevation levels: round in the reader’s unit, 4–14 lines, majors every 5th', () => {
    const m = elevationLevels(1580, 4300);
    assert.ok(m.levels.length >= 4 && m.levels.length <= 14, `${m.levels.length}`);
    assert.ok(m.levels.every((l) => Number.isInteger(l.m / m.step)), 'multiples of the step');
    assert.equal(m.step, 200, '2720 m / 200 = 13.6 lines');
    const ft = elevationLevels(1580, 4300, { toDisplay: (x) => x / 0.3048, fromDisplay: (d) => d * 0.3048, sym: 'ft' });
    assert.ok(ft.levels.every((l) => Number.isInteger(Math.round(l.m / 0.3048 * 1e6) / 1e6 / ft.step)), 'whole steps of FEET');
    assert.equal(ft.step, 1000);
    assert.ok(ft.levels.find((l) => l.label === '10,000 ft').major);
    assert.deepEqual(elevationLevels(10, 10).levels, []);
});

ok('tileSampler reads across tile edges exactly on a planar field; a missing tile is a hole', () => {
    const z = 10;
    // Two adjacent tiles holding h = 1000 + x/16 (global pixel x; exact in Terrarium's 1/256 m): bilinear is exact on a plane.
    const tile = (tx) => { const d = new Uint8ClampedArray(256 * 256 * 4); for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) { const [r, g, b] = terrariumEncode(1000 + 0.0625 * (tx * 256 + x)); d.set([r, g, b, 255], (y * 256 + x) * 4); } return d; };
    const tiles = new Map([[`${z}/200/400`, tile(200)], [`${z}/201/400`, tile(201)]]);
    const h = tileSampler(z, (zz, x, y) => tiles.get(`${zz}/${x}/${y}`) ?? null);
    const edge = tileLatLon(201, 400.5, z);                              // ON the seam between the two tiles
    const want = 1000 + 0.0625 * (201 * 256 - 0.5);
    assert.ok(Math.abs(h(edge.lat, edge.lon) - want) < 0.01, `${h(edge.lat, edge.lon)} vs ${want}`);
    const off = tileLatLon(202.5, 400.5, z);
    assert.equal(h(off.lat, off.lon), null, 'no tile, no height');
});

ok('exposure grids: flat = 1 in both modes; a south face beats a north face; Sun down = no value', () => {
    const lat0 = 40, g = plane(lat0, 0, 0.3);                            // rises north ⇒ faces SOUTH
    const sa = slopeAspect(g), k = 40;
    const sunSouth = () => ({ altitudeDeg: 25, azimuthDeg: 180 });
    const now = exposureGrid(g, sa, { mode: 'now', sunAt: sunSouth });
    assert.ok(now[k] > 1.5, `south face, southern Sun: ${now[k]}`);
    const flatNow = exposureGrid(plane(lat0, 0, 0), slopeAspect(plane(lat0, 0, 0)), { mode: 'now', sunAt: sunSouth });
    assert.ok(Math.abs(flatNow[k] - 1) < 1e-6);
    const north = exposureGrid(plane(lat0, 0, -0.3), slopeAspect(plane(lat0, 0, -0.3)), { mode: 'now', sunAt: sunSouth });
    assert.ok(north[k] < 0.5, `north face: ${north[k]}`);
    assert.ok(Number.isNaN(exposureGrid(g, sa, { mode: 'now', sunAt: () => ({ altitudeDeg: -4, azimuthDeg: 0 }) })[k]));
    const track = Array.from({ length: 24 }, (_, h) => ({ altitudeDeg: 30 * Math.sin(Math.PI * (h - 6) / 12), azimuthDeg: 90 + h * 7.5 }));
    const today = exposureGrid(g, sa, { mode: 'today', track });
    assert.ok(today[k] > 1, `south face over the day: ${today[k]}`);
    const flatToday = exposureGrid(plane(lat0, 0, 0), slopeAspect(plane(lat0, 0, 0)), { mode: 'today', track })[k];
    assert.ok(Math.abs(flatToday - 1) < 1e-6);
});

ok('the exposure colour: transparent at 1×, full shade at 0.71× or less, full sun at 1.41× or more', () => {
    const at = (r) => { const d = new Uint8ClampedArray(4); exposurePaint(r, d, 0); return [...d]; };
    assert.equal(at(1)[3], 0);
    assert.equal(EXPOSURE_FULL_LOG2, 0.5);
    assert.deepEqual(at(Math.SQRT1_2), [...EXPOSURE_SHADE.map((c) => Math.round(c * 255)), Math.round(255 * 0.85)]);
    assert.deepEqual(at(0), at(0.25), 'a face that sees no Sun is full shade');
    assert.deepEqual(at(3), [...EXPOSURE_SUN.map((c) => Math.round(c * 255)), Math.round(255 * 0.85)]);
    assert.ok(at(1.2)[3] > 0 && at(1.2)[3] < at(Math.SQRT2)[3], 'grows with |log₂ ratio|');
    assert.equal(at(Math.SQRT2)[3], at(2)[3], 'saturates at half a stop');
    assert.deepEqual(at(NaN), [0, 0, 0, 0]);
});

// ── The route (/api/climalytix/dem), upstream stubbed ─────────────────────
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const { default: handler } = await import('../api/climalytix/dem.js');
const realFetch = globalThis.fetch;
const asked = [];
const stub = (fn) => { globalThis.fetch = async (u) => { const s2 = typeof u === 'string' ? u : u.url; asked.push(s2); return fn(s2); }; };
const call = (qs) => handler(new Request(`https://x.test/api/climalytix/dem${qs ? `?${qs}` : ''}`));

await (async () => {
    // First host answers an HTML error page with 200; the second serves PNG.
    stub((u) => (u.includes(DEM_CANDIDATES[0].url.split('/')[2]) && u.startsWith('https://s3.amazonaws.com')
        ? new Response('<html>nope</html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
        : new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } })));
    const r = await call('z=12&x=844&y=1551');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('X-DEM-Source'), 'aws-s3-host', 'the HTML 200 was refused');
    assert.equal(r.headers.get('Content-Type'), 'image/png');
    assert.match(r.headers.get('Cache-Control'), /immutable/);
    assert.ok(asked.every((u) => /terrarium\/12\/844\/1551\.png$/.test(u)), 'URLs rebuilt from the template');
    passed++; console.log('  ✓ route: an HTML 200 is refused, the next host serves the PNG and is named; cached immutable');

    asked.length = 0;
    stub(() => new Response('', { status: 404 }));
    assert.equal((await call('z=5&x=1&y=2')).status, 404, 'a hole stays a hole');
    stub(() => { throw new Error('network'); });
    assert.equal((await call('z=5&x=1&y=2')).status, 502);
    for (const bad of ['z=13&x=0&y=0', 'z=2&x=4&y=0', 'z=a&x=0&y=0', 'z=-1&x=0&y=0', 'z=3&x=1.5&y=0']) {
        assert.equal((await call(bad)).status, 400, bad);
    }
    asked.length = 0;
    stub(() => new Response(PNG, { status: 200 }));
    await call('z=3&x=1&y=3&url=https://evil.example/x.png');
    assert.ok(asked.every((u) => !u.includes('evil')), 'no passthrough: a url parameter is ignored');
    assert.deepEqual(parseDemTile({ z: '12', x: '4095', y: '0' }), { z: 12, x: 4095, y: 0 });
    passed++; console.log('  ✓ route: every host 404 ⇒ 404, network down ⇒ 502, bad z/x/y ⇒ 400, no passthrough URL');

    stub((u) => (u.startsWith('https://s3.amazonaws.com') ? new Response('', { status: 403 }) : new Response(PNG, { status: 200 })));
    let j = await (await call('')).json();
    assert.equal(j.resolved, 'aws-s3-host');
    assert.deepEqual(j.candidates.map((c) => [c.id, c.ok, c.status]), [['aws-s3-path', false, 403], ['aws-s3-host', true, 200]]);
    assert.equal(j.freshness, 'fresh');
    stub(() => { throw new Error('down'); });
    const r2 = await call('');
    j = await r2.json();
    assert.equal(r2.status, 200, 'the probe never 5xxs');
    assert.equal(j.freshness, 'stale'); assert.equal(j.resolved, null);
    passed++; console.log('  ✓ route probe: names the host that answered; nothing answering is 200 + stale');
    globalThis.fetch = realFetch;
})();

console.log(`\n${passed} passed`);
