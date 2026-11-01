/**
 * launch-camera-layout.js — PURE layout rules for the launch planner's 3D
 * vehicle canvas: which camera preset a given screen opens on, and where the
 * vehicle may be framed so the toolbars never sit on top of it.
 *
 * No DOM, no THREE: numbers in, numbers out, node-gated by
 * tests/launch-camera-layout.mjs. js/launch-vehicle-3d.js applies the
 * results; launch-planner.html measures the overlay rectangles.
 *
 * 1. DEFAULT VIEW BY SCREEN (`pickDefaultView`). Launch vehicles are TALL, so
 *    the frame's shape decides what reads best:
 *      portrait (aspect < 0.85, phones)  → 3/4 at 40° — the stack fills the
 *                                          tall frame; a slightly wider lens
 *                                          keeps the pad in the shot
 *      short landscape (h < 420, phone
 *        on its side)                    → 3/4 at 38° — the vertical fit binds,
 *                                          a pulled-back shot would be a speck
 *      very wide (aspect ≥ 1.9, full-
 *        screen on a monitor)            → Wide at 34° — the side space shows
 *                                          the pad instead of empty sky
 *      everything else                   → 3/4 at 38° (the historical default)
 *    The canvas only applies this while the user has not picked a preset
 *    themselves; a deliberate choice is never overridden by a resize.
 *
 * 2. SAFE FRAME (`safeInsets` + `framingFor`). The toolbars float over the
 *    canvas. An overlay counts against the frame only if it crosses the
 *    CENTRAL band (30–70 % of the width), where the vehicle is drawn — a
 *    narrow dock in a corner of a wide canvas costs the vehicle nothing,
 *    while the same dock spanning a phone's width does. Each inset is capped
 *    at 30 % of the height, so at least 40 % of the frame always remains.
 *    `framingFor` turns the insets into what the camera needs:
 *      · fitFovDeg / fitAspect — the vertical FOV and aspect of the SAFE
 *        rectangle (same focal length, shorter height), which the bbox fit
 *        uses so the vehicle fits the unobstructed area exactly;
 *      · viewOffsetY — how far the projection's principal point must move
 *        (camera.setViewOffset(W, H, 0, viewOffsetY, W, H)) so the fitted
 *        vehicle is centred in that rectangle rather than in the full canvas.
 *    With no insets every output is the identity (offset 0, fov unchanged).
 */

export const DEFAULT_VIEW = Object.freeze({ view: 'threequarter', fov: 38 });

export function pickDefaultView({ width, height } = {}) {
    const w = Number(width), h = Number(height);
    if (!(w > 0) || !(h > 0)) return { ...DEFAULT_VIEW };
    const aspect = w / h;
    if (aspect < 0.85)              return { view: 'threequarter', fov: 40 };
    if (h < 420 && aspect >= 1.2)   return { view: 'threequarter', fov: 38 };
    if (aspect >= 1.9)              return { view: 'wide',         fov: 34 };
    return { ...DEFAULT_VIEW };
}

const BAND_LO = 0.30, BAND_HI = 0.70;   // the central band the vehicle occupies
const MAX_INSET_FRAC = 0.30;            // per edge
const GAP_PX = 6;                       // breathing room past an overlay's edge

// rects: [{ left, top, right, bottom }] in px RELATIVE to the canvas host.
// Hidden overlays should simply not be passed.
export function safeInsets(width, height, rects = []) {
    const W = Math.max(1, Number(width) || 1);
    const H = Math.max(1, Number(height) || 1);
    let top = 0, bottom = 0;
    for (const r of rects) {
        if (!r) continue;
        const { left, right } = r;
        const rt = r.top, rb = r.bottom;
        if (!(right > left) || !(rb > rt)) continue;
        // Must cross the central band to matter.
        if (right <= W * BAND_LO || left >= W * BAND_HI) continue;
        const cy = (rt + rb) / 2;
        if (cy < H / 2) top = Math.max(top, rb + GAP_PX);
        else            bottom = Math.max(bottom, H - rt + GAP_PX);
    }
    const cap = H * MAX_INSET_FRAC;
    return {
        top: Math.max(0, Math.min(cap, Math.round(top))),
        bottom: Math.max(0, Math.min(cap, Math.round(bottom))),
    };
}

export function framingFor({ width, height, fovDeg, insets = { top: 0, bottom: 0 } }) {
    const W = Math.max(1, Number(width) || 1);
    const H = Math.max(1, Number(height) || 1);
    const top = Math.max(0, insets.top || 0);
    const bottom = Math.max(0, insets.bottom || 0);
    const Hs = Math.max(H * 0.4, H - top - bottom);
    const half = (fovDeg * Math.PI / 180) / 2;
    const fitFovDeg = 2 * Math.atan(Math.tan(half) * Hs / H) * 180 / Math.PI;
    return {
        fitFovDeg,
        fitAspect: W / Hs,
        // Principal point moves DOWN by (top − bottom)/2: a window starting
        // that far ABOVE the full image puts the image centre that far lower.
        viewOffsetY: (bottom - top) / 2,
        safeHeight: Hs,
    };
}
