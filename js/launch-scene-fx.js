/**
 * launch-scene-fx.js — The world AROUND the launch planner's vehicle:
 * night sky, stars, terrain, the reflection environment, and the
 * post-processing chain. js/launch-vehicle-3d.js owns the vehicle, pad
 * and camera; this module owns everything those sit inside.
 *
 * THE LOOK: a night launch from a floodlit pad — the classic launch
 * photograph. The vehicle is lit by cool xenon floodlights from the camera
 * side (the scene's key light), the sky is the end of astronomical twilight
 * with a faint warm glow low on one horizon, the Milky Way overhead, and the
 * engine flame becomes the brightest thing in the frame at ignition.
 *
 * FOUR THINGS ARE LOAD-BEARING:
 *   1. ONE HORIZON COLOUR. `HORIZON` is the sky dome's colour at the horizon
 *      AND scene.fog's colour, so terrain fogs into exactly the sky behind
 *      it — that is what removed the hard edge where the old ground disc
 *      ended against a different-coloured background.
 *   2. THE DOME FOLLOWS THE CAMERA (call `sky.follow(camera)` per frame) and
 *      is drawn first with depthWrite off, so it can never occlude terrain
 *      or be clipped by the far plane at any zoom.
 *   3. THE ENVIRONMENT IS NOT THE SKY ALONE. A metal reflects its
 *      surroundings and a night sky is nearly black, so the old dusk-sky IBL
 *      left Starship's steel and Dragon's clearcoat reflecting nothing. The
 *      PMREM source is this sky PLUS emissive floodlight panels at the key /
 *      fill azimuths and a lit apron below — what a vehicle on a floodlit
 *      pad actually mirrors.
 *   4. POST RUNS IN LINEAR HDR. RenderPass → UnrealBloomPass on the linear
 *      image (only things brighter than the threshold — flame, beacons,
 *      floodlight lamps — bloom) → ONE final pass (sanitize → ACES → sRGB →
 *      vignette + TPDF dither; the dark sky gradient bands visibly in 8 bits
 *      without the dither). Without WebGL2 the chain is skipped and the
 *      renderer tone-maps directly.
 *   5. EVERY PASS THAT READS THE LINEAR SCENE SANITIZES IT (SANITIZE_GLSL).
 *      One NaN/Inf pixel through the bloom blacked out the whole stage on
 *      real GPUs (2026-11-08) — never remove the guard, and never add a
 *      shader with pow() of a possibly-negative base, normalize() of a
 *      possibly-zero vector or atan(0, 0): SwiftShader tolerates them, a
 *      GPU driver does not, so CI cannot see it.
 *
 * Public API:
 *   HORIZON                               THREE.Color shared by dome + fog
 *   buildSky({ radius })                  → { mesh, follow(camera), dispose }
 *   buildStars({ count, radius })         → { points, tick(t), follow(camera), dispose }
 *   buildTerrain()                        → { group, dispose }
 *   buildEnvironment(renderer)            → { texture, dispose }
 *   createPost(renderer, scene, camera, { quality }) → { render(), setSize(w,h),
 *                                             setBloom(k), enabled, dispose }
 *   detectQuality(renderer, search)       → 'high' | 'low' | 'off'
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

// Linear-light colours (the scene is rendered linear and tone-mapped once).
export const HORIZON = new THREE.Color(0.030, 0.028, 0.050);
const ZENITH         = new THREE.Color(0.0018, 0.0026, 0.0095);
const MID            = new THREE.Color(0.0060, 0.0085, 0.026);
const GLOW           = new THREE.Color(0.30, 0.12, 0.045);   // twilight / distant-city glow
// Azimuth of that glow: left of the default 3/4 camera's view, so it sits in
// frame low on the horizon behind the tower instead of behind the camera.
const GLOW_DIR = new THREE.Vector3(-0.85, 0.0, -0.55).normalize();

// ── Shared GLSL noise ───────────────────────────────────────────────────────
const NOISE_GLSL = /* glsl */`
    float h13(vec3 p) {
        p = fract(p * 0.1031);
        p += dot(p, p.zyx + 31.32);
        return fract((p.x + p.y) * p.z);
    }
    float vnoise(vec3 p) {
        vec3 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float n000 = h13(i), n100 = h13(i + vec3(1,0,0));
        float n010 = h13(i + vec3(0,1,0)), n110 = h13(i + vec3(1,1,0));
        float n001 = h13(i + vec3(0,0,1)), n101 = h13(i + vec3(1,0,1));
        float n011 = h13(i + vec3(0,1,1)), n111 = h13(i + vec3(1,1,1));
        return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
                   mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
    }
    float fbm3(vec3 p) {
        float v = 0.0, a = 0.5;
        for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
        return v;
    }
`;

// ── Sky dome ────────────────────────────────────────────────────────────────

const SKY_VERT = /* glsl */`
    varying vec3 vDir;
    void main() {
        vDir = normalize(position);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_Position.z = gl_Position.w * 0.99999;     // pin to the far plane
    }
`;

const SKY_FRAG = /* glsl */`
    uniform vec3 uZenith, uMid, uHorizon, uGlow, uGlowDir;
    uniform float uMilkyWay;
    varying vec3 vDir;
    ${NOISE_GLSL}
    void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        // Below the horizon: the haze the terrain fogs into (same colour).
        if (h < 0.0) {
            gl_FragColor = vec4(uHorizon * mix(1.0, 0.55, smoothstep(0.0, -0.25, h)), 1.0);
            return;
        }
        // Vertical gradient — horizon → mid → zenith, on a √ height law so the
        // bright band hugs the horizon the way an airglow / haze layer does.
        float t = sqrt(h);
        vec3 col = mix(uHorizon, uMid, smoothstep(0.0, 0.45, t));
        col = mix(col, uZenith, smoothstep(0.35, 1.0, t));

        // Twilight glow low on one azimuth (forward-scattering halo).
        // Azimuth term. normalize(vec3(d.x, 0, d.z)) is normalize(0) at the
        // zenith — NaN on real GPUs, and one NaN pixel used to black out the
        // frame through the bloom (see SANITIZE_GLSL). Guarded on the length.
        float hl = length(d.xz);
        float az = hl > 1e-5 ? max(dot(d.xz / hl, uGlowDir.xz), 0.0) : 0.0;
        // Lifted a few degrees off the horizon: terrain fogs into plain
        // HORIZON, so a glow peaking AT h = 0 drew a hard line along it.
        float lowBand = exp(-h * 9.0) * smoothstep(0.0, 0.07, h);
        col += uGlow * pow(az, 6.0) * lowBand * 0.55;
        col += uGlow * pow(az, 1.5) * exp(-h * 3.0) * 0.06;

        // Milky Way: a tilted great circle, fbm brightness, darker dust lanes.
        vec3 pole = normalize(vec3(0.38, 0.42, -0.82));
        float b = dot(d, pole);                       // galactic "latitude"
        float band = exp(-b * b * 22.0);
        float n  = fbm3(d * 7.0);
        float n2 = fbm3(d * 18.0 + 3.1);
        float lanes = smoothstep(0.38, 0.62, fbm3(d * 11.0 - 1.7));
        float mw = band * (0.35 + 0.9 * n) * (0.55 + 0.45 * n2) * mix(1.0, 0.35, lanes * exp(-b * b * 60.0));
        col += vec3(0.020, 0.019, 0.024) * mw * uMilkyWay * smoothstep(0.02, 0.25, h);

        gl_FragColor = vec4(col, 1.0);
    }
`;

export function buildSky({ radius = 3000 } = {}) {
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uZenith:   { value: ZENITH.clone() },
            uMid:      { value: MID.clone() },
            uHorizon:  { value: HORIZON.clone() },
            uGlow:     { value: GLOW.clone() },
            uGlowDir:  { value: GLOW_DIR.clone() },
            uMilkyWay: { value: 1.0 },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
    });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 64, 32), mat);
    mesh.name = 'SkyDome';
    mesh.renderOrder = -10;
    mesh.frustumCulled = false;
    return {
        mesh,
        follow(camera) { mesh.position.copy(camera.position); },
        dispose() { mesh.geometry.dispose(); mat.dispose(); },
    };
}

// ── Stars ───────────────────────────────────────────────────────────────────
// Magnitude-distributed (many faint, few bright), colour by a rough spectral
// class, extinguished and reddened toward the horizon, twinkling harder low
// in the sky (more air in the way). Bright ones exceed the bloom threshold.

function starColor(u) {
    // Blackbody-ish ramp, M (orange) → O/B (blue-white); weighted toward G/K.
    const stops = [
        [0.00, [1.00, 0.62, 0.38]],
        [0.25, [1.00, 0.80, 0.60]],
        [0.55, [1.00, 0.95, 0.88]],
        [0.80, [0.86, 0.90, 1.00]],
        [1.00, [0.66, 0.76, 1.00]],
    ];
    for (let i = 1; i < stops.length; i++) {
        if (u <= stops[i][0]) {
            const [a0, c0] = stops[i - 1], [a1, c1] = stops[i];
            const f = (u - a0) / (a1 - a0);
            return c0.map((v, k) => v + (c1[k] - v) * f);
        }
    }
    return stops[stops.length - 1][1];
}

export function buildStars({ count = 3200, radius = 2600 } = {}) {
    let s = 20261101;
    const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const mag = new Float32Array(count);
    const ph  = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        // Upper hemisphere only (uniform in solid angle), a sliver below the
        // horizon so the extinction fade has something to fade.
        const y = rnd() * 1.04 - 0.04;
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        pos[i * 3] = Math.cos(a) * r * radius;
        pos[i * 3 + 1] = y * radius;
        pos[i * 3 + 2] = Math.sin(a) * r * radius;
        const c = starColor(Math.pow(rnd(), 0.8));
        col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
        // Brightness ∝ 10^(−0.4 m) with N(<m) growing ~3× per magnitude:
        // sample m from an exponential so faint stars dominate.
        const m = Math.min(6.5, -Math.log(1 - rnd() * 0.9995) / 1.1);   // 0 … 6.5
        mag[i] = Math.pow(10, -0.4 * (m - 1.2));
        ph[i] = rnd() * Math.PI * 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aMag',     new THREE.BufferAttribute(mag, 1));
    geo.setAttribute('aPhase',   new THREE.BufferAttribute(ph, 1));
    const mat = new THREE.ShaderMaterial({
        uniforms: { uTime: { value: 0 }, uFade: { value: 1 } },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        fog: false,
        vertexShader: /* glsl */`
            attribute float aMag;
            attribute float aPhase;
            attribute vec3 color;
            uniform float uTime;
            varying vec3 vCol;
            varying float vBright;
            void main() {
                vec3 dir = normalize(position);
                float alt = dir.y;
                // Extinction + reddening toward the horizon.
                float ext = smoothstep(-0.01, 0.22, alt);
                float twAmp = mix(0.55, 0.10, smoothstep(0.0, 0.5, alt));
                float tw = 1.0 + twAmp * sin(uTime * (2.0 + aPhase) + aPhase * 7.0)
                                       * sin(uTime * 3.3 + aPhase * 3.0);
                vBright = aMag * ext * tw;
                vCol = mix(color * vec3(1.0, 0.72, 0.55), color, ext);
                vec4 mv = modelViewMatrix * vec4(position, 1.0);
                gl_Position = projectionMatrix * mv;
                gl_Position.z = gl_Position.w * 0.99998;
                gl_PointSize = clamp(1.6 + 2.6 * sqrt(aMag), 1.5, 6.0);
            }
        `,
        fragmentShader: /* glsl */`
            uniform float uFade;
            varying vec3 vCol;
            varying float vBright;
            void main() {
                vec2 q = gl_PointCoord - 0.5;
                float r2 = dot(q, q) * 4.0;
                if (r2 > 1.0) discard;
                // Gaussian PSF core.
                float psf = exp(-r2 * 4.5);
                gl_FragColor = vec4(vCol * vBright * psf * 1.4 * uFade, 1.0);
            }
        `,
    });
    const points = new THREE.Points(geo, mat);
    points.name = 'Stars';
    points.frustumCulled = false;
    points.renderOrder = -9;
    return {
        points,
        tick(t) { mat.uniforms.uTime.value = t; },
        follow(camera) { points.position.copy(camera.position); },
        dispose() { geo.dispose(); mat.dispose(); },
    };
}

// ── Terrain ─────────────────────────────────────────────────────────────────
// Coastal scrub flats out to the haze, plus a low treeline silhouette ring.
// The ground is a lit MeshStandardMaterial (it receives the key light's
// shadows and the engine flame's light) with a procedural albedo; fog does
// the horizon blend (see HORIZON).

function scrubTexture(size = 512) {
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    let s = 99;
    const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    const G = 32;
    const lat = new Float32Array(G * G).map(() => rnd());
    // Tileable value noise (lattice wraps at G).
    const lv = (x, y) => lat[((y % G) + G) % G * G + ((x % G) + G) % G];
    const noise = (x, y) => {
        const xi = Math.floor(x), yi = Math.floor(y);
        let fx = x - xi, fy = y - yi;
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
        const a = lv(xi, yi), b = lv(xi + 1, yi), c2 = lv(xi, yi + 1), e = lv(xi + 1, yi + 1);
        return (a + (b - a) * fx) * (1 - fy) + (c2 + (e - c2) * fx) * fy;
    };
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = x / size * G, v = y / size * G;
            let n = 0, amp = 0.5, f = 1 / 4;
            for (let o = 0; o < 5; o++) { n += amp * noise(u * f * 4, v * f * 4); f *= 2; amp *= 0.5; }
            const grain = rnd() * 0.08;
            // Sand ↔ scrub mix.
            const veg = Math.max(0, Math.min(1, (n - 0.45) * 3));
            const r = (0.36 - 0.16 * veg + grain) * 255;
            const g = (0.33 - 0.08 * veg + grain) * 255;
            const b = (0.26 - 0.12 * veg + grain * 0.8) * 255;
            const k = (y * size + x) * 4;
            d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    return tex;
}

export function buildTerrain() {
    const group = new THREE.Group();
    group.name = 'Terrain';
    const tex = scrubTexture(512);
    tex.repeat.set(90, 90);
    const groundMat = new THREE.MeshStandardMaterial({
        map: tex, color: 0x9a9284, roughness: 0.96, metalness: 0,
    });
    const ground = new THREE.Mesh(new THREE.CircleGeometry(4200, 96), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.32;
    ground.receiveShadow = true;
    group.add(ground);

    // Treeline: a ring of irregular height at ~1.3 km, dark, unlit (it is a
    // silhouette against the haze, which fog then softens).
    const R = 1300, SEG = 360;
    const posArr = [];
    const idx = [];
    let s = 7;
    const rnd = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    let hPrev = 12;
    for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        if (i === SEG) { posArr.push(...posArr.slice(0, 6)); break; }   // close the ring exactly
        hPrev = Math.max(4, Math.min(28, hPrev + (rnd() - 0.5) * 6));
        const hh = hPrev + (rnd() < 0.08 ? 10 * rnd() : 0);
        const rr = R + (rnd() - 0.5) * 60;
        posArr.push(Math.cos(a) * rr, -0.3, Math.sin(a) * rr);
        posArr.push(Math.cos(a) * rr, hh,   Math.sin(a) * rr);
        if (i < SEG) {
            const k = i * 2;
            idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
        }
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
    tg.setIndex(idx);
    const treeMat = new THREE.MeshBasicMaterial({ color: 0x07070b, side: THREE.DoubleSide });
    const trees = new THREE.Mesh(tg, treeMat);
    trees.name = 'Treeline';
    group.add(trees);

    return {
        group,
        dispose() {
            ground.geometry.dispose(); groundMat.dispose(); tex.dispose();
            tg.dispose(); treeMat.dispose();
        },
    };
}

// ── Reflection environment ──────────────────────────────────────────────────

export function buildEnvironment(renderer) {
    const envScene = new THREE.Scene();
    // The sky itself (small radius — PMREM's cube camera has near 0.1 / far 100).
    const sky = buildSky({ radius: 40 });
    sky.mesh.material.uniforms.uMilkyWay.value = 0;
    // A touch brighter than the backdrop so dark steel still separates from it.
    sky.mesh.material.uniforms.uHorizon.value.multiplyScalar(2.2);
    sky.mesh.material.uniforms.uMid.value.multiplyScalar(2.0);
    sky.mesh.material.depthTest = true;
    envScene.add(sky.mesh);

    // Floodlight panels: xenon white at the key-light azimuth (camera side),
    // a dimmer warm sodium bank at the fill azimuth, a cool rim behind.
    const panel = (color, intensity, w, h, dir, dist = 30) => {
        const m = new THREE.Mesh(
            new THREE.PlaneGeometry(w, h),
            new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }),
        );
        const p = new THREE.Vector3(...dir).normalize().multiplyScalar(dist);
        m.position.copy(p);
        m.lookAt(0, 0, 0);
        envScene.add(m);
        return m;
    };
    panel(0xf4f6ff, 9.0, 16, 6,  [0.85, 0.42, 0.55]);
    panel(0xf4f6ff, 5.0, 10, 4,  [0.20, 0.30, 0.95]);
    panel(0xffb070, 3.2, 14, 5,  [-0.70, 0.22, 0.45]);
    panel(0x9fb8ff, 1.6, 20, 4,  [0.00, 0.35, -1.00]);
    // Lit apron below the horizon (concrete under floodlights).
    const apron = new THREE.Mesh(
        new THREE.CircleGeometry(38, 48),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0x8a8a90).multiplyScalar(0.16), side: THREE.DoubleSide }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -6;
    envScene.add(apron);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const rt = pmrem.fromScene(envScene, 0.02, 0.1, 100);
    pmrem.dispose();
    envScene.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    return { texture: rt.texture, dispose() { rt.dispose(); } };
}

// ── Quality ─────────────────────────────────────────────────────────────────

export function detectQuality(renderer, search = '') {
    const q = new URLSearchParams(search).get('lpfx');
    if (q === 'off' || q === '0') return 'off';
    if (q === 'high' || q === 'low') return q;
    const gl = renderer.getContext();
    if (!renderer.capabilities.isWebGL2) return 'off';
    let name = '';
    try {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    } catch (_) { /* privacy-hardened browsers */ }
    if (/swiftshader|llvmpipe|software|basic render/i.test(name)) return 'low';
    return 'high';
}

// ── Post-processing ─────────────────────────────────────────────────────────

// ── HDR sanitizing (THE BLACK-SCREEN FIX, 2026-11-08) ───────────────────────
// ONE non-finite pixel blacked out the whole stage. A NaN (pow of a negative
// base, normalize(0), atan(0,0) — tame on SwiftShader, undefined on real GPU
// drivers) or an Inf (any HDR value past half-float's 65504) entered the
// bloom's mip chain, the separable blur smeared it into a RECTANGLE most of
// the frame wide, and ACES(NaN) is black. Measured: a 0.4 m speck emitting
// 0/0 turns the entire canvas black on the pre-fix chain; the user's report
// showed exactly that rectangle with the finish pass's dither still on it.
//
// So every pass that READS the linear scene sanitizes it first: the bloom's
// bright pass (so the blur can never carry a bad value) and the final pass
// (so a bad pixel stays ONE pixel). The test is on the BITS
// (floatBitsToUint — GLSL ES 3.00, i.e. WebGL2, which is the only path that
// runs post), because `x != x` and isnan() are legally folded to false by
// fast-math compilers. +Inf maps to the ceiling (a blown highlight stays
// white), NaN and −Inf to 0, then a firefly ceiling far above anything the
// scene emits (standby peak ≈ 14 linear across every vehicle and view).
export const HDR_CEILING = 256.0;
export const SANITIZE_GLSL = /* glsl */`
    float lpFinite(float x) {
        highp uint b = floatBitsToUint(x);     // highp: mediump ints may be 16-bit
        if ((b & 0x7f800000u) == 0x7f800000u) {
            return ((b & 0x007fffffu) != 0u || (b & 0x80000000u) != 0u) ? 0.0 : ${HDR_CEILING.toFixed(1)};
        }
        return clamp(x, 0.0, ${HDR_CEILING.toFixed(1)});
    }
    vec3 lpSanitize(vec3 c) { return vec3(lpFinite(c.r), lpFinite(c.g), lpFinite(c.b)); }
`;

// The final pass: sanitize → exposure + ACES → sRGB → vignette → TPDF dither.
// It replaces OutputPass + a separate finish pass (one full-screen pass
// fewer per frame) and reproduces their arithmetic exactly — OutputPass is
// ACESFilmicToneMapping() then sRGBTransferOETF(), and the vignette/dither
// ran on that display-space result. uSanitize exists for the browser gate's
// NEGATIVE CONTROL (tests/launch-planner-render-health.spec.js), nothing else.
const FinalShader = {
    uniforms: {
        tDiffuse:   { value: null },
        uVignette:  { value: 0.32 },
        uFrame:     { value: 0 },
        uRes:       { value: new THREE.Vector2(1, 1) },
        uSanitize:  { value: 1 },
    },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uVignette;
        uniform float uFrame;
        uniform vec2 uRes;
        uniform float uSanitize;
        varying vec2 vUv;
        // three prepends colorspace_pars_fragment (sRGBTransferOETF) to every
        // non-raw ShaderMaterial — including it again is a redefinition that
        // fails to compile (the render-health monitor caught exactly that).
        // tonemapping_pars_fragment is only prepended when the material is
        // tone-mapped, and this one is not (toneMapped: false), so it IS needed.
        #include <tonemapping_pars_fragment>
        ${SANITIZE_GLSL}
        float hash12(vec2 p) {
            vec3 p3 = fract(vec3(p.xyx) * 0.1031);
            p3 += dot(p3, p3.yzx + 33.33);
            return fract((p3.x + p3.y) * p3.z);
        }
        void main() {
            vec4 c = texture2D(tDiffuse, vUv);
            if (uSanitize > 0.5) c.rgb = lpSanitize(c.rgb);
            c.rgb = ACESFilmicToneMapping(c.rgb);       // applies toneMappingExposure
            c = sRGBTransferOETF(c);
            // Vignette (display space, gentle, aspect-aware).
            vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
            float v = 1.0 - uVignette * smoothstep(0.35, 1.05, length(q));
            c.rgb *= v;
            // TPDF dither, ±1 LSB: breaks the 8-bit banding in the night sky.
            vec2 px = vUv * uRes + uFrame * vec2(17.0, 11.0);
            float n = hash12(px) + hash12(px + 0.37) - 1.0;
            c.rgb += n / 255.0;
            gl_FragColor = vec4(c.rgb, 1.0);
        }
    `,
};

// Sanitize the bloom's BRIGHT PASS — the first thing the blur chain reads.
// Patched by string so the vendored UnrealBloomPass stays untouched; THROWS if
// the anchor is gone (a three upgrade must not silently drop the guard).
export function sanitizeBloomInput(bloom) {
    const m = bloom.materialHighPassFilter;
    const anchor = 'vec4 texel = texture2D( tDiffuse, vUv );';
    if (!m || !m.fragmentShader.includes(anchor)) {
        throw new Error('sanitizeBloomInput: UnrealBloomPass high-pass shader changed — re-anchor the HDR sanitize');
    }
    m.uniforms.uSanitize = { value: 1 };
    m.fragmentShader = m.fragmentShader
        .replace('void main() {', `uniform float uSanitize;\n${SANITIZE_GLSL}\nvoid main() {`)
        .replace(anchor, `${anchor}\n\t\t\tif ( uSanitize > 0.5 ) texel.rgb = lpSanitize( texel.rgb );`);
    m.needsUpdate = true;
    return m;
}

// three r160's UnrealBloomPass builds each separable blur with σ = the
// kernel RADIUS, i.e. truncated at 1σ where the weight is still e^(−½) = 0.61.
// That is nearly a box filter, and a box blurred along x then y is a SQUARE:
// every small hot point (a beacon, a plume tip, a lamp) bloomed as a glowing
// square (measured in the first after-shots). Re-deriving the coefficients at
// σ = radius / 2.5 truncates at 2.5σ (weight 0.044) — round halos. The shader
// divides by its own weight sum, so total energy is unchanged; the mip chain
// still provides the halo's width.
export function roundBloomKernels(bloom, sigmaDiv = 2.5) {
    for (const m of bloom.separableBlurMaterials || []) {
        const R = m.defines.KERNEL_RADIUS;
        const sigma = R / sigmaDiv;
        const c = [];
        for (let i = 0; i < R; i++) c.push(Math.exp(-0.5 * i * i / (sigma * sigma)));
        m.uniforms.gaussianCoefficients.value = c;
    }
}

export function createPost(renderer, scene, camera, { quality = 'high' } = {}) {
    if (quality === 'off' || !renderer.capabilities.isWebGL2) {
        return {
            enabled: false,
            quality: 'off',
            render() { renderer.render(scene, camera); },
            setSize() {},
            setBloom() {},
            setSanitize() {},
            dispose() {},
        };
    }
    const w = Math.max(1, renderer.domElement.width);
    const h = Math.max(1, renderer.domElement.height);
    const rt = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        samples: quality === 'high' ? 4 : 0,
    });
    const composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(1);          // the host locks pixelRatio to 1 — see launch-vehicle-3d.js
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.55, 1.6);
    roundBloomKernels(bloom);
    sanitizeBloomInput(bloom);
    composer.addPass(bloom);
    const final = new ShaderPass(FinalShader);
    final.material.toneMapped = false;  // the pass applies the curve itself
    composer.addPass(final);
    composer.setSize(w, h);
    final.uniforms.uRes.value.set(w, h);
    let frame = 0;
    const baseStrength = 0.6;
    return {
        enabled: true,
        quality,
        bloom,
        render() {
            final.uniforms.uFrame.value = (frame++ % 64);
            composer.render();
        },
        setSize(width, height) {
            composer.setSize(width, height);
            final.uniforms.uRes.value.set(width, height);
        },
        // k ≥ 0 multiplies the resting strength (the host raises it with throttle).
        setBloom(k) { bloom.strength = baseStrength * k; },
        // Test hook ONLY: the render-health gate's negative control turns the
        // guard off to prove a non-finite pixel still blacks the frame without it.
        setSanitize(on) {
            const v = on ? 1 : 0;
            final.uniforms.uSanitize.value = v;
            bloom.materialHighPassFilter.uniforms.uSanitize.value = v;
        },
        dispose() { composer.dispose(); rt.dispose(); bloom.dispose(); final.material.dispose(); },
    };
}

// ── Floodlight beams ────────────────────────────────────────────────────────
// A faint additive cone from a lamp toward its aim point: the shaft you see
// when xenon floodlights cut through humid coastal air at night. Brightness
// peaks along the AXIS (where the sightline crosses the most lit air), so the
// fragment weight is how squarely the cone surface faces the viewer, faded
// with distance from the lamp. It is deliberately far below the bloom
// threshold: an atmosphere effect, not an emitter. `uOpacity` lets the host's
// pad fade dim it with the rest of the pad.
const BEAM_VERT = /* glsl */`
    varying float vAxial;
    varying vec3 vN;
    varying vec3 vV;
    void main() {
        vAxial = uv.y;                         // 0 at the lamp … 1 at the far end
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
    }
`;
const BEAM_FRAG = /* glsl */`
    uniform vec3 uColor;
    uniform float uIntensity;
    uniform float uOpacity;
    varying float vAxial;
    varying vec3 vN;
    varying vec3 vV;
    void main() {
        float facing = abs(dot(normalize(vN), normalize(vV)));
        float core = pow(clamp(facing, 0.0, 1.0), 2.2);
        // max(): vAxial interpolates to 1 + ε at the far rim, and pow() of a
        // negative base is undefined (NaN on real GPUs — see SANITIZE_GLSL).
        float along = pow(max(1.0 - vAxial, 0.0), 1.6) * smoothstep(0.0, 0.04, vAxial);
        float a = core * along * uIntensity * uOpacity;
        gl_FragColor = vec4(uColor * a, 1.0);
    }
`;

export function buildLightBeam(from, to, { color = 0xdfe6ff, intensity = 0.05, spread = 0.16 } = {}) {
    const len = from.distanceTo(to) * 1.15;
    // Open cone, apex at the lamp. CylinderGeometry uv.y = 1 at the top, so
    // build it top = lamp (radius ~0) and flip uv-based vAxial accordingly.
    const geo = new THREE.CylinderGeometry(0.25, len * spread, len, 28, 1, true);
    geo.translate(0, -len / 2, 0);                         // top (lamp) at origin
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    const mat = new THREE.ShaderMaterial({
        uniforms: {
            uColor: { value: new THREE.Color(color) },
            uIntensity: { value: intensity },
            uOpacity: { value: 1 },
        },
        vertexShader: BEAM_VERT,
        fragmentShader: BEAM_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'FloodBeam';
    mesh.position.copy(from);
    // Point local −Y (the cone's length) from the lamp toward the target.
    const dir = new THREE.Vector3().subVectors(to, from).normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir);
    mesh.renderOrder = 3;
    return mesh;
}
