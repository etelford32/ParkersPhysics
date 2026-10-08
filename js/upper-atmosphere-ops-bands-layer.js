/**
 * upper-atmosphere-ops-bands-layer.js — the operational bands on the limb
 * ═══════════════════════════════════════════════════════════════════════════
 * three.js half of js/upper-atmosphere-ops-bands.js. Draws the band table
 * as a RULER on the planet's limb: a thin coloured ring where each band
 * edge's shell is seen tangentially, and a faint wash of the band's colour
 * between its edges, so an operator can read "that is the station band,
 * that is the constellation shell" straight off the render, from any
 * orbit-view framing, without a legend.
 *
 * It is ANALYTIC, the way explore mode's membranes are (plan §9.6): one
 * pass on a bounding sphere; the fragment shader computes each view ray's
 * closest approach b to the planet centre and lights a ring where b equals
 * a shell radius. No tessellated shell (a sphere's silhouette shows its
 * facets exactly where this ring sits), no `pow(rim, n)` on a back face
 * (identically 1 — the SOLAR_SYSTEM_VISUAL_REVIEW S3 scar), and no
 * occlusion test needed: the tangent point of a shell with b > 1 is never
 * behind the planet. A camera INSIDE a shell has no tangent to it (b ≤ its
 * distance < the radius), so the rings vanish on the way down by geometry
 * alone, and the pass is skipped entirely once the camera is inside the
 * lowest band edge it could still see.
 *
 * Ring width is a PIXEL footprint: the ray's closest-approach distance
 * moves by (pixel angle × range to the tangent point) per pixel, so the
 * Gaussian's σ is that times a fixed ~1.3 px — the same width at every
 * framing, which is what makes it a ruler rather than a halo.
 *
 * It computes no physics: the bands' altitudes and colours are the kernel's
 * (`OPS_BANDS`), interpolated into the shader from the table, never typed.
 */

import * as THREE from 'three';
import { OPS_BANDS, R_EARTH_KM } from './upper-atmosphere-ops-bands.js';

const NB = OPS_BANDS.length;

const VERT = /* glsl */`
varying vec3 vWorld;
void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// NB is the kernel's band count, never typed.
const FRAG = /* glsl */`
#define NB ${NB}
uniform vec3 uCam;
uniform float uLo[NB];
uniform float uHi[NB];
uniform vec3 uCol[NB];
uniform float uPixAng;
uniform float uRingPx;
uniform float uFill;
uniform float uGain;
uniform int uFocus;
varying vec3 vWorld;

void main() {
    vec3 o = uCam;
    vec3 d = normalize(vWorld - uCam);
    float dist = length(o);
    // Closest approach of the ray to the planet centre, and the range to it.
    float tc = -dot(o, d);
    float b = sqrt(max(0.0, dot(o, o) - tc * tc));
    if (tc <= 0.0 || b < 1.0) { gl_FragColor = vec4(0.0); return; }
    // One pixel of ray rotation moves the closest-approach point by about
    // pixAng * range along the sightline's normal.
    float sig = max(1.0e-6, uPixAng * tc * uRingPx);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < NB; i++) {
        float lo = uLo[i], hi = uHi[i];
        // Rings on both edges of the band; a shared edge is drawn once per
        // band because each band owns its LOWER edge and the top band both.
        float w = 1.0;
        if (uFocus >= 0 && uFocus != i) w = 0.35;
        if (lo < dist) {
            float x = (b - lo) / sig;
            acc += uCol[i] * w * exp(-0.5 * x * x);
        }
        if (i == NB - 1 && hi < dist) {
            float x = (b - hi) / sig;
            acc += uCol[i] * w * exp(-0.5 * x * x);
        }
        // The wash between the edges, from the limb inward.
        if (b >= lo && b < hi) acc += uCol[i] * w * uFill;
    }
    gl_FragColor = vec4(acc * uGain, 1.0);
}
`;

export class OpsBandsLayer {
    constructor(scene) {
        this._on = true;
        this._focus = -1;
        const uniforms = {
            uCam:    { value: new THREE.Vector3() },
            uLo:     { value: OPS_BANDS.map(b => 1 + b.minKm / R_EARTH_KM) },
            uHi:     { value: OPS_BANDS.map(b => 1 + b.maxKm / R_EARTH_KM) },
            uCol:    { value: OPS_BANDS.map(b => new THREE.Color(b.colorHex)) },
            uPixAng: { value: 0.001 },
            uRingPx: { value: 1.3 },
            uFill:   { value: 0.035 },
            uGain:   { value: 0.85 },
            uFocus:  { value: -1 },
        };
        this._mat = new THREE.ShaderMaterial({
            vertexShader: VERT, fragmentShader: FRAG, uniforms,
            side: THREE.BackSide, transparent: true,
            depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
        });
        // Bounding sphere just outside the top band so every tangent ray to
        // it is covered from any orbit-view camera; a camera inside it sees
        // the back faces all around, which is also what we want.
        const rBound = 1 + (OPS_BANDS[NB - 1].maxKm + 120) / R_EARTH_KM;
        this._mesh = new THREE.Mesh(new THREE.SphereGeometry(rBound, 48, 24), this._mat);
        this._mesh.frustumCulled = false;
        this._mesh.renderOrder = 3;
        this._mesh.visible = false;
        this._mesh.name = 'ops-bands';
        this._mesh.userData = { kind: 'ops-bands' };
        scene.add(this._mesh);
        this._rLowest = 1 + OPS_BANDS[0].minKm / R_EARTH_KM;
    }

    get mesh() { return this._mesh; }
    setVisible(on) { this._on = !!on; if (!on) this._mesh.visible = false; }
    getVisible() { return this._on; }
    isDrawn() { return this._mesh.visible; }
    /** Highlight one band (index or id) and dim the rest; null clears. */
    setFocus(idOrIndex) {
        const i = typeof idOrIndex === 'number' ? idOrIndex
            : idOrIndex == null ? -1 : OPS_BANDS.findIndex(b => b.id === idOrIndex);
        this._focus = i >= 0 && i < NB ? i : -1;
        this._mat.uniforms.uFocus.value = this._focus;
    }
    getFocus() { return this._focus >= 0 ? OPS_BANDS[this._focus].id : null; }

    /**
     * Per frame. Skipped entirely when the camera is inside the lowest edge
     * (no shell can be seen tangentially from there) or the layer is off.
     */
    update(camera, { viewportHeight = 500 } = {}) {
        const dist = camera.position.length();
        const drawn = this._on && dist > this._rLowest * 1.0005;
        this._mesh.visible = drawn;
        if (!drawn) return;
        const U = this._mat.uniforms;
        U.uCam.value.copy(camera.position);
        U.uPixAng.value = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) / Math.max(1, viewportHeight);
    }

    dispose() {
        this._mesh.parent?.remove(this._mesh);
        this._mesh.geometry.dispose();
        this._mat.dispose();
    }
}
