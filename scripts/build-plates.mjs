#!/usr/bin/env node
/**
 * build-plates.mjs — bake Bird's PB2002 plate model into
 * data/earth-interior/plates-pb2002.json.gz (read by js/earth-interior/plates.js).
 *
 *   node scripts/build-plates.mjs [--src <dir>]          write the bake
 *   node scripts/build-plates.mjs --check [--src <dir>]  fail on drift
 *
 * Source: Bird (2003) G³ 4(3) 1027 electronic supplement, copied unmodified
 * ("with some very minor updates" — splitting at ±180° is in the SHAPEFILES,
 * not these .dig/.dat files) in fraxen/tectonicplates @ 339b0c5 `original/`,
 * Open Data Commons Attribution 1.0 (credit Peter Bird; Hugo Ahlenius /
 * Nordpil). Each file is sha256-pinned; `--src` reads local copies.
 *
 * Baked:
 *   • plates: id, name, Euler pole relative to the Pacific (PB2002_poles.dat).
 *   • raster: plate index per 0.5° cell, decided by the spherical WINDING
 *     ANGLE of each cell centre in Bird's closed CCW outlines (PB2002_plates.dig;
 *     plates.js `windingAngle`). A cell no outline claims (an edge cell) goes
 *     to the outline whose winding is largest — counted and printed.
 *   • steps: all 5,819 digitisation steps — endpoints, left/right plate,
 *     subduction polarity, class, and Bird's ETOPO5 elevation and Müller et
 *     al. (1997) seafloor age at the midpoint (those two are Bird's numbers,
 *     drawn as observations). Bird's computed velocity columns are kept as
 *     `bird` ONLY so the gate can check our Euler-pole arithmetic against them;
 *     the page draws plates.js's own numbers.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { unit, windingAngle } from '../js/earth-interior/plates.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data/earth-interior/plates-pb2002.json.gz');
const BASE = 'https://raw.githubusercontent.com/fraxen/tectonicplates/339b0c56563c118307b1f4542703047f5f698fae/original/';
const FILES = {
    poles: { name: 'PB2002_poles.dat.txt', sha256: '887d208bda44cea75ee0c778c1883476906757a3d8035608a6cff7b79cf40f2e' },
    plates: { name: 'PB2002_plates.dig.txt', sha256: 'ff7e25dbf29658d4330b38e95e876533c5cdfd292ef71fa806e2340edfa3abc0' },
    steps: { name: 'PB2002_steps.dat.txt', sha256: '513babb111c65cd275274e2edcb249085d00e007c79d8755e1b4b79f60806f37' },
};
// Bird (2003) Table 1 plate names.
const NAMES = {
    AF: 'Africa', AM: 'Amur', AN: 'Antarctica', AP: 'Altiplano', AR: 'Arabia', AS: 'Aegean Sea', AT: 'Anatolia', AU: 'Australia',
    BH: "Birds Head", BR: 'Balmoral Reef', BS: 'Banda Sea', BU: 'Burma', CA: 'Caribbean', CL: 'Caroline', CO: 'Cocos', CR: 'Conway Reef',
    EA: 'Easter', EU: 'Eurasia', FT: 'Futuna', GP: 'Galápagos', IN: 'India', JF: 'Juan de Fuca', JZ: 'Juan Fernández', KE: 'Kermadec',
    MA: 'Mariana', MN: 'Manus', MO: 'Maoke', MS: 'Molucca Sea', NA: 'North America', NB: 'North Bismarck', ND: 'North Andes', NH: 'New Hebrides',
    NI: "Niuafo'ou", NZ: 'Nazca', OK: 'Okhotsk', ON: 'Okinawa', PA: 'Pacific', PM: 'Panama', PS: 'Philippine Sea', RI: 'Rivera',
    SA: 'South America', SB: 'South Bismarck', SC: 'Scotia', SL: 'Shetland', SO: 'Somalia', SS: 'Solomon Sea', SU: 'Sunda', SW: 'Sandwich',
    TI: 'Timor', TO: 'Tonga', WL: 'Woodlark', YA: 'Yangtze',
};
const CLASSES = ['OSR', 'OTF', 'OCB', 'SUB', 'CRB', 'CTF', 'CCB'];
const STEP_DEG = 0.5;
const COORD_SCALE = 1e-3;

const args = process.argv.slice(2);
const CHECK = args.includes('--check');
const srcAt = args.indexOf('--src');
const SRC = srcAt >= 0 ? args[srcAt + 1] : null;
const sha = (b) => createHash('sha256').update(b).digest('hex');
async function load(f) {
    const buf = SRC ? readFileSync(join(SRC, f.name)) : Buffer.from(await (await fetch(BASE + f.name)).arrayBuffer());
    if (sha(buf) !== f.sha256) throw new Error(`${f.name}: sha256 mismatch`);
    return buf.toString('latin1');
}

function parsePoles(text) {
    return text.split('\n').filter((l) => /^[A-Z]{2}\s/.test(l)).map((l) => ({
        id: l.slice(0, 2), lat: Number(l.slice(2, 11)), lon: Number(l.slice(11, 21)), rateDegMa: Number(l.slice(21, 30)),
        poleSource: l.slice(30).trim().split(/\s{2,}/)[0],
    }));
}
function parseDig(text) {
    const segs = [];
    let cur = null;
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (line.startsWith('***')) { if (cur) segs.push(cur); cur = null; continue; }
        if (!cur) { cur = { title: line.trim(), pts: [] }; continue; }
        const [lon, lat] = line.split(',').map(Number);
        cur.pts.push([lat, lon]);
    }
    return segs;
}

async function build() {
    const poles = parsePoles(await load(FILES.poles));
    const ids = poles.map((p) => p.id);
    const idx = new Map(ids.map((id, i) => [id, i]));
    if (poles.length !== 52 || ids.some((id) => !NAMES[id])) throw new Error('expected 52 named plates');

    // Raster by winding angle, with a spherical-cap prefilter per outline.
    const outlines = parseDig(await load(FILES.plates)).map((s) => {
        const xyz = s.pts.map(([la, lo]) => unit(la, lo));
        const c = xyz.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0]);
        const k = Math.hypot(...c);
        const cen = k > 1e-9 ? c.map((x) => x / k) : [0, 0, -1];
        const cosCap = Math.min(...xyz.map((v) => v[0] * cen[0] + v[1] * cen[1] + v[2] * cen[2]));
        return { id: s.title.slice(0, 2), plate: idx.get(s.title.slice(0, 2)), xyz, cen, cosCap };
    });
    if (outlines.length !== 52) throw new Error(`expected 52 outlines, got ${outlines.length}`);
    const nLat = 180 / STEP_DEG, nLon = 360 / STEP_DEG;
    const cells = new Array(nLat * nLon).fill(-1);
    let overlaps = 0, orphans = 0;
    for (let i = 0; i < nLat; i++) {
        const lat = 90 - (i + 0.5) * STEP_DEG;
        for (let j = 0; j < nLon; j++) {
            const p = unit(lat, -180 + (j + 0.5) * STEP_DEG);
            let hit = -1, best = -1, bestW = -Infinity;
            for (const o of outlines) {
                // A cap whose radius exceeds 90° (Antarctica, Pacific) cannot be prefiltered this way.
                if (o.cosCap > 0 && p[0] * o.cen[0] + p[1] * o.cen[1] + p[2] * o.cen[2] < o.cosCap - 1e-9) continue;
                const w = windingAngle(o.xyz, p);
                if (w > Math.PI) { if (hit >= 0) overlaps++; else hit = o.plate; }
                if (w > bestW) { bestW = w; best = o.plate; }
            }
            if (hit < 0) { orphans++; hit = best; }
            cells[i * nLon + j] = hit;
        }
    }
    console.log(`raster ${nLon}×${nLat}: ${overlaps} overlapping, ${orphans} orphan cells (assigned to the largest winding)`);

    const S = { scale: COORD_SCALE, classes: CLASSES, lon1: [], lat1: [], lon2: [], lat2: [], left: [], right: [], polarity: [], cls: [], elev: [], age: [], orogen: [], bird: { vel: [], az: [], div: [], dex: [] } };
    for (const l of (await load(FILES.steps)).split(/\r?\n/)) {
        if (!l.trim()) continue;
        const id = l.slice(6, 11);
        const q = (v) => Math.round(Number(v) / COORD_SCALE);
        S.left.push(idx.get(id.slice(0, 2))); S.right.push(idx.get(id.slice(3, 5))); S.polarity.push(id[2]);
        S.lon1.push(q(l.slice(12, 20))); S.lat1.push(q(l.slice(21, 28))); S.lon2.push(q(l.slice(29, 37))); S.lat2.push(q(l.slice(38, 45)));
        S.bird.vel.push(Number(l.slice(56, 61))); S.bird.az.push(Number(l.slice(62, 65)));
        S.bird.div.push(Number(l.slice(66, 72))); S.bird.dex.push(Number(l.slice(73, 79)));
        S.elev.push(Number(l.slice(80, 86))); S.age.push(Number(l.slice(87, 90)));
        const c = CLASSES.indexOf(l.slice(92, 95));
        if (c < 0 || S.left.at(-1) === undefined || S.right.at(-1) === undefined) throw new Error(`bad step line: ${l}`);
        S.cls.push(c); S.orogen.push(l[95] === '*' ? 1 : 0);
    }
    if (S.left.length !== 5819) throw new Error(`expected 5819 steps, got ${S.left.length}`);

    const baked = {
        model: 'PB2002',
        source: {
            citation: 'Bird, P. (2003), An updated digital model of plate boundaries, Geochem. Geophys. Geosyst., 4(3), 1027, doi:10.1029/2001GC000252',
            copy: 'fraxen/tectonicplates @ 339b0c5 original/ (ODC-By 1.0; credit Peter Bird and Hugo Ahlenius, Nordpil)',
            files: FILES,
            seafloorAge: 'Müller et al. (1997), as tabulated by Bird at each step midpoint',
            elevation: 'ETOPO5, as tabulated by Bird at each step midpoint',
            raster: { overlaps, orphans },
        },
        plates: poles.map((p) => ({ ...p, name: NAMES[p.id] })),
        raster: { stepDeg: STEP_DEG, nLat, nLon, cells },
        steps: S,
    };
    return gzipSync(Buffer.from(JSON.stringify(baked)), { level: 9, mtime: 0 });
}

const bytes = await build();
if (CHECK) {
    if (!gunzipSync(readFileSync(OUT)).equals(gunzipSync(bytes))) { console.error('plates-pb2002.json.gz is stale — re-run scripts/build-plates.mjs'); process.exit(1); }
    console.log('plates-pb2002.json.gz matches the pinned source');
} else {
    writeFileSync(OUT, bytes);
    console.log(`wrote ${OUT} (${(bytes.length / 1024).toFixed(0)} KB)`);
}
