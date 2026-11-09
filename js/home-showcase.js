/**
 * home-showcase.js — the homepage Simulation Showcase (index.html #showcase)
 * ═══════════════════════════════════════════════════════════════════════════
 * A grid of DOORS into the simulations: one card per entry in
 * js/home-showcase-slides.js SHOWCASE_SLIDES, each a crisp poster that plays
 * its captured loop on hover, with the physics the page actually computes,
 * the data it runs on, the named model behind it, and the tier it needs.
 * Filter chips are the site's own sections (js/site-sections.js) — a visitor
 * who finds something under "Local Space" here finds it under "Local Space"
 * in the nav.
 *
 * WHAT IT REPLACED (2026-11-09, owner decision)
 * ─────────────────────────────────────────────
 * The 2026-09 experiment `home_bg_carousel` cycled the same captures as a
 * full-bleed BACKGROUND behind the hero copy: posters captured on a software
 * rasteriser, stretched by object-fit:cover to 1440px, fighting the live
 * Earth for the same pixels. The owner judged it "very janky", and it was:
 * a background can only ever be glanced at. The captures are now the
 * SUBJECT — framed, labelled, and each one a link — and the hero keeps the
 * one thing that is actually live (the magnetosphere canvas). The
 * captures-not-embeds decision stands (the module header of the slides file
 * says why): nothing here opens a WebGL context.
 *
 * Contract
 *   mountHomeShowcase(host, { manifestUrl, slides, motion }) → controller
 *     host        the element to render into (index.html #showcase-host)
 *     manifestUrl the capture manifest (default from the slides module)
 *     controller  { cards, filter(sectionId|'all'), active, destroy() }
 *
 * Rules, each deliberate
 *   • One decoding <video> at most: a clip's src is attached on
 *     pointerenter / focus and detached on leave. Never on touch-only
 *     devices (no hover), under prefers-reduced-motion, or save-data.
 *   • A slide with no capture still renders — a dark plate with its glyph
 *     and the words "capture pending" — never a blank or a broken image.
 *   • The poster carries its capture date and renderer in a chip. A capture
 *     is an archive, not an observation; the site discloses archival vs live
 *     everywhere else and so does this.
 *   • Each card is an <a data-funnel-cta="showcase_<id>">, so index.html's
 *     delegated listener counts it as a landing CTA. Filter clicks are
 *     tracked by the host through `onFilter` so the admin funnel can see
 *     which sections people reach for.
 *
 * Debug: `?debug=1` exposes the controller as window.__ppShowcase (the
 * browser gate tests/home-showcase.spec.js drives it through that).
 */
import { SHOWCASE_SLIDES, MANIFEST_URL } from './home-showcase-slides.js';
import { SITE_SECTIONS } from './site-sections.js';
import { glyph } from './glyphs.js';

const TIER_LABEL = { public: 'Open', free: 'Free account', advanced: 'Advanced' };

const CSS = `
.hs{--hs-ink:var(--fg-1,#f5f0ff);--hs-ink2:var(--fg-2,#cdc4f0);--hs-ink3:var(--fg-3,#9d92c8);--hs-ink4:var(--fg-4,#6f6695);
  --hs-card:linear-gradient(180deg,rgba(13,6,38,.62),rgba(7,2,26,.9));--hs-line:rgba(154,133,255,.16);--hs-line2:rgba(154,133,255,.42);
  --hs-chip:rgba(13,6,38,.7);--hs-plate:#070b1c}
.hs-filters{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 22px}
.hs-filter{appearance:none;cursor:pointer;border-radius:999px;padding:7px 14px;font-family:var(--font-display,inherit);font-size:.62rem;
  letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:var(--hs-ink3);background:transparent;border:1px solid var(--hs-line);
  transition:color .2s,border-color .2s,background .2s}
.hs-filter:hover{color:var(--hs-ink);border-color:var(--hs-line2)}
.hs-filter[aria-pressed="true"]{color:#fff;background:var(--grad-uv,linear-gradient(135deg,#3b1eff,#9d3aff));border-color:transparent}
.hs-filter:focus-visible{outline:2px solid #8ff0ff;outline-offset:2px}
.hs-filter small{opacity:.7;margin-left:6px;letter-spacing:0;font-family:var(--font-mono,monospace)}
.hs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px}
.hs-card{position:relative;display:flex;flex-direction:column;border-radius:16px;overflow:hidden;text-decoration:none;color:var(--hs-ink2);
  background:var(--hs-card);border:1px solid var(--hs-line);transition:transform .25s cubic-bezier(.2,.7,.2,1),border-color .25s,box-shadow .25s}
.hs-card:hover,.hs-card:focus-visible{transform:translateY(-4px);border-color:var(--hs-acc,var(--hs-line2));box-shadow:0 18px 44px rgba(2,0,10,.45),0 0 0 1px var(--hs-acc,transparent)}
.hs-card:focus-visible{outline:2px solid #8ff0ff;outline-offset:3px}
.hs-card[hidden]{display:none}
.hs-media{position:relative;aspect-ratio:16/10;background:var(--hs-plate);overflow:hidden}
.hs-media img,.hs-media video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.hs-media img{transform:scale(1.02);transition:transform 6s cubic-bezier(.2,.7,.2,1)}
.hs-card:hover .hs-media img{transform:scale(1.08)}
.hs-media video{opacity:0;transition:opacity .5s ease}
.hs-media video.hs-playing{opacity:1}
.hs-media::after{content:'';position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(180deg,rgba(2,0,10,.0) 55%,rgba(2,0,10,.55) 100%)}
.hs-pending{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--hs-acc,#9d3aff)}
.hs-pending svg{width:64px;height:64px;opacity:.85;filter:drop-shadow(0 0 14px currentColor)}
.hs-pending span{font-family:var(--font-mono,monospace);font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;color:var(--hs-ink4)}
.hs-tier{position:absolute;top:10px;left:10px;z-index:1;font-family:var(--font-display,inherit);font-size:.54rem;font-weight:700;letter-spacing:.14em;
  text-transform:uppercase;padding:4px 9px;border-radius:999px;background:var(--hs-chip);border:1px solid var(--hs-line2);color:#fff;backdrop-filter:blur(6px)}
.hs-tier[data-tier="advanced"]{border-color:rgba(255,31,156,.5);color:#ff8ccf}
.hs-tier[data-tier="free"]{border-color:rgba(46,255,158,.45);color:#7dffc4}
.hs-shot{position:absolute;right:10px;bottom:10px;z-index:1;font-family:var(--font-mono,monospace);font-size:.56rem;letter-spacing:.08em;
  color:rgba(245,240,255,.72);background:rgba(2,0,10,.55);padding:3px 8px;border-radius:4px;backdrop-filter:blur(4px)}
.hs-play{position:absolute;left:10px;bottom:10px;z-index:1;display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono,monospace);
  font-size:.56rem;letter-spacing:.12em;text-transform:uppercase;color:rgba(245,240,255,.8);background:rgba(2,0,10,.55);padding:3px 8px;border-radius:4px;
  backdrop-filter:blur(4px);opacity:0;transition:opacity .25s}
.hs-card:hover .hs-play{opacity:1}
.hs-play::before{content:'';width:0;height:0;border-left:6px solid currentColor;border-top:4px solid transparent;border-bottom:4px solid transparent}
.hs-body{display:flex;flex-direction:column;gap:7px;padding:14px 16px 16px;flex:1}
.hs-kicker{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;font-family:var(--font-mono,monospace);font-size:.58rem;letter-spacing:.14em;
  text-transform:uppercase;color:var(--hs-acc,#9d3aff)}
.hs-kicker i{font-style:normal;color:var(--hs-ink4)}
.hs-title{font-family:var(--font-display,inherit);font-weight:700;font-size:.98rem;letter-spacing:.02em;color:var(--hs-ink);line-height:1.25}
.hs-does{font-size:.86rem;color:var(--hs-ink2);line-height:1.5;font-weight:600}
.hs-claim{font-size:.8rem;color:var(--hs-ink3);line-height:1.5}
.hs-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:auto;padding-top:8px}
.hs-chip{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-mono,monospace);font-size:.6rem;letter-spacing:.04em;color:var(--hs-ink3);
  padding:3px 8px;border-radius:5px;border:1px solid var(--hs-line);background:rgba(255,255,255,.02)}
.hs-chip b{font-weight:600;color:var(--hs-ink2)}
.hs-go{display:inline-flex;align-items:center;gap:7px;margin-top:4px;font-family:var(--font-display,inherit);font-size:.68rem;font-weight:700;
  letter-spacing:.12em;text-transform:uppercase;color:var(--hs-acc,#9d3aff);transition:gap .15s}
.hs-card:hover .hs-go{gap:12px}
.hs-empty{padding:28px;text-align:center;color:var(--hs-ink3);font-size:.9rem}
@media (max-width:640px){.hs-grid{grid-template-columns:1fr;gap:14px}.hs-body{padding:12px 14px 14px}}
@media (prefers-reduced-motion:reduce){.hs-card,.hs-media img,.hs-media video,.hs-go{transition:none}.hs-card:hover .hs-media img{transform:none}}
/* LIGHT THEME (html.theme-light — js/theme-light.css holds the --pl-* palette). */
html.theme-light .hs{--hs-ink:var(--pl-text-1);--hs-ink2:var(--pl-text-2);--hs-ink3:var(--pl-text-3);--hs-ink4:var(--pl-text-4);
  --hs-card:var(--pl-card);--hs-line:var(--pl-border);--hs-line2:var(--pl-border-strong);--hs-chip:rgba(255,255,255,.14)}
html.theme-light .hs-card{box-shadow:var(--pl-shadow)}
html.theme-light .hs-card:hover,html.theme-light .hs-card:focus-visible{box-shadow:var(--pl-shadow-hover),0 0 0 1px var(--hs-acc,var(--pl-blue))}
html.theme-light .hs-filter[aria-pressed="true"]{background:var(--pl-grad-btn)}
html.theme-light .hs-chip{background:var(--pl-bg-soft)}
html.theme-light .hs-kicker,html.theme-light .hs-go{filter:brightness(.66) saturate(1.35)}
html.theme-light .hs-pending span{color:rgba(245,240,255,.6)}
`;

function injectStyles() {
    if (document.getElementById('hs-styles')) return;
    const s = document.createElement('style');
    s.id = 'hs-styles';
    s.textContent = CSS;
    document.head.appendChild(s);
}

function fmtDate(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function loadManifest(url) {
    try {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) return null;
        const json = await res.json();
        return json && Array.isArray(json.slides) ? json : null;
    } catch {
        return null;
    }
}

/** Hover loops are a desktop, motion-allowed, not-metered affordance. */
export function clipsAllowed(win = window, nav = navigator) {
    try {
        if (win.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
        if (!win.matchMedia('(hover: hover) and (pointer: fine)').matches) return false;
        if (nav.connection && nav.connection.saveData) return false;
    } catch { return false; }
    return true;
}

function el(tag, attrs = {}, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k.startsWith('data-') || k.startsWith('aria-')) n.setAttribute(k, v);
        else if (k === 'style') n.style.cssText = v;
        else n[k] = v;
    }
    for (const c of children) if (c != null) n.append(c);
    return n;
}

/**
 * @param {HTMLElement} host
 * @param {{ manifestUrl?: string, slides?: any[], motion?: boolean, onFilter?: (id: string) => void }} opts
 */
export async function mountHomeShowcase(host, opts = {}) {
    if (!host) return null;
    injectStyles();
    const slides = opts.slides || SHOWCASE_SLIDES;
    const manifest = await loadManifest(opts.manifestUrl || MANIFEST_URL);
    const media = new Map((manifest?.slides || []).map((e) => [e.id, e]));
    const motion = opts.motion ?? clipsAllowed();
    const sectionLabel = new Map(SITE_SECTIONS.map((s) => [s.id, s.label]));

    const root = el('div', { class: 'hs' });
    const filters = el('div', { class: 'hs-filters', role: 'group', 'aria-label': 'Filter simulations by section' });
    const grid = el('div', { class: 'hs-grid', role: 'list' });
    root.append(filters, grid);

    // Filters: All, then each section in nav order that has at least one slide.
    const counts = new Map();
    for (const s of slides) counts.set(s.section, (counts.get(s.section) || 0) + 1);
    const filterDefs = [{ id: 'all', label: 'All', n: slides.length }]
        .concat(SITE_SECTIONS.filter((s) => counts.has(s.id)).map((s) => ({ id: s.id, label: s.label, n: counts.get(s.id) })));
    let active = 'all';
    const filterBtns = filterDefs.map((f) => {
        const b = el('button', { type: 'button', class: 'hs-filter', 'aria-pressed': String(f.id === active), 'data-filter': f.id });
        b.append(document.createTextNode(f.label), el('small', { text: String(f.n) }));
        b.addEventListener('click', () => { filter(f.id); opts.onFilter?.(f.id); });
        return b;
    });
    filters.append(...filterBtns);

    // Cards
    let playing = null;
    const stopClip = (v) => {
        if (!v) return;
        v.classList.remove('hs-playing');
        try { v.pause(); } catch {}
        // Drop the decoder: a cleared src releases it, a paused one does not.
        setTimeout(() => { if (!v.classList.contains('hs-playing')) { v.removeAttribute('src'); try { v.load(); } catch {} } }, 600);
        if (playing === v) playing = null;
    };
    const startClip = (v, src) => {
        if (!motion || !src) return;
        if (playing && playing !== v) stopClip(playing);
        if (!v.getAttribute('src')) v.setAttribute('src', src);
        playing = v;
        v.play().then(() => v.classList.add('hs-playing')).catch(() => {});
    };

    const cards = slides.map((s) => {
        const m = media.get(s.id);
        const card = el('a', {
            class: 'hs-card', href: s.href, role: 'listitem',
            'data-funnel-cta': 'showcase_' + s.id, 'data-id': s.id, 'data-section': s.section,
            style: `--hs-acc:${s.accent}`,
            'aria-label': `${s.title} — ${s.does}`,
        });
        const mediaBox = el('div', { class: 'hs-media' });
        const pendingPlate = () => {
            const pend = el('div', { class: 'hs-pending' });
            pend.insertAdjacentHTML('afterbegin', glyph(s.icon || 'space-weather'));
            pend.append(el('span', { text: 'capture pending' }));
            return pend;
        };
        if (m?.poster) {
            const img = el('img', { src: m.poster, alt: '', loading: 'lazy', decoding: 'async', width: m.width || 1600, height: m.height || 1000 });
            // A poster that fails to load becomes the pending plate — never a
            // broken-image glyph on a card (the manifest can outlive its files).
            img.addEventListener('error', () => {
                for (const n of mediaBox.querySelectorAll('img, video, .hs-shot, .hs-play')) n.remove();
                mediaBox.prepend(pendingPlate());
            }, { once: true });
            mediaBox.append(img);
            if (m.clip && motion) {
                const v = el('video', { muted: true, loop: true, playsInline: true, preload: 'none', 'aria-hidden': 'true' });
                v.dataset.src = m.clip;
                mediaBox.append(v);
                card.addEventListener('pointerenter', () => startClip(v, m.clip));
                card.addEventListener('focus', () => startClip(v, m.clip));
                card.addEventListener('pointerleave', () => stopClip(v));
                card.addEventListener('blur', () => stopClip(v));
                mediaBox.append(el('span', { class: 'hs-play', text: 'loop' }));
            }
            const when = fmtDate(m.capturedAt);
            const how = m.renderer === 'gpu' ? '' : ' · software render';
            if (when) mediaBox.append(el('span', { class: 'hs-shot', text: `captured ${when}${how}` }));
        } else {
            mediaBox.append(pendingPlate());
        }
        mediaBox.append(el('span', { class: 'hs-tier', 'data-tier': s.tier, text: TIER_LABEL[s.tier] || s.tier }));

        const body = el('div', { class: 'hs-body' });
        const kicker = el('span', { class: 'hs-kicker' });
        kicker.append(document.createTextNode(sectionLabel.get(s.section) || s.section));
        if (s.model) kicker.append(el('i', { text: s.model }));
        body.append(
            kicker,
            el('h3', { class: 'hs-title', text: s.title }),
            el('p', { class: 'hs-does', text: s.does }),
            el('p', { class: 'hs-claim', text: s.claim }),
        );
        const chips = el('div', { class: 'hs-chips' });
        if (s.data) chips.append(el('span', { class: 'hs-chip' }, el('b', { text: 'data' }), document.createTextNode(s.data)));
        if (s.scale) chips.append(el('span', { class: 'hs-chip' }, el('b', { text: 'scale' }), document.createTextNode(s.scale)));
        body.append(chips, el('span', { class: 'hs-go' }, document.createTextNode(s.verb || 'Open'), el('span', { 'aria-hidden': 'true', text: '→' })));
        card.append(mediaBox, body);
        return card;
    });
    grid.append(...cards);
    const empty = el('p', { class: 'hs-empty', text: 'Nothing in this section yet.', hidden: true });
    grid.after(empty);

    function filter(id) {
        active = id;
        let shown = 0;
        for (const c of cards) {
            const on = id === 'all' || c.dataset.section === id;
            c.hidden = !on;
            if (on) shown++;
        }
        for (const b of filterBtns) b.setAttribute('aria-pressed', String(b.dataset.filter === id));
        empty.hidden = shown > 0;
        if (playing) stopClip(playing);
    }

    host.replaceChildren(root);

    // Nothing decodes while the section is off screen or the tab is hidden.
    const onVis = () => { if (document.hidden && playing) stopClip(playing); };
    document.addEventListener('visibilitychange', onVis);

    const controller = {
        get cards() { return cards; },
        get active() { return active; },
        filter,
        slides: slides.map((s) => s.id),
        captured: slides.filter((s) => media.get(s.id)?.poster).map((s) => s.id),
        destroy() {
            document.removeEventListener('visibilitychange', onVis);
            if (playing) stopClip(playing);
            host.replaceChildren();
        },
    };
    try {
        if (new URLSearchParams(location.search).get('debug') === '1') window.__ppShowcase = controller;
    } catch {}
    return controller;
}
