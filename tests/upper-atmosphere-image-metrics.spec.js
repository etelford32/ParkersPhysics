/**
 * upper-atmosphere-image-metrics.spec.js — measure it, don't eyeball it
 * ═══════════════════════════════════════════════════════════════════════════
 * Four visual bugs on upper-atmosphere.html were found by eye in
 * screenshots (plan §9.5–9.6). Each is now a NUMBER measured on a solo
 * render — the one layer under test drawn alone on black, read back with
 * gl.readPixels — by the pure metrics in tests/helpers/image-metrics.mjs:
 *
 *   horizon    the planet's limb against the ANALYTIC limb (per-column ray
 *              tangency with the unit sphere): the 720-face icosphere's
 *              horizon was a polygon;
 *   membranes  the boundary grid seen grazing: an isotropic line width
 *              divided by the grazing cosine bloomed a latitude line into a
 *              30 px wedge, and a camera exactly ON a boundary, over a grid
 *              line, flooded a wedge of the view;
 *   aurora     the curtain across its 24 h MLT seam: non-periodic noise and
 *              folds left a hard edge at magnetic midnight;
 *   sprites    the nearest gas dot / layer particle: uncapped sprites drew
 *              71 px blobs and 30 px squares.
 *
 * EVERY GATE CARRIES ITS OWN NEGATIVE CONTROL, run in the same page: the old
 * bug is put back (geometry swapped, shader text patched, material replaced)
 * and the same metric must FAIL it. A metric that cannot see the bug is not
 * a gate, and a threshold set without a control is a guess.
 *
 * Runs on the manual frame clock (js/upper-atmosphere-frame-clock.js) from a
 * fixed start instant, with a seeded gas cloud and every off-site request
 * blocked, so every render is the same frame on every run.
 *
 * Tuning a threshold: `UA_METRICS_LOG=1` prints every measurement next to
 * its control's, and `UA_METRICS_PNG=<dir>` writes each solo render (and
 * its control) as a PNG. The membrane grid is measured at 16× gain because
 * the product draws it at ~8/255 on black; a width at half maximum does not
 * depend on the gain.
 */

import { test, expect } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as zlib from 'node:zlib';   // namespace: crc32 is Node ≥ 22.2, and only the debug dump needs it
import {
    horizonDeviation, lineWidths, firstLitRow, coverage, seamStep, blobStats, imageFromCapture,
} from './helpers/image-metrics.mjs';

const URL = '/upper-atmosphere.html';
const DT = 1 / 60;
const MEASURE = !!process.env.UA_METRICS_LOG;
test.describe.configure({ timeout: 240_000 });

async function boot(page) {
    // The Earth textures and every live feed come from other hosts: block
    // them so the render is the same offline as online (EarthSkin keeps its
    // grey fallback, the feeds their defaults).
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.globe?.stepFrames && !!window.__ua?.explore, null, { timeout: 60_000 });
    await page.evaluate(async () => {
        const THREE = await import('three');
        window.__uaTHREE = THREE;
        const g = window.__ua.globe;
        g.setManualClock(true, { startMs: 1.0e6 });
        g.seedRandom(1234);
        g.setBeaconsVisible(false);
        /**
         * Render ONLY `keep` (and their ancestors/descendants, at the
         * visibility the page gave them) on black, read the pixels back in
         * the same task (the drawing buffer is not preserved), restore.
         */
        window.__uaSolo = (keep, { overrideMaterial = null } = {}) => {
            const scene = g._scene, renderer = g._renderer, camera = g._camera;
            const keepSet = new Set();
            for (const k of keep) {
                k.traverse((o) => keepSet.add(o));
                for (let p = k.parent; p; p = p.parent) keepSet.add(p);
            }
            const saved = [];
            scene.traverse((o) => { saved.push([o, o.visible]); if (!keepSet.has(o)) o.visible = false; });
            const bg = scene.background, fog = scene.fog, ov = scene.overrideMaterial;
            scene.background = null; scene.fog = null;
            if (overrideMaterial) scene.overrideMaterial = overrideMaterial;
            const prevColor = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
            renderer.setClearColor(0x000000, 1);
            camera.updateMatrixWorld();
            renderer.render(scene, camera);
            const gl = renderer.getContext();
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const raw = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
            renderer.setClearColor(prevColor, prevAlpha);
            scene.background = bg; scene.fog = fog; scene.overrideMaterial = ov;
            for (const [o, v] of saved) o.visible = v;
            // Flip to row 0 at the top and base64 it.
            const out = new Uint8Array(w * h * 4);
            for (let y = 0; y < h; y++) out.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
            let s = '';
            for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
            return { w, h, b64: btoa(s) };
        };
        /** The analytic limb of the unit sphere: per column, the row where the ray grazes it. */
        window.__uaLimb = () => {
            const renderer = g._renderer, camera = g._camera;
            const gl = renderer.getContext();
            const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
            const V = camera.position.constructor;
            camera.updateMatrixWorld();
            const o = camera.position.clone();
            const d = new V();
            const hits = (nx, ny) => {
                d.set(nx, ny, 0.5).unproject(camera).sub(o).normalize();
                const b = o.dot(d), c = o.lengthSq() - 1;
                const disc = b * b - c;
                return disc >= 0 && -b + Math.sqrt(disc) > 0;
            };
            const rows = new Array(w).fill(NaN);
            for (let x = 0; x < w; x++) {
                const nx = (x + 0.5) / w * 2 - 1;
                if (hits(nx, 1) || !hits(nx, -1)) continue;
                let lo = -1, hi = 1;           // lo hits, hi misses
                for (let k = 0; k < 40; k++) { const m = 0.5 * (lo + hi); if (hits(nx, m)) lo = m; else hi = m; }
                rows[x] = (1 - 0.5 * (lo + hi)) / 2 * h;
            }
            return rows;
        };
    });
}

const step = (page, n, render = 'none') => page.evaluate(([n, dt, r]) => window.__ua.globe.stepFrames(n, dt, { render: r }), [n, DT, render]);

/** Land in explore mode at a known pose, on the manual clock. */
async function landAt(page, where) {
    await page.evaluate((w) => window.__ua.globe.diveTo({ ...w, durationSec: 0.5 }), where);
    await step(page, 40);
    expect(await page.evaluate(() => window.__ua.globe.getCameraMode())).toBe('explore');
}

function log(...a) { if (MEASURE) console.log('[metrics]', ...a); }

/** Debug: write a capture as PNG when UA_METRICS_PNG=<dir> (no image deps). */
function dumpPng(name, cap) {
    const dir = process.env.UA_METRICS_PNG;
    if (!dir) return;
    if (typeof zlib.crc32 !== 'function') { console.warn('UA_METRICS_PNG needs Node ≥ 22.2 (zlib.crc32)'); return; }
    const img = imageFromCapture(cap);
    const rowLen = img.w * 4 + 1;
    const raw = Buffer.alloc(rowLen * img.h);
    for (let y = 0; y < img.h; y++) Buffer.from(img.data.buffer, y * img.w * 4, img.w * 4).copy(raw, y * rowLen + 1);
    const chunk = (type, data) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(img.w, 0); ihdr.writeUInt32BE(img.h, 4); ihdr[8] = 8; ihdr[9] = 6;
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${name}.png`, Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
    ]));
}

test('the horizon is the sphere\'s, not a polygon\'s (control: the old 720-face planet)', async ({ page }) => {
    await boot(page);
    const poses = [
        { latDeg: 20, lonDeg: -40, altKm: 300, headingDeg: 90, pitchDeg: -8 },
        { latDeg: -35, lonDeg: 120, altKm: 110, headingDeg: 20, pitchDeg: -6 },
    ];
    for (const p of poses) {
        await landAt(page, p);
        const run = async (coarse) => page.evaluate((coarse) => {
            const THREE = window.__uaTHREE;
            const g = window.__ua.globe;
            const mesh = g._skin.earthMesh;
            const geo = mesh.geometry;
            if (coarse) mesh.geometry = new THREE.IcosahedronGeometry(1, 5);
            const flat = new THREE.MeshBasicMaterial({ color: 0xffffff });
            const cap = window.__uaSolo([mesh], { overrideMaterial: flat });
            if (coarse) { mesh.geometry.dispose(); mesh.geometry = geo; }
            flat.dispose();
            return { cap, limb: window.__uaLimb() };
        }, coarse);
        const now = await run(false);
        const old = await run(true);
        dumpPng(`horizon-${p.altKm}`, now.cap);
        dumpPng(`horizon-${p.altKm}-control`, old.cap);
        const a = horizonDeviation(imageFromCapture(now.cap), now.limb);
        const b = horizonDeviation(imageFromCapture(old.cap), old.limb);
        log('horizon', p.altKm, 'km', JSON.stringify(a), 'control', JSON.stringify(b));
        expect(a.columns, 'the limb crosses the frame').toBeGreaterThan(now.cap.w * 0.8);
        expect(a.maxDev).toBeLessThanOrEqual(2);
        expect(b.maxDev, 'the control (720 faces) must fail').toBeGreaterThan(4);
    }
});

/** Patch the membrane shader text (a control), render solo, restore. */
async function membraneCapture(page, patches = [], { gain = 1 } = {}) {
    return page.evaluate(([patches, gain]) => {
        const ex = window.__ua.globe._explore;
        const mat = ex._memMat;
        const g0 = mat.uniforms.uGain.value;
        mat.uniforms.uGain.value = g0 * gain;
        const src = mat.fragmentShader;
        let s = src;
        for (const [a, b] of patches) {
            if (!s.includes(a)) throw new Error('control patch did not apply: ' + a);
            s = s.split(a).join(b);
        }
        if (s !== src) { mat.fragmentShader = s; mat.needsUpdate = true; }
        const drawn = ex._memMesh.visible;
        const cap = window.__uaSolo([ex._memMesh]);
        if (s !== src) { mat.fragmentShader = src; mat.needsUpdate = true; }
        mat.uniforms.uGain.value = g0;
        return { cap, drawn };
    }, [patches, gain]);
}

// The first version's line width: isotropic, divided by the grazing cosine.
const ISOTROPIC_WIDTH = [[
    'float wLat = k * (abs(dot(px, north)) + abs(dot(py, north)));\n    float wLon = k * (abs(dot(px, east)) + abs(dot(py, east))) / cl;',
    'float wLat = k * t * uPixAng / max(cosInc, 0.02);\n    float wLon = wLat / cl;',
]];
// Lines on whole degrees (the equator is one) and no near fade.
const OLD_GRID_NO_NEAR_FADE = [
    ['abs(fract(x) - 0.5)', 'abs(fract(x + 0.5) - 0.5)'],
    ['smoothstep(nearA, 4.0 * nearA, t)', '1.0'],
];

test('a boundary grid seen grazing keeps thin lines (control: the isotropic width that bloomed a 30 px wedge)', async ({ page }) => {
    await boot(page);
    // Heading east at 10.5°N, 20 km above the 250 km boundary: the latitude
    // lines recede straight to the horizon under the camera.
    await landAt(page, { latDeg: 10.5, lonDeg: -40, altKm: 270, headingDeg: 90, pitchDeg: -8 });
    await step(page, 1);
    // The grid is a faint marker (line luma ~8 of 255 on black), so it is
    // measured at 16× gain — the width at half maximum does not depend on
    // the gain, only the 8-bit quantisation does.
    const now = await membraneCapture(page, [], { gain: 16 });
    const old = await membraneCapture(page, ISOTROPIC_WIDTH, { gain: 16 });
    dumpPng('membrane-grazing', now.cap);
    dumpPng('membrane-grazing-control', old.cap);
    expect(now.drawn, 'the membrane is drawn at 270 km').toBe(true);
    const iNow = imageFromCapture(now.cap), iOld = imageFromCapture(old.cap);
    const top = firstLitRow(iNow, { threshold: 20 });
    expect(top).toBeGreaterThan(0);
    // The line straight ahead recedes to the horizon at the centre of the
    // view: measure it alone, in a window narrower than the grid spacing.
    const win = { col0: Math.round(iNow.w / 2 - 28), col1: Math.round(iNow.w / 2 + 28), minContrast: 8 };
    const a = lineWidths(iNow, { ...win, row0: top + 6 }), b = lineWidths(iOld, { ...win, row0: top + 6 });
    log('membrane grazing', JSON.stringify(a), 'control', JSON.stringify(b));
    expect(a.count, 'the receding line was measured in (almost) every row').toBeGreaterThan((iNow.h - top) * 0.8);
    expect(a.max, 'widest the receding line gets, px at half maximum').toBeLessThanOrEqual(5);
    expect(b.max, 'the control (isotropic width) must bloom').toBeGreaterThanOrEqual(15);
});

test('a camera sitting on a boundary does not draw the boundary at its own position (control: whole-degree grid, no near fade)', async ({ page }) => {
    await boot(page);
    // 10 m above the 250 km boundary, exactly on the equator, heading along
    // it and looking down: every downward ray grazes the boundary a few
    // metres away, at the camera's own latitude.
    await landAt(page, { latDeg: 0, lonDeg: -90, altKm: 250.01, headingDeg: 90, pitchDeg: -30 });
    await step(page, 1);
    const now = await membraneCapture(page, [], { gain: 16 });
    const old = await membraneCapture(page, OLD_GRID_NO_NEAR_FADE, { gain: 16 });
    dumpPng('membrane-on-boundary', now.cap);
    dumpPng('membrane-on-boundary-control', old.cap);
    expect(now.drawn, 'the membrane is live at 250 km').toBe(true);
    const a = coverage(imageFromCapture(now.cap), { threshold: 8 });
    const b = coverage(imageFromCapture(old.cap), { threshold: 8 });
    log('membrane on-boundary', a, 'control', b);
    expect(a).toBeLessThan(0.002);
    expect(b, 'the control (old grid, no near fade) must flood').toBeGreaterThan(0.02);
});

/** The aurora alone, and where on screen its MLT seam (aS = 0) falls. */
async function auroraCapture(page, patches = [], { gain = 1 } = {}) {
    return page.evaluate(([patches, gain]) => {
        const g = window.__ua.globe, ex = g._explore, cam = g._camera;
        const mat = ex._auroraMat;
        const src = mat.fragmentShader;
        let s = src;
        for (const [a, b] of patches) {
            if (!s.includes(a)) throw new Error('control patch did not apply: ' + a);
            s = s.split(a).join(b);
        }
        if (s !== src) { mat.fragmentShader = s; mat.needsUpdate = true; }
        const f0 = mat.uniforms.uFade.value;
        mat.uniforms.uFade.value = f0 * gain;
        const drawn = ex._auroraGroup.visible;
        const cap = window.__uaSolo([ex._auroraGroup]);
        mat.uniforms.uFade.value = f0;
        if (s !== src) { mat.fragmentShader = src; mat.needsUpdate = true; }
        // Seam columns: project every seam vertex in front of the camera.
        const V = cam.position.constructor;
        const xs = [];
        for (const { mesh } of ex._auroraMeshes) {
            const pos = mesh.geometry.attributes.position, aS = mesh.geometry.attributes.aS;
            const v = new V();
            for (let i = 0; i < pos.count; i++) {
                if (aS.getX(i) !== 0) continue;
                v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).project(cam);
                if (v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1) xs.push((v.x + 1) / 2 * cap.w);
            }
        }
        return { cap, drawn, seamX: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, seamN: xs.length };
    }, [patches, gain]);
}

// Noise and folds that do not repeat every 24 h of MLT: the pattern jumps
// where the ring closes, at magnetic midnight.
const NON_PERIODIC = [
    ['return mix(hash1(mod(i, P)), hash1(mod(i + 1.0, P)), u);', 'return mix(hash1(i), hash1(i + 1.0), u);'],
    ['sin(vS * 1.5708 + uTime * 0.12 + 1.6 * sin(vS * 2.8798 + 0.7))', 'sin(vS * 1.3 + uTime * 0.12 + 1.6 * sin(vS * 2.5 + 0.7))'],
];

test('the auroral curtain closes on itself at magnetic midnight (control: noise and folds that do not repeat every 24 h)', async ({ page }) => {
    await boot(page);
    // The aurora POI faces the oval at MLT 0 — the ring's seam is dead ahead.
    await page.evaluate(() => window.__ua.globe.diveToPoi('aurora', { durationSec: 0.5 }));
    await step(page, 41);
    const now = await auroraCapture(page);
    const old = await auroraCapture(page, NON_PERIODIC);
    dumpPng('aurora', now.cap);
    dumpPng('aurora-control', old.cap);
    expect(now.drawn, 'the curtains are drawn at the aurora POI').toBe(true);
    expect(now.seamX, 'the seam is on screen').not.toBeNull();
    const iNow = imageFromCapture(now.cap), iOld = imageFromCapture(old.cap);
    expect(coverage(iNow, { threshold: 8 }), 'the curtain fills a good part of the view').toBeGreaterThan(0.15);
    // Column-to-column (win = 1): rays are smooth over several pixels, a
    // seam is a one-pixel jump. Averaged over every lit row.
    const top = firstLitRow(iNow, { threshold: 8 });
    const at = { row0: top, row1: iNow.h, win: 1, col0: Math.round(now.seamX - 80), col1: Math.round(now.seamX + 80) };
    const a = seamStep(iNow, at), b = seamStep(iOld, at);
    const whole = seamStep(iNow, { row0: top, row1: iNow.h, win: 1 });
    log('aurora seamX', now.seamX.toFixed(1), JSON.stringify(a), 'control', JSON.stringify(b), 'whole frame', JSON.stringify(whole));
    expect(a.step).toBeLessThan(0.2);
    expect(whole.step, 'no hard edge anywhere in the curtain').toBeLessThan(0.2);
    expect(b.step, 'the control (non-periodic) must show the seam').toBeGreaterThan(0.35);
    expect(Math.abs(b.at - now.seamX), 'and the control\'s edge is AT the seam').toBeLessThan(4);
});


/**
 * One sprite of `which` put `nearMul` × the camera's near distance in front
 * of the lens (just off the view axis; anything nearer is clipped) and drawn
 * alone, with the product's material and then with a control material (the
 * pre-fix one: uncapped, textured or not). Opacity is lifted to 1 for both —
 * it sets brightness, not size or shape.
 */
async function spriteCapture(page, which, control, nearMul) {
    return page.evaluate(([which, control, nearMul]) => {
        const THREE = window.__uaTHREE;
        const g = window.__ua.globe, cam = g._camera;
        const pts = which === 'gas' ? g._transit._cloud
            : Object.values(g._particles).map((sy) => sy.points).find((p) => p.visible && p.geometry.drawRange.count > 0);
        if (!pts || !pts.visible || pts.geometry.drawRange.count < 1) return { error: `no visible ${which} sprites` };
        const geo = pts.geometry, pos = geo.attributes.position;
        const i = geo.drawRange.start;
        const saved = [pos.getX(i), pos.getY(i), pos.getZ(i)];
        const saveRange = { start: geo.drawRange.start, count: geo.drawRange.count };
        cam.updateMatrixWorld();
        const fwd = cam.getWorldDirection(new THREE.Vector3());
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
        const d = nearMul * cam.near;
        const world = cam.position.clone().addScaledVector(fwd, d).addScaledVector(right, 0.1 * d);
        const local = pts.worldToLocal(world.clone());
        pos.setXYZ(i, local.x, local.y, local.z); pos.needsUpdate = true;
        const m = pts.material, op = m.opacity;
        let cap, capOld;
        geo.setDrawRange(i, 1);
        try {
            m.opacity = 1;
            cap = window.__uaSolo([pts]);
            const old = new THREE.PointsMaterial({
                size: m.size, sizeAttenuation: true, vertexColors: m.vertexColors,
                map: control === 'textured' ? m.map : null,
                transparent: true, opacity: 1, depthWrite: false, blending: m.blending,
            });
            pts.material = old;
            capOld = window.__uaSolo([pts]);
            pts.material = m;
            old.dispose();
        } finally {
            m.opacity = op;
            geo.setDrawRange(saveRange.start, saveRange.count);
            pos.setXYZ(i, ...saved); pos.needsUpdate = true;
        }
        return { cap, capOld, distKm: d * 6371, capPx: m.userData.pointCapPx * g._renderer.getPixelRatio(), id: pts.userData?.id ?? pts.name };
    }, [which, control, nearMul]);
}


test('no point sprite fills the lens (controls: the uncapped gas dot, the uncapped untextured layer particle)', async ({ page }) => {
    await boot(page);
    // At the 95 km floor — where the gas drew 71 px blobs and the layer
    // particles 30 px squares.
    await landAt(page, { latDeg: 20, lonDeg: -40, altKm: 95, headingDeg: 90, pitchDeg: -4 });
    await step(page, 10);
    const cases = [
        { which: 'gas', control: 'textured' },       // it always had the soft dot; it lacked the cap
        { which: 'layer', control: 'untextured' },   // it lacked both
    ];
    for (const c of cases) {
        for (const nm of [1.1, 1.5, 3, 10]) {
            const r = await spriteCapture(page, c.which, c.control, nm);
            expect(r.error, r.error).toBeUndefined();
            dumpPng(`sprite-${c.which}-${nm}`, r.cap);
            dumpPng(`sprite-${c.which}-${nm}-control`, r.capOld);
            const a = blobStats(imageFromCapture(r.cap), { threshold: 3 });
            const b = blobStats(imageFromCapture(r.capOld), { threshold: 3 });
            log('sprite', c.which, r.id, `${r.distKm.toFixed(1)} km`, 'cap', r.capPx, JSON.stringify(a), 'control', JSON.stringify(b));
            expect(a.found, `${c.which} at ${nm}× near is drawn`).toBe(true);
            expect(Math.max(a.width, a.height), `${c.which} at ${nm}× near: size ≤ its cap`).toBeLessThanOrEqual(r.capPx + 2);
            // Round vs square only means something above a few pixels.
            if (a.width >= 6) expect(a.fill, `${c.which} at ${nm}× near: a disc, not a square`).toBeLessThan(0.9);
            if (nm === 1.1) {
                // Just past the near plane, the pre-fix sprite is far over its cap.
                expect(b.width, `the ${c.which} control must blow up`).toBeGreaterThan(2 * r.capPx);
                if (c.control === 'untextured') expect(b.fill, 'and be a square').toBeGreaterThan(0.95);
            }
        }
    }
});
