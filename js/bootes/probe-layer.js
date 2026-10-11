/**
 * bootes/probe-layer.js — the force probe drawn on the Boötes stage
 * ═══════════════════════════════════════════════════════════════════════════
 * Rendering and pointer plumbing only. Every vector this file draws arrives
 * already computed by js/bootes-force-probe.js (through bootes/probe-panel.js);
 * it imports no physics and `tests/bootes-void-page.mjs` fails if it ever does.
 *
 * WHAT IS DRAWN
 *   - the probe itself: a dot, plus a dashed radial guide back to the void
 *     centre, so "radial" and "tangential" in the readout have something on
 *     screen to be radial and tangential TO;
 *   - three force arrows from the probe — the void (blue), the web (orange) and
 *     their sum A (violet) — in the charts' own palette;
 *   - optionally the three tidal eigen-axes as double-ended bars (an AXIS has
 *     no arrowhead: a squeeze along ±e is the same squeeze);
 *   - optionally the streamline of the total field through the probe.
 *
 * LENGTHS ARE RELATIVE TO THE PROBE'S OWN LARGEST TERM, and the panel prints
 * the magnitudes. The three forces differ by up to two orders of magnitude from
 * point to point, so an absolute scale would make the probe unreadable exactly
 * where the interesting cancellation happens (outside the wall, void and web
 * nearly cancel). Same rule as the field arrows (bootes/scene.js header).
 *
 * THE GLYPH ZOOMS, THE MAGNITUDES DO NOT. The arrows live in a group positioned
 * at the probe and SCALED by a camera-distance glyph size each frame — the
 * scene.js `arrowLengthFor` rule, applied as one matrix instead of a rebuild.
 *
 * DRAWN OVER EVERYTHING. depthTest is off on the glyphs: a probe hidden behind
 * 2400 additive tracer dots is a probe nobody can read, and the probe is an
 * instrument overlay, not part of the modelled universe.
 *
 * POINTER — and the scar this avoids
 * ──────────────────────────────────
 * Shift+drag, or any drag while the probe tool is ARMED (the touch path —
 * phones have no shift key), moves the probe on the plane through its current
 * position facing the camera, so it slides under the cursor at the depth it
 * already has. The listener is registered in the CAPTURE phase and stops
 * immediate propagation, so OrbitControls (which shift-drag would otherwise
 * PAN) never sees the press — the upper-atmosphere camera rig's Alt-drag
 * swivel uses the same move for the same reason. A plain drag still orbits.
 */

import * as THREE from 'three';

export const PROBE_COLORS = Object.freeze({
    void: 0x4fc3f7,
    web: 0xff9a56,
    A: 0xc792ea,
    squeeze: 0xff6f91,
    stretch: 0x8ee3c8,
    marker: 0xffffff,
    stream: 0xc792ea,
});

/** Probe glyph size in Mpc for a camera distance in Mpc — clamped both ends. */
export function probeGlyphMpc(cameraDistanceMpc) {
    return Math.max(7, Math.min(46, cameraDistanceMpc * 0.12));
}

function noDepth(material) {
    material.depthTest = false;
    material.depthWrite = false;
    material.transparent = true;
    return material;
}

export function createProbeLayer({ root, canvas, camera, toScene, fromScene }) {
    const group = new THREE.Group();
    group.name = 'force-probe';
    group.renderOrder = 20;
    root.add(group);

    // Unit-length glyphs, re-scaled every frame.
    const glyphs = new THREE.Group();
    group.add(glyphs);
    const world = new THREE.Group();             // not scaled: guide + streamline
    group.add(world);

    const marker = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        noDepth(new THREE.MeshBasicMaterial({ color: PROBE_COLORS.marker, opacity: 0.95 })));
    marker.renderOrder = 22;
    glyphs.add(marker);

    // A screen-sized ring around the probe. The dot alone vanished into the
    // vector field at the survey view (700 arrows, ~40 px apart): the ring is
    // sizeAttenuation:false, so it reads at the same few pixels at every zoom.
    // It lives OUTSIDE the scaled glyph group — a parent scale would multiply
    // into a non-attenuated sprite's clip-space size.
    const ringCanvas = document.createElement('canvas');
    ringCanvas.width = ringCanvas.height = 64;
    {
        const c = ringCanvas.getContext('2d');
        c.strokeStyle = 'rgba(255,255,255,1)';
        c.lineWidth = 5;
        c.beginPath(); c.arc(32, 32, 24, 0, Math.PI * 2); c.stroke();
        c.strokeStyle = 'rgba(199,146,234,1)';
        c.lineWidth = 2;
        c.beginPath(); c.arc(32, 32, 29, 0, Math.PI * 2); c.stroke();
    }
    const ringTex = new THREE.CanvasTexture(ringCanvas);
    ringTex.colorSpace = THREE.SRGBColorSpace;
    const ring = new THREE.Sprite(noDepth(new THREE.SpriteMaterial({
        map: ringTex, sizeAttenuation: false, opacity: 0.9,
    })));
    ring.scale.set(0.04, 0.04, 1);
    ring.renderOrder = 23;
    group.add(ring);

    let positionMpc = null;
    let enabled = true;
    let armed = false;
    let dragging = false;
    let placeHandler = null;
    let glyphMpc = 0;

    function clear(g) {
        for (const child of [...g.children]) {
            if (child === marker) continue;
            g.remove(child);
            child.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
        }
    }

    function arrow(vec, length, color) {
        const dir = new THREE.Vector3(vec[0], vec[1], vec[2]);
        if (dir.lengthSq() === 0 || !(length > 0.02)) return null;
        dir.normalize();
        const a = new THREE.ArrowHelper(dir, new THREE.Vector3(), length, color,
            Math.min(0.22, 0.4 * length), Math.min(0.11, 0.2 * length));
        a.traverse(o => { if (o.material) noDepth(o.material); o.renderOrder = 21; });
        return a;
    }

    /**
     * Rebuild the glyphs.
     *
     *   positionMpc   probe position, comoving Mpc from the void centre
     *   forces        { void, web, A } — each a 3-vector (any common unit)
     *   axes          [{ vector, lambda }] or null
     *   streamline    { forward: [[x,y,z]…], backward: [...] } (Mpc) or null
     */
    function set({ positionMpc: pos, forces, axes = null, streamline = null }) {
        positionMpc = [...pos];
        const p = pos.map(toScene);
        group.position.set(0, 0, 0);
        glyphs.position.set(p[0], p[1], p[2]);
        ring.position.set(p[0], p[1], p[2]);
        clear(glyphs);
        clear(world);

        const mags = ['void', 'web', 'A'].map(k => Math.hypot(...(forces?.[k] ?? [0, 0, 0])));
        const maxMag = Math.max(...mags);
        if (maxMag > 0) {
            ['void', 'web', 'A'].forEach((k, i) => {
                const a = arrow(forces[k], mags[i] / maxMag, PROBE_COLORS[k]);
                if (a) glyphs.add(a);
            });
        }

        if (axes?.length) {
            const maxL = Math.max(...axes.map(a => Math.abs(a.lambda))) || 1;
            const verts = [];
            const cols = [];
            const c = new THREE.Color();
            for (const ax of axes) {
                const l = 0.85 * Math.abs(ax.lambda) / maxL;
                if (l < 0.02) continue;
                c.setHex(ax.lambda > 0 ? PROBE_COLORS.squeeze : PROBE_COLORS.stretch);
                verts.push(-ax.vector[0] * l, -ax.vector[1] * l, -ax.vector[2] * l,
                    ax.vector[0] * l, ax.vector[1] * l, ax.vector[2] * l);
                cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
            }
            if (verts.length) {
                const g = new THREE.BufferGeometry();
                g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
                g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
                const lines = new THREE.LineSegments(g, noDepth(new THREE.LineBasicMaterial({
                    vertexColors: true, opacity: 0.85,
                })));
                lines.renderOrder = 21;
                glyphs.add(lines);
            }
        }

        // Radial guide: void centre → probe.
        const guideGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0), new THREE.Vector3(p[0], p[1], p[2])]);
        const guide = new THREE.Line(guideGeo, noDepth(new THREE.LineDashedMaterial({
            color: 0xffffff, opacity: 0.32, dashSize: toScene(3), gapSize: toScene(3),
        })));
        guide.computeLineDistances();
        world.add(guide);

        if (streamline) {
            const make = (pts, opacity, dashed) => {
                if (!pts || pts.length < 2) return;
                const geo = new THREE.BufferGeometry().setFromPoints(
                    pts.map(q => new THREE.Vector3(toScene(q[0]), toScene(q[1]), toScene(q[2]))));
                const mat = dashed
                    ? new THREE.LineDashedMaterial({ color: PROBE_COLORS.stream, opacity,
                        dashSize: toScene(2.5), gapSize: toScene(2.5) })
                    : new THREE.LineBasicMaterial({ color: PROBE_COLORS.stream, opacity });
                const line = new THREE.Line(geo, noDepth(mat));
                if (dashed) line.computeLineDistances();
                line.renderOrder = 20;
                world.add(line);
            };
            make(streamline.forward?.points, 0.95, false);   // downstream: solid
            make(streamline.backward?.points, 0.45, true);   // upstream: dashed
        }
        group.visible = enabled;
        updateGlyph(true);
    }

    function updateGlyph(force = false) {
        if (!positionMpc) return;
        const want = probeGlyphMpc(fromScene(camera.position.length()));
        if (!force && Math.abs(want / (glyphMpc || 1) - 1) < 0.02) return;
        glyphMpc = want;
        const s = toScene(want);
        glyphs.scale.set(s, s, s);
        // The marker is scaled inside the glyph group; keep it a small dot.
        marker.scale.setScalar(0.045);
    }

    // ── Pointer ─────────────────────────────────────────────────────────────
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const plane = new THREE.Plane();
    const hit = new THREE.Vector3();
    const viewDir = new THREE.Vector3();

    function pointToMpc(event) {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1,
            -((event.clientY - rect.top) / rect.height) * 2 + 1);
        raycaster.setFromCamera(ndc, camera);
        camera.getWorldDirection(viewDir);
        const anchor = positionMpc
            ? new THREE.Vector3(...positionMpc.map(toScene))
            : new THREE.Vector3(0, 0, 0);
        plane.setFromNormalAndCoplanarPoint(viewDir, anchor);
        if (!raycaster.ray.intersectPlane(plane, hit)) return null;
        return [fromScene(hit.x), fromScene(hit.y), fromScene(hit.z)];
    }

    const wants = (event) => enabled && event.button === 0 && (event.shiftKey || armed);

    function onDown(event) {
        if (!wants(event)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        dragging = true;
        try { canvas.setPointerCapture(event.pointerId); } catch { /* synthetic ids */ }
        const mpc = pointToMpc(event);
        if (mpc) placeHandler?.(mpc, { phase: 'start' });
    }
    function onMove(event) {
        if (!dragging) {
            // Armed but not pressed: keep the crosshair. The rig's own hover
            // handler would otherwise reset it to 'grab' on the next move, and
            // the cursor is the only thing saying a drag will move the probe.
            if (armed && enabled) {
                event.stopImmediatePropagation();
                canvas.style.cursor = 'crosshair';
            }
            return;
        }
        event.stopImmediatePropagation();
        const mpc = pointToMpc(event);
        if (mpc) placeHandler?.(mpc, { phase: 'move' });
    }
    function onUp(event) {
        if (!dragging) return;
        event.stopImmediatePropagation();
        dragging = false;
        try { canvas.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
        placeHandler?.(null, { phase: 'end' });
    }
    canvas.addEventListener('pointerdown', onDown, { capture: true });
    canvas.addEventListener('pointermove', onMove, { capture: true });
    canvas.addEventListener('pointerup', onUp, { capture: true });
    canvas.addEventListener('pointercancel', onUp, { capture: true });

    return {
        group,
        set,
        update: () => updateGlyph(false),
        setEnabled(on) {
            enabled = !!on;
            group.visible = enabled && !!positionMpc;
            if (!enabled) armed = false;
        },
        setArmed(on) {
            armed = !!on;
            canvas.style.cursor = armed ? 'crosshair' : 'grab';
        },
        get armed() { return armed; },
        get dragging() { return dragging; },
        get glyphMpc() { return glyphMpc; },
        get positionMpc() { return positionMpc ? [...positionMpc] : null; },
        onPlace(fn) { placeHandler = fn; },
        /** Screen position of the probe (client px), for tests and HUD anchoring. */
        screenPosition() {
            if (!positionMpc) return null;
            const v = new THREE.Vector3(...positionMpc.map(toScene)).project(camera);
            const rect = canvas.getBoundingClientRect();
            return {
                x: rect.left + ((v.x + 1) / 2) * rect.width,
                y: rect.top + ((1 - v.y) / 2) * rect.height,
                behind: v.z > 1,
            };
        },
        dispose() {
            canvas.removeEventListener('pointerdown', onDown, { capture: true });
            canvas.removeEventListener('pointermove', onMove, { capture: true });
            canvas.removeEventListener('pointerup', onUp, { capture: true });
            canvas.removeEventListener('pointercancel', onUp, { capture: true });
            clear(glyphs); clear(world);
            marker.geometry.dispose(); marker.material.dispose();
            ring.material.dispose(); ringTex.dispose();
            root.remove(group);
        },
    };
}
