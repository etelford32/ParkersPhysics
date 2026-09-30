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
 *   'explore'  — Flight ALONG the sphere inside the 80–2000 km band (the
 *                kernel is js/upper-atmosphere-explore-model.js): W/S fly
 *                where you look, A/D turn, Q/E climb in log-altitude,
 *                Shift boost, Ctrl crawl, drag to look. Up is always the
 *                local radial, so the horizon is level everywhere.
 *
 * Transitions (`runPath`) — a dive into the band or the climb back out —
 * own the camera until they finish, and ANY input cancels them where they
 * are (the TIGA rule: the page may start a flight, it may not hold the
 * camera). An external driver (the layer transit) can claim the camera
 * with `setExternalDriver(true)`; the active mode re-seeds from the pose
 * it is handed back.
 *
 * THE RIG (2026-09-30, js/upper-atmosphere-camera-rig.js is the PURE math):
 *   • Orbit mode PANS and SWIVELS, not just rotates. A drag TOOL picks what
 *     the left button / one finger does ('orbit' | 'pan' | 'swivel');
 *     right-drag always pans (rotates under the pan tool), Shift/Ctrl+drag
 *     pans, Alt+drag swivels (a tripod head: the camera stays, the view
 *     turns). Pan and swivel move the PIVOT, and the pivot is bounded
 *     (`clampPivot`) — the TIGA lesson: an unbounded pan orbits nothing.
 *   • THE ORBIT FRAME IS REBUILT, NEVER RE-AIMED. Vendored r160
 *     OrbitControls caches its orbit axis from `camera.up` at construction
 *     (OrbitControls.js:177) and ignores later assignments, so a limb view
 *     — pivot ON the limb, orbit axis = the local radial — rebuilds the
 *     controls with `camera.up` set FIRST (`_buildOrbit`), exactly the
 *     Stage / Mars / Moon rule. `setMode('orbit')` and every Reset rebuild
 *     the planet frame (+Y about the centre). `_orbit` is therefore
 *     re-assigned; nothing outside this file may hold a reference to it.
 *   • Keyboard in orbit mode while the pointer is over the globe (or the
 *     canvas has focus): arrows orbit, Shift+arrows pan, +/− dolly toward
 *     the pivot, [ / ] change the lens. Gated so a focused slider or the
 *     page scroll keep their arrow keys.
 *   • The LENS is a control (`setFov`, 2°–90°). A running path restores
 *     the lens the user chose, not the one it started with.
 *
 * Public surface
 *   new CameraController(camera, domElement)
 *   .setMode('orbit'|'fly'|'explore')        switch active mode
 *   .setDragTool('orbit'|'pan'|'swivel')     what a left drag does in orbit
 *   .setFov(deg) / .getFov()                 the lens
 *   .limbView(pose)                          fly to a limb pose, then orbit
 *                                            about the limb point
 *   .dolly(factor) / .recenterPivot()        pivot-aware zoom / re-centre
 *   .getRigState()                           pivot, orbit axis, tool, lens
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
import {
    stateFromPose, explorePose, exploreStep, transitionFovGain, EXPLORE,
} from './upper-atmosphere-explore-model.js';
// Paths and flyTo animations time themselves on the shared frame clock, so
// the test hook's stepped frames drive them exactly.
import { frameClock } from './upper-atmosphere-frame-clock.js';
import {
    RIG, DRAG_TOOLS, clampFov, clampPivot, liftAboveSurface, panPivot, swivelTarget,
    orbitAround, dollyToward,
} from './upper-atmosphere-camera-rig.js';

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
// Keys that move the camera, and therefore cancel a transition in flight.
const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e']);
// Orbit-mode rig keys, by KeyboardEvent.code (layout- and Shift-proof).
const RIG_CODES = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Equal', 'Minus', 'NumpadAdd', 'NumpadSubtract', 'BracketLeft', 'BracketRight']);
const _arr = (v) => [v.x, v.y, v.z];

export class CameraController {
    /**
     * @param {THREE.PerspectiveCamera} camera
     * @param {HTMLElement} domElement   pointer-event source (canvas)
     */
    constructor(camera, domElement) {
        this.camera = camera;
        this.dom = domElement;

        // OrbitControls owns the orbit-mode bookkeeping. It is REBUILT
        // whenever the orbit axis changes (see the header) — `_buildOrbit`
        // is the only place one is made.
        this._dragTool = 'orbit';
        this._maxDistance = 28;
        this._orbitUp = new THREE.Vector3(0, 1, 0);
        this._orbit = null;
        this._buildOrbit(this._orbitUp, new THREE.Vector3(0, 0, 0));
        // Keyboard rig state: physical key codes held, and whether the
        // pointer is over the globe (the gate for arrow keys).
        this._codes = new Set();
        this._hover = false;
        this._swivel = null;

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

        // Explore mode: the kernel state { u, h, altKm, pitchRad } and the
        // last step's speeds (for the HUD). Mouse-look accumulates here and
        // is consumed by the next step.
        this._explore = null;
        this._exploreInfo = null;
        this._lookDx = 0;
        this._lookDy = 0;
        // A transition (dive / climb) in progress, and the external driver flag.
        this._path = null;
        this._external = false;
        this._tmpV = new THREE.Vector3();

        this._bindFly();
    }

    setMode(mode, { fromFollow = false } = {}) {
        if (mode !== 'orbit' && mode !== 'fly' && mode !== 'explore') return;
        // Phase 25: user-initiated mode changes break follow lock —
        // otherwise the operator would fight an invisible track. The
        // internal followObject() path passes fromFollow=true to bypass.
        if (!fromFollow) this._follow = null;
        // Orbit while already orbiting a limb point (or a panned pivot):
        // go back to orbiting the PLANET, turning the view smoothly.
        if (mode === 'orbit' && this._mode === 'orbit' && !this._isPlanetFrame()) {
            this.recenterPivot();
            return;
        }
        if (mode === this._mode) return;
        const prev = this._mode;

        if (mode === 'explore') {
            // Seed the sphere-flight state from wherever the camera is; the
            // altitude clamps into the band (callers above the band DIVE in
            // rather than asking for this directly).
            this._orbit.enabled = false;
            this._mode = 'explore';
            this._seedExplore();
            this.dom.style.cursor = 'crosshair';
            return;
        }
        if (mode === 'fly') {
            // Leaving explore: keep flying level over the same point, so
            // the first fly frame does not roll the view.
            if (prev === 'explore') {
                this.setUpVector(this.camera.position.clone().normalize(), { keepView: false });
            }
            // Seed yaw/pitch from the camera's current orientation so the
            // transition is invisible.
            this.syncOrientationFromCamera();
            // Stop any orbit damping motion.
            this._orbit.enabled = false;
            this.dom.style.cursor = 'crosshair';
        } else {
            // OrbitControls orbits about the +Y it cached at construction;
            // rebuild it about the planet (+Y, centre) before it runs.
            // Re-aim at the planet centre while preserving camera position.
            this._enterOrbitFrame(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0));
            return;
        }
        this._mode = mode;
    }

    // ── The orbit frame (see the header: rebuilt, never re-aimed) ────────

    /**
     * Make a fresh OrbitControls about `target` with orbit axis `up`.
     * `camera.up` MUST be set before construction — r160 reads it there
     * and never again. Everything tunable is (re)applied here.
     */
    _buildOrbit(up, target) {
        const wasEnabled = this._orbit ? this._orbit.enabled : true;
        this._orbit?.dispose();
        this._orbitUp.copy(up).normalize();
        this.camera.up.copy(this._orbitUp);
        const o = new OrbitControls(this.camera, this.dom);
        o.enableDamping = true;
        o.dampingFactor = 0.08;
        o.rotateSpeed = 0.55;
        o.enablePan = true;
        o.screenSpacePanning = true;
        o.target.copy(target);
        o.maxDistance = this._maxDistance;
        this._orbit = o;
        this._applyOrbitLimits();
        this._applyDragTool();
        o.enabled = wasEnabled;
        o.update();
        return o;
    }

    /** Distance limits: 1.05 R⊕ about the centre (the page's historical
     *  floor); about any other pivot the surface floor does the work. */
    _applyOrbitLimits() {
        const o = this._orbit;
        if (!o) return;
        o.minDistance = o.target.lengthSq() < 1e-10 ? 1.05 : 0.01;
        o.maxDistance = this._maxDistance;
    }

    _isPlanetFrame() {
        return this._orbitUp.y > 1 - 1e-9 && this._orbit.target.lengthSq() < 1e-10;
    }

    /** Switch to orbit mode about (`up`, `target`) from the current pose. */
    _enterOrbitFrame(up, target) {
        this.setUpVector(up, { keepView: false });
        const sameAxis = this._orbitUp.distanceToSquared(up.clone().normalize()) < 1e-14;
        if (sameAxis && this._orbit) {
            this.camera.up.copy(this._orbitUp);
            this._orbit.target.copy(target);
            this._applyOrbitLimits();
        } else {
            this._buildOrbit(up, target);
        }
        this._mode = 'orbit';
        this._orbit.enabled = true;
        this._orbit.update();
        this._applyDragTool();
    }

    // ── The drag tool ───────────────────────────────────────────────────

    /** What a left drag / one finger does in orbit mode. */
    setDragTool(tool) {
        if (!DRAG_TOOLS.includes(tool)) return this._dragTool;
        this._dragTool = tool;
        this._applyDragTool();
        return tool;
    }
    getDragTool() { return this._dragTool; }

    _applyDragTool() {
        const o = this._orbit;
        if (!o) return;
        const t = this._dragTool;
        // Right drag pans (or rotates under the pan tool); the wheel and the
        // middle button dolly. The swivel tool's LEFT button is ours — the
        // capture-phase listener in _bindFly handles it and OrbitControls
        // is told to ignore it (−1: no action).
        o.mouseButtons = {
            LEFT:   t === 'pan' ? THREE.MOUSE.PAN : t === 'swivel' ? -1 : THREE.MOUSE.ROTATE,
            MIDDLE: THREE.MOUSE.DOLLY,
            RIGHT:  t === 'pan' ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN,
        };
        o.touches = {
            ONE: t === 'pan' ? THREE.TOUCH.PAN : THREE.TOUCH.ROTATE,
            TWO: THREE.TOUCH.DOLLY_PAN,
        };
        if (this._mode === 'orbit') {
            this.dom.style.cursor = t === 'pan' ? 'move' : t === 'swivel' ? 'crosshair' : 'grab';
        }
    }

    // ── The lens ─────────────────────────────────────────────────────────

    /** Set the vertical field of view (clamped 2°–90°). */
    setFov(deg) {
        const f = clampFov(deg);
        // A running path owns the lens (its FOV kick) — it restores THIS on exit.
        if (this._path) { this._path.fov0 = f; return f; }
        if (this._anim) this._anim.fov1 = f;
        this.camera.fov = f;
        this.camera.updateProjectionMatrix();
        return f;
    }
    getFov() { return this._path ? this._path.fov0 : this.camera.fov; }

    /** Largest orbit distance (the CME layer raises it to see the corridor). */
    setMaxDistance(r) {
        this._maxDistance = Math.max(4, Number(r) || 28);
        this._applyOrbitLimits();
        const d = this.camera.position.length();
        if (d > this._maxDistance && this._mode === 'orbit') {
            this.camera.position.multiplyScalar(this._maxDistance / d);
        }
    }
    getMaxDistance() { return this._maxDistance; }

    // ── Pivot moves ──────────────────────────────────────────────────────

    /**
     * Zoom. In orbit mode the camera moves along the line to the PIVOT (so
     * a limb view zooms onto the limb point, not onto Earth's centre);
     * elsewhere it scales the distance from the centre as the page always did.
     */
    dolly(factor) {
        if (!(factor > 0)) return;
        this.cancelPath('dolly');
        if (this._mode === 'orbit') {
            const o = this._orbit;
            const p = dollyToward({
                position: _arr(this.camera.position), target: _arr(o.target), factor,
                minDist: o.minDistance, maxDist: o.maxDistance,
            });
            const q = liftAboveSurface(p);
            this.camera.position.set(q[0], q[1], q[2]);
            o.update();
            return;
        }
        const dist = this.camera.position.length();
        const next = Math.max(1.05, Math.min(this._maxDistance, dist * factor));
        this.camera.position.multiplyScalar(next / dist);
    }

    /** Orbit the planet again from where the camera is (view turns smoothly). */
    recenterPivot({ durationSec = 0.8 } = {}) {
        this._follow = null;
        const pos = this.camera.position.clone();
        this.flyTo(pos, new THREE.Vector3(0, 0, 0), durationSec, {
            up: new THREE.Vector3(0, 1, 0),
            endOrbit: { up: new THREE.Vector3(0, 1, 0), target: new THREE.Vector3(0, 0, 0) },
        });
    }

    /**
     * Fly to a limb view (js/upper-atmosphere-camera-rig.js `limbViewPose`)
     * and orbit the LIMB POINT about the local radial when it lands. The
     * lens animates to the pose's field of view on the way.
     */
    limbView(pose, { durationSec = 1.8 } = {}) {
        if (!pose?.position) return;
        const v = (a) => new THREE.Vector3(a[0], a[1], a[2]);
        const up = v(pose.up).normalize();
        this.flyTo(v(pose.position), v(pose.target), durationSec, {
            up, fovDeg: pose.fovDeg,
            endOrbit: { up, target: v(pose.target) },
        });
    }

    /** Any pose `{position, target, up, fovDeg}` → fly there, then orbit its target about its up. */
    flyToPose(pose, opts) { this.limbView(pose, opts); }

    /** What the rig is doing, for the panel readout and the tests. */
    getRigState() {
        const o = this._orbit;
        return {
            mode: this._mode,
            tool: this._dragTool,
            fovDeg: this.getFov(),
            target: _arr(o.target),
            orbitUp: _arr(this._orbitUp),
            planetFrame: this._isPlanetFrame(),
            maxDistance: this._maxDistance,
            position: _arr(this.camera.position),
        };
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
        if (this._mode === 'explore') this._seedExplore();
    }

    /** Explore state from the camera's current pose (altitude clamped into the band). */
    _seedExplore() {
        const p = this.camera.position, f = this._tmpV.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
        const st = stateFromPose([p.x, p.y, p.z], [f.x, f.y, f.z]);
        st.altKm = Math.max(EXPLORE.floorKm, Math.min(EXPLORE.ceilKm, st.altKm));
        this._explore = st;
        this._lookDx = this._lookDy = 0;
    }

    /** The explore kernel state and the last step's speeds (null outside explore). */
    getExploreState() {
        if (this._mode !== 'explore' || !this._explore) return null;
        return { ...this._explore, ...(this._exploreInfo || {}) };
    }

    /**
     * An external driver (the layer transit) owns the camera pose while
     * `on`. The active mode stops stepping, and re-seeds from the pose it is
     * handed back when the driver lets go.
     */
    setExternalDriver(on) {
        const was = this._external;
        this._external = !!on;
        if (was && !on) this.syncOrientationFromCamera();
    }

    /**
     * Run a camera path from js/upper-atmosphere-explore-model.js
     * (`divePath` / `climbPath`). The path owns the camera until it ends;
     * any move key, a press on the canvas or a wheel turn cancels it where
     * it is. The field of view kicks out mid-path as a speed cue and is
     * restored exactly at the end or on cancel.
     *
     * @param {{ at:(s:number)=>{position,forward,up}, durationSec:number }} path
     * @param {object} [o]
     * @param {'explore'|'orbit'|'fly'} [o.endMode='explore']
     * @param {(reason:string)=>void} [o.onDone]    'arrived' | 'cancelled'
     */
    runPath(path, { endMode = 'explore', durationSec = null, onDone = null } = {}) {
        this.cancelPath('superseded');
        this._follow = null;
        this._anim = null;
        this._orbit.enabled = false;
        this._path = {
            path, endMode, onDone,
            t0: frameClock.now() / 1000,
            duration: Math.max(0.2, durationSec ?? path.durationSec ?? 4),
            fov0: this.camera.fov,
            s: 0,
        };
    }
    isPathActive() { return !!this._path; }
    /** A flyTo (Reset, a preset, a limb view) is still animating. */
    isAnimating() { return !!this._anim; }
    getPathProgress() { return this._path ? this._path.s : null; }

    /** Stop a running path where it is. The caller's onDone gets 'cancelled'. */
    cancelPath(reason = 'cancelled') {
        const P = this._path;
        if (!P) return false;
        this._path = null;
        this.camera.fov = P.fov0;
        this.camera.updateProjectionMatrix();
        // Hand the camera to a mode that can hold this pose: inside the band
        // that is explore; above it, fly (level over the same point).
        const alt = this.getAltitudeKm();
        if (alt <= EXPLORE.ceilKm + 1) {
            if (this._mode === 'explore') this._seedExplore(); else this.setMode('explore');
        } else {
            this.setUpVector(this.camera.position.clone().normalize(), { keepView: false });
            if (this._mode === 'fly') this.syncOrientationFromCamera(); else this.setMode('fly');
        }
        try { P.onDone?.(reason === 'superseded' ? 'superseded' : 'cancelled'); } catch (_) { /* isolate */ }
        return true;
    }

    _stepPath() {
        const P = this._path;
        const now = frameClock.now() / 1000;
        // Within 1e-9 of the end IS the end: n frames of 1/60 s sum to a hair
        // under n/60 in floating point for some start instants, which left a
        // path one frame from landing on the frame the clock says it lands.
        const raw = (now - P.t0) / P.duration;
        const s = raw > 1 - 1e-9 ? 1 : raw;
        P.s = s;
        const pose = P.path.at(s);
        this.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
        this.camera.up.set(pose.up[0], pose.up[1], pose.up[2]);
        this._tmpV.set(
            pose.position[0] + pose.forward[0],
            pose.position[1] + pose.forward[1],
            pose.position[2] + pose.forward[2]);
        this.camera.lookAt(this._tmpV);
        this.camera.fov = P.fov0 * transitionFovGain(s);
        this.camera.updateProjectionMatrix();
        if (s < 1) return;
        this._path = null;
        this.camera.fov = P.fov0;
        this.camera.updateProjectionMatrix();
        if (P.endMode === 'orbit') {
            this._mode = 'fly';                     // force the orbit re-entry path
            this.setMode('orbit');
        } else if (P.endMode === 'explore') {
            if (this._mode === 'explore') this._seedExplore(); else this.setMode('explore');
        } else {
            this.setUpVector(this.camera.position.clone().normalize(), { keepView: false });
            if (this._mode === 'fly') this.syncOrientationFromCamera(); else this.setMode('fly');
        }
        try { P.onDone?.('arrived'); } catch (_) { /* isolate */ }
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
    flyTo(targetPos, lookAtPos = null, durationSec = 1.4, { up = null, fovDeg = null, endOrbit = null } = {}) {
        // A flyTo (Reset, Top, click-to-fly) supersedes a transition, and
        // cannot run under explore: at its end the explore state would be
        // stale and the next explore step would snap the camera back into
        // the band. Fly holds any pose, level over the same point.
        this.cancelPath('superseded');
        if (this._mode === 'explore') this.setMode('fly');
        // Snapshot start state.
        const start = {
            pos:  this.camera.position.clone(),
            quat: this.camera.quaternion.clone(),
        };
        // For end orientation: build a quaternion that points at lookAt.
        const endQuat = new THREE.Quaternion();
        if (lookAtPos) {
            const m = new THREE.Matrix4().lookAt(targetPos, lookAtPos, up || this._up);
            endQuat.setFromRotationMatrix(m);
        } else {
            endQuat.copy(start.quat);
        }
        this._anim = {
            t0:        frameClock.now() / 1000,
            duration:  durationSec,
            startPos:  start.pos,
            endPos:    targetPos.clone(),
            startQuat: start.quat,
            endQuat,
            lookAt:    lookAtPos?.clone() || null,
            fov0:      this.camera.fov,
            fov1:      fovDeg == null ? this.camera.fov : clampFov(fovDeg),
            // Orbit frame to enter on landing (a limb view, or back to the
            // planet); null keeps the old behaviour per mode.
            endOrbit:  endOrbit ? { up: endOrbit.up.clone(), target: endOrbit.target.clone() } : null,
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
        const target = new THREE.Vector3(0, 0.65 * distance, distance);
        const lookAt = new THREE.Vector3(0, 0, 0);
        // Home is also the home LENS and the planet orbit frame.
        this.flyTo(target, lookAt, durationSec, {
            up: new THREE.Vector3(0, 1, 0), fovDeg: RIG.fovDefaultDeg,
            endOrbit: this._mode === 'orbit'
                ? { up: new THREE.Vector3(0, 1, 0), target: new THREE.Vector3(0, 0, 0) } : null,
        });
    }

    /** Snap to a polar (top-down) view of the planet. */
    flyToTopView({ distance = 4.5, durationSec = 1.0 } = {}) {
        this._follow = null;
        this.setUpVector(new THREE.Vector3(0, 1, 0), { keepView: false });
        const target = new THREE.Vector3(0, distance, 0.001);   // ε for valid lookAt
        const lookAt = new THREE.Vector3(0, 0, 0);
        this.flyTo(target, lookAt, durationSec, {
            up: new THREE.Vector3(0, 1, 0),
            endOrbit: this._mode === 'orbit'
                ? { up: new THREE.Vector3(0, 1, 0), target: new THREE.Vector3(0, 0, 0) } : null,
        });
    }

    /** Per-frame update — call from the host's animate() loop. */
    update(dt) {
        // A transition (dive / climb) owns the camera outright.
        if (this._path) {
            this._stepPath();
            return;
        }
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

        // The layer transit (or any external driver) owns the pose.
        if (this._external && this._mode !== 'orbit') return;

        if (this._mode === 'orbit') {
            this._stepOrbitKeys(dt);
            this._orbit.update();
            this._boundOrbit();
        } else if (this._mode === 'explore') {
            this._stepExplore(dt);
        } else {
            this._stepFly(dt);
        }
    }

    /** True when the orbit-mode rig keys should act (pointer over the globe or canvas focused). */
    _rigKeysLive() {
        return this._mode === 'orbit' && !this._path && !this._anim
            && (this._hover || document.activeElement === this.dom);
    }

    /**
     * Keyboard orbit / pan / dolly / lens, frame-rate independent. Every
     * move is the rig kernel's; OrbitControls then re-reads the pose.
     */
    _stepOrbitKeys(dt) {
        const c = this._codes;
        if (!c.size || !this._rigKeysLive() || !(dt > 0)) return;
        const o = this._orbit;
        const shift = this._keys.has('shift');
        const h = ((c.has('ArrowRight') ? 1 : 0) - (c.has('ArrowLeft') ? 1 : 0));
        const v = ((c.has('ArrowUp') ? 1 : 0) - (c.has('ArrowDown') ? 1 : 0));
        let pos = _arr(this.camera.position), tgt = _arr(o.target);
        if (h || v) {
            if (shift) {
                const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
                const sUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
                const r = panPivot({
                    position: pos, target: tgt, right: _arr(right), screenUp: _arr(sUp),
                    dxFrac: h * RIG.keyPanFracS * dt, dyFrac: v * RIG.keyPanFracS * dt, fovDeg: this.camera.fov,
                });
                pos = r.position; tgt = r.target;
            } else {
                // Right arrow swings the camera round to the right (the scene
                // turns left) — the same sense as dragging the globe leftward.
                pos = orbitAround({
                    position: pos, target: tgt, up: _arr(this._orbitUp),
                    dAzRad: h * RIG.keyOrbitRadS * dt, dPolarRad: -v * RIG.keyOrbitRadS * dt,
                });
            }
        }
        const z = ((c.has('Minus') || c.has('NumpadSubtract')) ? 1 : 0)
                - ((c.has('Equal') || c.has('NumpadAdd')) ? 1 : 0);
        if (z) {
            pos = dollyToward({ position: pos, target: tgt, factor: Math.pow(RIG.keyZoomPerS, z * dt),
                                minDist: o.minDistance, maxDist: o.maxDistance });
        }
        const f = (c.has('BracketRight') ? 1 : 0) - (c.has('BracketLeft') ? 1 : 0);
        if (f) this.setFov(this.camera.fov * Math.pow(RIG.keyFovPerS, f * dt));
        this.camera.position.set(pos[0], pos[1], pos[2]);
        o.target.set(tgt[0], tgt[1], tgt[2]);
    }

    /** After OrbitControls: the pivot stays in bounds and the camera above ground. */
    _boundOrbit() {
        const o = this._orbit;
        const c = clampPivot({ position: _arr(this.camera.position), target: _arr(o.target) });
        if (c.shifted) {
            this.camera.position.set(c.position[0], c.position[1], c.position[2]);
            o.target.set(c.target[0], c.target[1], c.target[2]);
        }
        const r = this.camera.position.length();
        if (r < RIG.surfaceFloorRe) this.camera.position.multiplyScalar(RIG.surfaceFloorRe / r);
    }

    /** Swivel the view about the camera (orbit mode): dx/dy in pixels. */
    _swivelBy(dx, dy) {
        const o = this._orbit;
        const t = swivelTarget({
            position: _arr(this.camera.position), target: _arr(o.target), up: _arr(this._orbitUp),
            yawRad: dx * RIG.swivelSens, pitchRad: -dy * RIG.swivelSens,
        });
        o.target.set(t[0], t[1], t[2]);
        this._applyOrbitLimits();
        this.camera.lookAt(o.target);
    }

    _stepExplore(dt) {
        if (!this._explore) this._seedExplore();
        const k = this._keys;
        const input = {
            forward: (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0),
            turn:    (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0),
            climb:   (k.has('e') ? 1 : 0) - (k.has('q') ? 1 : 0),
            boost:   k.has('shift'),
            crawl:   k.has('control') || k.has('alt'),
            // Drag right looks right; drag up looks up.
            dYawRad:   this._lookDx * FLY_LOOK_SENS,
            dPitchRad: -this._lookDy * FLY_LOOK_SENS,
        };
        this._lookDx = this._lookDy = 0;
        const next = exploreStep(this._explore, input, dt);
        this._explore = { u: next.u, h: next.h, altKm: next.altKm, pitchRad: next.pitchRad };
        this._exploreInfo = {
            speedKmS: next.speedKmS, groundSpeedKmS: next.groundSpeedKmS,
            climbKmS: next.climbKmS, moving: input.forward !== 0 || input.climb !== 0,
        };
        const pose = explorePose(this._explore);
        this.camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
        this.camera.up.set(pose.up[0], pose.up[1], pose.up[2]);
        this._tmpV.set(
            pose.position[0] + pose.forward[0],
            pose.position[1] + pose.forward[1],
            pose.position[2] + pose.forward[2]);
        this.camera.lookAt(this._tmpV);
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
            // Orbit-mode rig keys by physical code. Arrow keys would also
            // scroll the page, so they are claimed ONLY while the rig acts
            // on them (pointer over the globe, or the canvas focused).
            if (RIG_CODES.has(e.code)) {
                if (down && this._rigKeysLive()) {
                    this._codes.add(e.code);
                    e.preventDefault();
                } else if (!down) {
                    this._codes.delete(e.code);
                }
            }
            // A move key takes the camera back from a transition in flight.
            if (down && this._path && MOVE_KEYS.has(key)) this.cancelPath('key');
            // Don't preventDefault — that would block tabbing/copy etc.
        };
        const onMouseDown = (e) => {
            if (this._path) this.cancelPath('drag');
            if (this._mode !== 'fly' && this._mode !== 'explore') return;
            // Left button only — leave middle/right alone for browser UI.
            if (e.button !== 0) return;
            this._dragging = true;
            this._lastMouse.x = e.clientX;
            this._lastMouse.y = e.clientY;
            this.dom.style.cursor = 'grabbing';
        };
        const onMouseUp = () => {
            this._dragging = false;
            if (this._mode === 'fly' || this._mode === 'explore') this.dom.style.cursor = 'crosshair';
        };
        const onWheel = () => { if (this._path) this.cancelPath('wheel'); };
        const onMouseMove = (e) => {
            if (!this._dragging) return;
            if (this._mode === 'explore') {
                this._lookDx += e.clientX - this._lastMouse.x;
                this._lookDy += e.clientY - this._lastMouse.y;
                this._lastMouse.x = e.clientX;
                this._lastMouse.y = e.clientY;
                return;
            }
            if (this._mode !== 'fly') return;
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

        // Releasing every key when the window loses focus: a key held
        // through an alt-tab otherwise never sees its keyup and the explore
        // camera flies on by itself.
        const onBlur = () => { this._keys.clear(); this._codes.clear(); };

        // Swivel (orbit mode): the swivel tool's left drag, or Alt + any
        // left drag. Captured BEFORE OrbitControls' own pointerdown on the
        // same element and stopped there, so it never starts a rotate.
        const onPointerDownCapture = (e) => {
            if (this._mode !== 'orbit' || this._path || this._anim) return;
            if (e.button !== 0) return;
            if (!(this._dragTool === 'swivel' || e.altKey)) return;
            e.stopImmediatePropagation();
            this._follow = null;
            this._swivel = { id: e.pointerId, x: e.clientX, y: e.clientY };
            try { this.dom.setPointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
            this.dom.style.cursor = 'grabbing';
        };
        const onPointerMoveSwivel = (e) => {
            const sw = this._swivel;
            if (!sw || e.pointerId !== sw.id) return;
            const dx = e.clientX - sw.x, dy = e.clientY - sw.y;
            sw.x = e.clientX; sw.y = e.clientY;
            if (dx || dy) this._swivelBy(dx, dy);
        };
        const onPointerUpSwivel = (e) => {
            const sw = this._swivel;
            if (!sw || e.pointerId !== sw.id) return;
            this._swivel = null;
            try { this.dom.releasePointerCapture(e.pointerId); } catch (_) { /* synthetic */ }
            this._applyDragTool();
        };
        const onEnter = () => { this._hover = true; };
        const onLeave = () => { this._hover = false; this._codes.clear(); };

        window.addEventListener('keydown', onKD);
        window.addEventListener('keyup',   onKU);
        window.addEventListener('blur',    onBlur);
        this.dom.addEventListener('mousedown', onMouseDown);
        this.dom.addEventListener('wheel', onWheel, { passive: true });
        this.dom.addEventListener('pointerdown', onPointerDownCapture, { capture: true });
        this.dom.addEventListener('pointermove', onPointerMoveSwivel);
        this.dom.addEventListener('pointerup', onPointerUpSwivel);
        this.dom.addEventListener('pointercancel', onPointerUpSwivel);
        this.dom.addEventListener('pointerenter', onEnter);
        this.dom.addEventListener('pointerleave', onLeave);
        window.addEventListener('mouseup', onMouseUp);
        window.addEventListener('mousemove', onMouseMove);
        this._unbindFly = () => {
            window.removeEventListener('keydown', onKD);
            window.removeEventListener('keyup',   onKU);
            window.removeEventListener('blur',    onBlur);
            this.dom.removeEventListener('wheel', onWheel);
            this.dom.removeEventListener('pointerdown', onPointerDownCapture, { capture: true });
            this.dom.removeEventListener('pointermove', onPointerMoveSwivel);
            this.dom.removeEventListener('pointerup', onPointerUpSwivel);
            this.dom.removeEventListener('pointercancel', onPointerUpSwivel);
            this.dom.removeEventListener('pointerenter', onEnter);
            this.dom.removeEventListener('pointerleave', onLeave);
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
        // And a soft ceiling (30 R⊕, or further while the CME corridor is
        // up) so users can't get lost.
        const ceil = Math.max(30, this._maxDistance);
        if (dist > ceil) {
            this.camera.position.multiplyScalar(ceil / dist);
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
        const now = frameClock.now() / 1000;
        const tr = (now - a.t0) / a.duration;
        const t = tr > 1 - 1e-9 ? 1 : tr;   // same end tolerance as _stepPath
        // Ease in/out (smoothstep).
        const k = t * t * (3 - 2 * t);

        this.camera.position.lerpVectors(a.startPos, a.endPos, k);
        this.camera.quaternion.slerpQuaternions(a.startQuat, a.endQuat, k);
        if (a.fov1 !== a.fov0) {
            this.camera.fov = a.fov0 + (a.fov1 - a.fov0) * k;
            this.camera.updateProjectionMatrix();
        }

        if (t >= 1) {
            // On completion, sync the active mode so user-input picks up
            // cleanly from the new pose.
            if (a.endOrbit) {
                this._anim = null;
                this._enterOrbitFrame(a.endOrbit.up, a.endOrbit.target);
                return;
            }
            if (this._mode === 'fly' && a.lookAt) {
                this.syncOrientationFromCamera();
            } else if (this._mode === 'orbit') {
                // Planet frame only — a custom frame would need `endOrbit`.
                if (!this._isPlanetFrame()) this._buildOrbit(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0));
                this._orbit.target.set(0, 0, 0);
                this._applyOrbitLimits();
                this._orbit.update();
            }
            this._anim = null;
        }
    }
}
