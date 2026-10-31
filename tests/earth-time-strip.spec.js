/**
 * earth-time-strip.spec.js — the weather strip under the EarthView slider
 * (EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md §3 the cube, §6 the strip).
 *
 * Hermetic (tests/helpers/earthview-harness.mjs boot: maps from assets/earth,
 * every other external request aborted). The page's own feeds therefore have
 * nothing; the gate SEEDS the real WeatherHistory with a known day — 24 h of
 * observations and 48 h of NWP forecast, rain every 12 h for 3 h — and checks
 * that the strip, through the REAL WeatherCube, shows exactly that:
 *
 *   1. The strip's time axis is the slider's: its measured thumb travel
 *      lines up with the range input to the pixel.
 *   2. Bands: observed then forecast, nothing outside the seeded hours.
 *   3. Rain bars at the seeded rain hours and only there.
 *   4. Dragging the strip scrubs the shared clock (through the slider's own
 *      events) and the cube answers for the new instant.
 *   5. The hover readout prints the cube's value with units and its source.
 *   6. Event markers: rain starts at the seeded onsets, a freeze each night,
 *      and a marker click moves the clock to its instant.
 *   7. Loop playback: ⟲ plays ±24 h on repeat inside its window; a hand on
 *      the strip stops it; Shift-drag picks a custom window and loops it.
 *   NEGATIVE CONTROL: with the history emptied the strip draws no rain and no
 *   temperature — it must not invent weather when there is none.
 *
 * Run with --workers=1 on the sandbox (parallel SwiftShader workers kill the
 * browser session — EARTHVIEW_VISUAL_DIALIN_PLAN.md §2).
 */
import { test, expect } from '@playwright/test';
import { boot } from './helpers/earthview-harness.mjs';

test.describe.configure({ mode: 'serial' });
test.setTimeout(240_000);

const PLACE = { lat: 40.0, lon: -105.25, city: 'Boulder' };
const HOUR = 3_600_000;

async function seed(page) {
    return page.evaluate(({ HOUR }) => {
        const h = window._wxGridHistory;
        const W = 72, H = 36, N = W * H;
        const now = Math.floor(Date.now() / HOUR) * HOUR;
        const frame = (k) => {
            const c = new Float32Array(N * 9);
            for (let i = 0; i < N; i++) {
                c[i] = 1 + 8 * Math.sin((2 * Math.PI * k) / 24);    // T: a diurnal swing through 0 °C
                c[N + i] = 1013;                                     // MSLP
                c[2 * N + i] = 60;                                   // RH
                c[3 * N + i] = 3; c[4 * N + i] = -2;                 // wind
                c[5 * N + i] = 40; c[6 * N + i] = 20; c[7 * N + i] = 10;
                c[8 * N + i] = (((k % 12) + 12) % 12) < 3 ? 3 : 0;   // rain 3 h in every 12
            }
            return c;
        };
        for (let k = -23; k <= 0; k++) h.ingest({ t: now + k * HOUR, source: 'seed-obs', gridW: W, gridH: H, coarse: frame(k) });
        for (let k = 1; k <= 48; k++) h.ingestForecast({ t: now + k * HOUR, source: 'seed-nwp', gridW: W, gridH: H, coarse: frame(k) });
        return now;
    }, { HOUR });
}

async function stripState(page) {
    return page.evaluate(() => {
        const d = window.__evTimeStrip?.debug();
        const strip = document.getElementById('tc-strip').getBoundingClientRect();
        const slider = document.getElementById('tc-scrub').getBoundingClientRect();
        if (!d?.model) return null;
        const m = d.model;
        return {
            place: d.place, version: d.version, domain: d.domain,
            strip: { left: strip.left, width: strip.width, top: strip.top, height: strip.height },
            slider: { left: slider.left, right: slider.right },
            trackX0: m.trackX0, trackX1: m.trackX1,
            bands: m.bands.map((b) => ({ p: b.provenance, x0: b.x0, x1: b.x1 })),
            precip: m.precip.map((b) => b.x + b.w / 2),
            tempSegs: m.tempSegs.length,
            cubeVersion: window.__evCube.version,
        };
    });
}

async function waitForRepaint(page, minVersion) {
    await page.waitForFunction((v) => {
        const d = window.__evTimeStrip?.debug();
        return d?.model && d.version >= v && d.version === window.__evCube.version;
    }, minVersion, { timeout: 30_000 });
}

test('the strip shows the cube\'s weather for the place, on the slider\'s axis, and scrubs', async ({ page }) => {
    await page.addInitScript((loc) => localStorage.setItem('ppx_user_location', JSON.stringify(loc)), PLACE);
    const errors = await boot(page, '', { clouds: false });
    await page.waitForFunction(() => window.__evTimeStrip && window.__evCube && window._wxGridHistory?.isReady, null, { timeout: 60_000 });

    const v0 = await page.evaluate(() => window.__evCube.version);
    const now = await seed(page);
    await waitForRepaint(page, v0 + 1);
    const s = await stripState(page);
    expect(s, 'strip model').not.toBeNull();
    expect(s.place.label).toContain('Boulder');

    // 1. The axis is the slider's thumb travel, to the pixel.
    expect(Math.abs((s.strip.left + s.trackX0) - (s.slider.left + 7))).toBeLessThan(1);
    expect(Math.abs((s.strip.left + s.trackX1) - (s.slider.right - 7))).toBeLessThan(1);

    const X = (t) => s.trackX0 + ((t - s.domain.t0) / (s.domain.t1 - s.domain.t0)) * (s.trackX1 - s.trackX0);
    const pxPerHour = (s.trackX1 - s.trackX0) * HOUR / (s.domain.t1 - s.domain.t0);

    // 2. Bands: observed up to now, then forecast; nothing before the seed or
    //    after +48 h. (The page's in-browser nowcast may claim the first
    //    hours after now — that is the cube's rule, and it is still forecast.)
    const provs = s.bands.map((b) => b.p);
    expect(provs[0]).toBe('observed');
    expect(provs.at(-1)).toBe('nwp');
    expect(Math.abs(s.bands[0].x0 - X(now - 23 * HOUR))).toBeLessThan(1.5);
    expect(Math.abs(s.bands.at(-1).x1 - X(now + 48 * HOUR))).toBeLessThan(1.5);

    // 3. Rain bars only at seeded rain hours (k mod 12 ∈ {0,1,2}).
    expect(s.precip.length).toBeGreaterThan(10);
    for (const x of s.precip) {
        const k = Math.round((s.domain.t0 + ((x - s.trackX0) / (s.trackX1 - s.trackX0)) * (s.domain.t1 - s.domain.t0) - now) / HOUR);
        expect(((k % 12) + 12) % 12, `bar at hour ${k}`).toBeLessThan(3);
    }
    expect(s.tempSegs).toBeGreaterThan(30);

    // The canvas actually painted something.
    const inked = await page.evaluate(() => {
        const c = document.querySelector('#tc-strip canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
    });
    expect(inked).toBeGreaterThan(500);

    // 4. Drag to +24 h scrubs the shared clock through the slider.
    const y = s.strip.top + s.strip.height / 2;
    const xTarget = s.strip.left + X(now + 24 * HOUR);
    await page.mouse.move(s.strip.left + X(now), y);
    await page.mouse.down();
    await page.mouse.move(xTarget, y, { steps: 6 });
    const tip = await page.locator('#tc-strip .tc-strip-tip').textContent();
    // STRIP_SHOT=<dir>: capture the bar + readout for a visual check.
    if (process.env.STRIP_SHOT) {
        const bar = await page.locator('#time-controls').boundingBox();
        await page.screenshot({ path: `${process.env.STRIP_SHOT}/time-strip.png`,
            clip: { x: bar.x - 6, y: bar.y - 6, width: bar.width + 12, height: bar.height + 90 } });
    }
    await page.mouse.up();
    const minutes = Number(await page.locator('#tc-scrub').inputValue());
    expect(Math.abs(minutes - 24 * 60)).toBeLessThanOrEqual(Math.ceil(60 / pxPerHour) + 2);

    // The strip's cursor follows the clock to the thumb's centre.
    await page.waitForFunction(({ want }) => {
        const c = document.querySelector('#tc-strip .tc-strip-cursor');
        const strip = document.getElementById('tc-strip').getBoundingClientRect();
        const m = /translateX\(([-\d.]+)px\)/.exec(c.style.transform);
        return m && Math.abs(strip.left + Number(m[1]) - want) < 2;
    }, { want: xTarget }, { timeout: 20_000 });

    // 5. The readout is the cube's value at that instant, with units + source.
    const want = await page.evaluate(({ PLACE, t }) => window.__evCube.sample('t2m', PLACE.lat, PLACE.lon, t), { PLACE, t: now + 24 * HOUR });
    expect(tip).toContain('°C');
    expect(tip).toContain('Boulder');
    expect(tip).toMatch(/Forecast \(NWP\)|Nowcast/);
    expect(want.value).not.toBeNull();

    // 6. Markers: rain onsets at k ≡ 0 (mod 12) wherever the SEEDED frames
    //    paint (the in-browser nowcast may own the first hours after now with
    //    its own model — that span is exempt), freezes each night, and a
    //    click on a marker moves the clock to it.
    const dbg = await page.evaluate(() => {
        const d = window.__evTimeStrip.debug();
        const cov = window.__evCube.coverage().filter((r) => r.provenance === 'nowcast');
        return { events: d.events, markers: d.markers.length, nowcast: cov[0] ?? null };
    });
    const inNowcast = (t) => dbg.nowcast && t > dbg.nowcast.t0 && t <= dbg.nowcast.t1 + HOUR;
    const starts = dbg.events.filter((e) => e.type === 'rain-start' && !inNowcast(e.t));
    expect(starts.length).toBeGreaterThanOrEqual(3);
    for (const e of starts) expect((((Math.round((e.t - now) / HOUR)) % 12) + 12) % 12, `rain start at ${(e.t - now) / HOUR} h`).toBe(0);
    expect(dbg.events.filter((e) => e.type === 'freeze').length).toBeGreaterThanOrEqual(2);
    expect(dbg.markers).toBeGreaterThan(0);
    // Across 21 days the strip is ~1 px/h, so the 15 px separation keeps the
    // higher-priority markers (freezes) and drops crowded rain onsets — by
    // design; click whichever marker survived.
    const mark = page.locator('#tc-strip .tc-strip-mark').first();
    const markT = Number(await mark.getAttribute('data-t'));
    await mark.click();
    expect(Math.abs(Number(await page.locator('#tc-scrub').inputValue()) - Math.round((markT - Date.now()) / 60_000))).toBeLessThanOrEqual(2);
    expect(await mark.getAttribute('aria-label')).toMatch(/(Rain|Below freezing|Wind|Aurora).* Jump to this time/);

    // 7. Loop ±24 h: the clock moves on its own, stays in the window, stops on a hand.
    await page.locator('#tc-loop').click();
    await expect(page.locator('#tc-loop')).toHaveAttribute('aria-pressed', 'true');
    const seen = new Set();
    await expect.poll(async () => {
        const v = Number(await page.locator('#tc-scrub').inputValue());
        expect(v).toBeGreaterThanOrEqual(-24 * 60 - 2);
        expect(v).toBeLessThanOrEqual(24 * 60 + 2);
        seen.add(v);
        return seen.size;
    }, { timeout: 60_000, intervals: [300] }).toBeGreaterThanOrEqual(3);
    await page.mouse.click(s.strip.left + X(now + 30 * HOUR), y);
    await expect(page.locator('#tc-loop')).toHaveAttribute('aria-pressed', 'false');
    const parked = Number(await page.locator('#tc-scrub').inputValue());
    await page.waitForTimeout(1500);
    expect(Number(await page.locator('#tc-scrub').inputValue())).toBe(parked);

    // Shift-drag: a custom window, looped.
    await page.keyboard.down('Shift');
    await page.mouse.move(s.strip.left + X(now + 2 * HOUR), y);
    await page.mouse.down();
    await page.mouse.move(s.strip.left + X(now + 10 * HOUR), y, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const lp = await page.evaluate(() => window.__evTimeStrip.loop);
    expect(lp.active).toBe(true);
    expect(lp.id).toBe('custom');
    expect(Math.abs((lp.window.t1 - lp.window.t0) / HOUR - 8)).toBeLessThan(1.5);
    await expect(page.locator('#tc-loop-range')).toHaveValue('custom');
    if (process.env.STRIP_SHOT) {
        await page.locator('#tc-strip .tc-strip-mark').first().hover();
        const bar = await page.locator('#time-controls').boundingBox();
        await page.screenshot({ path: `${process.env.STRIP_SHOT}/time-strip-loop.png`,
            clip: { x: bar.x - 6, y: bar.y - 6, width: bar.width + 12, height: bar.height + 30 } });
    }
    await page.keyboard.press('l');
    await expect(page.locator('#tc-loop')).toHaveAttribute('aria-pressed', 'false');

    expect(errors, errors.join('\n')).toEqual([]);

    // NEGATIVE CONTROL: no data → no rain, no line (never invented weather).
    const v1 = await page.evaluate(() => {
        const h = window._wxGridHistory;
        h._ring._buf = new Array(h._ring._cap); h._ring._head = 0; h._ring._size = 0;
        h.purgeStaleForecasts(Infinity);
        window._wxPaintProvider?._applyDense(null);
        return window.__evCube.version;
    });
    await waitForRepaint(page, v1);
    const empty = await stripState(page);
    expect(empty.precip.length).toBe(0);
    expect(empty.tempSegs).toBe(0);
    expect(empty.bands.length).toBe(0);
});
