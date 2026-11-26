/**
 * chicxulub/constraints.js — the model against its constraints (PURE).
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no ambient time, no randomness. Node-gated by tests/chicxulub.mjs §10.
 *
 * ONE MODEL, FIVE VARIABLES: diameter, speed, angle, bulk density, and the
 * share of the body's iridium that ended up in the global layer (fDep).
 * Everything observable is a function of those five (impact-model.js).
 *
 * TWO KINDS OF ROW, and the split is the point:
 *
 *   FITTED     the model is adjusted to these. Measurements of the rock
 *              (rim, two ejecta sections, iridium), the published trajectory,
 *              and two priors about what kind of body it was (speed, density).
 *   HELD OUT   never used in the fit. The model's value is PREDICTED and then
 *              compared: the peak ring, the outer ring, a third ejecta
 *              section, and other people's energy and earthquake estimates.
 *              A held-out row that fails is a finding, not a bug to tune away.
 *
 * Every row is a Gaussian in its natural space (log for sizes and amounts,
 * linear for angles and magnitudes): z = (model − observed) / σ. A measured
 * RANGE lo–hi is centred on its middle with σ = half the range plus the
 * model's own scatter, stated per row. χ² = Σ z² over the fitted rows.
 *
 * WHAT THE TOOLS ANSWER
 *   evaluate      how far is this set of variables from each row?
 *   fit           which variables fit best? (deterministic coordinate descent)
 *   elasticity    which observable moves when which variable moves, and by how
 *                 much (d ln observable / d ln variable)?
 *   stiffness     which COMBINATIONS of variables does the evidence pin down,
 *                 and which does it leave free? (eigenvectors of JᵀJ)
 *   profile       how far can ONE variable move if the others re-adjust?
 *   pairMap       the χ² surface over two variables, the rest held.
 *   leaveOneOut   drop a fitted row, refit: does the model predict the row it
 *                 was not shown, and how far does the answer move?
 *   tension       can two rows be satisfied together at all?
 *
 * `stiffness` and `fit` say nothing about whether the SCALING LAWS are right —
 * every row goes through the same recalled coefficients (SCALING.verified is
 * false). A good fit means the evidence is consistent under these laws.
 */

import * as M from './impact-model.js';
import * as O from './observations.js';
import { DEFAULTS, EJECTA_FIT, SPEED_PRIOR, asteroidSpeedDensity } from './reconstruct.js';
import { PALEO_SITES } from './paleo-sites.js';

const RAD = Math.PI / 180;

export const PARAMS = Object.freeze([
    Object.freeze({ key: 'diameterKm', label: 'Diameter', unit: 'km', lo: 3, hi: 30, log: true, digits: 1 }),
    Object.freeze({ key: 'speedKms', label: 'Speed', unit: 'km/s', lo: 11.3, hi: 72, log: true, digits: 1 }),
    Object.freeze({ key: 'angleDeg', label: 'Angle', unit: '°', lo: 20, hi: 90, log: false, digits: 0 }),
    Object.freeze({ key: 'density', label: 'Density', unit: 'kg/m³', lo: 1400, hi: 2700, log: false, digits: 0 }),
    Object.freeze({ key: 'fDep', label: 'Iridium in the layer', unit: '', lo: 0.01, hi: 1, log: true, digits: 2 }),
]);
export const PARAM_KEYS = Object.freeze(PARAMS.map((p) => p.key));
const toU = (p, x) => (p.log ? Math.log(x / p.lo) / Math.log(p.hi / p.lo) : (x - p.lo) / (p.hi - p.lo));
const fromU = (p, u) => { const c = Math.max(0, Math.min(1, u)); return p.log ? p.lo * (p.hi / p.lo) ** c : p.lo + (p.hi - p.lo) * c; };
export const paramToUnit = (key, x) => toU(PARAMS.find((p) => p.key === key), x);
export const unitToParam = (key, u) => fromU(PARAMS.find((p) => p.key === key), u);

const dist = (s) => M.greatCircle(O.CRATER.centre.latDeg, O.CRATER.centre.lonDeg, s.latDeg, s.lonDeg);
const BELOC = O.EJECTA_SITES.find((s) => s.name.startsWith('Beloc'));
// Haiti sits on the Caribbean plate and has moved since: its distance from the
// crater at 66 Ma is the plate model's (js/chicxulub/paleo-sites.js). The
// other ejecta sites ride the same plate as the crater, so theirs are today's.
export const BELOC_DISTANCE_KM = Object.freeze({ today: PALEO_SITES.beloc.distanceTodayKm, at66: PALEO_SITES.beloc.distance66Km });

/** Everything the model predicts for one set of variables. */
export function predict(v) {
    const L = v.diameterKm * 1000, sp = v.speedKms * 1000;
    const mass = M.impactorMass(L, v.density), energy = M.kineticEnergy(mass, sp);
    const Dtc = M.transientDiameter({ diameterM: L, speed: sp, angleDeg: v.angleDeg, density: v.density, targetDensity: DEFAULTS.targetDensity });
    const Dfr = M.finalDiameter(Dtc);
    const out = {
        finalKm: Dfr / 1000, transientKm: Dtc / 1000, peakRingKm: O.PEAK_RING_RATIO.value * Dfr / 1000,
        massKg: mass, energyJ: energy, seismicM: M.seismicMagnitude(energy),
        iridium: M.iridiumFluence({ massKg: mass, abundanceNgG: DEFAULTS.abundanceNgG, fDep: v.fDep }),
        speedKms: v.speedKms, angleDeg: v.angleDeg, density: v.density,
        ejectaBeloc: M.ejectaThickness(Dtc, BELOC_DISTANCE_KM.at66 * 1000),
        ejectaBelocToday: M.ejectaThickness(Dtc, dist(BELOC)),
    };
    EJECTA_FIT.forEach((e, i) => { out[`ejecta${i}`] = M.ejectaThickness(Dtc, e.distanceKm * 1000); });
    return out;
}

// the asteroid speed prior as a z: −2 ln(p / p_max), signed by the side of the mode
let _speedMax = null;
function speedZ(vKms) {
    if (!_speedMax) { let best = 0, at = 12; for (let v = 11.3; v < 72; v += 0.01) { const p = asteroidSpeedDensity(v); if (p > best) { best = p; at = v; } } _speedMax = { p: best, v: at }; }
    const p = asteroidSpeedDensity(vKms);
    if (!(p > 0)) return 30;
    return Math.sign(vKms - _speedMax.v) * Math.sqrt(Math.max(0, -2 * Math.log(p / _speedMax.p)));
}
export const speedPriorMode = () => { speedZ(20); return _speedMax.v; };

const mid = (r) => (r.lo + r.hi) / 2;
const irSigma = Math.hypot(O.IRIDIUM.fluenceNgCm2.sigma / O.IRIDIUM.fluenceNgCm2.value, DEFAULTS.fluenceModelLogSigma);

/**
 * The rows. `obs` is the centre, `sigma` its width in the row's space
 * (`log: true` ⇒ sigma is in ln units). `get` reads the model's value.
 */
export const ROWS = Object.freeze([
    // ── fitted ──
    { id: 'rim', group: 'fitted', label: 'Topographic (inner) rim', unit: 'km', log: true, get: (p) => p.finalKm,
      obs: DEFAULTS.craterKm, sigma: DEFAULTS.craterLogSigma, kind: 'measured', verified: 'search',
      basis: 'seismic images: 140–170 km; σ covers that range and the law\'s scatter' },
    ...EJECTA_FIT.map((e, i) => ({ id: `ejecta${i}`, group: 'fitted', label: `Debris at ${e.name.split(',')[0]} (${Math.round(e.distanceKm)} km)`, unit: 'cm', scale: 100,
      log: true, get: (p) => p[`ejecta${i}`], obs: e.thicknessM, sigma: e.logSigma, kind: 'measured',
      verified: O.EJECTA_SITES.find((s) => s.name === e.name).verified,
      basis: 'layer thickness; the blanket law goes as the transient crater to the fourth power' })),
    { id: 'iridium', group: 'fitted', label: 'Global iridium', unit: 'ng/cm²', log: true, get: (p) => p.iridium,
      obs: O.IRIDIUM.fluenceNgCm2.value, sigma: irSigma, kind: 'measured', verified: 'search',
      basis: '52 boundary sections; σ adds the uncertainty in a CM body\'s iridium content' },
    { id: 'angle', group: 'fitted', label: 'Angle to the ground', unit: '°', log: false, get: (p) => p.angleDeg,
      obs: mid(O.TRAJECTORY.angleDeg), sigma: 8, kind: 'inferred', verified: 'search',
      basis: 'crater asymmetry against 3-D simulations: 45–60°' },
    { id: 'speed', group: 'fitted', label: 'Speed typical of an asteroid', unit: 'km/s', log: false, get: (p) => p.speedKms,
      obs: null, sigma: null, z: (p) => speedZ(p.speedKms), kind: 'prior', verified: SPEED_PRIOR.verified,
      basis: 'main-belt bodies reach Earth at ~12–30 km/s; the isotopes say asteroid' },
    { id: 'density', group: 'fitted', label: 'Density of a CM-type body', unit: 'kg/m³', log: false, get: (p) => p.density,
      obs: O.IMPACTOR_DENSITY.value, sigma: 400, kind: 'prior', verified: false,
      basis: 'carbonaceous meteorites and asteroids: 1400–2700' },
    // ── held out ──
    { id: 'peakRing', group: 'held', label: 'Peak ring', unit: 'km', log: true, get: (p) => p.peakRingKm,
      obs: O.CRATER.peakRingDiameterKm.value, sigma: 0.12, kind: 'measured', verified: 'search',
      basis: 'measured 80–90 km, against "half the rim" (a recalled rule)' },
    { id: 'outerRing', group: 'held', label: 'Outer ring, if IT were the rim', unit: 'km', log: true, get: (p) => p.finalKm,
      obs: O.CRATER.rimDiameterKm.value, sigma: 0.10, kind: 'measured', verified: 'search',
      basis: 'measured 180–200 km; tests which ring the scaling law describes' },
    { id: 'beloc', group: 'held', label: `Debris at Beloc (${Math.round(BELOC_DISTANCE_KM.at66)} km at 66 Ma; ${Math.round(BELOC_DISTANCE_KM.today)} today)`, unit: 'cm', scale: 100, log: true, get: (p) => p.ejectaBeloc,
      obs: BELOC.thicknessM, sigma: Math.log(3), kind: 'measured', verified: 'search',
      basis: 'distance at 66 Ma from a plate model (Müller et al. 2019); reworked deposit, so not fitted' },
    { id: 'energy', group: 'held', label: 'Published energy', unit: 'J', log: true, get: (p) => p.energyJ,
      obs: Math.sqrt(O.ENERGY.joules.lo * O.ENERGY.joules.hi), sigma: Math.log(O.ENERGY.joules.hi / O.ENERGY.joules.lo) / 2 + 0.2, kind: 'inferred', verified: 'search',
      basis: 'other reconstructions: 1–4×10²³ J' },
    { id: 'quake', group: 'held', label: 'Published earthquake magnitude', unit: '', log: false, get: (p) => p.seismicM,
      obs: mid(O.ENERGY.seismicMw), sigma: 0.5, kind: 'inferred', verified: 'search',
      basis: 'other estimates: magnitude 10–11' },
].map(Object.freeze));
export const FITTED = Object.freeze(ROWS.filter((r) => r.group === 'fitted'));
export const HELD = Object.freeze(ROWS.filter((r) => r.group === 'held'));

function zOf(row, pred) {
    if (row.z) return row.z(pred);
    const m = row.get(pred);
    if (m == null || !(m > 0)) return 30;
    return row.log ? Math.log(m / row.obs) / row.sigma : (m - row.obs) / row.sigma;
}
/** Each row's distance from the model, and χ² over a chosen set of fitted rows. */
export function evaluate(vars, { use = null } = {}) {
    const pred = predict(vars);
    const rows = ROWS.map((r) => ({ id: r.id, group: r.group, label: r.label, model: r.get(pred), z: zOf(r, pred) }));
    let chi2 = 0;
    for (const r of rows) if (r.group === 'fitted' && (!use || use.includes(r.id))) chi2 += r.z * r.z;
    let held = 0; for (const r of rows) if (r.group === 'held') held += r.z * r.z;
    return { vars: { ...vars }, pred, rows, chi2, chi2Held: held };
}
const chi2Of = (vars, use) => { const p = predict(vars); let s = 0; for (const r of FITTED) if (!use || use.includes(r.id)) { const z = zOf(r, p); s += z * z; } return s; };

/**
 * Best-fitting variables: coordinate descent in each variable's unit interval
 * from a fixed set of starts, steps halving. Deterministic. `fixed` pins
 * variables; `use` restricts which fitted rows count.
 */
export function fit({ use = null, fixed = {}, sweeps = 70 } = {}) {
    const free = PARAMS.filter((p) => !(p.key in fixed));
    let best = null;
    for (const uL of [0.45, 0.7]) for (const uV of [0.15, 0.45]) {
        const u = { diameterKm: uL, speedKms: uV, angleDeg: 0.45, density: 0.6, fDep: 0.5 };
        const vars = () => Object.fromEntries(PARAMS.map((p) => [p.key, p.key in fixed ? fixed[p.key] : fromU(p, u[p.key])]));
        let c = chi2Of(vars(), use), step = 0.2;
        for (let s = 0; s < sweeps && step > 1e-7; s++) {
            let moved = false;
            for (const p of free) for (const d of [step, -step]) {
                const keep = u[p.key]; u[p.key] = Math.max(0, Math.min(1, keep + d));
                const c2 = chi2Of(vars(), use);
                if (c2 < c - 1e-14) { c = c2; moved = true; } else u[p.key] = keep;
            }
            if (!moved) step /= 2;
        }
        if (!best || c < best.chi2) best = { vars: vars(), chi2: c };
    }
    // Coordinate descent stalls in a narrow DIAGONAL valley (size traded against
    // speed and iridium share — measured: a step along that direction still
    // lowered χ² by 0.1). Finish with line searches along the eigen-directions
    // of the fit's own stiffness matrix, where the valley is one coordinate.
    const clamp = (v) => Object.fromEntries(PARAMS.map((p) => [p.key, p.key in fixed ? fixed[p.key] : Math.max(p.lo, Math.min(p.hi, v[p.key]))]));
    const along = (v, w, a) => clamp(Object.fromEntries(PARAMS.map((p) => [p.key, v[p.key] * Math.exp(a * (p.key in fixed ? 0 : w[p.key]))])));
    let vars = best.vars, c = best.chi2;
    for (let round = 0; round < 4; round++) {
        const before = c;
        for (const m of stiffness(vars, { use }).modes) {
            let lo = -1.5, hi = 1.5;
            for (let i = 0; i < 46; i++) {
                const a1 = lo + (hi - lo) / 3, a2 = hi - (hi - lo) / 3;
                if (chi2Of(along(vars, m.weights, a1), use) < chi2Of(along(vars, m.weights, a2), use)) hi = a2; else lo = a1;
            }
            const cand = along(vars, m.weights, (lo + hi) / 2), cc = chi2Of(cand, use);
            if (cc < c) { vars = cand; c = cc; }
        }
        if (before - c < 1e-10) break;
    }
    return { ...evaluate(vars, { use }), chi2: c, dof: (use ? use.length : FITTED.length) - free.length };
}

/** d ln(observable) / d ln(variable) at a point: rows × variables. */
export const OBSERVABLES = Object.freeze([
    ['finalKm', 'Crater width'], ['ejecta0', 'Debris thickness'], ['iridium', 'Iridium'], ['energyJ', 'Energy'], ['massKg', 'Mass'],
]);
export function elasticity(vars, h = 1e-4) {
    return OBSERVABLES.map(([key, label]) => ({
        key, label,
        d: Object.fromEntries(PARAMS.map((p) => {
            const up = predict({ ...vars, [p.key]: vars[p.key] * (1 + h) })[key], dn = predict({ ...vars, [p.key]: vars[p.key] * (1 - h) })[key];
            return [p.key, Math.log(up / dn) / Math.log((1 + h) / (1 - h))];
        })),
    }));
}

/** Jacobi eigen-decomposition of a small symmetric matrix. */
export function symmetricEigen(A) {
    const n = A.length, a = A.map((r) => r.slice()), V = a.map((_, i) => a.map((__, j) => (i === j ? 1 : 0)));
    for (let sweep = 0; sweep < 60; sweep++) {
        let off = 0; for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] ** 2;
        if (off < 1e-24) break;
        for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
            if (Math.abs(a[p][q]) < 1e-300) continue;
            const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
            const c = 1 / Math.sqrt(t * t + 1), s = t * c;
            for (let k = 0; k < n; k++) { const x = a[k][p], y = a[k][q]; a[k][p] = c * x - s * y; a[k][q] = s * x + c * y; }
            for (let k = 0; k < n; k++) { const x = a[p][k], y = a[q][k]; a[p][k] = c * x - s * y; a[q][k] = s * x + c * y; }
            for (let k = 0; k < n; k++) { const x = V[k][p], y = V[k][q]; V[k][p] = c * x - s * y; V[k][q] = s * x + c * y; }
        }
    }
    return a.map((_, i) => ({ value: a[i][i], vector: V.map((r) => r[i]) })).sort((x, y) => y.value - x.value);
}

/**
 * Which combinations of variables the fitted rows pin down. J[i][j] is
 * dz_i / d ln(variable_j); the eigenvectors of JᵀJ are directions in
 * log-variable space, and 1/√eigenvalue is how far (in ln units — 0.1 ≈ 10 %)
 * the model can slide along one before χ² rises by 1. Stiff first.
 */
export function stiffness(vars, { use = null, h = 1e-4 } = {}) {
    const rows = FITTED.filter((r) => !use || use.includes(r.id));
    const J = rows.map((r) => PARAMS.map((p) => {
        const up = zOf(r, predict({ ...vars, [p.key]: vars[p.key] * (1 + h) })), dn = zOf(r, predict({ ...vars, [p.key]: vars[p.key] * (1 - h) }));
        return (up - dn) / Math.log((1 + h) / (1 - h));
    }));
    const n = PARAMS.length, F = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (__, b) => J.reduce((s, r) => s + r[a] * r[b], 0)));
    const modes = symmetricEigen(F).map((m) => {
        const sgn = Math.sign(m.vector.reduce((big, x) => (Math.abs(x) > Math.abs(big) ? x : big), 0)) || 1;
        return { value: m.value, freedom: m.value > 1e-12 ? 1 / Math.sqrt(m.value) : Infinity,
                 weights: Object.fromEntries(PARAMS.map((p, i) => [p.key, sgn * m.vector[i]])) };
    });
    return { J, rows: rows.map((r) => r.id), fisher: F, modes };
}

/** χ² as ONE variable is walked across its range and the others re-adjust. */
export function profile(key, { n = 41, use = null } = {}) {
    const p = PARAMS.find((q) => q.key === key), xs = [], chi = [];
    for (let i = 0; i < n; i++) { const x = fromU(p, i / (n - 1)); xs.push(x); chi.push(fit({ use, fixed: { [key]: x }, sweeps: 45 }).chi2); }
    const min = Math.min(...chi), inside = xs.filter((_, i) => chi[i] <= min + 1);
    return { key, x: xs, chi2: chi, min, lo: inside[0], hi: inside[inside.length - 1], pinned: inside.length < n };
}

/**
 * χ² over two variables, the others held at `at`. With `freeIridium` (default)
 * the iridium share re-adjusts at every point unless it is one of the two
 * axes: it enters only the iridium row, so its best value is closed-form
 * (observed ÷ the body's whole iridium, capped at 1). Held fixed instead, the
 * iridium row alone pins the size and the map shows a sliver, not a trade-off.
 */
export function pairMap(kx, ky, at, { n = 48, use = null, freeIridium = true } = {}) {
    const slide = freeIridium && kx !== 'fDep' && ky !== 'fDep';
    const fp = PARAMS.find((q) => q.key === 'fDep'), irObs = O.IRIDIUM.fluenceNgCm2.value;
    const bestShare = (v) => Math.max(fp.lo, Math.min(1, irObs / predict({ ...v, fDep: 1 }).iridium));
    const px = PARAMS.find((q) => q.key === kx), py = PARAMS.find((q) => q.key === ky);
    const x = Array.from({ length: n }, (_, i) => fromU(px, i / (n - 1))), y = Array.from({ length: n }, (_, j) => fromU(py, j / (n - 1)));
    const chi2 = new Float64Array(n * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const v = { ...at, [kx]: x[i], [ky]: y[j] };
        if (slide) v.fDep = bestShare(v);
        chi2[i * n + j] = chi2Of(v, use);
    }
    return { kx, ky, x, y, chi2, n, freeIridium: slide };
}

/**
 * Drop each fitted row in turn and refit without it. `predictedZ` is how far
 * the refitted model lands from the row it was not shown; `moved` is how far
 * the answer shifted (ln units per variable).
 */
export function leaveOneOut(base = fit()) {
    return FITTED.map((r) => {
        const f = fit({ use: FITTED.filter((q) => q.id !== r.id).map((q) => q.id) });
        const z = f.rows.find((q) => q.id === r.id).z;
        const moved = Object.fromEntries(PARAMS.map((p) => [p.key, Math.log(f.vars[p.key] / base.vars[p.key])]));
        // does dropping it leave a variable loose? (the sloppiest direction without the row)
        const soft = stiffness(f.vars, { use: FITTED.filter((q) => q.id !== r.id).map((q) => q.id) }).modes.at(-1);
        const loosens = soft.freedom > 2 ? PARAMS.reduce((m, p) => (Math.abs(soft.weights[p.key]) > Math.abs(soft.weights[m]) ? p.key : m), PARAMS[0].key) : null;
        return { id: r.id, label: r.label, predictedZ: z, chi2Without: f.chi2, moved, vars: f.vars, loosens,
                 largestMove: PARAMS.reduce((m, p) => (Math.abs(moved[p.key]) > Math.abs(moved[m]) ? p.key : m), PARAMS[0].key) };
    });
}

/** Can two fitted rows be satisfied together? The smallest χ² using only those two. */
export function tension(idA, idB) { return fit({ use: [idA, idB], sweeps: 50 }).chi2; }
export function tensionTable() {
    const out = [];
    for (let i = 0; i < FITTED.length; i++) for (let j = i + 1; j < FITTED.length; j++) out.push({ a: FITTED[i].id, b: FITTED[j].id, chi2: tension(FITTED[i].id, FITTED[j].id) });
    return out.sort((x, y) => y.chi2 - x.chi2);
}

/** The analytic exponents the elasticity must reproduce (from the scaling law). */
export function analyticExponents(angleDeg) {
    const S = M.SCALING, k = S.finalExp, cot = 1 / Math.tan(angleDeg * RAD);
    return {
        finalKm: { diameterKm: k * S.expL, speedKms: k * S.expV, density: k / 3, angleDeg: k / 3 * cot * angleDeg * RAD, fDep: 0 },
        ejecta0: { diameterKm: 4 * S.expL, speedKms: 4 * S.expV, density: 4 / 3, angleDeg: 4 / 3 * cot * angleDeg * RAD, fDep: 0 },
        iridium: { diameterKm: 3, speedKms: 0, density: 1, angleDeg: 0, fDep: 1 },
        energyJ: { diameterKm: 3, speedKms: 2, density: 1, angleDeg: 0, fDep: 0 },
        massKg: { diameterKm: 3, speedKms: 0, density: 1, angleDeg: 0, fDep: 0 },
    };
}
