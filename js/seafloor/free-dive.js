/**
 * free-dive.js — a sea-floor window ANYWHERE on Earth, at the same shape as the baked ones. PURE.
 *
 * The 28 baked windows (data/seafloor/<id>.bin.gz) cover the named sites. Everywhere else the
 * page reads the SAME source live — AWS Terrain Tiles through the existing /api/climalytix/dem
 * route — and samples it onto the SAME kind of grid (1′ nodes, ±2° of latitude, longitude
 * half-width 2°/cos φ), so every kernel downstream (bathy, sounder, the 3D block) cannot tell a
 * dive window from a baked one. Tile math and the bilinear sampler are js/climalytix/terrain.js's
 * (imported, never copied): Mercator tiles are SAMPLED through the exact inverse, never stretched.
 *
 * A node whose tile is missing is a HOLE: `gridFromSampler` counts them and the page refuses a
 * window with any (`holes > 0`) rather than drawing sea level where nothing was read.
 */
import { tilesFor, tileSampler, demPath, TILE_PX } from '../climalytix/terrain.js';
import { WINDOW_HALF_DEG, GRID_ARCMIN } from './sites.js';

export const DIVE_TILE_ZOOM = 7;               // the bake's own zoom: ~1.2 km pixels at the equator, finer than the 1′ source
export const DIVE_MAX_LAT = 80;                // the window must stay inside the Mercator pyramid (85.05°)
export { demPath, TILE_PX };

/** Grid geometry of the window centred on (lat, lon) — the same fields as an index.json site entry. */
export function diveWindow(lat, lon) {
    if (!(Math.abs(lat) <= DIVE_MAX_LAT)) return null;
    const step = GRID_ARCMIN / 60, half = WINDOW_HALF_DEG;
    // snap the centre to the 1′ lattice so a re-dive at the same spot reuses the same nodes
    const cLat = Math.round(lat / step) * step, cLon = Math.round(lon / step) * step;
    let halfLon = Math.min(half / Math.max(Math.cos(cLat * Math.PI / 180), 0.2), 6);
    halfLon = Math.round(halfLon / step) * step;
    const ny = Math.round(2 * half / step) + 1, nx = Math.round(2 * halfLon / step) + 1;
    return { id: 'custom', north: cLat + half, west: cLon - halfLon, step_deg: +step.toFixed(8), nx, ny, centre: { lat: cLat, lon: cLon } };
}

export function diveTiles(win, z = DIVE_TILE_ZOOM) {
    const box = { north: win.north, south: win.north - (win.ny - 1) * win.step_deg, west: win.west, east: win.west + (win.nx - 1) * win.step_deg };
    // one tile of margin on every side: the bilinear stencil of an edge node reads its neighbour
    const pad = 360 / 2 ** z / TILE_PX * 2;
    return tilesFor({ north: Math.min(85, box.north + pad), south: Math.max(-85, box.south - pad), west: box.west - pad, east: box.east + pad }, z);
}

/** Sample `getTile(z, x, y)` (RGBA of TILE_PX² or null) onto the window. Returns { z: Int16Array, holes, deepest }. */
export function gridFromTiles(win, getTile, z = DIVE_TILE_ZOOM) {
    const heightAt = tileSampler(z, getTile);
    const out = new Int16Array(win.nx * win.ny);
    let holes = 0, k = 0, kMin = 0;
    for (let j = 0; j < win.ny; j++) {
        const lat = win.north - j * win.step_deg;
        for (let i = 0; i < win.nx; i++, k++) {
            const h = heightAt(lat, win.west + i * win.step_deg);
            if (h == null || !Number.isFinite(h)) { holes++; out[k] = 0; continue; }
            out[k] = Math.max(-32768, Math.min(32767, Math.round(h)));
            if (out[k] < out[kMin]) kMin = k;
        }
    }
    const jm = Math.floor(kMin / win.nx), im = kMin - jm * win.nx;
    return { z: out, holes, deepest: { lat: +(win.north - jm * win.step_deg).toFixed(5), lon: +(win.west + im * win.step_deg).toFixed(5), depth_m: -out[kMin] } };
}

/** The index-entry-shaped meta of a dive window, given its sampled grid. */
export function diveMeta(win, sampled) {
    let ocean = 0; const neg = [];
    for (const v of sampled.z) if (v < 0) { ocean++; neg.push(v); }
    neg.sort((a, b) => a - b);
    return { ...win, deepest: sampled.deepest, median_depth_m: neg.length ? -neg[Math.floor(neg.length / 2)] : null, ocean_fraction: ocean / sampled.z.length };
}
