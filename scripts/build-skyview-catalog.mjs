#!/usr/bin/env node
/**
 * build-skyview-catalog.mjs — bakes data/skyview/sky-catalog.json for SkyView
 * ═══════════════════════════════════════════════════════════════════════════
 *   node scripts/build-skyview-catalog.mjs            # uses scripts/.cache/skyview
 *   node scripts/build-skyview-catalog.mjs --fetch    # (re)downloads the sources
 *
 * TWO SOURCES, ONE FILE
 * ─────────────────────
 * 1. The SKY: Olaf Frohn's d3-celestial data files (BSD-3-Clause; star data is
 *    the Hipparcos catalogue, ESA 1997) — every star to V ≈ 6, the IAU proper
 *    names, the constellation stick figures and label points, the Messier
 *    catalogue, a hand-selected list of the brightest non-Messier deep-sky
 *    objects, and the Milky Way's five brightness contours. Fetched from
 *    raw.githubusercontent.com (the jsdelivr mirror is egress-blocked here).
 *
 * 2. The GALAXY MAP: galactic-map.html's own `CATALOG` array, extracted from
 *    the page source and evaluated as data — never copied by hand. Every one
 *    of its objects is stored at the map's own (l, b, dist) plus the RA/Dec
 *    that sky-engine's `galacticToEquatorial` gives, then CROSS-MATCHED to the
 *    sky: a star to the brightest Hipparcos star within MATCH_STAR_DEG, an
 *    extended object to the nearest deep-sky object within MATCH_DSO_DEG. A
 *    match lends the sky object the map's description, distance and page link;
 *    an object with NO match (Sgr A*, M87's black hole, TON 618, the Great
 *    Attractor…) becomes a LANDMARK: drawn where it is, never ranked, because
 *    it has no naked-eye magnitude. `tests/skyview-catalog.mjs` re-runs the
 *    extraction against the live page and fails if the two drift.
 *
 * The Milky Way is RASTERISED here, not shipped as polygons: the outer contour
 * is a pair of rings that each wrap the full 360° of RA, which no planar
 * even-odd fill handles and which a stereographic projection tears apart near
 * the nadir. Per RA column we cast a meridian ray up from the south celestial
 * pole (which is outside the band, b = −27°) and count contour crossings, so
 * the seam needs no special case. 1° cells, value = how many of the five
 * nested contours contain the cell.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { galacticToEquatorial, angularSeparationDeg } from '../js/skyview/sky-engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'scripts/.cache/skyview');
const OUT = path.join(ROOT, 'data/skyview/sky-catalog.json');
const UPSTREAM = 'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/';
const FILES = ['stars.6.json', 'starnames.json', 'constellations.json',
    'constellations.lines.json', 'messier.json', 'dsos.bright.json', 'mw.json'];

export const CATALOG_VERSION = 1;
export const MATCH_STAR_DEG = 0.35;
export const MATCH_DSO_DEG = 1.5;

/**
 * WHO each galaxy-map star IS, by Hipparcos number — identity is a FACT about
 * the star, never inferred from the map's own (l, b), because the map's
 * positions are what this table exists to check (ten were 0.3°–17° off; see
 * the CATALOG comment in galactic-map.html). Stars fainter than the V≈6 cut
 * (Proxima, Barnard's Star, Wolf 359, TRAPPIST-1) are absent ON PURPOSE: they
 * are invisible to the eye and become landmarks. A new star on the map with
 * no entry here falls back to a positional match and the test says so.
 */
export const GALACTIC_HIP = Object.freeze({
    alpha_cen: 71683, sirius: 32349, eps_eri: 16537, procyon: 37279, tau_ceti: 8102,
    sixtyone_cyg: 104214, altair: 97649, vega: 91262, fomalhaut: 113368, pollux: 37826,
    arcturus: 69673, capella: 24608, aldebaran: 21421, regulus: 49669, spica: 65474,
    antares: 80763, canopus: 30438, betelgeuse: 27989, rigel: 24436, deneb: 102098,
    acrab: 78820, dschubba: 78401, pi_sco: 78265, sigma_sco: 80112, tau_sco: 81266,
    eps_sco: 82396, mu_sco: 82514, zeta_sco: 82729, eta_sco: 84143, sargas: 86228,
    iota_sco: 87073, kappa_sco: 86670, shaula: 85927, lesath: 85696, cursa: 23875,
    zaurak: 18543, delta_eri: 17378, eta_eri: 13701, acamar: 13847, achernar: 7588,
});

const r3 = (x) => Math.round(x * 1000) / 1000;
const r2 = (x) => Math.round(x * 100) / 100;
const ra360 = (lon) => r3(((lon % 360) + 360) % 360);

// ── d3-celestial type code → SkyView kind ──────────────────────────────────
export const DSO_KIND = Object.freeze({
    oc: 'open-cluster', gc: 'globular',
    g: 'galaxy', gg: 'galaxy', s: 'galaxy', s0: 'galaxy', sd: 'galaxy', e: 'galaxy', i: 'galaxy',
    sfr: 'nebula', en: 'nebula', rn: 'nebula', bn: 'nebula', dn: 'nebula', snr: 'nebula', pn: 'nebula',
    pos: 'asterism',
});

// The bright list carries catalogue numbers only; these are the names an
// observer knows them by. Messier objects get their names from messier.json.
const BRIGHT_NAMES = Object.freeze({
    'PGC 17223': 'Large Magellanic Cloud', 'NGC 292': 'Small Magellanic Cloud',
    'NGC 224': 'Andromeda Galaxy', 'NGC 598': 'Triangulum Galaxy',
    'NGC 1976': 'Orion Nebula', 'NGC 2632': 'Beehive Cluster', 'M 45': 'Pleiades',
    'Cr 39': 'Alpha Persei Cluster', 'C 41': 'Hyades', 'Cr 256': 'Coma Star Cluster',
    'NGC 104': '47 Tucanae', 'NGC 869': 'Double Cluster (h Per)', 'NGC 884': 'Double Cluster (χ Per)',
    'NGC 2244': 'Rosette Cluster', 'NGC 2264': 'Christmas Tree Cluster', 'NGC 2362': 'Tau Canis Majoris Cluster',
    'NGC 2451': 'NGC 2451 (Puppis)', 'NGC 2516': 'Southern Beehive', 'NGC 3372': 'Carina Nebula',
    'NGC 3532': 'Wishing Well Cluster', 'NGC 5139': 'Omega Centauri', 'NGC 6231': 'Northern Jewel Box',
    'IC 2602': 'Southern Pleiades', 'IC 2391': 'Omicron Velorum Cluster', 'NGC 6121': 'M4',
    'NGC 6405': 'Butterfly Cluster', 'NGC 6475': 'Ptolemy’s Cluster', 'M 8': 'Lagoon Nebula',
    'NGC 6611': 'Eagle Nebula', 'Cr 140': 'Collinder 140', 'Cr 399': 'Coathanger (Brocchi’s Cluster)',
});

/** "190x60" → 190; "13" → 13; "" → null. */
export function majorAxisArcmin(dim) {
    const m = String(dim ?? '').match(/[\d.]+/);
    return m ? Number(m[0]) : null;
}

// ── Sources ────────────────────────────────────────────────────────────────

async function fetchSources() {
    fs.mkdirSync(CACHE, { recursive: true });
    for (const f of FILES) {
        const res = await fetch(UPSTREAM + f);
        if (!res.ok) throw new Error(`fetch ${f}: HTTP ${res.status}`);
        fs.writeFileSync(path.join(CACHE, f), await res.text());
        console.log(`fetched ${f}`);
    }
}
function readSource(f) {
    const p = path.join(CACHE, f);
    if (!fs.existsSync(p)) throw new Error(`missing ${p} — run with --fetch first`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── Galactic map extraction (shared with tests/skyview-catalog.mjs) ─────────

/**
 * Evaluate galactic-map.html's `const CATALOG = [ … ];` as DATA. The array is
 * pure literals (no THREE, no functions) — if that ever stops being true this
 * throws, which is the point: SkyView must not silently lose the map.
 */
export function extractGalacticCatalog(html) {
    const start = html.indexOf('const CATALOG = [');
    if (start < 0) throw new Error('galactic-map.html: `const CATALOG = [` not found');
    const end = html.indexOf('\n];', start);
    if (end < 0) throw new Error('galactic-map.html: end of CATALOG not found');
    const body = html.slice(start + 'const CATALOG = '.length, end + 2);
    // eslint-disable-next-line no-new-func
    const arr = new Function(`"use strict"; return ${body};`)();
    if (!Array.isArray(arr) || arr.length < 50) throw new Error('galactic-map CATALOG did not evaluate to an array');
    return arr;
}

/** Map one galaxy-map entry onto SkyView's grouping. */
function galacticGroup(o) {
    if (o.isSstar) return 'sstar';
    if (o.isGC) return 'galactic-centre';
    if (o.isIntergalactic) return 'extragalactic';
    if (o.isCluster) return 'extended';
    if (o.isStellarBH) return 'stellar-bh';
    if (o.isShowpiece) return 'extended';
    return 'star';
}

function parseMagNote(props) {
    for (const [k, v] of props ?? []) {
        if (/^(V magnitude|Apparent mag(nitude)?)$/i.test(k)) return String(v);
    }
    return null;
}

/**
 * Galaxy-map entries → SkyView records, cross-matched to the star and DSO
 * lists. Pure: same inputs, same output, so the test can re-run it.
 */
export function buildGalacticRecords(catalog, stars, dsos) {
    const out = [];
    for (const o of catalog) {
        if (o.isHeader || String(o.id).startsWith('__')) continue;   // sidebar separators
        if (o.id === 'sun') continue;                                // the Sun is the observer's own
        const group = galacticGroup(o);
        if (group === 'sstar') continue;   // all at Sgr A*'s position; Sgr A* stands for them
        const { raDeg, decDeg } = galacticToEquatorial(o.l, o.b);
        const rec = {
            id: o.id, name: o.name, abbr: o.abbr ?? o.name, type: o.type ?? '', group,
            l: o.l, b: o.b, distLy: o.dist,
            ra: r3(raDeg), dec: r3(decDeg),
            desc: o.desc ?? '', link: o.link ?? null, props: o.props ?? [],
        };
        const note = parseMagNote(o.props);
        if (note) rec.magNote = note;
        if (group === 'star' && GALACTIC_HIP[o.id] != null) {
            const i = stars.hip.indexOf(GALACTIC_HIP[o.id]);
            if (i < 0) throw new Error(`GALACTIC_HIP.${o.id} = HIP ${GALACTIC_HIP[o.id]} is not in the star list`);
            rec.hip = stars.hip[i];
            rec.matchSepDeg = r3(angularSeparationDeg(raDeg, decDeg, stars.ra[i], stars.dec[i]));
            rec.matchBy = 'identity';
        } else if (group === 'star') {
            let best = null;
            for (let i = 0; i < stars.hip.length; i++) {
                if (Math.abs(stars.dec[i] - decDeg) > MATCH_STAR_DEG) continue;
                const sep = angularSeparationDeg(raDeg, decDeg, stars.ra[i], stars.dec[i]);
                if (sep <= MATCH_STAR_DEG && (!best || stars.mag[i] < best.mag)) best = { i, sep, mag: stars.mag[i] };
            }
            if (best) { rec.hip = stars.hip[best.i]; rec.matchSepDeg = r3(best.sep); rec.matchBy = 'position'; }
        } else if (group === 'extended' || group === 'extragalactic' || group === 'galactic-centre') {
            let best = null;
            for (const d of dsos) {
                const sep = angularSeparationDeg(raDeg, decDeg, d.ra, d.dec);
                const tol = Math.max(MATCH_DSO_DEG * (group === 'extended' ? 1 : 0.5), (d.dim ?? 0) / 120);
                if (sep <= tol && (!best || sep < best.sep)) best = { d, sep };
            }
            // Only a NAMED counterpart is a match: Sgr A* must not become "M24".
            if (best && group !== 'galactic-centre') { rec.dso = best.d.id; rec.matchSepDeg = r3(best.sep); rec.matchBy = 'position'; }
        }
        out.push(rec);
    }
    return out;
}

// ── Stars ───────────────────────────────────────────────────────────────────

function buildStars(starsJson, names) {
    const rows = starsJson.features.map((f) => ({
        hip: Number(f.id),
        ra: ra360(f.geometry.coordinates[0]),
        dec: r3(f.geometry.coordinates[1]),
        mag: r2(Number(f.properties.mag)),
        bv: f.properties.bv === '' || f.properties.bv == null ? null : r2(Number(f.properties.bv)),
    })).filter((s) => Number.isFinite(s.mag) && Number.isFinite(s.ra));
    rows.sort((a, b) => a.mag - b.mag || a.hip - b.hip);
    const stars = { hip: [], ra: [], dec: [], mag: [], bv: [] };
    for (const s of rows) for (const k of Object.keys(stars)) stars[k].push(s[k]);
    const starNames = {};
    for (const s of rows) {
        const n = names[String(s.hip)];
        if (!n) continue;
        const desig = n.bayer || n.flam || '';
        if (!n.name && !desig) continue;
        starNames[s.hip] = [n.name || '', desig, n.c || ''];
    }
    return { stars, starNames };
}

// ── Constellations ──────────────────────────────────────────────────────────

function buildConstellations(conJson, linesJson) {
    const lines = new Map(linesJson.features.map((f) => [f.id, f.geometry.coordinates]));
    return conJson.features.map((f) => ({
        id: f.id, name: f.properties.name,
        labelRa: ra360(f.geometry.coordinates[0]), labelDec: r3(f.geometry.coordinates[1]),
        lines: (lines.get(f.id) ?? []).map((poly) => poly.flatMap(([lon, lat]) => [ra360(lon), r3(lat)])),
    })).sort((a, b) => a.id.localeCompare(b.id));
}

// ── Deep sky ────────────────────────────────────────────────────────────────

function buildDsos(messier, bright) {
    const out = [];
    for (const f of messier.features) {
        const p = f.properties;
        out.push({
            id: f.id, name: p.alt ? `${p.alt}` : f.id, desig: p.desig || '', messier: f.id,
            kind: DSO_KIND[p.type] ?? 'nebula', type: p.type,
            mag: Number(p.mag) < 99 ? r2(Number(p.mag)) : null, dim: majorAxisArcmin(p.dim),
            ra: ra360(f.geometry.coordinates[0]), dec: r3(f.geometry.coordinates[1]),
        });
    }
    for (const f of bright.features) {
        const p = f.properties;
        if (p.type === 'pos' && f.id === 'GC') continue;     // Sgr A* is the galaxy map's landmark
        const ra = ra360(f.geometry.coordinates[0]), dec = r3(f.geometry.coordinates[1]);
        // Same object already in Messier? Merge (keep the Messier id, add the name).
        const dup = out.find((d) => angularSeparationDeg(ra, dec, d.ra, d.dec) < 0.35);
        const nice = BRIGHT_NAMES[f.id];
        if (dup) {
            // The observer's name wins over Messier's terse alt ("Andromeda" →
            // "Andromeda Galaxy"), except where the name IS the Messier number.
            if (nice && !/^M\d+$/.test(nice)) dup.name = nice;
            if (!dup.desig) dup.desig = f.id;
            continue;
        }
        out.push({
            id: f.id.replace(/\s+/g, ' '), name: nice ?? f.id, desig: f.id, messier: null,
            kind: DSO_KIND[p.type] ?? 'nebula', type: p.type,
            mag: Number(p.mag) < 99 ? r2(Number(p.mag)) : null, dim: majorAxisArcmin(p.dim),
            ra, dec,
        });
    }
    return out;
}

// ── Milky Way raster ────────────────────────────────────────────────────────

/** Crossings of all ring edges with the meridian at `ra` (degrees, −180..180 frame). */
function meridianCrossings(rings, ra) {
    const ys = [];
    for (const ring of rings) {
        for (let i = 0; i < ring.length - 1; i++) {
            let [x1, y1] = ring[i];
            let [x2, y2] = ring[i + 1];
            if (x2 - x1 > 180) x2 -= 360; else if (x1 - x2 > 180) x2 += 360;
            for (const shift of [-360, 0, 360]) {
                const a = x1 + shift, b = x2 + shift;
                // Half-open test so a vertex exactly on the meridian counts once.
                if ((a <= ra && ra < b) || (b <= ra && ra < a)) {
                    ys.push(y1 + (y2 - y1) * (ra - a) / (b - a));
                }
            }
        }
    }
    return ys.sort((p, q) => p - q);
}

export function rasterizeMilkyWay(mw, width = 360, height = 180) {
    const grid = new Uint8Array(width * height);
    for (const feature of mw.features) {
        const rings = feature.geometry.coordinates.flat(1);   // MultiPolygon → all rings
        for (let c = 0; c < width; c++) {
            const raDeg = c + 0.5;                              // 0..360
            const lon = raDeg > 180 ? raDeg - 360 : raDeg;      // GeoJSON frame
            const ys = meridianCrossings(rings, lon);
            let k = 0;
            for (let r = height - 1; r >= 0; r--) {             // from the south pole up
                const dec = 90 - (r + 0.5) * (180 / height);
                while (k < ys.length && ys[k] < dec) k++;
                if (k % 2 === 1) grid[r * width + c]++;
            }
        }
    }
    // Run-length encode, row-major from dec +90 down, RA 0 → 360.
    const rle = [];
    let v = grid[0], n = 0;
    for (let i = 0; i < grid.length; i++) {
        if (grid[i] === v) n++;
        else { rle.push(v, n); v = grid[i]; n = 1; }
    }
    rle.push(v, n);
    return { width, height, levels: mw.features.length, rle };
}

// ── Main ────────────────────────────────────────────────────────────────────

export function buildCatalog({ sources, galacticHtml }) {
    const { stars, starNames } = buildStars(sources['stars.6.json'], sources['starnames.json']);
    const constellations = buildConstellations(sources['constellations.json'], sources['constellations.lines.json']);
    const dsos = buildDsos(sources['messier.json'], sources['dsos.bright.json']);
    const milkyWay = rasterizeMilkyWay(sources['mw.json']);
    const galactic = buildGalacticRecords(extractGalacticCatalog(galacticHtml), stars, dsos);
    return {
        version: CATALOG_VERSION,
        attribution: {
            sky: 'Star, constellation, deep-sky and Milky Way data: d3-celestial by Olaf Frohn (BSD-3-Clause), '
               + 'stars from the Hipparcos catalogue (ESA 1997).',
            galactic: 'Galactic objects: galactic-map.html CATALOG, extracted at build time.',
        },
        counts: { stars: stars.hip.length, named: Object.keys(starNames).length,
                  constellations: constellations.length, dsos: dsos.length, galactic: galactic.length },
        stars, starNames, constellations, dsos, milkyWay, galactic,
    };
}

async function main() {
    if (process.argv.includes('--fetch')) await fetchSources();
    const sources = Object.fromEntries(FILES.map((f) => [f, readSource(f)]));
    const galacticHtml = fs.readFileSync(path.join(ROOT, 'galactic-map.html'), 'utf8');
    const cat = buildCatalog({ sources, galacticHtml });
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(cat) + '\n');
    const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
    console.log(`wrote ${path.relative(ROOT, OUT)} (${kb} KB)`, cat.counts);
    const unmatched = cat.galactic.filter((g) => g.hip == null && g.dso == null);
    console.log(`galactic: ${cat.galactic.length - unmatched.length} matched to the sky, ${unmatched.length} landmarks`);
    for (const g of cat.galactic) {
        const m = g.hip != null ? `HIP ${g.hip}` : g.dso != null ? g.dso : '— landmark';
        console.log(`  ${g.id.padEnd(16)} ${g.group.padEnd(15)} ${m}${g.matchSepDeg != null ? ` (${g.matchSepDeg}°)` : ''}`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch((e) => { console.error(e); process.exit(1); });
}
