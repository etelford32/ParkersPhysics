/**
 * launch-planner-camera.spec.js — the launch planner's 3D canvas camera
 * controls and responsive stage (js/launch-vehicle-3d.js +
 * js/launch-camera-layout.js + launch-planner.html).
 *
 * Pins:
 *   1. LAYOUT per device: the view row, the toggle row and the camera dock
 *      never overlap; every dock button sits inside the stage; the stage fits
 *      the viewport height; the MET HUD and the variant rows honour [hidden]
 *      (author display:flex used to beat it). Measured before this change on
 *      a 390 px phone: the toggle bar covered the whole view bar.
 *   2. DEFAULT VIEW by screen: phone portrait opens Auto at 40°, a laptop at
 *      38°; a USER-picked preset survives a resize and a vehicle swap, and
 *      Auto hands it back to the screen.
 *   3. SAFE FRAME: the projection's principal point moves into the area the
 *      toolbars leave clear (camera.setViewOffset).
 *   4. CONTROLS: dock orbit / zoom / recenter, arrow keys, a two-pointer
 *      pinch, right-drag pan, Spin (it was a no-op stub), full screen.
 *
 * NEGATIVE CONTROLS (run 2026-11-01 by putting each old line back): removing
 * the `[hidden]{display:none}` restatement fails test 1 (MET HUD 'flex' at
 * standby), and the old `setAutoRotate(_on) {}` stub fails test 3 (Spin moved
 * the camera 0 rad).
 */
import { test, expect } from '@playwright/test';

const URL = '/launch-planner.html';

async function boot(page) {
    await page.route('**/api/telemetry/log', (r) =>
        r.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' }));
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
    await page.goto(URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__lpVehicle3d?.renderStats, null, { timeout: 60_000 });
    await page.evaluate(() => {
        const el = document.querySelector('.lh-vehicle-canvas-host');
        window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 56);
        // The cookie-consent banner covers the bottom of the page and
        // intercepts clicks on the dock — it took the full-screen click on
        // main (2026-11-08). It is chrome, not stage; the render-health spec
        // removes it the same way.
        document.querySelector('.pp-consent-banner')?.remove();
    });
    await frames(page, 3);
}
// Wait for the stage's FINAL framing. The camera first frames with no safe
// insets, then RE-FITS when the page reports the toolbars' footprint
// (setSafeInsets → reframeCurrentView, by design). That report lands only once
// the toolbars have their final size — and with every external request
// aborted the web fonts never arrive, so the toolbar text lays out after the
// font-block timeout, ~3 s in. A fixed 900 ms sleep read the PRE-insets frame
// on CI (s0 = 122.2) and the re-fit then landed between s0 and the orbit
// click (164.7) — identical on retry, because both framings are deterministic.
// Measured locally: 104.95 with insets {0,0}, then 127.08 once insets arrive.
async function settledFrame(page, { stillFrames = 10, timeout = 30_000 } = {}) {
    await page.waitForFunction((need) => {
        const a = window.__lpVehicle3d;
        const ins = a?.view?.insets;
        if (!ins || (ins.top + ins.bottom) === 0) return false;     // insets not applied yet
        const key = `${a.renderStats.distance.toFixed(4)}|${ins.top}|${ins.bottom}`;
        const w = (window.__lpSettle ||= { key: '', still: 0 });
        w.still = key === w.key ? w.still + 1 : 0;
        w.key = key;
        return w.still >= need;
    }, stillFrames, { timeout, polling: 'raf' });
    await page.evaluate(() => { delete window.__lpSettle; });
}
async function frames(page, n = 3) {
    await page.evaluate((n) => new Promise((res) => {
        let k = 0; const f = () => (++k >= n ? res() : requestAnimationFrame(f));
        requestAnimationFrame(f);
    }), n);
}
const stats = (page) => page.evaluate(() => window.__lpVehicle3d.renderStats);
const view  = (page) => page.evaluate(() => window.__lpVehicle3d.view);
const azimuth = (s) => Math.atan2(s.cameraPos[0] - s.target[0], s.cameraPos[2] - s.target[2]);

async function layout(page) {
    return page.evaluate(() => {
        const host = document.querySelector('.lh-vehicle-canvas-host').getBoundingClientRect();
        const r = (sel) => document.querySelector(sel).getBoundingClientRect();
        const bars = { views: r('.lh-vehicle-views'), toggles: r('.lh-vehicle-toggles'), dock: r('.lh-cam-dock') };
        const ov = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
        const dockButtons = [...document.querySelectorAll('.lh-cam-dock .lh-cam')]
            .filter((b) => getComputedStyle(b).display !== 'none')
            .map((b) => { const q = b.getBoundingClientRect(); return { cam: b.dataset.cam, inside: q.left >= host.left - 0.5 && q.right <= host.right + 0.5, w: q.width, h: q.height }; });
        return {
            host: { w: host.width, h: host.height }, vh: innerHeight,
            overlaps: [ov(bars.views, bars.toggles), ov(bars.views, bars.dock), ov(bars.toggles, bars.dock)],
            barsInside: Object.values(bars).every((b) => b.left >= host.left - 0.5 && b.right <= host.right + 0.5 && b.top >= host.top - 0.5 && b.bottom <= host.bottom + 0.5),
            dockButtons,
            metDisplay: getComputedStyle(document.getElementById('lh-met')).display,
            hiddenVariantRowsShown: [...document.querySelectorAll('.lh-vp-variants[hidden]')].filter((g) => getComputedStyle(g).display !== 'none').length,
            docOverflowX: document.documentElement.scrollWidth - innerWidth,
        };
    });
}

test.describe('launch-planner camera controls + responsive stage', () => {
    test.setTimeout(240_000);

    test('phone portrait: docked toolbars, finger-sized dock, Auto at 40°', async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
        const page = await ctx.newPage();
        await boot(page);
        const L = await layout(page);
        expect(L.overlaps).toEqual([false, false, false]);
        expect(L.barsInside).toBe(true);
        expect(L.host.h).toBeLessThanOrEqual(L.vh);
        expect(L.host.h / L.host.w).toBeGreaterThan(1.3);          // a tall stage for a tall vehicle
        for (const b of L.dockButtons) {
            expect(b.inside, `${b.cam} inside the stage`).toBe(true);
            expect(Math.min(b.w, b.h), `${b.cam} touch target`).toBeGreaterThanOrEqual(36);
        }
        for (const cam of ['orbit-left', 'orbit-right', 'zoom-in', 'zoom-out', 'recenter', 'fullscreen', 'help']) {
            expect(L.dockButtons.map((b) => b.cam)).toContain(cam);
        }
        expect(L.metDisplay).toBe('none');
        expect(L.hiddenVariantRowsShown).toBe(0);
        expect(L.docOverflowX).toBeLessThanOrEqual(0);
        const v = await view(page);
        expect(v).toMatchObject({ name: 'threequarter', auto: true, fov: 40 });
        // The two top rows + the dock push the frame in, and the principal
        // point moves into the clear area.
        expect(v.insets.top).toBeGreaterThan(80);
        expect(v.insets.bottom).toBeGreaterThan(40);
        const s = await stats(page);
        expect(s.viewOffsetY).toBeCloseTo((v.insets.bottom - v.insets.top) / 2, 0);
        await ctx.close();
    });

    test('laptop: stage fits the screen; a chosen preset survives resize + vehicle swap; Auto hands it back', async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
        const page = await ctx.newPage();
        await boot(page);
        const L = await layout(page);
        expect(L.overlaps).toEqual([false, false, false]);
        expect(L.host.h).toBeLessThanOrEqual(768 - 90);
        expect(await view(page)).toMatchObject({ name: 'threequarter', auto: true, fov: 38 });

        await page.click('.lh-view[data-view="closeup"]');
        await frames(page, 2);
        expect(await view(page)).toMatchObject({ name: 'closeup', auto: false });
        expect(await page.getAttribute('.lh-view[data-view="closeup"]', 'aria-pressed')).toBe('true');
        await page.setViewportSize({ width: 900, height: 700 });
        await frames(page, 3);
        expect((await view(page)).name).toBe('closeup');
        await page.click('.lh-vp-btn[data-vehicle="starship"][data-variant="v2"]');
        await frames(page, 3);
        expect((await view(page)).name).toBe('closeup');

        await page.click('.lh-view[data-view="auto"]');
        await frames(page, 2);
        expect(await view(page)).toMatchObject({ auto: true });
        expect(await page.getAttribute('.lh-view[data-view="auto"]', 'aria-pressed')).toBe('true');
        await ctx.close();
    });

    test('dock, keys, pinch, pan, Spin and full screen move the camera', async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        await boot(page);
        await settledFrame(page);                         // final framing (see settledFrame)
        const s0 = await stats(page);

        // Orbit button → azimuth changes, distance kept.
        await page.click('.lh-cam[data-cam="orbit-right"]');
        await frames(page, 2);
        const s1 = await stats(page);
        expect(Math.abs(azimuth(s1) - azimuth(s0))).toBeGreaterThan(0.2);
        expect(s1.distance).toBeCloseTo(s0.distance, 1);

        // Zoom in → closer.
        await page.click('.lh-cam[data-cam="zoom-in"]');
        await frames(page, 2);
        expect((await stats(page)).distance).toBeLessThan(s1.distance * 0.9);

        // Recenter → back on the preset pose.
        await page.click('.lh-cam[data-cam="recenter"]');
        await page.waitForTimeout(1000);
        await frames(page, 3);
        const s2 = await stats(page);
        expect(s2.distance).toBeCloseTo(s0.distance, 0);

        // Keyboard (canvas focused): ← orbits.
        await page.focus('#lh-vehicle-canvas');
        await page.keyboard.press('ArrowLeft');
        await frames(page, 2);
        expect(Math.abs(azimuth(await stats(page)) - azimuth(s2))).toBeGreaterThan(0.05);

        // Two-pointer pinch (synthetic PointerEvents — CDP touch dispatch
        // blocks on a software renderer; setPointerCapture is stubbed because
        // the browser has no record of these ids).
        const before = (await stats(page)).distance;
        await page.evaluate(() => {
            const c = document.getElementById('lh-vehicle-canvas');
            c.setPointerCapture = () => {}; c.releasePointerCapture = () => {};
            const r = c.getBoundingClientRect();
            const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const ev = (type, id, x) => c.dispatchEvent(new PointerEvent(type, {
                pointerId: id, pointerType: 'touch', clientX: x, clientY: cy, bubbles: true, isPrimary: id === 1, button: 0,
            }));
            ev('pointerdown', 1, cx - 40); ev('pointerdown', 2, cx + 40);
            for (let k = 1; k <= 10; k++) { ev('pointermove', 1, cx - 40 - k * 12); ev('pointermove', 2, cx + 40 + k * 12); }
            ev('pointerup', 1, cx - 160); ev('pointerup', 2, cx + 160);
        });
        await frames(page, 2);
        expect((await stats(page)).distance).toBeLessThan(before * 0.6);  // spread fingers = zoom in

        // Right-drag pans: the TARGET moves (an orbit would keep it fixed).
        const t0 = (await stats(page)).target;
        await page.evaluate(() => {
            const c = document.getElementById('lh-vehicle-canvas');
            const r = c.getBoundingClientRect();
            const x = r.left + r.width / 2, y = r.top + r.height / 2;
            const ev = (type, dx) => c.dispatchEvent(new PointerEvent(type, {
                pointerId: 7, pointerType: 'mouse', button: 2, buttons: 2, clientX: x + dx, clientY: y, bubbles: true,
            }));
            ev('pointerdown', 0); for (let k = 1; k <= 6; k++) ev('pointermove', k * 15); ev('pointerup', 90);
        });
        await frames(page, 2);
        const t1 = (await stats(page)).target;
        expect(Math.hypot(t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2])).toBeGreaterThan(1);

        // Spin turns the camera on its own (it was a no-op).
        await page.click('.lh-toggle[data-toggle="autoRotate"]');
        const a0 = azimuth(await stats(page));
        await page.waitForTimeout(1500);
        await frames(page, 3);
        expect(Math.abs(azimuth(await stats(page)) - a0)).toBeGreaterThan(0.02);
        await page.click('.lh-toggle[data-toggle="autoRotate"]');

        // Full screen (API or the CSS fallback): the stage covers the window.
        // Poll the LAYOUT on a timer, never on requestAnimationFrame: these are
        // DOM facts, and on CI's chromium-headless-shell the frames(3) that
        // used to sit here never resolved once the stage went full screen
        // (the test burned its whole 240 s budget at this line, 2026-11-08).
        const coversWindow = () => {
            const r = document.querySelector('.lh-vehicle-canvas-host').getBoundingClientRect();
            return r.width >= innerWidth - 2 && r.height >= innerHeight - 2
                && document.getElementById('lh-cam-full').getAttribute('aria-pressed') === 'true';
        };
        await page.click('.lh-cam[data-cam="fullscreen"]');
        await page.waitForFunction(coversWindow, null, { polling: 100, timeout: 20_000 });
        // Leave with a DISPATCHED click: page.click's actionability check
        // waits for the button to be "stable" across animation frames, and
        // those frames are exactly what a full-window software render starves
        // (CI burned the rest of the 240 s budget waiting here, 2026-11-08).
        // The button's own handler is what is under test, not hit-testing.
        await page.locator('.lh-cam[data-cam="fullscreen"]').dispatchEvent('click');
        await expect(page.locator('#lh-cam-full')).toHaveAttribute('aria-pressed', 'false', { timeout: 20_000 });

        // Help opens and closes.
        await page.click('.lh-cam[data-cam="help"]');
        await expect(page.locator('#lh-cam-help')).toBeVisible();
        await page.click('.lh-cam-help-x');
        await expect(page.locator('#lh-cam-help')).toBeHidden();
        await ctx.close();
    });
});
