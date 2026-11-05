/**
 * Test-only clock driver. Production modules, shaders and physics are untouched.
 * The Playwright clock owns Date/performance/timers. A queued rAF driver lets us
 * advance those timers and run ONE app frame per 100 ms, independent of CPU/GPU
 * speed. Smoke still uses its production <= 1/20 s internal integration steps.
 * The app's own initial tick is at time zero; screenshots never advance time.
 */
import { expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

export const EPOCH = '2026-11-01T20:00:00.000Z';
export const FRAME_MS = 100;
export const STAGE = '.lh-vehicle-canvas-host';
export const PIXELS = { threshold: 0.12, maxDiffPixelRatio: 0.001 };

export async function advance(page, count, dt = FRAME_MS) {
    for (let i = 0; i < count; i++) {
        await page.clock.runFor(dt);
        await page.evaluate(() => window.__launchCapture.frame());
    }
}

export async function bootCapture(page, { quality = 'low' } = {}) {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => {
        // Network failures are handled by routes below. Never hide shader errors.
        if (msg.type() === 'error' && /THREE|WebGL|GL_INVALID|shader|launch-vehicle/i.test(msg.text())) {
            errors.push(msg.text());
        }
    });
    await page.route('**/*', route => {
        const u = new URL(route.request().url());
        if (!['localhost', '127.0.0.1'].includes(u.hostname)) return route.abort();
        if (u.pathname === '/api/launches/upcoming') {
            return route.fulfill({ json: { launches: [], source: 'visual-test', fetched_at: EPOCH } });
        }
        // No live services, telemetry writes, authentication or weather feed races.
        if (u.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true } });
        return route.continue();
    });
    // Opt-in negative controls change only the response in this test context.
    // Smoke counts and post.enabled remain true, demonstrating the pixel gap.
    const fault = process.env.LAUNCH_VISUAL_FAULT;
    if (fault) {
        const changes = {
            smoke: ['scene.add(smokeView.mesh);', 'scene.add(smokeView.mesh); smokeView.mesh.visible = false;'],
            lighting: ['key.castShadow = true;', 'key.castShadow = true; key.intensity = 0;'],
            bloom: ['post.setBloom(1 + 0.7 * burn);', 'post.setBloom(0);'],
        };
        if (!Object.hasOwn(changes, fault)) throw new Error(`Unknown visual fault: ${fault}`);
        const [needle, replacement] = changes[fault];
        const source = readFileSync(new URL('../../js/launch-vehicle-3d.js', import.meta.url), 'utf8');
        if (source.split(needle).length !== 2) throw new Error(`Fault anchor drifted: ${fault}`);
        await page.route('**/js/launch-vehicle-3d.js', route => route.fulfill({
            contentType: 'application/javascript', body: source.replace(needle, replacement),
        }));
    }
    await page.clock.install({ time: new Date(EPOCH) });
    await page.clock.pauseAt(new Date(EPOCH));
    await page.addInitScript(() => {
        let seed = 20261101;
        Math.random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            return seed / 4294967296;
        };
        let nextId = 0;
        const callbacks = new Map();
        window.requestAnimationFrame = callback => {
            const id = ++nextId;
            callbacks.set(id, callback);
            return id;
        };
        window.cancelAnimationFrame = id => callbacks.delete(id);
        window.__launchCapture = {
            frames: 0,
            frame() {
                // Snapshot ids, not callbacks: cancellation within a frame works.
                const ids = [...callbacks.keys()];
                for (const id of ids) {
                    const callback = callbacks.get(id);
                    callbacks.delete(id);
                    if (callback) callback(performance.now());
                }
                this.frames++;
            },
        };
    });
    await page.goto(`/launch-planner.html?lpfx=${quality}`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__lpVehicle3d?.renderStats, null, { polling: 50 });
    // Exercise the real refusal control; a first-visit banner otherwise covers
    // most of the mobile stage. Never hide an overlay with screenshot CSS.
    await press(page, '.pp-consent-banner [data-action="reject"]');
    await expect(page.locator('.pp-consent-banner')).toHaveCount(0);
    await page.evaluate(async () => {
        await document.fonts.ready;
        const el = document.querySelector('.lh-vehicle-canvas-host');
        window.scrollTo(0, el.getBoundingClientRect().top + scrollY - 56);
    });
    // Let Resize/IntersectionObservers deliver before stepping queued frames.
    await expect(page.locator(STAGE)).toBeInViewport();
    await advance(page, 4);
    await page.evaluate(() => window.__lpVehicle3d.refresh());
    await advance(page, 2);
    const state = await captureState(page);
    expect(state.stats.quality).toBe(quality);
    expect(state.stats.post).toBe(true);
    expect(state.renderer).toMatch(/SwiftShader/i);
    return errors;
}

// DOM click intentionally avoids Playwright's rAF-based actionability wait while
// the application clock is paused. It invokes the real button handlers; existing
// unmodified camera tests retain real pointer/keyboard/touch action coverage.
export async function press(page, selector) {
    await expect(page.locator(selector).first()).toBeVisible();
    await page.locator(selector).first().evaluate(el => el.click());
}

export async function prepareScene(page, scene) {
    const family = `.lh-vp-btn[data-vehicle="${scene.vehicle}"]`;
    await press(page, family);
    if ((scene.variant || '') !== await page.locator(family).first().getAttribute('data-variant')) {
        await press(page, `${family}[data-variant="${scene.variant}"]`);
    }
    if (scene.view !== 'auto') await press(page, `.lh-view[data-view="${scene.view}"]`);
    // 800 ms camera tween + settled final frame, at an exact virtual time.
    await advance(page, 12);
    if (scene.plume) {
        await press(page, '.lh-toggle[data-toggle="plume"]');
        await advance(page, 1);
    }
    if (scene.missionT !== undefined) {
        await press(page, '#lh-liftoff');
        await advance(page, (scene.missionT + 3) * 1000 / FRAME_MS);
        expect(await page.evaluate(() => window.__lpVehicle3d.missionT)).toBeCloseTo(scene.missionT, 8);
        const s = await page.evaluate(() => window.__lpVehicle3d.renderStats);
        expect(s.smokeAlive).toBeGreaterThan(20);
        expect(s.smokeDrawn).toBeGreaterThan(0);
        expect(s.flameIntensity).toBeGreaterThan(0);
    }
}

export async function captureState(page) {
    return page.evaluate(() => {
        const api = window.__lpVehicle3d;
        const canvas = document.getElementById('lh-vehicle-canvas');
        const gl = canvas.getContext('webgl2');
        const ext = gl?.getExtension('WEBGL_debug_renderer_info');
        const host = document.querySelector('.lh-vehicle-canvas-host');
        const box = host.getBoundingClientRect();
        return {
            stats: api.renderStats, view: api.view, missionT: api.missionT,
            frames: window.__launchCapture.frames,
            time: performance.now(), date: new Date().toISOString(),
            renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
            canvas: { width: canvas.width, height: canvas.height },
            stage: { width: box.width, height: box.height },
            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
            overflowX: document.documentElement.scrollWidth - innerWidth,
            unobscured: [0.1, 0.5, 0.9].every(x => [0.1, 0.5, 0.9].every(y =>
                host.contains(document.elementFromPoint(box.left + box.width * x, box.top + box.height * y)))),
        };
    });
}
