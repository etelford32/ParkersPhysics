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
 *     degradedNwp from a synthetic manifest (the route's own two functions)
 *
 * Options:
 *   down: 'all' | Set<'gfs'|'era5'|'station'|'drivers'|'geomag'>   answer 503
 *   archiveExpired: true    archive answers its degraded 200 (freshness:'expired')
 *   nwp: 'unpublished'      our archive answers 200 + expired + r2_not_configured
 *        'old'              our archive serves a 40-hour-old run (freshness:'stale')
 */
import { labFixture } from './climate-lab-fixtures.mjs';
import { normalizeArchive, degradedArchive, parseArchiveQuery } from '../../js/climalytix/archive-request.js';
import { siteBody, degradedNwp, parseSite, SCHEMA } from '../../js/climalytix/point-tile.js';

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
        uMs: times.map(() => 3), vMs: times.map(() => -4),
        mslHpa: leadsH.map((h) => 1016 - 9 * Math.exp(-(((h - 96) / 30) ** 2))),
        precipMm: leadsH.map((h) => (h === 0 ? null : h >= 90 && h <= 102 ? 2.4 : 0)),
        cloudPct: times.map(() => 40),
    };
    return siteBody(man, { nodeLat: Math.ceil(site.lat * 4) / 4, nodeLon: Math.floor(site.lon * 4) / 4 + 360 }, v, { ...site, nowMs });
}

export async function installClimalytixMocks(page, { down = null, archiveExpired = false, nwp = 'fresh', onRequest } = {}) {
    const isDown = (id) => down === 'all' || (down instanceof Set && down.has(id));
    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        const now = Date.now();
        onRequest?.(url);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
            const p = url.pathname;
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
            if (p.startsWith('/api/')) return route.abort();
            return route.continue();
        }
        if (url.hostname === 'nominatim.openstreetmap.org' && url.pathname.startsWith('/search')) {
            return route.fulfill({ json: [{ lat: '35.6762', lon: '139.6503', display_name: 'Tokyo, Japan', address: { city: 'Tokyo' } }] });
        }
        return route.abort();
    });
}
