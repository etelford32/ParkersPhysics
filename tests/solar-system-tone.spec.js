/**
 * solar-system-tone.spec.js — the orrery has ONE colour pipeline.
 * ═══════════════════════════════════════════════════════════════════════════
 * solar-system.html sets `renderer.toneMapping = ACESFilmicToneMapping`, but
 * three.js applies the tone curve and the output colour-space conversion
 * through the `<tonemapping_fragment>` / `<colorspace_fragment>` chunks, which
 * exist only in the BUILT-IN materials. Every custom `ShaderMaterial` on this
 * page writes `gl_FragColor` raw, so all 16 of them — the Sun, both glow
 * shells, the chromosphere, the planets, Jupiter, the wind, the heliospheric
 * current sheet, the magnetosphere, the belts, the ring current, the
 * ionosphere, the plasmasphere, the coronal rain, and the NEO rocks and
 * points — silently bypassed it. The page had two colour pipelines.
 *
 * MEASURED BEFORE THE FIX (2026-09-14, SOLAR_SYSTEM_VISUAL_REVIEW.md §1.1),
 * on the brightest 8 000 disc pixels at Sun View:
 *
 *     state     disc RGB           luminance σ    R,G at 255
 *     quiet     (255, 255, 243)    1.64           100 %
 *     X2.8      (255, 255, 255)    0.00           100 %
 *
 * A σ of 0.00 during a flare is literally zero spatial structure: granulation,
 * sunspots, filament channels and active regions were all present in the
 * shader and all of them above the clip ceiling. The star rendered as a
 * featureless white cut-out.
 *
 * THE FIX IS TWO THINGS THAT MOVE TOGETHER, and this gate exists because
 * either one alone fails. Adding the chunks without re-fitting the exposure
 * moved the flare-state σ to 0.10 and left the disc 100 % clipped — ACES
 * cannot recover an input sitting five stops past its shoulder. See the
 * SUN_EXPOSURE block in `sunFS`.
 *
 * METHOD. The panel is CLOSED for every measurement: `#backdrop` dims the
 * whole canvas by 45 % while it is open (finding U1), and the review's first
 * pass read a disc ceiling of exactly 140/255 = 255 × (1 − 0.45) — the overlay,
 * not the render. Pixels come from a real canvas screenshot (the page renders
 * without `preserveDrawingBuffer`, so nothing in-page can read the buffer
 * back, and a WebGLRenderTarget would not do: three.js DISABLES tone mapping
 * when the render target is not null, which would measure the bug as the fix).
 * The PNG is handed back to the browser to decode, so this file needs no image
 * dependency. The disc is masked to 0.92 × the projected photosphere radius
 * via `window.__solarRender.discPx()` — inside the limb, so the corona shells
 * at r = 1.9 / 2.8 cannot contribute.
 */

import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEG = Math.PI / 180;

const IGNORED_CONSOLE_ERRORS = [
    /fonts\.googleapis\.com/, /\/api\/telemetry\//, /\/api\/horizons/, /\/api\/noaa\//, /\/api\/donki\//,
    /\/api\/solar/, /\/api\/health/, /\/api\/neo\//, /services\.swpc\.noaa\.gov/, /Failed to load resource/,
    /net::ERR/, /\[swpc-feed\]/, /\[earth-sim-bridge\]/, /supabase/i, /WebSocket/, /upstream_unavailable/,
];

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', m => {
        if (m.type() !== 'error') return;
        const text = m.text(), loc = m.location?.()?.url || '';
        if (IGNORED_CONSOLE_ERRORS.some(p => p.test(text) || p.test(loc))) return;
        errors.push(text);
    });
    return errors;
}

/**
 * The feed's event contract (js/swpc-feed.js `_buildState`), at a chosen X-ray
 * level. The regions are planted at STONYHURST longitudes 90° apart (converted
 * to the Carrington the feed publishes via the page's own L0), so at least one
 * always lands on the hemisphere the Sun View camera sees. Raw Carrington
 * longitudes do NOT do this — where they fall depends on the date — and this
 * spec was flaky for exactly that reason once S2 made the flare local: before
 * it, an X-class lit the whole disc whether a region was visible or not, so the
 * σ this measures did not depend on there being anything to see.
 */
const AR_STONYHURST = [0, 90, 180, 270];
function swpcState(xrayIntensity, cls, l0Deg) {
    const carr = stony => ((stony + l0Deg) % 360 + 360) % 360;
    return {
        __synthetic: true,
        solar_wind: { speed: 450, density: 5, temperature: 8e4, bt: 6, bz: -2, bx: 1, by: 1 },
        kp: 3, xray_flux: 2.8e-4, xray_class: cls, xray_series: [], proton_series: [],
        flare_class: cls, flare_letter: cls[0], flare_time: null,
        flare_location: 'N12W40', flare_watts: 2.8e-4,
        active_regions: AR_STONYHURST.map((stony, i) => ({
            region: 14101 + i, lat_deg: 12, lon_deg: carr(stony),
            lat_rad: 12 * DEG, lon_rad: carr(stony) * DEG,
            area_norm: 0.6, mag_class: 'beta-gamma-delta', is_complex: true, num_spots: 20,
        })),
        flares: [], recent_flares: [],
        derived: {
            wind_speed_norm: 0.5, wind_density_norm: 0.5, bt_norm: 0.5, bz: -2, bz_southward: 0.2,
            xray_intensity: xrayIntensity, kp_norm: 0.33, storm_level: 0, f107_norm: 0.5,
            proton_10mev_norm: 0, electron_2mev_norm: 0, speed: 450, text: 'test',
        },
        status: 'ok', lastUpdated: new Date(), storm_mode: false, new_major_flare: false,
        flare_direction: null,
        proton_flux_10mev: 0.1, proton_flux_100mev: 0.01, electron_flux_2mev: 100, sep_storm_level: 0,
        aurora_power_north: 20, aurora_power_south: 20, aurora_activity: 'quiet', active_alerts: [],
        f107_flux: 150, recent_cmes: [], earth_directed_cme: null, cme_eta_hours: null,
        donki_notifications: [], donki_flares: [], gst_events: [], current_gst: null,
        sep_events: [], recent_sep_event: null, radiation_storm_active: false, new_cme_detected: false,
        dst_index: -5, kp_1min: 3, proton_diff_1mev: 0,
    };
}

async function openPage(page) {
    await page.route('**/services.swpc.noaa.gov/**', r => r.abort());
    await page.route('**/api/**', r => r.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"upstream_unavailable"}' }));
    // Only synthetic space weather reaches the page: the real feed polls in
    // three tiers and a late (empty) dispatch would reset u_flare_str between
    // the drive and the screenshot.
    await page.addInitScript(() => {
        const orig = window.dispatchEvent.bind(window);
        window.dispatchEvent = (ev) => {
            if (ev?.type === 'swpc-update' && !ev.detail?.__synthetic) return true;
            return orig(ev);
        };
    });
    await page.goto('/solar-system.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__solarRender && !!window.__solarFlare, null, { timeout: 30_000 });
    // Sun View, panel closed — see METHOD above.
    await page.evaluate(() => {
        document.getElementById('cam-sun')?.click();
        document.getElementById('panel')?.classList.remove('open');
        document.getElementById('backdrop')?.classList.remove('show');
    });
    await page.waitForTimeout(1200);
}

async function setSpaceWeather(page, xrayIntensity, cls) {
    const l0 = await page.evaluate(() => window.__solarFlare.state.l0Deg);
    await page.evaluate(s => window.dispatchEvent(new CustomEvent('swpc-update', { detail: s })),
        swpcState(xrayIntensity, cls, l0));
    await page.waitForTimeout(600);
}

/**
 * Statistics over the brightest `topN` pixels inside 0.92 × the photosphere
 * radius. The PNG is decoded by the browser itself (a data: URL does not taint
 * a 2D canvas), which keeps this spec free of any image dependency.
 */
async function discStats(page, topN = 8000) {
    const disc = await page.evaluate(() => window.__solarRender.discPx());
    const png = await page.locator('canvas').first().screenshot();
    return page.evaluate(async ({ b64, disc, topN }) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        // The screenshot is in device pixels; discPx() is in CSS pixels.
        const s = cv.width / disc.w;
        const cx = disc.cx * s, cy = disc.cy * s, r = disc.r * s * 0.92;

        const px = [];
        for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(cv.height, Math.ceil(cy + r)); y++) {
            for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(cv.width, Math.ceil(cx + r)); x++) {
                if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
                const i = (y * cv.width + x) * 4;
                const R = d[i], G = d[i + 1], B = d[i + 2];
                px.push([R, G, B, 0.2126 * R + 0.7152 * G + 0.0722 * B]);
            }
        }
        px.sort((a, b) => b[3] - a[3]);
        const top = px.slice(0, Math.min(topN, px.length));
        const n = top.length;
        const mean = k => top.reduce((a, p) => a + p[k], 0) / n;
        const mL = mean(3);
        const sigma = Math.sqrt(top.reduce((a, p) => a + (p[3] - mL) ** 2, 0) / n);
        return {
            n, discPixels: px.length,
            rgb: [mean(0), mean(1), mean(2)].map(v => Math.round(v)),
            sigma,
            clippedRG: top.filter(p => p[0] >= 255 && p[1] >= 255).length / n,
            clippedAny: top.filter(p => p[0] >= 255 || p[1] >= 255 || p[2] >= 255).length / n,
        };
    }, { b64: png.toString('base64'), disc, topN });
}

test.describe('solar-system.html tone mapping', () => {

    test('the Sun\'s disc carries spatial structure instead of clipping to white', async ({ page }) => {
        test.setTimeout(150_000);
        await page.setViewportSize({ width: 1400, height: 900 });
        const errors = collectPageErrors(page);
        await openPage(page);

        // ── Quiet Sun ──────────────────────────────────────────────────────
        await setSpaceWeather(page, 0.17, 'A1');      // GOES background — js/swpc-feed.js maps 1e-8 → 0.17
        const quiet = await discStats(page);
        expect(quiet.discPixels, 'Sun View frames a disc big enough to sample').toBeGreaterThan(20_000);
        expect(quiet.clippedRG, `quiet: R,G clipped on ${(quiet.clippedRG * 100).toFixed(1)} % of the brightest disc pixels`)
            .toBeLessThan(0.20);
        expect(quiet.sigma, `quiet: luminance σ over the disc = ${quiet.sigma.toFixed(2)} (was 1.64, fully clipped)`)
            .toBeGreaterThan(2);

        // ── X2.8 ───────────────────────────────────────────────────────────
        // js/swpc-feed.js: clamp01((log10(2.8e-4) + 9) / 6) = 0.91.
        await setSpaceWeather(page, 0.91, 'X2.8');
        expect(await page.evaluate(() => window.__solarRender.flareStr)).toBeCloseTo(0.91, 5);
        const flare = await discStats(page);
        expect(flare.clippedRG, `X2.8: R,G clipped on ${(flare.clippedRG * 100).toFixed(1)} % of the brightest disc pixels`)
            .toBeLessThan(0.20);
        expect(flare.sigma, `X2.8: luminance σ over the disc = ${flare.sigma.toFixed(2)} (was 0.00 — a white cut-out)`)
            .toBeGreaterThan(4);

        // NOTE — there is deliberately no `flare.sigma > quiet.sigma` here. That
        // assertion lived here while S1 was the only fix and an X-class lit the
        // WHOLE photosphere, so the flare state trivially had the wider spread.
        // S2 made the flare local, and a local flare does not have to raise the
        // spread over the brightest 8 000 pixels of the whole disc — measured
        // afterwards, quiet σ 12.6 against X-class 9.3, with both far above
        // their own floors. Whether a flare READS AS AN EVENT is a question
        // about the flaring region, not about the disc, and it is gated where it
        // belongs: tests/solar-system-flare-response.spec.js.

        expect(errors, errors.join('\n')).toEqual([]);
    });

    test('every custom fragment shader runs the tone curve and the colour-space encode', async () => {
        // STRUCTURAL, not pixel-based. The measurement above only sees the Sun;
        // this is what catches the NEXT shader being added on the old pattern.
        // Every shader on this page is a `/* glsl */` template literal, so each
        // one that writes gl_FragColor must also carry both chunks — otherwise
        // it is on the second colour pipeline and three.js's ACES curve and
        // sRGB encode never run on it.
        const files = [
            'solar-system.html',
            'js/neo-layer.js',     // NEO sprites + meteoroid streams
            'js/neo-rocks.js',     // NEO bodies up close
            'js/jupiter-shader.js', // drawn by this page AND jupiter-system.html
        ];
        const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
        const offenders = [];
        let checked = 0;

        for (const rel of files) {
            const src = await readFile(path.join(root, rel), 'utf8');
            // Each shader is a tagged template: /* glsl */`…`
            const re = /\/\* glsl \*\/`([\s\S]*?)`/g;
            let m, idx = 0;
            while ((m = re.exec(src)) !== null) {
                idx++;
                const body = m[1];
                if (!/gl_FragColor\s*=/.test(body)) continue;   // vertex shader
                checked++;
                const hasTone = body.includes('#include <tonemapping_fragment>');
                const hasSpace = body.includes('#include <colorspace_fragment>');
                if (!hasTone || !hasSpace) {
                    const line = src.slice(0, m.index).split('\n').length;
                    offenders.push(`${rel}:${line} (shader #${idx}) missing ${!hasTone ? '<tonemapping_fragment>' : ''}${!hasTone && !hasSpace ? ' + ' : ''}${!hasSpace ? '<colorspace_fragment>' : ''}`);
                }
            }
        }

        // 15, not 16: S3 replaced the two glow shells with ONE integrated corona.
        expect(checked, 'found the fragment shaders to check').toBe(15);
        expect(offenders, `shaders still on the raw colour pipeline:\n  ${offenders.join('\n  ')}`).toEqual([]);
    });

    test('no stray backtick has split a GLSL template literal', async () => {
        // A BACKTICK IN A COMMENT INSIDE A /* glsl */ TEMPLATE LITERAL ENDS IT.
        // Writing `col` or `arNear` in a shader comment — the obvious way to
        // name an identifier in prose — terminates the literal, and the rest of
        // the shader becomes JavaScript. It broke this page three separate times
        // while S1 and S2 were being written, each time surfacing only as a
        // mystery "Unexpected identifier" at page load with no line worth
        // reading. This catches it in Node in milliseconds.
        //
        // The test: every /* glsl */ literal must contain something that is
        // actually GLSL. A split leaves a fragment that is pure prose.
        const files = ['solar-system.html', 'js/neo-layer.js', 'js/neo-rocks.js',
                       'js/jupiter-shader.js', 'js/tone-decode.js'];
        const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
        const split = [];
        for (const rel of files) {
            const src = await readFile(path.join(root, rel), 'utf8');
            const re = /\/\* glsl \*\/`([\s\S]*?)`/g;
            let m;
            while ((m = re.exec(src)) !== null) {
                const body = m[1];
                const looksLikeGlsl = /\bvoid\s+main\s*\(|gl_FragColor|gl_Position|\b(?:float|vec[234]|mat[234]|bool|int)\s+\w+\s*\(/.test(body);
                if (!looksLikeGlsl) split.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
            }
        }
        expect(split, `a /* glsl */ literal with no shader in it — a backtick in a comment probably split it:\n  ${split.join('\n  ')}`).toEqual([]);
    });
});
