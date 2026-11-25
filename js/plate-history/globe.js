/**
 * globe.js — the 3-D stage for plate-tectonics.html (renderer only: it draws kernel numbers).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PLATE_HISTORY_PLAN.md. Nothing here computes plate motion: positions come from
 * rotations.js (total rotations), boundaries from frames.js (boundariesAt), velocities from the
 * kernel's eulerVector. Frame: rotations.js is ECEF (x → 0°E, z → north); the scene is the repo's
 * canonical js/geo/coords.js frame (+X Greenwich, +Y north, −Z = 90°E) — `toScene` is the ONE
 * conversion, (x, y, z)_ECEF → (x, z, −y).
 *
 * HOW CONTINENTS MOVE. All continental polygons are triangulated ONCE at their PRESENT-day
 * positions (stereographic projection about the ring's own centre, earcut via three's
 * ShapeUtils, then subdivided onto the sphere) into ONE mesh whose vertices carry their plate's
 * index and valid time. Each frame the kernel's total rotation of every plate is written into a
 * 3 × N float texture (one matrix row per texel) and the vertex shader rotates each vertex by its
 * plate's matrix — so 866 polygons glide at any instant, in one draw call, exactly as the kernel
 * places them. A polygon outside its valid time is collapsed off screen.
 *
 * THE PLATES are tinted from the frame's 1° raster (held at the nearest 5 Myr frame), cells in
 * NO plate (the model's own topology gaps) are hatched, never filled with a guess.
 *
 * CAMERA: camera.up stays +Y, OrbitControls is built ONCE; the page may START a flight (Reset),
 * it never holds the camera.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GlowLines } from '../earth-interior/glow-lines.js';
import { qMatrix, unit } from './rotations.js';
import { boundariesAt, frameIndexAt, existsAt } from './frames.js';

export const toScene = (x, y, z) => [x, z, -y];
const fromScene = (x, y, z) => [x, -z, y];
const DEG = Math.PI / 180;

/** The one colour per boundary type, shared with the charts (validated on #0b1322). */
export const BOUNDARY_COLORS = {
    MidOceanRidge: '#3987e5',      // slot 1 — ridges
    SubductionZone: '#d95926',     // slot 2 — trenches
    Transform: '#199e70',          // slot 3 — transform faults
    other: '#8a91a1',              // neutral — rifts, orogens, terrane boundaries, inferred
};
export const SPEED_COLORS = { all: '#199e70', continents: '#9085e9' };

// Colours go to raw shaders that write display values (no output encode), so a pick must stay
// in sRGB — THREE.Color would decode it to LINEAR under r160's colour management and every
// colour would draw too dark.
export const hex3 = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const vec3 = (h) => new THREE.Vector3(...hex3(h));

/** A stable, muted tint per plate id (golden-ratio hues), so a plate keeps its colour through time. */
export function plateTint(pid) {
    const h = ((pid * 0.6180339887) % 1 + 1) % 1, S = 0.30, L = 0.22;
    const f = (n) => { const k = (n + h * 12) % 12, a = S * Math.min(L, 1 - L); return L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [f(0), f(8), f(4)];
}

// ── continent triangulation (present-day, once) ───────────────────────────────────────────
function triangulateRing(pts) {
    const n = pts.length / 2;
    const P = [];
    for (let i = 0; i < n; i++) P.push(unit(pts[2 * i], pts[2 * i + 1]));
    let c = [0, 0, 0];
    for (const p of P) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    const cn = Math.hypot(...c); if (!cn) return null;
    c = c.map((x) => x / cn);
    const ref = Math.abs(c[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    let e1 = [c[1] * ref[2] - c[2] * ref[1], c[2] * ref[0] - c[0] * ref[2], c[0] * ref[1] - c[1] * ref[0]];
    const n1 = Math.hypot(...e1); e1 = e1.map((x) => x / n1);
    const e2 = [c[1] * e1[2] - c[2] * e1[1], c[2] * e1[0] - c[0] * e1[2], c[0] * e1[1] - c[1] * e1[0]];
    // Stereographic from the antipode of the centre: valid for any ring short of the whole sphere.
    const contour = P.map((p) => {
        const d = 1 + p[0] * c[0] + p[1] * c[1] + p[2] * c[2];
        return new THREE.Vector2((p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2]) / d, (p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2]) / d);
    });
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(contour, []); } catch { return null; }
    return { P, tris };
}

function pushSubdivided(a, b, c, out, depth = 0) {
    const ang = (u, v) => Math.acos(Math.min(1, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]));
    const maxEdge = Math.max(ang(a, b), ang(b, c), ang(c, a));
    if (maxEdge < 2.0 * DEG || depth >= 5) { out.push(a, b, c); return; }
    const mid = (u, v) => { const m = [u[0] + v[0], u[1] + v[1], u[2] + v[2]], k = Math.hypot(...m); return m.map((x) => x / k); };
    const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
    pushSubdivided(a, ab, ca, out, depth + 1); pushSubdivided(ab, b, bc, out, depth + 1);
    pushSubdivided(ca, bc, c, out, depth + 1); pushSubdivided(ab, bc, ca, out, depth + 1);
}

const ROT_VS = /* glsl */`
uniform sampler2D uRot;
uniform float uRotN;
uniform float uT;
uniform float uLift;
attribute float aPlate;
attribute vec2 aValid;
varying vec3 vNormalV;
varying vec3 vWorld;
vec3 rowOf(float r) { return texture2D(uRot, vec2((r + 0.5) / 3.0, (aPlate + 0.5) / uRotN)).xyz; }
void main() {
    if (!(aValid.x >= uT && uT >= aValid.y)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec3 p = position;
    vec3 e = vec3(dot(rowOf(0.0), p), dot(rowOf(1.0), p), dot(rowOf(2.0), p));
    vec3 s = vec3(e.x, e.z, -e.y) * uLift;
    vWorld = s;
    vNormalV = normalize(normalMatrix * s);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(s, 1.0);
}`;
const LAND_FS = /* glsl */`
uniform vec3 uColor;
varying vec3 vNormalV;
void main() {
    float lit = 0.62 + 0.38 * max(dot(normalize(vNormalV), normalize(vec3(-0.35, 0.45, 1.0))), 0.0);
    gl_FragColor = vec4(uColor * lit, 1.0);
}`;

const OCEAN_VS = /* glsl */`
varying vec3 vObj;
varying vec3 vNormalV;
void main() {
    vObj = position;
    vNormalV = normalize(normalMatrix * position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const OCEAN_FS = /* glsl */`
uniform sampler2D uPlates;
uniform float uTint;
varying vec3 vObj;
varying vec3 vNormalV;
const float PI = 3.141592653589793;
void main() {
    vec3 s = normalize(vObj);
    vec3 e = vec3(s.x, -s.z, s.y);                          // scene → ECEF
    float lat = asin(clamp(e.z, -1.0, 1.0));
    float lon = atan(e.y, e.x);
    vec2 uv = vec2((lon + PI) / (2.0 * PI), (0.5 * PI - lat) / PI);
    vec4 pl = texture2D(uPlates, uv);
    vec3 ocean = vec3(0.035, 0.075, 0.14);
    vec3 col = mix(ocean, pl.rgb, 0.55 * uTint * pl.a);
    if (pl.a < 0.5) {                                        // NO PLATE: the model's topology gap
        float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0));
        col = mix(vec3(0.16, 0.08, 0.09), vec3(0.30, 0.14, 0.15), stripe);
    }
    float lit = 0.55 + 0.45 * max(dot(normalize(vNormalV), normalize(vec3(-0.35, 0.45, 1.0))), 0.0);
    float rim = pow(1.0 - max(dot(normalize(vNormalV), vec3(0.0, 0.0, 1.0)), 0.0), 3.0);
    gl_FragColor = vec4(col * lit + vec3(0.05, 0.10, 0.18) * rim, 1.0);
}`;

export class PlateGlobe {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{ model, fr, shapes }} data — the rotation model, decoded frames, decoded shapes
     */
    constructor(canvas, { model, fr, shapes }) {
        this.canvas = canvas; this.model = model; this.fr = fr; this.shapes = shapes;
        this.layers = { boundaries: true, velocities: true, coasts: true, tint: true, graticule: true };
        this.t = 0; this._frameIdx = -1; this._dirty = true; this._visible = true;
        this.onPick = null; this.onHover = null;

        const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
        r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        r.toneMapping = THREE.NoToneMapping;
        r.setClearColor(0x04070d, 1);
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(32, 1, 0.05, 50);
        this.home = new THREE.Vector3(...toScene(...unit(20, 10))).multiplyScalar(4.1);
        this.camera.position.copy(this.home);
        this.camera.up.set(0, 1, 0);
        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
        this.controls.enablePan = false; this.controls.minDistance = 1.45; this.controls.maxDistance = 8;
        this.controls.rotateSpeed = 0.55;
        this.controls.addEventListener('change', () => { this._dirty = true; });
        canvas.addEventListener('wheel', () => { this._userZoomed = true; }, { passive: true });
        canvas.addEventListener('touchstart', (e) => { if (e.touches.length > 1) this._userZoomed = true; }, { passive: true });

        this._buildOcean();
        this._buildContinents();
        this.lines = new GlowLines({ width: 2.2, gain: 1.15, core: 1.25 });
        this.teeth = new GlowLines({ width: 1.6, gain: 1.0, core: 1.2 });
        this.arrows = new GlowLines({ width: 1.3, gain: 0.85, core: 1.1 });
        this.grid = new GlowLines({ width: 1.0, gain: 0.5, core: 1.0 });
        for (const g of [this.grid, this.lines, this.teeth, this.arrows]) this.scene.add(g.mesh);
        this._buildGraticule();
        this._lattice = fibonacci(640);

        this._wirePointer();
        new ResizeObserver(() => this.resize()).observe(canvas);
        if ('IntersectionObserver' in window) new IntersectionObserver((es) => { this._visible = es[0].isIntersecting; }).observe(canvas);
        this.resize();
        const loop = () => {
            requestAnimationFrame(loop);
            if (!this._visible) return;
            this.controls.update();
            if (this._dirty) { this._dirty = false; this.renderer.render(this.scene, this.camera); }
        };
        requestAnimationFrame(loop);
    }

    /** Camera distance at which the whole globe (radius 1, plus a margin) fits the narrower axis. */
    fitDistance() {
        const halfV = (this.camera.fov / 2) * DEG;
        const halfH = Math.atan(Math.tan(halfV) * this.camera.aspect);
        return 1.12 / Math.sin(Math.min(halfV, halfH));
    }

    resize() {
        const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
        const dpr = this.renderer.getPixelRatio();
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
        // Until the reader zooms, the globe is framed to fit (a phone's narrow axis is the binding one).
        const fit = this.fitDistance();
        this.controls.maxDistance = Math.max(8, fit * 1.6);
        if (!this._userZoomed) { this.camera.position.setLength(fit); this.controls.update(); }
        for (const g of [this.lines, this.teeth, this.arrows, this.grid]) g.setResolution(w * dpr, h * dpr, dpr);
        this._dirty = true;
    }

    // ── static pieces ─────────────────────────────────────────────────────────────────────
    _buildOcean() {
        this.plateData = new Uint8Array(360 * 180 * 4);
        this.plateTex = new THREE.DataTexture(this.plateData, 360, 180, THREE.RGBAFormat);
        this.plateTex.magFilter = THREE.NearestFilter; this.plateTex.minFilter = THREE.NearestFilter;
        this.plateTex.flipY = false; this.plateTex.needsUpdate = true;
        this.oceanMat = new THREE.ShaderMaterial({
            vertexShader: OCEAN_VS, fragmentShader: OCEAN_FS,
            uniforms: { uPlates: { value: this.plateTex }, uTint: { value: 1.0 } },
        });
        this.ocean = new THREE.Mesh(new THREE.SphereGeometry(1, 144, 72), this.oceanMat);
        this.scene.add(this.ocean);
    }

    _buildContinents() {
        const plates = new Map();
        const idx = (pid) => { if (!plates.has(pid)) plates.set(pid, plates.size); return plates.get(pid); };
        let failed = 0;
        const fill = (list) => {
            const pos = [], plate = [], valid = [];
            for (const s of list) {
                const tri = triangulateRing(s.pts);
                if (!tri || !tri.tris.length) { failed++; continue; }
                const k = idx(s.plate), out = [];
                for (const [a, b, c] of tri.tris) pushSubdivided(tri.P[a], tri.P[b], tri.P[c], out);
                for (const v of out) { pos.push(...v); plate.push(k); valid.push(s.begin, s.end); }
            }
            return [pos, plate, valid];
        };
        // Continental crust (incl. shelves) underneath, today's land on top: filled, never outlined —
        // the coast file splits land along every terrane boundary, and outlines drew all of them.
        const crust = fill(this.shapes.continents);
        const landNow = fill(this.shapes.coasts);
        this.triangulationFailures = failed;
        this.platesIndex = [...plates.keys()];
        const N = this.platesIndex.length;
        this.rotData = new Float32Array(3 * N * 4);
        this.rotTex = new THREE.DataTexture(this.rotData, 3, N, THREE.RGBAFormat, THREE.FloatType);
        this.rotTex.magFilter = THREE.NearestFilter; this.rotTex.minFilter = THREE.NearestFilter; this.rotTex.needsUpdate = true;
        const uniforms = (color, lift, alpha = 1) => ({
            uRot: { value: this.rotTex }, uRotN: { value: N }, uT: { value: 0 }, uLift: { value: lift },
            uColor: { value: vec3(color) }, uAlpha: { value: alpha },
        });
        const geo = (P, K, V) => {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
            g.setAttribute('aPlate', new THREE.Float32BufferAttribute(K, 1));
            g.setAttribute('aValid', new THREE.Float32BufferAttribute(V, 2));
            return g;
        };
        this.crustMat = new THREE.ShaderMaterial({ vertexShader: ROT_VS, fragmentShader: LAND_FS, uniforms: uniforms('#5e5543', 1.0012) });
        this.crust = new THREE.Mesh(geo(...crust), this.crustMat);
        this.landMat = new THREE.ShaderMaterial({ vertexShader: ROT_VS, fragmentShader: LAND_FS, uniforms: uniforms('#a99472', 1.0022) });
        this.land = new THREE.Mesh(geo(...landNow), this.landMat);
        this.crust.frustumCulled = false; this.land.frustumCulled = false;
        this.scene.add(this.crust, this.land);
    }

    _buildGraticule() {
        const lines = [];
        for (let lat = -60; lat <= 60; lat += 30) {
            const pts = [];
            for (let lon = -180; lon <= 180; lon += 3) pts.push(toScene(...unit(lat, lon)).map((x) => x * 1.003));
            lines.push({ points: pts, color: lat === 0 ? [0.55, 0.62, 0.74] : [0.26, 0.31, 0.40], alpha: lat === 0 ? 0.9 : 0.6 });
        }
        for (let lon = -180; lon < 180; lon += 30) {
            const pts = [];
            for (let lat = -88; lat <= 88; lat += 3) pts.push(toScene(...unit(lat, lon)).map((x) => x * 1.003));
            lines.push({ points: pts, color: [0.18, 0.22, 0.29], alpha: 0.45 });
        }
        this.grid.set(lines);
    }

    // ── time ──────────────────────────────────────────────────────────────────────────────
    setLayer(name, on) {
        this.layers[name] = on;
        this.land.visible = this.layers.coasts;
        this.grid.mesh.visible = this.layers.graticule;
        this.oceanMat.uniforms.uTint.value = this.layers.tint ? 1 : 0;
        this._rebuildDynamic();
        this._dirty = true;
    }

    setTime(t) {
        this.t = t;
        const { model } = this;
        for (let i = 0; i < this.platesIndex.length; i++) {
            const m = qMatrix(model.total(this.platesIndex[i], t));
            this.rotData.set([m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0], 12 * i);
        }
        this.rotTex.needsUpdate = true;
        this.landMat.uniforms.uT.value = t; this.crustMat.uniforms.uT.value = t;
        const fi = frameIndexAt(this.fr, t);
        if (fi !== this._frameIdx) { this._frameIdx = fi; this._paintPlates(this.fr.frames[fi]); }
        this._rebuildDynamic();
        this._dirty = true;
    }

    _paintPlates(frame) {
        const tints = frame.plates.map((p) => plateTint(p.p));
        const d = this.plateData;
        for (let k = 0; k < frame.raster.length; k++) {
            const v = frame.raster[k];
            if (v === 255) { d[4 * k] = d[4 * k + 1] = d[4 * k + 2] = 0; d[4 * k + 3] = 0; continue; }
            const c = tints[v];
            d[4 * k] = c[0] * 255; d[4 * k + 1] = c[1] * 255; d[4 * k + 2] = c[2] * 255; d[4 * k + 3] = 255;
        }
        this.plateTex.needsUpdate = true;
    }

    _rebuildDynamic() {
        const { model, fr, t } = this;
        // Boundaries — each piece carried by its feature's own rotation (frames.js).
        const lines = [], teeth = [];
        if (this.layers.boundaries) {
            const { segs } = boundariesAt(model, fr, t);
            this.currentSegs = segs;
            for (const s of segs) {
                const key = BOUNDARY_COLORS[s.type] ? s.type : 'other';
                const col = hex3(BOUNDARY_COLORS[key]);
                const pts = [];
                for (let j = 0; j < s.xyz.length; j += 3) pts.push(toScene(s.xyz[j], s.xyz[j + 1], s.xyz[j + 2]).map((x) => x * 1.004));
                lines.push({ points: pts, color: col, alpha: key === 'other' ? 0.55 : 1 });
                if (s.type === 'SubductionZone' && (s.over === s.left || s.over === s.right)) addTeeth(s, col, teeth);
            }
        } else this.currentSegs = [];
        this.lines.set(lines); this.teeth.set(teeth);
        // Velocities — a fixed lattice; each point moves with the plate under it in this frame.
        const arrows = [];
        if (this.layers.velocities) {
            const frame = fr.frames[frameIndexAt(fr, t)];
            const W = new Map();
            for (const [lat, lon] of this._lattice) {
                const pl = plateUnder(fr, frame, lat, lon);
                if (!pl) continue;
                if (!W.has(pl.p)) W.set(pl.p, model.eulerVector(pl.p, t));
                const w = W.get(pl.p);
                if (!Number.isFinite(w[0])) continue;
                const arrow = arrowFor(w, lat, lon);
                if (arrow) arrows.push(...arrow);
            }
        }
        this.arrows.set(arrows);
    }

    // ── pointer: analytic ray–sphere, never a mesh raycast ───────────────────────────────
    _wirePointer() {
        const ray = new THREE.Raycaster();
        const hit = (ev) => {
            const r = this.canvas.getBoundingClientRect();
            const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
            ray.setFromCamera(ndc, this.camera);
            const o = ray.ray.origin, d = ray.ray.direction;
            const b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c;
            if (disc < 0) return null;
            const s = -b - Math.sqrt(disc);
            if (s < 0) return null;
            const p = o.clone().addScaledVector(d, s);
            const e = fromScene(p.x, p.y, p.z);
            return { lat: Math.asin(Math.max(-1, Math.min(1, e[2]))) / DEG, lon: Math.atan2(e[1], e[0]) / DEG };
        };
        let down = null, last = 0;
        this.canvas.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp }; });
        this.canvas.addEventListener('pointerup', (ev) => {
            if (down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 6 && ev.timeStamp - down.t < 600) {
                const h = hit(ev); if (h && this.onPick) this.onPick(h);
            }
            down = null;
        });
        this.canvas.addEventListener('pointermove', (ev) => {
            if (ev.timeStamp - last < 50 || ev.buttons) return;
            last = ev.timeStamp;
            if (this.onHover) this.onHover(hit(ev));
        });
        this.canvas.addEventListener('pointerleave', () => { if (this.onHover) this.onHover(null); });
    }

    /** One-shot: back to the opening view (never held). */
    resetView() {
        this._userZoomed = false;
        this.camera.position.copy(this.home).setLength(this.fitDistance()); this.controls.target.set(0, 0, 0); this.controls.update(); this._dirty = true;
    }
    /** Look at (lat, lon) from the current distance (one-shot — the page starts it, never holds it). */
    lookAt(lat, lon) {
        this.home.set(...toScene(...unit(lat, lon)));
        const d = this.camera.position.length();
        this.camera.position.set(...toScene(...unit(lat, lon))).multiplyScalar(d);
        this.controls.update(); this._dirty = true;
    }
    /** Continents existing at the current time, with their names (for the probe). */
    continentsAt(t = this.t) { return this.shapes.continents.filter((s) => existsAt(s, t)); }
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────
function fibonacci(n) {
    const out = [], g = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
        const z = 1 - (2 * (i + 0.5)) / n;
        out.push([Math.asin(z) / DEG, ((((i * g) / DEG) % 360) + 540) % 360 - 180]);
    }
    return out;
}

function plateUnder(fr, frame, lat, lon) {
    const d = fr.rasterDeg, nc = 360 / d;
    const r = Math.min(180 / d - 1, Math.max(0, Math.floor((90 - lat) / d)));
    const c = Math.min(nc - 1, Math.floor((lon + 180) / d));
    const k = frame.raster[r * nc + c];
    return k === 255 ? null : frame.plates[k];
}

/** Arrow on the sphere from (lat, lon) along the plate velocity; length ∝ speed (100 mm/yr → 4.5°). */
const ARROW_DEG_PER_MMYR = 0.045;
function arrowFor(w, lat, lon) {
    const p = unit(lat, lon);
    const v = [w[1] * p[2] - w[2] * p[1], w[2] * p[0] - w[0] * p[2], w[0] * p[1] - w[1] * p[0]];   // rad/Myr on the unit sphere
    const speed = Math.hypot(...v) * 6371;                                                           // mm/yr
    if (!(speed > 1)) return null;
    const dir = v.map((x) => x / Math.hypot(...v));
    const L = Math.min(9, speed * ARROW_DEG_PER_MMYR) * DEG;
    const at = (s, side = 0) => {
        const q = [p[0] * Math.cos(s) + dir[0] * Math.sin(s), p[1] * Math.cos(s) + dir[1] * Math.sin(s), p[2] * Math.cos(s) + dir[2] * Math.sin(s)];
        if (!side) return q;
        const n = [q[1] * dir[2] - q[2] * dir[1], q[2] * dir[0] - q[0] * dir[2], q[0] * dir[1] - q[1] * dir[0]];
        const back = [q[0] - dir[0] * L * 0.3, q[1] - dir[1] * L * 0.3, q[2] - dir[2] * L * 0.3];
        const r = back.map((x, i) => x + n[i] * side * L * 0.22), k = Math.hypot(...r);
        return r.map((x) => x / k);
    };
    const lift = (q) => toScene(...q).map((x) => x * 1.006);
    const steps = 6, shaft = [];
    for (let i = 0; i <= steps; i++) shaft.push(lift(at((L * i) / steps)));
    const tip = lift(at(L));
    const a = Math.min(1, 0.35 + speed / 120);
    const col = [0.92, 0.94, 0.97];
    return [
        { points: shaft, color: col, alpha: a },
        { points: [lift(at(L, 1)), tip, lift(at(L, -1))], color: col, alpha: a },
    ];
}

/** Trench teeth: short ticks every ~350 km pointing INTO the overriding plate. */
function addTeeth(s, col, out) {
    const xyz = s.xyz, toLeft = s.over === s.left;
    let acc = 0;
    for (let j = 0; j + 5 < xyz.length; j += 3) {
        const a = [xyz[j], xyz[j + 1], xyz[j + 2]], b = [xyz[j + 3], xyz[j + 4], xyz[j + 5]];
        const len = Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 6371;
        const spacing = 350;
        let d = spacing - acc;
        while (d <= len) {
            const f = d / len;
            const m = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
            const mk = Math.hypot(...m); const r = m.map((x) => x / mk);
            const tan = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
            let nl = [r[1] * tan[2] - r[2] * tan[1], r[2] * tan[0] - r[0] * tan[2], r[0] * tan[1] - r[1] * tan[0]];
            const nk = Math.hypot(...nl); nl = nl.map((x) => (toLeft ? x : -x) / nk);
            const tip = r.map((x, i) => x + nl[i] * 0.012), tk = Math.hypot(...tip);
            out.push({ points: [toScene(...r).map((x) => x * 1.004), toScene(...tip.map((x) => x / tk)).map((x) => x * 1.004)], color: col, alpha: 0.95 });
            d += spacing;
        }
        acc = (acc + len) % spacing;
    }
}
