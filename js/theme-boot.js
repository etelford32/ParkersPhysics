/* theme-boot.js — first-paint theme, loaded as a CLASSIC script in <head>.
 * ═══════════════════════════════════════════════════════════════════════
 * Runs synchronously before the body paints so a daytime visitor never
 * sees the dark page flash white. It only READS: the decision itself is
 * js/theme-schedule.js (PURE, Sun altitude at the saved location), applied
 * and kept current by js/theme.js once modules load. This script cannot
 * import that module, so it uses, in order:
 *   1. ?theme=light|dark       — one-load preview (earth.html's old param)
 *   2. localStorage pp.theme   — a pinned 'light' / 'dark'
 *   3. localStorage pp.theme.auto = { theme, untilMs } — the module's last
 *      auto answer, valid until its next sunrise/sunset
 *   4. the local-clock window 07:00–19:00 (theme-schedule.js CLOCK_DAY —
 *      mirrored here BY HAND; tests/theme-schedule.mjs reads this source
 *      and fails if the two drift)
 *
 * Only pages that declare <html data-theme-support="light"> go light. Every
 * other page (the immersive simulations — space is black) is left exactly as
 * it was: this script adds nothing to them.
 */
(function () {
    var d = document.documentElement;
    if (!d || d.getAttribute('data-theme-support') !== 'light') return;
    var CLOCK_START_H = 7, CLOCK_END_H = 19;
    var theme = null;
    try {
        var q = new URLSearchParams(location.search).get('theme');
        if (q === 'light' || q === 'dark') theme = q;
    } catch (e) { /* old browser: fall through */ }
    var ls = null;
    try { ls = window.localStorage; } catch (e) { /* storage blocked */ }
    if (!theme && ls) {
        var mode = null;
        try { mode = ls.getItem('pp.theme'); } catch (e) {}
        if (mode === 'light' || mode === 'dark') theme = mode;
    }
    if (!theme && ls) {
        try {
            var c = JSON.parse(ls.getItem('pp.theme.auto') || 'null');
            if (c && (c.theme === 'light' || c.theme === 'dark') && Date.now() < c.untilMs) theme = c.theme;
        } catch (e) {}
    }
    if (!theme) {
        var h = new Date().getHours();
        theme = (h >= CLOCK_START_H && h < CLOCK_END_H) ? 'light' : 'dark';
    }
    if (theme === 'light') d.classList.add('theme-light');
    d.setAttribute('data-theme', theme);
    // Mobile browser chrome: the page's own dark theme-color is kept in
    // data-dark so js/theme.js can restore it at sunset.
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) {
        if (!m.hasAttribute('data-dark')) m.setAttribute('data-dark', m.getAttribute('content') || '');
        if (theme === 'light') m.setAttribute('content', '#ffffff');
    }
})();
