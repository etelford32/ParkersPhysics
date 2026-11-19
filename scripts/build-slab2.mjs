#!/usr/bin/env node
/**
 * build-slab2.mjs — bake USGS Slab2 (Hayes et al. 2018) into
 * data/earth-interior/slab2.json.gz (read by js/earth-interior/slabs.js).
 *
 *   node scripts/build-slab2.mjs --src <dir>            write the bake
 *   node scripts/build-slab2.mjs --check --src <dir>    fail on drift
 *   node scripts/build-slab2.mjs --pins --src <dir>     print the sha256 pins
 *
 * Source: the Slab2 release files (02.23–02.26.18, "Slab2, version
 * 03/01/2018"), copied in ndb38/arc-metals @ 543bf32
 * (1_arc-metals/supporting_datasets/Hayes2018/Slab2_TXT/*.xyz — the text
 * twins of the .grd grids; ScienceBase doi:10.5066/F7PV6JNV is the canonical
 * host). USGS work: public domain. Without --src the 54 files are fetched
 * from that commit (≈140 MB) and every one must match its sha256 pin.
 *
 * What is baked, per slab: depth to the slab SURFACE (km, positive DOWN —
 * Slab2 stores it NEGATIVE; the sign is flipped here, once) and its 1σ
 * uncertainty, SUBSAMPLED (never averaged) to 0.2° (~22 km): every 4th node
 * of the 0.05° grids, every 10th of the few 0.02° ones. Every baked value is a Slab2 value; the kernel
 * interpolates between them. Nodes Slab2 leaves NaN (outside its clipping
 * mask) stay null. The four overturned slabs' supplementary nodes (dip > 90°)
 * are NOT baked — the surface is single-valued here and the page says so.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data/earth-interior/slab2.json.gz');
const BASE = 'https://raw.githubusercontent.com/ndb38/arc-metals/543bf32cabaa97384a28c0b83304975be4079ddb/1_arc-metals/supporting_datasets/Hayes2018/Slab2_TXT/';
const TARGET_STEP = 0.2;     // degrees: stride = round(0.2 / the slab's own step) — most slabs 0.05° (×4), small ones 0.02° (×10)

// Slab2 codes → region names (Hayes et al. 2018, Table 1) and the release-date suffix of each file.
export const SLABS = {
    alu: ['Aleutians', '02.23.18'], cal: ['Calabria', '02.24.18'], cam: ['Central America', '02.24.18'],
    car: ['Caribbean', '02.24.18'], cas: ['Cascadia', '02.24.18'], cot: ['Cotabato', '02.24.18'],
    hal: ['Halmahera', '02.23.18'], hel: ['Hellenic', '02.24.18'], him: ['Himalaya', '02.24.18'],
    hin: ['Hindu Kush', '02.24.18'], izu: ['Izu–Bonin', '02.24.18'], ker: ['Kermadec–Tonga', '02.24.18'],
    kur: ['Kuril–Kamchatka', '02.24.18'], mak: ['Makran', '02.24.18'], man: ['Manila', '02.24.18'],
    mue: ['Muertos', '02.24.18'], pam: ['Pamir', '02.26.18'], phi: ['Philippines', '02.26.18'],
    png: ['New Guinea', '02.26.18'], puy: ['Puysegur', '02.26.18'], ryu: ['Ryukyu', '02.26.18'],
    sam: ['South America', '02.23.18'], sco: ['Scotia', '02.23.18'], sol: ['Solomon Islands', '02.23.18'],
    sul: ['Sulawesi', '02.23.18'], sum: ['Sumatra–Java', '02.23.18'], van: ['Vanuatu', '02.23.18'],
};
const PINS = JSON.parse(readFileSync(join(ROOT, 'scripts/slab2-pins.json'), 'utf8'));

const args = process.argv.slice(2);
const CHECK = args.includes('--check'), PRINT_PINS = args.includes('--pins');
const srcAt = args.indexOf('--src');
const SRC = srcAt >= 0 ? args[srcAt + 1] : null;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fileName = (code, kind) => `${code}_slab2_${kind}_${SLABS[code][1]}.xyz`;

async function load(name) {
    const buf = SRC ? readFileSync(join(SRC, name)) : Buffer.from(await (await fetch(BASE + name)).arrayBuffer());
    if (!PRINT_PINS && sha(buf) !== PINS[name]) throw new Error(`${name}: sha256 mismatch`);
    return buf;
}

/** "lon,lat,value" rows (value NaN outside the mask) → the regular grid, placed BY VALUE (row order is not trusted). */
export function parseXyz(text) {
    const rows = text.trim().split('\n').map((l) => l.split(',').map(Number));
    const lons = [...new Set(rows.map((r) => r[0]))].sort((a, b) => a - b);
    const lats = [...new Set(rows.map((r) => r[1]))].sort((a, b) => b - a);           // north first
    const step = +(lons[1] - lons[0]).toFixed(6);
    const dLat = +(lats[0] - lats[1]).toFixed(6);
    if (Math.abs(step - dLat) > 1e-9 || !(step === 0.05 || step === 0.02)) throw new Error(`grid step ${step} / ${dLat}`);
    const nLon = Math.round((lons.at(-1) - lons[0]) / step) + 1, nLat = Math.round((lats[0] - lats.at(-1)) / step) + 1;
    if (nLon * nLat !== rows.length) throw new Error(`not a full grid: ${nLon}×${nLat} vs ${rows.length}`);
    const v = new Float64Array(nLon * nLat).fill(NaN);
    for (const [lo, la, z] of rows) v[Math.round((lats[0] - la) / step) * nLon + Math.round((lo - lons[0]) / step)] = z;
    return { lon0: lons[0], lat0: lats[0], step, nLon, nLat, v };
}

async function build() {
    const pins = {}, slabs = [];
    for (const code of Object.keys(SLABS)) {
        const out = {};
        for (const kind of ['dep', 'unc']) {
            const name = fileName(code, kind), buf = await load(name);
            pins[name] = sha(buf);
            out[kind] = parseXyz(buf.toString('utf8'));
        }
        const g = out.dep, u = out.unc;
        if (g.lon0 !== u.lon0 || g.lat0 !== u.lat0 || g.nLon !== u.nLon || g.nLat !== u.nLat) throw new Error(`${code}: dep/unc grids differ`);
        const STRIDE = Math.round(TARGET_STEP / g.step);
        const nLon = Math.floor((g.nLon - 1) / STRIDE) + 1, nLat = Math.floor((g.nLat - 1) / STRIDE) + 1;
        const depth = [], unc = [];
        let maxDepth = 0;
        for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) {
            const k = i * STRIDE * g.nLon + j * STRIDE;
            const d = g.v[k], s = u.v[k];
            if (Number.isFinite(d)) {
                if (d > 1) throw new Error(`${code}: positive Slab2 depth ${d} (expected ≤ 0, km negative down)`);
                depth.push(Math.round(-d * 10)); unc.push(Number.isFinite(s) ? Math.round(s * 10) : null);
                maxDepth = Math.max(maxDepth, -d);
            } else { depth.push(null); unc.push(null); }
        }
        slabs.push({ code, name: SLABS[code][0], release: SLABS[code][1], lon0: g.lon0, lat0: g.lat0, step: +(g.step * STRIDE).toFixed(6), nLon, nLat, maxDepthKm: +maxDepth.toFixed(1), depth, unc });
    }
    if (PRINT_PINS) { console.log(JSON.stringify(pins, null, 1)); process.exit(0); }
    const baked = {
        model: 'Slab2',
        source: {
            citation: 'Hayes, G. P., Moore, G. L., Portner, D. E., et al. (2018), Slab2, a comprehensive subduction zone geometry model, Science 362, 58–61, doi:10.1126/science.aat4723',
            copy: 'ndb38/arc-metals @ 543bf32 (Slab2_TXT, release 03/01/2018); ScienceBase doi:10.5066/F7PV6JNV',
            licence: 'USGS — public domain',
            sampling: '0.2° (every 4th node of 0.05° grids, every 10th of 0.02° ones), subsampled not averaged; depth and 1σ uncertainty in 0.1 km, positive down',
        },
        scale: 0.1,
        slabs,
    };
    return gzipSync(Buffer.from(JSON.stringify(baked)), { level: 9, mtime: 0 });
}

const bytes = await build();
if (CHECK) {
    if (!gunzipSync(readFileSync(OUT)).equals(gunzipSync(bytes))) { console.error('slab2.json.gz is stale — re-run scripts/build-slab2.mjs'); process.exit(1); }
    console.log('slab2.json.gz matches the pinned source');
} else {
    writeFileSync(OUT, bytes);
    console.log(`wrote ${OUT} (${(bytes.length / 1024).toFixed(0)} KB)`);
}
