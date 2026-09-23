import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    installCloudRoutes, decodePng, rectStats, rectDiff, discRect, ROOT,
} from './helpers/cloud-source.mjs';
import { probeArchive } from '../scripts/fetch-cloud-fixtures.mjs';

/**
 * cloud-live.spec.js — the cloud layer against the REAL world.
 *
 * Opt-in (CLOUD_LIVE=1): nothing is stubbed. NASA GIBS and the weather API
 * are hit for real, from the dev server or from production:
 *
 *   CLOUD_LIVE=1 npx playwright test tests/cloud-live.spec.js --headed
 *   TEST_BASE_URL=https://parkersphysics.com CLOUD_LIVE=1 npx playwright test tests/cloud-live.spec.js
 *
 * `--headed` puts Chromium on the machine's GPU (headless runs on
 * SwiftShader); CLOUD_STEPS=12 caps the march if the run is too slow.
 *
 * What it proves that the stubbed gates cannot:
 *   1. The live mosaic is a real geostationary composite: ≥ 2 discs, recent
 *      (≤ 2 h), covering most of the globe, with an IR top channel, and its
 *      pixels are neither empty nor saturated.
 *   2. The weather grid is live (not the procedural demo) and the wind the
 *      advection reads is a real field.
 *   3. A scrub 3 h back fetches the ARCHIVED frame at that timestamp and
 *      the archive actually serves it (HTTP 200 + image/*) for ≥ 2 regions;
 *      the mosaic on screen changes (different fingerprint); scrubbing back
 *      to now restores the live frame from the cache.
 *   4. The near future is a nowcast at reduced confidence; the deep future
 *      is model-only (weight 0).
 *   5. On real data, a paused instant renders steadily (two screenshots
 *      differ only by the march jitter) — measured against the size of the
 *      change between live and the +8 h model frame.
 *   6. The archive's reach: which leads (1 h … 60 d) GIBS still serves. The
 *      −7 d bus window MUST be inside it; the 30 d assumption in
 *      js/cloud-time.js MOSAIC.retentionMs is reported against the
 *      measurement so it can be corrected.
 *
 * Every number lands in test-results/cloud-live/report.json alongside the
 * screenshots (live, replay, nowcast, model) for eyeballing the render.
 */

const LIVE = process.env.CLOUD_LIVE === '1';
const H = 3_600_000;
const floor10 = (ms) => Math.floor(ms / 600_000) * 600_000;
const stamp   = (ms) => new Date(ms).toISOString().slice(0, 16) + ':00Z';
const OUT     = join(ROOT, 'test-results', 'cloud-live');

const summarizeDiag = (d) => d ? {
    mode: d.mode, ms: d.ms, requestedMs: d.requestedMs ?? null,
    regions: d.regions, polar: d.polar, composite: d.composite,
    attempts: d.attempts.length, failures: d.attempts.filter(a => !a.ok).length,
} : null;

test.use({
    launchOptions: {
        args: ['--ignore-certificate-errors', '--allow-insecure-localhost', '--enable-unsafe-swiftshader'],
    },
    ignoreHTTPSErrors: true,
});

test.describe('cloud layer — LIVE data', () => {
    test.skip(!LIVE, 'opt-in: CLOUD_LIVE=1 (needs a network path to earthdata.nasa.gov)');

    test('real GIBS frames follow the time bus; real wind drives the advection; archive reach is measured', async ({ page }, testInfo) => {
        test.setTimeout(12 * 60_000);
        mkdirSync(OUT, { recursive: true });
        const report = { startedAt: new Date().toISOString(), baseURL: testInfo.project.use.baseURL };

        const gibs = await installCloudRoutes(page, { mode: 'live' });
        const responses = [];
        page.on('response', (res) => {
            const u = res.url();
            if (!u.includes('wvs.earthdata.nasa.gov')) return;
            const url = new URL(u);
            responses.push({
                layers: url.searchParams.get('LAYERS') ?? '', time: url.searchParams.get('TIME') ?? '',
                status: res.status(), contentType: res.headers()['content-type'] ?? '',
            });
        });
        await page.addInitScript(() => {
            window.__wxMetas = [];
            document.addEventListener('weather-update', (e) => {
                const m = e.detail?.meta ?? {};
                window.__wxMetas.push({ demo: !!m.demo, source: m.source ?? null, replay: !!e.detail?.replay, t: Date.now() });
            });
        });
        const pageErrors = [], shaderErrors = [];
        page.on('pageerror', (err) => pageErrors.push(err.message));
        page.on('console', (msg) => {
            const t = msg.text();
            if (msg.type() === 'error' && /WebGLProgram|Shader Error|not compiled|VALIDATE_STATUS/i.test(t)) shaderErrors.push(t.slice(0, 600));
        });

        const steps = process.env.CLOUD_STEPS ? `&cloud_steps=${Number(process.env.CLOUD_STEPS) | 0}` : '';
        await page.goto(`/earth.html?verdict=0&cloud_quality=1&volumetric=1${steps}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
            () => typeof window.__evCloudTime === 'function' && typeof window.__evCloudMosaic === 'function'
               && typeof window.__evCloudWind === 'function' && window._earthTimeBus,
            null, { timeout: 90_000 });
        // Park the camera: the screenshots below are compared to each other.
        await page.evaluate(() => {
            const el = document.getElementById('lyr-rotate');
            if (el?.checked) { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
        });

        // ── 1. The live mosaic is a real, recent geostationary composite ──────
        await page.waitForFunction(() => window.__evCloudTime().frameTimeMs != null && window.__evCloudMosaic() != null,
                                   null, { timeout: 240_000 });
        await page.waitForTimeout(2500);
        const diagLive = await page.evaluate(() => window.__cloudDiag);
        const live     = await page.evaluate(() => window.__evCloudTime());
        const mosLive  = await page.evaluate(() => window.__evCloudMosaic());
        report.live = { diag: summarizeDiag(diagLive), timing: live, mosaic: mosLive,
                        cloudMode: await page.evaluate(() => window.__evCloudMode()) };
        expect(diagLive?.mode, 'GIBS answered with a geostationary mosaic (not the MODIS fallback)').toBe('mosaic');
        expect(diagLive.regions.length, 'at least two geostationary discs loaded').toBeGreaterThanOrEqual(2);
        expect.soft(diagLive.regions.length, 'all four discs loaded').toBeGreaterThanOrEqual(4);
        expect(diagLive.composite.coverage, 'composite covers most of the globe').toBeGreaterThan(0.5);
        const ages = diagLive.regions.map(r => r.ageMin).filter(a => a != null);
        expect(ages.length).toBeGreaterThan(0);
        expect(Math.min(...ages), 'newest disc is recent').toBeLessThanOrEqual(120);
        expect(live.mode).toBe('live');
        expect(mosLive.meanCloud, 'mosaic is not empty').toBeGreaterThan(0.05);
        expect(mosLive.meanCloud, 'mosaic is not saturated').toBeLessThan(0.95);
        expect(mosLive.meanConf, 'observation confidence over the globe').toBeGreaterThan(0.3);
        expect.soft(mosLive.hasIR, 'an IR product contributed (cloud-top heights)').toBe(true);

        // ── 2. The weather grid is live and the wind is a real field ──────────
        await page.waitForFunction(() => window.__wxMetas.length > 0, null, { timeout: 60_000 });
        const metas    = await page.evaluate(() => window.__wxMetas);
        const lastLive = [...metas].reverse().find(m => !m.replay);
        const wind     = await page.evaluate(() => window.__evCloudWind());
        report.weather = { source: lastLive?.source ?? null, demo: lastLive?.demo ?? null, wind };
        expect.soft(lastLive?.demo, `weather grid is live, not the synthetic demo (source: ${lastLive?.source})`).toBe(false);
        if (lastLive && !lastLive.demo) {
            expect(wind.meanSpeedMs, 'global mean 10 m wind speed is a real number of m/s').toBeGreaterThan(1.0);
            expect(wind.meanSpeedMs).toBeLessThan(30);
        }

        // ── 3. Screenshots at live, twice (the march jitter is the only change)
        const A1 = await page.screenshot({ path: join(OUT, 'live-A1.png') });
        await page.waitForTimeout(800);
        const A2 = await page.screenshot({ path: join(OUT, 'live-A2.png') });

        // ── 4. Replay: the archived frame at −3 h, by timestamp ───────────────
        const t0 = Date.now() - 3 * H;
        const nReq = gibs.length, nResp = responses.length;
        await page.evaluate((t) => window._earthTimeBus.setSimTime(t, { fromUser: true }), t0);
        await page.waitForFunction((t) => {
            const s = window.__evCloudTime();
            return s.mode === 'replay' && s.frameTimeMs != null && t - s.frameTimeMs < 40 * 60_000 && s.weight > 0.95;
        }, t0, { timeout: 300_000 });
        await page.waitForTimeout(2500);
        const replay     = await page.evaluate(() => window.__evCloudTime());
        const mosReplay  = await page.evaluate(() => window.__evCloudMosaic());
        const diagReplay = await page.evaluate(() => window.__cloudDiag);
        const want = stamp(floor10(t0));
        const replayResp = responses.slice(nResp).filter(r => !/Cloud_Optical_Thickness/.test(r.layers));
        const servedAtT0 = replayResp.filter(r => r.time === want && r.status === 200 && r.contentType.startsWith('image/'));
        report.replay = {
            requestedStamp: want, timing: replay, mosaic: mosReplay, diag: summarizeDiag(diagReplay),
            requests: gibs.slice(nReq).map(r => `${r.layers.slice(0, 28)}@${r.time}`),
            servedAtExactTime: servedAtT0.map(r => r.layers.slice(0, 28)),
        };
        expect(replayResp.every(r => r.time.includes('T')), 'replay requests carry timestamps, never a date-only granule').toBe(true);
        expect(servedAtT0.length, `the archive served the exact frame ${want} for ≥ 2 regions`).toBeGreaterThanOrEqual(2);
        expect(diagReplay?.requestedMs, 'the fetch was an explicit request for the scrubbed frame').toBe(floor10(t0));
        expect(mosReplay.hash, 'the mosaic on screen is a DIFFERENT observation than the live one').not.toBe(mosLive.hash);
        expect(replay.leadSec).toBeGreaterThanOrEqual(0);
        expect(replay.leadSec).toBeLessThan(45 * 60);
        const B1 = await page.screenshot({ path: join(OUT, 'replay-B1.png') });
        await page.waitForTimeout(800);
        const B2 = await page.screenshot({ path: join(OUT, 'replay-B2.png') });

        // ── 5a. Nowcast ───────────────────────────────────────────────────────
        await page.evaluate((t) => window._earthTimeBus.setSimTime(t, { fromUser: true }), Date.now() + 1 * H);
        await page.waitForFunction(() => window.__evCloudTime().mode === 'nowcast', null, { timeout: 60_000 });
        await page.waitForTimeout(1500);
        const nowcast = await page.evaluate(() => window.__evCloudTime());
        report.nowcast = nowcast;
        expect(nowcast.targetWeight).toBeLessThan(1);
        expect(nowcast.targetWeight).toBeGreaterThan(0.35);
        expect(nowcast.leadSec).toBeGreaterThan(3600);
        await page.screenshot({ path: join(OUT, 'nowcast-C.png') });

        // ── 5b. Model only ────────────────────────────────────────────────────
        await page.evaluate((t) => window._earthTimeBus.setSimTime(t, { fromUser: true }), Date.now() + 8 * H);
        await page.waitForFunction(() => window.__evCloudTime().mode === 'model', null, { timeout: 60_000 });
        await page.waitForFunction(() => window.__evCloudTime().weight < 0.03, null, { timeout: 60_000 });
        await page.waitForTimeout(1000);
        report.model = await page.evaluate(() => window.__evCloudTime());
        expect(report.model.targetWeight).toBe(0);
        const D = await page.screenshot({ path: join(OUT, 'model-D.png') });

        // ── 6. Back to now: the live frame comes back from the cache ──────────
        const nReq2 = gibs.length;
        await page.evaluate(() => window._earthTimeBus.setSimTime(Date.now(), { fromUser: true }));
        await page.waitForFunction(() => window.__evCloudTime().mode === 'live' && window.__evCloudTime().weight > 0.95,
                                   null, { timeout: 60_000 });
        await page.waitForTimeout(1500);
        const mosBack = await page.evaluate(() => window.__evCloudMosaic());
        const refetched = gibs.slice(nReq2).length;
        report.back = { mosaic: mosBack, newRequests: refetched, restoredLiveFrame: mosBack.hash === mosLive.hash };
        // The 10-min poll may legitimately have replaced the live frame while
        // the test ran; otherwise the cache must answer with no network.
        expect.soft(mosBack.hash === mosLive.hash || refetched > 0,
                    'live frame restored from the frame cache (or refreshed by the poll)').toBe(true);

        // ── 7. Pixel measures on the screenshots ──────────────────────────────
        const rect = discRect(1280, 720);
        const dA1 = decodePng(A1), dA2 = decodePng(A2), dB1 = decodePng(B1), dB2 = decodePng(B2), dD = decodePng(D);
        const px = {
            live:        rectStats(dA1, rect),
            replay:      rectStats(dB1, rect),
            model:       rectStats(dD, rect),
            liveJitter:  rectDiff(dA1, dA2, rect),
            pausedPair:  rectDiff(dB1, dB2, rect),
            liveVsReplay: rectDiff(dA1, dB1, rect),
            liveVsModel: rectDiff(dA1, dD, rect),
        };
        report.pixels = px;
        // A paused instant is steady: the only frame-to-frame change is the
        // march jitter, which is far smaller than a real change of state.
        expect(px.pausedPair, 'paused replay frame is steady').toBeLessThan(Math.max(3.0, 0.35 * px.liveVsModel));
        expect(px.liveVsReplay, 'three hours of weather moved the picture').toBeGreaterThan(px.liveJitter);

        // ── 8. Archive reach (node-side fetch, no browser) ────────────────────
        console.log('  archive reach probe:');
        const probe = await probeArchive({ log: (line) => console.log('    ' + line) });
        report.archive = probe;
        const at = (h) => probe.results.find(r => r.leadHours === h)?.ok === true;
        expect(at(168), 'the time bus window (−7 d) is inside the GIBS archive').toBe(true);
        expect.soft(at(720), 'MOSAIC.retentionMs assumes 30 d — the probe disagrees; record the measured reach in js/cloud-time.js').toBe(true);

        writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');
        console.log([
            '',
            `  live    ${diagLive.regions.length} discs · coverage ${(diagLive.composite.coverage * 100).toFixed(0)}% · newest ${Math.min(...ages)} min · mean cloud ${mosLive.meanCloud.toFixed(2)}`,
            `  wind    ${lastLive?.demo ? 'DEMO (grid feed down)' : lastLive?.source} · mean |v| ${wind.meanSpeedMs.toFixed(1)} m/s`,
            `  replay  ${want} served for ${servedAtT0.length} regions · frame ${new Date(replay.frameTimeMs).toISOString().slice(11, 16)}Z · hash ${mosLive.hash} → ${mosReplay.hash}`,
            `  pixels  jitter ${px.liveJitter.toFixed(2)} · paused ${px.pausedPair.toFixed(2)} · live→replay ${px.liveVsReplay.toFixed(2)} · live→model ${px.liveVsModel.toFixed(2)}`,
            `  archive oldest lead served ${probe.oldestOkHours == null ? 'none' : probe.oldestOkHours + ' h (' + (probe.oldestOkHours / 24).toFixed(1) + ' d)'}`,
            `  report  ${join(OUT, 'report.json')}`,
            '',
        ].join('\n'));

        expect(shaderErrors, 'shaders compile on this GPU').toEqual([]);
        expect(pageErrors).toEqual([]);
    });
});
