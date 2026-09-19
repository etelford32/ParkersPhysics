/**
 * neo-layer.js — near-Earth objects for solar-system.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Draws the whole catalogued near-Earth population (asteroids, near-Earth
 * comets, the interstellar visitors) at its propagated position for the
 * orrery's current Julian Day, plus:
 *
 *   · an Earth-anchored "near-Earth space" frame — rings at 1/5/10/20 lunar
 *     distances on the Moon's own compression, with every object currently
 *     inside 20 LD drawn there with a ±3-day geocentric trail and a label
 *   · the selected object's full orbit and a camera-lock anchor the page's
 *     selectBody()/setCamLock() can follow like a planet
 *   · inbound arrows for the meteor showers active at the sim date (the
 *     direction meteoroids arrive FROM, at the stream's geocentric speed)
 *
 * All orbital arithmetic for the population runs in js/neo-worker.js; this
 * module owns three.js objects, the data feeds, selection and picking. The
 * pure kernel (js/neo-orbits.js) is the single copy of every rule below.
 *
 * ── The two drawing conventions (read the kernel header first) ────────────
 * Population points ride the orrery's log radial scale in the ecliptic OF
 * DATE. Inside LOCAL_FRAME.maxLD of Earth an object is drawn on the local
 * frame instead, and across LOCAL_FRAME.fadeLD the two instances cross-fade
 * (alpha only — positions never jump). The page discloses both in the panel.
 *
 * ── Data ladder ───────────────────────────────────────────────────────────
 * /api/neo/catalog?tier=pha → bright → all, in sequence, each REPLACING the
 * previous (tiers nest). `all` is skipped on save-data connections. A feed
 * that fails leaves the previous tier on screen and says so in `status`; a
 * catalogue that never arrives draws NOTHING (never a stale invention).
 * /api/neo/watch supplies the close-approach table (JPL's integrated orbits,
 * not our two-body propagation), the Sentry risk list and recent fireballs.
 *
 * Browser gate: tests/solar-system-neo-smoke.spec.js (routes mocked).
 */

import * as THREE from 'three';
import { TONE_DECODE_GLSL } from './tone-decode.js';
import {
    FLAG, LD_AU, AU_KM, LOCAL_FRAME, CLASS_LABELS,
    rowToRecord, normalizeElements, propagate, toOfDate, sampleOrbit,
    helioToScene, geoToLocalScene, localSceneRadius, localFrameWeight, precessionLongitudeRad, rotateAboutPole,
    diameterKm, formatSize, formatLD, toLD, speedKms, elementsAgeNote, findNotable, neoClass,
    opticalProperties, apparentMagnitudeV, phaseAngleRad, TAXONOMY,
    solarLongitudeDeg, activeShowers, nextShower, radiantEclipticUnit,
} from './neo-orbits.js';

import { rockGeometry, rockMaterial, drawnRockRadius, shapeFor, spinFor, hash32, MeteoroidStream } from './neo-rocks.js';
import { AIRLESS_GLSL, AIRLESS_DISPLAY, OPPOSITION } from './airless-body.js';
import { shadowIllumination, reflectedIrradianceFraction, BODY_ALBEDO, EARTH_RADIUS_KM } from './eclipse-geometry.js';

const WORKER_URL = new URL('./neo-worker.js', import.meta.url);

// ── Mesh LOD ────────────────────────────────────────────────────────────────
// A sprite is honest for a 30 m rock two AU away; it is not for the object
// you locked the camera on. A pool of ROCK_SLOTS rock meshes is assigned, at
// ~10 Hz, to the selected object, the flybys inside the Earth-local frame and
// the objects nearest the camera within ROCK_RANGE scene units; their sprites
// are suppressed while a mesh stands in. Geometries are seeded per object and
// cached (GEO_CACHE_MAX), so a body always has the same shape.
const ROCK_SLOTS = 24;
const ROCK_RANGE = 2.5;
const GEO_CACHE_MAX = 48;
const _Y = new THREE.Vector3(0, 1, 0);
const _qSpin = new THREE.Quaternion();

// Pick scratch. GRAB_PX is the grace a 2 px body gets: the accept radius is the
// DRAWN radius, which for most of the population is smaller than a fingertip.
const _mPick = new THREE.Matrix4();
const _mPick2 = new THREE.Matrix4();
const GRAB_PX = 7;
const _cHover = new THREE.Color();

// ── Local-frame labels ──────────────────────────────────────────────────────
// At most LOCAL_LABEL_MAX in-zone objects are labelled, and a label that would
// land on top of one already placed is dropped rather than drawn: stacked text
// over the Sun's glare is worse than no text, and since 2026-09-18 anything the
// page does not label is one HOVER away from being named. Separation is in NDC
// because the labels are `sizeAttenuation:false` sprites — their size is a
// fraction of the VIEW, not of the world (hFrac 0.032 of the height ⇒ 0.064 of
// the NDC y range, so 0.055 is a little under one label of clearance).
const LOCAL_LABEL_MAX = 8;
const LABEL_SEP_NDC = { x: 0.26, y: 0.055 };
const _vLbl = new THREE.Vector3();

export const NEO_COLORS = Object.freeze({
    pha:          0xff5a3c,
    APO:          0xffb347,
    ATE:          0x5be0c8,
    AMO:          0xc39bff,
    IEO:          0xff8ad8,
    comet:        0x7fd7ff,
    interstellar: 0xffffff,
    other:        0xa09a8c,
    flyby:        0xfff2a8,
    ring:         0x6fa8dc,
    radiant:      0xffd27a,
});

export const NEO_TIER_LADDER = ['pha', 'bright', 'all'];

/**
 * Two palettes. NATURAL (default) is what a camera would record: asteroids
 * run from S-type reddish-grey to C-type dark neutral (a per-object hash keeps
 * the mix stable frame to frame), comets are blue-white, interstellar objects
 * white; a PHA carries a warm bias so hazard stays legible. CLASS is the
 * data-viz palette the legend names. Brightness and size come from ABSOLUTE
 * MAGNITUDE either way — Eros (H 10) outshines a 30 m rock (H 28) by eight
 * magnitudes, and the sprite says so inside the 1.7–5.6 px band a point can
 * honestly occupy. The sprite itself is a Gaussian core + soft PSF halo,
 * blended ADDITIVELY so dense regions glow instead of stacking opaque discs.
 */
/**
 * The NATURAL palette's fixed entries. The ASTEROID tints no longer live here —
 * they come from the kernel's TAXONOMY table, so a body's colour, its albedo and
 * its derived diameter are three readings of ONE published classification and
 * cannot disagree. These are the objects that have no taxonomy to read.
 */
export const NATURAL_COLORS = Object.freeze({
    sType: TAXONOMY.S.tint, cType: TAXONOMY.C.tint, pha: 0xf0a97c,
    comet: 0xc4e8ff, interstellar: 0xffffff, flyby: 0xfff0c2,
});
/**
 * Per-object optical properties, CACHED. `opticalProperties` walks a small
 * table and allocates, and this is called for every object in the catalogue on
 * every style pass — 38 000 of them. Keyed by the element record itself, so a
 * catalogue swap drops the whole map with the objects.
 */
const _optics = new WeakMap();
export function opticsFor(el) {
    let o = _optics.get(el);
    if (!o) {
        o = opticalProperties(el);
        const d = diameterKm(el, o);
        o = { ...o, diamKm: d.km, diamMeasured: d.measured };
        _optics.set(el, o);
    }
    return o;
}

function classColorHex(el) {
    if (el.flags & FLAG.INTERSTELLAR) return NEO_COLORS.interstellar;
    if (el.flags & FLAG.COMET) return NEO_COLORS.comet;
    if (el.flags & FLAG.PHA) return NEO_COLORS.pha;
    return NEO_COLORS[el.cls] ?? NEO_COLORS.other;
}
const _cB = new THREE.Color();
/** Writes the object's colour under `mode` ('natural' | 'class') into `out`; returns `out`. */
export function colorFor(el, mode, out) {
    if (mode === 'class') return out.setHex(classColorHex(el));
    if (el.flags & FLAG.INTERSTELLAR) return out.setHex(NATURAL_COLORS.interstellar);
    // NATURAL is now the TAXONOMY's own tint (kernel TAXONOMY / COMET_NUCLEUS /
    // UNCLASSIFIED), not a hash of the designation. An object JPL has classified
    // is drawn as its class; one it has not gets the unclassified grey and says
    // so in the readout, rather than being assigned a spectral type at random.
    return out.setHex(opticsFor(el).tint);
}
export function classLabel(el) {
    if (el.flags & FLAG.INTERSTELLAR) return 'Interstellar object';
    if (el.flags & FLAG.COMET) return (CLASS_LABELS[el.cls] ?? 'Comet') + ' · near-Earth comet';
    const c = CLASS_LABELS[el.cls] ?? CLASS_LABELS[neoClass(el.a, el.e)] ?? 'Near-Earth asteroid';
    return (el.flags & FLAG.PHA) ? `${c} · potentially hazardous` : c;
}
export function displayName(el) { return el.name || el.des || '—'; }

const DPR = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);

/**
 * THE DRAWN SIZE OF A BODY, IN ONE PLACE.
 *
 * A body's drawn size is now its TRUE PROJECTED SIZE — the same
 * `drawnRockRadius` the mesh pool uses, put through the perspective division —
 * floored at `minPx` where it falls below a pixel. Three things follow, and the
 * first two were visible bugs:
 *
 *   · DEPTH READS. The attenuation curve this replaced (u_att / viewDepth,
 *     clamped to [0.55, 2.30]) saturated at both ends: everything closer than
 *     ~13 scene units drew at the ceiling and everything past ~54 at the floor,
 *     so a whole framing of the orrery came out as one wall of same-size rocks.
 *   · THE LOD HANDOFF IS CONTINUOUS. The impostor and the rock mesh that
 *     replaces it inside ROCK_RANGE now subtend the same angle, so an object
 *     does not jump size as it crosses the line.
 *   · RELATIVE SIZES MEAN SOMETHING. They are the (disclosed, log-compressed)
 *     real diameters — measured where JPL publishes one, else derived from H
 *     through THIS object's albedo, not a 0.14 default that draws every dark
 *     body 1.5x too small.
 *
 * Below `minPx` a body is UNRESOLVED and drawn as a fixed marker; that floor is
 * the one drawing convention left in the size, and the panel discloses it.
 * `drawnPx()` is the JS mirror the pick radius uses — the shader works in
 * device pixels and the mirror in CSS pixels, which is the only difference.
 */
const SPRITE = Object.freeze({
    minPx: 2.0,        // an unresolved body is drawn this big and no smaller
    reticlePx: 11.0,   // an attention ring stays a legible target at any size
    padComa: 1.40,     // extra quad for a comet's coma
    // The display normalisation and compression, both DISCLOSED. `gain` is set
    // so the reference object — the IAU default albedo 0.14, at 1 AU, seen at
    // opposition — renders at ~0.95 of full tone, and `stretch` compresses the
    // several decades of reflected radiance the population actually spans
    // (0.04-albedo nucleus at 5 AU up to a 0.45 E-type at 0.9 AU). Neither
    // changes anything RELATIVE: they move the whole population together.
    //
    // THEY ARE NOT LOCAL. The same two constants tone every moon on the orrery
    // (js/airless-body.js AIRLESS_DISPLAY), which is what makes "a moon and a
    // rock of the same albedo at the same distance render identically" a fact
    // about the code rather than a coincidence between two hand-tuned numbers.
    // One copy, imported — never re-typed here.
    gain: AIRLESS_DISPLAY.gain,
    stretch: AIRLESS_DISPLAY.stretch,
});
/** Pixels per scene unit at view depth `clipW` for a camera of height `viewH` px. */
function pxPerUnit(camera, viewH, clipW) {
    return (camera.projectionMatrix.elements[5] * viewH * 0.5) / Math.max(clipW, 1e-6);
}
/** gl_PointSize in CSS px — the JS mirror of POINT_VS. Keep the two in step. */
function drawnPx(radius, scale, coma = 0, pulse = 0) {
    const body = 2 * radius * scale;
    const quad = Math.max(SPRITE.minPx, body) * (1 + coma * SPRITE.padComa);
    return Math.max(quad, pulse * SPRITE.reticlePx);
}

// ── What a far-field object LOOKS like ──────────────────────────────────────
// A catalogued NEO is a ROCK, not a star. What this replaced was an additive
// Gaussian PSF with a diffraction cross — the rendering convention for a point
// SOURCE of light — and 38 000 of them blended additively into an orange haze
// that read as the population glowing on its own. Worse, the rock meshes that
// stand in inside ROCK_RANGE are shaded SUNLIT BODIES (js/neo-rocks.js), so an
// object changed species as it crossed the LOD line: a light out here, a rock
// up close. The sprite is now the same body the mesh is, drawn as a SPHERE
// IMPOSTOR, and everything about its appearance is computed photometry:
//
//   · THE SCATTERING LAW IS LOMMEL–SEELIGER (single scattering off a dark,
//     particulate, airless regolith), NOT LAMBERT. This is the classic
//     difference: a Lambertian sphere at full phase is a bright centre fading
//     to a dark limb, while an airless body is nearly FLAT across the disc —
//     which is why the full Moon looks like a disc and not a ball. The rock
//     meshes use the same law, on real normals.
//   · THE SCATTERING LAW AND THE OPPOSITION SURGE COME FROM js/airless-body.js,
//     shared with the rock meshes and with every moon the page draws. The
//     disc-integrated H–G function is deliberately NOT applied on top of the
//     BRDF — that double-counted the terminator this shader already draws; it
//     survives in the kernel where a MAGNITUDE is computed, which is its job.
//   · THE ILLUMINATION FALLS AS 1/r². `aIllum` is (1 AU / r)² from the worker's
//     own heliocentric distance, so an object at 3 AU is 9x darker than the
//     same object at 1 AU instead of equally bright everywhere.
//   · THE ALBEDO IS THE OBJECT'S. Measured where JPL publishes one, else the
//     taxonomic class mean (kernel `opticalProperties`) — 0.04 for a cometary
//     nucleus, 0.06 for a C-type, 0.45 for an E-type. Never a hash.
//
// The product of those is a REFLECTED RADIANCE spanning several decades across
// the population, so the last step is a DISCLOSED display stretch (SPRITE.gain
// and SPRITE.stretch) — the same honesty the drawn sizes carry. Shape from
// Lommel–Seeliger and level from H–G is a rendering approximation, not a
// self-consistent Hapke model; it is not claimed to be one.
//
// Blending is NORMAL and premultiplied, so a body in front of the Sun is a
// SILHOUETTE and no number of bodies can add up to a glow. A COMET'S COMA IS
// THE ONE THING HERE THAT MAY GLOW (aComa, the tails' own 1/r²). Attention
// markers — a flyby this week, an in-zone object, the hovered body — are a
// HAIRLINE RETICLE drawn around the body, never a halo drawn on it.
const POINT_VS = /* glsl */`${AIRLESS_GLSL}
    attribute vec3  aColor;
    attribute float aRadius;     // drawn body radius, SCENE units (drawnRockRadius)
    attribute float aAlpha;
    attribute float aPulse;
    attribute float aAlbedo;
    attribute float aIllum;      // (1 AU / r_helio)² — the light reaching the body
    attribute float aShadow;     // fraction of the Sun still visible (Earth's shadow)
    attribute float aShine;      // Earth-reflected light, as a fraction of direct
    attribute float aComa;
    uniform float u_dpr;
    uniform float u_viewPx;      // drawing-buffer height, device px
    uniform float u_minPx;
    uniform float u_reticlePx;
    uniform float u_padComa;
    uniform float u_B0;
    uniform float u_hOpp;
    uniform vec3  u_earthWorld;  // the DRAWN Earth, for the earthshine direction
    varying vec3  vColor;
    varying vec3  vSun;
    varying float vAlpha;
    varying float vPulse;
    varying float vAlbedo;
    varying float vComa;
    varying float vPx;
    varying float vBodyFrac;     // the body's share of the quad — the FS never re-derives it
    varying float vLight;        // illumination × opposition surge × eclipse at this body
    varying float vShine;        // Earth-reflected light reaching it
    varying vec3  vShineDir;     // view-space direction toward Earth
    void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // The Sun is the scene origin, so its VIEW-space position is the view
        // matrix applied to the origin — no uniform for the page to keep in sync.
        vec3 sunView = (viewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 toSun = sunView - mv.xyz;
        vec3 toEye = -mv.xyz;
        vSun = normalize(toSun);
        // Phase angle at the BODY, between the Sun and the camera — the same
        // Sun–body–observer angle the kernel's phaseAngleRad computes. Only the
        // OPPOSITION SURGE is applied here: the disc-integrated H–G function
        // would double-count the terminator this shader already draws (see the
        // js/airless-body.js header). aShadow is Earth's shadow, which only
        // the Earth-local instances can be inside — the umbra is 1.38 million
        // km long and the heliocentric cloud starts past 20 lunar distances.
        float alpha = acos(clamp(dot(vSun, normalize(toEye)), -1.0, 1.0));
        vLight = aIllum * oppositionSurge(alpha, u_B0, u_hOpp) * aShadow;
        vShine = aShine;
        // Earth-reflected light arrives from the DRAWN Earth, so the night side
        // of a close flyby is lit from the right side of the sky.
        vShineDir = normalize((viewMatrix * vec4(u_earthWorld, 1.0)).xyz - mv.xyz);

        float clipW = max(-mv.z, 1e-4);
        // TRUE projected size: projectionMatrix[1][1] is 1/tan(fov/2).
        float bodyPx = 2.0 * aRadius * (projectionMatrix[1][1] * u_viewPx * 0.5) / clipW;
        float quad = max(u_minPx * u_dpr, bodyPx) * (1.0 + aComa * u_padComa);
        quad = max(quad, aPulse * u_reticlePx * u_dpr);
        gl_PointSize = quad;
        vPx = quad;
        vBodyFrac = clamp(bodyPx / max(quad, 1e-4), 0.04, 1.0);
        gl_Position = projectionMatrix * mv;
        vColor = aColor; vAlpha = aAlpha; vPulse = aPulse; vAlbedo = aAlbedo; vComa = aComa;
    }
`;
const POINT_FS = /* glsl */`${TONE_DECODE_GLSL}${AIRLESS_GLSL}
    uniform float u_time;
    uniform float u_gain;
    uniform float u_stretch;
    varying vec3  vColor;
    varying vec3  vSun;
    varying float vAlpha;
    varying float vPulse;
    varying float vAlbedo;
    varying float vComa;
    varying float vPx;
    varying float vBodyFrac;
    varying float vLight;
    varying float vShine;
    varying vec3  vShineDir;
    void main() {
        if (vAlpha <= 0.002) discard;
        vec2 c = (gl_PointCoord - 0.5) * 2.0;     // NOTE gl_PointCoord.y runs DOWN the screen
        float r = length(c);
        if (r > 1.0) discard;
        float bodyR = vBodyFrac;                  // set in POINT_VS — never re-derived here
        float edge  = max(0.10, 2.0 / max(vPx, 1.0));      // ~1 px of antialiased limb
        float cov   = 1.0 - smoothstep(bodyR - edge, bodyR + edge, r);

        // Sphere impostor: the visible hemisphere's normal, in VIEW space, which
        // is the frame vSun is already in. The y flip is gl_PointCoord's.
        vec2 q = c / max(bodyR, 1e-4);
        vec3 n = vec3(q.x, -q.y, sqrt(max(0.0, 1.0 - min(1.0, dot(q, q)))));
        float mu0 = max(dot(n, vSun), 0.0);       // cos(incidence)
        float mu  = max(n.z, 1e-3);               // cos(emission) — the eye is +z here
        // The SHARED law (js/airless-body.js): Lommel–Seeliger, normalised at
        // backscatter, plus the DISCLOSED display compression. A moon and a
        // rock of the same albedo at the same distance render identically.
        float radiance = vAlbedo * (vLight * lommelSeeliger(mu0, mu)
                                  + vShine * lommelSeeliger(max(dot(n, vShineDir), 0.0), mu));
        float lit = airlessTone(radiance, u_gain, u_stretch);
        float limb = pow(smoothstep(bodyR * 0.55, bodyR, r), 3.0) * 0.06;
        vec3 body = vColor * lit + limb * vec3(0.55, 0.62, 0.78);

        float coma = vComa * exp(-r * r * 2.2) * 0.55;     // the one real light source here

        // Hairline reticle, breathing in OPACITY (a size pulse reads as a body
        // that changes size), sitting between the limb and the edge of the quad.
        float ringR = bodyR + (1.0 - bodyR) * 0.55;
        float w     = max(0.035, 1.6 / max(vPx, 1.0));
        float ring  = vPulse * (1.0 - smoothstep(0.0, w, abs(r - ringR)))
                    * (0.62 + 0.38 * sin(u_time * 2.2));
        vec3 ringCol = mix(vColor, vec3(1.0), 0.65);

        // OPACITY RISES WITH THE LIGHT THE BODY ACTUALLY RETURNS. The drawn disc
        // is inflated by the log size map (drawnRockRadius draws a 1 km rock at
        // ~2 000 km), so a fully opaque body would occult a patch of sky
        // thousands of times larger than the real one can — a backlit object
        // came out as a solid black hole in the scene, which is a bigger lie
        // than the dimming. The floor keeps a body crossing a bright background
        // reading as a shadow, which is what an occultation looks like.
        float aBody = cov * vAlpha * clamp(0.30 + 0.70 * lit, 0.30, 1.0);
        float aComa = coma * vAlpha;
        float aRing = ring * vAlpha * 0.9;
        float a = clamp(aBody + aComa + aRing, 0.0, 1.0);
        if (a <= 0.003) discard;
        // Tone map and encode the UNPREMULTIPLIED colour, then premultiply — the
        // order three.js itself uses (<premultiplied_alpha_fragment> runs after
        // <colorspace_fragment>). Encoding the premultiplied colour instead would
        // push the sRGB curve through the alpha and lift every faint object.
        vec3 rgb = (body * aBody + vec3(0.72, 0.86, 1.0) * aComa + ringCol * aRing) / max(a, 1e-4);
        gl_FragColor = vec4(rgb, a);
        gl_FragColor.rgb = toneDecode(gl_FragColor.rgb);   // sRGB colour picks → linear
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor.rgb *= a;                             // premultiplied
    }
`;

function makePointsMaterial() {
    return new THREE.ShaderMaterial({
        vertexShader: POINT_VS, fragmentShader: POINT_FS,
        uniforms: {
            u_dpr:       { value: DPR },
            u_time:      { value: 0 },
            u_viewPx:    { value: 720 * DPR },       // replaced on the first update()
            u_minPx:     { value: SPRITE.minPx },
            u_reticlePx: { value: SPRITE.reticlePx },
            u_padComa:   { value: SPRITE.padComa },
            u_gain:      { value: SPRITE.gain },
            u_stretch:   { value: SPRITE.stretch },
            u_B0:        { value: OPPOSITION.B0 },
            u_hOpp:      { value: OPPOSITION.h },
            u_earthWorld: { value: new THREE.Vector3() },
        },
        transparent: true, depthWrite: false, depthTest: true,
        // NOT AdditiveBlending — see the block above. Premultiplied because the
        // shader hands back premultiplied colour, tone-mapped before the multiply.
        blending: THREE.NormalBlending, premultipliedAlpha: true,
    });
}

// ── Comet tails ─────────────────────────────────────────────────────────────
// Two tails per active comet, as line segments with vertex colours fading to
// black (additive blend ⇒ fade). ION tail: straight, anti-sunward — the Sun is
// at the scene origin, so that direction is exact even on the log scale. DUST
// tail: shorter, lagging behind the motion with a t² curve. Length and coma
// brightness scale as 1/r² of heliocentric distance, gated below TAIL_MAX_R AU.
// Lengths are SCENE units and schematic (the radial scale is logarithmic);
// directions are physical.
const TAIL_SEG = 12;
const TAIL_VERTS = 2 * TAIL_SEG * 2;
const TAIL_MAX_R = 3.5;

// ── Meteoroid streams ───────────────────────────────────────────────────────
// A shower is drawn as what it is: a stream of particles converging on Earth
// from the radiant direction at the stream's speed. Everything is in the
// vertex shader (seed + time), so a stream costs the CPU nothing.
const STREAM_VS = /* glsl */`
    attribute float aSeed;
    attribute vec3  aJitter;
    uniform vec3  u_dir;
    uniform float u_time;
    uniform float u_speed;
    uniform float u_dpr;
    varying float vFade;
    void main() {
        float s = fract(aSeed + u_time * u_speed);                      // 0 far out → 1 at Earth
        vec3 p = u_dir * mix(1.25, 0.16, s) + aJitter * (0.05 + 0.13 * (1.0 - s));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (2.2 + 2.0 * s) * u_dpr * clamp(30.0 / max(-mv.z, 0.05), 0.6, 2.0);
        vFade = smoothstep(0.0, 0.12, s) * (1.0 - smoothstep(0.88, 1.0, s));
        gl_Position = projectionMatrix * mv;
    }
`;
const STREAM_FS = /* glsl */`${TONE_DECODE_GLSL}
    uniform vec3 u_color;
    varying float vFade;
    void main() {
        vec2 c = (gl_PointCoord - 0.5) * 2.0;
        float d2 = dot(c, c);
        if (d2 > 1.0) discard;
        float a = exp(-d2 * 4.0) * vFade * 0.35;   // faint streaks; the rocks carry the stream
        gl_FragColor = vec4(u_color, a);               // premultiply AFTER the encode — see POINT_FS
        gl_FragColor.rgb = toneDecode(gl_FragColor.rgb);   // sRGB colour picks → linear
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragColor.rgb *= a;
    }
`;
function makeStream(count, colorHex) {
    const g = new THREE.BufferGeometry();
    const seed = new Float32Array(count), jit = new Float32Array(count * 3), pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        seed[i] = Math.random();
        jit[i * 3] = Math.random() * 2 - 1; jit[i * 3 + 1] = Math.random() * 2 - 1; jit[i * 3 + 2] = Math.random() * 2 - 1;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    g.setAttribute('aJitter', new THREE.BufferAttribute(jit, 3));
    const m = new THREE.ShaderMaterial({
        vertexShader: STREAM_VS, fragmentShader: STREAM_FS,
        uniforms: {
            u_dir: { value: new THREE.Vector3(0, 1, 0) }, u_time: { value: 0 }, u_speed: { value: 0.5 },
            u_dpr: { value: DPR }, u_color: { value: new THREE.Color(colorHex) },
        },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    pts.renderOrder = 7;
    return pts;
}

/** Canvas-text sprite with constant on-screen size. */
function makeLabel(text, { color = '#dfe6f0', size = 22, weight = 500 } = {}) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const font = `${weight} ${size}px 'Segoe UI', system-ui, sans-serif`;
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(text).width) + 16, h = size + 12;
    canvas.width = w; canvas.height = h;
    ctx.font = font;
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0,0,0,.9)'; ctx.shadowBlur = 4;
    ctx.fillStyle = color;
    ctx.fillText(text, 8, h / 2);
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = THREE.LinearFilter;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false });
    const sprite = new THREE.Sprite(mat);
    // sizeAttenuation:false ⇒ scale is a fraction of the view (≈ scale / (2·tan(fov/2)) of the height).
    const hFrac = 0.032;
    sprite.scale.set(hFrac * (w / h), hFrac, 1);
    sprite.renderOrder = 20;
    sprite.userData.text = text;
    return sprite;
}

/** Simple emitter. */
class Emitter {
    constructor() { this._l = new Map(); }
    on(ev, fn) { if (!this._l.has(ev)) this._l.set(ev, new Set()); this._l.get(ev).add(fn); return () => this._l.get(ev)?.delete(fn); }
    emit(ev, payload) { for (const fn of (this._l.get(ev) ?? [])) { try { fn(payload); } catch (e) { console.warn('[neo-layer]', ev, e); } } }
}

export class NeoLayer extends Emitter {
    /**
     * @param {{ scene: THREE.Scene, earthR?: number, fetchImpl?: typeof fetch,
     *           useWorker?: boolean, tiers?: string[], catalogUrl?: string, watchUrl?: string }} opts
     */
    constructor(opts) {
        super();
        this.scene = opts.scene;
        this.earthR = opts.earthR ?? LOCAL_FRAME.earthSceneRadius;
        this._fetch = opts.fetchImpl ?? ((u, o) => fetch(u, o));
        this.tiers = opts.tiers ?? NEO_TIER_LADDER;
        this.catalogUrl = opts.catalogUrl ?? '/api/neo/catalog';
        this.watchUrl = opts.watchUrl ?? '/api/neo/watch';
        this.useWorker = opts.useWorker ?? true;

        // Population state (index-aligned across els / worker / attributes).
        this.els = [];                 // normalized element records
        this.byDes = new Map();        // des → index
        this.count = 0;
        this.tier = null;
        this.status = {
            catalog: 'loading', catalogNote: 'loading…', tierLoaded: null, tiersPending: [...this.tiers],
            watch: 'loading', watchNote: 'loading…', worker: 'spawning', frameMs: 0, rejected: {},
            catalogMeta: null, watchMeta: null,
        };
        this.watch = { approaches: [], sentry: [], fireballs: [], window: null };
        // population: 'all' | 'bright' (H ≤ 22, PHAs, comets, interstellar) | 'pha'
        // colorMode: 'natural' (S/C-type tints) | 'class' (the legend's data-viz palette)
        this.visible = { asteroids: true, comets: true, population: 'all', local: true, radiants: true, orbit: true, labels: true, colorMode: 'natural' };

        // Frame state from the worker.
        this.frameJd = null;
        this.rGeo = null;              // Float32Array(N), AU
        this.rHelio = null;
        this.inZone = [];              // indices with dLD < LOCAL_FRAME.maxLD (sorted by distance)
        this.closest = null;           // { index, dLD }
        this._earthOfDate = [1, 0, 0];
        this._earthDrawn = new THREE.Vector3();
        this._lastJd = null;

        // Selection.
        this.selectedIndex = null;
        this._bodies = new Map();      // index → body object handed to the page

        // three.js objects.
        this.group = new THREE.Group(); this.group.name = 'neo-layer';
        this.localGroup = new THREE.Group(); this.localGroup.name = 'neo-local-frame';
        this.group.add(this.localGroup);
        this.scene.add(this.group);
        this._pointsMat = makePointsMaterial();
        this.points = null;            // heliocentric-frame population
        this.localPoints = null;       // in-zone instances
        this._localCap = 64;
        this._buildLocalFrame();
        this.orbitLine = null;
        this._orbitBuiltJd = null;
        this.cometTails = null;        // LineSegments: two tails per active comet
        this._cometIdx = [];           // indices of objects that can grow a tail
        this.cometTailsActive = 0;
        this._rockSlots = [];          // { mesh, index, geoKey, shape, spin, isComet }
        this._geoCache = new Map();    // des → { geo, shape }
        this._meshed = new Set();      // indices drawn as meshes right now (sprites suppressed)
        this._rockTick = 0;
        this.anchor = new THREE.Object3D(); this.anchor.name = 'neo-anchor'; this.group.add(this.anchor);
        this.selectedMarker = this._buildSelectedMarker();
        // Hover: what a click would take. Built from the same reticle so the
        // pre-selection and the selection are visibly the same kind of mark.
        this.hoverIndex = null;
        this.hoverMarker = this._buildSelectedMarker('neo-hover-marker', 0.62);
        this._labels = new Map();      // key → sprite
        // Labels have constant SCREEN size, so at the top view (camera ~55 units
        // out) a dozen of them pile onto the Earth disc. Each class is shown
        // only once the frame it annotates subtends enough of the view (measured
        // as ring radius / camera-to-Earth distance) — set every frame in update().
        this._labelVis = { rings: false, objects: false };
        this._radiants = [];           // { code, line, cone, label }
        this._trails = new Map();      // index → Line
        this._trackReq = new Map();    // index → pending id

        // Worker.
        this._worker = null; this._nextId = 1; this._inFlight = false; this._pendingJd = null;
        this._mainFallbackNext = 0;
        this._t = 0;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    /** Kick off the data ladder. Safe to call once. */
    start() {
        this._ensureWorker();
        this._loadWatch();
        this._loadNextTier();
        return this;
    }

    dispose() {
        this._worker?.terminate();
        for (const slot of this._rockSlots) slot.mesh.material.dispose();
        for (const [, g] of this._geoCache) g.geo.dispose();
        for (const r of this._radiants) r.rocks.dispose();
        this.scene.remove(this.group);
    }

    // ── Worker bridge ───────────────────────────────────────────────────────

    _ensureWorker() {
        if (this._worker || !this.useWorker || typeof Worker === 'undefined') return;
        try {
            this._worker = new Worker(WORKER_URL, { type: 'module' });
        } catch (err) {
            console.warn('[neo-layer] module worker unsupported, propagating on main thread:', err);
            this.status.worker = 'main-thread';
            return;
        }
        this._worker.addEventListener('message', (ev) => this._onWorkerMsg(ev.data));
        this._worker.addEventListener('error', (err) => {
            console.warn('[neo-layer] worker error:', err.message || err);
            this.status.worker = 'main-thread';
            this._worker.terminate(); this._worker = null; this._inFlight = false;
        });
    }

    _onWorkerMsg(msg) {
        if (!msg) return;
        if (msg.type === 'ready') { this.status.worker = 'ready'; return; }
        if (msg.type === 'loaded') {
            this.status.rejected = msg.rejected ?? {};
            this.status.worker = `ready · ${msg.count.toLocaleString()} objects`;
            this._inFlight = false;
            this._requestFrame(true);
            return;
        }
        if (msg.type === 'frame') {
            this._inFlight = false;
            if (msg.count === this.count && this.points) this._applyFrame(msg);
            // Time moved on while we computed — go again immediately.
            if (this._pendingJd != null && Math.abs(this._pendingJd - msg.jd) > 1e-4) this._requestFrame(true);
            return;
        }
        if (msg.type === 'track') { this._applyTrack(msg); return; }
        if (msg.type === 'error') { console.warn('[neo-layer] worker:', msg.error); this._inFlight = false; }
    }

    _requestFrame(force = false) {
        if (!this.count || this._lastJd == null) return;
        const jd = this._lastJd;
        this._pendingJd = jd;
        if (this._worker) {
            if (this._inFlight) return;
            if (!force && this.frameJd != null && Math.abs(jd - this.frameJd) < 1e-4) return;
            this._inFlight = true;
            this._worker.postMessage({ type: 'frame', id: this._nextId++, jd, earth: this._earthOfDate });
            return;
        }
        // Main-thread fallback: 1 Hz, so a 38k solve never stalls the render loop for long.
        const now = performance.now();
        if (!force && now < this._mainFallbackNext) return;
        this._mainFallbackNext = now + 1000;
        this._mainThreadFrame(jd);
    }

    async _mainThreadFrame(jd) {
        const mod = await import('./neo-orbits.js');
        if (!this._cols) { const prep = mod.prepareColumns(this.els); this._cols = prep.cols; this._helio = new Float64Array(this.count * 3); }
        const N = this.count;
        const scene = new Float32Array(N * 3), rHelio = new Float32Array(N), rGeo = new Float32Array(N);
        mod.propagateColumns(this._cols, jd, this._helio);
        mod.deriveFrames(this._helio, N, this._earthOfDate, scene, rHelio, rGeo, mod.precessionLongitudeRad(jd));
        this._applyFrame({ jd, count: N, scene, rHelio, rGeo, ms: 0 });
    }

    // ── Data feeds ──────────────────────────────────────────────────────────

    async _loadJson(url) {
        const res = await this._fetch(url, { cache: 'default' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async _loadNextTier() {
        const tier = this.status.tiersPending.shift();
        if (!tier) return;
        if (tier === 'all' && typeof navigator !== 'undefined' && navigator.connection?.saveData) {
            this.status.catalogNote += ' · full catalogue skipped (save-data)';
            this.emit('catalog', this.status);
            return;
        }
        this.status.catalog = this.count ? 'ready' : 'loading';
        this.status.catalogNote = `loading ${tier}…`;
        this.emit('catalog', this.status);
        try {
            const body = await this._loadJson(`${this.catalogUrl}?tier=${encodeURIComponent(tier)}`);
            const rows = Array.isArray(body?.rows) ? body.rows : [];
            if (body?.freshness === 'stale' && rows.length === 0) throw new Error(body.degraded_reason || 'catalogue unavailable');
            this._ingestCatalog(rows, tier, body);
            this.status.catalog = 'ready';
            this.status.catalogNote = body?.freshness === 'stale'
                ? `partial — ${body.degraded_reason || 'asteroid population unavailable'}`
                : `${this.count.toLocaleString()} objects · ${body?.tier_label ?? tier}`;
        } catch (err) {
            console.warn(`[neo-layer] catalog tier ${tier}:`, err.message);
            if (!this.count) { this.status.catalog = 'down'; this.status.catalogNote = `feed down — ${err.message}`; }
            else this.status.catalogNote = `${this.count.toLocaleString()} objects (${this.tier}) · ${tier} failed: ${err.message}`;
        }
        this.emit('catalog', this.status);
        this._loadNextTier();
    }

    _ingestCatalog(rows, tier, meta) {
        const els = [];
        const rejected = {};
        for (const row of rows) {
            const r = normalizeElements(rowToRecord(row));
            if (!r.ok) { rejected[r.reason] = (rejected[r.reason] || 0) + 1; continue; }
            els.push(r.el);
        }
        this.els = els;
        this.count = els.length;
        this.tier = tier;
        this.status.tierLoaded = tier;
        this.status.rejected = rejected;
        this.status.catalogMeta = meta ? { generated_at: meta.generated_at, groups: meta.groups, freshness: meta.freshness, tier_label: meta.tier_label } : null;
        this.byDes = new Map();
        for (let k = 0; k < els.length; k++) if (els[k].des) this.byDes.set(els[k].des, k);
        this._cols = null;
        this._rebuildPoints();
        const prevSel = this.selectedIndex != null ? this._selectedDes : null;
        this.selectedIndex = null; this._bodies.clear();
        this.hover(null);              // indices are about to mean different objects
        this._clearTrails();
        if (this._worker) {
            this._inFlight = true;
            this._worker.postMessage({ type: 'load', id: this._nextId++, records: els.map(el => ({
                des: el.des, name: el.name, H: el.H, cls: el.cls, flags: el.flags,
                e: el.e, a: el.a, q: el.q, i: el.i, om: el.om, w: el.w,
                ma: el.M0 * 180 / Math.PI, epoch: el.t0, tp: el.e >= 1 ? el.t0 : null, moid: el.moid, diam: el.diam,
            })), reset: true });
        } else {
            this._requestFrame(true);
        }
        this._resolveWatchIndices();
        if (prevSel != null && this.byDes.has(prevSel)) this.select(this.byDes.get(prevSel));
        this.emit('population', { count: this.count, tier });
    }

    async _loadWatch() {
        try {
            const body = await this._loadJson(this.watchUrl);
            this.watch = {
                approaches: Array.isArray(body?.approaches) ? body.approaches : [],
                sentry: Array.isArray(body?.sentry) ? body.sentry : [],
                fireballs: Array.isArray(body?.fireballs) ? body.fireballs : [],
                window: body?.window ?? null,
            };
            this.status.watchMeta = { generated_at: body?.generated_at, sources: body?.sources, freshness: body?.freshness };
            const cadDown = body?.freshness === 'stale';
            this.status.watch = cadDown ? 'down' : 'ready';
            this.status.watchNote = cadDown
                ? `approach table down — ${body?.degraded_reason || 'JPL CAD unavailable'}`
                : `${this.watch.approaches.length} approaches · ${this.watch.sentry.length} risk-listed · ${this.watch.fireballs.length} fireballs`;
        } catch (err) {
            console.warn('[neo-layer] watch:', err.message);
            this.status.watch = 'down';
            this.status.watchNote = `feed down — ${err.message}`;
        }
        this._resolveWatchIndices();
        this.emit('watch', this.watch);
    }

    _resolveWatchIndices() {
        for (const a of this.watch.approaches) a.index = this.byDes.has(a.des) ? this.byDes.get(a.des) : null;
        for (const s of this.watch.sentry) s.index = this.byDes.has(s.des) ? this.byDes.get(s.des) : null;
        this._applyStyles();
    }

    // ── Geometry ────────────────────────────────────────────────────────────

    _rebuildPoints() {
        if (this.points) { this.group.remove(this.points); this.points.geometry.dispose(); }
        const N = this.count;
        const geo = new THREE.BufferGeometry();
        this._pos = new Float32Array(N * 3);
        this._col = new Float32Array(N * 3);
        this._radius = new Float32Array(N);    // drawn body radius, scene units
        this._alpha = new Float32Array(N);
        this._pulse = new Float32Array(N);
        this._albedo = new Float32Array(N);
        this._illum = new Float32Array(N);     // (1 AU / r_helio)²
        this._shadow = new Float32Array(N);    // fraction of the Sun still visible
        this._shine = new Float32Array(N);     // Earth-reflected light, fraction of direct
        this._coma = new Float32Array(N);
        this._illum.fill(1);
        // The heliocentric cloud starts past 20 lunar distances and Earth's
        // umbra is 1.38 million km (3.6 LD) long, so nothing drawn on THIS
        // frame can be eclipsed or meaningfully earthlit: these stay constant.
        this._shadow.fill(1);
        geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
        geo.setAttribute('aColor', new THREE.BufferAttribute(this._col, 3));
        geo.setAttribute('aRadius', new THREE.BufferAttribute(this._radius, 1));
        geo.setAttribute('aAlpha', new THREE.BufferAttribute(this._alpha, 1));
        geo.setAttribute('aPulse', new THREE.BufferAttribute(this._pulse, 1));
        geo.setAttribute('aAlbedo', new THREE.BufferAttribute(this._albedo, 1));
        geo.setAttribute('aIllum', new THREE.BufferAttribute(this._illum, 1));
        geo.setAttribute('aShadow', new THREE.BufferAttribute(this._shadow, 1));
        geo.setAttribute('aShine', new THREE.BufferAttribute(this._shine, 1));
        geo.setAttribute('aComa', new THREE.BufferAttribute(this._coma, 1));
        geo.setDrawRange(0, N);
        this.points = new THREE.Points(geo, this._pointsMat);
        this.points.name = 'neo-points';
        this.points.frustumCulled = false;
        this.points.renderOrder = 5;
        this.group.add(this.points);
        this.rGeo = null; this.rHelio = null; this.frameJd = null; this.inZone = []; this.closest = null;
        this._cometIdx = [];
        for (let k = 0; k < N; k++) {
            const el = this.els[k];
            const cometClass = /^(HYP|COM|JFc|JFC|HTC|ETc|CTc|PAR)$/.test(el.cls || '');
            if ((el.flags & FLAG.COMET) || ((el.flags & FLAG.INTERSTELLAR) && cometClass)) this._cometIdx.push(k);
        }
        this._buildCometTails();
        this._applyStyles();
    }

    _buildCometTails() {
        if (this.cometTails) { this.group.remove(this.cometTails); this.cometTails.geometry.dispose(); this.cometTails.material.dispose(); this.cometTails = null; }
        const n = this._cometIdx.length;
        this.cometTailsActive = 0;
        if (!n) return;
        const V = n * TAIL_VERTS;
        const g = new THREE.BufferGeometry();
        this._tailPos = new Float32Array(V * 3);
        this._tailCol = new Float32Array(V * 3);
        g.setAttribute('position', new THREE.BufferAttribute(this._tailPos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(this._tailCol, 3));
        this.cometTails = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
        this.cometTails.name = 'neo-comet-tails';
        this.cometTails.frustumCulled = false;
        this.cometTails.renderOrder = 4;
        this.group.add(this.cometTails);
    }

    _writeTail(o, px, py, pz, f, rgb, b) {
        const pos = this._tailPos, col = this._tailCol;
        for (let i = 0; i < TAIL_SEG; i++) {
            const t0 = i / TAIL_SEG, t1 = (i + 1) / TAIL_SEG;
            const p0 = f(t0), p1 = f(t1);
            const q = o + i * 6;
            pos[q] = px + p0[0]; pos[q + 1] = py + p0[1]; pos[q + 2] = pz + p0[2];
            pos[q + 3] = px + p1[0]; pos[q + 4] = py + p1[1]; pos[q + 5] = pz + p1[2];
            const f0 = Math.pow(1 - t0, 1.6) * b, f1 = Math.pow(1 - t1, 1.6) * b;
            col[q] = rgb[0] * f0; col[q + 1] = rgb[1] * f0; col[q + 2] = rgb[2] * f0;
            col[q + 3] = rgb[0] * f1; col[q + 4] = rgb[1] * f1; col[q + 5] = rgb[2] * f1;
        }
    }

    /** Per worker frame: tails + coma for every comet inside TAIL_MAX_R AU. */
    _refreshCometTails() {
        if (!this.cometTails || this.frameJd == null) return;
        const jd = this.frameJd, prec = precessionLongitudeRad(jd);
        const cp = Math.cos(prec), sp = Math.sin(prec);
        const pos = this._tailPos, col = this._tailCol;
        let active = 0, comaDirty = false;
        for (let i = 0; i < this._cometIdx.length; i++) {
            const k = this._cometIdx[i];
            const o = i * TAIL_VERTS * 3;
            const el = this.els[k];
            const r = this.rHelio[k];
            const vis = this._baseVis ? this._baseVis[k] : 1;
            const b = vis && r < TAIL_MAX_R ? Math.min(1, 0.9 / (r * r)) : 0;
            // The coma is the one thing in the population that may GLOW, so it
            // rides its own attribute (POINT_FS `aComa`) rather than swelling the
            // body: the nucleus stays the dark rock it is and the haze grows
            // around it as 1/r², which is also how the tails below are scaled.
            if (this._coma[k] !== b) { this._coma[k] = b; comaDirty = true; }
            if (b <= 0.01) { pos.fill(0, o, o + TAIL_VERTS * 3); col.fill(0, o, o + TAIL_VERTS * 3); continue; }
            active++;
            const px = this._pos[k * 3], py = this._pos[k * 3 + 1], pz = this._pos[k * 3 + 2];
            const rs = Math.hypot(px, py, pz) || 1;
            const ax = px / rs, ay = py / rs, az = pz / rs;               // anti-sunward (Sun at origin)
            const v = propagate(el, jd, true);                              // J2000 AU/day
            const vx = cp * v.vx - sp * v.vy, vy = sp * v.vx + cp * v.vy;  // → of date
            const vn = Math.hypot(vx, vy, v.vz) || 1;
            const wx = vx / vn, wy = v.vz / vn, wz = vy / vn;              // scene axes (x, z, y)
            const L = Math.min(1.1, Math.max(0.05, 0.32 / (r * r)));
            this._writeTail(o, px, py, pz, (t) => [ax * t * L, ay * t * L, az * t * L], [0.55, 0.78, 1.0], b);
            const Ld = L * 0.75, lag = 0.45;
            this._writeTail(o + TAIL_SEG * 6, px, py, pz,
                (t) => [(ax * t - wx * lag * t * t) * Ld, (ay * t - wy * lag * t * t) * Ld, (az * t - wz * lag * t * t) * Ld],
                [1.0, 0.9, 0.72], b * 0.85);
        }
        this.cometTailsActive = active;
        this.cometTails.geometry.attributes.position.needsUpdate = true;
        this.cometTails.geometry.attributes.color.needsUpdate = true;
        if (comaDirty) this.points.geometry.attributes.aComa.needsUpdate = true;
    }

    _buildLocalFrame() {
        // In-zone instances.
        const cap = this._localCap;
        const geo = new THREE.BufferGeometry();
        this._lpos = new Float32Array(cap * 3); this._lcol = new Float32Array(cap * 3);
        this._lradius = new Float32Array(cap); this._lalpha = new Float32Array(cap); this._lpulse = new Float32Array(cap);
        this._lalbedo = new Float32Array(cap); this._lcoma = new Float32Array(cap);
        this._lillum = new Float32Array(cap);
        this._lshadow = new Float32Array(cap); this._lshine = new Float32Array(cap);
        geo.setAttribute('position', new THREE.BufferAttribute(this._lpos, 3));
        geo.setAttribute('aColor', new THREE.BufferAttribute(this._lcol, 3));
        geo.setAttribute('aRadius', new THREE.BufferAttribute(this._lradius, 1));
        geo.setAttribute('aAlpha', new THREE.BufferAttribute(this._lalpha, 1));
        geo.setAttribute('aPulse', new THREE.BufferAttribute(this._lpulse, 1));
        geo.setAttribute('aAlbedo', new THREE.BufferAttribute(this._lalbedo, 1));
        geo.setAttribute('aIllum', new THREE.BufferAttribute(this._lillum, 1));
        geo.setAttribute('aShadow', new THREE.BufferAttribute(this._lshadow, 1));
        geo.setAttribute('aShine', new THREE.BufferAttribute(this._lshine, 1));
        geo.setAttribute('aComa', new THREE.BufferAttribute(this._lcoma, 1));
        geo.setDrawRange(0, 0);
        this.localPoints = new THREE.Points(geo, this._pointsMat);
        this.localPoints.name = 'neo-local-points';
        this.localPoints.frustumCulled = false;
        this.localPoints.renderOrder = 6;
        this.localGroup.add(this.localPoints);
        this._localIndices = [];

        // Rings at fixed lunar distances — a ruler, so the ticks never move.
        this.rings = [];
        const ringLD = [1, 5, 10, 20];
        for (const [ri, ld] of ringLD.entries()) {
            const r = localSceneRadius(ld * LD_AU * AU_KM, this.earthR);
            const n = 128, arr = new Float32Array(n * 3);
            for (let k = 0; k < n; k++) { const a = (k / n) * Math.PI * 2; arr[k * 3] = r * Math.cos(a); arr[k * 3 + 1] = 0; arr[k * 3 + 2] = r * Math.sin(a); }
            const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
            const line = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: NEO_COLORS.ring, transparent: true, opacity: ld === 1 ? 0.34 : 0.16, depthWrite: false }));
            line.name = `neo-ring-${ld}ld`;
            line.renderOrder = 4;
            this.localGroup.add(line);
            const label = makeLabel(`${ld} LD`, { color: '#8fb8e8', size: 18 });
            // Staggered azimuths: at the same azimuth the four labels project onto
            // one spot whenever the camera looks along the ring plane (Earth View).
            const az = (45 + ri * 28) * Math.PI / 180;
            label.position.set(r * Math.cos(az), 0.012, r * Math.sin(az));
            label.visible = false;
            this.localGroup.add(label);
            this.rings.push({ ld, r, line, label });
        }
    }

    _buildSelectedMarker(name = 'neo-selected-marker', dim = 1) {
        // A thin reticle in the object's own colour, not a grey washer.
        const group = new THREE.Group();
        group.name = name;
        const ring = (ri, ro, opacity) => new THREE.Mesh(new THREE.RingGeometry(ri, ro, 64),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, side: THREE.DoubleSide,
                depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
        // Hairlines: the lock camera sits ~0.1 unit from the rock, so a ring
        // 0.0025 thick was a 25 px band.
        group.add(ring(0.0222, 0.0228, 0.95 * dim), ring(0.0300, 0.0303, 0.30 * dim));
        group.visible = false;
        group.renderOrder = 15;
        this.group.add(group);
        return group;
    }

    /** Colour / size / base alpha per object from class + toggles + watch highlights. */
    _applyStyles() {
        if (!this.points) return;
        const N = this.count;
        const c = new THREE.Color();
        const flybySet = new Set();
        const nowMs = this._simMs ?? Date.now();
        for (const a of this.watch.approaches) {
            if (a.index != null && Math.abs(a.t_ms - nowMs) < 7 * 86400e3) flybySet.add(a.index);
        }
        if (!this._baseVis || this._baseVis.length !== N) this._baseVis = new Float32Array(N);
        if (!this._baseA || this._baseA.length !== N) this._baseA = new Float32Array(N);
        const pop = this.visible.population;
        const mode = this.visible.colorMode;
        const flybyHex = mode === 'class' ? NEO_COLORS.flyby : NATURAL_COLORS.flyby;
        for (let k = 0; k < N; k++) {
            const el = this.els[k];
            const isComet = !!(el.flags & FLAG.COMET), isInter = !!(el.flags & FLAG.INTERSTELLAR), isPha = !!(el.flags & FLAG.PHA);
            let vis;
            if (isComet)      vis = this.visible.comets;
            else if (isInter) vis = this.visible.asteroids || this.visible.comets;
            else {
                vis = this.visible.asteroids;
                if (pop === 'pha')    vis = vis && isPha;
                if (pop === 'bright') vis = vis && (isPha || (el.H != null && el.H <= 22));
            }
            const flyby = flybySet.has(k);
            if (flyby && this.visible.asteroids) vis = true;   // a flyby this week is always worth drawing
            if (flyby) c.setHex(flybyHex); else colorFor(el, mode, c);
            this._col[k * 3] = c.r; this._col[k * 3 + 1] = c.g; this._col[k * 3 + 2] = c.b;
            // Size, albedo and phase slope are three readings of ONE published
            // classification — never three independent guesses.
            const o = opticsFor(el);
            this._radius[k] = drawnRockRadius(o.diamKm);
            this._pulse[k] = flyby ? 1 : 0;
            this._albedo[k] = o.albedo;
            this._baseVis[k] = vis ? 1 : 0;
            // Alpha is VISIBILITY and the local-frame cross-fade, nothing else —
            // a body is opaque or it is not drawn. Magnitude lives in the drawn
            // size and albedo in the shading (see albedoFor).
            this._baseA[k] = 1;
        }
        for (const a of ['aColor', 'aRadius', 'aPulse', 'aAlbedo']) this.points.geometry.attributes[a].needsUpdate = true;
        this._flybySet = flybySet;
        this._refreshAlpha();
    }

    _refreshAlpha() {
        if (!this.points) return;
        const N = this.count;
        for (let k = 0; k < N; k++) {
            if (this._meshed.has(k)) { this._alpha[k] = 0; continue; }   // a mesh stands in
            const base = (this._baseVis ? this._baseVis[k] : 1) * (this._baseA ? this._baseA[k] : 1);
            const dLD = this.rGeo ? toLD(this.rGeo[k]) : Infinity;
            const w = this.visible.local ? localFrameWeight(dLD) : 1;
            this._alpha[k] = base * (0.35 + 0.65 * w);
            // Inside the fade band the local instance takes over; in the deep zone the helio instance is off.
            if (this.visible.local && dLD < LOCAL_FRAME.fadeLD[0]) this._alpha[k] = 0;
        }
        this.points.geometry.attributes.aAlpha.needsUpdate = true;
    }

    /** Frame from the worker: positions, distances, in-zone set, closest, local instances. */
    _applyFrame(msg) {
        const N = msg.count;
        this._pos.set(msg.scene);
        this.points.geometry.attributes.position.needsUpdate = true;
        this.points.geometry.computeBoundingSphere();
        this.rGeo = msg.rGeo; this.rHelio = msg.rHelio; this.frameJd = msg.jd;
        // Illumination at each body: the inverse-square law, in the units H is
        // defined in (1 AU). Without it every object is lit as if it sat at
        // Earth's distance, whatever its real heliocentric distance.
        for (let k = 0; k < N; k++) {
            const r = this.rHelio[k];
            this._illum[k] = r > 1e-4 ? 1 / (r * r) : 1;
        }
        this.points.geometry.attributes.aIllum.needsUpdate = true;
        this.status.frameMs = msg.ms;

        // In-zone set + closest.
        const maxAU = LOCAL_FRAME.maxLD * LD_AU;
        const zone = [];
        let best = -1, bestD = Infinity;
        for (let k = 0; k < N; k++) {
            const d = this.rGeo[k];
            if (d < maxAU && (this._baseVis ? this._baseVis[k] : 1)) zone.push(k);
            if (d < bestD && (this._baseVis ? this._baseVis[k] : 1)) { bestD = d; best = k; }
        }
        zone.sort((a, b) => this.rGeo[a] - this.rGeo[b]);
        this.inZone = zone.slice(0, this._localCap);
        this.closest = best >= 0 ? { index: best, dLD: toLD(bestD), dAU: bestD } : null;
        this._refreshAlpha();
        this._refreshLocalInstances();
        this._refreshCometTails();
        this.emit('frame', { jd: msg.jd, count: N, closest: this.closest, inZone: this.inZone, ms: msg.ms });
    }

    /** Exact geocentric vector for one object at the frame JD (of-date frame). */
    geocentricAt(index, jd = this.frameJd ?? this._lastJd) {
        const el = this.els[index];
        if (!el || jd == null) return null;
        const p = toOfDate(propagate(el, jd), jd);
        const e = this._earthOfDate;
        return { x: p.x - e[0], y: p.y - e[1], z: p.z - e[2], helio: p };
    }

    /**
     * Is there room on screen for this object's label? Off-screen and
     * behind-the-camera positions are never labelled; a position within
     * LABEL_SEP_NDC of one already placed loses (the nearest object is drawn
     * first, so the closer one keeps its label). With no camera yet, every
     * label is allowed — the old behaviour, and the first frame looks the same.
     */
    _labelClear(off, placed) {
        const cam = this._camera;
        if (!cam) return true;
        _vLbl.set(off.x + this._earthDrawn.x, off.y + 0.02 + this._earthDrawn.y, off.z + this._earthDrawn.z).project(cam);
        const onScreen = _vLbl.z > -1 && _vLbl.z < 1 && Math.abs(_vLbl.x) <= 1.1 && Math.abs(_vLbl.y) <= 1.1;
        // OFF-SCREEN IS NOT A CONFLICT. This test exists to stop two labels
        // landing on top of each other, not to cull: a label outside the
        // frustum is already invisible, and dropping it made the set of labels
        // depend on the framing — which churned canvas rasters on every pan and
        // made a browser gate flaky (a label the test expected simply was not
        // built on the frames where Earth sat near the edge). It is allowed
        // through, and takes no slot, because it cannot overlap anything drawn.
        if (!onScreen) return true;
        for (const p of placed) {
            if (Math.abs(p.x - _vLbl.x) < LABEL_SEP_NDC.x && Math.abs(p.y - _vLbl.y) < LABEL_SEP_NDC.y) return false;
        }
        placed.push({ x: _vLbl.x, y: _vLbl.y });
        return true;
    }

    _refreshLocalInstances() {
        const c = new THREE.Color();
        const jd = this.frameJd;
        const n = this.inZone.length;
        this._localIndices = this.inZone.slice();
        const keep = new Set();
        const placed = [];             // NDC of the labels already placed this pass
        for (let j = 0; j < n; j++) {
            const k = this.inZone[j];
            const el = this.els[k];
            const g = this.geocentricAt(k, jd);
            const off = geoToLocalScene(g.x, g.y, g.z, this.earthR);
            this._lpos[j * 3] = off.x; this._lpos[j * 3 + 1] = off.y; this._lpos[j * 3 + 2] = off.z;
            if (this._flybySet?.has(k)) c.setHex(this.visible.colorMode === 'class' ? NEO_COLORS.flyby : NATURAL_COLORS.flyby);
            else colorFor(el, this.visible.colorMode, c);
            this._lcol[j * 3] = c.r; this._lcol[j * 3 + 1] = c.g; this._lcol[j * 3 + 2] = c.b;
            const o = opticsFor(el);
            this._lradius[j] = drawnRockRadius(o.diamKm);
            this._lpulse[j] = 0.8;                       // in-zone: the body wears a reticle
            this._lalbedo[j] = o.albedo;
            this._lillum[j] = this._illum ? this._illum[k] : 1;
            // EARTH'S SHADOW AND EARTHSHINE, in real kilometres — never from
            // the drawn frame, which compresses 384 400 km into two Earth
            // radii. Only the in-zone set can be inside the umbra at all
            // (1.38 million km, i.e. 3.6 LD), and only it is close enough for
            // earthshine to be worth anything, so the heliocentric cloud pays
            // nothing for either.
            const ec = this._earthLitState(g);
            this._lshadow[j] = ec.lit;
            this._lshine[j] = ec.shine;
            this._lcoma[j] = this._coma ? this._coma[k] : 0;
            this._lalpha[j] = this.visible.local && !this._meshed.has(k) ? (1 - localFrameWeight(off.dLD)) : 0;
            // Labels + trails for the nearest few (the selected object already
            // carries the page-level label, so it gets no second one here).
            if (j < LOCAL_LABEL_MAX && this.visible.local && this.visible.labels && k !== this.selectedIndex && this._labelClear(off, placed)) {
                const key = `local:${k}`;
                keep.add(key);
                const text = `${displayName(el)} · ${off.dLD < 10 ? off.dLD.toFixed(2) : off.dLD.toFixed(1)} LD`;
                let s = this._labels.get(key);
                // A canvas re-raster per worker frame × 12 labels would be the
                // most expensive thing on the page at warp speed: 4 Hz per label.
                const nowMs = performance.now();
                if (!s || (s.userData.text !== text && nowMs - (s.userData.builtAt ?? 0) > 250)) {
                    if (s) { this.localGroup.remove(s); s.material.map.dispose(); s.material.dispose(); }
                    s = makeLabel(text, { color: '#ffe9a8', size: 19 });
                    s.userData.builtAt = nowMs;
                    this.localGroup.add(s);
                    this._labels.set(key, s);
                }
                s.position.set(off.x, off.y + 0.02, off.z);
                // The label follows the local-frame weight, NOT the sprite alpha — the
                // sprite is zeroed while a mesh stands in, the label must stay.
                s.material.opacity = this.visible.local ? (1 - localFrameWeight(off.dLD)) : 0;
                s.visible = this._labelVis.objects;
            }
            if (j < 12 && this.visible.local) this._requestTrack(k);
        }
        for (const [key, s] of this._labels) {
            if (key.startsWith('local:') && !keep.has(key)) { this.localGroup.remove(s); s.material.map.dispose(); s.material.dispose(); this._labels.delete(key); }
        }
        for (const [k, line] of this._trails) {
            if (!this.inZone.slice(0, 12).includes(k)) { this.localGroup.remove(line); line.geometry.dispose(); this._trails.delete(k); }
        }
        this.localPoints.geometry.setDrawRange(0, n);
        for (const a of ['position', 'aColor', 'aRadius', 'aAlpha', 'aPulse', 'aAlbedo', 'aIllum', 'aShadow', 'aShine', 'aComa']) this.localPoints.geometry.attributes[a].needsUpdate = true;
        this.localPoints.geometry.computeBoundingSphere();
    }

    /**
     * What Earth is doing to the light at a body, from its REAL geocentric
     * vector: blocking some of the Sun, and reflecting some back. Both come
     * out of js/eclipse-geometry.js, so the Moon (solar-system.html) and a
     * near-Earth object answer the same question with the same code.
     * @param {{x,y,z,helio:{x,y,z}}} g  geocentric + heliocentric, AU
     */
    _earthLitState(g) {
        const e = this._earthOfDate;
        if (!g || !e) return { lit: 1, shine: 0, phase: 'none' };
        const K = AU_KM;
        const geoKm = { x: g.x * K, y: g.y * K, z: g.z * K };
        const sunFromBody = { x: -g.helio.x * K, y: -g.helio.y * K, z: -g.helio.z * K };
        const earthFromBody = { x: -geoKm.x, y: -geoKm.y, z: -geoKm.z };
        const sh = shadowIllumination({ sunFromBody, occulterFromBody: earthFromBody, occulterRadiusKm: EARTH_RADIUS_KM });
        const shine = reflectedIrradianceFraction({
            bodyFromPlanetKm: geoKm,
            sunFromPlanetKm: { x: -e[0] * K, y: -e[1] * K, z: -e[2] * K },
            planetRadiusKm: EARTH_RADIUS_KM, albedo: BODY_ALBEDO.earth,
        });
        return { lit: sh.lit, shine, phase: sh.phase };
    }

    _requestTrack(index) {
        if (!this._worker || this._trackReq.has(index)) return;
        const line = this._trails.get(index);
        if (line && Math.abs(line.userData.jd - this.frameJd) < 0.5) return;   // rebuilt twice a sim-day at most
        const days = 3, steps = 49;
        const jd0 = this.frameJd - days, dt = (2 * days) / (steps - 1);
        const earthAt = [];
        for (let k = 0; k < steps; k++) { const e = this._earthFn?.(jd0 + k * dt); earthAt.push(e ? [e.x_AU, e.y_AU, e.z_AU] : this._earthOfDate); }
        const id = this._nextId++;
        this._trackReq.set(index, id);
        this._worker.postMessage({ type: 'track', id, index, jd: this.frameJd, days, steps, earthAt });
    }

    _applyTrack(msg) {
        this._trackReq.delete(msg.index);
        if (!this.els[msg.index]) return;
        const steps = msg.geo.length / 3;
        const arr = new Float32Array(steps * 3);
        for (let k = 0; k < steps; k++) {
            const off = geoToLocalScene(msg.geo[k * 3], msg.geo[k * 3 + 1], msg.geo[k * 3 + 2], this.earthR);
            arr[k * 3] = off.x; arr[k * 3 + 1] = off.y; arr[k * 3 + 2] = off.z;
        }
        let line = this._trails.get(msg.index);
        if (line) { this.localGroup.remove(line); line.geometry.dispose(); }
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const el = this.els[msg.index];
        const base = this._flybySet?.has(msg.index)
            ? _cB.setHex(this.visible.colorMode === 'class' ? NEO_COLORS.flyby : NATURAL_COLORS.flyby)
            : colorFor(el, this.visible.colorMode, _cB);
        // Bright at "now" (the middle sample), fading to both ends — a ±3-day exposure.
        const col = new Float32Array(steps * 3);
        for (let k = 0; k < steps; k++) {
            const f = 1 - Math.abs(k / (steps - 1) - 0.5) * 2;
            const bb = 0.06 + 0.94 * f * f;
            col[k * 3] = base.r * bb; col[k * 3 + 1] = base.g * bb; col[k * 3 + 2] = base.b * bb;
        }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
        line.name = `neo-trail-${msg.index}`;
        line.userData.jd = msg.jd0 + (steps - 1) * msg.dtDays / 2;
        line.visible = this.visible.local;
        this.localGroup.add(line);
        this._trails.set(msg.index, line);
    }

    _clearTrails() {
        for (const [, line] of this._trails) { this.localGroup.remove(line); line.geometry.dispose(); }
        this._trails.clear(); this._trackReq.clear();
    }

    // ── Mesh LOD (rock pool) ────────────────────────────────────────────────

    _rockRadius(el) {
        // ONE diameter for the mesh and the impostor — measured where JPL has
        // one, else derived from H through THIS object's albedo. They must
        // agree or a body changes size as the mesh takes over.
        return drawnRockRadius(opticsFor(el).diamKm ?? ((el.flags & FLAG.COMET) ? 3 : 0.1));
    }

    _ensureRockSlots() {
        if (this._rockSlots.length) return;
        const placeholder = new THREE.IcosahedronGeometry(1, 0);
        for (let i = 0; i < ROCK_SLOTS; i++) {
            const mesh = new THREE.Mesh(placeholder, rockMaterial(0x9a9691));
            mesh.visible = false; mesh.name = `neo-rock-${i}`; mesh.renderOrder = 8; mesh.frustumCulled = false;
            this.group.add(mesh);
            this._rockSlots.push({ mesh, index: -1, geoKey: null, shape: null, spin: null, isComet: false });
        }
    }

    _geometryFor(el) {
        const key = String(el.des ?? el.name);
        let hit = this._geoCache.get(key);
        if (!hit) {
            const seed = hash32(key);
            const shape = shapeFor(el.des, seed);
            hit = { geo: rockGeometry({ seed, shape, detail: 7 }), shape };   // three subdivides LINEARLY: 7 ⇒ 1280 faces
            this._geoCache.set(key, hit);
            if (this._geoCache.size > GEO_CACHE_MAX) {
                const first = this._geoCache.keys().next().value;
                if (first !== key && !this._rockSlots.some(sl => sl.geoKey === first)) { this._geoCache.get(first).geo.dispose(); this._geoCache.delete(first); }
            }
        }
        return { key, ...hit };
    }

    _isCometLike(el) {
        return !!(el.flags & FLAG.COMET) || (!!(el.flags & FLAG.INTERSTELLAR) && /^(HYP|COM|JFc|JFC|HTC|ETc|CTc|PAR)$/.test(el.cls || ''));
    }

    _updateRocks(f) {
        if (!this.count || !this._pos || !f.camera) return;
        this._ensureRockSlots();
        if ((this._rockTick++ % 6) === 0) {
            const want = [], seen = new Set();
            const visOf = (k) => (this._baseVis ? this._baseVis[k] : 1);
            const add = (k) => { if (k != null && k >= 0 && !seen.has(k) && visOf(k)) { seen.add(k); want.push(k); } };
            add(this.selectedIndex);
            for (const k of this.inZone.slice(0, 12)) add(k);
            // Nearest to the camera inside ROCK_RANGE, from the heliocentric-frame positions.
            const cx = f.camera.position.x, cy = f.camera.position.y, cz = f.camera.position.z;
            const R2 = ROCK_RANGE * ROCK_RANGE;
            const near = [];
            for (let k = 0; k < this.count; k++) {
                if (!visOf(k)) continue;
                const dx = this._pos[k * 3] - cx, dy = this._pos[k * 3 + 1] - cy, dz = this._pos[k * 3 + 2] - cz;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 > R2) continue;
                if (near.length < ROCK_SLOTS || d2 < near[near.length - 1].d2) {
                    let i = near.length; near.push(null);
                    while (i > 0 && near[i - 1].d2 > d2) { near[i] = near[i - 1]; i--; }
                    near[i] = { k, d2 };
                    if (near.length > ROCK_SLOTS) near.pop();
                }
            }
            for (const n of near) { if (want.length >= ROCK_SLOTS) break; add(n.k); }
            const wantSet = new Set(want);
            for (const slot of this._rockSlots) if (slot.index >= 0 && !wantSet.has(slot.index)) { slot.index = -1; slot.mesh.visible = false; }
            const held = new Set(this._rockSlots.map(sl => sl.index));
            for (const k of want) {
                if (held.has(k)) continue;
                const slot = this._rockSlots.find(sl => sl.index < 0);
                if (!slot) break;
                const el = this.els[k];
                const g = this._geometryFor(el);
                slot.mesh.geometry = g.geo; slot.geoKey = g.key; slot.shape = g.shape;
                slot.spin = spinFor(el.des, hash32(String(el.des ?? el.name)));
                slot.isComet = this._isCometLike(el);
                // The base colour is the taxonomy's tint; how DARK the body is
                // comes from its albedo in the shader, not from a hand dimming.
                slot.mesh.material.uniforms.u_base.value.copy(colorFor(el, this.visible.colorMode, _cB));
                slot.mesh.material.uniforms.u_albedo.value = opticsFor(el).albedo;
                slot.mesh.material.uniforms.u_glow.value = 0;
                slot.mesh.scale.setScalar(this._rockRadius(el));
                slot.index = k;
                slot.mesh.visible = true;
                held.add(k);
            }
            const meshed = new Set(this._rockSlots.filter(sl => sl.index >= 0).map(sl => sl.index));
            let changed = meshed.size !== this._meshed.size;
            if (!changed) for (const k of meshed) if (!this._meshed.has(k)) { changed = true; break; }
            if (changed) { this._meshed = meshed; this._refreshAlpha(); if (this.rGeo) this._refreshLocalInstances(); }
        }
        // Position + spin every frame. Spin is a closed-form function of SIM
        // time (real period, seeded phase), so it warps and scrubs correctly.
        const simMs = this._simMs ?? Date.now();
        for (const slot of this._rockSlots) {
            if (slot.index < 0) continue;
            const p = this.drawnPosition(slot.index, slot.mesh.position);
            if (!p) { slot.mesh.visible = false; continue; }
            slot.mesh.visible = true;
            // The illumination reaching this body, plus whatever Earth is doing
            // to it. The shader evaluates the eclipse PER FRAGMENT from these
            // real-kilometre vectors, so a body inside the shadow shows the
            // curved edge of it rather than dimming as one flat disc.
            {
                const el = this.els[slot.index];
                const u = slot.mesh.material.uniforms;
                u.u_illum.value = this._illum ? this._illum[slot.index] : 1;
                u.u_bodyRadiusKm.value = Math.max(0.05, (opticsFor(el).diamKm ?? 0.2) * 0.5);
                const g = this.geocentricAt(slot.index);
                const e = this._earthOfDate;
                if (g && e) {
                    const K = AU_KM;
                    // Ecliptic (x, y, z) → SCENE axes (x, z, y), the same swap
                    // helioToScene applies, so these share a frame with the
                    // drawn normals the shader reads.
                    u.u_sunFromBodyKm.value.set(-g.helio.x * K, -g.helio.z * K, -g.helio.y * K);
                    u.u_occFromBodyKm.value.set(-g.x * K, -g.z * K, -g.y * K);
                    u.u_occRadiusKm.value = EARTH_RADIUS_KM;
                    const st = this._earthLitState(g);
                    u.u_shine.value = st.shine;
                    u.u_shineDir.value.set(-g.x, -g.z, -g.y).normalize();
                } else {
                    u.u_occRadiusKm.value = 0;
                    u.u_shine.value = 0;
                }
            }
            const ang = ((simMs / 3.6e6 / slot.spin.periodH) * Math.PI * 2 + slot.spin.phase) % (Math.PI * 2);
            // Spin about the body's own symmetry axis (geometry +Y), tilted to the seeded pole.
            _qSpin.setFromAxisAngle(_Y, ang);
            slot.mesh.quaternion.setFromUnitVectors(_Y, slot.spin.axis).multiply(_qSpin);
            if (slot.isComet && this.rHelio) {
                const r = this.rHelio[slot.index];
                slot.mesh.material.uniforms.u_glow.value = r < TAIL_MAX_R ? Math.min(1, 0.9 / (r * r)) : 0;
            }
        }
    }

    // ── Selection / bodies ──────────────────────────────────────────────────

    /** Body object in the shape solar-system.html's selectBody() expects. */
    bodyFor(index) {
        const el = this.els[index];
        if (!el) return null;
        let b = this._bodies.get(index);
        if (!b) {
            b = { name: displayName(el), type: classLabel(el), radius: this._rockRadius(el), color: colorFor(el, this.visible.colorMode, _cB).getHex(), mesh: this.anchor, neoIndex: index, des: el.des, data: {} };
            this._bodies.set(index, b);
        }
        b.data = this.readout(index);
        return b;
    }

    /** Select by index (or null to clear). Rebuilds the orbit line and marker. */
    select(index) {
        if (index != null && !this.els[index]) index = null;
        this.selectedIndex = index;
        if (index != null && index === this.hoverIndex) { this.hoverIndex = null; this.hoverMarker.visible = false; }
        this._selectedDes = index != null ? this.els[index].des : null;
        if (this.orbitLine) { this.group.remove(this.orbitLine); this.orbitLine.geometry.dispose(); this.orbitLine = null; }
        const key = 'selected';
        const old = this._labels.get(key);
        if (old) { this.group.remove(old); old.material.map.dispose(); old.material.dispose(); this._labels.delete(key); }
        this.selectedMarker.visible = index != null;
        if (index != null) {
            // setCamLock() reads anchor.position synchronously — seat it now.
            const p = this.drawnPosition(index, this.anchor.position);
            if (p) this.selectedMarker.position.copy(p);
            const tint = colorFor(this.els[index], this.visible.colorMode, _cB).lerp(_cB.clone().set(0xffffff), 0.35).clone();
            for (const m of this.selectedMarker.children) m.material.color.copy(tint);
            this._buildOrbit(index);
            const s = makeLabel(displayName(this.els[index]), { color: '#ffffff', size: 21, weight: 600 });
            this.group.add(s); this._labels.set(key, s);
        }
        this._refreshAlpha();
        this.emit('select', index != null ? this.bodyFor(index) : null);
        return index != null ? this.bodyFor(index) : null;
    }

    selectByDes(des) {
        const idx = this.byDes.get(String(des));
        return idx == null ? null : this.select(idx);
    }

    _buildOrbit(index) {
        const el = this.els[index];
        const jd = this._lastJd ?? this.frameJd ?? el.epoch;
        const pts = sampleOrbit(el, el.e < 1 ? 360 : 200, 60);
        const prec = precessionLongitudeRad(jd);
        const arr = new Float32Array(pts.length * 3);
        for (let k = 0; k < pts.length; k++) {
            const d = rotateAboutPole(pts[k].x, pts[k].y, pts[k].z, prec);
            const s = helioToScene(d.x, d.y, d.z);
            arr[k * 3] = s.x; arr[k * 3 + 1] = s.y; arr[k * 3 + 2] = s.z;
        }
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(arr, 3));
        const Ctor = el.e < 1 ? THREE.LineLoop : THREE.Line;
        this.orbitLine = new Ctor(g, new THREE.LineBasicMaterial({ color: colorFor(el, this.visible.colorMode, _cB).getHex(), transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending }));
        this.orbitLine.name = 'neo-orbit';
        this.orbitLine.visible = this.visible.orbit;
        this.orbitLine.renderOrder = 3;
        this.group.add(this.orbitLine);
        this._orbitBuiltJd = jd;
    }

    /** Drawn position of an object right now (local frame when inside the zone). */
    drawnPosition(index, out = new THREE.Vector3()) {
        const el = this.els[index];
        if (!el) return null;
        const jd = this._lastJd ?? this.frameJd;
        const g = this.geocentricAt(index, jd);
        if (!g) return null;
        const dLD = toLD(Math.hypot(g.x, g.y, g.z));
        const w = this.visible.local ? localFrameWeight(dLD) : 1;
        if (w < 0.5) {
            const off = geoToLocalScene(g.x, g.y, g.z, this.earthR);
            return out.set(this._earthDrawn.x + off.x, this._earthDrawn.y + off.y, this._earthDrawn.z + off.z);
        }
        const s = helioToScene(g.helio.x, g.helio.y, g.helio.z);
        return out.set(s.x, s.y, s.z);
    }

    /** Live data card rows for the Selected Body table. */
    readout(index) {
        const el = this.els[index];
        if (!el) return {};
        const jd = this._lastJd ?? this.frameJd ?? el.epoch;
        const p = propagate(el, jd, true);
        const g = this.geocentricAt(index, jd);
        const dGeo = g ? Math.hypot(g.x, g.y, g.z) : null;
        const notable = findNotable(el);
        const next = this.watch.approaches.filter(a => a.des === el.des && a.t_ms >= (this._simMs ?? Date.now()) - 86400e3).sort((a, b) => a.t_ms - b.t_ms)[0];
        const sentry = this.watch.sentry.find(s => s.des === el.des);
        const o = opticsFor(el);
        const out = {};
        if (notable) out['Why it matters'] = notable.why;
        out['Designation'] = el.des ?? '—';
        out['Class'] = classLabel(el);
        out['Distance from Earth'] = dGeo != null ? `${formatLD(dGeo)} · ${dGeo.toFixed(4)} AU` : '—';
        out['Distance from Sun'] = `${p.r.toFixed(3)} AU`;
        out['Heliocentric speed'] = `${speedKms(p.vx, p.vy, p.vz).toFixed(1)} km/s`;
        out['Size'] = o.diamMeasured
            ? `${formatSize(o.diamKm)} (measured)`
            : (o.diamKm != null ? `${formatSize(o.diamKm)} (from H ${el.H.toFixed(1)} at albedo ${o.albedo.toFixed(3)})` : '—');
        // Albedo and taxonomy set the drawn tone, the drawn size and the phase
        // slope, so the card says which of them was OBSERVED and which is a
        // class mean. `opticalProperties` never invents one.
        out['Albedo · taxonomy'] = `${o.albedo.toFixed(3)} ${o.measured.albedo ? '(measured)' : '(class mean)'} · ${o.measured.taxonomy ? o.label : o.label + ' — no published class'}`;
        // Apparent magnitude AS SEEN FROM EARTH, exact: r, Δ and the phase angle
        // all come from the propagated vectors, never from the drawn scene.
        if (el.H != null && g && dGeo) {
            const alpha = phaseAngleRad(g.helio, g);
            const V = apparentMagnitudeV(el.H, p.r, dGeo, alpha, o.G);
            if (V != null) {
                out['Apparent magnitude'] = `V ≈ ${V.toFixed(1)} from Earth · phase ${(alpha * 180 / Math.PI).toFixed(0)}° · H ${el.H.toFixed(1)}, G ${o.G.toFixed(2)} (IAU H–G)`;
            }
        }
        out['Orbit a · e · i'] = `${Math.abs(el.a).toFixed(3)} AU · ${el.e.toFixed(4)} · ${el.i.toFixed(2)}°`;
        out['Perihelion · aphelion'] = el.e < 1 ? `${el.q.toFixed(3)} · ${el.Q.toFixed(3)} AU` : `${el.q.toFixed(3)} AU · unbound (e > 1)`;
        out['Period'] = el.per_y != null ? (el.per_y < 2 ? `${(el.per_y * 365.25).toFixed(0)} days` : `${el.per_y.toFixed(2)} yr`) : 'unbound — leaving the Solar System';
        if (el.moid != null) out['Earth MOID'] = `${formatLD(el.moid)} · ${el.moid.toFixed(4)} AU`;
        if (next) out['Next close approach'] = `${new Date(next.t_ms).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${formatLD(next.dist_au)} · ${next.v_rel_kms != null ? next.v_rel_kms.toFixed(1) + ' km/s' : ''}`;
        if (sentry) out['Impact monitor'] = `Sentry-listed · Torino ${sentry.ts_max} · Palermo ${sentry.ps_cum} · P(impact) ${sentry.ip != null ? sentry.ip.toExponential(1) : '—'} (${sentry.range ?? '—'})`;
        // Earth in the way, or Earth lighting the night side. Both are computed
        // from the real vectors (js/eclipse-geometry.js), and both are silent
        // when they are nothing — an "Earth's shadow: none" row on every object
        // in the catalogue would be noise.
        if (g) {
            const st = this._earthLitState(g);
            if (st.lit < 0.999) {
                out['Earth\u2019s shadow'] = st.phase === 'umbral'
                    ? 'total — the Sun is fully hidden by Earth; lit only by sunlight refracted through its atmosphere'
                    : `partial — Earth is covering ${((1 - st.lit) * 100).toFixed(0)}% of the Sun`;
            }
            if (st.shine > 1e-5) {
                out['Earthshine'] = `${(st.shine * 1e6).toFixed(0)} ppm of direct sunlight on the night side`;
            }
        }
        out['Propagation'] = `${elementsAgeNote(el.epoch, jd)} · JPL SBDB osculating elements`;
        return out;
    }

    // ── Toggles ─────────────────────────────────────────────────────────────

    setVisible(patch) {
        Object.assign(this.visible, patch);
        if (this.orbitLine) this.orbitLine.visible = this.visible.orbit;
        this.localGroup.visible = this.visible.local;
        for (const [, line] of this._trails) line.visible = this.visible.local;
        for (const r of this._radiants) { const v = this.visible.radiants; r.line.visible = v; r.cone.visible = v; r.label.visible = v; r.stream.visible = v; r.rocks.mesh.visible = v; }
        for (const slot of this._rockSlots) if (slot.index >= 0) slot.mesh.material.uniforms.u_base.value.copy(colorFor(this.els[slot.index], this.visible.colorMode, _cB));
        if (this.rGeo) this._refreshCometTails();
        this._applyStyles();
        if (this.rGeo) this._refreshLocalInstances();
    }

    // ── Picking ─────────────────────────────────────────────────────────────

    /**
     * WHAT IS UNDER THE CURSOR — measured in PIXELS, in the frame that is drawn.
     *
     * The three.js Points raycast this replaced compared a WORLD-space distance
     * to the ray against a world-space threshold (0.012 × the camera range). On
     * a log-scaled orrery that is not a pick radius at all: the same 0.24 units
     * is a fraction of a pixel out at Neptune and a third of the screen a few
     * hundredths of a unit from the eye, so a click on empty sky routinely
     * returned an object hundreds of pixels from the cursor — the "it selects
     * random NEOs" report. It then sorted the hits by `distanceToRay`, which is
     * a perpendicular distance in scene units and not what a cursor means.
     *
     * This projects each candidate and measures the distance in CSS PIXELS, and
     * the accept radius is THE DRAWN RADIUS: gl_PointSize / 2 through `drawnPx`,
     * the JS mirror of POINT_VS, plus GRAB_PX of grace. Both read the same
     * SPRITE table and the same projected body size, so the accept radius
     * cannot drift from what is on screen. The rule a visitor can learn holds —
     * you can click what you can see, and only what you can see.
     *
     * Rock meshes are picked FIRST and exactly, against real geometry. A body
     * close enough to be drawn as a shaped rock was previously not clickable at
     * all — only the two point clouds were ever in the pick set, and a meshed
     * object's sprite is suppressed (`_meshed` ⇒ alpha 0), so the one object on
     * screen with an actual silhouette was the one thing a click could not hit.
     *
     * @param {{ camera: THREE.Camera, ndc: {x:number,y:number},
     *           pixels: {w:number,h:number}, raycaster?: THREE.Raycaster,
     *           grabPx?: number }} o
     * @returns {{ index:number, kind:'mesh'|'point'|'local', px:number } | null}
     */
    pick(o = {}) {
        const { camera, ndc, pixels, raycaster = null, grabPx = GRAB_PX } = o;
        if (!camera || !ndc || !pixels || !pixels.w || !pixels.h || !this.points) return null;

        // 1. Rock meshes — an exact raycast against the drawn geometry.
        if (raycaster) {
            const meshes = this._rockSlots.filter(sl => sl.index >= 0 && sl.mesh.visible).map(sl => sl.mesh);
            if (meshes.length) {
                const hit = raycaster.intersectObjects(meshes, false)[0];
                if (hit) {
                    const slot = this._rockSlots.find(sl => sl.mesh === hit.object);
                    if (slot && slot.index >= 0) return { index: slot.index, kind: 'mesh', px: 0 };
                }
            }
        }

        // 2. The two point clouds, in screen space.
        const halfW = pixels.w * 0.5, halfH = pixels.h * 0.5;
        // projectionMatrix[1][1] · viewportHeight/2 is the pixels-per-scene-unit
        // numerator POINT_VS uses; dividing by clip.w (which IS −viewZ for a
        // perspective camera) gives the drawn size at that depth.
        const pxNum = camera.projectionMatrix.elements[5] * halfH;
        let best = null;
        const scan = (obj, pos, radius, alpha, pulse, coma, count, indexOf, kind) => {
            if (!obj || !count || !pos) return;
            _mPick.multiplyMatrices(camera.projectionMatrix,
                _mPick2.multiplyMatrices(camera.matrixWorldInverse, obj.matrixWorld));
            const e = _mPick.elements;
            for (let i = 0; i < count; i++) {
                if (alpha[i] <= 0.05) continue;                       // not drawn ⇒ not clickable
                const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
                const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
                if (cw <= 1e-6) continue;                             // behind the camera
                const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / cw;
                const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw;
                const dx = (cx - ndc.x) * halfW, dy = (cy - ndc.y) * halfH;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (best && d > best.d + 2) continue;                 // cheap reject before the size maths
                const px = drawnPx(radius[i], pxNum / cw, coma ? coma[i] : 0, pulse ? pulse[i] : 0);
                if (d > Math.max(grabPx, px * 0.5 + 1.5)) continue;
                // Nearest the cursor; within 2 px of a tie, the nearer body wins.
                if (!best || d < best.d - 2 || (d < best.d + 2 && cw < best.cw)) {
                    const index = indexOf(i);
                    if (index != null) best = { index, kind, d, cw };
                }
            }
        };
        scan(this.localPoints, this._lpos, this._lradius, this._lalpha, this._lpulse, this._lcoma,
             this._localIndices ? this._localIndices.length : 0, (i) => this._localIndices[i], 'local');
        scan(this.points, this._pos, this._radius, this._alpha, this._pulse, this._coma,
             this.count, (i) => i, 'point');
        return best ? { index: best.index, kind: best.kind, px: best.d } : null;
    }

    /**
     * Hover highlight — the affordance that tells you what a click will take.
     * A reticle, for the same reason the flyby marker is one: an instrument
     * annotation on a body, never a brightening OF the body.
     */
    hover(index) {
        let next = (index == null || index === this.selectedIndex) ? null : index;
        if (next != null && !this.els[next]) next = null;   // a tier swap can outrun a hover
        if (next === this.hoverIndex) return this.hoverIndex;
        this.hoverIndex = next;
        if (next == null) { this.hoverMarker.visible = false; return null; }
        const tint = colorFor(this.els[next], this.visible.colorMode, _cHover).lerp(_cB.setHex(0xffffff), 0.5);
        for (const m of this.hoverMarker.children) m.material.color.copy(tint);
        this.hoverMarker.visible = true;
        return next;
    }

    /**
     * How much of the drawn population is OBSERVED rather than a class mean.
     * Albedo and taxonomy set every body's tone, its derived diameter and its
     * phase slope, so the page reports the coverage instead of letting a
     * catalogue with zero measured albedos look identical to one full of them.
     */
    photometryCoverage() {
        let albedo = 0, taxonomy = 0, diam = 0;
        for (const el of this.els) {
            if (el.albedo != null) albedo++;
            if (el.spec != null) taxonomy++;
            if (el.diam != null) diam++;
        }
        return { total: this.els.length, albedo, taxonomy, diam };
    }

    /** One line identifying an object, for a hover tooltip — no readout() build. */
    hoverText(index) {
        const el = this.els[index];
        if (!el) return '';
        const g = this.geocentricAt(index);
        const bits = [displayName(el), classLabel(el)];
        if (g) bits.push(`${formatLD(Math.hypot(g.x, g.y, g.z))} from Earth`);
        return bits.join(' · ');
    }

    // ── Meteor showers ──────────────────────────────────────────────────────

    /** Active showers at the current sim λ☉ (cached per frame). */
    showers() { return this._showers ?? { active: [], next: null, solarLon: null }; }

    _refreshRadiants(jd, earthLonRad) {
        const lon = solarLongitudeDeg(earthLonRad);
        const active = activeShowers(lon);
        this._showers = { active, next: nextShower(lon), solarLon: lon };
        const want = active.filter(x => x.activity >= 0.2).slice(0, 3);
        const wantCodes = new Set(want.map(x => x.shower.code));
        for (const r of this._radiants.slice()) {
            if (!wantCodes.has(r.code)) {
                this.localGroup.remove(r.line, r.cone, r.label, r.stream, r.rocks.mesh);
                r.line.geometry.dispose(); r.cone.geometry.dispose(); r.label.material.map.dispose();
                r.stream.geometry.dispose(); r.stream.material.dispose(); r.rocks.dispose();
                this._radiants.splice(this._radiants.indexOf(r), 1);
            }
        }
        const prec = precessionLongitudeRad(jd);
        for (const x of want) {
            const s = x.shower;
            let r = this._radiants.find(q => q.code === s.code);
            const u0 = radiantEclipticUnit(s.ra, s.dec);
            const u = rotateAboutPole(u0.x, u0.y, u0.z, prec);
            // Scene axis swap; arrow points INBOUND (meteoroids come from the radiant).
            const dir = new THREE.Vector3(u.x, u.z, u.y);
            const tail = dir.clone().multiplyScalar(1.05), head = dir.clone().multiplyScalar(0.34);
            // The shaft is a thin cylinder, not a GL line: WebGL lines are 1 px
            // wide whatever the zoom and vanish against the point cloud.
            const len = tail.length() - head.length();
            const mid = head.clone().add(tail).multiplyScalar(0.5);
            if (!r) {
                // A hairline guide with a small head; the STREAM carries the visual weight.
                const shaftMat = new THREE.MeshBasicMaterial({ color: NEO_COLORS.radiant, transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending });
                const line = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0035, len, 6), shaftMat);
                const cone = new THREE.Mesh(new THREE.ConeGeometry(0.02, 0.07, 10), shaftMat);
                const label = makeLabel(`☄ ${s.name} · ZHR ~${Math.round(s.zhr * x.activity)} · ${s.vKms} km/s`, { color: '#ffd27a', size: 19 });
                const stream = makeStream(Math.round(70 + 170 * x.activity), 0xfff1c8);
                // The meteoroids themselves: instanced tumbling rocks on the same cone.
                const rocks = new MeteoroidStream({ count: Math.round(90 + 130 * x.activity), seed: hash32(s.code) });
                line.name = `neo-radiant-${s.code}`;
                stream.name = `neo-stream-${s.code}`;
                rocks.mesh.name = `neo-meteoroids-${s.code}`;
                this.localGroup.add(line, cone, label, stream, rocks.mesh);
                r = { code: s.code, line, cone, label, stream, rocks };
                this._radiants.push(r);
            }
            r.line.position.copy(mid);
            r.line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
            r.cone.position.copy(head);
            r.cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().negate());
            r.label.position.copy(tail).addScalar(0.02);
            r.stream.material.uniforms.u_dir.value.copy(dir);
            r.stream.material.uniforms.u_speed.value = s.vKms / 40;   // faster streams pour in faster
            r.rocks.setDirection(dir); r.rocks.setSpeed(s.vKms / 40);
            const vis = this.visible.radiants;
            r.line.visible = vis; r.cone.visible = vis; r.label.visible = vis; r.stream.visible = vis; r.rocks.mesh.visible = vis;
        }
    }

    // ── Per-frame update (called from the page's animate loop) ──────────────

    /**
     * @param {{ jd:number, earthOfDate:{x_AU,y_AU,z_AU,lon_rad}, earthFn?:(jd)=>object,
     *           earthDrawn:THREE.Vector3, t:number, simMs?:number, camera?:THREE.Camera, camDist?:number }} f
     */
    update(f) {
        this._t = f.t ?? this._t + 0.016;
        this._pointsMat.uniforms.u_time.value = this._t;
        // Drawn size is a TRUE projected size, so the shader needs the viewport
        // height in device pixels. Set every frame: it is one uniform write, and
        // a resize that missed it would silently mis-size the whole population
        // (and the pick radius with it).
        if (f.viewPx > 0) this._pointsMat.uniforms.u_viewPx.value = f.viewPx;
        for (const r of this._radiants) { r.stream.material.uniforms.u_time.value = this._t; r.rocks.update(this._t); }
        this._camera = f.camera ?? this._camera;   // the label de-clutter projects with it
        this._earthDrawn.copy(f.earthDrawn);
        this._pointsMat.uniforms.u_earthWorld.value.copy(this._earthDrawn);
        this._earthOfDate = [f.earthOfDate.x_AU, f.earthOfDate.y_AU, f.earthOfDate.z_AU];
        this._earthFn = f.earthFn ?? this._earthFn;
        this._simMs = f.simMs ?? this._simMs;
        const jdChanged = this._lastJd == null || Math.abs(f.jd - this._lastJd) > 1e-4;
        this._lastJd = f.jd;
        this.localGroup.position.copy(this._earthDrawn);
        if (f.camera) {
            const dEarth = Math.max(0.05, f.camera.position.distanceTo(this._earthDrawn));
            const r1 = this.rings[0].r, r20 = this.rings[this.rings.length - 1].r;
            // fov 50°: a radius r at distance d spans ≈ 1.07·r/d of the view height.
            const rings = this.visible.local && r1 / dEarth > 0.02;
            const objects = this.visible.local && this.visible.labels && r20 / dEarth > 0.08;
            if (rings !== this._labelVis.rings || objects !== this._labelVis.objects) {
                this._labelVis = { rings, objects };
                for (const r of this.rings) r.label.visible = rings;
                for (const [key, sp] of this._labels) if (key.startsWith('local:')) sp.visible = objects;
            }
        }
        // Labels are placed by SCREEN separation (_labelClear), so orbiting with
        // the sim PAUSED has to re-place them — the worker frame that normally
        // does it never arrives while the clock is stopped. Throttled, and only
        // on real camera motion, because the pass costs up to 64 Kepler solves.
        if (f.camera && this.rGeo && this.visible.local && this.visible.labels) {
            const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            const moved = this._labelCamPos ? f.camera.position.distanceTo(this._labelCamPos) : Infinity;
            if (moved > 0.01 * Math.max(1e-3, f.camera.position.length()) && nowMs - (this._labelPassAt ?? 0) > 300) {
                this._labelPassAt = nowMs;
                (this._labelCamPos ??= new THREE.Vector3()).copy(f.camera.position);
                this._refreshLocalInstances();
            }
        }
        if (jdChanged) this._requestFrame(false);
        // Radiants ride the sim date (λ☉ moves ~1°/day, cheap to re-evaluate every ~0.1 d).
        if (this._radiantJd == null || Math.abs(f.jd - this._radiantJd) > 0.1) { this._radiantJd = f.jd; this._refreshRadiants(f.jd, f.earthOfDate.lon_rad); }
        // Flyby highlight set depends on the sim date (±7 d) — refresh every sim-day.
        if (this._styleMs == null || Math.abs((this._simMs ?? 0) - this._styleMs) > 86400e3) { this._styleMs = this._simMs ?? 0; if (this.points) this._applyStyles(); }
        this._updateRocks(f);
        // Hover reticle: the same seat-and-face treatment as the selected one, a
        // touch larger so the two rings read as pre-selection and selection.
        if (this.hoverIndex != null && this.hoverMarker.visible) {
            const hp = this.drawnPosition(this.hoverIndex, this.hoverMarker.position);
            if (hp) {
                const hr = this._rockRadius(this.els[this.hoverIndex]);
                this.hoverMarker.scale.setScalar(Math.max(hr * 2.1 / 0.021, Math.min(9, Math.max(1.25, (f.camDist ?? 20) * 0.10))));
                this.hoverMarker.lookAt(f.camera ? f.camera.position : new THREE.Vector3(0, 50, 0));
            } else {
                this.hoverMarker.visible = false;
            }
        }
        // Selected object: anchor, marker, label, orbit (re-oriented if the date moved a lot).
        if (this.selectedIndex != null) {
            const p = this.drawnPosition(this.selectedIndex, this.anchor.position);
            if (p) {
                this.selectedMarker.position.copy(p);
                const rr = this._rockRadius(this.els[this.selectedIndex]);
                this.selectedMarker.scale.setScalar(Math.max(rr * 1.7 / 0.021, Math.min(8, Math.max(1, (f.camDist ?? 20) * 0.08))));
                this.selectedMarker.lookAt(f.camera ? f.camera.position : new THREE.Vector3(0, 50, 0));
                const s = this._labels.get('selected');
                if (s) s.position.set(p.x, p.y + 0.03, p.z);
            }
            if (this._orbitBuiltJd != null && Math.abs(f.jd - this._orbitBuiltJd) > 30) this._buildOrbit(this.selectedIndex);
        }
    }
}
