/**
 * stage-fx.js — the Inner Earth stage's post chain: RenderPass → bloom → ONE
 * final pass (sanitize → soft shoulder → vignette → TPDF dither).
 *
 * COLOUR. The stage's raw shaders write DISPLAY bytes (a cut-face pixel IS
 * its legend colour), so there is no tone curve and no sRGB encode here: the
 * final pass is the identity below 0.85 on each channel and only rolls off the
 * glows above it (the ribbons and packets are deliberately > 1 so they bloom).
 * Built-in materials render into the half-float target in their linear
 * working space, which is why the stage gives its sprites NoColorSpace
 * colours and NoColorSpace textures — they then pass through raw, like the
 * shaders.
 *
 * NaN. The launch planner's black-stage fix is reused, not copied:
 * `sanitizeBloomInput` puts its bit-test into the bloom's bright pass, and the
 * final pass runs the same `SANITIZE_GLSL`, so one bad pixel can never be
 * smeared across the frame (js/launch-scene-fx.js header).
 *
 * QUALITY. high = bloom; low = the final pass only (a software rasteriser —
 * bloom's mip chain costs seconds a frame on SwiftShader); off = a direct
 * render. `?eifx=high|low|off` overrides.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SANITIZE_GLSL, sanitizeBloomInput, roundBloomKernels } from '../launch-scene-fx.js';

export function detectStageQuality(renderer, search = '') {
    const q = new URLSearchParams(search).get('eifx');
    if (q === 'off' || q === '0') return 'off';
    if (q === 'high' || q === 'low') return q;
    if (!renderer.capabilities.isWebGL2) return 'off';
    let name = '';
    try {
        const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
        name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
    } catch (_) { /* privacy-hardened browsers */ }
    return /swiftshader|llvmpipe|software|basic render/i.test(name) ? 'low' : 'high';
}

const FINAL = {
    uniforms: { tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uVignette: { value: 0.35 } },
    vertexShader: /* glsl */`
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform vec2 uRes;
        uniform float uVignette;
        varying vec2 vUv;
        ${SANITIZE_GLSL}
        float shoulder(float x) { return x < 0.85 ? x : 0.85 + 0.15 * (1.0 - exp(-(x - 0.85) / 0.15)); }
        float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        void main() {
            vec3 c = lpSanitize(texture2D(tDiffuse, vUv).rgb);
            c = vec3(shoulder(c.r), shoulder(c.g), shoulder(c.b));
            vec2 q = vUv - 0.5;
            c *= 1.0 - uVignette * smoothstep(0.25, 0.85, dot(q, q) * 2.2);
            float d = hash(gl_FragCoord.xy) + hash(gl_FragCoord.yx + 17.0) - 1.0;   // TPDF, ±1 LSB
            gl_FragColor = vec4(c + d / 255.0, 1.0);
        }`,
};

export function createStagePost(renderer, scene, camera, { quality = 'high' } = {}) {
    if (quality === 'off') {
        return { quality, render() { renderer.render(scene, camera); }, setSize() {}, dispose() {} };
    }
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    let bloom = null;
    if (quality === 'high') {
        bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.45, 0.9);
        sanitizeBloomInput(bloom);
        roundBloomKernels(bloom);
        composer.addPass(bloom);
    }
    const final = new ShaderPass(FINAL);
    composer.addPass(final);
    return {
        quality, bloom,
        render() { composer.render(); },
        setSize(w, h, dpr) {
            composer.setPixelRatio(dpr); composer.setSize(w, h);
            final.uniforms.uRes.value.set(w * dpr, h * dpr);
        },
        dispose() { composer.dispose?.(); },
    };
}
