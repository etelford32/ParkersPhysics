/**
 * cloud-volume.js — volumetric cloud renderer for earth.html
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A single-pass raymarch through the troposphere shell, replacing the three
 * alpha-blended noise DECALS in earth-skin.js's CLOUD_FRAG at the top
 * governor tiers. Same data, given real vertical extent — and, since
 * 2026-09, real MOTION: everything time-dependent below is a function of
 * SIMULATION time, and the motion comes from the wind field.
 *
 * WHAT THIS FIXES
 * ───────────────
 * The decal shader had hit its ceiling. Three shells of FBM alpha stacked
 * over a lit sphere can produce a coverage map, but it cannot produce a
 * cloud: there is no depth to integrate through, so there are no dark bases,
 * no bright tops, no shafts, no limb puff, and every fragment resolves to
 * roughly the same mid-grey. That is the "grey soup" the layered
 * compositing, the mass-clumping S-curve and the relief-bump pass were each
 * trying to fake, and it is why the globe read as smeared rather than
 * cloudy. Integrating along the view ray gets all of it for free, because
 * all of it is the same phenomenon: light attenuating through a medium.
 *
 * WHAT IT DOES NOT CHANGE
 * ───────────────────────
 * The DATA. Coverage still comes from the Open-Meteo low/mid/high channels
 * and the satellite mosaic exactly as CLOUD_FRAG consumed them, including
 * the Phase-2.5 IR deck routing. The march decides where the mass SITS in
 * the column and how light moves through it; it never invents coverage.
 * Research / measured-only mode does NOT use this path at all (see the
 * routing note below) — a volumetric render implies vertical structure the
 * measured fields did not supply.
 *
 * THE CLOCK (Phase 4 — js/cloud-time.js is the ONE copy of the rules)
 * ─────────────────────────────────────────────────────────────────────
 * Three things used to run on three clocks: the coverage grid on the time
 * bus, the mosaic on wall-clock, the noise on clock.getElapsedTime(). Now:
 *
 *   • `u_sim_time` is simulation seconds (relative to a page epoch — a raw
 *     epoch-ms value has 128 s of float32 precision, which is useless).
 *     Pause freezes the clouds; 60× runs them 60× faster; revisiting an
 *     instant reproduces it. The MORPH rate is per sim-MINUTE what the old
 *     wall-clock drift was per second (FLOW.morphRatePerSec) — real cloud
 *     morphology evolves over hours, and the wind carries the visible motion.
 *   • The procedural noise is a two-phase FLOW MAP advected by the surface
 *     wind (scaled aloft by windGainAt): the sample point is displaced
 *     upstream by phase × period × wind on two layers half a period apart,
 *     cross-faded so each layer's reset hides under the other. Bounded
 *     distortion, no pops, and the clouds stream along the jet and spiral
 *     into lows because that is what the wind field does.
 *   • The mosaic is sampled UPSTREAM by `u_sat_lead` (sim time − frame
 *     time) × wind — a 10-min frame MOVES for the ten minutes it stands in
 *     for, the next frame lands where the last one had drifted to, and the
 *     same displacement with a lead of hours is the persistence-advection
 *     NOWCAST cloud-time.js resolves for the near future. `u_sat_prev` +
 *     `u_sat_blend` cross-fade frame swaps; `u_sat_weight` is the mode's
 *     confidence (0 in the deep future — the render is model-only there,
 *     and the page says so).
 *
 * The phase numbers (`u_flow` = (phaseA·T, phaseB·T, blend)) are computed
 * on the JS side from the same kernel, once per frame, so the branch on
 * the blend weight below is UNIFORM across pixels and a fresh reset costs
 * one noise evaluation, not two.
 *
 * THE IR TOP IS THE VOLUME'S TOP
 * ──────────────────────────────
 * The mosaic's B channel is an IR brightness-temperature proxy; decoded
 * against 2 m temperature and a 6.5 K/km lapse it is an OBSERVED cloud-top
 * height. The decal shader could only use it to pick which of three flat
 * shells to paint. Here it sets the actual top of the marched column, so a
 * measured 13 km overshoot renders as a tower that is 13 km tall. Where no
 * IR disc saw the pixel the column falls back to the model's nominal deck
 * extents — procedural-fill regions grow no fake towers.
 *
 * GEOMETRY / COVERAGE
 * ───────────────────
 * The carrier mesh is a unit sphere scaled just past the volume top, drawn
 * `side: BackSide, depthTest: false`. BackSide is what makes the same
 * material work from OUTSIDE the volume (back faces cover exactly the
 * shell's silhouette) and from INSIDE it (back faces surround you) — which
 * the altitude ramp needs, because the camera is allowed to descend into
 * the stack. depthTest is off because the march establishes its own
 * occlusion: it clips at the planet sphere analytically, so the ground
 * hides cloud correctly without the depth buffer, and a fragment whose ray
 * misses the shell early-outs before any march cost.
 *
 * The march runs in WORLD space (concentric spheres are rotation-invariant,
 * so intersections need no frame change) and only the SAMPLE DIRECTION is
 * rotated into the Earth-fixed frame by `u_earth_rot`. Do not re-add a
 * per-vertex object-space transform for this — `inverse()` is GLSL3-only
 * and the mesh must stay un-rotated for the scale-tracking to be one line.
 *
 * PLANET SHADOW IS REAL HERE
 * ──────────────────────────
 * The light march tests the sun ray against the planet sphere, so the
 * terminator, the long shadow-side falloff and the reddening all fall out
 * of geometry instead of the decal shader's hand-tuned NdotL biases and
 * per-deck `u_shell_lift` constants. That is why those uniforms have no
 * analogue here.
 *
 * COST + ROUTING
 * ──────────────
 * This is fragment-bound and expensive. Two things keep it on screen on
 * hardware that used to lose it:
 *
 *   1. HALF-RESOLUTION. `VolumeCompositor` renders the carrier mesh into an
 *      offscreen target at `scale` (default 0.5) of the drawing buffer and
 *      composites it into the scene through a screen quad with the SAME
 *      premultiplied blend, at the same renderOrder the mesh had. Clouds are
 *      low-frequency; a 2× bilinear upsample of a raymarch is standard
 *      practice and buys ~4× on fill rate. `?cloud_res=1` disables it.
 *   2. The light march runs on ALTERNATE primary steps and the result is
 *      reused: sun transmittance varies slowly along the ray and it is the
 *      dominant term (light steps × primary steps density evaluations).
 *
 * The routing (earth.html `_updateCloudShellMode`) now keeps the march live
 * one governor tier down — at the 28-step rung instead of the 48 — rather
 * than swapping to the decals. THAT SWAP WAS THE "KEEPS REGRESSING" REPORT:
 * the governor is reactive, the march pushed a mid-range GPU over the
 * demotion threshold, the decals ran fast enough to promote it back, and
 * the page ping-ponged between two different-looking planets. A cheaper
 * march is the same planet with less detail. Every other state — the floor
 * tier, research mode, the whole software-GL path CI runs on — still falls
 * back to the composite CLOUD_FRAG shell. Both paths stay live and neither
 * is dead code. Step counts come from `marchLadder()` so the ladder is
 * data, not scattered magic numbers.
 *
 * Altitudes, radii and the exaggeration factor all come from
 * js/atmo-scale.js; timing rules from js/cloud-time.js. This module owns no
 * geometry or timing constants of its own.
 */

import * as THREE from 'three';
import { GEO_GLSL } from './geo/coords.glsl.js';
import {
    R_EARTH_KM, DECK_ALTITUDE_KM, VOLUME_TOP_KM, VOLUME_BASE_KM,
    SURFACE_CLEARANCE_R,
} from './atmo-scale.js';
import { FLOW, R_EARTH_M, windGainAt, flowPhase } from './cloud-time.js';

/**
 * Primary / light march step budget per quality tier. Mirrors the tiering of
 * CLOUD_FRAG's `u_quality` so a governor step changes both shaders' cost in
 * the same direction. The top two rungs are reachable by the governor (the
 * volumetric path routes at q > 0.45); the floor rung exists for the URL
 * override (`?cloud_quality=`).
 */
export function marchLadder(quality) {
    if (quality > 0.83) return { primary: 48, light: 6 };
    if (quality > 0.45) return { primary: 28, light: 4 };
    return { primary: 16, light: 3 };
}

/** Hard ceilings the GLSL loops are compiled with (GLSL ES 1.00 needs
 *  constant bounds; the uniforms break out early below these). */
const MAX_PRIMARY_STEPS = 64;
const MAX_LIGHT_STEPS   = 8;

/** Wind gain applied to the mosaic's advection: the observed field is a
 *  column property whose motion is set by the cloud tops, so it rides a
 *  mid-troposphere gain rather than the surface wind. Stated approximation
 *  (see cloud-time.js windGainAt). */
export const SAT_ADVECT_ALT_KM = 3.0;

export const VOLUME_VERT = /* glsl */`
varying vec3 vWorldPos;
void main() {
    vWorldPos   = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const VOLUME_FRAG = /* glsl */`
precision highp float;

${GEO_GLSL}

varying vec3 vWorldPos;

uniform sampler2D u_cloud_layers;   // R=low G=mid B=high A=precip  [0-1]
uniform sampler2D u_satellite;      // R=cover  B=IR top proxy  A=confidence
uniform sampler2D u_sat_prev;       // the frame being cross-faded FROM
uniform sampler2D u_weather;        // R=temp (t2m, normalised)
uniform sampler2D u_wind;           // RG = 10 m wind U,V  (x*2-1)*u_wind_max m/s

uniform vec3  u_sun_dir;            // world space, unit
uniform float u_earth_rot;          // planet spin, radians (world → Earth-fixed)
uniform float u_sim_time;           // SIMULATION seconds, relative to the page epoch
uniform vec3  u_flow;               // (phaseA·T, phaseB·T, blend) — cloud-time.js flowPhase
uniform float u_flow_gain;          // display exaggeration of the advection (1 = physical)
uniform float u_wind_max;           // m/s at texel value 1
uniform float u_sat_lead;           // s the CURRENT mosaic frame is advected by
uniform float u_sat_prev_lead;      // s the PREVIOUS frame is advected by
uniform float u_sat_blend;          // weight of the previous frame [0,1]
uniform float u_sat_weight;         // mode confidence (0 = model only)
uniform float u_frame;              // frame counter (jitter decorrelation)
uniform float u_exag;               // vertical exaggeration (atmo-scale)
uniform float u_r_base;             // volume inner radius, world units
uniform float u_r_top;              // volume outer radius, world units
uniform float u_r_surface;          // planet sphere, for shadow + clipping
uniform float u_satellite_on;
uniform float u_cloud_data_strength;
uniform float u_density;            // global optical-depth scale (tuning knob)
uniform int   u_steps;              // primary march steps
uniform int   u_light_steps;        // light march steps

const float R_EARTH_KM_C   = ${R_EARTH_KM.toFixed(1)};
const float R_EARTH_M_C    = ${R_EARTH_M.toFixed(1)};
const float R_CLEAR_C      = ${SURFACE_CLEARANCE_R.toFixed(6)};
const float VOL_TOP_KM     = ${VOLUME_TOP_KM.toFixed(2)};
const float VOL_BASE_KM    = ${VOLUME_BASE_KM.toFixed(3)};
const float LOW_BASE_KM    = ${DECK_ALTITUDE_KM.low.base.toFixed(2)};
const float LOW_TOP_KM     = ${DECK_ALTITUDE_KM.low.top.toFixed(2)};
const float MID_BASE_KM    = ${DECK_ALTITUDE_KM.mid.base.toFixed(2)};
const float MID_TOP_KM     = ${DECK_ALTITUDE_KM.mid.top.toFixed(2)};
const float HIGH_BASE_KM   = ${DECK_ALTITUDE_KM.high.base.toFixed(2)};
const float HIGH_TOP_KM    = ${DECK_ALTITUDE_KM.high.top.toFixed(2)};
// Timing constants — interpolated from js/cloud-time.js FLOW, never typed.
const float FLOW_PERIOD_S  = ${FLOW.periodSec.toFixed(1)};
const float MORPH_RATE     = ${FLOW.morphRatePerSec.toExponential(6)};
const float WIND_GAIN_ALOFT = ${FLOW.windGainAloft.toFixed(3)};
const float WIND_GAIN_TOP_KM = ${FLOW.windGainTopKm.toFixed(2)};
const float SAT_WIND_GAIN  = ${windGainAt(SAT_ADVECT_ALT_KM).toFixed(4)};

// ── Noise ────────────────────────────────────────────────────────────────────
// Same hash/value-noise construction as CLOUD_FRAG so the two paths share a
// visual family — a governor flip between them must not look like a different
// planet's weather.
float hash31(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash31(i);
    float n100 = hash31(i + vec3(1.0, 0.0, 0.0));
    float n010 = hash31(i + vec3(0.0, 1.0, 0.0));
    float n110 = hash31(i + vec3(1.0, 1.0, 0.0));
    float n001 = hash31(i + vec3(0.0, 0.0, 1.0));
    float n101 = hash31(i + vec3(1.0, 0.0, 1.0));
    float n011 = hash31(i + vec3(0.0, 1.0, 1.0));
    float n111 = hash31(i + vec3(1.0, 1.0, 1.0));
    float x00 = mix(n000, n100, f.x);
    float x10 = mix(n010, n110, f.x);
    float x01 = mix(n001, n101, f.x);
    float x11 = mix(n011, n111, f.x);
    return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

// NORMALISED to [0,1] — divide by the amplitude actually summed, not by a
// constant. The coverage remap in densityAt() thresholds against (1 - cover),
// so it assumes its input spans the unit interval. An un-normalised 3-octave
// sum tops out at 0.875 and averages ~0.44, which silently made every cell
// with less than ~55% cover render as clear sky: the globe came back almost
// cloudless and it read as "the data isn't arriving" rather than as a
// one-line scaling bug. Keep the division.
float fbm3(vec3 p, int octaves) {
    float v = 0.0, a = 0.5, f = 1.0, norm = 0.0;
    for (int i = 0; i < 5; i++) {
        if (i >= octaves) break;
        v += a * vnoise3(p * f);
        norm += a;
        f *= 2.17;      // non-integer lacunarity: keeps octaves from
        a *= 0.5;       // re-aligning into visible lattice grids
    }
    return v / max(norm, 1e-5);
}

// Interleaved gradient noise (Jimenez 2014): a per-pixel jitter with a far
// better spectrum than a hash of the fragment coordinate, and cheaper. The
// golden-ratio frame offset decorrelates it frame to frame.
float ign(vec2 p) {
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
}

vec3 rotateY(vec3 p, float a) {
    float c = cos(a), s = sin(a);
    return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
}

// ── Wind advection (mirrors cloud-time.js tangentFrame / advectDirection) ───
// Local east / north at unit direction n in the Earth-fixed frame (spin axis
// +Y, lon 0 at +X, 90°E at −Z — js/geo/coords.js). Displace UPSTREAM by the
// wind for dtSec: the material at n now was at the returned direction dtSec
// ago. First-order semi-Lagrangian; the leads are clamped on the JS side.
vec3 advectDir(vec3 n, vec2 wind, float dtSec, float gain) {
    vec3  east = vec3(n.z, 0.0, -n.x);
    float el   = length(east);
    east = el < 1e-6 ? vec3(1.0, 0.0, 0.0) : east / el;
    vec3  north = cross(n, east);
    float k = dtSec * gain * u_flow_gain / R_EARTH_M_C;
    return normalize(n - (east * wind.x + north * wind.y) * k);
}

// Surface → aloft wind gain (cloud-time.js windGainAt).
float windGain(float altKm) {
    float x = clamp(altKm / WIND_GAIN_TOP_KM, 0.0, 1.0);
    return 1.0 + WIND_GAIN_ALOFT * x * x * (3.0 - 2.0 * x);
}

vec2 windAt(vec2 uv) {
    return (texture2D(u_wind, uv).rg * 2.0 - 1.0) * u_wind_max;
}

// ── Ray/sphere ───────────────────────────────────────────────────────────────
// Origin-centred sphere of radius R. Returns (tNear, tFar); tFar < 0 or
// tFar < tNear means "no useful hit". Kept branch-free — it is called up to
// four times per fragment before any march decision is made.
vec2 raySphere(vec3 ro, vec3 rd, float R) {
    float b = dot(ro, rd);
    float c = dot(ro, ro) - R * R;
    float disc = b * b - c;
    if (disc < 0.0) return vec2(1.0, -1.0);
    float s = sqrt(disc);
    return vec2(-b - s, -b + s);
}

// Real altitude (km) at a world radius, undoing the exaggeration. Every
// physical decision below is made in KILOMETRES, never in globe radii, so
// the ramp can move the geometry without changing a single cloud's shape.
float altitudeKm(float r) {
    return (r - R_CLEAR_C) * R_EARTH_KM_C / max(u_exag, 0.0001);
}

// Soft vertical membership of a deck [base, top]: 1 through the middle,
// easing out over the outer 35% so decks blend instead of stacking as slabs.
float deckProfile(float altKm, float base, float top) {
    // NB: 'half' is a GLSL reserved word — do not shorten halfSpan back to it.
    float mid     = 0.5 * (base + top);
    float halfSpan = max(0.5 * (top - base), 0.001);
    float d       = abs(altKm - mid) / halfSpan;
    return 1.0 - smoothstep(0.65, 1.0, d);
}

// ── Column properties ────────────────────────────────────────────────────────
// Everything that depends only on WHERE ON THE GLOBE the sample is (not how
// high). Sampled per march step, but all taps are on smoothly-upsampled
// coarse fields so the cost is texture bandwidth, not detail.
struct Column {
    float covLow;
    float covMid;
    float covHigh;
    float precip;
    float topKm;      // observed cloud-top height, < 0 when no IR estimate
    float conf;       // satellite observation confidence (× mode weight)
    vec2  wind;       // 10 m wind, m/s east/north — drives every advection
};

Column columnAt(vec3 nObj) {
    Column c;
    vec2 uv   = normalToUV(nObj);
    vec4 cl   = texture2D(u_cloud_layers, uv);
    float g   = clamp(u_cloud_data_strength * 2.0, 0.0, 1.0);
    // Data-GATED coverage, lockstep with CLOUD_FRAG: a clear grid cell must
    // read as clear. A base floor here is what made the old globe
    // permanently half-overcast.
    c.covLow  = mix(0.55, mix(0.02, 1.00, cl.r), g);
    c.covMid  = mix(0.40, mix(0.02, 0.95, cl.g), g);
    c.covHigh = mix(0.30, mix(0.01, 0.90, cl.b), g);
    c.precip  = cl.a;
    c.topKm   = -1.0;
    c.conf    = 0.0;
    c.wind    = windAt(uv);

    if (u_satellite_on > 0.5 && u_sat_weight > 0.001) {
        // The observed frame is sampled UPSTREAM of the sample point by the
        // lead × wind: a frame stands in for an instant it was not taken
        // at, and the cloud that is here now was there then. The same tap
        // with an hours-long lead is the nowcast (see header).
        vec3 nSat = advectDir(nObj, c.wind, u_sat_lead, SAT_WIND_GAIN);
        vec4 sat  = texture2D(u_satellite, normalToUV(nSat));
        if (u_sat_blend > 0.001) {
            vec3 nPrev = advectDir(nObj, c.wind, u_sat_prev_lead, SAT_WIND_GAIN);
            sat = mix(sat, texture2D(u_sat_prev, normalToUV(nPrev)), u_sat_blend);
        }
        c.conf   = sat.a * u_sat_weight;
        float satShape = smoothstep(0.14, 0.86, sat.r);
        // The mosaic is the dominant coverage signal where it actually saw
        // the pixel; the feathered alpha keeps the handoff a gradient.
        float infl = c.conf * 0.85;
        c.covLow  = mix(c.covLow,  satShape,        infl);
        c.covMid  = mix(c.covMid,  satShape * 0.85, infl * 0.8);
        c.covHigh = mix(c.covHigh, satShape * 0.70, infl * 0.7);

        // IR cloud-top height → the column's real top. Keep the
        // 26.85 − b·105 ramp in lockstep with IR_BT_WARM_K / IR_BT_COLD_K
        // in cloud-mosaic-core.js and with CLOUD_FRAG's copy.
        if (sat.b > 0.02) {
            float t2mC = texture2D(u_weather, uv).r * 110.0 - 60.0;
            float btC  = 26.85 - sat.b * 105.0;
            c.topKm    = clamp((t2mC - btC) / 6.5, 0.0, 17.0);
        }
    }
    return c;
}

// ── Density ──────────────────────────────────────────────────────────────────
// The 'cheap' flag skips the detail octaves — used by the light march and by the
// empty-space skip, where only "is there anything here" matters. This split
// is the difference between ~48 and ~300 noise evaluations per pixel.
float densityAt(vec3 pWorld, Column col, bool cheap) {
    float r     = length(pWorld);
    float altKm = altitudeKm(r);
    if (altKm < VOL_BASE_KM || altKm > VOL_TOP_KM) return 0.0;

    // Vertical coverage: each deck contributes over its own extent.
    float pLow  = deckProfile(altKm, LOW_BASE_KM,  LOW_TOP_KM);
    float pMid  = deckProfile(altKm, MID_BASE_KM,  MID_TOP_KM);
    float pHigh = deckProfile(altKm, HIGH_BASE_KM, HIGH_TOP_KM);
    float cov   = col.covLow * pLow + col.covMid * pMid + col.covHigh * pHigh;

    // Deep convection: where rain is falling, bridge the gap between the low
    // and mid decks so a storm renders as ONE tower rather than two
    // disconnected sheets. This is the volumetric form of CLOUD_FRAG's
    // precip→cloud coupling, and it exists for the same reason: the decks
    // are separate channels but the storm is one object.
    float wet = smoothstep(0.02, 0.30, col.precip);
    if (wet > 0.0) {
        float bridge = deckProfile(altKm, LOW_BASE_KM, MID_TOP_KM);
        cov = max(cov, bridge * wet * 0.95);
    }

    // Observed top: hard-cap the column at the IR cloud-top height, and let
    // it BUILD up to that height. Confidence-weighted, so a feathered disc
    // edge relaxes back to the model's nominal decks instead of snapping.
    if (col.topKm > 0.0) {
        float capped = 1.0 - smoothstep(col.topKm - 0.9, col.topKm + 0.35, altKm);
        cov = mix(cov, cov * capped, col.conf);
        // Tall observed tops thicken the column they belong to — this is the
        // anvil, and it is measured, not invented.
        float anvil = smoothstep(7.0, 13.0, col.topKm) * col.conf;
        cov += anvil * deckProfile(altKm, col.topKm - 3.0, col.topKm) * 0.35;
    }

    cov = clamp(cov, 0.0, 1.0);
    if (cov <= 0.001) return 0.0;

    // Within-deck vertical density gradient: thin at the base, dense toward
    // the top. This is what gives cumulus a flat dark bottom and a piled
    // bright crown instead of a symmetric blob.
    float hFrac = clamp((altKm - VOL_BASE_KM) / (VOL_TOP_KM - VOL_BASE_KM), 0.0, 1.0);
    float grad  = smoothstep(0.0, 0.09, hFrac) * (1.0 - smoothstep(0.55, 1.0, hFrac));
    // Cirrus is a veil, not a mass — flatten its gradient so it doesn't get a
    // cumulus crown.
    grad = mix(grad, 0.55, clamp(pHigh, 0.0, 1.0));

    // Sampling direction in the Earth-fixed frame. Noise rides the SPHERE,
    // never equirectangular UV — that is what keeps the poles free of the
    // UV-stretch smear the decal shader had to fix the same way.
    vec3 nObj = rotateY(pWorld / r, -u_earth_rot);

    // FLOW MAP: two copies of the noise field, each displaced upstream by
    // its phase × period × wind (stronger aloft), cross-faded by u_flow.z.
    // Layer A resets at phase 0 under full B weight and vice versa, so the
    // domain distortion stays bounded and neither reset is visible. The
    // morph (z-drift) is per sim-second — see the header for the rate.
    float gainA = windGain(altKm);
    float drift = u_sim_time * MORPH_RATE * (1.0 + hFrac * 1.6);
    vec3  qA = advectDir(nObj, col.wind, u_flow.x, gainA) * 22.0 + vec3(0.0, 0.0, drift);
    vec3  qB = advectDir(nObj, col.wind, u_flow.y, gainA) * 22.0 + vec3(0.0, 0.0, drift);
    // Vertical detail is sampled in REAL km so the noise cell shape is
    // physical — without this the exaggeration stretches every cloud
    // vertically as the ramp climbs, and the whole stack smears on zoom.
    qA.y += altKm * 0.42;
    qB.y += altKm * 0.42;

    // DOMAIN WARP — not optional. Value noise on a cubic-interpolated lattice
    // leaves axis-aligned straight edges, and the coverage threshold below
    // turns those into hard rectangular blobs: the globe came back looking
    // tiled rather than cloudy. CLOUD_FRAG hit the same wall and fixed it the
    // same way (see its warpedFbm3 note about "horizontal strips"). One octave
    // per axis is enough to decorrelate the lattice and is a third the cost of
    // warping with full FBM.
    //
    // Evaluated ONCE, at the un-advected point, and applied to both flow
    // layers: the warp's job is to break the lattice, which a static
    // large-scale distortion does just as well, and warping per layer would
    // double the most expensive taps in the shader.
    //
    // Applied on BOTH the cheap and detailed paths on purpose: the light march
    // uses the cheap one, and if the two disagree about where a cloud IS, the
    // self-shadowing lands next to the cloud casting it.
    vec3 q0 = nObj * 22.0 + vec3(0.0, 0.0, drift);
    q0.y += altKm * 0.42;
    vec3 warp = vec3(
        vnoise3(q0 * 0.55 + vec3( 17.3, -3.1,  0.0)),
        vnoise3(q0 * 0.55 + vec3( -9.6, 12.4,  5.2)),
        vnoise3(q0 * 0.55 + vec3(  4.2,  7.8, -8.1))
    ) - 0.5;
    qA += warp * 1.35;
    qB += warp * 1.35;

    // u_flow.z is a UNIFORM, so this branch is coherent: a layer at (almost)
    // zero weight is simply not evaluated.
    int   oct   = cheap ? 2 : 4;
    float shape;
    if      (u_flow.z < 0.01) shape = fbm3(qA, oct);
    else if (u_flow.z > 0.99) shape = fbm3(qB, oct);
    else                      shape = mix(fbm3(qA, oct), fbm3(qB, oct), u_flow.z);

    // Coverage-thresholded remap: as cov → 1 the threshold → 0 and the
    // column fills. Standard, and the reason clear cells read as truly clear.
    float d = clamp((shape - (1.0 - cov)) / max(cov, 0.001), 0.0, 1.0);
    d *= grad;
    // Hard cut on the bottom of the density range. Densities of a few
    // thousandths contribute nothing individually but accumulate over ~48
    // steps into a uniform grey veil across the whole globe — the same haze
    // the decal shader's base-coverage floor produced, arriving by a
    // different route. Clear air has to integrate to exactly zero.
    d = max(0.0, d - 0.035) * 1.036;

    if (!cheap && d > 0.0) {
        // Edge erosion: high-frequency detail bites into the boundary only,
        // which is where real clouds are wispy. Applying it everywhere just
        // lowers the mean density and brings back the haze. The detail rides
        // layer A's advected frame so it streams with the cloud it erodes.
        float det  = fbm3(qA * 4.3 + vec3(11.7, 3.1, 0.0), 2);
        float edge = 1.0 - smoothstep(0.0, 0.30, d);
        d = clamp(d - det * edge * 0.42, 0.0, 1.0);
    }
    return d * u_density;
}

// ── Extinction scale ─────────────────────────────────────────────────────────
// Optical depth must be a property of the CLOUD, not of how far the
// exaggeration ramp has stretched the shell it is drawn in. Scaling by the
// shell thickness keeps a given density at a fixed optical depth as the ramp
// fans the column from 0.022 R out to 0.12 R — without this, zooming in
// silently thickens every cloud into a white wall.
//
// 55 is calibrated so a fully-covered deck reaches optical depth ~18 through
// a vertical column: solidly opaque, which is what overcast is.
float sigmaScale() {
    return u_density * 55.0 / max(u_r_top - u_r_base, 1e-5);
}

// ── Phase function ───────────────────────────────────────────────────────────
// Dual-lobe Henyey-Greenstein: a strong forward lobe (the silver lining when
// you look toward the sun) plus a weak back lobe (the glow when it is behind
// you). Normalised so that ISOTROPIC == 1 (the 4π cancels the 1/4π in hg),
// which is what makes the radiance below land in [0,1] without a fudge
// factor. 'ani' scales both lobes toward isotropic for the multiple-scattering
// orders.
float hg(float cosT, float g) {
    float g2 = g * g;
    float d  = 1.0 + g2 - 2.0 * g * cosT;
    return (1.0 - g2) / (12.566370614 * d * sqrt(max(d, 1e-4)));
}
float phaseTwoLobe(float cosT, float ani) {
    return mix(hg(cosT, 0.80 * ani), hg(cosT, -0.30 * ani), 0.28) * 12.566370614;
}

// Multiple-scattering approximation (the standard Wrenninge octave trick):
// approximate each successive scattering order with less extinction and a
// flatter phase, reusing the ONE light-march result. This is not a
// refinement — it is the difference between a cloud and a smudge. Single
// scattering alone is always far too dark, because almost every photon that
// reaches your eye from a real cloud has bounced many times; without these
// orders you get exactly the flat grey the decal shader was already stuck at.
vec3 msScatter(float lt, float cosT, vec3 sunCol) {
    vec3 sum = vec3(0.0);
    float att = 1.0;   // energy remaining in this order
    float ext = 1.0;   // extinction exponent
    float ani = 1.0;   // phase anisotropy
    for (int k = 0; k < 3; k++) {
        sum += att * sunCol * pow(max(lt, 1e-5), ext) * phaseTwoLobe(cosT, ani);
        att *= 0.52;
        ext *= 0.55;
        ani *= 0.60;
    }
    return sum;
}

// Planet shadow with a penumbra. A hard raySphere test gives a razor-sharp
// terminator, which is wrong twice over: the Sun is a 0.53 deg disc, not a
// point, and the atmosphere refracts and scatters light well past the
// geometric line. Both smear the shadow edge over roughly a hundred km.
//
// Cheaper than the intersection test it replaces: the shadow of an
// origin-centred sphere is a cylinder, so "am I in it" is one dot product
// (are we anti-sunward at all) plus one perpendicular distance.
float planetShadow(vec3 p) {
    float along = dot(p, u_sun_dir);
    if (along > 0.0) return 1.0;                 // sunward hemisphere
    float perp = length(p - u_sun_dir * along);
    return smoothstep(u_r_surface * 0.994, u_r_surface * 1.022, perp);
}

// Transmittance of sunlight arriving at p: planet shadow first (cheap), then
// a short march through the medium.
float lightTransmittance(vec3 p, Column col) {
    float shadow = planetShadow(p);
    if (shadow <= 0.001) return 0.0;

    vec2 hitTop = raySphere(p, u_sun_dir, u_r_top);
    float span  = max(hitTop.y, 0.0);
    if (span <= 0.0) return shadow;

    int   n  = u_light_steps;
    float dt = span / float(n);
    float tau = 0.0;
    float t   = dt * 0.5;
    for (int i = 0; i < ${MAX_LIGHT_STEPS}; i++) {
        if (i >= n) break;
        vec3 sp = p + u_sun_dir * t;
        // Cheap density: the light march only needs bulk opacity, and the
        // detail octaves cost more here than anywhere (n× per primary step).
        tau += densityAt(sp, col, true) * dt;
        // Geometric step growth — the far end of a light ray contributes
        // little and does not deserve uniform sampling.
        t  += dt;
        dt *= 1.35;
    }
    return exp(-tau * sigmaScale()) * shadow;
}

void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorldPos - cameraPosition);

    // ── Establish the march interval ────────────────────────────────────────
    vec2 hTop  = raySphere(ro, rd, u_r_top);
    if (hTop.y <= 0.0) discard;                 // ray never reaches the shell
    vec2 hBase = raySphere(ro, rd, u_r_base);
    vec2 hSurf = raySphere(ro, rd, u_r_surface);

    float tEnter = max(hTop.x, 0.0);            // 0 when the camera is inside
    float tExit  = hTop.y;

    // The planet is opaque: stop at the ground.
    if (hSurf.y > 0.0 && hSurf.x > 0.0) tExit = min(tExit, hSurf.x);
    // Below the volume base there is nothing to integrate; a ray that enters
    // the inner sphere and comes back out (a grazing chord) is handled by the
    // per-sample altitude test rather than by splitting the interval in two,
    // which would double the loop for a case that contributes almost nothing.
    if (hBase.x > 0.0 && hSurf.x <= 0.0) tExit = min(tExit, hBase.x);

    if (tExit <= tEnter) discard;

    int   n      = u_steps;
    float span   = tExit - tEnter;
    float dt     = span / float(n);

    // Interleaved-gradient jitter on the start offset. Without it a 48-step
    // march across a 0.02 R shell bands visibly into concentric rings; with
    // it the banding becomes per-pixel noise the bloom pass swallows. The
    // golden-ratio frame offset keeps the pattern from sitting still.
    float jitter = fract(ign(gl_FragCoord.xy) + u_frame * 0.61803398875);

    vec3  scattered    = vec3(0.0);
    float transmittance = 1.0;
    float t = tEnter + dt * jitter;

    float cosT  = dot(rd, u_sun_dir);
    float sigK  = sigmaScale();

    // Light transmittance is evaluated on ALTERNATE steps and reused: it is
    // the dominant cost (light steps × density evaluations per primary step)
    // and it varies slowly along the ray. A step that finds density after an
    // empty one re-evaluates regardless, so a cloud edge is never lit with a
    // stale value from clear air.
    float lt      = 1.0;
    bool  ltValid = false;

    for (int i = 0; i < ${MAX_PRIMARY_STEPS}; i++) {
        if (i >= n || transmittance < 0.012) break;

        vec3  p    = ro + rd * t;
        float r    = length(p);
        vec3  nObj = rotateY(p / r, -u_earth_rot);
        Column col = columnAt(nObj);

        float d = densityAt(p, col, false);
        if (d > 0.002) {
            float sigma = d * sigK;
            if (!ltValid || mod(float(i), 2.0) < 0.5) {
                lt = lightTransmittance(p, col);
                ltValid = true;
            }

            // Sun colour reddens through the long slant path near the
            // terminator — the same reason a real sunset is orange. Driven by
            // the local solar elevation, so it tracks the shadow line exactly.
            float sunEl = dot(p / r, u_sun_dir);
            vec3  sunCol = mix(vec3(1.00, 0.52, 0.24), vec3(1.00, 0.97, 0.93),
                               smoothstep(-0.02, 0.28, sunEl));

            // Powder / dark-edge term: an approximation of the multiple
            // scattering that makes cloud EDGES darker than their interiors
            // when lit from behind the viewer. Without it thin edges read as
            // uniformly bright and the whole field flattens.
            float powder = 1.0 - exp(-d * 14.0);
            powder = mix(1.0, powder, clamp(cosT * 0.5 + 0.5, 0.0, 1.0));

            // Sky ambient: bright from above, dim and blue from below, so
            // undersides fill with sky rather than going black.
            float up  = clamp(altitudeKm(r) / VOL_TOP_KM, 0.0, 1.0);
            vec3 ambient = mix(vec3(0.13, 0.17, 0.26), vec3(0.42, 0.50, 0.64), up);
            // Ambient must also die on the night side or the dark hemisphere
            // glows with daylight sky — but NOT to zero. A night cloud is a
            // dim blue silhouette (moonlight, airglow, and city light from
            // underneath), not a hole in the planet: at floor 0 the whole
            // dark hemisphere rendered as a black cut-out wherever it was
            // overcast, which reads as a rendering failure rather than as
            // night. The floor is deliberately low enough that the terminator
            // still reads as a terminator.
            ambient *= clamp(sunEl * 1.6 + 0.36, 0.11, 1.0);

            vec3 S = msScatter(lt, cosT, sunCol) * powder + ambient;

            // Energy-conserving integration of a constant-density step:
            // ∫ S·T dt over the step, in closed form. Summing S·T·dt instead
            // makes the result step-count dependent, so a governor tier flip
            // would visibly change cloud brightness.
            float Tstep = exp(-sigma * dt);
            scattered += transmittance * S * (1.0 - Tstep);
            transmittance *= Tstep;
        } else {
            ltValid = false;
        }
        t += dt;
    }

    float alpha = clamp(1.0 - transmittance, 0.0, 1.0);
    if (alpha < 0.002) discard;
    // 'scattered' is already transmittance-weighted along the ray, i.e. it is
    // PREMULTIPLIED radiance. The material blends with (ONE,
    // ONE_MINUS_SRC_ALPHA) for exactly this reason — standard
    // (SRC_ALPHA, ONE_MINUS_SRC_ALPHA) would multiply by alpha a second time
    // and halve every cloud's brightness.
    gl_FragColor = vec4(scattered, alpha);
}`;

/** A 1×1 "calm" wind texture (U = V = 0) so the shader never advects by the
 *  −u_wind_max a black default would decode to. */
export function createNeutralWindTexture() {
    const tex = new THREE.DataTexture(new Uint8Array([128, 128, 0, 255]), 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    return tex;
}

/**
 * Uniform block. Shares the SAME uniform entry objects as the decal shader
 * for every input both consume (`Object.assign` in earth.html copies the
 * references), so one `cloudU.u_x.value = …` write still reaches both paths
 * and the fallback can never render stale data.
 */
export function createVolumeUniforms(sunDir = new THREE.Vector3(1, 0, 0)) {
    const ladder = marchLadder(1);
    const neutralWind = createNeutralWindTexture();
    return {
        u_cloud_layers: { value: null },
        u_satellite:    { value: null },
        u_sat_prev:     { value: null },
        u_weather:      { value: null },
        u_wind:         { value: neutralWind },
        u_sun_dir:      { value: sunDir },
        u_earth_rot:    { value: 0 },
        u_sim_time:     { value: 0 },
        u_flow:         { value: new THREE.Vector3(0, FLOW.periodSec * 0.5, 1) },
        u_flow_gain:    { value: 1 },
        u_wind_max:     { value: 60 },
        u_sat_lead:     { value: 0 },
        u_sat_prev_lead: { value: 0 },
        u_sat_blend:    { value: 0 },
        u_sat_weight:   { value: 1 },
        u_frame:        { value: 0 },
        u_exag:         { value: 10 },
        u_r_base:       { value: 1.0031 },
        u_r_top:        { value: 1.025 },
        u_r_surface:    { value: 1.0 },
        u_satellite_on: { value: 0 },
        u_cloud_data_strength: { value: 0.5 },
        // Optical-depth scale. Tuned so a fully-covered low deck reads as
        // solid overcast without the limb going to a white wall; exposed as a
        // knob because it is the one number that trades "dramatic" against
        // "washed out" and it will want retuning against real mosaics.
        u_density:      { value: 1.0 },
        u_steps:        { value: ladder.primary },
        u_light_steps:  { value: ladder.light },
    };
}

/**
 * Per-frame timing write: sim seconds → u_sim_time + the flow-map phases.
 * One place, so the shader's u_flow can never disagree with the kernel.
 * @param {object} uniforms   from createVolumeUniforms (or any sharing u_flow)
 * @param {number} simSec     simulation seconds relative to the page epoch
 */
export function writeFlowUniforms(uniforms, simSec) {
    const ph = flowPhase(simSec, FLOW.periodSec);
    uniforms.u_sim_time.value = simSec;
    uniforms.u_flow.value.set(ph.p0 * FLOW.periodSec, ph.p1 * FLOW.periodSec, ph.w);
}

/**
 * Build the carrier mesh. Radius-1 sphere: the caller scales it to track the
 * volume top as the exaggeration ramp moves (one `setScalar` per frame),
 * which is why nothing here bakes a radius into the geometry.
 */
export function createVolumeMesh(uniforms) {
    const geo = new THREE.IcosahedronGeometry(1, 4);
    const mat = new THREE.ShaderMaterial({
        vertexShader: VOLUME_VERT,
        fragmentShader: VOLUME_FRAG,
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: false,       // the march owns its own occlusion — see header
        side: THREE.BackSide,   // works from outside AND inside the volume
        // PREMULTIPLIED alpha: the march returns radiance already weighted by
        // transmittance. Do not "simplify" this back to NormalBlending — that
        // applies alpha twice and the clouds come out half-lit and grey.
        blending: THREE.CustomBlending,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;   // the camera can sit inside it
    return mesh;
}

// ── Half-resolution compositor ───────────────────────────────────────────────

const COMPOSITE_VERT = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */`
precision mediump float;
uniform sampler2D u_tex;
varying vec2 vUv;
void main() {
    // Premultiplied radiance straight through — the blend state on the
    // material composites it exactly as the carrier mesh's did.
    gl_FragColor = texture2D(u_tex, vUv);
}`;

/**
 * Renders the volumetric carrier mesh into an offscreen target at a fraction
 * of the drawing-buffer resolution and composites it into the main scene
 * through a screen quad with the SAME premultiplied blend. See the header's
 * COST section. The mesh lives in the compositor's private scene; the quad
 * goes in the page scene where the mesh used to be.
 *
 *   const vc = new VolumeCompositor(renderer, cloudVolumeMesh, { scale: 0.5 });
 *   scene.add(vc.quad);
 *   … per frame, before the main render: if (mesh.visible) vc.render(renderer, camera);
 *
 * The target is HalfFloat where the context can render to it (WebGL2 with
 * EXT_color_buffer_(half_)float) so the march's HDR radiance survives into
 * the ACES/bloom chain unclamped; otherwise 8-bit, which merely caps the
 * brightest sunlit tops at 1.0 before the tonemap.
 */
export class VolumeCompositor {
    constructor(renderer, mesh, { scale = 0.5 } = {}) {
        this.scene = new THREE.Scene();
        this.scene.add(mesh);
        this.mesh  = mesh;
        this.scale = 1;
        this.setScale(scale);

        const gl2 = renderer.capabilities.isWebGL2;
        const canHalf = gl2 && (renderer.extensions.has('EXT_color_buffer_float')
                              || renderer.extensions.has('EXT_color_buffer_half_float'));
        this.hdr = canHalf;
        this.rt = new THREE.WebGLRenderTarget(2, 2, {
            type:            canHalf ? THREE.HalfFloatType : THREE.UnsignedByteType,
            format:          THREE.RGBAFormat,
            minFilter:       THREE.LinearFilter,
            magFilter:       THREE.LinearFilter,
            depthBuffer:     false,
            stencilBuffer:   false,
            generateMipmaps: false,
        });

        const mat = new THREE.ShaderMaterial({
            vertexShader:   COMPOSITE_VERT,
            fragmentShader: COMPOSITE_FRAG,
            uniforms:       { u_tex: { value: this.rt.texture } },
            transparent:    true,
            depthWrite:     false,
            depthTest:      false,
            blending:       THREE.CustomBlending,
            blendSrc:       THREE.OneFactor,
            blendDst:       THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha:  THREE.OneFactor,
            blendDstAlpha:  THREE.OneMinusSrcAlphaFactor,
        });
        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
        this.quad.frustumCulled = false;
        this.quad.visible = false;

        this._size  = new THREE.Vector2();
        this._clear = new THREE.Color();
    }

    /** Resolution fraction of the drawing buffer, clamped to [0.25, 1]. */
    setScale(s) {
        const v = Number(s);
        this.scale = Number.isFinite(v) ? Math.max(0.25, Math.min(1, v)) : 0.5;
        return this.scale;
    }

    /** Current target size in device pixels (for probes / tests). */
    get targetSize() { return { width: this.rt.width, height: this.rt.height }; }

    render(renderer, camera) {
        renderer.getDrawingBufferSize(this._size);
        const w = Math.max(1, Math.round(this._size.x * this.scale));
        const h = Math.max(1, Math.round(this._size.y * this.scale));
        if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);

        const prevTarget = renderer.getRenderTarget();
        const prevAuto   = renderer.autoClear;
        renderer.getClearColor(this._clear);
        const prevAlpha  = renderer.getClearAlpha();

        renderer.setRenderTarget(this.rt);
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = false;
        renderer.clear(true, false, false);
        renderer.render(this.scene, camera);

        renderer.setRenderTarget(prevTarget);
        renderer.setClearColor(this._clear, prevAlpha);
        renderer.autoClear = prevAuto;
    }

    dispose() {
        this.rt.dispose();
        this.quad.geometry.dispose();
        this.quad.material.dispose();
    }
}
