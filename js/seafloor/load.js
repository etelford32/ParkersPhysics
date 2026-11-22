/**
 * load.js — fetching the baked sea-floor data (data/seafloor/*). No physics.
 * `gunzip` checks the gzip MAGIC, not the URL: a host that sends Content-Encoding: gzip has
 * already decompressed the body in transit (the glacier-catalog scar).
 */
import { makeGrid, int16FromBytes } from './bathy.js';

export const DATA_BASE = 'data/seafloor/';

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
export async function loadWorld(index, fetchFn = fetch, base = DATA_BASE) {
    const w = index.world;
    const u8 = await gunzip(await (await get(fetchFn, base + w.file)).arrayBuffer());
    const z = int16FromBytes(u8);
    if (z.length !== w.nx * w.ny) throw new Error('world grid size mismatch');
    return { nx: w.nx, ny: w.ny, step: w.step_deg, z };
}
