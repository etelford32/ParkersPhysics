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

const PAGE = '/index.html?debug=1&theme=dark&exp_home_title_v2=control';

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
        // The stats strip is filled from the catalogue and the log.
        const count = await page.evaluate(async () => (await import('/js/simulations-catalog.js')).SIM_COUNT);
        await expect(page.locator('[data-lp-stats]')).toBeVisible();
        await expect(page.locator('[data-lp-stats] .lp-stat').first()).toContainText(String(count));
        expect(await page.locator('[data-lp-stats] .lp-stat').count()).toBe(4);
    });

    test('fits the first screen at 1440×900; no sideways scroll on a phone; light cells with dark text', async ({ page }) => {
        await offline(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        const fold = await page.evaluate(() => ({
            hero: document.getElementById('hero').getBoundingClientRect().bottom,
            carousel: document.querySelector('.lp-recent').getBoundingClientRect(),
            tiles: [...document.querySelectorAll('.lp-fix')].map((a) => a.getBoundingClientRect().bottom),
        }));
        // The carousel and the six tiles are on the first screen; the log strip may sit just under it.
        expect(fold.carousel.bottom).toBeLessThanOrEqual(900);
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
        // LIGHT MODE: the cells are light cards with dark text (owner request) —
        // not white type on a dark plate. Measured as contrast against each
        // text's OWN backdrop, with dark mode as the negative control.
        const cells = () => page.evaluate(() => {
            const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
            const cs = (sel) => getComputedStyle(document.querySelector(sel));
            const slideBody = document.querySelector('.lp-slide.lp-active .lp-slide-body').getBoundingClientRect();
            const media = document.querySelector('.lp-slide.lp-active .lp-media').getBoundingClientRect();
            const tile = document.querySelector('.lp-fix[data-lp-fixture="earth"]');
            const img = tile.querySelector('img').getBoundingClientRect(), body = tile.querySelector('.lp-fix-body b').getBoundingClientRect();
            return {
                heroBg: cs('#hero').backgroundImage, panel: cs('.lp-panel').backgroundColor,
                slideBg: lum(cs('.lp-slide.lp-active .lp-slide-body').backgroundColor || 'rgb(0,0,0)'),
                slideBgAlpha: cs('.lp-slide.lp-active .lp-slide-body').backgroundColor,
                slideText: [cs('.lp-slide.lp-active .lp-slide-sim').color, cs('.lp-slide.lp-active .lp-slide-title').color, cs('.lp-slide.lp-active .lp-slide-sum').color].map(lum),
                tileBg: lum(cs('.lp-fix').backgroundColor), tileText: [cs('.lp-fix-body b').color, cs('.lp-fix-live').color].map(lum),
                copyBelowPicture: slideBody.top >= media.bottom - 1,          // the copy is not laid over the photograph
                tileCopyBesidePicture: body.left >= img.right - 1 || body.top >= img.bottom - 1,
                scrim: getComputedStyle(document.querySelector('.lp-slide.lp-active'), '::after').display,
            };
        });
        const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        await boot(page, '/index.html?debug=1&theme=light&exp_home_title_v2=control');
        const light = await cells();
        expect(light.heroBg).toMatch(/rgb\(246, 249, 254\)/);
        expect(light.panel).toBe('rgb(255, 255, 255)');
        expect(light.slideBg).toBeGreaterThan(0.9);                 // a light cell…
        expect(light.tileBg).toBeGreaterThan(0.9);
        for (const t of light.slideText) { expect(t).toBeLessThan(0.2); expect(ratio(t, light.slideBg)).toBeGreaterThanOrEqual(4.5); }   // …with dark, AA text
        for (const t of light.tileText)  { expect(t).toBeLessThan(0.2); expect(ratio(t, light.tileBg)).toBeGreaterThanOrEqual(4.5); }
        expect(light.copyBelowPicture).toBe(true);
        expect(light.tileCopyBesidePicture).toBe(true);
        expect(light.scrim).toBe('none');
        // NEGATIVE CONTROL: dark mode keeps white type over the photograph.
        await boot(page, '/index.html?debug=1&theme=dark&exp_home_title_v2=control');
        const dark = await cells();
        for (const t of dark.slideText) expect(t).toBeGreaterThan(0.6);
        expect(dark.copyBelowPicture).toBe(false);
        expect(dark.scrim).not.toBe('none');
        // Phone, light: still no sideways scroll, tiles keep dark-on-light.
        await page.setViewportSize({ width: 390, height: 844 });
        await boot(page, '/index.html?debug=1&theme=light&exp_home_title_v2=control');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        const ph = await cells();
        expect(ph.tileCopyBesidePicture).toBe(true);
    });

    test('home_title_v2: each arm shows its own copy, no arm flashes another, exposure is recorded once', async ({ page }) => {
        await offline(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        const copy = await (async () => {
            await page.goto('/js/home-title-variants.js');
            return page.evaluate(async () => {
                const m = await import('/js/home-title-variants.js');
                const { SIM_COUNT } = await import('/js/simulations-catalog.js');
                return Object.fromEntries(Object.keys(m.TITLE_VARIANTS).map((id) => [id, m.titleFor(id, SIM_COUNT)]));
            });
        })();
        expect(Object.keys(copy)).toEqual(['control', 'verbs', 'real']);
        for (const id of Object.keys(copy)) {
            // Record every title the visitor could have SEEN (opacity > 0) from the first frame on.
            await page.addInitScript(() => {
                window.__seenTitles = new Set();
                const tick = () => {
                    const h = document.querySelector('#hero .hero-h1');
                    if (h && Number(getComputedStyle(h).opacity) > 0.02) window.__seenTitles.add(h.textContent.replace(/\s+/g, ' ').trim());
                    requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
            });
            await boot(page, `/index.html?debug=1&theme=dark&exp_home_title_v2=${id}`);
            await page.waitForTimeout(700);                         // past the opacity transition
            const got = await page.evaluate(() => ({
                variant: document.getElementById('hero').dataset.titleVariant,
                pending: document.getElementById('hero').classList.contains('lp-title-pending'),
                a: document.querySelector('[data-lp-t1]').textContent, b: document.querySelector('[data-lp-t2]').textContent,
                sub: document.querySelector('[data-lp-sub]').textContent,
                h1s: document.querySelectorAll('h1').length,
                seen: [...window.__seenTitles],
                opacity: getComputedStyle(document.querySelector('.hero-h1')).opacity,
            }));
            expect(got.variant).toBe(id);
            expect(got.pending).toBe(false);
            expect(got.opacity).toBe('1');
            expect(got.a).toBe(copy[id].a); expect(got.b).toBe(copy[id].b);
            expect(got.sub).toBe(copy[id].sub.replace(/<[^>]+>/g, ''));
            expect(got.sub).not.toContain('{n}');
            expect(got.h1s).toBe(1);
            // NO FLASH: the only title ever visible is this arm's.
            expect(got.seen).toEqual([`${copy[id].a} ${copy[id].b}`]);
            // The title fits: no horizontal overflow, and the tiles stay on the first screen.
            const fit = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth,
                tiles: Math.max(...[...document.querySelectorAll('.lp-fix')].map((n) => n.getBoundingClientRect().bottom)) }));
            expect(fit.sw).toBeLessThanOrEqual(1440);
            expect(fit.tiles).toBeLessThanOrEqual(900);
        }
        // NEGATIVE CONTROL for the guard: with the module held back, the title stays
        // hidden (never the control line under a challenger) until the 900 ms backstop.
        let release; const gate = new Promise((r) => { release = r; });
        await page.route('**/js/home-title-variants.js', async (route) => { await gate; await route.continue(); });
        // 'commit', not 'domcontentloaded': a held module import holds that event too.
        await page.goto('/index.html?debug=1&theme=dark&exp_home_title_v2=verbs', { waitUntil: 'commit' });
        await page.waitForSelector('#hero.lp-title-pending .hero-h1', { state: 'attached' });
        expect(await page.evaluate(() => getComputedStyle(document.querySelector('.hero-h1')).opacity)).toBe('0');
        await page.waitForFunction(() => !document.getElementById('hero').classList.contains('lp-title-pending'), null, { timeout: 3000 });
        expect(await page.evaluate(() => document.querySelector('[data-lp-t1]').textContent)).toBe(copy.control.a);   // backstop = the static control line, visible
        release();
    });

    test('Google sign-up: above the dashboard, starts OAuth on click, hidden when signed in, never dead', async ({ page }) => {
        await offline(page);
        await page.setViewportSize({ width: 1440, height: 900 });
        // Stub auth.js: record the OAuth call instead of leaving the page.
        await page.route('**/js/auth.js', (route) => route.fulfill({ contentType: 'text/javascript', body:
            'export const auth = { signInWithProvider: async (p, o) => { window.__oauth = { p, o }; return { success: true }; } };' }));
        await boot(page);
        const btn = page.locator('#lp-signup-google');
        await expect(btn).toBeVisible();
        await expect(btn).toContainText('Sign up with Google');
        const geo = await page.evaluate(() => {
            const g = document.getElementById('lp-signup-google').getBoundingClientRect();
            const d = document.querySelector('[data-funnel-cta="launchpad_try_mars"]').getBoundingClientRect();
            return { above: g.bottom <= d.top + 1, sameColumn: Math.abs(g.left - d.left) < 2 && Math.abs(g.width - d.width) < 2, gy: g.bottom, h: g.height };
        });
        expect(geo.above).toBe(true);
        expect(geo.sameColumn).toBe(true);
        expect(geo.gy).toBeLessThan(900);
        expect(geo.h).toBeGreaterThanOrEqual(44);                 // a touch target
        await btn.click();
        await page.waitForFunction(() => !!window.__oauth);
        const call = await page.evaluate(() => window.__oauth);
        expect(call.p).toBe('google');
        expect(call.o.redirectTo).toMatch(/\/auth-callback\.html\?from=home$/);
        await expect(btn).toBeDisabled();
        await expect(btn).toContainText('Redirecting');

        // Signed in: the button and its email alternative are gone; the try-it CTA stays.
        await page.addInitScript(() => { try { localStorage.setItem('pp_auth', JSON.stringify({ signedIn: true })); } catch {} });
        await boot(page);
        await expect(page.locator('#lp-signup-google')).toBeHidden();
        await expect(page.locator('[data-funnel-cta="launchpad_signup_email"]')).toBeHidden();
        await expect(page.locator('[data-funnel-cta="launchpad_try_mars"]')).toBeVisible();
        await page.evaluate(() => localStorage.removeItem('pp_auth'));
    });

    test('Google sign-up falls back to signup.html when the flow cannot start', async ({ page }) => {
        await offline(page);
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.route('**/js/auth.js', (route) => route.fulfill({ contentType: 'text/javascript', body:
            'export const auth = { signInWithProvider: async () => ({ success: false, error: "Supabase client not configured" }) };' }));
        await boot(page);
        await Promise.all([
            page.waitForURL(/\/signup\.html\?from=home$/, { waitUntil: 'commit' }),
            page.locator('#lp-signup-google').click(),
        ]);
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
