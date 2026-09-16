/**
 * solar-system-rope.spec.js — the modeled CME train on the orrery, drawn as
 * flux-rope surfaces (js/orrery-rope-layer.js).
 *
 * DONKI is egress-blocked from CI, so this drives the REAL committed WASM
 * through the REAL shared provider with injected fixture CMEs, then publishes
 * the result on the exact contract the layer consumes (window.__fluxRopeForecast
 * + the 'flux-rope-forecast' event). Nothing about the geometry is faked: the
 * apex distances asserted below are the kernel's own apexKmAt.
 *
 * What this pins, and why each one is a bug that already has a shape:
 *
 *   - a compounding TRAIN draws one rope per member, not one cloud
 *   - the rope leaves along the FLARE'S azimuth (the frame identity — if it
 *     drifts, a flare and its own CME sit on opposite limbs)
 *   - ROPES ARE BALLISTIC: scrubbing the clock moves Earth and NOT the rope's
 *     heading, which is the whole reason the corridor refuses to co-rotate them
 *   - the apex ARRIVES at the drawn Earth orbit — the picture and the ETA are
 *     one claim, which the particle burst this replaces could never manage
 *   - scrubbing BACKWARD un-launches the train (no per-frame accumulator)
 *   - an idle/failed provider draws NOTHING, and the particle burst is
 *     suppressed while a rope is up so two CMEs never disagree on screen
 */

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { logSceneRadius } from '../js/neo-orbits.js';
import { SUN_DRAWN_R } from '../js/orrery-rope-layer.js';

const IGNORED_CONSOLE_ERRORS = [
    /fonts\.googleapis\.com/, /\/api\/telemetry\//, /\/api\/horizons/, /\/api\/noaa\//,
    /\/api\/donki\//, /\/api\/solar/, /\/api\/health/, /\/api\/neo\//, /\/api\/cme\//,
    /services\.swpc\.noaa\.gov/, /Failed to load resource/, /net::ERR/, /\[swpc-feed\]/,
    /\[earth-sim-bridge\]/, /supabase/i, /WebSocket/, /upstream_unavailable/,
    /flux-rope provider/,
];

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        const location = message.location?.()?.url || '';
        if (IGNORED_CONSOLE_ERRORS.some((p) => p.test(text) || p.test(location))) return;
        errors.push(text);
    });
    return errors;
}

// A two-CME compounding train: a fast halo, then a second launched 9 h later
// from a different longitude — the §16 interaction case the provider models.
const LAUNCH_ISO = '2026-07-19T06:00:00Z';
const TRAIN = [
    { timeIso: LAUNCH_ISO, speedKms: 1250, lonDeg: 4, latDeg: -3, halfAngleDeg: 42, earthDirected: true },
    { timeIso: '2026-07-19T15:00:00Z', speedKms: 900, lonDeg: 22, latDeg: 8, halfAngleDeg: 35, earthDirected: true },
];

async function openPage(page) {
    // Every live feed is unrouted here and degrades by design.
    await page.route('**/services.swpc.noaa.gov/**', (r) => r.abort());
    await page.route('**/api/**', (r) => r.fulfill({
        status: 502, contentType: 'application/json', body: '{"error":"upstream_unavailable"}',
    }));
    await page.goto('/solar-system.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__orreryRopes && !!window.__solarFlare, null, { timeout: 45_000 });
}

/**
 * Run the REAL provider in the page with fixture CMEs and publish the result
 * on the contract the layer listens to. Returns the launch epoch in ms.
 */
async function publishForecast(page, { cmes = TRAIN, nowMs } = {}) {
    const wasmBytes = Array.from(new Uint8Array(
        await readFile(fileURLToPath(new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url)))));
    return page.evaluate(async ({ cmes, nowMs, wasmBytes }) => {
        const { computeFluxRopeForecast } = await import('/js/flux-rope-forecast.js');
        const fc = await computeFluxRopeForecast({
            sources: { cmes, rtsw: null, wasm: new Uint8Array(wasmBytes) },
            nowMs, relevanceFilter: false,
        });
        if (fc.idle) throw new Error('fixture produced an idle forecast: ' + fc.reason);
        window.__fluxRopeForecast = fc;
        window.dispatchEvent(new CustomEvent('flux-rope-forecast', { detail: fc }));
        return { launchMs: fc.launchMs, ropes: fc.preset.ropes?.length ?? 1 };
    }, { cmes, nowMs: nowMs ?? Date.parse('2026-07-20T12:00:00Z'), wasmBytes });
}

/**
 * Drive the PAGE's own clock to an absolute instant and let its animate loop
 * place the train. Calling `ropeLayer.update()` directly does not work and must
 * not be used: the RAF loop calls it every frame with the page's real sim time
 * and silently overwrites anything a test poked in behind it.
 */
async function scrubTo(page, ms) {
    await page.evaluate((ms) => {
        window.__solarFlare.setSimSpeed(0);       // hold the instant we set
        window.__solarFlare.setSimDate(ms);
    }, ms);
    // Two frames: one to move the clock, one for the layer's own rebuild.
    await page.waitForTimeout(420);
    const landed = await page.evaluate(() => window.__solarFlare.simDateMs);
    expect(Math.abs(landed - ms)).toBeLessThan(60_000);
}

test.describe('solar-system.html — modeled CME train as flux ropes', () => {
    test.setTimeout(150_000);

    test('a compounding train draws one rope per member, on the kernel', async ({ page }) => {
        const errors = collectPageErrors(page);
        await openPage(page);

        // Nothing published yet ⇒ nothing drawn. A dead feed must look dead.
        const before = await page.evaluate(() => window.__orreryRopes.state);
        expect(before.ropeCount).toBe(0);
        expect(before.groupVisible).toBe(false);

        const pub = await publishForecast(page);
        expect(pub.ropes).toBe(2);

        // Well after both launches: both ropes in flight, both on the kernel.
        await scrubTo(page, pub.launchMs + 20 * 3600e3);
        const s = await page.evaluate(() => window.__orreryRopes.state);
        expect(s.ropeCount).toBe(2);
        expect(s.drawn).toBe(2);
        expect(s.groupVisible).toBe(true);
        expect(s.oracle).toEqual(['kernel', 'kernel']);
        // The first-launched rope leads the train.
        expect(s.apexAu[0]).toBeGreaterThan(s.apexAu[1]);
        expect(s.apexAu.every((a) => a > 0 && a < 1.35)).toBe(true);

        expect(errors, errors.join('\n')).toEqual([]);
    });

    test('the rope leaves along the flare azimuth, and does not co-rotate', async ({ page }) => {
        await openPage(page);
        const pub = await publishForecast(page);
        await scrubTo(page, pub.launchMs + 20 * 3600e3);

        // The frame identity, read off the live scene: rope 0's heading is the
        // azimuth flare-geometry would put a Stonyhurst site at, for Earth's
        // azimuth at THAT rope's launch.
        const geo = await page.evaluate(async () => {
            const FG = await import('/js/flare-geometry.js');
            const L = window.__orreryRopes;
            const fc = window.__fluxRopeForecast;
            const rope = (fc.preset.ropes ?? [fc.preset.rope])[0];
            const az = L.state.azRad[0];
            const dir = FG.heliocentricSiteDirection({
                latRad: rope.latDeg * Math.PI / 180,
                lonRad: rope.lonDeg * Math.PI / 180,
                earthAzRad: az, spinSign: 1,
            });
            // The nose marker is the drawn apex; its azimuth is the rope heading.
            const nose = L.group.children[0].children.find((c) => c.type === 'Mesh' && c.geometry.type === 'SphereGeometry');
            const p = nose.position;
            return {
                drawnAz: Math.atan2(p.z, p.x),
                expectAz: FG.heliocentricAzimuth(dir),
                drawnLat: Math.asin(p.y / Math.hypot(p.x, p.y, p.z)),
                expectLat: rope.latDeg * Math.PI / 180,
                azAtLaunch: az,
            };
        });
        const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
        expect(Math.abs(wrap(geo.drawnAz - geo.expectAz))).toBeLessThan(1e-6);
        expect(Math.abs(geo.drawnLat - geo.expectLat)).toBeLessThan(1e-6);

        // BALLISTIC: advance the clock 5 days. Earth moves ~5° along its orbit;
        // the rope's heading must not follow it. (The rope itself is long gone
        // past L1 by then, so read the frozen basis, which is what holds it.)
        const azBefore = geo.azAtLaunch;
        await scrubTo(page, pub.launchMs + 5 * 86400e3);
        const azAfter = await page.evaluate(() => window.__orreryRopes.state.azRad[0]);
        expect(azAfter).toBe(azBefore);
    });

    test('the apex arrives at the drawn Earth orbit — the picture is the ETA', async ({ page }) => {
        await openPage(page);
        const pub = await publishForecast(page);

        // Walk the clock until the kernel says rope 0's apex has reached 1 AU,
        // then assert the DRAWN nose is on the page's own drawn Earth orbit.
        const arrivalMs = await page.evaluate(({ launchMs }) => {
            const fc = window.__fluxRopeForecast;
            const AU_KM = 1.495978707e8;
            // Bisect on the kernel's own apex — no re-derived kinematics.
            let lo = 0, hi = 6 * 86400;
            for (let i = 0; i < 60; i++) {
                const mid = 0.5 * (lo + hi);
                if (fc.kernel.apexKmAt(0, mid) / AU_KM >= 1) hi = mid; else lo = mid;
            }
            return launchMs + hi * 1000;
        }, { launchMs: pub.launchMs });

        await scrubTo(page, arrivalMs);
        const hit = await page.evaluate(() => {
            const L = window.__orreryRopes;
            const nose = L.group.children[0].children.find(
                (c) => c.type === 'Mesh' && c.geometry.type === 'SphereGeometry');
            return {
                apexAu: L.state.apexAu[0],
                noseR: Math.hypot(nose.position.x, nose.position.y, nose.position.z),
            };
        });

        expect(hit.apexAu).toBeGreaterThan(0.99);
        expect(hit.apexAu).toBeLessThan(1.01);
        // 1 AU lands exactly on logSceneRadius(1) — the orbit the page draws Earth on.
        expect(Math.abs(hit.noseR - logSceneRadius(1))).toBeLessThan(0.05);

        // And the arrival the ensemble reports agrees with the instant we drew it.
        const summary = await page.evaluate(() => window.__fluxRopeForecast.summary);
        expect(Math.abs(arrivalMs - summary.arrivalP50Ms) / 3600e3).toBeLessThan(24);
    });

    test('scrubbing backward un-launches the train; the surface never bulbs at the Sun', async ({ page }) => {
        await openPage(page);
        const pub = await publishForecast(page);

        // Before launch: nothing drawn. A per-frame accumulator (the particle
        // burst this replaces) could not do this — it had no launch epoch.
        await scrubTo(page, pub.launchMs - 6 * 3600e3);
        expect((await page.evaluate(() => window.__orreryRopes.state)).drawn).toBe(0);

        // Just after launch: rope 0 only (rope 1 launches 9 h later).
        await scrubTo(page, pub.launchMs + 30 * 60e3);
        expect((await page.evaluate(() => window.__orreryRopes.state)).drawn).toBe(1);

        // Mid-transit, measure the drawn surface: every vertex outside the Sun,
        // and the base snug to it. Under the page's raw radial map the footpoints
        // would be flung onto a 2.5-unit shell — the bulb this layer's own map
        // exists to prevent.
        await scrubTo(page, pub.launchMs + 14 * 3600e3);
        const geom = await page.evaluate(() => {
            const mesh = window.__orreryRopes.group.children[0].children.find(
                (c) => c.type === 'Mesh' && c.geometry.type === 'BufferGeometry');
            const a = mesh.geometry.attributes.position.array;
            let rMin = Infinity, rMax = -Infinity, bad = 0;
            for (let i = 0; i < a.length; i += 3) {
                const r = Math.hypot(a[i], a[i + 1], a[i + 2]);
                if (!Number.isFinite(r)) { bad++; continue; }
                if (r < rMin) rMin = r;
                if (r > rMax) rMax = r;
            }
            return { rMin, rMax, bad, verts: a.length / 3 };
        });
        expect(geom.bad).toBe(0);
        expect(geom.verts).toBeGreaterThan(500);
        expect(geom.rMin).toBeGreaterThanOrEqual(SUN_DRAWN_R - 1e-3);
        expect(geom.rMin).toBeLessThan(SUN_DRAWN_R + 0.4);
        expect(geom.rMax).toBeLessThan(logSceneRadius(1));

        // And back to before launch again — state is a function of the clock,
        // never an accumulator.
        await scrubTo(page, pub.launchMs - 6 * 3600e3);
        expect((await page.evaluate(() => window.__orreryRopes.state)).drawn).toBe(0);
    });

    test('the toggle hides it, and an idle provider draws nothing', async ({ page }) => {
        await openPage(page);
        const pub = await publishForecast(page);
        await scrubTo(page, pub.launchMs + 20 * 3600e3);
        expect((await page.evaluate(() => window.__orreryRopes.state)).groupVisible).toBe(true);

        // The HUD lives in the top band and this page scrolls (#solar-data-section
        // is below the fold), so Playwright's scroll-into-view puts the control
        // under the nav. Pin the page at the top and click it where a user would.
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.locator('#tog-ropes').uncheck();
        expect((await page.evaluate(() => window.__orreryRopes.state)).groupVisible).toBe(false);
        await page.locator('#tog-ropes').check();
        expect((await page.evaluate(() => window.__orreryRopes.state)).groupVisible).toBe(true);

        // An idle publish clears the train — never a fabricated rope left on screen.
        await page.evaluate(() => {
            const fc = { idle: true, reason: 'cme-train-passed' };
            window.__fluxRopeForecast = fc;
            window.dispatchEvent(new CustomEvent('flux-rope-forecast', { detail: fc }));
        });
        const idle = await page.evaluate(() => window.__orreryRopes.state);
        expect(idle.ropeCount).toBe(0);
        expect(idle.groupVisible).toBe(false);
    });
});
