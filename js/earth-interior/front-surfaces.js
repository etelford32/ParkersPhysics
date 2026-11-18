/**
 * front-surfaces.js — the wavefronts as the 3-D SURFACES they are.
 * Renderer only; the curves come from quake-model.js `wavefronts`.
 *
 * WHY THIS IS PHYSICS, NOT DECORATION. PREM is spherically symmetric and a
 * point source radiates in every direction, so the wavefront at time t is
 * symmetric about the axis through the epicentre and the centre: it is the
 * slice's front curve (r(θ), drawn at angle φ from the epicentre) REVOLVED
 * about that axis. A point at (r, φ) on the curve sweeps
 *      x(ψ) = (r/R)·[cos φ·ê₁ + sin φ·(cos ψ·ê₂ + sin ψ·n̂)],  ψ ∈ [0, π]
 * where ê₁ is the epicentre, ê₂ the in-slice direction toward the viewer and
 * n̂ the slice normal — ψ = 0 is the curve in the slice, ψ = π its mirror,
 * and the half-turn between is the REMOVED half of the planet, which is the
 * only place a surface can be seen (the other half is solid). What this does
 * NOT show: the radiation pattern's variation around the axis (the source
 * term is not drawn on the surfaces) and anything 3-D in the Earth (PREM is
 * 1-D; so are the rays).
 *
 * LOOK. A glass shell: additive, view-dependent (Fresnel from the screen-space
 * normal — edges bright, a sheet seen face-on nearly clear), so the slice's
 * ribbons stay legible through it.
 */
import * as THREE from 'three';
import { sweepPoint } from './quake-model.js';

const VS = /* glsl */`
attribute vec3 aColor;
varying vec3 vColor;
varying vec3 vW;
void main() {
    vColor = aColor;
    vW = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}`;
const FS = /* glsl */`
uniform float uGain;
varying vec3 vColor;
varying vec3 vW;
void main() {
    vec3 dx = dFdx(vW), dy = dFdy(vW);
    vec3 nrm = cross(dx, dy);
    float ln = length(nrm);
    vec3 v = cameraPosition - vW;
    float lv = length(v);
    if (ln < 1e-12 || lv < 1e-6) discard;
    float f = 1.0 - abs(dot(nrm / ln, v / lv));
    float k = (0.035 + 0.55 * f * f * f) * uGain;
    gl_FragColor = vec4(vColor * k, 1.0);
}`;

export const SWEEP_STEPS = 48;

export class FrontSurfaces {
    constructor({ gain = 1 } = {}) {
        this.material = new THREE.ShaderMaterial({
            vertexShader: VS, fragmentShader: FS, uniforms: { uGain: { value: gain } },
            side: THREE.DoubleSide, transparent: true, depthTest: false, depthWrite: false,
            blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
            extensions: { derivatives: true },
        });
        this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
        this.mesh.frustumCulled = false;
    }

    /**
     * fronts: [{ points: [{ rKm, phi, wave }] }] (the +φ side only — the sweep makes the −φ side),
     * plane: { e1, e2, n }, colors: { P: [r,g,b], S: [r,g,b] }.
     */
    set(fronts, plane, colors) {
        const S = SWEEP_STEPS;
        let nv = 0, ni = 0;
        for (const f of fronts) if (f.points.length > 1) { nv += f.points.length * (S + 1); ni += 6 * (f.points.length - 1) * S; }
        const pos = new Float32Array(3 * nv), col = new Float32Array(3 * nv), idx = new Uint32Array(ni);
        let v = 0, k = 0;
        for (const f of fronts) {
            const m = f.points.length;
            if (m < 2) continue;
            const base = v;
            for (const p of f.points) {
                // quake-model.js sweepPoint: the ONE copy of the sweep (node-gated), φ past π folded back.
                const rgb = colors[p.wave];
                for (let j = 0; j <= S; j++) {
                    pos.set(sweepPoint(plane, p.rKm, p.phi, (j / S) * Math.PI), 3 * v);
                    col.set(rgb, 3 * v);
                    v++;
                }
            }
            for (let i = 0; i < m - 1; i++) {
                for (let j = 0; j < S; j++) {
                    const a = base + i * (S + 1) + j, b = a + S + 1;
                    idx[k++] = a; idx[k++] = b; idx[k++] = a + 1;
                    idx[k++] = a + 1; idx[k++] = b; idx[k++] = b + 1;
                }
            }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        this.mesh.geometry.dispose(); this.mesh.geometry = g;
    }
}
