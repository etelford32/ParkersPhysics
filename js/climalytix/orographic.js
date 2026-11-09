/**
 * climalytix/orographic.js — forced ascent over terrain (plan §19 T2), PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * Air cannot flow into the ground, so where the wind blows up a slope it is
 * forced up. At the surface this is EXACT — the kinematic lower boundary
 * condition of every atmospheric model:
 *
 *        w = u·∂h/∂x + v·∂h/∂y          (m/s; u east, v north, h metres)
 *
 * Windward slopes get w > 0 (forced ascent, "ridge lift"), lee slopes w < 0
 * (forced descent). The same dot product written in slope/aspect terms is
 *
 *        w = tan(s)·(−u·sin A − v·cos A)    (A = the direction the slope FACES)
 *
 * and `slopeWind` is that form, so the hover readout and the gridded field
 * are checked against each other (tests/climalytix-orographic.mjs).
 *
 * What this is NOT, and the rail says so:
 *   · it is the SURFACE value. Above the ground the forced motion decays over
 *     a height comparable to the hill's horizontal scale (potential flow), and
 *     a stable atmosphere turns it into lee waves the boundary condition knows
 *     nothing about;
 *   · the wind is GFS's 10 m wind on GFS's own ~25 km terrain — the model has
 *     already deflected some of the flow around the big features, and the
 *     wind a slope actually feels can differ a lot from it;
 *   · w scales with the slope, so it is only as fine as the slope grid (the
 *     terrain rail quotes that resolution).
 * It is a diagnostic of where the flow is pushed up or down, never a promise
 * of lift at a spot.
 *
 * Inputs reuse T1's grid + `slopeAspect` (dzdx / dzdy in m/m, dzdy = rise
 * toward the NORTH) and airflow.js's `windAt`. NaN where either is missing.
 */

const D2R = Math.PI / 180;

/** |w| (m/s) at which the colour is full strength. Ridge lift of a few m/s is strong. */
export const OROGRAPHIC_FULL_MS = 2;
/**
 * Below this |w| (m/s) nothing is painted, and the ramp STARTS here so weak
 * values fade in instead of stepping in. 0.1 m/s ≈ 20 ft/min, a fraction of
 * any glider's own sink rate. Measured on the first render: at 0.02 with the
 * ramp from zero, 50 m of roughness under a 9 m/s wind painted ±0.2 m/s at
 * ~30 % opacity and striped every plain — real terrain is rough everywhere.
 */
export const OROGRAPHIC_FLOOR_MS = 0.1;
export const OROGRAPHIC_UP = Object.freeze([0.93, 0.36, 0.24]);     // forced ascent
export const OROGRAPHIC_DOWN = Object.freeze([0.25, 0.55, 0.95]);   // forced descent
export const OROGRAPHIC_ALPHA = 0.82;

/** m/s → ft/min (a glider pilot's vario unit). */
export const FT_PER_MIN_PER_MS = 60 / 0.3048;

/** The closed form: w for a slope `slopeDeg` facing `aspectDeg` under wind (u, v). */
export function slopeWind(slopeDeg, aspectDeg, u, v) {
    if (!Number.isFinite(slopeDeg) || !Number.isFinite(u) || !Number.isFinite(v)) return NaN;
    if (slopeDeg === 0) return 0;
    if (!Number.isFinite(aspectDeg)) return NaN;
    const a = aspectDeg * D2R;
    return Math.tan(slopeDeg * D2R) * (-u * Math.sin(a) - v * Math.cos(a));
}

/**
 * w on every node of a T1 grid. `windAt(lat, lon)` → { u, v } | null.
 * Returns Float32Array (NaN where the slope or the wind is unknown).
 */
export function orographicGrid(g, sa, windAt) {
    const out = new Float32Array(g.nRows * g.nCols).fill(NaN);
    for (let i = 0; i < g.nRows; i++) {
        const lat = g.latN - i * g.dlat;
        for (let j = 0; j < g.nCols; j++) {
            const k = i * g.nCols + j;
            const gx = sa.dzdx[k], gy = sa.dzdy[k];
            if (!Number.isFinite(gx) || !Number.isFinite(gy)) continue;
            const w = windAt(lat, g.lonW + j * g.dlon);
            if (!w || !Number.isFinite(w.u) || !Number.isFinite(w.v)) continue;
            out[k] = w.u * gx + w.v * gy;
        }
    }
    return out;
}

/**
 * The strongest forced ascent and descent on the grid (optionally inside a
 * lat/lon box): { up: { w, lat, lon } | null, down: … , n }.
 */
export function orographicExtremes(g, w, box = null) {
    let up = null, down = null, n = 0;
    for (let i = 0; i < g.nRows; i++) {
        const lat = g.latN - i * g.dlat;
        if (box && (lat > box.north || lat < box.south)) continue;
        for (let j = 0; j < g.nCols; j++) {
            const lon = g.lonW + j * g.dlon;
            if (box && (lon < box.west || lon > box.east)) continue;
            const v = w[i * g.nCols + j];
            if (!Number.isFinite(v)) continue;
            n++;
            if (!up || v > up.w) up = { w: v, lat, lon };
            if (!down || v < down.w) down = { w: v, lat, lon };
        }
    }
    return { up: up && up.w > 0 ? up : null, down: down && down.w < 0 ? down : null, n };
}

/** Which side of the slope the wind is on, from w and the slope (words for the hover). */
export function windSide(w, slopeDeg) {
    if (!Number.isFinite(w)) return null;
    if (!(slopeDeg >= 1) || Math.abs(w) < OROGRAPHIC_FLOOR_MS) return 'across the slope';
    return w > 0 ? 'windward, forced up' : 'lee, forced down';
}

/** Heat-image painter: red up / blue down, √ ramp from the floor to full at OROGRAPHIC_FULL_MS. */
export function orographicPaint(w, data, o) {
    if (!Number.isFinite(w) || Math.abs(w) <= OROGRAPHIC_FLOOR_MS) return;
    const s = Math.sqrt(Math.min(1, (Math.abs(w) - OROGRAPHIC_FLOOR_MS) / (OROGRAPHIC_FULL_MS - OROGRAPHIC_FLOOR_MS)));
    const c = w > 0 ? OROGRAPHIC_UP : OROGRAPHIC_DOWN;
    data[o] = Math.round(c[0] * 255); data[o + 1] = Math.round(c[1] * 255); data[o + 2] = Math.round(c[2] * 255);
    data[o + 3] = Math.round(255 * OROGRAPHIC_ALPHA * s);
}

/** "+1.3 m/s" or, for a ft reader, "+1.3 m/s (256 ft/min)". */
export function formatW(w, { feet = false } = {}) {
    if (!Number.isFinite(w)) return '—';
    const s = `${w >= 0 ? '+' : '−'}${Math.abs(w).toFixed(Math.abs(w) < 1 ? 2 : 1)} m/s`;
    return feet ? `${s} (${w >= 0 ? '+' : '−'}${Math.round(Math.abs(w) * FT_PER_MIN_PER_MS)} ft/min)` : s;
}
