/**
 * upper-atmosphere-satellites.spec.js — satellite suites, framing, and the
 * camera's way home
 * ═══════════════════════════════════════════════════════════════════════════
 * Runs on the manual frame clock with a SYNTHETIC catalogue
 * (tests/fixtures/sat-suites-synthetic.mjs — real checksummed TLEs, Walker
 * shells) so nothing waits on CelesTrak. What is pinned:
 *
 *   • the suites panel lists the WHOLE catalogue by category; a suite loads
 *     with its count, the ladder draws, a failed suite says so and unticks;
 *   • the catalogue dots sit at the SGP4 position of the SCENE instant (the
 *     bus), and move when the bus is scrubbed — NEGATIVE CONTROL: the old
 *     wall-clock tick, with the bus 3 h away, must miss by far more;
 *   • every orbit ring passes through its own dot (rebuilt AND rotation-only
 *     frames), and a picked dot gets its own ring;
 *   • ONE SATELLITE, ONE PLACE: the named ISS probe, the same NORAD in the
 *     stations suite, the probe's own orbit loop and a flight seeded from
 *     its TLE all coincide; NEGATIVE CONTROLS: the legacy frozen-node orbit
 *     (>200 km on a 2-day-old TLE) and the old 6378.135 km/unit tracker
 *     scale (>5 km) must each break it;
 *   • the dots are capped (§9.5) and textured;
 *   • "Frame GEO" lands with the whole GEO belt in view in the planet orbit
 *     frame, which it was not from home — and does not HOLD the camera;
 *   • the escape hatch (2026-10-04 report: stuck chasing the ISS): Reset
 *     during a Visit-ISS fly-in ends in orbit with NO follow even after the
 *     fly-in's timer fires — NEGATIVE CONTROL: without the cancellation the
 *     lock re-engages; re-clicking the followed target is a no-op; R resets
 *     and Esc lets go;
 *   • full screen is a large labelled button, F toggles it, Esc leaves.
 */

import { test, expect } from '@playwright/test';
import { SAT_SUITES, SUITE_CATEGORIES } from '../js/upper-atmosphere-sat-suites.js';
import { routeSyntheticCatalogue } from './fixtures/sat-suites-synthetic.mjs';

const URL = '/upper-atmosphere.html';
const DT = 1 / 60;
const EPOCH = Math.floor(Date.now() / 3600e3) * 3600e3 - 3600e3;   // an hour-aligned epoch, an hour ago
test.describe.configure({ timeout: 240_000 });

async function boot(page) {
    await page.route('**/api/donki/**', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{}' }));
    await routeSyntheticCatalogue(page, EPOCH);
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.globe?.stepFrames && !!window.__ua?.satSuites, null, { timeout: 60_000 });
    const consent = page.locator('.pp-consent-banner');
    await consent.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) {
        await consent.locator('[data-action="reject"]').click().catch(() => {});
    }
    await page.waitForTimeout(600);
    // The suites panel lives in the Analysis pane.
    await page.locator('#ua-aside-tabs [data-ua-tab="analysis"]').click();
    await page.evaluate(() => { window.__ua.globe.setBeaconsVisible?.(false); window.__ua.globe.setManualClock(true); });
}

const step = (page, n, render = 'none') => page.evaluate(([n, dt, render]) => window.__ua.globe.stepFrames(n, dt, { render }), [n, DT, render]);
const setBus = (page, ms) => page.evaluate((ms) => { const b = window.__ua.globe._timeBus; b.pause(); b.setSimTime(ms); }, ms);

async function enableSuite(page, group) {
    await page.locator(`#ua-sat-suites label[data-group="${group}"]`).click();
    await page.waitForFunction((g) => (window.__ua.globe.getCatalogStatus().groups.find((x) => x.name === g)?.count ?? 0) > 0, group, { timeout: 30_000 });
}

/**
 * Worst |dot − SGP4(scene instant)| over a group, in km, after the tracker's
 * worker has published a frame for that instant. SGP4 is the page's OWN
 * WASM; the TEME → scene map is the kernel's (pinned to coords.js in node).
 */
async function worstDotErrorKm(page, group, { frames = 40 } = {}) {
    for (let i = 0; i < frames; i++) {
        await step(page, 1);
        await page.waitForTimeout(25);
    }
    return page.evaluate(async (group) => {
        const g = window.__ua.globe;
        const t = g._catalogTracker;
        const { getWasmSgp4 } = await import('/js/satellite-tracker.js');
        const K = await import('/js/upper-atmosphere-sat-suites.js');
        const wasm = getWasmSgp4();
        const ms = g.getSceneTimeMs();
        const gm = K.gmstRad(ms);
        let worst = 0;
        for (const s of t._satellites.filter((x) => x.group === group)) {
            const tsince = (ms / 86400000 + 2440587.5 - s.epochJd) * 1440;
            const r = wasm.propagate_tle(s.tle.line1, s.tle.line2, tsince);
            const want = K.temeToScene(r[0], r[1], r[2], gm);
            const got = t.getPositionXYZ(s.tle.norad_id);
            worst = Math.max(worst, Math.hypot(got.x - want[0], got.y - want[1], got.z - want[2]) * K.SCENE_RE_KM);
        }
        return worst;
    }, group);
}

test('the suites panel lists the whole catalogue; a suite loads, the ladder draws, a failure says so', async ({ page }) => {
    await boot(page);
    const host = page.locator('#ua-sat-suites');
    for (const c of SUITE_CATEGORIES) await expect(host.locator('.ua-ss-catlabel', { hasText: c.label })).toHaveCount(1);
    await expect(host.locator('label[data-group]')).toHaveCount(SAT_SUITES.length);
    await expect(page.locator('#ua-ss-ladder')).toBeHidden();

    await enableSuite(page, 'starlink');
    await expect(host.locator('[data-count="starlink"]')).toHaveText(/48/);
    await expect(page.locator('#ua-catalog-status')).toContainText('48 shown');
    await expect(page.locator('#ua-ss-ladder')).toBeVisible();
    // 550 km sits in one 50 km bin of the thermosphere.
    const ladder = await page.evaluate(() => window.__ua.globe.getSuiteLadder());
    expect(ladder.total).toBe(48);
    expect(ladder.bins.find((b) => b.count > 0)).toMatchObject({ loKm: 550, count: 48, layer: 'thermosphere' });
    await expect(page.locator('#ua-ss-ladder .ua-ss-bar')).toHaveCount(1);

    // A suite the route cannot serve (fixture → 503): the chip unticks and the status says why.
    await page.locator('#ua-sat-suites label[data-group="oneweb"]').click();
    await expect(page.locator('#ua-catalog-status')).toHaveAttribute('data-kind', 'error', { timeout: 15_000 });
    await expect(page.locator('#ua-sat-suites label[data-group="oneweb"] input')).not.toBeChecked();

    // Hiding a suite empties the ladder and the picking (hidden dots do not answer).
    await page.locator('#ua-sat-suites label[data-group="starlink"]').click();
    const hidden = await page.evaluate(() => {
        const g = window.__ua.globe;
        return { total: g.getSuiteLadder().total, pick: g._resolveCatalogHit({ object: g._catalogTracker._pointsMesh, index: 0 }) };
    });
    expect(hidden).toEqual({ total: 0, pick: null });
});

test('catalogue dots ride the SCENE clock (negative control: the wall clock)', async ({ page }) => {
    await boot(page);
    await setBus(page, EPOCH + 2 * 3600e3);
    await enableSuite(page, 'stations');
    await enableSuite(page, 'starlink');

    const capped = await page.evaluate(() => {
        const m = window.__ua.globe._catalogTracker._dotMat;
        return { cap: m.userData.pointCapPx, map: !!m.map };
    });
    expect(capped).toEqual({ cap: 6, map: true });

    const e1 = await worstDotErrorKm(page, 'starlink');
    console.log(`  dots vs SGP4 @bus: ${e1.toFixed(3)} km`);
    expect(e1).toBeLessThan(2);

    const p0 = await page.evaluate(() => ({ ...window.__ua.globe._catalogTracker.getPositionXYZ(79999) }));
    await setBus(page, EPOCH + 2 * 3600e3 + 25 * 60e3);   // a quarter orbit later
    const e2 = await worstDotErrorKm(page, 'stations');
    const p1 = await page.evaluate(() => ({ ...window.__ua.globe._catalogTracker.getPositionXYZ(79999) }));
    expect(e2).toBeLessThan(2);
    expect(Math.hypot(p1.x - p0.x, p1.y - p0.y, p1.z - p0.z)).toBeGreaterThan(0.8);   // it moved ~1.5 R⊕ of arc

    // NEGATIVE CONTROL: the pre-2026-10 tick (Date.now()) with the bus 3 h away.
    await setBus(page, Date.now() + 3 * 3600e3);
    await page.evaluate(() => { window.__ua.globe._catalogClockOverride = () => Date.now(); });
    const bad = await worstDotErrorKm(page, 'starlink');
    console.log(`  control (wall-clock tick): ${bad.toFixed(0)} km`);
    expect(bad).toBeGreaterThan(500);
    await page.evaluate(() => { window.__ua.globe._catalogClockOverride = null; });
});

test('one satellite, one place: named probe, catalogue dot, its ring and a seeded flight coincide', async ({ page }) => {
    await boot(page);
    // The named ISS probe upgrades from the fixture's ?norad=25544 record and
    // hands itself to the SGP4 WASM; the SAME record is in the stations suite.
    await page.waitForFunction(() => !!window.__ua.globe._satProbes?.iss?._sgp4, null, { timeout: 30_000 });
    await setBus(page, EPOCH + 3600e3);
    await enableSuite(page, 'stations');
    const dotErr = await worstDotErrorKm(page, 'stations', { frames: 30 });
    expect(dotErr).toBeLessThan(2);

    const measure = () => page.evaluate(async () => {
        const g = window.__ua.globe;
        g.stepFrames(1, 1 / 60, { render: 'none' });
        const K = await import('/js/upper-atmosphere-sat-suites.js');
        const probe = g._satProbes.iss;
        const a = probe.mesh.position;
        const b = g._catalogTracker.getPositionXYZ(25544);
        // The probe's own orbit loop, turned Earth-fixed exactly as drawn.
        probe.pathLine.updateMatrixWorld(true);
        const pos = probe.pathLine.geometry.getAttribute('position').array;
        const e = probe.pathLine.matrixWorld.elements;
        const ring = new Float64Array(pos.length);
        for (let i = 0; i < pos.length; i += 3) {
            const x = pos[i], y = pos[i + 1], z = pos[i + 2];
            ring[i] = e[0] * x + e[4] * y + e[8] * z;
            ring[i + 1] = e[1] * x + e[5] * y + e[9] * z;
            ring[i + 2] = e[2] * x + e[6] * y + e[10] * z;
        }
        return {
            gapKm: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 6371,
            ringKm: K.distanceToRing([a.x, a.y, a.z], ring) * 6371,
            probeAlt: probe.mesh.userData.altKm,
            dotAlt: g._catalogPageAltKm(g._catalogTracker._satellites.find((s) => s.tle.norad_id === 25544)),
        };
    });

    const m = await measure();
    console.log(`  ISS probe vs its catalogue dot: ${m.gapKm.toFixed(3)} km · probe to its own orbit loop: ${m.ringKm.toFixed(2)} km · alt ${m.probeAlt.toFixed(2)} / ${m.dotAlt.toFixed(2)} km`);
    expect(m.gapKm).toBeLessThan(0.5);            // one propagator, one datum
    expect(m.ringKm).toBeLessThan(20);            // mean ring with J2 vs SGP4
    expect(Math.abs(m.probeAlt - m.dotAlt)).toBeLessThan(0.5);

    // A flight seeded from the same TLE at the same instant starts ON the dot.
    const flight = await page.evaluate(async () => {
        const g = window.__ua.globe;
        const lines = g._satProbes.iss.tleLines;
        await g.trackFlightFromTle({ line1: lines.line1, line2: lines.line2, name: 'ISS', horizonS: 600 });
        g.stepFrames(1, 1 / 60, { render: 'none' });
        const f = g._flight.getFlight();
        const p = f.sceneAt(0);
        const b = g._catalogTracker.getPositionXYZ(25544);
        return Math.hypot(p[0] - b.x, p[1] - b.y, p[2] - b.z) * 6371;
    });
    console.log(`  flight seed vs dot: ${flight.toFixed(3)} km`);
    expect(flight).toBeLessThan(2);

    // Before the WASM answers, the probe rides its mean elements + J2: close.
    await page.evaluate(() => { const p = window.__ua.globe._satProbes.iss; p.__sgp4 = p._sgp4; p._sgp4 = null; });
    const meanPath = await measure();
    console.log(`  mean-element path vs dot: ${meanPath.gapKm.toFixed(2)} km`);
    expect(meanPath.gapKm).toBeLessThan(25);

    // NEGATIVE CONTROL — the legacy frozen-node circle on a 2-day-old TLE.
    await page.evaluate(() => { const p = window.__ua.globe._satProbes.iss; p.__el = p._el; p._el = null; });
    const legacy = await measure();
    console.log(`  control (legacy two-body, frozen node): ${legacy.gapKm.toFixed(0)} km`);
    expect(legacy.gapKm).toBeGreaterThan(200);
    await page.evaluate(() => { const p = window.__ua.globe._satProbes.iss; p._el = p.__el; p._sgp4 = p.__sgp4; });

    // NEGATIVE CONTROL — the old tracker scale (earthRadius 1.0 ⇒ km/6378.135).
    await page.evaluate(() => { window.__ua.globe._catalogTracker._earthR = 1.0; });
    const scaled = await worstDotErrorKm(page, 'stations', { frames: 30 });
    console.log(`  control (tracker at 6378.135 km/unit): ${scaled.toFixed(2)} km`);
    expect(scaled).toBeGreaterThan(5);
});

test('orbit rings pass through their own dots, rebuilt and rotated; a picked dot gets its ring', async ({ page }) => {
    await boot(page);
    await setBus(page, EPOCH + 3600e3);
    await enableSuite(page, 'starlink');
    await enableSuite(page, 'gps-ops');
    await page.locator('#ua-ss-rings').check();

    const ringMiss = async () => {
        await worstDotErrorKm(page, 'starlink', { frames: 30 });
        return page.evaluate(async () => {
            const g = window.__ua.globe;
            const K = await import('/js/upper-atmosphere-sat-suites.js');
            const rings = g._suiteRings;
            rings.updateMatrixWorld(true);
            const pos = rings.geometry.getAttribute('position').array;
            const e = rings.matrixWorld.elements;
            const st = g.getSuiteRingState();
            const N = 96;
            let worst = 0;
            st.norads.forEach((norad, k) => {
                const ring = new Float64Array(N * 3);
                for (let i = 0; i < N; i++) {
                    const o = k * N * 6 + i * 6;
                    const x = pos[o], y = pos[o + 1], z = pos[o + 2];
                    ring[i * 3] = e[0] * x + e[4] * y + e[8] * z;
                    ring[i * 3 + 1] = e[1] * x + e[5] * y + e[9] * z;
                    ring[i * 3 + 2] = e[2] * x + e[6] * y + e[10] * z;
                }
                const p = g._catalogTracker.getPositionXYZ(norad);
                worst = Math.max(worst, K.distanceToRing([p.x, p.y, p.z], ring) * K.SCENE_RE_KM);
            });
            return { worst, count: st.count, builtMs: st.builtMs };
        });
    };
    const a = await ringMiss();
    console.log(`  rings: ${a.count}, worst dot-to-ring ${a.worst.toFixed(2)} km`);
    expect(a.count).toBe(24 + 24);                 // 24 per suite (GPS has exactly 24)
    expect(a.worst).toBeLessThan(25);
    await expect(page.locator('#ua-catalog-status')).toContainText('48 orbit rings');

    // +5 min: no rebuild, the group is only TURNED by the sidereal angle.
    await setBus(page, EPOCH + 3600e3 + 5 * 60e3);
    const b = await ringMiss();
    expect(b.builtMs).toBe(a.builtMs);
    expect(b.worst).toBeLessThan(25);
    // +2 h: rebuilt for the J2 drift.
    await setBus(page, EPOCH + 3 * 3600e3);
    const c = await ringMiss();
    expect(c.builtMs).not.toBe(a.builtMs);
    expect(c.worst).toBeLessThan(25);

    // The sample covers the starlink suite's six planes, not one crowded plane.
    const planes = await page.evaluate(() => {
        const g = window.__ua.globe;
        const st = g.getSuiteRingState();
        const sats = g._catalogTracker._satellites;
        return new Set(st.norads.map((n) => sats.find((s) => s.tle.norad_id === n))
            .filter((s) => s.group === 'starlink').map((s) => Math.round(s.tle.raan))).size;
    });
    expect(planes).toBe(6);

    // A picked catalogue dot gets its own ring, even with the suite rings off.
    await page.locator('#ua-ss-rings').uncheck();
    await page.evaluate(() => window.__ua.globe.setFocusSatellite(70050));
    await step(page, 2);
    expect(await page.evaluate(() => window.__ua.globe.getSuiteRingState())).toMatchObject({ on: false, count: 1, focus: 70050, norads: [70050] });
    expect(await page.evaluate(() => window.__ua.globe._suiteRings.visible)).toBe(true);
});

test('Frame GEO brings the whole belt into view, in orbit mode, and does not hold the camera', async ({ page }) => {
    await boot(page);
    await setBus(page, EPOCH + 3600e3);
    await enableSuite(page, 'geo');
    await worstDotErrorKm(page, 'geo', { frames: 20 });

    const inView = () => page.evaluate(() => {
        const g = window.__ua.globe;
        const cam = g._camera;
        cam.updateMatrixWorld(true);
        const t = g._catalogTracker;
        let inside = 0, n = 0;
        for (const s of t._satellites.filter((x) => x.group === 'geo')) {
            const p = t.getPositionXYZ(s.tle.norad_id);
            const v = new cam.position.constructor(p.x, p.y, p.z).project(cam);
            n++;
            if (v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1) inside++;
        }
        return { inside, n, dist: cam.position.length(), mode: g.getCameraMode() };
    });
    const before = await inView();
    expect(before.inside).toBeLessThan(before.n);   // from home the belt is not all in view

    await page.locator('#ua-sat-suites [data-frame="geo"]').click();
    const plan = await page.evaluate(() => window.__ua.globe._lastFrame);
    await step(page, 120, 'last');
    const after = await inView();
    console.log(`  GEO: ${before.inside}/${before.n} → ${after.inside}/${after.n} in view, d=${after.dist.toFixed(2)} R⊕`);
    expect(after.inside).toBe(after.n);
    expect(after.mode).toBe('orbit');
    expect(after.dist).toBeCloseTo(plan.distance, 2);

    // Not held: a zoom after the flight sticks.
    await page.evaluate(() => window.__ua.globe.dollyCamera(0.8));
    await step(page, 90);
    const held = await page.evaluate(() => window.__ua.globe._camera.position.length());
    expect(held).toBeLessThan(plan.distance * 0.9);
});

test('the camera always has a way home (stuck-following-the-ISS report)', async ({ page }) => {
    await boot(page);
    const state = () => page.evaluate(() => {
        const g = window.__ua.globe;
        return { following: g.isFollowing(), mode: g.getCameraMode(), dist: g._camera.position.length(),
                 target: g.getFollowTarget() };
    });
    const HOME = 3.4 * Math.hypot(1, 0.65);

    // Reset DURING the Visit-ISS fly-in; the fly-in's 1.6 s (wall) timer must not re-lock.
    await page.locator('#ua-cam-iss').click();
    await step(page, 30);
    await page.locator('#ua-cam-reset').click();
    await page.waitForTimeout(2000);
    await step(page, 120);
    let s = await state();
    expect(s).toMatchObject({ following: false, mode: 'orbit', target: null });
    expect(s.dist).toBeCloseTo(HOME, 1);

    // NEGATIVE CONTROL: without the cancellation the same sequence ends locked.
    await page.evaluate(() => { const g = window.__ua.globe; g.__cancel = g._cancelPendingFollow; g._cancelPendingFollow = () => {}; });
    await page.locator('#ua-cam-iss').click();
    await step(page, 30);
    await page.locator('#ua-cam-reset').click();
    await page.waitForTimeout(2000);
    await step(page, 5);
    expect((await state()).following).toBe(true);
    await page.evaluate(() => { const g = window.__ua.globe; g._cancelPendingFollow = g.__cancel; });

    // Esc lets go of a follow; R goes home from anywhere.
    await page.keyboard.press('Escape');
    expect((await state()).following).toBe(false);
    await page.locator('#ua-cam-iss').click();
    await page.waitForTimeout(1800);
    await step(page, 120);
    expect((await state()).following).toBe(true);

    // Re-clicking the followed target (it fills the view) is a no-op, not a new fly-in.
    const reclick = await page.evaluate(() => {
        const g = window.__ua.globe;
        const c = g.canvas, r = c.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        g._hoveredUserData = { kind: 'sat-probe', id: 'iss' };
        c.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
        g._hoveredUserData = { kind: 'sat-probe', id: 'iss' };
        c.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
        return { flying: g._controls.isFlying(), following: g.isFollowing() };
    });
    expect(reclick).toEqual({ flying: false, following: true });

    await page.locator('#ua-globe').hover();
    await page.keyboard.press('r');
    await step(page, 120);
    s = await state();
    expect(s).toMatchObject({ following: false, mode: 'orbit' });
    expect(s.dist).toBeCloseTo(HOME, 1);
});

test('full screen is a large labelled control; F toggles it and Esc leaves', async ({ page }) => {
    await boot(page);
    const btn = page.locator('#ua-cam-immersive');
    await expect(btn).toBeVisible();
    await expect(btn).toContainText('Full screen');
    const box = await btn.boundingBox();
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(120);
    const reset = await page.locator('#ua-cam-reset').boundingBox();
    expect(box.width * box.height).toBeGreaterThan(2 * reset.width * reset.height);

    await page.keyboard.press('f');
    await expect(page.locator('#ua-globe-wrap')).toHaveClass(/ua-immersive/);
    await expect(btn).toContainText('Exit full screen');
    await expect(btn).toHaveAttribute('aria-pressed', 'true');
    const wrap = await page.locator('#ua-globe-wrap').boundingBox();
    const vp = page.viewportSize();
    expect(wrap.width).toBeGreaterThanOrEqual(vp.width - 1);
    expect(wrap.height).toBeGreaterThanOrEqual(vp.height - 1);

    await page.keyboard.press('Escape');
    await expect(page.locator('#ua-globe-wrap')).not.toHaveClass(/ua-immersive/);
    await expect(btn).toContainText('Full screen');
    // Typing into a field must not toggle it.
    await page.locator('#ua-sat-suites').scrollIntoViewIfNeeded();
    await page.evaluate(() => { const i = document.createElement('input'); i.id = '__t'; document.body.append(i); i.focus(); });
    await page.keyboard.press('f');
    await expect(page.locator('#ua-globe-wrap')).not.toHaveClass(/ua-immersive/);
});
