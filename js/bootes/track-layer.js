/**
 * bootes/track-layer.js — the galaxy tracker drawn on the Boötes stage
 * ═══════════════════════════════════════════════════════════════════════════
 * Rendering only; imports no physics (`tests/bootes-void-page.mjs` enforces
 * it). Every position arrives from js/bootes-void-tracker.js through
 * bootes/track-panel.js.
 *
 * Per tracked galaxy:
 *   - its whole Zel'dovich PATH over the timeline (a straight comoving line —
 *     that straightness is the approximation, and drawing it honestly shows
 *     it), dim before the scrubbed instant and bright after it is reached;
 *   - a screen-sized ring at its position NOW on the scrubber, in the
 *     galaxy's own colour (the colour follows the GALAXY, never its slot in a
 *     list — the SkyView rule);
 *   - a small hollow tick at its Lagrangian start q, where it was when the
 *     void had not yet formed.
 *
 * Drawn over everything (depthTest off) for the same reason as the probe: it
 * is an instrument overlay on a field of 3 500 additive dots.
 */

import * as THREE from 'three';

function ringTexture(stroke = 5) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.strokeStyle = '#ffffff';
    g.lineWidth = stroke;
    g.beginPath(); g.arc(32, 32, 24, 0, Math.PI * 2); g.stroke();
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
}

function overlay(material) {
    material.depthTest = false;
    material.depthWrite = false;
    material.transparent = true;
    return material;
}

export function createTrackLayer({ root, toScene }) {
    const group = new THREE.Group();
    group.name = 'galaxy-tracks';
    root.add(group);
    const ringTex = ringTexture(6);
    const tickTex = ringTexture(3);

    function clear() {
        for (const child of [...group.children]) {
            group.remove(child);
            child.geometry?.dispose?.();
            child.material?.dispose?.();
        }
    }

    const v3 = (p) => new THREE.Vector3(toScene(p[0]), toScene(p[1]), toScene(p[2]));

    /**
     * tracks: [{ color, pathMpc: [[x,y,z]…], cursorIndex, currentMpc, startMpc }]
     */
    function set(tracks, { paths = true } = {}) {
        clear();
        for (const tr of tracks) {
            const color = new THREE.Color(tr.color);
            if (paths && tr.pathMpc?.length > 1) {
                const k = Math.max(1, Math.min(tr.pathMpc.length, (tr.cursorIndex ?? 0) + 1));
                const past = tr.pathMpc.slice(0, k);
                const future = tr.pathMpc.slice(k - 1);
                if (past.length > 1) {
                    const line = new THREE.Line(
                        new THREE.BufferGeometry().setFromPoints(past.map(v3)),
                        overlay(new THREE.LineBasicMaterial({ color, opacity: 0.95 })));
                    line.renderOrder = 24;
                    group.add(line);
                }
                if (future.length > 1) {
                    const line = new THREE.Line(
                        new THREE.BufferGeometry().setFromPoints(future.map(v3)),
                        overlay(new THREE.LineDashedMaterial({
                            color, opacity: 0.45, dashSize: toScene(1.2), gapSize: toScene(1.2),
                        })));
                    line.computeLineDistances();
                    line.renderOrder = 24;
                    group.add(line);
                }
            }
            if (tr.currentMpc) {
                const ring = new THREE.Sprite(overlay(new THREE.SpriteMaterial({
                    map: ringTex, color, sizeAttenuation: false, opacity: 0.95,
                })));
                ring.scale.set(0.034, 0.034, 1);
                ring.position.copy(v3(tr.currentMpc));
                ring.renderOrder = 25;
                group.add(ring);
            }
            if (paths && tr.startMpc) {
                const tick = new THREE.Sprite(overlay(new THREE.SpriteMaterial({
                    map: tickTex, color, sizeAttenuation: false, opacity: 0.5,
                })));
                tick.scale.set(0.014, 0.014, 1);
                tick.position.copy(v3(tr.startMpc));
                tick.renderOrder = 25;
                group.add(tick);
            }
        }
    }

    return {
        group,
        set,
        setVisible(on) { group.visible = !!on; },
        dispose() {
            clear();
            ringTex.dispose();
            tickTex.dispose();
            root.remove(group);
        },
    };
}
