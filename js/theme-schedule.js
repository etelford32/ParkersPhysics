/**
 * theme-schedule.js — when is it light? (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * The site's LIGHT theme (white + blue) follows the visitor's DAY: in the
 * default 'auto' mode a page is light while the Sun is above the horizon at
 * the visitor's saved location and dark otherwise, and it flips by itself at
 * sunrise and sunset. 'light' and 'dark' pin it.
 *
 * THE RULE, and why it is this one:
 *   - The location is `ppx_user_location` — the ONE place every card on the
 *     site already reads (js/user-location.js). Never add a second store.
 *   - Daylight is the Sun's geometric altitude from
 *     js/sun-altitude.js `solarPosition` (the site's local-sky solar position;
 *     never a sixth sub-solar function) compared against SUN_LIGHT_ALT_DEG =
 *     −0.833°, the standard sunrise/sunset altitude (refraction 34′ + the
 *     semi-diameter 16′). So "light from sunrise to sunset" is literally true.
 *   - WITHOUT a location the rule falls back to the visitor's LOCAL CLOCK,
 *     CLOCK_DAY (07:00–19:00), and says so (reason 'clock'). A longitude
 *     guessed from the timezone offset is wrong by up to ~15° (an hour) and
 *     the latitude is unknowable, so a clock window is the honest fallback,
 *     not an "approximate sunrise" pretending to be one.
 *   - Polar day / polar night: there is no transition in the scan window;
 *     `untilMs` is then a re-check RECHECK_MS out, never null.
 *
 * js/theme-boot.js (a classic script that runs in <head> before first paint)
 * cannot import this module, so it reads the cached answer this module's
 * result is written into (`pp.theme.auto` = { theme, untilMs }) and, on a
 * cold cache, applies the SAME clock window. Its constants are mirrored by
 * hand; `node tests/theme-schedule.mjs` reads the boot script's source and
 * fails if the two drift.
 */

import { solarPosition } from './sun-altitude.js';

export const THEME_MODES = Object.freeze(['auto', 'light', 'dark']);

/** localStorage: the visitor's chosen mode. Missing / unknown ⇒ 'auto'.
 *  (earth.html wrote 'light' | 'dark' here before the site-wide theme
 *  existed — those values keep their meaning.) */
export const STORAGE_KEY = 'pp.theme';
/** localStorage: the last auto answer, for the first-paint boot script. */
export const CACHE_KEY = 'pp.theme.auto';

/** Standard sunrise/sunset altitude (deg). */
export const SUN_LIGHT_ALT_DEG = -0.833;
/** Local-clock fallback when no location is saved. MIRRORED in theme-boot.js. */
export const CLOCK_DAY = Object.freeze({ startH: 7, endH: 19 });

/** Transition scan: coarse step, then bisection to BISECT_MS. */
const SCAN_STEP_MS = 10 * 60_000;
const SCAN_SPAN_MS = 48 * 3_600_000;
const BISECT_MS = 1_000;
/** Polar day/night (no transition in the scan window): look again in 6 h. */
export const RECHECK_MS = 6 * 3_600_000;

export function normalizeMode(v) {
    return v === 'light' || v === 'dark' ? v : 'auto';
}

export function validLocation(loc) {
    return !!loc && Number.isFinite(+loc.lat) && Number.isFinite(+loc.lon)
        && Math.abs(+loc.lat) <= 90 && Math.abs(+loc.lon) <= 360;
}

/**
 * Local clock hour (fractional) at `ms`. `tzOffsetMin` follows
 * Date#getTimezoneOffset's sign (minutes BEHIND UTC: +300 for UTC−5);
 * omitted ⇒ the runtime's own zone at that instant (DST-correct).
 */
export function localHour(ms, tzOffsetMin) {
    const off = Number.isFinite(tzOffsetMin) ? tzOffsetMin : new Date(ms).getTimezoneOffset();
    const local = ms - off * 60_000;
    const dayMs = ((local % 86_400_000) + 86_400_000) % 86_400_000;
    return dayMs / 3_600_000;
}

/**
 * Is it day at `ms`?
 * @returns {{ light: boolean, reason: 'sun'|'clock', altitudeDeg?: number }}
 */
export function isDaylight(ms, location, { tzOffsetMin } = {}) {
    if (validLocation(location)) {
        const { altitudeDeg } = solarPosition(new Date(ms), +location.lat, +location.lon);
        return { light: altitudeDeg > SUN_LIGHT_ALT_DEG, reason: 'sun', altitudeDeg };
    }
    const h = localHour(ms, tzOffsetMin);
    return { light: h >= CLOCK_DAY.startH && h < CLOCK_DAY.endH, reason: 'clock' };
}

/**
 * The next instant after `ms` at which isDaylight flips, to ~1 s, or null
 * when nothing flips within SCAN_SPAN_MS (polar day / night).
 */
export function nextTransitionMs(ms, location, opts = {}) {
    const start = isDaylight(ms, location, opts).light;
    let lo = ms;
    for (let t = ms + SCAN_STEP_MS; t <= ms + SCAN_SPAN_MS; t += SCAN_STEP_MS) {
        if (isDaylight(t, location, opts).light !== start) {
            let hi = t;
            while (hi - lo > BISECT_MS) {
                const mid = lo + (hi - lo) / 2;
                if (isDaylight(mid, location, opts).light === start) lo = mid; else hi = mid;
            }
            return Math.ceil(hi);
        }
        lo = t;
    }
    return null;
}

/**
 * The theme for a mode at an instant.
 * @param {{ mode?: string, nowMs: number, location?: {lat:number, lon:number}|null,
 *           tzOffsetMin?: number }} args
 * @returns {{ mode: 'auto'|'light'|'dark', theme: 'light'|'dark',
 *             reason: 'pinned'|'sun'|'clock', untilMs: number|null,
 *             altitudeDeg?: number }}
 *   untilMs — when to re-evaluate ('auto' only; null when pinned).
 */
export function resolveTheme({ mode, nowMs, location = null, tzOffsetMin } = {}) {
    const m = normalizeMode(mode);
    if (m !== 'auto') return { mode: m, theme: m, reason: 'pinned', untilMs: null };
    const opts = { tzOffsetMin };
    const day = isDaylight(nowMs, location, opts);
    const next = nextTransitionMs(nowMs, location, opts);
    return {
        mode: 'auto',
        theme: day.light ? 'light' : 'dark',
        reason: day.reason,
        untilMs: next ?? nowMs + RECHECK_MS,
        ...(day.altitudeDeg !== undefined ? { altitudeDeg: day.altitudeDeg } : {}),
    };
}

/** Short human description of an auto answer, for the toggle's tooltip. */
export function describeTheme(res, { placeName = '', formatTime } = {}) {
    if (!res) return '';
    if (res.mode !== 'auto') return `Theme: ${res.theme} (pinned). Click to change.`;
    const fmt = formatTime || ((ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }));
    const next = res.untilMs ? fmt(res.untilMs) : '';
    if (res.reason === 'sun') {
        const where = placeName ? ` at ${placeName}` : '';
        return `Theme: auto — light from sunrise to sunset${where}. ` +
            `Switches to ${res.theme === 'light' ? 'dark' : 'light'} around ${next}.`;
    }
    return `Theme: auto — light ${CLOCK_DAY.startH}:00–${CLOCK_DAY.endH}:00 on your clock ` +
        `(save a location for real sunrise/sunset). Switches around ${next}.`;
}
