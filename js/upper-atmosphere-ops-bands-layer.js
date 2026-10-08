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
 * occlusion test needed for the rings: the tangent point of a shell with
 * b > 1 is never behind the planet. A camera INSIDE a shell has no tangent
 * to it (b ≤ its distance < the radius), so the rings vanish on the way
 * down by geometry alone, and the pass is skipped entirely once the camera
 * is inside the lowest band edge it could still see.
 *
 * Ring width is a PIXEL footprint: the ray's closest-approach distance
 * moves by (pixel angle × range to the tangent point) per pixel, so the
 * Gaussian's σ is that times a fixed ~1.3 px — the same width at every
 * framing, which is what makes it a ruler rather than a halo.
 *
 * THE RINGS ARE LAYERS (2026-10-08). Each band can be HOVERED (its ring
 * brightens), SELECTED (the others dim to a third) and EXPANDED: a selected
 * band is drawn as a translucent shell of its TRUE extent — the kernel's
 * `shellChord` (the ray's path length through lo ≤ r ≤ hi, the full chord
 * where the ray clears the planet and the near side only where it hits
 * it), normalised by the longest chord (`shellChordMax`, the lower
 * tangent) — so it is limb-bright and thin over the disc exactly as a real
 * layer of air seen from orbit is, under a √ DISPLAY STRETCH (face-on the
 * chord is ~4 % of the limb's and the layer would not show over the disc
 * at all; the card discloses the stretch). The shader's chord is a transliteration
 * of the kernel's function; the kernel is the oracle. The expansion eases
 * on the frame clock (so the stepped-frame tests see it settle) and is
 * skipped while the camera is inside the band's upper edge.
 *
 * It computes no physics: the bands' altitudes and colours are the kernel's
 * (`OPS_BANDS`), interpolated into the shader from the table, never typed.
 */

import * as THREE from 'three';
import { OPS_BANDS, R_EARTH_KM, shellChordMax } from './upper-atmosphere-ops-bands.js';
import { frameClock } from './upper-atmosphere-frame-clock.js';

const NB = OPS_BANDS.length;
const EASE_S = 0.22;          // e-folding time of the expand / dim transitions

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
uniform float uExpand[NB];
uniform float uChordMax[NB];
uniform float uPixAng;
uniform float uRingPx;
uniform float uFill;
uniform float uGain;
uniform float uShell;
uniform float uDim;
uniform int uHover;
uniform int uSel;
varying vec3 vWorld;

// The kernel's shellChord(b, lo, hi): the ray's path through the shell on
// the camera's side of the planet. Transliterated — change both together.
float shellChord(float b, float lo, float hi) {
    if (b >= hi) return 0.0;
    float outer = sqrt(hi * hi - b * b);
    float inner = b < lo ? sqrt(lo * lo - b * b) : 0.0;
    if (b >= 1.0) return 2.0 * (outer - inner);
    float ground = sqrt(max(0.0, 1.0 - b * b));
    return outer - max(inner, ground);
}

void main() {
    vec3 o = uCam;
    vec3 d = normalize(vWorld - uCam);
    float dist = length(o);
    float tc = -dot(o, d);
    if (tc <= 0.0) { gl_FragColor = vec4(0.0); return; }
    float b = sqrt(max(0.0, dot(o, o) - tc * tc));
    float sig = max(1.0e-6, uPixAng * tc * uRingPx);
    vec3 acc = vec3(0.0);
    for (int i = 0; i < NB; i++) {
        float lo = uLo[i], hi = uHi[i];
        // Emphasis: hover brightens, a selection dims every other band.
        float w = 1.0;
        if (uSel >= 0 && uSel != i) w = uDim;
        if (uHover == i) w *= 1.8;
        // The expanded shell: the band's true extent as a translucent layer.
        float ex = uExpand[i];
        if (ex > 0.001 && hi < dist) {
            // √ DISPLAY STRETCH, disclosed in the card: face-on, a 100 km
            // layer is ~4 % of its limb chord and would not show over the
            // disc at all; the root keeps the limb brightest and lets the
            // layer read as a layer where it crosses the planet.
            float c = sqrt(shellChord(b, lo, hi) / max(1.0e-9, uChordMax[i]));
            acc += uCol[i] * (ex * uShell * c);
        }
        if (b < 1.0) continue;                       // rings and wash live off the disc
        if (lo < dist) {
            float x = (b - lo) / sig;
            acc += uCol[i] * w * exp(-0.5 * x * x);
        }
        if (i == NB - 1 && hi < dist) {
            float x = (b - hi) / sig;
            acc += uCol[i] * w * exp(-0.5 * x * x);
        }
        if (b >= lo && b < hi) acc += uCol[i] * w * uFill;
    }
    gl_FragColor = vec4(acc * uGain, 1.0);
}
`;

export class OpsBandsLayer {
    constructor(scene) {
        this._on = true;
        this._sel = -1;
        this._hover = -1;
        this._expand = new Array(NB).fill(0);       // eased weights
        this._expandTarget = new Array(NB).fill(0);
        this._lastT = null;
        const uniforms = {
            uCam:      { value: new THREE.Vector3() },
            uLo:       { value: OPS_BANDS.map(b => 1 + b.minKm / R_EARTH_KM) },
            uHi:       { value: OPS_BANDS.map(b => 1 + b.maxKm / R_EARTH_KM) },
            uCol:      { value: OPS_BANDS.map(b => new THREE.Color(b.colorHex)) },
            uExpand:   { value: new Array(NB).fill(0) },
            uChordMax: { value: OPS_BANDS.map(b => shellChordMax(1 + b.minKm / R_EARTH_KM, 1 + b.maxKm / R_EARTH_KM)) },
            uPixAng:   { value: 0.001 },
            uRingPx:   { value: 1.3 },
            uFill:     { value: 0.035 },
            uGain:     { value: 0.85 },
            uShell:    { value: 0.55 },
            uDim:      { value: 0.3 },
            uHover:    { value: -1 },
            uSel:      { value: -1 },
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

    static _index(idOrIndex) {
        if (typeof idOrIndex === 'number') return idOrIndex >= 0 && idOrIndex < NB ? idOrIndex : -1;
        if (idOrIndex == null) return -1;
        return OPS_BANDS.findIndex(b => b.id === idOrIndex);
    }
    /** Hover emphasis (index or id); null clears. */
    setHover(idOrIndex) {
        this._hover = OpsBandsLayer._index(idOrIndex);
        this._mat.uniforms.uHover.value = this._hover;
    }
    getHover() { return this._hover >= 0 ? OPS_BANDS[this._hover].id : null; }
    /**
     * Select a band: it expands into its shell, the others dim. null clears.
     * `setFocus` is the older name for the same thing.
     */
    setSelected(idOrIndex) {
        this._sel = OpsBandsLayer._index(idOrIndex);
        this._mat.uniforms.uSel.value = this._sel;
        for (let i = 0; i < NB; i++) this._expandTarget[i] = i === this._sel ? 1 : 0;
    }
    setFocus(idOrIndex) { this.setSelected(idOrIndex); }
    getSelected() { return this._sel >= 0 ? OPS_BANDS[this._sel].id : null; }
    getFocus() { return this.getSelected(); }
    /** The eased expansion weights per band (0 … 1), for gates and the ruler. */
    getExpandWeights() { return OPS_BANDS.map((b, i) => ({ id: b.id, weight: this._expand[i] })); }

    /**
     * Per frame. Skipped entirely when the camera is inside the lowest edge
     * (no shell can be seen tangentially from there) or the layer is off.
     * The expansion eases toward its target on the frame clock.
     */
    update(camera, { viewportHeight = 500 } = {}) {
        const now = frameClock.now() / 1000;
        const dt = this._lastT == null ? 0 : Math.min(0.25, Math.max(0, now - this._lastT));
        this._lastT = now;
        const k = 1 - Math.exp(-dt / EASE_S);
        const dist = camera.position.length();
        const U = this._mat.uniforms;
        for (let i = 0; i < NB; i++) {
            // No expansion while the camera is inside the band's top: the
            // chord formula assumes an outside camera (explore's membranes
            // mark the boundaries from inside).
            const target = dist > U.uHi.value[i] ? this._expandTarget[i] : 0;
            const w = this._expand[i] + (target - this._expand[i]) * k;
            this._expand[i] = Math.abs(w - target) < 1e-3 ? target : w;
            U.uExpand.value[i] = this._expand[i];
        }
        const drawn = this._on && dist > this._rLowest * 1.0005;
        this._mesh.visible = drawn;
        if (!drawn) return;
        U.uCam.value.copy(camera.position);
        U.uPixAng.value = 2 * Math.tan((camera.fov * Math.PI / 180) / 2) / Math.max(1, viewportHeight);
    }

    dispose() {
        this._mesh.parent?.remove(this._mesh);
        this._mesh.geometry.dispose();
        this._mat.dispose();
    }
}
