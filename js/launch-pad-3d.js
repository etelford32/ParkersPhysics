/**
 * launch-pad-3d.js — Pluggable launch-pad geometry.
 *
 * Different rockets fly from very different ground infrastructure. This
 * module exposes one builder per pad style so the framework can swap pads
 * the same way it swaps vehicles. Each builder returns:
 *
 *   { root, beacons }
 *
 *   root      THREE.Group with the entire pad + tower + ground, base at y=0
 *   beacons   Array of { mesh, phase, color } — red/white aviation warning
 *             lights the framework's tick loop blinks at ~0.5 Hz
 *
 * Pad styles:
 *   'lc39a'        — KSC LC-39A: MLP deck, Fixed Service Structure (FSS),
 *                    crew-access arm, sound-suppression water tank,
 *                    Rotating Service Structure (retracted), 3 lightning
 *                    masts. Used for the Space Shuttle.
 *   'mechazilla'   — SpaceX Stage 0 / Boca Chica OLIT: Orbital Launch Mount
 *                    on 6 legs, integration tower with chopstick catch arms,
 *                    Quick-Disconnect (QD) arm, lightning rods, propellant
 *                    farm (4 cryo tanks). Used for Starship.
 *   'generic'      — Minimal MLP + lattice tower fallback for any vehicle
 *                    without a dedicated pad.
 *
 * Public API:
 *   buildPad(id, opts) → { root, beacons }
 */

import * as THREE from 'three';

// ── Materials ────────────────────────────────────────────────────────────────

const PAD_COLORS = {
    concrete:       0x3a3a40,
    concreteLight:  0x4f4f56,
    gravel:         0x2a2620,
    asphalt:        0x161618,
    fssOrange:      0xc15028,        // Florida-coast pad red-orange
    chopstickYellow:0xd0a020,        // Mechazilla yellow
    steel:          0xa8acb2,
    steelDark:      0x4a4e54,
    tankWhite:      0xe2e6ec,
    waterBlue:      0x1a2c44,
    beaconRed:      0xff2010,
    beaconWhite:    0xfff2c0,
    floodlight:     0xffe6a0,
    rust:           0x8a3a18,
};

function flatMat(color, roughness = 0.85, metalness = 0.05) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function steelMat(color = PAD_COLORS.steel, roughness = 0.55, metalness = 0.6) {
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function emissiveMat(color, intensity = 1.0) {
    return new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: intensity,
        roughness: 0.4,
        metalness: 0.0,
    });
}

// ── Procedural surface textures (launch planner pads) ───────────────────────
// Generated once per page and shared by every pad build (swapPad disposes
// materials, never these textures). Deterministic: a seeded PRNG, so the
// concrete looks identical on every load.
//
//   concrete — mottled slabs with expansion joints, oil stains, and a
//              radial blast scorch around the centre (where every launch
//              has scoured the deck).
//   gravel   — the crushed-stone apron, with an alpha that fades the disc
//              into the scene's terrain instead of ending on a hard edge.
//   truss    — an alpha-tested lattice for the big service-structure walls
//              that used to be solid slabs.
const _texCache = {};
function _rng(seed) {
    let s = seed;
    return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}
function _valueNoise(seed, G = 32) {
    const r = _rng(seed);
    const lat = new Float32Array(G * G).map(() => r());
    const lv = (x, y) => lat[((y % G) + G) % G * G + ((x % G) + G) % G];
    return (x, y) => {
        const xi = Math.floor(x), yi = Math.floor(y);
        let fx = x - xi, fy = y - yi;
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
        const a = lv(xi, yi), b = lv(xi + 1, yi), c = lv(xi, yi + 1), d = lv(xi + 1, yi + 1);
        return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
    };
}
function _canvasTex(c, color = true) {
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
}
function concreteTexture({ scorch = true } = {}) {
    const key = scorch ? 'concreteScorch' : 'concrete';
    if (_texCache[key]) return _texCache[key];
    const S = 1024;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S);
    const d = img.data;
    const n = _valueNoise(11, 64), r = _rng(5);
    const slab = S / 8;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        let v = 0, a = 0.5, f = 1 / 32;
        for (let o = 0; o < 5; o++) { v += a * n(x * f, y * f); f *= 2; a *= 0.5; }
        let g = 0.50 + (v - 0.5) * 0.30 + (r() - 0.5) * 0.06;
        // Per-slab tone so the grid reads.
        const sx = Math.floor(x / slab), sy = Math.floor(y / slab);
        g *= 0.93 + 0.10 * ((sx * 7 + sy * 13) % 5) / 4;
        // Expansion joints.
        const jx = x % slab, jy = y % slab;
        if (jx < 2 || jy < 2) g *= 0.55;
        if (scorch) {
            const dx = x / S - 0.5, dy = y / S - 0.5;
            const rr = Math.hypot(dx, dy);
            const burn = Math.exp(-rr * rr * 26) * (0.65 + 0.5 * v);
            g *= 1 - 0.72 * Math.min(1, burn);
        }
        const k = (y * S + x) * 4;
        d[k] = g * 255 * 1.00; d[k + 1] = g * 255 * 0.99; d[k + 2] = g * 255 * 0.96; d[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Oil / water stains.
    for (let i = 0; i < 26; i++) {
        const x = r() * S, y = r() * S, rad = 10 + r() * 50;
        const gr = ctx.createRadialGradient(x, y, 0, x, y, rad);
        gr.addColorStop(0, 'rgba(20,18,16,0.22)');
        gr.addColorStop(1, 'rgba(20,18,16,0)');
        ctx.fillStyle = gr;
        ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    return (_texCache[key] = _canvasTex(c));
}
function gravelTexture() {
    if (_texCache.gravel) return _texCache.gravel;
    const S = 512;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(S, S);
    const d = img.data;
    const n = _valueNoise(23, 32), r = _rng(9);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const v = 0.6 * n(x / 16, y / 16) + 0.4 * n(x / 5, y / 5);
        const g = 0.30 + 0.18 * v + (r() - 0.5) * 0.16;
        const k = (y * S + x) * 4;
        d[k] = g * 255; d[k + 1] = g * 0.95 * 255; d[k + 2] = g * 0.86 * 255; d[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const t = _canvasTex(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return (_texCache.gravel = t);
}
function radialFadeTexture() {
    if (_texCache.fade) return _texCache.fade;
    const S = 256;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    const gr = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0.00, '#fff');
    gr.addColorStop(0.70, '#fff');
    gr.addColorStop(1.00, '#000');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, S, S);
    return (_texCache.fade = _canvasTex(c, false));
}
function trussTexture() {
    if (_texCache.truss) return _texCache.truss;
    const S = 256;
    const c = document.createElement('canvas'); c.width = c.height = S;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, S, S);
    ctx.strokeStyle = '#fff';
    ctx.lineCap = 'square';
    // Chords (heavy) + diagonals (light), one bay per tile.
    ctx.lineWidth = 18;
    ctx.strokeRect(9, 9, S - 18, S - 18);
    ctx.lineWidth = 9;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(S, S); ctx.moveTo(S, 0); ctx.lineTo(0, S); ctx.stroke();
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(0, S / 2); ctx.lineTo(S, S / 2); ctx.stroke();
    const t = _canvasTex(c, false);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return (_texCache.truss = t);
}
function concreteMat(color = PAD_COLORS.concreteLight, { scorch = false, repeat = 1 } = {}) {
    const map = concreteTexture({ scorch });
    const m = new THREE.MeshStandardMaterial({ color, map, roughness: 0.92, metalness: 0.02 });
    if (repeat !== 1) {
        m.map = map.clone();
        m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
        m.map.repeat.set(repeat, repeat);
        m.map.needsUpdate = true;
    }
    return m;
}
// Lattice "wall" material for large service structures — the alpha-tested
// truss reads as open steelwork against the sky at any distance.
function trussMat(color, repeatX, repeatY) {
    const alphaMap = trussTexture().clone();
    alphaMap.repeat.set(repeatX, repeatY);
    alphaMap.needsUpdate = true;
    return new THREE.MeshStandardMaterial({
        color, alphaMap, alphaTest: 0.5, side: THREE.DoubleSide,
        roughness: 0.7, metalness: 0.2,
    });
}

// ── Shared sub-builders ──────────────────────────────────────────────────────

// Lattice column made from 4 corner tubes + diagonal cross-bracing every Δ m.
// Returns a Group rooted at (0,0,0), tower extends up +Y to y=height.
function buildLatticeTower({
    height,
    footprint = 6,
    color     = PAD_COLORS.fssOrange,
    diagonal  = true,
    bandStep  = 7,
}) {
    const g = new THREE.Group();
    const mat = flatMat(color, 0.7, 0.15);
    const beamGeo = new THREE.BoxGeometry(0.45, height, 0.45);
    const half = footprint / 2;

    // 4 corner columns
    for (const [dx, dz] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
        const col = new THREE.Mesh(beamGeo, mat);
        col.position.set(dx, height / 2, dz);
        col.castShadow = true;
        col.receiveShadow = true;
        g.add(col);
    }

    // Cross-bracing rings + optional diagonals
    const skinny = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.15 });
    function beam(p0, p1) {
        const v0 = new THREE.Vector3(...p0);
        const v1 = new THREE.Vector3(...p1);
        const len = v0.distanceTo(v1);
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, len), skinny);
        m.position.copy(v0).lerp(v1, 0.5);
        m.lookAt(v1);
        m.castShadow = true;
        g.add(m);
    }
    for (let y = bandStep; y < height; y += bandStep) {
        beam([-half, y, -half], [ half, y, -half]);
        beam([-half, y,  half], [ half, y,  half]);
        beam([-half, y, -half], [-half, y,  half]);
        beam([ half, y, -half], [ half, y,  half]);
        if (diagonal) {
            beam([-half, y - bandStep, -half], [ half, y, -half]);
            beam([-half, y - bandStep,  half], [ half, y,  half]);
            beam([-half, y - bandStep, -half], [-half, y,  half]);
            beam([ half, y - bandStep, -half], [ half, y,  half]);
        }
    }

    return g;
}

// Aviation warning beacon — small emissive sphere + tiny spike, returned
// alongside its phase so the framework can blink it. Beacons are usually
// visible from a long way off, so we cheat a bit on emissive intensity.
function buildBeacon({ color = PAD_COLORS.beaconRed, intensity = 2.0 } = {}) {
    const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(0.5, 12, 8),
        emissiveMat(color, intensity)
    );
    return sphere;
}

// Ground deck — concrete pad tile + surrounding gravel. Sized to feel
// "site-scale" so the camera sees real ground at all but the closest views.
function buildGroundPlane({ size = 320, padSize = 60, padColor = PAD_COLORS.concrete }) {
    const g = new THREE.Group();

    // Gravel apron. Its alpha fades to zero at the rim so the disc melts into
    // the scene terrain (js/launch-scene-fx.js) instead of ending on an edge.
    const gravel = gravelTexture().clone();
    gravel.repeat.set(size / 6, size / 6);
    gravel.needsUpdate = true;
    const terrain = new THREE.Mesh(
        new THREE.CircleGeometry(size, 64),
        new THREE.MeshStandardMaterial({
            color: 0xb8ae9c, map: gravel, alphaMap: radialFadeTexture(),
            transparent: true, depthWrite: false, roughness: 0.97, metalness: 0,
        })
    );
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = -0.25;
    terrain.receiveShadow = true;
    terrain.renderOrder = -1;
    g.add(terrain);

    // Inner pad — slabbed concrete, scorched at the centre.
    const pad = new THREE.Mesh(
        new THREE.CircleGeometry(padSize, 64),
        concreteMat(padColor === PAD_COLORS.concrete ? 0x9a9aa0 : padColor, { scorch: true })
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = -0.20;
    pad.receiveShadow = true;
    g.add(pad);

    // Concentric apron stripe (painted safety ring).
    const apron = new THREE.Mesh(
        new THREE.RingGeometry(padSize, padSize + 1.2, 96),
        new THREE.MeshStandardMaterial({ color: 0xb89a3a, roughness: 0.8 })
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.y = -0.19;
    apron.receiveShadow = true;
    g.add(apron);

    return g;
}

// Pole-mounted floodlight — used for perimeter and tower lighting. Returns a
// group with a pole, lamp head, and a faint halo sprite that reads as a
// light source when the camera is far away.
function buildFloodlight({ height = 18, color = PAD_COLORS.floodlight } = {}) {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.18, 0.22, height, 10),
        steelMat(PAD_COLORS.steelDark, 0.6, 0.4)
    );
    pole.position.y = height / 2;
    pole.castShadow = true;
    g.add(pole);

    const head = new THREE.Mesh(
        new THREE.BoxGeometry(1.4, 0.5, 1.0),
        steelMat(PAD_COLORS.steelDark, 0.4, 0.5)
    );
    head.position.set(0.5, height - 0.3, 0);
    head.castShadow = true;
    g.add(head);

    // HDR lamp face: linear radiance well above the bloom threshold so the
    // post chain gives each lamp its glow (the old 0.9-opacity sphere sat
    // below any threshold and read as a grey ball).
    const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 12, 8),
        new THREE.MeshBasicMaterial({
            color: new THREE.Color(color).multiplyScalar(6), transparent: true,
            opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
        })
    );
    halo.position.set(0.5, height - 0.3, 0);
    g.add(halo);
    g.name = 'Floodlight';
    g.userData.lampLocal = [0.5, height - 0.3, 0];

    return g;
}

// ── LC-39A (Space Shuttle) ───────────────────────────────────────────────────

function buildLC39A() {
    const root = new THREE.Group();
    root.name = 'LC-39A';
    const beacons = [];

    // Ground
    root.add(buildGroundPlane({ size: 280, padSize: 55 }));

    // Mobile Launcher Platform — square deck under the stack with a flame
    // trench slot. Taller than a generic deck (the real MLP is ~7.5 m).
    const mlpBase = new THREE.Mesh(
        new THREE.BoxGeometry(40, 4.2, 36),
        concreteMat(0x8e8e94, { scorch: true })
    );
    mlpBase.position.y = 2.1;
    mlpBase.castShadow = true;
    mlpBase.receiveShadow = true;
    root.add(mlpBase);

    // Flame trench cut — visible black opening below the SRB exhausts.
    const trench = new THREE.Mesh(
        new THREE.BoxGeometry(20, 5.0, 7),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    trench.position.y = 1.7;
    root.add(trench);

    // Hold-down posts on the deck — eight small concrete blocks where SRB
    // skirts and orbiter aft attach.
    for (const [x, z] of [[-7,-2],[-7,2],[7,-2],[7,2],[-2,-7],[-2,7],[2,-7],[2,7]]) {
        const post = new THREE.Mesh(
            new THREE.BoxGeometry(1.4, 0.8, 1.4),
            flatMat(PAD_COLORS.concrete, 0.9)
        );
        post.position.set(x, 4.4, z);
        post.castShadow = true;
        post.receiveShadow = true;
        root.add(post);
    }

    // Fixed Service Structure (FSS) — orange lattice tower NORTH of the
    // stack (we put it at -X). Real FSS is ~107 m; we use 92 m so it
    // doesn't dominate the camera frame.
    const fssH = 92;
    const fss = buildLatticeTower({ height: fssH, footprint: 7, color: PAD_COLORS.fssOrange });
    fss.position.set(-22, 4.2, 0);
    root.add(fss);

    // Crew-access arm — extends from FSS at orbiter cabin height (~64 m)
    // toward the stack. Retracted at T-7s in real ops; we draw it half-
    // extended for visual continuity with the orbiter.
    const cabArm = new THREE.Mesh(
        new THREE.BoxGeometry(15, 1.2, 1.6),
        flatMat(PAD_COLORS.fssOrange, 0.7, 0.1)
    );
    cabArm.position.set(-15, 4.2 + 64, 4);
    cabArm.castShadow = true;
    root.add(cabArm);

    // Crew-access room (the "white room" pod at the arm tip)
    const whiteRoom = new THREE.Mesh(
        new THREE.BoxGeometry(2.5, 2.5, 2.5),
        flatMat(0xeeeeee, 0.7)
    );
    whiteRoom.position.set(-7.5, 4.2 + 64, 4);
    whiteRoom.castShadow = true;
    root.add(whiteRoom);

    // GOX vent arm + "beanie cap" — at top of FSS, normally over the ET
    // nose during fueling. We park it retracted to the FSS.
    const gox = new THREE.Mesh(
        new THREE.ConeGeometry(2.2, 3.0, 16),
        flatMat(0xeeeeee, 0.7)
    );
    gox.position.set(-22, 4.2 + fssH - 6, 0);
    gox.castShadow = true;
    root.add(gox);

    // 3 lightning masts at the top of the FSS
    for (let i = 0; i < 3; i++) {
        const mast = new THREE.Mesh(
            new THREE.CylinderGeometry(0.10, 0.10, 16, 10),
            steelMat(PAD_COLORS.steelDark, 0.4, 0.7)
        );
        mast.position.set(-22 + (i - 1) * 3.2, 4.2 + fssH + 8, -2.5);
        mast.castShadow = true;
        root.add(mast);
    }

    // Rotating Service Structure (RSS) — large rectangular "barn" in
    // retracted position, swung 120° away from the stack. Drawn as a few
    // solid panels for visual mass.
    const rssH = 56;
    const rssBarn = new THREE.Group();
    const wall = (w, h, d, color = PAD_COLORS.fssOrange) =>
        new THREE.Mesh(new THREE.BoxGeometry(w, h, d), flatMat(color, 0.75));
    // The RSS is open steelwork, not a slab: an alpha-tested truss on a box
    // (one 4.5 m bay per texture tile) with a dark solid core behind it.
    const panel1 = new THREE.Mesh(new THREE.BoxGeometry(18, rssH, 8),
        trussMat(PAD_COLORS.fssOrange, 4, rssH / 4.5));
    const core = new THREE.Mesh(new THREE.BoxGeometry(14, rssH - 6, 4),
        flatMat(0x3a2a24, 0.9));
    core.position.set(0, rssH / 2, 0);
    core.castShadow = true;
    rssBarn.add(core);
    panel1.position.set(0, rssH / 2, 0);
    panel1.castShadow = true;
    panel1.receiveShadow = true;
    rssBarn.add(panel1);
    // RSS hinge column
    const rssHinge = wall(2.5, rssH + 4, 2.5, PAD_COLORS.fssOrange);
    rssHinge.position.set(-9, (rssH + 4) / 2, 4);
    rssHinge.castShadow = true;
    rssBarn.add(rssHinge);
    rssBarn.position.set(-32, 4.2, 24);
    rssBarn.rotation.y = Math.PI * 0.55;
    root.add(rssBarn);

    // Sound-suppression water tank — the iconic white sphere on stilts at
    // the south side of the pad. Fired ~1.1 million gallons of water
    // through pad outlets at T-6 to dampen acoustic energy.
    const wtFrame = new THREE.Group();
    const wtSphere = new THREE.Mesh(
        new THREE.SphereGeometry(8, 28, 18),
        flatMat(PAD_COLORS.tankWhite, 0.6, 0.1)
    );
    wtSphere.position.y = 22;
    wtSphere.castShadow = true;
    wtSphere.receiveShadow = true;
    wtFrame.add(wtSphere);
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const leg = new THREE.Mesh(
            new THREE.CylinderGeometry(0.3, 0.3, 18, 8),
            steelMat(PAD_COLORS.steelDark, 0.6, 0.3)
        );
        leg.position.set(Math.cos(a) * 4, 9, Math.sin(a) * 4);
        leg.castShadow = true;
        wtFrame.add(leg);
    }
    // Placed ~50° off the default 3/4 camera's axis (outside its 29° half
    // field) — at its old
    // (38, 22) spot the 16 m sphere filled the lower-right of the opening shot.
    wtFrame.position.set(-60, 0, 75);
    root.add(wtFrame);

    // Perimeter floodlights
    for (const [x, z] of [[-30, 30], [30, -30], [-50, -10], [50, 30]]) {
        const fl = buildFloodlight({ height: 18 });
        fl.position.set(x, 0, z);
        root.add(fl);
    }

    // Aviation warning beacons — top of FSS (red), top of RSS (red).
    const fssBeacon = buildBeacon({ color: PAD_COLORS.beaconRed });
    fssBeacon.position.set(-22, 4.2 + fssH + 17, -2.5);
    root.add(fssBeacon);
    beacons.push({ mesh: fssBeacon, phase: 0,    color: PAD_COLORS.beaconRed });

    const wtBeacon = buildBeacon({ color: PAD_COLORS.beaconRed });
    wtBeacon.position.set(-60, 30.2, 75);
    root.add(wtBeacon);
    beacons.push({ mesh: wtBeacon, phase: 1.5, color: PAD_COLORS.beaconRed });

    return { root, beacons };
}

// ── Mechazilla / Stage 0 (Starship) ──────────────────────────────────────────

function buildMechazilla(opts = {}) {
    const root = new THREE.Group();
    root.name = 'Mechazilla';
    const beacons = [];

    // Boca Chica: sandy ground, big concrete OLM apron in the middle.
    root.add(buildGroundPlane({
        size: 360, padSize: 70, padColor: PAD_COLORS.concrete,
    }));

    // OLM scaling: hole + table grow with the booster so a wider stack
    // doesn't collide with the table edge. Default sized for a 9 m
    // Starship; widens automatically for the 12 m future variant.
    const boosterR = (opts.boosterDiameter || 9.0) / 2;
    const holeR    = Math.max(4.0, boosterR * 0.7);          // accommodates engine cluster
    const olmRingR = Math.max(9.0, boosterR * 1.5);          // hex table outer radius

    // Orbital Launch Mount (OLM) — 6-legged hexagonal table the booster
    // sits on. Real OLM legs are ~20 m tall.
    const olmH = 20;
    const olm = new THREE.Group();
    // 6 legs
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
        const leg = new THREE.Mesh(
            new THREE.CylinderGeometry(0.7, 0.9, olmH, 12),
            flatMat(PAD_COLORS.fssOrange, 0.7, 0.15)
        );
        leg.position.set(Math.cos(a) * (olmRingR - 1.2), olmH / 2, Math.sin(a) * (olmRingR - 1.2));
        leg.castShadow = true;
        leg.receiveShadow = true;
        olm.add(leg);
    }
    // Hexagonal table top (with a hole in the middle for booster engine plume)
    const tableShape = new THREE.Shape();
    for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const x = Math.cos(a) * olmRingR;
        const z = Math.sin(a) * olmRingR;
        if (i === 0) tableShape.moveTo(x, z); else tableShape.lineTo(x, z);
    }
    tableShape.closePath();
    const hole = new THREE.Path();
    hole.absarc(0, 0, holeR, 0, Math.PI * 2, true);
    tableShape.holes.push(hole);
    const tableGeo = new THREE.ExtrudeGeometry(tableShape, { depth: 1.4, bevelEnabled: false });
    const table = new THREE.Mesh(tableGeo, flatMat(PAD_COLORS.fssOrange, 0.7, 0.15));
    table.rotation.x = -Math.PI / 2;
    table.position.y = olmH;
    table.castShadow = true;
    table.receiveShadow = true;
    olm.add(table);

    // Hold-down clamps — 20 small posts around the inner ring of the table,
    // hugging the booster's outer radius rather than a fixed circle so they
    // line up with the booster aft skirt regardless of variant.
    const clampR = boosterR * 1.04;
    for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        const clamp = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.7, 0.5),
            steelMat(PAD_COLORS.steelDark, 0.5, 0.5)
        );
        clamp.position.set(Math.cos(a) * clampR, olmH + 1.7, Math.sin(a) * clampR);
        clamp.castShadow = true;
        olm.add(clamp);
    }

    // Cross-bracing between OLM legs (X-pattern)
    const braceMat = flatMat(PAD_COLORS.fssOrange, 0.7, 0.15);
    for (let i = 0; i < 6; i++) {
        const a0 = (i / 6) * Math.PI * 2 + Math.PI / 6;
        const a1 = ((i + 1) / 6) * Math.PI * 2 + Math.PI / 6;
        const r = olmRingR - 1.2;
        const v0 = new THREE.Vector3(Math.cos(a0) * r, 4, Math.sin(a0) * r);
        const v1 = new THREE.Vector3(Math.cos(a1) * r, 16, Math.sin(a1) * r);
        const v2 = new THREE.Vector3(Math.cos(a0) * r, 16, Math.sin(a0) * r);
        const v3 = new THREE.Vector3(Math.cos(a1) * r, 4, Math.sin(a1) * r);
        for (const [p0, p1] of [[v0, v1], [v2, v3]]) {
            const len = p0.distanceTo(p1);
            const beam = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, len), braceMat);
            beam.position.copy(p0).lerp(p1, 0.5);
            beam.lookAt(p1);
            beam.castShadow = true;
            olm.add(beam);
        }
    }

    olm.position.y = 0;
    root.add(olm);

    // Water deluge plate — flat steel plate at the base under the OLM,
    // sized just past the hole so it catches the full booster exhaust.
    const delugeR = Math.max(7, holeR + 3);
    const deluge = new THREE.Mesh(
        new THREE.CylinderGeometry(delugeR, delugeR, 0.5, 32),
        flatMat(PAD_COLORS.steel, 0.4, 0.6)
    );
    deluge.position.y = 0.25;
    deluge.receiveShadow = true;
    root.add(deluge);

    // Mechazilla integration tower — square lattice tower on the +X side,
    // Z-aligned so the chopstick arms reach toward the stack at origin.
    const mtH = 145;             // real OLIT is ~146 m
    const towerX = -16;          // tower offset; chopsticks extend toward +X
    const tower = buildLatticeTower({
        height: mtH, footprint: 8, color: PAD_COLORS.fssOrange, bandStep: 9,
    });
    tower.position.set(towerX, 0, 0);
    root.add(tower);

    // Chopstick arms (Mechazilla) — 2 horizontal yellow arms reaching from
    // the tower toward the stack at ~booster-catch height (~80 m).
    const armColor = PAD_COLORS.chopstickYellow;
    const armMat = flatMat(armColor, 0.55, 0.2);
    function buildChopstickArm(z, swingRad) {
        const arm = new THREE.Group();
        // Spine — long box from hinge outboard
        const spine = new THREE.Mesh(new THREE.BoxGeometry(20, 1.2, 1.8), armMat);
        spine.position.set(10, 0, 0);
        spine.castShadow = true;
        arm.add(spine);
        // Pincer pad at the tip
        const pad = new THREE.Mesh(new THREE.BoxGeometry(2.0, 1.6, 4.5), armMat);
        pad.position.set(19.5, 0, 0);
        pad.castShadow = true;
        arm.add(pad);
        // Hinge box at the tower side
        const hinge = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 2.5), armMat);
        hinge.position.set(0.5, 0, 0);
        hinge.castShadow = true;
        arm.add(hinge);
        // Z-axis offset (one arm in -Z, other in +Z) and swung outboard so
        // the spine doesn't ghost through the booster while it sits on the
        // OLM. Real chopsticks swing ~60° away from the catch axis when the
        // stack is integrated and waiting for launch.
        arm.position.set(towerX + 4, 80, z);
        arm.rotation.y = swingRad;
        return arm;
    }
    root.add(buildChopstickArm(-3.5, -1.05));   // swung -Z away from rocket
    root.add(buildChopstickArm( 3.5,  1.05));   // mirror

    // Quick-Disconnect (QD) arm — slimmer arm at ship hot-stage-ring height
    // (~95 m) for ship fuel/electrical umbilicals. Sized so the umbilical
    // head reaches the ship surface (~4.5 m from rocket axis) without the
    // spine punching through the ship body. Hinged at the inboard tower
    // face, length = tower-edge to ship-surface = ~10 m.
    const qd = new THREE.Group();
    const qdSpine = new THREE.Mesh(new THREE.BoxGeometry(10, 1.0, 1.4), armMat);
    qdSpine.position.set(5, 0, 0);
    qdSpine.castShadow = true;
    qd.add(qdSpine);
    const qdHead = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 2.2), armMat);
    qdHead.position.set(10.2, 0, 0);
    qdHead.castShadow = true;
    qd.add(qdHead);
    qd.position.set(towerX + 4, 95, 0);
    qd.rotation.y = -0.18;       // partially swung away
    root.add(qd);

    // Lightning rods — 4 thin spikes on top of the tower
    for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const rod = new THREE.Mesh(
            new THREE.CylinderGeometry(0.10, 0.10, 18, 10),
            steelMat(PAD_COLORS.steelDark, 0.4, 0.7)
        );
        rod.position.set(towerX + Math.cos(a) * 3, mtH + 9, Math.sin(a) * 3);
        rod.castShadow = true;
        root.add(rod);
    }

    // Propellant farm — 4 vertical cryo tanks NW of the OLM. Real Stage 0
    // has many more (subcoolers, vents, etc.), but a quartet reads cleanly.
    function buildCryoTank({ height, radius, color }) {
        const g = new THREE.Group();
        const body = new THREE.Mesh(
            new THREE.CylinderGeometry(radius, radius, height, 28),
            flatMat(color, 0.55, 0.1)
        );
        body.position.y = height / 2 + 1.2;
        body.castShadow = true;
        body.receiveShadow = true;
        g.add(body);
        // Domed top + bottom
        const dome = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2),
            flatMat(color, 0.55, 0.1)
        );
        dome.position.y = height + 1.2;
        dome.castShadow = true;
        g.add(dome);
        const dome2 = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2),
            flatMat(color, 0.55, 0.1)
        );
        dome2.position.y = 1.2;
        dome2.rotation.x = Math.PI;
        dome2.castShadow = true;
        g.add(dome2);
        // Slim support stand
        const stand = new THREE.Mesh(
            new THREE.CylinderGeometry(radius * 0.4, radius * 0.5, 1.4, 12),
            flatMat(PAD_COLORS.steelDark, 0.7)
        );
        stand.position.y = 0.7;
        stand.castShadow = true;
        g.add(stand);
        return g;
    }

    const tankSpecs = [
        { x: 50,  z: -25, h: 24, r: 5, c: PAD_COLORS.tankWhite },     // LOX (largest)
        { x: 60,  z:  -8, h: 22, r: 4.5, c: PAD_COLORS.tankWhite },   // CH4
        { x: 50,  z:  18, h: 18, r: 4, c: PAD_COLORS.tankWhite },     // LN2
        { x: 38,  z:  35, h: 14, r: 3.2, c: PAD_COLORS.tankWhite },   // helium
    ];
    for (const s of tankSpecs) {
        const tank = buildCryoTank({ height: s.h, radius: s.r, color: s.c });
        tank.position.set(s.x, 0, s.z);
        root.add(tank);

        // Each tank gets a small red beacon at its dome.
        const tb = buildBeacon({ color: PAD_COLORS.beaconRed, intensity: 1.5 });
        tb.position.set(s.x, s.h + 2.5, s.z);
        tb.scale.setScalar(0.6);
        root.add(tb);
        beacons.push({ mesh: tb, phase: Math.random() * Math.PI * 2, color: PAD_COLORS.beaconRed });
    }

    // Tower-top + tower-mid aviation beacons (red, blinking out of phase).
    const topBeacon = buildBeacon({ color: PAD_COLORS.beaconRed, intensity: 2.5 });
    topBeacon.position.set(towerX, mtH + 4, 0);
    topBeacon.scale.setScalar(1.2);
    root.add(topBeacon);
    beacons.push({ mesh: topBeacon, phase: 0, color: PAD_COLORS.beaconRed });

    const midBeacon = buildBeacon({ color: PAD_COLORS.beaconWhite, intensity: 1.6 });
    midBeacon.position.set(towerX, mtH * 0.5, 4.5);
    root.add(midBeacon);
    beacons.push({ mesh: midBeacon, phase: 1.0, color: PAD_COLORS.beaconWhite });

    // Perimeter floodlights — taller than LC-39A's; Boca Chica uses
    // tall poles around the launch table.
    for (const [x, z] of [[-40, 40], [40, -40], [-40, -30], [55, 35], [25, -55]]) {
        const fl = buildFloodlight({ height: 22 });
        fl.position.set(x, 0, z);
        root.add(fl);
    }

    return { root, beacons };
}

// ── Falcon TEL pad (SLC-40 / LC-39A Falcon configuration) ────────────────────
// Falcon 9 launches from a comparatively spartan deck: a flat concrete pad,
// a vertical strongback (Transporter-Erector-Launcher) on one side carrying
// the umbilical Ts, four lightning conductor towers at the perimeter, and a
// flame trench beneath the booster. No FSS, no rotating service structure —
// SpaceX integrates horizontally and erects right before launch.

function buildFalconTEL() {
    const root = new THREE.Group();
    root.name = 'FalconTEL';
    const beacons = [];

    root.add(buildGroundPlane({ size: 280, padSize: 50, padColor: PAD_COLORS.concrete }));

    // Pad deck — modest concrete platform under the booster. Top is at
    // y=4.2 to match the rest of the launch-planner's vehicle baseline.
    const deck = new THREE.Mesh(
        new THREE.BoxGeometry(22, 4.2, 22),
        concreteMat(0x8e8e94, { scorch: true })
    );
    deck.position.y = 2.1;
    deck.castShadow = true;
    deck.receiveShadow = true;
    root.add(deck);

    // Flame trench — narrow black slot under the octaweb, centered.
    const trench = new THREE.Mesh(
        new THREE.BoxGeometry(7, 5.0, 7),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    trench.position.y = 1.7;
    root.add(trench);

    // Hold-down clamps — 4 small steel posts at the corners of a square
    // sized for the Falcon 9's 3.66 m booster (Falcon Heavy mates with
    // additional clamps off-pad-axis, but a single set reads fine).
    const clampMat = steelMat(PAD_COLORS.steelDark, 0.4, 0.55);
    for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const clamp = new THREE.Mesh(
            new THREE.BoxGeometry(0.55, 0.9, 0.55),
            clampMat
        );
        clamp.position.set(Math.cos(a) * 2.5, 4.65, Math.sin(a) * 2.5);
        clamp.castShadow = true;
        root.add(clamp);
    }

    // Strongback (Transporter-Erector) — tall vertical truss on -Z (south)
    // running from deck to ~payload-fairing height. Real strongback is on
    // the side away from the wind; we put it on -Z so it's visible from a
    // 3/4 view without occluding the rocket from the camera-facing side.
    const sbX = 0;
    const sbZ = -3.5;          // a couple metres clear of the booster (R≈1.83)
    const sbH = 60;            // top reaches ~S2 / fairing seam
    const sb = buildLatticeTower({
        height: sbH, footprint: 3.4, color: PAD_COLORS.fssOrange, bandStep: 8,
    });
    sb.position.set(sbX, 4.2, sbZ);
    root.add(sb);

    // Strongback hinge cradle — squat box at the base, in line with the
    // erector pivot.
    const hinge = new THREE.Mesh(
        new THREE.BoxGeometry(5.2, 1.6, 4.4),
        flatMat(PAD_COLORS.fssOrange, 0.55)
    );
    hinge.position.set(sbX, 5.0, sbZ - 0.6);
    hinge.castShadow = true;
    root.add(hinge);

    // Umbilical Ts — horizontal yellow arms from the strongback toward the
    // rocket. One at booster aft (+5 m above deck), one at S2 (+45 m), one
    // at fairing/Dragon (+55 m). Each arm tip stops just shy of the rocket
    // so it reads as "connected" without z-fighting.
    const umbMat = flatMat(PAD_COLORS.chopstickYellow, 0.6, 0.2);
    function buildUmb(yWorld, length, headW = 1.6, headH = 1.2) {
        const arm = new THREE.Group();
        const spine = new THREE.Mesh(
            new THREE.BoxGeometry(0.6, 0.6, length),
            umbMat
        );
        spine.position.z = length / 2;
        spine.castShadow = true;
        arm.add(spine);
        const head = new THREE.Mesh(
            new THREE.BoxGeometry(headW, headH, 0.9),
            umbMat
        );
        head.position.z = length;
        head.castShadow = true;
        arm.add(head);
        arm.position.set(sbX, yWorld, sbZ + 0.6);
        return arm;
    }
    // sbZ = -3.5; rocket surface at z=-1.83. Arm length ≈ 1.0 m so head
    // sits at z ≈ -2.5, just outside the rocket.
    root.add(buildUmb(4.2 +  6, 1.1));     // booster aft umbilical
    root.add(buildUmb(4.2 + 42, 1.0));     // interstage / S2
    root.add(buildUmb(4.2 + 56, 0.9));     // fairing / Dragon

    // Four lightning conductor towers spaced around the pad perimeter — thin
    // tall lattices each capped with a red aviation beacon. (Real SLC-40 has
    // four such towers; LC-39A inherited similar protection during the
    // Falcon era.)
    //
    // PLACEMENT IS A FRAMING DECISION (2026-11). They used to stand 70 m out
    // on the 45° diagonals — and the default 3/4 camera looks down the +x/+z
    // diagonal, so one 95 m tower stood squarely between the camera and the
    // rocket (and cut through the exhaust cloud at liftoff) while the other
    // three framed the stack like a cage. At LT_AZIMUTHS_DEG / LT_RADIUS every
    // preset sightline (side 0°, 3/4 ≈ 56°, wide ≈ 54°, front 90°) clears the
    // nearest tower by ≥ 38° of azimuth — outside the frame's horizontal
    // half-angle (~29° at 38° FOV on a 16:10 stage) — so they read as
    // perimeter context in Wide and are out of shot in the close views.
    // They cast NO shadow: from the spot key their 95 m shadows streaked the
    // whole apron and read as clutter, not structure.
    const LT_RADIUS = 110;
    const LT_HEIGHT = 95;
    const LT_AZIMUTHS_DEG = [20, 110, 200, 290];
    LT_AZIMUTHS_DEG.forEach((deg, i) => {
        const a = deg * Math.PI / 180;
        const x = Math.cos(a) * LT_RADIUS, z = Math.sin(a) * LT_RADIUS;
        const lt = buildLatticeTower({
            height: LT_HEIGHT, footprint: 3.0, color: PAD_COLORS.steelDark, bandStep: 11,
        });
        lt.traverse((o) => { if (o.isMesh) o.castShadow = false; });
        lt.position.set(x, 0, z);
        root.add(lt);

        // Concrete footing so a tower this far out stands on something.
        const footing = new THREE.Mesh(
            new THREE.BoxGeometry(5.5, 0.8, 5.5),
            concreteMat(0x85858a)
        );
        footing.position.set(x, 0.15, z);
        footing.receiveShadow = true;
        root.add(footing);

        const tip = new THREE.Mesh(
            new THREE.CylinderGeometry(0.12, 0.12, 12, 10),
            steelMat(PAD_COLORS.steelDark, 0.4, 0.7)
        );
        tip.position.set(x, LT_HEIGHT + 6, z);
        root.add(tip);

        const beaconM = buildBeacon({ color: PAD_COLORS.beaconRed, intensity: 1.8 });
        beaconM.position.set(x, LT_HEIGHT + 13, z);
        root.add(beaconM);
        beacons.push({ mesh: beaconM, phase: i * 0.6, color: PAD_COLORS.beaconRed });
    });

    // Strongback-top beacon
    const sbBeacon = buildBeacon({ color: PAD_COLORS.beaconRed, intensity: 2.0 });
    sbBeacon.position.set(sbX, 4.2 + sbH + 1, sbZ);
    root.add(sbBeacon);
    beacons.push({ mesh: sbBeacon, phase: 0.3, color: PAD_COLORS.beaconRed });

    // Two ground floodlights flanking the deck to throw a little ambient
    // illumination onto the booster aft.
    for (const xs of [-1, 1]) {
        const fl = buildFloodlight({ height: 14 });
        fl.position.set(xs * 14, 0, 8);
        fl.rotation.y = -xs * Math.PI / 2.4;
        root.add(fl);
    }

    return { root, beacons };
}


function buildGenericPad() {
    const root = new THREE.Group();
    root.name = 'GenericPad';
    const beacons = [];

    root.add(buildGroundPlane({ size: 240, padSize: 50 }));

    const mlp = new THREE.Mesh(
        new THREE.BoxGeometry(34, 1.4, 34),
        flatMat(PAD_COLORS.concrete, 0.95)
    );
    mlp.position.y = 0.7;
    mlp.castShadow = true;
    mlp.receiveShadow = true;
    root.add(mlp);

    const trench = new THREE.Mesh(
        new THREE.BoxGeometry(8, 1.6, 4),
        new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    trench.position.y = 0.7;
    root.add(trench);

    const tower = buildLatticeTower({ height: 80, footprint: 7, color: PAD_COLORS.fssOrange });
    tower.position.set(-22, 1.4, 0);
    root.add(tower);

    const beacon = buildBeacon({ color: PAD_COLORS.beaconRed });
    beacon.position.set(-22, 84, 0);
    root.add(beacon);
    beacons.push({ mesh: beacon, phase: 0, color: PAD_COLORS.beaconRed });

    return { root, beacons };
}

// ── Public dispatcher ────────────────────────────────────────────────────────

const PAD_BUILDERS = {
    lc39a:       buildLC39A,
    mechazilla:  buildMechazilla,
    falcon_tel:  buildFalconTEL,
    generic:     buildGenericPad,
};

// Sub-builders exported (2026-10) for the Space Ship Designer, which builds
// its own launch mount sized to an arbitrary vehicle but keeps the site's
// tower + beacon look. Exporting them changes nothing for the pads above.
export { buildLatticeTower, buildBeacon, PAD_COLORS };

// opts: optional builder hints — { boosterDiameter } adapts shared geometry
// like the OLM table hole so a wider booster (e.g. the 12 m future Starship
// concept) doesn't collide with the table. Each pad builder may ignore or
// honor opts; unsupported builders just receive no argument.
export function buildPad(id = 'generic', opts = {}) {
    const builder = PAD_BUILDERS[id] || PAD_BUILDERS.generic;
    return builder(opts);
}

// Animate beacons — call from the framework's tick loop with current time t
// (seconds). Each beacon pulses every ~2 s (0.5 Hz) with its own phase.
export function tickBeacons(beacons, t) {
    if (!beacons || !beacons.length) return;
    for (const b of beacons) {
        if (!b.mesh.material) continue;
        const v = (Math.sin(t * Math.PI + b.phase) + 1) * 0.5;     // 0..1
        const lit = v > 0.85 ? 1 : 0.05;                           // crisp blink
        // `gain` (optional, default 1) lets an HDR host push the lit state past
        // its bloom threshold; the Space Ship Designer passes none.
        b.mesh.material.emissiveIntensity = (0.3 + lit * 2.5) * (b.gain ?? 1);
        b.mesh.scale.setScalar(0.85 + lit * 0.6);
    }
}
