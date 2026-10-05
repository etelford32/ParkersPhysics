/**
 * spaceship-designer-3d.js — 3D vehicle builder + launch animation for the
 * Space Ship Designer page.
 *
 * Builds the vehicle from the ONE stack geometry the kernel computes
 * (`stackLayout` in spaceship-designer-engine.js) and flies it along the ONE
 * trajectory the kernel integrates (`runAscent`), posed by the pure flight
 * kernel (spaceship-designer-flight.js). It computes no physics of its own.
 *
 * LOAD-BEARING (each was a bug in the version this replaced, 2026-10):
 *   • ENGINES ARE REAL SIZE. Bells are drawn at their physical throat/exit/
 *     length (`engineGeometry`) and packed by `clusterLayout`; nothing is
 *     shrunk to fit. A cluster wider than its stage gets a flared aft skirt —
 *     the same flare computeStats bills as reference area.
 *   • THE STACK STANDS ON A LAUNCH MOUNT. Stage 1's skin base sits
 *     `engineDrop + clearance` above the deck. The old view put it at y = 0, so
 *     every bell hung inside the pad and the plume was a speck in the trench.
 *   • EVERY STAGE HAS ITS OWN ENGINES AND PLUMES, lit only while that stage is
 *     the one firing in the trajectory (sample.stage, !sample.coasting). Spent
 *     stages are DETACHED (scene.attach keeps their world transform) and fly
 *     ballistically from the vehicle's velocity at separation; the fairing
 *     halves / escape tower go at the kernel's `fairing` event.
 *   • THE CAMERA FOLLOWS BY TRANSLATING THE RIG, EXACTLY, every frame — target
 *     and camera move by the same vector, so the user's own orbit / zoom are
 *     never overwritten (the star-collider rule; an eased follow trails a fast
 *     vehicle). The old view eased only the target, so the camera stayed on
 *     the ground staring up at a vehicle leaving the frame.
 *   • TRUE SCALE, NO ALTITUDE COMPRESSION. The vehicle flies real metres over
 *     a planet of real radius; near/far are re-ranged from the camera distance
 *     every frame so the pad and the limb both resolve.
 *
 * Public:
 *   createRocketScene(canvas, opts) → {
 *     build(design), launch(ascentResult), abort(), reset(),
 *     setStaticFire(on), isStaticFiring, setView(name), setAutoRotate(bool),
 *     debug(), dispose(), design,
 *   }
 *   opts.onTick(state) — per-frame flight telemetry for the HUD
 *   opts.onPhase(name) — phase transitions
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildEngineBell } from './launch-engine-bell.js';
import { buildPlume, tickPlume } from './launch-plume.js';
import { buildLatticeTower, buildBeacon, tickBeacons, PAD_COLORS } from './launch-pad-3d.js';
import {
    PROPELLANTS, LIVERIES, LAUNCH_BODIES, stackLayout, designStageExpansion01,
} from './spaceship-designer-engine.js';
import { sampleTrajectory, poseAt, flightEvents, playbackRate, airFraction } from './spaceship-designer-flight.js';
import {
    BODY_LOOK, createSky, createStars, createPlanet, createParticles, SMOKE, sunDirection,
} from './spaceship-designer-fx.js';

// Plume palette per propellant. Additive blending: darker = dimmer, which is
// how hydrolox and nuclear plumes come out nearly transparent (as they are).
// lenD = visible sea-level plume length in exit diameters (cosmetic).
const PLUME_LOOK = {
    kerolox:    { core: 0xfff2d0, mid: 0xffa040, outer: 0x3a1a08, lenD: 26 },
    methalox:   { core: 0xeaf4ff, mid: 0x7fb8ff, outer: 0x101c3a, lenD: 22 },
    hydrolox:   { core: 0xc8d4f0, mid: 0x5a6aa0, outer: 0x0a1020, lenD: 18 },
    hypergolic: { core: 0xfff0d0, mid: 0xff9a50, outer: 0x401808, lenD: 20 },
    solid:      { core: 0xffffff, mid: 0xfff2c8, outer: 0x8a6a40, lenD: 30 },
    nuclear:    { core: 0xd8ecff, mid: 0x4a6a88, outer: 0x060c14, lenD: 12 },
    ion:        { core: 0xbfe4ff, mid: 0x3a78ff, outer: 0x000610, lenD: 30 },
};

const DECK_TOP = 1.5;              // concrete deck height (m)
const MOUNT_CLEARANCE = 3.5;       // engine exit plane → deck (m): room for the plume to turn
const IGNITION_HOLD_S = 3.0;       // engines light at T−3 s, hold-downs release at T−0

export function createRocketScene(canvas, opts = {}) {
    const onTick = opts.onTick || (() => {});
    const onPhase = opts.onPhase || (() => {});

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);
    scene.fog = new THREE.FogExp2(0xb7d3ea, 0);

    const camera = new THREE.PerspectiveCamera(42, 1, 0.5, 4e7);
    camera.position.set(60, 45, 90);

    // Y-up scene, camera.up never changes → OrbitControls is built once and
    // never needs the rebuild the Z-up / local-vertical pages do.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 6;
    controls.maxDistance = 2500;
    controls.target.set(0, 30, 0);

    // ── Lighting ──
    const SUN = sunDirection();
    const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x3a3328, 0.75);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
    sun.position.copy(SUN).multiplyScalar(200);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0004;
    scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-60, 40, -40);
    scene.add(fill);
    // Exhaust light: lights the deck, the mount and the vehicle's own base.
    const engineLight = new THREE.PointLight(0xffa040, 0, 0, 2);
    scene.add(engineLight);

    // ── Environment (rebuilt when the body or launch latitude changes) ──
    let env = null;            // { key, body, look, sky, stars, planet, ground }
    const particles = createParticles(3200);
    scene.add(particles.points);

    // ── Pad (rebuilt per design: the mount is sized to the vehicle) ──
    const padRoot = new THREE.Group();
    scene.add(padRoot);
    let padBeacons = [], padArms = [], padOwned = new Set();
    let padGeom = null;               // { holeR, outerR, legs } of the current launch mount

    // ── Rocket ──
    const rocketRoot = new THREE.Group();
    scene.add(rocketRoot);
    let owned = new Set();            // geometries + materials of the current build
    let currentDesign = null;
    let stack = null;                 // stackLayout(currentDesign)
    let stageGroups = [];             // one Group per stage (detachable)
    let engineSets = [];              // per stage: { pivots, plumes, bellMats, hotMats, look, gimbalRad, glow, fullThrust }
    let noseParts = { halves: [], les: null };
    let rcs = [];                     // puff meshes
    let baseY = DECK_TOP + 4;         // rocket skin base height on the mount
    let debris = [];
    let staticFire = false;
    let autoRotate = false;
    let flight = null;
    let rcsPuffT = 0;

    function own(obj) {
        obj.traverse((c) => {
            if (c.geometry) owned.add(c.geometry);
            const m = c.material;
            if (Array.isArray(m)) m.forEach((x) => owned.add(x)); else if (m) owned.add(m);
        });
        return obj;
    }
    function disposeSet(set) {
        for (const r of set) r.dispose?.();
        set.clear();
    }

    // ── Environment ─────────────────────────────────────────────────────────
    function ensureEnv(design) {
        const body = LAUNCH_BODIES[design.bodyId] || LAUNCH_BODIES.earth;
        const lat = Math.round((design.launchLatitude ?? 0) * 2) / 2;
        const key = body.id + ':' + lat;
        if (env?.key === key) return env;
        if (env) {
            scene.remove(env.sky.mesh, env.stars.points, env.planet.group, env.ground);
            env.sky.dispose(); env.stars.dispose(); env.planet.dispose();
            env.ground.geometry.dispose(); env.ground.material.map?.dispose(); env.ground.material.dispose();
        }
        const look = BODY_LOOK[body.id] || BODY_LOOK.moon;
        const sky = createSky(look);
        const stars = createStars();
        const planet = createPlanet(body, look, lat);
        // Local ground apron: the planet's polar facet is ~100 km wide, so
        // the ground round the pad gets its own flat disc. 20 km is wide
        // enough that fog, not the disc's rim, makes the horizon (a 3 km disc
        // ended 1° below it in a hard line); its sag against the true sphere
        // is 31 m at the rim, and it is hidden above 25 km anyway.
        const ground = new THREE.Mesh(
            new THREE.CircleGeometry(20000, 96),
            new THREE.MeshStandardMaterial({ color: look.ground, map: groundTexture(), roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, transparent: true }),
        );
        ground.rotation.x = -Math.PI / 2;
        ground.receiveShadow = true;
        scene.add(sky.mesh, stars.points, planet.group, ground);
        hemi.groundColor.setHex(look.ground);
        env = { key, body, look, sky, stars, planet, ground };
        return env;
    }

    function updateEnv() {
        if (!env) return;
        const C = new THREE.Vector3(0, -env.planet.R, 0);
        const rel = camera.position.clone().sub(C);
        const camAlt = rel.length() - env.planet.R;
        const up = rel.normalize();
        const air = airFraction(env.body, camAlt);
        // Perceived sky brightness falls much more slowly than pressure: the
        // sky is still blue at 10 km (p/p₀ ≈ 0.3) and only black by ~60 km.
        const skyAir = Math.pow(air, 0.35);
        env.sky.update(camera.position, up, skyAir);
        const hasAir = env.body.rho0_kg_m3 > 1e-6;
        env.stars.update(camera.position, hasAir ? 1 - Math.min(1, air * 30) : 0.75);
        env.planet.update(camera.position, camAlt);
        // Fog = the horizon colour, visibility from the body's surface value,
        // thinning with the air above the camera.
        scene.fog.color.setHex(env.look.horizon ?? 0x000000).multiplyScalar(Math.max(0.05, skyAir));
        // Haze is a SURFACE phenomenon: thin it faster than the pressure so
        // the ground stays visible looking down from altitude.
        scene.fog.density = hasAir && env.look.fog ? Math.pow(air, 1.5) / env.look.fog : 0;
        // The apron and pad are 3 km of flat ground; from high up they would
        // z-fight the sphere, and they are sub-pixel anyway.
        // The flat apron hands over to the true sphere (and its map) as the
        // camera climbs from 2 to 8 km.
        const apron = 1 - Math.min(1, Math.max(0, (camAlt - 2000) / 6000));
        env.ground.material.opacity = apron;
        env.ground.visible = apron > 0.01;
        padRoot.visible = camAlt < 25000;
        // Depth range rides the camera distance: 5 m from an engine bell and
        // 300 km over the limb are the same scene.
        const d = camera.position.distanceTo(controls.target);
        camera.near = Math.min(50, Math.max(0.05, d * 0.004));
        camera.far = 4e7;
        camera.updateProjectionMatrix();
        hemi.intensity = 0.25 + 0.5 * (hasAir ? Math.max(air, 0.15) : 0.35);
    }

    // ── Build ───────────────────────────────────────────────────────────────
    function build(design) {
        currentDesign = design;
        // A rebuild mid-flight (the user edited the design) ends that flight —
        // resolve its promise or the page's Launch button never re-enables.
        const was = flight; flight = null;
        was?.resolve?.(was.result);
        ensureEnv(design);
        disposeRocket();
        stack = stackLayout(design);
        const liv = LIVERIES[design.livery?.id] || LIVERIES.classic;
        const M = {
            body: new THREE.MeshStandardMaterial({ color: liv.primary, roughness: 0.45, metalness: 0.1 }),
            dark: new THREE.MeshStandardMaterial({ color: liv.secondary, roughness: 0.55, metalness: 0.25 }),
            accent: new THREE.MeshStandardMaterial({ color: liv.accent, roughness: 0.4, metalness: 0.3 }),
            bulk: new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.7, metalness: 0.4, side: THREE.DoubleSide }),
            steel: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.45, metalness: 0.7 }),
        };

        stack.stages.forEach((st, i) => {
            const g = new THREE.Group();
            g.name = `stage-${i + 1}`;
            const prop = PROPELLANTS[st.engine.propellant] || PROPELLANTS.kerolox;
            buildStageBody(g, st, i, prop, design, M);
            engineSets[i] = buildEngineSet(g, st, i);
            rocketRoot.add(g);
            stageGroups.push(g);
        });
        buildNose(design, M);
        buildRcs(M);
        own(rocketRoot);
        rocketRoot.traverse((c) => { if (c.isMesh && !c.material?.transparent) c.castShadow = true; });

        buildPad(design);
        rocketRoot.position.set(0, baseY, 0);
        rocketRoot.rotation.set(0, 0, 0);
        if (staticFire) setPlumes(0, true);
        frameCamera();
        return { height: stack.bodyLength_m };
    }

    function disposeRocket() {
        for (const d of debris) scene.remove(d.obj);
        debris = [];
        for (const g of stageGroups) { g.parent?.remove(g); }
        for (const h of noseParts.halves) h.parent?.remove(h);
        noseParts.les?.parent?.remove(noseParts.les);
        rocketRoot.clear();
        disposeSet(owned);
        stageGroups = []; engineSets = []; noseParts = { halves: [], les: null }; rcs = [];
        particles.clear();
    }

    function buildStageBody(g, st, i, prop, design, M) {
        const { r, y0, length: len } = st;
        // Hydrolox stages wear their foam (the Shuttle ET / SLS core look);
        // solid motors their bare case. Everything else wears the livery.
        const skin = prop.id === 'hydrolox' || prop.id === 'solid'
            ? new THREE.MeshStandardMaterial({ color: prop.tank, roughness: prop.id === 'solid' ? 0.6 : 0.85, metalness: 0.05 })
            : M.body;
        const body = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 56, 1, true), skin);
        body.position.y = y0 + len / 2;
        g.add(body);

        // Bulkheads — the stage is a closed tank, not a tube you can see sky through.
        const baseR = st.aftSkirt ? st.aftSkirt.rBot : r;
        const aft = new THREE.Mesh(new THREE.CircleGeometry(baseR, 48), M.bulk);
        aft.rotation.x = Math.PI / 2; aft.position.y = y0;
        const fwd = new THREE.Mesh(new THREE.CircleGeometry(r, 48), M.bulk);
        fwd.rotation.x = -Math.PI / 2; fwd.position.y = y0 + len;
        g.add(aft, fwd);

        // Aft skirt flare over an overhanging cluster (Saturn V's engine fairings).
        if (st.aftSkirt) {
            const k = st.aftSkirt;
            const skirt = new THREE.Mesh(new THREE.CylinderGeometry(k.rTop, k.rBot, k.length, 56, 1, true), M.dark);
            skirt.position.y = y0 + k.length / 2;
            g.add(skirt);
        } else {
            const collarH = Math.min(2.2, len * 0.08);
            const collar = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.006, r * 1.02, collarH, 56, 1, true), M.dark);
            collar.position.y = y0 + collarH / 2;
            g.add(collar);
        }

        // Cable raceway — the one external line every real stage carries.
        const race = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.12, r * 0.08), len * 0.86, Math.max(0.1, r * 0.06)), M.dark);
        race.position.set(0, y0 + len / 2, r * 1.01);
        g.add(race);

        // Livery pattern.
        const ring = (yy, h, mat = M.accent) => {
            const m = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.012, r * 1.012, h, 56, 1, true), mat);
            m.position.y = yy; g.add(m);
        };
        const pattern = design.livery?.pattern || 'solid';
        if (prop.id === 'solid') {
            for (let f = 0.2; f < 0.99; f += 0.2) ring(y0 + len * f, Math.min(0.5, len * 0.012), M.dark);   // segment joints
        } else if (pattern === 'stripe') ring(y0 + len * 0.82, Math.min(2, len * 0.06));
        else if (pattern === 'bands') { for (let f = 0.2; f < 0.95; f += 0.25) ring(y0 + len * f, Math.min(1.2, len * 0.04)); }
        else if (pattern === 'checker') { for (let f = 0.15; f < 0.95; f += 0.18) ring(y0 + len * f, Math.min(0.8, len * 0.03)); }

        // Interstage — houses the next stage's engines; jettisoned with THIS stage.
        if (st.interstage) {
            const it = st.interstage;
            const inter = new THREE.Mesh(new THREE.CylinderGeometry(it.rTop, it.rBot, it.length, 56, 1, true), M.dark);
            inter.material = M.dark;
            inter.position.y = it.y0 + it.length / 2;
            g.add(inter);
        }

        if (i === 0) addFins(g, design.fins, st, M);
    }

    function addFins(g, fins, st, M) {
        if (!fins || fins.type === 'none') return;
        const count = Math.max(2, Math.min(8, fins.count || 4));
        const r = st.r;
        for (let k = 0; k < count; k++) {
            const a = (k / count) * Math.PI * 2 + Math.PI / count;
            if (fins.type === 'grid') {
                // Grid fins sit at the TOP of the booster (they steer it home
                // tail-first): a frame with a 4×4 lattice, stowed flat.
                const w = Math.max(0.8, r * 0.75), h = w * 1.25, t = 0.06;
                const fin = new THREE.Group();
                const bar = (bw, bh, x, y) => {
                    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.22), M.dark);
                    m.position.set(x, y, 0); fin.add(m);
                };
                bar(w, t * 2, 0, h / 2); bar(w, t * 2, 0, -h / 2); bar(t * 2, h, w / 2, 0); bar(t * 2, h, -w / 2, 0);
                for (let q = 1; q < 4; q++) { bar(t, h, -w / 2 + (w * q) / 4, 0); bar(w, t, 0, -h / 2 + (h * q) / 4); }
                fin.position.set(Math.cos(a) * (r + 0.15), st.y0 + st.length - h * 0.9, Math.sin(a) * (r + 0.15));
                fin.rotation.y = -a + Math.PI / 2;
                g.add(fin);
            } else {
                const span = r * (fins.type === 'swept' ? 1.3 : 1.1);
                const root = r * 2.6;
                const sweep = fins.type === 'swept' ? 0.85 : 0.45;
                const shape = new THREE.Shape();
                shape.moveTo(0, 0); shape.lineTo(0, root);
                shape.lineTo(span, root * (1 - sweep)); shape.lineTo(span, 0); shape.closePath();
                const geo = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.12, r * 0.06), bevelEnabled: false });
                geo.translate(0, 0, -Math.max(0.12, r * 0.06) / 2);
                const fin = new THREE.Mesh(geo, M.dark);
                fin.position.set(Math.cos(a) * r * 0.98, st.y0 - st.geo.bellLen_m * 0.2, Math.sin(a) * r * 0.98);
                fin.rotation.y = -a;
                g.add(fin);
            }
        }
    }

    function buildEngineSet(g, st, i) {
        const e = st.engine, geo = st.geo;
        const look = PLUME_LOOK[e.propellant] || PLUME_LOOK.kerolox;
        const n = st.cluster.positions.length;
        const detail = n > 12 ? 'low' : n > 4 ? 'medium' : 'high';
        let proto;
        if (geo.kind === 'ion') proto = buildIonThruster(geo);
        else {
            proto = buildEngineBell({
                type: e.bell, detail,
                throatR: geo.throatR_m, exitR: geo.exitR_m, length: geo.bellLen_m,
                tubes: geo.cooling === 'regen' ? undefined : false,
            });
        }
        // Materials the firing state drives: the bell skin (radiatively-cooled
        // extensions glow orange in flight) and the BackSide interior glow.
        const bellMats = new Set(), hotMats = new Set();
        proto.traverse((c) => {
            if (!c.isMesh) return;
            if (c.material?.isMeshPhysicalMaterial) bellMats.add(c.material);
            if (c.material?.isMeshBasicMaterial && c.material.side === THREE.BackSide) {
                c.material.userData.base = c.material.color.clone();
                hotMats.add(c.material);
            }
        });
        const pivots = [], plumes = [];
        st.cluster.positions.forEach((p, k) => {
            const pivot = new THREE.Group();
            pivot.position.set(p.x, st.y0, p.z);       // gimbal at the throat plane
            const bell = k === 0 ? proto : proto.clone();
            pivot.add(bell);
            const plume = buildPlume({
                coreRadius: (geo.exitR_m / 1.6) * 0.95,
                outerLen: geo.exitR_m * 2 * look.lenD,
                coreColor: look.core, midColor: look.mid, outerColor: look.outer,
                name: `plume-s${i + 1}-${k}`,
            });
            plume.position.y = -geo.bellLen_m;
            pivot.add(plume);
            g.add(pivot);
            pivots.push(pivot); plumes.push(plume);
        });
        const fullThrust = Math.max(1, (i === 0 ? (e.sl_kn || e.vac_kn) : e.vac_kn) * n);
        return {
            pivots, plumes, bellMats: [...bellMats], hotMats: [...hotMats], look,
            gimbalRad: ((geo.gimbalDeg || 0) * Math.PI) / 180, glow: 0, lit: false,
            radiative: geo.cooling === 'radiative', fullThrust, geo, st,
        };
    }

    function buildIonThruster(geo) {
        const g = new THREE.Group();
        const R = geo.exitR_m;
        const body = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.12, R * 1.0, geo.bellLen_m, 32),
            new THREE.MeshPhysicalMaterial({ color: 0x8e949c, metalness: 0.7, roughness: 0.35 }));
        body.position.y = -geo.bellLen_m / 2;
        const grid = new THREE.Mesh(new THREE.CircleGeometry(R * 0.95, 32),
            new THREE.MeshBasicMaterial({ color: 0x16243a, side: THREE.BackSide }));
        grid.rotation.x = -Math.PI / 2;
        grid.position.y = -geo.bellLen_m - 0.005;
        g.add(body, grid);
        return g;
    }

    // Nose: fairing halves (jettisonable) round a payload, a crew capsule with
    // its launch-escape tower, or a winged spaceplane.
    function buildNose(design, M) {
        const type = design.payload?.nosecone || 'ogive';
        const top = stack.stages[stack.stages.length - 1];
        const r = top ? top.r : 1.8;
        const L = stack.noseLen;
        const y0 = stack.noseY0;
        const hostG = stageGroups[stageGroups.length - 1];

        if (type === 'capsule') {
            const rc = Math.min(r, 2.6);
            const capH = Math.min(L * 0.75, rc * 1.25);
            const adH = rc < r - 0.05 ? Math.max(1, (r - rc) * 1.6) : 0;
            if (adH) {
                const ad = new THREE.Mesh(new THREE.CylinderGeometry(rc, r, adH, 48, 1, true), M.dark);
                ad.position.y = y0 + adH / 2; hostG.add(ad);
            }
            const prof = [];
            for (let k = 0; k <= 12; k++) {
                const t = k / 12;
                prof.push(new THREE.Vector2(rc * (1 - 0.66 * t) + 0.001, capH * t));
            }
            prof.unshift(new THREE.Vector2(0.001, -rc * 0.06));
            prof.push(new THREE.Vector2(rc * 0.18, capH), new THREE.Vector2(rc * 0.18, capH + rc * 0.12), new THREE.Vector2(0.001, capH + rc * 0.12));
            const cap = new THREE.Mesh(new THREE.LatheGeometry(prof, 48), M.body);
            cap.position.y = y0 + adH;
            hostG.add(cap);
            addWindows(hostG, design, rc * 0.82, y0 + adH + capH * 0.45, M);
            // Launch-escape tower: truss + solid motor, jettisoned with the fairing event.
            const les = new THREE.Group();
            const towerH = rc * 1.5, motorL = rc * 1.4;
            for (let q = 0; q < 4; q++) {
                const a = (q / 4) * Math.PI * 2;
                const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, towerH, 6), M.dark);
                rod.position.set(Math.cos(a) * rc * 0.12, towerH / 2, Math.sin(a) * rc * 0.12);
                les.add(rod);
            }
            const motor = new THREE.Mesh(new THREE.CylinderGeometry(rc * 0.11, rc * 0.11, motorL, 20), M.body);
            motor.position.y = towerH + motorL / 2;
            const tip = new THREE.Mesh(new THREE.ConeGeometry(rc * 0.11, rc * 0.35, 20), M.accent);
            tip.position.y = towerH + motorL + rc * 0.175;
            les.add(motor, tip);
            les.position.y = y0 + adH + capH + rc * 0.12;
            hostG.add(les);
            noseParts.les = les;
            return;
        }

        if (type === 'spaceplane') {
            const prof = [];
            for (let k = 0; k <= 16; k++) {
                const t = k / 16;
                prof.push(new THREE.Vector2(r * Math.sqrt(Math.max(0, 1 - Math.pow(t, 2.4))) * 0.85 + 0.001, L * t));
            }
            const fuse = new THREE.Mesh(new THREE.LatheGeometry(prof, 48), M.body);
            fuse.position.y = y0;
            hostG.add(fuse);
            const wing = new THREE.Shape();
            wing.moveTo(0, 0); wing.lineTo(r * 2.4, 0); wing.lineTo(0.2, L * 0.6); wing.closePath();
            for (const side of [1, -1]) {
                const w = new THREE.Mesh(new THREE.ExtrudeGeometry(wing, { depth: 0.18, bevelEnabled: false }), M.dark);
                w.position.set(side * r * 0.7, y0 + L * 0.05, -0.09);
                w.scale.x = side;
                hostG.add(w);
            }
            addWindows(hostG, design, r * 0.7, y0 + L * 0.72, M);
            return;
        }

        // Fairing: a cylindrical payload envelope + a tangent-ogive (or cone /
        // blunt) nose, split into two halves that open at jettison.
        const cylL = type === 'cone' ? 0 : L * 0.38;
        const noseL = L - cylL;
        const prof = [new THREE.Vector2(r, 0)];
        if (cylL > 0) prof.push(new THREE.Vector2(r, cylL));
        const rho = (r * r + noseL * noseL) / (2 * r);
        for (let k = 1; k <= 24; k++) {
            const x = (k / 24) * noseL;
            let rad;
            if (type === 'cone') rad = r * (1 - x / noseL);
            else if (type === 'blunt') rad = r * Math.sqrt(Math.max(0, 1 - Math.pow(x / noseL, 2)));   // elliptic
            else rad = Math.sqrt(Math.max(0, rho * rho - x * x)) + r - rho;   // tangent ogive, x from its base: r at 0, 0 at noseL
            prof.push(new THREE.Vector2(Math.max(0.001, rad), cylL + x));
        }
        const fairMat = M.body.clone(); fairMat.side = THREE.DoubleSide;
        owned.add(fairMat);
        for (const side of [0, 1]) {
            const half = new THREE.Group();
            const m = new THREE.Mesh(new THREE.LatheGeometry(prof, 28, side * Math.PI, Math.PI), fairMat);
            half.add(m);
            half.position.y = y0;
            half.userData.side = side ? -1 : 1;     // +X half / −X half
            hostG.add(half);
            noseParts.halves.push(half);
        }
        if (design.cockpit?.layout && design.cockpit.layout !== 'none') addWindows(hostG, design, r * 0.97, y0 + cylL + noseL * 0.3, M);
        // Payload: a generic satellite bus, revealed when the fairing opens.
        const w = r * 1.05, h = Math.min(L * 0.5, r * 1.5);
        const sat = new THREE.Group();
        const adapter = new THREE.Mesh(new THREE.CylinderGeometry(w * 0.35, r * 0.7, h * 0.18, 32), M.dark);
        adapter.position.y = h * 0.09;
        const bus = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.7, w),
            new THREE.MeshStandardMaterial({ color: 0xc89a3c, metalness: 0.85, roughness: 0.3 }));
        bus.position.y = h * 0.18 + h * 0.35;
        const panelMat = new THREE.MeshStandardMaterial({ color: 0x1a2a55, metalness: 0.4, roughness: 0.35 });
        for (const sx of [1, -1]) {
            const p = new THREE.Mesh(new THREE.BoxGeometry(0.06, h * 0.62, w * 0.9), panelMat);
            p.position.set(sx * (w / 2 + 0.05), bus.position.y, 0);
            sat.add(p);
        }
        const dish = new THREE.Mesh(new THREE.SphereGeometry(w * 0.28, 20, 8, 0, Math.PI * 2, 0, Math.PI / 3), M.steel);
        dish.rotation.x = Math.PI; dish.position.y = bus.position.y + h * 0.35 + w * 0.28;
        sat.add(adapter, bus, dish);
        sat.position.y = y0;
        hostG.add(sat);
    }

    function addWindows(parent, design, r, yy, M) {
        const n = Math.max(0, Math.min(8, design.cockpit?.windows ?? 2));
        const glass = new THREE.MeshStandardMaterial({
            color: design.cockpit?.layout === 'glass' ? 0x0a1a2a : 0x121821,
            emissive: 0x123a55, emissiveIntensity: 0.6, roughness: 0.15, metalness: 0.6,
        });
        for (let k = 0; k < n; k++) {
            const a = (k / Math.max(1, n)) * Math.PI * 2;
            const w = new THREE.Mesh(new THREE.CircleGeometry(r * 0.13, 16), glass);
            w.position.set(Math.cos(a) * r * 1.01, yy, Math.sin(a) * r * 1.01);
            w.lookAt(Math.cos(a) * r * 3, yy, Math.sin(a) * r * 3);
            parent.add(w);
        }
    }

    // RCS quads on the top stage: cold-gas puffs at separation (ullage
    // settling) and fairing jettison. Cosmetic.
    function buildRcs(M) {
        const top = stack.stages[stack.stages.length - 1];
        if (!top) return;
        const g = stageGroups[stageGroups.length - 1];
        const puffMat = new THREE.MeshBasicMaterial({ color: 0xf2f6ff, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
        for (let k = 0; k < 4; k++) {
            const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
            const quad = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.45, 0.3), M.dark);
            const y = top.y0 + top.length * 0.92;
            quad.position.set(Math.cos(a) * (top.r + 0.12), y, Math.sin(a) * (top.r + 0.12));
            quad.lookAt(Math.cos(a) * 10, y, Math.sin(a) * 10);
            const puff = new THREE.Mesh(new THREE.ConeGeometry(0.5, 2.4, 12, 1, true), puffMat);
            puff.rotation.x = -Math.PI / 2; puff.position.z = 1.3;
            quad.add(puff);
            g.add(quad);
            rcs.push(puff);
        }
    }

    // ── Pad: deck + launch mount sized to the vehicle + tower ──────────────
    function buildPad(design) {
        padRoot.clear();
        disposeSet(padOwned);
        padBeacons = []; padArms = [];
        const s0 = stack.stages[0];
        if (!s0) return;
        const baseR = s0.aftSkirt ? s0.aftSkirt.rBot : s0.r;
        const holeR = Math.max(s0.cluster.clusterR_m, baseR) + 0.4;
        const mountH = Math.max(4, stack.engineDrop_m + MOUNT_CLEARANCE);
        const outerR = holeR + Math.max(2, baseR * 0.5);
        baseY = DECK_TOP + mountH;
        padGeom = { holeR, outerR, legs: 6 };

        const concrete = new THREE.MeshStandardMaterial({ color: PAD_COLORS.concrete, roughness: 0.95 });
        const steel = new THREE.MeshStandardMaterial({ color: PAD_COLORS.steelDark, roughness: 0.55, metalness: 0.6 });
        const deckW = Math.max(40, outerR * 2 + 30);
        const deck = new THREE.Mesh(new THREE.BoxGeometry(deckW, DECK_TOP, deckW), concrete);
        deck.position.y = DECK_TOP / 2; deck.receiveShadow = true;
        padRoot.add(deck);
        // Launch table: a ring on legs over the flame deflector.
        const ringShape = new THREE.Shape();
        ringShape.absarc(0, 0, outerR, 0, Math.PI * 2, false);
        const hole = new THREE.Path(); hole.absarc(0, 0, holeR, 0, Math.PI * 2, true);
        ringShape.holes.push(hole);
        const table = new THREE.Mesh(new THREE.ExtrudeGeometry(ringShape, { depth: 1.2, bevelEnabled: false, curveSegments: 48 }), steel);
        table.rotation.x = -Math.PI / 2;
        table.position.y = baseY - 1.2;
        table.castShadow = true; table.receiveShadow = true;
        padRoot.add(table);
        const legs = 6;
        for (let k = 0; k < legs; k++) {
            const a = (k / legs) * Math.PI * 2;
            const leg = new THREE.Mesh(new THREE.BoxGeometry(1.4, mountH - 1.2, 1.4), steel);
            leg.position.set(Math.cos(a) * (outerR - 1), DECK_TOP + (mountH - 1.2) / 2, Math.sin(a) * (outerR - 1));
            leg.castShadow = true;
            padRoot.add(leg);
        }
        // Hold-down clamps reaching from the ring to the stage's base.
        for (let k = 0; k < 8; k++) {
            const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
            const span = Math.max(0.3, holeR - baseR + 0.4);
            const clamp = new THREE.Mesh(new THREE.BoxGeometry(span, 0.6, 0.5), steel);
            clamp.position.set(Math.cos(a) * (baseR + span / 2 - 0.15), baseY + 0.3, Math.sin(a) * (baseR + span / 2 - 0.15));
            clamp.rotation.y = -a;
            padRoot.add(clamp);
        }
        const deflector = new THREE.Mesh(new THREE.ConeGeometry(holeR * 1.15, Math.min(mountH * 0.6, holeR * 0.9), 40), steel);
        deflector.position.y = DECK_TOP + Math.min(mountH * 0.6, holeR * 0.9) / 2;
        padRoot.add(deflector);

        // Service tower: a lattice as tall as the vehicle, on the UP-range side
        // (−X) so the ascent never crosses it, with umbilical / crew arms that
        // swing clear at ignition.
        const towerH = baseY + stack.bodyLength_m * 0.92 + 6;
        const foot = Math.min(10, Math.max(5, baseR * 1.2));
        const tower = buildLatticeTower({ height: towerH, footprint: foot, color: PAD_COLORS.fssOrange, bandStep: 7 });
        const tx = -(outerR + foot / 2 + 3);
        tower.position.set(tx, DECK_TOP, 0);
        padRoot.add(tower);
        const beacon = buildBeacon({ color: PAD_COLORS.beaconRed });
        beacon.position.set(tx, DECK_TOP + towerH + 1.2, 0);
        padRoot.add(beacon);
        padBeacons.push({ mesh: beacon, phase: 0, color: PAD_COLORS.beaconRed });

        const armTo = (yWorld, rAtY, w = 1.2) => {
            const reach = Math.abs(tx) - foot / 2 - rAtY - 0.2;
            if (reach <= 0.2) return;
            const pivot = new THREE.Group();
            pivot.position.set(tx + foot / 2, yWorld, 0);
            const arm = new THREE.Mesh(new THREE.BoxGeometry(reach, w, w), steel);
            arm.position.x = reach / 2;
            arm.castShadow = true;
            pivot.add(arm);
            padRoot.add(pivot);
            padArms.push(pivot);
        };
        const top = stack.stages[stack.stages.length - 1];
        if (top && stack.stages.length > 1) armTo(baseY + top.y0 + top.length * 0.5, top.r);
        armTo(baseY + Math.min(8, s0.length * 0.3), s0.r, 0.9);
        if (design.payload?.nosecone === 'capsule' && (design.cockpit?.crew || 0) > 0) {
            armTo(baseY + stack.noseY0 + Math.min(stack.noseLen * 0.4, 2.5), Math.min(top?.r || 2, 2.6) * 0.9, 2.0);
        }

        padRoot.traverse((c) => {
            if (c.geometry) padOwned.add(c.geometry);
            if (c.material) padOwned.add(c.material);
        });
        padArms.forEach((p) => { p.rotation.y = 0; });

        // Shadow box round the pad, sized to the vehicle.
        const span = Math.max(60, stack.bodyLength_m * 0.8 + outerR * 2);
        Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 600 });
        sun.shadow.camera.updateProjectionMatrix();
        sun.target.position.set(0, baseY, 0);
        sun.position.copy(SUN).multiplyScalar(250).add(sun.target.position);
    }

    // ── Plume / engine state ────────────────────────────────────────────────
    function setPlumes(i, on) {
        const es = engineSets[i];
        if (!es) return;
        es.lit = on;
        es.plumes.forEach((p) => { p.visible = on; });
    }
    function tickEngines(i, now, throttle, alt_km, exp01, dtF) {
        const es = engineSets[i];
        if (!es) return;
        for (const p of es.plumes) tickPlume(p, now, throttle, alt_km, exp01);
        // Interior glow follows the flame; a radiatively-cooled skirt heats up
        // over ~20 s of firing and cools when the engine stops.
        const target = es.lit ? throttle : 0;
        es.glow += (target - es.glow) * Math.min(1, dtF / (es.lit ? 20 : 30));
        const core = new THREE.Color(es.look.core);
        for (const m of es.hotMats) m.color.copy(m.userData.base).lerp(core, es.lit ? 0.4 + 0.6 * throttle : 0);
        if (es.radiative) for (const m of es.bellMats) { m.emissive.setHex(0xff5a1a); m.emissiveIntensity = 1.6 * es.glow; }
    }
    function applyGimbal(i, ax, az) {
        const es = engineSets[i];
        if (!es) return;
        const lim = es.gimbalRad;
        for (const p of es.pivots) p.rotation.set(clamp(ax, -lim, lim), 0, clamp(az, -lim, lim));
    }
    function placeEngineLight(i, throttle) {
        const es = engineSets[i];
        if (!es || !es.lit || throttle <= 0) { engineLight.intensity = 0; return; }
        const local = new THREE.Vector3(0, es.st.y0 - es.geo.bellLen_m - 1.5, 0);
        stageGroups[i].localToWorld(local);
        engineLight.position.copy(local);
        engineLight.color.setHex(es.look.mid);
        const R = es.st.cluster.clusterR_m;
        const brightness = es.look === PLUME_LOOK.hydrolox || es.look === PLUME_LOOK.nuclear || es.look === PLUME_LOOK.ion ? 0.25 : 1;
        engineLight.intensity = 260 * throttle * brightness * Math.max(0.3, R * R / 3.4);
    }

    // ── Particles ───────────────────────────────────────────────────────────
    let lastTrailPos = null;
    function emitGroundCloud(intensity, dt) {
        if (!env || intensity <= 0) return;
        const s0 = stack.stages[0];
        const holeR = Math.max(s0.cluster.clusterR_m, s0.r) + 0.4;
        const airy = env.body.rho0_kg_m3 > 1e-6;
        const n = Math.round((airy ? 38 : 30) * intensity * dt * Math.max(1, holeR / 2) + Math.random() * 0.9);
        const smoke = SMOKE[s0.engine.propellant];
        for (let k = 0; k < n; k++) {
            const a = Math.random() * Math.PI * 2;
            const sp = (airy ? 18 : 35) + Math.random() * 30;
            emitRadial(a, sp, holeR, airy, smoke);
        }
    }
    function emitRadial(a, sp, holeR, airy, smoke) {
        particles.emit({
            x: Math.cos(a) * holeR * 0.8, y: DECK_TOP + 1 + Math.random() * 2, z: Math.sin(a) * holeR * 0.8,
            vx: Math.cos(a) * sp, vy: airy ? 2 + Math.random() * 5 : 1 + Math.random() * 3, vz: Math.sin(a) * sp,
            size0: holeR * 1.2, size1: airy ? holeR * 7 + 14 : holeR * 3 + 6,
            life: airy ? 4.5 + Math.random() * 4 : 1.8 + Math.random(),
            color: airy ? (smoke === SMOKE.solid ? smoke.color : 0xeef1f4) : env.look.ground,   // deluge steam / regolith
            alpha: airy ? 0.42 : 0.35, drag: airy ? 0.55 : 0.2, buoy: airy ? 1.6 : 0,
        });
    }
    function emitTrail(i, air, throttle) {
        const es = engineSets[i];
        if (!es || !es.lit) { lastTrailPos = null; return; }
        const smoke = SMOKE[es.st.engine.propellant];
        if (!smoke || air < 0.002) { lastTrailPos = null; return; }
        const local = new THREE.Vector3(0, es.st.y0 - es.geo.bellLen_m - es.geo.exitR_m * 2 * es.look.lenD * 0.45, 0);
        stageGroups[i].localToWorld(local);
        const R = es.st.cluster.clusterR_m;
        const spacing = Math.max(1.5, R * 0.7);
        const from = lastTrailPos || local.clone();
        const dist = from.distanceTo(local);
        const n = Math.min(40, Math.max(1, Math.floor(dist / spacing)));
        const expand = 1 + 3 * (1 - air);               // thinner air → the puff balloons
        for (let k = 0; k < n; k++) {
            const p = from.clone().lerp(local, (k + Math.random()) / n);
            particles.emit({
                x: p.x + (Math.random() - 0.5) * R, y: p.y + (Math.random() - 0.5) * R, z: p.z + (Math.random() - 0.5) * R,
                vx: (Math.random() - 0.5) * 4, vy: (Math.random() - 0.5) * 4, vz: (Math.random() - 0.5) * 4,
                size0: R * 2.2, size1: R * (6 + 8 * smoke.grow) * expand,
                life: 7 + Math.random() * 5, color: smoke.color,
                alpha: smoke.alpha * Math.pow(air, 0.25) * Math.min(1, throttle + 0.3), drag: 0.3, buoy: 0.4,
            });
        }
        lastTrailPos = local;
    }

    // ── Camera ──────────────────────────────────────────────────────────────
    // Framing reads the STACK geometry, never Box3.setFromObject: that walks
    // invisible children too, and the plume cones would add tens of metres
    // of nothing below the vehicle.
    function attachedFrom() { return Math.max(0, stageGroups.findIndex((g) => g.parent === rocketRoot)); }
    function stackSpan() {
        const i0 = attachedFrom();
        const st = stack.stages[i0];
        const lo = st ? st.y0 - st.geo.bellLen_m : 0;
        return { lo, hi: stack.bodyLength_m, h: stack.bodyLength_m - lo };
    }
    function frameCamera() {
        if (!stack) return;
        const { lo, hi, h } = stackSpan();
        const center = rocketRoot.localToWorld(new THREE.Vector3(0, (lo + hi) / 2, 0));
        const dist = (Math.max(h, 10) / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.25;
        camera.position.set(center.x + dist * 0.62, center.y + h * 0.08, center.z + dist * 0.78);
        controls.target.copy(center);
        controls.update();
    }
    /** Views are relative to the vehicle's current pose (on the pad or in flight). */
    function setView(name) {
        if (!stack) return;
        const { lo, hi, h: span } = stackSpan();
        const center = rocketRoot.localToWorld(new THREE.Vector3(0, (lo + hi) / 2, 0));
        const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(rocketRoot.quaternion);
        const side = new THREE.Vector3(0, 0, 1);
        const right = new THREE.Vector3().crossVectors(axis, side).normalize();
        const h = Math.max(span, 10);
        const d = (h / 2) / Math.tan((camera.fov * Math.PI) / 360) * 1.2;
        let pos, target = center.clone();
        if (name === 'front') pos = center.clone().addScaledVector(side, d);
        else if (name === 'side') pos = center.clone().addScaledVector(right, -d);
        else if (name === 'top') pos = center.clone().addScaledVector(axis, d).addScaledVector(side, 0.01);
        else if (name === 'engines') {
            // Look up into the aft end: the cluster, the bells, the mount.
            const i0 = attachedFrom();
            const s0 = stack.stages[i0];
            const aft = new THREE.Vector3(0, s0.y0 - s0.geo.bellLen_m * 0.5, 0);
            stageGroups[i0].localToWorld(aft);
            const R = Math.max(s0.cluster.clusterR_m, s0.r);
            target = aft;
            if (!flight && i0 === 0 && padGeom) {
                // On the pad: a deck-level camera just outside the launch
                // table, mid-way between two legs, looking up into the cluster
                // UNDER the table ring (from any higher the ring hides the bells).
                const a = Math.PI / padGeom.legs;
                const rr = padGeom.outerR + Math.max(2, padGeom.holeR * 0.6);
                pos = new THREE.Vector3(Math.cos(a) * rr, DECK_TOP + 0.9, Math.sin(a) * rr);
                target = new THREE.Vector3(0, baseY - s0.geo.bellLen_m * 0.7, 0);
            } else {
                pos = aft.clone().addScaledVector(side, R * 3.2).addScaledVector(right, R * 1.6).addScaledVector(axis, -R * 1.4);
            }
        } else if (name === 'nose') {
            const top = stack.stages[stack.stages.length - 1];
            const rN = Math.max(top?.r || 2, 1);
            target = rocketRoot.localToWorld(new THREE.Vector3(0, stack.noseY0 + stack.noseLen * 0.45, 0));
            const dn = Math.max(stack.noseLen, rN * 4) * 1.6;
            pos = target.clone().addScaledVector(side, dn * 0.8).addScaledVector(right, -dn * 0.55).addScaledVector(axis, dn * 0.15);
        } else pos = center.clone().addScaledVector(side, d * 0.78).addScaledVector(right, -d * 0.62).addScaledVector(axis, h * 0.08);
        camera.position.copy(pos);
        controls.target.copy(target);
        controls.update();
    }

    // ── Static fire ─────────────────────────────────────────────────────────
    function setStaticFire(on) {
        if (flight) return;
        staticFire = !!on;
        setPlumes(0, staticFire);
        if (!staticFire) { applyGimbal(0, 0, 0); engineLight.intensity = 0; onPhase('idle'); }
        else onPhase('static-fire');
    }
    function padExpansion() {
        try { return currentDesign ? designStageExpansion01(currentDesign, 0, 0) : 0.35; } catch { return 0.35; }
    }

    // ── Flight ──────────────────────────────────────────────────────────────
    function launch(ascentResult) {
        staticFire = false;
        if (!ascentResult?.trajectory?.length || !stack) return Promise.resolve(ascentResult);
        rocketRoot.rotation.set(0, 0, 0);
        engineSets.forEach((_, i) => { setPlumes(i, false); applyGimbal(i, 0, 0); });
        const body = env.body;
        const events = flightEvents(ascentResult, currentDesign, body);
        onPhase('ignition');
        return new Promise((resolve) => {
            const focus = rocketFocusWorld();
            flight = {
                result: ascentResult, traj: ascentResult.trajectory, events,
                burn: ascentResult.trajectory[ascentResult.trajectory.length - 1].t || 1,
                t: -IGNITION_HOLD_S, resolve, detached: 0, fairingOff: false,
                lastPos: rocketRoot.position.clone(), vel: new THREE.Vector3(),
                focusY: focusLocalY(0), lastFocus: focus, phase: 'ignition',
                R: body.R_km * 1000, gSurf: (body.mu_km3s2 * 1e9) / Math.pow(body.R_km * 1000, 2),
            };
            lastTrailPos = null;
        });
    }

    /** Local-y of the middle of the stack still attached (stage `from` up). */
    function focusLocalY(from) {
        const st = stack.stages[from];
        if (!st) return stack.bodyLength_m / 2;
        const lo = st.y0 - st.geo.bellLen_m;
        return (lo + stack.bodyLength_m) / 2;
    }
    function rocketFocusWorld(yLocal) {
        const y = yLocal ?? (flight ? flight.focusY : stack.bodyLength_m / 2);
        return rocketRoot.localToWorld(new THREE.Vector3(0, y, 0));
    }

    function separateStage(i) {
        const g = stageGroups[i];
        if (!g || g.parent !== rocketRoot) return;
        setPlumes(i, false);
        scene.attach(g);
        const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(rocketRoot.quaternion);
        debris.push({
            obj: g, v: flight.vel.clone().addScaledVector(axis, -2.5),
            w: new THREE.Vector3((Math.random() - 0.5) * 0.06, (Math.random() - 0.5) * 0.04, (Math.random() - 0.5) * 0.08),
            ttl: 240, axisSpin: null,
        });
        rcsPuffT = 1.6;
        engineSets[i].glow = 0;
    }
    function jettisonFairing() {
        flight.fairingOff = true;
        const q = rocketRoot.quaternion;
        const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        const zAxis = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
        const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
        for (const h of noseParts.halves) {
            if (h.parent === scene) continue;
            scene.attach(h);
            const s = h.userData.side;
            debris.push({
                obj: h, v: flight.vel.clone().addScaledVector(xAxis, 3.5 * s).addScaledVector(axis, 0.6),
                w: new THREE.Vector3(), axisSpin: { axis: zAxis.clone(), rate: -0.5 * s }, ttl: 200,
            });
        }
        if (noseParts.les && noseParts.les.parent !== scene) {
            const les = noseParts.les;
            scene.attach(les);
            // The tower's own jettison motor fires it up and off to one side.
            debris.push({ obj: les, v: flight.vel.clone().addScaledVector(axis, 30).addScaledVector(xAxis, 8), w: new THREE.Vector3(0, 0, -0.4), ttl: 200 });
        }
        rcsPuffT = Math.max(rcsPuffT, 1.0);
    }

    function tickDebris(dtF) {
        if (!dtF || !debris.length || !flight) return;
        const C = new THREE.Vector3(0, -flight.R, 0);
        const keep = [];
        for (const d of debris) {
            const rel = d.obj.position.clone().sub(C);
            const r = rel.length();
            const g = rel.multiplyScalar(-flight.gSurf * flight.R * flight.R / (r * r * r));
            d.v.addScaledVector(g, dtF);
            d.obj.position.addScaledVector(d.v, dtF);
            if (d.axisSpin) {
                // Fairing halves hinge open (~100°) and then just drift.
                const spun = d.obj.userData.spun || 0;
                const step = d.axisSpin.rate * dtF * Math.max(0, 1 - spun / 1.8);
                d.obj.rotateOnWorldAxis(d.axisSpin.axis, step);
                d.obj.userData.spun = spun + Math.abs(step);
            }
            d.obj.rotation.x += d.w.x * dtF; d.obj.rotation.y += d.w.y * dtF; d.obj.rotation.z += d.w.z * dtF;
            d.ttl -= dtF;
            const far = d.obj.position.distanceTo(rocketRoot.position) > 40000;
            if (d.ttl <= 0 || far) d.obj.parent?.remove(d.obj);
            else keep.push(d);
        }
        debris = keep;
    }

    function tickFlight(dtWall, now) {
        const f = flight;
        if (f.t < 0) {
            // ── Ignition hold: engines light at T−3, spool, hold-downs release at T−0.
            f.t += dtWall;
            const spool = Math.min(1, Math.max(0, (f.t + IGNITION_HOLD_S - 0.3) / 1.4));
            if (spool > 0 && !engineSets[0].lit) setPlumes(0, true);
            const thr = spool * 0.9;
            tickEngines(0, now, thr, 0, padExpansion(), dtWall);
            applyGimbal(0, Math.sin(now * 9) * 0.04 * (1 - spool), Math.cos(now * 7) * 0.04 * (1 - spool));
            placeEngineLight(0, thr);
            emitGroundCloud(thr, dtWall);
            padArms.forEach((p) => { p.rotation.y = Math.min(1.2, p.rotation.y + dtWall * 0.8); });
            onTick({ phase: 'ignition', t: f.t, altKm: 0, vKms: 0, throttle: thr,
                     thrustMN: engineSets[0].fullThrust * thr / 1000 });
            return;
        }

        const rate = playbackRate(f.t, f.events, f.burn);
        const dtF = rate * dtWall;
        f.t = Math.min(f.burn, f.t + dtF);
        const s = sampleTrajectory(f.traj, f.t);
        const active = Math.max(1, s.stage || 1);

        // Spent stages go when the trajectory moves on to the next one.
        while (f.detached < active - 1 && f.detached < stageGroups.length - 1) {
            separateStage(f.detached);
            f.detached++;
            f.phase = 'staging';
        }
        const fairEv = f.events.find((e) => e.kind === 'fairing');
        if (fairEv && !f.fairingOff && f.t >= fairEv.t) { jettisonFairing(); onPhase('fairing sep'); }

        // Pose the vehicle on the real trajectory.
        const pose = poseAt(s, f.R, baseY);
        rocketRoot.position.set(pose.x, pose.y, 0);
        rocketRoot.rotation.set(0, 0, pose.rotZ);
        if (dtF > 1e-6) f.vel.copy(rocketRoot.position).sub(f.lastPos).divideScalar(dtF);
        f.lastPos.copy(rocketRoot.position);

        // Camera rig: re-centre the focus on the remaining stack (eased in the
        // vehicle's OWN frame — a re-centring, not a follow lag), then move
        // camera + target by exactly the focus's displacement.
        f.focusY += (focusLocalY(f.detached) - f.focusY) * Math.min(1, dtWall * 1.5);
        const focus = rocketFocusWorld(f.focusY);
        const delta = focus.clone().sub(f.lastFocus);
        camera.position.add(delta); controls.target.add(delta);
        f.lastFocus = focus;

        // Engines: only the stage the trajectory says is firing.
        const burning = (s.thrust_kN ?? 0) > 0.001 && !s.coasting;
        const iFire = active - 1;
        const es = engineSets[iFire];
        const thrVis = burning && es ? Math.max(0.55, Math.min(1.15, (s.thrust_kN || 0) / es.fullThrust)) : 0;
        engineSets.forEach((_, i) => {
            const on = burning && i === iFire;
            if (engineSets[i].lit !== on && stageGroups[i].parent === rocketRoot) setPlumes(i, on);
            tickEngines(i, now, on ? thrVis : 0, s.alt_km, s.expansion01, dtF);
        });
        // Guidance: a slow weave inside each engine's real gimbal range, plus
        // a downrange lean while the pitch program is turning the vehicle.
        if (es && burning) {
            const turning = (s.pitch_deg ?? 90) < 89.5 && (s.pitch_deg ?? 90) > 0.5 ? 1 : 0.3;
            applyGimbal(iFire, (Math.sin(f.t * 0.6) * 0.35) * es.gimbalRad * turning, Math.sin(f.t * 0.45 + 1.3) * 0.3 * es.gimbalRad);
        }
        placeEngineLight(iFire, burning ? thrVis : 0);

        // Smoke: ground cloud while the vehicle clears the pad; exhaust trail
        // while there is air to hold it.
        const air = airFraction(env.body, s.alt_km * 1000);
        if (s.alt_km < 0.25 && burning) emitGroundCloud(thrVis * (1 - s.alt_km / 0.25), dtWall);
        if (burning) emitTrail(iFire, air, thrVis); else lastTrailPos = null;

        padArms.forEach((p) => { p.rotation.y = Math.min(1.2, p.rotation.y + dtWall * 0.8); });
        tickDebris(dtF);

        let phase;
        if (s.coasting) phase = 'staging';
        else if (f.t < 6) phase = 'liftoff';
        else phase = active > 1 ? 'stage ' + active : 'ascent';
        if (phase !== f.phase) { f.phase = phase; onPhase(phase); }

        onTick({ phase: 'ascent', t: f.t, altKm: s.alt_km, vKms: s.v_kms,
                 throttle: burning ? (s.throttle ?? 1) : 0,
                 thrustMN: (s.thrust_kN ?? 0) / 1000, massFrac: s.mass_frac,
                 mach: s.mach, qkPa: s.q_kPa, reynolds: s.reynolds,
                 dragkN: s.drag_kN, dragFrictionkN: s.dragFriction_kN,
                 dragPressurekN: s.dragPressure_kN, dragWavekN: s.dragWave_kN,
                 boundaryLayer: s.boundaryLayer, regime: s.regime,
                 isp: s.isp_s, twr: s.twr, accelG: s.accel_g,
                 stage: s.stage, coasting: s.coasting, dvUsed: s.dv_used_kms,
                 pitchDeg: s.pitch_deg, downrangeKm: s.downrange_km, rate,
                 nozzleState: s.nozzleState, peOverPa: s.peOverPa,
                 exitMach: s.exitMach, separated: s.separated, expansion01: s.expansion01 });

        if (f.t >= f.burn - 1e-6) endFlight();
    }

    function endFlight() {
        const f = flight;
        engineSets.forEach((_, i) => setPlumes(i, false));
        engineLight.intensity = 0;
        flight = null;
        lastTrailPos = null;
        onPhase('meco');
        f?.resolve?.(f.result);
    }
    function abort() { if (flight) endFlight(); }

    function reset() {
        const was = flight; flight = null; staticFire = false;
        engineLight.intensity = 0;
        if (currentDesign) build(currentDesign);
        was?.resolve?.(was.result);
        onPhase('idle');
    }

    function tickStaticFire(now, dt) {
        const thr = clamp(currentDesign?.stages?.[0]?.throttle ?? 1, 0, 1);
        if (!engineSets[0]?.lit) setPlumes(0, true);
        tickEngines(0, now, thr, 0, padExpansion(), dt);
        placeEngineLight(0, thr);
        emitGroundCloud(thr, dt);
        // A Lissajous sweep across the engine's REAL gimbal range (a fixed
        // engine — Raptor Vacuum — honestly does not move).
        const lim = engineSets[0].gimbalRad;
        applyGimbal(0, Math.sin(now * 1.3) * lim * thr, Math.sin(now * 0.9 + 1.0) * lim * thr);
        onTick({ phase: 'static-fire', t: now, altKm: 0, vKms: 0, throttle: thr,
                 thrustMN: engineSets[0].fullThrust * thr / 1000 });
    }

    // ── Render loop ─────────────────────────────────────────────────────────
    let raf = 0, running = true, lastNow = 0;
    let timeScale = 1;                // test hook: 0 freezes the flight clock (captures on software GL)
    const clock = new THREE.Clock();
    let rcsPrev = 0;
    function render() {
        if (!running) return;
        raf = requestAnimationFrame(render);
        const now = clock.getElapsedTime();
        const dt = Math.min(0.25, Math.max(0, now - lastNow)) * timeScale;
        lastNow = now;
        if (autoRotate && !flight && !staticFire) rocketRoot.rotation.y += 0.0035;
        tickBeacons(padBeacons, now);
        if (flight) tickFlight(dt, now);
        else if (staticFire) tickStaticFire(now, dt);
        if (rcsPuffT > 0 || rcsPrev > 0) {
            rcsPuffT = Math.max(0, rcsPuffT - dt);
            const o = rcsPuffT > 0 ? (0.5 + 0.5 * Math.sin(now * 40)) * Math.min(1, rcsPuffT) * 0.8 : 0;
            for (const p of rcs) { p.material.opacity = o; p.scale.setScalar(0.6 + o); }
            rcsPrev = rcsPuffT;
        }
        controls.update();
        updateEnv();
        particles.update(dt, camera, renderer.domElement.height / renderer.getPixelRatio());
        renderer.render(scene, camera);
    }

    function resize() {
        const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 640;
        const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 480;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement || canvas);
    resize();
    render();

    function dispose() {
        running = false;
        cancelAnimationFrame(raf);
        ro.disconnect();
        controls.dispose();
        disposeRocket();
        padRoot.clear(); disposeSet(padOwned);
        particles.dispose();
        if (env) { env.sky.dispose(); env.stars.dispose(); env.planet.dispose(); env.ground.geometry.dispose(); env.ground.material.map?.dispose(); env.ground.material.dispose(); }
        renderer.dispose();
    }

    /** Test / inspection hook (tests/spaceship-designer-smoke.spec.js). */
    function debug() {
        rocketRoot.updateMatrixWorld(true);
        let lowestExit = Infinity;
        engineSets.forEach((es, i) => {
            if (stageGroups[i]?.parent !== rocketRoot) return;
            for (const p of es.pivots) {
                const v = new THREE.Vector3(0, -es.geo.bellLen_m, 0);
                p.localToWorld(v);
                if (i === 0) lowestExit = Math.min(lowestExit, v.y);
            }
        });
        return {
            stages: stageGroups.length,
            engines: engineSets.map((es) => es.pivots.length),
            lit: engineSets.map((es) => es.lit),
            attached: stageGroups.map((g) => g.parent === rocketRoot),
            fairingOff: noseParts.halves.length ? noseParts.halves.every((h) => h.parent !== rocketRoot && h.parent?.parent !== rocketRoot) : null,
            deckTop: DECK_TOP, mountTop: baseY, lowestStage1Exit: lowestExit,
            rocket: rocketRoot.position.toArray(), rotZ: rocketRoot.rotation.z,
            camToTarget: camera.position.distanceTo(controls.target),
            flightT: flight?.t ?? null, particles: particles.live,
            fog: scene.fog.density, near: camera.near, camPos: camera.position.toArray(),
        };
    }

    return {
        build, launch, abort, reset, setStaticFire,
        get isStaticFiring() { return staticFire; },
        setView,
        setAutoRotate: (v) => { autoRotate = !!v; },
        setTimeScale: (k) => { timeScale = Math.max(0, +k || 0); },
        debug, dispose,
        get design() { return currentDesign; },
    };
}

function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

/** Tiling greyscale mottling for the pad apron (multiplied by the body's ground
 *  colour). Cosmetic texture only — it encodes no terrain. */
function groundTexture() {
    const N = 256, c = document.createElement('canvas');
    c.width = c.height = N;
    const g = c.getContext('2d');
    g.fillStyle = '#d0d0d0'; g.fillRect(0, 0, N, N);
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let k = 0; k < 900; k++) {
        const x = rnd() * N, y = rnd() * N, r = 2 + rnd() * 18, v = 150 + rnd() * 105;
        g.fillStyle = `rgba(${v},${v},${v},0.35)`;
        for (const [dx, dy] of [[0, 0], [N, 0], [-N, 0], [0, N], [0, -N]]) { g.beginPath(); g.arc(x + dx, y + dy, r, 0, Math.PI * 2); g.fill(); }
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(400, 400);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
}
