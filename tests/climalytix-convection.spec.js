/**
 * climalytix-convection.spec.js — browser gate for the map's STORM INGREDIENTS
 * layer (plan §19 T6: GFS CAPE / CIN / lifted index + the T4 thermals as lift).
 *
 * The mock ingredients are LINEAR in lat/lon (`mockConvection`) and the
 * thermal inputs are T4's closed forms, so every outlook the page shows is
 * RECOMPUTED here with the kernel from the same inputs.
 *   · midday: the site has a weak lid and moderate thermals → 'likely'; 2°
 *     north has MORE CAPE under a lid thermals cannot break → 'capped'.
 *     NEGATIVE CONTROL (in-test): ranking by CAPE alone puts the north point
 *     first — the page must not. Both outlook colours are on the canvas, and
 *     the layer takes over the fill group
 *   · CAPE view: the site value is the closed form; the CAPE fill draws
 *   · night: no thermals → only 'possible' at the site, and the 48 h strip
 *     carries both possible and likely steps
 *   · an archive ingested before the convection fields says so, draws nothing
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks, mockConvection, mockThermal, mockTempC } from './fixtures/climalytix-mocks.mjs';
import { convectionOutlook, OUTLOOK_COLORS } from '../js/climalytix/convection.js';
import { thermalAt } from '../js/climalytix/thermals.js';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const SITE = { lat: 40.02, lon: -105.27 };
const H = 3_600_000;

test.describe.configure({ timeout: 120_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });

function nextUtc(hour) {
    let t = Math.floor(Date.now() / 86_400_000) * 86_400_000 + hour * H;
    while (t < Date.now() + 4 * H) t += 86_400_000;
    return t;
}

async function boot(page, mocks = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    await installClimalytixMocks(page, mocks);
    await page.addInitScript((device) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('ppx_user_location', JSON.stringify(device));
        localStorage.setItem('ppx_tour_completed', '1');
    }, BOULDER);
    await page.goto('/climalytix.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__climalytix?.state?.map?.drawn?.heat, null, { timeout: 60_000 });
    await page.evaluate(() => document.querySelectorAll('.pp-consent-banner,.tour-overlay,.tour-tooltip').forEach((e) => e.remove()));
    return errors;
}

async function convectionAt(page, ms) {
    await page.evaluate((t) => window.__climalytix.map.setTime(t), ms);
    await page.locator('#cx-layer-cv').check();
    await page.waitForFunction((t) => {
        const c = window.__climalytix.state.map.convection;
        return c.state !== 'loading' && c.timeMs === t;
    }, ms, { timeout: 60_000 });
    return page.evaluate(() => window.__climalytix.state.map);
}

/** The kernel at a point from the closed forms (thermals: the flux window ending at the next stamp). */
function expected(lat, lon, ms) {
    const end = Math.ceil(ms / (3 * H)) * 3 * H, start = end - 3 * H, f = (ms - start) / (3 * H);
    const lerp = (a, b) => a + (b - a) * f;
    const m0 = mockThermal(lat, lon, start, SITE), m1 = mockThermal(lat, lon, end, SITE);
    const t0 = mockTempC(lat, lon, start, SITE), t1 = mockTempC(lat, lon, end, SITE);
    const th = thermalAt({
        fluxWm2: m1.shflxWm2, ziM: lerp(m0.hpblM, m1.hpblM), psfcHpa: lerp(m0.psfcHpa, m1.psfcHpa),
        tempC: lerp(t0, t1), dewC: lerp(t0 - m0.spreadK, t1 - m1.spreadK),
    });
    const c = mockConvection(lat, lon, ms, SITE);
    const triggers = th && th.regime !== 'none' ? [{ key: 'thermal', w: th.wstar }] : [];
    return { ...convectionOutlook({ ...c, triggers }), thermal: th };
}

test('midday: likely at the site, CAPPED 2° north under more CAPE — NEGATIVE CONTROL: CAPE alone ranks north first', async ({ page }) => {
    const errors = await boot(page);
    const ms = nextUtc(20) + 0.5 * H;
    const st = await convectionAt(page, ms);
    const cv = st.convection;
    expect(cv.state).toBe('live');
    const site = expected(SITE.lat, SITE.lon, ms);
    expect(site.category).toBe('likely');
    expect(cv.site.category).toBe('likely');
    expect(Math.abs(cv.site.capeJkg - site.capeJkg), 'the mock site is rounded to 0.01°: 150 J/kg per degree').toBeLessThan(2);
    expect(Math.abs(cv.site.cinJkg - site.cinJkg)).toBeLessThan(0.1);
    expect(Math.abs(cv.site.best.w - site.best.w)).toBeLessThan(0.02);
    const north = await page.evaluate(([la, lo]) => window.__climalytix.map.convectionAt(la, lo), [SITE.lat + 2, SITE.lon]);
    const wantN = expected(SITE.lat + 2, SITE.lon, ms);
    expect(wantN.category).toBe('capped');
    expect(north.category).toBe('capped');
    expect(north.capeJkg).toBeGreaterThan(cv.site.capeJkg);           // the CAPE-only ranking would pick it
    expect(cv.counts.capped).toBeGreaterThan(0);
    expect(cv.counts.likely).toBeGreaterThan(0);
    expect(st.drawn.convection).toEqual({ drawn: true, mode: 'outlook' });
    expect(st.drawn.heat).toBe(false);
    await expect(page.locator('#cx-layer-temp')).not.toBeChecked();
    // Both category colours are on the canvas — flat bands, no interpolated colour between them.
    const seen = await page.evaluate((cols) => {
        const c = document.querySelector('#cx-map-canvas'), g = c.getContext('2d');
        const d = g.getImageData(0, 0, c.width, c.height).data;
        const hit = Object.fromEntries(Object.keys(cols).map((k) => [k, 0]));
        for (let i = 0; i < d.length; i += 16) {
            for (const [k, rgb] of Object.entries(cols)) {
                // A fill composited over the basemap moves toward its own colour; test the hue's signature.
                if (k === 'likely' && d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 100) hit[k]++;
            }
        }
        return hit;
    }, { likely: OUTLOOK_COLORS.likely[0], capped: OUTLOOK_COLORS.capped[0] });
    expect(seen.likely).toBeGreaterThan(50);
    await expect(page.locator('#cx-cv-status')).toContainText('storms likely');
    await expect(page.locator('#cx-cv-status')).toContainText('not a probability');
    expect(errors).toEqual([]);
});

test('CAPE view: the site value is the closed form and the CAPE fill draws', async ({ page }) => {
    const errors = await boot(page);
    const ms = nextUtc(20);
    await convectionAt(page, ms);
    await page.locator('#cx-cv-mode [data-cv="cape"]').click();
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.convection.mode === 'cape');
    const st = await page.evaluate(() => window.__climalytix.state.map);
    expect(Math.abs(st.convection.site.capeJkg - mockConvection(SITE.lat, SITE.lon, ms, SITE).capeJkg), 'the mock site is rounded to 0.01°: 150 J/kg per degree').toBeLessThan(2);
    expect(st.convection.site.liBand).toBe('marginally unstable');       // LI = 2 − 1500/400 = −1.75
    await expect(page.locator('#cx-cv-key')).toHaveAttribute('data-mode', 'cape');
    expect(errors).toEqual([]);
});

test('night: no thermals → only possible at the site; the 48 h strip shows possible AND likely steps', async ({ page }) => {
    const errors = await boot(page);
    const ms = nextUtc(7);
    const st = await convectionAt(page, ms);
    const want = expected(SITE.lat, SITE.lon, ms);
    expect(want.category).toBe('possible');
    expect(st.convection.site.category).toBe('possible');
    expect(st.convection.site.best).toBe(null);
    const cats = st.convection.strip.map((r) => r.category);
    expect(cats.length).toBeGreaterThanOrEqual(16);
    expect(cats).toContain('possible');
    expect(cats).toContain('likely');
    for (const r of st.convection.strip) {
        if (r.t <= Date.now()) continue;
        expect(r.category, new Date(r.t).toISOString()).toBe(expected(SITE.lat, SITE.lon, r.t).category);
    }
    await expect(page.locator('#cx-cv-status .cx-cv-cell')).toHaveCount(cats.length);
    await expect(page.locator('#cx-cv-status')).toContainText('no thermals');
    expect(errors).toEqual([]);
});

test('an archive ingested before the convection fields says so and draws nothing', async ({ page }) => {
    const errors = await boot(page, { convection: 'missing' });
    await page.locator('#cx-layer-cv').check();
    await expect(page.locator('#cx-cv-status')).toContainText('ingested before the convection fields');
    expect((await page.evaluate(() => window.__climalytix.state.map)).drawn.convection.drawn).toBe(false);
    expect(errors).toEqual([]);
});
