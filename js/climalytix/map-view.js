/**
 * climalytix/map-view.js — the location map's geometry, PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch: tests/climalytix-map-view.mjs pins every rule here, and
 * js/climalytix/map.js only draws what this returns.
 *
 * PROJECTION. Equirectangular with its true-scale parallel at the VIEW
 * CENTRE: 1° of latitude is `ky` px and 1° of longitude is ky·cos(φ_centre)
 * px. GIBS EPSG:4326 tiles are plate carrée, so drawing them at that aspect
 * is a pure scale — and the heat field (a lat/lon grid) lands on the same
 * pixels with no reprojection. A plain 1:1 plate carrée would stretch a 40°N
 * site 1.3× east–west; this is the projection every regional weather map
 * uses for a few degrees around a point. Clamped at cos ≥ 0.15 so a polar
 * site still draws.
 *
 * ZOOM AT THE CURSOR. `zoomAt` keeps the ground under the pointer under the
 * pointer: latitude first (ky depends only on the span), then longitude with
 * the NEW centre's cos φ — solving in that order makes it exact, which the
 * gate asserts to 1e-9 px.
 *
 * TILES. GIBS 4326 matrices are 288/2^z° tiles with PADDED right/bottom edges
 * (js/earth-detail-inset.js tileSpanDeg — the ONE copy of that grid; a
 * power-of-two pyramid requests tiles that do not exist). A window across the
 * dateline is split into two canonical longitude intervals, each drawn at its
 * own 360° offset, and every tile's source rectangle is CLIPPED to ≤ 180°E and
 * ≥ 90°S so a padded edge tile never paints its blank padding over the other
 * side of the world.
 */

import { tileSpanDeg, tilesAcross, tilesDown } from '../earth-detail-inset.js';
import { TEMP_LUT_SIZE, TEMP_ENCODE_MIN_C, TEMP_ENCODE_SPAN_C } from '../temp-ramp.js';

export const SPAN_MIN_DEG = 0.35;
export const SPAN_MAX_DEG = 70;
export const SPAN_DEFAULT_DEG = 7.5;
export const ZOOM_STEP = 1.6;
export const PAN_STEP = 0.25;          // fraction of the visible extent per D-pad press
export const TILE_PX = 512;
const KM_PER_DEG = 111.32;
const COS_FLOOR = 0.15;

/** Longitude expressed in the turn nearest `ref`. */
export function wrapNear(lon, ref) {
    let v = lon;
    while (v - ref > 180) v -= 360;
    while (v - ref < -180) v += 360;
    return v;
}

/** Longitude in [-180, 180). */
export function wrap180(lon) {
    const v = ((((lon + 180) % 360) + 360) % 360) - 180;
    return v + 0;
}

export function makeView(lat, lon, span = SPAN_DEFAULT_DEG) {
    return clampView({ lat, lon, span });
}

/** Span inside [MIN, MAX]; the view never shows past a pole; lon in [-180,180). */
export function clampView(v) {
    const span = Math.min(SPAN_MAX_DEG, Math.max(SPAN_MIN_DEG, v.span));
    const half = span / 2;
    const lat = Math.min(90 - half, Math.max(-90 + half, v.lat));
    return { lat, lon: wrap180(v.lon), span };
}

/** px per degree: { kx, ky }. */
export function scales(v, h) {
    const ky = h / v.span;
    const kx = ky * Math.max(COS_FLOOR, Math.cos(v.lat * Math.PI / 180));
    return { kx, ky };
}

export function geoToPx(v, w, h, lat, lon) {
    const { kx, ky } = scales(v, h);
    return { x: w / 2 + (wrapNear(lon, v.lon) - v.lon) * kx, y: h / 2 - (lat - v.lat) * ky };
}

export function pxToGeo(v, w, h, x, y) {
    const { kx, ky } = scales(v, h);
    return { lat: v.lat - (y - h / 2) / ky, lon: v.lon + (x - w / 2) / kx };
}

/** Visible geographic box (lon UNWRAPPED around the centre). */
export function viewBounds(v, w, h) {
    const nw = pxToGeo(v, w, h, 0, 0), se = pxToGeo(v, w, h, w, h);
    return { north: nw.lat, south: se.lat, west: nw.lon, east: se.lon };
}

/**
 * Zoom by `factor` (> 1 = in) keeping the ground under (px, py) fixed. At a
 * span limit the view does not move at all (a clamped zoom must not pan).
 */
export function zoomAt(v, factor, px, py, w, h) {
    const span = Math.min(SPAN_MAX_DEG, Math.max(SPAN_MIN_DEG, v.span / factor));
    if (span === v.span) return v;
    const g = pxToGeo(v, w, h, px, py);
    const ky = h / span;
    const lat = g.lat + (py - h / 2) / ky;
    const kx = ky * Math.max(COS_FLOOR, Math.cos(lat * Math.PI / 180));
    const lon = g.lon - (px - w / 2) / kx;
    return clampView({ lat, lon, span });
}

/** Move the view by a screen displacement (drag: content follows the pointer). */
export function panBy(v, dx, dy, w, h) {
    const { kx, ky } = scales(v, h);
    return clampView({ lat: v.lat + dy / ky, lon: v.lon - dx / kx, span: v.span });
}

/** D-pad step: a quarter of the visible extent in that direction. */
export function panStep(v, dir, w, h) {
    const d = { up: [0, 1], down: [0, -1], left: [1, 0], right: [-1, 0] }[dir];
    if (!d) return v;
    return panBy(v, d[0] * w * PAN_STEP, d[1] * h * PAN_STEP, w, h);
}

/**
 * The GIBS tiles covering the view at device resolution.
 * Returns { z, tiles: [{ z, row, col, lonOffset, src: {sx,sy,sw,sh}, geo: {west,north,east,south} }] }
 * `geo` is in the view's unwrapped longitudes (canonical + lonOffset).
 */
export function tilePlan(v, w, h, { dpr = 1, maxLevel = 7, minLevel = 0, maxTiles = 48 } = {}) {
    const { ky } = scales(v, h);
    const needPxPerDeg = ky * dpr;
    let z = minLevel;
    while (z < maxLevel && (TILE_PX / tileSpanDeg(z)) < needPxPerDeg) z++;
    const b = viewBounds(v, w, h);
    // Canonical longitude intervals with the offset that maps them back to the view.
    const intervals = [];
    const start = Math.floor((b.west + 180) / 360);       // which turn the west edge is in
    for (let k = start; k * 360 - 180 < b.east; k++) {
        const lo = Math.max(b.west, k * 360 - 180), hi = Math.min(b.east, k * 360 + 180);
        if (hi > lo) intervals.push({ lo: lo - k * 360, hi: hi - k * 360, offset: k * 360 });
    }
    const span = tileSpanDeg(z);
    const nAcross = tilesAcross(z), nDown = tilesDown(z);
    const r0 = Math.max(0, Math.floor((90 - Math.min(90, b.north)) / span));
    const r1 = Math.min(nDown - 1, Math.floor((90 - Math.max(-90, b.south)) / span - 1e-9));
    const tiles = [];
    for (const iv of intervals) {
        const c0 = Math.max(0, Math.floor((iv.lo + 180) / span));
        const c1 = Math.min(nAcross - 1, Math.floor((iv.hi + 180) / span - 1e-9));
        for (let row = r0; row <= r1; row++) {
            for (let col = c0; col <= c1; col++) {
                const west = -180 + col * span, north = 90 - row * span;
                const east = Math.min(180, west + span), south = Math.max(-90, north - span);
                const pxPerDeg = TILE_PX / span;
                tiles.push({
                    z, row, col, lonOffset: iv.offset,
                    src: { sx: 0, sy: 0, sw: (east - west) * pxPerDeg, sh: (north - south) * pxPerDeg },
                    geo: { west: west + iv.offset, east: east + iv.offset, north, south },
                });
            }
        }
    }
    if (tiles.length > maxTiles) return tilePlan(v, w, h, { dpr, maxLevel: z - 1, minLevel, maxTiles });
    return { z, tiles };
}

/** A round-number scale bar no longer than maxPx at the view centre. */
export function scaleBar(v, h, maxPx = 120) {
    const { ky } = scales(v, h);
    const pxPerKm = ky / KM_PER_DEG;
    const maxKm = maxPx / pxPerKm;
    const p = 10 ** Math.floor(Math.log10(maxKm));
    const km = [5, 2, 1].map((m) => m * p).find((x) => x <= maxKm) ?? p;
    return { km, px: km * pxPerKm, label: km >= 1 ? `${km} km` : `${Math.round(km * 1000)} m` };
}

// ── The heat field ─────────────────────────────────────────────────────────

/** Index of the field time nearest `ms`, or null outside the run (± half a step). */
export function fieldTimeIndex(times, ms) {
    if (!times?.length || !Number.isFinite(ms)) return null;
    const step = times.length > 1 ? times[1] - times[0] : 3 * 3_600_000;
    if (ms < times[0] - step / 2 || ms > times[times.length - 1] + step / 2) return null;
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - ms) < Math.abs(times[best] - ms)) best = i;
    return best;
}

/** Bilinear value at (lat, lon) for time index t; null outside or on a gap corner. */
export function fieldSample(f, t, lat, lon) {
    if (!f?.values || t == null) return null;
    const y = (f.latN - lat) / f.dlat;
    const x = (wrapNear(lon, f.lonW + 180) - f.lonW) / f.dlon;
    if (y < 0 || x < 0 || y > f.nRows - 1 || x > f.nCols - 1) return null;
    const i = Math.min(Math.floor(y), f.nRows - 2), j = Math.min(Math.floor(x), f.nCols - 2);
    const fy = y - i, fx = x - j;
    const base = t * f.nRows * f.nCols;
    const q = [f.values[base + i * f.nCols + j], f.values[base + i * f.nCols + j + 1],
               f.values[base + (i + 1) * f.nCols + j], f.values[base + (i + 1) * f.nCols + j + 1]];
    if (q.some((x) => x == null || !Number.isFinite(x))) return null;
    return (1 - fy) * ((1 - fx) * q[0] + fx * q[1]) + fy * ((1 - fx) * q[2] + fx * q[3]);
}

/** Min/max of one time's plane (null when the plane is all gaps). */
export function fieldRange(f, t) {
    if (!f?.values || t == null) return null;
    let lo = Infinity, hi = -Infinity;
    const base = t * f.nRows * f.nCols;
    for (let k = 0; k < f.nRows * f.nCols; k++) {
        const v = f.values[base + k];
        if (v == null || !Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    return lo <= hi ? { min: lo, max: hi } : null;
}

/**
 * RGBA pixels (one per grid NODE) for time t through the site-wide
 * temperature LUT (js/temp-ramp.js — the same bytes as EarthView's key).
 * A gap is alpha 0, never a colour.
 */
export function heatPixels(f, t, lut) {
    const n = f.nRows * f.nCols;
    const out = new Uint8ClampedArray(n * 4);
    const base = t * n;
    for (let k = 0; k < n; k++) {
        const v = f.values[base + k];
        if (v == null || !Number.isFinite(v)) continue;
        const idx = Math.max(0, Math.min(TEMP_LUT_SIZE - 1,
            Math.round(((v - TEMP_ENCODE_MIN_C) / TEMP_ENCODE_SPAN_C) * (TEMP_LUT_SIZE - 1))));
        out.set(lut.subarray(idx * 4, idx * 4 + 3), k * 4);
        out[k * 4 + 3] = 255;
    }
    return out;
}

/**
 * Where the node raster goes on the map: pixel CENTRES on the nodes, so the
 * image extends half a cell past the outer nodes (canvas smoothing then
 * interpolates between nodes — display only, the readout samples the data).
 */
export function heatGeoRect(f) {
    return {
        west: f.lonW - f.dlon / 2, east: f.lonW + (f.nCols - 0.5) * f.dlon,
        north: f.latN + f.dlat / 2, south: f.latN - (f.nRows - 0.5) * f.dlat,
    };
}
