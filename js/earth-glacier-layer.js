/**
 * earth-glacier-layer.js — Glacier Watch's glaciers on the EarthView globe.
 *
 * Draws, from the committed Glacier Watch archive (scripts/build-glacier-*):
 *   MARKERS    one diamond per glacier at its mid-glacier gauge, coloured by the
 *              engine's motion state there (data/glaciers/summary.json, computed by
 *              js/glacier-engine.js `currentState` — never re-derived here): faster /
 *              slower than usual for the season, within the normal range, or BELOW
 *              DETECTION (hollow — a small glacier's motion is under what a 120 m
 *              satellite grid resolves, and the layer must not paint it as a state);
 *   FLOWLINES  each glacier's flowline (a streamline of the OBSERVED 2014–2024 mean
 *              field) drawn on the globe in the page's speed ramp, with dots sliding
 *              along it. THE ONE DISHONESTY, disclosed in the panel note: the dots'
 *              rate is LOG-compressed (a 10 km/yr outlet and a 20 m/yr cirque glacier
 *              both have to visibly move) — relative order is kept, ratios are not.
 *
 * The states are AS OF THE ARCHIVE DATE (`summary.as_of`): the tooltip prints it and
 * deep-links to glacier-watch.html?g=…, which adds the pairs published since. A layer
 * that loaded 25 detail files (~4.8 MB) or called the daily route 25 times per visitor
 * would cost far more than a globe layer may — that is why the summary exists.
 *
 * PICKING IS IN PIXELS (the neo-watch scar: a world-radius raycaster threshold is right
 * at exactly one camera distance): `getHovered(raycaster)` measures each marker's ANGLE
 * from the ray and converts with the pixel scale the page hands `tick()`. Far-side
 * markers never pick.
 *
 * Lifecycle (the Volcanoes rule): OFF at boot, nothing fetched until the first enable.
 * Interaction contract mirrors js/earth-volcano-layer.js: getHovered → describe(i) | null,
 * setHighlight(i), setVisible(on), setFlowVisible(on), tick(t, pixelScale).
 */
import { decodeIndex } from './glacier-engine.js';
import { rampColor } from './glacier-flowmap.js';

export const INDEX_URL = '/data/glaciers/glaciers.json';
export const SUMMARY_URL = '/data/glaciers/summary.json';
export const PICK_PX = 14;

// motion state → colour. Faster/slower are a POLARITY (the dataviz diverging poles used
// on glacier-watch.html); normal is the neutral midpoint; below-detection is drawn HOLLOW
// in the neutral so it can never be read as a fourth state.
export const STATE_STYLE = {
    faster:       { color: '#f08a5d', label: 'Faster than usual', fill: 1 },
    slower:       { color: '#6ea8f0', label: 'Slower than usual', fill: 1 },
    normal:       { color: '#c9d3e3', label: 'Within the usual range', fill: 1 },
    undetectable: { color: '#8a94a6', label: 'Below satellite detection', fill: 0 },
    unknown:      { color: '#5d6a82', label: 'No recent pairs', fill: 0 },
};
const STATE_ORDER = Object.keys(STATE_STYLE);
const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/**
 * PURE: log-compressed dot rate, in flowline-lengths per second, for a speed in m/yr.
 * Visual speed runs 0.15 (1 m/yr) → 1 (10 km/yr) on a log scale, divided by the line's
 * length so a dot crosses a long outlet and a short cirque glacier at comparable ground
 * speed for comparable ice speed. Disclosed as log-compressed in the panel note.
 */
export function flowRate(vMyr, lengthKm) {
    const visual = 0.15 + 0.85 * Math.min(1, Math.log10(Math.max(1, vMyr || 1)) / 4);
    return visual * 0.5 / Math.max(3, lengthKm || 3);
}

/**
 * PURE: angular distance (radians) from a ray to a point, or Infinity if the point is
 * behind the ray origin. Used for PIXEL picking: angle × pixelScale ≈ pixels.
 */
export function rayAngle(origin, dir, p) {
    const vx = p.x - origin.x, vy = p.y - origin.y, vz = p.z - origin.z;
    const t = vx * dir.x + vy * dir.y + vz * dir.z;
    if (t <= 0) return Infinity;
    const px = vx - t * dir.x, py = vy - t * dir.y, pz = vz - t * dir.z;
    return Math.atan2(Math.hypot(px, py, pz), t);
}

export class EarthGlacierLayer {
    /**
     * @param {object} THREE
     * @param {object} opts { geoToXYZ(lat, lon) → THREE.Vector3 on the unit sphere, radius?, onStatus?, fetchJson? }
     */
    constructor(THREE, { geoToXYZ, radius = 1.0042, onStatus, fetchJson } = {}) {
        this._T = THREE; this._geoToXYZ = geoToXYZ; this._radius = radius;
        this._onStatus = onStatus ?? (() => {});
        this._fetchJson = fetchJson ?? (async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
        this.summary = null; this.glaciers = null; this._loading = null;
        this._hi = -1; this._pixelScale = 600; this._flowOn = true;
        // the page's pixel scale is in DEVICE pixels (drawing buffer); marker size and the pick
        // radius are specified in CSS pixels, so both carry the device pixel ratio
        this._dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        this.group = new THREE.Group(); this.group.visible = false;
        this._world = new THREE.Vector3();
        const colors = STATE_ORDER.map(s => new THREE.Vector3(...hexToRgb(STATE_STYLE[s].color)));
        this._mat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false,
            uniforms: { uColors: { value: colors }, uPx: { value: 13 * this._dpr } },
            vertexShader: `
                attribute float aState;
                attribute float aFill;
                attribute float aHi;
                uniform float uPx;
                varying float vState; varying float vFill; varying float vHi;
                void main() {
                    vState = aState; vFill = aFill; vHi = aHi;
                    gl_PointSize = uPx * (1.0 + 0.45 * aHi);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                uniform vec3 uColors[5];
                varying float vState; varying float vFill; varying float vHi;
                void main() {
                    vec2 q = gl_PointCoord - 0.5;
                    float d = abs(q.x) + abs(q.y);                    // diamond
                    float edge = 0.46;
                    float inside = 1.0 - smoothstep(edge - 0.03, edge, d);
                    float rim = 1.0 - smoothstep(0.0, 0.07, abs(d - (edge - 0.07)));
                    vec3 c = uColors[0];
                    for (int k = 0; k < 5; k++) if (abs(float(k) - vState) < 0.5) c = uColors[k];
                    float a = vFill > 0.5 ? inside : rim;            // hollow = below detection / unknown
                    vec3 rgb = mix(c, vec3(1.0), vHi * 0.35);
                    a = max(a, vHi * rim);
                    // a dark OUTLINE outside the glyph: a 13 px diamond vanished over snow and
                    // cloud without it (seen over the Alps on review) — contrast on any ground
                    float halo = (1.0 - smoothstep(0.495, 0.5, d)) * smoothstep(edge - 0.04, edge, d);
                    float hollowBack = (vFill > 0.5) ? 0.0 : (1.0 - smoothstep(edge - 0.10, edge - 0.08, d)) * 0.45;
                    vec3 dark = vec3(0.03, 0.05, 0.09);
                    float ink = max(a, 0.0);
                    rgb = mix(dark, rgb, ink);
                    a = max(ink, max(halo * 0.85, hollowBack));
                    if (a < 0.03) discard;
                    gl_FragColor = vec4(rgb, a * 0.97);
                }`,
        });
        this._dotMat = new THREE.PointsMaterial({ size: 3.2, sizeAttenuation: false, color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
    }

    get visible() { return this.group.visible; }

    setVisible(on) {
        this.group.visible = !!on;
        if (on) this._ensureLoaded();
    }

    setFlowVisible(on) {
        this._flowOn = !!on;
        if (this._lines) this._lines.visible = this._flowOn;
        if (this._dots) this._dots.visible = this._flowOn;
    }

    async _ensureLoaded() {
        if (this.summary || this._loading) return this._loading;
        this._onStatus('fetching', {});
        this._loading = (async () => {
            try {
                const [summary, index] = await Promise.all([this._fetchJson(SUMMARY_URL), this._fetchJson(INDEX_URL)]);
                if (summary?.format !== 'glacier-watch-summary-v1') throw new Error('unexpected summary format');
                this.summary = summary;
                this.glaciers = decodeIndex(index);
                this._build();
                const counts = {};
                for (const g of summary.glaciers) { const s = this.stateOf(g); counts[s] = (counts[s] || 0) + 1; }
                this._onStatus('loaded', { count: summary.glaciers.length, asOf: summary.as_of, counts });
            } catch (e) {
                this._onStatus('error', { error: e?.message ?? String(e) });
            } finally { this._loading = null; }
        })();
        return this._loading;
    }

    /** The motion state the marker shows: the MID-glacier gauge's, from the summary. */
    stateOf(g) { return g.gauges.find(q => q.id === 'middle')?.state ?? 'unknown'; }

    _build() {
        const T = this._T, S = this.summary.glaciers, n = S.length;
        const pos = new Float32Array(3 * n), st = new Float32Array(n), fill = new Float32Array(n), hi = new Float32Array(n);
        S.forEach((g, i) => {
            const p = this._geoToXYZ(g.lat, g.lon).multiplyScalar(this._radius + 0.0006);
            pos.set([p.x, p.y, p.z], 3 * i);
            const s = this.stateOf(g);
            st[i] = Math.max(0, STATE_ORDER.indexOf(s)); fill[i] = STATE_STYLE[s]?.fill ?? 0;
        });
        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(pos, 3));
        geo.setAttribute('aState', new T.BufferAttribute(st, 1));
        geo.setAttribute('aFill', new T.BufferAttribute(fill, 1));
        geo.setAttribute('aHi', new T.BufferAttribute(hi, 1));
        this._hiAttr = geo.getAttribute('aHi');
        this._markers = new T.Points(geo, this._mat);
        this._markers.renderOrder = 12;
        this.group.add(this._markers);
        // flowlines: one LineSegments, vertex-coloured by the observed mean speed
        const lp = [], lc = [];
        this._tracks = [];
        let vmax = 1;
        for (const g of this.glaciers) for (const v of g.climatology.v0) if (Number.isFinite(v)) vmax = Math.max(vmax, v);
        const lmax = Math.log10(vmax);
        for (const g of this.glaciers) {
            const f = g.flowline, pts = f.lat.map((la, k) => this._geoToXYZ(la, f.lon[k]).multiplyScalar(this._radius));
            const col = Array.from(g.climatology.v0, v => rampColor(0.25 + 0.75 * Math.max(0, Math.log10(Math.max(1, v || 1)) / lmax)).map(c => c / 255));
            for (let k = 0; k + 1 < pts.length; k++) {
                lp.push(pts[k].x, pts[k].y, pts[k].z, pts[k + 1].x, pts[k + 1].y, pts[k + 1].z);
                lc.push(...col[k], ...col[k + 1]);
            }
            const vMid = Array.from(g.climatology.v0).filter(Number.isFinite);
            const vMed = vMid.length ? vMid.sort((a, b) => a - b)[vMid.length >> 1] : 1;
            this._tracks.push({ pts, s: f.s_m.map(s => s / f.length_m), rate: flowRate(vMed, f.length_m / 1000), dots: 5 });
        }
        const lg = new T.BufferGeometry();
        lg.setAttribute('position', new T.Float32BufferAttribute(lp, 3));
        lg.setAttribute('color', new T.Float32BufferAttribute(lc, 3));
        this._lines = new T.LineSegments(lg, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
        this._lines.renderOrder = 11;
        const nd = this._tracks.reduce((a, t) => a + t.dots, 0);
        this._dotPos = new Float32Array(3 * nd);
        const dg = new T.BufferGeometry();
        dg.setAttribute('position', new T.BufferAttribute(this._dotPos, 3));
        this._dots = new T.Points(dg, this._dotMat);
        this._dots.renderOrder = 12; this._dots.frustumCulled = false;
        this.group.add(this._lines, this._dots);
        this.setFlowVisible(this._flowOn);
    }

    /** Advance the flow dots (wall-clock t, seconds) and take the page's pixel scale for picking. */
    tick(t, pixelScale) {
        if (Number.isFinite(pixelScale) && pixelScale > 0) this._pixelScale = pixelScale;
        if (!this.group.visible || !this._dots || !this._flowOn) return;
        let o = 0;
        for (const tr of this._tracks) {
            for (let d = 0; d < tr.dots; d++) {
                const u = ((t * tr.rate + d / tr.dots) % 1 + 1) % 1;
                let k = 1;
                while (k < tr.s.length - 1 && tr.s[k] < u) k++;
                const a = tr.pts[k - 1], b = tr.pts[k], w = (u - tr.s[k - 1]) / Math.max(1e-9, tr.s[k] - tr.s[k - 1]);
                this._dotPos[o++] = a.x + (b.x - a.x) * w; this._dotPos[o++] = a.y + (b.y - a.y) * w; this._dotPos[o++] = a.z + (b.z - a.z) * w;
            }
        }
        this._dots.geometry.attributes.position.needsUpdate = true;
    }

    /** Everything the tooltip prints. */
    describe(i) {
        const g = this.summary?.glaciers[i];
        if (!g) return null;
        const s = this.stateOf(g);
        return { index: i, glacier: g, state: s, stateLabel: STATE_STYLE[s]?.label ?? s, mid: g.gauges.find(q => q.id === 'middle'), asOf: this.summary.as_of };
    }

    getHovered(raycaster) {
        if (!this.group.visible || !this._markers) return null;
        this._markers.updateWorldMatrix(true, false);
        const posAttr = this._markers.geometry.getAttribute('position');
        const o = raycaster.ray.origin, d = raycaster.ray.direction;
        let best = -1, bestPx = PICK_PX * this._dpr;
        for (let i = 0; i < posAttr.count; i++) {
            this._world.fromBufferAttribute(posAttr, i).applyMatrix4(this._markers.matrixWorld);
            // near side only: the surface normal at the marker must face the camera
            if (this._world.x * (o.x - this._world.x) + this._world.y * (o.y - this._world.y) + this._world.z * (o.z - this._world.z) <= 0) continue;
            const px = rayAngle(o, d, this._world) * this._pixelScale;
            if (px < bestPx) { bestPx = px; best = i; }
        }
        return best < 0 ? null : this.describe(best);
    }

    setHighlight(i) {
        if (!this._hiAttr || i === this._hi) return;
        if (this._hi >= 0) this._hiAttr.setX(this._hi, 0);
        if (i >= 0) this._hiAttr.setX(i, 1);
        this._hi = i; this._hiAttr.needsUpdate = true;
    }

    /** Test/console probe: world position of glacier `i`. */
    worldPosition(i) {
        if (!this._markers) return null;
        this._markers.updateWorldMatrix(true, false);
        return this._world.fromBufferAttribute(this._markers.geometry.getAttribute('position'), i).applyMatrix4(this._markers.matrixWorld).clone();
    }

    dispose() {
        for (const o of [this._markers, this._lines, this._dots]) o?.geometry.dispose();
        this._mat.dispose(); this._dotMat.dispose(); this._lines?.material.dispose();
        this.group.parent?.remove(this.group);
    }
}

export default EarthGlacierLayer;
