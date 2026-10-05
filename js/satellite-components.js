/**
 * satellite-components.js — the Satellite Designer's component library
 * ════════════════════════════════════════════════════════════════════════════
 *
 * PURE data + geometry. No DOM, no THREE, no imports — so the builder
 * (physics), the layout kernel (placement + mass properties), the engineering
 * review (budgets) and the mesh factory (pixels) can all read ONE copy.
 *
 * What lives here, beyond the four original slots in satellite-builder.js
 * (bus / thruster / array / payload):
 *
 *   TANKS          propellant tanks — sized by real geometry; capacity is
 *                  inner volume × the propellant's storage density × usable
 *                  fill fraction (ullage), NEVER a typed kg number
 *   PROPELLANTS    storage density per thruster family (THRUSTER_PROPELLANT)
 *   BATTERIES      Li-ion packs (Wh, kg, envelope)
 *   ADCS_UNITS     reaction-wheel / CMG / magnetorquer suites: momentum
 *                  storage [N·m·s], torque [N·m], dump dipole [A·m²]
 *   RCS_KITS       optional reaction-control kits ('auto' = the bus's own)
 *   OBC_UNITS      flight computers
 *   FINISHES       bus skin (MLI blankets, paints) — α/ε for the thermal node
 *   EXTRAS         face-mounted parts the user adds freely: antennas, star
 *                  trackers, sun sensors, GNSS, booms, deployable radiators
 *   BODY_DEFAULTS  the kit each bus ships with when a slot is 'auto'
 *
 * and two pieces of packing geometry shared by builder + layout:
 *   packInternals()  3-D box packer inside the bus envelope (tanks first)
 *   packFace()       2-D rectangle packer for face-mounted extras
 *
 * Numbers are representative of real hardware classes circa 2020–2026 (e.g.
 * CubeSpace / Blue Canyon wheel classes, Ti-6Al-4V diaphragm tanks, COPV
 * xenon tanks, 18650-class Li-ion packs at ~130 Wh/kg pack level). They are a
 * teaching catalogue, not a spec sheet.
 *
 * FRAME (same as satellite-builder.js): bus centred on the origin, metres,
 * +Z = payload deck (thrust pushes +Z), −Z = aft deck (engines), arrays
 * deploy along ±X, ±Y are the radiator sides.
 */

// ── Subsystems ───────────────────────────────────────────────────────────────
// Colour = the validated 8-slot categorical palette (dark steps), assigned in
// FIXED order. These colours are identity only — the review's status chips
// use the page's separate good/warn/bad tokens with an icon + label.
export const SUBSYSTEMS = {
    structure:  { label: 'Structure',   color: '#3987e5' },
    power:      { label: 'Power',       color: '#d95926' },
    propulsion: { label: 'Propulsion',  color: '#199e70' },
    adcs:       { label: 'ADCS',        color: '#c98500' },
    comms:      { label: 'Comms',       color: '#d55181' },
    thermal:    { label: 'Thermal',     color: '#008300' },
    avionics:   { label: 'Avionics',    color: '#9085e9' },
    payload:    { label: 'Payload',     color: '#e66767' },
};
export const SUBSYSTEM_ORDER = Object.keys(SUBSYSTEMS);

// ── Faces ────────────────────────────────────────────────────────────────────
// u × v = n for every face (right-handed), so a part built with +Z out of its
// mount and oriented by makeBasis(u, v, n) is never mirrored.
export const FACES = {
    '+Z': { label: 'Payload deck (+Z)', n: [0, 0, 1],  u: [1, 0, 0],  v: [0, 1, 0] },
    '-Z': { label: 'Aft deck (−Z)',     n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
    '+X': { label: 'Wing side +X',      n: [1, 0, 0],  u: [0, 1, 0],  v: [0, 0, 1] },
    '-X': { label: 'Wing side −X',      n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
    '+Y': { label: 'Side +Y',           n: [0, 1, 0],  u: [-1, 0, 0], v: [0, 0, 1] },
    '-Y': { label: 'Side −Y',           n: [0, -1, 0], u: [1, 0, 0],  v: [0, 0, 1] },
};
export const FACE_KEYS = Object.keys(FACES);

/** Bus class — drives defaults, wall thickness and payload miniaturisation. */
export function bodyClass(bodyKey) {
    if (/^cubesat/.test(bodyKey || '')) return 'cubesat';
    if (bodyKey === 'smallsat') return 'small';
    return 'large';
}

// ── Propellants ──────────────────────────────────────────────────────────────
// density = storage density [kg/m³] at the tank's operating point; fill =
// usable fraction of inner volume (liquids keep ~8 % ullage; supercritical
// gases are loaded to MEOP so the density already is the limit; a sublimating
// solid packs to ~60 %).
export const PROPELLANTS = {
    n2:       { label: 'Nitrogen (GN₂, 300 bar)',      density:  310, fill: 1.00, storage: 'gas'    },
    n2h4:     { label: 'Hydrazine (N₂H₄)',             density: 1004, fill: 0.92, storage: 'liquid' },
    mmh_nto:  { label: 'MMH / NTO (O/F 1.65)',         density: 1190, fill: 0.92, storage: 'biprop' },
    krypton:  { label: 'Krypton (150 bar, supercrit.)', density:  670, fill: 1.00, storage: 'gas'    },
    xenon:    { label: 'Xenon (150 bar, supercrit.)',  density: 1600, fill: 1.00, storage: 'gas'    },
    iodine:   { label: 'Iodine (solid I₂)',            density: 4930, fill: 0.60, storage: 'solid'  },
    ionic:    { label: 'Ionic liquid (EMI-BF₄)',        density: 1280, fill: 0.90, storage: 'liquid' },
    water:    { label: 'Water',                        density: 1000, fill: 0.92, storage: 'liquid' },
};
// Keys MUST match ENGINE_PRESETS / THRUSTER_UNITS.
export const THRUSTER_PROPELLANT = {
    cold_gas: 'n2', monoprop: 'n2h4', biprop: 'mmh_nto',
    hall_ion: 'krypton', gridded_ion: 'xenon', hall_shielded: 'xenon',
    iodine_ion: 'iodine', electrospray: 'ionic', water_resisto: 'water',
};
export function propellantFor(thrusterKey) {
    return PROPELLANTS[THRUSTER_PROPELLANT[thrusterKey]] || PROPELLANTS.n2h4;
}

// ── Tanks ────────────────────────────────────────────────────────────────────
// shape: 'sphere' (d = outer Ø), 'capsule' (d, len = overall length, axis
// along local z), 'box' (dims). Inner volume is DERIVED from the geometry with
// a wall allowance, so the drawn tank and its capacity cannot disagree.
export const TANKS = {
    cs_tank_05u: { label: 'CubeSat tank 0.5U',          shape: 'box',     dims: [0.090, 0.090, 0.050], mass: 0.35, mat: 'alu',  cubesatOnly: true },
    cs_tank_1u:  { label: 'CubeSat tank 1U',            shape: 'box',     dims: [0.090, 0.090, 0.095], mass: 0.55, mat: 'alu',  cubesatOnly: true },
    ti_s:        { label: 'Ti sphere Ø0.25 m',          shape: 'sphere',  d: 0.25, mass:  1.6, mat: 'ti'   },
    ti_m:        { label: 'Ti sphere Ø0.52 m',          shape: 'sphere',  d: 0.52, mass:  7.5, mat: 'ti'   },
    ti_l:        { label: 'Ti sphere Ø0.84 m',          shape: 'sphere',  d: 0.84, mass: 24,   mat: 'ti'   },
    ti_xl:       { label: 'Ti sphere Ø1.02 m',          shape: 'sphere',  d: 1.02, mass: 40,   mat: 'ti'   },
    copv_s:      { label: 'COPV 22 L (Ø0.24 m)',        shape: 'capsule', d: 0.24, len: 0.62, mass:  4.2, mat: 'copv' },
    copv_l:      { label: 'COPV 119 L (Ø0.42 m)',       shape: 'capsule', d: 0.42, len: 1.05, mass: 14,   mat: 'copv' },
};
const TANK_WALL = 0.005;  // m — inner = outer − 2·wall

/** Inner volume [m³] of a tank spec, from its geometry. */
export function tankVolume(t) {
    if (!t) return 0;
    if (t.shape === 'sphere') {
        const r = t.d / 2 - TANK_WALL;
        return (4 / 3) * Math.PI * r ** 3;
    }
    if (t.shape === 'capsule') {
        const r = t.d / 2 - TANK_WALL;
        const lc = Math.max(0, t.len - t.d);
        return Math.PI * r * r * lc + (4 / 3) * Math.PI * r ** 3;
    }
    const [a, b, c] = t.dims;
    return Math.max(0, (a - 2 * TANK_WALL) * (b - 2 * TANK_WALL) * (c - 2 * TANK_WALL));
}
/** Usable propellant capacity [kg] of ONE tank for a thruster family. */
export function tankCapacityKg(t, thrusterKey) {
    const p = propellantFor(thrusterKey);
    return tankVolume(t) * p.density * p.fill;
}
/** Axis-aligned envelope [x,y,z] of a tank in a given orientation. */
export function tankEnvelope(t, axis = 'z') {
    if (t.shape === 'sphere') return [t.d, t.d, t.d];
    if (t.shape === 'capsule') return axis === 'x' ? [t.len, t.d, t.d] : [t.d, t.d, t.len];
    return [...t.dims];
}

// ── Batteries ────────────────────────────────────────────────────────────────
export const BATTERIES = {
    li_20:   { label: 'Li-ion 20 Wh',   wh:   20, mass: 0.16, dims: [0.090, 0.090, 0.020] },
    li_80:   { label: 'Li-ion 80 Wh',   wh:   80, mass: 0.60, dims: [0.090, 0.090, 0.040] },
    li_300:  { label: 'Li-ion 300 Wh',  wh:  300, mass: 2.40, dims: [0.20, 0.15, 0.10] },
    li_1200: { label: 'Li-ion 1.2 kWh', wh: 1200, mass: 9.0,  dims: [0.32, 0.24, 0.16] },
    li_4800: { label: 'Li-ion 4.8 kWh', wh: 4800, mass: 35,   dims: [0.50, 0.36, 0.24] },
};

// ── Attitude control suites ─────────────────────────────────────────────────
// hNms = usable momentum envelope of the whole array, torque = max control
// torque, dipole = magnetorquer dipole for momentum dumping, slewDeg = the
// arcade base slew the flight model scales (deriveDesign). powerW orbit-avg.
export const ADCS_UNITS = {
    mtq_only:  { label: 'Magnetorquers only',      sys: 'Magnetorquers',          hNms: 0,     torque: 0,       dipole: 0.2, slewDeg: 0.3, mass: 0.25, powerW: 0.6, dims: [0.090, 0.090, 0.020], wheels: 0, kind: 'mtq'  },
    rw_cube:   { label: 'CubeSat ADCS (3 wheels)', sys: 'Nano wheels + MTQ',      hNms: 0.006, torque: 0.0002,  dipole: 0.2, slewDeg: 1.2, mass: 0.45, powerW: 1.5, dims: [0.090, 0.090, 0.050], wheels: 3, kind: 'rw'   },
    rw_small:  { label: 'Small wheels ×4',         sys: 'Reaction wheels',        hNms: 1.2,   torque: 0.01,    dipole: 3,   slewDeg: 1.4, mass: 4.0,  powerW: 12,  dims: [0.26, 0.26, 0.10],    wheels: 4, kind: 'rw'   },
    rw_medium: { label: 'Medium wheels ×4',        sys: 'Reaction wheels',        hNms: 2.5,   torque: 0.05,    dipole: 15,  slewDeg: 1.0, mass: 9.0,  powerW: 25,  dims: [0.40, 0.40, 0.18],    wheels: 4, kind: 'rw'   },
    rw_large:  { label: 'Large wheels ×4',         sys: 'Reaction wheels',        hNms: 10,    torque: 0.15,    dipole: 30,  slewDeg: 1.2, mass: 20,   powerW: 45,  dims: [0.55, 0.55, 0.25],    wheels: 4, kind: 'rw'   },
    cmg:       { label: 'CMG array ×4',            sys: 'Control-moment gyros',   hNms: 60,    torque: 5,       dipole: 60,  slewDeg: 2.6, mass: 58,   powerW: 85,  dims: [0.70, 0.70, 0.35],    wheels: 4, kind: 'cmg'  },
};

// ── RCS kits ────────────────────────────────────────────────────────────────
// 'auto' keeps the bus's own suite (BODIES[].rcs, mass already in the bus).
export const RCS_KITS = {
    none:       { label: 'No RCS',              thrust: 0,   isp: 0,   mass: 0   },
    rcs_cold:   { label: 'Cold-gas RCS',        thrust: 0.5, isp: 65,  mass: 2.5 },
    rcs_hyd:    { label: 'Hydrazine RCS',       thrust: 10,  isp: 220, mass: 9   },
    rcs_hyd_hi: { label: 'Hydrazine RCS (hi)',  thrust: 40,  isp: 230, mass: 20  },
};

// ── Flight computers ────────────────────────────────────────────────────────
export const OBC_UNITS = {
    obc_cube: { label: 'CubeSat OBC',        mass: 0.10, powerW: 2,  dims: [0.090, 0.090, 0.020], rad: 'COTS'      },
    obc_std:  { label: 'SmallSat OBC',       mass: 2.5,  powerW: 12, dims: [0.22, 0.16, 0.08],    rad: 'rad-tolerant' },
    obc_rad:  { label: 'Rad-hard OBC',       mass: 5.0,  powerW: 20, dims: [0.26, 0.20, 0.14],    rad: 'rad-hard'  },
};

// ── Skin finishes ───────────────────────────────────────────────────────────
// mli = true: the surface is an insulating blanket, so the bus node only sees
// an effective ε* ≈ 0.03 and α* = ε*·α/ε (the outer layer's own balance).
// mli = false: a bare painted / anodised surface radiates with its own ε.
export const FINISHES = {
    mli_gold:   { label: 'Gold MLI (Al-Kapton)',   alpha: 0.38, eps: 0.67, mli: true  },
    mli_silver: { label: 'Silver MLI (Ag-Teflon)', alpha: 0.09, eps: 0.78, mli: true  },
    mli_black:  { label: 'Black Kapton MLI',       alpha: 0.92, eps: 0.86, mli: true  },
    white_paint:{ label: 'White paint',            alpha: 0.25, eps: 0.88, mli: false },
    anodized:   { label: 'Black anodise',          alpha: 0.65, eps: 0.82, mli: false },
};
export const MLI_EPS_STAR = 0.03;
export const OSR = { alpha: 0.08, eps: 0.80 };            // optical solar reflector
export const BODY_CELL = { alpha: 0.92, eps: 0.85, eta: 0.29, packing: 0.80, kgM2: 1.2 };

// ── Face-mounted extras ─────────────────────────────────────────────────────
// foot = [w, h] footprint on the face (m), height = how far it stands proud,
// reach = visual extent beyond the footprint (booms, tapes) for camera fit.
// Comms: band, f [Hz], txW (RF), gainDbi or dishD, maxBps (modem ceiling),
// link: 'ground' | 'crosslink'.
export const EXTRAS = {
    uhf_whip:    { label: 'UHF turnstile antenna', subsystem: 'comms',    kind: 'uhf',      foot: [0.03, 0.03], height: 0.012, reach: 0.18, mass: 0.08, powerW: 2,   band: 'UHF', f: 437e6,  txW: 1,  gainDbi: 0,  maxBps: 9.6e3,  link: 'ground' },
    s_patch:     { label: 'S-band patch',          subsystem: 'comms',    kind: 'patch',    foot: [0.08, 0.08], height: 0.012, mass: 0.35, powerW: 6,   band: 'S',   f: 2.25e9, txW: 2,  gainDbi: 6,  maxBps: 4e6,    link: 'ground' },
    x_patch:     { label: 'X-band patch array',    subsystem: 'comms',    kind: 'xpatch',   foot: [0.09, 0.09], height: 0.015, mass: 0.6,  powerW: 15,  band: 'X',   f: 8.2e9,  txW: 4,  gainDbi: 14, maxBps: 200e6,  link: 'ground' },
    x_horn:      { label: 'X-band horn',           subsystem: 'comms',    kind: 'horn',     foot: [0.12, 0.12], height: 0.18,  mass: 1.8,  powerW: 30,  band: 'X',   f: 8.2e9,  txW: 10, gainDbi: 18, maxBps: 400e6,  link: 'ground' },
    ka_dish:     { label: 'Ka-band gimballed dish',subsystem: 'comms',    kind: 'kadish',   foot: [0.20, 0.20], height: 0.75,  reach: 0.4, mass: 9, powerW: 60, band: 'Ka', f: 26e9, txW: 20, dishD: 0.6, maxBps: 2e9, link: 'ground', area: 0.28 },
    laser_term:  { label: 'Optical crosslink terminal', subsystem: 'comms', kind: 'laser',  foot: [0.16, 0.16], height: 0.24,  mass: 8,    powerW: 45,  band: 'Optical', maxBps: 10e9, link: 'crosslink' },
    gps_patch:   { label: 'GNSS receiver',         subsystem: 'avionics', kind: 'gnss',     foot: [0.06, 0.06], height: 0.010, mass: 0.12, powerW: 1.2 },
    star_tracker:{ label: 'Star tracker',          subsystem: 'adcs',     kind: 'star',     foot: [0.09, 0.09], height: 0.16,  mass: 0.9,  powerW: 1.5, fine: true },
    sun_sensor:  { label: 'Fine sun sensor',       subsystem: 'adcs',     kind: 'sun',      foot: [0.035, 0.035], height: 0.015, mass: 0.035, powerW: 0.15 },
    earth_sensor:{ label: 'Earth horizon sensor',  subsystem: 'adcs',     kind: 'earth',    foot: [0.06, 0.06], height: 0.05,  mass: 0.13, powerW: 0.5 },
    mag_boom:    { label: 'Magnetometer boom',     subsystem: 'adcs',     kind: 'boom',     foot: [0.05, 0.05], height: 0.05,  reach: 1.2, mass: 0.8, powerW: 0.5 },
    deploy_rad:  { label: 'Deployable radiator 1 m²', subsystem: 'thermal', kind: 'radiator', foot: [0.10, 0.28], height: 0.06, reach: 1.3, mass: 6, powerW: 0, radArea: 1.6, area: 0.30 },
};

// ── Payload miniaturisation (CubeSat class only) ────────────────────────────
// Larger buses carry the catalogue payload at full size — reflectors and SAR
// panels overhang their bus in real life. A CubeSat carries the miniaturised
// variant that fits its deck: s = deck-fit scale, mass ∝ s³, power & area ∝
// s². ONE function, used by the physics AND the mesh, so the drawn camera and
// its mass cannot disagree.
export const PAYLOAD_FOOTPRINT = {          // nominal [w, h] on the deck (m)
    scope: [0.28, 0.28], imager: [0.55, 0.40], dish: [0.84, 0.84],
    plate: [1.20, 0.70], driver: [0.32, 0.32], array: [1.20, 0.70],
};
export function payloadScale(bodyKey, bodyDims, shape) {
    if (!shape || bodyClass(bodyKey) !== 'cubesat') return 1;
    const fp = PAYLOAD_FOOTPRINT[shape] || [0.3, 0.3];
    const deck = Math.min(bodyDims[0], bodyDims[1]) * 0.9;
    return Math.min(1, deck / Math.max(fp[0], fp[1]));
}

// ── Defaults per bus ('auto' slots resolve to these) ────────────────────────
const CUBE_EXTRAS_3U = [
    { k: 'uhf_whip', face: '+Y' }, { k: 'gps_patch', face: '+Y' },
    { k: 's_patch', face: '-Y' }, { k: 'x_patch', face: '-Y' },
    { k: 'sun_sensor', face: '+X' }, { k: 'sun_sensor', face: '-X' },
];
const CUBE_EXTRAS_12U = [...CUBE_EXTRAS_3U, { k: 'star_tracker', face: '+Y' }];
export const BODY_DEFAULTS = {
    cubesat_3u:   { battery: 'li_20',   adcs: 'rw_cube',   obc: 'obc_cube', finish: 'anodized',   radiator: 0,    bodyCells: ['+X', '-X', '+Y', '-Y'], extras: CUBE_EXTRAS_3U },
    cubesat_12u:  { battery: 'li_80',   adcs: 'rw_cube',   obc: 'obc_cube', finish: 'anodized',   radiator: 0,    bodyCells: ['+X', '-X', '+Y', '-Y'], extras: CUBE_EXTRAS_12U },
    cubesat_grid: { battery: 'li_80',   adcs: 'rw_cube',   obc: 'obc_cube', finish: 'anodized',   radiator: 0,    bodyCells: ['+X', '-X', '+Y', '-Y'], extras: CUBE_EXTRAS_12U },
    smallsat:     { battery: 'li_300',  adcs: 'rw_small',  obc: 'obc_std',  finish: 'mli_gold',   radiator: 0.30, bodyCells: [], extras: [
        { k: 's_patch', face: '-Y' }, { k: 'gps_patch', face: '+Y' }, { k: 'star_tracker', face: '+Y' },
        { k: 'x_patch', face: '-Y' }, { k: 'sun_sensor', face: '+X' }, { k: 'sun_sensor', face: '-X' } ] },
    bus_med:      { battery: 'li_1200', adcs: 'rw_medium', obc: 'obc_std',  finish: 'mli_gold',   radiator: 0.40, bodyCells: [], extras: [
        { k: 's_patch', face: '-Y' }, { k: 'x_horn', face: '+Z' }, { k: 'star_tracker', face: '+Y' },
        { k: 'star_tracker', face: '-Y' }, { k: 'gps_patch', face: '+Y' },
        { k: 'sun_sensor', face: '+X' }, { k: 'sun_sensor', face: '-X' } ] },
    tank_cyl:     { battery: 'li_1200', adcs: 'rw_medium', obc: 'obc_std',  finish: 'mli_silver', radiator: 0.35, bodyCells: [], extras: [
        { k: 's_patch', face: '-Y' }, { k: 'x_patch', face: '-Y' }, { k: 'star_tracker', face: '+Y' },
        { k: 'gps_patch', face: '+Y' }, { k: 'sun_sensor', face: '+X' }, { k: 'sun_sensor', face: '-X' } ] },
    tug:          { battery: 'li_1200', adcs: 'rw_medium', obc: 'obc_std',  finish: 'mli_gold',   radiator: 0.35, bodyCells: [], extras: [
        { k: 's_patch', face: '-Y' }, { k: 'star_tracker', face: '+Y' }, { k: 'star_tracker', face: '-Y' },
        { k: 'gps_patch', face: '+Y' }, { k: 'x_patch', face: '-Y' },
        { k: 'sun_sensor', face: '+X' }, { k: 'sun_sensor', face: '-X' } ] },
    telescope:    { battery: 'li_1200', adcs: 'cmg',       obc: 'obc_rad',  finish: 'mli_silver', radiator: 0.30, bodyCells: [], extras: [
        { k: 's_patch', face: '-Y' }, { k: 'x_horn', face: '+Y' }, { k: 'star_tracker', face: '+Y' },
        { k: 'star_tracker', face: '-Y' }, { k: 'gps_patch', face: '-Y' },
        { k: 'sun_sensor', face: '+X' }, { k: 'sun_sensor', face: '-X' } ] },
};
export function bodyDefaults(bodyKey) {
    return BODY_DEFAULTS[bodyKey] || BODY_DEFAULTS.smallsat;
}

// ── Bus interior envelope ───────────────────────────────────────────────────
/** Inner usable envelope: { shape:'box'|'cyl', size:[x,y,z], r? }. */
export function innerEnvelope(body, bodyKey) {
    const wall = bodyClass(bodyKey) === 'cubesat' ? 0.0025 : 0.03;
    const [dx, dy, dz] = body.dims;
    if (body.shape === 'cyl' || body.shape === 'tube') {
        // The telescope keeps its optics in the forward ~55 % of the tube;
        // the service module is the aft section.
        const len = body.shape === 'tube' ? dz * 0.42 : dz - 2 * wall;
        const zc = body.shape === 'tube' ? -dz / 2 + wall + len / 2 : 0;
        const r = dx / 2 - wall;
        return { shape: 'cyl', size: [2 * r, 2 * r, len], r, zc };
    }
    return { shape: 'box', size: [dx - 2 * wall, dy - 2 * wall, dz - 2 * wall], zc: 0 };
}

function boxInside(env, c, s, eps = 1e-6) {
    const hz = env.size[2] / 2;
    if (c[2] - s[2] / 2 < env.zc - hz - eps || c[2] + s[2] / 2 > env.zc + hz + eps) return false;
    if (env.shape === 'cyl') {
        // Every xy corner of the box inside the radius.
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
            if (Math.hypot(c[0] + sx * s[0] / 2, c[1] + sy * s[1] / 2) > env.r + eps) return false;
        }
        return true;
    }
    return Math.abs(c[0]) + s[0] / 2 <= env.size[0] / 2 + eps
        && Math.abs(c[1]) + s[1] / 2 <= env.size[1] / 2 + eps;
}
function sphereInside(env, c, d, eps = 1e-6) {
    const r = d / 2, hz = env.size[2] / 2;
    if (c[2] - r < env.zc - hz - eps || c[2] + r > env.zc + hz + eps) return false;
    if (env.shape === 'cyl') return Math.hypot(c[0], c[1]) + r <= env.r + eps;
    return Math.abs(c[0]) + r <= env.size[0] / 2 + eps && Math.abs(c[1]) + r <= env.size[1] / 2 + eps;
}
function boxSphereOverlap(c, s, sc, r, gap = 0) {
    let d2 = 0;
    for (let i = 0; i < 3; i++) {
        const lo = c[i] - s[i] / 2, hi = c[i] + s[i] / 2;
        const q = Math.max(lo, Math.min(sc[i], hi));
        d2 += (sc[i] - q) ** 2;
    }
    return d2 < (r + gap) ** 2 - 1e-12;
}
function boxesOverlap(c1, s1, c2, s2, gap = 0) {
    for (let i = 0; i < 3; i++) {
        if (Math.abs(c1[i] - c2[i]) >= (s1[i] + s2[i]) / 2 + gap - 1e-9) return false;
    }
    return true;
}

/**
 * Place `count` tanks of spec `t` in the bus. Tanks sit AFT (low z) and
 * symmetric about the thrust axis so the propellant's centre of mass stays on
 * it as it drains. Tries several arrangements; returns the first that fits.
 * @returns {{fits:boolean, items:Array<{c:number[], s:number[], axis:string}>}}
 */
export function placeTanks(env, t, count) {
    const n = Math.max(1, Math.min(4, Math.round(count || 1)));
    const zLo = env.zc - env.size[2] / 2;
    const gap = 0.01;
    const tries = [];
    for (const axis of t.shape === 'capsule' ? ['z', 'x'] : ['z']) {
        const s = tankEnvelope(t, axis);
        const zAft = zLo + s[2] / 2;
        const sep = (a) => a / 2 + gap / 2;
        if (n === 1) tries.push([[0, 0, zAft]].map(c => ({ c, s, axis })));
        if (n === 2) {
            tries.push([[-sep(s[0]), 0, zAft], [sep(s[0]), 0, zAft]].map(c => ({ c, s, axis })));
            tries.push([[0, -sep(s[1]), zAft], [0, sep(s[1]), zAft]].map(c => ({ c, s, axis })));
            tries.push([[0, 0, zAft], [0, 0, zAft + s[2] + gap]].map(c => ({ c, s, axis })));
        }
        if (n === 3) {
            const rr = (Math.max(s[0], s[1]) + gap) / Math.sqrt(3);
            tries.push([0, 1, 2].map(i => {
                const a = Math.PI / 2 + i * 2 * Math.PI / 3;
                return { c: [rr * Math.cos(a), rr * Math.sin(a), zAft], s, axis };
            }));
            tries.push([0, 1, 2].map(i => ({ c: [0, 0, zAft + i * (s[2] + gap)], s, axis })));
        }
        if (n === 4) {
            tries.push([[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) =>
                ({ c: [a * sep(s[0]), b * sep(s[1]), zAft], s, axis })));
            tries.push([[-1, 0], [1, 0], [-1, 1], [1, 1]].map(([a, k]) =>
                ({ c: [a * sep(s[0]), 0, zAft + k * (s[2] + gap)], s, axis })));
        }
    }
    for (const items of tries) {
        const ok = items.every(it => t.shape === 'sphere'
            ? sphereInside(env, it.c, t.d) : boxInside(env, it.c, it.s));
        if (ok) return { fits: true, items };
    }
    return { fits: false, items: tries[0] || [] };
}

/**
 * Pack internal boxes (battery, wheels, computer…) around fixed obstacles
 * (tanks). Candidates are a 9-step lattice of positions per axis, tried
 * farthest-from-the-tanks first so equipment hugs the walls and the forward
 * deck; deterministic. Items that cannot be placed come back with fits:false
 * and are parked at the envelope centre (the review fails them).
 */
export function packInternals(env, items, obstacles = []) {
    // Spherical tanks are tested as spheres, not as their bounding cubes, so
    // equipment can tuck into the corners around them as it does in a real bus.
    const placed = obstacles.map(o => ({ c: o.c, s: o.s, sphere: o.sphere || 0 }));
    const out = [];
    const STEPS = 9;
    for (const it of items) {
        const s = it.s;
        const cands = [];
        const range = (i) => {
            const half = env.size[i] / 2 - s[i] / 2;
            if (half < -1e-9) return [];
            const lo = (i === 2 ? env.zc : 0) - Math.max(0, half);
            const hi = (i === 2 ? env.zc : 0) + Math.max(0, half);
            const arr = [];
            for (let k = 0; k < STEPS; k++) arr.push(lo + (hi - lo) * k / (STEPS - 1));
            return arr;
        };
        const xs = range(0), ys = range(1), zs = range(2);
        for (const x of xs) for (const y of ys) for (const z of zs) cands.push([x, y, z]);
        // Prefer high z (forward deck, away from the aft tanks), then the
        // walls. Stable sort key so ties never depend on engine internals.
        cands.sort((a, b) => (b[2] - a[2]) * 10 + (Math.hypot(b[0], b[1]) - Math.hypot(a[0], a[1]))
            || a[0] - b[0] || a[1] - b[1]);
        let hit = null;
        for (const c of cands) {
            if (!boxInside(env, c, s)) continue;
            if (placed.some(p => p.sphere
                ? boxSphereOverlap(c, s, p.c, p.sphere / 2, 0.006)
                : boxesOverlap(c, s, p.c, p.s, 0.006))) continue;
            hit = c; break;
        }
        if (hit) { placed.push({ c: hit, s }); out.push({ ...it, c: hit, fits: true }); }
        else out.push({ ...it, c: [0, 0, env.zc], fits: false });
    }
    return out;
}

/**
 * Face geometry for packing: the face rectangle (W along u, H along v), the
 * distance of the face plane from the origin, and whether it is curved.
 */
export function faceGeometry(body, face) {
    const [dx, dy, dz] = body.dims;
    const cyl = body.shape === 'cyl' || body.shape === 'tube';
    if (face === '+Z' || face === '-Z') {
        return { W: dx, H: dy, d: dz / 2, round: cyl ? dx / 2 : 0 };
    }
    if (cyl) {
        // Tangent-plane strip on a curved wall: the usable width is the chord
        // across ±40° of arc around the face direction.
        const r = dx / 2;
        return { W: 2 * r * Math.sin(40 * Math.PI / 180), H: dz, d: r, curvedR: r };
    }
    if (face === '+X' || face === '-X') return { W: dy, H: dz, d: dx / 2 };
    return { W: dx, H: dz, d: dy / 2 };
}

/**
 * 2-D rectangle packer for one face. reserved = [{u,v,w,h}] rectangles or
 * {ring:true, rIn, rOut} annuli (centred on the face origin). Candidate
 * centres are a 17×17 lattice, tried corners-first. Returns per item
 * {u, v, fits}.
 */
export function packFace(geom, items, reserved = []) {
    const placed = [];
    const out = [];
    const gap = 0.008;
    const N = 17;
    const hit = (u, v, w, h) => {
        for (const r of reserved) {
            if (r.ring) {
                // Nearest / farthest point of the rect from the origin vs the band.
                const nx = Math.max(Math.abs(u) - w / 2, 0), ny = Math.max(Math.abs(v) - h / 2, 0);
                const near = Math.hypot(nx, ny);
                const far = Math.hypot(Math.abs(u) + w / 2, Math.abs(v) + h / 2);
                if (far > r.rIn - gap && near < r.rOut + gap) return true;
            } else if (Math.abs(u - r.u) < (w + r.w) / 2 + gap && Math.abs(v - r.v) < (h + r.h) / 2 + gap) {
                return true;
            }
        }
        for (const p of placed) {
            if (Math.abs(u - p.u) < (w + p.w) / 2 + gap && Math.abs(v - p.v) < (h + p.h) / 2 + gap) return true;
        }
        return false;
    };
    for (const it of items) {
        const [w, h] = it.foot;
        const hu = geom.W / 2 - w / 2 - 0.004, hv = geom.H / 2 - h / 2 - 0.004;
        let found = null;
        if (hu >= 0 && hv >= 0) {
            const cands = [];
            for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
                const u = -hu + 2 * hu * i / (N - 1), v = -hv + 2 * hv * j / (N - 1);
                cands.push([u, v]);
            }
            cands.sort((a, b) => (Math.hypot(b[0] / (geom.W || 1), b[1] / (geom.H || 1))
                                 - Math.hypot(a[0] / (geom.W || 1), a[1] / (geom.H || 1)))
                                 || b[1] - a[1] || a[0] - b[0]);
            for (const [u, v] of cands) {
                if (geom.round) {   // round deck: every corner inside the disc
                    const far = Math.hypot(Math.abs(u) + w / 2, Math.abs(v) + h / 2);
                    if (far > geom.round - 0.004) continue;
                }
                if (hit(u, v, w, h)) continue;
                found = [u, v]; break;
            }
        }
        if (found) { placed.push({ u: found[0], v: found[1], w, h }); out.push({ ...it, u: found[0], v: found[1], fits: true }); }
        else out.push({ ...it, u: 0, v: 0, fits: false });
    }
    return out;
}
