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
 *   THE TIME MACHINE (sky-predict.js):
 *   - the 30-night forecast builds for every Galaxy Map object, and the
 *     galactic list is ranked by tonight's usable hours
 *   - tracks: ○ adds one, colour stays with the OBJECT, the 4th drops the
 *     oldest (3 is a colour-vision cap), and each draws an arc + nightly dots
 *   - «/» step exactly one clock day (the same moment next night) and a fixed
 *     object's same-time position moves ~1° west per night (sidereal drift)
 *   - nightly playback advances in whole days and widens the range to a month
 *   - the card's visibility calendar has one row per night, and tapping a
 *     night moves the clock into that night without re-anchoring the forecast
 */

const DENVER_NIGHT = '/skyview.html?lat=39.74&lon=-104.99&place=Denver&t=2026-10-05T04:30:00Z';
const DENVER_NOON = '/skyview.html?lat=39.74&lon=-104.99&place=Denver&t=2026-10-05T19:00:00Z';

const IGNORED = [/Failed to load resource/, /net::ERR/, /fonts\.googleapis\.com/, /supabase/i, /telemetry/];

async function openForecast(page, url) {
    const errors = await open(page, url);
    await page.waitForSelector('body[data-skyview-forecast="1"]', { timeout: 30_000 });
    return errors;
}

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
        await openForecast(page, DENVER_NIGHT);
        // Landmarks live in the Galactic targets list (keys gal:*), never in the ranking.
        const items = page.locator('#sv-galactic .sv-gal-row[data-key^="gal:"]');
        expect(await items.count()).toBeGreaterThan(40);
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

    test('galactic targets are forecast and ranked by tonight', async ({ page }) => {
        const errors = await openForecast(page, DENVER_NIGHT);
        const rows = page.locator('#sv-galactic .sv-gal-row');
        const n = await page.evaluate(() => window.__skyView.cat.galactic.length);
        await expect(rows).toHaveCount(n);
        const hours = await page.evaluate(() => {
            const sv = window.__skyView;
            return [...document.querySelectorAll('#sv-galactic .sv-gal-row')].map((li) => sv._forecast.byKey.get(li.dataset.key).nights[0].hours);
        });
        for (let i = 1; i < hours.length; i++) expect(hours[i - 1]).toBeGreaterThanOrEqual(hours[i] - 1e-9);
        await page.locator('.sv-gal-tools [data-galfilter="instrument"]').click();
        expect(await rows.count()).toBeLessThan(n);
        expect(errors).toEqual([]);
    });

    test('tracking: colour follows the object, three at most', async ({ page }) => {
        await openForecast(page, DENVER_NIGHT + '&track=');
        expect(await page.evaluate(() => window.__skyView.tracked.length)).toBe(0);
        const keys = ['hip:91262', 'dso:M31', 'gal:sgr_a', 'hip:24608'];   // Vega, M31, Sgr A*, Capella
        for (const k of keys.slice(0, 3)) await page.locator(`#sv-galactic [data-track="${k}"]`).click();
        const before = await page.evaluate(() => window.__skyView.tracked.map((t) => [t.key, t.color]));
        expect(before.map((t) => t[0])).toEqual(keys.slice(0, 3));
        expect(new Set(before.map((t) => t[1])).size).toBe(3);
        // Untrack the middle one, add a fourth: the others keep their colours.
        await page.locator('#sv-tracks [data-track="dso:M31"]').click();
        await page.locator(`#sv-galactic [data-track="${keys[3]}"]`).click();
        const after = await page.evaluate(() => window.__skyView.tracked.map((t) => [t.key, t.color]));
        expect(after.find((t) => t[0] === 'hip:91262')[1]).toBe(before[0][1]);
        expect(after.find((t) => t[0] === 'gal:sgr_a')[1]).toBe(before[2][1]);
        expect(after.find((t) => t[0] === keys[3])[1]).toBe(before[1][1]);   // the freed slot
        const t = await page.evaluate(() => window.__skyView.tracks.map((x) => ({ arc: x.arc.length, nights: x.nightly.length })));
        for (const x of t) { expect(x.arc).toBeGreaterThan(30); expect(x.nights).toBeGreaterThanOrEqual(7); }
        // A fourth beyond the cap drops the oldest.
        await page.locator('#sv-galactic [data-track="dso:M31"]').click();
        expect(await page.evaluate(() => window.__skyView.tracked.length)).toBe(3);
        expect(await page.evaluate(() => window.__skyView.isTracked('hip:91262'))).toBe(false);
    });

    test('night steps are one clock day, and a fixed star drifts west', async ({ page }) => {
        await openForecast(page, DENVER_NIGHT + '&track=hip:91262');
        const pos = () => page.evaluate(() => {
            const n = window.__skyView.tracks[0].nightly[0];
            return { t: window.__skyView.timeMs, alt: n.altDeg, az: n.azDeg };
        });
        const a = await pos();
        await page.locator('[data-step="1440"]').click();
        await page.locator('[data-step="1440"]').click();
        const b = await pos();
        expect(b.t - a.t).toBe(2 * 86_400_000);
        // Two nights at the same clock time = 2 × 0.9856° of hour angle, which on
        // the sky is 2 × 0.9856° × cos δ ≈ 1.54° for Vega (δ = +38.8°). Measured as
        // a great-circle separation — AZIMUTH alone changes less for a high star.
        const r = Math.PI / 180;
        const v = (p) => [Math.cos(p.alt * r) * Math.sin(p.az * r), Math.cos(p.alt * r) * Math.cos(p.az * r), Math.sin(p.alt * r)];
        const [p1, p2] = [v(a), v(b)];
        const sep = Math.acos(p1[0] * p2[0] + p1[1] * p2[1] + p1[2] * p2[2]) / r;
        expect(sep).toBeGreaterThan(1.35);
        expect(sep).toBeLessThan(1.75);
        expect(b.az).toBeGreaterThan(a.az);   // westward: Vega is in the west, azimuth grows toward 270°+
        await expect(page.locator('#sv-time-offset')).toHaveText('+2.0 days from start');
    });

    test('nightly playback advances whole days over a month range', async ({ page }) => {
        await openForecast(page, DENVER_NIGHT);
        await page.selectOption('#sv-speed', 'night');
        const t0 = await page.evaluate(() => window.__skyView.timeMs);
        await page.locator('#sv-play').click();
        await expect.poll(() => page.evaluate((t) => window.__skyView.timeMs - t, t0), { timeout: 10_000 }).toBeGreaterThanOrEqual(2 * 86_400_000);
        await page.locator('#sv-play').click();
        const st = await page.evaluate((t) => ({ d: (window.__skyView.timeMs - t) / 86_400_000, range: window.__skyView.range, playing: window.__skyView.playing }), t0);
        expect(Number.isInteger(st.d)).toBe(true);
        expect(st.range).toBe('month');
        expect(st.playing).toBe(false);
    });

    test('the card forecast is one row per night and jumps the clock', async ({ page }) => {
        await openForecast(page, DENVER_NIGHT);
        await page.locator('#sv-top-list .sv-top-item', { hasText: 'Vega' }).click();
        await expect(page.locator('#sv-card-fc .sv-fc-table tr')).toHaveCount(31);   // header + 30 nights
        await expect(page.locator('#sv-card-fc .sv-fc-sum')).toContainText('Its season peaks around');
        const anchor = await page.evaluate(() => window.__skyView.anchorMs);
        const fkey = await page.evaluate(() => window.__skyView._forecast.key);
        // Tap the 11th night's column.
        const svg = page.locator('#sv-fc-chart svg');
        await svg.scrollIntoViewIfNeeded();
        const box = await svg.boundingBox();
        const L = 30, R = 6, W = 360;
        const x = box.x + (L + 10.5 * (W - L - R) / 30) * box.width / W;
        await page.mouse.click(x, box.y + box.height / 2);
        const after = await page.evaluate(() => ({ t: window.__skyView.timeMs, a: window.__skyView.anchorMs, k: window.__skyView._forecast.key, n: window.__skyView._forecast.grid.nights[10] }));
        expect(after.a).toBe(anchor);
        expect(after.k).toBe(fkey);
        const jd = after.t / 86_400_000 + 2440587.5;
        expect(jd).toBeGreaterThanOrEqual(after.n.noonJd);
        expect(jd).toBeLessThan(after.n.noonJd + 1);
    });
});
