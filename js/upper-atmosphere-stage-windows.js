/**
 * upper-atmosphere-stage-windows.js — every panel over the stage is a window
 * ═══════════════════════════════════════════════════════════════════════════
 * DOM half of js/stage-layout.js (the PURE rules). Each registered piece of
 * chrome over the canvas — the camera dock, the render dock (legend +
 * toolbar), the time dock, the explore column, the flight deck — gets a
 * TITLE BAR (grip · name · fold · home) and a RESIZE GRIP, and becomes:
 *
 *   • DRAGGABLE by its WHOLE bar, buttons included (a narrow bar's right
 *     half IS its buttons — the time dock's is 104 px with fold/home from
 *     64 — so a press on ▾ or ⌂ that travels past CLICK_PX becomes a drag
 *     and the click is swallowed; a press that does not is the click). The
 *     pointer is captured only once the drag is real, so an untouched press
 *     stays an ordinary button press. The panel converts from its CSS home
 *     — right/bottom insets — to left/top inside the stage on the first real
 *     move, is clamped so MIN_VISIBLE_PX of it always stay on the stage,
 *     and its edges SNAP to the stage gutter within SNAP_PX (Alt holds the
 *     snap off); Escape mid-drag puts it back where it was;
 *   • COLLAPSIBLE to its bar (`data-collapsed`; everything but the bar is
 *     hidden by CSS, so a folded dock is one 22 px line);
 *   • RESIZABLE from its grip on the axes the panel can use (the time dock
 *     only sideways, the column only up and down). THE GRIP FACES THE OPEN
 *     STAGE (`data-grip`, kernel `gripSide`): a dock parked top-right has
 *     nowhere to grow on its right, so its grip sits bottom-left and
 *     dragging it left widens the dock with its right edge pinned — a
 *     bottom-right grip there only pushed the dock off the stage. A size is
 *     clamped to the edge it grows toward (kernel `resizeFrom`), the bar
 *     prints the live `w × h` while the grip is held, and a double-click on
 *     the grip restores the home SIZE where the panel stands;
 *   • HOMABLE: the ⌂ button or a double-click on the bar removes every
 *     inline style and the entry — back to the CSS home, which is also
 *     what a visitor who never touched anything sees. A double-click that
 *     is really the tail of a drag (two quick drags) is ignored.
 *
 * A FLOATING PANEL STILL GROWS FROM ITS CORNER. Floating converts the CSS
 * home to left/top, so a bottom-anchored dock whose content then grows
 * (the render dock's toolbar re-wraps when the dock is narrowed) would
 * grow DOWNWARD over whatever sits under it — measured: the time dock's
 * bar was buried and could not be grabbed. Every panel therefore carries
 * a ResizeObserver that re-places it from its stored corner whenever its
 * size changes (bottom-anchored ⇒ bottom pinned, grows up; right-anchored
 * ⇒ right pinned), skipped while the pointer is driving it; and a
 * WIDTH-ONLY resize keeps the anchor the panel started with (the user did
 * not touch the vertical, so the bottom must not move).
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
    clampRect, clampSize, snapRect, gripSide, resizeFrom, withPanel,
    layoutMemoryAllowed, STAGE_LAYOUT_VERSION,
} from './stage-layout.js';
import { initDocSync } from './dashboard-sync.js';

const CLICK_PX = 4;
const Z_BASE = 20;      // raise-on-grab band, above the instruments overlay (6)
const DRAG_TAIL_MS = 400;   // a click/dblclick this soon after a drag is the drag's own tail
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
        bar.setAttribute('aria-label', `${title} — drag anywhere on this bar to move, double-click to send home`);
        bar.innerHTML = `<span class="ua-win-grip" aria-hidden="true">⋮⋮</span>`
            + `<span class="ua-win-title">${esc(title)}</span>`
            + `<span class="ua-win-size" aria-live="polite"></span>`
            + `<button type="button" class="ua-win-btn" data-win-act="fold" title="Fold / unfold (drag here moves the panel too)" aria-expanded="true"><span aria-hidden="true">▾</span><span class="ua-sr">Fold</span></button>`
            + `<button type="button" class="ua-win-btn" data-win-act="home" title="Send home — default place and size (drag here moves the panel too)"><span aria-hidden="true">⌂</span><span class="ua-sr">Home</span></button>`;
        el.insertBefore(bar, el.firstChild);
        let grip = null;
        if (axis !== 'none') {
            grip = document.createElement('div');
            grip.className = `ua-win-resize ua-win-resize--${axis}`;
            grip.title = 'Resize · double-click for the default size';
            grip.setAttribute('aria-hidden', 'true');
            el.appendChild(grip);
        }
        const p = { id, el, bar, grip, title, axis, minW, minH, maxW, maxH, sizeEl: bar.querySelector('.ua-win-size'), lastDragEnd: -Infinity };
        this.panels.set(id, p);
        this._wireDrag(p);
        if (grip) this._wireResize(p);
        bar.addEventListener('click', (e) => {
            const b = e.target.closest('[data-win-act]');
            if (!b) return;
            e.stopPropagation();
            if (this._dragTail(p)) return;          // the press that became a drag
            if (b.dataset.winAct === 'fold') this.toggle(id);
            else if (b.dataset.winAct === 'home') this.home(id);
        });
        bar.addEventListener('dblclick', (e) => {
            if (e.target.closest('[data-win-act]') || this._dragTail(p)) return;
            this.home(id);
        });
        bar.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.toggle(id); }
            else if (e.key === 'Home') { e.preventDefault(); this.home(id); }
            const step = e.shiftKey ? 32 : 8;
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
            if (d) { e.preventDefault(); this._nudge(p, d[0], d[1]); }
        });
        el.addEventListener('pointerdown', () => this._raise(p), { capture: true });
        this._updateGrip(p);
        // Content growth re-places the panel from its corner (see the header).
        p.ro = new ResizeObserver(() => this._replaceFromAnchor(p));
        p.ro.observe(el);
    }
    /** Re-place a floating panel from its stored corner after its size changed (not while the pointer drives it). */
    _replaceFromAnchor(p) {
        const e = this.doc.panels[p.id];
        if (!e?.anchor || p.el.dataset.floating !== '1') return;
        if (p.el.classList.contains('is-dragging') || p.el.classList.contains('is-resizing')) return;
        const stage = this._stageSize();
        if (!stage.w || !stage.h) return;
        const r = placeFromAnchor(e, stage, { w: p.el.offsetWidth, h: p.el.offsetHeight });
        const left = `${Math.round(r.left)}px`, top = `${Math.round(r.top)}px`;
        if (p.el.style.left !== left) p.el.style.left = left;
        if (p.el.style.top !== top) p.el.style.top = top;
        this._updateGrip(p);
    }
    _dragTail(p) { return (performance.now() - p.lastDragEnd) < DRAG_TAIL_MS; }

    // ── Geometry ─────────────────────────────────────────────────────────
    _stageSize() { return { w: this.stage.clientWidth, h: this.stage.clientHeight }; }
    /**
     * A panel's rect in the frame `left`/`top` position in: the stage's
     * PADDING box. The stage carries a 1 px border, and measuring from its
     * border box put every float and re-place 1 px off — a grip double-click
     * (two zero-travel resize cycles plus the home-size pass) drifted 6 px
     * off the gutter that way, measured.
     */
    _rectOf(el) {
        const s = this.stage.getBoundingClientRect(), r = el.getBoundingClientRect();
        return { left: r.left - s.left - this.stage.clientLeft, top: r.top - s.top - this.stage.clientTop, w: r.width, h: r.height };
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
    /** Place at left/top: snapped to the stage gutter (unless `snap` is false), then clamped. */
    _setPos(p, left, top, { snap = true } = {}) {
        const stage = this._stageSize();
        let r = { left, top, w: p.el.offsetWidth, h: p.el.offsetHeight };
        if (snap) r = snapRect(r, stage);
        r = clampRect(r, stage);
        p.el.style.left = `${Math.round(r.left)}px`;
        p.el.style.top = `${Math.round(r.top)}px`;
    }
    /** The resize grip faces the open stage (kernel `gripSide`); axis-y panels keep their CSS side. */
    _updateGrip(p) {
        if (!p.grip || p.axis === 'y') return;
        p.el.dataset.grip = gripSide(this._rectOf(p.el), this._stageSize());
    }

    // ── Drag ─────────────────────────────────────────────────────────────
    _wireDrag(p) {
        let sx = 0, sy = 0, ox = 0, oy = 0, moving = false, pid = null, wasFloating = false, home = null;
        // Until the drag is real the pointer is NOT captured, so the move
        // and up are watched on the document: a flick that leaves the 22 px
        // bar inside one frame still starts the drag (and still ends it).
        const stop = () => {
            p.bar.releasePointerCapture?.(pid);
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            document.removeEventListener('keydown', onKey, true);
            pid = null;
        };
        const onMove = (e) => {
            if (e.pointerId !== pid) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moving) {
                if (Math.abs(dx) < CLICK_PX && Math.abs(dy) < CLICK_PX) return;
                moving = true;
                // Capture only now: an untouched press on ▾ / ⌂ stays that
                // button's own click; a press that travelled is ours.
                p.bar.setPointerCapture?.(pid);
                wasFloating = p.el.dataset.floating === '1';
                home = { left: p.el.style.left, top: p.el.style.top };
                this._float(p);
                ox = parseFloat(p.el.style.left) || 0;
                oy = parseFloat(p.el.style.top) || 0;
                p.el.classList.add('is-dragging');
                document.addEventListener('keydown', onKey, true);
            }
            this._setPos(p, ox + dx, oy + dy, { snap: !e.altKey });
        };
        const onKey = (e) => {
            if (e.key !== 'Escape' || !moving) return;
            // Put it back exactly where it was, home included.
            e.preventDefault(); e.stopPropagation();
            if (wasFloating) { p.el.style.left = home.left; p.el.style.top = home.top; }
            else { for (const k of ['left', 'top', 'right', 'bottom', 'width', 'height', 'margin']) p.el.style[k] = ''; delete p.el.dataset.floating; }
            moving = false;
            p.el.classList.remove('is-dragging');
            p.lastDragEnd = performance.now();
            stop();
        };
        const onUp = (e) => {
            if (e.pointerId !== pid) return;
            stop();
            if (!moving) return;
            moving = false;
            p.el.classList.remove('is-dragging');
            p.lastDragEnd = performance.now();
            this._commitPlace(p);
        };
        p.bar.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            // Buttons keep their default (focus, click); anywhere else the
            // press is ours outright.
            if (!e.target.closest('[data-win-act]')) e.preventDefault();
            e.stopPropagation();        // the canvas / OrbitControls under the bar must not see it
            pid = e.pointerId; sx = e.clientX; sy = e.clientY;
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }
    _nudge(p, dx, dy) {
        this._float(p);
        this._setPos(p, (parseFloat(p.el.style.left) || 0) + dx, (parseFloat(p.el.style.top) || 0) + dy, { snap: false });
        this._commitPlace(p);
    }
    _commitPlace(p) {
        const r = this._rectOf(p.el);
        const e = anchorFromRect(r, this._stageSize());
        this._updateGrip(p);
        this._save(withPanel(this.doc, p.id, { anchor: e.anchor, dx: Math.round(e.dx), dy: Math.round(e.dy) }));
    }

    // ── Resize ───────────────────────────────────────────────────────────
    _wireResize(p) {
        let sx = 0, sy = 0, start = null, pid = null, side = 'r', startAnchor = null;
        const paintSize = () => {
            if (!p.sizeEl) return;
            const w = Math.round(p.el.offsetWidth), h = Math.round(p.el.offsetHeight);
            p.sizeEl.textContent = p.axis === 'x' ? `${w} px` : p.axis === 'y' ? `${h} px` : `${w} × ${h}`;
        };
        const onMove = (e) => {
            if (e.pointerId !== pid) return;
            const r = resizeFrom(start, { dx: e.clientX - sx, dy: e.clientY - sy }, this._stageSize(),
                { axis: p.axis, side, minW: p.minW, minH: p.minH, maxW: p.maxW, maxH: p.maxH });
            if (r.w !== undefined) p.el.style.width = `${Math.round(r.w)}px`;
            if (r.h !== undefined) p.el.style.height = `${Math.round(r.h)}px`;
            if (r.left !== start.left) p.el.style.left = `${Math.round(r.left)}px`;
            paintSize();
        };
        const onUp = (e) => {
            if (e.pointerId !== pid) return;
            p.grip.releasePointerCapture?.(pid);
            p.grip.removeEventListener('pointermove', onMove);
            p.grip.removeEventListener('pointerup', onUp);
            p.grip.removeEventListener('pointercancel', onUp);
            pid = null;
            p.el.classList.remove('is-resizing');
            if (p.sizeEl) p.sizeEl.textContent = '';
            const patch = {};
            if (p.axis !== 'y') patch.w = Math.round(p.el.offsetWidth);
            if (p.axis !== 'x') patch.h = Math.round(p.el.offsetHeight);
            // A left-grip resize moved the left edge: the place is re-anchored
            // too. A WIDTH-ONLY resize keeps the corner it started from (the
            // user did not touch the vertical: a bottom dock whose content
            // re-wrapped taller must keep its bottom, not its top), and is
            // re-placed from it so the growth goes the right way.
            const a = anchorFromRect(this._rectOf(p.el), this._stageSize(), p.axis === 'x' ? startAnchor?.anchor : null);
            if (p.axis === 'x' && startAnchor) a.dy = startAnchor.dy;
            Object.assign(patch, { anchor: a.anchor, dx: Math.round(a.dx), dy: Math.round(a.dy) });
            this._save(withPanel(this.doc, p.id, patch));
            this._replaceFromAnchor(p);
        };
        p.grip.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault(); e.stopPropagation();
            // A resize fixes the panel where it stands (its CSS home may be
            // an inset pair that would otherwise fight the new size).
            this._float(p);
            this._updateGrip(p);
            side = p.el.dataset.grip === 'l' ? 'l' : 'r';
            pid = e.pointerId; sx = e.clientX; sy = e.clientY;
            const r = this._rectOf(p.el);
            start = { left: parseFloat(p.el.style.left) || r.left, top: r.top, w: p.el.offsetWidth, h: p.el.offsetHeight };
            startAnchor = this.doc.panels[p.id]?.anchor ? { ...this.doc.panels[p.id] } : anchorFromRect(r, this._stageSize());
            p.el.classList.add('is-resizing');
            paintSize();
            p.grip.setPointerCapture?.(pid);
            p.grip.addEventListener('pointermove', onMove);
            p.grip.addEventListener('pointerup', onUp);
            p.grip.addEventListener('pointercancel', onUp);
        });
        // Double-click the grip: the home SIZE, where the panel stands.
        p.grip.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); this.homeSize(p.id); });
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
        this._updateGrip(p);
    }
    /**
     * The home SIZE, keeping the place. A floating panel is out from under
     * its id-level caps (`max-width:none` is what lets a user size win), so
     * clearing its inline width would give the CONTENT width, not the home
     * width (measured: the camera dock came back 91 px wider than home).
     * The home size is therefore measured with the caps re-applied for one
     * layout and then pinned as the panel's size — which is also what makes
     * it survive a reload, where a floating panel with no stored size would
     * come up at content width again.
     */
    homeSize(id) {
        const p = this.panels.get(id);
        if (!p) return;
        const was = this._rectOf(p.el);                     // the user's rect, BEFORE the size is cleared
        p.el.style.width = '';
        p.el.style.height = '';
        if (p.el.dataset.floating !== '1') { this._save(withPanel(this.doc, id, { w: undefined, h: undefined })); return; }
        delete p.el.dataset.floating;                       // the CSS home caps apply for this measurement
        const nat = { w: p.el.offsetWidth, h: p.el.offsetHeight };
        p.el.dataset.floating = '1';
        const patch = {};
        p.el.style.width = `${Math.round(nat.w)}px`;
        if (p.axis !== 'y') patch.w = Math.round(nat.w);
        if (p.axis === 'y' || p.axis === 'xy') { p.el.style.height = `${Math.round(nat.h)}px`; patch.h = Math.round(nat.h); }
        // The same rule as the drag resize: a left-grip panel keeps its RIGHT
        // edge, so the dock stays against its gutter rather than opening a
        // gap on the side it faces (measured: 79 px off the gutter without it).
        let left = parseFloat(p.el.style.left) || was.left;
        if (p.el.dataset.grip === 'l') left = (was.left + was.w) - nat.w;
        this._setPos(p, left, parseFloat(p.el.style.top) || 0, { snap: false });
        const a = anchorFromRect(this._rectOf(p.el), this._stageSize());
        this._updateGrip(p);
        this._save(withPanel(this.doc, id, { ...patch, anchor: a.anchor, dx: Math.round(a.dx), dy: Math.round(a.dy) }));
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
        for (const p of this.panels.values()) this._updateGrip(p);
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
        for (const p of this.panels.values()) { p.ro?.disconnect(); p.bar.remove(); p.grip?.remove(); p.el.classList.remove('ua-win'); }
        this.panels.clear();
    }
}
