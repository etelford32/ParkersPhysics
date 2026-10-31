/**
 * earth-scrub-perf.spec.js — a time scrub must not cost a frame
 * (EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md T3, measured 2026-10-31).
 *
 * Before the scrub workers, every replay repaint ran the isobar contour
 * inline (~58 ms) and every hour crossed decoded its frame inline (~40 ms):
 * p50 50 ms / p90 68 ms of main-thread work per repaint with the default
 * layers on. This gate drives the REAL resolver across 24 h at a 10 Hz
 * repaint cadence with wind + isobars on and asserts:
 *
 *   1. main-thread cost per repaint: p90 under a 16.7 ms frame;
 *   2. hour crossings are served by the look-ahead (≤ 3 inline decodes —
 *      the first bracket has nothing to look ahead from);
 *   3. the isobars still update (latest-wins applies, not zero);
 *   4. the WORKER results are bit-identical to the inline path: the
 *      worker's isobar geometry equals computeIsobars on the same buffer,
 *      and a prefetched trio equals the feed's own inline decode;
 *   NEGATIVE CONTROL: the same scrub with `?scrubworker=0` must be at least
 *      3× more expensive at p90 — otherwise the gate is not measuring the
 *      thing it claims to.
 *
 * Absolute numbers are this machine's CPU (V8 runs natively here; only the
 * GPU is emulated), so the ratio is the portable claim. --workers=1.
 */
import { test, expect } from '@playwright/test';
import { boot } from './helpers/earthview-harness.mjs';

test.describe.configure({ mode: 'serial' });
test.setTimeout(400_000);

async function scrub(page) {
    await page.waitForFunction(() => window._wxResolver && window._wxGridHistory?.isReady && window.__evIsobars);
    await page.evaluate(() => {
        for (const id of ['lyr-isobars', 'lyr-wind']) {
            const el = document.getElementById(id);
            if (el && !el.checked) { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }
        }
    });
    return page.evaluate(async () => {
        const HOUR = 3_600_000, W = 72, H = 36, N = W * H, h = window._wxGridHistory;
        const now = Math.floor(Date.now() / HOUR) * HOUR;
        const frame = (k) => {
            const c = new Float32Array(N * 9);
            for (let i = 0; i < N; i++) {
                const x = i % W, y = (i / W) | 0;
                c[i] = 10 + 8 * Math.sin(k / 4 + i * 0.01);
                c[N + i] = 1013 + 14 * Math.sin(x / 6 + k * 0.2) * Math.cos(y / 5);
                c[2 * N + i] = 60; c[3 * N + i] = 5 * Math.sin(i * 0.03 + k); c[4 * N + i] = 3;
                c[5 * N + i] = 40; c[6 * N + i] = 30; c[7 * N + i] = 20; c[8 * N + i] = k % 5;
            }
            return c;
        };
        for (let k = -47; k <= 0; k++) h.ingest({ t: now + k * HOUR, source: 's', gridW: W, gridH: H, coarse: frame(k) });
        await new Promise((r) => setTimeout(r, 1500));
        const r = window._wxResolver;
        r.setMinRepaintMs(0);
        let applies = 0;
        const L = window.__evIsobars, ap = L._apply.bind(L);
        L._apply = (x) => { applies++; return ap(x); };
        const times = [];
        for (let m = 0; m <= 24 * 60; m += 20) {
            const t = now - 36 * HOUR + m * 60_000;
            const t0 = performance.now(); r.tick(t); times.push(performance.now() - t0);
            await new Promise((res) => setTimeout(res, 100));
        }
        await new Promise((res) => setTimeout(res, 1000));
        times.sort((a, b) => a - b);
        const q = (p) => times[Math.floor(p * (times.length - 1))];

        // Bit-identity of the worker paths against their inline twins.
        const { computeIsobars } = await import('/js/isobar-contour.js');
        // One explicit buffer through the worker path, compared to the
        // inline computation of the SAME buffer (the scrub's last applied
        // result may belong to an earlier repaint — latest-wins coalesces).
        const probe = r._weatherScratch.slice();
        await L.requestUpdate(probe);
        const last = L.lastResult;
        const inline = computeIsobars(probe);
        const sameArr = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
        let trioSame = null;
        for (const [key, entry] of r._lru._m) {
            const rec = h.all().find((x) => x.t === key);
            if (!rec || entry.src !== rec.coarse) continue;
            const ref = window._wxResolver._feed._decodeCoarse(rec.coarse, rec.gridW, rec.gridH);
            trioSame = sameArr(entry.trio.weatherBuf, ref.weatherBuf) && sameArr(entry.trio.windBuf, ref.windBuf) && sameArr(entry.trio.cloudBuf, ref.cloudBuf);
            break;
        }
        return {
            p50: q(0.5), p90: q(0.9), decode: r.decodeStats, applies,
            isobarsMatch: last ? sameArr(last.positions, inline.positions) && sameArr(last.colors, inline.colors) : null,
            trioSame,
        };
    });
}

let withWorkers = null;

test('scrub repaint fits a frame with the workers; their results equal the inline path', async ({ page }) => {
    const errors = await boot(page, '', { clouds: true });
    withWorkers = await scrub(page);
    console.log('workers', JSON.stringify(withWorkers));
    expect(withWorkers.p90).toBeLessThan(16.7);
    expect(withWorkers.decode.inline).toBeLessThanOrEqual(3);
    expect(withWorkers.decode.prefetched).toBeGreaterThan(10);
    expect(withWorkers.applies).toBeGreaterThan(5);
    expect(withWorkers.isobarsMatch, 'worker isobars == inline computeIsobars on the final buffer').toBe(true);
    expect(withWorkers.trioSame, 'a prefetched trio == the feed\'s inline decode').toBe(true);
    expect(errors, errors.join('\n')).toEqual([]);
});

test('NEGATIVE CONTROL: ?scrubworker=0 pays the old inline cost', async ({ page }) => {
    await boot(page, '?scrubworker=0', { clouds: true });
    const inline = await scrub(page);
    console.log('inline', JSON.stringify(inline));
    expect(inline.decode.prefetched).toBe(0);
    expect(inline.decode.inline).toBeGreaterThan(10);
    expect(withWorkers, 'run serially after the worker test').not.toBeNull();
    expect(inline.p90).toBeGreaterThan(3 * withWorkers.p90);
});
