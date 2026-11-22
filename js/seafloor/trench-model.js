/**
 * trench-model.js — why a trench is where it is and why it has the shape it has. PURE.
 *
 * It computes NO plate kinematics and NO slab geometry of its own: plate boundaries, Euler poles
 * and the plate raster are Bird's PB2002 through js/earth-interior/plates.js (+ plates-model.js
 * `nearestStep`), the subducted plate's surface is USGS Slab2 through js/earth-interior/slabs.js.
 * Both are imported, never copied — touching either means the Inner Earth gates too.
 *
 * WHAT IT ADDS IS ONE MODEL: THE BENDING PLATE.
 * Seaward of a trench the downgoing plate behaves like a thin elastic plate floating on a fluid
 * mantle and loaded at its end. Its deflection is the UNIVERSAL TRENCH PROFILE (Caldwell et al.
 * 1976; Turcotte & Schubert, Geodynamics, §3.17):
 *
 *     w(x) = w_b · √2 · e^(π/4) · exp(−(π/4)·ξ) · sin((π/4)·ξ),     ξ = (x − x₀)/(x_b − x₀)
 *
 * w is height above the undisturbed sea floor, x is distance seaward of the trench axis, x₀ is
 * where the plate crosses its undisturbed level and (x_b, w_b) is the top of the OUTER RISE —
 * the low swell a few hundred metres high that stands seaward of every bending plate. The shape
 * has no free constants: two lengths and one height. The plate's stiffness follows from the
 * length alone:
 *
 *     α = 4·(x_b − x₀)/π       (flexural parameter)
 *     D = α⁴·(ρ_m − ρ_w)·g/4   (flexural rigidity)
 *     T_e = [12·(1 − ν²)·D/E]^(1/3)   (effective elastic thickness)
 *
 * `fitFlexure` fits (x₀, x_b, w_b) and the undisturbed depth to the OBSERVED bathymetry: a STACK
 * (median of parallel sections — one section is at the mercy of a single seamount) on the
 * downgoing plate's side, which is decided by the plate raster, never by which side looks deeper.
 * Every fit is scored against two CONTROLS on the same points — a flat sea floor (no bending) and
 * a straight tilted one — and reports `quality`: a fit that does not clearly beat the straight
 * line, whose outer rise is not inside the data, does not stand clear of the scatter, or is not
 * followed by sea floor back at the undisturbed level, is 'poor' and the page prints no elastic
 * thickness for it. MEASURED on the 28 baked windows (2026-11-22): most trenches are 'poor' — the
 * rise is a few hundred metres on a grid whose own scatter is 100–300 m, and seamounts or a young
 * plate's regional slope hide it. That is the honest state of a first model; a regional-slope
 * term and longer windows are the next steps, not a looser test.
 *
 * LIMITS, each said on the page: T_e is an EFFECTIVE thickness (a real plate yields and faults as
 * it bends, so it reads thinner than the cold lithosphere is thick); E, ν and the densities are
 * textbook constants (`ELASTIC`); the baked windows reach ~200 km from the trench, which is
 * short for old, stiff plates; the bathymetry is a 1.8 km grid of mostly predicted depth.
 */
import { nearestStep, stepFamily, FAMILY_STYLE, CLASS_FAMILY } from '../earth-interior/plates-model.js';
import { plateAt, velocityIn, STEP_CLASSES } from '../earth-interior/plates.js';
import { slabValueAt, downDip } from '../earth-interior/slabs.js';
import { section, destination, sampleDepth } from './bathy.js';

export { FAMILY_STYLE, CLASS_FAMILY, stepFamily };

/** Textbook constants (Turcotte & Schubert). The elastic thickness scales as E^(−1/3): ±30 % in E is ∓10 % in T_e. */
export const ELASTIC = Object.freeze({ E: 70e9, nu: 0.25, rhoMantle: 3300, rhoWater: 1030, g: 9.81 });
/** Past this distance a point is "mid-plate": the boundary is named but no trench is modelled. */
export const BOUNDARY_NEAR_KM = 200;
export const STACK = Object.freeze({ offsetsKm: [-40, -30, -20, -10, 0, 10, 20, 30, 40], minLines: 5, stepKm: 2, reachKm: 260 });
const SQRT2_EPI4 = Math.SQRT2 * Math.exp(Math.PI / 4);

/** The universal profile, in units of w_b: height above the undisturbed plate at ξ = (x − x₀)/(x_b − x₀). */
export function flexureShape(xi) { return SQRT2_EPI4 * Math.exp(-(Math.PI / 4) * xi) * Math.sin((Math.PI / 4) * xi); }
export function flexureHeight(xKm, { x0, xb, wb }) { return wb * flexureShape((xKm - x0) / (xb - x0)); }

/** Elastic thickness (km), rigidity (N m) and flexural parameter (km) from the outer-rise distance. */
export function elasticFromRise(x0Km, xbKm, k = ELASTIC) {
    const alphaM = 4 * (xbKm - x0Km) * 1000 / Math.PI;
    const D = alphaM ** 4 * (k.rhoMantle - k.rhoWater) * k.g / 4;
    return { alphaKm: alphaM / 1000, D, teKm: Math.cbrt(12 * (1 - k.nu * k.nu) * D / k.E) / 1000 };
}

/**
 * The plate setting of a point: the nearest PB2002 boundary step, who meets whom, and how fast.
 * `closing` is the convergence rate (mm/yr, ≥ 0 when the plates approach), `along` the strike-slip
 * part (+ right-lateral), `obliquityDeg` the angle of the relative motion from the boundary's
 * normal (0 = head-on, 90 = pure sliding).
 */
export function plateSetting(plates, lat, lon) {
    const n = nearestStep(plates, lat, lon);
    if (!n) return null;
    const m = n.motion, here = plateAt(plates.raster, lat, lon);
    const closing = -m.divergent;
    return {
        cls: n.step.cls, className: STEP_CLASSES[n.step.cls], family: n.family, km: n.km, near: n.km <= BOUNDARY_NEAR_KM,
        left: { id: n.step.left.id, name: n.step.left.name }, right: { id: n.step.right.id, name: n.step.right.name },
        down: n.down ? { id: n.down.id, name: n.down.name, index: n.down.index } : null,
        over: n.down ? (n.down === n.step.left ? { id: n.step.right.id, name: n.step.right.name } : { id: n.step.left.id, name: n.step.left.name }) : null,
        speed: m.speed, closing, along: m.rightLateral, obliquityDeg: Math.atan2(Math.abs(m.rightLateral), Math.abs(m.divergent)) * 180 / Math.PI,
        strikeDeg: m.azimuth, mid: m.mid, ageMa: n.step.ageMa, orogen: n.step.orogen,
        plateHere: here >= 0 ? { id: plates.plates[here].id, name: plates.plates[here].name } : null,
        // the downgoing plate's motion relative to the overriding one, as a compass bearing (the frame cancels)
        downBearingDeg: n.down ? ((n.down === n.step.left ? m.velAzimuth : m.velAzimuth + 180) % 360) : null,
        _step: n.step,
    };
}

/** Median of the finite values (null when fewer than `min`). */
function median(a, min = 1) { const v = a.filter((x) => x != null && Number.isFinite(x)).sort((p, q) => p - q); return v.length < min ? null : (v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2); }

/**
 * The stacked cross-trench profile through (lat, lon): the MEDIAN depth of parallel sections
 * offset along the trench axis. Returns [{ s (km, along acrossDeg), depth | null, n }].
 */
export function stackedSection(grid, lat, lon, axisDeg, acrossDeg, { offsetsKm = STACK.offsetsKm, minLines = STACK.minLines, stepKm = STACK.stepKm, reachKm = STACK.reachKm } = {}) {
    const n = Math.round(2 * reachKm / stepKm) + 1;
    const lines = offsetsKm.map((o) => { const p = o >= 0 ? destination(lat, lon, axisDeg, o) : destination(lat, lon, axisDeg + 180, -o); return section(grid, p.lat, p.lon, acrossDeg, reachKm, n); });
    const out = [];
    for (let k = 0; k < n; k++) {
        const vals = lines.map((L) => L[k].depth).filter((d) => d != null && d > 0);
        out.push({ s: lines[0][k].s, depth: median(vals, minLines), n: vals.length });
    }
    return out;
}

/** 2-parameter linear least squares y ≈ a + b·f. Returns { a, b, rms }. */
function lsq2(f, y) {
    let n = f.length, sf = 0, sy = 0, sff = 0, sfy = 0;
    for (let i = 0; i < n; i++) { sf += f[i]; sy += y[i]; sff += f[i] * f[i]; sfy += f[i] * y[i]; }
    const det = n * sff - sf * sf;
    if (Math.abs(det) < 1e-12) return null;
    const b = (n * sfy - sf * sy) / det, a = (sy - b * sf) / n;
    let ss = 0; for (let i = 0; i < n; i++) ss += (y[i] - a - b * f[i]) ** 2;
    return { a, b, rms: Math.sqrt(ss / n) };
}

/**
 * Fit the universal profile to a seaward profile [{ x (km from the trench axis, > 0 seaward), depth (m) }].
 * depth(x) = d_ref − w(x): (d_ref, w_b) by linear least squares for each (x₀, x_b) of a grid search.
 * Returns { x0, xb, wb, dRef, rms, flatRms, lineRms, gain, quality, reasons, reachKm, n, elastic } or null.
 */
export function fitFlexure(profile, { x0Range = [0, 110], riseRange = [16, 130], stepKm = 2, minPoints = 30, minReachKm = 110 } = {}) {
    const pts = profile.filter((p) => p.depth != null && p.x >= 0).sort((a, b) => a.x - b.x);
    if (pts.length < minPoints) return null;
    const x = pts.map((p) => p.x), y = pts.map((p) => p.depth), reachKm = x[x.length - 1];
    if (reachKm < minReachKm) return null;
    let best = null;
    for (let x0 = x0Range[0]; x0 <= x0Range[1]; x0 += stepKm) for (let L = riseRange[0]; L <= riseRange[1]; L += stepKm) {
        const f = x.map((v) => -flexureShape((v - x0) / L));
        const r = lsq2(f, y);
        if (!r || !(r.b > 0)) continue;                      // w_b must be a RISE
        if (!best || r.rms < best.rms) best = { x0, xb: x0 + L, wb: r.b, dRef: r.a, rms: r.rms };
    }
    if (!best) return null;
    const mean = y.reduce((a, b) => a + b, 0) / y.length;
    const flatRms = Math.sqrt(y.reduce((a, v) => a + (v - mean) ** 2, 0) / y.length);
    const line = lsq2(x, y), lineRms = line.rms;
    const reasons = [];
    if (best.rms > 0.6 * lineRms) reasons.push('no-better-than-a-slope');
    if (best.xb > reachKm - 10) reasons.push('rise-outside-the-data');
    if (best.wb < 50) reasons.push('no-rise');
    if (best.wb > 1500) reasons.push('rise-implausibly-high');
    if (best.x0 >= x0Range[1] || best.xb - best.x0 >= riseRange[1] || best.xb - best.x0 <= riseRange[0]) reasons.push('at-search-bound');
    // THE RISE MUST BE SEEN, not just fitted: the sea floor beyond it has to come back down to the
    // undisturbed level the fit assumed, and the rise has to stand clear of the misfit. Measured on the
    // real windows: without these two tests Mariana (seamounts shoal the far field by 1 km) and Tonga
    // (no rise in the stack at all) both passed as 'good' with a 230–630 m "rise".
    const L = best.xb - best.x0, far = pts.filter((q) => q.x >= best.xb + L).map((q) => q.depth).sort((u, v) => u - v);
    const farDepth = far.length >= 8 ? far[far.length >> 1] : null;
    if (farDepth == null) reasons.push('far-field-not-in-the-data');
    else if (Math.abs(farDepth - best.dRef) > 0.4 * best.wb) reasons.push('far-field-not-level');
    if (best.wb < 1.5 * best.rms) reasons.push('rise-within-the-scatter');
    return { ...best, farDepth, flatRms, lineRms, gain: 1 - best.rms / lineRms, quality: reasons.length ? 'poor' : 'good', reasons, reachKm, n: pts.length, elastic: elasticFromRise(best.x0, best.xb) };
}

/**
 * Everything about the trench at a detail's sounding point.
 * @param plates   decodePlates() model           @param slabs  decodeSlabs() model (may be null)
 * @param detail   page-model siteDetail (uses point, axis, sectionAzimuth)
 */
export function trenchModel({ plates, slabs = null, grid, detail }) {
    if (!plates || !detail || !detail.point) return null;
    const p = detail.point, setting = plateSetting(plates, p.lat, p.lon);
    if (!setting) return null;
    const out = { setting, flexure: null, profile: null, seawardSign: null, slab: null, why: null };
    const axis = detail.axis;
    if (!setting.near) { out.why = 'mid-plate'; return out; }
    if (!axis || !axis.defined) { out.why = 'no-axis'; return out; }
    const across = axis.acrossDeg;
    // ── the subducted plate under the landward side (Slab2), along the same line, at any distance ──
    const sideOf = (sign) => { const q = sign > 0 ? destination(p.lat, p.lon, across, 90) : destination(p.lat, p.lon, across + 180, 90); return plateAt(plates.raster, q.lat, q.lon); };
    let seaward = null;
    if (setting.down) { const a = sideOf(+1), b = sideOf(-1); if (a === setting.down.index && b !== a) seaward = +1; else if (b === setting.down.index && a !== b) seaward = -1; }
    out.seawardSign = seaward;
    if (slabs && seaward) {
        const pts = []; let slab = null;
        for (let d = 0; d <= 600; d += 10) {
            const q = seaward > 0 ? destination(p.lat, p.lon, across + 180, d) : destination(p.lat, p.lon, across, d);
            let hit = null;
            for (const s of slabs.slabs) { const v = slabValueAt(s, q.lat, q.lon); if (v != null && (!hit || v < hit.depthKm)) hit = { s, depthKm: v }; }
            if (hit && !slab) slab = hit.s;
            pts.push({ x: -d, lat: q.lat, lon: q.lon, depthKm: hit && hit.s === slab ? hit.depthKm : null });
        }
        if (slab) {
            const at = (dep) => pts.find((q) => q.depthKm != null && q.depthKm >= dep);
            const p50 = at(50), p100 = at(100), dip = p100 && downDip(slab, p100.lat, p100.lon);
            out.slab = { code: slab.code, name: slab.name, profile: pts, reaches100AtKm: p100 ? -p100.x : null, reaches50AtKm: p50 ? -p50.x : null,
                dipDeg: dip ? dip.dipDeg : null, dipAzimuthDeg: dip ? dip.azimuthDeg : null, maxDepthKm: slab.maxDepthKm };
        }
    }
    if (setting.cls !== 'SUB' || !setting.down) { out.why = 'not-subduction'; return out; }
    if (!seaward) { out.why = 'side-unknown'; return out; }
    // ── the bending plate: stacked profile on the downgoing side, measured from the trench axis ──
    const stack = stackedSection(grid, p.lat, p.lon, axis.azimuthDeg, across);
    const near = stack.filter((q) => q.depth != null && Math.abs(q.s) <= 40);
    if (!near.length) { out.why = 'no-profile'; return out; }
    const axisS = near.reduce((a, q) => (q.depth > a.depth ? q : a)).s;
    out.profile = stack.map((q) => ({ x: (q.s - axisS) * seaward, depth: q.depth, n: q.n }));
    out.flexure = fitFlexure(out.profile);
    if (!out.flexure) out.why = 'profile-too-short';
    return out;
}

/** One line per site for the table: closing rate and elastic thickness where the fit is good. */
export function trenchSummary(tm) {
    if (!tm) return null;
    const s = tm.setting, f = tm.flexure;
    return { family: s.family, cls: s.cls, closing: s.near ? s.closing : null, km: s.km, teKm: f && f.quality === 'good' ? f.elastic.teKm : null, riseM: f && f.quality === 'good' ? f.wb : null };
}

/** A short plain-language line for how the plates move at a setting ("77 mm/yr closing"). */
export function motionLabel(s) {
    if (!s) return null;
    if (!s.near) return { text: 'mid-plate', detail: `nearest boundary ${Math.round(s.km).toLocaleString('en-US')} km away` };
    const r = (v) => `${Math.round(Math.abs(v))} mm/yr`;
    if (s.family === 'spreading') return { text: `${r(s.closing)} opening`, detail: s.className };
    if (s.family === 'sliding' || s.obliquityDeg > 70) return { text: `${r(s.along)} sliding`, detail: s.className };
    return { text: `${r(s.closing)} closing`, detail: s.className };
}

/** Boundary steps as plain segments for a renderer: [{ lat1, lon1, lat2, lon2, family }]. */
export function boundarySegments(plates) {
    return plates.steps.map((st) => ({ lat1: st.lat1, lon1: st.lon1, lat2: st.lat2, lon2: st.lon2, family: CLASS_FAMILY[st.cls] }));
}
