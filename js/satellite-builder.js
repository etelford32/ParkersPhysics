/**
 * satellite-builder.js — parametric spacecraft assembly for the Design Bay
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Turns a "build" config into the derived *physics* the flight model
 * consumes (dry mass, projected drag area, blended drag coefficient, total
 * thrust, Isp, power, slew authority, RCS).
 *
 * The build has the four original slots — { body, thruster, thrusterCount,
 * panel, panelSpan, payload } — plus the subsystem slots added with the
 * component library (js/satellite-components.js): panelChord, fuelKg, tank /
 * tankCount, battery, adcs, obc, rcs, finish, radiator, bodyCells, extras.
 * Every new slot accepts 'auto', which resolves to the bus's own default kit
 * (BODY_DEFAULTS) — so a legacy saved build with none of the new fields still
 * derives, and switching bus re-kits anything the user has not hand-picked.
 * resolveBuild() is the ONE place 'auto' is resolved.
 *
 * massBreakdown() is the ONE itemised mass list: deriveDesign() sums it and
 * js/satellite-layout.js places every item of it, so the mass the flight model
 * flies and the centre of mass the review reports cannot disagree
 * (tests/satellite-components.mjs pins the sum).
 *
 * The whole point is the engineering trade-off: bigger solar wings collect
 * more power but add frontal area → more drag → faster orbital decay; more
 * thrusters out-push drag but cost dry mass and (for chemical engines) burn
 * propellant fast. The numbers below are order-of-magnitude representative
 * of real LEO hardware classes.
 *
 * The meshes live in js/satellite-parts-3d.js (THREE injected); this module
 * stays dependency-free apart from the pure component library, so
 * deriveDesign() + selfTest() run in plain Node.
 */

import {
    TANKS, BATTERIES, ADCS_UNITS, RCS_KITS, OBC_UNITS, FINISHES, EXTRAS, FACES,
    BODY_CELL, bodyClass, bodyDefaults, payloadScale, tankCapacityKg,
    innerEnvelope, placeTanks, packInternals, propellantFor,
} from './satellite-components.js';

// ── Body / bus chassis ──────────────────────────────────────────────────────
// dims [x,y,z] metres (z = thrust axis), mass kg, cd ≈ free-molecular drag
// coefficient for that shape, broad = broadside projected area (m²) used as
// the default ram area when the bus flies belly-to-the-wind.
//
// momentArmMul = how off-axis the *centre of pressure* sits relative to the
// centre of mass, normalised to (max-side / 2). It feeds the engine's drag-
// torque term: tall buses (telescopes, tugs) want active attitude control
// or they tumble; symmetric cubes resist disturbance naturally.
//
// rcs = optional reaction-control thruster suite — { thrust, isp } (per-axis
// authority [N] and propellant Isp [s]). Bodies that carry it gain
// *multidirectional* translation in flight (engine reads design.rcs*): they
// can push along and across the velocity vector at once, decoupled from the
// main engine. Only the bigger buses fly RCS — CubeSats hold attitude with
// magnetorquers/wheels and have no translation clusters. The orbital tug is
// servicing-grade and carries the strongest, finest RCS in the catalogue.
//
// attCtrl = how the bus *re-points* (steers its attitude) — never aero
// surfaces; space has no air. { sys, slewDeg } names the dominant actuator and
// its base slew rate [deg/s]. Real hardware classes:
//   • Reaction wheels        — ubiquitous, precise, moderate authority
//   • Control-moment gyros   — agile high-torque pointing (Pléiades, ISS)
//   • Magnetorquers + wheels — torque against Earth's B-field, slow (CubeSats)
//   • RCS thrusters          — fast but propellant-fed (added as a bonus when
//                              the bus also carries an rcs suite)
// deriveDesign() turns this into a per-design slewRate, scaled by mass and bus
// tier — the number the flight model uses for A/D steering.
export const BODIES = {
    cubesat_3u:   { label: '3U CubeSat',        dims: [0.10, 0.10, 0.34], mass: 4,    cd: 2.2, shape: 'box',  momentArmMul: 0.15, attCtrl: { sys: 'Reaction wheels',        slewDeg: 1.5 } },
    cubesat_12u:  { label: '12U CubeSat',       dims: [0.20, 0.20, 0.34], mass: 14,   cd: 2.2, shape: 'box',  momentArmMul: 0.18, attCtrl: { sys: 'Magnetorquers + wheels', slewDeg: 1.1 } },
    cubesat_grid: { label: '6U Grid (3×2)',     dims: [0.30, 0.20, 0.34], mass: 22,   cd: 2.3, shape: 'grid', momentArmMul: 0.22, gridCells: [3, 2, 1], attCtrl: { sys: 'Magnetorquers + wheels', slewDeg: 1.0 } },
    smallsat:     { label: 'SmallSat bus',      dims: [0.60, 0.60, 0.80], mass: 90,   cd: 2.2, shape: 'box',  momentArmMul: 0.18, rcs: { thrust:  2, isp:  80 }, attCtrl: { sys: 'Reaction wheels',        slewDeg: 1.4 } },
    bus_med:      { label: 'Medium bus',        dims: [1.20, 1.20, 1.50], mass: 320,  cd: 2.2, shape: 'box',  momentArmMul: 0.20, rcs: { thrust: 10, isp: 220 }, attCtrl: { sys: 'Reaction wheels',        slewDeg: 0.9 } },
    tank_cyl:     { label: 'Cylindrical bus',   dims: [1.00, 1.00, 2.00], mass: 240,  cd: 2.0, shape: 'cyl',  momentArmMul: 0.30, rcs: { thrust:  8, isp: 220 }, attCtrl: { sys: 'Reaction wheels',        slewDeg: 0.8 } },
    tug:          { label: 'Orbital tug',       dims: [1.60, 1.60, 1.10], mass: 480,  cd: 2.1, shape: 'cyl',  momentArmMul: 0.22, tug: true, rcs: { thrust: 40, isp: 230 }, attCtrl: { sys: 'RCS thrusters',          slewDeg: 1.6 } },
    telescope:    { label: 'Optical telescope', dims: [1.10, 1.10, 3.20], mass: 540,  cd: 2.4, shape: 'tube', momentArmMul: 0.55, rcs: { thrust:  4, isp: 200 }, attCtrl: { sys: 'Control-moment gyros',   slewDeg: 2.4 } },
};

// ── Thruster units ──────────────────────────────────────────────────────────
// Keys MUST match satellite-designer-engine.js ENGINE_PRESETS so the flight
// model's thrust/Isp stay the single source of truth. Here we add the
// per-unit dry mass, the nozzle size used for the 3-D model, and the
// per-unit electrical power draw at rated thrust.
//
//   power = 0   → chemical: stored-energy propellant, thrust is power-
//                 independent (cold-gas, mono-/bi-propellant).
//   power > 0   → electric: needs that many watts (≈ ½·T·Isp·g₀ / η) to
//                 make rated thrust. Starve it of array power and thrust
//                 throttles down linearly (deriveDesign, below).
//
//   gimbalDeg   → maximum gimbal half-angle the nozzle can vector through
//                 (the engine reads control.gimbal in rad, clamped here).
//                 Chemicals gimbal a few degrees mechanically; electrics
//                 vector electrostatically and have wider authority.
//   throatLifeS → how many *full-throttle seconds* the throat lasts before
//                 erosion costs you Isp and thrust (capped at 25 % loss).
//                 Ion engines have huge life; bipropellants are aggressive.
export const THRUSTER_UNITS = {
    cold_gas:      { label: 'Cold-gas (N₂)',          unitMass: 0.6,  nozzle: 0.04, power: 0,    gimbalDeg: 0,   throatLifeS:  8_000 },
    monoprop:      { label: 'Monoprop hydrazine',     unitMass: 4.0,  nozzle: 0.07, power: 0,    gimbalDeg: 4,   throatLifeS:  4_500 },
    biprop:        { label: 'Bipropellant (MMH/NTO)', unitMass: 12.0, nozzle: 0.11, power: 0,    gimbalDeg: 8,   throatLifeS:  2_400 },
    hall_ion:      { label: 'Hall-effect ion',        unitMass: 8.0,  nozzle: 0.09, power: 1100, gimbalDeg: 15,  throatLifeS: 60_000 },
    gridded_ion:   { label: 'Gridded ion (Xe)',       unitMass: 10.0, nozzle: 0.10, power: 650,  gimbalDeg: 18,  throatLifeS: 90_000 },
    hall_shielded: { label: 'Mag-shielded Hall',      unitMass: 11.0, nozzle: 0.09, power: 1500, gimbalDeg: 12,  throatLifeS:120_000 },
    iodine_ion:    { label: 'Iodine gridded ion',     unitMass: 2.2,  nozzle: 0.06, power: 220,  gimbalDeg: 18,  throatLifeS: 30_000 },
    electrospray:  { label: 'Electrospray / FEEP',    unitMass: 0.5,  nozzle: 0.035, power: 35,  gimbalDeg: 22,  throatLifeS: 40_000 },
    water_resisto: { label: 'Water electrothermal',   unitMass: 1.6,  nozzle: 0.05, power: 90,   gimbalDeg: 6,   throatLifeS:  6_000 },
};

// ── Payloads ────────────────────────────────────────────────────────────────
// A fourth assembly slot — the *reason* the bird is up there. Payloads add
// dry mass, drag-area, and a fixed electrical load, and they introduce new
// failure / opportunity modes:
//
//   optical_cam  — narrow-FOV imager; very mass-efficient, modest power.
//   wide_imager  — staring multi-band camera; bigger aperture, more area.
//   commsat_dish — high-gain X-band reflector; large frontal area when
//                  pointed cross-track, big housekeeping power.
//   sar_radar    — phased-array side-looker; heavy, power-hungry, mostly
//                  flat-plate drag.
//   mass_driver  — experimental electromagnetic launcher (gameplay flavour
//                  payload); very heavy, exotic power draw, lots of area.
//
// All payloads have a centreOffset (m, along +z) describing how far above
// the bus deck they sit, used both for the 3-D model and (eventually) for
// CG-offset moments in the flight model.
export const PAYLOADS = {
    none:         { label: 'None',                mass:   0, area:  0,  cd: 0,   powerW:   0, centreOffset: 0,    shape: null,     dataGBd: 0 },
    optical_cam:  { label: 'Optical camera',      mass:  18, area: 0.25, cd: 2.3, powerW:  40, centreOffset: 0.45, shape: 'scope',  dataGBd: 25,  fine: true },
    wide_imager:  { label: 'Wide-field imager',   mass:  46, area: 0.70, cd: 2.3, powerW:  85, centreOffset: 0.55, shape: 'imager', dataGBd: 90,  fine: true },
    commsat_dish: { label: 'Comms HG dish',       mass:  32, area: 1.10, cd: 2.6, powerW: 110, centreOffset: 0.60, shape: 'dish',   dataGBd: 0,   role: 'comms' },
    sar_radar:    { label: 'SAR phased array',    mass: 120, area: 2.40, cd: 2.6, powerW: 320, centreOffset: 0.30, shape: 'plate',  dataGBd: 150 },
    // Same flat-plate physics as the SAR panel, but a COMMS role: it relays
    // user traffic rather than generating imagery to downlink (Starlink,
    // BlueBird). Drawn as an active phased array, not a SAR tile panel.
    phased_array: { label: 'Comms phased array',  mass: 120, area: 2.40, cd: 2.6, powerW: 320, centreOffset: 0.30, shape: 'array',  dataGBd: 0,   role: 'comms' },
    mass_driver:  { label: 'Mass driver (exp.)',  mass: 240, area: 1.60, cd: 2.4, powerW: 480, centreOffset: 0.95, shape: 'driver', dataGBd: 0 },
};

// ── Solar arrays ────────────────────────────────────────────────────────────
// wings = number of deployable panels, areaKgM2 = panel areal density,
// ramFactor = fraction of full panel area that actually faces the ram (sun-
// tracking arrays spend a lot of the orbit broadside to the flow), cd = flat-
// plate free-molecular drag coefficient, wPerM2 = electrical power generated
// per m² of panel (BOL, 1 AU, after packing/efficiency).
//
// "Body-mounted only" makes no deployable power, so an electric thruster on
// it is starved → no thrust. Roll-out (ROSA) and thin-film are the cutting-
// edge picks: far lighter per watt, so you can carry the kilowatts an ion
// engine needs without the mass — at the cost of more drag area.
export const PANELS = {
    none:     { label: 'Body-mounted only', wings: 0, areaKgM2: 0,    ramFactor: 0,    cd: 0,   wPerM2: 0   },
    dual:     { label: 'Dual deployable',   wings: 2, areaKgM2: 2.3,  ramFactor: 0.55, cd: 2.5, wPerM2: 180 },
    quad:     { label: 'Quad deployable',   wings: 4, areaKgM2: 2.3,  ramFactor: 0.55, cd: 2.5, wPerM2: 180 },
    large:    { label: 'Large array',       wings: 2, areaKgM2: 1.8,  ramFactor: 0.6,  cd: 2.6, wPerM2: 170 },
    rosa:     { label: 'Roll-out (ROSA)',   wings: 2, areaKgM2: 1.0,  ramFactor: 0.55, cd: 2.5, wPerM2: 200 },
    thinfilm: { label: 'Thin-film flex',    wings: 2, areaKgM2: 0.55, ramFactor: 0.6,  cd: 2.6, wPerM2: 140 },
};

// Harness + power conditioning scale with the bus (≈5 % of structure); the
// flight computer, wheels, battery and tanks are separate items now.
const harnessMass = (busMass) => 0.2 + 0.05 * busMass;
// Baseline bus load (EPS conversion losses, thermal control, harness) before
// any listed unit. A CubeSat's is a couple of watts, not twenty.
const housekeepingW = (bodyKey) => bodyClass(bodyKey) === 'cubesat' ? 2 : 20;
export const CHORD_DEFAULT = 0.45;

export function defaultBuild() {
    return { body: 'smallsat', thruster: 'monoprop', thrusterCount: 2,
             panel: 'dual', panelSpan: 2.2, panelChord: CHORD_DEFAULT,
             payload: 'optical_cam', fuelKg: 60,
             tank: 'auto', tankCount: 1, battery: 'auto', adcs: 'auto',
             obc: 'auto', rcs: 'auto', finish: 'auto', radiator: 'auto',
             bodyCells: 'auto', extras: 'auto' };
}

/** Per-wing panel area (m²): span (root→tip) × chord. */
function wingArea(span, chord = CHORD_DEFAULT) {
    return clampNum(span, 0.3, 8, 2) * clampNum(chord, 0.2, 2.5, CHORD_DEFAULT);
}

const MAX_EXTRAS = 24;

/**
 * Pick the lightest tank set that holds `fuelKg` and fits inside the bus.
 * Bipropellant prefers an even count (separate fuel and oxidiser tanks).
 * @returns {{tank:string, count:number}}
 */
// Which tank sets physically fit a bus (with its internal kit) does not
// depend on the propellant load, so it is computed once per bus + kit.
const TANK_FIT_CACHE = new Map();
function tankFitTable(bodyKey, others) {
    const key = bodyKey + '|' + JSON.stringify(others);
    let rows = TANK_FIT_CACHE.get(key);
    if (rows) return rows;
    const body = BODIES[bodyKey] || BODIES.smallsat;
    const env = innerEnvelope(body, bodyKey);
    const cube = bodyClass(bodyKey) === 'cubesat';
    rows = [];
    for (const [k, t] of Object.entries(TANKS)) {
        if (t.cubesatOnly && !cube) continue;
        for (let n = 1; n <= 4; n++) {
            // "Fits" means the tanks fit AND the rest of the internal kit
            // still packs around them — a tank that leaves no room for the
            // battery is no answer.
            const tp = placeTanks(env, t, n);
            let fits = tp.fits;
            if (fits && others.length) {
                const obst = tp.items.map(it => ({ ...it, sphere: t.shape === 'sphere' ? t.d : 0 }));
                fits = packInternals(env, others.map(s => ({ s })), obst).every(o => o.fits);
            }
            rows.push({ tank: k, count: n, mass: t.mass * n, fits });
        }
    }
    rows.sort((a, b) => a.mass - b.mass || a.count - b.count);
    if (TANK_FIT_CACHE.size > 200) TANK_FIT_CACHE.clear();
    TANK_FIT_CACHE.set(key, rows);
    return rows;
}

/**
 * Pick the lightest tank set that holds `fuelKg` and fits inside the bus
 * alongside the internal kit (`others` = their [x,y,z] envelopes).
 * Bipropellant prefers an even count (separate fuel and oxidiser tanks).
 * @returns {{tank:string, count:number}}
 */
export function autoTank(bodyKey, thrusterKey, fuelKg, others = []) {
    const biprop = propellantFor(thrusterKey).storage === 'biprop';
    const opts = tankFitTable(bodyKey, others).map(o =>
        ({ ...o, cap: tankCapacityKg(TANKS[o.tank], thrusterKey) * o.count }));
    const need = Math.max(0, fuelKg || 0);
    const pick = (f) => opts.find(f);
    return pick(o => o.fits && o.cap >= need && (!biprop || o.count % 2 === 0))
        || pick(o => o.fits && o.cap >= need)
        || opts.filter(o => o.fits).sort((a, b) => b.cap - a.cap)[0]
        || opts.slice().sort((a, b) => b.cap - a.cap)[0];
}

/**
 * Resolve every 'auto' slot to a concrete part. Unknown keys fall back to the
 * defaults, so a corrupt draft can never throw. Returns a NEW object carrying
 * the concrete values plus `auto` flags (which slots were auto).
 */
export function resolveBuild(build = {}) {
    const d = defaultBuild();
    const body = BODIES[build.body] ? build.body : d.body;
    const bd = bodyDefaults(body);
    const thruster = THRUSTER_UNITS[build.thruster] ? build.thruster : d.thruster;
    const isAuto = (v) => v == null || v === 'auto';
    const pickKey = (v, table, dflt) => (!isAuto(v) && table[v]) ? v : dflt;
    const fuelKg = clampNum(build.fuelKg, 0, 500_000, 0);
    const battery = pickKey(build.battery, BATTERIES, bd.battery);
    const adcs = pickKey(build.adcs, ADCS_UNITS, bd.adcs);
    const obc = pickKey(build.obc, OBC_UNITS, bd.obc);
    let tank, tankCount;
    if (!isAuto(build.tank) && TANKS[build.tank]) {
        tank = build.tank; tankCount = Math.max(1, Math.min(4, Math.round(+build.tankCount || 1)));
    } else {
        const a = autoTank(body, thruster, fuelKg,
            [ADCS_UNITS[adcs].dims, BATTERIES[battery].dims, OBC_UNITS[obc].dims]);
        tank = a.tank; tankCount = a.count;
    }
    let extras;
    if (Array.isArray(build.extras)) {
        extras = build.extras
            .filter(e => e && EXTRAS[e.k] && FACES[e.face])
            .slice(0, MAX_EXTRAS)
            .map(e => ({ k: e.k, face: e.face }));
    } else {
        extras = bd.extras.map(e => ({ ...e }));
    }
    const bodyCells = Array.isArray(build.bodyCells)
        ? build.bodyCells.filter(f => FACES[f]) : [...bd.bodyCells];
    return {
        body, thruster,
        thrusterCount: Math.max(1, Math.min(8, Math.round(build.thrusterCount || 1))),
        panel: PANELS[build.panel] ? build.panel : d.panel,
        panelSpan: clampNum(build.panelSpan, 0.3, 8, d.panelSpan),
        panelChord: clampNum(build.panelChord, 0.2, 2.5, CHORD_DEFAULT),
        payload: PAYLOADS[build.payload] ? build.payload : 'none',
        fuelKg, tank, tankCount,
        battery, adcs, obc,
        rcs: (!isAuto(build.rcs) && RCS_KITS[build.rcs]) ? build.rcs : 'auto',
        finish: pickKey(build.finish, FINISHES, bd.finish),
        radiator: isAuto(build.radiator) ? bd.radiator : clampNum(build.radiator, 0, 1, bd.radiator),
        bodyCells, extras,
        auto: {
            tank: isAuto(build.tank) || !TANKS[build.tank],
            battery: isAuto(build.battery), adcs: isAuto(build.adcs), obc: isAuto(build.obc),
            rcs: isAuto(build.rcs), finish: isAuto(build.finish), radiator: isAuto(build.radiator),
            bodyCells: !Array.isArray(build.bodyCells), extras: !Array.isArray(build.extras),
        },
    };
}

/**
 * Everything that changes the SHAPE of the craft (not its propellant load,
 * unless the load changes the auto-sized tanks). Renderers rebuild meshes
 * only when this string changes.
 */
export function geometrySignature(build) {
    const rb = resolveBuild(build);
    const { fuelKg, auto, ...shape } = rb;
    return JSON.stringify(shape);
}

/** Area (m²) of one bus face — the curved wall of a cylinder counts a quadrant. */
export function faceArea(body, face) {
    const [dx, dy, dz] = body.dims;
    const cyl = body.shape === 'cyl' || body.shape === 'tube';
    if (face === '+Z' || face === '-Z') return cyl ? Math.PI * dx * dx / 4 : dx * dy;
    if (cyl) return Math.PI * dx * dz / 4;
    return (face === '+X' || face === '-X') ? dy * dz : dx * dz;
}

/**
 * Itemised dry mass. Every entry: { slot, key, label, subsystem, mass, count }.
 * deriveDesign() sums `mass` (already × count); the layout kernel places
 * each entry. tierMods as in deriveDesign().
 */
export function massBreakdown(build, tierMods = null) {
    const rb = build && build.auto ? build : resolveBuild(build);
    const tm = tierMods || {};
    const b  = BODIES[rb.body];
    const tu = THRUSTER_UNITS[rb.thruster];
    const p  = PANELS[rb.panel];
    const pl = PAYLOADS[rb.payload];
    const plS = payloadScale(rb.body, b.dims, pl.shape);
    const items = [];
    const add = (slot, key, label, subsystem, mass, count = 1) =>
        items.push({ slot, key, label, subsystem, mass, count });

    const busMass = b.mass * ((tm.body || {}).massMul ?? 1);
    add('bus', rb.body, b.label, 'structure', busMass);
    add('thruster', rb.thruster, tu.label, 'propulsion',
        tu.unitMass * rb.thrusterCount * ((tm.thruster || {}).massMul ?? 1), rb.thrusterCount);
    const panelArea = wingArea(rb.panelSpan, rb.panelChord) * p.wings;
    add('panel', rb.panel, p.label, 'power', panelArea * p.areaKgM2 * ((tm.panel || {}).massMul ?? 1), p.wings);
    add('payload', rb.payload, pl.label, 'payload', pl.mass * plS ** 3 * ((tm.payload || {}).massMul ?? 1));
    add('harness', 'harness', 'Harness + power conditioning', 'power', harnessMass(b.mass));
    const bat = BATTERIES[rb.battery];
    add('battery', rb.battery, bat.label, 'power', bat.mass);
    const tk = TANKS[rb.tank];
    add('tank', rb.tank, tk.label, 'propulsion', tk.mass * rb.tankCount, rb.tankCount);
    const ad = ADCS_UNITS[rb.adcs];
    add('adcs', rb.adcs, ad.label, 'adcs', ad.mass);
    const ob = OBC_UNITS[rb.obc];
    add('obc', rb.obc, ob.label, 'avionics', ob.mass);
    if (rb.rcs !== 'auto' && rb.rcs !== 'none') {
        const kit = RCS_KITS[rb.rcs];
        add('rcs', rb.rcs, kit.label, 'propulsion', kit.mass, 4);
    }
    const cellArea = bodyCellArea(rb);
    if (cellArea > 0) add('cells', 'body_cells', 'Body-mounted cells', 'power', cellArea * BODY_CELL.kgM2);
    rb.extras.forEach((e, i) => {
        const x = EXTRAS[e.k];
        items.push({ slot: 'extra', key: e.k, label: x.label, subsystem: x.subsystem,
                     mass: x.mass, count: 1, index: i, face: e.face });
    });
    return items;
}

/** Cell area (m²) of the body-mounted strings (packing factor applied). */
export function bodyCellArea(rb) {
    const b = BODIES[rb.body];
    let a = 0;
    for (const f of rb.bodyCells) {
        // Radiator band on ±Y displaces cells there.
        const frac = (f === '+Y' || f === '-Y') ? (1 - rb.radiator) : 1;
        a += faceArea(b, f) * frac;
    }
    return a * BODY_CELL.packing;
}

/**
 * Derive flight-model parameters from a build.
 *
 * @param {object} build
 * @param {object} [presets] ENGINE_PRESETS from the flight engine. When
 *        supplied, thrust/isp are filled in (single source of truth).
 * @returns {{dryMass,area,cd,engine,thrusterCount,thrust,isp,
 *            bodyArea,panelArea,panelMass,
 *            power,powerReq,powerMargin,powerFrac,electric, …}}
 */
export function deriveDesign(build, presets = null, tierMods = null) {
    const rb = resolveBuild(build);
    const b  = BODIES[rb.body];
    const tu = THRUSTER_UNITS[rb.thruster];
    const p  = PANELS[rb.panel];
    const pl = PAYLOADS[rb.payload];
    const count = rb.thrusterCount;
    const plS = payloadScale(rb.body, b.dims, pl.shape);

    // ── Tier modifiers ──────────────────────────────────────────────────
    // tierMods is supplied by the progression module — { body:{massMul,...},
    // thruster:{...}, panel:{...}, payload:{...} } — so the builder stays
    // decoupled from XP/persistence. Missing entries default to 1× (Mk I).
    const tm = tierMods || {};
    const mB  = tm.body     || {};
    const mTu = tm.thruster || {};
    const mP  = tm.panel    || {};
    const mPl = tm.payload  || {};

    // Bus broadside ram area (largest face for box, side rectangle for cyl,
    // length × diameter for the long telescope tube).
    const [dx, dy, dz] = b.dims;
    const bodyArea = b.shape === 'cyl' || b.shape === 'tube'
        ? dx * dz                                   // diameter × length
        : Math.max(dx * dy, dx * dz, dy * dz);      // biggest box face

    const perWing = wingArea(rb.panelSpan, rb.panelChord);
    const totalPanelArea = perWing * p.wings;
    const panelRamArea = totalPanelArea * p.ramFactor * (mP.cdMul ?? 1);

    // Apply per-slot Cd multipliers to each contribution (Mk II/III bodies
    // are slicker, etc) — area is unchanged but blended Cd shifts.
    const bodyCdEff    = b.cd  * (mB.cdMul  ?? 1);
    const panelCdEff   = p.cd  * (mP.cdMul  ?? 1);
    const payloadCdEff = pl.cd * (mPl.cdMul ?? 1);
    const payloadArea  = pl.area * plS * plS;
    // Big deployables (reflectors, radiator panels) add ram area too.
    const extrasArea   = rb.extras.reduce((s, e) => s + (EXTRAS[e.k].area || 0), 0);
    const EXTRA_CD = 2.4;

    const area = bodyArea + panelRamArea + payloadArea + extrasArea;
    const cd = area > 0
        ? (bodyCdEff * bodyArea + panelCdEff * panelRamArea + payloadCdEff * payloadArea
           + EXTRA_CD * extrasArea) / area
        : bodyCdEff;

    const breakdown = massBreakdown(rb, tm);
    const dryMass = breakdown.reduce((s, it) => s + it.mass, 0);
    const panelMass = breakdown.find(it => it.slot === 'panel').mass;

    // ── Power budget ──────────────────────────────────────────────────────
    // Deployable wings track the sun: full rated power in sunlight. Body-
    // mounted cells see on average a quarter of their area (the projected
    // area of a convex body averaged over orientation is A/4), disclosed.
    const wingPower  = totalPanelArea * p.wPerM2 * (mP.wMul ?? 1);
    const cellArea   = bodyCellArea(rb);
    const cellPower  = cellArea / 4 * 1361 * BODY_CELL.eta * 0.9;
    const powerGen   = wingPower + cellPower;
    const electric   = tu.power > 0;
    const thrPwrFull = tu.power * count;                      // W at rated thrust
    const payloadW   = pl.powerW * plS * plS * (mPl.powerMul ?? 1);
    const unitsW     = OBC_UNITS[rb.obc].powerW + ADCS_UNITS[rb.adcs].powerW
                     + rb.extras.reduce((s, e) => s + EXTRAS[e.k].powerW, 0);
    const fixedLoad  = housekeepingW(rb.body) + payloadW + unitsW;
    const powerReq   = fixedLoad + (electric ? thrPwrFull : 0);
    const powerAvail = Math.max(0, powerGen - fixedLoad);
    const powerFrac  = electric
        ? (thrPwrFull > 0 ? Math.min(1, powerAvail / thrPwrFull) : 1)
        : 1;

    // Centre-of-pressure offset (m): the lever arm between the geometric
    // centre of drag and the centre of mass, used by the engine to compute
    // disturbance torques.
    const maxSide = Math.max(dx, dy, dz);
    const baseArm = maxSide * (b.momentArmMul ?? 0.18);
    const payloadArmRaw = pl.centreOffset * plS * (pl.mass * plS ** 3 / Math.max(1, dryMass));
    const copOffset = baseArm + payloadArmRaw * 0.5;

    // Thruster gimbal / throat life with tier mods. Default 1× (Mk I).
    const gimbalDeg   = tu.gimbalDeg   * (mTu.gimbalMul     ?? 1);
    const throatLifeS = tu.throatLifeS * (mTu.throatLifeMul ?? 1);

    // ── RCS suite: the bus's own ('auto') or a fitted kit ────────────────
    const kit = rb.rcs === 'auto' ? null : RCS_KITS[rb.rcs];
    const rcsSpec = kit ? (kit.thrust > 0 ? { thrust: kit.thrust, isp: kit.isp } : null) : (b.rcs || null);

    // ── Attitude control / slew authority ───────────────────────────────
    // How fast the bus can re-point (steer). RCS jets add a slew bonus and a
    // combined label; lighter craft turn faster (slew ∝ 1/√mass); a tiered
    // bus adds reaction-wheel authority (mB.slewMul). The flight model reads
    // slewRate [rad/s] for A/D steering; slewDeg/attSys are for the HUD. An
    // explicitly fitted ADCS suite replaces the bus's own actuator class.
    const adU = ADCS_UNITS[rb.adcs];
    const att = rb.auto.adcs
        ? (b.attCtrl || { sys: 'Reaction wheels', slewDeg: 1.0 })
        : { sys: adU.sys, slewDeg: adU.slewDeg };
    const rcsSlewBonus = rcsSpec ? 0.8 : 0;
    const massSlew = Math.max(0.5, Math.min(1.6, Math.sqrt(180 / Math.max(40, dryMass))));
    const slewDeg = round((att.slewDeg + rcsSlewBonus) * massSlew * (mB.slewMul ?? 1), 2);
    const attSys  = (rcsSpec && /wheel/i.test(att.sys)) ? `${att.sys} + RCS` : att.sys;

    const out = {
        dryMass:      round(dryMass, 1),
        area:         round(area, 3),
        cd:           round(cd, 3),
        engine:       rb.thruster,
        thrusterCount: count,
        bodyArea:     round(bodyArea, 3),
        panelArea:    round(totalPanelArea, 3),
        panelMass:    round(panelMass, 2),
        payload:      rb.payload,
        payloadMass:  round(pl.mass * plS ** 3 * (mPl.massMul ?? 1), 1),
        payloadArea:  round(payloadArea, 3),
        payloadPower: round(payloadW, 0),
        payloadScale: round(plS, 3),
        extrasArea:   round(extrasArea, 3),
        power:        round(powerGen, 0),
        wingPower:    round(wingPower, 0),
        cellPower:    round(cellPower, 1),
        cellArea:     round(cellArea, 4),
        fixedLoad:    round(fixedLoad, 1),
        housekeepingW: housekeepingW(rb.body),
        thrusterPowerW: electric ? thrPwrFull : 0,
        powerReq:     round(powerReq, 0),
        powerMargin:  round(powerGen - powerReq, 0),
        powerFrac:    round(powerFrac, 3),
        electric,
        gimbalDeg:    round(gimbalDeg, 1),
        gimbalRad:    gimbalDeg * Math.PI / 180,
        throatLifeS:  Math.round(throatLifeS),
        copOffset:    round(copOffset, 3),
        maxSide:      round(maxSide, 3),
        // ── Multidirectional RCS suite ───────────────────────────────────
        // Per-axis translation authority [N] and propellant Isp [s]. Zero /
        // false for buses with no translation clusters and no fitted kit.
        rcs:          !!rcsSpec,
        rcsThrust:    rcsSpec ? round(rcsSpec.thrust, 2) : 0,
        rcsIsp:       rcsSpec ? rcsSpec.isp : 0,
        // Attitude / steering authority (see above).
        slewDeg:      slewDeg,
        slewRate:     round(slewDeg * Math.PI / 180, 4),   // rad/s
        attSys:       attSys,
        // ── Subsystems (component library) ───────────────────────────────
        tank:         rb.tank,
        tankCount:    rb.tankCount,
        tankCapacityKg: round(tankCapacityKg(TANKS[rb.tank], rb.thruster) * rb.tankCount, 2),
        propellant:   propellantFor(rb.thruster).label,
        batteryWh:    BATTERIES[rb.battery].wh,
        resolved:     rb,
        breakdown,
    };
    if (presets && presets[rb.thruster]) {
        const ptu = presets[rb.thruster];
        out.thrust = round(ptu.thrust * count * powerFrac * (mTu.thrustMul ?? 1), 4);
        out.isp    = round(ptu.isp * (mTu.ispMul ?? 1), 1);
    }
    return out;
}

// ── helpers ─────────────────────────────────────────────────────────────────
function clampNum(v, lo, hi, dflt) {
    const n = Number(v);
    if (!isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
}
function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }

// ── self-test ───────────────────────────────────────────────────────────────
export function selfTest() {
    const out = [];
    const T = (c, m) => out.push({ pass: !!c, msg: m });
    const presets = {
        monoprop:      { thrust: 22,   isp: 225  },
        hall_ion:      { thrust: 0.25, isp: 1800 },
        hall_shielded: { thrust: 0.30, isp: 2000 },
    };

    const d = deriveDesign(defaultBuild(), presets);
    T(d.dryMass > 0 && d.area > 0 && d.cd >= 2 && d.cd <= 2.7,
        `default build sane (m=${d.dryMass}kg A=${d.area}m² Cd=${d.cd})`);
    T(d.thrust === 44 && d.isp === 225, `2× monoprop → 44 N / 225 s (got ${d.thrust}/${d.isp})`);

    // More thrusters → more dry mass.
    const t1 = deriveDesign({ ...defaultBuild(), thrusterCount: 1 }, presets);
    const t4 = deriveDesign({ ...defaultBuild(), thrusterCount: 4 }, presets);
    T(t4.dryMass > t1.dryMass, `+thrusters ⇒ +dry mass (${t1.dryMass} → ${t4.dryMass})`);

    // Bigger wings → more drag area AND more mass (the core trade-off).
    const s1 = deriveDesign({ ...defaultBuild(), panelSpan: 1 }, presets);
    const s5 = deriveDesign({ ...defaultBuild(), panelSpan: 5 }, presets);
    T(s5.area > s1.area && s5.dryMass > s1.dryMass,
        `+wing span ⇒ +area & +mass (A ${s1.area}→${s5.area})`);

    // No panels AND no payload ⇒ Cd collapses to the bare bus value.
    const np = deriveDesign({ ...defaultBuild(), panel: 'none', payload: 'none' }, presets);
    T(Math.abs(np.cd - BODIES[defaultBuild().body].cd) < 1e-6,
        `no panels & no payload ⇒ Cd = bus Cd (${np.cd})`);

    // A big bus is heavier and draggier than a CubeSat.
    const cube = deriveDesign({ ...defaultBuild(), body: 'cubesat_3u', panel: 'none', payload: 'none' }, presets);
    const big = deriveDesign({ ...defaultBuild(), body: 'bus_med', panel: 'none', payload: 'none' }, presets);
    T(big.dryMass > cube.dryMass && big.area > cube.area,
        `bus_med ≫ 3U (m ${cube.dryMass}→${big.dryMass}, A ${cube.area}→${big.area})`);

    // ── Power budget ──────────────────────────────────────────────────────
    // Arrays generate power; power scales with span.
    const pw1 = deriveDesign({ ...defaultBuild(), panelSpan: 1 }, presets);
    const pw5 = deriveDesign({ ...defaultBuild(), panelSpan: 5 }, presets);
    T(pw5.power > pw1.power && pw1.power > 0,
        `array power grows with span (${pw1.power} → ${pw5.power} W)`);

    // An electric thruster on a body-only build is starved → ~no thrust.
    const epStarved = deriveDesign(
        { body: 'smallsat', thruster: 'hall_shielded', thrusterCount: 1,
          panel: 'none', panelSpan: 2 }, presets);
    T(epStarved.electric && epStarved.powerFrac === 0 && epStarved.thrust === 0,
        `electric + no panels ⇒ 0 thrust (frac ${epStarved.powerFrac})`);
    T(epStarved.powerMargin < 0, `starved EP shows negative power margin`);

    // Give it a big quad array → full rated thrust, positive margin.
    const epFed = deriveDesign(
        { body: 'smallsat', thruster: 'hall_shielded', thrusterCount: 1,
          panel: 'quad', panelSpan: 6 }, presets);
    T(epFed.powerFrac === 1 && Math.abs(epFed.thrust - 0.30) < 1e-6,
        `electric + ample power ⇒ rated thrust (${epFed.thrust} N)`);
    T(epFed.powerMargin > 0, `well-fed EP shows positive power margin`);

    // Chemical thrust is power-independent: same with or without panels.
    const chemNo = deriveDesign({ ...defaultBuild(), panel: 'none' }, presets);
    const chemBig = deriveDesign({ ...defaultBuild(), panel: 'large', panelSpan: 5 }, presets);
    T(chemNo.thrust === chemBig.thrust && chemNo.electric === false,
        `chemical thrust ignores power (${chemNo.thrust} N both)`);

    // ROSA beats rigid on specific power (W per kg of array).
    const span = 5;
    const rosa = deriveDesign({ ...defaultBuild(), panel: 'rosa',  panelSpan: span }, presets);
    const rigid = deriveDesign({ ...defaultBuild(), panel: 'large', panelSpan: span }, presets);
    T(rosa.power / rosa.panelMass > rigid.power / rigid.panelMass,
        `ROSA > rigid on W/kg (${(rosa.power/rosa.panelMass).toFixed(0)} vs ${(rigid.power/rigid.panelMass).toFixed(0)})`);

    // ── Multidirectional RCS suite ────────────────────────────────────────
    // The bigger buses carry RCS clusters; CubeSats don't. The orbital tug
    // has the strongest per-axis authority of the lot.
    const cubeRcs = deriveDesign({ ...defaultBuild(), body: 'cubesat_3u' }, presets);
    const smallRcs = deriveDesign({ ...defaultBuild(), body: 'smallsat' }, presets);
    const tugRcs = deriveDesign({ ...defaultBuild(), body: 'tug' }, presets);
    T(cubeRcs.rcs === false && cubeRcs.rcsThrust === 0,
        `CubeSat carries no RCS (rcs=${cubeRcs.rcs})`);
    T(smallRcs.rcs === true && smallRcs.rcsThrust > 0 && smallRcs.rcsIsp > 0,
        `SmallSat has RCS (${smallRcs.rcsThrust} N @ ${smallRcs.rcsIsp}s)`);
    T(tugRcs.rcs === true && tugRcs.rcsThrust > smallRcs.rcsThrust,
        `tug RCS ≫ smallsat (${smallRcs.rcsThrust} → ${tugRcs.rcsThrust} N)`);

    // ── Attitude / slew authority ─────────────────────────────────────────
    // Every design names a steering system and a positive slew rate. CMG and
    // RCS buses out-slew a plain reaction-wheel bus; a bus tier upgrade adds
    // authority.
    const scope = deriveDesign({ ...defaultBuild(), body: 'telescope' }, presets);
    const medBus = deriveDesign({ ...defaultBuild(), body: 'bus_med' }, presets);
    T(medBus.slewRate > 0 && /wheel|RCS/i.test(medBus.attSys),
        `bus reports slew + attitude system (${medBus.slewDeg}°/s · ${medBus.attSys})`);
    T(scope.slewDeg > medBus.slewDeg,
        `CMG telescope out-slews medium bus (${medBus.slewDeg} < ${scope.slewDeg} °/s)`);
    T(/RCS/.test(tugRcs.attSys),
        `tug steers on RCS (${tugRcs.attSys})`);
    const med3 = PROG_BODY_T3(medBus); // computed below via tier mods
    T(med3 > medBus.slewDeg, `bus tier-III adds slew authority (${medBus.slewDeg} → ${med3} °/s)`);

    return out;
}

// Helper for the slew tier self-test — re-derives a medium bus with the
// Mk III body slew bonus applied, mirroring the progression tierMods shape.
function PROG_BODY_T3(_baseline) {
    const d = deriveDesign({ body: 'bus_med', thruster: 'monoprop', thrusterCount: 2,
        panel: 'dual', panelSpan: 2.2, payload: 'optical_cam' },
        { monoprop: { thrust: 22, isp: 225 } },
        { body: { massMul: 0.85, cdMul: 0.92, slewMul: 1.28 } });
    return d.slewDeg;
}
