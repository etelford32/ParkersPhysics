/**
 * neo-orbits.js — PURE small-body orbit kernel for the solar-system orrery
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no three.js, no ambient time. Imported by three consumers
 * that never see each other at runtime, so every rule here is the ONE copy:
 *
 *   js/neo-worker.js         propagates the whole catalogue off-thread
 *   js/neo-layer.js          draws it (positions come from the worker, but the
 *                            selected object's orbit line and every readout are
 *                            evaluated here on the main thread)
 *   api/_lib/neo-sources.js  compacts JPL rows into NEO_ROW_COLUMNS
 *
 * Gate: `node tests/neo-orbits.mjs` after ANY edit.
 *
 * ── What is modelled ──────────────────────────────────────────────────────
 * Two-body Keplerian propagation of heliocentric osculating elements
 * (ecliptic J2000, the frame JPL's SBDB publishes) to an arbitrary Julian Day.
 * Elliptic (e < 1) and hyperbolic (e > 1) branches; near-parabolic orbits with
 * |e − 1| < PARABOLIC_BAND are refused rather than propagated badly — the
 * catalogue is NEOs and periodic comets, which are all comfortably elliptic,
 * plus the interstellar visitors, which are all comfortably hyperbolic.
 *
 * Accuracy: JPL's osculating elements are exact at their epoch; two-body
 * motion drifts from the perturbed truth at roughly arcminutes per year for a
 * typical NEO, and MUCH faster across a close planetary encounter (which is
 * why the page's approach list comes from JPL's own CAD service, not from
 * this kernel). The kernel is honest about that in `elementsAgeNote`.
 *
 * ── Frames and the two display conventions ───────────────────────────────
 * The orrery draws heliocentric distance on a LOG radial scale
 * (`logSceneRadius`, a mirror of solar-system.html's `simDist`) and swaps
 * ecliptic (x, y, z) → scene (x, z, y). At Earth that scale is ~2.7 scene
 * units per AU and the drawn Earth sphere (0.12 units) is therefore ~17 lunar
 * distances wide, so a flyby at 1 LD lands INSIDE the drawn planet. Rather
 * than lie about that, near-Earth objects get a second, disclosed convention:
 * an Earth-anchored frame whose radial compression is the SAME power law the
 * page already uses to draw the Moon (planet-moons.js MOON_VIS_CFG.earth,
 * minus its 6 R⊕ clamp), so "1 LD" on that frame passes through the drawn
 * Moon. The two conventions never meet — the layer cross-fades between them
 * across LOCAL_FADE_LD — because no monotonic radial map can satisfy both
 * (the Moon-anchored map at 1 LD already exceeds the heliocentric map at
 * 40 LD; measured in the plan doc, do not re-derive).
 */

export const GAUSS_K = 0.01720209895;        // rad/day — Gaussian gravitational constant
export const AU_KM   = 149_597_870.7;
export const LD_KM   = 384_400;              // lunar distance, IAU convention
export const LD_AU   = LD_KM / AU_KM;        // 0.002569 AU
export const J2000   = 2451545.0;
export const D2R     = Math.PI / 180;
export const R2D     = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

/** Orbits with |e − 1| below this are refused (parabolic degeneracy). */
export const PARABOLIC_BAND = 1e-3;

// ── Log radial scale — MIRROR of solar-system.html `simDist` ───────────────
// The page cannot import this file's copy into its inline module without a
// refactor, and the worker cannot import the page's. tests/solar-system-neo-
// smoke.spec.js asserts the two agree at 1 AU, so drift fails loudly.
export const LOG_SCALE = Object.freeze({ base: 2.5, gain: 4.2, k: 1.8 });
export function logSceneRadius(rAU) {
    return LOG_SCALE.base + LOG_SCALE.gain * Math.log(1 + rAU * LOG_SCALE.k);
}

// ── Earth-local frame — MIRROR of planet-moons.js MOON_VIS_CFG.earth ───────
// moonKmToScene('earth', R, p) = R · 0.85 · (|p| / 60 268)^0.55 (clamped to
// [1.7 R, 6 R]). The clamp saturates at ~5.5 LD, useless for a flyby list that
// runs to 20 LD, so this frame keeps the power law and drops the clamp. The
// Moon (384 400 km) sits below the clamp, so it draws at the same radius
// under both — that is the anchor tests/neo-orbits.mjs pins.
export const LOCAL_FRAME = Object.freeze({
    earthSceneRadius: 0.12,   // solar-system.html earthR ("1 Re in this scene")
    aRefKm: 60_268,
    exp: 0.55,
    gain: 0.85,
    /** Objects farther than this from Earth leave the local frame entirely. */
    maxLD: 20,
    /** Cross-fade band (in LD) between the local and heliocentric drawings. */
    fadeLD: [14, 20],
});
export function localSceneRadius(dKm, earthR = LOCAL_FRAME.earthSceneRadius) {
    if (!(dKm > 0)) return 0;
    return earthR * LOCAL_FRAME.gain * Math.pow(dKm / LOCAL_FRAME.aRefKm, LOCAL_FRAME.exp);
}
/** Scene-space offset from the drawn Earth for a geocentric ecliptic vector (AU). */
export function geoToLocalScene(gx, gy, gz, earthR = LOCAL_FRAME.earthSceneRadius) {
    const dAU = Math.hypot(gx, gy, gz);
    if (!(dAU > 0)) return { x: 0, y: 0, z: 0, dLD: 0 };
    const s = localSceneRadius(dAU * AU_KM, earthR) / dAU;
    // Same axis swap as helioToScene: ecliptic z is scene "up".
    return { x: gx * s, y: gz * s, z: gy * s, dLD: dAU / LD_AU };
}
/** 0 → fully local, 1 → fully heliocentric, across LOCAL_FRAME.fadeLD. */
export function localFrameWeight(dLD) {
    const [a, b] = LOCAL_FRAME.fadeLD;
    if (!(dLD > a)) return 0;
    if (dLD >= b) return 1;
    const t = (dLD - a) / (b - a);
    return t * t * (3 - 2 * t);
}

// ── Equinox: J2000 elements versus the page's ecliptic OF DATE ──────────────
// JPL publishes elements on the J2000 ecliptic; the orrery places its planets
// from VSOP87D, which is the ecliptic and equinox OF DATE. The two differ by
// the general precession in longitude — 0.37° in 2026, which at 1 AU is
// ~2.5 lunar distances, i.e. the whole flyby geometry. Every position this
// kernel hands to the scene is therefore rotated about the ecliptic pole by
// p_A (IAU 1976, Lieske et al.: 5029.0966″ T + 1.11113″ T²); the ~47″/century
// tilt of the ecliptic plane itself is dropped (0.02 LD at 1 AU over the
// page's 1800–2200 span).
export function precessionLongitudeRad(jd) {
    const T = (jd - J2000) / 36525;
    return ((5029.0966 + 1.11113 * T) * T / 3600) * D2R;
}
/** Rotate an ecliptic vector about the pole by `ang` (rad): J2000 → of date for ang = p_A. */
export function rotateAboutPole(x, y, z, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    return { x: c * x - s * y, y: s * x + c * y, z };
}
/** J2000 heliocentric position → ecliptic of date at JD. */
export function toOfDate(p, jd) {
    const r = rotateAboutPole(p.x, p.y, p.z, precessionLongitudeRad(jd));
    return { ...p, x: r.x, y: r.y, z: r.z };
}

/** Heliocentric ecliptic (AU) → scene units, log radial scale + axis swap. */
export function helioToScene(x, y, z) {
    const r = Math.hypot(x, y, z);
    if (!(r > 0)) return { x: 0, y: 0, z: 0 };
    const s = logSceneRadius(r) / r;
    return { x: x * s, y: z * s, z: y * s };
}

// ── Kepler solvers ──────────────────────────────────────────────────────────

/** Eccentric anomaly E from mean anomaly M (rad) for 0 ≤ e < 1. Newton, ≤40 it. */
export function solveKeplerElliptic(M, e) {
    M = M % TWO_PI;
    if (M < 0) M += TWO_PI;
    let E = e < 0.8 ? M + e * Math.sin(M) : Math.PI;
    for (let it = 0; it < 40; it++) {
        const f  = E - e * Math.sin(E) - M;
        const fp = 1 - e * Math.cos(E);
        const dE = f / fp;
        E -= dE;
        if (Math.abs(dE) < 1e-13) break;
    }
    return E;
}

/** Hyperbolic anomaly H from mean anomaly M for e > 1. Newton, ≤60 it. */
export function solveKeplerHyperbolic(M, e) {
    // Danby's start: H ≈ ln(2|M|/e + 1.8) for large |M|, asinh(M/e) near 0.
    const aM = Math.abs(M);
    let H = aM > 1 ? Math.log(2 * aM / e + 1.8) : Math.asinh(aM / e);
    if (M < 0) H = -H;
    for (let it = 0; it < 60; it++) {
        const f  = e * Math.sinh(H) - H - M;
        const fp = e * Math.cosh(H) - 1;
        const dH = f / fp;
        H -= dH;
        if (Math.abs(dH) < 1e-13) break;
    }
    return H;
}

// ── Element records ─────────────────────────────────────────────────────────
//
// A record is the flat object the edge route ships per object. Angles in
// DEGREES (as published), distances in AU, epoch / tp in Julian Days (TDB —
// the ~69 s TT−UTC offset is ~1 km of motion for an NEO and is ignored).
//
//   des     primary designation ("99942", "2024 YR4", "109P")
//   name    display name ("99942 Apophis (2004 MN4)")
//   H       absolute magnitude (null for comets)
//   cls     JPL orbit-class code ("APO" "ATE" "AMO" "IEO" "JFc" "HTC" "HYA"…)
//   flags   bitfield, see FLAG
//   e a i om w ma  osculating elements at `epoch`
//   q tp    perihelion distance / time — required when e ≥ 1
//   moid    Earth MOID (AU) or null
//   diam    measured diameter (km) or null

export const FLAG = Object.freeze({
    NEO: 1, PHA: 2, COMET: 4, INTERSTELLAR: 8,
});

/** Column order of a compact catalogue row (the wire format). */
export const NEO_ROW_COLUMNS = Object.freeze([
    'des', 'name', 'H', 'cls', 'flags', 'e', 'a', 'q', 'i', 'om', 'w', 'ma', 'tp', 'epoch', 'moid', 'diam',
]);

export function rowToRecord(row) {
    const rec = {};
    for (let k = 0; k < NEO_ROW_COLUMNS.length; k++) rec[NEO_ROW_COLUMNS[k]] = row[k] ?? null;
    return rec;
}
export function recordToRow(rec) {
    return NEO_ROW_COLUMNS.map(c => (rec[c] === undefined ? null : rec[c]));
}

const num = v => (v === null || v === undefined || v === '' ? NaN : Number(v));

/**
 * Validate a record and fill derived quantities. Returns
 * { ok: true, el } or { ok: false, reason }. `el` carries everything the
 * propagator needs, plus q, Q (aphelion, or null), per_y, n (rad/day).
 */
export function normalizeElements(rec) {
    const e = num(rec.e), i = num(rec.i), om = num(rec.om), w = num(rec.w);
    let a = num(rec.a), q = num(rec.q);
    const ma = num(rec.ma), tp = num(rec.tp), epoch = num(rec.epoch);
    if (!Number.isFinite(e) || e < 0)                  return { ok: false, reason: 'bad_e' };
    if (Math.abs(e - 1) < PARABOLIC_BAND)               return { ok: false, reason: 'parabolic' };
    if (![i, om, w].every(Number.isFinite))             return { ok: false, reason: 'bad_angles' };
    if (!Number.isFinite(a) && Number.isFinite(q))      a = q / (1 - e);        // hyperbolic: a < 0
    if (!Number.isFinite(a) || a === 0)                 return { ok: false, reason: 'bad_a' };
    if (e < 1 && a < 0)                                 return { ok: false, reason: 'bad_a' };
    if (e > 1 && a > 0)                                 a = -a;                 // some sources publish |a|
    if (!Number.isFinite(q)) q = a * (1 - e);
    const n = GAUSS_K / Math.pow(Math.abs(a), 1.5);
    let anchor;   // how the mean anomaly is anchored in time
    if (e < 1 && Number.isFinite(ma) && Number.isFinite(epoch)) {
        anchor = { M0: ma * D2R, t0: epoch };
    } else if (Number.isFinite(tp)) {
        anchor = { M0: 0, t0: tp };
    } else {
        return { ok: false, reason: 'no_time_anchor' };
    }
    const Q = e < 1 ? a * (1 + e) : null;
    const per_y = e < 1 ? Math.pow(a, 1.5) : null;
    return {
        ok: true,
        el: {
            des: rec.des ?? null, name: rec.name ?? rec.des ?? null,
            H: Number.isFinite(num(rec.H)) ? num(rec.H) : null,
            cls: rec.cls ?? null, flags: rec.flags | 0,
            moid: Number.isFinite(num(rec.moid)) ? num(rec.moid) : null,
            diam: Number.isFinite(num(rec.diam)) ? num(rec.diam) : null,
            e, a, q, Q, i, om, w, n, per_y,
            M0: anchor.M0, t0: anchor.t0,
            epoch: Number.isFinite(epoch) ? epoch : anchor.t0,
        },
    };
}

/** Perifocal → ecliptic unit vectors P (toward perihelion) and Q (90° ahead). */
export function perifocalBasis(iDeg, omDeg, wDeg) {
    const i = iDeg * D2R, Om = omDeg * D2R, w = wDeg * D2R;
    const cO = Math.cos(Om), sO = Math.sin(Om);
    const ci = Math.cos(i),  si = Math.sin(i);
    const cw = Math.cos(w),  sw = Math.sin(w);
    return {
        Px:  cO * cw - sO * sw * ci,
        Py:  sO * cw + cO * sw * ci,
        Pz:  sw * si,
        Qx: -cO * sw - sO * cw * ci,
        Qy: -sO * sw + cO * cw * ci,
        Qz:  cw * si,
    };
}

/**
 * Perifocal coordinates (AU) and, optionally, velocities (AU/day) at JD.
 * Elliptic and hyperbolic branches share this so the two never drift apart.
 */
export function perifocalState(el, jd, withVelocity = false) {
    const { e, a, n } = el;
    const M = el.M0 + n * (jd - el.t0);
    if (e < 1) {
        const E = solveKeplerElliptic(M, e);
        const cE = Math.cos(E), sE = Math.sin(E);
        const b = a * Math.sqrt(1 - e * e);
        const out = { xp: a * (cE - e), yp: b * sE, r: a * (1 - e * cE), anomaly: E };
        if (withVelocity) {
            const Edot = n / (1 - e * cE);
            out.vxp = -a * sE * Edot;
            out.vyp =  b * cE * Edot;
        }
        return out;
    }
    const Hh = solveKeplerHyperbolic(M, e);
    const cH = Math.cosh(Hh), sH = Math.sinh(Hh);
    const b = -a * Math.sqrt(e * e - 1);          // a < 0 ⇒ b > 0
    const out = { xp: a * (cH - e), yp: b * sH, r: a * (1 - e * cH), anomaly: Hh };
    if (withVelocity) {
        const Hdot = n / (e * cH - 1);
        out.vxp = a * sH * Hdot;
        out.vyp = b * cH * Hdot;
    }
    return out;
}

/**
 * Heliocentric ecliptic J2000 position (AU) at JD; velocity (AU/day) when
 * asked. Allocates — use `prepareColumns` + `propagateColumns` for the bulk path.
 */
export function propagate(el, jd, withVelocity = false) {
    const B = el.basis ?? perifocalBasis(el.i, el.om, el.w);
    const s = perifocalState(el, jd, withVelocity);
    const out = {
        x: B.Px * s.xp + B.Qx * s.yp,
        y: B.Py * s.xp + B.Qy * s.yp,
        z: B.Pz * s.xp + B.Qz * s.yp,
        r: s.r,
    };
    if (withVelocity) {
        out.vx = B.Px * s.vxp + B.Qx * s.vyp;
        out.vy = B.Py * s.vxp + B.Qy * s.vyp;
        out.vz = B.Pz * s.vxp + B.Qz * s.vyp;
    }
    return out;
}

/** True anomaly (rad) → heliocentric position along the orbit, for drawing. */
export function positionAtTrueAnomaly(el, nu) {
    const B = el.basis ?? perifocalBasis(el.i, el.om, el.w);
    const p = el.a * (1 - el.e * el.e);           // semi-latus rectum (positive both branches)
    const r = p / (1 + el.e * Math.cos(nu));
    const xp = r * Math.cos(nu), yp = r * Math.sin(nu);
    return { x: B.Px * xp + B.Qx * yp, y: B.Py * xp + B.Qy * yp, z: B.Pz * xp + B.Qz * yp, r };
}

/**
 * Sample an orbit for a polyline. Ellipses close; hyperbolae run between
 * ±(asymptote − margin) and are cut at `rMaxAU`. Returns [{x,y,z,r}, …].
 */
export function sampleOrbit(el, samples = 256, rMaxAU = 60) {
    const pts = [];
    if (el.e < 1) {
        for (let k = 0; k < samples; k++) pts.push(positionAtTrueAnomaly(el, (k / samples) * TWO_PI));
        return pts;
    }
    const nuInf = Math.acos(-1 / el.e);
    // Largest ν with r ≤ rMax: r = p/(1+e cos ν) ⇒ cos ν = (p/rMax − 1)/e
    const p = el.a * (1 - el.e * el.e);
    const nuCut = Math.acos(Math.max(-1, Math.min(1, (p / rMaxAU - 1) / el.e)));
    const nuMax = Math.min(nuInf * 0.98, nuCut);
    for (let k = 0; k <= samples; k++) {
        const nu = -nuMax + (2 * nuMax) * (k / samples);
        pts.push(positionAtTrueAnomaly(el, nu));
    }
    return pts;
}

// ── Bulk path: struct-of-arrays for the worker ──────────────────────────────

/**
 * Turn an array of records into typed columns. Records that fail
 * normalisation are counted in `rejected` and dropped, so the caller's index
 * space is the surviving `els` array. Rotation bases are precomputed here so
 * the hot loop is one Kepler solve and six multiplies per object.
 */
export function prepareColumns(records) {
    const els = [];
    const rejected = {};
    for (const rec of records) {
        const r = normalizeElements(rec);
        if (!r.ok) { rejected[r.reason] = (rejected[r.reason] || 0) + 1; continue; }
        els.push(r.el);
    }
    const N = els.length;
    const cols = {
        count: N,
        e: new Float64Array(N), a: new Float64Array(N), n: new Float64Array(N),
        M0: new Float64Array(N), t0: new Float64Array(N),
        P: new Float64Array(N * 3), Q: new Float64Array(N * 3),
        flags: new Uint8Array(N),
        H: new Float32Array(N),        // absolute magnitude (NaN when unknown) — feeds the per-frame V
    };
    for (let k = 0; k < N; k++) {
        const el = els[k];
        cols.e[k] = el.e; cols.a[k] = el.a; cols.n[k] = el.n;
        cols.M0[k] = el.M0; cols.t0[k] = el.t0; cols.flags[k] = el.flags;
        cols.H[k] = el.H == null ? NaN : el.H;
        const B = perifocalBasis(el.i, el.om, el.w);
        cols.P[k * 3] = B.Px; cols.P[k * 3 + 1] = B.Py; cols.P[k * 3 + 2] = B.Pz;
        cols.Q[k * 3] = B.Qx; cols.Q[k * 3 + 1] = B.Qy; cols.Q[k * 3 + 2] = B.Qz;
    }
    return { els, cols, rejected };
}

/**
 * Propagate every column entry to JD, writing heliocentric ecliptic AU into
 * `helio` (3N). Returns the count written. Allocation-free.
 */
export function propagateColumns(cols, jd, helio) {
    const N = cols.count;
    const { e: E, a: A, n: Nn, M0, t0, P, Q } = cols;
    for (let k = 0; k < N; k++) {
        const e = E[k], a = A[k];
        const M = M0[k] + Nn[k] * (jd - t0[k]);
        let xp, yp;
        if (e < 1) {
            const Ea = solveKeplerElliptic(M, e);
            xp = a * (Math.cos(Ea) - e);
            yp = a * Math.sqrt(1 - e * e) * Math.sin(Ea);
        } else {
            const Hh = solveKeplerHyperbolic(M, e);
            xp = a * (Math.cosh(Hh) - e);
            yp = -a * Math.sqrt(e * e - 1) * Math.sinh(Hh);
        }
        const o = k * 3;
        helio[o]     = P[o]     * xp + Q[o]     * yp;
        helio[o + 1] = P[o + 1] * xp + Q[o + 1] * yp;
        helio[o + 2] = P[o + 2] * xp + Q[o + 2] * yp;
    }
    return N;
}

/**
 * From J2000 heliocentric positions and Earth's OF-DATE heliocentric position,
 * fill scene positions (log frame, of date), heliocentric distance (AU) and
 * geocentric distance (AU). `precRad` is precessionLongitudeRad(jd); the
 * rotation is applied here, once, so `helio` stays J2000 for the readouts.
 * One pass, allocation-free; this is what the worker ships back.
 */
export function deriveFrames(helio, N, earth, scene, rHelio, rGeo, precRad = 0, vmag = null, H = null, flags = null) {
    const [ex, ey, ez] = earth;
    const c = Math.cos(precRad), sn = Math.sin(precRad);
    for (let k = 0; k < N; k++) {
        const o = k * 3;
        const x0 = helio[o], y0 = helio[o + 1], z = helio[o + 2];
        const x = c * x0 - sn * y0, y = sn * x0 + c * y0;
        const r = Math.hypot(x, y, z);
        const gx = x - ex, gy = y - ey, gz = z - ez;
        const d = Math.hypot(gx, gy, gz);
        rHelio[k] = r;
        rGeo[k] = d;
        const s = r > 0 ? logSceneRadius(r) / r : 0;
        scene[o] = x * s; scene[o + 1] = z * s; scene[o + 2] = y * s;
        if (vmag) {
            // Apparent V from Earth NOW — the one honest brightness for the far
            // field (see the photometry section). Identical to the scalar
            // apparentMagnitude(); tests/neo-orbits.mjs pins the two equal.
            const h = H ? H[k] : NaN;
            if (Number.isFinite(h) && r > 0 && d > 0) {
                if (flags && (flags[k] & FLAG.COMET)) {
                    vmag[k] = h + 5 * Math.log10(d) + 10 * Math.log10(r);
                } else {
                    const ca = Math.max(-1, Math.min(1, (x * gx + y * gy + z * gz) / (r * d)));
                    const alpha = Math.acos(ca) * R2D;
                    vmag[k] = h + 5 * Math.log10(r * d) - 2.5 * Math.log10(Math.max(hgPhaseFunction(alpha), 1e-12));
                }
            } else vmag[k] = NaN;
        }
    }
}

// ── Classification and physical estimates ───────────────────────────────────

export const CLASS_LABELS = Object.freeze({
    APO: 'Apollo (Earth-crossing, a > 1 AU)',
    ATE: 'Aten (Earth-crossing, a < 1 AU)',
    AMO: 'Amor (Earth-approaching, 1.017 < q < 1.3 AU)',
    IEO: 'Atira (orbit entirely inside Earth’s)',
    JFc: 'Jupiter-family comet',
    JFC: 'Jupiter-family comet',
    HTC: 'Halley-type comet',
    ETc: 'Encke-type comet',
    CTc: 'Chiron-type comet',
    COM: 'Comet (unclassified)',
    HYA: 'Hyperbolic asteroid',
    HYP: 'Hyperbolic comet',
    PAA: 'Parabolic asteroid',
    PAR: 'Parabolic comet',
    MBA: 'Main-belt asteroid',
});

/** JPL's NEO sub-classes from a, e alone — the fallback when `cls` is missing. */
export function neoClass(a, e) {
    if (!(e < 1) || !(a > 0)) return e >= 1 ? 'HYA' : null;
    const q = a * (1 - e), Q = a * (1 + e);
    if (a > 1.0 && q < 1.017) return 'APO';
    if (a < 1.0 && Q > 0.983) return 'ATE';
    if (a < 1.0 && Q < 0.983) return 'IEO';
    if (q >= 1.017 && q < 1.3) return 'AMO';
    return null;
}

/** Diameter (km) from absolute magnitude, D = 1329 / √p · 10^(−H/5). */
export function diameterKmFromH(H, albedo = 0.14) {
    if (!Number.isFinite(H)) return null;
    return (1329 / Math.sqrt(albedo)) * Math.pow(10, -H / 5);
}

/** Short human size: "~340 m" / "~1.2 km", with the albedo assumption disclosed by the caller. */
export function formatSize(km) {
    if (!Number.isFinite(km) || km <= 0) return '—';
    if (km < 1) return `~${Math.round(km * 1000 / (km < 0.1 ? 1 : 10)) * (km < 0.1 ? 1 : 10)} m`;
    return `~${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

export function toLD(au) { return au / LD_AU; }
export function formatLD(au) {
    const ld = toLD(au);
    if (!Number.isFinite(ld)) return '—';
    if (ld < 0.1) return `${Math.round(au * AU_KM).toLocaleString()} km`;
    return `${ld < 10 ? ld.toFixed(2) : ld.toFixed(1)} LD`;
}

/** Heliocentric speed (km/s) from an AU/day velocity. */
export function speedKms(vx, vy, vz) {
    return Math.hypot(vx, vy, vz) * AU_KM / 86400;
}

/** "elements N years old" disclosure for a record's epoch versus the sim JD. */
export function elementsAgeNote(epochJD, jd) {
    const dy = Math.abs(jd - epochJD) / 365.25;
    if (dy < 0.5) return 'elements current';
    if (dy < 3)   return `two-body from ${dy.toFixed(1)} yr-old elements`;
    return `two-body ${dy.toFixed(0)} yr from epoch — perturbations unmodelled`;
}

// ── Notable objects — the ones visitors ask about by name ───────────────────
// Matched on primary designation first, then on a name fragment (the
// interstellar visitors' designations are not stable across sources).
export const NOTABLES = Object.freeze([
    { des: '99942',  label: 'Apophis',      why: 'Passes ~31,600 km above Earth on 2029-04-13 — inside the geostationary belt' },
    { des: '101955', label: 'Bennu',        why: 'OSIRIS-REx sample returned 2023; 1-in-2,700 impact chance in 2182' },
    { des: '162173', label: 'Ryugu',        why: 'Hayabusa2 sample returned 2020' },
    { des: '65803',  label: 'Didymos',      why: 'DART struck its moon Dimorphos on 2022-09-26 — first asteroid deflection test' },
    { des: '2024 YR4', label: '2024 YR4',   why: 'Briefly 3 % Earth-impact odds for 2032 (ruled out); ~4 % lunar-impact chance 2032-12-22' },
    { des: '3200',   label: 'Phaethon',     why: 'Parent of the Geminids; perihelion 0.14 AU; DESTINY+ flyby target' },
    { des: '433',    label: 'Eros',         why: 'First NEO discovered (1898); NEAR Shoemaker landed on it in 2001' },
    { des: '25143',  label: 'Itokawa',      why: 'Hayabusa sample returned 2010' },
    { des: '29075',  label: '1950 DA',      why: 'Highest long-term Palermo-scale risk; possible impact in 2880' },
    { des: '4179',   label: 'Toutatis',     why: 'Chang’e 2 flyby 2012; tumbling non-principal-axis rotator' },
    { des: '1566',   label: 'Icarus',       why: 'Perihelion 0.19 AU; first asteroid observed by radar (1968)' },
    { des: '2062',   label: 'Aten',         why: 'Prototype of the Aten class' },
    { des: '1862',   label: 'Apollo',       why: 'Prototype of the Apollo class' },
    { des: '1221',   label: 'Amor',         why: 'Prototype of the Amor class' },
    { des: '163693', label: 'Atira',        why: 'Prototype of the Atira class — orbits entirely inside Earth’s' },
    { des: '367943', label: 'Duende',       why: '2013-02-15 flyby at 27,700 km — inside geostationary orbit' },
    { des: '109P',   label: '109P/Swift–Tuttle', why: 'Parent of the Perseids; the largest known object with repeated close Earth encounters' },
    { des: '1P',     label: '1P/Halley',    why: 'Parent of the Orionids and η-Aquariids; next perihelion 2061' },
    { des: '2P',     label: '2P/Encke',     why: 'Parent of the Taurid complex; shortest comet period (3.3 yr)' },
    { des: '55P',    label: '55P/Tempel–Tuttle', why: 'Parent of the Leonids (storms of 1833, 1966, 1999)' },
    { des: '21P',    label: '21P/Giacobini–Zinner', why: 'Parent of the Draconids' },
    { nameIncludes: 'oumuamua', label: '1I/ʻOumuamua', why: 'First known interstellar object (2017); e ≈ 1.2, now beyond Neptune' },
    { nameIncludes: 'borisov',  label: '2I/Borisov',  why: 'Second interstellar object, an active comet (2019); e ≈ 3.4' },
    { nameIncludes: '3i/atlas', label: '3I/ATLAS',    why: 'Third interstellar object, found 2025-07-01; perihelion 2025-10-29 at 1.36 AU; e ≈ 6.1' },
    { nameIncludes: '2025 n1',  label: '3I/ATLAS',    why: 'Third interstellar object, found 2025-07-01; perihelion 2025-10-29 at 1.36 AU; e ≈ 6.1' },
]);

export function findNotable(rec) {
    if (!rec) return null;
    const des = String(rec.des ?? '');
    const name = String(rec.name ?? '').toLowerCase();
    for (const n of NOTABLES) {
        if (n.des && n.des === des) return n;
        if (n.nameIncludes && name.includes(n.nameIncludes)) return n;
    }
    return null;
}

// ── Meteor showers — the "meteors" half of near-Earth space ────────────────
//
// A shower is Earth crossing a parent body's debris stream. Activity is keyed
// to SOLAR LONGITUDE λ☉ (the stream node is fixed in the orbit, not the
// calendar), so the table stores λ☉ windows and the caller supplies λ☉ from
// Earth's heliocentric longitude (+180°). Values: IAU MDC established list /
// IMO working list, J2000. ZHR is the historical peak rate at zenith under a
// 6.5-mag sky — an ORDER-OF-MAGNITUDE guide, not a forecast. `parentDes` is
// the SBDB primary designation, which is how the layer finds the parent in
// the catalogue (comets are "NNP", asteroids their number).
export const METEOR_SHOWERS = Object.freeze([
    { code: 'QUA', name: 'Quadrantids',        peakLon: 283.15, startLon: 276.0, endLon: 291.0, zhr: 80,  vKms: 41, ra: 230, dec: 49,  parent: '(196256) 2003 EH1', parentDes: '196256', note: 'Sharp 6-hour peak' },
    { code: 'LYR', name: 'Lyrids',             peakLon: 32.32,  startLon: 24.0,  endLon: 40.0,  zhr: 18,  vKms: 49, ra: 271, dec: 34,  parent: 'C/1861 G1 (Thatcher)', parentDes: null, note: 'Outbursts of ~100 in 1922 and 1982' },
    { code: 'ETA', name: 'η-Aquariids',   peakLon: 45.5,   startLon: 29.0,  endLon: 67.0,  zhr: 50,  vKms: 66, ra: 338, dec: -1,  parent: '1P/Halley', parentDes: '1P', note: 'Best from the southern hemisphere' },
    { code: 'ARI', name: 'Daytime Arietids',   peakLon: 76.5,   startLon: 60.0,  endLon: 96.0,  zhr: 30,  vKms: 38, ra: 44,  dec: 24,  parent: '96P/Machholz complex', parentDes: '96P', note: 'Daytime shower — radio and pre-dawn only' },
    { code: 'JBO', name: 'June Boötids',  peakLon: 95.7,   startLon: 91.0,  endLon: 100.0, zhr: 5,   vKms: 18, ra: 224, dec: 48,  parent: '7P/Pons–Winnecke', parentDes: '7P', note: 'Variable; outbursts 1998 and 2004' },
    { code: 'CAP', name: 'α-Capricornids',peakLon: 127.0,  startLon: 101.0, endLon: 142.0, zhr: 5,   vKms: 23, ra: 307, dec: -10, parent: '169P/NEAT', parentDes: '169P', note: 'Slow, bright fireballs' },
    { code: 'SDA', name: 'S. δ-Aquariids',peakLon: 127.0,  startLon: 110.0, endLon: 150.0, zhr: 25,  vKms: 41, ra: 340, dec: -16, parent: '96P/Machholz (probable)', parentDes: '96P', note: '' },
    { code: 'PER', name: 'Perseids',           peakLon: 140.0,  startLon: 114.0, endLon: 151.0, zhr: 100, vKms: 59, ra: 48,  dec: 58,  parent: '109P/Swift–Tuttle', parentDes: '109P', note: 'The northern-summer standard' },
    { code: 'DRA', name: 'Draconids',          peakLon: 195.4,  startLon: 193.0, endLon: 197.5, zhr: 10,  vKms: 20, ra: 262, dec: 54,  parent: '21P/Giacobini–Zinner', parentDes: '21P', note: 'Storms 1933 and 1946; evening shower' },
    { code: 'STA', name: 'S. Taurids',         peakLon: 220.0,  startLon: 167.0, endLon: 238.0, zhr: 5,   vKms: 27, ra: 52,  dec: 15,  parent: '2P/Encke', parentDes: '2P', note: 'Fireball-rich swarm years (2022, 2025, 2029)' },
    { code: 'ORI', name: 'Orionids',           peakLon: 208.0,  startLon: 189.0, endLon: 225.0, zhr: 20,  vKms: 66, ra: 95,  dec: 16,  parent: '1P/Halley', parentDes: '1P', note: 'Fast, with persistent trains' },
    { code: 'NTA', name: 'N. Taurids',         peakLon: 230.0,  startLon: 207.0, endLon: 258.0, zhr: 5,   vKms: 29, ra: 58,  dec: 22,  parent: '2P/Encke (2004 TG10 branch)', parentDes: '2P', note: '' },
    { code: 'LEO', name: 'Leonids',            peakLon: 235.27, startLon: 224.0, endLon: 248.0, zhr: 10,  vKms: 71, ra: 152, dec: 22,  parent: '55P/Tempel–Tuttle', parentDes: '55P', note: 'Storms every ~33 yr (1833, 1966, 1999)' },
    { code: 'GEM', name: 'Geminids',           peakLon: 262.2,  startLon: 252.0, endLon: 268.0, zhr: 150, vKms: 35, ra: 112, dec: 33,  parent: '(3200) Phaethon', parentDes: '3200', note: 'Strongest annual shower; asteroidal parent' },
    { code: 'URS', name: 'Ursids',             peakLon: 270.7,  startLon: 265.0, endLon: 275.0, zhr: 10,  vKms: 33, ra: 217, dec: 76,  parent: '8P/Tuttle', parentDes: '8P', note: 'Outbursts 1945 and 1986' },
]);

/** Solar longitude λ☉ (deg, 0–360) from Earth's heliocentric ecliptic longitude. */
export function solarLongitudeDeg(earthLonRad) {
    return ((earthLonRad * R2D + 180) % 360 + 360) % 360;
}

function lonDelta(a, b) {
    let d = ((a - b) % 360 + 360) % 360;
    if (d > 180) d -= 360;
    return d;
}

/**
 * Relative activity (0–1) of a shower at λ☉: an asymmetric Gaussian whose
 * half-widths are the table's window edges (activity ≈ 0.05 at the edges,
 * 1 at the peak). Zero outside the window.
 */
export function showerActivity(shower, solarLonDeg) {
    const d = lonDelta(solarLonDeg, shower.peakLon);
    const before = lonDelta(shower.peakLon, shower.startLon);   // > 0
    const after  = lonDelta(shower.endLon, shower.peakLon);     // > 0
    if (d < -before || d > after) return 0;
    const half = d < 0 ? before : after;
    // σ such that the edge sits at e^{-3} ≈ 0.05
    const sigma = half / Math.sqrt(6);
    return Math.exp(-(d * d) / (2 * sigma * sigma));
}

/** Showers active at λ☉, strongest (ZHR × activity) first. */
export function activeShowers(solarLonDeg) {
    return METEOR_SHOWERS
        .map(s => ({ shower: s, activity: showerActivity(s, solarLonDeg) }))
        .filter(x => x.activity > 0)
        .map(x => ({ ...x, rate: x.shower.zhr * x.activity }))
        .sort((a, b) => b.rate - a.rate);
}

/** Next shower peak at or after λ☉ (wrapping), with degrees of λ☉ to go. */
export function nextShower(solarLonDeg) {
    let best = null;
    for (const s of METEOR_SHOWERS) {
        const ahead = ((s.peakLon - solarLonDeg) % 360 + 360) % 360;
        if (!best || ahead < best.degAhead) best = { shower: s, degAhead: ahead };
    }
    // λ☉ advances ~0.9856°/day
    if (best) best.daysAhead = best.degAhead / 0.98564736;
    return best;
}

/** J2000 equatorial radiant (deg) → ecliptic unit vector (the direction meteoroids come FROM). */
export function radiantEclipticUnit(raDeg, decDeg) {
    const eps = 23.4392911 * D2R;
    const ra = raDeg * D2R, dec = decDeg * D2R;
    const xq = Math.cos(dec) * Math.cos(ra);
    const yq = Math.cos(dec) * Math.sin(ra);
    const zq = Math.sin(dec);
    return {
        x: xq,
        y:  yq * Math.cos(eps) + zq * Math.sin(eps),
        z: -yq * Math.sin(eps) + zq * Math.cos(eps),
    };
}

// ── Photometry: what a telescope on Earth sees RIGHT NOW ────────────────────
// The far field used to size and brighten its sprites by ABSOLUTE magnitude,
// which made 42 000 objects a wall of 10–25 px blobs at any zoom (measured on
// the 2026-09-13 deploy). The one honest brightness is the APPARENT V
// magnitude from Earth at the sim instant — IAU H–G (Bowell et al. 1989):
//   V = H + 5 log10(r Δ) − 2.5 log10((1−G) Φ1(α) + G Φ2(α)),  G = 0.15
// so a 30 m rock at 0.1 AU and a 5 km one at 3 AU can be equally bright, and
// that is the point: brightness now encodes observability, not size. Comets
// use the total-magnitude power law m = M1 + 5 log10 Δ + 10 log10 r (n = 4).
// The display maps below turn V into a point size and alpha; both are pure,
// monotone and bounded, and tests/neo-orbits.mjs pins those bounds.
export const HG_DEFAULT_G = 0.15;
export const EARTH_RADIUS_KM = 6371.0088;

/** Phase angle (deg) Sun–object–Earth from the heliocentric and geocentric vectors of the object (any frame, same units). */
export function phaseAngleDeg(hx, hy, hz, gx, gy, gz) {
    const r = Math.hypot(hx, hy, hz), d = Math.hypot(gx, gy, gz);
    if (!(r > 0) || !(d > 0)) return null;
    const c = (hx * gx + hy * gy + hz * gz) / (r * d);
    return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}
/** Solar elongation (deg) as seen from Earth: Earth's heliocentric vector E and the object's geocentric vector g. 0 = at the Sun, 180 = opposition. */
export function elongationDeg(ex, ey, ez, gx, gy, gz) {
    const r = Math.hypot(ex, ey, ez), d = Math.hypot(gx, gy, gz);
    if (!(r > 0) || !(d > 0)) return null;
    const c = -(ex * gx + ey * gy + ez * gz) / (r * d);
    return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}
/** IAU H–G phase function Φ(α) — (1−G)Φ1 + GΦ2. Defined for α ≤ 120°; clamped at 150° where it is already ~0.003. */
export function hgPhaseFunction(alphaDeg, G = HG_DEFAULT_G) {
    const t = Math.tan(Math.max(0, Math.min(150, alphaDeg)) * D2R / 2);
    const phi1 = Math.exp(-3.33 * Math.pow(t, 0.63));
    const phi2 = Math.exp(-1.87 * Math.pow(t, 1.22));
    return (1 - G) * phi1 + G * phi2;
}
/**
 * Apparent V magnitude. `H` is the absolute magnitude (a comet's M1 with
 * `comet: true`), r and Δ in AU, α the phase angle in degrees. null when a
 * term is missing — the caller decides what "unknown" looks like.
 */
export function apparentMagnitude(H, rAU, deltaAU, alphaDeg = 0, opts = {}) {
    if (!Number.isFinite(H) || !(rAU > 0) || !(deltaAU > 0)) return null;
    if (opts.comet) return H + 5 * Math.log10(deltaAU) + 10 * Math.log10(rAU);
    const phi = hgPhaseFunction(Number.isFinite(alphaDeg) ? alphaDeg : 0, opts.G ?? HG_DEFAULT_G);
    return H + 5 * Math.log10(rAU * deltaAU) - 2.5 * Math.log10(Math.max(phi, 1e-12));
}

/**
 * Display maps V → sprite size (CSS px, before DPR and the near-camera
 * growth) and V → alpha. V 12 is a binocular object, V 23 the survey limit,
 * V 27.5 fainter than anything that can be observed tonight; the alpha floor
 * keeps the unobservable 90 % as a haze so the population still reads.
 */
export const MAG_DISPLAY = Object.freeze({
    sizeBrightV: 12, sizeFaintV: 23, sizeMaxPx: 3.4, sizeMinPx: 1.4,
    alphaBrightV: 14, alphaFaintV: 27.5, alphaMin: 0.10,
    unknownAlpha: 0.45,          // no H at all (many comets): a mid-grey, never invisible
});
export function magnitudeSizePx(V) {
    const D = MAG_DISPLAY;
    if (!Number.isFinite(V)) return (D.sizeMaxPx + D.sizeMinPx) / 2;
    const t = Math.max(0, Math.min(1, (V - D.sizeBrightV) / (D.sizeFaintV - D.sizeBrightV)));
    return D.sizeMaxPx - (D.sizeMaxPx - D.sizeMinPx) * t;
}
export function magnitudeAlpha(V) {
    const D = MAG_DISPLAY;
    if (!Number.isFinite(V)) return D.unknownAlpha;
    const t = Math.max(0, Math.min(1, (V - D.alphaBrightV) / (D.alphaFaintV - D.alphaBrightV)));
    return 1 - (1 - D.alphaMin) * t;
}

// ── Sizes: true scale with a pixel floor, exaggeration DISCLOSED ────────────
// The drawn Earth is 6371 km at LOCAL_FRAME.earthSceneRadius, so a body's
// true-scale radius in that convention is (D/2)·earthR/R⊕ — Eros is 1.6e-4
// units, a 30 m flyby 3e-7: invisible, correctly. Rocks are therefore drawn at
// max(true scale, a floor that subtends `minPx` on screen at the current
// camera distance); the ratio is reported on the data card as "drawn ×N".
// Never use these radii for physics.
export function trueScaleRadius(diamKm, earthR = LOCAL_FRAME.earthSceneRadius) {
    return Number.isFinite(diamKm) && diamKm > 0 ? (diamKm / 2) * earthR / EARTH_RADIUS_KM : 0;
}
/** Scene radius that subtends `minPx` (radius) at `camDist` for a vertical-fov camera over `viewHeightPx`. */
export function pixelFloorRadius(camDist, minPx, viewHeightPx = 900, fovDeg = 50) {
    return Math.max(0, camDist) * (minPx / Math.max(1, viewHeightPx)) * 2 * Math.tan(fovDeg * D2R / 2);
}
export function rockDrawRadius(diamKm, { camDist = 1, minPx = 5, viewHeightPx = 900, fovDeg = 50, earthR } = {}) {
    const rTrue = trueScaleRadius(diamKm, earthR);
    const floor = pixelFloorRadius(camDist, minPx, viewHeightPx, fovDeg);
    const r = Math.max(rTrue, floor, 1e-7);
    return { r, rTrue, floor, exaggeration: rTrue > 0 ? r / rTrue : null, atFloor: floor > rTrue };
}

// ── Orbit analysis (pure; every row on the card comes from here) ────────────
export const JUPITER_A_AU = 5.2026;
/** Tisserand parameter w.r.t. Jupiter — T_J > 3 asteroidal, 2–3 Jupiter-family, < 2 Halley-type / long-period. Bound orbits only. */
export function tisserandJ(a, e, iDeg, aJ = JUPITER_A_AU) {
    if (!(a > 0) || !(e >= 0) || !(e < 1)) return null;
    return aJ / a + 2 * Math.cos(iDeg * D2R) * Math.sqrt((a / aJ) * (1 - e * e));
}
/** Heliocentric distance (AU) where the orbit pierces the ecliptic: ν = −ω (ascending), 180° − ω (descending). null on an unreachable hyperbolic branch. */
export function nodeDistancesAU(el) {
    const p = el.a * (1 - el.e * el.e);
    const at = (nu) => { const den = 1 + el.e * Math.cos(nu); return den > 1e-9 ? p / den : null; };
    const w = el.w * D2R;
    return { asc: at(-w), desc: at(Math.PI - w) };
}
/** Earth's heliocentric distance range (perihelion .. aphelion). */
export const EARTH_ORBIT_RANGE_AU = Object.freeze([0.9833, 1.0167]);
export function earthCrossingNote(nodes, range = EARTH_ORBIT_RANGE_AU) {
    const inBand = (r) => r != null && r >= range[0] && r <= range[1];
    const which = [inBand(nodes.asc) ? 'ascending' : null, inBand(nodes.desc) ? 'descending' : null].filter(Boolean);
    if (which.length === 2) return 'crosses Earth’s orbit at both nodes';
    if (which.length === 1) return `crosses Earth’s orbit at the ${which[0]} node`;
    return 'no node inside Earth’s orbital band';
}
/** JD of the next perihelion passage at or after `jd`; null for a hyperbolic orbit already past perihelion. */
export function nextPerihelionJD(el, jd) {
    if (!(el.n > 0)) return null;
    if (el.e < 1) {
        const M = el.M0 + el.n * (jd - el.t0);
        const Mw = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        return jd + ((2 * Math.PI - Mw) % (2 * Math.PI)) / el.n;
    }
    const tp = el.t0 - el.M0 / el.n;
    return tp >= jd ? tp : null;
}
export function jdToIsoDate(jd) {
    const ms = (jd - 2440587.5) * 86400e3;
    return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '—';
}
/** Ecliptic longitude/latitude (deg) of a vector; longitude wrapped to [0, 360). */
export function eclipticLonLatDeg(x, y, z) {
    const r = Math.hypot(x, y, z);
    if (!(r > 0)) return { lon: null, lat: null };
    return { lon: ((Math.atan2(y, x) * R2D) % 360 + 360) % 360, lat: Math.asin(Math.max(-1, Math.min(1, z / r))) * R2D };
}

// ── Planet paths for the orrery ─────────────────────────────────────────────
// The page's planets used to ride mean-motion CIRCLES phased once at load —
// Mercury's equation of centre alone is ±23°, Mars's ±10.6°, and the radial
// swing (Mercury 0.31–0.47 AU) did not exist at all, so an NEO drawn from a
// true Kepler solve sat at the wrong place relative to every inner planet.
// The planets now follow their ephemeris functions (js/horizons.js) through
// the SAME helioToScene the objects use, and an orbit ribbon is the sampled
// TRUE path over one period around the sim date — the line the planet
// actually traces, no element bookkeeping. Rebuilt every ~10 years of scrub.
export function ephemerisPathScene(ephFn, jd, periodDays, samples = 256) {
    const out = new Float32Array(samples * 3);
    for (let k = 0; k < samples; k++) {
        const e = ephFn(jd - periodDays / 2 + (k / samples) * periodDays);
        const s = helioToScene(e.x_AU, e.y_AU, e.z_AU);
        out[k * 3] = s.x; out[k * 3 + 1] = s.y; out[k * 3 + 2] = s.z;
    }
    return out;
}
/**
 * Closed ribbon (triangle strip) around a closed polyline of scene points:
 * each vertex is offset ±halfWidth along the in-plane side vector
 * (orbit-plane normal × tangent), so the strip is a flat band in the orbital
 * plane — the same look as the old RingGeometry annulus, on the true ellipse.
 */
export function ribbonStrip(pts, halfWidth) {
    const n = pts.length / 3;
    const positions = new Float32Array(n * 6);
    const indices = new Uint32Array(n * 6);
    for (let i = 0; i < n; i++) {
        const ip = (i + n - 1) % n, inx = (i + 1) % n;
        const px = pts[i * 3], py = pts[i * 3 + 1], pz = pts[i * 3 + 2];
        let tx = pts[inx * 3] - pts[ip * 3], ty = pts[inx * 3 + 1] - pts[ip * 3 + 1], tz = pts[inx * 3 + 2] - pts[ip * 3 + 2];
        const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
        let nx = py * tz - pz * ty, ny = pz * tx - px * tz, nz = px * ty - py * tx;   // p × t: plane normal
        const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
        const sx = ny * tz - nz * ty, sy = nz * tx - nx * tz, sz = nx * ty - ny * tx;   // n × t: in-plane side
        positions[i * 6]     = px + sx * halfWidth; positions[i * 6 + 1] = py + sy * halfWidth; positions[i * 6 + 2] = pz + sz * halfWidth;
        positions[i * 6 + 3] = px - sx * halfWidth; positions[i * 6 + 4] = py - sy * halfWidth; positions[i * 6 + 5] = pz - sz * halfWidth;
        const a = 2 * i, b = 2 * i + 1, c = 2 * inx, d = 2 * inx + 1;
        indices[i * 6] = a; indices[i * 6 + 1] = b; indices[i * 6 + 2] = c;
        indices[i * 6 + 3] = b; indices[i * 6 + 4] = d; indices[i * 6 + 5] = c;
    }
    return { positions, indices };
}
