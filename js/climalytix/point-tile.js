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
