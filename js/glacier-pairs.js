/**
 * glacier-pairs.js — how Glacier Watch names, finds and samples NASA ITS_LIVE image pairs.
 *
 * PURE (no fetch, no DOM, no ambient time). The ONE JS copy of the rules
 * scripts/build-glacier-velocity.py applies at bake time, so a pair the daily
 * route picks up (api/glaciers/velocity.js) is the same measurement the bake
 * would have made and the two join into one series:
 *
 *   - a granule name is `<image 1 id>_X_<image 2 id>_G0120V02_P<valid %>.nc`;
 *     Landsat ids carry the acquisition date in field 4 (`LC09_L1TP_067017_20260107_…`),
 *     Sentinel-1/2 ids carry it as the first `_YYYYMMDDThhmmss` stamp;
 *   - a scene is a Landsat WRS-2 path/row (`L067017`), a Sentinel-2 MGRS tile
 *     (`T06VWP`), or a Sentinel-1 folder whose pairs are footprint-tested;
 *   - only SHORT-BASELINE pairs count (1 ≤ Δt ≤ DT_MAX_DAYS): a 400-day pair is
 *     not a daily measurement;
 *   - a flowline point's value is the 3×3 MEDIAN of the pair's `v` with the fill
 *     (−32767) ignored, and only when ≥ 5 of the 9 pixels are valid.
 *
 * Change a rule here and in the Python baker together — tests/glacier-pairs.mjs
 * pins this side; the baked fixture in that test pins the join.
 */

export const DT_MAX_DAYS = 64;
export const FILL = -32767;
export const MIN_VALID_3X3 = 5;
export const BUCKET = 'https://its-live-data.s3.amazonaws.com';

const NAME_RE = /^(.+?)_X_(.+?)_G0120V02_P(\d{3})(?:\.nc)?$/;

function idDate(id) {
    let s;
    if (id.startsWith('L')) s = id.split('_')[3];
    else { const m = /_(\d{8})T\d{6}/.exec(id); s = m && m[1]; }
    if (!s || !/^\d{8}$/.test(s)) return null;
    return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
}

/** { d1, d2 (ms UTC, midnight), dtDays, validPct, sensor } | null */
export function parsePairName(name) {
    const base = name.split('/').pop();
    const m = NAME_RE.exec(base);
    if (!m) return null;
    const d1 = idDate(m[1]), d2 = idDate(m[2]);
    if (d1 == null || d2 == null) return null;
    const sensor = base.startsWith('L') ? 'landsatOLI' : base.startsWith('S2') ? 'sentinel2'
        : base.startsWith('S1') ? 'sentinel1' : null;
    return { id: base.replace(/\.nc$/, ''), d1, d2, dtDays: Math.round((d2 - d1) / 864e5), validPct: +m[3], sensor };
}

export function isShortBaseline(p) {
    return !!p && p.dtDays >= 1 && p.dtDays <= DT_MAX_DAYS && p.validPct >= 1;
}

/** 'YYYYMM' for every month touching [t0, t1]. */
export function monthStamps(t0, t1) {
    const out = [];
    const a = new Date(t0), b = new Date(t1);
    let y = a.getUTCFullYear(), mo = a.getUTCMonth();
    while (y < b.getUTCFullYear() || (y === b.getUTCFullYear() && mo <= b.getUTCMonth())) {
        out.push(`${y}${String(mo + 1).padStart(2, '0')}`);
        if (++mo === 12) { mo = 0; y++; }
    }
    return out;
}

/**
 * S3 key prefixes to list for one scene over the months whose IMAGE-1 dates can
 * still produce a pair ending at or after `sinceMs` (image 1 is up to DT_MAX_DAYS earlier).
 */
export function scenePrefixes(scene, sinceMs, nowMs) {
    const months = monthStamps(sinceMs - DT_MAX_DAYS * 864e5, nowMs);
    const base = `velocity_image_pair/${scene.sensor}/v02/${scene.folder}/`;
    const out = [];
    if (scene.sensor === 'landsatOLI') {
        const pr = String(scene.key).slice(1);
        for (const sat of ['LC08', 'LC09']) for (const lvl of ['L1TP', 'L1GT']) for (const ym of months) out.push(`${base}${sat}_${lvl}_${pr}_${ym}`);
    } else if (scene.sensor === 'sentinel2') {
        for (const sat of ['S2A', 'S2B', 'S2C']) for (const ym of months) out.push(`${base}${sat}_MSIL1C_${ym}`);
    } else if (scene.sensor === 'sentinel1') {
        for (const pol of ['1SDH', '1SDV']) for (const sat of ['S1A', 'S1B', 'S1C']) for (const ym of months) out.push(`${base}${sat}_IW_SLC__${pol}_${ym}`);
    }
    return out;
}

/** Does a listed key belong to the scene (S2 keys are listed per folder and filtered by tile)? */
export function keyMatchesScene(key, scene) {
    if (!key.endsWith('.nc')) return false;
    if (scene.sensor === 'sentinel2') return key.includes(`_${scene.key}_`);
    return true;
}

/** Point-in-polygon on a granule's `.spatial` sidecar (whitespace-separated lon lat pairs). */
export function footprintContains(spatialText, lon, lat) {
    const n = String(spatialText).trim().split(/\s+/).map(Number);
    const poly = [];
    for (let i = 0; i + 1 < n.length; i += 2) poly.push([n[i], n[i + 1]]);
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [x1, y1] = poly[i], [x2, y2] = poly[j];
        if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) c = !c;
    }
    return c;
}

function median(a) {
    const s = a.slice().sort((p, q) => p - q), n = s.length;
    return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

/**
 * Sample a pair's grid at map points.
 * @param {object} g  { data: Int16Array|number[] (row-major ny×nx), nx, ny, x0, y0, dx, dy }
 *                    x0/y0 = centre of pixel (0,0); dy is negative for north-up grids
 * @param {number[]} xs, ys  map coordinates in the granule's EPSG
 * @returns {Float64Array} NaN where outside or < MIN_VALID_3X3 valid pixels
 */
export function sampleGrid(g, xs, ys) {
    const out = new Float64Array(xs.length).fill(NaN);
    for (let k = 0; k < xs.length; k++) {
        const j = Math.round((xs[k] - g.x0) / g.dx), i = Math.round((ys[k] - g.y0) / g.dy);
        if (i < 1 || j < 1 || i >= g.ny - 1 || j >= g.nx - 1) continue;
        const vals = [];
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
            const v = g.data[(i + di) * g.nx + (j + dj)];
            if (v !== FILL && Number.isFinite(v)) vals.push(v);
        }
        if (vals.length >= MIN_VALID_3X3) out[k] = median(vals);
    }
    return out;
}

/** Coverage rule shared with the bake: a pair is kept when ≥ max(3, 10 %) of points are valid. */
export function pairHasCoverage(values) {
    let n = 0;
    for (const v of values) if (Number.isFinite(v)) n++;
    return n >= Math.max(3, 0.1 * values.length);
}

/** base64 little-endian int16 (−32768 = no data) — the bake's encoding. */
export function encodeI16(values) {
    const a = new Int16Array(values.length);
    for (let k = 0; k < values.length; k++) {
        const v = values[k];
        a[k] = Number.isFinite(v) ? Math.max(-32767, Math.min(32767, Math.round(v))) : -32768;
    }
    const bytes = new Uint8Array(a.buffer);
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}
