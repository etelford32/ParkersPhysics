import { test, expect } from '@playwright/test';
import { marsSolarLongitude, marsSubsolarPoint } from '../js/mars-mission-state.js';
import { MARS_LANDMARKS } from '../js/mars-landmarks-data.js';

/**
 * Browser gate for mars.html as an EXPLORABLE MAP (2026-09).
 *
 * The page rendered, and it was still "very broken" to use. Each block below
 * pins one of the failures that made it so, measured before the fix:
 *
 *   1. FRAMING. "Global view" drew a 770 px globe in an 850 px canvas with most
 *      of it under the panels and the title. The projection's principal point
 *      now sits in the middle of the unobstructed region (the SAFE FRAME) and
 *      the whole disc fits there.
 *   2. LIGHTING. The night hemisphere was a brown smear: flying to a feature
 *      past the terminator showed nothing, and landing there gave a flat orange
 *      plane. Map light (default) lights every region; live sunlight is a
 *      toggle, and the physical Sun is still reported as the Sun.
 *   3. ZOOM DEAD-END. The globe's zoom stopped ~750 km up and the only way down
 *      was an undisclosed double-click. Zooming through the floor now lands;
 *      zooming out past the surface ceiling returns to orbit.
 *   4. RELIEF. 18× everywhere drew Olympus Mons 422 km tall and put the whole
 *      frame below the horizon (black void). The survey scale is capped per
 *      site by a drawn-relief budget; Jezero keeps its documented 18×.
 *   5. SEASON. The analytic Ls was anchored 61 days early and the live Horizons
 *      column was misnamed, so production read "Ls 30°" at Ls 358°.
 *
 * Every Mars feed is aborted: the page must do all of this on its fallbacks.
 */

const IGNORED_CONSOLE_ERRORS = [
    /fonts\.googleapis\.com/,
    /\/api\/telemetry\//,
    /\/api\/mars\//,
    /\/api\/horizons/,
    /trek\.nasa\.gov/,
    /Failed to load resource/,
];

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        const text = message.text();
        const location = message.location?.()?.url || '';
        if (IGNORED_CONSOLE_ERRORS.some(p => p.test(text) || p.test(location))) return;
        errors.push(text);
    });
    return errors;
}

async function bootMars(page, { width = 1440, height = 900 } = {}) {
    await page.setViewportSize({ width, height });
    // Consent answered up front: the banner sits over the bottom of the map.
    await page.addInitScript(() => {
        try {
            localStorage.setItem('pp_consent_v1', JSON.stringify({
                version: 1, necessary: true, functional: true, analytics: false, ts: Date.now(),
            }));
        } catch { /* storage blocked: the banner just shows */ }
    });
    await page.route('**/api/mars/ephemeris**', route => route.abort());
    await page.route('**/api/mars/weather**', route => route.abort());
    await page.route('**/api/horizons?**', route => route.abort());
    await page.route('**/api/mars/tiles**', route => route.abort());
    await page.goto('/mars.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__marsReady === true && !!window.__marsLab, null, { timeout: 90_000 });
    // The ladder would demote the renderer mid-test on a software rasteriser;
    // pin the cheap rung so timings are stable. Nothing here is quality-gated.
    await page.evaluate(() => window.__marsLab.setQuality(3, { lock: true }));
}

const sunElevationDeg = (latDeg, lonDeg, subsolar) => {
    const r = Math.PI / 180;
    return Math.asin(
        Math.sin(latDeg * r) * Math.sin(subsolar.lat_deg * r)
        + Math.cos(latDeg * r) * Math.cos(subsolar.lat_deg * r) * Math.cos((lonDeg - subsolar.lon_deg) * r),
    ) / r;
};

/** Mean luminance of a box around the safe-frame centre, from a real screenshot. */
async function centreLuminance(page) {
    const frame = await page.evaluate(() => window.__marsLab.frameState());
    const png = await page.locator('#mars-canvas').screenshot();
    return page.evaluate(async ({ b64, frame }) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = `data:image/png;base64,${b64}`; });
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const scale = cv.width / frame.viewport.width;
        const cx = (frame.safe.left + frame.safe.right) / 2 * scale;
        const cy = (frame.safe.top + frame.safe.bottom) / 2 * scale;
        const half = 40 * scale;
        const d = ctx.getImageData(Math.round(cx - half), Math.round(cy - half), Math.round(half * 2), Math.round(half * 2)).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        return sum / (d.length / 4);
    }, { b64: png.toString('base64'), frame });
}

test('Global view frames the whole planet in the unobstructed part of the screen', async ({ page }) => {
    test.slow();
    const errors = collectPageErrors(page);
    await bootMars(page);
    await expect(page.locator('.data-dock')).toHaveClass(/collapsed/);
    await expect(page.locator('#camera-mode')).toHaveText('Mission orbit');

    const frame = await page.evaluate(() => window.__marsLab.frameState());
    // The frame really is narrowed by the side panels, and the projection is offset into it.
    expect(frame.safe.left).toBeGreaterThan(250);
    expect(frame.safe.right).toBeLessThan(frame.viewport.width - 250);
    expect(frame.viewOffset).not.toBeNull();
    const safeCx = (frame.safe.left + frame.safe.right) / 2;
    const safeCy = (frame.safe.top + frame.safe.bottom) / 2;
    // Mars' centre projects to the centre of the safe frame (the camera looks
    // at the origin, so this is exactly the principal-point shift).
    expect(Math.abs(frame.discCenterPx.x - safeCx)).toBeLessThan(2);
    expect(Math.abs(frame.discCenterPx.y - safeCy)).toBeLessThan(2);
    // And the whole disc fits inside it.
    expect(frame.discCenterPx.x - frame.discRadiusPx).toBeGreaterThanOrEqual(frame.safe.left - 1);
    expect(frame.discCenterPx.x + frame.discRadiusPx).toBeLessThanOrEqual(frame.safe.right + 1);
    expect(frame.discCenterPx.y - frame.discRadiusPx).toBeGreaterThanOrEqual(frame.safe.top - 1);
    expect(frame.discCenterPx.y + frame.discRadiusPx).toBeLessThanOrEqual(frame.safe.bottom + 1);
    // Not a postage stamp either: the disc fills most of the frame's short side.
    expect(frame.discRadiusPx * 2).toBeGreaterThan(0.8 * Math.min(frame.safe.widthPx, frame.safe.heightPx));

    // Collapsing the Perseverance panel widens the frame, and the fit follows.
    await page.locator('.mission-panel .panel-toggle').click();
    await expect.poll(() => page.evaluate(() => window.__marsLab.frameState().safe.left)).toBeLessThan(frame.safe.left - 100);
    // Hiding every panel returns the full canvas.
    await page.locator('#ui-panels-toggle').click();
    await expect.poll(() => page.evaluate(() => window.__marsLab.frameState().viewOffset)).toBeNull();
    expect(errors).toEqual([]);
});

test('Map light makes the night side explorable; live sunlight is one toggle away', async ({ page }) => {
    test.slow();
    const errors = collectPageErrors(page);
    await bootMars(page);
    await page.locator('#ui-panels-toggle').click();

    // The atlas feature deepest into night right now (18 features spread in
    // longitude: one of them is always well past the terminator).
    const subsolar = marsSubsolarPoint(new Date());
    const night = MARS_LANDMARKS
        .map(l => ({ name: l.name, elevation: sunElevationDeg(l.latDeg, l.lonDeg, subsolar) }))
        .sort((a, b) => a.elevation - b.elevation)[0];
    expect(night.elevation).toBeLessThan(-20);

    await page.evaluate(name => window.__marsLab.selectFeature(name), night.name);
    await expect(page.locator('#camera-mode')).toHaveText(night.name);
    await expect.poll(() => page.evaluate(() => window.__marsLab.sunState().elevationAtTargetDeg), { timeout: 20_000 })
        .toBeLessThan(-15);
    await page.waitForTimeout(1500);

    const mapState = await page.evaluate(() => window.__marsLab.sunState());
    expect(mapState.lighting).toBe('map');
    expect(mapState.lampElevationAtTargetDeg, 'the lamp lights the target').toBeGreaterThan(20);
    await expect(page.locator('#camera-light')).toHaveAttribute('aria-pressed', 'false');
    const mapLuminance = await centreLuminance(page);

    await page.keyboard.press('i');
    await expect(page.locator('#camera-light')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#lighting-toggle')).toBeChecked();
    await expect(page.locator('#lighting-source')).toContainText('real Sun');
    const liveState = await page.evaluate(() => window.__marsLab.sunState());
    expect(liveState.lighting).toBe('live');
    // Live: the lamp IS the Sun, and the physical Sun never changed.
    expect(Math.abs(liveState.lampElevationAtTargetDeg - liveState.elevationAtTargetDeg)).toBeLessThan(0.01);
    expect(Math.abs(liveState.elevationAtTargetDeg - mapState.elevationAtTargetDeg)).toBeLessThan(1);
    await page.waitForTimeout(800);
    const liveLuminance = await centreLuminance(page);
    // Measured, not assumed: the night-side target is several times brighter
    // under map light than under the real (set) Sun.
    expect(mapLuminance, `map ${mapLuminance.toFixed(1)} vs live ${liveLuminance.toFixed(1)}`)
        .toBeGreaterThan(liveLuminance * 1.8);

    await page.keyboard.press('i');
    await expect(page.locator('#camera-light')).toHaveAttribute('aria-pressed', 'false');
    expect((await page.evaluate(() => window.__marsLab.sunState())).lighting).toBe('map');
    expect(errors).toEqual([]);
});

test('Zooming through the orbit floor lands, and zooming out past the ceiling returns to orbit', async ({ page }) => {
    test.slow();
    const errors = collectPageErrors(page);
    await bootMars(page);
    await expect(page.locator('#camera-help')).toContainText('zoom in to land');
    const frame = await page.evaluate(() => window.__marsLab.frameState());
    const box = await page.locator('#mars-canvas').boundingBox();
    const at = { x: box.x + frame.discCenterPx.x, y: box.y + frame.discCenterPx.y };

    // Real wheel BURSTS, dispatched in-page: two events in one task, the way a
    // wheel notch or a trackpad fling arrives. (Playwright's mouse.wheel waits
    // for each event, which on a software rasteriser spaces them seconds apart
    // — slower than any hand, and the arming window rightly ignores that.)
    const burst = (deltaY) => page.evaluate(({ x, y, deltaY }) => {
        const canvas = document.querySelector('#mars-canvas');
        for (let i = 0; i < 2; i += 1) {
            canvas.dispatchEvent(new WheelEvent('wheel', {
                deltaY, clientX: x, clientY: y, bubbles: true, cancelable: true,
            }));
        }
    }, { ...at, deltaY });

    let landed = false;
    for (let i = 0; i < 40 && !landed; i += 1) {
        await burst(-400);
        await page.waitForTimeout(120);
        landed = await page.evaluate(() => window.__marsLab.surfaceState().active);
    }
    expect(landed, 'zooming in reaches the ground').toBe(true);
    await expect(page.locator('#surface-explorer')).toBeVisible();
    await expect(page.locator('#camera-mode')).toContainText('selected terrain');

    let orbit = false;
    for (let i = 0; i < 60 && !orbit; i += 1) {
        await burst(400);
        await page.waitForTimeout(120);
        orbit = !(await page.evaluate(() => window.__marsLab.surfaceState().active));
    }
    expect(orbit, 'zooming out returns to orbit').toBe(true);
    await expect(page.locator('#surface-explorer')).toBeHidden();
    await expect(page.locator('#camera-mode')).toContainText('Orbit');
    expect(errors).toEqual([]);
});

test('Surface relief is capped per site: Olympus is not 400 km tall, Jezero keeps 18×', async ({ page }) => {
    test.slow();
    const errors = collectPageErrors(page);
    await bootMars(page);

    await page.evaluate(() => window.__marsLab.enterSurfaceExplorer(18.65, -133.8, { duration: 10 }));
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().active)).toBe(true);
    const olympus = await page.evaluate(() => window.__marsLab.surfaceState());
    expect(olympus.reliefCeiling).toBe(3);
    expect(olympus.reliefScaleNow).toBeLessThanOrEqual(3);
    // Drawn span within the budget (90 km), where it used to be ~422 km.
    expect(olympus.patchRelief.spanM / 1000 * olympus.reliefScaleNow).toBeLessThan(90);
    await expect(page.locator('#surface-detail')).toContainText('×');

    await page.evaluate(() => window.__marsLab.enterSurfaceExplorer(18.43, 77.3, { duration: 10 }));
    await expect.poll(() => page.evaluate(() => window.__marsLab.surfaceState().reliefCeiling)).toBe(18);
    await expect(page.locator('#surface-detail')).toContainText('18×');
    expect(errors).toEqual([]);
});

test('The season is Mars24-correct on the analytic fallback, not 32° ahead', async ({ page }) => {
    const errors = collectPageErrors(page);
    await bootMars(page);
    await expect(page.locator('#geometry-note')).toContainText('Mars24');
    const shown = Number((await page.locator('#header-season').textContent()).replace(/[^\d.]/g, ''));
    const expected = marsSolarLongitude(new Date());
    const delta = Math.abs(((shown - expected + 540) % 360) - 180);
    expect(delta, `header shows Ls ${shown}°, Mars24 says ${expected.toFixed(2)}°`).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
});
