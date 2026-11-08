/**
 * theme.js — the site theme at runtime (light / dark / auto-by-daylight).
 * ═══════════════════════════════════════════════════════════════════════════
 * Imported by js/nav.js, so it runs on every page. On a page that declares
 * <html data-theme-support="light"> it:
 *   - resolves the theme through js/theme-schedule.js (PURE — Sun altitude at
 *     `ppx_user_location`, else the local-clock window) and puts / removes
 *     `theme-light` on <html> (the class earth.html's design tokens and
 *     js/theme-light.css key on);
 *   - writes the answer to `pp.theme.auto` so js/theme-boot.js paints the
 *     NEXT page load correctly before any module runs;
 *   - re-evaluates by itself at the next sunrise/sunset (one timer), when the
 *     tab becomes visible again (timers sleep in background tabs), when the
 *     saved location changes, and when another tab changes the preference;
 *   - announces every change as a `pp-theme-change` event
 *     ({ theme, mode, reason, untilMs }) for canvases that want to follow.
 * On every other page it still exposes the API (so a preference set there
 * persists) but never touches the page — the simulations stay dark.
 *
 * window.ppTheme = { get(), set('auto'|'light'|'dark'), cycle(), supported }
 */

import {
    STORAGE_KEY, CACHE_KEY, RECHECK_MS,
    normalizeMode, resolveTheme, describeTheme,
} from './theme-schedule.js';

const MAX_TIMER_MS = 2 ** 31 - 1;          // setTimeout's own ceiling (~24.8 d)
const SWITCH_ANIM_MS = 700;

let _state = null;
let _timer = 0;
let _started = false;

const root = () => document.documentElement;
export const themeSupported = () => root()?.getAttribute('data-theme-support') === 'light';

function readMode() {
    try { return normalizeMode(localStorage.getItem(STORAGE_KEY)); } catch { return 'auto'; }
}

function readLocation() {
    try {
        const s = localStorage.getItem('ppx_user_location');
        return s ? JSON.parse(s) : null;
    } catch { return null; }
}

function urlOverride() {
    try {
        const q = new URLSearchParams(location.search).get('theme');
        return q === 'light' || q === 'dark' ? q : null;
    } catch { return null; }
}

/** Current resolved state (copy). */
export function getTheme() { return _state ? { ..._state } : null; }

/** Human tooltip for the current state. */
export function describeCurrent() {
    const loc = readLocation();
    return describeTheme(_state, { placeName: loc?.city || '' });
}

function applyClass(theme, { animate }) {
    const el = root();
    if (!el || !themeSupported()) return;
    const was = el.classList.contains('theme-light') ? 'light' : 'dark';
    if (was === theme) { el.setAttribute('data-theme', theme); syncThemeColor(theme); return; }
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (animate && !reduce) {
        el.classList.add('theme-switching');
        setTimeout(() => el.classList.remove('theme-switching'), SWITCH_ANIM_MS);
    }
    el.classList.toggle('theme-light', theme === 'light');
    el.setAttribute('data-theme', theme);
    syncThemeColor(theme);
}

function syncThemeColor(theme) {
    const m = document.querySelector('meta[name="theme-color"]');
    if (!m) return;
    if (!m.hasAttribute('data-dark')) m.setAttribute('data-dark', m.getAttribute('content') || '');
    m.setAttribute('content', theme === 'light' ? '#ffffff' : m.getAttribute('data-dark'));
}

/** Re-resolve and apply. `animate` softens a runtime flip (never first paint). */
export function refreshTheme({ animate = true } = {}) {
    const now = Date.now();
    const forced = urlOverride();
    const res = forced
        ? { mode: forced, theme: forced, reason: 'pinned', untilMs: null }
        : resolveTheme({ mode: readMode(), nowMs: now, location: readLocation() });
    const changed = !_state || _state.theme !== res.theme || _state.mode !== res.mode
        || _state.reason !== res.reason;
    _state = res;

    if (res.mode === 'auto' && !forced) {
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify({ theme: res.theme, untilMs: res.untilMs }));
        } catch { /* storage blocked: boot falls back to the clock */ }
    }
    applyClass(res.theme, { animate });

    clearTimeout(_timer);
    if (res.mode === 'auto' && !forced) {
        // +1.5 s so the re-evaluation lands on the far side of the bisected edge.
        const wait = Math.min(Math.max((res.untilMs ?? now + RECHECK_MS) - now + 1500, 1000), MAX_TIMER_MS);
        _timer = setTimeout(() => refreshTheme({ animate: true }), wait);
    }
    if (changed) {
        window.dispatchEvent(new CustomEvent('pp-theme-change', { detail: getTheme() }));
    }
    return getTheme();
}

/** Pin or release the theme. 'auto' removes the stored preference. */
export function setThemeMode(mode) {
    const m = normalizeMode(mode);
    // An explicit choice outranks a ?theme= preview param: drop it from the
    // URL, or the click would appear to do nothing.
    if (urlOverride()) {
        try {
            const u = new URL(location.href);
            u.searchParams.delete('theme');
            history.replaceState(history.state, '', u);
        } catch { /* ignore */ }
    }
    try {
        if (m === 'auto') localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, m);
    } catch { /* session-only */ }
    return refreshTheme({ animate: true });
}

/** auto → light → dark → auto. */
export function cycleThemeMode() {
    const order = ['auto', 'light', 'dark'];
    const cur = _state?.mode ?? readMode();
    return setThemeMode(order[(order.indexOf(cur) + 1) % order.length]);
}

export function startTheme() {
    if (_started) return getTheme();
    _started = true;
    refreshTheme({ animate: false });
    window.addEventListener('user-location-changed', () => refreshTheme());
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refreshTheme();
    });
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY || e.key === 'ppx_user_location') refreshTheme();
    });
    window.ppTheme = {
        get: getTheme,
        set: setThemeMode,
        cycle: cycleThemeMode,
        describe: describeCurrent,
        get supported() { return themeSupported(); },
    };
    return getTheme();
}

startTheme();
