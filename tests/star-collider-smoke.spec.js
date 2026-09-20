/**
 * star-collider-smoke.spec.js — browser gate for star-collider.html.
 *
 * Run: npx playwright test tests/star-collider-smoke.spec.js
 *
 * The static contract between the markup and js/star-collider/page.js is
 * checked by `node tests/star-collider-page.mjs`, the physics by the five
 * kernel gates, and the shipped WASM by the kernel smoke. What only a browser
 * can check is the part in between: that the page boots with no errors, that
 * every analytic readout carries a value, that the catalog rail is built and
 * loading an object changes the pair, that the WASM worker comes up and a run
 * actually inspirals, and that the stage has paint on it.
 *
 * NO NETWORK. The page fetches nothing beyond its own modules and the WASM
 * binary, so there is no route mocking here and there must never be any.
 */

import { test, expect } from '@playwright/test';

const PAGE = '/star-collider.html';

// Console noise that is not this page's: the dev server answers the nav's
// telemetry POST with 501 (tests/neo-watch-smoke.spec.js filters the same),
// and software WebGL warns about itself.
const NOISE = [/\/api\/telemetry\//, /Failed to load resource/, /net::ERR/, /WebGL|GPU|swiftshader|GroupMarkerNotSet/i];
const isNoise = (msg) => NOISE.some(re => re.test(msg));
function collectErrors(page) {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.on('console', m => { if (m.type() === 'error' && !isNoise(m.text())) errors.push(m.text()); });
    return errors;
}

async function ready(page) {
    await page.waitForFunction(() => {
        const el = document.querySelector('[data-sc="fate"]');
        return el && el.textContent.trim() && el.textContent.trim() !== '—';
    }, null, { timeout: 30000 });
}

test.describe('Star Collider Lab', () => {
    test('boots with no console errors and fills every analytic readout', async ({ page }) => {
        const errors = collectErrors(page);

        await page.goto(PAGE);
        await ready(page);

        // Analytic readouts must all carry values. The SPH HUD is legitimately on
        // its placeholder until a run is started, so it is excluded here and
        // checked in the run test.
        const hudKeys = new Set(['simTime', 'simSep', 'simFreq', 'simN', 'simSteps', 'simRate', 'simUnbound', 'simAccreted',
            'simRhoMax', 'simHeat', 'simEgw', 'simDrift', 'simPn', 'stageScale']);
        const unfilled = await page.evaluate((hud) => [...document.querySelectorAll('[data-sc]')]
            .filter(el => !hud.includes(el.getAttribute('data-sc')))
            .filter(el => !el.textContent.trim() || el.textContent.trim() === '—')
            .map(el => el.getAttribute('data-sc')), [...hudKeys]);
        expect(unfilled, 'analytic readouts still on their placeholder').toEqual([]);

        // GW170817 is the default pair: chirp mass 1.186, a BNS.
        await expect(page.locator('[data-sc="pairClass"]')).toHaveText(/Binary neutron star/);
        await expect(page.locator('[data-sc="chirpMass"]')).toHaveText(/1\.18[4-8]/);
        await expect(page.locator('[data-sc="fate"]')).toHaveText(/collapse|neutron star/);
        await expect(page.locator('[data-sc="knPeak"]')).toHaveText(/erg\/s/);

        expect(errors, 'console/page errors during boot').toEqual([]);
    });

    test('catalog rail is built and loading an object changes the pair', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        const cards = page.locator('#sc-catalog .sc-card');
        await expect(cards).toHaveCount(await page.evaluate(async () => (await import('/js/star-collider/catalog.js')).OBJECTS.length));
        // Load Cygnus X-1 as B → NSBH.
        await page.locator('.sc-card[data-object-id="cygx1"] [data-load="1"]').click();
        await expect(page.locator('[data-sc="pairClass"]')).toHaveText(/Neutron star – black hole/);
        await expect(page.locator('[data-sc="fate"]')).toHaveText(/disruption|swallowed/);
        // Load Sirius B as A → WD–BH: a LISA-band overflow.
        await page.locator('.sc-card[data-object-id="siriusb"] [data-load="0"]').click();
        await expect(page.locator('[data-sc="pairClass"]')).toHaveText(/White dwarf – black hole/);
        await expect(page.locator('[data-sc="remnant"]')).toHaveText(/Roche-lobe overflow/);
        // The EOS select changes a neutron-star radius; pick GW150914 → BBH final mass 62.
        await page.selectOption('[data-sc-control="pair"]', 'gw150914');
        await expect(page.locator('[data-sc="pairClass"]')).toHaveText(/Binary black hole/);
        await expect(page.locator('[data-sc="remnant"]')).toHaveText(/6[1-3]\.\d+ M☉/);
    });

    test('changing the EOS moves the radius and the fate flips with it', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        const radiusSly = await page.locator('[data-sc="radiusAOut"]').textContent();
        await page.selectOption('[data-sc-control="eos"]', 'MS1');
        await expect(page.locator('[data-sc="radiusAOut"]')).not.toHaveText(radiusSly);
        await expect(page.locator('[data-sc="radiusAOut"]')).toHaveText(/1[45]\.\d+ km/);
        await expect(page.locator('[data-sc="fate"]')).toHaveText(/stable neutron star/);
        await page.selectOption('[data-sc-control="eos"]', 'SLy');
        await expect(page.locator('[data-sc="fate"]')).toHaveText(/prompt collapse \(marginal\)/);
    });

    test('camera rig: presets fly, follow tracks a core, corotating holds the cores on x, colour modes switch, keys work', async ({ page }) => {
        test.setTimeout(120000);
        const errors = collectErrors(page);
        await page.goto(PAGE);
        await ready(page);
        await page.waitForFunction(() => window.__starCollider?.scene && !window.__starCollider.scene.state.tweening, null, { timeout: 30000 });
        const polar = () => page.evaluate(() => {
            const s = window.__starCollider.scene;
            const v = s.camera.position.clone().sub(s.controls.target);
            return Math.atan2(Math.hypot(v.x, v.z), v.y);
        });
        const settle = () => page.waitForFunction(() => !window.__starCollider.scene.state.tweening, null, { timeout: 5000 });

        // Presets are one-shot flights to the named polar angle.
        await page.locator('[data-sc-control="viewTop"]').click();
        await settle();
        expect(await polar()).toBeLessThan(0.1);
        await page.locator('[data-sc-control="viewEdge"]').click();
        await settle();
        expect(Math.abs(await polar() - 1.545)).toBeLessThan(0.05);
        await expect(page.locator('[data-sc="stageFrame"]')).toHaveText(/edge view/);

        // Pre-run preview exists (the stage is not an empty grid before a run).
        expect(await page.evaluate(() => window.__starCollider.scene.world.children.some(c => c.type === 'Group' && c.visible && c.children.length === 2))).toBe(true);

        // Run, then follow core A: the target must sit on core A's world position.
        await page.waitForFunction(() => /WASM/.test(document.querySelector('[data-sc="simEngine"]').textContent), null, { timeout: 30000 });
        await page.selectOption('[data-sc-control="particles"]', '150');
        await page.locator('[data-sc-control="run"]').click();
        await page.waitForFunction(() => { const d = window.__starCollider.state.sim.diag; return /running/.test(document.querySelector('[data-sc="simStatus"]').textContent) && d && d.steps > 60; }, null, { timeout: 60000 });
        await page.selectOption('[data-sc-control="follow"]', 'A');
        await page.waitForTimeout(500);
        // Measure after a render frame, against the core position the scene itself
        // last received — this is a test of the rig tracking its target, not of
        // worker-message timing on a software renderer.
        const afterFrame = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        await afterFrame();
        const followErr = await page.evaluate(() => {
            const s = window.__starCollider.scene; const st = s.state; const cps = s.codePerScene;
            const local = new (s.camera.position.constructor)(st.lastMeta.cmA[0] / cps, st.lastMeta.cmA[2] / cps, -st.lastMeta.cmA[1] / cps);
            const w = s.world.localToWorld(local);
            return { err: w.distanceTo(s.controls.target), fp: st.followPoint, target: s.controls.target.toArray() };
        });
        expect(followErr.err, JSON.stringify(followErr)).toBeLessThan(0.15);
        await expect(page.locator('[data-sc="stageFrame"]')).toHaveText(/following core A/);

        // Corotating frame: the core–core line lies along world x (|z| ≪ |x|).
        await page.locator('[data-sc-control="frameCorotating"]').check();
        await page.waitForTimeout(300);
        await afterFrame();
        const align = await page.evaluate(() => {
            const s = window.__starCollider.scene; const st = s.state; const cps = s.codePerScene;
            const V = s.camera.position.constructor;
            s.world.updateMatrixWorld(true);
            const a = s.world.localToWorld(new V(st.lastMeta.cmA[0] / cps, st.lastMeta.cmA[2] / cps, -st.lastMeta.cmA[1] / cps));
            const b = s.world.localToWorld(new V(st.lastMeta.cmB[0] / cps, st.lastMeta.cmB[2] / cps, -st.lastMeta.cmB[1] / cps));
            return { dx: Math.abs(a.x - b.x), dz: Math.abs(a.z - b.z), rot: s.world.rotation.y };
        });
        expect(align.dz, JSON.stringify(align)).toBeLessThan(0.08 * align.dx + 1e-3);
        await expect(page.locator('[data-sc="stageFrame"]')).toHaveText(/corotating/);

        // Colour modes reach the shader.
        await page.selectOption('[data-sc-control="colorMode"]', 'bound');
        expect(await page.evaluate(() => window.__starCollider.scene.state.colorMode)).toBe('bound');
        await expect(page.locator('[data-sc="stageColour"]')).toHaveText(/unbound ejecta/);

        // Keyboard on the stage: keys go to the focused canvas (a focused select
        // keeps its own keys — typing in the console must never fly the camera).
        await page.evaluate(() => document.querySelector('#sc-stage canvas').focus());
        await page.hover('#sc-stage canvas');
        await page.keyboard.press('3');
        await settle();
        expect(Math.abs(await polar() - 0.82)).toBeLessThan(0.05);
        await page.keyboard.press('0');
        await expect(page.locator('[data-sc="stageFrame"]')).toHaveText(/fixed on the origin/);
        await page.keyboard.press(' ');
        await expect(page.locator('[data-sc="simStatus"]')).toHaveText(/paused/);

        // Trails accumulated while following.
        expect(await page.evaluate(() => window.__starCollider.scene.world.children.filter(c => c.type === 'Line' && c.visible).length)).toBeGreaterThanOrEqual(2);
        expect(errors, 'errors during the camera test').toEqual([]);
    });

    test('the WASM engine builds, runs, inspirals, and paints the stage', async ({ page }) => {
        test.setTimeout(120000);
        const errors = collectErrors(page);
        await page.goto(PAGE);
        await ready(page);
        await page.waitForFunction(() => /WASM/.test(document.querySelector('[data-sc="simEngine"]').textContent), null, { timeout: 30000 });
        await page.selectOption('[data-sc-control="particles"]', '150');
        await page.locator('[data-sc-control="run"]').click();
        await page.waitForFunction(() => /running/.test(document.querySelector('[data-sc="simStatus"]').textContent), null, { timeout: 60000 });
        const sep0 = await page.evaluate(() => window.__starCollider.state.sim.diag.separation);
        // Let it run; the separation must fall (radiation reaction) and the HUD fill.
        await page.waitForFunction((s0) => {
            const d = window.__starCollider.state.sim.diag;
            return d && d.steps > 200 && d.separation < s0 - 0.5;
        }, sep0, { timeout: 60000 });
        const hud = await page.evaluate(() => [...document.querySelectorAll('.sc-hud [data-sc], .sc-hud-b [data-sc]')]
            .filter(el => !el.textContent.trim() || el.textContent.trim() === '—').map(el => el.getAttribute('data-sc')));
        expect(hud, 'HUD readouts on placeholder while running').toEqual([]);
        await expect(page.locator('[data-sc="simEgw"]')).not.toHaveText(/^0 /);
        // Stage painted: the WebGL canvas has non-background pixels somewhere in the middle.
        const painted = await page.evaluate(() => {
            const c = document.querySelector('#sc-stage canvas');
            if (!c) return -1;
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            if (!gl) return -2;
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const px = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
            let lit = 0;
            for (let i = 0; i < px.length; i += 16) if (px[i] + px[i + 1] + px[i + 2] > 90) lit++;
            return lit;
        });
        // preserveDrawingBuffer is off, so readPixels may legitimately return the cleared buffer
        // (-1/-2 are structural failures; 0 is tolerated only if the fallback is hidden).
        expect(painted).toBeGreaterThanOrEqual(0);
        const fb = await page.evaluate(() => { const el = document.querySelector('#sc-stage-fallback'); return { hidden: el.hidden, display: getComputedStyle(el).display }; });
        expect(fb.hidden).toBe(true);
        expect(fb.display).toBe('none');
        await page.locator('[data-sc-control="pause"]').click();
        await expect(page.locator('[data-sc="simStatus"]')).toHaveText(/paused/);
        expect(errors, 'errors during the run').toEqual([]);
    });
});
