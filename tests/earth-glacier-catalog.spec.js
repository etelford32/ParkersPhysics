/**
 * earth-glacier-catalog.spec.js — EarthView's "All glaciers (RGI 7.0)" sub-layer
 * ═══════════════════════════════════════════════════════════════════════════════
 *   npx playwright test tests/earth-glacier-catalog.spec.js --workers=1
 *
 * The real committed catalogue (data/glaciers/catalog/*); nothing upstream is called. Pins:
 *   1. OFF at boot and NOTHING fetched before the first enable; enabling draws all 274 531 and
 *      the pip names the inventory and its date caveat;
 *   2. ANALYTIC PIXEL PICKING over 274 k points: hovering Great Aletsch's centroid names it
 *      (inventory facts + "tracked"), a tap pins the deep link into glacier-watch.html's catalogue,
 *      and a bare spot of ocean picks nothing;
 *   3. NEGATIVE CONTROL: a missing points file says so (error pip, nothing drawn, no throw).
 */
import { test, expect } from '@playwright/test';

async function boot(page, { url = '/earth.html', points = true } = {}) {
    const hits = { catalog: 0 };
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api.open-meteo.com/**', r => r.fulfill({ json: { hourly: { time: [] }, daily: { time: [] } } }));
    await page.route('**/air-quality-api.open-meteo.com/**', r => r.fulfill({ json: { hourly: { time: [], us_aqi: [] } } }));
    if (!points) await page.route('**/data/glaciers/catalog/rgi7-points.bin.gz', r => r.fulfill({ status: 404, body: 'not found' }));
    page.on('request', req => { if (req.url().includes('/data/glaciers/catalog/')) hits.catalog++; });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__glacierCatalogLayer, null, { timeout: 45_000 });
    await page.evaluate(() => document.querySelector('.pp-consent-banner')?.remove());
    return { hits, errors };
}

async function enable(page) {
    await page.evaluate(() => {
        const r = document.getElementById('lyr-rotate');
        if (r) { r.checked = false; r.dispatchEvent(new Event('change', { bubbles: true })); }
        const el = document.getElementById('lyr-glacier-catalog');
        el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

test.describe('EarthView all-glaciers layer (RGI 7.0)', () => {
    test.describe.configure({ timeout: 180_000 });   // earth.html boots slowly on a software rasteriser

    test('off at boot, lazy, all 274 531 on enable', async ({ page }) => {
        const { hits, errors } = await boot(page);
        await expect(page.locator('#lyr-glacier-catalog')).not.toBeChecked();
        await page.waitForTimeout(1500);
        expect(hits.catalog, 'nothing fetched before the first enable').toBe(0);
        await enable(page);
        await page.waitForFunction(() => !!window.__glacierCatalogLayer.cat && !!window.__glacierCatalogLayer._points, null, { timeout: 60_000 });
        const s = await page.evaluate(() => ({
            n: window.__glacierCatalogLayer.cat.pts.n,
            drawn: window.__glacierCatalogLayer._points.geometry.attributes.position.count,
            count: document.getElementById('glacier-catalog-count').textContent,
            pip: document.querySelector('.lyr-status[data-layer="glacier-catalog"]')?.title ?? '',
        }));
        expect(s.n).toBe(274531);
        expect(s.drawn).toBe(274531);
        expect(s.count).toBe('275k');
        expect(s.pip).toMatch(/274,531 glaciers, 706,744 km²/);
        expect(s.pip).toMatch(/median 2002/);
        expect(errors).toEqual([]);
    });

    test('hover names the glacier; tap pins the deep link; ocean picks nothing', async ({ page }) => {
        const { errors } = await boot(page, { url: '/earth.html?at=46.48,8.03,600' });
        await enable(page);
        await page.waitForFunction(() => !!window.__glacierCatalogLayer.cat, null, { timeout: 60_000 });
        const idx = await page.evaluate(async () => (await (await fetch('/data/glaciers/catalog/rgi7-meta.json')).json()).watch_links.aletsch.index);
        await page.waitForFunction((i) => (window.__rgiAtIndex(i)?.facing ?? 0) > 0.995, idx, { timeout: 30_000 });
        // the Alps hold a glacier every few pixels at this range: wait until the fly-in's damping has
        // STOPPED moving the point (< 0.3 px over 700 ms), then re-measure right before each action
        const settle = async () => {
            for (let k = 0; k < 40; k++) {
                const a = await page.evaluate((i) => window.__rgiAtIndex(i), idx);
                await page.waitForTimeout(700);
                const b = await page.evaluate((i) => window.__rgiAtIndex(i), idx);
                if (Math.hypot(a.x - b.x, a.y - b.y) < 0.3) return b;
            }
            throw new Error('the globe never settled');
        };
        let t = await settle();
        expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, t), 'Aletsch is not under page chrome').toBe('CANVAS');
        // names arrive a moment after the points
        await page.waitForFunction(() => !!window.__glacierCatalogLayer.names, null, { timeout: 30_000 });
        // the globe TURNS with sidereal time (~0.35 px/s here) and a software frame can land a second
        // after the measurement, so re-aim from a fresh projection until the cursor is on Aletsch's
        // centroid (a tributary sits a pixel away) — at most a few attempts, then assert
        const tip = page.locator('#rgi-tip');
        const aim = async (act) => {
            for (let k = 0; k < 6; k++) {
                t = await page.evaluate((i) => window.__rgiAtIndex(i), idx);
                await act(t);
                await page.waitForTimeout(500);
                if ((await page.evaluate(() => window.__glacierCatalogLayer._hi)) === idx) return;
            }
        };
        await aim((p) => page.mouse.move(p.x, p.y));
        await expect(tip).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#rgi-tip-name')).toHaveText('Grosser Aletsch Gletscher');
        await expect(page.locator('#rgi-tip-size')).toContainText('81.8 km² · median elevation 3,152 m');
        await expect(page.locator('#rgi-tip-flags')).toContainText('TRACKED in Glacier Watch');
        t = await settle();
        await aim(async (p) => { await page.waitForTimeout(450); await page.mouse.click(p.x, p.y); });
        await expect(tip).toHaveClass(/pinned/);
        expect(await page.locator('#rgi-tip-hint a').getAttribute('href')).toBe('glacier-watch.html?rgi=RGI2000-v7.0-G-11-02596&g=aletsch');
        // the Mediterranean, ~400 km south: no glacier within reach of the cursor
        const sea = await page.evaluate(() => {
            const r = document.getElementById('c').getBoundingClientRect();
            for (let y = r.top + r.height * 0.75; y < r.bottom - 20; y += 30) for (let x = r.left + 40; x < r.right - 40; x += 40) {
                if (document.elementFromPoint(x, y)?.tagName !== 'CANVAS') continue;
                return { x, y };
            }
            return null;
        });
        expect(sea).toBeTruthy();
        await page.waitForTimeout(600);       // earth.html drops a second tap inside 400 ms
        await page.mouse.click(sea.x, sea.y);
        await expect(tip).not.toHaveClass(/pinned/);
        expect(errors).toEqual([]);
    });

    test('NEGATIVE CONTROL: a missing inventory says so and draws nothing', async ({ page }) => {
        const { errors } = await boot(page, { points: false });
        await enable(page);
        await page.waitForFunction(() => document.getElementById('glacier-catalog-count').textContent === 'error', null, { timeout: 30_000 });
        const s = await page.evaluate(() => ({
            pip: document.querySelector('.lyr-status[data-layer="glacier-catalog"]')?.title ?? '',
            drawn: window.__glacierCatalogLayer.group.children.length,
        }));
        expect(s.pip).toMatch(/glacier inventory unavailable: rgi7-points\.bin\.gz: HTTP 404/);
        expect(s.drawn).toBe(0);
        expect(errors).toEqual([]);
    });
});
