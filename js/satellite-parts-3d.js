/**
 * satellite-parts-3d.js — what every Design Bay component LOOKS like
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Mesh factory for the Satellite Designer. THREE is injected (no import) so
 * the module costs nothing until a page has three.js loaded. It draws ONLY
 * what js/satellite-layout.js placed — one THREE.Group per layout part,
 * tagged with userData.partId — so the picture, the centre of mass and the
 * engineering review are three views of one placement.
 *
 * Fidelity notes (what each part is modelled on):
 *   bus skin       crinkled MLI blankets with stitched seams (gold Al-Kapton,
 *                  silver Ag-Teflon, black Kapton) or paint / anodise; OSR
 *                  mirror-tile radiators; CubeSat hard-anodised corner rails;
 *                  a clamp-band launch-adapter ring on the aft deck
 *   solar arrays   GaAs triple-junction cells (cropped corners, busbars) on
 *                  honeycomb panels with hinges, yoke and drive (SADA); ROSA /
 *                  thin-film blankets on booms with the roll-out mandrel
 *   thrusters      Rao-style bell nozzles (lathed) with valves and catalyst
 *                  bed / gimballed biprop head; Hall thrusters with the
 *                  annular ceramic channel, centre pole and external hollow
 *                  cathode; gridded-ion domes with perforated molybdenum grids
 *   tanks          titanium spheres with girth ring and tabs; carbon-overwrap
 *                  COPVs with polar bosses
 *   ADCS           wheel pyramids (4 at 54.7°), CMG gimbals, magnetorquer rods
 *   comms          patch radomes, X-band patch arrays and horns, a gimballed
 *                  parabolic Ka dish, an optical terminal on a fork mount, a
 *                  UHF tape turnstile
 *
 * Public surface:
 *   buildSatellite(THREE, build, opts) → Group  (opts: tierMods, envMap)
 *   setViewMode(group, 'real'|'subsystem'|'xray')
 *   setExplode(group, t∈[0,1])
 *   setHighlight(group, partId|null, hoverId|null)
 *   partIdOf(object3D) → partId | null
 *   studioEnvironment(THREE, renderer) → PMREM texture (cached per renderer)
 *   disposeSatellite(group)
 *
 * Textures are procedural canvases, generated once per THREE instance and
 * SHARED (never disposed with a build — the flight scene rebuilds the craft
 * on every bay edit). UV scale is applied per geometry so a cell is 4 × 7 cm
 * on every panel regardless of panel size.
 */

import { layoutBuild, thrusterLength, adapterRing } from './satellite-layout.js';
import { SUBSYSTEMS, TANKS, ADCS_UNITS, bodyClass, faceGeometry } from './satellite-components.js';
import { BODIES } from './satellite-builder.js';

// ── Procedural textures ─────────────────────────────────────────────────────
const TEX_CACHE = new WeakMap();
const CELL_TILE = [0.32, 0.28];     // metres covered by one cells-texture tile (8 × 4 cells)
const MLI_TILE = 0.7;
const OSR_TILE = 0.4;

function rng(seed) {
    let s = seed >>> 0;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
function canvas(w, h = w) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d')];
}

function texCells(variant = 'gaas') {
    const [c, g] = canvas(512, 512);
    const R = rng(variant === 'gaas' ? 7 : 11);
    g.fillStyle = variant === 'film' ? '#3a2410' : '#5d636c';
    g.fillRect(0, 0, 512, 512);
    const cols = 8, rows = 4, cw = 512 / cols, ch = 512 / rows, gap = 2, bev = 8;
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const x = i * cw + gap, y = j * ch + gap, w = cw - 2 * gap, h = ch - 2 * gap;
        g.save();
        g.beginPath();
        g.moveTo(x + bev, y); g.lineTo(x + w - bev, y); g.lineTo(x + w, y + bev);
        g.lineTo(x + w, y + h - bev); g.lineTo(x + w - bev, y + h); g.lineTo(x + bev, y + h);
        g.lineTo(x, y + h - bev); g.lineTo(x, y + bev); g.closePath();
        g.clip();
        const t = R() * 0.08;
        const grd = g.createLinearGradient(x, y, x + w, y + h);
        if (variant === 'film') {
            grd.addColorStop(0, `rgb(${60 + t * 200 | 0},${38 + t * 80 | 0},${24})`);
            grd.addColorStop(1, `rgb(${92 + t * 200 | 0},${58 + t * 80 | 0},${30})`);
        } else {
            grd.addColorStop(0, `rgb(${12 + t * 60 | 0},${24 + t * 90 | 0},${58 + t * 120 | 0})`);
            grd.addColorStop(0.55, `rgb(${22 + t * 60 | 0},${40 + t * 90 | 0},${92 + t * 120 | 0})`);
            grd.addColorStop(1, `rgb(${14 + t * 60 | 0},${28 + t * 90 | 0},${66 + t * 120 | 0})`);
        }
        g.fillStyle = grd; g.fillRect(x, y, w, h);
        // Grid fingers.
        g.strokeStyle = 'rgba(190,210,240,0.10)'; g.lineWidth = 1;
        for (let yy = y + 5; yy < y + h; yy += 5) { g.beginPath(); g.moveTo(x, yy); g.lineTo(x + w, yy); g.stroke(); }
        g.restore();
        // Busbar along the top edge.
        g.fillStyle = 'rgba(200,206,214,0.55)';
        g.fillRect(x + bev, y + 1, w - 2 * bev, 2);
    }
    return c;
}
function texPanelBack() {
    const [c, g] = canvas(256);
    g.fillStyle = '#d4d6da'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(120,128,138,0.25)'; g.lineWidth = 1;
    for (let i = 0; i <= 256; i += 16) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
        g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
    }
    g.fillStyle = 'rgba(60,64,70,0.55)';
    g.fillRect(0, 120, 256, 10);                     // harness tape
    g.fillStyle = 'rgba(190,150,60,0.6)';
    g.fillRect(40, 0, 6, 256);
    return c;
}
/** MLI: crinkled foil. Returns [colour canvas, height canvas]. */
function texMli(tint) {
    const S = 512;
    const [hc, h] = canvas(S);
    const R = rng(99);
    h.fillStyle = '#c8c8c8'; h.fillRect(0, 0, S, S);
    for (let k = 0; k < 1100; k++) {
        const x = R() * S, y = R() * S, r = 8 + R() * 38;
        const v = 150 + R() * 105 | 0;
        h.fillStyle = `rgba(${v},${v},${v},0.4)`;
        h.beginPath();
        const n = 3 + (R() * 3 | 0);
        for (let q = 0; q < n; q++) {
            const a = q / n * Math.PI * 2 + R() * 0.8;
            const rr = r * (0.5 + R() * 0.6);
            const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
            q ? h.lineTo(px, py) : h.moveTo(px, py);
        }
        h.closePath(); h.fill();
    }
    const [cc, g] = canvas(S);
    g.drawImage(hc, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = tint; g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'source-over';
    // Stitched seams and tape patches.
    for (const yy of [S * 0.33, S * 0.83]) {
        g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, yy - 6, S, 12);
        g.strokeStyle = 'rgba(255,255,255,0.35)'; g.setLineDash([6, 6]); g.lineWidth = 1.5;
        g.beginPath(); g.moveTo(0, yy); g.lineTo(S, yy); g.stroke();
    }
    g.setLineDash([]);
    g.fillStyle = 'rgba(255,255,255,0.10)';
    g.fillRect(S * 0.62, S * 0.5, 34, 34);
    g.fillRect(S * 0.12, S * 0.06, 24, 24);
    return [cc, hc];
}
function texOsr() {
    const [c, g] = canvas(512);
    const R = rng(3);
    const n = 16, t = 512 / n;
    g.fillStyle = '#4b5058'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const v = 205 + R() * 40 | 0;
        g.fillStyle = `rgb(${v},${v + 3},${v + 8})`;
        g.fillRect(i * t + 1.5, j * t + 1.5, t - 3, t - 3);
    }
    return c;
}
function texCarbon() {
    const [c, g] = canvas(256);
    g.fillStyle = '#25282c'; g.fillRect(0, 0, 256, 256);
    for (let i = -256; i < 512; i += 10) {
        g.strokeStyle = i % 20 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.25)';
        g.lineWidth = 5;
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 256, 256); g.stroke();
    }
    return c;
}
function texIonGrid() {
    const [c, g] = canvas(256);
    g.fillStyle = '#8d9298'; g.fillRect(0, 0, 256, 256);
    g.fillStyle = '#0b0c0f';
    const p = 9;
    for (let j = 0, y = 4; y < 256; j++, y += p * 0.866) {
        for (let x = (j % 2) * p / 2 + 4; x < 256; x += p) {
            g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2); g.fill();
        }
    }
    return c;
}
function texPcb() {
    const [c, g] = canvas(256);
    const R = rng(5);
    g.fillStyle = '#16502e'; g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(214,180,90,0.55)'; g.lineWidth = 1.5;
    for (let k = 0; k < 60; k++) {
        const x = R() * 256, y = R() * 256;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + (R() - 0.5) * 120, y); g.lineTo(x + (R() - 0.5) * 120, y + (R() - 0.5) * 80); g.stroke();
    }
    g.fillStyle = '#111';
    for (let k = 0; k < 9; k++) g.fillRect(R() * 220, R() * 220, 18 + R() * 26, 14 + R() * 20);
    return c;
}
function texSar() {
    const [c, g] = canvas(512);
    g.fillStyle = '#e7e3d8'; g.fillRect(0, 0, 512, 512);
    const n = 16, t = 512 / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        g.fillStyle = '#b4823a';
        g.fillRect(i * t + t * 0.28, j * t + t * 0.28, t * 0.44, t * 0.44);
    }
    g.strokeStyle = 'rgba(80,80,80,0.5)'; g.lineWidth = 3;
    for (let i = 0; i <= 4; i++) { g.beginPath(); g.moveTo(i * 128, 0); g.lineTo(i * 128, 512); g.stroke(); }
    return c;
}
function texPhased() {
    const [c, g] = canvas(512);
    g.fillStyle = '#121a26'; g.fillRect(0, 0, 512, 512);
    const p = 22;
    for (let j = 0, y = 6; y < 512; j++, y += p * 0.866) {
        for (let x = (j % 2) * p / 2 + 6; x < 512; x += p) {
            g.fillStyle = '#c9a24e';
            g.beginPath();
            for (let q = 0; q < 6; q++) {
                const a = q * Math.PI / 3;
                const px = x + Math.cos(a) * 7, py = y + Math.sin(a) * 7;
                q ? g.lineTo(px, py) : g.moveTo(px, py);
            }
            g.closePath(); g.fill();
        }
    }
    return c;
}
function texXpatch() {
    const [c, g] = canvas(128);
    g.fillStyle = '#ebe7dc'; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
        g.fillStyle = '#c08a3a'; g.fillRect(8 + i * 30, 8 + j * 30, 22, 22);
    }
    return c;
}
function texBrushed() {
    const [c, g] = canvas(256);
    const R = rng(21);
    g.fillStyle = '#b9bec6'; g.fillRect(0, 0, 256, 256);
    for (let k = 0; k < 400; k++) {
        const v = 160 + R() * 80 | 0;
        g.strokeStyle = `rgba(${v},${v},${v + 6},0.25)`;
        const y = R() * 256;
        g.beginPath(); g.moveTo(0, y); g.lineTo(256, y + (R() - 0.5) * 2); g.stroke();
    }
    return c;
}
function texCoil() {
    const [c, g] = canvas(64, 256);
    g.fillStyle = '#7a3e1b'; g.fillRect(0, 0, 64, 256);
    for (let y = 0; y < 256; y += 4) { g.fillStyle = 'rgba(255,190,120,0.35)'; g.fillRect(0, y, 64, 1.5); }
    return c;
}
function texBatteryTop() {
    const [c, g] = canvas(256);
    g.fillStyle = '#2b2f36'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
        g.fillStyle = '#5c6470';
        g.beginPath(); g.arc(16 + i * 32, 16 + j * 32, 12, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#9aa3ad';
        g.beginPath(); g.arc(16 + i * 32, 16 + j * 32, 4, 0, Math.PI * 2); g.fill();
    }
    return c;
}

function textures(THREE) {
    let T = TEX_CACHE.get(THREE);
    if (T) return T;
    const mk = (cv, { repeat = true, srgb = true } = {}) => {
        const t = new THREE.CanvasTexture(cv);
        if (srgb) t.colorSpace = THREE.SRGBColorSpace;
        if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.anisotropy = 4;
        return t;
    };
    const mli = {};
    let bump = null;
    for (const [k, tint] of Object.entries({ gold: '#f4c25e', silver: '#f2f5f8', black: '#3a3d42' })) {
        const [cc, hc] = texMli(tint);
        mli[k] = mk(cc);
        if (!bump) bump = mk(hc, { srgb: false });
    }
    T = {
        cells: mk(texCells('gaas')), film: mk(texCells('film')), back: mk(texPanelBack()),
        mli, mliBump: bump, osr: mk(texOsr()), carbon: mk(texCarbon()), grid: mk(texIonGrid()),
        pcb: mk(texPcb()), sar: mk(texSar()), phased: mk(texPhased()), xpatch: mk(texXpatch(), { repeat: false }),
        brushed: mk(texBrushed()), coil: mk(texCoil()), battery: mk(texBatteryTop()),
    };
    TEX_CACHE.set(THREE, T);
    return T;
}

// ── Studio environment (for metallic reflections) ───────────────────────────
const ENV_CACHE = new WeakMap();
/** A soft "studio in space" environment: dark sky, warm key softbox, cool
 *  Earth-bounce floor. PMREM-filtered once per renderer. */
export function studioEnvironment(THREE, renderer) {
    if (ENV_CACHE.has(renderer)) return ENV_CACHE.get(renderer);
    const scene = new THREE.Scene();
    const sky = new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false,
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        fragmentShader: 'varying vec3 vP; void main(){ float t = vP.z * 0.5 + 0.5; vec3 lo = vec3(0.22, 0.34, 0.55); vec3 hi = vec3(0.05, 0.06, 0.09); gl_FragColor = vec4(mix(lo, hi, smoothstep(0.0, 0.7, t)), 1.0); }',
    }));
    scene.add(sky);
    const panel = (w, h, color, pos, intensity) => {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
            new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity), side: THREE.DoubleSide }));
        m.position.set(...pos); m.lookAt(0, 0, 0); scene.add(m);
    };
    panel(7, 5, 0xfff1dc, [6, 4, 5], 4.0);     // key (the Sun)
    panel(8, 3, 0x8fb6ff, [-5, -3, -4], 1.4);   // Earthshine
    panel(4, 4, 0xffffff, [-3, 6, 2], 1.2);     // fill
    panel(3, 6, 0xffffff, [2, -6, 1], 0.9);     // rim
    const pmrem = new THREE.PMREMGenerator(renderer);
    const tex = pmrem.fromScene(scene, 0.035).texture;
    pmrem.dispose();
    scene.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    ENV_CACHE.set(renderer, tex);
    return tex;
}

// ── Materials ───────────────────────────────────────────────────────────────
function materials(THREE, rb, envMap) {
    const T = textures(THREE);
    const S = (o) => {
        const m = new THREE.MeshStandardMaterial(o);
        if (envMap) { m.envMap = envMap; m.envMapIntensity = o.envMapIntensity ?? 1; }
        return m;
    };
    const finish = rb.finish;
    const skin = finish === 'mli_gold' ? S({ map: T.mli.gold, bumpMap: T.mliBump, bumpScale: 0.6, color: 0xffffff, metalness: 0.75, roughness: 0.34, envMapIntensity: 1.5 })
        : finish === 'mli_silver' ? S({ map: T.mli.silver, bumpMap: T.mliBump, bumpScale: 0.6, color: 0xffffff, metalness: 0.8, roughness: 0.26, envMapIntensity: 1.5 })
        : finish === 'mli_black' ? S({ map: T.mli.black, bumpMap: T.mliBump, bumpScale: 0.5, color: 0xffffff, metalness: 0.35, roughness: 0.45 })
        : finish === 'white_paint' ? S({ color: 0xe9ecef, metalness: 0.05, roughness: 0.72 })
        : S({ color: 0x24272c, metalness: 0.55, roughness: 0.42 });           // black anodise
    return {
        T,
        skin,
        alu: S({ map: T.brushed, color: 0xffffff, metalness: 0.85, roughness: 0.32 }),
        rail: S({ color: 0xa9aeb5, metalness: 0.8, roughness: 0.38 }),
        dark: S({ color: 0x2c3036, metalness: 0.75, roughness: 0.42 }),
        black: S({ color: 0x07080a, metalness: 0.2, roughness: 0.9, side: THREE.DoubleSide }),
        cells: S({ map: T.cells, color: 0xffffff, metalness: 0.35, roughness: 0.22, envMapIntensity: 1.3 }),
        film: S({ map: T.film, color: 0xffffff, metalness: 0.2, roughness: 0.35, transparent: true, opacity: 0.92, side: THREE.DoubleSide }),
        back: S({ map: T.back, color: 0xffffff, metalness: 0.15, roughness: 0.7 }),
        edge: S({ color: 0x3a3f46, metalness: 0.6, roughness: 0.5 }),
        osr: S({ map: T.osr, color: 0xffffff, metalness: 0.9, roughness: 0.1, envMapIntensity: 1.4 }),
        white: S({ color: 0xeceff2, metalness: 0.05, roughness: 0.65 }),
        whiteDS: S({ color: 0xeef1f4, metalness: 0.1, roughness: 0.5, side: THREE.DoubleSide }),
        radome: S({ color: 0xece4d2, metalness: 0.0, roughness: 0.6 }),
        copper: S({ color: 0xc58a46, metalness: 1.0, roughness: 0.3 }),
        gold: S({ color: 0xe0b552, metalness: 1.0, roughness: 0.26 }),
        ti: S({ color: 0x9ea4aa, metalness: 0.92, roughness: 0.34 }),
        carbon: S({ map: T.carbon, color: 0xffffff, metalness: 0.35, roughness: 0.48 }),
        glass: S({ color: 0x0e2234, metalness: 0.95, roughness: 0.06, emissive: 0x041824, emissiveIntensity: 0.6 }),
        nozzle: S({ color: 0x6c7280, metalness: 0.85, roughness: 0.42, side: THREE.DoubleSide }),
        niobium: S({ color: 0x4f5a72, metalness: 0.8, roughness: 0.48, side: THREE.DoubleSide }),
        ceramic: S({ color: 0xf1ede3, metalness: 0.0, roughness: 0.75 }),
        graphite: S({ color: 0x1e1f22, metalness: 0.3, roughness: 0.8 }),
        grid: S({ map: T.grid, color: 0xffffff, metalness: 0.9, roughness: 0.3, side: THREE.DoubleSide }),
        pcb: S({ map: T.pcb, color: 0xffffff, metalness: 0.2, roughness: 0.6 }),
        sar: S({ map: T.sar, color: 0xffffff, metalness: 0.3, roughness: 0.55 }),
        phased: S({ map: T.phased, color: 0xffffff, metalness: 0.6, roughness: 0.35 }),
        xpatch: S({ map: T.xpatch, color: 0xffffff, metalness: 0.3, roughness: 0.5 }),
        coil: S({ map: T.coil, color: 0xffffff, metalness: 0.9, roughness: 0.35 }),
        battery: S({ map: T.battery, color: 0xffffff, metalness: 0.4, roughness: 0.5 }),
        cfrp: S({ color: 0x2e3238, metalness: 0.4, roughness: 0.5 }),
        tape: S({ color: 0xd9dde2, metalness: 0.9, roughness: 0.3 }),
        dish: S({ color: 0xf2f4f6, metalness: 0.15, roughness: 0.45, side: THREE.DoubleSide }),
    };
}

// ── Geometry helpers ────────────────────────────────────────────────────────
/** Scale the UVs of one BoxGeometry face (0..5 = +x −x +y −y +z −z). */
function scaleBoxFaceUV(geo, face, su, sv) {
    const uv = geo.attributes.uv;
    for (let i = face * 4; i < face * 4 + 4; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    uv.needsUpdate = true;
}
function scaleUV(geo, su, sv = su) {
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
    uv.needsUpdate = true;
    return geo;
}
/** Cylinder with its axis on +z, base at z=0 (or centred when `centred`). */
function cylZ(THREE, rTop, rBot, h, seg = 24, open = false, centred = false) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open);
    g.rotateX(Math.PI / 2);
    if (!centred) g.translate(0, 0, h / 2);
    return g;
}
function lathe(THREE, pts, seg = 40) {
    const g = new THREE.LatheGeometry(pts.map(([r, z]) => new THREE.Vector2(r, z)), seg);
    g.rotateX(Math.PI / 2);         // lathe axis Y → +Z
    return g;
}
/** Rao-style bell: chamber, converging cone, throat, parabolic bell. */
function bellProfile(rt, re, len) {
    const rc = rt * 1.7, lc = len * 0.28, lconv = len * 0.12, lb = len - lc - lconv;
    const pts = [[rc * 0.6, 0], [rc, 0.0005], [rc, lc], [rt, lc + lconv]];
    for (let i = 1; i <= 12; i++) {
        const t = i / 12;
        pts.push([rt + (re - rt) * (1 - (1 - t) ** 2), lc + lconv + lb * t]);
    }
    return pts;
}
function mesh(THREE, geo, mat, pos = null, rot = null) {
    const m = new THREE.Mesh(geo, mat);
    if (pos) m.position.set(pos[0], pos[1], pos[2]);
    if (rot) m.rotation.set(rot[0], rot[1], rot[2]);
    return m;
}
/** Thin strut between two points. */
function strut(THREE, a, b, r, mat) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    const g = new THREE.CylinderGeometry(r, r, len, 8);
    const m = new THREE.Mesh(g, mat);
    m.position.copy(A).add(B).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    return m;
}
/** Orient a group so local x/y/z = face u/v/n. */
function orientToFace(THREE, grp, part) {
    const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...part.u), new THREE.Vector3(...part.v), new THREE.Vector3(...part.n));
    grp.quaternion.setFromRotationMatrix(m);
}

// ── Part builders (each returns a Group in the part's local frame) ──────────
function buildBus(THREE, M, part, rb) {
    const g = new THREE.Group();
    const body = BODIES[rb.body];
    const [dx, dy, dz] = body.dims;
    const cube = bodyClass(rb.body) === 'cubesat';
    if (body.shape === 'cyl' || body.shape === 'tube') {
        const r = dx / 2;
        const len = body.shape === 'tube' ? dz : dz;
        const geo = scaleUV(cylZ(THREE, r, r, len, 48, false, true), Math.PI * dx / MLI_TILE, len / MLI_TILE);
        const shell = mesh(THREE, geo, M.skin); shell.userData.skin = true; g.add(shell);
        // Stringer rings at the deck edges.
        for (const z of [-len / 2, len / 2]) {
            const ring = mesh(THREE, new THREE.TorusGeometry(r, 0.012, 8, 48), M.alu, [0, 0, z]);
            g.add(ring);
        }
        if (body.shape === 'tube') {
            // Sun-shade baffle with an open aperture door, dark interior and
            // a recessed primary mirror.
            const bl = dz * 0.18;
            const baffle = mesh(THREE, cylZ(THREE, r * 1.04, r * 1.04, bl, 48, true), M.skin, [0, 0, dz / 2]);
            g.add(baffle);
            g.add(mesh(THREE, cylZ(THREE, r * 0.985, r * 0.985, dz / 2 + bl, 48, true), M.black, [0, 0, 0]));
            g.add(mesh(THREE, new THREE.CircleGeometry(r * 0.9, 48), M.glass, [0, 0, dz * 0.02]));
            const door = new THREE.Group();
            door.position.set(0, r * 1.04, dz / 2 + bl);
            const leaf = mesh(THREE, new THREE.CylinderGeometry(r * 1.04, r * 1.04, 0.03, 48), M.skin, [0, -r * 1.04, 0]);
            leaf.rotation.x = Math.PI / 2;
            door.add(leaf);
            door.rotation.x = -1.9;
            g.add(door);
        }
    } else {
        // Box bus: skin faces, edge frame. The skin box is one mesh with six
        // face groups; its UVs are scaled so the blanket texture keeps a fixed
        // physical size on every face.
        const geo = new THREE.BoxGeometry(dx, dy, dz);
        const sz = [[dy, dz], [dy, dz], [dx, dz], [dx, dz], [dx, dy], [dx, dy]];
        const tile = cube ? 0.12 : MLI_TILE;
        sz.forEach(([a, b], f) => scaleBoxFaceUV(geo, f, a / tile, b / tile));
        const shell = mesh(THREE, geo, M.skin); shell.userData.skin = true; g.add(shell);
        if (cube) {
            // Hard-anodised corner rails, proud of both decks (CDS rail feet).
            for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
                g.add(mesh(THREE, new THREE.BoxGeometry(0.0085, 0.0085, dz + 0.014), M.rail,
                    [sx * (dx / 2 - 0.0042), sy * (dy / 2 - 0.0042), 0]));
            }
            // Separation switch plungers on the aft rail feet.
            g.add(mesh(THREE, cylZ(THREE, 0.002, 0.002, 0.006, 8), M.alu, [dx / 2 - 0.004, dy / 2 - 0.004, -dz / 2 - 0.013]));
        } else {
            // Aluminium edge frame visible at the blanket seams.
            const e = 0.018;
            for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
                g.add(mesh(THREE, new THREE.BoxGeometry(e, e, dz + 0.004), M.alu, [sx * dx / 2, sy * dy / 2, 0]));
                g.add(mesh(THREE, new THREE.BoxGeometry(dx + 0.004, e, e), M.alu, [0, sx * dy / 2, sy * dz / 2]));
                g.add(mesh(THREE, new THREE.BoxGeometry(e, dy + 0.004, e), M.alu, [sx * dx / 2, 0, sy * dz / 2]));
            }
        }
    }
    // Launch adapter ring (clamp-band interface) on the aft deck.
    const ring = adapterRing(body, rb.body);
    if (ring) {
        const prof = [[ring.r - ring.w, 0], [ring.r + ring.w, 0], [ring.r + ring.w, 0.05], [ring.r + ring.w * 1.6, 0.06],
                      [ring.r + ring.w * 1.6, 0.085], [ring.r - ring.w, 0.085], [ring.r - ring.w, 0]];
        const lg = lathe(THREE, prof, 64);
        const m = mesh(THREE, lg, M.alu, [0, 0, -dz / 2]);
        m.rotation.x = Math.PI;              // hang below the aft deck
        g.add(m);
    }
    // Tug: docking ring + capture probe on the forward deck.
    if (body.tug) {
        g.add(mesh(THREE, new THREE.TorusGeometry(dx * 0.42, dx * 0.035, 14, 64), M.gold, [0, 0, dz / 2 + 0.03]));
        if (rb.payload === 'none') {
            g.add(mesh(THREE, cylZ(THREE, 0.04, 0.1, 0.32, 20), M.alu, [0, 0, dz / 2]));
            g.add(mesh(THREE, new THREE.ConeGeometry(0.06, 0.14, 20).rotateX(Math.PI / 2), M.dark, [0, 0, dz / 2 + 0.39]));
        }
    }
    return g;
}

function buildRadBand(THREE, M, part, rb) {
    const g = new THREE.Group();
    const body = BODIES[rb.body];
    const geom = faceGeometry(body, part.face);
    if (body.shape === 'cyl' || body.shape === 'tube') {
        // Curved band on the ±Y quadrant (local frame = face basis: z is the
        // outward normal, so the arc is centred on +z).
        const r = body.dims[0] / 2 + 0.003;
        const h = (body.shape === 'tube' ? body.dims[2] * 0.42 : body.dims[2]) * part.frac;
        const cg = new THREE.CylinderGeometry(r, r, h, 24, 1, true, -Math.PI / 4, Math.PI / 2);
        scaleUV(cg, Math.PI * r / 2 / OSR_TILE, h / OSR_TILE);
        const m = mesh(THREE, cg, M.osr);
        // Cylinder axis (local y) → face v; arc centre (local +z) → face normal.
        m.position.set(0, body.shape === 'tube' ? -body.dims[2] * 0.29 : 0, -body.dims[0] / 2);
        g.add(m);
    } else {
        const w = geom.W - 0.02, h = geom.H * part.frac;
        const pg = scaleUV(new THREE.PlaneGeometry(w, h), w / OSR_TILE, h / OSR_TILE);
        g.add(mesh(THREE, pg, M.osr, [0, 0, 0.003]));
    }
    return g;
}


function buildCells(THREE, M, part, rb) {
    const g = new THREE.Group();
    const body = BODIES[rb.body];
    const geom = faceGeometry(body, part.face);
    const cube = bodyClass(rb.body) === 'cubesat';
    const radFrac = (part.face === '+Y' || part.face === '-Y') ? rb.radiator : 0;
    const inset = cube ? 0.011 : 0.03;
    const w = Math.max(0.01, geom.W - 2 * inset);
    const strip = (h, v) => {
        if (h <= 0.005) return;
        const pg = scaleUV(new THREE.PlaneGeometry(w, h), w / CELL_TILE[0], h / CELL_TILE[1]);
        g.add(mesh(THREE, pg, M.cells, [0, v, 0.0025]));
    };
    if (radFrac <= 0.001) strip(geom.H - 2 * inset, 0);
    else {
        // Cells above and below the radiator band.
        const band = geom.H * radFrac;
        const h = (geom.H - band) / 2 - inset - 0.004;
        strip(h, band / 2 + 0.004 + h / 2);
        strip(h, -(band / 2 + 0.004 + h / 2));
    }
    return g;
}

function buildWing(THREE, M, part, rb) {
    const g = new THREE.Group();
    const body = BODIES[rb.body];
    const cube = bodyClass(rb.body) === 'cubesat';
    const { span, chord, root } = part;
    const kind = rb.panel;
    // Drive + yoke (rigid / blanket wings on bigger buses).
    if (!cube) {
        g.add(mesh(THREE, new THREE.CylinderGeometry(0.045, 0.05, root * 0.45, 20).rotateZ(Math.PI / 2), M.dark, [root * 0.22, 0, 0]));
        for (const sz of [-1, 1]) g.add(strut(THREE, [root * 0.45, 0, 0], [root, 0, sz * chord * 0.38], 0.012, M.alu));
    } else {
        // CubeSat hinge: a slim knuckle on the face.
        g.add(mesh(THREE, new THREE.CylinderGeometry(0.003, 0.003, Math.min(chord, body.dims[2]), 8).rotateX(Math.PI / 2), M.alu, [root * 0.5, 0, 0]));
    }
    if (kind === 'rosa' || kind === 'thinfilm') {
        const boomR = Math.max(0.008, chord * 0.012);
        for (const sz of [-1, 1]) {
            g.add(strut(THREE, [root, 0, sz * chord / 2], [root + span, 0, sz * chord / 2], boomR, M.cfrp));
        }
        g.add(mesh(THREE, new THREE.BoxGeometry(0.05, 0.04, chord * 1.04), M.dark, [root, 0, 0]));
        const bw = chord * 0.92;
        const blanket = new THREE.BoxGeometry(span, 0.003, bw);
        const tile = kind === 'rosa' ? CELL_TILE : [CELL_TILE[0] * 1.5, CELL_TILE[1] * 1.5];
        scaleBoxFaceUV(blanket, 2, span / tile[0], bw / tile[1]);
        scaleBoxFaceUV(blanket, 3, span / 0.25, bw / 0.25);
        const front = kind === 'rosa' ? M.cells : M.film;
        g.add(mesh(THREE, blanket, [M.edge, M.edge, front, kind === 'rosa' ? M.back : M.film, M.edge, M.edge], [root + span / 2, 0, 0]));
        // Roll-out mandrel at the tip (what the blanket unrolled from).
        g.add(mesh(THREE, new THREE.CylinderGeometry(0.055, 0.055, chord * 1.06, 24).rotateX(Math.PI / 2), M.alu, [root + span + 0.05, 0, 0]));
        if (kind === 'thinfilm') {
            for (const sz of [-1, 1]) g.add(strut(THREE, [root, 0, sz * bw / 2], [root + span, 0, -sz * bw / 2], 0.0015, M.tape));
        }
        return g;
    }
    // Rigid honeycomb panels, accordion-hinged.
    const segTarget = cube ? body.dims[2] * 0.95 : 1.1;
    const n = Math.max(1, Math.round(span / segTarget));
    const gap = cube ? 0.004 : 0.02;
    const segW = (span - (n - 1) * gap) / n;
    const thick = cube ? 0.0025 : 0.022;
    for (let i = 0; i < n; i++) {
        const geo = new THREE.BoxGeometry(segW, thick, chord);
        scaleBoxFaceUV(geo, 2, segW / CELL_TILE[0], chord / CELL_TILE[1]);
        scaleBoxFaceUV(geo, 3, segW / 0.25, chord / 0.25);
        const x0 = root + i * (segW + gap) + segW / 2;
        g.add(mesh(THREE, geo, [M.edge, M.edge, M.cells, M.back, M.edge, M.edge], [x0, 0, 0]));
        if (i > 0) for (const sz of [-1, 1]) {
            g.add(mesh(THREE, new THREE.BoxGeometry(gap + 0.03, thick * 1.6, 0.05), M.alu,
                [root + i * (segW + gap) - gap / 2, 0, sz * chord * 0.4]));
        }
    }
    return g;
}

function buildThruster(THREE, M, part, rb) {
    const g = new THREE.Group();
    const key = rb.thruster;
    const n = { cold_gas: 0.04, monoprop: 0.07, biprop: 0.11, hall_ion: 0.09, gridded_ion: 0.10,
                hall_shielded: 0.09, iodine_ion: 0.06, electrospray: 0.035, water_resisto: 0.05 }[key] || 0.07;
    if (key === 'cold_gas' || key === 'water_resisto') {
        g.add(mesh(THREE, new THREE.BoxGeometry(n * 1.1, n * 1.1, n * 0.7).translate(0, 0, n * 0.35), M.gold));
        g.add(mesh(THREE, lathe(THREE, bellProfile(n * 0.18, n * 0.55, n * 2.0)), M.nozzle, [0, 0, n * 0.7]));
    } else if (key === 'monoprop') {
        for (let k = 0; k < 3; k++) {
            const a = k * 2 * Math.PI / 3;
            g.add(strut(THREE, [Math.cos(a) * n * 0.7, Math.sin(a) * n * 0.7, 0], [Math.cos(a) * n * 0.35, Math.sin(a) * n * 0.35, n * 0.5], n * 0.04, M.ti));
        }
        g.add(mesh(THREE, new THREE.BoxGeometry(n * 0.8, n * 0.6, n * 0.45).translate(0, 0, n * 0.25), M.gold));
        g.add(mesh(THREE, cylZ(THREE, n * 0.42, n * 0.42, n * 0.9, 20), M.nozzle, [0, 0, n * 0.5]));
        g.add(mesh(THREE, lathe(THREE, bellProfile(n * 0.22, n * 0.9, n * 2.2)), M.nozzle, [0, 0, n * 1.3]));
    } else if (key === 'biprop') {
        g.add(mesh(THREE, new THREE.TorusGeometry(n * 0.85, n * 0.07, 10, 32), M.alu, [0, 0, n * 0.35]));
        g.add(mesh(THREE, cylZ(THREE, n * 0.55, n * 0.6, n * 0.65, 24), M.ti, [0, 0, 0]));
        for (const sx of [-1, 1]) g.add(mesh(THREE, new THREE.BoxGeometry(n * 0.35, n * 0.35, n * 0.45).translate(0, 0, n * 0.22), M.gold, [sx * n * 0.75, 0, 0]));
        g.add(mesh(THREE, lathe(THREE, bellProfile(n * 0.3, n * 1.0, n * 3.0), 48), M.niobium, [0, 0, n * 0.6]));
        for (const a of [0, Math.PI / 2]) g.add(strut(THREE, [Math.cos(a) * n, Math.sin(a) * n, 0], [Math.cos(a) * n * 0.55, Math.sin(a) * n * 0.55, n * 1.6], n * 0.05, M.dark));
    } else if (key === 'hall_ion' || key === 'hall_shielded') {
        const L = n * 1.3;
        g.add(mesh(THREE, cylZ(THREE, n * 1.15, n * 1.15, L, 32), M.dark));
        g.add(mesh(THREE, new THREE.RingGeometry(n * 0.9, n * 1.15, 40), M.dark, [0, 0, L + 0.001]));
        g.add(mesh(THREE, new THREE.RingGeometry(n * 0.55, n * 0.9, 40), M.black, [0, 0, L - n * 0.12]));
        g.add(mesh(THREE, cylZ(THREE, n * 0.9, n * 0.9, n * 0.14, 40, true), M.ceramic, [0, 0, L - n * 0.13]));
        g.add(mesh(THREE, cylZ(THREE, n * 0.55, n * 0.55, n * 0.14, 40, true), M.ceramic, [0, 0, L - n * 0.13]));
        g.add(mesh(THREE, new THREE.CircleGeometry(n * 0.55, 32), M.graphite, [0, 0, L + 0.001]));
        if (key === 'hall_shielded') {
            g.add(mesh(THREE, new THREE.TorusGeometry(n * 0.92, n * 0.05, 8, 40), M.graphite, [0, 0, L]));
            g.add(mesh(THREE, new THREE.TorusGeometry(n * 0.53, n * 0.05, 8, 40), M.graphite, [0, 0, L]));
        }
        // External hollow cathode on a bracket, canted toward the plume.
        g.add(mesh(THREE, new THREE.BoxGeometry(n * 0.5, n * 0.2, n * 0.2), M.alu, [n * 1.3, 0, L * 0.6]));
        const cath = mesh(THREE, cylZ(THREE, n * 0.11, n * 0.11, n * 0.8, 14), M.ti, [n * 1.55, 0, L * 0.45]);
        cath.rotation.y = -0.35; g.add(cath);
    } else if (key === 'gridded_ion') {
        const L = n * 1.2;
        g.add(mesh(THREE, cylZ(THREE, n * 1.1, n * 1.05, L, 32), M.dark));
        g.add(mesh(THREE, new THREE.TorusGeometry(n * 1.08, n * 0.06, 8, 40), M.alu, [0, 0, L]));
        const dome = new THREE.SphereGeometry(n * 1.6, 40, 10, 0, Math.PI * 2, 0, 0.66);
        dome.rotateX(Math.PI / 2);
        const dm = mesh(THREE, scaleUV(dome, 3, 3), M.grid, [0, 0, L - n * 1.6 * Math.cos(0.66)]);
        g.add(dm);
        g.add(mesh(THREE, cylZ(THREE, n * 0.12, n * 0.12, n * 0.6, 12), M.ti, [n * 1.25, 0, L * 0.7]));
    } else if (key === 'iodine_ion') {
        g.add(mesh(THREE, new THREE.BoxGeometry(n * 2, n * 2, n * 1.5).translate(0, 0, n * 0.75), M.dark));
        g.add(mesh(THREE, new THREE.CircleGeometry(n * 0.75, 32), M.grid, [0, 0, n * 1.5 + 0.001]));
        g.add(mesh(THREE, new THREE.TorusGeometry(n * 0.78, n * 0.05, 8, 32), M.alu, [0, 0, n * 1.5]));
    } else { // electrospray
        g.add(mesh(THREE, new THREE.BoxGeometry(n * 2.2, n * 2.2, n * 0.45).translate(0, 0, n * 0.22), M.dark));
        g.add(mesh(THREE, scaleUV(new THREE.PlaneGeometry(n * 1.7, n * 1.7), 0.5, 0.5), M.grid, [0, 0, n * 0.45 + 0.001]));
    }
    return g;
}

function buildPayload(THREE, M, part, rb) {
    const g = new THREE.Group();
    const shape = part.shape;
    if (shape === 'scope') {
        for (let k = 0; k < 6; k++) {
            const a = k * Math.PI / 3, b = a + (k % 2 ? 0.5 : -0.5);
            g.add(strut(THREE, [Math.cos(a) * 0.15, Math.sin(a) * 0.15, 0], [Math.cos(b) * 0.12, Math.sin(b) * 0.12, 0.07], 0.006, M.ti));
        }
        g.add(mesh(THREE, cylZ(THREE, 0.15, 0.15, 0.02, 32), M.alu, [0, 0, 0.065]));
        g.add(mesh(THREE, cylZ(THREE, 0.14, 0.14, 0.30, 36, true), M.white, [0, 0, 0.08]));
        g.add(mesh(THREE, cylZ(THREE, 0.137, 0.137, 0.40, 36, true), M.black, [0, 0, 0.08]));
        g.add(mesh(THREE, cylZ(THREE, 0.148, 0.142, 0.10, 36, true), M.white, [0, 0, 0.38]));
        g.add(mesh(THREE, new THREE.CircleGeometry(0.13, 36), M.glass, [0, 0, 0.11]));
        for (let k = 0; k < 3; k++) {
            const a = k * 2 * Math.PI / 3;
            g.add(strut(THREE, [0, 0, 0.36], [Math.cos(a) * 0.137, Math.sin(a) * 0.137, 0.36], 0.003, M.dark));
        }
        g.add(mesh(THREE, cylZ(THREE, 0.035, 0.035, 0.03, 20), M.dark, [0, 0, 0.35]));
    } else if (shape === 'imager') {
        g.add(mesh(THREE, new THREE.BoxGeometry(0.55, 0.4, 0.26).translate(0, 0, 0.16), M.white));
        for (const [x, y] of [[-0.16, 0.07], [0.16, 0.07], [0, -0.1]]) {
            g.add(mesh(THREE, cylZ(THREE, 0.075, 0.075, 0.07, 28, true), M.white, [x, y, 0.29]));
            g.add(mesh(THREE, cylZ(THREE, 0.072, 0.072, 0.07, 28, true), M.black, [x, y, 0.29]));
            g.add(mesh(THREE, new THREE.CircleGeometry(0.06, 28), M.glass, [x, y, 0.295]));
        }
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) g.add(mesh(THREE, cylZ(THREE, 0.02, 0.02, 0.03, 10), M.ti, [sx * 0.22, sy * 0.15, 0]));
    } else if (shape === 'dish') {
        g.add(mesh(THREE, cylZ(THREE, 0.05, 0.07, 0.16, 18), M.alu));
        g.add(mesh(THREE, new THREE.BoxGeometry(0.16, 0.12, 0.06).translate(0, 0, 0.18), M.dark));
        const R = 0.42, f = 0.3;
        const pts = []; for (let i = 0; i <= 16; i++) { const r = R * i / 16; pts.push([r, r * r / (4 * f)]); }
        const dish = mesh(THREE, lathe(THREE, pts, 56), M.dish, [0, 0, 0.21]);
        g.add(dish);
        g.add(mesh(THREE, new THREE.TorusGeometry(R, 0.008, 6, 56), M.alu, [0, 0, 0.21 + R * R / (4 * f)]));
        g.add(mesh(THREE, new THREE.ConeGeometry(0.035, 0.08, 16).rotateX(-Math.PI / 2), M.gold, [0, 0, 0.21 + f]));
        for (let k = 0; k < 3; k++) {
            const a = k * 2 * Math.PI / 3 + Math.PI / 6;
            g.add(strut(THREE, [Math.cos(a) * R, Math.sin(a) * R, 0.21 + R * R / (4 * f)], [0, 0, 0.21 + f + 0.03], 0.005, M.cfrp));
        }
    } else if (shape === 'plate' || shape === 'array') {
        const W = 1.2, H = 0.7, t = shape === 'plate' ? 0.04 : 0.03;
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) g.add(mesh(THREE, cylZ(THREE, 0.018, 0.018, 0.07, 10), M.ti, [sx * W * 0.38, sy * H * 0.35, 0]));
        const geo = new THREE.BoxGeometry(W, H, t);
        if (shape === 'array') scaleBoxFaceUV(geo, 4, W / 0.6, H / 0.6);
        const top = shape === 'plate' ? M.sar : M.phased;
        g.add(mesh(THREE, geo, [M.edge, M.edge, M.edge, M.edge, top, M.back], [0, 0, 0.07 + t / 2]));
    } else if (shape === 'driver') {
        g.add(mesh(THREE, cylZ(THREE, 0.13, 0.13, 1.4, 24, true), M.alu, [0, 0, 0.05]));
        g.add(mesh(THREE, cylZ(THREE, 0.12, 0.12, 1.4, 24, true), M.black, [0, 0, 0.05]));
        for (let i = 0; i < 6; i++) g.add(mesh(THREE, new THREE.TorusGeometry(0.16, 0.028, 8, 24), M.coil, [0, 0, 0.15 + i * 0.25]));
        for (const sx of [-1, 1]) g.add(mesh(THREE, new THREE.BoxGeometry(0.12, 0.2, 0.18).translate(0, 0, 0.09), M.dark, [sx * 0.24, 0, 0]));
    }
    return g;
}

function buildTank(THREE, M, part, rb) {
    const g = new THREE.Group();
    const t = TANKS[part.key];
    if (t.shape === 'sphere') {
        const r = t.d / 2;
        g.add(mesh(THREE, new THREE.SphereGeometry(r, 36, 24), M.ti));
        g.add(mesh(THREE, new THREE.TorusGeometry(r * 1.005, Math.max(0.006, r * 0.035), 8, 48), M.alu));
        for (let k = 0; k < 4; k++) {
            const a = k * Math.PI / 2 + Math.PI / 4;
            g.add(mesh(THREE, new THREE.BoxGeometry(r * 0.22, r * 0.06, r * 0.12), M.alu, [Math.cos(a) * r * 1.08, Math.sin(a) * r * 1.08, 0], [0, 0, a]));
        }
        g.add(mesh(THREE, cylZ(THREE, r * 0.06, r * 0.06, r * 0.25, 10), M.ti, [0, 0, -r * 1.2]));
    } else if (t.shape === 'capsule') {
        const r = t.d / 2, lc = t.len - t.d;
        const pts = [];
        for (let i = 0; i <= 10; i++) { const a = -Math.PI / 2 + i / 10 * Math.PI / 2; pts.push([r * Math.cos(a) + 1e-4, -lc / 2 + r * Math.sin(a)]); }
        for (let i = 0; i <= 10; i++) { const a = i / 10 * Math.PI / 2; pts.push([r * Math.cos(a) + 1e-4, lc / 2 + r * Math.sin(a)]); }
        const geo = scaleUV(lathe(THREE, pts, 36), 3, 2);
        const body = mesh(THREE, geo, M.carbon);
        const holder = new THREE.Group();
        holder.add(body);
        for (const z of [-t.len / 2, t.len / 2]) holder.add(mesh(THREE, cylZ(THREE, r * 0.18, r * 0.18, r * 0.2, 12, false, true), M.alu, [0, 0, z]));
        for (const z of [-lc * 0.3, lc * 0.3]) holder.add(mesh(THREE, new THREE.TorusGeometry(r * 1.01, 0.006, 6, 36), M.alu, [0, 0, z]));
        if (part.axis === 'x') holder.rotation.y = Math.PI / 2;
        g.add(holder);
    } else {
        const [a, b, c] = t.dims;
        g.add(mesh(THREE, new THREE.BoxGeometry(a, b, c), M.alu));
        g.add(mesh(THREE, cylZ(THREE, 0.006, 0.006, 0.012, 8), M.gold, [a * 0.3, b * 0.3, c / 2]));
    }
    return g;
}

function buildBattery(THREE, M, part) {
    const g = new THREE.Group();
    const [a, b, c] = part.s;
    const geo = new THREE.BoxGeometry(a, b, c);
    scaleBoxFaceUV(geo, 4, a / 0.12, b / 0.12);
    g.add(mesh(THREE, geo, [M.dark, M.dark, M.dark, M.dark, M.battery, M.dark]));
    g.add(mesh(THREE, new THREE.BoxGeometry(a * 1.002, b * 0.12, c * 1.002), M.copper));
    return g;
}

function buildObc(THREE, M, part, rb) {
    const g = new THREE.Group();
    const [a, b, c] = part.s;
    if (part.key === 'obc_cube') {
        for (let i = 0; i < 3; i++) g.add(mesh(THREE, new THREE.BoxGeometry(a, b, 0.0016), [M.pcb, M.pcb, M.pcb, M.pcb, M.pcb, M.pcb], [0, 0, -c / 2 + 0.002 + i * c / 3]));
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) g.add(mesh(THREE, cylZ(THREE, 0.002, 0.002, c, 6, false, true), M.alu, [sx * a * 0.42, sy * b * 0.42, 0]));
    } else {
        g.add(mesh(THREE, new THREE.BoxGeometry(a, b, c * 0.8), M.alu, [0, 0, -c * 0.1]));
        for (let i = 0; i < 7; i++) g.add(mesh(THREE, new THREE.BoxGeometry(a * 0.04, b * 0.9, c * 0.2), M.alu, [-a * 0.42 + i * a * 0.14, 0, c * 0.4]));
        for (let i = 0; i < 3; i++) g.add(mesh(THREE, new THREE.BoxGeometry(a * 0.14, b * 0.05, c * 0.25), M.dark, [-a * 0.3 + i * a * 0.3, b / 2, 0]));
    }
    return g;
}

function buildAdcs(THREE, M, part) {
    const g = new THREE.Group();
    const u = ADCS_UNITS[part.key];
    const [a, b, c] = u.dims;
    if (u.kind === 'mtq') {
        const L = Math.min(a, b) * 0.9;
        g.add(mesh(THREE, new THREE.CylinderGeometry(L * 0.07, L * 0.07, L, 12), M.coil, [0, -b * 0.3, 0], [0, 0, Math.PI / 2]));
        g.add(mesh(THREE, new THREE.CylinderGeometry(L * 0.07, L * 0.07, L, 12), M.coil, [a * 0.3, 0, 0]));
        g.add(mesh(THREE, new THREE.TorusGeometry(L * 0.35, L * 0.04, 8, 24), M.coil, [0, 0, 0]));
        return g;
    }
    g.add(mesh(THREE, new THREE.BoxGeometry(a, b, c * 0.12), M.alu, [0, 0, -c * 0.44]));
    const wheelR = Math.min(a, b) * (u.wheels === 3 ? 0.2 : 0.18);
    const wheelH = Math.min(c * 0.5, wheelR * 0.8);
    const unit = (axis, pos) => {
        const w = new THREE.Group();
        w.add(mesh(THREE, new THREE.CylinderGeometry(wheelR, wheelR, wheelH, 28), M.dark));
        w.add(mesh(THREE, new THREE.TorusGeometry(wheelR, wheelR * 0.05, 6, 28).rotateX(Math.PI / 2), M.gold, [0, wheelH / 2, 0]));
        if (u.kind === 'cmg') w.add(mesh(THREE, new THREE.TorusGeometry(wheelR * 1.25, wheelR * 0.08, 8, 32), M.alu, [0, 0, 0], [0, 0, Math.PI / 2]));
        w.position.set(...pos);
        w.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...axis).normalize());
        g.add(w);
    };
    if (u.wheels === 3) {
        unit([1, 0, 0], [-a * 0.28, 0, -c * 0.1]);
        unit([0, 1, 0], [a * 0.12, -b * 0.25, -c * 0.1]);
        unit([0, 0, 1], [a * 0.12, b * 0.22, -c * 0.2]);
    } else {
        // Classic 4-wheel pyramid: spin axes 54.7° off the deck normal.
        const tilt = Math.acos(1 / Math.sqrt(3));
        for (let k = 0; k < 4; k++) {
            const az = Math.PI / 4 + k * Math.PI / 2;
            const ax = [Math.sin(tilt) * Math.cos(az), Math.sin(tilt) * Math.sin(az), Math.cos(tilt)];
            unit(ax, [Math.cos(az) * a * 0.26, Math.sin(az) * b * 0.26, 0]);
        }
    }
    return g;
}

function buildRcs(THREE, M, part) {
    const g = new THREE.Group();
    const r = part.podR;
    g.add(mesh(THREE, new THREE.BoxGeometry(r * 1.4, r * 1.4, r * 1.1), M.dark));
    const dirs = [[...part.dir], [0, 0, 1], [0, 0, -1],
                  [-part.dir[1], part.dir[0], 0]];
    for (const d of dirs) {
        const v = new THREE.Vector3(...d).normalize();
        const n = mesh(THREE, lathe(THREE, bellProfile(r * 0.12, r * 0.38, r * 0.9), 16), M.nozzle);
        n.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), v);
        n.position.copy(v.clone().multiplyScalar(r * 0.6));
        g.add(n);
    }
    return g;
}

/** Face-mounted extras, built with local +z out of the face. */
function buildExtra(THREE, M, part) {
    const g = new THREE.Group();
    switch (part.kind) {
        case 'uhf': {
            g.add(mesh(THREE, new THREE.BoxGeometry(0.03, 0.03, 0.012).translate(0, 0, 0.006), M.alu));
            for (let k = 0; k < 4; k++) {
                const a = Math.PI / 4 + k * Math.PI / 2;
                const tape = mesh(THREE, new THREE.BoxGeometry(0.17, 0.005, 0.0008), M.tape,
                    [Math.cos(a) * 0.1, Math.sin(a) * 0.1, 0.012]);
                tape.rotation.z = a;
                g.add(tape);
            }
            break;
        }
        case 'patch': case 'gnss': {
            const s = part.kind === 'patch' ? 0.08 : 0.06;
            g.add(mesh(THREE, new THREE.BoxGeometry(s, s, 0.008).translate(0, 0, 0.004), M.radome));
            if (part.kind === 'patch') g.add(mesh(THREE, new THREE.PlaneGeometry(s * 0.5, s * 0.5), M.copper, [0, 0, 0.0085]));
            else {
                g.add(mesh(THREE, new THREE.CircleGeometry(s * 0.3, 24), M.copper, [0, 0, 0.0085]));
                g.add(mesh(THREE, new THREE.SphereGeometry(s * 0.12, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), M.radome, [0, 0, 0.008]));
            }
            break;
        }
        case 'xpatch': {
            g.add(mesh(THREE, new THREE.BoxGeometry(0.09, 0.09, 0.015), [M.radome, M.radome, M.radome, M.radome, M.xpatch, M.radome], [0, 0, 0.0075]));
            break;
        }
        case 'horn': {
            g.add(mesh(THREE, new THREE.BoxGeometry(0.1, 0.1, 0.01).translate(0, 0, 0.005), M.alu));
            g.add(mesh(THREE, new THREE.BoxGeometry(0.04, 0.025, 0.05).translate(0, 0, 0.035), M.gold));
            const horn = cylZ(THREE, 0.085, 0.022, 0.12, 4, true);
            horn.rotateZ(Math.PI / 4);
            g.add(mesh(THREE, horn, M.gold, [0, 0, 0.06]));
            break;
        }
        case 'kadish': {
            g.add(mesh(THREE, cylZ(THREE, 0.06, 0.08, 0.03, 18), M.alu));
            g.add(mesh(THREE, cylZ(THREE, 0.025, 0.025, 0.34, 14), M.cfrp, [0, 0, 0.03]));
            g.add(mesh(THREE, new THREE.BoxGeometry(0.08, 0.06, 0.07), M.dark, [0, 0, 0.4]));
            const head = new THREE.Group();
            head.position.set(0, 0, 0.44);
            head.rotation.x = -0.45;
            const R = 0.3, f = 0.22;
            const pts = []; for (let i = 0; i <= 14; i++) { const r = R * i / 14; pts.push([r, r * r / (4 * f)]); }
            head.add(mesh(THREE, lathe(THREE, pts, 48), M.dish));
            head.add(mesh(THREE, new THREE.ConeGeometry(0.025, 0.06, 14).rotateX(-Math.PI / 2), M.gold, [0, 0, f]));
            for (let k = 0; k < 3; k++) {
                const a = k * 2 * Math.PI / 3;
                head.add(strut(THREE, [Math.cos(a) * R, Math.sin(a) * R, R * R / (4 * f)], [0, 0, f + 0.02], 0.004, M.cfrp));
            }
            g.add(head);
            break;
        }
        case 'laser': {
            g.add(mesh(THREE, cylZ(THREE, 0.075, 0.08, 0.04, 24), M.alu));
            for (const sx of [-1, 1]) g.add(mesh(THREE, new THREE.BoxGeometry(0.02, 0.05, 0.13).translate(0, 0, 0.065), M.alu, [sx * 0.065, 0, 0.04]));
            const tel = new THREE.Group();
            tel.position.set(0, 0, 0.13);
            tel.rotation.x = -0.6;
            tel.add(mesh(THREE, cylZ(THREE, 0.05, 0.05, 0.16, 24, false, true), M.white));
            tel.add(mesh(THREE, cylZ(THREE, 0.054, 0.05, 0.05, 24, true), M.dark, [0, 0, 0.08]));
            tel.add(mesh(THREE, new THREE.CircleGeometry(0.045, 24), M.glass, [0, 0, 0.081]));
            g.add(tel);
            break;
        }
        case 'star': {
            const head = new THREE.Group();
            head.rotation.x = 0.35;
            g.add(mesh(THREE, new THREE.BoxGeometry(0.09, 0.09, 0.02).translate(0, 0, 0.01), M.alu));
            head.position.set(0, 0, 0.02);
            head.add(mesh(THREE, new THREE.BoxGeometry(0.065, 0.065, 0.05).translate(0, 0, 0.025), M.dark));
            head.add(mesh(THREE, cylZ(THREE, 0.045, 0.026, 0.085, 24, true), M.black, [0, 0, 0.05]));
            head.add(mesh(THREE, new THREE.CircleGeometry(0.022, 20), M.glass, [0, 0, 0.051]));
            g.add(head);
            break;
        }
        case 'sun': {
            g.add(mesh(THREE, new THREE.BoxGeometry(0.035, 0.035, 0.012).translate(0, 0, 0.006), M.dark));
            g.add(mesh(THREE, new THREE.PlaneGeometry(0.018, 0.018), M.glass, [0, 0, 0.0125]));
            break;
        }
        case 'earth': {
            g.add(mesh(THREE, new THREE.BoxGeometry(0.06, 0.06, 0.03).translate(0, 0, 0.015), M.dark));
            g.add(mesh(THREE, new THREE.SphereGeometry(0.02, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(Math.PI / 2), M.glass, [0, 0, 0.03]));
            break;
        }
        case 'boom': {
            g.add(mesh(THREE, new THREE.BoxGeometry(0.05, 0.05, 0.04).translate(0, 0, 0.02), M.alu));
            const end = [0, 0.6, 1.05];
            g.add(strut(THREE, [0, 0, 0.04], end, 0.008, M.cfrp));
            g.add(mesh(THREE, new THREE.CylinderGeometry(0.02, 0.02, 0.06, 14), M.dark, end));
            break;
        }
        case 'radiator': {
            g.add(mesh(THREE, new THREE.BoxGeometry(0.1, 0.06, 0.05).translate(0, 0, 0.025), M.alu));
            g.add(strut(THREE, [0, 0, 0.05], [0, 0, 0.28], 0.012, M.alu));
            const geo = new THREE.BoxGeometry(0.02, 0.8, 1.0);
            scaleBoxFaceUV(geo, 0, 2.5, 2); scaleBoxFaceUV(geo, 1, 2.5, 2);
            g.add(mesh(THREE, geo, [M.osr, M.osr, M.edge, M.edge, M.edge, M.edge], [0, 0, 0.28 + 0.5]));
            break;
        }
        default:
            g.add(mesh(THREE, new THREE.BoxGeometry(0.04, 0.04, 0.02), M.dark));
    }
    return g;
}

const INTERNAL = { tank: buildTank, battery: buildBattery, obc: buildObc, adcs: buildAdcs };

// ── Assembly ────────────────────────────────────────────────────────────────
/**
 * Build the whole spacecraft. Every child group carries
 * userData = { partId, part, basePos, explodeDir, explodeDist }.
 */
export function buildSatellite(THREE, build, opts = {}) {
    const lay = layoutBuild(build, opts.tierMods || null);
    const rb = lay.rb;
    const body = BODIES[rb.body];
    const [dx, , dz] = body.dims;
    const M = materials(THREE, rb, opts.envMap || null);
    const root = new THREE.Group();
    root.name = 'satellite';
    const parts = new Map();
    const maxSide = Math.max(...body.dims);
    for (const p of lay.parts) {
        let g = null;
        const dir = new THREE.Vector3();
        let dist = 0;
        switch (p.kind) {
            case 'harness': continue;
            case 'bus':
                g = buildBus(THREE, M, p, rb); break;
            case 'radband':
                g = buildRadBand(THREE, M, p, rb);
                g.position.set(...p.c); orientToFace(THREE, g, p);
                dir.set(...p.n); dist = maxSide * 0.08; break;
            case 'cells':
                g = buildCells(THREE, M, p, rb);
                g.position.set(...p.c); orientToFace(THREE, g, p);
                dir.set(...p.n); dist = maxSide * 0.08; break;
            case 'wing':
                g = buildWing(THREE, M, p, rb);
                g.position.set(p.side * dx / 2, 0, p.zoff);
                if (p.side < 0) g.rotation.y = Math.PI;
                dir.set(p.side, 0, 0); dist = maxSide * 0.45; break;
            case 'thruster':
                g = buildThruster(THREE, M, p, rb);
                g.position.set(p.c[0], p.c[1], -dz / 2);
                g.rotation.x = Math.PI;
                g.scale.setScalar(p.scale || 1);
                dir.set(0, 0, -1); dist = maxSide * 0.5; break;
            case 'payload':
                g = buildPayload(THREE, M, p, rb);
                g.position.set(0, 0, p.zBase);
                g.scale.setScalar(p.scale || 1);
                dir.set(0, 0, 1); dist = maxSide * 0.55; break;
            case 'rcs':
                g = buildRcs(THREE, M, p);
                g.position.set(...p.c);
                dir.set(...p.dir); dist = maxSide * 0.35; break;
            default:
                if (INTERNAL[p.kind]) {
                    g = INTERNAL[p.kind](THREE, M, p, rb);
                    g.position.set(...p.c);
                    // Internals slide out of the +Y wall (toward the bay's
                    // default camera), fanned by their own position so they
                    // do not collide.
                    dir.set(p.c[0] * 0.8, 1, p.c[2] * 0.8).normalize();
                    dist = maxSide * 1.15;
                } else if (p.slot === 'extra') {
                    g = buildExtra(THREE, M, p);
                    g.position.set(...p.base);
                    orientToFace(THREE, g, p);
                    dir.set(...p.n); dist = maxSide * 0.4;
                }
        }
        if (!g) continue;
        g.userData = { partId: p.id, part: p, basePos: g.position.clone(), explodeDir: dir, explodeDist: dist };
        g.traverse(o => {
            if (!o.isMesh) return;
            o.userData.partId = p.id;
            o.userData.subsystem = p.subsystem;
            o.userData.baseMat = o.material;
            if (p.kind === 'bus' && o.userData.skin) o.userData.ghostable = true;
            if (p.kind === 'cells' || p.kind === 'radband') o.userData.ghostable = true;
        });
        root.add(g);
        parts.set(p.id, g);
    }
    // Bus outline, shown only in the see-through views.
    const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(body.shape === 'box' || body.shape === 'grid'
            ? new THREE.BoxGeometry(...body.dims)
            : cylZ(THREE, dx / 2, dx / 2, dz, 32, false, true)),
        new THREE.LineBasicMaterial({ color: 0x7fc8ff, transparent: true, opacity: 0.55 }));
    outline.visible = false;
    outline.userData.outline = true;
    root.add(outline);
    root.userData = { layout: lay, parts, M, outline, mode: 'real', explode: 0, selected: null, hover: null,
                      extent: lay.extent, variants: new Map(), subsys: {}, ghost: null, THREE };
    return root;
}

/** Walk up from a raycast hit to its part id. */
export function partIdOf(obj) {
    for (let o = obj; o; o = o.parent) if (o.userData && o.userData.partId) return o.userData.partId;
    return null;
}
/** First hit that is a real part (skips ghosted skin in the see-through views). */
export function pickPart(group, hits) {
    const see = group.userData.mode !== 'real';
    for (const h of hits) {
        if (!h.object.isMesh || !h.object.visible) continue;
        if (see && h.object.userData.ghostable) continue;
        const id = partIdOf(h.object);
        if (id) return id;
    }
    return null;
}

function ghostMat(group) {
    const U = group.userData, THREE = U.THREE;
    if (!U.ghost) U.ghost = new THREE.MeshBasicMaterial({ color: 0x6fb6ff, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide });
    return U.ghost;
}
function subsysMat(group, sub) {
    const U = group.userData, THREE = U.THREE;
    if (!U.subsys[sub]) U.subsys[sub] = new THREE.MeshStandardMaterial({
        color: SUBSYSTEMS[sub]?.color || '#888888', metalness: 0.1, roughness: 0.6,
        emissive: SUBSYSTEMS[sub]?.color || '#888888', emissiveIntensity: 0.18 });
    return U.subsys[sub];
}
function variant(group, mat, kind) {
    const U = group.userData;
    let m = U.variants.get(mat);
    if (!m) { m = {}; U.variants.set(mat, m); }
    if (!m[kind]) {
        const v = mat.clone();
        if ('emissive' in v) {
            v.emissive = new U.THREE.Color(kind === 'sel' ? 0x2f8cff : 0x5fb0ff);
            v.emissiveIntensity = kind === 'sel' ? 0.75 : 0.4;
        }
        m[kind] = v;
    }
    return m[kind];
}

function refresh(group) {
    const U = group.userData;
    group.traverse(o => {
        if (!o.isMesh || !o.userData.baseMat) return;
        const id = o.userData.partId;
        let base = o.userData.baseMat;
        if (U.mode === 'subsystem') {
            base = o.userData.ghostable ? ghostMat(group) : (Array.isArray(base) ? base.map(() => subsysMat(group, o.userData.subsystem)) : subsysMat(group, o.userData.subsystem));
        } else if (U.mode === 'xray' && o.userData.ghostable) {
            base = ghostMat(group);
        }
        const hl = id === U.selected ? 'sel' : id === U.hover ? 'hov' : null;
        if (hl && base !== U.ghost) base = Array.isArray(base) ? base.map(m => variant(group, m, hl)) : variant(group, base, hl);
        o.material = base;
    });
    U.outline.visible = U.mode !== 'real';
}

export function setViewMode(group, mode) {
    group.userData.mode = ['real', 'subsystem', 'xray'].includes(mode) ? mode : 'real';
    refresh(group);
}
export function setHighlight(group, selectedId = null, hoverId = null) {
    const U = group.userData;
    if (U.selected === selectedId && U.hover === hoverId) return;
    U.selected = selectedId; U.hover = hoverId;
    refresh(group);
}
export function setExplode(group, t) {
    const U = group.userData;
    U.explode = Math.max(0, Math.min(1, t));
    for (const g of U.parts.values()) {
        const d = g.userData;
        g.position.copy(d.basePos).addScaledVector(d.explodeDir, d.explodeDist * U.explode);
    }
}

/** Dispose geometries and per-build materials (shared textures are kept). */
export function disposeSatellite(group) {
    if (!group) return;
    const mats = new Set();
    group.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        const add = (m) => m && mats.add(m);
        if (o.userData?.baseMat) [].concat(o.userData.baseMat).forEach(add);
        [].concat(o.material || []).forEach(add);
    });
    const U = group.userData || {};
    if (U.M) for (const v of Object.values(U.M)) if (v && v.isMaterial) mats.add(v);
    for (const m of Object.values(U.subsys || {})) mats.add(m);
    for (const m of (U.variants || new Map()).values()) Object.values(m).forEach(x => mats.add(x));
    if (U.ghost) mats.add(U.ghost);
    mats.forEach(m => m.dispose());
}
