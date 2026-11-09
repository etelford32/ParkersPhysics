/**
 * climalytix-smoke.spec.js — browser gate for climalytix.html (plan §13 P0).
 *
 * Every feed is mocked (tests/fixtures/climalytix-mocks.mjs); CI has no
 * outbound network. What it pins:
 *   · boot with no uncaught exception; the site is the CURRENT VIEW
 *     (ppx_user_location), the one location store
 *   · all five datasets load and say so; the expected panels render; OUR
 *     archive (GFS) is listed first and badged, the bootstrap ones badged too
 *   · our archive down/unpublished is ONE red chip that says why, and the
 *     bootstrap NWP is NOT substituted for it (its series stay their own)
 *   · a workspace saved before the archive existed gets its series once
 *   · the future is dashed (a projection), never solid
 *   · long windows are AGGREGATED and the legend names the bucket
 *   · the workspace persists across a reload; a series toggle removes a panel
 *   · the crosshair reads every series at one instant
 *   · ONE dead feed is one red chip and the rest still draw
 *   · NEGATIVE CONTROL: every feed down ⇒ the page says it is an outage and
 *     draws NOTHING (feeds down must look down, never quiet)
 *   · visiting another place shows VISITING + Return home; Return home goes home
 *   · phone width: no horizontal scroll
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks } from './fixtures/climalytix-mocks.mjs';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };

test.describe.configure({ timeout: 90_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', reducedMotion: 'reduce' });

async function boot(page, { mocks = {}, device = BOULDER, account = null, ws = null, path = '/climalytix.html' } = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    await installClimalytixMocks(page, mocks);
    await page.addInitScript(({ device, account, ws }) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        if (device) localStorage.setItem('ppx_user_location', JSON.stringify(device));
        if (account) localStorage.setItem('pp_auth', JSON.stringify({ signedIn: false, location: account }));
        if (ws) localStorage.setItem('pp_climalytix_v1', JSON.stringify(ws));
    }, { device, account, ws });
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__climalytix && window.__climalytix.state.loading.length === 0
        && Object.keys(window.__climalytix.state.datasets).length === 5, null, { timeout: 60_000 });
    return errors;
}

const state = (page) => page.evaluate(() => window.__climalytix.state);

test('boots at the current view, loads all five datasets and draws the panels', async ({ page }) => {
    const errors = await boot(page);
    await expect(page.locator('#cx-site-name')).toHaveText('Boulder, CO');
    const s = await state(page);
    for (const id of ['gfs', 'era5', 'station', 'drivers', 'geomag']) {
        expect(s.datasets[id].state, `${id} loads`).toBe('live');
    }
    expect(s.datasets.geomag.series).toEqual(['geomag.apObs', 'geomag.apPred']);
    expect(s.panels.map((p) => p.id)).toEqual(['temp', 'precip', 'wind', 'pressure', 'drivers', 'geomag']);
    expect(s.panels.every((p) => p.hasData)).toBe(true);
    await expect(page.locator('.cx-chip[data-state="live"]')).toHaveCount(5);
    // Our archive is listed first and says whose it is; the bootstrap feeds say so too.
    await expect(page.locator('.cx-ds').first()).toHaveAttribute('data-dataset', 'gfs');
    await expect(page.locator('[data-dataset="gfs"] .cx-role')).toHaveText('Our archive');
    await expect(page.locator('[data-dataset="station"] .cx-role')).toHaveText('Bootstrap');
    await expect(page.locator('[data-dataset="gfs"] .cx-ds-note').first()).toContainText('bilinear from 4 grid nodes');
    // The temperature panel overlays the 35-year record, our 10-day GFS run and the bootstrap forecast on one ruler.
    expect(s.panels[0].lines).toEqual(expect.arrayContaining(['era5.tmax', 'era5.tmin', 'gfs.tempC', 'station.tempC']));
    expect(s.datasets.gfs.series).toEqual(expect.arrayContaining(['gfs.tempC', 'gfs.precipMm', 'gfs.windMs', 'gfs.mslHpa']));
    await expect(page.locator('[data-panel="temp"] path.cx-proj[data-series="gfs.tempC"]')).toHaveCount(1);
    // Our archive and the bootstrap draw in DIFFERENT colours (slots are per series, never shared).
    const cls = await page.locator('[data-panel="temp"] path[data-series="gfs.tempC"]').first().getAttribute('class');
    expect(cls).toContain('cx-s4');
    // Past solid, future dashed.
    await expect(page.locator('[data-panel="temp"] path.cx-proj[data-series="station.tempC"]')).toHaveCount(1);
    await expect(page.locator('[data-panel="temp"] .cx-now')).toHaveCount(1);
    await expect(page.locator('#cx-step')).toContainText('dashed = projection');
    expect(errors).toEqual([]);
});

test('long windows aggregate by each series’ rule and say so; the workspace persists', async ({ page }) => {
    await boot(page);
    await page.locator('[data-range="all"]').click();
    await expect(page.locator('#cx-step')).toContainText('30-day');
    await expect(page.locator('[data-panel="temp"] .cx-key[data-series="era5.tmax"] .cx-agg-note')).toContainText(/max per 30-day/);
    await expect(page.locator('[data-panel="precip"] .cx-key[data-series="era5.precip"] .cx-agg-note')).toContainText(/sum per 30-day/);
    // A 10-day forecast in a 30-day bucket is honest about it, not "No data".
    await expect(page.locator('[data-panel="temp"] .cx-key[data-series="gfs.tempC"] .cx-agg-note')).toContainText(/only \d+ days — zoom in/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__climalytix?.state.loading.length === 0
        && Object.keys(window.__climalytix.state.datasets).length === 5);
    await expect(page.locator('[data-range="all"]')).toHaveAttribute('aria-pressed', 'true');
    expect((await state(page)).workspace.range).toBe('all');
});

test('a series toggle removes its panel, and the crosshair reads every series at one instant', async ({ page }) => {
    await boot(page);
    await page.locator('input[data-series="drivers.ao"]').uncheck();
    await page.locator('input[data-series="drivers.nao"]').uncheck();
    await expect(page.locator('[data-panel="drivers"]')).toHaveCount(0);
    expect((await state(page)).workspace.on).not.toContain('drivers.ao');

    const svg = page.locator('[data-panel="temp"] .cx-panel-svg');
    await svg.scrollIntoViewIfNeeded();   // the unchecks above scrolled the panel off screen
    const box = await svg.boundingBox();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await expect(page.locator('#cx-cross')).toBeVisible();
    await expect(page.locator('#cx-readout .cx-ro')).not.toHaveCount(0);
    await expect(page.locator('#cx-readout')).toContainText('Daily high (ERA5)');
});

test('one dead feed is one red chip; the rest still draw', async ({ page }) => {
    const errors = await boot(page, { mocks: { archiveExpired: true } });
    const s = await state(page);
    expect(s.datasets.era5.state).toBe('down');
    expect(s.datasets.station.state).toBe('live');
    await expect(page.locator('[data-dataset="era5"] .cx-chip')).toHaveAttribute('data-state', 'down');
    await expect(page.locator('[data-dataset="era5"] .cx-ds-note').first()).toContainText('upstream HTTP 429');
    expect(s.panels.map((p) => p.id)).toContain('temp');
    await expect(page.locator('#cx-banner')).toBeHidden();
    expect(errors).toEqual([]);
});

test('our archive unpublished is one red chip that says why; the bootstrap is NOT substituted', async ({ page }) => {
    const errors = await boot(page, { mocks: { nwp: 'unpublished' } });
    const s = await state(page);
    expect(s.datasets.gfs.state).toBe('down');
    expect(s.datasets.gfs.series).toEqual([]);
    await expect(page.locator('[data-dataset="gfs"] .cx-chip')).toHaveAttribute('data-state', 'down');
    await expect(page.locator('[data-dataset="gfs"] .cx-ds-note').first()).toContainText('not published yet');
    await expect(page.locator('[data-dataset="gfs"] .cx-ds-note').first()).toContainText('Nothing is substituted');
    // The bootstrap forecast still draws AS ITSELF — never relabelled as ours.
    expect(s.datasets.station.state).toBe('live');
    const temp = s.panels.find((p) => p.id === 'temp');
    expect(temp.lines).toContain('station.tempC');
    expect(temp.lines).not.toContain('gfs.tempC');
    await expect(page.locator('#cx-banner')).toBeHidden();
    expect(errors).toEqual([]);
});

test('an old run is served but degraded, and the chip says so', async ({ page }) => {
    const errors = await boot(page, { mocks: { nwp: 'old' } });
    const s = await state(page);
    expect(s.datasets.gfs.state).toBe('stale');
    await expect(page.locator('[data-dataset="gfs"] .cx-chip')).toHaveAttribute('data-state', 'stale');
    await expect(page.locator('[data-dataset="gfs"] .cx-ds-note').first()).toContainText('older than the daily cadence');
    expect(s.panels.find((p) => p.id === 'temp').lines).toContain('gfs.tempC');
    expect(errors).toEqual([]);
});

test('a workspace saved before our archive existed gets its series once', async ({ page }) => {
    const v1 = { v: 1, range: '30d', on: ['era5.tmax', 'station.tempC', 'drivers.ao'], units: { preset: 'auto' }, historyFrom: 1991 };
    const errors = await boot(page, { ws: v1 });
    const s = await state(page);
    expect(s.workspace.on).toEqual(expect.arrayContaining(['era5.tmax', 'station.tempC', 'gfs.tempC', 'gfs.precipMm']));
    expect(s.workspace.on).not.toContain('era5.tmin');   // the user's own choice stands
    expect(s.panels.find((p) => p.id === 'temp').lines).toContain('gfs.tempC');
    expect(errors).toEqual([]);
});

test('NEGATIVE CONTROL: every feed down is an outage, and nothing is drawn', async ({ page }) => {
    const errors = await boot(page, { mocks: { down: 'all' } });
    const s = await state(page);
    expect(Object.values(s.datasets).every((d) => d.state === 'down')).toBe(true);
    await expect(page.locator('#cx-banner')).toBeVisible();
    await expect(page.locator('#cx-banner')).toContainText('outage, not a quiet day');
    await expect(page.locator('.cx-panel')).toHaveCount(0);
    await expect(page.locator('.cx-chip[data-state="down"]')).toHaveCount(5);
    expect(errors).toEqual([]);
});

test('visiting another place says so; Return home goes back to the account Home', async ({ page }) => {
    await boot(page, { account: BOULDER, path: '/climalytix.html?lat=35.68&lon=139.65&name=Tokyo' });
    await expect(page.locator('#cx-site-name')).toHaveText('Tokyo');
    await expect(page.locator('#cx-site-badge')).toHaveText('VISITING');
    const view = await page.evaluate(() => JSON.parse(localStorage.getItem('ppx_user_location')));
    expect(view.lat).toBeCloseTo(35.68, 2);   // one location store: the visit IS the current view
    await page.locator('#cx-home-btn').click();
    await expect(page.locator('#cx-site-name')).toHaveText('Boulder, CO');
    await expect(page.locator('#cx-site-badge')).toHaveText('HOME');
    await expect(page.locator('#cx-home-btn')).toBeHidden();
});

test('phone width has no horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
});
