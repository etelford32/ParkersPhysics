/**
 * climate-lab-mocks.mjs — Playwright route mocks for the dashboard's Climate
 * Lab, built from climate-lab-fixtures.mjs around the page's own clock.
 * Every third-party host is fulfilled or aborted: CI has no outbound network,
 * and a feed that silently hangs would make the gate time-dependent.
 */
import { labFixture, airFixture, archiveFixture, issRecord } from './climate-lab-fixtures.mjs';
import { normalizeOmmRecord } from '../../api/_lib/omm.js';

function orbit(nowMs, norad, name, over) {
    if (norad === 25544) return issRecord(nowMs);
    return normalizeOmmRecord({
        OBJECT_NAME: name, NORAD_CAT_ID: norad,
        EPOCH: new Date(nowMs - 8 * 3_600_000).toISOString().replace('Z', ''),
        ECCENTRICITY: 0.0003, ARG_OF_PERICENTER: 80, MEAN_ANOMALY: 280, REV_AT_EPOCH: 30000, BSTAR: 0.0002,
        ...over,
    });
}
const CATALOG = {
    25544: ['ISS (ZARYA)', {}],
    48274: ['CSS (TIANHE)', { MEAN_MOTION: 15.60, INCLINATION: 41.47, RA_OF_ASC_NODE: 300.1 }],
    20580: ['HST', { MEAN_MOTION: 15.14, INCLINATION: 28.47, RA_OF_ASC_NODE: 45.3 }],
    43013: ['NOAA 20 (JPSS-1)', { MEAN_MOTION: 14.195, INCLINATION: 98.7, RA_OF_ASC_NODE: 210.0 }],
};

export async function installLabMocks(page, { onRequest } = {}) {
    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const now = Date.now();
        onRequest?.(url);
        if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
            if (url.pathname === '/api/weather/forecast') {
                if (url.searchParams.get('type') === 'lab') return route.fulfill({ json: labFixture(now) });
                return route.abort();
            }
            if (url.pathname === '/api/celestrak/tle') {
                const id = Number(url.searchParams.get('norad'));
                const q = (url.searchParams.get('search') || '').toLowerCase();
                if (q) {
                    const hits = Object.entries(CATALOG).filter(([, [n]]) => n.toLowerCase().includes(q))
                        .map(([k, [n, o]]) => orbit(now, Number(k), n, o));
                    return route.fulfill({ json: { satellites: hits, count: hits.length } });
                }
                const hit = CATALOG[id];
                return hit ? route.fulfill({ json: { satellites: [orbit(now, id, hit[0], hit[1])], count: 1 } })
                    : route.fulfill({ status: 503, json: { error: 'upstream_unavailable' } });
            }
            if (url.pathname.startsWith('/api/')) return route.abort();
            return route.continue();
        }
        if (url.hostname === 'air-quality-api.open-meteo.com') return route.fulfill({ json: airFixture(now) });
        if (url.hostname === 'archive-api.open-meteo.com') return route.fulfill({ json: archiveFixture(now) });
        if (url.hostname === 'nominatim.openstreetmap.org' && url.pathname.startsWith('/search')) {
            return route.fulfill({ json: [{ lat: '35.6762', lon: '139.6503', display_name: 'Tokyo, Japan', address: { city: 'Tokyo' } }] });
        }
        return route.abort();
    });
}
