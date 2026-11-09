/**
 * climalytix/updraft.js — vertical air motion (plan §19 T5), PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * Four different things are all called "updraft", and this module keeps them
 * APART — it lists them side by side and never adds them, because they are
 * different quantities at different heights and scales:
 *
 *   surface   orographic w (T2): the wind forced up/down a slope, AT the ground
 *   slope     the vertical part of the Prandtl slope jet (T3): u·sin α, at the
 *             jet's height (tens of metres) — upslope by day, drainage by night
 *   scale     thermal w* (T4): the SIZE of convective updraughts in the
 *             boundary layer — not a mean (a convecting layer's area-mean w is
 *             ~0: rising plumes and sinking air between them balance)
 *   mean      GFS w at 850 / 700 / 500 hPa (this step): the model's resolved
 *             vertical motion, a 25 km GRID MEAN — fronts, troughs, mountain
 *             waves, large convective systems
 *
 * GFS w is DZDT — the model's own GEOMETRIC vertical velocity in m/s — which
 * GFS publishes beside VVEL (ω, Pa/s). Using it avoids the ω → w = −ω/(ρg)
 * conversion and its density assumption altogether (plan §19 first proposed
 * the conversion; DZDT makes it unnecessary).
 *
 * THE TRAP: a pressure level BELOW THE GROUND is extrapolated fiction — at
 * Boulder (surface ≈ 840 hPa) the 850 hPa "wind" is underground. A level is
 * used only where the surface pressure exceeds it by LEVEL_CLEARANCE_HPA (the
 * level must sit clearly above the ground); everywhere else it is a hole, and
 * the browser gate's negative control draws the masked field to prove it.
 * Each level's height above the ground is the hypsometric equation with a
 * standard-lapse mean layer temperature (an estimate, disclosed; it
 * reproduces the ICAO standard atmosphere to < 0.2 %).
 */

import { OROGRAPHIC_UP, OROGRAPHIC_DOWN } from './orographic.js';

export const G = 9.80665;
export const RD = 287.05;
export const LAPSE = 0.0065;                     // K/m, standard atmosphere
/** A level is used only this far (hPa) above the ground's pressure. */
export const LEVEL_CLEARANCE_HPA = 25;
export const LEVELS = Object.freeze([
    { hPa: 850, id: 'wMs850' }, { hPa: 700, id: 'wMs700' }, { hPa: 500, id: 'wMs500' },
]);
/** |w| (m/s) at which the paint is full strength / below which nothing is painted. */
export const W_FULL_MS = 0.5;
export const W_FLOOR_MS = 0.01;

/** Height (m) of pressure level p above a surface at psfc with 2 m temperature tempC. */
export function levelHeightAgl(psfcHpa, pHpa, tempC) {
    if (!(psfcHpa > 0) || !(pHpa > 0) || !Number.isFinite(tempC)) return NaN;
    const T0 = tempC + 273.15;
    let dz = 0;
    for (let k = 0; k < 6; k++) {                 // mean layer T from the standard lapse
        const Tbar = T0 - LAPSE * dz / 2;
        dz = RD * Tbar / G * Math.log(psfcHpa / pHpa);
    }
    return dz;
}

/** Is level p clearly above the ground (surface pressure psfc)? */
export function levelUsable(psfcHpa, pHpa) {
    return Number.isFinite(psfcHpa) && psfcHpa - pHpa >= LEVEL_CLEARANCE_HPA;
}

/** The two stamps around ms for INSTANTANEOUS fields: { i0, i1, f } or null outside. */
export function bracket(times, ms) {
    if (!times?.length || !Number.isFinite(ms) || ms < times[0] || ms > times[times.length - 1]) return null;
    let i1 = 0;
    while (times[i1] < ms) i1++;
    if (i1 === 0) return { i0: 0, i1: 0, f: 0 };
    return { i0: i1 - 1, i1, f: (ms - times[i1 - 1]) / (times[i1] - times[i1 - 1]) };
}

/** Heat-image painter: red rising / blue sinking, √ ramp from the floor. */
export function updraftPaint(w, data, o) {
    if (!Number.isFinite(w) || Math.abs(w) <= W_FLOOR_MS) return;
    const s = Math.sqrt(Math.min(1, (Math.abs(w) - W_FLOOR_MS) / (W_FULL_MS - W_FLOOR_MS)));
    const c = w > 0 ? OROGRAPHIC_UP : OROGRAPHIC_DOWN;
    data[o] = Math.round(c[0] * 255); data[o + 1] = Math.round(c[1] * 255); data[o + 2] = Math.round(c[2] * 255);
    data[o + 3] = Math.round(255 * (0.18 + 0.5 * s));
}

/**
 * The vertical-motion budget at one point: a LIST of components, each with
 * its own kind and height — never a sum. Inputs are whatever the other layers
 * computed (null = not computed):
 *   orographicW (m/s, at the surface), slope (T3 result: { u, slopeDeg, zJet }),
 *   thermal (T4 result: { wstar, topM, regime }), levels ([{ hPa, w, zAgl, usable }]).
 * Rows: { key, label, kind: 'surface'|'slope'|'scale'|'mean', w, heightM, note }.
 */
export function verticalMotion({ orographicW = null, slope = null, thermal = null, levels = [] } = {}) {
    const rows = [];
    if (Number.isFinite(orographicW)) {
        rows.push({ key: 'orographic', label: 'Forced by the slope', kind: 'surface', w: orographicW, heightM: 0,
            note: 'the 10 m wind pushed up or down the terrain, at the ground' });
    }
    if (slope && Number.isFinite(slope.u) && Number.isFinite(slope.slopeDeg)) {
        rows.push({ key: 'slope', label: slope.u > 0 ? 'Upslope wind (vertical part)' : 'Drainage wind (vertical part)',
            kind: 'slope', w: slopeVertical(slope.u, slope.slopeDeg), heightM: slope.zJet ?? null,
            note: 'the slope jet\'s climb or descent, u·sin α' });
    }
    if (thermal && thermal.regime && thermal.regime !== 'none') {
        rows.push({ key: 'thermal', label: 'Thermal updraughts (scale)', kind: 'scale', w: thermal.wstar,
            heightM: thermal.topM, note: 'how strong the rising plumes are — not a mean: air sinks between them' });
    }
    for (const l of levels) {
        rows.push({ key: `gfs${l.hPa}`, label: `GFS ${l.hPa} hPa (25 km mean)`, kind: 'mean',
            w: l.usable ? l.w : null, heightM: l.usable ? l.zAgl : null,
            note: l.usable ? 'the model\'s resolved vertical motion, averaged over its grid cell' : 'below the ground here' });
    }
    return rows.sort((a, b) => (a.heightM ?? Infinity) - (b.heightM ?? Infinity));
}

/** The vertical component of a flow of speed u along a slope of angle α. */
export function slopeVertical(u, slopeDeg) {
    return u * Math.sin(slopeDeg * Math.PI / 180);
}
