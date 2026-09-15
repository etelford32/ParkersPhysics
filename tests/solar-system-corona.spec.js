/**
 * solar-system-corona.spec.js — the Sun reads as a star, not a target.
 * ═══════════════════════════════════════════════════════════════════════════
 * The corona used to be two back-side spheres at r = 1.9 and r = 2.8 whose
 * alpha was pow(rim, n) with rim = 1 - max(dot(normal, viewDir), 0)
 * (SOLAR_SYSTEM_VISUAL_REVIEW.md §1.3, S3).
 *
 * THAT EXPRESSION DOES NOT VARY ON A BACK-SIDE SPHERE. The rendered faces are
 * the far hemisphere, whose outward normals point away from the camera, so the
 * dot product is negative, max() clamps it to zero, and rim is identically 1
 * over every drawn fragment. Both shells were flat plates with hard rims.
 * Measured on the radial profile at Sun View, in units of the drawn disc
 * radius, with everything but the Sun and its shells hidden:
 *
 *     1.25 R   132.5
 *     1.35 R    35.5      <- a 73 % cliff in one step
 *     1.35 R .. 1.85 R    35.52 EXACTLY, five consecutive annuli: a plate
 *     1.95 R    12.6
 *     2.05 R     0.0      <- a second cliff, to nothing
 *     2.35 R .. 3.05 R     0.2 -> 7.8, RISING: the second shell's own rim
 *
 * A bright annulus, a cliff, a flat plate, a cliff to nothing, a gap, then a
 * second ring further out. After: a single analytic shell, 51.7 falling
 * smoothly and monotonically to the 8-bit floor, with no step anywhere.
 *
 * METHOD, and two things that will bite whoever edits this.
 *
 * 1. THE SAMPLE IS A WEDGE, NOT AN ANNULUS. The canvas carries DOM overlays —
 *    the data panel on the left, the live-status bar at the top, the consent
 *    banner and toolbar at the bottom — and an element screenshot includes
 *    whatever is painted over the element. A full annulus averages them in,
 *    and past ~2.7 R the bottom overlay alone turned a falling profile into a
 *    rising one (21 counts in the south sector against 1 in the east). The drawn
 *    corona is spherically symmetric by construction, so one clean wedge about
 *    +x is the whole story.
 * 2. THE PROFILE'S END IS THE DENSITY MODEL, NOT THE MESH. Verified by moving
 *    the mesh from 3.33 to 3.87 R_sun and re-measuring: the profile did not
 *    move by a single count. That is the property S3 is really about — the
 *    geometry's silhouette must never be the visual edge — and it is asserted
 *    below against the mesh's live radius rather than a remembered number.
 */

import { test, expect } from '@playwright/test';

const DEG = Math.PI / 180;
const WEDGE = 30 * DEG;          // half-angle of the sample wedge about +x
const R_FROM = 1.15, R_TO = 3.65, R_STEP = 0.10;

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

function swpcState(xrayIntensity, cls) {
    return {
        __synthetic: true,
        solar_wind: { speed: 450, density: 5, temperature: 8e4, bt: 6, bz: -2, bx: 1, by: 1 },
        kp: 3, xray_flux: 1e-6, xray_class: cls, xray_series: [], proton_series: [],
        flare_class: cls, flare_letter: cls[0], flare_time: null, flare_location: null, flare_watts: 1e-6,
        active_regions: [], flares: [], recent_flares: [],
        derived: {
            wind_speed_norm: 0.5, wind_density_norm: 0.5, bt_norm: 0.5, bz: -2, bz_southward: 0.2,
            xray_intensity: xrayIntensity, kp_norm: 0.33, storm_level: 0, f107_norm: 0.5,
            proton_10mev_norm: 0, electron_2mev_norm: 0, speed: 450, text: 'test',
        },
        status: 'ok', lastUpdated: new Date(), storm_mode: false, new_major_flare: false, flare_direction: null,
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
    await page.addInitScript(() => {
        const orig = window.dispatchEvent.bind(window);
        window.dispatchEvent = (ev) => {
            if (ev?.type === 'swpc-update' && !ev.detail?.__synthetic) return true;
            return orig(ev);
        };
    });
    await page.goto('/solar-system.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__solarRender && !!window.__solarFlare, null, { timeout: 30_000 });
    await page.evaluate(() => {
        document.getElementById('cam-sun')?.click();
        document.getElementById('panel')?.classList.remove('open');
        document.getElementById('backdrop')?.classList.remove('show');
    });
    await page.waitForTimeout(1200);
}

/** Hide everything but the photosphere and the corona shell. */
async function isolateCorona(page) {
    await page.evaluate(() => {
        const R = window.__solarRender;
        R.sunMesh.parent.children.forEach(o => {
            o.visible = (o === R.sunMesh || o.name === 'corona-shell');
        });
    });
    await page.waitForTimeout(500);
}

/** Mean luminance in a +-30° wedge about +x, per annulus, in disc radii. */
async function radialProfile(page) {
    const disc = await page.evaluate(() => window.__solarRender.discPx());
    const png = await page.locator('canvas').first().screenshot();
    return page.evaluate(async ({ b64, disc, WEDGE, R_FROM, R_TO, R_STEP }) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        const s = cv.width / disc.w, cx = disc.cx * s, cy = disc.cy * s, R = disc.r * s;
        const rows = [];
        for (let k = R_FROM; k <= R_TO + 1e-9; k += R_STEP) {
            const r0 = R * (k - R_STEP / 2), r1 = R * (k + R_STEP / 2);
            let sum = 0, n = 0;
            for (let y = Math.max(0, Math.floor(cy - r1)); y < Math.min(cv.height, cy + r1); y++) {
                for (let x = Math.max(0, Math.floor(cx - r1)); x < Math.min(cv.width, cx + r1); x++) {
                    const dd = Math.hypot(x - cx, y - cy);
                    if (dd < r0 || dd > r1) continue;
                    if (Math.abs(Math.atan2(y - cy, x - cx)) > WEDGE) continue;
                    const i = (y * cv.width + x) * 4;
                    sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
                    n++;
                }
            }
            rows.push({ k: +k.toFixed(2), L: n ? sum / n : 0, n });
        }
        return rows;
    }, { b64: png.toString('base64'), disc, WEDGE, R_FROM, R_TO, R_STEP });
}

test.describe('solar-system.html corona', () => {

    test('one shell, falling smoothly, ending before its own geometry', async ({ page }) => {
        test.setTimeout(200_000);
        await page.setViewportSize({ width: 1400, height: 900 });
        const errors = collectPageErrors(page);
        await openPage(page);

        // ── Structure: ONE shell, and not a 24-gon ──────────────────────────
        const shell = await page.evaluate(() => {
            const R = window.__solarRender;
            const found = R.sunMesh.parent.children.filter(o => o.name === 'corona-shell');
            if (found.length !== 1) return { count: found.length };
            const p = found[0].geometry?.parameters || {};
            return {
                count: 1, radius: p.radius, widthSegments: p.widthSegments, heightSegments: p.heightSegments,
                backSide: found[0].material?.side === 1, additive: found[0].material?.blending === 2,
                depthWrite: found[0].material?.depthWrite,
            };
        });
        expect(shell.count, 'exactly one corona shell (there used to be two)').toBe(1);
        expect(shell.widthSegments, `corona segments = ${shell.widthSegments} (was 24; the outer shell read as a visible 24-gon)`)
            .toBeGreaterThanOrEqual(64);
        expect(shell.heightSegments).toBeGreaterThanOrEqual(64);
        expect(shell.backSide, 'the shell is back-side').toBe(true);
        expect(shell.depthWrite, 'and does not write depth').toBe(false);

        await isolateCorona(page);
        const prof = await radialProfile(page);
        // eslint-disable-next-line no-console
        console.log('corona radial profile (wedge about +x):\n' +
            prof.map(r => `  ${r.k.toFixed(2)}R ${r.L.toFixed(2).padStart(7)}`).join('\n'));

        // Everything above the 8-bit quantisation floor is the measurable part.
        const live = prof.filter(r => r.L > 2);
        expect(live.length, 'the corona is actually drawn').toBeGreaterThan(8);

        // ── 1. NO PLATE ─────────────────────────────────────────────────────
        // Five consecutive annuli read 35.52 EXACTLY on the old shells, because
        // pow(rim, n) is constant over a back-side hemisphere. A real radial
        // profile falls at every step.
        for (let i = 0; i + 1 < live.length; i++) {
            const drop = (live[i].L - live[i + 1].L) / live[i].L;
            expect(drop, `${live[i].k}R -> ${live[i + 1].k}R: ${live[i].L.toFixed(2)} -> ${live[i + 1].L.toFixed(2)}, the profile must FALL at every step (the old shells sat flat at 35.52 for five annuli)`)
                .toBeGreaterThan(0.04);
        }

        // ── 2. NO CLIFF ─────────────────────────────────────────────────────
        // The old profile dropped 132.5 -> 35.5 in one step (73 %) and then
        // 12.6 -> 0.0 (100 %). A power-law falloff sampled this finely cannot.
        for (let i = 0; i + 1 < live.length; i++) {
            const drop = (live[i].L - live[i + 1].L) / live[i].L;
            expect(drop, `${live[i].k}R -> ${live[i + 1].k}R drops ${(drop * 100).toFixed(0)} % in one step — that is an edge, not a falloff`)
                .toBeLessThan(0.40);
        }

        // ── 3. NO SECOND RING ───────────────────────────────────────────────
        // The old outer shell put a local MAXIMUM at 3.05 R, past a gap of
        // literal zeroes. Monotone all the way out, floor included.
        for (let i = 0; i + 1 < prof.length; i++) {
            expect(prof[i + 1].L, `${prof[i + 1].k}R (${prof[i + 1].L.toFixed(2)}) is brighter than ${prof[i].k}R (${prof[i].L.toFixed(2)}) — a second ring`)
                .toBeLessThanOrEqual(prof[i].L + 0.5);
        }

        // ── 4. THE MESH SILHOUETTE IS NOT THE VISUAL EDGE ───────────────────
        // Asserted against the shell's LIVE radius, so shrinking the mesh to
        // fit the glow fails here rather than looking tidy.
        const meshInDiscRadii = shell.radius / 1.5;      // SUN_R scene units per R_sun
        const lastLit = prof.filter(r => r.L >= 0.5).pop();
        expect(lastLit, 'the corona has a measurable extent').toBeTruthy();
        expect(lastLit.k, `the glow ends at ${lastLit.k}R but the mesh silhouette is at ${meshInDiscRadii.toFixed(2)}R — it must fade out well inside its own geometry`)
            .toBeLessThan(meshInDiscRadii * 0.92);

        expect(errors, errors.join('\n')).toEqual([]);
    });

    test('an eruption lights the corona', async ({ page }) => {
        test.setTimeout(200_000);
        await page.setViewportSize({ width: 1400, height: 900 });
        await openPage(page);
        await isolateCorona(page);

        const at = async (xr, cls) => {
            await page.evaluate(s => window.dispatchEvent(new CustomEvent('swpc-update', { detail: s })), swpcState(xr, cls));
            await page.waitForTimeout(700);
            const p = await radialProfile(page);
            // A mid-corona annulus, above the quantisation floor and clear of the limb.
            return p.find(r => Math.abs(r.k - 1.55) < 1e-6).L;
        };
        const quiet = await at(0.17, 'A1');      // A-class background
        const flare = await at(0.91, 'X2.8');
        // eslint-disable-next-line no-console
        console.log(`corona at 1.55R — A1 ${quiet.toFixed(2)}, X2.8 ${flare.toFixed(2)}`);
        expect(flare, `the corona at 1.55R went ${quiet.toFixed(2)} -> ${flare.toFixed(2)} from A-class background to X2.8`)
            .toBeGreaterThan(quiet * 1.15);
    });
});
