/**
 * climalytix-terrain.spec.js — browser gate for the map's TERRAIN layers
 * (plan §19 T1: elevation contours + sun exposure).
 *
 * The DEM is mocked (tests/fixtures/climalytix-mocks.mjs) as a CLOSED-FORM
 * east–west ridge at 40°N: flat at 1500 m, rising to 3500 m at the crest over
 * 0.1° either side, so each flank is a plane of known slope (~10.2°) facing
 * due south or due north. Tiles are real Terrarium PNGs in Web-Mercator, so
 * the whole path — fetch, decode, Mercator → lat/lon resampling, Sobel slope,
 * aspect, the Sun — is exercised. What it pins:
 *   · height, slope and aspect at points on each flank and on flat ground
 *   · sun exposure: south flank > 1×, north flank < 1×, flat ground EXACTLY 1×,
 *     and "over today" equals the kernel's dailyRatio at the disclosed centre
 *   · contours at a round interval in the READER's unit (500 ft → 200 m)
 *   · Sun exposure joins the one-at-a-time fill group (Temperature off)
 *   · NEGATIVE CONTROL: DEM down ⇒ no grid, nothing drawn, the rail says so
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks, mockDem, MOCK_RIDGE, MOCK_RIDGE_SLOPE_DEG } from './fixtures/climalytix-mocks.mjs';
import { dailyRatio } from '../js/climalytix/terrain.js';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };

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
const demSettled = (page) => page.waitForFunction(() => {
    const d = window.__climalytix.state.map.dem;
    return d.state === 'ok' || d.state === 'down';
}, null, { timeout: 60_000 });
/**
 * Zoom in until the slope grid resolves the 0.1° flanks (the default 7.5°
 * view samples every ~8 km and honestly smooths a 22 km ridge — the rail
 * says so), then wait for the DEM at the new zoom.
 */
async function zoomToRidge(page) {
    const before = await page.evaluate(() => window.__climalytix.state.map.dem.resM);
    await page.evaluate(() => { for (let k = 0; k < 3; k++) window.__climalytix.map.act('zoom-in'); });
    await page.waitForFunction((r0) => {
        const d = window.__climalytix.state.map.dem;
        return d.state === 'ok' && d.resM != null && d.resM < Math.min(2500, r0 ?? Infinity);
    }, before, { timeout: 60_000 });
}
const at = (page, lat, lon) => page.evaluate(([a, b]) => window.__climalytix.map.terrainAt(a, b), [lat, lon]);

test('the ridge: height, slope and aspect on both flanks and on flat ground', async ({ page }) => {
    const errors = await boot(page);
    await expect(page.locator('#cx-layer-elev')).not.toBeChecked();
    await page.locator('#cx-layer-elev').check();
    await demSettled(page);
    expect((await page.evaluate(() => window.__climalytix.state.map.dem)).state).toBe('ok');
    await expect(page.locator('#cx-dem-status')).toContainText('slopes resolved every');
    await zoomToRidge(page);
    const s = await page.evaluate(() => window.__climalytix.state.map);
    const lon = -105.4;
    const south = await at(page, MOCK_RIDGE.lat - 0.05, lon);
    const north = await at(page, MOCK_RIDGE.lat + 0.05, lon);
    const flat = await at(page, MOCK_RIDGE.lat - 0.5, lon);
    // Height: bilinear on DEM pixels of a piecewise-linear surface — exact on the planes.
    expect(Math.abs(south.h - mockDem(MOCK_RIDGE.lat - 0.05)), JSON.stringify(south)).toBeLessThan(15);
    expect(Math.abs(flat.h - MOCK_RIDGE.base)).toBeLessThan(1);
    // Slope + aspect: the planes' own.
    expect(Math.abs(south.slope - MOCK_RIDGE_SLOPE_DEG), JSON.stringify(south)).toBeLessThan(0.6);
    expect(Math.abs(north.slope - MOCK_RIDGE_SLOPE_DEG), JSON.stringify(north)).toBeLessThan(0.6);
    expect(Math.abs(south.aspect - 180)).toBeLessThan(2);
    expect(Math.min(north.aspect, 360 - north.aspect)).toBeLessThan(2);
    expect(flat.slope).toBeLessThan(0.05);
    // Contours: 1500–3500 m in view. Auto units for en-US are feet ⇒ round 500 ft…
    expect(s.drawn.elevation.step).toBe(500);
    expect(s.drawn.elevation.lines).toBeGreaterThan(4);
    await expect(page.locator('#cx-dem-status')).toContainText('Contours every 500 ft');
    // …and a metric reader gets round metres: 200 m (negative control on the unit).
    await page.locator('#cx-units').selectOption('metric');
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.elevation.step === 200);
    await expect(page.locator('#cx-dem-status')).toContainText('Contours every 200 m');
    expect(errors).toEqual([]);
});

test('sun exposure: south flank > 1×, north flank < 1×, flat ground exactly 1×, and it replaces Temperature', async ({ page }) => {
    const errors = await boot(page);
    await page.locator('#cx-layer-exp').check();
    await demSettled(page);
    await zoomToRidge(page);
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.exposure);
    const s = await page.evaluate(() => window.__climalytix.state.map);
    await expect(page.locator('#cx-layer-temp')).not.toBeChecked();
    expect(s.drawn.heat).toBe(false);
    await expect(page.locator('#cx-exp-key')).toBeVisible();
    const lon = -105.4;
    const south = await at(page, MOCK_RIDGE.lat - 0.05, lon);
    const north = await at(page, MOCK_RIDGE.lat + 0.05, lon);
    const flat = await at(page, MOCK_RIDGE.lat - 0.5, lon);
    expect(south.ratio, JSON.stringify(south)).toBeGreaterThan(1);
    expect(north.ratio, JSON.stringify(north)).toBeLessThan(1);
    expect(Math.abs(flat.ratio - 1)).toBeLessThan(1e-3);
    // "Over today" is the kernel's daily ratio over the disclosed track.
    const tr = s.dem.track;
    expect(tr).not.toBe(null);
    const want = dailyRatio(south.slope, south.aspect, tr.lat, tr.lon, tr.dayStartMs);
    expect(Math.abs(south.ratio - want), `${south.ratio} vs ${want}`).toBeLessThan(0.01);
    // The hover tip names the slope and the ratio.
    await page.locator('#cx-map-canvas').scrollIntoViewIfNeeded();
    const box = await page.locator('#cx-map-canvas').boundingBox();
    await page.mouse.move(box.x + s.size.w / 2 - 60, box.y + s.size.h / 2 + 30);
    await expect(page.locator('#cx-map-tip')).toContainText('flat-ground sun today');
    // "At this time": night is blank, day is a ratio — either way never invented.
    await page.locator('#cx-exp-mode [data-exp="now"]').click();
    await page.waitForFunction(() => window.__climalytix.state.map.dem.mode === 'now');
    const now = await at(page, MOCK_RIDGE.lat - 0.05, lon);
    expect(now.ratio === null || now.ratio > 1, JSON.stringify(now)).toBe(true);
    // NEGATIVE CONTROL: Temperature back on takes exposure off.
    await page.locator('#cx-layer-temp').check();
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.heat);
    expect((await page.evaluate(() => window.__climalytix.state.map)).drawn.exposure).toBe(false);
    await expect(page.locator('#cx-layer-exp')).not.toBeChecked();
    expect(errors).toEqual([]);
});

test('NEGATIVE CONTROL: DEM down ⇒ no terrain is drawn and the rail says why', async ({ page }) => {
    const errors = await boot(page, { dem: 'down' });
    await page.locator('#cx-layer-elev').check();
    await page.locator('#cx-layer-exp').check();
    await demSettled(page);
    const s = await page.evaluate(() => window.__climalytix.state.map);
    expect(s.dem.state).toBe('down');
    expect(s.drawn.exposure).toBe(false);
    expect(s.drawn.elevation.lines).toBe(0);
    expect(await at(page, 39.95, -105.4)).toBe(null);
    await expect(page.locator('#cx-dem-status')).toContainText('Elevation tiles unavailable');
    expect(errors).toEqual([]);
});
