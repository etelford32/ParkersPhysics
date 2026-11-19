/**
 * seismic-layer.js — the LIVE earthquake layer on the InteriorStage.
 * Renderer only: every position is quake-model.js (rays, fronts, the slice)
 * or a USGS catalogue coordinate. It computes no physics.
 *
 * What it draws, in the great-circle slice through the epicentre, the
 * viewer and the centre:
 *   · the WAVEFRONTS at the layer's clock as continuous glowing curves —
 *     P blue, S orange, by the wave type ON each stretch (SKS turns blue in
 *     the liquid core) — with three fading ECHOES of where each front was
 *     10, 20 and 30 s earlier, so the motion reads in a still frame. The
 *     curve passes through the kernel's own ray positions; between them it
 *     is a Catmull–Rom display interpolation (×4), never new physics;
 *   · every ray that reaches the viewer (dashed: reflected / multiple /
 *     depth phases; brightness = the phase's strength in its band), with a
 *     glowing PACKET riding it at the clock and a short trail behind it;
 *   · the HYPOCENTRE at its catalogue depth inside the slice (joined to the
 *     epicentre), the epicentre (a pulsing marker — the pulse is a marker,
 *     not a wave), the viewer (a ring + a beacon along the local vertical),
 *     and every other catalogue quake on the visible surface, sized by
 *     magnitude;
 *   · the fronts as 3-D SURFACES (front-surfaces.js): the slice curve revolved
 *     about the epicentre axis through the removed half — PREM is spherically
 *     symmetric, so that IS the wavefront; toggle with `setSurfaces`;
 *   · the layer names on wall B (the stage cuts a WEDGE: wall A is the slice
 *     to the viewer, wall B the perpendicular plane through the epicentre axis,
 *     where — by the axial symmetry — the same fronts are drawn again).
 *   · fronts are taken from the +φ side and FOLDED (φ > π → 2π − φ): the −φ
 *     half of the slice is inside the solid now, and it is the same curve.
 * The clock is supplied by the page (live wall clock or a replay); the
 * stage never spins. The globe is lit by the Sun at the instant shown.
 */

import * as THREE from 'three';
import { planePoint, sweepPoint, wavefronts, positionAt, geoVec } from './quake-model.js';
import { R_EARTH_KM } from './prem.js';
import { GlowLines, GlowPoints } from './glow-lines.js';
import { FrontSurfaces } from './front-surfaces.js';

export const WAVE_COLORS = Object.freeze({ P: '#3987e5', S: '#d95926' });
const DASHED_KINDS = new Set(['reflected', 'multiple', 'depth']);
const LIFT = 1.002;
const ECHOES = [{ dt: 0, alpha: 1 }, { dt: 10, alpha: 0.30 }, { dt: 20, alpha: 0.14 }, { dt: 30, alpha: 0.06 }];
const TRAIL_S = 60, TRAIL_N = 14;
const PULSE_MS = 2400;
const LAYER_LABELS = [
    { text: 'Mantle', rKm: (R_EARTH_KM + 3480) / 2 + 600 },
    { text: 'Outer core · liquid', rKm: (3480 + 1221.5) / 2 },
    { text: 'Inner core', rKm: 560 },
];

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
// Display colours, LIFTED above the legend swatch so the glow reads on the dark cut
// (the core of the line is the swatch hue, brightened; the halo blooms).
const GLOW = { P: hexRgb('#4f9bff'), S: hexRgb('#ff6a2b') };

function ringTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const x = c.getContext('2d');
    x.beginPath(); x.arc(64, 64, 52, 0, Math.PI * 2); x.lineWidth = 10; x.strokeStyle = 'rgba(255,255,255,1)'; x.stroke();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; return t;
}
function burstTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d');
    x.translate(32, 32); x.fillStyle = '#ff7a3d'; x.strokeStyle = '#05080f'; x.lineWidth = 3;
    x.beginPath();
    for (let i = 0; i < 16; i++) { const r = i % 2 ? 11 : 27, a = i * Math.PI / 8; x.lineTo(r * Math.cos(a), r * Math.sin(a)); }
    x.closePath(); x.stroke(); x.fill();
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; return t;
}
const additiveSprite = (map, hex) => new THREE.Sprite(new THREE.SpriteMaterial({
    map, sizeAttenuation: false, depthTest: false, transparent: true, blending: THREE.AdditiveBlending,
    color: new THREE.Color().setHex(hex, THREE.NoColorSpace),
}));

/** Catmull–Rom through the points (display only), with per-point colours carried along. */
function smooth(pts, cols, k = 4) {
    if (pts.length < 3) return { pts, cols };
    const P = [], C = [];
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
        for (let j = 0; j < k; j++) {
            const t = j / k, t2 = t * t, t3 = t2 * t;
            P.push([0, 1, 2].map((a) => 0.5 * (2 * p1[a] + (-p0[a] + p2[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2 + (-p0[a] + 3 * p1[a] - 3 * p2[a] + p3[a]) * t3)));
            C.push(t < 0.5 ? cols[i] : cols[i + 1]);
        }
    }
    P.push(pts.at(-1)); C.push(cols.at(-1));
    return { pts: P, cols: C };
}

export class SeismicLayer {
    constructor(stage, { labelLayer = null, onPickQuake = () => {} } = {}) {
        this.stage = stage; this.labelLayer = labelLayer; this.onPickQuake = onPickQuake;
        this.group = new THREE.Group(); this.group.visible = false;
        stage.scene.add(this.group);

        this.fronts = new GlowLines({ width: 3, gain: 0.62, core: 1.3 });
        this.rays = new GlowLines({ width: 1.8, gain: 0.55, core: 1.2 });
        this.raysDashed = new GlowLines({ width: 1.8, gain: 0.5, core: 1.2, dash: 0.03 });
        this.trails = new GlowLines({ width: 3, gain: 0.8, core: 1.3 });
        this.marks = new GlowLines({ width: 2.4, gain: 1.0, core: 1.3 });
        this.packets = new GlowPoints();
        this.surfaces = new FrontSurfaces({ gain: 0.55 });
        this.surfaces.mesh.renderOrder = 4.5;
        this.group.add(this.surfaces.mesh);
        this.surfacesOn = !/[?&]fronts3d=0\b/.test(location.search);
        this.others = new GlowPoints();
        const objs = [this.rays.mesh, this.raysDashed.mesh, this.fronts.mesh, this.trails.mesh, this.marks.mesh, this.packets.points, this.others.points];
        objs.forEach((o, i) => { o.renderOrder = 5 + i * 0.01; this.group.add(o); });
        this._unsize = stage.onResize(({ w, h, dpr }) => {
            for (const g of [this.fronts, this.rays, this.raysDashed, this.trails, this.marks]) g.setResolution(w, h, dpr);
            this.packets.setDpr(dpr); this.others.setDpr(dpr);
        });

        this.epi = additiveSprite(burstTexture(), 0xffffff);
        this.pulse = additiveSprite(ringTexture(), 0xff7a3d);
        this.site = additiveSprite(ringTexture(), 0xffffff);
        for (const s of [this.epi, this.pulse, this.site]) { s.renderOrder = 6; this.group.add(s); }
        this.otherList = [];

        this.labels = {};
        if (labelLayer) {
            for (const k of ['epi', 'site', 'hypo']) { const s = document.createElement('span'); s.className = `ei-mlabel ei-mlabel--${k}`; labelLayer.appendChild(s); this.labels[k] = s; }
            this.layerLabels = LAYER_LABELS.map((L) => { const s = document.createElement('span'); s.className = 'ei-mlabel ei-mlabel--layer'; s.textContent = L.text; labelLayer.appendChild(s); return { ...L, el: s }; });
        } else this.layerLabels = [];

        this.state = null;            // { quake, site, plane, fan, rays }
        this._lastT = null; this._lastSun = 0;
        this._unhook = stage.onFrame((now) => this._place(now));
    }

    setVisible(on) {
        this.group.visible = on;
        for (const l of Object.values(this.labels)) l.style.display = on ? '' : 'none';
        for (const l of this.layerLabels) l.el.style.display = on ? '' : 'none';
    }

    /** The quake, the site, its slice plane and the Worker's payload (rays to the site, the fan). */
    setScene({ quake, site, plane, rays = [], fan = [], arrivals = [] }) {
        this.state = { quake, site, plane, rays, fan, arrivals };
        const P = (r, phi) => planePoint(plane, r, phi);
        this.epi.position.set(...geoVec(quake.lat, quake.lon)).multiplyScalar(LIFT);
        this.pulse.position.copy(this.epi.position);
        const siteV = new THREE.Vector3(...geoVec(site.lat, site.lon));
        this.site.position.copy(siteV).multiplyScalar(LIFT);
        if (this.labels.epi) this.labels.epi.textContent = `M${quake.mag.toFixed(1)}`;
        if (this.labels.site) this.labels.site.textContent = site.fallback ? 'NEIC' : 'You';
        if (this.labels.hypo) this.labels.hypo.textContent = `${Math.round(quake.depthKm)} km deep`;

        // Rays to the site, coloured per stretch by their wave; brightness = the phase's
        // STRENGTH in its band (amplitude.js) — a −50 dB partial reflection is drawn faint.
        const kindOf = new Map(arrivals.map((a) => [a.phase, a.kind]));
        const dbOf = new Map(arrivals.map((a) => [a.phase, a.db]));
        const alphaOf = (ph) => { const d = dbOf.get(ph); return d == null ? 0.25 : 0.12 + 0.78 * Math.max(0, Math.min(1, (d + 50) / 50)); };
        const solid = [], dashed = [];
        for (const r of rays) {
            if (!r.path) continue;
            const line = { points: r.path.map((n) => P(n.rKm, n.phi)), colors: r.path.map((n) => GLOW[n.wave]), alpha: alphaOf(r.phase) };
            (DASHED_KINDS.has(kindOf.get(r.phase)) ? dashed : solid).push(line);
            r.packed = packed(r.path);
        }
        this.rays.set(solid); this.raysDashed.set(dashed);

        // The hypocentre at depth, joined to the epicentre; the viewer's beacon on the local vertical.
        const hypo = P(R_EARTH_KM - quake.depthKm, 0), epiP = P(R_EARTH_KM, 0);
        const beacon = [siteV.clone().multiplyScalar(1.004).toArray(), siteV.clone().multiplyScalar(1.10).toArray()];
        this.hypoPos = new THREE.Vector3(...hypo);
        this.marks.set([
            { points: [hypo, epiP], color: [1.0, 0.5, 0.25], alpha: 0.55 },
            { points: beacon, colors: [[0.9, 0.95, 1.0], [0.05, 0.07, 0.1]], alpha: 1 },
        ]);
        // Layer names on wall B (the plane through the epicentre axis and n̂), clear of the rays on wall A.
        for (const L of this.layerLabels) L.pos = new THREE.Vector3(...sweepPoint(plane, L.rKm, 0.62 * Math.PI, Math.PI / 2));
        this._lastT = null;
    }

    /** Other catalogue quakes as surface dots: [{ id, lat, lon, mag }]. */
    setOthers(list) {
        // Dots on the half the slice removes would float in empty space: they are not drawn (or picked).
        this.otherList = list.filter((q) => !this.stage.isCut(new THREE.Vector3(...geoVec(q.lat, q.lon))));
        this.others.set(this.otherList.map((q) => ({
            p: new THREE.Vector3(...geoVec(q.lat, q.lon)).multiplyScalar(LIFT).toArray(),
            size: 5 + 2.4 * Math.max(0, (q.mag ?? 3) - 2.5),
            color: [0.95, 0.82, 0.62].map((v) => v * 0.8),
        })));
    }

    /** Draw the fronts and packets at t seconds after the origin. */
    setTime(tS) {
        if (!this.state || (this._lastT !== null && Math.abs(tS - this._lastT) < 0.05)) return;
        this._lastT = tS;
        const t0 = performance.now();
        try { this._setTime(tS); } finally { this.lastBuildMs = performance.now() - t0; }
    }
    _setTime(tS) {
        const { plane, fan, rays, quake } = this.state;
        const P = (r, phi) => planePoint(plane, r, phi);
        // The globe is lit by the Sun at the instant shown (throttled: it moves 0.25° a minute).
        const inst = quake.timeMs + tS * 1000;
        if (Math.abs(inst - this._lastSun) > 60_000) { this._lastSun = inst; this.stage.setSunDate(new Date(inst)); }

        const lines = [];
        const fold = (phi) => (phi > Math.PI ? 2 * Math.PI - phi : phi);
        const WALLS = [(r, phi) => P(r, fold(phi)), (r, phi) => sweepPoint(plane, r, phi, Math.PI / 2)];
        for (const e of ECHOES) {
            const t = tS - e.dt;
            if (t <= 0) continue;
            for (const f of wavefronts(fan, t)) {
                if (f.points[0].phi < 0) continue;            // the −φ side is the same curve (and inside the solid now)
                for (const W of WALLS) {
                    // Split where neighbouring rays left in very different directions (not one front).
                    let pts = [], cols = [];
                    const flush = () => { if (pts.length > 1) { const s = smooth(pts, cols); lines.push({ points: s.pts, colors: s.cols, alpha: e.alpha }); } pts = []; cols = []; };
                    for (let i = 0; i < f.points.length; i++) {
                        const a = f.points[i];
                        if (i > 0 && Math.abs(fold(a.phi) - fold(f.points[i - 1].phi)) > 0.35) flush();
                        pts.push(W(a.rKm, a.phi)); cols.push(GLOW[a.wave]);
                    }
                    flush();
                }
            }
        }
        this.fronts.set(lines);
        // The 3-D fronts: the +φ side of the CURRENT fronts, swept through the removed half.
        if (this.surfacesOn) {
            const now = [];
            for (const f of wavefronts(fan, tS)) if (f.points[0].phi >= 0) now.push(f);
            this.surfaces.set(now, plane, GLOW);
        }
        this.surfaces.mesh.visible = this.surfacesOn;

        // Packets riding each ray to the site, with a trail over the last TRAIL_S seconds.
        const heads = [], trails = [];
        for (const r of rays) {
            if (!r.packed) continue;
            const side = r.path.at(-1).phi < 0 ? -1 : 1;
            const q = positionAt(r.packed, tS);
            if (!q) continue;
            heads.push({ p: P(q.rKm, side * q.deltaRad), size: 13, color: GLOW[q.wave].map((v) => v * 1.1) });
            const pts = [], cols = [], al = [];
            for (let k = TRAIL_N; k >= 0; k--) {
                const s = positionAt(r.packed, tS - (k / TRAIL_N) * TRAIL_S);
                if (!s) continue;
                pts.push(P(s.rKm, side * s.deltaRad)); cols.push(GLOW[s.wave]); al.push(Math.pow(1 - k / TRAIL_N, 1.6));
            }
            if (pts.length > 1) trails.push({ points: pts, colors: cols, alphas: al.slice(-pts.length) });
        }
        this.packets.set(heads); this.trails.set(trails);
    }

    /** Show / hide the 3-D front surfaces. */
    setSurfaces(on) { this.surfacesOn = !!on; this.surfaces.mesh.visible = this.surfacesOn; this._lastT = null; }

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

    _sizeSprites(now) {
        const hpx = this.stage.canvas.clientHeight || 1, k = 2 * Math.tan(this.stage.camera.fov * Math.PI / 360) / hpx;
        const u = ((now ?? 0) % PULSE_MS) / PULSE_MS;
        this.epi.scale.setScalar(24 * k);
        this.pulse.scale.setScalar((18 + 46 * u) * k);
        this.pulse.material.opacity = 0.9 * (1 - u) * (1 - u);
        this.site.scale.setScalar(17 * k);
    }

    _place(now) {
        if (!this.group.visible || !this.state) return;
        this._sizeSprites(now);
        const cam = this.stage.camera, w = this.stage.canvas.clientWidth, h = this.stage.canvas.clientHeight;
        const camDir = cam.position.clone().normalize();
        const put = (el, v, dx = 12, dy = -8, hide = false) => {
            if (!el) return;
            el.style.display = hide ? 'none' : '';
            if (hide) return;
            const s = v.clone().project(cam);
            el.style.transform = `translate(${((s.x + 1) / 2 * w + dx).toFixed(1)}px, ${((1 - s.y) / 2 * h + dy).toFixed(1)}px)`;
        };
        put(this.labels.epi, this.epi.position, 12, -8, this.epi.position.clone().normalize().dot(camDir) < -0.2);
        put(this.labels.site, this.site.position, 12, -8, this.site.position.clone().normalize().dot(camDir) < -0.2);
        // A point INSIDE the planet is seen only if the sightline enters the sphere through the
        // removed wedge; otherwise the solid globe is in front of it (DOM labels are not depth-tested).
        const seen = (v) => {
            const o = cam.position, d = v.clone().sub(o), L = d.length(); d.divideScalar(L);
            const b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c;
            if (disc < 0) return true;
            const t = -b - Math.sqrt(disc);
            if (t < 0 || t > L) return true;
            return this.stage.isCut(o.clone().addScaledVector(d, t));
        };
        if (this.hypoPos) put(this.labels.hypo, this.hypoPos, 10, 6, !seen(this.hypoPos));
        // Layer names only while the cut faces the camera (edge-on they would pile up).
        const plane = this.state.plane, faceOn = camDir.dot(new THREE.Vector3(...plane.e2)) > 0.25;     // wall B faces +ê₂
        for (const L of this.layerLabels) if (L.pos) put(L.el, L.pos, -36, -6, !faceOn || !seen(L.pos));
    }
}

function packed(path) {
    const a = new Float64Array(4 * path.length);
    // Rays to the site are { rKm, phi, wave }; positionAt reads [r, δ, t, wave] — δ is |φ| and t comes from the node.
    path.forEach((n, i) => { a[4 * i] = n.rKm; a[4 * i + 1] = Math.abs(n.phi); a[4 * i + 2] = n.tS; a[4 * i + 3] = n.wave === 'S' ? 1 : 0; });
    return a;
}
