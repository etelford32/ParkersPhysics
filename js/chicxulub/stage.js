/**
 * chicxulub/stage.js — the 3-D stage. A RENDERER of scene-model.js.
 * ═══════════════════════════════════════════════════════════════════════════
 * 1 scene unit = 1 km, true scale. Axes: +x east, +y up, +z SOUTH (so north
 * is −z and the map reads north-up from the default camera).
 *
 * It computes no physics: every position, radius, height and opacity is read
 * from the kernel at the current time. The one display choice it owns is the
 * VERTICAL EXAGGERATION of the ground (×1 by default; the toggle says ×5) —
 * the body, the fireball and the curtain are never exaggerated.
 *
 * camera.up stays +Y and OrbitControls is built ONCE (the r160 orbit-axis scar
 * cannot occur). Presets are one-shot tweens that any drag, wheel or pinch
 * cancels: the page may START a flight, it may not HOLD the camera.
 * Rendering is ON DEMAND (time change, camera change, resize) — nothing is
 * drawn while the picture is not changing.
 *
 * Only built-in three.js materials are used, so the renderer's tone curve and
 * output encode apply to every pixel through three's own chunks.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as SM from './scene-model.js';

const RINGS = 150, SEGS = 96;
const GROUND = new THREE.Color('#31465c'), GROUND_LINE = new THREE.Color('#5b7896');
const HOT = new THREE.Color('#ff7a2a'), ROCK = new THREE.Color('#6b6258'), BLANKET = new THREE.Color('#8a8378');

function label(text, { size = 46, color = '#cfd6ea' } = {}) {
    const c = document.createElement('canvas'), g = c.getContext('2d');
    g.font = `600 ${size}px Segoe UI, system-ui, sans-serif`;
    c.width = Math.ceil(g.measureText(text).width) + 24; c.height = size + 22;
    g.font = `600 ${size}px Segoe UI, system-ui, sans-serif`; g.fillStyle = color; g.textBaseline = 'middle';
    g.fillText(text, 12, c.height / 2);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false }));
    s.userData.aspect = c.width / c.height;
    s.renderOrder = 10;
    return s;
}
function glowTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.25, 'rgba(255,214,150,.75)'); grd.addColorStop(1, 'rgba(255,120,40,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
}

export function createStage(canvas, tl) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#04070f');
    scene.fog = new THREE.Fog('#04070f', 900, 2600);
    const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 6000);
    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.minDistance = 12; controls.maxDistance = 1800; controls.maxPolarAngle = Math.PI * 0.497;

    scene.add(new THREE.HemisphereLight('#9fb6d8', '#141a26', 0.9));
    const sun = new THREE.DirectionalLight('#fff3df', 2.2); sun.position.set(-500, 420, 380); scene.add(sun);
    const flash = new THREE.PointLight('#ffb070', 0, 0, 0); flash.position.set(0, 30, 0); scene.add(flash);

    // ── ground: a polar grid, dense near the centre ──────────────────────────
    const ringR = new Float32Array(RINGS + 1);
    for (let i = 0; i <= RINGS; i++) ringR[i] = SM.SCENE_RADIUS_KM * (i / RINGS) ** 1.6;
    const nV = 1 + RINGS * SEGS, pos = new Float32Array(nV * 3), col = new Float32Array(nV * 3), idx = [];
    const vr = new Float32Array(nV);
    for (let i = 1; i <= RINGS; i++) for (let j = 0; j < SEGS; j++) {
        const k = 1 + (i - 1) * SEGS + j, a = j / SEGS * Math.PI * 2;
        pos[3 * k] = ringR[i] * Math.sin(a); pos[3 * k + 2] = -ringR[i] * Math.cos(a); vr[k] = ringR[i];
    }
    for (let j = 0; j < SEGS; j++) idx.push(0, 1 + j, 1 + (j + 1) % SEGS);
    for (let i = 1; i < RINGS; i++) for (let j = 0; j < SEGS; j++) {
        const a = 1 + (i - 1) * SEGS + j, b = 1 + (i - 1) * SEGS + (j + 1) % SEGS, c = a + SEGS, d = b + SEGS;
        idx.push(a, c, b, b, c, d);
    }
    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    gGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    gGeo.setIndex(idx);
    const ground = new THREE.Mesh(gGeo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }));
    scene.add(ground);

    // range rings every 100 km + compass
    const rings = new THREE.Group(); scene.add(rings);
    for (let km = 100; km <= 400; km += 100) {
        const pts = []; for (let j = 0; j <= 128; j++) { const a = j / 128 * Math.PI * 2; pts.push(new THREE.Vector3(km * Math.sin(a), 0.6 - SM.curvatureDropKm(km), -km * Math.cos(a))); }
        rings.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: GROUND_LINE, transparent: true, opacity: 0.55 })));
        const l = label(`${km} km`); l.position.set(km * 0.707, 4, km * 0.707); l.userData.px = 15; rings.add(l);
    }
    const north = label('N', { color: '#f3f5ff' }); north.position.set(0, 6, -SM.SCENE_RADIUS_KM * 0.93); north.userData.px = 20; rings.add(north);

    // ── the body ─────────────────────────────────────────────────────────────
    const rockGeo = new THREE.IcosahedronGeometry(1, 5), rp = rockGeo.attributes.position;
    for (let i = 0; i < rp.count; i++) { const f = SM.lumpiness(rp.getX(i), rp.getY(i), rp.getZ(i)); rp.setXYZ(i, rp.getX(i) * f, rp.getY(i) * f, rp.getZ(i) * f); }
    // smooth shading: an icosphere is non-indexed, so face normals would facet it
    { const nrm = rockGeo.attributes.normal, v = new THREE.Vector3(); for (let i = 0; i < rp.count; i++) { v.set(rp.getX(i), rp.getY(i), rp.getZ(i)).normalize(); nrm.setXYZ(i, v.x, v.y, v.z); } }
    const rockMat = new THREE.MeshStandardMaterial({ color: ROCK, roughness: 0.95, metalness: 0.02, emissive: '#ff5a1a', emissiveIntensity: 0 });
    const rock = new THREE.Mesh(rockGeo, rockMat); scene.add(rock);
    const glowTex = glowTexture();
    const bow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
    scene.add(bow);
    // the path it came down
    const dir = SM.travelDirection(tl), far = SM.impactorState(tl, -SM.APPROACH_S * 1.6);
    const pathGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(far.east, far.up, -far.north), new THREE.Vector3(0, tl.diameterKm / 2, 0)]);
    const path = new THREE.Line(pathGeo, new THREE.LineDashedMaterial({ color: '#f3f5ff', dashSize: 6, gapSize: 5, transparent: true, opacity: 0.45 }));
    path.computeLineDistances(); scene.add(path);
    const trail = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: '#ffb070', transparent: true, opacity: 0.9 }));
    scene.add(trail);
    const karman = label('100 km · edge of space'); karman.userData.px = 14;
    { const k = SM.REFERENCE.karmanKm / -dir.up; karman.position.set(-dir.east * k + 14, SM.REFERENCE.karmanKm, dir.north * k); } scene.add(karman);

    // ── scale comparison, standing on the ground uprange-left ────────────────
    const scale = new THREE.Group(); scale.position.set(-70, 0, 70); scale.rotation.y = Math.PI / 4; scene.add(scale);
    const ghost = new THREE.Mesh(rockGeo, new THREE.MeshStandardMaterial({ color: ROCK, roughness: 0.95 }));
    ghost.scale.setScalar(tl.diameterKm / 2); ghost.position.set(0, tl.diameterKm / 2 * 0.98, 0); scale.add(ghost);
    const everest = new THREE.Mesh(new THREE.ConeGeometry(SM.REFERENCE.everestKm * 0.9, SM.REFERENCE.everestKm, 6), new THREE.MeshStandardMaterial({ color: '#b9c2da', roughness: 0.9, flatShading: true }));
    everest.position.set(tl.diameterKm * 0.95, SM.REFERENCE.everestKm / 2, 0); scale.add(everest);
    const lE = label('Everest, 8.8 km'); lE.position.set(tl.diameterKm * 0.95, SM.REFERENCE.everestKm + 2.2, 0); lE.userData.px = 14; scale.add(lE);
    const lA = label(`the asteroid, ${tl.diameterKm.toFixed(0)} km`); lA.position.set(0, tl.diameterKm + 2.4, 0); lA.userData.px = 14; scale.add(lA);
    const cruise = new THREE.Mesh(new THREE.RingGeometry(tl.diameterKm * 1.5, tl.diameterKm * 1.5 + 0.25, 64), new THREE.MeshBasicMaterial({ color: '#7fb0ff', side: THREE.DoubleSide, transparent: true, opacity: 0.7 }));
    cruise.rotation.x = -Math.PI / 2; cruise.position.set(tl.diameterKm * 0.45, SM.REFERENCE.cruiseKm, 0); scale.add(cruise);
    const lC = label('airliners fly here, 11 km'); lC.position.set(tl.diameterKm * 0.45 - tl.diameterKm * 1.5, SM.REFERENCE.cruiseKm + 1.6, 0); lC.userData.px = 13; scale.add(lC);

    // ── fireball and curtain ─────────────────────────────────────────────────
    const fire = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: '#ffb46a', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    scene.add(fire);
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 }));
    scene.add(core);
    const curtain = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 72, 1, true),
        new THREE.MeshStandardMaterial({ color: '#9a8f82', roughness: 1, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, emissive: '#ff6a20', emissiveIntensity: 0 }));
    scene.add(curtain);
    let curtainKey = '';

    const labels = [];
    scene.traverse((o) => { if (o.isSprite && o.userData.px) labels.push(o); });

    // ── state ────────────────────────────────────────────────────────────────
    const S = { t: -SM.APPROACH_S, exaggeration: 1, dirty: true, preset: 'approach', visible: true, frames: 0 };
    const c3 = new THREE.Color();
    function updateGround() {
        const p = gGeo.attributes.position, cA = gGeo.attributes.color;
        const Rc = SM.craterRadiusKm(tl, S.t), glow = SM.meltGlow(tl, S.t), land = SM.landingRadiusKm(S.t);
        for (let k = 0; k < nV; k++) {
            const r = vr[k], h = SM.surfaceHeightKm(tl, r, S.t);
            p.array[3 * k + 1] = h * S.exaggeration - SM.curvatureDropKm(r);
            c3.copy(GROUND);
            if (S.t > 0 && r < Math.max(land, Rc) && r >= Rc) c3.lerp(BLANKET, 0.55 * Math.min(1, (Rc * 1.6 / Math.max(r, 1)) ** 2 + 0.25));
            if (r < Rc) c3.lerp(ROCK, 0.7).lerp(HOT, glow * (0.35 + 0.65 * Math.max(0, 1 - r / Math.max(Rc, 1))));
            cA.array[3 * k] = c3.r; cA.array[3 * k + 1] = c3.g; cA.array[3 * k + 2] = c3.b;
        }
        p.needsUpdate = true; cA.needsUpdate = true; gGeo.computeVertexNormals();
    }
    function apply() {
        const t = S.t, st = SM.impactorState(tl, t);
        updateGround();
        // body
        rock.visible = st.remaining > 0.02;
        rock.position.set(st.east, st.up, -st.north);
        rock.scale.setScalar(st.radiusKm * Math.max(0.05, st.remaining) ** (1 / 3));
        const heat = st.inAtmosphere ? 1 - st.altitudeKm / SM.REFERENCE.karmanKm : t > 0 ? 1 : 0;
        rockMat.emissiveIntensity = 0.9 * heat;
        bow.visible = rock.visible && heat > 0.02;
        bow.position.copy(rock.position).addScaledVector(new THREE.Vector3(dir.east, dir.up, -dir.north), st.radiusKm * 0.5);
        bow.scale.setScalar(st.radiusKm * (2.6 + 3.4 * heat)); bow.material.opacity = 0.85 * heat;
        path.visible = t <= 0; karman.visible = t <= 0;
        trail.visible = t <= 0 && heat > 0;
        if (trail.visible) {
            const k = st.radiusKm, top = SM.impactorState(tl, t - Math.min(4, (SM.REFERENCE.karmanKm - st.altitudeKm) / (tl.speedKms * -dir.up)));
            trail.geometry.setFromPoints([new THREE.Vector3(top.east, top.up, -top.north), new THREE.Vector3(st.east, st.up + k * 0.2, -st.north)]);
        }
        scale.visible = t <= 0;
        // fireball
        const fb = SM.fireballState(tl, t);
        fire.visible = fb.opacity > 0.01 && fb.radiusKm > 0.5;
        fire.scale.setScalar(Math.max(fb.radiusKm, 0.001)); fire.material.opacity = 0.2 * fb.opacity;
        core.visible = t > 0 && fb.opacity > 0.02;
        core.position.set(0, Math.min(40, fb.radiusKm * 0.25), 0);
        core.scale.setScalar(Math.max(1, Math.min(fb.radiusKm, 260) * 1.1)); core.material.opacity = 0.75 * fb.opacity * fb.opacity;
        flash.intensity = 5 * fb.opacity * fb.opacity * (t > 0 ? 1 : 0);      // no distance falloff: keep it small
        // curtain
        const cu = SM.curtainState(tl, t);
        curtain.visible = cu.visible && cu.opacity > 0.01;
        if (curtain.visible) {
            const key = `${cu.baseKm.toFixed(1)}|${cu.heightKm.toFixed(1)}`;
            if (key !== curtainKey) {
                curtain.geometry.dispose();
                curtain.geometry = new THREE.CylinderGeometry(cu.topKm, cu.baseKm, cu.heightKm, 72, 1, true);
                curtainKey = key;
            }
            curtain.position.set(0, cu.heightKm / 2 - SM.curvatureDropKm(cu.baseKm) + SM.surfaceHeightKm(tl, cu.baseKm, t) * S.exaggeration, 0);
            curtain.material.opacity = cu.opacity;
            curtain.material.emissiveIntensity = 0.5 * SM.meltGlow(tl, t * 3);
        }
        S.dirty = true;
    }

    // ── camera ───────────────────────────────────────────────────────────────
    const R = tl.diameterKm / 2;
    const PRESETS = {
        // from the south-east, square-on to the plane the body flies in, so the slant of its path reads true
        approach: { pos: [300, 85, 300], target: [45, 75, -45] },
        size: { pos: [-70 + R * 4.6, R * 1.5, 70 + R * 4.6], target: [-70 + R * 0.35, R * 0.95, 70 - R * 0.35] },
        crater: { pos: [-60, 150, 250], target: [0, -6, 0] },
        region: { pos: [-140, 560, 760], target: [0, 0, 20] },
    };
    let tween = null;
    function fly(name, { instant = false } = {}) {
        const p = PRESETS[name]; if (!p) return;
        S.preset = name;
        const to = { pos: new THREE.Vector3(...p.pos), target: new THREE.Vector3(...p.target) };
        if (instant) { camera.position.copy(to.pos); controls.target.copy(to.target); controls.update(); tween = null; S.dirty = true; return; }
        tween = { from: { pos: camera.position.clone(), target: controls.target.clone() }, to, t0: performance.now(), ms: 900 };
        S.dirty = true;
    }
    controls.addEventListener('start', () => { tween = null; });
    controls.addEventListener('change', () => { S.dirty = true; });

    function resize() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); S.dirty = true;
    }
    new ResizeObserver(resize).observe(canvas);
    new IntersectionObserver((e) => { S.visible = e[0].isIntersecting; if (S.visible) S.dirty = true; }).observe(canvas);

    const tmp = new THREE.Vector3();
    function frame(now) {
        requestAnimationFrame(frame);
        if (tween) {
            const u = Math.min(1, (now - tween.t0) / tween.ms), e = u * u * (3 - 2 * u);
            camera.position.lerpVectors(tween.from.pos, tween.to.pos, e);
            controls.target.lerpVectors(tween.from.target, tween.to.target, e);
            if (u >= 1) tween = null;
            S.dirty = true;
        }
        if (controls.update()) S.dirty = true;
        if (!S.dirty || !S.visible) return;
        // labels hold a constant size on screen
        const hPx = canvas.clientHeight || 1, k = 2 * Math.tan(camera.fov * Math.PI / 360) / hPx;
        for (const l of labels) { const d = tmp.setFromMatrixPosition(l.matrixWorld).distanceTo(camera.position), s = l.userData.px * k * d; l.scale.set(s * l.userData.aspect, s, 1); }
        renderer.render(scene, camera);
        S.dirty = false; S.frames++;
    }

    resize(); fly('approach', { instant: true }); apply();
    scene.updateMatrixWorld(true);
    requestAnimationFrame(frame);

    return {
        setTime(t) { S.t = Math.max(-SM.APPROACH_S, Math.min(SM.END_S, t)); apply(); },
        setExaggeration(x) { S.exaggeration = x; apply(); },
        fly,
        get state() { return { t: S.t, exaggeration: S.exaggeration, preset: S.preset, frames: S.frames, flying: !!tween }; },
        /** test hook: world positions and sizes of what is drawn (no physics). */
        probe() {
            const p = gGeo.attributes.position.array;
            return {
                rock: { visible: rock.visible, x: rock.position.x, y: rock.position.y, z: rock.position.z, radius: rock.scale.x },
                centreY: p[1], fireball: { visible: fire.visible, radius: fire.scale.x }, curtain: { visible: curtain.visible },
                camera: camera.position.toArray(), target: controls.target.toArray(), up: camera.up.toArray(),
            };
        },
        renderNow() { scene.updateMatrixWorld(true); renderer.render(scene, camera); },
        renderer,
    };
}
