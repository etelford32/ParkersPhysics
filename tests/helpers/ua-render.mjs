/**
 * tests/helpers/ua-render.mjs — solo renders of upper-atmosphere.html
 * ═══════════════════════════════════════════════════════════════════════════
 * The harness the image-metric specs share. `boot` loads the page with every
 * off-site request blocked (EarthSkin keeps its grey fallback, the feeds
 * their defaults), switches the globe onto the MANUAL frame clock from a
 * fixed instant, seeds the gas and hides the POI labels, and installs two
 * page-side helpers:
 *
 *   window.__uaSolo(keep, { overrideMaterial })
 *       render ONLY `keep` (and their ancestors/descendants, at the
 *       visibility the page gave them) on black and read the pixels back in
 *       the same task (the drawing buffer is not preserved), then restore.
 *       Returns { w, h, b64 } — RGBA, row 0 at the TOP.
 *   window.__uaLimb()
 *       per column, the row where the view ray grazes the unit sphere.
 *
 * `dumpPng` writes a capture as PNG when UA_METRICS_PNG=<dir> is set (a
 * 30-line encoder on node:zlib — the repo has no image dependency).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import * as zlib from 'node:zlib';   // namespace: crc32 is Node ≥ 22.2, and only the debug dump needs it
import { expect } from '@playwright/test';
import { imageFromCapture } from './image-metrics.mjs';

export const URL = '/upper-atmosphere.html';
export const DT = 1 / 60;
export const MEASURE = !!process.env.UA_METRICS_LOG;

export async function boot(page, { sceneTimeMs = null } = {}) {
    // The Earth textures and every live feed come from other hosts: block
    // them so the render is the same offline as online (EarthSkin keeps its
    // grey fallback, the feeds their defaults).
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
    await page.goto(URL);
    await page.waitForFunction(() => !!window.__ua?.globe?.stepFrames && !!window.__ua?.explore, null, { timeout: 60_000 });
    await page.evaluate(async (sceneTimeMs) => {
        const THREE = await import('three');
        window.__uaTHREE = THREE;
        const g = window.__ua.globe;
        g.setManualClock(true, { startMs: 1.0e6 });
        // Pin the SCENE instant too (sun, terminator, the fountain's clock),
        // or everything time-of-day depends on the day the test runs.
        if (Number.isFinite(sceneTimeMs)) g.setSceneTime(sceneTimeMs);
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
    }, sceneTimeMs);
}

export const step = (page, n, render = 'none') => page.evaluate(([n, dt, r]) => window.__ua.globe.stepFrames(n, dt, { render: r }), [n, DT, render]);

/** Land in explore mode at a known pose, on the manual clock. */
export async function landAt(page, where) {
    await page.evaluate((w) => window.__ua.globe.diveTo({ ...w, durationSec: 0.5 }), where);
    await step(page, 40);
    expect(await page.evaluate(() => window.__ua.globe.getCameraMode())).toBe('explore');
}

export function log(...a) { if (MEASURE) console.log('[metrics]', ...a); }

/** Debug: write a capture as PNG when UA_METRICS_PNG=<dir> (no image deps). */
export function dumpPng(name, cap) {
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
