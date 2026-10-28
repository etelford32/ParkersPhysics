import { test, expect } from '@playwright/test';

/**
 * wind-palette-page.spec.js — the LIVE wind layers wear the one palette.
 *
 * `node tests/wind-palette.mjs` pins the rule (blue; brighter = faster;
 * deeper = lower). This gate pins that earth.html actually READS it:
 *
 *   1. The surface trails, the arrow field and every pressure-level
 *      instance report the same slow/mid/fast colours js/wind-palette.js
 *      returns for their altitude (via window.__evWindStack().ramp) — a
 *      stale private copy of any ramp fails here, which a legend canvas
 *      alone could never show.
 *   2. The wx-panel key is painted from the same bytes: left end deep
 *      navy, right end bright, luminance rising left→right.
 *   3. Each pressure-level key is a lighter shade of the same hue than the
 *      one below it (lower = deeper, in the key as on the globe).
 *   4. The disclosure line under the key names both axes.
 *
 * Runs without live network (the feeds fail to their error pips; the ramps
 * are pure functions of altitude and do not need data).
 */

test.use({
    launchOptions: { args: ['--ignore-certificate-errors', '--allow-insecure-localhost'] },
    ignoreHTTPSErrors: true,
});

const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test.describe.configure({ timeout: 180_000 });

test('live wind layers, arrows and legends all read js/wind-palette.js', async ({ page }) => {
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Module-ready, not load-ready (see wind-levels-smoke.spec.js: `load`
    // waits on egress-blocked CDN textures and blows the budget).
    await page.goto('/earth.html', { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(() => typeof window.__evWindStack === 'function', null, { timeout: 120_000 });

    // Enable every level so each instance exists and reports its own ramp.
    for (const id of ['lyr-wind-850', 'lyr-wind-500', 'lyr-jet']) {
        await page.evaluate((elId) => {
            const el = document.getElementById(elId);
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, id);
    }
    await page.waitForTimeout(500);

    // 1. Every live ramp == the module at that altitude.
    const result = await page.evaluate(async () => {
        const m = await import('/js/wind-palette.js');
        const st = window.__evWindStack();
        const expect = (alt) => ({
            slow: m.windColor(0, alt), mid: m.windColor(0.5, alt), fast: m.windColor(1, alt),
        });
        return {
            levels: st.levels.map(l => ({ key: l.key, altKm: l.altKm, created: l.created ?? true,
                                          got: l.ramp, want: expect(l.altKm) })),
            arrows: { got: st.arrowRamp, want: expect(st.levels[0].altKm) },
            note: document.getElementById('wind-palette-note')?.textContent ?? '',
        };
    });
    expect(result.levels.map(l => l.key)).toEqual(['sfc', 'w850', 'w500', 'jet']);
    for (const l of result.levels) {
        expect(l.created, `${l.key} instance exists`).toBe(true);
        for (const k of ['slow', 'mid', 'fast']) {
            for (let c = 0; c < 3; c++) {
                expect(l.got[k][c], `${l.key} ${k}[${c}]`).toBeCloseTo(l.want[k][c], 6);
            }
        }
    }
    for (const k of ['slow', 'mid', 'fast']) {
        for (let c = 0; c < 3; c++) {
            expect(result.arrows.got[k][c], `arrows ${k}[${c}]`).toBeCloseTo(result.arrows.want[k][c], 6);
        }
    }

    // Blue, brighter with speed, lighter with altitude — on the live values.
    let prevMid = -1;
    for (const l of result.levels) {
        for (const k of ['slow', 'mid', 'fast']) {
            const [r, g, b] = l.got[k];
            expect(b, `${l.key} ${k} blue dominates`).toBeGreaterThanOrEqual(g);
            expect(g, `${l.key} ${k} blue dominates`).toBeGreaterThanOrEqual(r);
        }
        expect(lum(l.got.fast)).toBeGreaterThan(lum(l.got.mid));
        expect(lum(l.got.mid)).toBeGreaterThan(lum(l.got.slow));
        expect(lum(l.got.mid), `${l.key} lighter than the level below`).toBeGreaterThan(prevMid);
        prevMid = lum(l.got.mid);
    }

    // 2 + 3. The painted keys follow the same shades.
    const keys = await page.evaluate(() => {
        const read = (cv) => {
            const ctx = cv.getContext('2d');
            const px = (x) => Array.from(ctx.getImageData(x, 0, 1, 1).data).slice(0, 3).map(v => v / 255);
            return { left: px(0), mid: px((cv.width / 2) | 0), right: px(cv.width - 1) };
        };
        const out = { sfc: read(document.getElementById('wx-wind-legend')) };
        for (const key of ['w850', 'w500', 'jet']) {
            const cv = document.querySelector(`#wx-windlvl-legend-${key} canvas`);
            out[key] = cv ? read(cv) : null;
        }
        return out;
    });
    let prev = -1;
    for (const key of ['sfc', 'w850', 'w500', 'jet']) {
        const k = keys[key];
        expect(k, `${key} key painted`).not.toBeNull();
        expect(lum(k.right)).toBeGreaterThan(lum(k.mid));
        expect(lum(k.mid)).toBeGreaterThan(lum(k.left));
        expect(k.left[2]).toBeGreaterThanOrEqual(k.left[1]);   // blue dominates at the dark end
        expect(lum(k.mid), `${key} key lighter than the one below`).toBeGreaterThan(prev);
        prev = lum(k.mid);
    }
    expect(lum(keys.sfc.left)).toBeLessThan(0.3);   // deep navy, not the old (0.35, 0.55, 1.0)
    expect(lum(keys.jet.right)).toBeGreaterThan(0.9);

    // 4. The disclosure.
    expect(result.note).toContain('Brighter = faster');
    expect(result.note).toContain('lower altitude');

    expect(pageErrors, pageErrors.join('\n')).toHaveLength(0);
});
