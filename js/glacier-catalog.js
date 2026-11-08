/**
 * js/glacier-catalog.js — EVERY glacier on Earth (RGI 7.0), the global tier under Glacier Watch
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * PURE: no DOM, no three.js, no fetch in the decoders (the two loaders at the bottom take a
 * fetch function). Node-gated by tests/glacier-catalog.mjs; read by glacier-watch.html's
 * catalogue section and EarthView's "All glaciers" sub-layer.
 *
 * THE DATA (data/glaciers/catalog/, baked by scripts/build-glacier-catalog.py):
 *   rgi7-points.bin.gz       all 274 531 glaciers — centroid, area, median elevation, flags,
 *                            second-order region — delta-coded + byte-shuffled columns
 *   rgi7-detail-<o1>.json.gz the rest of RGI's attributes, one file per first-order region,
 *                            loaded only when a glacier there is opened
 *   rgi7-names.json.gz       the 9 457 glaciers with a usable name
 *   rgi7-meta.json           provenance, the RGI Consortium's OWN region tables, derived stats,
 *                            the size classes, and the links from the 48 Glacier Watch glaciers
 *
 *   rgi7-speed.bin.gz        ITS_LIVE surface speed for every glacier (+ rgi7-speed-meta.json: per-tile
 *                            noise floors) — loaded only when a speed view is asked for
 *
 * WHAT THIS IS AND IS NOT. An INVENTORY: outlines dated by their source imagery (median 2002,
 * 1943–2021), not a measurement of today. It says where every glacier is and how big. Its speed
 * table is ITS_LIVE's 2014–2024 MEAN (`speedOf`), judged against each tile's measured noise floor —
 * a decade's average, never today's motion (that is the 48-glacier tier, pair by pair), and no
 * mass balance is ever invented for the other 274 000. The page and the layer say so.
 *
 * Load-bearing facts:
 *   • ROW i IS RGI2000-v7.0-G-<o1>-<seq>: ids follow row order inside each o1 region (the baker
 *     refuses otherwise), so no id strings ship — `rgiId` derives them from meta.starts.
 *   • Areas are 10^(q/8000 − 4) km² from a UINT16 (0.0144 % per glacier; the first format's signed
 *     int16 overflowed above ~1 900 km² and turned 64 000 km² of ice into tiny glaciers). Region sums reproduce the Consortium's
 *     rounded table, which is what the gate checks.
 *   • RGI 7.0 assigns ONLY the marine-terminating class. Every other glacier is "not assigned" —
 *     never print it as land-terminating.
 *   • The ice sheets are NOT in RGI (region 20, Antarctic mainland, has zero glaciers): seven of
 *     the 48 tracked glaciers (Jakobshavn, Helheim, Kangerlussuaq, Petermann, Thwaites, Pine
 *     Island, Lambert) have no RGI outline, and `meta.watch_links` carries the reason.
 *   • Nearest-glacier picking is GREAT-CIRCLE over a 1° grid that searches as many cells as the
 *     radius needs at that latitude (cos φ) and wraps the antimeridian — pinned against brute force.
 */

export const CATALOG_BASE = '/data/glaciers/catalog/';
export const R_EARTH_KM = 6371.0088;
export const SURGE_LABELS = Object.freeze(['no evidence', 'possible', 'probable', 'observed']);

// THE ONE PALETTE for the catalogue, shared by glacier-watch.html's map and EarthView's layer so
// the key and the globe carry the same bytes. Two jobs, never mixed: median elevation is ONE
// sequential hue (reference blue 600 → 100, dark = low, validated on the #0b1120 surface);
// terminus & surge is categorical (slot 1 / slot 2) over a neutral that means NOT ASSIGNED.
export const ELEV_BANDS = Object.freeze([
    { lo: -Infinity, label: '< 1 000 m', color: '#184f95' },
    { lo: 1000, label: '1–2 km', color: '#256abf' },
    { lo: 2000, label: '2–3 km', color: '#3987e5' },
    { lo: 3000, label: '3–4 km', color: '#6da7ec' },
    { lo: 4000, label: '4–5 km', color: '#9ec5f4' },
    { lo: 5000, label: '≥ 5 km', color: '#cde2fb' },
]);
export const CLASS_COLORS = Object.freeze({ marine: '#3987e5', surge: '#d95926', none: '#6b7486' });
export function elevColor(zmed) {
    let c = ELEV_BANDS[0].color;
    for (const b of ELEV_BANDS) if (zmed >= b.lo) c = b.color;
    return c;
}
export function classColor(flags) {
    const f = flagsOf(flags);
    return f.marine ? CLASS_COLORS.marine : f.surge ? CLASS_COLORS.surge : CLASS_COLORS.none;
}

// ── points ───────────────────────────────────────────────────────────────────
const MAGIC = 'RGI7PTS\u0002';   // v2: area column is uint16 (log10 a + 4)·8000 — v1's int16 overflowed above ~1 900 km²

function unshuffle(bytes, off, n, size) {
    const out = new Uint8Array(n * size);
    for (let b = 0; b < size; b++) {
        const plane = off + b * n;
        for (let i = 0; i < n; i++) out[i * size + b] = bytes[plane + i];
    }
    return out;
}

/** The DECOMPRESSED points file → columns. Throws on a wrong magic (never decodes garbage). */
export function decodePoints(u8) {
    const bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    const magic = String.fromCharCode(...bytes.subarray(0, 8));
    if (magic !== MAGIC) throw new Error('not an RGI7 points file');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(8, true);
    if (dv.getUint32(12, true) !== 6) throw new Error('unexpected column count');
    let off = 16;
    const col32 = () => { const u = unshuffle(bytes, off, n, 4); off += 4 * n; return new Int32Array(u.buffer); };
    const col16 = () => { const u = unshuffle(bytes, off, n, 2); off += 2 * n; return new Int16Array(u.buffer); };
    const colU16 = () => { const u = unshuffle(bytes, off, n, 2); off += 2 * n; return new Uint16Array(u.buffer); };
    const dLon = col32(), dLat = col32(), logA = colU16(), zmed = col16();
    const flags = bytes.slice(off, off + n); off += n;
    const o2 = bytes.slice(off, off + n); off += n;
    if (off !== bytes.length) throw new Error(`points file length ${bytes.length} ≠ ${off}`);
    const lonQ = new Int32Array(n), latQ = new Int32Array(n);
    const lon = new Float64Array(n), lat = new Float64Array(n), area = new Float64Array(n);
    let x = 0, y = 0;
    for (let i = 0; i < n; i++) {
        x += dLon[i]; y += dLat[i];
        lonQ[i] = x; latQ[i] = y; lon[i] = x / 1e4; lat[i] = y / 1e4;
        area[i] = Math.pow(10, logA[i] / 8000 - 4);
    }
    return { n, lon, lat, lonQ, latQ, area, zmed, flags, o2 };
}

export function flagsOf(f) {
    return { marine: !!(f & 1), surge: (f >> 1) & 3, isRgi6: !!(f & 8), named: !!(f & 16) };
}

/** Row index → 'RGI2000-v7.0-G-<o1>-<seq>' (ids follow row order inside each o1). */
export function rgiId(meta, i) {
    const o1 = o1Of(meta, i);
    if (!o1) return null;
    return `RGI2000-v7.0-G-${o1}-${String(i - meta.starts[o1] + 1).padStart(5, '0')}`;
}

export function o1Of(meta, i) {
    let best = null;
    for (const [o1, s] of Object.entries(meta.starts)) if (s <= i && (best === null || s > meta.starts[best])) best = o1;
    if (best === null || i >= meta.n || i < 0) return null;
    return best;
}

/** 'RGI2000-v7.0-G-11-01706' → row index (or null). */
export function indexOfRgiId(meta, id) {
    const m = /^RGI2000-v7\.0-G-(\d\d)-(\d{5})$/.exec(String(id || '').trim());
    if (!m || !(m[1] in meta.starts)) return null;
    const i = meta.starts[m[1]] + Number(m[2]) - 1;
    const next = Object.values(meta.starts).filter(s => s > meta.starts[m[1]]).sort((a, b) => a - b)[0] ?? meta.n;
    return Number(m[2]) >= 1 && i < next ? i : null;
}

// ── geometry ─────────────────────────────────────────────────────────────────
const RAD = Math.PI / 180;
export function greatCircleKm(lat1, lon1, lat2, lon2) {
    const s1 = Math.sin((lat2 - lat1) * RAD / 2), s2 = Math.sin((lon2 - lon1) * RAD / 2);
    const h = s1 * s1 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * s2 * s2;
    return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A 1° bucket index over the points (built once, ~30 ms for 274 k). */
export function buildGrid(pts, cellDeg = 1) {
    const nx = Math.round(360 / cellDeg), ny = Math.round(180 / cellDeg);
    const counts = new Uint32Array(nx * ny + 1);
    const cell = new Uint32Array(pts.n);
    for (let i = 0; i < pts.n; i++) {
        const cx = Math.min(nx - 1, Math.floor((pts.lon[i] + 180) / cellDeg));
        const cy = Math.min(ny - 1, Math.floor((pts.lat[i] + 90) / cellDeg));
        cell[i] = cy * nx + cx; counts[cell[i] + 1]++;
    }
    for (let k = 1; k < counts.length; k++) counts[k] += counts[k - 1];
    const order = new Uint32Array(pts.n), fill = counts.slice(0, nx * ny);
    for (let i = 0; i < pts.n; i++) order[fill[cell[i]]++] = i;
    return { cellDeg, nx, ny, start: counts, order };
}

/**
 * Nearest glacier centroid to (lat, lon) within maxKm, great-circle. `filter(i)` may exclude rows.
 * Searches every cell the radius can reach at this latitude (wider near the poles), wrapping the
 * antimeridian. Returns { index, km } or null.
 */
export function nearest(pts, grid, lat, lon, maxKm, filter = null) {
    const dLatDeg = maxKm / (R_EARTH_KM * RAD);
    const latLo = Math.max(-90, lat - dLatDeg), latHi = Math.min(90, lat + dLatDeg);
    const cosMin = Math.min(Math.cos(latLo * RAD), Math.cos(latHi * RAD));
    const polar = latLo <= -89.999 || latHi >= 89.999 || cosMin < 1e-6;
    const dLonDeg = polar ? 180 : Math.min(180, dLatDeg / cosMin);
    const { cellDeg, nx, ny, start, order } = grid;
    const cy0 = Math.max(0, Math.floor((latLo + 90) / cellDeg)), cy1 = Math.min(ny - 1, Math.floor((latHi + 90) / cellDeg));
    const span = Math.min(nx, Math.ceil(2 * dLonDeg / cellDeg) + 2);
    const cx0 = Math.floor((lon - dLonDeg + 180) / cellDeg);
    let best = -1, bestKm = maxKm;
    for (let cy = cy0; cy <= cy1; cy++) {
        for (let k = 0; k < span; k++) {
            const cx = ((cx0 + k) % nx + nx) % nx;
            const c = cy * nx + cx;
            for (let p = start[c]; p < start[c + 1]; p++) {
                const i = order[p];
                if (filter && !filter(i)) continue;
                const d = greatCircleKm(lat, lon, pts.lat[i], pts.lon[i]);
                if (d <= bestKm) { bestKm = d; best = i; }
            }
        }
    }
    return best < 0 ? null : { index: best, km: bestKm };
}

// ── statistics ───────────────────────────────────────────────────────────────
/** Count and area per o1 region, recomputed from the points (the gate compares with meta.official). */
export function regionTotals(meta, pts) {
    const out = {};
    for (const o1 of meta.o1) out[o1] = { n: 0, area_km2: 0 };
    for (let i = 0; i < pts.n; i++) {
        const o2 = meta.o2[pts.o2[i]], o1 = o2.slice(0, 2);
        out[o1].n++; out[o1].area_km2 += pts.area[i];
    }
    return out;
}

/** Glaciers and area per size class — "most glaciers are tiny; most ice is in a few large ones". */
export function sizeHistogram(pts, edges = [0.01, 0.1, 1, 10, 100, 1000, 10000]) {
    const e = [0, ...edges, Infinity];
    const rows = e.slice(0, -1).map((lo, k) => ({ lo, hi: e[k + 1] === Infinity ? null : e[k + 1], n: 0, area_km2: 0 }));
    for (let i = 0; i < pts.n; i++) {
        const a = pts.area[i];
        let k = 0;
        while (k < rows.length - 1 && a >= e[k + 1]) k++;
        rows[k].n++; rows[k].area_km2 += a;
    }
    return rows;
}

/** The region table the page prints: the Consortium's numbers beside the derived ones. */
export function regionRows(meta) {
    return meta.o1.map(o1 => {
        const off = meta.official.o1region[o1], der = meta.derived.o1[o1];
        return {
            o1, name: off.name, n: off.count, area_km2: off.area_km2, share: off.area_km2 / meta.official.o1region.Global.area_km2,
            largest: der.n ? der.largest : null, marine: der.marine ?? 0, surge: der.surge ?? [0, 0, 0, 0],
            named: der.named ?? 0, zmedMedian: der.zmed_median ?? null,
        };
    });
}

// ── names ────────────────────────────────────────────────────────────────────
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** [[index, name], …] → a searchable list. */
export function decodeNames(json) {
    return { list: json.map(([i, name]) => ({ i, name, key: fold(name) })), byIndex: new Map(json) };
}

/**
 * Search by name (diacritics folded) or by RGI id. Prefix matches rank first, then larger glaciers.
 * Returns up to `limit` row indexes.
 */
export function search(meta, pts, names, query, limit = 12) {
    const q = String(query || '').trim();
    if (!q) return [];
    const byId = indexOfRgiId(meta, q.toUpperCase().replace(/^RGI2000-V7\.0/, 'RGI2000-v7.0'));
    if (byId !== null) return [byId];
    const k = fold(q);
    const hits = [];
    for (const e of names.list) {
        const at = e.key.indexOf(k);
        if (at < 0) continue;
        const word = at === 0 || /[\s\-'(/]/.test(e.key[at - 1]);
        hits.push({ i: e.i, rank: at === 0 ? 0 : word ? 1 : 2, area: pts.area[e.i] });
    }
    hits.sort((a, b) => a.rank - b.rank || b.area - a.area);
    return hits.slice(0, limit).map(h => h.i);
}

// ── detail ───────────────────────────────────────────────────────────────────
/**
 * Everything RGI says about glacier i: the points columns + its region shard (decompressed JSON),
 * with the shard's offsets undone. Pure; the shard must be the one for o1Of(meta, i).
 */
export function detailFor(meta, pts, shard, i, names = null) {
    const k = i - shard.start;
    if (k < 0 || k >= shard.n) throw new Error(`row ${i} is not in shard ${shard.o1}`);
    const f = flagsOf(pts.flags[i]);
    const zmed = pts.zmed[i], zmin = zmed - shard.dzmin[k];
    const hyp = shard.hyp[k] || [];
    const z0 = zmin + shard.dz0[k];
    const term = shard.dterm[k];
    return {
        index: i, rgi_id: rgiId(meta, i), o1: shard.o1, o2: meta.o2[pts.o2[i]],
        region: meta.official.o1region[shard.o1]?.name ?? null,
        subregion: meta.official.o2region[meta.o2[pts.o2[i]]]?.name ?? null,
        name: names ? names.byIndex.get(i) ?? null : null,
        lat: pts.lat[i], lon: pts.lon[i], area_km2: pts.area[i],
        zmin, zmed, zmax: zmed + shard.dzmax[k], zmean: zmed + shard.dzmean[k],
        slope_deg: shard.slope10[k] == null ? null : shard.slope10[k] / 10, aspect_deg: shard.aspect[k], lmax_m: shard.lmax[k],
        term: term && term[0] != null ? { lon: (pts.lonQ[i] + term[0]) / 1e4, lat: (pts.latQ[i] + term[1]) / 1e4 } : null,
        year: shard.year[k], dem: shard.dem[k], rgi6: shard.rgi6[k],
        marine: f.marine, surge: f.surge, surgeLabel: SURGE_LABELS[f.surge], sameAsRgi6: f.isRgi6,
        hypsometry: hyp.map((p, b) => ({ z: z0 + meta.hypsometry_band_m * b, frac: p / 1000 })),
    };
}

/** The tracked Glacier Watch glacier whose outline this is (or null). */
export function trackedFor(meta, i) {
    for (const [id, L] of Object.entries(meta.watch_links || {})) if (L.index === i) return id;
    return null;
}

// ── surface speed (NASA ITS_LIVE composites; scripts/build-glacier-catalog-speed.py) ──────────
// For every glacier: v0 (the composite's fitted mean speed, 2014–2024 where the tile has it)
// summarised over the pixels INSIDE its RGI outline — median and fastest tenth — plus the trend
// dv_dt and the tile it came from. THE VERDICT IS THE TRACKED TIER'S RULE (glacier-engine
// `detectable`): resolved only above TWICE the typical single-pair error, measured from the tracked
// archive per RGI region (`smeta.pair_error`). The ice-free-ground floor was tried first and is
// WORTHLESS both ways (≈0 by ITS_LIVE's own stable-ground correction, which called Storglaciären
// "moving" at 1.8 m/yr; 24–149 m/yr where sea ice passes for ground) — see the baker's header.
// ORANGE ordinal ramp (the second sequential context takes the next categorical hue; validated on
// #060a14: monotone, one hue, light end ≥ 2:1), dark = slow, light = fast; NEUTRAL = not measurably
// moving or no data — never a speed colour for noise.
export const SPEED_BANDS = Object.freeze([
    { lo: -Infinity, label: '< 10 m/yr', color: '#8a3512' },
    { lo: 10, label: '10–30', color: '#ad4419' },
    { lo: 30, label: '30–100', color: '#cf5822' },
    { lo: 100, label: '100–300', color: '#ea7438' },
    { lo: 300, label: '300–1000', color: '#f39a66' },
    { lo: 1000, label: '≥ 1 km/yr', color: '#f9c4a0' },
]);
export const SPEED_NEUTRAL = '#4b5263';
export const SPEED_STATES = Object.freeze({
    moving: 'resolved by ITS_LIVE', partly: 'only its fastest ice is resolved by ITS_LIVE', below: 'below what ITS_LIVE resolves',
    'no-data': 'no valid ITS_LIVE pixels', 'no-tile': 'outside ITS_LIVE coverage',
});

/** uint16 log-quantised speed → m/yr (0 = none). Inverse of the baker's qspeed. */
export function dequantSpeed(q) { return q === 0 ? NaN : Math.pow(10, q / 8000 - 2.5) - 0.01; }

const SPD_MAGIC = 'RGI7SPD\u0002';   // v2 adds p98 (the fastest ice: p90 missed narrow tongues and icefalls)
/** The DECOMPRESSED speed file → columns (NaN where there is no value). */
export function decodeSpeed(u8) {
    const bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    if (String.fromCharCode(...bytes.subarray(0, 8)) !== SPD_MAGIC) throw new Error('not an RGI7 speed file');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(8, true);
    let off = 16;
    const col = (Ctor, size) => { const u = unshuffle(bytes, off, n, size); off += size * n; return new Ctor(u.buffer); };
    const tile = col(Uint16Array, 2), qm = col(Uint16Array, 2), qp = col(Uint16Array, 2), qx = col(Uint16Array, 2), qe = col(Uint16Array, 2);
    const dvq = col(Int16Array, 2), npix = col(Uint16Array, 2);
    const cov = bytes.slice(off, off + n); off += n;
    const flags = bytes.slice(off, off + n); off += n;
    if (off !== bytes.length) throw new Error(`speed file length ${bytes.length} ≠ ${off}`);
    const med = new Float32Array(n), p90 = new Float32Array(n), p98 = new Float32Array(n), err = new Float32Array(n), dvdt = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        med[i] = dequantSpeed(qm[i]); p90[i] = dequantSpeed(qp[i]); p98[i] = dequantSpeed(qx[i]); err[i] = dequantSpeed(qe[i]);
        dvdt[i] = dvq[i] === -32768 ? NaN : dvq[i] / 10;
    }
    return { n, tile, med, p90, p98, err, dvdt, npix, cov, flags };
}

/** The typical single-pair error (m/yr) for an RGI o1 region: measured per region, else the global median. */
export function pairErrorFor(smeta, o1) {
    const pe = smeta.pair_error, v = pe.by_o1[o1];
    return v != null ? { sigma: v, n: pe.n_by_o1[o1], scope: 'region' } : { sigma: pe.global_, n: pe.n, scope: 'global' };
}

/**
 * Everything the speed table says about glacier i (in o1 region `o1`), with the verdict: RESOLVED when
 * a speed exceeds 2 × the region's typical pair error — `moving` if the median does, `partly` if only
 * the fastest ice (p98) does, `below` otherwise.
 */
export function speedOf(spd, smeta, i, o1) {
    if (spd.tile[i] === 65535) return { state: 'no-tile', label: SPEED_STATES['no-tile'] };
    const t = smeta.tiles[spd.tile[i]];
    const pe = pairErrorFor(smeta, o1);
    const base = {
        // npix is a uint16 column: 65535 means "at least that many" (Hubbard has ~197 000)
        med: spd.med[i], p90: spd.p90[i], p98: spd.p98[i], dvdt: spd.dvdt[i], npix: spd.npix[i],
        coverage: spd.cov[i] === 255 ? null : spd.cov[i], subpixel: !!(spd.flags[i] & 1),
        threshold: 2 * pe.sigma, pairError: pe, tileUrl: t.url,
    };
    let state;
    if (spd.flags[i] & 2 || !Number.isFinite(base.p98)) state = 'no-data';
    else if (base.med > base.threshold) state = 'moving';
    else if (base.p98 > base.threshold) state = 'partly';
    else state = 'below';
    return { ...base, state, label: SPEED_STATES[state] };
}

/** The map / globe colour for a speedOf() result: orange by the fastest ice (p98), neutral unless resolved. */
export function speedColor(s) {
    if (!s || (s.state !== 'moving' && s.state !== 'partly')) return SPEED_NEUTRAL;
    let c = SPEED_BANDS[0].color;
    for (const b of SPEED_BANDS) if (s.p98 >= b.lo) c = b.color;
    return c;
}

// ── the year-by-year speed of a RESOLVED glacier (scripts/build-glacier-catalog-annual.py) ──
// One file per RGI o1 region, fetched when a record card opens. Each CALENDAR year of the glacier's
// ITS_LIVE annual composite (seasonal cycle already fitted out), over the speed table's own pixels:
// median, p98, median v_error and coverage (valid pixels that year ÷ pixels with a valid v0). Only the
// speed table's moving / partly glaciers have a series — a below-detection glacier's yearly line is
// noise, and `annualSeries` returns null for it on purpose. A year below `cover_min` is a GAP (a
// half-imaged glacier's median is the median of whichever half was imaged), never a value; the meta's
// `partial_year` is drawn as partial (the release was built in September of that year).
export const ANNUAL_COLORS = Object.freeze({ fastest: '#d95926', typical: '#3987e5' });   // validated pair on #0a101e (dark band, CVD ΔE 26.8)
const ANN_MAGIC = 'RGI7ANN\u0001';
/** The DECOMPRESSED annual file → Map(row index → { years, med, p98, err, cov }). */
export function decodeAnnual(u8) {
    const bytes = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    if (String.fromCharCode(...bytes.subarray(0, 8)) !== ANN_MAGIC) throw new Error('not an RGI7 annual-speed file');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(8, true), m = dv.getUint32(12, true), year0 = dv.getUint32(16, true);
    let off = 24;
    const idx = new Uint32Array(unshuffle(bytes, off, n, 4).buffer); off += 4 * n;
    const y0 = bytes.slice(off, off + n); off += n;
    const ny = bytes.slice(off, off + n); off += n;
    const col = () => { const u = new Uint16Array(unshuffle(bytes, off, m, 2).buffer); off += 2 * m; return u; };
    const qm = col(), qx = col(), qe = col();
    const cov = bytes.slice(off, off + m); off += m;
    if (off !== bytes.length) throw new Error(`annual file length ${bytes.length} ≠ ${off}`);
    const out = new Map();
    for (let s = 0, r = 0; s < n; s++) {
        const k = ny[s], years = new Array(k), med = new Float32Array(k), p98 = new Float32Array(k), err = new Float32Array(k), c = new Uint8Array(k);
        for (let j = 0; j < k; j++, r++) {
            years[j] = year0 + y0[s] + j; med[j] = dequantSpeed(qm[r]); p98[j] = dequantSpeed(qx[r]); err[j] = dequantSpeed(qe[r]); c[j] = cov[r];
        }
        if (r > m) throw new Error('annual file: year rows overrun');
        out.set(idx[s], { years, med, p98, err, cov: c });
    }
    return out;
}

/**
 * Glacier i's rows for the chart: { year, med, p98, err, cov, drawn, partial }, or null when the glacier
 * has no series (not resolved, or outside the bake). `drawn` = the coverage reaches `cover_min`.
 */
export function annualSeries(dec, ameta, i) {
    const s = dec?.get(i);
    if (!s) return null;
    return s.years.map((year, j) => ({
        year, med: s.med[j], p98: s.p98[j], err: s.err[j], cov: s.cov[j],
        drawn: s.cov[j] >= ameta.cover_min && Number.isFinite(s.p98[j]),
        partial: year === ameta.partial_year,
    }));
}

/** Pixel geometry of the chart (PURE, so the gate can check where a year lands): years → x, m/yr → y from 0. */
export function annualChartModel(rows, { width = 296, height = 150, pad = { l: 34, r: 8, t: 10, b: 20 }, threshold = null } = {}) {
    const shown = rows.filter(r => r.drawn);
    const y0 = rows[0].year, y1 = rows.at(-1).year;
    const vmax = Math.max(threshold ?? 0, ...shown.map(r => r.p98), ...shown.map(r => r.med + (Number.isFinite(r.err) ? r.err : 0)), 1e-6);
    const step = niceStep(vmax / 4), top = Math.ceil(vmax / step) * step;
    const W = width - pad.l - pad.r, H = height - pad.t - pad.b;
    const x = (yr) => pad.l + (y1 === y0 ? W / 2 : (yr - y0) / (y1 - y0) * W);
    const y = (v) => pad.t + H - v / top * H;
    const ticks = []; for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
    const span = y1 - y0, yStep = span > 24 ? 10 : span > 10 ? 5 : span > 5 ? 2 : 1;
    const yearTicks = []; for (let yr = Math.ceil(y0 / yStep) * yStep; yr <= y1; yr += yStep) yearTicks.push(yr);
    // one polyline segment per unbroken run of drawn years (a gap year breaks the line)
    const runs = []; let cur = null;
    for (const r of rows) { if (r.drawn) { (cur ||= []).push(r); } else if (cur) { runs.push(cur); cur = null; } }
    if (cur) runs.push(cur);
    return { x, y, top, ticks, yearTicks, runs, y0, y1, width, height, pad, gaps: rows.filter(r => !r.drawn).length };
}
function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9)))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// ── loaders (fetch injected; DecompressionStream is in every current browser and Node ≥ 18) ──
export async function gunzip(buf) {
    // A host that labels a .gz with Content-Encoding: gzip has ALREADY decompressed it in transit;
    // decompressing again would throw. The gzip magic (1f 8b) decides, never the URL.
    const head = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, 2);
    if (!(head[0] === 0x1f && head[1] === 0x8b)) return new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function loadCatalog(fetchFn = fetch, base = CATALOG_BASE) {
    const get = async (f) => { const r = await fetchFn(base + f); if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r; };
    const meta = await (await get('rgi7-meta.json')).json();
    const pts = decodePoints(await gunzip(await (await get(meta.points.file)).arrayBuffer()));
    if (pts.n !== meta.n) throw new Error(`points ${pts.n} ≠ meta ${meta.n}`);
    return { meta, pts };
}

export async function loadNames(fetchFn = fetch, base = CATALOG_BASE) {
    const r = await fetchFn(base + 'rgi7-names.json.gz');
    if (!r.ok) throw new Error(`names: HTTP ${r.status}`);
    return decodeNames(JSON.parse(new TextDecoder().decode(await gunzip(await r.arrayBuffer()))));
}

export async function loadSpeed(fetchFn = fetch, base = CATALOG_BASE) {
    const m = await fetchFn(base + 'rgi7-speed-meta.json');
    if (!m.ok) throw new Error(`speed meta: HTTP ${m.status}`);
    const smeta = await m.json();
    const r = await fetchFn(base + 'rgi7-speed.bin.gz');
    if (!r.ok) throw new Error(`speed: HTTP ${r.status}`);
    const spd = decodeSpeed(await gunzip(await r.arrayBuffer()));
    if (spd.n !== smeta.n) throw new Error(`speed rows ${spd.n} ≠ meta ${smeta.n}`);
    return { smeta, spd };
}

/** The annual meta (once) and region o1's annual file → { ameta, dec } (dec is null if the region has no resolved glacier). */
export async function loadAnnualMeta(fetchFn = fetch, base = CATALOG_BASE) {
    const m = await fetchFn(base + 'rgi7-annual-meta.json');
    if (!m.ok) throw new Error(`annual meta: HTTP ${m.status}`);
    return m.json();
}
export async function loadAnnual(ameta, o1, fetchFn = fetch, base = CATALOG_BASE) {
    const sh = ameta.shards[o1];
    if (!sh) return null;
    const r = await fetchFn(base + sh.file);
    if (!r.ok) throw new Error(`annual ${o1}: HTTP ${r.status}`);
    const dec = decodeAnnual(await gunzip(await r.arrayBuffer()));
    if (dec.size !== sh.series) throw new Error(`annual ${o1}: ${dec.size} series ≠ meta ${sh.series}`);
    return dec;
}

export async function loadShard(o1, fetchFn = fetch, base = CATALOG_BASE) {
    const r = await fetchFn(`${base}rgi7-detail-${o1}.json.gz`);
    if (!r.ok) throw new Error(`detail ${o1}: HTTP ${r.status}`);
    return JSON.parse(new TextDecoder().decode(await gunzip(await r.arrayBuffer())));
}
