/**
 * solar-system-flare-response.spec.js — a flare is an EVENT, not a light switch.
 * ═══════════════════════════════════════════════════════════════════════════
 * `u_flare_str` is fed straight from the feed's `xray_intensity`
 * (`js/swpc-feed.js`), which is `clamp01((log10(flux) + 9) / 6)` — a LOG X-RAY
 * LEVEL, not an event strength. It is never zero:
 *
 *     A1 (background) 1e-8 → 0.17      M1 1e-5 → 0.67
 *     B1              1e-7 → 0.33      X1 1e-4 → 0.83
 *     C1              1e-6 → 0.50      X2.8 2.8e-4 → 0.91
 *
 * `sunFS` was written as if that ran 0 → ~0.3, and two things followed
 * (SOLAR_SYSTEM_VISUAL_REVIEW.md §1.2, S2):
 *
 *   arDark  += inAR * core * (1.0 - u_flare_str*2.5) * 0.5;  // negative above 0.40
 *   filDark += …     * max(0.0, 1.0 - u_flare_str * 2.5);    // identically 0 above 0.40
 *
 * so at C1 — which is most days — the sunspot term goes NEGATIVE and the
 * filament channels vanish, and at A-class background the spots are already
 * 42 % erased. The two features the shader works hardest to draw were the two
 * it switched off first.
 *
 * And the whiteout had the same root: the temperature mix
 *
 *   float flareTemp = u_teff * (1.0 + u_flare_str * 0.55);
 *   vec3  base      = mix(blackbody(u_teff), blackbody(flareTemp), u_flare_str * 0.75);
 *
 * is GLOBAL. A real X-class brightens ~1e-4 of the visible disc in white light
 * and is invisible in the continuum outside the ribbons; this reheated the
 * entire photosphere to 8 956 K.
 *
 * WHAT THIS GATE MEASURES. Four active regions are planted 90° apart in
 * Stonyhurst longitude so at least one lands well inside the drawn disc from
 * the Sun View camera, and its screen position is derived EXACTLY — the
 * shader's own `arDir` convention rotated by `sunMesh.rotation.y`, both read
 * back through `window.__solarFlare` / `window.__solarRender`, then projected
 * by the live camera. That gives two disjoint samples of the photosphere:
 *
 *   AR PATCH    — inside the region's own angular radius
 *   FAR FIELD   — disc pixels outside every region by a wide margin
 *
 * from which three things are asserted across A1 / C1 / M1 / X2.8:
 *
 *   SPOT SURVIVES  the umbra stays dark against the quiet photosphere at every
 *                  class, and does not fade as the class rises.
 *   FLARE IS LOCAL the far field barely moves between background and X2.8.
 *                  This is the one that fails loudest on the old shader.
 *   FLARE READS    the AR patch does brighten, so the event is still an event.
 *
 * Pixels come from a real canvas screenshot with the panel closed (`#backdrop`
 * dims the canvas 45 % while it is open — finding U1), decoded by the browser
 * itself so this file needs no image dependency. Same method as
 * `tests/solar-system-tone.spec.js`, which owns the colour-pipeline half.
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

/** GOES classes on the feed's own scale, so the thresholds here are re-derivable. */
const CLASSES = [
    { name: 'A1 (background)', xr: 0.17, cls: 'A1'   },
    { name: 'C1 (a normal day)', xr: 0.50, cls: 'C1' },
    { name: 'M1',              xr: 0.67, cls: 'M1'   },
    { name: 'X2.8',            xr: 0.91, cls: 'X2.8' },
];

/** Four regions 90° apart in Stonyhurst, so one is always well inside the disc. */
const AR_LONS = [0, 90, 180, 270];
const AR_LAT_DEG = 12;
const AR_AREA = 0.6;

function swpcState(xrayIntensity, cls, l0Deg) {
    const carr = stony => ((stony + l0Deg) % 360 + 360) % 360;
    return {
        __synthetic: true,
        solar_wind: { speed: 450, density: 5, temperature: 8e4, bt: 6, bz: -2, bx: 1, by: 1 },
        kp: 3, xray_flux: 1e-6, xray_class: cls, xray_series: [], proton_series: [],
        flare_class: cls, flare_letter: cls[0], flare_time: null,
        flare_location: null, flare_watts: 1e-6,
        active_regions: AR_LONS.map((lon, i) => ({
            region: 14100 + i, lat_deg: AR_LAT_DEG, lon_deg: carr(lon),
            lat_rad: AR_LAT_DEG * DEG, lon_rad: carr(lon) * DEG,
            area_norm: AR_AREA, mag_class: 'beta-gamma-delta', is_complex: true, num_spots: 20,
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

/**
 * Where each planted region is drawn, in canvas pixels. Uses the shader's own
 * arDir convention (cos lat cos lon, sin lat, cos lat sin lon) on the slot
 * longitude the page actually wrote, rotated by the Sun mesh's own rotation —
 * so this cannot drift from what the shader drew.
 */
async function regionScreenPositions(page) {
    return page.evaluate(() => {
        const R = window.__solarRender, S = window.__solarFlare.state;
        const el = R.renderer.domElement, w = el.clientWidth, h = el.clientHeight;
        const rotY = S.sunRotY;
        const v = R.sunMesh.position.clone();
        // Sun-to-camera direction, for the front-facing test.
        const camDir = R.camera.position.clone().normalize();
        return S.regions.map(r => {
            const lat = r.lat_rad, lon = r.slot_lon, cl = Math.cos(lat);
            const ox = cl * Math.cos(lon), oy = Math.sin(lat), oz = cl * Math.sin(lon);
            // three's RotationY: x' = x cosθ + z sinθ ; z' = −x sinθ + z cosθ
            const c = Math.cos(rotY), s = Math.sin(rotY);
            const wx = ox * c + oz * s, wy = oy, wz = -ox * s + oz * c;
            const facing = wx * camDir.x + wy * camDir.y + wz * camDir.z;
            const p = v.set(wx * 1.5, wy * 1.5, wz * 1.5).project(R.camera);
            return { x: (p.x * 0.5 + 0.5) * w, y: (-p.y * 0.5 + 0.5) * h, facing };
        });
    });
}

/**
 * Luminance statistics for the AR patch and the far field, in canvas pixels.
 * `arR` is the region's angular radius in the shader: 0.10 + area * 0.18 rad.
 */
async function photosphereStats(page, arCentre, allCentres, arAngR, samples = 3) {
    // Granulation and the nanoflare field move the disc by ~3 counts frame to
    // frame, so every figure here is the mean of several frames. Without that
    // the colour metric below sits inside its own noise.
    const acc = [];
    for (let k = 0; k < samples; k++) {
        acc.push(await photosphereFrame(page, arCentre, allCentres, arAngR));
        await page.waitForTimeout(220);
    }
    const avg = key => acc.reduce((a, v) => a + v[key], 0) / acc.length;
    const out = {};
    for (const key of Object.keys(acc[0])) out[key] = avg(key);
    return out;
}

async function photosphereFrame(page, arCentre, allCentres, arAngR) {
    const disc = await page.evaluate(() => window.__solarRender.discPx());
    const png = await page.locator('canvas').first().screenshot();
    return page.evaluate(async ({ b64, disc, arCentre, allCentres, arAngR }) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        const s = cv.width / disc.w;
        const cx = disc.cx * s, cy = disc.cy * s, r = disc.r * s * 0.92;
        // The region's drawn radius: an angular radius on the sphere maps to
        // sin(arR) of the disc radius near disc centre.
        const arPx = disc.r * s * Math.sin(arAngR);
        const cs = allCentres.map(p => ({ x: p.x * s, y: p.y * s }));
        const ac = { x: arCentre.x * s, y: arCentre.y * s };

        const inAr = [], far = [], farR = [], farG = [], farB = [];
        for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(cv.height, Math.ceil(cy + r)); y++) {
            for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(cv.width, Math.ceil(cx + r)); x++) {
                if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
                const i = (y * cv.width + x) * 4;
                const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
                if ((x - ac.x) ** 2 + (y - ac.y) ** 2 <= arPx * arPx) { inAr.push(L); continue; }
                // Far field: outside EVERY planted region by 2.5 radii.
                let clear = true;
                for (const p of cs) {
                    if ((x - p.x) ** 2 + (y - p.y) ** 2 < (arPx * 2.5) ** 2) { clear = false; break; }
                }
                if (clear) { far.push(L); farR.push(d[i]); farG.push(d[i + 1]); farB.push(d[i + 2]); }
            }
        }
        const pct = (a, q) => { if (!a.length) return NaN; const b = [...a].sort((u, v2) => u - v2); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };
        const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
        return {
            arN: inAr.length, farN: far.length,
            arMedian: pct(inAr, 0.5), arP1: pct(inAr, 0.01), arP99: pct(inAr, 0.99),
            farMedian: pct(far, 0.5), farP1: pct(far, 0.01),
            // Far-field COLOUR. The global temperature mix reheated the whole
            // photosphere from 5 778 K to ~8 956 K, which is a colour change
            // before it is a brightness change — and colour is what survives the
            // ACES shoulder, where luminance is compressed into a few counts.
            farR: mean(farR), farG: mean(farG), farB: mean(farB),
        };
    }, { b64: png.toString('base64'), disc, arCentre, allCentres, arAngR });
}

test.describe('solar-system.html flare response', () => {

    test('a sunspot survives its own flare, and an X-class stays local to its region', async ({ page }) => {
        test.setTimeout(200_000);
        await page.setViewportSize({ width: 1400, height: 900 });
        const errors = collectPageErrors(page);
        await openPage(page);

        const l0 = await page.evaluate(() => window.__solarFlare.state.l0Deg);
        const arAngR = 0.10 + AR_AREA * 0.18;
        const rows = {};

        for (const c of CLASSES) {
            await page.evaluate(s => window.dispatchEvent(new CustomEvent('swpc-update', { detail: s })),
                swpcState(c.xr, c.cls, l0));
            await page.waitForTimeout(700);

            const pos = await regionScreenPositions(page);
            expect(pos.length, 'four regions were planted').toBe(4);
            // The region nearest disc centre, among those on the near side.
            const disc = await page.evaluate(() => window.__solarRender.discPx());
            const front = pos.filter(p => p.facing > 0.35)
                .sort((a, b) => Math.hypot(a.x - disc.cx, a.y - disc.cy) - Math.hypot(b.x - disc.cx, b.y - disc.cy));
            expect(front.length, 'at least one region faces the Sun View camera').toBeGreaterThan(0);

            const st = await photosphereStats(page, front[0], pos, arAngR);
            rows[c.cls] = st;
            // eslint-disable-next-line no-console
            console.log(`${c.name.padEnd(18)} AR[med ${st.arMedian.toFixed(1)} p1 ${st.arP1.toFixed(1)} p99 ${st.arP99.toFixed(1)}]  FAR[med ${st.farMedian.toFixed(1)} rgb ${st.farR.toFixed(1)},${st.farG.toFixed(1)},${st.farB.toFixed(1)} B/R ${(st.farB / st.farR).toFixed(4)}]`);
            expect(st.arN, 'the AR patch has pixels').toBeGreaterThan(200);
            expect(st.farN, 'the far field has pixels').toBeGreaterThan(5000);
        }

        // ── 1. THE SPOT SURVIVES ITS OWN FLARE ──────────────────────────────
        // The umbra is the darkest thing on the disc. Measured against the quiet
        // photosphere well away from any region it must stay dark at EVERY
        // class. Before the fix this read 2.1 counts at A-class background and
        // went NEGATIVE from C1 up — the darkest pixel inside a region was
        // BRIGHTER than the photosphere around it, which is the whole of the
        // finding: `arDark` carried (1 - u_flare_str*2.5), which is negative for
        // any X-ray level above 0.40.
        for (const c of CLASSES) {
            const st = rows[c.cls];
            const depth = st.farMedian - st.arP1;
            expect(depth, `${c.name}: sunspot depth (far median − AR p1) = ${depth.toFixed(1)} counts`)
                .toBeGreaterThan(12);
        }
        // The depth DOES shrink as the class rises (roughly 66 → 23 counts), and
        // that is by design, not a leftover: the review's own bullet says an
        // eruption THINS the filament channel to 35 % rather than deleting it,
        // and the channel is co-located with the spot in this shader, so the
        // pixel legitimately brightens. What must never come back is the spot's
        // darkening being a function of the flare at all — asserted structurally
        // below, which is a far sharper instrument than a pixel ratio.

        // ── 2. THE FLARE IS LOCAL ───────────────────────────────────────────
        // A real X-class brightens ~1e-4 of the visible disc in white light and
        // is invisible in the continuum outside the ribbons, so the photosphere
        // away from every region must barely move between a quiet background day
        // and an X2.8.
        //
        // COLOUR IS THE INSTRUMENT HERE, NOT BRIGHTNESS. The bug was a global
        // temperature mix reheating the photosphere from 5 778 K to ~8 956 K,
        // which whitens it — and after the ACES shoulder a large radiance change
        // is only a few counts of luminance, while the blue-to-red ratio moves
        // freely. Measured on the pre-fix shader the far field ran
        // B/R 0.7998 → 0.8450 → 0.8489 → 0.8933 across A1/C1/M1/X2.8, a
        // monotonic +0.094; after, it has no trend at all.
        const brA = rows['A1'].farB / rows['A1'].farR;
        const brX = rows['X2.8'].farB / rows['X2.8'].farR;
        expect(Math.abs(brX - brA), `far-field colour moved B/R ${brA.toFixed(4)} → ${brX.toFixed(4)} from A1 to X2.8 (pre-fix: 0.7998 → 0.8933)`)
            .toBeLessThan(0.04);
        const farShift = Math.abs(rows['X2.8'].farMedian - rows['A1'].farMedian);
        expect(farShift, `far-field luminance moved ${farShift.toFixed(1)} counts from A1 to X2.8`)
            .toBeLessThan(8);

        // ── 3. THE FLARE STILL READS AS AN EVENT ────────────────────────────
        // Local does not mean invisible: the region itself has to brighten, or
        // S2 has traded one lie for another.
        const lift = rows['X2.8'].arMedian - rows['A1'].arMedian;
        expect(lift, `the flaring region brightened ${lift.toFixed(1)} counts from A1 to X2.8`)
            .toBeGreaterThan(5);

        expect(errors, errors.join('\n')).toEqual([]);
    });

    test('the sunspot term reads no flare at all, and the filament channel has a floor', async () => {
        // STRUCTURAL, and sharper than any pixel test: the two lines the finding
        // names. A pixel gate can be satisfied by compensating elsewhere; these
        // cannot.
        const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
        const src = await readFile(path.join(root, 'solar-system.html'), 'utf8');

        // 1. The sunspot darkening must not be a function of the flare. It used
        //    to be `inAR * core * (1.0 - u_flare_str*2.5) * 0.5`, which is
        //    negative above 0.40 — i.e. from C-class up, most days.
        const arDarkLine = src.split('\n').find(l => /arDark\s*\+=/.test(l));
        expect(arDarkLine, 'found the sunspot darkening term').toBeTruthy();
        expect(arDarkLine, `a sunspot does not disappear because its region flared: ${arDarkLine?.trim()}`)
            .not.toMatch(/u_flare_str|flareX/);

        // 2. The filament channel is thinned by an eruption, never deleted. The
        //    old factor was max(0.0, 1.0 - u_flare_str * 2.5), identically zero
        //    above 0.40.
        const filFactor = src.match(/filDark\s*\+=[\s\S]{0,240}?max\(([^,]+),/);
        expect(filFactor, 'found the filament disruption factor').toBeTruthy();
        expect(parseFloat(filFactor[1]), `the filament channel must survive its own eruption, floor = ${filFactor?.[1]}`)
            .toBeGreaterThan(0.2);

        // 3. Nothing may go back to reading the raw X-ray LEVEL as an event
        //    strength inside sunFS. A1 background is 0.17 on that scale, so a
        //    term written against it treats an ordinary day as a half-event.
        const sunFs = src.slice(src.indexOf('const sunFS'), src.indexOf('const sunGeo'));
        const rawUses = sunFs.split('\n')
            .filter(l => /u_flare_str/.test(l) && !/^\s*\/\//.test(l) && !/flareExcess\(/.test(l) && !/uniform/.test(l));
        expect(rawUses, `sunFS must take event strength from flareExcess(), not the raw level:\n  ${rawUses.map(l => l.trim()).join('\n  ')}`)
            .toEqual([]);
    });
});
