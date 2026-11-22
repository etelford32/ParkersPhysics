/**
 * bathy.js — reading the baked bathymetry grids (data/seafloor/*.bin.gz). PURE.
 *
 * A grid is int16 metres of ELEVATION (negative below sea level), row 0 = NORTH, col 0 = WEST,
 * on a regular lat/lon lattice of `step` degrees (scripts/build-seafloor-bathymetry.py). Every
 * function here speaks DEPTH, metres positive DOWN; the sign flips once, in `depthAtCell`.
 *
 * The source is ETOPO1 / GEBCO 2014 through the AWS Terrain Tiles: ~1.8 km cells of mostly
 * altimetry-PREDICTED depth. `GRID_VERTICAL_UNCERTAINTY_M` is a stated order of magnitude for
 * such grids in trenches, NOT a measured error of this bake — the page prints it as "±".
 */
export const R_EARTH_KM = 6371.0088;
export const GRID_VERTICAL_UNCERTAINTY_M = 150;
export const HADAL_DEPTH_M = 6000;
const D2R = Math.PI / 180;

export function makeGrid(meta, int16) {
    if (int16.length !== meta.nx * meta.ny) throw new Error(`grid ${meta.id}: ${int16.length} values for ${meta.nx}×${meta.ny}`);
    return { id: meta.id, nx: meta.nx, ny: meta.ny, north: meta.north, west: meta.west, step: meta.step_deg, z: int16 };
}
export function int16FromBytes(u8) {
    if (u8.byteLength % 2) throw new Error('odd byte length for an int16 grid');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = new Int16Array(u8.byteLength / 2);
    for (let i = 0; i < out.length; i++) out[i] = dv.getInt16(i * 2, true);   // little-endian whatever the host is
    return out;
}

export const depthAtCell = (g, i, j) => -g.z[j * g.nx + i];
export const cellLat = (g, j) => g.north - j * g.step;
export const cellLon = (g, i) => g.west + i * g.step;
const wrap180 = (lon) => ((lon + 540) % 360) - 180;
/** Fractional column of a longitude, unwrapped to the grid's own (possibly > 180) span. */
function colOf(g, lon) { let d = lon - g.west; d -= 360 * Math.floor(d / 360); return d / g.step; }

/** Bilinear depth (m, + down) at a point; null outside the window. */
export function sampleDepth(g, lat, lon) {
    let fj = (g.north - lat) / g.step, fi = colOf(g, lon);
    // a point ON the window's edge is inside it: float error in (north − lat)/step must not reject it
    const E = 1e-6;
    if (fi > g.nx - 1 && fi > 360 / g.step - E) fi -= 360 / g.step;
    if (!(fj >= -E) || !(fi >= -E) || fj > g.ny - 1 + E || fi > g.nx - 1 + E) return null;
    fj = Math.min(Math.max(fj, 0), g.ny - 1); fi = Math.min(Math.max(fi, 0), g.nx - 1);
    const i0 = Math.min(Math.floor(fi), g.nx - 2), j0 = Math.min(Math.floor(fj), g.ny - 2);
    const u = fi - i0, v = fj - j0;
    return (depthAtCell(g, i0, j0) * (1 - u) + depthAtCell(g, i0 + 1, j0) * u) * (1 - v)
         + (depthAtCell(g, i0, j0 + 1) * (1 - u) + depthAtCell(g, i0 + 1, j0 + 1) * u) * v;
}

export function deepest(g) {
    let k = 0;
    for (let n = 1; n < g.z.length; n++) if (g.z[n] < g.z[k]) k = n;
    const j = Math.floor(k / g.nx), i = k - j * g.nx;
    return { lat: cellLat(g, j), lon: wrap180(cellLon(g, i)), depth: -g.z[k], i, j };
}

/** Great-circle destination: start, initial bearing (deg clockwise from north), distance km. */
export function destination(lat, lon, bearingDeg, km) {
    const d = km / R_EARTH_KM, b = bearingDeg * D2R, p1 = lat * D2R, l1 = lon * D2R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 / D2R, lon: wrap180(l2 / D2R) };
}
export function distanceKm(lat1, lon1, lat2, lon2) {
    const p1 = lat1 * D2R, p2 = lat2 * D2R;
    const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((lon2 - lon1) * D2R / 2) ** 2;
    return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Depth along a great circle through (lat, lon): `n` samples from −halfKm to +halfKm. Gaps are null. */
export function section(g, lat, lon, azimuthDeg, halfKm, n = 201) {
    const out = [];
    for (let k = 0; k < n; k++) {
        const s = -halfKm + (2 * halfKm) * k / (n - 1);
        const q = s >= 0 ? destination(lat, lon, azimuthDeg, s) : destination(lat, lon, azimuthDeg + 180, -s);
        out.push({ s, lat: q.lat, lon: q.lon, depth: sampleDepth(g, q.lat, q.lon) });
    }
    return out;
}

/**
 * The trench AXIS through a point: the bearing (0–175°) whose ±halfKm line has the greatest mean
 * depth — a trench is deep ALONG itself and shoals ACROSS itself. `contrast` (m) is the deepest
 * minus the shallowest line mean; on an abyssal plain it is small and the axis means nothing
 * (`defined` false below `minContrastM`). The cross-section the page draws is axis + 90°.
 */
export function trenchAxis(g, lat, lon, { halfKm = 60, stepDeg = 5, minContrastM = 300 } = {}) {
    let best = null, worst = null;
    for (let az = 0; az < 180; az += stepDeg) {
        const sec = section(g, lat, lon, az, halfKm, 41).filter((p) => p.depth != null);
        if (sec.length < 30) continue;
        const mean = sec.reduce((a, p) => a + p.depth, 0) / sec.length;
        if (!best || mean > best.mean) best = { az, mean };
        if (!worst || mean < worst.mean) worst = { az, mean };
    }
    if (!best) return null;
    const contrast = best.mean - worst.mean;
    return { azimuthDeg: best.az, acrossDeg: (best.az + 90) % 180, contrast, defined: contrast >= minContrastM };
}

/** Steepest slope (degrees) between consecutive samples of a section, and where. */
export function steepest(sec) {
    let out = { deg: 0, s: null };
    for (let k = 1; k < sec.length; k++) {
        const a = sec[k - 1], b = sec[k];
        if (a.depth == null || b.depth == null) continue;
        const deg = Math.atan2(Math.abs(b.depth - a.depth), Math.abs(b.s - a.s) * 1000) / D2R;
        if (deg > out.deg) out = { deg, s: (a.s + b.s) / 2 };
    }
    return out;
}

const cellAreaKm2 = (g, j) => (g.step * D2R * R_EARTH_KM) ** 2 * Math.cos(cellLat(g, j) * D2R);

/**
 * Area-weighted depth statistics of the window's OCEAN cells (cos φ per row — a 1′ cell at 79° N
 * is a fifth of one at the equator; the unweighted count is the gate's negative control).
 */
export function hypsometry(g, binM = 500) {
    const bins = new Map();
    let area = 0, hadal = 0, hadalVolume = 0, sum = 0;
    for (let j = 0; j < g.ny; j++) {
        const a = cellAreaKm2(g, j);
        for (let i = 0; i < g.nx; i++) {
            const d = depthAtCell(g, i, j);
            if (d <= 0) continue;
            area += a; sum += d * a;
            const b = Math.floor(d / binM) * binM;
            bins.set(b, (bins.get(b) || 0) + a);
            if (d > HADAL_DEPTH_M) { hadal += a; hadalVolume += a * (d - HADAL_DEPTH_M) / 1000; }
        }
    }
    const rows = [...bins.entries()].sort((x, y) => x[0] - y[0]).map(([from, a]) => ({ from, to: from + binM, areaKm2: a, share: a / area }));
    let acc = 0, median = null;
    for (const r of rows) { if (acc + r.areaKm2 >= area / 2) { median = r.from + binM * (area / 2 - acc) / r.areaKm2; break; } acc += r.areaKm2; }
    return { bins: rows, oceanAreaKm2: area, meanDepth: area ? sum / area : null, medianDepth: median, hadalAreaKm2: hadal, hadalVolumeKm3: hadalVolume };
}

/** Local east/north offsets (km) of a cell from a point — flat-Earth, fine inside one window. */
export function localOffsetKm(lat0, lon0, lat, lon) {
    let dl = lon - lon0; dl -= 360 * Math.round(dl / 360);
    return { e: dl * D2R * R_EARTH_KM * Math.cos(lat0 * D2R), n: (lat - lat0) * D2R * R_EARTH_KM };
}
