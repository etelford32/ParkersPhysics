/**
 * mission-positions.js — PURE placement kernel for the missions map.
 *
 * Where a spacecraft is drawn when nothing LIVE says otherwise, and how a
 * live vector is folded into the drawn scale. No DOM, no fetch, no three.js —
 * node-gated by tests/mission-positions.mjs. js/missions-3d.js is the only
 * renderer; js/mission-ephemeris.js supplies the live samples.
 *
 * Frame: heliocentric ecliptic, AU. x toward the vernal equinox, z = ecliptic
 * north. The renderer maps (x, y, z) → three.js (x, z, −y). Planets come from
 * js/horizons.js (Meeus, ecliptic OF DATE); Horizons vectors are ECLIPJ2000.
 * The 0.37° of precession between them is 0.006 AU at 1 AU — a third of the
 * drawn Earth's radius — and is invisible here; LOCAL offsets (spacecraft −
 * host) are taken between two Horizons vectors so it cancels exactly.
 *
 * ── THE ONE DISHONEST FUNCTION, DISCLOSED ───────────────────────────────────
 * The planets are drawn hundreds of times too large (Earth 0.018 AU, 422 ×
 * real) so they can be seen at all on a 60 AU stage. At that scale every
 * Earth-neighbourhood object — ISS, SDO, the L1 sentinels at 0.01 AU, JWST at
 * L2, even the Moon — sits INSIDE the drawn sphere and is depth-killed, which
 * is exactly what the page did until 2026-11: SOHO/ACE/WIND/DSCOVR/IMAP were
 * placed at the real L1 displacement (0.01 AU) inside a 0.018 AU Earth and
 * never rendered. `localSceneOffset` therefore compresses geocentric (and
 * areocentric, jovicentric, selenocentric) distance LOGARITHMICALLY:
 *
 *     drawn = R_draw(host) · (1 + LOCAL_K · ln(r / R_host))      for r ≥ R_host
 *
 * with LOCAL_K chosen so Sun–Earth L1/L2 (235 R⊕) land at 5 drawn radii —
 * ISS hugs the surface (1.04 R), GEO is 2.4 R, the Moon 4.0 R, L1/L2 5.0 R.
 * Direction is exact; only radial distance is compressed, and the legend on
 * the page says so. True-scale is the orrery's job, not this map's.
 *
 * Placement types (MISSION_LOCS):
 *   lagrange        Sun–host L1 or L2 (sunward / anti-sunward of the host)
 *   local           orbit about a host: r_km, period_min, inc_deg (phase from JD)
 *   surface         pinned lon/lat on the host (Mars rovers)
 *   helio_kepler    independent heliocentric Kepler orbit (a, e, period, peri_jd)
 *   helio_fixed     far probes: ecliptic lon/lat + r at epoch + radial rate
 *   cruise          interpolated transfer between two bodies, by date
 *   completed_at    marker parked beside the host (mission ended there)
 *   lost            no position (card only)
 */

export const KM_PER_AU = 149597870.7;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Drawn radii (AU) — the renderer's PLANET_VIS reads the same table. */
export const DRAW_RADIUS_AU = Object.freeze({
    sun: 0.045, mercury: 0.012, venus: 0.018, earth: 0.018, moon: 0.006,
    mars: 0.014, jupiter: 0.034, saturn: 0.030, uranus: 0.024, neptune: 0.024,
});

/** Mean equatorial radii, km. */
export const HOST_RADIUS_KM = Object.freeze({
    earth: 6371.0, moon: 1737.4, mars: 3389.5, jupiter: 69911, saturn: 58232,
    venus: 6051.8, mercury: 2439.7,
});

export const MOON_DIST_KM = 384400;
export const LAGRANGE_KM  = 1.5e6;                    // Sun–Earth L1/L2 displacement
/** Derived, not typed: L1 at 235 R⊕ lands at 5 drawn radii. */
export const LOCAL_K = 4 / Math.log(LAGRANGE_KM / HOST_RADIUS_KM.earth);

/** Compressed drawn distance (AU) for an offset of `rKm` from `host`. */
export function localSceneDistance(rKm, host) {
    const Rh = HOST_RADIUS_KM[host];
    const Rd = DRAW_RADIUS_AU[host];
    if (!(Rh > 0) || !(Rd > 0)) throw new Error(`localSceneDistance: unknown host ${host}`);
    const rho = rKm / Rh;
    if (!(rho > 1)) return Rd * Math.max(0, rho);
    return Rd * (1 + LOCAL_K * Math.log(rho));
}

/** Compress a host-relative offset (km, any frame) keeping its direction. */
export function localSceneOffset(dxKm, dyKm, dzKm, host) {
    const r = Math.hypot(dxKm, dyKm, dzKm);
    if (!(r > 0)) return { x: 0, y: 0, z: 0 };
    const s = localSceneDistance(r, host) / r;
    return { x: dxKm * s, y: dyKm * s, z: dzKm * s };
}

/** Inverse of localSceneDistance (for the legend / tests). */
export function localRealDistanceKm(drawnAU, host) {
    const Rh = HOST_RADIUS_KM[host], Rd = DRAW_RADIUS_AU[host];
    const f = drawnAU / Rd;
    return f <= 1 ? f * Rh : Rh * Math.exp((f - 1) / LOCAL_K);
}

// ── Frames ──────────────────────────────────────────────────────────────────

const OBLIQUITY_J2000 = 23.4392911 * D2R;

/** TEME/equatorial (x, y, z) → ecliptic (rotation about +x by the obliquity). */
export function equatorialToEcliptic(v) {
    const c = Math.cos(OBLIQUITY_J2000), s = Math.sin(OBLIQUITY_J2000);
    return { x: v.x, y: c * v.y + s * v.z, z: -s * v.y + c * v.z };
}

// ── Per-mission placement config ────────────────────────────────────────────
// Approximate Kepler elements for heliocentric spacecraft come from published
// mission profiles. Sub-degree precision is NOT the goal — live Horizons
// vectors replace these whenever the route resolves the spacecraft; this is
// the disclosed fallback ('model') and the gate only checks it is sane.

export function jdFromISO(s) {
    const t = Date.parse(s.length <= 10 ? `${s}T00:00:00Z` : s);
    return t / 86400000 + 2440587.5;
}

export const MISSION_LOCS = Object.freeze({
    // ── Sun–Earth L1 sentinels ──────────────────────────────────────────────
    'soho':        { type: 'lagrange', host: 'earth', point: 1 },
    'ace':         { type: 'lagrange', host: 'earth', point: 1 },
    'wind':        { type: 'lagrange', host: 'earth', point: 1 },
    'dscovr':      { type: 'lagrange', host: 'earth', point: 1 },
    'imap':        { type: 'lagrange', host: 'earth', point: 1 },
    'carruthers':  { type: 'lagrange', host: 'earth', point: 1 },
    'swfo-l1':     { type: 'lagrange', host: 'earth', point: 1 },
    'aditya-l1':   { type: 'lagrange', host: 'earth', point: 1 },
    // ── Sun–Earth L2 observatories ──────────────────────────────────────────
    'jwst':        { type: 'lagrange', host: 'earth', point: 2 },
    'euclid':      { type: 'lagrange', host: 'earth', point: 2 },
    'roman':       { type: 'lagrange', host: 'earth', point: 2 },
    // ESCAPADE loitered near L2 until its Nov 2026 Earth flyby; after the
    // burns it is on a trans-Mars cruise. The cruise entry takes over on the
    // burn date; Horizons supersedes both.
    'escapade': {
        type: 'cruise', from: 'earth', to: 'mars',
        launch_jd: jdFromISO('2026-11-09'), arrive_jd: jdFromISO('2027-09-15'),
        before: { type: 'lagrange', host: 'earth', point: 2 },
    },

    // ── Earth orbit (real radii; drawn through localSceneDistance) ──────────
    'iss':         { type: 'local', host: 'earth', r_km: 6371 + 415,   period_min: 92.9,  inc_deg: 51.6 },
    'tiangong':    { type: 'local', host: 'earth', r_km: 6371 + 390,   period_min: 92.4,  inc_deg: 41.5 },
    'hubble':      { type: 'local', host: 'earth', r_km: 6371 + 515,   period_min: 95.0,  inc_deg: 28.5 },
    'sdo':         { type: 'local', host: 'earth', r_km: 42164,        period_min: 1436,  inc_deg: 28.0 },
    'goes-19':     { type: 'local', host: 'earth', r_km: 42164,        period_min: 1436,  inc_deg: 0.1  },
    'punch':       { type: 'local', host: 'earth', r_km: 6371 + 650,   period_min: 97.7,  inc_deg: 97.9 },
    'spherex':     { type: 'local', host: 'earth', r_km: 6371 + 650,   period_min: 97.7,  inc_deg: 97.9 },
    'pandora':     { type: 'local', host: 'earth', r_km: 6371 + 600,   period_min: 96.7,  inc_deg: 97.8 },
    'hinode':      { type: 'local', host: 'earth', r_km: 6371 + 680,   period_min: 98.4,  inc_deg: 98.1 },
    'iris':        { type: 'local', host: 'earth', r_km: 6371 + 670,   period_min: 98.2,  inc_deg: 97.9 },
    'ibex':        { type: 'local', host: 'earth', r_km: 190000,       period_min: 13100, inc_deg: 33   },
    'smile':       { type: 'local', host: 'earth', r_km: 6371 + 63000, period_min: 3060,  inc_deg: 70   },
    'proba-3':     { type: 'local', host: 'earth', r_km: 6371 + 30500, period_min: 1178,  inc_deg: 59   },

    // ── Independent heliocentric orbiters ───────────────────────────────────
    // Parker Solar Probe — final orbit (a≈0.388 AU, e≈0.853, P≈88 d).
    // Perihelion 29 occurred 2026-09-04 14:53 UT; subsequent perihelia repeat every 88 d.
    'parker-solar-probe': {
        type: 'helio_kepler', a: 0.388, e: 0.853, period_d: 88,
        peri_jd: jdFromISO('2026-09-04T14:53:00Z'), lon_peri_deg: 80, inc_deg: 3.4,
    },
    // Solar Orbiter — a≈0.605 AU, e≈0.45, P≈168 d, perihelion ~0.29 AU.
    'solar-orbiter': {
        type: 'helio_kepler', a: 0.605, e: 0.45, period_d: 168,
        peri_jd: jdFromISO('2026-03-30'), lon_peri_deg: 175, inc_deg: 17.0,
    },
    // STEREO-A — a≈0.957 AU, e≈0.0066, slowly pulling ahead of Earth after the Aug 2023 pass.
    'stereo-a': {
        type: 'helio_kepler', a: 0.957, e: 0.0066, period_d: 346,
        peri_jd: jdFromISO('2026-01-01'), lon_peri_deg: 0, inc_deg: 0.13,
        lead_earth_deg: 20,
    },
    // OSIRIS-APEX — heliocentric en route to Apophis (April 2029).
    'osiris-apex': {
        type: 'helio_kepler', a: 1.04, e: 0.20, period_d: 388,
        peri_jd: jdFromISO('2024-09-01'), lon_peri_deg: 200, inc_deg: 3.0,
    },
    // Hayabusa2# — heliocentric to 1998 KY26 (~2031).
    'hayabusa2-extended': {
        type: 'helio_kepler', a: 1.05, e: 0.20, period_d: 393,
        peri_jd: jdFromISO('2024-04-01'), lon_peri_deg: 300, inc_deg: 5.0,
    },
    // Tianwen-2 — station-keeping at Kamoʻoalewa, a quasi-satellite of Earth
    // (a≈1.001 AU, e≈0.104, i≈7.8°; perihelion 2026-02-02 ± weeks).
    'tianwen-2': {
        type: 'helio_kepler', a: 1.001, e: 0.104, period_d: 366,
        peri_jd: jdFromISO('2026-02-02'), lon_peri_deg: 66, inc_deg: 7.8,
    },
    // Lucy — a≈3.9 AU heading for L4 Trojans; Eurybates Aug 2027.
    'lucy': {
        type: 'cruise', from: 'earth', to: 'jupiter',
        launch_jd: jdFromISO('2025-04-20'), arrive_jd: jdFromISO('2027-08-11'),
    },
    'europa-clipper': {
        type: 'helio_kepler', a: 1.11, e: 0.11, period_d: 427,
        peri_jd: jdFromISO('2026-12-03'), lon_peri_deg: 71, inc_deg: 1.0,
    },
    'juice': {
        type: 'helio_kepler', a: 1.33, e: 0.26, period_d: 560,
        peri_jd: jdFromISO('2026-09-28'), lon_peri_deg: 5, inc_deg: 1.0,
    },
    // Far probes: ecliptic lon/lat + distance at epoch, radial rate (AU/yr).
    'new-horizons': { type: 'helio_fixed', lon_deg: 296, lat_deg:  1.3, r_au: 62.2,  dr_au_yr: 2.98, epoch_jd: jdFromISO('2026-11-01') },
    'voyager-1':    { type: 'helio_fixed', lon_deg: 256, lat_deg: 35.0, r_au: 168.2, dr_au_yr: 3.58, epoch_jd: jdFromISO('2026-11-01') },
    'voyager-2':    { type: 'helio_fixed', lon_deg: 290, lat_deg: -35.0, r_au: 140.4, dr_au_yr: 3.26, epoch_jd: jdFromISO('2026-11-01') },

    // ── Inner-planet missions ───────────────────────────────────────────────
    'bepicolombo': {
        type: 'cruise', from: 'earth', to: 'mercury',
        launch_jd: jdFromISO('2018-10-20'), arrive_jd: jdFromISO('2026-11-21'),
        after: { type: 'local', host: 'mercury', r_km: 2440 + 1500, period_min: 140, inc_deg: 90 },
    },
    'messenger': { type: 'completed_at', host: 'mercury' },
    'akatsuki':  { type: 'completed_at', host: 'venus' },

    // ── Small bodies ────────────────────────────────────────────────────────
    'dart':   { type: 'lost' },
    // Hera — arrives at Didymos (a≈1.64 AU) in Nov 2026; drawn along the
    // Earth→Didymos-region transfer until the live vector takes over.
    'hera':   {
        type: 'cruise', from: 'earth', to: 'mars',
        launch_jd: jdFromISO('2024-10-07'), arrive_jd: jdFromISO('2026-11-30'),
    },
    'psyche': {
        type: 'cruise', from: 'mars', to: 'jupiter',
        launch_jd: jdFromISO('2026-05-15'), arrive_jd: jdFromISO('2029-08-01'),
        before: { type: 'cruise', from: 'earth', to: 'mars',
                  launch_jd: jdFromISO('2023-10-13'), arrive_jd: jdFromISO('2026-05-15') },
    },

    // ── Mars fleet (real orbital radii, compressed on draw) ─────────────────
    'mars-reconnaissance-orbiter': { type: 'local', host: 'mars', r_km: 3390 + 290,   period_min: 112,  inc_deg: 92.6 },
    'mars-odyssey':                { type: 'local', host: 'mars', r_km: 3390 + 400,   period_min: 118,  inc_deg: 93.1 },
    'maven':                       { type: 'completed_at', host: 'mars' },
    'mars-express':                { type: 'local', host: 'mars', r_km: 3390 + 5200,  period_min: 404,  inc_deg: 86.9 },
    'exomars-tgo':                 { type: 'local', host: 'mars', r_km: 3390 + 400,   period_min: 118,  inc_deg: 74   },
    'tianwen-1':                   { type: 'local', host: 'mars', r_km: 3390 + 6130,  period_min: 453,  inc_deg: 86.9 },
    'hope-emm':                    { type: 'local', host: 'mars', r_km: 3390 + 31500, period_min: 3300, inc_deg: 25   },
    'curiosity':                   { type: 'surface', host: 'mars', lon_deg: 137.4, lat_deg: -4.6 },
    'perseverance':                { type: 'surface', host: 'mars', lon_deg:  77.5, lat_deg: 18.4 },
    'mmx': {
        type: 'cruise', from: 'earth', to: 'mars',
        launch_jd: jdFromISO('2026-10-20'), arrive_jd: jdFromISO('2027-08-01'),
    },

    // ── Outer system ────────────────────────────────────────────────────────
    'juno':    { type: 'local', host: 'jupiter', r_km: 69911 * 8, period_min: 33 * 1440, inc_deg: 90 },
    'cassini': { type: 'completed_at', host: 'saturn' },

    // ── Moon ────────────────────────────────────────────────────────────────
    'lro':        { type: 'local', host: 'moon', r_km: 1737 + 90,  period_min: 113, inc_deg: 90 },
    'danuri':     { type: 'local', host: 'moon', r_km: 1737 + 100, period_min: 118, inc_deg: 90 },
    'artemis-ii': { type: 'completed_at', host: 'moon' },

    // ── Retired / planned (card only) ───────────────────────────────────────
    'helios-a':   { type: 'lost' },
    'ulysses':    { type: 'lost' },
    'mariner-10': { type: 'lost' },
    'gaia':       { type: 'lost' },
});

/** Resolve the time-dependent branch of a placement (before/after a date). */
export function resolveLoc(loc, jd) {
    if (!loc) return null;
    if (loc.before && loc.launch_jd != null && jd < loc.launch_jd) return resolveLoc(loc.before, jd);
    if (loc.after  && loc.arrive_jd != null && jd >= loc.arrive_jd) return resolveLoc(loc.after, jd);
    return loc;
}

/** Stable [0,1) hash for a string id — used to phase-jitter co-located markers. */
export function hashId(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return ((h % 1000) + 1000) % 1000 / 1000;
}

/** Solve Kepler's equation E − e·sin(E) = M (Newton). */
export function solveKepler(M, e) {
    let E = e < 0.8 ? M : Math.PI;
    for (let i = 0; i < 30; i++) {
        const f  = E - e * Math.sin(E) - M;
        const fp = 1 - e * Math.cos(E);
        const dE = f / fp;
        E -= dE;
        if (Math.abs(dE) < 1e-12) break;
    }
    return E;
}

/** Heliocentric XYZ (AU) for a Kepler orbit definition at `jd`. */
export function keplerPos(loc, jd) {
    const M = ((jd - loc.peri_jd) / loc.period_d) * 2 * Math.PI;
    const E = solveKepler(((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), loc.e);
    const cosE = Math.cos(E), sinE = Math.sin(E);
    const xPF = loc.a * (cosE - loc.e);
    const yPF = loc.a * Math.sqrt(1 - loc.e * loc.e) * sinE;
    const peri = (loc.lon_peri_deg || 0) * D2R;
    const inc  = (loc.inc_deg     || 0) * D2R;
    const cosO = Math.cos(peri), sinO = Math.sin(peri);
    const xR = xPF * cosO - yPF * sinO;
    const yR = xPF * sinO + yPF * cosO;
    return { x_AU: xR, y_AU: yR * Math.cos(inc), z_AU: yR * Math.sin(inc) };
}

/** STEREO-A style: locked at a fixed angular lead ahead of Earth's longitude. */
export function leadEarthPos(loc, earthVec) {
    const earthLon = Math.atan2(earthVec.y_AU, earthVec.x_AU);
    const lon = earthLon + (loc.lead_earth_deg || 0) * D2R;
    return { x_AU: loc.a * Math.cos(lon), y_AU: loc.a * Math.sin(lon), z_AU: 0 };
}

/** Sun–host L1/L2, drawn at the compressed displacement along the Sun–host line. */
export function lagrangePos(loc, hostVec) {
    const r = Math.hypot(hostVec.x_AU, hostVec.y_AU, hostVec.z_AU);
    const sign = loc.point === 2 ? +1 : -1;
    const dAU = localSceneDistance(LAGRANGE_KM, loc.host);
    const k = 1 + sign * dAU / r;
    return { x_AU: hostVec.x_AU * k, y_AU: hostVec.y_AU * k, z_AU: hostVec.z_AU * k };
}

/** Phased orbit about a host, real radius compressed on draw. */
export function localOrbitPos(centerVec, loc, jd, missionId) {
    const drawn = localSceneDistance(loc.r_km, loc.host);
    const P = (loc.period_min || 1440) / 1440;
    const inc = (loc.inc_deg || 0) * D2R;
    const phi = ((jd / P) + hashId(missionId)) * 2 * Math.PI;
    const x = drawn * Math.cos(phi);
    const y = drawn * Math.sin(phi) * Math.cos(inc);
    const z = drawn * Math.sin(phi) * Math.sin(inc);
    return { x_AU: centerVec.x_AU + x, y_AU: centerVec.y_AU + y, z_AU: centerVec.z_AU + z };
}

/** Pinned surface point — lon/lat on the drawn sphere (illustrative orientation). */
export function surfacePos(centerVec, loc) {
    const r   = DRAW_RADIUS_AU[loc.host] * 1.02;
    const lon = (loc.lon_deg || 0) * D2R;
    const lat = (loc.lat_deg || 0) * D2R;
    return {
        x_AU: centerVec.x_AU + r * Math.cos(lat) * Math.cos(lon),
        y_AU: centerVec.y_AU + r * Math.cos(lat) * Math.sin(lon),
        z_AU: centerVec.z_AU + r * Math.sin(lat),
    };
}

function lerpPos(a, b, f) {
    return {
        x_AU: a.x_AU * (1 - f) + b.x_AU * f,
        y_AU: a.y_AU * (1 - f) + b.y_AU * f,
        z_AU: a.z_AU * (1 - f) + b.z_AU * f,
    };
}

/** Transfer between two bodies by date, bowed slightly outward from the Sun. */
export function cruisePos(loc, jd, planets) {
    const f = Math.max(0, Math.min(1, (jd - loc.launch_jd) / (loc.arrive_jd - loc.launch_jd)));
    const lin = lerpPos(planets[loc.from], planets[loc.to], f);
    const r = Math.hypot(lin.x_AU, lin.y_AU, lin.z_AU);
    const bow = 0.06 * Math.sin(f * Math.PI);
    const k = r > 0 ? (r + bow) / r : 1;
    return { x_AU: lin.x_AU * k, y_AU: lin.y_AU * k, z_AU: lin.z_AU * k };
}

/** Far probe: fixed direction, distance growing at its published rate. */
export function helioFixedPos(loc, jd) {
    const r = loc.r_au + loc.dr_au_yr * (jd - loc.epoch_jd) / 365.25;
    const lon = loc.lon_deg * D2R, lat = loc.lat_deg * D2R;
    return { x_AU: r * Math.cos(lat) * Math.cos(lon), y_AU: r * Math.cos(lat) * Math.sin(lon), z_AU: r * Math.sin(lat) };
}

/**
 * Model position for a mission. `planets` holds heliocentric vectors for
 * every host (mercury … neptune + moon, which the renderer derives from
 * Earth + the compressed Moon offset). Returns null for 'lost'.
 */
export function computeMissionPos(mission, loc0, jd, planets) {
    const loc = resolveLoc(loc0, jd);
    if (!loc) return null;
    const host = loc.host && planets[loc.host];
    switch (loc.type) {
        case 'lagrange':     return host ? lagrangePos(loc, host) : null;
        case 'local':        return host ? localOrbitPos(host, loc, jd, mission.id) : null;
        case 'surface':      return host ? surfacePos(host, loc) : null;
        case 'helio_kepler': return loc.lead_earth_deg != null ? leadEarthPos(loc, planets.earth) : keplerPos(loc, jd);
        case 'helio_fixed':  return helioFixedPos(loc, jd);
        case 'cruise':       return (planets[loc.from] && planets[loc.to]) ? cruisePos(loc, jd, planets) : null;
        case 'completed_at': return host ? localOrbitPos(host, { host: loc.host, r_km: HOST_RADIUS_KM[loc.host] * 1.6, period_min: 1e9 }, 0, mission.id) : null;
        default:             return null;
    }
}

/** Human label for a placement (the HUD's "where"). */
export function locationLabel(loc0, jd) {
    const loc = resolveLoc(loc0, jd);
    if (!loc) return '';
    const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;
    switch (loc.type) {
        case 'lagrange':     return `Sun–${cap(loc.host)} L${loc.point}`;
        case 'local':        return `${cap(loc.host)} orbit`;
        case 'surface':      return `${cap(loc.host)} surface`;
        case 'helio_kepler': return 'Heliocentric orbit';
        case 'helio_fixed':  return 'Outer heliosphere / interstellar';
        case 'cruise':       return `Cruise: ${cap(loc.from)} → ${cap(loc.to)}`;
        case 'completed_at': return `${cap(loc.host)} (mission ended)`;
        default:             return '';
    }
}

/**
 * Fold a LIVE heliocentric vector (AU, ecliptic) into the drawn frame.
 *   • a host-local mission (loc.host set, type lagrange/local/surface) keeps
 *     its exact direction from the host and gets the compressed distance,
 *     anchored on the DRAWN host — the live spacecraft and live host vectors
 *     must come from the same source (both Horizons) so the offset is real;
 *   • everything else is drawn where it is (1 unit = 1 AU).
 * Returns { x_AU, y_AU, z_AU, r_host_km } (r_host_km only for local draws).
 */
export function liveToDrawn(loc0, jd, liveSc, liveHost, drawnHost) {
    const loc = resolveLoc(loc0, jd);
    const isLocal = loc && loc.host && (loc.type === 'lagrange' || loc.type === 'local' || loc.type === 'surface');
    if (!isLocal || !liveHost || !drawnHost) {
        return { x_AU: liveSc.x_AU, y_AU: liveSc.y_AU, z_AU: liveSc.z_AU, r_host_km: null };
    }
    const dx = (liveSc.x_AU - liveHost.x_AU) * KM_PER_AU;
    const dy = (liveSc.y_AU - liveHost.y_AU) * KM_PER_AU;
    const dz = (liveSc.z_AU - liveHost.z_AU) * KM_PER_AU;
    const o = localSceneOffset(dx, dy, dz, loc.host);
    return {
        x_AU: drawnHost.x_AU + o.x, y_AU: drawnHost.y_AU + o.y, z_AU: drawnHost.z_AU + o.z,
        r_host_km: Math.hypot(dx, dy, dz),
    };
}

/** Geocentric TEME km (SGP4 output) → drawn position about the drawn Earth. */
export function temeToDrawn(temeKm, drawnEarth) {
    const e = equatorialToEcliptic(temeKm);
    const o = localSceneOffset(e.x, e.y, e.z, 'earth');
    return {
        x_AU: drawnEarth.x_AU + o.x, y_AU: drawnEarth.y_AU + o.y, z_AU: drawnEarth.z_AU + o.z,
        r_host_km: Math.hypot(e.x, e.y, e.z),
    };
}

export const _internal = { OBLIQUITY_J2000, R2D };
