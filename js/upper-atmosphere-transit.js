/**
 * upper-atmosphere-transit.js — riding the local vertical, in the gas
 * ═══════════════════════════════════════════════════════════════════════════
 * three.js half of the layer-transit mode (kernel: -transit-model.js).
 *
 *   • THE TRANSIT drives the camera up or down the local vertical above
 *     the sub-camera point at a chosen rate (km of altitude per second of
 *     real time), horizon level, looking along a compass heading with a
 *     slight down-pitch so the limb band and the airglow layers come up to
 *     meet you. It STARTS a flight and never HOLDS the camera against the
 *     user (the TIGA rule): any fly key or a drag on the canvas releases
 *     it, and the fly controller is re-seeded from the pose it left, so
 *     the first drag continues from the view rather than snapping.
 *
 *   • THE AMBIENT GAS is a camera-local point cloud, re-sampled from the
 *     kernel's `ambientGas` at the camera's altitude: dot count ∝ log₁₀ n,
 *     colour per species drawn from the engine's fractions, drift ∝ v_th,
 *     heading changes ∝ collision frequency. The cloud lives in WORLD
 *     space; a dot that leaves the sphere around the camera is wrapped to
 *     the far side, which is what makes a fast descent read as gas
 *     streaming past rather than a static snow globe.
 *
 * Symbolic, and disclosed: one dot is not one molecule.
 */

import * as THREE from 'three';
import {
    ambientGas, assignSpecies, transitPose, poseFromPosition, transitAltitude,
    CLOUD, MODEL_FLOOR_KM, MODEL_CEIL_KM, R_EARTH_KM, TRANSIT_FLOOR_KM,
} from './upper-atmosphere-transit-model.js';
import { capPointSize } from './upper-atmosphere-point-cap.js';

const CANCEL_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);

function _dotTexture(size = 32) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c); t.needsUpdate = true;
    return t;
}

export class AtmosphereTransit {
    /**
     * @param {THREE.Scene} scene
     * @param {object} deps
     * @param {import('./upper-atmosphere-camera.js').CameraController} deps.controls
     * @param {HTMLCanvasElement} deps.canvas
     */
    constructor(scene, { controls, canvas, onStart = null, onStop = null }) {
        this._scene = scene;
        this._controls = controls;
        this._canvas = canvas;
        this._onStart = onStart;
        this._onStop = onStop;
        this._state = { active: false, paused: false, done: false, mode: null,
                        fromKm: 0, toKm: 0, kmPerSec: 50, tS: 0, altKm: NaN,
                        latDeg: 0, lonDeg: 0, headingDeg: 90, pitchDeg: -6 };
        this._gas = null;
        this._gasKey = '';
        this._gasAt = 0;
        this._cloudVisible = true;

        const N = CLOUD.maxDots;
        this._pos = new Float32Array(N * 3);
        this._col = new Float32Array(N * 3);
        this._dir = new Float32Array(N * 3);
        this._seeded = false;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(this._col, 3));
        geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        geo.attributes.color.setUsage(THREE.DynamicDrawUsage);
        geo.setDrawRange(0, 0);
        // Capped and dimmed at the lens: a dot a few hundred metres away
        // otherwise drew 71 px wide and neighbours stacked into white blobs
        // under additive blending (measured at 95 km).
        this._cloud = new THREE.Points(geo, capPointSize(new THREE.PointsMaterial({
            size: CLOUD.dotSizeRunit, sizeAttenuation: true, vertexColors: true,
            map: _dotTexture(), transparent: true, opacity: 0.6, depthWrite: false,
            blending: THREE.AdditiveBlending,
        }), { maxPx: 14 }));
        this._cloud.frustumCulled = false;
        this._cloud.name = 'ambient-gas';
        this._cloud.visible = false;
        this._cloud.userData = { kind: 'ambient-gas' };
        scene.add(this._cloud);
        this._tmp = new THREE.Vector3();
        this._tmpC = new THREE.Color();

        // Release on user input — the page may START a flight, not HOLD the camera.
        this._onKey = (e) => {
            const tag = (e.target?.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (this._state.active && CANCEL_KEYS.has((e.key || '').toLowerCase())) this.stop('key');
        };
        this._onDown = (e) => { if (this._state.active && e.button === 0) this.stop('drag'); };
        window.addEventListener('keydown', this._onKey);
        canvas.addEventListener('mousedown', this._onDown);
    }

    // ── transit ────────────────────────────────────────────────────────
    /**
     * @param {object} o
     * @param {'descend'|'ascend'} o.mode
     * @param {number} [o.kmPerSec=50]
     * @param {number} [o.toKm]         default: the model floor / ceiling
     * @param {number} [o.headingDeg]   default: the camera's current heading, else east
     * @param {number} [o.pitchDeg=-6]
     * @param {number} [o.fromKm]       default: the camera's altitude clamped to the band
     */
    start({ mode = 'descend', kmPerSec = 50, toKm = null, headingDeg = null, pitchDeg = -6, fromKm = null } = {}) {
        const cam = this._controls.camera;
        const here = poseFromPosition([cam.position.x, cam.position.y, cam.position.z]);
        const s = this._state;
        s.mode = mode;
        s.kmPerSec = Math.max(0.1, kmPerSec);
        s.latDeg = here.latDeg; s.lonDeg = here.lonDeg;
        const clampBand = (a) => Math.max(TRANSIT_FLOOR_KM, Math.min(MODEL_CEIL_KM, a));
        s.fromKm = Number.isFinite(fromKm) ? clampBand(fromKm) : clampBand(here.altKm);
        s.toKm = Number.isFinite(toKm) ? clampBand(toKm) : (mode === 'descend' ? TRANSIT_FLOOR_KM : MODEL_CEIL_KM);
        if (Number.isFinite(headingDeg)) {
            s.headingDeg = headingDeg;
        } else {
            // Current forward projected onto the local horizontal, if it has one.
            const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
            const pose0 = transitPose({ latDeg: s.latDeg, lonDeg: s.lonDeg, altKm: s.fromKm, headingDeg: 0, pitchDeg: 0 });
            const up = new THREE.Vector3(...pose0.up);
            const north = new THREE.Vector3(...pose0.forward);
            const east = new THREE.Vector3().crossVectors(north, up);
            const h = fwd.clone().sub(up.clone().multiplyScalar(fwd.dot(up)));
            s.headingDeg = h.lengthSq() > 1e-4
                ? ((Math.atan2(h.dot(east), h.dot(north)) * 180 / Math.PI) + 360) % 360
                : 90;
        }
        s.pitchDeg = pitchDeg;
        s.tS = 0; s.done = false; s.paused = false; s.active = true;
        s.altKm = s.fromKm;
        this._controls.stopFollowing?.();
        if (this._controls.getMode() !== 'fly') this._controls.setMode('fly');
        this._controls._anim = null;
        // The fly camera flies LEVEL over this point from now on: its up is
        // the local radial (constant along a vertical), so releasing the
        // transit hands back exactly the view it left.
        const pose0 = transitPose({ latDeg: s.latDeg, lonDeg: s.lonDeg, altKm: s.fromKm, headingDeg: 0, pitchDeg: 0 });
        this._controls.setUpVector?.(new THREE.Vector3(...pose0.up), { keepView: false });
        this._apply(cam);
        try { this._onStart?.(this.getState()); } catch (_) { /* isolate */ }
        this._emit('start');
        return this.getState();
    }
    stop(reason = 'stop') {
        if (!this._state.active) return;
        this._state.active = false;
        this._state.paused = false;
        this._controls.syncOrientationFromCamera?.();
        try { this._onStop?.(this.getState(), reason); } catch (_) { /* isolate */ }
        this._emit('stop', reason);
    }
    setPaused(on) {
        if (!this._state.active) return;
        this._state.paused = !!on;
        this._emit(on ? 'pause' : 'resume');
    }
    getState() { return { ...this._state }; }

    _apply(cam) {
        const s = this._state;
        const pose = transitPose({ latDeg: s.latDeg, lonDeg: s.lonDeg, altKm: s.altKm,
                                   headingDeg: s.headingDeg, pitchDeg: s.pitchDeg });
        cam.position.set(pose.position[0], pose.position[1], pose.position[2]);
        cam.up.set(pose.up[0], pose.up[1], pose.up[2]);
        this._tmp.set(pose.position[0] + pose.forward[0], pose.position[1] + pose.forward[1], pose.position[2] + pose.forward[2]);
        cam.lookAt(this._tmp);
    }

    _emit(kind, reason) {
        try {
            window.dispatchEvent(new CustomEvent('ua-transit', { detail: { kind, reason, ...this.getState() } }));
        } catch (_) { /* SSR */ }
    }

    // ── ambient gas ────────────────────────────────────────────────────
    setCloudVisible(on) { this._cloudVisible = !!on; if (!on) this._cloud.visible = false; }
    getCloudVisible() { return this._cloudVisible; }
    getGas() { return this._gas; }
    getCloudCount() { return this._cloud.visible ? this._cloud.geometry.drawRange.count : 0; }

    _seedCloud(cam) {
        const R = CLOUD.radiusRunit;
        for (let i = 0; i < CLOUD.maxDots; i++) {
            // Uniform in a ball around the camera.
            let x, y, z;
            do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; }
            while (x * x + y * y + z * z > 1);
            this._pos[i * 3] = cam.position.x + x * R;
            this._pos[i * 3 + 1] = cam.position.y + y * R;
            this._pos[i * 3 + 2] = cam.position.z + z * R;
            this._randomDir(i);
        }
        this._seeded = true;
    }
    _randomDir(i) {
        const u = Math.random() * 2 - 1, ph = Math.random() * Math.PI * 2;
        const r = Math.sqrt(1 - u * u);
        this._dir[i * 3] = r * Math.cos(ph); this._dir[i * 3 + 1] = r * Math.sin(ph); this._dir[i * 3 + 2] = u;
    }
    _recolour(gas, count) {
        const idx = assignSpecies(gas, count, 1234567);
        for (let i = 0; i < count; i++) {
            const sp = gas.species[idx[i]] || gas.species[0];
            this._tmpC.set(sp ? sp.hex : 0xffffff);
            this._col[i * 3] = this._tmpC.r; this._col[i * 3 + 1] = this._tmpC.g; this._col[i * 3 + 2] = this._tmpC.b;
        }
        this._cloud.geometry.attributes.color.needsUpdate = true;
    }

    /**
     * Per frame. `dt` is a REAL wall-clock delta (the globe's own dt is ~0).
     */
    update(cam, dt, { f107 = 150, ap = 15 } = {}) {
        const s = this._state;
        // The transit rate is km per second of REAL time, so it keeps its own
        // clock: the frame delta the globe hands out is capped at 0.1 s for
        // the follow spring's sake, and on a slow renderer a 200 km/s descent
        // ran at ~60 km/s on it (measured). Capped at 1 s so a backgrounded
        // tab does not teleport the camera on return.
        const now = performance.now();
        const dtReal = this._lastMs == null ? dt : Math.min(1, (now - this._lastMs) / 1000);
        this._lastMs = now;
        if (s.active) {
            if (!s.paused && !s.done) {
                s.tS += dtReal;
                const a = transitAltitude({ fromKm: s.fromKm, toKm: s.toKm, kmPerSec: s.kmPerSec, tS: s.tS });
                s.altKm = a.altKm;
                if (a.done) { s.done = true; s.paused = true; this._emit('arrived'); }
            }
            this._apply(cam);
        }

        // Ambient gas.
        if (!this._cloudVisible) return;
        const altKm = (cam.position.length() - 1) * R_EARTH_KM;
        if (altKm > MODEL_CEIL_KM || altKm < MODEL_FLOOR_KM - 5) {
            this._cloud.visible = false;
            return;
        }
        const key = `${Math.round(altKm / 2)}|${Math.round(f107)}|${Math.round(ap)}`;
        if (key !== this._gasKey && now - this._gasAt > 120) {
            const prev = this._gas;
            this._gas = ambientGas({ altitudeKm: altKm, f107Sfu: f107, ap });
            this._gasKey = key; this._gasAt = now;
            const count = this._gas.count;
            const speciesSig = this._gas.species.map(x => `${x.id}:${x.fraction.toFixed(2)}`).join(',');
            if (!prev || prev.count !== count || this._speciesSig !== speciesSig) {
                this._recolour(this._gas, count);
                this._speciesSig = speciesSig;
            }
            this._cloud.geometry.setDrawRange(0, count);
            this._cloud.material.opacity = 0.35 + 0.5 * this._gas.densityNorm;
        }
        const gas = this._gas;
        if (!gas || gas.count === 0) { this._cloud.visible = false; return; }
        if (!this._seeded) this._seedCloud(cam);
        this._cloud.visible = true;

        // Advance the dots: drift along their heading, re-draw the heading
        // at the collision rate, wrap to the far side of the camera sphere.
        const R = CLOUD.radiusRunit, R2 = R * R;
        const step = Math.min(CLOUD.maxStepRunit, gas.driftRunitPerS * dt);
        const pFlip = Math.min(1, gas.headingChangeHz * dt);
        const cx = cam.position.x, cy = cam.position.y, cz = cam.position.z;
        const P = this._pos, D = this._dir, n = gas.count;
        for (let i = 0; i < n; i++) {
            const o = i * 3;
            if (Math.random() < pFlip) this._randomDir(i);
            P[o] += D[o] * step; P[o + 1] += D[o + 1] * step; P[o + 2] += D[o + 2] * step;
            const dx = P[o] - cx, dy = P[o + 1] - cy, dz = P[o + 2] - cz;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 > R2) {
                // Re-enter on the opposite side, slightly inside, so a moving
                // camera sees a continuous stream of gas.
                const k = 0.97 * R / Math.sqrt(d2);
                P[o] = cx - dx * k; P[o + 1] = cy - dy * k; P[o + 2] = cz - dz * k;
            }
        }
        this._cloud.geometry.attributes.position.needsUpdate = true;
    }

    dispose() {
        window.removeEventListener('keydown', this._onKey);
        this._canvas.removeEventListener('mousedown', this._onDown);
        this._scene.remove(this._cloud);
        this._cloud.geometry.dispose();
        this._cloud.material.map?.dispose();
        this._cloud.material.dispose();
    }
}
