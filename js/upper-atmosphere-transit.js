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
 *   • SPEED STREAKS. When the camera moves through the gas (a transit, an
 *     explore cruise, a dive) every dot also draws a line from where it is
 *     to where it appeared `STREAK.exposureS` ago — a camera shutter, which
 *     is the depth cue exploration games use for speed. Streaks are the
 *     CAMERA's motion, not the gas's: the gas's own drift is its thermal
 *     jitter and stays a dot. They switch off at rest.
 *
 * The transit hands the camera to EXPLORE mode (flight along the sphere),
 * so the first key after arriving flies level over the ground instead of
 * off along a straight line out of the band.
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

/** Speed-streak tuning. Exposure is a shutter time; lengths in R⊕. */
export const STREAK = Object.freeze({
    exposureS: 0.12,
    minLenRunit: 0.0012,     // below ~8 km of apparent motion a dot stays a dot
    maxLenRunit: 0.045,      // 1.5 × the cloud radius
    smoothS: 0.15,           // velocity EMA time constant
});

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

        // Speed streaks: one segment per dot, head bright, tail black
        // (additive, so the tail fades out rather than darkening anything).
        this._sPos = new Float32Array(N * 6);
        this._sCol = new Float32Array(N * 6);
        const sgeo = new THREE.BufferGeometry();
        sgeo.setAttribute('position', new THREE.BufferAttribute(this._sPos, 3));
        sgeo.setAttribute('color', new THREE.BufferAttribute(this._sCol, 3));
        sgeo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        sgeo.attributes.color.setUsage(THREE.DynamicDrawUsage);
        sgeo.setDrawRange(0, 0);
        this._streaks = new THREE.LineSegments(sgeo, new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.55,
            depthWrite: false, blending: THREE.AdditiveBlending,
        }));
        this._streaks.frustumCulled = false;
        this._streaks.name = 'gas-streaks';
        this._streaks.visible = false;
        this._streaks.userData = { kind: 'gas-streaks' };
        scene.add(this._streaks);
        this._vel = new THREE.Vector3();
        this._lastCam = null;
        this._streakLen = 0;

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
        this._controls.cancelPath?.('superseded');
        this._controls._anim = null;
        // The transit owns the pose; explore takes over from wherever it
        // leaves the camera (flight along the sphere, up = local radial).
        if (this._controls.getMode() !== 'explore') this._controls.setMode('explore');
        this._controls.setExternalDriver?.(true);
        // Fly mode, if the user switches to it later, flies level here too.
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
        // Hand the pose back: the active mode re-seeds from it.
        if (this._controls.setExternalDriver) this._controls.setExternalDriver(false);
        else this._controls.syncOrientationFromCamera?.();
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
    setCloudVisible(on) {
        this._cloudVisible = !!on;
        if (!on) { this._cloud.visible = false; this._streaks.visible = false; }
    }
    getCloudVisible() { return this._cloudVisible; }
    getGas() { return this._gas; }
    getCloudCount() { return this._cloud.visible ? this._cloud.geometry.drawRange.count : 0; }
    /** Streak segments drawn this frame, and their apparent length (R⊕). */
    getStreakInfo() {
        return {
            count: this._streaks.visible ? this._streaks.geometry.drawRange.count / 2 : 0,
            lengthRunit: this._streaks.visible ? this._streakLen : 0,
            speedKmS: this._vel.length() * R_EARTH_KM,
        };
    }

    /** Camera velocity through the gas, smoothed; scene units per second. */
    _trackVelocity(cam, dtReal) {
        const p = cam.position;
        if (this._lastCam && dtReal > 1e-4) {
            const dx = p.x - this._lastCam.x, dy = p.y - this._lastCam.y, dz = p.z - this._lastCam.z;
            const jump = Math.hypot(dx, dy, dz);
            if (jump > 0.5) {
                this._vel.set(0, 0, 0);                  // a teleport, not a motion
            } else {
                const k = 1 - Math.exp(-dtReal / STREAK.smoothS);
                this._vel.x += (dx / dtReal - this._vel.x) * k;
                this._vel.y += (dy / dtReal - this._vel.y) * k;
                this._vel.z += (dz / dtReal - this._vel.z) * k;
            }
        }
        if (!this._lastCam) this._lastCam = p.clone(); else this._lastCam.copy(p);
    }

    _drawStreaks(n) {
        const v = this._vel;
        let L = v.length() * STREAK.exposureS;
        if (L < STREAK.minLenRunit || n === 0) {
            this._streaks.visible = false;
            this._streakLen = 0;
            return;
        }
        const k = Math.min(1, STREAK.maxLenRunit / L);
        L *= k;
        this._streakLen = L;
        const ox = v.x * STREAK.exposureS * k, oy = v.y * STREAK.exposureS * k, oz = v.z * STREAK.exposureS * k;
        const P = this._pos, C = this._col, SP = this._sPos, SC = this._sCol;
        // Longer streaks spread the same light along more pixels; hold the
        // total roughly constant so a boost does not white out the view.
        const gain = Math.min(1, 0.012 / L + 0.35);
        for (let i = 0; i < n; i++) {
            const o = i * 3, q = i * 6;
            SP[q] = P[o]; SP[q + 1] = P[o + 1]; SP[q + 2] = P[o + 2];
            SP[q + 3] = P[o] + ox; SP[q + 4] = P[o + 1] + oy; SP[q + 5] = P[o + 2] + oz;
            SC[q] = C[o] * gain; SC[q + 1] = C[o + 1] * gain; SC[q + 2] = C[o + 2] * gain;
            SC[q + 3] = 0; SC[q + 4] = 0; SC[q + 5] = 0;
        }
        const g = this._streaks.geometry;
        g.setDrawRange(0, n * 2);
        g.attributes.position.needsUpdate = true;
        g.attributes.color.needsUpdate = true;
        this._streaks.visible = true;
    }

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
        this._trackVelocity(cam, dtReal);
        if (!this._cloudVisible) return;
        const altKm = (cam.position.length() - 1) * R_EARTH_KM;
        if (altKm > MODEL_CEIL_KM || altKm < MODEL_FLOOR_KM - 5) {
            this._cloud.visible = false;
            this._streaks.visible = false;
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
        if (!gas || gas.count === 0) { this._cloud.visible = false; this._streaks.visible = false; return; }
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
            if (d2 > 4 * R2) {
                // Left more than a cloud diameter behind (a dive covers
                // hundreds of km per frame): mirroring would re-enter EVERY
                // dot in the one narrow cone pointing back at the old cloud
                // — measured as all the streaks bunched in a corner — so
                // re-seed it uniformly in the ball instead.
                let x, y, z;
                do { x = Math.random() * 2 - 1; y = Math.random() * 2 - 1; z = Math.random() * 2 - 1; }
                while (x * x + y * y + z * z > 1);
                P[o] = cx + x * R; P[o + 1] = cy + y * R; P[o + 2] = cz + z * R;
            } else if (d2 > R2) {
                // Re-enter on the opposite side, slightly inside, so a moving
                // camera sees a continuous stream of gas.
                const k = 0.97 * R / Math.sqrt(d2);
                P[o] = cx - dx * k; P[o + 1] = cy - dy * k; P[o + 2] = cz - dz * k;
            }
        }
        this._cloud.geometry.attributes.position.needsUpdate = true;
        this._drawStreaks(n);
    }

    dispose() {
        window.removeEventListener('keydown', this._onKey);
        this._canvas.removeEventListener('mousedown', this._onDown);
        this._scene.remove(this._cloud);
        this._scene.remove(this._streaks);
        this._streaks.geometry.dispose();
        this._streaks.material.dispose();
        this._cloud.geometry.dispose();
        this._cloud.material.map?.dispose();
        this._cloud.material.dispose();
    }
}
