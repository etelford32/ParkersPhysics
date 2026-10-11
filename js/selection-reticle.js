/**
 * selection-reticle.js — the ONE selection mark on solar-system.html
 * ═══════════════════════════════════════════════════════════════════════════
 * A hairline double ring that faces the camera. The NEO layer (selected +
 * hover) and the page (Sun, planets, moons) all build it here, so a selected
 * Earth and a selected asteroid wear the same mark. Before 2026-10 only NEOs
 * had one — selecting a planet or the Moon showed nothing at all.
 *
 * SIZE IS SET IN SCREEN PIXELS, then converted to world units at the body's
 * own view depth: the ring hugs the body (RING_GAP × its drawn radius) but
 * never shrinks below MIN_RING_PX, so an unresolved rock and a planet seen
 * from across the system are both a legible target. The old NEO rule scaled
 * from the camera-to-TARGET distance, which is not the depth of the marked
 * body and drifted with every zoom.
 *
 * Geometry is built at UNIT radius, so `scale` IS the inner ring's world
 * radius. depthTest is off on purpose — a reticle on a body behind a planet's
 * limb must still say where it is.
 */
import * as THREE from 'three';

export const RETICLE = Object.freeze({
    MIN_RING_PX: 12,    // CSS px, inner ring radius floor
    RING_GAP: 1.45,     // inner ring radius ÷ the body's drawn radius
    HOVER_GROW: 1.22,   // the hover ring sits a little outside the selection
});

const _v = new THREE.Vector3();

/** Build a reticle group (hidden). `dim` scales opacity (hover = 0.62). */
export function createReticle(name = 'selection-reticle', dim = 1) {
    const group = new THREE.Group();
    group.name = name;
    const ring = (ri, ro, opacity) => {
        const m = new THREE.Mesh(new THREE.RingGeometry(ri, ro, 96),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, side: THREE.DoubleSide,
                depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }));
        m.renderOrder = 15;
        m.frustumCulled = false;
        return m;
    };
    // Proportions of the original NEO reticle (0.0222–0.0228, 0.0300–0.0303).
    group.add(ring(1.0, 1.027, 0.95 * dim), ring(1.351, 1.365, 0.30 * dim));
    group.visible = false;
    group.renderOrder = 15;
    return group;
}

/** Tint every ring of a reticle. */
export function tintReticle(group, color) {
    for (const m of group.children) m.material.color.copy(color);
}

/**
 * World radius that projects to `px` CSS pixels at `pos` for this camera.
 * `viewH` is the canvas height in CSS px.
 */
export function worldPerPixels(camera, pos, viewH, px = 1) {
    _v.copy(pos).applyMatrix4(camera.matrixWorldInverse);
    const depth = Math.max(1e-6, -_v.z);
    const pxPerUnit = (camera.projectionMatrix.elements[5] * viewH * 0.5) / depth;
    return px / Math.max(pxPerUnit, 1e-9);
}

/**
 * Seat a reticle on a body: position, size (pixel floor), and face the camera.
 * @param {THREE.Object3D} group
 * @param {THREE.Vector3} pos         world position of the body
 * @param {number} bodyRadius         drawn radius, world units
 * @param {THREE.Camera} camera
 * @param {number} viewH              canvas height, CSS px
 * @param {number} [grow=1]           extra factor (hover ring)
 */
export function seatReticle(group, pos, bodyRadius, camera, viewH, grow = 1) {
    group.position.copy(pos);
    const r = Math.max((bodyRadius || 0) * RETICLE.RING_GAP, worldPerPixels(camera, pos, viewH, RETICLE.MIN_RING_PX));
    group.scale.setScalar(r * grow);
    group.quaternion.copy(camera.quaternion);   // billboard: the ring's plane is the screen
}
