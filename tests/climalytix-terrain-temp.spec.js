/**
 * climalytix-terrain-temp.spec.js — temperature on the REAL ground, cast
 * shadows, and the site's Sun path.
 *
 * Feeds are mocked (tests/fixtures/climalytix-mocks.mjs). The GFS field
 * carries MSLP for a FLAT model surface at 2 000 m (`modelZ`), and the DEM is
 * the closed-form east–west ridge MOCK_RIDGE (1 500 m plain, 3 500 m crest at
 * 40.0° N) — so every correction is a number:
 *   · the model height is flat ⇒ no relief to fit ⇒ the standard −6.5 K/km,
 *     and the rail says so
 *   · the plain is 500 m BELOW the model surface ⇒ +3.25 K; the crest 1 500 m
 *     ABOVE it ⇒ −9.75 K
 * What it pins:
 *   · terrain detail is ON by default and draws the ridge into the heat —
 *     NEGATIVE CONTROL: toggled off, the crest and the plain are the same
 *     smooth field again
 *   · a run with no MSLP, or elevation tiles down, falls back to GFS's own
 *     field and says which — the heat still draws
 *   · the tooltip names both heights
 *   · sun & shade: at midday the ridge's south flank is warmer and its north
 *     flank cooler than flat ground, the plain is untouched, the effect view
 *     draws it alone; NEGATIVE CONTROLS: the toggle off, and night, are nothing
 *   · cold-air pooling: at night the ridge's foot is colder and its crest
 *     milder, the plain untouched; NEGATIVE CONTROLS: the toggle off, and day
 *   · the clock is the current MINUTE: the field is interpolated between GFS
 *     frames (NEGATIVE CONTROL: the nearest frame) and the Sun is at the instant
 *   · terrain shadows: a low Sun to the south shades the ridge's north flank;
 *     NEGATIVE CONTROL: at night nothing is drawn (night is not a shadow)
 *   · the Sun path chart draws with or without a horizon, and says which
 */
import { test, expect } from '@playwright/test';
import { installClimalytixMocks, MOCK_RIDGE } from './fixtures/climalytix-mocks.mjs';
import { solarPosition } from '../js/sun-altitude.js';

const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const MODEL_Z = 2000;

test.describe.configure({ timeout: 90_000 });
test.use({ locale: 'en-US', timezoneId: 'America/Denver', reducedMotion: 'reduce', viewport: { width: 1366, height: 900 } });

async function boot(page, mocks = {}) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    await installClimalytixMocks(page, mocks);
    await page.addInitScript((device) => {
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('ppx_user_location', JSON.stringify(device));
        localStorage.setItem('ppx_tour_completed', '1');
    }, BOULDER);
    await page.goto('/climalytix.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
        const s = window.__climalytix?.state;
        return s && s.loading.length === 0 && s.map && s.field?.state !== 'loading' && s.map.drawn.heat;
    }, null, { timeout: 60_000 });
    await page.evaluate(() => document.querySelectorAll('.pp-consent-banner,.tour-overlay,.tour-tooltip').forEach((e) => e.remove()));
    await page.selectOption('#cx-units', 'metric');
    await page.locator('#cx-layer-airflow').uncheck();
    return errors;
}
const state = (page) => page.evaluate(() => window.__climalytix.state);
const detailIs = (page, want) => page.waitForFunction((w) => window.__climalytix.state.map.frame.detail?.state === w, want, { timeout: 30_000 });
const nextFrame = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
/** Mean colour of an 8×8 block at a canvas point given as fractions of the stage. */
const sampleAt = (page, fx, fy) => page.evaluate(([x, y]) => {
    const c = document.getElementById('cx-map-canvas');
    const d = c.getContext('2d').getImageData(Math.round(c.width * x), Math.round(c.height * y), 8, 8).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
    return sum.map((v) => Math.round(v / 64));
}, [fx, fy]);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Stage fraction (y) of a latitude, from the map's own view (equirectangular: linear in latitude). */
const latFrac = async (page, lat) => {
    const { view } = (await state(page)).map;                 // map-view.js scales(): ky = h / span
    return 0.5 - (lat - view.lat) / view.span;
};

test('terrain detail draws the ridge into the temperature; off, it is GFS\'s smooth field again', async ({ page }) => {
    const errors = await boot(page, { modelZ: MODEL_Z });
    await detailIs(page, 'on');
    await page.locator('#cx-layer-tsun').uncheck();          // the HEIGHT correction alone (sun & shade and
    await page.locator('#cx-layer-tpool').uncheck();         // cold-air pooling have their own tests)
    await nextFrame(page);
    let s = await state(page);
    const d = s.map.frame.detail;
    // A flat model surface has no relief to fit a lapse rate from.
    expect(d.lapse.source).toBe('standard');
    expect(d.lapse.gamma).toBe(-6.5);
    // The plain is 500 m below the model surface, the crest 1 500 m above it.
    expect(d.correction.max).toBeCloseTo(-6.5 * (MOCK_RIDGE.base - MODEL_Z) / 1000, 1);            // +3.25 K
    const crestK = -6.5 * (MOCK_RIDGE.base + MOCK_RIDGE.rise - MODEL_Z) / 1000;                     // −9.75 K
    expect(d.correction.min).toBeLessThan(crestK * 0.8);
    expect(d.correction.min).toBeGreaterThanOrEqual(crestK - 0.05);
    expect(s.map.drawn.detail).toBe(true);
    await expect(page.locator('#cx-layer-tdetail')).toBeChecked();
    await expect(page.locator('#cx-heat-detail')).toHaveAttribute('data-state', 'on');
    await expect(page.locator('#cx-heat-detail')).toContainText('standard −6.5 K/km (too little relief in view)');
    await expect(page.locator('#cx-heat-detail')).toContainText('corrections −');

    // The ridge is IN the picture: the crest (40.0° N) against the plain 0.5° north of it.
    const yCrest = await latFrac(page, MOCK_RIDGE.lat), yPlain = await latFrac(page, MOCK_RIDGE.lat + 0.5);
    const onCrest = await sampleAt(page, 0.7, yCrest), onPlain = await sampleAt(page, 0.7, yPlain);
    expect(dist(onCrest, onPlain)).toBeGreaterThan(40);

    // The tooltip names both heights.
    const box = await page.locator('#cx-map-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * yPlain);
    await expect(page.locator('#cx-map-tip')).toContainText('GFS:');
    await expect(page.locator('#cx-map-tip')).toContainText('surface');
    await page.mouse.move(5, 5);

    // NEGATIVE CONTROL: detail off ⇒ no ridge in the temperature.
    await page.locator('#cx-layer-tdetail').uncheck();
    await nextFrame(page);
    s = await state(page);
    expect(s.map.frame.detail.state).toBe('off');
    expect(s.map.drawn.detail).toBe(false);
    await expect(page.locator('#cx-heat-detail')).toContainText('Terrain detail off');
    const offCrest = await sampleAt(page, 0.7, yCrest), offPlain = await sampleAt(page, 0.7, yPlain);
    expect(dist(offCrest, offPlain)).toBeLessThan(dist(onCrest, onPlain) / 2);
    // …and back on.
    await page.locator('#cx-layer-tdetail').check();
    await detailIs(page, 'on');
    await nextFrame(page);
    expect(dist(await sampleAt(page, 0.7, yCrest), onCrest)).toBeLessThan(4);
    expect(errors).toEqual([]);
});

test('sun & shade: the sunlit flank is warmer, the far flank cooler, flat ground untouched; off and at night it is nothing', async ({ page }) => {
    const errors = await boot(page, { modelZ: MODEL_Z });
    await detailIs(page, 'on');
    // A midday instant inside the run (Sun high in the south), and a night one with the Sun down the whole memory window.
    const start = Math.floor(Date.now() / 600_000) * 600_000;
    const sun = (ms) => solarPosition(new Date(ms), BOULDER.lat, BOULDER.lon);
    let noon = null, night = null;
    for (let m = 0; m < 30 * 60 && !(noon && night); m += 10) {
        const t = start + m * 60_000, p = sun(t);
        if (!noon && p.altitudeDeg > 20 && p.azimuthDeg > 172 && p.azimuthDeg < 188) noon = t;
        if (!night && p.altitudeDeg < -8 && sun(t - 6 * 3_600_000).altitudeDeg < 0) night = t;
    }
    expect(noon).not.toBeNull();
    expect(night).not.toBeNull();

    await page.locator('#cx-layer-tpool').uncheck();         // the sun term alone
    await page.evaluate((t) => window.__climalytix.map.setTime(t), noon);
    await page.waitForFunction(() => window.__climalytix.state.map.frame.detail?.sun?.state === 'on', null, { timeout: 30_000 });
    let s = await state(page);
    const sn = s.map.frame.detail.sun;
    expect(sn.range.max).toBeGreaterThan(0.15);                       // the south flank faces the noon Sun
    expect(sn.range.min).toBeLessThan(-0.15);                         // the north flank faces away
    expect(sn.range.max).toBeLessThan(6);
    expect(sn.cloud).toBe(true);
    await expect(page.locator('#cx-layer-tsun')).toBeChecked();
    await expect(page.locator('#cx-heat-sun')).toContainText('Sun & shade (modelled)');
    await expect(page.locator('#cx-heat-sun')).toContainText('°C in view');

    // The effect on its own: gold on the sunlit flank, indigo on the far one, nothing on the plain.
    // sampleAt reads an 8 px block DOWNWARD from its point and a flank is only ~9 px tall: start each at its flank's top.
    const ySouth = await latFrac(page, MOCK_RIDGE.lat - 0.008), yNorth = await latFrac(page, MOCK_RIDGE.lat + 0.095), yPlain = await latFrac(page, MOCK_RIDGE.lat + 0.5);
    const plainTemp = await sampleAt(page, 0.7, yPlain);
    await page.locator('#cx-heat-view [data-view="sun"]').click();
    await page.waitForFunction(() => window.__climalytix.state.map.frame.view === 'sun', null, { timeout: 10_000 });
    await nextFrame(page);
    await expect(page.locator('#cx-heat-view [data-view="sun"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#cx-map-key .cx-mk-title')).toContainText('Sun, shade & cold-air effect');
    await expect(page.locator('#cx-heat-key')).toHaveAttribute('data-scale', 'effect');
    const south = await sampleAt(page, 0.7, ySouth), north = await sampleAt(page, 0.7, yNorth), plain = await sampleAt(page, 0.7, yPlain);
    // The mock ridge's effect is a few tenths of a kelvin, so the tint is faint: judge each flank AGAINST the plain.
    const warm = (c) => c[0] - c[2];                                  // gold pushes red over blue, indigo the reverse
    expect(warm(south)).toBeGreaterThan(warm(plain) + 15);
    expect(warm(north)).toBeLessThan(warm(plain) - 6);
    expect(dist(plain, plainTemp)).toBeGreaterThan(20);               // the plain no longer wears the temperature colour: flat open ground is 0
    s = await state(page);
    expect(s.map.drawn.isotherms).toBe(0);                            // isotherms belong to the temperature, not the adjustment
    // The tooltip says how much, with its sign, on each flank.
    const box = await page.locator('#cx-map-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * ySouth);
    await expect(page.locator('#cx-map-tip')).toContainText(/effect \+\d/);
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * yNorth);
    await expect(page.locator('#cx-map-tip')).toContainText(/effect −\d/);
    await page.mouse.move(5, 5);

    // NEGATIVE CONTROL: the toggle off ⇒ no adjustment, the effect view has nothing to show and says so by leaving.
    await page.locator('#cx-layer-tsun').uncheck();
    await page.waitForFunction(() => window.__climalytix.state.map.frame.detail?.sun?.state === 'off', null, { timeout: 10_000 });
    await nextFrame(page);
    s = await state(page);
    expect(s.map.frame.view).toBe('temp');
    await expect(page.locator('#cx-heat-view [data-view="sun"]')).toBeDisabled();
    await expect(page.locator('#cx-heat-sun')).toHaveCount(0);
    expect(dist(await sampleAt(page, 0.7, yPlain), plainTemp)).toBeLessThan(4);
    await page.locator('#cx-layer-tsun').check();
    // Without terrain detail there is no slope to light: the toggle goes with it.
    await page.locator('#cx-layer-tdetail').uncheck();
    await expect(page.locator('#cx-layer-tsun')).toBeDisabled();
    await page.locator('#cx-layer-tdetail').check();
    await detailIs(page, 'on');

    // Night: the Sun has been down for the whole memory — nothing, and the rail says what is not modelled.
    await page.evaluate((t) => window.__climalytix.map.setTime(t), night);
    await page.waitForFunction(() => window.__climalytix.state.map.frame.detail?.sun?.state === 'night', null, { timeout: 30_000 });
    s = await state(page);
    expect([s.map.frame.detail.sun.range.min, s.map.frame.detail.sun.range.max]).toEqual([0, 0]);
    await expect(page.locator('#cx-heat-sun')).toContainText('no sunlight adjustment');
    await expect(page.locator('#cx-heat-pool')).toContainText('switched off');      // and says the night half is off
    await expect(page.locator('#cx-heat-view [data-view="sun"]')).toBeDisabled();
    expect(errors).toEqual([]);
});

test('cold-air pooling: at night the foot of the ridge is colder and its crest milder, the plain untouched; by day and off it is nothing', async ({ page }) => {
    const errors = await boot(page, { modelZ: MODEL_Z });
    await detailIs(page, 'on');
    await page.locator('#cx-layer-tsun').uncheck();          // the night term alone
    const start = Math.floor(Date.now() / 600_000) * 600_000;
    const sun = (ms) => solarPosition(new Date(ms), BOULDER.lat, BOULDER.lon);
    let night = null, noon = null;
    for (let m = 0; m < 30 * 60 && !(night && noon); m += 10) {
        const t = start + m * 60_000, p = sun(t);
        // Deep night: the Sun down now and for the six hours before.
        if (!night && p.altitudeDeg < -8 && [1, 2, 3, 4, 5, 6].every((h) => sun(t - h * 3_600_000).altitudeDeg < 0)) night = t;
        // Early afternoon: the Sun has been up six hours or more, long enough to have burnt the pool off.
        if (!noon && p.altitudeDeg > 15 && p.azimuthDeg > 200 && p.azimuthDeg < 230) noon = t;
    }
    expect(night).not.toBeNull();
    expect(noon).not.toBeNull();

    await page.evaluate((t) => window.__climalytix.map.setTime(t), night);
    await page.waitForFunction(() => window.__climalytix.state.map.frame.detail?.pool?.state === 'on', null, { timeout: 30_000 });
    let s = await state(page);
    const pl = s.map.frame.detail.pool;
    expect(pl.nightFrac).toBeGreaterThan(0.8);                        // six hours in: 1 − e^(−6/3) = 0.86 and rising
    expect(pl.range.min).toBeLessThan(-0.15);                         // the concave foot sits below its surroundings
    expect(pl.range.max).toBeGreaterThan(0.3);                        // the crest stands above them
    expect(pl.range.max).toBeLessThanOrEqual(3.01);                   // gain × the 4 K clear-calm inversion
    expect(s.map.frame.detail.sun.state).toBe('off');
    await expect(page.locator('#cx-heat-pool')).toContainText('Cold-air pooling (modelled)');
    await expect(page.locator('#cx-heat-pool')).toContainText('low ground colder');

    // The effect view at night: gold on the crest, indigo at the foot, nothing on the plain or the even flank.
    // sampleAt reads an 8 px block downward: the crest block straddles the crest, the foot block the foot line.
    const yCrest = await latFrac(page, MOCK_RIDGE.lat + 0.035), yFoot = await latFrac(page, MOCK_RIDGE.lat + MOCK_RIDGE.halfDeg + 0.035),
        yPlain = await latFrac(page, MOCK_RIDGE.lat + 0.5);
    const view = page.locator('#cx-heat-view [data-view="sun"]');
    await expect(view).toBeEnabled();                                 // the night has an effect to show now
    await view.click();
    await page.waitForFunction(() => window.__climalytix.state.map.frame.view === 'sun', null, { timeout: 10_000 });
    await nextFrame(page);
    await expect(page.locator('#cx-map-key .cx-mk-title')).toContainText('Sun, shade & cold-air effect');
    const warm = (c) => c[0] - c[2];
    const crest = await sampleAt(page, 0.7, yCrest), foot = await sampleAt(page, 0.7, yFoot), plain = await sampleAt(page, 0.7, yPlain);
    expect(warm(crest)).toBeGreaterThan(warm(plain) + 15);            // milder: gold
    expect(warm(foot)).toBeLessThan(warm(plain) - 6);                 // colder: indigo
    const box = await page.locator('#cx-map-canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * (await latFrac(page, MOCK_RIDGE.lat)));
    await expect(page.locator('#cx-map-tip')).toContainText(/effect \+\d/);
    await page.mouse.move(5, 5);
    await page.locator('#cx-heat-view [data-view="temp"]').click();
    await nextFrame(page);
    const corrOn = (await state(page)).map.frame.detail.correction;

    // NEGATIVE CONTROL: off ⇒ the crest's temperature goes back and the effect view has nothing to show.
    await page.locator('#cx-layer-tpool').uncheck();
    await page.waitForFunction(() => window.__climalytix.state.map.frame.detail?.pool?.state === 'off', null, { timeout: 10_000 });
    await nextFrame(page);
    const corrOff = (await state(page)).map.frame.detail.correction;       // the crest is the coldest correction in view:
    expect(corrOn.min - corrOff.min).toBeGreaterThan(0.1);                  // pooling had made it milder (a ±3 K term is too faint to judge by fit-scale pixels)
    await expect(page.locator('#cx-heat-view [data-view="sun"]')).toBeDisabled();
    await page.locator('#cx-layer-tpool').check();

    // By day the Sun has eroded it: nothing, and the rail says when it comes back.
    await page.evaluate((t) => window.__climalytix.map.setTime(t), noon);
    await page.waitForFunction(() => window.__climalytix.state.map.frame.detail?.pool?.state === 'day', null, { timeout: 30_000 });
    s = await state(page);
    expect(Math.max(Math.abs(s.map.frame.detail.pool.range.min), Math.abs(s.map.frame.detail.pool.range.max))).toBeLessThan(0.02);
    await expect(page.locator('#cx-heat-pool')).toContainText('builds after sunset');
    // Without terrain detail there is no ground to compare: the toggle goes with it.
    await page.locator('#cx-layer-tdetail').uncheck();
    await expect(page.locator('#cx-layer-tpool')).toBeDisabled();
    expect(errors).toEqual([]);
});

test('the map is the current MINUTE: the field is interpolated between GFS frames and the Sun is taken at that instant', async ({ page }) => {
    const errors = await boot(page, { modelZ: MODEL_Z });
    await detailIs(page, 'on');
    // Live: the clock is the wall clock floored to the minute, and the frame is AT it — not at a 3-hourly stamp.
    let s = await state(page);
    expect(s.map.timeMs).toBeNull();
    expect(s.map.clockMs % 60_000).toBe(0);
    expect(Math.abs(Date.now() - s.map.clockMs)).toBeLessThan(120_000);
    expect(s.map.frame.timeMs).toBe(s.map.clockMs);
    await expect(page.locator('#cx-heat-status')).toContainText('Now ·');
    const live = s.map.frame.blend;
    expect(live.t0Ms).toBeLessThanOrEqual(s.map.clockMs);
    expect(live.t1Ms).toBeGreaterThanOrEqual(s.map.clockMs);
    if (live.i0 !== live.i1) await expect(page.locator('#cx-heat-status')).toContainText('interpolated to the minute');

    // GFS's own field (terrain detail off), on a frame, on the next, and 47 minutes into the three hours between.
    await page.locator('#cx-layer-tdetail').uncheck();
    const at = async (ms) => {
        await page.evaluate((t) => window.__climalytix.map.setTime(t), ms);
        await page.waitForFunction((t) => window.__climalytix.state.map.frame.timeMs === t, ms, { timeout: 15_000 });
        return (await state(page)).map.frame;
    };
    const step = live.i0 !== live.i1 ? live.t1Ms - live.t0Ms : 3 * 3_600_000;
    const t0 = live.t0Ms, t1 = t0 + step, w = 47 / 180;
    const f0 = await at(t0), f1 = await at(t1), fm = await at(t0 + 47 * 60_000);
    expect(fm.timeMs).toBe(t0 + 47 * 60_000);
    expect(fm.blend.w).toBeCloseTo(w, 9);
    expect(f0.blend.w).toBe(0);
    // The mock's field is a fixed pattern plus a diurnal term, so its minimum is linear in time between frames.
    expect(Math.abs(f1.range.min - f0.range.min)).toBeGreaterThan(0.2);          // the frames do differ…
    expect(fm.range.min).toBeCloseTo(f0.range.min + w * (f1.range.min - f0.range.min), 2);
    // NEGATIVE CONTROL: the old rule showed the NEAREST frame — at 47 min that is frame 0, unchanged.
    expect(Math.abs(fm.range.min - f0.range.min)).toBeGreaterThan(0.05);
    // A second off the minute is that minute: the clock's grain.
    await page.evaluate((t) => window.__climalytix.map.setTime(t), t0 + 47 * 60_000 + 31_000);
    expect((await state(page)).map.clockMs).toBe(t0 + 47 * 60_000);

    // The Sun is taken at the instant: two times inside ONE pair of frames light the ridge differently.
    await page.locator('#cx-layer-tdetail').check();
    await page.locator('#cx-layer-tpool').uncheck();
    const start = Math.floor(Date.now() / 600_000) * 600_000;
    const sun = (ms) => solarPosition(new Date(ms), BOULDER.lat, BOULDER.lon);
    let a = null;
    for (let m = 0; m < 30 * 60 && a == null; m += 10) {
        const t = start + m * 60_000;
        if (sun(t).altitudeDeg > 12 && sun(t + 100 * 60_000).altitudeDeg > 12 && sun(t).azimuthDeg < 170) a = t;
    }
    expect(a).not.toBeNull();
    const sunAt = async (ms) => {
        await page.evaluate((t) => window.__climalytix.map.setTime(t), ms);
        await page.waitForFunction((t) => { const f = window.__climalytix.state.map.frame; return f.timeMs === t && f.detail?.sun?.state === 'on'; }, ms, { timeout: 30_000 });
        return (await state(page)).map.frame;
    };
    const fa = await sunAt(a + 7 * 60_000);                             // off every frame and every 10-minute mark
    const pair = [fa.blend.t0Ms, fa.blend.t1Ms];
    let b = a + 97 * 60_000;
    if (b >= pair[1]) b = a + 7 * 60_000 - 90 * 60_000 > pair[0] ? a + 7 * 60_000 - 90 * 60_000 : pair[1] - 60_000;
    const fb = await sunAt(b);
    expect([fb.blend.t0Ms, fb.blend.t1Ms]).toEqual(pair);              // same two frames…
    expect(Math.abs(fb.detail.sun.range.max - fa.detail.sun.range.max) + Math.abs(fb.detail.sun.range.min - fa.detail.sun.range.min))
        .toBeGreaterThan(0.01);                                         // …a different Sun, a different slope budget

    // Back to live: the minute tick redraws without a hand on the page.
    await page.evaluate(() => window.__climalytix.map.setTime(null));
    s = await state(page);
    expect(s.map.timeMs).toBeNull();
    expect(Math.abs(Date.now() - s.map.frame.timeMs)).toBeLessThan(120_000);
    expect(errors).toEqual([]);
});

test('no MSLP in the run, or elevation down: GFS\'s own field is shown and the rail says which', async ({ page }) => {
    let errors = await boot(page);                                   // the default mock run carries no MSLP
    let s = await state(page);
    expect(s.map.frame.detail.state).toBe('nofields');
    expect(s.map.drawn.heat).toBe(true);
    expect(s.map.drawn.detail).toBe(false);
    await expect(page.locator('#cx-heat-detail')).toContainText('this run carries no surface pressure');
    expect(errors).toEqual([]);

    errors = await boot(page, { modelZ: MODEL_Z, dem: 'down' });
    await detailIs(page, 'nodem');
    s = await state(page);
    expect(s.map.drawn.heat).toBe(true);
    expect(s.map.drawn.detail).toBe(false);
    await expect(page.locator('#cx-heat-detail')).toContainText('elevation tiles did not load');
    expect(errors).toEqual([]);
});

test('terrain shadows: a low southern Sun shades the ridge\'s north flank; night draws nothing', async ({ page }) => {
    const errors = await boot(page, { modelZ: MODEL_Z });
    // Temperature stays ON: a dark veil only shows on a bright field (the fixture's ground is dark).
    // An instant today with the Sun low in the south-east/south-west, and one at night.
    const day0 = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    let low = null, night = null;
    for (let m = 0; m < 1440; m += 5) {
        const p = solarPosition(new Date(day0 + m * 60_000), BOULDER.lat, BOULDER.lon);
        if (!low && p.altitudeDeg > 3 && p.altitudeDeg < 7 && p.azimuthDeg > 100 && p.azimuthDeg < 260) low = day0 + m * 60_000;
        if (!night && p.altitudeDeg < -10) night = day0 + m * 60_000;
    }
    expect(low).not.toBeNull();
    expect(night).not.toBeNull();

    await page.evaluate((t) => window.__climalytix.map.setTime(t), low);
    const yNorth = await latFrac(page, MOCK_RIDGE.lat + 0.07);        // on the north flank
    const before = await sampleAt(page, 0.7, yNorth);
    await page.locator('#cx-layer-shadow').check();
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.shadow?.drawn, null, { timeout: 30_000 });
    await nextFrame(page);
    let s = await state(page);
    expect(s.map.drawn.shadow.night).toBe(false);
    expect(s.map.drawn.shadow.shaded).toBeGreaterThan(50);
    expect(s.map.drawn.shadow.lit).toBeGreaterThan(s.map.drawn.shadow.shaded);       // the plain is lit
    const shaded = await sampleAt(page, 0.7, yNorth);
    expect(dist(shaded, before)).toBeGreaterThan(12);                                // the north flank went dark
    const ySouth = await latFrac(page, MOCK_RIDGE.lat - 0.07);
    await page.locator('#cx-layer-shadow').uncheck();
    await nextFrame(page);
    const southOff = await sampleAt(page, 0.7, ySouth);
    await page.locator('#cx-layer-shadow').check();
    await nextFrame(page);
    expect(dist(await sampleAt(page, 0.7, ySouth), southOff)).toBeLessThan(4);       // the Sun-facing flank did not
    await expect(page.locator('#cx-sun-status')).toContainText('terrain shades');

    // NEGATIVE CONTROL: night is not a shadow.
    await page.evaluate((t) => window.__climalytix.map.setTime(t), night);
    await page.waitForFunction(() => window.__climalytix.state.map.drawn.shadow?.night === true, null, { timeout: 30_000 });
    s = await state(page);
    expect(s.map.drawn.shadow.drawn).toBe(false);
    expect(s.map.drawn.shadow.shaded).toBe(0);
    await expect(page.locator('#cx-sun-status')).toContainText('Night is not a shadow');
    expect(errors).toEqual([]);
});

test('Sun path: today\'s arc against the terrain horizon; without elevation it says the horizon is missing', async ({ page }) => {
    let errors = await boot(page, { modelZ: MODEL_Z });
    await expect(page.locator('#cx-sun')).toBeHidden();
    await page.locator('#cx-layer-sun').check();
    await page.waitForFunction(() => window.__climalytix.state.sun?.horizon, null, { timeout: 30_000 });
    await expect(page.locator('#cx-sun')).toBeVisible();
    let s = await state(page);
    expect(s.sun.state).toBe('ok');
    expect(s.sun.open.sunMin).toBeGreaterThan(8 * 60);                // Boulder has 9–15 h of daylight all year
    expect(s.sun.open.sunMin).toBeLessThan(15.5 * 60);
    expect(s.sun.day.directMin).toBeLessThanOrEqual(s.sun.open.sunMin);
    expect(s.sun.open.noon.az).toBeGreaterThan(170);                  // the Sun culminates due south
    expect(s.sun.open.noon.az).toBeLessThan(190);
    expect(Object.keys(s.sun.horizon.angles).length).toBe(180);
    await expect(page.locator('#cx-sun-status')).toContainText('Sunrise');
    await expect(page.locator('#cx-sun-status')).toContainText('Horizon from the map’s elevation grid');
    const inked = await page.evaluate(() => {
        const c = document.querySelector('#cx-sun canvas'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let amber = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 220 && d[i + 1] > 150 && d[i + 2] < 120 && d[i + 3] > 200) amber++;
        return amber;
    });
    expect(inked).toBeGreaterThan(300);                               // the Sun's arc is drawn
    expect(errors).toEqual([]);

    errors = await boot(page, { modelZ: MODEL_Z, dem: 'down' });
    await page.locator('#cx-layer-sun').check();
    await page.waitForFunction(() => window.__climalytix.state.sun?.state === 'nodem', null, { timeout: 30_000 });
    s = await state(page);
    expect(s.sun.horizon).toBeNull();
    expect(s.sun.day.lostMin).toBe(0);                                // an unknown horizon takes nothing
    await expect(page.locator('#cx-sun')).toBeVisible();
    await expect(page.locator('#cx-sun-status')).toContainText('the terrain horizon is not drawn');
    expect(errors).toEqual([]);
});
