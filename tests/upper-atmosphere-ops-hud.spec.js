/**
 * upper-atmosphere-ops-hud.spec.js — the stage chrome and the ops bands
 * ═══════════════════════════════════════════════════════════════════════════
 * The 2026-10 stage rebuild (plan §9.14): a viewport-driven canvas, one
 * token set for every piece of chrome drawn over it, the camera dock
 * top-right, the time-warp chips INSIDE the scrubber's head, the render
 * toolbar + legend pill bottom-left, the explore column left, and the
 * operational bands (js/upper-atmosphere-ops-bands.js) as a limb ruler.
 * Hermetic (the feeds fixture) and on the manual frame clock. Pins:
 *
 *   • NO PIECE OF CHROME OVERLAPS ANOTHER at 1280×720, 1440×900 and
 *     1920×1080, every piece sits inside the stage, and the stage is at
 *     least 540 px tall — NEGATIVE CONTROL: zeroing the toolbar's measured
 *     height (`--ua-toolbar-h`) must put the legend pill under the toolbar,
 *     which is what the measurement exists to prevent;
 *   • the time-warp chips are in the scrubber's head, none remain in the
 *     camera dock, and a chip still sets the bus rate;
 *   • the readout folds and the fold survives a reload;
 *   • the full-screen control is still the dock's largest (≥ 44 × 120);
 *   • the ops bands: on by default and DRAWN from the home view; the
 *     camera's band is null from orbit and 'station' at 420 km, where the
 *     readout prints the band tag and its orbit row; the toggle hides the
 *     pass and the legend's band rows with it;
 *   • the explore column carries the ops strip on the same log scale as the
 *     physics bar (a band's top edge sits where `gaugeFraction` puts it).
 */

import { test, expect } from '@playwright/test';
import { routeUpperAtmosphereFeeds } from './fixtures/upper-atmosphere-feeds.mjs';
import { OPS_BANDS } from '../js/upper-atmosphere-ops-bands.js';
import { gaugeFraction } from '../js/upper-atmosphere-explore-model.js';

const URL = '/upper-atmosphere.html';
const DT = 1 / 60;
test.describe.configure({ timeout: 240_000 });

const CHROME = [
    '#ua-camera-hud .ua-cam-controls--mode',
    '#ua-camera-hud .ua-cam-controls--preset',
    '#ua-cam-readout',
    '#ua-explore-gauge',
    '#ua-globe-legend',
    '#ua-atmo-controls',
    '#ua-time-dock .ua-scrub',
];

async function boot(page, { viewport = null } = {}) {
    if (viewport) await page.setViewportSize(viewport);
    await routeUpperAtmosphereFeeds(page);
    await page.route('**/api/donki/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.globe?.stepFrames && !!window.__ua?.explore, null, { timeout: 60_000 });
    const consent = page.locator('.pp-consent-banner');
    await consent.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) await consent.locator('[data-action="reject"]').click().catch(() => {});
    await page.evaluate(() => { const g = window.__ua.globe; g.setManualClock(true, { startMs: 1.0e6 }); g.seedRandom(7); });
    await step(page, 3);
    await page.waitForTimeout(300);
}
const step = (page, n, render = 'full') => page.evaluate(([n, dt, render]) => window.__ua.globe.stepFrames(n, dt, { render }), [n, DT, render]);

/** Canvas-relative rects of the chrome pieces that are visible. */
const rects = (page) => page.evaluate((sels) => {
    const wrap = document.getElementById('ua-globe-wrap').getBoundingClientRect();
    const out = {};
    for (const s of sels) {
        const el = document.querySelector(s);
        if (!el || !el.offsetParent) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        out[s] = { x: r.left - wrap.left, y: r.top - wrap.top, w: r.width, h: r.height, right: r.right - wrap.left, bottom: r.bottom - wrap.top };
    }
    out.__wrap = { w: wrap.width, h: wrap.height };
    return out;
}, CHROME);
const overlaps = (a, b) => a.x < b.right - 0.5 && a.right > b.x + 0.5 && a.y < b.bottom - 0.5 && a.bottom > b.y + 0.5;

for (const vp of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    test(`no chrome overlaps and everything is inside the stage at ${vp.width}×${vp.height}`, async ({ page }) => {
        await boot(page, { viewport: vp });
        const r = await rects(page);
        const wrap = r.__wrap;
        expect(wrap.h, 'the stage is at least 540 px tall').toBeGreaterThanOrEqual(540);
        expect(wrap.h, 'the stage grows with the viewport').toBeGreaterThanOrEqual(Math.min(1100, vp.height - 178) - 1);
        const keys = CHROME.filter(k => r[k]);
        expect(keys.length, 'every piece of chrome is on screen').toBe(CHROME.length);
        for (const k of keys) {
            const q = r[k];
            expect(q.x, `${k} inside left`).toBeGreaterThanOrEqual(-0.5);
            expect(q.y, `${k} inside top`).toBeGreaterThanOrEqual(-0.5);
            expect(q.right, `${k} inside right`).toBeLessThanOrEqual(wrap.w + 0.5);
            expect(q.bottom, `${k} inside bottom`).toBeLessThanOrEqual(wrap.h + 0.5);
        }
        for (let i = 0; i < keys.length; i++) {
            for (let j = i + 1; j < keys.length; j++) {
                expect(overlaps(r[keys[i]], r[keys[j]]), `${keys[i]} overlaps ${keys[j]}`).toBe(false);
            }
        }
        // The stage is the product: the chrome's bounding boxes cover well
        // under half of it (the explore column's box is mostly transparent —
        // a 10 px bar and its labels in a 118 px column — so this is an
        // over-estimate; measured 0.40 at the smallest viewport).
        const covered = keys.reduce((s, k) => s + r[k].w * r[k].h, 0);
        expect(covered / (wrap.w * wrap.h)).toBeLessThan(0.45);
    });
}

test('NEGATIVE CONTROL: the legend sits above the toolbar only because the toolbar is MEASURED', async ({ page }) => {
    await boot(page, { viewport: { width: 1440, height: 900 } });
    const before = await rects(page);
    expect(overlaps(before['#ua-globe-legend'], before['#ua-atmo-controls'])).toBe(false);
    // Put the pre-fix constant back: a zero toolbar height.
    await page.evaluate(() => document.getElementById('ua-globe-wrap').style.setProperty('--ua-toolbar-h', '0px'));
    const after = await rects(page);
    expect(overlaps(after['#ua-globe-legend'], after['#ua-atmo-controls']), 'the control must overlap').toBe(true);
});

test('the time-warp chips live in the scrubber head, not the camera dock, and still drive the bus', async ({ page }) => {
    await boot(page);
    expect(await page.locator('#ua-time-dock .ua-scrub-head .ua-cam-warp-rate').count()).toBe(9);
    expect(await page.locator('#ua-camera-hud .ua-cam-warp-rate').count()).toBe(0);
    await page.click('#ua-time-dock [data-rate="60"]');
    expect(await page.evaluate(() => window.__ua.globe._timeBus.getRate())).toBe(60);
    await expect(page.locator('#ua-time-dock [data-rate="60"]')).toHaveClass(/ua-cam-on/);
    await page.click('#ua-cam-warp-snap');
    expect(await page.evaluate(() => window.__ua.globe._timeBus.getRate())).toBe(1);
    // The scrubber's own "Now" is folded away (one control for one action).
    expect(await page.locator('#ua-time-dock .ua-scrub-snap').isVisible()).toBe(false);
});

test('the readout folds, and the fold survives a reload', async ({ page }) => {
    await boot(page);
    const readout = page.locator('#ua-cam-readout');
    await expect(readout).toHaveAttribute('data-open', '1');
    await expect(page.locator('#ua-cam-rho')).toBeVisible();
    await page.click('#ua-cam-readout-toggle');
    await expect(readout).toHaveAttribute('data-open', '0');
    await expect(page.locator('#ua-cam-rho')).toBeHidden();
    // The header keeps the altitude on screen while folded.
    await expect(page.locator('#ua-cam-alt')).toBeVisible();
    await boot(page);
    await expect(page.locator('#ua-cam-readout')).toHaveAttribute('data-open', '0');
    await page.click('#ua-cam-readout-toggle');
    await expect(page.locator('#ua-cam-readout')).toHaveAttribute('data-open', '1');
    await page.evaluate(() => localStorage.removeItem('ua_hud_readout_open'));
});

test('full screen is still the dock\'s largest control', async ({ page }) => {
    await boot(page);
    const fs = await page.locator('#ua-cam-immersive').boundingBox();
    expect(fs.height).toBeGreaterThanOrEqual(44);
    expect(fs.width).toBeGreaterThanOrEqual(120);
    const reset = await page.locator('#ua-cam-reset').boundingBox();
    expect(fs.width * fs.height).toBeGreaterThan(2 * reset.width * reset.height);
    await expect(page.locator('#ua-cam-immersive')).toContainText('Full screen');
});

test('ops bands: on by default and drawn from orbit; the camera\'s band and its orbit row at 420 km; the toggle', async ({ page }) => {
    await boot(page);
    const g0 = await page.evaluate(() => {
        const g = window.__ua.globe;
        return { on: g.getOpsBandsVisible(), drawn: g.isOpsBandsDrawn(), band: g.getCameraOpsBand(),
                 pressed: document.getElementById('ua-atmo-bands').getAttribute('aria-pressed'),
                 bandTag: document.getElementById('ua-cam-band').hidden, opsRow: document.getElementById('ua-cam-ops').hidden,
                 gl: g._renderer.getContext().getError() };
    });
    expect(g0.on).toBe(true);
    expect(g0.drawn, 'the ring pass draws from the home view').toBe(true);
    expect(g0.band, 'the home camera is above the band').toBeNull();
    expect(g0.pressed).toBe('true');
    expect(g0.bandTag).toBe(true);
    expect(g0.opsRow).toBe(true);
    expect(g0.gl).toBe(0);

    // The legend lists every band with a decay estimate while the rings draw.
    await page.click('#ua-legend-toggle');
    const legend = await page.locator('#ua-legend-body').innerText();
    for (const b of OPS_BANDS) expect(legend).toContain(b.short);
    expect(legend).toMatch(/decay ~/);

    // Into the station band.
    await page.evaluate(() => window.__ua.globe.diveTo({ latDeg: 10, lonDeg: -40, altKm: 420, headingDeg: 90, pitchDeg: -5, durationSec: 0.5 }));
    await step(page, 40);
    await page.evaluate(() => window.__ua.ui._paintCameraHUD());
    const g1 = await page.evaluate(() => {
        const g = window.__ua.globe;
        return { band: g.getCameraOpsBand()?.id, alt: g.getCameraAltitudeKm(),
                 tag: document.getElementById('ua-cam-band').hidden ? null : document.getElementById('ua-cam-band').textContent.trim(),
                 ops: document.getElementById('ua-cam-ops').hidden ? null : document.getElementById('ua-cam-ops-v').textContent };
    });
    expect(Math.abs(g1.alt - 420)).toBeLessThan(2);
    expect(g1.band).toBe('station');
    expect(g1.tag).toBe('STATION');
    expect(g1.ops).toMatch(/7\.6\d km\/s · 9\d\.\d min · decay ~/);

    // Off: no pass, no legend rows, the button says so.
    await page.click('#ua-atmo-bands');
    await step(page, 2);
    const g2 = await page.evaluate(() => ({
        on: window.__ua.globe.getOpsBandsVisible(), drawn: window.__ua.globe.isOpsBandsDrawn(),
        pressed: document.getElementById('ua-atmo-bands').getAttribute('aria-pressed'),
        legend: document.getElementById('ua-legend-body').innerText,
    }));
    expect(g2.on).toBe(false);
    expect(g2.drawn).toBe(false);
    expect(g2.pressed).toBe('false');
    expect(g2.legend).not.toContain('decay ~');
});

test('the explore column\'s ops strip shares the physics bar\'s log scale', async ({ page }) => {
    await boot(page, { viewport: { width: 1920, height: 1080 } });
    const bar = await page.locator('#ua-explore-gauge .ua-xg-bar').boundingBox();
    const strips = await page.locator('#ua-explore-gauge .ua-xg-ops i').evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, title: e.title }; }));
    expect(strips.length).toBe(OPS_BANDS.length);
    for (let i = 0; i < OPS_BANDS.length; i++) {
        const b = OPS_BANDS[i], s = strips[i];
        expect(s.title).toContain(b.name);
        const expTop = bar.y + bar.height * (1 - gaugeFraction(b.maxKm));
        const expBottom = bar.y + bar.height * (1 - gaugeFraction(b.minKm));
        expect(Math.abs(s.top - expTop), `${b.id} top`).toBeLessThan(1.5);
        expect(Math.abs(s.bottom - expBottom), `${b.id} bottom`).toBeLessThan(1.5);
    }
    // Names only where they fit: the tall top band is named, and no name is
    // drawn for a band shorter than its label.
    const names = await page.locator('#ua-explore-gauge .ua-xg-opsname:not([hidden])').allTextContents();
    expect(names).toContain('LEO TOP');
    expect(names.length).toBeGreaterThanOrEqual(5);
});
