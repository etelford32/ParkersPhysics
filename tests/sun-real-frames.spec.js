/**
 * sun-real-frames.spec.js — sun.html on REAL NASA / NOAA browse frames
 * ═══════════════════════════════════════════════════════════════════════════
 * Until 2026-11-20 every Sun gate ran on SYNTHETIC frames, because the image
 * hosts were unreachable from the build sandbox. The first real frames showed
 * three things production visitors had been seeing and no gate could:
 *   • the off-limb ring blown out to a white-and-pink band (its reference
 *     shell sits at the browse product's display floor on a real frame);
 *   • AIA's burned-in caption drawn as white text under the Sun;
 *   • a LASCO C3 frame with half its field missing, drawn as it came.
 * tests/fixtures/sdo/real_* are those frames (scripts/fetch-sdo-fixtures.mjs).
 * They are REAL DATA: never hand-edit them; re-fetch and re-bake.
 *
 * Pixels are read from a page screenshot with the DOM hidden, at points
 * projected through the page's own camera and the off-limb mesh's own basis.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sdo');
const HAVE = existsSync(join(DIR, 'real-manifest.json'));
const REAL = HAVE ? JSON.parse(readFileSync(join(DIR, 'real-manifest.json'), 'utf8')) : { frames: {} };

async function routeReal(page, { c3 = 'c3_dropout' } = {}) {
    await page.route('**/api/solar/aia*', (route) => {
        const ch = new URL(route.request().url()).searchParams.get('channel') || 'white';
        const f = REAL.frames[ch === 'c3' ? c3 : ch];
        if (!f) return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"no_real_fixture"}' });
        route.fulfill({
            status: 200,
            headers: {
                'Content-Type': /\.png$/.test(f.file) ? 'image/png' : 'image/jpeg',
                'X-AIA-Channel': ch, 'X-AIA-Mode': 'live',
                'X-SDO-Observed-At': new Date(Date.now() - 7 * 60e3).toISOString(),
                ...((ch === 'c2' || ch === 'c3') ? { 'X-SOHO-Instrument': ch } : {}),
                ...(ch.startsWith('suvi') ? { 'X-SUVI-Band': ch.slice(4), 'X-SUVI-Source': f.source_id || 'swpc-animation-primary-png', 'X-SUVI-Satellite': 'primary' } : {}),
                'Access-Control-Expose-Headers': 'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At, X-SOHO-Instrument, X-SUVI-Band, X-SUVI-Source, X-SUVI-Satellite',
            },
            body: readFileSync(join(DIR, f.file)),
        });
    });
    await page.route((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u.href), (r) => r.abort());
}

async function boot(page, query = '') {
    await page.addInitScript(() => { try { localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 })); } catch (e) {} });
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error' && /Shader Error|GLSL|ERROR: 0:|Program Info Log/i.test(m.text())) errs.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    await routeReal(page);
    await page.goto('/sun.html' + query);
    await page.waitForFunction(() => window.__sun?.ready && window.__sun.frames > 5 && window.__sun.cam, null, { timeout: 60_000 });
    await page.waitForFunction(() => window.__sun.uniforms.u_obsOn.value > 0.5 && (window.__sun.offLimb?.channels || []).filter(c => c.ok).length === 2, null, { timeout: 60_000 });
    await page.evaluate(() => { const s = window.__sun; s.freeze(120); for (const id of ['tog-wind', 'tog-loops', 'tog-corona', 'tog-fieldlines', 'tog-prom', 'tog-cmetrain', 'tog-nanoflares']) { const el = document.getElementById(id); if (el && el.checked) el.click(); } });
    await page.waitForTimeout(5000);
    return errs;
}

/** Median luminance (0–255) of small patches at plane-of-sky points (R☉), through the page's own camera. */
async function probe(page, points, testInfo = null) {
    const px = await page.evaluate((points) => {
        const s = window.__sun, T = s.THREE, el = s.renderer.domElement, r = el.getBoundingClientRect(), q = s.offLimbMesh.quaternion;
        return Object.fromEntries(Object.entries(points).map(([k, [x, y]]) => {
            const v = new T.Vector3(x, y, 0).applyQuaternion(q).project(s.camera);
            return [k, [Math.round(r.left + (v.x * 0.5 + 0.5) * r.width), Math.round(r.top + (-v.y * 0.5 + 0.5) * r.height)]];
        }));
    }, points);
    await page.addStyleTag({ content: '#canvas-wrap > *:not(canvas), nav, #lsb-bar { visibility: hidden !important; }' });
    await page.waitForTimeout(600);
    const shot = await page.screenshot();
    // Keep the picture that was actually MEASURED (and what the page thought it
    // was drawing): a failure here is intermittent under load, and the
    // screenshot Playwright takes at failure time is a later frame.
    if (testInfo) {
        await testInfo.attach('probed-frame.png', { body: shot, contentType: 'image/png' });
        const state = await page.evaluate(() => { const s = window.__sun; return {
            layers: Object.fromEntries(Object.entries(s.layers).map(([k, m]) => [k, !!m?.visible])),
            togs: Object.fromEntries(['tog-wind', 'tog-loops', 'tog-corona', 'tog-fieldlines', 'tog-prom', 'tog-cmetrain', 'tog-nanoflares'].map(id => [id, document.getElementById(id)?.checked])),
            offLimb: s.offLimb, coronaVol: !!s.coronaVol?.mesh?.visible, view: document.getElementById('view-mode')?.value,
            flare: s.flareEvent, cam: s.camera.position.toArray(), px,
        }; }, px).catch((e) => ({ error: e.message }));
        await testInfo.attach('probed-state.json', { body: JSON.stringify(state, null, 1), contentType: 'application/json' });
    }
    const b64 = shot.toString('base64');
    return page.evaluate(async ({ b64, px }) => {
        const img = new Image();
        await new Promise((ok, bad) => { img.onload = ok; img.onerror = bad; img.src = 'data:image/png;base64,' + b64; });
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
        const { data, width: W, height: H } = g.getImageData(0, 0, c.width, c.height);
        const out = {};
        for (const [k, [x0, y0]] of Object.entries(px)) {
            const v = [];
            for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
                const x = x0 + dx, y = y0 + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue;
                const i = (y * W + x) * 4; v.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
            }
            v.sort((a, b) => a - b); out[k] = v.length ? v[v.length >> 1] : -1;
        }
        return out;
    }, { b64, px });
}
const ring = (rho, n, tag) => Object.fromEntries(Array.from({ length: n }, (_, i) => { const a = (i + 0.5) / n * 2 * Math.PI; return [`${tag}${i}`, [rho * Math.cos(a), rho * Math.sin(a)]]; }));
const stats = (o, tag) => { const v = Object.entries(o).filter(([k]) => k.startsWith(tag)).map(([, x]) => x).sort((a, b) => a - b); return { med: v[v.length >> 1], max: v[v.length - 1], min: v[0], white: v.filter(x => x > 245).length / v.length, n: v.length }; };

test.describe('sun.html on real browse frames', () => {
    test.skip(!HAVE, 'tests/fixtures/sdo/real-manifest.json is absent — run scripts/fetch-sdo-fixtures.mjs on a machine with egress');
    test.describe.configure({ timeout: 240_000 });

    test('SDO/AIA ring: a limb glow on black sky, no caption text, not a white band', async ({ page }, testInfo) => {
        const errs = await boot(page, '?offlimbSource=sdo&coronagraph=0');
        const off = await page.evaluate(() => window.__sun.offLimb);
        expect(off.sourceId).toBe('sdo');
        // The limb reference is far above the product's display floor (it was two code values).
        for (const c of off.channels) expect(c.ref, `${c.channel} reference`).toBeGreaterThan(0.01);
        const lum = await probe(page, {
            ...ring(1.03, 24, 'limb'), ...ring(1.42, 16, 'sky'),
            // AIA's caption: rows 987–1009 of 1024, columns 10–492 → ρ ≈ 1.19–1.75 below-left of the Sun.
            capA: [-0.35, -1.215], capB: [-0.70, -1.215], capC: [-1.05, -1.215],
        }, testInfo);
        const limb = stats(lum, 'limb'), sky = stats(lum, 'sky');
        console.log('AIA ring luminance:', JSON.stringify({ limb, sky, cap: [lum.capA, lum.capB, lum.capC] }));
        expect(limb.med, 'the limb glow is drawn').toBeGreaterThan(sky.med + 12);
        expect(limb.white, 'the limb is not a saturated white band').toBeLessThan(0.34);
        expect(sky.max, 'the sky beyond 1.4 R☉ is black — no amplified noise, no square').toBeLessThan(14);
        for (const k of ['capA', 'capB', 'capC']) expect(lum[k], `no caption text at ${k}`).toBeLessThan(14);
        expect(errs, errs.join('\n')).toEqual([]);
    });

    test('default: the ring is GOES/SUVI, and a LASCO frame with missing blocks is refused', async ({ page }) => {
        const errs = await boot(page);
        const off = await page.evaluate(() => window.__sun.offLimb);
        expect(off.sourceId, 'SUVI is the default off-limb source').toBe('suvi');
        expect(off.channels.every(c => c.ok)).toBe(true);
        expect(await page.textContent('#sun-provenance')).toContain('GOES/SUVI 304+131');
        // SUVI carries corona to 1.6 R☉ where AIA is black: outward it must FALL, smoothly.
        const lum = await probe(page, { ...ring(1.04, 24, 'a'), ...ring(1.25, 24, 'b'), ...ring(1.50, 24, 'c'), ...ring(1.90, 16, 'sky'), cap: [0.0, -1.57] });
        const a = stats(lum, 'a'), b = stats(lum, 'b'), c = stats(lum, 'c'), sky = stats(lum, 'sky');
        console.log('SUVI ring luminance:', JSON.stringify({ a: a.med, b: b.med, c: c.med, sky: sky.med, cap: lum.cap }));
        expect(a.med).toBeGreaterThan(b.med);
        expect(b.med).toBeGreaterThanOrEqual(c.med);
        expect(a.med, 'limb glow').toBeGreaterThan(sky.med + 20);
        expect(sky.max, 'nothing beyond the ring').toBeLessThan(14);
        expect(lum.cap, 'SUVI\'s caption strip is not drawn').toBeLessThan(14);

        // The coronagraph: C2 measured on the real frame, C3's dropout refused.
        await page.evaluate(() => { const s = window.__sun; s.cam.cancel('test'); s.camera.position.setLength(24); s.controls.update(); });
        await page.waitForFunction(() => /LASCO/.test(document.getElementById('sun-provenance').textContent), null, { timeout: 30_000 });
        const coro = await page.evaluate(() => ({ inst: window.__sun.coronagraph.instruments, chip: document.getElementById('sun-provenance').textContent }));
        const c2 = coro.inst.find(i => i.id === 'c2'), c3 = coro.inst.find(i => i.id === 'c3');
        expect(c2.drawn).toBe(true);
        expect(c2.geometry, 'the white limb circle was found in the real frame').toBe('measured');
        expect(Math.abs(c2.ringRatio - 1), `plate scale check, ring ratio ${c2.ringRatio}`).toBeLessThan(0.03);
        expect(c3.drawn, 'a frame with 11 % of its field missing is not drawn').toBe(false);
        expect(c3.incomplete).toBe(true);
        expect(coro.chip).toContain('LASCO C2 (C3 frame incomplete)');
        expect(errs, errs.join('\n')).toEqual([]);
    });
});
