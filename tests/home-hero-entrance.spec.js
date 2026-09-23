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
 *   (5) reduced motion: no reticle, no scene;
 *   (6) THE REAL EARTH (js/hero-earth.js): the self-hosted maps are applied
 *       (u_texMix → 1) and the globe is held at its real orientation — the
 *       mesh carries today's sub-solar point onto the scene Sun — and with
 *       the maps blocked the globe stays FEATURELESS (u_texMix 0) while the
 *       hero still boots and goes live;
 *   (7) THE REAL AURORA (js/hero-aurora.js): with an OVATION grid served
 *       (a SYNTHETIC fixture — NOAA is egress-blocked here), the curtains
 *       stand on the observed oval (per-azimuth intensity, not the uniform
 *       Kp ring), the engine's equatorial group sits on the REAL IGRF dipole,
 *       and the night-side footprint is on; with the feed failing, the Kp
 *       ring comes back and the footprint goes dark.
 * Chrome geometry + debug hooks only — no live network needed.
 */
import { test, expect } from '@playwright/test';
import { synthOvation } from './fixtures/ovation-synthetic.mjs';

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

        // (6) Real maps applied; real orientation: the sub-solar point's
        // canonical normal (js/geo/coords.js frame), through the mesh's own
        // transform, lands on the scene Sun.
        const earth = await page.evaluate(() => {
            const h = window.__ppHero;
            const V3 = h._earth.position.constructor;
            const { lat, lon } = h._subsolar;
            const r = Math.PI / 180, cl = Math.cos(lat * r);
            const n = new V3(cl * Math.cos(lon * r), Math.sin(lat * r), -cl * Math.sin(lon * r));
            const w = n.applyQuaternion(h._earth.quaternion);
            const S = h._earthU.u_sun.value.clone().normalize();
            return { texMix: h._earthU.u_texMix.value, tier: h._earthTier, dot: w.dot(S) };
        });
        expect(earth.texMix).toBe(1);
        expect(['boot', 'hd', 'uhd']).toContain(earth.tier);
        expect(earth.dot).toBeGreaterThan(0.99999);

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

    test('maps blocked: a featureless globe, still live', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.route('**/assets/earth/**', (r) => r.abort());
        await page.goto(URL + '&intro=0', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            const c = document.getElementById('hero-canvas');
            return document.getElementById('hero').classList.contains('hero-live') || (c && c.style.display === 'none');
        }, null, { timeout: 120_000 });
        const hasScene = await page.evaluate(() => !!window.__ppHero?._shown);
        test.skip(!hasScene, 'WebGL unavailable — no scene to check');
        await page.waitForTimeout(1500);
        const st = await page.evaluate(() => ({ texMix: window.__ppHero._earthU.u_texMix.value, tier: window.__ppHero._earthTier ?? null }));
        expect(st).toEqual({ texMix: 0, tier: null });
    });

    test('live aurora: curtains on the observed oval, on the real dipole; dead feed → Kp ring', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        let feed = 'up';
        const body = JSON.stringify(synthOvation(new Date()));
        await page.route('**/api/noaa/aurora-grid*', (r) => feed === 'up'
            ? r.fulfill({ status: 200, contentType: 'application/json', body })
            : r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"upstream_unavailable"}' }));
        await page.goto(URL + '&intro=0', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            const c = document.getElementById('hero-canvas');
            return !!window.__ppHero?._shown || (c && c.style.display === 'none');
        }, null, { timeout: 120_000 });
        test.skip(!(await page.evaluate(() => !!window.__ppHero?._shown)), 'WebGL unavailable — no scene to check');
        await page.waitForFunction(() => window.__ppHero._auroraSource === 'ovation' && window.__ppHero._earthU.u_auroraOn.value === 1, null, { timeout: 30_000 });

        const live = await page.evaluate(() => {
            const h = window.__ppHero, e = h._engine;
            let ints = null;
            e._auroraN.traverse((o) => { if (!ints && o.geometry?.attributes?.a_int) ints = Array.from(o.geometry.attributes.a_int.array); });
            // The group's +y must be the IGRF north dipole pole, carried into
            // the world by the globe's own orientation.
            const V3 = h._earth.position.constructor;
            const r = Math.PI / 180, la = h._dipole.poleLatDeg * r, lo = h._dipole.poleLonDeg * r;
            const pole = new V3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).applyQuaternion(h._earth.quaternion);
            const up = new V3(0, 1, 0).applyQuaternion(e._eqGroup.quaternion);
            return {
                oval: !!e._auroraOval, segs: e._auroraOval?.north?.colatDeg?.length,
                min: Math.min(...ints), max: Math.max(...ints), dot: up.dot(pole),
                poleLat: h._dipole.poleLatDeg,
            };
        });
        expect(live.oval).toBe(true);
        expect(live.segs).toBe(181);
        // Observed, not parametric: bright at magnetic midnight, dark at noon.
        expect(live.max).toBeGreaterThan(0.7);
        expect(live.min).toBeLessThan(0.5);
        expect(live.dot).toBeGreaterThan(0.99999);
        expect(live.poleLat).toBeGreaterThan(79);   // the geomagnetic pole, not the old fixed 11.5° tilt

        // Feed dies → the next refresh drops back to the Kp ring, footprint dark.
        feed = 'down';
        await page.evaluate(() => window.__ppHero._fetchAurora());
        await page.waitForFunction(() => window.__ppHero._auroraSource === 'kp' && window.__ppHero._earthU.u_auroraOn.value === 0, null, { timeout: 30_000 });
        const kp = await page.evaluate(() => {
            const e = window.__ppHero._engine;
            let ints = null;
            e._auroraN.traverse((o) => { if (!ints && o.geometry?.attributes?.a_int) ints = Array.from(o.geometry.attributes.a_int.array); });
            return { oval: e._auroraOval, allOne: ints.every((v) => v === 1), reason: window.__ppHero._auroraReason };
        });
        expect(kp).toEqual({ oval: null, allOne: true, reason: 'http-503' });
    });

    test('reduced motion: no reticle, no scene', async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.getElementById('hero-canvas')?.style.display === 'none', null, { timeout: 60_000 });
        const cls = await page.evaluate(() => document.getElementById('hero').className);
        expect(cls).not.toMatch(/hero-booting|hero-live/);
    });
});
