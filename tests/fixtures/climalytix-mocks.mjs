/**
 * climalytix-mocks.mjs — Playwright route mocks for climalytix.html.
 *
 * Every feed is served from closed-form fixtures around the page's own clock;
 * every third-party host is fulfilled or aborted (CI has no outbound network,
 * and a hanging feed makes a gate time-dependent).
 *
 *   · the Home Station feed reuses the Climate Lab's OWN fixture (labFixture),
 *     because Climalytix reads that route through the lab's own fetch
 *   · the archive body is built by the REAL route normaliser
 *     (js/climalytix/archive-request.js normalizeArchive) from a synthetic
 *     upstream, so the mock cannot drift from the route's contract
 *   · our GFS archive's body is built by the REAL point-tile.js siteBody /
 *     degradedNwp from a synthetic manifest (the route's own two functions),
 *     and the heat FIELD by the route's own fieldPlan + fieldBody
 *   · NASA GIBS tiles are real 512×512 PNGs (a flat colour per tile, so the
 *     tiling is visible) with Access-Control-Allow-Origin, as GIBS serves
 *     them — the map loads them crossOrigin, so the canvas stays readable
 *
 * Options:
 *   down: 'all' | Set<'gfs'|'era5'|'station'|'drivers'|'geomag'>   answer 503
 *   archiveExpired: true    archive answers its degraded 200 (freshness:'expired')
 *   nwp: 'unpublished'      our archive answers 200 + expired + r2_not_configured
 *        'old'              our archive serves a 40-hour-old run (freshness:'stale')
 *   gibs: 'down'            every GIBS tile 404s (the map still draws the heat + site)
 *   nwp: 'nowind'           the field route has temperature but no wind (airflow says why)
 *   aq: 'down'              the air-quality field route answers 200 + expired (no field)
 *   monitors: 'down'        the AirNow stations route answers 503
 *   earth: 'blocked'        the self-hosted Blue Marble underlay (assets/earth/day-*) 404s
 */
import { labFixture } from './climate-lab-fixtures.mjs';
import { normalizeArchive, degradedArchive, parseArchiveQuery } from '../../js/climalytix/archive-request.js';
import { aqGrid, aqFieldBody, degradedAq, AQ_VARS } from '../../js/climalytix/aq-field.js';
import { siteBody, degradedNwp, parseSite, fieldPlan, fieldBody, SCHEMA } from '../../js/climalytix/point-tile.js';
import { deflateSync } from 'node:zlib';
import { encodePng } from '../helpers/cloud-source.mjs';
import { terrariumEncode, tileLatLon, TILE_PX } from '../../js/climalytix/terrain.js';

const DAY = 86_400_000;

/** Synthetic ERA5 upstream: a clean seasonal cycle with a planted record day. */
export function syntheticArchiveUpstream(fromYear, nowMs, utcOffsetS = -7 * 3600) {
    const start = Date.UTC(fromYear, 0, 1) - utcOffsetS * 1000;   // local midnight
    const end = nowMs - 5 * DAY;
    const time = [], tmax = [], tmin = [], tmean = [], precip = [], wmax = [], gust = [], et0 = [];
    for (let t = start, i = 0; t <= end; t += DAY, i++) {
        const doy = (i % 365.25) / 365.25;
        const hi = 16 + 12 * Math.sin(2 * Math.PI * (doy - 0.3));
        time.push(Math.round(t / 1000));
        tmax.push(i === 400 ? 41.5 : +hi.toFixed(1));                 // planted record high
        tmin.push(i % 97 === 3 ? null : +(hi - 12).toFixed(1));        // planted gaps
        tmean.push(+(hi - 6).toFixed(1));
        precip.push(i % 6 === 0 ? 4.5 : 0);
        wmax.push(6 + (i % 5));
        gust.push(12 + (i % 7));
        et0.push(+(2 + 2 * Math.sin(2 * Math.PI * (doy - 0.3))).toFixed(2));
    }
    return {
        latitude: 40.02, longitude: -105.27, elevation: 1624,
        timezone: 'America/Denver', utc_offset_seconds: utcOffsetS,
        daily: {
            time, temperature_2m_max: tmax, temperature_2m_min: tmin, temperature_2m_mean: tmean,
            precipitation_sum: precip, wind_speed_10m_max: wmax, wind_gusts_10m_max: gust,
            et0_fao_evapotranspiration: et0,
        },
    };
}

export function teleconnectionsFixture(nowMs) {
    const hist = (phase) => Array.from({ length: 60 }, (_, i) => ({
        date: new Date(nowMs - (60 - i) * DAY).toISOString().slice(0, 10),
        value: +(1.5 * Math.sin(i / 9 + phase)).toFixed(2),
    }));
    return {
        source: 'NOAA CPC daily AO + NAO indices (fixture)', freshness: 'live',
        ao: { current: 0.4, history: hist(0) }, nao: { current: -0.2, history: hist(1.3) },
    };
}

export function apHistoryFixture(nowMs) {
    const rows = [];
    const t0 = Math.floor(nowMs / (3 * 3_600_000)) * 3 * 3_600_000;
    for (let i = -240; i <= 0; i++) rows.push({ t: new Date(t0 + i * 3 * 3_600_000).toISOString(), ap: 5 + (i % 8 === 0 ? 40 : 3), kind: 'observed' });
    for (let i = 1; i <= 360; i++) rows.push({ t: new Date(t0 + i * 3 * 3_600_000).toISOString(), ap: 8, kind: 'predicted' });
    return { source: 'NOAA SWPC (fixture)', freshness: 'live', stale: false, data: { rows } };
}

// ── A real PNG, no dependencies ────────────────────────────────────────────
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(buf) { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
}
/** A solid RGBA PNG of w×h. */
export function solidPng(w, h, [r, g, b, a = 255]) {
    const row = Buffer.alloc(1 + w * 4);
    for (let x = 0; x < w; x++) row.set([r, g, b, a], 1 + x * 4);
    const raw = Buffer.concat(Array.from({ length: h }, () => row));
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** The base tiles' colour: dark earth tones that vary by tile so seams show. */
export function baseTileColor(z, row, col) { return [40 + ((row * 7 + col * 3) % 5) * 9, 70 + (z * 5) % 30, 52]; }
const pngCache = new Map();
function tilePng(key, rgba) {
    if (!pngCache.has(key)) pngCache.set(key, solidPng(512, 512, rgba));
    return pngCache.get(key);
}

/** Our archive's heat FIELD around a site, built by the route's own code. */
/** Closed-form 10 m wind for the mock field: a 6 m/s westerly plus a
 *  counter-clockwise (cyclonic, NH) swirl centred 1° north and 1.5° west of
 *  the site — so the drawn flow has structure whose direction is KNOWN. */
export function mockWind(lat, lon, site) {
    const dy = (lat - (site.lat + 1)) * 111_320, dx = (lon - (site.lon - 1.5)) * 111_320 * Math.cos(lat * Math.PI / 180);
    const r = Math.hypot(dx, dy), k = 9 * Math.exp(-((r / 150_000) ** 2)) / Math.max(r, 1);
    return { u: 6 - k * dy, v: k * dx };
}

export function nwpFieldFixture(nowMs, site, { ageH = 7, half = 3, vars = ['tempC'], windFn = null, cloudFn = () => 0 } = {}) {
    const H = 3_600_000;
    const runMs = Math.floor((nowMs - ageH * H) / (6 * H)) * 6 * H;
    const leadsH = Array.from({ length: 81 }, (_, i) => i * 3);
    const man = {
        schema: SCHEMA, source: 'gfs', grid: '0p25', run: new Date(runMs).toISOString().slice(0, 16) + 'Z', runMs,
        lat0: 90, dlat: 0.25, lon0: 0, dlon: 0.25, ni: 1440, nj: 721, tileN: 20, tileRows: 36, tileCols: 72,
        vars: [{ id: 'tempC', unit: 'degC', scale: 0.01, offset: 0 }], times: leadsH.map((h) => runMs + h * H), leadsH,
        nodata: -32768, prefix: 'mock',
    };
    const plan = fieldPlan(man, { lat: site.lat, lon: site.lon, halfDeg: half });
    const plane = plan.nRows * plan.nCols;
    const values = new Float32Array(man.times.length * plane);
    for (let t = 0; t < man.times.length; t++) {
        const diurnal = 6 * Math.sin(2 * Math.PI * (man.times[t] / 86_400_000 - 0.4));
        for (let i = 0; i < plan.nRows; i++) {
            for (let j = 0; j < plan.nCols; j++) {
                const lat = plan.latN - i * man.dlat, lon = plan.lonW + j * man.dlon;
                // A clear north–south gradient plus a warm east: the layer must SHOW structure.
                values[t * plane + i * plan.nCols + j] = 10 - 2.2 * (lat - site.lat) + 1.5 * (lon - site.lon) + diurnal;
            }
        }
    }
    if (vars.length === 1 && vars[0] === 'tempC') return fieldBody(man, plan, 'tempC', values, { nowMs, site });
    const wind = { uMs: new Float32Array(values.length), vMs: new Float32Array(values.length), cloudPct: new Float32Array(values.length) };
    for (let t = 0; t < man.times.length; t++) {
        for (let i = 0; i < plan.nRows; i++) for (let j = 0; j < plan.nCols; j++) {
            const lat = plan.latN - i * man.dlat, lon = plan.lonW + j * man.dlon;
            const w = windFn ? windFn(lat, lon) : mockWind(lat, lon, site);
            wind.uMs[t * plane + i * plan.nCols + j] = w.u;
            wind.vMs[t * plane + i * plan.nCols + j] = w.v;
            wind.cloudPct[t * plane + i * plan.nCols + j] = 100 * cloudFn(lat, lon, man.times[t]);
        }
    }
    const all = { tempC: values, ...wind };
    const [first, ...rest] = vars;
    man.vars = vars.map((id) => ({ id, unit: id === 'tempC' ? 'degC' : 'm/s', scale: 0.01, offset: 0 }));
    return fieldBody(man, plan, first, all[first], { nowMs, site, extra: Object.fromEntries(rest.map((id) => [id, all[id]])) });
}

const GFS_VARS = ['tempC', 'dewC', 'rhPct', 'uMs', 'vMs', 'gustMs', 'mslHpa', 'precipMm', 'cloudPct'];

/** Our archive's body for one site: a 00z run `ageH` hours old, 0–240 h every
 *  3 h, closed-form values (diurnal temperature, a rain burst, a trough). */
export function nwpFixture(nowMs, site, { ageH = 7 } = {}) {
    const H = 3_600_000;
    const runMs = Math.floor((nowMs - ageH * H) / (6 * H)) * 6 * H;
    const leadsH = Array.from({ length: 81 }, (_, i) => i * 3);
    const times = leadsH.map((h) => runMs + h * H);
    const man = {
        schema: SCHEMA, source: 'gfs', grid: '0p25', run: new Date(runMs).toISOString().slice(0, 16) + 'Z', runMs,
        dlat: 0.25, dlon: 0.25, vars: GFS_VARS.map((id) => ({ id, unit: '-' })), times, leadsH,
        intervalH: { precipMm: 3 }, missing: [], notes: [],
    };
    const v = {
        tempC: times.map((t) => 9 + 7 * Math.sin(2 * Math.PI * (t / 86_400_000 - 0.4))),
        dewC: times.map(() => 1.5), rhPct: times.map(() => 55), gustMs: times.map(() => 9),
        // A wind that veers through the run (mostly westerly) so the rose has shape.
        uMs: times.map((t) => 5 + 3 * Math.sin(2 * Math.PI * t / (36 * H))), vMs: times.map((t) => 4 * Math.cos(2 * Math.PI * t / (50 * H))),
        mslHpa: leadsH.map((h) => 1016 - 9 * Math.exp(-(((h - 96) / 30) ** 2))),
        precipMm: leadsH.map((h) => (h === 0 ? null : h >= 90 && h <= 102 ? 2.4 : 0)),
        cloudPct: times.map(() => 40),
    };
    return siteBody(man, { nodeLat: Math.ceil(site.lat * 4) / 4, nodeLon: Math.floor(site.lon * 4) / 4 + 360 }, v, { ...site, nowMs });
}

/**
 * Closed-form PM2.5 for the mock air-quality field: a background that is
 * DIRTY when the mock site wind (nwpFixture) blows from the north (v < 0) and
 * clean from the south, plus a LINEAR spatial gradient — bilinear on the
 * 0.5° nodes reproduces a linear field exactly, so the model at any monitor
 * is known in closed form.
 */
export function mockPm25(lat, lon, ms, site) {
    const H = 3_600_000;
    const v = 4 * Math.cos(2 * Math.PI * ms / (50 * H));
    // The gradient is anchored at a FIXED point (40°N 105°W), not the site:
    // the field route sees the snapped centre and the stations route the
    // page's site, and both must describe the same air.
    void site;
    return 8 + 12 * Math.max(0, -v / 4) + 0.6 * (lat - 40) - 0.4 * (lon + 105);
}
/** Mock monitors read this much ABOVE the model (so model − measured = −2). */
export const MOCK_MONITOR_EXCESS = 2;

export function aqFieldFixture(nowMs, site) {
    const H = 3_600_000;
    const grid = aqGrid(site.lat, site.lon);
    const t0 = Math.floor(nowMs / 86_400_000) * 86_400_000 - 86_400_000;
    const hours = Array.from({ length: 24 * 6 }, (_, k) => t0 + k * H);
    const locs = grid.lats.map((lat, p) => {
        const lonC = grid.lonW + (p % grid.nCols) * grid.dlon;          // continuous with the site
        const hourly = { time: hours.map((ms) => ms / 1000) };
        for (const v of AQ_VARS) hourly[v.om] = hours.map((ms) => (v.id === 'pm25' ? +mockPm25(lat, lonC, ms, site).toFixed(3) : 1));
        return { latitude: lat, longitude: grid.lons[p], hourly };
    });
    return aqFieldBody(grid, locs, { nowMs, site });
}

/** AirNow-shaped stations answer: six monitors around the site at the requested hour. */
export function stationsFixture(nowMs, site, atMs) {
    const H = 3_600_000;
    const hour = Math.floor(atMs / H) * H;
    if (hour > nowMs) return { available: false, reason: 'observations_not_forecasts' };
    const offsets = [[0.3, 0.4], [-0.6, 0.2], [1.1, -0.9], [-1.4, -1.2], [0.8, 1.6], [-0.2, -2.1]];
    return {
        available: true, count: offsets.length,
        frame: {
            validAt: new Date(hour).toISOString(),
            points: offsets.map(([dLat, dLon], k) => {
                const lat = site.lat + dLat, lon = site.lon + dLon;
                return { id: `M${k}`, name: `Monitor ${k}`, lat, lon,
                         pm25: +(mockPm25(lat, lon, hour, site) + MOCK_MONITOR_EXCESS).toFixed(3), units: { pm25: 'UG/M3' } };
            }),
        },
    };
}

// ── Terrain: a closed-form ridge ────────────────────────────────────────────
// An east–west ridge along MOCK_RIDGE.lat: flat at `base` m, rising linearly
// to base + rise at the crest over `halfDeg` of latitude either side. Its
// south flank FACES SOUTH and its north flank FACES NORTH at
// atan(rise / (halfDeg·111 195 m)) ≈ 10.2°, so sun exposure has a known sign.
export const MOCK_RIDGE = Object.freeze({ lat: 40.0, halfDeg: 0.1, base: 1500, rise: 2000 });
export const MOCK_RIDGE_SLOPE_DEG = Math.atan(MOCK_RIDGE.rise / (MOCK_RIDGE.halfDeg * 6_371_008.8 * Math.PI / 180)) * 180 / Math.PI;
export function mockDem(lat) {
    return MOCK_RIDGE.base + MOCK_RIDGE.rise * Math.max(0, 1 - Math.abs(lat - MOCK_RIDGE.lat) / MOCK_RIDGE.halfDeg);
}
const demCache = new WeakMap();
/** One Terrarium tile of `heightAt(lat, lon)` (default: the ridge), pixel centres in Web-Mercator. */
function demTilePng(z, x, y, heightAt = mockDem) {
    if (!demCache.has(heightAt)) demCache.set(heightAt, new Map());
    const cache = demCache.get(heightAt), key = `${z}/${x}/${y}`;
    if (!cache.has(key)) {
        const rowLat = Array.from({ length: TILE_PX }, (_, j) => tileLatLon(x, y + (j + 0.5) / TILE_PX, z).lat);
        const colLon = Array.from({ length: TILE_PX }, (_, i) => tileLatLon(x + (i + 0.5) / TILE_PX, y, z).lon);
        cache.set(key, encodePng(TILE_PX, TILE_PX, (i, j) => [...terrariumEncode(heightAt(rowLat[j], colLon[i])), 255]));
    }
    return cache.get(key);
}

export async function installClimalytixMocks(page, { dem = 'up', demHeight, windFn = null, cloudFn, cloud = 'up', onDem, down = null, archiveExpired = false, nwp = 'fresh', gibs = 'up', earth = 'up', aq = 'up', monitors = 'up', onTile, onRequest } = {}) {
    const isDown = (id) => down === 'all' || (down instanceof Set && down.has(id));
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        const now = Date.now();
        onRequest?.(url);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
            const p = url.pathname;
            if (p === '/api/climalytix/nwp-field') {
                if (isDown('gfs')) return route.fulfill({ status: 503, json: { error: 'upstream_unavailable' } });
                const q = parseSite(Object.fromEntries(url.searchParams));
                if (nwp === 'unpublished') return route.fulfill({ json: { ...degradedNwp(q, '0p25', 'r2_not_configured', now), var: 'tempC', values: null } });
                const vars = (url.searchParams.get('vars') || 'tempC').split(',');
                if (cloud === 'missing' && vars.includes('cloudPct')) return route.fulfill({ json: { ...degradedNwp(q, '0p25', 'no variable cloudPct in this run', now), vars, fields: null, values: null } });
                if (nwp === 'nowind' && vars.includes('uMs')) return route.fulfill({ json: { ...degradedNwp(q, '0p25', 'no variable uMs in this run', now), vars, fields: null, values: null } });
                return route.fulfill({ json: nwpFieldFixture(now, q, { ageH: nwp === 'old' ? 40 : 7, half: Number(url.searchParams.get('half')) || 3, vars, windFn, ...(cloudFn ? { cloudFn } : {}) }) });
            }
            if (p === '/api/climalytix/nwp') {
                if (isDown('gfs')) return route.fulfill({ status: 503, json: { error: 'upstream_unavailable' } });
                const q = parseSite(Object.fromEntries(url.searchParams));
                if (nwp === 'unpublished') return route.fulfill({ json: degradedNwp(q, '0p25', 'r2_not_configured', now) });
                return route.fulfill({ json: nwpFixture(now, q, { ageH: nwp === 'old' ? 40 : 7 }) });
            }
            if (p === '/api/climalytix/archive') {
                if (isDown('era5')) return route.fulfill({ status: 503, json: { error: 'upstream_unavailable' } });
                const q = parseArchiveQuery(Object.fromEntries(url.searchParams), now);
                if (archiveExpired) return route.fulfill({ json: degradedArchive(q, 'upstream HTTP 429', now) });
                return route.fulfill({ json: normalizeArchive(syntheticArchiveUpstream(q.fromYear, now), q, now) });
            }
            if (p === '/api/weather/forecast' && url.searchParams.get('type') === 'lab') {
                if (isDown('station')) return route.fulfill({ status: 503, json: { error: 'upstream_unavailable' } });
                return route.fulfill({ json: labFixture(now) });
            }
            if (p === '/api/weather/teleconnections') {
                if (isDown('drivers')) return route.fulfill({ status: 503, json: { error: 'upstream_unavailable' } });
                return route.fulfill({ json: teleconnectionsFixture(now) });
            }
            if (p === '/api/noaa/ap-history') {
                if (isDown('geomag')) return route.fulfill({ status: 503, json: { error: 'upstream_unavailable' } });
                return route.fulfill({ json: apHistoryFixture(now) });
            }
            if (p === '/api/climalytix/aq-field') {
                const q = parseSite(Object.fromEntries(url.searchParams));
                if (aq === 'down') return route.fulfill({ json: degradedAq(q, 'upstream_failed: upstream HTTP 503', now) });
                return route.fulfill({ json: aqFieldFixture(now, q) });
            }
            if (p === '/api/climalytix/dem') {
                const [z, x, y] = ['z', 'x', 'y'].map((k) => Number(url.searchParams.get(k)));
                onDem?.({ z, x, y });
                if (dem === 'down') return route.fulfill({ status: 502, json: { error: 'upstream_unavailable' } });
                return route.fulfill({ status: 200, body: demTilePng(z, x, y, demHeight), headers: { 'Content-Type': 'image/png' } });
            }
            if (p === '/api/air-quality/stations') {
                if (monitors === 'down') return route.fulfill({ status: 503, json: { error: 'upstream_unavailable', message: 'AirNow HTTP 503' } });
                const site = { lat: Number(url.searchParams.get('lat')), lon: Number(url.searchParams.get('lon')) };
                return route.fulfill({ json: stationsFixture(now, site, Date.parse(url.searchParams.get('at'))) });
            }
            if (p.startsWith('/api/')) return route.abort();
            if (earth === 'blocked' && p.startsWith('/assets/earth/day-')) return route.fulfill({ status: 404, body: 'not found' });
            return route.continue();
        }
        if (url.hostname === 'gibs.earthdata.nasa.gov') {
            const m = /\/(\d+)\/(\d+)\/(\d+)\.(jpg|png)$/.exec(url.pathname);
            if (!m || gibs === 'down') return route.fulfill({ status: 404, body: 'not found' });
            const [z, row, col] = m.slice(1, 4).map(Number);
            const overlay = /Reference_/.test(url.pathname);
            const body = overlay ? tilePng('overlay', [0, 0, 0, 0]) : tilePng(`${z}/${row}/${col}`, baseTileColor(z, row, col));
            onTile?.(url);
            return route.fulfill({ status: 200, body, headers: { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' } });
        }
        if (url.hostname === 'nominatim.openstreetmap.org' && url.pathname.startsWith('/search')) {
            return route.fulfill({ json: [{ lat: '35.6762', lon: '139.6503', display_name: 'Tokyo, Japan', address: { city: 'Tokyo' } }] });
        }
        return route.abort();
    });
}
