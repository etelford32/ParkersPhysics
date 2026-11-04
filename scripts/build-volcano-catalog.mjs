#!/usr/bin/env node
/**
 * build-volcano-catalog.mjs — bakes data/volcanoes/volcanoes-catalog.json
 * ═══════════════════════════════════════════════════════════════════════════
 *   node scripts/build-volcano-catalog.mjs            # uses scripts/.cache/volcanoes
 *   node scripts/build-volcano-catalog.mjs --fetch    # (re)downloads the sources
 *   node scripts/build-volcano-catalog.mjs --check    # rebuild in memory, fail on drift
 *
 * (Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 — set it on
 * a proxied machine, or drop the files into the cache by hand: the sha256 of
 * every source is pinned below and checked either way.)
 *
 * THREE SOURCES, ONE FILE — all of them the Smithsonian Global Volcanism
 * Program's own tables (Volcanoes of the World). volcano.si.edu and its
 * GeoServer are egress-blocked from the build sandbox, so each is read from a
 * PINNED GitHub copy whose bytes are hashed here; the GVP download is the
 * same file anyone gets from the "Download list" button.
 *
 * 1. GVP Holocene volcano list, VOTW 5.3.4, downloaded 22 Mar 2026 (1222
 *    volcanoes with evidence of activity in the last ~11,700 years). This is
 *    the authority for identity, position, type, evidence and LAST KNOWN
 *    ERUPTION. Mirrored at github.com/jwilleke/volcano-lists.
 * 2. GVP Pleistocene volcano list, same download (1439 volcanoes with NO
 *    known Holocene eruption — the "inactive" population). Same mirror.
 * 3. GVP eruption + volcano tables as exported for TidyTuesday 2020-05-12
 *    (github.com/rfordatascience/tidytuesday) — every catalogued eruption with
 *    its start year and VEI (through early 2020), plus GVP's LandScan
 *    population counts within 5/10/30/100 km. This is the only per-eruption
 *    record reachable from here; it is SIX YEARS OLDER than the lists, and the
 *    file says so (`eruptionTableThrough`). The engine reconciles the gap with
 *    the lists' newer last-eruption year — never by inventing eruptions.
 *
 * The XLS files are SpreadsheetML (XML) — and NOT well-formed XML: GVP writes
 * "Oceanic crust (< 15 km)" with a bare '<', so a real XML parser throws on
 * line 6. They are read row-by-row with a regex over <Row>/<Cell>/<Data>,
 * honouring ss:Index gaps. Headers are matched BY NAME, never by position —
 * the Holocene and Pleistocene sheets put Rock and Tectonic in opposite
 * orders (measured), which a positional reader silently swaps.
 *
 * Output is COLUMNAR with string dictionaries (~2.7k rows); read it only
 * through js/volcano-engine.js `decodeCatalog`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'scripts/.cache/volcanoes');
const OUT = path.join(ROOT, 'data/volcanoes/volcanoes-catalog.json');

const GVP_MIRROR = 'https://raw.githubusercontent.com/jwilleke/volcano-lists/063f6ad26cf098ad41ba6b25ed9880b9c4f2b70a/data/';
const TT_MIRROR = 'https://raw.githubusercontent.com/rfordatascience/tidytuesday/f422450f6519830f6ce0312e5294e3cf110c72ed/data/2020/2020-05-12/';

export const SOURCES = [
    { file: 'GVP_Volcano_List_Holocene_202603220718.xls', url: GVP_MIRROR + 'GVP_Volcano_List_Holocene_202603220718.xls',
      sha256: 'b5a03f04815d5eab68da7c089ed3008889c4fca35ff2d1696e29be67cb391307' },
    { file: 'GVP_Volcano_List_Pleistocene_202603220718.xls', url: GVP_MIRROR + 'GVP_Volcano_List_Pleistocene_202603220718.xls',
      sha256: '58a9ca4e73431e16c1b8fb04df7509dc373fbab62e3571c35e688693f686f819' },
    { file: 'eruptions.csv', url: TT_MIRROR + 'eruptions.csv',
      sha256: '460d4f5afcd23465ff30a50973d04ffb63cc4cabb845cdf40db44bf27005db1f' },
    { file: 'volcano.csv', url: TT_MIRROR + 'volcano.csv',
      sha256: '3ab7c7b02f813d68512a360d1f2da23098409b564a70f0e84610db8fdad9f8f8' },
];

// ── SpreadsheetML reader (regex — see header for why not an XML parser) ────
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescape(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
        if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
        return ENT[e] ?? m;
    });
}
export function readSpreadsheetML(text) {
    const rows = [];
    for (const rm of text.matchAll(/<Row\b[^>]*>([\s\S]*?)<\/Row>/g)) {
        const cells = [];
        for (const cm of rm[1].matchAll(/<Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Cell>)/g)) {
            const im = /ss:Index="(\d+)"/.exec(cm[1]);
            if (im) while (cells.length < Number(im[1]) - 1) cells.push('');
            const dm = /<Data\b[^>]*>([\s\S]*?)<\/Data>/.exec(cm[2] ?? '');
            cells.push(dm ? unescape(dm[1]).trim() : '');
        }
        rows.push(cells);
    }
    return rows;
}

// ── CSV (RFC 4180 quoting) ──────────────────────────────────────────────────
export function readCsv(text) {
    const out = []; let row = []; let f = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
            else f += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(f); f = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(f); f = ''; out.push(row); row = [];
        } else f += c;
    }
    if (f.length || row.length) { row.push(f); out.push(row); }
    const [hdr, ...body] = out.filter(r => r.length > 1 || r[0] !== '');
    return body.map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i] ?? ''])));
}

/** "2025 CE" → 2025, "8300 BCE" → −8300 (GVP's own numeric convention),
 *  "Unknown"/'' → null. */
export function parseGvpYear(s) {
    const m = /^(\d+)\s*(BCE|CE)$/i.exec(String(s ?? '').trim());
    if (!m) return null;
    return m[2].toUpperCase() === 'BCE' ? -Number(m[1]) : Number(m[1]);
}

function num(s) {
    if (s == null) return null;
    const t = String(s).trim();
    if (t === '' || t === 'NA' || t === 'Unknown') return null;
    const v = Number(t);
    return Number.isFinite(v) ? v : null;
}
function str(s) {
    const t = String(s ?? '').trim();
    return t === '' || t === 'NA' ? null : t;
}

function sheetRecords(text, epoch) {
    const rows = readSpreadsheetML(text);
    const title = rows[0]?.join(' ') ?? '';
    const hdr = rows[1];
    const need = ['Volcano Number', 'Volcano Name', 'Country', 'Volcanic Region Group', 'Volcanic Region',
        'Volcano Landform', 'Primary Volcano Type', 'Activity Evidence', 'Last Known Eruption',
        'Latitude', 'Longitude', 'Elevation (m)', 'Tectonic Setting', 'Dominant Rock Type'];
    const col = {};
    for (const n of need) {
        const i = hdr.indexOf(n);
        if (i < 0) throw new Error(`${epoch} sheet: header "${n}" missing (got ${hdr.join(' | ')})`);
        col[n] = i;
    }
    const recs = rows.slice(2).filter(r => r[col['Volcano Number']]).map(r => {
        const g = n => r[col[n]] ?? '';
        return {
            num: Number(g('Volcano Number')),
            name: str(g('Volcano Name')) ?? 'Unnamed',
            country: str(g('Country')),
            regionGroup: str(g('Volcanic Region Group')),
            region: str(g('Volcanic Region')),
            landform: str(g('Volcano Landform')),
            type: str(g('Primary Volcano Type')),
            evidence: str(g('Activity Evidence')),
            lastEruption: parseGvpYear(g('Last Known Eruption')),
            lat: num(g('Latitude')),
            lon: num(g('Longitude')),
            elev: num(g('Elevation (m)')),
            tectonic: str(g('Tectonic Setting')),
            rock: str(g('Dominant Rock Type')),
            epoch,
        };
    });
    return { title, recs };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function fetchSources() {
    fs.mkdirSync(CACHE, { recursive: true });
    for (const s of SOURCES) {
        const res = await fetch(s.url);
        if (!res.ok) throw new Error(`fetch ${s.file}: HTTP ${res.status}`);
        fs.writeFileSync(path.join(CACHE, s.file), Buffer.from(await res.arrayBuffer()));
        console.log(`fetched ${s.file}`);
    }
}

function readSource(s) {
    const p = path.join(CACHE, s.file);
    if (!fs.existsSync(p)) throw new Error(`missing ${p} — run with --fetch first`);
    const buf = fs.readFileSync(p);
    const h = sha256(buf);
    if (h !== s.sha256) throw new Error(`${s.file}: sha256 ${h} ≠ pinned ${s.sha256}`);
    return buf.toString('utf8');
}

/** Column-encode an array of records with string dictionaries. */
function encode(recs, fields, dictFields) {
    const dicts = {}; const columns = {};
    for (const f of dictFields) dicts[f] = [];
    const idx = {};
    for (const f of dictFields) idx[f] = new Map();
    for (const f of fields) columns[f] = [];
    for (const r of recs) {
        for (const f of fields) {
            let v = r[f] ?? null;
            if (dictFields.includes(f) && v != null) {
                if (!idx[f].has(v)) { idx[f].set(v, dicts[f].length); dicts[f].push(v); }
                v = idx[f].get(v);
            }
            columns[f].push(v);
        }
    }
    return { dicts, columns };
}

export function buildCatalog(texts) {
    const hol = sheetRecords(texts[SOURCES[0].file], 'H');
    const ple = sheetRecords(texts[SOURCES[1].file], 'P');
    const eruptions = readCsv(texts['eruptions.csv']);
    const volc = readCsv(texts['volcano.csv']);

    const all = [...hol.recs, ...ple.recs];
    const byNum = new Map(all.map(r => [r.num, r]));
    if (byNum.size !== all.length) throw new Error('duplicate volcano numbers across the two lists');

    // ── Per-eruption record (Holocene volcanoes only — a Pleistocene volcano
    // has no Holocene eruptions by definition; a row that maps to one is a
    // renumbering and is COUNTED, not silently merged).
    const hist = new Map();
    const stats = { confirmed: 0, uncertain: 0, discredited: 0, unmatched: 0, matched: 0, maxYear: -Infinity };
    for (const e of eruptions) {
        const cat = e.eruption_category;
        if (cat === 'Discredited Eruption') { stats.discredited++; continue; }
        const n = Number(e.volcano_number);
        const v = byNum.get(n);
        if (!v || v.epoch !== 'H') { stats.unmatched++; continue; }
        if (cat === 'Uncertain Eruption') { stats.uncertain++; v.uncertainEruptions = (v.uncertainEruptions ?? 0) + 1; continue; }
        if (cat !== 'Confirmed Eruption') continue;
        const y = num(e.start_year);
        if (y == null) continue;
        stats.confirmed++; stats.matched++;
        stats.maxYear = Math.max(stats.maxYear, y);
        const vei = num(e.vei);
        const ey = num(e.end_year);
        if (!hist.has(n)) hist.set(n, []);
        // [startYear, vei (−1 unknown), durationYears (−1 unknown)]
        hist.get(n).push([y, vei == null ? -1 : vei, ey == null ? -1 : Math.max(0, ey - y)]);
    }
    for (const [n, h] of hist) {
        h.sort((a, b) => a[0] - b[0]);
        byNum.get(n).eruptions = h;
    }

    // GVP LandScan populations (2020 table; ≤ 958 volcanoes carry them)
    let popMatched = 0;
    for (const r of volc) {
        const v = byNum.get(Number(r.volcano_number));
        if (!v) continue;
        const p = [num(r.population_within_5_km), num(r.population_within_10_km),
                   num(r.population_within_30_km), num(r.population_within_100_km)];
        if (p.some(x => x != null)) { v.pop = p; popMatched++; }
    }

    const fields = ['num', 'name', 'country', 'regionGroup', 'region', 'landform', 'type', 'evidence',
        'lastEruption', 'lat', 'lon', 'elev', 'tectonic', 'rock', 'epoch', 'uncertainEruptions', 'pop', 'eruptions'];
    const dictFields = ['country', 'regionGroup', 'region', 'landform', 'type', 'evidence', 'tectonic', 'rock'];
    all.sort((a, b) => a.num - b.num);
    const { dicts, columns } = encode(all, fields, dictFields);

    const titleMatch = /Volcanoes of the World ([\d.]+)/.exec(hol.title);
    const dlMatch = /Downloaded on (\d+ \w+ \d{4})/.exec(hol.title);
    return {
        schema: 'volcano-catalog-v1',
        source: {
            name: 'Smithsonian Institution Global Volcanism Program — Volcanoes of the World',
            version: titleMatch?.[1] ?? null,
            listsDownloaded: dlMatch ? new Date(dlMatch[1] + ' UTC').toISOString().slice(0, 10) : null,
            citation: 'Global Volcanism Program. Volcanoes of the World (v. 5.3.4; list downloaded 22 Mar 2026). Smithsonian Institution. https://volcano.si.edu/',
            eruptionTable: 'GVP eruption list as exported for TidyTuesday 2020-05-12',
            files: SOURCES.map(s => ({ file: s.file, sha256: s.sha256, url: s.url })),
        },
        // Decimal year of the lists' download — the "now" the catalogue knows.
        catalogueEpoch: 2026 + (31 + 28 + 21) / 365,
        eruptionTableThrough: stats.maxYear,
        counts: {
            holocene: hol.recs.length, pleistocene: ple.recs.length,
            confirmedEruptions: stats.confirmed, uncertainEruptions: stats.uncertain,
            discreditedDropped: stats.discredited, unmatchedEruptionRows: stats.unmatched,
            withPopulation: popMatched,
        },
        n: all.length,
        dicts,
        columns,
    };
}

async function main() {
    if (process.argv.includes('--fetch')) await fetchSources();
    const texts = Object.fromEntries(SOURCES.map(s => [s.file, readSource(s)]));
    const cat = buildCatalog(texts);
    const json = JSON.stringify(cat);
    if (process.argv.includes('--check')) {
        const cur = fs.readFileSync(OUT, 'utf8');
        if (cur.trim() !== json) { console.error('volcanoes-catalog.json is STALE — re-run the baker'); process.exit(1); }
        console.log('volcanoes-catalog.json matches its sources');
        return;
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, json + '\n');
    console.log(`wrote ${path.relative(ROOT, OUT)} — ${cat.n} volcanoes (${cat.counts.holocene} H + ${cat.counts.pleistocene} P), ` +
        `${cat.counts.confirmedEruptions} confirmed eruptions through ${cat.eruptionTableThrough}, ` +
        `${cat.counts.unmatchedEruptionRows} unmatched rows, ${(json.length / 1024).toFixed(0)} KB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(e => { console.error(e.message); process.exit(1); });
}
