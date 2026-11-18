/**
 * amplitude.js — how STRONG each phase is when it reaches the viewer, and the
 * station-elevation correction to its time. Pure kernel.
 * Gate: `tests/earth-interior-amplitude.mjs`. Plan: INNER_EARTH_PLAN.md §10.
 *
 * ── WHAT THE NUMBER IS ───────────────────────────────────────────────────
 * The far-field, ray-theory DISPLACEMENT amplitude of a phase at the station,
 * relative to the other phases of the same event:
 *
 *   u = R_c/(4π ρ_s v_s³) · √(ρ_s v_s / ρ_r v_r) · √(dΩ / (dS cos i_r)) · √(Π E_k) · e^(−π f t*)
 *
 *   · source: a point moment source in an isotropic solid (far-field term
 *     ∝ 1/ρv³), with the focal sphere's RMS radiation coefficient R_c
 *     (Boore & Boatwright 1984: P 0.52, S 0.63, split equally between SV and
 *     SH). The real event's focal mechanism is NOT known here, so a station on
 *     a nodal plane can see much less — disclosed.
 *   · geometric spreading from ENERGY CONSERVATION along a ray tube: the
 *     solid angle dΩ = sin i_s di_s dφ leaving the source lands on the
 *     surface patch dS = R² sinΔ dΔ dφ, seen at incidence i_r. In a uniform
 *     medium this is exactly 1/L (the gate's oracle); at a caustic (dΔ/di → 0)
 *     or at Δ ≈ 0°/180° ray theory's amplitude is infinite and is FLAGGED,
 *     never shown as a big number.
 *   · every interface the ray crosses or bounces off: ENERGY-normalised plane-
 *     wave coefficients E_k from the full P-SV Zoeppritz system (solid–solid,
 *     solid–liquid, liquid–solid, free surface; complex, so post-critical
 *     incidence and evanescent waves come out right) or the SH closed form.
 *     Phases recorded as pure shear (S, s, sS, SS, ScS) are taken as SH;
 *     anything that converts (sP, ScP, PcS, SKS…) is SV. Gate: energy is
 *     conserved at every interface type for every p — an identity the solver
 *     never imposes.
 *   · anelastic attenuation t* = ∫ dt / Q along the ray, Q from PREM's own
 *     Q_μ, Q_κ (Q_P⁻¹ = L/Q_μ + (1 − L)/Q_κ, L = ⁴⁄₃(β/α)²), at a reference
 *     frequency per recorded wave: 1 Hz for P, 0.2 Hz for S (the bands they
 *     are usually read in). Disclosed; a different band changes the ratio.
 *
 * NOT CLAIMED: the receiver's free-surface amplification (incident amplitude
 * is reported), site response, scattering, 3-D focusing, diffracted phases
 * (Pdiff/Sdiff have no ray-theory amplitude — null, with the reason), and
 * ABSOLUTE ground motion (no moment / source spectrum — relative only).
 *
 * ── STATION ELEVATION ────────────────────────────────────────────────────
 * PREM's surface is a sphere at sea level; a station h metres above it sits
 * on top of an extra layer whose speed is the uppermost crust's. To first
 * order the ray crosses it at its own slowness:
 *      δT = h · √(1/v_c² − (p/R)²)
 * (the vertical slowness — NOT h/v_c, which is wrong away from vertical
 * incidence; the gate's control). v_c is PREM's upper crust (5.8 / 3.2 km/s),
 * a stated choice: real near-surface rock is often slower.
 */

import { R_EARTH_KM, premAt, discontinuities } from './prem.js';
import { premPhaseModel, PHASE_INFO, DIFFRACTION_MAX_DEG } from './phases.js';

const DEG = Math.PI / 180;
export const RADIATION = Object.freeze({ P: 0.52, SV: 0.63 / Math.SQRT2, SH: 0.63 / Math.SQRT2 });
export const REF_FREQ_HZ = Object.freeze({ P: 1, S: 0.2 });
export const SH_PHASES = Object.freeze(new Set(['S', 's', 'sS', 'SS', 'ScS']));
/** Visibility classes (dB relative to the event's strongest arrival at this station). */
export const VISIBILITY = Object.freeze([
    { minDb: -12, label: 'strong' }, { minDb: -26, label: 'clear' }, { minDb: -40, label: 'weak' }, { minDb: -Infinity, label: 'very weak' },
]);

// ── complex arithmetic ─────────────────────────────────────────────────────
const C = (re, im = 0) => ({ re, im });
const add = (a, b) => C(a.re + b.re, a.im + b.im), sub = (a, b) => C(a.re - b.re, a.im - b.im);
const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a, b) => { const d = b.re * b.re + b.im * b.im; return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
const scale = (a, k) => C(a.re * k, a.im * k);
const abs2 = (a) => a.re * a.re + a.im * a.im;
/** √x for real x, on the branch with Im ≥ 0 (an evanescent wave DECAYS away from the interface). */
const csqrtReal = (x) => (x >= 0 ? C(Math.sqrt(x)) : C(0, Math.sqrt(-x)));

/** Gaussian elimination with partial pivoting on complex A x = b. */
function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
        let piv = c;
        for (let r = c + 1; r < n; r++) if (abs2(M[r][c]) > abs2(M[piv][c])) piv = r;
        [M[c], M[piv]] = [M[piv], M[c]];
        for (let r = c + 1; r < n; r++) {
            const f = div(M[r][c], M[c][c]);
            for (let k = c; k <= n; k++) M[r][k] = sub(M[r][k], mul(f, M[c][k]));
        }
    }
    const x = Array(n);
    for (let r = n - 1; r >= 0; r--) {
        let s = M[r][n];
        for (let k = r + 1; k < n; k++) s = sub(s, mul(M[r][k], x[k]));
        x[r] = div(s, M[r][r]);
    }
    return x;
}

/**
 * A plane wave of type 'P' or 'S' (SV) in medium m = { rho, vp, vs }, horizontal
 * slowness ph (s/km), going down (sgn +1, z positive down) or up (−1): its unit
 * displacement and the traction on a horizontal plane, as [ux, uz, tx, tz].
 */
function waveVector(m, type, ph, sgn) {
    const v = type === 'P' ? m.vp : m.vs;
    const q = csqrtReal(1 / (v * v) - ph * ph), s = scale(q, sgn);
    const dx = type === 'P' ? C(v * ph) : scale(s, v), dz = type === 'P' ? scale(s, v) : C(-v * ph);
    const mu = m.rho * m.vs * m.vs, lam = m.rho * (m.vp * m.vp - 2 * m.vs * m.vs);
    const tx = scale(add(mul(s, dx), scale(dz, ph)), mu);
    const tz = add(scale(add(scale(dx, ph), mul(s, dz)), lam), scale(mul(s, dz), 2 * mu));
    return { vec: [dx, dz, tx, tz], q, v };
}

const isFluid = (m) => !m || m.vs === 0;

/**
 * P-SV plane-wave coefficients for a wave of type `inc` ('P' | 'S') incident from
 * medium `from` onto medium `to` (null = vacuum: a free surface). Geometry is
 * always "incident travelling down from above" — a z-flip of any real
 * configuration, under which ENERGY coefficients are invariant.
 * Returns { R: {P, S}, T: {P, S} } as ENERGY fractions (0 where a wave cannot exist).
 */
export function psvCoefficients(inc, from, to, ph) {
    if (inc === 'S' && isFluid(from)) throw new Error('no S wave in a fluid');
    const unknowns = [['R', 'P', from, -1]];
    if (!isFluid(from)) unknowns.push(['R', 'S', from, -1]);
    if (to) { unknowns.push(['T', 'P', to, +1]); if (!isFluid(to)) unknowns.push(['T', 'S', to, +1]); }
    // Boundary conditions. Welded solids: u and t continuous. A fluid side: uz and t
    // continuous, ux free (tx is 0 on the fluid side ⇒ tx = 0 on the solid side). Vacuum: t = 0.
    const rows = !to ? [2, 3] : (isFluid(from) || isFluid(to) ? [1, 2, 3] : [0, 1, 2, 3]);
    const incW = waveVector(from, inc, ph, +1);
    const cols = unknowns.map(([side, type, m, sgn]) => ({ side, type, m, w: waveVector(m, type, ph, sgn) }));
    const A = rows.map((r) => cols.map((c) => (c.side === 'R' ? c.w.vec[r] : scale(c.w.vec[r], -1))));
    const b = rows.map((r) => scale(incW.vec[r], -1));
    const x = solve(A, b);
    const fluxIn = from.rho * incW.v * incW.v * incW.q.re;
    const out = { R: { P: 0, S: 0 }, T: { P: 0, S: 0 } };
    cols.forEach((c, i) => { out[c.side][c.type] = c.m.rho * c.w.v * c.w.v * c.w.q.re * abs2(x[i]) / fluxIn; });
    return out;
}

/** SH coefficients (energy) from solid `from` onto `to` (fluid or null ⇒ total reflection). */
export function shCoefficients(from, to, ph) {
    const q1 = csqrtReal(1 / (from.vs * from.vs) - ph * ph);
    if (isFluid(to)) return { R: 1, T: 0 };
    const q2 = csqrtReal(1 / (to.vs * to.vs) - ph * ph);
    const z1 = scale(q1, from.rho * from.vs * from.vs), z2 = scale(q2, to.rho * to.vs * to.vs);
    const R = div(sub(z1, z2), add(z1, z2)), T = div(scale(z1, 2), add(z1, z2));
    return { R: abs2(R), T: z2.re > 0 && q1.re > 0 ? abs2(T) * z2.re / z1.re : 0 };
}

// ── PREM's interfaces ──────────────────────────────────────────────────────
const asMedium = (s) => ({ rho: s.rhoKgM3, vp: s.vpKmS, vs: s.vsKmS });
/** First-order discontinuities the seismic model actually has (no ocean: its shells end in crust). */
export const INTERFACES = Object.freeze(discontinuities()
    .filter((d) => d.firstOrder && d.rKm < R_EARTH_KM - 3.5)
    .map((d) => ({ rKm: d.rKm, above: asMedium(d.above), below: asMedium(d.below) })));
export const SURFACE_MEDIUM = Object.freeze(asMedium(premAt(R_EARTH_KM, { ocean: false })));
const findInterface = (r) => INTERFACES.find((f) => Math.abs(f.rKm - r) < 1e-6) ?? null;

/** Medium at a radius (km), from PREM without ocean; `side` resolves a discontinuity. */
const mediumAt = (r, side = 'below') => asMedium(premAt(Math.min(R_EARTH_KM, Math.max(0, r)), { ocean: false, side }));

const waveOf = (set, r, cmb) => (set === 'K' ? (r < cmb - 1e-9 ? 'P' : 'S') : set);

/**
 * Walk a phase ray's legs in travel order and list every interface event:
 * transmissions through PREM's discontinuities, reflections at a boundary a
 * leg bounces off (CMB, ICB, or a discontinuity a ray turned AT), and free-
 * surface reflections between legs. Returns [{ kind, rKm, inc, out, E }] with E
 * the energy coefficient, or null if the ray has an arc (diffracted).
 */
export function interfaceEvents(ray, { model = premPhaseModel(), polarization = 'SV' } = {}) {
    const cmb = model.cmbKm, events = [], R = model.radiusKm;
    const coef = (kind, inc, out, from, to, r) => {
        const ph = ray.p / r;
        if (inc === 'S' && out === 'S' && polarization === 'SH') {
            const c = shCoefficients(from, to, ph);
            return kind === 'R' ? c.R : c.T;
        }
        const c = psvCoefficients(inc, from, to, ph);
        return (kind === 'R' ? c.R : c.T)[out];
    };
    const legs = ray.legs;
    for (let i = 0; i < legs.length; i++) {
        const l = legs[i];
        if (l.arc) return null;
        const crossings = INTERFACES.filter((f) => f.rKm > l.lo + 1e-6 && f.rKm < l.hi - 1e-6);
        crossings.sort((a, b) => (l.dir < 0 ? b.rKm - a.rKm : a.rKm - b.rKm));
        for (const f of crossings) {
            const [from, to] = l.dir < 0 ? [f.above, f.below] : [f.below, f.above];
            const rIn = l.dir < 0 ? f.rKm + 1e-6 : f.rKm - 1e-6, rOut = l.dir < 0 ? f.rKm - 1e-6 : f.rKm + 1e-6;
            const inc = waveOf(l.set, rIn, cmb), out = waveOf(l.set, rOut, cmb);
            events.push({ kind: 'transmit', rKm: f.rKm, inc, out, E: coef('T', inc, out, from, to, f.rKm) });
        }
        const next = legs[i + 1];
        if (!next) break;
        if (l.dir < 0 && next.dir > 0) {
            // Bottom of a down leg: a turning point inside a shell is not an event; a
            // boundary is a reflection from above (PcP, PKiKP, or a turn AT an interface).
            const f = findInterface(l.lo);
            if (f) {
                const inc = waveOf(l.set, f.rKm + 1e-6, cmb), out = waveOf(next.set, f.rKm + 1e-6, cmb);
                events.push({ kind: 'reflect', rKm: f.rKm, inc, out, E: coef('R', inc, out, f.above, f.below, f.rKm) });
            }
        } else if (l.dir > 0 && next.dir < 0 && Math.abs(l.hi - R) < 1e-6) {
            const inc = waveOf(l.set, R - 1e-6, cmb), out = waveOf(next.set, R - 1e-6, cmb);
            events.push({ kind: 'surface', rKm: R, inc, out, E: coef('R', inc, out, SURFACE_MEDIUM, null, R) });
        }
    }
    return events;
}

/** Q for a wave type at a radius, from PREM's Q_μ and Q_κ. */
export function qAt(wave, r) {
    const s = premAt(Math.min(R_EARTH_KM, Math.max(0, r)), { ocean: false });
    const qmu = s.qMu > 0 && Number.isFinite(s.qMu) ? s.qMu : Infinity, qk = s.qKappa;
    if (wave === 'S') return qmu;
    const L = s.vsKmS > 0 ? (4 / 3) * (s.vsKmS / s.vpKmS) ** 2 : 0;
    return 1 / (L / qmu + (1 - L) / qk);
}

/** t* (s) of each wave type along the ray: { P, S } — ∫ dt / Q, per interval at its mid-radius. */
export function tStar(ray, { model = premPhaseModel() } = {}) {
    const { intervals } = model.samplePath(ray, { sub: 1 });
    const out = { P: 0, S: 0 };
    for (const iv of intervals) {
        if (!iv.dT) continue;
        const w = waveOf(iv.set, iv.rMid, model.cmbKm);
        out[w] += iv.dT / qAt(w, iv.rMid);
    }
    return out;
}

/**
 * The ray-tube spreading term √(dΩ / (dS cos i_r)) (1/km) for a ray of parameter
 * p from radius rs to the surface, given dΔ/dp, the source speed and the
 * receiver speed. Returns null where ray theory has no finite answer.
 */
export function spreading(p, deltaRad, dDeltaDp, { rs, vs, vr, R = R_EARTH_KM }) {
    const sinIs = p * vs / rs, sinIr = p * vr / R;
    if (sinIs >= 1 || sinIr >= 1) return null;                  // horizontal takeoff / grazing arrival
    const cosIs = Math.sqrt(1 - sinIs * sinIs), cosIr = Math.sqrt(1 - sinIr * sinIr), sD = Math.abs(Math.sin(deltaRad));
    const dpdD = 1 / Math.abs(dDeltaDp);
    if (!Number.isFinite(dpdD) || sD < Math.sin(1 * DEG)) return null;   // a caustic, or an antipodal/epicentral focus
    // dΩ/dΔ = sin i_s · di_s/dΔ, di_s/dΔ = (v_s / (r_s cos i_s)) · dp/dΔ.
    const dOmega = sinIs * (vs / (rs * cosIs)) * dpdD;
    return Math.sqrt(dOmega / (R * R * sD * cosIr));
}

/**
 * The relative displacement amplitude of one ray of a phase:
 * { amp, parts: { source, spreading, interfaces, attenuation }, events, tStar, flags[] }
 * or { amp: null, reason } where ray theory does not give one.
 */
export function phaseAmplitude(ray, { model = premPhaseModel(), sourceDepthKm = 0 } = {}) {
    const info = PHASE_INFO[ray.name];
    if (!info) return { amp: null, reason: 'unknown phase' };
    if (info.kind === 'diffracted') return { amp: null, reason: 'diffracted — no ray-theory amplitude; it decays fast with distance past the core shadow' };
    const polarization = SH_PHASES.has(ray.name) ? 'SH' : 'SV';
    const events = interfaceEvents(ray, { model, polarization });
    if (!events) return { amp: null, reason: 'diffracted' };
    const rs = model.radiusKm - sourceDepthKm;
    const first = ray.legs[0], last = ray.legs.at(-1);
    const wS = waveOf(first.set, first.dir < 0 ? rs - 1e-6 : rs + 1e-6, model.cmbKm);
    const wR = waveOf(last.set, model.radiusKm - 1e-6, model.cmbKm);
    const mS = mediumAt(rs, first.dir < 0 ? 'below' : 'above'), mR = SURFACE_MEDIUM;
    const vS = wS === 'P' ? mS.vp : mS.vs, vR = wR === 'P' ? mR.vp : mR.vs;
    // dΔ/dp from the phase itself, centred; a sign change across the stencil is a caustic.
    const h = 1e-4 * Math.max(1, ray.p);
    const a = model.phaseRay(ray.name, ray.p - h, { sourceDepthKm }), b = model.phaseRay(ray.name, ray.p + h, { sourceDepthKm });
    const flags = [];
    let dDdp = null;
    if (a && b) dDdp = (b.deltaRad - a.deltaRad) / (2 * h);
    else if (a) dDdp = (ray.deltaRad - a.deltaRad) / h;
    else if (b) dDdp = (b.deltaRad - ray.deltaRad) / h;
    if (a && b && (ray.deltaRad - a.deltaRad) * (b.deltaRad - ray.deltaRad) <= 0) flags.push('caustic');
    const sp = dDdp == null ? null : spreading(ray.p, ray.deltaRad, dDdp, { rs, vs: vS, vr: vR, R: model.radiusKm });
    if (sp == null || flags.includes('caustic')) {
        return { amp: null, reason: flags.includes('caustic') || Math.abs(Math.sin(ray.deltaRad)) >= Math.sin(DEG)
            ? 'at a caustic — ray theory predicts a focus (strong, but its size is not finite in ray theory)'
            : 'at the epicentre or antipode — a focus ray theory cannot size', events, flags: [...flags, 'focus'] };
    }
    const source = RADIATION[wS === 'P' ? 'P' : polarization] / (4 * Math.PI * mS.rho * vS ** 3);
    const impedance = Math.sqrt((mS.rho * vS) / (mR.rho * vR));
    const transmission = Math.sqrt(events.reduce((s, e) => s * Math.max(0, e.E), 1));
    const ts = tStar(ray, { model });
    const tTotal = ts.P + ts.S;
    const atten = Math.exp(-Math.PI * REF_FREQ_HZ[wR] * tTotal);
    return {
        amp: source * impedance * sp * transmission * atten,
        parts: { source, impedance, spreading: sp, interfaces: transmission, attenuation: atten },
        events, tStar: ts, recordedAs: wR === 'P' ? 'P' : polarization, flags,
    };
}

/** dB relative to a reference, and the visibility class. */
export function visibility(amp, refAmp) {
    if (!(amp > 0) || !(refAmp > 0)) return { db: null, label: null };
    const db = 20 * Math.log10(amp / refAmp);
    return { db, label: VISIBILITY.find((v) => db >= v.minDb).label };
}

/** Station elevation: the extra time through h km of upper crust at the ray's own slowness. */
export function elevationCorrection(p, wave, hKm, { R = R_EARTH_KM, crust = SURFACE_MEDIUM } = {}) {
    if (!Number.isFinite(hKm) || hKm === 0) return 0;
    const v = wave === 'S' ? crust.vs : crust.vp, ph = p / R;
    const q2 = 1 / (v * v) - ph * ph;
    return hKm * Math.sqrt(Math.max(0, q2));
}

export { DIFFRACTION_MAX_DEG };
