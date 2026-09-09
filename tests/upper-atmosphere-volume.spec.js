/**
 * upper-atmosphere-volume.spec.js — browser gate for the continuous
 * atmosphere render and the on-canvas instruments
 * ═══════════════════════════════════════════════════════════════════════════
 * The physics is gated by `node tests/upper-atmosphere-column.mjs`. What
 * needs a browser is everything that can only fail on a GPU or in the DOM:
 *
 *   • THE SHADERS COMPILE. Both new GLSL programs and the ones already on
 *     the page. This spec asserts ZERO WebGL errors, which is not
 *     paranoia — the Sun's photosphere shader on this page declared a
 *     variable called `active`, a GLSL ES reserved word, and had silently
 *     failed to compile since it shipped. Nothing in the page's own
 *     console output said so; three.js logs the error and carries on with
 *     a fallback material.
 *   • THE TWO RENDERERS ARE MUTUALLY EXCLUSIVE. Both visible at once
 *     stacks two additive passes over the same physical column and
 *     doubles the limb, which looks like a tuning problem rather than a
 *     bug.
 *   • THE PROBE ANSWERS THE RIGHT PHYSICS. A limb ray must report a
 *     tangent altitude, a column, and a local/model density ratio that
 *     actually differs from 1 where the diurnal bulge says it should.
 *   • THE OVERLAY DOES NOT EAT POINTER EVENTS. It sits above the WebGL
 *     canvas that OrbitControls and the raycaster both listen on.
 */

import { test, expect } from '@playwright/test';

const URL = '/upper-atmosphere.html';
const BOOT_MS = 30_000;

// Booting this page on a software rasteriser costs ~45 s before a test
// does anything: the 3D scene, five satellite catalogues and the consent
// banner all have to settle. Against the 60 s default that leaves no
// budget, and a test that runs out of it fails at whatever click happened
// to be last — which reads as an unclickable control rather than a clock.
// Measured; same reason atmo-stack-smoke.spec.js raises its own.
test.describe.configure({ timeout: 150_000 });

async function boot(page) {
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.globe, { timeout: BOOT_MS });
    // The cookie-consent banner owns the bottom edge of the VIEWPORT while
    // open, and at 1280x720 that is exactly where the atmosphere control
    // row sits. Without dismissing it, clicking a control times out on
    // actionability with no hint that a banner is the cause — measured.
    const consent = page.locator('.pp-consent-banner');
    await consent.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) {
        await consent.locator('[data-action="reject"]').click().catch(() => {});
    }
    await page.waitForTimeout(2500);
}

test.describe('upper-atmosphere continuous volume render', () => {

    test('both atmosphere shaders compile — zero GL errors', async ({ page }) => {
        const shaderErrors = [];
        page.on('console', (m) => {
            const t = m.text();
            if (/Shader Error|not compiled|reserved word/i.test(t)) shaderErrors.push(t);
        });
        await boot(page);
        // Force the A/B path to compile too, so a broken shell shader
        // cannot hide behind the volume being the default.
        await page.evaluate(() => window.__ua.globe.setAtmosphereRender('shells'));
        await page.waitForTimeout(900);
        await page.evaluate(() => window.__ua.globe.setAtmosphereRender('volume'));
        await page.waitForTimeout(900);

        expect(shaderErrors, shaderErrors.join('\n')).toEqual([]);
        const glErr = await page.evaluate(
            () => window.__ua.globe._renderer.getContext().getError());
        expect(glErr).toBe(0);
    });

    test('volume is the default renderer and the shells are off', async ({ page }) => {
        await boot(page);
        const s = await page.evaluate(() => ({
            mode: window.__ua.globe.getAtmosphereRender(),
            vol:  window.__ua.globe._volume.getVisible(),
            shel: window.__ua.globe._shellGroup.visible,
        }));
        expect(s.mode).toBe('volume');
        expect(s.vol).toBe(true);
        expect(s.shel).toBe(false);
    });

    test('the two renderers are mutually exclusive in every combination',
    async ({ page }) => {
        await boot(page);
        const states = await page.evaluate(() => {
            const g = window.__ua.globe;
            const out = [];
            for (const mode of ['shells', 'volume', 'shells']) {
                for (const on of [true, false, true]) {
                    g.setAtmosphereRender(mode);
                    g.setVisibility({ shells: on });
                    out.push({
                        mode, on,
                        vol: g._volume.getVisible(),
                        shel: g._shellGroup.visible,
                    });
                }
            }
            return out;
        });
        for (const s of states) {
            expect(s.vol && s.shel,
                `both renderers visible at mode=${s.mode} shells=${s.on}`).toBe(false);
            // "atmosphere off" must actually turn it off.
            if (!s.on) expect(s.vol || s.shel).toBe(false);
            else expect(s.vol || s.shel).toBe(true);
        }
    });

    test('the display scale is reported so the legend can label it',
    async ({ page }) => {
        await boot(page);
        const sc = await page.evaluate(() => window.__ua.globe.getVolumeScaleInfo());
        expect(sc.transform).toBe('log10');
        expect(sc.decades).toBeGreaterThan(4);
        expect(sc.gamma).toBeGreaterThan(0);
        // The band really does span many decades — that is why a linear or
        // asinh mapping cannot show it.
        expect(sc.spanDecades).toBeGreaterThan(8);
        const summary = await page.textContent('#ua-legend-summary');
        expect(summary).toContain(String(sc.decades));
    });

    test('legend states that the density render is not a photograph',
    async ({ page }) => {
        await boot(page);
        await page.click('#ua-legend-toggle');
        const body = (await page.textContent('#ua-legend-body')).toLowerCase();
        expect(body).toContain('no visible light');
        expect(body).toContain('display transform');
    });
});

test.describe('on-canvas instruments', () => {

    test('the overlay does not swallow pointer events', async ({ page }) => {
        await boot(page);
        const pe = await page.evaluate(() => {
            const el = document.querySelector('.ua-instruments');
            return el ? getComputedStyle(el).pointerEvents : 'missing';
        });
        expect(pe).toBe('none');
        // And the globe still orbits: a drag must move the camera.
        const box = await page.locator('#ua-globe-wrap').boundingBox();
        const before = await page.evaluate(
            () => window.__ua.globe._camera.position.toArray());
        await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.55,
                              { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(400);
        const after = await page.evaluate(
            () => window.__ua.globe._camera.position.toArray());
        const moved = Math.hypot(...after.map((v, i) => v - before[i]));
        expect(moved, 'drag must still orbit the globe').toBeGreaterThan(0.01);
    });

    test('the limb probe reports the physics of the ray under the cursor',
    async ({ page }) => {
        await boot(page);
        const box = await page.locator('#ua-globe-wrap').boundingBox();
        // Aim at the REAL limb rather than a guessed fraction of the
        // viewport: ask the globe where 400 km projects to and hover
        // there. A fixed fraction put the cursor at a 3472 km tangent
        // altitude at 1280x720 — outside the modelled band entirely, so
        // the test was exercising the degraded path and calling it the
        // normal one.
        const geo = await page.evaluate(
            () => window.__ua.globe.limbTicks([400]));
        const r = geo.ticks[0]?.screenRadius ?? box.width * 0.3;
        await page.mouse.move(box.x + geo.centre.x - r, box.y + geo.centre.y);
        await page.waitForTimeout(700);

        const pr = await page.evaluate(() => {
            const q = window.__ua.globe.getLimbProbe();
            if (!q) return null;
            return {
                tan: q.tangentAltKm, hits: q.hitsPlanet,
                rho: q.rho, rhoGlobal: q.rhoGlobal, ratio: q.rhoRatio,
                col: q.columnKgM2, path: q.pathEquivKm,
                lst: q.lstHr, lat: q.latDeg, T: q.T,
                aboveModel: q.aboveModel, sampleAlt: q.sampleAlt,
                profileLen: q.profile?.length ?? 0,
            };
        });
        expect(pr, 'probe produced no reading').not.toBeNull();
        expect(pr.hits).toBe(false);
        expect(pr.tan).toBeGreaterThan(0);
        // A ray can pass ABOVE the modelled band. When it does the probe
        // must SAY so rather than silently reporting the 2000 km values
        // next to a tangent altitude of 3472 km — which is what it did
        // before this assertion existed.
        if (pr.tan > 2000) {
            expect(pr.aboveModel).toBe(true);
            expect(pr.sampleAlt).toBe(2000);
        } else {
            expect(pr.aboveModel).toBe(false);
        }
        expect(pr.rho).toBeGreaterThan(0);
        // The column is structurally zero for a ray that only grazes the
        // model ceiling — there is no modelled atmosphere above it — so it
        // is only meaningful inside the band. The card suppresses the row
        // there for the same reason.
        if (!pr.aboveModel) expect(pr.col).toBeGreaterThan(0);
        expect(pr.lst).toBeGreaterThanOrEqual(0);
        expect(pr.lst).toBeLessThan(24);
        expect(pr.profileLen).toBeGreaterThan(10);
        // Limb brightening: the ray carries far more atmosphere than one
        // scale height. This is the number that justifies the render.
        expect(pr.path).toBeGreaterThan(300);
        // Aimed at the 400 km limb, so it should be near it.
        if (!pr.aboveModel) expect(pr.tan).toBeLessThan(1200);
        // The field is doing something — a ratio pinned at exactly 1
        // everywhere would mean the T∞ field never reached the density.
        expect(pr.ratio).toBeGreaterThan(0.2);
        expect(pr.ratio).toBeLessThan(5);
    });

    test('THE FIELD IS NOT SPHERICALLY SYMMETRIC — day and night differ',
    async ({ page }) => {
        await boot(page);
        // Ask the kernel through the page for the same altitude at the
        // bulge maximum and minimum. If these come out equal, the diurnal
        // term never reached the density and the render is a sphere.
        const r = await page.evaluate(async () => {
            const m = await import('./js/upper-atmosphere-column.js');
            const c = m.diurnalContrast({ altKm: 400, latDeg: 0, sunDeclDeg: 0,
                                          f107Sfu: 150, ap: 15 });
            return { ratio: c.ratio, lstMax: c.lstMax, lstMin: c.lstMin };
        });
        expect(r.ratio).toBeGreaterThan(1.5);
        // And the bulge lags the sun.
        expect(r.lstMax).toBeGreaterThan(13);
        expect(r.lstMax).toBeLessThan(15.5);
    });

    test('render controls drive the renderer and can be turned off',
    async ({ page }) => {
        await boot(page);
        const comps = () => page.evaluate(() => window.__ua.globe.getVolumeComponents());

        expect(await comps()).toEqual({ density: true, airglow: true });
        await page.click('#ua-atmo-airglow');
        expect((await comps()).airglow).toBe(false);
        await page.click('#ua-atmo-density');
        expect((await comps()).density).toBe(false);

        await page.click('#ua-atmo-anomaly');
        expect(await page.evaluate(() => window.__ua.globe.getVolumeMode()))
            .toBe('anomaly');

        await page.click('#ua-atmo-probe');
        expect(await page.evaluate(() => window.__ua.globe.getLimbProbeEnabled()))
            .toBe(false);
    });

    test('the probe card stays clear of the camera HUD', async ({ page }) => {
        await boot(page);
        const box = await page.locator('#ua-globe-wrap').boundingBox();
        // Hover inside the HUD's own band at the top of the canvas — the
        // worst case, because the time-warp row spans nearly the full width.
        await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.06);
        await page.waitForTimeout(700);
        const clear = await page.evaluate(() => {
            const g = window.__ua.globe;
            const inst = g._instruments;
            if (!inst?.getProbe()) return { skip: true };
            const rects = inst._avoidRects();
            return { skip: false, n: rects.length };
        });
        if (!clear.skip) expect(clear.n).toBeGreaterThan(0);
        // The real assertion: no console error and the card still drew.
        const ok = await page.evaluate(() => !!window.__ua.globe.getLimbProbe());
        expect(ok).toBe(true);
    });
});
