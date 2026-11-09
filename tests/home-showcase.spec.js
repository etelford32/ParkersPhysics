// home-showcase.spec.js — browser gate for the homepage Simulation Showcase
// (js/home-showcase.js over js/home-showcase-slides.js). Offline-safe: the
// space-weather feed and the console's Open-Meteo calls are aborted; the
// showcase itself only needs the committed manifest + media.
//
// Pins: (1) the showcase mounts with one card per registered slide, each a
// funnel CTA that links at the sim and carries the catalogue's section;
// (2) a captured slide shows its poster and the capture date; a slide with
// no media shows the "capture pending" plate — never an empty card;
// (3) the section filters hide and show cards and are the site's sections;
// (4) hover attaches ONE clip on a hover-capable viewport and reduced motion
// never attaches any; (5) the light theme paints the cards white on blue
// and the hero's live scene is framed in the dark window.

import { test, expect } from '@playwright/test';

async function offline(page) {
    await page.route('**/services.swpc.noaa.gov/**', (r) => r.abort());
    await page.route('**/api.open-meteo.com/**', (r) => r.abort());
    await page.route('**/air-quality-api.open-meteo.com/**', (r) => r.abort());
    await page.route('**/api/**', (r) => r.abort());
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
}

async function mountShowcase(page, url = '/index.html?debug=1&theme=dark') {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // The section mounts when it scrolls near (or after 6 s). Scroll to it.
    await page.evaluate(() => document.getElementById('showcase-host').scrollIntoView());
    await page.waitForFunction(() => !!window.__ppShowcase, null, { timeout: 60_000 });
    return page.evaluate(() => ({ slides: window.__ppShowcase.slides, captured: window.__ppShowcase.captured }));
}

test.describe('home simulation showcase', () => {

    test('mounts one card per slide; cards are funnel CTAs with catalogue sections and media or a pending plate', async ({ page }) => {
        test.slow();
        await offline(page);
        const { slides, captured } = await mountShowcase(page);
        expect(slides.length).toBeGreaterThanOrEqual(12);
        for (const id of ['earth', 'sun', 'upper-atmosphere', 'mars', 'moon', 'star-collider']) {
            expect(slides, `slide ${id} present`).toContain(id);
        }
        const cards = page.locator('#showcase-host .hs-card');
        await expect(cards).toHaveCount(slides.length);
        for (const id of slides) {
            const card = page.locator(`#showcase-host .hs-card[data-id="${id}"]`);
            await expect(card).toHaveAttribute('data-funnel-cta', `showcase_${id}`);
            await expect(card).toHaveAttribute('href', /\.html/);
            const section = await card.getAttribute('data-section');
            expect(['space-weather', 'earth-orbit', 'local-space', 'deep-space', 'research']).toContain(section);
            await expect(card.locator('.hs-title')).not.toBeEmpty();
            await expect(card.locator('.hs-does')).not.toBeEmpty();
            await expect(card.locator('.hs-tier')).toBeAttached();
            if (captured.includes(id)) {
                const img = card.locator('.hs-media img');
                await expect(img).toHaveAttribute('src', /assets\/home\/showcase\/.+\.jpg/);
                await expect(card.locator('.hs-shot')).toContainText(/captured/);
            } else {
                await expect(card.locator('.hs-pending')).toContainText(/capture pending/i);
            }
        }
        // At least one real poster decodes.
        const firstImg = page.locator('#showcase-host .hs-card .hs-media img').first();
        await firstImg.scrollIntoViewIfNeeded();
        await expect.poll(() => firstImg.evaluate((el) => el.complete && el.naturalWidth > 0), { timeout: 20_000 }).toBe(true);
    });

    test('section filters are the site sections and hide the other cards', async ({ page }) => {
        test.slow();
        await offline(page);
        const { slides } = await mountShowcase(page);
        const filters = page.locator('#showcase-host .hs-filter');
        const labels = await filters.allTextContents();
        expect(labels[0]).toMatch(/^All/);
        expect(labels.length).toBeGreaterThanOrEqual(4);
        await expect(filters.first()).toHaveAttribute('aria-pressed', 'true');

        // Pick the first real section; only its cards remain visible.
        const sectionId = await filters.nth(1).getAttribute('data-filter');
        await filters.nth(1).click();
        await expect(filters.nth(1)).toHaveAttribute('aria-pressed', 'true');
        await expect(filters.first()).toHaveAttribute('aria-pressed', 'false');
        const visible = await page.evaluate(() => [...document.querySelectorAll('#showcase-host .hs-card')]
            .filter((c) => !c.hidden).map((c) => c.dataset.section));
        expect(visible.length).toBeGreaterThan(0);
        expect(visible.length).toBeLessThan(slides.length);
        expect(visible.every((s) => s === sectionId)).toBe(true);
        expect(await page.evaluate(() => window.__ppShowcase.active)).toBe(sectionId);

        // Back to All.
        await filters.first().click();
        expect(await page.evaluate(() => document.querySelectorAll('#showcase-host .hs-card:not([hidden])').length)).toBe(slides.length);
    });

    test('hover attaches one clip; reduced motion attaches none', async ({ page, browser }) => {
        test.slow();
        await offline(page);
        const { captured } = await mountShowcase(page);
        test.skip(!captured.length, 'no captured media committed');
        const card = page.locator(`#showcase-host .hs-card[data-id="${captured[0]}"]`);
        await card.scrollIntoViewIfNeeded();
        const video = card.locator('video');
        if (await video.count()) {
            // Clip only attaches on hover, and only one at a time.
            expect(await video.getAttribute('src')).toBeNull();
            await card.hover();
            await expect.poll(() => video.getAttribute('src'), { timeout: 10_000 }).toMatch(/\.webm$/);
            expect(await page.evaluate(() => document.querySelectorAll('#showcase-host video[src]').length)).toBe(1);
            await page.mouse.move(0, 0);
            await expect.poll(() => video.getAttribute('src'), { timeout: 5_000 }).toBeNull();
        }

        // NEGATIVE CONTROL: reduced motion mounts no <video> at all.
        const ctx = await browser.newContext({ reducedMotion: 'reduce' });
        const p2 = await ctx.newPage();
        await offline(p2);
        await mountShowcase(p2);
        expect(await p2.evaluate(() => document.querySelectorAll('#showcase-host video').length)).toBe(0);
        await ctx.close();
    });

    test('light theme: white cards, and the hero frames its live scene in a dark window', async ({ page }) => {
        test.slow();
        await page.setViewportSize({ width: 1440, height: 900 });
        await offline(page);
        await mountShowcase(page, '/index.html?debug=1&theme=light');
        expect(await page.evaluate(() => document.documentElement.classList.contains('theme-light'))).toBe(true);
        // Card surface is white (the palette's --pl-card), not the dark gradient.
        const bg = await page.locator('#showcase-host .hs-card').first().evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bg).toBe('rgb(255, 255, 255)');
        // The hero itself is light; its live canvas is clipped to the stage
        // column and the dark window plate sits exactly under that column.
        const heroBg = await page.evaluate(() => getComputedStyle(document.getElementById('hero')).backgroundImage);
        expect(heroBg).toMatch(/linear-gradient/);
        const win = await page.evaluate(() => {
            const w = document.getElementById('hero-window').getBoundingClientRect();
            const c = document.getElementById('hero-stage-col').getBoundingClientRect();
            return { display: getComputedStyle(document.getElementById('hero-window')).display,
                     dx: Math.abs(w.left - c.left), dy: Math.abs(w.top - c.top), dw: Math.abs(w.width - c.width), dh: Math.abs(w.height - c.height),
                     clip: getComputedStyle(document.getElementById('hero-canvas')).clipPath };
        });
        expect(win.display).toBe('block');
        expect(win.dx).toBeLessThan(1.5); expect(win.dy).toBeLessThan(1.5); expect(win.dw).toBeLessThan(1.5); expect(win.dh).toBeLessThan(1.5);
        expect(win.clip).toMatch(/inset/);
        // NEGATIVE CONTROL: dark mode shows no window and does not clip.
        await page.goto('/index.html?theme=dark', { waitUntil: 'domcontentloaded' });
        const dark = await page.evaluate(() => ({
            display: getComputedStyle(document.getElementById('hero-window')).display,
            clip: getComputedStyle(document.getElementById('hero-canvas')).clipPath,
        }));
        expect(dark.display).toBe('none');
        expect(dark.clip).toBe('none');
    });
});
