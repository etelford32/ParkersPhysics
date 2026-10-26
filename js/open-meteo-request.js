/**
 * open-meteo-request.js — the ONE copy of how a multi-location Open-Meteo
 * request is chunked and spelled.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURE: no fetch, no DOM, no ambient time. Imported by the hourly cron
 * (api/cron/refresh-weather-grid.js), the forecast ring
 * (js/weather-forecast-feed.js), the pressure-level feed
 * (js/temp-volume-feed.js) and the regional patch (js/weather-patch.js).
 * `node tests/open-meteo-request.mjs` pins every rule below.
 *
 * WHY THIS FILE EXISTS (measured 2026-10-26, EARTHVIEW_LOD_UX_PLAN.md §1.1)
 * ──────────────────────────────────────────────────────────────────────────
 * Open-Meteo's front end answers HTTP 414 Request-URI Too Large to any GET
 * whose request line is over nginx's 8 KB default. Four callers each kept
 * their OWN chunk constant (864 / 864 / 864 / 640 locations) and their OWN
 * coordinate formatting (`toFixed(2)`, `toFixed(3)`), and every one of them
 * built a URL of 10.5–12.3 KB:
 *
 *   • the cron fell to the MET Norway 10° fallback on every run for at least
 *     30 days (287 of 287 cached frames; the heartbeat's
 *     last_failure_reason named the 414),
 *   • the three browser feeds failed the same way, but a 414 arrives WITHOUT
 *     CORS headers, so the browser saw a bare NetworkError — the "forecast
 *     unavailable" badge, the WIND SKILL dashes, and no regional detail.
 *
 * Three copies of 864 is how that outage happened and went unexplained. Every
 * caller now derives its chunking from here, and `chunkUrl` REFUSES to emit a
 * URL over MAX_URL_BYTES — a too-long request fails loudly in a node test,
 * never silently at nginx.
 *
 * THE RULES
 * ─────────
 *   • MAX_URL_BYTES = 7000: comfortably under nginx's 8192-byte request line
 *     (the line also carries "GET " + " HTTP/1.1"), with room for an apikey.
 *   • MAX_LOCATIONS_PER_REQUEST = 400 for the canonical 5° grid: its cell
 *     centres are exact half-degrees ("-87.5", "-177.5"), so at %g precision
 *     a location costs ≤ 14 bytes and 400 of them ≈ 5.4 KB with the query.
 *   • Grids whose cells are NOT on half-degrees (the regional patch: 0.25°
 *     steps, up to three decimals) size their chunk from the bytes their
 *     coordinates actually take — `locationsPerRequest` — never from a typed
 *     constant.
 *   • Coordinates are printed at %g precision (`formatCoord`): the shortest
 *     string that round-trips, capped at six decimals. `toFixed(2)` on an
 *     exact half-degree grid was pure padding ("12.50"); the patch's
 *     `toFixed(3)` on 0.125-multiples was also padding ("37.125" already).
 *   • Chunks partition [0, n) in order and `mergeChunks` concatenates them in
 *     order, so the merged 2592-point array is bit-for-bit the old layout —
 *     the cache rows, the CHW packer and the shaders never see a change.
 */

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_CUSTOMER_URL = 'https://customer-api.open-meteo.com/v1/forecast';

/** Hard ceiling on an emitted URL, bytes (UTF-8). See header. */
export const MAX_URL_BYTES = 7000;

/** Locations per request for grids on exact half-degrees (the 5° grid). */
export const MAX_LOCATIONS_PER_REQUEST = 400;

/**
 * Bytes reserved for everything in the URL that is not a coordinate — the
 * host, the path, the variable list, the time window and an optional apikey.
 * `locationsPerRequest` subtracts this from MAX_URL_BYTES; callers that know
 * their exact query pass its measured length instead.
 */
export const QUERY_RESERVE_BYTES = 600;

/**
 * The canonical global grid every multi-location consumer samples: 72×36
 * cells at 5°, centred half a step inside each pole. ONE record — the cron,
 * the forecast ring, the pressure-level feed and js/weather-feed.js's
 * defaults all read it.
 */
export const GRID = Object.freeze({
    w: 72,
    h: 36,
    n: 72 * 36,                 // 2592
    deg: 180 / 36,              // 5°
    latOrigin: -90 + 2.5,       // -87.5
    lonOrigin: -180 + 2.5,      // -177.5
});

/** Row-major (lat slow, lon fast) cell centre for grid index `idx`. */
export function gridLatLon(idx, grid = GRID) {
    const j = Math.floor(idx / grid.w);
    const i = idx % grid.w;
    return { lat: grid.latOrigin + j * grid.deg, lon: grid.lonOrigin + i * grid.deg };
}

/**
 * Inclusive [start, end] index ranges that partition [0, n) in order, at
 * most `max` locations each. Concatenating the chunks in array order is
 * the identity on the grid — the merge order consumers rely on.
 *
 * @param {number} n     total locations
 * @param {number} [max] locations per chunk (default MAX_LOCATIONS_PER_REQUEST)
 * @returns {{start:number, end:number}[]}
 */
export function chunkRanges(n, max = MAX_LOCATIONS_PER_REQUEST) {
    if (!Number.isInteger(n) || n < 0) throw new RangeError(`chunkRanges: n must be a non-negative integer, got ${n}`);
    if (!Number.isInteger(max) || max < 1) throw new RangeError(`chunkRanges: max must be a positive integer, got ${max}`);
    const out = [];
    for (let start = 0; start < n; start += max) {
        out.push({ start, end: Math.min(start + max - 1, n - 1) });
    }
    return out;
}

/**
 * %g-style coordinate: the shortest decimal that round-trips, capped at six
 * decimals (~0.1 m — Open-Meteo's own resolution is ~11 km). Folds −0 to 0.
 * @param {number} v
 */
export function formatCoord(v) {
    if (!Number.isFinite(v)) throw new RangeError(`formatCoord: non-finite coordinate ${v}`);
    const r = Math.round(v * 1e6) / 1e6;
    return String(r === 0 ? 0 : r);
}

/**
 * UTF-8 byte length of a string (what the request line is measured in).
 * @param {string} s
 */
export function byteLength(s) {
    return new TextEncoder().encode(s).length;
}

/**
 * How many locations fit in one request given the bytes ONE location costs
 * in the URL (its lat + lon strings, the two commas) and the bytes the rest
 * of the query takes. Never more than MAX_LOCATIONS_PER_REQUEST; at least 1.
 *
 * @param {object} o
 * @param {number} o.coordBytes   worst-case bytes for one location's lat + lon
 *                                strings INCLUDING their two separators
 * @param {number} [o.queryBytes] bytes of the non-coordinate part of the URL
 *                                (default QUERY_RESERVE_BYTES)
 */
export function locationsPerRequest({ coordBytes, queryBytes = QUERY_RESERVE_BYTES } = {}) {
    if (!Number.isFinite(coordBytes) || coordBytes <= 0) {
        throw new RangeError(`locationsPerRequest: coordBytes must be positive, got ${coordBytes}`);
    }
    const fit = Math.floor((MAX_URL_BYTES - queryBytes) / coordBytes);
    return Math.max(1, Math.min(MAX_LOCATIONS_PER_REQUEST, fit));
}

/**
 * Worst-case bytes one location costs across a list of coordinate strings:
 * the longest lat + the longest lon + two commas.
 * @param {string[]} lats
 * @param {string[]} lons
 */
export function maxCoordBytes(lats, lons) {
    let a = 0, b = 0;
    for (const s of lats) a = Math.max(a, byteLength(s));
    for (const s of lons) b = Math.max(b, byteLength(s));
    return a + b + 2;
}

/**
 * Coordinate strings for grid indices [start, end] inclusive, row-major.
 * @returns {{ lats: string[], lons: string[] }}
 */
export function gridChunkCoords(start, end, grid = GRID) {
    const lats = [], lons = [];
    for (let idx = start; idx <= end; idx++) {
        const { lat, lon } = gridLatLon(idx, grid);
        lats.push(formatCoord(lat));
        lons.push(formatCoord(lon));
    }
    return { lats, lons };
}

/**
 * Build one multi-location URL and REFUSE to emit it over MAX_URL_BYTES.
 *
 *   `${base}?latitude=${lats}&longitude=${lons}&${query}`
 *
 * `query` is the caller's already-encoded parameter string (variable list,
 * units, time window, model, apikey) in the order the caller wants it —
 * this module adds nothing to it, so each route's URL shape stays its own.
 *
 * @param {object} o
 * @param {string}   [o.base]  endpoint (default the free forecast host)
 * @param {string[]} o.lats    coordinate strings (see formatCoord)
 * @param {string[]} o.lons
 * @param {string}   o.query   e.g. 'current=temperature_2m&timezone=UTC'
 * @returns {string}
 * @throws {RangeError} when the URL would exceed MAX_URL_BYTES, or lats/lons
 *                      differ in length, or either is empty
 */
export function chunkUrl({ base = OPEN_METEO_FORECAST_URL, lats, lons, query = '' } = {}) {
    if (!Array.isArray(lats) || !Array.isArray(lons) || lats.length === 0 || lats.length !== lons.length) {
        throw new RangeError(`chunkUrl: lats (${lats?.length}) and lons (${lons?.length}) must be equal-length, non-empty`);
    }
    const url = `${base}?latitude=${lats.join(',')}&longitude=${lons.join(',')}` + (query ? `&${query}` : '');
    const bytes = byteLength(url);
    if (bytes > MAX_URL_BYTES) {
        throw new RangeError(
            `chunkUrl: ${bytes} B for ${lats.length} locations exceeds MAX_URL_BYTES=${MAX_URL_BYTES} `
            + '(Open-Meteo answers 414 Request-URI Too Large past ~8 KB — chunk smaller)');
    }
    return url;
}

/**
 * Concatenate per-chunk arrays in chunk order into one array of exactly `n`
 * items. Throws on a hole or a length mismatch so a half-failed fan-out can
 * never be written to the cache as a whole frame.
 *
 * @param {Array<Array<any>|null>} chunks  one array per chunk, chunk order
 * @param {number} n                        expected merged length
 */
export function mergeChunks(chunks, n) {
    const merged = [];
    for (let k = 0; k < chunks.length; k++) {
        const items = chunks[k];
        if (!Array.isArray(items)) throw new Error(`mergeChunks: chunk ${k} is not an array`);
        for (const it of items) merged.push(it);
    }
    if (merged.length !== n) throw new Error(`mergeChunks: merged length ${merged.length} != ${n}`);
    return merged;
}

export default chunkUrl;
