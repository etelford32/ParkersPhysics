/**
 * climalytix-orographic.spec.js — browser gate for the map's OROGRAPHIC LIFT
 * layer (plan §19 T2: w = u·∂h/∂x + v·∂h/∂y at the surface).
 *
 * The DEM is the closed-form east–west ridge at 40°N (MOCK_RIDGE: each flank
 * a plane of known slope facing due south / due north) and the GFS 10 m wind
 * is mocked UNIFORM, so w on each flank is a number:
 *   · a SOUTH wind (v = +8) climbs the south flank: w = +8·tan(s) there and
 *     −8·tan(s) on the north flank; flat ground 0; the rail names the
 *     strongest ascent on the south side and descent on the north side; the
 *     hover says "windward, forced up"
 *   · REVERSED (v = −8) the signs flip
 *   · NEGATIVE CONTROL: a WEST wind runs along the ridge's contours ⇒ no
 *     lift anywhere, and the rail says none
 *   · lift joins the one-at-a-time fills (Temperature goes off)
 *   · no wind field ⇒ nothing drawn, and the rail says why
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks, MOCK_RIDGE, MOCK_RIDGE_SLOPE_DEG } from './fixtures/climalytix-mocks.mjs';
import { geoToPx } from '../js/climalytix/map-view.js';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const TAN = Math.tan(MOCK_RIDGE_SLOPE_DEG * Math.PI / 180);

test.describe.configure({ timeout: 120_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });

async function boot(page, mocks = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    await installClimalytixMocks(page, mocks);
    await page.addInitScript((device) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('ppx_user_location', JSON.stringify(device));
        localStorage.setItem('ppx_tour_completed', '1');
    }, BOULDER);
    await page.goto('/climalytix.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__climalytix?.state?.map?.drawn?.heat, null, { timeout: 60_000 });
    await page.evaluate(() => document.querySelectorAll('.pp-consent-banner,.tour-overlay,.tour-tooltip').forEach((e) => e.remove()));
    return errors;
}

/** Turn lift on, zoom until the slope grid resolves the 0.1° flanks, wait for the fill. */
async function liftOn(page) {
    await page.locator('#cx-layer-oro').check();
    await page.waitForFunction(() => window.__climalytix.state.map.dem.state === 'ok', null, { timeout: 60_000 });
    await page.evaluate(() => { for (let k = 0; k < 3; k++) window.__climalytix.map.act('zoom-in'); });
    await page.waitForFunction(() => {
        const m = window.__climalytix.state.map;
        return m.dem.state === 'ok' && m.dem.resM != null && m.dem.resM < 2500 && m.orographic.state === 'ok';
    }, null, { timeout: 60_000 });
}
const at = (page, lat, lon) => page.evaluate(([a, b]) => window.__climalytix.map.terrainAt(a, b), [lat, lon]);
const LON = -105.4;

test('a south wind lifts the south flank and sinks the north flank by u·∂h/∂x + v·∂h/∂y', async ({ page }) => {
    const errors = await boot(page, { windFn: () => ({ u: 0, v: 8 }) });
    await liftOn(page);
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.orographic);
    const s = await page.evaluate(() => window.__climalytix.state.map);
    await expect(page.locator('#cx-layer-temp')).not.toBeChecked();
    expect(s.drawn.heat).toBe(false);
    await expect(page.locator('#cx-oro-key')).toBeVisible();
    const south = await at(page, MOCK_RIDGE.lat - 0.05, LON);
    const north = await at(page, MOCK_RIDGE.lat + 0.05, LON);
    const flat = await at(page, MOCK_RIDGE.lat - 0.5, LON);
    const want = 8 * TAN;
    expect(Math.abs(south.w - want), JSON.stringify(south)).toBeLessThan(0.1);
    expect(Math.abs(north.w + want), JSON.stringify(north)).toBeLessThan(0.1);
    expect(Math.abs(flat.w)).toBeLessThan(0.01);
    // The rail: the strongest ascent sits on the south flank, the strongest descent on the north.
    const o = s.orographic;
    expect(o.up.lat).toBeLessThan(MOCK_RIDGE.lat);
    expect(o.down.lat).toBeGreaterThan(MOCK_RIDGE.lat);
    expect(Math.abs(o.up.w - want)).toBeLessThan(0.15);
    await expect(page.locator('#cx-oro-status')).toContainText('Strongest forced ascent in view: +1.');
    // Hover over the south flank names the windward side (a ft reader also gets ft/min).
    await page.locator('#cx-map-canvas').scrollIntoViewIfNeeded();
    const box = await page.locator('#cx-map-canvas').boundingBox();
    const p = geoToPx(s.view, s.size.w, s.size.h, MOCK_RIDGE.lat - 0.05, LON);
    await page.mouse.move(box.x + p.x, box.y + p.y);
    await expect(page.locator('#cx-map-tip')).toContainText('windward, forced up');
    await expect(page.locator('#cx-map-tip')).toContainText('ft/min');
    expect(errors).toEqual([]);
});

test('reversing the wind flips the sign', async ({ page }) => {
    const errors = await boot(page, { windFn: () => ({ u: 0, v: -8 }) });
    await liftOn(page);
    const south = await at(page, MOCK_RIDGE.lat - 0.05, LON);
    const north = await at(page, MOCK_RIDGE.lat + 0.05, LON);
    expect(Math.abs(south.w + 8 * TAN), JSON.stringify(south)).toBeLessThan(0.1);
    expect(Math.abs(north.w - 8 * TAN), JSON.stringify(north)).toBeLessThan(0.1);
    expect(errors).toEqual([]);
});

test('NEGATIVE CONTROL: a west wind runs along the contours — no lift anywhere', async ({ page }) => {
    const errors = await boot(page, { windFn: () => ({ u: 8, v: 0 }) });
    await liftOn(page);
    const south = await at(page, MOCK_RIDGE.lat - 0.05, LON);
    expect(south.slope).toBeGreaterThan(9);                 // the slope is there…
    expect(Math.abs(south.w)).toBeLessThan(0.01);           // …the wind just does not climb it
    const o = (await page.evaluate(() => window.__climalytix.state.map)).orographic;
    expect(o.up === null || o.up.w < 0.02, JSON.stringify(o)).toBe(true);
    expect(errors).toEqual([]);
});

test('no wind field: nothing is drawn and the rail says why', async ({ page }) => {
    const errors = await boot(page, { nwp: 'nowind' });
    await page.locator('#cx-layer-oro').check();
    await expect(page.locator('#cx-oro-status')).toContainText('No wind field');
    await expect(page.locator('#cx-oro-status')).toContainText('Nothing stands in for it');
    expect((await page.evaluate(() => window.__climalytix.state.map)).drawn.orographic).toBe(false);
    expect(errors).toEqual([]);
});
