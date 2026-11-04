/**
 * missions-smoke.spec.js — browser gate for missions.html (the live fleet map).
 *
 * Hermetic: the three feeds are mocked (JPL Horizons, CelesTrak and LL2 are
 * all egress-blocked in CI), with fixtures built from the SAME ephemeris the
 * page draws its planets from so a Horizons "SOHO" lands where SOHO is.
 *
 *   1. With live feeds: SOHO is drawn from Horizons, the ISS from SGP4, Voyager
 *      from the model; the provenance chip counts them; and the compressed
 *      Earth neighbourhood puts SOHO OUTSIDE the drawn Earth at ~5 radii and
 *      the ISS just above its surface (the old page drew every L1 sentinel
 *      inside the sphere — tests/mission-positions.mjs carries that control).
 *   2. Card → marker focus shows the detail panel with telemetry + provenance.
 *   3. The launch manifest and the just-launched rail render with countdowns
 *      and live SGP4 sub-points.
 *   4. Family + status filters narrow the roster.
 *   5. NEGATIVE CONTROL for resilience: every feed 503 → the page still
 *      renders every card, says "model only", and throws nothing.
 *
 *   npx playwright test tests/missions-smoke.spec.js
 */
import { test, expect } from '@playwright/test';
import { earthHeliocentric, marsHeliocentric, jdNow } from '../js/horizons.js';
import { MISSION_LOCS, keplerPos, DRAW_RADIUS_AU } from '../js/mission-positions.js';
import { windowStartJd } from '../js/mission-ephemeris.js';

const HOUR = 3_600_000, DAY = 86_400_000;

function samplesFor(fn, startJd) {
    const out = [];
    for (let h = 0; h <= 26; h++) {
        const jd = startJd + h / 24;
        const p = fn(jd), q = fn(jd + 1 / 24 / 60);   // finite-difference velocity, AU/day
        out.push([jd, p.x_AU, p.y_AU, p.z_AU, (q.x_AU - p.x_AU) * 1440, (q.y_AU - p.y_AU) * 1440, (q.z_AU - p.z_AU) * 1440]);
    }
    return out;
}
const earthAt = jd => earthHeliocentric(jd);
const sohoAt  = jd => { const e = earthAt(jd); const r = Math.hypot(e.x_AU, e.y_AU, e.z_AU); const k = (r - 0.01) / r; return { x_AU: e.x_AU * k, y_AU: e.y_AU * k, z_AU: e.z_AU * k }; };
const pspAt   = jd => keplerPos(MISSION_LOCS['parker-solar-probe'], jd);

function ephemerisPayload(url) {
    const startJd = windowStartJd(jdNow());
    const ids = (new URL(url).searchParams.get('ids') || '').split(',').filter(Boolean);
    const have = { 'soho': sohoAt, 'parker-solar-probe': pspAt };
    const spacecraft = ids.map(id => have[id]
        ? { id, ok: true, command_used: id === 'soho' ? '-21' : '-96', tried: [], samples: samplesFor(have[id], startJd) }
        : { id, ok: false, command_used: null, tried: [{ command: 'x', reason: 'no-match' }], samples: null });
    return {
        source: 'jpl-horizons', fetched_at: new Date().toISOString(), window: { start_jd: startJd, hours: 26, step_h: 1 },
        freshness: spacecraft.some(s => s.ok) ? 'live' : 'stale', requested: ids.length, resolved: spacecraft.filter(s => s.ok).length,
        hosts: { earth: { command: '399', samples: samplesFor(earthAt, startJd) }, mars: { command: '499', samples: samplesFor(marsHeliocentric, startJd) } },
        spacecraft,
    };
}

/** ISS-like normalized OMM record with its epoch at "now". */
function issRecord(nowMs) {
    return {
        name: 'ISS (ZARYA)', norad_id: 25544, object_id: '1998-067A', epoch: new Date(nowMs).toISOString(), epoch_ms: nowMs,
        epoch_jd: nowMs / DAY + 2440587.5, inclination: 51.64, raan: 120.0, eccentricity: 0.0005, arg_perigee: 60.0,
        mean_anomaly: 300.0, mean_motion: 15.49, bstar: 0.0001, period_min: 92.96, apogee_km: 420, perigee_km: 413, sma_km: 6788,
        line1: null, line2: null,
    };
}
function recentRecords(nowMs) {
    const doy = Math.floor((nowMs - Date.UTC(new Date(nowMs).getUTCFullYear(), 0, 1)) / DAY) + 1;
    const yr = new Date(nowMs).getUTCFullYear();
    const base = issRecord(nowMs);
    return [
        { ...base, name: 'STARLINK-99901', norad_id: 70010, object_id: `${yr}-${String(doy - 2).padStart(3, '0')}A` },
        { ...base, name: 'FALCON 9 R/B', norad_id: 70011, object_id: `${yr}-${String(doy - 2).padStart(3, '0')}B`, perigee_km: 200, apogee_km: 350 },
        { ...base, name: 'MMX', norad_id: 70020, object_id: `${yr}-${String(doy - 14).padStart(3, '0')}A`, eccentricity: 0.9, mean_motion: 1.2, apogee_km: 900000, perigee_km: 250 },
    ];
}
function launches(nowMs) {
    const L = (name, off, status, vehicle) => ({ id: name, name, slug: name, status, mission: 'x', vehicle, provider: 'SpaceX',
        pad: { name: 'SLC-40', lat: 28.56, lon: -80.58, location: 'Cape Canaveral SFS' }, net_iso: new Date(nowMs + off).toISOString(), orbit: 'LEO' });
    return { source: 'thespacedevs/ll2', count: 3, launches: [L('Starlink Group 17-9', 5 * HOUR, 'Go', 'Falcon 9'), L('Griffin Mission One', 12 * DAY, 'TBC', 'Falcon Heavy'), L('PLATO', 60 * DAY, 'TBD', 'Ariane 64')] };
}

async function mockFeeds(page, { down = false } = {}) {
    const now = Date.now();
    const fail = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'upstream_unavailable' }) });
    await page.route('**/api/missions/ephemeris*', route => down ? fail(route) : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ephemerisPayload(route.request().url())) }));
    await page.route('**/api/celestrak/tle*', route => {
        if (down) return fail(route);
        const u = new URL(route.request().url());
        const body = u.searchParams.get('group') === 'last-30-days'
            ? { source: 'CelesTrak', count: 3, satellites: recentRecords(now) }
            : u.searchParams.get('norad') === '25544'
                ? { source: 'CelesTrak', count: 1, satellites: [issRecord(now)] }
                : null;
        return body ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }) : fail(route);
    });
    await page.route('**/api/launches/upcoming*', route => down ? fail(route) : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(launches(now)) }));
}

function collectErrors(page) {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    return errors;
}

async function waitLive(page) {
    await page.waitForFunction(() => window.__missionsViewer && !/loading/.test(document.getElementById('mn3-prov').textContent), null, { timeout: 60_000 });
}

test.describe('missions.html — live fleet map', () => {
    test('live feeds: Horizons, SGP4 and model markers each say which, and the Earth neighbourhood is drawn outside the sphere', async ({ page }) => {
        const errors = collectErrors(page);
        await mockFeeds(page);
        await page.goto('/missions.html');
        await waitLive(page);
        const prov = await page.evaluate(() => window.__missionsViewer.provenance());
        expect(prov.horizons).toBeGreaterThanOrEqual(2);
        expect(prov.sgp4).toBeGreaterThanOrEqual(1);
        expect(prov.model).toBeGreaterThan(20);
        await expect(page.locator('#mn3-prov')).toContainText('JPL Horizons');
        await expect(page.locator('#mn3-prov')).toContainText('SGP4');

        // give the loop a few frames, then read the drawn state
        await page.waitForTimeout(600);
        const r = await page.evaluate(() => {
            const v = window.__missionsViewer;
            const items = Object.fromEntries(v.items().map(i => [i.id, i]));
            const e = v.planets().earth;
            const d = i => Math.hypot(i.pos.x_AU - e.x_AU, i.pos.y_AU - e.y_AU, i.pos.z_AU - e.z_AU);
            return { soho: items.soho, sohoD: d(items.soho), iss: items.iss, issD: d(items.iss), psp: items['parker-solar-probe'], voy: items['voyager-1'], earthR: Math.hypot(e.x_AU, e.y_AU, e.z_AU), sohoR: Math.hypot(items.soho.pos.x_AU, items.soho.pos.y_AU, items.soho.pos.z_AU) };
        });
        expect(r.soho.source).toBe('horizons');
        expect(r.psp.source).toBe('horizons');
        expect(r.iss.source).toBe('sgp4');
        expect(r.voy.source).toBe('model');
        const RE = DRAW_RADIUS_AU.earth;
        expect(r.sohoD / RE).toBeGreaterThan(4.5);
        expect(r.sohoD / RE).toBeLessThan(5.5);
        expect(r.sohoR).toBeLessThan(r.earthR);            // L1 is sunward
        expect(r.issD / RE).toBeGreaterThan(1.0);
        expect(r.issD / RE).toBeLessThan(1.12);
        // hero stat + per-card live lines
        await expect(page.locator('#msn-stat-live')).toContainText('live positions');
        const sohoCard = page.locator('.msn-card[data-mission-id="soho"] .msn-card-live');
        await expect(sohoCard).toHaveAttribute('data-source', 'horizons');
        await expect(sohoCard).toContainText('Sun–Earth L1');
        await expect(page.locator('.msn-card[data-mission-id="iss"] .msn-card-live')).toContainText(/alt \d+ km/);
        expect(errors).toEqual([]);
    });

    test('card click focuses the marker and opens the detail panel with telemetry + provenance', async ({ page }) => {
        const errors = collectErrors(page);
        await mockFeeds(page);
        await page.goto('/missions.html');
        await waitLive(page);
        await page.locator('.msn-card[data-mission-id="parker-solar-probe"]').click();
        const detail = page.locator('#mn3-detail');
        await expect(detail).toHaveClass(/mn3-detail--shown/);
        await expect(detail.locator('.mn3-detail-name')).toHaveText('Parker Solar Probe');
        await expect(detail.locator('.mn3-detail-tel')).toContainText('r☉');
        await expect(detail.locator('.mn3-detail-prov')).toContainText('JPL Horizons (-96)');
        await expect(page.locator('.msn-card[data-mission-id="parker-solar-probe"]')).toHaveClass(/msn-card--focus/);
        // a model-placed mission says so
        await page.locator('.msn-card[data-mission-id="voyager-1"]').click();
        await expect(detail.locator('.mn3-detail-prov')).toContainText('Analytic model');
        // the next-milestone countdown renders on cards that carry one
        await expect(page.locator('.msn-card[data-mission-id="bepicolombo"] .msn-next strong')).toContainText(/^T[−+]/);
        expect(errors).toEqual([]);
    });

    test('launch manifest + just-launched rails render with countdowns and SGP4 sub-points', async ({ page }) => {
        const errors = collectErrors(page);
        await mockFeeds(page);
        await page.goto('/missions.html');
        const rows = page.locator('#msn-manifest-list .msn-launch');
        await expect(rows).toHaveCount(2);                       // the 60-day one is outside the 30-day window
        await expect(rows.nth(0).locator('.msn-launch-t')).toContainText(/^T−4h 5\dm$/);
        await expect(rows.nth(0).locator('.msn-pip')).toHaveClass(/msn-pip--go/);
        await expect(rows.nth(1).locator('.msn-launch-name')).toHaveText('Griffin Mission One');
        await expect(page.locator('#msn-stat-launches')).toContainText('2');
        const objs = page.locator('#msn-recent-list .msn-obj');
        await expect(objs).toHaveCount(3);
        await expect(page.locator('#msn-recent-count')).toContainText('2 launches · 2 payloads · 1 rocket bodies');
        await expect(objs.nth(1).locator('.msn-kind')).toHaveText('R/B');
        await expect(objs.nth(2).locator('.msn-obj-meta')).toContainText('beyond GEO');
        await expect(objs.nth(0).locator('.msn-obj-pos')).toContainText(/\d+ km/, { timeout: 15_000 });
        expect(errors).toEqual([]);
    });

    test('family and status filters narrow the roster', async ({ page }) => {
        await mockFeeds(page);
        await page.goto('/missions.html');
        await expect(page.locator('#msn-family-filters .msn-chip')).toHaveCount(8);
        await expect(page.locator('.msn-card')).toHaveCount(71);
        await page.locator('[data-family="outer"]').click();
        await expect(page.locator('.msn-card')).toHaveCount(7);
        await page.locator('[data-status="cruising"]').click();
        await expect(page.locator('.msn-card')).toHaveCount(2);    // Europa Clipper + JUICE
        await expect(page.locator('#msn-counter')).toHaveText('Showing 2 of 71 missions');
        await expect(page.locator('#msn-verified')).toContainText('verified 2026-11-03');
    });

    test('NEGATIVE CONTROL: every feed down → every card still renders, map says model only, nothing throws', async ({ page }) => {
        const errors = collectErrors(page);
        await mockFeeds(page, { down: true });
        await page.goto('/missions.html');
        await waitLive(page);
        await expect(page.locator('.msn-card')).toHaveCount(71);
        await expect(page.locator('#mn3-prov')).toContainText('model only');
        const prov = await page.evaluate(() => window.__missionsViewer.provenance());
        expect(prov.horizons + prov.sgp4).toBe(0);
        expect(prov.model).toBeGreaterThan(50);
        await expect(page.locator('#msn-manifest-list .msn-rail-empty')).toHaveAttribute('data-state', 'down');
        await expect(page.locator('#msn-recent-list .msn-rail-empty')).toHaveAttribute('data-state', 'down');
        await expect(page.locator('#msn-stat-launches')).toContainText('feed down');
        expect(errors).toEqual([]);
    });
});
