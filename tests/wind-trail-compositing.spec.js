import { test, expect } from '@playwright/test';

/**
 * wind-trail-compositing.spec.js — dense wind stays BLUE, never white.
 *
 * `node tests/wind-trail-compositor.mjs` pins the knee. This gate pins that
 * earth.html actually routes the trails through it and that the clip it
 * exists to remove is real:
 *
 *   1. On the compositor path, with the trail gain at ×4 (the test hook —
 *      the sandbox's synthetic field is sparse), the RAW offscreen sum has
 *      pixels past 1.0 (fracOver1 > 0): the additive clip would have
 *      happened. The knee bounds the output peak below 1.
 *   2. The night-side disc, with clouds / lights / atmosphere / imagery off
 *      so the trails are the only light on the globe, has (almost) no
 *      achromatic-white pixels among its lit pixels, and blue stays the
 *      dominant channel on nearly all of them.
 *   3. NEGATIVE CONTROL: the same frame on `?trailcomp=0` (the old additive
 *      path into ACES) DOES draw white — the gate can see the bug.
 *
 * Run with --workers=1 on the sandbox: parallel SwiftShader workers kill the
 * browser session (EARTHVIEW_VISUAL_DIALIN_PLAN.md §2).
 */

test.use({
    launchOptions: { args: ['--ignore-certificate-errors', '--allow-insecure-localhost'] },
    ignoreHTTPSErrors: true,
});
test.describe.configure({ timeout: 240_000 });

const OFF_LAYERS = ['lyr-clouds', 'lyr-obs-sst', 'lyr-lights', 'lyr-atm', 'lyr-obs-precip', 'lyr-obs-fires', 'lyr-obs-snow', 'lyr-isobars'];

async function nightDiscStats(page, query) {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    await page.goto('/earth.html' + query, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => typeof window.__evFrameStats === 'function' && typeof window.__evTrailCompositor === 'function',
        null, { timeout: 120_000 });
    await page.evaluate((ids) => {
        for (const id of ids) {
            const el = document.getElementById(id);
            if (el && el.checked) { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }
        }
    }, OFF_LAYERS);
    await page.waitForTimeout(3000);   // let the particles spread
    // Globe view, night side (the sun the page itself lights with).
    await page.evaluate(() => {
        const s = window.__evSunDir();
        window.__evSetCamDist(3.0);
        window.__evSetCamDir(-s[0], -s[1], -s[2]);
        window.setWindTrailBoost(4);
    });
    await page.waitForTimeout(3000);
    const out = await page.evaluate(() => {
        const comp = window.__evTrailCompositor({ step: 3 });
        // The disc: the centre 55 % of the shorter side (globe radius ≈ 0.41 H at 3 R).
        const cv = document.querySelector('canvas');
        const W = cv.width, H = cv.height;
        const side = Math.floor(Math.min(W, H) * 0.55);
        const frame = window.__evFrameStats({ x: (W - side) >> 1, y: (H - side) >> 1, w: side, h: side });
        return { comp, frame };
    });
    return { ...out, pageErrors };
}

test('compositor: the raw sum clips at ×4 gain, the output does not go white', async ({ page }) => {
    const { comp, frame, pageErrors } = await nightDiscStats(page, '');
    console.log('[trail-compositing] compositor', JSON.stringify({ comp: comp.stats, hdr: comp.hdr, size: comp.targetSize, frame }));
    expect(pageErrors, pageErrors.join('\n')).toHaveLength(0);
    expect(comp.enabled).toBe(true);
    expect(comp.active).toBe(true);
    expect(comp.hdr, 'HalfFloat sum target (the clip is only measurable above 1.0)').toBe(true);
    expect(comp.targetSize.width).toBeGreaterThan(100);
    // 1. the clip is real …
    expect(comp.stats.n).toBeGreaterThan(500);
    expect(comp.stats.fracOver1).toBeGreaterThan(0.02);
    expect(comp.stats.max).toBeGreaterThan(1.5);
    // … and the knee bounds it.
    expect(comp.stats.kneedMax).toBeLessThan(1);
    // 2. no white, blue dominant.
    expect(frame.lit).toBeGreaterThan(500);
    expect(frame.fracWhite).toBeLessThan(0.01);
    expect(frame.fracBlue).toBeGreaterThan(0.9);
});

test('negative control: the old additive path draws dense wind white', async ({ page }) => {
    const { comp, frame, pageErrors } = await nightDiscStats(page, '?trailcomp=0');
    console.log('[trail-compositing] additive', JSON.stringify({ enabled: comp.enabled, frame }));
    expect(pageErrors, pageErrors.join('\n')).toHaveLength(0);
    expect(comp.enabled).toBe(false);
    expect(frame.lit).toBeGreaterThan(500);
    expect(frame.fracWhite).toBeGreaterThan(0.02);
});
