/**
 * star-collider/scene.js — the collider's three.js stage
 * ═══════════════════════════════════════════════════════════════════════════
 * Draws what the SPH kernel computes and nothing else: one Points cloud
 * (position, log-density, thermal energy per particle, straight from the
 * worker's packed frame), two optional black-hole spheres, a scale ring and
 * a faint orbital-plane grid. No physics lives here.
 *
 * FRAME. The kernel's orbital plane is x–y with the angular momentum along
 * +z. The stage is Y-UP, so kernel (x, y, z) → scene (x, z, −y): a ROTATION
 * (det +1), not the y↔z swap, which would mirror the orbital sense. The
 * camera starts above the plane looking down, so the inspiral reads as the
 * top-down picture every merger paper draws.
 *
 * SCALE. `setScale(codePerScene)` maps kernel length units to scene units so
 * a 20-km neutron star and a 6000-km white dwarf both fill the same stage;
 * the ring under the system is labelled in physical km by page.js, so the
 * compression is disclosed on the stage itself.
 *
 * COLOUR. log₁₀ρ over the top three decades below the frame's maximum runs
 * a cold→hot ramp (deep blue → cyan → white → yellow); the thermal energy u
 * (the shock-heating record) pushes a particle toward white-orange. Points
 * are additive so overlapping particles brighten, which is what a column
 * density looks like. Camera-distance-scaled point size, floored at 2 px.
 *
 * `camera.up` never changes (Y-up throughout), so OrbitControls is built once
 * and never rebuilt — the Mars/Moon/Stage orbit-axis scar cannot occur here.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MAX_POINTS = 8192;

const POINT_VS = /* glsl */`
    attribute float aDens;
    attribute float aHeat;
    uniform float uSize;
    uniform float uDensMax;
    uniform float uDensSpan;
    uniform float uHeatScale;
    varying float vDens;
    varying float vHeat;
    void main() {
        vDens = clamp((aDens - (uDensMax - uDensSpan)) / uDensSpan, 0.0, 1.0);
        vHeat = clamp(aHeat * uHeatScale, 0.0, 1.0);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float px = uSize * (240.0 / max(-mv.z, 0.05));
        gl_PointSize = max(px, 2.0);
        gl_Position = projectionMatrix * mv;
    }
`;
const POINT_FS = /* glsl */`
    precision highp float;
    varying float vDens;
    varying float vHeat;
    vec3 ramp(float t) {
        vec3 c0 = vec3(0.06, 0.10, 0.45);
        vec3 c1 = vec3(0.10, 0.55, 0.95);
        vec3 c2 = vec3(0.65, 0.95, 1.00);
        vec3 c3 = vec3(1.00, 0.97, 0.80);
        if (t < 0.33) return mix(c0, c1, t / 0.33);
        if (t < 0.66) return mix(c1, c2, (t - 0.33) / 0.33);
        return mix(c2, c3, (t - 0.66) / 0.34);
    }
    void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        float a = exp(-r2 * 9.0);
        vec3 col = ramp(vDens);
        col = mix(col, vec3(1.0, 0.72, 0.35), vHeat * 0.8);
        float lum = 0.18 + 0.82 * vDens;
        gl_FragColor = vec4(col * lum * a, a * 0.9);
    }
`;

export function createColliderScene(container, { onFrame } = {}) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x04051a, 1);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 2000);
    camera.up.set(0, 1, 0);
    camera.position.set(0, 9, 11);
    camera.lookAt(0, 0, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.autoRotate = false;
    controls.autoRotateSpeed = 0.6;
    controls.minDistance = 0.5;
    controls.maxDistance = 400;

    // Stars
    const starGeo = new THREE.BufferGeometry();
    const starPos = new Float32Array(800 * 3);
    for (let i = 0; i < 800; i++) {
        const r = 600, th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
        starPos[3 * i] = r * Math.sin(ph) * Math.cos(th);
        starPos[3 * i + 1] = r * Math.cos(ph);
        starPos[3 * i + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x9fb0cc, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.5 })));

    // Orbital-plane grid + scale ring (y = 0 plane)
    const grid = new THREE.GridHelper(40, 40, 0x1d2a55, 0x111a3a);
    grid.material.transparent = true; grid.material.opacity = 0.55;
    scene.add(grid);
    const ringGeo = new THREE.RingGeometry(3.98, 4.02, 128);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x5ee1ff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);

    // Particles
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(MAX_POINTS * 3);
    const dens = new Float32Array(MAX_POINTS);
    const heat = new Float32Array(MAX_POINTS);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aDens', new THREE.BufferAttribute(dens, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aHeat', new THREE.BufferAttribute(heat, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
        vertexShader: POINT_VS, fragmentShader: POINT_FS,
        uniforms: { uSize: { value: 0.12 }, uDensMax: { value: 0 }, uDensSpan: { value: 3 }, uHeatScale: { value: 20 } },
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    scene.add(points);

    // Black holes
    const bhMeshes = [0, 1].map(() => {
        const g = new THREE.Group();
        const body = new THREE.Mesh(new THREE.SphereGeometry(1, 40, 24), new THREE.MeshBasicMaterial({ color: 0x000000 }));
        const halo = new THREE.Mesh(new THREE.RingGeometry(1.35, 1.6, 96), new THREE.MeshBasicMaterial({ color: 0xffb066, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }));
        halo.rotation.x = -Math.PI / 2;
        g.add(body); g.add(halo);
        g.visible = false;
        scene.add(g);
        return g;
    });

    let codePerScene = 4;   // kernel units per scene unit
    let ringCode = 16;      // ring radius in kernel units
    let running = true;
    let visible = true;

    function resize() {
        const w = container.clientWidth || 640, h = container.clientHeight || 400;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    const io = new IntersectionObserver((entries) => { visible = entries.some(e => e.isIntersecting); }, { threshold: 0.02 });
    io.observe(container);
    const onVis = () => { running = !document.hidden; };
    document.addEventListener('visibilitychange', onVis);

    let raf = 0;
    function loop() {
        raf = requestAnimationFrame(loop);
        controls.update();
        if (!running || !visible) return;
        if (onFrame) onFrame();
        renderer.render(scene, camera);
    }
    loop();

    const api = {
        renderer, scene, camera, controls,
        /** kernel units per scene unit and the ring radius (kernel units). */
        setScale(cps, ringR) {
            codePerScene = cps;
            ringCode = ringR;
            const rs = ringR / cps;
            ring.scale.set(rs / 4, rs / 4, 1);
        },
        setPointSize(sceneUnits) { mat.uniforms.uSize.value = sceneUnits; },
        /** frame: Float32Array [x,y,z,log10ρ,u] × n; bodies: [{kind, pos, rs}] */
        setFrame(frame, n, bodies = []) {
            const cnt = Math.min(n, MAX_POINTS);
            let dmax = -Infinity;
            let k = 0;
            for (let i = 0; i < cnt; i++) {
                const o = 5 * i;
                const x = frame[o];
                if (!Number.isFinite(x)) continue;
                pos[3 * k] = x / codePerScene;
                pos[3 * k + 1] = frame[o + 2] / codePerScene;
                pos[3 * k + 2] = -frame[o + 1] / codePerScene;
                dens[k] = frame[o + 3];
                heat[k] = frame[o + 4];
                if (dens[k] > dmax) dmax = dens[k];
                k++;
            }
            geo.setDrawRange(0, k);
            geo.attributes.position.needsUpdate = true;
            geo.attributes.aDens.needsUpdate = true;
            geo.attributes.aHeat.needsUpdate = true;
            if (Number.isFinite(dmax)) mat.uniforms.uDensMax.value = dmax;
            for (let b = 0; b < 2; b++) {
                const m = bhMeshes[b], body = bodies[b];
                if (body && body.kind === 'bh') {
                    m.visible = true;
                    const r = Math.max(body.rs / codePerScene, 0.03);
                    m.scale.set(r, r, r);
                    m.position.set(body.pos[0] / codePerScene, body.pos[2] / codePerScene, -body.pos[1] / codePerScene);
                } else m.visible = false;
            }
        },
        setHeatScale(v) { mat.uniforms.uHeatScale.value = v; },
        setAutoRotate(on) { controls.autoRotate = !!on; },
        frameAll(distance) {
            camera.position.set(0, distance * 0.8, distance * 0.95);
            controls.target.set(0, 0, 0);
            camera.lookAt(0, 0, 0);
        },
        clear() { geo.setDrawRange(0, 0); bhMeshes.forEach(m => { m.visible = false; }); },
        dispose() {
            cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
            document.removeEventListener('visibilitychange', onVis);
            renderer.dispose();
        },
        get codePerScene() { return codePerScene; },
        get ringCode() { return ringCode; },
    };
    return api;
}
