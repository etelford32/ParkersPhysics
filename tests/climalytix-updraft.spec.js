/**
 * climalytix-updraft.spec.js — browser gate for the map's UPDRAFT layer
 * (plan §19 T5: GFS DZDT by pressure level + the vertical-motion list).
 *
 * The mock w is linear in lat, lon AND time (`mockUpdraft`), and the mock
 * surface pressure is 816–864 hPa (`mockThermal`), so 850 hPa is BELOW THE
 * GROUND across the whole window — the Rockies case this layer must handle.
 *   · 700 hPa: the site value is the closed form interpolated to the instant;
 *     its height above the ground is the kernel's hypsometric estimate; the
 *     fill draws; Updraft takes over the fill group
 *   · 850 hPa: every node is masked, NOTHING is drawn and the rail says the
 *     level is underground — NEGATIVE CONTROL (in-test): the mock's own
 *     850 hPa numbers are perfectly ordinary, so a page that skipped the mask
 *     would draw them; the gate asserts the fill is empty where they exist
 *   · the list: with thermals loaded too, the site's vertical motions are
 *     LISTED (thermal scale + the GFS levels, sorted by height) — no total —
 *     and the rail says "not added"
 *   · an archive ingested before DZDT says so and draws nothing
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks, mockUpdraft, mockThermal, mockTempC } from './fixtures/climalytix-mocks.mjs';
import { levelHeightAgl } from '../js/climalytix/updraft.js';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const SITE = { lat: 40.02, lon: -105.27 };
const H = 3_600_000;

test.describe.configure({ timeout: 120_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });

function nextUtc(hour) {
    let t = Math.floor(Date.now() / 86_400_000) * 86_400_000 + hour * H;
    while (t < Date.now() + 4 * H) t += 86_400_000;
    return t;
}

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

async function updraftAt(page, ms, level = 700) {
    await page.evaluate((t) => window.__climalytix.map.setTime(t), ms);
    await page.locator('#cx-layer-up').check();
    if (level !== 700) await page.locator(`#cx-up-level [data-level="${level}"]`).click();
    await page.waitForFunction(([t, lv]) => {
        const u = window.__climalytix.state.map.updraft;
        return u.state !== 'loading' && u.timeMs === t && u.level === lv;
    }, [ms, level], { timeout: 60_000 });
    return page.evaluate(() => window.__climalytix.state.map);
}

/** The closed form at the instant: lerp between the bracketing 3 h stamps. */
function expected(lat, lon, ms, key) {
    const t0 = Math.floor(ms / (3 * H)) * 3 * H, t1 = t0 + 3 * H, f = (ms - t0) / (3 * H);
    const lerp = (a, b) => a + (b - a) * f;
    return {
        w: lerp(mockUpdraft(lat, lon, t0, SITE)[key], mockUpdraft(lat, lon, t1, SITE)[key]),
        psfc: lerp(mockThermal(lat, lon, t0, SITE).psfcHpa, mockThermal(lat, lon, t1, SITE).psfcHpa),
        tempC: lerp(mockTempC(lat, lon, t0, SITE), mockTempC(lat, lon, t1, SITE)),
    };
}

test('700 hPa: the site value is the closed form at the instant, at the kernel\'s height above the ground', async ({ page }) => {
    const errors = await boot(page);
    const ms = nextUtc(19) + 1.25 * H;                   // between stamps on purpose
    const st = await updraftAt(page, ms);
    const u = st.updraft;
    expect(u.state).toBe('live');
    const want = expected(SITE.lat, SITE.lon, ms, 'wMs700');
    expect(u.site.usable).toBe(true);
    expect(Math.abs(u.site.w - want.w), `${u.site.w} vs ${want.w}`).toBeLessThan(0.002);
    expect(Math.abs(u.site.zAgl - levelHeightAgl(want.psfc, 700, want.tempC))).toBeLessThan(15);
    expect(st.drawn.updraft.drawn).toBe(true);
    expect(st.drawn.updraft.masked).toBe(0);
    expect(st.drawn.heat).toBe(false);
    await expect(page.locator('#cx-layer-temp')).not.toBeChecked();
    await expect(page.locator('#cx-up-key')).toBeVisible();
    expect(errors).toEqual([]);
});

test('850 hPa is below the ground here: every node is masked and nothing is drawn', async ({ page }) => {
    const errors = await boot(page);
    const ms = nextUtc(19);
    const st = await updraftAt(page, ms, 850);
    // The mock's 850 hPa numbers are ordinary (0.05 m/s ± 0.16) — a page without the mask WOULD draw them.
    expect(Math.abs(expected(SITE.lat, SITE.lon, ms, 'wMs850').w)).toBeGreaterThan(0.02);
    expect(st.updraft.masked).toBe(st.updraft.nodes);
    expect(st.updraft.site.usable).toBe(false);
    const filled = await page.evaluate(() => {
        // Read the map canvas: no red/blue fill pixels anywhere (the basemap is green/brown, the fill is not).
        const c = document.querySelector('#cx-map-canvas'), g = c.getContext('2d');
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 16) if (d[i] > 200 && d[i + 1] < 120) n++;
        return n;
    });
    expect(filled).toBe(0);
    await expect(page.locator('#cx-up-status')).toContainText('850 hPa is below the ground across this whole view');
    const box = await page.locator('#cx-map-canvas').boundingBox();
    await page.locator('#cx-map-canvas').scrollIntoViewIfNeeded();
    const b2 = await page.locator('#cx-map-canvas').boundingBox();
    await page.mouse.move(b2.x + b2.width / 2 - 40, b2.y + b2.height / 2 + 30);
    await expect(page.locator('#cx-map-tip')).toContainText('850 hPa is below the ground here');
    expect(box).toBeTruthy();
    expect(errors).toEqual([]);
});

test('the list: thermal scale + GFS levels side by side, sorted by height, never added', async ({ page }) => {
    const errors = await boot(page);
    const ms = nextUtc(20);
    await page.evaluate((t) => window.__climalytix.map.setTime(t), ms);
    await page.locator('#cx-layer-th').check();               // loads the thermal fields
    await page.waitForFunction(() => window.__climalytix.state.map.thermals.state === 'live');
    const st = await updraftAt(page, ms);
    const rows = st.updraft.budget;
    expect(rows.map((r) => r.key)).toEqual(['thermal', 'gfs700', 'gfs500', 'gfs850']);
    expect(rows.find((r) => r.key === 'gfs850').w).toBe(null);
    expect(rows.every((r) => !('total' in r))).toBe(true);
    const heights = rows.filter((r) => r.heightM != null).map((r) => r.heightM);
    expect([...heights].sort((a, b) => a - b)).toEqual(heights);
    await expect(page.locator('#cx-up-status')).toContainText('not added');
    await expect(page.locator('#cx-up-status table tr')).toHaveCount(4);
    expect(errors).toEqual([]);
});

test('an archive ingested before DZDT says so and draws nothing', async ({ page }) => {
    const errors = await boot(page, { updraft: 'missing' });
    await page.locator('#cx-layer-up').check();
    await expect(page.locator('#cx-up-status')).toContainText('ingested before the vertical-motion fields existed');
    expect((await page.evaluate(() => window.__climalytix.state.map)).drawn.updraft.drawn).toBe(false);
    expect(errors).toEqual([]);
});
