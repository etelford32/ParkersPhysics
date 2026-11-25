#!/usr/bin/env node
/**
 * build-seafloor-age.mjs — bake the present-day age of the ocean floor (Seton et al. 2020) into
 * data/earth-interior/seafloor-age.bin.gz + seafloor-age.json (read by js/earth-interior/seafloor-age.js).
 *
 *   node scripts/build-seafloor-age.mjs [--src <dir>]             write the bake
 *   node scripts/build-seafloor-age.mjs --check [--src <dir>]     fail on drift
 *   node scripts/build-seafloor-age.mjs --fixture --src <dir>     write the TEXT-TWIN oracle fixture
 *
 * SOURCE. Seton, M., Müller, R. D., Zahirovic, S. et al. (2020), "A global dataset of present-day
 * oceanic crustal age and seafloor spreading parameters", G³ 21, e2020GC009214 — release 2020.1,
 * timescale GTS2012 (Ogg 2012), 6 arc-minute, gridline-registered, from EarthByte's own WebDAV
 * (earthbyte/agegrid/2020/Grids/), CC BY 4.0. INNER_EARTH_PLAN.md §8b recorded this host as
 * blocked on 2026-11-18; it answered on 2026-11-23. Without --src the file is fetched and must
 * match its sha256 pin.
 *
 * WHAT IS BAKED. The age (Myr) of every 2nd node — 0.2°, SUBSAMPLED, never averaged (the Slab2
 * rule): each baked value IS a Seton 2020 value. Rows run NORTH → SOUTH (the source file runs
 * south → north; it is flipped here, once), columns 180°W → 179.8°E (the duplicate +180° column
 * is dropped). Quantised to 0.05 Myr in uint16; 65535 = no oceanic crust (continents, and ocean
 * floor the authors did not date). Encoded as ZIG-ZAG deltas along the row inside each ocean
 * run, byte-shuffled (high bytes then low bytes), then gzip — 423 KB for 1.62 M nodes.
 *
 * THE ORACLE. The release also publishes a TEXT twin of the same grid (`.xyz`: lon, lat, age per
 * node, north → south). `--fixture` samples it — nodes ON the baked lattice (exact values) and
 * nodes BETWEEN them (interpolation) — into tests/fixtures/earth-interior/seafloor-age-xyz.json,
 * so tests/earth-interior-seafloor-age.mjs holds our binary reader and the decoder to a
 * different file of the authors': a row flip or a half-cell shift cannot pass it.
 *
 * Deterministic: gzip mtime 0 (Node's gzipSync writes 0), stable key order.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_BIN = join(ROOT, 'data/earth-interior/seafloor-age.bin.gz');
const OUT_META = join(ROOT, 'data/earth-interior/seafloor-age.json');
const FIXTURE = join(ROOT, 'tests/fixtures/earth-interior/seafloor-age-xyz.json');
const BASE = 'https://www.earthbyte.org/webdav/ftp/earthbyte/agegrid/2020/Grids/';
export const SOURCE = {
    grd: { file: 'age.2020.1.GTS2012.6m.grd', sha256: '67c1803d08050578a8b131b13788d1583192dcc3b06d470474e9529e455f2f6c' },
    xyz: { file: 'age.2020.1.GTS2012.6m.xyz', sha256: 'dd3ac333b1db95913650ae439407fd5846ec6303d79f39c379348d9695f52d2a' },
};
export const STRIDE = 2;          // every 2nd 0.1° node → 0.2°
export const QUANTUM = 0.05;      // Myr
export const NONE = 65535;

const sha = (b) => createHash('sha256').update(b).digest('hex');

/** Minimal NetCDF-3 classic (CDF-1 / CDF-2) reader — big-endian, header + fixed-size variables. */
export function readNetcdf3(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 0;
    const u8 = () => dv.getUint8(o++), i32 = () => { const v = dv.getInt32(o); o += 4; return v; };
    const magic = String.fromCharCode(u8(), u8(), u8()), ver = u8();
    if (magic !== 'CDF' || (ver !== 1 && ver !== 2)) throw new Error(`not NetCDF-3 classic (${magic}${ver})`);
    const pad = (n) => (4 - (n % 4)) % 4;
    const text = (n) => { const s = new TextDecoder().decode(buf.subarray(o, o + n)); o += n + pad(n); return s; };
    const name = () => text(i32());
    const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8 };
    const get = (type, p) => (type === 1 ? dv.getInt8(p) : type === 3 ? dv.getInt16(p) : type === 4 ? dv.getInt32(p) : type === 5 ? dv.getFloat32(p) : dv.getFloat64(p));
    const values = (type, n) => {
        if (type === 2) return text(n).replace(/\0+$/, '');
        const out = []; for (let i = 0; i < n; i++) out.push(get(type, o + i * SIZE[type]));
        o += n * SIZE[type] + pad(n * SIZE[type]);
        return out;
    };
    const list = (want) => { const tag = i32(), n = i32(); if (tag === 0 && n === 0) return 0; if (tag !== want) throw new Error(`bad list tag ${tag}`); return n; };
    const attrs = () => { const a = {}, n = list(0x0C); for (let i = 0; i < n; i++) { const k = name(), t = i32(), m = i32(); a[k] = values(t, m); } return a; };
    i32();                                                   // numrecs (no record variables here)
    const dims = []; for (let i = 0, n = list(0x0A); i < n; i++) dims.push({ name: name(), len: i32() });
    const gatts = attrs();
    const vars = {};
    for (let i = 0, n = list(0x0B); i < n; i++) {
        const vn = name(), nd = i32(), ids = []; for (let k = 0; k < nd; k++) ids.push(i32());
        const atts = attrs(), type = i32(); i32();          // vsize
        let begin; if (ver === 1) begin = i32(); else { begin = Number(dv.getBigInt64(o)); o += 8; }
        vars[vn] = { name: vn, dims: ids.map((d) => dims[d]), atts, type, begin };
    }
    const read = (vn) => {
        const v = vars[vn]; if (!v) throw new Error(`no variable ${vn}`);
        const count = v.dims.reduce((a, d) => a * d.len, 1), out = new Float64Array(count), sz = SIZE[v.type];
        for (let i = 0; i < count; i++) out[i] = get(v.type, v.begin + i * sz);
        return out;
    };
    return { version: ver, dims, gatts, vars, read };
}

/** Bake the grid: { bin (gzip bytes), meta }. */
export function bake(grdBytes) {
    const nc = readNetcdf3(grdBytes);
    const lat = nc.read('lat'), lon = nc.read('lon'), z = nc.read('z');
    const NLAT = lat.length, NLON = lon.length;
    // Read the geometry from the file, never assume it.
    const step = (lat[NLAT - 1] - lat[0]) / (NLAT - 1);
    if (!(Math.abs(Math.abs(step) - 0.1) < 1e-9 && Math.abs(lon[1] - lon[0] - 0.1) < 1e-9)) throw new Error('expected a 0.1° grid');
    if (!(Math.abs(lon[0] + 180) < 1e-9 && Math.abs(lon[NLON - 1] - 180) < 1e-9)) throw new Error('expected lon −180…+180');
    const southFirst = lat[0] < lat[NLAT - 1];
    const nLat = (NLAT - 1) / STRIDE + 1, nLon = (NLON - 1) / STRIDE;
    const q = new Uint16Array(nLat * nLon);
    let ocean = 0, oldest = { age: -1 };
    for (let i = 0; i < nLat; i++) {
        const src = southFirst ? NLAT - 1 - i * STRIDE : i * STRIDE;           // output row 0 = NORTH
        for (let j = 0; j < nLon; j++) {
            const v = z[src * NLON + j * STRIDE];
            if (Number.isNaN(v)) { q[i * nLon + j] = NONE; continue; }
            const k = Math.round(v / QUANTUM);
            if (k >= NONE) throw new Error(`age ${v} overflows the quantum`);
            q[i * nLon + j] = k; ocean++;
            if (v > oldest.age) oldest = { age: v, lat: lat[src], lon: lon[j * STRIDE] };
        }
    }
    const n = q.length, zz = new Uint16Array(n);
    for (let k = 0, prev = 0; k < n; k++) {
        if (k % nLon === 0) prev = 0;
        if (q[k] === NONE) { zz[k] = NONE; prev = 0; continue; }
        const d = q[k] - prev; zz[k] = d >= 0 ? 2 * d : -2 * d - 1; prev = q[k];
        if (zz[k] >= NONE) throw new Error('delta collides with the land code');
    }
    const shuf = Buffer.alloc(2 * n);
    for (let k = 0; k < n; k++) { shuf[k] = zz[k] >> 8; shuf[n + k] = zz[k] & 255; }
    const bin = gzipSync(shuf, { level: 9 });
    const meta = {
        source: {
            citation: 'Seton, M., Müller, R. D., Zahirovic, S., Williams, S., Wright, N., Cannon, J., Whittaker, J., Matthews, K., McGirr, R. (2020). A global dataset of present-day oceanic crustal age and seafloor spreading parameters. Geochemistry, Geophysics, Geosystems 21, e2020GC009214. doi:10.1029/2020GC009214',
            release: '2020.1', timescale: 'GTS2012 (Ogg 2012)', url: BASE + SOURCE.grd.file, sha256: SOURCE.grd.sha256,
            licence: 'CC BY 4.0 (earthbyte/agegrid/2020/LICENSE.txt)',
            knownArtefacts: 'Gridding artefacts around microplates (e.g. Bauer), along fracture zones (e.g. central Atlantic) and where spreading is highly oblique (e.g. SW Indian Ridge) — the release README.',
        },
        grid: { nLat, nLon, stepDeg: 0.1 * STRIDE, lat0: 90, lon0: -180, registration: 'gridline', rows: 'north→south', quantumMyr: QUANTUM, none: NONE,
            encoding: 'uint16 ages / quantum; zig-zag delta along each row, reset at every no-crust node and at each row start; byte-shuffled (all high bytes, then all low bytes); gzip' },
        counts: { nodes: n, oceanNodes: ocean },
        oldestNode: { ageMyr: Math.round(oldest.age * 100) / 100, lat: Math.round(oldest.lat * 1e4) / 1e4, lon: Math.round(oldest.lon * 1e4) / 1e4 },
        output: { file: 'seafloor-age.bin.gz', bytes: bin.length, sha256: sha(bin) },
    };
    return { bin, meta };
}

/** Sample the TEXT twin into the oracle fixture (seeded). */
export function fixtureFromXyz(text) {
    // mulberry32 (a bare 32-bit LCG's draws were correlated enough to skip every between-node sample).
    let a = 20261125 >>> 0;
    const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const on = [], off = [];
    let line = 0;
    for (const row of text.split('\n')) {
        if (!row) continue;
        const [lo, la, a] = row.split('\t');
        const lon = Number(lo), lat = Number(la), age = a.trim() === 'NaN' ? null : Number(a);
        const onLattice = Math.abs(Math.round(lat * 10) % 2) === 0 && Math.abs(Math.round(lon * 10) % 2) === 0 && Math.abs(lon - 180) > 1e-9;
        const r = rnd();
        if (onLattice && r < 4.5e-3) on.push([lat, lon, age]);
        else if (!onLattice && r < 3e-4) off.push([lat, lon, age]);
        line++;
    }
    return { note: 'Nodes of Seton et al. (2020) read from the release TEXT twin (age.2020.1.GTS2012.6m.xyz) — written by scripts/build-seafloor-age.mjs --fixture; never hand-edit',
        xyzSha256: SOURCE.xyz.sha256, lines: line, fields: ['lat', 'lon', 'ageMyr (null = no oceanic crust)'], onLattice: on, between: off };
}

async function fetchPinned(spec, srcDir) {
    const path = srcDir && join(srcDir, spec.file);
    let buf;
    if (path && existsSync(path)) buf = readFileSync(path);
    else {
        const r = await fetch(BASE + spec.file);
        if (!r.ok) throw new Error(`${spec.file}: HTTP ${r.status}`);
        buf = Buffer.from(await r.arrayBuffer());
    }
    if (sha(buf) !== spec.sha256) throw new Error(`${spec.file}: sha256 ${sha(buf)} does not match the pin`);
    return buf;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const args = process.argv.slice(2), flag = (f) => args.includes(f);
    const src = args.includes('--src') ? args[args.indexOf('--src') + 1] : null;
    if (flag('--fixture')) {
        const text = (await fetchPinned(SOURCE.xyz, src)).toString('utf8');
        const fx = fixtureFromXyz(text);
        mkdirSync(dirname(FIXTURE), { recursive: true });
        writeFileSync(FIXTURE, JSON.stringify(fx) + '\n');
        console.log(`wrote ${FIXTURE} (${fx.onLattice.length} on-lattice, ${fx.between.length} between-node samples of ${fx.lines} lines)`);
    } else {
        const { bin, meta } = bake(await fetchPinned(SOURCE.grd, src));
        const metaText = JSON.stringify(meta, null, 1) + '\n';
        if (flag('--check')) {
            const ok = existsSync(OUT_BIN) && readFileSync(OUT_BIN).equals(bin) && existsSync(OUT_META) && readFileSync(OUT_META, 'utf8') === metaText;
            if (!ok) { console.error('seafloor-age bake is STALE — run node scripts/build-seafloor-age.mjs'); process.exit(1); }
            console.log('seafloor-age: bake reproduces byte-for-byte');
        } else {
            writeFileSync(OUT_BIN, bin); writeFileSync(OUT_META, metaText);
            console.log(`wrote seafloor-age.bin.gz (${bin.length.toLocaleString()} bytes, ${meta.counts.oceanNodes.toLocaleString()} ocean nodes; oldest ${meta.oldestNode.ageMyr} Myr at ${meta.oldestNode.lat}, ${meta.oldestNode.lon})`);
        }
    }
}
