/**
 * satellite-designer-smoke.spec.js — boot + physics smoke test
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies satellite-designer.html loads without console errors, the orbital
 * flight engine self-tests all pass, and launching a craft advances the
 * simulation (telemetry + orbit trail update). Mirrors the style of
 * upper-atmosphere-smoke.spec.js, leaning on the exposed `window.__sd`.
 *
 * Every test boots through `boot()`, which makes the gate HERMETIC and
 * clickable:
 *   - the two NOAA history feeds the forecast module fetches at boot are
 *     served from the upper-atmosphere fixtures (same shapes the page's
 *     client reads). Without that, a sandbox with no egress logs two 503
 *     "Failed to load resource" lines, and a filter wide enough to hide a
 *     feed 503 would also hide a 404 on one of the page's own modules.
 *   - the cookie-consent banner (js/cookie-consent.js, fixed to the bottom
 *     of the viewport) is dismissed, or it swallows clicks on controls that
 *     scroll under it.
 */

import { test, expect } from '@playwright/test';
import { f107History, apHistory } from './fixtures/upper-atmosphere-feeds.mjs';

const URL = '/satellite-designer.html';
const BOOT_TIMEOUT_MS = 15_000;

async function routeFeeds(page, nowMs = Date.now()) {
    const json = (route, body) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    await page.route('**/api/noaa/f107-history**', (r) => json(r, f107History(nowMs)));
    await page.route('**/api/noaa/ap-history**', (r) => json(r, apHistory(nowMs)));
}

async function boot(page) {
    await routeFeeds(page);
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__sd, { timeout: BOOT_TIMEOUT_MS });
    const reject = page.locator('button[data-action="reject"]').first();
    if (await reject.count()) await reject.click();
}

/** Time warp above ×10 is a progression unlock (×1000 = Navigator rank).
 *  Grant the XP through the page's own hook, then pick it in the UI. */
async function warp1000(page) {
    await page.evaluate(() => window.__sd.progression.award(1000));
    await page.click('#warp-modes .toggle[data-warp="1000"]');
    await expect(page.locator('#warp-modes .toggle[data-warp="1000"]')).toHaveClass(/active/);
}

function attachConsoleRecorder(page) {
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push({ text: msg.text(), location: msg.location() });
    });
    page.on('pageerror', (err) => errors.push({ text: err.message, stack: err.stack }));
    return errors;
}

test.describe('satellite-designer.html smoke', () => {

    test('boots without console errors', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await boot(page);
        await page.waitForTimeout(1200);

        // Supabase CDN can be blocked in CI sandboxes — the page degrades to a
        // local-only hangar, which is expected behaviour, not a page fault.
        const filtered = errors.filter(e =>
            !/supabase|jsdelivr|Failed to fetch|net::ERR/i.test(e.text || ''));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'No unexpected console errors during boot').toHaveLength(0);
    });

    test('flight engine self-test passes', async ({ page }) => {
        await boot(page);
        const results = await page.evaluate(() => window.__sd.engine.selfTest());
        const failures = results.filter(r => !r.pass);
        expect(failures,
            `all self-tests pass (failures: ${failures.map(f => f.msg).join('; ')})`
        ).toHaveLength(0);
    });

    test('launch advances the simulation', async ({ page }) => {
        await boot(page);

        await page.click('#b-launch');
        // Crank time-warp so a good fraction of an orbit passes quickly.
        await warp1000(page);
        await page.waitForFunction(() => {
            const s = window.__sd.sim;
            return (s.state?.t || 0) > 60 && s.trail.length > 20;
        }, { timeout: 20_000 }).catch(() => {});   // the expects below report

        const st = await page.evaluate(() => ({
            running: window.__sd.sim.running,
            t: window.__sd.sim.state?.t || 0,
            trail: window.__sd.sim.trail.length,
            alt: Number(document.querySelector('#m-alt .v').textContent.replace(/[^\d.]/g, '')),
        }));
        expect(st.t, 'mission clock advanced').toBeGreaterThan(60);
        expect(st.trail, 'orbit trail accumulated points').toBeGreaterThan(20);
        expect(st.alt, 'altitude telemetry is a sane LEO number').toBeGreaterThan(80);
    });

    test('design readouts compute Δv from the rocket equation', async ({ page }) => {
        await boot(page);

        // Dry mass and Isp live in the collapsed "Manual fine-tune" disclosure;
        // propellant is the bay's range slider (a range input cannot be filled).
        await page.click('details:has(#f-dry) > summary');
        await page.fill('#f-dry', '100');
        await page.fill('#f-isp', '300');
        await page.evaluate(() => {
            const f = document.querySelector('#f-fuel');
            f.value = '100'; f.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForTimeout(150);

        // Δv = Isp·g0·ln(2) = 300 · 9.80665 · 0.6931 ≈ 2039 m/s
        const dv = await page.evaluate(() =>
            Number(document.querySelector('#d-dv').textContent.replace(/[^\d.]/g, '')));
        expect(dv).toBeGreaterThan(1950);
        expect(dv).toBeLessThan(2150);
    });

    test('builder self-test passes', async ({ page }) => {
        await boot(page);
        const results = await page.evaluate(() => window.__sd.builder.selfTest());
        const failures = results.filter(r => !r.pass);
        expect(failures,
            `builder self-tests pass (failures: ${failures.map(f => f.msg).join('; ')})`
        ).toHaveLength(0);
    });

    test('inline design view configures parts and auto-applies to the ship', async ({ page }) => {
        await boot(page);

        // No modal: the labelled SATELLITE DESIGN section and its part chips
        // are present on the core page from the start.
        await expect(page.locator('#sd-design .area-hd')).toContainText(/satellite design/i);
        await expect(page.locator('#sd-mission .area-hd')).toContainText(/mission state/i);
        await expect(page.locator('#bay')).toHaveCount(0);
        await page.waitForFunction(
            () => document.querySelectorAll('#bay-body .opt').length >= 3, { timeout: 4000 });

        const specHasNumber = await page.evaluate(() =>
            /\d/.test(document.querySelector('#bs-mass').textContent));
        expect(specHasNumber, 'build spec readout populated').toBe(true);

        // Pick the big bus + remove panels — changes auto-apply to the ship
        // form: dry mass jumps and Cd collapses to the bare-bus value.
        await page.click('#bay-body .opt[data-v="bus_med"]');
        await page.click('#bay-panel .opt[data-v="none"]');

        const form = await page.evaluate(() => ({
            dry: Number(document.querySelector('#f-dry').value),
            cd: Number(document.querySelector('#f-cd').value),
            build: window.__sd.bay.getBuild(),
        }));
        expect(form.dry, 'medium bus is heavy').toBeGreaterThan(300);
        expect(form.cd, 'no panels ⇒ bare-bus Cd').toBeCloseTo(2.2, 1);
        expect(form.build.body).toBe('bus_med');
    });

    test('build config round-trips through the design draft', async ({ page }) => {
        await boot(page);

        const data = await page.evaluate(() => window.__sd.ui.currentDesignData());
        expect(data.build, 'design data carries the 3-D build').toBeTruthy();
        expect(data.build.body, 'build has a chassis').toBeTruthy();
        expect(data.build.thruster, 'build has a thruster type').toBeTruthy();
        expect(data.env, 'design data carries space-weather env').toBeTruthy();
        expect(data.attitude, 'design data carries drag attitude').toBeTruthy();
    });

    test('space-weather presets swing the thermosphere density', async ({ page }) => {
        await boot(page);

        const r = await page.evaluate(() => {
            window.__sd.conditions.setSWPreset('solar_min');
            const lo = window.__sd.conditions.rho400();
            window.__sd.conditions.setSWPreset('carrington');
            const hi = window.__sd.conditions.rho400();
            return { lo, hi, env: window.__sd.conditions.getEnv() };
        });
        // Carrington-class storm density at 400 km is many× solar-min.
        expect(r.hi).toBeGreaterThan(r.lo * 5);
        expect(r.env.ap).toBe(400);

        // Preset chip + slider readout reflect the active regime.
        await page.click('#sw-presets .toggle[data-sw="solar_max"]');
        const f107 = await page.evaluate(() => Number(document.querySelector('#f-f107').value));
        expect(f107).toBe(230);
    });

    test('drag attitude scales the effective drag area', async ({ page }) => {
        await boot(page);

        const r = await page.evaluate(() => {
            window.__sd.conditions.setAttitude('feathered');
            const f = window.__sd.sim.control.attitudeMult;
            window.__sd.conditions.setAttitude('broadside');
            const b = window.__sd.sim.control.attitudeMult;
            return { f, b, att: window.__sd.conditions.getAttitude() };
        });
        expect(r.f).toBeLessThan(1);
        expect(r.b).toBeGreaterThan(1.5);
        expect(r.att).toBe('broadside');

        // The effective-area readout updates with attitude.
        const effText = await page.textContent('#d-effarea');
        expect(/\d/.test(effText), 'effective drag area shown').toBe(true);
    });

    test('the 3-D mission scene mounts on the stage canvas', async ({ page }) => {
        await boot(page);

        // One WebGL scene (js/satellite-designer-3d.js) draws Earth, the orbit
        // and the parametric ship. If init fails the page swaps the canvas for
        // a "3-D scene unavailable" note, so the canvas surviving boot is
        // itself the first check.
        await expect(page.locator('#sd-canvas'), 'stage canvas survives boot').toBeAttached();

        const r = await page.evaluate(async () => {
            const scene = await window.__sd.stage.ensureScene();
            const cv = document.querySelector('#sd-canvas');
            return { returned: !!scene,
                     ready: window.__sd.stage.sceneReady(),
                     mode: window.__sd.stage.getCameraMode(),
                     w: cv?.width || 0, h: cv?.height || 0 };
        });
        // Chromium ships WebGL, so in CI this should come up ready.
        expect(r.returned, 'ensureScene resolves to the scene').toBe(true);
        expect(r.ready, 'scene initialised under WebGL').toBe(true);
        expect(['wide', 'follow', 'free'], 'camera mode is one of the three').toContain(r.mode);
        expect(r.w * r.h, 'drawing buffer sized to the stage').toBeGreaterThan(0);

        // ensureScene is idempotent — a second call returns the same scene.
        const same = await page.evaluate(async () =>
            (await window.__sd.stage.ensureScene()) === (await window.__sd.stage.ensureScene()));
        expect(same, 'ensureScene does not rebuild the scene').toBe(true);
    });

    test('launch → pause → reset drives the simulation loop', async ({ page }) => {
        await boot(page);

        // Pre-flight: readouts blank, Reset always available, Pause inert.
        await expect(page.locator('#st-phase')).toHaveText(/pre-flight/i);
        await expect(page.locator('#b-reset')).toBeEnabled();
        await expect(page.locator('#m-alt .v')).toHaveText('—');

        // Crank time-warp so the loop visibly advances in well under a second.
        await warp1000(page);
        await page.click('#b-launch');
        await expect(page.locator('#st-phase')).toHaveText(/in flight/i);

        // The loop must advance physics and push it to the gauges.
        await page.waitForFunction(() => {
            const s = window.__sd.sim;
            return s.running && s.state && s.state.t > 0 && s.trail.length > 2;
        }, { timeout: 5000 });
        await expect(page.locator('#m-alt .v')).not.toHaveText('—');
        const movedClock = await page.evaluate(() =>
            Number(document.querySelector('#o-clock').textContent.replace(/\D/g, '')) > 0);
        expect(movedClock, 'mission clock advances').toBe(true);

        // Pause freezes the loop and is reflected in the status pill.
        await page.click('#b-pause');
        await expect(page.locator('#st-phase')).toHaveText(/paused/i);
        const t1 = await page.evaluate(() => window.__sd.sim.state.t);
        await page.waitForTimeout(250);
        const t2 = await page.evaluate(() => window.__sd.sim.state.t);
        expect(t2, 'state frozen while paused').toBe(t1);

        // Reset returns to an editable pre-flight board with blank readouts.
        await page.click('#b-reset');
        await expect(page.locator('#st-phase')).toHaveText(/pre-flight/i);
        await expect(page.locator('#m-alt .v')).toHaveText('—');
        const cleared = await page.evaluate(() => {
            const s = window.__sd.sim;
            return !s.running && s.state === null && s.trail.length === 0;
        });
        expect(cleared, 'sim fully cleared on reset').toBe(true);
        await expect(page.locator('#b-launch')).toBeEnabled();
    });

    test('power budget gates electric propulsion', async ({ page }) => {
        await boot(page);

        // One thruster, matching the builder's own self-test: the default
        // build carries two, and 2 × 1500 W of Hall exceeds even a 6 m quad
        // array (powerFrac ≈ 0.63), which is the physics working, not a bug.
        await page.evaluate(() => {
            const tc = document.querySelector('#bay-tc');
            tc.value = '1'; tc.dispatchEvent(new Event('input', { bubbles: true }));
        });
        expect((await page.evaluate(() => window.__sd.bay.getBuild())).thrusterCount).toBe(1);

        // Flagship Hall thruster on a body-only build: no array power, so it
        // is fully starved — zero thrust, negative margin (flagged red).
        await page.click('#bay-thruster .opt[data-v="hall_shielded"]');
        await page.click('#bay-panel .opt[data-v="none"]');
        let s = await page.evaluate(() => ({
            thr: Number(document.querySelector('#f-thrust').value),
            d: window.__sd.builder.deriveDesign(
                 window.__sd.bay.getBuild(), window.__sd.engine.ENGINE_PRESETS),
            marginBad: document.querySelector('#bs-margin-m')
                          .classList.contains('flag-bad'),
        }));
        expect(s.d.electric, 'hall is electric').toBe(true);
        expect(s.d.powerFrac, 'starved EP makes no thrust').toBe(0);
        expect(s.thr, 'form thrust starved to zero').toBe(0);
        expect(s.marginBad, 'negative power margin flagged').toBe(true);

        // Strap on a big quad array → fully powered, rated thrust restored.
        await page.click('#bay-panel .opt[data-v="quad"]');
        await page.evaluate(() => {
            const sp = document.querySelector('#bay-span');
            sp.value = '6'; sp.dispatchEvent(new Event('input', { bubbles: true }));
        });
        s = await page.evaluate(() => ({
            thr: Number(document.querySelector('#f-thrust').value),
            d: window.__sd.builder.deriveDesign(
                 window.__sd.bay.getBuild(), window.__sd.engine.ENGINE_PRESETS),
            pwrShown: /\d/.test(document.querySelector('#bs-pwr').textContent),
        }));
        expect(s.d.powerFrac, 'ample power ⇒ full thrust').toBe(1);
        expect(s.thr, 'rated Hall thrust applied to ship').toBeCloseTo(0.30, 2);
        expect(s.pwrShown, 'array-power readout populated').toBe(true);

        // Chemical thrusters ignore the array entirely.
        await page.click('#bay-thruster .opt[data-v="monoprop"]');
        await page.click('#bay-panel .opt[data-v="none"]');
        const chem = await page.evaluate(() => window.__sd.builder.deriveDesign(
            window.__sd.bay.getBuild(), window.__sd.engine.ENGINE_PRESETS));
        expect(chem.electric, 'monoprop is chemical').toBe(false);
        expect(chem.powerFrac, 'chemical thrust unaffected by power').toBe(1);
        expect(chem.thrust, 'monoprop still produces thrust with no panels')
            .toBeGreaterThan(0);
    });
});

// ── Component library, layout and engineering review (2026-10) ──────────────
// The bay draws js/satellite-parts-3d.js meshes placed by
// js/satellite-layout.js; the review panel reads the same layout. These gates
// pin the page wiring — the physics itself is gated in plain Node by
// tests/satellite-components.mjs.
test.describe('satellite-designer.html component bay', () => {

    async function bootBay(page) {
        await page.goto(URL);
        await page.waitForFunction(() => window.__sd?.bay?.ready?.(), { timeout: 60_000 });
        // The cookie banner is fixed over the bottom of the viewport and
        // swallows clicks on whatever scrolls under it — dismiss it first.
        const reject = page.locator('button[data-action="reject"]').first();
        if (await reject.isVisible().catch(() => false)) await reject.click();
        await page.evaluate(() => {
            window.__sd.bay.spin(false);
            document.querySelector('#bay-view').scrollIntoView({ block: 'center' });
        });
        await page.waitForFunction(() => !!window.__sd.bay.lastReview(), { timeout: 10_000 });
    }

    test('every layout part is drawn and pickable; clicking one opens the inspector', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await bootBay(page);
        const ids = await page.evaluate(() => ({
            drawn: window.__sd.bay.partIds(),
            placed: window.__sd.bay.layout().parts.filter(p => p.kind !== 'harness').map(p => p.id),
        }));
        expect(ids.drawn.sort(), 'one mesh group per placed part').toEqual(ids.placed.sort());

        // Click the payload where it projects on screen → it is selected and
        // the inspector names it.
        await page.waitForTimeout(400);                     // let damping settle
        const pt = await page.evaluate(() => window.__sd.bay.screenOf('payload'));
        await page.mouse.click(pt.x, pt.y);
        await expect.poll(() => page.evaluate(() => window.__sd.bay.getSelected())).toBe('payload');
        await expect(page.locator('#bay-inspect')).toBeVisible();
        await expect(page.locator('#bay-inspect h3')).toHaveText(/camera/i);

        const filtered = errors.filter(e => !/supabase|jsdelivr|Failed to fetch|net::ERR|Failed to load resource/i.test(e.text || ''));
        expect(filtered, 'no console errors while picking').toHaveLength(0);
    });

    test('view modes swap materials and the legend really hides', async ({ page }) => {
        await bootBay(page);
        // The legend's author display:flex must not beat the [hidden] rule
        // (the mars.html feature-index scar) — it is only shown in Subsystems.
        await expect(page.locator('#bay-legend')).toBeHidden();
        await page.click('#bay-views button[data-view="subsystem"]');
        await expect(page.locator('#bay-legend')).toBeVisible();
        await expect(page.locator('#bay-legend')).toContainText(/Propulsion/);
        await page.click('#bay-views button[data-view="xray"]');
        await expect(page.locator('#bay-legend')).toBeHidden();
        expect(await page.evaluate(() => window.__sd.bay.getView())).toBe('xray');
        await page.click('#bay-explode');
        await expect(page.locator('#bay-explode')).toHaveAttribute('aria-pressed', 'true');
    });

    test('adding, moving and removing a component flows into mass, CG and the review', async ({ page }) => {
        await bootBay(page);
        const before = await page.evaluate(() => ({
            dry: Number(document.querySelector('#f-dry').value),
            n: window.__sd.bay.layout().rb.extras.length,
        }));
        await page.click('#ss-tabs button[data-tab="comms"]');
        await page.selectOption('#ss-face', '+Y');
        await page.click('#ss-lib .lib-item[data-k="ka_dish"]');
        await expect.poll(() => page.evaluate(() => window.__sd.bay.layout().rb.extras.length)).toBe(before.n + 1);
        const after = await page.evaluate(() => Number(document.querySelector('#f-dry').value));
        expect(after - before.dry, 'a 9 kg dish adds 9 kg to the flight model').toBeCloseTo(9, 1);
        await expect(page.locator('#ss-inst-n')).toHaveText(String(before.n + 1));

        // The review re-runs and sees the CG walk toward +Y.
        await page.waitForFunction(() => window.__sd.bay.lastReview()?.massProps.cgWet[1] > 0.02, { timeout: 5000 });

        // Move it to the opposite face through the installed list.
        const i = before.n;
        await page.selectOption(`#ss-installed .inst[data-i="${i}"] select`, '-Y');
        await page.waitForFunction(() => window.__sd.bay.lastReview()?.massProps.cgWet[1] < -0.02, { timeout: 5000 });

        await page.click(`#ss-installed .inst[data-i="${i}"] .rm`);
        await expect.poll(() => page.evaluate(() => window.__sd.bay.layout().rb.extras.length)).toBe(before.n);
    });

    test('subsystem chips change the hardware and the budgets', async ({ page }) => {
        await bootBay(page);
        await page.click('#ss-tabs button[data-tab="power"]');
        await page.click('#ss-battery .opt[data-v="li_20"]');
        await page.waitForFunction(() => window.__sd.bay.lastReview()?.design.resolved.battery === 'li_20', { timeout: 5000 });
        const dod = await page.evaluate(() => window.__sd.bay.lastReview().checks.find(c => c.id === 'power.dod').sev);
        expect(dod, 'a 20 Wh pack on a SmallSat fails depth of discharge').toBe('fail');
        await expect(page.locator('#rv-summary .rv-chip.fail')).toContainText(/1 fail/);

        // Propellant drives the Auto tanks: more fuel, more tank.
        const cap0 = await page.evaluate(() => window.__sd.bay.lastReview().prop.capacityKg);
        await page.evaluate(() => {
            const f = document.querySelector('#f-fuel');
            f.value = '400'; f.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForFunction((c) => window.__sd.bay.lastReview()?.prop.capacityKg > c, cap0, { timeout: 5000 });
    });

    test('every review tab renders', async ({ page }) => {
        await bootBay(page);
        for (const tab of ['checks', 'mass', 'power', 'thermal', 'comms', 'adcs', 'prop', 'bom']) {
            await page.click(`#rv-tabs button[data-tab="${tab}"]`);
            const txt = await page.textContent('#rv-body');
            expect(txt.trim().length, `${tab} tab has content`).toBeGreaterThan(20);
        }
        // The parts list is the flight model's own dry mass.
        const total = await page.evaluate(() => window.__sd.bay.lastReview().mass.dry);
        const form = await page.evaluate(() => Number(document.querySelector('#f-dry').value));
        expect(total).toBeCloseTo(form, 1);
    });

    test('blueprints load their engineered subsystems', async ({ page }) => {
        await bootBay(page);
        await page.evaluate(() => window.__sd.blueprints.load('starlink_v2mini'));
        const b = await page.evaluate(() => window.__sd.bay.getBuild());
        expect(b.payload).toBe('phased_array');
        expect(b.fuelKg).toBe(90);
        await page.waitForFunction(() => window.__sd.bay.lastReview()?.design.resolved.payload === 'phased_array', { timeout: 5000 });
    });
});
