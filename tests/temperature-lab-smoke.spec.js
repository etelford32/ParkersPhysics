// @ts-check
/**
 * temperature-lab-smoke.spec.js — the Planetary Temperature Lab page
 * (PLANETARY_TEMPERATURE_LAB_PLAN.md §5, §7, §10).
 * ─────────────────────────────────────────────────────────────────────────────
 * Hermetic: /api/temperature/snapshot is served from the REAL model on the
 * shipped normals (tests/fixtures/temperature-lab-feeds.mjs) and Open-Meteo is
 * mocked, so no live network. A signed-in rung is the shared
 * tests/fixtures/supabase-session.mjs stub (the self-hosted supabase-js
 * initialises offline, so the old `pp_auth` mock no longer applies); signed
 * out answers every Supabase call empty.
 *
 * Pins:
 *   (1) the LADDER: signed out → tl-teaser, 3 rows per card, the week cut at
 *       3 days, filters and the calendar locked; free → tl-free, 10 rows, the
 *       filters reach the route as ?surface / ?region; Intro (basic) →
 *       tl-intro, 25 rows and a real 30-day calendar
 *   (2) gates fire on REACH, never on load, and the gate follows the rung
 *       (a teaser's lock is the free gate, a free account's calendar lock is
 *       the paid Basic one)
 *   (3) the map is painted from the grid (a nudged cell is coloured, the
 *       mode switch repaints, hover names the grid point)
 *   (4) a degraded feed LOOKS degraded: a fallback window says it
 *       understates extremes; an expired one draws no cards and says why;
 *       a dead route is "Unavailable", never a blank page
 *   (5) °C ↔ °F converts every value and is remembered
 *   (6) no horizontal overflow at phone width
 */
import { test, expect } from '@playwright/test';
import {
    snapshotBody, expiredBody, wxFixture, aqFixture, archiveFixture, NUDGES,
} from './fixtures/temperature-lab-feeds.mjs';
import { stubSupabaseSession } from './fixtures/supabase-session.mjs';

test.use({ timezoneId: 'UTC', reducedMotion: 'reduce' });
test.describe.configure({ timeout: 120_000 });

const PAGE = '/temperature-lab.html';

/**
 * @param {import('@playwright/test').Page} page
 * @param {{plan?: string|null, snapshot?: (url: URL) => any, status?: number}} [o]
 */
async function boot(page, { plan = null, snapshot = (u) => snapshotBody({ query: Object.fromEntries(u.searchParams) }), status = 200 } = {}) {
    const now = Date.now();
    const seen = [];
    await page.route('**://cdn.jsdelivr.net/**', (r) => r.abort());
    if (plan) await stubSupabaseSession(page, { plan });
    else {
        await page.route('**/rest/v1/**', (r) => r.fulfill({ json: [] }));
        await page.route('**/auth/v1/**', (r) => r.fulfill({ json: {} }));
    }
    await page.addInitScript(() => {
        localStorage.setItem('ppx_user_location', JSON.stringify({ lat: 41.88, lon: -87.63, city: 'Chicago', displayName: 'Chicago' }));
    });
    await page.route('**/api/temperature/snapshot**', (r) => {
        const u = new URL(r.request().url());
        seen.push(u.search);
        return status === 200 ? r.fulfill({ json: snapshot(u) }) : r.fulfill({ status, body: 'down' });
    });
    await page.route('**/api.open-meteo.com/**', (r) => r.fulfill({ json: wxFixture(now) }));
    await page.route('**/air-quality-api.open-meteo.com/**', (r) => r.fulfill({ json: aqFixture(now) }));
    await page.route('**/archive-api.open-meteo.com/**', (r) => r.fulfill({ json: archiveFixture(now) }));
    await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#tl-host .tl-status .tl-chip', { timeout: 60_000 });
    return { now, seen };
}

const rowsIn = (page, card) => page.locator(`.tl-card[data-card="${card}"] > .tl-rows .tl-row`);

test.describe('Temperature Lab: the ladder', () => {
    test('signed out: teaser — 3 rows, 3 days, locks visible, no gate on load', async ({ page }) => {
        await boot(page);
        await expect(page.locator('body')).toHaveClass(/tl-teaser/);
        await expect(page.locator('.tl-chip')).toHaveAttribute('data-freshness', 'live');
        await expect(page.locator('.tl-card')).toHaveCount(5);
        for (const k of ['hottest', 'coldest', 'above', 'below', 'swings']) await expect(rowsIn(page, k)).toHaveCount(3);
        // Locked content is visible-but-frosted, and nothing auto-opens.
        await expect(page.locator('.tl-card .tl-lock button[data-lock="rows"]')).toHaveCount(5);
        await expect(page.locator('#pp-gate-root')).toHaveCount(0);
        // The place card: three open days, the rest frosted, the month locked.
        await expect(page.locator('.tl-place .tl-days-wrap > .tl-days .tl-day')).toHaveCount(3, { timeout: 30_000 });
        await expect(page.locator('.tl-place [data-lock="outlook"]')).toBeVisible();
        await expect(page.locator('.tl-place [data-lock="calendar"]')).toBeVisible();
        await expect(page.locator('#pp-gate-root')).toHaveCount(0);
        // The hottest row is the nudged Sahara cell, flagged beyond 1991–2020.
        const top = rowsIn(page, 'hottest').first();
        await expect(top).toContainText('Sahara');
        await expect(top.locator('.tl-rec')).toHaveText('beyond 1991–2020');
        // REACH → the FREE gate (the teaser's next rung), even for the calendar's
        // neighbour the rows lock.
        await page.locator('.tl-card[data-card="hottest"] [data-lock="rows"]').click();
        await expect(page.locator('#pp-gate-root .pp-gate-headline')).toHaveText('See the full top ten.');
        await page.keyboard.press('Escape');
        await expect(page.locator('#pp-gate-root')).toHaveCount(0);
        // A filter is a reach too.
        await page.locator('[data-surface="ocean"]').click();
        await expect(page.locator('#pp-gate-root .pp-gate-headline')).toHaveText('See the full top ten.');
        await page.keyboard.press('Escape');
        // The calendar's lock is the PAID gate even for a teaser.
        await page.locator('.tl-place [data-lock="calendar"]').click();
        await expect(page.locator('#pp-gate-root .pp-gate-headline')).toHaveText("You've got the week. Want the month?");
    });

    test('free account: 10 rows, the week, filters reach the route', async ({ page }) => {
        const { seen } = await boot(page, { plan: 'free' });
        await expect(page.locator('body')).toHaveClass(/tl-free/);
        await expect(rowsIn(page, 'above')).toHaveCount(10);
        await expect(page.locator('.tl-card [data-lock="rows"]')).toHaveCount(0);
        await expect(page.locator('.tl-place .tl-days-wrap > .tl-days .tl-day')).toHaveCount(7, { timeout: 30_000 });
        await page.locator('[data-surface="ocean"]').click();
        await expect.poll(() => seen.some(q => q.includes('surface=ocean'))).toBe(true);
        await expect(page.locator('.tl-card[data-card="hottest"] .what')).toContainText('ocean');
        await page.locator('[data-tl="region"]').selectOption('Sahara & North Africa');
        await expect.poll(() => seen.some(q => q.includes('region=Sahara'))).toBe(true);
        await expect(page.locator('#pp-gate-root')).toHaveCount(0);
        // The calendar is the paid rung.
        await page.locator('.tl-place [data-lock="calendar"]').click();
        await expect(page.locator('#pp-gate-root .pp-gate-headline')).toHaveText("You've got the week. Want the month?");
    });

    test('Intro (basic): 25 rows and a real 30-day calendar', async ({ page }) => {
        await boot(page, { plan: 'basic' });
        await expect(page.locator('body')).toHaveClass(/tl-intro/);
        await expect(rowsIn(page, 'coldest')).toHaveCount(25);
        const cells = page.locator('.tl-place .tl-cal .sc-cal .d:not(.pad)');
        await expect(cells.first()).toBeVisible({ timeout: 30_000 });
        expect(await cells.count()).toBeGreaterThanOrEqual(31);
        await expect(page.locator('.tl-place [data-lock]')).toHaveCount(0);
        // Every forward cell carries a number once the archive has landed.
        await expect.poll(async () => page.locator('.tl-place .sc-cal .d[data-lead="30"] .hl').innerText()).toMatch(/\d/);
    });
});

test.describe('Temperature Lab: map, degradation, units, layout', () => {
    test('the map paints the grid, switches mode, and names the grid point on hover', async ({ page }) => {
        await boot(page);
        const canvas = page.locator('canvas[data-tl="map"]');
        await expect(canvas).toBeVisible();
        const px = () => page.evaluate(({ lat, lon }) => {
            const c = /** @type {HTMLCanvasElement} */ (document.querySelector('canvas[data-tl="map"]'));
            const x = Math.round((lon + 180) / 360 * c.width), y = Math.round((90 - lat) / 180 * c.height);
            return [...c.getContext('2d').getImageData(x, y, 1, 1).data];
        }, NUDGES.sahara);
        await expect.poll(async () => (await px())[0]).toBeGreaterThan(40);
        const before = await px();
        await page.locator('[data-tl="modes"] [data-mode="temperature"]').click();
        await expect.poll(async () => (await px()).join()).not.toBe(before.join());
        await canvas.scrollIntoViewIfNeeded();
        const box = await canvas.boundingBox();
        await page.mouse.move(box.x + box.width * ((NUDGES.sahara.lon + 180) / 360), box.y + box.height * ((90 - NUDGES.sahara.lat) / 180));
        await expect(page.locator('.tl-tip')).toBeVisible();
        await expect(page.locator('.tl-tip')).toContainText('5° grid point');
        await expect(page.locator('.tl-legend canvas')).toHaveCount(1);
    });

    test('a fallback window says it understates extremes', async ({ page }) => {
        await boot(page, { snapshot: () => snapshotBody({ sources: { 'met-norway:72x36': 24 } }) });
        await expect(page.locator('.tl-chip')).toHaveAttribute('data-freshness', 'stale');
        await expect(page.locator('.tl-status')).toContainText('understates extremes');
        await expect(page.locator('.tl-note')).toContainText('understates extremes');
        await expect(page.locator('.tl-card')).toHaveCount(5);
    });

    test('an expired aggregate draws no cards and says why; a dead route is Unavailable', async ({ page }) => {
        await boot(page, { snapshot: () => expiredBody() });
        await expect(page.locator('.tl-chip')).toHaveAttribute('data-freshness', 'expired');
        await expect(page.locator('.tl-status')).toContainText('not available yet');
        await expect(page.locator('.tl-card')).toHaveCount(0);
        await expect(page.locator('[data-tl="cards"]')).toContainText('return as soon as');
        await page.unrouteAll({ behavior: 'ignoreErrors' });
    });

    test('a 5xx from the route is shown as Unavailable, never a blank page', async ({ page }) => {
        await boot(page, { status: 503 });
        await expect(page.locator('.tl-chip')).toHaveAttribute('data-freshness', 'expired');
        await expect(page.locator('.tl-status')).toContainText('could not be reached');
    });

    test('°C ↔ °F converts every value and is remembered', async ({ page }) => {
        await boot(page);
        await page.locator('.tl-units [data-unit="C"]').click();
        await expect(rowsIn(page, 'hottest').first().locator('.v')).toContainText('°C');
        await page.locator('.tl-units [data-unit="F"]').click();
        await expect(rowsIn(page, 'hottest').first().locator('.v')).toContainText('°F');
        await expect(page.locator('.tl-strip')).not.toContainText('°C');
        expect(await page.evaluate(() => localStorage.getItem('tl_unit'))).toBe('F');
    });

    test('no horizontal overflow at phone width', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await boot(page, { plan: 'basic' });
        await expect(page.locator('.tl-place .sc-cal')).toBeVisible({ timeout: 30_000 });
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(over).toBeLessThanOrEqual(0);
    });
});
