/**
 * stage-layout.js — where the panels over a canvas live, and who remembers it
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE (no DOM, no storage, no ambient time; node-gated by
 * tests/stage-layout.mjs). The rules behind `js/upper-atmosphere-stage-windows.js`,
 * which turns every piece of chrome over the Upper Atmosphere stage into a
 * WINDOW — draggable, collapsible, resizable — and remembers the arrangement.
 *
 * THE DOCUMENT
 * ────────────
 *   { v: 1, panels: { [id]: { anchor, dx, dy, w, h, open } } }
 * A panel that was never touched has NO entry: it sits at its CSS home.
 * A moved panel is stored RELATIVE TO THE NEAREST STAGE CORNER (`anchor`
 * 'tl'|'tr'|'bl'|'br', `dx`/`dy` the offsets of the panel's own matching
 * corner from it), never as absolute pixels: a dock dragged a little off
 * the top-right stays top-right when the stage is 1224 px wide on a
 * monitor and 584 px wide on a laptop, where absolute pixels would strand
 * it in the middle or off the canvas. `w`/`h` are the user's sizes (absent
 * = the CSS size), `open` false means collapsed to the title bar.
 *
 * PLACING
 * ───────
 * `placeFromAnchor` turns an entry back into left/top for a stage of the
 * current size and CLAMPS it so at least MIN_VISIBLE_PX of the panel stay
 * inside the stage (the draggable-panel rule: the user must always have
 * something to grab). `anchorFromRect` is its inverse on drop. `snapRect`
 * lands a dragged edge exactly on the stage gutter when it comes within
 * SNAP_PX of it. `gripSide` / `resizeFrom` are the resize rules: the grip
 * faces the OPEN stage and a size is clamped to the edge it grows toward,
 * so a resize can never push a panel off the stage.
 *
 * WHO REMEMBERS
 * ─────────────
 * Everyone can arrange the stage for the session. REMEMBERING it — locally
 * and, through the dashboards table, across devices — is a Basic+ feature
 * ("intro" is the legacy alias of basic): `layoutMemoryAllowed` is the ONE
 * gate and delegates to dashboard-sync's `tierAllowsSync`, so the stage,
 * the space-weather console and the climate lab all draw the paid line in
 * the same place (testers and admins ride along there too).
 */

import { tierAllowsSync } from './dashboard-sync.js';

export const STAGE_LAYOUT_VERSION = 1;
export const ANCHORS = Object.freeze(['tl', 'tr', 'bl', 'br']);
/** The least of a panel that may remain inside the stage after a drop. */
export const MIN_VISIBLE_PX = 36;

const fin = (v) => Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Basic+ (testers / admins too): the one gate for remembering a layout. */
export function layoutMemoryAllowed(plan, role) {
    return tierAllowsSync(plan, role);
}

/**
 * A valid document from anything: unknown ids dropped, bad numbers
 * dropped, an entry with nothing left in it dropped. null for garbage.
 * @param {*} raw
 * @param {string[]} panelIds  the ids this page knows
 */
export function normalizeStageLayout(raw, panelIds) {
    const known = new Set(panelIds || []);
    const out = { v: STAGE_LAYOUT_VERSION, panels: {} };
    if (!raw || typeof raw !== 'object' || !raw.panels || typeof raw.panels !== 'object') return out;
    for (const [id, e] of Object.entries(raw.panels)) {
        if (!known.has(id) || !e || typeof e !== 'object') continue;
        const p = {};
        if (ANCHORS.includes(e.anchor) && fin(e.dx) && fin(e.dy)) {
            p.anchor = e.anchor; p.dx = clamp(e.dx, -1e5, 1e5); p.dy = clamp(e.dy, -1e5, 1e5);
        }
        if (fin(e.w) && e.w > 0) p.w = clamp(e.w, 1, 1e4);
        if (fin(e.h) && e.h > 0) p.h = clamp(e.h, 1, 1e4);
        if (e.open === false) p.open = false;
        if (Object.keys(p).length) out.panels[id] = p;
    }
    return out;
}

/** True when the document says nothing (every panel at its CSS home). */
export function isHomeLayout(doc) {
    return !doc || !doc.panels || Object.keys(doc.panels).length === 0;
}

/**
 * Clamp a rect into the stage so at least `minVisible` px of it remain on
 * both axes. Rects are {left, top, w, h}; the stage is {w, h}.
 */
export function clampRect(rect, stage, minVisible = MIN_VISIBLE_PX) {
    const mv = Math.max(1, Math.min(minVisible, rect.w, rect.h));
    return {
        left: clamp(rect.left, mv - rect.w, stage.w - mv),
        top: clamp(rect.top, mv - rect.h, stage.h - mv),
        w: rect.w, h: rect.h,
    };
}

/** Edge snap distance and the stage inset the edges snap TO (the page's
 *  --ua-sp-5 gutter, where every CSS home sits). */
export const SNAP_PX = 10;
export const SNAP_INSET_PX = 12;

/**
 * Snap a dragged rect's edges to the stage gutter when they come within
 * SNAP_PX of it, so a dock dragged back toward its corner lands EXACTLY
 * where its CSS home was rather than 3 px off it. Left/right and top/bottom
 * are independent; the nearer edge on each axis wins. Returns a new rect.
 */
export function snapRect(rect, stage, { inset = SNAP_INSET_PX, tol = SNAP_PX } = {}) {
    let { left, top } = rect;
    const dl = Math.abs(left - inset), dr = Math.abs((stage.w - inset) - (left + rect.w));
    if (dl <= tol && dl <= dr) left = inset;
    else if (dr <= tol) left = stage.w - inset - rect.w;
    const dt = Math.abs(top - inset), db = Math.abs((stage.h - inset) - (top + rect.h));
    if (dt <= tol && dt <= db) top = inset;
    else if (db <= tol) top = stage.h - inset - rect.h;
    return { left, top, w: rect.w, h: rect.h };
}

/**
 * Which side a panel's resize grip faces: 'l' when the panel's centre sits
 * clearly in the right half of the stage, 'r' otherwise. A grip faces the
 * OPEN stage — a dock parked top-right has nowhere to grow on its right, so
 * its grip sits bottom-left and dragging it left widens the dock with its
 * right edge pinned (dragging a bottom-right grip rightwards there only
 * pushed the dock off the stage). A panel that SPANS the stage (the time
 * dock, the render dock at home) has its centre on the midline to within
 * a fraction of a pixel, and a fractional width tipped it left — measured:
 * both docks grew left-side grips, and a press meant for one dock's grip
 * landed on the other's. A tie, to GRIP_TIE_PX, is the conventional
 * bottom-right.
 */
export const GRIP_TIE_PX = 2;
export function gripSide(rect, stage) {
    return (rect.left + rect.w / 2) - stage.w / 2 > GRIP_TIE_PX ? 'l' : 'r';
}

/**
 * The size a resize drag arrives at. `side` is the grip's side ('l'|'r'),
 * `dx`/`dy` the pointer travel; the width is clamped so the panel's far edge
 * never leaves the stage gutter, the height so its bottom never does, and
 * for a left grip the left edge moves with the width so the right edge is
 * pinned. Returns { w, h, left } (left only changes for a left grip; w or h
 * are undefined on an axis the panel does not resize on).
 */
export function resizeFrom(start, delta, stage, { axis = 'xy', side = 'r', minW = 120, minH = 24, maxW = Infinity, maxH = Infinity, inset = SNAP_INSET_PX } = {}) {
    const wantW = axis === 'y' ? undefined : (side === 'l' ? start.w - delta.dx : start.w + delta.dx);
    const wantH = axis === 'x' ? undefined : start.h + delta.dy;
    const roomW = side === 'l' ? (start.left + start.w) - inset : (stage.w - inset) - start.left;
    const roomH = (stage.h - inset) - start.top;
    const sz = clampSize({ w: wantW, h: wantH }, {
        minW, minH,
        maxW: Math.min(maxW, Math.max(minW, roomW)),
        maxH: Math.min(maxH, Math.max(minH, roomH)),
    });
    const left = (side === 'l' && sz.w !== undefined) ? start.left + (start.w - sz.w) : start.left;
    return { w: sz.w, h: sz.h, left };
}

/** A size within the panel's limits. */
export function clampSize(size, limits = {}) {
    const { minW = 120, minH = 24, maxW = Infinity, maxH = Infinity } = limits;
    return {
        w: fin(size.w) ? clamp(size.w, minW, maxW) : undefined,
        h: fin(size.h) ? clamp(size.h, minH, maxH) : undefined,
    };
}

/**
 * The entry for a dropped rect: the stage corner nearest the rect's
 * centre, and the rect's matching corner's offset from it (dx positive
 * INTO the stage on both axes, so a stored offset never depends on which
 * side it was measured from).
 */
export function anchorFromRect(rect, stage, anchor = null) {
    const cx = rect.left + rect.w / 2, cy = rect.top + rect.h / 2;
    const a = ANCHORS.includes(anchor) ? anchor : null;
    // A forced corner (the panel's EXISTING anchor, kept across a width-only
    // resize so a bottom-anchored dock stays bottom-anchored) or the nearest.
    const right = a ? a[1] === 'r' : cx > stage.w / 2;
    const bottom = a ? a[0] === 'b' : cy > stage.h / 2;
    const dx = right ? stage.w - (rect.left + rect.w) : rect.left;
    const dy = bottom ? stage.h - (rect.top + rect.h) : rect.top;
    return { anchor: (bottom ? 'b' : 't') + (right ? 'r' : 'l'), dx, dy };
}

/**
 * Inverse of `anchorFromRect` for the current stage, clamped. `size` is
 * the panel's current rendered size (w, h).
 */
export function placeFromAnchor(entry, stage, size, minVisible = MIN_VISIBLE_PX) {
    const w = size.w, h = size.h;
    const right = entry.anchor?.[1] === 'r', bottom = entry.anchor?.[0] === 'b';
    const left = right ? stage.w - entry.dx - w : entry.dx;
    const top = bottom ? stage.h - entry.dy - h : entry.dy;
    return clampRect({ left, top, w, h }, stage, minVisible);
}

/** Round trip helper: a rect placed then re-anchored keeps its anchor. */
export function roundTrip(rect, stage) {
    const e = anchorFromRect(rect, stage);
    return placeFromAnchor(e, stage, { w: rect.w, h: rect.h });
}

/** Merge a change into a document (pure). `patch` null removes the entry. */
export function withPanel(doc, id, patch) {
    const base = normalizeStageLayout(doc, [...Object.keys(doc?.panels || {}), id]);
    const panels = { ...base.panels };
    if (patch == null) delete panels[id];
    else {
        const merged = { ...(panels[id] || {}), ...patch };
        for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
        if (merged.open !== false) delete merged.open;
        if (Object.keys(merged).length) panels[id] = merged; else delete panels[id];
    }
    return { v: STAGE_LAYOUT_VERSION, panels };
}
