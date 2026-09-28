/**
 * upper-atmosphere-camera.js — orbit ⇄ free-fly camera controller
 * ═══════════════════════════════════════════════════════════════════════════
 * Wraps OrbitControls + a hand-rolled WASD/mouse-look fly mode behind a
 * single setMode() switch. The motivation: the upper-atmosphere page wants
 * users to *enter* the layers, not just orbit them — but the orbit camera
 * is still the right default for first-paint and for the satellite-ring
 * readouts. This controller keeps both alive and only one active.
 *
 * Modes
 *   'orbit'    — OrbitControls around the planet centre. Default.
 *   'fly'      — Free 6-DOF camera. WASD pans relative to look-direction,
 *                Q/E descend/ascend in world frame, Space/Shift accelerate
 *                /decelerate base speed, mouse-drag rotates view (no
 *                pointer-lock — keeps the click-to-fly affordance working
 *                against satellites).
 *
 * Public surface
 *   new CameraController(camera, domElement)
 *   .setMode('orbit'|'fly')                  switch active mode
 *   .getMode()
 *   .update(dt)                              call once per frame
 *   .flyTo(targetVec3, lookAtVec3?)          smooth camera move
 *   .getAltitudeKm()                         |camera position| → km above 1 R⊕
 *   .dispose()
 *
 * Notes for callers
 *   • Don't share OrbitControls.update() with this — call .update(dt) and
 *     it dispatches to whichever mode is active.
 *   • flyTo() works in any mode; in orbit mode it animates the orbit
 *     target + distance; in fly mode it animates the camera position +
 *     forward vector.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const R_EARTH_KM = 6371;

// Fly-mode tuning — base speed in R⊕/s, scaled by an exponential of the
// camera's distance from Earth so users can both crawl through a 50-km
// layer band and zip across the magnetosphere with the same key.
const FLY_BASE_SPEED  = 0.45;     // R⊕/s
const FLY_SHIFT_BOOST = 4.0;      // hold-Shift multiplier
const FLY_CRAWL       = 0.18;     // hold-Ctrl/Alt multiplier
// Mouse sensitivity in radians per pixel of drag. Tuned so a full
// monitor-width drag completes ~half a turn.
const FLY_LOOK_SENS   = 0.0035;

export class CameraController {
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {HTMLElement} domElement   pointer-event source (canvas)
     */
    constructor(camera, domElement) {
        this.camera = camera;
        this.dom = domElement;

        // OrbitControls owns the orbit-mode bookkeeping. We keep its
        // damping enabled so the transition feels consistent with the
        // page's existing behaviour.
        this._orbit = new OrbitControls(camera, domElement);
        this._orbit.enableDamping = true;
        this._orbit.dampingFactor = 0.08;
        this._orbit.minDistance = 1.05;       // allow grazing the surface
        this._orbit.maxDistance = 28;
        this._orbit.enablePan = false;
        this._orbit.rotateSpeed = 0.55;

        // Fly-mode state. Yaw / pitch are measured in a basis built on
        // `_up` — world +Y by default, the LOCAL RADIAL during and after a
        // layer transit — so the horizon the fly camera keeps level is the
        // one the user is actually looking at. With a fixed +Y, a transit
        // on the +Z side of the globe (lon −90°) handed back a view rolled
        // ~80° on the first fly frame (measured: quaternion Δ 0.47).
        this._mode = 'orbit';
        this._yaw = 0;
        this._pitch = 0;
        this._up = new THREE.Vector3(0, 1, 0);
        this._e1 = new THREE.Vector3(1, 0, 0);     // "right" at yaw 0
        this._e3 = new THREE.Vector3(0, 0, 1);     // "back" at yaw 0 (fwd = −e3)
        this._velocity = new THREE.Vector3();
        this._keys = new Set();
        this._dragging = false;
        this._lastMouse = { x: 0, y: 0 };

        // Smooth flyTo() animation.
        this._anim = null;

        // Object-follow state (Phase 25). The camera locks onto a
        // moving target — getPositionFn() is called every frame; the
        // camera repositions to an offset behind/above the target and
        // re-aims its lookAt. Used to "follow ISS" / "follow
        // STARLINK-XXXX" as they propagate via SGP4 each frame.
        // Cleared by stopFollowing() or by any user-initiated mode
        // change (orbit/fly button click).
        this._follow = null;

        // Cached camera basis — recomputed whenever yaw/pitch change.
        this._fwd   = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._up    = new THREE.Vector3(0, 1, 0);

        this._bindFly();
    }

    setMode(mode, { fromFollow = false } = {}) {
        if (mode !== 'orbit' && mode !== 'fly') return;
        // Phase 25: user-initiated mode changes break follow lock —
        // otherwise the operator would fight an invisible track. The
        // internal followObject() path passes fromFollow=true to bypass.
        if (!fromFollow) this._follow = null;
        if (mode === this._mode) return;

        if (mode === 'fly') {
            // Seed yaw/pitch from the camera's current orientation so the
            // transition is invisible.
            this.syncOrientationFromCamera();
            // Stop any orbit damping motion.
            this._orbit.enabled = false;
            this.dom.style.cursor = 'crosshair';
        } else {
            // OrbitControls orbits about the +Y it cached at construction;
            // give it back a +Y camera before it runs.
            this.setUpVector(new THREE.Vector3(0, 1, 0), { keepView: false });
            this.camera.up.set(0, 1, 0);
            // Re-aim orbit at planet centre while preserving camera
            // position so the user doesn't get yanked.
            this._orbit.target.set(0, 0, 0);
            this._orbit.enabled = true;
            this._orbit.update();
            this.dom.style.cursor = 'grab';
        }
        this._mode = mode;
    }

    /**
     * The fly camera's "up". Pass the local radial to fly level over a
     * point on the globe (the layer transit does), +Y to go back to the
     * page-wide default. With `keepView` the current view is re-expressed
     * in the new basis so nothing on screen moves.
     */
    setUpVector(v, { keepView = true } = {}) {
        if (!v || v.lengthSq() < 1e-12) return;
        this._up.copy(v).normalize();
        // Reference axis least aligned with up → a stable, right-handed basis
        // that reduces to (X, Y, Z) for up = +Y.
        const ref = Math.abs(this._up.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
        this._e1.crossVectors(this._up, ref).normalize();     // Y × Z = X
        this._e3.crossVectors(this._e1, this._up).normalize(); // X × Y = Z
        if (keepView) this.syncOrientationFromCamera();
    }
    getUpVector() { return this._up.clone(); }

    getMode() { return this._mode; }

    /**
     * Re-seed fly-mode yaw/pitch from the camera's CURRENT orientation.
     * Anything that drives the camera directly for a while (the layer
     * transit) calls this when it hands control back, so the first drag
     * continues from where the view is instead of snapping to a stale
     * heading. Same inversion as setMode('fly').
     */
    syncOrientationFromCamera() {
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
        // _stepFly builds fwd = e1·(sy·cp) + up·sp − e3·(cy·cp), so invert
        // with the same basis: pitch from up, yaw from (e1, −e3).
        this._pitch = Math.asin(Math.max(-1, Math.min(1, fwd.dot(this._up))));
        this._yaw   = Math.atan2(fwd.dot(this._e1), -fwd.dot(this._e3));
    }

    /** Total camera distance from Earth centre, expressed in km. */
    getAltitudeKm() {
        return (this.camera.position.length() - 1) * R_EARTH_KM;
    }

    /**
     * Animate the camera to `targetPos`, optionally pointing at
     * `lookAtPos`. Works in both modes.
     *
     * @param {THREE.Vector3} targetPos
     * @param {THREE.Vector3} [lookAtPos]
     * @param {number}        [durationSec=1.4]
     */
    flyTo(targetPos, lookAtPos = null, durationSec = 1.4) {
        // Snapshot start state.
        const start = {
            pos:  this.camera.position.clone(),
            quat: this.camera.quaternion.clone(),
        };
        // For end orientation: build a quaternion that points at lookAt.
        const endQuat = new THREE.Quaternion();
        if (lookAtPos) {
            const m = new THREE.Matrix4().lookAt(targetPos, lookAtPos, this._up);
            endQuat.setFromRotationMatrix(m);
        } else {
            endQuat.copy(start.quat);
        }
        this._anim = {
            t0:        performance.now() / 1000,
            duration:  durationSec,
            startPos:  start.pos,
            endPos:    targetPos.clone(),
            startQuat: start.quat,
            endQuat,
            lookAt:    lookAtPos?.clone() || null,
        };
    }

    /**
     * Engage follow-mode on a moving target. The supplied callback is
     * called every frame and must return a THREE.Vector3 in the
     * scene's world units (1 R⊕ = 1) for the target's current
     * position. The camera repositions to `offset` behind the target
     * each frame and re-aims its lookAt at the target. Follow is
     * gentle — the camera-to-offset position uses a critically-damped
     * spring (smoothing) so the operator doesn't experience jerks on
     * fast-moving low-orbit targets.
     *
     * Auto-switches to fly mode (so OrbitControls doesn't fight the
     * lock by pulling toward planet centre). Calling stopFollowing
     * leaves the camera at its last followed position; the operator
     * can then orbit / fly freely.
     *
     * @param {() => THREE.Vector3} getPositionFn
     * @param {object} [opts]
     * @param {THREE.Vector3} [opts.offset]  camera offset relative to
     *   the target's RADIAL direction (away from Earth centre).
     *   Default 0.18 R⊕ outward — clear view past Earth's limb.
     * @param {number} [opts.smoothing]      time-constant in seconds
     *   for the position spring. 0 = snap; 0.3 = noticeably smooth.
     */
    followObject(getPositionFn, { offset = null, smoothing = 0.15 } = {}) {
        if (typeof getPositionFn !== 'function') return;
        // Switch to fly mode (without breaking the follow lock).
        if (this._mode !== 'fly') this.setMode('fly', { fromFollow: true });
        this._follow = {
            getPos: getPositionFn,
            offset: offset ? offset.clone() : null,   // null → use radial-out default
            smoothing,
        };
    }

    stopFollowing() { this._follow = null; }
    isFollowing()   { return !!this._follow; }

    /** Reset to a default viewpoint — useful for a "Home" button. */
    resetView({ distance = 3.4, durationSec = 1.0 } = {}) {
        this._follow = null;
        this.setUpVector(new THREE.Vector3(0, 1, 0), { keepView: false });
        this.camera.up.set(0, 1, 0);
        const target = new THREE.Vector3(0, 0.65 * distance, distance);
        const lookAt = new THREE.Vector3(0, 0, 0);
        this.flyTo(target, lookAt, durationSec);
    }

    /** Snap to a polar (top-down) view of the planet. */
    flyToTopView({ distance = 4.5, durationSec = 1.0 } = {}) {
        this._follow = null;
        const target = new THREE.Vector3(0, distance, 0.001);   // ε for valid lookAt
        const lookAt = new THREE.Vector3(0, 0, 0);
        this.flyTo(target, lookAt, durationSec);
    }

    /** Per-frame update — call from the host's animate() loop. */
    update(dt) {
        // While a flyTo() animation is in progress we don't run mode-
        // specific update logic — the anim owns the camera. In orbit
        // mode in particular, OrbitControls would fight the anim by
        // pulling the camera back toward target every frame.
        if (this._anim) {
            this._stepAnim();
            return;
        }

        // Phase 25: follow-mode runs after any flyTo completes. The
        // target's position comes from getPositionFn — typically a
        // probe's mesh.position which is updated each frame by the
        // SGP4 propagator. We move the camera toward (target + offset)
        // with a critically-damped spring so a fast-moving LEO target
        // doesn't yank the view jerkily.
        if (this._follow) {
            this._stepFollow(dt);
            return;
        }

        if (this._mode === 'orbit') {
            this._orbit.update();
        } else {
            this._stepFly(dt);
        }
    }

    dispose() {
        this._unbindFly?.();
        this._orbit.dispose();
    }

    // ── Fly-mode internals ──────────────────────────────────────────────

    _bindFly() {
        const onKey = (down) => (e) => {
            // Don't capture keys while user is typing in form fields.
            const tag = (e.target?.tagName || '').toUpperCase();
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            const key = e.key.toLowerCase();
            if (down) this._keys.add(key);
            else      this._keys.delete(key);
            // Don't preventDefault — that would block tabbing/copy etc.
        };
        const onMouseDown = (e) => {
            if (this._mode !== 'fly') return;
            // Left button only — leave middle/right alone for browser UI.
            if (e.button !== 0) return;
            this._dragging = true;
            this._lastMouse.x = e.clientX;
            this._lastMouse.y = e.clientY;
            this.dom.style.cursor = 'grabbing';
        };
        const onMouseUp = () => {
            this._dragging = false;
            if (this._mode === 'fly') this.dom.style.cursor = 'crosshair';
        };
        const onMouseMove = (e) => {
            if (!this._dragging || this._mode !== 'fly') return;
            const dx = e.clientX - this._lastMouse.x;
            const dy = e.clientY - this._lastMouse.y;
            this._lastMouse.x = e.clientX;
            this._lastMouse.y = e.clientY;
            this._yaw   -= dx * FLY_LOOK_SENS;
            this._pitch -= dy * FLY_LOOK_SENS;
            // Clamp pitch a hair below the poles to avoid gimbal flip.
            const lim = Math.PI / 2 - 0.05;
            if (this._pitch >  lim) this._pitch =  lim;
            if (this._pitch < -lim) this._pitch = -lim;
        };

        const onKD = onKey(true);
        const onKU = onKey(false);

        window.addEventListener('keydown', onKD);
        window.addEventListener('keyup',   onKU);
        this.dom.addEventListener('mousedown', onMouseDown);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('mousemove', onMouseMove);
        this._unbindFly = () => {
            window.removeEventListener('keydown', onKD);
            window.removeEventListener('keyup',   onKU);
            this.dom.removeEventListener('mousedown', onMouseDown);
            window.removeEventListener('mouseup', onMouseUp);
            window.removeEventListener('mousemove', onMouseMove);
        };
    }

    _stepFly(dt) {
        // While a flyTo() animation owns the camera, defer to it
        // entirely — both position AND orientation come from the anim.
        // Once the anim ends, _stepAnim() seeds yaw/pitch back into
        // this controller so user input picks up cleanly.
        if (this._anim) return;

        // Build forward / right from yaw + pitch in the (e1, up, e3) basis —
        // (X, Y, Z) unless a transit set a local up. Convention unchanged:
        // yaw=0, pitch=0 → looking along −e3 (−Z in the default basis).
        const cy = Math.cos(this._yaw),   sy = Math.sin(this._yaw);
        const cp = Math.cos(this._pitch), sp = Math.sin(this._pitch);
        this._fwd.set(0, 0, 0)
            .addScaledVector(this._e1, sy * cp)
            .addScaledVector(this._up, sp)
            .addScaledVector(this._e3, -cy * cp).normalize();
        this._right.set(0, 0, 0)
            .addScaledVector(this._e1, cy)
            .addScaledVector(this._e3, sy).normalize();

        // Apply orientation. lookAt with an explicit target so up stays
        // the basis up (no roll).
        const tgt = this.camera.position.clone().add(this._fwd);
        this.camera.up.copy(this._up);
        this.camera.lookAt(tgt);

        // Distance-scaled base speed: when very close to Earth, slow down
        // so users can actually park inside a 50-km-thick layer band.
        const r = this.camera.position.length();
        const distScale = 0.30 + Math.min(2.5, r);
        let speed = FLY_BASE_SPEED * distScale;
        if (this._keys.has('shift')) speed *= FLY_SHIFT_BOOST;
        if (this._keys.has('control') || this._keys.has('alt')) speed *= FLY_CRAWL;

        // Translation accumulator (R⊕).
        const move = new THREE.Vector3();
        if (this._keys.has('w')) move.add(this._fwd);
        if (this._keys.has('s')) move.sub(this._fwd);
        if (this._keys.has('d')) move.add(this._right);
        if (this._keys.has('a')) move.sub(this._right);
        // Q/E descend/ascend along the basis up (world +Y by default, the
        // local vertical after a transit) so users can climb out of a layer
        // regardless of where they're looking.
        if (this._keys.has('e')) move.add(this._up);
        if (this._keys.has('q')) move.sub(this._up);

        if (move.lengthSq() > 0) {
            move.normalize().multiplyScalar(speed * dt);
            this.camera.position.add(move);
        }

        // Soft floor: never let the camera go inside the planet — push it
        // back to 1.005 R⊕ if the user runs into the surface.
        const dist = this.camera.position.length();
        if (dist < 1.005) {
            this.camera.position.multiplyScalar(1.005 / dist);
        }
        // And a soft ceiling at 30 R⊕ so users can't get lost.
        if (dist > 30) {
            this.camera.position.multiplyScalar(30 / dist);
        }
    }

    _stepFollow(dt) {
        const f = this._follow;
        let tgt;
        try { tgt = f.getPos(); } catch (_) { tgt = null; }
        if (!tgt || !Number.isFinite(tgt.x)) { this._follow = null; return; }

        // Default offset: 0.18 R⊕ radially outward from the target so
        // the camera looks at the target with Earth's limb behind it.
        // Caller can supply a custom THREE.Vector3 offset which is
        // applied in WORLD frame (e.g. north-up offset for a polar
        // tracking view).
        const camPos = tgt.clone();
        if (f.offset) {
            camPos.add(f.offset);
        } else {
            const radial = tgt.clone().normalize().multiplyScalar(0.18);
            camPos.add(radial);
        }

        // Critically-damped position spring. dt-aware so behaviour is
        // frame-rate independent.
        const k = 1 - Math.exp(-dt / Math.max(0.001, f.smoothing));
        this.camera.position.lerp(camPos, k);
        // A fast target (time-warp on a slow renderer: the flight probe or a
        // satellite can move tens of degrees between frames) puts the lerp's
        // CHORD inside the planet — measured: camera at −171 km after a
        // 600× chase. Keep the camera at least at the target's own radius.
        const rMin = tgt.length() + 0.02;
        if (this.camera.position.length() < rMin) this.camera.position.setLength(rMin);

        // Re-aim. Use lookAt with world-Y up so the horizon stays level.
        this.camera.up.set(0, 1, 0);
        this.camera.lookAt(tgt);

        // Seed yaw/pitch from the lookAt direction so if the operator
        // stops following + drives the fly camera manually, controls
        // pick up cleanly (the follow keeps +Y up; re-express in it).
        if (this._up.y < 0.999) this.setUpVector(new THREE.Vector3(0, 1, 0), { keepView: false });
        this.syncOrientationFromCamera();
    }

    _stepAnim() {
        const a = this._anim;
        const now = performance.now() / 1000;
        const t = Math.min(1, (now - a.t0) / a.duration);
        // Ease in/out (smoothstep).
        const k = t * t * (3 - 2 * t);

        this.camera.position.lerpVectors(a.startPos, a.endPos, k);
        this.camera.quaternion.slerpQuaternions(a.startQuat, a.endQuat, k);

        if (t >= 1) {
            // On completion, sync the active mode so user-input picks up
            // cleanly from the new pose.
            if (this._mode === 'fly' && a.lookAt) {
                this.syncOrientationFromCamera();
            } else if (this._mode === 'orbit') {
                this._orbit.target.set(0, 0, 0);
                this._orbit.update();
            }
            this._anim = null;
        }
    }
}
