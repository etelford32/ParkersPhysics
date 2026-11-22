/**
 * home-launchpad.js — the homepage's first screen (index.html #hero)
 * ═══════════════════════════════════════════════════════════════════════════
 * Renders what js/home-launchpad-model.js derives: the RECENT carousel (one
 * slide per simulation, from the build log), each permanent tile's "latest
 * change" line, and the newest build-log entries. It computes nothing of its
 * own — read the model's header for the rules.
 *
 * The page works before this module arrives and without it: the six permanent
 * tiles, the section doors and every link are STATIC markup in index.html.
 * This module fills the three [data-lp-*] hosts and enhances the tiles.
 *
 * THE CAROUSEL IS A SCROLLER, not a stack of absolutely positioned slides:
 * a flex row with scroll-snap. Touch swipe, trackpad, shift-wheel and
 * keyboard scrolling are the browser's; the arrows, dots and auto-advance
 * only ever call scrollTo. The active slide is READ BACK from scrollLeft, so
 * a swipe and a button can never disagree about where the carousel is.
 *   • Auto-advance (AUTO_MS) runs only while the carousel is on screen, the
 *     tab is visible, nothing in it is hovered or focused, and motion is
 *     allowed — and stops for good the first time the visitor steers it.
 *   • Off-screen slides are `inert`, so Tab walks one slide, not eight.
 *   • No WebGL and no video here: posters are the launchpad thumbnails
 *     (scripts/build-launchpad-thumbs.py). A simulation with no capture gets
 *     a glyph plate in its section's colour — never a blank, never a stand-in
 *     photograph of something else.
 *
 * Every link carries data-funnel-cta (launchpad_recent_<sim>, _changed_<sim>,
 * _log_<entry>), counted by index.html's delegated listener.
 *
 * Contract
 *   mountHomeLaunchpad(root, { nowMs, autoMs, motion }) → controller
 *     { slides, index, go(i), next(), prev(), destroy() }
 * Debug: ?debug=1 exposes it as window.__ppLaunchpad (tests/home-launchpad.spec.js).
 */
import { recentSlides, fixtures, logStrip, SIM_COUNT } from './home-launchpad-model.js';
import { KINDS, formatDate } from './dev-log.js';
import { LAUNCHPAD_MEDIA, LAUNCHPAD_MEDIA_DIR } from './home-launchpad-media.js';
import { glyph } from './glyphs.js';

export const AUTO_MS = 7000;

/** One accent per site section (the showcase's palette family). */
const SECTION_ACCENT = {
    'space-weather': '#ff8c5a', 'earth-orbit': '#2eff9e', 'local-space': '#8ff0ff',
    'deep-space': '#b765ff', 'research': '#ffd23f',
};
const KIND_SHORT = Object.fromEntries(KINDS.map((k) => [k.id, k.short]));

function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'style') n.style.cssText = v;
        else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
}

function plate(icon) {
    const p = el('div', { class: 'lp-plate', 'aria-hidden': 'true' });
    p.insertAdjacentHTML('afterbegin', glyph(icon || 'space-weather', { size: 96 }));
    return p;
}

function poster(sim, width, { eager = false } = {}) {
    const box = el('div', { class: 'lp-media' });
    if (!LAUNCHPAD_MEDIA[sim.id]) { box.append(plate(sim.icon)); return box; }
    const img = el('img', {
        src: `${LAUNCHPAD_MEDIA_DIR}${sim.id}-${width}.jpg`, alt: '', width: String(width), height: String(Math.round(width * 9 / 16)),
        decoding: 'async', loading: eager ? 'eager' : 'lazy', ...(eager ? { fetchpriority: 'high' } : {}),
    });
    img.addEventListener('error', () => { img.remove(); box.append(plate(sim.icon)); }, { once: true });
    box.append(img);
    return box;
}

function slideNode({ sim, entry, href, fresh }, i, n) {
    const acc = SECTION_ACCENT[sim.category] || '#9a85ff';
    const node = el('article', {
        class: 'lp-slide', role: 'group', 'aria-roledescription': 'slide', 'aria-label': `${i + 1} of ${n}: ${sim.title}`,
        'data-sim': sim.id, 'data-entry': entry.id, style: `--lp-acc:${acc}`,
    });
    const chips = el('div', { class: 'lp-chips' },
        el('span', { class: 'lp-chip lp-chip-kind', 'data-kind': entry.kind, text: KIND_SHORT[entry.kind] || entry.kind }),
        el('time', { class: 'lp-chip', datetime: entry.date, text: formatDate(entry.date) }),
        fresh ? el('span', { class: 'lp-chip lp-chip-new', text: 'New' }) : null);
    const body = el('div', { class: 'lp-slide-body' },
        chips,
        el('h3', { class: 'lp-slide-sim', text: sim.title }),
        el('p', { class: 'lp-slide-title', text: entry.title }),
        el('p', { class: 'lp-slide-sum', text: entry.summary }),
        el('div', { class: 'lp-slide-cta' },
            el('a', { class: 'lp-open', href, 'data-funnel-cta': 'launchpad_recent_' + sim.id, text: `Open ${sim.title} →` }),
            el('a', { class: 'lp-changed', href: 'recent-development.html#' + entry.id,
                      'data-funnel-cta': 'launchpad_changed_' + sim.id, text: 'What changed' })));
    node.append(poster(sim, 960, { eager: i === 0 }), body);
    return node;
}

function motionAllowed(win = window) {
    try { return !win.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

export function mountHomeLaunchpad(root, opts = {}) {
    if (!root) return null;
    const nowMs = opts.nowMs ?? Date.now();
    const autoMs = opts.autoMs ?? AUTO_MS;
    const motion = opts.motion ?? motionAllowed();

    // ── Count ───────────────────────────────────────────────────────────────
    for (const n of root.querySelectorAll('[data-lp-count]')) n.textContent = String(SIM_COUNT);

    // ── Permanent tiles: each one's newest logged change ────────────────────
    for (const f of fixtures()) {
        const tile = root.querySelector(`[data-lp-fixture="${f.sim.id}"]`);
        const slot = tile?.querySelector('[data-lp-latest]');
        if (!slot || !f.latest) continue;
        slot.textContent = `Updated ${formatDate(f.latest.date, { year: false })} · ${f.latest.title}`;
        slot.hidden = false;
    }

    // ── The log strip ───────────────────────────────────────────────────────
    const logHost = root.querySelector('[data-lp-log]');
    if (logHost) {
        logHost.replaceChildren(...logStrip().map((e) => el('li', {},
            el('a', { href: 'recent-development.html#' + e.id, 'data-funnel-cta': 'launchpad_log_' + e.id },
                el('time', { datetime: e.date, text: formatDate(e.date, { year: false }) }),
                el('span', { class: 'lp-log-kind', 'data-kind': e.kind, text: KIND_SHORT[e.kind] || e.kind }),
                el('span', { class: 'lp-log-title', text: e.title })))));
    }

    // ── The carousel ────────────────────────────────────────────────────────
    const host = root.querySelector('[data-lp-recent]');
    const slides = recentSlides({ nowMs });
    const ctl = { slides, index: 0, go() {}, next() {}, prev() {}, destroy() {} };
    if (!host || !slides.length) return ctl;

    const track = el('div', { class: 'lp-track', tabindex: '0', 'aria-label': 'Recently built or improved simulations' });
    const nodes = slides.map((s, i) => slideNode(s, i, slides.length));
    track.append(...nodes);
    const prevBtn = el('button', { type: 'button', class: 'lp-arrow lp-prev', 'aria-label': 'Previous simulation', text: '‹' });
    const nextBtn = el('button', { type: 'button', class: 'lp-arrow lp-next', 'aria-label': 'Next simulation', text: '›' });
    const dots = el('div', { class: 'lp-dots', role: 'group', 'aria-label': 'Choose a simulation' });
    const dotBtns = slides.map((s, i) => {
        const b = el('button', { type: 'button', class: 'lp-dot', 'aria-label': `${i + 1}: ${s.sim.title}` });
        b.addEventListener('click', () => { steer(); go(i); });
        return b;
    });
    dots.append(...dotBtns);
    host.replaceChildren(track, prevBtn, nextBtn, dots);
    host.removeAttribute('aria-busy');

    let index = -1;
    const mark = (i) => {
        if (i === index) return;
        index = ctl.index = i;
        nodes.forEach((n, k) => { n.toggleAttribute('inert', k !== i); n.classList.toggle('lp-active', k === i); });
        dotBtns.forEach((b, k) => b.setAttribute('aria-current', k === i ? 'true' : 'false'));
    };
    const go = (i, { smooth = motion } = {}) => {
        const n = slides.length;
        const k = ((i % n) + n) % n;
        track.scrollTo({ left: nodes[k].offsetLeft - track.offsetLeft, behavior: smooth ? 'smooth' : 'instant' });
        mark(k);
    };
    // The scroll position is the truth: a swipe lands here too.
    let raf = 0;
    const onScroll = () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
            raf = 0;
            const w = track.clientWidth;
            if (w > 0) mark(Math.max(0, Math.min(slides.length - 1, Math.round(track.scrollLeft / w))));
        });
    };
    track.addEventListener('scroll', onScroll, { passive: true });

    // Auto-advance: only when nobody is steering, and never again once they have.
    let steered = false, hovered = false, focused = false, onScreen = false, timer = 0;
    const tick = () => { if (!steered && !hovered && !focused && onScreen && !document.hidden) go(index + 1); };
    const steer = () => { steered = true; clearInterval(timer); timer = 0; };
    if (motion && autoMs > 0 && slides.length > 1) timer = setInterval(tick, autoMs);
    host.addEventListener('pointerenter', () => { hovered = true; });
    host.addEventListener('pointerleave', () => { hovered = false; });
    host.addEventListener('focusin', () => { focused = true; });
    host.addEventListener('focusout', () => { focused = false; });
    track.addEventListener('pointerdown', steer, { passive: true });
    track.addEventListener('wheel', steer, { passive: true });
    track.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); steer(); go(index + 1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); steer(); go(index - 1); }
    });
    prevBtn.addEventListener('click', () => { steer(); go(index - 1); });
    nextBtn.addEventListener('click', () => { steer(); go(index + 1); });
    let io = null;
    if ('IntersectionObserver' in window) {
        io = new IntersectionObserver((es) => { onScreen = es.some((e) => e.isIntersecting); }, { threshold: 0.5 });
        io.observe(host);
    } else onScreen = true;

    mark(0);
    Object.assign(ctl, {
        go: (i) => { steer(); go(i, { smooth: false }); },
        next: () => { steer(); go(index + 1, { smooth: false }); },
        prev: () => { steer(); go(index - 1, { smooth: false }); },
        _tick: tick,
        get autoplaying() { return !!timer && !steered; },
        destroy() { clearInterval(timer); io?.disconnect(); track.removeEventListener('scroll', onScroll); },
    });
    try { if (new URLSearchParams(location.search).has('debug')) window.__ppLaunchpad = ctl; } catch {}
    return ctl;
}
