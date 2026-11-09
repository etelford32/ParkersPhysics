/**
 * climalytix-map.spec.js — browser gate for the Climalytix location map.
 *
 * Every feed is mocked (tests/fixtures/climalytix-mocks.mjs): GIBS tiles are
 * real PNGs with CORS, the heat field is built by the route's own
 * fieldPlan + fieldBody. What it pins:
 *   · the map is at the TOP, centred on the site; the layer rail is LEFT of
 *     it with Temperature as the first toggle; the controls sit in the
 *     map's LOWER-RIGHT corner
 *   · the Temperature toggle draws the heat field (canvas pixels at the site
 *     change) — NEGATIVE CONTROL: toggled off, the pixel is the basemap's
 *   · isotherms are drawn in the READER'S unit and re-chosen on a unit
 *     switch; the freezing line is flagged exactly when the window spans
 *     0 °C; warmest/coldest are marked; each sub-toggle turns only itself off
 *     and both disable with Temperature
 *   · zoom ± / D-pad / recentre / keyboard / wheel-at-cursor / drag all move
 *     the view the right way, and the wheel does not scroll the page
 *   · our archive unpublished ⇒ no heat, the rail says why, the basemap
 *     still draws (nothing substituted for the archive)
 *   · the heat follows the timeline's crosshair
 *   · GIBS down ⇒ the heat and site still draw, no page error, and the
 *     SELF-HOSTED underlay still paints the ground — NEGATIVE CONTROL: block
 *     the underlay too and the ground is the bare ocean fill
 *   · Terrain shades the mountains west of Boulder — NEGATIVE CONTROL: off,
 *     those pixels are the basemap's again
 *   · Place labels name Denver beside the site without covering the ring;
 *     off, none are drawn
 *   · phone width: no horizontal scroll, controls inside the map
 */
import { test, expect } from '@playwright/test';
import { fieldWindow } from '../js/climalytix/point-tile.js';
import { installClimalytixMocks, baseTileColor } from './fixtures/climalytix-mocks.mjs';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const ZOOM_STEP = 1.6;

test.describe.configure({ timeout: 90_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', reducedMotion: 'reduce', viewport: { width: 1366, height: 900 } });

async function boot(page, { mocks = {}, waitHeat = true } = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    await installClimalytixMocks(page, mocks);
    await page.addInitScript((device) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('ppx_user_location', JSON.stringify(device));
        localStorage.setItem('ppx_tour_completed', '1');
    }, BOULDER);
    await page.goto('/climalytix.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((wh) => {
        const s = window.__climalytix?.state;
        return s && s.loading.length === 0 && s.map && s.field?.state !== 'loading' && (!wh || s.map.drawn.heat);
    }, waitHeat, { timeout: 60_000 });
    await page.evaluate(() => document.querySelectorAll('.pp-consent-banner,.tour-overlay,.tour-tooltip').forEach((e) => e.remove()));
    return errors;
}

const mapState = (page) => page.evaluate(() => window.__climalytix.state.map);
const nextFrame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** RGBA at a CSS point of the map canvas. */
function pixelAt(page, x, y) {
    return page.evaluate(([x, y]) => {
        const c = document.querySelector('#cx-map-canvas');
        const k = c.width / c.clientWidth;
        return [...c.getContext('2d').getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data];
    }, [x, y]);
}

test('the map is at the top, the layer rail is left of it, the controls are in its lower-right corner', async ({ page }) => {
    const errors = await boot(page);
    const box = async (sel) => page.locator(sel).boundingBox();
    const map = await box('#cx-map'), cat = await box('#cx-catalog'), exp = await box('#cx-explore');
    expect(map.y).toBeLessThan(cat.y);
    expect(map.y).toBeLessThan(exp.y);
    const rail = await box('#cx-map-layers'), stage = await box('#cx-map-stage');
    expect(rail.x + rail.width).toBeLessThanOrEqual(stage.x + 1);
    await expect(page.locator('#cx-map-layers .cx-layer').first()).toContainText('Temperature');
    await expect(page.locator('#cx-layer-temp')).toBeChecked();
    const ctl = await box('#cx-map-ctl');
    expect(stage.x + stage.width - (ctl.x + ctl.width)).toBeLessThanOrEqual(16);
    expect(stage.y + stage.height - (ctl.y + ctl.height)).toBeLessThanOrEqual(40);
    expect(ctl.x).toBeGreaterThan(stage.x + stage.width / 2);
    expect(ctl.y).toBeGreaterThan(stage.y + stage.height / 2);
    for (const a of ['zoom-in', 'zoom-out', 'pan-up', 'pan-down', 'pan-left', 'pan-right', 'recenter']) {
        await expect(page.locator(`#cx-map-ctl [data-map-act="${a}"]`)).toBeVisible();
    }
    const s = await mapState(page);
    expect(s.view.lat).toBeCloseTo(BOULDER.lat, 6);
    expect(s.view.lon).toBeCloseTo(BOULDER.lon, 6);
    expect(s.drawn.tiles).toBeGreaterThan(0);
    expect(errors).toEqual([]);
});

test('Temperature draws the heat field; NEGATIVE CONTROL: toggled off the site pixel is the basemap', async ({ page }) => {
    const errors = await boot(page);
    const s = await mapState(page);
    // V2: the window is fitted to the stage — ±4° of latitude and the longitude the view shows.
    const win = fieldWindow({ aspect: s.size.w / s.size.h, lat: BOULDER.lat });
    expect(win.halfLon).toBeGreaterThan(win.halfDeg);
    expect(s.field).toMatchObject({ nRows: 8 * win.halfDeg + 1, nCols: 8 * win.halfLon + 1 });
    expect(s.frame.range.max).toBeGreaterThan(s.frame.range.min);
    await expect(page.locator('#cx-heat-status')).toContainText('Valid');
    // A point inside the field, away from the site marker.
    const probe = { x: s.size.w / 2 - 60, y: s.size.h / 2 + 40 };
    // Base-map layers off so the bare tile colour is what is left.
    await page.locator('#cx-layer-terrain').uncheck();
    await page.locator('#cx-layer-labels').uncheck();
    await nextFrame(page);
    const on = await pixelAt(page, probe.x, probe.y);
    await page.locator('#cx-layer-temp').uncheck();
    await nextFrame(page);
    expect((await mapState(page)).drawn.heat).toBe(false);
    const off = await pixelAt(page, probe.x, probe.y);
    const dist = Math.hypot(on[0] - off[0], on[1] - off[1], on[2] - off[2]);
    expect(dist, `heat on ${on} vs off ${off}`).toBeGreaterThan(25);
    // Off, the pixel is one of the mock basemap's tile colours (z up to 7).
    const base = new Set();
    for (let z = 0; z <= 7; z++) for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) base.add(baseTileColor(z, r, c).join(','));
    const offRgb = off.slice(0, 3);
    expect([...base].some((k) => k.split(',').map(Number).every((v, i) => Math.abs(v - offRgb[i]) <= 2)), `${offRgb}`).toBe(true);
    await page.locator('#cx-layer-temp').check();
    await nextFrame(page);
    expect((await mapState(page)).drawn.heat).toBe(true);
    expect(errors).toEqual([]);
});

test('isotherms in the reader’s unit, the freezing line, warmest/coldest, and their toggles', async ({ page }) => {
    const errors = await boot(page);
    let s = await mapState(page);
    expect(s.drawn.isotherms).toBeGreaterThan(2);
    expect(s.drawn.extremes).toBe(true);
    const r = s.frame.range;
    expect(s.drawn.freezing).toBe(r.min < 0 && r.max > 0);
    const fLabels = s.drawn.isoLevels;
    // en-US default is °F; switch to metric and the levels are re-chosen in °C.
    await page.locator('#cx-units').selectOption('metric');
    await nextFrame(page);
    s = await mapState(page);
    expect(s.drawn.isoLevels).not.toEqual(fLabels);
    expect(s.drawn.isoLevels.every((l) => Number.isFinite(parseFloat(l)))).toBe(true);
    // Sub-toggles turn off only themselves.
    await page.locator('#cx-layer-iso').uncheck();
    await nextFrame(page);
    s = await mapState(page);
    expect(s.drawn.isotherms).toBe(0);
    expect(s.drawn.heat).toBe(true);
    expect(s.drawn.extremes).toBe(true);
    await page.locator('#cx-layer-ext').uncheck();
    await nextFrame(page);
    expect((await mapState(page)).drawn.extremes).toBe(false);
    // Temperature off disables both.
    await page.locator('#cx-layer-temp').uncheck();
    await expect(page.locator('#cx-layer-iso')).toBeDisabled();
    await expect(page.locator('#cx-layer-ext')).toBeDisabled();
    expect(errors).toEqual([]);
});

test('zoom, D-pad, recentre and the keyboard move the view the right way', async ({ page }) => {
    const errors = await boot(page);
    const v0 = (await mapState(page)).view;
    const click = async (a) => { await page.locator(`#cx-map-ctl [data-map-act="${a}"]`).click(); await nextFrame(page); return (await mapState(page)).view; };
    let v = await click('zoom-in');
    expect(v.span).toBeCloseTo(v0.span / ZOOM_STEP, 9);
    expect(v.lat).toBeCloseTo(v0.lat, 9);
    v = await click('zoom-out');
    expect(v.span).toBeCloseTo(v0.span, 9);
    expect((await click('pan-up')).lat).toBeGreaterThan(v0.lat);
    expect((await click('pan-right')).lon).toBeGreaterThan(v0.lon);
    expect((await click('pan-left')).lon).toBeCloseTo(v0.lon, 6);
    expect((await click('pan-down')).lat).toBeCloseTo(v0.lat, 6);
    await click('pan-left'); await click('zoom-in');
    v = await click('recenter');
    expect(v.lat).toBeCloseTo(BOULDER.lat, 6);
    expect(v.lon).toBeCloseTo(BOULDER.lon, 6);
    // Keyboard, once the map has focus.
    await page.locator('#cx-map-canvas').focus();
    await page.keyboard.press('+');
    await nextFrame(page);
    expect((await mapState(page)).view.span).toBeLessThan(v.span);
    await page.keyboard.press('ArrowRight');
    await nextFrame(page);
    expect((await mapState(page)).view.lon).toBeGreaterThan(v.lon);
    await page.keyboard.press('0');
    await nextFrame(page);
    expect((await mapState(page)).view.lon).toBeCloseTo(BOULDER.lon, 6);
    expect(errors).toEqual([]);
});

test('the wheel zooms AT THE CURSOR without scrolling the page; a drag pans', async ({ page }) => {
    const errors = await boot(page);
    const stage = await page.locator('#cx-map-canvas').boundingBox();
    const v0 = (await mapState(page)).view;
    const scroll0 = await page.evaluate(() => window.scrollY);
    // Cursor in the upper-left quarter: zooming in pulls the centre toward it.
    await page.mouse.move(stage.x + stage.width * 0.25, stage.y + stage.height * 0.25);
    await page.mouse.wheel(0, -300);
    await page.waitForFunction((s) => window.__climalytix.state.map.view.span < s, v0.span);
    const v1 = (await mapState(page)).view;
    expect(v1.lat).toBeGreaterThan(v0.lat);
    expect(v1.lon).toBeLessThan(v0.lon);
    expect(await page.evaluate(() => window.scrollY)).toBe(scroll0);
    // Drag to the right: the content follows the pointer, so the view looks west.
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width / 2 + 150, stage.y + stage.height / 2 + 20, { steps: 6 });
    await page.mouse.up();
    await nextFrame(page);
    const v2 = (await mapState(page)).view;
    expect(v2.lon).toBeLessThan(v1.lon);
    expect(v2.lat).toBeGreaterThan(v1.lat);
    expect(errors).toEqual([]);
});

test('our archive unpublished: no heat, the rail says why, the basemap still draws', async ({ page }) => {
    const errors = await boot(page, { mocks: { nwp: 'unpublished' }, waitHeat: false });
    const s = await mapState(page);
    expect(s.drawn.heat).toBe(false);
    expect(s.field).toBe(null);
    expect(s.drawn.tiles).toBeGreaterThan(0);
    await expect(page.locator('#cx-heat-status')).toHaveAttribute('data-state', 'down');
    await expect(page.locator('#cx-heat-status')).toContainText('not published yet');
    await expect(page.locator('#cx-heat-status')).toContainText('Nothing is substituted');
    expect(errors).toEqual([]);
});

test('the heat follows the timeline crosshair, and returns to now when it leaves', async ({ page }) => {
    const errors = await boot(page);
    const t0 = (await mapState(page)).frame.t;
    await page.locator('[data-range="7d"]').click();
    await expect(page.locator('#cx-step')).toContainText('7 days');
    await nextFrame(page);
    const svg = page.locator('[data-panel="temp"] .cx-panel-svg');
    await svg.scrollIntoViewIfNeeded();
    const b = await svg.boundingBox();
    await page.mouse.move(b.x + b.width * 0.93, b.y + b.height / 2);          // ~+2.5 days
    await page.waitForFunction((t) => window.__climalytix.state.map.frame.t !== t, t0);
    const t1 = (await mapState(page)).frame.t;
    expect(t1).toBeGreaterThan(t0);
    await page.mouse.move(5, 5);
    await page.waitForFunction((t) => window.__climalytix.state.map.frame.t === t, t0);
    expect(errors).toEqual([]);
});

test('GIBS down: the heat and the site still draw and the self-hosted underlay paints the ground', async ({ page }) => {
    const errors = await boot(page, { mocks: { gibs: 'down' } });
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.underlay);
    const s = await mapState(page);
    expect(s.drawn.tiles).toBe(0);
    expect(s.drawn.heat).toBe(true);
    expect(s.drawn.underlay).toBe('4k');                          // zoomed in: the largest tier
    for (const id of ['#cx-layer-temp', '#cx-layer-terrain', '#cx-layer-labels']) await page.locator(id).uncheck();
    await nextFrame(page);
    const px = await pixelAt(page, s.size.w / 2 - 60, s.size.h / 2 + 40);
    // Not the ocean fill: Blue Marble's Colorado ground.
    expect(Math.hypot(px[0] - 0x0a, px[1] - 0x1a, px[2] - 0x2e), `${px}`).toBeGreaterThan(30);
    expect(errors).toEqual([]);
});

test('NEGATIVE CONTROL: GIBS down AND the underlay blocked ⇒ the bare ocean fill', async ({ page }) => {
    const errors = await boot(page, { mocks: { gibs: 'down', earth: 'blocked' } });
    for (const id of ['#cx-layer-temp', '#cx-layer-terrain', '#cx-layer-labels']) await page.locator(id).uncheck();
    await nextFrame(page);
    const s = await mapState(page);
    expect(s.drawn.underlay).toBe(null);
    const px = await pixelAt(page, s.size.w / 2 - 60, s.size.h / 2 + 40);
    expect(Math.hypot(px[0] - 0x0a, px[1] - 0x1a, px[2] - 0x2e), `${px}`).toBeLessThan(4);
    expect(errors).toEqual([]);
});

test('Terrain shades the mountains; NEGATIVE CONTROL: off, those pixels are the basemap again', async ({ page }) => {
    const errors = await boot(page);
    await page.locator('#cx-layer-temp').uncheck();
    await page.locator('#cx-layer-labels').uncheck();
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.terrain);
    const s = await mapState(page);
    expect(s.relief.state).toBe('ok');
    // A strip across the Front Range, west of the site.
    const strip = (page) => page.evaluate(([w, h]) => {
        const c = document.querySelector('#cx-map-canvas');
        const k = c.width / c.clientWidth;
        return [...c.getContext('2d').getImageData(Math.round((w / 2 - 160) * k), Math.round((h / 2 - 20) * k), Math.round(140 * k), Math.round(40 * k)).data];
    }, [s.size.w, s.size.h]);
    const on = await strip(page);
    await page.locator('#cx-layer-terrain').uncheck();
    await nextFrame(page);
    expect((await mapState(page)).drawn.terrain).toBe(false);
    const off = await strip(page);
    let changed = 0, n = 0;
    for (let i = 0; i < on.length; i += 4, n++) if (Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]) > 12) changed++;
    expect(changed / n, `${changed}/${n} pixels shaded`).toBeGreaterThan(0.25);
    // Off, every pixel is a mock tile colour (the overlay is gone, not dimmed).
    const base = new Set();
    for (let z = 0; z <= 7; z++) for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) base.add(baseTileColor(z, r, c).join(','));
    expect(base.has(off.slice(0, 3).join(',')) || [...base].some((b) => b.split(',').map(Number).every((v, i) => Math.abs(v - off[i]) <= 2))).toBe(true);
    expect(errors).toEqual([]);
});

test('Place labels name Denver beside the site without covering it; off, none', async ({ page }) => {
    const errors = await boot(page);
    let s = await mapState(page);
    expect(s.drawn.labels).toContain('Denver');
    await page.locator('#cx-layer-labels').uncheck();
    await nextFrame(page);
    s = await mapState(page);
    expect(s.drawn.labels).toEqual([]);
    expect(errors).toEqual([]);
});

test.describe('phone width', () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test('no horizontal scroll; the controls are inside the map', async ({ page }) => {
        const errors = await boot(page);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        const stage = await page.locator('#cx-map-stage').boundingBox();
        const ctl = await page.locator('#cx-map-ctl').boundingBox();
        expect(ctl.x).toBeGreaterThanOrEqual(stage.x);
        expect(ctl.x + ctl.width).toBeLessThanOrEqual(stage.x + stage.width + 1);
        expect(ctl.y + ctl.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
        expect(errors).toEqual([]);
    });
});
