/**
 * sun-exposure.spec.js — a brighter FRAME is not a brighter SUN
 * ═══════════════════════════════════════════════════════════════════════════
 * sun.html's exposure controller (js/sun-post.js) meters the frame's mean
 * log-luminance. The hero frame is mostly black sky and a close-up is all
 * disc, so the mean rises ~2.5 EV between them with nothing on the Sun having
 * changed. Until 2026-11-22 the controller read that as "the scene got
 * brighter" and held every close-up of the disc at its −2 EV floor — a
 * quarter of its exposure — for as long as the camera stayed there. It was
 * reported as "the disc goes dark during a flare" (visual review, 2026-11-21)
 * because the flare shot is the close-up most visitors see; measured with no
 * flare on the page at all it was the same.
 *
 * WHAT THIS DRIVES. The real page, the real post pass, the real readback:
 *   1. lock the calibration on the hero frame (see below);
 *   2. cut to a close-up — the frame MUST read brighter (or the gate has no
 *      teeth), and the exposure must come back to ~0 EV;
 *   3. NEGATIVE CONTROL — `accommodate: false`, the law shipped until then, on
 *      the same close-up: it goes to the floor;
 *   4. back to the hero frame: ~0 EV again, nothing left accommodated;
 *   5. a re-lock asked for in a close-up does not lock (the calibration is
 *      "the whole Sun in view").
 *
 * THE LOCK IS EMULATED, AND SAYS SO. The controller locks from 20 readbacks,
 * 4 frames apart: 1.3 s on a GPU, minutes on the software rasteriser CI runs
 * (measured 0.65 frames/s in an EUV view). The gate therefore sets
 * `calibLum` to the hero frame's own measured luminance — exactly the value a
 * fast machine locks — rather than waiting for it. The controller's own lock
 * rule is pinned in node (tests/sun-post.mjs).
 *
 * Runs on software GL. The upstream is mocked; CI must never need nasa.gov.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, 'fixtures', 'sdo');
const MAN = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

async function boot(page) {
    await page.addInitScript(() => {
        try {
            localStorage.setItem('pp_consent_v1', JSON.stringify(
                { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        } catch (e) {}
    });
    const errs = [];
    page.on('console', (m) => {
        if (m.type() === 'error' && /Shader Error|GLSL|ERROR: 0:|Program Info Log/i.test(m.text())) errs.push(m.text());
    });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    await page.route('**/api/solar/aia*', (route) => {
        const ch = new URL(route.request().url()).searchParams.get('channel') || 'white';
        const frame = MAN.frames[ch] || MAN.frames.white;
        route.fulfill({
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'X-AIA-Channel': ch, 'X-AIA-Mode': 'live',
                'X-SDO-Observed-At': new Date(Date.now() - 7 * 60 * 1000).toISOString(),
                'Access-Control-Expose-Headers': 'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At',
            },
            body: readFileSync(join(FIXTURE_DIR, frame.file)),
        });
    });
    await page.route((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u.href), (route) => route.abort());
    await page.setViewportSize({ width: 1100, height: 780 });
    await page.goto('/sun.html');
    await page.waitForFunction(() => window.__sun && window.__sun.frames > 5, null, { timeout: 60_000 });
    await page.waitForFunction(() => window.__sun.uniforms.u_obsOn.value > 0.5, null, { timeout: 30_000 });
    return errs;
}

/** The controller's state, as the page holds it. */
const expo = (page) => page.evaluate(() => {
    const p = window.__sun.post, e = p.exposure;
    return {
        ev: e.ev, target: e.evTarget, excess: e.excess, accommodated: e.accommodated,
        lum: e.lastLum, calib: e.calibLum, samples: e.samples, calibN: e._calibN,
        calibrateOK: p.calibrateOK, d: window.__sun.camera.position.length(),
    };
});

/** Wait for `n` more luminance readbacks (the controller steps once per readback). */
async function readbacks(page, n) {
    const from = (await expo(page)).samples;
    await page.waitForFunction(([f, k]) => window.__sun.post.exposure.samples >= f + k, [from, n], { timeout: 120_000, polling: 250 });
}

/** A jump cut: the camera on the Sun–Earth line at `d` R☉ with a `fov`° lens. */
const cutTo = (page, d, fov) => page.evaluate(([dd, f]) => {
    const s = window.__sun;
    s.cam?.cancel?.();
    const dir = s.camera.position.clone().normalize();
    s.camera.position.copy(dir.multiplyScalar(dd));
    s.camera.fov = f; s.camera.updateProjectionMatrix();
    s.controls.update();
}, [d, fov]);

test.describe('sun.html exposure: a brighter frame is not a brighter Sun', () => {
    test('a close-up of the disc keeps the hero frame\'s exposure; the old law held it at the floor', async ({ page }) => {
        test.setTimeout(600_000);
        const errs = await boot(page);
        expect(errs, errs.join('\n')).toHaveLength(0);

        // The pass reads the frame's luminance back every 4th frame; here it
        // reads every frame. Same controller, same steps — a quarter of the
        // frames, which on the software rasteriser (seconds per close-up
        // frame, and slower again beside another worker: this test timed out
        // at 7 minutes inside the full suite) is the difference between a
        // gate and a timeout.
        await page.evaluate(() => { window.__sun.post.readbackEvery = 1; });

        // 1. The hero frame, and the lock a fast machine reaches there.
        await readbacks(page, 3);
        const hero = await expo(page);
        expect(hero.calibrateOK, 'the whole Sun is in view on load: this framing may calibrate').toBe(true);
        expect(hero.lum).toBeGreaterThan(0);
        const heroPose = await page.evaluate(() => ({ d: window.__sun.camera.position.length(), fov: window.__sun.camera.fov }));
        await page.evaluate(() => { const e = window.__sun.post.exposure; e.recalibrate(); e.calibLum = e.lastLum; });

        // 2. Cut to a close-up. The frame must actually read brighter — that is the trap.
        await cutTo(page, 2.16, 20);
        await readbacks(page, 7);
        const close = await expo(page);
        console.log(`exposure  hero L ${hero.lum.toFixed(4)} → close-up L ${close.lum.toFixed(4)} (frame ${close.excess.toFixed(2)} EV brighter) · EV ${close.ev.toFixed(3)} · accommodated ${close.accommodated.toFixed(2)} EV`);
        expect(close.excess, 'the close-up frame reads well over a stop brighter than the hero frame').toBeGreaterThan(1.2);
        expect(Math.abs(close.ev), 'and the disc keeps its exposure').toBeLessThan(0.25);
        expect(close.accommodated, 'because the excess was accommodated as framing').toBeGreaterThan(close.excess - 0.25);
        expect(close.calibrateOK, 'a close-up is not a view the calibration may count').toBe(false);

        // 3. NEGATIVE CONTROL — the law shipped until 2026-11-22, same close-up.
        await page.evaluate(() => { window.__sun.post.exposure.p.accommodate = false; });
        await readbacks(page, 6);
        const legacy = await expo(page);
        console.log(`          legacy law on the same close-up: EV ${legacy.ev.toFixed(3)} (×${Math.pow(2, legacy.ev).toFixed(2)})`);
        expect(legacy.ev, 'the old law stops the close-up down by more than a stop').toBeLessThan(-1.0);
        expect(legacy.ev).toBeLessThan(close.ev - 1.0);

        // 4. Back to the shipped law and back out to the hero frame.
        await page.evaluate(() => { window.__sun.post.exposure.p.accommodate = true; });
        await cutTo(page, heroPose.d, heroPose.fov);
        await readbacks(page, 8);
        const back = await expo(page);
        console.log(`          back on the hero frame: EV ${back.ev.toFixed(3)} · accommodated ${back.accommodated.toFixed(2)} EV`);
        expect(Math.abs(back.ev), 'the hero frame is at its own exposure again').toBeLessThan(0.25);
        expect(back.accommodated).toBeLessThan(0.25);

        // 5. A re-lock asked for in a close-up waits for the whole Sun.
        await cutTo(page, 2.16, 20);
        await readbacks(page, 2);
        await page.evaluate(() => window.__sun.post.exposure.recalibrate());
        await readbacks(page, 3);
        const relock = await expo(page);
        expect(relock.calib, 'no lock from a close-up').toBeNull();
        expect(relock.calibN, 'not even a partial count').toBe(0);
        expect(relock.ev).toBe(0);
    });
});
