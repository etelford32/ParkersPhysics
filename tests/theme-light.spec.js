// @ts-check
/**
 * tests/theme-light.spec.js — the site's daylight theme, end to end.
 *
 *   npx playwright test tests/theme-light.spec.js
 *
 * The kernel (when is it day?) is pinned in node by tests/theme-schedule.mjs.
 * This gate pins what only a browser can show:
 *   - a light-capable page is LIGHT at local noon and DARK at night, decided
 *     by the Sun at the saved location (Boulder, timezone America/Denver);
 *   - it FLIPS BY ITSELF at sunset with the page open (one timer, no reload);
 *   - the boot script paints the right theme before any module runs
 *     (theme.js blocked) — on a cold cache from the clock window, on a warm
 *     one from the cached auto answer, which the NEGATIVE CONTROL plants as
 *     'dark' at noon to prove the cache, not the clock, decided;
 *   - the switch under the logo flips + pins, double-click returns to the Sun,
 *     it survives nav re-renders, and pages without the shared nav get it too;
 *   - a page NOT in scripts/build-theme-support.mjs LIGHT_PAGES never goes
 *     light and shows no toggle (the simulations stay dark — space is black).
 */
import { test, expect } from '@playwright/test';

const LIGHT_PAGE = '/simulations.html';
const DARK_ONLY_PAGE = '/rust.html';
const BOULDER = { lat: 40.015, lon: -105.27, city: 'Boulder' };
// 2026-06-21 in Denver (MDT, UTC−6): noon, 02:00, and 5 min before sunset (~20:32).
const NOON = Date.UTC(2026, 5, 21, 18, 0);
const NIGHT = Date.UTC(2026, 5, 22, 8, 0);
const PRE_SUNSET = Date.UTC(2026, 5, 22, 2, 27);

test.use({ timezoneId: 'America/Denver' });

/** Block third-party fonts (egress-blocked in CI sandboxes) and seed storage. */
async function prep(page, { location = BOULDER, storage = {} } = {}) {
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    await page.addInitScript(([loc, extra]) => {
        try {
            if (!sessionStorage.getItem('__seeded')) {
                sessionStorage.setItem('__seeded', '1');
                if (loc) localStorage.setItem('ppx_user_location', JSON.stringify(loc));
                for (const [k, v] of Object.entries(extra)) localStorage.setItem(k, v);
            }
        } catch { /* ignore */ }
    }, [location, storage]);
}

const isLight = (page) => page.evaluate(() => document.documentElement.classList.contains('theme-light'));

test('auto: light at local noon, dark at night, by the Sun at the saved location', async ({ page }) => {
    await prep(page);
    await page.clock.install({ time: NOON });
    await page.goto(LIGHT_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ppTheme?.get());
    expect(await isLight(page)).toBe(true);
    const st = await page.evaluate(() => window.ppTheme.get());
    expect(st).toMatchObject({ mode: 'auto', theme: 'light', reason: 'sun' });
    // White page, navy text — the palette actually applied.
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(255, 255, 255)');
    // The auto answer is cached for the next page's first paint.
    const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('pp.theme.auto')));
    expect(cache.theme).toBe('light');
    expect(cache.untilMs).toBeGreaterThan(NOON);

    await page.clock.setSystemTime(NIGHT);
    await page.goto(LIGHT_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ppTheme?.get());
    expect(await isLight(page)).toBe(false);
    expect(await page.evaluate(() => window.ppTheme.get().theme)).toBe('dark');
});

test('auto flips by itself at sunset with the page open', async ({ page }) => {
    await prep(page);
    await page.clock.install({ time: PRE_SUNSET });
    await page.goto(LIGHT_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ppTheme?.get());
    expect(await isLight(page)).toBe(true);
    const events = page.evaluate(() => new Promise((res) =>
        window.addEventListener('pp-theme-change', (e) => res(e.detail), { once: true })));
    await page.clock.runFor(10 * 60_000);     // ten minutes: past sunset
    expect(await isLight(page)).toBe(false);
    expect(await events).toMatchObject({ theme: 'dark', mode: 'auto' });
});

test('first paint comes from the boot script, before any module runs', async ({ page }) => {
    // theme.js never loads: whatever is on <html> is theme-boot.js's work.
    await page.route(/\/js\/theme\.js/, (r) => r.abort());
    await prep(page, { location: null });
    await page.clock.install({ time: NOON });
    await page.goto(LIGHT_PAGE, { waitUntil: 'domcontentloaded' });
    expect(await isLight(page)).toBe(true);          // cold cache: 12:00 is inside 07–19

    // NEGATIVE CONTROL: a cached auto answer of 'dark' still valid at noon
    // must win over the clock window — proves the cache path is read.
    const page2 = await page.context().newPage();
    await page2.route(/\/js\/theme\.js/, (r) => r.abort());
    await prep(page2, { location: null, storage: {
        'pp.theme.auto': JSON.stringify({ theme: 'dark', untilMs: NOON + 3_600_000 }),
    } });
    await page2.clock.install({ time: NOON });
    await page2.goto(LIGHT_PAGE, { waitUntil: 'domcontentloaded' });
    expect(await isLight(page2)).toBe(false);
});

test('the switch under the logo: click pins, double-click returns to the Sun', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await prep(page);
    await page.clock.install({ time: NIGHT });
    await page.goto(LIGHT_PAGE, { waitUntil: 'domcontentloaded' });
    const sw = page.locator('#pp-theme-switch');
    await expect(sw).toBeVisible();
    await expect(sw).toHaveAttribute('role', 'switch');
    await expect(sw).toHaveAttribute('aria-checked', 'false');      // night ⇒ dark, knob left
    await expect(sw).toHaveAttribute('data-mode', 'auto');

    // The reference's geometry: a 46×20 pill hanging UNDER the logo, inside
    // the sticky nav (so it rides with it), left-aligned with the brand.
    const g = await page.evaluate(() => {
        const r = document.getElementById('pp-theme-switch').getBoundingClientRect();
        const logo = document.querySelector('body > nav .nav-logo-img').getBoundingClientRect();
        const nav = document.querySelector('body > nav').getBoundingClientRect();
        return { w: r.width, h: r.height, top: r.top, left: r.left, logoLeft: logo.left, navBottom: nav.bottom,
                 inNav: document.getElementById('pp-theme-switch').parentElement.matches('body > nav') };
    });
    expect(g).toMatchObject({ w: 46, h: 20, inNav: true });
    expect(g.top).toBeGreaterThan(g.navBottom);                       // under the bar …
    expect(g.top - g.navBottom).toBeLessThan(12);                     // … just under it
    expect(Math.abs(g.left - g.logoLeft)).toBeLessThanOrEqual(2);     // … aligned with the logo

    await sw.click();                                                  // flip → light, pinned
    await expect(sw).toHaveAttribute('aria-checked', 'true');
    await expect(sw).toHaveAttribute('data-mode', 'light');
    expect(await isLight(page)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('pp.theme'))).toBe('light');
    // The knob slid right (translateX 26px — the reference's light position).
    await page.waitForTimeout(450);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.pp-theme-switch-knob')).transform))
        .toMatch(/matrix\(1, 0, 0, 1, 26, 0\)/);

    await sw.click();                                                  // flip → dark, pinned
    await expect(sw).toHaveAttribute('data-mode', 'dark');
    expect(await isLight(page)).toBe(false);

    // The pin survives a reload — checked at NOON, where auto would say light.
    await page.clock.setSystemTime(NOON);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#pp-theme-switch')).toHaveAttribute('data-mode', 'dark');
    expect(await isLight(page)).toBe(false);

    // Double-click hands it back to the Sun: noon ⇒ light, preference cleared.
    await page.locator('#pp-theme-switch').dblclick();
    await expect(page.locator('#pp-theme-switch')).toHaveAttribute('data-mode', 'auto');
    expect(await isLight(page)).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('pp.theme'))).toBeNull();

    // A nav re-render (auth-changed rewrites the nav's innerHTML) must not
    // lose it: the module puts the SAME element back.
    const before = await page.evaluate(() => { window.__sw = document.getElementById('pp-theme-switch'); return true; });
    expect(before).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('auth-changed')));
    await expect(page.locator('body > nav > #pp-theme-switch')).toHaveCount(1);
    expect(await page.evaluate(() => document.getElementById('pp-theme-switch') === window.__sw)).toBe(true);
});

test('pages without the shared nav still get the switch (privacy.html)', async ({ page }) => {
    await prep(page);
    await page.clock.install({ time: NOON });
    await page.goto('/privacy.html', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#pp-theme-switch')).toHaveCount(1);
    await expect(page.locator('#pp-theme-switch')).toHaveAttribute('aria-checked', 'true');
});

test('a page outside LIGHT_PAGES never goes light and shows no switch', async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await prep(page, { storage: { 'pp.theme': 'light' } });
    await page.clock.install({ time: NOON });
    await page.goto(DARK_ONLY_PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ppTheme && document.querySelector('body > nav .nav-brand'));
    expect(await isLight(page)).toBe(false);
    await expect(page.locator('#pp-theme-switch')).toHaveCount(0);
});
