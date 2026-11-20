/**
 * flare-geometry.js — the ONE copy of solar flare-site geometry (PURE).
 * ═══════════════════════════════════════════════════════════════════════════
 * Where a flare IS on the Sun, which way it FACES, how it CO-ROTATES, and
 * how its arcade and eruption are oriented in the local tangent frame. Every
 * renderer that draws flare activity — sun.html's photosphere shader, AR
 * slots, marker groups and the 3D arcade (`js/flare-arcade.js`), the
 * solar-system orrery, the 2D flare modeler — reads its geometry from here.
 * No DOM, no three.js, no fetch, no ambient time: `tests/flare-geometry.mjs`
 * pins every rule below, several of them against three.js's own matrix math
 * so the frame conventions cannot silently diverge from what the renderer
 * actually does with them.
 *
 * WHY THIS FILE EXISTS (2026-09-13). Four copies of "where is the flare"
 * disagreed with each other, measured before this module was written:
 *   · sunFS rotated the photosphere and the AR spots EAST (+lon decreasing)
 *     while every 3D marker group rotated WEST, at 1.8× the rate
 *     (0.004·2π vs 0.014 rad per sim unit) — markers left their sunspots
 *     within ~10 s of model-mode time;
 *   · the ribbons compared against a Stonyhurst longitude that never
 *     rotated at all;
 *   · `js/swpc-feed.js` parsed "N12W19" with EAST positive, so every
 *     SWPC-driven flare on sun.html and the orrery fired on the mirror
 *     side of the disk;
 *   · the orrery placed Carrington longitudes as if they were Stonyhurst
 *     and ignored where Earth was, and spun the Sun retrograde relative
 *     to the planets' orbits.
 * Each of these is now one function here, one test there.
 *
 * ── Frames ─────────────────────────────────────────────────────────────────
 *   SUN FRAME (sun.html, the sphere's object space): +y is the rotation
 *   axis (solar north), +z points at the sub-Earth observer, +x is solar
 *   WEST (image-right in every SDO frame). Heliographic (lat, lon) is
 *   Stonyhurst with W positive — the NOAA convention "N12W19" — and maps to
 *   (cos lat sin lon, sin lat, cos lat cos lon), so lon = atan2(x, z).
 *   Solar rotation is prograde about +y: a disk-centre feature moves toward
 *   +x. That is three.js `makeRotationY(+θ)` — `rotateY()` here is pinned
 *   equal to it.
 *
 *   HELIOCENTRIC SCENE (solar-system.html): y up, azimuth measured from +x
 *   toward +z (its `latLonToVec3`). Stonyhurst longitude is measured from
 *   the sub-Earth meridian, so a site's azimuth is Earth's azimuth plus the
 *   longitude, counted in the sense the drawn Sun spins (`spinSign`).
 *   NOAA's `carrington_longitude` is NOT Stonyhurst: subtract L0, the
 *   Carrington longitude of the central meridian (`solarEphemeris(date)
 *   .l0Deg`, Meeus ch. 29, pinned to his worked example AND to L0 = 0 at
 *   the start of Carrington rotation 1).
 *
 * ── Rotation ───────────────────────────────────────────────────────────────
 *   The sim frame rotates by ONE equatorial angle (`u_rotAngle` on
 *   sun.html, accumulated at SIM_ROT_RATE·u_rot per sim unit) and every
 *   latitude turns by that angle times the Snodgrass factor
 *   (`diffRotFactor`, sun-observed.js — the same fit sunFS carries inline).
 *   A Stonyhurst location is a position at sim epoch t = 0 (page load);
 *   `siteLonAt` is where it is now, `epochLonFor` is its inverse for a
 *   location observed NOW that must be stored in epoch coordinates.
 *
 * ── The PIL prior ──────────────────────────────────────────────────────────
 *   When no field atlas supplies the real polarity-inversion line (that is
 *   sun.html without `?debug=field`, and always on the orrery), the arcade
 *   and the ribbons are oriented by Joy's law: a bipole's axis is tilted
 *   from east–west by ≈ 0.5 × latitude with the leading (western) spot
 *   equatorward (Hale et al. 1919), and the PIL runs perpendicular to that
 *   axis. It is a PRIOR and is labelled as such by consumers; real
 *   footpoint pairs from `js/flare-ribbons.js` override it loop by loop.
 *
 * ── Ribbon / arcade laws ───────────────────────────────────────────────────
 *   ONE overridable parameter set (FLARE_SHAPE_*, makeFlareModel) — see the
 *   laws section. sunFS holds NO shape law: the page uploads this model's
 *   separation / width / length / decay each frame, and
 *   `tests/flare-geometry.mjs` fails if a literal law reappears in the
 *   shader. The arcade is the 3D counterpart of those ribbons: loops
 *   straddle the PIL at the ribbon separation, sheared strong-to-weak as
 *   reconnection proceeds (Aulanier et al. 2012), apex over the PIL. How
 *   close the shape is to observed flares is MEASURED, by
 *   js/flare-realism.js.
 */

import { diffRotFactor, solarEphemeris } from './sun-observed.js';

export const DEG = Math.PI / 180;
export const TWO_PI = Math.PI * 2;

/** Equatorial sim-frame rotation rate: rad per sim unit per unit `u_rot` (sunFS `rotLon`). */
export const SIM_ROT_RATE = 0.014;
export const SUN_SIDEREAL_DAYS = 25.38;
export const SUN_SYNODIC_DAYS = 27.2753;
/** Sidereal angular velocity of the Sun's equator, rad/s. */
export const OMEGA_SUN_SIDEREAL = TWO_PI / (SUN_SIDEREAL_DAYS * 86400);
export const AU_KM = 1.495978707e8;

// ── Small vector helpers (arrays, not three.js) ───────────────────────────
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
function unit(a) {
    const n = norm(a) || 1;
    return [a[0] / n, a[1] / n, a[2] / n];
}
export const vec = Object.freeze({ dot, cross, norm, scale, add, unit });

// ═══════════════════════════════════════════════════════════════════════════
//  Stonyhurst strings
// ═══════════════════════════════════════════════════════════════════════════

/**
 * "N12W19" → { latDeg: 12, lonDeg: 19 }; "S05E34" → { latDeg: -5, lonDeg: -34 }.
 * WEST IS POSITIVE (heliographic convention; NOAA prints W as +). Returns
 * null for anything else — callers must not fall back to (0, 0), which is
 * disk centre and reads as an Earth-directed event.
 */
export function parseStonyhurst(s) {
    // Unanchored on purpose: NOAA / DONKI sometimes append a region number
    // ("N12W19 (AR 14101)"); the feed's old regex tolerated that, so does this.
    const m = String(s ?? '').toUpperCase().match(/([NS])\s*(\d{1,2})\s*([EW])\s*(\d{1,3})(?!\d)/);
    if (!m) return null;
    const lat = (m[1] === 'N' ? 1 : -1) * Number(m[2]);
    const lon = (m[3] === 'W' ? 1 : -1) * Number(m[4]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { latDeg: lat, lonDeg: lon };
}

/** Inverse of parseStonyhurst (rounded to whole degrees, zero-padded). */
export function formatStonyhurst(latDeg, lonDeg) {
    const la = Math.round(Math.abs(latDeg)), lo = Math.round(Math.abs(lonDeg));
    return `${latDeg < 0 ? 'S' : 'N'}${String(la).padStart(2, '0')}${lonDeg < 0 ? 'E' : 'W'}${String(lo).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Sun frame (sun.html)
// ═══════════════════════════════════════════════════════════════════════════

/** Unit vector for heliographic (lat, lon) radians: +y north, +z sub-Earth, +x west. */
export function stonyhurstToUnit(latRad, lonRad) {
    const cl = Math.cos(latRad);
    return [cl * Math.sin(lonRad), Math.sin(latRad), cl * Math.cos(lonRad)];
}

/** Inverse of stonyhurstToUnit for any non-zero vector. */
export function unitToStonyhurst(v) {
    const r = norm(v) || 1;
    return {
        latRad: Math.asin(Math.max(-1, Math.min(1, v[1] / r))),
        lonRad: Math.atan2(v[0], v[2]),
    };
}

/**
 * Rotation about +y by `ang` — EXACTLY three.js Matrix4.makeRotationY(ang):
 * x' = c·x + s·z, z' = −s·x + c·z. Positive ang carries +z toward +x, i.e.
 * a disk-centre feature moves WEST. This is the Sun's prograde spin.
 */
export function rotateY(v, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

/** Equatorial rotation angle accumulated over `tSim` sim units at multiplier `uRot`. */
export function rotationAngle(tSim, uRot = 1) {
    return tSim * SIM_ROT_RATE * uRot;
}

/** How far a site at `latRad` has turned when the equator has turned `eqAngle`. */
export function siteRotation(eqAngle, latRad) {
    return eqAngle * diffRotFactor(latRad);
}

/** Current longitude of a site whose epoch (t = 0) longitude was `lonRad0`. */
export function siteLonAt(lonRad0, eqAngle, latRad) {
    return lonRad0 + siteRotation(eqAngle, latRad);
}

/** Epoch longitude for a site observed at `lonRadNow` when the equator has turned `eqAngle`. */
export function epochLonFor(lonRadNow, eqAngle, latRad) {
    return lonRadNow - siteRotation(eqAngle, latRad);
}

/** Current unit position of an epoch-frame site. */
export function sitePositionAt(latRad, lonRad0, eqAngle) {
    return stonyhurstToUnit(latRad, siteLonAt(lonRad0, eqAngle, latRad));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Local tangent frame + the PIL prior
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Orthonormal right-handed frame at a site: `radial` (outward), `east`
 * (∂/∂lon, the direction of rotation), `north` (∂/∂lat). east × north = radial.
 */
export function localFrame(latRad, lonRad) {
    const sl = Math.sin(latRad), cl = Math.cos(latRad);
    const so = Math.sin(lonRad), co = Math.cos(lonRad);
    return {
        radial: [cl * so, sl, cl * co],
        east:   [co, 0, -so],
        north:  [-sl * so, cl, -sl * co],
    };
}

/**
 * Joy's law tilt of a bipole axis, radians, measured from local east toward
 * local north. ≈ 0.5 × |lat| with the sign that puts the LEADING (western)
 * spot equatorward: negative in the north (west end dips south), positive
 * in the south. Zero on the equator.
 */
export function joyTiltRad(latRad) {
    return -Math.sign(latRad) * 0.5 * Math.abs(latRad);
}

/** Bipole axis (following → leading spot) in the tangent plane, unit. */
export function bipoleAxis(latRad, lonRad) {
    const f = localFrame(latRad, lonRad);
    const g = joyTiltRad(latRad);
    return add(scale(f.east, Math.cos(g)), scale(f.north, Math.sin(g)));
}

/**
 * The PIL prior: perpendicular to the Joy's-law bipole axis, as an angle from
 * local east toward local north, wrapped to (−π/2, π/2].
 */
export function pilAngleRad(latRad) {
    let a = joyTiltRad(latRad) + Math.PI / 2;
    while (a > Math.PI / 2) a -= Math.PI;
    while (a <= -Math.PI / 2) a += Math.PI;
    return a;
}

/**
 * Tangent frame with the PIL laid in: `pilAxis` runs along the inversion
 * line, `loopAxis` crosses it (pilAxis rotated +90° about `radial`). Arcade
 * loops run along loopAxis; ribbons run along pilAxis at ±separation along
 * loopAxis. `pilAngle` defaults to the Joy's-law prior.
 */
export function tangentFrame(latRad, lonRad, pilAngle = pilAngleRad(latRad)) {
    const f = localFrame(latRad, lonRad);
    const c = Math.cos(pilAngle), s = Math.sin(pilAngle);
    return {
        ...f,
        pilAngle,
        pilAxis:  add(scale(f.east, c), scale(f.north, s)),
        loopAxis: add(scale(f.east, -s), scale(f.north, c)),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Ribbon / arcade / plume laws — ONE parameter set, overridable
// ═══════════════════════════════════════════════════════════════════════════

/**
 * THE FLARE'S SHAPE IS A MODEL WITH PARAMETERS, AND THE PARAMETERS ARE DATA.
 *
 * Every law below — how far apart the ribbons stand and how fast they part,
 * how sheared the loops are, how tall, how long the arcade is, how the
 * brightening runs along the inversion line — reads ONE parameter set. A set
 * is plain numbers, so it can be:
 *
 *   scored     js/flare-realism.js measures a model against published
 *              observational ranges and returns a scorecard; the committed
 *              baseline can only ratchet up (tests/flare-realism.mjs);
 *   compared   `makeFlareModel(overrides)` builds a candidate without editing
 *              this file; `node scripts/flare-realism.mjs --try '{…}'` scores
 *              it against the shipped one, `--sweep path=lo:hi:n` walks one
 *              parameter;
 *   swapped    sun.html draws whatever model it is handed
 *              (`__sun.setFlareModel`, `?flaremodel=v1`), and its shader holds
 *              NO shape law of its own — the page feeds it this model's
 *              numbers every frame. One copy.
 *
 * `FLARE_SHAPE_V1` is the set of laws shipped until 2026-11-21, kept EXACTLY
 * (the gate re-derives its closed forms) so there is always a reference to
 * score against: linear ribbon separation from 28 Mm apart, loops 2–3× taller
 * than their footpoint span, shear 30° → 7°. `FLARE_SHAPE_V2` is the first set
 * chosen WITH the scorecard. Units: radians of arc on the unit sphere (1 rad =
 * 695.7 Mm), `t` in sim units since onset (sun.html: 0.35 per second).
 */
function deepFreeze(o) {
    for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
    return Object.freeze(o);
}

export const FLARE_SHAPE_V2 = deepFreeze({
    id: 'flare-shape-v2',
    /** GOES class → size factor. Ordered A < B < C < M < X; unknown reads as M. */
    classFactor: { A: 0.35, B: 0.45, C: 0.60, M: 0.85, X: 1.15 },
    ribbon: {
        sep0: 0.008,        // half-separation across the PIL at onset — ribbons start close to the inversion line
        sepRate: 0,         // linear term, rad per sim unit (the v1 law; off)
        sepGain: 0.032,     // reach of the saturating term per unit classFactor: sep → sep0 + sepGain·cf
        sepTau: 250,        // its e-folding, sim units — ribbons part fast, then slow
        wid0: 0.005, widRate: 6.0e-6,           // ribbon width (Gaussian scale) and its growth
        len0: 0.095, lenGrowT: 2500.0,          // along-PIL 1/e half-length per unit classFactor; σ² doubles in lenGrowT
        decayT: 175.0,                          // e-folding of the ribbon brightness
    },
    /** Shear angle: between the line joining a loop's feet and the normal to the PIL. Relaxes in tan-space. */
    shear: { onsetDeg: 62, onsetComplexDeg: 72, finalDeg: 22, relaxT: 250 },
    /** Apex height = (a + b·cf) × the half footpoint CHORD (onChord 1) or the half separation (0). */
    height: { a: 0.85, b: 0.10, onChord: 1 },
    arcade: {
        spanSigma: 0.6,     // loops are laid over ±spanSigma·σ of the ribbon envelope
        formT0: 30,         // sim units — formation-time scale
        formGrowth: 1.5,    // each generation waits this much longer than the last
        zipT: 90,           // sim units for the brightening to reach the arcade's ends
        zipCore: 0.22,      // the central fraction of the arcade that lights AT onset
        fadeIn: 9,          // sim units for a new loop to come up
        alongJitter: 0.38,  // station spacing irregularity, fraction of the mean spacing
        heightJitter: 0.14, // loop-to-loop height scatter, fraction
        timeJitter: 0.35,   // formation-time scatter, fraction of the gap to the next generation
        maxGenerations: 7,
    },
    plume: { speed: 0.06, reach: 2.4 },
});

/** The laws shipped until 2026-11-21 — the reference every later set is scored against. Never edit. */
export const FLARE_SHAPE_V1 = deepFreeze({
    id: 'flare-shape-v1',
    classFactor: { A: 0.35, B: 0.45, C: 0.60, M: 0.85, X: 1.15 },
    ribbon: { sep0: 0.020, sepRate: 2.5e-5, sepGain: 0, sepTau: 250,
              wid0: 0.005, widRate: 6.0e-6, len0: 0.095, lenGrowT: 2500.0, decayT: 175.0 },
    // tan(shear) was 0.45·e^(−t/250) + 0.12 (0.75 for δ regions): the same form, in angles.
    shear: { onsetDeg: Math.atan(0.57) / DEG, onsetComplexDeg: Math.atan(0.87) / DEG, finalDeg: Math.atan(0.12) / DEG, relaxT: 250 },
    // height was 2·sep·(0.6 + 0.7·cf), on the separation — not the footpoint chord.
    height: { a: 1.2, b: 1.4, onChord: 0 },
    arcade: { spanSigma: 0.6, formT0: 30, formGrowth: 1.5, zipT: 45, zipCore: 0.22, fadeIn: 9,
              alongJitter: 0.38, heightJitter: 0.14, timeJitter: 0.35, maxGenerations: 7 },
    plume: { speed: 0.06, reach: 2.4 },
});

/** The set the site ships. Change it only with a scorecard that did not go down. */
export const FLARE_SHAPE_DEFAULT = FLARE_SHAPE_V2;

/**
 * Deep-merge overrides onto a base set. An unknown key THROWS: a typo in an
 * override must not silently score (or draw) the base model.
 */
export function mergeFlareShape(base, over, path = '') {
    if (over == null) return base;
    if (typeof over !== 'object' || Array.isArray(over)) throw new Error(`flare shape: ${path || 'overrides'} must be an object`);
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
        if (!(k in base)) throw new Error(`flare shape: unknown parameter "${path}${k}"`);
        if (base[k] && typeof base[k] === 'object') out[k] = mergeFlareShape(base[k], v, `${path}${k}.`);
        else if (k === 'id') out[k] = String(v);
        else {
            if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`flare shape: "${path}${k}" must be a finite number`);
            out[k] = v;
        }
    }
    return out;
}

/** Deterministic hash → [0, 1). (station, generation, salt) under a site seed. */
export function arcadeHash(seed, i, k, salt = 0) {
    let h = (seed ^ Math.imul(i + 1, 0x9E3779B1) ^ Math.imul(k + 1, 0x85EBCA6B) ^ Math.imul(salt + 1, 0xC2B2AE35)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7FEB352D); h = Math.imul(h ^ (h >>> 15), 0x846CA68B);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Site → seed, quantised to a degree so float jitter never re-rolls a flare's arcade. */
export function arcadeSeed(latRad, lonRad) {
    return (Math.imul(Math.round(latRad / DEG) + 91, 73856093) ^ Math.imul(Math.round(lonRad / DEG) + 181, 19349663)) >>> 0;
}

/** One loop: a great-circle arc between two feet, lifted by a sine so the apex sits over their midpoint. */
function liftedLoop(fa, fb, h, samples) {
    const cosw = Math.max(-1, Math.min(1, dot(fa, fb)));
    const w = Math.acos(cosw), sw = Math.sin(w);
    const pts = [];
    for (let j = 0; j <= samples; j++) {
        const u = j / samples;
        const p = sw < 1e-9 ? fa : add(scale(fa, Math.sin((1 - u) * w) / sw), scale(fb, Math.sin(u * w) / sw));
        pts.push(scale(unit(p), 1 + h * Math.sin(Math.PI * u)));
    }
    return pts;
}

/**
 * Build a flare-shape model from a parameter set. `overrides` is deep-merged
 * onto `base` (unknown keys throw). The returned object carries every law the
 * consumers call, bound to those parameters, plus `params` itself.
 */
export function makeFlareModel(overrides = null, base = FLARE_SHAPE_DEFAULT) {
    const P = deepFreeze(mergeFlareShape(base, overrides));
    const { ribbon: R, shear: S, height: H, arcade: A, plume: PL } = P;
    const tanOnset = Math.tan(S.onsetDeg * DEG), tanOnsetC = Math.tan(S.onsetComplexDeg * DEG), tanFinal = Math.tan(S.finalDeg * DEG);

    function classFactor(cls) {
        const k = String(cls ?? 'M').trim()[0]?.toUpperCase();
        return P.classFactor[k] ?? P.classFactor.M;
    }
    /** Half-separation of the ribbons across the PIL: a fast start that saturates (bigger flares part further). */
    const ribbonSeparation = (t, cls = 'M') =>
        R.sep0 + t * R.sepRate + R.sepGain * classFactor(cls) * (1 - Math.exp(-Math.max(t, 0) / R.sepTau));
    const ribbonWidth = (t) => R.wid0 + t * R.widRate;
    /**
     * Along-PIL 1/e half-length of the ribbons at onset, radians — SCALED BY CLASS.
     * It was one constant for every flare until 2026-11-20, √0.10 = 0.316 rad: a
     * ribbon 440 Mm from 1/e point to 1/e point (0.63 R☉) standing 28 Mm apart.
     * With len0 = 0.095 the 1/e length is 152 Mm for X, 112 Mm for M, 79 Mm for C.
     */
    const ribbonLength0 = (cls = 'M') => R.len0 * classFactor(cls);
    const ribbonAlongSigma = (t, cls = 'M') => ribbonLength0(cls) * Math.sqrt(1 + Math.max(t, 0) / R.lenGrowT);
    const ribbonDecay = (t) => Math.exp(-t / R.decayT);

    /**
     * Arcade shear as tan(θ): footpoint offset along the PIL per unit separation.
     * Strong at onset, relaxing toward near-potential (the strong-to-weak shear
     * change of two-ribbon flares). δ regions start more sheared.
     */
    const arcadeShear = (t, complex = false) => tanFinal + ((complex ? tanOnsetC : tanOnset) - tanFinal) * Math.exp(-t / S.relaxT);
    const arcadeShearAngle = (t, complex = false) => Math.atan(arcadeShear(t, complex));
    /** Apex height above the photosphere, R☉ — a fixed multiple of the loop's own footpoint span. */
    const arcadeHeight = (t, cls = 'M', complex = false) => {
        const sh = arcadeShear(t, complex);
        return (H.a + H.b * classFactor(cls)) * ribbonSeparation(t, cls) * (H.onChord ? Math.sqrt(1 + sh * sh) : 1);
    };
    /** When generation k forms, sim units after its station lights (unjittered). */
    const arcadeFormTime = (k) => A.formT0 * (Math.pow(A.formGrowth, k) - 1);

    /**
     * Post-flare arcade loops as polylines in the SUN FRAME (epoch coordinates —
     * the caller rotates by `siteRotation`): ONE generation, the arcade at the
     * current ribbon separation. Without `pairs`, `n` loops are laid along the
     * PIL over ±spanSigma·σ of the ribbon envelope; with `pairs` (the atlas's
     * conjugate footpoints, `{ a, b, apexR? }`) each pair is one loop.
     * Each loop: { pts, footA, footB, apexR, along, weight }, footA on the
     * +loopAxis side, `weight` the ribbon envelope at `along`.
     */
    function arcadeLoops({ latRad, lonRad, pilAngle, t = 0, cls = 'M', n = 9, complex = false, pairs = null, samples = 24 } = {}) {
        const frame = tangentFrame(latRad, lonRad, pilAngle);
        const h = arcadeHeight(t, cls, complex);
        const out = [];
        const loopFrom = (fa, fb, apexR, along, weight) => {
            const a = unit(fa), b = unit(fb);
            return { pts: liftedLoop(a, b, apexR - 1, samples), footA: a, footB: b, apexR, along, weight };
        };
        if (pairs && pairs.length) {
            for (const pr of pairs) {
                if (!pr?.a || !pr?.b) continue;
                const apexR = Number.isFinite(pr.apexR) && pr.apexR > 1 ? pr.apexR : 1 + h;
                const mid = unit(add(pr.a, pr.b));
                const along = dot(add(mid, scale(frame.radial, -1)), frame.pilAxis);
                // Keep footA on the +loopAxis side so consumers can tell the sides apart.
                const sideA = dot(pr.a, frame.loopAxis) >= dot(pr.b, frame.loopAxis);
                out.push(loopFrom(sideA ? pr.a : pr.b, sideA ? pr.b : pr.a, apexR, along, 1));
            }
            return out;
        }
        const sep = ribbonSeparation(t, cls);
        const sigma = ribbonAlongSigma(t, cls);
        const shear = arcadeShear(t, complex);
        const span = A.spanSigma * sigma;
        for (let i = 0; i < n; i++) {
            const along = n === 1 ? 0 : -span + (2 * span * i) / (n - 1);
            // Each loop's feet are equal-and-opposite offsets from ITS OWN
            // midpoint on the PIL, in the tangent frame at that midpoint — so the
            // two feet normalise identically and the apex (their bisector) sits
            // on the PIL exactly, not to first order.
            const mid   = unit(add(frame.radial, scale(frame.pilAxis, along)));
            const pilM  = unit(add(frame.pilAxis, scale(mid, -dot(mid, frame.pilAxis))));
            const loopM = cross(mid, pilM);              // radial × pil = loop (right-handed)
            const fa = add(add(mid, scale(loopM,  sep)), scale(pilM,  shear * sep));
            const fb = add(add(mid, scale(loopM, -sep)), scale(pilM, -shear * sep));
            out.push(loopFrom(fa, fb, 1 + h, along, Math.exp(-(along * along) / (sigma * sigma))));
        }
        return out;
    }

    /**
     * A GROWING arcade: every generation of loops at once (the CSHKP picture).
     * Reconnection climbs, each new loop is rooted further from the inversion
     * line than the last and stands higher, and the loops under it are older
     * and have cooled — so the arcade is NESTED, hot and new outside, cool
     * inside, and the earliest (inner) loops are the most sheared.
     *
     * No new geometry: a loop that formed at local time τ has
     * `ribbonSeparation(τ)`, `arcadeHeight(τ)` and `arcadeShear(τ)` — the laws
     * above at the loop's own formation time, and kept. Three things are added:
     *
     *   formation   — generation k forms formT0·(formGrowth^k − 1) sim units
     *                 after its station lights: 0, 15, 38, 71, 122, 198, 312 —
     *                 quickly at first and ever more slowly. (A fixed cadence
     *                 was tried first: all seven had formed by t ≈ 150 and the
     *                 arcade stopped growing while the ribbons kept parting.)
     *   zip         — the brightening runs ALONG the inversion line: the
     *                 central zipCore lights at onset, the ends zipT later.
     *                 (With the zip starting from the exact centre no station
     *                 had formed at t = 0 and a flare began with an empty
     *                 arcade.)
     *   irregularity — stations are unevenly spaced and loops differ a little
     *                 in height and timing, SEEDED by the site (quantised to a
     *                 degree) and the loop's own (station, generation), so a
     *                 loop never changes shape between frames and a flare
     *                 always draws the same arcade.
     *
     * @returns {Array<{pts, footA, footB, apexR, along, weight, age, tForm, station, generation, alpha}>}
     *   `age` is sim units since the loop formed (what colour an age is, is the
     *   view's business); `alpha` the fade-in envelope. A loop that has not
     *   formed is not returned.
     */
    function arcadeShells({ latRad, lonRad, pilAngle, t = 0, cls = 'M', n = 11, complex = false, samples = 24,
                            generations = A.maxGenerations, seed = arcadeSeed(latRad, lonRad) } = {}) {
        const frame = tangentFrame(latRad, lonRad, pilAngle);
        const sigma = ribbonAlongSigma(t, cls);
        const span = A.spanSigma * sigma;
        const out = [];
        const G = Math.min(generations, A.maxGenerations);
        for (let i = 0; i < n; i++) {
            const u0 = n === 1 ? 0.5 : i / (n - 1);
            const jit = n === 1 ? 0 : (arcadeHash(seed, i, 0, 1) - 0.5) * A.alongJitter / (n - 1);
            const along = -span + 2 * span * Math.min(1, Math.max(0, u0 + jit));
            const off = Math.max(0, Math.abs(along) / Math.max(span, 1e-9) - A.zipCore) / (1 - A.zipCore);
            const tl = t - A.zipT * off;                          // this station's own clock
            if (!(tl >= 0)) continue;
            const mid   = unit(add(frame.radial, scale(frame.pilAxis, along)));
            const pilM  = unit(add(frame.pilAxis, scale(mid, -dot(mid, frame.pilAxis))));
            const loopM = cross(mid, pilM);
            const weight = Math.exp(-(along * along) / (sigma * sigma));
            for (let k = 0; k < G; k++) {
                const gap = arcadeFormTime(k + 1) - arcadeFormTime(k);
                const tForm = k === 0 ? 0 : arcadeFormTime(k) + (arcadeHash(seed, i, k, 2) - 0.5) * A.timeJitter * gap;
                const age = tl - tForm;
                if (!(age >= 0)) break;                           // later generations have not formed
                const tau = Math.max(tForm, 0);
                const sep = ribbonSeparation(tau, cls);
                const shear = arcadeShear(tau, complex);
                const h = arcadeHeight(tau, cls, complex) * (1 + (arcadeHash(seed, i, k, 3) - 0.5) * 2 * A.heightJitter);
                const fa = unit(add(add(mid, scale(loopM,  sep)), scale(pilM,  shear * sep)));
                const fb = unit(add(add(mid, scale(loopM, -sep)), scale(pilM, -shear * sep)));
                out.push({ pts: liftedLoop(fa, fb, h, samples), footA: fa, footB: fb, apexR: 1 + h, along, weight, age, tForm,
                           station: i, generation: k, alpha: Math.min(1, age / A.fadeIn) });
            }
        }
        return out;
    }

    /**
     * The eruptive plume: a jet along the site's radial that rises from the
     * photosphere, widens, and fades. Radii in R☉, opacity in [0, 1]. Faster
     * and farther for bigger classes; the front caps at `rMax` so a stale
     * flare cannot fill the whole scene.
     */
    function plumeState(t, cls = 'M') {
        const cf = classFactor(cls);
        const v = PL.speed * cf;                  // R☉ per sim unit
        const rMax = 1 + PL.reach * cf;
        const front = Math.min(rMax, 1 + v * Math.max(0, t));
        const length = 0.35 + 0.6 * cf * Math.min(1, Math.max(0, t) / 30);
        const tail = Math.max(1, front - length);
        const radius = 0.03 + 0.05 * cf * Math.min(1, Math.max(0, t) / 40);
        const alpha = t <= 0 ? 0 : (1 - Math.exp(-t / 3)) * Math.exp(-t / (60 * cf));
        return { front, tail, radius, alpha, rMax };
    }

    return Object.freeze({
        id: P.id, params: P,
        classFactor, ribbonSeparation, ribbonWidth, ribbonLength0, ribbonAlongSigma, ribbonDecay,
        arcadeShear, arcadeShearAngle, arcadeHeight, arcadeFormTime, arcadeLoops, arcadeShells, plumeState,
        // The parameter set under the names the consumers and gates already read.
        CLASS_FACTOR: P.classFactor,
        RIBBON: Object.freeze({ SEP0: R.sep0, SEP_RATE: R.sepRate, SEP_GAIN: R.sepGain, SEP_TAU: R.sepTau,
            WID0: R.wid0, WID_RATE: R.widRate, LEN0: R.len0, LEN_GROW_T: R.lenGrowT, DECAY_T: R.decayT }),
        ARCADE: Object.freeze({ SPAN_SIGMA: A.spanSigma, FORM_T0: A.formT0, FORM_GROWTH: A.formGrowth, ZIP_T: A.zipT,
            ZIP_CORE: A.zipCore, FADE_IN: A.fadeIn, ALONG_JITTER: A.alongJitter, HEIGHT_JITTER: A.heightJitter,
            TIME_JITTER: A.timeJitter, MAX_GENERATIONS: A.maxGenerations }),
    });
}

/** The shipped model. The named exports below are ITS laws — every importer keeps working unchanged. */
export const FLARE_MODEL = makeFlareModel();
export const {
    classFactor, ribbonSeparation, ribbonWidth, ribbonLength0, ribbonAlongSigma, ribbonDecay,
    arcadeShear, arcadeShearAngle, arcadeHeight, arcadeFormTime, arcadeLoops, arcadeShells, plumeState,
    CLASS_FACTOR, RIBBON, ARCADE,
} = FLARE_MODEL;
/** The along-PIL σ every class used until 2026-11-20 (see ribbonLength0). */
export const RIBBON_LEN_LEGACY = Math.sqrt(0.10);

// ═══════════════════════════════════════════════════════════════════════════
//  Earth view — how the activity is ANGLED to the observer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Viewing geometry of a site from Earth with the solar axis tilted by B0
 * (the same tilt sunFS applies to read the observed frame: μ = y·sin B0 +
 * z·cos B0). `profileFraction` = sin of the angle from disk centre — 0 means
 * the arcade is seen face-on (its height is invisible), 1 means side-on at
 * the limb, where loops and plumes read as height above the limb.
 */
export function earthViewGeometry(latRad, lonRad, b0Rad = 0) {
    const p = stonyhurstToUnit(latRad, lonRad);
    const mu = p[1] * Math.sin(b0Rad) + p[2] * Math.cos(b0Rad);
    const clamped = Math.max(-1, Math.min(1, mu));
    return {
        mu: clamped,
        nearSide: clamped > 0,
        limbAngleRad: Math.acos(clamped),
        profileFraction: Math.sqrt(Math.max(0, 1 - clamped * clamped)),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Heliocentric scene (solar-system.html)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Unit direction of a Stonyhurst site in a y-up heliocentric scene whose
 * azimuth runs from +x toward +z and where Earth sits at `earthAzRad`.
 * `spinSign` is the sense in which the DRAWN Sun spins in that azimuth
 * (+1: azimuth increasing) — west is by definition the direction of
 * rotation, so a W-longitude site is that far AHEAD of Earth's azimuth.
 * The 7.25° axis tilt is not modelled here (the orrery draws the axis as +y).
 */
export function heliocentricSiteDirection({ latRad = 0, lonRad = 0, earthAzRad = 0, spinSign = 1 } = {}) {
    const az = earthAzRad + Math.sign(spinSign || 1) * lonRad;
    const cl = Math.cos(latRad);
    return [cl * Math.cos(az), Math.sin(latRad), cl * Math.sin(az)];
}

/** Azimuth (from +x toward +z) of a scene vector. */
export function heliocentricAzimuth(v) {
    return Math.atan2(v[2], v[0]);
}

/**
 * Object-space azimuth that lands at world azimuth `worldAzRad` inside a
 * mesh rotated by `meshRotY` about +y. three.js makeRotationY(θ) maps
 * azimuth φ → φ − θ, so the object needs φ + θ. (The orrery used to
 * subtract — the sign the test pins against Object3D.localToWorld.)
 */
export function objectAzimuthForWorld(worldAzRad, meshRotY) {
    return worldAzRad + meshRotY;
}

/** Carrington longitude → Stonyhurst, degrees in (−180, 180], given the central-meridian L0. */
export function carringtonToStonyhurstDeg(lonCarrDeg, l0Deg) {
    let d = ((lonCarrDeg - l0Deg) % 360 + 540) % 360 - 180;
    if (d === -180) d = 180;
    return d;
}

/** Carrington longitude of the central meridian, degrees — the ONE ephemeris (Meeus ch. 29). */
export function centralMeridianL0Deg(date = new Date()) {
    return solarEphemeris(date).l0Deg;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Parker connection — which longitudes can reach Earth along the field
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stonyhurst W-longitude of Earth's Parker-spiral footpoint on the Sun:
 * Ω⊙ r / v_sw (≈ 61° at 400 km/s and 1 AU). Flares near it are
 * magnetically well connected — the classic west-hemisphere SEP bias.
 */
export function parkerFootpointLonDeg(vSwKms = 400, rAU = 1) {
    const v = Math.max(50, Number(vSwKms) || 400);
    return (OMEGA_SUN_SIDEREAL * rAU * AU_KM / v) / DEG;
}

/** Gaussian connectivity score in [0, 1], peaking at the footpoint longitude. */
export function magneticConnectivity(lonDeg, vSwKms = 400, sigmaDeg = 30) {
    const d = lonDeg - parkerFootpointLonDeg(vSwKms);
    return Math.exp(-(d * d) / (sigmaDeg * sigmaDeg));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Cone basis (eruption / CME particle cones)
// ═══════════════════════════════════════════════════════════════════════════

/** Orthonormal right-handed basis { axis, u, v } about a direction: v = axis × u. */
export function coneBasis(axisIn) {
    const axis = unit(axisIn);
    const helper = Math.abs(axis[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = unit(cross(helper, axis));
    const v = cross(axis, u);
    return { axis, u, v };
}

// ═══════════════════════════════════════════════════════════════════════════
//  2D disk (star2d.html and the canvas renderers): north up, west right
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Where a site falls on a 2D disk drawn with north up and west to the
 * right, in unit-radius disk coordinates with CANVAS y (down). `angle` is
 * the canvas angle of the site from the disk centre (0 = right, −π/2 = up),
 * which is also the direction a radial jet from that site leaves the disk.
 */
export function siteOnDisk2D(latRad, lonRad) {
    const p = stonyhurstToUnit(latRad, lonRad);
    return { x: p[0], y: -p[1], angle: Math.atan2(-p[1], p[0]), visible: p[2] > 0, mu: p[2] };
}
