/**
 * upper-atmosphere-transit.spec.js — browser gate for the layer transit and
 * the camera-local gas
 * ═══════════════════════════════════════════════════════════════════════════
 * The kernel is gated in node (`tests/upper-atmosphere-transit.mjs`). What
 * needs a browser: the descent actually moves the camera at the chosen
 * REAL-time rate (it must not depend on frame rate — measured 60 km/s for a
 * 200 km/s request when it rode the capped frame delta), the gas cloud
 * draws and recolours as the composition changes, the readouts follow, a
 * fly key releases the camera (the page may start a flight, not hold it),
 * and no GL error is raised.
 */

import { test, expect } from '@playwright/test';

const URL = '/upper-atmosphere.html';
const BOOT_MS = 30_000;
test.describe.configure({ timeout: 150_000 });

async function boot(page) {
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.globe?.getTransitState, { timeout: BOOT_MS });
    const consent = page.locator('.pp-consent-banner');
    await consent.waitFor({ state: 'visible', timeout: 8_000 }).catch(() => {});
    if (await consent.isVisible().catch(() => false)) {
        await consent.locator('[data-action="reject"]').click().catch(() => {});
    }
    await page.waitForTimeout(2000);
}

test('descend rides the local vertical in real time, the gas follows, a fly key releases', async ({ page }) => {
    const errs = [];
    page.on('console', (m) => { if (/Shader Error|not compiled|reserved word/i.test(m.text())) errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
    await boot(page);

    await page.locator('#ua-transit-rate').selectOption('200');
    await page.locator('#ua-transit-descend').click();
    const a = await page.evaluate(() => {
        const g = window.__ua.globe;
        return { st: g.getTransitState(), t: performance.now(), camAlt: g.getCameraAltitudeKm() };
    });
    expect(a.st.active).toBe(true);
    expect(a.st.mode).toBe('descend');
    expect(a.st.toKm).toBe(80.5);
    // Started from the model ceiling (the default camera sits at ~14 000 km).
    expect(a.st.fromKm).toBe(2000);
    await page.waitForTimeout(3000);
    const b = await page.evaluate(() => {
        const g = window.__ua.globe;
        const st = g.getTransitState();
        return {
            st, t: performance.now(), camAlt: g.getCameraAltitudeKm(),
            dots: g.getAmbientGasCount(), gas: g.getAmbientGas(),
            hudGas: document.getElementById('ua-cam-gas').textContent,
            hudMfp: document.getElementById('ua-cam-mfp').textContent,
            hudVth: document.getElementById('ua-cam-vth').textContent,
            transitRow: document.getElementById('ua-cam-transit-v').textContent,
            mode: g.getCameraMode(),
            gl: g._renderer.getContext().getError(),
            // The camera sits ON the local vertical above the transit's site.
            radial: (() => {
                const p = g._camera.position;
                return { lat: Math.asin(p.y / p.length()) * 180 / Math.PI, lon: Math.atan2(-p.z, p.x) * 180 / Math.PI };
            })(),
        };
    });
    const elapsedS = (b.t - a.t) / 1000;
    const expectedDrop = 200 * elapsedS;
    const drop = a.st.altKm - b.st.altKm;
    // Real time, not frame time: within 25 % of the nominal rate even on a
    // software renderer (the first frame after the click is a partial).
    expect(drop).toBeGreaterThan(expectedDrop * 0.75);
    expect(drop).toBeLessThan(expectedDrop * 1.25);
    expect(Math.abs(b.camAlt - b.st.altKm)).toBeLessThan(1);
    expect(Math.abs(b.radial.lat - b.st.latDeg)).toBeLessThan(0.01);
    expect(Math.abs(((b.radial.lon - b.st.lonDeg + 540) % 360) - 180)).toBeLessThan(0.01);
    expect(b.mode).toBe('fly');
    expect(b.dots).toBeGreaterThan(0);
    expect(b.gas.species.length).toBeGreaterThan(0);
    expect(b.hudGas).toMatch(/(H|He|O|N2) \d+%/);
    expect(b.hudMfp).toMatch(/(km|m)$/);
    expect(b.hudVth).toMatch(/\d+ m\/s/);
    expect(b.transitRow).toMatch(/⇣ 200 km\/s → 8[01] km/);
    expect(b.gl).toBe(0);

    // Releasing: a fly key hands the camera back and the controller keeps
    // the pose it was left in (no snap).
    const before = await page.evaluate(() => window.__ua.globe._camera.quaternion.toArray());
    await page.keyboard.press('w');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({
        st: window.__ua.globe.getTransitState(),
        q: window.__ua.globe._camera.quaternion.toArray(),
        row: document.getElementById('ua-cam-transit').hidden,
    }));
    expect(after.st.active).toBe(false);
    expect(after.row).toBe(true);
    const dq = Math.max(...after.q.map((v, i) => Math.abs(v - before[i])));
    expect(dq).toBeLessThan(0.15);
    expect(errs, errs.join('\n')).toEqual([]);
});

test('the gas cloud is denser and bluer low down than high up, and ascend goes back up', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(async () => {
        const g = window.__ua.globe;
        const wait = (ms) => new Promise(r => setTimeout(r, ms));
        g.startTransit({ mode: 'descend', kmPerSec: 200, fromKm: 1500, toKm: 1490 });
        await wait(900);
        const high = { dots: g.getAmbientGasCount(), gas: g.getAmbientGas() };
        g.startTransit({ mode: 'descend', kmPerSec: 200, fromKm: 95, toKm: 90 });
        await wait(900);
        const low = { dots: g.getAmbientGasCount(), gas: g.getAmbientGas() };
        g.startTransit({ mode: 'ascend', kmPerSec: 200 });
        await wait(1500);
        const up = g.getTransitState();
        return { high, low, up };
    });
    expect(r.low.dots).toBeGreaterThan(r.high.dots * 5);
    expect(r.low.gas.dominant).toBe('N2');
    expect(['H', 'He']).toContain(r.high.gas.dominant);
    expect(r.low.gas.mfp_km).toBeLessThan(r.high.gas.mfp_km / 1000);
    expect(r.up.mode).toBe('ascend');
    expect(r.up.altKm).toBeGreaterThan(200);
    expect(r.up.toKm).toBe(2000);
});
