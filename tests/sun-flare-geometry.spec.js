/**
 * sun-flare-geometry.spec.js — the flare-site geometry gate for sun.html.
 * ═══════════════════════════════════════════════════════════════════════════
 * Every consumer that draws "where the flare is" on sun.html must agree with
 * js/flare-geometry.js and with each other, and must turn the way the Sun
 * turns. This spec reads them side by side through `window.__sun
 * .flareGeometry` and checks:
 *
 *   · the shader's rotation accumulator IS the page's (u_rotAngle ≡ solarRotAngle);
 *   · the AR sunspot slot, the 3D region marker, the flash ring and the
 *     flare-site group all sit where the kernel puts the site, to 1e-6;
 *   · the shader's flare longitude is the kernel's siteLonAt of the EPOCH
 *     site — it advances by the accumulator × the Snodgrass factor at that
 *     latitude, and the epoch site itself never moves;
 *   · the SENSE is prograde: as the frame turns, a W30 site's x grows (west);
 *   · the 3D arcade + plume exist after a flare, use the Joy's-law PIL prior
 *     (no atlas in CI), rise off the disk, and obey the flares toggle.
 *
 * Measured before the fix (2026-09-13): the photosphere/spots turned east at
 * 0.014/unit, the marker groups west at 0.025/unit, the ribbons not at all.
 * This is the test that would have caught it.
 *
 * AIA is routed DOWN (model disk) so `u_rot` is the slider value, not the
 * real-time multiplier — the rotation has to move measurably in seconds.
 */

import { test, expect } from '@playwright/test';
import * as FG from '../js/flare-geometry.js';
import { diffRotFactor } from '../js/sun-observed.js';

const PAGE = '/sun.html';
const BOOT_TIMEOUT_MS = 25_000;
const DEG = Math.PI / 180;

function isExpectedNoise(text) {
    if (/Shader Error|GLSL|ERROR: 0:|program not valid|Program Info Log/i.test(text || '')) return false;
    return /supabase|jsdelivr|unpkg|cdn|Failed to fetch|net::ERR|ERR_|CORS|swpc|noaa|donki|\bhek\b|nasa|soho|sdo|gibs|celestrak|telemetry|429|404|501|502|503|net::/i
        .test(text || '');
}

async function boot(page) {
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
        try {
            localStorage.setItem('pp_consent_v1', JSON.stringify(
                { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        } catch (e) {}
    });
    await page.route('**/api/solar/aia*', (route) => route.fulfill({
        status: 502, contentType: 'application/json',
        body: JSON.stringify({ error: 'aia_unavailable', detail: 'test: feed down' }),
    }));
    await page.goto(PAGE);
    await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(() => window.__sun.frames > 5, { timeout: BOOT_TIMEOUT_MS });
    return errors;
}

const vdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test.describe('sun.html flare-site geometry', () => {

    test('every consumer draws the site where the kernel puts it, and the frame turns west', async ({ page }) => {
        test.setTimeout(90_000);
        const errors = await boot(page);

        // Model disk, slider rotation, two live regions (the first is the flare's AR).
        await page.evaluate(() => {
            window.__sun.setObserved(false);
            window.__sun.setRegions([
                { num: 14101, loc: 'N14W30', area: 420, z: 'Ekc', mag: 'beta-gamma-delta', nspot: 22 },
                { num: 14102, loc: 'S20E60', area: 90,  z: 'Cso', mag: 'beta',            nspot: 5  },
            ]);
            window.__sun.rebuildMarkers();
        });
        await page.waitForTimeout(400);
        const fired = await page.evaluate(() => window.__sun.testFlare('X', 14, 30));
        expect(fired.latDeg).toBeCloseTo(14, 9);
        await page.waitForTimeout(300);

        const g0 = await page.evaluate(() => window.__sun.flareGeometry);
        expect(g0.uRot, 'rotation runs at the slider rate on the model disk').toBeGreaterThan(0);
        expect(g0.uRotAngle, 'the shader reads THE accumulator').toBeCloseTo(g0.rotAngle, 12);
        expect(g0.site.set).toBe(true);
        expect(g0.site.latRad).toBeCloseTo(14 * DEG, 12);
        expect(g0.shaderPil, 'PIL prior uploaded to the shader').toBeCloseTo(FG.pilAngleRad(14 * DEG), 12);

        // Kernel answers, computed here from the page's own accumulator.
        const siteNow = FG.sitePositionAt(g0.site.latRad, g0.site.lonRad0, g0.rotAngle);
        expect(vdist(g0.siteNow, siteNow)).toBeLessThan(1e-9);
        expect(g0.shaderLon).toBeCloseTo(FG.siteLonAt(g0.site.lonRad0, g0.rotAngle, g0.site.latRad), 9);

        // The AR slot (sunFS spots), the 3D marker, the flash ring and the site group: one position.
        const regionNow = FG.sitePositionAt(14 * DEG, 30 * DEG, g0.rotAngle);
        expect(g0.slots.length).toBeGreaterThanOrEqual(2);
        expect(vdist(g0.slots[0], regionNow), 'u_arSpots[0] = kernel').toBeLessThan(1e-6);
        const marker = g0.markers.find(m => m.lat === 14 && m.lon === 30);
        expect(marker, 'a marker for N14W30').toBeTruthy();
        expect(vdist(marker.pos, regionNow), 'region marker = kernel').toBeLessThan(1e-6);
        expect(g0.flashes.length).toBeGreaterThan(0);
        expect(vdist(g0.flashes[0].pos, siteNow), 'flash ring = kernel site').toBeLessThan(1e-6);
        expect(g0.siteGroupRotY).toBeCloseTo(FG.siteRotation(g0.rotAngle, 14 * DEG), 12);
        for (const L of g0.loopRotations) {
            expect(L.rotY).toBeCloseTo(FG.siteRotation(g0.rotAngle, L.latRad), 12);
        }

        // The arcade + plume are up, on the prior, off the disk.
        expect(g0.arcade.active).toBe(true);
        expect(g0.arcade.loops).toBeGreaterThan(0);
        expect(g0.arcade.pil).toBe('prior');
        expect(g0.arcade.apexR).toBeGreaterThan(1.02);
        expect(g0.arcade.apexR).toBeCloseTo(1 + FG.arcadeHeight(g0.arcade.t, 'X'), 6);
        expect(g0.arcadeSite.cls).toBe('X');

        // Let the frame turn, fast.
        await page.evaluate(() => window.__sun.setSimSpeed(50));
        await page.waitForTimeout(2500);
        const g1 = await page.evaluate(() => window.__sun.flareGeometry);
        await page.evaluate(() => window.__sun.setSimSpeed(1));

        const dAng = g1.rotAngle - g0.rotAngle;
        expect(dAng, 'the accumulator advanced').toBeGreaterThan(0.01);
        expect(g1.uRotAngle).toBeCloseTo(g1.rotAngle, 12);
        expect(g1.site.lonRad0, 'the EPOCH site never moves').toBeCloseTo(g0.site.lonRad0, 12);
        expect(g1.shaderLon - g0.shaderLon, 'shader lon advances at this latitude\'s Snodgrass rate')
            .toBeCloseTo(dAng * diffRotFactor(14 * DEG), 9);
        expect(g1.siteNow[0], 'SENSE: a W30 site moves toward +x (west)').toBeGreaterThan(g0.siteNow[0]);
        // Everyone still agrees after turning.
        const regionLater = FG.sitePositionAt(14 * DEG, 30 * DEG, g1.rotAngle);
        expect(vdist(g1.slots[0], regionLater)).toBeLessThan(1e-6);
        const markerLater = g1.markers.find(m => m.lat === 14 && m.lon === 30);
        expect(vdist(markerLater.pos, regionLater)).toBeLessThan(1e-6);
        // The second region, at a different latitude, turned at ITS rate — not the equator's.
        const south = g1.markers.find(m => m.lat === -20 && m.lon === -60);
        expect(vdist(south.pos, FG.sitePositionAt(-20 * DEG, -60 * DEG, g1.rotAngle))).toBeLessThan(1e-6);
        expect(g1.siteGroupRotY).toBeCloseTo(FG.siteRotation(g1.rotAngle, 14 * DEG), 12);
        // The plume rose into space while the clock ran.
        expect(g1.arcade.t).toBeGreaterThan(g0.arcade.t);
        expect(g1.arcade.plume.front).toBeGreaterThan(1.05);
        expect(g1.arcade.plume.front).toBeCloseTo(FG.plumeState(g1.arcade.t, 'X').front, 6);

        // The flares toggle owns the arcade too.
        const setFlares = (on) => page.evaluate((v) => {
            const el = document.getElementById('tog-flares');
            if (el.checked !== v) { el.checked = v; el.dispatchEvent(new Event('change', { bubbles: true })); }
        }, on);
        await setFlares(false);
        await page.waitForTimeout(300);
        expect((await page.evaluate(() => window.__sun.flareGeometry)).arcade.active, 'arcade hidden with flares off').toBe(false);
        await setFlares(true);
        await page.waitForTimeout(300);
        expect((await page.evaluate(() => window.__sun.flareGeometry)).arcade.active, 'arcade back with flares on').toBe(true);

        const filtered = errors.filter((e) => !isExpectedNoise(e));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no unexpected console / shader-compile errors').toHaveLength(0);
    });

    test('a flare fired later lands at the requested Stonyhurst location NOW, not at load-time coordinates', async ({ page }) => {
        test.setTimeout(60_000);
        await boot(page);
        await page.evaluate(() => { window.__sun.setObserved(false); window.__sun.setSimSpeed(50); });
        await page.waitForTimeout(1500);
        await page.evaluate(() => window.__sun.setSimSpeed(1));
        const g = await page.evaluate(() => {
            window.__sun.testFlare('M', -8, 45);
            return window.__sun.flareGeometry;
        });
        expect(g.rotAngle).toBeGreaterThan(0.005);
        // The shader sees the site at W45 right now…
        expect(g.shaderLon).toBeCloseTo(45 * DEG, 9);
        // …which means the stored epoch longitude is W45 minus what the frame has turned at −8°.
        expect(g.site.lonRad0).toBeCloseTo(FG.epochLonFor(45 * DEG, g.rotAngle, -8 * DEG), 12);
        expect(vdist(g.siteNow, FG.stonyhurstToUnit(-8 * DEG, 45 * DEG))).toBeLessThan(1e-9);
        expect(g.arcadeSite.cls).toBe('M');
    });
});
