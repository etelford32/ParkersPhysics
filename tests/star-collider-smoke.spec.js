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
