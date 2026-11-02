/**
 * launch-planner-xbrowser.spec.js — the launch planner's 3D canvas in EVERY
 * engine Playwright ships: Chromium (the 'chromium' project) AND Firefox +
 * WebKit (the 'firefox-launch' / 'webkit-launch' projects in
 * playwright.config.js, run by .github/workflows/launch-planner.yml).
 *
 * Every other launch-planner gate is Chromium-only, and Safari/WebKit and
 * Firefox are exactly where this repo's silent breakages have lived (the
 * import-map ordering that killed mars.html in Firefox for seven weeks). This
 * spec is deliberately light — boot, judge the frame, check the framing — so
 * it can run on all three without ballooning CI.
 *
 * It judges the frame with the page's OWN verdict (`api.checkHealth()`, from
 * js/launch-render-health.js) — the same one a visitor's browser reports to
 * telemetry — and asserts that report is actually sent, so a device-only
 * failure in production becomes a queryable row:
 *   client_telemetry where kind = 'feature'
 *     and metadata->>'feature' = 'launch_vehicle_3d'
 *     and metadata->>'action'  = 'render_health'
 *
 * If an engine's headless build has no WebGL at all, the page's documented
 * "unavailable" fallback is the correct outcome: the test asserts that
 * fallback and records an annotation rather than passing silently.
 */
import { test, expect } from '@playwright/test';

test.describe('launch-planner 3D canvas — cross-browser', () => {
    test.setTimeout(240_000);

    test('boots, draws a healthy frame, frames the vehicle, reports its health', async ({ page, browserName }) => {
        const errors = [];
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => {
            if (m.type() === 'error' && /launch-vehicle-3d|shader|WebGL|THREE/i.test(m.text())) errors.push(`console: ${m.text()}`);
        });
        const reports = [];
        await page.route('**/api/telemetry/log', async (route) => {
            try {
                const body = route.request().postDataJSON();
                for (const ev of body?.events || []) {
                    if (ev?.metadata?.feature === 'launch_vehicle_3d') reports.push(ev.metadata);
                }
            } catch { /* not JSON — ignore */ }
            await route.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' });
        });
        await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());

        await page.goto('/launch-planner.html', { waitUntil: 'domcontentloaded' });
        const outcome = await Promise.race([
            page.waitForFunction(() => window.__lpVehicle3d?.checkHealth, null, { timeout: 120_000 }).then(() => 'api', () => 'timeout'),
            page.waitForFunction(() => /unavailable/i.test(document.querySelector('.lh-vehicle-canvas-host')?.innerText || ''),
                null, { timeout: 120_000 }).then(() => 'fallback', () => 'timeout'),
        ]);
        expect(outcome, 'neither the 3D API nor the no-WebGL fallback appeared').not.toBe('timeout');
        if (outcome === 'fallback') {
            test.info().annotations.push({ type: 'webgl-unavailable', description: `${browserName} headless has no WebGL; fallback shown` });
            expect(errors.filter((t) => t.startsWith('pageerror'))).toEqual([]);
            return;
        }

        await page.evaluate(() => {
            const el = document.querySelector('.lh-vehicle-canvas-host');
            window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 56);
        });
        const health = await page.evaluate(() => window.__lpVehicle3d.checkHealth());
        console.log(`[${browserName}] health`, JSON.stringify(health));
        expect(health.verdict, `frame verdict on ${browserName}: ${JSON.stringify(health)}`).toBe('ok');
        expect(health.shaderErrors, `shader link failures: ${health.firstShaderError}`).toBe(0);

        const framing = await page.evaluate(() => ({
            occ: window.__lpVehicle3d.measureOcclusion(),
            fg: window.__lpVehicle3d.measureForeground(),
        }));
        expect(framing.occ.ok, `vehicle hidden: ${JSON.stringify(framing.occ.examples)}`).toBe(true);
        expect(framing.fg.ok, `foreground clutter: ${JSON.stringify(framing.fg.items)}`).toBe(true);

        // The self-report reaches the telemetry endpoint (5 s flush timer).
        await expect.poll(() => reports.filter((r) => r.action === 'render_health').length,
            { timeout: 30_000, message: 'render_health telemetry was sent' }).toBeGreaterThan(0);
        const sent = reports.find((r) => r.action === 'render_health');
        for (const k of ['verdict', 'gpu', 'engine', 'quality', 'post', 'webgl2', 'shaderErrors']) {
            expect(sent, `telemetry payload carries ${k}`).toHaveProperty(k);
        }
        expect(errors).toEqual([]);
    });
});
