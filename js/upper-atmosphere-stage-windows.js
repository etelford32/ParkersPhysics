/**
 * upper-atmosphere-stage-windows.js — every panel over the stage is a window
 * ═══════════════════════════════════════════════════════════════════════════
 * DOM half of js/stage-layout.js (the PURE rules). Each registered piece of
 * chrome over the canvas — the camera dock, the render dock (legend +
 * toolbar), the time dock, the explore column, the flight deck — gets a
 * TITLE BAR (grip · name · fold · home) and a RESIZE GRIP, and becomes:
 *
 *   • DRAGGABLE by its bar (pointer capture; a press that wanders < 4 px is
 *     a click; the panel converts from its CSS home — right/bottom insets —
 *     to left/top inside the stage on the first real move, and is clamped
 *     so MIN_VISIBLE_PX of it always stay on the stage);
 *   • COLLAPSIBLE to its bar (`data-collapsed`; everything but the bar is
 *     hidden by CSS, so a folded dock is one 24 px line);
 *   • RESIZABLE from its grip on the axes the panel can use (the time dock
 *     only sideways, the column only up and down);
 *   • HOMABLE: the ⌂ button or a double-click on the bar removes every
 *     inline style and the entry — back to the CSS home, which is also
 *     what a visitor who never touched anything sees.
 *
 * MEMORY. The arrangement is a `stage-layout` document. Everyone keeps it
 * for the SESSION (in memory). Basic+ (`layoutMemoryAllowed` — the one
 * gate, shared with the console's cloud sync) keeps it in localStorage AND
 * in the dashboards table through dashboard-sync's `initDocSync`, so it
 * follows them across devices; a free visitor's layout resets on reload
 * and the layout menu says so, with the upgrade link. Positions are
 * stored RELATIVE TO THE NEAREST STAGE CORNER and re-placed on every stage
 * resize (the kernel's reason: a dock dragged off the top-right must stay
 * top-right on a laptop).
 *
 * NOTHING HERE KNOWS WHAT A PANEL CONTAINS. The bars are injected ahead of
 * the panel's own children; ids, listeners and the page's own measured
 * clearances (`--ua-atmo-floor`, `--ua-cam-hud-bottom`,
 * `--ua-render-dock-h`) keep working because the panels keep their ids and
 * their CSS homes until the user moves them.
 */

import {
    normalizeStageLayout, isHomeLayout, anchorFromRect, placeFromAnchor,
    clampRect, clampSize, withPanel, layoutMemoryAllowed, STAGE_LAYOUT_VERSION,
} from './stage-layout.js';
import { initDocSync } from './dashboard-sync.js';

const CLICK_PX = 4;
const Z_BASE = 20;      // raise-on-grab band, above the instruments overlay (6)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function readAccount() {
    try {
        return JSON.parse(localStorage.getItem('pp_auth') || 'null')
            || JSON.parse(sessionStorage.getItem('pp_auth') || 'null');
    } catch { return null; }
}

export class StageWindows {
    /**
     * @param {object} o
     * @param {HTMLElement} o.stage                the positioned stage (#ua-globe-wrap)
     * @param {Array<{id:string, el:HTMLElement, title:string, axis?:'x'|'y'|'xy'|'none', minW?:number, minH?:number, maxW?:number, maxH?:number}>} o.panels
     * @param {string} [o.page]                    storage key / dashboards page
     * @param {{plan?:string, role?:string}} [o.account]   override (tests)
     * @param {boolean} [o.cloud=true]             attach dashboard-sync
     */
    constructor({ stage, panels, page = 'upper-atmosphere-stage', account = null, cloud = true }) {
        this.stage = stage;
        this.page = page;
        this.panels = new Map();
        this._z = Z_BASE;
        const acct = account || readAccount() || {};
        this.memory = layoutMemoryAllowed(acct.plan, acct.role);
        this.signedIn = !!acct.signedIn || !!account;
        this._storeKey = `pp-stage-layout.${page}`;
        this.doc = this.memory ? normalizeStageLayout(this._readStore(), panels.map(p => p.id)) : { v: STAGE_LAYOUT_VERSION, panels: {} };
        for (const spec of panels) this._register(spec);
        this.applyAll();
        this._ro = new ResizeObserver(() => this.applyAll());
        this._ro.observe(stage);
        this.sync = null;
        if (this.memory && cloud) {
            this.sync = initDocSync({
                page, version: STAGE_LAYOUT_VERSION,
                getDoc: () => this.doc,
                applyDoc: (doc) => {
                    this.doc = normalizeStageLayout(doc, [...this.panels.keys()]);
                    this._writeStore(this.doc);
                    this.applyAll();
                },
                saveEvent: 'ua-stage-layout',
            });
        }
    }

    // ── Registration ─────────────────────────────────────────────────────
    _register(spec) {
        const { id, el, title, axis = 'xy', minW = 160, minH = 40, maxW = Infinity, maxH = Infinity } = spec;
        if (!el || this.panels.has(id)) return;
        el.classList.add('ua-win');
        el.dataset.win = id;
        const bar = document.createElement('div');
        bar.className = 'ua-win-bar';
        bar.tabIndex = 0;
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', `${title} — drag to move, double-click to send home`);
        bar.innerHTML = `<span class="ua-win-grip" aria-hidden="true">⋮⋮</span>`
            + `<span class="ua-win-title">${esc(title)}</span>`
            + `<button type="button" class="ua-win-btn" data-win-act="fold" title="Fold / unfold" aria-expanded="true"><span aria-hidden="true">▾</span><span class="ua-sr">Fold</span></button>`
            + `<button type="button" class="ua-win-btn" data-win-act="home" title="Send home (default place and size)"><span aria-hidden="true">⌂</span><span class="ua-sr">Home</span></button>`;
        el.insertBefore(bar, el.firstChild);
        let grip = null;
        if (axis !== 'none') {
            grip = document.createElement('div');
            grip.className = `ua-win-resize ua-win-resize--${axis}`;
            grip.title = 'Resize';
            grip.setAttribute('aria-hidden', 'true');
            el.appendChild(grip);
        }
        const p = { id, el, bar, grip, title, axis, minW, minH, maxW, maxH };
        this.panels.set(id, p);
        this._wireDrag(p);
        if (grip) this._wireResize(p);
        bar.addEventListener('click', (e) => {
            const b = e.target.closest('[data-win-act]');
            if (!b) return;
            e.stopPropagation();
            if (b.dataset.winAct === 'fold') this.toggle(id);
            else if (b.dataset.winAct === 'home') this.home(id);
        });
        bar.addEventListener('dblclick', (e) => { if (!e.target.closest('[data-win-act]')) this.home(id); });
        bar.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggle(id); }
            const step = e.shiftKey ? 32 : 8;
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
            if (d) { e.preventDefault(); this._nudge(p, d[0], d[1]); }
        });
        el.addEventListener('pointerdown', () => this._raise(p), { capture: true });
    }

    // ── Geometry ─────────────────────────────────────────────────────────
    _stageSize() { return { w: this.stage.clientWidth, h: this.stage.clientHeight }; }
    _rectOf(el) {
        const s = this.stage.getBoundingClientRect(), r = el.getBoundingClientRect();
        return { left: r.left - s.left, top: r.top - s.top, w: r.width, h: r.height };
    }
    /** Convert from the CSS home (right/bottom insets) to left/top in place. */
    _float(p) {
        if (p.el.dataset.floating === '1') return;
        const r = this._rectOf(p.el);
        const st = p.el.style;
        st.left = `${Math.round(r.left)}px`;
        st.top = `${Math.round(r.top)}px`;
        st.right = 'auto';
        st.bottom = 'auto';
        st.width = `${Math.round(r.w)}px`;
        if (p.axis === 'y' || p.axis === 'xy') st.height = `${Math.round(r.h)}px`;
        st.margin = '0';
        p.el.dataset.floating = '1';
    }
    _raise(p) {
        this._z = Math.min(39, this._z + 1);
        p.el.style.zIndex = String(this._z);
    }
    _setPos(p, left, top) {
        const r = clampRect({ left, top, w: p.el.offsetWidth, h: p.el.offsetHeight }, this._stageSize());
        p.el.style.left = `${Math.round(r.left)}px`;
        p.el.style.top = `${Math.round(r.top)}px`;
    }

    // ── Drag ─────────────────────────────────────────────────────────────
    _wireDrag(p) {
        let sx = 0, sy = 0, ox = 0, oy = 0, moving = false, pid = null;
        const onMove = (e) => {
            if (e.pointerId !== pid) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moving) {
                if (Math.abs(dx) < CLICK_PX && Math.abs(dy) < CLICK_PX) return;
                moving = true;
                this._float(p);
                ox = parseFloat(p.el.style.left) || 0;
                oy = parseFloat(p.el.style.top) || 0;
                p.el.classList.add('is-dragging');
            }
            this._setPos(p, ox + dx, oy + dy);
        };
        const onUp = (e) => {
            if (e.pointerId !== pid) return;
            p.bar.releasePointerCapture?.(pid);
            p.bar.removeEventListener('pointermove', onMove);
            p.bar.removeEventListener('pointerup', onUp);
            p.bar.removeEventListener('pointercancel', onUp);
            pid = null;
            if (!moving) return;
            moving = false;
            p.el.classList.remove('is-dragging');
            this._commitPlace(p);
        };
        p.bar.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || e.target.closest('[data-win-act]')) return;
            e.preventDefault();
            e.stopPropagation();        // the canvas / OrbitControls under the bar must not see it
            pid = e.pointerId; sx = e.clientX; sy = e.clientY;
            p.bar.setPointerCapture?.(pid);
            p.bar.addEventListener('pointermove', onMove);
            p.bar.addEventListener('pointerup', onUp);
            p.bar.addEventListener('pointercancel', onUp);
        });
    }
    _nudge(p, dx, dy) {
        this._float(p);
        this._setPos(p, (parseFloat(p.el.style.left) || 0) + dx, (parseFloat(p.el.style.top) || 0) + dy);
        this._commitPlace(p);
    }
    _commitPlace(p) {
        const r = this._rectOf(p.el);
        const e = anchorFromRect(r, this._stageSize());
        this._save(withPanel(this.doc, p.id, { anchor: e.anchor, dx: Math.round(e.dx), dy: Math.round(e.dy) }));
    }

    // ── Resize ───────────────────────────────────────────────────────────
    _wireResize(p) {
        let sx = 0, sy = 0, w0 = 0, h0 = 0, pid = null;
        const onMove = (e) => {
            if (e.pointerId !== pid) return;
            const sz = clampSize({
                w: p.axis === 'y' ? undefined : w0 + (e.clientX - sx),
                h: p.axis === 'x' ? undefined : h0 + (e.clientY - sy),
            }, { minW: p.minW, minH: p.minH, maxW: Math.min(p.maxW, this._stageSize().w - 16), maxH: Math.min(p.maxH, this._stageSize().h - 16) });
            if (sz.w !== undefined) p.el.style.width = `${Math.round(sz.w)}px`;
            if (sz.h !== undefined) p.el.style.height = `${Math.round(sz.h)}px`;
        };
        const onUp = (e) => {
            if (e.pointerId !== pid) return;
            p.grip.releasePointerCapture?.(pid);
            p.grip.removeEventListener('pointermove', onMove);
            p.grip.removeEventListener('pointerup', onUp);
            p.grip.removeEventListener('pointercancel', onUp);
            pid = null;
            p.el.classList.remove('is-resizing');
            const patch = {};
            if (p.axis !== 'y') patch.w = Math.round(p.el.offsetWidth);
            if (p.axis !== 'x') patch.h = Math.round(p.el.offsetHeight);
            this._save(withPanel(this.doc, p.id, patch));
        };
        p.grip.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            // A resize fixes the panel where it stands (its CSS home may be
            // an inset pair that would otherwise fight the new size).
            this._float(p);
            pid = e.pointerId; sx = e.clientX; sy = e.clientY;
            w0 = p.el.offsetWidth; h0 = p.el.offsetHeight;
            p.el.classList.add('is-resizing');
            p.grip.setPointerCapture?.(pid);
            p.grip.addEventListener('pointermove', onMove);
            p.grip.addEventListener('pointerup', onUp);
            p.grip.addEventListener('pointercancel', onUp);
        });
    }

    // ── Fold / home ──────────────────────────────────────────────────────
    isCollapsed(id) { return this.panels.get(id)?.el.dataset.collapsed === '1'; }
    setCollapsed(id, on) {
        const p = this.panels.get(id);
        if (!p) return;
        p.el.dataset.collapsed = on ? '1' : '0';
        p.bar.querySelector('[data-win-act="fold"]')?.setAttribute('aria-expanded', on ? 'false' : 'true');
        this._save(withPanel(this.doc, id, { open: on ? false : true }));
    }
    toggle(id) { this.setCollapsed(id, !this.isCollapsed(id)); }
    home(id) {
        const p = this.panels.get(id);
        if (!p) return;
        for (const k of ['left', 'top', 'right', 'bottom', 'width', 'height', 'margin', 'zIndex']) p.el.style[k] = '';
        delete p.el.dataset.floating;
        p.el.dataset.collapsed = '0';
        p.bar.querySelector('[data-win-act="fold"]')?.setAttribute('aria-expanded', 'true');
        this._save(withPanel(this.doc, id, null));
    }
    homeAll() { for (const id of this.panels.keys()) this.home(id); }
    collapseAll(on) { for (const id of this.panels.keys()) this.setCollapsed(id, on); }

    // ── Apply a document to the DOM ──────────────────────────────────────
    applyAll() {
        const stage = this._stageSize();
        if (!stage.w || !stage.h) return;
        for (const p of this.panels.values()) {
            const e = this.doc.panels[p.id];
            if (!e) {
                if (p.el.dataset.floating === '1' || p.el.dataset.collapsed === '1') {
                    for (const k of ['left', 'top', 'right', 'bottom', 'width', 'height', 'margin']) p.el.style[k] = '';
                    delete p.el.dataset.floating;
                    p.el.dataset.collapsed = '0';
                }
                continue;
            }
            p.el.dataset.collapsed = e.open === false ? '1' : '0';
            p.bar.querySelector('[data-win-act="fold"]')?.setAttribute('aria-expanded', e.open === false ? 'false' : 'true');
            if (e.w !== undefined || e.h !== undefined || e.anchor) this._float(p);
            const sz = clampSize({ w: e.w, h: e.h }, { minW: p.minW, minH: p.minH, maxW: Math.min(p.maxW, stage.w - 16), maxH: Math.min(p.maxH, stage.h - 16) });
            if (sz.w !== undefined && p.axis !== 'y') p.el.style.width = `${Math.round(sz.w)}px`;
            if (sz.h !== undefined && p.axis !== 'x') p.el.style.height = `${Math.round(sz.h)}px`;
            if (e.anchor) {
                const r = placeFromAnchor(e, stage, { w: p.el.offsetWidth, h: p.el.offsetHeight });
                p.el.style.left = `${Math.round(r.left)}px`;
                p.el.style.top = `${Math.round(r.top)}px`;
            }
        }
    }

    // ── Memory ───────────────────────────────────────────────────────────
    _readStore() { try { return JSON.parse(localStorage.getItem(this._storeKey) || 'null'); } catch { return null; } }
    _writeStore(doc) {
        try {
            if (isHomeLayout(doc)) localStorage.removeItem(this._storeKey);
            else localStorage.setItem(this._storeKey, JSON.stringify(doc));
        } catch { /* private mode */ }
    }
    _save(doc) {
        this.doc = doc;
        if (this.memory) {
            this._writeStore(doc);
            try { window.dispatchEvent(new CustomEvent('ua-stage-layout', { detail: { page: this.page, doc } })); } catch { /* no window */ }
        }
        try { window.dispatchEvent(new CustomEvent('ua-stage-layout-changed', { detail: { page: this.page, doc, remembered: this.memory } })); } catch { /* no window */ }
    }
    getLayout() { return this.doc; }
    /** 'remembered' (Basic+), 'session' (signed in, free), 'guest' (signed out). */
    memoryState() { return this.memory ? 'remembered' : this.signedIn ? 'session' : 'guest'; }

    destroy() {
        this._ro?.disconnect();
        for (const p of this.panels.values()) { p.bar.remove(); p.grip?.remove(); p.el.classList.remove('ua-win'); }
        this.panels.clear();
    }
}
