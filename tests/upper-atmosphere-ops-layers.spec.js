/**
 * upper-atmosphere-ops-layers.spec.js — the rings are layers
 * ═══════════════════════════════════════════════════════════════════════════
 * The operational bands' rings (plan §9.14 / §9.15) answer the cursor and
 * expand into layers. Hermetic (the feeds fixture), on the manual frame
 * clock so the expansion's easing can be stepped. Pins:
 *
 *   • HOVER: a ring edge under the cursor sets the globe's hover (kernel
 *     `pickOpsBand` through the globe's pick), the cursor turns to a
 *     pointer, and the ring wins over the hidden-but-hittable layer shells;
 *   • CLICK selects: the band expands (weight → 1 within the ease), the
 *     others dim, the card opens with the band's name and its live
 *     numbers, the column strip and the legend row mark it; clicking the
 *     same ring again deselects; a click on empty sky clears;
 *   • the card's ‹ › step the ladder, ✕ and Esc clear, "Go there" rides the
 *     camera into the band (the explore column's own `goToAltitude`);
 *   • the strip in the explore column selects and toggles; a legend row
 *     selects;
 *   • from INSIDE a band its expansion is not drawn (the chord assumes an
 *     outside camera) and comes back once the camera is out;
 *   • turning the bands off clears the selection.
 */

import { test, expect } from '@playwright/test';
import { routeUpperAtmosphereFeeds } from './fixtures/upper-atmosphere-feeds.mjs';
import { OPS_BANDS } from '../js/upper-atmosphere-ops-bands.js';

const URL = '/upper-atmosphere.html';
const DT = 1 / 60;
test.describe.configure({ timeout: 240_000 });

async function boot(page) {
    await routeUpperAtmosphereFeeds(page);
    await page.route('**/api/donki/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.globe?.stepFrames && !!window.__ua?.bandCard, null, { timeout: 60_000 });
    const consent = page.locator('.pp-consent-banner');
    await consent.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) await consent.locator('[data-action="reject"]').click().catch(() => {});
    await page.evaluate(() => { const g = window.__ua.globe; g.setManualClock(true, { startMs: 1.0e6 }); g.seedRandom(7); g.setBeaconsVisible(false); });
    // Two zoom-outs: at the home framing the rings run under the chrome.
    await page.click('#ua-cam-zoom-out');
    await page.click('#ua-cam-zoom-out');
    await step(page, 5);
}
const step = (page, n, render = 'full') => page.evaluate(([n, dt, render]) => window.__ua.globe.stepFrames(n, dt, { render }), [n, DT, render]);
const state = (page) => page.evaluate(() => {
    const g = window.__ua.globe;
    return {
        sel: g.getSelectedOpsBand()?.id ?? null,
        hover: g.getOpsBandHover()?.band?.id ?? null,
        hoverPart: g.getOpsBandHover()?.part ?? null,
        weights: Object.fromEntries(g.getOpsBandExpandWeights().map(w => [w.id, +w.weight.toFixed(3)])),
        card: !document.getElementById('ua-band-card').hidden,
        cardTitle: document.querySelector('#ua-band-card .ua-bc-title b')?.textContent ?? null,
        cursor: g.canvas.style.cursor,
        drawn: g.isOpsBandsDrawn(),
    };
});
/**
 * A page point ON the given altitude's ring that is really over the canvas
 * (not under the dock, the column, the toolbar or the camera dock): scan
 * the bearings and take the first whose element-from-point is the canvas.
 */
const ringPoint = (page, altKm) => page.evaluate((altKm) => {
    const g = window.__ua.globe; const geo = g.limbTicks([altKm]); const rc = g.canvas.getBoundingClientRect();
    if (!geo?.ticks?.length) return null;
    for (let deg = 0; deg < 360; deg += 5) {
        const a = deg * Math.PI / 180;
        const x = rc.left + geo.centre.x + geo.ticks[0].screenRadius * Math.cos(a);
        const y = rc.top + geo.centre.y + geo.ticks[0].screenRadius * Math.sin(a);
        if (x < rc.left + 4 || x > rc.right - 4 || y < rc.top + 4 || y > rc.bottom - 4) continue;
        const el = document.elementFromPoint(x, y);
        if (el !== g.canvas && !el?.classList?.contains('ua-instruments')) continue;
        return { x, y, deg };
    }
    return null;
}, altKm);
/** A page point in empty sky (outside the 2000 km shell) that is over the canvas. */
const skyPoint = (page) => page.evaluate(() => {
    const g = window.__ua.globe; const geo = g.limbTicks([2000]); const rc = g.canvas.getBoundingClientRect();
    const r = geo.ticks[0].screenRadius + 40;
    for (let deg = 0; deg < 360; deg += 5) {
        const a = deg * Math.PI / 180;
        const x = rc.left + geo.centre.x + r * Math.cos(a), y = rc.top + geo.centre.y + r * Math.sin(a);
        if (x < rc.left + 4 || x > rc.right - 4 || y < rc.top + 4 || y > rc.bottom - 4) continue;
        const el = document.elementFromPoint(x, y);
        if (el !== g.canvas && !el?.classList?.contains('ua-instruments')) continue;
        if (g.pickOpsBandAt(x, y)) continue;
        return { x, y };
    }
    return null;
});

test('hover names a ring, a click selects and expands it, a second click deselects, empty sky clears', async ({ page }) => {
    await boot(page);
    const p = await ringPoint(page, 600);           // the SSO band's lower edge
    expect(p, 'a ring point over the canvas').not.toBeNull();
    await page.mouse.move(p.x, p.y);
    await step(page, 2);
    let s = await state(page);
    expect(s.hover).toBe('sso');
    expect(s.hoverPart).toBe('edge');
    expect(s.cursor).toBe('pointer');
    expect(s.sel).toBeNull();

    await page.mouse.click(p.x, p.y);
    await step(page, 60);                            // ~1 s: the ease settles
    s = await state(page);
    expect(s.sel).toBe('sso');
    expect(s.weights.sso).toBeGreaterThan(0.95);
    for (const b of OPS_BANDS) if (b.id !== 'sso') expect(s.weights[b.id], b.id).toBe(0);
    expect(s.card).toBe(true);
    expect(s.cardTitle).toBe('Sun-synchronous imaging');
    const grid = await page.locator('#ua-band-card .ua-bc-grid').innerText();
    expect(grid).toMatch(/v circular\s+7\.5\d km\/s/);   // √(μ/(6371+705)) = 7.51
    expect(grid).toMatch(/decay\s+~/);
    // The column strip and the legend row mark the selection.
    await expect(page.locator('#ua-explore-gauge .ua-xg-ops i[data-band="sso"]')).toHaveClass(/is-sel/);
    await expect(page.locator('#ua-explore-gauge .ua-xg-ops i[data-band="station"]')).toHaveClass(/is-dim/);
    await page.click('#ua-legend-toggle');
    await expect(page.locator('#ua-legend-body dt[data-band="sso"]')).toHaveClass(/is-sel/);
    await page.click('#ua-legend-toggle');

    // The same ring again: deselect (the card closes, the shell eases out).
    const p2 = await ringPoint(page, 600);
    await page.mouse.click(p2.x, p2.y);
    await step(page, 60);
    s = await state(page);
    expect(s.sel).toBeNull();
    expect(s.card).toBe(false);
    expect(s.weights.sso, 'eased out (τ 0.22 s: e^−1/0.22 ≈ 0.011 after 1 s)').toBeLessThan(0.02);

    // Select, then click empty sky: cleared.
    await page.mouse.click(p2.x, p2.y);
    await step(page, 5);
    expect((await state(page)).sel).toBe('sso');
    const sky = await skyPoint(page);
    expect(sky).not.toBeNull();
    await page.mouse.click(sky.x, sky.y);
    await step(page, 5);
    expect((await state(page)).sel).toBeNull();
});

test('the card steps the ladder, Esc and ✕ clear, Go there rides the camera into the band', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => window.__ua.globe.selectOpsBand('station'));
    await step(page, 5);
    expect((await state(page)).cardTitle).toBe('Crewed-station band');
    await page.click('#ua-band-card [data-act="next"]');
    await step(page, 5);
    expect((await state(page)).sel).toBe('constellation');
    await page.click('#ua-band-card [data-act="prev"]');
    await page.click('#ua-band-card [data-act="prev"]');
    await step(page, 5);
    expect((await state(page)).sel).toBe('vleo');
    expect(await page.locator('#ua-band-card [data-act="prev"]').isDisabled()).toBe(false);
    await page.keyboard.press('Escape');
    await step(page, 2);
    expect((await state(page)).sel).toBeNull();

    await page.evaluate(() => window.__ua.globe.selectOpsBand('entry'));
    await step(page, 2);
    expect(await page.locator('#ua-band-card [data-act="prev"]').isDisabled()).toBe(true);
    await page.click('#ua-band-card [data-act="close"]');
    await step(page, 2);
    expect((await state(page)).sel).toBeNull();

    // Go there: the camera ends inside the station band, and the expansion
    // is withheld from inside (the chord assumes an outside camera).
    await page.evaluate(() => window.__ua.globe.selectOpsBand('station'));
    await step(page, 2);
    await page.click('#ua-band-card [data-act="go"]');
    await page.waitForFunction(() => {
        const g = window.__ua.globe;
        return !g.isTransitioning() && !g.getTransitState()?.active && Math.abs(g.getCameraAltitudeKm() - 420) < 3;
    }, null, { timeout: 90_000 }).catch(async () => { await step(page, 400); });
    await step(page, 30);
    const inside = await state(page);
    expect(Math.abs(await page.evaluate(() => window.__ua.globe.getCameraAltitudeKm()) - 420)).toBeLessThan(3);
    expect(inside.sel).toBe('station');
    expect(inside.weights.station).toBe(0);
    expect(await page.evaluate(() => window.__ua.globe.getCameraOpsBand()?.id)).toBe('station');
});

test('the explore column strip selects and toggles; turning the bands off clears the selection', async ({ page }) => {
    await boot(page);
    await page.locator('#ua-explore-gauge .ua-xg-ops i[data-band="upper-leo"]').click({ force: true });
    await step(page, 5);
    expect((await state(page)).sel).toBe('upper-leo');
    await page.locator('#ua-explore-gauge .ua-xg-ops i[data-band="upper-leo"]').click({ force: true });
    await step(page, 5);
    expect((await state(page)).sel).toBeNull();
    // A click on the bar itself still GOES to that altitude (not a selection).
    await page.locator('#ua-explore-gauge .ua-xg-opsname[data-band="leo-top"]').click({ force: true });
    await step(page, 5);
    expect((await state(page)).sel).toBe('leo-top');
    await page.click('#ua-atmo-bands');
    await step(page, 5);
    const off = await state(page);
    expect(off.sel).toBeNull();
    expect(off.drawn).toBe(false);
    expect(off.card).toBe(false);
});
