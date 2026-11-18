/**
 * phases.js — every seismic phase the page draws, composed from LEGS.
 * Pure kernel. Gate: `tests/earth-interior-phases.mjs`.
 * Plan: `INNER_EARTH_PLAN.md` §10 (T1b of our own tomography).
 *
 * ── THE IDEA ─────────────────────────────────────────────────────────────
 * raytrace.js integrates a ray through PREM's Bullen shells exactly. Every
 * other phase is the SAME ray parameter p carried through a sequence of
 * radially monotone LEGS, each one an exact sum of shell integrals:
 *
 *   direct      P, S (turn in the mantle)        down → turn → up
 *   core        PKP, PKIKP (P),  SKS, SKIKS       S in the mantle, P in the core
 *   up-going    p, s                             a deep source straight up
 *   depth       pP, sP, sS                       up to the surface, then a surface ray
 *   multiples   PP, SS                           a source ray, then a second surface ray
 *   reflected   PcP, ScS, ScP, PcS, PKiKP        down to a boundary and back up
 *   diffracted  Pdiff, Sdiff                     the grazing ray plus an arc ALONG the CMB
 *
 * Snell's law at every boundary IS "same p", so a conversion (ScP) or a
 * reflection needs nothing beyond choosing which shells each leg uses. A
 * leg exists only where η = r/v ≥ p along all of it; a phase is null for a
 * p it cannot carry.
 *
 * ── WHAT IS NOT CLAIMED ──────────────────────────────────────────────────
 * Times and slownesses only: no amplitudes, so a branch drawn here may be
 * too weak to see on a real seismogram (Pdiff decays with distance; PKiKP
 * at short range is a weak partial reflection). Diffraction is the
 * ray-theory limit (grazing ray + an arc at the CMB's slowness, as TauP
 * does), drawn to 160°. Ellipticity is ellipticity.js; topography, station
 * elevation and 3-D structure are not modelled.
 */

import { R_EARTH_KM, PREM_REGIONS } from './prem.js';
import { premShells, etaOf, shellDT, turningRadius } from './raytrace.js';

const CMB_KM = PREM_REGIONS.find((g) => g.name === 'Outer core').rOuterKm;   // 3480
const ICB_KM = PREM_REGIONS.find((g) => g.name === 'Inner core').rOuterKm;   // 1221.5
export const DIFFRACTION_MAX_DEG = 160;
const DEG = Math.PI / 180;

export const PHASES = Object.freeze([
    { name: 'P', kind: 'direct', family: 'mantle', wave: 'P' },
    { name: 'p', kind: 'upgoing', family: 'mantle', wave: 'P' },
    { name: 'PKP', kind: 'core', family: 'outer', wave: 'P' },
    { name: 'PKIKP', kind: 'core', family: 'inner', wave: 'P' },
    { name: 'PKiKP', kind: 'reflected', family: 'inner', wave: 'P' },
    { name: 'PcP', kind: 'reflected', family: 'outer', wave: 'P' },
    { name: 'Pdiff', kind: 'diffracted', family: 'outer', wave: 'P' },
    { name: 'pP', kind: 'depth', family: 'mantle', wave: 'P' },
    { name: 'sP', kind: 'depth', family: 'mantle', wave: 'S' },
    { name: 'PP', kind: 'multiple', family: 'mantle', wave: 'P' },
    { name: 'S', kind: 'direct', family: 'mantle', wave: 'S' },
    { name: 's', kind: 'upgoing', family: 'mantle', wave: 'S' },
    { name: 'SKS', kind: 'core', family: 'outer', wave: 'S' },
    { name: 'SKIKS', kind: 'core', family: 'inner', wave: 'S' },
    { name: 'ScS', kind: 'reflected', family: 'outer', wave: 'S' },
    { name: 'ScP', kind: 'reflected', family: 'outer', wave: 'S' },
    { name: 'PcS', kind: 'reflected', family: 'outer', wave: 'P' },
    { name: 'Sdiff', kind: 'diffracted', family: 'outer', wave: 'S' },
    { name: 'sS', kind: 'depth', family: 'mantle', wave: 'S' },
    { name: 'SS', kind: 'multiple', family: 'mantle', wave: 'S' },
]);
export const PHASE_INFO = Object.freeze(Object.fromEntries(PHASES.map((p) => [p.name, p])));

/**
 * A phase model over a pair of shell sets. Defaults to PREM; the gate builds
 * models over closed-form media (uniform, smooth) to check the composition.
 * `mix` (S in the solid mantle, P in the liquid outer core) is derived by
 * index: both sets are built over the same regions with the same step, so
 * shell i is the same radial interval in each.
 */
export function createPhaseModel({ shellsP = premShells('P'), shellsS = premShells('S'), cmbKm = CMB_KM, icbKm = ICB_KM, radiusKm = R_EARTH_KM } = {}) {
    if (shellsP.length !== shellsS.length) throw new Error('P and S shell sets must share their radial grid');
    // In the liquid outer core the S set has v = 0; SKS travels it as P. Inner core: P (SKIKS).
    const mix = shellsS.map((s, i) => (s.r2 <= cmbKm + 1e-9 ? shellsP[i] : s));
    const sets = { P: shellsP, S: shellsS, K: mix };
    const R = radiusKm;

    const solid = (s) => s.v1 > 0 && s.v2 > 0;

    /** Exact [Δ, T] of a monotone leg lo → hi, or null if the ray cannot run all of it. */
    // Shells run outermost first (r1 descending): binary-search the first one below r.
    function firstBelow(sh, r) {
        let a = 0, b = sh.length;
        while (a < b) { const m = (a + b) >> 1; if (sh[m].r1 < r) b = m; else a = m + 1; }
        return a;
    }

    function legDT(sh, p, lo, hi) {
        if (hi - lo < 1e-9) return [0, 0];
        let D = 0, T = 0;
        for (let i = firstBelow(sh, hi); i < sh.length; i++) {
            const s = sh[i];
            if (s.r2 <= lo) break;
            const a = Math.max(s.r1, lo), b = Math.min(s.r2, hi);
            if (!solid(s)) return null;
            const tol = 1e-9 * Math.max(1, p);
            if (a === s.r1 && b === s.r2) {
                // Whole shell (the usual case): η at the ends is cached — pow() dominated the cost.
                const e1 = s._e1 ??= (s.r1 > 0 ? etaOf(s, s.r1) : 0), e2 = s._e2 ??= etaOf(s, s.r2), k = s._k ??= 1 / (1 - s.b);
                if (e2 < p - tol || (s.r1 > 0 && e1 < p - tol)) return null;
                // Same expression as raytrace.js shellDT (atan2 form — accurate at a turning point).
                const q1 = e1 <= p ? 0 : Math.sqrt((e1 - p) * (e1 + p)), q2 = e2 <= p ? 0 : Math.sqrt((e2 - p) * (e2 + p));
                D += ((q2 > 0 ? Math.atan2(q2, p) : 0) - (q1 > 0 ? Math.atan2(q1, p) : 0)) * k;
                T += (q2 - q1) * k;
                continue;
            }
            const ea = a > 0 ? etaOf(s, a) : 0, eb = etaOf(s, b);
            if (eb < p - tol || (a > 0 && ea < p - tol)) return null;
            const [d, t] = shellDT(s, p, a, b); D += d; T += t;
        }
        return [D, T];
    }

    /** Where a ray of p leaving rTop downward turns: { r, inner:boolean, atInterface } or { stop } (liquid). */
    function turnBelow(sh, p, rTop) {
        for (let i = firstBelow(sh, rTop); i < sh.length; i++) {
            const s = sh[i];
            const hi = Math.min(s.r2, rTop);
            if (!solid(s)) return { stop: true, r: hi };
            if (etaOf(s, hi) < p) return { r: hi, atInterface: true };
            const eLo = s.r1 > 0 ? etaOf(s, s.r1) : 0;
            if (eLo < p) return { r: Math.max(s.r1, Math.min(hi, turningRadius(s, p))), atInterface: false };
        }
        return { r: 0, atInterface: false };
    }
    const etaAt = (sh, r) => { const s = sh.find((x) => x.r1 < r && x.r2 >= r) ?? sh.at(-1); return etaOf(s, r); };

    const where = (r) => (r >= cmbKm - 1e-9 ? 'mantle' : r >= icbKm - 1e-9 ? 'outer' : 'inner');

    // A full ray from radius rTop down to its turning point and up to the surface.
    function turning(setKey, p, rTop, want) {
        const sh = sets[setKey], t = turnBelow(sh, p, rTop);
        if (t.stop) return null;
        // A turn AT the ICB from above is a total reflection — PKiKP's job, not PKP's.
        if (t.atInterface && Math.abs(t.r - icbKm) < 1e-6) return null;
        if (where(t.r) !== want) return null;
        return [{ set: setKey, lo: t.r, hi: rTop, dir: -1 }, { set: setKey, lo: t.r, hi: R, dir: +1 }];
    }
    const surfaceRay = (setKey, p, want) => turning(setKey, p, R, want);
    const bounce = (down, up, rB, p, rs) => [{ set: down, lo: rB, hi: rs, dir: -1 }, { set: up, lo: rB, hi: R, dir: +1 }];

    /** Diffraction: the slowness of a ray grazing the CMB from above (the mantle's minimum η there). */
    const grazeP = {};
    function grazingP(setKey) {
        if (grazeP[setKey] != null) return grazeP[setKey];
        let mn = Infinity;
        for (const s of sets[setKey]) if (s.r1 >= cmbKm - 1e-9 && solid(s)) mn = Math.min(mn, etaOf(s, s.r1), etaOf(s, s.r2));
        return (grazeP[setKey] = mn);
    }

    function legsFor(name, p, rs) {
        const up = (k) => ({ set: k, lo: rs, hi: R, dir: +1 });
        switch (name) {
            case 'P': return turning('P', p, rs, 'mantle');
            case 'PKP': return turning('P', p, rs, 'outer');
            case 'PKIKP': return turning('P', p, rs, 'inner');
            case 'S': return turning('S', p, rs, 'mantle');
            case 'SKS': return turning('K', p, rs, 'outer');
            case 'SKIKS': return turning('K', p, rs, 'inner');
            case 'p': return rs < R - 1e-6 ? [up('P')] : null;
            case 's': return rs < R - 1e-6 ? [up('S')] : null;
            case 'pP': case 'sP': case 'sS': {
                if (rs > R - 1) return null;                      // a surface source has no separate depth phase
                const second = surfaceRay(name[1], p, 'mantle');
                return second ? [up(name[0].toUpperCase()), ...second] : null;
            }
            case 'PP': case 'SS': {
                const first = turning(name[0], p, rs, 'mantle'), second = first && surfaceRay(name[0], p, 'mantle');
                return second ? [...first, ...second] : null;
            }
            case 'PcP': return bounce('P', 'P', cmbKm, p, rs);
            case 'ScS': return bounce('S', 'S', cmbKm, p, rs);
            case 'ScP': return bounce('S', 'P', cmbKm, p, rs);
            case 'PcS': return bounce('P', 'S', cmbKm, p, rs);
            case 'PKiKP': return bounce('P', 'P', icbKm, p, rs);
            default: return null;
        }
    }

    /** One ray of a phase: { name, p, legs, deltaRad, timeS } or null. */
    function phaseRay(name, p, { sourceDepthKm = 0 } = {}) {
        const rs = R - sourceDepthKm;
        const legs = legsFor(name, p, rs);
        if (!legs) return null;
        let D = 0, T = 0;
        for (const l of legs) {
            const dt = legDT(sets[l.set], p, l.lo, l.hi);
            if (!dt) return null;
            D += dt[0]; T += dt[1];
        }
        return { name, p, legs, deltaRad: D, deltaDeg: D / DEG, timeS: T };
    }

    /** The diffracted ray that has run `arcRad` along the CMB (arcRad ≥ 0). */
    function diffractedRay(name, arcRad, { sourceDepthKm = 0 } = {}) {
        const k = name === 'Pdiff' ? 'P' : 'S', p = grazingP(k);
        const g = phaseRay(k === 'P' ? 'PcP' : 'ScS', p, { sourceDepthKm });
        if (!g) return null;
        const legs = [g.legs[0], { arc: true, set: k, r: cmbKm, dRad: arcRad }, g.legs[1]];
        return { name, p, legs, deltaRad: g.deltaRad + arcRad, deltaDeg: (g.deltaRad + arcRad) / DEG, timeS: g.timeS + p * arcRad };
    }

    /**
     * Sweep a phase into its travel-time branch: rays in p order, split into
     * SEGMENTS wherever the phase stops existing between samples.
     */
    function branch(name, { sourceDepthKm = 0, n = 600 } = {}) {
        if (name === 'Pdiff' || name === 'Sdiff') {
            const g0 = diffractedRay(name, 0, { sourceDepthKm });
            if (!g0) return [];
            const span = Math.max(0, DIFFRACTION_MAX_DEG - g0.deltaDeg) * DEG, rays = [];
            for (let i = 0; i <= 60; i++) rays.push(diffractedRay(name, span * i / 60, { sourceDepthKm }));
            return [rays];
        }
        const rs = R - sourceDepthKm;
        const info = PHASE_INFO[name];
        const pTop = Math.max(etaAt(sets.P, rs), etaAt(sets.S, rs), etaAt(sets.P, R), etaAt(sets.S, R));
        // Coarse scan for where the phase lives, then a fine sweep there.
        const coarse = 240, live = [];
        for (let i = 0; i <= coarse; i++) { const p = pTop * i / coarse * (1 - 1e-9); if (phaseRay(name, p, { sourceDepthKm })) live.push(i); }
        if (!live.length || !info) return [];
        const lo = Math.max(0, live[0] - 1) / coarse * pTop, hi = Math.min(coarse, live.at(-1) + 1) / coarse * pTop * (1 - 1e-9);
        // A segment's END is bisected to the exact edge of existence: the grazing
        // limits (PcP at the core's slowness, ScP at P's) are where Δ(p) moves fastest,
        // and a fixed sweep stopped short of them (ScP ended 1° early, measured).
        const edge = (pIn, pOut) => {
            let a = pIn, b = pOut, last = null;
            for (let it = 0; it < 40; it++) { const m = 0.5 * (a + b), r = phaseRay(name, m, { sourceDepthKm }); if (r) { a = m; last = r; } else b = m; }
            return last;
        };
        const segs = []; let cur = [], prevP = null;
        for (let i = 0; i <= n; i++) {
            const p = lo + (hi - lo) * i / n;
            const r = phaseRay(name, p, { sourceDepthKm });
            if (r) {
                if (!cur.length && prevP !== null) { const e = edge(p, prevP); if (e) cur.push(e); }
                cur.push(r);
            } else if (cur.length) { const e = edge(cur.at(-1).p, p); if (e) cur.push(e); segs.push(cur); cur = []; }
            prevP = p;
        }
        if (cur.length) segs.push(cur);
        for (const sg of segs) sg.sort((x, y) => x.p - y.p);
        return segs.filter((s) => s.length > 1);
    }

    /**
     * Sample a ray along its path in travel order: nodes { rKm, deltaRad, tS }
     * plus, per interval, the exact dΔ/dT and the vertical slowness q = √(η² − p²)
     * at its midpoint (what ellipticity.js integrates). `sub` intervals per shell piece.
     */
    function samplePath(ray, { sub = 2 } = {}) {
        const nodes = [], intervals = [];
        let d = 0, t = 0, first = true;
        const push = (r) => { nodes.push({ rKm: r, deltaRad: d, tS: t }); };
        for (const l of ray.legs) {
            if (l.arc) {
                const m = 24;
                if (first) { push(l.r); first = false; }
                for (let j = 1; j <= m; j++) {
                    const dd = l.dRad / m, dt = ray.p * dd;
                    intervals.push({ dr: 0, q: 0, dirSign: 0, dDelta: dd, dT: dt });
                    d += dd; t += dt; push(l.r);
                }
                continue;
            }
            const sh = sets[l.set];
            const pieces = [];
            for (const s of sh) {
                if (s.r2 <= l.lo || s.r1 >= l.hi) continue;
                pieces.push([s, Math.max(s.r1, l.lo), Math.min(s.r2, l.hi)]);
            }
            pieces.sort((a, b) => b[1] - a[1]);                 // outermost first
            if (l.dir > 0) pieces.reverse();                     // up legs run inner → outer
            if (first) { push(l.dir < 0 ? l.hi : l.lo); first = false; }
            for (const [s, a, b] of pieces) {
                // Nodes clustered toward the low end (where a ray turns): r = a + (b − a)·u².
                const rr = Array.from({ length: sub + 1 }, (_, k) => a + (b - a) * (k / sub) ** 2);
                if (l.dir < 0) rr.reverse();
                for (let j = 1; j <= sub; j++) {
                    const r0 = rr[j - 1], r1 = rr[j], x = Math.min(r0, r1), y = Math.max(r0, r1);
                    const [dd, dt] = shellDT(s, ray.p, x, y);
                    const rm = 0.5 * (x + y), em = etaOf(s, rm);
                    intervals.push({ dr: r1 - r0, q: Math.sqrt(Math.max(0, em * em - ray.p * ray.p)), dirSign: l.dir, dDelta: dd, dT: dt });
                    d += dd; t += dt; push(r1);
                }
            }
        }
        return { nodes, intervals };
    }

    return { legDT, turnBelow, phaseRay, diffractedRay, branch, samplePath, grazingP, sets, cmbKm, icbKm, radiusKm: R };
}

let DEFAULT_MODEL = null;
export const premPhaseModel = () => (DEFAULT_MODEL ??= createPhaseModel());

/**
 * Travel-time table for a source depth: { [phase]: segments } for every
 * phase in `names` (default all). Cached per depth.
 */
const TABLE_CACHE = new Map();
export function travelTimeTable(sourceDepthKm = 0, { names = PHASES.map((p) => p.name), model = premPhaseModel() } = {}) {
    const key = `${sourceDepthKm}|${names.join(',')}`;
    if (model === premPhaseModel() && TABLE_CACHE.has(key)) return TABLE_CACHE.get(key);
    const out = {};
    for (const nm of names) { const segs = model.branch(nm, { sourceDepthKm }); if (segs.length) out[nm] = segs; }
    if (model === premPhaseModel()) TABLE_CACHE.set(key, out);
    return out;
}

/** Ray distances beyond 180° arrive at 360° − Δ (the long way round). */
export const foldDeg = (d) => { const m = ((d % 360) + 360) % 360; return m > 180 ? 360 - m : m; };

/**
 * Every arrival at an epicentral distance (deg), earliest first:
 * [{ phase, timeS, p, deltaRay }]. Interpolates within each segment on the
 * FOLDED distance; two crossings of one phase within 0.5 s are one arrival
 * seen on either side of a micro-cusp.
 */
export function arrivals(deltaDeg, table) {
    const out = [];
    for (const [phase, segs] of Object.entries(table)) {
        for (const seg of segs) {
            for (let i = 1; i < seg.length; i++) {
                const a = seg[i - 1], b = seg[i], fa = foldDeg(a.deltaDeg), fb = foldDeg(b.deltaDeg);
                if ((fa - deltaDeg) * (fb - deltaDeg) > 0 || fa === fb) continue;
                // A pair that straddles the 180° fold is not an interpolation interval.
                if (Math.abs(fa - fb) > 30) continue;
                const f = (deltaDeg - fa) / (fb - fa);
                out.push({ phase, timeS: a.timeS + f * (b.timeS - a.timeS), p: a.p + f * (b.p - a.p), deltaRay: a.deltaDeg + f * (b.deltaDeg - a.deltaDeg) });
            }
        }
    }
    out.sort((x, y) => x.timeS - y.timeS);
    const kept = [];
    for (const a of out) if (!kept.some((k) => k.phase === a.phase && Math.abs(k.timeS - a.timeS) < 0.5)) kept.push(a);
    return kept;
}
