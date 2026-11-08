#!/usr/bin/env node
/**
 * climalytix-basemap.mjs — node gate for js/climalytix/basemap.js.
 *
 *   · the underlay's source rectangles are the exact inverse of the
 *     projection (each rect's corners land on its geographic box), are split
 *     at the dateline and never read past the image
 *   · the underlay tier is the smallest with ≥ 1 texel per device pixel
 *   · the hillshade is NEUTRAL (128) on flat ground, lighter on a slope that
 *     faces the north-west light and darker on one facing away, gives the
 *     same shade to the same physical slope at 0° and 60° latitude, wraps at
 *     the dateline — NEGATIVE CONTROL: on an 8-bit quantised gentle ramp the
 *     Sobel-2 shade is smooth while the one-texel FORWARD difference draws
 *     every quantisation step as a ridge (EarthView's topoGradient scar)
 *   · city labels: biggest first, never overlapping each other or the site,
 *     inside the frame, and zooming in reveals smaller cities
 *
 *   node tests/climalytix-basemap.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    underlayTier, underlayRects, hillshade, cityLabels, reliefKmPerTexel,
    UNDERLAY_TIERS, RELIEF_EXAGGERATION, LIGHT_AZIMUTH_DEG,
} from '../js/climalytix/basemap.js';
import { makeView, geoToPx, scales } from '../js/climalytix/map-view.js';
import { MAJOR_CITIES } from '../js/data/major-cities.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
console.log('climalytix basemap');

const W = 900, H = 480;

ok('underlay rects are the exact inverse of the projection', () => {
    const v = makeView(40.015, -105.271, 7.5);
    const rects = underlayRects(v, W, H, 4096, 2048);
    assert.equal(rects.length, 1);
    const r = rects[0];
    // Corners of the rect, mapped image → geo → screen, are the screen corners.
    const geoOf = (sx, sy) => ({ lon: sx / 4096 * 360 - 180, lat: 90 - sy / 2048 * 180 });
    const a = geoToPx(v, W, H, geoOf(r.sx, r.sy).lat, geoOf(r.sx, r.sy).lon);
    const b = geoToPx(v, W, H, geoOf(r.sx + r.sw, r.sy + r.sh).lat, geoOf(r.sx + r.sw, r.sy + r.sh).lon);
    for (const [got, want] of [[a.x, 0], [a.y, 0], [b.x, W], [b.y, H]]) assert.ok(Math.abs(got - want) < 1e-6, `${got} vs ${want}`);
});

ok('across the dateline: two rects, both inside the image, adjacent on screen', () => {
    const v = makeView(-17.5, 179, 12);                           // Fiji
    const rects = underlayRects(v, W, H, 2048, 1024);
    assert.equal(rects.length, 2);
    for (const r of rects) {
        assert.ok(r.sx >= -1e-9 && r.sx + r.sw <= 2048 + 1e-9, 'inside the image');
        assert.ok(r.sw > 0 && r.sh > 0);
    }
    const [west, east] = rects.sort((p, q) => p.geo.west - q.geo.west);
    assert.equal(west.geo.east, 180);
    assert.equal(east.geo.west, 180, 'the east piece continues where the west one ends');
    assert.ok(Math.abs(west.sx + west.sw - 2048) < 1e-9, 'west piece runs to the image east edge');
    assert.ok(Math.abs(east.sx) < 1e-9, 'east piece starts at the image west edge');
});

ok('near a pole the rect stops at 90°', () => {
    const v = makeView(86, 0, 10);                                // clamped to lat 85
    for (const r of underlayRects(v, W, H, 2048, 1024)) assert.ok(r.sy >= 0 && r.geo.north <= 90);
});

ok('underlay tier: smallest with ≥ 1 texel per device px; largest when none suffices', () => {
    const z = makeView(40, -105, 70);
    const need = scales(z, H).kx;                                 // 5.25 px/deg: 1k holds 2.84, 2k 5.69
    assert.equal(underlayTier(z, W, H, 1).id, UNDERLAY_TIERS.find((t) => t.width / 360 >= need).id);
    assert.equal(underlayTier(z, W, H, 1).id, '2k');
    assert.equal(underlayTier(z, W, 200, 1).id, '1k', 'a short map at full zoom-out: 2.19 px/deg');
    assert.equal(underlayTier(z, W, H, 2).id, '4k', 'the same view on a 2× display');
    assert.equal(underlayTier(makeView(40, -105, 7.5), W, H, 2).id, '4k', 'zoomed in: the largest');
});

// ── Hillshade ────────────────────────────────────────────────────────────
const GW = 64, GH = 32;
function grid(fn) {
    const a = new Uint8Array(GW * GH);
    for (let i = 0; i < GH; i++) for (let j = 0; j < GW; j++) a[i * GW + j] = Math.max(0, Math.min(255, Math.round(fn(i, j))));
    return a;
}
const row = (lat) => Math.floor((90 - lat) / 180 * GH);
const px = (s, lat, j) => s[row(lat) * GW + j];

ok('flat ground (and sea) is exactly neutral 128 — overlay leaves the imagery untouched', () => {
    for (const lvl of [0, 90]) {
        const s = hillshade(grid(() => lvl), GW, GH);
        assert.ok(s.every((x) => x === 128), `level ${lvl}`);
    }
});

ok('a slope facing the NW light is lighter, one facing away is darker', () => {
    // Rises toward the east: faces WEST (toward the light's west component) ⇒ lighter.
    const east = hillshade(grid((i, j) => 100 + j), GW, GH, { exaggeration: 400 });
    const west = hillshade(grid((i, j) => 100 - j), GW, GH, { exaggeration: 400 });
    assert.ok(px(east, 0, 30) > 128 && px(west, 0, 30) < 128, `${px(east, 0, 30)} / ${px(west, 0, 30)}`);
    // Rises toward the south: faces NORTH ⇒ lighter.
    const south = hillshade(grid((i) => 50 + 4 * i), GW, GH, { exaggeration: 40 });
    assert.ok(px(south, 0, 30) > 128);
});

ok('the same PHYSICAL slope shades the same at 0° and 60° (cos φ spacing)', () => {
    // An east-rising ramp whose per-texel rise is k·cos φ has ONE physical
    // slope everywhere (the texel is cos φ narrower). Sampled at column 1,
    // where the field's north–south variation (k·j·cos φ) is smallest, under
    // a light from due west so only the east–west slope lights it.
    const f = new Float64Array(GW * GH);
    for (let i = 0; i < GH; i++) for (let j = 0; j < GW; j++) {
        const lat = 90 - (i + 0.5) * 180 / GH;
        f[i * GW + j] = 20 + j * 3 * Math.cos(lat * Math.PI / 180);
    }
    const o = { exaggeration: 6000, azimuthDeg: 270 };   // a coarse test grid: texels are 625 km
    const s = hillshade(f, GW, GH, o);
    assert.ok(Math.abs(px(s, 0, 1) - px(s, 60, 1)) <= 1, `${px(s, 0, 1)} vs ${px(s, 60, 1)}`);
    assert.ok(px(s, 0, 1) > 135, 'and it is a visible slope');
    // NEGATIVE CONTROL: the same LEVELS per texel everywhere (no cos φ) read
    // as a steeper slope at 60° — which is what a cos-blind shade would draw.
    const g = new Float64Array(GW * GH).map((_, k) => 20 + (k % GW) * 3 * 0.5);
    const t = hillshade(g, GW, GH, o);
    assert.ok(px(t, 60, 1) - px(t, 0, 1) > 3, `${px(t, 60, 1)} vs ${px(t, 0, 1)}`);
});

ok('columns wrap at the dateline (no seam ridge on a smooth field)', () => {
    const s = hillshade(grid((i, j) => 100 + 30 * Math.sin(2 * Math.PI * j / GW)), GW, GH, { exaggeration: 300 });
    const r = row(0);
    const d0 = Math.abs(s[r * GW] - s[r * GW + 1]), dMid = Math.abs(s[r * GW + 31] - s[r * GW + 32]);
    assert.ok(d0 <= dMid + 2, `edge step ${d0} vs interior ${dMid}`);
});

ok('NEGATIVE CONTROL: on an 8-bit gentle ramp Sobel-2 is smooth, the forward difference draws the steps', () => {
    // 0.3 levels per texel east: the quantised map holds a step every ~3 texels.
    const lv = grid((i, j) => 60 + 0.3 * j);
    const rough = (s) => {
        const r = row(0) * GW;
        let acc = 0;
        for (let j = 4; j < GW - 4; j++) acc += Math.abs(s[r + j + 1] - s[r + j]);
        return acc / (GW - 8);
    };
    const opts = { exaggeration: 2000 };
    const sob = rough(hillshade(lv, GW, GH, { ...opts, method: 'sobel2' }));
    const fwd = rough(hillshade(lv, GW, GH, { ...opts, method: 'forward' }));
    // Measured 5.30 vs 2.95 (1.8×) — the same order as EarthView's
    // texel-roughness numbers (0.49 → 0.30 on the low-Sun Sahara).
    assert.ok(fwd > 1.5 * sob, `forward ${fwd.toFixed(2)} vs sobel ${sob.toFixed(2)}`);
});

ok('the rail prints the SAME exaggeration and light the kernel uses', () => {
    const html = readFileSync(new URL('../climalytix.html', import.meta.url), 'utf8');
    assert.ok(html.includes(`×${RELIEF_EXAGGERATION} vertically`), 'exaggeration');
    assert.equal(LIGHT_AZIMUTH_DEG, 315, 'the rail says north-west');
});

ok('relief resolution is printed honestly: ~19.6 km at the equator, cos φ narrower', () => {
    assert.ok(Math.abs(reliefKmPerTexel(0) - 19.57) < 0.05);
    assert.ok(Math.abs(reliefKmPerTexel(60) - 19.57 / 2) < 0.05);
});

// ── City labels ──────────────────────────────────────────────────────────
ok('labels: biggest first, no overlaps (with the site box), all inside the frame', () => {
    const site = { lat: 40.015, lon: -105.271 };
    const v = makeView(39, -98, 30);
    const labels = cityLabels(v, W, H, MAJOR_CITIES, { site });
    assert.ok(labels.length >= 5, `${labels.length} labels`);
    for (let k = 1; k < labels.length; k++) assert.ok(labels[k - 1].p >= labels[k].p, 'biggest first');
    const sitePx = geoToPx(v, W, H, site.lat, site.lon);
    const boxes = [...labels.map((l) => l.box), { x0: sitePx.x - 10, y0: sitePx.y - 10, x1: sitePx.x + 10, y1: sitePx.y + 10 }];
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
        const p = boxes[a], q = boxes[b];
        assert.ok(p.x1 <= q.x0 || q.x1 <= p.x0 || p.y1 <= q.y0 || q.y1 <= p.y0, `overlap ${a}/${b}`);
    }
    for (const l of labels) assert.ok(l.box.x0 >= 0 && l.box.x1 <= W && l.box.y0 >= 0 && l.box.y1 <= H);
    // NEGATIVE CONTROL: switch the overlap test off and more names are placed.
    const all = cityLabels(v, W, H, MAJOR_CITIES, { padPx: -1e9 });
    assert.ok(all.length > labels.length, 'the declutter really removed overlapping names');
});

ok('a city beside the site is still named and never covers the ring (Denver next to Boulder)', () => {
    const site = { lat: 40.015, lon: -105.271 };
    const v = makeView(site.lat, site.lon, 7.5);
    const ls = cityLabels(v, 1000, 414, MAJOR_CITIES, { site });
    const den = ls.find((l) => l.name === 'Denver');
    assert.ok(den, `labels: ${ls.map((l) => l.name)}`);
    const s = geoToPx(v, 1000, 414, site.lat, site.lon);
    const b = den.box;
    assert.ok(b.x1 <= s.x - 10 || b.x0 >= s.x + 10 || b.y1 <= s.y - 10 || b.y0 >= s.y + 10, 'clear of the ring');
    // Every placement is tried: a town 40 px WEST of the site, whose name
    // would run over the ring if set to the right, is set to the left.
    const kx = scales(v, 414).kx;
    const town = { n: 'Westville', c: 'X', lat: site.lat, lon: site.lon - 40 / kx, p: 1 };
    const t = cityLabels(v, 1000, 414, [town], { site });
    assert.equal(t.length, 1, 'still named');
    assert.equal(t[0].text.align, 'right', 'set to the left of its dot (right-aligned text)');
    assert.ok(t[0].box.x1 <= s.x - 10, 'clear of the ring');
});

ok('no label touches the screen furniture it is told to avoid (the map controls)', () => {
    const v = makeView(39, -98, 30);
    const free = cityLabels(v, W, H, MAJOR_CITIES);
    // A control-sized box dropped over the biggest name's spot.
    const b0 = free[0].box;
    const ctl = { x0: b0.x0 - 20, y0: b0.y0 - 60, x1: b0.x0 + 100, y1: b0.y0 + 110 };
    const hit = (b) => !(b.x1 <= ctl.x0 || b.x0 >= ctl.x1 || b.y1 <= ctl.y0 || b.y0 >= ctl.y1);
    assert.ok(free.some((l) => hit(l.box)), 'control: without `avoid` a name lands under the controls');
    const kept = cityLabels(v, W, H, MAJOR_CITIES, { avoid: [ctl] });
    assert.ok(kept.every((l) => !hit(l.box)));
});

ok('zooming in reveals names the wider view had to drop; across the dateline cities are found on both sides', () => {
    // NW Europe is dense: at 40° span names collide, at 8° they fit.
    const wideV = makeView(50, 4, 40), closeV = makeView(50, 4, 8);
    const wide = new Set(cityLabels(wideV, W, H, MAJOR_CITIES).map((l) => l.name));
    const close = cityLabels(closeV, W, H, MAJOR_CITIES).map((l) => l.name);
    const revealed = close.filter((n) => !wide.has(n));
    assert.ok(revealed.length >= 1, `close ${close} / wide ${[...wide]}`);
    const fiji = cityLabels(makeView(-20, 180, 70), 1600, H, MAJOR_CITIES);
    assert.ok(fiji.length && fiji.every((l) => l.x >= 0 && l.x <= 1600), 'dateline: projected into the view');
    assert.ok(fiji.some((l) => l.lon < 0) && fiji.some((l) => l.lon > 0), 'both sides of 180°');
});

console.log(`\n${passed} passed`);
