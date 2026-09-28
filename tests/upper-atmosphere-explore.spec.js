/**
 * upper-atmosphere-explore.spec.js — browser gate for explore mode
 * ═══════════════════════════════════════════════════════════════════════════
 * The kernel is gated in node (`tests/upper-atmosphere-explore.mjs`). What
 * needs a browser:
 *   • the default orbit view is untouched (no membrane pass, no curtains)
 *     until the camera comes down, while the gauge / beacons / labels exist;
 *   • the Explore button DIVES and arrives exactly, level, in explore mode,
 *     with the field of view restored after its kick;
 *   • W flies ALONG the sphere (altitude held at pitch 0) and the gas
 *     streaks while moving; any key cancels a dive where it is (the page
 *     may start a flight, not hold the camera);
 *   • double-click dives to the clicked ground; the altitude column rides
 *     the vertical and the crossings name the layer entered;
 *   • the aurora stop draws the curtains, and Orbit climbs back out with
 *     OrbitControls' +Y up and the user's focus settings restored;
 *   • immersive fills the window and Esc leaves it;
 *   • no GL error, no shader compile failure, no page error anywhere.
 */

import { test, expect } from '@playwright/test';

const URL = '/upper-atmosphere.html';
const BOOT_MS = 45_000;
test.describe.configure({ timeout: 240_000 });

function watchErrors(page) {
    const errs = [];
    page.on('console', (m) => { if (/Shader Error|not compiled|reserved word|THREE\.WebGLProgram/i.test(m.text())) errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    return errs;
}

async function boot(page) {
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.explore && !!window.__ua?.globe?.diveTo, { timeout: BOOT_MS });
    const consent = page.locator('.pp-consent-banner');
    await consent.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) {
        await consent.locator('[data-action="reject"]').click().catch(() => {});
    }
    await page.waitForTimeout(1500);
}

const arrived = (page) => page.waitForFunction(
    () => window.__ua.globe.getCameraMode() === 'explore' && !window.__ua.globe.isTransitioning(),
    { timeout: 90_000 });

test('orbit view is untouched until you come down; Explore dives and arrives level', async ({ page }) => {
    const errs = watchErrors(page);
    await boot(page);
    const orbit = await page.evaluate(() => {
        const g = window.__ua.globe;
        return {
            mem: g.isMembranePassDrawn(), aurora: g.getAuroraCurtainInfo().drawn,
            gauge: !!document.querySelector('#ua-explore-gauge .ua-xg-bar'),
            pois: g.getPointsOfInterest().length, fov: g._camera.fov,
            labels: document.querySelectorAll('#ua-explore-labels .ua-xl-tag').length,
            info: g.getExploreInfo(),
        };
    });
    expect(orbit.mem).toBe(false);
    expect(orbit.aurora).toBe(false);
    expect(orbit.gauge).toBe(true);
    expect(orbit.pois).toBeGreaterThanOrEqual(7);
    expect(orbit.labels).toBeGreaterThan(0);
    expect(orbit.info).toBeNull();

    const kinds = [];
    await page.exposeFunction('__uaKind', (k) => kinds.push(k));
    await page.evaluate(() => window.addEventListener('ua-explore', (e) => window.__uaKind(e.detail.kind)));
    await page.locator('#ua-cam-explore').click();
    await page.waitForFunction(() => window.__ua.globe.isTransitioning(), { timeout: 10_000 });
    await arrived(page);
    // Announced, crossed on the way (the ceiling at least), and arrived.
    expect(kinds[0]).toBe('dive-start');
    expect(kinds).toContain('cross');
    expect(kinds).toContain('dive-arrive');
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
        const g = window.__ua.globe, c = g._camera;
        const p = c.position.clone().normalize();
        return {
            info: g.getExploreInfo(), upDot: c.up.dot(p), fov: c.fov,
            mem: g.isMembranePassDrawn(), near: c.near,
            gl: g._renderer.getContext().getError(),
            chip: document.getElementById('ua-cam-mode').textContent,
            btn: document.getElementById('ua-cam-explore').classList.contains('ua-cam-on'),
        };
    });
    expect(Math.abs(r.info.altKm - 250)).toBeLessThan(0.5);
    expect(Math.abs(r.info.pitchDeg - (-8))).toBeLessThan(0.01);
    expect(r.upDot).toBeGreaterThan(0.99999);
    expect(r.fov).toBe(orbit.fov);                 // the FOV kick is restored exactly
    expect(r.mem).toBe(true);                      // the 250 km boundary is right here
    expect(r.near).toBeLessThanOrEqual(0.01);
    expect(r.chip).toBe('explore');
    expect(r.btn).toBe(true);
    expect(r.gl).toBe(0);
    expect(errs, errs.join('\n')).toEqual([]);
});

test('W flies along the sphere at constant altitude and streaks the gas; a key cancels a dive where it is', async ({ page }) => {
    const errs = watchErrors(page);
    await boot(page);
    await page.evaluate(() => window.__ua.globe.diveTo({ latDeg: 20, lonDeg: -40, altKm: 300, headingDeg: 90, pitchDeg: 0, durationSec: 1.5 }));
    await arrived(page);
    await page.waitForTimeout(600);
    const a = await page.evaluate(() => window.__ua.globe.getExploreInfo());
    // Boosted: the controls' step is capped at 0.1 s, so on a software
    // renderer (~0.6 s frames) the unboosted apparent speed sits right at
    // the streak threshold.
    await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    await page.waitForTimeout(1200);
    const streak = await page.evaluate(() => window.__ua.globe.getStreakInfo());
    await page.waitForTimeout(1200);
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(400);
    const b = await page.evaluate(() => window.__ua.globe.getExploreInfo());
    expect(Math.abs(b.altKm - a.altKm)).toBeLessThan(0.5);       // altitude held at pitch 0
    const moved = Math.hypot(b.latDeg - a.latDeg, (b.lonDeg - a.lonDeg) * Math.cos(20 * Math.PI / 180));
    expect(moved).toBeGreaterThan(0.05);                          // it flew
    expect(Math.abs(b.latDeg - a.latDeg)).toBeLessThan(moved);    // mostly east, as headed
    expect(streak.count).toBeGreaterThan(0);                      // gas streaked while moving
    expect(streak.lengthRunit).toBeGreaterThan(0);
    const rest = await page.evaluate(async () => { await new Promise(r => setTimeout(r, 1500)); return window.__ua.globe.getStreakInfo(); });
    expect(rest.count).toBe(0);                                   // and stopped at rest

    // Any move key takes a dive back where it is.
    const fov0 = await page.evaluate(() => window.__ua.globe._camera.fov);
    await page.evaluate(() => window.__ua.globe.diveToPoi('geocorona', { durationSec: 8 }));
    await page.waitForTimeout(900);
    expect(await page.evaluate(() => window.__ua.globe.isTransitioning())).toBe(true);
    await page.keyboard.press('q');
    await page.waitForTimeout(400);
    const c = await page.evaluate(() => ({
        dive: window.__ua.globe.isTransitioning(), mode: window.__ua.globe.getCameraMode(),
        fov: window.__ua.globe._camera.fov, alt: window.__ua.globe.getCameraAltitudeKm(),
    }));
    expect(c.dive).toBe(false);
    expect(['explore', 'fly']).toContain(c.mode);
    expect(c.fov).toBe(fov0);
    expect(errs, errs.join('\n')).toEqual([]);
});

test('double-click dives to the clicked ground; the altitude column rides down and names the layers crossed', async ({ page }) => {
    const errs = watchErrors(page);
    await boot(page);
    const events = [];
    await page.exposeFunction('__uaEvt', (d) => events.push(d));
    await page.evaluate(() => window.addEventListener('ua-explore', (e) => window.__uaEvt(JSON.parse(JSON.stringify(e.detail)))));
    // Labels are their own clickable (dive to that POI); keep them out of
    // the way so this press lands on the planet itself.
    await page.evaluate(() => window.__ua.globe.setBeaconsVisible(false));
    await page.waitForTimeout(400);
    const canvas = page.locator('#ua-globe');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    const px = box.x + box.width * 0.45, py = box.y + box.height * 0.5;   // on the planet from the default view
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.id, [px, py])).toBe('ua-globe');
    await page.mouse.move(px, py);
    await page.mouse.dblclick(px, py);
    await page.waitForFunction(() => window.__ua.globe.isTransitioning(), { timeout: 10_000 });
    await arrived(page);
    const start = events.find(e => e.kind === 'dive-start');
    expect(start).toBeTruthy();
    const at = await page.evaluate(() => window.__ua.globe.getExploreInfo());
    expect(Math.abs(at.latDeg - start.target.latDeg)).toBeLessThan(1e-6);
    expect(Math.abs(at.lonDeg - start.target.lonDeg)).toBeLessThan(1e-6);
    expect(Math.abs(at.altKm - 250)).toBeLessThan(0.5);
    expect(events.some(e => e.kind === 'dive-arrive')).toBe(true);

    // Up to 700 km first, so the ride the column starts down to 110 km
    // crosses the 600 and 250 km boundaries.
    await page.evaluate(() => window.__ua.globe.goToAltitude(700));
    await page.waitForFunction(() => window.__ua.globe.getTransitState()?.done, { timeout: 30_000 });
    events.length = 0;
    const bar = await page.locator('#ua-explore-gauge .ua-xg-bar').boundingBox();
    const f = Math.log(110 / 80) / Math.log(2000 / 80);
    await page.mouse.click(bar.x + bar.width / 2, bar.y + bar.height * (1 - f));
    await page.waitForFunction(() => window.__ua.globe.getTransitState()?.done, { timeout: 30_000 });
    const [alt, near] = await page.evaluate(() => [window.__ua.globe.getCameraAltitudeKm(), window.__ua.globe._camera.near]);
    expect(Math.abs(alt - 110)).toBeLessThan(6);                  // one gauge pixel is a few km
    expect(near).toBeLessThan(0.006);                             // the near plane followed the camera down
    const crossings = events.filter(e => e.kind === 'cross');
    expect(crossings.length).toBeGreaterThan(0);
    const names = crossings.map(e => e.entered);
    // Announced as each is crossed (a slow frame may merge two; the last one names where we are).
    expect(names.some(n => /Thermosphere/.test(n))).toBe(true);
    expect(errs, errs.join('\n')).toEqual([]);
});

test('the aurora stop draws the curtains; Orbit climbs back out with +Y up and focus restored; immersive round-trips', async ({ page }) => {
    const errs = watchErrors(page);
    await boot(page);
    const focus0 = await page.evaluate(() => window.__ua.globe.getFlightFocus());
    await page.evaluate(() => window.__ua.globe.diveToPoi('aurora', { durationSec: 2 }));
    await arrived(page);
    await page.waitForTimeout(800);
    const a = await page.evaluate(() => ({
        aur: window.__ua.globe.getAuroraCurtainInfo(),
        disc: window.__ua.globe.getExploreDiscoveries(),
        focus: window.__ua.globe.getFlightFocus(),
    }));
    expect(a.aur.drawn).toBe(true);
    expect(a.aur.fade).toBeGreaterThan(0.99);
    expect(a.disc.found).toContain('aurora');
    expect(a.focus).toBe(true);                   // hoops quieted while down in the band

    // Immersive: fills the window, Esc leaves.
    const vp = page.viewportSize();
    await page.locator('#ua-cam-immersive').click();
    await page.waitForTimeout(1500);
    const imm = await page.evaluate(() => ({ w: window.__ua.globe.canvas.clientWidth, h: window.__ua.globe.canvas.clientHeight, on: window.__ua.explore.isImmersive() }));
    expect(imm.on).toBe(true);
    expect(imm.w).toBeGreaterThan(vp.width - 4);
    expect(imm.h).toBeGreaterThan(vp.height - 4);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1200);
    const out = await page.evaluate(() => ({ h: window.__ua.globe.canvas.clientHeight, on: window.__ua.explore.isImmersive() }));
    expect(out.on).toBe(false);
    expect(out.h).toBeLessThan(vp.height - 100);

    await page.locator('#ua-cam-orbit').click();
    await page.waitForFunction(() => window.__ua.globe.isTransitioning(), { timeout: 10_000 });
    await page.waitForFunction(() => window.__ua.globe.getCameraMode() === 'orbit' && !window.__ua.globe.isTransitioning(), { timeout: 90_000 });
    await page.waitForTimeout(800);
    const o = await page.evaluate(() => {
        const g = window.__ua.globe;
        return { up: g._camera.up.toArray(), alt: g.getCameraAltitudeKm(), focus: g.getFlightFocus(),
                 aur: g.getAuroraCurtainInfo().drawn, mem: g.isMembranePassDrawn(), gl: g._renderer.getContext().getError() };
    });
    expect(o.up).toEqual([0, 1, 0]);
    expect(Math.abs(o.alt - 2.4 * 6371)).toBeLessThan(5);
    expect(o.focus).toBe(focus0);
    expect(o.aur).toBe(false);
    expect(o.mem).toBe(false);
    expect(o.gl).toBe(0);
    expect(errs, errs.join('\n')).toEqual([]);
});
