/**
 * seafloor-age.js — how old the ocean floor is, everywhere (PURE: no DOM, no three.js).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * Data: Seton et al. (2020), G³ 21, e2020GC009214 — release 2020.1 (GTS2012), baked by
 * scripts/build-seafloor-age.mjs as every 2nd node of the 6′ grid (0.2°, SUBSAMPLED, never
 * averaged; rows north → south). Format in that script's header.
 *
 * What it is: the age of the OCEANIC crust, from magnetic anomaly picks, fracture zones and the
 * authors' plate model, interpolated between them. What it is not: an age for continental crust
 * (no value), or a measurement at every node — between isochrons the age is the authors'
 * interpolation, and the release README names its own artefacts (microplates such as Bauer,
 * fracture zones in the central Atlantic, highly oblique spreading on the SW Indian Ridge).
 *
 *   ageAt     bilinear between the four nodes around a point when all four are ocean; at a coast
 *             (a corner is not ocean) the NEAREST node's value, and null if that is not ocean —
 *             an interpolation never invents ocean floor over a continent.
 *   areaAgeDistribution   ocean-floor AREA per age bin, each node weighted by its true cell area
 *             on the sphere (gridline-registered: the polar rows carry half cells). This is the
 *             classic area–age distribution: a planet that makes and destroys sea floor at a
 *             steady rate, consuming it regardless of age, has area falling roughly linearly with
 *             age — measured here, not assumed.
 *
 * tests/earth-interior-seafloor-age.mjs holds this decoder to the release's TEXT twin (.xyz), and
 * the grid to an independent age product (Müller et al. 1997, as Bird tabulates it at his
 * PB2002 boundary steps).
 */

export const R_EARTH_KM = 6371;
const DEG = Math.PI / 180;

/** Decode the baked bytes (already gunzipped) with their meta → { nLat, nLon, stepDeg, ages: Float32Array (NaN = no oceanic crust) }. */
export function decodeSeafloorAge(meta, bytes) {
    const { nLat, nLon, stepDeg, quantumMyr, none } = meta.grid;
    const n = nLat * nLon;
    if (bytes.length !== 2 * n) throw new Error(`seafloor age: ${bytes.length} bytes, expected ${2 * n}`);
    const ages = new Float32Array(n);
    let prev = 0;
    for (let k = 0; k < n; k++) {
        if (k % nLon === 0) prev = 0;
        const z = (bytes[k] << 8) | bytes[n + k];
        if (z === none) { ages[k] = NaN; prev = 0; continue; }
        const d = z & 1 ? -((z + 1) >> 1) : z >> 1;
        prev += d;
        ages[k] = prev * quantumMyr;
    }
    return { nLat, nLon, stepDeg, lat0: meta.grid.lat0, lon0: meta.grid.lon0, ages };
}

const wrapLon = (lon) => ((((lon - -180) % 360) + 360) % 360) - 180;

/** The baked node value at row i (north → south), column j (west → east, wrapping). */
export function nodeAge(g, i, j) {
    if (i < 0 || i >= g.nLat) return NaN;
    j = ((j % g.nLon) + g.nLon) % g.nLon;
    return g.ages[i * g.nLon + j];
}

/** Age (Myr) at (lat, lon), or null where there is no oceanic crust. */
export function ageAt(g, latDeg, lonDeg) {
    const y = (g.lat0 - latDeg) / g.stepDeg, x = (wrapLon(lonDeg) - g.lon0) / g.stepDeg;
    const i0 = Math.max(0, Math.min(g.nLat - 2, Math.floor(y))), j0 = Math.floor(x);
    const fy = Math.max(0, Math.min(1, y - i0)), fx = x - j0;
    const a = nodeAge(g, i0, j0), b = nodeAge(g, i0, j0 + 1), c = nodeAge(g, i0 + 1, j0), d = nodeAge(g, i0 + 1, j0 + 1);
    if (!Number.isNaN(a) && !Number.isNaN(b) && !Number.isNaN(c) && !Number.isNaN(d)) {
        return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
    const near = nodeAge(g, i0 + (fy >= 0.5 ? 1 : 0), j0 + (fx >= 0.5 ? 1 : 0));
    return Number.isNaN(near) ? null : near;
}

/** True cell area (km²) of a gridline-registered node in row i. */
export function nodeAreaKm2(g, i) {
    const h = g.stepDeg / 2, lat = g.lat0 - i * g.stepDeg;
    const top = Math.min(90, lat + h) * DEG, bot = Math.max(-90, lat - h) * DEG;
    return R_EARTH_KM * R_EARTH_KM * (g.stepDeg * DEG) * (Math.sin(top) - Math.sin(bot));
}

/**
 * Area of ocean floor per age bin and its summary:
 * { binMyr, bins: [{ from, to, areaKm2 }], oceanAreaKm2, globeFraction, meanMyr, medianMyr, olderThan: { 100, 150, 180 } (area fractions) }.
 */
export function areaAgeDistribution(g, binMyr = 10) {
    const counts = [];
    let total = 0, sum = 0;
    for (let i = 0; i < g.nLat; i++) {
        const w = nodeAreaKm2(g, i);
        for (let j = 0; j < g.nLon; j++) {
            const a = g.ages[i * g.nLon + j];
            if (Number.isNaN(a)) continue;
            const b = Math.floor(a / binMyr);
            counts[b] = (counts[b] || 0) + w;
            total += w; sum += w * a;
        }
    }
    const bins = [];
    for (let b = 0; b < counts.length; b++) bins.push({ from: b * binMyr, to: (b + 1) * binMyr, areaKm2: counts[b] || 0 });
    let acc = 0, median = null;
    for (const bin of bins) {
        if (median == null && acc + bin.areaKm2 >= total / 2) median = bin.from + ((total / 2 - acc) / bin.areaKm2) * binMyr;
        acc += bin.areaKm2;
    }
    const older = (t) => bins.reduce((s, b) => s + (b.from >= t ? b.areaKm2 : b.to > t ? b.areaKm2 * (b.to - t) / binMyr : 0), 0) / total;
    return {
        binMyr, bins, oceanAreaKm2: total, globeFraction: total / (4 * Math.PI * R_EARTH_KM * R_EARTH_KM),
        meanMyr: sum / total, medianMyr: median, olderThan: { 100: older(100), 150: older(150), 180: older(180) },
    };
}

/**
 * The ONE age ramp (young → old), shared with the boundary colouring on the plates view so a
 * boundary and the sea floor beside it wear the same colour for the same age. Sequential, one
 * hue family light → dark; the end is AGE_RAMP_MAX_MYR and older crust takes the last colour.
 */
export const AGE_RAMP = ['#fff3b0', '#f6b26b', '#d9663a', '#8c2d5a', '#3b1f5c'];
export const AGE_RAMP_MAX_MYR = 180;
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
export function ageColor(a) {
    const t = Math.min(1, Math.max(0, a / AGE_RAMP_MAX_MYR)) * (AGE_RAMP.length - 1), i = Math.min(AGE_RAMP.length - 2, Math.floor(t)), f = t - i;
    const p = hexRgb(AGE_RAMP[i]), q = hexRgb(AGE_RAMP[i + 1]);
    return p.map((v, k) => v + (q[k] - v) * f);
}

/**
 * RGBA overlay (row 0 = north) sampled at CELL CENTRES of a w × h equirectangular texture through
 * ageAt — the stage's overlay is cell-registered, the grid gridline-registered; sampling through
 * the interpolator keeps the half-cell straight. No oceanic crust ⇒ alpha 0.
 */
export function ageRGBA(g, w = 1800, h = 900, alpha = 230) {
    const out = new Uint8Array(4 * w * h);
    for (let r = 0; r < h; r++) {
        const lat = 90 - (r + 0.5) * 180 / h;
        for (let c = 0; c < w; c++) {
            const a = ageAt(g, lat, -180 + (c + 0.5) * 360 / w);
            if (a == null) continue;
            const col = ageColor(a), k = 4 * (r * w + c);
            out[k] = Math.round(col[0] * 255); out[k + 1] = Math.round(col[1] * 255); out[k + 2] = Math.round(col[2] * 255); out[k + 3] = alpha;
        }
    }
    return out;
}

/** Load + decode (fetch injected): data/earth-interior/seafloor-age.{json,bin.gz}. */
export async function loadSeafloorAge(fetchFn = fetch, base = 'data/earth-interior/') {
    const metaRes = await fetchFn(base + 'seafloor-age.json');
    if (!metaRes.ok) throw new Error(`seafloor-age.json: HTTP ${metaRes.status}`);
    const meta = await metaRes.json();
    const r = await fetchFn(base + meta.output.file);
    if (!r.ok) throw new Error(`${meta.output.file}: HTTP ${r.status}`);
    let bytes = new Uint8Array(await r.arrayBuffer());
    // A host that sends Content-Encoding: gzip has already decompressed it: the MAGIC decides.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    return { meta, grid: decodeSeafloorAge(meta, bytes) };
}
