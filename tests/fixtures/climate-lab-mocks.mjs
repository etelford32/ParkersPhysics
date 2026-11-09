/**
 * climate-lab-mocks.mjs — Playwright route mocks for the dashboard's Climate
 * Lab, built from climate-lab-fixtures.mjs.
 * Every third-party host is fulfilled or aborted: CI has no outbound network,
 * and a feed that silently hangs would make the gate time-dependent.
 *
 * ONE INSTANT, BOTH SIDES. The fixtures are laid out relative to the hour
 * of the instant they are built for, and the page reads them at ITS OWN
 * Date.now(). Built per request from the test process's clock, the gate
 * therefore read the fixture at whatever minute the run happened to start —
 * and the fixture is NOT valid at every minute: its deliberate pressure gap
 * sits at hourNow − 2 h, and tendencyFromSeries only accepts a sample within
 * 45 min of now − 3 h, so from :46 to :59 neither neighbour of the gap
 * qualifies, the 3-hour change is "—" and the "Falling" chip disappears
 * (2026-11-09: failed twice a few minutes before 03:00 UTC, passed 42 times
 * elsewhere in the hour; tests/climate-lab.mjs pins the window). A run
 * straddling an hour boundary is a second way to read hour H+1 out of a
 * fixture built for hour H (the station's 30 s tick re-reads on the hour).
 * So a gate that asserts exact numbers passes `nowMs` here AND pins the page
 * to the same instant with `pinPageClock`; `labAnchor()` is that instant.
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

const HOUR = 3_600_000;

/**
 * :20 past the current UTC hour — the minute the node gate's NOW uses, 25 min
 * clear of the fixture's :46 edge and 40 min clear of the hour boundary (a
 * spec runs for ~2 min). Exported for tests/climate-lab.mjs, which checks it.
 */
export const LAB_ANCHOR_MINUTE = 20;
export function labAnchor(realMs = Date.now()) {
    return Math.floor(realMs / HOUR) * HOUR + LAB_ANCHOR_MINUTE * 60_000;
}

/**
 * Start the page's wall clock at `nowMs` and let it advance at the real rate
 * (monotonic `performance.now()`), before any page script runs. ONLY `Date`
 * is touched — timers, rAF and performance stay native, which is why this is
 * not `page.clock` (that fakes requestAnimationFrame too).
 */
export async function pinPageClock(page, nowMs) {
    await page.addInitScript((anchor) => {
        const RealDate = Date;
        const t0 = performance.now();
        const now = () => anchor + (performance.now() - t0);
        function PinnedDate(...args) {
            if (!new.target) return new RealDate(now()).toString();
            return args.length ? new RealDate(...args) : new RealDate(now());
        }
        PinnedDate.prototype = RealDate.prototype;
        PinnedDate.now = () => Math.floor(now());
        PinnedDate.parse = RealDate.parse;
        PinnedDate.UTC = RealDate.UTC;
        Object.defineProperty(PinnedDate.prototype, 'constructor', { value: PinnedDate, configurable: true, writable: true });
        globalThis.Date = PinnedDate;
    }, nowMs);
}

/**
 * @param {object} [opts]
 * @param {number} [opts.nowMs]  build every fixture for THIS instant (pair it
 *   with pinPageClock). Omitted, each request uses the test process's clock.
 */
export async function installLabMocks(page, { onRequest, nowMs } = {}) {
    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
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
