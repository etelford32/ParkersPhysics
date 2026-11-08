/**
 * climalytix/basemap.js — the location map's base layers, PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch (tests/climalytix-basemap.mjs pins every rule); map.js
 * draws what this returns.
 *
 * THE UNDERLAY. The map's ground is EarthView's own self-hosted NASA Blue
 * Marble (assets/earth/day-{1k,2k,4k}.webp — the files the homepage hero and
 * earth.html already ship; see assets/earth/SOURCES.md). It is same-origin, so
 * it paints at once and survives NASA GIBS being down; the GIBS 500 m tiles
 * still draw over it wherever they load. Both are ARCHIVAL composites and the
 * attribution says so. The images are plate carrée over −180…180 / 90…−90, so
 * `underlayRects` is the same interval split as the tile plan's: one source
 * rectangle per 360° turn the view touches, each clipped to the image, placed
 * linearly in the view's own longitudes.
 *
 * THE TERRAIN. A hillshade of assets/earth/relief-2k.webp (normalised
 * elevation, sea = 0) computed once in the page. Two rules, both measured
 * scars elsewhere on the site:
 *   · SOBEL ON A 2-TEXEL BASELINE (central differences, rows weighted 1-2-1)
 *     — EarthView's `topoGradient` rule. The relief map is 8-bit; over flat
 *     ground neighbouring texels differ by under one level, so a one-texel
 *     FORWARD difference turns every quantisation step into a lit ridge. The
 *     gate's negative control is that forward difference on a quantised ramp.
 *   · The east–west spacing is cos φ times the north–south one, so a slope is
 *     a slope at every latitude (floored like the projection's COS_FLOOR).
 * The output is NEUTRAL GREY (128) wherever the ground is flat — sea, plains —
 * and is composited with 'overlay', so flat ground leaves the imagery exactly
 * as it was and only slopes lighten or darken it. The light is the
 * CARTOGRAPHIC convention (from the north-west, 45° up), not today's Sun;
 * the relief is vertically exaggerated by RELIEF_EXAGGERATION. Both are
 * printed in the rail. The relief map is ~20 km per texel at the equator, so
 * nothing finer than that is drawn — the rail says that too.
 *
 * PLACE LABELS. EarthView's own city list (js/data/major-cities.js) — the
 * unverified GIBS "Reference_Labels" overlay this replaces could not be
 * confirmed from the build sandbox. `cityLabels` takes the cities inside the
 * view, biggest metro first, and places each label only where its box clears
 * every box already placed (and the site marker), so the map shows as many
 * names as fit and never a pile-up; zooming in reveals smaller cities.
 */

import { geoToPx, viewBounds, scales, wrapNear } from './map-view.js';

export const UNDERLAY_TIERS = Object.freeze([
    Object.freeze({ id: '1k', width: 1024, src: 'assets/earth/day-1k.webp' }),
    Object.freeze({ id: '2k', width: 2048, src: 'assets/earth/day-2k.webp' }),
    Object.freeze({ id: '4k', width: 4096, src: 'assets/earth/day-4k.webp' }),
]);
export const RELIEF_SRC = 'assets/earth/relief-2k.webp';
/** Normalised relief: level 255 is taken as this many metres (nominal, disclosed). */
export const RELIEF_TOP_M = 8848;
export const RELIEF_EXAGGERATION = 10;
export const LIGHT_AZIMUTH_DEG = 315;      // from the north-west (cartographic convention)
export const LIGHT_ALTITUDE_DEG = 45;
const COS_FLOOR = 0.15;
const KM_PER_DEG = 111.32;

/**
 * The smallest underlay tier with at least one texel per device pixel along
 * longitude at the view centre; the largest when none is enough.
 */
export function underlayTier(v, w, h, dpr = 1, tiers = UNDERLAY_TIERS) {
    const need = scales(v, h).kx * dpr;                 // device px per degree of longitude
    return tiers.find((t) => t.width / 360 >= need) ?? tiers[tiers.length - 1];
}

/**
 * Source rectangles of an equirectangular whole-world image (W × H, lon
 * −180…180, lat 90…−90) covering the view, one per 360° turn, each with the
 * geographic box it lands on in the view's unwrapped longitudes.
 */
export function underlayRects(v, w, h, W, H) {
    const b = viewBounds(v, w, h);
    const north = Math.min(90, b.north), south = Math.max(-90, b.south);
    if (!(north > south)) return [];
    const out = [];
    const start = Math.floor((b.west + 180) / 360);
    for (let k = start; k * 360 - 180 < b.east; k++) {
        const lo = Math.max(b.west, k * 360 - 180), hi = Math.min(b.east, k * 360 + 180);
        if (!(hi > lo)) continue;
        const cLo = lo - k * 360, cHi = hi - k * 360;     // canonical [-180, 180]
        out.push({
            sx: (cLo + 180) / 360 * W, sw: (cHi - cLo) / 360 * W,
            sy: (90 - north) / 180 * H, sh: (north - south) / 180 * H,
            geo: { west: lo, east: hi, north, south },
        });
    }
    return out;
}

/**
 * Hillshade of an 8-bit height map (Uint8 levels, row-major, W × H, plate
 * carrée whole world; columns WRAP, rows clamp at the poles).
 * Returns Uint8ClampedArray of W·H grey levels, 128 = flat.
 * opts.method 'sobel2' (shipped) | 'forward' (the negative control).
 */
export function hillshade(levels, W, H, {
    method = 'sobel2', exaggeration = RELIEF_EXAGGERATION, topM = RELIEF_TOP_M,
    azimuthDeg = LIGHT_AZIMUTH_DEG, altitudeDeg = LIGHT_ALTITUDE_DEG,
} = {}) {
    const out = new Uint8ClampedArray(W * H);
    const mPerLevel = topM / 255;
    const dyM = 180 / H * KM_PER_DEG * 1000;            // metres per texel north–south
    const az = azimuthDeg * Math.PI / 180, alt = altitudeDeg * Math.PI / 180;
    // Light direction in (east, north, up).
    const lx = Math.sin(az) * Math.cos(alt), ly = Math.cos(az) * Math.cos(alt), lz = Math.sin(alt);
    const flat = lz;
    const at = (i, j) => levels[Math.min(H - 1, Math.max(0, i)) * W + ((j % W) + W) % W];
    for (let i = 0; i < H; i++) {
        const lat = 90 - (i + 0.5) * 180 / H;
        const dxM = dyM * Math.max(COS_FLOOR, Math.cos(lat * Math.PI / 180));
        for (let j = 0; j < W; j++) {
            let gx, gy;                                       // levels per texel, east / north
            if (method === 'forward') {
                gx = at(i, j + 1) - at(i, j);
                gy = at(i, j) - at(i + 1, j);
            } else {
                // Sobel: central differences over 2 texels, rows/cols weighted 1-2-1, ÷ 8.
                gx = ((at(i - 1, j + 1) - at(i - 1, j - 1)) + 2 * (at(i, j + 1) - at(i, j - 1))
                    + (at(i + 1, j + 1) - at(i + 1, j - 1))) / 8;
                gy = ((at(i - 1, j - 1) - at(i + 1, j - 1)) + 2 * (at(i - 1, j) - at(i + 1, j))
                    + (at(i - 1, j + 1) - at(i + 1, j + 1))) / 8;
            }
            // Slopes (rise over run), exaggerated.
            const sx = gx * mPerLevel / dxM * exaggeration, sy = gy * mPerLevel / dyM * exaggeration;
            // Surface normal (−sx, −sy, 1) / |…|, dotted with the light.
            const cos = (-sx * lx - sy * ly + lz) / Math.hypot(sx, sy, 1);
            out[i * W + j] = 128 * Math.max(0, cos) / flat;
        }
    }
    return out;
}

/**
 * City labels that fit the view without overlapping each other or the site
 * marker. cities: [{ n, c, lat, lon, p }]. Returns
 * [{ name, lat, lon, x, y, p, text:{x,y,align}, box }] biggest metro first.
 * Each label tries right of its dot, then left, below, above; `box` covers
 * dot + text. opts.avoid: screen boxes ({x0,y0,x1,y1}) no label may touch. opts.measure estimates text width (the page passes measureText).
 */
export function cityLabels(v, w, h, cities, {
    site = null, siteRadiusPx = 10, avoid = [], measure = (s) => s.length * 6.4, max = 60, padPx = 3, dotPx = 3, edgePx = 4,
} = {}) {
    const b = viewBounds(v, w, h);
    const placed = [];
    const boxes = [];
    if (site) {
        const p = geoToPx(v, w, h, site.lat, site.lon);
        // The site ring (map.js draws r = 8 at 2.5 px stroke) — a label may
        // sit right beside it, it may not cover it.
        boxes.push({ x0: p.x - siteRadiusPx, y0: p.y - siteRadiusPx, x1: p.x + siteRadiusPx, y1: p.y + siteRadiusPx, pad: 1 });
    }
    // Screen furniture drawn over the canvas (the zoom/pan controls, the
    // attribution strip): a name under it could not be read.
    for (const a of avoid) boxes.push({ ...a, pad: 2 });
    const clear = (r) => boxes.every((q) => {
        const g = q.pad ?? padPx;
        return r.x1 + g <= q.x0 || q.x1 + g <= r.x0 || r.y1 + g <= q.y0 || q.y1 + g <= r.y0;
    });
    const visible = cities.filter((c) => c.lat <= b.north && c.lat >= b.south
        && wrapNear(c.lon, v.lon) >= b.west && wrapNear(c.lon, v.lon) <= b.east);
    visible.sort((a, b2) => b2.p - a.p || a.n.localeCompare(b2.n));
    for (const c of visible) {
        if (placed.length >= max) break;
        const p = geoToPx(v, w, h, c.lat, c.lon);
        const tw = measure(c.n);
        const dot = { x0: p.x - dotPx, y0: p.y - dotPx, x1: p.x + dotPx, y1: p.y + dotPx };
        // Right of the dot first (the cartographic default), then left, below, above.
        const spots = [
            { x: p.x + dotPx + 3, y: p.y, align: 'left', t: { x0: p.x + dotPx + 3, y0: p.y - 7, x1: p.x + dotPx + 3 + tw, y1: p.y + 7 } },
            { x: p.x - dotPx - 3, y: p.y, align: 'right', t: { x0: p.x - dotPx - 3 - tw, y0: p.y - 7, x1: p.x - dotPx - 3, y1: p.y + 7 } },
            { x: p.x, y: p.y + dotPx + 9, align: 'center', t: { x0: p.x - tw / 2, y0: p.y + dotPx + 2, x1: p.x + tw / 2, y1: p.y + dotPx + 16 } },
            { x: p.x, y: p.y - dotPx - 9, align: 'center', t: { x0: p.x - tw / 2, y0: p.y - dotPx - 16, x1: p.x + tw / 2, y1: p.y - dotPx - 2 } },
        ];
        for (const s of spots) {
            const box = { x0: Math.min(dot.x0, s.t.x0), y0: Math.min(dot.y0, s.t.y0), x1: Math.max(dot.x1, s.t.x1), y1: Math.max(dot.y1, s.t.y1) };
            if (box.x0 < edgePx || box.y0 < edgePx || box.x1 > w - edgePx || box.y1 > h - edgePx) continue;
            if (!clear(box)) continue;
            boxes.push(box);
            placed.push({ name: c.n, lat: c.lat, lon: c.lon, p: c.p, x: p.x, y: p.y, text: { x: s.x, y: s.y, align: s.align }, box });
            break;
        }
    }
    return placed;
}

/** Ground resolution of the relief map at a latitude, in km per texel east–west. */
export function reliefKmPerTexel(lat, W = 2048) {
    return 360 / W * KM_PER_DEG * Math.max(COS_FLOOR, Math.cos(lat * Math.PI / 180));
}
