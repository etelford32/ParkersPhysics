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
    /**
     * J-SHAPED RIBBON ENDS. Each ribbon runs straight along the PIL to `at`·σ and then turns AWAY from the
     * inversion line on an arc of radius `radius`·σ through `sweepDeg` — the hook that wraps the erupting
     * rope's foot. The two hooks are at OPPOSITE ends (a 180° rotation of each other). sweepDeg 0 = straight.
     */
    hook: { at: 0.75, radius: 0.18, sweepDeg: 170 },
    /**
     * CUSP-SHAPED NEW LOOPS THAT RELAX. A loop's lift profile is (1 − c)·sin(πu) + c·(1 − |2u−1|^power):
     * c = `onset` when it forms (a pointed top), decaying with e-folding `relaxT` sim units to the round
     * arc; while it relaxes it also SHRINKS — it forms (1 + `shrink`) × its relaxed height.
     */
    cusp: { onset: 0.45, power: 0.7, relaxT: 120, shrink: 0.28 },
    /**
     * THE ERUPTING FLUX ROPE. Its feet stand inside the ribbons' hooks; its apex starts `h0` above the
     * photosphere and rises on a logistic speed curve — slow at first, accelerating around `t0` over a
     * width `tau` (sim units), then coasting at `speed` × classFactor (R☉ per sim unit). The field winds
     * `twist` turns about the axis from foot to foot; the minor radius is `radius` × the apex height
     * (self-similar), tapering to `footRadius` × the hook's radius at the feet, which stand `footAlong` ×
     * the hook's own distance along the PIL (1 = at the centre of the hook's arc); `sigmoid` is how far the
     * low rope's middle is turned back toward the inversion line (0 straight chord, 1 along the PIL) — the
     * S-shape, which straightens as it rises; it has faded out by an apex radius of
     * `fadeR` R☉ from Sun centre. speed 0 = no rope.
     */
    rope: { speed: 4.64e-3, t0: 180, tau: 70, h0: 0.045, twist: 1.75, radius: 0.30, footAlong: 1, footRadius: 0.8, sigmoid: 0.7, fadeR: 2.5,
            spread: 0.40, spreadH: 0.5, filament: 0.45 },
    plume: { speed: 0.06, reach: 2.4 },
    // PLASMA ALONG THE FIELD (R☉ per sim unit; 1 = 243 495 km/s at the page's 0.35 units per second).
    //   evap      chromospheric evaporation: a new loop fills from both feet at this speed (300 km/s)
    //   rain      coronal rain: once a loop has cooled, clumps drain down its legs at this speed (80 km/s)
    //   rainOnset / rainRamp   loop age (sim units) at which rain begins, and how long it takes to set in
    //   clumps    rain clumps per leg
    //   sheetOut  outflow speed along the current sheet under the rope, both ways from the X-point (450 km/s)
    //   sheetX    where along the sheet (0 arcade top … 1 rope underside) the flows part
    flow: { evap: 1.232e-3, rain: 3.285e-4, rainOnset: 190, rainRamp: 60, clumps: 2.5, sheetOut: 1.848e-3, sheetX: 0.3, sheetClumps: 2 },
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
    hook: { at: 0.75, radius: 0.18, sweepDeg: 0 },            // straight ribbons
    cusp: { onset: 0, power: 0.7, relaxT: 120, shrink: 0 },   // round loops that keep their height
    rope: { speed: 0, t0: 180, tau: 70, h0: 0.045, twist: 0, radius: 0.30, footAlong: 1, footRadius: 0.8, sigmoid: 0, fadeR: 2.5,
            spread: 0, spreadH: 0.5, filament: 0 },   // no rope (a particle plume stood in for it)
    plume: { speed: 0.06, reach: 2.4 },
    flow: { evap: 0, rain: 0, rainOnset: 190, rainRamp: 60, clumps: 3.5, sheetOut: 0, sheetX: 0.3, sheetClumps: 4 },   // no flows: every loop lit end to end, always
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

/**
 * One loop: a great-circle arc between two feet, lifted by `profile(u)` (0 at
 * the feet, 1 at the apex) so the apex sits over their midpoint. The default
 * profile is the round one, sin(πu).
 */
function liftedLoop(fa, fb, h, samples, profile = null) {
    const cosw = Math.max(-1, Math.min(1, dot(fa, fb)));
    const w = Math.acos(cosw), sw = Math.sin(w);
    const pts = [];
    for (let j = 0; j <= samples; j++) {
        const u = j / samples;
        const p = sw < 1e-9 ? fa : add(scale(fa, Math.sin((1 - u) * w) / sw), scale(fb, Math.sin(u * w) / sw));
        pts.push(scale(unit(p), 1 + h * (profile ? profile(u) : Math.sin(Math.PI * u))));
    }
    return pts;
}

/**
 * WHICH WAY A FLARE IS HANDED — a prior, like Joy's law. χ = +1 or −1 sets two
 * things together, because one quantity (the sign of the region's magnetic
 * helicity) sets both: the sense of the arcade's shear, and which end of each
 * ribbon carries its hook. Helicity is predominantly NEGATIVE in the northern
 * hemisphere and positive in the south (Pevtsov, Canfield & Metcalf 1995), a
 * rule that holds for roughly two regions in three — so this is a prior, and
 * a consumer with an observed chirality (a filament's, a sigmoid's) should
 * pass that instead.
 *
 * The geometric sense, derived here and NOT yet checked against a figure: in
 * the (along-PIL, across-PIL) frame seen from above, χ = +1 puts the hook of
 * the +across ribbon at its +along end and shifts that ribbon's loop feet
 * toward +along (sheared loops lie nearly parallel to the erupting rope, whose
 * feet are inside the hooks). The rope then runs from the lower-left hook to
 * the upper-right one — an inverse S, i.e. negative helicity, i.e. NORTH.
 */
export function helicityChirality(latRad) { return latRad >= 0 ? 1 : -1; }

/**
 * Distance to, and position along, a J-shaped ribbon — in the flare's tangent
 * plane, `a` along the PIL and `c` across it. The ribbon is the line c = sep
 * for a ≤ s0, then an arc of radius rho that turns through `sweep` radians
 * away from the inversion line. Returns [d, s]: d the distance to the curve,
 * s the arc length of the nearest point measured from a = 0 (the brightness
 * envelope is a function of s, so the hook dims as the ribbon's end does).
 * sweep ≤ 0 is the straight ribbon EXACTLY: [|c − sep|, a].
 *
 * This is the +across ribbon with its hook at the +along end. The other
 * ribbon is the same curve turned 180°: ribbonJ(−a, −c, …). The opposite
 * handedness is ribbonJ(−a, c, …) and ribbonJ(a, −c, …).
 *
 * RIBBON_J_GLSL below is the SAME function for the shader; the node gate
 * transliterates the GLSL back to JS and runs it against this one, and
 * checks both against brute force on the polyline. Change them together.
 */
export function ribbonJ(a, c, sep, s0, rho, sweep) {
    if (sweep <= 0 || rho <= 0) return [Math.abs(c - sep), a];
    const dLine = a <= s0 ? Math.abs(c - sep) : Math.hypot(a - s0, c - sep);
    const da = a - s0, dc = c - sep - rho;
    let phi = (Math.abs(da) + Math.abs(dc) < 1e-9) ? 0 : Math.atan2(da, -dc);
    if (phi < 0) phi += TWO_PI;
    const dEnd = Math.hypot(da - rho * Math.sin(sweep), dc + rho * Math.cos(sweep));
    const dStart = Math.hypot(da, dc + rho);
    const onArc = phi <= sweep;
    const dArc = onArc ? Math.abs(Math.hypot(da, dc) - rho) : Math.min(dEnd, dStart);
    const sArc = s0 + rho * (onArc ? phi : (dEnd < dStart ? sweep : 0));
    return dArc < dLine ? [dArc, sArc] : [dLine, Math.min(a, s0)];
}

/** GLSL twin of ribbonJ (returns vec2(d, s)). Scalar-only on purpose: the gate transliterates it. No backticks. */
/** Length of a polyline of 3-vectors. */
export function polylineLength(pts) {
    let L = 0;
    for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    return L;
}

/**
 * HOW A STRAND'S BRIGHTNESS MOVES ALONG IT — one function in two languages (this, and STRAND_FLOW_GLSL
 * below, which the strand shader interpolates; tests/flare-geometry.mjs transliterates the GLSL back and
 * runs it against this). `arc` is 0…1 along the strand. It returns a GAIN on the strand's own brightness.
 *
 * The clump pattern is deliberately SOFT (a floor of ~half the strand's brightness between clumps, peaks ~2×):
 * the first version (floor 0.2, peaks 4×, 3.5–4 clumps) drew every loop and sheet line as a string of beads.
 *
 *   mode 0   nothing moves: 1.
 *   mode 1   a LOOP (arc 0 and 1 are its feet). p1 = fill: each leg is lit from its foot up to p1 of the
 *            way to the top, with a brighter front at the edge (the evaporation front); ≥ 1.15 is a full
 *            loop and the gain is exactly 1. p2 = rain (0…1): clumps, `k` to a leg, moving toward the feet
 *            as p3 (their travel, in clumps) grows.
 *   mode 2   a SHEET (arc 0 its lower end). p1 = where the flows part; p2 = how much of the pattern shows;
 *            p3 = travel: blobs move AWAY from p1 on both sides as it grows.
 */
export function strandFlowClump(x) {
    const a = 0.5 + 0.5 * Math.sin(6.2831853 * x);
    const b = 0.5 + 0.5 * Math.sin(6.2831853 * 2.37 * x + 1.3);
    const c = a * b;
    return 1.6 * c * (0.4 + 0.6 * c);
}
export function strandFlowGain(arc, mode, p1, p2, p3, k) {
    const mix = (x, y, a) => x * (1 - a) + y * a;
    const smoothstep = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
    let g = 1.0;
    const s = 2.0 * Math.min(arc, 1.0 - arc);
    if (mode > 0.5 && mode < 1.5) {
        const leg = arc < 0.5 ? 0.0 : 0.37;
        const lit = 1.0 - smoothstep(p1 - 0.02, p1 + 0.06, s);
        const d = (s - p1) / 0.07;
        const front = p1 < 1.15 ? Math.exp(-d * d) : 0.0;
        g = (lit + 1.6 * front) * mix(1.0, 0.5 + 1.0 * strandFlowClump(s * k + p3 + leg), p2);
    }
    if (mode > 1.5) {
        const d2 = arc - p1;
        const side = d2 < 0.0 ? 0.41 : 0.0;
        g = mix(1.0, 0.45 + 1.1 * strandFlowClump(Math.abs(d2) * k - p3 + side), p2);
    }
    return g;
}
export const STRAND_FLOW_GLSL = /* glsl */`
    float strandFlowClump(float x) {
        float a = 0.5 + 0.5 * sin(6.2831853 * x);
        float b = 0.5 + 0.5 * sin(6.2831853 * 2.37 * x + 1.3);
        float c = a * b;
        return 1.6 * c * (0.4 + 0.6 * c);
    }
    float strandFlowGain(float arc, float mode, float p1, float p2, float p3, float k) {
        float g = 1.0;
        float s = 2.0 * min(arc, 1.0 - arc);
        if (mode > 0.5 && mode < 1.5) {
            float leg = arc < 0.5 ? 0.0 : 0.37;
            float lit = 1.0 - smoothstep(p1 - 0.02, p1 + 0.06, s);
            float d = (s - p1) / 0.07;
            float front = p1 < 1.15 ? exp(-d * d) : 0.0;
            g = (lit + 1.6 * front) * mix(1.0, 0.5 + 1.0 * strandFlowClump(s * k + p3 + leg), p2);
        }
        if (mode > 1.5) {
            float d2 = arc - p1;
            float side = d2 < 0.0 ? 0.41 : 0.0;
            g = mix(1.0, 0.45 + 1.1 * strandFlowClump(abs(d2) * k - p3 + side), p2);
        }
        return g;
    }
`;

export const RIBBON_J_GLSL = /* glsl */`
    vec2 ribbonJ(float a, float c, float sep, float s0, float rho, float sweep) {
        if (sweep <= 0.0 || rho <= 0.0) return vec2(abs(c - sep), a);
        float dLine = a <= s0 ? abs(c - sep) : length(vec2(a - s0, c - sep));
        float da = a - s0;
        float dc = c - sep - rho;
        float phi = (abs(da) + abs(dc) < 1e-9) ? 0.0 : atan(da, -dc);
        if (phi < 0.0) phi += 6.283185307179586;
        float dEnd = length(vec2(da - rho * sin(sweep), dc + rho * cos(sweep)));
        float dStart = length(vec2(da, dc + rho));
        bool onArc = phi <= sweep;
        float dArc = onArc ? abs(length(vec2(da, dc)) - rho) : min(dEnd, dStart);
        float sArc = s0 + rho * (onArc ? phi : (dEnd < dStart ? sweep : 0.0));
        return dArc < dLine ? vec2(dArc, sArc) : vec2(dLine, min(a, s0));
    }
`;

/**
 * Build a flare-shape model from a parameter set. `overrides` is deep-merged
 * onto `base` (unknown keys throw). The returned object carries every law the
 * consumers call, bound to those parameters, plus `params` itself.
 */
export function makeFlareModel(overrides = null, base = FLARE_SHAPE_DEFAULT) {
    const P = deepFreeze(mergeFlareShape(base, overrides));
    const { ribbon: R, shear: S, height: H, arcade: A, plume: PL, hook: HK, cusp: CU, rope: RP, flow: FL } = P;
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

    /** How un-relaxed a loop of this age still is: 1 as it forms, → 0. */
    const loopRelax = (age) => Math.exp(-Math.max(age, 0) / CU.relaxT);
    /** Lift profile of a loop of this age (0 at the feet, 1 at the apex): cusped when new, round when relaxed. */
    const loopProfile = (u, age = Infinity) => {
        const c = CU.onset * loopRelax(age);
        return (1 - c) * Math.sin(Math.PI * u) + c * (1 - Math.pow(Math.abs(2 * u - 1), CU.power));
    };
    /** A loop forms taller than it ends up: its height ÷ its relaxed height at this age. */
    const loopHeightFactor = (age = Infinity) => 1 + CU.shrink * loopRelax(age);
    /** The ribbons' hook at time t: where the straight part ends (s0), the arc's radius and sweep. Radians. */
    const ribbonHook = (t, cls = 'M') => {
        const sg = ribbonAlongSigma(t, cls);
        return { s0: HK.at * sg, rho: HK.radius * sg, sweep: HK.sweepDeg * DEG };
    };
    /**
     * Both ribbons' centrelines as points on the unit sphere (sun frame, epoch
     * coordinates), each with its tangent-plane coordinates: `a` along the PIL,
     * `c` across it, `s` the arc length from the ribbon's middle. `plus` is the
     * +across ribbon. Straight from −`reach`·σ, then the hook.
     */
    function ribbonCurves({ latRad, lonRad, pilAngle, t = 0, cls = 'M', chirality = 1, samples = 96, reach = 1.6 } = {}) {
        const frame = tangentFrame(latRad, lonRad, pilAngle);
        const sep = ribbonSeparation(t, cls), sg = ribbonAlongSigma(t, cls), hk = ribbonHook(t, cls);
        const chi = chirality < 0 ? -1 : 1;
        const base = [];                                        // the +across ribbon with its hook at +along
        const hooked = hk.sweep > 0 && hk.rho > 0;
        const end = hooked ? hk.s0 : reach * sg;
        for (let i = 0; i <= samples; i++) { const a = -reach * sg + (end + reach * sg) * i / samples; base.push({ a, c: sep, s: a }); }
        if (hooked) for (let i = 1; i <= samples; i++) {
            const phi = hk.sweep * i / samples;
            base.push({ a: hk.s0 + hk.rho * Math.sin(phi), c: sep + hk.rho * (1 - Math.cos(phi)), s: hk.s0 + hk.rho * phi });
        }
        const lift = ({ a, c, s }) => {
            const z = Math.sqrt(Math.max(0, 1 - a * a - c * c));    // so that dot(p, pilAxis) = a exactly, as the shader reads it
            return { p: add(add(scale(frame.pilAxis, a), scale(frame.loopAxis, c)), scale(frame.radial, z)), a, c, s };
        };
        return {
            plus:  base.map(({ a, c, s }) => lift({ a:  chi * a, c,     s })),
            minus: base.map(({ a, c, s }) => lift({ a: -chi * a, c: -c, s })),
            hook: hk, sep, sigma: sg, chirality: chi,
        };
    }

    /**
     * Post-flare arcade loops as polylines in the SUN FRAME (epoch coordinates —
     * the caller rotates by `siteRotation`): ONE generation, the arcade at the
     * current ribbon separation. Without `pairs`, `n` loops are laid along the
     * PIL over ±spanSigma·σ of the ribbon envelope; with `pairs` (the atlas's
     * conjugate footpoints, `{ a, b, apexR? }`) each pair is one loop.
     * Each loop: { pts, footA, footB, apexR, along, weight }, footA on the
     * +loopAxis side, `weight` the ribbon envelope at `along`.
     */
    function arcadeLoops({ latRad, lonRad, pilAngle, t = 0, cls = 'M', n = 9, complex = false, pairs = null, samples = 24, chirality = 1 } = {}) {
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
        const shear = (chirality < 0 ? -1 : 1) * arcadeShear(t, complex);
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
                            generations = A.maxGenerations, seed = arcadeSeed(latRad, lonRad), chirality = 1 } = {}) {
        const frame = tangentFrame(latRad, lonRad, pilAngle);
        const chi = chirality < 0 ? -1 : 1;
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
                const shear = chi * arcadeShear(tau, complex);
                // The loop's RELAXED height is the law at its formation time (and its own scatter); while it is
                // young it stands taller by the cusp that has not yet retracted, and its top is pointed.
                const hRelaxed = arcadeHeight(tau, cls, complex) * (1 + (arcadeHash(seed, i, k, 3) - 0.5) * 2 * A.heightJitter);
                const h = hRelaxed * loopHeightFactor(age);
                const fa = unit(add(add(mid, scale(loopM,  sep)), scale(pilM,  shear * sep)));
                const fb = unit(add(add(mid, scale(loopM, -sep)), scale(pilM, -shear * sep)));
                out.push({ pts: liftedLoop(fa, fb, h, samples, (u) => loopProfile(u, age)), footA: fa, footB: fb, apexR: 1 + h,
                           relaxedApexR: 1 + hRelaxed, cusp: CU.onset * loopRelax(age), along, weight, age, tForm,
                           station: i, generation: k, alpha: Math.min(1, age / A.fadeIn) });
            }
        }
        return out;
    }

    // ── The erupting flux rope ───────────────────────────────────────────────
    const softplus = (x) => (x > 30 ? x : Math.log1p(Math.exp(x)));
    /** Apex speed, R☉ per sim unit: a logistic — slow rise, acceleration centred on t0, coast. */
    const ropeSpeed = (t, cls = 'M') => RP.speed * classFactor(cls) / (1 + Math.exp(-(Math.max(t, 0) - RP.t0) / RP.tau));
    /** Apex height above the photosphere, R☉: the integral of ropeSpeed from onset, on top of h0. */
    const ropeApexHeight = (t, cls = 'M') =>
        RP.h0 + RP.speed * classFactor(cls) * RP.tau * (softplus((Math.max(t, 0) - RP.t0) / RP.tau) - softplus(-RP.t0 / RP.tau));
    /**
     * The rope at time t: { active, h0, apexH, apexR, speed, accel, minorR, alpha }. `alpha` is its
     * presence (fades in over the first sim units, out as the apex nears fadeR) — NOT its brightness
     * dilution, which is the view's disclosed choice.
     */
    function ropeState(t, cls = 'M') {
        const active = RP.speed > 0 && t >= 0;
        const apexH = ropeApexHeight(t, cls), apexR = 1 + apexH;
        const v = ropeSpeed(t, cls);
        const fadeFrom = 1 + 0.5 * (RP.fadeR - 1);
        const f = Math.min(1, Math.max(0, (apexR - fadeFrom) / Math.max(RP.fadeR - fadeFrom, 1e-9)));
        const alpha = active ? Math.min(1, Math.max(t, 0) / 6) * (1 - f * f * (3 - 2 * f)) : 0;
        return { active, h0: RP.h0, apexH, apexR, speed: v, accel: v * (1 - v / (RP.speed * classFactor(cls) || 1)) / RP.tau,
                 minorR: RP.radius * apexH, alpha };
    }
    /**
     * The rope's AXIS: points in the sun frame (epoch coordinates) from the foot inside the −across
     * ribbon's hook to the foot inside the +across one, with an orthonormal frame (T along the axis,
     * N, B across it; N × B = T) and the minor radius at each point. Low in the atmosphere the axis is
     * a sigmoid — its middle runs along the inversion line and its ends turn in to the feet; the bend
     * fades as the rope rises. Returns { pts, frames: [{T, N, B}], radius: [], feet: [minus, plus],
     * footAC: [[a, c], [a, c]], state }.
     */
    function ropeAxis({ latRad, lonRad, pilAngle, t = 0, cls = 'M', chirality = 1, samples = 96 } = {}) {
        const frame = tangentFrame(latRad, lonRad, pilAngle);
        const st = ropeState(t, cls), hk = ribbonHook(t, cls), sep = ribbonSeparation(t, cls);
        const chi = chirality < 0 ? -1 : 1;
        // Each foot stands where its ribbon's hook is: footAlong = 1 is the centre of the hook's arc (see
        // ribbonJ) — what the hook wraps. It is a PARAMETER so that "the feet are inside the hooks" is a
        // property a model can fail, and the scorecard row for it is not true by construction.
        const fp = [chi * RP.footAlong * hk.s0, sep + hk.rho], fm = [-chi * RP.footAlong * hk.s0, -(sep + hk.rho)];
        const d = [fp[0] - fm[0], fp[1] - fm[1]], len = Math.hypot(d[0], d[1]) || 1e-9;
        const nrm = [chi * -d[1] / len, chi * d[0] / len];             // turns the rope's middle TOWARD the inversion line
        // SIGMOID: `sigmoid` is the fraction of the chord's angle to the inversion line by which the rope's
        // MIDDLE is turned back toward it (1 = the middle runs along the PIL). The amplitude follows from
        // that — sin(2πu) turns the middle by atan(2π·bend/len) — and it straightens as the rope rises.
        // (The first version took the amplitude as a fraction of the chord: 0.12 turned the middle 37°, PAST
        // the inversion line and out the other side of a chord that is only 19° from it — measured.)
        const chordAng = Math.atan2(Math.abs(d[1]), Math.abs(d[0]));
        const bend = len * Math.tan(Math.min(1, RP.sigmoid * (st.h0 / st.apexH)) * chordAng) / (2 * Math.PI);
        // SPREAD: the rope OVER-EXPANDS SIDEWAYS as it rises. Its feet stay where they are; its legs lean
        // out along the foot-to-foot line, so the axis becomes the broad loop a coronagraph sees and not a
        // hairpin the width of its own feet. `spread` is the angle (rad, at Sun centre) each leg leans out
        // by once the rope is high; it comes in with height on the scale `spreadH` (R☉), so the low rope is
        // still the sigmoid over the inversion line. (Without it the tube — which DOES grow with height —
        // became fatter than the gap between its own legs by ~0.5 R☉: measured, and scored as `rope_legs`.)
        const lean = RP.spread * (st.apexH - st.h0) / Math.max(st.apexH - st.h0 + RP.spreadH, 1e-9);
        const pts = [];
        for (let i = 0; i <= samples; i++) {
            const u = i / samples, s2 = Math.sin(2 * Math.PI * u), sgm = bend * s2;
            const xi = u - (lean / len) * s2;                          // along the chord: < 0 and > 1 are beyond the feet
            const a = fm[0] + d[0] * xi + nrm[0] * sgm, c = fm[1] + d[1] * xi + nrm[1] * sgm;
            const z = Math.sqrt(Math.max(0, 1 - a * a - c * c));
            const p0 = add(add(scale(frame.pilAxis, a), scale(frame.loopAxis, c)), scale(frame.radial, z));
            pts.push(scale(p0, 1 + st.apexH * Math.sin(Math.PI * u)));
        }
        const aFoot = RP.footRadius * (hk.rho > 0 ? hk.rho : 0.25 * sep);
        // THE FRAME IS PARALLEL-TRANSPORTED FROM THE APEX. At the apex N is the local vertical (so "−N" is
        // DOWN there — the rope's underside, where the filament rides); from there it is carried along the
        // axis with as little rotation about it as the curve allows. The first version rebuilt N at every
        // point as "the vertical, made perpendicular to T": that is undefined where the axis is itself
        // vertical, and a leg that leans OUT passes through vertical on its way to the top — N flipped
        // through zero there and every strand was pinched onto one line at each shoulder (seen in the first
        // widened rope; a rope whose legs lean in never crosses vertical, which is why the hairpin hid it).
        const tangents = [], radius = [];
        for (let i = 0; i <= samples; i++) {
            const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, samples)];
            tangents.push(unit(add(b, scale(a, -1))));
            radius.push(aFoot + (Math.max(st.minorR, aFoot) - aFoot) * Math.sin(Math.PI * i / samples));
        }
        const frames = new Array(samples + 1), mid = Math.round(samples / 2);
        const perp = (v, T) => add(v, scale(T, -dot(v, T)));
        {
            let N = perp(unit(pts[mid]), tangents[mid]);
            if (norm(N) < 1e-6) N = perp(frame.loopAxis, tangents[mid]);
            N = unit(N);
            frames[mid] = { T: tangents[mid], N, B: cross(tangents[mid], N) };
        }
        for (const dir of [1, -1]) {
            for (let i = mid + dir; i >= 0 && i <= samples; i += dir) {
                const T = tangents[i];
                let N = perp(frames[i - dir].N, T);
                if (norm(N) < 1e-9) N = perp(frames[i - dir].T, T);     // a right-angle corner between samples: cannot happen on this curve
                N = unit(N);
                frames[i] = { T, N, B: cross(T, N) };
            }
        }
        const lift = ([a, c]) => add(add(scale(frame.pilAxis, a), scale(frame.loopAxis, c)), scale(frame.radial, Math.sqrt(Math.max(0, 1 - a * a - c * c))));
        return { pts, frames, radius, feet: [lift(fm), lift(fp)], footAC: [fm, fp], footRadius: aFoot, state: st, chirality: chi };
    }
    /**
     * The rope's field lines: `n` helices about the axis, in two shells, winding `twist` turns from foot
     * to foot. HANDEDNESS: θ = φ − χ·2π·twist·u in the (N, B) plane with N × B = T, so χ = +1 is a
     * LEFT-handed rope — negative helicity, the northern-hemisphere sense helicityChirality assigns —
     * and χ = −1 a right-handed one. (That a right-handed twist is positive helicity is a definition;
     * which hemisphere and which hook end go with it is the prior documented at helicityChirality.)
     * Every third strand is flagged `cool`: the filament material the rope carries. Nothing dips below
     * the photosphere. Returns [{ pts, cool, shell, weight }].
     */
    function ropeStrands({ latRad, lonRad, pilAngle, t = 0, cls = 'M', chirality = 1, n = 18, samples = 96,
                           seed = arcadeSeed(latRad, lonRad) } = {}) {
        const ax = ropeAxis({ latRad, lonRad, pilAngle, t, cls, chirality, samples });
        const out = [];
        const fil = Math.max(0, Math.min(0.8, RP.filament));
        for (let j = 0; j < n; j++) {
            const h1 = arcadeHash(seed, j, 0, 7), h2 = arcadeHash(seed, j, 1, 7), h3 = arcadeHash(seed, j, 2, 7);
            const cool = j % 3 === 2;
            // FIELD LINES of the rope lie on nested shells — not on two (the first version drew every line on
            // shell 1 or 0.55 at even phases, and it read as a spirograph). Shell radii are spread by the golden
            // ratio (no two alike, no clumps), phases and brightness are irregular, the outer shells brightest.
            // THE FILAMENT is different matter: cool plasma collects in the DIPS of the helical field, which are
            // on the rope's underside, so it is a thin bundle offset toward −N by `filament` of the tube radius
            // (at the apex −N is straight down). With `filament` 0 it is just more field lines, as before.
            const shell = cool && fil > 0 ? 0.10 + 0.16 * h2 : 0.38 + 0.62 * ((0.31 + j * 0.6180339887) % 1);
            const off = cool ? fil : 0;
            const phi0 = 2 * Math.PI * (j + 0.7 * (h1 - 0.5)) / n;
            const weight = cool ? 0.75 + 0.25 * h3 : (0.35 + 0.65 * h3) * (0.55 + 0.45 * shell);
            const pts = [];
            for (let i = 0; i <= samples; i++) {
                const u = i / samples, th = phi0 - ax.chirality * 2 * Math.PI * RP.twist * u;
                const { N, B } = ax.frames[i], R0 = ax.radius[i], r = R0 * shell;
                let p = add(ax.pts[i], add(scale(N, r * Math.cos(th) - off * R0), scale(B, r * Math.sin(th))));
                const pl = norm(p);
                if (pl < 1.0005) p = scale(p, 1.0005 / pl);
                pts.push(p);
            }
            out.push({ pts, cool, shell, offset: off, weight });
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

    // ── Plasma moving along the field ─────────────────────────────────────
    const smooth01 = (x) => { const c = Math.min(1, Math.max(0, x)); return c * c * (3 - 2 * c); };
    /**
     * What is moving along ONE flare loop of a given age. A loop is not lit end to end the moment it
     * forms: heated chromosphere EVAPORATES up both legs and fills it (`fill` = the fraction of each leg
     * the front has reached, ≥ 1.15 = full), and once it has cooled, condensations RAIN back down the legs
     * (`rain` = how far that has set in, `rainPhase` = how far the clump pattern has travelled, in clumps).
     * With `flow.evap` 0 every loop is full from the start and with `flow.rain` 0 nothing drains — the
     * loops as drawn before 2026-11-22.
     */
    function loopFlow({ age = 0, halfLength = 0.05 } = {}) {
        const hl = Math.max(halfLength, 1e-9), a = Math.max(age, 0), since = a - FL.rainOnset;
        return {
            fill: FL.evap > 0 ? Math.min(2, FL.evap * a / hl) : 2,
            rain: FL.rain > 0 ? smooth01(since / Math.max(FL.rainRamp, 1e-9)) : 0,
            rainPhase: FL.rain > 0 && since > 0 ? FL.clumps * FL.rain * since / hl : 0,
            clumps: FL.clumps,
        };
    }
    /** ∫ rate(t′)/length(t′) dt′ from 0 to t — how far a pattern has travelled along something whose length changes. */
    const travel = (rate, lengthAt, t, steps = 32) => {
        if (!(t > 0) || !(rate > 0)) return 0;
        let sum = 0;
        for (let k = 0; k <= steps; k++) sum += (k === 0 || k === steps ? 0.5 : 1) / Math.max(lengthAt(t * k / steps), 1e-9);
        return rate * sum * t / steps;
    };
    /**
     * THE CURRENT SHEET under an erupting rope: the thin hot layer between the top of the flare arcade
     * (where the newest, still-pointed loops end) and the rope's underside, in which the field reconnects.
     * Plasma leaves the reconnection point both ways along it — down onto the arcade, up into the rope.
     * Heights are above the photosphere, R☉; `x` is where the flows part (0 arcade top … 1 rope);
     * `phase` is how far the blob pattern has travelled outward, in blobs.
     */
    function sheetState(t, cls = 'M', complex = false) {
        const st = ropeState(t, cls);
        const lowAt = (tt) => arcadeHeight(Math.max(tt, 0), cls, complex) * (1 + CU.shrink);
        const lenAt = (tt) => { const s2 = ropeState(tt, cls); return s2.apexH - s2.minorR - lowAt(tt); };
        const lowH = lowAt(t), highH = st.apexH - st.minorR, length = highH - lowH;
        const active = st.active && FL.sheetOut > 0 && length > 0;
        return {
            active, lowH, highH, length: Math.max(length, 0), x: FL.sheetX, clumps: FL.sheetClumps,
            alpha: active ? st.alpha * smooth01((length - 0.01) / 0.05) : 0,
            phase: active ? FL.sheetClumps * travel(FL.sheetOut, lenAt, t) : 0,
        };
    }
    /** The sheet as lines: from the arcade's top, at stations along the inversion line, up to the rope's underside. */
    function sheetStrands({ latRad, lonRad, pilAngle, t = 0, cls = 'M', chirality = 1, complex = false, n = 7, samples = 24 } = {}) {
        const ss = sheetState(t, cls, complex);
        if (!ss.active) return [];
        const frame = tangentFrame(latRad, lonRad, pilAngle), N = 96;
        const ax = ropeAxis({ latRad, lonRad, pilAngle, t, cls, chirality, samples: N });
        const half = 0.7 * ribbonLength0(cls), out = [];
        for (let i = 0; i < n; i++) {
            const f = n > 1 ? i / (n - 1) : 0.5, a = (f - 0.5) * 2 * half;
            const foot = add(scale(frame.pilAxis, a), scale(frame.radial, Math.sqrt(Math.max(0, 1 - a * a))));
            const lo = scale(foot, 1 + ss.lowH);
            // The rope runs from −χ·s0 to +χ·s0 along the inversion line, so a station on the +PIL side meets the +χ half of it.
            const k = Math.round(N * (0.5 + ax.chirality * (f - 0.5) * 0.36));
            const hi = add(ax.pts[k], scale(ax.frames[k].N, -ax.radius[k]));
            if (!(norm(hi) > norm(lo) + 1e-4)) continue;
            const pts = [];
            for (let j = 0; j <= samples; j++) { const u = j / samples; pts.push(add(scale(lo, 1 - u), scale(hi, u))); }
            out.push({ pts, station: i, weight: 0.55 + 0.45 * arcadeHash(arcadeSeed(latRad, lonRad), i, 3, 11) });
        }
        return out;
    }
    /**
     * The filament DRAINING as the rope erupts: its cool material runs back down the rope's legs.
     * `rain` sets in as the rope leaves its starting height; `rainPhase` is the clump pattern's travel on a
     * strand whose half-length is the rope axis's own at each instant (it grows — hence an integral).
     */
    function ropeDrain({ latRad, lonRad, pilAngle, t = 0, cls = 'M', chirality = 1 } = {}) {
        const st = ropeState(t, cls);
        if (!(FL.rain > 0) || !st.active) return { rain: 0, rainPhase: 0, clumps: FL.clumps };
        const halfAt = (tt) => 0.5 * polylineLength(ropeAxis({ latRad, lonRad, pilAngle, t: tt, cls, chirality, samples: 24 }).pts);
        return { rain: smooth01((st.apexH / st.h0 - 1.5) / 2), rainPhase: FL.clumps * travel(FL.rain, halfAt, t, 12), clumps: FL.clumps };
    }

    return Object.freeze({
        id: P.id, params: P,
        classFactor, ribbonSeparation, ribbonWidth, ribbonLength0, ribbonAlongSigma, ribbonDecay,
        arcadeShear, arcadeShearAngle, arcadeHeight, arcadeFormTime, arcadeLoops, arcadeShells, plumeState,
        loopRelax, loopProfile, loopHeightFactor, ribbonHook, ribbonCurves,
        ropeSpeed, ropeApexHeight, ropeState, ropeAxis, ropeStrands,
        loopFlow, sheetState, sheetStrands, ropeDrain,
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
    loopRelax, loopProfile, loopHeightFactor, ribbonHook, ribbonCurves,
    ropeSpeed, ropeApexHeight, ropeState, ropeAxis, ropeStrands,
    loopFlow, sheetState, sheetStrands, ropeDrain,
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
