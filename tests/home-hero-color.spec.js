// @ts-check
/**
 * home-hero-color.spec.js — the homepage hero's ONE colour pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-24, js/hero-color.js. The node gate (tests/hero-color.mjs) pins the
 * JS mirror; this runs the GLSL on a real GL context against it, and checks
 * that the live scene is actually on the pipeline:
 *
 *   (1) THE ORACLE — linear values drawn through `heroRadiance` and the
 *       output pass come out as `outputTransform()` says, across the toe,
 *       the knee and deep HDR (incl. a saturated orange: the hue is held);
 *   (2) RULE 2 — a display-authored additive emitter (c, a) ALONE ON BLACK
 *       reproduces its old pixel c·a exactly (the no-khaki gate: a colour
 *       encoded without being decoded first would come out pale here);
 *   (3) RULE 3 — an additive built-in (MeshBasicMaterial, hex + opacity)
 *       through `adaptMaterialForHdr` reproduces hex·opacity;
 *   (4) THE DITHER is there (±1 LSB noise on a flat field) and unbiased;
 *   (5) THE LIVE SCENE: HDR target in use, every material swept, no raw
 *       shader left 'unconverted', the hero's own shaders and the engine's
 *       all compiled with HERO_HDR; `?hdr=0` boots the display-space
 *       fallback with no HERO_HDR anywhere and still goes live.
 *
 * (1)–(4) need no page boot: the modules are imported into a bare document
 * on the dev server (hero-color.js takes THREE by injection).
 */
import { test, expect } from '@playwright/test';
import { outputTransform, srgbDecode, srgbEncode } from '../js/hero-color.js';

const URL = '/index.html?exp_home_bg_carousel=control&debug=1&intro=0';
const THREE_URL = '/js/vendor/three-0.160.0/three.module.js';

/** Draw N solid patches through the real HeroPost and read them back. */
async function drawPatches(page, spec) {
    return page.evaluate(async ({ spec, THREE_URL }) => {
        const THREE = await import(THREE_URL);
        const { HeroPost, HERO_COLOR_GLSL, adaptMaterialForHdr } = await import('/js/hero-color.js');
        const canvas = document.createElement('canvas');
        canvas.width = 64 * spec.patches.length; canvas.height = 64;
        document.body.appendChild(canvas);
        const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
        renderer.setPixelRatio(1);
        renderer.setSize(canvas.width, canvas.height, false);
        renderer.setClearColor(0x000000, 1);
        if (spec.hdr && !HeroPost.supported(renderer)) return { skip: 'no WebGL2 half-float target' };
        const scene = new THREE.Scene();
        const cam = new THREE.OrthographicCamera(0, canvas.width, canvas.height, 0, -1, 1);
        spec.patches.forEach((p, i) => {
            let mat;
            if (p.kind === 'radiance') {
                mat = new THREE.ShaderMaterial({
                    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
                    fragmentShader: `precision highp float;\n${HERO_COLOR_GLSL}\nuniform vec3 L;\nvoid main(){ gl_FragColor = heroRadiance(L); }`,
                    uniforms: { L: { value: new THREE.Vector3(...p.L) } },
                });
            } else if (p.kind === 'emit') {
                mat = new THREE.ShaderMaterial({
                    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
                    fragmentShader: `precision highp float;\n${HERO_COLOR_GLSL}\nuniform vec3 C; uniform float A;\nvoid main(){ gl_FragColor = heroEmit(C, A); }`,
                    uniforms: { C: { value: new THREE.Vector3(...p.c) }, A: { value: p.a } },
                    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
                });
            } else {   // 'basic'
                mat = new THREE.MeshBasicMaterial({ color: p.hex, opacity: p.opacity, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
            }
            const m = new THREE.Mesh(new THREE.PlaneGeometry(64, 64), mat);
            m.position.set(32 + 64 * i, 32, 0);
            scene.add(m);
        });
        let post = null;
        if (spec.hdr) {
            post = new HeroPost(THREE, renderer, { width: canvas.width, height: canvas.height, samples: 0 });
            if (!post.validate()) return { skip: 'HDR target incomplete' };
            post.material.uniforms.uDither.value = spec.dither ? 1 : 0;
            scene.traverse((o) => { if (o.material) adaptMaterialForHdr(o.material, THREE.AdditiveBlending); });
            post.render(scene, cam);
        } else {
            renderer.render(scene, cam);
        }
        const gl = renderer.getContext();
        const px = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const at = (x, y) => { const o = (y * canvas.width + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };
        const centres = spec.patches.map((_, i) => at(32 + 64 * i, 32));
        // For the dither check: every pixel of patch 0's inner 48×48.
        const field = [];
        if (spec.dither) for (let y = 8; y < 56; y++) for (let x = 8; x < 56; x++) field.push(at(x, y)[1]);
        return { centres, field };
    }, { spec, THREE_URL });
}

test.describe('home hero colour pipeline', () => {
    test.describe.configure({ timeout: 180_000 });

    test('GLSL output transform + rules 2/3 match the JS oracle; dither present', async ({ page }) => {
        await page.goto('/js/hero-color.js');   // any same-origin document will do

        // (1) the oracle: toe, knee, shoulder, deep HDR, saturated HDR orange.
        const Ls = [[0.002, 0.002, 0.002], [0.02, 0.01, 0.005], [0.18, 0.18, 0.18], [0.5, 0.3, 0.1],
            [0.8, 0.8, 0.8], [1.5, 1.5, 1.5], [4, 4, 4], [16, 16, 16], [2.0, 0.92, 0.36], [0.05, 0.4, 3.0]];
        const r1 = await drawPatches(page, { hdr: true, patches: Ls.map((L) => ({ kind: 'radiance', L })) });
        test.skip(!!r1.skip, r1.skip);
        Ls.forEach((L, i) => {
            const want = outputTransform(L).map((v) => Math.round(Math.min(1, v) * 255));
            const got = r1.centres[i];
            for (let k = 0; k < 3; k++) {
                expect(Math.abs(got[k] - want[k]), `oracle L=${L} ch${k}: got ${got} want ${want}`).toBeLessThanOrEqual(1);
            }
        });
        // The contrast that makes this a pipeline and not a clip: the HDR
        // orange keeps red > green > blue with a green/red ratio far from the
        // per-channel clip's (1.0, 0.92 → clipped 1.0, 0.92 → yellow).
        const orange = r1.centres[8];
        expect(orange[0]).toBeGreaterThan(orange[1]);
        expect(orange[1]).toBeGreaterThan(orange[2]);

        // (2) rule 2 — the author's pixel, alone on black, is reproduced.
        const emits = [[[1, 0.6, 0.2], 1], [[1, 0.6, 0.2], 0.3], [[0.3, 0.58, 1.0], 0.5],
            [[0.03, 1.0, 0.28], 0.08], [[0.8, 0.8, 0.95], 0.04], [[0.62, 0.14, 0.88], 0.7]];
        const r2 = await drawPatches(page, { hdr: true, patches: emits.map(([c, a]) => ({ kind: 'emit', c, a })) });
        emits.forEach(([c, a], i) => {
            const want = c.map((v) => v * a);
            // Below the knee the tone curve is the identity: exact up to 8-bit rounding.
            if (Math.max(...want.map(srgbDecode)) > 0.8) return;
            const got = r2.centres[i];
            for (let k = 0; k < 3; k++) {
                expect(Math.abs(got[k] - Math.round(want[k] * 255)), `rule 2 c=${c} a=${a} ch${k}: got ${got}`).toBeLessThanOrEqual(1);
            }
        });
        // …and on the display-space fallback heroEmit is the identity.
        const r2f = await drawPatches(page, { hdr: false, patches: emits.map(([c, a]) => ({ kind: 'emit', c, a })) });
        emits.forEach(([c, a], i) => {
            for (let k = 0; k < 3; k++) expect(Math.abs(r2f.centres[i][k] - Math.round(c[k] * a * 255))).toBeLessThanOrEqual(1);
        });

        // (3) rule 3 — an additive built-in with display-tuned opacity.
        const basics = [[0xff9944, 0.3], [0x44ccee, 0.14], [0xffffff, 0.05], [0x3366ff, 0.8]];
        const r3 = await drawPatches(page, { hdr: true, patches: basics.map(([hex, opacity]) => ({ kind: 'basic', hex, opacity })) });
        basics.forEach(([hex, op], i) => {
            const c = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => v / 255);
            const got = r3.centres[i];
            for (let k = 0; k < 3; k++) {
                expect(Math.abs(got[k] - Math.round(c[k] * op * 255)), `rule 3 #${hex.toString(16)}×${op} ch${k}: got ${got}`).toBeLessThanOrEqual(1);
            }
        });

        // (4) the dither: a flat dark field comes out as ±1 LSB noise around
        // the undithered value, not as one flat code (which is what bands).
        const L = srgbDecode(40.4 / 255);
        const r4 = await drawPatches(page, { hdr: true, dither: true, patches: [{ kind: 'radiance', L: [L, L, L] }] });
        const f = r4.field;
        const mean = f.reduce((s, v) => s + v, 0) / f.length;
        const distinct = new Set(f).size;
        expect(distinct, `dither levels in a flat field: ${[...new Set(f)]}`).toBeGreaterThanOrEqual(2);
        expect(Math.abs(mean - srgbEncode(L) * 255)).toBeLessThan(0.6);
        expect(Math.max(...f) - Math.min(...f)).toBeLessThanOrEqual(3);
    });

    test('the live scene is on the pipeline; ?hdr=0 is the display-space fallback', async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(URL, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => {
            const c = document.getElementById('hero-canvas');
            return window.__ppHero?._shown || (c && c.style.display === 'none');
        }, null, { timeout: 150_000 });
        const booted = await page.evaluate(() => !!window.__ppHero?._shown);
        test.skip(!booted, 'WebGL unavailable — no scene');

        const live = await page.evaluate(() => {
            const h = window.__ppHero;
            const kinds = {};
            const unconverted = [];
            const shaderNoHdr = [];
            h._scene.traverse((o) => {
                const m = o.material;
                if (!m) return;
                for (const mm of Array.isArray(m) ? m : [m]) {
                    const k = mm.userData?.heroHdr ?? 'UNSWEPT';
                    kinds[k] = (kinds[k] ?? 0) + 1;
                    if (k === 'unconverted') unconverted.push(o.name || o.type);
                    if (mm.isShaderMaterial && !('HERO_HDR' in (mm.defines ?? {}))) shaderNoHdr.push(o.name || o.type);
                }
            });
            const t = h._post?.target;
            return {
                hdr: h._hdr, post: !!h._post, type: t?.texture.type, samples: h._post?.samples,
                bufW: h._renderer.getContext().drawingBufferWidth, rtW: t?.width,
                earthHdr: 'HERO_HDR' in (h._earth.material.defines ?? {}),
                auroraHdr: 'HERO_HDR' in (h._engine._auroraN?.children[0]?.material.defines ?? {}),
                kinds, unconverted, shaderNoHdr,
            };
        });
        expect(live.hdr).toBe(true);
        expect(live.post).toBe(true);
        expect(live.type).toBe(1016);                // THREE.HalfFloatType: linear light, not 8-bit
        expect(live.rtW).toBe(live.bufW);            // the target IS the image: full drawing-buffer size
        expect(live.earthHdr).toBe(true);
        expect(live.auroraHdr).toBe(true);           // the engine's shaders were switched by the sweep
        expect(live.kinds.UNSWEPT ?? 0).toBe(0);
        expect(live.unconverted).toEqual([]);
        expect(live.shaderNoHdr).toEqual([]);
        expect(live.kinds.shader).toBeGreaterThanOrEqual(5);   // earth, atmosphere, stars, wind, deep field (+ engine)

        // The fallback: same page, no HDR target, no HERO_HDR anywhere, live.
        await page.goto(URL + '&hdr=0', { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__ppHero?._shown, null, { timeout: 150_000 });
        const fb = await page.evaluate(() => {
            const h = window.__ppHero;
            let hdrDefines = 0;
            h._scene.traverse((o) => { if (o.material && 'HERO_HDR' in (o.material.defines ?? {})) hdrDefines++; });
            return { hdr: h._hdr, post: h._post, hdrDefines, live: document.getElementById('hero').classList.contains('hero-live') };
        });
        expect(fb).toEqual({ hdr: false, post: null, hdrDefines: 0, live: true });
    });
});
