/**
 * dashboard-climate-lab.spec.js — browser gate for the dashboard's Climate Lab.
 * ═══════════════════════════════════════════════════════════════════════════
 * Runs dashboard.html in DEMO mode (no account needed) with every external
 * feed served from tests/fixtures/climate-lab-fixtures.mjs via
 * climate-lab-mocks.mjs — CI has no outbound network, and the fixture's
 * values are closed-form, so a number on screen can be checked exactly.
 *
 * What it pins (each was either the point of the feature or a bug found
 * while building it):
 *   · boot: no uncaught exception anywhere on the page (the dashboard is one
 *     big module — a single throw kills every card after it)
 *   · HOME IS THE DEFAULT VIEW: a stale device location re-opens at the
 *     account's Home; `openAt: 'last'` opts out and shows "Visiting"
 *   · visiting a searched place keeps Home, and "Return home" restores it
 *   · the instruments read the fixture (falling barometer, 3 × 2 mm of rain)
 *   · customisation (units, hidden instruments) re-renders and persists
 *   · the meteogram probe reads every series at one hour; table view exists
 *   · satellite passes are PHYSICAL (≤ 15 min for LEO) and the sky chart is
 *     an arc — the committed SGP4 WASM produced 49-minute ISS passes and a
 *     sky chart collapsed to one point before the tracker was moved to the
 *     Kepler + J2 propagator (js/climate-lab/lab-satellites.js header)
 *   · a lab watch triggers on the fixture's gusts
 *   · phone width: no horizontal scroll
 */

import { test, expect } from '@playwright/test';
import { installLabMocks } from './fixtures/climate-lab-mocks.mjs';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const TOKYO = { lat: 35.6762, lon: 139.6503, city: 'Tokyo' };

test.describe.configure({ timeout: 120_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', reducedMotion: 'reduce' });

async function boot(page, { device = BOULDER, account = null, prefs = null } = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    await installLabMocks(page);
    await page.addInitScript(({ device, account, prefs }) => {
        sessionStorage.setItem('pp_demo_mode', '1');
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('pp_tour_completed', '1');
        if (device) localStorage.setItem('ppx_user_location', JSON.stringify(device));
        // The pp_auth mirror is where an ACCOUNT home is read from before the
        // live profile arrives (lab-home.js accountHome); signedIn stays false
        // so the page remains in demo mode.
        if (account) localStorage.setItem('pp_auth', JSON.stringify({ signedIn: false, location: account }));
        if (prefs) localStorage.setItem('pp_climate_lab_v1', JSON.stringify(prefs));
    }, { device, account, prefs });
    await page.goto('/dashboard.html', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#location-card .cl-hero-value')).toBeVisible({ timeout: 45_000 });
    return errors;
}

test('the Climate Lab boots cleanly and every module renders', async ({ page }) => {
    const errors = await boot(page);
    await expect(page.locator('#location-card .cl-station-name')).toContainText('Boulder, CO');
    await expect(page.locator('#location-card .cl-badge-home')).toBeVisible();
    await expect(page.locator('#cl-bench-card .cl-tile:not(.is-empty)')).toHaveCount(11);   // 13 instruments, 2 hidden by default
    await expect(page.locator('#cl-meteogram-card svg.cl-mg')).toBeVisible();
    await expect(page.locator('#cl-climate-card .cl-climate-head')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#alert-console-card .cl-watch')).toHaveCount(2);
    await expect(page.locator('#cl-sat-card .cl-sat-name').first()).toContainText('ISS', { timeout: 30_000 });
    await expect(page.locator('#cl-rail a')).toHaveCount(5);
    expect(await page.locator('.card-load-error').count(), 'no card fell back to its Retry box').toBe(0);
    expect(errors, errors.join('\n')).toEqual([]);
});

test('instruments read the station exactly (falling barometer, 3 × 2 mm of rain)', async ({ page }) => {
    await boot(page);
    const baro = page.locator('.cl-tile[data-inst="baro"]');
    await expect(baro.locator('.cl-chip')).toContainText('Falling');
    const rain = page.locator('.cl-tile[data-inst="rain"]');
    await expect(rain.locator('.cl-tile-value')).toHaveText('0.24');          // 6 mm in inches
    await expect(rain.locator('.cl-chip')).toContainText('Rain very likely');
    await expect(page.locator('.cl-tile[data-inst="anemo"] .cl-chip')).toContainText('Force 3');
    await expect(page.locator('.cl-tile[data-inst="anemo"]')).toContainText('Veering');
});

test('customising units and the bench re-renders and persists', async ({ page }) => {
    await boot(page);
    await page.locator('[data-role="customize-btn"]').click();
    await page.locator('[data-role="preset"]').selectOption('metric');
    await expect(page.locator('#location-card .cl-hero-unit')).toHaveText('°C');
    await expect(page.locator('.cl-tile[data-inst="rain"] .cl-tile-unit')).toHaveText('mm');
    await page.locator('[data-inst-toggle="psychro"]').uncheck();
    await expect(page.locator('.cl-tile[data-inst="psychro"]')).toHaveCount(0);
    await page.locator('[data-inst-toggle="soil"]').check();
    await expect(page.locator('.cl-tile[data-inst="soil"]')).toBeVisible();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('pp_climate_lab_v1')));
    expect(stored.units.preset).toBe('metric');
    expect(stored.bench.hidden).toContain('psychro');
    expect(stored.bench.hidden).not.toContain('soil');
});

test('HOME IS THE DEFAULT VIEW: a stale device location reopens at the account home', async ({ page }) => {
    await boot(page, { device: TOKYO, account: BOULDER });
    await expect(page.locator('#location-card .cl-station-name')).toContainText('Boulder, CO');
    await expect(page.locator('#location-card .cl-badge-home')).toBeVisible();
    const view = await page.evaluate(() => JSON.parse(localStorage.getItem('ppx_user_location')));
    expect(Math.abs(view.lat - BOULDER.lat)).toBeLessThan(0.01);
});

test('openAt "last" keeps the last place and says it is a visit', async ({ page }) => {
    await boot(page, { device: TOKYO, account: BOULDER, prefs: { v: 1, openAt: 'last' } });
    await expect(page.locator('#location-card .cl-station-name')).toContainText('Tokyo');
    await expect(page.locator('#location-card .cl-badge-visit')).toBeVisible();
    await expect(page.locator('[data-act="go-home"]')).toBeVisible();
});

test('visiting a searched place keeps Home; Return home restores it', async ({ page }) => {
    await boot(page);
    await page.locator('#cl-station-search').fill('Tokyo');
    await page.locator('#cl-station-search').press('Enter');
    await expect(page.locator('#location-card .cl-badge-visit')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#location-card .cl-station-name')).toContainText('Tokyo');
    await expect(page.locator('#location-card .cl-visit-bar')).toContainText('Boulder, CO');
    await page.locator('[data-act="go-home"]').click();
    await expect(page.locator('#location-card .cl-badge-home')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#location-card .cl-station-name')).toContainText('Boulder, CO');
});

test('the meteogram probe reads every series at one hour; table view lists the hours', async ({ page }) => {
    await boot(page);
    const svg = page.locator('#cl-meteogram-card svg.cl-mg');
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
    const probe = page.locator('#cl-meteogram-card [data-role="probe"]');
    await expect(probe).toContainText('dew');
    await expect(probe).toContainText('gust');
    await expect(probe).toContainText('forecast');
    await page.locator('[data-role="mg-table-btn"]').click();
    expect(await page.locator('#cl-meteogram-card table.cl-table tbody tr').count()).toBeGreaterThan(40);
});

test('satellite passes over home are physical and the sky chart is an arc', async ({ page }) => {
    await boot(page);
    const rows = page.locator('#cl-sat-card .cl-pass-table tbody tr');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    // The first pass search runs BEFORE satellite-tracker.js's SGP4 WASM has
    // finished loading, so at that moment tracker.propagate IS the JS path and
    // a regression back to it would pass unseen (measured: this test passed
    // with PROPAGATOR = 'sgp4-wasm' until this block existed). Wait for the
    // WASM, re-run the search, and judge the passes it produces.
    await expect.poll(() => page.evaluate(async () => (await import('/js/satellite-tracker.js')).isWasmLoaded()),
        { timeout: 30_000, message: 'SGP4 WASM never loaded' }).toBe(true);
    await page.evaluate(() => window.__labSats.recompute());
    await expect(rows.first()).toBeVisible();
    const minutes = await rows.locator('td:nth-child(2)').allTextContents();
    expect(minutes.length).toBeGreaterThan(2);
    for (const m of minutes) {
        const n = Number.parseInt(m, 10);
        expect(n, `pass lasting "${m}"`).toBeGreaterThan(0);
        expect(n, `a LEO pass cannot last "${m}"`).toBeLessThanOrEqual(15);
    }
    const d = await page.locator('#cl-sat-card .cl-dome-track').getAttribute('d');
    const pts = (d.match(/[ML]([\d.]+),([\d.]+)/g) || []);
    expect(pts.length).toBeGreaterThan(10);
    expect(new Set(pts).size, 'the arc is not collapsed to one point').toBeGreaterThan(10);
    await expect(page.locator('#cl-sat-card .cl-sat-stats').first()).toContainText('km/s');
});

test('a lab watch triggers on the fixture’s gusts', async ({ page }) => {
    await boot(page);
    const gust = page.locator('#alert-console-card .cl-watch').filter({ hasText: 'Wind gusts above' });
    await gust.locator('[data-w="threshold"]').fill('15');          // mph; the fixture gusts 9 m/s ≈ 20 mph
    await gust.locator('[data-w="threshold"]').press('Enter');
    await gust.locator('.cl-switch').click();
    await expect(page.locator('#alert-console-card .cl-watch').filter({ hasText: 'Wind gusts above' }).locator('.cl-chip'))
        .toContainText('Triggered', { timeout: 20_000 });
    await expect(page.locator('#alert-console-card [data-role="summary"]')).toContainText('1 triggered');
});

test.describe('phone width', () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test('no horizontal scroll and the station stacks', async ({ page }) => {
        const errors = await boot(page);
        await expect(page.locator('#cl-sat-card .cl-sat-name').first()).toContainText('ISS', { timeout: 30_000 });
        const overflow = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
        expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1);
        expect(errors).toEqual([]);
    });
});
