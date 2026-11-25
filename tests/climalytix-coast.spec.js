/**
 * climalytix-coast.spec.js — browser gate for the Coast card on
 * climalytix.html (js/climalytix/coast-view.js over coast.js +
 * marine-request.js). The physics is node-gated (tests/climalytix-coast.mjs);
 * this proves the page reads the right inputs and says what it knows.
 *
 * The shoreline is a closed-form straight coast served as real Terrarium
 * tiles (land east of 122.05° W, so the coast FACES WEST); the sea is a
 * closed-form sea state with a one-constituent tide, built by the REAL route
 * normaliser — so every number on the card has an exact expected value.
 *
 *   · a coastal site gets the card: where the shore is, which way it faces,
 *     waves, sea temperature, breaking, the wind against the shore, the tide
 *   · NEGATIVE CONTROL: an inland site gets NO card — even if a marine feed
 *     answers for it
 *   · feeds fail independently and the card says which; nothing is substituted
 *   · moving the site inland takes the card away
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks, MOCK_COAST, mockCoastDem, MOCK_TIDE, MOCK_SEA } from './fixtures/climalytix-mocks.mjs';

const COAST_PATH = `/climalytix.html?lat=${MOCK_COAST.site.lat}&lon=${MOCK_COAST.site.lon}&name=Coast%20Town`;
const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };

test.describe.configure({ timeout: 120_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Los_Angeles', reducedMotion: 'reduce' });

async function boot(page, { mocks = {}, path = COAST_PATH } = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    await installClimalytixMocks(page, { marine: 'up', demHeight: mockCoastDem, ...mocks });
    await page.addInitScript((device) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('ppx_user_location', JSON.stringify(device));
        localStorage.setItem('pp_auth', JSON.stringify({ signedIn: false, location: device }));
    }, BOULDER);
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__climalytix && window.__climalytix.state.loading.length === 0
        && Object.keys(window.__climalytix.state.datasets).length === 5, null, { timeout: 60_000 });
    await page.waitForFunction(() => { const c = window.__climalytix.state.coast; return c && c.shoreState !== 'loading' && c.marineState !== 'loading'; }, null, { timeout: 60_000 });
    return errors;
}
const coast = (page) => page.evaluate(() => window.__climalytix.state.coast);
const card = (page) => page.locator('#cx-coast');

test('a coastal site gets the card: the shore, the sea, how it breaks, the wind and the tide', async ({ page }) => {
    const errors = await boot(page);
    await expect(card(page)).toBeVisible();
    const c = await coast(page);
    expect(c.visible).toBe(true);
    expect(c.shoreState).toBe('coastal');
    // 0.05° of longitude at 36.95° N is 4.44 km; the coast faces west.
    expect(Math.abs(c.shore.distanceKm - 4.44)).toBeLessThan(c.shore.resKm);
    expect(Math.abs(c.shore.normalDeg - 270)).toBeLessThan(3);
    expect(c.shore.onWater).toBe(false);
    await expect(card(page).locator('[data-co="shore"]').first()).toContainText('from the shore, to the W');
    await expect(card(page).locator('[data-co="shore"]').first()).toContainText(/the coast here faces W \(2(6[89]|7[0-2])°\)/);
    await expect(card(page).locator('.cx-role')).toHaveText('Bootstrap');

    // The sea: the fixture's numbers, in the reader's units (en-US ⇒ feet, °F).
    expect(c.now.waveM).toBeCloseTo(MOCK_SEA.waveM, 6);
    await expect(card(page).locator('[data-co="wave"] b')).toHaveText('4.9 ft');            // 1.5 m
    await expect(card(page).locator('[data-co="wave"] small')).toContainText('10 s · from W (270°) · moderate');
    await expect(card(page).locator('[data-co="swell"] b')).toHaveText('3.9 ft');           // 1.2 m
    await expect(card(page).locator('[data-co="sst"] b')).toHaveText('57 °F');              // 14 °C
    await expect(card(page).locator('[data-co="power"] b')).toHaveText('11 kW/m');          // ρ g² H² T / 64π = 11.03
    // Breaking and run-up are RANGES over beach slope, and say so.
    await expect(card(page).locator('[data-co="breaker"]')).toContainText('across beach slopes of 1:50 to 1:10');
    await expect(card(page).locator('[data-co="breaker"]')).toContainText(/spilling|plunging/);
    await expect(card(page).locator('[data-co="runup"]')).toContainText(/about [\d.]+.ft to [\d.]+.ft/);
    // A wave from due west on a west-facing coast is head-on; the mock wind is westerly ⇒ onshore.
    await expect(card(page).locator('[data-co="angle"]')).toContainText('almost head-on');
    await expect(card(page).locator('[data-co="wind"]')).toContainText('onshore');

    // The tide: the next high and low are the closed form's, to minutes.
    const now = Date.now();
    const half = MOCK_TIDE.periodMs / 2;
    const nextOf = (even) => { let n = Math.ceil((now - MOCK_TIDE.tHighMs) / half); if ((Math.abs(n) % 2 === 0) !== even) n++; return MOCK_TIDE.tHighMs + n * half; };
    expect(Math.abs(c.tide.nextHigh.t - nextOf(true))).toBeLessThan(5 * 60_000);
    expect(Math.abs(c.tide.nextLow.t - nextOf(false))).toBeLessThan(5 * 60_000);
    expect(c.tide.nextHigh.level).toBeCloseTo(MOCK_TIDE.ampM, 2);
    expect(c.tide.range).toBeCloseTo(2 * MOCK_TIDE.ampM, 1);
    await expect(card(page).locator('[data-co="tide"] .cx-co-lead')).toContainText(/Sea level is .* and (rising|falling) — next (high|low) water/);
    await expect(card(page).locator('[data-co="tide"] .cx-co-lead')).toContainText('Times are local to the site');
    await expect(card(page).locator('svg.cx-co-tide path.cx-co-line')).toHaveCount(1);
    expect(await card(page).locator('svg.cx-co-tide .cx-co-ex').count()).toBeGreaterThanOrEqual(6);   // 48 h of a 12.4 h tide
    await expect(card(page).locator('svg.cx-co-tide .cx-co-now')).toHaveCount(1);
    // What it is not.
    await expect(card(page).locator('[data-co="source"]')).toContainText('not a measurement at the beach and not a tide gauge');
    await expect(card(page).locator('[data-co="source"]')).toContainText('not a safety forecast');

    // Units follow the page.
    await page.locator('#cx-units').selectOption('metric');
    await expect(card(page).locator('[data-co="wave"] b')).toHaveText('1.5 m');
    await expect(card(page).locator('[data-co="sst"] b')).toHaveText('14.0 °C');
    expect(errors).toEqual([]);
});

test('NEGATIVE CONTROL: an inland site gets no Coast card — even when a marine feed answers', async ({ page }) => {
    const errors = await boot(page, { path: '/climalytix.html', mocks: { demHeight: undefined, marine: 'up' } });
    const c = await coast(page);
    expect(c.shoreState).toBe('inland');
    expect(c.marineState).toBe('ok');                       // the feed DID answer…
    expect(c.visible).toBe(false);                          // …and the elevation still says there is no shore here
    await expect(card(page)).toBeHidden();
    expect(errors).toEqual([]);
});

test('no sea in the wave model: the shore is still described, the sea state says why, nothing is substituted', async ({ page }) => {
    await boot(page, { mocks: { marine: 'none' } });
    await expect(card(page)).toBeVisible();
    await expect(card(page).locator('[data-co="shore"]').first()).toContainText('the coast here faces W');
    await expect(card(page).locator('[data-co="sea"]')).toContainText('the wave model has no sea cell here');
    await expect(card(page).locator('[data-co="sea"]')).toContainText('Nothing is substituted');
    await expect(card(page).locator('.cx-co-tile')).toHaveCount(0);
    await expect(card(page).locator('svg.cx-co-tide')).toHaveCount(0);
    expect((await coast(page)).now).toBeNull();
});

test('marine feed down (503): same honesty, different reason', async ({ page }) => {
    await boot(page, { mocks: { marine: 'down' } });
    await expect(card(page).locator('[data-co="sea"]')).toContainText('the marine feed is unreachable right now');
    await expect(card(page).locator('.cx-co-tile')).toHaveCount(0);
});

test('elevation down: the sea state is shown, and nothing that needs the shore’s direction is', async ({ page }) => {
    await boot(page, { mocks: { dem: 'down' } });
    const c = await coast(page);
    expect(c.shoreState).toBe('down');
    expect(c.visible).toBe(true);                           // a sea cell right here is the evidence of a coast
    await expect(card(page).locator('[data-co="shore"]')).toContainText('Elevation tiles unavailable');
    await expect(card(page).locator('[data-co="wave"] b')).toHaveText('4.9 ft');
    await expect(card(page).locator('[data-co="breaker"]')).toHaveCount(1);     // needs only the wave
    await expect(card(page).locator('[data-co="angle"]')).toHaveCount(0);       // needs the shore's facing
    await expect(card(page).locator('[data-co="wind"]')).toHaveCount(0);
    await expect(card(page)).not.toContainText('faces');
});

test('a model with no sea level shows no tide — and lists what was not provided', async ({ page }) => {
    await boot(page, { mocks: { marine: 'nolevel' } });
    await expect(card(page).locator('[data-co="tide"]')).toContainText('the tide is not shown');
    await expect(card(page).locator('svg.cx-co-tide')).toHaveCount(0);
    await expect(card(page).locator('[data-co="source"]')).toContainText('Not provided by the model here: seaLevelM');
    await expect(card(page).locator('[data-co="wave"] b')).toHaveText('4.9 ft');
    expect((await coast(page)).tide).toBeNull();
});

test('moving the site inland takes the card away; coming back brings it back', async ({ page }) => {
    // One elevation model for both places: sea west of 122.05° W, land everywhere east of it.
    await boot(page);
    await expect(card(page)).toBeVisible();
    await page.locator('#cx-search').fill('denv');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.locator('#cx-site-name')).toHaveText('Denver');
    await expect.poll(async () => (await coast(page)).shoreState, { timeout: 30_000 }).toBe('inland');
    await expect(card(page)).toBeHidden();
    await page.locator('.cx-place[data-kind="recent"] .cx-pl-go', { hasText: 'Coast Town' }).click();
    await expect.poll(async () => (await coast(page)).shoreState, { timeout: 30_000 }).toBe('coastal');
    await expect(card(page)).toBeVisible();
});

test('phone: the card fits, tiles stack, the tide chart scales', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page);
    await card(page).scrollIntoViewIfNeeded();
    const box = await card(page).boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    const svg = await card(page).locator('svg.cx-co-tide').boundingBox();
    expect(svg.x + svg.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});
