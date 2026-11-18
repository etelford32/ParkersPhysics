/**
 * stage.js — the earth-interior.html 3D cutaway. Renderer only: every colour
 * on a cut face is a texel of page-model.js `radialTable` (sampled from the
 * PREM / Grayver kernels), every marker position is the observatory feed's
 * own coordinate. Nothing here computes physics.
 *
 * GEOMETRY. Radii are TRUE: Earth 1.0, CMB 0.546, inner core 0.192. The
 * northern octant over lon [CUT_LON0, CUT_LON0 + 90°] is removed: the surface
 * shader DISCARDS it and three quarter-disks (two meridional, one equatorial)
 * close the solid. That sector (North Atlantic / Europe) holds none of the
 * USGS observatories, so no live marker ever falls into the hole.
 *
 * FRAME. The canonical js/geo/coords.js frame (+X Greenwich, +Y north,
 * −Z = 90°E). The surface samples the map through GEO_GLSL `normalToUVMip`
 * from the fragment's own direction — never a mesh UV (three's sphere UVs
 * name the antipode in this frame: the EarthView scar).
 *
 * SLICE. For a live earthquake the cut is the great-circle PLANE through the
 * epicentre, the viewer and the centre (every ray between them lies in it):
 * the surface shader discards the +n half and one disk closes the solid
 * (`setSlice`). The planet never spins: the frame is Earth-fixed and only the
 * user moves the camera.
 *
 * CAMERA. The TIGA rule: the page may START a flight (presets), never HOLD
 * the camera — a preset is a one-shot tween any drag/wheel cancels. camera.up
 * stays +Y, so OrbitControls is built once and never rebuilt.
 *
 * COLOUR. Raw ShaderMaterials write sRGB bytes straight through (no tone
 * mapping, textures read as NoColorSpace), so a face pixel IS the legend's
 * colour and the map is the file's colour.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GEO_GLSL } from '../geo/coords.glsl.js';
import { R_EARTH_KM } from './prem.js';
import { BOUNDARY_RADII_KM } from './page-model.js';

export const CUT_LON0_DEG = -40;
export const CUT_SPAN_DEG = 90;

/** latLon (deg) → canonical unit vector. Mirrors GEO_GLSL latLonToNormal. */
export function latLonToVec(latDeg, lonDeg) {
    const la = latDeg * Math.PI / 180, lo = lonDeg * Math.PI / 180, c = Math.cos(la);
    return new THREE.Vector3(c * Math.cos(lo), Math.sin(la), -c * Math.sin(lo));
}
/** Is (lat, lon) inside the removed octant? Mirrors the shader's test. */
export function inCut(latDeg, lonDeg) {
    if (latDeg < 0) return false;
    const d = ((lonDeg - CUT_LON0_DEG) % 360 + 360) % 360;
    return d <= CUT_SPAN_DEG;
}

const SURFACE_VS = /* glsl */`
varying vec3 vDir;
void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const SURFACE_FS = /* glsl */`
#define GEO_SEAMLESS
${GEO_GLSL}
uniform sampler2D uMap;
uniform float uHasMap;
uniform vec3 uLight;
uniform float uCutLon0;
uniform float uCutSpan;
uniform float uCutMode;     // 0: the octant; 1: a great-circle SLICE (the half on the +uCutN side removed)
uniform vec3 uCutN;
varying vec3 vDir;
void main() {
    vec3 n = normalize(vDir);
    vec2 ll = normalToLatLon(n);
    if (uCutMode > 0.5) {
        if (dot(n, uCutN) > 0.0) discard;
    } else {
        float d = mod(ll.y - uCutLon0 + 4.0 * GEO_TAU, GEO_TAU);
        if (ll.x >= 0.0 && d <= uCutSpan) discard;
    }
    vec3 base = uHasMap > 0.5 ? texture2D(uMap, normalToUVMip(n)).rgb : vec3(0.09, 0.16, 0.26);
    float lit = 0.62 + 0.38 * max(dot(n, uLight), 0.0);
    gl_FragColor = vec4(base * lit, 1.0);
}`;

const FACE_VS = /* glsl */`
varying vec3 vPos;
void main() {
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FACE_FS = /* glsl */`
uniform sampler2D uRadial;
uniform float uBounds[${BOUNDARY_RADII_KM.length}];
uniform float uProbeR;
uniform float uShade;
uniform float uLine;
varying vec3 vPos;
void main() {
    float r = length(vPos);
    vec3 c = texture2D(uRadial, vec2(clamp(r, 0.0, 1.0), 0.5)).rgb * uShade;
    float w = fwidth(r);
    float line = 0.0;
    for (int i = 0; i < ${BOUNDARY_RADII_KM.length}; i++) {
        line = max(line, 1.0 - smoothstep(0.5 * w, 1.6 * w, abs(r - uBounds[i])));
    }
    c = mix(c, vec3(0.94, 0.94, 0.92), uLine * line);
    if (uProbeR >= 0.0) {
        float pr = 1.0 - smoothstep(0.6 * w, 2.0 * w, abs(r - uProbeR));
        c = mix(c, vec3(0.851, 0.349, 0.149), pr);
    }
    gl_FragColor = vec4(c, 1.0);
}`;

/** A quarter-disk spanned by unit vectors u (θ = 0) and v (θ = 90°). */
function quarterDisk(u, v, seg = 128) {
    const pos = [0, 0, 0], idx = [];
    for (let i = 0; i <= seg; i++) {
        const t = (i / seg) * Math.PI / 2;
        const p = u.clone().multiplyScalar(Math.cos(t)).add(v.clone().multiplyScalar(Math.sin(t)));
        pos.push(p.x, p.y, p.z);
        if (i > 0) idx.push(0, i, i + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
}

function markerTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.beginPath(); x.arc(32, 32, 26, 0, Math.PI * 2); x.fillStyle = '#ffffff'; x.fill();
    x.lineWidth = 6; x.strokeStyle = '#0b1322'; x.stroke();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace;
    return t;
}

export class InteriorStage {
    constructor(canvas, { onHover = () => {}, onPick = () => {}, labelLayer = null } = {}) {
        this.canvas = canvas;
        this.onHover = onHover; this.onPick = onPick; this.labelLayer = labelLayer;
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.toneMapping = THREE.NoToneMapping;
        this.renderer.setClearColor(0x05080f, 1);
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
        this.camera.up.set(0, 1, 0);

        // A fixed key light from the camera's upper left at the default view.
        const light = latLonToVec(38, CUT_LON0_DEG + 20).normalize();

        this.surfaceMat = new THREE.ShaderMaterial({
            vertexShader: SURFACE_VS, fragmentShader: SURFACE_FS,
            uniforms: {
                uMap: { value: null }, uHasMap: { value: 0 }, uLight: { value: light },
                uCutLon0: { value: CUT_LON0_DEG * Math.PI / 180 }, uCutSpan: { value: CUT_SPAN_DEG * Math.PI / 180 },
                uCutMode: { value: 0 }, uCutN: { value: new THREE.Vector3(0, 0, 1) },
            },
        });
        this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 128), this.surfaceMat);
        this.scene.add(this.earth);

        this.radialTex = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
        const bounds = BOUNDARY_RADII_KM.map((r) => r / R_EARTH_KM);
        const SLICE_KEEP = [R_EARTH_KM - 400, R_EARTH_KM - 670, 3480, 1221.5];
        const sliceBounds = BOUNDARY_RADII_KM.map((r) => (SLICE_KEEP.some((k) => Math.abs(k - r) < 2) ? r / R_EARTH_KM : -1));
        const e0 = latLonToVec(0, CUT_LON0_DEG), e1 = latLonToVec(0, CUT_LON0_DEG + CUT_SPAN_DEG), up = new THREE.Vector3(0, 1, 0);
        this.faces = [
            { g: quarterDisk(e0, up), shade: 0.90 },
            { g: quarterDisk(e1, up), shade: 1.0 },
            { g: quarterDisk(e0, e1), shade: 0.80 },
        ].map(({ g, shade }) => {
            const m = new THREE.Mesh(g, new THREE.ShaderMaterial({
                vertexShader: FACE_VS, fragmentShader: FACE_FS, side: THREE.DoubleSide,
                uniforms: { uRadial: { value: this.radialTex }, uBounds: { value: bounds }, uProbeR: { value: -1 }, uShade: { value: shade }, uLine: { value: 0.55 } },
                extensions: { derivatives: true },
            }));
            this.scene.add(m);
            return m;
        });

        // The great-circle slice (live earthquakes): one full disk in the plane, the
        // same face shader, its OWN radial table (the seismic view draws neutral layers
        // so blue/orange wavefronts read against them).
        this.slice = null;
        this.sliceTex = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
        this.sliceDisk = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
            vertexShader: FACE_VS, fragmentShader: FACE_FS, side: THREE.DoubleSide,
            // Only the boundaries a seismologist reads a ray fan against (400, 670, CMB, ICB), and
            // fainter: all eleven of PREM's crowd the rim into a white band at this scale (measured).
            uniforms: { uRadial: { value: this.sliceTex }, uBounds: { value: sliceBounds }, uProbeR: { value: -1 }, uShade: { value: 1 }, uLine: { value: 0.32 } },
            extensions: { derivatives: true },
        }));
        this.sliceDisk.visible = false;
        this.scene.add(this.sliceDisk);
        this._frameHooks = [];

        this.markerTex = markerTexture();
        this.markers = new Map();           // code → { sprite, label, lat, lon }

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
        this.controls.enablePan = false; this.controls.minDistance = 1.35; this.controls.maxDistance = 7;
        this.controls.rotateSpeed = 0.6;
        this.controls.addEventListener('start', () => { this._flight = null; });
        this.setView('cutaway', { instant: true });

        this.raycaster = new THREE.Raycaster();
        this._pointer = null; this._down = null;
        canvas.addEventListener('pointermove', (e) => { this._pointer = this._ndc(e); this._hoverDirty = true; });
        canvas.addEventListener('pointerleave', () => { this._pointer = null; this._hoverDirty = true; });
        canvas.addEventListener('pointerdown', (e) => { this._down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; });
        canvas.addEventListener('pointerup', (e) => {
            const d = this._down; this._down = null;
            if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || e.timeStamp - d.t > 700) return;
            const hit = this.pick(this._ndc(e), e);
            if (hit) this.onPick(hit);
        });

        this._visible = true;
        new IntersectionObserver((es) => { this._visible = es[0].isIntersecting; }).observe(canvas);
        new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
        this.resize();
        this.setView('cutaway', { instant: true });   // again, now the aspect is real
        this._raf = requestAnimationFrame((t) => this._frame(t));
    }

    /** Run fn(nowMs) every rendered frame (the live layer's clock). Returns an unsubscribe. */
    onFrame(fn) { this._frameHooks.push(fn); return () => { this._frameHooks = this._frameHooks.filter((f) => f !== fn); }; }

    /**
     * Cut along a great-circle plane { e1, e2, n } (unit vectors, canonical frame):
     * the half on the +n side is removed and a disk closes the solid. null restores the octant.
     */
    setSlice(plane, radialTable = null) {
        this.slice = plane;
        const on = !!plane;
        this.surfaceMat.uniforms.uCutMode.value = on ? 1 : 0;
        for (const f of this.faces) f.visible = !on;
        this.sliceDisk.visible = on;
        if (!on) return;
        this.surfaceMat.uniforms.uCutN.value.set(...plane.n);
        const e1 = new THREE.Vector3(...plane.e1), e2 = new THREE.Vector3(...plane.e2), seg = 360;
        const pos = [0, 0, 0], idx = [];
        for (let i = 0; i <= seg; i++) {
            const t = i / seg * Math.PI * 2, q = e1.clone().multiplyScalar(Math.cos(t)).add(e2.clone().multiplyScalar(Math.sin(t)));
            pos.push(q.x, q.y, q.z);
            if (i > 0) idx.push(0, i, i + 1);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
        this.sliceDisk.geometry.dispose(); this.sliceDisk.geometry = g;
        if (radialTable) {
            const rgba = new Uint8Array(4 * radialTable.n);
            for (let i = 0; i < radialTable.n; i++) rgba.set([radialTable.rgb[3 * i], radialTable.rgb[3 * i + 1], radialTable.rgb[3 * i + 2], 255], 4 * i);
            const t = new THREE.DataTexture(rgba, radialTable.n, 1, THREE.RGBAFormat);
            t.magFilter = t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
            this.sliceTex.dispose(); this.sliceTex = t; this.sliceDisk.material.uniforms.uRadial.value = t;
        }
    }

    /** Is a unit surface point removed by the current cut? */
    isCut(q) {
        if (this.slice) return q.x * this.slice.n[0] + q.y * this.slice.n[1] + q.z * this.slice.n[2] > 0;
        const lat = Math.asin(Math.max(-1, Math.min(1, q.y))) * 180 / Math.PI, lon = Math.atan2(-q.z, q.x) * 180 / Math.PI;
        return inCut(lat, lon);
    }

    /** One-shot flight to look along a direction at a given fill (the TIGA rule: started, never held). */
    flyToDirection(dir, { fill = 0.9, instant = false } = {}) {
        const to = (Array.isArray(dir) ? new THREE.Vector3(...dir) : dir.clone()).normalize().multiplyScalar(this._fitDistance(fill));
        if (instant) { this.camera.position.copy(to); this.controls.target.set(0, 0, 0); this.controls.update(); return; }
        this._flight = { from: this.camera.position.clone(), to, t0: performance.now(), dur: 1300 };
    }

    async loadMap(url) {
        const tex = await new THREE.TextureLoader().loadAsync(url);
        tex.colorSpace = THREE.NoColorSpace;
        // GEO's normalToUV puts v = 0 at the NORTH pole (image row 0). TextureLoader's
        // default flipY would put image row 0 at v = 1 and draw the map upside down
        // under correctly placed markers — measured on the first render.
        tex.flipY = false;
        tex.wrapS = THREE.RepeatWrapping;
        tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        this.surfaceMat.uniforms.uMap.value = tex;
        this.surfaceMat.uniforms.uHasMap.value = 1;
    }

    /** Draw a radialTable on the faces. */
    setRadialTable(table) {
        const rgba = new Uint8Array(4 * table.n);
        for (let i = 0; i < table.n; i++) rgba.set([table.rgb[3 * i], table.rgb[3 * i + 1], table.rgb[3 * i + 2], 255], 4 * i);
        const t = new THREE.DataTexture(rgba, table.n, 1, THREE.RGBAFormat);
        t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter;
        t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true;
        this.radialTex.dispose(); this.radialTex = t;
        for (const f of this.faces) f.material.uniforms.uRadial.value = t;
    }

    /** Highlight one radius on the faces (km), or null. */
    setProbeRadius(rKm) {
        const v = Number.isFinite(rKm) ? rKm / R_EARTH_KM : -1;
        for (const f of this.faces) f.material.uniforms.uProbeR.value = v;
    }

    /** Observatory markers: [{ code, lat, lon, emphasis }] — positions from the FEED. */
    setStations(list, selected = null) {
        const keep = new Set(list.map((s) => s.code));
        for (const [code, m] of this.markers) if (!keep.has(code)) { this.scene.remove(m.sprite); m.label?.remove(); this.markers.delete(code); }
        for (const s of list) {
            let m = this.markers.get(s.code);
            if (!m) {
                const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.markerTex, sizeAttenuation: false, depthTest: false, transparent: true }));
                this.scene.add(sprite);
                let label = null;
                if (this.labelLayer) { label = document.createElement('span'); label.className = 'ei-mlabel'; label.textContent = s.code; this.labelLayer.appendChild(label); }
                m = { sprite, label }; this.markers.set(s.code, m);
            }
            Object.assign(m, { lat: s.lat, lon: s.lon, code: s.code });
            m.sprite.position.copy(latLonToVec(s.lat, s.lon).multiplyScalar(1.004));
            const px = 9 + 9 * Math.min(1, s.emphasis ?? 0);
            m.px = px;
            m.sprite.material.color.set(s.code === selected ? 0xd95926 : 0xffffff);
            m.label?.classList.toggle('is-sel', s.code === selected);
        }
        this._sizeMarkers();
    }

    _sizeMarkers() {
        const h = this.canvas.clientHeight || 1;
        const k = 2 * Math.tan(this.camera.fov * Math.PI / 360) / h;
        for (const m of this.markers.values()) m.sprite.scale.setScalar(m.px * k);
    }

    /** One-shot flights. 'cutaway' faces the cut; 'observatories' faces the station centroid. */
    setView(name, { instant = false } = {}) {
        let dir, fill = 0.86;               // the disc's share of the binding half-angle
        if (name === 'observatories' && this.markers.size) {
            const c = new THREE.Vector3();
            for (const m of this.markers.values()) c.add(latLonToVec(m.lat, m.lon));
            dir = c.normalize(); fill = 0.96;
        } else dir = latLonToVec(30, CUT_LON0_DEG + CUT_SPAN_DEG / 2 - 8);
        const dist = this._fitDistance(fill);
        const to = dir.multiplyScalar(dist);
        if (instant) { this.camera.position.copy(to); this.controls.target.set(0, 0, 0); this.controls.update(); return; }
        this._flight = { from: this.camera.position.clone(), to, t0: performance.now(), dur: 1100 };
    }

    /** Camera distance at which the unit sphere fills `fill` of the BINDING half-angle (the smaller of vertical/horizontal). */
    _fitDistance(fill) {
        const v = this.camera.fov * Math.PI / 360;
        const h = Math.atan(Math.tan(v) * (this.camera.aspect || 1));
        return 1 / Math.sin(Math.min(v, h) * fill);
    }

    resize() {
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        if (!w || !h) return;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
        this._sizeMarkers();
    }

    _ndc(e) {
        const r = this.canvas.getBoundingClientRect();
        return { x: ((e.clientX - r.left) / r.width) * 2 - 1, y: -((e.clientY - r.top) / r.height) * 2 + 1, px: e.clientX - r.left, py: e.clientY - r.top };
    }

    /** What is under a pointer: a marker (pixel test), a cut face (radius) or the surface (lat/lon). */
    pick(p) {
        if (!p) return null;
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
        let best = null, bestD = 14;
        const camDir = this.camera.position.clone().normalize();
        for (const m of this.markers.values()) {
            if (m.sprite.position.clone().normalize().dot(camDir) < 0.05) continue;
            const s = m.sprite.position.clone().project(this.camera);
            const d = Math.hypot((s.x + 1) / 2 * w - p.px, (1 - s.y) / 2 * h - p.py);
            if (d < bestD) { bestD = d; best = { kind: 'station', code: m.code }; }
        }
        if (best) return best;
        this.raycaster.setFromCamera(new THREE.Vector2(p.x, p.y), this.camera);
        const ray = this.raycaster.ray;
        const faceHit = this.raycaster.intersectObjects(this.slice ? [this.sliceDisk] : this.faces, false)[0] ?? null;
        // Analytic sphere: nearest intersection that is NOT inside the cut.
        let sphere = null;
        const b = ray.origin.dot(ray.direction), c = ray.origin.lengthSq() - 1, disc = b * b - c;
        if (disc >= 0) {
            for (const t of [-b - Math.sqrt(disc), -b + Math.sqrt(disc)]) {
                if (t <= 0) continue;
                const q = ray.at(t, new THREE.Vector3());
                const lat = Math.asin(Math.max(-1, Math.min(1, q.y))) * 180 / Math.PI;
                const lon = Math.atan2(-q.z, q.x) * 180 / Math.PI;
                if (!this.isCut(q)) { sphere = { t, lat, lon }; break; }
            }
        }
        if (faceHit && (!sphere || faceHit.distance < sphere.t)) return { kind: 'interior', rKm: faceHit.point.length() * R_EARTH_KM };
        if (sphere) return { kind: 'surface', lat: sphere.lat, lon: sphere.lon };
        return null;
    }

    _frame(now) {
        this._raf = requestAnimationFrame((t) => this._frame(t));
        if (this._flight) {
            const f = this._flight, u = Math.min(1, (now - f.t0) / f.dur), e = u * u * (3 - 2 * u);
            // Interpolate DIRECTION and log-distance (a straight chord dives through the planet).
            const a = f.from.clone().normalize(), z = f.to.clone().normalize();
            const dir = a.lerp(z, e).normalize();
            const dist = Math.exp(Math.log(f.from.length()) * (1 - e) + Math.log(f.to.length()) * e);
            this.camera.position.copy(dir.multiplyScalar(dist));
            if (u >= 1) this._flight = null;
        }
        this.controls.update();
        if (!this._visible) return;
        for (const fn of this._frameHooks) fn(Date.now());
        if (this._hoverDirty) { this._hoverDirty = false; this.onHover(this.pick(this._pointer)); }
        this.renderer.render(this.scene, this.camera);
        this._placeLabels();
    }

    _placeLabels() {
        const w = this.canvas.clientWidth, h = this.canvas.clientHeight, camDir = this.camera.position.clone().normalize();
        for (const m of this.markers.values()) {
            const front = m.sprite.position.clone().normalize().dot(camDir) > 0.12;
            const s = m.sprite.position.clone().project(this.camera);
            m.sprite.visible = front;
            if (!m.label) continue;
            m.label.style.display = front ? '' : 'none';
            if (front) m.label.style.transform = `translate(${((s.x + 1) / 2 * w + 9).toFixed(1)}px, ${((1 - s.y) / 2 * h - 8).toFixed(1)}px)`;
        }
    }
}
