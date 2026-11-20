/**
 * sun-cinematic.spec.js — the 2026-11 cinematic pass on sun.html
 * ═══════════════════════════════════════════════════════════════════════════
 * SUN_VISUALS_WORLD_CLASS_PLAN.md "2026-11-20". Browser half of four node
 * gates (tests/sun-limb.mjs, sun-camera.mjs, sun-flare-director.mjs,
 * sun-coronagraph.mjs): those pin the kernels, this pins that the PAGE obeys
 * them. Software GL, fixtures routed, every other host blocked.
 *
 *   1. THE LIMB. The chromosphere / transition-region shells used to draw a
 *      flat band 0.06 R☉ wide (pow(rim, n) on a DoubleSide shell). Measured on
 *      pixels: with only those two shells on, 1.03–1.05 R☉ is now sky.
 *   2. FRAMING + FLIGHTS. The Sun sits in the unobstructed rectangle at the
 *      distance the kernel derives; a hop to the far side never enters the
 *      Sun; a touch of the controls ends a flight and nothing takes the
 *      camera back; a resize does not undo the user's own zoom.
 *   3. THE CORONAGRAPH. Hidden at the disc's exposure, revealed by pulling
 *      back, and a response without the instrument header draws NOTHING.
 *   4. ONE FLARE ENTRY POINT. Unlocated ⇒ not placed. A flare reported late
 *      starts late on BOTH clocks. A replay says REPLAY.
 *   5. CINEMATIC MODE. Chrome stands down, the provenance chip does not; Esc
 *      restores the lens, the post chain and the hero pose.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as CAM from '../js/sun-camera.js';
import { simAgeFor } from '../js/sun-flare-director.js';

const PAGE = '/sun.html';
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sdo');
const MANIFEST = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

/** Fixtures for /api/solar/aia. `lasco: false` withholds the X-SOHO-Instrument header (the negative control). */
async function routeFeeds(page, { lasco = true } = {}) {
    await page.route('**/api/solar/aia*', (route) => {
        const ch = new URL(route.request().url()).searchParams.get('channel') || 'white';
        const frame = MANIFEST.frames[ch] || MANIFEST.frames.white;
        const isLasco = ch === 'c2' || ch === 'c3';
        route.fulfill({
            status: 200,
            headers: {
                'Content-Type': 'image/png', 'X-AIA-Channel': ch, 'X-AIA-Mode': 'live',
                'X-SDO-Observed-At': new Date(Date.now() - 7 * 60e3).toISOString(),
                ...(isLasco && lasco ? { 'X-SOHO-Instrument': ch } : {}),
                'Access-Control-Expose-Headers': 'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At, X-SOHO-Instrument',
            },
            body: readFileSync(join(FIXTURE_DIR, frame.file)),
        });
    });
    await page.route((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u.href), (route) => route.abort());
}

function watchErrors(page) {
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error' && /Shader Error|GLSL|ERROR: 0:|Program Info Log/i.test(m.text())) errs.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    return errs;
}

async function boot(page, { query = '', lasco = true, observed = true } = {}) {
    await page.addInitScript(() => {
        try { localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 })); } catch (e) {}
    });
    const errs = watchErrors(page);
    await routeFeeds(page, { lasco });
    await page.goto(PAGE + query);
    await page.waitForFunction(() => window.__sun && window.__sun.ready && window.__sun.frames > 5 && window.__sun.cam, null, { timeout: 60_000 });
    if (observed) await page.waitForFunction(() => window.__sun.uniforms.u_obsOn.value > 0.5, null, { timeout: 40_000 });
    return errs;
}

/** Wait until `fn` (evaluated in the page) is truthy. */
const until = (page, fn, arg, timeout = 30_000) => page.waitForFunction(fn, arg, { timeout });

test.describe('sun.html cinematic pass', () => {
    test.describe.configure({ timeout: 240_000 });

    test('THE LIMB: the chromosphere + transition region are a thin fringe, not a 0.06 R☉ band', async ({ page }) => {
        const errs = await boot(page, { query: '?observed=0&offlimb=0&coronagraph=0&prom=0', observed: false });
        // Only the two shells over the photosphere: everything else that lives
        // between 1.0 and 1.06 R☉ is switched off so the probes see THEM.
        await page.evaluate(() => {
            const off = (id) => { const el = document.getElementById(id); if (el && el.checked) el.click(); };
            for (const id of ['tog-wind', 'tog-loops', 'tog-corona', 'tog-fieldlines', 'tog-nanoflares', 'tog-prom', 'tog-cmetrain', 'tog-spots']) off(id);
            const s = window.__sun;
            s.freeze(120);
            // A long lens straight at the +x limb: ~1300 px per R☉, so 0.004 R☉ is ~5 px.
            s.cam.cancel('test');
            s.camera.position.set(0, 0, 6); s.controls.target.set(1.02, 0, 0);
            s.camera.fov = 4; s.camera.clearViewOffset(); s.camera.updateProjectionMatrix();
            s.controls.update();
        });
        await page.waitForTimeout(6000);
        const state = await page.evaluate(() => {
            const s = window.__sun;
            return { chromoSide: s.layers.chromosphere.material.side, trSide: s.layers.transition.material.side,
                     front: s.THREE.FrontSide, limbObs: s.uniforms.u_limbObs.value,
                     chromoVisible: s.layers.chromosphere.visible, trVisible: s.layers.transition.visible };
        });
        expect(state.chromoSide, 'chromosphere canvas is FrontSide').toBe(state.front);
        expect(state.trSide, 'transition-region canvas is FrontSide').toBe(state.front);
        expect(state.limbObs, 'Model mode: no observed limb, the model fringe is at full weight').toBe(0);
        expect(state.chromoVisible && state.trVisible).toBe(true);

        // Probe points along +x, at plane-of-sky radius rho, through the page's own camera.
        const probes = await page.evaluate(() => {
            const s = window.__sun, T = s.THREE, el = s.renderer.domElement, r = el.getBoundingClientRect();
            const at = (rho) => { const v = new T.Vector3(rho, 0, 0).project(s.camera); return [Math.round(r.left + (v.x * 0.5 + 0.5) * r.width), Math.round(r.top + (-v.y * 0.5 + 0.5) * r.height)]; };
            return { fringe: at(1.0025), band1: at(1.030), band2: at(1.045), sky: at(1.075) };
        });
        // Hide the DOM: page.screenshot captures the page, and a panel over a probe is not the Sun.
        await page.addStyleTag({ content: '#canvas-wrap > *:not(canvas), nav, #lsb-bar { visibility: hidden !important; }' });
        const b64 = (await page.screenshot()).toString('base64');
        const lum = await page.evaluate(async ({ b64, probes }) => {
            const img = new Image();
            await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = 'data:image/png;base64,' + b64; });
            const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
            const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
            const { data, width: W, height: H } = g.getImageData(0, 0, c.width, c.height);
            const out = {};
            for (const [k, [px, py]] of Object.entries(probes)) {
                const vals = [];
                for (let dy = -6; dy <= 6; dy++) for (let dx = -1; dx <= 1; dx++) {
                    const x = px + dx, y = py + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue;
                    const i = (y * W + x) * 4; vals.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
                }
                vals.sort((a, b) => a - b); out[k] = vals.length ? vals[vals.length >> 1] : -1;
            }
            return out;
        }, { b64, probes });
        console.log('limb luminance (0–255):', JSON.stringify(lum));
        // The fringe exists where the chromosphere is…
        expect(lum.fringe, 'a fringe is drawn just above the limb').toBeGreaterThan(lum.sky + 6);
        // …and the old band's interior is sky. The band drew the shells'
        // clamped alpha (≥ 0.45, additive) across this whole range.
        expect(lum.band1, '1.030 R☉ is not inside a flat band').toBeLessThan(lum.sky + 8);
        expect(lum.band2, '1.045 R☉ is not inside a flat band').toBeLessThan(lum.sky + 8);
        expect(lum.fringe, 'the profile falls: fringe ≫ band').toBeGreaterThan(3 * Math.max(lum.band1 - lum.sky, 1));
        expect(errs, errs.join('\n')).toEqual([]);
    });

    test('FRAMING, FLIGHTS and THE CORONAGRAPH', async ({ page }) => {
        const errs = await boot(page);
        await page.waitForTimeout(2500);        // the Sun Watch dock mounts late and re-measures the safe frame

        await test.step('the Sun sits in the unobstructed rectangle, at the kernel\'s distance, through the 30° lens', async () => {
            const st = await page.evaluate(() => {
                const s = window.__sun, T = s.THREE, el = s.renderer.domElement, r = el.getBoundingClientRect();
                const c = new T.Vector3(0, 0, 0).project(s.camera);
                const cam = s.cam.state;
                return { cam, w: r.width, h: r.height, cx: (c.x * 0.5 + 0.5) * r.width, cy: (-c.y * 0.5 + 0.5) * r.height,
                         d: s.camera.position.length(), fov: s.camera.fov };
            });
            expect(st.fov).toBe(CAM.HERO_FOV_DEG);
            expect(st.cam.userMoved).toBe(false);
            expect(st.cam.safe.w, 'chrome was measured').toBeLessThan(st.w);
            expect(Math.abs(st.cx - st.cam.safe.cx), 'Sun centre x = safe centre').toBeLessThan(2.5);
            expect(Math.abs(st.cy - st.cam.safe.cy), 'Sun centre y = safe centre').toBeLessThan(2.5);
            expect(st.d).toBeCloseTo(st.cam.heroDistance, 3);
            const diameterPx = 2 * CAM.fillAt({ fovDeg: st.fov, d: st.d }) * (st.h / 2);
            expect(diameterPx / Math.min(st.cam.safe.w, st.cam.safe.h)).toBeCloseTo(CAM.HERO_FILL, 2);
        });

        await test.step('the coronagraph is hidden at the disc\'s exposure and revealed by pulling back', async () => {
            await until(page, () => (window.__sun.coronagraph?.instruments || []).filter(i => i.drawn).length === 2);
            const near = await page.evaluate(() => ({ chip: document.getElementById('sun-provenance').textContent, gain: window.__sun.coronagraphCtl.gain, max: window.__sun.controls.maxDistance }));
            expect(near.chip, 'not listed while it is not on screen').not.toContain('LASCO');
            expect(near.gain).toBe(0);
            expect(near.max, 'there is something to zoom out to').toBe(CAM.MAX_DISTANCE_CORONAGRAPH);
            await page.evaluate(() => { const s = window.__sun; s.camera.position.setLength(24); s.controls.update(); });
            await until(page, () => document.getElementById('sun-provenance').textContent.includes('LASCO C2+C3') && window.__sun.spaceOcclusion.relax > 0.8);
            const far = await page.evaluate(() => ({ gain: window.__sun.coronagraphCtl.gain, evMax: window.__sun.post.exposure?.p?.evMax ?? window.__sun.composer.passes.find(p => p.exposure)?.exposure.p.evMax,
                visible: window.__sun.coronagraphMesh.visible, occl: window.__sun.spaceOcclusion }));
            expect(far.gain).toBeGreaterThan(0.1);
            expect(far.visible).toBe(true);
            expect(far.evMax, 'whole Sun in view ⇒ the exposure ceiling is +1.5 EV, not +4').toBeCloseTo(1.5, 5);
            expect(far.occl.sunR, 'the vignette\'s zones follow the Sun\'s projected radius').toBeCloseTo(
                Math.tan(Math.asin(1 / 24)) / (2 * Math.tan(CAM.HERO_FOV_DEG * CAM.DEG / 2)), 4);
        });

        await test.step('a hop to the far side goes ROUND the Sun, and a touch of the controls ends it', async () => {
            await page.evaluate(() => { const s = window.__sun; s.camera.position.setLength(3.2); s.controls.update(); });
            // Record the camera's distance on every frame of a flight to a region 170° away.
            const minR = await page.evaluate(() => new Promise((done) => {
                const s = window.__sun; let m = Infinity, n = 0;
                const to = { az: 170 * Math.PI / 180, el: 0.1, r: 3.0, target: [0, 0, 0], fov: 30 };
                s.cam.fly([{ t: 0, pose: s.cam.pose() }, { t: 2.5, pose: to }], { name: 'test-hop' });
                (function step() { m = Math.min(m, s.camera.position.length()); n++; if (s.cam.state.flying) requestAnimationFrame(step); else done({ m, n, az: Math.atan2(s.camera.position.x, s.camera.position.z) }); })();
            }));
            expect(minR.n).toBeGreaterThan(2);
            expect(minR.m, 'never closer than the nearer endpoint').toBeGreaterThanOrEqual(3.0 - 1e-6);
            expect(Math.abs(minR.az - 170 * Math.PI / 180)).toBeLessThan(1e-3);

            // Start a long flight, then press on the canvas: OrbitControls fires 'start'.
            await page.evaluate(() => window.__sun.cam.playShot('orbit'));
            expect(await page.evaluate(() => window.__sun.cam.state.flying)).toBe(true);
            const box = await page.locator('#canvas-wrap canvas').boundingBox();
            await page.mouse.move(box.x + box.width * 0.72, box.y + box.height * 0.5);
            await page.mouse.down(); await page.mouse.up();
            await until(page, () => !window.__sun.cam.state.flying);
            const a = await page.evaluate(() => window.__sun.camera.position.toArray());
            await page.waitForTimeout(1500);
            const b = await page.evaluate(() => ({ p: window.__sun.camera.position.toArray(), moved: window.__sun.cam.state.userMoved }));
            expect(Math.hypot(a[0] - b.p[0], a[1] - b.p[1], a[2] - b.p[2]), 'nothing takes the camera back').toBeLessThan(0.02);
            expect(b.moved).toBe(true);
        });

        await test.step('a resize re-measures the frame but does not undo the user\'s zoom', async () => {
            const before = await page.evaluate(() => window.__sun.camera.position.length());
            await page.setViewportSize({ width: 1100, height: 760 });
            await page.waitForTimeout(1500);
            const after = await page.evaluate(() => ({ d: window.__sun.camera.position.length(), safe: window.__sun.cam.state.safe }));
            expect(after.d).toBeCloseTo(before, 3);
            expect(after.safe.w).toBeLessThanOrEqual(1100);
        });
        expect(errs, errs.join('\n')).toEqual([]);
    });

    test('NEGATIVE CONTROL: a LASCO response without the instrument header draws nothing', async ({ page }) => {
        await boot(page, { lasco: false });
        await page.evaluate(() => { const s = window.__sun; s.camera.position.setLength(24); s.controls.update(); });
        await page.waitForTimeout(6000);
        const st = await page.evaluate(() => ({ c: window.__sun.coronagraph, chip: document.getElementById('sun-provenance').textContent,
            visible: window.__sun.coronagraphMesh?.visible, max: window.__sun.controls.maxDistance, relax: window.__sun.spaceOcclusion.relax }));
        expect(st.c.instruments.some(i => i.drawn), 'no frame is accepted').toBe(false);
        expect(st.visible).toBe(false);
        expect(st.chip).not.toContain('C2+C3');
        expect(st.relax, 'nothing observed out there ⇒ the vignette is not relaxed').toBeLessThan(0.05);
        expect(st.max, 'and the zoom range is not extended to an empty sky').toBeLessThanOrEqual(CAM.MAX_DISTANCE);
    });

    test('ONE FLARE ENTRY POINT, and CINEMATIC MODE', async ({ page }) => {
        const errs = await boot(page);

        await test.step('an unlocated flare is never placed', async () => {
            const r = await page.evaluate(() => ({ site: window.__sun.playFlare({ cls: 'X9.3', time: new Date().toISOString() }), ev: window.__sun.flareEvent }));
            expect(r.site).toBeNull();
            expect(r.ev).toBeNull();
        });

        await test.step('a flare reported 20 minutes late starts 20 minutes in — on both clocks', async () => {
            const r = await page.evaluate(() => {
                const s = window.__sun;
                const site = s.playFlare({ flrID: 'TEST-FLR-1', classType: 'M5.2', sourceLocation: 'N14W28', activeRegionNum: 14321,
                    beginTime: new Date(Date.now() - 20 * 60e3).toISOString(), peakTime: new Date(Date.now() - 12 * 60e3).toISOString() });
                return { site, ev: s.flareEvent, t: s.uniforms.u_flare_t.value, dem: s.flareDem, geo: s.flareGeometry.arcadeSite };
            });
            expect(r.site.latDeg).toBeCloseTo(14, 6);
            expect(r.ev.source).toBe('NASA DONKI');
            expect(r.ev.elapsedS, 'cooling clock').toBeGreaterThan(1195);
            expect(r.ev.elapsedS).toBeLessThan(1260);
            expect(r.t, 'ribbon clock').toBeGreaterThan(simAgeFor(1195) - 1);
            expect(r.t).toBeLessThan(simAgeFor(1260) + 5);
            expect(r.ev.replay).toBe(false);
            expect(r.geo.cls).toBe('M');
            // Twenty minutes in, the plasma is past its hot phase.
            expect(['cooling', 'arcade']).toContain(r.ev.phase.id);
            await until(page, () => !document.getElementById('flare-caption').hidden);
            const cap = await page.locator('#flare-caption .fc-text').textContent();
            expect(cap).toContain('M5.2 flare · N14W28 · AR 14321 · NASA DONKI');
            expect(cap).toMatch(/T\+2[01]:\d\d/);
            expect(cap).not.toContain('REPLAY');
        });

        await test.step('a replay starts at onset and says so', async () => {
            const r = await page.evaluate(() => {
                const s = window.__sun;
                s.playFlare({ flrID: 'TEST-FLR-1', classType: 'M5.2', sourceLocation: 'N14W28', beginTime: new Date(Date.now() - 20 * 60e3).toISOString() }, { fromOnset: true, rate: 40 });
                return { ev: s.flareEvent, t: s.uniforms.u_flare_t.value };
            });
            expect(r.ev.replay).toBe(true);
            expect(r.ev.rate).toBe(40);
            expect(r.ev.elapsedS).toBeLessThan(60);
            expect(r.t).toBeLessThan(simAgeFor(60));
            await until(page, () => /REPLAY/.test(document.querySelector('#flare-caption .fc-text').textContent));
            expect(await page.locator('#flare-caption .fc-text').textContent()).toContain('×40 time');
        });

        await test.step('Cinematic: the chrome stands down, the provenance chip does not', async () => {
            await page.locator('#btn-cine').click();
            await until(page, () => document.body.classList.contains('sun-cine') && window.__sun.cam.state.cine.on);
            const on = await page.evaluate(() => {
                const vis = (sel) => { const el = document.querySelector(sel); if (!el) return null; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden'; };
                const s = window.__sun;
                return { hud: vis('#hud'), dock: vis('#sun-watch-dock'), chip: vis('#sun-provenance'), cineHud: vis('#cine-hud'),
                         shot: document.getElementById('cine-shot').textContent, lens: s.post.state.lens, cine: s.cam.state.cine,
                         view: s.cam.state.view, chipText: document.getElementById('sun-provenance').textContent };
            });
            expect(on.hud).toBe(false);
            expect(on.dock === false || on.dock === null).toBe(true);
            expect(on.chip, 'observed vs model stays on screen in every mode').toBe(true);
            expect(on.chipText).toMatch(/OBSERVED|MODEL/);
            expect(on.cineHud).toBe(true);
            expect(on.shot.length).toBeGreaterThan(3);
            expect(on.lens, 'the Phase 2 lens is on in the cinematic paths').toBe(true);
            expect(on.cine.order[0]).toBe('approach');
            expect(on.cine.order, 'a flare is on screen, so it is in the running order').toContain('flare');
        });

        await test.step('any touch pauses the sequence; Esc restores the page', async () => {
            const box = await page.locator('#canvas-wrap canvas').boundingBox();
            await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
            await page.mouse.down(); await page.mouse.up();
            await until(page, () => window.__sun.cam.state.cine.paused && !window.__sun.cam.state.flying);
            await page.keyboard.press('Escape');
            await until(page, () => !document.body.classList.contains('sun-cine'));
            await until(page, () => !window.__sun.cam.state.flying, null, 40_000);
            const off = await page.evaluate(() => {
                const s = window.__sun;
                return { lens: s.post.state.lens, fov: s.camera.fov, d: s.camera.position.length(), hero: s.cam.state.heroDistance,
                         tgt: s.controls.target.length(), hudShown: getComputedStyle(document.getElementById('hud')).display !== 'none' };
            });
            expect(off.lens).toBe(false);
            expect(off.fov).toBeCloseTo(CAM.HERO_FOV_DEG, 5);
            expect(off.tgt).toBeLessThan(1e-6);
            expect(off.d).toBeCloseTo(off.hero, 2);
            expect(off.hudShown).toBe(true);
        });
        expect(errs, errs.join('\n')).toEqual([]);
    });
});
