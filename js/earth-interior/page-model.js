/**
 * page-model.js — everything earth-interior.html DRAWS, as pure numbers.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no fetch. Gate: `tests/earth-interior-page.mjs`.
 * The stage (js/earth-interior/stage.js) and the panels (page.js) compute
 * nothing; every value they show comes from here, and everything here comes
 * from the kernels (prem.js, conductivity.js, geoelectric.js, raytrace.js) — never a
 * retyped number. Layer radii are READ from PREM_REGIONS; the cutaway's
 * colour table is SAMPLED from premAt; the column charts are the same
 * layeredImpedance the nowcast uses.
 *
 * Colour: magnitudes use ONE sequential hue (the reference blue ramp,
 * validated on the page surface #0b1322: monotone L, 2.29:1 at the dark end).
 * Two-series charts use categorical slots 1–2 (blue #3987e5, orange #d95926;
 * CVD ΔE 26.8 on #0b1322). Status colours are not used for data.
 */

import { R_EARTH_KM, PREM_REGIONS, premAt, gravityMS2, pressureGPa } from './prem.js';
import { sigmaAt, impedanceSummary, MU0 } from './conductivity.js';
import { groundColumn, groundColumnInfo, GROUND_COLUMN_IDS, TPL007_BETA } from './geoelectric.js';
import { travelTimeBranches, rayPath, maxRayParameter, arrivalsAt as rtArrivals } from './raytrace.js';

// ── Colour ─────────────────────────────────────────────────────────────────

/** Reference sequential blue, dark (low) → light (high) for a dark page. */
export const SEQ_RAMP = Object.freeze(['#104281', '#184f95', '#256abf', '#3987e5', '#6da7ec', '#9ec5f4', '#cde2fb']);
export const SERIES = Object.freeze({ one: '#3987e5', two: '#d95926' });
export const SURFACE = '#0b1322';

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** t ∈ [0,1] → [r,g,b] 0–255, piecewise linear through SEQ_RAMP. Out of range clamps. */
export function rampColor(t, ramp = SEQ_RAMP) {
    const x = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (ramp.length - 1);
    const i = Math.min(ramp.length - 2, Math.floor(x)), f = x - i;
    const a = hexRgb(ramp[i]), b = hexRgb(ramp[i + 1]);
    return a.map((v, k) => Math.round(v + (b[k] - v) * f));
}

// ── Quantities ─────────────────────────────────────────────────────────────

/** What the cutaway can show. `at(rKm)` is the kernel's own value. */
export const QUANTITIES = Object.freeze({
    vp:    { label: 'P-wave speed', short: 'Vp', unit: 'km/s', log: false, source: 'PREM',
             at: (r) => premAt(r).vpKmS },
    vs:    { label: 'S-wave speed', short: 'Vs', unit: 'km/s', log: false, source: 'PREM',
             at: (r) => premAt(r).vsKmS },
    rho:   { label: 'Density', short: 'Density', unit: 'g/cm³', log: false, source: 'PREM',
             at: (r) => premAt(r).rhoKgM3 / 1000 },
    p:     { label: 'Pressure', short: 'Pressure', unit: 'GPa', log: false, source: 'PREM (hydrostatic)',
             at: (r) => pressureGPa(r) },
    g:     { label: 'Gravity', short: 'Gravity', unit: 'm/s²', log: false, source: 'PREM',
             at: (r) => gravityMS2(r) },
    sigma: { label: 'Electrical conductivity', short: 'Conductivity', unit: 'S/m', log: true, source: 'Grayver et al. 2017 (global average)',
             at: (r) => sigmaAt(R_EARTH_KM - r) },
});
export const QUANTITY_KEYS = Object.freeze(Object.keys(QUANTITIES));

/** Value of a quantity at radius r (km). Never clamped; out of range → NaN. */
export function quantityAt(key, rKm) {
    const q = QUANTITIES[key];
    if (!q || !(rKm >= 0 && rKm <= R_EARTH_KM)) return NaN;
    return q.at(rKm);
}

/**
 * The cutaway's radial colour table: `n` texels, texel i at the CENTRE of
 * [i/n, (i+1)/n]·R. Returns { rgb: Uint8Array(3n), min, max, log, values }.
 * The scale's extremes are the table's own, so the legend and the faces
 * cannot disagree. A log quantity is mapped on log10.
 */
export function radialTable(key, n = 1024) {
    const q = QUANTITIES[key];
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) values[i] = quantityAt(key, (i + 0.5) / n * R_EARTH_KM);
    const tr = (v) => (q.log ? Math.log10(v) : v);
    let lo = Infinity, hi = -Infinity;
    for (const v of values) { const t = tr(v); if (Number.isFinite(t)) { lo = Math.min(lo, t); hi = Math.max(hi, t); } }
    const rgb = new Uint8Array(3 * n);
    for (let i = 0; i < n; i++) {
        const c = rampColor((tr(values[i]) - lo) / (hi - lo || 1));
        rgb.set(c, 3 * i);
    }
    return { rgb, values, n, min: q.log ? 10 ** lo : lo, max: q.log ? 10 ** hi : hi, log: q.log };
}

/** Legend ticks for a table: 5 values (log-spaced for a log quantity). */
export function legendTicks(table, count = 5) {
    const out = [];
    for (let i = 0; i < count; i++) {
        const f = i / (count - 1);
        const v = table.log ? 10 ** (Math.log10(table.min) + f * (Math.log10(table.max) - Math.log10(table.min)))
                            : table.min + f * (table.max - table.min);
        out.push({ f, v });
    }
    return out;
}

// ── Layers (radii READ from the kernel) ────────────────────────────────────

const BAND_OF = Object.freeze({
    'Inner core': 'Inner core', 'Outer core': 'Outer core',
    'D″': 'Lower mantle', 'Lower mantle': 'Lower mantle', 'Top lower mantle': 'Lower mantle',
    'Transition zone 670–600': 'Transition zone', 'Transition zone 600–400': 'Transition zone',
    'Transition zone 400–220': 'Upper mantle', 'Low-velocity zone': 'Upper mantle', 'Lid': 'Upper mantle',
    'Lower crust': 'Crust', 'Upper crust': 'Crust', 'Ocean': 'Ocean',
});

/** Named display bands, centre → surface, with radii from PREM_REGIONS. */
export const LAYER_BANDS = Object.freeze((() => {
    const out = [];
    for (const g of PREM_REGIONS) {
        const name = BAND_OF[g.name];
        if (!name) throw new Error(`page-model: PREM region ${g.name} has no display band`);
        const last = out[out.length - 1];
        if (last && last.name === name) last.rOuterKm = g.rOuterKm;
        else out.push({ name, rInnerKm: g.rInnerKm, rOuterKm: g.rOuterKm, state: g.state });
    }
    return out.map((b) => Object.freeze({ ...b, topDepthKm: R_EARTH_KM - b.rOuterKm, bottomDepthKm: R_EARTH_KM - b.rInnerKm }));
})());

/** Radii (km) of the boundaries drawn as lines on the cut faces (not the surface). */
export const BOUNDARY_RADII_KM = Object.freeze(LAYER_BANDS.slice(0, -1).map((b) => b.rOuterKm));

export function bandAt(rKm) {
    return LAYER_BANDS.find((b) => rKm >= b.rInnerKm && rKm <= b.rOuterKm) ?? null;
}

/** The probe readout at radius r: every quantity + the band. */
export function probeAt(rKm) {
    if (!(rKm >= 0 && rKm <= R_EARTH_KM)) return null;
    const p = premAt(rKm);
    return {
        rKm, depthKm: R_EARTH_KM - rKm, band: bandAt(rKm)?.name ?? p.region, region: p.region, state: p.state,
        vpKmS: p.vpKmS, vsKmS: p.vsKmS, rhoGcc: p.rhoKgM3 / 1000,
        gMS2: gravityMS2(rKm), pGPa: pressureGPa(rKm), sigmaSm: sigmaAt(R_EARTH_KM - rKm),
    };
}

// ── Profile charts (depth on the vertical axis, small multiples) ───────────

/**
 * Depth profile of one or two quantities, with BOTH sides of every PREM jump
 * so a step draws as a step. Returns [{ depthKm, values: {key: v} }].
 */
export function profileSeries(keys, step = 10) {
    const pts = [];
    const jumpsR = PREM_REGIONS.slice(1).map((g) => g.rInnerKm);
    const depths = new Set();
    for (let d = 0; d <= R_EARTH_KM; d += step) depths.add(d);
    depths.add(R_EARTH_KM);
    const sorted = [...depths].sort((a, b) => a - b);
    const sample = (rKm, side) => {
        const out = {};
        for (const k of keys) {
            if (k === 'sigma') out[k] = sigmaAt(R_EARTH_KM - rKm);
            else if (k === 'p' || k === 'g') out[k] = quantityAt(k, rKm);
            else { const p = premAt(rKm, { side }); out[k] = k === 'rho' ? p.rhoKgM3 / 1000 : k === 'vp' ? p.vpKmS : p.vsKmS; }
        }
        return out;
    };
    const jumpDepths = new Set(jumpsR.map((rb) => R_EARTH_KM - rb));
    // A grid depth that IS a jump is drawn by the two edge points only — a
    // third, single-sided sample between them is a redundant vertex (gated).
    for (const d of sorted) if (!jumpDepths.has(d)) pts.push({ depthKm: d, values: sample(R_EARTH_KM - d, 'below') });
    for (const rb of jumpsR) {
        const d = R_EARTH_KM - rb;
        pts.push({ depthKm: d, values: sample(rb, 'above'), edge: 'top' });
        pts.push({ depthKm: d, values: sample(rb, 'below'), edge: 'bottom' });
    }
    // Shallow side first at a shared depth, so a polyline steps across the jump.
    return pts.sort((a, b) => a.depthKm - b.depthKm || ((a.edge === 'top' ? 0 : a.edge === 'bottom' ? 2 : 1) - (b.edge === 'top' ? 0 : b.edge === 'bottom' ? 2 : 1)));
}

// ── The nowcast table ──────────────────────────────────────────────────────

/** Rows for the station table, strongest field first. Nulls are kept, never zeroed. */
export function nowcastRows(nowcast) {
    if (!nowcast?.stations) return [];
    return nowcast.stations.map((s) => ({
        code: s.code, name: s.name, lat: s.geodeticLatitude, lon: s.geodeticLongitude,
        geomagLatDeg: s.geomagLatDeg,
        eLatestVkm: s.latest?.eMagVkm ?? null, eNorthVkm: s.latest?.eNorthVkm ?? null, eEastVkm: s.latest?.eEastVkm ?? null,
        time: s.latest?.time ?? null, warmup: !!s.latest?.warmup, bridged: !!s.latest?.bridged,
        peakVkm: s.peakLastHourVkm, columnId: s.column.id, columnName: s.column.name, columnBasis: s.column.basis,
        benchmarkVkm: s.tpl007?.benchmarkVkm ?? null, overBenchmark: s.tpl007?.latestOverBenchmark ?? null,
        spark: s.series.eMagVkm,
    })).sort((a, b) => (b.eLatestVkm ?? -1) - (a.eLatestVkm ?? -1));
}

/** Sparkline points: the last `n` minutes, nulls as gaps (null), x 0–1, y 0–1 of the row's own max. */
export function sparkline(values, n = 720) {
    const v = values.slice(-n);
    const max = Math.max(0, ...v.filter((x) => Number.isFinite(x)));
    return { max, points: v.map((x, i) => (Number.isFinite(x) ? [v.length > 1 ? i / (v.length - 1) : 0, max > 0 ? x / max : 0] : null)) };
}

// ── The ground-column panel ────────────────────────────────────────────────

/** Column layers to `maxDepthKm` for a step chart: [{ topKm, bottomKm, sigma }]. */
export function columnSteps(id, maxDepthKm = 1000) {
    const L = groundColumn(id);
    if (!L) return null;
    const out = []; let top = 0;
    for (const l of L) {
        const bottom = Number.isFinite(l.thicknessM) ? top + l.thicknessM / 1000 : Infinity;
        out.push({ topKm: top, bottomKm: Math.min(bottom, maxDepthKm), sigma: l.sigma });
        if (bottom >= maxDepthKm) break;
        top = bottom;
    }
    return out;
}

/** |E| (V/km) per 100 nT of steady oscillation vs period, for a column. */
export const RESPONSE_PERIODS_S = Object.freeze(Array.from({ length: 41 }, (_, i) => 10 * Math.pow(8640, i / 40)));
export function responseCurve(id, bNT = 100) {
    const L = groundColumn(id);
    if (!L) return null;
    return RESPONSE_PERIODS_S.map((T) => {
        const z = impedanceSummary(L, T);
        return { periodS: T, eVkm: z.magOhm * (bNT * 1e-9 / MU0) * 1e3, phaseDeg: z.phaseDeg };
    });
}

/** The column picker's options, grouped by provenance, with the TPL-007 β where tabulated. */
export function columnOptions() {
    return GROUND_COLUMN_IDS.map((id) => {
        const info = groundColumnInfo(id);
        return { id, name: info.name, kind: info.kind, tier: info.tier, beta: TPL007_BETA[id]?.[0] ?? null };
    });
}

// ── Formatting (the ONE place numbers become strings) ──────────────────────

export function fmt(v, digits = 3) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-3 || a >= 1e5)) {
        const [m, e] = v.toExponential(digits - 1).split('e');
        const sup = String(Number(e)).replace(/[-0-9]/g, (c) => '⁻⁰¹²³⁴⁵⁶⁷⁸⁹'['-0123456789'.indexOf(c)]);
        return `${m}×10${sup}`;
    }
    return Number(v.toPrecision(digits)).toLocaleString('en-US', { maximumSignificantDigits: digits });
}

// ── Seismic rays (INNER_EARTH_PLAN.md §10 T1) ──────────────────────────────
// The ray tracer is the one in raytrace.js; this only lays its output out.
// Phase colours are categorical slots 1–3 (blue / orange / aqua), validated
// all-pairs on #0b1322: CVD ΔE 9.4 worst, normal-vision 20.9 — every curve is
// also direct-labelled, so colour is never the only key.


export const PHASE_FAMILY = Object.freeze({ P: 'mantle', S: 'mantle', PKP: 'outer', PKiKP: 'outer', PKIKP: 'inner' });
export const FAMILY_COLORS = Object.freeze({ mantle: '#3987e5', outer: '#d95926', inner: '#199e70' });
export const FAMILY_LABELS = Object.freeze({
    mantle: 'Turns in the mantle', outer: 'Through the liquid outer core', inner: 'Through the solid inner core',
});
export const SOURCE_DEPTHS_KM = Object.freeze([0, 100, 300, 600]);

const FAN_CACHE = new Map(), TT_CACHE = new Map();

/**
 * A ray fan from one source: rays at equal steps of TAKEOFF ANGLE (from the
 * downward vertical), drawn source-up. points are [x, y] km with the source at
 * (0, r_s): x = r sin θ, y = r cos θ.
 */
export function seismicFan({ wave = 'P', sourceDepthKm = 0, nRays = 46 } = {}) {
    const key = `${wave}|${sourceDepthKm}|${nRays}`;
    if (FAN_CACHE.has(key)) return FAN_CACHE.get(key);
    const pMax = maxRayParameter({ wave, sourceDepthKm });
    const rays = [];
    for (let i = 0; i < nRays; i++) {
        const takeoff = (i + 0.5) / nRays * (Math.PI / 2);
        const path = rayPath(pMax * Math.sin(takeoff), { wave, sourceDepthKm, maxPoints: 260 });
        if (!path) continue;
        const stopped = path.phase === 'S→core';
        // A stopped S ray is drawn only DOWN to the core: there is no way back.
        const pts = stopped ? path.points.slice(0, Math.ceil(path.points.length / 2)) : path.points;
        rays.push({
            p: path.p, takeoffDeg: takeoff / (Math.PI / 180), phase: path.phase, stopped,
            family: stopped ? 'mantle' : PHASE_FAMILY[path.phase], deltaDeg: stopped ? null : path.deltaDeg,
            timeS: stopped ? null : path.timeS,
            points: pts.map((q) => [q.rKm * Math.sin(q.thetaRad), q.rKm * Math.cos(q.thetaRad)]),
        });
    }
    const out = { wave, sourceDepthKm, rays };
    FAN_CACHE.set(key, out);
    return out;
}

/**
 * Travel-time curves T(Δ) per phase, in sweep order (caustics stay as cusps —
 * that is the triplication, not a drawing artefact), plus the SHADOW: the
 * distances no ray of this wave type reaches as the direct mantle phase.
 */
export function travelTimeCurves({ wave = 'P', sourceDepthKm = 0 } = {}) {
    const key = `${wave}|${sourceDepthKm}`;
    if (TT_CACHE.has(key)) return TT_CACHE.get(key);
    const branches = travelTimeBranches({ wave, sourceDepthKm, n: 1800 });
    const curves = Object.entries(branches).map(([phase, rays]) => ({
        phase, family: PHASE_FAMILY[phase],
        points: rays.map((r) => [r.deltaDeg, r.timeS]),
    }));
    const span = (ph) => { const c = curves.find((x) => x.phase === ph); if (!c) return null; const d = c.points.map((q) => q[0]); return [Math.min(...d), Math.max(...d)]; };
    const direct = span(wave);
    // P: the mantle phase ends and nothing arrives strongly until PKP's caustic.
    // S: no shear wave crosses the liquid core, so the shadow runs to 180°.
    const shadow = direct ? (wave === 'P' ? [direct[1], span('PKP')?.[0] ?? 180] : [direct[1], 180]) : null;
    const out = { wave, sourceDepthKm, branches, curves, shadow, maxTimeS: Math.max(...curves.flatMap((c) => c.points.map((q) => q[1]))) };
    TT_CACHE.set(key, out);
    return out;
}

/** Every arrival at a distance, earliest first: [{ phase, family, timeS, p }]. */
export function arrivalsAtDistance(deltaDeg, tt) {
    // Two crossings of the SAME phase within a second are one arrival seen on
    // either side of a micro-cusp in the sweep — reading them as two would
    // claim a triplication the ray density cannot resolve.
    const out = [];
    for (const a of rtArrivals(deltaDeg, tt.branches)) {
        if (out.some((b) => b.phase === a.phase && Math.abs(b.timeS - a.timeS) < 1)) continue;
        out.push({ ...a, family: PHASE_FAMILY[a.phase] });
    }
    return out;
}

/** "12 min 07 s" from seconds. */
export function fmtMinSec(s) {
    if (s === null || !Number.isFinite(s)) return '—';
    const m = Math.floor(s / 60), r = Math.round(s - 60 * m);
    return r === 60 ? `${m + 1} min 00 s` : `${m} min ${String(r).padStart(2, '0')} s`;
}
