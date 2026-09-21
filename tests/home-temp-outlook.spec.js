// @ts-check
/**
 * home-temp-outlook.spec.js — the sky console's TEMPERATURE tab: the 7-day
 * hourly line with daily candlesticks, and the 30-day outlook calendar.
 * ─────────────────────────────────────────────────────────────────────────────
 * Open-Meteo is mocked (forecast 16 d + 2 past days, air quality, and the
 * 3-year archive), a location is seeded, and the browser clock runs in UTC
 * so the fixture's wall-clock strings and the page's "local day" agree.
 * Pins:
 *   (1) seven candles, today first, each wick containing its body, both
 *       warming and cooling days present (the fixture alternates);
 *   (2) the calendar: this month's page through today + 30 — 31 forward
 *       cells, today marked, leads 0–15 from NWP, and once the archive lands
 *       leads 16–30 from normal + trend with a number in every cell, past
 *       days of the month filled and dimmed;
 *   (3) hover on a day column and on a cell shows the tip; focus does too;
 *       leaving hides it;
 *   (4) no horizontal overflow in the card at the 1440 split (560px lane)
 *       or at phone width.
 * Chrome geometry + mocked feeds only — no live network.
 */
import { test, expect } from '@playwright/test';

test.use({ timezoneId: 'UTC' });

const URL = '/index.html?exp_home_bg_carousel=control';
const pad = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utcMidnight = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Forecast payload shaped like the live call: forecast_days=16&past_days=2. */
function wxFixture(now) {
    const day0 = utcMidnight(new Date(now)) - 2 * 86400e3;
    const hourly = { time: [], temperature_2m: [], precipitation_probability: [], cape: [] };
    for (let i = 0; i < 18 * 24; i++) {
        const t = new Date(day0 + i * 3600e3);
        const h = t.getUTCHours(), dayIdx = Math.floor(i / 24);
        // Even days warm across midnight, odd days cool → alternating candles.
        const ramp = (dayIdx % 2 === 0 ? 1 : -1) * (h / 23) * 5;
        hourly.time.push(`${isoDay(t)}T${pad(h)}:00`);
        hourly.temperature_2m.push(Math.round((62 + 9 * Math.sin(2 * Math.PI * (h - 9) / 24) + ramp) * 10) / 10);
        hourly.precipitation_probability.push(i % 37 === 0 ? 40 : 5);
        hourly.cape.push(200);
    }
    const daily = { time: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_sum: [], wind_gusts_10m_max: [], weather_code: [], sunrise: [], sunset: [], uv_index_max: [] };
    for (let i = 0; i < 18; i++) {
        const d = new Date(day0 + i * 86400e3);
        daily.time.push(isoDay(d));
        daily.temperature_2m_max.push(74 + (i % 3));
        daily.temperature_2m_min.push(51 - (i % 3));
        daily.precipitation_sum.push(0);
        daily.wind_gusts_10m_max.push(14);
        daily.weather_code.push(1);
        daily.sunrise.push(`${isoDay(d)}T06:40`);
        daily.sunset.push(`${isoDay(d)}T19:00`);
        daily.uv_index_max.push(6);
    }
    return {
        timezone: 'UTC',
        current: { temperature_2m: 66, apparent_temperature: 65, relative_humidity_2m: 48, wind_speed_10m: 7, wind_gusts_10m: 12, weather_code: 1, pressure_msl: 1016, cloud_cover: 20, precipitation: 0, uv_index: 4, is_day: 1 },
        hourly, daily,
    };
}

function aqFixture(now) {
    const day0 = utcMidnight(new Date(now));
    const time = [], us_aqi = [];
    for (let i = 0; i < 7 * 24; i++) {
        const t = new Date(day0 + i * 3600e3);
        time.push(`${isoDay(t)}T${pad(t.getUTCHours())}:00`);
        us_aqi.push(35 + (i % 9));
    }
    return { current: { us_aqi: 38, pm2_5: 6, pm10: 11, ozone: 60, nitrogen_dioxide: 8 }, hourly: { time, us_aqi } };
}

/** Three years of dailies ending two days ago: annual sinusoid, hi/lo ±10. */
function archiveFixture(now) {
    const end = utcMidnight(new Date(now)) - 2 * 86400e3;
    const n = 3 * 365;
    const out = { time: [], temperature_2m_mean: [], temperature_2m_max: [], temperature_2m_min: [], shortwave_radiation_sum: [] };
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(end - i * 86400e3);
        const doy = Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400e3);
        const mean = 55 + 25 * Math.cos(2 * Math.PI * (doy - 205) / 365) + 3 * Math.sin(i / 2.3);
        out.time.push(isoDay(d));
        out.temperature_2m_mean.push(Math.round(mean * 10) / 10);
        out.temperature_2m_max.push(Math.round((mean + 10) * 10) / 10);
        out.temperature_2m_min.push(Math.round((mean - 10) * 10) / 10);
        out.shortwave_radiation_sum.push(Math.round((14 + 11 * Math.cos(2 * Math.PI * (doy - 172) / 365)) * 10) / 10);
    }
    return { daily: out };
}

async function boot(page, { archive = true } = {}) {
    const now = Date.now();
    await page.addInitScript(() => {
        localStorage.setItem('ppx_user_location', JSON.stringify({ lat: 41.88, lon: -87.63, city: 'Chicago', displayName: 'Chicago' }));
    });
    await page.route('**/api.open-meteo.com/**', (r) => r.fulfill({ json: wxFixture(now) }));
    await page.route('**/air-quality-api.open-meteo.com/**', (r) => r.fulfill({ json: aqFixture(now) }));
    await page.route('**/archive-api.open-meteo.com/**', (r) => (archive ? r.fulfill({ json: archiveFixture(now) }) : r.abort()));
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.sc-tabs', { timeout: 60_000 });
    await page.click('.sc-tab[data-view="sky-temp"]');
    await page.waitForSelector('[data-temp-card] svg.sc-wk', { timeout: 60_000 });
    return now;
}

test.describe('home temperature tab: candles + 30-day calendar', () => {
    // Boot alone measured ~40 s on the software rasteriser (see
    // home-hero-stage.spec.js); the 60 s default is what a full-file run trips.
    test.describe.configure({ timeout: 150_000 });

    test('seven daily candles over the hourly line, today first, wick ⊇ body, both directions', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const now = await boot(page);
        const todayKey = isoDay(new Date(now));
        const candles = page.locator('[data-temp-card] rect[data-candle]');
        await expect(candles).toHaveCount(7);
        await expect(candles.first()).toHaveAttribute('data-candle', todayKey);
        const dirs = await candles.evaluateAll((els) => els.map((e) => e.getAttribute('data-dir')));
        expect(dirs).toContain('warming');
        expect(dirs).toContain('cooling');
        // Geometry: every body sits inside its wick (the line drawn just before it).
        const ok = await page.evaluate(() => {
            const svg = document.querySelector('[data-temp-card] svg.sc-wk');
            return [...svg.querySelectorAll('rect[data-candle]')].every((body) => {
                const wick = body.previousElementSibling;
                if (!wick || wick.tagName !== 'line') return false;
                const y1 = +wick.getAttribute('y1'), y2 = +wick.getAttribute('y2');
                const top = +body.getAttribute('y'), bot = top + +body.getAttribute('height');
                return top >= Math.min(y1, y2) - 0.01 && bot <= Math.max(y1, y2) + 0.01;
            });
        });
        expect(ok).toBe(true);
        // The hourly line spans the week and the seven columns are hit areas.
        await expect(page.locator('[data-temp-card] svg.sc-wk path[stroke-width="1.5"]')).toHaveCount(1);
        await expect(page.locator('[data-temp-card] svg.sc-wk rect.hit')).toHaveCount(7);
        // The old 7-day range bars are gone from this tab.
        await expect(page.locator('[data-temp-card] svg[aria-label="7-day temperature range"]')).toHaveCount(0);
    });

    test('calendar: this month through today + 30, NWP then normal + trend, past days filled', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        const now = await boot(page);
        const todayKey = isoDay(new Date(now));
        const cal = page.locator('[data-temp-card] .sc-cal');
        await expect(cal).toHaveCount(1);
        const forward = cal.locator('.d:not(.pad)[data-lead]');
        // 31 forward cells (today + 30), today marked and first-of-month labelled.
        const leads = await forward.evaluateAll((els) => els.map((e) => +e.getAttribute('data-lead')).filter((l) => l >= 0));
        expect(leads.length).toBe(31);
        expect(Math.min(...leads)).toBe(0);
        expect(Math.max(...leads)).toBe(30);
        await expect(cal.locator('.d.today')).toHaveCount(1);
        await expect(cal.locator('.d.today')).toHaveAttribute('data-key', todayKey);
        await expect(cal.locator('.d[data-lead="0"]')).toHaveAttribute('data-src', 'nwp');
        await expect(cal.locator('.d[data-lead="15"]')).toHaveAttribute('data-src', 'nwp');
        await expect(cal.locator('.d[data-lead="7"]')).toHaveAttribute('data-tier', 'nwp-ext');
        await expect(cal.locator('.d:not(.pad) .dn b').first()).toContainText(/^[A-Z][a-z]{2} 1$/);
        // Once the archive has landed the tail is normal + trend, with numbers everywhere.
        await expect(cal.locator('.d[data-lead="16"]')).toHaveAttribute('data-src', 'blend', { timeout: 30_000 });
        await expect(cal.locator('.d[data-lead="30"]')).toHaveAttribute('data-src', 'blend');
        const texts = await cal.locator('.d:not(.pad)[data-lead] .hl').evaluateAll((els) => els.map((e) => e.textContent.trim()));
        for (const t of texts) expect(t).toMatch(/^-?\d+\/-?\d+$/);
        // Past days of this month: (date − 1) dimmed observed cells, every one with a value.
        const dom = new Date(now).getUTCDate();
        const past = cal.locator('.d.past');
        await expect(past).toHaveCount(dom - 1);
        if (dom > 1) {
            const pastTexts = await past.locator('.hl').evaluateAll((els) => els.map((e) => e.textContent.trim()));
            for (const t of pastTexts) expect(t).toMatch(/^-?\d+\/-?\d+$/);
            const srcs = await past.evaluateAll((els) => els.map((e) => e.getAttribute('data-src')));
            // The archive ends two days ago; yesterday is the model's own analysis.
            expect(srcs).toContain('analysis');
            if (dom > 3) expect(srcs).toContain('archive');
        }
        // The provenance note names the fitted τ.
        await expect(page.locator('[data-temp-card] .sc-risknote')).toContainText(/τ ≈ \d/);
        // Every week row is seven cells wide.
        const widths = await cal.locator('.sc-cal-grid').evaluateAll((rows) => rows.map((r) => r.children.length));
        expect(widths.every((w) => w === 7)).toBe(true);
    });

    test('calendar without the archive: NWP days present, the tail says it is waiting', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page, { archive: false });
        const cal = page.locator('[data-temp-card] .sc-cal');
        await expect(cal.locator('.d[data-lead="3"]')).toHaveAttribute('data-src', 'nwp');
        await expect(cal.locator('.d[data-lead="20"]')).toHaveAttribute('data-src', 'none');
        await expect(cal.locator('.d[data-lead="20"] .hl')).toHaveText('—');
        await expect(page.locator('[data-temp-card] .sc-risknote')).toContainText(/normals/);
    });

    test('tips: hover a day column and a calendar cell, focus a cell, leave hides', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        const tip = page.locator('.sky-console .sc-tip');
        await expect(tip).toBeHidden();
        await page.locator('[data-temp-card] svg.sc-wk rect.hit').nth(2).hover();
        await expect(tip).toBeVisible();
        await expect(tip).toContainText(/High \d+° · Low \d+°/);
        await expect(tip).toContainText(/Midnight \d+° → 23:00 \d+°/);
        // A blend cell explains itself.
        const cell = page.locator('[data-temp-card] .sc-cal .d[data-lead="20"]');
        await expect(cell).toHaveAttribute('data-src', 'blend', { timeout: 30_000 });
        await cell.hover();
        await expect(tip).toContainText(/Normal for the date/);
        await expect(tip).toContainText(/Typical miss ±\d+°/);
        // Keyboard: focus shows the same tip; leaving the card hides it.
        await page.locator('[data-temp-card] .sc-cal .d[data-lead="2"]').focus();
        await expect(tip).toContainText(/Model forecast/);
        await page.mouse.move(5, 5);
        await page.locator('[data-temp-card] h3').first().focus();
        await expect(tip).toBeHidden();
    });

    for (const [w, h] of [[1440, 900], [390, 844]]) {
        test(`no horizontal overflow at ${w}×${h}`, async ({ page }) => {
            await page.setViewportSize({ width: w, height: h });
            await boot(page);
            await expect(page.locator('[data-temp-card] .sc-cal .d[data-lead="16"]')).toHaveAttribute('data-src', 'blend', { timeout: 30_000 });
            const over = await page.evaluate(() => {
                const card = document.querySelector('[data-temp-card]');
                const cr = card.getBoundingClientRect();
                const bad = [];
                for (const el of card.querySelectorAll('svg, .sc-cal, .sc-cal .d')) {
                    const r = el.getBoundingClientRect();
                    if (r.right > cr.right + 1 || r.left < cr.left - 1) bad.push(el.className.baseVal ?? el.className);
                }
                return { bad, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
            });
            expect(over.bad).toEqual([]);
            expect(over.page).toBeLessThanOrEqual(0);
        });
    }
});
