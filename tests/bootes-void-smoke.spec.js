/**
 * bootes-void-smoke.spec.js — browser gate for bootes-void.html.
 *
 * Run: npx playwright test tests/bootes-void-smoke.spec.js
 *
 * The static contract between the markup and js/bootes/page.js is checked by
 * `node tests/bootes-void-page.mjs`, and the physics by the two kernel gates.
 * What only a browser can check is the part in between: that the page actually
 * boots, that every readout ends up carrying a value instead of its placeholder,
 * that the canvases have paint on them, and that moving a control moves the
 * numbers it is supposed to move.
 *
 * NO NETWORK. The page fetches nothing — every input is either a literal in
 * js/bootes-void-data.js or computed — so this spec needs no route mocking and
 * must never grow any. If a future edit makes this page fetch, that is a change
 * to its provenance story and belongs in data/bootes/SOURCES.md first.
 */

import { test, expect } from '@playwright/test';

const PAGE = '/bootes-void.html';

/**
 * Bring the stage into the viewport and stop the auto-rotate.
 *
 * BOTH HALVES ARE LOAD-BEARING FOR MOUSE TESTS. `boundingBox()` returns
 * VIEWPORT-relative coordinates, and the stage sits below the fold at the
 * default scroll — so a drag driven from an unscrolled box lands on empty page
 * and the test fails claiming the camera ignored it. And auto-rotate moves the
 * camera underneath any pose assertion.
 */
async function stageReady(page) {
    await page.evaluate(() => {
        document.querySelector('.bv-stage-grid').scrollIntoView({ block: 'center' });
        const rot = document.querySelector('[data-bv-control="autorotate"]');
        if (rot.checked) rot.click();
        document.activeElement?.blur?.();
    });
    await page.waitForTimeout(400);
}

/** Wait for the first recompute to land — the mass deficit is the last thing written. */
async function ready(page) {
    await page.waitForFunction(() => {
        const el = document.querySelector('[data-bv="massDeficit"]');
        return el && el.textContent.trim() && el.textContent.trim() !== '—';
    }, null, { timeout: 20000 });
}

test.describe('Boötes Void', () => {
    test('boots with no console errors and fills every readout', async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(String(e)));
        page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

        await page.goto(PAGE);
        await ready(page);

        // Every VISIBLE data-bv element must carry a real value. An em-dash left
        // behind reads as "not available" rather than "never wired", which is the
        // whole failure mode the DOM contract exists to prevent.
        //
        // Readouts inside a [hidden] container are excluded: the focus chip is
        // legitimately empty until somebody focuses a cluster, and asserting on
        // it would force a placeholder that means nothing.
        const unfilled = await page.evaluate(() => [...document.querySelectorAll('[data-bv]')]
            .filter(el => !el.closest('[hidden]'))
            .filter(el => !el.textContent.trim() || el.textContent.trim() === '—')
            .map(el => el.getAttribute('data-bv')));
        expect(unfilled, 'readouts still on their placeholder').toEqual([]);

        expect(errors, 'console/page errors during boot').toEqual([]);
    });

    test('the stage renders and the fallback stays hidden', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);

        const stage = page.locator('#bv-stage');
        await expect(stage).toBeVisible();

        // The fallback must be BOTH hidden-attributed and computed display:none.
        // An author `display:flex` on an id beats the UA sheet's
        // [hidden]{display:none}, and the message rendered straight through a
        // working canvas until the explicit rule was added. Checking `.hidden`
        // alone would have passed on the broken build.
        const fb = await page.evaluate(() => {
            const el = document.querySelector('#bv-stage-fallback');
            return { hidden: el.hidden, display: getComputedStyle(el).display };
        });
        expect(fb.hidden).toBe(true);
        expect(fb.display, 'the [hidden] rule must actually take effect').toBe('none');

        // The GL context exists and the canvas has non-zero size.
        const gl = await page.evaluate(() => {
            const c = document.querySelector('#bv-stage');
            return { w: c.width, h: c.height, ctx: !!(c.getContext('webgl2') || c.getContext('webgl')) };
        });
        expect(gl.ctx).toBe(true);
        expect(gl.w).toBeGreaterThan(100);
        expect(gl.h).toBeGreaterThan(100);
    });

    test('every figure has paint on it', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        const painted = await page.evaluate(() =>
            [...document.querySelectorAll('[data-bv-chart]')].map(c => {
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                let n = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
                return { key: c.getAttribute('data-bv-chart'), pixels: n };
            }));
        expect(painted.length).toBeGreaterThanOrEqual(7);
        for (const chart of painted) {
            // A frame alone is roughly 2k pixels; a real curve is well above it.
            expect(chart.pixels, `chart "${chart.key}" is blank`).toBeGreaterThan(2500);
        }
    });

    test('the bias slider moves the whole chain at once', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);

        const snapshot = () => page.evaluate(() => ({
            deltaM: document.querySelector('[data-bv="deltaMCore"]').textContent,
            peak: document.querySelector('[data-bv="peakOutflow"]').textContent,
            mass: document.querySelector('[data-bv="massDeficit"]').textContent,
            isw: document.querySelector('[data-bv="iswCentral"]').textContent,
            snr: document.querySelector('[data-bv="lensingSnr"]').textContent,
        }));
        const before = await snapshot();

        // A LOWER bias means a DEEPER matter void, so every downstream amplitude
        // must grow. That coupling is the point of the control — this asserts
        // the whole chain moved together, which is what one shared recompute
        // buys and what per-panel incremental updates would break.
        await page.locator('[data-bv-control="bias"]').fill('1.15');
        await page.locator('[data-bv-control="bias"]').dispatchEvent('input');
        await page.waitForTimeout(900);
        const after = await snapshot();

        expect(after.deltaM).not.toBe(before.deltaM);
        expect(after.peak).not.toBe(before.peak);
        expect(after.mass).not.toBe(before.mass);
        expect(after.isw).not.toBe(before.isw);

        const f = (s) => parseFloat(String(s).replace(/[^\d.\-]/g, ''));
        expect(Math.abs(f(after.deltaM)), 'a lower bias deepens the matter void')
            .toBeGreaterThan(Math.abs(f(before.deltaM)));
        expect(f(after.peak), 'and speeds up the outflow').toBeGreaterThan(f(before.peak));
        expect(Math.abs(f(after.isw)), 'and deepens the ISW cold spot')
            .toBeGreaterThan(Math.abs(f(before.isw)));
    });

    test('the physical signs the page argues for survive a round trip', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        const signs = await page.evaluate(() => ({
            isw: document.querySelector('[data-bv="iswSign"]').textContent,
            outflow: document.querySelector('[data-bv="peakOutflow"]').textContent,
            mass: document.querySelector('[data-bv="massDeficit"]').textContent,
            compensation: document.querySelector('[data-bv="compensation"]').textContent,
            tidal: document.querySelector('[data-bv="tidalReading"]').textContent,
        }));
        expect(signs.isw, 'a void prints a COLD spot').toContain('COLD');
        expect(signs.mass, 'the enclosed mass is a deficit').toContain('-');
        expect(parseFloat(signs.outflow), 'the outflow is outward and substantial')
            .toBeGreaterThan(50);
        expect(parseFloat(signs.compensation), 'the void is under-compensated').toBeLessThan(1);
        expect(signs.tidal).toContain('squeezed into the wall');
    });

    test('the field mode switches without recomputing the physics', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);

        const modeLabel = page.locator('[data-bv="fieldMode"]').first();
        await expect(modeLabel).toContainText('Δg');

        // `.first()` is required, not defensive: massDeficit deliberately
        // appears twice in the markup (headline strip and compensation card),
        // and a bare locator is a strict-mode violation on exactly the keys the
        // page repeats on purpose.
        const massBefore = await page.locator('[data-bv="massDeficit"]').first().textContent();
        await page.locator('[data-bv-control="mode"]').selectOption('velocity');
        await page.waitForTimeout(400);
        await expect(modeLabel).toContainText('Peculiar velocity');
        await expect(page.locator('[data-bv="fieldMax"]').first()).toContainText('km/s');

        // Switching what is DRAWN must not change what is COMPUTED.
        expect(await page.locator('[data-bv="massDeficit"]').first().textContent())
            .toBe(massBefore);
    });

    test('re-rolling the web changes the model but not the void', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        const before = await page.evaluate(() => ({
            seed: document.querySelector('[data-bv="seed"]').textContent,
            mass: document.querySelector('[data-bv="massDeficit"]').textContent,
            horizon: document.querySelector('[data-bv="velocityHorizon"]').textContent,
            share: document.querySelector('[data-bv="shareAtTwo"]').textContent,
        }));
        await page.locator('#bv-reroll').click();
        await page.waitForTimeout(900);
        const after = await page.evaluate(() => ({
            seed: document.querySelector('[data-bv="seed"]').textContent,
            mass: document.querySelector('[data-bv="massDeficit"]').textContent,
            horizon: document.querySelector('[data-bv="velocityHorizon"]').textContent,
            share: document.querySelector('[data-bv="shareAtTwo"]').textContent,
        }));

        expect(after.seed).not.toBe(before.seed);
        // The void's own quantities depend on the profile alone, so a different
        // web must leave them untouched. If they move, something has leaked
        // between the two halves of the counterfactual.
        expect(after.mass, 'the mass deficit belongs to the void, not the web')
            .toBe(before.mass);
        expect(after.horizon, 'the velocity horizon belongs to the void, not the web')
            .toBe(before.horizon);
    });

    test('the provenance banner is present and cannot be dismissed', async ({ page }) => {
        await page.goto(PAGE);
        const banner = page.locator('.bv-provenance');
        await expect(banner).toBeVisible();
        await expect(banner).toContainText('Everything else on this page is a model');
        await expect(banner).toContainText('No number here is a detection');
        // No close affordance of any kind.
        expect(await banner.locator('button, [role="button"], a[href="#"]').count()).toBe(0);
    });

    test('the page is reachable from the Deep Space menu', async ({ page }) => {
        await page.goto('/deep-space.html');
        await expect(page.locator('a[href="bootes-void.html"]').first()).toBeVisible();
    });

    // ── Camera ──────────────────────────────────────────────────────────────

    test('the viewpoint buttons fly the camera and light up', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);

        const buttons = page.locator('[data-bv-viewpoint]');
        await expect(buttons).toHaveCount(5);
        await expect(page.locator('[data-bv-viewpoint="survey"]'))
            .toHaveAttribute('aria-pressed', 'true');

        const pose = () => page.evaluate(() => {
            const p = globalThis.__bootesLab.scene.currentPose();
            return { theta: p.theta, phi: p.phi, radius: p.radius, fov: p.fovDeg };
        });
        const before = await pose();

        // Top-down is the unambiguous one: it must end up looking almost
        // straight down, and the polar clamp must stop it reaching the pole
        // exactly — at the pole the azimuth is undefined and the view rolls.
        await page.click('[data-bv-viewpoint="pole"]');
        await page.waitForTimeout(2000);
        const after = await pose();
        expect(after.phi).toBeLessThan(0.2);
        expect(after.phi, 'the polar clamp must hold the camera off the pole')
            .toBeGreaterThan(0);
        expect(after.phi).not.toBe(before.phi);
        await expect(page.locator('[data-bv-viewpoint="pole"]'))
            .toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('[data-bv-viewpoint="survey"]'))
            .toHaveAttribute('aria-pressed', 'false');
        await expect(page.locator('[data-bv="camElevation"]').first()).toContainText('+8');

        // The inside view carries its own wide lens; the others share one.
        await page.click('[data-bv-viewpoint="inside"]');
        await page.waitForTimeout(2000);
        const inside = await pose();
        expect(inside.fov).toBeGreaterThan(60);
        expect(inside.radius).toBeLessThan(after.radius / 3);
    });

    test('the sightline viewpoints are built from the real oblique sightline', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);

        // Both are asserted in the pure gate; what a browser adds is that the
        // rig actually lands where the maths says, rather than at a coordinate
        // axis that happens to look similar.
        const dirFor = async (vp) => {
            await page.click(`[data-bv-viewpoint="${vp}"]`);
            await page.waitForTimeout(2000);
            return page.evaluate(() => {
                const c = globalThis.__bootesLab.scene.camera.position;
                const n = Math.hypot(c.x, c.y, c.z);
                return [c.x / n, c.y / n, c.z / n];
            });
        };
        const along = await dirFor('sightline');
        const across = await dirFor('across');
        const dot = along[0] * across[0] + along[1] * across[1] + along[2] * across[2];
        expect(Math.abs(dot), 'the two sightline views must be perpendicular')
            .toBeLessThan(0.02);
        expect(Math.abs(across[1]), 'and "across" must be level').toBeLessThan(0.02);
        // Neither may be a coordinate axis.
        for (const v of [along, across]) {
            const axisLike = Math.max(...v.map(Math.abs));
            expect(axisLike, 'a sightline view must not collapse onto an axis')
                .toBeLessThan(0.99);
        }
    });

    test('the scale bar is present and responds to zoom', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);

        const read = () => page.evaluate(() => ({
            label: document.querySelector('[data-bv="scaleBarLabel"]').textContent,
            width: parseFloat(document.querySelector('#bv-scalebar-fill').style.width),
        }));
        const wide = await read();
        expect(wide.label).toMatch(/Mpc/);
        expect(wide.width).toBeGreaterThan(20);

        // Fly inside: a given screen width must then be worth far FEWER Mpc.
        await page.click('[data-bv-viewpoint="inside"]');
        await page.waitForTimeout(2200);
        const close = await read();
        const mpcOf = (s) => parseFloat(s);
        expect(mpcOf(close.label), 'zooming in must shrink what a screen width is worth')
            .toBeLessThan(mpcOf(wide.label));
    });

    test('the keyboard drives the camera but does not steal slider keys', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        await stageReady(page);

        // A viewpoint shortcut works with nothing focused.
        await page.keyboard.press('4');
        await page.waitForTimeout(2000);
        expect(await page.evaluate(() => globalThis.__bootesLab.scene.currentPose().phi))
            .toBeLessThan(0.2);

        // THE GATE THAT MATTERS. A range input uses the arrow keys itself, and
        // the rail sits beside the canvas — an ungated global handler steals
        // them and the slider silently stops working while the camera spins.
        const slider = page.locator('[data-bv-control="clumpiness"]');
        await slider.focus();
        const before = await slider.inputValue();
        const camBefore = await page.evaluate(() =>
            globalThis.__bootesLab.scene.currentPose().theta);
        await page.keyboard.press('ArrowRight');
        await page.waitForTimeout(400);
        expect(await slider.inputValue(), 'the focused slider must still take the key')
            .not.toBe(before);
        // Not "did not move at all" — OrbitControls' damping is still settling
        // and drifts by ~3e-5 rad per frame. The claim is that the camera did
        // not take the ORBIT STEP, which is 0.06 rad; anything under a tenth of
        // that is settling, not a keypress.
        const camAfter = await page.evaluate(() =>
            globalThis.__bootesLab.scene.currentPose().theta);
        expect(Math.abs(camAfter - camBefore),
            'the camera must not have taken the keyboard orbit step').toBeLessThan(0.006);
    });

    test('dragging the stage releases the named viewpoint', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        await stageReady(page);
        await expect(page.locator('[data-bv-viewpoint="survey"]'))
            .toHaveAttribute('aria-pressed', 'true');

        const box = await page.locator('#bv-stage').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(400);

        // Leaving a preset lit after the reader has dragged away from it is a
        // small lie that makes the buttons feel broken.
        const pressed = await page.locator('[data-bv-viewpoint][aria-pressed="true"]').count();
        expect(pressed).toBe(0);
    });

    test('the catalogued clusters are pickable and focusing works', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        await stageReady(page);

        // Project a cluster to screen through the rig's own picker, then check
        // a double-click there focuses it. Using the rig's projection rather
        // than a guessed pixel keeps this robust to camera changes.
        const hit = await page.evaluate(() => {
            const sc = globalThis.__bootesLab.scene;
            const rect = document.querySelector('#bv-stage').getBoundingClientRect();
            // Sweep a coarse grid for any pickable — nine clusters on a
            // 1280-wide canvas are found within a few dozen probes.
            const stage = document.querySelector('#bv-stage');
            for (let y = rect.top + 20; y < rect.bottom - 20; y += 18) {
                for (let x = rect.left + 20; x < rect.right - 20; x += 18) {
                    const p = sc.rig.pickAt(x, y, 14);
                    if (!p) continue;
                    // The canvas must be the TOPMOST element at that point.
                    // The site nav is fixed at the top of the viewport, so at a
                    // 720px-tall window part of the stage sits underneath it —
                    // and a synthetic double-click on those pixels lands on the
                    // nav, not on the stage. `pickAt` projects in 3D and knows
                    // nothing about what is covering the canvas.
                    if (document.elementFromPoint(x, y) !== stage) continue;
                    return { x, y, id: p.id, name: p.name };
                }
            }
            return null;
        });
        expect(hit, 'at least one catalogued cluster must be on screen and pickable')
            .not.toBeNull();

        await page.mouse.dblclick(hit.x, hit.y);
        await page.waitForTimeout(1600);
        const chip = page.locator('#bv-focus');
        await expect(chip).toBeVisible();
        await expect(chip).toContainText(/Mpc from the void centre/);

        await page.locator('#bv-focus-clear').click();
        await page.waitForTimeout(1600);
        await expect(chip).toBeHidden();
    });

    test('labels can be turned off from the control and from the keyboard', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);

        const labelCount = () => page.evaluate(() =>
            globalThis.__bootesLab.scene.groups.refs.children
                .filter(c => c.isSprite).filter(c => c.visible).length);
        expect(await labelCount(), 'the ruler and the clusters are labelled')
            .toBeGreaterThan(5);

        await page.locator('[data-bv-control="labels"]').uncheck();
        await page.waitForTimeout(300);
        expect(await labelCount()).toBe(0);

        // BLUR FIRST, AND THAT IS THE INTENDED BEHAVIOUR RATHER THAN A
        // WORKAROUND: clicking the checkbox leaves it focused, and the camera's
        // key handler yields to any focused control so that the rail's sliders
        // keep their arrow keys. A shortcut that fired over a focused input
        // would be the bug.
        await page.evaluate(() => document.activeElement?.blur?.());

        // The L key and the checkbox are two views of one flag; toggling one
        // must move the other or the control shows the opposite of the scene.
        await page.keyboard.press('l');
        await page.waitForTimeout(300);
        expect(await labelCount()).toBeGreaterThan(5);
        await expect(page.locator('[data-bv-control="labels"]')).toBeChecked();
    });

    test('the range rings are fixed and cover the catalogued clusters', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        const rings = await page.evaluate(() => {
            const sc = globalThis.__bootesLab.scene;
            return sc.groups.refs.children.filter(c => c.isLine).length;
        });
        expect(rings, 'range rings, the meridian, the spokes and the gnomon')
            .toBeGreaterThanOrEqual(6);

        // The rings must NOT change with zoom — that is what separates them
        // from the scale bar, and it is why "two rings out" means something.
        const before = await page.evaluate(() => globalThis.__bootesLab.scene
            .groups.refs.children.filter(c => c.isLine).length);
        await page.click('[data-bv-viewpoint="inside"]');
        await page.waitForTimeout(2200);
        const after = await page.evaluate(() => globalThis.__bootesLab.scene
            .groups.refs.children.filter(c => c.isLine).length);
        expect(after).toBe(before);
    });

    test('a drag cancels a flight in progress instead of being swallowed', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        await stageReady(page);

        // Start a long flight to the far side, then grab the stage halfway
        // through. THE CONVENTION (set by js/geomag/core-3d.js for the TIGA 3D
        // view): any direct manipulation cancels the flight. Swallowing input
        // for the duration instead means a reader who grabs mid-flight gets
        // nothing for a second and a bit, which reads as a frozen page.
        // A DELIBERATELY LONG FLIGHT, driven through the hook rather than by
        // clicking the button. The default flight is 1.15 s and Playwright's
        // synthesised drag — boundingBox, move, down, six stepped moves, up —
        // takes most of that on a software rasteriser, so a button-driven
        // version raced the flight and sometimes tested a camera that had
        // already arrived. Six seconds removes the race without changing which
        // code path is under test: this is the same `endFlight` via the same
        // capture-phase pointerdown.
        await page.evaluate(() =>
            globalThis.__bootesLab.scene.goTo('inside', { seconds: 6 }));
        await page.waitForTimeout(400);
        expect(await page.evaluate(() =>
            globalThis.__bootesLab.scene.rig.isFlying), 'the flight is running').toBe(true);

        const box = await page.locator('#bv-stage').boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(250);

        expect(await page.evaluate(() => globalThis.__bootesLab.scene.rig.isFlying),
            'the drag must have cancelled the flight').toBe(false);

        // STOPPED, NOT COMPLETED — and that has to be measured against the
        // DESTINATION, not against a radius sampled before the drag. The flight
        // keeps running while Playwright synthesises the drag (which takes a few
        // hundred ms), and this one is a log interpolation from ~357 Mpc down to
        // ~20, so the radius legitimately moves a long way in that window. The
        // claim is that it never arrived.
        const dest = await page.evaluate(() => globalThis.__bootesLab.scene
            .rig.viewpoints.inside.distance * 91.6);
        const after = await page.evaluate(() => globalThis.__bootesLab.scene
            .currentPose().radius * 20);
        expect(after, 'the camera must not have reached the flight destination')
            .toBeGreaterThan(dest * 2.5);

        // And it must now be STILL — a cancelled flight that is still easing
        // would keep moving after the pointer is up.
        await page.waitForTimeout(700);
        const settled = await page.evaluate(() => globalThis.__bootesLab.scene
            .currentPose().radius * 20);
        expect(Math.abs(settled / after - 1),
            'the camera is at rest once the flight is cancelled').toBeLessThan(0.05);

        // And the drag itself took effect.
        const pressed = await page.locator('[data-bv-viewpoint][aria-pressed="true"]').count();
        expect(pressed, 'a cancelled flight is not "at" its viewpoint').toBe(0);
    });

    test('auto-rotate survives a flight interrupted by another flight', async ({ page }) => {
        await page.goto(PAGE);
        await ready(page);
        await page.evaluate(() => document.querySelector('.bv-stage-grid')
            .scrollIntoView({ block: 'center' }));
        await page.waitForTimeout(300);

        // Auto-rotate is on by default and a flight turns it off for the
        // duration. Starting a SECOND flight before the first lands used to
        // capture the mid-flight value — false — and auto-rotate was then
        // permanently lost, with no symptom except that the stage quietly
        // stopped turning.
        expect(await page.evaluate(() => globalThis.__bootesLab.scene.autoRotate)).toBe(true);

        await page.click('[data-bv-viewpoint="pole"]');
        await page.waitForTimeout(300);
        await page.click('[data-bv-viewpoint="across"]');
        await page.waitForTimeout(2200);

        expect(await page.evaluate(() => globalThis.__bootesLab.scene.autoRotate),
            'auto-rotate must come back after the second flight lands').toBe(true);
        await expect(page.locator('[data-bv-control="autorotate"]')).toBeChecked();
    });
});
