/**
 * deep-time/globe.js — the globe of deep-time-earth.html. A RENDERER: it
 * draws the plate model's own pieces where js/paleo/rotations.js puts them
 * and computes no position of its own.
 *
 * How it draws (each choice was the simple one that is also exact):
 *   - Every piece of today's surface (the model's static polygons, its
 *     continental polygons, today's coastlines) is triangulated ONCE in
 *     present-day lon/lat and merged into one mesh PER PLATE. Moving the
 *     plates to an age is then nothing but setting each plate mesh's
 *     quaternion to the kernel's total rotation — the geometry is never
 *     rebuilt and there is no clipping to get wrong (the depth test hides
 *     the far side).
 *   - Triangles are subdivided in LON/LAT (longest edge ≤ SUBDIV_DEG), not in
 *     3-D: a triangle spanning a polar ring has two corners at one point in
 *     3-D, and only a lon/lat split recovers its area.
 *   - A piece of crust that does not exist yet at the displayed age (its
 *     appearance age is younger) is DISCARDED in the fragment shader from a
 *     per-vertex [from, to] age span, and the click test skips it too.
 *   - ECEF (x lon 0, y 90°E, z north) → scene is (x, z, −y), the site's
 *     canonical frame (js/geo/coords.js); a rotation's quaternion maps the
 *     same way, (w, x, y, z) → three's (x, z, −y, w).
 *   - Built-in materials (Lambert / LineBasic) with a two-line
 *     onBeforeCompile for the age discard; colours are sRGB picks decoded to
 *     linear before they go into a vertex colour.
 *   - camera.up stays +Y and OrbitControls is built ONCE; the page renders on
 *     demand (controls 'change', an age change, a resize), never in a loop.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as M from './page-model.js';

const DEG = Math.PI / 180;
export const SUBDIV_DEG = 2.5;
const R_SEA = 1.0, R_CONT = 1.0015, R_COAST = 1.003, R_TRACK = 1.005, R_GRID = 1.0008;
const COL = { void: '#1b1f2b', unknown: '#3a4256', cont: '#c9b48a', coast: '#f2e6c8', grid: '#9fb3d9', track: '#ffd166' };

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hexToLinear = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };   // THREE.Color(hex) decodes sRGB → linear
export const ecefToScene = (v) => [v[0], v[2], -v[1]];
export const sceneToEcef = (v) => [v[0], -v[2], v[1]];
const llToScene = (lat, lon, r) => {
    const la = lat * DEG, lo = lon * DEG;
    return [r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo)];
};

/** Triangulate one lon/lat polygon (rings[0] outer, the rest holes) and subdivide in lon/lat. */
export function triangulate(rings, maxDeg = SUBDIV_DEG) {
    const clean = (r) => {
        const out = r.map(([x, y]) => new THREE.Vector2(x, y));
        if (out.length > 1 && out[0].equals(out[out.length - 1])) out.pop();
        return out;
    };
    const contour = clean(rings[0]), holes = rings.slice(1).map(clean);
    if (contour.length < 3) return [];
    const all = contour.concat(...holes);
    const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
    const out = [];
    const split = (a, b, c, depth) => {
        const d = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);
        const ab = d(a, b), bc = d(b, c), ca = d(c, a), m = Math.max(ab, bc, ca);
        if (m <= maxDeg || depth > 14) { out.push(a, b, c); return; }
        const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
        if (m === ab) { const k = mid(a, b); split(a, k, c, depth + 1); split(k, b, c, depth + 1); }
        else if (m === bc) { const k = mid(b, c); split(a, b, k, depth + 1); split(a, k, c, depth + 1); }
        else { const k = mid(c, a); split(a, b, k, depth + 1); split(k, b, c, depth + 1); }
    };
    for (const [i, j, k] of tris) split([all[i].x, all[i].y], [all[j].x, all[j].y], [all[k].x, all[k].y], 0);
    return out;                                   // flat list of [lon, lat], three per triangle
}

function ageDiscard(material, uAge) {
    material.onBeforeCompile = (sh) => {
        sh.uniforms.uAge = uAge;
        sh.vertexShader = 'attribute vec2 aSpan;\nvarying vec2 vSpan;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvSpan = aSpan;');
        sh.fragmentShader = 'uniform float uAge;\nvarying vec2 vSpan;\n' + sh.fragmentShader.replace('void main() {', 'void main() {\n\tif (uAge > vSpan.x + 1e-4 || uAge < vSpan.y - 1e-4) discard;');
    };
    material.customProgramCacheKey = () => 'deep-time-age-discard';
    return material;
}

/**
 * Mount the globe on `canvas`. `model` = js/paleo/rotations.js createModel,
 * `plates` = js/paleo/plates.js decodePlates, `coast` = the baked coastlines.
 * Returns the API the page drives.
 */
export function createGlobe(canvas, { model, plates, coast, onPick, onRender } = {}) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#03050c');
    const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
    camera.up.set(0, 1, 0);
    camera.position.set(...llToScene(15, -60, 4.3));
    const controls = new OrbitControls(camera, canvas);
    controls.enablePan = false;
    controls.minDistance = 1.5;
    controls.maxDistance = 9;
    controls.rotateSpeed = 0.55;
    scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    camera.add(key); key.position.set(-1.5, 1.2, 1); scene.add(camera);

    const uAge = { value: 0 };
    let age = 0;

    // the planet under the plates: crust the model has no present-day piece of
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(R_SEA * 0.998, 96, 64), new THREE.MeshLambertMaterial({ color: COL.void })));

    // ── plate meshes ────────────────────────────────────────────────────────
    const plateGroups = new Map();          // plate → { objects: [Object3D] }
    const group = (plate) => { if (!plateGroups.has(plate)) plateGroups.set(plate, { objects: [] }); return plateGroups.get(plate); };
    const seaColorArrays = [];              // { colors, from, attr } for the per-age seafloor colour
    const pickMeshes = [];

    function buildLayer(polys, radius, colorFn, material, layer) {
        const byPlate = new Map();
        for (const p of polys) {
            const tri = triangulate(p.rings);
            if (!tri.length) continue;
            if (!byPlate.has(p.plate)) byPlate.set(p.plate, []);
            byPlate.get(p.plate).push({ p, tri });
        }
        for (const [plate, list] of byPlate) {
            const n = list.reduce((s, x) => s + x.tri.length, 0);
            const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), span = new Float32Array(n * 2), from = new Float32Array(n);
            let k = 0;
            for (const { p, tri } of list) {
                const c = colorFn(p);
                for (const [lon, lat] of tri) {
                    pos.set(llToScene(lat, lon, radius), k * 3);
                    col.set(c, k * 3);
                    span[k * 2] = p.fromAge; span[k * 2 + 1] = p.toAge; from[k] = p.fromAge;
                    k++;
                }
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
            g.setAttribute('normal', new THREE.BufferAttribute(pos.slice(), 3));
            const colAttr = new THREE.BufferAttribute(col, 3);
            g.setAttribute('color', colAttr);
            g.setAttribute('aSpan', new THREE.BufferAttribute(span, 2));
            const mesh = new THREE.Mesh(g, material);
            mesh.userData = { plate, layer };
            scene.add(mesh);
            group(plate).objects.push(mesh);
            pickMeshes.push(mesh);
            if (layer === 'sea') seaColorArrays.push({ col, from, attr: colAttr });
        }
    }
    const seaMat = ageDiscard(new THREE.MeshLambertMaterial({ vertexColors: true }), uAge);
    const contMat = ageDiscard(new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), uAge);
    const contCol = hexToLinear(COL.cont), unknownCol = hexToLinear(COL.unknown);
    buildLayer(plates.static, R_SEA, () => [0, 0, 0], seaMat, 'sea');
    buildLayer(plates.continents, R_CONT, () => contCol, contMat, 'continent');

    // coastlines: today's, carried back (line segments per plate)
    const coastMat = ageDiscard(new THREE.LineBasicMaterial({ color: COL.coast, transparent: true, opacity: 0.75 }), uAge);
    {
        const byPlate = new Map();
        for (const [plate, fromAge, pts] of coast.lines) {
            if (!byPlate.has(plate)) byPlate.set(plate, []);
            byPlate.get(plate).push({ fromAge, pts });
        }
        for (const [plate, list] of byPlate) {
            const pos = [], span = [];
            for (const { fromAge, pts } of list) {
                for (let i = 1; i < pts.length; i++) {
                    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
                    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 1.0));
                    for (let s = 0; s < n; s++) {
                        const a = s / n, b = (s + 1) / n;
                        pos.push(...llToScene(y0 + (y1 - y0) * a, x0 + (x1 - x0) * a, R_COAST), ...llToScene(y0 + (y1 - y0) * b, x0 + (x1 - x0) * b, R_COAST));
                        span.push(fromAge, 0, fromAge, 0);
                    }
                }
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
            g.setAttribute('aSpan', new THREE.Float32BufferAttribute(span, 2));
            const line = new THREE.LineSegments(g, coastMat);
            line.userData = { plate, layer: 'coast' };
            scene.add(line);
            group(plate).objects.push(line);
        }
    }

    // graticule in the MANTLE frame (it does not move with the plates)
    {
        const pos = [];
        for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 2) pos.push(...llToScene(lat, lon, R_GRID), ...llToScene(lat, lon + 2, R_GRID));
        for (let lon = -180; lon < 180; lon += 30) for (let lat = -88; lat < 88; lat += 2) pos.push(...llToScene(lat, lon, R_GRID), ...llToScene(lat + 2, lon, R_GRID));
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        scene.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COL.grid, transparent: true, opacity: 0.28, depthWrite: false })));
    }

    // the clicked point's track
    const trackMat = new THREE.LineBasicMaterial({ color: COL.track });
    let trackLine = null;

    // ── age ────────────────────────────────────────────────────────────────
    const q3 = new THREE.Quaternion();
    const drawn = { plates: 0, hidden: 0 };
    function applyAge(a) {
        age = a; uAge.value = a;
        drawn.plates = 0; drawn.hidden = 0;
        for (const [plate, g] of plateGroups) {
            const t = model.total(plate, a);
            if (!t) { for (const o of g.objects) o.visible = false; drawn.hidden++; continue; }
            const [w, x, y, z] = t.q;
            q3.set(x, z, -y, w);
            for (const o of g.objects) { o.visible = true; o.quaternion.copy(q3); }
            drawn.plates++;
        }
        for (const s of seaColorArrays) {
            const { col, from } = s;
            let lastFrom = NaN, c = null;
            for (let i = 0; i < from.length; i++) {
                if (from[i] !== lastFrom) {
                    lastFrom = from[i];
                    c = from[i] >= M.CRUST_AGE_UNKNOWN ? unknownCol : M.crustColor(from[i] - a).map(srgbToLinear);
                }
                col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
            }
            s.attr.needsUpdate = true;
        }
        render();
    }

    function setTrack(track) {
        if (trackLine) { scene.remove(trackLine); trackLine.geometry.dispose(); trackLine = null; }
        if (!track || track.points.length < 2) { render(); return; }
        const pos = [];
        for (const p of track.points) pos.push(...llToScene(p.lat, p.lon, R_TRACK));
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        trackLine = new THREE.Line(g, trackMat);
        scene.add(trackLine);
        render();
    }

    // ── picking: pointerup within 5 px / 600 ms of its pointerdown ─────────
    const ray = new THREE.Raycaster();
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; });
    canvas.addEventListener('pointerup', (e) => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = e.timeStamp - down.t;
        down = null;
        if (moved > 5 || dt > 600) return;
        const r = canvas.getBoundingClientRect();
        const hit = pickAt((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        if (onPick) onPick(hit);
    });

    /**
     * What is under normalised device coords (x, y): the plate whose piece
     * EXISTS at the displayed age, highest plate id among coincident hits
     * (pyGPlates' order), and the hit as an ECEF unit vector at that age.
     */
    function pickAt(nx, ny) {
        ray.setFromCamera(new THREE.Vector2(nx, ny), camera);
        const hits = ray.intersectObjects(pickMeshes.filter((m) => m.visible && m.userData.layer === 'sea'), false).filter((h) => {
            const s = h.object.geometry.getAttribute('aSpan');
            return age <= s.getX(h.face.a) + 1e-4 && age >= s.getY(h.face.a) - 1e-4;
        });
        if (!hits.length) {
            const g = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), R_SEA), new THREE.Vector3());
            return g ? { plate: null, unit: sceneToEcef(g.normalize().toArray()) } : null;
        }
        const near = hits.filter((h) => h.distance < hits[0].distance + 2e-3).sort((a, b) => b.object.userData.plate - a.object.userData.plate);
        const p = near[0].point.clone().normalize();
        return { plate: near[0].object.userData.plate, unit: sceneToEcef(p.toArray()) };
    }

    // ── screen positions for the DOM labels the page draws ─────────────────
    const v3 = new THREE.Vector3(), camDir = new THREE.Vector3();
    /** Screen position (CSS px) of an ECEF unit vector, or null on the far side. */
    function project(unit, radius = R_TRACK) {
        const s = ecefToScene(unit);
        v3.set(s[0] * radius, s[1] * radius, s[2] * radius);
        camDir.copy(camera.position).normalize();
        if (v3.clone().normalize().dot(camDir) < 0.08) return null;
        v3.project(camera);
        const r = canvas.getBoundingClientRect();
        return { x: (v3.x + 1) / 2 * r.width, y: (1 - v3.y) / 2 * r.height };
    }

    let coastOn = true;
    function setCoastVisible(on) { coastOn = on; coastMat.visible = on; render(); }

    /**
     * Share of the sphere covered by seafloor/plate pieces that exist at
     * `age` (flat-triangle area on the unit sphere; rotation preserves it).
     * At 0 Ma it should be ~1 (the static polygons tile today's surface).
     */
    function coveredFraction(a) {
        let A = 0;
        const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), p0 = new THREE.Vector3();
        for (const m of pickMeshes) {
            if (m.userData.layer !== 'sea') continue;
            const pos = m.geometry.getAttribute('position'), sp = m.geometry.getAttribute('aSpan');
            for (let i = 0; i < pos.count; i += 3) {
                if (a > sp.getX(i) + 1e-4 || a < sp.getY(i) - 1e-4) continue;
                p0.fromBufferAttribute(pos, i);
                e1.fromBufferAttribute(pos, i + 1).sub(p0); e2.fromBufferAttribute(pos, i + 2).sub(p0);
                A += e1.cross(e2).length() / 2;
            }
        }
        return A / (4 * Math.PI);
    }
    /** Render now and read one drawing-buffer pixel (CSS-px coords) — for the browser gate. */
    function readPixel(cssX, cssY) {
        renderer.render(scene, camera);
        const gl = renderer.getContext(), dpr = renderer.getPixelRatio(), buf = new Uint8Array(4);
        gl.readPixels(Math.round(cssX * dpr), Math.round(gl.drawingBufferHeight - cssY * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return [...buf];
    }

    function resize() {
        const r = canvas.getBoundingClientRect();
        renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
        camera.aspect = r.width / Math.max(1, r.height);
        camera.updateProjectionMatrix();
        // the globe fits the NARROWER dimension (a phone is portrait); the
        // distance is set only while the user has not zoomed
        if (!userZoomed) {
            const half = Math.min(camera.fov / 2 * DEG, Math.atan(Math.tan(camera.fov / 2 * DEG) * camera.aspect));
            camera.position.setLength(Math.min(controls.maxDistance, 1.12 / Math.sin(half)));
            controls.update();
        }
        render();
    }
    let pending = false;
    function render() {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            renderer.render(scene, camera);
            if (onRender) onRender();
        });
    }
    let userZoomed = false;
    canvas.addEventListener('wheel', () => { userZoomed = true; }, { passive: true });
    canvas.addEventListener('pointerdown', (e) => { if (!e.isPrimary) userZoomed = true; });
    controls.addEventListener('change', render);
    new ResizeObserver(resize).observe(canvas);

    /** Turn the camera to look at a lat/lon in the mantle frame (one jump, never held). */
    function lookAt(lat, lon) {
        const d = camera.position.length();
        camera.position.set(...llToScene(lat, lon, d));
        controls.update();
        render();
    }

    resize();
    applyAge(0);
    return {
        setAge: applyAge, get age() { return age; }, coveredFraction, readPixel, setTrack, setCoastVisible, get coastOn() { return coastOn; }, project, pickAt, lookAt, render,
        drawn, renderer, camera, controls,
        stats: { plates: plateGroups.size, meshes: pickMeshes.length, triangles: pickMeshes.reduce((s, m) => s + m.geometry.getAttribute('position').count / 3, 0) },
    };
}
