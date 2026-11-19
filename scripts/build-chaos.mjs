#!/usr/bin/env node
/**
 * build-chaos.mjs — bake CHAOS-8.1 into data/earth-interior/chaos-8.1.json.gz
 * (INNER_EARTH_PLAN.md §8 P2; read by js/geomag/chaos.js).
 *
 *   node scripts/build-chaos.mjs [--src <dir>]   write the bake
 *   node scripts/build-chaos.mjs --check [--src <dir>]  fail on drift
 *
 * Source: ESA-VirES/MagneticModel @ 6aa2d4f (eoxmagmod/eoxmagmod/data/), the
 * copy DTU's CHAOS-8.1 files reach us through (space.dtu.dk is the canonical
 * host; DTU distributes CHAOS freely with citation — Finlay et al., CHAOS-8).
 * Each file is pinned by sha256; `--src` reads local copies instead of
 * fetching (same pins).
 *
 * What is baked:
 *   • core: all 281 samples × 440 coefficients (n ≤ 20), delta-coded in
 *     1e-6 nT — lossless to the file's 1e-8 nT print far below anything the
 *     gate can see (the field error from the coding is < 1e-4 nT).
 *   • extrapolated: DTU's own 2-sample linear forecast, kept ONLY as the
 *     gate's check on our extrapolation (the kernel extrapolates itself).
 *   • lithosphere: the static field n = 21–185 evaluated BY OUR EVALUATOR
 *     (js/geomag/igrf.js fieldGrid at the set's own stride): the geodetic
 *     DOWN component Z at the WGS-84 surface, 1° grid, int16 in 0.1 nT. Evaluating n = 185 per vertex is too slow for a browser
 *     (plan §6); the gate re-evaluates sample points against ChaosMagPy.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fieldGrid } from '../js/geomag/igrf.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data/earth-interior/chaos-8.1.json.gz');
const BASE = 'https://raw.githubusercontent.com/ESA-VirES/MagneticModel/6aa2d4f427f5e30172536d406863aed24545bb55/eoxmagmod/eoxmagmod/data/';
export const FILES = {
    core: { name: 'CHAOS-8.1_core.shc', sha256: 'c08962cbb2a6cd0d465687116f037ae9c03d4c6c43e38e78e36bf924b4971675' },
    extrapolated: { name: 'CHAOS-8.1_core_extrapolated.shc', sha256: '11ce188697327c7d77a07a8eb86d630422592cdeb94d90d9c28cb0d080ad3d3a' },
    static: { name: 'CHAOS-8.1_static.shc', sha256: 'b29590b0af930f0ec311cd934b14b988fe7bee14b37e4f81602c6c2714134916' },
};
const CORE_SCALE = 1e-6;          // nT per delta unit
export const LITHO_SCALE = 0.1;   // nT per int16 unit (Kursk reaches ~1800 nT; 0.05 overflowed)
const LITHO = { nLat: 181, nLon: 361 };

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const srcAt = args.indexOf('--src');
const SRC = srcAt >= 0 ? args[srcAt + 1] : null;
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function load(f) {
    const buf = SRC ? readFileSync(join(SRC, f.name)) : Buffer.from(await (await fetch(BASE + f.name)).arrayBuffer());
    const got = sha(buf);
    if (got !== f.sha256) throw new Error(`${f.name}: sha256 ${got} ≠ pinned ${f.sha256}`);
    return buf.toString('utf8');
}

/** SHC: comment lines '#', then "nmin nmax N order step", the N times, then rows "n m v1 … vN". */
export function parseShc(text) {
    const lines = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    const [nmin, nmax, N, order, step] = lines[0].trim().split(/\s+/).map(Number);
    const tok = lines.slice(1).join(' ').trim().split(/\s+/).map(Number);
    const times = tok.slice(0, N);
    const rows = [], series = [];
    for (let i = N; i < tok.length; i += N + 2) {
        rows.push([tok[i], tok[i + 1]]);
        series.push(tok.slice(i + 2, i + 2 + N));
    }
    if (rows.length !== nmax * (nmax + 2) - (nmin * nmin - 1)) throw new Error(`row count ${rows.length} for n ${nmin}..${nmax}`);
    for (const s of series) if (s.length !== N || s.some((v) => !Number.isFinite(v))) throw new Error('short or non-numeric row');
    return { nmin, nmax, N, order, step, times, rows, series };
}

function deltaCode(series, scale) {
    return series.map((s) => {
        const q = s.map((v) => Math.round(v / scale));
        return q.map((v, i) => (i === 0 ? v : v - q[i - 1]));
    });
}

async function build() {
    const core = parseShc(await load(FILES.core));
    const ext = parseShc(await load(FILES.extrapolated));
    const stat = parseShc(await load(FILES.static));

    // Lithosphere: a coefficient set holding ONLY n = 21–185, evaluated by igrf.js.
    const g = [], h = [];
    for (let n = 0; n <= stat.nmax; n++) { g.push(new Float64Array(stat.nmax + 1)); h.push(new Float64Array(stat.nmax + 1)); }
    stat.rows.forEach(([n, m], k) => { if (m >= 0) g[n][m] = stat.series[k][0]; else h[n][-m] = stat.series[k][0]; });
    const grid = fieldGrid({ g, h }, stat.nmax, LITHO);
    const z = Array.from(grid.z, (v) => {
        const q = Math.round(v / LITHO_SCALE);
        if (Math.abs(q) > 32767) throw new Error(`lithospheric Z ${v} nT overflows int16 at ${LITHO_SCALE} nT`);
        return q;
    });

    const baked = {
        name: 'CHAOS-8.1',
        source: {
            citation: 'Finlay, C. C., Kloss, C., Olsen, N. et al., CHAOS-8 (DTU Space). Distributed freely with citation.',
            copy: 'ESA-VirES/MagneticModel @ 6aa2d4f',
            files: FILES,
            extractedOn: '2024-10-14',
        },
        core: {
            nmax: core.nmax, order: core.order, step: core.step, scale: CORE_SCALE,
            times: core.times, rows: core.rows, samples: deltaCode(core.series, CORE_SCALE),
        },
        extrapolated: { times: ext.times, rows: ext.rows, series: ext.series },
        lithosphere: {
            nmin: stat.nmin, nmax: stat.nmax, quantity: 'Z (geodetic down), WGS-84 surface, n 21–185',
            nLat: LITHO.nLat, nLon: LITHO.nLon, lat0: 90, lon0: -180, stepDeg: 1, scale: LITHO_SCALE, z,
        },
    };
    return gzipSync(Buffer.from(JSON.stringify(baked)), { level: 9, mtime: 0 });
}

const bytes = await build();
if (CHECK) {
    const committed = readFileSync(OUT);
    if (!gunzipSync(committed).equals(gunzipSync(bytes))) { console.error('chaos-8.1.json.gz is stale — re-run scripts/build-chaos.mjs'); process.exit(1); }
    console.log('chaos-8.1.json.gz matches the pinned source');
} else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, bytes);
    console.log(`wrote ${OUT} (${(bytes.length / 1024).toFixed(0)} KB)`);
}
