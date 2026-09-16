/**
 * sun-limb-observed.js — the OBSERVED off-limb Sun: prominences and loops
 * from the SAME frame the disk already wears
 * ═══════════════════════════════════════════════════════════════════════════
 * SUN_VISUALS_WORLD_CLASS_PLAN.md, 2026-09-16. Phase 1 wrapped the SDO browse
 * frame onto the Earth-facing hemisphere and threw the rest of the frame
 * away — yet an AIA frame extends to 1.28 R☉ at its nearest edge (1.81 at
 * the corners), and that annulus is where the 304 Å prominences and the
 * 171 / 131 Å post-flare loops actually are. This module draws it.
 *
 * ── The idea: a plane-of-sky billboard, and why that is honest ───────────
 * EUV emission is optically thin, so an image of the corona IS a line-of-
 * sight integral through it — a 2-D field in the plane of the sky, with no
 * depth. Drawing that field on a plane through the Sun's centre,
 * perpendicular to the Sun–Earth line, additively, occluded by the sphere,
 * is therefore not a trick: it is the observation, placed where the
 * instrument saw it. Two disclosures come with it:
 *   1. The frame was taken from EARTH. Orbit the camera off the Sun–Earth
 *      line and the billboard is Earth's projection seen from the side, so
 *      the layer FADES with the viewing angle (`viewWeight`: full within
 *      30°, gone past 60°) instead of pretending to be a volume. The
 *      volumetric model corona (js/corona-volumetric.js) takes over as it
 *      fades — and is SUPPRESSED where the observation covers, so the page
 *      never draws two coronas at once (`u_obsLimb` in that shader).
 *   2. Only channels with off-limb emission get it (`channelHasOffLimb`):
 *      the six AIA passbands. HMI continuum and the magnetogram have nothing
 *      above the limb, so white light and the magnetogram draw no plane.
 *
 * ── Geometry (mirrors js/sun-observed.js projectDiskUV exactly) ──────────
 * In the sphere's object frame (+y north, +z toward Earth) the observer
 * direction is e = (0, sin B0, cos B0). The plane's in-image axes are
 * x̂ = (1, 0, 0) (image right = solar west) and ŷ = (0, cos B0, −sin B0)
 * (image up); a plane point (a, b) in R☉ maps to the frame at
 * (cx + a·r, (1 − cy) + b·r) — the same expression the disk uses with
 * q = (a, b, ·), which is what `tests/sun-limb-observed.mjs` pins. The
 * mesh is a PlaneGeometry facing +z rotated about x by −B0, so its LOCAL
 * (x, y) ARE (a, b) and the fragment shader needs no matrix.
 *
 * The plane does NOT co-rotate with the photosphere: it is the sky, not the
 * surface. At the real-time rotation rate Observed mode runs at, the
 * surface turns ~0.5° between frames — a limb prominence stays at the limb.
 *
 * ── Honesty ──────────────────────────────────────────────────────────────
 *  • Shares the disk's uniforms (u_obsTex/Prev/Fade/Geom/B0/On/Kind) BY
 *    REFERENCE, so every refresh, cross-fade, feed-down and MODEL switch the
 *    chip reports applies to the limb at the same instant. No second fetch,
 *    no second freshness story: the chip's timestamp covers both.
 *  • The JPEG black floor is subtracted before adding, so a frame's
 *    compression haze does not become a glow.
 *  • `?limb=0` opts out; the chip tooltip discloses the layer and its fade.
 *
 * ── Deferred (the next data step, not this module's) ─────────────────────
 * GOES-R SUVI (NOAA SWPC) would give a ~1.6 R☉ field at 4-min cadence with
 * minutes of latency — the better off-limb source — but it is a different
 * instrument with its own plate scale, freshness contract and UNVERIFIED
 * URLs (egress-blocked at build time). It belongs in api/solar/aia.js as a
 * `src=suvi` candidate list with its own geometry, not as a silent swap of
 * the disk's frame. Recorded in the plan.
 */
import { CHANNELS } from './sun-observed.js';

export const LIMB_INNER        = 1.0;    // R☉ — the plane begins at the limb
export const LIMB_FEATHER      = 0.02;   // R☉ — fade-in above the limb (no hard ring against the sphere)
export const LIMB_EDGE_FEATHER = 0.12;   // R☉ — fade-out inside the frame's nearest edge
export const LIMB_PLANE_HALF   = 1.9;    // R☉ — plane half-size; covers an AIA frame's corners (1.81)
export const VIEW_FULL_DEG     = 30;     // full weight within this angle off the Sun–Earth line
export const VIEW_ZERO_DEG     = 60;     // and none beyond this
export const BACKGROUND_FLOOR  = 0.03;   // JPEG black level subtracted before the additive draw

const clamp01 = (v) => Math.min(1, Math.max(0, v));
function smoothstep(e0, e1, x) { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); }

/** Radius (R☉) at which the frame ends along its axes — 0.5 / r (AIA ≈ 1.28, HMI ≈ 1.075). */
export function frameEdgeRadius(geom) { return 0.5 / geom.r; }

/** Radius (R☉) at which the frame's corners end — √½ / r (AIA ≈ 1.81). */
export function frameCornerRadius(geom) { return Math.SQRT1_2 / geom.r; }

/** Observer direction and the plane's in-image axes in the sphere's object frame. */
export function skyPlaneBasis(b0Rad) {
    const c = Math.cos(b0Rad), s = Math.sin(b0Rad);
    return { normal: [0, s, c], xAxis: [1, 0, 0], yAxis: [0, c, -s] };
}

/** Plane point (a, b) in R☉ → texture (u, v) with v up — the disk's own formula with q = (a, b, ·). */
export function planePointToUV(a, b, geom) {
    return { u: geom.cx + a * geom.r, v: (1 - geom.cy) + b * geom.r };
}

/** Weight of the billboard for a viewer whose direction makes cosθ with the Sun–Earth line. */
export function viewWeight(cosTheta) {
    const DEG = Math.PI / 180;
    return smoothstep(Math.cos(VIEW_ZERO_DEG * DEG), Math.cos(VIEW_FULL_DEG * DEG), Math.abs(cosTheta));
}

/** Annulus mask: 0 on the disk, 1 just above the limb, 0 again at the frame's nearest edge. */
export function limbMask(rho, rEdge) {
    return smoothstep(LIMB_INNER, LIMB_INNER + LIMB_FEATHER, rho)
         * (1 - smoothstep(rEdge - LIMB_EDGE_FEATHER, rEdge, rho));
}

/** Only the EUV passbands (kind 1) have emission above the limb. */
export function channelHasOffLimb(channelKey) {
    const c = CHANNELS[String(channelKey)];
    return !!c && c.kind === 1;
}

/**
 * What the layer is doing right now — one object for the mesh, the corona
 * suppression and the test hook.
 * @param {object} o
 * @param {number}  o.obsOn      u_obsOn (1 while an observed frame is on)
 * @param {string}  o.channel    proxy channel key
 * @param {number}  o.cosTheta   dot(camera direction, Sun–Earth line)
 * @param {{r:number}|null} o.geom  the frame's disk geometry
 * @param {boolean} [o.userOn=true]
 */
export function limbState({ obsOn, channel, cosTheta, geom, userOn = true }) {
    if (!userOn)                      return { active: false, weight: 0, rEdge: 0, reason: 'user-off' };
    if (!(obsOn > 0.5))               return { active: false, weight: 0, rEdge: 0, reason: 'model' };
    if (!channelHasOffLimb(channel))  return { active: false, weight: 0, rEdge: 0, reason: 'no-off-limb-emission' };
    if (!geom || !(geom.r > 0))       return { active: false, weight: 0, rEdge: 0, reason: 'no-geometry' };
    const weight = viewWeight(cosTheta);
    return { active: weight > 0, weight, rEdge: frameEdgeRadius(geom), reason: weight > 0 ? null : 'off-axis' };
}

// ── Shaders ────────────────────────────────────────────────────────────────
// Constants are interpolated from the exports above so the GLSL cannot drift
// from `limbMask`; the node test checks the literals are present.
export const LIMB_VERT = /* glsl */`
    varying vec2 vLocal;
    void main() {
        vLocal = position.xy;                 // the plane's local (a, b) in R☉ — see the header
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

export const LIMB_FRAG = /* glsl */`
    precision highp float;
    uniform sampler2D u_obsTex;
    uniform sampler2D u_obsPrev;
    uniform float u_obsFade;
    uniform float u_obsOn;
    uniform float u_obsKind;      // 0 white · 1 EUV · 2 magnetogram (js/sun-observed.js CHANNELS)
    uniform vec4  u_obsGeom;      // (cx, 1 − cy, r, 0) — fractions of the frame
    uniform float u_limbView;     // viewWeight(cosθ), from JS
    uniform float u_limbGain;     // display gain — a rendering choice
    varying vec2 vLocal;
    void main() {
        if (u_obsOn < 0.5 || abs(u_obsKind - 1.0) > 0.5 || u_limbView <= 0.0) discard;
        float rho   = length(vLocal);
        float rEdge = 0.5 / max(u_obsGeom.z, 1e-3);
        float m = smoothstep(${LIMB_INNER.toFixed(2)}, ${(LIMB_INNER + LIMB_FEATHER).toFixed(2)}, rho)
                * (1.0 - smoothstep(rEdge - ${LIMB_EDGE_FEATHER.toFixed(2)}, rEdge, rho));
        if (m <= 0.0) discard;
        vec2 uv = vec2(u_obsGeom.x + vLocal.x * u_obsGeom.z, u_obsGeom.y + vLocal.y * u_obsGeom.z);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;   // beyond the frame's corners
        vec3 a = texture2D(u_obsTex,  uv).rgb;
        vec3 b = texture2D(u_obsPrev, uv).rgb;
        vec3 c = mix(b, a, u_obsFade);
        // The browse JPEG's black floor is compression, not corona.
        c = max(c - vec3(${BACKGROUND_FLOOR.toFixed(2)}), vec3(0.0)) / (1.0 - ${BACKGROUND_FLOOR.toFixed(2)});
        gl_FragColor = vec4(c * m * u_limbView * u_limbGain, 1.0);      // additive
    }
`;

// ── Browser half ───────────────────────────────────────────────────────────

/**
 * Mount the plane. `uniforms` is sun.html's shared object — the u_obs*
 * entries are referenced, never copied, so the layer follows the disk.
 *
 * @param {object} o
 * @param {object} o.THREE
 * @param {object} o.scene
 * @param {object} o.uniforms
 * @param {number} [o.renderOrder=3]
 * @param {boolean} [o.userOn=true]
 */
export function mountObservedLimb({ THREE, scene, uniforms, renderOrder = 3, userOn = true }) {
    if (!THREE || !scene || !uniforms) throw new Error('mountObservedLimb: THREE, scene and uniforms are required');
    for (const k of ['u_obsTex', 'u_obsPrev', 'u_obsFade', 'u_obsOn', 'u_obsKind', 'u_obsGeom', 'u_obsB0']) {
        if (!uniforms[k]) throw new Error(`mountObservedLimb: uniforms.${k} missing`);
    }
    const own = {
        u_limbView: { value: 0.0 },
        u_limbGain: { value: 1.0 },
    };
    const material = new THREE.ShaderMaterial({
        vertexShader: LIMB_VERT,
        fragmentShader: LIMB_FRAG,
        uniforms: {
            u_obsTex: uniforms.u_obsTex, u_obsPrev: uniforms.u_obsPrev, u_obsFade: uniforms.u_obsFade,
            u_obsOn: uniforms.u_obsOn, u_obsKind: uniforms.u_obsKind, u_obsGeom: uniforms.u_obsGeom,
            ...own,
        },
        transparent: true,
        depthWrite: false,
        depthTest: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2 * LIMB_PLANE_HALF, 2 * LIMB_PLANE_HALF), material);
    mesh.name = 'observed-limb';
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = false;
    mesh.visible = false;
    scene.add(mesh);

    const state = { active: false, weight: 0, rEdge: 0, reason: 'model', cosTheta: 1, b0Rad: 0, userOn: !!userOn };
    const dir = new THREE.Vector3();

    return {
        mesh, material,
        get state() { return { ...state }; },
        setUserOn(on) { state.userOn = !!on; },
        setGain(g) { own.u_limbGain.value = Math.max(0, +g || 0); },
        /**
         * Per frame. `channel` is the proxy key the disk is showing; `geom`
         * its {cx, cy, r}; the camera's direction from the Sun sets the fade.
         */
        update({ camera, channel, geom, sunCenter = null }) {
            const b0 = uniforms.u_obsB0.value || 0;
            state.b0Rad = b0;
            mesh.rotation.set(-b0, 0, 0);                // normal → (0, sin B0, cos B0); local +y → (0, cos B0, −sin B0)
            if (sunCenter) mesh.position.copy(sunCenter);
            dir.copy(camera.position);
            if (sunCenter) dir.sub(sunCenter);
            dir.normalize();
            const cosTheta = dir.y * Math.sin(b0) + dir.z * Math.cos(b0);
            state.cosTheta = cosTheta;
            const s = limbState({ obsOn: uniforms.u_obsOn.value, channel, cosTheta, geom, userOn: state.userOn });
            Object.assign(state, s);
            own.u_limbView.value = s.weight;
            mesh.visible = s.active;
            return state;
        },
        dispose() { scene.remove(mesh); mesh.geometry.dispose(); material.dispose(); },
    };
}
