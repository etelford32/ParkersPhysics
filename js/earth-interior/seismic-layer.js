/**
 * seismic-layer.js — the LIVE earthquake layer on the InteriorStage.
 * Renderer only: every position is quake-model.js (rays, fronts, the slice)
 * or a USGS catalogue coordinate. It computes no physics.
 *
 * What it draws, in the great-circle slice through the epicentre, the
 * viewer and the centre:
 *   · the wavefronts at the layer's clock — P blue, S orange, by the wave
 *     type ON each stretch (SKS turns blue in the liquid core), as dots
 *     joined where neighbouring rays are both still in the Earth;
 *   · every ray that reaches the viewer (dashed: reflected / multiple /
 *     depth phases; opacity = the phase's strength in its band), and a bright
 *     packet riding each one at the clock;
 *   · the epicentre (orange burst), the viewer (white ring) and every other
 *     catalogue quake on the surface (white dots, sized by magnitude).
 * The clock is supplied by the page (live wall clock or a replay); the
 * stage never spins.
 */

import * as THREE from 'three';
import { planePoint, wavefronts, positionAt, geoVec } from './quake-model.js';

export const WAVE_COLORS = Object.freeze({ P: '#3987e5', S: '#d95926' });
const DASHED_KINDS = new Set(['reflected', 'multiple', 'depth']);
const LIFT = 1.002;

function dotTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const x = c.getContext('2d'), g = x.createRadialGradient(16, 16, 0, 16, 16, 15);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.55, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; return t;
}
function burstTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.translate(32, 32); x.fillStyle = '#d95926'; x.strokeStyle = '#05080f'; x.lineWidth = 4;
    x.beginPath();
    for (let i = 0; i < 16; i++) { const r = i % 2 ? 13 : 28, a = i * Math.PI / 8; x.lineTo(r * Math.cos(a), r * Math.sin(a)); }
    x.closePath(); x.stroke(); x.fill();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; return t;
}

export class SeismicLayer {
    constructor(stage, { labelLayer = null, onPickQuake = () => {} } = {}) {
        this.stage = stage; this.labelLayer = labelLayer; this.onPickQuake = onPickQuake;
        this.group = new THREE.Group(); this.group.visible = false;
        stage.scene.add(this.group);
        this.dotTex = dotTexture();
        this.colors = { P: new THREE.Color(WAVE_COLORS.P), S: new THREE.Color(WAVE_COLORS.S) };

        // Wavefronts: one LineSegments + one Points, rebuilt per clock tick.
        this.frontLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthTest: false }));
        this.frontDots = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ vertexColors: true, size: 5, sizeAttenuation: false, map: this.dotTex, transparent: true, depthTest: false }));
        this.packets = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ vertexColors: true, size: 11, sizeAttenuation: false, map: this.dotTex, transparent: true, depthTest: false }));
        this.rayGroup = new THREE.Group();
        for (const o of [this.rayGroup, this.frontLines, this.frontDots, this.packets]) { o.renderOrder = 5; this.group.add(o); }

        this.epi = new THREE.Sprite(new THREE.SpriteMaterial({ map: burstTexture(), sizeAttenuation: false, depthTest: false, transparent: true }));
        this.site = new THREE.Sprite(new THREE.SpriteMaterial({ map: stage.markerTex, sizeAttenuation: false, depthTest: false, transparent: true }));
        this.epi.renderOrder = this.site.renderOrder = 6;
        this.group.add(this.epi, this.site);
        this.others = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial({ color: 0xf0efec, size: 6, sizeAttenuation: false, map: this.dotTex, transparent: true, opacity: 0.8 }));
        this.group.add(this.others);
        this.otherList = [];

        this.labels = {};
        if (labelLayer) for (const k of ['epi', 'site']) { const s = document.createElement('span'); s.className = `ei-mlabel ei-mlabel--${k}`; labelLayer.appendChild(s); this.labels[k] = s; }

        this.state = null;            // { quake, site, plane, fan, rays }
        this._lastT = null;
        this._unhook = stage.onFrame(() => this._place());
    }

    setVisible(on) {
        this.group.visible = on;
        for (const l of Object.values(this.labels)) l.style.display = on ? '' : 'none';
    }

    /** The quake, the site, its slice plane and the Worker's payload (rays to the site, the fan). */
    setScene({ quake, site, plane, rays = [], fan = [], arrivals = [] }) {
        this.state = { quake, site, plane, rays, fan, arrivals };
        const v = (r, phi) => new THREE.Vector3(...planePoint(plane, r, phi));
        this.epi.position.copy(new THREE.Vector3(...geoVec(quake.lat, quake.lon)).multiplyScalar(LIFT));
        this.site.position.copy(new THREE.Vector3(...geoVec(site.lat, site.lon)).multiplyScalar(LIFT));
        if (this.labels.epi) this.labels.epi.textContent = `M${quake.mag.toFixed(1)}`;
        if (this.labels.site) this.labels.site.textContent = site.fallback ? 'NEIC' : 'You';
        // Rays to the site: one line each, coloured per stretch by its wave.
        for (const c of [...this.rayGroup.children]) { this.rayGroup.remove(c); c.geometry.dispose(); c.material.dispose(); }
        const kindOf = new Map(arrivals.map((a) => [a.phase, a.kind]));
        // A ray's opacity is its phase's STRENGTH in its own band (amplitude.js): a −50 dB
        // partial reflection should not be drawn as boldly as the direct P.
        const dbOf = new Map(arrivals.map((a) => [a.phase, a.db]));
        const alphaOf = (ph) => { const d = dbOf.get(ph); return d == null ? 0.3 : 0.12 + 0.63 * Math.max(0, Math.min(1, (d + 50) / 50)); };
        for (const r of rays) {
            if (!r.path) continue;
            const pos = [], col = [];
            for (let i = 1; i < r.path.length; i++) {
                const a = r.path[i - 1], b = r.path[i], c = this.colors[b.wave];
                pos.push(...v(a.rKm, a.phi).toArray(), ...v(b.rKm, b.phi).toArray());
                col.push(c.r, c.g, c.b, c.r, c.g, c.b);
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
            const dashed = DASHED_KINDS.has(kindOf.get(r.phase));
            const m = dashed
                ? new THREE.LineDashedMaterial({ vertexColors: true, dashSize: 0.012, gapSize: 0.01, transparent: true, opacity: alphaOf(r.phase), depthTest: false })
                : new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: alphaOf(r.phase), depthTest: false });
            const line = new THREE.LineSegments(g, m);
            if (dashed) line.computeLineDistances();
            line.userData.phase = r.phase;
            this.rayGroup.add(line);
        }
        this._lastT = null;
        this._sizeSprites();
    }

    /** Other catalogue quakes as surface dots: [{ id, lat, lon, mag }]. */
    setOthers(list) {
        // Dots on the half the slice removes would float in empty space: they are not drawn (or picked).
        this.otherList = list.filter((q) => !this.stage.isCut(new THREE.Vector3(...geoVec(q.lat, q.lon))));
        const pos = [];
        for (const q of this.otherList) pos.push(...new THREE.Vector3(...geoVec(q.lat, q.lon)).multiplyScalar(LIFT).toArray());
        const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        this.others.geometry.dispose(); this.others.geometry = g;
    }

    /** Draw the fronts and packets at t seconds after the origin. */
    setTime(tS) {
        if (!this.state || (this._lastT !== null && Math.abs(tS - this._lastT) < 0.05)) return;
        this._lastT = tS;
        const { plane, fan, rays } = this.state;
        const P = (r, phi) => planePoint(plane, r, phi);
        const lp = [], lc = [], dp = [], dc = [];
        for (const f of wavefronts(fan, tS)) {
            for (let i = 0; i < f.points.length; i++) {
                const a = f.points[i], c = this.colors[a.wave];
                dp.push(...P(a.rKm, a.phi)); dc.push(c.r, c.g, c.b);
                if (i === 0) continue;
                const b = f.points[i - 1];
                // Do not bridge across a big jump in angle (two rays that left in different directions).
                if (Math.abs(a.phi - b.phi) > 0.35) continue;
                lp.push(...P(b.rKm, b.phi), ...P(a.rKm, a.phi)); lc.push(c.r, c.g, c.b, c.r, c.g, c.b);
            }
        }
        set(this.frontLines, lp, lc); set(this.frontDots, dp, dc);
        // Packets riding each ray to the site.
        const pp = [], pc = [];
        for (const r of rays) {
            if (!r.packed) r.packed = packed(r.path);
            const q = positionAt(r.packed, tS);
            if (!q) continue;
            const c = this.colors[q.wave];
            pp.push(...P(q.rKm, (r.path.at(-1).phi < 0 ? -1 : 1) * q.deltaRad)); pc.push(c.r, c.g, c.b);
        }
        set(this.packets, pp, pc);
    }

    /** Pixel pick of a surface quake dot; returns its id or null. */
    pickQuake(p) {
        const w = this.stage.canvas.clientWidth, h = this.stage.canvas.clientHeight, cam = this.stage.camera;
        const camDir = cam.position.clone().normalize();
        let best = null, bestD = 12;
        for (const q of this.otherList) {
            const v = new THREE.Vector3(...geoVec(q.lat, q.lon));
            if (v.dot(camDir) < 0.05 || this.stage.isCut(v)) continue;
            const s = v.clone().project(cam), d = Math.hypot((s.x + 1) / 2 * w - p.px, (1 - s.y) / 2 * h - p.py);
            if (d < bestD) { bestD = d; best = q.id; }
        }
        return best;
    }

    _sizeSprites() {
        const hpx = this.stage.canvas.clientHeight || 1, k = 2 * Math.tan(this.stage.camera.fov * Math.PI / 360) / hpx;
        this.epi.scale.setScalar(22 * k); this.site.scale.setScalar(15 * k);
    }

    _place() {
        if (!this.group.visible || !this.state) return;
        this._sizeSprites();
        const cam = this.stage.camera, w = this.stage.canvas.clientWidth, h = this.stage.canvas.clientHeight;
        for (const [k, sprite] of [['epi', this.epi], ['site', this.site]]) {
            const lab = this.labels[k]; if (!lab) continue;
            const s = sprite.position.clone().project(cam);
            const behind = sprite.position.clone().normalize().dot(cam.position.clone().normalize()) < -0.2;
            lab.style.display = behind ? 'none' : '';
            lab.style.transform = `translate(${((s.x + 1) / 2 * w + 12).toFixed(1)}px, ${((1 - s.y) / 2 * h - 8).toFixed(1)}px)`;
        }
    }
}

function set(obj, pos, col) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    obj.geometry.dispose(); obj.geometry = g;
}
function packed(path) {
    const a = new Float64Array(4 * path.length);
    // Rays to the site are { rKm, phi, wave }; positionAt reads [r, δ, t, wave] — δ is |φ| and t comes from the node.
    path.forEach((n, i) => { a[4 * i] = n.rKm; a[4 * i + 1] = Math.abs(n.phi); a[4 * i + 2] = n.tS; a[4 * i + 3] = n.wave === 'S' ? 1 : 0; });
    return a;
}
