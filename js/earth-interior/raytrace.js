/**
 * raytrace.js — seismic rays through a spherically symmetric Earth (PREM).
 * Pure kernel. Gate: `tests/earth-interior-raytrace.mjs`.
 * Plan: `INNER_EARTH_PLAN.md` §10 (T1 of our own tomography, PP-P1).
 *
 * ── THE METHOD ───────────────────────────────────────────────────────────
 * Ray theory in a spherical, radially varying Earth. A ray keeps its ray
 * parameter p = r·sin(i)/v (s/rad) for its whole path — that IS Snell's law,
 * at every discontinuity included — and turns where η(r) = r/v(r) falls to
 * p. Distance and time follow from
 *      dΔ/dr = p / (r·√(η² − p²)),     dT/dr = η² / (r·√(η² − p²)).
 * Each PREM region is cut into thin shells inside which the speed follows a
 * BULLEN LAW v = a·r^b (fitted through the shell's own end values), for
 * which both integrals are EXACT:
 *      Δ = [acos(p/η)] / (1 − b),      T = [√(η² − p²)] / (1 − b)
 * between the shell's radii — no quadrature, so the 1/√ singularity at the
 * turning point costs nothing (the classic method of Bullen and of the τ-p
 * codes). The only approximation is the Bullen fit to PREM's polynomials
 * inside a shell; the gate measures it against direct quadrature on the
 * polynomials themselves.
 *
 * ── WHAT IT IS NOT ───────────────────────────────────────────────────────
 * High-frequency geometric rays: no amplitudes, no diffraction (Pdiff along
 * the core is absent — the shadow zone is exactly where ray theory says
 * nothing arrives), no attenuation, no ellipticity, no 3-D structure. The
 * surface is PREM's crust with NO OCEAN (the 3 km ocean has Vs = 0, so no S
 * could leave a surface source — TauP's prem.nd makes the same choice).
 * S stops at the core (the liquid outer core carries no shear: SKS/ScS
 * conversions are a later step and are NOT drawn).
 */

import { R_EARTH_KM, premAt, PREM_REGIONS } from './prem.js';

export const DEFAULT_SHELL_KM = 5;

const SHELL_CACHE = new Map();

/**
 * Bullen shells for a velocity function, region by region (outer first).
 * `speed(rKm, regionIndex)` must evaluate region k's OWN law at r (no side ambiguity).
 * Returns [{ r1, r2, v1, v2, a, b, region }] with r1 < r2, surface first.
 */
export function buildShells(speed, regions, stepKm = DEFAULT_SHELL_KM) {
    const shells = [];
    for (let k = regions.length - 1; k >= 0; k--) {
        const g = regions[k];
        const n = Math.max(1, Math.ceil((g.rOuterKm - g.rInnerKm) / stepKm));
        for (let j = n - 1; j >= 0; j--) {
            const r1 = g.rInnerKm + (g.rOuterKm - g.rInnerKm) * j / n;
            const r2 = g.rInnerKm + (g.rOuterKm - g.rInnerKm) * (j + 1) / n;
            const v1 = speed(r1, k), v2 = speed(r2, k);
            let b = 0;
            if (r1 > 0 && v1 > 0 && v2 > 0) b = Math.log(v2 / v1) / Math.log(r2 / r1);
            const a = r1 > 0 ? v1 / r1 ** b : v2;     // the centre shell is uniform
            shells.push({ r1, r2, v1: r1 > 0 ? v1 : v2, v2, a, b: r1 > 0 ? b : 0, region: k, name: g.name });
        }
    }
    return shells;
}

/** PREM shells for 'P' or 'S' (no-ocean surface, as TauP). */
export function premShells(wave = 'P', stepKm = DEFAULT_SHELL_KM) {
    const key = `${wave}|${stepKm}`;
    if (SHELL_CACHE.has(key)) return SHELL_CACHE.get(key);
    const regions = PREM_REGIONS.slice(0, -1).map((g, i, arr) => (i === arr.length - 1 ? { ...g, rOuterKm: R_EARTH_KM } : g));
    const speed = (r, k) => {
        // Evaluate with the region's OWN polynomial: pick the side that puts r in region k.
        const g = regions[k];
        const side = r <= g.rInnerKm + 1e-9 ? 'above' : 'below';
        const s = premAt(Math.min(R_EARTH_KM, Math.max(0, r)), { ocean: false, side });
        return wave === 'S' ? s.vsKmS : s.vpKmS;
    };
    const shells = buildShells(speed, regions, stepKm);
    SHELL_CACHE.set(key, shells);
    return shells;
}

const etaOf = (s, r) => (s.b === 0 && s.r1 === 0 ? r / s.a : r ** (1 - s.b) / s.a);

/** One shell's [Δ, T] between radii lo < hi with η ≥ p throughout. */
function shellDT(s, p, lo, hi) {
    const e1 = etaOf(s, lo), e2 = etaOf(s, hi), k = 1 / (1 - s.b);
    // At the turning point η = p, acos(p/η) = 0 — including the vertical ray (p = 0)
    // turning at the centre, where p/η is 0/0 (the p = 0 NaN, measured on the first run).
    const ac = (e) => (e <= p ? 0 : Math.acos(p / e));
    const sq = (e) => Math.sqrt(Math.max(0, e * e - p * p));
    return [(ac(e2) - ac(e1)) * k, (sq(e2) - sq(e1)) * k];
}

/** Radius inside shell s where η = p (Bullen inversion). */
function turningRadius(s, p) {
    if (s.r1 === 0 && s.b === 0) return p * s.a;
    return (p * s.a) ** (1 / (1 - s.b));
}

/**
 * Trace one ray of parameter p (s/rad) from a source at `sourceDepthKm`,
 * leaving downward. Returns { p, deltaRad, deltaDeg, timeS, turnRKm, turnRegion,
 * phase, stopped } or null if the ray cannot leave the source downward
 * (p > η at the source). One-way legs are summed shell by shell; the leg
 * above the source is counted once, the rest twice.
 */
export function traceRay(p, { wave = 'P', sourceDepthKm = 0, stepKm = DEFAULT_SHELL_KM, shells = null } = {}) {
    const sh = shells ?? premShells(wave, stepKm);
    const rs = R_EARTH_KM - sourceDepthKm;
    let D = 0, T = 0, turn = null, turnRegion = null, stopped = null, deepest = null;
    for (const s of sh) {
        if (s.r1 >= rs) continue;                 // shell entirely above the source: no leg
        const hi = Math.min(s.r2, rs);
        if (s.v1 === 0 || s.v2 === 0) { stopped = s.name; turn = hi; turnRegion = s.region; break; }   // S into the liquid core
        const eHi = etaOf(s, hi);
        if (eHi < p) { turn = hi; turnRegion = s.region; break; }   // cannot enter: turns AT the interface
        const eLo = s.r1 > 0 ? etaOf(s, s.r1) : 0;
        deepest = s;
        if (eLo >= p && s.r1 > 0) {
            const [d, t] = shellDT(s, p, s.r1, hi); D += d; T += t;
        } else {
            const rt = Math.max(s.r1, Math.min(hi, turningRadius(s, p)));
            const [d, t] = shellDT(s, p, rt, hi); D += d; T += t;
            turn = rt; turnRegion = s.region; break;
        }
    }
    if (deepest === null && turn === null) return null;
    // Legs below the source are traversed twice (down and back up to it); the part
    // between source and surface once. Compute the above-source leg separately.
    let Du = 0, Tu = 0;
    for (const s of sh) {
        if (s.r2 <= rs) continue;
        const lo = Math.max(s.r1, rs);
        if (etaOf(s, lo) < p) return null;         // the upgoing leg cannot reach the surface
        const [d, t] = shellDT(s, p, lo, s.r2); Du += d; Tu += t;
    }
    if (etaOf(sh.find((s) => s.r1 < rs && s.r2 >= rs) ?? sh[0], rs) < p) return null;
    const deltaRad = 2 * D + Du, timeS = 2 * T + Tu;
    return { p, deltaRad, deltaDeg: deltaRad * 180 / Math.PI, timeS, turnRKm: turn, turnRegion,
             phase: phaseName(wave, turnRegion, turn, stopped), stopped };
}

/** Name a ray by where it turned (first-arrival nomenclature). */
export function phaseName(wave, turnRegion, turnR, stopped) {
    if (stopped) return wave === 'S' ? 'S→core' : null;
    const g = PREM_REGIONS[turnRegion]?.name ?? '';
    if (wave === 'S') return 'S';
    if (g === 'Inner core') return 'PKIKP';
    if (g === 'Outer core') return Math.abs(turnR - PREM_REGIONS[1].rInnerKm) < 1e-6 ? 'PKiKP' : 'PKP';
    return 'P';
}

/** η at the source = the largest p that still leaves it horizontally. */
export function maxRayParameter({ wave = 'P', sourceDepthKm = 0, stepKm = DEFAULT_SHELL_KM } = {}) {
    const sh = premShells(wave, stepKm), rs = R_EARTH_KM - sourceDepthKm;
    const s = sh.find((x) => x.r1 < rs && x.r2 >= rs) ?? sh[0];
    return etaOf(s, rs);
}

/**
 * Sweep p from horizontal takeoff to vertical and return rays grouped into
 * phase branches: { [phase]: [{p, deltaDeg, timeS, ...}] } in sweep order.
 */
export function travelTimeBranches({ wave = 'P', sourceDepthKm = 0, n = 2400, stepKm = DEFAULT_SHELL_KM } = {}) {
    const pMax = maxRayParameter({ wave, sourceDepthKm, stepKm });
    const out = {};
    for (let i = 0; i <= n; i++) {
        // Denser near p = 0 and near pMax via a smooth stretch.
        const u = i / n, p = pMax * (1 - u) * (1 - 1e-9);
        const ray = traceRay(p, { wave, sourceDepthKm, stepKm });
        if (!ray || !ray.phase || ray.phase === 'S→core') continue;
        (out[ray.phase] ??= []).push(ray);
    }
    return out;
}

/**
 * The ray's path as polar points [{ rKm, thetaRad }] from the source down to
 * the turning point and back up to the surface, for drawing. θ = 0 at the source.
 */
export function rayPath(p, { wave = 'P', sourceDepthKm = 0, stepKm = DEFAULT_SHELL_KM, maxPoints = 600 } = {}) {
    const ray = traceRay(p, { wave, sourceDepthKm, stepKm });
    if (!ray) return null;
    const sh = premShells(wave, stepKm), rs = R_EARTH_KM - sourceDepthKm;
    const down = [{ rKm: rs, thetaRad: 0 }];
    let th = 0;
    for (const s of sh) {
        if (s.r1 >= rs) continue;
        const hi = Math.min(s.r2, rs);
        const lo = Math.max(s.r1, ray.turnRKm ?? s.r1);
        if (lo >= hi) break;
        th += shellDT(s, p, lo, hi)[0];
        down.push({ rKm: lo, thetaRad: th });
        if (lo <= (ray.turnRKm ?? -1) + 1e-9) break;
    }
    const thTurn = th;
    // Up leg: mirror the down leg about the turning point, then the above-source leg.
    const up = down.slice(0, -1).reverse().map((q) => ({ rKm: q.rKm, thetaRad: 2 * thTurn - q.thetaRad }));
    const pts = [...down, ...up];
    let thUp = pts[pts.length - 1].thetaRad;
    for (const s of [...sh].reverse()) {
        if (s.r2 <= rs) continue;
        const lo = Math.max(s.r1, rs);
        thUp += shellDT(s, p, lo, s.r2)[0];
        pts.push({ rKm: s.r2, thetaRad: thUp });
    }
    // Decimate for drawing, always keeping the turning point and the ends.
    if (pts.length <= maxPoints) return { ...ray, points: pts };
    const stride = Math.ceil(pts.length / maxPoints), keep = [];
    pts.forEach((q, i) => { if (i % stride === 0 || i === pts.length - 1 || Math.abs(q.thetaRad - thTurn) < 1e-12) keep.push(q); });
    return { ...ray, points: keep };
}

/** First-arrival time at a distance (deg) per phase, by interpolating its branch; null where none arrives. */
export function arrivalsAt(deltaDeg, branches) {
    const out = [];
    for (const [phase, rays] of Object.entries(branches)) {
        for (let i = 1; i < rays.length; i++) {
            const a = rays[i - 1], b = rays[i];
            if ((a.deltaDeg - deltaDeg) * (b.deltaDeg - deltaDeg) <= 0 && a.deltaDeg !== b.deltaDeg) {
                const f = (deltaDeg - a.deltaDeg) / (b.deltaDeg - a.deltaDeg);
                out.push({ phase, timeS: a.timeS + f * (b.timeS - a.timeS), p: a.p + f * (b.p - a.p) });
            }
        }
    }
    return out.sort((x, y) => x.timeS - y.timeS);
}
