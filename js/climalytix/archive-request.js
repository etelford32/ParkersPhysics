/**
 * climalytix/archive-request.js — the PURE half of /api/climalytix/archive.
 * ═══════════════════════════════════════════════════════════════════════════
 * Shared by the edge route (api/climalytix/archive.js) and the browser loader
 * (js/climalytix/loaders.js), so the URL the browser asks for and the URL the
 * route builds upstream agree on ONE snapped site and ONE cache key. It lives
 * in js/, not api/_lib/, because api/ is not served statically — a browser
 * import of it 404s and takes the page module down (the hek-filaments scar).
 *
 * WHAT THIS IS: daily ERA5 / ERA5-Land reanalysis for one point since 1940,
 * via Open-Meteo's historical API. It is the BOOTSTRAP source of
 * CLIMALYTIX_PLAN.md §5 — Open-Meteo's free tier is non-commercial, so this
 * route is never a paid path; the §17 data engine (GitHub Actions ingest →
 * R2 point tiles) replaces it, and the response says which it is.
 *
 * Node-gated by tests/climalytix-archive.mjs.
 */

export const OPEN_METEO_ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

/** ERA5 starts in 1940; the default start is the WMO normals period. */
export const ARCHIVE_MIN_YEAR = 1940;
export const ARCHIVE_DEFAULT_YEAR = 1991;

/**
 * Days the reanalysis lags real time. ERA5T publishes ~5 days behind; asking
 * past it returns nulls, which would read as a run of missing days.
 */
export const ARCHIVE_LAG_DAYS = 5;

/**
 * Snap grid. 0.05° (~5 km) is inside the reanalysis cell (ERA5-Land ~9 km,
 * ERA5 ~25 km), so snapping changes nothing physical while every visitor
 * within a cell shares one edge-cache entry (plan §4.2).
 */
export const SNAP_DEG = 0.05;

/** Route variable key → Open-Meteo daily variable. Units are pinned SI below. */
export const ARCHIVE_VARIABLES = Object.freeze({
    tmax:    'temperature_2m_max',
    tmin:    'temperature_2m_min',
    tmean:   'temperature_2m_mean',
    precip:  'precipitation_sum',
    windmax: 'wind_speed_10m_max',
    gustmax: 'wind_gusts_10m_max',
    et0:     'et0_fao_evapotranspiration',
});

const DAY_MS = 86_400_000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Snap a coordinate to the SNAP_DEG grid (fixed decimals, no −0). */
export function snapCoord(x) {
    const s = Math.round(x / SNAP_DEG) * SNAP_DEG;
    const out = +s.toFixed(2);
    return out === 0 ? 0 : out;
}

/**
 * Validate + snap a request. Returns { lat, lon, fromYear } or { error }.
 * `fromYear` defaults to 1991 and is clamped to [1940, nowYear − 1].
 */
export function parseArchiveQuery({ lat, lon, from } = {}, nowMs = Date.now()) {
    // A missing parameter must not become 0 (Number(null) and Number('') are
    // both 0 — that is the equator / the prime meridian, a plausible site).
    const toNum = (x) => (x == null || String(x).trim() === '' ? NaN : Number(x));
    const la = toNum(lat), lo = toNum(lon);
    if (!(isNum(la) && la >= -90 && la <= 90)) return { error: 'lat must be a number in [-90, 90]' };
    if (!(isNum(lo) && lo >= -180 && lo <= 180)) return { error: 'lon must be a number in [-180, 180]' };
    const nowYear = new Date(nowMs).getUTCFullYear();
    let y = Number.parseInt(from, 10);
    if (!Number.isInteger(y)) y = ARCHIVE_DEFAULT_YEAR;
    y = Math.min(nowYear - 1, Math.max(ARCHIVE_MIN_YEAR, y));
    return { lat: snapCoord(la), lon: snapCoord(lo), fromYear: y };
}

/** The same-origin path a client asks for (one canonical cache key). */
export function archivePath({ lat, lon, fromYear }) {
    return `/api/climalytix/archive?lat=${snapCoord(lat).toFixed(2)}&lon=${snapCoord(lon).toFixed(2)}&from=${fromYear}`;
}

/** The upstream URL. End date = today − ARCHIVE_LAG_DAYS (UTC). */
export function buildArchiveUrl({ lat, lon, fromYear }, nowMs = Date.now()) {
    const end = new Date(nowMs - ARCHIVE_LAG_DAYS * DAY_MS).toISOString().slice(0, 10);
    const p = new URLSearchParams({
        latitude: lat.toFixed(2),
        longitude: lon.toFixed(2),
        start_date: `${fromYear}-01-01`,
        end_date: end,
        daily: Object.values(ARCHIVE_VARIABLES).join(','),
        temperature_unit: 'celsius',
        wind_speed_unit: 'ms',
        precipitation_unit: 'mm',
        timezone: 'auto',
        timeformat: 'unixtime',
    });
    return `${OPEN_METEO_ARCHIVE_URL}?${p}`;
}

/** Great-circle distance, km (requested site → the grid point answered). */
export function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371.0088;
    const r = Math.PI / 180;
    const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Upstream JSON → the route's body. Daily instants become epoch ms of the
 * site's LOCAL midnight; every value is a finite number or null — never 0 for
 * a gap. Returns null when the upstream had no daily rows (degraded).
 */
export function normalizeArchive(up, req, fetchedAtMs) {
    const D = up?.daily;
    if (!D || !Array.isArray(D.time) || !D.time.length) return null;
    const t = D.time.map((s) => (isNum(s) ? s * 1000 : null));
    const daily = { t };
    let finite = 0, cells = 0;
    for (const [key, src] of Object.entries(ARCHIVE_VARIABLES)) {
        const arr = Array.isArray(D[src]) ? D[src] : [];
        daily[key] = t.map((_, i) => {
            const v = isNum(arr[i]) ? arr[i] : null;
            cells++; if (v != null) finite++;
            return v;
        });
    }
    const gLat = isNum(up.latitude) ? up.latitude : null;
    const gLon = isNum(up.longitude) ? up.longitude : null;
    return {
        source: 'Open-Meteo historical API (ERA5 / ERA5-Land best match)',
        role: 'bootstrap',
        note: 'Reanalysis, not a station record: a ~9–25 km grid cell. Bootstrap source until the Climalytix data engine serves this site.',
        site: {
            lat: req.lat, lon: req.lon,
            grid_lat: gLat, grid_lon: gLon,
            distance_km: gLat != null && gLon != null ? +haversineKm(req.lat, req.lon, gLat, gLon).toFixed(2) : null,
            elevation_m: isNum(up.elevation) ? up.elevation : null,
            timezone: typeof up.timezone === 'string' ? up.timezone : null,
            utc_offset_seconds: isNum(up.utc_offset_seconds) ? up.utc_offset_seconds : 0,
        },
        from_year: req.fromYear,
        days: t.length,
        coverage: cells ? +(finite / cells).toFixed(4) : 0,
        units: { tmax: '°C', tmin: '°C', tmean: '°C', precip: 'mm', windmax: 'm/s', gustmax: 'm/s', et0: 'mm' },
        fetched_at: new Date(fetchedAtMs).toISOString(),
        freshness: 'live',
        daily,
    };
}

/** The degraded body: 200 + freshness:'expired', never a 5xx (CLAUDE.md §8). */
export function degradedArchive(req, reason, fetchedAtMs) {
    return {
        source: 'Open-Meteo historical API (ERA5 / ERA5-Land best match)',
        role: 'bootstrap',
        site: req ? { lat: req.lat, lon: req.lon } : null,
        from_year: req?.fromYear ?? null,
        fetched_at: new Date(fetchedAtMs).toISOString(),
        freshness: 'expired',
        reasons: [reason],
        daily: null,
    };
}
