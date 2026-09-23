// @ts-check
/**
 * home-hero-entrance.spec.js — the homepage hero's LOAD SEQUENCE
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-23. The load used to be: an empty stage, a main-thread freeze while
 * every program compiled on frame one, the finished scene CUT in over the CSS
 * backdrop — as an oval, because the drawing buffer kept its boot size while
 * the hero grew — and two full WebGL demo iframes booting against all of it.
 * Pins (js/hero-space-weather.js ENTRANCE bullet, index.html BOOT RETICLE):
 *   (1) the boot reticle is in the first paint (`hero-booting`), and the
 *       first frame swaps it for `hero-live` (canvas crossfades in);
 *   (2) the drawing buffer tracks the canvas's CSS box when the hero grows
 *       WITHOUT a window resize, and the camera aspect follows it — the
 *       oval-Earth bug (measured 1440×1009 buffer shown at 1440×1208);
 *   (3) the entrance settles on the live state exactly (zoom 1, arc 0,
 *       curtains fully risen, stars fully lit) and announces
 *       'hero-intro-done';
 *   (4) the two demo iframes carry no src at load, the near one gets it
 *       only after the gate opens, the far one only when scrolled near;
 *   (5) reduced motion: no reticle, no scene.
 * Chrome geometry + debug hooks only — no live network needed.
 */
import { test, expect } from '@playwright/test';

const URL = '/index.html?exp_home_bg_carousel=control&debug=1';

test.describe('home hero entrance', () => {
    // Boot alone measured ~41 s on the software rasteriser (home-hero-stage).
    test.describe.configure({ timeout: 180_000 });

    test('reticle → live, round Earth, settled entrance, deferred embeds', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.addInitScript(() => {
            window.__introDone = false;
            window.addEventListener('hero-intro-done', () => { window.__introDone = true; });
        });
        await page.goto(URL, { waitUntil: 'domcontentloaded' });

        // (1) + (4, at load): reticle up, no embed has a src yet.
        const early = await page.evaluate(() => ({
            booting: document.getElementById('hero').classList.contains('hero-booting'),
            srcs: [...document.querySelectorAll('iframe[data-src]')].map((f) => f.getAttribute('src')),
        }));
        expect(early.booting).toBe(true);
        expect(early.srcs.length).toBe(2);
        expect(early.srcs.every((s) => s === null)).toBe(true);

        await page.waitForFunction(() => {
            const c = document.getElementById('hero-canvas');
            return document.getElementById('hero').classList.contains('hero-live') || (c && c.style.display === 'none');
        }, null, { timeout: 120_000 });
        const live = await page.evaluate(() => document.getElementById('hero').className);
        test.skip(!/hero-live/.test(live), 'WebGL unavailable — no scene to enter');
        expect(live).not.toMatch(/hero-booting/);

        // (3) The entrance runs on wall clock; settles on the live values.
        await page.waitForFunction(() => window.__introDone === true, null, { timeout: 60_000 });
        const settled = await page.evaluate(() => {
            const h = window.__ppHero;
            return {
                zoom: h._introZoom, arc: h._introArc, elev: h._introElev,
                rise: h._engine._auroraRise, ignite: h._starU.u_ignite.value,
            };
        });
        expect(settled).toEqual({ zoom: 1, arc: 0, elev: 0, rise: 1, ignite: 1 });

        // (2) Grow the hero with no window resize: the buffer must follow the
        // CSS box and the camera aspect with it (else Earth is an oval).
        await page.evaluate(() => {
            const pad = document.createElement('div');
            pad.id = 'test-grow';
            pad.style.height = '300px';
            document.querySelector('#hero .hero-inner').appendChild(pad);
        });
        await page.waitForFunction(() => {
            const c = document.getElementById('hero-canvas');
            const dpr = window.__ppHero._renderer.getPixelRatio();
            return Math.abs(c.height - Math.floor(c.clientHeight * dpr)) <= 1;
        }, null, { timeout: 20_000 });
        const geo = await page.evaluate(() => {
            const c = document.getElementById('hero-canvas');
            return { aspect: window.__ppHero._camera.aspect, css: c.clientWidth / c.clientHeight };
        });
        expect(Math.abs(geo.aspect - geo.css)).toBeLessThan(0.005);

        // (4) The gate is open (entrance done): the near embed loads, the far
        // one waits until it comes within the IO margin.
        await page.waitForFunction(() => !!document.querySelector('#earth-demo iframe').getAttribute('src'), null, { timeout: 20_000 });
        expect(await page.evaluate(() => document.querySelector('iframe.sw-attract-frame').getAttribute('src'))).toBeNull();
        await page.evaluate(() => document.querySelector('.sw-attract-section').scrollIntoView());
        await page.waitForFunction(() => /preview=1/.test(document.querySelector('iframe.sw-attract-frame').getAttribute('src') || ''), null, { timeout: 20_000 });
    });

    test('reduced motion: no reticle, no scene', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.getElementById('hero-canvas')?.style.display === 'none', null, { timeout: 60_000 });
        const cls = await page.evaluate(() => document.getElementById('hero').className);
        expect(cls).not.toMatch(/hero-booting|hero-live/);
    });
});
