/**
 * js/trojan-dynamics.js — PURE kernel for the Jupiter Trojans.
 * Gate: `node tests/trojan-dynamics.mjs`. No DOM, no fetch, no ambient time.
 *
 * Input is /api/trojans/catalog: SBDB osculating elements for every object
 * JPL files as orbit class TJN, plus Jupiter's and Saturn's Sun-centred state
 * vectors from Horizons at the SAME epoch. Output is what the population
 * actually does.
 *
 * ── THE ONE ANGLE ──────────────────────────────────────────────────────────
 * A Trojan shares Jupiter's orbit and sits ~60° ahead (L4, the "Greek camp")
 * or behind (L5, the "Trojan camp"). The quantity is the RESONANT ANGLE
 *     φ = λ − λ_J,   λ = Ω + ω + M   (mean longitude)
 * and it must be formed against Jupiter's OSCULATING elements at the same
 * instant in the same frame — which is why the route ships Horizons vectors
 * instead of letting the client use mean elements. The Standish (1992) mean
 * elements below are the disclosed fallback (`jupiterSource: 'standish-mean'`).
 *
 * ── TJN IS A BOX, LIBRATION IS A MOTION ────────────────────────────────────
 * JPL's class is an (a, e) cut around 5.2 AU. Membership in a camp is a
 * property of φ(t), not of φ at one epoch, so this kernel answers it two ways:
 *
 *  1. `analyticLibration` — the averaged planar-circular co-orbital problem
 *     has an exact integral of motion (derived in the function header);
 *     its turning points give the tadpole amplitude in microseconds. It
 *     ignores e, i, Jupiter's eccentricity and Saturn, so it is an ESTIMATE
 *     and is labelled one everywhere.
 *  2. `integrateSwarm` — Sun + Jupiter + Saturn integrated together, every
 *     Trojan a massless particle, φ MEASURED from osculating elements over
 *     centuries. This is the authority: amplitude, libration period, regime
 *     (L4 / L5 tadpole, horseshoe, circulating, close encounter).
 *
 * The run-averaged a/e/i it reports are NOT proper elements (those need a
 * filtered multi-Myr integration — Milani 1993); they are named for what they
 * are.
 *
 * ── SIZES ──────────────────────────────────────────────────────────────────
 * Trojans are dark: NEOWISE measured a population mean geometric albedo of
 * 0.07 (Grav et al. 2011, ApJ 742:40). The site-wide unclassified default of
 * 0.14 (js/neo-orbits.js) would draw every Trojan 1.41× too small, so
 * `trojanDiameterKm` uses MEASURED diameter → measured albedo → 0.07, and says
 * which.
 */

import { GAUSS_K, D2R, R2D, solveKeplerElliptic, perifocalBasis } from './neo-orbits.js';

export const K2 = GAUSS_K * GAUSS_K;                 // GM_sun, AU³/day²
/** Sun / planet-system mass ratios (IAU 2015 Resolution B3 nominal values). */
export const MASS_RATIO = Object.freeze({ jupiter: 1047.348644, saturn: 3497.9018 });
export const M_JUPITER = 1 / MASS_RATIO.jupiter;     // solar masses
export const M_SATURN  = 1 / MASS_RATIO.saturn;
/** Restricted-problem mass parameter μ = m_J / (M☉ + m_J). */
export const MU_JUPITER = M_JUPITER / (1 + M_JUPITER);
/** Population mean geometric albedo of the Jupiter Trojans (Grav et al. 2011). */
export const TROJAN_MEAN_ALBEDO = 0.07;
export const JULIAN_YEAR_D = 365.25;
const TWO_PI = 2 * Math.PI;

/** Wrap degrees into (−180, 180]. */
export function wrap180(d) {
    let x = ((d + 180) % 360 + 360) % 360 - 180;
    if (x === -180) x = 180;
    return x;
}

// ── Two-body state ↔ elements ───────────────────────────────────────────────

/**
 * Heliocentric state from elliptic elements (degrees, AU) at mean anomaly M.
 * `gm` in AU³/day² — K2 for a massless particle, K2·(1+m) for a planet.
 */
export function stateFromElements({ a, e, i, om, w, M }, gm = K2) {
    const B = perifocalBasis(i, om, w);
    const E = solveKeplerElliptic(M * D2R, e);
    const cE = Math.cos(E), sE = Math.sin(E);
    const b = a * Math.sqrt(1 - e * e);
    const n = Math.sqrt(gm / (a * a * a));
    const xp = a * (cE - e), yp = b * sE;
    const Edot = n / (1 - e * cE);
    const vxp = -a * sE * Edot, vyp = b * cE * Edot;
    return {
        r: [B.Px * xp + B.Qx * yp, B.Py * xp + B.Qy * yp, B.Pz * xp + B.Qz * yp],
        v: [B.Px * vxp + B.Qx * vyp, B.Py * vxp + B.Qy * vyp, B.Pz * vxp + B.Qz * vyp],
    };
}

/**
 * Osculating elements from a heliocentric state. Angles in degrees.
 * Returns λ (mean longitude) and ϖ (longitude of perihelion) too, because the
 * resonant angle is built from λ and is well defined even where ω and Ω are
 * not (e → 0, i → 0).
 */
export function elementsFromState(r, v, gm = K2) {
    const [x, y, z] = r, [vx, vy, vz] = v;
    const rr = Math.hypot(x, y, z);
    const v2 = vx * vx + vy * vy + vz * vz;
    const hx = y * vz - z * vy, hy = z * vx - x * vz, hz = x * vy - y * vx;
    const h = Math.hypot(hx, hy, hz);
    const a = 1 / (2 / rr - v2 / gm);
    const rv = x * vx + y * vy + z * vz;
    // Eccentricity vector
    const ex = (vy * hz - vz * hy) / gm - x / rr;
    const ey = (vz * hx - vx * hz) / gm - y / rr;
    const ez = (vx * hy - vy * hx) / gm - z / rr;
    const e = Math.hypot(ex, ey, ez);
    const i = Math.acos(Math.max(-1, Math.min(1, hz / h)));
    const om = Math.atan2(hx, -hy);                     // node: n = ẑ × h
    // Longitude of perihelion ϖ = Ω + ω, and true longitude θ = Ω + ω + ν,
    // measured in the "dog-leg" sense (projected angles) that stays defined
    // as i → 0 — the conventional way small-body codes form λ.
    // Argument of latitude u = ω + ν: angle from the node line n̂ to r in
    // the orbit plane, using the in-plane basis (n̂, ĥ × n̂). Defined for any
    // i; at i = 0 Ω is arbitrary but λ = Ω + ω + M is not, which is all the
    // resonant angle needs.
    const nx = Math.cos(om), ny = Math.sin(om);
    const mx = -hz * ny / h, my = hz * nx / h, mz = (hx * ny - hy * nx) / h;
    const u = Math.atan2(x * mx + y * my + z * mz, x * nx + y * ny);
    let w, nu;
    if (e > 1e-10) {
        const cosNu = (ex * x + ey * y + ez * z) / (e * rr);
        nu = Math.acos(Math.max(-1, Math.min(1, cosNu)));
        if (rv < 0) nu = TWO_PI - nu;
        w = u - nu;
    } else { nu = u; w = 0; }
    let M;
    if (a > 0 && e < 1) {
        const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
        M = E - e * Math.sin(E);
    } else M = NaN;
    const norm = (t) => ((t * R2D) % 360 + 360) % 360;
    return {
        a, e, i: i * R2D, om: norm(om), w: norm(w), M: norm(M),
        varpi: norm(om + w), lambda: norm(om + w + M),
    };
}

// ── Jupiter / Saturn ────────────────────────────────────────────────────────

/**
 * Standish (1992) "Keplerian Elements for Approximate Positions of the Major
 * Planets", Table 1 (J2000 ecliptic, mean elements, valid 1800–2050):
 * value at J2000 and rate per Julian century. FALLBACK ONLY — used when the
 * route could not reach Horizons, and disclosed as `standish-mean`.
 */
export const STANDISH = Object.freeze({
    jupiter: { a: [5.20288700, -0.00011607], e: [0.04838624, -0.00013253], i: [1.30439695, -0.00183714],
               L: [34.39644051, 3034.74612775], varpi: [14.72847983, 0.21252668], om: [100.47390909, 0.20469106] },
    saturn:  { a: [9.53667594, -0.00125060], e: [0.05386179, -0.00050991], i: [2.48599187, 0.00193609],
               L: [49.95424423, 1222.49362201], varpi: [92.59887831, -0.41897216], om: [113.66242448, -0.28867794] },
});

export function standishElements(key, jd) {
    const t = STANDISH[key];
    const T = (jd - 2451545.0) / 36525;
    const f = ([v0, rate]) => v0 + rate * T;
    const a = f(t.a), e = f(t.e), i = f(t.i), L = f(t.L), varpi = f(t.varpi), om = f(t.om);
    const w = varpi - om, M = L - varpi;
    return { a, e, i, om: ((om % 360) + 360) % 360, w: ((w % 360) + 360) % 360, M: ((M % 360) + 360) % 360,
        varpi: ((varpi % 360) + 360) % 360, lambda: ((L % 360) + 360) % 360 };
}

export function planetGm(key) { return K2 * (1 + 1 / MASS_RATIO[key]); }

/**
 * Perturber states at `epoch`: Horizons vectors when the route supplied them
 * for THAT epoch, Standish mean elements otherwise — and says which.
 * @param {{ jupiter?: {jd,r,v}, saturn?: {jd,r,v} }} vectors
 */
export function perturberStates(vectors, epoch) {
    const out = {};
    for (const key of ['jupiter', 'saturn']) {
        const p = vectors?.[key];
        if (p && Math.abs(p.jd - epoch) < 1e-6 && p.r?.length === 3 && p.v?.length === 3) {
            out[key] = { r: [...p.r], v: [...p.v], source: 'horizons' };
        } else {
            out[key] = { ...stateFromElements(standishElements(key, epoch), planetGm(key)), source: 'standish-mean' };
        }
        out[key].gm = planetGm(key);
        out[key].m = 1 / MASS_RATIO[key];
        out[key].el = elementsFromState(out[key].r, out[key].v, out[key].gm);
    }
    return out;
}

// ── The resonant angle and the analytic tadpole ─────────────────────────────

/** φ = λ − λ_J in (−180, 180]. Positive ⇒ leading Jupiter (L4 side). */
export function resonantAngle(lambda, lambdaJ) { return wrap180(lambda - lambdaJ); }
export function campOf(phi) { return phi > 0 ? 'L4' : 'L5'; }

/**
 * The co-orbital potential of the averaged planar circular problem, in units
 * of μ n² a²:  F(φ) = 1/(2|sin(φ/2)|) − cos φ  (direct 1/Δ term at equal radii
 * minus the indirect term). F has its minimum 1/2 at φ = ±60° (L4/L5) and
 * the value 3/2 at φ = 180° (L3).
 */
export function coorbitalPotential(phiDeg) {
    const p = Math.abs(phiDeg) * D2R;
    return 1 / (2 * Math.abs(Math.sin(p / 2))) - Math.cos(p);
}

/**
 * THE INTEGRAL. With x = (a − a_J)/a_J ≪ 1 and the disturbing function
 * R = μ n²a² F(φ), Lagrange's equations give
 *     dφ/dt = −(3/2) n x,      dx/dt = 2 μ n F′(φ)
 * so  d/dt[ (3/4) x² + 2μ F(φ) ] = (3/2) x·2μnF′ + 2μF′·(−(3/2) n x) = 0.
 * C = (3/4)x² + 2μF(φ) is conserved; the separatrix passes through L3
 * (φ = 180°, x = 0): C_sep = 3μ, whose near turning point is the textbook
 * 23.9° (Murray & Dermott 1999 §3.9) — the gate pins that.
 */
export function tadpoleInvariant(x, phiDeg, mu = MU_JUPITER) {
    return 0.75 * x * x + 2 * mu * coorbitalPotential(phiDeg);
}

function bisect(f, lo, hi, it = 80) {
    let flo = f(lo);
    for (let k = 0; k < it; k++) {
        const mid = 0.5 * (lo + hi), fm = f(mid);
        if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else hi = mid;
    }
    return 0.5 * (lo + hi);
}

/** Near turning point of the separatrix (degrees) — 23.9° for any small μ. */
export function separatrixMinAngle() {
    return bisect((p) => coorbitalPotential(p) - 1.5, 1, 60);
}

/**
 * Analytic libration from ONE osculating state.
 * @returns {{ regime:'tadpole'|'beyond-separatrix', camp, phiMin, phiMax, amplitude, x, C, Csep }}
 *   phiMin/phiMax are |φ| turning points (degrees, folded onto the L4 side);
 *   amplitude = (phiMax − phiMin)/2. Beyond the separatrix the averaged
 *   model no longer describes a tadpole and only phiMin is reported.
 */
export function analyticLibration(a, aJ, phiDeg, mu = MU_JUPITER) {
    const x = (a - aJ) / aJ;
    const C = tadpoleInvariant(x, phiDeg, mu);
    const Csep = 3 * mu;
    const target = C / (2 * mu);
    const g = (p) => coorbitalPotential(p) - target;
    const camp = campOf(phiDeg);
    if (C >= Csep) {
        return { regime: 'beyond-separatrix', camp, phiMin: bisect(g, 1e-3, 60), phiMax: null, amplitude: null, x, C, Csep };
    }
    const phiMin = bisect(g, 1e-3, 60);
    const phiMax = bisect(g, 60, 180);
    return { regime: 'tadpole', camp, phiMin, phiMax, amplitude: (phiMax - phiMin) / 2, x, C, Csep };
}

/** Small-amplitude libration period (days): T = P / √(27μ/4). */
export function smallAmplitudePeriodDays(aJ = STANDISH.jupiter.a[0], mu = MU_JUPITER) {
    const P = TWO_PI / Math.sqrt(K2 * (1 + M_JUPITER) / (aJ * aJ * aJ));
    return P / Math.sqrt(27 * mu / 4);
}

// ── The wire format (/api/trojans/catalog) ──────────────────────────────────

/**
 * 'trojan-v2' — the LEAN rows the route ships, measured on the 2026-11-03
 * catalogue: 2.47 MB → 1.77 MB raw, 785 → 652 KB brotli. Dropped from the
 * shared NEO row (js/neo-orbits.js NEO_ROW_COLUMNS) because they carry
 * NOTHING for this population: `cls` (always TJN), `flags` (always 0), `q`
 * (derivable, always null), `tp` (folded into `ma` below), `moid` (EARTH
 * MOID — ~4 AU for every Trojan). Two encodings:
 *   epoch_off   days from the body's join epoch (0 for ~90 % of rows)
 *   name        the name AFTER the designation ("624 Hektor (A907 CF)" →
 *               "Hektor (A907 CF)"); null when SBDB's name is only the
 *               designation. `recordsFromCatalog` re-joins it.
 * Readers resolve columns BY NAME, so adding a column is additive.
 */
export const TROJAN_WIRE_FORMAT = 'trojan-v2';
export const TROJAN_WIRE_COLUMNS = Object.freeze([
    'des', 'name', 'H', 'e', 'a', 'i', 'om', 'w', 'ma', 'epoch_off',
    'diam', 'albedo', 'spec', 'cc', 'arc_d', 'n_obs',
]);

/** Records (route parser output) → lean rows at `joinEpoch`. */
export function encodeCatalogRows(records, joinEpoch) {
    return records.map((r) => {
        let ma = r.ma;
        // An elliptic row anchored by perihelion time only: express it as a
        // mean anomaly at its own epoch so `tp` never has to ship.
        if (ma == null && r.tp != null && r.a > 0 && r.epoch != null) {
            const n = Math.sqrt(K2 / (r.a * r.a * r.a)) * R2D;
            ma = Number(((((n * (r.epoch - r.tp)) % 360) + 360) % 360).toFixed(4));
        }
        let name = r.name ?? null;
        if (name && r.des && name.startsWith(`${r.des} `)) name = name.slice(r.des.length + 1);
        const off = r.epoch == null || joinEpoch == null ? null : Number((r.epoch - joinEpoch).toFixed(2));
        const row = { ...r, name, ma, epoch_off: off };
        return TROJAN_WIRE_COLUMNS.map(c => (row[c] === undefined ? null : row[c]));
    });
}

/**
 * Any /api/trojans/catalog body → records { des, name, H, e, a, i, om, w,
 * ma, epoch, diam, albedo, spec, cc, arc_d, n_obs }. Reads 'trojan-v2' and
 * the original NEO-column rows (the committed real-data fixture is that
 * shape — never hand-edit it to convert).
 */
export function recordsFromCatalog(body) {
    const cols = body?.columns ?? [];
    const at = Object.fromEntries(cols.map((c, k) => [c, k]));
    const join = body?.epoch?.epoch ?? null;
    const lean = body?.format === TROJAN_WIRE_FORMAT;
    return (body?.rows ?? []).map((row) => {
        const get = (c) => (at[c] == null ? null : row[at[c]] ?? null);
        const rec = {};
        for (const c of ['des', 'name', 'H', 'e', 'a', 'i', 'om', 'w', 'ma', 'tp', 'diam', 'albedo', 'spec', 'cc', 'arc_d', 'n_obs']) rec[c] = get(c);
        if (lean) {
            const off = get('epoch_off');
            rec.epoch = off == null || join == null ? null : join + off;
            if (rec.name) rec.name = `${rec.des} ${rec.name}`;
        } else {
            rec.epoch = get('epoch');
        }
        return rec;
    });
}

// ── Catalogue rows → analysed records ───────────────────────────────────────

/** Best diameter: measured → H with measured albedo → H with the population mean. */
export function trojanDiameterKm(rec) {
    const d = Number(rec.diam);
    if (Number.isFinite(d) && d > 0 && rec.diam !== null) return { km: d, basis: 'measured' };
    const H = Number(rec.H);
    if (rec.H == null || !Number.isFinite(H)) return { km: null, basis: 'none' };
    const pv = Number(rec.albedo);
    const measuredPv = rec.albedo != null && Number.isFinite(pv) && pv > 0 && pv <= 1;
    const albedo = measuredPv ? pv : TROJAN_MEAN_ALBEDO;
    return { km: (1329 / Math.sqrt(albedo)) * Math.pow(10, -H / 5), basis: measuredPv ? 'H+measured-albedo' : 'H+population-albedo' };
}

/**
 * Bring a record's elements to the join epoch. Most rows share it; for the
 * rest (poorly observed objects whose SBDB solution is older) the mean
 * anomaly is advanced two-body, and `epochOffsetDays` says by how much —
 * that offset is an error bar, not a detail.
 */
export function elementsAtEpoch(rec, epoch) {
    const a = Number(rec.a), e = Number(rec.e);
    if (!(a > 0) || !(e >= 0 && e < 1)) return null;
    const n = Math.sqrt(K2 / (a * a * a)) * R2D;       // deg/day
    let M;
    if (rec.ma != null && rec.epoch != null) M = Number(rec.ma) + n * (epoch - Number(rec.epoch));
    else if (rec.tp != null) M = n * (epoch - Number(rec.tp));
    else return null;
    M = ((M % 360) + 360) % 360;
    const el = { a, e, i: Number(rec.i), om: Number(rec.om), w: Number(rec.w), M };
    if (![el.i, el.om, el.w].every(Number.isFinite)) return null;
    return { el, epochOffsetDays: rec.epoch != null ? epoch - Number(rec.epoch) : null };
}

/**
 * Instant (single-epoch) analysis of one catalogue record against Jupiter.
 * @param {object} rec    a row as a record (js/neo-orbits.js rowToRecord)
 * @param {object} jup    perturberStates(...).jupiter
 * @param {number} epoch  JD TDB of the join
 */
export function analyseRecord(rec, jup, epoch, aligned = null) {
    const at = elementsAtEpoch(rec, epoch);
    if (!at) return null;
    let { el } = at;
    const { epochOffsetDays } = at;
    if (aligned?.state) {
        const o = elementsFromState(aligned.state.r, aligned.state.v, K2);
        el = { a: o.a, e: o.e, i: o.i, om: o.om, w: o.w, M: o.M };
    }
    const lambda = ((el.om + el.w + el.M) % 360 + 360) % 360;
    const phi = resonantAngle(lambda, jup.el.lambda);
    const lib = analyticLibration(el.a, jup.el.a, phi);
    const size = trojanDiameterKm(rec);
    return {
        des: rec.des, name: rec.name ?? null, H: rec.H ?? null,
        a: el.a, e: el.e, i: el.i, lambda, phi, camp: campOf(phi),
        offsetFromLagrange: phi > 0 ? phi - 60 : phi + 60,
        analytic: lib,
        diameterKm: size.km, sizeBasis: size.basis,
        albedo: rec.albedo ?? null, spec: rec.spec ?? null,
        epochOffsetDays, alignMethod: aligned?.method ?? (epochOffsetDays ? 'two-body' : 'epoch'),
        el, state: aligned?.state ?? null,
    };
}

// ── N-body: Sun + Jupiter + Saturn + massless Trojans ───────────────────────

/**
 * Heliocentric accelerations for the two planets (indirect terms included).
 * P = [xJ,yJ,zJ, xS,yS,zS]; writes A (same layout).
 */
function planetAccel(P, m, gmSelf, A, useSaturn) {
    const nP = useSaturn ? 2 : 1;
    for (let j = 0; j < nP; j++) {
        const xj = P[3 * j], yj = P[3 * j + 1], zj = P[3 * j + 2];
        const rj = Math.hypot(xj, yj, zj), rj3 = rj * rj * rj;
        let ax = -gmSelf[j] * xj / rj3, ay = -gmSelf[j] * yj / rj3, az = -gmSelf[j] * zj / rj3;
        for (let k = 0; k < nP; k++) {
            if (k === j) continue;
            const xk = P[3 * k], yk = P[3 * k + 1], zk = P[3 * k + 2];
            const dx = xk - xj, dy = yk - yj, dz = zk - zj;
            const d = Math.hypot(dx, dy, dz), d3 = d * d * d;
            const rk = Math.hypot(xk, yk, zk), rk3 = rk * rk * rk;
            const g = K2 * m[k];
            ax += g * (dx / d3 - xk / rk3); ay += g * (dy / d3 - yk / rk3); az += g * (dz / d3 - zk / rk3);
        }
        A[3 * j] = ax; A[3 * j + 1] = ay; A[3 * j + 2] = az;
    }
}

/**
 * Integrate the two planets once with RK4 at HALF the particle step and keep
 * every position, so each particle's RK4 can read the perturbers at t,
 * t + dt/2 and t + dt without re-integrating them 20 000 times.
 */
export function planetTrack({ jupiter, saturn }, steps, dtDays, { useSaturn = true, circularJupiter = false } = {}) {
    const h = dtDays / 2, N = 2 * steps + 1;
    const nP = useSaturn ? 2 : 1;
    const pos = new Float64Array(N * 6), vel = new Float64Array(N * 6);
    const m = [jupiter.m, saturn?.m ?? 0];
    const gmSelf = [K2 * (1 + m[0]), K2 * (1 + m[1])];
    const P = new Float64Array(6), V = new Float64Array(6);
    P.set(jupiter.r, 0); V.set(jupiter.v, 0);
    if (useSaturn) { P.set(saturn.r, 3); V.set(saturn.v, 3); }
    if (circularJupiter) {
        // Test-only exact circular, planar Jupiter (the restricted problem the
        // analytic invariant is derived in). Positions are closed-form.
        const aJ = Math.hypot(P[0], P[1]), nJ = Math.sqrt(gmSelf[0] / (aJ * aJ * aJ)), th0 = Math.atan2(P[1], P[0]);
        for (let s = 0; s < N; s++) {
            const th = th0 + nJ * h * s;
            pos[6 * s] = aJ * Math.cos(th); pos[6 * s + 1] = aJ * Math.sin(th);
            vel[6 * s] = -aJ * nJ * Math.sin(th); vel[6 * s + 1] = aJ * nJ * Math.cos(th);
        }
        return { pos, vel, h, N, m: [m[0], 0], useSaturn: false };
    }
    const k1 = new Float64Array(6), k2 = new Float64Array(6), k3 = new Float64Array(6), k4 = new Float64Array(6);
    const Pt = new Float64Array(6);
    const store = (s) => { pos.set(P, 6 * s); vel.set(V, 6 * s); };
    store(0);
    for (let s = 1; s < N; s++) {
        planetAccel(P, m, gmSelf, k1, useSaturn);
        const v1 = V.slice();
        for (let q = 0; q < 3 * nP; q++) Pt[q] = P[q] + 0.5 * h * v1[q];
        planetAccel(Pt, m, gmSelf, k2, useSaturn);
        const v2 = v1.map((v, q) => v + 0.5 * h * k1[q]);
        for (let q = 0; q < 3 * nP; q++) Pt[q] = P[q] + 0.5 * h * v2[q];
        planetAccel(Pt, m, gmSelf, k3, useSaturn);
        const v3 = v1.map((v, q) => v + 0.5 * h * k2[q]);
        for (let q = 0; q < 3 * nP; q++) Pt[q] = P[q] + h * v3[q];
        planetAccel(Pt, m, gmSelf, k4, useSaturn);
        const v4 = v1.map((v, q) => v + h * k3[q]);
        for (let q = 0; q < 3 * nP; q++) {
            P[q] += (h / 6) * (v1[q] + 2 * v2[q] + 2 * v3[q] + v4[q]);
            V[q] += (h / 6) * (k1[q] + 2 * k2[q] + 2 * k3[q] + k4[q]);
        }
        store(s);
    }
    return { pos, vel, h, N, m: [m[0], useSaturn ? m[1] : 0], useSaturn };
}

/**
 * Defaults: 4 small-amplitude libration periods at a 40-day step.
 * THE STEP IS MEASURED, NOT GUESSED (2026-11-03, 800 well-determined
 * Trojans, 600 yr, against a 5-day reference): |Δ amplitude| median 0.001°,
 * max 0.011° at 40 d — the same as at 10 d and 20 d — and zero regime flips.
 * On the WHOLE population 20 d → 40 d changed 5 regimes, all U9 orbits from
 * 1–7-day arcs (chaotic: any perturbation flips them, and the quality flag
 * already says their verdict means little), and halved the run (42 → 21 s).
 * The libration PERIOD carries a ~0.1–0.4 yr floor from the annual sampling
 * cadence, not from the step.
 */
export const SWARM_RUN = Object.freeze({ years: 600, dtDays: 40, sampleDays: 365.25, encounterHill: 3 });
/** Epoch alignment keeps the finer step: it is ~0.5 s total and its gate is pinned at 20 d. */
export const ALIGN_DT_DAYS = 20;
export const HILL_RADIUS_AU = STANDISH.jupiter.a[0] * Math.cbrt(M_JUPITER / 3);

/**
 * Integrate one massless particle against a precomputed planet track and
 * MEASURE its resonant angle.
 *
 * Regimes (from the unwrapped φ series):
 *   'L4' / 'L5'     tadpole — φ never leaves (0°, 180°) / (−180°, 0°)
 *   'horseshoe'     φ crosses 180° but never 0° (encloses L3, L4 and L5)
 *   'circulating'   φ runs through a full 360° — not co-orbital at all
 *   'encounter'     came within `encounterHill` Hill radii of Jupiter; the
 *                   run stops (a 20-day RK4 step cannot resolve the flyby)
 *
 * @returns {{ regime, phiMin, phiMax, phiMean, amplitude, periodYears|null,
 *             aMean, eMean, iMean, eMax, iMax, samples, encounterYear|null, phi?:Float32Array }}
 */
export function integrateParticle(state0, track, { dtDays, sampleDays, encounterHill = SWARM_RUN.encounterHill, keepSeries = false, returnState = false } = {}) {
    const { pos, h, N, m } = track;
    const steps = (N - 1) / 2;
    const sampleEvery = Number.isFinite(sampleDays) ? Math.max(1, Math.round(Math.abs(sampleDays / dtDays))) : Infinity;
    const nSamples = Number.isFinite(sampleEvery) ? Math.floor(steps / sampleEvery) + 1 : 1;
    const phiSeries = new Float64Array(nSamples);
    const mJ = m[0], mS = m[1];
    const gJ = K2 * mJ, gS = K2 * mS;
    const enc2 = Math.pow(encounterHill * HILL_RADIUS_AU, 2);
    const gmJ = K2 * (1 + mJ);
    let x = state0.r[0], y = state0.r[1], z = state0.r[2];
    let vx = state0.v[0], vy = state0.v[1], vz = state0.v[2];
    let ax = 0, ay = 0, az = 0;
    const accel = (px, py, pz, s) => {
        const o = 6 * s;
        const r = Math.hypot(px, py, pz), r3 = r * r * r;
        ax = -K2 * px / r3; ay = -K2 * py / r3; az = -K2 * pz / r3;
        const jx = pos[o], jy = pos[o + 1], jz = pos[o + 2];
        let dx = jx - px, dy = jy - py, dz = jz - pz;
        let d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2), d3 = d2 * d;
        let rk = Math.hypot(jx, jy, jz), rk3 = rk * rk * rk;
        ax += gJ * (dx / d3 - jx / rk3); ay += gJ * (dy / d3 - jy / rk3); az += gJ * (dz / d3 - jz / rk3);
        if (gS) {
            const sx = pos[o + 3], sy = pos[o + 4], sz = pos[o + 5];
            dx = sx - px; dy = sy - py; dz = sz - pz;
            d2 = dx * dx + dy * dy + dz * dz; d = Math.sqrt(d2); d3 = d2 * d;
            rk = Math.hypot(sx, sy, sz); rk3 = rk * rk * rk;
            ax += gS * (dx / d3 - sx / rk3); ay += gS * (dy / d3 - sy / rk3); az += gS * (dz / d3 - sz / rk3);
        }
    };
    let aSum = 0, eSum = 0, iSum = 0, eMax = 0, iMax = 0, ns = 0, encounterYear = null;
    let unwrapped = 0, prevPhi = null;
    const sample = (s) => {
        const o = 6 * s;
        const el = elementsFromState([x, y, z], [vx, vy, vz], K2);
        const jel = elementsFromState([pos[o], pos[o + 1], pos[o + 2]], [track.vel[o], track.vel[o + 1], track.vel[o + 2]], gmJ);
        const phi = wrap180(el.lambda - jel.lambda);
        if (prevPhi == null) unwrapped = phi;
        else unwrapped += wrap180(phi - prevPhi);
        prevPhi = phi;
        phiSeries[ns] = unwrapped;
        aSum += el.a; eSum += el.e; iSum += el.i;
        if (el.e > eMax) eMax = el.e;
        if (el.i > iMax) iMax = el.i;
        ns++;
    };
    sample(0);
    for (let k = 0; k < steps; k++) {
        const s0 = 2 * k;
        // RK4 (step dt = 2h) with the perturbers read from the half-step track
        const dt = 2 * h;
        accel(x, y, z, s0);
        const k1x = ax, k1y = ay, k1z = az, v1x = vx, v1y = vy, v1z = vz;
        const v2x = vx + h * k1x, v2y = vy + h * k1y, v2z = vz + h * k1z;
        accel(x + h * v1x, y + h * v1y, z + h * v1z, s0 + 1);
        const k2x = ax, k2y = ay, k2z = az;
        const v3x = vx + h * k2x, v3y = vy + h * k2y, v3z = vz + h * k2z;
        accel(x + h * v2x, y + h * v2y, z + h * v2z, s0 + 1);
        const k3x = ax, k3y = ay, k3z = az;
        const v4x = vx + dt * k3x, v4y = vy + dt * k3y, v4z = vz + dt * k3z;
        accel(x + dt * v3x, y + dt * v3y, z + dt * v3z, s0 + 2);
        const k4x = ax, k4y = ay, k4z = az;
        x += (dt / 6) * (v1x + 2 * v2x + 2 * v3x + v4x);
        y += (dt / 6) * (v1y + 2 * v2y + 2 * v3y + v4y);
        z += (dt / 6) * (v1z + 2 * v2z + 2 * v3z + v4z);
        vx += (dt / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
        vy += (dt / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
        vz += (dt / 6) * (k1z + 2 * k2z + 2 * k3z + k4z);
        const o = 6 * (s0 + 2);
        const ddx = x - pos[o], ddy = y - pos[o + 1], ddz = z - pos[o + 2];
        if (ddx * ddx + ddy * ddy + ddz * ddz < enc2) { encounterYear = Math.abs((k + 1) * dt) / JULIAN_YEAR_D; break; }
        if ((k + 1) % sampleEvery === 0) sample(s0 + 2);
    }
    const summary = summarisePhi(phiSeries.subarray(0, ns), {
        sampleYears: Number.isFinite(sampleEvery) ? (sampleEvery * Math.abs(dtDays)) / JULIAN_YEAR_D : 0,
        aMean: aSum / ns, eMean: eSum / ns, iMean: iSum / ns, eMax, iMax, encounterYear, keepSeries,
    });
    if (returnState) summary.state = { r: [x, y, z], v: [vx, vy, vz] };
    return summary;
}

/**
 * Regime, amplitude and period from an unwrapped φ series (degrees).
 * Exported so the gate can feed it synthetic series with known answers.
 */
export function summarisePhi(series, { sampleYears, aMean = null, eMean = null, iMean = null, eMax = null, iMax = null, encounterYear = null, keepSeries = false }) {
    const n = series.length;
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (let k = 0; k < n; k++) { const p = series[k]; if (p < lo) lo = p; if (p > hi) hi = p; sum += p; }
    const mean = sum / n;
    let regime;
    if (encounterYear != null) regime = 'encounter';
    else if (hi - lo >= 360) regime = 'circulating';
    else {
        // Fold the window onto (−180, 180] about its own centre so a tadpole
        // that happened to unwrap from −179° to 181° is not misread.
        const shift = 360 * Math.round(((lo + hi) / 2) / 360);
        const l = lo - shift, u = hi - shift;
        if (l > 0 && u < 180) regime = 'L4';
        else if (l > -180 && u < 0) regime = 'L5';
        else if ((l > 0 && u < 360) || (l > -360 && u < 0)) regime = 'horseshoe';
        else regime = 'circulating';
    }
    // Period: crossings of the mean with hysteresis (an eighth of the
    // half-range) so sample noise cannot add spurious crossings.
    let periodYears = null;
    if (regime !== 'circulating' && regime !== 'encounter' && n > 8) {
        const band = (hi - lo) / 16;
        const cross = [];
        let state = series[0] > mean ? 1 : -1;
        for (let k = 1; k < n; k++) {
            const d = series[k] - mean;
            if (state < 0 && d > band) {
                // interpolate the upward crossing of `mean` between k-1 and k
                const p0 = series[k - 1] - mean, p1 = d;
                cross.push((k - 1 + (p0 < 0 ? -p0 / (p1 - p0) : 0)) * sampleYears);
                state = 1;
            } else if (state > 0 && d < -band) state = -1;
        }
        if (cross.length >= 2) periodYears = (cross[cross.length - 1] - cross[0]) / (cross.length - 1);
    }
    const shift = 360 * Math.round(mean / 360);
    return {
        regime,
        phiMin: lo - shift, phiMax: hi - shift, phiMean: mean - shift,
        amplitude: (hi - lo) / 2,
        periodYears,
        aMean, eMean, iMean, eMax, iMax,
        samples: n, encounterYear,
        ...(keepSeries ? { phi: Float32Array.from(series, p => p - shift) } : {}),
    };
}

/**
 * Integrate a whole swarm. `particles` are { r, v } at the join epoch.
 * `onProgress(done, total)` lets a worker report; nothing here touches time.
 */
export function integrateSwarm(particles, perturbers, opts = {}) {
    const { years, dtDays, sampleDays } = { ...SWARM_RUN, ...opts };
    const steps = Math.ceil((years * JULIAN_YEAR_D) / dtDays);
    const track = planetTrack(perturbers, steps, dtDays, opts);
    const out = new Array(particles.length);
    for (let k = 0; k < particles.length; k++) {
        out[k] = integrateParticle(particles[k], track, { dtDays, sampleDays, encounterHill: opts.encounterHill, keepSeries: opts.keepSeries });
        if (opts.onProgress && (k % 250 === 0 || k === particles.length - 1)) opts.onProgress(k + 1, particles.length);
    }
    return { results: out, steps, dtDays, years, perturbers: { jupiter: perturbers.jupiter.source, saturn: opts.useSaturn === false ? 'off' : perturbers.saturn?.source } };
}

// ── Bringing every object to ONE epoch ──────────────────────────────────────

/**
 * Objects whose SBDB solution is older than this are carried to the join
 * epoch by N-BODY integration, not two-body. Measured on the 2026-11-03
 * catalogue: 1 644 of 16 445 rows sit off the shared epoch, many by ~12 yr
 * (single-opposition 2014 discoveries), and a two-body advance over 12 yr
 * ignores a full Jupiter orbit of perturbation — 143 of the 173 objects the
 * first full run called non-librating were exactly those rows.
 */
export const ALIGN_TWO_BODY_MAX_DAYS = 30;

/** Elements of a record AT ITS OWN epoch (mean anomaly as published). */
export function elementsAtOwnEpoch(rec) {
    const ep = Number(rec.epoch);
    if (rec.epoch == null || !Number.isFinite(ep)) return null;
    const at = elementsAtEpoch(rec, ep);
    return at ? { el: at.el, epoch: ep } : null;
}

/**
 * The planets' state at `jd`, integrated (Sun + Jupiter + Saturn) from the
 * join-epoch vectors — the same dynamics the swarm run uses, run backwards.
 */
export function planetsAt(perturbers, joinEpoch, jd, dtDays = ALIGN_DT_DAYS) {
    const span = jd - joinEpoch;
    if (Math.abs(span) < 1e-9) return perturbers;
    const n = Math.max(1, Math.ceil(Math.abs(span) / dtDays));
    const tr = planetTrack(perturbers, n, span / n);
    const o = 6 * (tr.N - 1);
    const pick = (k) => ({ r: Array.from(tr.pos.subarray(o + 3 * k, o + 3 * k + 3)), v: Array.from(tr.vel.subarray(o + 3 * k, o + 3 * k + 3)) });
    return {
        jupiter: { ...perturbers.jupiter, ...pick(0) },
        saturn: perturbers.saturn ? { ...perturbers.saturn, ...pick(1) } : perturbers.saturn,
    };
}

/**
 * Heliocentric states of `recs` at `joinEpoch`. Rows within
 * ALIGN_TWO_BODY_MAX_DAYS are advanced two-body; older ones are grouped by
 * epoch and integrated forward with the planets. Each result says HOW it got
 * there: 'epoch' | 'two-body' | 'n-body' | 'two-body-after-encounter'
 * (a row that met Jupiter on the way in keeps its two-body state, flagged).
 * @returns {Array<{ state:{r,v}|null, method:string, offsetDays:number|null }>}
 */
export function alignToEpoch(recs, perturbers, joinEpoch, { dtDays = ALIGN_DT_DAYS } = {}) {
    const out = new Array(recs.length);
    const groups = new Map();
    recs.forEach((rec, k) => {
        const at = elementsAtEpoch(rec, joinEpoch);
        if (!at) { out[k] = { state: null, method: 'unusable', offsetDays: null }; return; }
        const off = at.epochOffsetDays;
        const twoBody = { state: stateFromElements(at.el), offsetDays: off };
        if (off == null || Math.abs(off) <= ALIGN_TWO_BODY_MAX_DAYS) {
            out[k] = { ...twoBody, method: off ? 'two-body' : 'epoch' };
            return;
        }
        out[k] = { ...twoBody, method: 'two-body' };          // replaced below
        const ep = Number(rec.epoch);
        if (!groups.has(ep)) groups.set(ep, []);
        groups.get(ep).push(k);
    });
    for (const [ep, idx] of groups) {
        const planets = planetsAt(perturbers, joinEpoch, ep, dtDays);
        const span = joinEpoch - ep;
        const n = Math.max(1, Math.ceil(Math.abs(span) / dtDays));
        const h = span / n;
        const track = planetTrack(planets, n, h);
        for (const k of idx) {
            const own = elementsAtOwnEpoch(recs[k]);
            if (!own) continue;
            const r = integrateParticle(stateFromElements(own.el), track, { dtDays: h, sampleDays: Infinity, returnState: true });
            if (r.regime === 'encounter') out[k].method = 'two-body-after-encounter';
            else out[k] = { state: r.state, method: 'n-body', offsetDays: out[k].offsetDays };
        }
    }
    return out;
}

// ── Orbit quality ───────────────────────────────────────────────────────────

/**
 * THE ONE RULE for whether an orbit is known well enough for a libration
 * verdict to mean much. 'short-arc' = JPL condition code U ≥ 6, OR a data
 * arc under a year, OR a solution off the shared epoch (JPL has not refit it
 * recently — almost always because it has not been re-observed). 'unknown'
 * = the route could not supply the quality columns. The analysis script, the
 * report builder and the dynamics artifact all call this.
 */
export function orbitQuality({ cc = null, arc_d = null } = {}, alignMethod = 'epoch') {
    const U = cc == null || cc === '' ? null : Number(String(cc).replace(/\D/g, ''));
    const arc = arc_d == null || arc_d === '' ? null : Number(arc_d);
    if (U == null && arc == null) return 'unknown';
    return (U != null && U >= 6) || (arc != null && arc < 365) || (alignMethod && alignMethod !== 'epoch')
        ? 'short-arc' : 'well-determined';
}

// ── The precomputed dynamics artifact (data/trojans/trojans-dynamics.json) ──

/**
 * What a PAGE loads instead of integrating: the full-population run costs
 * ~3 CPU-minutes (measured 2026-11-03: 45 s on 4 threads for 600 yr), far past
 * a browser frame budget and a Vercel function's 60 s, so it is computed
 * offline (scripts/analyze-trojans.mjs, refreshed by
 * .github/workflows/trojans-refresh.yml) and shipped as compact rows.
 * COLUMNAR (`data: { column: [...] }`), which brotli packs 18 % smaller than
 * the same rows (284 vs 347 KB, measured on the 2026-11-03 population).
 * Categorical fields are small integers indexing `codes`; numbers are rounded
 * to what the integration supports (amplitudes to 0.1°, periods to 1 yr).
 */
export const DYNAMICS_FORMAT = 'trojan-dynamics-v1';
export const DYNAMICS_CODES = Object.freeze({
    regime: Object.freeze(['L4', 'L5', 'horseshoe', 'circulating', 'encounter']),
    quality: Object.freeze(['well-determined', 'short-arc', 'unknown']),
    size: Object.freeze(['measured', 'H+measured-albedo', 'H+population-albedo', 'none']),
});
export const DYNAMICS_COLUMNS = Object.freeze([
    'des', 'regime', 'amp', 'period', 'phi_mean', 'phi_min', 'phi_max',
    'a_mean', 'e_mean', 'i_mean', 'diam', 'size', 'quality', 'phi0',
]);

const rnd = (v, dp) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(dp)));

/**
 * @param {object[]} analysed  analyseRecord outputs (with .rec = the source record)
 * @param {object[]} results   integrateSwarm results, same order
 * @param {object}   meta      provenance + run + summary, copied verbatim
 */
export function encodeDynamics(analysed, results, meta = {}) {
    const code = (table, v) => { const k = DYNAMICS_CODES[table].indexOf(v); if (k < 0) throw new Error(`encodeDynamics: unknown ${table} '${v}'`); return k; };
    const rows = analysed.map((a, k) => {
        const r = results[k];
        const D = a.diameterKm;
        return [
            a.des, code('regime', r.regime), rnd(r.amplitude, 1), rnd(r.periodYears, 0),
            rnd(r.phiMean, 1), rnd(r.phiMin, 1), rnd(r.phiMax, 1),
            rnd(r.aMean, 4), rnd(r.eMean, 3), rnd(r.iMean, 1),
            D == null ? null : rnd(D, D < 10 ? 1 : 0), code('size', a.sizeBasis),
            code('quality', orbitQuality(a.rec ?? {}, a.alignMethod)), rnd(a.phi, 1),
        ];
    });
    const data = Object.fromEntries(DYNAMICS_COLUMNS.map((c, j) => [c, rows.map(r => r[j])]));
    return { format: DYNAMICS_FORMAT, ...meta, codes: DYNAMICS_CODES, columns: [...DYNAMICS_COLUMNS], count: rows.length, data };
}

/** Artifact → objects with the categorical codes expanded. */
export function decodeDynamics(doc) {
    if (doc?.format !== DYNAMICS_FORMAT) throw new Error(`decodeDynamics: expected ${DYNAMICS_FORMAT}, got ${doc?.format}`);
    const codes = doc.codes ?? DYNAMICS_CODES;
    const n = doc.count ?? doc.data?.[doc.columns[0]]?.length ?? 0;
    return Array.from({ length: n }, (_, k) => {
        const o = {};
        for (const c of doc.columns) o[c] = doc.data[c]?.[k] ?? null;
        o.regime = codes.regime[o.regime]; o.size = codes.size[o.size]; o.quality = codes.quality[o.quality];
        return o;
    });
}

// ── Population statistics ───────────────────────────────────────────────────

/** Counts per camp + the L4/L5 ratio with its binomial (Wilson) 68 % interval. */
export function campRatio(nL4, nL5) {
    const n = nL4 + nL5;
    if (!n || !nL5) return { nL4, nL5, ratio: null, lo: null, hi: null };
    const p = nL4 / n, z = 1, z2 = z * z;
    const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
    const half = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / (1 + z2 / n);
    const toRatio = (q) => q / (1 - q);
    return { nL4, nL5, ratio: nL4 / nL5, lo: toRatio(centre - half), hi: toRatio(centre + half) };
}
