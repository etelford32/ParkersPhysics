/**
 * sun-suvi-layer.spec.js — the GOES/SUVI source for the observed off-limb ring
 * ═══════════════════════════════════════════════════════════════════════════
 * SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 3e. Read js/suvi-geometry.js's header.
 *
 * What this gate is FOR. sun.html's off-limb annulus (js/sun-offlimb.js) draws
 * 1.0–1.6 R☉ of the live 304 + 131 frames, and its shader correctly refuses to
 * clamp-extend a border texel — so outside the frame it draws nothing. An
 * SDO/AIA half-frame stops at 1.280 R☉ on axis, which means the ring has only
 * ever been 65.9 % supplied: four dark lobes on the axes, and the viewer reads
 * the shape of the DETECTOR as the shape of the corona. GOES/SUVI reaches
 * 1.667 R☉ and supplies all of it.
 *
 * tests/suvi-geometry.mjs proves that in arithmetic. This proves it in PIXELS,
 * and pins the two things that would otherwise fail SILENTLY:
 *
 *   1. THE DISK FRACTION MUST FOLLOW THE INSTRUMENT. `resolveDiskGeometry`
 *      accepts a measured disk only within 12 % of the expected fraction, and
 *      SUVI's 0.300 is 23 % from AIA's 0.390. Resolved against the AIA
 *      fallback, an honest SUVI measurement is THROWN OUT and the ring draws
 *      30 % too small — frame loads, shader runs, every prominence misplaced.
 *   2. THE CHIP MUST NAME THE INSTRUMENT. SUVI 304 and AIA 304 are the same
 *      line, not the same measurement.
 *
 * The fixture set carries a planted feature, PROM-FAR-W, on the +x axis at
 * 1.50 R☉ — deliberately between the two instruments' on-axis reach, so it is
 * physically absent from the AIA frame and present in the SUVI one. Nothing
 * arranges that; it falls out of the plate scale. It is what lets the coverage
 * claim be measured rather than asserted.
 *
 * Runs fully offline: the synthetic fixtures stand in for /api/solar/aia.
 */

import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUVI_DISK_FRACTION, AIA_DISK_FRACTION } from '../js/suvi-geometry.js';

const PAGE = '/sun.html';
const BOOT_TIMEOUT_MS = 30_000;
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sdo');
const MANIFEST = JSON.parse(readFileSync(join(FIXTURE_DIR, 'manifest.json'), 'utf8'));

async function routeAia(page) {
    const hits = [];
    await page.route('**/api/solar/aia*', (route) => {
        const ch = new URL(route.request().url()).searchParams.get('channel') || 'white';
        hits.push(ch);
        const frame = MANIFEST.frames[ch];
        if (!frame) {
            // A channel we have no fixture for must fail like the real route,
            // never silently serve a different instrument's frame.
            return route.fulfill({ status: 502, contentType: 'application/json',
                body: JSON.stringify({ error: 'no_fixture', channel: ch }) });
        }
        route.fulfill({
            status: 200,
            headers: {
                'Content-Type': 'image/png',
                'X-AIA-Channel': ch,
                'X-AIA-Mode': 'live',
                'X-SDO-Observed-At': new Date(Date.now() - 7 * 60 * 1000).toISOString(),
                ...(ch.startsWith('suvi') ? {
                    'X-SUVI-Band': ch.slice(4),
                    'X-SUVI-Source': 'swpc-animation-primary-png',
                    'X-SUVI-Satellite': 'primary',
                } : {}),
                'Access-Control-Expose-Headers':
                    'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At, X-SUVI-Band, X-SUVI-Source, X-SUVI-Satellite',
            },
            body: readFileSync(join(FIXTURE_DIR, frame.file)),
        });
    });
    return hits;
}

/**
 * The page pulls a dozen unrelated live feeds (SWPC, HEK, DONKI, CDNs) that a
 * sandbox without egress refuses, so its console is never empty. This is the
 * SAME filter tests/sun-smoke.spec.js uses, and it carries the same scar: a
 * shader-compile failure dumps the whole GLSL source, whose comments mention
 * swpc/noaa/sdo — so the compile-error escape hatch MUST come first, or the
 * filter swallows a broken shader (measured once: coronaFS failed to compile
 * for a full run while every test stayed green). Compile errors are never
 * noise, and neither is anything naming this layer's own modules.
 */
function isExpectedNoise(text) {
    const t = text || '';
    if (/Shader Error|GLSL|ERROR: 0:|program not valid|Program Info Log/i.test(t)) return false;
    if (/suvi|off-?limb|sun-observed/i.test(t)) return false;
    return /supabase|jsdelivr|unpkg|cdn|Failed to fetch|net::ERR|ERR_|CORS|swpc|noaa|donki|\bhek\b|nasa|soho|sdo|gibs|celestrak|telemetry|429|404|501|502|503|net::/i
        .test(t);
}

async function bootWithSource(page, source) {
    const hits = await routeAia(page);
    const errors = [];
    const record = (t) => { if (!isExpectedNoise(t)) errors.push(t); };
    page.on('console', (m) => { if (m.type() === 'error') record(m.text()); });
    page.on('pageerror', (e) => record(e.message));
    await page.goto(PAGE + (source === 'suvi' ? '?offlimbSource=suvi' : ''));
    await page.waitForFunction(() => window.__sun?.ready, { timeout: BOOT_TIMEOUT_MS });
    await page.waitForFunction(
        () => (window.__sun.offLimb?.channels || []).filter(c => c.ok).length === 2,
        { timeout: BOOT_TIMEOUT_MS });
    await page.evaluate(() => { window.__sun.controls.autoRotate = false; });
    await page.waitForFunction(() => window.__sun.frames > 20, { timeout: BOOT_TIMEOUT_MS });
    return { hits, errors };
}

test.describe('off-limb: the GOES/SUVI source', () => {

    test('the layer fetches SUVI channels and resolves SUVI\'s OWN disk geometry', async ({ page }) => {
        const { hits, errors } = await bootWithSource(page, 'suvi');

        // It asked for the SUVI bands, not the AIA ones.
        expect(hits).toContain('suvi304');
        expect(hits).toContain('suvi131');

        const st = await page.evaluate(() => {
            const u = window.__sun.offLimbMesh.material.uniforms;
            return {
                sourceId: window.__sun.offLimb.sourceId,
                geomA: u.u_geomA.value.z,     // disk radius as a fraction of the frame
                geomB: u.u_geomB.value.z,
                onA: u.u_onA.value, onB: u.u_onB.value,
                coverage: window.__sun.offLimbCoverage,
                channels: window.__sun.offLimb.channels.map(c => ({ channel: c.channel, band: c.band, ok: c.ok })),
            };
        });

        expect(st.sourceId).toBe('suvi');
        expect(st.onA).toBe(1);
        expect(st.onB).toBe(1);

        // THE LOAD-BEARING ASSERTION. Both slots must carry SUVI's fraction
        // (~0.300), not AIA's (0.390). The fixture is 512² so the measured
        // radius lands within ~1 % of the derived value — tolerance is set by
        // the fixture's own resolution, not by the accuracy of the model.
        for (const r of [st.geomA, st.geomB]) {
            expect(Math.abs(r - SUVI_DISK_FRACTION) / SUVI_DISK_FRACTION).toBeLessThan(0.03);
            // …and provably NOT the AIA fallback, which is what a silent
            // instrument mix-up would leave here.
            expect(Math.abs(r - AIA_DISK_FRACTION) / AIA_DISK_FRACTION).toBeGreaterThan(0.15);
        }

        expect(st.coverage.fraction).toBeGreaterThan(0.999);
        expect(st.channels.map(c => c.band)).toEqual(['304', '131']);
        expect(errors).toEqual([]);
    });

    test('the chip names GOES/SUVI, and prints the band rather than the proxy channel', async ({ page }) => {
        await bootWithSource(page, 'suvi');
        const chip = await page.textContent('#sun-provenance');
        expect(chip).toContain('GOES/SUVI');
        expect(chip).toMatch(/304\+131/);
        // The proxy's namespacing is an implementation detail and must not leak.
        expect(chip).not.toContain('suvi304');
    });

    test('SUVI SHOWS WHAT AIA CANNOT: the 1.50 R☉ feature is in one frame and not the other', async ({ page }) => {
        // The whole argument for this layer, measured on pixels.
        //
        // PROM-FAR-W sits on the +x axis at 1.50 R☉. AIA's half-frame stops at
        // 1.280, so no AIA pixel exists there; SUVI's reaches 1.667, so one
        // does. Sample the SAME scene point under both sources and require the
        // SUVI render to be brighter there — while a control point at 1.15 R☉,
        // which BOTH frames cover, stays comparable. Without the control this
        // would pass on any overall brightness difference between sources.
        const PROBE   = [1.50, 0.0];
        const CONTROL = [1.15, 0.0];

        const sample = async (source) => {
            await bootWithSource(page, source);
            return page.evaluate(async ([probe, control]) => {
                const { camera, renderer } = window.__sun;
                const THREE = window.__sun.THREE;
                // Plane-of-sky point → screen pixel, through the layer's own mesh
                // so the projection is the one actually being drawn.
                const mesh = window.__sun.offLimbMesh;
                const toPixel = ([x, y]) => {
                    const v = new THREE.Vector3(x, y, 0);
                    mesh.localToWorld(v);
                    v.project(camera);
                    const rect = renderer.domElement;
                    return {
                        x: Math.round((v.x * 0.5 + 0.5) * rect.width),
                        y: Math.round((-v.y * 0.5 + 0.5) * rect.height),
                    };
                };
                const gl = renderer.getContext();
                const read = (p) => {
                    const buf = new Uint8Array(4);
                    // GL origin is bottom-left; the projection above is top-left.
                    gl.readPixels(p.x, renderer.domElement.height - p.y, 1, 1,
                                  gl.RGBA, gl.UNSIGNED_BYTE, buf);
                    return 0.2126 * buf[0] + 0.7152 * buf[1] + 0.0722 * buf[2];
                };
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
                return { probe: read(toPixel(probe)), control: read(toPixel(control)) };
            }, [PROBE, CONTROL]);
        };

        const suvi = await sample('suvi');
        const sdo  = await sample('sdo');

        // At 1.50 R☉ SUVI has a measurement and AIA has no frame at all.
        expect(suvi.probe).toBeGreaterThan(sdo.probe);
        expect(suvi.probe - sdo.probe).toBeGreaterThan(4);
        // At 1.15 R☉ both instruments cover the sky, so the layer is live in
        // both renders — this is what proves the difference above is FIELD OF
        // VIEW and not one source simply failing to draw.
        expect(sdo.control).toBeGreaterThan(2);
        expect(suvi.control).toBeGreaterThan(2);
    });

    test('switching source at runtime repoints the layer and keeps both frames', async ({ page }) => {
        const { hits, errors } = await bootWithSource(page, 'sdo');
        expect(hits).toContain('304');
        expect(hits).not.toContain('suvi304');

        await page.evaluate(() => window.__sun.setOffLimbSource('suvi'));
        await page.waitForFunction(
            () => window.__sun.offLimb.sourceId === 'suvi'
               && window.__sun.offLimb.channels.filter(c => c.ok).length === 2,
            { timeout: BOOT_TIMEOUT_MS });
        expect(hits).toContain('suvi304');

        const after = await page.evaluate(() => ({
            geom: window.__sun.offLimbMesh.material.uniforms.u_geomA.value.z,
            coverage: window.__sun.offLimbCoverage.fraction,
        }));
        expect(Math.abs(after.geom - SUVI_DISK_FRACTION) / SUVI_DISK_FRACTION).toBeLessThan(0.03);
        expect(after.coverage).toBeGreaterThan(0.999);

        // Back again: the SDO frames were kept, so this must not re-fetch.
        const before = hits.length;
        await page.evaluate(() => window.__sun.setOffLimbSource('sdo'));
        await page.waitForFunction(() => window.__sun.offLimb.sourceId === 'sdo', { timeout: BOOT_TIMEOUT_MS });
        const back = await page.evaluate(() => window.__sun.offLimbMesh.material.uniforms.u_geomA.value.z);
        expect(Math.abs(back - AIA_DISK_FRACTION) / AIA_DISK_FRACTION).toBeLessThan(0.03);
        expect(hits.length).toBe(before);
        expect(errors).toEqual([]);
    });

    test('the UI row states the coverage it computes, and the default stays SDO', async ({ page }) => {
        await bootWithSource(page, 'sdo');
        const row = await page.evaluate(() => ({
            checked: document.getElementById('tog-offlimb-suvi')?.checked,
            meta: document.getElementById('lm-offlimb-suvi')?.textContent,
            title: document.getElementById('lm-offlimb-suvi')?.title,
            sourceId: window.__sun.offLimb.sourceId,
        }));
        expect(row.sourceId).toBe('sdo');
        expect(row.checked).toBe(false);
        // The disclosure is the point: the default source does NOT cover the ring.
        expect(row.meta).toMatch(/66% of the ring/);
        expect(row.title).toMatch(/1\.28 R☉ on axis/);

        // The provenance tooltip is a disclosure and must track the source: on
        // SDO it has to SAY the ring is only partly supplied, because the
        // shader draws nothing outside the frame and a partly-covered ring
        // otherwise just looks like a partly-empty corona.
        const tipSdo = await page.getAttribute('#sun-provenance', 'title');
        expect(tipSdo).toContain('SDO/AIA');
        expect(tipSdo).toMatch(/supplies 66% of this annulus/);
        expect(tipSdo).toMatch(/drawn as nothing, never invented/);

        await page.click('#tog-offlimb-suvi');
        await page.waitForFunction(() => window.__sun.offLimb.sourceId === 'suvi', { timeout: BOOT_TIMEOUT_MS });
        const after = await page.evaluate(() => ({
            meta: document.getElementById('lm-offlimb-suvi').textContent,
            title: document.getElementById('lm-offlimb-suvi').title,
        }));
        expect(after.meta).toMatch(/100% of the ring/);
        expect(after.title).toMatch(/1\.67 R☉ on axis/);

        const tipSuvi = await page.getAttribute('#sun-provenance', 'title');
        expect(tipSuvi).toContain('GOES/SUVI');
        expect(tipSuvi).toMatch(/covers the whole annulus/);
        // …and it must no longer claim the SDO reach it used to.
        expect(tipSuvi).not.toMatch(/supplies 66%/);
    });
});
