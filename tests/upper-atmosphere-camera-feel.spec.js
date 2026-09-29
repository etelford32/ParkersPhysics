/**
 * upper-atmosphere-camera-feel.spec.js — the camera, to the last digit
 * ═══════════════════════════════════════════════════════════════════════════
 * Uses the manual frame clock (`globe.setManualClock(true)` +
 * `globe.stepFrames(n, dt)`, js/upper-atmosphere-frame-clock.js): the render
 * loop idles and every frame is stepped by exactly `dt`, so the camera can be
 * compared against the PURE kernel (js/upper-atmosphere-explore-model.js),
 * imported right here in node, frame for frame — on a software renderer that
 * draws one real frame every ~0.6 s. Without the hook these properties could
 * only be checked as "it moved, roughly east".
 *
 * What is pinned:
 *   • explore flight runs at EXACTLY the kernel's cruise, turn, climb and
 *     boost rates, and mouse look turns by EXACTLY pixels × sensitivity;
 *   • a dive IS the kernel's path at every frame, its field-of-view kick is
 *     the kernel's gain, it lands exactly on time, and no frame snaps;
 *   • any input stops a dive on the event, leaving the camera where it was;
 *   • the transit and the climb out run on the same clock;
 *   • a seeded gas cloud is repeatable, and streak length is the shutter
 *     times the camera's speed through the gas.
 */

import { test, expect } from '@playwright/test';
import {
    divePath, climbPath, exploreStep, stateFromLatLon, describeState,
    cruiseSpeedKmS, transitionFovGain, EXPLORE, R_EARTH_KM,
} from '../js/upper-atmosphere-explore-model.js';

const URL = '/upper-atmosphere.html';
const DT = 1 / 60;
test.describe.configure({ timeout: 180_000 });

async function boot(page) {
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.globe?.stepFrames && !!window.__ua?.explore, null, { timeout: 45_000 });
    const consent = page.locator('.pp-consent-banner');
    await consent.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) {
        await consent.locator('[data-action="reject"]').click().catch(() => {});
    }
    await page.waitForTimeout(1000);
    // Labels are clickable DOM over the canvas; keep them out of mouse tests.
    await page.evaluate(() => { window.__ua.globe.setBeaconsVisible(false); window.__ua.globe.setManualClock(true); });
}

const step = (page, n, render = 'none') => page.evaluate(([n, dt, r]) => window.__ua.globe.stepFrames(n, dt, { render: r }), [n, DT, render]);
const info = (page) => page.evaluate(() => window.__ua.globe.getExploreInfo());
const pose = (page) => page.evaluate(() => {
    const c = window.__ua.globe._camera;
    const f = c.getWorldDirection(new c.position.constructor());
    return { pos: c.position.toArray(), fwd: f.toArray(), up: c.up.toArray(), fov: c.fov,
             mode: window.__ua.globe.getCameraMode(), path: window.__ua.globe.getTransitionProgress() };
});

/** Land in explore mode at a known pose, on the manual clock. */
async function landAt(page, where) {
    await page.evaluate((w) => window.__ua.globe.diveTo({ ...w, durationSec: 0.5 }), where);
    await step(page, 40);
    expect(await page.evaluate(() => window.__ua.globe.getCameraMode())).toBe('explore');
    expect(await page.evaluate(() => window.__ua.globe.isTransitioning())).toBe(false);
}

/** The same flight in the kernel, from what the page reports. */
function kernelFly(start, input, frames) {
    let st = stateFromLatLon({ latDeg: start.latDeg, lonDeg: start.lonDeg, altKm: start.altKm,
                               headingDeg: start.headingDeg, pitchDeg: start.pitchDeg });
    for (let i = 0; i < frames; i++) st = exploreStep(st, input, DT);
    return describeState(st);
}
const lonDiff = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

/** A point where the WebGL canvas itself is on top (HUD panels cover parts of it). */
async function canvasPoint(page) {
    const p = await page.evaluate(() => {
        const c = document.getElementById('ua-globe');
        const r = c.getBoundingClientRect();
        for (const fy of [0.55, 0.45, 0.65, 0.35]) {
            for (const fx of [0.35, 0.45, 0.25, 0.55]) {
                const x = r.left + r.width * fx, y = r.top + r.height * fy;
                // Leave room for a 100 px drag to the right.
                if (document.elementFromPoint(x, y) === c && document.elementFromPoint(x + 100, y) === c) return { x, y };
            }
        }
        return null;
    });
    expect(p, 'a clear point on the canvas').not.toBeNull();
    return p;
}

test('explore flight runs at exactly the kernel\'s cruise, turn, climb and boost rates; look is pixels × sensitivity', async ({ page }) => {
    await boot(page);
    await landAt(page, { latDeg: 20, lonDeg: -40, altKm: 300, headingDeg: 90, pitchDeg: -4 });

    const cases = [
        { name: 'cruise (W)', keys: ['w'], input: { forward: 1 }, frames: 60 },
        { name: 'turn (D)', keys: ['d'], input: { turn: 1 }, frames: 30 },
        { name: 'climb (E)', keys: ['e'], input: { climb: 1 }, frames: 60 },
        { name: 'boosted cruise (Shift+W)', keys: ['Shift', 'w'], input: { forward: 1, boost: true }, frames: 45 },
        { name: 'descend + turn left (Q+A)', keys: ['q', 'a'], input: { climb: -1, turn: -1 }, frames: 40 },
    ];
    for (const c of cases) {
        const a = await info(page);
        for (const k of c.keys) await page.keyboard.down(k);
        await step(page, c.frames);
        const b = await info(page);
        for (const k of [...c.keys].reverse()) await page.keyboard.up(k);
        const want = kernelFly(a, c.input, c.frames);
        expect(Math.abs(b.latDeg - want.latDeg), `${c.name} lat`).toBeLessThan(1e-6);
        expect(lonDiff(b.lonDeg, want.lonDeg), `${c.name} lon`).toBeLessThan(1e-6);
        expect(Math.abs(b.altKm - want.altKm), `${c.name} alt`).toBeLessThan(1e-6);
        expect(lonDiff(b.headingDeg, want.headingDeg), `${c.name} heading`).toBeLessThan(1e-6);
        await step(page, 1);   // the key-up frame
    }
    // The rates themselves, in the units a person would tune.
    const a = await info(page);
    await page.keyboard.down('d'); await step(page, 60); await page.keyboard.up('d');
    const b = await info(page);
    expect(Math.abs(((b.headingDeg - a.headingDeg + 360) % 360) - EXPLORE.turnRateDeg)).toBeLessThan(1e-6);
    expect(Math.abs(b.speedKmS - cruiseSpeedKmS(b.altKm))).toBeLessThan(1e-9);

    // Mouse look: a 100 px drag right turns by exactly 100 × 0.0035 rad.
    await step(page, 1);
    const { x: x0, y: y0 } = await canvasPoint(page);
    const c0 = await info(page);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + 100, y0, { steps: 4 });
    await page.mouse.up();
    await step(page, 1);
    const c1 = await info(page);
    const turned = ((c1.headingDeg - c0.headingDeg + 540) % 360) - 180;
    expect(Math.abs(turned - 100 * 0.0035 * 180 / Math.PI)).toBeLessThan(1e-6);
    expect(Math.abs(c1.pitchDeg - c0.pitchDeg)).toBeLessThan(1e-9);   // a level drag does not pitch
});

test('a dive is the kernel path at every frame, kicks the FOV by the kernel gain, lands on time and never snaps', async ({ page }) => {
    await boot(page);
    const p0 = await pose(page);
    const D = 4;
    const target = { latDeg: -25, lonDeg: 120, altKm: 220, headingDeg: 45, pitchDeg: -6 };
    await page.evaluate(([t, d]) => window.__ua.globe.diveTo({ ...t, durationSec: d }), [target, D]);
    const path = divePath({ fromPos: p0.pos, fromFwd: p0.fwd, fromUp: p0.up, ...target });

    let prev = await pose(page);
    let maxTurnDeg = 0, maxJumpRunit = 0;
    const frames = Math.round(D / DT);
    for (let i = 1; i <= frames; i++) {
        await step(page, 1);
        const cur = await pose(page);
        const s = Math.min(1, (i * DT) / D);
        if (i < frames) {
            const want = path.at(s);
            expect(Math.abs(cur.path - s), `progress at frame ${i}`).toBeLessThan(1e-9);
            for (let k = 0; k < 3; k++) expect(Math.abs(cur.pos[k] - want.position[k]), `pos at frame ${i}`).toBeLessThan(1e-9);
            expect(Math.abs(cur.fov - p0.fov * transitionFovGain(s)), `fov at frame ${i}`).toBeLessThan(1e-9);
        }
        const d = Math.hypot(cur.fwd[0] - prev.fwd[0], cur.fwd[1] - prev.fwd[1], cur.fwd[2] - prev.fwd[2]);
        maxTurnDeg = Math.max(maxTurnDeg, 2 * Math.asin(Math.min(1, d / 2)) * 180 / Math.PI);
        maxJumpRunit = Math.max(maxJumpRunit, Math.hypot(cur.pos[0] - prev.pos[0], cur.pos[1] - prev.pos[1], cur.pos[2] - prev.pos[2]));
        prev = cur;
    }
    // Landed exactly, on the frame the clock says, with the FOV restored exactly.
    const end = await pose(page);
    expect(end.mode).toBe('explore');
    expect(end.path).toBeNull();
    expect(end.fov).toBe(p0.fov);
    const i1 = await info(page);
    expect(Math.abs(i1.latDeg - target.latDeg)).toBeLessThan(1e-9);
    expect(lonDiff(i1.lonDeg, target.lonDeg)).toBeLessThan(1e-9);
    expect(Math.abs(i1.altKm - target.altKm)).toBeLessThan(1e-6);
    expect(lonDiff(i1.headingDeg, target.headingDeg)).toBeLessThan(1e-6);
    // No snaps: the view never swings more than 2.5° in a 60 Hz frame, and
    // the camera never jumps more than the path's own top speed allows.
    expect(maxTurnDeg).toBeLessThan(2.5);
    expect(maxJumpRunit).toBeLessThan(0.12);
});

test('any key, press or wheel stops a dive on the event, where it is', async ({ page }) => {
    await boot(page);
    for (const how of ['key', 'press', 'wheel']) {
        await page.evaluate(() => window.__ua.globe.diveTo({ latDeg: 10, lonDeg: 10, altKm: 400, durationSec: 6 }));
        await step(page, 90);
        const before = await pose(page);
        expect(before.path).toBeGreaterThan(0.2);
        const pt = await canvasPoint(page);
        if (how === 'key') await page.keyboard.press('q');
        if (how === 'press') { await page.mouse.move(pt.x, pt.y); await page.mouse.down(); await page.mouse.up(); }
        if (how === 'wheel') { await page.mouse.move(pt.x, pt.y); await page.mouse.wheel(0, 40); }
        const after = await pose(page);
        expect(after.path, `${how}: stopped`).toBeNull();
        for (let k = 0; k < 3; k++) expect(Math.abs(after.pos[k] - before.pos[k]), `${how}: where it was`).toBeLessThan(1e-12);
        expect(after.fov, `${how}: FOV restored`).toBe(await page.evaluate(() => window.__ua.globe._camera.fov));
        expect(['explore', 'fly']).toContain(after.mode);
        await step(page, 2);
        // Back to the orbit view for the next case.
        await page.evaluate(() => window.__ua.globe.climbToOrbit({ durationSec: 1 }));
        await step(page, 70);
    }
});

test('the transit and the climb out run on the same clock', async ({ page }) => {
    await boot(page);
    await landAt(page, { latDeg: 0, lonDeg: 0, altKm: 500, headingDeg: 90, pitchDeg: 0 });
    await page.evaluate(() => window.__ua.globe.startTransit({ mode: 'descend', kmPerSec: 100, fromKm: 500, toKm: 200 }));
    await step(page, 60);
    let alt = await page.evaluate(() => window.__ua.globe.getCameraAltitudeKm());
    expect(Math.abs(alt - 400)).toBeLessThan(1e-6);
    await step(page, 181);
    const st = await page.evaluate(() => window.__ua.globe.getTransitState());
    expect(st.done).toBe(true);
    expect(Math.abs(st.altKm - 200)).toBeLessThan(1e-9);

    // Release the transit, then climb out: exactly radial, exactly on time.
    await page.keyboard.press('w');
    await step(page, 1);
    const p0 = await pose(page);
    const path = climbPath({ fromPos: p0.pos, fromFwd: p0.fwd, fromUp: p0.up, distance: 3.4 });
    await page.evaluate(() => window.__ua.globe.climbToOrbit({ durationSec: 3 }));
    await step(page, 90);
    const mid = await pose(page);
    const want = path.at(0.5);
    for (let k = 0; k < 3; k++) expect(Math.abs(mid.pos[k] - want.position[k])).toBeLessThan(1e-9);
    await step(page, 90);
    const end = await pose(page);
    expect(end.mode).toBe('orbit');
    expect(end.up).toEqual([0, 1, 0]);
    expect(Math.abs(Math.hypot(...end.pos) - 3.4)).toBeLessThan(1e-9);
});

test('a seeded gas cloud is repeatable, and streak length is the shutter × the speed through the gas', async ({ page }) => {
    await boot(page);
    await landAt(page, { latDeg: 5, lonDeg: 5, altKm: 250, headingDeg: 90, pitchDeg: 0 });
    const sample = () => page.evaluate(() => Array.from(window.__ua.globe._transit._pos.slice(0, 60)));
    await page.evaluate(() => window.__ua.globe.seedRandom(7));
    await step(page, 5);
    const a = await sample();
    await page.evaluate(() => window.__ua.globe.seedRandom(7));
    await step(page, 5);
    const b = await sample();
    expect(b).toEqual(a);
    await page.evaluate(() => window.__ua.globe.seedRandom(8));
    await step(page, 5);
    expect(await sample()).not.toEqual(a);

    // At rest: no streaks. Cruising: length = 0.12 s × cruise speed (in R⊕),
    // once the velocity average has settled.
    await step(page, 30);
    expect((await page.evaluate(() => window.__ua.globe.getStreakInfo())).count).toBe(0);
    await page.keyboard.down('w');
    await step(page, 90);
    const s = await page.evaluate(() => window.__ua.globe.getStreakInfo());
    await page.keyboard.up('w');
    const v = cruiseSpeedKmS(250);
    expect(s.count).toBeGreaterThan(0);
    expect(Math.abs(s.speedKmS - v) / v).toBeLessThan(0.01);
    expect(Math.abs(s.lengthRunit - 0.12 * v / R_EARTH_KM) / (0.12 * v / R_EARTH_KM)).toBeLessThan(0.01);
});
