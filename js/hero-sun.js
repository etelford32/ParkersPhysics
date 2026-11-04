/**
 * hero-sun.js — the homepage hero's LIVE SUN: the star the corridor's CME
 * flux ropes leave, drawn with what it is doing today.
 * ═══════════════════════════════════════════════════════════════════════════
 * Replaces the corridor's plain limb-darkened ball (hero-rope-layer.js) with:
 *
 *   · PHOTOSPHERE — granulation (Worley cells + a mesogranular octave + the
 *     supergranular network), a per-channel limb-darkening law (the limb
 *     reddens because blue darkens faster), and every NOAA region on the disc
 *     at its reported position carried forward by differential rotation: a
 *     sunspot BIPOLE laid along Joy's law (leading spot west + equatorward,
 *     bigger; umbra with umbral dots, filamented penumbra, pores along the
 *     PIL of a γ/δ region), inside a facular plage that brightens toward the
 *     limb as real faculae do. A flare on the bus lights two ribbons either
 *     side of its region's PIL. FILAMENTS are dark threads along their spines
 *     (the H-alpha look) — the same structures that stand up bright as
 *     prominences at the limb (one record, two looks; see PROMINENCES).
 *   · LOOPS — each region's nested bipole arcade (hero-sun-model
 *     `regionLoops`) as thin additive tubes with siphon-flow pulses running
 *     foot to foot; their brightness is the region's `activityHeat`, and a
 *     flare lights the arcade up (the post-flare loops). They are
 *     depth-tested against the photosphere, so an arcade rotating over the
 *     W limb stands up in profile and then sets.
 *   · PROMINENCES (2026-11) — cool material drawn as bundles of hairy
 *     strands standing on each filament spine: HEK's filament/prominence
 *     detections when the feed is live (`/api/hek/filaments`, the feed
 *     sun.html already uses — OBSERVED, never derived, because a potential
 *     field holds no prominence material), else the per-region PIL filament
 *     as the analytic fallback. Bright off the limb, faded in front of the
 *     disc (where the photosphere draws the SAME spine dark), carried by
 *     differential rotation like the regions. Height ×PROM_HEIGHT_SCALE,
 *     disclosed.
 *   · FLARE FLOW (2026-11) — what a flare RELEASES, as particles on the pure
 *     js/hero-sun-flow.js kernel: evaporation filling the post-flare arcade
 *     (field-aligned by construction), coronal rain draining it, and a
 *     class-scaled fraction of EJECTA escaping along the radial swept by a
 *     DIVERGENCE-FREE curl-noise eddy field (Bridson 2007). Display speeds,
 *     class-scaled rates; a schematic of the eruption's phases, and the
 *     legend says so. The CME itself stays the flux-rope kernel's.
 *   · EUV WAVES (2026-11) — each located flare launches a circular front
 *     over the disc at hero-sun-model `WAVE_SPEED_KMS`, fading with age.
 *   · CORONA — one FrontSide shell evaluated on the view ray's IMPACT
 *     PARAMETER b (closed-form column ~ b^−2.6 with an outer e-fold), never
 *     `pow(rim, n)` on a back face (identically 1 there — the orrery's S3
 *     scar). Structure: a low-latitude streamer belt, radial rays from noise
 *     on the sky-plane DIRECTION only (so they are radial by construction),
 *     and a bright fan over every region (hotter while it flares), weighted
 *     by how near the limb it sits in the sky plane. A spicule-fringed
 *     chromospheric rim at b ≈ 1. Brightens with the live GOES X-ray level.
 *   · FLASHES / LIFTOFFS — sprites at flare sites (bus flares with a
 *     location, carried to τ) and at each engine rope's source site around
 *     its launch (the Stage's `liftoffAt` envelope), so a CME is seen
 *     leaving the place it left from.
 *
 * Frame: `root` carries the FLUX-ROPE frame (x = Sun→Earth, y = west,
 * z = north — hero-sun-model.js header) mapped into the hero scene by the
 * rope layer's `heroBasis`, scaled to the drawn radius. Region geometry is
 * built once at each region's anchor longitude and TURNED about +z by its
 * own latitude's rate — a 30° region lags the equator, as it should.
 *
 * Colour: every raw shader ends in `heroRadiance` (the photosphere — an HDR
 * emitter in linear light) or `heroEmit` (the additive layers); built-in
 * sprites are converted by the hero's per-frame sweep (js/hero-color.js).
 * A BACKTICK inside any GLSL below terminates the template literal — keep
 * comments in the shaders backtick-free (the orrery scar).
 *
 * HYPERBOLE, ON PURPOSE AND DISCLOSED: the owner asked for the features
 * accentuated. Every factor that exaggerates lives in `HYPERBOLE` below and
 * is printed in the scrubber legend (hero-rope-layer.js `outlookLegend`).
 * The physics underneath — positions, rotation, class ordering, the phases
 * of an eruption, the incompressible eddy field — is not what is scaled.
 *
 * Pure halves: js/hero-sun-model.js (`node tests/hero-sun-model.mjs`) and
 * js/hero-sun-flow.js (`node tests/hero-sun-flow.mjs`).
 */

import { HERO_COLOR_GLSL } from './hero-color.js';
import {
    MAX_REGIONS, MAX_FILAMENTS, PROM_HEIGHT_SCALE, helioUnit, tangentAt, regionAt, regionTurnRad,
    bipoleAxisAt, bipoleSize, activityHeat, regionLoops, flareSites, flareFlash, flareWave,
    stonyhurstDriftDegPerDay, prominenceSpine, regionProminences, prominenceAt, WAVE_WIDTH_RAD,
} from './hero-sun-model.js';
import {
    createFlowState, setSites, stepFlow, packFlow, flowCounts, KIND as FLOW_KIND, makeRng,
} from './hero-sun-flow.js';
import { liftoffAt } from './stage/model.js';

const DEG = Math.PI / 180;
const DAY = 86400e3;

/** Corona shell radius, in drawn solar radii. The glow must fade out well
 *  inside it — the geometry's silhouette must never be the visible edge. */
export const CORONA_SHELL_R = 3.6;
/** Loop tube radius, in drawn solar radii (≈1.4 px at a 150 px Sun). */
export const LOOP_TUBE_R = 0.011;
/** Prominence strand radius, drawn solar radii. */
export const PROM_TUBE_R = 0.008;
/** Strands per prominence spine. */
export const PROM_STRANDS = 7;
/** Photosphere disc-centre level in linear light: well under the tone
 *  curve's knee, because the bloom (threshold 0.214 linear) adds its own
 *  glow ON TOP of the disc — at 0.86 the pair washed the disc to a flat
 *  peach and the granulation and spots vanished (measured, first render). */
export const PHOTOSPHERE_LEVEL = 0.40;
/** Drawn umbra size relative to the model's `bipoleSize` — a disclosed
 *  legibility factor (a real 500 MSH umbra is ~3 px on a 150 px Sun). */
export const SPOT_SCALE = 1.55;
/** Particle pool for the flare flow (all sites together). */
export const FLOW_POOL = 2400;
/** Most simultaneous EUV wave fronts the corona shader carries. */
export const MAX_WAVES = 4;
/**
 * THE DISCLOSED EXAGGERATIONS (see the header). Each is a plain factor on a
 * drawn quantity, never on a physical one: prominence HEIGHT, loop GLOW,
 * flare RIBBON light, and the flow's PARTICLE SIZE. The flow's own speeds
 * are display speeds by construction (hero-sun-flow.js header).
 */
export const HYPERBOLE = Object.freeze({
    prominenceHeight: PROM_HEIGHT_SCALE,
    loopGlow: 1.6,
    flareRibbon: 1.5,
    flowSprite: 2.0,
});

const PHOTO_VS = /* glsl */`
    varying vec3 vPos; varying vec3 vN; varying vec3 vV;
    void main(){
        vPos = position;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

const NOISE_GLSL = /* glsl */`
    float hash3(vec3 p){
        p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 x){
        vec3 i = floor(x); vec3 f = fract(x);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash3(i), hash3(i + vec3(1.0, 0.0, 0.0)), f.x),
                       mix(hash3(i + vec3(0.0, 1.0, 0.0)), hash3(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
                   mix(mix(hash3(i + vec3(0.0, 0.0, 1.0)), hash3(i + vec3(1.0, 0.0, 1.0)), f.x),
                       mix(hash3(i + vec3(0.0, 1.0, 1.0)), hash3(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
    }
    float fbm(vec3 p){
        float a = 0.5, s = 0.0;
        for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 1.7; a *= 0.5; }
        return s;
    }`;

const PHOTO_FS = /* glsl */`
    precision highp float;
    ${HERO_COLOR_GLSL}
    #define MAXR ${MAX_REGIONS}
    #define MAXF ${MAX_FILAMENTS}
    const float SPOT_SCALE = ${SPOT_SCALE.toFixed(3)};
    const float RIBBON_GAIN = ${HYPERBOLE.flareRibbon.toFixed(3)};
    uniform float u_time;
    uniform float u_level;
    uniform int   u_n;
    uniform vec4  u_reg[MAXR];   // xyz centre (unit, root frame), w half-separation (rad)
    uniform vec4  u_ax[MAXR];    // xyz bipole axis following to leading, w umbra radius (rad)
    uniform vec4  u_act[MAXR];   // x heat, y flare flash, z complex
    uniform int   u_nf;
    uniform vec4  u_fil[MAXF];   // xyz spine centre (unit), w half-length (rad)
    uniform vec4  u_filD[MAXF];  // xyz spine direction (unit tangent), w thread width (rad)
    varying vec3 vPos; varying vec3 vN; varying vec3 vV;
    ${NOISE_GLSL}
    // Worley F1/F2 on a jittered lattice: bright granules, dark lanes.
    vec2 worley(vec3 p){
        vec3 i = floor(p); vec3 f = fract(p);
        float d1 = 8.0, d2 = 8.0;
        for (int z = -1; z <= 1; z++)
        for (int y = -1; y <= 1; y++)
        for (int x = -1; x <= 1; x++) {
            vec3 g = vec3(float(x), float(y), float(z));
            vec3 o = vec3(hash3(i + g), hash3(i + g + 19.1), hash3(i + g + 47.7));
            vec3 r = g + o - f;
            float d = dot(r, r);
            if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
        }
        return vec2(sqrt(d1), sqrt(d2));
    }
    // One sunspot: umbra + filamented penumbra. Returns the intensity factor.
    float spotI(vec3 p, vec3 s, float r, vec3 ax, vec3 side, inout float umbraW){
        float d = length(p - s);
        if (d > r * 2.6) return 1.0;
        float ang = atan(dot(p - s, side), dot(p - s, ax));
        float fil = 0.78 + 0.22 * sin(ang * 34.0 + 5.0 * vnoise(p * 140.0));
        float pen = 1.0 - smoothstep(r * 1.9, r * 2.45, d);
        float um  = 1.0 - smoothstep(r * 0.80, r * 1.05, d);
        umbraW = max(umbraW, um);
        // Umbral dots: the bright points convection pushes up through the umbra.
        float dots = 0.10 + 0.10 * smoothstep(0.66, 0.86, vnoise(p * 620.0 + 3.0));
        return mix(mix(1.0, 0.50 * fil, pen), dots, um);
    }
    void main(){
        vec3 p = normalize(vPos);
        float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);

        // Granulation + a mesogranular octave + the supergranular network,
        // contrast foreshortened to the limb.
        vec2 w = worley(p * 48.0 + vec3(0.0, 0.0, u_time * 0.035));
        float gran = smoothstep(0.02, 0.34, w.y - w.x);
        float meso = fbm(p * 23.0 - vec3(u_time * 0.02, 0.0, 0.0));
        float net = fbm(p * 9.0 + 3.1);
        float tex = 0.76 + 0.34 * gran + 0.10 * (meso - 0.5) + 0.12 * (net - 0.5);
        tex = mix(1.0, tex, 0.25 + 0.75 * mu);

        float I = 1.0, umbraW = 0.0, fac = 0.0, rib = 0.0;
        for (int i = 0; i < MAXR; i++) {
            if (i >= u_n) break;
            vec3 c = u_reg[i].xyz; float hs = u_reg[i].w;
            float dc = length(p - c);
            if (dc > hs * 3.4) continue;
            vec3 ax = u_ax[i].xyz; float ru = u_ax[i].w;
            vec3 side = normalize(cross(c, ax));             // along the PIL
            float heat = u_act[i].x, flash = u_act[i].y, cx = u_act[i].z;
            // The bipole: leading spot west + bigger, following spot trailing.
            I *= spotI(p, normalize(c + ax * hs * 0.85), ru * SPOT_SCALE, ax, side, umbraW);
            I *= spotI(p, normalize(c - ax * hs * 1.05), ru * SPOT_SCALE * 0.74, ax, side, umbraW);
            // A gamma/delta region: pores and small spots crowd the PIL.
            float e = dot(p - c, ax), a = dot(p - c, side);
            float band = exp(-pow(e / (hs * 0.35), 2.0) - pow(a / (hs * 0.9), 2.0));
            I *= 1.0 - cx * 0.55 * band * smoothstep(0.58, 0.78, vnoise(p * 240.0));
            // Plage: patchy faculae over the whole region.
            float plage = smoothstep(0.42, 0.78, fbm(p * 64.0 + float(i) * 7.3));
            fac += plage * (1.0 - smoothstep(hs * 1.3, hs * 2.9, dc)) * (0.45 + 0.55 * heat);
            // White-light flare ribbons either side of the PIL.
            if (flash > 0.001) {
                float r1 = exp(-pow((e - 0.26 * hs) / (0.07 * hs), 2.0)) + exp(-pow((e + 0.26 * hs) / (0.07 * hs), 2.0));
                rib += flash * r1 * exp(-pow(a / (0.75 * hs), 2.0));
            }
        }
        // Faculae are a limb phenomenon: nearly invisible at disc centre.
        I *= 1.0 + min(fac, 1.2) * (0.05 + 0.42 * (1.0 - mu));
        // Filaments: dark threads along their spines (the H-alpha look). The
        // same spine stands up bright at the limb as a prominence strand.
        float filD = 0.0;
        for (int i = 0; i < MAXF; i++) {
            if (i >= u_nf) break;
            vec3 fc = u_fil[i].xyz; float hl = u_fil[i].w;
            vec3 fd = u_filD[i].xyz; float fw = u_filD[i].w;
            float along = atan(dot(p, fd), dot(p, fc));
            if (abs(along) > hl + fw * 3.0) continue;
            vec3 q = normalize(fc * cos(along) + fd * sin(along));
            float across = length(p - q);
            float env = exp(-pow(across / fw, 2.0)) * (1.0 - smoothstep(hl * 0.85, hl + fw, abs(along)));
            float thread = 0.55 + 0.45 * vnoise(p * 180.0 + float(i) * 3.0);
            filD = max(filD, env * thread);
        }
        I *= 1.0 - 0.34 * filD;

        float lm = 1.0 - mu;
        vec3 limb = vec3(1.0) - vec3(0.42, 0.58, 0.76) * lm - vec3(0.18, 0.20, 0.16) * lm * lm;
        vec3 base = heroDecode(vec3(1.0, 0.82, 0.52));
        vec3 umbraTint = mix(vec3(1.0), vec3(1.0, 0.72, 0.52), umbraW);
        vec3 col = base * limb * tex * I * umbraTint * u_level;
        col += vec3(1.0, 0.96, 0.9) * rib * 2.2 * RIBBON_GAIN;   // HDR: ribbons bloom
        gl_FragColor = heroRadiance(col);
    }`;

const LOOP_VS = /* glsl */`
    attribute float aU;
    attribute float aSeed;
    varying float vU; varying float vSeed; varying vec3 vN; varying vec3 vV;
    void main(){
        vU = aU; vSeed = aSeed;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

const LOOP_FS = /* glsl */`
    precision highp float;
    ${HERO_COLOR_GLSL}
    const float LOOP_GAIN = ${HYPERBOLE.loopGlow.toFixed(3)};
    uniform float u_time; uniform float u_heat; uniform float u_flash; uniform float u_xray; uniform float u_vis;
    varying float vU; varying float vSeed; varying vec3 vN; varying vec3 vV;
    void main(){
        // Soft round tube: brightest where the line of sight grazes the most plasma.
        float edge = pow(clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 1.1);
        // Siphon flows: brightness knots running foot to foot.
        float flow = 0.5 + 0.5 * sin(6.2831 * (vU * 1.6 - u_time * 0.11 + vSeed * 7.0));
        float feet = smoothstep(0.0, 0.07, vU) * smoothstep(1.0, 0.93, vU);
        float hot = clamp(u_heat + 0.5 * u_flash + 0.3 * u_xray, 0.0, 1.0);
        vec3 col = mix(vec3(1.0, 0.52, 0.16), vec3(1.0, 0.82, 0.50), hot);
        float a = (0.30 + 0.70 * flow) * feet * edge * (0.20 + 0.50 * u_heat) * (1.0 + 2.4 * u_flash) * u_vis * LOOP_GAIN;
        gl_FragColor = heroEmit(col, a);
    }`;

const CORONA_VS = /* glsl */`
    varying vec3 vW;
    void main(){
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

const CORONA_FS = /* glsl */`
    precision highp float;
    ${HERO_COLOR_GLSL}
    #define MAXR ${MAX_REGIONS}
    #define MAXW ${MAX_WAVES}
    const float WAVE_W = ${WAVE_WIDTH_RAD.toFixed(4)};
    uniform mat4  u_w2l;          // world to root frame (unit = one drawn solar radius)
    uniform float u_time; uniform float u_xray; uniform float u_vis;
    uniform int   u_n;
    uniform vec4  u_reg[MAXR];    // xyz centre (unit), w heat (+ flash)
    uniform int   u_nw;
    uniform vec4  u_wave[MAXW];   // xyz flare site (unit), w front radius (rad)
    uniform float u_waveS[MAXW];  // front strength
    varying vec3 vW;
    ${NOISE_GLSL}
    void main(){
        vec3 ro = (u_w2l * vec4(cameraPosition, 1.0)).xyz;
        vec3 pw = (u_w2l * vec4(vW, 1.0)).xyz;
        vec3 rd = normalize(pw - ro);
        vec3 P  = ro - rd * dot(ro, rd);                 // closest approach to the Sun's centre
        float b = length(P);                             // impact parameter, in solar radii
        vec3 s  = P / max(b, 1e-4);                      // sky-plane direction of this ray
        // K-corona column (closed form, n ~ r^-3.2) with an outer e-fold.
        float column = pow(max(b, 1.0), -2.2) * exp(-max(b - 1.0, 0.0) / 2.2);
        // Structure lives on the DIRECTION only, so every feature is radial:
        // a helmet-streamer belt at low latitude, fainter polar-hole plumes,
        // and fine streaks from noise at two angular scales.
        float belt  = mix(0.30, 1.0, exp(-pow(s.z / 0.42, 2.0)));
        float drift = u_time * 0.004;
        float rays  = 0.45 + 0.55 * vnoise(s * 9.0 + drift) + 0.55 * pow(vnoise(s * 31.0 - drift), 2.0);
        float ar = 0.0;
        for (int i = 0; i < MAXR; i++) {
            if (i >= u_n) break;
            vec3 c = u_reg[i].xyz;
            vec3 cs = c - rd * dot(c, rd);               // the region, projected on the sky
            float lim = length(cs);                      // 1 on the limb, 0 at disc centre
            if (lim < 1e-3) continue;
            float fan = pow(max(dot(s, cs / lim), 0.0), 40.0);
            ar += u_reg[i].w * fan * lim * lim;
        }
        float glow = column * (belt * rays + 0.9 * ar * rays) * (0.7 + 0.8 * u_xray);
        // Over the disc the photosphere outshines it — let it through only as a veil.
        glow *= mix(0.12, 1.0, smoothstep(0.985, 1.03, b));
        // EUV wave fronts: where this ray meets the disc, a ring expanding
        // from each flaring site (hero-sun-model flareWave sets radius + fade).
        float wave = 0.0;
        if (b < 1.0 && u_nw > 0) {
            float tq = -dot(ro, rd) - sqrt(max(0.0, 1.0 - b * b));
            vec3 hit = normalize(ro + rd * tq);
            for (int i = 0; i < MAXW; i++) {
                if (i >= u_nw) break;
                float ang = acos(clamp(dot(hit, u_wave[i].xyz), -1.0, 1.0));
                float R = u_wave[i].w;
                float front = exp(-pow((ang - R) / WAVE_W, 2.0));
                float grain = 0.7 + 0.5 * vnoise(hit * 40.0 + u_time * 0.2);
                wave += u_waveS[i] * front * grain;
            }
        }
        // Chromospheric rim, fringed with spicules (fine radial structure).
        float spic = 0.6 + 0.8 * pow(vnoise(s * 170.0 + vec3(0.0, 0.0, u_time * 0.35)), 2.0);
        float chrom = exp(-max(b - 1.0, 0.0) / (0.014 + 0.012 * spic)) * smoothstep(0.995, 1.004, b) * spic;
        vec3 col = vec3(1.0, 0.86, 0.66) * glow * 0.55 + vec3(1.0, 0.36, 0.42) * chrom * 0.6
                 + vec3(0.80, 0.96, 1.0) * wave * 0.9;
        gl_FragColor = heroEmit(col, u_vis);
    }`;

const PROM_VS = /* glsl */`
    attribute float aU;
    attribute float aSeed;
    varying float vU; varying float vSeed; varying vec3 vN; varying vec3 vV; varying vec3 vW;
    void main(){
        vU = aU; vSeed = aSeed;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
    }`;

// A prominence strand: cool (chromospheric) material held up in the corona,
// drawn as it looks in He II 304 / H-alpha emission — hairy, with
// counter-streaming knots running along the spine. In FRONT of the disc the
// emitter is faded (the photosphere draws the same spine as a dark thread);
// behind the limb the depth test hides it.
const PROM_FS = /* glsl */`
    precision highp float;
    ${HERO_COLOR_GLSL}
    uniform mat4  u_w2l;
    uniform float u_time; uniform float u_vis; uniform float u_heat;
    varying float vU; varying float vSeed; varying vec3 vN; varying vec3 vV; varying vec3 vW;
    ${NOISE_GLSL}
    void main(){
        float edge = pow(clamp(abs(dot(normalize(vN), normalize(vV))), 0.0, 1.0), 0.5);
        float hair = 0.45 + 0.55 * vnoise(vec3(vU * 38.0 + vSeed * 50.0, vSeed * 9.0, u_time * 0.22));
        float dirn = vSeed > 0.5 ? 1.0 : -1.0;
        float stream = 0.55 + 0.45 * sin(6.2831 * (vU * 3.0 - dirn * u_time * 0.07 + vSeed * 5.0));
        float feet = smoothstep(0.0, 0.06, vU) * smoothstep(1.0, 0.94, vU);
        vec3 ro = (u_w2l * vec4(cameraPosition, 1.0)).xyz;
        vec3 pw = (u_w2l * vec4(vW, 1.0)).xyz;
        vec3 rd = normalize(pw - ro);
        vec3 P  = ro - rd * dot(ro, rd);
        float b = length(P);
        float limb = smoothstep(0.985, 1.035, b);
        vec3 col = mix(vec3(1.0, 0.34, 0.30), vec3(1.0, 0.66, 0.52), hair);
        float a = feet * edge * hair * stream * (0.30 + 0.70 * limb) * (0.75 + 0.5 * u_heat) * u_vis;
        gl_FragColor = heroEmit(col, a);
    }`;

// Flare flow particles (hero-sun-flow.js): points sized by their true
// projection, two populations by colour — loop plasma (white-gold cooling
// to orange as it rains) and ejecta (reddening as it leaves).
const PART_VS = /* glsl */`
    attribute float aKind;
    attribute float aAge;
    uniform float u_halfH;      // drawing-buffer half height, px
    uniform float u_scale;      // root scale (drawn solar radius, world units)
    uniform float u_sprite;     // HYPERBOLE.flowSprite
    varying float vKind; varying float vAge;
    void main(){
        vKind = aKind; vAge = aAge;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float sizeRoot = (aKind > 0.5 ? 0.040 : 0.022) * (1.0 - 0.40 * aAge) * u_sprite;
        float px = sizeRoot * u_scale * projectionMatrix[1][1] * u_halfH / max(0.05, -mv.z);
        gl_PointSize = clamp(px, 1.0, 16.0) * step(aAge, 0.999);
        gl_Position = projectionMatrix * mv;
    }`;
const PART_FS = /* glsl */`
    precision highp float;
    ${HERO_COLOR_GLSL}
    uniform float u_vis;
    varying float vKind; varying float vAge;
    void main(){
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float disc = exp(-d * d * 3.2) * (1.0 - smoothstep(0.72, 1.0, d));
        vec3 loopC = mix(vec3(1.0, 0.96, 0.82), vec3(1.0, 0.60, 0.24), vAge);
        vec3 ejC   = mix(vec3(1.0, 0.86, 0.62), vec3(1.0, 0.28, 0.20), vAge);
        vec3 col = mix(loopC, ejC, vKind);
        float a = disc * (1.0 - vAge * vAge) * mix(1.0, 0.95, vKind) * u_vis;
        gl_FragColor = heroEmit(col, a);
    }`;

/** A tube mesh's arrays for a set of polylines (unit-sphere coords × apex). */
export function loopTubeArrays(loops, radius = LOOP_TUBE_R, radial = 5) {
    let nv = 0, ni = 0;
    for (const l of loops) { nv += l.pts.length * radial; ni += (l.pts.length - 1) * radial * 6; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3);
    const aU = new Float32Array(nv), aSeed = new Float32Array(nv);
    const idx = new (nv > 65535 ? Uint32Array : Uint16Array)(ni);
    let v = 0, k = 0;
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const unit = (a) => { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; };
    loops.forEach((l, li) => {
        const pts = l.pts, n = pts.length;
        const mid = pts[Math.floor(n / 2)];
        // The loop is near-planar: one binormal for the whole arc.
        const B = unit(cross(sub(pts[n - 1], pts[0]), mid));
        const seed = ((li * 0.618034) % 1);
        const base = v;
        for (let i = 0; i < n; i++) {
            const T = unit(sub(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]));
            const N = unit(cross(B, T));
            for (let j = 0; j < radial; j++) {
                const th = (j / radial) * Math.PI * 2;
                const c = Math.cos(th), s = Math.sin(th);
                const d = [N[0] * c + B[0] * s, N[1] * c + B[1] * s, N[2] * c + B[2] * s];
                pos[v * 3] = pts[i][0] + d[0] * radius; pos[v * 3 + 1] = pts[i][1] + d[1] * radius; pos[v * 3 + 2] = pts[i][2] + d[2] * radius;
                nor[v * 3] = d[0]; nor[v * 3 + 1] = d[1]; nor[v * 3 + 2] = d[2];
                aU[v] = i / (n - 1); aSeed[v] = seed;
                v++;
            }
        }
        for (let i = 0; i < n - 1; i++) {
            for (let j = 0; j < radial; j++) {
                const a = base + i * radial + j, b = base + i * radial + ((j + 1) % radial);
                const c = a + radial, d = b + radial;
                idx[k++] = a; idx[k++] = c; idx[k++] = b;
                idx[k++] = b; idx[k++] = c; idx[k++] = d;
            }
        }
    });
    return { pos, nor, aU, aSeed, idx };
}

/**
 * Strands for one prominence spine (unit vectors on the Sun, hero-sun-model
 * `prominenceSpine`): `PROM_STRANDS` hairy arcs standing on the spine, each
 * lifted by a flat-topped profile to ~`heightRad` with seeded jitter across
 * the spine and in height, feet on the photosphere. Polylines in root units.
 */
export function prominenceStrands(spine, heightRad, seed = 1, strands = PROM_STRANDS) {
    const rng = makeRng(seed);
    const n = spine.length;
    const out = [];
    const unit = (a) => { const m = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / m, a[1] / m, a[2] / m]; };
    for (let j = 0; j < strands; j++) {
        const hScale = 0.7 + 0.5 * rng();
        const lateral = (rng() - 0.5) * 0.6 * heightRad;
        const phase = rng() * 6.283;
        const pts = [];
        for (let i = 0; i < n; i++) {
            const u = i / (n - 1);
            const p = spine[i];
            const T = unit([0, 1, 2].map((k) => spine[Math.min(n - 1, i + 1)][k] - spine[Math.max(0, i - 1)][k]));
            const B = unit([p[1] * T[2] - p[2] * T[1], p[2] * T[0] - p[0] * T[2], p[0] * T[1] - p[1] * T[0]]);
            const off = lateral * (0.6 + 0.4 * Math.sin(phase + u * 7.0));
            const lift = heightRad * hScale * Math.pow(Math.sin(Math.PI * u), 0.55) * (0.9 + 0.2 * Math.sin(phase * 2 + u * 11.0));
            const q = unit([p[0] + B[0] * off, p[1] + B[1] * off, p[2] + B[2] * off]);
            pts.push([q[0] * (1 + lift), q[1] * (1 + lift), q[2] * (1 + lift)]);
        }
        out.push({ pts });
    }
    return out;
}

/**
 * @param {object} o
 * @param {object} o.THREE
 * @param {object} o.parent     Object3D positioned at the drawn Sun's centre (the rope layer's sunGroup)
 * @param {{e1:number[],e2:number[],e3:number[]}} o.basis  flux-rope frame → hero world (heroBasis)
 * @param {number} o.radius     drawn solar radius, hero units
 */
export function createHeroSun({ THREE, parent, basis, radius }) {
    const root = new THREE.Group();
    root.name = 'hero-live-sun';
    const m = new THREE.Matrix4().makeBasis(
        new THREE.Vector3(...basis.e1), new THREE.Vector3(...basis.e2), new THREE.Vector3(...basis.e3));
    root.quaternion.setFromRotationMatrix(m);
    root.scale.setScalar(radius);
    parent.add(root);

    const regU = Array.from({ length: MAX_REGIONS }, () => new THREE.Vector4());
    const axU = Array.from({ length: MAX_REGIONS }, () => new THREE.Vector4());
    const actU = Array.from({ length: MAX_REGIONS }, () => new THREE.Vector4());
    const corU = Array.from({ length: MAX_REGIONS }, () => new THREE.Vector4());

    const filU = Array.from({ length: MAX_FILAMENTS }, () => new THREE.Vector4());
    const filDU = Array.from({ length: MAX_FILAMENTS }, () => new THREE.Vector4());
    const waveU = Array.from({ length: MAX_WAVES }, () => new THREE.Vector4());
    const waveS = new Float32Array(MAX_WAVES);

    const photoMat = new THREE.ShaderMaterial({
        uniforms: {
            u_time: { value: 0 }, u_level: { value: PHOTOSPHERE_LEVEL }, u_n: { value: 0 },
            u_reg: { value: regU }, u_ax: { value: axU }, u_act: { value: actU },
            u_nf: { value: 0 }, u_fil: { value: filU }, u_filD: { value: filDU },
        },
        vertexShader: PHOTO_VS, fragmentShader: PHOTO_FS, fog: false,
    });
    const photosphere = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), photoMat);
    photosphere.name = 'hero-sun-photosphere';
    root.add(photosphere);

    const w2l = new THREE.Matrix4();
    const coronaMat = new THREE.ShaderMaterial({
        uniforms: {
            u_w2l: { value: w2l }, u_time: { value: 0 }, u_xray: { value: 0 }, u_vis: { value: 1 },
            u_n: { value: 0 }, u_reg: { value: corU },
            u_nw: { value: 0 }, u_wave: { value: waveU }, u_waveS: { value: waveS },
        },
        vertexShader: CORONA_VS, fragmentShader: CORONA_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide, fog: false,
    });
    const corona = new THREE.Mesh(new THREE.SphereGeometry(CORONA_SHELL_R, 64, 40), coronaMat);
    corona.name = 'hero-sun-corona';
    corona.renderOrder = 5;
    root.add(corona);

    // ── Prominences: one group per spine (turned by its own latitude's rate) ──
    const promMat = new THREE.ShaderMaterial({
        uniforms: { u_w2l: { value: w2l }, u_time: { value: 0 }, u_vis: { value: 1 }, u_heat: { value: 0.3 } },
        vertexShader: PROM_VS, fragmentShader: PROM_FS,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    });
    let promSlots = [];      // { p, group, mesh }
    let promSource = 'none'; // 'hek' | 'region' | 'none'

    // ── Flare flow: the particle pool on the pure kernel ──
    const flow = createFlowState(FLOW_POOL, 7);
    const packed = packFlow(flow);
    const partGeo = new THREE.BufferGeometry();
    const partPos = new THREE.BufferAttribute(packed.pos, 3);
    const partKind = new THREE.BufferAttribute(packed.kind, 1);
    const partAge = new THREE.BufferAttribute(packed.age, 1);
    partPos.setUsage(THREE.DynamicDrawUsage); partKind.setUsage(THREE.DynamicDrawUsage); partAge.setUsage(THREE.DynamicDrawUsage);
    partGeo.setAttribute('position', partPos);
    partGeo.setAttribute('aKind', partKind);
    partGeo.setAttribute('aAge', partAge);
    const partMat = new THREE.ShaderMaterial({
        uniforms: {
            u_halfH: { value: 450 }, u_scale: { value: radius }, u_sprite: { value: HYPERBOLE.flowSprite }, u_vis: { value: 1 },
        },
        vertexShader: PART_VS, fragmentShader: PART_FS,
        transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending, fog: false,
    });
    const particles = new THREE.Points(partGeo, partMat);
    particles.name = 'hero-sun-flare-flow';
    particles.renderOrder = 7;
    particles.frustumCulled = false;
    particles.visible = false;
    root.add(particles);
    let flowSites = [];      // what update() last handed the kernel
    let lastWall = NaN;

    const dotTex = (() => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 64;
        const g = cv.getContext('2d');
        const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,240,210,0.6)');
        gr.addColorStop(0.6, 'rgba(255,190,120,0.14)'); gr.addColorStop(1, 'rgba(255,160,80,0)');
        g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
        const t = new THREE.CanvasTexture(cv);
        t.colorSpace = THREE.SRGBColorSpace;
        return t;
    })();
    const makeSprite = (color) => {
        const s = new THREE.Sprite(new THREE.SpriteMaterial({
            map: dotTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
        }));
        s.visible = false; s.renderOrder = 8;
        root.add(s);
        return s;
    };
    const flashSprites = Array.from({ length: 4 }, () => makeSprite(0xffffff));
    const liftSprites = Array.from({ length: 6 }, () => [makeSprite(0xffe2b0), makeSprite(0xffc78a)]);

    let regions = [];
    let slots = [];          // { reg, group, mesh, mat, heat }
    let sites = [];          // flare sites on the bus
    let prominences = [];    // hero-sun-model records (observed or the region fallback)
    let observedProms = null;// the HEK list when the feed answered, else null
    let liftoffs = [];       // { launchMs, latDeg, lonDeg }
    let xray = 0;
    let tauMs = Date.now();
    let visible = 1;
    let live = true;         // false: a replay of another date — no TODAY on this Sun

    function disposeSlots() {
        for (const s of slots) { root.remove(s.group); s.mesh.geometry.dispose(); s.mat.dispose(); }
        slots = [];
    }

    /** Regions from hero-sun-model `latestRegions`. Rebuilds the loop meshes. */
    function setRegions(list) {
        disposeSlots();
        regions = (list ?? []).slice(0, MAX_REGIONS);
        for (const reg of regions) {
            const { pos, nor, aU, aSeed, idx } = loopTubeArrays(regionLoops(reg, { n: 13 }));
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
            g.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
            g.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
            g.setIndex(new THREE.BufferAttribute(idx, 1));
            const heat = activityHeat(reg);
            const mat = new THREE.ShaderMaterial({
                uniforms: {
                    u_time: { value: 0 }, u_heat: { value: heat }, u_flash: { value: 0 },
                    u_xray: { value: xray }, u_vis: { value: 1 },
                },
                vertexShader: LOOP_VS, fragmentShader: LOOP_FS,
                transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
            });
            const mesh = new THREE.Mesh(g, mat);
            mesh.renderOrder = 6;
            const group = new THREE.Group();
            group.add(mesh);
            root.add(group);
            slots.push({ reg, group, mesh, mat, heat });
        }
        if (!observedProms) applyProminences(regionProminences(regions), regions.length ? 'region' : 'none');
        update(tauMs, true);
    }

    function disposeProms() {
        for (const sl of promSlots) { root.remove(sl.group); sl.mesh.geometry.dispose(); }
        promSlots = [];
    }

    /** Build the strand meshes for a prominence list (model records). */
    function applyProminences(list, source) {
        disposeProms();
        prominences = (list ?? []).slice(0, MAX_FILAMENTS);
        promSource = prominences.length ? source : 'none';
        prominences.forEach((pr, i) => {
            const spine = prominenceSpine(pr.latDeg, pr.lonDeg, pr.tiltDeg, pr.halfLenRad, 14);
            let seed = 11;
            for (const ch of String(pr.id)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
            const { pos, nor, aU, aSeed, idx } = loopTubeArrays(prominenceStrands(spine, pr.heightRad, seed), PROM_TUBE_R, 4);
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
            g.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
            g.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
            g.setIndex(new THREE.BufferAttribute(idx, 1));
            const mesh = new THREE.Mesh(g, promMat);
            mesh.renderOrder = 6;
            const group = new THREE.Group();
            group.name = `hero-sun-prominence-${i}`;
            group.add(mesh);
            root.add(group);
            promSlots.push({ p: pr, group, mesh });
        });
    }

    /**
     * Observed prominences / filaments (hero-sun-model `hekProminences`
     * records). `null` means the feed did not answer: fall back to the
     * per-region PIL filaments (sun.html's own fallback rule).
     */
    function setProminences(list) {
        observedProms = Array.isArray(list) ? list : null;
        if (observedProms) applyProminences(observedProms, 'hek');
        else applyProminences(regionProminences(regions), regions.length ? 'region' : 'none');
        update(tauMs, true);
    }

    /** The live bus state (js/swpc-feed.js): X-ray level + located flares. */
    function setBus(state) {
        if (!state) return;
        const x = state.derived?.xray_intensity;
        xray = Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : xray;
        sites = flareSites(state.flares ?? state.recent_flares ?? []);
    }

    /** Engine rope launches: [{ launchMs, latDeg, lonDeg }]. */
    function setLiftoffs(list) { liftoffs = (list ?? []).slice(0, liftSprites.length); }

    const tmpV = new THREE.Vector3();
    const place = (sprite, latDeg, lonDeg, r, scale, opacity) => {
        const u = helioUnit(latDeg, lonDeg);
        sprite.position.set(u[0] * r, u[1] * r, u[2] * r);
        sprite.scale.setScalar(scale);
        sprite.material.opacity = opacity;
        sprite.visible = opacity > 0.01;
    };

    /** Place everything at instant τ (epoch ms). */
    function update(t, force = false) {
        if (!Number.isFinite(t)) return;
        if (!force && t === tauMs) return;
        tauMs = t;
        let n = 0;
        for (const s of slots) {
            s.group.visible = live;
            if (!live) continue;
            const at = regionAt(s.reg, tauMs);
            s.group.rotation.set(0, 0, regionTurnRad(s.reg, tauMs));
            const c = helioUnit(at.latDeg, at.lonDeg);
            const ax = bipoleAxisAt(at.latDeg, at.lonDeg);
            const { halfSepRad, umbraRad } = bipoleSize(s.reg.area);
            // Flash from any located flare within 10° of this region.
            let flash = 0;
            for (const f of sites) {
                const drift = stonyhurstDriftDegPerDay(f.latDeg) * (tauMs - f.timeMs) / DAY;
                const fc = helioUnit(f.latDeg, f.lonDeg + drift);
                if (c[0] * fc[0] + c[1] * fc[1] + c[2] * fc[2] > Math.cos(10 * DEG)) flash = Math.max(flash, flareFlash(f, tauMs));
            }
            s.mat.uniforms.u_flash.value = flash;
            s.mat.uniforms.u_xray.value = xray;
            regU[n].set(c[0], c[1], c[2], halfSepRad);
            axU[n].set(ax[0], ax[1], ax[2], umbraRad);
            actU[n].set(s.heat, flash, s.reg.complex ? 1 : 0, 0);
            corU[n].set(c[0], c[1], c[2], Math.min(1.5, s.heat + 0.8 * flash));
            n++;
        }
        photoMat.uniforms.u_n.value = n;
        coronaMat.uniforms.u_n.value = n;
        coronaMat.uniforms.u_xray.value = live ? xray : 0;

        // Prominences: turned by their own latitude's rate; the same spine is
        // a dark thread on the disc (photosphere uniforms, at τ).
        let nf = 0;
        for (const sl of promSlots) {
            sl.group.visible = live;
            if (!live) continue;
            const at = prominenceAt(sl.p, tauMs);
            sl.group.rotation.set(0, 0, stonyhurstDriftDegPerDay(sl.p.latDeg) * ((tauMs - sl.p.anchorMs) / DAY) * DEG);
            if (nf >= MAX_FILAMENTS) continue;
            const c = helioUnit(at.latDeg, at.lonDeg);
            const { west, north } = tangentAt(at.latDeg, at.lonDeg);
            const g = sl.p.tiltDeg * DEG;
            const d = [0, 1, 2].map((i) => west[i] * Math.cos(g) + north[i] * Math.sin(g));
            filU[nf].set(c[0], c[1], c[2], sl.p.halfLenRad);
            filDU[nf].set(d[0], d[1], d[2], 0.010 + 0.06 * sl.p.halfLenRad);
            nf++;
        }
        photoMat.uniforms.u_nf.value = nf;
        promMat.uniforms.u_heat.value = live ? Math.min(1, 0.3 + xray) : 0;

        // EUV waves + the flow's emitting sites, from the located flares at τ.
        let nw = 0;
        const fs = [];
        for (const f of live ? sites : []) {
            const drift = stonyhurstDriftDegPerDay(f.latDeg) * (tauMs - f.timeMs) / DAY;
            const lon = f.lonDeg + drift;
            const c = helioUnit(f.latDeg, lon);
            const w = flareWave(f, tauMs);
            if (w && nw < MAX_WAVES) { waveU[nw].set(c[0], c[1], c[2], w.radiusRad); waveS[nw] = w.strength; nw++; }
            const fl = flareFlash(f, tauMs);
            if (fl > 0.001) {
                const ax = bipoleAxisAt(f.latDeg, lon);
                const side = [c[1] * ax[2] - c[2] * ax[1], c[2] * ax[0] - c[0] * ax[2], c[0] * ax[1] - c[1] * ax[0]];
                // The arcade size: the flaring region's, if a numbered one sits within 10°.
                let area = 250;
                for (const s of slots) {
                    const rc = helioUnit(regionAt(s.reg, tauMs).latDeg, regionAt(s.reg, tauMs).lonDeg);
                    if (c[0] * rc[0] + c[1] * rc[1] + c[2] * rc[2] > Math.cos(10 * DEG)) { area = Math.max(area, s.reg.area); break; }
                }
                fs.push({ id: `${f.timeMs}`, c, ax, side, hs: bipoleSize(area).halfSepRad, letter: f.letter, flash: fl });
            }
        }
        coronaMat.uniforms.u_nw.value = nw;
        flowSites = fs;
        setSites(flow, fs);

        // Flare flashes at their own sites (a flare need not sit in a numbered region).
        flashSprites.forEach((sp, i) => {
            const f = live ? sites[i] : null;
            if (!f) { sp.visible = false; return; }
            const fl = flareFlash(f, tauMs);
            const drift = stonyhurstDriftDegPerDay(f.latDeg) * (tauMs - f.timeMs) / DAY;
            const lon = f.lonDeg + drift;
            const facing = Math.cos(f.latDeg * DEG) * Math.cos(lon * DEG) > -0.15;
            // Smaller than it was: the ribbons, the lit arcade, the wave and the
            // flow carry the flare now; the sprite is only the impulsive glint.
            place(sp, f.latDeg, lon, 1.02, 0.16 + 0.34 * fl, facing ? 0.7 * fl : 0);
        });
        // CME liftoffs: a plume at the rope's source site around its launch.
        liftSprites.forEach(([a, b], i) => {
            const L = liftoffs[i];
            const lo = L ? liftoffAt(L.launchMs, tauMs) : 0;
            if (!lo) { a.visible = false; b.visible = false; return; }
            place(a, L.latDeg, L.lonDeg, 1.06, 0.5 + 0.7 * lo, 0.9 * lo);
            place(b, L.latDeg, L.lonDeg, 1.28 + 0.25 * (1 - lo), 0.8 + 1.0 * lo, 0.55 * lo);
        });
    }

    /**
     * Per frame: shader clocks, the world→root matrix the corona and the
     * prominences march in, and the flare flow stepped on WALL time
     * (`halfHPx`: the drawing buffer's half height, for true point sizes).
     */
    function tick(wallT, halfHPx = NaN) {
        photoMat.uniforms.u_time.value = wallT;
        coronaMat.uniforms.u_time.value = wallT;
        promMat.uniforms.u_time.value = wallT;
        for (const s of slots) s.mat.uniforms.u_time.value = wallT;
        root.updateWorldMatrix(true, false);
        w2l.copy(root.matrixWorld).invert();
        if (Number.isFinite(halfHPx) && halfHPx > 0) partMat.uniforms.u_halfH.value = halfHPx;
        const dt = Number.isFinite(lastWall) ? Math.max(0, Math.min(0.1, wallT - lastWall)) : 0;
        lastWall = wallT;
        const active = live && visible > 0.02 && (flow.count > 0 || flowSites.length > 0);
        if (active && dt > 0) {
            stepFlow(flow, dt);
            packFlow(flow, packed);
            partPos.needsUpdate = true; partKind.needsUpdate = true; partAge.needsUpdate = true;
        }
        particles.visible = active && flow.count > 0;
    }

    /**
     * true: this is TODAY's Sun (regions, X-ray, flares from the live feeds).
     * false: the drawing is a replay of another date (the Gannon transit) —
     * the Sun keeps its photosphere and a quiet corona, and wears none of
     * today's activity.
     */
    function setLive(v) {
        if (live === !!v) return;
        live = !!v;
        update(tauMs, true);
    }

    /** 0..1: how much of the Sun's additive dressing shows (the photosphere is opaque). */
    function setVisibility(v) {
        visible = Math.max(0, Math.min(1, v));
        coronaMat.uniforms.u_vis.value = visible;
        promMat.uniforms.u_vis.value = visible;
        partMat.uniforms.u_vis.value = visible;
        for (const s of slots) s.mat.uniforms.u_vis.value = visible;
    }

    return {
        root, photosphere, corona, particles,
        setRegions, setBus, setLiftoffs, setLive, setProminences, update, tick, setVisibility,
        get state() {
            const fc = flowCounts(flow);
            return {
                regions: live ? regions.length : 0,
                earthFacing: !live ? 0 : regions.filter((r) => regionAt(r, tauMs).earthFacing).length,
                flares: sites.length,
                flashing: flashSprites.filter((s) => s.visible).length,
                liftoffs: liftSprites.filter(([a]) => a.visible).length,
                prominences: live ? prominences.length : 0,
                promSource: live ? promSource : 'none',
                promEarthFacing: !live ? 0 : prominences.filter((p) => prominenceAt(p, tauMs).earthFacing).length,
                waves: coronaMat.uniforms.u_nw.value,
                flow: { sites: flowSites.length, loop: fc.loop, ejecta: fc.ejecta, drawn: particles.visible },
                hyperbole: HYPERBOLE,
                xray, tauMs, visible, live,
            };
        },
        dispose() {
            disposeSlots(); disposeProms();
            parent.remove(root);
            photosphere.geometry.dispose(); photoMat.dispose();
            corona.geometry.dispose(); coronaMat.dispose();
            promMat.dispose(); partGeo.dispose(); partMat.dispose();
            for (const s of [...flashSprites, ...liftSprites.flat()]) s.material.dispose();
            dotTex.dispose();
        },
    };
}
