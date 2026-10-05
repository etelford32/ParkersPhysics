import { test, expect } from '@playwright/test';

/**
 * Browser gate for skyview.html.
 *
 * Every test pins the SITE and the INSTANT in the URL (?lat=&lon=&t=), so the
 * sky is the same on every run and every machine: Denver, 2026-10-05 04:30 UT
 * (22:30 local), astronomically dark, Saturn one day past opposition. The
 * catalogue is the committed data file — no network is needed (Nominatim and
 * telemetry are aborted).
 *
 * What this pins:
 *   - the page boots, loads the catalogue, and raises no page error
 *   - the top-10 list IS the engine's ranking (one evaluation per instant), and
 *     a dark October night in Denver ranks Vega and Saturn in it
 *   - picking is in SCREEN space through the page's own projection: a click on
 *     Saturn's drawn position selects Saturn and fills the card
 *   - a DRAG in Look mode pans the view and selects nothing (pointerup-tap rule)
 *   - a list row selects, and a galaxy-map star's card carries the map's page
 *     link and the Galaxy Map deep link (?focus=<id>)
 *   - galaxy-map LANDMARKS are listed, selectable, and never ranked
 *   - daylight puts the Sun first with its eye-safety warning
 *   - "Tonight" moves the clock off live into darkness
 *   - the phone layout does not scroll sideways
 */

const DENVER_NIGHT = '/skyview.html?lat=39.74&lon=-104.99&place=Denver&t=2026-10-05T04:30:00Z';
const DENVER_NOON = '/skyview.html?lat=39.74&lon=-104.99&place=Denver&t=2026-10-05T19:00:00Z';

const IGNORED = [/Failed to load resource/, /net::ERR/, /fonts\.googleapis\.com/, /supabase/i, /telemetry/];

async function open(page, url) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
        if (m.type() === 'error' && !IGNORED.some((p) => p.test(m.text()))) errors.push(m.text());
    });
    await page.route(/nominatim\.openstreetmap\.org|\/api\/telemetry|supabase/, (r) => r.abort());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body[data-skyview-ready="1"]', { timeout: 30_000 });
    return errors;
}

/** Screen position (page CSS px) of an object, through the page's own frame + view. */
async function screenPosOf(page, key) {
    return page.evaluate(async (k) => {
        const { toEnu, raDecToVec } = await import('/js/skyview/sky-engine.js');
        const { project } = await import('/js/skyview/sky-projection.js');
        const sv = window.__skyView;
        const o = sv.sky.objects.find((x) => x.key === k) ?? sv.sky.landmarks.find((x) => x.key === k);
        const p = project(sv.view, toEnu(sv.frame, raDecToVec(o.raDeg, o.decDeg)));
        const r = document.getElementById('sv-canvas').getBoundingClientRect();
        return p ? { x: r.left + p.x, y: r.top + p.y } : null;
    }, key);
}

test.describe('SkyView', () => {
    test('boots and ranks the sky the engine computed', async ({ page }) => {
        const errors = await open(page, DENVER_NIGHT);
        const rows = page.locator('#sv-top-list .sv-top-item');
        await expect(rows).toHaveCount(10);
        const shown = await rows.locator('.sv-top-name').allTextContents();
        const engine = await page.evaluate(() => window.__skyView.sky.ranked.slice(0, 10).map((o) => o.name));
        expect(shown).toEqual(engine);
        expect(shown).toContain('Vega');
        expect(shown).toContain('Saturn');
        await expect(page.locator('#sv-hero-regime')).toHaveText('dark night');
        await expect(page.locator('#sv-hero-live')).toHaveText('TIME-SHIFTED');
        const st = await page.evaluate(() => {
            const s = window.__skyView.sky;
            return { allUp: s.ranked.every((o) => o.altDeg > 0), noLandmark: !s.ranked.some((o) => o.kind === 'landmark'), top: window.__skyView.top.length };
        });
        expect(st).toEqual({ allUp: true, noLandmark: true, top: 100 });
        expect(errors).toEqual([]);
    });

    test('clicking a drawn object selects it (screen-space pick)', async ({ page }) => {
        const errors = await open(page, DENVER_NIGHT);
        const p = await screenPosOf(page, 'saturn');
        expect(p).not.toBeNull();
        await page.mouse.click(p.x, p.y);
        await expect.poll(() => page.evaluate(() => window.__skyView.selectedKey)).toBe('saturn');
        await expect(page.locator('#sv-card h3')).toHaveText('Saturn');
        await expect(page.locator('#sv-card')).toContainText('Rings');
        expect(errors).toEqual([]);
    });

    test('a drag in Look mode pans and selects nothing', async ({ page }) => {
        await open(page, DENVER_NIGHT);
        await page.locator('[data-view="look"]').click();
        const p = await screenPosOf(page, 'saturn');
        const az0 = await page.evaluate(() => window.__skyView.look.az);
        await page.mouse.move(p.x, p.y);
        await page.mouse.down();
        await page.mouse.move(p.x + 60, p.y + 5, { steps: 6 });
        await page.mouse.up();
        const after = await page.evaluate(() => ({ key: window.__skyView.selectedKey, az: window.__skyView.look.az }));
        expect(after.key).toBeNull();
        expect(after.az).not.toBeCloseTo(az0, 1);
    });

    test('a list row selects, and the galaxy map record comes with it', async ({ page }) => {
        await open(page, DENVER_NIGHT);
        await page.locator('#sv-top-list .sv-top-item', { hasText: 'Vega' }).click();
        await expect(page.locator('#sv-card h3')).toHaveText('Vega');
        await expect(page.locator('#sv-card a[href="vega.html"]')).toHaveCount(1);
        await expect(page.locator('#sv-card a[href="galactic-map.html?focus=vega"]')).toHaveCount(1);
        await expect(page.locator('#sv-card')).toContainText('25.1 ly');
        await expect(page.locator('#sv-card')).toContainText('l 67.4');
    });

    test('landmarks are listed, selectable, and invisible to the eye', async ({ page }) => {
        await open(page, DENVER_NIGHT);
        const items = page.locator('#sv-landmarks li');
        expect(await items.count()).toBeGreaterThan(5);
        await items.first().click();
        await expect(page.locator('#sv-card .sv-chip--nomag')).toHaveCount(1);
        const key = await page.evaluate(() => window.__skyView.selectedKey);
        expect(key.startsWith('gal:')).toBe(true);
    });

    test('daylight puts the Sun first, with the eye-safety warning', async ({ page }) => {
        await open(page, DENVER_NOON);
        await expect(page.locator('#sv-hero-regime')).toHaveText('day');
        const first = page.locator('#sv-top-list .sv-top-item').first();
        await expect(first.locator('.sv-top-name')).toHaveText('Sun');
        await first.click();
        await expect(page.locator('#sv-card .sv-warn')).toContainText('Never look at the Sun');
    });

    test('Tonight moves the clock into darkness', async ({ page }) => {
        await open(page, '/skyview.html?lat=39.74&lon=-104.99&place=Denver');
        await expect(page.locator('#sv-hero-live')).toHaveText('LIVE');
        await page.locator('#sv-time-tonight').click();
        await expect(page.locator('#sv-hero-live')).toHaveText('TIME-SHIFTED');
        const sunAlt = await page.evaluate(() => window.__skyView.sky.env.sunAltDeg);
        expect(sunAlt).toBeLessThan(-12);
    });

    test('phone layout does not scroll sideways', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await open(page, DENVER_NIGHT);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        const box = await page.locator('#sv-canvas').boundingBox();
        expect(box.width).toBeGreaterThan(300);
    });
});
