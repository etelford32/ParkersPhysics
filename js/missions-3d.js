/**
 * missions-3d.js — Real-time 3D map of the missions roster.
 *
 * Every spacecraft is drawn from the BEST position the page can get, and
 * says which:
 *
 *   horizons   JPL Horizons state vectors through /api/missions/ephemeris
 *              (26 h window, hourly, Hermite-interpolated to the frame's JD;
 *              js/mission-ephemeris.js is the shared kernel)
 *   sgp4       CelesTrak elements through /api/celestrak/tle, propagated by
 *              the shared tracker's `propagate` (Rust SGP4 when loaded, the
 *              JS fallback until then — same propagator every other page
 *              draws with)
 *   model      the analytic placement in js/mission-positions.js — Kepler
 *              elements from published mission profiles, L1/L2 geometry,
 *              date-interpolated cruises. The disclosed fallback.
 *
 * Nothing here computes physics; it reads the kernels and draws.
 *
 * Coordinate system (three.js scene units): 1 unit = 1 AU, heliocentric
 * ecliptic, +Y = ecliptic normal. (x_AU, y_AU, z_AU) → (x_AU, z_AU, −y_AU).
 * Planets come from js/horizons.js (Meeus, of date). The Earth/Mars/Jupiter/
 * Moon NEIGHBOURHOODS are drawn log-compressed (`localSceneDistance` —
 * surface → L1/L2 is 1 → 5 drawn radii), which is the one dishonesty of the
 * map and is printed in the legend; see the kernel header for why the old
 * honest placement drew every L1 sentinel INSIDE the Earth sphere.
 *
 * Markers are sprites scaled per frame to a constant PIXEL size, so Voyager
 * at 168 AU and the ISS at 1.05 drawn Earth radii are both a dot you can
 * click. Planet meshes keep their world size (they are the scale reference).
 *
 * Test hook: `window.__missionsViewer` (items/provenance/setLive/focus).
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    jdNow, mercuryHeliocentric, venusHeliocentric, earthHeliocentric,
    marsHeliocentric, jupiterHeliocentric, saturnHeliocentric,
    uranusHeliocentric, neptuneHeliocentric, moonGeocentric,
} from './horizons.js';
import {
    DRAW_RADIUS_AU, MISSION_LOCS, KM_PER_AU, LAGRANGE_KM, HOST_RADIUS_KM,
    computeMissionPos, resolveLoc, liveToDrawn, temeToDrawn, locationLabel, localSceneDistance,
} from './mission-positions.js';
import {
    interpolateState, planBatches, distanceAU, lightTimeMinutes, speedKms, provenanceSummary,
} from './mission-ephemeris.js';
import { propagate, tleEpochToJd } from './satellite-tracker.js';

// ── Constants ────────────────────────────────────────────────────────────────
const PLANET_VIS = {
    sun:     { color: 0xffaa33, radius: DRAW_RADIUS_AU.sun, emissive: true },
    mercury: { color: 0xaa9988, radius: DRAW_RADIUS_AU.mercury },
    venus:   { color: 0xe7c987, radius: DRAW_RADIUS_AU.venus },
    earth:   { color: 0x4f8fe0, radius: DRAW_RADIUS_AU.earth },
    moon:    { color: 0xbfbfc8, radius: DRAW_RADIUS_AU.moon },
    mars:    { color: 0xc0552d, radius: DRAW_RADIUS_AU.mars },
    jupiter: { color: 0xc6a382, radius: DRAW_RADIUS_AU.jupiter },
    saturn:  { color: 0xdcc89a, radius: DRAW_RADIUS_AU.saturn },
    uranus:  { color: 0x9bdcdc, radius: DRAW_RADIUS_AU.uranus },
    neptune: { color: 0x4566c4, radius: DRAW_RADIUS_AU.neptune },
};
const RING_AU = { mercury: 0.387, venus: 0.723, earth: 1.000, mars: 1.524, jupiter: 5.20, saturn: 9.55, uranus: 19.22, neptune: 30.11 };

const STATUS_COLOR = {
    operational: 0x4fc97f, extended: 0x4fc3f7, cruising: 0xffb830,
    completed: 0xaaaaaa, retired: 0x666666, planned: 0xcc7799,
};
const STATUS_HEX = Object.fromEntries(Object.entries(STATUS_COLOR).map(([k, v]) => [k, '#' + v.toString(16).padStart(6, '0')]));

const MARKER_PX = 11;          // constant on-screen marker diameter (CSS px)
const HALO_PX   = 26;
const CAMERA_FAR = 5000;
const EPHEMERIS_BATCH = 12;
const TLE_FETCH_TIMEOUT_MS = 12000;

// ── Position helpers ─────────────────────────────────────────────────────────
function snapshotPlanets(jd) {
    const p = {
        mercury: mercuryHeliocentric(jd), venus: venusHeliocentric(jd), earth: earthHeliocentric(jd),
        mars: marsHeliocentric(jd), jupiter: jupiterHeliocentric(jd), saturn: saturnHeliocentric(jd),
        uranus: uranusHeliocentric(jd), neptune: neptuneHeliocentric(jd),
    };
    // The Moon: real geocentric direction (Meeus), compressed distance.
    const m = moonGeocentric(jd);
    const d = localSceneDistance(m.dist_km, 'earth');
    p.moon = {
        x_AU: p.earth.x_AU + d * Math.cos(m.lat_rad) * Math.cos(m.lon_rad),
        y_AU: p.earth.y_AU + d * Math.cos(m.lat_rad) * Math.sin(m.lon_rad),
        z_AU: p.earth.z_AU + d * Math.sin(m.lat_rad),
    };
    return p;
}

function helioToScene(p) { return new THREE.Vector3(p.x_AU, p.z_AU, -p.y_AU); }

// ── Three.js helpers ─────────────────────────────────────────────────────────
function makeMarkerSprite(colorHex) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const r = (colorHex >> 16) & 255, g = (colorHex >> 8) & 255, b = colorHex & 255;
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0,    `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.25, `rgba(${r},${g},${b},0.9)`);
    grad.addColorStop(0.55, `rgba(${r},${g},${b},0.35)`);
    grad.addColorStop(1,    `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
    return new THREE.Sprite(mat);
}

function makeStarfield(count = 4000, rMin = 1200, rMax = 2400) {
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const r  = rMin + Math.random() * (rMax - rMin);
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        pos[i*3]   = r * Math.sin(ph) * Math.cos(th);
        pos[i*3+1] = r * Math.sin(ph) * Math.sin(th);
        pos[i*3+2] = r * Math.cos(ph);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false }));
}

function makeOrbitRing(radiusAU, color = 0x335577, segments = 256) {
    const pts = [];
    for (let i = 0; i <= segments; i++) {
        const t = (i / segments) * Math.PI * 2;
        pts.push(new THREE.Vector3(radiusAU * Math.cos(t), 0, radiusAU * Math.sin(t)));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.35 }));
}

function makeLabel(text, px = 28, color = 'rgba(220,220,255,0.85)') {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.font = `bold ${px}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false });
    const sp = new THREE.Sprite(mat);
    sp.userData.aspect = 4;
    return sp;
}

function cap(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

// ── Public API ───────────────────────────────────────────────────────────────

export function initMissionsViewer({ container, missions, onSelect, onLive, fetchLive = true }) {
    if (!container) throw new Error('initMissionsViewer: container required');

    // ── Renderer ────────────────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setClearColor(0x040210, 1);
    container.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%' });

    // ── Scene + camera ──────────────────────────────────────────────────────
    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 0.001, CAMERA_FAR);
    const HOME_CAM = new THREE.Vector3(0, 3.0, 3.5);
    camera.position.copy(HOME_CAM);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping  = true;
    controls.dampingFactor  = 0.08;
    controls.minDistance    = 0.03;
    controls.maxDistance    = 600;
    controls.zoomSpeed      = 1.2;
    controls.panSpeed       = 0.8;
    controls.rotateSpeed    = 0.7;
    controls.screenSpacePanning = true;

    const sunLight = new THREE.PointLight(0xffeecc, 3.5, 0, 1.5);
    scene.add(sunLight);
    scene.add(new THREE.AmbientLight(0x404060, 0.55));
    scene.add(makeStarfield());

    // ── Sun ─────────────────────────────────────────────────────────────────
    const sun = new THREE.Mesh(new THREE.SphereGeometry(PLANET_VIS.sun.radius, 48, 32), new THREE.MeshBasicMaterial({ color: PLANET_VIS.sun.color }));
    scene.add(sun);
    scene.add(new THREE.Mesh(
        new THREE.SphereGeometry(PLANET_VIS.sun.radius * 2.6, 32, 24),
        new THREE.MeshBasicMaterial({ color: 0xffaa44, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false }),
    ));

    // ── Planets + orbit rings ───────────────────────────────────────────────
    const planetMeshes = {}, planetLabels = {};
    for (const [name, vis] of Object.entries(PLANET_VIS)) {
        if (name === 'sun') continue;
        const mesh = new THREE.Mesh(
            new THREE.SphereGeometry(vis.radius, 32, 24),
            new THREE.MeshStandardMaterial({ color: vis.color, roughness: 0.85, metalness: 0.05 }),
        );
        mesh.userData = { kind: 'planet', name };
        scene.add(mesh);
        planetMeshes[name] = mesh;
        if (RING_AU[name]) scene.add(makeOrbitRing(RING_AU[name]));
        const label = makeLabel(cap(name), name === 'moon' ? 22 : 28);
        scene.add(label);
        planetLabels[name] = label;
    }

    // ── Mission markers ─────────────────────────────────────────────────────
    const missionGroup = new THREE.Group();
    scene.add(missionGroup);
    const missionItems = [];
    const missionById  = new Map();
    for (const mission of missions) {
        const loc = MISSION_LOCS[mission.id];
        if (!loc) continue;
        const color  = STATUS_COLOR[mission.status] || 0x888888;
        const sprite = makeMarkerSprite(color);
        sprite.userData = { kind: 'mission', missionId: mission.id };
        const halo = makeMarkerSprite(color);
        halo.material.opacity = 0;
        halo.userData = { kind: 'mission-halo', missionId: mission.id };
        missionGroup.add(sprite); missionGroup.add(halo);
        const item = { mission, loc, sprite, halo, source: 'model', pos: null, visible: true, telemetry: null };
        const r = resolveLoc(loc, jdNow());
        if (!r || r.type === 'lost') { item.visible = false; sprite.visible = false; halo.visible = false; }
        missionItems.push(item);
        missionById.set(mission.id, item);
    }

    // ── Live state ──────────────────────────────────────────────────────────
    const live = {
        horizons: new Map(),      // id → { samples, command, fetched_at }
        hosts:    new Map(),      // host → samples
        sgp4:     new Map(),      // id → tle record
        status:   { ephemeris: 'pending', tle: 'pending' },
    };

    function applyEphemeris(data) {
        if (!data || !Array.isArray(data.spacecraft)) return;
        for (const [host, h] of Object.entries(data.hosts || {})) {
            if (h && Array.isArray(h.samples)) live.hosts.set(host, h.samples);
        }
        for (const s of data.spacecraft) {
            if (s.ok && Array.isArray(s.samples)) {
                live.horizons.set(s.id, { samples: s.samples, command: s.command_used, fetched_at: data.fetched_at });
            }
        }
    }
    function applyTle(id, tle) { if (tle) live.sgp4.set(id, tle); }

    async function fetchJson(url, timeoutMs) {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async function loadEphemeris() {
        const batches = planBatches(missions, EPHEMERIS_BATCH);
        const settled = await Promise.allSettled(batches.map(b =>
            fetchJson(`/api/missions/ephemeris?ids=${encodeURIComponent(b.ids.join(','))}&hosts=${b.hosts.join(',')}`, 25000)));
        let anyLive = false;
        for (const r of settled) {
            if (r.status !== 'fulfilled') continue;
            applyEphemeris(r.value);
            if (r.value.freshness === 'live') anyLive = true;
        }
        live.status.ephemeris = anyLive ? 'live' : settled.some(r => r.status === 'fulfilled') ? 'stale' : 'down';
    }

    async function loadTles() {
        const wants = missions.filter(m => m.norad || m.norad_search);
        const settled = await Promise.allSettled(wants.map(async m => {
            const q = m.norad ? `norad=${m.norad}` : `search=${encodeURIComponent(m.norad_search)}`;
            const data = await fetchJson(`/api/celestrak/tle?${q}`, TLE_FETCH_TIMEOUT_MS);
            const rec = Array.isArray(data.satellites) ? data.satellites[0] : null;
            if (!rec) throw new Error('no record');
            return { id: m.id, rec };
        }));
        let okN = 0;
        for (const r of settled) if (r.status === 'fulfilled') { applyTle(r.value.id, r.value.rec); okN++; }
        live.status.tle = okN ? 'live' : wants.length ? 'down' : 'none';
    }

    function announceLive() {
        // Re-source every marker NOW: the tick that would do it is a frame
        // away (or paused off-screen), and a chip summarised before it ran
        // read "57 model" with Horizons already in hand.
        const jd = jdNow();
        const planets = snapshotPlanets(jd);
        for (const item of missionItems) updateItem(item, jd, planets);
        const prov = provenance();
        hud.prov.textContent = provText(prov);
        if (typeof onLive === 'function') onLive(prov);
    }

    if (fetchLive) {
        Promise.allSettled([loadEphemeris(), loadTles()]).then(announceLive);
    }

    // ── HUD ─────────────────────────────────────────────────────────────────
    const hud = buildHUD(container);
    const flyPreset = (cam, target = new THREE.Vector3(0, 0, 0)) => () => { followSelected = false; hud.btnFollow.classList.remove('mn3-on'); flyTo(cam, target); };
    hud.btnTop.onclick    = flyPreset(new THREE.Vector3(0, 6, 0.001));
    hud.btnEdge.onclick   = flyPreset(new THREE.Vector3(6, 0.4, 0));
    hud.btnInner.onclick  = flyPreset(new THREE.Vector3(0, 2.2, 2.4));
    hud.btnOuter.onclick  = flyPreset(new THREE.Vector3(0, 40, 36));
    hud.btnFar.onclick    = flyPreset(new THREE.Vector3(60, 260, 220));
    hud.btnEarth.onclick  = () => { const e = planetMeshes.earth.position.clone(); followSelected = false; flyTo(e.clone().add(new THREE.Vector3(0.12, 0.16, 0.18)), e); };
    hud.btnReset.onclick  = () => { selected = null; followSelected = false; hud.btnFollow.classList.remove('mn3-on'); flyTo(HOME_CAM.clone(), new THREE.Vector3(0, 0, 0)); updateHUD(); };
    hud.btnFollow.onclick = () => { followSelected = !followSelected; hud.btnFollow.classList.toggle('mn3-on', followSelected); };

    // ── Picking ─────────────────────────────────────────────────────────────
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let hovered = null, selected = null, followSelected = false;

    function pickAt(clientX, clientY) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((clientX - rect.left) / rect.width)  *  2 - 1;
        pointer.y = ((clientY - rect.top)  / rect.height) * -2 + 1;
        raycaster.setFromCamera(pointer, camera);
        const hits = raycaster.intersectObjects(missionGroup.children, false);
        for (const h of hits) {
            const id = h.object.userData?.missionId;
            if (id && h.object.userData.kind === 'mission' && h.object.visible && missionById.has(id)) return missionById.get(id);
        }
        return null;
    }

    renderer.domElement.addEventListener('pointermove', ev => {
        const item = pickAt(ev.clientX, ev.clientY);
        if (item !== hovered) {
            if (hovered && hovered !== selected) hovered.halo.material.opacity = 0;
            hovered = item;
            if (hovered) hovered.halo.material.opacity = 0.35;
            renderer.domElement.style.cursor = hovered ? 'pointer' : 'grab';
            hud.tip.textContent = hovered ? `${hovered.mission.name} · ${sourceLabel(hovered)}` : '';
            hud.tip.style.display = hovered ? 'block' : 'none';
        }
        if (hovered) {
            const rect = container.getBoundingClientRect();
            hud.tip.style.left = `${ev.clientX - rect.left + 14}px`;
            hud.tip.style.top  = `${ev.clientY - rect.top + 10}px`;
        }
    });

    let pressAt = null;
    renderer.domElement.addEventListener('pointerdown', ev => { if (ev.button === 0) pressAt = { x: ev.clientX, y: ev.clientY, t: ev.timeStamp }; });
    renderer.domElement.addEventListener('pointerup', ev => {
        if (ev.button !== 0 || !pressAt) return;
        const moved = Math.hypot(ev.clientX - pressAt.x, ev.clientY - pressAt.y);
        const dt = ev.timeStamp - pressAt.t;
        pressAt = null;
        if (moved > 6 || dt > 700) return;          // a drag belongs to the camera
        const item = pickAt(ev.clientX, ev.clientY);
        if (!item) return;
        selectItem(item);
        if (typeof onSelect === 'function') onSelect(item.mission.id);
    });

    function selectItem(item) {
        selected = item;
        updateHUD();
        const worldPos = item.sprite.position.clone();
        const dist = Math.max(0.06, Math.min(0.6, camera.position.distanceTo(controls.target) * 0.25));
        const offset = camera.position.clone().sub(controls.target).normalize().multiplyScalar(dist);
        flyTo(worldPos.clone().add(offset), worldPos);
    }

    // ── Camera fly-to ───────────────────────────────────────────────────────
    let flyState = null;
    function flyTo(camTo, targetTo, duration = 800) {
        flyState = { camFrom: camera.position.clone(), camTo: camTo.clone(), tgtFrom: controls.target.clone(), tgtTo: targetTo.clone(), t0: performance.now(), duration };
    }
    controls.addEventListener('start', () => { flyState = null; });

    // ── Resize ──────────────────────────────────────────────────────────────
    function resize() {
        const w = container.clientWidth || 800, h = container.clientHeight || 520;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // ── Per-frame position of one mission ───────────────────────────────────
    const _tmp = new THREE.Vector3();
    function updateItem(item, jd, planets) {
        const loc = resolveLoc(item.loc, jd);
        if (!loc || loc.type === 'lost') { item.visible = false; item.sprite.visible = item.halo.visible = false; return; }
        let pos = null, source = 'model', tel = null;

        const H = live.horizons.get(item.mission.id);
        if (H) {
            const st = interpolateState(H.samples, jd);
            if (st) {
                const host = loc.host;
                const hostS = host ? live.hosts.get(host) : null;
                const hostSt = hostS ? interpolateState(hostS, jd) : null;
                const needsHost = host && (loc.type === 'lagrange' || loc.type === 'local' || loc.type === 'surface');
                if (!needsHost || (hostSt && planets[host])) {
                    const d = liveToDrawn(loc, jd, st, hostSt, planets[host]);
                    pos = d; source = 'horizons';
                    const rSun = Math.hypot(st.x_AU, st.y_AU, st.z_AU);
                    const earthSt = live.hosts.get('earth') ? interpolateState(live.hosts.get('earth'), jd) : null;
                    const rEarth = earthSt ? distanceAU(st, earthSt) : distanceAU(st, planets.earth);
                    tel = { r_sun_au: rSun, r_earth_au: rEarth, light_min: lightTimeMinutes(rEarth), speed_kms: speedKms(st),
                            r_host_km: d.r_host_km, command: H.command, fetched_at: H.fetched_at, mode: st.mode };
                }
            }
        }
        if (!pos) {
            const tle = live.sgp4.get(item.mission.id);
            if (tle) {
                const tsince = (jd - tleEpochToJd(tle)) * 1440;
                const p = propagate(tle, tsince);
                if (p && Number.isFinite(p.x)) {
                    const d = temeToDrawn(p, planets.earth);
                    pos = d; source = 'sgp4';
                    const rEarth = d.r_host_km / KM_PER_AU;
                    tel = { r_sun_au: Math.hypot(planets.earth.x_AU, planets.earth.y_AU, planets.earth.z_AU), r_earth_au: rEarth,
                            light_min: lightTimeMinutes(rEarth), alt_km: d.r_host_km - HOST_RADIUS_KM.earth, r_host_km: d.r_host_km,
                            epoch_age_h: (jd - tleEpochToJd(tle)) * 24, norad: tle.norad_id, mode: 'propagated' };
                }
            }
        }
        if (!pos) {
            pos = computeMissionPos(item.mission, item.loc, jd, planets);
            source = 'model';
            if (pos) {
                const rSun = Math.hypot(pos.x_AU, pos.y_AU, pos.z_AU);
                tel = { r_sun_au: rSun, r_earth_au: distanceAU(pos, planets.earth), mode: 'model' };
                tel.light_min = lightTimeMinutes(tel.r_earth_au);
            }
        }
        if (!pos) { item.visible = false; item.sprite.visible = item.halo.visible = false; return; }
        item.visible = true; item.sprite.visible = item.halo.visible = true;
        item.pos = pos; item.source = source; item.telemetry = tel;
        const v = helioToScene(pos);
        item.sprite.position.copy(v);
        item.halo.position.copy(v);
    }

    // Constant on-screen size: world size = px × (distance × 2·tan(fov/2) / viewportHeight).
    function pixelScale(worldPos, px) {
        const dist = camera.position.distanceTo(worldPos);
        const h = renderer.domElement.clientHeight || 520;
        return px * dist * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / h;
    }

    // ── Tick ────────────────────────────────────────────────────────────────
    let frameNo = 0, lastJD = jdNow(), rafId = 0;
    let paused = false;
    function tick() {
        rafId = requestAnimationFrame(tick);
        frameNo++;
        if (paused) return;

        const jd = jdNow();
        lastJD = jd;
        const planets = snapshotPlanets(jd);

        for (const [name, mesh] of Object.entries(planetMeshes)) {
            mesh.position.copy(helioToScene(planets[name]));
            const lbl = planetLabels[name];
            const s = pixelScale(mesh.position, 64);
            lbl.scale.set(s, s / 4, 1);
            lbl.position.copy(mesh.position).add(_tmp.set(0, PLANET_VIS[name].radius * 1.4 + s * 0.2, 0));
            // labels of the inner planets fade out when the camera is far
            const camDist = camera.position.length();
            lbl.material.opacity = (name === 'moon' && camDist > 1.2) ? 0 : (camDist > 80 && RING_AU[name] && RING_AU[name] < 2) ? 0 : 0.85;
        }

        for (const item of missionItems) {
            updateItem(item, jd, planets);
            if (!item.visible) continue;
            const s = pixelScale(item.sprite.position, MARKER_PX);
            item.sprite.scale.set(s, s, 1);
            const hs = pixelScale(item.halo.position, HALO_PX);
            item.halo.scale.set(hs, hs, 1);
        }

        if (flyState) {
            const t = Math.min(1, (performance.now() - flyState.t0) / flyState.duration);
            const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            camera.position.lerpVectors(flyState.camFrom, flyState.camTo, e);
            controls.target.lerpVectors(flyState.tgtFrom, flyState.tgtTo, e);
            if (t >= 1) flyState = null;
        }
        if (followSelected && selected && !flyState) {
            // translate rig and target by the same vector (no easing: a 7 km/s target leaves an eased camera behind)
            const delta = selected.sprite.position.clone().sub(controls.target);
            controls.target.add(delta);
            camera.position.add(delta);
        }
        if (selected) selected.halo.material.opacity = 0.55 + 0.25 * Math.sin(performance.now() / 300);

        sun.rotation.y += 0.0015;
        controls.update();
        renderer.render(scene, camera);

        if (frameNo % 60 === 0) { updateClock(jd); if (selected) updateTelemetry(); }
    }
    tick();

    // Pause GL when scrolled off screen (the Stage/TIGA rule).
    if (typeof IntersectionObserver === 'function') {
        new IntersectionObserver(entries => { paused = !entries.some(e => e.isIntersecting); }, { threshold: 0.01 }).observe(container);
    }

    // ── HUD updates ─────────────────────────────────────────────────────────
    function updateClock(jd) {
        const d = new Date((jd - 2440587.5) * 86400000);
        hud.clock.textContent = `${d.toUTCString().slice(5, 22)} UTC`;
    }
    updateClock(lastJD);

    function sourceLabel(item) {
        if (item.source === 'horizons') return `JPL Horizons (${item.telemetry?.command ?? '…'})`;
        if (item.source === 'sgp4') return `SGP4 · NORAD ${item.telemetry?.norad ?? ''}`;
        return 'model (analytic placement)';
    }

    function fmtAU(au) { return au < 0.01 ? `${(au * KM_PER_AU).toFixed(0)} km` : au < 0.1 ? `${(au * KM_PER_AU / 1e6).toFixed(2)} Mkm` : `${au.toFixed(au < 10 ? 3 : 1)} AU`; }
    function fmtLight(min) { return min < 1 ? `${(min * 60).toFixed(0)} s` : min < 120 ? `${min.toFixed(1)} min` : `${(min / 60).toFixed(1)} h`; }

    function telemetryLine(item) {
        const t = item.telemetry;
        if (!t) return '';
        const parts = [];
        const host = resolveLoc(item.loc, lastJD)?.host;
        if (t.alt_km != null) parts.push(`alt ${t.alt_km.toFixed(0)} km`);
        else if (t.r_host_km != null) parts.push(`${fmtAU(t.r_host_km / KM_PER_AU)} from ${cap(host || 'host')}`);
        if (t.r_sun_au != null) parts.push(`r☉ ${fmtAU(t.r_sun_au)}`);
        // the Earth distance is the host distance already printed for Earth-local draws
        if (t.r_earth_au != null && !(host === 'earth' && (t.alt_km != null || t.r_host_km != null))) parts.push(`Earth ${fmtAU(t.r_earth_au)}`);
        if (t.light_min != null) parts.push(`light ${fmtLight(t.light_min)}`);
        if (t.speed_kms != null) parts.push(`${t.speed_kms.toFixed(1)} km/s`);
        return parts.join(' · ');
    }

    function provenanceLine(item) {
        const t = item.telemetry;
        if (item.source === 'horizons') {
            const at = t?.fetched_at ? new Date(t.fetched_at).toUTCString().slice(17, 22) : '';
            return `JPL Horizons ${t?.command ? `(${t.command})` : ''} ${t?.mode === 'extrapolated' ? '· extrapolated past the window' : ''} ${at ? `· fetched ${at} UTC` : ''}`.replace(/\s+/g, ' ').trim();
        }
        if (item.source === 'sgp4') return `SGP4 on CelesTrak elements · NORAD ${t?.norad ?? ''} · epoch ${t?.epoch_age_h != null ? t.epoch_age_h.toFixed(1) + ' h old' : ''}`;
        return 'Analytic model — published orbit elements / transfer dates, not a live fix';
    }

    function updateTelemetry() {
        if (!selected) return;
        hud.detailTel.textContent  = telemetryLine(selected);
        hud.detailProv.textContent = provenanceLine(selected);
        hud.detailProv.dataset.source = selected.source;
    }

    function updateHUD() {
        if (!selected) {
            hud.detail.classList.remove('mn3-detail--shown');
            for (const item of missionItems) if (item !== hovered) item.halo.material.opacity = 0;
            return;
        }
        const m = selected.mission;
        hud.detail.classList.add('mn3-detail--shown');
        hud.detailName.textContent = m.name;
        hud.detailMeta.textContent = [m.agency, m.status?.toUpperCase(), locationLabel(selected.loc, lastJD)].filter(Boolean).join(' · ');
        hud.detailSummary.textContent = m.summary || m.note || '';
        updateTelemetry();
    }

    function provenance() {
        const summary = provenanceSummary(missionItems.filter(i => i.visible));
        return { ...summary, status: { ...live.status }, drawn: missionItems.filter(i => i.visible).length };
    }
    function provText(p) {
        const bits = [];
        if (p.horizons) bits.push(`${p.horizons} JPL Horizons`);
        if (p.sgp4) bits.push(`${p.sgp4} SGP4`);
        if (p.model) bits.push(`${p.model} model`);
        const noLive = p.horizons === 0 && p.sgp4 === 0;
        const state = noLive && p.status.ephemeris !== 'pending' ? ' · live feeds down, model only'
            : p.status.ephemeris === 'stale' || p.status.ephemeris === 'down' ? ' · Horizons feed down' : '';
        return `Positions: ${bits.join(' · ')}${state}`;
    }
    hud.prov.textContent = 'Positions: loading live ephemerides…';

    // ── External API ────────────────────────────────────────────────────────
    const api = {
        focusMission(id) {
            const item = missionById.get(id);
            if (!item || !item.visible) return false;
            selectItem(item);
            return true;
        },
        clearSelection() { selected = null; updateHUD(); },
        describe(id) {
            const item = missionById.get(id);
            if (!item || !item.visible) return null;
            return { id, source: item.source, where: locationLabel(item.loc, lastJD), telemetry: item.telemetry, line: telemetryLine(item), provenance: provenanceLine(item) };
        },
        items() {
            return missionItems.map(i => ({ id: i.mission.id, visible: i.visible, source: i.source, pos: i.pos, scene: i.visible ? i.sprite.position.toArray() : null }));
        },
        provenance,
        /** Test hook: inject a route payload / TLE records without the network. */
        setLive({ ephemeris, tles } = {}) {
            if (ephemeris) { applyEphemeris(ephemeris); live.status.ephemeris = ephemeris.freshness === 'live' ? 'live' : 'stale'; }
            if (tles) { for (const [id, rec] of Object.entries(tles)) applyTle(id, rec); live.status.tle = 'live'; }
            announceLive();
        },
        planets: () => snapshotPlanets(lastJD),
        camera, controls,
        dispose() { cancelAnimationFrame(rafId); ro.disconnect(); renderer.dispose(); container.innerHTML = ''; },
    };
    if (typeof window !== 'undefined') window.__missionsViewer = api;
    return api;
}

// ── HUD DOM ──────────────────────────────────────────────────────────────────
function buildHUD(container) {
    if (!document.getElementById('mn3-css')) {
        const css = document.createElement('style');
        css.id = 'mn3-css';
        css.textContent = `
        .mn3-host { position:relative; }
        .mn3-controls { position:absolute; top:10px; right:10px; display:flex; gap:6px; z-index:5; flex-wrap:wrap; justify-content:flex-end; max-width:60%; }
        .mn3-btn { font:600 .66rem 'Segoe UI', system-ui, sans-serif; padding:5px 10px; cursor:pointer; background:rgba(10,6,28,.78); color:#bcd;
            border:1px solid rgba(255,255,255,.15); border-radius:999px; backdrop-filter:blur(8px); letter-spacing:.04em; text-transform:uppercase; transition:all .15s; }
        .mn3-btn:hover { color:#fff; border-color:rgba(255,184,48,.4); }
        .mn3-btn.mn3-on { background:rgba(255,184,48,.18); border-color:#fb0; color:#fc7; }
        .mn3-clock { position:absolute; top:10px; left:10px; z-index:5; font:600 .7rem monospace; padding:5px 10px; color:#9ab; background:rgba(10,6,28,.78);
            border:1px solid rgba(0,200,200,.18); border-radius:6px; backdrop-filter:blur(8px); }
        .mn3-clock::before { content:'● LIVE  '; color:#4fc97f; }
        .mn3-prov { position:absolute; top:40px; left:10px; z-index:5; font:600 .64rem monospace; padding:4px 9px; color:#cbd; background:rgba(10,6,28,.72);
            border:1px solid rgba(255,255,255,.1); border-radius:6px; backdrop-filter:blur(8px); letter-spacing:.03em; }
        .mn3-legend { position:absolute; bottom:10px; left:10px; z-index:5; display:flex; flex-direction:column; gap:5px; font:600 .62rem 'Segoe UI', system-ui, sans-serif;
            background:rgba(10,6,28,.78); padding:6px 10px; border:1px solid rgba(255,255,255,.08); border-radius:6px; backdrop-filter:blur(8px); color:#bcd; max-width:360px; }
        .mn3-legend-row { display:flex; gap:10px; flex-wrap:wrap; }
        .mn3-legend-item { display:flex; align-items:center; gap:4px; text-transform:uppercase; letter-spacing:.05em; }
        .mn3-legend-dot { width:8px; height:8px; border-radius:50%; box-shadow:0 0 6px currentColor; }
        .mn3-legend-note { font-weight:500; color:#889; letter-spacing:0; text-transform:none; line-height:1.35; }
        .mn3-tip { position:absolute; z-index:6; display:none; pointer-events:none; font:600 .66rem 'Segoe UI', system-ui, sans-serif; color:#fff;
            background:rgba(10,6,28,.9); border:1px solid rgba(255,184,48,.35); border-radius:5px; padding:3px 7px; white-space:nowrap; }
        .mn3-detail { position:absolute; bottom:10px; right:10px; z-index:5; max-width:360px; padding:10px 12px; background:rgba(10,6,28,.88);
            border:1px solid rgba(255,184,48,.35); border-left:3px solid #fb0; border-radius:8px; backdrop-filter:blur(10px); color:#ccd;
            opacity:0; transform:translateY(8px); pointer-events:none; transition:opacity .2s, transform .2s; }
        .mn3-detail--shown { opacity:1; transform:translateY(0); pointer-events:auto; }
        .mn3-detail-name { font-size:.95rem; font-weight:800; color:#eef; margin-bottom:3px; }
        .mn3-detail-meta { font-size:.66rem; color:#998; font-family:monospace; margin-bottom:6px; letter-spacing:.04em; }
        .mn3-detail-summary { font-size:.76rem; line-height:1.5; color:#ccd; }
        .mn3-detail-tel { font-size:.68rem; font-family:monospace; color:#fc7; margin-top:7px; line-height:1.45; }
        .mn3-detail-prov { font-size:.62rem; font-family:monospace; color:#7a8; margin-top:4px; line-height:1.4; }
        .mn3-detail-prov[data-source="sgp4"] { color:#8bd; }
        .mn3-detail-prov[data-source="model"] { color:#a98; }
        @media (max-width:720px) {
            .mn3-detail { max-width:none; left:10px; }
            .mn3-legend { display:none; }
            .mn3-controls { max-width:70%; }
            .mn3-prov { top:38px; font-size:.58rem; max-width:55%; }
        }`;
        document.head.appendChild(css);
    }

    container.classList.add('mn3-host');

    const clock = document.createElement('div');
    clock.className = 'mn3-clock'; clock.textContent = '— UTC';
    container.appendChild(clock);

    const prov = document.createElement('div');
    prov.className = 'mn3-prov'; prov.id = 'mn3-prov';
    container.appendChild(prov);

    const controls = document.createElement('div');
    controls.className = 'mn3-controls';
    const mkBtn = (label, id) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'mn3-btn'; b.textContent = label; b.dataset.view = id; controls.appendChild(b); return b; };
    const btnInner  = mkBtn('Inner', 'inner');
    const btnOuter  = mkBtn('Outer', 'outer');
    const btnFar    = mkBtn('Heliopause', 'far');
    const btnEarth  = mkBtn('Earth', 'earth');
    const btnTop    = mkBtn('Top-down', 'top');
    const btnEdge   = mkBtn('Edge', 'edge');
    const btnFollow = mkBtn('Follow', 'follow');
    const btnReset  = mkBtn('Reset', 'reset');
    container.appendChild(controls);

    const legend = document.createElement('div');
    legend.className = 'mn3-legend';
    const l1 = localSceneDistance(LAGRANGE_KM, 'earth') / DRAW_RADIUS_AU.earth;
    legend.innerHTML = `<div class="mn3-legend-row">${Object.entries({ Operational: STATUS_HEX.operational, Extended: STATUS_HEX.extended, Cruising: STATUS_HEX.cruising, Completed: STATUS_HEX.completed, Retired: STATUS_HEX.retired })
        .map(([k, c]) => `<span class="mn3-legend-item"><span class="mn3-legend-dot" style="background:${c};color:${c}"></span>${k}</span>`).join('')}</div>
        <div class="mn3-legend-note">1 unit = 1 AU, planets drawn oversized. Earth / Moon / Mars / Jupiter neighbourhoods are <b>log-compressed</b>: surface → Sun–Earth L1/L2 spans 1 → ${l1.toFixed(0)} drawn radii, direction exact. Positions: JPL Horizons where it resolves, SGP4 for Earth orbit, else the analytic model — each marker says which.</div>`;
    container.appendChild(legend);

    const tip = document.createElement('div');
    tip.className = 'mn3-tip';
    container.appendChild(tip);

    const detail = document.createElement('div');
    detail.className = 'mn3-detail'; detail.id = 'mn3-detail';
    const mk = (cls) => { const d = document.createElement('div'); d.className = cls; detail.appendChild(d); return d; };
    const detailName = mk('mn3-detail-name'), detailMeta = mk('mn3-detail-meta'), detailSummary = mk('mn3-detail-summary');
    const detailTel = mk('mn3-detail-tel'), detailProv = mk('mn3-detail-prov');
    container.appendChild(detail);

    return { clock, prov, tip, btnTop, btnEdge, btnInner, btnOuter, btnFar, btnEarth, btnFollow, btnReset, detail, detailName, detailMeta, detailSummary, detailTel, detailProv };
}

export default initMissionsViewer;
