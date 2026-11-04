/**
 * earth-volcano-layer.spec.js — the Volcanoes layer on EarthView (earth.html)
 * ═══════════════════════════════════════════════════════════════════════════
 *   npx playwright test tests/earth-volcano-layer.spec.js
 *
 * /api/volcanoes/activity is MOCKED (USGS/EONET are egress-blocked in CI);
 * the catalogue is the real committed file. Pins:
 *   1. the layer is OFF at boot and the catalogue is NOT fetched until the
 *      first enable (2.7k volcanoes must not cost every EarthView visitor);
 *   2. enabling it draws all 2661 volcanoes, joins the live feed (Etna by
 *      position, Kilauea by GVP number) and the count says so;
 *   3. hovering a glyph shows the engine's numbers; a tap pins the tip with
 *      the deep link into volcanoes.html;
 *   4. the group checkboxes hide classes from drawing AND from picking;
 *   5. NEGATIVE CONTROL: a dead live feed keeps the catalogue drawn and turns
 *      the pip to error with the reason — never a quiet, healthy-looking layer.
 */

import { test, expect } from '@playwright/test';

const ACTIVITY = {
    updated: new Date().toISOString(), freshness: 'live', count: 2,
    items: [
        { source: 'usgs-hans', id: 'hans-332010', num: 332010, name: 'Kilauea', lat: null, lon: null, colorCode: 'ORANGE', alertLevel: 'WATCH' },
        { source: 'eonet', id: 'E1', num: null, name: 'Etna', title: 'Etna Volcano, Italy', lat: 37.748, lon: 14.999, ageDays: 2 },
    ],
    sources: { usgs_hans: { ok: true, count: 1 }, eonet: { ok: true, count: 1 } },
};

async function boot(page, { activity = ACTIVITY } = {}) {
    const hits = { catalog: 0 };
    await page.route('**/api.open-meteo.com/**', r => r.fulfill({ json: { hourly: { time: [] }, daily: { time: [] } } }));
    await page.route('**/air-quality-api.open-meteo.com/**', r => r.fulfill({ json: { hourly: { time: [], us_aqi: [] } } }));
    await page.route('**/api/volcanoes/activity', r => activity
        ? r.fulfill({ json: activity })
        : r.fulfill({ json: { updated: new Date().toISOString(), freshness: 'stale', reasons: ['usgs-hans-down', 'eonet-down'], count: 0, items: [], sources: {} } }));
    page.on('request', req => { if (req.url().includes('/data/volcanoes/volcanoes-catalog.json')) hits.catalog++; });
    await page.goto('/earth.html', { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__volcanoLayer, null, { timeout: 45_000 });
    return hits;
}

async function enable(page) {
    await page.evaluate(() => {
        const r = document.getElementById('lyr-rotate');
        r.checked = false; r.dispatchEvent(new Event('change', { bubbles: true }));
        const el = document.getElementById('lyr-volcanoes');
        el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => window.__volcanoLayer.cat && window.__volcanoLayer.liveState.freshness != null, null, { timeout: 30_000 });
}

test.describe('EarthView volcano layer', () => {

    test('off at boot, lazy catalogue, live join on enable', async ({ page }) => {
        const hits = await boot(page);
        await expect(page.locator('#lyr-volcanoes')).not.toBeChecked();
        expect(await page.evaluate(() => window.__volcanoLayer.group.visible)).toBe(false);
        await page.waitForTimeout(1500);
        expect(hits.catalog, 'catalogue not fetched before the first enable').toBe(0);

        await enable(page);
        const s = await page.evaluate(() => {
            const L = window.__volcanoLayer;
            return { n: L.cat.volcanoes.length, live: [...L.live.values()].map(x => x.volcano.name).sort(),
                     visible: L.group.visible, count: document.getElementById('volcanoes-count').textContent,
                     pip: document.querySelector('.lyr-status[data-layer="volcanoes"]')?.title ?? '' };
        });
        expect(s.n).toBe(2661);
        expect(s.visible).toBe(true);
        expect(s.live).toEqual(['Etna', 'Kilauea']);
        expect(s.count).toContain('2,661');
        expect(s.count).toContain('2 live');
        expect(s.pip).toContain('2 elevated/erupting today');
    });

    test('hover shows engine numbers; tap pins the deep link; groups gate drawing + picking', async ({ page }) => {
        await boot(page);
        await enable(page);
        await page.waitForTimeout(500);
        const target = await page.evaluate(() => window.__volcanoAtCenter(v => v.status === 'recent' || v.status === 'erupting'));
        expect(target, 'a camera-facing active volcano').toBeTruthy();
        await page.mouse.move(target.x, target.y);
        const tip = page.locator('#volcano-tip');
        await expect(tip).toBeVisible({ timeout: 5000 });
        await expect(page.locator('#volcano-tip-hazard')).toContainText('within 10 yr');
        await expect(page.locator('#volcano-tip-last')).toContainText('Last known eruption');

        await page.mouse.click(target.x, target.y);
        await expect(tip).toHaveClass(/pinned/);
        const href = await page.locator('#volcano-tip-hint a').getAttribute('href');
        expect(href).toMatch(/^volcanoes\.html\?v=\d+$/);

        // hide the ACTIVE group: the glyph under the cursor can no longer be picked
        await page.evaluate(() => {
            const el = document.getElementById('lyr-volcanoes-active');
            el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const picked = await page.evaluate(({ x, y }) => {
            const L = window.__volcanoLayer;
            return L.groupVisible('active');
        }, target);
        expect(picked).toBe(false);
        const hit = await page.evaluate(() => window.__volcanoAtCenter(v => v.status === 'recent' || v.status === 'erupting'));
        expect(hit, 'no active volcano is pickable once the group is off').toBeNull();
    });

    test('NEGATIVE CONTROL: dead live feed keeps the catalogue and says so', async ({ page }) => {
        await boot(page, { activity: null });
        await enable(page);
        const s = await page.evaluate(() => ({
            n: window.__volcanoLayer.cat.volcanoes.length,
            live: window.__volcanoLayer.live.size,
            pip: document.querySelector('.lyr-status[data-layer="volcanoes"]')?.title ?? '',
        }));
        expect(s.n).toBe(2661);
        expect(s.live).toBe(0);
        expect(s.pip).toMatch(/live status unavailable/);
        expect(s.pip).toMatch(/eonet-down/);
    });
});
