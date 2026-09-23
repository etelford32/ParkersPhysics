import { test, expect } from '@playwright/test';
import { installCloudRoutes, resolveCloudSource } from './helpers/cloud-source.mjs';

/**
 * cloud-timeline.spec.js — the cloud layer on the shared clock.
 *
 * Pins the Phase-4 contract (CLOUD_WIND_DEPTH_PLAN.md §6, js/cloud-time.js):
 *
 *   1. The satellite mosaic FOLLOWS THE TIME BUS. A scrub 3 h back fetches
 *      the archived 10-min frame by explicit timestamp (never a date-only
 *      reference granule), reports mode 'replay', and the frame on screen
 *      is the one at or just before the scrubbed instant.
 *   2. The near future is a NOWCAST of the newest frame (mode 'nowcast',
 *      confidence < 1, lead > 1 h, no extra network), and the deep future
 *      is MODEL ONLY — the mosaic weight tweens to 0. Painting "now" over a
 *      forecast globe is the one thing the layer must never do.
 *   3. Sim time is what the shaders see: with the bus frozen in scrub mode
 *      the flow-map phase does not move, so pause freezes the clouds and a
 *      revisited instant renders the same.
 *   4. The march renders through the half-resolution compositor, and every
 *      shader with the new uniforms (VOLUME_FRAG, CLOUD_FRAG, EARTH_FRAG)
 *      compiles — a GLSL error here surfaces as an invisible layer that is
 *      indistinguishable from "thin clouds today".
 *
 * GIBS is never hit for real here (the build sandbox has no NASA egress,
 * and this gate must not need it): tests/helpers/cloud-source.mjs answers
 * every request from REAL archived frames when `node
 * scripts/fetch-cloud-fixtures.mjs` has populated tests/fixtures/clouds/,
 * and from synthetic PNGs otherwise. tests/cloud-live.spec.js is the
 * opt-in gate that runs against the live archive. The same three URL
 * flags the atmo-stack gate uses make the volumetric path reachable on a
 * software rasteriser; see that spec for why each is load-bearing.
 */

const H = 3_600_000;
const floor10 = (ms) => Math.floor(ms / 600_000) * 600_000;
const stamp   = (ms) => new Date(ms).toISOString().slice(0, 16) + ':00Z';

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost', '--enable-unsafe-swiftshader'],
    },
    ignoreHTTPSErrors: true,
});

test.describe('cloud timeline', () => {
    test('mosaic follows the time bus; sim time drives the clouds; half-res march compiles', async ({ page }) => {
        test.setTimeout(180_000);
        // Fixture mode (real archived frames from disk) when the fetcher has
        // run; synthetic otherwise. Never live — that is cloud-live.spec.js.
        let source = resolveCloudSource();
        if (source.mode === 'live') source = { mode: 'synthetic', manifest: null };
        console.log(`[cloud-timeline] GIBS source: ${source.mode}${source.manifest ? ` (${source.manifest.frames.length} frames, fetched ${source.manifest.fetched})` : ''}`);
        const gibs = await installCloudRoutes(page, source);
        await page.route('**/api/telemetry/log', route =>
            route.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' }));

        const pageErrors = [];
        const shaderErrors = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));
        page.on('console', (msg) => {
            const t = msg.text();
            if (msg.type() === 'error' && /WebGLProgram|Shader Error|not compiled|VALIDATE_STATUS/i.test(t)) {
                shaderErrors.push(t.slice(0, 600));
            }
        });

        await page.goto('/earth.html?verdict=0&cloud_quality=1&volumetric=1&cloud_steps=6',
                        { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
            () => typeof window.__evCloudTime === 'function' && typeof window.__evCloudMode === 'function'
               && window._earthTimeBus,
            null, { timeout: 60_000 });

        // ── Live frame lands, on the volumetric path, through the half-res target
        // The first mosaic is five 2048×1024 normalisations on the main thread
        // (~10M pixel visits, chunked) on top of the boot — on a shared
        // software rasteriser that can take well over a minute.
        await page.waitForFunction(() => window.__evCloudTime().frameTimeMs != null, null, { timeout: 120_000 });
        await page.waitForTimeout(1500);
        const live = await page.evaluate(() => window.__evCloudTime());
        expect(live.mode).toBe('live');
        expect(live.weight).toBeGreaterThan(0.95);
        expect(Math.abs(live.leadSec)).toBeLessThan(45 * 60);      // lag + one cadence
        expect(await page.evaluate(() => window.__evCloudMode())).toBe('volumetric');
        expect(live.resScale).toBe(0.5);
        const drawW = await page.evaluate(() => {
            const c = document.querySelector('canvas');
            return c ? c.width : 0;
        });
        expect(live.target.width).toBeGreaterThan(0);
        expect(live.target.width).toBeLessThanOrEqual(Math.round(drawW * 0.5) + 1);

        // Live requests carry real timestamps (the pre-existing contract).
        expect(gibs.filter(r => r.time.includes('T')).length).toBeGreaterThanOrEqual(4);

        // ── 1. Replay: scrub 3 h back → an explicit archived frame ────────────
        const t0 = Date.now() - 3 * H;
        const nBefore = gibs.length;
        await page.evaluate((t) => window._earthTimeBus.setSimTime(t, { fromUser: true }), t0);
        // (weight is TWEENED — it dips to 0.5 while the frame is in flight and
        // climbs back once it lands; wait for the climb, not just the mode)
        await page.waitForFunction((t) => {
            const s = window.__evCloudTime();
            return s.mode === 'replay' && s.frameTimeMs != null && s.frameTimeMs <= t
                && t - s.frameTimeMs < 11 * 60_000 && s.weight > 0.95;
        }, t0, { timeout: 60_000 });
        const replay = await page.evaluate(() => window.__evCloudTime());
        expect(replay.mode).toBe('replay');
        expect(replay.weight).toBeGreaterThan(0.95);
        expect(replay.frameTimeMs).toBe(floor10(t0));
        // The frame was requested BY TIMESTAMP at the scrubbed instant, and
        // no date-only reference granule was asked for on the way.
        const replayReqs = gibs.slice(nBefore).filter(r => !/Cloud_Optical_Thickness/.test(r.layers));
        expect(replayReqs.length).toBeGreaterThanOrEqual(4);
        expect(replayReqs.some(r => r.time === stamp(floor10(t0)))).toBe(true);
        expect(replayReqs.every(r => r.time.includes('T'))).toBe(true);
        // The lead the shaders advect by is sim time − frame time: minutes, not hours.
        expect(replay.leadSec).toBeGreaterThanOrEqual(0);
        expect(replay.leadSec).toBeLessThan(11 * 60);

        // ── 3. Frozen bus ⇒ frozen flow phase (pause freezes the clouds) ──────
        const flowA = await page.evaluate(() => window.__evCloudTime().flow);
        await page.waitForTimeout(400);
        const flowB = await page.evaluate(() => window.__evCloudTime().flow);
        expect(flowB).toEqual(flowA);

        // ── 2a. Nowcast: +1 h → the newest frame, advected, at reduced weight
        const nNow = gibs.length;
        await page.evaluate((t) => window._earthTimeBus.setSimTime(t, { fromUser: true }), Date.now() + 1 * H);
        await page.waitForFunction(() => window.__evCloudTime().mode === 'nowcast', null, { timeout: 30_000 });
        await page.waitForTimeout(800);
        const nowcast = await page.evaluate(() => window.__evCloudTime());
        expect(nowcast.targetWeight).toBeLessThan(1);
        expect(nowcast.targetWeight).toBeGreaterThan(0.35);
        expect(nowcast.leadSec).toBeGreaterThan(3600);
        expect(nowcast.describe).toMatch(/Nowcast/);
        // No archived-frame fetch for the future: nothing to fetch.
        const futureReqs = gibs.slice(nNow).filter(r => Date.parse(r.time) > Date.now());
        expect(futureReqs).toEqual([]);

        // ── 2b. Model only: +8 h → weight tweens to 0, disclosure says so ─────
        await page.evaluate((t) => window._earthTimeBus.setSimTime(t, { fromUser: true }), Date.now() + 8 * H);
        await page.waitForFunction(() => window.__evCloudTime().mode === 'model', null, { timeout: 30_000 });
        // The tween runs at wall-clock rate; on a 1 fps software rasteriser it
        // takes a few frames to settle, so poll for it.
        await page.waitForFunction(() => window.__evCloudTime().weight < 0.03, null, { timeout: 30_000 });
        const model = await page.evaluate(() => window.__evCloudTime());
        expect(model.targetWeight).toBe(0);
        expect(model.weight).toBeLessThan(0.03);
        expect(model.describe).toMatch(/Model cloud only/);
        // The Cloud Cover ROW tooltip carries the disclosure (the status pip
        // belongs to the weather-grid pipeline, which writes its own title).
        const rowTitle = await page.evaluate(() => document.getElementById('lyr-clouds')?.parentElement?.title ?? '');
        expect(rowTitle).toMatch(/Model cloud only/);

        // ── Back to now: live again, weight recovers ──────────────────────────
        await page.evaluate(() => window._earthTimeBus.setSimTime(Date.now(), { fromUser: true }));
        await page.waitForFunction(() => window.__evCloudTime().mode === 'live' && window.__evCloudTime().weight > 0.95,
                                   null, { timeout: 30_000 });

        expect(shaderErrors, 'VOLUME_FRAG / CLOUD_FRAG / EARTH_FRAG must compile').toEqual([]);
        expect(pageErrors).toEqual([]);
    });
});
