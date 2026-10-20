/**
 * star-collider/scene.js — the collider's three.js stage and its camera rig
 * ═══════════════════════════════════════════════════════════════════════════
 * Draws what the SPH kernel computes and nothing else: one Points cloud
 * (position, log-density, thermal energy and a star/unbound flag per
 * particle, straight from the worker's packed frame), the two bodies'
 * cores, their trails, the line between them, optional black-hole spheres,
 * a scale ring and the orbital-plane grid. Before a run it previews the
 * configured pair as wire spheres at the configured separation so the
 * camera has the system to look at, not an empty grid. No physics here.
 *
 * FRAME. The kernel's orbital plane is x–y with the angular momentum along
 * +z. The stage is Y-UP, so kernel (x, y, z) → scene (x, z, −y): a ROTATION
 * (det +1), not the y↔z swap, which would mirror the orbital sense. Every
 * drawn thing lives in `world`, a group the COROTATING frame turns about +y
 * by the angle of the core–core line, so the two stars sit still on the
 * x-axis and the tides, the bar and the ejecta move around them — the
 * frame every merger paper plots in.
 *
 * THE CAMERA HAS ONE RULE (the TIGA rule): the page may START a flight, it
 * may not HOLD the camera. Presets and frame-to-fit are one-shot tweens of
 * the spherical coordinates about the target that any drag, wheel, pinch or
 * key cancels. FOLLOW is not a hold: each frame the target moves to the
 * followed point (system barycentre, core A or core B) and the camera is
 * translated by exactly the same vector, so the user's own orbit angle and
 * zoom are untouched — it is the rig that moves, never the camera's pose
 * relative to it. The translation is exact every frame: an eased version
 * trailed a core by 75° of orbit on a 3 fps software rasteriser (measured),
 * and a density-weighted centroid of hundreds of particles has no jitter
 * worth smoothing.
 *
 * `camera.up` never changes (Y-up throughout), so OrbitControls is built
 * once and never rebuilt — the Mars/Moon/Stage orbit-axis scar cannot occur
 * here. Presets steer through OrbitControls' own spherical state (the
 * camera is positioned about `controls.target`), so a preset and a user
 * drag are the same kind of motion and cannot fight.
 *
 * SCALE. `setScale(codePerScene, ringR)` maps kernel length units to scene
 * units so a 20-km neutron star and a 6000-km white dwarf both fill the
 * stage; page.js prints the ring's radius in km on the stage so the
 * compression is disclosed where it is seen.
 *
 * COLOUR MODES (the analysis views): density (log₁₀ρ over the top three
 * decades below the frame maximum, cold→hot, shock heat pushing toward
 * orange), heat (the thermal energy u alone — where the shocks are),
 * body (star A cyan, star B magenta — mixing at contact), bound (bound
 * material dim, unbound ejecta bright green — the kernel's own Bernoulli
 * flag, the same definition as the M_unbound readout).
 *
 * THE SPLAT (2026-10 HD pass). An SPH particle is not a dot: it is mass
 * smeared over its smoothing kernel W(r, h). Each particle is therefore drawn
 * as K sub-sprites (an InstancedBufferGeometry: K child vertices × one
 * instance per particle) whose offsets are STRATIFIED SAMPLES of the cubic
 * spline's radial mass distribution q²W(q), turned by a per-particle random
 * rotation (seeded by the particle's kernel index, so the pattern is stable
 * from frame to frame and never a lattice). h itself is not in the frame; it
 * is recovered the way the kernel sets it, h ∝ (m/ρ)^{1/3}, i.e.
 * h = h̄·10^{(log ρ̄ − log ρ)/3} with ρ̄ the mean density the page sized h̄ at —
 * so ejecta and tidal tails swell exactly as the particles' own kernels do.
 * Sprite size is the TRUE projected size (projectionMatrix × drawing-buffer
 * height), so surface brightness is zoom-invariant; below the pixel floor the
 * sprite's weight falls as (px/floor)² instead of inflating the light.
 * Colours are sRGB picks DECODED to linear before they are added (additive
 * blending is a sum of light, and a sum of display values is the khaki trap
 * the orrery's tone pass documents), accumulated in a half-float target when
 * the HDR path is on, then bloomed and Reinhard-tone-mapped by an OutputPass.
 * The DETAIL ladder (`setDetail`): 'standard' = 4 children, no post (the
 * direct path — and the AUTO choice on a software rasteriser, where a bloom
 * chain costs whole frames); 'high' = 10 children + HDR + bloom (auto on a
 * GPU); 'ultra' = 20 children. Children are capped at CHILD_BUDGET in total.
 *
 * BEHAVIOUR (`setInteractions`): the worker runs interactions.js on the
 * kernel's raw state and ships, per KERNEL index, the velocity, the kernel's
 * real h, ∇·v, A–B mixing and the viscous heating rate, plus the A–B kernel
 * pairs. Four colour modes read it (velocity relative to the barycentre,
 * compression, mixing, live shock heating — each normalised by an EASED
 * robust percentile so a single frame cannot flash the palette), the splats
 * switch to the real h, and three line layers draw it: FLOW STREAKS (each
 * particle's path over 4 % of an orbit; in the corotating frame the motion
 * relative to the rotating axes, Ω fitted from the gas itself), PATHLINE
 * TRACERS (≤ 240 particles, sampled every 1 % of an orbit of SIM time,
 * stored un-rotated by the corotating angle at record time so they draw as
 * corotating-frame paths) and A–B CONTACTS (gold = approaching, i.e. being
 * viscously heated; violet = overlapping). None of it feeds back.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const MAX_POINTS = 8192;
const MAX_TRAIL = 1500;
const TWEEN_S = 0.75;
const CHILD_BUDGET = 72000;          // sub-sprites in total, across every particle
const GAIN = { direct: 0.24, hdr: 0.34 };   // per-particle light, tuned on a 600-per-star GW170817 run
export const DETAIL_LEVELS = Object.freeze({
    // childSize is the sprite diameter in units of h: more children, finer grain.
    standard: { children: 4,  childSize: 0.95, hdr: false, bloom: 0,    label: 'standard · 4 sub-sprites, direct render' },
    high:     { children: 10, childSize: 0.70, hdr: true,  bloom: 0.32, label: 'high · 10 sub-sprites, HDR + bloom' },
    ultra:    { children: 20, childSize: 0.55, hdr: true,  bloom: 0.38, label: 'ultra · 20 sub-sprites, HDR + bloom' },
});

/** The cubic spline's radial mass distribution q²W(q) on [0, 2], as an inverse CDF. */
function kernelRadiusSampler() {
    const W = (q) => q < 1 ? 1 - 1.5 * q * q + 0.75 * q * q * q : q < 2 ? 0.25 * (2 - q) ** 3 : 0;
    const N = 512, cdf = new Float64Array(N + 1);
    for (let i = 1; i <= N; i++) { const q = 2 * (i - 0.5) / N; cdf[i] = cdf[i - 1] + q * q * W(q); }
    for (let i = 1; i <= N; i++) cdf[i] /= cdf[N];
    return (u) => {
        let lo = 0, hi = N;
        while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cdf[m] < u) lo = m; else hi = m; }
        const f = (u - cdf[lo]) / Math.max(cdf[hi] - cdf[lo], 1e-12);
        return 2 * (lo + f) / N;
    };
}
const sampleKernelRadius = kernelRadiusSampler();

/**
 * K child offsets in units of h: radii STRATIFIED in the kernel's mass CDF,
 * directions on a Fibonacci sphere (so a small K still covers the sphere),
 * plus a per-child brightness jitter — the granulation.
 */
export function kernelOffsets(K, seed = 97) {
    let s = seed >>> 0;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const pos = new Float32Array(K * 3), jit = new Float32Array(K);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const order = Array.from({ length: K }, (_, i) => i);
    for (let i = K - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    for (let i = 0; i < K; i++) {
        const q = sampleKernelRadius((i + rnd()) / K);
        const k = order[i];
        const y = 1 - 2 * (k + 0.5) / K, rr = Math.sqrt(Math.max(0, 1 - y * y)), th = golden * k;
        pos[3 * i] = q * rr * Math.cos(th); pos[3 * i + 1] = q * y; pos[3 * i + 2] = q * rr * Math.sin(th);
        jit[i] = 0.65 + 0.7 * rnd();
    }
    return { pos, jit };
}

export const VIEW_PRESETS = Object.freeze({
    top:     { polar: 0.04, azimuth: 0.0,  label: 'top (face-on)' },
    edge:    { polar: 1.545, azimuth: 0.35, label: 'edge-on' },
    oblique: { polar: 0.82, azimuth: 0.45, label: 'oblique' },
});
export const COLOR_MODES = Object.freeze({
    density: { id: 0, label: 'density (log₁₀ρ, top 3 decades) · shock heat → orange' },
    heat:    { id: 1, label: 'shock heating u (blue → white → red)' },
    body:    { id: 2, label: 'body membership · A cyan, B magenta' },
    bound:   { id: 3, label: 'gravitationally bound (dim) vs unbound ejecta (green)' },
    // The four below read the interaction diagnostics (interactions.js, the
    // kernel's own pair rules); until the first aux arrives they fall back
    // to density.
    velocity:    { id: 4, label: 'velocity vs the barycentre · infall blue, orbit white, outflow orange', aux: true },
    compression: { id: 5, label: '∇·v · compressing orange-red, expanding blue', aux: true },
    mixing:      { id: 6, label: 'interpenetration · own-star colour → gold where A and B gas share kernels', aux: true },
    shocking:    { id: 7, label: 'viscous heating RATE now · where shocks are working', aux: true },
});
export const FOLLOW_MODES = Object.freeze(['system', 'A', 'B', 'none']);

// NO BACKTICKS inside these GLSL literals — one terminates the template (the
// orrery's scar). Child vertex = `position` (offset in units of h) + aJit;
// instance attributes = the particle (iPos, iDens, iHeat, iFlag, iSeed).
const POINT_VS = /* glsl */`
    attribute float aJit;
    attribute vec3 iPos;
    attribute float iDens;
    attribute float iHeat;
    attribute float iFlag;
    attribute float iSeed;
    attribute vec3 iVel;          // kernel velocity, scene axes, code units
    attribute vec4 iAux;          // h (scene units), div v, mixing, viscous heating rate
    uniform float uHasAux;
    uniform vec3 uCm;             // barycentre (scene-local) and its velocity
    uniform vec3 uVcm;
    uniform float uVelScale;
    uniform float uDivScale;
    uniform float uShockScale;
    uniform float uSize;          // h at the reference (mean) density, scene units
    uniform float uPointScale;
    uniform float uDensMax;
    uniform float uDensSpan;
    uniform float uDensRef;       // log10(rho_max / rho_mean) the page sized uSize at
    uniform float uHeatScale;
    uniform float uViewportH;     // drawing-buffer height, px
    uniform float uSpread;        // child offset scale (units of h)
    uniform float uChildSize;     // sprite diameter (units of h)
    uniform float uGain;
    varying float vDens;
    varying float vHeat;
    varying float vFlag;
    varying float vW;
    varying float vCore;
    varying float vVr;
    varying float vSpd;
    varying float vDiv;
    varying float vMix;
    varying float vShock;
    vec3 hash3(float n) {
        return fract(sin(vec3(n * 0.1031 + 1.0, n * 0.1030 + 7.0, n * 0.0973 + 13.0) * vec3(127.1, 311.7, 74.7)) * 43758.5453);
    }
    vec3 rotq(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
    void main() {
        vDens = clamp((iDens - (uDensMax - uDensSpan)) / uDensSpan, 0.0, 1.0);
        vHeat = clamp(iHeat * uHeatScale, 0.0, 1.0);
        vFlag = iFlag;
        // h = h_mean * (rho_mean / rho)^(1/3): the kernel's own adaptive length.
        float hs = clamp(pow(10.0, (uDensMax - uDensRef - iDens) / 3.0), 0.6, 7.0);
        // Once the interaction diagnostics arrive, the kernel's OWN h replaces
        // the estimate (the frame carries no h; the aux channel does).
        if (uHasAux > 0.5 && iAux.x > 0.0) hs = clamp(iAux.x / uSize, 0.4, 9.0);
        float h = uSize * hs;
        vec3 vrel = iVel - uVcm;
        vec3 rdir = iPos - uCm;
        float rl = length(rdir);
        vSpd = length(vrel) * uVelScale;
        vVr = rl > 1e-6 ? dot(vrel, rdir / rl) * uVelScale : 0.0;
        vDiv = iAux.y * uDivScale;
        vMix = iAux.z;
        vShock = iAux.w * uShockScale;
        // Shoemake: a uniform random rotation per particle, stable across frames.
        vec3 u = hash3(iSeed);
        float s1 = sqrt(1.0 - u.x), s2 = sqrt(u.x);
        vec4 q = vec4(s1 * sin(6.2831853 * u.y), s1 * cos(6.2831853 * u.y), s2 * sin(6.2831853 * u.z), s2 * cos(6.2831853 * u.z));
        vec3 off = rotq(q, position) * h * uSpread;
        vCore = 1.0 - clamp(length(position) * 0.5, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(iPos + off, 1.0);
        float depth = max(-mv.z, 1e-3);
        float px = h * uChildSize * uPointScale * projectionMatrix[1][1] * 0.5 * uViewportH / depth;
        const float FLOOR_PX = 1.6;
        float dim = px < FLOOR_PX ? (px * px) / (FLOOR_PX * FLOOR_PX) : 1.0;
        gl_PointSize = clamp(px, FLOOR_PX, 384.0);
        // larger kernels spread the same light thinner (column density), gently
        vW = uGain * aJit * max(dim, 0.04) / sqrt(hs);
        gl_Position = projectionMatrix * mv;
    }
`;
const POINT_FS = /* glsl */`
    precision highp float;
    uniform int uMode;
    uniform float uHasAux;
    uniform float uLinear;        // 1 = decode sRGB picks to linear (HDR path)
    varying float vDens;
    varying float vHeat;
    varying float vFlag;
    varying float vW;
    varying float vCore;
    varying float vVr;
    varying float vSpd;
    varying float vDiv;
    varying float vMix;
    varying float vShock;
    vec3 ramp(float t) {
        vec3 c0 = vec3(0.10, 0.06, 0.42);
        vec3 c1 = vec3(0.06, 0.38, 1.00);
        vec3 c2 = vec3(0.30, 0.88, 1.00);
        vec3 c3 = vec3(1.00, 0.95, 0.85);
        if (t < 0.33) return mix(c0, c1, t / 0.33);
        if (t < 0.66) return mix(c1, c2, (t - 0.33) / 0.33);
        return mix(c2, c3, (t - 0.66) / 0.34);
    }
    vec3 heatRamp(float t) {
        vec3 c0 = vec3(0.10, 0.18, 0.55);
        vec3 c1 = vec3(0.92, 0.94, 1.00);
        vec3 c2 = vec3(1.00, 0.55, 0.15);
        vec3 c3 = vec3(1.00, 0.12, 0.10);
        if (t < 0.4) return mix(c0, c1, t / 0.4);
        if (t < 0.75) return mix(c1, c2, (t - 0.4) / 0.35);
        return mix(c2, c3, (t - 0.75) / 0.25);
    }
    void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        // Gaussian footprint renormalised to reach exactly 0 at the sprite edge
        float a = max(exp(-r2 * 14.0) - 0.0302, 0.0) * 1.0311;
        float body = mod(vFlag, 2.0);          // 0 = A, 1 = B
        float unbound = step(2.0, vFlag);      // 1 if ejecta
        vec3 col;
        float lum;
        // the interaction modes fall back to density until the first aux frame
        int mode = (uHasAux < 0.5 && uMode >= 4) ? 0 : uMode;
        if (mode == 1) {
            col = heatRamp(vHeat);
            lum = 0.25 + 0.75 * max(vHeat, 0.35 * vDens);
        } else if (mode == 2) {
            col = mix(vec3(0.30, 0.85, 1.00), vec3(0.95, 0.45, 1.00), body);
            lum = 0.22 + 0.78 * vDens;
        } else if (mode == 3) {
            col = mix(vec3(0.35, 0.42, 0.70), vec3(0.45, 1.00, 0.60), unbound);
            lum = mix(0.12 + 0.55 * vDens, 1.0, unbound);
        } else if (mode == 4) {
            // direction cosine of the motion relative to the barycentre:
            // -1 infall (blue), 0 orbital (white), +1 outflow (orange)
            float c = clamp(vVr / max(vSpd, 1e-4), -1.0, 1.0);
            vec3 tang = vec3(0.86, 0.90, 1.00);
            col = c < 0.0 ? mix(tang, vec3(0.20, 0.50, 1.00), -c) : mix(tang, vec3(1.00, 0.52, 0.16), c);
            lum = 0.10 + 0.90 * clamp(vSpd, 0.0, 1.2);
        } else if (mode == 5) {
            float dv = clamp(vDiv, -1.0, 1.0);
            col = dv < 0.0 ? mix(vec3(0.55, 0.60, 0.75), vec3(1.00, 0.36, 0.12), -dv) : mix(vec3(0.55, 0.60, 0.75), vec3(0.25, 0.55, 1.00), dv);
            lum = max(0.08 + 0.22 * vDens, pow(abs(dv), 0.7));
        } else if (mode == 6) {
            float m = clamp(vMix * 2.0, 0.0, 1.0);
            vec3 own = mix(vec3(0.30, 0.85, 1.00), vec3(0.95, 0.45, 1.00), body);
            col = mix(own, vec3(1.00, 0.86, 0.45), m);
            lum = 0.14 + 0.45 * vDens + 0.75 * m;
        } else if (mode == 7) {
            float sh = clamp(sqrt(max(vShock, 0.0)), 0.0, 1.0);
            col = heatRamp(0.25 + 0.75 * sh);
            lum = 0.05 + 0.10 * vDens + sh;
        } else {
            // the kernel's inner children run a touch hotter than its rim
            // gamma 2 on the ramp: the bulk of a star reads blue → cyan and only
            // the top of the density range (the cores) runs to white
            float t = clamp(vDens + 0.10 * (vCore - 0.5), 0.0, 1.0);
            col = ramp(t * t);
            col = mix(col, vec3(1.0, 0.72, 0.35), vHeat * 0.8);
            lum = 0.16 + 0.84 * vDens;
        }
        vec3 c = col * lum;
        if (uLinear > 0.5) c = pow(c, vec3(2.2));
        gl_FragColor = vec4(c, a * vW);
    }
`;

/** Backdrop stars: magnitude-distributed sizes, blackbody-ish tints. */
const SKY_VS = /* glsl */`
    attribute float aSize;
    attribute vec3 aColor;
    uniform float uDpr;
    varying vec3 vColor;
    void main() {
        vColor = aColor;
        gl_PointSize = aSize * uDpr;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const SKY_FS = /* glsl */`
    precision highp float;
    uniform float uLinear;
    varying vec3 vColor;
    void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        float a = exp(-r2 * 22.0);
        vec3 c = uLinear > 0.5 ? pow(vColor, vec3(2.2)) : vColor;
        gl_FragColor = vec4(c, a);
    }
`;

/** A star seen whole (the pre-run preview): a sphere of glowing gas, brighter
    through its centre (longer chord) with a rim glow — not a wire cage. */
const STAR_VS = /* glsl */`
    varying vec3 vN;
    varying vec3 vV;
    void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
    }
`;
const STAR_FS = /* glsl */`
    precision highp float;
    uniform vec3 uColor;
    uniform float uLinear;
    varying vec3 vN;
    varying vec3 vV;
    void main() {
        float mu = clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0);
        // chord through an n = 1 polytrope ~ mu^1.5, plus a thin limb glow
        float core = pow(mu, 1.5);
        float rim = pow(1.0 - mu, 4.0) * 0.6;
        vec3 c = uColor * (0.12 + 0.55 * core) + vec3(1.0, 0.98, 0.92) * pow(mu, 8.0) * 0.35 + uColor * rim;
        if (uLinear > 0.5) c = pow(c, vec3(2.2));
        gl_FragColor = vec4(c, 0.5 + 0.45 * core);
    }
`;

function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
const k2s = (v, cps) => new THREE.Vector3(v[0] / cps, v[2] / cps, -v[1] / cps);

/** A software rasteriser (SwiftShader / llvmpipe) pays whole frames for a bloom chain. */
function isSoftwareRenderer(renderer) {
    try {
        const gl = renderer.getContext();
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
        return /swiftshader|llvmpipe|software|basic render/i.test(name);
    } catch { return false; }
}

export function createColliderScene(container, { onFrame, onCommand, detail = 'auto' } = {}) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const CLEAR = new THREE.Color(0x04051a);
    // Into the composer's linear target three r160 encodes the clear colour
    // to sRGB on the way IN, and the OutputPass encodes it again on the way out
    // (measured: the sky read 34,38,90 instead of 4,5,26). Pre-decoding it once
    // more makes the round trip land on the same night sky as the direct path.
    const CLEAR_HDR = CLEAR.clone().convertSRGBToLinear();
    renderer.setClearColor(CLEAR, 1);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.setAttribute('tabindex', '0');
    renderer.domElement.setAttribute('aria-label', '3D merger stage — drag to orbit, wheel to zoom; keys 1/2/3 views, F frame, S/A/B follow, 4 corotating, C colour, T trails, V streaks, P pathlines, X contacts, R reset');
    renderer.domElement.style.outline = 'none';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 4000);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 9, 11);
    camera.lookAt(0, 0, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.6;
    controls.minDistance = 0.3;
    controls.maxDistance = 600;
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI - 0.02;
    controls.zoomToCursor = false;

    // ── Static backdrop ─────────────────────────────────────────────────────
    // A decorative sky (not a catalogue): sizes from a steep magnitude law so
    // most stars are faint pinpricks, tints from a cool-to-hot palette.
    const SKY_N = 3200;
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(SKY_N * 3), starSize = new Float32Array(SKY_N), starCol = new Float32Array(SKY_N * 3);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const tints = [[0.70, 0.80, 1.00], [0.85, 0.90, 1.00], [1.00, 0.98, 0.95], [1.00, 0.88, 0.72], [1.00, 0.76, 0.58]];
    for (let i = 0; i < SKY_N; i++) {
        const r = 900, th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
        starPos[3 * i] = r * Math.sin(ph) * Math.cos(th);
        starPos[3 * i + 1] = r * Math.cos(ph);
        starPos[3 * i + 2] = r * Math.sin(ph) * Math.sin(th);
        const m = Math.pow(rnd(), 3.2);                       // mostly faint
        starSize[i] = 1.0 + 2.6 * m;
        const t = tints[Math.min(tints.length - 1, Math.floor(rnd() * tints.length))];
        const b = 0.18 + 0.75 * m;
        starCol[3 * i] = t[0] * b; starCol[3 * i + 1] = t[1] * b; starCol[3 * i + 2] = t[2] * b;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    starGeo.setAttribute('aSize', new THREE.BufferAttribute(starSize, 1));
    starGeo.setAttribute('aColor', new THREE.BufferAttribute(starCol, 3));
    const skyMat = new THREE.ShaderMaterial({
        vertexShader: SKY_VS, fragmentShader: SKY_FS,
        uniforms: { uDpr: { value: renderer.getPixelRatio() }, uLinear: { value: 0 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const sky = new THREE.Points(starGeo, skyMat);
    sky.frustumCulled = false;
    scene.add(sky);

    // ── The world group: everything that lives in the kernel's frame ────────
    const world = new THREE.Group();
    scene.add(world);
    const grid = new THREE.GridHelper(40, 40, 0x1d2a55, 0x111a3a);
    grid.material.transparent = true; grid.material.opacity = 0.55;
    // Drawn BEFORE the additive gas and writing NO depth: a grid that wrote
    // depth culled the gas behind the orbital plane along every grid line and
    // cut dark stripes straight through the stars.
    grid.material.depthWrite = false;
    grid.renderOrder = -2;
    world.add(grid);
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.98, 4.02, 128),
        new THREE.MeshBasicMaterial({ color: 0x5ee1ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.renderOrder = -1;
    world.add(ring);

    // Particles: K child vertices (the kernel samples) × one instance per particle.
    const pos = new Float32Array(MAX_POINTS * 3);
    const dens = new Float32Array(MAX_POINTS);
    const heat = new Float32Array(MAX_POINTS);
    const flag = new Float32Array(MAX_POINTS);
    const seedA = new Float32Array(MAX_POINTS);
    const velA = new Float32Array(MAX_POINTS * 3);
    const auxA = new Float32Array(MAX_POINTS * 4);
    const inst = {
        iPos: new THREE.InstancedBufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage),
        iDens: new THREE.InstancedBufferAttribute(dens, 1).setUsage(THREE.DynamicDrawUsage),
        iHeat: new THREE.InstancedBufferAttribute(heat, 1).setUsage(THREE.DynamicDrawUsage),
        iFlag: new THREE.InstancedBufferAttribute(flag, 1).setUsage(THREE.DynamicDrawUsage),
        iSeed: new THREE.InstancedBufferAttribute(seedA, 1).setUsage(THREE.DynamicDrawUsage),
        iVel: new THREE.InstancedBufferAttribute(velA, 3).setUsage(THREE.DynamicDrawUsage),
        iAux: new THREE.InstancedBufferAttribute(auxA, 4).setUsage(THREE.DynamicDrawUsage),
    };
    function buildParticleGeometry(K) {
        const g = new THREE.InstancedBufferGeometry();
        const { pos: off, jit } = kernelOffsets(K);
        g.setAttribute('position', new THREE.BufferAttribute(off, 3));
        g.setAttribute('aJit', new THREE.BufferAttribute(jit, 1));
        for (const [k, a] of Object.entries(inst)) g.setAttribute(k, a);
        g.instanceCount = 0;
        return g;
    }
    let geo = buildParticleGeometry(DETAIL_LEVELS.standard.children);
    const mat = new THREE.ShaderMaterial({
        vertexShader: POINT_VS, fragmentShader: POINT_FS,
        uniforms: {
            uSize: { value: 0.12 }, uPointScale: { value: 1.0 }, uDensMax: { value: 0 }, uDensSpan: { value: 3 },
            uDensRef: { value: 0.5 }, uHeatScale: { value: 20 }, uMode: { value: 0 },
            uViewportH: { value: 720 }, uSpread: { value: 0.65 }, uChildSize: { value: 1.1 }, uGain: { value: 0.3 },
            uLinear: { value: 0 },
            uHasAux: { value: 0 }, uCm: { value: new THREE.Vector3() }, uVcm: { value: new THREE.Vector3() },
            uVelScale: { value: 1 }, uDivScale: { value: 1 }, uShockScale: { value: 1 },
        },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    world.add(points);

    // One shared uniform object: every sRGB-picked shader decodes to linear
    // exactly when the HDR path is on (and only then).
    const linearUniform = { value: 0 };
    mat.uniforms.uLinear = linearUniform;
    skyMat.uniforms.uLinear = linearUniform;
    /** The bright lensed ring just outside a hole's shadow (r_ph ≈ 1.5 r_s, seen at ~2.6 r_s). */
    function makePhotonGlow(r) {
        const m = new THREE.ShaderMaterial({
            vertexShader: STAR_VS,
            fragmentShader: /* glsl */`
                precision highp float;
                uniform float uLinear;
                varying vec3 vN;
                varying vec3 vV;
                void main() {
                    float mu = abs(dot(normalize(vN), normalize(vV)));
                    float ring = exp(-pow((mu - 0.18) / 0.10, 2.0));
                    vec3 c = vec3(1.0, 0.72, 0.42) * ring * 0.9;
                    if (uLinear > 0.5) c = pow(c, vec3(2.2)) * 1.6;
                    gl_FragColor = vec4(c, ring);
                }
            `,
            uniforms: { uLinear: linearUniform },
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
        });
        return new THREE.Mesh(new THREE.SphereGeometry(r * 2.6, 48, 32), m);
    }

    // Black holes
    const bhMeshes = [0, 1].map(() => {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), new THREE.MeshBasicMaterial({ color: 0x000000 })));
        const halo = new THREE.Mesh(new THREE.RingGeometry(1.35, 1.6, 96), new THREE.MeshBasicMaterial({ color: 0xffb066, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
        halo.rotation.x = -Math.PI / 2;
        g.add(halo);
        g.add(makePhotonGlow(1));
        g.visible = false;
        world.add(g);
        return g;
    });

    // Cores, separation line, trails (analysis overlays)
    const coreColors = [0x5ee1ff, 0xf08cff];
    const coreMarks = coreColors.map(c => {
        const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.0, 40), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
        m.rotation.x = -Math.PI / 2; m.visible = false; world.add(m); return m;
    });
    const sepGeo = new THREE.BufferGeometry();
    sepGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage));
    const sepLine = new THREE.Line(sepGeo, new THREE.LineDashedMaterial({ color: 0xffb066, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.7 }));
    sepLine.visible = false; world.add(sepLine);
    const trails = coreColors.map(c => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3).setUsage(THREE.DynamicDrawUsage));
        g.setDrawRange(0, 0);
        const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.55 }));
        l.frustumCulled = false; world.add(l);
        return { line: l, n: 0 };
    });
    const bary = new THREE.Mesh(new THREE.OctahedronGeometry(0.06), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
    bary.visible = false; world.add(bary);

    // ── Behaviour layers: flow streaks, pathline tracers, A–B contacts ──────
    // All three read the interaction channel (`setInteractions`): velocities
    // and pairs are the kernel's, positions the latest frame's. Lines are
    // additive and write no depth, like the gas they annotate.
    const LINE_VS = /* glsl */`
        attribute vec4 aCol;
        uniform float uLinear;
        varying vec4 vCol;
        void main() {
            vCol = aCol;
            if (uLinear > 0.5) vCol.rgb = pow(vCol.rgb, vec3(2.2));
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
    `;
    const LINE_FS = /* glsl */`
        precision highp float;
        varying vec4 vCol;
        void main() { gl_FragColor = vCol; }
    `;
    function makeLineLayer(maxVerts) {
        const g = new THREE.BufferGeometry();
        const p = new Float32Array(maxVerts * 3), c = new Float32Array(maxVerts * 4);
        g.setAttribute('position', new THREE.BufferAttribute(p, 3).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute('aCol', new THREE.BufferAttribute(c, 4).setUsage(THREE.DynamicDrawUsage));
        g.setDrawRange(0, 0);
        const m = new THREE.ShaderMaterial({ vertexShader: LINE_VS, fragmentShader: LINE_FS, uniforms: { uLinear: linearUniform },
            transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
        const l = new THREE.LineSegments(g, m);
        l.frustumCulled = false; l.visible = false;
        world.add(l);
        return { line: l, p, c, max: maxVerts };
    }
    const streaks = makeLineLayer(MAX_POINTS * 2);
    const TRACER_MAX = 240, TRACER_LEN = 48;
    const pathlines = makeLineLayer(TRACER_MAX * (TRACER_LEN - 1) * 2);
    const LINK_MAX = 3000;
    const contacts = makeLineLayer(LINK_MAX * 2);
    const BODY_RGB = [[0.30, 0.85, 1.00], [0.95, 0.45, 1.00]];
    const tracer = { ids: [], hist: null, head: 0, count: 0, lastT: -Infinity, body: [] };
    const ia = { aux: null, links: null, n: 0, summary: null, cm: [0, 0, 0], vcm: [0, 0, 0] };
    const scaleEma = { vel: 0, div: 0, shock: 0 };

    // Pre-run preview of the configured pair
    const preview = new THREE.Group();
    world.add(preview);

    // ── Post: HDR accumulation, bloom, ACES (the 'high' / 'ultra' rungs) ─────
    const software = isSoftwareRenderer(renderer);
    const canHdr = renderer.capabilities.isWebGL2;
    let composer = null, bloomPass = null;
    function ensureComposer() {
        if (composer || !canHdr) return composer;
        try {
            composer = new EffectComposer(renderer);
            composer.addPass(new RenderPass(scene, camera));
            bloomPass = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.32, 0.35, 0.85);
            composer.addPass(bloomPass);
            composer.addPass(new OutputPass());
        } catch (err) {
            console.warn('[star-collider] HDR path unavailable', err);
            composer = null;
        }
        return composer;
    }

    // ── State ───────────────────────────────────────────────────────────────
    const st = {
        codePerScene: 4, ringCode: 16,
        follow: 'system', corotating: false, colorMode: 'density', trailsOn: true, view: 'oblique',
        pointScale: 1,
        // last frame meta (kernel units)
        cmA: null, cmB: null, mA: 0, mB: 0, sep: 0, omega: 0, hasFrame: false, alive: 0,
        cloudRadius: 2.5,          // scene units, from the last frame
        rotAngle: 0, lastFrameT: 0,
        tween: null,
        followSnap: true,
        running: true, visible: true, hovering: false,
        detail: 'standard', hdr: false, children: DETAIL_LEVELS.standard.children,
        nBudget: 1200, h0: 0.12, gainBase: 0.3,
        streaksOn: true, pathlinesOn: true, contactsOn: true, streakTime: 0, tracerDt: 0,
    };
    function sizeComposer(w, h) {
        if (!composer) return;
        composer.setPixelRatio(renderer.getPixelRatio());
        composer.setSize(w, h);
    }

    function resize() {
        const w = container.clientWidth || 640, h = container.clientHeight || 400;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        mat.uniforms.uViewportH.value = h * renderer.getPixelRatio();
        sizeComposer(w, h);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    const io = new IntersectionObserver((entries) => { st.visible = entries.some(e => e.isIntersecting); }, { threshold: 0.02 });
    io.observe(container);
    const onVis = () => { st.running = !document.hidden; };
    document.addEventListener('visibilitychange', onVis);

    // Any user input on the controls cancels a flight (the rule).
    controls.addEventListener('start', () => { st.tween = null; });
    renderer.domElement.addEventListener('pointerenter', () => { st.hovering = true; });
    renderer.domElement.addEventListener('pointerleave', () => { st.hovering = false; });

    // ── Camera helpers ──────────────────────────────────────────────────────
    const sph = new THREE.Spherical();
    const tmpV = new THREE.Vector3();
    function currentSpherical() {
        tmpV.copy(camera.position).sub(controls.target);
        sph.setFromVector3(tmpV);
        return { r: sph.radius, polar: sph.phi, azimuth: sph.theta };
    }
    function applySpherical(r, polar, azimuth) {
        sph.set(r, Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, polar)), azimuth);
        tmpV.setFromSpherical(sph);
        camera.position.copy(controls.target).add(tmpV);
        camera.lookAt(controls.target);
    }
    function flyTo({ r, polar, azimuth }, seconds = TWEEN_S) {
        const from = currentSpherical();
        const to = { r: r ?? from.r, polar: polar ?? from.polar, azimuth: azimuth ?? from.azimuth };
        // shortest azimuth path
        let da = to.azimuth - from.azimuth;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        to.azimuth = from.azimuth + da;
        if (seconds <= 0) { applySpherical(to.r, to.polar, to.azimuth); st.tween = null; return; }
        st.tween = { from, to, t0: performance.now(), dur: seconds * 1000 };
    }
    function stepTween(now) {
        const tw = st.tween; if (!tw) return;
        const u = Math.min(1, (now - tw.t0) / tw.dur);
        const e = easeInOut(u);
        applySpherical(tw.from.r + (tw.to.r - tw.from.r) * e, tw.from.polar + (tw.to.polar - tw.from.polar) * e, tw.from.azimuth + (tw.to.azimuth - tw.from.azimuth) * e);
        if (u >= 1) st.tween = null;
    }
    /** Where the rig should sit, in WORLD coordinates (accounts for the corotating turn). */
    function followPointWorld() {
        let local = null;
        if (st.follow === 'none' || !st.hasFrame) return null;
        if (st.follow === 'A' && st.cmA) local = k2s(st.cmA, st.codePerScene);
        else if (st.follow === 'B' && st.cmB) local = k2s(st.cmB, st.codePerScene);
        else if (st.cmA && st.cmB) {
            const m = st.mA + st.mB || 1;
            local = k2s([(st.mA * st.cmA[0] + st.mB * st.cmB[0]) / m, (st.mA * st.cmA[1] + st.mB * st.cmB[1]) / m, (st.mA * st.cmA[2] + st.mB * st.cmB[2]) / m], st.codePerScene);
        }
        return local ? world.localToWorld(local) : null;
    }
    function stepFollow() {
        const target = followPointWorld();
        if (!target) return;
        // EXACT translation, every frame. An eased version (e-folding 0.18 s)
        // was tried first and measured in headless software GL at ~3 fps: the
        // rig trailed a following core by 75° of orbit, because each rare
        // frame closed only part of a gap the star kept re-opening. The
        // followed point is a mass-density-weighted centroid of hundreds of
        // particles, so there is no jitter worth smoothing.
        const delta = target.sub(controls.target);
        st.followSnap = false;
        controls.target.add(delta);
        camera.position.add(delta);
    }
    function distanceToFit(radiusScene) {
        const vFov = camera.fov * Math.PI / 180;
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        const half = Math.min(vFov, hFov) / 2;
        return Math.max(radiusScene, 0.05) / Math.sin(half) * 1.12;
    }

    // ── Behaviour helpers ───────────────────────────────────────────────────
    /** Per-instance velocity + aux, read by KERNEL index from the held channel. */
    function fillAuxInstances(cnt, stride, frame) {
        const cps = st.codePerScene, a = ia.aux, as = ia.stride || 7;
        let k = 0;
        for (let i = 0; i < cnt; i++) {
            if (!Number.isFinite(frame[stride * i])) continue;
            if (a && i < ia.n) {
                const o = as * i;
                velA[3 * k] = a[o] / cps; velA[3 * k + 1] = a[o + 2] / cps; velA[3 * k + 2] = -a[o + 1] / cps;
                auxA[4 * k] = a[o + 3] / cps; auxA[4 * k + 1] = a[o + 4]; auxA[4 * k + 2] = a[o + 5]; auxA[4 * k + 3] = a[o + 6];
            } else {
                velA[3 * k] = velA[3 * k + 1] = velA[3 * k + 2] = 0;
                auxA[4 * k] = 0; auxA[4 * k + 1] = 0; auxA[4 * k + 2] = 0; auxA[4 * k + 3] = 0;
            }
            k++;
        }
        const v = ia.vcm;
        mat.uniforms.uVcm.value.set(v[0] / cps, v[2] / cps, -v[1] / cps);
        if (st.cmA && st.cmB) {
            const m = st.mA + st.mB || 1;
            mat.uniforms.uCm.value.copy(k2s([(st.mA * st.cmA[0] + st.mB * st.cmB[0]) / m, (st.mA * st.cmA[1] + st.mB * st.cmB[1]) / m, (st.mA * st.cmA[2] + st.mB * st.cmB[2]) / m], cps));
        }
    }
    function resetTracers() {
        tracer.ids = []; tracer.hist = null; tracer.head = 0; tracer.count = 0; tracer.lastT = -Infinity;
        pathlines.line.geometry.setDrawRange(0, 0); pathlines.line.visible = false;
    }
    /** Rotate scene-local (x, z) by −θ about +y: the inverse of world.rotation.y = θ. */
    function unrotate(x, y, z, th) {
        if (!th) return [x, y, z];
        const c = Math.cos(th), s = Math.sin(th);
        return [x * c - z * s, y, x * s + z * c];
    }
    function updateBehaviour(frame, cnt, stride, meta) {
        const cps = st.codePerScene;
        const a = ia.aux, as = ia.stride || 7;
        const omega = meta && Number.isFinite(meta.omega) && Math.abs(meta.omega) > 1e-9 ? Math.abs(meta.omega) : 0;
        const period = omega > 0 ? 2 * Math.PI / omega : 0;
        // ── flow streaks: the path each particle covers in streakTime (4 % of an
        //    orbit, so an orbiting star draws arcs a quarter of its radius long)
        if (st.streaksOn && a && period > 0) {
            st.streakTime = 0.04 * period;
            const vc = ia.vcm;
            // In the corotating frame a streak must be the motion RELATIVE to
            // the rotating axes, or two stars held still on the x-axis would
            // still draw orbital arcs. The rate is FITTED from the gas itself
            // (rigid-rotation least squares about the barycentre, kernel
            // axes), so its sign can never disagree with what is drawn.
            let wz = 0, cxk = 0, cyk = 0;
            if (st.corotating && st.cmA && st.cmB) {
                const m = st.mA + st.mB || 1;
                cxk = (st.mA * st.cmA[0] + st.mB * st.cmB[0]) / m; cyk = (st.mA * st.cmA[1] + st.mB * st.cmB[1]) / m;
                let num = 0, den = 0;
                for (let i = 0; i < cnt && i < ia.n; i++) {
                    const o = stride * i; if (!Number.isFinite(frame[o])) continue;
                    const q = as * i, rx = frame[o] - cxk, ry = frame[o + 1] - cyk;
                    num += rx * (a[q + 1] - vc[1]) - ry * (a[q] - vc[0]); den += rx * rx + ry * ry;
                }
                wz = den > 0 ? num / den : 0;
            }
            let v = 0;
            for (let i = 0; i < cnt && i < ia.n; i++) {
                const o = stride * i;
                if (!Number.isFinite(frame[o])) continue;
                const q = as * i;
                const hx = frame[o] / cps, hy = frame[o + 2] / cps, hz = -frame[o + 1] / cps;
                // kernel-axes velocity, minus Ω × (r − r_cm) in the corotating frame
                const ux = a[q] + wz * (frame[o + 1] - cyk), uy = a[q + 1] - wz * (frame[o] - cxk), uz = a[q + 2];
                const dvx = ux - vc[0], dvy = uy - vc[1], dvz = uz - vc[2];
                const T = st.streakTime / cps;
                const tx = hx - ux * T, ty = hy - uz * T, tz = hz + uy * T;
                const spd = Math.hypot(dvx, dvy, dvz) / (scaleEma.vel || 1);
                const b = (frame[o + 5] | 0) & 1, rgb = BODY_RGB[b];
                const alpha = Math.min(0.42, 0.08 + 0.32 * spd);
                const P = streaks.p, C = streaks.c, pv = 3 * v, cv = 4 * v;
                P[pv] = hx; P[pv + 1] = hy; P[pv + 2] = hz; P[pv + 3] = tx; P[pv + 4] = ty; P[pv + 5] = tz;
                const w = 0.55 + 0.45 * Math.min(spd, 1);
                C[cv] = rgb[0] * w + 0.3 * (1 - w); C[cv + 1] = rgb[1] * w + 0.3 * (1 - w); C[cv + 2] = rgb[2] * w + 0.3 * (1 - w); C[cv + 3] = alpha;
                C[cv + 4] = rgb[0]; C[cv + 5] = rgb[1]; C[cv + 6] = rgb[2]; C[cv + 7] = 0;
                v += 2;
            }
            streaks.line.geometry.setDrawRange(0, v);
            streaks.line.geometry.attributes.position.needsUpdate = true;
            streaks.line.geometry.attributes.aCol.needsUpdate = true;
            streaks.line.visible = v > 0;
        } else streaks.line.visible = false;

        // ── pathline tracers: a fixed subset of particles (every k-th kernel
        //    index), sampled every tracerDt of SIM time (1 % of an orbit), so
        //    each line is the last ~half orbit of that parcel's history —
        //    diffusion and mixing read as lines crossing the other star's.
        if (st.pathlinesOn && period > 0 && meta?.time != null) {
            if (!tracer.hist) {
                const step = Math.max(1, Math.floor(cnt / TRACER_MAX));
                tracer.ids = [];
                for (let i = 0; i < cnt && tracer.ids.length < TRACER_MAX; i += step) if (Number.isFinite(frame[stride * i])) tracer.ids.push(i);
                tracer.body = tracer.ids.map(i => (frame[stride * i + 5] | 0) & 1);
                tracer.hist = new Float32Array(tracer.ids.length * TRACER_LEN * 3).fill(NaN);
                tracer.head = 0; tracer.count = 0; tracer.lastT = -Infinity;
                st.tracerDt = 0.01 * period;
            }
            if (meta.time - tracer.lastT >= st.tracerDt) {
                tracer.lastT = meta.time;
                const th = st.corotating ? st.rotAngle : 0;
                tracer.ids.forEach((i, t) => {
                    const o = stride * i, at = 3 * (t * TRACER_LEN + tracer.head);
                    if (!Number.isFinite(frame[o])) { tracer.hist[at] = NaN; return; }
                    const [x, y, z] = unrotate(frame[o] / cps, frame[o + 2] / cps, -frame[o + 1] / cps, th);
                    tracer.hist[at] = x; tracer.hist[at + 1] = y; tracer.hist[at + 2] = z;
                });
                tracer.head = (tracer.head + 1) % TRACER_LEN;
                tracer.count = Math.min(TRACER_LEN, tracer.count + 1);
                // rebuild the segments, oldest → newest
                let v = 0;
                const L = tracer.count;
                for (let t = 0; t < tracer.ids.length; t++) {
                    const rgb = BODY_RGB[tracer.body[t]];
                    for (let s = 0; s < L - 1; s++) {
                        const i0 = (tracer.head - L + s + TRACER_LEN) % TRACER_LEN, i1 = (i0 + 1) % TRACER_LEN;
                        const p0 = 3 * (t * TRACER_LEN + i0), p1 = 3 * (t * TRACER_LEN + i1);
                        if (!Number.isFinite(tracer.hist[p0]) || !Number.isFinite(tracer.hist[p1])) continue;
                        const a0 = 0.24 * (s / (L - 1)) ** 2, a1 = 0.24 * ((s + 1) / (L - 1)) ** 2;
                        const P = pathlines.p, C = pathlines.c, H = tracer.hist, pv = 3 * v, cv = 4 * v;
                        P[pv] = H[p0]; P[pv + 1] = H[p0 + 1]; P[pv + 2] = H[p0 + 2]; P[pv + 3] = H[p1]; P[pv + 4] = H[p1 + 1]; P[pv + 5] = H[p1 + 2];
                        C[cv] = rgb[0]; C[cv + 1] = rgb[1]; C[cv + 2] = rgb[2]; C[cv + 3] = a0;
                        C[cv + 4] = rgb[0]; C[cv + 5] = rgb[1]; C[cv + 6] = rgb[2]; C[cv + 7] = a1;
                        v += 2;
                    }
                }
                pathlines.line.geometry.setDrawRange(0, v);
                pathlines.line.geometry.attributes.position.needsUpdate = true;
                pathlines.line.geometry.attributes.aCol.needsUpdate = true;
                pathlines.line.visible = v > 0;
            }
        } else if (!st.pathlinesOn) pathlines.line.visible = false;

        // ── A–B contacts: every cross-body kernel overlap the worker found,
        //    drawn at the CURRENT positions; gold where the pair is approaching
        //    (Monaghan viscosity heating it), violet where it merely overlaps.
        const links = ia.links;
        if (st.contactsOn && links && links.length) {
            let maxW = 0, maxH = 0;
            for (let k = 0; k < links.length; k += 4) { if (links[k + 2] > maxW) maxW = links[k + 2]; if (links[k + 3] > maxH) maxH = links[k + 3]; }
            // Every overlap is COUNTED (the HUD's A–B pairs); only those at the
            // stars' own resolution are DRAWN — an overlap between two fat
            // outskirt kernels is real but spans half the stage and read as a
            // spider-web over the merger (measured on the first capture).
            const maxLen = 4 * st.h0 * cps, maxLen2 = maxLen * maxLen;
            const crowd = Math.min(1, Math.sqrt(600 / Math.max(1, ia.summary?.abPairs ?? links.length / 4)));
            let v = 0;
            for (let k = 0; k < links.length && v < contacts.max; k += 4) {
                const i = links[k] | 0, j = links[k + 1] | 0;
                const oi = stride * i, oj = stride * j;
                if (i >= cnt || j >= cnt || !Number.isFinite(frame[oi]) || !Number.isFinite(frame[oj])) continue;
                const ddx = frame[oi] - frame[oj], ddy = frame[oi + 1] - frame[oj + 1], ddz = frame[oi + 2] - frame[oj + 2];
                if (ddx * ddx + ddy * ddy + ddz * ddz > maxLen2) continue;
                const heatN = maxH > 0 ? links[k + 3] / maxH : 0, wN = maxW > 0 ? links[k + 2] / maxW : 0;
                const rgb = heatN > 0 ? [1.0, 0.78, 0.38] : [0.62, 0.52, 1.0];
                // fade with crowding: at first touch a few hundred pairs ARE the
                // interface; inside the merged remnant every pair is A–B
                const al = crowd * (heatN > 0 ? 0.12 + 0.45 * Math.sqrt(heatN) : 0.06 + 0.2 * wN);
                contacts.p.set([frame[oi] / cps, frame[oi + 2] / cps, -frame[oi + 1] / cps, frame[oj] / cps, frame[oj + 2] / cps, -frame[oj + 1] / cps], 3 * v);
                contacts.c.set([rgb[0], rgb[1], rgb[2], al, rgb[0], rgb[1], rgb[2], al], 4 * v);
                v += 2;
            }
            contacts.line.geometry.setDrawRange(0, v);
            contacts.line.geometry.attributes.position.needsUpdate = true;
            contacts.line.geometry.attributes.aCol.needsUpdate = true;
            contacts.line.visible = v > 0;
        } else contacts.line.visible = false;
    }

    // ── Detail ladder ───────────────────────────────────────────────────────
    function applyDetail() {
        const L = DETAIL_LEVELS[st.detail] || DETAIL_LEVELS.standard;
        const K = Math.max(2, Math.min(L.children, Math.floor(CHILD_BUDGET / Math.max(st.nBudget, 1))));
        if (K !== st.children || geo.attributes.position.count !== K) {
            const n = geo.instanceCount;
            const old = geo;
            geo = buildParticleGeometry(K);
            geo.instanceCount = n;
            points.geometry = geo;
            old.dispose();
            st.children = K;
        }
        st.hdr = !!(L.hdr && ensureComposer());
        if (bloomPass) bloomPass.strength = L.bloom;
        linearUniform.value = st.hdr ? 1 : 0;
        renderer.setClearColor(st.hdr ? CLEAR_HDR : CLEAR, 1);
        // REINHARD, not ACES: the ACES fit goes NEGATIVE below ~0.004 linear and
        // crushed the night sky to 0,0,3 (measured); Reinhard is the identity in
        // the darks and only rolls off the overlapping cores.
        renderer.toneMapping = st.hdr ? THREE.ReinhardToneMapping : THREE.NoToneMapping;
        renderer.toneMappingExposure = 1.0;
        // Per-child light: split the particle's light over its K children and
        // normalise the column (∝ N^{1/3}) to a 600-per-star reference.
        // Overlap per pixel goes as K·(sprite size)², so the gain divides by it.
        const column = Math.cbrt(1200 / st.nBudget);
        mat.uniforms.uChildSize.value = L.childSize;
        mat.uniforms.uGain.value = GAIN[st.hdr ? 'hdr' : 'direct'] * column / (K * L.childSize * L.childSize);
        if (st.hdr) sizeComposer(container.clientWidth || 640, container.clientHeight || 400);
    }

    // ── Render loop ─────────────────────────────────────────────────────────
    let raf = 0, lastNow = performance.now();
    function loop() {
        raf = requestAnimationFrame(loop);
        const now = performance.now();
        lastNow = now;
        stepFollow();
        stepTween(now);
        controls.update();
        if (!st.running || !st.visible) return;
        if (onFrame) onFrame();
        if (st.hdr && composer) composer.render();
        else renderer.render(scene, camera);
    }
    loop();

    // ── Keyboard ────────────────────────────────────────────────────────────
    function onKeyDown(ev) {
        const t = ev.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (!st.hovering && document.activeElement !== renderer.domElement) return;
        const key = ev.key.toLowerCase();
        const handled = {
            '1': () => api.setView('top'), '2': () => api.setView('edge'), '3': () => api.setView('oblique'),
            '4': () => api.setCorotating(!st.corotating), 'f': () => api.frameSystem(),
            's': () => api.setFollow('system'), 'a': () => api.setFollow('A'), 'b': () => api.setFollow('B'), '0': () => api.setFollow('none'),
            'c': () => { const ids = Object.keys(COLOR_MODES); api.setColorMode(ids[(ids.indexOf(st.colorMode) + 1) % ids.length]); },
            't': () => api.setTrails(!st.trailsOn), 'r': () => api.reset(),
            'v': () => api.setStreaks(!st.streaksOn), 'p': () => api.setPathlines(!st.pathlinesOn), 'x': () => api.setContacts(!st.contactsOn),
            ' ': () => onCommand && onCommand('togglePause'),
            '+': () => flyTo({ r: currentSpherical().r * 0.8 }, 0.3), '=': () => flyTo({ r: currentSpherical().r * 0.8 }, 0.3),
            '-': () => flyTo({ r: currentSpherical().r * 1.25 }, 0.3),
        }[key];
        if (handled) { ev.preventDefault(); handled(); if (onCommand) onCommand('camera-changed'); }
    }
    window.addEventListener('keydown', onKeyDown);

    // ── API ─────────────────────────────────────────────────────────────────
    const api = {
        renderer, scene, camera, controls, world,
        get state() {
            return { detail: st.detail, hdr: st.hdr, children: st.children, software, view: st.view, follow: st.follow, corotating: st.corotating, colorMode: st.colorMode, trails: st.trailsOn,
                pointScale: st.pointScale, hasFrame: st.hasFrame, tweening: !!st.tween,
                streaks: st.streaksOn, pathlines: st.pathlinesOn, contacts: st.contactsOn, hasAux: !!ia.aux,
                streakTime: st.streakTime, tracerWindow: st.tracerDt * (TRACER_LEN - 1), tracers: tracer.ids.length,
                layerCounts: { streaks: streaks.line.geometry.drawRange.count / 2, pathlines: pathlines.line.geometry.drawRange.count / 2, contacts: contacts.line.geometry.drawRange.count / 2 },
                lastMeta: st.cmA && st.cmB ? { cmA: st.cmA.slice(), cmB: st.cmB.slice(), sep: st.sep } : null,
                followPoint: followPointWorld()?.toArray() ?? null };
        },
        /** kernel units per scene unit and the ring radius (kernel units). */
        setScale(cps, ringR) {
            st.codePerScene = cps; st.ringCode = ringR;
            const rs = ringR / cps;
            ring.scale.set(rs / 4, rs / 4, 1);
            const cr = Math.max(0.08, 0.05 * rs);
            coreMarks.forEach(m => m.scale.set(cr, cr, 1));
            bary.scale.setScalar(Math.max(0.5, rs / 4));
        },
        /**
         * h̄ in scene units (the smoothing length at the stars' MEAN density),
         * and the run's particle count, which sets the child budget and the
         * gain: the column through a star grows as N^{1/3}, so the light per
         * child is normalised by it to keep a 150- and a 2500-particle star
         * equally bright.
         */
        setPointSize(sceneUnits, nTotal = st.nBudget) {
            st.h0 = sceneUnits; st.nBudget = Math.max(1, nTotal | 0);
            mat.uniforms.uSize.value = sceneUnits;
            applyDetail();
        },
        /** 'auto' | 'standard' | 'high' | 'ultra' — see DETAIL_LEVELS. */
        setDetail(level) {
            const resolved = level === 'auto' || !DETAIL_LEVELS[level] ? (software || !canHdr ? 'standard' : 'high') : level;
            st.detailRequested = level;
            st.detail = resolved;
            applyDetail();
            if (onCommand) onCommand('view-state');
        },
        setPointScale(mult) { st.pointScale = mult; mat.uniforms.uPointScale.value = mult; },
        setHeatScale(v) { mat.uniforms.uHeatScale.value = v; },
        setColorMode(mode) { if (!COLOR_MODES[mode]) return; st.colorMode = mode; mat.uniforms.uMode.value = COLOR_MODES[mode].id; if (onCommand) onCommand('view-state'); },
        setTrails(on) { st.trailsOn = !!on; trails.forEach(t => { t.line.visible = st.trailsOn && t.n > 1; }); if (onCommand) onCommand('view-state'); },
        setFollow(mode) { if (!FOLLOW_MODES.includes(mode)) return; st.follow = mode; st.followSnap = true; if (onCommand) onCommand('view-state'); },
        setCorotating(on) {
            st.corotating = !!on;
            if (!st.corotating) { world.rotation.y = 0; st.rotAngle = 0; }
            resetTracers();
            st.followSnap = true;
            if (onCommand) onCommand('view-state');
        },
        setView(preset, { animate = true } = {}) {
            const p = VIEW_PRESETS[preset]; if (!p) return;
            st.view = preset;
            flyTo({ polar: p.polar, azimuth: p.azimuth }, animate ? TWEEN_S : 0);
            if (onCommand) onCommand('view-state');
        },
        /** Fit the particle cloud (or the preview) about the followed point. */
        frameSystem({ animate = true } = {}) {
            const r = distanceToFit(st.cloudRadius);
            flyTo({ r }, animate ? TWEEN_S : 0);
        },
        reset() {
            st.follow = 'system'; st.followSnap = true;
            api.setCorotating(false);
            st.view = 'oblique';
            const p = VIEW_PRESETS.oblique;
            flyTo({ r: distanceToFit(st.cloudRadius), polar: p.polar, azimuth: p.azimuth }, TWEEN_S);
            if (onCommand) onCommand('view-state');
        },
        /**
         * frame: Float32Array [x,y,z,log10ρ,u,flags] × n (stride 6, or 5 for an
         * older kernel); bodies: [{kind, pos, rs}]; meta: {cmA, cmB, mA, mB, sep, omega, time}.
         */
        setFrame(frame, n, bodies = [], meta = null, stride = 6) {
            preview.visible = false;
            const cps = st.codePerScene;
            const cnt = Math.min(n, MAX_POINTS);
            let dmax = -Infinity, k = 0;
            // corotating turn first, so the follow point and the cloud agree this frame
            if (meta) {
                st.cmA = meta.cmA; st.cmB = meta.cmB; st.mA = meta.mA; st.mB = meta.mB; st.sep = meta.sep; st.omega = meta.omega;
                if (st.corotating) {
                    if (meta.sep > 1e-6 && meta.cmA && meta.cmB) {
                        const X = meta.cmA[0] - meta.cmB[0], Z = -(meta.cmA[1] - meta.cmB[1]);
                        st.rotAngle = Math.atan2(Z, X);
                    } else if (Number.isFinite(meta.omega) && meta.time != null && st.lastFrameT) {
                        st.rotAngle += meta.omega * (meta.time - st.lastFrameT);   // kernel ω about +z → scene −y sense handled by sign below
                    }
                    world.rotation.y = st.rotAngle;
                }
                st.lastFrameT = meta.time ?? st.lastFrameT;
            }
            // follow point in local coords for the cloud radius
            const fp = (() => {
                if (st.follow === 'A' && st.cmA) return k2s(st.cmA, cps);
                if (st.follow === 'B' && st.cmB) return k2s(st.cmB, cps);
                if (st.cmA && st.cmB) { const m = st.mA + st.mB || 1; return k2s([(st.mA * st.cmA[0] + st.mB * st.cmB[0]) / m, (st.mA * st.cmA[1] + st.mB * st.cmB[1]) / m, (st.mA * st.cmA[2] + st.mB * st.cmB[2]) / m], cps); }
                return new THREE.Vector3();
            })();
            const radii = [];
            for (let i = 0; i < cnt; i++) {
                const o = stride * i;
                const x = frame[o];
                if (!Number.isFinite(x)) continue;
                const sx = x / cps, sy = frame[o + 2] / cps, sz = -frame[o + 1] / cps;
                pos[3 * k] = sx; pos[3 * k + 1] = sy; pos[3 * k + 2] = sz;
                dens[k] = frame[o + 3];
                heat[k] = frame[o + 4];
                flag[k] = stride >= 6 ? frame[o + 5] : 0;
                seedA[k] = i;          // the KERNEL index: an accreted particle must not reshuffle the rest
                if (dens[k] > dmax) dmax = dens[k];
                if ((k & 3) === 0) radii.push(Math.hypot(sx - fp.x, sy - fp.y, sz - fp.z));
                k++;
            }
            geo.instanceCount = k;
            fillAuxInstances(cnt, stride, frame);
            for (const a of Object.values(inst)) a.needsUpdate = true;
            updateBehaviour(frame, cnt, stride, meta);
            if (Number.isFinite(dmax)) mat.uniforms.uDensMax.value = dmax;
            st.alive = k; st.hasFrame = k > 0 || bodies.some(b => b && b.kind === 'bh');
            if (radii.length) { radii.sort((a, b) => a - b); st.cloudRadius = Math.max(radii[Math.floor(radii.length * 0.96)], 0.2); }
            else if (bodies.length) st.cloudRadius = Math.max(st.sep / cps, 0.5);
            for (let b = 0; b < 2; b++) {
                const m = bhMeshes[b], body = bodies[b];
                if (body && body.kind === 'bh') {
                    m.visible = true;
                    const r = Math.max(body.rs / cps, 0.03);
                    m.scale.set(r, r, r);
                    m.position.copy(k2s(body.pos, cps));
                } else m.visible = false;
            }
            // cores, separation line, trails, barycentre
            if (st.cmA && st.cmB) {
                const a = k2s(st.cmA, cps), bb = k2s(st.cmB, cps);
                coreMarks[0].position.copy(a); coreMarks[1].position.copy(bb);
                coreMarks.forEach(m => { m.visible = true; });
                const sp = sepGeo.attributes.position.array;
                sp[0] = a.x; sp[1] = a.y; sp[2] = a.z; sp[3] = bb.x; sp[4] = bb.y; sp[5] = bb.z;
                sepGeo.attributes.position.needsUpdate = true;
                sepLine.computeLineDistances();
                sepLine.visible = st.sep / cps > 0.05;
                bary.position.copy(fp.clone().lerp(new THREE.Vector3(), 0)); // fp already the follow point; barycentre drawn only in system-follow
                const m = st.mA + st.mB || 1;
                bary.position.copy(k2s([(st.mA * st.cmA[0] + st.mB * st.cmB[0]) / m, (st.mA * st.cmA[1] + st.mB * st.cmB[1]) / m, (st.mA * st.cmA[2] + st.mB * st.cmB[2]) / m], cps));
                bary.visible = true;
                [a, bb].forEach((p, i) => {
                    const t = trails[i];
                    const arr = t.line.geometry.attributes.position.array;
                    if (t.n >= MAX_TRAIL) { arr.copyWithin(0, 3, MAX_TRAIL * 3); t.n = MAX_TRAIL - 1; }
                    const last = t.n > 0 ? [arr[3 * (t.n - 1)], arr[3 * (t.n - 1) + 1], arr[3 * (t.n - 1) + 2]] : null;
                    if (!last || Math.hypot(last[0] - p.x, last[1] - p.y, last[2] - p.z) > 0.004) {
                        arr[3 * t.n] = p.x; arr[3 * t.n + 1] = p.y; arr[3 * t.n + 2] = p.z; t.n++;
                    }
                    t.line.geometry.setDrawRange(0, t.n);
                    t.line.geometry.attributes.position.needsUpdate = true;
                    t.line.visible = st.trailsOn && t.n > 1;
                });
            }
        },
        /** Pre-run preview: bodies [{kind, radius (code), pos (code[3])}]. */
        setPreview(bodies) {
            while (preview.children.length) {
                const c = preview.children.pop();
                c.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
            }
            const cps = st.codePerScene;
            let maxR = 0.5;
            bodies.forEach((b, i) => {
                const r = Math.max(b.radius / cps, 0.02);
                const p = k2s(b.pos, cps);
                maxR = Math.max(maxR, p.length() + r);
                let mesh;
                mesh = new THREE.Group();
                if (b.kind === 'bh') {
                    mesh.add(new THREE.Mesh(new THREE.SphereGeometry(r, 48, 32), new THREE.MeshBasicMaterial({ color: 0x000000 })));
                    const halo = new THREE.Mesh(new THREE.RingGeometry(r * 1.35, r * 1.6, 96), new THREE.MeshBasicMaterial({ color: 0xffb066, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
                    halo.rotation.x = -Math.PI / 2; mesh.add(halo);
                    mesh.add(makePhotonGlow(r));
                } else {
                    const col = new THREE.Color(coreColors[i] || 0xffffff);
                    const glow = new THREE.ShaderMaterial({
                        vertexShader: STAR_VS, fragmentShader: STAR_FS,
                        uniforms: { uColor: { value: new THREE.Vector3(col.r, col.g, col.b) }, uLinear: linearUniform },
                        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
                    });
                    mesh.add(new THREE.Mesh(new THREE.SphereGeometry(r, 64, 40), glow));
                    // a faint lat–long cage keeps the 'configured, not yet built' read
                    mesh.add(new THREE.Mesh(new THREE.SphereGeometry(r * 1.002, 18, 10), new THREE.MeshBasicMaterial({ color: coreColors[i] || 0xffffff, wireframe: true, transparent: true, opacity: 0.035, depthWrite: false })));
                }
                mesh.position.copy(p);
                preview.add(mesh);
            });
            preview.visible = true;
            st.hasFrame = false; st.cmA = null; st.cmB = null;
            st.cloudRadius = maxR;
        },
        clearTrails() { trails.forEach(t => { t.n = 0; t.line.geometry.setDrawRange(0, 0); t.line.visible = false; }); resetTracers(); },
        /**
         * The interaction channel from the worker: aux (Float32Array, AUX_STRIDE
         * per KERNEL index: vx, vy, vz, h, ∇·v, mixing, heating rate), links
         * (i, j, w, heat) and the summary. Held until the next one arrives.
         */
        setInteractions(aux, links, summary, n, stride = 7) {
            if (!aux) return;
            ia.aux = aux; ia.links = links || null; ia.summary = summary || null; ia.n = n; ia.stride = stride;
            // barycentre velocity (kernel axes) → robust display scales, eased
            const vcm = summary?.cmVel || [0, 0, 0];
            ia.vcm = vcm;
            const sp = [], dv = [], sh = [];
            for (let i = 0; i < n; i++) {
                const o = stride * i;
                if (!(aux[o + 3] > 0)) continue;
                sp.push(Math.hypot(aux[o] - vcm[0], aux[o + 1] - vcm[1], aux[o + 2] - vcm[2]));
                dv.push(Math.abs(aux[o + 4]));
                if (aux[o + 6] > 0) sh.push(aux[o + 6]);
            }
            const pct = (a, q) => { if (!a.length) return 0; a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };
            const ease = (key, v) => { if (!(v > 0)) return; scaleEma[key] = scaleEma[key] > 0 ? 0.7 * scaleEma[key] + 0.3 * v : v; };
            ease('vel', pct(sp, 0.95)); ease('div', pct(dv, 0.95)); ease('shock', pct(sh, 0.98));
            mat.uniforms.uVelScale.value = scaleEma.vel > 0 ? 1 / scaleEma.vel : 1;
            mat.uniforms.uDivScale.value = scaleEma.div > 0 ? 1 / scaleEma.div : 1;
            mat.uniforms.uShockScale.value = scaleEma.shock > 0 ? 1 / scaleEma.shock : 1;
            mat.uniforms.uHasAux.value = 1;
        },
        setStreaks(on) { st.streaksOn = !!on; if (!on) streaks.line.visible = false; if (onCommand) onCommand('view-state'); },
        setPathlines(on) { st.pathlinesOn = !!on; if (!on) pathlines.line.visible = false; resetTracers(); if (onCommand) onCommand('view-state'); },
        setContacts(on) { st.contactsOn = !!on; if (!on) contacts.line.visible = false; if (onCommand) onCommand('view-state'); },
        setAutoRotate(on) { controls.autoRotate = !!on; },
        /** Back-compat: frame the stage at a distance (used before the first frame). */
        frameAll(distance) { flyTo({ r: distance }, 0); },
        clear() {
            geo.instanceCount = 0; bhMeshes.forEach(m => { m.visible = false; });
            coreMarks.forEach(m => { m.visible = false; }); sepLine.visible = false; bary.visible = false;
            api.clearTrails(); st.hasFrame = false; st.cmA = null; st.cmB = null; world.rotation.y = 0; st.rotAngle = 0;
            ia.aux = null; ia.links = null; ia.summary = null; mat.uniforms.uHasAux.value = 0;
            scaleEma.vel = scaleEma.div = scaleEma.shock = 0;
            [streaks, pathlines, contacts].forEach(L => { L.line.visible = false; L.line.geometry.setDrawRange(0, 0); });
        },
        dispose() {
            cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
            document.removeEventListener('visibilitychange', onVis);
            window.removeEventListener('keydown', onKeyDown);
            composer?.dispose?.();
            renderer.dispose();
        },
        get codePerScene() { return st.codePerScene; },
        get detailLevels() { return DETAIL_LEVELS; },
        /** Test/capture hook: the post chain (null on the direct path). */
        get post() { return composer ? { composer, bloomPass } : null; },
        get ringCode() { return st.ringCode; },
        distanceToFit,
    };
    // Initial rung, silently (the page renders the view state once it holds `scene`).
    st.detailRequested = detail;
    st.detail = detail === 'auto' || !DETAIL_LEVELS[detail] ? (software || !canHdr ? 'standard' : 'high') : detail;
    applyDetail();
    return api;
}
