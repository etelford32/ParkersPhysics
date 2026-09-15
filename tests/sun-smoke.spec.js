/**
 * sun-smoke.spec.js — boot + 7-layer + animation smoke test
 * ═══════════════════════════════════════════════════════════════════════════
 * Verifies sun.html loads without console / shader-compile errors, all seven
 * structural layers (core, radiative, convective, photosphere, chromosphere,
 * transition region, corona) toggle without throwing, and the render loop keeps
 * advancing. Mirrors the style of upper-atmosphere-smoke.spec.js, leaning on
 * the exposed `window.__sun` handle.
 *
 * This is the Phase-0 regression guard for the convection visual upgrade
 * (see SUN_CONVECTION_UPGRADE_PLAN.md): a shader-compile failure in the
 * photosphere / interior shaders surfaces here as a console error.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { solarEphemeris } from '../js/sun-observed.js';

const PAGE = '/sun.html';
const BOOT_TIMEOUT_MS = 20_000;

// ── Observed-disk fixtures (SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 1) ─────────
// The synthetic SDO frames under tests/fixtures/sdo stand in for
// /api/solar/aia so CI never needs nasa.gov. See that folder's README.
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sdo');
const FIXTURE_MANIFEST = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

/** Serve the synthetic frame for the requested channel, with the provenance header the page reads. */
// Stamp frames 7 min old by default so the chip reads live (the manifest's
// noon epoch would honestly read 'expired' by the afternoon — and did).
async function routeAiaToFixtures(page, { observedAt = new Date(Date.now() - 7 * 60 * 1000).toISOString() } = {}) {
    const hits = [];
    await page.route('**/api/solar/aia*', (route) => {
        const u = new URL(route.request().url());
        const ch = u.searchParams.get('channel') || 'white';
        hits.push(ch);
        const frame = FIXTURE_MANIFEST.frames[ch] || FIXTURE_MANIFEST.frames.white;
        route.fulfill({
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'X-AIA-Channel': ch,
                'X-AIA-Mode': 'live',
                'X-SDO-Observed-At': observedAt,
                'Access-Control-Expose-Headers': 'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At',
            },
            body: readFileSync(join(FIXTURE_DIR, frame.file)),
        });
    });
    return hits;
}

/** Make the proxy fail like a sandbox without egress (502 JSON, the route's real failure shape). */
async function routeAiaDown(page) {
    await page.route('**/api/solar/aia*', (route) => route.fulfill({
        status: 502, contentType: 'application/json',
        body: JSON.stringify({ error: 'aia_unavailable', detail: 'test: feed down' }),
    }));
}

function attachConsoleRecorder(page) {
    const errors = [];
    page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push({ text: msg.text(), location: msg.location() });
    });
    page.on('pageerror', (err) => errors.push({ text: err.message, stack: err.stack }));
    return errors;
}

// Live space-weather feeds (NOAA SWPC, NASA DONKI/HEK, SDO/SOHO imagery) and the
// Supabase / CDN clients routinely fail in a sandbox; the page is built to
// degrade to its procedural model. Those are expected, not page faults. Shader
// compile errors ("THREE.WebGLProgram: Shader Error", program info logs) do NOT
// match this filter, so they still fail the test.
// `telemetry` + 501: /api/telemetry/log answers 501 not_configured wherever
// SUPABASE_SERVICE_KEY is absent (any sandbox running dev-server.mjs) — the
// same expected-degradation class as the supabase entry above. 502: the
// same-origin /api/noaa/passthrough mirror gateways NOAA and answers 502
// when the sandbox has no outbound network; the console text carries only
// the status, never the URL, so the status code is the only handle.
function isExpectedNoise(text) {
    // A shader-compile failure dumps the whole GLSL source, whose comments
    // mention swpc/noaa/sdo — so without this guard the noise filter below
    // swallowed a broken corona shader (measured: coronaFS failed to compile
    // for a full run while every test stayed green). Compile errors are
    // never noise.
    if (/Shader Error|GLSL|ERROR: 0:|program not valid|Program Info Log/i.test(text || '')) return false;
    return /supabase|jsdelivr|unpkg|cdn|Failed to fetch|net::ERR|ERR_|CORS|swpc|noaa|donki|\bhek\b|nasa|soho|sdo|gibs|celestrak|telemetry|429|404|501|502|503|net::/i
        .test(text || '');
}

const LAYER_TOGGLES = [
    'tog-core', 'tog-radiative', 'tog-convective',
    'tog-photosphere', 'tog-chrom', 'tog-tr', 'tog-corona',
];

test.describe('sun.html smoke', () => {

    // Pre-seed cookie consent so the banner never mounts and intercepts clicks.
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch (e) {}
        });
    });

    test('boots and renders frames without shader/console errors', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        // Let the WebGL scene + post-processing render several frames; a broken
        // shader would have logged a compile error by now.
        await page.waitForFunction(() => window.__sun.frames > 5, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(800);

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no unexpected console / shader-compile errors').toHaveLength(0);
    });

    test('all 7 structural layers toggle without throwing', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(500);

        // Flip every layer toggle and flip it back, exercising the visibility
        // wiring + any isolation-uniform side effects in both directions.
        // The real checkboxes are visually hidden behind styled rows, so drive
        // them programmatically and fire the 'change' event the page listens for
        // (exercises the real visibility handlers without click flake).
        const setLayer = (id, on) => page.evaluate(({ id, on }) => {
            const el = document.getElementById(id);
            if (el.checked !== on) {
                el.checked = on;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, { id, on });

        // Flip every layer to the opposite of its default, then back.
        for (const id of LAYER_TOGGLES) {
            const before = await page.evaluate((i) => document.getElementById(i).checked, id);
            await setLayer(id, !before);
            await page.waitForTimeout(60);
            await setLayer(id, before);
            await page.waitForTimeout(60);
        }

        // Drive a concrete cutaway-style state: interior on, photosphere off.
        await setLayer('tog-core', true);
        await setLayer('tog-convective', true);
        await setLayer('tog-photosphere', false);
        await page.waitForTimeout(150);
        const vis = await page.evaluate(() => ({
            core:        window.__sun.layers.core.visible,
            convective:  window.__sun.layers.convective.visible,
            photosphere: window.__sun.layers.photosphere.visible,
        }));
        expect(vis.core, 'core visible after check').toBe(true);
        expect(vis.convective, 'convective visible after check').toBe(true);
        expect(vis.photosphere, 'photosphere hidden after uncheck').toBe(false);

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors while toggling layers').toHaveLength(0);
    });

    test('animation loop keeps advancing', async ({ page }) => {
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        const f0 = await page.evaluate(() => window.__sun.frames);
        await page.waitForTimeout(1000);
        const f1 = await page.evaluate(() => window.__sun.frames);
        expect(f1, 'frame counter advances over ~1s').toBeGreaterThan(f0 + 5);
    });

    test('cutaway peel toggles + depth slider without throwing', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(500);

        // Enable cutaway (checkbox is visually hidden — fire the change event).
        await page.evaluate(() => {
            const el = document.getElementById('tog-cutaway');
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(250);

        // Interior convective shell is revealed; the photosphere mesh stays in
        // the scene (it is clipped per-fragment, not hidden).
        const on = await page.evaluate(() => ({
            convective:  window.__sun.layers.convective.visible,
            photosphere: window.__sun.layers.photosphere.visible,
        }));
        expect(on.convective, 'convective revealed in cutaway').toBe(true);
        expect(on.photosphere, 'photosphere mesh stays (clipped, not hidden)').toBe(true);

        // Sweep the cut-depth slider (drives u_cutOffset).
        await page.evaluate(() => {
            const s = document.getElementById('sl-cutdepth');
            for (const v of ['10', '85', '45']) {
                s.value = v;
                s.dispatchEvent(new Event('input', { bubbles: true }));
            }
        });
        await page.waitForTimeout(150);

        // Disable cutaway again; the convective shell returns to its prior state.
        await page.evaluate(() => {
            const el = document.getElementById('tog-cutaway');
            el.checked = false;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(150);

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors toggling cutaway + slider').toHaveLength(0);
    });

    test('Doppler velocity view toggles cleanly', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(500);

        await page.evaluate(() => {
            const el = document.getElementById('tog-doppler');
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(250);
        const on = await page.evaluate(() => ({
            photosphere: window.__sun.layers.photosphere.visible,
            corona: window.__sun.layers.corona.visible,
            legend: document.getElementById('doppler-legend')?.style.display,
        }));
        expect(on.photosphere, 'photosphere shown in Doppler mode').toBe(true);
        expect(on.corona, 'corona hidden in Doppler mode').toBe(false);
        expect(on.legend, 'legend visible in Doppler mode').toBe('block');

        await page.evaluate(() => {
            const el = document.getElementById('tog-doppler');
            el.checked = false;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(200);
        const legendOff = await page.evaluate(() => document.getElementById('doppler-legend')?.style.display);
        expect(legendOff, 'legend hidden after exit').toBe('none');

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors toggling Doppler').toHaveLength(0);
    });

    test('EUV / magnetogram wavelength views cycle cleanly', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(500);

        // Cycle every channel (304/171/193/211/131/magnetogram) then back to white light.
        for (const v of ['1', '2', '3', '4', '5', '6', '0']) {
            await page.evaluate((val) => {
                const el = document.getElementById('view-mode');
                el.value = val;
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }, v);
            await page.waitForTimeout(150);
            const mode = await page.evaluate(() => window.__sun.uniforms.u_viewMode.value);
            expect(mode, `u_viewMode set to ${v}`).toBe(parseFloat(v));
        }

        // A channel view hides the white-light corona shell.
        await page.evaluate(() => {
            const el = document.getElementById('view-mode');
            el.value = '1';
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await page.waitForTimeout(150);
        const coronaInChannel = await page.evaluate(() => window.__sun.layers.corona.visible);
        expect(coronaInChannel, 'corona hidden in channel view').toBe(false);

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors cycling wavelength views').toHaveLength(0);
    });

    // ── Observed disk (Phase 1) ──────────────────────────────────────────────
    test('feed down → boots in MODEL mode, chip says so, u_obsOn stays 0', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        await routeAiaDown(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.observed && window.__sun.observed.reason === 'feed-down', { timeout: BOOT_TIMEOUT_MS });
        const st = await page.evaluate(() => ({
            obsOn: window.__sun.uniforms.u_obsOn.value,
            mode:  window.__sun.observed.mode,
            chip:  document.getElementById('sun-provenance').textContent,
            cls:   document.getElementById('sun-provenance').className,
        }));
        expect(st.obsOn, 'u_obsOn is 0 with no frame').toBe(0);
        expect(st.mode).toBe('model');
        expect(st.chip).toMatch(/^MODEL · procedural photosphere · feed down$/);
        expect(st.cls).toContain('prov-model');
        // The procedural photosphere still renders (this IS the CI path).
        await page.waitForFunction(() => window.__sun.frames > 5, { timeout: BOOT_TIMEOUT_MS });
        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors on the feed-down path').toHaveLength(0);
    });

    test('observed by default: fixture frame wraps the disk, chip says OBSERVED with instrument + age, rotation goes real-time', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        const hits = await routeAiaToFixtures(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.frames > 5, { timeout: BOOT_TIMEOUT_MS });
        const st = await page.evaluate(() => {
            const u = window.__sun.uniforms;
            return {
                obsOn: u.u_obsOn.value, hasTex: !!u.u_obsTex.value, kind: u.u_obsKind.value,
                geom: u.u_obsGeom.value.toArray(), b0: u.u_obsB0.value,
                rot: u.u_rot.value, hudRot: document.getElementById('hud-rot').textContent,
                state: window.__sun.observed,
                chip: document.getElementById('sun-provenance').textContent,
                cls: document.getElementById('sun-provenance').className,
            };
        });
        expect(hits[0], 'first fetch is the white-light frame').toBe('white');
        expect(st.obsOn).toBe(1);
        expect(st.hasTex).toBe(true);
        expect(st.kind).toBe(0);
        expect(st.state.channel).toBe('white');
        expect(st.state.pAngleApplied, 'P is exposed, not applied').toBe(false);
        // The chip carries BOTH sources: the disk's provenance, then the
        // off-limb annulus's (js/sun-offlimb.js). Anchored at the start so the
        // disk half cannot drift; the suffix is asserted on its own below.
        expect(st.chip).toMatch(/^OBSERVED · SDO\/HMI continuum · \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · 7 min old/);
        expect(st.cls).toContain('prov-observed');
        // Disk geometry is MEASURED from the frame (synthetic HMI: r = 0.465 of the frame).
        expect(st.state.geometry).toBe('measured');
        expect(Math.abs(st.geom[2] - 0.465)).toBeLessThan(0.465 * 0.012);
        // B0 is the ephemeris value for the frame's observation time (today − 7 min).
        expect(Math.abs(st.b0 * 180 / Math.PI - solarEphemeris(new Date()).b0Deg)).toBeLessThan(0.05);
        // Observed ⇒ real-time rotation multiplier, and the HUD says so.
        expect(st.rot).toBeLessThan(0.01);
        expect(st.hudRot).toContain('real-time');
        // Phase 2 post chain is live: a 6-mip bloom chain at 720p and a finite
        // luminance readback (the exposure controller is being fed).
        const post = await page.evaluate(() => window.__sun.post.state);
        expect(post.mips).toBe(6);
        expect(Number.isFinite(post.avgLogLum), 'luminance readback works').toBe(true);
        expect(post.bloomEnabled && post.flareEnabled).toBe(true);
        expect(post.lens, 'lens effects are OFF by default in Observed mode').toBe(false);
        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors on the observed path').toHaveLength(0);
    });

    test('EUV mode fetches the matching AIA frame; cutaway / Doppler drop to MODEL and restore; chip click toggles', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        const hits = await routeAiaToFixtures(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
        const setView = (v) => page.evaluate((val) => {
            const el = document.getElementById('view-mode');
            el.value = val; el.dispatchEvent(new Event('change', { bubbles: true }));
        }, v);
        const setTog = (id, on) => page.evaluate(({ id, on }) => {
            const el = document.getElementById(id);
            if (el.checked !== on) { el.checked = on; el.dispatchEvent(new Event('change', { bubbles: true })); }
        }, { id, on });
        const obs = () => page.evaluate(() => ({
            on: window.__sun.uniforms.u_obsOn.value, kind: window.__sun.uniforms.u_obsKind.value,
            geomR: window.__sun.uniforms.u_obsGeom.value.z,
            st: window.__sun.observed, chip: document.getElementById('sun-provenance').textContent,
        }));

        // Plant three ARs (SWPC is unreachable in CI) so the PFSS atlas has
        // arcades to splat; the mount's first refresh reads liveRegions.
        await page.evaluate(() => window.__sun.setRegions([
            { loc: 'N15W20', area: 420, mag: 'beta-gamma' }, { loc: 'S12E35', area: 260, mag: 'beta' }, { loc: 'N22E60', area: 140, mag: 'beta' },
        ]));
        // 171 Å → the AIA frame (kind 1, AIA disk fraction ≈ 0.390 measured).
        await setView('2');
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed' && window.__sun.observed.channel === '171', { timeout: BOOT_TIMEOUT_MS });
        let s = await obs();
        expect(hits).toContain('171');
        expect(s.kind).toBe(1);
        expect(Math.abs(s.geomR - 0.390)).toBeLessThan(0.390 * 0.012);
        expect(s.chip).toMatch(/^OBSERVED · SDO\/AIA 171 Å/);

        // Phase 3: the channel view mounts the volumetric AIA corona (it used
        // to draw none), the accumulation pass integrates frames, and the
        // arcades come from the PFSS atlas splatted into the loop volume.
        await page.waitForFunction(() => window.__sun.coronaVol && window.__sun.coronaVol.mesh.visible
            && window.__sun.coronaAccum?.state.frames > 1, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.coronaVol.loopOn || window.__sun.coronaVol.loopStats, { timeout: BOOT_TIMEOUT_MS });
        const cor = await page.evaluate(() => ({
            channel: window.__sun.coronaVol.currentChannel, loopOn: window.__sun.coronaVol.loopOn,
            stats: window.__sun.coronaVol.loopStats, accum: window.__sun.coronaAccum.state,
            layer: window.__sun.coronaVol.mesh.layers.mask, whiteShell: window.__sun.layers.corona.visible,
        }));
        expect(cor.channel).toBe('171');
        expect(cor.layer, 'corona mesh renders on layer 1 (the accumulation pass), not the main pass').toBe(2);
        expect(cor.whiteShell, 'white-light shell hidden in a channel view').toBe(false);
        expect(cor.accum.active).toBe(true);
        expect(cor.loopOn, `PFSS loop volume built (${JSON.stringify(cor.stats)})`).toBe(true);
        expect(cor.stats.closed).toBeGreaterThan(0);

        // Magnetogram → HMI LOS (kind 2); no EUV corona over a magnetogram.
        await setView('6');
        await page.waitForFunction(() => window.__sun.observed?.channel === 'mag' && window.__sun.observed.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
        s = await obs();
        expect(s.kind).toBe(2);
        await page.waitForFunction(() => window.__sun.coronaVol && !window.__sun.coronaVol.mesh.visible, { timeout: BOOT_TIMEOUT_MS });
        await setView('0');
        await page.waitForFunction(() => window.__sun.observed?.channel === 'white' && window.__sun.observed.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
        // Back in white light the multit shell (with the Thomson K-corona) is the corona again.
        await page.waitForFunction(() => window.__sun.layers.corona.visible && !window.__sun.coronaVol.mesh.visible, { timeout: BOOT_TIMEOUT_MS });

        // Cutaway is a MODEL view: observed off while peeled, back when un-peeled.
        await setTog('tog-cutaway', true);
        await page.waitForTimeout(150);
        s = await obs();
        expect(s.on).toBe(0);
        expect(s.chip).toMatch(/^MODEL · procedural photosphere · cutaway$/);
        await setTog('tog-cutaway', false);
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
        s = await obs();
        expect(s.on).toBe(1);

        // Doppler likewise.
        await setTog('tog-doppler', true);
        await page.waitForTimeout(150);
        s = await obs();
        expect(s.on).toBe(0);
        expect(s.chip).toMatch(/^MODEL · procedural photosphere · Doppler$/);
        await setTog('tog-doppler', false);
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });

        // The chip is the toggle: click → Model (sim rotation restored), click → Observed.
        await page.evaluate(() => document.getElementById('sun-provenance').click());
        await page.waitForTimeout(100);
        s = await obs();
        expect(s.on).toBe(0);
        expect(s.chip).toMatch(/^MODEL · procedural photosphere$/);
        const rotModel = await page.evaluate(() => window.__sun.uniforms.u_rot.value);
        expect(rotModel).toBeGreaterThanOrEqual(0.2);
        await page.evaluate(() => document.getElementById('sun-provenance').click());
        await page.waitForFunction(() => window.__sun.observed?.mode === 'observed', { timeout: BOOT_TIMEOUT_MS });
        s = await obs();
        expect(s.on).toBe(1);

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors switching observed/model').toHaveLength(0);
    });

    test('?observed=0 boots in MODEL mode by user choice (rotation stays the sim rate)', async ({ page }) => {
        await routeAiaToFixtures(page);
        await page.goto(PAGE + '?observed=0');
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForTimeout(300);
        const st = await page.evaluate(() => ({
            on: window.__sun.uniforms.u_obsOn.value, rot: window.__sun.uniforms.u_rot.value,
            chip: document.getElementById('sun-provenance').textContent,
        }));
        expect(st.on).toBe(0);
        expect(st.rot).toBe(1);
        expect(st.chip).toMatch(/^MODEL · procedural photosphere$/);
    });

    // ── OBSERVED OFF-LIMB ANNULUS (js/sun-offlimb.js, plan Phase 3b) ────────
    // The physics argument is in that module's header: an off-limb EUV pixel
    // is a line integral and plane-of-sky is its native geometry, so the
    // 1.0-1.6 R☉ ring of the live 304 + 131 frames is drawn on the plane
    // through Sun centre normal to the Sun-Earth line. These gates pin the
    // three things that make that honest rather than decorative: the plane is
    // in the OBSERVER's frame, it fades when the viewer leaves that frame, and
    // the chip never claims a layer that is not drawing.

    test('off-limb: both channels load, the plane is normal to the Sun-Earth line, and the chip names them', async ({ page }) => {
        const errors = attachConsoleRecorder(page);
        const hits = await routeAiaToFixtures(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(
            () => (window.__sun.offLimb?.channels || []).filter(c => c.ok).length === 2,
            { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.frames > 5, { timeout: BOOT_TIMEOUT_MS });

        expect(hits, 'the layer fetches its own two channels').toEqual(expect.arrayContaining(['304', '131']));

        const st = await page.evaluate(() => {
            const m = window.__sun.offLimbMesh;
            // The mesh's +Z is the plane normal by construction (observerBasis).
            const n = new window.__sun.THREE.Vector3(0, 0, 1).applyQuaternion(m.quaternion);
            const u = m.material.uniforms;
            return {
                state: window.__sun.offLimb,
                visible: m.visible,
                normal: n.toArray(),
                axis: u.u_axis.value,
                diff: u.u_diff.value,
                onA: u.u_onA.value, onB: u.u_onB.value,
                refA: u.u_refA.value, refB: u.u_refB.value,
                geomA: u.u_geomA.value.toArray(),
                radial: u.u_radial.value.toArray(),
                camera: window.__sun.camera.position.toArray(),
                chip: document.getElementById('sun-provenance').textContent,
            };
        });

        expect(st.onA).toBe(1);
        expect(st.onB).toBe(1);
        expect(st.visible, 'the annulus draws').toBe(true);
        // Reference-shell photometry succeeded on both frames — a layer that
        // could not measure its own unit must NOT draw (the REF_FLOOR guard).
        expect(st.refA).toBeGreaterThan(0);
        expect(st.refB).toBeGreaterThan(0);

        // THE PLANE IS IN THE OBSERVER'S FRAME. Its normal is Earth's
        // direction (0, sin B0, cos B0) — not the camera's, not the sphere's.
        const b0 = solarEphemeris(new Date()).b0Deg * Math.PI / 180;
        expect(Math.abs(st.normal[0])).toBeLessThan(1e-6);
        expect(Math.abs(st.normal[1] - Math.sin(b0))).toBeLessThan(2e-3);
        expect(Math.abs(st.normal[2] - Math.cos(b0))).toBeLessThan(2e-3);

        // The annulus spans the limb to 1.6 R☉ — the sphere is radius 1, so an
        // inner radius at or inside 1 would fight the observed disk.
        expect(st.radial[0]).toBe(1);
        expect(st.radial[2]).toBeCloseTo(1.6, 6);
        // The AIA disk fraction is MEASURED per frame (synthetic AIA: 0.390).
        expect(Math.abs(st.geomA[2] - 0.390)).toBeLessThan(0.390 * 0.02);

        // The load camera sits ON the Sun-Earth line, so the plane-of-sky the
        // frame encodes IS the viewer's and the layer is at full weight.
        expect(st.axis).toBeGreaterThan(0.99);
        expect(st.diff).toBe(0);
        expect(st.chip).toContain(' · off-limb 304+131');

        const filtered = errors.filter((e) => !isExpectedNoise(e.text));
        if (filtered.length) console.error('Console errors:', filtered);
        expect(filtered, 'no errors on the off-limb path').toHaveLength(0);
    });

    test('off-limb: fades out as the camera leaves the Sun-Earth line, and the chip says so', async ({ page }) => {
        await routeAiaToFixtures(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(
            () => (window.__sun.offLimb?.channels || []).some(c => c.ok), { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.offLimbMesh?.visible === true, { timeout: BOOT_TIMEOUT_MS });

        // Orbit 70° off the Sun-Earth line. The plane is then seen nearly
        // edge-on: holding the frame there would be a claim about 3-D
        // structure a plane-of-sky integral does not carry.
        // autoRotate off first, or the camera drifts back out from under the
        // assertion while the software rasteriser takes its time.
        await page.evaluate(() => { window.__sun.controls.autoRotate = false; });
        await page.evaluate(() => {
            const r = window.__sun.camera.position.length();
            const a = 70 * Math.PI / 180;
            window.__sun.camera.position.set(Math.sin(a) * r, 0, Math.cos(a) * r);
            window.__sun.camera.lookAt(0, 0, 0);
        });
        await page.waitForFunction(() => window.__sun.offLimbMesh?.visible === false, { timeout: BOOT_TIMEOUT_MS });
        const off = await page.evaluate(() => ({
            axis: window.__sun.offLimbMesh.material.uniforms.u_axis.value,
            chip: document.getElementById('sun-provenance').textContent,
        }));
        expect(off.axis).toBe(0);
        // Faded out is NOT the same as absent — the chip must not let a blank
        // sky imply a quiet Sun.
        expect(off.chip).toContain('(off-axis)');

        // Back on the line, it comes back. (Not a one-way gate.)
        await page.evaluate(() => {
            const r = window.__sun.camera.position.length();
            window.__sun.camera.position.set(0, 0, r);
            window.__sun.camera.lookAt(0, 0, 0);
        });
        await page.waitForFunction(() => window.__sun.offLimbMesh?.visible === true, { timeout: BOOT_TIMEOUT_MS });
        const back = await page.evaluate(() => window.__sun.offLimbMesh.material.uniforms.u_axis.value);
        expect(back).toBeGreaterThan(0.9);
    });

    test('off-limb: running difference needs two distinct observations and says so until it has them', async ({ page }) => {
        await routeAiaToFixtures(page);
        await page.goto(PAGE + '?offlimb=diff');
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(
            () => (window.__sun.offLimb?.channels || []).some(c => c.ok), { timeout: BOOT_TIMEOUT_MS });
        const st = await page.evaluate(() => ({
            diff: window.__sun.offLimbMesh.material.uniforms.u_diff.value,
            state: window.__sun.offLimb,
            chip: document.getElementById('sun-provenance').textContent,
        }));
        expect(st.diff).toBe(1);
        // One observation in hand: a difference against itself is not a
        // difference, and the chip refuses to imply a quiet corona.
        expect(st.state.diffReady).toBe(false);
        expect(st.chip).toContain('(awaiting next frame)');
        expect(st.chip).toMatch(/· off-limb Δ304\+131/);
    });

    test('off-limb: the PLANTED off-limb features render where the frame put them', async ({ page }) => {
        // THE END-TO-END GATE. Everything above checks state and uniforms; this
        // one goes through the real shader to the real pixels, and it is what
        // catches a handedness error — the class of bug that mirrored every
        // SWPC flare for months (CLAUDE.md, Stonyhurst is west-positive).
        //
        // The fixture generator plants two off-limb features at KNOWN
        // plane-of-sky positions (scripts/lib/sdo-synth.mjs PLANTED_OFFLIMB):
        // a 304 prominence off the EAST limb and a 131 arcade off the WEST.
        // Each must render bright at its own position and not at a
        // feature-free reference point on the same annulus radius.
        //
        // Self-validating: the same measurement runs with the layer OFF, and
        // the contrast must collapse. A gate that has stopped seeing the layer
        // fails instead of passing.
        await routeAiaToFixtures(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(
            () => (window.__sun.offLimb?.channels || []).filter(c => c.ok).length === 2,
            { timeout: BOOT_TIMEOUT_MS });
        await page.evaluate(() => { window.__sun.controls.autoRotate = false; });
        await page.waitForFunction(() => window.__sun.frames > 20, { timeout: BOOT_TIMEOUT_MS });

        const PROBES = {
            prom:   [-1.18,  0.10],      // PROM-E   (304, east limb)
            arcade: [ 1.14, -0.22],      // ARCADE-W (131, west limb)
            // Each feature's MIRROR in x. A mapping that flipped handedness
            // would light these instead. They are far enough from the other
            // feature (0.32 R☉, >4σ) that neither leaks into the other.
            promX:   [ 1.18,  0.10],
            arcadeX: [-1.14, -0.22],
            refUp:  [ 0.00,  1.18],      // feature-free, same annulus
            refDn:  [ 0.00, -1.18],
        };

        /** Plane-of-sky (R☉) → screen pixels, through the page's own camera. */
        const screenOf = (probes) => page.evaluate(({ probes }) => {
            const T = window.__sun.THREE, cam = window.__sun.camera;
            const el = window.__sun.renderer.domElement;
            const r = el.getBoundingClientRect();
            const b = window.__sun.offLimbMesh.quaternion;
            const out = {};
            for (const [k, [x, y]] of Object.entries(probes)) {
                // The mesh's own basis IS the plane-of-sky frame, so the probe
                // goes through the same transform the shader's vPlane does.
                const v = new T.Vector3(x, y, 0).applyQuaternion(b).project(cam);
                out[k] = [Math.round((v.x * 0.5 + 0.5) * r.width), Math.round((-v.y * 0.5 + 0.5) * r.height)];
            }
            return out;
        }, { probes });

        /** Median luminance in a small patch of a screenshot, per probe. */
        const sample = (b64, pts) => page.evaluate(async ({ b64, pts }) => {
            const img = new Image();
            await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = 'data:image/png;base64,' + b64; });
            const c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            const g = c.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0);
            const { data, width: W, height: H } = g.getImageData(0, 0, c.width, c.height);
            const out = {};
            for (const [k, [px, py]] of Object.entries(pts)) {
                const vals = [];
                for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
                    const x = px + dx, y = py + dy;
                    if (x < 0 || y < 0 || x >= W || y >= H) continue;
                    const i = (y * W + x) * 4;
                    vals.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
                }
                vals.sort((a, b) => a - b);
                out[k] = vals.length ? vals[vals.length >> 1] : 0;
            }
            return out;
        }, { b64, pts });

        // HIDE THE DOM. page.screenshot() captures the page, not the canvas, so
        // the HUD panels that overlay it land in the measurement — which is
        // how the first version of this gate read 227 (a bright panel) at a
        // probe that should have been empty sky. `visibility` is inherited, so
        // hiding everything and re-showing the canvas leaves the canvas visible
        // in place with its layout untouched.
        await page.addStyleTag({ content: 'body *{visibility:hidden!important} canvas{visibility:visible!important}' });
        const canvas = await page.locator('canvas').first().boundingBox();
        const pts = await screenOf(PROBES);
        const on = await sample((await page.screenshot({ clip: canvas })).toString('base64'), pts);

        // Turn the layer off and measure the same pixels. Anything left is the
        // scene underneath (bloom skirt, K-corona), which is what we divide out.
        await page.evaluate(() => { window.__sun.offLimbCtl.setEnabled(false); });
        await page.waitForFunction(() => window.__sun.offLimbMesh.visible === false, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.frames > 30, { timeout: BOOT_TIMEOUT_MS });
        const off = await sample((await page.screenshot({ clip: canvas })).toString('base64'), pts);

        const added = (k) => Math.max(0, on[k] - off[k]);
        const ref = Math.max(added('refUp'), added('refDn'), 1e-3);
        // eslint-disable-next-line no-console
        console.log('off-limb probes (on/off/added):', Object.fromEntries(
            Object.keys(PROBES).map(k => [k, [on[k].toFixed(1), off[k].toFixed(1), added(k).toFixed(1)]])));

        // The layer contributes SOMETHING everywhere on the annulus (the quiet
        // corona is real signal, not zero) …
        expect(added('refUp'), 'the quiet annulus draws').toBeGreaterThan(0.5);
        // … and much more where the frame actually has a feature.
        expect(added('prom') / ref, 'the 304 prominence is on the annulus').toBeGreaterThan(2.0);
        expect(added('arcade') / ref, 'the 131 arcade is on the annulus').toBeGreaterThan(1.5);
        // HANDEDNESS. Each feature must beat ITS OWN MIRROR, not the other
        // feature: the two channels normalise by their own reference shells
        // (131's quiet corona is fainter, so its feature stands out more), so
        // comparing them to each other measures the fixture, not the mapping.
        expect(added('prom'), `304 prominence EAST not west (east ${added('prom').toFixed(1)} vs west ${added('promX').toFixed(1)})`)
            .toBeGreaterThan(added('promX') * 2);
        expect(added('arcade'), `131 arcade WEST not east (west ${added('arcade').toFixed(1)} vs east ${added('arcadeX').toFixed(1)})`)
            .toBeGreaterThan(added('arcadeX') * 2);
    });

    test('off-limb: MODEL mode and a dead feed both remove the layer AND its claim', async ({ page }) => {
        await routeAiaToFixtures(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.offLimbMesh?.visible === true, { timeout: BOOT_TIMEOUT_MS });
        // Chip click → Model. The annulus is the same observation as the disk,
        // so it must go with it; an observed ring over a procedural disk would
        // be the chip lying by omission.
        await page.click('#sun-provenance');
        await page.waitForFunction(() => window.__sun.observed?.mode === 'model', { timeout: BOOT_TIMEOUT_MS });
        const model = await page.evaluate(() => ({
            visible: window.__sun.offLimbMesh.visible,
            enabled: window.__sun.offLimb.enabled,
            chip: document.getElementById('sun-provenance').textContent,
        }));
        expect(model.enabled).toBe(false);
        expect(model.visible).toBe(false);
        expect(model.chip).not.toContain('off-limb');
    });

    test('off-limb: a dead feed draws nothing and does not claim a corona', async ({ page }) => {
        await routeAiaDown(page);
        await page.goto(PAGE);
        await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
        await page.waitForFunction(() => window.__sun.observed?.mode === 'model', { timeout: BOOT_TIMEOUT_MS });
        const st = await page.evaluate(() => ({
            visible: window.__sun.offLimbMesh?.visible,
            channels: window.__sun.offLimb?.channels,
            chip: document.getElementById('sun-provenance').textContent,
        }));
        expect(st.visible).toBe(false);
        expect(st.channels.every(c => !c.ok), 'no channel calibrated').toBe(true);
        // Feeds down must look down (plan §5.4) — never a quiet sky.
        expect(st.chip).toMatch(/^MODEL/);
    });
});
