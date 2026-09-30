/**
 * upper-atmosphere-camera-rig.spec.js — the camera rig and the incoming CME
 * ═══════════════════════════════════════════════════════════════════════════
 * Runs on the manual frame clock (`globe.setManualClock(true)` +
 * `stepFrames`), so camera motion is compared to the rig kernel
 * (js/upper-atmosphere-camera-rig.js) rather than eyeballed.
 *
 * What is pinned:
 *   • the default view is untouched: planet orbit frame, 40° lens, orbit
 *     tool, no CME layer loaded;
 *   • right-drag PANS (camera and pivot move together, pivot bounded), the
 *     swivel tool and Alt+drag turn the view about a camera that does not
 *     move, the pan tool pans on the left button;
 *   • keyboard orbit is the kernel's rate exactly, the lens keys work, and
 *     the arrows are left alone when the pointer is not over the globe;
 *   • a LIMB VIEW lands exactly on the kernel's pose, and then orbits about
 *     the LOCAL RADIAL — the OrbitControls orbit-axis scar (Stage / Mars /
 *     Moon): a NEGATIVE CONTROL rebuilds the controls about +Y instead and
 *     the same drag must break the invariant; the limb scale's ticks stack
 *     by tangent height; Reset restores the planet frame and the lens;
 *   • the panel's layer lens flies to the chosen layer at the chosen site,
 *     prints the population, and "only this layer" leaves one particle
 *     system drawn;
 *   • the CME layer (DONKI blocked ⇒ the provider fails ⇒ the Gannon REPLAY,
 *     chip says so): nothing before launch; after arrival Earth is inside a
 *     rope with the kernel's southward Bz, true-scale field lines drawn; the
 *     approach station frames the drawn Sun and Earth; off restores the
 *     camera range.
 */

import { test, expect } from '@playwright/test';
import { limbViewPose, RIG } from '../js/upper-atmosphere-camera-rig.js';

const URL = '/upper-atmosphere.html';
const DT = 1 / 60;
test.describe.configure({ timeout: 240_000 });

async function boot(page) {
    // The provider's DONKI catalogue is blocked so the CME layer's REPLAY
    // path is exercised deterministically (and nothing waits on the network).
    await page.route('**/api/donki/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.globe?.stepFrames && !!window.__ua?.rig && !!window.__ua?.cme, null, { timeout: 60_000 });
    const consent = page.locator('.pp-consent-banner');
    await consent.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) {
        await consent.locator('[data-action="reject"]').click().catch(() => {});
    }
    await page.waitForTimeout(800);
    await page.evaluate(() => { window.__ua.globe.setBeaconsVisible(false); window.__ua.globe.setManualClock(true); });
}

const step = (page, n) => page.evaluate(([n, dt]) => window.__ua.globe.stepFrames(n, dt, { render: 'none' }), [n, DT]);
const rig = (page) => page.evaluate(() => window.__ua.globe.getCameraRig());
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const angDeg = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (len(a) * len(b))))) * 180 / Math.PI;

/** A point where the WebGL canvas itself is on top, with room to drag right. */
async function canvasPoint(page) {
    const p = await page.evaluate(() => {
        const c = document.getElementById('ua-globe');
        const r = c.getBoundingClientRect();
        for (const fy of [0.55, 0.45, 0.65, 0.35]) {
            for (const fx of [0.3, 0.4, 0.25, 0.5]) {
                const x = r.left + r.width * fx, y = r.top + r.height * fy;
                if (document.elementFromPoint(x, y) === c && document.elementFromPoint(x + 160, y) === c
                    && document.elementFromPoint(x, y - 60) === c) return { x, y };
            }
        }
        return null;
    });
    expect(p, 'an uncovered canvas point').not.toBeNull();
    return p;
}

async function drag(page, from, dx, dy, { button = 'left', alt = false } = {}) {
    if (alt) await page.keyboard.down('Alt');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down({ button });
    const n = 8;
    for (let i = 1; i <= n; i++) await page.mouse.move(from.x + dx * i / n, from.y + dy * i / n);
    await page.mouse.up({ button });
    if (alt) await page.keyboard.up('Alt');
}

test('the default view is untouched: planet frame, 40° lens, orbit tool, no CME layer', async ({ page }) => {
    await boot(page);
    const r = await rig(page);
    expect(r.mode).toBe('orbit');
    expect(r.planetFrame).toBe(true);
    expect(r.tool).toBe('orbit');
    expect(r.fovDeg).toBeCloseTo(RIG.fovDefaultDeg, 9);
    expect(r.maxDistance).toBe(28);
    expect(await page.evaluate(() => window.__ua.globe.getCmeLayer())).toBeNull();
    await expect(page.locator('#ua-cam-tools [data-tool="orbit"]')).toHaveAttribute('aria-pressed', 'true');
});

test('right-drag pans, swivel and Alt+drag turn the view about a fixed camera, the pan tool pans', async ({ page }) => {
    await boot(page);
    const at = await canvasPoint(page);

    // Right drag: pan. Camera and pivot move by the same vector; the pivot leaves the centre.
    const r0 = await rig(page);
    await drag(page, at, 120, 0, { button: 'right' });
    await step(page, 90);
    const r1 = await rig(page);
    expect(len(r1.target)).toBeGreaterThan(0.05);
    const off0 = sub(r0.position, r0.target), off1 = sub(r1.position, r1.target);
    expect(len(sub(off0, off1))).toBeLessThan(1e-3);
    expect(len(r1.target)).toBeLessThanOrEqual(Math.max(RIG.pivotLimitRe, len(r1.position) + RIG.pivotMarginRe) + 1e-9);

    // Let the pan's damping tail die out (0.92^n) so it cannot pass for motion.
    await step(page, 400);
    // Swivel tool (via the HUD chip): the camera stays, the view turns right by pixels × sensitivity.
    await page.click('#ua-cam-tools [data-tool="swivel"]');
    expect((await rig(page)).tool).toBe('swivel');
    await expect(page.locator('#ua-rig-panel [data-tool="swivel"]')).toHaveAttribute('aria-pressed', 'true');
    const s0 = await rig(page);
    await drag(page, at, 100, 0);
    await step(page, 30);
    const s1 = await rig(page);
    expect(len(sub(s1.position, s0.position))).toBeLessThan(1e-9);
    const f0 = sub(s0.target, s0.position), f1 = sub(s1.target, s1.position);
    expect(angDeg(f0, f1)).toBeGreaterThan(100 * RIG.swivelSens * 180 / Math.PI * 0.6);
    // Turned to the camera's RIGHT.
    const right = await page.evaluate(() => {
        const c = window.__ua.globe._camera;
        return new c.position.constructor().setFromMatrixColumn(c.matrixWorld, 0).toArray();
    });
    expect(dot(sub(f1, f0), right)).toBeGreaterThan(0);

    // Alt + drag swivels under the orbit tool too.
    await page.click('#ua-cam-tools [data-tool="orbit"]');
    const a0 = await rig(page);
    await drag(page, at, -80, 0, { alt: true });
    await step(page, 30);
    const a1 = await rig(page);
    expect(len(sub(a1.position, a0.position))).toBeLessThan(1e-9);
    expect(angDeg(sub(a0.target, a0.position), sub(a1.target, a1.position))).toBeGreaterThan(5);

    // The pan tool pans on the LEFT button.
    await page.click('#ua-cam-tools [data-tool="pan"]');
    const p0 = await rig(page);
    await drag(page, at, 0, 80);
    await step(page, 90);
    const p1 = await rig(page);
    expect(len(sub(p1.target, p0.target))).toBeGreaterThan(0.02);
    expect(len(sub(sub(p1.position, p1.target), sub(p0.position, p0.target)))).toBeLessThan(1e-3);
});

test('keyboard orbit is the kernel rate; lens keys; arrows ignored with the pointer elsewhere', async ({ page }) => {
    await boot(page);
    const at = await canvasPoint(page);
    await page.mouse.move(at.x, at.y);
    const r0 = await rig(page);
    await page.keyboard.down('ArrowRight');
    await step(page, 60);
    await page.keyboard.up('ArrowRight');
    await step(page, 2);
    const r1 = await rig(page);
    // Azimuth about +Y (the planet frame) by exactly rate × 1 s; range held.
    const az = (p) => Math.atan2(p[0], p[2]);
    let dAz = az(r1.position) - az(r0.position);
    dAz = ((dAz + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    expect(Math.abs(Math.abs(dAz) - RIG.keyOrbitRadS * 60 * DT)).toBeLessThan(1e-6);
    expect(len(r1.position)).toBeCloseTo(len(r0.position), 9);

    await page.keyboard.down('BracketLeft');
    await step(page, 30);
    await page.keyboard.up('BracketLeft');
    const f = (await rig(page)).fovDeg;
    expect(f).toBeCloseTo(40 * Math.pow(RIG.keyFovPerS, -0.5), 6);

    // Pointer over the side panel: the arrows belong to the page, not the rig.
    const side = await page.locator('#ua-pane-controls').boundingBox();
    await page.mouse.move(side.x + 20, side.y + 20);
    const r2 = await rig(page);
    await page.keyboard.down('ArrowLeft');
    await step(page, 30);
    await page.keyboard.up('ArrowLeft');
    expect(len(sub((await rig(page)).position, r2.position))).toBeLessThan(1e-12);
});

test('a limb view lands on the kernel pose, then orbits about the LOCAL RADIAL (orbit-axis gate + negative control)', async ({ page }) => {
    await boot(page);
    const res = await page.evaluate(() => {
        const g = window.__ua.globe;
        const p = g.flyToLimb({ layerId: 'upper-thermosphere', siteId: 'dusk', durationSec: 0.5 });
        return { pose: { position: p.position, target: p.target, up: p.up, fovDeg: p.fovDeg }, site: p.site };
    });
    await step(page, 40);
    const r = await rig(page);
    // The kernel, in node, from the same site.
    const k = limbViewPose({ latDeg: res.site.latDeg, lonDeg: res.site.lonDeg, minKm: 250, maxKm: 600 });
    expect(r.mode).toBe('orbit');
    expect(r.planetFrame).toBe(false);
    expect(len(sub(r.position, k.position))).toBeLessThan(1e-6);
    expect(len(sub(r.target, k.target))).toBeLessThan(1e-9);
    expect(angDeg(r.orbitUp, k.up)).toBeLessThan(1e-6);
    expect(r.fovDeg).toBeCloseTo(k.fovDeg, 6);
    expect(await page.evaluate(() => window.__ua.globe.getFlightFocus())).toBe(true);   // hoops quieted

    // The limb scale: tangent ticks stack upward with altitude, on the canvas.
    const ticks = await page.evaluate(() => window.__ua.globe.limbTangentTicks([250, 400, 600]));
    expect(ticks.length).toBe(3);
    expect(ticks[0].y).toBeGreaterThan(ticks[1].y);
    expect(ticks[1].y).toBeGreaterThan(ticks[2].y);

    // Drag sideways: an orbit ABOUT THE LOCAL RADIAL keeps the camera's
    // height along it and its range to the pivot.
    const at = await canvasPoint(page);
    const heightAlong = (q) => dot(sub(q.position, q.target), q.orbitUp) / len(q.orbitUp);
    await drag(page, at, 160, 0);
    await step(page, 60);
    const r2 = await rig(page);
    expect(angDeg(sub(r2.position, r2.target), sub(r.position, r.target))).toBeGreaterThan(5);   // it moved
    expect(Math.abs(heightAlong(r2) - heightAlong(r))).toBeLessThan(1e-6);
    expect(len(sub(r2.position, r2.target))).toBeCloseTo(len(sub(r.position, r.target)), 7);
    const camUp = await page.evaluate(() => window.__ua.globe._camera.up.toArray());
    expect(angDeg(camUp, r.orbitUp)).toBeLessThan(1e-6);

    // NEGATIVE CONTROL: the scar put back — controls built about +Y around the
    // same pivot. The same drag must now break the invariant.
    const ctl = await page.evaluate(() => {
        const c = window.__ua.globe._controls;
        const T = c._orbit.target.clone();
        c._buildOrbit(new T.constructor(0, 1, 0), T);
        return true;
    });
    expect(ctl).toBe(true);
    const b0 = await rig(page);
    await drag(page, at, 160, 0);
    await step(page, 60);
    const b1 = await rig(page);
    const radial = r.orbitUp;
    const h = (q) => dot(sub(q.position, q.target), radial);
    expect(Math.abs(h(b1) - h(b0)), 'the +Y controls must visibly break the radial invariant').toBeGreaterThan(1e-3);

    // Reset: the planet frame and the home lens come back.
    await page.evaluate(() => window.__ua.globe.resetCameraView());
    await step(page, 90);
    const z = await rig(page);
    expect(z.planetFrame).toBe(true);
    expect(z.fovDeg).toBeCloseTo(40, 9);
    await step(page, 2);
    expect(await page.evaluate(() => window.__ua.globe.getFlightFocus())).toBe(false);
});

test('the layer lens: site + layer from the panel, the population card, and one particle population', async ({ page }) => {
    await boot(page);
    await page.locator('#ua-rig-panel select[data-f="site"]').selectOption('midnight');
    await page.locator('#ua-rig-panel [data-layer="inner-exosphere"]').click();
    const lv = await page.evaluate(() => window.__ua.globe.getLimbView());
    expect(lv.layerId).toBe('inner-exosphere');
    expect(lv.siteId).toBe('midnight');
    await expect(page.locator('#ua-rig-panel [data-f="pop"]')).toContainText('Inner Exosphere');
    await expect(page.locator('#ua-rig-panel [data-f="pop"]')).toContainText('Kn');
    await page.locator('#ua-rig-panel input[data-f="solo"]').check();
    const vis = await page.evaluate(() => Object.fromEntries(
        Object.entries(window.__ua.globe._particles).map(([id, s]) => [id, s.points.visible])));
    expect(Object.values(vis).filter(Boolean)).toHaveLength(1);
    expect(vis['inner-exosphere']).toBe(true);
    await page.locator('#ua-rig-panel input[data-f="solo"]').uncheck();
    const all = await page.evaluate(() => Object.values(window.__ua.globe._particles).every((s) => s.points.visible));
    expect(all).toBe(true);
});

test('the incoming CME: REPLAY when the feed is down, nothing before launch, the rope field at Earth after arrival', async ({ page }) => {
    await boot(page);
    await page.locator('#ua-cme-panel [data-act="toggle"]').click();
    await page.waitForFunction(() => window.__ua.globe.getCmeLayer()?.getState()?.status?.state === 'replay', null, { timeout: 90_000 });
    await expect(page.locator('#ua-cme-panel [data-f="chip"]')).toContainText('REPLAY');
    expect((await rig(page)).maxDistance).toBeGreaterThan(300);

    const at = async (hoursAfterLaunch) => {
        await page.evaluate((h) => {
            const L = window.__ua.globe.getCmeLayer();
            L.setPlaying(false);
            L.setTau(L.getState().launchMs + h * 3600e3);
        }, hoursAfterLaunch);
        await step(page, 2);
        await page.waitForTimeout(350);          // the field / line cadences are wall-clock leashes
        await step(page, 2);
        return page.evaluate(() => {
            const L = window.__ua.globe.getCmeLayer();
            const s = L.getState();
            const lines = L.root.getObjectByName('cme-imf-lines');
            const ropesShown = L.ropes.filter((r) => r.mesh.visible).length;
            return { atEarth: s.atEarth, ropes: s.ropes, drawn: lines.geometry.drawRange.count, ropesShown };
        });
    };

    const before = await at(-3);
    expect(before.ropesShown).toBe(0);
    expect(before.drawn).toBe(0);
    expect(before.atEarth?.inside ?? false).toBe(false);

    const after = await at(60);
    expect(after.ropes.length).toBeGreaterThanOrEqual(1);
    expect(after.ropes.every((r) => r.oracle === 'kernel')).toBe(true);
    expect(after.atEarth.inside).toBe(true);
    expect(after.atEarth.gse[2]).toBeLessThan(0);          // the kernel's southward Bz
    expect(after.drawn).toBeGreaterThan(20);
    await expect(page.locator('#ua-cme-panel [data-f="earth"]')).toContainText('inside the rope');

    // The approach station frames the drawn Sun and Earth.
    await page.evaluate(() => window.__ua.globe.flyToCmeView('approach'));
    await step(page, 200);
    const ndc = await page.evaluate(() => {
        const g = window.__ua.globe, c = g._camera;
        const sun = g.getCmeLayer().root.getObjectByName('cme-sun').position.clone().project(c);
        const earth = new c.position.constructor(0, 0, 0).project(c);
        return { sun: [sun.x, sun.y, sun.z], earth: [earth.x, earth.y, earth.z] };
    });
    for (const p of [ndc.sun, ndc.earth]) {
        expect(Math.abs(p[0])).toBeLessThan(1);
        expect(Math.abs(p[1])).toBeLessThan(1);
        expect(p[2]).toBeLessThan(1);
    }

    // Off: hidden, and the camera range comes back.
    await page.locator('#ua-cme-panel [data-act="toggle"]').click();
    await page.waitForFunction(() => !window.__ua.globe.isCmeLayerEnabled());
    expect((await rig(page)).maxDistance).toBe(28);
    expect(await page.evaluate(() => window.__ua.globe.getCmeLayer().root.visible)).toBe(false);
});
