/**
 * climalytix-airflow.spec.js — browser gate for the map's AIRFLOW layer.
 *
 * Every feed is mocked (tests/fixtures/climalytix-mocks.mjs): the wind field
 * is a closed form (`mockWind`: a 6 m/s westerly plus a cyclonic swirl), so
 * the drawn motion can be checked against an answer written independently of
 * the page. What it pins:
 *   · particles MOVE WITH THE WIND: each one's displacement points along the
 *     closed-form wind at its position — NEGATIVE CONTROL: the same motion
 *     scored against the wind with u and v swapped fails
 *   · the layer paints the flow canvas; toggled off it is clear and the
 *     animation stops (frames stop counting)
 *   · the animation stops when the map is scrolled off screen
 *   · reduced motion draws static STREAMLINES and runs no animation
 *   · the wind rose's prevailing direction is the one the site's hours give;
 *     the hover readout carries a direction and a speed in the reader's unit
 *   · a run without wind: no flow, the rail says why, the heat still draws
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks, mockWind } from './fixtures/climalytix-mocks.mjs';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const M_PER_DEG = 111_320;

test.describe.configure({ timeout: 90_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', viewport: { width: 1366, height: 900 } });

async function boot(page, { mocks = {}, until = (m) => m.drawn.airflow?.frames > 5 } = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    await installClimalytixMocks(page, mocks);
    await page.addInitScript((device) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('ppx_user_location', JSON.stringify(device));
        localStorage.setItem('ppx_tour_completed', '1');
    }, BOULDER);
    await page.goto('/climalytix.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(`(() => { const m = window.__climalytix?.state?.map; return m && (${until})(m); })()`, null, { timeout: 60_000 });
    await page.evaluate(() => document.querySelectorAll('.pp-consent-banner,.tour-overlay,.tour-tooltip').forEach((e) => e.remove()));
    return errors;
}

const mapState = (page) => page.evaluate(() => window.__climalytix.state.map);
const frames = async (page) => (await mapState(page)).drawn.airflow.frames;

test.describe('animated', () => {
    test.use({ reducedMotion: 'no-preference' });

    test('particles move WITH the wind — NEGATIVE CONTROL: scored against swapped u/v they do not', async ({ page }) => {
        const errors = await boot(page);
        const pair = await page.evaluate(() => new Promise((resolve) => {
            const map = window.__climalytix.map;
            const a = map.flowSnapshot();
            // Two animation frames later (the flow steps once per frame).
            requestAnimationFrame(() => requestAnimationFrame(() => resolve({ a, b: map.flowSnapshot() })));
        }));
        const score = (windFn) => {
            const cos = [];
            pair.a.forEach((p, k) => {
                const q = pair.b[k];
                if (!q || q.born) return;
                const dLat = q.lat - p.lat, dLon = q.lon - p.lon;
                if (Math.abs(dLat) > 0.5 || Math.abs(dLon) > 0.5) return;          // reborn in between
                const mid = { lat: (p.lat + q.lat) / 2, lon: (p.lon + q.lon) / 2 };
                const dx = dLon * M_PER_DEG * Math.cos(mid.lat * Math.PI / 180), dy = dLat * M_PER_DEG;
                const w = windFn(mid.lat, mid.lon);
                const n = Math.hypot(dx, dy) * Math.hypot(w.u, w.v);
                if (n > 0) cos.push((dx * w.u + dy * w.v) / n);
            });
            cos.sort((x, y) => x - y);
            return { n: cos.length, median: cos[Math.floor(cos.length / 2)] };
        };
        const right = score((lat, lon) => mockWind(lat, lon, BOULDER));
        const swapped = score((lat, lon) => { const w = mockWind(lat, lon, BOULDER); return { u: w.v, v: w.u }; });
        expect(right.n).toBeGreaterThan(50);
        expect(right.median, JSON.stringify({ right, swapped })).toBeGreaterThan(0.99);
        expect(swapped.median).toBeLessThan(0.6);
        expect(errors).toEqual([]);
    });

    test('the layer paints the flow canvas; off, it is clear and the animation stops', async ({ page }) => {
        const errors = await boot(page, { until: (m) => m.drawn.airflow?.frames > 30 });
        const on = await page.evaluate(() => window.__climalytix.map.flowCoverage());
        expect(on).toBeGreaterThan(0.01);
        await page.locator('#cx-layer-airflow').uncheck();
        await page.waitForTimeout(200);
        const f0 = await frames(page);
        await page.waitForTimeout(400);
        expect(await frames(page)).toBe(f0);
        expect((await mapState(page)).drawn.airflow.mode).toBe(null);
        expect(await page.evaluate(() => window.__climalytix.map.flowCoverage())).toBe(0);
        await expect(page.locator('#cx-flow-status')).toHaveText('Airflow layer off.');
        await page.locator('#cx-layer-airflow').check();
        await page.waitForFunction((f) => window.__climalytix.state.map.drawn.airflow.frames > f + 5, f0);
        await expect(page.locator('#cx-flow-status')).toContainText('Wind at');
        await expect(page.locator('#cx-flow-status')).toContainText('of travel');
        expect(errors).toEqual([]);
    });

    test('scrolled off screen the animation stops; back on screen it resumes', async ({ page }) => {
        const errors = await boot(page);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.evaluate(() => document.body.style.minHeight = '4000px');
        await page.evaluate(() => window.scrollTo(0, 4000));
        await page.waitForTimeout(300);
        const f0 = await frames(page);
        await page.waitForTimeout(500);
        expect(await frames(page)).toBe(f0);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForFunction((f) => window.__climalytix.state.map.drawn.airflow.frames > f + 3, f0);
        expect(errors).toEqual([]);
    });
});

test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('static streamlines, no animation', async ({ page }) => {
        const errors = await boot(page, { until: (m) => m.drawn.airflow?.mode === 'streamlines' });
        const s = await mapState(page);
        expect(s.drawn.airflow.lines).toBeGreaterThan(50);
        expect(s.drawn.airflow.frames).toBe(0);
        expect(await page.evaluate(() => window.__climalytix.map.flowCoverage())).toBeGreaterThan(0.005);
        expect(errors).toEqual([]);
    });

    test('the rose and the hover readout: prevailing direction, wind in the reader’s unit', async ({ page }) => {
        const errors = await boot(page, { until: (m) => m.drawn.airflow?.mode === 'streamlines' });
        const rose = await page.evaluate(() => window.__climalytix.state.rose);
        expect(rose.n).toBe(81);
        // The site's hours are mostly westerly (u = 5 ± 3, v = ±4): W-ish, never from the east.
        expect(['W', 'WNW', 'WSW']).toContain(rose.prevailing.name);
        expect(rose.freq[4]).toBe(0);                                         // E sector empty
        await expect(page.locator('#cx-rose-caption')).toContainText(`mostly from the ${rose.prevailing.name}`);
        const s = await mapState(page);
        const box = await page.locator('#cx-map-canvas').boundingBox();
        await page.mouse.move(box.x + s.size.w / 2 + 30, box.y + s.size.h / 2 + 30);
        await expect(page.locator('#cx-map-tip')).toHaveText(/\b(N|NNE|NE|ENE|E|ESE|SE|SSE|S|SSW|SW|WSW|W|WNW|NW|NNW)\s\d+(\.\d+)?\smph/);
        // The direction is the closed-form wind's at the coordinates the tip itself prints.
        const tip = await page.locator('#cx-map-tip').innerText();
        const [, la, ns, lo, ew] = /([\d.]+)°([NS])\s([\d.]+)°([EW])/.exec(tip);
        const w = mockWind((ns === 'N' ? 1 : -1) * +la, (ew === 'E' ? 1 : -1) * +lo, BOULDER);
        const from = (Math.atan2(-w.u, -w.v) * 180 / Math.PI + 360) % 360;
        const NAMES = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
        expect(tip).toMatch(new RegExp(`(^|\\s)${NAMES[Math.round(from / 22.5) % 16]}\\s\\d`));
        const mph = +/(\d+(?:\.\d+)?)\smph/.exec(tip)[1];
        expect(Math.abs(mph - Math.hypot(w.u, w.v) * 2.23694)).toBeLessThan(1.5);
        expect(errors).toEqual([]);
    });

    test('a run without wind: no flow, the rail says why, the heat still draws', async ({ page }) => {
        const errors = await boot(page, { mocks: { nwp: 'nowind' }, until: (m) => m.drawn.heat && m.wind.state === 'down' });
        const s = await mapState(page);
        expect(s.drawn.airflow.mode).toBe(null);
        await expect(page.locator('#cx-flow-status')).toContainText('No airflow');
        await expect(page.locator('#cx-flow-status')).toContainText('Nothing is substituted');
        expect(errors).toEqual([]);
    });
});
