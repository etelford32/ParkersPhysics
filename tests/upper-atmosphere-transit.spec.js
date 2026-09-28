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
    // The transit hands the camera to EXPLORE (flight along the sphere).
    expect(b.mode).toBe('explore');
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

test('nothing at the lens fills the screen: round capped points, a curved horizon, dot-sized probe markers', async ({ page }) => {
    // Measured at the 95 km floor before this gate: layer particles as
    // 30 px squares, transit gas as 71 px blobs, a 76 km probe ball
    // subtending 4.6°, and a polygon horizon from a 720-face planet.
    await boot(page);
    const orbit = await page.evaluate(() =>
        Object.values(window.__ua.globe._satProbes || {}).map(p => p.farGrp?.scale.x));
    // The default orbit view is untouched.
    expect(orbit.length).toBeGreaterThan(0);
    for (const s of orbit) expect(s).toBe(1);
    await page.evaluate(() => window.__ua.globe.startTransit({ mode: 'descend', kmPerSec: 200, fromKm: 100, toKm: 95, headingDeg: 90, pitchDeg: -4 }));
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
        const g = window.__ua.globe;
        const pts = [];
        g._scene.traverse(o => {
            const m = o.material;
            if (o.isPoints && m && !m.isShaderMaterial && m.sizeAttenuation) {
                pts.push({ kind: o.userData?.kind || o.name || 'points', map: !!m.map, cap: m.userData?.pointCapPx ?? null });
            }
        });
        const detail = g._skin.earthMesh.geometry.parameters.detail;
        const probes = Object.values(g._satProbes || {}).map(p => p.farGrp?.scale.x);
        return { pts, detail, probes, gl: g._renderer.getContext().getError() };
    });
    expect(r.pts.length).toBeGreaterThan(0);
    for (const p of r.pts) {
        expect(p.map, `${p.kind} is an untextured square`).toBe(true);
        expect(p.cap, `${p.kind} has no pixel ceiling`).not.toBeNull();
    }
    // Icosphere edge ≈ 63.43° / (detail + 1); its chord must sag < 1 km
    // below the sphere or the transit horizon is visibly a polygon.
    const edgeRad = (63.435 * Math.PI / 180) / (r.detail + 1);
    const sagKm = 6371 * (1 - Math.cos(edgeRad / 2));
    expect(sagKm).toBeLessThan(1);
    expect(Math.min(...r.probes)).toBeLessThan(1);
    expect(r.gl).toBe(0);
});
