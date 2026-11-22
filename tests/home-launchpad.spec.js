// @ts-check
/**
 * home-launchpad.spec.js — the homepage's first screen in a real browser.
 *
 * The launchpad (index.html #hero, js/home-launchpad.js) replaced the live
 * magnetosphere hero on 2026-11-22. Node gate: tests/home-launchpad.mjs.
 * This spec pins what only a browser can show:
 *   1. the carousel renders the model's slides, in order, every link live;
 *   2. arrows / dots / keyboard move it, the scroll position is the truth,
 *      off-screen slides are inert, and auto-advance stops once steered
 *      (NEGATIVE CONTROL: before steering, a tick does advance it);
 *   3. the six permanent tiles are in the FIRST PAINT (present before the
 *      module arrives) and gain their "latest change" line from the log;
 *   4. the whole launchpad sits above the fold at 1440×900 and nothing
 *      scrolls sideways at 390;
 *   5. the page opens no WebGL context and loads no three.js for it.
 *
 * No network beyond the dev server: external hosts are aborted.
 */
import { test, expect } from '@playwright/test';

const PAGE = '/index.html?debug=1&theme=dark';

async function offline(page) {
    await page.route((u) => !/^(localhost|127\.0\.0\.1)$/.test(u.hostname), (r) => r.abort());
}
async function boot(page, url = PAGE) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__ppLaunchpad && document.querySelectorAll('.lp-slide').length > 0, null, { timeout: 30000 });
    await page.evaluate(() => document.querySelector('.pp-consent-banner')?.remove());
}
const active = (page) => page.evaluate(() => {
    const t = document.querySelector('.lp-track');
    return { index: window.__ppLaunchpad.index, scrolled: Math.round(t.scrollLeft / t.clientWidth),
             inert: [...document.querySelectorAll('.lp-slide')].map((n) => n.hasAttribute('inert')) };
});

test.describe('homepage launchpad', () => {
    test.use({ reducedMotion: 'reduce' });   // deterministic: no smooth scroll, no auto-advance timer

    test('carousel is the build log: slides, order, links', async ({ page }) => {
        await offline(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        const model = await page.evaluate(async () => {
            const m = await import('/js/home-launchpad-model.js');
            return m.recentSlides().map((s) => ({ sim: s.sim.id, entry: s.entry.id, href: s.href, title: s.sim.title }));
        });
        const dom = await page.evaluate(() => [...document.querySelectorAll('.lp-slide')].map((n) => ({
            sim: n.dataset.sim, entry: n.dataset.entry,
            href: n.querySelector('.lp-open').getAttribute('href'),
            title: n.querySelector('.lp-slide-sim').textContent,
            changed: n.querySelector('.lp-changed').getAttribute('href'),
            cta: n.querySelector('.lp-open').dataset.funnelCta,
            media: n.querySelector('.lp-media img') ? 'img' : n.querySelector('.lp-plate') ? 'plate' : 'none',
        })));
        expect(dom.map(({ sim, entry, href, title }) => ({ sim, entry, href, title }))).toEqual(model);
        for (const d of dom) {
            expect(d.changed).toBe('recent-development.html#' + d.entry);
            expect(d.cta).toBe('launchpad_recent_' + d.sim);
            expect(d.media).not.toBe('none');             // a photograph or a plate — never blank
        }
        // Every "what changed" anchor exists on the pre-rendered build log.
        const log = await (await page.request.get('/recent-development.html')).text();
        for (const d of dom) expect(log).toContain(`id="${d.entry}"`);
        // No broken thumbnails.
        await page.waitForFunction(() => [...document.querySelectorAll('#hero img')].filter((i) => i.loading !== 'lazy').every((i) => i.complete));
        const broken = await page.evaluate(() => [...document.querySelectorAll('#hero img')].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src));
        expect(broken).toEqual([]);
        // The log strip is the newest entries, newest first.
        const strip = await page.evaluate(() => [...document.querySelectorAll('[data-lp-log] a')].map((a) => a.getAttribute('href')));
        const want = await page.evaluate(async () => (await import('/js/home-launchpad-model.js')).logStrip().map((e) => 'recent-development.html#' + e.id));
        expect(strip).toEqual(want);
    });

    test('controls: arrows, dots, keyboard; scroll is the truth; inert off-screen; auto-advance stops when steered', async ({ page }) => {
        await offline(page);
        await page.setViewportSize({ width: 1280, height: 800 });
        await boot(page);
        const n = await page.evaluate(() => window.__ppLaunchpad.slides.length);
        let a = await active(page);
        expect(a.index).toBe(0); expect(a.scrolled).toBe(0);
        expect(a.inert).toEqual([false, ...Array(n - 1).fill(true)]);
        // NEGATIVE CONTROL for "stops when steered": an un-steered tick advances
        // once the carousel is on screen and neither hovered nor focused.
        await page.mouse.move(5, 795);
        await page.waitForTimeout(300);                       // let the IntersectionObserver report
        await page.evaluate(() => window.__ppLaunchpad._tick());
        await expect.poll(async () => (await active(page)).scrolled).toBe(1);
        // Steer with the arrow: back to 0, then wrap backwards to the last.
        await page.locator('.lp-prev').click();
        await expect.poll(async () => (await active(page)).scrolled).toBe(0);
        await page.locator('.lp-prev').click();
        await expect.poll(async () => (await active(page)).scrolled).toBe(n - 1);
        await page.locator('.lp-next').click();
        await expect.poll(async () => (await active(page)).scrolled).toBe(0);
        // Steered: a tick now does nothing.
        await page.mouse.move(5, 795);
        await page.evaluate(() => window.__ppLaunchpad._tick());
        await page.waitForTimeout(250);
        expect((await active(page)).scrolled).toBe(0);
        // Dots.
        await page.locator('.lp-dot').nth(3).click();
        await expect.poll(async () => (await active(page)).scrolled).toBe(3);
        a = await active(page);
        expect(a.index).toBe(3);
        expect(a.inert.filter((x) => !x).length).toBe(1);
        expect(a.inert[3]).toBe(false);
        expect(await page.locator('.lp-dot[aria-current="true"]').count()).toBe(1);
        // Keyboard on the track.
        await page.locator('.lp-track').focus();
        await page.keyboard.press('ArrowRight');
        await expect.poll(async () => (await active(page)).scrolled).toBe(4);
        await page.keyboard.press('ArrowLeft');
        await expect.poll(async () => (await active(page)).scrolled).toBe(3);
        // A native scroll (what a swipe does) is read back as the active slide.
        await page.evaluate(() => { const t = document.querySelector('.lp-track'); t.scrollLeft = t.clientWidth * 5; });
        await expect.poll(async () => (await active(page)).index).toBe(5);
        // The active slide's CTA navigates to that simulation.
        const href = await page.evaluate(() => document.querySelector('.lp-slide.lp-active .lp-open').getAttribute('href'));
        expect(href).toBe(await page.evaluate(() => window.__ppLaunchpad.slides[5].href));
    });

    test('permanent tiles are in the first paint and gain their latest change from the log', async ({ page }) => {
        await offline(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        // Hold the launchpad module back: the tiles must already be there.
        let release; const gate = new Promise((r) => { release = r; });
        await page.route('**/js/home-launchpad.js', async (route) => { await gate; await route.continue(); });
        await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
        const first = await page.evaluate(() => [...document.querySelectorAll('.lp-fix')].map((a) => ({
            id: a.dataset.lpFixture, href: a.getAttribute('href'), w: a.getBoundingClientRect().width,
            latestHidden: a.querySelector('[data-lp-latest]').hidden })));
        expect(first.map((t) => t.id)).toEqual(['galactic-map', 'solar-system', 'earth', 'climalytix', 'mars', 'sun']);
        for (const t of first) { expect(t.w).toBeGreaterThan(150); expect(t.latestHidden).toBe(true); expect(t.href).toBe(t.id + '.html'); }
        expect(await page.locator('.lp-slide').count()).toBe(0);
        release();
        await page.waitForFunction(() => document.querySelectorAll('.lp-slide').length > 0);
        const want = await page.evaluate(async () => {
            const m = await import('/js/home-launchpad-model.js');
            return Object.fromEntries(m.fixtures().map((f) => [f.sim.id, f.latest ? f.latest.title : null]));
        });
        const got = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.lp-fix')].map((a) => {
            const s = a.querySelector('[data-lp-latest]');
            return [a.dataset.lpFixture, s.hidden ? null : s.textContent];
        })));
        for (const [id, title] of Object.entries(want)) {
            if (title == null) expect(got[id]).toBeNull();          // nothing logged ⇒ nothing claimed
            else expect(got[id]).toContain(title);
        }
        expect(Object.values(want).some((t) => t != null)).toBe(true);
        // The count badge is filled from the catalogue.
        const count = await page.evaluate(async () => (await import('/js/simulations-catalog.js')).SIM_COUNT);
        await expect(page.locator('.hero-badge')).toContainText(`${count} simulations`);
    });

    test('fits the first screen at 1440×900; no sideways scroll on a phone; light theme', async ({ page }) => {
        await offline(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        const fold = await page.evaluate(() => ({
            hero: document.getElementById('hero').getBoundingClientRect().bottom,
            carousel: document.querySelector('.lp-recent').getBoundingClientRect(),
            tiles: [...document.querySelectorAll('.lp-fix')].map((a) => a.getBoundingClientRect().bottom),
        }));
        expect(fold.hero).toBeLessThanOrEqual(900);
        expect(fold.carousel.height).toBeGreaterThan(300);
        expect(Math.max(...fold.tiles)).toBeLessThanOrEqual(900);
        await page.setViewportSize({ width: 390, height: 844 });
        await boot(page);
        const phone = await page.evaluate(() => ({
            sw: document.documentElement.scrollWidth,
            over: [...document.querySelectorAll('#hero *')].filter((n) => n.closest('.lp-track') === null || n.classList.contains('lp-track'))
                .filter((n) => n.getBoundingClientRect().right > 391 && !n.closest('.lp-slide')).length,
        }));
        expect(phone.sw).toBeLessThanOrEqual(390);
        expect(phone.over).toBe(0);
        await boot(page, '/index.html?debug=1&theme=light');
        const light = await page.evaluate(() => ({
            bg: getComputedStyle(document.getElementById('hero')).backgroundImage,
            panel: getComputedStyle(document.querySelector('.lp-panel')).backgroundColor,
            sim: getComputedStyle(document.querySelector('.lp-slide-sim')).color,
        }));
        expect(light.bg).toMatch(/rgb\(246, 249, 254\)/);
        expect(light.panel).toBe('rgb(255, 255, 255)');
        expect(light.sim).toBe('rgb(255, 255, 255)');     // type on a slide stays white: it sits on a dark photograph
    });

    test('the live demo embed carries no src at load and gets one only when scrolled near', async ({ page }) => {
        // Moved here from tests/home-hero-entrance.spec.js with the hero's move:
        // the flux-rope attract frame is a full WebGL app and must not boot
        // against the first screen.
        await offline(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        const srcs = await page.evaluate(() => [...document.querySelectorAll('iframe[data-src]')].map((f) => f.getAttribute('src')));
        expect(srcs).toEqual([null]);
        await page.waitForFunction(() => !document.getElementById('showcase-host')?.hasAttribute('aria-busy'));
        await page.evaluate(() => document.querySelector('.sw-attract-section').scrollIntoView({ behavior: 'instant' }));
        await page.waitForFunction(() => /preview=1/.test(document.querySelector('iframe.sw-attract-frame').getAttribute('src') || ''), null, { timeout: 20_000 });
    });

    test('the first screen opens no WebGL context and loads no three.js', async ({ page }) => {
        await offline(page);
        await page.addInitScript(() => {
            window.__glContexts = 0;
            const orig = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
                if (/webgl/i.test(String(type))) window.__glContexts++;
                return orig.call(this, type, ...rest);
            };
        });
        const three = [];
        page.on('request', (r) => { if (/three\.module\.js|hero-space-weather\.js/.test(r.url())) three.push(r.url()); });
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        await page.waitForTimeout(2500);
        expect(await page.evaluate(() => window.__glContexts)).toBe(0);
        expect(three).toEqual([]);
    });
});
