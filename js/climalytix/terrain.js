/**
 * climalytix/terrain.js — elevation levels and sun exposure, PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no ambient time (tests/climalytix-terrain.mjs pins every
 * rule). CLIMALYTIX_PLAN.md §19 step T1; T2–T6 build on this module.
 *
 * THE DEM is AWS Terrain Tiles (Terrarium PNG: h = R·256 + G + B/256 − 32768
 * metres; public, attribution "Terrain Tiles: Mapzen / AWS — SRTM, GMTED,
 * ETOPO1, NED, …"), fetched through /api/climalytix/dem. Tiles are Web
 * Mercator; the map is equirectangular. So the DEM is SAMPLED onto a lat/lon
 * grid through the exact inverse (`tileXY`) — a tile image is never stretched
 * onto the map, which would bend every contour north–south.
 *
 * SLOPE AND ASPECT are a Sobel gradient on a 2-node baseline (EarthView's
 * topoGradient rule: a one-node difference reads quantisation steps as
 * ridges) in METRES — the east–west node spacing is cos φ of the north–south
 * one, per row. Aspect is the compass direction the slope FACES (downslope,
 * 0 = N, clockwise): a hill rising to the north faces SOUTH. That sign is the
 * classic trap and the gate pins both ways.
 *
 * SUN EXPOSURE is direct-beam geometry on the slope, from the site's ONE Sun
 * (js/sun-altitude.js solarPosition):
 *     cos θ = cos s · sin α + sin s · cos α · cos(A☉ − aspect)
 * clamped at 0 (the slope faces away) and 0 with the Sun down. Flat ground is
 * sin α exactly. "Today" is the day's integral of that over flat ground's —
 * 1 on the flat by construction. SELF-SHADING ONLY: a slope in a neighbour's
 * shadow is not darkened (no horizon/cast-shadow ray march) — disclosed. It is
 * a top-of-atmosphere geometric ratio (clear sky, no air-mass attenuation),
 * which is the honest first rung; cloud enters at T3.
 */

import { solarPosition } from '../sun-altitude.js';

export const TILE_PX = 256;
export const DEM_MAX_Z = 12;
export const DEM_MIN_Z = 3;
export const DEM_ATTRIBUTION = 'Terrain Tiles (Mapzen / AWS Open Data — SRTM, GMTED2010, ETOPO1 and others)';
const R_EARTH_M = 6_371_008.8;
const M_PER_DEG = Math.PI * R_EARTH_M / 180;
const MERC_MAX_LAT = 85.0511287798;
const D2R = Math.PI / 180;

/** Terrarium RGB → metres. */
export function terrariumDecode(r, g, b) {
    return r * 256 + g + b / 256 - 32768;
}

/** Inverse, for the gate's fixtures and the mock tiles: metres → [r, g, b]. */
export function terrariumEncode(h) {
    const v = h + 32768;
    const r = Math.floor(v / 256), g = Math.floor(v - r * 256);
    const b = Math.round((v - r * 256 - g) * 256);
    return b === 256 ? [r, g + 1, 0] : [r, g, b];
}

/** Fractional Web-Mercator tile coordinates of (lat, lon) at zoom z. */
export function tileXY(lat, lon, z) {
    const n = 2 ** z;
    const la = Math.max(-MERC_MAX_LAT, Math.min(MERC_MAX_LAT, lat)) * D2R;
    const lo = ((((lon + 180) % 360) + 360) % 360);
    return {
        x: lo / 360 * n,
        y: (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n,
    };
}

/** Inverse of tileXY (tile-corner coordinates → lat/lon). */
export function tileLatLon(x, y, z) {
    const n = 2 ** z;
    return { lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) / D2R, lon: x / n * 360 - 180 };
}

/**
 * The tile zoom whose pixels are about one screen pixel: the smallest z with
 * ≥ `pxPerDeg` (device) tile pixels per degree of longitude, clamped.
 */
export function demZoomFor(pxPerDeg) {
    let z = DEM_MIN_Z;
    while (z < DEM_MAX_Z && TILE_PX * 2 ** z / 360 < pxPerDeg) z++;
    return z;
}

/** Tiles (z, x, y) covering a lat/lon box (lon may be unwrapped; x wraps). */
export function tilesFor(box, z) {
    const n = 2 ** z;
    const a = tileXY(box.north, box.west, z), b = tileXY(box.south, box.east, z);
    const y0 = Math.max(0, Math.floor(a.y)), y1 = Math.min(n - 1, Math.floor(b.y - 1e-9));
    const span = box.east - box.west;
    const x0 = Math.floor(a.x), x1 = Math.floor(a.x + span / 360 * n - 1e-9);
    const out = [];
    for (let y = y0; y <= y1; y++) for (let xx = x0; xx <= x1; xx++) out.push({ z, x: ((xx % n) + n) % n, y });
    return out;
}

/**
 * Sample a DEM onto a regular lat/lon grid. `heightAt(lat, lon)` returns
 * metres or null (no tile / a hole). Grid nodes run NW → SE; values NaN where
 * unknown. Returns { latN, lonW, dlat, dlon, nRows, nCols, values }.
 */
export function sampleGrid(box, nCols, nRows, heightAt) {
    const dlat = (box.north - box.south) / (nRows - 1), dlon = (box.east - box.west) / (nCols - 1);
    const values = new Float32Array(nRows * nCols);
    for (let i = 0; i < nRows; i++) {
        const lat = box.north - i * dlat;
        for (let j = 0; j < nCols; j++) {
            const h = heightAt(lat, box.west + j * dlon);
            values[i * nCols + j] = h == null || !Number.isFinite(h) ? NaN : h;
        }
    }
    return { latN: box.north, lonW: box.west, dlat, dlon, nRows, nCols, values };
}

/**
 * Slope (degrees) and aspect (degrees, the direction the slope FACES,
 * 0 = N clockwise; NaN on flat ground or where the stencil touches a gap) for
 * every grid node. Sobel on a 2-node baseline in metres, cos φ spacing per row.
 * opts.method 'forward' is the negative control (one-node, east/north only).
 */
export function slopeAspect(g, { method = 'sobel2' } = {}) {
    const { nRows, nCols, values } = g;
    const slope = new Float32Array(nRows * nCols).fill(NaN);
    const aspect = new Float32Array(nRows * nCols).fill(NaN);
    const dzdx = new Float32Array(nRows * nCols).fill(NaN), dzdy = new Float32Array(nRows * nCols).fill(NaN);
    const at = (i, j) => values[i * nCols + j];
    const dyM = g.dlat * M_PER_DEG;
    for (let i = 0; i < nRows; i++) {
        const lat = g.latN - i * g.dlat;
        const dxM = g.dlon * M_PER_DEG * Math.cos(lat * D2R);
        for (let j = 0; j < nCols; j++) {
            let gx, gy;
            if (method === 'forward') {
                if (i + 1 >= nRows || j + 1 >= nCols) continue;
                gx = (at(i, j + 1) - at(i, j)) / dxM;
                gy = (at(i, j) - at(i + 1, j)) / dyM;            // rise toward the NORTH
            } else {
                if (i < 1 || j < 1 || i + 1 >= nRows || j + 1 >= nCols) continue;
                const ex = (r) => at(r, j + 1) - at(r, j - 1);
                const ny = (c) => at(i - 1, c) - at(i + 1, c);    // row i−1 is NORTH
                gx = (ex(i - 1) + 2 * ex(i) + ex(i + 1)) / (8 * dxM);
                gy = (ny(j - 1) + 2 * ny(j) + ny(j + 1)) / (8 * dyM);
            }
            if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
            const k = i * nCols + j;
            dzdx[k] = gx; dzdy[k] = gy;
            const mag = Math.hypot(gx, gy);
            slope[k] = Math.atan(mag) / D2R;
            // Faces DOWNSLOPE: the direction of −∇h, as a compass bearing.
            aspect[k] = mag < 1e-9 ? NaN : (Math.atan2(-gx, -gy) / D2R + 360) % 360;
        }
    }
    return { slope, aspect, dzdx, dzdy };
}

/** Direct-beam cosine on a slope (≥ 0; 0 with the Sun down or the slope facing away). */
export function incidence(slopeDeg, aspectDeg, sunAltDeg, sunAzDeg) {
    if (!(sunAltDeg > 0)) return 0;
    const s = slopeDeg * D2R, a = sunAltDeg * D2R;
    const asp = Number.isFinite(aspectDeg) ? aspectDeg : 0;
    const c = Math.cos(s) * Math.sin(a) + Math.sin(s) * Math.cos(a) * Math.cos((sunAzDeg - asp) * D2R);
    return Math.max(0, c);
}

/**
 * The day's direct beam on the slope ÷ on flat ground, from `dayStartMs`
 * over 24 h in `steps` samples of the site's Sun. 1 on flat ground exactly;
 * null when the Sun never rises (polar night).
 */
export function dailyRatio(slopeDeg, aspectDeg, lat, lon, dayStartMs, { steps = 96 } = {}) {
    let slope = 0, flat = 0;
    for (let k = 0; k < steps; k++) {
        const p = solarPosition(new Date(dayStartMs + (k + 0.5) * 86_400_000 / steps), lat, lon);
        if (p.altitudeDeg <= 0) continue;
        flat += Math.sin(p.altitudeDeg * D2R);
        slope += incidence(slopeDeg, aspectDeg, p.altitudeDeg, p.azimuthDeg);
    }
    return flat > 0 ? slope / flat : null;
}

/**
 * A round contour interval in the READER's unit (m or ft) giving 4–14 lines
 * across [minM, maxM]; returns { step, levels:[{ m, label, major }] }, major
 * = every 5th from zero. A flat window has none.
 */
export function elevationLevels(minM, maxM, { toDisplay = (m) => m, fromDisplay = (d) => d, sym = 'm' } = {}) {
    if (!(maxM > minM)) return { step: null, levels: [] };
    const lo = toDisplay(minM), hi = toDisplay(maxM);
    const steps = sym === 'ft' ? [10, 20, 50, 100, 200, 250, 500, 1000, 2000, 5000] : [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000];
    const step = steps.find((s) => (hi - lo) / s <= 14) ?? steps[steps.length - 1];
    const levels = [];
    for (let d = Math.ceil(lo / step) * step; d <= hi; d += step) {
        levels.push({ m: fromDisplay(d), label: `${d.toLocaleString('en-US')} ${sym}`, major: Math.round(d / step) % 5 === 0 });
    }
    return { step, levels };
}

/** Compass name of a bearing (16 points). */
export function compass16(deg) {
    const N = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    return N[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

// ── The DEM route's pure half (api/climalytix/dem.js fetches) ───────────────

/**
 * Upstream hosts for the Terrarium pyramid, in order. UNVERIFIED from the
 * build sandbox (egress-blocked): the route stops at the first that answers
 * with a PNG and says which (`X-DEM-Source`); its no-coordinate form probes
 * all of them, so ONE production request settles the list:
 *     curl -s https://parkersphysics.com/api/climalytix/dem | jq .resolved,.candidates
 */
export const DEM_CANDIDATES = Object.freeze([
    Object.freeze({ id: 'aws-s3-path', url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png' }),
    Object.freeze({ id: 'aws-s3-host', url: 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png' }),
]);
export const DEM_PROBE = Object.freeze({ z: 3, x: 1, y: 3 });      // central US: a tile every source has

/** Validate a tile request: integers, 0 ≤ z ≤ DEM_MAX_Z, x/y inside the matrix. */
export function parseDemTile(q) {
    const toInt = (v) => (v == null || !/^\d+$/.test(String(v)) ? NaN : Number(v));
    const z = toInt(q.z), x = toInt(q.x), y = toInt(q.y);
    if (![z, x, y].every(Number.isInteger)) return { error: 'z, x and y must be non-negative integers' };
    if (z > DEM_MAX_Z) return { error: `z must be ≤ ${DEM_MAX_Z}` };
    const n = 2 ** z;
    if (x >= n || y >= n) return { error: `x and y must be < ${n} at z=${z}` };
    return { z, x, y };
}

/** The upstream URL for a candidate — rebuilt from the frozen template, never passed through. */
export function demTileUrl(candidate, { z, x, y }) {
    return candidate.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

/** Is this byte buffer a PNG (an error page served 200 is not)? */
export function isPng(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
}

/** Browser path for one tile (through our route). */
export function demPath({ z, x, y }) {
    return `/api/climalytix/dem?z=${z}&x=${x}&y=${y}`;
}

// ── Sampling the tile pyramid and painting exposure ─────────────────────────

/**
 * A height sampler over decoded tiles: `getTile(z, x, y)` → RGBA
 * Uint8ClampedArray of TILE_PX² or null. Bilinear in the tile's PIXEL
 * centres; a stencil that crosses a tile edge reads the neighbour tile; any
 * missing corner ⇒ null (a hole, never a guess).
 */
export function tileSampler(z, getTile) {
    const n = 2 ** z, size = TILE_PX;
    const px = (gx, gy) => {
        if (gy < 0 || gy >= n * size) return null;
        const w = n * size, X = ((gx % w) + w) % w;
        const tx = Math.floor(X / size), ty = Math.floor(gy / size);
        const d = getTile(z, tx, ty);
        if (!d) return null;
        const o = ((gy - ty * size) * size + (X - tx * size)) * 4;
        return terrariumDecode(d[o], d[o + 1], d[o + 2]);
    };
    return (lat, lon) => {
        const t = tileXY(lat, lon, z);
        const fx = t.x * size - 0.5, fy = t.y * size - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
        const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
        if (a == null || b == null || c == null || d == null) return null;
        return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
    };
}

/**
 * Exposure ratios on the grid (Float32Array, NaN where unknown):
 *   mode 'now'   — incidence ÷ sin α at each node, the Sun from `sunAt(lat, lon)`
 *                  ({ altitudeDeg, azimuthDeg }); NaN where the Sun is down
 *   mode 'today' — Σ incidence ÷ Σ sin α over `track` (one day's Sun samples,
 *                  shared by the whole window)
 */
export function exposureGrid(g, sa, { mode = 'now', sunAt = null, track = null } = {}) {
    const out = new Float32Array(g.nRows * g.nCols).fill(NaN);
    const day = mode === 'today' ? (track || []).filter((s) => s.altitudeDeg > 0) : null;
    const flatDay = day ? day.reduce((a, s) => a + Math.sin(s.altitudeDeg * D2R), 0) : 0;
    for (let i = 0; i < g.nRows; i++) {
        const lat = g.latN - i * g.dlat;
        for (let j = 0; j < g.nCols; j++) {
            const k = i * g.nCols + j;
            const s = sa.slope[k];
            if (!Number.isFinite(s)) continue;
            const asp = sa.aspect[k];
            if (mode === 'today') {
                if (!(flatDay > 0)) continue;
                let sum = 0;
                for (const p of day) sum += incidence(s, asp, p.altitudeDeg, p.azimuthDeg);
                out[k] = sum / flatDay;
            } else {
                const p = sunAt(lat, g.lonW + j * g.dlon);
                if (!(p.altitudeDeg > 0)) continue;
                out[k] = incidence(s, asp, p.altitudeDeg, p.azimuthDeg) / Math.sin(p.altitudeDeg * D2R);
            }
        }
    }
    return out;
}

/** Shade (less sun than flat ground) and sun (more) — a diverging pair, transparent at 1×. */
export const EXPOSURE_SHADE = Object.freeze([0.29, 0.27, 0.70]);
export const EXPOSURE_SUN = Object.freeze([1.0, 0.76, 0.22]);
export const EXPOSURE_ALPHA = 0.85;
/**
 * |log₂ ratio| at which the colour is full strength: half a stop, 0.71× /
 * 1.41×. At ½× / 2× (one stop) a 10° slope at 40° N painted ~20 % opaque and
 * the layer read as empty; real slopes mostly sit within ±½ stop, so that is
 * the range the scale spends its colour on. The key prints these numbers.
 */
export const EXPOSURE_FULL_LOG2 = 0.5;

/**
 * Heat-image painter for an exposure ratio: alpha grows with |log₂ ratio|
 * (full strength at ±EXPOSURE_FULL_LOG2 stops), hue says which side of flat ground.
 */
export function exposurePaint(ratio, data, o) {
    if (!Number.isFinite(ratio)) return;
    const strength = ratio <= 0 ? 1 : Math.min(1, Math.abs(Math.log2(ratio)) / EXPOSURE_FULL_LOG2);
    const c = ratio < 1 ? EXPOSURE_SHADE : EXPOSURE_SUN;
    data[o] = Math.round(c[0] * 255); data[o + 1] = Math.round(c[1] * 255); data[o + 2] = Math.round(c[2] * 255);
    data[o + 3] = Math.round(255 * EXPOSURE_ALPHA * strength);
}
