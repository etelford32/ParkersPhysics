/**
 * spaceship-designer-smoke.spec.js — boot + physics smoke test
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies spaceship-designer.html loads without console errors, the design /
 * ascent engine self-tests pass (default rocket reaches orbit), and launching
 * advances the flight (HUD altitude climbs off zero). Mirrors the style of
 * satellite-designer-smoke.spec.js, leaning on the exposed `window.__ssd`.
 */

import { test, expect } from '@playwright/test';

const URL = '/spaceship-designer.html';
const BOOT_TIMEOUT_MS = 15_000;

function attachConsoleRecorder(page) {
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push({ text: msg.text(), location: msg.location() });
    });
    page.on('pageerror', (err) => errors.push({ text: err.message, stack: err.stack }));
    return errors;
}

test.describe('spaceship-designer.html smoke', () => {

    test('boots without console errors', async ({ page }) => {
        // dev-server.mjs does not implement the telemetry beacon (see the
        // cloud-timeline / mars-smoke specs); its 5 s flush answered 501 and
        // read as a page error whenever boot ran past it on software GL.
        await page.route('**/api/telemetry/log', (route) =>
            route.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' }));
        const errors = attachConsoleRecorder(page);
        await page.goto(URL);
        await page.waitForFunction(() => window.__ssd?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(1000);

        // Supabase CDN can be blocked in CI sandboxes — the page degrades to a
        // local-only hangar, which is expected behaviour, not a page fault.
        const filtered = errors.filter((e) =>
            !/supabase|jsdelivr|Failed to fetch|net::ERR/i.test(e.text || ''));
        if (filtered.length) console.error('Console errors:', JSON.stringify(filtered, null, 1));
        expect(filtered, 'No unexpected console errors during boot').toHaveLength(0);
    });

    test('design + ascent engine self-test passes', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => window.__ssd?.ready, { timeout: BOOT_TIMEOUT_MS });
        const result = await page.evaluate(() => window.__ssd.selfTest());
        if (!result.ok) console.error('Self-test checks:', result.checks);
        expect(result.ok, 'All design/ascent self-test checks pass').toBe(true);
    });

    test('launching advances the flight', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => window.__ssd?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.getByRole('button', { name: /Launch/i }).click();
        // Altitude HUD should climb off zero within a few seconds of the ascent.
        await page.waitForFunction(() => {
            const t = document.getElementById('hud-alt')?.textContent || '0';
            return parseFloat(t) > 1;
        }, { timeout: 30_000 });   // T−3 s ignition hold + real-time liftoff before the warp ramps
        const alt = await page.evaluate(() => document.getElementById('hud-alt')?.textContent);
        expect(parseFloat(alt)).toBeGreaterThan(1);
    });

    // The bug this page shipped with: stage 1 stood at y = 0, so every bell hung
    // inside the pad and the plume was a speck in the trench.
    test('the stack stands on its launch mount with the engines above the deck', async ({ page }) => {
        await page.goto(URL);
        // `ready` precedes the (debounced) first build — wait for the stack itself.
        await page.waitForFunction(() => window.__ssd?.scene?.debug().stages > 0, { timeout: BOOT_TIMEOUT_MS });
        const d = await page.evaluate(() => window.__ssd.scene.debug());
        expect(d.engines).toEqual([9, 1]);
        expect(d.lowestStage1Exit).toBeGreaterThan(d.deckTop + 1);
        expect(d.mountTop).toBeGreaterThan(d.lowestStage1Exit);
    });

    // launch-plume.js built its cone pointing UP into the vehicle until 2026-10
    // (translate-then-rotate). The plume must extend DOWNSTREAM (−Y) from its
    // origin at the bell exit. Shared with the Launch Planner.
    test('the shared plume points downstream', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => window.__ssd?.ready, { timeout: BOOT_TIMEOUT_MS });
        const box = await page.evaluate(async () => {
            const THREE = await import('three');
            const { buildPlume } = await import('./js/launch-plume.js');
            const p = buildPlume({ coreRadius: 0.5, outerLen: 20 });
            p.visible = true;
            const b = new THREE.Box3().setFromObject(p);
            return { min: b.min.y, max: b.max.y };
        });
        expect(box.max).toBeLessThan(0.05);
        expect(box.min).toBeLessThan(-19);
    });

    // Longitude is part of the design: the presets and the slider both move
    // the planet under the pad, and the design blob carries it.
    test('launch site: presets and the longitude slider move the pad', async ({ page }) => {
        await page.addInitScript(() => { try { localStorage.removeItem('pp_ssd_draft_v1'); } catch {} });
        await page.goto(URL);
        await page.waitForFunction(() => window.__ssd?.scene?.debug().stages > 0, { timeout: BOOT_TIMEOUT_MS });
        expect(await page.evaluate(() => window.__ssd.scene.debug().site)).toEqual([28.5, -80.6]);
        await page.selectOption('#ssd-site', 'mahia');
        await page.waitForFunction(() => window.__ssd.scene.debug().site?.[1] === 177.9, { timeout: 10_000 });
        expect(await page.evaluate(() => [window.__ssd.design.launchLatitude, window.__ssd.design.launchLongitude])).toEqual([-39.3, 177.9]);
        await expect(page.locator('#ssd-lon-val')).toHaveText('177.9° E');
        // Nudging the slider makes the site custom and still moves the pad.
        await page.locator('#ssd-lon').evaluate((el) => { el.value = '-10'; el.dispatchEvent(new Event('input', { bubbles: true })); });
        await page.waitForFunction(() => window.__ssd.scene.debug().site?.[1] === -10, { timeout: 10_000 });
        await expect(page.locator('#ssd-site')).toHaveValue('custom');
        // A new body brings its own default site.
        await page.selectOption('#ssd-body', 'mars');
        await page.waitForFunction(() => window.__ssd.scene.debug().body === 'mars', { timeout: 10_000 });
        expect(await page.evaluate(() => window.__ssd.scene.debug().site)).toEqual([18.4, 77.5]);
        await expect(page.locator('#ssd-site')).toHaveValue('jezero');
    });

    test('engine picker values are catalog keys', async ({ page }) => {
        await page.goto(URL);
        await page.waitForFunction(() => window.__ssd?.ready, { timeout: BOOT_TIMEOUT_MS });
        const bad = await page.evaluate(async () => {
            const { ENGINE_CATALOG } = await import('./js/spaceship-designer-engine.js');
            return [...document.querySelectorAll('select[data-k="engineId"] option')]
                .map((o) => o.value).filter((v) => !(v in ENGINE_CATALOG));
        });
        expect(bad).toEqual([]);
    });

    test('flight stages: booster separates, stage 2 lights, fairing jettisons', async ({ page }) => {
        test.setTimeout(150_000);
        await page.goto(URL);
        await page.waitForFunction(() => window.__ssd?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.getByRole('button', { name: /Launch/i }).click();
        await page.evaluate(() => window.__ssd.scene.setTimeScale(4));
        await page.waitForFunction(() => {
            const d = window.__ssd.scene.debug();
            return d.attached[0] === false && d.lit[1] === true && d.fairingOff === true;
        }, null, { timeout: 120_000, polling: 100 });
        const d = await page.evaluate(() => window.__ssd.scene.debug());
        expect(d.attached).toEqual([false, true]);
        expect(d.rotZ).toBeLessThan(-0.5);          // pitched over downrange, not still vertical
    });
});
