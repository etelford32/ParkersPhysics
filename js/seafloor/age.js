/**
 * age.js — the age of the sea floor under a trench profile, and the depth that age alone predicts. PURE.
 *
 * DATA: Seton et al. 2020 (G-cubed, doi:10.1029/2020GC009214), version 2020.1, 6′, CC BY 4.0 — baked by
 * scripts/build-seafloor-age.py into one window per trench site (`<id>.age.bin.gz`, `age-index.json`). The
 * ages are the source's own nodes; sampling is bilinear and a point with ANY no-data corner has NO age (a
 * continent or unmapped crust is never averaged into a number).
 *
 * THE MODEL IS THERMAL SUBSIDENCE: a plate deepens as it cools. Both published trench studies this page is
 * checked against remove it before fitting the bending plate (Garcia et al. 2019: Parsons & Sclater 1977;
 * Zhang et al. 2018: a half-space model). We use GDH1 (Stein & Stein 1992), a plate model, because the two
 * branches of Parsons & Sclater 1977 disagree by ~80 m where they are joined at 70 Myr and a 520 km profile
 * across that age would carry a false step; GDH1's branches meet at 20 Myr in value AND slope (gated). The
 * coefficients are written FROM MEMORY (`SUBSIDENCE.verified: false`); the join is the internal evidence that
 * they are the published ones. Only the SHAPE matters to the fit — the profile's own reference depth is still
 * fitted — so a constant offset in the curve (a swell, a ridge depth) changes nothing.
 *
 * NOT REMOVED: sediment loading (both studies remove it; no sediment grid is baked yet), crustal-thickness
 * changes, and the depth anomalies of hotspot swells. They stay in the residual, as they did with the straight
 * regional slope this replaces.
 */
import { destination } from './bathy.js';

export const AGE_NO_DATA = -32768;
/** GDH1, Stein & Stein 1992: depth (m) = shallow branch below `tJoin` Myr, exponential branch above. */
export const SUBSIDENCE = Object.freeze({ name: 'GDH1 (Stein & Stein 1992)', verified: false, d0: 2600, a: 365, tJoin: 20, dInf: 5651, b: 2473, k: 0.0278 });

/** Depth (m) the plate-cooling model predicts for sea floor of age t (Myr). */
export function subsidenceDepth(tMa, m = SUBSIDENCE) {
    if (!(tMa >= 0)) return null;
    return tMa < m.tJoin ? m.d0 + m.a * Math.sqrt(tMa) : m.dInf - m.b * Math.exp(-m.k * tMa);
}

/** An age window from its age-index.json entry and its decoded int16 values. */
export function makeAgeGrid(meta, int16) {
    if (int16.length !== meta.nx * meta.ny) throw new Error(`age grid ${meta.id}: ${int16.length} values for ${meta.nx}×${meta.ny}`);
    return { id: meta.id, nx: meta.nx, ny: meta.ny, north: meta.north, west: meta.west, step: meta.step_deg, q: int16 };
}

/** Age (Myr) at a point: bilinear on the source's nodes, null outside the window or next to any no-data node. */
export function sampleAge(g, lat, lon) {
    let d = lon - g.west; d -= 360 * Math.floor(d / 360);
    const fj = (g.north - lat) / g.step, fi = d / g.step, E = 1e-6;
    if (!(fj >= -E && fi >= -E && fj <= g.ny - 1 + E && fi <= g.nx - 1 + E)) return null;
    const i0 = Math.min(Math.max(Math.floor(fi), 0), g.nx - 2), j0 = Math.min(Math.max(Math.floor(fj), 0), g.ny - 2);
    const u = Math.min(Math.max(fi - i0, 0), 1), v = Math.min(Math.max(fj - j0, 0), 1);
    const at = (i, j) => g.q[j * g.nx + i];
    const a = at(i0, j0), b = at(i0 + 1, j0), c = at(i0, j0 + 1), e = at(i0 + 1, j0 + 1);
    if (a === AGE_NO_DATA || b === AGE_NO_DATA || c === AGE_NO_DATA || e === AGE_NO_DATA) return null;
    return ((a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + e * u) * v) / 10;
}

/**
 * The age under each point of a stacked bending profile (trench-model.js `bendingProfile`, which records its
 * origin, seaward bearing and axis offset): the MEAN over the same parallel lines the depth was stacked from,
 * null where fewer than `minLines` have an age. A mean, not the depth's median, because subsidence is close to
 * linear in age over an 80 km stack and the median of nine nearly equal ages adds nothing but rounding.
 */
export function profileAges(ageGrid, profile, { offsetsKm = [-40, -30, -20, -10, 0, 10, 20, 30, 40], minLines = 5 } = {}) {
    if (!ageGrid || !profile || !profile.origin) return null;
    const { origin, seaBearingDeg: sb, axisOffsetKm } = profile, along = sb + 90;
    const lines = offsetsKm.map((o) => (o >= 0 ? destination(origin.lat, origin.lon, along, o) : destination(origin.lat, origin.lon, along + 180, -o)));
    return profile.map((p) => {
        const s = axisOffsetKm + p.x; let sum = 0, n = 0;
        for (const L of lines) { const q = s >= 0 ? destination(L.lat, L.lon, sb, s) : destination(L.lat, L.lon, sb + 180, -s), a = sampleAge(ageGrid, q.lat, q.lon); if (a != null) { sum += a; n++; } }
        return n >= minLines ? sum / n : null;
    });
}

/**
 * A profile with thermal subsidence REMOVED: each point's depth minus the depth its age predicts (plus a constant
 * so the numbers stay depths near the trench's own), keeping only the points that have an age. Returns the new
 * profile (same `x`, `n`, `src`, plus `age`, `ageHeld` and `subsidence`) with `ageCoverage` (share of the input's
 * depth points that kept an age, held ones included), `ageHeldKm` (how far from the axis an age was held) and the mean slope the subsidence implies (m/km, positive = deepening seaward).
 */
/**
 * AT THE AXIS THE GRID STOPS SHORT OF THE PLATE: Seton et al. mask their grid at the mapped plate boundary, and the
 * stacked lines near a trench axis reach onto the overriding plate — MEASURED on the 75 stations: the first dated
 * point lies 0–32 km seaward of the axis (Hellenic aside), and dropping those points silently removed the deepest
 * part of the trench wall from every age-referenced fit (and stopped the two-thickness fit, which needs the axis).
 * The incoming plate is continuous to the axis and changes age by well under 1 Myr over that distance, so a point
 * within `AGE_HOLD_KM` of the axis takes the age of the nearest dated point SEAWARD, flagged `ageHeld`; nothing is
 * held past that, and nothing landward of the axis.
 */
export const AGE_HOLD_KM = 40;
export function removeSubsidence(profile, ages, m = SUBSIDENCE) {
    if (!profile || !ages) return null;
    const pts = [], withDepth = profile.filter((p) => p.depth != null && p.x >= 0).length;
    let first = null; for (let i = 0; i < profile.length; i++) if (profile[i].x >= 0 && ages[i] != null && (!first || profile[i].x < first.x)) first = { x: profile[i].x, age: ages[i] };
    let heldKm = 0;
    for (let i = 0; i < profile.length; i++) {
        const p = profile[i]; let t = ages[i], held = false;
        if (t == null && first && p.x >= 0 && p.x < first.x && first.x <= AGE_HOLD_KM) { t = first.age; held = true; heldKm = Math.max(heldKm, first.x - p.x); }
        if (p.depth == null || t == null) continue;
        pts.push({ ...p, age: t, ageHeld: held, subsidence: subsidenceDepth(t, m) });
    }
    const sea = pts.filter((p) => p.x >= 0), ref = sea.length ? sea.reduce((a, p) => a + p.subsidence, 0) / sea.length : 0;
    const out = pts.map((p) => ({ ...p, depth: p.depth - (p.subsidence - ref) }));
    let sx = 0, sy = 0, sxx = 0, sxy = 0; for (const p of sea) { sx += p.x; sy += p.subsidence; sxx += p.x * p.x; sxy += p.x * p.subsidence; }
    const n = sea.length, det = n * sxx - sx * sx;
    return Object.assign(out, { axisS: profile.axisS, origin: profile.origin, seaBearingDeg: profile.seaBearingDeg, axisOffsetKm: profile.axisOffsetKm,
        ageCoverage: withDepth ? sea.length / withDepth : 0, ageHeldKm: heldKm, subsidenceSlope: det > 0 ? (n * sxy - sx * sy) / det : null,
        ageRange: sea.length ? [Math.min(...sea.map((p) => p.age)), Math.max(...sea.map((p) => p.age))] : null });
}

/**
 * THE UNBENT PLATE AGAINST TEMPERATURE. An oceanic plate is elastic down to roughly a fixed isotherm — studies put
 * T_e between the 300 °C and 600 °C isotherms of a cooling model (the comparison both trench papers make). Here the
 * isotherm depths come from the HALF-SPACE cooling model, z = 2·√(κt)·erf⁻¹(T/T_m), with `THERMAL` (κ, T_m written
 * FROM MEMORY, `verified: false`). This is a COMPARISON printed beside the data's own bounds — it never bounds a fit.
 */
export const THERMAL = Object.freeze({ kappa: 1e-6, tMantleC: 1350, isotherms: [300, 600], verified: false });
const SEC_PER_MYR = 3.15576e13;
/** erf: the Maclaurin series below 2.5 (exact to double precision there), Abramowitz & Stegun 7.1.26 above (|ε| < 1.5e-7). */
export function erf(x) {
    if (x < 0) return -erf(-x);
    if (x < 2.5) { let sum = 0, term = x, n = 0; while (Math.abs(term) > 1e-17 * Math.abs(sum) || n < 3) { sum += term / (2 * n + 1); n++; term *= -x * x / n; if (n > 200) break; } return 2 / Math.sqrt(Math.PI) * sum; }
    const t = 1 / (1 + 0.3275911 * x), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return y;
}
export function erfinv(y) {
    if (!(y > -1 && y < 1)) return y === 1 ? Infinity : y === -1 ? -Infinity : NaN;
    let x = Math.sign(y) * Math.sqrt(-Math.log((1 - Math.abs(y)) / 2));             // a start on the right side
    if (Math.abs(y) < 0.9) x = y * Math.sqrt(Math.PI) / 2;
    for (let i = 0; i < 60; i++) { const e = erf(x) - y, d = 2 / Math.sqrt(Math.PI) * Math.exp(-x * x); const step = e / d; x -= step; if (Math.abs(step) < 1e-15) break; }
    return x;
}
/** Depth (km) of the T °C isotherm in a half-space cooled for t Myr. */
export function isothermDepthKm(tMa, tC, m = THERMAL) {
    if (!(tMa > 0) || !(tC > 0 && tC < m.tMantleC)) return null;
    return 2 * Math.sqrt(m.kappa * tMa * SEC_PER_MYR) * erfinv(tC / m.tMantleC) / 1000;
}
/** The unbent plate of a two-thickness fit beside the isotherms of its age: { ageMa, isothermsKm: {300, 600}, lowerKm, upperKm, aboveHot }. */
export function thermalCheck(ageMa, fit, m = THERMAL) {
    const iso = Object.fromEntries(m.isotherms.map((T) => [T, isothermDepthKm(ageMa, T, m)]));
    const iv = fit && fit.intervals && fit.intervals.teM;
    const hot = iso[Math.max(...m.isotherms)];
    return { ageMa, isothermsKm: iso, lowerKm: iv ? iv[0] : null, upperKm: iv && !iv[3] ? iv[1] : null,
        // the data's own LOWER bound already below the hotter isotherm is consistent; above it, the fit asks for a plate stiffer than a cooling plate of that age can be
        aboveHot: iv && hot != null ? iv[0] > hot : null };
}
