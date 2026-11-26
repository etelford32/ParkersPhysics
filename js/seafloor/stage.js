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

const CLEARANCE_KM = 0.35;                 // the camera is kept this far (drawn) above the sea floor
const CAMERA_EVENT_MS = 120;

/**
 * UNDERWATER: the camera may go below y = 0. Nothing here knows any optics — the page injects
 * `ambient(depthM)` (page-model's `ambientColor`, sRGB bytes) and the backdrop takes that colour;
 * the terrain stays lit by the scene's own lamp (disclosed on the page: real water is opaque
 * past ~100 m, so the water is drawn clear). `onCamera({ lat, lon, depthM })` reports where the
 * camera is, throttled; depth is TRUE metres (drawn y ÷ exaggeration).
 */
export function createStage(host, { onPick = null, onCamera = null, ambient = null } = {}) {
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
    const castGroup = new THREE.Group(), markGroup = new THREE.Group(), pingGroup = new THREE.Group(), plateGroup = new THREE.Group();
    world.add(castGroup, markGroup, pingGroup, plateGroup);
    let plateData = null;
    let casts = [], marks = null, ping = null, dirty = true, visible = true, raf = 0;
    const state = { exaggeration: exag, vertices: 0, casts: 0, pinging: false, frames: 0, cameraDepthM: 0, underwater: false, flying: false, boundaryLines: 0 };
    let flight = null, lastCamEvent = 0, lastCamKey = '';
    const keys = new Set();

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
            const s = new THREE.Mesh(new THREE.SphereGeometry(0.7, 14, 10), new THREE.MeshBasicMaterial({ color: 0x9fe8ff })); s.position.copy(b); markGroup.add(s);
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

    /**
     * The plate boundary inside this block, DRAPED on the sea floor, and one arrow on the sea surface for the
     * downgoing plate's motion. Numbers are handed in (trench-model.js); the arrow's LENGTH is symbolic.
     */
    function buildPlates() {
        clear(plateGroup);
        if (!plateData || !grid) return;
        let n = 0;
        for (const g of plateData.segments) {
            const pts = [];
            for (let k = 0; k <= 6; k++) {
                const f = k / 6, lat = g.lat1 + (g.lat2 - g.lat1) * f; let dl = g.lon2 - g.lon1; dl -= 360 * Math.round(dl / 360);
                const lon = g.lon1 + dl * f, d = sampleDepth(grid, lat, lon);
                if (d == null) { if (pts.length >= 6) flush(pts, g); pts.length = 0; continue; }
                const v = toScene(lat, lon, Math.max(d, 0)); pts.push(v.x, v.y + 0.35, v.z);
            }
            if (pts.length >= 6) flush(pts, g);
        }
        function flush(pts, g) {
            const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.slice(), 3));
            plateGroup.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(plateData.styles[g.family].hex), depthTest: false, transparent: true, opacity: 0.9 }))); n++;
        }
        if (plateData.arrow) {
            const a = plateData.arrow, b = a.bearingDeg * D2R, from = toScene(a.lat, a.lon, 0), len = Math.min(extent.x, extent.z) * 0.16;
            const arrow = new THREE.ArrowHelper(new THREE.Vector3(Math.sin(b), 0, -Math.cos(b)), from.setY(1.2), len, 0xffffff, len * 0.28, len * 0.14);
            plateGroup.add(arrow);
        }
        state.boundaryLines = n;
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

    // one-shot flights: the page may START one, any drag / wheel / key cancels it (never a per-frame hold)
    controls.addEventListener('start', () => { flight = null; state.flying = false; });
    function fly(toPos, toTarget, ms = 2400) {
        flight = { p0: camera.position.clone(), t0: controls.target.clone(), p1: toPos, t1: toTarget, start: performance.now(), ms };
        state.flying = true; dirty = true;
    }
    const camGeo = () => ({
        lat: origin.lat + (-camera.position.z) / R_EARTH_KM / D2R,
        lon: origin.lon + camera.position.x / (R_EARTH_KM * Math.cos(origin.lat * D2R)) / D2R,
        depthM: -camera.position.y / exag * 1000,
    });
    function floorY(x, z) {
        const d = sampleDepth(grid, origin.lat + (-z) / R_EARTH_KM / D2R, origin.lon + x / (R_EARTH_KM * Math.cos(origin.lat * D2R)) / D2R);
        return d == null ? null : -d / 1000 * exag;
    }
    host.tabIndex = 0;
    host.addEventListener('keydown', (e) => {
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'q', 'e'].includes(k)) { keys.add(k); flight = null; state.flying = false; e.preventDefault(); }
    });
    host.addEventListener('keyup', (e) => { keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); });
    host.addEventListener('blur', () => keys.clear());
    let lastTick = 0;
    function moveByKeys(dt) {
        if (!keys.size || !grid) return;
        const f = new THREE.Vector3().subVectors(controls.target, camera.position); f.y = 0;
        if (f.lengthSq() < 1e-9) f.set(0, 0, -1); f.normalize();
        const r = new THREE.Vector3(-f.z, 0, f.x);
        const dist = camera.position.distanceTo(controls.target), sp = Math.max(4, dist * 0.9) * dt;      // a NAVIGATION speed: faster when further out
        const mv = new THREE.Vector3();
        if (keys.has('w') || keys.has('ArrowUp')) mv.add(f); if (keys.has('s') || keys.has('ArrowDown')) mv.sub(f);
        if (keys.has('d') || keys.has('ArrowRight')) mv.add(r); if (keys.has('a') || keys.has('ArrowLeft')) mv.sub(r);
        mv.multiplyScalar(sp);
        const nx = Math.min(extent.maxX, Math.max(extent.minX, controls.target.x + mv.x)), nz = Math.min(extent.maxZ, Math.max(extent.minZ, controls.target.z + mv.z));
        const dx = nx - controls.target.x, dz = nz - controls.target.z, y0 = controls.target.y;
        let dy = 0; const fy = floorY(nx, nz); if (fy != null) dy = fy - y0;                               // the pivot rides the sea floor
        controls.target.set(nx, y0 + dy, nz); camera.position.x += dx; camera.position.z += dz; camera.position.y += dy;
        if (keys.has('e')) camera.position.y += sp * 0.6; if (keys.has('q')) camera.position.y -= sp * 0.6;
        dirty = true;
    }

    function tick(now) {
        raf = requestAnimationFrame(tick);
        if (!visible) return;
        const dt = Math.min(0.1, lastTick ? (now - lastTick) / 1000 : 0); lastTick = now;
        if (flight) {
            const u = Math.min(1, (now - flight.start) / flight.ms), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
            camera.position.lerpVectors(flight.p0, flight.p1, e); controls.target.lerpVectors(flight.t0, flight.t1, e);
            if (u >= 1) { flight = null; state.flying = false; }
            dirty = true;
        }
        moveByKeys(dt);
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
        if (grid) {
            // never inside the sea floor
            const fy = floorY(camera.position.x, camera.position.z);
            if (fy != null && camera.position.y < fy + CLEARANCE_KM) { camera.position.y = fy + CLEARANCE_KM; dirty = true; }
            const cg = camGeo(); state.cameraDepthM = cg.depthM; state.underwater = cg.depthM > 0;
            const key = `${cg.lat.toFixed(4)}|${cg.lon.toFixed(4)}|${Math.round(cg.depthM / 5)}`;
            if (onCamera && key !== lastCamKey && now - lastCamEvent > CAMERA_EVENT_MS) { lastCamKey = key; lastCamEvent = now; onCamera(cg); }
        }
        if (!dirty) return;
        dirty = false; state.frames++;
        if (ambient) {
            const c = ambient(state.cameraDepthM), col = new THREE.Color(srgb(c[0]), srgb(c[1]), srgb(c[2]));
            renderer.setClearColor(col, 1);
            // under water a light haze of the same colour gives distance a cue (a display choice, disclosed on the page)
            if (state.underwater) { if (!scene.fog) scene.fog = new THREE.Fog(col, 30, 520); scene.fog.color.copy(col); } else scene.fog = null;
        }
        if (sea) sea.material.opacity = state.underwater ? 0.22 : 0.10;
        renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(tick);
    resize();

    return {
        state,
        setGrid(g, o) { grid = g; origin = o; buildTerrain(); buildCasts(); buildMarks(); buildPlates(); frameAll(); },
        setPlates(d) { plateData = d; if (grid) buildPlates(); dirty = true; },
        setExaggeration(x) { exag = x; state.exaggeration = x; if (grid) { buildTerrain(); buildCasts(); buildMarks(); buildPlates(); controls.target.y = -3 * exag * 0.6; } dirty = true; },
        setCasts(list) { casts = list || []; if (grid) buildCasts(); dirty = true; },
        setMarks(m) { marks = m; if (grid) buildMarks(); dirty = true; },
        view(preset) { flight = null; state.flying = false; frameAll(preset); },
        /** Fly beneath the surface to just above the sea floor at a point (one-shot; any input cancels it). */
        dive({ lat, lon, depth, alongDeg = null }) {
            if (!grid) return;
            const floor = toScene(lat, lon, depth);
            let back = new THREE.Vector3().subVectors(camera.position, controls.target); back.y = 0;
            if (back.lengthSq() < 1e-6) back.set(-0.5, 0, 0.85); back.normalize();
            if (alongDeg != null) {
                // approach ALONG the deepest line (a trench's axis), from whichever end is nearer the current view:
                // approached across it, the camera would end over the shallower wall and be pushed back up
                const a = alongDeg * D2R, ax = new THREE.Vector3(Math.sin(a), 0, -Math.cos(a));
                back = ax.dot(back) >= 0 ? ax : ax.negate();
            }
            // end pose: a third of the way up the (drawn) water column, as far back as the sea floor stays below the camera
            const column = depth / 1000 * exag, up = Math.max(1.5, column * 0.3), want = Math.max(22, column * 2.4);
            let dist = want;
            for (; dist > 6; dist *= 0.85) {
                let clear = true;
                for (let k = 1; k <= 8 && clear; k++) { const q = floor.clone().addScaledVector(back, dist * k / 8), fy = floorY(q.x, q.z); if (fy == null || fy + CLEARANCE_KM > floor.y + up * (0.35 + 0.65 * k / 8)) clear = false; }
                if (clear) break;
            }
            fly(floor.clone().addScaledVector(back, dist).setY(floor.y + up), floor, 2600);
        },
        camera: () => (grid ? camGeo() : null),
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
