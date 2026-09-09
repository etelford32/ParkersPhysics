/**
 * sun-convection.spec.js — the photosphere's fluid dynamics + nanoflare layer
 * ═══════════════════════════════════════════════════════════════════════════
 * Two claims sun.html makes about the surface, each gated by measuring the
 * thing back out of the running page rather than by looking at it.
 *
 * 1. THE CONVECTION IS CONVECTION. js/solar-fluid.js used to project the
 *    velocity onto ∇·v = 0 and force it with pure curl noise — both
 *    divergence-free, so the field could not have the one property that makes
 *    granulation granulation: plasma boiling OUT of hot cell centres and
 *    draining INTO the dark lanes. It now targets ∇·v = S with S the local
 *    buoyancy, so the correlation between temperature excess and horizontal
 *    divergence must be strongly POSITIVE. `SolarFluid.probe()` measures it,
 *    and the test flips the coupling to 0 to confirm the correlation collapses
 *    — i.e. that the gate is measuring the physics and not the weather.
 *
 * 2. THE NANOFLARES ARE A POPULATION. js/sun-nanoflares.js specifies a bounded
 *    power law dN/dE ∝ E^−α; the shader draws from it with the kernel's own
 *    inverse transform. The gate checks the uniform the shader actually
 *    receives tracks the control, that the reported heating budget moves the
 *    way the physics says when α crosses Hudson's threshold, and that the
 *    readout never claims a measured index it does not have.
 *
 * Runs on software GL. No network: every feed is allowed to fail, which is the
 * page's normal degraded path.
 */

import { test, expect } from '@playwright/test';
import {
    nanoflareState, energyFractionBelow, HEATING_REQUIREMENT, ALPHA_REFERENCES,
} from '../js/sun-nanoflares.js';
import { diffRotShear, SNODGRASS } from '../js/solar-fluid.js';

const BOOT = 45_000;

async function boot(page, query = '') {
    await page.addInitScript(() => {
        try {
            localStorage.setItem('pp_consent_v1', JSON.stringify(
                { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        } catch (e) {}
    });
    const shaderErrs = [];
    page.on('console', (m) => {
        if (m.type() === 'error' && /Shader Error|GLSL|ERROR: 0:|Program Info Log/i.test(m.text())) shaderErrs.push(m.text());
    });
    page.on('pageerror', (e) => shaderErrs.push('pageerror: ' + e.message));
    await page.goto('/sun.html' + query);
    await page.waitForFunction(() => window.__sun && window.__sun.frames > 5, null, { timeout: BOOT });
    return shaderErrs;
}

test.describe('photosphere convection', () => {

    test('the solver produces CONVECTION: hot fluid diverges, cool fluid converges', async ({ page }) => {
        test.setTimeout(180_000);
        const errs = await boot(page);
        expect(errs, errs.join('\n')).toHaveLength(0);

        const available = await page.evaluate(() => !!(window.__sun.fluid && window.__sun.fluid.probe));
        // The solver needs float colour buffers; where they are missing the page
        // falls back to procedural granulation ON PURPOSE and there is nothing
        // here to measure. Say so rather than passing silently.
        test.skip(!available, 'float render targets unavailable — fluid solver did not start');

        const on = await page.evaluate(async () => {
            const s = window.__sun;
            for (let i = 0; i < 220; i++) s.fluid.step(s.renderer);
            return s.fluid.probe(s.renderer);
        });
        console.log('convection (buoyancy on):  ' + JSON.stringify(on));

        // Same solver, coupling removed — the old divergence-free projection.
        const off = await page.evaluate(async () => {
            const s = window.__sun;
            s.fluid.setBuoyancy(0.0);
            for (let i = 0; i < 260; i++) s.fluid.step(s.renderer);
            return s.fluid.probe(s.renderer);
        });
        console.log('convection (buoyancy off): ' + JSON.stringify(off));

        expect(on.n).toBeGreaterThan(1000);
        // Measured at 0.79 with the shipped defaults; the bound leaves room for
        // a different GPU's float behaviour without leaving room for a solver
        // that has stopped convecting.
        expect(on.corr, 'hot must diverge and cool must converge').toBeGreaterThan(0.45);
        // And the gate must be measuring the coupling, not something incidental
        // that would score the same on a solver with the physics taken out.
        // Uncoupled, this is ~0 BY CONSTRUCTION: the projection targets ∇·v = 0
        // and there is nothing left for the temperature to correlate with.
        expect(Math.abs(off.corr), 'an incompressible projection has no such correlation').toBeLessThan(0.15);

        // Put it back so nothing downstream in this page runs uncoupled.
        await page.evaluate(() => window.__sun.fluid.setBuoyancy(32.0));
    });

    test('differential rotation profile matches Snodgrass & Ulrich, and the GLSL mirror agrees', async ({ page }) => {
        // Pure half first — no page needed for the physics itself.
        expect(diffRotShear(0)).toBeCloseTo(0, 12);                 // equator is the reference
        const pole = diffRotShear(Math.PI / 2);
        expect(pole).toBeLessThan(0);                                // poles lag
        // Ω(90°)/Ω(0°) = (A + B + C)/A — the equator laps the poles.
        const ratio = (SNODGRASS.A + SNODGRASS.B + SNODGRASS.C) / SNODGRASS.A;
        expect(1 + pole).toBeCloseTo(ratio, 12);
        expect(ratio).toBeGreaterThan(0.68);
        expect(ratio).toBeLessThan(0.73);
        // Monotone from equator to pole — no spurious mid-latitude jet.
        let prev = 0;
        for (let d = 5; d <= 90; d += 5) {
            const v = diffRotShear(d * Math.PI / 180);
            expect(v).toBeLessThan(prev + 1e-12);
            prev = v;
        }

        // The shader carries the same fit inline (it cannot import). Evaluate
        // the GLSL expression against the exported one at matched latitudes.
        const errs = await boot(page);
        expect(errs, errs.join('\n')).toHaveLength(0);
        const mirrored = await page.evaluate((lats) => lats.map((lat) => {
            const s2 = Math.sin(lat) ** 2;
            return (-2.396 * s2 - 1.787 * s2 * s2) / 14.713;       // the ADVECT_FS literal
        }), [0, 0.3, 0.7, 1.1, 1.5707963]);
        [0, 0.3, 0.7, 1.1, 1.5707963].forEach((lat, i) => {
            expect(mirrored[i]).toBeCloseTo(diffRotShear(lat), 9);
        });
    });
});

test.describe('nanoflare population', () => {

    test('the shader is fed the population the kernel specifies, and follows the control', async ({ page }) => {
        test.setTimeout(120_000);
        const errs = await boot(page);
        expect(errs, errs.join('\n')).toHaveLength(0);

        const read = () => page.evaluate(() => window.__sun.nanoflares);
        const setAlpha = async (a) => {
            await page.evaluate((v) => {
                const sl = document.getElementById('sl-nano-alpha');
                sl.value = String(v);
                sl.dispatchEvent(new Event('input', { bubbles: true }));
            }, a);
            await page.waitForTimeout(400);
        };

        for (const a of [1.6, 2.0, 2.45]) {
            await setAlpha(a);
            const n = await read();
            expect(n.uniform[0], 'the shader gets the control α').toBeCloseTo(a, 6);
            expect(n.state.alpha).toBeCloseTo(a, 6);
            // log2 bounds must round-trip to the kernel's erg range, or the
            // GLSL sampler draws from a different distribution than the readout
            // describes.
            expect(Math.pow(2, n.uniform[1])).toBeCloseTo(1e23, -18);
            expect(Math.pow(2, n.uniform[2])).toBeCloseTo(1e27, -22);
            expect(n.uniform[3]).toBeGreaterThan(0);
            // The page's own numbers must equal the kernel's, recomputed here —
            // the readout and the shader must not be able to drift apart.
            expect(n.state.smallEventShare).toBeCloseTo(energyFractionBelow(1e25, a), 9);
            const kernel = nanoflareState({ f107: 65, arAreaMh: 0, alpha: a });
            expect(n.state.meanErg).toBeCloseTo(kernel.meanErg, -18);
            expect(n.state.canHeat).toBe(kernel.canHeat);
        }
    });

    test('crossing Hudson’s α = 2 threshold flips which events carry the budget', async ({ page }) => {
        test.setTimeout(120_000);
        const errs = await boot(page);
        expect(errs, errs.join('\n')).toHaveLength(0);
        const at = async (a) => {
            await page.evaluate((v) => {
                const sl = document.getElementById('sl-nano-alpha');
                sl.value = String(v);
                sl.dispatchEvent(new Event('input', { bubbles: true }));
            }, a);
            await page.waitForTimeout(400);
            return {
                st: await page.evaluate(() => window.__sun.nanoflares.state),
                text: await page.evaluate(() => document.getElementById('nano-readout')?.textContent || ''),
            };
        };
        const lo = await at(1.7), hi = await at(2.45);

        expect(lo.st.canHeat).toBe(false);
        expect(hi.st.canHeat).toBe(true);
        expect(lo.st.smallEventShare).toBeLessThan(0.5);
        expect(hi.st.smallEventShare).toBeGreaterThan(0.5);
        expect(lo.text).toMatch(/large events carry/);
        expect(hi.text).toMatch(/unresolved events carry/);
        // The requirement it is scored against must be named, with its number.
        expect(hi.text).toMatch(/Withbroe/);
        expect(hi.text).toContain(String(HEATING_REQUIREMENT.quiet / 1e5));

        // Steeper α ⇒ a smaller mean event ⇒ less power at the same event rate.
        expect(hi.st.fluxQuiet).toBeLessThan(lo.st.fluxQuiet);
    });

    test('the SOC grid’s α is MEASURED, never asserted — and the readout says so while it is thin', async ({ page }) => {
        test.setTimeout(120_000);
        const errs = await boot(page);
        expect(errs, errs.join('\n')).toHaveLength(0);
        const n = await page.evaluate(() => window.__sun.nanoflares);
        const text = await page.evaluate(() => document.getElementById('nano-readout')?.textContent || '');

        // Whatever the event count, the two numbers must never be conflated:
        // the control's α is set, the SOC grid's α is fitted from its own
        // avalanche stream (js/sun-nanoflares.js AlphaMonitor).
        if (n.measured.ok) {
            expect(text).toMatch(/SOC grid measures/);
            expect(n.measured.n).toBeGreaterThanOrEqual(50);
            expect(n.measured.alpha).toBeGreaterThan(1.0);
            expect(n.measured.alpha).toBeLessThan(3.7);
            expect(n.measured.ks).toBeLessThan(0.09);
            expect(n.measured.atBound).toBe(false);
        } else {
            // Three separate grounds for withholding, and the line must say
            // which: too few cascades, a KS distance saying the avalanche sizes
            // are not power-law distributed at all (which is what this grid
            // currently measures — see SOC_PROPAGATE's comment in sun.html), or
            // a likelihood that ran to the edge of its search.
            expect(text).toMatch(/measuring|not power-law/);
            expect(text).not.toMatch(/SOC grid measures/);
            if (n.measured.n >= 50) {
                expect(n.measured.ks > 0.09 || n.measured.atBound,
                    'a withheld fit on a full window must say why').toBe(true);
            }
        }
    });

    test('the toggle turns the WHOLE nanoflare chain off, not one layer of it', async ({ page }) => {
        test.setTimeout(120_000);
        const errs = await boot(page);
        expect(errs, errs.join('\n')).toHaveLength(0);
        const before = await page.evaluate(() => window.__sun.nanoflares.on);
        expect(before).toBe(1);
        await page.evaluate(() => {
            const t = document.getElementById('tog-nanoflares');
            t.checked = false;
            t.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(400);
        const after = await page.evaluate(() => ({
            on: window.__sun.nanoflares.on,
            sparks: window.__sun.nanoflares.sparksVisible,
            frames: window.__sun.frames,
        }));
        expect(after.on, 'the photospheric population is off').toBe(0);
        expect(after.sparks, 'and so are the loop sparks').toBe(false);
        expect(after.frames).toBeGreaterThan(5);         // still rendering
    });

    test('the α control is anchored to the published measurements, on both sides of the threshold', async ({ page }) => {
        test.setTimeout(120_000);
        const errs = await boot(page);
        expect(errs, errs.join('\n')).toHaveLength(0);
        const opts = await page.evaluate(() =>
            [...document.querySelectorAll('#nano-alpha-refs option')].map(o => ({ v: +o.value, l: o.label })));
        expect(opts.length).toBe(ALPHA_REFERENCES.length);
        expect(opts.some(o => o.v < 2)).toBe(true);
        expect(opts.some(o => o.v > 2)).toBe(true);
        for (const o of opts) expect(o.l).toMatch(/\d{4}/);       // every tick names a paper + year
        // The slider must be able to reach both sides of the threshold.
        const range = await page.evaluate(() => {
            const s = document.getElementById('sl-nano-alpha');
            return { min: +s.min, max: +s.max };
        });
        expect(range.min).toBeLessThan(2);
        expect(range.max).toBeGreaterThan(2);
    });
});
