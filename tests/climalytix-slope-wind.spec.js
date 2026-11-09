/**
 * climalytix-slope-wind.spec.js — browser gate for the map's SLOPE WINDS
 * (plan §19 T3: Prandtl anabatic / katabatic flow along each fall line).
 *
 * The DEM is the closed-form east–west ridge at 40°N (MOCK_RIDGE: each flank
 * a plane of known slope facing due south / due north); the GFS cloud field
 * is mocked (`cloudFn`, default clear). The map is set to two instants —
 * local solar NOON and local MIDNIGHT at the ridge — and every value the page
 * reports is RECOMPUTED here with the kernel from the page's own inputs plus
 * an independent Sun (js/sun-altitude.js), so the timeline instant, the Sun,
 * the cloud field and the temperature all have to reach the kernel intact.
 *   · noon: both flanks blow UPSLOPE along their fall lines (south flank →
 *     north, north flank → south), the sun-facing flank harder; amber arrows
 *     only; the rail says the air is sliding up
 *   · midnight: both flanks DRAIN downslope with EQUAL speed (no Sun, no
 *     aspect); blue arrows only
 *   · overcast cuts noon flow by more than half — the cloud field reached
 *     the kernel (an always-clear page would fail this)
 *   · no cloud field ⇒ clear sky assumed and the rail says these are upper
 *     bounds; no DEM ⇒ no arrows, and the rail says why
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks, MOCK_RIDGE } from './fixtures/climalytix-mocks.mjs';
import { slopeWind, surfaceBudget } from '../js/climalytix/slope-wind.js';
import { solarPosition } from '../js/sun-altitude.js';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const H = 3_600_000;
const LON = -105.4;

test.describe.configure({ timeout: 120_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', viewport: { width: 1366, height: 900 }, reducedMotion: 'reduce' });

/** The next instant (≥ 3 h ahead, inside the mocked run) at the given UTC hour. */
function nextUtcHour(hour) {
    const now = Date.now();
    let t = Math.floor(now / 86_400_000) * 86_400_000 + hour * H;
    while (t < now + 3 * H) t += 86_400_000;
    return t;
}
// Solar noon at 105.4°W is ~19:02 UTC (±16 min equation of time); midnight ~07:02.
const NOON = nextUtcHour(19), MIDNIGHT = nextUtcHour(7);

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

/** Slope winds on, zoomed until the slope grid resolves the 0.1° flanks, at instant `ms`. */
async function slopeWindsAt(page, ms) {
    await page.locator('#cx-layer-slope').check();
    await page.waitForFunction(() => window.__climalytix.state.map.dem.state !== 'idle', null, { timeout: 60_000 });
    await page.evaluate(() => { for (let k = 0; k < 3; k++) window.__climalytix.map.act('zoom-in'); });
    await page.evaluate((t) => window.__climalytix.map.setTime(t), ms);
    await page.waitForFunction(() => {
        const m = window.__climalytix.state.map;
        return m.dem.state === 'ok' && m.dem.resM != null && m.dem.resM < 2500 && m.slopewind.state === 'ok';
    }, null, { timeout: 60_000 });
}
const at = (page, lat) => page.evaluate(([a, b]) => window.__climalytix.map.terrainAt(a, b), [lat, LON]);

/** The kernel's answer from the page's own slope/aspect/θ0/cloud and an independent Sun. */
function kernel(tr, lat, ms, cloudFrac = tr.slopeWind.cloudFrac) {
    return slopeWind({ slopeDeg: tr.slope, aspectDeg: tr.aspect, sun: solarPosition(new Date(ms), lat, LON),
        cloudFrac, theta0K: tr.slopeWind.theta0K });
}
const bearingGap = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

test('noon: both flanks blow UPSLOPE along their fall lines, the sun-facing one harder', async ({ page }) => {
    const errors = await boot(page);
    await slopeWindsAt(page, NOON);
    const latS = MOCK_RIDGE.lat - 0.05, latN = MOCK_RIDGE.lat + 0.05;
    const s = await at(page, latS), n = await at(page, latN);
    expect(s.slopeWind.regime, JSON.stringify(s.slopeWind)).toBe('anabatic');
    expect(n.slopeWind.regime, JSON.stringify(n.slopeWind)).toBe('anabatic');
    expect(bearingGap(s.slopeWind.toward, 0)).toBeLessThan(3);      // south flank: upslope = north
    expect(bearingGap(n.slopeWind.toward, 180)).toBeLessThan(3);    // north flank: upslope = south
    expect(s.slopeWind.u).toBeGreaterThan(n.slopeWind.u);
    expect(s.slopeWind.cloudFrac).toBe(0);
    // The kernel, with an independent Sun at the timeline instant, agrees.
    for (const [tr, lat] of [[s, latS], [n, latN]]) {
        const k = kernel(tr, lat, NOON);
        expect(Math.abs(k.u - tr.slopeWind.u), `${k.u} vs ${tr.slopeWind.u}`).toBeLessThan(0.03);
        expect(Math.abs(k.q - tr.slopeWind.q)).toBeLessThan(5);
    }
    expect(s.slopeWind.theta0K).toBeGreaterThan(250);               // the mock 2 m temperature reached it
    const st = await page.evaluate(() => window.__climalytix.state.map);
    expect(st.drawn.slopewind.up).toBeGreaterThan(0);
    expect(st.drawn.slopewind.down).toBe(0);
    await expect(page.locator('#cx-slope-status')).toContainText('sliding UP');
    await expect(page.locator('#cx-slope-key')).toBeVisible();
    expect(errors).toEqual([]);
});

test('midnight: both flanks DRAIN downslope at equal speed', async ({ page }) => {
    const errors = await boot(page);
    await slopeWindsAt(page, MIDNIGHT);
    const s = await at(page, MOCK_RIDGE.lat - 0.05), n = await at(page, MOCK_RIDGE.lat + 0.05);
    expect(s.slopeWind.regime).toBe('katabatic');
    expect(n.slopeWind.regime).toBe('katabatic');
    expect(bearingGap(s.slopeWind.toward, 180)).toBeLessThan(3);    // south flank drains south
    expect(bearingGap(n.slopeWind.toward, 0)).toBeLessThan(3);      // north flank drains north
    expect(Math.abs(s.slopeWind.u - n.slopeWind.u)).toBeLessThan(0.02);
    const k = kernel(s, MOCK_RIDGE.lat - 0.05, MIDNIGHT);
    expect(Math.abs(k.u - s.slopeWind.u)).toBeLessThan(0.03);
    const st = await page.evaluate(() => window.__climalytix.state.map);
    expect(st.drawn.slopewind.down).toBeGreaterThan(0);
    expect(st.drawn.slopewind.up).toBe(0);
    await expect(page.locator('#cx-slope-status')).toContainText('draining DOWN');
    // Flat ground says so instead of drawing a wind.
    expect((await at(page, MOCK_RIDGE.lat - 0.5)).slopeWind.regime).toBe('flat');
    expect(errors).toEqual([]);
});

test('overcast cuts the noon flow by more than half — the cloud field reaches the kernel', async ({ page }) => {
    const errors = await boot(page, { cloudFn: () => 1 });
    await slopeWindsAt(page, NOON);
    const lat = MOCK_RIDGE.lat - 0.05;
    const s = await at(page, lat);
    expect(s.slopeWind.cloudFrac).toBe(1);
    const clear = kernel(s, lat, NOON, 0);
    expect(s.slopeWind.u, `overcast ${s.slopeWind.u} vs clear ${clear.u}`).toBeLessThan(clear.u / 2);
    const b = surfaceBudget({ incidence: 1, sunAltDeg: 30, cloudFrac: 1 });
    expect(b.sw).toBeLessThan(surfaceBudget({ incidence: 1, sunAltDeg: 30, cloudFrac: 0 }).sw / 3);
    expect(errors).toEqual([]);
});

test('no cloud field ⇒ clear sky assumed and said; no DEM ⇒ no arrows', async ({ page }) => {
    let errors = await boot(page, { cloud: 'missing' });
    await slopeWindsAt(page, NOON);
    await expect(page.locator('#cx-slope-status')).toContainText('clear sky assumed');
    await expect(page.locator('#cx-slope-status')).toContainText('UPPER bounds');
    expect((await page.evaluate(() => window.__climalytix.state.map)).drawn.slopewind.arrows).toBeGreaterThan(0);
    expect(errors).toEqual([]);

    errors = await boot(page, { dem: 'down' });
    await page.locator('#cx-layer-slope').check();
    await page.waitForFunction(() => window.__climalytix.state.map.dem.state === 'down', null, { timeout: 60_000 });
    await expect(page.locator('#cx-slope-status')).toContainText('Elevation tiles unavailable');
    expect((await page.evaluate(() => window.__climalytix.state.map)).drawn.slopewind.arrows).toBe(0);
    expect(errors).toEqual([]);
});
