/**
 * solar-system-moon-light.spec.js — the Earth–Moon system is lit by physics.
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BUG THIS REPLACES. Every satellite on the orrery was a
 * `MeshStandardMaterial` with a hand-picked light-grey colour, lit by the
 * scene's PointLight. That is a PBR dielectric ball, and it is wrong about a
 * moon in three separate ways at once:
 *
 *   · LEVEL. The Moon's geometric albedo is 0.12 — darker than worn asphalt.
 *     A 0xc8c2b8 base colour draws it at roughly six times its real
 *     reflectance, which is why the drawn Moon read brighter than Earth.
 *   · LAW. Lambert shading puts a smooth cos-limb across the disc, so the
 *     body reads as a shiny ball. Airless regolith is Lommel–Seeliger
 *     (μ₀/(μ₀+μ)) and is nearly FLAT across the disc — that is why a full Moon
 *     looks like a coin and not a sphere.
 *   · GEOMETRY. Nothing in the old path knew what an eclipse was. The Moon
 *     sailed through Earth's shadow at full brightness, in a simulation whose
 *     whole point is that it is driven by real ephemerides.
 *
 * The moons now use the SAME shading as the NEO population
 * (`js/airless-body.js` — one copy of the law, so a moon and a rock of the
 * same albedo at the same distance render identically), and the same
 * occultation kernel (`js/eclipse-geometry.js`) the NEO layer uses for Earth's
 * shadow.
 *
 * WHAT THIS FILE PINS, and why each one can fail silently:
 *
 *  1. The satellites are on the shared shader at all. A revert to a built-in
 *     material renders something perfectly plausible — just wrong.
 *  2. The shader is handed REAL KILOMETRES, never the drawn frame. The orrery
 *     compresses the Moon's orbit to ~2 R_E instead of 60, so a shadow cone
 *     built in scene units would put the Moon inside the umbra permanently and
 *     look, from a screenshot, like a working eclipse model.
 *  3. The page agrees with the kernel on the SAME vectors. Not a remembered
 *     number: the assertion re-runs js/eclipse-geometry.js on exactly the
 *     uniforms the GPU received.
 *  4. Illumination is 1/r² at the PARENT's true distance, so Io is ~27× dimmer
 *     than the Moon. The old PointLight fall-off left the Galileans at ~1.6 %
 *     of Earth's light — all but black.
 *  5. A real total lunar eclipse happens at its real time, and the drawn Moon
 *     actually goes dark and copper-red when it does. Screenshot-measured.
 *  6. Planetshine peaks when the PARENT is full from the satellite. Nothing
 *     keys that; it falls out of the phase angle, so getting the sign wrong
 *     lights the night side from the wrong quarter of the sky and no static
 *     frame shows it.
 */

import { test, expect } from '@playwright/test';
import { shadowIllumination, BODY_ALBEDO, EARTH_RADIUS_KM, SUN_RADIUS_KM, UMBRAL_TRANSMISSION } from '../js/eclipse-geometry.js';

const AU_KM = 149_597_870.7;

const IGNORED_CONSOLE_ERRORS = [
    /fonts\.googleapis\.com/, /\/api\/telemetry\//, /\/api\/horizons/, /\/api\/noaa\//, /\/api\/donki\//,
    /\/api\/solar/, /\/api\/health/, /\/api\/neo\//, /\/api\/cme\//, /services\.swpc\.noaa\.gov/,
    /Failed to load resource/, /net::ERR/, /\[swpc-feed\]/, /\[earth-sim-bridge\]/, /supabase/i, /WebSocket/,
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

async function openPage(page) {
    await page.goto('/solar-system.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__solarRender?.moonLight && !!window.__solarFlare?.setSimDate,
        null, { timeout: 45_000 });
    // One applied frame: the uniforms are written by _updateMoonPosition inside
    // the animate loop, so a read before the first tick sees the constructor
    // defaults (u_illum = 1, Sun straight down +x) and every number is a lie.
    await page.waitForFunction(() => {
        const m = window.__solarRender.moonLight('moon');
        return !!m && Math.hypot(...m.occFromBodyKm) > 1000;
    }, null, { timeout: 45_000 });
    await page.evaluate(() => {
        document.getElementById('panel')?.classList.remove('open');
        document.getElementById('backdrop')?.classList.remove('show');
    });
}

/**
 * Drive the page's OWN clock and wait until the satellite's uniforms have
 * actually moved. `setSimDate` re-anchors the time base; the uniforms follow on
 * the next animation frame, and polling on a CHANGED value (rather than a fixed
 * timeout) is what makes this deterministic on a software rasteriser.
 */
async function setDate(page, iso) {
    const before = await page.evaluate(() => window.__solarRender.moonLight('moon').sunFromBodyKm[0]);
    await page.evaluate(d => window.__solarFlare.setSimDate(new Date(d)), iso);
    await page.waitForFunction(b => {
        const m = window.__solarRender.moonLight('moon');
        return !!m && Math.abs(m.sunFromBodyKm[0] - b) > 1;
    }, before, { timeout: 45_000 });
    // Two more frames so the value settles on the re-anchored clock.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/** Re-run the kernel on exactly the vectors the GPU was handed. */
function kernelOn(m) {
    // THE SCENE-AXIS SWAP IS IRRELEVANT HERE, on purpose. The uniforms are in
    // the page's (x, z, y) draw frame so the shader's normals and these vectors
    // share one basis; shadowIllumination only ever takes lengths and dot
    // products, both invariant under a coordinate permutation. Feeding it the
    // swapped vectors therefore measures the page's real geometry without this
    // test needing to know the page's axis convention at all.
    const v = a => ({ x: a[0], y: a[1], z: a[2] });
    return shadowIllumination({
        sunFromBody: v(m.sunFromBodyKm),
        occulterFromBody: v(m.occFromBodyKm),
        occulterRadiusKm: m.occRadiusKm,
        sunRadiusKm: m.sunRadiusKm,
    });
}

/** Mean colour of the drawn satellite disc, from a real canvas screenshot. */
async function moonDiscRgb(page, key = 'moon') {
    const disc = await page.evaluate(k => window.__solarRender.viewFromParent(k), key);
    // Let the re-aimed camera render.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const png = await page.locator('canvas').first().screenshot();
    return page.evaluate(async ({ b64, disc }) => {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
        const cv = document.createElement('canvas');
        cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        const ctx = cv.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        const s = cv.width / disc.w;
        // 0.7 of the drawn radius: inside the limb, so the shader's faint
        // edge term (which is a constant blue-grey and would wash out the
        // copper measurement) cannot contribute.
        const cx = disc.cx * s, cy = disc.cy * s, r = disc.r * s * 0.7;
        let n = 0, R = 0, G = 0, B = 0;
        for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(cv.height, Math.ceil(cy + r)); y++) {
            for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(cv.width, Math.ceil(cx + r)); x++) {
                if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
                const i = (y * cv.width + x) * 4;
                R += d[i]; G += d[i + 1]; B += d[i + 2]; n++;
            }
        }
        return { n, discR: disc.r, r: R / n, g: G / n, b: B / n, lum: (0.2126 * R + 0.7152 * G + 0.0722 * B) / n };
    }, { b64: png.toString('base64'), disc });
}

test.describe('solar-system.html — Earth, the Moon, and the light between them', () => {

    test('satellites are airless-regolith spheres carrying their published albedo', async ({ page }) => {
        test.setTimeout(120_000);
        const errors = collectPageErrors(page);
        await page.setViewportSize({ width: 1280, height: 800 });
        await openPage(page);

        const moon = await page.evaluate(() => window.__solarRender.moonLight('moon'));
        expect(moon.isShader, 'the Moon is on the shared airless shader, not a PBR ball').toBe(true);
        // THE LEVEL IS THE PUBLISHED ALBEDO, from the ONE table.
        expect(moon.albedo).toBeCloseTo(BODY_ALBEDO.moon, 6);
        expect(moon.albedo).toBeLessThan(0.15);
        expect(moon.occRadiusKm).toBeCloseTo(EARTH_RADIUS_KM, 0);
        expect(moon.sunRadiusKm).toBeCloseTo(SUN_RADIUS_KM, 0);
        expect(moon.bodyRadiusKm).toBeGreaterThan(1730);   // 1737.4
        expect(moon.bodyRadiusKm).toBeLessThan(1745);

        // The table is genuinely per-body and spans two decades of reflectance:
        // Enceladus is the most reflective surface in the solar system (a
        // geometric albedo ABOVE 1 is physical — it is a backscatter ratio, not
        // an energy budget), Phobos among the least. A single 0.14 constant for
        // everything is the thing this rules out.
        const keys = await page.evaluate(() => window.__solarRender.moonKeys);
        expect(keys).toContain('enceladus');
        expect(keys).toContain('phobos');
        const albedos = await page.evaluate(() =>
            ['enceladus', 'phobos', 'io', 'europa'].map(k => window.__solarRender.moonLight(k)?.albedo));
        const [enc, pho, io, eur] = albedos;
        expect(enc).toBeGreaterThan(1);
        expect(pho).toBeLessThan(0.1);
        expect(enc / pho).toBeGreaterThan(10);
        expect(eur).toBeGreaterThan(io);           // Europa's ice over Io's sulphur
        expect(errors).toEqual([]);
    });

    test('the light reaching a satellite is 1/r² at its own true heliocentric distance', async ({ page }) => {
        test.setTimeout(120_000);
        const errors = collectPageErrors(page);
        await page.setViewportSize({ width: 1280, height: 800 });
        await openPage(page);

        const [moon, io] = await page.evaluate(() =>
            ['moon', 'io'].map(k => window.__solarRender.moonLight(k)));

        // u_illum is (1 AU / r)². The Moon sits at 1 AU, Io at ~5.2 AU.
        expect(moon.illum).toBeGreaterThan(0.94);
        expect(moon.illum).toBeLessThan(1.07);
        expect(io.illum).toBeGreaterThan(1 / (5.6 * 5.6));
        expect(io.illum).toBeLessThan(1 / (4.8 * 4.8));
        // ~27× — this is the number the PointLight got catastrophically wrong.
        expect(moon.illum / io.illum).toBeGreaterThan(20);

        // And it is EXACTLY consistent with the Sun vector the same uniform
        // block carries: |sunFromBody| in AU, squared, is 1/illum. Exactly,
        // because the light is evaluated at the satellite and not at its
        // parent — the two differ by the orbit radius over the heliocentric
        // distance, 0.26 % at the Moon, and this equality is what says which
        // one the page used.
        for (const m of [moon, io]) {
            const rAU = Math.hypot(...m.sunFromBodyKm) / AU_KM;
            expect(1 / (rAU * rAU), `${m.key}: illum matches its own Sun vector`).toBeCloseTo(m.illum, 6);
        }
        expect(errors).toEqual([]);
    });

    test('the shader is handed REAL kilometres, not the drawn frame', async ({ page }) => {
        test.setTimeout(120_000);
        const errors = collectPageErrors(page);
        await page.setViewportSize({ width: 1280, height: 800 });
        await openPage(page);

        const m = await page.evaluate(() => window.__solarRender.moonLight('moon'));
        const dKm = Math.hypot(...m.occFromBodyKm);
        // Perigee 356 500 km, apogee 406 700 km — the real orbit, whatever the
        // page happens to be drawing.
        expect(dKm).toBeGreaterThan(350_000);
        expect(dKm).toBeLessThan(412_000);
        // THE DRAWN SEPARATION IS A DIFFERENT NUMBER ENTIRELY, and that is the
        // point: the orrery compresses the Moon's orbit to a couple of Earth
        // radii so the system is legible at all. If somebody ever wires the
        // drawn positions into these uniforms, dKm collapses to order 0.1 and
        // this assertion is what says so.
        expect(m.drawnSeparation).toBeLessThan(2);
        expect(dKm / m.drawnSeparation).toBeGreaterThan(100_000);
        // The real Earth–Moon geometry: Earth's disc is ~3.6× the Sun's from
        // the Moon (0.95° vs 0.266° radius), which is the whole reason a total
        // lunar eclipse can last hours.
        const earthAng = Math.asin(EARTH_RADIUS_KM / dKm);
        const sunAng = Math.asin(SUN_RADIUS_KM / Math.hypot(...m.sunFromBodyKm));
        expect(earthAng / sunAng).toBeGreaterThan(3);
        expect(errors).toEqual([]);
    });

    test('a real total lunar eclipse happens at its real time, and the Moon goes copper', async ({ page }) => {
        test.setTimeout(240_000);
        const errors = collectPageErrors(page);
        await page.setViewportSize({ width: 1280, height: 800 });
        await openPage(page);

        // Greatest eclipse, NASA five-millennium catalogue. Totality runs
        // ~11:04–12:02 UTC, so the mid-point is deep inside the umbra.
        const TOTALITY = '2026-03-03T11:33:00Z';
        // Control: the SAME full moon nine hours later — out of the penumbra
        // entirely, with the phase angle only ~4.8° different, so anything this
        // measures is the shadow and not the phase.
        const CONTROL = '2026-03-03T20:33:00Z';

        await setDate(page, TOTALITY);
        const inUmbra = await page.evaluate(() => window.__solarRender.moonLight('moon'));
        const kUmbra = kernelOn(inUmbra);
        expect(kUmbra.phase, `the page has the Moon in the umbra at ${TOTALITY}`).toBe('umbral');
        expect(kUmbra.lit).toBe(0);

        const dark = await moonDiscRgb(page);
        expect(dark.n, 'the Moon is actually drawn, and big enough to measure').toBeGreaterThan(2000);

        await setDate(page, CONTROL);
        const outside = await page.evaluate(() => window.__solarRender.moonLight('moon'));
        const kOut = kernelOn(outside);
        expect(kOut.phase, 'nine hours later the shadow has passed').toBe('none');
        expect(kOut.lit).toBe(1);

        const lit = await moonDiscRgb(page);

        // ── THE VISUAL CLAIM ────────────────────────────────────────────────
        // Totality is ~1.2 % of direct sunlight (UMBRAL_TRANSMISSION), put
        // through a pow(·, 0.38) display stretch, so the drawn ratio is far
        // from 0.012 — a compressed tone curve is exactly what keeps an
        // eclipsed Moon visible rather than a black hole in the sky. What the
        // gate asserts is the DIRECTION and a generous margin, not a pixel.
        expect(UMBRAL_TRANSMISSION).toBeLessThan(0.05);
        expect(lit.lum, 'the uneclipsed full Moon is clearly lit').toBeGreaterThan(30);
        expect(dark.lum / lit.lum, 'totality is a large, unambiguous darkening').toBeLessThan(0.55);

        // AND IT IS RED. Sunlight reaching the umbra has been refracted through
        // the whole thickness of Earth's atmosphere, which is why totality is
        // copper and not grey. The uneclipsed Moon is near-neutral, so the
        // blue-to-red ratio is the measurement that separates "darker" from
        // "eclipsed" — a naive brightness multiplier would pass the test above
        // and fail this one.
        const bOverR = s => s.b / Math.max(s.r, 1e-6);
        expect(bOverR(lit), 'an uneclipsed Moon is near-neutral').toBeGreaterThan(0.75);
        expect(bOverR(dark), 'totality is copper, not grey').toBeLessThan(bOverR(lit) - 0.15);
        expect(errors).toEqual([]);
    });

    test('planetshine peaks when the parent is full from the satellite', async ({ page }) => {
        test.setTimeout(240_000);
        const errors = collectPageErrors(page);
        await page.setViewportSize({ width: 1280, height: 800 });
        await openPage(page);

        // Eight samples across one synodic month. Earthshine is not keyed to
        // anything — it is reflectedIrradianceFraction() of the phase angle — so
        // if the geometry is right the maximum must land on NEW MOON, where the
        // Moon sees a full Earth. That is the ashen light on the dark limb of a
        // young crescent, and it is the one term whose sign cannot be checked
        // from a single frame.
        const base = Date.UTC(2026, 2, 3, 11, 33);
        const samples = [];
        for (let i = 0; i < 8; i++) {
            const t = new Date(base + i * 3.6875 * 86400e3).toISOString();
            await setDate(page, t);
            const m = await page.evaluate(() => window.__solarRender.moonLight('moon'));
            // cos of the angle, AT THE MOON, between the Sun and Earth. −1 means
            // Earth is opposite the Sun in the Moon's sky: a full Earth.
            const dot = (a, b) => (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) /
                (Math.hypot(...a) * Math.hypot(...b));
            samples.push({ t, shine: m.shine, cos: dot(m.sunFromBodyKm, m.occFromBodyKm) });
        }
        const max = samples.reduce((a, s) => s.shine > a.shine ? s : a);
        const min = samples.reduce((a, s) => s.shine < a.shine ? s : a);
        expect(max.cos, `brightest earthshine is at a FULL Earth (samples: ${JSON.stringify(samples)})`).toBeLessThan(-0.6);
        expect(min.cos, 'faintest earthshine is at a new Earth').toBeGreaterThan(0.3);
        // Earthshine is real but small: ~10⁻⁴ of direct sunlight at best. If it
        // ever reads as a percent-level term, something has lost the 1/r².
        expect(max.shine).toBeGreaterThan(1e-5);
        expect(max.shine).toBeLessThan(2e-3);
        expect(max.shine / Math.max(min.shine, 1e-12)).toBeGreaterThan(20);
        expect(errors).toEqual([]);
    });
});
