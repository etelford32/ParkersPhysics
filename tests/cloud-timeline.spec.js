import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';

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
 * GIBS is stubbed with synthetic PNGs (the build sandbox has no NASA
 * egress, and this gate must not need it). The same three URL flags the
 * atmo-stack gate uses make the volumetric path reachable on a software
 * rasteriser; see that spec for why each is load-bearing.
 */

// ── Minimal PNG encoder (RGBA, no interlace) — see cloud-mosaic-e2e.spec.js ──
function crc32(buf) {
    let c, table = crc32.table;
    if (!table) {
        table = crc32.table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c;
        }
    }
    c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}
function encodePng(width, height, rgbaFn) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6;
    const raw = Buffer.alloc(height * (1 + width * 4));
    for (let j = 0; j < height; j++) {
        const row = j * (1 + width * 4);
        raw[row] = 0;
        for (let i = 0; i < width; i++) {
            const [r, g, b, a] = rgbaFn(i, j);
            const o = row + 1 + i * 4;
            raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
        }
    }
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
// Banded IR (alternating overcast / clear stripes) so the mosaic carries
// structure; MODIS COT transparent (observed-clear).
const IR_PNG  = encodePng(64, 32, (i) => ((i >> 3) & 1) ? [235, 235, 235, 255] : [70, 70, 70, 255]);
const COT_PNG = encodePng(64, 32, () => [0, 0, 0, 0]);

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
        const gibs = [];
        await page.route('**wvs.earthdata.nasa.gov/**', async route => {
            const url = new URL(route.request().url());
            const layers = url.searchParams.get('LAYERS') ?? '';
            const time   = url.searchParams.get('TIME') ?? '';
            gibs.push({ layers, time, at: Date.now() });
            await route.fulfill({
                status: 200, contentType: 'image/png',
                headers: { 'Access-Control-Allow-Origin': '*' },
                body: /Cloud_Optical_Thickness/.test(layers) ? COT_PNG : IR_PNG,
            });
        });
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
