/**
 * load.js — fetching the baked sea-floor data (data/seafloor/*). No physics.
 * `gunzip` checks the gzip MAGIC, not the URL: a host that sends Content-Encoding: gzip has
 * already decompressed the body in transit (the glacier-catalog scar).
 */
import { makeGrid, int16FromBytes, decodeWorld } from './bathy.js';
import { diveWindow, diveTiles, gridFromTiles, diveMeta, demPath, TILE_PX, DIVE_TILE_ZOOM } from './free-dive.js';

import { decodePlates } from '../earth-interior/plates.js';
import { decodeSlabs } from '../earth-interior/slabs.js';

export const DATA_BASE = 'data/seafloor/';
/** The Inner Earth page's own baked files (Bird PB2002 plates, USGS Slab2) — read, never copied. */
export const TECTONICS_BASE = 'data/earth-interior/';

export async function gunzip(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    if (!(u8[0] === 0x1f && u8[1] === 0x8b)) return u8;
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function get(fetchFn, url) { const r = await fetchFn(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r; }

export async function loadIndex(fetchFn = fetch, base = DATA_BASE) { return (await get(fetchFn, base + 'index.json')).json(); }
export async function loadCasts(fetchFn = fetch, base = DATA_BASE) {
    const u8 = await gunzip(await (await get(fetchFn, base + 'casts.json.gz')).arrayBuffer());
    return JSON.parse(new TextDecoder().decode(u8));
}
export async function loadGrid(meta, fetchFn = fetch, base = DATA_BASE) {
    const u8 = await gunzip(await (await get(fetchFn, base + meta.id + '.bin.gz')).arrayBuffer());
    return makeGrid(meta, int16FromBytes(u8));
}
/** A trench site's WIDE window (index `wide` entry): coarser, ±5°, read only for the bending plate's far field. */
export async function loadWideGrid(meta, fetchFn = fetch, base = DATA_BASE) {
    if (!meta || !meta.wide) return null;
    const u8 = await gunzip(await (await get(fetchFn, base + meta.wide.file)).arrayBuffer());
    return makeGrid(meta.wide, int16FromBytes(u8));
}
export async function loadWorld(index, fetchFn = fetch, base = DATA_BASE) {
    const u8 = await gunzip(await (await get(fetchFn, base + index.world.file)).arrayBuffer());
    return decodeWorld(index.world, u8);
}

/** One Terrarium tile through our route → RGBA bytes (browser only: decoded on a canvas). */
async function tileRgba(t) {
    const r = await fetch(demPath(t));
    if (!r.ok) throw new Error(`tile ${t.z}/${t.x}/${t.y}: HTTP ${r.status}`);
    const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = document.createElement('canvas'); c.width = c.height = TILE_PX;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
    return g.getImageData(0, 0, TILE_PX, TILE_PX).data;
}

/**
 * The sea floor around ANY point, read live from the same tiles the baked windows came from.
 * Throws when the point is outside the pyramid, a tile is missing, or the window has a hole —
 * the page then says so and draws nothing (never a flat sea floor where nothing was read).
 */
export async function loadDiveGrid(lat, lon) {
    const win = diveWindow(lat, lon);
    if (!win) throw new Error('outside the tile pyramid');
    const tiles = diveTiles(win), got = new Map();
    await Promise.all(tiles.map(async (t) => { got.set(`${t.z}/${t.x}/${t.y}`, await tileRgba(t)); }));
    const sampled = gridFromTiles(win, (z, x, y) => got.get(`${z}/${x}/${y}`) || null, DIVE_TILE_ZOOM);
    if (sampled.holes) throw new Error(`${sampled.holes} grid nodes could not be read`);
    const meta = diveMeta(win, sampled);
    return { meta, grid: makeGrid(meta, sampled.z) };
}

async function gzJson(fetchFn, url) { return JSON.parse(new TextDecoder().decode(await gunzip(await (await get(fetchFn, url)).arrayBuffer()))); }
export async function loadPlates(fetchFn = fetch, base = TECTONICS_BASE) { return decodePlates(await gzJson(fetchFn, base + 'plates-pb2002.json.gz')); }
export async function loadSlabs(fetchFn = fetch, base = TECTONICS_BASE) { return decodeSlabs(await gzJson(fetchFn, base + 'slab2.json.gz')); }
