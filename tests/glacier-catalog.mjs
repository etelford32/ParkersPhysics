/**
 * tests/glacier-catalog.mjs — the global glacier catalogue (RGI 7.0) and its kernel
 *   node tests/glacier-catalog.mjs
 *
 *  1. PROVENANCE: the committed files are the ones meta.json hashes, and meta.official IS the
 *     RGI Consortium's own table (tests/fixtures/glaciers/RGI2000-v7.0-G-o*region-summary.csv —
 *     real copies of rgi_user_guide v7.0, never hand-edit; their sha256 is pinned in the baker).
 *     (sizes: 84 % of glaciers are under 1 km²; the 994 over 100 km² hold 55 % of the ice.)
 *  2. THE POINTS reproduce that table from the quantised columns: count exactly, area to the
 *     Consortium's rounding, for every o1 region and the globe — 274 531 glaciers, 706 744 km².
 *     NEGATIVE CONTROL: decoding without the byte-unshuffle does not.
 *  3. IDS follow row order: rgiId/indexOfRgiId round-trip, and the baker's point-in-polygon watch
 *     links name the same ids.
 *  4. PICKING: grid nearest ≡ brute force, near the antimeridian and the poles included.
 *  5. DETAIL: offsets undone — zmin ≤ zmean/zmed ≤ zmax, hypsometry sums to 1000 ‰ inside
 *     [zmin, zmax], the terminus lies within the glacier's own max length of its centroid.
 *  6. NAMES / SEARCH: diacritic-folded, prefix first, then larger; RGI ids resolve directly.
 *  9. SPEED (ITS_LIVE composites inside each outline): file hashed, quantisation exact, the verdict is
 *     the tracked tier's rule (2 × the measured pair error) and AGREES with the tracked tier on ≥ 36 of
 *     the 41 linked glaciers; NEGATIVE CONTROL — the ice-free-ground floor it replaced calls
 *     Storglaciären / South Cascade 'moving' and agrees far less.
 *  8. EARTHVIEW PICKING: xyzToLatLon inverts js/geo/coords.js's canonical frame (its source text is
 *     pinned), and the pick radius converts pixels to kilometres at the hit distance.
 *  7. THE ICE-SHEET RULE: the seven ice-sheet outlets have no RGI outline and say why.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as C from '../js/glacier-catalog.js';
import { xyzToLatLon, pickKm } from '../js/earth-glacier-catalog-layer.js';
import * as E from '../js/glacier-engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, '../data/glaciers/catalog');
let checks = 0, failed = 0;
const ok = (c, m) => { checks++; if (!c) { failed++; console.error(`  ✗ ${m}`); } return c; };
const section = (t) => console.log(`\n${t}`);
const read = (f) => fs.readFileSync(path.join(DIR, f));
const csv = (f) => {
    const [h, ...rows] = fs.readFileSync(path.join(HERE, 'fixtures/glaciers', f), 'utf8').trim().split('\n').map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
    return rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
};

const meta = JSON.parse(read('rgi7-meta.json'));
const raw = zlib.gunzipSync(read('rgi7-points.bin.gz'));
const pts = C.decodePoints(raw);

section('1. provenance');
for (const [f, h] of Object.entries(meta.files)) {
    const b = read(f);
    ok(b.length === h.bytes && crypto.createHash('sha256').update(b).digest('hex') === h.sha256, `${f} is the file meta.json hashes`);
}
for (const key of ['o1region', 'o2region']) {
    const rows = csv(`RGI2000-v7.0-G-${key}-summary.csv`);
    ok(rows.length === Object.keys(meta.official[key]).length && rows.every(r => meta.official[key][r[key]]?.count === Number(r.count) && meta.official[key][r[key]]?.area_km2 === Number(r.area_km2)),
        `meta.official.${key} IS the Consortium's table (${rows.length} rows)`);
}
ok(meta.source.mirror.sha256 === 'f16a6c2d08c87d41dc315540ead570e0bab11b2fd4a70b42a4980d290ca0d016' && /F6JMOVY5NAVZ/.test(meta.citation), 'mirror pinned; RGI 7.0 cited by its DOI');

section('2. the points reproduce the official table');
ok(pts.n === 274531 && meta.n === pts.n, `${pts.n} glaciers`);
const tot = C.regionTotals(meta, pts);
let worst = 0;
for (const o1 of meta.o1) {
    const off = meta.official.o1region[o1];
    worst = Math.max(worst, Math.abs(tot[o1].area_km2 - off.area_km2));
    ok(tot[o1].n === off.count && Math.abs(tot[o1].area_km2 - off.area_km2) <= 0.5 + 2e-4 * off.area_km2, `o1 ${o1} ${off.name}: ${tot[o1].n} glaciers, ${tot[o1].area_km2.toFixed(1)} km² (official ${off.area_km2})`);
}
const globalArea = Object.values(tot).reduce((s, r) => s + r.area_km2, 0);
ok(Math.abs(globalArea - 706744) <= 1e-5 * 706744,   // 1 km² of rounding + 0.0144 % per-glacier steps, summed
    `global area ${globalArea.toFixed(1)} km² (official 706 744); worst region ${worst.toFixed(2)} km²`);
ok(pts.lat.every(v => v >= -90 && v <= 90) && pts.lon.every(v => v >= -180 && v <= 180) && pts.area.every(a => a > 0 && a < 6000), 'every centroid on the globe, every area 0–6000 km²');
// NEGATIVE CONTROL: the same bytes read row-interleaved (no unshuffle) are not a glacier inventory
{
    const n = pts.n, dv = new DataView(raw.buffer, raw.byteOffset + 16, 4 * n);
    let y = 0, bad = 0;
    for (let i = 0; i < n; i++) { y += dv.getInt32(i * 4, true); if (Math.abs(y / 1e4) > 180) bad++; }
    ok(bad > n / 10, `negative control: without the byte-unshuffle ${bad} of ${n} longitudes fall off the planet`);
}
let threw = false; try { C.decodePoints(new Uint8Array(32)); } catch { threw = true; }
ok(threw, 'a file without the RGI7 magic is refused, never decoded');
const hist = C.sizeHistogram(pts);
// the bake's histogram uses EXACT areas; a quantised area can cross a class edge (the smallest RGI glacier
// is 0.0100006 km², a hair above the 0.01 edge), so the decoded one may move a few glaciers, no more
const moved = hist.reduce((s, h, k) => s + Math.abs(h.n - meta.size_classes[k].n), 0);
const under1 = hist[0].n + hist[1].n + hist[2].n, over100 = hist.slice(-3).reduce((s, h) => s + h.n, 0), over100A = hist.slice(-3).reduce((s, h) => s + h.area_km2, 0);
ok(moved <= 60 && hist[0].n === 0 && under1 > 0.8 * pts.n && over100 < 0.005 * pts.n && over100A > 0.5 * globalArea,
    `size classes match the bake (${moved} glaciers moved across an edge by quantisation); RGI's floor is 0.01 km²; ${(100 * under1 / pts.n).toFixed(0)} % of glaciers are under 1 km² while the ${over100} over 100 km² hold ${(100 * over100A / globalArea).toFixed(0)} % of the ice`);

section('3. ids follow row order');
for (const i of [0, 1, 27508, 27509, 150000, pts.n - 1]) {
    const id = C.rgiId(meta, i);
    ok(C.indexOfRgiId(meta, id) === i, `row ${i} ⇄ ${id}`);
}
ok(C.rgiId(meta, 0) === 'RGI2000-v7.0-G-01-00001' && C.rgiId(meta, 27509) === 'RGI2000-v7.0-G-02-00001', 'region boundaries (Alaska has 27 509)');
ok(C.indexOfRgiId(meta, 'RGI2000-v7.0-G-01-27510') === null && C.indexOfRgiId(meta, 'RGI60-01.00570') === null && C.indexOfRgiId(meta, 'RGI2000-v7.0-G-20-00001') === null, 'ids past a region, RGI 6 ids and the empty region 20 resolve to null');
const links = Object.entries(meta.watch_links);
const indexIds = JSON.parse(fs.readFileSync(path.join(HERE, '../data/glaciers/glaciers.json'), 'utf8')).glaciers.map(g => g.id).sort();
ok(JSON.stringify(links.map(([id]) => id).sort()) === JSON.stringify(indexIds) && links.filter(([, L]) => L.index !== null).every(([, L]) => C.rgiId(meta, L.index) === L.rgi_id && Math.abs(pts.area[L.index] - L.area_km2) < 1e-3 * L.area_km2 + 1e-3),
    `a watch link for EVERY Glacier Watch glacier (${indexIds.length}; re-run the catalogue bake when the list changes), each naming the row the baker found by point-in-polygon`);
ok(links.filter(([, L]) => L.index !== null).every(([, L]) => C.greatCircleKm(L.at[0], L.at[1], pts.lat[L.index], pts.lon[L.index]) < Math.max(5, 2 * Math.sqrt(pts.area[L.index]))),
    "each tracked glacier's gauge lies within its outline's scale of that outline's centroid");

section('4. picking ≡ brute force');
const grid = C.buildGrid(pts);
const brute = (lat, lon, km) => { let b = -1, d = km; for (let i = 0; i < pts.n; i++) { const g = C.greatCircleKm(lat, lon, pts.lat[i], pts.lon[i]); if (g <= d) { d = g; b = i; } } return b < 0 ? null : b; };
let rng = 7; const rnd = () => ((rng = (rng * 1103515245 + 12345) % 2147483648) / 2147483648);
const probes = [[46.5, 8.0, 5], [61.2, -147.1, 30], [65.8, 179.95, 80], [65.8, -179.95, 80], [-54.6, -36.2, 40], [79.9, -45, 300], [-89.5, 0, 2000], [27.9, 86.9, 3]];
for (let k = 0; k < 40; k++) { const i = Math.floor(rnd() * pts.n); probes.push([pts.lat[i] + (rnd() - 0.5) * 0.3, pts.lon[i] + (rnd() - 0.5) * 0.3, 1 + rnd() * 60]); }
let agree = 0;
for (const [lat, lon, km] of probes) { const g = C.nearest(pts, grid, lat, lon, km); const b = brute(lat, lon, km); if ((g?.index ?? null) === b) agree++; }
ok(agree === probes.length, `grid nearest ≡ brute force on ${probes.length} probes (antimeridian, poles, random) — ${agree} agree`);

section('5. detail');
const shards = {};
const shard = (o1) => (shards[o1] ||= JSON.parse(zlib.gunzipSync(read(`rgi7-detail-${o1}.json.gz`))));
let detOk = 0, sample = 0;
for (let k = 0; k < 400; k++) {
    const i = Math.floor(rnd() * pts.n), o1 = C.o1Of(meta, i);
    const d = C.detailFor(meta, pts, shard(o1), i);
    sample++;
    const hs = d.hypsometry.reduce((s, h) => s + h.frac, 0);
    const inBand = d.hypsometry.every(h => h.z >= d.zmin - 50 && h.z <= d.zmax + 50);
    const termKm = d.term ? C.greatCircleKm(d.lat, d.lon, d.term.lat, d.term.lon) : 0;
    if (d.zmin <= d.zmed && d.zmed <= d.zmax && d.zmin <= d.zmean && d.zmean <= d.zmax && Math.abs(hs - 1) < 0.02 && inBand && termKm * 1000 <= d.lmax_m + 500) detOk++;
}
ok(detOk === sample, `${detOk}/${sample} random glaciers: zmin ≤ zmed, zmean ≤ zmax; hypsometry sums to 1 inside its range; terminus within its own length`);
const al = meta.watch_links.aletsch;
const ald = C.detailFor(meta, pts, shard('11'), al.index, C.decodeNames(JSON.parse(zlib.gunzipSync(read('rgi7-names.json.gz')))));
ok(ald.region === 'Central Europe' && ald.area_km2 > 70 && ald.zmax > 3800 && ald.zmin < 2000 && ald.lmax_m > 18000 && /RGI60-11\./.test(ald.rgi6),
    `Great Aletsch: ${ald.name} · ${ald.area_km2.toFixed(1)} km² · ${ald.zmin}–${ald.zmax} m · ${(ald.lmax_m / 1000).toFixed(1)} km · ${ald.rgi6}`);
ok(C.trackedFor(meta, al.index) === 'aletsch' && C.trackedFor(meta, 0) === null, 'a catalogued outline knows when it is one of the 48 tracked glaciers');

section('6. names and search');
const names = C.decodeNames(JSON.parse(zlib.gunzipSync(read('rgi7-names.json.gz'))));
ok(names.list.length === meta.derived.o1 && true || names.list.length === Object.values(meta.derived.o1).reduce((s, r) => s + (r.named || 0), 0), `${names.list.length} named glaciers, matching the region counts`);
const named = (i) => names.byIndex.get(i);
const s1 = C.search(meta, pts, names, 'aletsch');
ok(s1.length > 0 && /aletsch/i.test(named(s1[0])) && pts.area[s1[0]] > 50, `"aletsch" → ${named(s1[0])} first (the largest prefix match)`);
const s2 = C.search(meta, pts, names, 'rhone');
ok(s2.some(i => /rh[oô]ne/i.test(named(i))), 'diacritics fold ("rhone" finds the Rhône)');
ok(C.search(meta, pts, names, 'RGI2000-v7.0-G-11-01706')[0] === meta.watch_links.rhone.index && C.search(meta, pts, names, 'rgi2000-v7.0-g-11-01706')[0] === meta.watch_links.rhone.index, 'an RGI id resolves to its row, any case');
ok(C.search(meta, pts, names, '').length === 0 && C.search(meta, pts, names, 'zzzzqqq').length === 0, 'empty or unknown query → nothing, never a guess');

section('7. the ice-sheet rule');
const sheets = links.filter(([, L]) => L.index === null).map(([id]) => id).sort();
ok(JSON.stringify(sheets) === JSON.stringify(['helheim', 'jakobshavn', 'kangerlussuaq', 'lambert', 'petermann', 'pine-island', 'thwaites']) && links.filter(([, L]) => L.index === null).every(([, L]) => /ice sheet/.test(L.reason)),
    `the seven ice-sheet outlets have no RGI outline and say why (${sheets.join(', ')})`);
ok(meta.official.o1region['20'].count === 0 && meta.derived.o1['20'].n === 0, 'region 20 (Antarctic mainland) is empty in RGI 7.0 and stays empty here');
const rows = C.regionRows(meta);
ok(rows.length === 20 && Math.abs(rows.reduce((s, r) => s + r.share, 0) - 1) < 1e-3 && rows.find(r => r.o1 === '19').largest.area_km2 > 1000, 'region table: 20 rows, shares sum to 1, the largest glacier per region');
ok(/marine-terminating/.test(meta.term_type_note) && /not land-terminating/.test(meta.term_type_note), 'RGI 7.0 assigns only the marine class — the rest is "not assigned", and the meta says so');

section('8. EarthView picking geometry');
{
    const src = fs.readFileSync(path.join(HERE, '../js/geo/coords.js'), 'utf8');
    ok(/cl \* Math\.cos\(lon\),\s*Math\.sin\(lat\),\s*-cl \* Math\.sin\(lon\)/.test(src), 'coords.js still maps (lat, lon) → (cos φ cos λ, sin φ, −cos φ sin λ) — the frame transliterated below');
    const toXYZ = (lat, lon) => { const p = lat * Math.PI / 180, l = lon * Math.PI / 180; return [Math.cos(p) * Math.cos(l), Math.sin(p), -Math.cos(p) * Math.sin(l)]; };
    let worst = 0;
    for (const [lat, lon] of [[46.48, 8.03], [-72.5, 68.5], [61.17, -147.08], [0, 179.99], [0, -179.99], [89.9, 10], [-33.58, -70.13]]) {
        const [a, b] = xyzToLatLon(...toXYZ(lat, lon).map(v => v * 1.0032));
        worst = Math.max(worst, Math.abs(a - lat), Math.abs(((b - lon + 540) % 360) - 180));
    }
    ok(worst < 1e-9, `xyzToLatLon inverts the canonical frame (worst ${worst.toExponential(1)}°), radius-independent`);
    // NEGATIVE CONTROL: the three.js-sphere convention (lon = atan2(z, −x)) names the antipodal meridian
    const [, wrong] = (([x, y, z]) => [0, Math.atan2(z, -x) * 180 / Math.PI])(toXYZ(46.48, 8.03));
    ok(Math.abs(Math.abs(wrong - 8.03) - 180) < 1e-6, 'negative control: the mesh-UV convention lands 180° away (the earth.html antipode scar)');
    // 10 CSS px at dpr 2, 1200 device px per radian, 1.5 Earth radii away → 10·2/1200·1.5·6371 km
    ok(Math.abs(pickKm(10, 2, 1200, 1.5) - 159.275) < 0.01 && pickKm(10, 1, 1200, 0.01) < 1, 'pick radius: pixels → km at the hit distance (159 km from orbit, < 1 km close in)');
}

section('9. surface speed (ITS_LIVE)');
{
    const smeta = JSON.parse(read('rgi7-speed-meta.json'));
    const sb = read('rgi7-speed.bin.gz');
    ok(sb.length === smeta.files['rgi7-speed.bin.gz'].bytes && crypto.createHash('sha256').update(sb).digest('hex') === smeta.files['rgi7-speed.bin.gz'].sha256 && smeta.source.mirror_sha256 === meta.source.mirror.sha256,
        'rgi7-speed.bin.gz is the file its meta hashes, built from the same pinned mirror');
    const spd = C.decodeSpeed(zlib.gunzipSync(sb));
    ok(spd.n === pts.n && smeta.summary.no_tile === 333, `${spd.n} rows (the catalogue's), ${smeta.summary.no_tile} outside every ITS_LIVE tile`);
    let qmax = 0;
    for (const v of [0, 0.37, 1.8, 47, 1180, 13120]) { const q = Math.round((Math.log10(v + 0.01) + 2.5) * 8000); qmax = Math.max(qmax, Math.abs(C.dequantSpeed(q) - v) / Math.max(v, 0.01)); }
    ok(qmax < 4e-4 && Number.isNaN(C.dequantSpeed(0)), `speed quantisation within ${(100 * qmax).toFixed(3)} % (0 = none, never 0 m/yr)`);
    const o1At = (i) => meta.o2[pts.o2[i]].slice(0, 2);
    ok(Object.keys(smeta.pair_error.by_o1).length >= 12 && Object.values(smeta.pair_error.by_o1).every(v => v > 10 && v < 60) && smeta.pair_error.global_ > 15 && smeta.pair_error.global_ < 40,
        `pair errors measured per region (${Object.keys(smeta.pair_error.by_o1).length} regions, 10–60 m/yr; global ${smeta.pair_error.global_})`);
    const counts = {};
    for (let i = 0; i < spd.n; i++) { const st = C.speedOf(spd, smeta, i, o1At(i)).state; counts[st] = (counts[st] || 0) + 1; }
    ok(counts.below > 0.9 * spd.n && counts.moving + counts.partly > 2000 && !counts['no-floor'], `most of the inventory is below what ITS_LIVE resolves (${counts.below} below, ${counts.moving} moving, ${counts.partly} partly)`);
    // the two tiers must agree: a tracked glacier with ANY resolved flowline point ⇔ catalogue moving/partly
    const idx = E.decodeIndex(JSON.parse(fs.readFileSync(path.join(HERE, '../data/glaciers/glaciers.json'), 'utf8')));
    const tierAgree = (verdict) => {
        let agree = 0, n = 0;
        for (const g of idx) {
            const L = meta.watch_links[g.id]; if (L.index === null) continue; n++;
            const tracked = Array.from(g.climatology.v0).some((v, k) => Number.isFinite(v) && E.detectable(g, k).ok);
            if (tracked === verdict(L.index)) agree++;
        }
        return { agree, n };
    };
    const cat = tierAgree((i) => ['moving', 'partly'].includes(C.speedOf(spd, smeta, i, o1At(i)).state));
    ok(cat.agree >= 36 && cat.n === 41, `catalogue and tracked tier agree on ${cat.agree}/${cat.n} linked glaciers (the rest are < 2 % tongues and one-glacier regions)`);
    // NEGATIVE CONTROL: the rejected ice-free-ground floor
    const flo = tierAgree((i) => { const t = smeta.tiles[spd.tile[i]]; return t && t.p90 != null && spd.p98[i] > t.p90; });
    ok(flo.agree <= cat.agree - 15, `negative control: the ice-free-ground floor agrees on only ${flo.agree}/${flo.n} (it calls the slowest glaciers 'moving')`);
    const sg = C.speedOf(spd, smeta, meta.watch_links.storglaciaren.index, '08'), co = C.speedOf(spd, smeta, meta.watch_links.columbia.index, '01');
    ok(sg.state === 'below' && co.state !== 'below' && co.p98 > 1000 && C.speedColor(sg) === C.SPEED_NEUTRAL && C.speedColor(co) === C.SPEED_BANDS.at(-1).color,
        `Storglaciären below detection (neutral), Columbia resolved at ${Math.round(co.p98)} m/yr (the lightest band)`);
}

section('10. year-by-year speed (resolved glaciers only)');
{
    // (a) the chart geometry, on a synthetic series — years land on the x extent, 0 on the baseline, a gap breaks the line
    const syn = [2015, 2016, 2017, 2018, 2019].map((year, k) => ({ year, med: 50 + k, p98: 200 + 10 * k, err: 5, cov: k === 2 ? 30 : 90, drawn: k !== 2, partial: false }));
    const M = C.annualChartModel(syn, { width: 296, height: 156, threshold: 40 });
    ok(Math.abs(M.x(2015) - M.pad.l) < 1e-9 && Math.abs(M.x(2019) - (296 - M.pad.r)) < 1e-9 && Math.abs(M.y(0) - (156 - M.pad.b)) < 1e-9 && M.top >= 240,
        `chart model: years span the plot, 0 m/yr on the baseline, top ${M.top} ≥ the largest value`);
    ok(M.runs.length === 2 && M.runs[0].length === 2 && M.runs[1].length === 2 && M.gaps === 1, 'a year under the coverage floor breaks the line into two runs (a gap, never a value)');
    // (b) the decoder ≡ the baker's layout, on a hand-built file (u32 [n, m, year0, 0], shuffled cols)
    const shuffle = (ta) => { const b = new Uint8Array(ta.buffer), size = ta.BYTES_PER_ELEMENT, n = ta.length, o = new Uint8Array(b.length); for (let i = 0; i < n; i++) for (let k = 0; k < size; k++) o[k * n + i] = b[i * size + k]; return o; };
    const q = (v) => Math.round((Math.log10(v + 0.01) + 2.5) * 8000);
    const parts = [new TextEncoder().encode('RGI7ANN\u0001'), new Uint8Array(new Uint32Array([2, 5, 1980, 0]).buffer),
        shuffle(new Uint32Array([7, 4242])), new Uint8Array([35, 40]), new Uint8Array([3, 2]),
        shuffle(new Uint16Array([q(10), q(11), 0, q(500), q(510)])), shuffle(new Uint16Array([q(30), q(31), 0, q(900), q(910)])),
        shuffle(new Uint16Array([q(2), q(2), 0, q(20), q(21)])), new Uint8Array([90, 80, 0, 100, 60])];
    const file = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { file.set(p, o); o += p.length; }
    const dec = C.decodeAnnual(file);
    const g = dec.get(4242), a = dec.get(7);
    ok(dec.size === 2 && a.years.join() === '2015,2016,2017' && g.years.join() === '2020,2021' && Math.abs(g.p98[1] - 910) < 0.5 && Number.isNaN(a.med[2]) && g.cov[1] === 60,
        'decodeAnnual reads the baker\'s layout (index, first year, run length, quantised columns, coverage)');
    const rows = C.annualSeries(dec, { cover_min: 50, partial_year: 2021 }, 4242);
    ok(rows[1].drawn && rows[1].partial && !C.annualSeries(dec, { cover_min: 50 }, 7)[2].drawn && C.annualSeries(dec, { cover_min: 50 }, 99) === null,
        'annualSeries: partial year flagged, an empty year not drawn, a glacier without a series → null');
    //@@DATA@@
}

console.log(`\n${checks - failed}/${checks} checks passed`);
if (failed) process.exit(1);
