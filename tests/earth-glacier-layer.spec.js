/**
 * earth-glacier-layer.spec.js — the Glaciers layer on EarthView (earth.html)
 * ═══════════════════════════════════════════════════════════════════════════
 *   npx playwright test tests/earth-glacier-layer.spec.js --workers=1
 *
 * The archive is the real committed data/glaciers/*; nothing upstream is called. Pins:
 *   1. OFF at boot and NOTHING fetched until the first enable (the Volcanoes rule);
 *      enabling draws all glaciers and the pip states the archive date;
 *   2. flown to 600 km over Great Aletsch (?at=), hovering its marker shows the engine's
 *      numbers from the summary — not Rhône's or Mer de Glace's, ~50 px away — and a tap
 *      pins the deep link into glacier-watch.html?g=aletsch;
 *   3. PIXEL picking: a bare-canvas spot ≥ 40 px from every marker picks nothing, and a
 *      tap there releases the pin (a pinned tip takes pointer events for its link, so the
 *      spot is chosen by elementFromPoint, never a fixed offset that can land on the tip);
 *   4. the flowline dots MOVE between frames, and the flowline toggle hides them (and
 *      asking for flowlines switches the layer on);
 *   5. NEGATIVE CONTROL: a missing summary turns the pip to error with the reason, draws
 *      nothing and throws nothing — never a quiet, healthy-looking empty layer.
 */
import { test, expect } from '@playwright/test';

async function boot(page, { url = '/earth.html', summary = true } = {}) {
    const hits = { summary: 0, index: 0 };
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api.open-meteo.com/**', r => r.fulfill({ json: { hourly: { time: [] }, daily: { time: [] } } }));
    await page.route('**/air-quality-api.open-meteo.com/**', r => r.fulfill({ json: { hourly: { time: [], us_aqi: [] } } }));
    if (!summary) await page.route('**/data/glaciers/summary.json', r => r.fulfill({ status: 404, body: 'not found' }));
    page.on('request', req => {
        if (req.url().includes('/data/glaciers/summary.json')) hits.summary++;
        if (req.url().includes('/data/glaciers/glaciers.json')) hits.index++;
    });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__glacierLayer, null, { timeout: 45_000 });
    await page.evaluate(() => document.querySelector('.pp-consent-banner')?.remove());
    return { hits, errors };
}

async function enable(page) {
    await page.evaluate(() => {
        const r = document.getElementById('lyr-rotate');
        if (r) { r.checked = false; r.dispatchEvent(new Event('change', { bubbles: true })); }
        const el = document.getElementById('lyr-glaciers');
        el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

test.describe('EarthView glacier layer', () => {
    // earth.html boots slowly on a software rasteriser (CLAUDE.md: its loads exceed 60 s
    // budgets in the sandbox); the assertions are unchanged, only the budget is.
    test.describe.configure({ timeout: 180_000 });

    test('off at boot, lazy archive, all glaciers on enable', async ({ page }) => {
        const { hits, errors } = await boot(page);
        await expect(page.locator('#lyr-glaciers')).not.toBeChecked();
        expect(await page.evaluate(() => window.__glacierLayer.group.visible)).toBe(false);
        await page.waitForTimeout(1500);
        expect(hits.summary + hits.index, 'glacier archive not fetched before the first enable').toBe(0);
        await enable(page);
        await page.waitForFunction(() => !!window.__glacierLayer.summary, null, { timeout: 30_000 });
        const s = await page.evaluate(() => ({
            n: window.__glacierLayer.summary.glaciers.length, asOf: window.__glacierLayer.summary.as_of,
            count: document.getElementById('glaciers-count').textContent,
            pip: document.querySelector('.lyr-status[data-layer="glaciers"]')?.title ?? '',
        }));
        expect(s.n).toBeGreaterThanOrEqual(25);
        expect(s.count).toContain(String(s.n));
        expect(s.pip).toContain(`as of ${s.asOf}`);
        expect(s.pip).toMatch(/below detection/);
        expect(errors).toEqual([]);
    });

    test('hover shows the engine numbers; tap pins the deep link; picking is in pixels', async ({ page }) => {
        const { errors } = await boot(page, { url: '/earth.html?at=46.48,8.03,600' });
        await enable(page);
        await page.waitForFunction(() => !!window.__glacierLayer.summary, null, { timeout: 30_000 });
        await page.waitForFunction(() => (window.__glacierAtCenter('aletsch')?.facing ?? 0) > 0.995, null, { timeout: 30_000 });
        await page.waitForTimeout(800);
        const t = await page.evaluate(() => window.__glacierAtCenter('aletsch'));
        const onCanvas = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, t);
        expect(onCanvas, 'the Aletsch marker is not under page chrome').toBe('CANVAS');
        await page.mouse.move(t.x, t.y);
        const tip = page.locator('#glacier-tip');
        await expect(tip).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#glacier-tip-name')).toHaveText('Great Aletsch Glacier');
        const { want, asOf } = await page.evaluate(() => ({ want: window.__glacierLayer.summary.glaciers.find(g => g.id === 'aletsch'), asOf: window.__glacierLayer.summary.as_of }));
        await expect(page.locator('#glacier-tip-pairs')).toContainText(`${want.pairs_year} satellite pairs`);
        await expect(page.locator('#glacier-tip-mb')).toContainText('WGMS');
        await expect(page.locator('#glacier-tip-hint')).toContainText(`as of ${asOf}`);

        await page.mouse.click(t.x, t.y);
        await expect(tip).toHaveClass(/pinned/);
        expect(await page.locator('#glacier-tip-hint a').getAttribute('href')).toBe('glacier-watch.html?g=aletsch');

        // pixel picking: 40 px off the marker is empty globe for this layer — a tap there
        // releases the pin, and hovering there shows no glacier
        // earth.html drops a second tap inside 400 ms as the click echo of the first
        // (_onPrimaryTap's dedup); a human second tap comes later than that
        await page.waitForTimeout(600);
        // a pinned tip takes pointer events (its link must be clickable) and sits below-right
        // of the tap, so find a spot ≥ 40 px from EVERY marker that is bare canvas
        const away = await page.evaluate(({ x, y }) => {
            const L = window.__glacierLayer, cam = [];
            for (let i = 0; i < L.summary.glaciers.length; i++) { const p = window.__glacierAtCenter(L.summary.glaciers[i].id); if (p) cam.push(p); }
            for (const [dx, dy] of [[0, -90], [-90, 0], [90, -90], [-90, -90], [0, 120], [150, 0]]) {
                const px = x + dx, py = y + dy;
                if (document.elementFromPoint(px, py)?.tagName !== 'CANVAS') continue;
                if (cam.every(m => Math.hypot(m.x - px, m.y - py) >= 40)) return { x: px, y: py };
            }
            return null;
        }, t);
        expect(away, 'a bare-canvas spot away from every glacier marker').toBeTruthy();
        await page.mouse.click(away.x, away.y);
        await expect(tip).not.toHaveClass(/pinned/);
        await page.mouse.move(away.x, away.y);
        await expect(tip).toBeHidden();
        expect(errors).toEqual([]);
    });

    test('flowline dots move; the flow toggle hides them and switches the layer on', async ({ page }) => {
        await boot(page);
        await page.evaluate(() => { const f = document.getElementById('lyr-glacier-flow'); f.checked = false; f.dispatchEvent(new Event('change')); f.checked = true; f.dispatchEvent(new Event('change')); });
        await page.waitForFunction(() => window.__glacierLayer.group.visible && !!window.__glacierLayer._dots, null, { timeout: 30_000 });
        const a = await page.evaluate(() => Array.from(window.__glacierLayer._dotPos.slice(0, 30)));
        await page.waitForTimeout(1200);
        const b = await page.evaluate(() => Array.from(window.__glacierLayer._dotPos.slice(0, 30)));
        expect(a.some((v, i) => Math.abs(v - b[i]) > 1e-7), 'dots advanced along the flowlines').toBe(true);
        await page.evaluate(() => { const f = document.getElementById('lyr-glacier-flow'); f.checked = false; f.dispatchEvent(new Event('change')); });
        expect(await page.evaluate(() => [window.__glacierLayer._lines.visible, window.__glacierLayer._dots.visible])).toEqual([false, false]);
    });

    test('NEGATIVE CONTROL: a missing summary says so and draws nothing', async ({ page }) => {
        const { errors } = await boot(page, { summary: false });
        await enable(page);
        await page.waitForFunction(() => document.getElementById('glaciers-count').textContent === 'error', null, { timeout: 30_000 });
        const s = await page.evaluate(() => ({
            pip: document.querySelector('.lyr-status[data-layer="glaciers"]')?.title ?? '',
            drawn: window.__glacierLayer.group.children.length,
        }));
        expect(s.pip).toMatch(/glacier archive unavailable: HTTP 404/);
        expect(s.drawn).toBe(0);
        expect(errors).toEqual([]);
    });
});
