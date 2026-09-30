/**
 * upper-atmosphere-cme-model.js — the incoming CME, in THIS page's frame
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE kernel. No THREE, no DOM, no fetch, no ambient time. Node-tested by
 * `tests/upper-atmosphere-cme-model.mjs`. Scene vectors are plain [x, y, z]
 * in the canonical EARTH-FIXED frame (`latLonToScene`: +X Greenwich,
 * +Y north, −Z = 90°E; 1 unit = 1 R⊕, Earth at the origin).
 *
 * ── This module computes NO flux-rope physics ──────────────────────────────
 * Rope geometry is `corridor/corridor-model.js` `trainAt()` (the live
 * kernel's apex / σ probes, oracle-direct, with the pinned mirror as the
 * fallback) and the surface is `stage/model.js` `ropeSurfaceGrid` — the
 * orrery / hero pattern. The FIELD is the kernel's `fieldAt`. What lives
 * here is only the FRAME JOIN and two ways of drawing the result:
 *
 *   1. THE FRAME. The flux-rope frame is heliocentric, +x Sun→Earth, +z
 *      ecliptic north (Stonyhurst longitude, Earth at 0). This page is
 *      Earth-fixed, so ecliptic north is NOT +Y: it is the ecliptic pole
 *      turned into the rotating frame by the sidereal angle,
 *          ê_N = (−sin θ·sin ε, cos ε, cos θ·sin ε)      (θ = GMST)
 *      (ECI (0, −sin ε, cos ε) → scene axes (x, z, −y) → −θ about +Y; the
 *      same rotation `_eciSceneToEarthFixed` applies to every orbit). The
 *      basis is e1 = −ŝ (Sun→Earth), e3 = ê_N orthogonalised against e1,
 *      e2 = e3 × e1 — RIGHT-handed, because (x, z, −y) is a rotation, not
 *      the orrery's mirror, so a rope fitted at +γ draws at +γ. The gate
 *      pins ê_N ⟂ the page's own Sun direction over a year of dates.
 *
 *   2. THE CORRIDOR — COMPRESSED AND DISCLOSED. 1 AU is 23 481 R⊕; this
 *      scene's camera lives inside ~30 R⊕. So the approach is drawn on the
 *      Stage's own radial map (`stage/scale.js` `stageRadius`), rescaled so
 *      the drawn Sun sits `CME_VIEW.sunRe` R⊕ up the Sun line and 1 AU
 *      lands exactly on the drawn Earth (the hero's `corridorRadius`, with
 *      this page's anchor). Directions are preserved; only radius is
 *      compressed. The page prints the compression.
 *
 *   3. THE INCOMING FLUX — TRUE SCALE. Near Earth nothing is compressed:
 *      `traceImfLines` samples the kernel's field at real positions within
 *      `imfBoxRe` of Earth (heliocentric km = Earth + scene R⊕ × R⊕ km) and
 *      traces field lines through it. A rope is ~0.1 AU across — thousands
 *      of R⊕ — so over this box its field is nearly uniform and the lines
 *      are nearly straight; what changes is their DIRECTION as the rope
 *      sweeps past, which is exactly what the magnetosphere experiences.
 *      Lines stop where the kernel says the rope stops (so the front's
 *      arrival is visible as lines appearing) and where they reach the
 *      magnetopause: the kernel's field is the UNDISTURBED rope field, and
 *      draping around the magnetosphere is not modelled — they are clipped,
 *      never bent by hand.
 *
 * Earth sits at 1 AU on the +x axis of the rope frame (`CME_VIEW.earthAu`;
 * the kernel's L1 observer is 0.99 AU, the corridor's Earth 1 AU).
 */

import { stageRadius, EARTH_S, AU_KM, RE_KM } from './stage/scale.js';

const DEG = Math.PI / 180;

export const CME_VIEW = Object.freeze({
    sunRe: 160,            // the drawn Sun's distance up the Sun line [R⊕]
    sunDrawnRe: 6,         // its drawn radius (real: 109 R⊕ at 23 481 R⊕)
    earthAu: 1,            // Earth on the rope frame's +x axis
    passedHideAu: 1.35,    // a rope past 1 AU fades out by here
    imfBoxRe: 40,          // true-scale field lines within this radius of Earth
    imfGrid: 9,            // seeds per side on the plane ⟂ B (a disc of them)
    imfStepRe: 2.5,        // tracing step [R⊕]
    maxDistanceRe: 380,    // the camera may pull back this far with the layer on
});

/** Mean obliquity of the ecliptic, J2000 (Meeus 22.2) — 0.003° from 2026's. */
export const OBLIQUITY_DEG = 23.4392911;

// ── vectors ──
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => { const l = len(a); return l > 0 ? scale(a, 1 / l) : [0, 0, 0]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Ecliptic north pole in the Earth-fixed scene frame at sidereal angle θ. */
export function eclipticNorthScene(gmstRad, obliquityDeg = OBLIQUITY_DEG) {
    const e = obliquityDeg * DEG, c = Math.cos(gmstRad), s = Math.sin(gmstRad);
    return [-s * Math.sin(e), Math.cos(e), c * Math.sin(e)];
}

/**
 * The rope frame written in scene coordinates: e1 = Sun→Earth (−ŝ), e3 =
 * ecliptic north ⟂ e1, e2 = e3 × e1. Right-handed (see the header).
 * @param {number[]} sunDir  unit Earth→Sun in the scene
 * @param {number[]} eclNorth ecliptic north in the scene
 */
export function ropeBasisScene(sunDir, eclNorth) {
    const e1 = norm(scale(sunDir, -1));
    let e3 = [eclNorth[0] - e1[0] * dot(eclNorth, e1), eclNorth[1] - e1[1] * dot(eclNorth, e1),
              eclNorth[2] - e1[2] * dot(eclNorth, e1)];
    e3 = norm(e3);
    const e2 = cross(e3, e1);
    return { e1, e2, e3 };
}

/** Rope-frame vector → scene vector (rotation only). */
export function ropeVecToScene(v, basis, out = [0, 0, 0]) {
    const { e1, e2, e3 } = basis;
    out[0] = v[0] * e1[0] + v[1] * e2[0] + v[2] * e3[0];
    out[1] = v[0] * e1[1] + v[1] * e2[1] + v[2] * e3[1];
    out[2] = v[0] * e1[2] + v[1] * e2[2] + v[2] * e3[2];
    return out;
}
/** Scene vector → rope-frame vector (the transpose). */
export function sceneVecToRope(s, basis, out = [0, 0, 0]) {
    out[0] = dot(s, basis.e1); out[1] = dot(s, basis.e2); out[2] = dot(s, basis.e3);
    return out;
}

// ── 2. The compressed corridor ─────────────────────────────────────────────

/** Heliocentric r [AU] → distance from the drawn Sun [R⊕]; 1 AU → the drawn Earth. */
export function corridorRadiusRe(rAu, sunRe = CME_VIEW.sunRe) {
    if (!(rAu > 0)) return 0;
    return stageRadius(rAu) * (sunRe / EARTH_S);
}

/** How many times the corridor compresses distance at heliocentric r (local slope). */
export function corridorCompression(rAu, sunRe = CME_VIEW.sunRe) {
    const h = 1e-4;
    const slopeRePerAu = (corridorRadiusRe(rAu + h, sunRe) - corridorRadiusRe(rAu - h, sunRe)) / (2 * h);
    return (AU_KM / RE_KM) / slopeRePerAu;
}

/** One rope-frame point (AU from the Sun) → scene on the corridor map. */
export function corridorPointToScene(pAu, basis, sunDir, out = [0, 0, 0], sunRe = CME_VIEW.sunRe) {
    const r = len(pAu);
    const sx = sunDir[0] * sunRe, sy = sunDir[1] * sunRe, sz = sunDir[2] * sunRe;
    if (!(r > 1e-12)) { out[0] = sx; out[1] = sy; out[2] = sz; return out; }
    const k = corridorRadiusRe(r, sunRe) / r;
    const v = ropeVecToScene(pAu, basis);
    out[0] = sx + v[0] * k; out[1] = sy + v[1] * k; out[2] = sz + v[2] * k;
    return out;
}

/** Map a whole `ropeSurfaceGrid` positions array (AU) onto the corridor. */
export function mapCorridorSurface(positions, basis, sunDir, dst = null, sunRe = CME_VIEW.sunRe) {
    const out = dst && dst.length === positions.length ? dst : new Float32Array(positions.length);
    const p = [0, 0, 0], q = [0, 0, 0];
    for (let i = 0; i < positions.length; i += 3) {
        p[0] = positions[i]; p[1] = positions[i + 1]; p[2] = positions[i + 2];
        corridorPointToScene(p, basis, sunDir, q, sunRe);
        out[i] = q[0]; out[i + 1] = q[1]; out[i + 2] = q[2];
    }
    return out;
}

/** Opacity past 1 AU — never imply a still-inbound cloud once it has passed. */
export function passedFade(apexAu, hideAu = CME_VIEW.passedHideAu, earthAu = CME_VIEW.earthAu) {
    if (!(apexAu > earthAu)) return 1;
    return Math.max(0, 1 - (apexAu - earthAu) / (hideAu - earthAu));
}

// ── 3. True scale near Earth ───────────────────────────────────────────────

const EARTH_KM = () => CME_VIEW.earthAu * AU_KM;

/** Scene point [R⊕] → heliocentric rope-frame point [km]. */
export function sceneToHelioKm(s, basis, out = [0, 0, 0]) {
    sceneVecToRope(s, basis, out);
    out[0] = out[0] * RE_KM + EARTH_KM(); out[1] *= RE_KM; out[2] *= RE_KM;
    return out;
}
/** Heliocentric rope-frame point [km] → scene [R⊕]. */
export function helioKmToScene(p, basis, out = [0, 0, 0]) {
    return ropeVecToScene([(p[0] - EARTH_KM()) / RE_KM, p[1] / RE_KM, p[2] / RE_KM], basis, out);
}

/** Heliocentric field (the kernel's frame) → GSE: X Earth→Sun, Y dusk, Z north. */
export function toGse(b) { return [-b[0], -b[1], b[2]]; }

/** Shue et al. (1998) magnetopause radius at angle θ from the Sun line. */
export function shueRadiusRe(thetaRad, r0, alpha) {
    const c = Math.cos(thetaRad);
    if (c <= -1 + 1e-9) return Infinity;
    return r0 * Math.pow(2 / (1 + c), alpha);
}
/** Is a scene point inside the magnetopause (sunDir = Earth→Sun)? */
export function insideMagnetopause(s, sunDir, mp) {
    if (!mp || !(mp.r0 > 0)) return false;
    const r = len(s);
    if (!(r > 0)) return true;
    const th = Math.acos(Math.max(-1, Math.min(1, dot(s, sunDir) / r)));
    return r < shueRadiusRe(th, mp.r0, mp.alpha ?? 0.58);
}

/**
 * Trace the rope's field lines near Earth at TRUE scale.
 *
 * @param {object} o
 * @param {(pKm:number[]) => {bx,by,bz,inside}} o.fieldAt  heliocentric field at a point (kernel frame)
 * @param {object} o.basis    `ropeBasisScene`
 * @param {number[]} o.sunDir unit Earth→Sun (scene)
 * @param {{r0:number, alpha:number}} [o.mp]  the magnetopause lines stop at
 * @returns {{lines:Array<{points:number[], bz:number[], bmag:number[]}>, reference:null|{scene:number[],
 *           gse:number[], bmag:number, at:string}, calls:number}}
 *   `reference` is the field where the seeds were laid out — at Earth when
 *   Earth is inside a rope, else at the sunward or anti-sunward edge of the
 *   box; null when no part of the box is inside any rope (no lines).
 */
export function traceImfLines({ fieldAt, basis, sunDir, mp = null,
                                boxRe = CME_VIEW.imfBoxRe, grid = CME_VIEW.imfGrid, stepRe = CME_VIEW.imfStepRe }) {
    let calls = 0;
    const pKm = [0, 0, 0];
    const sample = (s) => {
        calls++;
        sceneToHelioKm(s, basis, pKm);
        const f = fieldAt(pKm);
        if (!f || !f.inside || !Number.isFinite(f.bx)) return null;
        const b = [f.bx, f.by, f.bz];
        const m = len(b);
        if (!(m > 0)) return null;
        return { dir: norm(ropeVecToScene(b, basis)), bz: f.bz, bmag: m, b };
    };
    // Reference: Earth first, then the box edges up and down the Sun line.
    const probes = [
        { s: [0, 0, 0], at: 'earth' },
        { s: scale(sunDir, 0.95 * boxRe), at: 'sunward' },
        { s: scale(sunDir, -0.95 * boxRe), at: 'antisunward' },
    ];
    let ref = null;
    for (const p of probes) {
        const f = sample(p.s);
        if (f) { ref = { ...f, s: p.s, at: p.at }; break; }
    }
    if (!ref) return { lines: [], reference: null, calls };

    // Seeds on the plane through the reference point ⟂ B, a grid×grid lattice.
    const d = ref.dir;
    const a = norm(cross(d, Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
    const b = cross(d, a);
    const lines = [];
    const box2 = boxRe * boxRe;
    const span = 0.9 * boxRe;
    const maxSteps = Math.ceil((2 * boxRe) / stepRe) + 2;
    for (let i = 0; i < grid; i++) {
        for (let j = 0; j < grid; j++) {
            const u = grid > 1 ? -span + (2 * span * i) / (grid - 1) : 0;
            const v = grid > 1 ? -span + (2 * span * j) / (grid - 1) : 0;
            if (u * u + v * v > span * span * 1.0001) continue;      // a disc, not a square
            const seed = [
                ref.s[0] + a[0] * u + b[0] * v,
                ref.s[1] + a[1] * u + b[1] * v,
                ref.s[2] + a[2] * u + b[2] * v,
            ];
            if (dot(seed, seed) > box2) continue;
            const f0 = sample(seed);
            if (!f0) continue;
            // March the whole field line through the box both ways (midpoint
            // rule on the unit direction), recording every point with whether
            // it is inside the magnetopause; then keep the runs OUTSIDE it.
            // A line that crosses the magnetosphere therefore comes out as
            // its upstream and downstream pieces — clipped, not bent.
            const half = (sign) => {
                const out = [];
                let p = seed, f = f0;
                for (let k = 0; k < maxSteps; k++) {
                    const mid = [p[0] + sign * f.dir[0] * stepRe * 0.5, p[1] + sign * f.dir[1] * stepRe * 0.5,
                                 p[2] + sign * f.dir[2] * stepRe * 0.5];
                    const fm = sample(mid);
                    if (!fm) break;
                    const q = [p[0] + sign * fm.dir[0] * stepRe, p[1] + sign * fm.dir[1] * stepRe,
                               p[2] + sign * fm.dir[2] * stepRe];
                    if (dot(q, q) > box2) break;
                    const fq = sample(q);
                    if (!fq) break;
                    out.push({ p: q, bz: fq.bz, bm: fq.bmag, mp: insideMagnetopause(q, sunDir, mp) });
                    p = q; f = fq;
                }
                return out;
            };
            const back = half(-1), fwd = half(1);
            const all = [...back.reverse(),
                { p: seed, bz: f0.bz, bm: f0.bmag, mp: insideMagnetopause(seed, sunDir, mp) }, ...fwd];
            let run = null;
            const flush = () => { if (run && run.bz.length >= 2) lines.push(run); run = null; };
            for (const v of all) {
                if (v.mp) { flush(); continue; }
                if (!run) run = { points: [], bz: [], bmag: [] };
                run.points.push(v.p[0], v.p[1], v.p[2]); run.bz.push(v.bz); run.bmag.push(v.bm);
            }
            flush();
        }
    }
    return {
        lines,
        reference: { scene: ref.s, gse: toGse(ref.b), bmag: ref.bmag, at: ref.at },
        calls,
    };
}

// ── The train's status (kernel probes only) ───────────────────────────────

/**
 * Hours from `tTrainS` until rope i's APEX reaches `rKm`, by bisection on
 * the kernel's own `apexKmAt` (train time — the kernel subtracts the rope's
 * launch offset itself). null if it does not get there within `horizonH`;
 * 0 if it already has.
 */
export function hoursToReach(kernel, i, tTrainS, rKm = CME_VIEW.earthAu * AU_KM, { horizonH = 240 } = {}) {
    if (!kernel || typeof kernel.apexKmAt !== 'function') return null;
    if (kernel.apexKmAt(i, tTrainS) >= rKm) return 0;
    let lo = tTrainS, hi = null;
    for (let h = 1; h <= horizonH; h++) {
        const t = tTrainS + h * 3600;
        if (kernel.apexKmAt(i, t) >= rKm) { hi = t; break; }
        lo = t;
    }
    if (hi == null) return null;
    for (let k = 0; k < 30; k++) {
        const mid = 0.5 * (lo + hi);
        if (kernel.apexKmAt(i, mid) >= rKm) hi = mid; else lo = mid;
    }
    return (hi - tTrainS) / 3600;
}

/**
 * The scrub window for a forecast: 6 h before the epoch to 18 h after the
 * latest arrival the summary knows (P90), or a nominal 60 h transit of the
 * last rope — and always including `nowMs` when given.
 */
export function cmeWindow(fc, { nowMs = null, nominalTransitH = 60 } = {}) {
    const epoch = fc?.launchMs;
    if (!Number.isFinite(epoch)) return null;
    const ropes = fc.preset?.ropes?.length ? fc.preset.ropes : (fc.preset?.rope ? [fc.preset.rope] : []);
    const launches = ropes.map((r) => epoch + (r.launchOffsetS ?? 0) * 1000);
    const lastLaunch = launches.length ? Math.max(...launches) : epoch;
    const s = fc.summary;
    const late = Number.isFinite(s?.arrivalP90Ms) ? s.arrivalP90Ms : lastLaunch + nominalTransitH * 3600e3;
    let t0 = epoch - 6 * 3600e3, t1 = late + 18 * 3600e3;
    if (Number.isFinite(nowMs)) { t0 = Math.min(t0, nowMs); t1 = Math.max(t1, nowMs); }
    return { t0, t1, launches, arrivalMs: Number.isFinite(s?.arrivalP50Ms) ? s.arrivalP50Ms : null };
}

// ── Camera stations for the CME layer ──────────────────────────────────────

/**
 * Where to stand to see the CME, as a pose the camera rig flies to and then
 * orbits (pivot + ecliptic-north orbit axis, so the ecliptic stays level):
 *   'approach' — side-on to the whole corridor: the drawn Sun and Earth both
 *                in frame, ropes crossing between them (compressed map);
 *   'upstream' — 30 R⊕ up the Sun line looking back at Earth: the incoming
 *                flux meeting the magnetosphere head-on (true scale);
 *   'side'     — dusk side, the Sun to the left, the field lines sweeping
 *                past the magnetopause (true scale).
 * @returns {{position:number[], target:number[], up:number[], fovDeg:number}|null}
 */
export function cmeViewPose(kind, basis, sunDir, sunRe = CME_VIEW.sunRe) {
    const { e2, e3 } = basis;
    const mix = (terms) => terms.reduce((acc, [v, k]) => [acc[0] + v[0] * k, acc[1] + v[1] * k, acc[2] + v[2] * k], [0, 0, 0]);
    if (kind === 'approach') {
        const mid = scale(sunDir, 0.5 * sunRe);
        return { position: mix([[mid, 1], [e2, -0.95 * sunRe], [e3, 0.28 * sunRe]]), target: mid, up: e3, fovDeg: 58 };
    }
    if (kind === 'upstream') {
        return { position: mix([[sunDir, 30], [e3, 5], [e2, -4]]), target: [0, 0, 0], up: e3, fovDeg: 50 };
    }
    if (kind === 'side') {
        return { position: mix([[e2, -44], [e3, 10], [sunDir, 6]]), target: scale(sunDir, 4), up: e3, fovDeg: 55 };
    }
    return null;
}
