/**
 * earth-glacier-catalog-layer.js — EVERY glacier on the EarthView globe (RGI 7.0, 274 531)
 *
 * The sub-layer under "Glaciers (ITS_LIVE)": where the 48 tracked glaciers carry a measured
 * motion state, these carry only what the INVENTORY says — position, size, median elevation,
 * marine front, surge evidence. It draws the PURE kernel js/glacier-catalog.js's numbers and
 * computes nothing; colours are the kernel's ONE palette (ELEV_BANDS), so this globe and
 * glacier-watch.html's map show the same bytes.
 *
 *   • ONE THREE.Points of all 274 531 centroids, sized to the TRUE equal-area disc where that is
 *     wider than `MIN_PX` and floored below it (the panel says so), round and outlined; the
 *     globe's depth buffer hides the far side.
 *   • PICKING IS ANALYTIC AND IN PIXELS: the ray meets the layer's own sphere (the earth.html
 *     globeHits rule — never a mesh raycast), the hit becomes lat/lon in the canonical frame
 *     (+X Greenwich, +Y north, −Z 90°E), the pick radius in CSS pixels becomes kilometres at that
 *     distance, and the kernel's great-circle grid answers. Projecting 274 k points per mouse
 *     move is what this avoids.
 *   • OFF at boot, NOTHING fetched before the first enable (the Volcanoes rule): ~1.8 MB.
 *
 * Interaction contract (the glacier layer's): getHovered(raycaster) → describe(i) | null,
 * setHighlight(i), setVisible(on), tick(t, pixelScale). pixelScale = drawing-buffer pixels per
 * radian at the camera, the page's `_envPixelScale`.
 */
import * as C from './glacier-catalog.js';

export const PICK_PX = 10;
export const MIN_PX = 2.2;
const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];

/**
 * PURE: the canonical frame's inverse — a point on (or near) the unit sphere → [lat, lon] in
 * degrees. js/geo/coords.js `latLonToPosition` puts +X at the prime meridian, +Y at the north
 * pole and −Z at 90°E, so lon = atan2(−z, x).
 */
export function xyzToLatLon(x, y, z) {
    const r = Math.hypot(x, y, z) || 1;
    return [Math.asin(Math.max(-1, Math.min(1, y / r))) * 180 / Math.PI, Math.atan2(-z, x) * 180 / Math.PI];
}

/** PURE: the pick radius in km on the ground for `px` CSS pixels at `distUnits` scene units (1 unit = 1 Earth radius). */
export function pickKm(px, dpr, pixelScale, distUnits) {
    return (px * dpr / Math.max(1e-6, pixelScale)) * distUnits * C.R_EARTH_KM;
}

export class EarthGlacierCatalogLayer {
    /** @param opts { geoToXYZ(lat, lon) → THREE.Vector3 on the unit sphere, radius?, onStatus?, load? } */
    constructor(THREE, { geoToXYZ, radius = 1.0032, onStatus, load } = {}) {
        this._T = THREE; this._geoToXYZ = geoToXYZ; this._radius = radius;
        this._onStatus = onStatus || (() => {});
        this._load = load || (() => C.loadCatalog());
        this._dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
        this._pixelScale = 600; this._hi = -1;
        this.group = new THREE.Group(); this.group.visible = false;
        this.cat = null; this.names = null; this._grid = null;
        this._inv = new THREE.Matrix4(); this._ray = new THREE.Ray(); this._sphere = new THREE.Sphere(new THREE.Vector3(), radius);
        this._hit = new THREE.Vector3();
    }

    get visible() { return this.group.visible; }

    setVisible(on) {
        this.group.visible = !!on;
        if (on) this._ensureLoaded();
    }

    async _ensureLoaded() {
        if (this.cat || this._loading) return this._loading;
        this._onStatus('fetching', {});
        this._loading = (async () => {
            try {
                const cat = await this._load();
                this.cat = cat;
                this._grid = C.buildGrid(cat.pts);
                this._build();
                this._onStatus('loaded', { count: cat.pts.n, area: cat.meta.official.o1region.Global.area_km2 });
                C.loadNames().then(n => { this.names = n; }).catch(() => { /* tips fall back to "unnamed" */ });
            } catch (e) {
                this._onStatus('error', { error: e?.message ?? String(e) });
            } finally { this._loading = null; }
        })();
        return this._loading;
    }

    _build() {
        const T = this._T, { pts } = this.cat, n = pts.n;
        const pos = new Float32Array(3 * n), col = new Float32Array(3 * n), rad = new Float32Array(n), hi = new Float32Array(n);
        const cache = new Map();
        for (let i = 0; i < n; i++) {
            const p = this._geoToXYZ(pts.lat[i], pts.lon[i]);
            pos[3 * i] = p.x * this._radius; pos[3 * i + 1] = p.y * this._radius; pos[3 * i + 2] = p.z * this._radius;
            const hex = C.elevColor(pts.zmed[i]);
            let rgb = cache.get(hex); if (!rgb) cache.set(hex, rgb = hexToRgb(hex));
            col[3 * i] = rgb[0]; col[3 * i + 1] = rgb[1]; col[3 * i + 2] = rgb[2];
            rad[i] = Math.sqrt(pts.area[i] / Math.PI) / C.R_EARTH_KM;     // true disc radius, in Earth radii
        }
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(pos, 3));
        g.setAttribute('aColor', new T.BufferAttribute(col, 3));
        g.setAttribute('aRad', new T.BufferAttribute(rad, 1));
        g.setAttribute('aHi', this._hiAttr = new T.BufferAttribute(hi, 1));
        this._mat = new T.ShaderMaterial({
            transparent: true, depthWrite: false,
            uniforms: { uPxScale: { value: this._pixelScale }, uMinPx: { value: MIN_PX * this._dpr } },
            vertexShader: `
                attribute vec3 aColor; attribute float aRad; attribute float aHi;
                uniform float uPxScale; uniform float uMinPx;
                varying vec3 vColor; varying float vHi;
                void main() {
                    vColor = aColor; vHi = aHi;
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    // the TRUE disc where it is wider than the floor; never more than 64 px
                    float px = 2.0 * aRad * uPxScale / max(1e-6, -mv.z);
                    gl_PointSize = min(64.0, max(uMinPx, px) + aHi * 10.0);
                    gl_Position = projectionMatrix * mv;
                }`,
            fragmentShader: `
                varying vec3 vColor; varying float vHi;
                void main() {
                    float d = length(gl_PointCoord - 0.5);
                    if (d > 0.5) discard;
                    // a dark rim so a bright dot reads over snow and cloud; white when highlighted
                    vec3 rim = mix(vec3(0.03, 0.05, 0.09), vec3(1.0), vHi);
                    vec3 c = mix(vColor, rim, smoothstep(0.34, 0.42, d));
                    gl_FragColor = vec4(c, 0.92);
                }`,
        });
        this._points = new T.Points(g, this._mat);
        this._points.frustumCulled = false;
        this._points.renderOrder = 3;   // below the 48 tracked glaciers' diamonds
        this.group.add(this._points);
    }

    setHighlight(i) {
        if (!this._hiAttr || i === this._hi) return;
        if (this._hi >= 0) this._hiAttr.array[this._hi] = 0;
        this._hi = i;
        if (i >= 0) this._hiAttr.array[i] = 1;
        this._hiAttr.needsUpdate = true;
    }

    tick(_t, pixelScale) {
        if (Number.isFinite(pixelScale) && pixelScale > 0) this._pixelScale = pixelScale;
        if (this._mat) this._mat.uniforms.uPxScale.value = this._pixelScale;
    }

    /** The glacier under the ray (nearest centroid within PICK_PX on the near side) → describe(i), or null. */
    getHovered(raycaster) {
        if (!this.group.visible || !this.cat) return null;
        this.group.updateWorldMatrix(true, false);
        this._inv.copy(this.group.matrixWorld).invert();
        this._ray.copy(raycaster.ray).applyMatrix4(this._inv);
        if (!this._ray.intersectSphere(this._sphere, this._hit)) return null;
        const [lat, lon] = xyzToLatLon(this._hit.x, this._hit.y, this._hit.z);
        const dist = this._ray.origin.distanceTo(this._hit);
        const km = pickKm(PICK_PX, this._dpr, this._pixelScale, dist);
        // never smaller than the dot actually drawn (a big glacier's disc is bigger than PICK_PX)
        const near = C.nearest(this.cat.pts, this._grid, lat, lon, Math.max(km, 0.02), null);
        if (!near) return null;
        const drawnKm = Math.max(km, Math.sqrt(this.cat.pts.area[near.index] / Math.PI));
        return near.km <= drawnKm ? this.describe(near.index) : null;
    }

    /** Everything the tooltip prints (no detail shard: that opens on glacier-watch.html). */
    describe(i) {
        const { meta, pts } = this.cat;
        const o2 = meta.o2[pts.o2[i]], f = C.flagsOf(pts.flags[i]);
        const tracked = C.trackedFor(meta, i);
        return {
            index: i, rgi_id: C.rgiId(meta, i), name: this.names?.byIndex.get(i) ?? null,
            area_km2: pts.area[i], zmed: pts.zmed[i], lat: pts.lat[i], lon: pts.lon[i],
            region: meta.official.o1region[o2.slice(0, 2)]?.name ?? null, subregion: meta.official.o2region[o2]?.name ?? null,
            marine: f.marine, surge: f.surge, surgeLabel: C.SURGE_LABELS[f.surge], tracked,
        };
    }

    /** World position of glacier i (tests / console). */
    worldPosition(i) {
        const { pts } = this.cat;
        return this._geoToXYZ(pts.lat[i], pts.lon[i]).multiplyScalar(this._radius).applyMatrix4(this.group.matrixWorld);
    }
}
