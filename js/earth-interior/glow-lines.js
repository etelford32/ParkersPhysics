/**
 * glow-lines.js — constant SCREEN-width glowing polylines for the Inner Earth
 * stage (renderer only; it draws whatever points it is handed).
 *
 * WHY. WebGL draws GL_LINES one pixel wide on every driver that matters, so
 * the live view's rays and wavefronts were hairlines and the fronts had to be
 * propped up with a dot at every vertex — a chain of beads. Each polyline here
 * is a triangle strip expanded in CLIP space (the js/screen-line.js idea): the
 * width is pixels whatever the zoom, joins are MITRED from both neighbours so
 * consecutive segments never overlap (overlap under additive blending is what
 * made beads), and the cross-section is a bright core in a soft glow.
 *
 * Blending is ADDITIVE and premultiplied, so crossing waves brighten where
 * they meet, and values above 1 feed the stage's bloom. Depth test is off:
 * every line lies in the slice plane or on the surface, drawn over the cut.
 *
 * NaN GUARD (the launch-planner black-stage scar): every normalize() is of a
 * vector whose length is tested first, and the mitre is clamped, so a
 * duplicated or coincident point can never produce a non-finite vertex.
 */
import * as THREE from 'three';

const VS = /* glsl */`
attribute vec3 aPrev;
attribute vec3 aNext;
attribute float aSide;
attribute vec3 aColor;
attribute float aAlpha;
attribute float aDist;
uniform vec2 uRes;
uniform float uWidth;
varying float vSide;
varying vec3 vColor;
varying float vAlpha;
varying float vDist;
vec2 toScreen(vec4 c) { return c.xy / max(c.w, 1e-6) * 0.5 * uRes; }
vec2 safeDir(vec2 d, vec2 fallback) { float l = length(d); return l > 1e-5 ? d / l : fallback; }
void main() {
    mat4 pmv = projectionMatrix * modelViewMatrix;
    vec4 c = pmv * vec4(position, 1.0);
    vec2 s = toScreen(c), sp = toScreen(pmv * vec4(aPrev, 1.0)), sn = toScreen(pmv * vec4(aNext, 1.0));
    vec2 d2 = safeDir(sn - s, vec2(1.0, 0.0));
    vec2 d1 = safeDir(s - sp, d2);
    d2 = safeDir(sn - s, d1);
    vec2 t = safeDir(d1 + d2, d1);
    vec2 nrm = vec2(-t.y, t.x);
    float miter = 1.0 / max(dot(nrm, vec2(-d1.y, d1.x)), 0.4);
    vec2 off = nrm * uWidth * aSide * miter;
    c.xy += off / (0.5 * uRes) * c.w;
    gl_Position = c;
    vSide = aSide; vColor = aColor; vAlpha = aAlpha; vDist = aDist;
}`;

const FS = /* glsl */`
uniform float uGain;
uniform float uCore;
uniform float uDash;
varying float vSide;
varying vec3 vColor;
varying float vAlpha;
varying float vDist;
void main() {
    if (uDash > 0.0 && fract(vDist / uDash) > 0.55) discard;
    float x = abs(vSide);
    float core = exp(-x * x * 18.0);           // the bright line
    float glow = (1.0 - x) * (1.0 - x);        // the halo, to the ribbon's edge
    float k = (uCore * core + 0.45 * glow) * vAlpha * uGain;
    gl_FragColor = vec4(vColor * k, 1.0);
}`;

export class GlowLines {
    /**
     * @param {object} o
     * @param {number} o.width   half-width of the ribbon, CSS px (the core is ~1/3 of it)
     * @param {number} o.gain    overall brightness (values > 1 bloom)
     * @param {number} o.core    core-to-glow ratio
     * @param {number} o.dash    dash period in world units (0 = solid)
     */
    constructor({ width = 3, gain = 1, core = 1.2, dash = 0 } = {}) {
        this.width = width;
        this.material = new THREE.ShaderMaterial({
            vertexShader: VS, fragmentShader: FS,
            uniforms: { uRes: { value: new THREE.Vector2(1, 1) }, uWidth: { value: width }, uGain: { value: gain }, uCore: { value: core }, uDash: { value: dash } },
            // DoubleSide: a strip's winding is fixed relative to its direction of travel, so with
            // back-face culling EVERY ribbon was culled (measured: geometry present, nothing drawn).
            side: THREE.DoubleSide,
            transparent: true, depthTest: false, depthWrite: false,
            blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        });
        this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
        this.mesh.frustumCulled = false;
    }

    /** Drawing-buffer size (px) and device-pixel ratio; call on every resize. */
    setResolution(w, h, dpr = 1) {
        this.material.uniforms.uRes.value.set(w, h);
        this.material.uniforms.uWidth.value = this.width * dpr;
    }

    /**
     * lines: [{ points: [[x,y,z], …], color: [r,g,b] | colors: [[r,g,b], …], alpha: a | alphas: [a, …] }]
     * A line with fewer than two points is skipped.
     */
    set(lines) {
        let nv = 0, ni = 0;
        for (const l of lines) if (l.points.length > 1) { nv += 2 * l.points.length; ni += 6 * (l.points.length - 1); }
        const pos = new Float32Array(3 * nv), prev = new Float32Array(3 * nv), next = new Float32Array(3 * nv);
        const side = new Float32Array(nv), col = new Float32Array(3 * nv), alp = new Float32Array(nv), dist = new Float32Array(nv);
        const idx = new Uint32Array(ni);
        let v = 0, k = 0;
        for (const l of lines) {
            const P = l.points, n = P.length;
            if (n < 2) continue;
            let acc = 0;
            for (let i = 0; i < n; i++) {
                const p = P[i], a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)];
                if (i > 0) acc += Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]);
                const c = l.colors ? l.colors[i] : l.color, al = l.alphas ? l.alphas[i] : (l.alpha ?? 1);
                for (const sd of [-1, 1]) {
                    pos.set(p, 3 * v); prev.set(a, 3 * v); next.set(b, 3 * v);
                    side[v] = sd; col.set(c, 3 * v); alp[v] = al; dist[v] = acc;
                    v++;
                }
                if (i < n - 1) {
                    const b0 = v - 2;
                    idx.set([b0, b0 + 1, b0 + 2, b0 + 1, b0 + 3, b0 + 2], k); k += 6;
                }
            }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('aPrev', new THREE.BufferAttribute(prev, 3));
        g.setAttribute('aNext', new THREE.BufferAttribute(next, 3));
        g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
        g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
        g.setAttribute('aAlpha', new THREE.BufferAttribute(alp, 1));
        g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        this.mesh.geometry.dispose(); this.mesh.geometry = g;
    }

    dispose() { this.mesh.geometry.dispose(); this.material.dispose(); }
}

/** Soft additive glow POINTS with a per-point size (CSS px) and colour; values > 1 bloom. */
const PT_VS = /* glsl */`
attribute float aSize;
attribute vec3 aColor;
uniform float uDpr;
varying vec3 vColor;
void main() {
    vColor = aColor;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = aSize * uDpr;
}`;
const PT_FS = /* glsl */`
varying vec3 vColor;
void main() {
    vec2 q = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(q, q);
    if (r2 > 1.0) discard;
    float k = exp(-r2 * 7.0) * 1.4 + (1.0 - r2) * 0.25;
    gl_FragColor = vec4(vColor * k, 1.0);
}`;

export class GlowPoints {
    constructor() {
        this.material = new THREE.ShaderMaterial({
            vertexShader: PT_VS, fragmentShader: PT_FS, uniforms: { uDpr: { value: 1 } },
            transparent: true, depthTest: false, depthWrite: false,
            blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
        });
        this.points = new THREE.Points(new THREE.BufferGeometry(), this.material);
        this.points.frustumCulled = false;
    }
    setDpr(dpr) { this.material.uniforms.uDpr.value = dpr; }
    /** pts: [{ p: [x,y,z], size, color: [r,g,b] }] */
    set(pts) {
        const pos = new Float32Array(3 * pts.length), size = new Float32Array(pts.length), col = new Float32Array(3 * pts.length);
        pts.forEach((o, i) => { pos.set(o.p, 3 * i); size[i] = o.size; col.set(o.color, 3 * i); });
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
        g.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
        this.points.geometry.dispose(); this.points.geometry = g;
    }
}
