/**
 * stage.js — the 3D block of sea floor on sea-floor.html. A RENDERER of kernel numbers: it draws
 * the baked grid, the casts and a sounding, and computes no physics (the ping's travel time, the
 * first-return point and every depth are handed in by the page from the PURE kernels).
 *
 * Scene units are KILOMETRES: +x east, +z south, +y up; sea level is y = 0 and the floor is at
 * y = −depth × exaggeration. THE ONE DISHONEST NUMBER IS THE VERTICAL EXAGGERATION — a trench is
 * ~100 km wide and ~11 km deep, so at true scale it is a shallow crease — and it is printed on
 * the stage and removable (1×). `camera.up` stays +Y and OrbitControls is built ONCE (the
 * vendored-r160 orbit-axis scar cannot occur); presets are one-shot, never a per-frame hold.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { depthAtCell, cellLat, cellLon, localOffsetKm, sampleDepth, R_EARTH_KM } from './bathy.js';
import { depthColor, temperatureColor } from './page-model.js';

const MAX_SIDE = 260;
const D2R = Math.PI / 180;

export function createStage(host, { onPick = null } = {}) {
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false }); }
    catch (e) { return null; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x050912, 1);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 6000);
    camera.up.set(0, 1, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.12;
    controls.maxPolarAngle = Math.PI * 0.495;
    scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x0a1020, 0.95));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5); sun.position.set(-0.6, 1, 0.5); scene.add(sun);

    const world = new THREE.Group(); scene.add(world);
    let grid = null, origin = null, exag = 5, terrain = null, sea = null, extent = { x: 200, z: 200 };
    const castGroup = new THREE.Group(), markGroup = new THREE.Group(), pingGroup = new THREE.Group();
    world.add(castGroup, markGroup, pingGroup);
    let casts = [], marks = null, ping = null, dirty = true, visible = true, raf = 0;
    const state = { exaggeration: exag, vertices: 0, casts: 0, pinging: false, frames: 0 };

    const toScene = (lat, lon, depthM) => {
        const o = localOffsetKm(origin.lat, origin.lon, lat, lon);
        return new THREE.Vector3(o.e, -depthM / 1000 * exag, -o.n);
    };

    function buildTerrain() {
        if (terrain) { world.remove(terrain); terrain.geometry.dispose(); terrain.material.dispose(); }
        const stride = Math.max(1, Math.ceil(Math.max(grid.nx, grid.ny) / MAX_SIDE));
        const nx = Math.floor((grid.nx - 1) / stride) + 1, ny = Math.floor((grid.ny - 1) / stride) + 1;
        const pos = new Float32Array(nx * ny * 3), col = new Float32Array(nx * ny * 3), idx = [];
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
            const gi = i * stride, gj = j * stride, k = (j * nx + i) * 3;
            const d = depthAtCell(grid, gi, gj);
            const o = localOffsetKm(origin.lat, origin.lon, cellLat(grid, gj), cellLon(grid, gi));
            // rows keep a common x per column (the window's own cos φ) so the block is a rectangle, not a trapezoid
            pos[k] = o.e; pos[k + 1] = -d / 1000 * exag; pos[k + 2] = -o.n;
            const c = depthColor(d);
            col[k] = srgb(c[0]); col[k + 1] = srgb(c[1]); col[k + 2] = srgb(c[2]);
            minX = Math.min(minX, o.e); maxX = Math.max(maxX, o.e); minZ = Math.min(minZ, -o.n); maxZ = Math.max(maxZ, -o.n);
        }
        for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
            const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
            idx.push(a, c, b, b, c, d);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        g.setIndex(idx); g.computeVertexNormals();
        terrain = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, side: THREE.DoubleSide }));
        world.add(terrain);
        extent = { x: maxX - minX, z: maxZ - minZ, minX, maxX, minZ, maxZ };
        state.vertices = nx * ny;
        if (sea) { world.remove(sea); sea.geometry.dispose(); sea.material.dispose(); }
        sea = new THREE.Mesh(new THREE.PlaneGeometry(extent.x, extent.z).rotateX(-Math.PI / 2),
            new THREE.MeshBasicMaterial({ color: 0x4a90d9, transparent: true, opacity: 0.10, depthWrite: false, side: THREE.DoubleSide }));
        sea.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
        world.add(sea);
    }

    function clear(group) { while (group.children.length) { const o = group.children.pop(); o.geometry && o.geometry.dispose(); o.material && o.material.dispose(); } }

    function buildCasts() {
        clear(castGroup);
        let n = 0;
        for (const c of casts) {
            if (sampleDepth(grid, c.lat, c.lon) == null) continue;
            const pts = [], cols = [];
            for (let i = 0; i < c.z.length; i++) {
                const v = toScene(c.lat, c.lon, c.z[i]); pts.push(v.x, v.y, v.z);
                const k = temperatureColor(c.t[i]); cols.push(srgb(k[0]), srgb(k[1]), srgb(k[2]));
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
            g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
            const line = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: c.selected ? 1 : 0.55 }));
            castGroup.add(line);
            const top = new THREE.Mesh(new THREE.SphereGeometry(c.selected ? 1.6 : 1.0, 12, 8), new THREE.MeshBasicMaterial({ color: c.selected ? 0xffe2a0 : 0xb9a37a }));
            top.position.copy(toScene(c.lat, c.lon, 0)); castGroup.add(top);
            n++;
        }
        state.casts = n;
    }

    function buildMarks() {
        clear(markGroup);
        if (!marks) return;
        if (marks.section && marks.section.length) {
            const pts = [];
            for (const p of marks.section) if (p.depth != null) { const v = toScene(p.lat, p.lon, p.depth); pts.push(v.x, v.y + 0.15, v.z); }
            const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
            markGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 })));
        }
        if (marks.point) {
            const a = toScene(marks.point.lat, marks.point.lon, 0), b = toScene(marks.point.lat, marks.point.lon, marks.point.depth);
            const g = new THREE.BufferGeometry().setFromPoints([a, b]);
            markGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x9fe8ff })));
            const s = new THREE.Mesh(new THREE.SphereGeometry(1.4, 14, 10), new THREE.MeshBasicMaterial({ color: 0x9fe8ff })); s.position.copy(b); markGroup.add(s);
            const ship = new THREE.Mesh(new THREE.ConeGeometry(1.6, 3.2, 12).rotateX(Math.PI), new THREE.MeshBasicMaterial({ color: 0xffffff })); ship.position.copy(a).y += 1.6; markGroup.add(ship);
            if (marks.beamDeg > 0) {
                // the beam cone: a real cone in real space, so the exaggeration squashes its footprint ÷ exag on screen — drawn at its TRUE footprint
                const r = marks.point.depth / 1000 * Math.tan(marks.beamDeg * D2R / 2), h = marks.point.depth / 1000 * exag;
                const cone = new THREE.Mesh(new THREE.ConeGeometry(r, h, 36, 1, true),
                    new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.10, depthWrite: false, side: THREE.DoubleSide }));
                cone.position.set(a.x, -h / 2, a.z); markGroup.add(cone);
            }
        }
        if (marks.hit && marks.hit.offKm > 0.05) {
            const a = toScene(marks.point.lat, marks.point.lon, 0), b = toScene(marks.hit.lat, marks.hit.lon, marks.hit.depth);
            const g = new THREE.BufferGeometry().setFromPoints([a, b]);
            markGroup.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xff9a5c })));
            const s = new THREE.Mesh(new THREE.SphereGeometry(1.4, 14, 10), new THREE.MeshBasicMaterial({ color: 0xff9a5c })); s.position.copy(b); markGroup.add(s);
        }
    }

    function frameAll(preset = 'oblique') {
        const cx = (extent.minX + extent.maxX) / 2, cz = (extent.minZ + extent.maxZ) / 2;
        const r = Math.max(extent.x, extent.z);
        controls.target.set(cx, -3 * exag * 0.6, cz);
        if (preset === 'top') camera.position.set(cx, r * 1.45, cz + 0.01);
        else if (preset === 'section') camera.position.set(cx, r * 0.10, cz + r * 1.25);
        else camera.position.set(cx - r * 0.55, r * 0.62, cz + r * 0.95);
        controls.minDistance = 8; controls.maxDistance = r * 4;
        controls.update(); dirty = true;
    }

    function resize() {
        const w = host.clientWidth || 600, h = host.clientHeight || 400;
        renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
    }
    const ro = new ResizeObserver(resize); ro.observe(host);
    const io = new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) dirty = true; }); io.observe(host);
    controls.addEventListener('change', () => { dirty = true; });

    // picking: a pointerup within 6 px / 600 ms of its pointerdown (event.timeStamp) — a drag belongs to the camera
    let down = null;
    const ray = new THREE.Raycaster();
    renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; });
    renderer.domElement.addEventListener('pointerup', (e) => {
        if (!down || !terrain || !onPick) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = e.timeStamp - down.t; down = null;
        if (moved > 6 || dt > 600) return;
        const hit = pickAt(e.clientX, e.clientY);
        if (hit) onPick(hit);
    });
    function pickAt(clientX, clientY) {
        const r = renderer.domElement.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
        const h = ray.intersectObject(terrain, false)[0];
        if (!h) return null;
        const lat = origin.lat + (-h.point.z) / R_EARTH_KM / D2R;
        const lon = origin.lon + h.point.x / (R_EARTH_KM * Math.cos(origin.lat * D2R)) / D2R;
        return { lat, lon };
    }

    function tick(now) {
        raf = requestAnimationFrame(tick);
        if (!visible) return;
        if (ping) {
            // the pulse is drawn on a COMPRESSED clock (the page prints the real two-way time)
            const f = Math.min(1, (now - ping.t0) / ping.wallMs);
            const down1 = f < 0.5, u = down1 ? f * 2 : 2 - f * 2;
            ping.mesh.position.lerpVectors(ping.a, ping.b, u);
            ping.mesh.material.opacity = 0.95;
            if (f >= 1) { pingGroup.remove(ping.mesh); ping.mesh.geometry.dispose(); ping.mesh.material.dispose(); const cb = ping.done; ping = null; state.pinging = false; cb && cb(); }
            dirty = true;
        }
        if (controls.update()) dirty = true;
        if (!dirty) return;
        dirty = false; state.frames++;
        renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(tick);
    resize();

    return {
        state,
        setGrid(g, o) { grid = g; origin = o; buildTerrain(); buildCasts(); buildMarks(); frameAll(); },
        setExaggeration(x) { exag = x; state.exaggeration = x; if (grid) { buildTerrain(); buildCasts(); buildMarks(); controls.target.y = -3 * exag * 0.6; } dirty = true; },
        setCasts(list) { casts = list || []; if (grid) buildCasts(); dirty = true; },
        setMarks(m) { marks = m; if (grid) buildMarks(); dirty = true; },
        view(preset) { frameAll(preset); },
        ping({ lat, lon, depth, hit = null, wallMs = 2600, done = null }) {
            if (!grid) return;
            if (ping) { pingGroup.remove(ping.mesh); }
            const a = toScene(lat, lon, 0), b = hit ? toScene(hit.lat, hit.lon, hit.depth) : toScene(lat, lon, depth);
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(2.2, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
            pingGroup.add(mesh);
            ping = { a, b, mesh, t0: performance.now(), wallMs, done }; state.pinging = true; dirty = true;
        },
        pickAt, toScreen(lat, lon, depthM) {
            const v = toScene(lat, lon, depthM).project(camera), r = renderer.domElement.getBoundingClientRect();
            return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, front: v.z < 1 };
        },
        dispose() { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); controls.dispose(); renderer.dispose(); },
    };
}

/** sRGB byte → linear float (three's vertex colours are linear). */
function srgb(b) { const c = b / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
