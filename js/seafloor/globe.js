/**
 * globe.js — the whole planet's sea floor as a 3D relief globe (sea-floor.html, first view).
 * A RENDERER: relief and colour come from the page model (`worldTexture`, the ONE depth ramp) and
 * the world grid; it computes no physics.
 *
 * FRAME: the site's canonical geo frame (js/geo/coords.js) — +X Greenwich, +Y north, −Z = 90° E —
 * `dirOf` / `latLonOf` in bathy.js, pinned by the node gate. The sphere is built from explicit (lat, lon) vertices with their own UVs, so there is no
 * three.js sphere-UV convention to get wrong (the EarthView antipode scar).
 *
 * THE ONE DISHONEST NUMBER is the relief exaggeration: at true scale the deepest trench is 0.17 %
 * of Earth's radius and the globe is a smooth ball. It is printed on the stage and adjustable to 1×.
 * The WATER is a translucent shell at sea level that can be switched off ("drain the ocean").
 *
 * PICKING is analytic (ray ∩ unit sphere → lat/lon), never a mesh raycast; site markers are picked
 * in PIXELS first. A tap is a pointerup within 6 px / 600 ms of its pointerdown on event.timeStamp.
 * `camera.up` stays +Y and OrbitControls is built ONCE; flights are one-shot and any input cancels them.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { worldElevationAt, R_EARTH_KM, dirOf, latLonOf } from './bathy.js';
import { KIND_STYLE } from './page-model.js';

const D2R = Math.PI / 180;
const SEG_LON = 480, SEG_LAT = 240;
const SITE_PICK_PX = 16;


export function createGlobe(host, { onPickPoint = null, onPickSite = null, onHover = null, onDive = null } = {}) {
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); } catch (e) { return null; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x03060d, 1);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.01, 50);
    camera.up.set(0, 1, 0);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = 0.12;
    controls.minDistance = 1.22; controls.maxDistance = 14;

    let world = null, exag = 30, terrain = null, texture = null, dirty = true, visible = true, raf = 0, flight = null;
    const water = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 64), new THREE.MeshBasicMaterial({ color: 0x2f7fd0, transparent: true, opacity: 0.30, depthWrite: false }));
    water.renderOrder = 2; scene.add(water);
    const markers = new THREE.Group(); markers.renderOrder = 3; scene.add(markers);
    let sites = [], selectedId = null, pin = null;
    const state = { exaggeration: exag, vertices: 0, frames: 0, water: true, sites: 0, flying: false };

    function buildTerrain() {
        const nV = (SEG_LON + 1) * (SEG_LAT + 1);
        const pos = new Float32Array(nV * 3), uv = new Float32Array(nV * 2);
        let k = 0;
        for (let j = 0; j <= SEG_LAT; j++) {
            const lat = 90 - 180 * j / SEG_LAT;
            for (let i = 0; i <= SEG_LON; i++, k++) {
                const lon = -180 + 360 * i / SEG_LON, d = dirOf(lat, lon);
                const r = 1 + worldElevationAt(world, lat, lon) / 1000 * exag / R_EARTH_KM;
                pos[k * 3] = d[0] * r; pos[k * 3 + 1] = d[1] * r; pos[k * 3 + 2] = d[2] * r;
                uv[k * 2] = i / SEG_LON; uv[k * 2 + 1] = j / SEG_LAT;          // DataTexture row 0 = north, flipY off
            }
        }
        if (terrain) { terrain.geometry.getAttribute('position').array.set(pos); terrain.geometry.getAttribute('position').needsUpdate = true; terrain.geometry.computeBoundingSphere(); return; }
        const idx = new Uint32Array(SEG_LON * SEG_LAT * 6); let q = 0;
        for (let j = 0; j < SEG_LAT; j++) for (let i = 0; i < SEG_LON; i++) {
            const a = j * (SEG_LON + 1) + i, b = a + 1, c = a + SEG_LON + 1, d = c + 1;
            idx[q++] = a; idx[q++] = c; idx[q++] = b; idx[q++] = b; idx[q++] = c; idx[q++] = d;
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        g.setIndex(new THREE.BufferAttribute(idx, 1)); g.computeBoundingSphere();
        terrain = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: texture }));
        terrain.renderOrder = 1; scene.add(terrain);
        state.vertices = nV;
    }

    function markerTexture(kind, selected) {
        const st = KIND_STYLE[kind], c = document.createElement('canvas'); c.width = c.height = 64;
        const g = c.getContext('2d'), r = selected ? 20 : 15;
        g.translate(32, 32); g.beginPath();
        if (st.shape === 'circle') g.arc(0, 0, r, 0, 6.2832);
        else if (st.shape === 'square') g.rect(-r * 0.9, -r * 0.9, r * 1.8, r * 1.8);
        else if (st.shape === 'triangle') { g.moveTo(0, -r * 1.15); g.lineTo(r, r * 0.85); g.lineTo(-r, r * 0.85); g.closePath(); }
        else { g.moveTo(0, -r * 1.2); g.lineTo(r * 1.2, 0); g.lineTo(0, r * 1.2); g.lineTo(-r * 1.2, 0); g.closePath(); }
        g.fillStyle = st.color; g.fill(); g.lineWidth = selected ? 6 : 4; g.strokeStyle = selected ? '#ffffff' : '#0b1120'; g.stroke();
        const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    }
    function buildMarkers() {
        while (markers.children.length) { const o = markers.children.pop(); o.material.map && o.material.map.dispose(); o.material.dispose(); }
        for (const s of sites) {
            const sel = s.id === selectedId;
            const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: markerTexture(s.kind, sel), sizeAttenuation: false, depthTest: true, depthWrite: false, transparent: true }));
            const d = dirOf(s.lat, s.lon); sp.position.set(d[0] * 1.004, d[1] * 1.004, d[2] * 1.004);
            sp.scale.setScalar(sel ? 0.052 : 0.04); sp.userData.id = s.id; markers.add(sp);
        }
        if (pin) {
            const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
            g.strokeStyle = '#9fe8ff'; g.lineWidth = 5; g.beginPath(); g.arc(32, 32, 18, 0, 6.2832); g.stroke(); g.fillStyle = '#9fe8ff'; g.beginPath(); g.arc(32, 32, 6, 0, 6.2832); g.fill();
            const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
            const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, sizeAttenuation: false, depthTest: true, depthWrite: false, transparent: true }));
            const d = dirOf(pin.lat, pin.lon); sp.position.set(d[0] * 1.005, d[1] * 1.005, d[2] * 1.005); sp.scale.setScalar(0.05); markers.add(sp);
        }
        state.sites = sites.length; dirty = true;
    }

    function resize() { const w = host.clientWidth || 600, h = host.clientHeight || 400; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true; }
    const ro = new ResizeObserver(resize); ro.observe(host);
    const io = new IntersectionObserver((es) => { visible = es[0].isIntersecting; if (visible) dirty = true; }); io.observe(host);
    controls.addEventListener('change', () => { dirty = true; });
    controls.addEventListener('start', () => { if (flight) { const f = flight; flight = null; state.flying = false; f.done(false); } });

    // ── picking ──
    const ray = new THREE.Raycaster();
    function pointAt(clientX, clientY) {
        const r = renderer.domElement.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2((clientX - r.left) / r.width * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
        const o = ray.ray.origin, d = ray.ray.direction, b = o.dot(d), c = o.lengthSq() - 1, disc = b * b - c;
        if (disc < 0) return null;
        const t = -b - Math.sqrt(disc); if (t < 0) return null;
        return latLonOf(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
    }
    function screenOf(lat, lon) {
        const d = dirOf(lat, lon), v = new THREE.Vector3(d[0], d[1], d[2]);
        const facing = v.dot(camera.position) > 1;                       // on the near side of the horizon
        v.project(camera); const r = renderer.domElement.getBoundingClientRect();
        return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height, facing };
    }
    function siteAt(clientX, clientY) {
        let best = null, bd = SITE_PICK_PX;
        for (const s of sites) { const p = screenOf(s.lat, s.lon); if (!p.facing) continue; const dd = Math.hypot(p.x - clientX, p.y - clientY); if (dd < bd) { bd = dd; best = s; } }
        return best;
    }
    let down = null, lastTap = null;
    const el = renderer.domElement;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: e.timeStamp }; });
    el.addEventListener('pointerup', (e) => {
        if (!down || !world) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = e.timeStamp - down.t; down = null;
        if (moved > 6 || dt > 600) return;
        const s = siteAt(e.clientX, e.clientY);
        const double = lastTap && e.timeStamp - lastTap.t < 500 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 24;
        lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
        if (s) { onPickSite && onPickSite(s.id, { double }); return; }
        const p = pointAt(e.clientX, e.clientY); if (!p) return;
        if (double) onDive && onDive(p); else onPickPoint && onPickPoint(p);
    });
    let hoverT = 0;
    el.addEventListener('pointermove', (e) => {
        if (!onHover || !world || e.timeStamp - hoverT < 60) return; hoverT = e.timeStamp;
        const s = siteAt(e.clientX, e.clientY), p = s ? null : pointAt(e.clientX, e.clientY);
        el.style.cursor = s ? 'pointer' : (p ? 'crosshair' : 'grab');
        onHover(s ? { site: s.id } : (p ? { point: p, elevation: worldElevationAt(world, p.lat, p.lon) } : null), e);
    });
    el.addEventListener('pointerleave', (e) => onHover && onHover(null, e));

    function tick(now) {
        raf = requestAnimationFrame(tick);
        if (!visible) return;
        if (flight) {
            const u = Math.min(1, (now - flight.start) / flight.ms), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
            const dir = new THREE.Vector3().copy(flight.d0).applyQuaternion(new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), flight.q, e));
            camera.position.copy(dir.multiplyScalar(Math.exp(Math.log(flight.r0) + (Math.log(flight.r1) - Math.log(flight.r0)) * e)));
            camera.lookAt(0, 0, 0); dirty = true;
            if (u >= 1) { const f = flight; flight = null; state.flying = false; f.done(true); }
        }
        // rotate more slowly up close, so a drag moves the ground about as far as the pointer
        controls.rotateSpeed = Math.max(0.08, Math.min(1, (camera.position.length() - 1) / 1.6));
        if (controls.update()) dirty = true;
        if (!dirty) return;
        dirty = false; state.frames++;
        renderer.render(scene, camera);
    }
    resize();
    // the whole disc must fit the NARROWER side of the canvas (a phone in portrait)
    const home = 3.3 / Math.min(1, camera.aspect * 0.92);
    camera.position.set(...dirOf(12, 150).map((v) => v * home));
    controls.update();
    raf = requestAnimationFrame(tick);

    return {
        state,
        setWorld(w, rgba) {
            world = w;
            texture = new THREE.DataTexture(rgba, w.nx, w.ny, THREE.RGBAFormat);
            texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = THREE.RepeatWrapping; texture.magFilter = THREE.LinearFilter;
            texture.minFilter = THREE.LinearMipmapLinearFilter; texture.generateMipmaps = true; texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); texture.needsUpdate = true;
            buildTerrain(); dirty = true;
        },
        setSites(rows) { sites = rows || []; buildMarkers(); },
        setSelected(id, point = null) { selectedId = id; pin = point; buildMarkers(); },
        setExaggeration(x) { exag = x; state.exaggeration = x; if (world) buildTerrain(); dirty = true; },
        setWater(on) { water.visible = !!on; state.water = !!on; dirty = true; },
        /** One-shot flight of the camera to stand over (lat, lon) at `distance` Earth radii from the centre. */
        flyTo(lat, lon, distance = null, ms = 1400) {
            return new Promise((done) => {
                if (flight) flight.done(false);
                const d0 = camera.position.clone().normalize(), t = dirOf(lat, lon), d1 = new THREE.Vector3(t[0], t[1], t[2]);
                flight = { d0, q: new THREE.Quaternion().setFromUnitVectors(d0, d1), r0: camera.position.length(), r1: distance || camera.position.length(), start: performance.now(), ms, done };
                state.flying = true; dirty = true;
            });
        },
        pointAt, screenOf,
        cameraOver() { return latLonOf(camera.position.x, camera.position.y, camera.position.z); },
        dispose() { cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); controls.dispose(); renderer.dispose(); },
    };
}
