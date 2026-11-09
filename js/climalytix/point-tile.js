/**
 * point-tile.js — read one site out of the Climalytix point-tile archive.
 *
 * PURE (no fetch, no DOM). CLIMALYTIX_PLAN.md §17. The WRITER is
 * scripts/climalytix_ingest/tiles.py; its header is the format's normative
 * description and this file mirrors it. tests/climalytix-point-tile.mjs reads
 * the tile fixture tiles.py wrote from a real GFS message
 * (tests/fixtures/climalytix/tile/) and must reproduce the values Python
 * computed — the two languages are pinned to the same bytes.
 *
 * THE LAYOUT, from the manifest: canonical rows run NORTH → SOUTH from lat0,
 * columns EAST from lon0 (degrees, wrapping at 360); tiles are N×N cells plus
 * a one-cell halo, little-endian int16, cell-major with the time series
 * innermost:
 *     byte(lr, lc, k, t) = 2 · (((lr · cols + lc) · nVar + k) · nTime + t)
 * so the 2×2 bilinear stencil is TWO contiguous byte ranges (rows lr and
 * lr + 1, two cells each) inside ONE tile — including at the grid's seam,
 * which the halo wraps. NODATA (−32768) is a gap; a stencil with any gap
 * corner reads null (a gap is never averaged away, CLIMALYTIX §15 rules).
 *
 * Bilinear between grid nodes is a stated interpolation, not downscaling;
 * the plan's M1 physical downscaling replaces it (§18).
 */

import { makeSeries, HOUR_MS } from './series.js';

export const SCHEMA = 'climalytix.point-tiles.v1';

/** Where (lat, lon) falls: the stencil's corner cell, weights and tile. */
export function locate(man, lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90) {
        throw new RangeError(`bad site ${lat},${lon}`);
    }
    const lon360 = ((lon % 360) + 360) % 360;
    const y = (man.lat0 - lat) / man.dlat;
    const xRaw = ((((lon360 - man.lon0) % 360) + 360) % 360) / man.dlon;
    const r = Math.min(Math.max(Math.floor(y), 0), man.nj - 2);
    const cFloor = Math.floor(xRaw);
    const c = ((cFloor % man.ni) + man.ni) % man.ni;
    const n = man.tileN;
    const tr = Math.floor(r / n), tc = Math.floor(c / n);
    return {
        r, c, fy: y - r, fx: xRaw - cFloor, tr, tc, lr: r - tr * n, lc: c - tc * n,
        nodeLat: man.lat0 - r * man.dlat, nodeLon: (man.lon0 + c * man.dlon) % 360,   // the stencil's NW node
    };
}

/** Rows and columns stored in tile (tr, tc) — halo included. */
export function tileShape(man, tr) {
    const n = man.tileN;
    const r0 = tr * n;
    return { rows: Math.min(r0 + n, man.nj - 1) - r0 + 1, cols: n + 1 };
}

export function tileKey(man, tr, tc) {
    const p = (v) => String(v).padStart(2, '0');
    return `${man.prefix}/t/r${p(tr)}-c${p(tc)}.i16`;
}

/** The two byte ranges [start, endExclusive] the stencil needs. */
export function stencilRanges(man, loc) {
    const { cols } = tileShape(man, loc.tr);
    const cell = 2 * man.vars.length * man.times.length;
    const at = (lr) => (lr * cols + loc.lc) * cell;
    return [[at(loc.lr), at(loc.lr) + 2 * cell], [at(loc.lr + 1), at(loc.lr + 1) + 2 * cell]];
}

function view(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

/**
 * Bilinear values from the two range bodies. Returns {varId: Array<number|null>}
 * over the manifest's times, in the STORED unit.
 */
export function readStencil(man, loc, topBytes, bottomBytes) {
    const nv = man.vars.length, nt = man.times.length;
    const need = 2 * 2 * nv * nt;
    const top = view(topBytes), bot = view(bottomBytes);
    if (top.byteLength !== need || bot.byteLength !== need) {
        throw new RangeError(`stencil body is ${top.byteLength}/${bot.byteLength} bytes, expected ${need}`);
    }
    const nodata = man.nodata;
    const raw = (dv, cell, k, t) => dv.getInt16(2 * ((cell * nv + k) * nt + t), true);
    const { fx, fy } = loc;
    const out = {};
    man.vars.forEach((v, k) => {
        const arr = new Array(nt);
        for (let t = 0; t < nt; t++) {
            const q = [raw(top, 0, k, t), raw(top, 1, k, t), raw(bot, 0, k, t), raw(bot, 1, k, t)];
            if (q.includes(nodata)) { arr[t] = null; continue; }
            const [a, b, d, e] = q.map((x) => x * v.scale + v.offset);
            arr[t] = (1 - fy) * ((1 - fx) * a + fx * b) + fy * ((1 - fx) * d + fx * e);
        }
        out[v.id] = arr;
    });
    return out;
}

/** Age-based freshness of a run, for the route and the registry. */
export const RUN_FRESH_S = 30 * 3600;
export const RUN_STALE_S = 54 * 3600;
export function runFreshness(runMs, nowMs) {
    const age = Math.max(0, Math.round((nowMs - runMs) / 1000));
    return { age_seconds: age, freshness: age <= RUN_FRESH_S ? 'fresh' : age <= RUN_STALE_S ? 'stale' : 'expired' };
}

/**
 * The route's wire body for one site. Derived variables are computed HERE,
 * once: wind speed from the interpolated u/v (interpolating speed directly
 * would overstate it where the direction turns between nodes); precipitation
 * keeps its interval and is stamped at the interval START by the adapter.
 */
export function siteBody(man, loc, values, { lat, lon, nowMs }) {
    const series = { ...values };
    if (values.uMs && values.vMs) {
        series.windMs = values.uMs.map((u, i) => {
            const v = values.vMs[i];
            return u == null || v == null ? null : Math.hypot(u, v);
        });
        series.windDirDeg = values.uMs.map((u, i) => {
            const v = values.vMs[i];
            if (u == null || v == null || (u === 0 && v === 0)) return null;
            return (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;   // meteorological: FROM
        });
    }
    const round = (x, d) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
    for (const k of Object.keys(series)) series[k] = series[k].map((x) => round(x, 3));
    return {
        source: `climalytix-${man.source}`, role: 'archive', schema: man.schema,
        run: man.run, runMs: man.runMs, grid: man.grid,
        ...runFreshness(man.runMs, nowMs),
        // The four grid nodes the value was interpolated from (box edges).
        site: { lat, lon, interpolation: 'bilinear', stencil: {
            north: loc.nodeLat, south: Math.round((loc.nodeLat - man.dlat) * 1e6) / 1e6,
            west: wrap180(loc.nodeLon), east: wrap180(loc.nodeLon + man.dlon) } },
        times: man.times, leadsH: man.leadsH, intervalH: man.intervalH || {},
        units: Object.fromEntries(man.vars.map((v) => [v.id, v.unit]).concat(
            series.windMs ? [['windMs', 'm/s'], ['windDirDeg', 'deg']] : [])),
        series,
        missing: (man.missing || []).length,
        notes: man.notes || [],
    };
}

const wrap180 = (x) => { const v = ((x % 360) + 360) % 360; return Math.round((v > 180 ? v - 360 : v) * 1e6) / 1e6 + 0; };

/**
 * Wire body → SiteSeries[] (only the specs asked for, in that order).
 * `issuedAt` is the RUN time; `fetchedAt` is when the browser got it (they
 * differ by the ingest lag plus the CDN age). `freshness` defaults to the
 * route's own word; the catalog maps it onto the page's vocabulary.
 */
export function toSiteSeries(body, specs, { fetchedAt = body?.runMs, freshness = body?.freshness, spatial = null } = {}) {
    const out = [];
    for (const spec of specs) {
        const v = body?.series?.[spec.key];
        if (!Array.isArray(v)) continue;
        const intervalH = body.intervalH?.[spec.key];
        const shift = intervalH ? intervalH * HOUR_MS : 0;
        out.push(makeSeries({
            id: spec.id, variable: spec.key, label: spec.label, quantity: spec.quantity,
            kind: 'forecast', agg: spec.agg,
            cadenceMs: intervalH ? intervalH * HOUR_MS : 3 * HOUR_MS,
            t: body.times.map((t) => t - shift), v,
            issuedAt: body.runMs,
            provenance: { source: body.source, version: body.run, fetchedAt, freshness,
                          note: `${body.grid} GFS run ${body.run}, bilinear to the site from four grid nodes` },
            spatial,
        }));
    }
    return out;
}

/** Validate ?lat&lon for the route; rounds to 0.01° so nearby visitors share
 *  one CDN cache key (≈1 km — a tenth of a 0.25° cell). */
export function parseSite({ lat, lon }) {
    const toNum = (x) => (x == null || String(x).trim() === '' ? NaN : Number(x));
    const la = toNum(lat), lo = toNum(lon);
    if (!Number.isFinite(la) || la < -90 || la > 90) return { error: 'lat must be a number in [-90, 90]' };
    if (!Number.isFinite(lo) || lo < -180 || lo > 180) return { error: 'lon must be a number in [-180, 180]' };
    const r = (x) => Math.round(x * 100) / 100 + 0;
    return { lat: r(la), lon: r(lo) };
}

/** The ONE path builder for /api/climalytix/nwp: the same 0.01° rounding as
 *  parseSite, so the page and the route share one CDN cache key. */
export function nwpPath({ lat, lon, grid = '0p25' }) {
    const q = parseSite({ lat, lon });
    if (q.error) throw new RangeError(q.error);
    return `/api/climalytix/nwp?lat=${q.lat.toFixed(2)}&lon=${q.lon.toFixed(2)}${grid === '0p25' ? '' : `&grid=${grid}`}`;
}

/** The route's degraded answer (200 + expired + reasons, series null). One
 *  copy, so the browser mocks and the route cannot disagree on its shape. */
export function degradedNwp(site, grid, reason, nowMs) {
    return {
        source: 'climalytix-gfs', role: 'archive', grid, freshness: 'expired', reasons: [reason],
        generated_at: new Date(nowMs).toISOString(), site, series: null,
        note: 'Our own GFS archive is unavailable for this request; nothing is substituted.',
    };
}

// ── Area reads: the heat-map field around a site ───────────────────────────
//
// The same tiles, read for a WINDOW of grid nodes instead of a 2×2 stencil.
// A window row inside one tile is ONE contiguous byte range (cells of a row
// are adjacent, each cell carrying every var and time), so a field costs one
// range per (row, tile) segment. Columns run in UNWRAPPED order from the
// window's west edge — continuous with the site's longitude — and map to
// canonical columns modulo ni, so a window across the grid's seam (Greenwich,
// for a 0..360 grid) splits into two segments and draws as one field.

export const FIELD_HALF_DEG_DEFAULT = 3;
/** Variables a field request may ask for (the map's layers). The bytes of
 *  every variable come back in each range anyway (a cell holds all of them),
 *  so a second variable costs wire size, never another R2 read. */
export const FIELD_VARS = Object.freeze(['tempC', 'uMs', 'vMs', 'cloudPct', 'rhPct', 'precipMm']);

/** `vars` query value → a validated, de-duplicated list (default tempC), or { error }. */
export function parseFieldVars(raw) {
    if (raw == null || raw === '') return ['tempC'];
    const list = [...new Set(String(raw).split(',').map((x) => x.trim()).filter(Boolean))];
    const bad = list.filter((x) => !FIELD_VARS.includes(x));
    if (!list.length || bad.length) return { error: `vars must be from ${FIELD_VARS.join(', ')}` };
    return list;
}
export const FIELD_HALF_DEG_MAX = 4;
const FIELD_SNAP_DEG = 0.25;

/** The ONE path builder for /api/climalytix/nwp-field. The centre snaps to
 *  0.25° so everyone looking at the same place shares one CDN key. */
export function fieldPath({ lat, lon, halfDeg = FIELD_HALF_DEG_DEFAULT, grid = '0p25', vars = null }) {
    const q = parseSite({ lat, lon });
    if (q.error) throw new RangeError(q.error);
    const snap = (x) => Math.round(x / FIELD_SNAP_DEG) * FIELD_SNAP_DEG + 0;
    const h = Math.min(FIELD_HALF_DEG_MAX, Math.max(1, Number(halfDeg) || FIELD_HALF_DEG_DEFAULT));
    const v = vars == null ? null : parseFieldVars(Array.isArray(vars) ? vars.join(',') : vars);
    if (v?.error) throw new RangeError(v.error);
    return `/api/climalytix/nwp-field?lat=${snap(q.lat).toFixed(2)}&lon=${snap(q.lon).toFixed(2)}&half=${h}`
        + (grid === '0p25' ? '' : `&grid=${grid}`)
        + (v && !(v.length === 1 && v[0] === 'tempC') ? `&vars=${v.join(',')}` : '');
}

/**
 * Which nodes and byte ranges a window needs.
 * Returns { rows: [r…], cols: [canonical c…], latN, lonW, nRows, nCols,
 *           segments: [{ tr, tc, key, range: [start, end), outRow, outCol0, n }] }
 */
export function fieldPlan(man, { lat, lon, halfDeg = FIELD_HALF_DEG_DEFAULT }) {
    const h = Math.min(FIELD_HALF_DEG_MAX, Math.max(0.25, halfDeg));
    const rTop = Math.max(0, Math.ceil((man.lat0 - (lat + h)) / man.dlat - 1e-9));
    const rBot = Math.min(man.nj - 1, Math.floor((man.lat0 - (lat - h)) / man.dlat + 1e-9));
    const lonRel = (x) => x - man.lon0;                       // unwrapped, may be negative
    const cW = Math.ceil(lonRel(lon - h) / man.dlon - 1e-9);
    const cE = Math.floor(lonRel(lon + h) / man.dlon + 1e-9);
    const rows = []; for (let r = rTop; r <= rBot; r++) rows.push(r);
    const unwrapped = []; for (let c = cW; c <= cE; c++) unwrapped.push(c);
    const cols = unwrapped.map((c) => ((c % man.ni) + man.ni) % man.ni);
    if (cols.length > man.ni) throw new RangeError('window wider than the grid');
    const n = man.tileN;
    const cell = 2 * man.vars.length * man.times.length;
    const segments = [];
    rows.forEach((r, i) => {
        const tr = Math.min(Math.floor(r / n), man.tileRows - 1);
        const lr = r - tr * n;
        const { cols: tileCols } = tileShape(man, tr);
        let j = 0;
        while (j < cols.length) {
            const tc = Math.floor(cols[j] / n);
            let k = j;
            while (k + 1 < cols.length && cols[k + 1] === cols[k] + 1 && Math.floor(cols[k + 1] / n) === tc) k++;
            const lc0 = cols[j] - tc * n;
            const start = (lr * tileCols + lc0) * cell;
            segments.push({ tr, tc, key: tileKey(man, tr, tc), range: [start, start + (k - j + 1) * cell],
                            outRow: i, outCol0: j, n: k - j + 1 });
            j = k + 1;
        }
    });
    return {
        rows, cols, nRows: rows.length, nCols: cols.length, segments,
        latN: man.lat0 - rTop * man.dlat,
        lonW: lonWrapNear(man.lon0 + cW * man.dlon, lon),
    };
}

/** A longitude expressed in the turn nearest `ref` (continuous with the site). */
function lonWrapNear(x, ref) {
    let v = x;
    while (v - ref > 180) v -= 360;
    while (v - ref < -180) v += 360;
    return Math.round(v * 1e6) / 1e6 + 0;
}

/**
 * One variable's field from the segment bodies (same order as plan.segments).
 * Returns Float32Array laid out [time][row][col], NaN for gaps.
 */
export function readField(man, plan, varId, bodies) {
    const k = man.vars.findIndex((v) => v.id === varId);
    if (k < 0) throw new RangeError(`no variable ${varId} in this run`);
    const { scale, offset } = man.vars[k];
    const nv = man.vars.length, nt = man.times.length;
    const plane = plan.nRows * plan.nCols;
    const out = new Float32Array(nt * plane).fill(NaN);
    plan.segments.forEach((seg, s) => {
        const dv = view(bodies[s]);
        if (dv.byteLength !== seg.range[1] - seg.range[0]) {
            throw new RangeError(`segment ${s} is ${dv.byteLength} bytes, expected ${seg.range[1] - seg.range[0]}`);
        }
        for (let c = 0; c < seg.n; c++) {
            const base = seg.outRow * plan.nCols + seg.outCol0 + c;
            for (let t = 0; t < nt; t++) {
                const q = dv.getInt16(2 * ((c * nv + k) * nt + t), true);
                out[t * plane + base] = q === man.nodata ? NaN : q * scale + offset;
            }
        }
    });
    return out;
}

/**
 * The field route's wire body. Values are rounded to 0.1 and gaps are null.
 * `values` is the FIRST variable (the original single-variable contract);
 * `extra` ({ id: Float32Array }) adds a `fields` map holding every requested
 * variable, the first included, and a `vars` list.
 */
export function fieldBody(man, plan, varId, values, { nowMs, site, extra = null }) {
    const v = man.vars.find((x) => x.id === varId);
    const wire = (arr) => Array.from(arr, (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null));
    const first = wire(values);
    const fields = extra ? { [varId]: first, ...Object.fromEntries(Object.entries(extra).map(([k, a]) => [k, wire(a)])) } : null;
    return {
        ...(fields ? { vars: Object.keys(fields), fields } : {}),
        source: `climalytix-${man.source}`, role: 'archive', schema: man.schema,
        run: man.run, runMs: man.runMs, grid: man.grid, ...runFreshness(man.runMs, nowMs),
        site, var: varId, unit: v?.unit ?? null,
        latN: plan.latN, lonW: plan.lonW, dlat: man.dlat, dlon: man.dlon,
        nRows: plan.nRows, nCols: plan.nCols, times: man.times, leadsH: man.leadsH,
        layout: 'time,row,col',
        values: first,
        note: 'Grid-node values of one GFS run; the map smooths between nodes for display only.',
    };
}
