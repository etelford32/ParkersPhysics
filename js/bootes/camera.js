/**
 * bootes/camera.js — the camera rig for the Boötes stage
 * ═══════════════════════════════════════════════════════════════════════════
 * Wraps OrbitControls with the things a bare OrbitControls does not have and
 * this page needs: named viewpoints, eased flights between them, a keyboard,
 * click-to-focus on the catalogued clusters, and a live pose readout the HUD
 * can print. All the arithmetic lives in bootes/camera-math.js, which is pure
 * and node-gated; this file is plumbing.
 *
 * THE UP-VECTOR IS +Y AND NEVER CHANGES — deliberately, and this is the one
 * paragraph to read before editing. The vendored r160 OrbitControls captures
 * its orbit axis from `camera.up` AT CONSTRUCTION and ignores every later
 * assignment (`OrbitControls.js:176`). Three pages in this repo have been bitten
 * by that — Mars' surface mode, the Moon's descent mode and the space-weather
 * Stage all keep `controls` in a `let` and REBUILD it whenever the frame
 * changes. This rig avoids the whole problem by never needing a different up:
 * every viewpoint, including the two derived from the oblique sightline, is
 * expressed as a camera POSITION with the world up left alone. If a future
 * edit introduces a viewpoint that wants a rolled horizon, it must rebuild the
 * controls, not assign `camera.up` — that assignment does nothing and the
 * resulting bug looks like a physics error in the render.
 *
 * FLIGHTS INTERPOLATE IN SPHERICAL COORDINATES, NOT CARTESIAN. A straight lerp
 * between two points on a sphere passes through the middle: flying from one
 * side of the void to the other dives through the centre, the wall sweeps
 * through the near plane, and the view flashes. `interpolatePose` moves θ, φ
 * and log-radius separately so the camera stays on an arc. The radius is
 * geometric for the same class of reason — apparent size goes as 1/r, so a
 * linear radius ramp loiters in the distance and then arrives in a rush.
 *
 * THE KEYBOARD IS GATED ON `document.activeElement`. This page has a select,
 * four range sliders and seven checkboxes in a rail beside the canvas; ranges
 * respond to the arrow keys themselves, so an ungated global handler steals
 * them and the slider stops working while the camera spins. Anything focusable
 * that is not the canvas keeps its own keys.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    VIEWPOINTS, VIEWPOINT_IDS, viewpointDirection, sphericalFromDirection,
    clampPolar, clamp, azimuthDeg, elevationDegFromPolar, interpolatePose,
} from './camera-math.js';

const TWO_PI = Math.PI * 2;

/**
 * Create the rig.
 *
 *   canvas       the stage canvas (also the key/pointer target)
 *   camera       a PerspectiveCamera, up = +Y
 *   toScene      Mpc → scene units
 *   fromScene    scene units → Mpc
 *   rEffMpc      the void's effective radius, the unit every viewpoint is in
 *   losUnit      unit vector from the void towards the observer
 *   onPose       called with the pose readout whenever it changes
 *   onViewpoint  called with the active viewpoint id (or null once the user
 *                has moved the camera off it by hand)
 */
export function createCameraRig({
    canvas, camera, toScene, fromScene, rEffMpc, losUnit,
    onPose = null, onViewpoint = null, onFocus = null,
}) {
    camera.up.set(0, 1, 0);                       // see the header before changing
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.rotateSpeed = 0.85;
    controls.zoomSpeed = 0.9;
    controls.panSpeed = 0.6;
    controls.minDistance = toScene(rEffMpc * 0.08);
    controls.maxDistance = toScene(rEffMpc * 12);
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3;
    // Touch: one finger orbits, two fingers dolly + pan. Matching what the
    // other 3D pages here do, so the gesture vocabulary is the same site-wide.
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    const reduceMotion = typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches;

    let activeViewpoint = 'survey';
    let tween = null;
    let labelsOn = true;
    const tmp = new THREE.Vector3();

    // ── Pose ────────────────────────────────────────────────────────────────
    function currentPose() {
        tmp.copy(camera.position).sub(controls.target);
        const radius = Math.max(tmp.length(), 1e-6);
        return {
            theta: Math.atan2(tmp.x, tmp.z),
            phi: clampPolar(Math.acos(clamp(tmp.y / radius, -1, 1))),
            radius,
            fovDeg: camera.fov,
            target: [controls.target.x, controls.target.y, controls.target.z],
        };
    }

    function applyPose(pose) {
        controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
        const phi = clampPolar(pose.phi);
        const s = Math.sin(phi);
        camera.position.set(
            pose.target[0] + pose.radius * s * Math.sin(pose.theta),
            pose.target[1] + pose.radius * Math.cos(phi),
            pose.target[2] + pose.radius * s * Math.cos(pose.theta),
        );
        if (Math.abs(camera.fov - pose.fovDeg) > 1e-4) {
            camera.fov = pose.fovDeg;
            camera.updateProjectionMatrix();
        }
        camera.lookAt(controls.target);
    }

    function emitPose() {
        if (!onPose) return;
        const p = currentPose();
        onPose({
            distanceMpc: fromScene(p.radius),
            azimuthDeg: azimuthDeg(p.theta),
            elevationDeg: elevationDegFromPolar(p.phi),
            fovDeg: p.fovDeg,
            targetMpc: p.target.map(fromScene),
            targetOffsetMpc: Math.hypot(...p.target.map(fromScene)),
        });
    }

    function setViewpointFlag(id) {
        if (activeViewpoint === id) return;
        activeViewpoint = id;
        onViewpoint?.(id);
    }

    // Any manual interaction drops the "you are at a named viewpoint" claim.
    // Leaving it lit after the user has dragged 40° away is a small lie that
    // makes the preset buttons feel broken when clicking the lit one moves the
    // camera. Auto-rotate does NOT clear it — the viewpoint is still the frame
    // you asked for, it is merely turning.
    controls.addEventListener('start', () => { setViewpointFlag(null); });
    controls.addEventListener('change', emitPose);

    // ── Flights ─────────────────────────────────────────────────────────────
    function poseForViewpoint(id) {
        const vp = VIEWPOINTS[id] ?? VIEWPOINTS.survey;
        const dir = viewpointDirection(id, losUnit);
        const { theta, phi } = sphericalFromDirection(dir);
        return {
            theta, phi,
            radius: toScene(rEffMpc * vp.distance),
            fovDeg: vp.fovDeg,
            target: [0, 0, 0],
        };
    }

    function flyTo(pose, { seconds = 1.15, viewpoint = null } = {}) {
        if (reduceMotion || seconds <= 0) {
            applyPose(pose);
            controls.update();
            emitPose();
            if (viewpoint) setViewpointFlag(viewpoint);
            return;
        }
        tween = {
            from: currentPose(),
            to: pose,
            startedAt: performance.now(),
            durationMs: seconds * 1000,
            viewpoint,
            wasAutoRotating: controls.autoRotate,
        };
        // OrbitControls fights direct position writes while it is enabled: its
        // damping integrates towards its own internal spherical, so the camera
        // would be pulled back on every frame of the flight.
        controls.enabled = false;
        controls.autoRotate = false;
    }

    function goTo(id, opts = {}) {
        if (!VIEWPOINTS[id]) return;
        flyTo(poseForViewpoint(id), { ...opts, viewpoint: id });
    }

    /**
     * Fly to look at a point, keeping the current viewing direction.
     *
     * The target moves and the radius tightens; θ and φ are left alone, so the
     * camera swings around to the new object rather than teleporting to a
     * different side of it. Reorienting as well would lose the reader's sense
     * of which way they were looking, which is the whole cost of a focus jump.
     */
    function focusOnMpc(positionMpc, { distanceMpc = rEffMpc * 0.85, seconds = 1 } = {}) {
        const p = currentPose();
        flyTo({
            theta: p.theta,
            phi: p.phi,
            radius: toScene(distanceMpc),
            fovDeg: 45,
            target: positionMpc.map(toScene),
        }, { seconds });
    }

    function reset(opts = {}) { goTo('survey', opts); }

    // ── Click-to-focus ──────────────────────────────────────────────────────
    //
    // SCREEN-SPACE PICKING, not a raycast. The candidates are drawn as Points
    // and Sprites, and raycasting Points needs a threshold tuned per zoom level
    // — too small and nothing is ever clickable, too large and the whole
    // cluster catalogue picks at once. Projecting each candidate and taking the
    // nearest within a pixel radius is exact, cheap at nine candidates, and
    // behaves identically at every zoom.
    let pickables = [];
    function setPickables(list) { pickables = list ?? []; }

    function pickAt(clientX, clientY, radiusPx = 34) {
        if (!pickables.length) return null;
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        let best = null;
        let bestDist = radiusPx;
        for (const item of pickables) {
            tmp.set(...item.positionMpc.map(toScene)).project(camera);
            if (tmp.z > 1) continue;                       // behind the camera
            const sx = rect.left + ((tmp.x + 1) / 2) * rect.width;
            const sy = rect.top + ((1 - tmp.y) / 2) * rect.height;
            const d = Math.hypot(sx - clientX, sy - clientY);
            if (d < bestDist) { bestDist = d; best = item; }
        }
        return best;
    }

    canvas.addEventListener('dblclick', (event) => {
        const hit = pickAt(event.clientX, event.clientY);
        if (!hit) return;
        event.preventDefault();
        focusOnMpc(hit.positionMpc, { distanceMpc: rEffMpc * 0.7 });
        onFocus?.(hit);
    });

    // Hover affordance: the cursor is the only thing that says a cluster is
    // clickable at all, and without it double-click-to-focus is a feature
    // nobody discovers.
    canvas.addEventListener('pointermove', (event) => {
        if (event.pointerType !== 'mouse') return;
        canvas.style.cursor = pickAt(event.clientX, event.clientY) ? 'pointer' : 'grab';
    });
    canvas.addEventListener('pointerdown', () => { canvas.style.cursor = 'grabbing'; });
    canvas.addEventListener('pointerup', () => { canvas.style.cursor = 'grab'; });
    canvas.style.cursor = 'grab';

    // ── Keyboard ────────────────────────────────────────────────────────────
    const ORBIT_STEP = 0.06;          // rad per keypress
    const DOLLY_STEP = 1.11;

    function orbitBy(dTheta, dPhi) {
        const p = currentPose();
        applyPose({ ...p, theta: p.theta + dTheta, phi: clampPolar(p.phi + dPhi) });
        controls.update();
        emitPose();
        setViewpointFlag(null);
    }

    function dollyBy(factor) {
        const p = currentPose();
        applyPose({
            ...p,
            radius: clamp(p.radius * factor, controls.minDistance, controls.maxDistance),
        });
        controls.update();
        emitPose();
    }

    let onLabelToggle = null;
    function handleKey(event) {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        // Do not steal keys from a focused control. Range inputs in particular
        // use the arrow keys, and the rail sits right beside the canvas.
        const el = document.activeElement;
        if (el && el !== document.body && el !== canvas) {
            const tag = el.tagName;
            if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA'
                || tag === 'BUTTON' || el.isContentEditable) return;
        }
        const k = event.key;
        let handled = true;
        switch (k) {
            case 'ArrowLeft': case 'a': case 'A': orbitBy(-ORBIT_STEP, 0); break;
            case 'ArrowRight': case 'd': case 'D': orbitBy(ORBIT_STEP, 0); break;
            case 'ArrowUp': orbitBy(0, -ORBIT_STEP); break;
            case 'ArrowDown': orbitBy(0, ORBIT_STEP); break;
            case 'w': case 'W': dollyBy(1 / DOLLY_STEP); break;
            case 's': case 'S': dollyBy(DOLLY_STEP); break;
            case 'r': case 'R': reset(); break;
            case 'l': case 'L': onLabelToggle?.(!labelsOn); break;
            case ' ': controls.autoRotate = !controls.autoRotate; break;
            default: {
                const vp = VIEWPOINT_IDS.find(id => VIEWPOINTS[id].key === k);
                if (vp) goTo(vp); else handled = false;
            }
        }
        if (handled) event.preventDefault();
    }
    // On the canvas AND on window: the canvas needs focus for the first, and
    // most readers never click the canvas before reaching for a key.
    canvas.tabIndex = 0;
    canvas.addEventListener('keydown', handleKey);
    globalThis.addEventListener('keydown', handleKey);

    // ── Per-frame update, called from the render loop ───────────────────────
    function update() {
        if (tween) {
            const t = (performance.now() - tween.startedAt) / tween.durationMs;
            if (t >= 1) {
                applyPose(tween.to);
                controls.enabled = true;
                controls.autoRotate = tween.wasAutoRotating;
                controls.update();
                const vp = tween.viewpoint;
                tween = null;
                emitPose();
                if (vp) setViewpointFlag(vp);
            } else {
                applyPose(interpolatePose(tween.from, tween.to, t));
                emitPose();
            }
            return;
        }
        controls.update();
    }

    emitPose();

    return {
        controls,
        update,
        goTo,
        reset,
        focusOnMpc,
        setPickables,
        pickAt,
        currentPose,
        get activeViewpoint() { return activeViewpoint; },
        get isFlying() { return tween !== null; },
        setAutoRotate(on) { controls.autoRotate = on; },
        get autoRotate() { return controls.autoRotate; },
        setLabelsFlag(on) { labelsOn = on; },
        onLabelToggleRequest(fn) { onLabelToggle = fn; },
        viewpoints: VIEWPOINTS,
        dispose() {
            canvas.removeEventListener('keydown', handleKey);
            globalThis.removeEventListener('keydown', handleKey);
            controls.dispose();
        },
    };
}
