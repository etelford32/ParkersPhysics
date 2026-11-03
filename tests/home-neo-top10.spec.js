// @ts-check
/**
 * home-neo-top10.spec.js — the homepage's "ten nearest near-Earth objects"
 * widget (js/home-neo-watch.js + the PURE js/home-neo-model.js).
 * ─────────────────────────────────────────────────────────────────────────────
 * JPL is MOCKED (ssd-api.jpl.nasa.gov is egress-blocked) with a catalogue
 * composed by the routes' own pure library and objects PLANTED at known
 * geocentric distances from the page's Earth ephemeris
 * (tests/fixtures/neo-catalog-synthetic.mjs), so the ranking holds on any date.
 * Pins:
 *   (1) the section mounts lazily, loads the tier ladder (pha → bright), and
 *       the board shows exactly TEN rows ranked by geocentric distance — the
 *       planted 2 LD object first, the planted 170 LD object (11th) absent;
 *   (2) every row is the kernel's: the printed LD distance matches the
 *       state's distKm / LD_KM, the plan-view radius IS neo-space's log map,
 *       the elevation glyph matches the sign of z;
 *   (3) the plan view is drawn (non-blank canvas) and clicking a row selects
 *       it on the map;
 *   (4) a saved location adds the sky column (alt/az through the kernel);
 *   (5) a dead catalogue says so — chip 'down', no rows, no page error.
 */
import { test, expect } from '@playwright/test';
import { catalogBody, PLANTED } from './fixtures/neo-catalog-synthetic.mjs';
import { geoSceneRadius, LD_KM } from '../js/neo-space.js';

const PAGE_URL = '/index.html?exp_home_bg_carousel=control&debug=1&intro=0';
const IGNORED = [/fonts\.googleapis/, /\/api\/telemetry/, /unpkg\.com/, /Failed to load resource/, /net::ERR/, /supabase/i, /WebSocket/, /\/api\//];

function collectErrors(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() !== 'error') return;
        const t = m.text(), u = m.location?.()?.url || '';
        if (IGNORED.some((p) => p.test(t) || p.test(u))) return;
        errors.push(t);
    });
    return errors;
}

async function mockCatalog(page, { down = false } = {}) {
    const tiers = [];
    await page.route('**/api/neo/catalog*', async (route) => {
        const tier = new URL(route.request().url()).searchParams.get('tier');
        tiers.push(tier);
        if (down) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ freshness: 'stale', rows: [], degraded_reason: 'HTTP 503' }) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalogBody(undefined, { tier })) });
    });
    await page.route('**/api/neo/watch*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"freshness":"stale","approaches":[]}' }));
    return tiers;
}

async function openBoard(page) {
    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.getElementById('neo-top10').scrollIntoView());
    await page.waitForFunction(() => !!window.__homeNeo, null, { timeout: 30_000 });
}

test.describe('home: ten nearest NEOs', () => {
    test.describe.configure({ timeout: 120_000 });

    test('ranks ten rows by distance through the kernel, draws the plan view, selects', async ({ page }) => {
        const errors = collectErrors(page);
        await page.addInitScript(() => { try { localStorage.setItem('ppx_user_location', JSON.stringify({ lat: 40.0, lon: -105.3, city: 'Boulder' })); } catch {} });
        const tiers = await mockCatalog(page);
        await openBoard(page);
        await page.waitForFunction(() => window.__homeNeo.state.rows.length >= 10, null, { timeout: 60_000 });
        const st = await page.evaluate(() => window.__homeNeo.state);
        expect(st.catalog.state).toBe('live');
        expect(tiers.slice(0, 2)).toEqual(['pha', 'bright']);                 // the ladder
        expect(st.rows).toHaveLength(10);
        // Ascending distance; the planted 2 LD object first; the 11th absent.
        for (let i = 1; i < st.rows.length; i++) expect(st.rows[i].distKm).toBeGreaterThanOrEqual(st.rows[i - 1].distKm);
        expect(st.rows[0].des).toBe(PLANTED[0].des);
        expect(Math.abs(st.rows[0].distLD - 2)).toBeLessThan(0.25);
        expect(st.rows.map((r) => r.des)).not.toContain('NEAR-170LD');
        // Every row is the kernel's: plan radius IS the log map; glyph = sign of z (planted north).
        for (const r of st.rows) {
            expect(Math.abs(r.planR - geoSceneRadius(r.distKm))).toBeLessThan(1e-6);
            expect(Math.abs(r.distLD - r.distKm / LD_KM)).toBeLessThan(1e-9);
            if (r.des.startsWith('NEAR-')) expect(r.above).toBe(true);
            expect(r.sky).not.toBeNull();                                        // the observer column
            expect(typeof r.sky.altDeg).toBe('number');
        }
        // The DOM prints the same numbers.
        const rows = page.locator('#neo-top10 tbody tr.hnw-row');
        await expect(rows).toHaveCount(10);
        // The cell may carry the inside-Earth's-grip note after the number (the planted 2 LD object is 'captured').
        const firstLd = await rows.nth(0).locator('[data-c="ld"]').textContent();
        expect(Number(/^\s*([\d.]+)\s*LD/.exec(firstLd)[1])).toBeCloseTo(st.rows[0].distLD, 1);
        await expect(rows.nth(0).locator('.n')).toContainText(PLANTED[0].des);
        await expect(rows.nth(0).locator('.pha')).toHaveCount(1);                 // planted as a PHA
        await expect(page.locator('#neo-top10 .hnw-chip')).toHaveClass(/live/);
        await expect(page.locator('#neo-top10 .hnw-chip')).toContainText(/JPL SBDB/);
        await expect(page.locator('#neo-top10 [data-caption]')).toContainText(/two-body/);
        await expect(page.locator('#neo-top10 [data-mapnote]')).toContainText(/LOGARITHMIC/);
        // The plan view is drawn: non-blank, with one point per row.
        expect(st.points).toBe(10);
        const painted = await page.evaluate(() => {
            const c = document.querySelector('#neo-top10 canvas');
            const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
            let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
            return n / (d.length / 4);
        });
        expect(painted).toBeGreaterThan(0.01);
        // Selecting a row selects on the map.
        await rows.nth(2).click();
        expect(await page.evaluate(() => window.__homeNeo.state.selected)).toBe(st.rows[2].index);
        await expect(rows.nth(2)).toHaveClass(/sel/);
        // Links out to the two 3D views.
        await expect(page.locator('#neo-top10 a[data-funnel-cta="home_neo_watch"]')).toHaveCount(1);
        await expect(page.locator('#neo-top10 a[data-funnel-cta="home_neo_orrery"]')).toHaveCount(1);
        expect(errors).toEqual([]);
    });

    test('catalogue down: the chip says so, nothing is drawn, no page error', async ({ page }) => {
        const errors = collectErrors(page);
        await mockCatalog(page, { down: true });
        await openBoard(page);
        await page.waitForFunction(() => window.__homeNeo.state.catalog.state === 'down', null, { timeout: 30_000 });
        await expect(page.locator('#neo-top10 .hnw-chip')).toHaveClass(/down/);
        await expect(page.locator('#neo-top10 .hnw-chip')).toContainText(/catalogue down/i);
        await expect(page.locator('#neo-top10 tbody tr.hnw-row')).toHaveCount(0);
        await expect(page.locator('#neo-top10 [data-empty]')).toBeVisible();
        await expect(page.locator('#neo-top10 [data-caption]')).toContainText(/nothing here is invented/i);
        expect(errors).toEqual([]);
    });

    test('phone: the board stacks and does not overflow', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await mockCatalog(page);
        await openBoard(page);
        await page.waitForFunction(() => window.__homeNeo.state.rows.length >= 10, null, { timeout: 60_000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
        const map = await page.locator('#neo-top10 .hnw-map').boundingBox();
        const table = await page.locator('#neo-top10 .hnw-table').boundingBox();
        expect(table.y).toBeGreaterThanOrEqual(map.y + map.height - 1);          // stacked, not side by side
    });
});
