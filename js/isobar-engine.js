/**
 * IsobarEngine — CPU marching-squares pressure contour pipeline
 *
 * Input:  weatherBuffer  Float32Array (TEX_W × TEX_H × 4 = 360 × 180 × 4)
 *           channel G = pressure normalised [0,1]  ↔  (hPa − 850) / 210
 *         Grid row 0 = 90°S (south), row H−1 = 90°N (north).
 *         Grid col 0 ≈ −180°, col W−1 ≈ +180°.
 *
 * Output: Three.js geometry attached to a Group that is a child of earthMesh
 *         (children of earthMesh auto-rotate with the globe).
 *
 * ── Algorithm ──────────────────────────────────────────────────────────────
 *  1. Decode pressure channel → Float32Array in hPa (360 × 180).
 *  2. Marching-squares on 359 × 179 cell grid (skipping the wrap column).
 *  3. Assemble disconnected segments into continuous polyline chains via an
 *     adjacency hash-map.
 *  4. Catmull-Rom smoothing: 3 sub-steps for major (20 hPa) levels, 2 for
 *     semi-major (8 hPa), 1 for minor (4 hPa).
 *  5. Project grid coordinates → sphere surface at R × 1.0025.
 *  6. Build ONE THREE.LineSegments from all chains with per-vertex RGB
 *     (colour encodes pressure level via meteorological ramp).
 *  7. Pressure-centre detection: box-blur grid → local min/max → NMS →
 *     THREE.Sprite labels (H / L + pressure value).
 *  8. Pressure-gradient statistics: ∂P/∂x and ∂P/∂y with latitude-correct
 *     km scale → hPa / 100 km and approximate geostrophic wind estimate.
 *
 * ── Where the work happens (2026-10-31) ──────────────────────────────────────
 *  Steps 1–4, 7 and 8 (everything that is not a three.js object) live in the
 *  PURE js/isobar-contour.js, so a Worker can run them during a time scrub
 *  (requestUpdate + setWorker). This file only turns the result into one
 *  LineSegments + the H/L sprites. Output is bit-identical to the pre-move
 *  inline pipeline (tests/isobar-contour.mjs, against a baked reference).
 *
 * ── Exports ────────────────────────────────────────────────────────────────
 *  IsobarLayer    class  — create once, call .update(buf) on weather events
 *  ISOBAR_LEVELS  number[] — hPa levels used (4 hPa spacing 960…1056)
 *  pressureToRGB  (hPa) → [r,g,b]  0..1 meteorological colour ramp
 *  geoWindMs      (gradHPa100km, latDeg) → m/s  geostrophic wind estimate
 */


import * as THREE from 'three';
import { computeIsobars, ISOBAR_LEVELS, pressureToRGB, geoWindMs } from './isobar-contour.js';

export { ISOBAR_LEVELS, pressureToRGB, geoWindMs };

// Render a canvas sprite label for a pressure centre
function makeHLSprite(type, hPa) {
    const isH = type === 'H';
    const css = isH ? '#ff8833' : '#33aaff';
    const sz  = 80;

    const canvas = document.createElement('canvas');
    canvas.width  = sz;
    canvas.height = sz;
    const ctx = canvas.getContext('2d');

    // Halo ring
    ctx.beginPath();
    ctx.arc(sz/2, sz/2, sz/2 - 3, 0, Math.PI * 2);
    ctx.fillStyle   = isH ? 'rgba(255,120,0,0.12)' : 'rgba(0,140,255,0.12)';
    ctx.fill();
    ctx.strokeStyle = css;
    ctx.lineWidth   = 2.5;
    ctx.stroke();

    // Main letter (H or L)
    ctx.fillStyle    = css;
    ctx.font         = `bold 34px system-ui, sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(type, sz/2, sz * 0.60);

    // Pressure value
    ctx.fillStyle    = 'rgba(210,230,255,0.92)';
    ctx.font         = `11px system-ui, sans-serif`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${Math.round(hPa)} hPa`, sz/2, sz * 0.83);

    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({
        map:          tex,
        transparent:  true,
        depthTest:    false,
        sizeAttenuation: true,
    });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.11, 0.11, 1);
    return sprite;
}

// ─────────────────────────────────────────────────────────────────────────────
//  IsobarLayer  — Three.js scene management
// ─────────────────────────────────────────────────────────────────────────────
export class IsobarLayer {
    /**
     * @param {THREE.Object3D} parent  — earthMesh (children rotate with globe)
     */
    constructor(parent) {
        this._parent  = parent;
        this._group   = new THREE.Group();
        this._group.name = 'isobarGroup';
        parent.add(this._group);

        this._lines   = null;    // THREE.LineSegments (all isobars in one draw call)
        this._sprites = [];      // H / L pressure-centre sprites
        this._visible = true;
        this._stats   = null;    // last computed gradient stats
        this._extrema = [];      // last set of H/L extrema (after NMS)
        this._bridge  = null;    // optional worker bridge (setWorker)
        this._pendingBuf = null; // latest-wins request waiting for the worker
        this._inFlight   = null;
        this._last       = null;
    }

    // ── Public API ────────────────────────────────────────────────────────────
    get stats()   { return this._stats; }
    get extrema() { return this._extrema; }

    setVisible(v) {
        this._visible       = v;
        this._group.visible = v;
    }
    get visible() { return this._visible; }

    /**
     * Rebuild all isobar geometry from a fresh weather buffer.
     * Called on every 'weather-update' event (~every 30 min from WeatherFeed,
     * or immediately on page load with procedural data).
     *
     * @param {Float32Array} weatherBuf  360 × 180 × 4 RGBA buffer
     */
    update(weatherBuf) {
        this._apply(computeIsobars(weatherBuf));
    }

    /**
     * Wire the off-main-thread contouring (js/weather-scrub-bridge.js). With
     * a bridge, requestUpdate() posts the buffer to a Worker and applies the
     * NEWEST result when it lands; a request made while one is in flight
     * replaces the pending one (latest wins), so a fast scrub never queues
     * stale contours. Without one, requestUpdate() is update().
     */
    setWorker(bridge) { this._bridge = bridge; }

    /** Async update — the scrub path. Returns a Promise that settles when applied (or superseded). */
    requestUpdate(weatherBuf) {
        const bridge = this._bridge;
        if (!bridge || !bridge.available()) { this.update(weatherBuf); return Promise.resolve(true); }
        // Copy: the caller's buffer is the resolver's scratch, rewritten next dispatch.
        this._pendingBuf = weatherBuf.slice();
        if (this._inFlight) return this._inFlight;
        const pump = async () => {
            while (this._pendingBuf) {
                const buf = this._pendingBuf;
                this._pendingBuf = null;
                try {
                    const result = await bridge.isobars(buf);
                    // Apply EVERY result, then loop to the newest pending one.
                    // Skipping a result because a newer request arrived would
                    // starve the layer under a continuous scrub (a new request
                    // always lands during the ~60 ms contour) — each applied
                    // result is at most one request behind.
                    this._apply(result);
                } catch (err) {
                    // Worker died: the bridge flips available() false; fall back inline.
                    console.warn('[IsobarEngine] worker contour failed, falling back inline:', err?.message ?? err);
                    this.update(this._pendingBuf ?? buf);
                    this._pendingBuf = null;
                }
            }
            this._inFlight = null;
            return true;
        };
        this._inFlight = pump();
        return this._inFlight;
    }

    /** The last applied contour result (test / debug hook). */
    get lastResult() { return this._last; }

    /** Build the three.js objects from a computeIsobars() result. */
    _apply(result) {
        this._last    = result;
        this._stats   = result.stats;
        this._extrema = result.extrema.map(({ x, y, type, hPa }) => ({ x, y, type, hPa }));

        // ── Rebuild LineSegments ────────────────────────────────────────────
        if (this._lines) {
            this._lines.geometry.dispose();
            this._lines.material.dispose();
            this._group.remove(this._lines);
            this._lines = null;
        }

        if (result.positions.length > 0) {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', new THREE.Float32BufferAttribute(result.positions, 3));
            geo.setAttribute('color',    new THREE.Float32BufferAttribute(result.colors,    3));

            const mat = new THREE.LineBasicMaterial({
                vertexColors: true,
                transparent:  true,
                opacity:      1.0,
                depthWrite:   false,
            });

            this._lines = new THREE.LineSegments(geo, mat);
            this._lines.renderOrder = 2;
            this._group.add(this._lines);
        }

        // ── H / L pressure-centre sprites ──────────────────────────────────
        this._sprites.forEach(s => {
            this._group.remove(s);
            s.material.map?.dispose();
            s.material.dispose();
        });
        this._sprites = [];

        for (const e of result.extrema) {
            const sprite = makeHLSprite(e.type, e.hPa);
            sprite.position.set(e.pos.x, e.pos.y, e.pos.z);
            this._group.add(sprite);
            this._sprites.push(sprite);
        }

        this._group.visible = this._visible;
    }

    dispose() {
        if (this._lines) {
            this._lines.geometry.dispose();
            this._lines.material.dispose();
        }
        this._sprites.forEach(s => { s.material.map?.dispose(); s.material.dispose(); });
        this._parent.remove(this._group);
    }
}
