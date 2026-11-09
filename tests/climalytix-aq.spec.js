/**
 * climalytix-aq.spec.js — browser gate for the map's AIR-QUALITY layer.
 *
 * Every feed is mocked (tests/fixtures/climalytix-mocks.mjs) with CLOSED
 * FORMS: `mockPm25` is linear in space (so bilinear on the 0.5° nodes
 * reproduces it exactly) and dirty when the mock site wind blows from the
 * north; mock monitors read MOCK_MONITOR_EXCESS above the model at their
 * own hour. What it pins:
 *   · Air quality and Temperature are one-at-a-time; the layer is badged
 *     Bootstrap; the hover value is the closed form at the tip's own
 *     coordinates and instant
 *   · monitors are compared with the model: the bias is the closed form's,
 *     computed here from the monitor hour and the field instant
 *   · the pollution rose: dirtiest air from the NORTH half, cleanest from the
 *     SOUTH half — NEGATIVE CONTROL: the wind-speed rose names no dirtiest
 *   · field down ⇒ no field, the rail says why; monitors down ⇒ the field
 *     still draws and the rail says the monitors are unavailable
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks, mockPm25, MOCK_MONITOR_EXCESS } from './fixtures/climalytix-mocks.mjs';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const H = 3_600_000;

test.describe.configure({ timeout: 90_000 });
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
    await page.waitForFunction(() => {
        const s = window.__climalytix?.state;
        return s?.map && s.aq && s.aq.state !== 'loading' && s.map.drawn.heat;
    }, null, { timeout: 60_000 });
    await page.evaluate(() => document.querySelectorAll('.pp-consent-banner,.tour-overlay,.tour-tooltip').forEach((e) => e.remove()));
    return errors;
}
const mapState = (page) => page.evaluate(() => window.__climalytix.state.map);

test('Air quality replaces Temperature, is badged Bootstrap, and hovers the closed-form PM2.5', async ({ page }) => {
    const errors = await boot(page);
    await expect(page.locator('#cx-layer-aq')).not.toBeChecked();
    await expect(page.locator('label:has(#cx-layer-aq) .cx-layer-src')).toHaveText('Bootstrap');
    await page.locator('#cx-layer-aq').check();
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.aq);
    let s = await mapState(page);
    await expect(page.locator('#cx-layer-temp')).not.toBeChecked();
    expect(s.drawn.heat).toBe(false);
    expect(s.layers.temperature).toBe(false);
    await expect(page.locator('#cx-aq-key')).toBeVisible();
    // Hover: the value is the closed form at the tip's coordinates and the field instant.
    await page.locator('#cx-layer-mon').uncheck();                      // keep monitors out from under the cursor
    const box = await page.locator('#cx-map-canvas').boundingBox();
    await page.mouse.move(box.x + s.size.w / 2 - 50, box.y + s.size.h / 2 + 40);
    await expect(page.locator('#cx-map-tip')).toContainText('PM2.5');
    const tip = await page.locator('#cx-map-tip').innerText();
    const [, pm] = /PM2\.5 ([\d.]+) µg\/m³/.exec(tip);
    const [, la, ns, lo, ew] = /([\d.]+)°([NS])\s([\d.]+)°([EW])/.exec(tip);
    s = await mapState(page);
    const want = mockPm25((ns === 'N' ? 1 : -1) * +la, (ew === 'E' ? 1 : -1) * +lo, s.aq.timeMs, BOULDER);
    expect(Math.abs(+pm - want), `${tip} vs ${want}`).toBeLessThan(0.06);       // 2-dp coords on the tip
    // NEGATIVE CONTROL: Temperature back on takes Air quality off.
    await page.locator('#cx-layer-temp').check();
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.heat);
    s = await mapState(page);
    expect(s.drawn.aq).toBe(false);
    await expect(page.locator('#cx-layer-aq')).not.toBeChecked();
    expect(errors).toEqual([]);
});

test('monitors vs the model: the bias is the closed form’s', async ({ page }) => {
    const errors = await boot(page);
    await page.locator('#cx-layer-aq').check();
    await page.waitForFunction(() => { const m = window.__climalytix.state.map; return m.aq.compared === 6 && m.drawn.monitors.n === 6; }, null, { timeout: 20_000 });
    const { aq, drawn } = await mapState(page);
    expect(drawn.monitors.n).toBe(6);
    // The same six offsets the fixture plants, measured at the monitor hour;
    // the model is the field at the 3-hourly instant NEAREST THAT READING
    // (aq-field.js residuals) — not the instant the map displays, which can sit
    // 2 h away from the monitor hour (the test used to fail at e.g. 10:51 UTC).
    const modelMs = Math.round(aq.monitorsAt / (3 * H)) * 3 * H;
    const offsets = [[0.3, 0.4], [-0.6, 0.2], [1.1, -0.9], [-1.4, -1.2], [0.8, 1.6], [-0.2, -2.1]];
    const site = { lat: 40.02, lon: -105.27 };                        // the page's 0.01° site
    const diffs = offsets.map(([a, b]) => {
        const lat = site.lat + a, lon = site.lon + b;
        const obs = +(mockPm25(lat, lon, aq.monitorsAt, site) + MOCK_MONITOR_EXCESS).toFixed(3);
        return mockPm25(lat, lon, modelMs, site) - obs;
    });
    const bias = Math.round(diffs.reduce((x, y) => x + y, 0) / 6 * 10) / 10;
    expect(Math.abs(aq.bias - bias), `page ${aq.bias} vs closed form ${bias}`).toBeLessThanOrEqual(0.1);
    expect(Math.abs(modelMs - aq.monitorsAt)).toBeLessThanOrEqual(1.5 * H);
    expect(aq.monitorsAt).toBeLessThanOrEqual(Date.now());
    await expect(page.locator('#cx-aq-status')).toContainText('6 monitors vs the model');
    expect(errors).toEqual([]);
});

test('the pollution rose: dirtiest from the north half, cleanest from the south — NEGATIVE CONTROL: the wind rose names none', async ({ page }) => {
    const errors = await boot(page);
    await page.waitForFunction(() => window.__climalytix.state.rose && !document.querySelector('#cx-rose-mode [data-rose="pm25"]').disabled);
    let rose = await page.evaluate(() => window.__climalytix.state.rose);
    expect(rose.mode).toBe('wind');
    expect(rose.dirtiest).toBe(null);
    await page.locator('#cx-rose-mode [data-rose="pm25"]').click();
    await page.waitForFunction(() => window.__climalytix.state.rose?.mode === 'pm25');
    rose = await page.evaluate(() => window.__climalytix.state.rose);
    const northHalf = (sec) => sec >= 12 || sec <= 4;                 // WNW … ENE
    const southHalf = (sec) => sec >= 4 && sec <= 12;
    expect(northHalf(rose.dirtiest.sector), JSON.stringify(rose.dirtiest)).toBe(true);
    expect(southHalf(rose.cleanest.sector), JSON.stringify(rose.cleanest)).toBe(true);
    expect(rose.dirtiest.mean).toBeGreaterThan(rose.cleanest.mean + 3);
    await expect(page.locator('#cx-rose-caption')).toContainText(`dirtiest air arrives from the ${rose.dirtiest.name}`);
    expect(errors).toEqual([]);
});

test('field down: no field and the rail says why; monitors down: the field still draws', async ({ page }) => {
    let errors = await boot(page, { aq: 'down' });
    await page.locator('#cx-layer-aq').check();
    await expect(page.locator('#cx-aq-status')).toContainText('No air-quality field');
    await expect(page.locator('#cx-aq-status')).toContainText('Nothing stands in for it');
    expect((await mapState(page)).drawn.aq).toBe(false);
    await expect(page.locator('#cx-rose-mode [data-rose="pm25"]')).toBeDisabled();
    expect(errors).toEqual([]);

    errors = await boot(page, { monitors: 'down' });
    await page.locator('#cx-layer-aq').check();
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.aq);
    await expect(page.locator('#cx-aq-status')).toContainText('Monitors unavailable');
    expect((await mapState(page)).drawn.monitors.n).toBe(0);
    expect(errors).toEqual([]);
});
