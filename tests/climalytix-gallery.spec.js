/**
 * climalytix-gallery.spec.js — the VISUAL GALLERY for the polish pass (plan §19
 * "visuals"). Not a gate: it only runs with CX_GALLERY=<dir> and writes one
 * frame per map layer from the SAME view on the self-hosted Blue Marble ground
 * (GIBS mocked down, so the mocked checkerboard tiles never stand in for
 * imagery), plus each layer's rail panel. Run it before and after a visual
 * change and compare the two directories side by side.
 *
 *   CX_GALLERY=validation-output/climalytix/gallery-before npx playwright test tests/climalytix-gallery.spec.js
 */
import { test } from '@playwright/test';
import { installClimalytixMocks } from './fixtures/climalytix-mocks.mjs';

const OUT = process.env.CX_GALLERY;
test.skip(!OUT, 'gallery only: set CX_GALLERY=<dir>');

// A synthetic range west of the site: a NNW–SSE spine of peaks, spurs and valleys.
const peaks = [];
for (let k = 0; k < 9; k++) peaks.push([40.7 - k * 0.17, -105.62 - 0.06 * Math.sin(k * 1.7), 1500 + 500 * Math.sin(k * 2.3), 0.09]);
peaks.push([39.95, -105.95, 1200, 0.14], [40.35, -105.9, 900, 0.12], [40.05, -105.42, 600, 0.06], [39.75, -105.4, 500, 0.07]);
function range(lat, lon) {
    let h = 1650 + 900 / (1 + Math.exp((lon + 105.45) / 0.08));
    for (const [a, b, H, s] of peaks) h += H * Math.exp(-(((lat - a) ** 2 + ((lon - b) * 0.766) ** 2) / (s * s)));
    return h + 50 * Math.sin(lat * 23 + lon * 9) * Math.cos(lon * 31 - lat * 7);
}

const H = 3_600_000;
const next = (h) => { let t = Math.floor(Date.now() / 86_400_000) * 86_400_000 + h * H; while (t < Date.now() + 4 * H) t += 86_400_000; return t; };

// [file, layer checkbox (or null), zoom steps from the boot view, rail element, extra setup]
const SHOTS = [
    ['01-temperature', null, 0, '#cx-heat-key'],
    ['02-airflow', '#cx-layer-airflow', 0, '#cx-flow-status'],
    ['03-air-quality', '#cx-layer-aq', 0, '#cx-aq-status'],
    ['04-elevation', '#cx-layer-elev', 3, '#cx-dem-status'],
    ['05-sun-exposure', '#cx-layer-exp', 3, '#cx-dem-status'],
    ['06-orographic', '#cx-layer-oro', 3, '#cx-oro-status'],
    ['07-slope-winds', '#cx-layer-slope', 3, '#cx-slope-status'],
    ['08-thermals', '#cx-layer-th', 0, '#cx-th-status'],
    ['09-updraft', '#cx-layer-up', 0, '#cx-up-status'],
    ['10-storm-outlook', '#cx-layer-cv', 0, '#cx-cv-status'],
];

for (const [name, layer, zoom, rail] of SHOTS) {
    test(name, async ({ page }) => {
        test.setTimeout(120_000);
        await page.setViewportSize({ width: 1366, height: 900 });
        await installClimalytixMocks(page, { demHeight: range, gibs: 'down' });
        await page.addInitScript(() => {
            localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            localStorage.setItem('ppx_user_location', JSON.stringify({ lat: 40.015, lon: -105.271, city: 'Boulder, CO' }));
            localStorage.setItem('ppx_tour_completed', '1');
        });
        await page.goto('/climalytix.html');
        await page.waitForFunction(() => window.__climalytix?.state?.map?.drawn?.heat, null, { timeout: 60_000 });
        await page.evaluate(() => document.querySelectorAll('.pp-consent-banner,.tour-overlay,.tour-tooltip').forEach((e) => e.remove()));
        await page.evaluate((t) => window.__climalytix.map.setTime(t), next(20) + 0.5 * H);
        if (name !== '02-airflow') await page.locator('#cx-layer-airflow').uncheck();
        if (layer && name !== '02-airflow') await page.locator(layer).check();
        await page.evaluate((n) => { for (let k = 0; k < n; k++) window.__climalytix.map.act('zoom-in'); }, zoom);
        await page.waitForTimeout(2500);
        await page.locator('#cx-map-canvas').scrollIntoViewIfNeeded();
        await page.mouse.move(5, 5);
        await page.waitForTimeout(400);
        await page.locator('#cx-map-stage').screenshot({ path: `${OUT}/${name}-map.png` });
        const r = page.locator(rail);
        if (await r.count() && await r.isVisible()) {
            await r.scrollIntoViewIfNeeded();
            await r.screenshot({ path: `${OUT}/${name}-rail.png` });
        }
    });
}

test('00-page-overview', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await installClimalytixMocks(page, { demHeight: range, gibs: 'down' });
    await page.addInitScript(() => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('ppx_user_location', JSON.stringify({ lat: 40.015, lon: -105.271, city: 'Boulder, CO' }));
        localStorage.setItem('ppx_tour_completed', '1');
    });
    await page.goto('/climalytix.html');
    await page.waitForFunction(() => window.__climalytix?.state?.map?.drawn?.heat, null, { timeout: 60_000 });
    await page.evaluate(() => document.querySelectorAll('.pp-consent-banner,.tour-overlay,.tour-tooltip').forEach((e) => e.remove()));
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/00-page-top.png` });
    await page.screenshot({ path: `${OUT}/00-page-full.png`, fullPage: true });
    await page.addStyleTag({ content: 'nav, .pp-nav, #site-nav { visibility:hidden !important; }' });
    const ex = page.locator('#cx-explore');
    await ex.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await ex.screenshot({ path: `${OUT}/11-explore.png` });
    // Hover a chart so the crosshair + tooltip are in the frame.
    const svg = page.locator('#cx-explore svg').first();
    const b = await svg.boundingBox();
    if (b) { await page.mouse.move(b.x + b.width * 0.62, b.y + b.height * 0.5); await page.waitForTimeout(300); }
    await page.locator('#cx-explore').screenshot({ path: `${OUT}/12-explore-hover.png` });
});
