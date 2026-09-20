/**
 * star-collider/scene.js — the collider's three.js stage and its camera rig
 * ═══════════════════════════════════════════════════════════════════════════
 * Draws what the SPH kernel computes and nothing else: one Points cloud
 * (position, log-density, thermal energy and a star/unbound flag per
 * particle, straight from the worker's packed frame), the two bodies'
 * cores, their trails, the line between them, optional black-hole spheres,
 * a scale ring and the orbital-plane grid. Before a run it previews the
 * configured pair as wire spheres at the configured separation so the
 * camera has the system to look at, not an empty grid. No physics here.
 *
 * FRAME. The kernel's orbital plane is x–y with the angular momentum along
 * +z. The stage is Y-UP, so kernel (x, y, z) → scene (x, z, −y): a ROTATION
 * (det +1), not the y↔z swap, which would mirror the orbital sense. Every
 * drawn thing lives in `world`, a group the COROTATING frame turns about +y
 * by the angle of the core–core line, so the two stars sit still on the
 * x-axis and the tides, the bar and the ejecta move around them — the
 * frame every merger paper plots in.
 *
 * THE CAMERA HAS ONE RULE (the TIGA rule): the page may START a flight, it
 * may not HOLD the camera. Presets and frame-to-fit are one-shot tweens of
 * the spherical coordinates about the target that any drag, wheel, pinch or
 * key cancels. FOLLOW is not a hold: each frame the target moves to the
 * followed point (system barycentre, core A or core B) and the camera is
 * translated by exactly the same vector, so the user's own orbit angle and
 * zoom are untouched — it is the rig that moves, never the camera's pose
 * relative to it. The translation is exact every frame: an eased version
 * trailed a core by 75° of orbit on a 3 fps software rasteriser (measured),
 * and a density-weighted centroid of hundreds of particles has no jitter
 * worth smoothing.
 *
 * `camera.up` never changes (Y-up throughout), so OrbitControls is built
 * once and never rebuilt — the Mars/Moon/Stage orbit-axis scar cannot occur
 * here. Presets steer through OrbitControls' own spherical state (the
 * camera is positioned about `controls.target`), so a preset and a user
 * drag are the same kind of motion and cannot fight.
 *
 * SCALE. `setScale(codePerScene, ringR)` maps kernel length units to scene
 * units so a 20-km neutron star and a 6000-km white dwarf both fill the
 * stage; page.js prints the ring's radius in km on the stage so the
 * compression is disclosed where it is seen.
 *
 * COLOUR MODES (the analysis views): density (log₁₀ρ over the top three
 * decades below the frame maximum, cold→hot, shock heat pushing toward
 * orange), heat (the thermal energy u alone — where the shocks are),
 * body (star A cyan, star B magenta — mixing at contact), bound (bound
 * material dim, unbound ejecta bright green — the kernel's own Bernoulli
 * flag, the same definition as the M_unbound readout). Points are additive
 * so overlapping particles brighten like a column density. Point size is
 * camera-distance scaled with a 2 px floor.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MAX_POINTS = 8192;
const MAX_TRAIL = 1500;
const TWEEN_S = 0.75;

export const VIEW_PRESETS = Object.freeze({
    top:     { polar: 0.04, azimuth: 0.0,  label: 'top (face-on)' },
    edge:    { polar: 1.545, azimuth: 0.35, label: 'edge-on' },
    oblique: { polar: 0.82, azimuth: 0.45, label: 'oblique' },
});
export const COLOR_MODES = Object.freeze({
    density: { id: 0, label: 'density (log₁₀ρ, top 3 decades) · shock heat → orange' },
    heat:    { id: 1, label: 'shock heating u (blue → white → red)' },
    body:    { id: 2, label: 'body membership · A cyan, B magenta' },
    bound:   { id: 3, label: 'gravitationally bound (dim) vs unbound ejecta (green)' },
});
export const FOLLOW_MODES = Object.freeze(['system', 'A', 'B', 'none']);

const POINT_VS = /* glsl */`
    attribute float aDens;
    attribute float aHeat;
    attribute float aFlag;
    uniform float uSize;
    uniform float uPointScale;
    uniform float uDensMax;
    uniform float uDensSpan;
    uniform float uHeatScale;
    varying float vDens;
    varying float vHeat;
    varying float vFlag;
    void main() {
        vDens = clamp((aDens - (uDensMax - uDensSpan)) / uDensSpan, 0.0, 1.0);
        vHeat = clamp(aHeat * uHeatScale, 0.0, 1.0);
        vFlag = aFlag;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float px = uSize * uPointScale * (240.0 / max(-mv.z, 0.05));
        gl_PointSize = max(px, 2.0);
        gl_Position = projectionMatrix * mv;
    }
`;
const POINT_FS = /* glsl */`
    precision highp float;
    uniform int uMode;
    varying float vDens;
    varying float vHeat;
    varying float vFlag;
    vec3 ramp(float t) {
        vec3 c0 = vec3(0.06, 0.10, 0.45);
        vec3 c1 = vec3(0.10, 0.55, 0.95);
        vec3 c2 = vec3(0.65, 0.95, 1.00);
        vec3 c3 = vec3(1.00, 0.97, 0.80);
        if (t < 0.33) return mix(c0, c1, t / 0.33);
        if (t < 0.66) return mix(c1, c2, (t - 0.33) / 0.33);
        return mix(c2, c3, (t - 0.66) / 0.34);
    }
    vec3 heatRamp(float t) {
        vec3 c0 = vec3(0.10, 0.18, 0.55);
        vec3 c1 = vec3(0.92, 0.94, 1.00);
        vec3 c2 = vec3(1.00, 0.55, 0.15);
        vec3 c3 = vec3(1.00, 0.12, 0.10);
        if (t < 0.4) return mix(c0, c1, t / 0.4);
        if (t < 0.75) return mix(c1, c2, (t - 0.4) / 0.35);
        return mix(c2, c3, (t - 0.75) / 0.25);
    }
    void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        float a = exp(-r2 * 9.0);
        float body = mod(vFlag, 2.0);          // 0 = A, 1 = B
        float unbound = step(2.0, vFlag);      // 1 if ejecta
        vec3 col;
        float lum;
        if (uMode == 1) {
            col = heatRamp(vHeat);
            lum = 0.25 + 0.75 * max(vHeat, 0.35 * vDens);
        } else if (uMode == 2) {
            col = mix(vec3(0.30, 0.85, 1.00), vec3(0.95, 0.45, 1.00), body);
            lum = 0.22 + 0.78 * vDens;
        } else if (uMode == 3) {
            col = mix(vec3(0.35, 0.42, 0.70), vec3(0.45, 1.00, 0.60), unbound);
            lum = mix(0.12 + 0.55 * vDens, 1.0, unbound);
        } else {
            col = ramp(vDens);
            col = mix(col, vec3(1.0, 0.72, 0.35), vHeat * 0.8);
            lum = 0.18 + 0.82 * vDens;
        }
        gl_FragColor = vec4(col * lum * a, a * 0.9);
    }
`;

function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
const k2s = (v, cps) => new THREE.Vector3(v[0] / cps, v[2] / cps, -v[1] / cps);

export function createColliderScene(container, { onFrame, onCommand } = {}) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x04051a, 1);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.setAttribute('tabindex', '0');
    renderer.domElement.setAttribute('aria-label', '3D merger stage — drag to orbit, wheel to zoom; keys 1/2/3 views, F frame, S/A/B follow, 4 corotating, C colour, T trails, R reset');
    renderer.domElement.style.outline = 'none';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 4000);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 9, 11);
    camera.lookAt(0, 0, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.6;
    controls.minDistance = 0.3;
    controls.maxDistance = 600;
    controls.minPolarAngle = 0.02;
    controls.maxPolarAngle = Math.PI - 0.02;
    controls.zoomToCursor = false;

    // ── Static backdrop ─────────────────────────────────────────────────────
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(800 * 3);
    let seed = 12345;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < 800; i++) {
        const r = 900, th = rnd() * Math.PI * 2, ph = Math.acos(2 * rnd() - 1);
        starPos[3 * i] = r * Math.sin(ph) * Math.cos(th);
        starPos[3 * i + 1] = r * Math.cos(ph);
        starPos[3 * i + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x9fb0cc, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.5 })));

    // ── The world group: everything that lives in the kernel's frame ────────
    const world = new THREE.Group();
    scene.add(world);
    const grid = new THREE.GridHelper(40, 40, 0x1d2a55, 0x111a3a);
    grid.material.transparent = true; grid.material.opacity = 0.55;
    world.add(grid);
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.98, 4.02, 128),
        new THREE.MeshBasicMaterial({ color: 0x5ee1ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    world.add(ring);

    // Particles
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX_POINTS * 3);
    const dens = new Float32Array(MAX_POINTS);
    const heat = new Float32Array(MAX_POINTS);
    const flag = new Float32Array(MAX_POINTS);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aDens', new THREE.BufferAttribute(dens, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aHeat', new THREE.BufferAttribute(heat, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aFlag', new THREE.BufferAttribute(flag, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
        vertexShader: POINT_VS, fragmentShader: POINT_FS,
        uniforms: {
            uSize: { value: 0.12 }, uPointScale: { value: 1.0 }, uDensMax: { value: 0 }, uDensSpan: { value: 3 },
            uHeatScale: { value: 20 }, uMode: { value: 0 },
        },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    world.add(points);

    // Black holes
    const bhMeshes = [0, 1].map(() => {
        const g = new THREE.Group();
        g.add(new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), new THREE.MeshBasicMaterial({ color: 0x000000 })));
        const halo = new THREE.Mesh(new THREE.RingGeometry(1.35, 1.6, 96), new THREE.MeshBasicMaterial({ color: 0xffb066, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
        halo.rotation.x = -Math.PI / 2;
        g.add(halo);
        g.visible = false;
        world.add(g);
        return g;
    });

    // Cores, separation line, trails (analysis overlays)
    const coreColors = [0x5ee1ff, 0xf08cff];
    const coreMarks = coreColors.map(c => {
        const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1.0, 40), new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
        m.rotation.x = -Math.PI / 2; m.visible = false; world.add(m); return m;
    });
    const sepGeo = new THREE.BufferGeometry();
    sepGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage));
    const sepLine = new THREE.Line(sepGeo, new THREE.LineDashedMaterial({ color: 0xffb066, dashSize: 0.12, gapSize: 0.08, transparent: true, opacity: 0.7 }));
    sepLine.visible = false; world.add(sepLine);
    const trails = coreColors.map(c => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_TRAIL * 3), 3).setUsage(THREE.DynamicDrawUsage));
        g.setDrawRange(0, 0);
        const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.55 }));
        l.frustumCulled = false; world.add(l);
        return { line: l, n: 0 };
    });
    const bary = new THREE.Mesh(new THREE.OctahedronGeometry(0.06), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7 }));
    bary.visible = false; world.add(bary);

    // Pre-run preview of the configured pair
    const preview = new THREE.Group();
    world.add(preview);

    // ── State ───────────────────────────────────────────────────────────────
    const st = {
        codePerScene: 4, ringCode: 16,
        follow: 'system', corotating: false, colorMode: 'density', trailsOn: true, view: 'oblique',
        pointScale: 1,
        // last frame meta (kernel units)
        cmA: null, cmB: null, mA: 0, mB: 0, sep: 0, omega: 0, hasFrame: false, alive: 0,
        cloudRadius: 2.5,          // scene units, from the last frame
        rotAngle: 0, lastFrameT: 0,
        tween: null,
        followSnap: true,
        running: true, visible: true, hovering: false,
    };

    function resize() {
        const w = container.clientWidth || 640, h = container.clientHeight || 400;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    const io = new IntersectionObserver((entries) => { st.visible = entries.some(e => e.isIntersecting); }, { threshold: 0.02 });
    io.observe(container);
    const onVis = () => { st.running = !document.hidden; };
    document.addEventListener('visibilitychange', onVis);

    // Any user input on the controls cancels a flight (the rule).
    controls.addEventListener('start', () => { st.tween = null; });
    renderer.domElement.addEventListener('pointerenter', () => { st.hovering = true; });
    renderer.domElement.addEventListener('pointerleave', () => { st.hovering = false; });

    // ── Camera helpers ──────────────────────────────────────────────────────
    const sph = new THREE.Spherical();
    const tmpV = new THREE.Vector3();
    function currentSpherical() {
        tmpV.copy(camera.position).sub(controls.target);
        sph.setFromVector3(tmpV);
        return { r: sph.radius, polar: sph.phi, azimuth: sph.theta };
    }
    function applySpherical(r, polar, azimuth) {
        sph.set(r, Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, polar)), azimuth);
        tmpV.setFromSpherical(sph);
        camera.position.copy(controls.target).add(tmpV);
        camera.lookAt(controls.target);
    }
    function flyTo({ r, polar, azimuth }, seconds = TWEEN_S) {
        const from = currentSpherical();
        const to = { r: r ?? from.r, polar: polar ?? from.polar, azimuth: azimuth ?? from.azimuth };
        // shortest azimuth path
        let da = to.azimuth - from.azimuth;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        to.azimuth = from.azimuth + da;
        if (seconds <= 0) { applySpherical(to.r, to.polar, to.azimuth); st.tween = null; return; }
        st.tween = { from, to, t0: performance.now(), dur: seconds * 1000 };
    }
    function stepTween(now) {
        const tw = st.tween; if (!tw) return;
        const u = Math.min(1, (now - tw.t0) / tw.dur);
        const e = easeInOut(u);
        applySpherical(tw.from.r + (tw.to.r - tw.from.r) * e, tw.from.polar + (tw.to.polar - tw.from.polar) * e, tw.from.azimuth + (tw.to.azimuth - tw.from.azimuth) * e);
        if (u >= 1) st.tween = null;
    }
    /** Where the rig should sit, in WORLD coordinates (accounts for the corotating turn). */
    function followPointWorld() {
        let local = null;
        if (st.follow === 'none' || !st.hasFrame) return null;
        if (st.follow === 'A' && st.cmA) local = k2s(st.cmA, st.codePerScene);
        else if (st.follow === 'B' && st.cmB) local = k2s(st.cmB, st.codePerScene);
        else if (st.cmA && st.cmB) {
            const m = st.mA + st.mB || 1;
            local = k2s([(st.mA * st.cmA[0] + st.mB * st.cmB[0]) / m, (st.mA * st.cmA[1] + st.mB * st.cmB[1]) / m, (st.mA * st.cmA[2] + st.mB * st.cmB[2]) / m], st.codePerScene);
        }
        return local ? world.localToWorld(local) : null;
    }
    function stepFollow() {
        const target = followPointWorld();
        if (!target) return;
        // EXACT translation, every frame. An eased version (e-folding 0.18 s)
        // was tried first and measured in headless software GL at ~3 fps: the
        // rig trailed a following core by 75° of orbit, because each rare
        // frame closed only part of a gap the star kept re-opening. The
        // followed point is a mass-density-weighted centroid of hundreds of
        // particles, so there is no jitter worth smoothing.
        const delta = target.sub(controls.target);
        st.followSnap = false;
        controls.target.add(delta);
        camera.position.add(delta);
    }
    function distanceToFit(radiusScene) {
        const vFov = camera.fov * Math.PI / 180;
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        const half = Math.min(vFov, hFov) / 2;
        return Math.max(radiusScene, 0.05) / Math.sin(half) * 1.12;
    }

    // ── Render loop ─────────────────────────────────────────────────────────
    let raf = 0, lastNow = performance.now();
    function loop() {
        raf = requestAnimationFrame(loop);
        const now = performance.now();
        lastNow = now;
        stepFollow();
        stepTween(now);
        controls.update();
        if (!st.running || !st.visible) return;
        if (onFrame) onFrame();
        renderer.render(scene, camera);
    }
    loop();

    // ── Keyboard ────────────────────────────────────────────────────────────
    function onKeyDown(ev) {
        const t = ev.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (!st.hovering && document.activeElement !== renderer.domElement) return;
        const key = ev.key.toLowerCase();
        const handled = {
            '1': () => api.setView('top'), '2': () => api.setView('edge'), '3': () => api.setView('oblique'),
            '4': () => api.setCorotating(!st.corotating), 'f': () => api.frameSystem(),
            's': () => api.setFollow('system'), 'a': () => api.setFollow('A'), 'b': () => api.setFollow('B'), '0': () => api.setFollow('none'),
            'c': () => { const ids = Object.keys(COLOR_MODES); api.setColorMode(ids[(ids.indexOf(st.colorMode) + 1) % ids.length]); },
            't': () => api.setTrails(!st.trailsOn), 'r': () => api.reset(),
            ' ': () => onCommand && onCommand('togglePause'),
            '+': () => flyTo({ r: currentSpherical().r * 0.8 }, 0.3), '=': () => flyTo({ r: currentSpherical().r * 0.8 }, 0.3),
            '-': () => flyTo({ r: currentSpherical().r * 1.25 }, 0.3),
        }[key];
        if (handled) { ev.preventDefault(); handled(); if (onCommand) onCommand('camera-changed'); }
    }
    window.addEventListener('keydown', onKeyDown);

    // ── API ─────────────────────────────────────────────────────────────────
    const api = {
        renderer, scene, camera, controls, world,
        get state() {
            return { view: st.view, follow: st.follow, corotating: st.corotating, colorMode: st.colorMode, trails: st.trailsOn,
                pointScale: st.pointScale, hasFrame: st.hasFrame, tweening: !!st.tween,
                lastMeta: st.cmA && st.cmB ? { cmA: st.cmA.slice(), cmB: st.cmB.slice(), sep: st.sep } : null,
                followPoint: followPointWorld()?.toArray() ?? null };
        },
        /** kernel units per scene unit and the ring radius (kernel units). */
        setScale(cps, ringR) {
            st.codePerScene = cps; st.ringCode = ringR;
            const rs = ringR / cps;
            ring.scale.set(rs / 4, rs / 4, 1);
            const cr = Math.max(0.08, 0.05 * rs);
            coreMarks.forEach(m => m.scale.set(cr, cr, 1));
            bary.scale.setScalar(Math.max(0.5, rs / 4));
        },
        setPointSize(sceneUnits) { mat.uniforms.uSize.value = sceneUnits; },
        setPointScale(mult) { st.pointScale = mult; mat.uniforms.uPointScale.value = mult; },
        setHeatScale(v) { mat.uniforms.uHeatScale.value = v; },
        setColorMode(mode) { if (!COLOR_MODES[mode]) return; st.colorMode = mode; mat.uniforms.uMode.value = COLOR_MODES[mode].id; if (onCommand) onCommand('view-state'); },
        setTrails(on) { st.trailsOn = !!on; trails.forEach(t => { t.line.visible = st.trailsOn && t.n > 1; }); if (onCommand) onCommand('view-state'); },
        setFollow(mode) { if (!FOLLOW_MODES.includes(mode)) return; st.follow = mode; st.followSnap = true; if (onCommand) onCommand('view-state'); },
        setCorotating(on) {
            st.corotating = !!on;
            if (!st.corotating) { world.rotation.y = 0; st.rotAngle = 0; }
            st.followSnap = true;
            if (onCommand) onCommand('view-state');
        },
        setView(preset, { animate = true } = {}) {
            const p = VIEW_PRESETS[preset]; if (!p) return;
            st.view = preset;
            flyTo({ polar: p.polar, azimuth: p.azimuth }, animate ? TWEEN_S : 0);
            if (onCommand) onCommand('view-state');
        },
        /** Fit the particle cloud (or the preview) about the followed point. */
        frameSystem({ animate = true } = {}) {
            const r = distanceToFit(st.cloudRadius);
            flyTo({ r }, animate ? TWEEN_S : 0);
        },
        reset() {
            st.follow = 'system'; st.followSnap = true;
            api.setCorotating(false);
            st.view = 'oblique';
            const p = VIEW_PRESETS.oblique;
            flyTo({ r: distanceToFit(st.cloudRadius), polar: p.polar, azimuth: p.azimuth }, TWEEN_S);
            if (onCommand) onCommand('view-state');
        },
        /**
         * frame: Float32Array [x,y,z,log10ρ,u,flags] × n (stride 6, or 5 for an
         * older kernel); bodies: [{kind, pos, rs}]; meta: {cmA, cmB, mA, mB, sep, omega, time}.
         */
        setFrame(frame, n, bodies = [], meta = null, stride = 6) {
            preview.visible = false;
            const cps = st.codePerScene;
            const cnt = Math.min(n, MAX_POINTS);
            let dmax = -Infinity, k = 0;
            // corotating turn first, so the follow point and the cloud agree this frame
            if (meta) {
                st.cmA = meta.cmA; st.cmB = meta.cmB; st.mA = meta.mA; st.mB = meta.mB; st.sep = meta.sep; st.omega = meta.omega;
                if (st.corotating) {
                    if (meta.sep > 1e-6 && meta.cmA && meta.cmB) {
                        const X = meta.cmA[0] - meta.cmB[0], Z = -(meta.cmA[1] - meta.cmB[1]);
                        st.rotAngle = Math.atan2(Z, X);
                    } else if (Number.isFinite(meta.omega) && meta.time != null && st.lastFrameT) {
                        st.rotAngle += meta.omega * (meta.time - st.lastFrameT);   // kernel ω about +z → scene −y sense handled by sign below
                    }
                    world.rotation.y = st.rotAngle;
                }
                st.lastFrameT = meta.time ?? st.lastFrameT;
            }
            // follow point in local coords for the cloud radius
            const fp = (() => {
                if (st.follow === 'A' && st.cmA) return k2s(st.cmA, cps);
                if (st.follow === 'B' && st.cmB) return k2s(st.cmB, cps);
                if (st.cmA && st.cmB) { const m = st.mA + st.mB || 1; return k2s([(st.mA * st.cmA[0] + st.mB * st.cmB[0]) / m, (st.mA * st.cmA[1] + st.mB * st.cmB[1]) / m, (st.mA * st.cmA[2] + st.mB * st.cmB[2]) / m], cps); }
                return new THREE.Vector3();
            })();
            const radii = [];
            for (let i = 0; i < cnt; i++) {
                const o = stride * i;
                const x = frame[o];
                if (!Number.isFinite(x)) continue;
                const sx = x / cps, sy = frame[o + 2] / cps, sz = -frame[o + 1] / cps;
                pos[3 * k] = sx; pos[3 * k + 1] = sy; pos[3 * k + 2] = sz;
                dens[k] = frame[o + 3];
                heat[k] = frame[o + 4];
                flag[k] = stride >= 6 ? frame[o + 5] : 0;
                if (dens[k] > dmax) dmax = dens[k];
                if ((k & 3) === 0) radii.push(Math.hypot(sx - fp.x, sy - fp.y, sz - fp.z));
                k++;
            }
            geo.setDrawRange(0, k);
            geo.attributes.position.needsUpdate = true;
            geo.attributes.aDens.needsUpdate = true;
            geo.attributes.aHeat.needsUpdate = true;
            geo.attributes.aFlag.needsUpdate = true;
            if (Number.isFinite(dmax)) mat.uniforms.uDensMax.value = dmax;
            st.alive = k; st.hasFrame = k > 0 || bodies.some(b => b && b.kind === 'bh');
            if (radii.length) { radii.sort((a, b) => a - b); st.cloudRadius = Math.max(radii[Math.floor(radii.length * 0.96)], 0.2); }
            else if (bodies.length) st.cloudRadius = Math.max(st.sep / cps, 0.5);
            for (let b = 0; b < 2; b++) {
                const m = bhMeshes[b], body = bodies[b];
                if (body && body.kind === 'bh') {
                    m.visible = true;
                    const r = Math.max(body.rs / cps, 0.03);
                    m.scale.set(r, r, r);
                    m.position.copy(k2s(body.pos, cps));
                } else m.visible = false;
            }
            // cores, separation line, trails, barycentre
            if (st.cmA && st.cmB) {
                const a = k2s(st.cmA, cps), bb = k2s(st.cmB, cps);
                coreMarks[0].position.copy(a); coreMarks[1].position.copy(bb);
                coreMarks.forEach(m => { m.visible = true; });
                const sp = sepGeo.attributes.position.array;
                sp[0] = a.x; sp[1] = a.y; sp[2] = a.z; sp[3] = bb.x; sp[4] = bb.y; sp[5] = bb.z;
                sepGeo.attributes.position.needsUpdate = true;
                sepLine.computeLineDistances();
                sepLine.visible = st.sep / cps > 0.05;
                bary.position.copy(fp.clone().lerp(new THREE.Vector3(), 0)); // fp already the follow point; barycentre drawn only in system-follow
                const m = st.mA + st.mB || 1;
                bary.position.copy(k2s([(st.mA * st.cmA[0] + st.mB * st.cmB[0]) / m, (st.mA * st.cmA[1] + st.mB * st.cmB[1]) / m, (st.mA * st.cmA[2] + st.mB * st.cmB[2]) / m], cps));
                bary.visible = true;
                [a, bb].forEach((p, i) => {
                    const t = trails[i];
                    const arr = t.line.geometry.attributes.position.array;
                    if (t.n >= MAX_TRAIL) { arr.copyWithin(0, 3, MAX_TRAIL * 3); t.n = MAX_TRAIL - 1; }
                    const last = t.n > 0 ? [arr[3 * (t.n - 1)], arr[3 * (t.n - 1) + 1], arr[3 * (t.n - 1) + 2]] : null;
                    if (!last || Math.hypot(last[0] - p.x, last[1] - p.y, last[2] - p.z) > 0.004) {
                        arr[3 * t.n] = p.x; arr[3 * t.n + 1] = p.y; arr[3 * t.n + 2] = p.z; t.n++;
                    }
                    t.line.geometry.setDrawRange(0, t.n);
                    t.line.geometry.attributes.position.needsUpdate = true;
                    t.line.visible = st.trailsOn && t.n > 1;
                });
            }
        },
        /** Pre-run preview: bodies [{kind, radius (code), pos (code[3])}]. */
        setPreview(bodies) {
            while (preview.children.length) { const c = preview.children.pop(); c.geometry?.dispose?.(); c.material?.dispose?.(); }
            const cps = st.codePerScene;
            let maxR = 0.5;
            bodies.forEach((b, i) => {
                const r = Math.max(b.radius / cps, 0.02);
                const p = k2s(b.pos, cps);
                maxR = Math.max(maxR, p.length() + r);
                let mesh;
                if (b.kind === 'bh') {
                    mesh = new THREE.Group();
                    mesh.add(new THREE.Mesh(new THREE.SphereGeometry(r, 32, 20), new THREE.MeshBasicMaterial({ color: 0x000000 })));
                    const halo = new THREE.Mesh(new THREE.RingGeometry(r * 1.35, r * 1.6, 64), new THREE.MeshBasicMaterial({ color: 0xffb066, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false }));
                    halo.rotation.x = -Math.PI / 2; mesh.add(halo);
                } else {
                    mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), new THREE.MeshBasicMaterial({ color: coreColors[i] || 0xffffff, wireframe: true, transparent: true, opacity: 0.28 }));
                }
                mesh.position.copy(p);
                preview.add(mesh);
            });
            preview.visible = true;
            st.hasFrame = false; st.cmA = null; st.cmB = null;
            st.cloudRadius = maxR;
        },
        clearTrails() { trails.forEach(t => { t.n = 0; t.line.geometry.setDrawRange(0, 0); t.line.visible = false; }); },
        setAutoRotate(on) { controls.autoRotate = !!on; },
        /** Back-compat: frame the stage at a distance (used before the first frame). */
        frameAll(distance) { flyTo({ r: distance }, 0); },
        clear() {
            geo.setDrawRange(0, 0); bhMeshes.forEach(m => { m.visible = false; });
            coreMarks.forEach(m => { m.visible = false; }); sepLine.visible = false; bary.visible = false;
            api.clearTrails(); st.hasFrame = false; st.cmA = null; st.cmB = null; world.rotation.y = 0; st.rotAngle = 0;
        },
        dispose() {
            cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
            document.removeEventListener('visibilitychange', onVis);
            window.removeEventListener('keydown', onKeyDown);
            renderer.dispose();
        },
        get codePerScene() { return st.codePerScene; },
        get ringCode() { return st.ringCode; },
        distanceToFit,
    };
    return api;
}
