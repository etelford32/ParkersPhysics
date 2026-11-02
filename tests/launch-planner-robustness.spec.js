/**
 * launch-planner-robustness.spec.js — the launch planner's 3D canvas under the
 * conditions real visitors bring and the SwiftShader CI run does not:
 *
 *   · a real-GPU renderer string (detectQuality picks the HIGH path there:
 *     MSAA half-float targets, 4096² shadows — CI on SwiftShader runs 'low')
 *   · a GPU / browser without float colour buffers (no EXT_color_buffer_float
 *     / _half_float), where a half-float render target is INCOMPLETE and
 *     draws nothing — with no error (the hero-color.js scar)
 *   · WebGL1 only, and no WebGL at all
 *   · a returning visitor's saved UI state (collapsed panel, compact density,
 *     dragged HUDs, the hint already seen)
 *   · WebGL context loss + restore (mobile tab switches, GPU memory pressure)
 *
 * NEGATIVE CONTROL (run 2026-11-02 against the pre-fix js/launch-scene-fx.js):
 * both float-buffer profiles drew a SOLID BLACK canvas — luminance mean 0.0,
 * spread 0.0, no console error — because createPost used a half-float (MSAA)
 * target without checking it was drawable. The fix verifies each rung
 * (MSAA → no MSAA → direct render) with checkFramebufferStatus.
 *
 * Each GPU profile also asserts the page's OWN verdict (`api.checkHealth()`,
 * js/launch-render-health.js) is 'ok' with zero shader link failures — the
 * same verdict a visitor's browser reports through telemetry.
 *
 * Every case asserts BOTH "no page errors" AND that the canvas actually
 * shows an image: pixels read back inside the same animation frame the page
 * rendered (the drawing buffer is not preserved, so a read in a later task
 * sees a cleared buffer). "Shows an image" = enough luminance spread across
 * the frame that it is not a flat clear colour.
 */
import { test, expect } from '@playwright/test';

const URL = '/launch-planner.html';

// Applied BEFORE any page script: shape what WebGL reports / supports.
function gpuProfileScript(profile) {
    return `(() => {
        const P = ${JSON.stringify(profile)};
        const orig = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, attrs) {
            if (P.noWebGL && /webgl/.test(type)) return null;
            if (P.webgl1Only && type === 'webgl2') return null;
            const ctx = orig.call(this, type, attrs);
            if (!ctx || !/webgl/.test(type) || ctx.__lpPatched) return ctx;
            ctx.__lpPatched = true;
            if (P.noMsaa && ctx.renderbufferStorageMultisample) {
                // A driver that refuses multisampled float storage: the call
                // allocates nothing, so the MSAA framebuffer is incomplete.
                ctx.renderbufferStorageMultisample = () => {};
            }
            const getExt = ctx.getExtension.bind(ctx);
            const getParam = ctx.getParameter.bind(ctx);
            const blocked = new Set(P.blockExt || []);
            ctx.getExtension = (name) => {
                if (blocked.has(name)) return null;
                if (P.renderer && name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 };
                return getExt(name);
            };
            ctx.getSupportedExtensions = ((orig) => () => (orig() || []).filter(n => !blocked.has(n)))(ctx.getSupportedExtensions.bind(ctx));
            ctx.getParameter = (p) => {
                if (P.renderer && p === 0x9246) return P.renderer;
                if (P.renderer && p === 0x9245) return 'Test GPU Vendor';
                return getParam(p);
            };
            return ctx;
        };
    })();`;
}

async function boot(page, { profile = null, storage = null, query = '' } = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.route('**/api/telemetry/log', (r) =>
        r.fulfill({ status: 202, contentType: 'application/json', body: '{"ok":true}' }));
    await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
    if (profile) await page.addInitScript(gpuProfileScript(profile));
    if (storage) await page.addInitScript((s) => { try { localStorage.setItem('lp:ui-state-v1', JSON.stringify(s)); } catch {} }, storage);
    await page.goto(URL + query, { waitUntil: 'domcontentloaded' });
    return errors;
}

// Errors the sandbox always produces (no network) and that are not this canvas.
const realErrors = (errs) => errs.filter((t) =>
    !/Failed to load resource|feed fetch|net::ERR|supabase|jsdelivr|503|501/i.test(t));

async function scrollToStage(page) {
    await page.evaluate(() => {
        const el = document.querySelector('.lh-vehicle-canvas-host');
        window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 56);
    });
}

// Luminance stats of the canvas, read in the SAME frame the page rendered.
async function frameStats(page) {
    return page.evaluate(() => new Promise((res) => {
        requestAnimationFrame(() => {
            const c = document.getElementById('lh-vehicle-canvas');
            if (!c || !c.width || !c.height) return res({ w: 0, h: 0, mean: 0, std: 0 });
            const o = document.createElement('canvas');
            o.width = Math.min(c.width, 320); o.height = Math.round(o.width * c.height / c.width);
            const g = o.getContext('2d');
            g.drawImage(c, 0, 0, o.width, o.height);
            const d = g.getImageData(0, 0, o.width, o.height).data;
            let s = 0, s2 = 0, n = 0;
            for (let i = 0; i < d.length; i += 4) {
                const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
                s += L; s2 += L * L; n++;
            }
            const mean = s / n;
            res({ w: c.width, h: c.height, mean, std: Math.sqrt(Math.max(0, s2 / n - mean * mean)) });
        });
    }));
}

async function waitForApi(page, timeout = 60_000) {
    await page.waitForFunction(() => window.__lpVehicle3d?.renderStats, null, { timeout });
}

// A rendered launch-pad frame has lit pad, vehicle and dark sky: spread ≫ 4.
const SHOWS_IMAGE = 6;

test.describe('launch-planner 3D canvas — real-world robustness', () => {
    test.setTimeout(180_000);

    // [name, gpu profile, expected quality, expected post chain]
    //   post: { enabled, fallback, samples } — what createPost must settle on.
    const PROFILES = [
        ['software GL as CI sees it', null, 'low', { enabled: true, fallback: null, samples: 0 }],
        ['real GPU name → high quality path', { renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)' },
            'high', { enabled: true, fallback: null, samples: 4 }],
        // MEASURED before the fix: this profile drew a solid black canvas
        // (luminance mean 0.0, spread 0.0) with no error — the half-float
        // target was incomplete and every draw into it was dropped.
        ['real GPU without float colour buffers', {
            renderer: 'ANGLE (Qualcomm, Adreno (TM) 610, OpenGL ES 3.2)',
            blockExt: ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'EXT_float_blend'],
        }, 'high', { enabled: false, fallback: 'no-float-colour-buffer', samples: 0 }],
        // MEASURED before the fix: also solid black (mean 0.0) — the MSAA
        // half-float target was incomplete and nothing checked it.
        ['real GPU that refuses multisampled float buffers', {
            renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620, OpenGL 4.6)', noMsaa: true,
        }, 'high', { enabled: true, fallback: 'msaa-float-incomplete', samples: 0 }],
        ['WebGL1 only', { webgl1Only: true }, 'off', { enabled: false, fallback: null, samples: 0 }],
    ];

    for (const [name, profile, expectQuality, expectPost] of PROFILES) {
        test(`renders an image: ${name}`, async ({ page }) => {
            const errors = await boot(page, { profile });
            await waitForApi(page);
            await scrollToStage(page);
            await page.waitForTimeout(2500);
            const s = await frameStats(page);
            const stats = await page.evaluate(() => window.__lpVehicle3d.renderStats);
            // The page's own verdict — the one it reports to telemetry from a
            // visitor's device (js/launch-render-health.js) — must agree.
            const health = await page.evaluate(() => window.__lpVehicle3d.checkHealth());
            expect(health.verdict, `in-page verdict ${JSON.stringify(health)}`).toBe('ok');
            expect(health.shaderErrors, `shader link failures: ${health.firstShaderError}`).toBe(0);
            console.log(`[${name}]`, JSON.stringify({ quality: stats.quality, post: stats.post,
                fallback: stats.postFallback, samples: stats.postSamples, frame: s }));
            if (expectQuality) expect(stats.quality).toBe(expectQuality);
            expect({ enabled: stats.post, fallback: stats.postFallback, samples: stats.postSamples }).toEqual(expectPost);
            expect(s.w).toBeGreaterThan(100);
            expect(s.std, `frame luminance spread (mean ${s.mean.toFixed(1)})`).toBeGreaterThan(SHOWS_IMAGE);
            expect(realErrors(errors)).toEqual([]);
        });
    }

    test('no WebGL at all: a readable fallback, no uncaught error', async ({ page }) => {
        const errors = await boot(page, { profile: { noWebGL: true } });
        await page.waitForTimeout(4000);
        const txt = await page.locator('.lh-vehicle-canvas-host, .lh-vehicle-wrap').first().innerText();
        expect(txt).toMatch(/unavailable/i);
        expect(errors.filter((t) => t.startsWith('pageerror'))).toEqual([]);
    });

    test('returning visitor: panel saved collapsed, compact density, dragged HUDs', async ({ page }) => {
        const errors = await boot(page, {
            storage: {
                'collapse:vehicle': true,
                density: 'compact',
                'drag:met': { x: 1400, y: 900 },
                'drag:views': { x: 900, y: 500 },
                camHintSeen: true,
            },
        });
        await waitForApi(page);
        // Expand the vehicle panel the way a visitor would.
        await page.click('#lp-vehicle .lp-collapse-hd');
        await scrollToStage(page);
        await page.waitForTimeout(2500);
        const s = await frameStats(page);
        const v = await page.evaluate(() => ({ ...window.__lpVehicle3d.renderStats, view: window.__lpVehicle3d.view }));
        console.log('[returning]', JSON.stringify({ frame: s, cameraY: v.cameraY, view: v.view }));
        expect(Number.isFinite(v.cameraY)).toBe(true);
        expect(v.cameraY).toBeGreaterThan(2);
        expect(s.std).toBeGreaterThan(SHOWS_IMAGE);
        expect(realErrors(errors)).toEqual([]);
    });

    test('WebGL context loss and restore: the canvas draws again', async ({ page }) => {
        const errors = await boot(page);
        await waitForApi(page);
        await scrollToStage(page);
        await page.waitForTimeout(1500);
        const lost = await page.evaluate(() => {
            const c = document.getElementById('lh-vehicle-canvas');
            const gl = c.getContext('webgl2') || c.getContext('webgl');
            const ext = gl && gl.getExtension('WEBGL_lose_context');
            if (!ext) return false;
            window.__lpLose = ext;
            ext.loseContext();
            return true;
        });
        test.skip(!lost, 'WEBGL_lose_context unavailable');
        await page.waitForTimeout(800);
        await page.evaluate(() => window.__lpLose.restoreContext());
        await page.waitForTimeout(4000);
        const s = await frameStats(page);
        console.log('[context restore]', JSON.stringify(s));
        expect(s.std).toBeGreaterThan(SHOWS_IMAGE);
        expect(realErrors(errors)).toEqual([]);
    });

    test('every vehicle and every variant builds and draws', async ({ page }) => {
        const errors = await boot(page);
        await waitForApi(page);
        await scrollToStage(page);
        const combos = [['shuttle'], ['falcon9', 'block5'], ['falcon9', 'block5-crew'], ['falcon9', 'heavy'],
                        ['starship', 'v1'], ['starship', 'v2'], ['starship', 'v3'], ['starship', 'future']];
        for (const [id, variant] of combos) {
            await page.evaluate(([id, v]) => window.__lpVehicle3d.setVehicle(id, v), [id, variant]);
            await page.waitForTimeout(1200);
            const s = await frameStats(page);
            expect(s.std, `${id}/${variant}`).toBeGreaterThan(SHOWS_IMAGE);
            const h = await page.evaluate(() => window.__lpVehicle3d.checkHealth());
            expect(h.verdict, `${id}/${variant} in-page verdict`).toBe('ok');
        }
        expect(realErrors(errors)).toEqual([]);
    });
});
