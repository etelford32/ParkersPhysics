/**
 * upper-atmosphere-globe.js — 3D Earth + atmosphere-shell visualisation
 * ═══════════════════════════════════════════════════════════════════════════
 * Three.js scene for the upper-atmosphere page. Uses the shared EarthSkin
 * class from earth-skin.js so the planet matches earth.html / space-
 * weather.html exactly — day/night mask, ocean specular, topology,
 * atmosphere rim glow, aurora shader.
 *
 * Layers (Earth radius = 1.0):
 *   • EarthSkin.earthMesh                         surface, clouds off
 *   • EarthSkin atmosphere rim                    1.026 R⊕ (provided by skin)
 *   • volumetric shells × 5 (mesosphere → outer exosphere)
 *                                                  ray-march shader: each
 *                                                  shell mesh is a sphere at
 *                                                  the layer's outer radius;
 *                                                  fragment shader integrates
 *                                                  the view ray's segment
 *                                                  *inside* the shell volume
 *                                                  (between inner & outer
 *                                                  radii, capped by planet)
 *                                                  and shades by path length
 *                                                  → real sphere sheets with
 *                                                  visible depth, not 2-D
 *                                                  limb rings
 *   • satellite rings at ISS/HST/Starlink/…       colored tori
 *   • altitude ring   at the user's current alt   cyan, tracks slider
 *   • star backdrop
 *
 * Aurora intensity follows the current Ap — stronger geomagnetic
 * forcing lights up the auroral oval via the EARTH_FRAG shader.
 *
 * Export:
 *   AtmosphereGlobe
 *     new AtmosphereGlobe(canvas, opts)
 *     setProfile(profile)                         per-shell ρ
 *     setAltitude(altitudeKm)                     move the cyan ring
 *     setState({ f107, ap })                      drive aurora + rim
 *     setVisibility({ satellites, shells })       toggle overlays
 *     dispose()
 */

import * as THREE from 'three';
import { EarthSkin } from './earth-skin.js';
import { SATELLITE_REFERENCES, density, fetchDebrisSample, fetchDebrisByEvent }
    from './upper-atmosphere-engine.js';
import { annotate as annotateDebris, summariseByFamily, DEBRIS_FAMILIES }
    from './debris-catalog.js';
import { CONSTELLATIONS, spawnConstellationPositions }
    from './constellation-catalog.js';
import { buildSatelliteModel, buildSatelliteModelLow }
    from './satellite-models.js';
import { computeShue, computeBowShock } from './magnetosphere-engine.js';
import { ATMOSPHERIC_LAYER_SCHEMA, layerForAltitude }
    from './upper-atmosphere-layers.js';
// Continuous volumetric atmosphere. This is the DEFAULT render of the
// 80-2000 km column; the five gradient shells below stay as the A/B
// reference and the low-end fallback. Both paths are live — see
// setAtmosphereRender().
import { AtmosphereVolume, VOLUME_QUALITY }
    from './upper-atmosphere-volume.js';
import { LayerParticleSystem } from './upper-atmosphere-particles.js';
import { capPointSize, roundDotTexture } from './upper-atmosphere-point-cap.js';
import {
    meanElements, ringSample, orbitRingInertialScene, ringToSegments, ringRotationY,
    gmstRad as suiteGmstRad, altitudeLadder, outerShellKm, framingDistance, FRAME_PRESETS,
    orbitRegime, perifocalTable, inertialSceneAt,
} from './upper-atmosphere-sat-suites.js';
import {
    TRACKER_EARTH_RADIUS, catalogAltToScene, catalogToPageAltKm, sceneToPageAltKm,
    pageAltToScene, PAGE_RE_KM,
} from './upper-atmosphere-datum.js';
import { layerPhysics, pointPhysics } from './upper-atmosphere-physics.js';
import { LayerVectorField } from './upper-atmosphere-vector-fields.js';
import { ZoneWaveField } from './upper-atmosphere-wave-field.js';
import { DragForecastOverlay } from './drag-forecast-overlay.js';
import { FleetRibbons } from './upper-atmosphere-fleet-ribbons.js';
import { MagneticCascade } from './upper-atmosphere-magnetic-cascade.js';
import { SubstormController } from './upper-atmosphere-substorm.js';
// Phase B (time-bus integration): the globe pulls simTimeMs from this
// shared singleton instead of its own THREE.Clock + rate multiplier.
// Sat + debris propagation read absolute time from the bus, so future
// scrubbing / replay work just sets bus.simTimeMs and everything
// follows.
import { getTimeBus } from './upper-atmosphere-time-bus.js';
import { CameraController } from './upper-atmosphere-camera.js';
import { subSolarPoint, greenwichSiderealDeg } from './sun-altitude.js';
import { geoFromVectors, latLonToScene, sceneToLatLon } from './upper-atmosphere-column.js';
import {
    gwPhases, airglowFieldAt, redFactorAt, redLineRegime, sarArc, brightestEveningArc,
} from './upper-atmosphere-airglow-field.js';
// The plasma (TEC) field and its driver: ring-current-efield's shielding
// model (Kp + solar-wind VBs → penetration ΔA into the shared fountain, the
// teardrop plasmapause into the trough and the SAR arcs) and the TIDs.
import { IonosphereDriver, plasmaFieldAt as plasmaKernelAt, vtec, mltAt } from './upper-atmosphere-plasma-field.js';
import { tidPhases } from './upper-atmosphere-tid.js';
// On-canvas analysis overlay (altitude ruler · limb probe · diurnal
// compass). Deliberately three-free — it takes geometry through the
// hooks below and its physics from the node-tested kernel.
import { AtmosphereInstruments } from './upper-atmosphere-instruments.js';
// Flight dynamics: the PURE kernel integrates, the layer draws. The globe
// only builds the density sampler from its own (F10.7, Ap) state and
// hands out the kernel's launch helpers — it computes no physics itself.
import {
    Flight, createDensitySampler, flightOptionsFromPreset, presetById,
    launchState, tleEpochMs,
} from './upper-atmosphere-flight.js';
import { FlightLayer } from './upper-atmosphere-flight-layer.js';
// Layer transit: the camera rides the local vertical through the band and a
// camera-local gas cloud is re-sampled from the engine at its altitude.
import { AtmosphereTransit } from './upper-atmosphere-transit.js';
import { ExploreLayer } from './upper-atmosphere-explore.js';
// The operational altitude bands (entry interface → top of LEO): the
// PURE table + the analytic limb-ring pass that draws it as a ruler.
import { OpsBandsLayer } from './upper-atmosphere-ops-bands-layer.js';
import { bandForAltitude as opsBandForAltitude } from './upper-atmosphere-ops-bands.js';
import { frameClock } from './upper-atmosphere-frame-clock.js';
import {
    divePath, climbPath, EXPLORE, describeState, orbitalSpeedKmS, compass8, pointsOfInterest,
} from './upper-atmosphere-explore-model.js';
// The camera rig's PURE math: limb views, lens, pivot moves.
import { limbSites, limbViewPose, describeRig } from './upper-atmosphere-camera-rig.js';
import { ATMOSPHERIC_LAYER_BY_ID } from './upper-atmosphere-layers.js';
// The incoming CME's frame + camera stations (PURE, small); the layer itself
// (and the flux-rope provider + WASM behind it) loads only on first enable.
import { CME_VIEW, cmeViewPose, ropeBasisScene, eclipticNorthScene } from './upper-atmosphere-cme-model.js';

// Map (sub-solar lat, sub-solar lon) → unit Vector3 in the scene's world
// frame. THE ONE CONVENTION is the kernel's `latLonToScene` — the site's
// canonical Earth-fixed frame (+X = Greenwich, +Y = north, −Z = 90°E),
// which is what the EarthSkin texture is drawn in. This function used to
// carry its own trig with z = +cos·sin(lon), the MIRROR of the texture's
// frame, so the terminator sat at −lon over the continents (noon over India
// at 18 UTC) for the page's whole life. See the kernel's header note.
function _subSolarToVec3(latDeg, lonDeg) {
    const [x, y, z] = latLonToScene(latDeg, lonDeg);
    return new THREE.Vector3(x, y, z);
}

// NOAA SWPC Kp→Ap table, used to invert Ap back to Kp for the aurora
// shader. The shader's own oval-geometry code wants Kp, not Ap.
const _KP_TO_AP = [0, 3, 7, 15, 27, 48, 80, 140, 240, 400];

function apToKp(ap) {
    if (!Number.isFinite(ap) || ap <= 0) return 0;
    for (let i = 0; i < _KP_TO_AP.length - 1; i++) {
        const a = _KP_TO_AP[i], b = _KP_TO_AP[i + 1];
        if (ap < b) return i + (ap - a) / (b - a);
    }
    return 9;
}

const R_EARTH_KM = 6371;

// Camera-to-probe distance (R⊕) at which a far-tier probe marker is drawn
// at its built size. The default view (camera at ~3.2 R⊕) never comes
// closer than ~2.13 to a LEO probe (see the LOD thresholds in
// _buildSatelliteProbe), so from there every marker is untouched; closer
// than this a marker holds that angular size (~0.7°), so a transit or
// chase camera sees a dot, not a moon.
const PROBE_MARKER_REF_RUNIT = 2.0;

// The planet's icosphere detail. three's `detail` is LINEAR: 5 was 720
// faces with ~10.6° edges whose chords sag 27 km below the sphere — a
// polygon horizon from a layer transit, where the horizon is ~10° away.
// 40 gives 1.55° edges and a 0.58 km sag, invisible from the 80 km floor.
const EARTH_ICO_DETAIL = 40;

// ── Gradient layer shells ──────────────────────────────────────────────────
// Five concentric translucent shells, one per physical regime the page
// distinguishes within the 80–2000 km band. Each shell is a back-side
// sphere at the layer's outer altitude, rendered with a custom GLSL
// shader that paints a fresnel-driven limb glow whose colour gradients
// from `colorLow` (layer floor) to `colorHigh` (layer top). Per-shell
// opacity is driven by local log(ρ) so the visual reads as data, not
// decoration: dense regimes glow brighter; the rarefied outer exosphere
// fades to a faint halo.
//
// `peakKm` is the altitude where we sample the profile to scale
// brightness; usually the layer's mid-point on a log-altitude scale so
// the thermosphere's wide vertical range still has a stable peak.
const LAYER_SHELLS = [
    {
        id:         "mesosphere",
        name:       "Mesosphere",
        minKm:       50, maxKm:   85,  peakKm:   80,
        colorLow:   0x6e9bff, colorHigh: 0x9cc3ff,
        baseAlpha:  0.22, rimPower: 2.4,
    },
    {
        id:         "lower-thermosphere",
        name:       "Lower Thermosphere",
        minKm:       85, maxKm:  250,  peakKm:  170,
        colorLow:   0xff7a3d, colorHigh: 0xffb060,
        baseAlpha:  0.30, rimPower: 2.8,
    },
    {
        id:         "upper-thermosphere",
        name:       "Upper Thermosphere",
        minKm:      250, maxKm:  600,  peakKm:  420,
        colorLow:   0xffa050, colorHigh: 0xffe0a0,
        baseAlpha:  0.22, rimPower: 3.0,
    },
    {
        id:         "inner-exosphere",
        name:       "Inner Exosphere",
        minKm:      600, maxKm: 1200,  peakKm:  900,
        colorLow:   0xb672ff, colorHigh: 0xe2a8ff,
        baseAlpha:  0.16, rimPower: 3.2,
    },
    {
        id:         "outer-exosphere",
        name:       "Outer Exosphere",
        minKm:     1200, maxKm: 2000,  peakKm: 1600,
        colorLow:   0x7a3dff, colorHigh: 0xb47cff,
        baseAlpha:  0.10, rimPower: 3.6,
    },
];

// ── Layer-shell GLSL — volumetric ray-march ──────────────────────────────
// The shell isn't a 2D ring around the limb — it's a 3D spherical *sheet*
// with a real inner/outer radius. The fragment shader treats the mesh
// surface as a "front door" into a volume bounded by uInnerR and uOuterR
// and computes how much of that volume the view ray traverses.
//
// For each fragment:
//   1. Cast a ray from the camera through the world-space fragment.
//   2. Intersect with the outer & inner spheres (analytic, cheap).
//   3. The visible shell-segment is everything the ray spends inside
//      the (inner < r < outer) annulus *in front* of the planet.
//   4. Color comes from the radial position of the segment's mid-point
//      (low → high altitude inside the layer) with a storm warming term.
//   5. Alpha is proportional to path length × layer base opacity ×
//      density-driven uIntensity. Long limb chords accumulate more
//      "atmosphere", short on-axis chords accumulate less — gives the
//      shell a real sense of *depth*.
//
// This replaces the old fresnel-only shader where the shell was only
// visible at the limb (which is exactly what made it look like a ring).
const LAYER_VERT = /* glsl */`
    varying vec3 vWorldPos;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;

const LAYER_FRAG = /* glsl */`
    uniform vec3  uCameraPos;
    uniform vec3  uColorLow;
    uniform vec3  uColorHigh;
    uniform float uOuterR;       // outer radius of this shell  (R⊕)
    uniform float uInnerR;       // inner radius of this shell  (R⊕)
    uniform float uPlanetR;      // opaque planet radius        (R⊕)
    uniform float uOpacity;
    uniform float uIntensity;    // density-driven multiplier (0.35..1.2)
    uniform float uStorm;        // 0..1 geomagnetic forcing
    uniform vec3  uSunDir;       // unit vector, world frame
    uniform float uSwForcing;    // 0..1 dynamic-pressure proxy from solar wind
    uniform float uFade;         // 0..1 — drops to ~0.18 when camera is
                                 //        inside this shell's altitude band
                                 //        so free-fly users can see through
                                 //        the layer they're standing in.
    varying vec3  vWorldPos;

    // Ray-sphere intersection. Returns vec2(tNear, tFar). Negative
    // values mean the ray origin is inside / behind that sphere.
    vec2 raySphere(vec3 ro, vec3 rd, float r) {
        float b = dot(ro, rd);
        float c = dot(ro, ro) - r * r;
        float disc = b * b - c;
        if (disc < 0.0) return vec2(1e9, -1e9);
        float sq = sqrt(disc);
        return vec2(-b - sq, -b + sq);
    }

    void main() {
        vec3 ro = uCameraPos;
        vec3 rd = normalize(vWorldPos - uCameraPos);

        vec2 hOut = raySphere(ro, rd, uOuterR);
        vec2 hIn  = raySphere(ro, rd, uInnerR);
        vec2 hPl  = raySphere(ro, rd, uPlanetR);

        if (hOut.y < 0.0) discard;          // outer shell entirely behind us

        // Near boundary of the shell-segment along the ray.
        float t0 = max(0.0, hOut.x);

        // Far boundary — whichever opaque thing the ray hits first:
        //   inner-shell entry, planet entry, or outer-shell exit.
        float t1 = hOut.y;
        if (hIn.x > 0.0) t1 = min(t1, hIn.x);
        else if (hIn.y > 0.0) t0 = max(t0, hIn.y);   // camera is below inner
        if (hPl.x > 0.0) t1 = min(t1, hPl.x);

        float pathLen = max(0.0, t1 - t0);
        if (pathLen <= 0.0) discard;

        // Mid-point sample for colour gradient + dayside lighting.
        vec3 midPos = ro + rd * (t0 + t1) * 0.5;
        float midR  = length(midPos);
        float radT  = clamp((midR - uInnerR) / max(uOuterR - uInnerR, 1e-4),
                            0.0, 1.0);
        vec3 col = mix(uColorLow, uColorHigh, radT);

        // Storm warming — push toward orange when Ap is high.
        col = mix(col, vec3(1.0, 0.55, 0.25), uStorm * 0.55);

        // Solar-wind compression cue: strengthens the dayside hemisphere
        // in proportion to dynamic pressure. The shell physically
        // compresses on the sunward side during storms; we tint that side
        // warmer + brighter to convey "this is where the wind is hitting".
        float sunDot = max(0.0, dot(normalize(midPos), uSunDir));
        float dayside = sunDot * uSwForcing;
        col = mix(col, vec3(1.0, 0.72, 0.40), dayside * 0.45);

        // Alpha from path length, normalised to a chord through the
        // shell's full thickness (the maximum any view ray can spend
        // inside this single layer when looking edge-on).
        float maxPath = max(uOuterR - uInnerR, 1e-3);
        float pn = clamp(pathLen / (maxPath * 1.6), 0.0, 1.0);

        // Mild gamma so thicker chords feel deeper without flattening
        // the on-axis fragments to nothing.
        pn = pow(pn, 0.85);

        float alpha = uOpacity * uIntensity * pn * (1.0 + 0.45 * dayside);
        alpha *= uFade;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
    }
`;

// ── Solar wind & magnetosphere boundaries ─────────────────────────────────
// Climatological defaults — used when no live data is available so the
// page still shows a meaningful magnetosphere from first paint.
const SW_DEFAULTS = Object.freeze({
    speed:   400,   // km/s
    density:   5,   // cm^-3
    bz:        0,   // nT (GSM, +north)
});

// Shue-1998 profile builder — re-implemented locally rather than imported
// (kept as a private helper inside magnetosphere-engine.js). Returns an
// array of THREE.Vector2 in the (transverse-radius, sun-axis) plane;
// LatheGeometry revolves around Y so we orient the parent group so local
// +Y aligns with the sun direction.
function _shueProfile(r0, alpha, nPts = 80) {
    const thetaMax = Math.PI * 0.87;
    const pts = [];
    for (let i = 0; i <= nPts; i++) {
        const theta = (i / nPts) * thetaMax;
        const r = r0 * Math.pow(2 / (1 + Math.cos(theta)), alpha);
        pts.push(new THREE.Vector2(
            r * Math.sin(theta),   // X = transverse radius from sun axis
            r * Math.cos(theta),   // Y = distance along sun axis
        ));
    }
    return pts;
}

// Fresnel shader for magnetopause / bow shock. Limb-bright, additive,
// double-sided so users see the surface from any angle.
const SW_VERT = /* glsl */`
    varying vec3 vNormal;
    varying vec3 vViewDir;
    void main() {
        vec4 mvp = modelViewMatrix * vec4(position, 1.0);
        vNormal  = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvp.xyz);
        gl_Position = projectionMatrix * mvp;
    }
`;
const SW_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  uColor;
    uniform vec3  uRimColor;
    uniform float uBaseAlpha;
    uniform float uRimPower;
    uniform float uIntensity;
    uniform float uTime;
    varying vec3  vNormal;
    varying vec3  vViewDir;
    void main() {
        float NdV = abs(dot(normalize(vNormal), normalize(vViewDir)));
        float fres = pow(1.0 - NdV, uRimPower);
        vec3 col = mix(uColor, uRimColor, fres);
        // Slow breathing pulse — magnetopause "flutter" hint.
        float pulse = 1.0 + 0.08 * sin(uTime * 0.6);
        float alpha = (uBaseAlpha + fres * 0.35) * pulse * uIntensity;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.85));
    }
`;

// Solar-wind flux streamer: animated dashed strip flowing along -Y in
// the solar group's local frame (i.e., from sun toward Earth). The
// stripe's brightness modulates with dynamic pressure via uIntensity.
const SW_STREAM_VERT = /* glsl */`
    attribute float aProgress;     // 0..1 along the streamer
    varying float vProgress;
    void main() {
        vProgress = aProgress;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const SW_STREAM_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  uColor;
    uniform float uTime;
    uniform float uIntensity;
    uniform float uSpeed;
    varying float vProgress;
    void main() {
        // Travelling dash pattern — brighter "particle" packets sweep
        // toward Earth at a rate scaled by the solar-wind speed.
        float t = vProgress + uTime * uSpeed;
        float dash = pow(0.5 + 0.5 * sin(t * 18.0), 4.0);
        // Fade in as we approach Earth (head of the streamer).
        float headFade = pow(vProgress, 0.6);
        float alpha = uIntensity * dash * headFade;
        gl_FragColor = vec4(uColor, alpha);
    }
`;

// ── Sun photosphere shader — procedural granulation + limb darkening ──
// fbm-based cell pattern that drifts slowly so the disc reads as a
// roiling, convecting surface rather than a flat sprite. Colour ramps
// from a hot white-yellow core toward orange limb (limb darkening), with
// brighter "active region" highlights that breathe with uTime.
const SUN_VERT = /* glsl */`
    varying vec3 vNormalW;
    varying vec3 vPosW;
    varying vec3 vViewDirW;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosW    = wp.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDirW = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;
const SUN_FRAG = /* glsl */`
    precision highp float;
    uniform float uTime;
    uniform float uIntensity;
    uniform vec3  uHot;
    uniform vec3  uCool;
    varying vec3  vNormalW;
    varying vec3  vViewDirW;
    varying vec3  vPosW;

    // Hash + value-noise — cheap, no texture dependency.
    float hash3(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = hash3(i + vec3(0.0, 0.0, 0.0));
        float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
        float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
        float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
        float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
        float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
        float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
        float n111 = hash3(i + vec3(1.0, 1.0, 1.0));
        return mix(
            mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
            mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
            f.z);
    }
    float fbm(vec3 p) {
        float a = 0.0, w = 0.5;
        for (int i = 0; i < 5; i++) {
            a += w * vnoise(p);
            p *= 2.05;
            w *= 0.5;
        }
        return a;
    }

    void main() {
        // Granulation: scale up the surface position so cells are small
        // relative to the disc, then drift with uTime to roil. A second
        // FBM at half scale picks out broad active-region brightening.
        vec3 p = normalize(vPosW) * 4.5;
        float gran   = fbm(p + vec3(0.0, uTime * 0.04, 0.0));
        // NOT 'active' — that is a reserved word in GLSL ES and this
        // shader has failed to compile since it shipped, which left the
        // Sun rendering on three.js's error-fallback material. The
        // compiler points at the declaration line, so it reads like a
        // problem with fbm() rather than with the variable's name.
        float arGlow = fbm(p * 0.6 + vec3(uTime * 0.02, 0.0, uTime * 0.015));
        float surf   = mix(gran, arGlow, 0.45);

        // Limb darkening: the disc edge cools toward orange/red; the
        // centre reads white-hot. Boost the darkening exponent slightly
        // so users get the "convex 3D star" cue rather than a flat disc.
        float NdV  = clamp(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0, 1.0);
        float limb = pow(NdV, 0.55);

        // Active-region hotspots — breathing white-hot peaks. Squared
        // contrast so they punch through the granulation noise.
        float hotspot = smoothstep(0.62, 0.95, surf);
        hotspot = pow(hotspot, 1.6);

        // Colour blend: limb-darkened cool baseline, brightened by the
        // FBM and lifted toward white at the hotspots.
        vec3 base = mix(uCool, uHot, limb);
        base += hotspot * vec3(0.55, 0.42, 0.18);
        base *= 0.78 + 0.42 * surf;

        // Subtle uIntensity scale (tied to F10.7) — quiet sun is a
        // touch dimmer, cycle max is brighter and whiter.
        base *= 0.85 + 0.45 * uIntensity;

        gl_FragColor = vec4(base, 1.0);
    }
`;

// ── Sun corona shader — multi-layer additive halo ─────────────────────
// A fresnel-bright shell with FBM "streamer" filaments rotating slowly
// around the disc. Used at three radii (chromosphere → mid corona →
// outer corona) with different colours so the layered glow reads as
// real depth rather than a single flat halo.
const CORONA_VERT = /* glsl */`
    varying vec3 vNormalW;
    varying vec3 vViewDirW;
    varying vec2 vUv;
    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vNormalW  = normalize(mat3(modelMatrix) * normal);
        vViewDirW = normalize(cameraPosition - wp.xyz);
        vUv       = uv;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;
const CORONA_FRAG = /* glsl */`
    precision highp float;
    uniform vec3  uColor;
    uniform vec3  uRimColor;
    uniform float uTime;
    uniform float uIntensity;
    uniform float uRimPower;
    uniform float uBaseAlpha;
    varying vec3  vNormalW;
    varying vec3  vViewDirW;
    varying vec2  vUv;

    float hash3(vec3 p) {
        p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(mix(hash3(i+vec3(0,0,0)), hash3(i+vec3(1,0,0)), f.x),
                mix(hash3(i+vec3(0,1,0)), hash3(i+vec3(1,1,0)), f.x), f.y),
            mix(mix(hash3(i+vec3(0,0,1)), hash3(i+vec3(1,0,1)), f.x),
                mix(hash3(i+vec3(0,1,1)), hash3(i+vec3(1,1,1)), f.x), f.y),
            f.z);
    }
    float fbm(vec3 p) {
        float a = 0.0, w = 0.5;
        for (int i = 0; i < 4; i++) {
            a += w * vnoise(p);
            p *= 2.1;
            w *= 0.5;
        }
        return a;
    }

    void main() {
        // Limb-bright fresnel — corona reads brightest at the silhouette.
        float NdV  = abs(dot(normalize(vNormalW), normalize(vViewDirW)));
        float fres = pow(1.0 - NdV, uRimPower);

        // Rotating filament noise: creates the suggestion of corona
        // streamers without modelling each one geometrically. The radial
        // sample uses the surface normal so the filaments stay attached
        // to the disc as it rotates.
        vec3 p = normalize(vNormalW) * 3.2 + vec3(uTime * 0.03, 0.0, uTime * 0.05);
        float fil = fbm(p);
        // Sharpen the FBM into "ribbons" — power curve picks out brighter
        // ridges and lets the rest fall away.
        fil = pow(smoothstep(0.40, 0.95, fil), 1.4);

        vec3 col = mix(uColor, uRimColor, fres);
        col += fil * uRimColor * 0.55;

        // Slow breathing pulse — overall corona modulation.
        float pulse = 0.92 + 0.16 * sin(uTime * 0.5);

        float alpha = (uBaseAlpha + fres * 0.55 + fil * 0.18) * pulse * uIntensity;
        gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.95));
    }
`;

export class AtmosphereGlobe {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {object} [opts]
     * @param {number} [opts.cameraDistance=3.2]  initial camera distance (Earth radii)
     * @param {boolean}[opts.stars=true]
     * @param {boolean}[opts.autoRotate=true]
     */
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        // Phase 26: default sat propagation to REAL-TIME (1×) so probes
        // sit at their actual current positions. Callers that explicitly
        // want demo-speed compression can pass satTimeScale in opts;
        // the in-page time-warp HUD uses setSatTimeScale() to change it
        // live. Legacy `issTimeScale` is honoured for back-compat but
        // also defaults to 1×.
        this.opts = { cameraDistance: 3.2, stars: true, autoRotate: true,
                      satTimeScale: 1, ...opts };
        // Phase B: the globe owns a reference to the shared TimeBus.
        // The bus's rate IS the satellite-propagation rate; the legacy
        // pauseSat / setSatTimeScale APIs proxy through. opts honoured:
        // if caller passed satTimeScale, seed the bus with that rate.
        this._timeBus = getTimeBus();
        if (Number.isFinite(this.opts.satTimeScale)) {
            this._timeBus.setRate(this.opts.satTimeScale);
        }

        this._initRenderer();
        this._initScene();
        this._buildEarth();
        this._buildLayerShells();
        this._buildAtmosphereVolume();
        this._buildDensitySubShells();
        this._buildIsodensitySurfaces();
        this._buildLayerParticles();
        this._buildLayerVectorFields();
        this._buildZoneWaveFields();
        this._buildDragForecastOverlay();
        this._buildFleetRibbons();
        this._buildFlightLayer();
        this._buildSatelliteRings();
        // Pairwise conjunction screener — depends on the probe lookup
        // tables built inside _buildSatelliteRings, so we set up after.
        this._setupConjunctionScreener();
        // Hover-highlight reticle for the debris cloud. Built up-front
        // (cheap; one mesh) so _updateDebrisHighlight has a target to
        // poke at the moment a hover lands on a dot.
        this._buildDebrisHighlight();
        // Fire-and-forget live-TLE upgrade. Each probe starts on its
        // hardcoded mean elements; the fetch resolves a few hundred ms
        // later and patches the probe in place. Failures fall back
        // silently to the hardcoded values.
        this._fetchLiveTLEs().catch(err => {
            console.debug('[upper-atmosphere] live TLE upgrade skipped:', err?.message || err);
        });
        // Background debris sample — 50 LEO debris pieces in the same
        // altitude band as our assets, fetched from CelesTrak's debris
        // SPECIAL list. Failures are silent; the page stays usable
        // without debris context.
        this._loadDebrisSample().catch(err => {
            console.debug('[upper-atmosphere] debris load skipped:', err?.message || err);
        });
        this._buildAltitudeRing();
        this._buildAtmosphericPhenomena();
        this._buildSolarWind();
        this._buildMagneticCascade();
        if (this.opts.stars) this._initStars();
        this._initControls();
        this._transit = new AtmosphereTransit(this._scene, {
            controls: this._controls, canvas: this.canvas,
            // From inside the band the altitude tori, field lines and orbit
            // loops sweep through the view as hoops; quiet them for the
            // ride (the flight layer's focus set) unless a flight already
            // owns that focus, and restore their own settings on release.
            onStart: () => {
                this._transitFocus = !this._flightFocusOn;
                if (this._transitFocus) this.setFlightFocus(true);
            },
            onStop: () => {
                if (this._transitFocus && !this._flight?.hasFlight()) this.setFlightFocus(false);
                this._transitFocus = false;
            },
        });
        // Explore mode's markers: boundary membranes, POI beacons, and the
        // crossing / discovery events (js/upper-atmosphere-explore.js).
        this._explore = new ExploreLayer(this._scene, {
            getPoiInputs: () => this._poiInputs(),
        });
        // The operational bands on the limb (js/upper-atmosphere-ops-bands-layer.js):
        // ON by default — the ruler an operator reads the render against.
        this._opsBands = new OpsBandsLayer(this._scene);
        this._initResize();
        this._initTooltip();
        this._initDiveOnDoubleClick();
        this._initInstruments();

        this._clock = new THREE.Clock();
        this._animate = this._animate.bind(this);
        this._raf = requestAnimationFrame(this._animate);
    }

    // ── Layer particle systems ──────────────────────────────────────────────
    // Five LayerParticleSystem instances, one per atmospheric regime.
    // Each system is mounted under its own group (this._particleGroup) so
    // we can master-toggle all particles independently of the gradient
    // shells, and each individual system can be hidden via
    // setLayerVisible(id, false).

    _buildLayerParticles() {
        this._particleGroup   = new THREE.Group();
        this._particles       = {};   // id → LayerParticleSystem
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            const sys = new LayerParticleSystem({
                parent: this._particleGroup,
                layer,
                // Sun direction drives the per-particle thermospheric
                // wind (subsolar→antisolar tangent flow). Stored on
                // each system; setSunDir() can update it later.
                sunDir: this._sunDir,
            });
            this._particles[layer.id] = sys;
        }
        this._scene.add(this._particleGroup);
    }

    // ── Layer vector fields ─────────────────────────────────────────────────
    // One LayerVectorField per atmospheric regime. Mode is a single
    // global toggle ('off' | 'temperature' | 'radiation') applied to all
    // five fields together, since the user-facing question is "which
    // *kind* of field do I want to see across the atmosphere", not
    // "which kind on layer 3 specifically". Per-layer toggle is a
    // straight-line follow-up if it ever matters.

    _buildLayerVectorFields() {
        this._fieldGroup     = new THREE.Group();
        this._fields         = {};
        this._fieldMode      = 'off';
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            const f = new LayerVectorField({
                parent: this._fieldGroup,
                layer,
                sunDir: this._sunDir,
            });
            this._fields[layer.id] = f;
        }
        this._scene.add(this._fieldGroup);
    }

    /**
     * Set the global vector-field mode. 'off' hides every layer's
     * field; 'temperature' or 'radiation' shows them, recomputing
     * vectors against the current physics + state.
     */
    setVectorFieldMode(mode) {
        const m = mode === 'temperature' || mode === 'radiation' ? mode : 'off';
        this._fieldMode = m;
        if (!this._fields) return;
        for (const id in this._fields) {
            const f = this._fields[id];
            f.setMode(m);
            // On switching ON we want fresh vectors — push the latest
            // physics for the matching layer, if we have it cached.
            if (m !== 'off' && this._lastFieldPhys?.[id]) {
                f.setPhysics(
                    this._lastFieldPhys[id],
                    this._lastFieldState ?? {},
                );
            }
        }
    }

    getVectorFieldMode() { return this._fieldMode ?? 'off'; }

    // ── Zone turbulence wave fields ─────────────────────────────────────────
    // One ZoneWaveField per atmospheric regime — an animated travelling-
    // disturbance ripple whose amplitude tracks the zone's live turbulence
    // index. Master-off by default (zero per-frame cost until shown). The
    // dashboard pushes per-zone indices via setZoneTurbulence(); setProfile
    // also seeds a coarse Ap-based baseline so the ripple is alive before
    // the first dashboard tick lands.

    _buildZoneWaveFields() {
        this._waveGroup = new THREE.Group();
        this._waves     = {};
        this._waveVisible = false;
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            this._waves[layer.id] = new ZoneWaveField({
                parent: this._waveGroup,
                layer,
            });
        }
        this._scene.add(this._waveGroup);
    }

    /** Master toggle for the turbulence wave-field overlay. */
    setWaveFieldVisible(on) {
        this._waveVisible = !!on;
        if (!this._waves) return;
        for (const id in this._waves) this._waves[id].setVisible(this._waveVisible);
    }

    getWaveFieldVisible() { return !!this._waveVisible; }

    /**
     * Push per-zone turbulence indices into the wave-field ripple
     * amplitudes. Accepts the array `computeZoneTurbulence()` returns
     * (objects with `{ zoneId, ti }`) or a plain `{ zoneId: ti }` map.
     */
    setZoneTurbulence(zi) {
        if (!this._waves || !zi) return;
        // Dashboard has taken ownership of the amplitudes — setProfile()
        // stops seeding its Ap baseline from here on.
        this._zoneTurbExternal = true;
        if (Array.isArray(zi)) {
            for (const z of zi) {
                if (z && this._waves[z.zoneId]) this._waves[z.zoneId].setTurbulence(z.ti);
            }
        } else {
            for (const id in zi) {
                if (this._waves[id]) this._waves[id].setTurbulence(zi[id]);
            }
        }
    }

    // ── Drag-forecast overlay ───────────────────────────────────────────────
    // Particle flow-line view of LEO drag. Each layer carries its own
    // population of tracers riding a sun-driven thermospheric wind proxy;
    // colour encodes dρ/dt (red = drag rising, green = drag falling) so
    // satellite operators can read the storm response at a glance. Built
    // up-front (cheap) and toggled on by setDragForecastVisible().

    _buildDragForecastOverlay() {
        this._dragOverlay = new DragForecastOverlay(this._scene, {
            sunDir: this._sunDir,
            totalParticles: 1400,
        });
        // Per-layer ρ history → drag-delta. Maintained as a one-step
        // rolling diff against the previous setProfile() / setState() push.
        // _dragHistory[layerId] = { lastRho, lastT, dRhoDt }
        this._dragHistory = {};
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            this._dragHistory[layer.id] = { lastRho: NaN, lastT: NaN, dRhoDt: 0 };
        }
        this._dragHistorySmoothing = 0.30;   // EMA factor for dρ/dt
    }

    // ── Fleet ribbons ───────────────────────────────────────────────────
    // Renders the top-N highest-severity tracked assets (managed by the
    // FleetPanel) as colour-coded great-circle orbit lines in the scene.
    // Built up-front; populated when FleetPanel calls setFleetRibbons().

    _buildFleetRibbons() {
        this._fleetRibbons = new FleetRibbons(this._scene);
    }

    /**
     * Push the current top-N fleet results into the in-scene ribbon
     * renderer. Pass an empty array to clear. Called by FleetPanel's
     * onSeverityChange callback every analyzer pass.
     */
    setFleetRibbons(top) {
        this._fleetRibbons?.setRibbons?.(Array.isArray(top) ? top : []);
    }

    // ── Flight dynamics layer ───────────────────────────────────────────
    // See js/upper-atmosphere-flight.js (kernel) and -flight-layer.js
    // (renderer). The globe's only physics contribution is the density
    // sampler, built from the SAME (F10.7, Ap) the rest of the page runs on.
    _buildFlightLayer() {
        this._flight = new FlightLayer(this._scene, {
            getSimTimeMs: () => this._timeBus.getSimTime(),
        });
        this._flightOpts = null;
        this._flightSampler = null;
        this._flightSamplerKey = '';
        this._canvasClickHandlers = [];
    }
    getFlightLayer() { return this._flight; }

    _flightSamplerKeyNow() {
        return `${Math.round(this._state?.f107 ?? 150)}|${Math.round(this._state?.ap ?? 15)}`;
    }
    /** The (F10.7, Ap) sampler; rebuilt only when the rounded state moves. */
    getFlightSampler() {
        const key = this._flightSamplerKeyNow();
        if (!this._flightSampler || this._flightSamplerKey !== key) {
            const [f107, ap] = key.split('|').map(Number);
            this._flightSampler = createDensitySampler({ f107Sfu: f107, ap });
            this._flightSamplerKey = key;
        }
        return this._flightSampler;
    }

    /**
     * Integrate + draw a flight from kernel options (r0, v0, t0Ms, bc, …).
     * The sampler is always the page's. Returns the Flight.
     */
    launchFlight(opts, { keepClock = false, colorMode = null } = {}) {
        const sampler = this.getFlightSampler();
        const prev = keepClock && this._flight.hasFlight() ? this._flight.getClock() : null;
        const flight = new Flight({ ...opts, sampler,
            meta: { ...(opts.meta || {}), samplerKey: this._flightSamplerKey } });
        this._flightOpts = { ...opts };
        this._flight.setFlight(flight, { colorMode: colorMode || opts.meta?.colorMode || null });
        if (prev && prev.mode === 'own') {
            this._flight.seek(prev.tS);
            if (prev.playing) this._flight.play();
        }
        try {
            window.dispatchEvent(new CustomEvent('ua-flight-launched', {
                detail: { name: flight.name, meta: flight.meta, relaunch: !!prev },
            }));
        } catch (_) { /* SSR */ }
        return flight;
    }
    /** One of FLIGHT_PRESETS by id, launched at the bus's sim time. */
    launchPreset(id, { atMs = null } = {}) {
        const preset = presetById(id);
        if (!preset) return null;
        const t0 = Number.isFinite(atMs) ? atMs : this._timeBus.getSimTime();
        return this.launchFlight(flightOptionsFromPreset(preset, t0));
    }
    /** A custom launch from a site + local velocity (see kernel launchState). */
    launchFromSite(launch, {
        bcM2PerKg = 0.02, liftToDrag = 0, horizonS = 86400,
        name = 'custom probe', atMs = null, colorMode = 'altitude',
    } = {}) {
        const t0 = Number.isFinite(atMs) ? atMs : this._timeBus.getSimTime();
        const ls = launchState({ ...launch, unixMs: t0 });
        return this.launchFlight({
            r0: ls.r, v0: ls.v, t0Ms: t0, bcM2PerKg, liftToDrag, horizonS, name,
            meta: { launch: { ...launch }, colorMode, custom: true },
        });
    }
    /**
     * Seed a flight from a TLE via the page's Rust SGP4 at the bus's sim
     * time (TEME treated as ECI, as the catalogue tracker does), then let
     * the kernel carry it through the live atmosphere. Needs the WASM.
     */
    async trackFlightFromTle({ line1, line2, name = 'satellite', bcM2PerKg = 0.02,
                               horizonS = 86400, noradId = null, color = null }) {
        if (!line1 || !line2) throw new Error('TLE lines required');
        const mod = await import('./satellite-tracker.js');
        await mod.whenWasmSettled?.();
        const wasm = mod.getWasmSgp4?.();
        if (!wasm?.propagate_tle) throw new Error('SGP4 WASM not loaded');
        const epochMs = tleEpochMs(line1);
        if (!Number.isFinite(epochMs)) throw new Error('unreadable TLE epoch');
        const t0 = this._timeBus.getSimTime();
        const st = wasm.propagate_tle(line1, line2, (t0 - epochMs) / 60000);
        return this.launchFlight({
            r0: [st[0], st[1], st[2]], v0: [st[3], st[4], st[5]], t0Ms: t0,
            bcM2PerKg, horizonS, name,
            meta: { tle: { line1, line2, noradId, epochMs }, colorMode: 'q', color },
        });
    }
    /**
     * Fly the camera to the flight's head (0.9 R⊕ out, tilted toward the
     * pole so the limb shows) — what makes a launch READ at all: at whole-
     * globe framing the ribbon competes with every other overlay and the
     * limb band. Switches to fly mode like a satellite click does.
     */
    frameFlight(durationSec = 1.6) {
        const layer = this._flight;
        if (!layer?.hasFlight()) return false;
        const f = layer.getFlight();
        const c = layer.getClock();
        const p = f.sceneAt(Math.max(0, Math.min(c.tS, f.tEndS))) || f.sceneAt(0);
        if (!p) return false;
        const pos = new THREE.Vector3(p[0], p[1], p[2]);
        const radial = pos.clone().normalize();
        const camPos = pos.clone().addScaledVector(radial, 0.55)
            .add(new THREE.Vector3(0, 0.16, 0)).normalize()
            .multiplyScalar(pos.length() + 0.55);
        if (this._controls.getMode?.() === 'orbit') this._controls.setMode('fly');
        this._followId = null;
        this._controls.stopFollowing?.();
        this.flyTo(camPos, pos, durationSec);
        this.setFlightFocus(true);
        return true;
    }
    /**
     * FOCUS: while a flight is on, quiet the overlays that compete with the
     * ribbon at close range — the magnetic-cascade field lines, the
     * conjunction chords, the reference probes' orbit loops and the fleet
     * ribbons (measured: at the launch framing they filled the frame and
     * the flight could not be found). Every hidden object's own visibility
     * is remembered and restored EXACTLY on focus-off / clearFlight, so a
     * user who switched a layer off keeps it off.
     */
    setFlightFocus(on) {
        on = !!on;
        if (on === !!this._flightFocusOn) return;
        this._flightFocusOn = on;
        const targets = [
            this._cascade?.group, this._conjunctionGroup, this._fleetRibbons?.mesh,
            // the altitude reference tori, the solar-wind streamers / Sun
            // marker, the slider's altitude ring and the mesosphere rings —
            // at the launch framing each of these crossed the frame as a
            // band brighter than the ribbon (measured on the screenshots)
            this._satGroup, this._swGroup, this._ring, this._phenomenaGroup,
            ...Object.values(this._satProbes || {}).map(p => p.pathLine),
        ].filter(Boolean);
        if (on) {
            this._flightFocusSaved = new Map(targets.map(o => [o, o.visible]));
            for (const o of targets) o.visible = false;
        } else if (this._flightFocusSaved) {
            for (const [o, v] of this._flightFocusSaved) o.visible = v;
            this._flightFocusSaved = null;
        }
    }
    getFlightFocus() { return !!this._flightFocusOn; }

    clearFlight() {
        this.setFlightFocus(false);
        this._flight.clear();
        this._flightOpts = null;
        this._sceneTimeOverrideMs = null;
        if (this._followId?.kind === 'flight') this.stopFollowing();
    }
    /** Chase camera on the flight head (radial-out offset, like a probe). */
    followFlight() {
        if (!this._flight?.hasFlight()) return false;
        if (this._controls.getMode?.() === 'orbit') this._controls.setMode('fly');
        this._controls.followObject?.(() => this._flight.getHeadPosition());
        this._followId = { kind: 'flight' };
        return true;
    }
    /** The atmosphere changed under a live flight: integrate it again. */
    _relaunchFlightForState() {
        if (!this._flightOpts || !this._flight?.hasFlight()) return;
        if (this._flight.getFlight()?.meta?.samplerKey === this._flightSamplerKeyNow()) return;
        this.launchFlight(this._flightOpts, { keepClock: true, colorMode: this._flight.getColorMode() });
    }
    /**
     * Register a canvas click (not drag) handler: fn({ nx, ny, userData,
     * event }) → return true to consume. Used by the launch panel's
     * "pick site on the globe". Returns an unsubscribe.
     */
    onCanvasClick(fn) {
        this._canvasClickHandlers.push(fn);
        return () => { this._canvasClickHandlers = this._canvasClickHandlers.filter(f => f !== fn); };
    }

    setDragForecastVisible(v) {
        if (this._dragOverlay) this._dragOverlay.setVisible(v);
    }
    getDragForecastVisible() {
        return !!this._dragOverlay?.isVisible?.();
    }

    /**
     * Latest drag-delta snapshot (read-only) — used by the UI legend
     * to paint per-layer up/down arrows and percent-change figures.
     * @returns {object} layerId → { rho, dRhoDt, dragQ }
     */
    getDragForecastSnapshot() {
        const out = {};
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            const h = this._dragHistory?.[layer.id];
            const phys = this._lastFieldPhys?.[layer.id];
            if (!h || !phys) continue;
            // q = ½ρv² for a circular orbit at the layer peak. v is
            // approximated as √(μ/(R+h)) with μ in km³/s²; converted to
            // m²/s² before multiplying ρ (kg/m³) so q comes out in Pa.
            const MU_KM3_S2 = 398600.4418;
            const r_km = 6371 + layer.peakKm;
            const v_ms = Math.sqrt(MU_KM3_S2 / r_km) * 1000;
            const dragQ = 0.5 * (phys.rho ?? 0) * v_ms * v_ms;
            out[layer.id] = {
                rho:    phys.rho ?? 0,
                dRhoDt: h.dRhoDt,
                dragQ,
            };
        }
        return out;
    }

    /** Internal: recompute per-layer dρ/dt from the freshly cached physics. */
    _refreshDragHistory() {
        const phys = this._lastFieldPhys;
        if (!phys) return;
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
        const perLayer = {};
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            const p = phys[layer.id]; if (!p) continue;
            const rho = p.rho ?? 0;
            const h = this._dragHistory[layer.id];
            if (Number.isFinite(h.lastRho) && rho > 0 && h.lastRho > 0 && now > h.lastT) {
                // Fractional change per minute → maps storm onset (~+30%
                // density inflation in 1–3 hr) to ≈+0.5 to +1.0 on the
                // overlay's red/green ramp. Symmetric on recovery.
                const dt_min = Math.max(1 / 60, (now - h.lastT) / 60);
                const fracPerMin = (rho - h.lastRho) / h.lastRho / dt_min;
                // Normalise: ±2%/min ≈ saturated colour.
                const norm = fracPerMin / 0.02;
                // EMA smoothing so single noisy ticks don't strobe colour.
                h.dRhoDt = (1 - this._dragHistorySmoothing) * h.dRhoDt
                         + this._dragHistorySmoothing * norm;
            }
            h.lastRho = rho;
            h.lastT   = now;
            perLayer[layer.id] = { dRhoDt: h.dRhoDt, rho };
        }
        if (this._dragOverlay) {
            this._dragOverlay.setDragHistory({
                perLayer,
                f107: this._lastFieldState?.f107,
                ap:   this._lastFieldState?.ap,
            });
        }
        // Broadcast for the UI panel to repaint its legend.
        try {
            window.dispatchEvent(new CustomEvent('ua-drag-forecast-tick', {
                detail: this.getDragForecastSnapshot(),
            }));
        } catch (_) { /* SSR / no-window — ignore */ }
    }

    /**
     * Per-layer visibility toggle — drives the gradient shell AND the
     * matching particle system together. Layer id matches
     * ATMOSPHERIC_LAYER_SCHEMA[].id.
     */
    setLayerVisible(layerId, visible) {
        const v = !!visible;
        // Shell mesh.
        if (this._shells) {
            const shell = this._shells.find(s => s.userData?.id === layerId);
            if (shell) shell.visible = v;
        }
        // Particle system — through the solo filter, so a layer switched
        // back on while another is soloed stays hidden until the solo ends.
        (this._layerUserVisible ??= {})[layerId] = v;
        this._applyParticleVisibility();
        // Drag-forecast overlay: mirror the layer toggle so flow lines for
        // hidden shells vanish too.
        this._dragOverlay?.setLayerEnabled?.(layerId, v);
        // Broadcast for any panel that paints per-layer state (drag legend
        // dims muted rows).
        try {
            window.dispatchEvent(new CustomEvent('ua-layer-visibility', {
                detail: { id: layerId, visible: v },
            }));
        } catch (_) { /* SSR / no-window — ignore */ }
    }

    /**
     * True/false snapshot of every layer's visibility — used by the UI
     * panel to seed checkbox state on first paint.
     */
    getLayerVisibility() {
        const out = {};
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            const shell = this._shells?.find(s => s.userData?.id === layer.id);
            out[layer.id] = shell ? shell.visible : true;
        }
        return out;
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Feed a sampled/fetched profile. Each gradient shell normalises its
     * intensity uniform against the in-band density range so the visual
     * tracks the data without dynamic-range collapse.
     */
    setProfile(profile) {
        if (!profile?.samples?.length) return;
        this._profile = profile;

        // Sample log(ρ) at each shell's reference altitude. The min/max
        // of the *current* profile defines the dynamic range — this way
        // a quiet preset and a G5-storm preset both light up the shells
        // proportionally without saturating one or going invisible in the
        // other.
        const logRhos = this._shells.map(sh => {
            const rho = _nearestRho(profile.samples, sh.userData.peakKm);
            sh.userData.rho = rho;
            return Math.log10(Math.max(rho, 1e-30));
        });
        const maxLR = Math.max(...logRhos);
        const minLR = Math.min(...logRhos);
        const span = Math.max(maxLR - minLR, 1.0);

        for (let i = 0; i < this._shells.length; i++) {
            const t = (logRhos[i] - minLR) / span;   // 0 (thin) … 1 (dense)
            // Compress so even the rarefied outer exosphere keeps a
            // visible halo, but dense regimes still pop.
            const intensity = 0.35 + 0.85 * t;
            this._shells[i].material.uniforms.uIntensity.value = intensity;
        }

        // Density-layer overlays track the same profile: repaint the
        // sub-shell brightness (∝ local ρ) and re-solve the isodensity
        // surface altitudes so they inflate / contract with the storm.
        if (this._subShellsBuilt) this._paintDensitySubShells(profile);
        this._positionIsodensitySurfaces(profile);

        // Push the latest physics into each particle system. layerPhysics
        // samples at peakKm with the layer's vertical thickness as the
        // Knudsen characteristic length, then setPhysics() rescales
        // particle count / colour / step magnitude / storm-drift in one
        // shot — no per-frame recompute, the per-frame update only
        // integrates positions.
        const f107 = profile.f107Sfu ?? this._lastState?.f107 ?? 150;
        const ap   = profile.ap      ?? this._lastState?.ap      ??  15;
        // Cache layerPhysics() once per layer + share it with both the
        // particle system AND the vector-field overlay so we're not
        // sampling the engine twice for the same (layer, F10.7, Ap)
        // tuple. Cheap, but pointless to do twice.
        this._lastFieldPhys  = this._lastFieldPhys || {};
        this._lastFieldState = { f107, ap };
        for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
            const phys = layerPhysics(layer, { f107Sfu: f107, ap });
            this._lastFieldPhys[layer.id] = phys;

            const sys = this._particles?.[layer.id];
            if (sys) sys.setPhysics(phys, { f107, ap });

            const fld = this._fields?.[layer.id];
            if (fld && this._fieldMode !== 'off') {
                fld.setPhysics(phys, { f107, ap });
            }
        }

        // Seed a coarse turbulence baseline from the current Ap so the
        // wave-field ripple is alive even before the dashboard's first
        // (volatility-aware) push lands. Higher Ap → more storm forcing →
        // a livelier baseline ripple. Once the dashboard calls
        // setZoneTurbulence() it owns the amplitudes and we stop seeding
        // here, so the richer index never flickers against this floor.
        if (this._waves && !this._zoneTurbExternal) {
            const apNow = Number.isFinite(ap) ? ap : 15;
            const baseTi = 1 - Math.exp(-Math.max(0, apNow - 5) / 45);
            for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
                this._waves[layer.id].setTurbulence(baseTi);
            }
        }

        // Volumetric atmosphere: rebuild the (altitude × T∞) and altitude
        // LUTs for the new state. ~5 ms — profile change only, never per
        // frame. The march reads density straight out of these, so this is
        // what makes a storm visibly inflate the rendered column.
        this._volume?.setState({ f107, ap });
        // The airglow field's Kp (SAR arcs, the fountain's disturbance dynamo).
        this._airglowAp = Number.isFinite(ap) ? ap : 15;
        // Let the page's legend re-read the display-scale numbers, which
        // are derived from the LUTs that just rebuilt. Without this the
        // legend would keep printing the boot-time scale after a storm
        // preset changed it.
        try {
            window.dispatchEvent(new CustomEvent('ua-profile-ready', {
                detail: { f107, ap, scale: this._volume?.getScaleInfo?.() ?? null },
            }));
        } catch (_) { /* SSR / no-window */ }

        // Drag-forecast overlay: physics has just refreshed, so per-layer
        // dρ/dt can be recomputed against the previous push and broadcast.
        this._refreshDragHistory();

        if (this._currentAltKm != null) this.setAltitude(this._currentAltKm);
    }

    /**
     * Move the highlighted cyan ring to a new altitude (km) and
     * recolour it by local ρ.
     */
    setAltitude(altitudeKm) {
        this._currentAltKm = altitudeKm;
        // The anomaly view reports the local/model drag multiplier AT the
        // altitude under examination — follow the slider.
        this._volume?.setAnomalyAltitude(altitudeKm);
        const r = 1 + altitudeKm / R_EARTH_KM;
        this._ring.scale.set(r, r, r);

        let rho = 0;
        if (this._profile) rho = _nearestRho(this._profile.samples, altitudeKm);
        const logR = Math.log10(Math.max(rho, 1e-30));
        const t = Math.max(0, Math.min(1, (logR + 20) / 16));
        const cold = new THREE.Color(0x8040ff);
        const warm = new THREE.Color(0x00ffd8);
        this._ring.material.color.copy(cold.lerp(warm, t));
        this._ring.material.opacity = 0.55 + t * 0.40;
    }

    /**
     * Drive the aurora shader from current space-weather state. The
     * EarthSkin shader takes raw Kp + bzSouth and does its own oval-
     * geometry math (equatorward shift + width growth with Kp); the
     * caller only has to pass faithful values.
     *
     * `bzSouth` is optional — when omitted we synthesise a proxy from
     * Ap so the storm presets still widen the oval realistically.
     * `dstNorm` is likewise synthesised when not provided (Dst correlates
     * strongly with Ap during substorms).
     */
    setState({ f107 = 150, ap = 15, bz = null } = {}) {
        this._state = { f107, ap, bz };
        this._lastState = { f107, ap };
        // A live flight was integrated through the OLD atmosphere; give the
        // slider a moment to settle, then integrate it again through the new
        // one (no-op when the rounded state has not moved).
        if (this._flight?.hasFlight()) {
            clearTimeout(this._flightRelaunchT);
            this._flightRelaunchT = setTimeout(() => this._relaunchFlightForState(), 350);
        }

        // Push the new (F10.7, Ap) to each particle system so the
        // storm-drift kicks in as soon as the user clicks a preset —
        // even before setProfile() runs.
        if (this._particles && this._profile) {
            for (const layer of ATMOSPHERIC_LAYER_SCHEMA) {
                const sys = this._particles[layer.id];
                if (!sys?._phys) continue;
                sys.setPhysics(sys._phys, { f107, ap });
            }
        }

        if (!this._skin) return;

        // Canonical SWPC Kp↔Ap inversion (not the old log2 approximation).
        const kp = apToKp(ap);

        // bzSouth is a [0..1] normalised "southward-ness" indicator used
        // by the shader to boost storm effects. When we don't have live
        // IMF data, approximate from Ap — values of 1 at Ap ≈ 80 (G3),
        // saturating at Ap ≥ 140 (G4+).
        let bzSouth;
        if (Number.isFinite(bz)) {
            // +bz = northward (suppresses aurora); -bz = southward
            // (enhances). Clamp magnitude to [0..1] at |Bz| = 30 nT.
            bzSouth = Math.max(0, Math.min(1, -bz / 30));
        } else {
            bzSouth = Math.max(0, Math.min(1, (ap - 15) / 100));
        }

        // Overall auroral power envelope. Off at quiet time, fully on
        // by Ap ~80 (G3). Shader multiplies by this; oval width also
        // scales with Kp so the two work together.
        const auroraAW = Math.max(0, Math.min(1, (ap - 12) / 110));

        // Dst proxy: linearly negative with Ap; normalised to
        // [-1..0] where -1 ≈ Ap 300 (G4-G5). Shader uses it for
        // ring-current effects not modelled here.
        const dstNorm = -Math.max(0, Math.min(1, ap / 300));

        this._skin.setSpaceWeather({
            kp,
            auroraOn: auroraAW > 0.02 ? 1 : 0,
            auroraAW,
            bzSouth,
            xray: 0,
            dstNorm,
        });

        // Storm warming for the gradient layer shells. Same envelope as
        // auroraAW so the colour shift stays in lock-step with the oval.
        if (this._shells) {
            for (const sh of this._shells) {
                sh.material.uniforms.uStorm.value = auroraAW;
            }
        }

        // Drive the sun's emission visuals from F10.7 — corona glow,
        // streamer brightness/length, core temperature.
        this.setF107(f107);

        // Refresh phenomena layer intensities (NLC, EEJ, AE rings, Sq).
        this._updateAtmosphericPhenomena({ f107, ap });

        // Drive the magnetic-field cascade — solar EUV + precipitation
        // packets flowing down dipole L-shells into the auroral oval.
        // Pass the live solar-wind state too so the cascade can:
        //   • compress dayside / stretch nightside lines from Pdyn
        //   • compute Φ_PC, FAC magnitude, HPI
        //   • dispatch a 'ua-magnetic-state' event with operator-grade
        //     headlines (HPI, Φ_PC, Lpp, FAC, oval edges, implications)
        // Uses live IMF Bz when available; falls back to an Ap-derived
        // proxy so storm presets still light up the reconnection cue.
        if (this._cascade) {
            this._cascade.setState({
                f107, ap, bz,
                speed:   this._swState?.speed,
                density: this._swState?.density,
                by:      this._swState?.by,
            });
        }

        // Feed a substorm-index proxy into the controller's auto-
        // trigger. We synthesise the index from the same drivers
        // solar-wind-magnetosphere.js uses: an Ap-driven storm-norm
        // plus a southward-Bz integrand. Climbing across 0.6 fires
        // an auto-substorm if the controller is idle + past the
        // refractory period.
        if (this._substorm) {
            const stormNorm = Math.max(0, Math.min(1, (ap - 12) / 200));
            // Bz drive integrand — accumulates while Bz is southward,
            // decays exponentially otherwise. Half-life ~30 sec wall-
            // clock so a state push of southward Bz primes the next
            // few sets of pushes (mirrors the real magnetosphere's
            // memory of recent driving).
            const bzS = Number.isFinite(bz)
                ? Math.max(0, -bz / 20)        // 0 at +Bz, 1 at -20 nT
                : stormNorm * 0.7;
            this._bzDriveAccum = Math.max(0, Math.min(1,
                0.85 * (this._bzDriveAccum || 0) + 0.45 * bzS));
            const idx = Math.min(1, 0.55 * stormNorm + 0.65 * this._bzDriveAccum);
            this._substorm.setSubstormIndex(idx);
        }
    }

    /**
     * Toggle overlay groups.
     */
    setVisibility({ satellites = true, shells = true, solarWind = true,
                    particles = true, vectorFields, cascade = true } = {}) {
        if (this._satGroup)      this._satGroup.visible      = satellites;
        // `shells` is the page's "atmosphere layer on/off" toggle, and it
        // predates there being two renderers for it. Route it through the
        // render mode rather than writing _shellGroup.visible directly:
        // with the volume active, poking the shell group back on stacks a
        // second additive pass over the same physical column and doubles
        // the limb. _applyAtmosphereVisibility owns the exclusivity.
        this._shellsWanted = !!shells;
        this._applyAtmosphereVisibility();
        if (this._swGroup)       this._swGroup.visible       = solarWind;
        if (this._particleGroup) this._particleGroup.visible = particles;
        if (this._cascade)       this._cascade.setVisible(cascade);
        // vectorFields visibility is driven by the field MODE — passing
        // false explicitly here forces the whole group off without
        // changing the mode (a user-friendly "hide" without losing
        // their last-selected mode).
        if (this._fieldGroup && vectorFields !== undefined) {
            this._fieldGroup.visible = !!vectorFields;
        }
    }

    /**
     * Drive the solar-wind / magnetospheric boundaries from upstream
     * plasma state. Recomputes the Shue-1998 magnetopause and Farris-
     * Russell bow shock standoff distances and rebuilds the lathe
     * geometries in place; updates streamer brightness from dynamic
     * pressure.
     *
     * @param {object} sw
     * @param {number} [sw.speed=400]    solar wind bulk speed (km/s)
     * @param {number} [sw.density=5]    proton density (cm^-3)
     * @param {number} [sw.bz=0]         IMF Bz GSM (nT, +north)
     */
    setSolarWind(sw = {}) {
        const speed   = Number.isFinite(sw.speed)   ? sw.speed   : SW_DEFAULTS.speed;
        const density = Number.isFinite(sw.density) ? sw.density : SW_DEFAULTS.density;
        const bz      = Number.isFinite(sw.bz)      ? sw.bz      : SW_DEFAULTS.bz;
        const by      = Number.isFinite(sw.by)      ? sw.by      : 0;
        this._swState = { speed, density, bz, by };
        // VBs (mV/m) for the ionosphere driver's convection field: the
        // rectified dawn–dusk electric field, v × southward Bz.
        this._vbs = speed * Math.max(0, -bz) * 1e-3;

        // Cascade geometry compresses dayside / stretches nightside
        // lines under Pdyn — push the live state so the visual tracks
        // the boundary motion the magnetopause is showing in parallel.
        if (this._cascade) {
            this._cascade.setSolarWindState({ speed, density, bz, by });
        }

        const mp = computeShue(density, speed, bz);
        const bs = computeBowShock(mp.r0, mp.alpha);
        this._swGeometry = { mp, bs };

        // Rebuild the magnetopause + bow-shock lathe geometries in place
        // (cheap — ~80 segments) so the standoff tracks live data.
        if (this._mpMesh) {
            const profile = _shueProfile(mp.r0, mp.alpha, 64);
            this._mpMesh.geometry.dispose();
            this._mpMesh.geometry = new THREE.LatheGeometry(profile, 56);
            this._mpMesh.userData.r0    = mp.r0;
            this._mpMesh.userData.alpha = mp.alpha;
        }
        if (this._bsMesh) {
            const profile = _shueProfile(bs.r0, bs.alpha, 64);
            this._bsMesh.geometry.dispose();
            this._bsMesh.geometry = new THREE.LatheGeometry(profile, 56);
            this._bsMesh.userData.r0    = bs.r0;
            this._bsMesh.userData.alpha = bs.alpha;
        }
        if (this._sheathMesh) {
            const profile = _shueProfile(bs.r0, bs.alpha, 48);
            this._sheathMesh.geometry.dispose();
            this._sheathMesh.geometry = new THREE.LatheGeometry(profile, 36);
        }

        // Streamer + magnetopause brightness scales with dynamic pressure;
        // a southward IMF (Bz < 0) brightens reconnection cues by warming
        // the magnetopause toward red.
        const pdyn = mp.pdyn;                              // nPa
        const pdynNorm = Math.max(0, Math.min(1, (pdyn - 0.5) / 8));
        const bzWarm = Math.max(0, Math.min(1, -bz / 12)); // 0..1 as Bz goes negative

        if (this._streamMat) {
            this._streamMat.uniforms.uIntensity.value = 0.35 + 0.85 * pdynNorm;
            this._streamMat.uniforms.uSpeed.value     = 0.05 + (speed / 800) * 0.30;
            const cool = new THREE.Color(0x6cc8ff);
            const hot  = new THREE.Color(0xff7a3a);
            const c = cool.clone().lerp(hot, pdynNorm);
            this._streamMat.uniforms.uColor.value.copy(c);
        }
        if (this._mpMat) {
            this._mpMat.uniforms.uIntensity.value = 0.7 + 0.5 * pdynNorm;
            const calm  = new THREE.Color(0x60d8ff);
            const storm = new THREE.Color(0xff7a90);
            this._mpMat.uniforms.uColor.value.copy(calm.clone().lerp(storm, bzWarm));
        }
        if (this._bsMat) {
            this._bsMat.uniforms.uIntensity.value = 0.7 + 0.5 * pdynNorm;
        }
        if (this._sheathMat) {
            this._sheathMat.opacity = 0.05 + 0.10 * pdynNorm;
        }
    }

    dispose() {
        this._volume?.dispose();
        this._instruments?.dispose();
        cancelAnimationFrame(this._raf);
        this._resizeObs?.disconnect();
        this._onScreenObs?.disconnect();
        if (this._debrisRefreshTimer) {
            clearInterval(this._debrisRefreshTimer);
            this._debrisRefreshTimer = null;
        }
        if (this._debrisVisHandler && typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._debrisVisHandler);
            this._debrisVisHandler = null;
        }
        // CameraController owns OrbitControls + the WASD bindings; its
        // dispose() unwinds both.
        this._controls?.dispose?.();
        this._disposeHover?.();
        this._scene.traverse(o => {
            if (o.geometry) o.geometry.dispose?.();
            if (o.material) {
                const mats = Array.isArray(o.material) ? o.material : [o.material];
                for (const m of mats) {
                    for (const k of Object.keys(m.uniforms || {})) {
                        const v = m.uniforms[k]?.value;
                        if (v && typeof v.dispose === "function") v.dispose();
                    }
                    m.dispose?.();
                }
            }
        });
        this._renderer.dispose();
    }

    // ── Construction ────────────────────────────────────────────────────────

    _initRenderer() {
        this._renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: false,
        });
        this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this._renderer.setClearColor(0x030012, 1);

        // Is the globe actually on screen? Offscreen it is not RENDERED (see
        // _animate), and the volume's quality governor may only learn from
        // frames it can SEE: scrolled down the 5800 px
        // controls column, the canvas is offscreen, frames come back in
        // ~17 ms, and the governor read that as headroom and climbed the
        // march ladder (10 → 16 steps, measured). Scrolling back then cost
        // multi-second frames and froze the page — the smoke test's
        // "overlay toggles" click timed out on exactly that (2026-10-05).
        this._canvasOnScreen = true;
        if (typeof IntersectionObserver !== 'undefined') {
            this._onScreenObs = new IntersectionObserver((entries) => {
                const on = entries.some((e) => e.isIntersecting);
                if (on && !this._canvasOnScreen) this._volume?.resetGovernorClock?.();
                this._canvasOnScreen = on;
            });
            this._onScreenObs.observe(this.canvas);
        }
    }

    _initScene() {
        this._scene = new THREE.Scene();
        const { clientWidth: w, clientHeight: h } = this.canvas;
        const aspect = Math.max(w / Math.max(h, 1), 1);
        this._camera = new THREE.PerspectiveCamera(40, aspect, 0.01, 1000);
        // NOT the Reset home (camera.js resetView: y = 0.65 d). Opening at
        // the home pose was tried on 2026-10-08 so the 2000 km band would fit
        // the taller stage, and it fails tests/upper-atmosphere-camera-feel:
        // the dive kernel's landing blend swings the view 6.3° in one frame
        // from a camera that high (2.49° from here — the gate's 2.5° bound
        // was calibrated on this pose; measured in node on `divePath`). The
        // band fits after a Reset; the dive from home is the kernel's to fix.
        this._camera.position.set(0, 0.6, this.opts.cameraDistance);

        // Sun direction — derived from the actual sub-solar point at
        // the current wall-clock time. The day-side terminator on the
        // EarthSkin texture and the position of the Sun graphic in the
        // solar-wind group both fall out of this vector, so the scene
        // reflects the real Earth–Sun geometry at page-load. _animate()
        // refreshes it every frame; that motion is genuinely glacial
        // (≈15°/hour, the Earth's actual rotation rate relative to the
        // Sun) so the camera reads as static while the geometry remains
        // physically correct.
        const ssp = subSolarPoint(new Date(this._sceneTimeMs()));
        this._sunDir = _subSolarToVec3(ssp.lat, ssp.lon);
    }

    _buildEarth() {
        // Reuse the shared EarthSkin stack so the globe looks identical
        // to earth.html: day/night, ocean specular, topology, atmosphere
        // rim glow, aurora. Clouds intentionally off — the upper-
        // atmosphere page is about what's *above* the troposphere.
        this._skin = new EarthSkin(this._scene, this._sunDir, {
            radius: 1.0,
            icoLevel: EARTH_ICO_DETAIL,
            clouds: false,
            atmosphere: true,
            aurora: true,
        });
        // Fire-and-forget texture load. Scene renders with the safe
        // gray fallback until the CDN responds.
        this._skin.loadTextures().catch(() => {});

        // EarthSkin shader handles its own lighting (sun_dir uniform) so
        // we don't add a DirectionalLight. Still add a faint ambient so
        // the tori look right on the dark side.
        this._scene.add(new THREE.AmbientLight(0x334466, 0.3));
    }

    _buildLayerShells() {
        // Build the five gradient layer shells as *volumetric* sphere
        // sheets — each mesh is the shell's outer sphere; the fragment
        // shader ray-marches the ray segment from there down to the
        // shell's inner radius (or whichever opaque surface intervenes:
        // inner shell, planet, etc.). Because the shader does the volume
        // math we draw the mesh DoubleSide so the shell still renders
        // when the camera is inside it.
        //
        // We render outermost-first so additive blending sums the inner
        // (denser) layers on top, matching the physical optical depth
        // intuition: more density = brighter accumulation at the limb.
        this._shells = [];
        this._shellGroup = new THREE.Group();

        const ordered = [...LAYER_SHELLS].sort((a, b) => b.maxKm - a.maxKm);
        let renderOrder = 0;
        for (const def of ordered) {
            const rOut = 1 + def.maxKm / R_EARTH_KM;
            const rIn  = 1 + def.minKm / R_EARTH_KM;
            const mat = new THREE.ShaderMaterial({
                vertexShader:   LAYER_VERT,
                fragmentShader: LAYER_FRAG,
                uniforms: {
                    uCameraPos: { value: this._camera.position.clone() },
                    uColorLow:  { value: new THREE.Color(def.colorLow) },
                    uColorHigh: { value: new THREE.Color(def.colorHigh) },
                    uOuterR:    { value: rOut },
                    uInnerR:    { value: rIn },
                    uPlanetR:   { value: 1.0 },
                    uOpacity:   { value: def.baseAlpha },
                    uIntensity: { value: 0.7 },
                    uStorm:     { value: 0 },
                    uSunDir:    { value: this._sunDir.clone() },
                    uSwForcing: { value: 0 },
                    uFade:      { value: 1.0 },
                },
                transparent: true,
                // BackSide: draws the far hemisphere when the camera is
                // outside the sphere (giving a fragment for every view
                // ray that passes through the volume) and draws the
                // entire interior when the camera is inside it. Either
                // way the ray-march shader finds the correct shell
                // segment to integrate. FrontSide+BackSide together
                // would render twice and double the additive alpha.
                side: THREE.BackSide,
                depthWrite: false,
                blending: THREE.AdditiveBlending,
            });
            const mesh = new THREE.Mesh(
                new THREE.SphereGeometry(rOut, 96, 64),
                mat,
            );
            mesh.renderOrder = renderOrder++;
            mesh.userData = {
                kind:    'layer-shell',
                id:      def.id,
                name:    def.name,
                minKm:   def.minKm,
                maxKm:   def.maxKm,
                peakKm:  def.peakKm,
                altKm:   def.peakKm,                  // for tooltip ρ readout
                color:   `#${def.colorHigh.toString(16).padStart(6, '0')}`,
            };
            this._shells.push(mesh);
            this._shellGroup.add(mesh);
        }
        this._scene.add(this._shellGroup);
    }

    // ── Continuous volumetric atmosphere ─────────────────────────────────────
    // One ray-march through the whole column instead of five discrete
    // spheres. The shells shaded by local rho at each layer's mid-altitude,
    // which cannot produce limb brightening: that is a geometric property
    // of the integral ∫ρ dl, not of the local density. See the header of
    // upper-atmosphere-volume.js.
    //
    // The two renderers are MUTUALLY EXCLUSIVE — running both stacks two
    // additive passes over the same physical column and doubles the limb.
    // setAtmosphereRender() owns that exclusivity; don't toggle the groups
    // directly.

    _buildAtmosphereVolume() {
        this._volume = new AtmosphereVolume(this._scene, {
            sunDir: this._sunDir,
            // The CHEAPEST rung, deliberately. The governor climbs from
            // here while the frame interval says there is headroom; naming
            // `medium` here is what put a 1.8 s frame on every software
            // renderer and blew the DSMC end-to-end budget.
            quality: VOLUME_QUALITY.floor,
            f107: 150, ap: 15,
        });
        this._atmoRender = 'volume';
        this._shellsWanted = true;
        this._applyAtmosphereVisibility();
    }

    /**
     * Choose which atmosphere renderer is live: 'volume' (continuous
     * ray-march, default) or 'shells' (the five discrete gradient shells).
     * Exactly one is ever visible.
     */
    setAtmosphereRender(mode) {
        if (mode !== 'volume' && mode !== 'shells') return;
        this._atmoRender = mode;
        this._applyAtmosphereVisibility();
    }

    /** The one place that decides which atmosphere renderer is on screen. */
    _applyAtmosphereVisibility() {
        const wanted = this._shellsWanted !== false;
        const onVolume = wanted && this._atmoRender === 'volume';
        this._volume?.setVisible(onVolume);
        if (this._shellGroup) this._shellGroup.visible = wanted && !onVolume;
    }
    getAtmosphereRender() { return this._atmoRender ?? 'volume'; }

    /** Toggle the two physically distinct components of the volume render. */
    setVolumeComponents({ density, airglow } = {}) {
        if (density !== undefined) this._volume?.setDensityVisible(density);
        if (airglow !== undefined) this._volume?.setAirglowVisible(airglow);
    }
    getVolumeComponents() {
        return this._volume?.getComponentVisibility() ?? { density: false, airglow: false };
    }

    /** 'column' | 'composition' | 'anomaly' | 'plasma' (slant TEC) */
    setVolumeMode(mode) { this._volume?.setMode(mode); }
    getVolumeAnomalyAltitude() { return this._volume?.getAnomalyAltitude?.() ?? null; }
    getVolumeMode() { return this._volume?.getMode() ?? 'column'; }
    setVolumeQuality(steps) { this._volume?.setQuality(steps); }
    getVolumeQualityState() { return this._volume?.getQualityState?.() ?? null; }
    getVolumeScaleInfo() { return this._volume?.getScaleInfo() ?? null; }

    // ── Density sub-shells ───────────────────────────────────────────────────
    // The five gradient shells answer "which regime am I in"; the sub-shells
    // answer "how does density fall off *within* the band". They subdivide
    // the 80–2000 km column into thin concentric wireframe spheres at a
    // selectable altitude step (25 / 50 / 100 km), each one's brightness
    // scaled by the local mass density so the operator can read the
    // exponential falloff as a stack of nested shells — and watch the inner
    // shells brighten when a storm inflates the thermosphere. Off by default
    // (built lazily on first show, zero cost until then).

    _buildDensitySubShells() {
        this._subShellGroup   = new THREE.Group();
        this._subShellGroup.visible = false;
        this._subShells       = [];          // [{ mesh, altKm }]
        this._subShellStepKm  = 50;          // default granularity
        this._subShellsVisible = false;
        this._subShellsBuilt  = false;
        this._scene.add(this._subShellGroup);
    }

    /** (Re)build the sub-shell stack at the current step. */
    _rebuildDensitySubShells() {
        // Dispose any existing shells first.
        for (const s of this._subShells) {
            s.mesh.geometry?.dispose();
            s.mesh.material?.dispose();
            this._subShellGroup.remove(s.mesh);
        }
        this._subShells = [];

        const step = this._subShellStepKm;
        // Span the modelled column; skip the very floor (80 km) so the
        // first shell sits just inside the mesosphere band.
        const floorKm = 100, ceilKm = 2000;
        for (let altKm = floorKm; altKm <= ceilKm; altKm += step) {
            const layer = layerForAltitude(altKm);
            const color = layer ? layer.colorHigh : 0x88aaff;
            const r = 1 + altKm / R_EARTH_KM;
            const mat = new THREE.MeshBasicMaterial({
                color,
                wireframe:   true,
                transparent: true,
                opacity:     0.05,
                depthWrite:  false,
                blending:    THREE.AdditiveBlending,
            });
            // Low segment count: the wireframe should read as a coarse
            // density-contour grid, not a dense mesh.
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), mat);
            mesh.renderOrder = 2;
            mesh.userData = { kind: 'density-sub-shell', altKm };
            this._subShells.push({ mesh, altKm });
            this._subShellGroup.add(mesh);
        }
        this._subShellsBuilt = true;
        // Paint opacities against whatever profile we already have.
        if (this._profile) this._paintDensitySubShells(this._profile);
    }

    /** Master toggle for the density sub-shell stack. */
    setDensitySubShellsVisible(on) {
        this._subShellsVisible = !!on;
        if (this._subShellsVisible && !this._subShellsBuilt) {
            this._rebuildDensitySubShells();
        }
        if (this._subShellGroup) this._subShellGroup.visible = this._subShellsVisible;
    }

    getDensitySubShellsVisible() { return !!this._subShellsVisible; }

    /** Set the sub-shell altitude step (km) and rebuild if showing. */
    setDensitySubShellStep(km) {
        const v = Number(km);
        if (!Number.isFinite(v) || v <= 0) return;
        this._subShellStepKm = v;
        if (this._subShellsBuilt) this._rebuildDensitySubShells();
    }

    /**
     * Brightness ∝ local density. Normalised in log space across the whole
     * stack so the dense inner shells pop and the rarefied outer ones stay
     * faint-but-visible — the same dynamic-range trick the gradient shells
     * use, applied per sub-shell.
     */
    _paintDensitySubShells(profile) {
        if (!this._subShells?.length || !profile?.samples?.length) return;
        const logRhos = this._subShells.map(s =>
            Math.log10(Math.max(_nearestRho(profile.samples, s.altKm), 1e-30)));
        const maxLR = Math.max(...logRhos);
        const minLR = Math.min(...logRhos);
        const span  = Math.max(maxLR - minLR, 1.0);
        for (let i = 0; i < this._subShells.length; i++) {
            const t = (logRhos[i] - minLR) / span;        // 0 (thin) … 1 (dense)
            this._subShells[i].mesh.material.opacity = 0.025 + 0.16 * t;
        }
    }

    // ── Isodensity surfaces ──────────────────────────────────────────────────
    // A constant-density shell: the surface where ρ(h) = target. Each one
    // sits at the altitude where the live profile crosses its threshold, so
    // it INFLATES when a storm heats + puffs the thermosphere and CONTRACTS
    // on recovery — the atmosphere visibly "breathing". Three selectable
    // thresholds spanning the LEO drag band; all hidden by default.

    _buildIsodensitySurfaces() {
        this._isoGroup = new THREE.Group();
        this._isoSurfaces = [];      // [{ threshold, mesh, color, altKm }]
        // (threshold kg/m³, colour). Spans the band where operational LEO
        // assets live: ~1e-11 (≈250 km), 1e-12 (≈400 km), 1e-13 (≈600 km).
        const defs = [
            { threshold: 1e-11, color: 0x33e1ff },
            { threshold: 1e-12, color: 0x9b6bff },
            { threshold: 1e-13, color: 0xff66aa },
        ];
        for (const d of defs) {
            const mat = new THREE.MeshBasicMaterial({
                color:       d.color,
                transparent: true,
                opacity:     0.12,
                depthWrite:  false,
                blending:    THREE.AdditiveBlending,
                side:        THREE.FrontSide,
            });
            // Unit base radius so `_positionIsodensitySurfaces` can scale
            // the mesh to exactly r = 1 + alt/R⊕ with no offset.
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.0, 64, 48), mat);
            mesh.visible = false;
            mesh.renderOrder = 2;
            mesh.userData = { kind: 'isodensity-surface', threshold: d.threshold };
            this._isoSurfaces.push({ threshold: d.threshold, mesh, color: d.color, altKm: null });
            this._isoGroup.add(mesh);
        }
        this._isoSelection = 'off';      // 'off' | 'all' | <threshold number>
        this._scene.add(this._isoGroup);
    }

    /**
     * Choose which isodensity surface(s) to show.
     * @param {'off'|'all'|number|string} sel  'off', 'all', or a threshold
     */
    setIsodensityThreshold(sel) {
        // Normalise a numeric string ("1e-12") to a number.
        const num = typeof sel === 'string' && sel !== 'off' && sel !== 'all'
            ? Number(sel) : sel;
        this._isoSelection = num;
        this._applyIsodensityVisibility();
        if (this._profile) this._positionIsodensitySurfaces(this._profile);
    }

    getIsodensitySelection() { return this._isoSelection; }

    /** Current solved altitude (km) per threshold, for a UI readout. */
    getIsodensityAltitudes() {
        const out = {};
        for (const s of this._isoSurfaces) out[s.threshold] = s.altKm;
        return out;
    }

    _applyIsodensityVisibility() {
        for (const s of this._isoSurfaces) {
            const selected =
                this._isoSelection === 'all' ||
                (Number.isFinite(this._isoSelection) &&
                 Math.abs(this._isoSelection - s.threshold) < s.threshold * 0.01);
            // Visibility also requires the surface to be in range (altKm set);
            // _positionIsodensitySurfaces() finalises that.
            s._selected = selected;
            s.mesh.visible = selected && Number.isFinite(s.altKm);
        }
    }

    /**
     * Re-solve each surface's altitude from the live profile and scale its
     * sphere there. A threshold outside the profile's density range hides
     * its surface (no crossing exists).
     */
    _positionIsodensitySurfaces(profile) {
        if (!this._isoSurfaces?.length || !profile?.samples?.length) return;
        for (const s of this._isoSurfaces) {
            const altKm = _altitudeForRho(profile.samples, s.threshold);
            s.altKm = Number.isFinite(altKm) ? altKm : null;
            if (Number.isFinite(altKm)) {
                const r = 1 + altKm / R_EARTH_KM;
                s.mesh.scale.set(r, r, r);
            }
            s.mesh.visible = !!s._selected && Number.isFinite(s.altKm);
        }
    }

    _buildSatelliteRings() {
        // Two-tier overlay:
        //  • _satGroup     — flat reference rings at each altitude. The
        //                    Kármán line (non-orbital) gets only this.
        //  • _satProbeGrp  — moving sprites + inclined orbital paths for
        //                    every entry that has an `orbital` block.
        //
        // The rings are kept around as zoomed-out "altitude shell"
        // indicators; the sprites + paths render the actual inclined
        // orbit at one period worth of points so users see the real
        // geometry instead of a fictitious flat circle.
        this._satGroup     = new THREE.Group();
        this._satProbeGrp  = new THREE.Group();
        this._satProbeGrp.name = 'satellite-probes';
        this._satRings     = [];
        this._satProbes    = {};      // id → { mesh, path, spec, _phase0 }

        for (const sat of SATELLITE_REFERENCES) {
            const r = 1 + sat.altitudeKm / R_EARTH_KM;
            // Slight tilt per ring so they don't all overlap on one plane.
            const tilt = (sat.altitudeKm % 31) * Math.PI / 180;
            const ring = _ringMesh(r, 0.004, _hex(sat.color), sat.orbital ? 0.45 : 0.75);
            ring.rotation.x = Math.PI / 2 + tilt * 0.05;
            ring.rotation.y = tilt * 0.8;
            ring.userData = {
                kind: 'satellite',
                altKm: sat.altitudeKm,
                id: sat.id,
                name: sat.name,
                color: sat.color,
            };
            this._satRings.push(ring);
            this._satGroup.add(ring);

            // For orbital objects, also build a moving probe + an
            // inclined orbital-path polyline.
            if (sat.orbital) this._buildSatelliteProbe(sat);
        }
        this._scene.add(this._satGroup);
        this._scene.add(this._satProbeGrp);
    }

    /**
     * Build a moving satellite probe + an inclined orbital-path
     * polyline for one SATELLITE_REFERENCES entry. The probe is
     * tagged kind='sat-probe' (identical handling for every satellite)
     * with `id` carrying the satellite key so click/tooltip can resolve
     * the right spec.
     *
     * Orbital propagation uses the entry's mean elements directly —
     * good enough for a "visualisation-grade" ground track. A live TLE
     * fetch from /api/celestrak/tle can upgrade the elements after boot.
     */
    _buildSatelliteProbe(spec) {
        const colorHex = _hex(spec.color);
        const altKm    = spec.altitudeKm;
        const r        = 1 + altKm / R_EARTH_KM;

        // ── Probe LOD ────────────────────────────────────────────────
        // Three tiers, swapped automatically by THREE.LOD based on
        // camera distance to the probe (in scene units, where 1 = R⊕):
        //
        //   far   (≥ 0.9)  sphere + halo only — the original "dot" look
        //                   from any zoomed-out camera position.
        //   mid   (≥ 0.06) low-poly recognisable shape — solar panels,
        //                   bus, antennas — readable from a few hundred
        //                   km out (artistic scale).
        //   near  (≥ 0)    the same shape (kept as a separate level so
        //                   we can plug a higher-poly variant later).
        //
        // The LOD is the picker target — userData is set on it so a
        // raycast against any of its children resolves up via the
        // .parent chain in _initTooltip.
        const lod = new THREE.LOD();
        lod.userData = {
            kind:    'sat-probe',
            id:      spec.id,
            name:    spec.name,
            altKm,
            color:   spec.color,
            spec,
            tooltip: spec.description ||
                     'Click to fly the camera here. Drag pressure '
                   + '≈ ½ρv² uses live ρ at the probe\'s current altitude.',
        };

        // Far tier: sphere + halo (original look). Wrapped in a Group
        // so the halo stays a child and follows orientation cleanly.
        const farGrp = new THREE.Group();
        const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(0.012, 14, 10),
            new THREE.MeshBasicMaterial({
                color: colorHex, transparent: true, opacity: 1.0,
            }),
        );
        const halo = new THREE.Mesh(
            new THREE.SphereGeometry(0.026, 14, 10),
            new THREE.MeshBasicMaterial({
                color: colorHex, transparent: true, opacity: 0.25,
                depthWrite: false, blending: THREE.AdditiveBlending,
            }),
        );
        farGrp.add(sphere);
        farGrp.add(halo);

        // Mid + near tiers: recognisable model from satellite-models.js.
        // The high-detail tier is currently identical to mid — kept
        // separate so future poly-count work plugs in cleanly.
        const midGrp = buildSatelliteModel(spec);
        const nearGrp = buildSatelliteModelLow(spec);

        // LOD distance thresholds. Three.js picks the highest-index
        // level whose distance ≤ camera-to-LOD distance; smaller
        // numbers = closer. With camera at ~3.2 R⊕ and probes at
        // ~1.07 R⊕, the default view sees distance ≈ 2.1 → far tier.
        // When the user flies to within ~0.3 R⊕ (≈ 2000 km artistic)
        // we promote to mid; closer than 0.06 R⊕ (≈ 380 km) we render
        // near. Tuned empirically — bump if the swap reads as a pop.
        lod.addLevel(nearGrp, 0);
        lod.addLevel(midGrp,  0.06);
        lod.addLevel(farGrp,  0.30);

        // Seed the probe's position on first paint at one orbital point
        // so it's not stuck at origin until the first animate() tick.
        lod.position.set(r, 0, 0);
        this._satProbeGrp.add(lod);

        // Keep `mesh` as the LOD object — _stepSatellites and the
        // public APIs that read probe.mesh.position keep working.
        const mesh = lod;

        // ── Orbital-path polyline ─────────────────────────────────────
        // 96 points around a full period — closed loop. Drawn in the
        // same satellite-probe group so visibility stays in sync.
        const N = 96;
        const pathPts = new Float32Array(N * 3);
        for (let k = 0; k < N; k++) {
            const tFrac = k / N;
            const p = _propagateKeplerian(spec.orbital, tFrac, r);
            pathPts[k * 3 + 0] = p.x;
            pathPts[k * 3 + 1] = p.y;
            pathPts[k * 3 + 2] = p.z;
        }
        const pathGeo = new THREE.BufferGeometry();
        pathGeo.setAttribute('position', new THREE.BufferAttribute(pathPts, 3));
        const pathMat = new THREE.LineBasicMaterial({
            color: colorHex,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
        });
        const pathLine = new THREE.LineLoop(pathGeo, pathMat);
        pathLine.userData = {
            kind: 'sat-orbit-path', id: spec.id, name: `${spec.name} orbit`,
            color: spec.color, altKm,
            tooltip: `Real-period inclined orbit · i = ${spec.orbital.inclinationDeg}° · `
                   + `period ≈ ${spec.orbital.periodMin.toFixed(1)} min · NORAD ${spec.orbital.noradId}`,
        };
        this._satProbeGrp.add(pathLine);

        // Cache for per-frame propagation. _phase0 randomises the
        // satellite's starting mean-anomaly so all four don't all start
        // at M=0 simultaneously. Phase B: also seed absolute-time
        // anchor fields so _lookupProbePositionAt works from frame 1.
        // The construction-time wall-clock is the epoch; downstream
        // updateFromCelesTrak() may overwrite both fields with the
        // real TLE epoch + sat.mean_anomaly when live data arrives.
        const M0 = spec.orbital.meanAnomalyDeg0 * Math.PI / 180;
        const probe = {
            mesh, pathLine, spec, farGrp,
            _phase0:        M0,
            _M_epoch_rad:   M0,
            _epochMs:       Date.now(),
            _propTable: null,        // populated immediately below
        };
        this._satProbes[spec.id] = probe;
        // Pre-bake a phase-indexed position lookup so the conjunction
        // screener can do O(1) lookups instead of trig calls per step.
        // 256 samples = 1.4° angular resolution = ~22 s for an ~92-min
        // orbit; fine enough for 30-s-step TCA finding.
        this._buildProbeLookup(probe);
    }

    /**
     * Pre-bake a 256-entry (x, y, z) Float32Array of probe positions
     * sampled evenly around the orbital phase. Used by the conjunction
     * screener — _lookupProbePosition turns simulated-time into a
     * position via a single integer division + array read.
     *
     * Re-run after TLE upgrades (orbital elements change) so the
     * lookup table stays consistent with the live mean elements.
     */
    _buildProbeLookup(probe) {
        const N = 256;
        if (!probe._propTable) probe._propTable = new Float32Array(N * 3);
        const r = _probeRadius(probe);
        for (let k = 0; k < N; k++) {
            const tFrac = k / N;
            const p = _propagateKeplerian(probe.spec.orbital, tFrac, r);
            probe._propTable[k * 3 + 0] = p.x;
            probe._propTable[k * 3 + 1] = p.y;
            probe._propTable[k * 3 + 2] = p.z;
        }
        probe._propTableN = N;
    }

    /**
     * Fly the camera to one satellite probe by id. Falls through to
     * the ISS probe if id is omitted (preserves the original
     * .flyToISS() entry point). Auto-switches to fly mode so
     * OrbitControls doesn't yank the camera back to planet centre
     * mid-animation (the Phase 25 bug fix).
     *
     * Pass {follow:true} to engage real per-frame tracking — without
     * it the camera just flies to where the satellite WAS at the
     * moment of click, and the satellite then propagates away.
     */
    flyToSatellite(id = 'iss', durationSec = 1.6, { follow = false } = {}) {
        const probe = this._satProbes?.[id];
        if (!probe) return;
        const pos = probe.mesh.position.clone();
        // Offset behind the velocity-side of the probe so the camera
        // sees it move forward through the layer.
        const radial = pos.clone().normalize();
        const offset = radial.multiplyScalar(0.18);
        const target = pos.clone().add(offset);
        if (this._controls.getMode?.() === 'orbit') {
            this._controls.setMode('fly');
        }
        this.flyTo(target, pos, durationSec);
        if (follow) {
            // Engage follow after the flyTo's smoothstep completes —
            // delay by the animation duration so the spring doesn't
            // fight the fly-in. The timer is GENERATION-checked: a Reset,
            // Top, Stop-follow or mode change made during the fly-in must
            // not be overridden by a lock that lands a second later (that
            // re-lock is how a visitor got stuck chasing the ISS, 2026-10).
            const gen = this._armPendingFollow();
            setTimeout(() => {
                if (gen === this._followGen && this._satProbes?.[id]) this.followSatellite(id);
            }, durationSec * 1000);
        }
    }

    /** A new deferred-follow ticket; any newer camera command invalidates it. */
    _armPendingFollow() { this._followGen = (this._followGen ?? 0) + 1; return this._followGen; }
    /** Cancel a follow that a fly-in has scheduled but not yet engaged. */
    _cancelPendingFollow() { this._followGen = (this._followGen ?? 0) + 1; }
    /** True while a follow is locked OR scheduled to lock at the end of a fly-in. */
    _isFollowTarget(kind, key) {
        const f = this._followId;
        if (!f || f.kind !== kind || (f.id !== key && f.idx !== key)) return false;
        // Stale ids (a fly-in that was cancelled) must not swallow a real click.
        return !!this._controls.isFollowing?.() || !!this._controls.isFlying?.();
    }

    /**
     * Engage per-frame follow on a satellite. The camera tracks the
     * probe's mesh.position (which is updated every frame by the SGP4
     * propagator) — so the operator sees the target stay fixed in
     * view while the world rotates past underneath.
     */
    followSatellite(id) {
        const probe = this._satProbes?.[id];
        if (!probe?.mesh) return;
        this._controls.followObject?.(() => probe.mesh.position);
        this._followId = { kind: 'sat', id };
    }

    /** Stop any active follow (mode + flyTo unchanged). */
    stopFollowing() {
        this._cancelPendingFollow();
        this._controls.stopFollowing?.();
        this._followId = null;
    }
    isFollowing() { return !!this._controls.isFollowing?.(); }
    getFollowTarget() { return this._followId ?? null; }

    /** Reset camera to a default home view. Drops any active follow. */
    resetCameraView() {
        // The escape hatch: whatever the camera is doing — a fly-in with a
        // follow pending, a follow lock, a transit, an explore path — Reset
        // ends it and goes home. Every lock is dropped BEFORE the flight so
        // nothing can re-grab the camera when the tween lands.
        this._cancelPendingFollow();
        this._releaseTransitForCamera('reset');
        this._controls.cancelPath?.('reset');
        this._controls.stopFollowing?.();
        this._followId = null;
        // Home is the PLANET ORBIT frame. Enter it first (keeps the camera
        // where it is, re-aims at the centre) so the tween lands in orbit
        // mode with no second timer racing it.
        if (this._controls.getMode?.() !== 'orbit') this._controls.setMode('orbit');
        this._controls.resetView?.();
    }
    /** Snap to top-down (polar) view. */
    cameraTopView()   { this._cancelPendingFollow(); this._releaseTransitForCamera('top'); this._controls.stopFollowing?.(); this._controls.flyToTopView?.(); this._followId = null; }
    /** A camera preset takes over from the layer transit (which re-applies its pose every frame). */
    _releaseTransitForCamera(reason) {
        if (this._transit?.getState?.().active) this._transit.stop(reason);
    }

    // ── The camera rig (js/upper-atmosphere-camera-rig.js) ───────────────
    // Lens, drag tool, pivot moves and the LIMB VIEWS that separate the
    // layers. The controller applies; the rig kernel computes; the globe
    // only supplies the model inputs (sub-solar point, the explore POIs).

    setCameraDragTool(tool) { return this._controls.setDragTool?.(tool); }
    getCameraDragTool()     { return this._controls.getDragTool?.() ?? 'orbit'; }
    setCameraFov(deg)       { return this._controls.setFov?.(deg); }
    getCameraFov()          { return this._controls.getFov?.() ?? this._camera.fov; }
    /** Pivot-aware zoom (<1 in, >1 out) — the HUD's ＋/− buttons. */
    dollyCamera(factor)     { this._releaseTransitForCamera('zoom'); this._controls.dolly?.(factor); }
    /** Orbit the planet again from where the camera is. */
    recenterCameraPivot()   { this._releaseTransitForCamera('pivot'); this._controls.stopFollowing?.(); this._followId = null; this._controls.recenterPivot?.(); }

    /** The rig's state + what it means (altitude, pivot range, focal length). */
    getCameraRig() {
        const st = this._controls.getRigState?.();
        if (!st) return null;
        return { ...st, ...describeRig({ position: st.position, target: st.target, fovDeg: st.fovDeg }) };
    }

    /** Limb-view sites for the current scene instant — local times + model-placed POIs. */
    getLimbSites() {
        const inp = this._poiInputs();
        let pois = [];
        try { pois = pointsOfInterest(inp); } catch (_) { pois = []; }
        return limbSites({ subSolarLatDeg: inp.subSolarLatDeg, subSolarLonDeg: inp.subSolarLonDeg, pois });
    }

    /**
     * Fly to a telephoto view ACROSS the atmosphere at a site's limb,
     * framing one layer (or any band), and orbit the limb point when it
     * lands. `layerId` is an ATMOSPHERIC_LAYER_SCHEMA id or 'band'
     * (80–2000 km). Returns the pose (or null for an unknown site).
     */
    flyToLimb({ layerId = 'band', siteId = 'dusk', minKm = null, maxKm = null, headingDeg = null, durationSec = 1.8 } = {}) {
        const L = ATMOSPHERIC_LAYER_BY_ID[layerId];
        const lo = Number.isFinite(minKm) ? minKm : L ? L.minKm : EXPLORE.floorKm;
        const hi = Number.isFinite(maxKm) ? maxKm : L ? L.maxKm : EXPLORE.ceilKm;
        const site = this.getLimbSites().find((q) => q.id === siteId);
        if (!site) return null;
        const pose = limbViewPose({ latDeg: site.latDeg, lonDeg: site.lonDeg, minKm: lo, maxKm: hi, headingDeg });
        this._releaseTransitForCamera('limb');
        this._controls.stopFollowing?.();
        this._followId = null;
        this._controls.cancelPath?.('superseded');
        this._controls.limbView?.(pose, { durationSec });
        this._limbView = { layerId, siteId, site, minKm: lo, maxKm: hi, fovDeg: pose.fovDeg };
        this._limbFocus = true;
        return { ...pose, site, layerId };
    }
    getLimbView() { return this._limbView ?? null; }

    // ── The incoming CME (js/upper-atmosphere-cme-layer.js) ──────────────
    /**
     * Show / hide the flux-rope layer. First enable dynamically imports the
     * layer (and, through it, the shared provider + the WASM kernel) so the
     * page pays nothing until asked. While on, the camera may pull back to
     * `CME_VIEW.maxDistanceRe` to see the corridor.
     */
    async setCmeLayerEnabled(on) {
        if (on) {
            if (!this._cme) {
                const { CmeLayer } = await import('./upper-atmosphere-cme-layer.js');
                this._cme ??= new CmeLayer(this._scene, {
                    getSunDir: () => this._sunDir,
                    getGmstRad: (ms) => this._gmstRad(ms),
                    getSceneTimeMs: () => this._sceneTimeMs(),
                    getMagnetopause: () => this._swGeometry?.mp ?? null,
                });
            }
            await this._cme.enable();
            this._controls.setMaxDistance?.(CME_VIEW.maxDistanceRe);
        } else {
            this._cme?.disable();
            this._controls.setMaxDistance?.(28);
        }
        try { window.dispatchEvent(new CustomEvent('ua-cme-layer', { detail: { enabled: !!on } })); } catch (_) { /* no window */ }
        return !!on;
    }
    getCmeLayer() { return this._cme ?? null; }
    isCmeLayerEnabled() { return !!this._cme?.isEnabled?.(); }

    /** Fly to a CME station ('approach' | 'upstream' | 'side') and orbit there. */
    flyToCmeView(kind) {
        const sd = this._sunDir;
        if (!sd) return null;
        const sunDir = [sd.x, sd.y, sd.z];
        const basis = ropeBasisScene(sunDir, eclipticNorthScene(this._gmstRad(this._sceneTimeMs())));
        const pose = cmeViewPose(kind, basis, sunDir);
        if (!pose) return null;
        this._releaseTransitForCamera('cme');
        this._controls.stopFollowing?.();
        this._followId = null;
        this._controls.cancelPath?.('superseded');
        this._controls.limbView?.(pose, { durationSec: kind === 'approach' ? 2.4 : 1.8 });
        this._limbView = null;
        return pose;
    }

    /**
     * Show ONE layer's particle population (null = all). Composes with the
     * per-layer toggles: a layer the user switched off stays off.
     */
    setParticleSolo(layerId = null) {
        this._particleSolo = layerId && this._particles?.[layerId] ? layerId : null;
        this._applyParticleVisibility();
        return this._particleSolo;
    }
    getParticleSolo() { return this._particleSolo ?? null; }
    _applyParticleVisibility() {
        const solo = this._particleSolo ?? null;
        for (const [id, sys] of Object.entries(this._particles || {})) {
            const userOn = this._layerUserVisible?.[id] !== false;
            sys.setVisible(userOn && (!solo || solo === id));
        }
    }

    // ── Phase 26: time-warp + sat-clock control ──────────────────────────
    //
    // Every per-frame satellite propagation multiplies `_clock.getDelta()`
    // by this rate. Default is 1× (real-time — probes sit at their
    // wall-clock positions). The HUD exposes preset multipliers (½, 1,
    // 10, 60, 600, 3600) plus pause + "snap to now"; this method is the
    // single mutation point.

    /**
     * Phase B: all rate / pause / snap state lives on the shared TimeBus.
     * The legacy globe methods below are thin pass-throughs so existing
     * HUD code + tests keep working unchanged. _getSatRate() is the only
     * field still owned by the globe — and it's just a getter on the
     * bus that legacy per-frame paths (none left after Phase B) might
     * still read.
     */
    _getSatRate() { return this._timeBus.getRate(); }

    /** Live-set propagation rate via the bus. Signed; 0 pauses. */
    setSatTimeScale(rate) {
        if (!Number.isFinite(rate)) return;
        this._timeBus.setRate(rate);
    }

    /** UI highlights its active preset chip off this. */
    getSatTimeScale() { return this._timeBus.getRate(); }

    /** Pause / resume / status all delegate to the bus, which owns the
     *  remember-the-prior-rate semantic for resume. */
    pauseSat()    { this._timeBus.pause();  }
    resumeSat()   { this._timeBus.resume(); }
    isSatPaused() { return this._timeBus.getRate() === 0; }

    /**
     * Snap every probe back to its real-time wall-clock position.
     * Phase B: this is now just bus.snapToNow() — simTimeMs jumps to
     * Date.now() and the bus emits a 'jump' event. Every per-frame
     * propagation already reads bus.getSimTime() so the next frame
     * paints probes at their correct real-time positions, no per-
     * probe re-anchoring needed.
     */
    snapSatToWallClock() { this._timeBus.snapToNow(); }

    /** Backwards-compatible wrapper retained for the existing UI button. */
    flyToISS(durationSec = 1.6) {
        return this.flyToSatellite('iss', durationSec);
    }
    /** New: follow ISS (default click target for the HUD's "Visit ISS"). */
    followISS() {
        if (this._controls.getMode?.() === 'orbit') this._controls.setMode('fly');
        this._followId = { kind: 'sat', id: 'iss' };   // pending: a re-click is a no-op
        return this.flyToSatellite('iss', 1.6, { follow: true });
    }

    /**
     * Fly the camera to a specific debris piece by index. Position
     * comes from the cloud's flat position buffer (not a per-piece
     * mesh) since debris are rendered as a single THREE.Points draw
     * call. Also auto-switches into fly mode so the camera anim
     * doesn't get clamped back to the planet centre by OrbitControls.
     */
    flyToDebris(idx, durationSec = 1.6, { follow = false } = {}) {
        if (!this._debrisPositions || !this._debris?.[idx]) return;
        const p = this._debrisPositions;
        const o = idx * 3;
        const debrisPos = new THREE.Vector3(p[o], p[o + 1], p[o + 2]);
        const radial = debrisPos.clone().normalize();
        const offset = radial.multiplyScalar(0.18);
        const target = debrisPos.clone().add(offset);
        if (this._controls.getMode?.() === 'orbit') {
            this._controls.setMode('fly');
        }
        this.flyTo(target, debrisPos, durationSec);
        if (follow) {
            // Debris positions live in a packed Float32Array updated
            // every frame by the catalog propagator. The follow callback
            // reads the live offset each frame — so the camera tracks
            // even rapidly-tumbling LEO fragments.
            const gen = this._armPendingFollow();
            setTimeout(() => { if (gen === this._followGen) this.followDebris(idx); }, durationSec * 1000);
        }
    }

    /** Engage per-frame follow on a debris piece by index. */
    followDebris(idx) {
        if (!this._debrisPositions || !this._debris?.[idx]) return;
        const p = this._debrisPositions;
        const o = idx * 3;
        const tmp = new THREE.Vector3();
        this._controls.followObject?.(() => {
            tmp.set(p[o], p[o + 1], p[o + 2]);
            return tmp;
        });
        this._followId = { kind: 'debris', idx };
    }

    /**
     * Upgrade every orbital probe from hardcoded mean elements to the
     * live TLE for that NORAD ID. Hits the same /api/celestrak/tle
     * Edge proxy that the rest of the repo uses; the proxy parses the
     * raw TLE into { inclination, raan, arg_perigee, mean_anomaly,
     * mean_motion, eccentricity, epoch, period_min, ... } so we don't
     * need to parse anything ourselves.
     *
     * Per satellite:
     *   1. Fetch /api/celestrak/tle?norad=<id>
     *   2. Compute the *current* mean anomaly:
     *        M_now = M_epoch + n · (now − epoch)
     *      where n is the mean motion in rad/s. This pins the probe
     *      to its real orbital position at page-boot time; subsequent
     *      per-frame propagation continues from there.
     *   3. Replace the spec.orbital block in place + rebuild the
     *      orbital-path polyline geometry from the new elements so
     *      visual track + sprite stay coherent.
     *
     * Doesn't apply J2 secular drift to RAAN/argP between epoch and
     * now — for typical TLEs <1 day old this is sub-degree on RAAN
     * for ISS, fine for visual-grade fidelity. A future round can
     * add the Brouwer-Lyddane secular terms if the precision matters.
     *
     * Concurrent fetches via Promise.allSettled — one slow satellite
     * doesn't block the others. Returns the count of upgraded probes
     * for the UI's freshness indicator.
     */
    async _fetchLiveTLEs() {
        if (!this._satProbes) return 0;
        const probes = Object.values(this._satProbes)
            .filter(p => p.spec?.orbital?.noradId);

        const fetchOne = async (probe) => {
            const id = probe.spec.orbital.noradId;
            const ctl = new AbortController();
            const t = setTimeout(() => ctl.abort(), 4000);
            try {
                const r = await fetch(`/api/celestrak/tle?norad=${id}`, {
                    signal: ctl.signal,
                    headers: { Accept: 'application/json' },
                });
                if (!r.ok) throw new Error(`HTTP ${r.status}`);
                const data = await r.json();
                const sat = data?.satellites?.[0];
                if (!sat) throw new Error('no satellites in response');
                this._upgradeProbeFromTLE(probe, sat);
                return { id: probe.spec.id, ok: true };
            } catch (err) {
                return { id: probe.spec.id, ok: false, err };
            } finally {
                clearTimeout(t);
            }
        };

        const results = await Promise.allSettled(probes.map(fetchOne));
        const ok = results.filter(r => r.value?.ok).length;
        // Stash a manifest so the UI's freshness pill knows what's live
        // vs fallback. window event so the UI module doesn't need an
        // explicit hook into globe internals.
        this._tleSummary = {
            total:    probes.length,
            live:     ok,
            fetchedAt: Date.now(),
        };
        try {
            window.dispatchEvent(new CustomEvent('ua-tle-update',
                { detail: this._tleSummary }));
        } catch (_) { /* SSR / no-window — ignore */ }
        return ok;
    }

    /**
     * Apply one parsed TLE to one probe in place. Splits out from the
     * fetch loop so unit tests / future scheduled-refresh paths can
     * call it directly with a mock element set.
     *
     * @param {object} probe   from this._satProbes[id]
     * @param {object} sat     parsed CelesTrak entry — see
     *                         api/celestrak/tle.js parseSingleTle()
     */
    _upgradeProbeFromTLE(probe, sat) {
        const orb = probe.spec.orbital;
        const epochMs = Date.parse(sat.epoch);
        if (!Number.isFinite(epochMs)) return;

        // Mean motion: rev/day → rad/s.
        const n_rad_s = (sat.mean_motion * 2 * Math.PI) / 86400;
        const dtSec = (Date.now() - epochMs) / 1000;
        // Wrap to [0, 2π) so the propagator's tFrac stays clean.
        let M_now_rad = (sat.mean_anomaly * Math.PI / 180) + n_rad_s * dtSec;
        const TAU = 2 * Math.PI;
        M_now_rad = ((M_now_rad % TAU) + TAU) % TAU;

        // Patch the orbital element block. Keep noradId; replace the
        // mean elements + period from the live TLE.
        orb.inclinationDeg   = sat.inclination;
        orb.raanDeg          = sat.raan;
        orb.argPerigeeDeg    = sat.arg_perigee;
        orb.eccentricity     = sat.eccentricity;
        orb.meanAnomalyDeg0  = M_now_rad * 180 / Math.PI;
        orb.periodMin        = sat.period_min;

        // Update the average altitude from apogee/perigee — used by
        // the orbital-path polyline radius and the static ring. For
        // near-circular orbits this is essentially unchanged; for
        // eccentric orbits this is a sensible "shell" altitude.
        // The relay's perigee/apogee are WGS-72 altitudes; the page's are
        // above the 6371 sphere (js/upper-atmosphere-datum.js).
        const meanAltKm = catalogToPageAltKm((sat.apogee_km + sat.perigee_km) / 2);
        if (Number.isFinite(meanAltKm) && meanAltKm > 0) {
            probe.spec.altitudeKm = Math.round(meanAltKm);
        }
        // The real elements, with J2 — what the probe is now propagated
        // by (and SGP4 on the lines once the WASM answers, below).
        const el = meanElements(sat);
        if (el) {
            probe._el = el;
            probe._perifocal = perifocalTable(el);
            probe.spec.altitudeKm = Math.round(el.meanAltKm);
        }

        // Reset the per-frame phase. Legacy field (_phase0) remains
        // populated for any caller that still inspects it, but the
        // per-frame propagation now reads (_M_epoch_rad, _epochMs)
        // directly — anchored at the TLE epoch instead of "now". This
        // makes the same formula work for live wall-clock AND for
        // replay through past simTimeMs values (the operator scrubs
        // backward and sees the actual past orbital phase, not a
        // forward extrapolation pretending to be backward).
        probe._phase0      = M_now_rad;
        probe._M_epoch_rad = sat.mean_anomaly * Math.PI / 180;
        probe._epochMs     = epochMs;

        // Carry the source + epoch into the probe's userData so the
        // tooltip + drag panel can show TLE freshness.
        if (probe.mesh?.userData) {
            probe.mesh.userData.tleSource = 'live';
            probe.mesh.userData.tleEpoch  = sat.epoch;
            // Phase 26: cache the raw mean-element snapshot so
            // snapSatToWallClock() can re-anchor without another
            // CelesTrak round-trip. We only need the four fields the
            // re-anchor math reads: epochMs, mean_motion (rev/day),
            // mean_anomaly (deg at epoch).
            probe.mesh.userData.lastTleSnapshot = {
                epochMs,
                mean_motion:  sat.mean_motion,
                mean_anomaly: sat.mean_anomaly,
            };
        }

        // Stash the raw TLE lines on the probe so the trajectory
        // analyzer can run SGP4 directly without a second fetch.
        if (sat.line1 && sat.line2) {
            probe.tleLines = { line1: sat.line1, line2: sat.line2, epoch: sat.epoch };
            this._attachProbeSgp4(probe, sat.line1, sat.line2);
        }

        // Rebuild the orbital-path polyline from the new elements.
        this._refreshOrbitalPath(probe);
        // And the conjunction-screener lookup table — its sampling is
        // tied to the orbital elements, so a TLE update means stale
        // entries until we regenerate.
        this._buildProbeLookup(probe);
    }

    /** J2 moves a LEO node ~0.2°/h: re-sample a real-element path every 10 sim-min. */
    _refreshProbePathIfStale(probe, ms) {
        if (!Number.isFinite(probe._pathMs) || Math.abs(ms - probe._pathMs) > 10 * 60e3) {
            this._refreshOrbitalPath(probe, ms);
        }
    }

    /**
     * Hand a probe to the SGP4 WASM once it has loaded (the tracker module
     * owns the load). Until then the probe rides its mean elements; the
     * switch is a few km in LEO, never a jump to another plane.
     */
    _attachProbeSgp4(probe, line1, line2) {
        const epochMs = tleEpochMs(line1);
        if (!Number.isFinite(epochMs)) return;
        import('./satellite-tracker.js').then(async (mod) => {
            await mod.whenWasmSettled?.();
            const wasm = mod.getWasmSgp4?.();
            if (!wasm?.propagate_tle) return;
            // Only if the lines still belong to this probe (a later upgrade wins).
            if (probe.tleLines?.line1 !== line1) return;
            try { wasm.propagate_tle(line1, line2, 0); } catch (_) { return; }
            probe._sgp4 = { wasm, line1, line2, epochMs };
        }).catch(() => {});
    }

    /**
     * Re-sample the orbital-path polyline for one probe using its
     * current spec.orbital. Cheap (96 points, no allocations) so
     * we can call it any time elements change.
     */
    _refreshOrbitalPath(probe, atMs = null) {
        const path = probe.pathLine;
        if (!path) return;
        const positions = path.geometry.attributes.position.array;
        const N = positions.length / 3;
        if (probe._el) {
            // Real elements: the instantaneous mean ring with J2 carried to
            // the scene instant — the same curve the suites' rings draw.
            const ms = Number.isFinite(atMs) ? atMs : this._timeBus.getSimTime();
            positions.set(orbitRingInertialScene(probe._el, ms, N));
            probe._pathMs = ms;
            path.geometry.attributes.position.needsUpdate = true;
            path.geometry.computeBoundingSphere();
            return;
        }
        const r = _probeRadius(probe);
        for (let k = 0; k < N; k++) {
            const tFrac = k / N;
            const p = _propagateKeplerian(probe.spec.orbital, tFrac, r);
            positions[k * 3 + 0] = p.x;
            positions[k * 3 + 1] = p.y;
            positions[k * 3 + 2] = p.z;
        }
        path.geometry.attributes.position.needsUpdate = true;
        path.geometry.computeBoundingSphere();
    }

    /**
     * Read the live-TLE summary set by _fetchLiveTLEs. Returns
     * { total, live, fetchedAt } or null if no fetch has resolved yet.
     * UI uses this to paint the "Live TLE · 2h ago" freshness pill.
     */
    /**
     * Lookup raw TLE lines for one tracked probe by id, if they were
     * fetched live. Returns null when the probe is still on fallback
     * mean elements or the spec has no NORAD ID.
     */
    getProbeTle(id) {
        const probe = this._satProbes?.[id];
        return probe?.tleLines || null;
    }

    /**
     * Lightweight metadata bundle for the trajectory analyzer.
     */
    getProbeMeta(id) {
        const probe = this._satProbes?.[id];
        if (!probe) return null;
        return {
            id,
            name:    probe.spec.name,
            color:   probe.spec.color,
            altKm:   probe.spec.altitudeKm,
            noradId: probe.spec.orbital?.noradId,
            inclinationDeg: probe.spec.orbital?.inclinationDeg,
            tleLines: probe.tleLines || null,
        };
    }

    // ── Live-catalog overlay (full active + debris cloud) ────────────────
    // Lazy-instantiated on the first enableCatalogGroup() call. Reuses the
    // shared SatelliteTracker class — its Rust-WASM SGP4 batch path handles
    // tens of thousands of objects per frame. We attach it under the same
    // scene as the rest of the globe so day/night and atmosphere cohorts
    // stay aligned.
    async enableCatalogGroup(group) {
        const tracker = await this._ensureCatalogTracker();
        if (!tracker) return { ok: false, reason: 'tracker init failed' };
        try {
            const added = await tracker.loadGroup(group);
            this._suiteRingsDirty = true;
            const info = tracker._groups?.get?.(group);
            if (info?.error) return { ok: false, reason: String(info.error), total: tracker._satellites.length };
            return { ok: true, count: added ?? 0, total: tracker._satellites.length };
        } catch (err) {
            return { ok: false, reason: String(err?.message || err) };
        }
    }

    /** Hide / forget one catalog group. */
    disableCatalogGroup(group) {
        const t = this._catalogTracker;
        if (!t) return false;
        // SatelliteTracker doesn't expose a per-group remove that
        // truly drops slots; the cheap operation is to toggle visibility.
        // Slots stay registered (cheap on the WASM side) but are not drawn.
        if (t._groups?.has?.(group)) {
            t.setGroupVisible?.(group, false);
        }
        this._suiteRingsDirty = true;
        return true;
    }

    /** Drop a group's registration (a failed load) so the next enable re-fetches. */
    forgetCatalogGroup(group) {
        this._catalogTracker?.forgetGroup?.(group);
        this._suiteElCache?.delete(group);
        this._suiteRingsDirty = true;
    }

    /** Re-show a previously disabled group without re-fetching. */
    showCatalogGroup(group) {
        const t = this._catalogTracker;
        if (!t) return false;
        t.setGroupVisible?.(group, true);
        this._suiteRingsDirty = true;
        return true;
    }

    /** Snapshot of catalog state — used by the toggle-bar status line. */
    getCatalogStatus() {
        const t = this._catalogTracker;
        if (!t) return { total: 0, groups: [] };
        return {
            total: t._satellites?.length || 0,
            groups: Array.from(t._groups || []).map(([name, info]) => ({
                name, count: info.count, visible: info.visible !== false,
            })),
        };
    }

    // ── Satellite suites: rings, ladder, framing ─────────────────────────
    // js/upper-atmosphere-sat-suites.js is the kernel; the dots stay the
    // tracker's SGP4. Everything here is drawn at the SCENE instant.

    /** The instant the catalogue is propagated to (overridable by the spec's negative control). */
    _catalogClockMs() {
        return this._catalogClockOverride ? this._catalogClockOverride() : this._sceneTimeMs();
    }

    /** Mean elements of a loaded suite, parsed once per load (null rows dropped). */
    _suiteElements(group) {
        const t = this._catalogTracker;
        if (!t) return [];
        this._suiteElCache = this._suiteElCache || new Map();
        const info = t._groups?.get?.(group);
        const count = info?.count ?? 0;
        const hit = this._suiteElCache.get(group);
        if (hit && hit.count === count) return hit.els;
        const els = [];
        for (const s of t._satellites) {
            if (s.group !== group) continue;
            const el = meanElements(s.tle);
            if (el) { el.group = group; els.push(el); }
        }
        this._suiteElCache.set(group, { count, els });
        return els;
    }

    _visibleSuites() {
        const t = this._catalogTracker;
        if (!t?._groups) return [];
        return Array.from(t._groups).filter(([, g]) => g.visible !== false && g.count > 0).map(([n]) => n);
    }

    /**
     * Orbit rings for the visible suites: up to `perSuite` members each,
     * chosen across PLANES (`ringSample`), capped at `maxTotal`, as ONE
     * LineSegments draw. Off by default.
     */
    setSuiteRingsVisible(on, { perSuite = 24, maxTotal = 240 } = {}) {
        on = !!on;
        this._suiteRingOpts = { perSuite, maxTotal };
        if (!on) {
            if (this._suiteRings) { this._suiteRings.visible = false; }
            this._suiteRingsOn = false;
            return false;
        }
        this._suiteRingsOn = true;
        if (!this._suiteRings) {
            const geo = new THREE.BufferGeometry();
            const mat = new THREE.LineBasicMaterial({
                vertexColors: true, transparent: true, opacity: 0.38, depthWrite: false,
            });
            this._suiteRings = new THREE.LineSegments(geo, mat);
            this._suiteRings.name = 'suite-rings';
            this._suiteRings.renderOrder = 9;
            this._suiteRings.frustumCulled = false;
            this._scene.add(this._suiteRings);
        }
        this._suiteRings.visible = true;
        this._suiteRingsDirty = true;
        return true;
    }
    areSuiteRingsVisible() { return !!this._suiteRingsOn; }
    /** Mark the ring set stale (a suite was shown, hidden or loaded). */
    invalidateSuiteRings() { this._suiteRingsDirty = true; }

    /** Draw one picked satellite's ring brighter than the suite's. null clears it. */
    setFocusSatellite(norad) {
        this._focusNorad = norad == null ? null : Number(norad);
        this._suiteRingsDirty = true;
        if (this._focusNorad != null && !this._suiteRings) {
            this.setSuiteRingsVisible(true);
            this._suiteRingsOn = false;           // focus ring only
        }
    }

    _stepSuiteRings() {
        const ms = this._catalogClockMs();
        const rings = this._suiteRings;
        // The ring is inertial; J2 moves a LEO node ~0.2°/h, so rebuild
        // when the scene instant has moved 10 min (or the set changed) and
        // otherwise only turn the group by the sidereal angle.
        if (this._suiteRingsDirty || !Number.isFinite(this._suiteRingsMs)
            || Math.abs(ms - this._suiteRingsMs) > 10 * 60e3) {
            this._rebuildSuiteRings(ms);
        }
        rings.rotation.y = ringRotationY(suiteGmstRad(ms));
        rings.visible = !!this._suiteRingsOn || this._focusNorad != null;
    }

    _rebuildSuiteRings(ms) {
        const t = this._catalogTracker;
        const N = 96;
        const picks = [];
        if (t && this._suiteRingsOn) {
            const { perSuite, maxTotal } = this._suiteRingOpts || { perSuite: 24, maxTotal: 240 };
            for (const g of this._visibleSuites()) {
                for (const el of ringSample(this._suiteElements(g), perSuite, ms)) {
                    if (picks.length < maxTotal) picks.push({ el, color: t._groups.get(g).color, focus: false });
                }
            }
        }
        if (t && this._focusNorad != null) {
            const idx = t._indexByNorad?.get?.(this._focusNorad);
            const sat = idx != null ? t._satellites[idx] : null;
            const el = sat ? meanElements(sat.tle) : null;
            if (el) picks.push({ el, color: new THREE.Color(0xffffff), focus: true });
        }
        const pos = new Float32Array(picks.length * N * 6);
        const col = new Float32Array(picks.length * N * 6);
        picks.forEach((p, k) => {
            ringToSegments(orbitRingInertialScene(p.el, ms, N), pos, k * N * 6);
            const c = p.color;
            const gain = p.focus ? 1 : 0.85;
            for (let i = 0; i < N * 2; i++) {
                const o = k * N * 6 + i * 3;
                col[o] = c.r * gain; col[o + 1] = c.g * gain; col[o + 2] = c.b * gain;
            }
        });
        const geo = this._suiteRings.geometry;
        geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        geo.computeBoundingSphere();
        this._suiteRingsMs = ms;
        this._suiteRingsDirty = false;
        this._suiteRingCount = picks.length;
        this._suiteRingNorads = picks.map((p) => p.el.norad);
    }

    /** What the rings currently show (for the panel and the spec). */
    getSuiteRingState() {
        // Readers (the panel's status line) must not see the PREVIOUS set:
        // a toggle marks the rings dirty and the frame loop would only
        // rebuild them on the next frame.
        if (this._suiteRings && this._suiteRingsDirty) this._rebuildSuiteRings(this._catalogClockMs());
        return {
            on: !!this._suiteRingsOn, count: this._suiteRingCount || 0,
            norads: (this._suiteRingNorads || []).slice(), focus: this._focusNorad ?? null,
            builtMs: this._suiteRingsMs ?? null,
        };
    }

    /**
     * The altitude ladder over the visible suites (or `groups`), from MEAN
     * elements — deterministic, available before the first SGP4 tick.
     */
    getSuiteLadder({ groups = null, minKm = 150, maxKm = 2000, binKm = 50 } = {}) {
        const gs = groups || this._visibleSuites();
        const els = gs.flatMap((g) => this._suiteElements(g));
        const ladder = altitudeLadder(els, { minKm, maxKm, binKm });
        ladder.groups = gs.map((g) => {
            const e = this._suiteElements(g);
            const regimes = {};
            for (const el of e) { const r = orbitRegime(el); regimes[r] = (regimes[r] || 0) + 1; }
            return { group: g, count: e.length, outerKm: outerShellKm(e), regimes };
        });
        return ladder;
    }

    /**
     * One-shot framing flight so a whole shell fits the lens: a preset id
     * ('leo' | 'meo' | 'geo'), a number (outer altitude, km), or 'visible'
     * (the visible suites' 95th-percentile apogee). Keeps the current view
     * DIRECTION, lands in the planet orbit frame, and is cancelled by any
     * drag/scroll like every camera flight (the page may START a flight, it
     * may not HOLD the camera).
     */
    frameSatellites(what = 'visible', { durationSec = 1.4 } = {}) {
        let outerKm = null;
        if (typeof what === 'number') outerKm = what;
        else if (what === 'visible') {
            outerKm = outerShellKm(this._visibleSuites().flatMap((g) => this._suiteElements(g)));
        } else outerKm = FRAME_PRESETS.find((p) => p.id === what)?.outerKm ?? null;
        if (!Number.isFinite(outerKm)) return null;
        const cam = this._camera;
        const maxR = this._controls.getMaxDistance?.() ?? 28;
        const f = framingDistance({ outerKm, fovDeg: cam.fov, aspect: cam.aspect, maxR });
        this._cancelPendingFollow();
        this._releaseTransitForCamera('frame');
        this._controls.cancelPath?.('frame');
        this._controls.stopFollowing?.();
        this._followId = null;
        if (this._controls.getMode?.() !== 'orbit') this._controls.setMode('orbit');
        const dir = cam.position.clone();
        if (dir.lengthSq() < 1e-9) dir.set(0, 0.55, 1);
        dir.normalize();
        const up = new THREE.Vector3(0, 1, 0);
        this._controls.flyTo(dir.multiplyScalar(f.distance), new THREE.Vector3(0, 0, 0), durationSec, {
            up, endOrbit: { up, target: new THREE.Vector3(0, 0, 0) },
        });
        this._lastFrame = { outerKm, ...f };
        return this._lastFrame;
    }

    async _ensureCatalogTracker() {
        if (this._catalogTracker) return this._catalogTracker;
        if (this._catalogTrackerLoading) return this._catalogTrackerLoading;
        this._catalogTrackerLoading = (async () => {
            try {
                const mod = await import('./satellite-tracker.js');
                // Earth radius = 1 in scene units; tracker handles km→scene.
                // showOrbits=false avoids per-sat orbit-trail meshes (we
                // do that on the named refs instead).
                // ONE datum (js/upper-atmosphere-datum.js): the tracker
                // scales km by earthRadius / 6378.135, so handing it 1.0 drew
                // every dot at r / 6378.135 in a 6371-km scene — 7 km low
                // against the shells, the probes and the camera readout.
                const tracker = new mod.SatelliteTracker(this._scene, TRACKER_EARTH_RADIUS, {
                    maxSatellites: 35000,
                    showOrbits: false,
                });
                // Make tracker points clickable for analysis. The
                // tracker rebuilds its Points mesh on each add-sats batch,
                // so we keep `_extraHittable` in sync with the live mesh
                // instead of appending stale references.
                // §9.5: nothing at the lens may fill the screen. The shared
                // tracker's dots are world-sized (0.008 R⊕ ≈ 51 km) and
                // untextured — uncapped SQUARES — so a camera chasing a
                // Starlink drew its neighbours as screen-sized tiles. Cap
                // them and give them the page's disc; the orbit view is
                // unchanged (they are 1–3 px there, under the ceiling).
                capPointSize(tracker._dotMat, { maxPx: 6 });
                tracker._dotMat.map = roundDotTexture();
                tracker._dotMat.alphaTest = 0.05;
                tracker._dotMat.needsUpdate = true;
                this._catalogTracker = tracker;
                this._extraHittable = this._extraHittable || [];
                const syncHittable = () => {
                    // Drop any prior catalog mesh and patch in the current
                    // one. Other hittables (debris cloud, satellite
                    // probes) live under different mesh refs so we only
                    // touch the one tagged as the tracker's points mesh.
                    this._extraHittable = this._extraHittable.filter(
                        o => o.userData?.kind !== 'catalog-cloud'
                    );
                    if (tracker._pointsMesh) {
                        tracker._pointsMesh.userData = tracker._pointsMesh.userData || {};
                        tracker._pointsMesh.userData.kind = 'catalog-cloud';
                        this._extraHittable.push(tracker._pointsMesh);
                    }
                };
                syncHittable();
                window.addEventListener('satellites-loaded', syncHittable);
                return tracker;
            } catch (err) {
                console.warn('[upper-atmosphere] catalog tracker init failed:', err);
                this._catalogTrackerLoading = null;
                return null;
            }
        })();
        return this._catalogTrackerLoading;
    }

    /** Page altitude (km above the 6371 sphere) of a tracker record, from its drawn position. */
    _catalogPageAltKm(sat) {
        const p = this._catalogTracker?.getPositionXYZ?.(sat?.tle?.norad_id);
        if (p) {
            const r = Math.hypot(p.x, p.y, p.z);
            if (r > 0.5) return sceneToPageAltKm(r);
        }
        return Number.isFinite(sat?.alt) ? catalogToPageAltKm(sat.alt) : null;
    }

    /** Resolve a catalog raycast hit to a sat record (TLE + name + alt). */
    _resolveCatalogHit(hit) {
        const t = this._catalogTracker;
        if (!t || !hit || hit.object !== t._pointsMesh) return null;
        const sat = t._satellites?.[hit.index];
        if (!sat) return null;
        // A hidden suite keeps its slots (cheap) but draws them in the
        // hidden colour — it must not answer the cursor either.
        if (t._groups?.get?.(sat.group)?.visible === false) return null;
        return {
            kind:   'catalog-point',
            id:     `catalog-${sat.tle?.norad_id ?? hit.index}`,
            name:   sat.tle?.name || `NORAD ${sat.tle?.norad_id ?? '—'}`,
            // PAGE altitude from the drawn radius — the tracker's own
            // `sat.alt` is a WGS-72 altitude (r − 6378.135).
            altKm:  this._catalogPageAltKm(sat),
            color:  '#0cc',
            noradId: sat.tle?.norad_id,
            line1:  sat.tle?.line1,
            line2:  sat.tle?.line2,
            tooltip: `Click to analyze trajectory · alt ${(this._catalogPageAltKm(sat) ?? 0).toFixed(0)} km`,
        };
    }

    getTleSummary() {
        return this._tleSummary || null;
    }

    // ── LEO debris cloud ──────────────────────────────────────────────────
    //
    // Background hazards drawn as a single THREE.Points cloud (one
    // draw call regardless of count). Each piece is propagated with
    // the same phase-indexed lookup-table machinery the named probes
    // use. They feed the conjunction screener so the asset-vs-debris
    // risk surfaces in the panel.
    //
    // Visualization-grade only — operational risk modelling needs the
    // full ~30k-object catalog (see js/satellite-tracker.js). 50 dots
    // gives users visible LEO context without the Kessler-syndrome
    // cost of a quadratic 4-asset × 30k debris screen.

    async _loadDebrisSample({ count = 850 } = {}) {
        // Strategy: balanced per-event fetch with FY-1C heavily represented
        // (it's the largest debris-generating event in history and the
        // most distinctive visual signature in LEO). The previous random-
        // pick from the composite group under-sampled FY-1C; the new path
        // pulls each per-event group separately and applies quotas.
        //
        // Total ≈ 850 dots: 350 FY-1C + 200 C-1408 + 150 IR-33 + 150 C-2251.
        // Each fragment is propagated client-side from real CelesTrak mean
        // elements via the same lookup-table propagator the named probes
        // use, so positions are real-time and tick at the simulated-time
        // rate the user has selected.
        let records = null;
        let byEvent = null;
        let fetchedAt = null;
        try {
            const result = await fetchDebrisByEvent({
                altMinKm: 200, altMaxKm: 1600,
                quotas: this._debrisQuotas || undefined,
            });
            records   = result.records;
            byEvent   = result.byEvent;
            fetchedAt = result.fetchedAt;
        } catch (err) {
            console.debug('[upper-atmosphere] balanced debris fetch failed, falling back to composite:',
                err?.message || err);
            // Fallback path keeps the page useful when one of the four
            // per-event groups is rate-limited or rolling. Random sample
            // from the composite, same shape as before.
            try {
                records = await fetchDebrisSample({ count, altMinKm: 250, altMaxKm: 1500 });
            } catch (err2) {
                console.debug('[upper-atmosphere] composite debris fetch also failed:',
                    err2?.message || err2);
                return;
            }
        }
        if (!records?.length) return;

        // Build one probe entry per debris record. Each gets:
        //   • Spec block with orbital + epoch
        //   • _phase0 set to *current* M (M_epoch + n·dt) so the dot
        //     starts where it should be in real-world right now.
        //   • _propTable for O(1) screener lookup.
        // They live in this._debris (parallel to _satProbes) so they
        // don't pollute satellite drag analysis or the named-probe
        // tooltip pipeline.
        const debris = [];
        for (const rec of records) {
            const probe = this._buildDebrisProbe(rec);
            if (probe) debris.push(probe);
        }
        this._debris = debris;
        if (!debris.length) return;

        this._debrisFetchedAt = fetchedAt ?? Date.now();
        this._buildDebrisCloud(debris);

        // Re-screen now that we have debris in scope.
        this._screenConjunctions();
        try {
            window.dispatchEvent(new CustomEvent('ua-debris-update', {
                detail: {
                    count:     debris.length,
                    byEvent:   byEvent || null,
                    fetchedAt: this._debrisFetchedAt,
                },
            }));
        } catch (_) { /* SSR / no-window — ignore */ }

        // Schedule a periodic refresh so the cloud tracks the live 18 SDS
        // catalog as TLEs are republished (~every 8 h). A 1-hour cadence
        // catches new fragments and updated mean elements without
        // hammering the edge cache. Only schedule once.
        this._scheduleDebrisRefresh();
    }

    /**
     * Periodic refresh: re-pull the per-event debris catalog every
     * `_debrisRefreshMs` (default 1 h) and rebuild the cloud in place.
     * Cheap because the propagator's _phase0 is recomputed from the
     * fresh epoch — so the cloud snaps to real-world positions with no
     * drift on each refresh, and continues propagating in real time
     * between refreshes.
     */
    _scheduleDebrisRefresh() {
        if (this._debrisRefreshTimer) return;
        const interval = this._debrisRefreshMs ?? 60 * 60 * 1000;
        this._debrisRefreshTimer = setInterval(() => {
            // Avoid refreshing while the tab is hidden; resumes on
            // visibilitychange below.
            if (typeof document !== 'undefined' && document.hidden) return;
            this._refreshDebrisSample().catch(err =>
                console.debug('[upper-atmosphere] debris refresh failed:',
                    err?.message || err));
        }, interval);

        // Trigger a refresh on focus when stale (>30 min) so users
        // returning to the tab see fresh debris without waiting for the
        // next interval tick.
        if (typeof document !== 'undefined' && !this._debrisVisHandler) {
            this._debrisVisHandler = () => {
                if (document.hidden) return;
                const ageMs = Date.now() - (this._debrisFetchedAt || 0);
                if (ageMs > 30 * 60 * 1000) {
                    this._refreshDebrisSample().catch(() => {});
                }
            };
            document.addEventListener('visibilitychange', this._debrisVisHandler);
        }
    }

    /**
     * Re-fetch the per-event debris catalog and rebuild the cloud. Called
     * on the periodic refresh tick and on tab-refocus when the cache is
     * stale. Idempotent — safe to call repeatedly.
     */
    async _refreshDebrisSample() {
        let result;
        try {
            result = await fetchDebrisByEvent({
                altMinKm: 200, altMaxKm: 1600,
                quotas: this._debrisQuotas || undefined,
            });
        } catch {
            return;
        }
        if (!result?.records?.length) return;

        const debris = [];
        for (const rec of result.records) {
            const probe = this._buildDebrisProbe(rec);
            if (probe) debris.push(probe);
        }
        if (!debris.length) return;
        this._debris = debris;
        this._debrisFetchedAt = result.fetchedAt;
        this._buildDebrisCloud(debris);
        this._screenConjunctions();
        try {
            window.dispatchEvent(new CustomEvent('ua-debris-update', {
                detail: {
                    count:     debris.length,
                    byEvent:   result.byEvent || null,
                    fetchedAt: this._debrisFetchedAt,
                    refresh:   true,
                },
            }));
        } catch (_) {}
    }

    /**
     * Build one debris probe from a parsed CelesTrak record. Computes
     * M_now from epoch + mean motion (same convention as
     * _upgradeProbeFromTLE), bakes the lookup table, and returns the
     * probe entry. Returns null when the record has bogus elements.
     */
    _buildDebrisProbe(rec) {
        const orb = rec.orbital;
        const epochMs = orb.epoch ? Date.parse(orb.epoch) : NaN;
        if (!Number.isFinite(epochMs) || !Number.isFinite(orb.meanMotionRevPerDay)) {
            return null;
        }
        const n_rad_s = (orb.meanMotionRevPerDay * 2 * Math.PI) / 86400;
        const dtSec   = (Date.now() - epochMs) / 1000;
        const TAU = 2 * Math.PI;
        let M_now = (orb.meanAnomalyDeg0 * Math.PI / 180) + n_rad_s * dtSec;
        M_now = ((M_now % TAU) + TAU) % TAU;

        // Family + size attribution. The catalog assigns:
        //   _family   — known fragmentation event or generic-debris
        //   _size     — small / medium / large (mass + RCS estimate)
        //   _hazardMJ — kinetic energy at typical LEO closing speed
        // Used downstream by the debris cloud (per-vertex color),
        // tooltips, and the family roll-up panel.
        const annot = annotateDebris(rec);

        // The record's REAL elements (M at the TLE epoch, before the legacy
        // "M now" re-anchor below), propagated with J2 — the same kernel the
        // suites' rings use, so a fragment shown both here and in its debris
        // suite is one object, not two (the frozen-node circle put them
        // hundreds of km apart within a day of epoch).
        const el = meanElements({
            norad_id: orb.noradId ?? rec.noradId, epoch: orb.epoch,
            inclination: orb.inclinationDeg, raan: orb.raanDeg, eccentricity: orb.eccentricity,
            arg_perigee: orb.argPerigeeDeg, mean_anomaly: orb.meanAnomalyDeg0,
            mean_motion: orb.meanMotionRevPerDay,
        });

        const probe = {
            spec: {
                id: rec.id,
                name: rec.name,
                // Override the engine's generic pink with the family
                // color so the cloud reads as "debris by source event".
                color: annot.family.color,
                // PAGE altitude: the record's is WGS-72 (perigee/apogee).
                altitudeKm: el ? el.meanAltKm : catalogToPageAltKm(rec.altitudeKm),
                orbital: { ...orb, meanAnomalyDeg0: M_now * 180 / Math.PI },
            },
            _phase0: M_now,
            // Phase B: absolute-time anchor. Anchored at construction
            // wall-clock since M_now is "M at now"; downstream replay
            // / scrub uses (simTimeMs − this epoch) × n to recompute M
            // for any past or future moment.
            _M_epoch_rad: M_now,
            _epochMs:     Date.now(),
            _propTable: null,
            _propTableN: 0,
            _kind: 'debris',
            _el: el,
            _perifocal: el ? perifocalTable(el) : null,
            _family: annot.family,
            _size:   annot.size,
            _hazardMJ: annot.hazardMJ,
            mesh: null,           // debris are points in a shared cloud, not individual meshes
        };
        this._buildProbeLookup(probe);
        return probe;
    }

    /**
     * Build a single THREE.Points cloud for the debris. One draw call
     * regardless of count; per-frame _stepDebris updates positions
     * from the cached lookup tables.
     */
    _buildDebrisCloud(debris) {
        const N = debris.length;
        const positions = new Float32Array(N * 3);
        // Per-vertex color: each debris point inherits its family's
        // signature color from debris-catalog.js. The PointsMaterial
        // is set to vertexColors so the cloud reads as a heatmap of
        // source events instead of a uniform pink swarm.
        const colors    = new Float32Array(N * 3);
        // Per-vertex point size — large rocket bodies render bigger
        // than small ASAT shrapnel, giving a visual hazard hierarchy.
        const sizes     = new Float32Array(N);

        // Seed with current positions so first paint isn't at origin.
        // Phase B: absolute-time lookup; downstream _stepDebris reuses
        // the same helper each frame.
        const simTimeMs = this._timeBus.getSimTime();
        const gmst = this._gmstRad(simTimeMs);
        const _tmpColor = new THREE.Color();
        for (let i = 0; i < N; i++) {
            const p = _eciSceneToEarthFixed(_lookupProbePositionAt(debris[i], simTimeMs), gmst);
            positions[i * 3]     = p.x;
            positions[i * 3 + 1] = p.y;
            positions[i * 3 + 2] = p.z;

            const fam = debris[i]._family;
            _tmpColor.set(fam?.color || '#ff7099');
            colors[i * 3]     = _tmpColor.r;
            colors[i * 3 + 1] = _tmpColor.g;
            colors[i * 3 + 2] = _tmpColor.b;

            sizes[i] = debris[i]._size?.pointPx ?? 0.014;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
        const mat = new THREE.PointsMaterial({
            vertexColors: true,
            // 2.4× the previous size so the cloud reads as "hazard" at the
            // default 3.2 Earth-radii camera distance instead of needing
            // the user to zoom in.
            size:         0.034,
            sizeAttenuation: true,
            transparent: true,
            // Bumped opacity so the additive blend doesn't wash the dots
            // out against the day-side Earth.
            opacity:     1.0,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
            map:         roundDotTexture(),
        });
        // 0.034 R⊕ is a 217 km sprite: a chase or transit camera inside the
        // LEO shell drew debris as squares tens of pixels wide.
        capPointSize(mat, { maxPx: 10 });
        if (this._debrisCloud) {
            // Re-load: dispose the old.
            this._satProbeGrp?.remove(this._debrisCloud);
            this._debrisCloud.geometry.dispose();
            this._debrisCloud.material.dispose();
        }
        this._debrisCloud = new THREE.Points(geom, mat);
        this._debrisCloud.frustumCulled = false;
        this._debrisCloud.userData = {
            kind: 'debris-cloud',
            id:   'debris',
            name: `LEO debris sample (n=${N})`,
            tooltip: 'Random sample of CelesTrak debris in the 350–900 km '
                   + 'altitude band. Visualization context only — full '
                   + 'risk modelling needs the complete catalog.',
        };
        this._debrisPositions = positions;
        this._satProbeGrp.add(this._debrisCloud);
    }

    /**
     * Per-frame debris position update. Reads the same absolute
     * simTimeMs as _stepSatellites — debris + named probes stay
     * coherent across all rate / scrub / replay states.
     */
    _stepDebris() {
        if (!this._debris?.length || !this._debrisPositions) return;
        const simTimeMs = this._timeBus.getSimTime();
        // Inertial lookup → Earth-fixed scene, see _stepSatellites.
        const gmst = this._gmstRad(simTimeMs);
        const c = Math.cos(gmst), s = Math.sin(gmst);
        const pos = this._debrisPositions;
        for (let i = 0; i < this._debris.length; i++) {
            const p = _lookupProbePositionAt(this._debris[i], simTimeMs);
            const o = i * 3;
            pos[o]     = c * p.x - s * p.z;
            pos[o + 1] = p.y;
            pos[o + 2] = s * p.x + c * p.z;
        }
        this._debrisCloud.geometry.attributes.position.needsUpdate = true;
    }

    /** Count of currently-tracked debris pieces. UI uses this for the
     *  panel header. Returns 0 if the fetch hasn't resolved yet. */
    getDebrisCount() { return this._debris?.length ?? 0; }

    /**
     * Roll-up of the loaded debris sample by source-event family.
     * Each entry is { family, count, mediumEnergyMJ }, sorted by count
     * desc. Used by the Debris Families UI panel.
     */
    getDebrisFamilyBreakdown() {
        return summariseByFamily(this._debris || []);
    }

    /**
     * Returns metadata for the i-th debris piece — used by the tooltip
     * pipeline (which has the index from the picked vertex). The
     * shape mirrors what the conjunction-watch row needs:
     *   { name, noradId, altKm, family:{id,name,color,year},
     *     size:{class,rangeM,massKg}, hazardMJ }
     */
    getDebrisMetaByIndex(idx) {
        const d = this._debris?.[idx];
        if (!d) return null;
        return {
            name:      d.spec.name,
            noradId:   d.spec.orbital?.noradId,
            altKm:     d.spec.altitudeKm,
            family:    d._family
                ? { id: d._family.id, name: d._family.name,
                    color: d._family.color, year: d._family.year }
                : null,
            size:      d._size
                ? { class: d._size.class, rangeM: d._size.rangeM,
                    massKg: d._size.massKg }
                : null,
            hazardMJ:  d._hazardMJ ?? 0,
        };
    }

    // ── Constellation overlays ───────────────────────────────────────────
    //
    // Render one or more major constellations as faint distinct point
    // clouds. Each constellation gets its own THREE.Points so toggling
    // is a single mesh.visible flip. Positions come from
    // constellation-catalog.js's spawnConstellationPositions(), which
    // synthesises Walker-Delta element sets — no live TLE fetch.
    //
    // Operational modelling needs the live catalog (see
    // js/satellite-tracker.js); these overlays exist purely to give
    // the user spatial intuition for "where do the big constellations
    // live, relative to my orbit + the debris clouds."

    /**
     * Toggle a constellation overlay on/off. Lazily builds the cloud
     * on first enable and caches it; subsequent toggles are O(1). When
     * the constellation has a `.meo: true` flag (GPS / Galileo /
     * GLONASS / BeiDou), the cloud is built but the camera distance
     * may need expanding to see it — we don't move the camera here.
     *
     * @param {string} id          constellation id (see CONSTELLATIONS)
     * @param {boolean} visible
     * @returns {boolean}          whether the call succeeded
     */
    setConstellationVisible(id, visible) {
        const c = CONSTELLATIONS.find(c => c.id === id);
        if (!c) return false;
        this._constellationClouds = this._constellationClouds || {};
        let cloud = this._constellationClouds[id];
        if (!cloud && visible) {
            cloud = this._buildConstellationCloud(c);
            this._constellationClouds[id] = cloud;
        }
        if (cloud) cloud.cloud.visible = visible;
        return true;
    }

    /** Returns a list of constellation ids currently visible. */
    getConstellationsVisible() {
        const out = [];
        const all = this._constellationClouds || {};
        for (const id in all) if (all[id].cloud.visible) out.push(id);
        return out;
    }

    /**
     * Build a {cloud, probes} entry for one constellation. Each probe
     * has the same shape as a debris probe (with _kind = 'sat'), so
     * the per-frame _stepConstellations loop can drive it through the
     * standard _lookupProbePosition pathway.
     */
    _buildConstellationCloud(c) {
        const recs = spawnConstellationPositions(c);
        const probes = recs.map(rec => {
            const orb = rec.orbital;
            const TAU = 2 * Math.PI;
            const M_now = ((orb.meanAnomalyDeg0 * Math.PI / 180) % TAU + TAU) % TAU;
            const probe = {
                spec: {
                    id: rec.id,
                    name: c.name,
                    color: rec.color,
                    // Shell altitudes are QUOTED in the catalogue convention
                    // (its period uses 6378.135 + h): one radius for both.
                    altitudeKm: catalogToPageAltKm(rec.altitudeKm),
                    orbital: { ...orb, meanAnomalyDeg0: M_now * 180 / Math.PI },
                },
                _rScene: catalogAltToScene(rec.altitudeKm),
                _phase0: M_now,
                // Phase B absolute-time anchor (same rationale as
                // _satProbes / debris paths above).
                _M_epoch_rad: M_now,
                _epochMs:     Date.now(),
                _propTable: null,
                _propTableN: 0,
                _kind: 'constellation',
                _constellationId: c.id,
                mesh: null,
            };
            this._buildProbeLookup(probe);
            return probe;
        });

        const N = probes.length;
        const positions = new Float32Array(N * 3);
        // Phase B: seed initial positions from bus-driven absolute time.
        const simTimeMs = this._timeBus.getSimTime();
        const gmst = this._gmstRad(simTimeMs);
        for (let i = 0; i < N; i++) {
            const p = _eciSceneToEarthFixed(_lookupProbePositionAt(probes[i], simTimeMs), gmst);
            positions[i * 3]     = p.x;
            positions[i * 3 + 1] = p.y;
            positions[i * 3 + 2] = p.z;
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
            color:       new THREE.Color(c.color),
            size:        0.012,
            sizeAttenuation: true,
            transparent: true,
            opacity:     0.55,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
            map:         roundDotTexture(),
        });
        capPointSize(mat, { maxPx: 8, fadeNear: false });
        const cloud = new THREE.Points(geom, mat);
        cloud.frustumCulled = false;
        cloud.userData = {
            kind: 'constellation',
            id:   c.id,
            name: `${c.name} (${c.operator}) — ${c.countActive} active`,
            tooltip: `${c.name}: ${c.summary}`,
        };
        // Mount on the same group as debris so it inherits any
        // global toggling we add later.
        this._satProbeGrp.add(cloud);

        return { cloud, probes, positions };
    }

    /** Per-frame: advance every visible constellation cloud's points. */
    _stepConstellations() {
        const all = this._constellationClouds;
        if (!all) return;
        // Phase B: absolute-time read from the shared bus, same as
        // _stepSatellites + _stepDebris — every orbital object on the
        // page is rendered against ONE canonical simTimeMs.
        const simTimeMs = this._timeBus.getSimTime();
        const gmst = this._gmstRad(simTimeMs);
        const c = Math.cos(gmst), s = Math.sin(gmst);
        for (const id in all) {
            const entry = all[id];
            if (!entry.cloud.visible) continue;
            const probes = entry.probes;
            const pos = entry.positions;
            for (let i = 0; i < probes.length; i++) {
                const p = _lookupProbePositionAt(probes[i], simTimeMs);
                const o = i * 3;
                pos[o]     = c * p.x - s * p.z;
                pos[o + 1] = p.y;
                pos[o + 2] = s * p.x + c * p.z;
            }
            entry.cloud.geometry.attributes.position.needsUpdate = true;
        }
    }

    /**
     * Build the hover-highlight ring used to disambiguate which dot
     * the tooltip is describing. 50 pink dots all look the same; the
     * cyan reticle gives the user a clear visual anchor. Ring orients
     * perpendicular to the view direction each frame (always face-on)
     * + pulses subtly so the eye lands on it immediately.
     */
    _buildDebrisHighlight() {
        const geom = new THREE.TorusGeometry(0.025, 0.0028, 8, 32);
        const mat  = new THREE.MeshBasicMaterial({
            color:       0x00ffe6,
            transparent: true,
            opacity:     0.0,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        this._debrisHighlight = new THREE.Mesh(geom, mat);
        this._debrisHighlight.visible = false;
        this._debrisHighlight.frustumCulled = false;
        this._debrisHighlight.userData = {
            kind:    'debris-highlight',
            tooltip: 'Currently-hovered debris piece.',
        };
        this._scene.add(this._debrisHighlight);
    }

    /**
     * Per-frame: keep the highlight ring stuck to the hovered debris
     * piece's live position + face-on to the camera. Reads
     * _hoveredDebrisIdx (set by the tooltip pipeline) and pulses the
     * ring scale slightly to draw the eye.
     */
    _updateDebrisHighlight(elapsedSec) {
        if (!this._debrisHighlight) return;
        const idx = this._hoveredDebrisIdx;
        if (!Number.isFinite(idx) || !this._debrisPositions
            || !this._debris?.[idx]) {
            // Smoothly fade out instead of hard-hide so the ring
            // doesn't pop when the cursor leaves the dot.
            const m = this._debrisHighlight.material;
            m.opacity = Math.max(0, m.opacity - 0.12);
            this._debrisHighlight.visible = m.opacity > 0.01;
            return;
        }
        const o = idx * 3;
        const p = this._debrisPositions;
        this._debrisHighlight.position.set(p[o], p[o + 1], p[o + 2]);
        // Face-on to the camera: ring plane perpendicular to view ray.
        this._debrisHighlight.lookAt(this._camera.position);
        // Subtle pulse — sin(2π · 1.4 Hz · t) at ±10 % scale.
        const s = 1 + 0.10 * Math.sin(elapsedSec * 8.8);
        this._debrisHighlight.scale.setScalar(s);
        const m = this._debrisHighlight.material;
        m.opacity = Math.min(0.9, m.opacity + 0.18);
        this._debrisHighlight.visible = true;
    }

    _buildAltitudeRing() {
        this._ring = _ringMesh(1, 0.0045, 0x00ffe6, 0.85);
        this._ring.rotation.x = Math.PI / 2;
        this._ring.rotation.y = 0.4;
        this._scene.add(this._ring);
    }

    /**
     * Mesosphere phenomena + thermospheric currents — the missing
     * "middle atmosphere" visualisation layer between the rim glow and
     * the auroral oval.
     *
     * Built once; intensity + visibility tracked from setState() so the
     * NLC band only lights up during the local hemisphere's summer
     * window, the equatorial electrojet brightens with EUV (F10.7), and
     * the auroral electrojet ring scales with Ap.
     *
     *   • NLC band   — two thin polar discs at 83 km, lat |φ| > 55°,
     *                  cyan, summer-hemisphere-only intensity.
     *   • EEJ ring   — equatorial electrojet at 110 km on the equator,
     *                  yellow-green, dayside-tilted (the real EEJ is
     *                  daylit-only but a full ring reads cleaner).
     *   • Sq vortex pair — paired markers near ±30° lat at 110 km on
     *                  the dayside, showing the classic two-cell Sq
     *                  current system.
     *   • Auroral EJ — magenta torus at 110 km along the auroral oval
     *                  centerline — the visible analogue of the AE/AL
     *                  current intensity.
     *   • Meteor flux — 200 short streaks in the 80-100 km mesosphere
     *                  hinting at the diurnal sporadic-meteor input.
     */
    _buildAtmosphericPhenomena() {
        this._phenomenaGroup = new THREE.Group();
        this._phenomenaGroup.name = 'atmospheric-phenomena';

        // ── Noctilucent cloud caps (mesopause, ~83 km) ────────────────
        // One thin torus per polar cap. The torus is centred on the y
        // axis at sin(latRefDeg) and given a major radius cos(latRefDeg)
        // so the ring lives at lat = latRefDeg on a sphere of radius
        // (1 + 83/R_E). Keeping these as simple rings avoids the cost
        // of a custom polar-cap shell.
        const rNlc = 1 + 83 / R_EARTH_KM;
        const latRef = 65 * Math.PI / 180;
        const nlcMajor = rNlc * Math.cos(latRef);
        const nlcY     = rNlc * Math.sin(latRef);
        this._nlcGroup = new THREE.Group();
        this._nlcGroup.name = 'nlc-band';
        for (const sign of [+1, -1]) {
            const ring = _ringMesh(nlcMajor, 0.0024, 0x9eecff, 0.0);
            ring.position.y = nlcY * sign;
            // Already lying in xz plane via _ringMesh; that matches a
            // latitude line, so no extra rotation is needed.
            ring.userData = {
                kind: 'nlc-band',
                hemisphere: sign > 0 ? 'N' : 'S',
                tooltip: 'Noctilucent clouds — water-ice particles at ~83 km. '
                       + 'Visible only in the summer-hemisphere mesopause window '
                       + '(~50-65° lat, dawn/dusk twilight).',
            };
            this._nlcGroup.add(ring);
        }
        this._phenomenaGroup.add(this._nlcGroup);

        // ── Equatorial electrojet (EEJ, ~110 km, ±3° lat) ─────────────
        // Single bright ring on the geographic equator at 110 km. The
        // real EEJ is a narrow eastward jet centred on the magnetic
        // equator with a ±3° half-width — visualisation-grade is fine.
        const rEej = 1 + 110 / R_EARTH_KM;
        this._eejRing = _ringMesh(rEej, 0.0030, 0xc0ff60, 0.18);
        this._eejRing.userData = {
            kind: 'eej',
            tooltip: 'Equatorial Electrojet — eastward dayside ionospheric current '
                   + 'at ~110 km, driven by the daily E×B tidal dynamo. '
                   + 'Brightens with F10.7 (EUV ionisation).',
        };
        this._phenomenaGroup.add(this._eejRing);

        // ── Auroral electrojet ring (AE/AL surrogate, ~110 km) ────────
        // Pair of rings at lat ±67° on the same 110 km shell. Brightens
        // with Ap and modulates with substorm phase from the substorm
        // controller.
        const aeLat = 67 * Math.PI / 180;
        const aeMajor = rEej * Math.cos(aeLat);
        const aeY     = rEej * Math.sin(aeLat);
        this._aeGroup = new THREE.Group();
        this._aeGroup.name = 'ae-rings';
        for (const sign of [+1, -1]) {
            const ring = _ringMesh(aeMajor, 0.0028, 0xff6dd2, 0.12);
            ring.position.y = aeY * sign;
            ring.userData = {
                kind: 'ae-ring',
                hemisphere: sign > 0 ? 'N' : 'S',
                tooltip: 'Auroral Electrojet — westward (AL) and eastward (AU) '
                       + 'currents at ~110 km along the auroral oval. '
                       + 'Brightens with Ap; intensifies during substorm expansion.',
            };
            this._aeGroup.add(ring);
        }
        this._phenomenaGroup.add(this._aeGroup);

        // ── Sq quiet-time vortex markers (~110 km, dayside ±30° lat) ──
        // Two soft glowing spheres marking the centres of the daytime
        // Sq current loops. Visualisation-only — the real Sq vortex is
        // a 2-D current-system that shifts with local time.
        this._sqGroup = new THREE.Group();
        this._sqGroup.name = 'sq-vortices';
        const sqLat = 30 * Math.PI / 180;
        const sqMajor = rEej * Math.cos(sqLat);
        const sqY     = rEej * Math.sin(sqLat);
        for (const sign of [+1, -1]) {
            const sphere = new THREE.Mesh(
                new THREE.SphereGeometry(0.020, 18, 14),
                new THREE.MeshBasicMaterial({
                    color: 0xfff0a8,
                    transparent: true,
                    opacity: 0.0,
                    blending: THREE.AdditiveBlending,
                    depthWrite: false,
                }),
            );
            sphere.userData = {
                _sign:   sign,
                _major:  sqMajor,
                _y:      sqY * sign,
                kind:    'sq-vortex',
                hemisphere: sign > 0 ? 'N' : 'S',
                tooltip: 'Sq current cell — daytime ionospheric dynamo vortex centre. '
                       + 'Two cells (one per hemisphere) drive a ~30 nT '
                       + 'magnetic-field perturbation at the surface.',
            };
            this._sqGroup.add(sphere);
        }
        this._phenomenaGroup.add(this._sqGroup);

        // ── Mesospheric meteor flux (80-100 km, point streaks) ────────
        // Static Points cloud — positions are chosen on a thin spherical
        // shell at altitudes 80-100 km. Visual only; per-frame phase is
        // baked into the shader via a sin(time + offset) opacity term so
        // points blink as if they were ionising trails.
        const meteorN = 240;
        const positions = new Float32Array(meteorN * 3);
        const phases    = new Float32Array(meteorN);
        for (let i = 0; i < meteorN; i++) {
            const u = Math.random();
            const v = Math.random();
            const theta = 2 * Math.PI * u;
            const phi   = Math.acos(2 * v - 1);
            const altKm = 80 + 20 * Math.random();
            const r = 1 + altKm / R_EARTH_KM;
            positions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = r * Math.cos(phi);
            positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
            phases[i] = Math.random() * Math.PI * 2;
        }
        const meteorGeo = new THREE.BufferGeometry();
        meteorGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        meteorGeo.setAttribute('aPhase',   new THREE.BufferAttribute(phases, 1));
        const meteorMat = new THREE.ShaderMaterial({
            uniforms: {
                uTime:      { value: 0 },
                uIntensity: { value: 0.0 },
            },
            vertexShader: /* glsl */`
                attribute float aPhase;
                uniform float uTime;
                varying float vBlink;
                void main() {
                    float blink = 0.5 + 0.5 * sin(uTime * 2.0 + aPhase * 6.28);
                    vBlink = pow(blink, 4.0);
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    gl_Position = projectionMatrix * mv;
                    gl_PointSize = 1.5 + 2.5 * vBlink;
                }
            `,
            fragmentShader: /* glsl */`
                uniform float uIntensity;
                varying float vBlink;
                void main() {
                    vec2 uv = gl_PointCoord - vec2(0.5);
                    float r = length(uv);
                    if (r > 0.5) discard;
                    float a = (1.0 - r * 2.0) * vBlink * uIntensity;
                    gl_FragColor = vec4(1.0, 0.85, 0.5, a);
                }
            `,
            transparent: true,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        this._meteorPoints = new THREE.Points(meteorGeo, meteorMat);
        this._meteorPoints.userData = {
            kind:    'meteor-flux',
            tooltip: 'Sporadic-meteor mass-deposition zone (80-100 km). '
                   + '~10 t/day worldwide; lifts metallic-ion layers. '
                   + 'Brightens during the major showers (Perseids, Geminids).',
        };
        this._phenomenaGroup.add(this._meteorPoints);

        this._scene.add(this._phenomenaGroup);

        // Seed initial intensities — refined by setState().
        this._updateAtmosphericPhenomena({
            f107: 150, ap: 15,
            monthIdx: new Date().getUTCMonth(),
        });
    }

    /**
     * Drive the phenomena layer's per-element intensities from the
     * current (F10.7, Ap) state plus the calendar month (for NLC
     * seasonality). Called from setState() and once at boot.
     */
    _updateAtmosphericPhenomena({ f107 = 150, ap = 15, monthIdx = null } = {}) {
        if (!this._phenomenaGroup) return;
        const m = (monthIdx == null) ? new Date().getUTCMonth() : monthIdx;

        // NLC seasonality — peaks ~20 d after summer solstice.
        // North hemisphere peak: late June (m≈5.7); south: late December.
        const nlcWindow = (peakM) => {
            const d = Math.abs(((m - peakM + 12) % 12));
            const dist = Math.min(d, 12 - d);
            return Math.max(0, Math.cos(dist / 1.5 * Math.PI / 2));
        };
        const nlcN = nlcWindow(5.7);
        const nlcS = nlcWindow(11.7);
        if (this._nlcGroup) {
            this._nlcGroup.children.forEach(ring => {
                const isN = ring.userData.hemisphere === 'N';
                ring.material.opacity = (isN ? nlcN : nlcS) * 0.55;
            });
        }

        // Equatorial electrojet brightens with F10.7 (EUV → conductivity)
        // and dampens slightly during the strongest storms (counter-EEJ
        // events around noon).
        if (this._eejRing) {
            const eejBase = Math.min(1, Math.max(0, (f107 - 70) / 200));
            const counter = ap > 100 ? 0.4 : 1.0;          // proxy for CEJ
            this._eejRing.material.opacity = 0.18 + 0.55 * eejBase * counter;
        }

        // Auroral electrojet rings track Ap (storm intensity).
        if (this._aeGroup) {
            const ae = Math.min(1, ap / 100);
            this._aeGroup.children.forEach(r => {
                r.material.opacity = 0.10 + 0.65 * ae;
            });
        }

        // Sq vortex strength scales with EUV ionisation (F10.7) and
        // *declines* during storms (storm-time ionospheric dynamo
        // disruption).
        if (this._sqGroup) {
            const sq = Math.min(1, Math.max(0, (f107 - 70) / 180));
            const stormDamp = 1 / (1 + ap / 80);
            this._sqGroup.children.forEach(s => {
                s.material.opacity = 0.30 * sq * stormDamp;
            });
        }

        // Meteor-flux blink intensity — slight diurnal modulation handled
        // in the shader, but the master brightness rides at a fixed
        // baseline so users always see something.
        if (this._meteorPoints) {
            this._meteorPoints.material.uniforms.uIntensity.value = 0.85;
        }

        // Cache so the per-frame _stepPhenomena keeps Sq vortices on the
        // dayside as the Earth rotates the sun-direction.
        this._phenomenaState = { f107, ap, monthIdx: m };
    }

    /**
     * Per-frame update for phenomena — slides Sq vortices to track
     * local-noon (subsolar longitude) and ticks the meteor shader's
     * uTime so the points blink. Cheap; runs every frame.
     */
    _stepPhenomena(elapsedSec) {
        if (!this._phenomenaGroup) return;
        if (this._meteorPoints) {
            this._meteorPoints.material.uniforms.uTime.value = elapsedSec;
        }
        if (this._sqGroup && this._sunDir) {
            // Place each vortex on the dayside (along +sun direction)
            // at lat ±30° on the 110 km shell. Use the sun direction
            // already cached on the globe (subsolar geometry).
            const sun = this._sunDir.clone().normalize();
            // Build a frame: y-up = world Y, x = projection of sun on
            // the equatorial plane.
            const eqSun = new THREE.Vector3(sun.x, 0, sun.z);
            if (eqSun.lengthSq() < 1e-6) eqSun.set(1, 0, 0);
            eqSun.normalize();
            for (const s of this._sqGroup.children) {
                const sign = s.userData._sign;
                const major = s.userData._major;
                const y     = s.userData._y;
                s.position.set(eqSun.x * major, y, eqSun.z * major);
            }
        }
    }

    _buildSolarWind() {
        // Sun-aligned group — local +Y points along the sun direction so
        // LatheGeometry's axis of revolution matches the sun-Earth line.
        // We orient with a quaternion that maps (0,1,0) → _sunDir.
        this._swGroup = new THREE.Group();
        this._swGroup.name = 'solarWind';
        const yAxis = new THREE.Vector3(0, 1, 0);
        const q = new THREE.Quaternion().setFromUnitVectors(yAxis, this._sunDir);
        this._swGroup.quaternion.copy(q);

        // Initial standoff distances (climatology — refined when
        // setSolarWind() lands).
        const mp0 = computeShue(SW_DEFAULTS.density, SW_DEFAULTS.speed, SW_DEFAULTS.bz);
        const bs0 = computeBowShock(mp0.r0, mp0.alpha);
        this._swGeometry = { mp: mp0, bs: bs0 };

        // ── Magnetosheath fill (between bow shock and magnetopause) ─────
        const sheathProfile = _shueProfile(bs0.r0, bs0.alpha, 48);
        const sheathGeo = new THREE.LatheGeometry(sheathProfile, 36);
        this._sheathMat = new THREE.MeshBasicMaterial({
            color:       0xff9944,
            transparent: true,
            opacity:     0.07,
            side:        THREE.BackSide,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        this._sheathMesh = new THREE.Mesh(sheathGeo, this._sheathMat);
        this._sheathMesh.renderOrder = 2;
        this._sheathMesh.userData = {
            kind:    'magnetosheath',
            id:      'magnetosheath',
            name:    'Magnetosheath',
            tooltip: 'Compressed, heated solar-wind plasma between the bow shock and the magnetopause.',
        };
        this._swGroup.add(this._sheathMesh);

        // ── Bow shock surface (Farris-Russell) ──────────────────────────
        const bsProfile = _shueProfile(bs0.r0, bs0.alpha, 64);
        const bsGeo = new THREE.LatheGeometry(bsProfile, 56);
        this._bsMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xffc070) },
                uRimColor:  { value: new THREE.Color(0xfff0a8) },
                uBaseAlpha: { value: 0.04 },
                uRimPower:  { value: 2.6 },
                uIntensity: { value: 1.0 },
                uTime:      { value: 0 },
            },
            vertexShader:   SW_VERT,
            fragmentShader: SW_FRAG,
            transparent:    true,
            side:           THREE.DoubleSide,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        this._bsMesh = new THREE.Mesh(bsGeo, this._bsMat);
        this._bsMesh.renderOrder = 3;
        this._bsMesh.userData = {
            kind:    'bow-shock',
            id:      'bow-shock',
            name:    'Bow Shock',
            r0:      bs0.r0,
            alpha:   bs0.alpha,
            tooltip: 'Where supersonic solar wind decelerates to subsonic on impact with the magnetosphere (Farris–Russell).',
        };
        this._swGroup.add(this._bsMesh);

        // ── Magnetopause surface (Shue-1998) ────────────────────────────
        const mpProfile = _shueProfile(mp0.r0, mp0.alpha, 64);
        const mpGeo = new THREE.LatheGeometry(mpProfile, 56);
        this._mpMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0x60d8ff) },
                uRimColor:  { value: new THREE.Color(0xc8f0ff) },
                uBaseAlpha: { value: 0.06 },
                uRimPower:  { value: 3.0 },
                uIntensity: { value: 1.0 },
                uTime:      { value: 0 },
            },
            vertexShader:   SW_VERT,
            fragmentShader: SW_FRAG,
            transparent:    true,
            side:           THREE.DoubleSide,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        this._mpMesh = new THREE.Mesh(mpGeo, this._mpMat);
        this._mpMesh.renderOrder = 4;
        this._mpMesh.userData = {
            kind:    'magnetopause',
            id:      'magnetopause',
            name:    'Magnetopause',
            r0:      mp0.r0,
            alpha:   mp0.alpha,
            tooltip: 'Boundary where Earth\'s magnetic pressure balances solar-wind dynamic pressure (Shue-1998).',
        };
        this._swGroup.add(this._mpMesh);

        // ── Flux streamers — incoming solar wind ────────────────────────
        // A small cluster of dashed line strips converging from the
        // sunward hemisphere toward Earth. They sit "in front of" the
        // bow shock so they're visible at moderate zoom levels.
        this._streamMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0x6cc8ff) },
                uTime:      { value: 0 },
                uIntensity: { value: 0.6 },
                uSpeed:     { value: 0.18 },
            },
            vertexShader:   SW_STREAM_VERT,
            fragmentShader: SW_STREAM_FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        this._streamGroup = new THREE.Group();
        this._streamGroup.name = 'fluxStreamers';
        // Bumped from 8 → 64 streamers for a denser, more textured
        // sunward flow. Each streamer is a multi-segment polyline with
        // a subtle Parker-spiral curl + per-strand jitter so the
        // cluster doesn't read as a wheel of straight spokes.
        const N_FLUX = 64;
        const SEG    = 16;          // segments per streamer
        const streamerStarts = _streamerStartPoints(N_FLUX, bs0.r0 + 4);
        const tooltipText = 'Bulk plasma flow from the Sun. Brightness ∝ dynamic pressure ρv²; flow rate ∝ speed.';
        for (let si = 0; si < streamerStarts.length; si++) {
            const s = streamerStarts[si];
            // Bow-shock approach point — converge slightly toward the
            // sun-Earth axis but never to zero so streamers don't
            // bunch into a single line at the nose.
            const yEnd = bs0.r0 * 0.95;
            const xEnd = s.x * 0.20;
            const zEnd = s.z * 0.20;

            // Parker-spiral hint — small azimuthal twist proportional
            // to streamer arrival distance. Sign jittered so adjacent
            // strands curl opposite ways and visually braid.
            const sign = (si % 2 === 0) ? 1 : -1;
            const twistAmp = 0.22 * sign * (0.7 + 0.6 * Math.random());

            const positions = new Float32Array(SEG * 3);
            const progress  = new Float32Array(SEG);
            for (let i = 0; i < SEG; i++) {
                const t = i / (SEG - 1);
                // Linear interpolate sunward → Earth, then add the
                // twist as an azimuthal offset around the sun-Earth
                // axis (+Y in solar-group frame).
                const x0 = s.x + (xEnd - s.x) * t;
                const y0 = s.y + (yEnd - s.y) * t;
                const z0 = s.z + (zEnd - s.z) * t;
                // Twist grows from 0 at the source to a peak around
                // mid-flight then relaxes near the bow shock — the
                // shape Parker-spiral streamers actually take in the
                // inner heliosphere.
                const tw = twistAmp * Math.sin(Math.PI * t);
                const c = Math.cos(tw), sn = Math.sin(tw);
                const x1 = x0 * c - z0 * sn;
                const z1 = x0 * sn + z0 * c;
                positions[i * 3 + 0] = x1;
                positions[i * 3 + 1] = y0;
                positions[i * 3 + 2] = z1;
                progress[i] = t;
            }
            const geom = new THREE.BufferGeometry();
            geom.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
            geom.setAttribute('aProgress', new THREE.BufferAttribute(progress, 1));
            const line = new THREE.Line(geom, this._streamMat);
            line.userData = {
                kind:    'flux-stream',
                id:      'flux-stream',
                name:    'Solar-wind flux',
                tooltip: tooltipText,
            };
            this._streamGroup.add(line);
        }
        this._swGroup.add(this._streamGroup);

        // ── Heliospheric current sheet (faint disc) ─────────────────────
        // Thin equatorial sheet along the solar-wind flow plane. Reads
        // as a soft pink-orange wash that traces the wavy ballerina-
        // skirt geometry. Cheap — one ring mesh; fragment shader does
        // the radial fade.
        const sheetGeo = new THREE.RingGeometry(2.5, bs0.r0 + 2, 96, 1);
        const sheetMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor: { value: new THREE.Color(0xff9c66) },
                uTime:  { value: 0 },
            },
            vertexShader: /* glsl */`
                varying vec2 vUv;
                varying vec3 vPosL;
                void main() {
                    vUv = uv;
                    vPosL = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: /* glsl */`
                precision highp float;
                uniform vec3  uColor;
                uniform float uTime;
                varying vec2  vUv;
                varying vec3  vPosL;
                void main() {
                    // Distance from the sun-Earth axis (+Y) → ring radius.
                    float r = length(vPosL.xz);
                    // Ballerina-skirt waviness — gentle azimuthal warp.
                    float az = atan(vPosL.z, vPosL.x);
                    float warp = sin(az * 4.0 + uTime * 0.4) * 0.5 + 0.5;
                    // Radial taper: brighter near the disc, falling to
                    // zero at both inner & outer edges.
                    float radial = smoothstep(2.5, 4.0, r) * (1.0 - smoothstep(8.0, 14.0, r));
                    float a = 0.10 * radial * (0.5 + 0.5 * warp);
                    gl_FragColor = vec4(uColor, a);
                }
            `,
            transparent: true,
            side:        THREE.DoubleSide,
            depthWrite:  false,
            blending:    THREE.AdditiveBlending,
        });
        const sheet = new THREE.Mesh(sheetGeo, sheetMat);
        // RingGeometry is in the XY plane — rotate so it lies in the
        // XZ plane (the sun-aligned group's equatorial plane).
        sheet.rotation.x = Math.PI / 2;
        sheet.userData = {
            kind:    'current-sheet',
            id:      'helio-current-sheet',
            name:    'Heliospheric current sheet',
            tooltip: 'Wavy equatorial boundary in the interplanetary magnetic field; the "ballerina skirt".',
        };
        this._currentSheetMat = sheetMat;
        this._swGroup.add(sheet);

        // ── Sun glow + EUV streamers ───────────────────────────────────
        // Replaces the flat sphere marker with a proper "the Sun is
        // emitting" cue: a hot core, a soft corona halo, and a cluster
        // of outgoing radial photon streamers whose count + brightness
        // scale with F10.7. setF107() updates them live.
        this._buildSun(bs0);

        this._scene.add(this._swGroup);

        // Apply climatology so first paint shows non-default state if
        // the engine already has a feel for this. setSolarWind() is also
        // called externally once SwpcFeed pushes real data.
        this.setSolarWind(SW_DEFAULTS);
    }

    /**
     * Build the dipole magnetic-field cascade — a set of L-shell field
     * lines carrying an animated EUV/precipitation packet train from
     * the magnetopause down to the auroral oval and the polar cusps.
     * Drives intensity from the live (F10.7, Ap, Bz) state via
     * setState(), which is called from setState() on the globe.
     */
    _buildMagneticCascade() {
        this._cascade = new MagneticCascade({
            parent:    this._scene,
            intensity: 0.45,
            sunDir:    this._sunDir,
        });
        // Apply the climatology so first paint shows a baseline cascade
        // even before setState() arrives.
        this._cascade.setState({ f107: 150, ap: 15 });

        // Substorm state machine — drives the growth → expansion →
        // recovery animation. 'demo' mode walks through a substorm
        // in ~30 s wall-clock; auto-triggered when the cumulative
        // southward-Bz drive (substorm-index proxy) crosses 0.6.
        this._substorm = new SubstormController({ mode: 'demo' });

        // Local accumulator of southward-Bz drive — fed into the
        // controller as a substorm-index proxy. Re-evaluated whenever
        // setState() pushes a fresh (Ap, Bz) tuple.
        this._bzDriveAccum = 0;
    }

    /**
     * Manually trigger a substorm. Returns true on success (controller
     * was IDLE), false if a substorm is already in progress.
     */
    triggerSubstorm(opts) {
        return this._substorm?.trigger(opts) ?? false;
    }
    /** Force-end any in-progress substorm. */
    resetSubstorm() { this._substorm?.reset(); }
    /** 'demo' (compressed ~30 s) or 'realtime' (literal-minutes timing). */
    setSubstormMode(mode) { this._substorm?.setMode(mode); }
    /** Toggle the auto-trigger from substorm-index threshold. */
    setSubstormAuto(v) { this._substorm?.setAutoEnabled(v); }

    /**
     * Build the sun: a hot inner core + a soft halo + 24 outgoing
     * radial streamers that read as photon emission. F10.7 modulates
     * the corona brightness + streamer length so users see "active
     * sun" vs "quiet sun" at a glance. Mounted in the solar group so
     * "+Y == sunward" alignment is automatic.
     */
    _buildSun(bs0) {
        const sunDistance = bs0.r0 + 8;
        // Multi-layer Sun: photosphere → chromosphere → corona →
        // outer corona. Each layer is a separate sphere mesh with its
        // own material so the layered fresnel additive blend reads as
        // real depth rather than a single flat halo. Sized in scene
        // units (Earth radii); not to true scale — the real Sun is
        // ~109 R⊕ wide but we keep it visually marker-sized so it
        // fits in frame next to Earth's magnetosphere.
        const photoR    = 0.55;   // visible "surface"
        const chromoR   = 0.72;   // tight reddish ring
        const coronaR   = 1.50;   // mid-corona glow
        const outerR    = 2.80;   // wide blue-white halo

        const sunUserData = {
            kind:    'sun-marker',
            id:      'sun',
            name:    'Sun',
            tooltip: 'Solar emission source. Photosphere granulation, '
                   + 'chromosphere ring, and multi-layer corona. '
                   + 'Brightness + streamer length scale with F10.7 '
                   + '(10.7-cm radio flux, an EUV proxy used by NRL-MSIS).',
        };

        // ── Photosphere — granulated, limb-darkened disc ────────────
        const photoMat = new THREE.ShaderMaterial({
            uniforms: {
                uTime:      { value: 0 },
                uIntensity: { value: 1.0 },
                uHot:       { value: new THREE.Color(0xfff5d8) },
                uCool:      { value: new THREE.Color(0xff8a30) },
            },
            vertexShader:   SUN_VERT,
            fragmentShader: SUN_FRAG,
            depthWrite:     true,
        });
        const photo = new THREE.Mesh(
            new THREE.SphereGeometry(photoR, 64, 48),
            photoMat,
        );
        photo.userData = sunUserData;

        // ── Chromosphere — thin reddish-pink shell hugging the disc ─
        const chromoMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xff5530) },
                uRimColor:  { value: new THREE.Color(0xff9870) },
                uBaseAlpha: { value: 0.22 },
                uRimPower:  { value: 2.4 },
                uIntensity: { value: 1.0 },
                uTime:      { value: 0 },
            },
            vertexShader:   CORONA_VERT,
            fragmentShader: CORONA_FRAG,
            transparent:    true,
            side:           THREE.DoubleSide,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        const chromo = new THREE.Mesh(
            new THREE.SphereGeometry(chromoR, 48, 32),
            chromoMat,
        );
        chromo.userData = sunUserData;

        // ── Mid corona — yellow-white, fbm filaments ────────────────
        const coronaMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xffd070) },
                uRimColor:  { value: new THREE.Color(0xffeec0) },
                uBaseAlpha: { value: 0.16 },
                uRimPower:  { value: 1.7 },
                uIntensity: { value: 1.0 },
                uTime:      { value: 0 },
            },
            vertexShader:   CORONA_VERT,
            fragmentShader: CORONA_FRAG,
            transparent:    true,
            side:           THREE.DoubleSide,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        const corona = new THREE.Mesh(
            new THREE.SphereGeometry(coronaR, 48, 32),
            coronaMat,
        );
        corona.userData = sunUserData;

        // ── Outer corona — wide cool halo, near-transparent ─────────
        const outerMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xffe8c8) },
                uRimColor:  { value: new THREE.Color(0xb0d8ff) },
                uBaseAlpha: { value: 0.05 },
                uRimPower:  { value: 2.6 },
                uIntensity: { value: 1.0 },
                uTime:      { value: 0 },
            },
            vertexShader:   CORONA_VERT,
            fragmentShader: CORONA_FRAG,
            transparent:    true,
            side:           THREE.DoubleSide,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });
        const outer = new THREE.Mesh(
            new THREE.SphereGeometry(outerR, 36, 24),
            outerMat,
        );
        outer.userData = sunUserData;

        // ── Outgoing radial streamers — Fibonacci sphere ────────────
        // Bumped from 24 → 56 strands and each carries a slight curl
        // off-axis so the cluster reads as a textured photon flow
        // rather than a regular wheel of spokes.
        const N_STREAMS = 56;
        const streamMat = new THREE.ShaderMaterial({
            uniforms: {
                uColor:     { value: new THREE.Color(0xffe4a0) },
                uTime:      { value: 0 },
                uIntensity: { value: 0.7 },
                uSpeed:     { value: -0.28 },     // negative → flow outward
            },
            vertexShader:   SW_STREAM_VERT,
            fragmentShader: SW_STREAM_FRAG,
            transparent:    true,
            depthWrite:     false,
            blending:       THREE.AdditiveBlending,
        });

        const streamGroup = new THREE.Group();
        const phi = Math.PI * (3 - Math.sqrt(5));
        for (let i = 0; i < N_STREAMS; i++) {
            const y    = 1 - (i / (N_STREAMS - 1)) * 2;
            const r    = Math.sqrt(Math.max(0, 1 - y * y));
            const lon  = i * phi;
            const dx = r * Math.cos(lon);
            const dy = y;
            const dz = r * Math.sin(lon);
            // Curl factor — small per-strand offset so the tip drifts
            // off the radial line. Amount alternates ± so neighbours
            // visually braid rather than radiate uniformly.
            const sign = (i % 2 === 0) ? 1 : -1;
            const curl = 0.18 * sign;
            const tx = -dz * curl;
            const tz =  dx * curl;
            const tipLen = 2.0 + 1.4 * Math.random();   // jittered length
            const positions = new Float32Array([
                dx * photoR, dy * photoR, dz * photoR,
                (dx + tx) * (photoR + tipLen), dy * (photoR + tipLen), (dz + tz) * (photoR + tipLen),
            ]);
            const progress = new Float32Array([0, 1]);
            const g = new THREE.BufferGeometry();
            g.setAttribute('position',  new THREE.BufferAttribute(positions, 3));
            g.setAttribute('aProgress', new THREE.BufferAttribute(progress, 1));
            const line = new THREE.Line(g, streamMat);
            line.userData = {
                kind:    'sun-stream',
                id:      'sun-stream',
                name:    'Sun · radial emission',
                tooltip: 'Radial photon flow. Length + brightness scale with F10.7.',
            };
            streamGroup.add(line);
        }

        // ── Sun group — bundle photosphere + halos + streamers ──────
        const sunGroup = new THREE.Group();
        sunGroup.add(photo);
        sunGroup.add(chromo);
        sunGroup.add(corona);
        sunGroup.add(outer);
        sunGroup.add(streamGroup);
        sunGroup.position.set(0, sunDistance, 0);

        // Cache references for setF107 + animate.
        this._sunMarker      = sunGroup;
        this._sunPhotoMat    = photoMat;
        this._sunChromoMat   = chromoMat;
        this._sunCoreMat     = photoMat;       // legacy alias for setF107
        this._sunHaloMat     = coronaMat;
        this._sunOuterMat    = outerMat;
        this._sunStreamMat   = streamMat;
        this._sunStreamGroup = streamGroup;
        this._swGroup.add(sunGroup);
    }

    /**
     * Drive the sun's emission visuals from the solar-flux index
     * (F10.7 in SFU). Quiet-sun ≈ 70 SFU; cycle-max ≈ 250–300. Maps
     * to streamer brightness, halo glow, and core size.
     */
    setF107(f107Sfu) {
        const f = Number.isFinite(f107Sfu) ? f107Sfu : 150;
        const q = Math.max(0, Math.min(1, (f - 65) / (300 - 65)));   // 0..1
        if (this._sunChromoMat) this._sunChromoMat.uniforms.uIntensity.value = 0.65 + 0.70 * q;
        if (this._sunHaloMat)   this._sunHaloMat.uniforms.uIntensity.value   = 0.55 + 0.95 * q;
        if (this._sunOuterMat)  this._sunOuterMat.uniforms.uIntensity.value  = 0.40 + 0.90 * q;
        if (this._sunStreamMat) this._sunStreamMat.uniforms.uIntensity.value = 0.35 + 1.10 * q;
        // Photosphere intensity ramp — the granulation stays the same
        // but the overall brightness rises with activity.
        if (this._sunPhotoMat) {
            this._sunPhotoMat.uniforms.uIntensity.value = 0.85 + 0.45 * q;
        }
        // Stream group scales radially so high F10.7 = longer EUV reach.
        if (this._sunStreamGroup) {
            const s = 0.85 + 0.65 * q;
            this._sunStreamGroup.scale.setScalar(s);
        }
    }

    /**
     * Refresh the world-frame sun direction from the current sub-solar
     * point so the day/night terminator on Earth and the Sun graphic in
     * the solar-wind group track real time. Cheap (one trig call + a
     * quaternion + a few uniform copies) so we run it every frame.
     */
    /**
     * The instant the SCENE is drawn at, in Unix ms: the flight deck's
     * private clock while a flight is being scrubbed or warped, else the
     * shared TimeBus (so the page's own time controls move the terminator
     * — its copy always promised that, and until 2026-09-27 the sun read
     * the wall clock while every satellite read the bus), else the wall
     * clock before the bus exists.
     */
    _sceneTimeMs() {
        if (Number.isFinite(this._sceneTimeOverrideMs)) return this._sceneTimeOverrideMs;
        const bus = this._timeBus?.getSimTime?.();
        return Number.isFinite(bus) ? bus : Date.now();
    }

    /** Sidereal angle of an instant — the ONE ECI→Earth-fixed rotation. */
    _gmstRad(ms) {
        return greenwichSiderealDeg(ms) * (Math.PI / 180);
    }

    // ── The airglow field (upper-atmosphere-airglow-field.js) ────────────
    /**
     * Drive the volume's airglow field from the SCENE instant: the shared
     * equatorial fountain (arcs + bubbles) advanced on the scene clock, the
     * symbolic ripple phases, and Kp for the SAR arcs. The fountain table
     * is re-sampled at most every 250 ms of frame clock (it moves on hour
     * scales) unless the scene instant jumps or Kp changes; the phases are
     * pushed every frame (cheap, and computed in double precision here
     * because float32 cannot hold ω·t).
     */
    _updateAirglowField(force = false) {
        if (!this._volume) return;
        const sceneMs = this._sceneTimeMs();
        const kp = apToKp(this._airglowAp ?? 15);
        if (!this._iono) {
            this._iono = new IonosphereDriver();
            // `_arcs` is the fountain sampler every airglow consumer reads
            // (probe, POIs, the gates); the driver owns and advances it.
            this._arcs = this._iono.sampler;
        }
        const now = frameClock.now();
        const kpChanged = kp !== this._arcsKp;
        const due = force || kpChanged || this._arcsSceneMs == null
            || (sceneMs !== this._arcsSceneMs
                && (now - (this._arcsAt ?? -Infinity) > 250 || Math.abs(sceneMs - this._arcsSceneMs) > 60000));
        let arcsData = null, ppData = null;
        if (due) {
            this._arcsAt = now;
            this._arcsSceneMs = sceneMs;
            if (this._iono.advanceTo(sceneMs, { kp, vbs: this._vbs }) || force) {
                arcsData = this._iono.sampler.data;
                ppData = this._iono.ppData;
            }
        }
        this._volume.setAirglowField({
            arcsData, ppData, phases: gwPhases(sceneMs / 1000), kp: kpChanged ? kp : null,
            tidPhases: tidPhases(sceneMs / 1000), utHours: sceneMs / 3.6e6,
        });
        this._arcsKp = kp;
    }

    /** Re-sample and re-upload the airglow field now (tests; after editing the fountain). */
    refreshAirglowField() {
        this._arcs?._fill?.();
        this._updateAirglowField(true);
    }

    /**
     * The airglow field at a scene point (e.g. the probe's tangent point),
     * from the SAME kernel and drivers the shader reads.
     */
    airglowFieldAt(p) {
        const v = Array.isArray(p) ? p : [p.x, p.y, p.z];
        const r = Math.hypot(v[0], v[1], v[2]) || 1;
        const u = [v[0] / r, v[1] / r, v[2] / r];
        const ll = sceneToLatLon(u);
        const sd = this._sunDir;
        const cosChi = sd ? (u[0] * sd.x + u[1] * sd.y + u[2] * sd.z) / (sd.length() || 1) : 0;
        const kp = apToKp(this._airglowAp ?? 15);
        const arcs = this._arcs ? this._arcs.sampleAt(ll.lonDeg) : undefined;
        const sceneMs = this._sceneTimeMs();
        const field = airglowFieldAt({
            latDeg: ll.latDeg, lonDeg: ll.lonDeg, u, cosChi, kp, arcs,
            phases: gwPhases(sceneMs / 1000),
            ppInvLatDeg: this._iono?.timeMs != null ? this._iono.plasmapauseAt(ll.lonDeg) : null,
            tidPhases: tidPhases(sceneMs / 1000), utHours: sceneMs / 3.6e6,
        });
        const red = redFactorAt(250, field);
        return { ...field, latDeg: ll.latDeg, lonDeg: ll.lonDeg, arcs, kp, sar: field.sar,
                 sarArc: sarArc(kp), red250: red.red, lit250: red.lit, regime: redLineRegime(field) };
    }

    /**
     * The plasma field at a scene point (the probe's tangent point), from
     * the SAME kernel and drivers the plasma view reads: layer peaks with
     * the horizontal factors applied, vertical TEC over the page's 80–2000
     * km band, and what dominates. Also the E-field state driving it.
     */
    plasmaFieldAt(p) {
        const v = Array.isArray(p) ? p : [p.x, p.y, p.z];
        const r = Math.hypot(v[0], v[1], v[2]) || 1;
        const u = [v[0] / r, v[1] / r, v[2] / r];
        const ll = sceneToLatLon(u);
        const sd = this._sunDir;
        const sun = sd ? [sd.x, sd.y, sd.z] : [1, 0, 0];
        const sl = Math.hypot(...sun) || 1;
        const cosChi = (u[0] * sun[0] + u[1] * sun[1] + u[2] * sun[2]) / sl;
        const { lstHr } = geoFromVectors(u, sun);
        const sceneMs = this._sceneTimeMs();
        const ut = ((sceneMs / 3.6e6) % 24 + 24) % 24;
        const kp = apToKp(this._airglowAp ?? 15);
        const live = this._iono?.timeMs != null;
        const field = plasmaKernelAt({
            latDeg: ll.latDeg, lonDeg: ll.lonDeg, cosChi, lstHr, mltHr: mltAt(ll.lonDeg, ut), kp,
            f107Sfu: this._lastFieldState?.f107 ?? 150,
            arcs: this._arcs ? this._arcs.sampleAt(ll.lonDeg) : undefined,
            ppInvLatDeg: live ? this._iono.plasmapauseAt(ll.lonDeg) : null,
            phases: tidPhases(sceneMs / 1000),
        });
        return {
            ...field, latDeg: ll.latDeg, lonDeg: ll.lonDeg, lstHr, kp, vtecTecu: vtec(field),
            ppInvLatDeg: live ? this._iono.plasmapauseAt(ll.lonDeg) : null,
            efield: this._iono?.efield?.() ?? null, vbs: this._vbs ?? null,
        };
    }

    /** The ionosphere driver's state (E-field, penetration, table time) — the legend and the gates read it. */
    ionosphereState() {
        if (!this._iono || this._iono.timeMs == null) return null;
        return { efield: this._iono.efield(), vbs: this._vbs ?? null, timeMs: this._iono.timeMs,
                 kp: apToKp(this._airglowAp ?? 15) };
    }

    /**
     * Pin the scene's instant (sun direction / terminator / diurnal bulge)
     * to a time other than the bus's — the flight layer's mission clock
     * when a flight is warped or scrubbed off the live clock. `null`
     * releases it back to the bus.
     */
    setSceneTime(ms) {
        this._sceneTimeOverrideMs = Number.isFinite(ms) ? ms : null;
    }
    getSceneTimeMs() { return this._sceneTimeMs(); }

    _updateSunRealTime() {
        const ssp = subSolarPoint(new Date(this._sceneTimeMs()));
        // Skin: only push uniform updates when the angle has actually
        // moved meaningfully (>0.01° ≈ 1.7e-4 rad). Sub-solar drift is
        // ≈15°/hour so this still fires several times a minute.
        const next = _subSolarToVec3(ssp.lat, ssp.lon);
        if (!this._sunDir) this._sunDir = next;
        else {
            // copy in place so consumers that captured the reference
            // (EarthSkin uniform, layer shells, particle systems, etc.)
            // see the new value without us having to re-push.
            this._sunDir.copy(next);
        }
        // EarthSkin holds its own clone — push the update so the
        // shader's u_sun_dir matches.
        this._skin?.setSunDir?.(this._sunDir);
        // Layer shells: each material owns its own uSunDir clone.
        if (this._shells) {
            for (const sh of this._shells) {
                sh.material.uniforms.uSunDir?.value.copy(this._sunDir);
            }
        }
        // Particle systems & vector fields use the sun direction for
        // the subsolar→antisolar wind tangent.
        if (this._particles) {
            for (const id in this._particles) {
                this._particles[id].setSunDir?.(this._sunDir);
            }
        }
        if (this._fields) {
            for (const id in this._fields) {
                this._fields[id].setSunDir?.(this._sunDir);
            }
        }
        // Volumetric atmosphere: the diurnal bulge is anchored to the
        // sub-solar direction, and its mean-preserving normaliser depends
        // on the solar declination — push both.
        this._volume?.setSunDir(this._sunDir);
        this._volume?.setSunDeclination(ssp.lat);
        this._sunDeclDeg = ssp.lat;

        // Drag-forecast overlay: tangent wind is sun-relative.
        this._dragOverlay?.setSunDir?.(this._sunDir);
        // Magnetic-field cascade: sun direction biases the dayside-vs-
        // nightside packet weighting (cusp packets brighten on the
        // dayside where reconnection is active).
        this._cascade?.setSunDir?.(this._sunDir);
        // Solar-wind group is oriented so its local +Y points at the
        // Sun; update the quaternion so the Shue magnetopause + bow
        // shock + Sun marker all rotate to the new sub-solar direction.
        if (this._swGroup) {
            const yAxis = new THREE.Vector3(0, 1, 0);
            const q = new THREE.Quaternion().setFromUnitVectors(yAxis, this._sunDir);
            this._swGroup.quaternion.copy(q);
        }
    }

    _initStars() {
        const n = 2500;
        const positions = new Float32Array(n * 3);
        const colors = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const theta = 2 * Math.PI * Math.random();
            const phi   = Math.acos(1 - 2 * Math.random());
            const R = 220 + 120 * Math.random();
            positions[i * 3 + 0] = R * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = R * Math.cos(phi);
            positions[i * 3 + 2] = R * Math.sin(phi) * Math.sin(theta);
            // Slight warm/cool variation.
            const shade = 0.75 + 0.25 * Math.random();
            colors[i * 3 + 0] = shade;
            colors[i * 3 + 1] = shade * (0.85 + 0.15 * Math.random());
            colors[i * 3 + 2] = shade * (0.95 + 0.08 * Math.random());
        }
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
        const mat = new THREE.PointsMaterial({
            size: 1.2,
            sizeAttenuation: false,
            vertexColors: true,
            transparent: true,
            opacity: 0.9,
            // Drawn first and never occluding: the backdrop is at infinity.
            depthWrite: false,
        });
        this._stars = new THREE.Points(geom, mat);
        this._stars.renderOrder = -10;
        this._stars.frustumCulled = false;
        this._scene.add(this._stars);
    }

    _initControls() {
        // CameraController wraps OrbitControls + a hand-rolled fly mode
        // behind a single setMode() switch. Default = orbit so existing
        // behaviour is unchanged on first paint; the UI exposes a toggle
        // to switch into fly mode where users can move *into* the layers.
        this._controls = new CameraController(this._camera, this.canvas);
    }

    /**
     * Toggle the camera between 'orbit' (planet-locked, OrbitControls)
     * and 'fly' (free 6-DOF, WASD + mouse-drag look). Returns the new
     * mode so callers can sync a UI toggle.
     */
    setCameraMode(mode) {
        // An explicit mode choice outranks a follow still waiting on its fly-in.
        this._cancelPendingFollow();
        this._controls.setMode(mode);
        if (!this._controls.isFollowing?.()) this._followId = null;
        return this._controls.getMode();
    }
    getCameraMode() { return this._controls.getMode(); }

    /**
     * Smoothly fly the camera to a world-space target, optionally aiming
     * at lookAt. Used by satellite click-to-fly and ISS focus.
     */
    flyTo(targetVec3, lookAtVec3 = null, duration = 1.4) {
        this._controls.flyTo(targetVec3, lookAtVec3, duration);
    }

    /**
     * Camera altitude above 1 R⊕ in km. The HUD reads this every frame to
     * paint the local-altitude readout + sample the engine for ρ/T/Kn.
     */
    getCameraAltitudeKm() {
        return this._controls.getAltitudeKm();
    }

    /**
     * Sample local atmospheric physics at the current camera altitude.
     * Returns null if the camera is below the simulator's domain (< 80 km).
     * Cheap; uses the same engine call the side panel uses.
     */
    getCameraSampleAtState({ f107, ap }) {
        const altKm = this.getCameraAltitudeKm();
        if (!Number.isFinite(altKm) || altKm < 80) return { altitudeKm: altKm, outOfDomain: true };
        const layer = layerForAltitude(altKm);
        const phys  = pointPhysics({
            altitudeKm: altKm,
            f107Sfu:    f107,
            ap,
            layerThicknessKm: layer ? Math.max(1, layer.maxKm - layer.minKm) : null,
        });
        return { ...phys, layer, opsBand: opsBandForAltitude(altKm) };
    }

    _initInstruments() {
        const host = this.canvas.parentElement;
        if (!host) return;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        this._instruments = new AtmosphereInstruments(host, {
            globe: this,
            // The instruments read state from the globe rather than from
            // the page so the page bootstrap needs no new wiring and the
            // two can never disagree about which (F10.7, Ap) is live.
            getState: () => ({
                f107:       this._state?.f107 ?? 150,
                ap:         this._state?.ap ?? 15,
                altitudeKm: this._currentAltKm ?? 400,
                sunDeclDeg: this._sunDeclDeg ?? 0,
            }),
        });
    }

    // ── Layer transit + ambient gas (js/upper-atmosphere-transit.js) ───────
    /** Ride the local vertical: { mode:'descend'|'ascend', kmPerSec, toKm?, headingDeg?, pitchDeg? }. */
    startTransit(opts) {
        this._followId = null;
        return this._transit?.start(opts) ?? null;
    }
    stopTransit()        { this._transit?.stop('api'); }
    pauseTransit(on)     { this._transit?.setPaused(on); }
    getTransitState()    { return this._transit?.getState() ?? null; }
    setAmbientGasVisible(on) { this._transit?.setCloudVisible(on); }
    getAmbientGasVisible()   { return this._transit?.getCloudVisible() ?? false; }
    getAmbientGas()          { return this._transit?.getGas() ?? null; }
    getAmbientGasCount()     { return this._transit?.getCloudCount() ?? 0; }
    getStreakInfo()          { return this._transit?.getStreakInfo() ?? { count: 0, lengthRunit: 0, speedKmS: 0 }; }

    // ── Explore mode (js/upper-atmosphere-explore*.js) ─────────────────────
    /** What the POI kernel needs from the live page. */
    _poiInputs() {
        const ssp = subSolarPoint(new Date(this._sceneTimeMs()));
        return {
            subSolarLatDeg: ssp.lat, subSolarLonDeg: ssp.lon,
            f107Sfu: this._state?.f107 ?? 150, ap: this._state?.ap ?? 15,
            iss: this._issState(),
            arcs: brightestEveningArc(this._arcs, ssp.lon),
        };
    }
    /** Live ISS lat/lon/alt/heading from its probe (null without one). */
    _issState() {
        const probe = this._satProbes?.iss;
        if (!probe?.mesh) return null;
        const p = probe.mesh.position;
        const r = p.length();
        if (!(r > 1)) return null;
        const u = [p.x / r, p.y / r, p.z / r];
        const ll = sceneToLatLon(u);
        // Heading from a two-second look-ahead on the same propagator.
        const t = this._timeBus?.getSimTime?.() ?? Date.now();
        const q = _eciSceneToEarthFixed(_lookupProbePositionAt(probe, t + 2000), this._gmstRad(t + 2000));
        const dir = [q.x - p.x, q.y - p.y, q.z - p.z];
        const east = [-Math.sin(ll.lonDeg * Math.PI / 180), 0, -Math.cos(ll.lonDeg * Math.PI / 180)];
        const north = [
            u[1] * east[2] - u[2] * east[1],
            u[2] * east[0] - u[0] * east[2],
            u[0] * east[1] - u[1] * east[0],
        ];
        const he = dir[0] * east[0] + dir[1] * east[1] + dir[2] * east[2];
        const hn = dir[0] * north[0] + dir[1] * north[1] + dir[2] * north[2];
        const headingDeg = (Math.hypot(he, hn) > 0) ? ((Math.atan2(he, hn) * 180 / Math.PI) + 360) % 360 : null;
        return { latDeg: ll.latDeg, lonDeg: ll.lonDeg, altKm: (r - 1) * R_EARTH_KM, headingDeg };
    }
    _cameraPose() {
        const c = this._camera;
        const f = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
        return { fromPos: c.position.toArray(), fromFwd: f.toArray(), fromUp: c.up.toArray() };
    }
    _emitExplore(detail) {
        try { window.dispatchEvent(new CustomEvent('ua-explore', { detail })); } catch (_) { /* SSR */ }
    }

    /**
     * Dive from wherever the camera is to (lat, lon, alt), arriving level
     * with the horizon in explore mode. Any key, drag or wheel cancels it
     * where it is (the page may start a flight, not hold the camera).
     */
    diveTo({ latDeg, lonDeg, altKm = 250, headingDeg = null, pitchDeg = -8, durationSec = null, poiId = null } = {}) {
        if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
        if (this._transit?.getState?.().active) this._transit.stop('dive');
        this._followId = null;
        this._controls.stopFollowing?.();
        const path = divePath({ ...this._cameraPose(), latDeg, lonDeg, altKm, headingDeg, pitchDeg });
        const target = path.target;
        this._controls.runPath(path, {
            endMode: 'explore', durationSec,
            onDone: (why) => this._emitExplore({
                kind: why === 'arrived' ? 'dive-arrive' : 'dive-cancel', target, poiId, reason: why,
            }),
        });
        this._emitExplore({ kind: 'dive-start', target, poiId, durationSec: durationSec ?? path.durationSec, arcDeg: path.arcDeg });
        return { ...target, durationSec: durationSec ?? path.durationSec, arcDeg: path.arcDeg };
    }
    /** Dive to one of the live points of interest by id. */
    diveToPoi(id, opts = {}) {
        this._explore?.refreshPois(true);
        const poi = this._explore?.getPoi(id);
        if (!poi) return null;
        return this.diveTo({
            latDeg: poi.latDeg, lonDeg: poi.lonDeg, altKm: poi.altKm,
            headingDeg: poi.headingDeg, pitchDeg: poi.pitchDeg, poiId: id, ...opts,
        });
    }
    /** Climb out of the band to the orbit view over the same ground. */
    climbToOrbit({ distance = 3.4, durationSec = null } = {}) {
        if (this._transit?.getState?.().active) this._transit.stop('climb');
        this._followId = null;
        this._controls.stopFollowing?.();
        const path = climbPath({ ...this._cameraPose(), distance });
        this._controls.runPath(path, {
            endMode: 'orbit', durationSec,
            onDone: (why) => this._emitExplore({ kind: why === 'arrived' ? 'climb-arrive' : 'climb-cancel', reason: why }),
        });
        this._emitExplore({ kind: 'climb-start', durationSec: durationSec ?? path.durationSec });
        return { durationSec: durationSec ?? path.durationSec };
    }
    /**
     * Explore from here: inside the band the camera switches mode where it
     * is; above it, it dives to the ground under the camera at `altKm`.
     */
    enterExplore({ altKm = 250 } = {}) {
        const alt = this.getCameraAltitudeKm();
        if (alt <= EXPLORE.ceilKm && !this._controls.isPathActive?.()) {
            if (this._transit?.getState?.().active) this._transit.stop('explore');
            this._controls.stopFollowing?.();
            this._followId = null;
            this._controls.setMode('explore');
            return { mode: 'explore', dived: false };
        }
        const ll = sceneToLatLon(this._camera.position.toArray());
        const t = this.diveTo({ ...ll, altKm });
        return { mode: 'dive', dived: true, target: t };
    }
    /**
     * Go to an altitude over the ground below the camera: a dive from above
     * the band, otherwise a ride along the local vertical that keeps the
     * current heading and pitch (~2 s; any key or drag releases it).
     */
    goToAltitude(altKm) {
        const target = Math.max(EXPLORE.floorKm, Math.min(EXPLORE.ceilKm, altKm));
        if (!Number.isFinite(target)) return null;
        const alt = this.getCameraAltitudeKm();
        if (alt > EXPLORE.ceilKm + 1 || this._controls.isPathActive?.()) {
            this._controls.cancelPath?.('superseded');
            const ll = sceneToLatLon(this._camera.position.toArray());
            return this.diveTo({ ...ll, altKm: target });
        }
        if (this._controls.getMode() !== 'explore') this._controls.setMode('explore');
        const info = this.getExploreInfo();
        return this.startTransit({
            mode: target < alt ? 'descend' : 'ascend',
            kmPerSec: Math.max(5, Math.abs(target - alt) / 2.2),
            fromKm: alt, toKm: target,
            headingDeg: info?.headingDeg ?? null,
            pitchDeg: Number.isFinite(info?.pitchDeg) ? info.pitchDeg : -6,
        });
    }
    isTransitioning() { return !!this._controls.isPathActive?.(); }
    getTransitionProgress() { return this._controls.getPathProgress?.() ?? null; }
    cancelTransition() { return this._controls.cancelPath?.('api') ?? false; }

    /** Where the explorer is and how fast it is going (null outside explore). */
    getExploreInfo() {
        const st = this._controls.getExploreState?.();
        if (!st) return null;
        const d = describeState(st);
        const v = st.speedKmS ?? 0;
        return {
            ...d,
            compass: compass8(d.headingDeg),
            speedKmS: v,
            groundSpeedKmS: st.groundSpeedKmS ?? 0,
            climbKmS: st.climbKmS ?? 0,
            moving: !!st.moving,
            orbitalKmS: orbitalSpeedKmS(d.altKm),
            orbitalMultiple: v / orbitalSpeedKmS(d.altKm),
        };
    }
    getPointsOfInterest()    { this._explore?.refreshPois(false); return this._explore?.getPois() ?? []; }
    getExploreDiscoveries()  { return this._explore?.getDiscoveries() ?? { found: [], total: 0 }; }
    resetExploreDiscoveries() { this._explore?.resetDiscoveries(); }
    // ── Operational bands (the limb ruler) ───────────────────────────────
    setOpsBandsVisible(on)   { this._opsBands?.setVisible(on); }
    getOpsBandsVisible()     { return this._opsBands?.getVisible() ?? false; }
    isOpsBandsDrawn()        { return this._opsBands?.isDrawn() ?? false; }
    setOpsBandFocus(id)      { this._opsBands?.setFocus(id); }
    getOpsBandFocus()        { return this._opsBands?.getFocus() ?? null; }
    /** The operational band the camera is in (null outside 80–2000 km). */
    getCameraOpsBand()       { return opsBandForAltitude(this.getCameraAltitudeKm()); }
    setMembranesVisible(on)  { this._explore?.setMembranesVisible(on); }
    getMembranesVisible()    { return this._explore?.getMembranesVisible() ?? false; }
    getMembraneWeights()     { return this._explore?.getMembraneWeights() ?? []; }
    isMembranePassDrawn()    { return this._explore?.isMembranePassDrawn() ?? false; }
    setBeaconsVisible(on)    { this._explore?.setBeaconsVisible(on); }
    getBeaconsVisible()      { return this._explore?.getBeaconsVisible() ?? false; }
    setAuroraCurtainsVisible(on) { this._explore?.setAuroraVisible(on); }
    getAuroraCurtainsVisible()   { return this._explore?.getAuroraVisible() ?? false; }
    getAuroraCurtainInfo()       { return this._explore?.getAuroraInfo() ?? null; }

    /**
     * Double-click the planet to dive there. Skipped when a click handler
     * (the launch panel's site picking) consumed the click, and when the
     * pointer is over a satellite / debris / catalogue point (a click on one
     * already means "fly to it").
     */
    _initDiveOnDoubleClick() {
        const ray = new THREE.Raycaster();
        const ndc = new THREE.Vector2();
        this._onDblClick = (e) => {
            // The launch panel's handler is registered for good and only
            // CONSUMES clicks while it is picking a site; skip the dive only
            // when one of this double-click's own clicks was consumed.
            if (Number.isFinite(this._clickConsumedAt) && e.timeStamp - this._clickConsumedAt < 700) return;
            // Only the kinds a single click already acts on (fly-to-satellite,
            // debris, catalogue): the hover raycast also reports shells and
            // field lines, which must not block a dive.
            const k = this._hoveredUserData?.kind;
            if (k === 'sat-probe' || k === 'iss-probe' || k === 'debris-piece' || k === 'catalog-point') return;
            const earth = this._skin?.earthMesh;
            if (!earth) return;
            const rect = this.canvas.getBoundingClientRect();
            ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1,
                    ((e.clientY - rect.top) / rect.height) * -2 + 1);
            ray.setFromCamera(ndc, this._camera);
            // Analytic sphere hit (the mesh is 33 k triangles; the sphere is exact).
            const o = ray.ray.origin, d = ray.ray.direction;
            const b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c;
            if (disc < 0) return;
            const t = -b - Math.sqrt(disc);
            if (!(t > 0)) return;
            const hit = o.clone().addScaledVector(d, t);
            const ll = sceneToLatLon(hit.toArray());
            const alt = this.getCameraAltitudeKm();
            const altKm = alt <= EXPLORE.ceilKm ? Math.max(EXPLORE.floorKm, alt) : 250;
            this.diveTo({ ...ll, altKm });
        };
        this.canvas.addEventListener('dblclick', this._onDblClick);
    }

    /**
     * Quiet the hoops (tori, field lines, orbit loops) while the camera is
     * down in the band, exactly as the transit does, and restore the user's
     * own settings when it goes back to orbit — unless a flight owns focus.
     */
    _updateExploreFocus(mode) {
        // A dive or climb counts: mid-dive the hoops sweep through the view
        // as giant bands (measured) before the mode has become explore.
        let inside = mode === 'explore' || !!this._controls.isPathActive?.();
        // A LIMB VIEW counts too, from the flight in until the camera orbits
        // the planet again: under a telephoto lens the altitude tori, the
        // mesosphere rings and the field lines are seen edge-on and fill the
        // frame as pastel bands (measured on the first limb screenshots).
        if (this._limbFocus) {
            const rig = this._controls.getRigState?.();
            if (rig && rig.planetFrame && !this._controls.isAnimating?.()) this._limbFocus = false;
            else inside = true;
        }
        if (inside === !!this._exploreFocusMode) return;
        this._exploreFocusMode = inside;
        if (inside) {
            this._exploreFocus = !this._flightFocusOn;
            if (this._exploreFocus) this.setFlightFocus(true);
        } else {
            if (this._exploreFocus && !this._flight?.hasFlight() && !this._transit?.getState?.().active) {
                this.setFlightFocus(false);
            }
            this._exploreFocus = false;
        }
    }

    /**
     * Near plane follows the camera down. The default 0.01 R⊕ (64 km) clips
     * everything nearer than that, which at 100 km is most of the gas and
     * every streak; 0.25 × altitude keeps the ground in front of it. Far
     * stays put, so the depth ratio never exceeds 5×10⁵ (the Mars flicker
     * scar was 5×10⁶). From the orbit view this is the old 0.01 exactly.
     */
    _updateNearPlane() {
        const cam = this._camera;
        const altR = cam.position.length() - 1;
        const near = Math.max(0.002, Math.min(0.01, 0.25 * altR));
        if (Math.abs(near - cam.near) > 0.02 * cam.near) {
            cam.near = near;
            cam.updateProjectionMatrix();
        }
    }

    setInstrumentsEnabled(on) { this._instruments?.setEnabled(on); }
    getInstrumentsEnabled()   { return this._instruments?.getEnabled() ?? false; }
    setLimbProbeEnabled(on)   { this._instruments?.setProbeEnabled(on); }
    getLimbProbeEnabled()     { return this._instruments?.getProbeEnabled() ?? false; }
    getLimbProbe()            { return this._instruments?.getProbe() ?? null; }

    // ── Geometry hooks for the on-canvas instruments ─────────────────────────
    // upper-atmosphere-instruments.js draws a 2-D overlay above the WebGL
    // canvas and needs two things from the scene: where a world point lands
    // on screen, and what atmosphere a given screen pixel is looking
    // through. Both live here rather than in the overlay so the overlay
    // stays free of three.js — the physics it reports then comes from the
    // node-tested kernel, and nothing about it needs a GPU to verify.

    /**
     * World point → canvas pixel. `behind` is true when the point is
     * behind the camera, where the perspective divide flips the sign and a
     * naive projection silently draws the marker mirrored across the
     * screen centre.
     */
    projectToScreen(x, y, z) {
        const v = new THREE.Vector3(x, y, z);
        v.project(this._camera);
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        // project() divides by w; when the point is behind the camera that
        // divide is by a negative number.
        const dir = new THREE.Vector3(x, y, z).sub(this._camera.position);
        const fwd = new THREE.Vector3();
        this._camera.getWorldDirection(fwd);
        return {
            x: (v.x * 0.5 + 0.5) * w,
            y: (-v.y * 0.5 + 0.5) * h,
            behind: dir.dot(fwd) <= 0,
        };
    }

    /**
     * What is this screen pixel looking through?
     *
     * Returns the view ray's tangent geometry: the altitude of its closest
     * approach to the Earth's centre, the world point where that happens,
     * and the (latitude, local solar time) there — which is what makes the
     * probe able to report the LOCAL density rather than the spherically
     * symmetric one.
     *
     * `hitsPlanet` distinguishes a ray that meets the solid Earth (the
     * disc) from one that passes over the limb. For a disc ray the
     * "tangent altitude" is below the surface and meaningless; the surface
     * intersection is reported instead, so the probe can say what the
     * column above that surface point is.
     *
     * @param {number} nx normalised device x, −1…+1
     * @param {number} ny normalised device y, −1…+1
     */
    probeScreenRay(nx, ny) {
        const cam = this._camera;
        const origin = cam.position.clone();
        const dir = new THREE.Vector3(nx, ny, 0.5)
            .unproject(cam).sub(origin).normalize();

        // Closest approach of the ray to the origin (Earth centre).
        const tClose = -origin.dot(dir);
        const camAltKm = (origin.length() - 1) * R_EARTH_KM;

        // Does it meet the planet? |perpendicular distance| < 1 R⊕ and the
        // approach is in front of us.
        const perp = origin.clone().addScaledVector(dir, Math.max(tClose, 0));
        const perpR = tClose > 0 ? perp.length() : origin.length();
        const hitsPlanet = tClose > 0 && perpR < 1.0;

        let point, altKm;
        if (hitsPlanet) {
            // Near intersection with the unit sphere.
            const b = origin.dot(dir);
            const c = origin.lengthSq() - 1;
            const disc = Math.max(0, b * b - c);
            const t = -b - Math.sqrt(disc);
            point = origin.clone().addScaledVector(dir, t);
            altKm = 0;
        } else if (tClose > 0) {
            point = perp;
            altKm = (perpR - 1) * R_EARTH_KM;
        } else {
            // Looking away from the planet entirely — the ray only
            // recedes, so its closest approach is the camera itself.
            point = origin.clone();
            altKm = camAltKm;
        }

        const geo = geoFromVectors(
            [point.x, point.y, point.z],
            [this._sunDir.x, this._sunDir.y, this._sunDir.z],
        );
        return {
            tangentAltKm: altKm,
            hitsPlanet,
            withinModel: altKm <= 2000,
            point: { x: point.x, y: point.y, z: point.z },
            latDeg: geo.latDeg,
            lstHr: geo.lstHr,
            camAltKm,
        };
    }

    /**
     * Screen RADII of the limb at a set of altitudes, plus the disc centre.
     *
     * Returns radii rather than points so the overlay can hang its ruler
     * along whatever screen bearing is least cluttered without this method
     * needing to know anything about the page's chrome.
     *
     * The radius for altitude h is the projected distance from the disc
     * centre to the silhouette of the sphere of radius (1 + h/R⊕) — the
     * point where the view ray is TANGENT to that sphere, which is what
     * "the limb at h" means. Using the silhouette rather than a fixed
     * world direction is what keeps the ticks on the limb as the camera
     * orbits.
     *
     * Off-centre the silhouette of a sphere under perspective is a slight
     * ellipse, so one radius is an approximation away from the view axis.
     * At any framing where the whole planet is visible the error is well
     * under a pixel; a ruler is not a measurement instrument here, it is a
     * legend for the render's vertical axis.
     */
    /**
     * Where the TANGENT rays for each altitude meet the limb, on screen, in
     * the vertical plane through the camera and the sightline at NDC x =
     * `ndcX` (screen-left by default). This is the ruler for a LIMB view:
     * there the planet's centre is far off-screen, the disc ruler below has
     * nothing to hang on, and what the eye reads is tangent height — each
     * point is where a ray grazing that altitude touches it. Pure geometry
     * on the unit sphere; the overlay stays three-free.
     */
    limbTangentTicks(altitudesKm, ndcX = -0.55) {
        const cam = this._camera;
        const C = cam.position.clone();
        const d = C.length();
        const dir = new THREE.Vector3(ndcX, 0, 0.5).unproject(cam).sub(cam.position).normalize();
        const ec = C.clone().normalize();
        const ef = dir.clone().addScaledVector(ec, -dir.dot(ec));
        if (!(d > 1) || ef.lengthSq() < 1e-10) return [];
        ef.normalize();
        const out = [];
        for (const altKm of altitudesKm) {
            const r = 1 + altKm / R_EARTH_KM;
            if (r >= d) continue;
            const cosA = r / d, sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
            const T = ec.clone().multiplyScalar(r * cosA).addScaledVector(ef, r * sinA);
            const scr = this.projectToScreen(T.x, T.y, T.z);
            if (scr.behind) continue;
            out.push({ altKm, x: scr.x, y: scr.y });
        }
        return out;
    }

    limbTicks(altitudesKm) {
        const cam = this._camera.position.clone();
        const d = cam.length();
        const centre = this.projectToScreen(0, 0, 0);
        if (!Number.isFinite(d) || d <= 0 || centre.behind) {
            return { centre: null, ticks: [] };
        }
        const camDir = cam.clone().normalize();
        // Any direction perpendicular to the view axis works for measuring
        // the silhouette radius.
        let side = new THREE.Vector3(0, 1, 0)
            .sub(camDir.clone().multiplyScalar(camDir.y));
        if (side.lengthSq() < 1e-8) side = new THREE.Vector3(1, 0, 0);
        side.normalize();

        const ticks = [];
        for (const altKm of altitudesKm) {
            const r = 1 + altKm / R_EARTH_KM;
            if (r >= d) continue;                 // camera inside this shell
            const cosA = r / d;
            const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
            const p = camDir.clone().multiplyScalar(r * cosA)
                .addScaledVector(side, r * sinA);
            const scr = this.projectToScreen(p.x, p.y, p.z);
            if (scr.behind) continue;
            ticks.push({
                altKm,
                screenRadius: Math.hypot(scr.x - centre.x, scr.y - centre.y),
            });
        }
        // Surface radius too, so the overlay can anchor the ruler's base.
        const cosS = 1 / d, sinS = Math.sqrt(Math.max(0, 1 - cosS * cosS));
        const ps = camDir.clone().multiplyScalar(cosS).addScaledVector(side, sinS);
        const ss = this.projectToScreen(ps.x, ps.y, ps.z);
        return {
            centre: { x: centre.x, y: centre.y },
            surfaceRadius: ss.behind ? null
                : Math.hypot(ss.x - centre.x, ss.y - centre.y),
            ticks,
        };
    }

    _initResize() {
        const resize = () => {
            const { clientWidth: w, clientHeight: h } = this.canvas;
            if (w === 0 || h === 0) return;
            this._renderer.setSize(w, h, false);
            this._camera.aspect = w / h;
            this._camera.updateProjectionMatrix();
        };
        resize();
        this._resizeObs = new ResizeObserver(resize);
        this._resizeObs.observe(this.canvas);
    }

    _initTooltip() {
        // Build the tooltip DOM once. Positioned absolutely inside the
        // canvas's parent so it follows the mouse; hidden by default.
        const parent = this.canvas.parentElement;
        if (!parent) return;
        // Ensure the parent is a positioning context.
        if (getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }
        const tip = document.createElement('div');
        tip.className = 'ua-tooltip';
        tip.style.cssText = `
            position:absolute; pointer-events:none;
            background:rgba(8,4,22,.92);
            border:1px solid rgba(0,200,200,.35);
            border-radius:6px;
            padding:6px 9px;
            font: 11px system-ui, sans-serif;
            color:#cde;
            box-shadow: 0 2px 14px rgba(0,0,0,.6);
            transform: translate(-50%, -110%);
            white-space: nowrap;
            opacity: 0; transition: opacity 90ms;
            z-index: 10;
        `;
        parent.appendChild(tip);
        this._tip = tip;

        this._raycaster = new THREE.Raycaster();
        // Thicker hit area than the visual torus — makes these thin rings
        // actually catchable with the mouse.
        this._raycaster.params.Line   = { threshold: 0.02 };
        // Per-point picking on the debris cloud. Threshold is in world
        // units (R⊕); 0.02 ≈ 127 km, generous enough to catch a 0.014-
        // size sprite without overlap between dots in the typical
        // viewing range.
        this._raycaster.params.Points = { threshold: 0.02 };
        this._mouse = new THREE.Vector2(-9, -9);

        const hittable = () => [
            ...(this._satRings   || []),
            ...(this._shells     || []),
            ...(this._mpMesh     ? [this._mpMesh]     : []),
            ...(this._bsMesh     ? [this._bsMesh]     : []),
            ...(this._sheathMesh ? [this._sheathMesh] : []),
            ...(this._sunMarker  ? [this._sunMarker]  : []),
            // Each satellite probe (moving sprite) is independently
            // hittable so the tooltip + click-to-fly resolves to the
            // right satellite.
            ...Object.values(this._satProbes || {}).map(p => p.mesh),
            // Debris cloud — single Points object, but Three's Points
            // raycaster returns a per-point .index we use to resolve
            // which dot was hovered. See _findTaggedUserData below.
            ...(this._debrisCloud ? [this._debrisCloud] : []),
            // Magnetic-cascade artefacts — every line, oval band,
            // cusp dot, MLT marker, and FAC ring carries a tagged
            // userData; the recursive=true raycast finds them via
            // their parent groups.
            ...(this._cascade ? [this._cascade.group] : []),
            // Live-catalog Points cloud — populated lazily by
            // enableCatalogGroup(). Each point picks per-index back to
            // a TLE record via _resolveCatalogHit.
            ...(this._extraHittable || []),
        ];

        // Recursive: the ISS sprite carries a child halo mesh; if we
        // raycast non-recursively the halo eats hits and the parent's
        // userData isn't found. recursive=true makes the raycaster
        // descend; we look at hits[0].object.userData OR walk up to a
        // tagged ancestor.
        const _findTaggedUserData = (obj) => {
            let o = obj;
            while (o) {
                if (o.userData?.kind) return o.userData;
                o = o.parent;
            }
            return obj.userData || {};
        };

        /**
         * Per-debris userData resolver. The cloud-level userData has
         * kind='debris-cloud' (good for the legend) but we want the
         * tooltip + click-to-fly to talk about the *specific* piece
         * the user is pointing at. Three's points raycaster returns
         * an .index field on the intersection; we map it back into
         * the parallel this._debris array.
         */
        const _userDataForHit = (hit) => {
            if (!hit) return {};
            // Live-catalog cloud hit → resolve to a specific TLE.
            const catUd = this._resolveCatalogHit?.(hit);
            if (catUd) return catUd;
            // Debris cloud hit → resolve to a specific piece.
            if (hit.object === this._debrisCloud
                && Number.isFinite(hit.index)
                && this._debris?.[hit.index]) {
                const d = this._debris[hit.index];
                return {
                    kind:     'debris-piece',
                    id:       d.spec.id,
                    name:     d.spec.name,
                    altKm:    d.spec.altitudeKm,
                    color:    d.spec.color,
                    noradId:  d.spec.orbital?.noradId,
                    inclinationDeg: d.spec.orbital?.inclinationDeg,
                    periodMin:      d.spec.orbital?.periodMin,
                    debrisIdx:      hit.index,
                    tooltip:  'Click to fly the camera to this debris piece. '
                            + 'Drag pressure uses the live ρ at its current altitude.',
                };
            }
            return _findTaggedUserData(hit.object);
        };

        const onMove = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            this._mouse.x = (x / rect.width)  *  2 - 1;
            this._mouse.y = (y / rect.height) * -2 + 1;
            this._raycaster.setFromCamera(this._mouse, this._camera);
            // three's raycaster does not skip hidden objects: with the cascade
            // or the hoops hidden (focus, a toggle) a hover still hit them and
            // showed a tooltip titled 'undefined'. Take the first VISIBLE hit —
            // except the layer shells, which are hidden in the default volume
            // render but still answer "which layer is this" for the volume,
            // which has no hover of its own.
            const shown = (o) => {
                if (o.userData?.kind === 'layer-shell') return true;
                for (let p = o; p; p = p.parent) if (!p.visible) return false;
                return true;
            };
            const hits = this._raycaster.intersectObjects(hittable(), true).filter(h => shown(h.object));
            if (hits.length > 0) {
                const ud = _userDataForHit(hits[0]);
                tip.innerHTML = _tipHTML(ud, this._profile, this._swState);
                tip.style.left = `${x}px`;
                tip.style.top  = `${y}px`;
                tip.style.opacity = '1';
                this._hoveredUserData = ud;
                // Drive the debris-cloud highlight reticle. Stays in
                // sync with whichever dot the tooltip is describing —
                // if the hover moves off a debris hit, the index is
                // cleared and the reticle fades out.
                this._hoveredDebrisIdx = ud?.kind === 'debris-piece'
                    ? ud.debrisIdx
                    : null;
                this.canvas.style.cursor = 'pointer';
            } else {
                tip.style.opacity = '0';
                this._hoveredUserData = null;
                this._hoveredDebrisIdx = null;
                const m = this._controls.getMode();
                if (m === 'fly' || m === 'explore') {
                    this.canvas.style.cursor = 'crosshair';
                } else {
                    this.canvas.style.cursor = 'grab';
                }
            }
        };
        const onLeave = () => {
            tip.style.opacity = '0';
            this._hoveredDebrisIdx = null;
            this.canvas.style.cursor = 'grab';
        };
        // Click handler: clicking on the ISS probe flies the camera to it.
        // Designed to ignore drag-clicks (keep OrbitControls / fly-mode
        // mouse-look working) by tracking the down-position and only
        // firing if the mouse hasn't moved more than a few pixels.
        let downX = 0, downY = 0, downT = 0;
        // event.timeStamp, not performance.now(): timeStamp is when the
        // browser GENERATED the event, performance.now() is when the handler
        // finally ran. On a busy frame (this page rebuilds a lot per frame on
        // a weak GPU) delivery lags by hundreds of ms and a genuine click was
        // measured as a 'drag' and dropped — the mars.html 914 ms scar.
        const onDown = (e) => {
            downX = e.clientX; downY = e.clientY; downT = e.timeStamp;
        };
        const onUp = (e) => {
            const dx = Math.abs(e.clientX - downX);
            const dy = Math.abs(e.clientY - downY);
            const dt = e.timeStamp - downT;
            if (dx > 4 || dy > 4 || dt > 350) return;     // user dragged
            const ud = this._hoveredUserData;
            // Registered click handlers (launch-site picking) get first refusal.
            if (this._canvasClickHandlers?.length) {
                const rect = this.canvas.getBoundingClientRect();
                const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
                const ny = ((e.clientY - rect.top) / rect.height) * -2 + 1;
                for (const fn of this._canvasClickHandlers) {
                    try {
                        if (fn({ nx, ny, userData: ud, event: e })) {
                            // A double-click's clicks that a handler consumed (site
                            // picking) must not also start a dive.
                            this._clickConsumedAt = e.timeStamp;
                            return;
                        }
                    } catch (_) { /* isolate */ }
                }
            }
            // Phase 25: click on an orbital target both flies the
            // camera in AND engages follow — so the target stays in
            // frame as it propagates instead of immediately drifting
            // out of view after the flyTo animation completes. The
            // operator stops following by switching mode (Orbit/Fly
            // button) or by clicking "Stop follow" in the HUD.
            // A click on the target ALREADY being followed (or flown to) is a
            // no-op. While following, that target fills much of the frame, so
            // every click the visitor made to look around landed on it and
            // re-started the fly-in + lock — the camera could not be escaped
            // without finding Stop follow (reported 2026-10-04).
            if (ud?.kind === 'sat-probe' && ud.id) {
                if (this._isFollowTarget('sat', ud.id)) return;
                this._followId = { kind: 'sat', id: ud.id };
                this.flyToSatellite(ud.id, 1.6, { follow: true });
            } else if (ud?.kind === 'iss-probe') {
                if (this._isFollowTarget('sat', 'iss')) return;
                this.followISS();
            } else if (ud?.kind === 'debris-piece' && Number.isFinite(ud.debrisIdx)) {
                if (this._isFollowTarget('debris', ud.debrisIdx)) return;
                this._followId = { kind: 'debris', idx: ud.debrisIdx };
                this.flyToDebris(ud.debrisIdx, 1.6, { follow: true });
            } else if (ud?.kind === 'catalog-point' && (ud.line1 || ud.noradId)) {
                // The picked object's own orbit, drawn brighter than its suite's.
                if (ud.noradId != null) this.setFocusSatellite(ud.noradId);
                // Click on any live-catalog point → push into the
                // trajectory analyzer panel. Pass TLE inline if we have
                // it; analyzer falls back to /api/celestrak/tle?norad=
                // otherwise.
                try {
                    window.dispatchEvent(new CustomEvent('ua-analyze-sat', {
                        detail: {
                            id:    ud.id,
                            name:  ud.name,
                            color: ud.color,
                            line1: ud.line1,
                            line2: ud.line2,
                            noradId: ud.noradId,
                        }
                    }));
                } catch (_) { /* ignore */ }
            }
        };
        this.canvas.addEventListener('mousemove', onMove);
        this.canvas.addEventListener('mouseleave', onLeave);
        this.canvas.addEventListener('mousedown',  onDown);
        this.canvas.addEventListener('mouseup',    onUp);
        this._disposeHover = () => {
            this.canvas.removeEventListener('mousemove', onMove);
            this.canvas.removeEventListener('mouseleave', onLeave);
            this.canvas.removeEventListener('mousedown',  onDown);
            this.canvas.removeEventListener('mouseup',    onUp);
            tip.remove();
        };
    }

    _animate() {
        this._raf = requestAnimationFrame(this._animate);
        // Manual clock (the test hook): frames advance only through
        // stepFrames(), so nothing moves between a test's steps.
        if (this._manualClock) return;
        const t = this._clock.getElapsedTime();
        const dt = this._clock.getDelta();
        // The camera controller gets a REAL wall-clock delta. `dt` above is
        // ~0 every frame (Clock.getElapsedTime() consumes the delta — plan
        // §6), which left fly-mode WASD nearly frozen and the follow spring
        // (k = 1 − e^(−dt/τ)) never closing on its target. Only the controls
        // take the corrected value; every other consumer of `dt` keeps its
        // historical behaviour until its speed is looked at deliberately.
        const wallNow = performance.now();
        const dtWall = this._lastWallMs == null ? 0.016 : Math.min(0.1, (wallNow - this._lastWallMs) / 1000);
        this._lastWallMs = wallNow;
        // STATE every frame, GL only while the canvas is on screen — the
        // Stage / TIGA rule. Scrolled down the controls column, the page used
        // to keep issuing full renders of an invisible globe every 17 ms; on
        // a software rasteriser the queued work landed when the globe came
        // back as ONE 37-second frame (measured, 2026-10-05), and on a laptop
        // it is a GPU burning battery on pixels nobody sees.
        this._frame(t, dt, dtWall, { render: this._canvasOnScreen !== false, stepBus: true });
    }

    // ── Test hook: a manual, steppable frame clock ──────────────────────
    /**
     * Freeze the render loop onto a manual clock. While on, the rAF loop
     * idles, the shared frame clock (js/upper-atmosphere-frame-clock.js)
     * stands still, the time bus is not stepped (so the sun, the probes and
     * the scene instant are frozen), and frames advance only through
     * stepFrames(). Off resumes live without a jump. `startMs` pins the
     * manual clock's starting instant (default: the wall time of the switch).
     */
    setManualClock(on, { startMs = null } = {}) {
        on = !!on;
        if (on === !!this._manualClock) return;
        this._manualClock = on;
        // A fixed start makes time-driven visuals (aurora rays, the
        // discovery cadence) the same frame on every run.
        frameClock.setManual(on, startMs);
        if (on) {
            this._manualT = Number.isFinite(startMs) ? startMs / 1000 : this._clock.getElapsedTime();
        } else {
            this._lastWallMs = null;
            this._clock.getDelta();
        }
    }
    isManualClock() { return !!this._manualClock; }
    /**
     * Run `n` frames of exactly `dtSec` each (entering manual mode if
     * needed). `render`: 'last' (default — cheap on a software renderer,
     * the camera logic still runs every frame), 'each', or 'none'.
     * The legacy per-frame `dt` is passed as 0, which is what the live loop
     * hands those consumers (plan §6), so stepped frames match live ones.
     */
    stepFrames(n = 1, dtSec = 1 / 60, { render = 'last' } = {}) {
        if (!this._manualClock) this.setManualClock(true);
        const steps = Math.max(0, Math.floor(n));
        const dt = Number.isFinite(dtSec) && dtSec > 0 ? dtSec : 1 / 60;
        for (let i = 0; i < steps; i++) {
            frameClock.advance(dt * 1000);
            this._manualT += dt;
            const doRender = render === 'each' || (render === 'last' && i === steps - 1);
            this._frame(this._manualT, 0, dt, { render: doRender, stepBus: false });
        }
        return { timeMs: frameClock.now(), frames: steps };
    }
    /** Seed the stochastic visuals (the camera-local gas) for repeatable frames; null = Math.random. */
    seedRandom(seed) { this._transit?.setSeed(seed); }

    /**
     * One frame of the scene. `t` is the elapsed clock, `dt` the legacy
     * per-frame delta (~0, plan §6), `dtWall` the real (or stepped) delta the
     * camera stack uses.
     */
    _frame(t, dt, dtWall, { render = true, stepBus = true } = {}) {
        if (this._skin) this._skin.update(t);

        // Per-frame particle integration. Each layer system runs its
        // thermal jitter + storm-drift step; cheap (~250 particles ×
        // 5 layers × ~10 ops). Hidden systems early-out via their
        // `this._n === 0` guard so an off-toggled layer costs nothing.
        if (this._particles) {
            for (const id in this._particles) {
                const sys = this._particles[id];
                if (sys.points.visible) sys.update(dt);
            }
        }

        // Turbulence wave-field ripple. Each visible zone advances its
        // travelling-wave phase from the shared clock; hidden zones early-
        // out inside update(). One uniform write per visible zone.
        if (this._waves && this._waveVisible) {
            for (const id in this._waves) this._waves[id].update(t);
        }

        // Drag-forecast tracer advection. Self-gates on visibility so it
        // costs nothing when the operator panel is closed. Camera distance
        // drives the LOD-style trail thinning so the field reads cleanly
        // at any zoom — full population up close, ~30% out near the stars.
        if (this._dragOverlay) {
            this._dragOverlay.setZoomLevel(this._camera.position.length());
            this._dragOverlay.update(dt);
        }

        // Real-time Earth–Sun geometry. We don't rotate the Earth mesh or
        // the camera here — instead the sub-solar point is recomputed from
        // the wall clock every frame so the day-side terminator tracks
        // reality at the actual sidereal rate (≈15°/hour). The user reads
        // this as a stationary, physically-correct scene rather than the
        // old fast spin-and-circle.
        this._updateSunRealTime();
        this._updateAirglowField();

        // Push the live camera position into the shell shaders so their
        // limb fresnel tracks the current viewpoint.
        if (this._shells) {
            for (const sh of this._shells) {
                sh.material.uniforms.uCameraPos.value.copy(this._camera.position);
            }
        }
        // The volumetric march is camera-origin: every fragment casts its
        // ray from here, so this uniform is not optional. This call also
        // ticks the volume's quality governor, which starts on the cheapest
        // rung and climbs only while the frame interval says there is
        // headroom — it times itself rather than taking the `dt` above,
        // which is ~0 every frame (see _governQuality's comment).
        // Governed only on live frames of a canvas that is ON SCREEN (see the
        // IntersectionObserver in the renderer setup).
        this._volume?.update(this._camera, {
            govern: stepBus && this._canvasOnScreen !== false,
            viewportHeight: this.canvas.clientHeight,
        });

        // Solar-wind shaders: advance time for fresnel pulse + streamer
        // dash animation.
        if (this._mpMat)       this._mpMat.uniforms.uTime.value       = t;
        if (this._bsMat)       this._bsMat.uniforms.uTime.value       = t;
        if (this._streamMat)   this._streamMat.uniforms.uTime.value   = t;
        if (this._currentSheetMat) this._currentSheetMat.uniforms.uTime.value = t;
        // Sun shaders: photosphere granulation drift, multi-layer
        // corona breathing pulse, outgoing-streamer dash.
        if (this._sunPhotoMat)  this._sunPhotoMat.uniforms.uTime.value  = t;
        if (this._sunChromoMat) this._sunChromoMat.uniforms.uTime.value = t;
        if (this._sunHaloMat)   this._sunHaloMat.uniforms.uTime.value   = t;
        if (this._sunOuterMat)  this._sunOuterMat.uniforms.uTime.value  = t;
        if (this._sunStreamMat) this._sunStreamMat.uniforms.uTime.value = t;

        // Magnetic-field cascade: advance the packet-dash phase. One
        // uniform write feeds every L-shell field line.
        if (this._cascade) this._cascade.update(t);

        // Substorm state machine: tick → push to cascade → broadcast
        // for the UI panel. Skip the heavy refresh path while idle so
        // we don't spend cycles re-rebuilding the oval every frame
        // when nothing is happening.
        if (this._substorm && this._cascade) {
            const prevPhase = this._substorm.getTick().phase;
            const tick = this._substorm.update(dt);
            const isActive   = tick.phase !== 'idle';
            const wasActive  = prevPhase   !== 'idle';
            // Only push to cascade when the substorm is doing
            // something — every frame during active phases (so the
            // bulge / WTS / AE proxy update smoothly), plus a one-
            // shot zero-state push on the active→idle transition so
            // the oval snaps back to its quiet position.
            if (isActive || wasActive) {
                this._cascade.setSubstormState(
                    tick,
                    this._cascade._lastKpCached,
                );
                // Broadcast for the UI panel.
                try {
                    window.dispatchEvent(new CustomEvent('ua-substorm-tick', {
                        detail: tick,
                    }));
                } catch (_) { /* SSR / no-window — ignore */ }
            }
        }

        // The controls are stepped AFTER every position update below (just
        // before the render): a follow that aims at a target's PREVIOUS
        // position lags it by a frame's worth of motion, which on a slow
        // renderer at time-warp put the chased probe at the frame's edge.

        // Phase B: advance the shared time bus once per animate frame.
        // step() reads Date.now() internally + applies the current rate,
        // so the bus pauses naturally when the page is hidden (no Date
        // drift between frames). Every downstream consumer (sat probes,
        // debris, eventually realtime driver + analyzer) reads
        // bus.getSimTime() — one canonical "now" across the page.
        if (stepBus) this._timeBus?.step();

        // Per-frame satellite orbit propagation. Uses absolute sim-time
        // via the bus (Phase B) — each probe carries (_epochMs,
        // _M_epoch_rad) and computes M = M_epoch + n × (simTimeMs −
        // epochMs)/1000, so rate changes / scrubs / replay all yield
        // the correct position with no drift accumulation.
        if (this._satProbes) this._stepSatellites();
        if (this._debris)    this._stepDebris();
        if (this._constellationClouds) this._stepConstellations();
        // Flight layer: advances its own mission clock (live-locked to the
        // bus unless the deck detached it), pumps the kernel a few ms at a
        // time, and publishes the instant the sun should be drawn at.
        if (this._flight?.hasFlight()) {
            this._flight.update(this._camera, this.canvas.clientWidth, this.canvas.clientHeight);
            this._sceneTimeOverrideMs = this._flight.getSceneTimeMs();
        }
        if (this._phenomenaGroup) this._stepPhenomena(t);
        // Track the hovered debris with a face-on cyan reticle so
        // users can tell which of 50 identical-looking pink dots the
        // tooltip is describing. Cheap; just position + scale + lookAt.
        this._updateDebrisHighlight(t);

        // Conjunction screener: re-scan every 2 simulated seconds so
        // TCA times stay current as orbits evolve. Per-frame chord
        // line updates use whatever the cache holds — cheap.
        if (this._satProbes && (t - (this._lastConjScanTime ?? -Infinity)) > 2.0) {
            this._screenConjunctions();
            this._lastConjScanTime = t;
        }
        if (this._conjunctionLines) this._updateConjunctionLines();

        // Shell-fade-when-inside: when the camera enters a layer band,
        // drop the shell's opacity so the user can see through the layer
        // they're standing in. Cheap — five comparisons per frame.
        if (this._shells) this._fadeShellsForCameraAltitude();

        // Live-catalog tracker — propagate every loaded sat via Rust
        // SGP4 WASM at the SCENE instant. It was fed Date.now() until
        // 2026-10-04 while the named probes, the sun and the terminator all
        // read the bus: at 600× or under a scrub the catalogue sat at the
        // wall-clock instant over a globe drawn hours away — every dot in the
        // wrong place relative to its own day/night (gated by
        // tests/upper-atmosphere-satellites.spec.js, with that negative control).
        if (this._catalogTracker?.tick) {
            this._catalogTracker.tick(this._catalogClockMs());
        }
        if (this._suiteRings) this._stepSuiteRings();

        this._controls.update(dtWall);
        // After the controls: while a transit is active it owns the pose,
        // and the ambient gas is re-sampled at wherever the camera now is.
        this._transit?.update(this._camera, dtWall, {
            f107: this._state?.f107 ?? 150, ap: this._state?.ap ?? 15,
        });
        const camMode = this._controls.getMode();
        const travelling = camMode !== 'orbit' || this._controls.isPathActive?.()
            || !!this._transit?.getState?.().active;
        this._explore?.update(this._camera, {
            viewportHeight: this.canvas.clientHeight, travelling,
        });
        this._opsBands?.update(this._camera, { viewportHeight: this.canvas.clientHeight });
        this._updateExploreFocus(camMode);
        this._updateNearPlane();
        this._cme?.update(this._camera, dtWall);
        // The star backdrop rides the camera: it is at infinity, and with the
        // CME corridor up the camera can stand further out than its shell.
        if (this._stars) this._stars.position.copy(this._camera.position);

        if (!render) return;
        this._renderer.render(this._scene, this._camera);

        // 2-D instrument overlay, drawn after the GL frame so its ruler and
        // probe sit on top of what was just rendered. Its expensive parts
        // self-gate on the pointer and state actually having moved.
        this._instruments?.draw();
    }

    /**
     * Drop the gradient shell's opacity when the camera is inside its
     * altitude band; restore otherwise. Without this, free-fly users see
     * the additive blend stack up against the inside of every shell they
     * pass through, which reads as a wall of orange.
     */
    _fadeShellsForCameraAltitude() {
        const altKm = this.getCameraAltitudeKm();

        // Same problem for the volume: a camera deep inside the column
        // looks outward through the densest part of it and the additive
        // march saturates to a wall. Ease the whole render down as the
        // camera descends through the band rather than switching it off,
        // so the transition reads as flying into thickening air.
        if (this._volume) {
            const target = altKm > 900 ? 1.0
                         : altKm > 200 ? 0.35 + 0.65 * ((altKm - 200) / 700)
                         : 0.35;
            const cur = this._volumeFade ?? 1;
            this._volumeFade = cur + (target - cur) * 0.12;
            this._volume.setFade(this._volumeFade);
        }

        for (const sh of this._shells) {
            const ud = sh.userData;
            const inside = altKm >= ud.minKm && altKm <= ud.maxKm;
            // Use an explicit fade factor on each shell's intensity
            // uniform — multiplied with the base log-ρ intensity that
            // setProfile() set up.
            const baseFade = inside ? 0.18 : 1.0;
            // Smoothly blend so the transition isn't abrupt.
            const cur = sh.material.uniforms.uFade?.value ?? 1.0;
            const next = cur + (baseFade - cur) * 0.12;
            if (sh.material.uniforms.uFade) {
                sh.material.uniforms.uFade.value = next;
            }
        }
    }

    /**
     * Advance every cached satellite probe along its mean-element
     * orbit. Each probe carries its own (i, RAAN, M₀, period); the
     * helper _propagateKeplerian computes a position on the inclined
     * orbital plane in world frame.
     *
     * The probe's userData.altKm is updated each frame from the
     * computed |position| so the tooltip drag-pressure readout uses
     * the *current* altitude (not the spec's nominal value) — this
     * matters when we eventually upgrade to elliptical orbits with
     * non-zero eccentricity.
     */
    _stepSatellites() {
        // Phase B: absolute-time propagation from the shared TimeBus.
        //   M = M_epoch + (2π/periodSec) × (simTimeMs − epochMs) / 1000
        // The bus's rate / pause / scrub state is already baked into
        // simTimeMs by the time we read it, so this loop is unaware
        // of "live vs replay vs warp" — it just renders the orbit at
        // whatever moment the bus says is "now".
        const simTimeMs = this._timeBus.getSimTime();
        const TAU = 2 * Math.PI;
        // The scene is Earth-FIXED (the texture, the sun vector and the
        // SGP4 cloud all live in the canonical coords.js frame), so an
        // inertial orbit has to be turned by the sidereal angle of the
        // sim clock before it is drawn — the same rotation the catalogue
        // tracker applies. One angle per frame serves every probe.
        const gmst = this._gmstRad(simTimeMs);
        const cam = this._camera;
        for (const id in this._satProbes) {
            const probe = this._satProbes[id];
            const periodSec = probe.spec.orbital.periodMin * 60;
            const dtSec = (simTimeMs - probe._epochMs) / 1000;
            const M = probe._M_epoch_rad + (TAU * dtSec) / Math.max(periodSec, 1);
            // Convert M back into an orbit fraction for the helper.
            const tFrac = ((M / TAU) % 1 + 1) % 1;
            const altShellR = _probeRadius(probe);
            // A probe with a live TLE is drawn by the SAME propagator as its
            // own catalogue dot (SGP4) — or, until the WASM is in, by its
            // mean elements with J2 drift; only the nominal reference set
            // keeps the legacy circular Kepler. All via ONE function, so the
            // drawn probe, the follow camera and the screener cannot differ.
            const live = !!(probe._sgp4 || probe._el);
            const p = _eciSceneToEarthFixed(live
                ? _lookupProbePositionAt(probe, simTimeMs)
                : _propagateKeplerian(probe.spec.orbital, tFrac, altShellR), gmst);
            if (live && probe._el) this._refreshProbePathIfStale(probe, simTimeMs);

            probe.mesh.position.set(p.x, p.y, p.z);
            // The far-tier ball is 0.012 R⊕ (76 km) with a 166 km halo —
            // a legible dot from the default ~2 R⊕ view, a moon-sized disc
            // from a layer transit a few hundred km below it (measured: a
            // 4.6° ball over the 95 km horizon). Inside the reference range
            // it keeps the angle it has there; beyond it nothing changes.
            if (probe.farGrp && cam) {
                const d = cam.position.distanceTo(probe.mesh.position);
                probe.farGrp.scale.setScalar(Math.min(1, d / PROBE_MARKER_REF_RUNIT));
            }
            // The orbit-path loop is built once in the inertial frame;
            // turning the whole polyline is one assignment per frame.
            if (probe.pathLine) probe.pathLine.rotation.y = -gmst;
            // Update altitude from current radial distance — keeps the
            // tooltip honest if eccentricity is non-zero (apogee/perigee
            // sweep). For circular orbits the value is constant.
            const rNow = Math.hypot(p.x, p.y, p.z);
            probe.mesh.userData.altKm = sceneToPageAltKm(rNow);

            // Orient the sprite along the velocity tangent so users
            // can see direction-of-travel when zoomed in.
            let v;
            if (live) {
                // Inertial-frame velocity direction by a 1 s difference on
                // the same propagator (the Earth-fixed rotation over 1 s is
                // 0.004° — irrelevant to an orientation).
                const q = _lookupProbePositionAt(probe, simTimeMs + 1000);
                const p0 = _lookupProbePositionAt(probe, simTimeMs);
                v = _eciSceneToEarthFixed({ x: q.x - p0.x, y: q.y - p0.y, z: q.z - p0.z }, gmst, new THREE.Vector3()).normalize();
            } else {
                v = _eciSceneToEarthFixed(
                    _propagateKeplerianVelocity(probe.spec.orbital, tFrac, altShellR),
                    gmst, new THREE.Vector3());
            }
            const radial = probe.mesh.position.clone().normalize();
            const m = new THREE.Matrix4().lookAt(
                probe.mesh.position,
                probe.mesh.position.clone().add(v),
                radial,
            );
            probe.mesh.quaternion.setFromRotationMatrix(m);
        }
    }

    /**
     * Snapshot of every satellite probe's *current* state, used by the
     * UI's drag-analysis side panel. Cheap — just reads cached probe
     * positions; no engine sampling here. Returns one entry per
     * orbital satellite; non-orbital references (Kármán) are skipped.
     */
    getSatelliteStates() {
        const out = [];
        if (!this._satProbes) return out;
        for (const id in this._satProbes) {
            const probe = this._satProbes[id];
            const rNow  = probe.mesh.position.length();
            const altKm = (rNow - 1) * R_EARTH_KM;
            out.push({
                id,
                name:    probe.spec.name,
                color:   probe.spec.color,
                altKm,
                noradId: probe.spec.orbital.noradId,
                periodMin: probe.spec.orbital.periodMin,
                inclinationDeg: probe.spec.orbital.inclinationDeg,
            });
        }
        return out;
    }

    /**
     * Full drag-analysis snapshot for every orbital satellite at the
     * current state. Returns altitude, ρ (sampled from the active
     * profile), circular orbital speed, drag pressure q = ½ρv², and a
     * Knudsen-derived regime label. Sorted descending by drag — the UI
     * panel shows "ISS feels the most drag" most-prominently.
     *
     * This couples globe state (probe altitude) with engine state
     * (profile from setProfile) so the panel reads off the same source
     * of truth as the rest of the page.
     */
    getSatelliteDragAnalysis() {
        const states = this.getSatelliteStates();
        if (!this._profile?.samples?.length) return states.map(s => ({ ...s, rho: null, q: null }));
        const out = states.map(s => {
            const rho = _nearestRho(this._profile.samples, s.altKm);
            const vKmS = _circularOrbitalSpeedKmS(s.altKm);
            const v = vKmS * 1000;                          // m/s
            const q = 0.5 * rho * v * v;                    // Pa
            // Carry the live/fallback flag + epoch into the panel so
            // users can see which probes are running on real CelesTrak
            // elements vs the hardcoded backstop.
            const probe = this._satProbes?.[s.id];
            const tleSource = probe?.mesh?.userData?.tleSource ?? 'fallback';
            const tleEpoch  = probe?.mesh?.userData?.tleEpoch  ?? null;
            return {
                ...s,
                rho,
                vKmS,
                qPa: q,
                qmPa: q * 1000,
                tleSource, tleEpoch,
            };
        });
        // Highest drag first — useful ranking for the panel.
        out.sort((a, b) => (b.qPa ?? 0) - (a.qPa ?? 0));
        return out;
    }

    // ── Conjunction screening ──────────────────────────────────────────────
    //
    // For each pair of orbital probes we sweep simulated-time from
    // "now" out to `horizonMin` minutes in `stepSec`-second
    // increments, find the time of closest approach (TCA) and the
    // miss distance there, plus the current separation. Results are
    // cached on this._conjunctions; the UI repaints from the cache.
    //
    // Cost: 6 pairs × 180 steps × 2 lookups + cheap math = ~10 k ops
    // per scan. We rerun every 2 s. Imperceptible.
    //
    // Time axis is *simulated* seconds (real orbital time), not page-
    // clock seconds. With opts.satTimeScale = 60×, "TCA in 47 min"
    // means 47 minutes of physical orbital evolution; the user will
    // see it occur after ~47 page-seconds.

    _setupConjunctionScreener() {
        this._conjunctions = [];
        // Lines connecting predicted-close pairs, drawn with additive
        // blending so they read against the dark backdrop.
        this._conjunctionGroup = new THREE.Group();
        this._conjunctionGroup.name = 'conjunction-chords';
        this._scene.add(this._conjunctionGroup);
        this._conjunctionLines = {};        // pairKey → THREE.Line — asset-asset, fixed
        this._debrisChordPool  = [];        // reusable pool for top-N asset-debris threats

        // Build one line per asset-asset pair right away so endpoint
        // updates don't pay for geometry creation in the hot path.
        const probes = Object.values(this._satProbes || {});
        for (let i = 0; i < probes.length; i++) {
            for (let j = i + 1; j < probes.length; j++) {
                const a = probes[i], b = probes[j];
                const key = _pairKey(a.spec.id, b.spec.id);
                const line = _buildChordLine({
                    aId:   a.spec.id, bId: b.spec.id,
                    aName: a.spec.name, bName: b.spec.name,
                });
                this._conjunctionLines[key] = line;
                this._conjunctionGroup.add(line);
            }
        }

        // Pre-allocate a small pool of chord lines for asset↔debris
        // threats so the per-frame logic doesn't allocate. Three is
        // enough — beyond that the scene gets cluttered and the panel
        // already lists more in detail.
        const POOL_SIZE = 3;
        for (let i = 0; i < POOL_SIZE; i++) {
            const line = _buildChordLine({});       // anonymous; reassigned per scan
            this._debrisChordPool.push(line);
            this._conjunctionGroup.add(line);
        }

        this._lastConjScanTime = -Infinity;
    }

    /**
     * Sweep every probe pair over the next `horizonMin` simulated
     * minutes and update this._conjunctions in place. Cheap; fed by
     * the per-probe phase-indexed lookup tables built at probe spawn.
     */
    _screenConjunctions({ horizonMin = 90, stepSec = 30, altPreFilterKm = 250 } = {}) {
        const assets = Object.values(this._satProbes || {});
        const debris = this._debris || [];
        if (assets.length < 1) {
            this._conjunctions = [];
            return;
        }

        // Phase B: scan walks forward from simTimeMs (absolute, in ms)
        // by stepSec increments per iteration. Each lookup takes the
        // proposed sim-time directly, so changing the bus's rate or
        // pausing doesn't change WHICH future moments we scan — the
        // physics window is anchored at simTimeMs regardless of how
        // fast it's advancing.
        const nowMs = this._timeBus.getSimTime();
        const horizonSec = horizonMin * 60;
        const nSteps = Math.max(2, Math.floor(horizonSec / stepSec) + 1);

        const out = [];

        // Each object's track over the horizon is computed ONCE per scan and
        // shared by every pair it is in. Every object now goes through the
        // one `_lookupProbePositionAt` its drawn dot uses (SGP4 / mean
        // elements + J2), which costs more per call than the old phase table
        // — memoising is what keeps assets × debris × steps affordable.
        const tracks = new Map();
        const trackOf = (o) => {
            let t = tracks.get(o);
            if (!t) {
                t = new Float32Array(nSteps * 3);
                for (let k = 0; k < nSteps; k++) {
                    const p = _lookupProbePositionAt(o, nowMs + k * stepSec * 1000);
                    t[k * 3] = p.x; t[k * 3 + 1] = p.y; t[k * 3 + 2] = p.z;
                }
                tracks.set(o, t);
            }
            return t;
        };
        // Inner helper to scan one pair across the horizon.
        const scan = (a, b) => {
            let minDist = Infinity, minStep = 0;
            let firstDist = 0;
            const ta = trackOf(a), tb = trackOf(b);
            for (let k = 0; k < nSteps; k++) {
                const o = k * 3;
                const dx = ta[o] - tb[o];
                const dy = ta[o + 1] - tb[o + 1];
                const dz = ta[o + 2] - tb[o + 2];
                const d2 = dx * dx + dy * dy + dz * dz;
                if (k === 0) firstDist = Math.sqrt(d2);
                if (d2 < minDist) { minDist = d2; minStep = k; }
            }
            return {
                currDistKm: firstDist * R_EARTH_KM,
                tcaDistKm:  Math.sqrt(minDist) * R_EARTH_KM,
                tcaTimeSec: minStep * stepSec,
            };
        };

        // ── Asset ↔ asset (always screened; the small N=4 case) ───────
        for (let i = 0; i < assets.length; i++) {
            for (let j = i + 1; j < assets.length; j++) {
                const a = assets[i], b = assets[j];
                // Altitude pre-filter — paired LEO assets pass easily,
                // but it costs nothing here and keeps GEO/MEO additions
                // robust against quadratic blow-ups in future rounds.
                if (Math.abs(a.spec.altitudeKm - b.spec.altitudeKm) > altPreFilterKm) continue;
                const r = scan(a, b);
                out.push({
                    kind: 'asset-asset',
                    aId: a.spec.id, bId: b.spec.id,
                    aName: a.spec.name, bName: b.spec.name,
                    aColor: a.spec.color, bColor: b.spec.color,
                    aNorad: a.spec.orbital?.noradId,
                    bNorad: b.spec.orbital?.noradId,
                    ...r,
                });
            }
        }

        // ── Asset ↔ debris ────────────────────────────────────────────
        // Pre-filter cuts the propagation cost for orbits that can
        // never come within altPreFilterKm anyway. For 4 assets × 50
        // debris, typical post-filter pair count is 30–80 — a small
        // fraction of the worst-case 200. Each surviving pair still
        // runs nSteps=180 lookups so the screener stays bounded.
        for (const a of assets) {
            for (const b of debris) {
                if (Math.abs(a.spec.altitudeKm - b.spec.altitudeKm) > altPreFilterKm) continue;
                const r = scan(a, b);
                out.push({
                    kind: 'asset-debris',
                    aId: a.spec.id, bId: b.spec.id,
                    aName: a.spec.name, bName: b.spec.name,
                    aColor: a.spec.color, bColor: b.spec.color,
                    aNorad: a.spec.orbital?.noradId,
                    bNorad: b.spec.orbital?.noradId,
                    ...r,
                });
            }
        }

        out.sort((p, q) => p.tcaDistKm - q.tcaDistKm);
        this._conjunctions = out;
    }

    /**
     * Update each per-pair chord line's endpoints to the live probe
     * positions and set color/opacity from the cached TCA prediction.
     * Drawn faint by default; intensifies for pairs with a tight TCA.
     */
    _updateConjunctionLines() {
        if (!this._conjunctionLines || !this._conjunctions) return;
        const watchKm = 200;

        // Build a quick id-pair → cached entry map for O(1) lookup
        // when refreshing the fixed asset-asset chord lines.
        const byKey = {};
        for (const c of this._conjunctions) byKey[_pairKey(c.aId, c.bId)] = c;

        // ── Asset ↔ asset: fixed lines, keyed by pair ─────────────────
        for (const key in this._conjunctionLines) {
            const line = this._conjunctionLines[key];
            const c = byKey[key];
            const pa = this._satProbes?.[line.userData.aId]?.mesh.position;
            const pb = this._satProbes?.[line.userData.bId]?.mesh.position;
            if (!c || !pa || !pb || c.tcaDistKm > watchKm) {
                line.material.opacity = 0;
                continue;
            }
            _paintChordLine(line, pa, pb, c, watchKm);
        }

        // ── Asset ↔ debris: top-N threats, painted into a small pool ──
        // The pool is a fixed-size set of THREE.Lines that we
        // repurpose each scan. Lines beyond the live threat count are
        // hidden by setting opacity to 0.
        const pool = this._debrisChordPool || [];
        const debrisThreats = this._conjunctions
            .filter(c => c.kind === 'asset-debris' && c.tcaDistKm <= watchKm)
            .slice(0, pool.length);

        for (let i = 0; i < pool.length; i++) {
            const line = pool[i];
            const c = debrisThreats[i];
            if (!c) {
                line.material.opacity = 0;
                continue;
            }
            const pa = this._satProbes?.[c.aId]?.mesh.position;
            // Debris position from the cloud's flat position buffer —
            // O(1) lookup via the debris index.
            const debrisIdx = (this._debris || []).findIndex(d => d.spec.id === c.bId);
            if (!pa || debrisIdx < 0) {
                line.material.opacity = 0;
                continue;
            }
            const pos = this._debrisPositions;
            const pb = {
                x: pos[debrisIdx * 3],
                y: pos[debrisIdx * 3 + 1],
                z: pos[debrisIdx * 3 + 2],
            };
            // Update the line's userData with the live pair so the
            // tooltip pipeline (raycaster) can describe the threat
            // even though the pool slot was repurposed.
            line.userData.aId  = c.aId;
            line.userData.bId  = c.bId;
            line.userData.aName = c.aName;
            line.userData.bName = c.bName;
            line.userData.tooltip = `Predicted close approach: ${c.aName} ↔ ${c.bName} (debris).`;
            _paintChordLine(line, pa, pb, c, watchKm);
        }
    }

    /**
     * Public snapshot for the UI conjunction-watch panel. Triggers
     * a screen if cache is stale (> 2 s old). Returns the cached
     * pair list sorted by TCA-distance ascending.
     */
    getConjunctionAnalysis() {
        const now = performance.now() / 1000;
        if (!this._conjunctions || (now - (this._lastConjScanTime ?? -Infinity)) > 2.0) {
            this._screenConjunctions();
            this._lastConjScanTime = now;
        }
        return this._conjunctions || [];
    }
}

// ── Keplerian orbit helper ─────────────────────────────────────────────────
// Visualisation-grade propagator. Inputs are mean elements; output is a
// position on the inclined orbital plane in world frame, scaled to a
// `radius` representative altitude so the math stays in R⊕ units the rest
// of the page works in.
//
// Convention: orbital plane is rotated from the equatorial plane by the
// inclination around X, then around Y by RAAN. Argument of perigee is
// folded into the in-plane angle so we can keep argP non-zero for users
// who want to play with apsides later.
//
// For circular orbits (eccentricity ≈ 0) we skip Kepler's-equation
// solving entirely — eccentric anomaly equals mean anomaly, and the
// in-plane radius is constant. tFrac is in [0, 1) along one orbit; the
// caller advances it deterministically each frame.
function _propagateKeplerian(orb, tFrac, radius) {
    const i = orb.inclinationDeg * Math.PI / 180;
    const Ω = orb.raanDeg         * Math.PI / 180;
    const ω = orb.argPerigeeDeg   * Math.PI / 180;
    const M = tFrac * 2 * Math.PI;
    const e = orb.eccentricity ?? 0;

    // True anomaly = mean anomaly for circular orbit; otherwise solve
    // Kepler's equation by Newton-Raphson and convert.
    let nu;
    if (e < 1e-4) {
        nu = M;
    } else {
        let E = M;
        for (let k = 0; k < 6; k++) {
            E = E - (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
        }
        nu = 2 * Math.atan2(
            Math.sqrt(1 + e) * Math.sin(E / 2),
            Math.sqrt(1 - e) * Math.cos(E / 2),
        );
    }
    const θ = ω + nu;
    const r = radius * (e < 1e-4 ? 1 : (1 - e * e) / (1 + e * Math.cos(nu)));

    // In-plane (perifocal) coordinates with x along ascending node.
    const xp = r * Math.cos(θ);
    const yp = r * Math.sin(θ);

    // Rotate to ECI using the standard 3-1-3 sequence (RAAN, incl,
    // argP); since argP was folded into θ above, we only need the
    // incl + RAAN rotations here. ECI is the canonical Z-up,
    // equatorial-XY frame used by SGP4 and pretty much every
    // satellite catalog.
    const cosI = Math.cos(i), sinI = Math.sin(i);
    const cosΩ = Math.cos(Ω), sinΩ = Math.sin(Ω);
    // Rotation around X by inclination: (xp, yp, 0) → (xp, yp·cosI, yp·sinI).
    const xa = xp;
    const ya = yp * cosI;
    const za = yp * sinI;
    // Rotation around Z by RAAN.
    const xEci = xa * cosΩ - ya * sinΩ;
    const yEci = xa * sinΩ + ya * cosΩ;
    const zEci = za;

    // Map ECI Z-up → the scene's Y-up axes the CANONICAL way (js/geo/
    // coords.js `eciToEcef` at GMST = 0: scene = [x, z, −y]). This is
    // the inertial frame expressed in scene axes; it is NOT yet Earth-
    // fixed. Callers that DRAW must rotate the result by the sidereal
    // angle of the sim clock (`_eciSceneToEarthFixed`) or the orbit
    // sits still while the planet does not. Until 2026-09-27 this
    // returned [x, z, +y] — the mirror — and was never rotated, so every
    // reference orbit on the page ran RETROGRADE against the continents
    // and sat over the wrong ground; the catalogue cloud, drawn through
    // coords.js, disagreed with it by exactly that.
    return { x: xEci, y: zEci, z: -yEci };
}

/**
 * Rotate an inertial position (ECI in scene axes, from
 * `_propagateKeplerian` / the probe lookup tables) into the scene's
 * Earth-fixed frame at Greenwich sidereal angle `gmstRad`. This is
 * coords.js `eciToEcef` written out for the (x, z, −y) axis order:
 * a rotation of −gmst about +Y. The orbit-path polylines get the same
 * thing as `rotation.y = −gmst`.
 */
function _eciSceneToEarthFixed(p, gmstRad, out = null) {
    const c = Math.cos(gmstRad), s = Math.sin(gmstRad);
    const x = c * p.x - s * p.z;
    const z = s * p.x + c * p.z;
    if (out) { out.set(x, p.y, z); return out; }
    return { x, y: p.y, z };
}

/**
 * Velocity tangent at the same orbital position. Used for sprite
 * orientation; returned as a unit vector in world frame.
 */
function _propagateKeplerianVelocity(orb, tFrac, radius) {
    // Forward-difference: sample a hair ahead and subtract. Cheap and
    // mode-agnostic (works for circular and elliptical alike) without
    // re-deriving the analytic dr/dν.
    const dt = 1e-4;
    const a = _propagateKeplerian(orb, tFrac,             radius);
    const b = _propagateKeplerian(orb, (tFrac + dt) % 1,  radius);
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    return new THREE.Vector3(dx / len, dy / len, dz / len);
}

// ── Utilities ──────────────────────────────────────────────────────────────

function _nearestRho(samples, altitudeKm) {
    let lo = 0, hi = samples.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].altitudeKm < altitudeKm) lo = mid + 1;
        else hi = mid;
    }
    const a = samples[Math.max(0, lo - 1)];
    const b = samples[lo];
    return Math.abs(a.altitudeKm - altitudeKm) < Math.abs(b.altitudeKm - altitudeKm)
        ? a.rho
        : b.rho;
}

/**
 * Solve the altitude (km) where the profile's mass density crosses
 * `targetRho`. The profile is altitude-ascending with monotonically
 * falling ρ, so we scan for the first bracketing pair and interpolate in
 * LOG-density / linear-altitude space (density is ~exponential in
 * altitude, so log ρ is near-linear and the interpolation is accurate).
 *
 * Returns NaN when the target lies outside the profile's density range —
 * i.e. no constant-density surface exists at this threshold for the
 * current state (the caller hides that surface).
 */
function _altitudeForRho(samples, targetRho) {
    if (!samples?.length || !(targetRho > 0)) return NaN;
    const logT = Math.log(targetRho);
    for (let i = 1; i < samples.length; i++) {
        const r0 = samples[i - 1].rho, r1 = samples[i].rho;
        if (!(r0 > 0) || !(r1 > 0)) continue;
        const l0 = Math.log(r0), l1 = Math.log(r1);
        // Bracketed when the target log-density sits between the pair.
        if ((logT <= l0 && logT >= l1) || (logT >= l0 && logT <= l1)) {
            const denom = (l1 - l0);
            const f = Math.abs(denom) < 1e-12 ? 0 : (logT - l0) / denom;
            return samples[i - 1].altitudeKm
                 + f * (samples[i].altitudeKm - samples[i - 1].altitudeKm);
        }
    }
    return NaN;
}

function _ringMesh(radius, tubeRadius, colorHex, opacity = 0.75) {
    const geom = new THREE.TorusGeometry(radius, tubeRadius, 12, 160);
    const mat = new THREE.MeshBasicMaterial({
        color: colorHex,
        transparent: true,
        opacity,
        depthWrite: false,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.rotation.x = Math.PI / 2;
    return mesh;
}

function _hex(colorStr) {
    if (typeof colorStr === "number") return colorStr;
    if (!colorStr) return 0xffffff;
    return parseInt(colorStr.replace("#", ""), 16);
}

/**
 * Circular orbital speed at altitude `altKm`. Uses Earth's standard
 * gravitational parameter μ = 398 600.4418 km³/s² and the WGS-72 mean
 * radius (matches the SGP4 propagator's RE_KM upstream so we stay on
 * one consistent reference). Returns km/s.
 *
 *   v = √(μ / (Rₑ + h))
 *
 * For ISS @ 420 km this gives 7.66 km/s, the canonical value.
 */
function _circularOrbitalSpeedKmS(altKm) {
    const MU = 398600.4418;     // km³/s²
    // Callers pass PAGE altitudes (above the 6371 sphere, the probes'
    // userData.altKm), so the radius is the page datum's — adding them to
    // WGS-72's 6378.135 counted the 7 km datum offset twice.
    const r = PAGE_RE_KM + altKm;
    return Math.sqrt(MU / r);
}

/**
 * Stable key for an unordered probe pair. Sorted-string concat so
 * (iss, hubble) and (hubble, iss) hash to the same chord line.
 */
function _pairKey(idA, idB) {
    return idA < idB ? `${idA}__${idB}` : `${idB}__${idA}`;
}

/**
 * Build one chord-line scaffold (2-vertex BufferGeometry +
 * additive-blended LineBasicMaterial). Used both for the fixed
 * asset-asset pairs and for the recyclable debris-threat pool;
 * userData is filled in by the caller / per-frame update.
 */
/**
 * Paint one chord line from `pa` to `pb` and color/opacity-modulate
 * by the TCA prediction `c`. Shared by the asset-asset branch and
 * the debris-pool branch of _updateConjunctionLines.
 */
function _paintChordLine(line, pa, pb, c, watchKm) {
    const pos = line.geometry.attributes.position.array;
    pos[0] = pa.x; pos[1] = pa.y; pos[2] = pa.z;
    pos[3] = pb.x; pos[4] = pb.y; pos[5] = pb.z;
    line.geometry.attributes.position.needsUpdate = true;
    // Color by predicted TCA distance — red <10 km, orange <50 km,
    // yellow <200 km. Opacity ramps up as the *current* separation
    // approaches the predicted TCA distance, so the line literally
    // lights up at the moment of closest approach.
    const col = c.tcaDistKm < 10  ? 0xff3060
              : c.tcaDistKm < 50  ? 0xff8a3a
              : 0xffd060;
    line.material.color.setHex(col);
    const ratio = Math.max(0, 1 - (c.currDistKm / Math.max(watchKm, c.tcaDistKm * 4)));
    line.material.opacity = 0.20 + 0.55 * ratio;
}

function _buildChordLine(userData) {
    const positions = new Float32Array(6);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
        color:       0x888888,
        transparent: true,
        opacity:     0.0,
        depthWrite:  false,
        blending:    THREE.AdditiveBlending,
    });
    const line = new THREE.Line(geom, mat);
    line.frustumCulled = false;
    line.userData = { kind: 'conjunction-chord', ...userData };
    return line;
}

/**
 * O(1) probe-position lookup via the precomputed phase-indexed
 * table. Phase B switched this to ABSOLUTE-time signature: pass a
 * Unix-ms timestamp (typically from the shared TimeBus) and the
 * helper resolves the corresponding mean anomaly directly from the
 * probe's epoch anchor:
 *
 *     M = _M_epoch_rad + n × (simTimeMs − _epochMs) / 1000
 *
 * where n = 2π / periodSec. This formula is stable under rate
 * changes, scrubbing, and replay: the same simTimeMs always yields
 * the same position, regardless of how long the renderer has been
 * running or how many rate edits the operator has made.
 *
 * Probes lacking explicit (_epochMs, _M_epoch_rad) — older code
 * paths or tests — fall back to the legacy _phase0 read using
 * the probe's own creation-time as the implicit epoch.
 *
 * Falls back to a fresh trig-based propagate when the precomputed
 * phase-table isn't built yet (only on the first frame post-spawn).
 */
const _lookupScratch = [0, 0, 0];

/**
 * Scene radius of an element-free probe: its own `_rScene` (a synthetic
 * shell quoted in the catalogue convention) or its PAGE altitude.
 */
function _probeRadius(probe) {
    return Number.isFinite(probe._rScene) ? probe._rScene : pageAltToScene(probe.spec.altitudeKm);
}

function _lookupProbePositionAt(probe, simTimeMs) {
    // ONE position per object (2026-10-04). In order:
    //   1. SGP4 on the probe's live TLE — the propagator its catalogue dot
    //      is drawn with, so a named probe and the same NORAD in a suite
    //      coincide (they used to sit hundreds of km apart: frozen node);
    //   2. mean elements + secular J2 (js/upper-atmosphere-sat-suites.js) —
    //      every catalogue record without lines, and a TLE probe until the
    //      WASM is in (~8 km of SGP4 in LEO, measured);
    //   3. the legacy phase table — nominal references and synthetic
    //      Walker shells, which have no epoch to propagate from.
    // Returned in the INERTIAL scene frame; callers turn it by −GMST.
    if (probe._sgp4) {
        const g = probe._sgp4;
        try {
            const st = g.wasm.propagate_tle(g.line1, g.line2, (simTimeMs - g.epochMs) / 60000);
            if (st && Number.isFinite(st[0])) {
                return { x: st[0] / PAGE_RE_KM, y: st[2] / PAGE_RE_KM, z: -st[1] / PAGE_RE_KM };
            }
        } catch (_) { /* decayed / refused → the mean elements below */ }
    }
    if (probe._el) {
        const q = inertialSceneAt(probe._el, simTimeMs, probe._perifocal, _lookupScratch);
        return { x: q[0], y: q[1], z: q[2] };
    }
    const periodSec = probe.spec.orbital.periodMin * 60;
    const TAU = 2 * Math.PI;
    // Mean anomaly via absolute time. The two-branch fallback keeps
    // synthetic probes (no TLE epoch wired) working — they have
    // _phase0 but no _epochMs / _M_epoch_rad until the constructor
    // helper backfills them.
    const epochMs    = Number.isFinite(probe._epochMs) ? probe._epochMs : 0;
    const M_at_epoch = Number.isFinite(probe._M_epoch_rad) ? probe._M_epoch_rad
                        : (probe._phase0 ?? 0);
    const dtSec = (simTimeMs - epochMs) / 1000;
    const M = M_at_epoch + (TAU * dtSec) / Math.max(periodSec, 1);

    if (!probe._propTable || !periodSec) {
        const tFrac = ((M / TAU) % 1 + 1) % 1;
        const r = _probeRadius(probe);
        return _propagateKeplerian(probe.spec.orbital, tFrac, r);
    }
    const N = probe._propTableN;
    const phaseFrac = ((M / TAU) % 1 + 1) % 1;
    const fIdx = phaseFrac * N;
    const k0 = Math.floor(fIdx) % N;
    const k1 = (k0 + 1) % N;
    const t  = fIdx - Math.floor(fIdx);
    const tbl = probe._propTable;
    const a0 = k0 * 3, a1 = k1 * 3;
    return {
        x: tbl[a0]     * (1 - t) + tbl[a1]     * t,
        y: tbl[a0 + 1] * (1 - t) + tbl[a1 + 1] * t,
        z: tbl[a0 + 2] * (1 - t) + tbl[a1 + 2] * t,
    };
}

// Distribute streamer launch points across the sunward hemisphere — a
// jittered fibonacci-style spiral on a half-sphere of radius `r`. Used
// to draw flux streamers with reasonable angular coverage without
// looking gridded.
function _streamerStartPoints(n, r) {
    const out = [];
    const phi = Math.PI * (3 - Math.sqrt(5));   // golden angle
    for (let i = 0; i < n; i++) {
        // Map i to [0..1] biased toward the sub-solar nose.
        const t = (i + 0.5) / n;
        const cosTheta = 1 - 0.55 * t;          // cap at ~56° from sun-axis
        const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
        const lon = i * phi;
        out.push({
            x: r * sinTheta * Math.cos(lon),
            y: r * cosTheta,                    // +Y == sunward in solar group
            z: r * sinTheta * Math.sin(lon),
        });
    }
    return out;
}

// Build the tooltip HTML for a hovered scene object. Picks the right
// data block (atmospheric ρ, solar-wind plasma state, satellite altitude,
// …) for the hovered kind so the tooltip is genuinely informative
// instead of just labelling the surface.
function _tipHTML(userData, profile, swState) {
    const colour = userData.color || '#0cc';

    let detail = '';
    let dataLines = '';
    switch (userData.kind) {
        case 'satellite':
            detail = `${userData.altKm} km · satellite shell`;
            if (profile?.samples?.length) {
                const rho = _nearestRho(profile.samples, userData.altKm);
                dataLines = `<div style="color:#889">ρ ≈ ${rho.toExponential(2)} kg/m³</div>`;
            }
            break;
        case 'layer-shell':
            detail = `${userData.minKm}–${userData.maxKm} km · atmospheric layer`;
            if (profile?.samples?.length) {
                const rho = _nearestRho(profile.samples, userData.altKm);
                dataLines = `<div style="color:#889">ρ ≈ ${rho.toExponential(2)} kg/m³ @ ${userData.peakKm} km</div>`;
            }
            break;
        case 'magnetopause':
            detail = `r₀ ≈ ${userData.r0?.toFixed(1) ?? '—'} R⊕ · α = ${userData.alpha?.toFixed(2) ?? '—'}`;
            if (swState) {
                const pdyn = (1.67e-6 * swState.density * swState.speed * swState.speed).toFixed(2);
                dataLines = `
                    <div style="color:#889">Pdyn ≈ ${pdyn} nPa · Bz ${swState.bz >= 0 ? '+' : ''}${swState.bz.toFixed(1)} nT</div>
                    <div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            } else {
                dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            }
            break;
        case 'bow-shock':
            detail = `r₀ ≈ ${userData.r0?.toFixed(1) ?? '—'} R⊕ · α = ${userData.alpha?.toFixed(2) ?? '—'}`;
            if (swState) {
                dataLines = `
                    <div style="color:#889">v_sw ${swState.speed.toFixed(0)} km/s · n ${swState.density.toFixed(1)}/cm³</div>
                    <div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            } else {
                dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            }
            break;
        case 'magnetosheath':
            detail = `compressed solar-wind plasma`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            break;
        case 'flux-stream':
            detail = `incoming plasma flow`;
            if (swState) {
                const pdyn = (1.67e-6 * swState.density * swState.speed * swState.speed).toFixed(2);
                dataLines = `
                    <div style="color:#889">v ${swState.speed.toFixed(0)} km/s · n ${swState.density.toFixed(1)}/cm³ · Pdyn ${pdyn} nPa</div>
                    <div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            } else {
                dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            }
            break;
        case 'sun-marker':
        case 'sun-stream':
            detail = `solar emission source`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            break;
        case 'iss-probe':
        case 'sat-probe': {
            // Live satellite probe. Drag pressure q = ½ρv² uses the
            // *current* probe altitude (so eccentric-orbit apogee/
            // perigee swings show up) and the circular orbital speed
            // at that altitude: v = √(μ/(R+h)).
            const incl = userData.spec?.orbital?.inclinationDeg;
            const period = userData.spec?.orbital?.periodMin;
            detail = `${userData.altKm.toFixed(0)} km`
                + (incl ? ` · ${incl}°` : '')
                + (period ? ` · ${period.toFixed(1)} min` : '')
                + ` · click to fly here`;
            if (profile?.samples?.length) {
                const rho = _nearestRho(profile.samples, userData.altKm);
                const v = _circularOrbitalSpeedKmS(userData.altKm) * 1000;   // m/s
                const q = 0.5 * rho * v * v;                                  // Pa
                dataLines = `
                    <div style="color:#9cf">ρ = ${rho.toExponential(2)} kg/m³ · v ≈ ${(v / 1000).toFixed(2)} km/s</div>
                    <div style="color:#0fc">drag q ≈ ${(q * 1000).toFixed(2)} mPa</div>
                    <div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            } else {
                dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            }
            break;
        }
        case 'sat-orbit-path':
            detail = `${userData.altKm} km · orbital track`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`;
            break;
        case 'debris-piece': {
            // Per-piece debris readout. Live ρ at the piece's altitude
            // + drag pressure q = ½ρv² at the circular orbital speed.
            const incl = userData.inclinationDeg;
            const period = userData.periodMin;
            const norad = userData.noradId;
            detail = `${userData.altKm} km · debris`
                + (incl  ? ` · ${incl.toFixed(1)}°` : '')
                + (period ? ` · ${period.toFixed(1)} min` : '')
                + ` · click to fly here`;
            const lines = [];
            if (norad) lines.push(`<div style="color:#9ab">NORAD ${norad}</div>`);
            if (profile?.samples?.length) {
                const rho = _nearestRho(profile.samples, userData.altKm);
                const v = _circularOrbitalSpeedKmS(userData.altKm) * 1000;
                const q = 0.5 * rho * v * v;
                lines.push(
                    `<div style="color:#9cf">ρ = ${rho.toExponential(2)} kg/m³ · v ≈ ${(v / 1000).toFixed(2)} km/s</div>`,
                    `<div style="color:#0fc">drag q ≈ ${(q * 1000).toFixed(2)} mPa</div>`,
                );
            }
            lines.push(`<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip}</div>`);
            dataLines = lines.join('');
            break;
        }
        case 'magnetic-cascade-line': {
            const L = userData.L?.toFixed(1) ?? '—';
            const labelColor = userData.color || '#9cf';
            detail = `L = ${L} · <span style="color:${labelColor}">${userData.label || ''}</span>`;
            dataLines = `
                <div style="color:#9ab;font-size:10px;margin-top:2px">${userData.population || ''}</div>
                <div style="color:#666;font-size:10px;margin-top:1px">family: ${userData.family || ''}</div>`;
            break;
        }
        case 'auroral-oval': {
            detail = `${userData.band === 'equatorward' ? 'Equatorward' : 'Poleward'} edge · ${userData.hemisphere} · ~${userData.altKm} km`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip || ''}</div>`;
            break;
        }
        case 'polar-cusp': {
            detail = `Polar cusp · ${userData.hemisphere} · ~${userData.altKm} km`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip || ''}</div>`;
            break;
        }
        case 'mlt-marker': {
            detail = `MLT ${userData.mlt.toString().padStart(2, '0')} · ${userData.label}`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip || ''}</div>`;
            break;
        }
        case 'fac-region-1':
        case 'fac-region-2': {
            const region = userData.region;
            detail = `Region ${region} Birkeland · ${userData.hemisphere} · ~${userData.altKm} km`;
            dataLines = `<div style="color:#666;font-size:10px;margin-top:2px">${userData.tooltip || ''}</div>`;
            break;
        }
        default:
            detail = userData.altKm != null ? `${userData.altKm} km` : '';
    }
    return `
        <div style="color:${colour};font-weight:600">${userData.name || userData.id}</div>
        <div>${detail}</div>
        ${dataLines}
    `;
}
