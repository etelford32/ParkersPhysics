/**
 * launch-planner-visuals.spec.js — browser gate for the launch planner's 3D
 * vehicle canvas (js/launch-vehicle-3d.js + launch-scene-fx / launch-smoke).
 *
 * Pins the four things the 2026-11 visual overhaul fixed or added:
 *   1. Every camera preset on every vehicle lands ABOVE the ground. The
 *      Engines close-up used to put the Starship camera under the terrain,
 *      because the framing bbox skipped meshes named exactly 'Plume' and
 *      Starship's / Falcon's cones are 'StarshipPlume' / 'Falcon9Plume'.
 *   2. A liftoff emits smoke sprites (ground cloud + trail) and an abort
 *      clears them.
 *   3. The pad's deliberately-transparent materials (gravel fade, lamp
 *      glows, floodlight beams) are STILL transparent after a launch — the
 *      old pad fade forced them opaque on restore.
 *   4. The post chain (bloom + the final ACES/sanitize pass) is active on
 *      WebGL2. Its pixel-level health is tests/launch-planner-render-health.spec.js.
 *
 * NEGATIVE CONTROLS (run 2026-11-01 by putting each old line back): the
 * exact-'Plume' bbox skip fails test 1 (Falcon 9 close-up camera at
 * y = 0.89 m, Starship's under the terrain), and the old `transparent =
 * false` restore fails test 2 (3 → 0 transparent pad materials).
 *
 * Runs on software GL in CI (quality 'low'); frames take ~1 s there, so
 * waits are generous and nothing asserts on pixel values.
 */
import { test, expect } from '@playwright/test';

const URL = '/launch-planner.html';

function attachConsoleRecorder(page) {
    const errors = [];
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
    page.on('pageerror', (err) => errors.push(err.message));
    return errors;
}

async function boot(page) {
    await page.route('**/api/telemetry/log', (r) =>
        r.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' }));
    // Hermetic: no third-party fetches (launch feeds degrade to their offline path).
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.locator('#lh-vehicle-canvas').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => window.__lpVehicle3d?.renderStats, null, { timeout: 60_000 });
}

// Wait for a few rendered frames (a view tween is 800 ms of wall time).
async function frames(page, n = 3) {
    await page.evaluate((n) => new Promise((res) => {
        let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f));
        requestAnimationFrame(f);
    }), n);
}

test.describe('launch-planner 3D canvas visuals', () => {
    test.setTimeout(240_000);

    test('post chain on, every view above ground for every vehicle', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await boot(page);
        const stats0 = await page.evaluate(() => window.__lpVehicle3d.renderStats);
        expect(stats0.post).toBe(true);
        expect(['high', 'low']).toContain(stats0.quality);

        const vehicles = [['shuttle', undefined], ['falcon9', 'block5'], ['falcon9', 'heavy'], ['starship', 'v2']];
        for (const [id, variant] of vehicles) {
            await page.evaluate(([id, v]) => window.__lpVehicle3d.setVehicle(id, v), [id, variant]);
            for (const view of ['threequarter', 'wide', 'front', 'side', 'closeup']) {
                await page.evaluate((view) => window.__lpVehicle3d.setView(view), view);
                await page.waitForTimeout(900);
                await frames(page, 2);
                const s = await page.evaluate(() => window.__lpVehicle3d.renderStats);
                // Above the terrain (y = 0) with room for the near plane.
                expect(s.cameraY, `${id}/${variant} ${view} camera y`).toBeGreaterThan(2);
                // The close-up aims at the engine section, which sits on the pad
                // (Starship's OLM puts its bells ~21 m up) — never below ground.
                if (view === 'closeup') expect(s.targetY, `${id} closeup target`).toBeGreaterThan(0);
            }
        }
        const real = errors.filter((t) => !/Failed to load resource|feed fetch|net::ERR|supabase|jsdelivr/i.test(t));
        expect(real).toEqual([]);
    });

    test('liftoff emits smoke; abort clears it; pad transparency survives', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => window.__lpVehicle3d.setVehicle('falcon9', 'block5'));
        await frames(page, 2);

        const transparentBefore = await page.evaluate(() => {
            const names = [];
            window.__lpVehicle3d.scene.traverse((o) => {
                if (!o.isMesh || !o.material || o.material.transparent !== true) return;
                if (o.name === 'FloodBeam' || o.material.alphaMap) names.push(o.name || o.material.type);
            });
            return names.length;
        });
        expect(transparentBefore).toBeGreaterThan(0);

        await page.evaluate(() => window.__lpVehicle3d.liftoff());
        await page.waitForFunction(() => window.__lpVehicle3d.missionT > 3, null, { timeout: 120_000 });
        await frames(page, 2);
        const mid = await page.evaluate(() => window.__lpVehicle3d.renderStats);
        expect(mid.smokeAlive).toBeGreaterThan(20);
        expect(mid.smokeDrawn).toBeGreaterThan(0);
        expect(mid.flameIntensity).toBeGreaterThan(0);

        // Let the pad fade begin (T > 12) so the opacity path actually runs.
        await page.waitForFunction(() => window.__lpVehicle3d.missionT > 14, null, { timeout: 180_000 });
        await page.evaluate(() => window.__lpVehicle3d.cancelLiftoff());
        await frames(page, 2);
        const after = await page.evaluate(() => {
            const s = window.__lpVehicle3d.renderStats;
            let n = 0;
            window.__lpVehicle3d.scene.traverse((o) => {
                if (!o.isMesh || !o.material || o.material.transparent !== true) return;
                if (o.name === 'FloodBeam' || o.material.alphaMap) n++;
            });
            return { smokeAlive: s.smokeAlive, transparent: n };
        });
        expect(after.smokeAlive).toBe(0);
        expect(after.transparent).toBe(transparentBefore);
        // A dark sky mid-flight is not a fault: the render-health monitor
        // (js/launch-vehicle-3d.js HEALTH) must not have stepped anything down.
        const health = await page.evaluate(() => window.__lpVehicle3d.renderHealth);
        expect(health.steps).toEqual([]);
        expect(health.errors).toBe(0);
    });
});
