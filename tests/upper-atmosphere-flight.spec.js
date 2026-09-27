/**
 * upper-atmosphere-flight.spec.js — browser gate for the flight layer,
 * the flight deck, the launch panel, and the page's ONE longitude frame
 * ═══════════════════════════════════════════════════════════════════════════
 * The physics is gated in node (`tests/upper-atmosphere-flight.mjs`). What
 * needs a browser:
 *
 *   • THE RIBBON SHADER COMPILES and draws (zero GL errors — the page's own
 *     Sun shader once shipped on a fallback material for months).
 *   • THE FRAME IS THE CANONICAL ONE. The globe's sun vector, the flight's
 *     launch point and the reference probes' orbit paths must all sit in
 *     the js/geo/coords.js frame the Earth texture is drawn in (+90°E at
 *     −Z), turned by the sidereal angle of the sim clock. Until 2026-09-27
 *     the sun was mirrored in longitude and the probes were never turned.
 *   • THE DECK'S TWO CLOCKS. Detaching to the deck's transport moves the
 *     head, pins the scene's instant, and LIVE re-locks it.
 *   • THE PANEL'S PICK-SITE CLICK goes through the globe's own click hook
 *     and probeScreenRay, not a second raycaster.
 *   • THE CHASE CAMERA CLOSES on the probe — the controls used to be fed a
 *     ~0 dt every frame and the follow spring never moved.
 */

import { test, expect } from '@playwright/test';

const URL = '/upper-atmosphere.html';
const BOOT_MS = 30_000;
test.describe.configure({ timeout: 150_000 });

async function boot(page) {
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.flight?.layer, { timeout: BOOT_MS });
    const consent = page.locator('.pp-consent-banner');
    await consent.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) {
        await consent.locator('[data-action="reject"]').click().catch(() => {});
    }
    await page.waitForTimeout(2000);
}

function glErrorRecorder(page) {
    const errs = [];
    page.on('console', (m) => {
        const t = m.text();
        if (/Shader Error|not compiled|reserved word|Program Info Log/i.test(t)) errs.push(t);
    });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    return errs;
}

test.describe('upper-atmosphere flight dynamics', () => {

    test('capsule preset: ribbon draws, deck reads the kernel, frame is canonical', async ({ page }) => {
        const errs = glErrorRecorder(page);
        await boot(page);

        const r = await page.evaluate(async () => {
            const g = window.__ua.globe;
            const [col, sun] = await Promise.all([
                import('/js/upper-atmosphere-column.js'), import('/js/sun-altitude.js')]);
            const f = g.launchPreset('capsule');
            f.run();                                   // finish integrating now
            await new Promise(r => setTimeout(r, 1800));
            const layer = g.getFlightLayer();
            const deck = document.getElementById('ua-flight-deck');
            const txt = deck.innerText;
            // Launch point over the preset's site, in the canonical frame.
            const p0 = f.sceneAt(0);
            const want = col.latLonToScene(25, -140).map(v => v * (1 + 120 / 6371));
            // The globe's sun vector is latLonToScene(subSolarPoint(scene time)).
            const ssp = sun.subSolarPoint(new Date(g.getSceneTimeMs()));
            const wantSun = col.latLonToScene(ssp.lat, ssp.lon);
            return {
                status: f.status, n: f.n, tEnd: f.tEndS,
                draw: layer._ribbonGeo.drawRange.count,
                headVisible: layer._head.visible,
                deckHidden: deck.hidden, txt,
                statusPill: deck.querySelector('[data-f=status]').textContent,
                launchErr: Math.max(...p0.map((v, i) => Math.abs(v - want[i]))),
                sunErr: Math.max(...g._sunDir.toArray().map((v, i) => Math.abs(v - wantSun[i]))),
                gl: g._renderer.getContext().getError(),
            };
        });
        expect(r.status).toBe('floor');
        expect(r.n).toBeGreaterThan(50);
        expect(r.draw).toBeGreaterThan(100);
        expect(r.headVisible).toBe(true);
        expect(r.deckHidden).toBe(false);
        expect(r.statusPill).toBe('floor');
        // Real numbers, not placeholders.
        expect(r.txt).toMatch(/altitude\s+\d+(\.\d+)? km/);
        expect(r.txt).toMatch(/\|v\| inertial\s+7\.\d+ km\/s/);
        expect(r.txt).toMatch(/q = ½ρv²\s+[\d.e+-]+ (mPa|Pa)/);
        expect(r.txt).toMatch(/heating\*/);
        expect(r.txt).toMatch(/Sutton–Graves/);
        expect(r.txt).toMatch(/reached the 80 km model floor/);
        expect(r.launchErr).toBeLessThan(1e-6);
        // The vector is refreshed per frame from the bus; sampling the clock a
        // few hundred ms later costs ~2e-5 rad (15°/h). 1e-3 rad still catches
        // the mirror (which is ~1 rad off at most hours of the day).
        expect(r.sunErr).toBeLessThan(1e-3);
        expect(r.gl).toBe(0);
        expect(errs, errs.join('\n')).toEqual([]);
    });

    test('the deck transport detaches the clock, pins the scene instant, scrubs, and LIVE re-locks; probes are Earth-fixed', async ({ page }) => {
        await boot(page);
        const r = await page.evaluate(async () => {
            const g = window.__ua.globe;
            const sun = await import('/js/sun-altitude.js');
            const f = g.launchPreset('iss');
            const layer = g.getFlightLayer();
            const t0 = performance.now();
            while (!f.done && performance.now() - t0 < 6000) f.step({ maxSteps: 4000 });
            await new Promise(r => setTimeout(r, 400));
            const live0 = layer.getClock();
            // Detach: 600× for ~1.2 s of wall time.
            layer.setRate(600); layer.play();
            await new Promise(r => setTimeout(r, 1200));
            const warped = layer.getClock();
            const pinned = { sceneMs: layer.getSceneTimeMs(), override: g._sceneTimeOverrideMs, globeSceneMs: g.getSceneTimeMs() };
            // Scrub to the middle through the deck's slider.
            const slider = document.querySelector('#ua-flight-deck .ua-fd-scrub');
            slider.value = '500'; slider.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 300));
            const scrubbed = layer.getClock();
            const headMid = layer.getHeadPosition().clone();
            // LIVE re-locks and releases the scene clock.
            document.querySelector('#ua-flight-deck [data-act=live]').click();
            await new Promise(r => setTimeout(r, 300));
            const relocked = layer.getClock();
            const released = g._sceneTimeOverrideMs;
            // Reference probes: the orbit-path loop is turned by −GMST(sim time).
            const probe = g._satProbes.iss;
            const gmst = sun.greenwichSiderealDeg(g._timeBus.getSimTime()) * Math.PI / 180;
            let dRot = probe.pathLine.rotation.y + gmst;
            dRot = Math.atan2(Math.sin(dRot), Math.cos(dRot));
            return { live0, warped, pinned, scrubbed, headMid: headMid.toArray(), relocked, released, dRot, tEnd: f.tEndS, done: f.done };
        });
        expect(r.live0.mode).toBe('live');
        expect(r.warped.mode).toBe('own');
        expect(r.warped.tS).toBeGreaterThan(300);
        expect(Number.isFinite(r.pinned.sceneMs)).toBe(true);
        expect(r.pinned.override).toBe(r.pinned.sceneMs);
        expect(r.pinned.globeSceneMs).toBe(r.pinned.sceneMs);
        expect(Math.abs(r.scrubbed.tS - 0.5 * r.tEnd)).toBeLessThan(0.02 * r.tEnd + 60);
        expect(r.relocked.mode).toBe('live');
        expect(r.released).toBeNull();
        expect(Math.abs(r.dRot)).toBeLessThan(1e-6);
    });

    test('launch panel: pick a site on the planet, launch a custom probe, chase it', async ({ page }) => {
        await boot(page);
        // Open the custom launch, arm the picker, click the centre of the disc.
        await page.locator('#ua-flight-panel .ua-fp-custom summary').click();
        await page.locator('#ua-flight-panel .ua-fp-pick').click();
        // Opening the panel scrolls the page; the sticky globe can sit a
        // thousand pixels above the viewport and a click at its box lands
        // on nothing (measured: box.y = −1035). Bring it back first.
        await page.locator('#ua-globe').scrollIntoViewIfNeeded();
        await page.waitForTimeout(300);
        const box = await page.locator('#ua-globe').boundingBox();
        expect(box.y).toBeGreaterThanOrEqual(0);
        await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
        await page.waitForTimeout(300);
        const picked = await page.evaluate(() => ({
            lat: Number(document.querySelector('#ua-fp-latDeg').value),
            lon: Number(document.querySelector('#ua-fp-lonDeg').value),
            armed: document.querySelector('#ua-flight-panel .ua-fp-pick').classList.contains('ua-chip--on'),
        }));
        // The default camera looks at the eastern Pacific side of the disc
        // (+Z = 90°W in the canonical frame); the exact point depends on the
        // framing, so gate the frame, not the number: a lon in the western
        // hemisphere and not the panel's −60 default.
        expect(picked.armed).toBe(false);
        expect(picked.lon).toBeLessThan(-30);
        expect(picked.lon).not.toBe(-60);
        expect(Math.abs(picked.lat)).toBeLessThan(60);

        await page.locator('#ua-flight-panel .ua-fp-launch').click();
        await page.waitForTimeout(1200);
        const r = await page.evaluate(async () => {
            const g = window.__ua.globe;
            const layer = g.getFlightLayer();
            const f = layer.getFlight();
            const m = f.meta.launch;
            // Chase: the controls now get a real dt, so the spring closes.
            g.followFlight();
            await new Promise(r => setTimeout(r, 2500));
            const dist = g._camera.position.distanceTo(layer.getHeadPosition());
            return { name: f.name, lat: m.latDeg, lon: m.lonDeg, following: g.getFollowTarget()?.kind, dist,
                     mode: g.getCameraMode() };
        });
        expect(r.name).toBe('custom probe');
        expect(r.lat).toBe(picked.lat);
        expect(r.lon).toBe(picked.lon);
        expect(r.following).toBe('flight');
        expect(r.mode).toBe('fly');
        expect(r.dist).toBeLessThan(0.35);
    });
});
