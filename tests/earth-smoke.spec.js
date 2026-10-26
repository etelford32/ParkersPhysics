/**
 * earth-smoke.spec.js — smoke test for earth.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Boots the page in headless Chromium via the dev server, waits for scene
 * init, and verifies the key invariants that have regressed in the past:
 *
 *   1. No console errors during boot.
 *   2. Every `input[id^="lyr-"]` toggles its paired mesh.visible predictably
 *      (no silent "NASA overlay visible while checkbox off" state drift).
 *   3. Every feed that emits a status reaches a non-idle state within the
 *      boot window — any feed still on 'idle' after 15 s is probably wedged.
 *   4. The scene sustains ≥ 25 fps over a 2 s sample under default load.
 *
 * Runs via `npx playwright test tests/earth-smoke.spec.js`. CI would point
 * TEST_BASE_URL at a preview deploy; local runs against the dev server
 * spun up by playwright.config.js.
 *
 * The tests lean heavily on the `?debug=1` overlay introduced in PR C —
 * its layerRegistry + feed rollup are exactly the bus we want to assert on.
 */

import { test, expect } from '@playwright/test';

const EARTH_URL = '/earth.html?debug=1';
const BOOT_TIMEOUT_MS = 20_000;

/** Collect console errors (but not warnings — Firefox texSubImage deprecation etc.). */
function attachConsoleRecorder(page) {
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            errors.push({ text: msg.text(), location: msg.location() });
        }
    });
    page.on('pageerror', (err) => {
        errors.push({ text: err.message, stack: err.stack });
    });
    return errors;
}

/** Wait for the scene's animate loop to have run at least N frames — simple
 *  proxy that earth.html has finished synchronous module init. */
async function waitForSceneReady(page) {
    await page.waitForFunction(() => {
        // The debug overlay is the easiest "scene is live" probe we have
        // without piercing the module's closure.
        return document.getElementById('debug-overlay') != null
            && document.getElementById('dbg-fps')?.textContent !== '—';
    }, { timeout: BOOT_TIMEOUT_MS });
}

test.describe('earth.html smoke', () => {

    test('boots without console errors', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);
        // Give a few seconds for any async init (WASM SGP4, Supabase auth)
        // to surface errors — many modules fetch in the background.
        await page.waitForTimeout(3_000);
        if (errors.length) {
            console.error('Console errors captured:', errors);
        }
        expect(errors, 'No console errors during boot').toHaveLength(0);
    });

    test('layer toggles round-trip mesh.visible', async ({ page }) => {
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);
        await page.waitForTimeout(1_500);  // let ObsOverlay meshes build

        // Sample a representative set of toggles — not every layer, but
        // the ones that historically regressed. Grid / tropics / lights
        // exercise the shader-side visibility path; clouds + obs exercise
        // the mesh-side; subsolar exercises a lazy-built marker.
        const toggles = ['lyr-grid', 'lyr-tropic', 'lyr-lights',
                         'lyr-clouds', 'lyr-subsolar',
                         'lyr-obs-precip-rate'];

        for (const id of toggles) {
            const cb = page.locator(`#${id}`);
            await expect(cb, `${id} checkbox exists`).toBeVisible();

            // Start state recorded, then flip, then flip back.
            const initial = await cb.isChecked();
            await cb.setChecked(!initial, { force: true });
            await page.waitForTimeout(200);

            // Assert the debug overlay's integrity check saw no drift.
            // (The overlay refreshes every 1 s; wait a beat.)
            await page.waitForTimeout(1_100);
            const integrityText = await page.textContent('#dbg-integrity');
            expect(integrityText,
                `No drift after toggling ${id}`).not.toMatch(/cb=.*mesh=/);

            await cb.setChecked(initial, { force: true });
        }
    });

    test('every feed reaches a non-idle state within 15 s', async ({ page }) => {
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);

        // Poll the debug overlay's feeds block. Any row whose status text
        // still reads 'idle' after 15 s is probably stuck waiting on a
        // network call that will never complete.
        const deadline = Date.now() + 15_000;
        let stuckIdle = [];
        while (Date.now() < deadline) {
            const rows = await page.locator('#dbg-feeds .dbg-row').all();
            stuckIdle = [];
            for (const row of rows) {
                const name  = (await row.locator('.dbg-k').textContent())?.trim();
                const value = (await row.locator('span').nth(1).textContent())?.trim() ?? '';
                if (value.startsWith('idle')) stuckIdle.push(name);
            }
            if (stuckIdle.length === 0) break;
            await page.waitForTimeout(500);
        }
        expect(stuckIdle, `All feeds reached non-idle (stuck: ${stuckIdle.join(', ')})`).toHaveLength(0);
    });

    test('sustains ≥ 25 fps over a 2 s sample', async ({ page }) => {
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);
        await page.waitForTimeout(1_500);    // skip initial-frame jank

        // Sample from the overlay's own median-fps calc (120-frame window).
        await page.waitForTimeout(2_000);
        const fps = Number(await page.textContent('#dbg-fps'));
        expect(fps, 'Sustained ≥ 25 fps').toBeGreaterThanOrEqual(25);
    });

    // ── Phase 0.4 / 0.5 (EARTHVIEW_LOD_UX_PLAN.md) ──────────────────────────
    // /api/weather/grid is mocked so these run egress-free and deterministic:
    // a 72×36 field with a plausible zonal temperature and a mild gradient,
    // served as either a healthy primary frame or a MET Norway fallback frame
    // (freshness: 'stale'). Range requests (the 72 h backfill) answer empty.
    function gridBody({ freshness = 'live', source = 'open-meteo:72x36' } = {}) {
        const data = [];
        for (let j = 0; j < 36; j++) {
            const lat = -87.5 + j * 5;
            for (let i = 0; i < 72; i++) {
                const lon = -177.5 + i * 5;
                data.push({ current: {
                    temperature_2m: 28 - 0.45 * Math.abs(lat) + 3 * Math.sin(lon / 30),
                    relative_humidity_2m: 60, pressure_msl: 1013 + 8 * Math.cos(lat / 20) + 4 * Math.sin(lon / 25),
                    wind_speed_10m: 6, wind_direction_10m: (lon + 540) % 360,
                    cloud_cover_low: 20, cloud_cover_mid: 10, cloud_cover_high: 5, precipitation: 0,
                } });
            }
        }
        return {
            source, fetched_at: new Date(Date.now() - 120_000).toISOString(), age_seconds: 120,
            grid: { w: 72, h: 36, deg: 5 }, freshness,
            ...(freshness === 'stale' ? { note: `fallback-source: ${source} (the primary upstream failed for this frame)` } : {}),
            pressure_kind: 'msl', data,
        };
    }
    async function mockWeatherGrid(page, opts) {
        const body = gridBody(opts);
        await page.route('**/api/weather/grid**', route => {
            const u = new URL(route.request().url());
            if (u.searchParams.has('since')) {
                return route.fulfill({ json: { since: u.searchParams.get('since'), count: 0, frames: [] } });
            }
            return route.fulfill({ json: body });
        });
    }
    const pipClass = (page, layer) => page.locator(`.lyr-status[data-layer="${layer}"]`).first().getAttribute('class');
    const toastShown = (page) => page.evaluate(() => {
        const box = document.getElementById('layer-feedback');
        return !!box && box.classList.contains('show')
            ? (document.getElementById('layer-feedback-text')?.textContent ?? '(shown)') : null;
    });

    test('healthy weather grid: green pips and NO "synthetic circulation" toast within 10 s (the boot race)', async ({ page }) => {
        // The toast used to fire on the FIRST animate() tick, from the feed's
        // initial loaded:false meta re-dispatched by the resolver, on every
        // healthy page — and nothing ever cleared it.
        await mockWeatherGrid(page);
        const t0 = Date.now();
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);
        await expect.poll(() => pipClass(page, 'isobars'), { timeout: 15_000 }).toMatch(/st-loaded/);
        expect(await pipClass(page, 'isobars')).not.toMatch(/st-fallback|st-error/);
        // Hold the line for the full 10 s window from navigation.
        const remaining = 10_000 - (Date.now() - t0);
        if (remaining > 0) await page.waitForTimeout(remaining);
        const toast = await toastShown(page);
        expect(toast === null || !/synthetic circulation|live weather unavailable/.test(toast),
            `no weather toast on a healthy grid (got: ${toast})`).toBe(true);
        expect(await pipClass(page, 'isobars')).toMatch(/st-loaded/);
    });

    test('fallback-upstream weather grid (freshness: stale): AMBER pips, no toast, title says so', async ({ page }) => {
        // /api/weather/grid has said freshness:'stale' for a MET Norway frame
        // since 2026-10-06; the client ignored it and drew green for a month.
        await mockWeatherGrid(page, { freshness: 'stale', source: 'met-norway:72x36' });
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);
        for (const layer of ['isobars', 'wind', 'clouds']) {
            await expect.poll(() => pipClass(page, layer), { timeout: 15_000 }).toMatch(/st-fallback/);
            expect(await pipClass(page, layer)).not.toMatch(/st-loaded|st-error/);
        }
        const title = await page.locator('.lyr-status[data-layer="isobars"]').first().getAttribute('title');
        expect(title).toMatch(/met-norway:72x36/);
        expect(title).toMatch(/fallback upstream/);
        await page.waitForTimeout(3_000);
        const toast = await toastShown(page);
        expect(toast === null || !/synthetic circulation|live weather unavailable/.test(toast),
            `stale real data is not a failure toast (got: ${toast})`).toBe(true);
    });

    test('no layer-integrity drift on first paint', async ({ page }) => {
        // Catches the class of regression PR A fixed — NASA overlays
        // visible while their checkboxes are off.  The debug overlay
        // surfaces this as text we can string-match on.
        await page.goto(EARTH_URL);
        await waitForSceneReady(page);
        await page.waitForTimeout(2_500);

        const integrityText = await page.textContent('#dbg-integrity');
        expect(integrityText,
            'Every layer checkbox matches its mesh visibility on first paint'
        ).toContain('layers in sync');
    });
});
