/**
 * climalytix-thermals.spec.js — browser gate for the map's THERMALS layer
 * (plan §19 T4: Deardorff w* + the Romps cloud base from our GFS archive).
 *
 * The thermal inputs are mocked as CLOSED FORMS that are linear in lat/lon
 * (tests/fixtures/climalytix-mocks.mjs `mockThermal`, `mockTempC`), so the
 * map's bilinear sampling reproduces them and every number the page shows is
 * RECOMPUTED here with the kernel from the window the page reports.
 *   · midday: the page's site value is the kernel's; cumulus-topped at the
 *     moist site, BLUE thermals 3° east where the air is dry; Thermals takes
 *     over the fill (Temperature goes off)
 *   · THE WINDOW CONVENTION: GFS's flux is the mean over the 3 h ENDING at a
 *     stamp, so at 09:30 the morning window is the one ending at the NEXT
 *     stamp — NEGATIVE CONTROL: the previous window gives a very different
 *     (pre-dawn) w*, so a page on the wrong convention fails here
 *   · night: no thermals, and the rail says the ground is not heating the air
 *   · the day line ("w* ≥ 1 m/s from … to …") is the kernel's, recomputed
 *   · an archive ingested before the thermal fields says so and draws nothing
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks, mockThermal, mockTempC } from './fixtures/climalytix-mocks.mjs';
import { thermalAt } from '../js/climalytix/thermals.js';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const SITE = { lat: 40.02, lon: -105.27 };          // the page's 0.01° site
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

async function thermalsAt(page, ms) {
    await page.locator('#cx-layer-th').check();
    await page.evaluate((t) => window.__climalytix.map.setTime(t), ms);
    await page.waitForFunction((t) => {
        const th = window.__climalytix.state.map.thermals;
        return th.state !== 'loading' && th.timeMs === t;
    }, ms, { timeout: 60_000 });
    return page.evaluate(() => window.__climalytix.state.map.thermals);
}

/** The kernel at a point, from the closed forms at the window the page used. */
function expected(lat, lon, win, { previousWindow = false } = {}) {
    const end = previousWindow ? win.startMs : win.endMs, start = end - 3 * H, f = previousWindow ? 1 : win.f;
    const lerp = (a, b) => a + (b - a) * f;
    const m0 = mockThermal(lat, lon, start, SITE), m1 = mockThermal(lat, lon, end, SITE);
    const t0 = mockTempC(lat, lon, start, SITE), t1 = mockTempC(lat, lon, end, SITE);
    return thermalAt({
        fluxWm2: m1.shflxWm2, ziM: lerp(m0.hpblM, m1.hpblM), psfcHpa: lerp(m0.psfcHpa, m1.psfcHpa),
        tempC: lerp(t0, t1), dewC: lerp(t0 - m0.spreadK, t1 - m1.spreadK),
    });
}

test('midday: the site value is the kernel\'s; cumulus at the moist site, blue thermals in the dry east', async ({ page }) => {
    const errors = await boot(page);
    const info = await thermalsAt(page, nextUtc(20));          // ~13:00 local solar
    expect(info.state).toBe('live');
    const want = expected(SITE.lat, SITE.lon, info.window);
    expect(info.site.regime).toBe('cu');
    expect(Math.abs(info.site.wstar - want.wstar), `${info.site.wstar} vs ${want.wstar}`).toBeLessThan(0.02);
    expect(Math.abs(info.site.baseM - want.baseM)).toBeLessThan(20);
    expect(want.wstar).toBeGreaterThan(1.5);
    const east = await page.evaluate(([la, lo]) => window.__climalytix.map.thermalAt(la, lo), [SITE.lat, SITE.lon + 3]);
    const wantE = expected(SITE.lat, SITE.lon + 3, info.window);
    expect(east.regime).toBe('blue');
    expect(wantE.regime).toBe('blue');
    expect(Math.abs(east.topM - wantE.topM)).toBeLessThan(5);
    const st = await page.evaluate(() => window.__climalytix.state.map);
    expect(st.drawn.thermals).toBe(true);
    expect(st.drawn.heat).toBe(false);
    await expect(page.locator('#cx-layer-temp')).not.toBeChecked();
    await expect(page.locator('#cx-th-status')).toContainText('cumulus base');
    await expect(page.locator('#cx-th-key')).toBeVisible();
    expect(errors).toEqual([]);
});

test('the window convention: at 09:30 the flux is the window ENDING at the next stamp — NEGATIVE CONTROL: the previous one', async ({ page }) => {
    const errors = await boot(page);
    const info = await thermalsAt(page, nextUtc(16.5));        // ~09:30 local solar
    const right = expected(SITE.lat, SITE.lon, info.window);
    const wrong = expected(SITE.lat, SITE.lon, info.window, { previousWindow: true });
    expect(Math.abs(info.site.wstar - right.wstar)).toBeLessThan(0.02);
    expect(Math.abs(right.wstar - wrong.wstar), `${right.wstar} vs ${wrong.wstar}`).toBeGreaterThan(0.5);
    expect(Math.abs(info.site.wstar - wrong.wstar)).toBeGreaterThan(0.5);
    expect(errors).toEqual([]);
});

test('night: no thermals and the rail says why; the day line is the kernel\'s', async ({ page }) => {
    const errors = await boot(page);
    const info = await thermalsAt(page, nextUtc(7));           // ~00:00 local solar
    expect(info.site.regime).toBe('none');
    await expect(page.locator('#cx-th-status')).toContainText('no thermals');
    // Recompute the day's w* ≥ 1 span over the window ends of the local day.
    const off = await page.evaluate(() => window.__climalytix.state.utcOffsetS ?? null);
    const offMs = (off ?? -7 * 3600) * 1000;
    const d0 = Math.floor((info.timeMs + offMs) / 86_400_000) * 86_400_000 - offMs;
    const ends = [];
    for (let t = Math.ceil((d0 + 1) / (3 * H)) * 3 * H; t <= d0 + 86_400_000; t += 3 * H) ends.push(t);
    const good = ends.filter((t) => expected(SITE.lat, SITE.lon, { startMs: t - 3 * H, endMs: t, f: 1 })?.wstar >= 1);
    expect(good.length).toBeGreaterThan(0);
    expect(info.fromMs).toBe(good[0] - 3 * H);
    expect(info.toMs).toBe(good[good.length - 1]);
    await expect(page.locator('#cx-th-status')).toContainText('Today: w* ≥ 1 m/s from');
    expect(errors).toEqual([]);
});

test('an archive ingested before the thermal fields says so and draws nothing', async ({ page }) => {
    const errors = await boot(page, { thermal: 'missing' });
    await page.locator('#cx-layer-th').check();
    await expect(page.locator('#cx-th-status')).toContainText('ingested before the thermal fields existed');
    expect((await page.evaluate(() => window.__climalytix.state.map)).drawn.thermals).toBe(false);
    expect(errors).toEqual([]);
});
