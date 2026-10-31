/**
 * weather-scrub-worker.js — the two CPU jobs a time scrub used to do on the
 * main thread (EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md T3, measured 2026-10-31):
 *
 *   'decode'   coarse CHW frame → the full-res render trio
 *              (js/weather-decode.js decodeCoarse — the ONE decoder; ~40 ms)
 *   'isobars'  360×180×4 weather buffer → isobar segments + H/L centres
 *              (js/isobar-contour.js computeIsobars; ~58 ms)
 *
 * Both imports are dependency-free relative modules, so this module worker
 * (which does not inherit the page's importmap) loads them directly.
 * Results are TRANSFERRED back (no copy). The page talks to it only through
 * js/weather-scrub-bridge.js, which falls back inline if this ever fails.
 */
import { decodeCoarse } from './weather-decode.js';
import { computeIsobars } from './isobar-contour.js';

self.onmessage = (e) => {
    const m = e.data || {};
    try {
        if (m.type === 'decode') {
            const trio = decodeCoarse(m.coarse, m.gridW, m.gridH);
            self.postMessage({ type: 'decode', id: m.id, trio },
                [trio.weatherBuf.buffer, trio.windBuf.buffer, trio.cloudBuf.buffer]);
        } else if (m.type === 'isobars') {
            const result = computeIsobars(m.buf);
            self.postMessage({ type: 'isobars', id: m.id, result },
                [result.positions.buffer, result.colors.buffer]);
        }
    } catch (err) {
        self.postMessage({ type: m.type, id: m.id, error: err?.message || String(err) });
    }
};
self.postMessage({ type: 'ready' });
