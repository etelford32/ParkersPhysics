/**
 * theme-switch.js — the light / dark switch under the logo.
 * ═══════════════════════════════════════════════════════════════════════════
 * A port of elliottelford.com's switch (Infinity WordPress theme, style.css
 * §21.0 "tiny toggle under the logo", header.php, assets/js/theme-toggle.js):
 * a 46×20 pill hanging just under the logo — moon on the left, sun on the
 * right, a 14px gradient knob that slides 26px over 0.35s. Knob LEFT = dark,
 * RIGHT = light. Same geometry, same easing, same palette roles (dark-cosmic
 * track + indigo edge + cyan→purple knob; science-light's slate track + blue
 * edge), same touch target trick (a ::before that reaches further DOWN than
 * up so it never steals taps from the logo above it).
 *
 * The one thing this site has that the reference does not is AUTO: by
 * default the theme follows the Sun (light from sunrise to sunset at the
 * saved location — js/theme-schedule.js; the reference uses the clock).
 * A click flips and PINS light / dark (theme.js setThemeMode). Holding the
 * switch (≥600 ms) or double-clicking it hands the theme back to the Sun;
 * the tooltip and aria-label say which mode is in force. Visually identical
 * to the reference in every mode.
 *
 * ONE MODULE OWNS IT — markup, styles, behaviour — because three light pages
 * (privacy, api-policy, reset-password) do not load js/nav.js. It is imported
 * by nav.js AND loaded by the theme block every light page carries
 * (scripts/build-theme-support.mjs THEME_HEAD); both resolve to the same URL,
 * so it runs once. Where it goes:
 *   - inside the page's top <nav> (`body > nav`), absolutely positioned just
 *     under the logo: the nav is sticky, so it is the containing block and
 *     the switch rides with it; out of flow, so the bar's width ladder never
 *     sees it. nav.js REWRITES the nav on `auth-changed`, which detaches it —
 *     a MutationObserver puts the SAME element back;
 *   - below EarthView's live status strip when one is glued under the nav;
 *   - no positioned nav at all: fixed at the top-left.
 * Pages that cannot go light (the simulations — space is black) get nothing.
 */

import { themeSupported, getTheme, setThemeMode, describeCurrent } from './theme.js';

const SWITCH_ID = 'pp-theme-switch';
const STYLE_ID = 'pp-theme-switch-styles';
const HOLD_MS = 600;

// The reference's own icon paths (Infinity theme inc/icons.php), 24-grid strokes.
const ICON = {
    moon: '<path d="M20.4 13.4A8.4 8.4 0 1 1 10.6 3.6a6.8 6.8 0 0 0 9.8 9.8z"/><circle cx="17.6" cy="5.8" r="0.8" fill="currentColor" stroke="none"/>',
    sun: '<circle cx="12" cy="12" r="4.4"/><path d="M12 2.6v2.8M12 18.6v2.8M2.6 12h2.8M18.6 12h2.8M5.2 5.2l2 2M16.8 16.8l2 2M18.8 5.2l-2 2M7.2 16.8l-2 2"/>',
};
const svg = (id) => `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" `
    + `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[id]}</svg>`;

const CSS = `
.pp-theme-switch {
    position: absolute; top: calc(100% + 6px); left: 16px; z-index: 590;
    display: inline-flex; align-items: center; justify-content: space-between;
    box-sizing: border-box; width: 46px; height: 20px; padding: 0 5px; margin: 0;
    border-radius: 999px;
    border: 1px solid color-mix(in srgb, #6366f1 45%, transparent);
    background: color-mix(in srgb, #1e2330 85%, transparent);
    color: #e0e7ff; cursor: pointer; touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
    transition: border-color .15s ease, background .15s ease;
}
.pp-theme-switch.pp-theme-switch--fixed { position: fixed; top: 12px; }
nav:has(+ #lsb-bar) > .pp-theme-switch { top: calc(100% + 32px + 6px); }
.pp-theme-switch:hover { border-color: #6366f1; }
.pp-theme-switch:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
.pp-theme-switch-icon { display: inline-flex; line-height: 0; opacity: .85; }
.pp-theme-switch-icon svg { display: block; }
.pp-theme-switch-knob {
    position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%;
    background: linear-gradient(135deg, #06b6d4, #8b5cf6);
    box-shadow: 0 0 8px color-mix(in srgb, #6366f1 60%, transparent);
    transition: transform .35s cubic-bezier(.22, .61, .36, 1);
}
.pp-theme-switch[aria-checked="true"] .pp-theme-switch-knob { transform: translateX(26px); }
/* The bar's compact tier pulls its padding in to 10px (js/nav-styles.css). */
@media (min-width: 1281px) and (max-width: 1519px) { .pp-theme-switch { left: 10px; } }
@media (pointer: coarse) {
    .pp-theme-switch::before { content: ''; position: absolute; inset: -6px -6px -18px; }
}
@media (prefers-reduced-motion: reduce) { .pp-theme-switch-knob { transition: none; } }

/* Light — the reference's science-light roles (slate track, blue edge),
   which is this site's white + blue. Literal colours: EarthView does not
   load js/theme-light.css. */
html.theme-light .pp-theme-switch {
    border-color: color-mix(in srgb, #3b82f6 45%, transparent);
    background: color-mix(in srgb, #e2e8f0 85%, transparent);
    color: #1d3557;
}
html.theme-light .pp-theme-switch:hover { border-color: #3b82f6; }
html.theme-light .pp-theme-switch:focus-visible { outline-color: #3b82f6; }
html.theme-light .pp-theme-switch-knob {
    background: linear-gradient(135deg, #8b5cf6, #06b6d4);
    box-shadow: 0 0 8px color-mix(in srgb, #3b82f6 60%, transparent);
}
`;

let sw = null;

function sync() {
    if (!sw) return;
    const st = getTheme() || { mode: 'auto', theme: 'dark' };
    const light = st.theme === 'light';
    sw.setAttribute('aria-checked', String(light));
    sw.dataset.mode = st.mode;
    const how = st.mode === 'auto'
        ? (describeCurrent() || 'Theme follows the Sun.')
        : `Theme: ${st.theme} (set by you). Hold or double-click to follow the Sun again.`;
    sw.title = `Switch to ${light ? 'dark' : 'light'} mode. ${how}`;
    sw.setAttribute('aria-label', `Light mode${st.mode === 'auto' ? ' (automatic, follows the Sun)' : ''}`);
}

function place() {
    if (!sw) return;
    const nav = document.querySelector('body > nav');
    if (nav && getComputedStyle(nav).position !== 'static') {
        sw.classList.remove('pp-theme-switch--fixed');
        if (sw.parentNode !== nav) nav.appendChild(sw);
    } else {
        sw.classList.add('pp-theme-switch--fixed');
        if (sw.parentNode !== document.body) document.body.appendChild(sw);
    }
}

function mount() {
    if (sw || !themeSupported()) return;
    if (!document.getElementById(STYLE_ID)) {
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        document.head.appendChild(s);
    }
    sw = document.createElement('button');
    sw.type = 'button';
    sw.id = SWITCH_ID;
    sw.className = 'pp-theme-switch';
    sw.setAttribute('role', 'switch');
    sw.innerHTML = `<span class="pp-theme-switch-icon">${svg('moon')}</span>`
        + `<span class="pp-theme-switch-icon">${svg('sun')}</span>`
        + `<span class="pp-theme-switch-knob"></span>`;

    // Click flips + pins. A HOLD (or a double-click) returns to auto; the
    // click that ends a hold is swallowed so it does not flip straight back.
    let holdTimer = 0, held = false;
    const clearHold = () => { clearTimeout(holdTimer); holdTimer = 0; };
    sw.addEventListener('pointerdown', () => {
        held = false; clearHold();
        holdTimer = setTimeout(() => { held = true; setThemeMode('auto'); sync(); }, HOLD_MS);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => sw.addEventListener(t, clearHold));
    sw.addEventListener('click', (e) => {
        e.stopPropagation();          // never let nav.js read it as an outside click
        if (held) { held = false; return; }
        const st = getTheme() || { theme: 'dark' };
        setThemeMode(st.theme === 'light' ? 'dark' : 'light');
        sync();
    });
    sw.addEventListener('dblclick', (e) => { e.preventDefault(); setThemeMode('auto'); sync(); });
    sw.addEventListener('contextmenu', (e) => { if (held) e.preventDefault(); });

    sync();
    place();
    window.addEventListener('pp-theme-change', sync);
    new MutationObserver(() => {
        if (!sw.isConnected || sw.parentNode !== document.querySelector('body > nav')) place();
    }).observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
else mount();

export { mount as mountThemeSwitch };
