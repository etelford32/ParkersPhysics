/**
 * volcanoes-page.spec.js — the Earth Volcanoes lab (volcanoes.html)
 * ═══════════════════════════════════════════════════════════════════════════
 *   npx playwright test tests/volcanoes-page.spec.js
 *
 * /api/volcanoes/activity is MOCKED (USGS/EONET are egress-blocked in CI).
 * Pins: boots without console errors; the headline counts are the engine's;
 * a deep link (?v=) selects and the card shows the engine's odds + scenario;
 * the status filters drive the table; the simulation renders both small
 * multiples and the replay; tapping a volcano on the map selects it; and the
 * NEGATIVE CONTROL — a dead live feed shows "Live status unavailable", never a
 * green chip.
 */

import { test, expect } from '@playwright/test';

const ACTIVITY = {
    updated: new Date().toISOString(), freshness: 'live', count: 1,
    items: [{ source: 'usgs-hans', id: 'h', num: 332010, name: 'Kilauea', colorCode: 'ORANGE', alertLevel: 'WATCH', ageDays: 1 }],
    sources: {},
};

function recorder(page) {
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));
    return errors;
}
async function boot(page, { activity = ACTIVITY, url = '/volcanoes.html' } = {}) {
    await page.route('**/api/volcanoes/activity', r => activity
        ? r.fulfill({ json: activity })
        : r.fulfill({ status: 200, json: { freshness: 'stale', reasons: ['usgs-hans-down', 'eonet-down'], items: [], count: 0 } }));
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__volcanoLab?.cat && window.__volcanoLab.sim, null, { timeout: 45_000 });
}

test.describe('Earth Volcanoes page', () => {
    test('boots clean; headline, card, live, simulation', async ({ page }) => {
        const errors = recorder(page);
        await boot(page, { url: '/volcanoes.html?v=332010' });
        await expect(page.locator('#vx-stat-total')).toHaveText('2,661');
        await expect(page.locator('#vx-stat-inactive')).toHaveText('1,439');
        await expect(page.locator('#vx-card h3')).toHaveText('Kilauea');
        await expect(page.locator('#vx-card .vx-live-pill')).toContainText('ORANGE');
        await expect(page.locator('.vx-odds-tile')).toHaveCount(3);
        await expect(page.locator('.vx-whatif-out dt').first()).toBeVisible();
        await expect(page.locator('#vx-chip-live')).toHaveAttribute('data-state', 'live');
        await expect(page.locator('#vx-sim-forcing svg')).toBeVisible();
        await expect(page.locator('#vx-sim-temp svg')).toBeVisible();
        await expect(page.locator('#vx-replay svg text.vx-ch-label').filter({ hasText: 'Pinatubo' })).toHaveCount(1);
        await expect(page.locator('#vx-exposure tbody tr')).toHaveCount(15);
        expect(errors.filter(e => !/favicon|manifest|supabase|telemetry|Failed to load resource/i.test(e))).toEqual([]);
    });

    test('filters drive the table; map tap selects', async ({ page }) => {
        await boot(page);
        const before = await page.locator('#vx-table-count').textContent();
        await page.locator('.vx-fhead', { hasText: 'Inactive' }).click();
        const after = await page.locator('#vx-table-count').textContent();
        expect(after).not.toEqual(before);
        expect(after).toContain('of 1,222');
        await page.locator('#vx-search').fill('Vesuvius');
        await expect(page.locator('#vx-table tbody tr')).toHaveCount(1);
        await page.locator('#vx-table tbody .vx-linkbtn').click();
        await expect(page.locator('#vx-card h3')).toHaveText('Vesuvius');
        expect(page.url()).toContain('v=211020');

        // tap the map at Etna's projected position (map scrolled into view
        // first — a mouse click at an off-viewport coordinate hits nothing)
        await page.locator('#vx-map').scrollIntoViewIfNeeded();
        const pt = await page.evaluate(() => {
            const L = window.__volcanoLab;
            const v = L.cat.volcanoes.find(x => x.name === 'Etna');
            L.flyTo(v);
            const [x, y] = L.project(v.lat, v.lon);
            const r = document.getElementById('vx-map').getBoundingClientRect();
            return { x: r.left + x, y: r.top + y };
        });
        await page.mouse.click(pt.x, pt.y);
        await expect(page.locator('#vx-card h3')).toHaveText('Etna');
    });

    test('NEGATIVE CONTROL: dead live feed is reported, not quiet', async ({ page }) => {
        await boot(page, { activity: null });
        await expect(page.locator('#vx-chip-live')).toHaveAttribute('data-state', 'down');
        await expect(page.locator('#vx-chip-live')).toContainText('Live status unavailable');
        await expect(page.locator('#vx-live .vx-warn')).toBeVisible();
    });
});
