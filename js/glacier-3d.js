/**
 * glacier-3d.js — Glacier Watch's volumetric 3D stage (three.js r160, vendored).
 *
 * Draws ONE glacier's window as three bodies, all from js/glacier-engine.js numbers:
 *   TERRAIN  the Copernicus GLO-30 surface off the ice, and the ESTIMATED BED under it
 *            (surface − H, engine `iceModel`), shaded by height;
 *   ICE      a translucent body between bed and surface on every ice cell, with vertical
 *            walls along its margins — coloured by the chosen layer: observed surface speed,
 *            modelled thickness, ice flux per unit width, or driving stress;
 *   SECTION  an optional curtain along the flowline from bed to surface: the thickness profile;
 *   FLOW     parcels advected through the OBSERVED mean field (engine `advect`), drawn as
 *            streaks riding the surface.
 *
 * Two DISCLOSED dishonesties: vertical exaggeration (default 2×, slider 1–6×, printed in the
 * legend) and compressed TIME for the parcels (printed). Nothing is magnified horizontally.
 * The scene is rotated so true north is −Z (up the screen from the default camera).
 *
 * It computes no physics. Camera rule (the TIGA / Stage scars): camera.up is +Y and never
 * changes, so OrbitControls is built ONCE; presets are one-shot moves, never a held spring.
 * The loop renders only when the stage is on screen and the tab visible.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fieldSampler, advect, northInGrid, iceModel } from './glacier-engine.js';

export const LAYERS = {
    speed:     { label: 'Surface speed', unit: 'm/yr', log: true,  ramp: ['#0b1f3a', '#123a68', '#1d5f9a', '#2f8bd0', '#62b6ec', '#a9dcfa', '#eef9ff'], source: 'observed (ITS_LIVE 2014–2024 mean)' },
    thickness: { label: 'Ice thickness', unit: 'm',    log: false, ramp: ['#1b1036', '#3b1f6b', '#5b3a9c', '#7e5fc3', '#a68ae0', '#cdb9f3', '#f1eafe'], source: 'model (shallow-ice inversion, plastic cap)' },
    flux:      { label: 'Ice flux / width', unit: 'm²/yr', log: true, ramp: ['#062a26', '#0b4a42', '#11705f', '#1b977c', '#45bd98', '#8fdcb9', '#e3f8ee'], source: 'model (0.8 · u · H)' },
    stress:    { label: 'Driving stress', unit: 'kPa', log: false, ramp: ['#2b1606', '#5a2d0c', '#8a4512', '#b8621c', '#dc8a3a', '#f0b878', '#fbe6cc'], source: 'model (ρ g H sin α)' },
};

const hexRgb = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
export function rampAt(ramp, f) {
    const c = ramp.map(hexRgb), x = Math.max(0, Math.min(1, f)) * (c.length - 1), i = Math.min(c.length - 2, Math.floor(x)), t = x - i;
    return [0, 1, 2].map(k => c[i][k] + (c[i + 1][k] - c[i][k]) * t);
}

export function webglAvailable() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}

export class Glacier3D {
    constructor(host, { onHover, onStats } = {}) {
        this.host = host; this.onHover = onHover; this.onStats = onStats;
        this.layer = 'speed'; this.exag = 2; this.showFlow = true; this.showSection = true;
        this.reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (this.reduced) this.showFlow = false;
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
        this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
        this.renderer.setClearColor(0x050a14, 1);
        this.renderer.domElement.style.display = 'block';
        this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D glacier: terrain, estimated ice body and flowing ice parcels');
        host.appendChild(this.renderer.domElement);
        this.scene = new THREE.Scene();
        this.scene.fog = new THREE.Fog(0x050a14, 60, 260);
        this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 2000);
        this.camera.up.set(0, 1, 0);                                       // set BEFORE the controls (orbit-axis scar)
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
        this.controls.maxPolarAngle = Math.PI * 0.49; this.controls.screenSpacePanning = false;
        this.scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x1a1410, 0.9));
        this.sun = new THREE.DirectionalLight(0xffffff, 1.6); this.sun.position.set(-40, 60, 30); this.scene.add(this.sun);
        this.root = new THREE.Group(); this.scene.add(this.root);
        this.frameMs = []; this.visible = true; this.raf = 0;
        this.ray = new THREE.Raycaster(); this.mouse = new THREE.Vector2();
        this._loop = this._loop.bind(this);
        new ResizeObserver(() => this.resize()).observe(host);
        if (typeof IntersectionObserver !== 'undefined') new IntersectionObserver(es => { this.visible = es[0].isIntersecting; this._kick(); }).observe(host);
        document.addEventListener('visibilitychange', () => this._kick());
        this.renderer.domElement.addEventListener('pointermove', (e) => this._hover(e));
        this.renderer.domElement.addEventListener('pointerleave', () => this.onHover?.(null));
        this.controls.addEventListener('change', () => this._kick());
        this.resize();
    }

    setGlacier(glacier, detail) {
        this.g = glacier; this.det = detail;
        const f = detail.field;
        if (!f.z) throw new Error('this glacier has no terrain grid in its archive');
        this.model = iceModel(f);
        this.sample = fieldSampler(f);
        this.north = northInGrid(glacier.flowline);
        // scene units: km; origin at the grid centre; north → −Z
        this.kmX = (j) => ((j - (f.nx - 1) / 2) * f.dx) / 1000;
        this.kmY = (i) => ((i - (f.ny - 1) / 2) * f.dy) / 1000;
        let zmin = Infinity, zmax = -Infinity;
        for (let k = 0; k < f.z.length; k++) { const b = this.model.bed[k]; if (Number.isFinite(b)) { zmin = Math.min(zmin, b); zmax = Math.max(zmax, f.z[k]); } }
        this.zmin = zmin; this.zmax = zmax;
        this._layerRange();
        this._build();
        this.frame('oblique');
        this.onStats?.(this.stats());
    }

    stats() {
        const m = this.model, L = LAYERS[this.layer];
        return { volumeKm3: m.volumeKm3, massGt: m.massGt, iceAreaKm2: m.iceAreaKm2, meanH: m.meanH, maxH: m.maxH, cappedFraction: m.cappedFraction,
            layer: this.layer, label: L.label, unit: L.unit, source: L.source, lo: this.lo, hi: this.hi, log: L.log, ramp: L.ramp, exag: this.exag, assumptions: m.assumptions,
            daysPerSecond: this.daysPerSecond };
    }

    _values() {
        const m = this.model;
        return this.layer === 'speed' ? m.speed : this.layer === 'thickness' ? m.H : this.layer === 'flux' ? m.q : m.tau;
    }

    _layerRange() {
        const v = this._values(), ice = this.det.field.ice, xs = [];
        for (let k = 0; k < v.length; k++) if (ice[k] >= 0.5 && Number.isFinite(v[k]) && (!LAYERS[this.layer].log || v[k] > 0)) xs.push(v[k]);
        xs.sort((a, b) => a - b);
        const q = (p) => xs.length ? xs[Math.floor(p * (xs.length - 1))] : 1;
        this.lo = LAYERS[this.layer].log ? Math.max(1, q(0.03)) : q(0.02); this.hi = Math.max(this.lo * 1.01, q(0.99));
    }

    _colorFor(v) {
        const L = LAYERS[this.layer];
        if (!Number.isFinite(v)) return [0.4, 0.45, 0.5];
        const f = L.log ? (Math.log10(Math.max(v, 1e-6)) - Math.log10(this.lo)) / (Math.log10(this.hi) - Math.log10(this.lo)) : (v - this.lo) / (this.hi - this.lo);
        return rampAt(L.ramp, f);
    }

    _h(z) { return ((z - this.zmin) * this.exag) / 1000; }

    _build() {
        for (const c of [...this.root.children]) { this.root.remove(c); c.geometry?.dispose(); c.material?.dispose(); }
        const f = this.det.field, m = this.model, nx = f.nx, ny = f.ny;
        // North-up: the grid's true-north vector (nX, nY) lands in world xz as (nX, −nY) (x = east-ish
        // columns, z = −grid y). A rotation φ about +Y with cos φ = nY, sin φ = nX takes it to (0, −1),
        // i.e. −Z, up the screen from the default camera. In UTM φ ≈ 0; in EPSG:3413 it can be ~100°.
        const ang = Math.atan2(this.north[0], this.north[1]);
        this.root.rotation.set(0, 0, 0);
        const iceAt = (i, j) => f.ice[i * nx + j] >= 0.5 && Number.isFinite(f.z[i * nx + j]);
        // ── terrain (bed under ice) ──
        const tPos = new Float32Array(nx * ny * 3), tCol = new Float32Array(nx * ny * 3);
        for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
            const k = i * nx + j, b = Number.isFinite(m.bed[k]) ? m.bed[k] : this.zmin;
            tPos.set([this.kmX(j), this._h(b), -this.kmY(i)], 3 * k);
            const t = (b - this.zmin) / Math.max(1, this.zmax - this.zmin);
            const rock = iceAt(i, j) ? [0.30 + 0.15 * t, 0.26 + 0.12 * t, 0.24 + 0.10 * t] : [0.20 + 0.45 * t, 0.21 + 0.42 * t, 0.22 + 0.40 * t];
            tCol.set(rock, 3 * k);
        }
        const idx = [];
        for (let i = 0; i < ny - 1; i++) for (let j = 0; j < nx - 1; j++) {
            const a = i * nx + j, b = a + 1, c = a + nx, d = c + 1;
            idx.push(a, c, b, b, c, d);
        }
        const tg = new THREE.BufferGeometry();
        tg.setAttribute('position', new THREE.BufferAttribute(tPos, 3)); tg.setAttribute('color', new THREE.BufferAttribute(tCol, 3));
        tg.setIndex(idx); tg.computeVertexNormals();
        this.terrain = new THREE.Mesh(tg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }));
        this.root.add(this.terrain);
        // ── ice body: surface triangles on ice cells + walls down to the bed on its margins ──
        const sPos = [], sCol = [], sIdx = [], vmap = new Int32Array(nx * ny).fill(-1);
        const vals = this._values();
        const vert = (i, j) => {
            const k = i * nx + j;
            if (vmap[k] >= 0) return vmap[k];
            vmap[k] = sPos.length / 3;
            sPos.push(this.kmX(j), this._h(f.z[k]) + 0.002, -this.kmY(i));
            sCol.push(...this._colorFor(vals[k]));
            return vmap[k];
        };
        for (let i = 0; i < ny - 1; i++) for (let j = 0; j < nx - 1; j++) {
            if (!(iceAt(i, j) && iceAt(i, j + 1) && iceAt(i + 1, j) && iceAt(i + 1, j + 1))) continue;
            const a = vert(i, j), b = vert(i, j + 1), c = vert(i + 1, j), d = vert(i + 1, j + 1);
            sIdx.push(a, c, b, b, c, d);
        }
        const wPos = [], wCol = [];
        const wall = (i0, j0, i1, j1) => {
            const k0 = i0 * nx + j0, k1 = i1 * nx + j1;
            const p = (i, j, z) => [this.kmX(j), this._h(z), -this.kmY(i)];
            const A = p(i0, j0, f.z[k0]), B = p(i1, j1, f.z[k1]), C = p(i0, j0, m.bed[k0]), D = p(i1, j1, m.bed[k1]);
            wPos.push(...A, ...C, ...B, ...B, ...C, ...D);
            const ca = this._colorFor(vals[k0]), cb = this._colorFor(vals[k1]);
            const dim = (c) => c.map(x => x * 0.55);
            wCol.push(...ca, ...dim(ca), ...cb, ...cb, ...dim(ca), ...dim(cb));
        };
        for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
            if (!iceAt(i, j)) continue;
            if (j + 1 < nx && iceAt(i, j + 1)) {           // horizontal edge: wall if a neighbour row is ice-free
                const up = i > 0 && iceAt(i - 1, j) && iceAt(i - 1, j + 1), dn = i + 1 < ny && iceAt(i + 1, j) && iceAt(i + 1, j + 1);
                if (!up || !dn) wall(i, j, i, j + 1);
            }
            if (i + 1 < ny && iceAt(i + 1, j)) {
                const lf = j > 0 && iceAt(i, j - 1) && iceAt(i + 1, j - 1), rt = j + 1 < nx && iceAt(i, j + 1) && iceAt(i + 1, j + 1);
                if (!lf || !rt) wall(i, j, i + 1, j);
            }
        }
        const sg = new THREE.BufferGeometry();
        sg.setAttribute('position', new THREE.Float32BufferAttribute(sPos, 3)); sg.setAttribute('color', new THREE.Float32BufferAttribute(sCol, 3));
        sg.setIndex(sIdx); sg.computeVertexNormals();
        this.iceMesh = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.05, transparent: true, opacity: 0.86, side: THREE.DoubleSide }));
        this.root.add(this.iceMesh);
        const wg = new THREE.BufferGeometry();
        wg.setAttribute('position', new THREE.Float32BufferAttribute(wPos, 3)); wg.setAttribute('color', new THREE.Float32BufferAttribute(wCol, 3));
        wg.computeVertexNormals();
        this.walls = new THREE.Mesh(wg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
        this.root.add(this.walls);
        // ── flowline section ──
        this._buildSection();
        // ── flow streaks ──
        this._seedFlow();
        // point the scene north-up
        this.root.rotation.y = ang;
        this._kick();
    }

    _gridIJ(x, y) { const f = this.det.field; return [(y - f.y0) / f.dy, (x - f.x0) / f.dx]; }
    _bil(a, fi, fj) {
        const f = this.det.field, i = Math.floor(fi), j = Math.floor(fj);
        if (i < 0 || j < 0 || i >= f.ny - 1 || j >= f.nx - 1) return NaN;
        const u = fj - j, w = fi - i, k = i * f.nx + j;
        const v = [a[k], a[k + 1], a[k + f.nx], a[k + f.nx + 1]];
        if (v.some(q => !Number.isFinite(q))) return v.filter(Number.isFinite).reduce((s, q, _, r) => s + q / r.length, 0) || NaN;
        return v[0] * (1 - u) * (1 - w) + v[1] * u * (1 - w) + v[2] * (1 - u) * w + v[3] * u * w;
    }

    _buildSection() {
        const fl = this.g.flowline, f = this.det.field, m = this.model, pos = [], col = [];
        let prev = null;
        for (let k = 0; k < fl.n; k++) {
            const [fi, fj] = this._gridIJ(fl.x[k], fl.y[k]);
            const zs = this._bil(f.z, fi, fj), zb = this._bil(m.bed, fi, fj), h = this._bil(m.H, fi, fj);
            if (!Number.isFinite(zs) || !Number.isFinite(zb)) { prev = null; continue; }
            const X = ((fj - (f.nx - 1) / 2) * f.dx) / 1000, Z = -((fi - (f.ny - 1) / 2) * f.dy) / 1000;
            const cur = { X, Z, top: this._h(zs) + 0.004, bot: this._h(zb), c: rampAt(LAYERS.thickness.ramp, Math.max(0, Math.min(1, h / Math.max(1, m.maxH)))) };
            if (prev) {
                pos.push(prev.X, prev.top, prev.Z, prev.X, prev.bot, prev.Z, cur.X, cur.top, cur.Z, cur.X, cur.top, cur.Z, prev.X, prev.bot, prev.Z, cur.X, cur.bot, cur.Z);
                col.push(...prev.c, ...prev.c.map(x => x * 0.4), ...cur.c, ...cur.c, ...prev.c.map(x => x * 0.4), ...cur.c.map(x => x * 0.4));
            }
            prev = cur;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        this.section = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }));
        this.section.visible = this.showSection;
        this.root.add(this.section);
    }

    _seedFlow() {
        const f = this.det.field;
        this.iceCells = [];
        for (let k = 0; k < f.vx.length; k++) if (f.ice[k] >= 0.5 && Number.isFinite(f.vx[k])) this.iceCells.push(k);
        const n = Math.min(2200, Math.max(400, Math.round(this.iceCells.length * 0.5)));
        this.parcels = Array.from({ length: n }, () => this._spawn(Math.random() * 150));
        const sp = this.iceCells.map(k => Math.hypot(f.vx[k], f.vy[k])).sort((a, b) => a - b);
        const v95 = sp.length ? sp[Math.floor(0.95 * (sp.length - 1))] : 50;
        this.dtYears = 0.25 * Math.abs(f.dx) / Math.max(1, v95);           // the fast ice moves ~¼ cell per frame
        this.daysPerSecond = this.dtYears * 60 * 365.25;
        this.streakPos = new Float32Array(n * 6);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(this.streakPos, 3));
        this.streaks = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 }));
        this.streaks.visible = this.showFlow;
        this.streaks.frustumCulled = false;
        this.root.add(this.streaks);
        this._updateStreaks(false);
    }

    _spawn(age = 0) {
        const f = this.det.field, k = this.iceCells[(Math.random() * this.iceCells.length) | 0] ?? 0;
        const i = Math.floor(k / f.nx), j = k % f.nx;
        return { x: f.x0 + (j + Math.random() - 0.5) * f.dx, y: f.y0 + (i + Math.random() - 0.5) * f.dy, px: null, py: null, age, life: 80 + Math.random() * 140 };
    }

    _updateStreaks(step = true) {
        const f = this.det.field, P = this.streakPos;
        for (let n = 0; n < this.parcels.length; n++) {
            let p = this.parcels[n];
            if (step) {
                const nx = advect(this.sample, p.x, p.y, this.dtYears);
                p.age++;
                if (!nx || p.age > p.life) { p = this.parcels[n] = this._spawn(); }
                else { p.px = p.x; p.py = p.y; p.x = nx[0]; p.y = nx[1]; }
            }
            const v = this.sample(p.x, p.y) || [0, 0];
            const tail = 6 * this.dtYears;                                     // streak = 6 frames of travel
            const pts = [[p.x, p.y], [p.x - v[0] * tail, p.y - v[1] * tail]];
            pts.forEach(([x, y], e) => {
                const [fi, fj] = this._gridIJ(x, y), zs = this._bil(f.z, fi, fj);
                P[n * 6 + e * 3] = ((fj - (f.nx - 1) / 2) * f.dx) / 1000;
                P[n * 6 + e * 3 + 1] = Number.isFinite(zs) ? this._h(zs) + 0.012 : -1e3;
                P[n * 6 + e * 3 + 2] = -((fi - (f.ny - 1) / 2) * f.dy) / 1000;
            });
        }
        this.streaks.geometry.attributes.position.needsUpdate = true;
    }

    setLayer(name) { if (!LAYERS[name] || !this.det) return; this.layer = name; this._layerRange(); this._build(); this.onStats?.(this.stats()); }
    setExaggeration(x) { if (!this.det) return; this.exag = x; this._build(); this.onStats?.(this.stats()); }
    setFlow(on) { this.showFlow = !!on && !this.reduced; if (this.streaks) this.streaks.visible = this.showFlow; this._kick(); }
    setSection(on) { this.showSection = !!on; if (this.section) this.section.visible = this.showSection; this._kick(); }

    /** One-shot camera presets; any drag afterwards is the user's. */
    frame(kind = 'oblique') {
        const f = this.det.field, w = Math.abs(f.nx * f.dx) / 1000, h = Math.abs(f.ny * f.dy) / 1000, r = Math.max(w, h);
        const mid = this._h((this.zmin + this.zmax) / 2);
        this.controls.target.set(0, mid * 0.6, 0);
        if (kind === 'top') this.camera.position.set(0.001, r * 1.25, 0.001 + r * 0.02);
        else if (kind === 'side') this.camera.position.set(r * 1.05, r * 0.25 + mid, 0);
        else this.camera.position.set(r * 0.15, r * 0.62, r * 0.85);
        this.controls.minDistance = r * 0.08; this.controls.maxDistance = r * 4;
        this.camera.near = r * 0.002; this.camera.far = r * 12; this.camera.updateProjectionMatrix();
        this.scene.fog.near = r * 1.5; this.scene.fog.far = r * 6;
        this.controls.update(); this._kick();
    }

    resize() {
        const r = this.host.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return;
        this.renderer.setSize(r.width, r.height, false);
        this.renderer.domElement.style.width = r.width + 'px'; this.renderer.domElement.style.height = r.height + 'px';
        this.camera.aspect = r.width / r.height; this.camera.updateProjectionMatrix();
        this._kick(true);
    }

    _kick(force = false) {
        const live = this.visible && !document.hidden && !!this.det;
        if (live && !this.raf) this.raf = requestAnimationFrame(this._loop);
        if (force && live) this.renderer.render(this.scene, this.camera);
    }

    _loop() {
        this.raf = 0;
        const t0 = performance.now();
        const moving = this.controls.update();
        if (this.showFlow && this.streaks) this._updateStreaks(true);
        this.renderer.render(this.scene, this.camera);
        this.frameMs.push(performance.now() - t0);
        if (this.frameMs.length > 120) this.frameMs.shift();
        if (this.showFlow || moving) this._kick();
    }

    frameCostMs() { const s = this.frameMs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; }

    _hover(e) {
        if (!this.iceMesh) return;
        const r = this.renderer.domElement.getBoundingClientRect();
        this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        this.ray.setFromCamera(this.mouse, this.camera);
        const hit = this.ray.intersectObjects([this.iceMesh, this.terrain], false)[0];
        if (!hit) { this.onHover?.(null); return; }
        const pLocal = this.root.worldToLocal(hit.point.clone()), f = this.det.field, m = this.model;
        const fj = pLocal.x * 1000 / f.dx + (f.nx - 1) / 2, fi = -pLocal.z * 1000 / f.dy + (f.ny - 1) / 2;
        const k = Math.round(fi) * f.nx + Math.round(fj);
        if (k < 0 || k >= f.z.length) { this.onHover?.(null); return; }
        const onIce = f.ice[k] >= 0.5;
        this.onHover?.({ x: e.clientX - r.left, y: e.clientY - r.top, onIce, z: f.z[k], speed: m.speed[k], H: m.H[k], bed: m.bed[k], q: m.q[k], tau: m.tau[k], slope: m.slope[k] });
    }
}
