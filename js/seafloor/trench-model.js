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
 * `fitFlexure` fits (x₀, x_b, w_b), the undisturbed depth AND A REGIONAL SLOPE to the OBSERVED
 * bathymetry: a STACK (median of parallel sections — one section is at the mercy of a single
 * seamount) on the downgoing plate's side, which is decided by the plate raster, never by which
 * side looks deeper. At the baked trench sites the stack runs 520 km seaward: the 1′ window near
 * the trench, the WIDE 2′ window (`<id>.wide.bin.gz`, ±5°) beyond it, and `profile[].src` says
 * which fed each point. Every fit is scored against two CONTROLS on the same points — a flat sea
 * floor and a straight tilted one — and reports `quality`: a fit whose outer rise is not inside
 * the data, does not stand clear of the scatter, is not followed by sea floor back on the fitted
 * reference, needs a slope no cooling plate has, or CHANGES when the farthest quarter of the
 * profile is left out, is 'poor' and the page prints no elastic thickness for it.
 *
 * MEASURED on the 28 baked windows (2026-11-22), in two steps:
 *   · level floor, 220 km windows (the first model): 3 of 15 subduction sites passed (Izu–Bonin,
 *     Java, Hellenic) — and the level-floor thickness turned out to GROW with the length of
 *     profile used (Izu–Bonin 14.6 → 24.5 km from 220 to 520 km, Kuril 12.4 → 23.2).
 *   · slope fitted, 520 km: 3 of 15 pass, and they are not the same three — Kuril (12 km, which
 *     could not be fitted at all before), Izu–Bonin (12 km) and Aleutian (27 km) hold; Java and
 *     Hellenic are gone. Mariana (seamounts), Tonga, Japan, Kermadec, Philippine (a rise no
 *     bigger than the scatter) are still rejected. The count did not rise; the answers stopped
 *     depending on the window.
 * The slope costs precision on a SHORT profile, where it trades off against the rise (planted
 * plate, 250 km: thickness off by up to ~15 %; 520 km: exact) — it needs the long window.
 * NEXT, not a looser test: masking seamounts in the stack, and a fit of several profiles along
 * each trench instead of one.
 *
 * LIMITS, each said on the page: T_e is an EFFECTIVE thickness (a real plate yields and faults as
 * it bends, so it reads thinner than the cold lithosphere is thick); E, ν and the densities are
 * textbook constants (`ELASTIC`); the regional slope is ONE straight line over 500 km; the
 * bathymetry is a 1.8–3.7 km grid of mostly predicted depth; nothing here has been checked
 * against published thicknesses for these trenches.
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
export const STACK = Object.freeze({ offsetsKm: [-40, -30, -20, -10, 0, 10, 20, 30, 40], minLines: 5, stepKm: 2, reachKm: 260, wideReachKm: 520 });
/** A regional slope steeper than this is not a cooling plate's (young fast-subsiding sea floor is ~2 m/km): the fit is refused. */
export const SLOPE_MAX_M_PER_KM = 3;
/** The reach test: refit on this fraction of the profile; the thickness may move by at most this share. */
export const STABILITY = Object.freeze({ fraction: 0.75, teTolerance: 0.25 });
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

/** 3-parameter linear least squares y ≈ a + s·x + b·f (normal equations, centred). Returns { a, s, b, rms } or null. */
function lsq3(x, f, y) {
    const n = x.length; let mx = 0, mf = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; mf += f[i]; my += y[i]; } mx /= n; mf /= n; my /= n;
    let sxx = 0, sff = 0, sxf = 0, sxy = 0, sfy = 0;
    for (let i = 0; i < n; i++) { const dx = x[i] - mx, df = f[i] - mf, dy = y[i] - my; sxx += dx * dx; sff += df * df; sxf += dx * df; sxy += dx * dy; sfy += df * dy; }
    const det = sxx * sff - sxf * sxf;
    if (!(det > 1e-9 * sxx * sff)) return null;                 // the shape is indistinguishable from a straight line on these points
    const sl = (sxy * sff - sfy * sxf) / det, b = (sfy * sxx - sxy * sxf) / det, a = my - sl * mx - b * mf;
    let ss = 0; for (let i = 0; i < n; i++) ss += (y[i] - a - sl * x[i] - b * f[i]) ** 2;
    return { a, s: sl, b, rms: Math.sqrt(ss / n) };
}

/** The undisturbed sea floor of a fit at x (m): the level, plus the regional slope when one was fitted. */
export function flexureReference(xKm, f) { return f.dRef + (f.slope || 0) * xKm; }

/**
 * Fit the universal profile to a seaward profile [{ x (km from the trench axis, > 0 seaward), depth (m) }].
 *
 *     depth(x) = d_ref + slope·x − w(x)
 *
 * (d_ref, slope, w_b) by linear least squares for each (x₀, x_b) of a grid search. THE REGIONAL SLOPE
 * (m of depth per km seaward) is the plate's own tilt — sea floor deepens with age, and most plates reach
 * their trench at an angle to their isochrons — and without it a tilted plate fails "far field not level"
 * however clean its rise is. `slope: false` is the level-floor law shipped first, kept as the A/B and the
 * gate's negative control. With a slope in the model the straight-line control is NESTED in it (w_b = 0),
 * so the tests that carry the weight are the ones on the RISE: it must stand clear of the scatter, lie
 * inside the data, and be followed by sea floor back on the fitted reference.
 *
 * AND THE ANSWER MUST NOT DEPEND ON WHERE THE DATA STOP (`STABILITY`): the fit is repeated on the nearest
 * three quarters of the profile, and a thickness that moves by more than a quarter — or a refit that finds
 * no rise at all — is 'not-stable-with-reach'. MEASURED on the baked windows (2026-11-22), this is what
 * the slope term buys: with a level floor the Izu–Bonin thickness read 14.6 km on 220 km of sea floor and
 * 24.5 km on 520 km (Kuril 12.4 → 23.2), because the fit paid for the plate's tilt with a taller, wider
 * rise; with the slope fitted the same two trenches read 14.6 → 12.4 and 13.5 → 12.4. It also REMOVED two
 * earlier passes (Java, Hellenic), which held only on a level floor and only on the short window.
 * `teRange` is the spread of the two fits — a floor on the uncertainty, not a confidence interval.
 * Returns { x0, xb, wb, dRef, slope, rms, flatRms, lineRms, gain, quality, reasons, reachKm, n, elastic, teRange, stability } or null.
 */
export function fitFlexure(profile, opts = {}) {
    const full = fitOnce(profile, opts);
    if (!full) return null;
    const frac = opts.stability === undefined ? STABILITY.fraction : opts.stability;
    full.teRange = [full.elastic.teKm, full.elastic.teKm]; full.stability = null;
    if (!frac) return full;
    const near = fitOnce(profile.filter((p) => p.x <= frac * full.reachKm), opts);
    if (!near) { full.stability = { reachKm: frac * full.reachKm, teKm: null, ok: false }; full.reasons.push('not-stable-with-reach'); }
    else {
        const a = full.elastic.teKm, b = near.elastic.teKm, rise = near.wb >= 50 && near.wb >= 1.5 * near.rms;
        const ok = rise && Math.abs(a - b) <= STABILITY.teTolerance * Math.max(a, b);
        full.stability = { reachKm: near.reachKm, teKm: b, wb: near.wb, slope: near.slope, ok };
        full.teRange = [Math.min(a, b), Math.max(a, b)];
        if (!ok) full.reasons.push('not-stable-with-reach');
    }
    full.quality = full.reasons.length ? 'poor' : 'good';
    return full;
}

function fitOnce(profile, { x0Range = [0, 110], riseRange = [16, 130], stepKm = 2, minPoints = 30, minReachKm = 110, slope = true } = {}) {
    const pts = profile.filter((p) => p.depth != null && p.x >= 0).sort((a, b) => a.x - b.x);
    if (pts.length < minPoints) return null;
    const x = pts.map((p) => p.x), y = pts.map((p) => p.depth), reachKm = x[x.length - 1];
    if (reachKm < minReachKm) return null;
    let best = null;
    for (let x0 = x0Range[0]; x0 <= x0Range[1]; x0 += stepKm) for (let L = riseRange[0]; L <= riseRange[1]; L += stepKm) {
        const f = x.map((v) => -flexureShape((v - x0) / L));
        const r = slope ? lsq3(x, f, y) : lsq2(f, y);
        if (!r || !(r.b > 0)) continue;                      // w_b must be a RISE
        if (!best || r.rms < best.rms) best = { x0, xb: x0 + L, wb: r.b, dRef: r.a, slope: slope ? r.s : 0, rms: r.rms };
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
    if (Math.abs(best.slope) > SLOPE_MAX_M_PER_KM) reasons.push('slope-implausible');
    if (best.x0 >= x0Range[1] || best.xb - best.x0 >= riseRange[1] || best.xb - best.x0 <= riseRange[0]) reasons.push('at-search-bound');
    // THE RISE MUST BE SEEN, not just fitted: the sea floor beyond it has to come back to the undisturbed
    // reference the fit assumed, and the rise has to stand clear of the misfit. Measured on the real
    // windows: without these two tests Mariana (seamounts shoal the far field by 1 km) and Tonga (no rise
    // in the stack at all) both passed as 'good' with a 230–630 m "rise".
    const L = best.xb - best.x0, far = pts.filter((q) => q.x >= best.xb + L).map((q) => q.depth - flexureReference(q.x, best)).sort((u, v) => u - v);
    const farOffset = far.length >= 8 ? far[far.length >> 1] : null;
    if (farOffset == null) reasons.push('far-field-not-in-the-data');
    else if (Math.abs(farOffset) > 0.4 * best.wb) reasons.push('far-field-not-level');
    if (best.wb < 1.5 * best.rms) reasons.push('rise-within-the-scatter');
    return { ...best, farOffset, farDepth: farOffset == null ? null : best.dRef + farOffset, flatRms, lineRms, gain: 1 - best.rms / lineRms, quality: reasons.length ? 'poor' : 'good', reasons, reachKm, n: pts.length, elastic: elasticFromRise(best.x0, best.xb) };
}

/**
 * Everything about the trench at a detail's sounding point.
 * @param plates   decodePlates() model           @param slabs  decodeSlabs() model (may be null)
 * @param detail   page-model siteDetail (uses point, axis, sectionAzimuth)
 * @param wide     optional coarser, WIDER grid of the same sea floor (the baked `<id>.wide` window): it supplies
 *                 the profile only where the fine grid has run out, and `profile[].src` says which fed each point
 * @param fit      options passed to fitFlexure (`{ slope: false }` is the level-floor A/B)
 */
export function trenchModel({ plates, slabs = null, grid, detail, wide = null, fit = {} }) {
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
    let stack = stackedSection(grid, p.lat, p.lon, axis.azimuthDeg, across).map((q) => ({ ...q, src: 'fine' }));
    if (wide) {
        const far = stackedSection(wide, p.lat, p.lon, axis.azimuthDeg, across, { reachKm: STACK.wideReachKm }), byS = new Map(stack.map((q) => [Math.round(q.s), q]));
        stack = far.map((q) => { const f = byS.get(Math.round(q.s)); return f && f.depth != null ? f : { ...q, src: 'wide' }; });
    }
    out.wide = !!wide;
    const near = stack.filter((q) => q.depth != null && Math.abs(q.s) <= 40);
    if (!near.length) { out.why = 'no-profile'; return out; }
    const axisS = near.reduce((a, q) => (q.depth > a.depth ? q : a)).s;
    out.profile = stack.map((q) => ({ x: (q.s - axisS) * seaward, depth: q.depth, n: q.n, src: q.src }));
    out.flexure = fitFlexure(out.profile, fit);
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
