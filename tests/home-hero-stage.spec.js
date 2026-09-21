// @ts-check
/**
 * home-hero-stage.spec.js — the homepage hero's STAGE geometry
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-20: the hero is split at ≥1100px (copy + console in a 560px left
 * column, Earth framed into the empty #hero-stage box on the right) and
 * stacked below that (the stage is a band between the copy and the console).
 * js/hero-space-weather.js reads the stage's rect and solves fov + NDC centre
 * (`__ppHero._frame` under ?debug=1). Pins:
 *   (1) nothing in the DOM overlaps the stage — the whole point of the layout;
 *   (2) on the split, Earth's NDC x is in the right half and the fov is a
 *       telephoto (the 2–2.5× disc), on the stack it is centred;
 *   (3) the console's tab row reflows to two columns inside the 560px lane
 *       (container query — a viewport query kept it 5-across and overflowed);
 *   (4) no horizontal page overflow at either width;
 *   (5) the CME flux-rope layer (js/hero-rope-layer.js) adopts a forecast
 *       whatever the feed does (live / idle→replay / failed→replay), mounts
 *       the scrubber under the stage without overlapping it, and scrubbing
 *       pulls the camera to the corridor framing (mix → 1, corrDist > 0)
 *       with the train drawn.
 * Chrome geometry only — no live network needed (feeds fail closed).
 */
import { test, expect } from '@playwright/test';

const URL = '/index.html?exp_home_bg_carousel=control&debug=1';

async function boot(page) {
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    // Hero boots (__ppHero) or hides its canvas on a GL failure.
    await page.waitForFunction(() => {
        const c = document.getElementById('hero-canvas');
        return !!window.__ppHero || (c && c.style.display === 'none');
    }, null, { timeout: 45_000 });
    await page.waitForSelector('.sc-tabs');
    await page.waitForTimeout(500);
}

function rect(page, sel) {
    return page.evaluate((s) => {
        const b = document.querySelector(s)?.getBoundingClientRect();
        return b ? { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height } : null;
    }, sel);
}

function overlaps(a, b) {
    return a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1;
}

test.describe('home hero stage', () => {
    // Boot alone measured 41 s on the software rasteriser; the 60 s default
    // is what a full-file run tripped, not an assertion.
    test.describe.configure({ timeout: 150_000 });
    test('split layout at 1440: stage right of the copy, nothing over it, Earth framed right', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        const stage = await rect(page, '#hero-stage');
        const top   = await rect(page, '.hero-top');
        const cons  = await rect(page, '#sky-console-host');
        const cta   = await rect(page, '.hero-cta');
        expect(stage.w).toBeGreaterThan(500);
        expect(stage.l).toBeGreaterThan(top.r);          // right column
        expect(stage.t).toBeLessThan(900);               // above the fold
        expect(stage.b).toBeLessThanOrEqual(900);        // the cap keeps the box in the viewport
        for (const box of [top, cons, cta]) expect(overlaps(stage, box)).toBe(false);

        // Console reflowed inside its lane
        const tabs = await page.evaluate(() => {
            const t = document.querySelector('.sc-tabs');
            const r = t.getBoundingClientRect();
            const cols = getComputedStyle(t).gridTemplateColumns.split(' ').length;
            const over = [...t.children].some(c => c.getBoundingClientRect().right > r.right + 1);
            return { w: r.width, cols, over };
        });
        expect(tabs.w).toBeGreaterThan(500);
        expect(tabs.cols).toBe(2);
        expect(tabs.over).toBe(false);

        const frame = await page.evaluate(() => window.__ppHero?._frame ?? null);
        test.skip(!frame, 'WebGL unavailable — framing not solvable here');
        expect(frame.nx).toBeGreaterThan(0.3);
        expect(frame.fov).toBeLessThan(36);

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
    });

    test('rope layer: adopts a forecast, scrubber sits under the stage, scrubbing frames the corridor', async ({ page }) => {
        // Boot + the replay kernel's WASM + the corridor ease, all on a
        // software rasteriser: measured ~75 s end to end, over the 60 s default.
        test.setTimeout(180_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await boot(page);
        const hero = await page.evaluate(() => !!window.__ppHero);
        test.skip(!hero, 'WebGL unavailable — no rope layer without the scene');
        // The replay's kernel is a 147 KB WASM; give it time on software GL.
        await page.waitForFunction(() => window.__heroRopes?.state.ropeCount > 0, null, { timeout: 60_000 });
        const st0 = await page.evaluate(() => window.__heroRopes.state);
        expect(['live', 'replay', 'down']).toContain(st0.mode);
        expect(st0.framing).toBe('earth');           // nothing moves the camera uninvited at adoption

        const scrub = await rect(page, '#hero-scrub');
        const stage = await rect(page, '#hero-stage');
        expect(scrub).not.toBeNull();
        expect(scrub.t).toBeGreaterThanOrEqual(stage.b - 1);   // under the stage, never over it
        expect(overlaps(scrub, stage)).toBe(false);
        await expect(page.locator('#hero-scrub .hrs-mode')).toContainText(/LIVE|REPLAY/);
        await expect(page.locator('#hero-scrub a[data-funnel-cta="hero_flux_rope"]')).toHaveCount(1);

        // Scrub to mid-transit: corridor framing, camera eased out, train drawn.
        await page.evaluate(() => {
            const r = window.__heroRopes; const w = r.state.window;
            r.setPlaying(false);
            r.setTau(w.t0 + (w.arrivalMs ? (w.arrivalMs - w.t0) * 0.85 : (w.t1 - w.t0) * 0.5));
        });
        await page.waitForFunction(() => window.__ppHero._mix > 0.95, null, { timeout: 20_000 });
        const st1 = await page.evaluate(() => ({ ...window.__heroRopes.state, frame: window.__ppHero._frame }));
        expect(st1.framing).toBe('corridor');
        expect(st1.frame.corrDist).toBeGreaterThan(20);
        expect(st1.drawn).toBeGreaterThan(0);
        expect(st1.apexAu.some((a) => a > 0 && a < 1.35)).toBe(true);
        expect(st1.oracle.filter(Boolean).every((o) => o === 'kernel' || o === 'mirror')).toBe(true);
    });

    test('stacked layout at 390: stage is a band between copy and console, Earth centred', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await boot(page);
        const stage = await rect(page, '#hero-stage');
        const top   = await rect(page, '.hero-top');
        const cons  = await rect(page, '#sky-console-host');
        expect(stage.h).toBeGreaterThanOrEqual(200);
        expect(stage.t).toBeGreaterThanOrEqual(top.b - 1);
        expect(cons.t).toBeGreaterThanOrEqual(stage.b - 1);
        expect(overlaps(stage, top)).toBe(false);
        expect(overlaps(stage, cons)).toBe(false);

        const frame = await page.evaluate(() => window.__ppHero?._frame ?? null);
        test.skip(!frame, 'WebGL unavailable — framing not solvable here');
        expect(Math.abs(frame.nx)).toBeLessThan(0.05);

        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    });
});
