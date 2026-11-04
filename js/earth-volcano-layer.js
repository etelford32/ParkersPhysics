/**
 * earth-volcano-layer.js — every volcano on Earth on the EarthView globe.
 *
 * Draws js/volcano-engine.js's decoded GVP catalogue (1222 Holocene + 1439
 * Pleistocene volcanoes) as ONE THREE.Points draw call of small triangle
 * glyphs, coloured by the engine's six status classes (STATUS_COLORS — the
 * same ramp volcanoes.html draws, so the two never disagree), plus a pulsing
 * halo on every volcano /api/volcanoes/activity says is elevated or erupting
 * TODAY (matched by the engine's `matchActivity`, never re-implemented here).
 *
 * This module computes nothing about volcanoes: status, onset probability and
 * the live join are all engine calls. It renders and hit-tests.
 *
 * Interaction contract (mirrors js/city-markers.js / js/wildfire-layer.js):
 *   getHovered(raycaster) → { volcano, index, live, p10 } | null  (near side
 *   only, hidden status classes never hit)
 *   setHighlight(index | -1)
 *   setGroupVisible('active' | 'dormant' | 'inactive', bool)
 *
 * Lifecycle: the 98 KB (gzip) catalogue loads on the FIRST setVisible(true),
 * never at page boot; the live feed loads with it and refreshes every 30 min
 * while visible. A dead live feed leaves the catalogue layer drawn and says
 * "live status unavailable" through onStatus — it never paints a quiet planet.
 */

import {
    decodeCatalog, buildHazardModel, onsetProbability, matchActivity,
    STATUS, STATUS_ORDER, STATUS_COLORS, GROUPS, lastKnownEruption,
} from './volcano-engine.js';

export const CATALOG_URL = '/data/volcanoes/volcanoes-catalog.json';
export const ACTIVITY_URL = '/api/volcanoes/activity';
const REFRESH_MS = 30 * 60 * 1000;
const HIT_THRESHOLD = 0.018;   // world units (globe R = 1); ~115 km grab

function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

export class EarthVolcanoLayer {
    /**
     * @param {object} THREE
     * @param {object} opts
     * @param {Function} opts.geoToXYZ (lat, lon) → THREE.Vector3 unit sphere
     * @param {number}  [opts.radius]
     * @param {Function}[opts.onStatus] (state, detail) → void
     * @param {Function}[opts.fetchJson] injectable for tests
     */
    constructor(THREE, { geoToXYZ, radius = 1.0045, onStatus, fetchJson } = {}) {
        this._T = THREE;
        this._geoToXYZ = geoToXYZ;
        this._radius = radius;
        this._onStatus = onStatus ?? (() => {});
        this._fetchJson = fetchJson ?? (async (u) => {
            const r = await fetch(u, { headers: { Accept: 'application/json' } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        });
        this.cat = null;
        this.hazard = null;
        this.live = new Map();
        this.liveState = { freshness: null, reasons: [], unmatched: 0, updated: null };
        this._hiIndex = -1;
        this._timer = null;
        this._loading = null;
        this._groupOn = { active: true, dormant: true, inactive: true };
        this._vWorld = new THREE.Vector3();
        this._vCam = new THREE.Vector3();

        const colors = STATUS_ORDER.map(s => new THREE.Vector3(...hexToRgb(STATUS_COLORS[s])));
        this._mat = new THREE.ShaderMaterial({
            transparent: true, depthWrite: false,
            blending: THREE.NormalBlending,
            uniforms: {
                uTime:   { value: 0 },
                uScale:  { value: 600 },
                uColors: { value: colors },
                uShow:   { value: STATUS_ORDER.map(() => 1) },
            },
            vertexShader: `
                attribute float aStatus;
                attribute float aSize;
                attribute float aLive;
                attribute float aHi;
                uniform float uTime;
                uniform float uScale;
                uniform float uShow[6];
                varying float vStatus;
                varying float vLive;
                varying float vHi;
                varying float vPulse;
                float showOf(float s) {
                    float v = 0.0;
                    for (int k = 0; k < 6; k++) if (abs(float(k) - s) < 0.5) v = uShow[k];
                    return v;
                }
                void main() {
                    vec4 mv = modelViewMatrix * vec4(position, 1.0);
                    float show = showOf(aStatus);
                    vStatus = aStatus; vLive = aLive; vHi = aHi;
                    vPulse = 0.5 + 0.5 * sin(uTime * 3.2 + position.x * 40.0);
                    float halo = aLive > 0.5 ? 1.9 : 1.0;
                    float sizePx = aSize * halo * (1.0 + aHi * 0.8) * uScale / max(0.0001, -mv.z);
                    gl_PointSize = show > 0.5 ? clamp(sizePx, 3.0, 44.0) : 0.0;
                    gl_Position = projectionMatrix * mv;
                }`,
            fragmentShader: `
                uniform vec3 uColors[6];
                varying float vStatus;
                varying float vLive;
                varying float vHi;
                varying float vPulse;
                vec3 statusColor(float s) {
                    vec3 c = uColors[0];
                    for (int k = 0; k < 6; k++) if (abs(float(k) - s) < 0.5) c = uColors[k];
                    return c;
                }
                // signed distance to an upward equilateral triangle (IQ)
                float sdTri(vec2 p, float r) {
                    const float k = 1.7320508;
                    p.x = abs(p.x) - r;
                    p.y = p.y + r / k;
                    if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
                    p.x -= clamp(p.x, -2.0 * r, 0.0);
                    return -length(p) * sign(p.y);
                }
                void main() {
                    vec2 q = gl_PointCoord - 0.5;
                    q.y = -q.y;
                    float glyphR = vLive > 0.5 ? 0.20 : 0.36;
                    float d = sdTri(q - vec2(0.0, 0.03), glyphR);
                    float fill = 1.0 - smoothstep(-0.02, 0.02, d);
                    float rim  = 1.0 - smoothstep(0.0, 0.05, abs(d));
                    vec3 col = statusColor(vStatus);
                    float a = fill * 0.92 + rim * 0.35;
                    vec3 rgb = mix(col, vec3(1.0), rim * 0.25 + vHi * 0.35);
                    if (vLive > 0.5) {
                        float r = length(q) * 2.0;
                        float ring = smoothstep(0.08, 0.0, abs(r - (0.62 + 0.30 * vPulse)));
                        float glow = pow(max(0.0, 1.0 - r), 2.0) * 0.45;
                        rgb = mix(rgb, vec3(1.0, 0.45, 0.15), (1.0 - fill) * 0.9);
                        a = max(a, ring * (0.9 - 0.5 * vPulse) + glow);
                    }
                    a = min(1.0, a + vHi * fill * 0.2);
                    if (a < 0.02) discard;
                    gl_FragColor = vec4(rgb, a);
                }`,
        });

        this._points = null;
        this.group = new THREE.Group();
        this.group.visible = false;
    }

    get visible() { return this.group.visible; }

    setVisible(v) {
        this.group.visible = !!v;
        if (v) {
            this._ensureLoaded();
            if (!this._timer && typeof setInterval === 'function') this._timer = setInterval(() => this._loadActivity(), REFRESH_MS);
        } else if (this._timer) {
            clearInterval(this._timer); this._timer = null;
        }
    }

    /** Show or hide a status GROUP (active / dormant / inactive). */
    setGroupVisible(group, on) {
        if (!GROUPS[group]) return;
        this._groupOn[group] = !!on;
        const show = this._mat.uniforms.uShow.value;
        STATUS_ORDER.forEach((s, k) => { show[k] = this._groupOn[STATUS[s].group] ? 1 : 0; });
        if (this._hiIndex >= 0 && !this._isShown(this._hiIndex)) this.setHighlight(-1);
    }
    groupVisible(group) { return !!this._groupOn[group]; }

    _isShown(i) {
        const v = this.cat?.volcanoes[i];
        return !!v && this._groupOn[STATUS[v.status].group];
    }

    async _ensureLoaded() {
        if (this.cat || this._loading) return this._loading;
        this._onStatus('fetching', {});
        this._loading = (async () => {
            try {
                this.cat = decodeCatalog(await this._fetchJson(CATALOG_URL));
                this.hazard = buildHazardModel(this.cat);
                this._build();
                this._report();
                await this._loadActivity();
            } catch (e) {
                this._onStatus('error', { error: e?.message ?? String(e) });
            } finally {
                this._loading = null;
            }
        })();
        return this._loading;
    }

    async _loadActivity() {
        if (!this.cat) return;
        try {
            const body = await this._fetchJson(ACTIVITY_URL);
            const { live, unmatched } = matchActivity(this.cat, body.items ?? []);
            this.live = live;
            this.liveState = { freshness: body.freshness ?? null, reasons: body.reasons ?? [], note: body.note ?? null,
                               unmatched: unmatched.length, updated: body.updated ?? null };
        } catch (e) {
            this.live = new Map();
            this.liveState = { freshness: 'stale', reasons: ['activity-route-unreachable'], note: e?.message ?? String(e), unmatched: 0, updated: null };
        }
        this._applyLive();
        this._report();
    }

    _build() {
        const T = this._T;
        const vs = this.cat.volcanoes;
        const n = vs.length;
        const pos = new Float32Array(n * 3);
        const status = new Float32Array(n), size = new Float32Array(n), live = new Float32Array(n), hi = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            const v = vs[i];
            const p = this._geoToXYZ(v.lat, v.lon).multiplyScalar(this._radius);
            pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
            const k = STATUS_ORDER.indexOf(v.status);
            status[i] = k;
            // recent activity reads larger; inactive cones stay small so 1439
            // Pleistocene glyphs do not carpet the Pacific rim
            size[i] = [0.020, 0.016, 0.013, 0.011, 0.010, 0.008][k];
        }
        const geo = new T.BufferGeometry();
        geo.setAttribute('position', new T.BufferAttribute(pos, 3));
        geo.setAttribute('aStatus', new T.BufferAttribute(status, 1));
        geo.setAttribute('aSize', new T.BufferAttribute(size, 1));
        geo.setAttribute('aLive', new T.BufferAttribute(live, 1));
        geo.setAttribute('aHi', new T.BufferAttribute(hi, 1));
        this._liveAttr = geo.getAttribute('aLive');
        this._hiAttr = geo.getAttribute('aHi');
        this._points = new T.Points(geo, this._mat);
        this._points.renderOrder = 11;
        this.group.add(this._points);
    }

    _applyLive() {
        if (!this._liveAttr) return;
        const a = this._liveAttr.array;
        a.fill(0);
        for (const i of this.live.keys()) a[i] = 1;
        this._liveAttr.needsUpdate = true;
    }

    _report() {
        if (!this.cat) return;
        const counts = {};
        for (const g of Object.keys(GROUPS)) counts[g] = 0;
        for (const v of this.cat.volcanoes) counts[STATUS[v.status].group]++;
        this._onStatus('loaded', {
            count: this.cat.volcanoes.length, counts,
            live: this.live.size, liveFreshness: this.liveState.freshness,
            liveReasons: this.liveState.reasons, liveNote: this.liveState.note,
            catalogue: this.cat.source?.listsDownloaded,
        });
    }

    tick(t, pixelScale) {
        this._mat.uniforms.uTime.value = t;
        if (Number.isFinite(pixelScale)) this._mat.uniforms.uScale.value = pixelScale;
    }

    /** Everything the tooltip prints, from the engine. */
    describe(i) {
        const v = this.cat?.volcanoes[i];
        if (!v) return null;
        const last = lastKnownEruption(v);
        return {
            volcano: v,
            index: i,
            statusLabel: STATUS[v.status].label,
            last,
            p10: this.hazard ? onsetProbability(this.hazard, v, 10) : null,
            live: this.live.get(i) ?? null,
        };
    }

    getHovered(raycaster) {
        if (!this.group.visible || !this._points) return null;
        const prev = raycaster.params.Points;
        raycaster.params.Points = { threshold: HIT_THRESHOLD };
        const hits = raycaster.intersectObject(this._points, false);
        raycaster.params.Points = prev;
        if (!hits.length) return null;
        this._points.updateWorldMatrix(true, false);
        const posAttr = this._points.geometry.getAttribute('position');
        // prefer the hit closest to the ray among near-side, shown glyphs
        let best = null, bestD = Infinity;
        for (const hit of hits) {
            const i = hit.index;
            if (i == null || !this._isShown(i)) continue;
            this._vWorld.fromBufferAttribute(posAttr, i).applyMatrix4(this._points.matrixWorld);
            this._vCam.copy(raycaster.ray.origin).sub(this._vWorld);
            if (this._vWorld.dot(this._vCam) <= 0) continue;
            const d = hit.distanceToRay ?? 0;
            if (d < bestD) { bestD = d; best = i; }
        }
        return best == null ? null : this.describe(best);
    }

    setHighlight(index) {
        if (!this._hiAttr || index === this._hiIndex) return;
        if (this._hiIndex >= 0) this._hiAttr.setX(this._hiIndex, 0);
        if (index >= 0) this._hiAttr.setX(index, 1);
        this._hiIndex = index;
        this._hiAttr.needsUpdate = true;
    }

    /** Test/console probe: world position of volcano `i` (or null). */
    worldPosition(i) {
        if (!this._points) return null;
        this._points.updateWorldMatrix(true, false);
        return this._vWorld.fromBufferAttribute(this._points.geometry.getAttribute('position'), i)
            .applyMatrix4(this._points.matrixWorld).clone();
    }

    dispose() {
        if (this._timer) clearInterval(this._timer);
        this._points?.geometry.dispose();
        this._mat.dispose();
        this.group.parent?.remove(this.group);
    }
}

export default EarthVolcanoLayer;
