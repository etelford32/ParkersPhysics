/**
 * upper-atmosphere-sat-suites.js — where the satellites sit (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * The kernel behind upper-atmosphere.html's "Satellite suites" overlay: the
 * whole CelesTrak catalogue the site relays (/api/celestrak/tle), grouped
 * into suites, drawn as live SGP4 dots (js/satellite-tracker.js — NOT this
 * file) plus the two things a dot cloud cannot show on its own:
 *
 *   • ORBIT RINGS — the instantaneous two-body ellipse of a member's MEAN
 *     elements, with the secular J2 drift of the node, perigee and mean
 *     anomaly carried to the scene instant. A dot says where a satellite IS;
 *     the ring says which shell and which PLANE it lives in, which is what
 *     makes a Walker constellation legible (Starlink's 72 planes, GPS's 6).
 *     The ring is a MEAN-element curve and SGP4's short-period J2 terms move
 *     the real satellite ±~10 km about it — `tests/upper-atmosphere-sat-
 *     suites.mjs` MEASURES that against the committed SGP4 WASM and gates it.
 *
 *   • THE ALTITUDE LADDER — every loaded object's mean altitude binned
 *     against the page's OWN layer table (`ATMOSPHERIC_LAYERS` from the
 *     engine — the one-model rule: this file never re-types a boundary), so
 *     the panel can say how many objects ride the thermosphere, where drag
 *     lives, and how many sit in the exosphere or above it (MEO / GEO).
 *
 * plus the camera's framing rule for a suite: the distance at which the
 * suite's outer shell fits the BINDING half-angle of the lens (the smaller of
 * the vertical and horizontal — the neo-watch `_distanceToFit` lesson; a
 * phone is portrait). From the page's home view (3.4 R⊕) GPS at 4.2 R⊕ and
 * GEO at 6.6 R⊕ are BEHIND the camera, which is why framing exists.
 *
 * FRAMES. SGP4 works in TEME; the page's scene is Earth-FIXED with +Y north
 * and −Z = 90°E (js/geo/coords.js `eciToEcef`: rotate −GMST about z, then
 * (x, y, z)_ecef → (x, z, −y)). `temeToScene` is that map, transcribed, and
 * the GMST is the page's own (js/sun-altitude.js), which agrees with the
 * tracker's coords.js copy to ~0.1 arcsec. One scene unit is the PAGE datum,
 * 6371 km (js/upper-atmosphere-datum.js). For a ring that is rebuilt rarely, the
 * renderer builds it at GMST = 0 and turns the group by `rotation.y = −GMST`
 * each frame — `ringRotationY` — which the node test proves equivalent.
 *
 * Constants are WGS-72 (what CelesTrak's elements are fitted with — see the
 * SGP4 kernel row in CLAUDE.md), and the semi-major axis is recovered from
 * the Kozai mean motion exactly as SGP4's initialiser does; using a = (μ/n²)^⅓
 * instead puts a LEO ring ~10 km high.
 *
 * No DOM, no three.js, no fetch, no ambient time.
 */

import { ATMOSPHERIC_LAYERS, layerAt } from './upper-atmosphere-engine.js';
import { PAGE_RE_KM, CATALOG_RE_KM } from './upper-atmosphere-datum.js';
import { greenwichSiderealDeg } from './sun-altitude.js';

// ── Constants (WGS-72, as SGP4) ─────────────────────────────────────────────
export const RE_KM = CATALOG_RE_KM;     // WGS-72 — SGP4's own, for the a/n recovery only
export const MU_KM3S2 = 398600.8;
export const J2 = 0.001082616;
const KE = 60 / Math.sqrt(RE_KM ** 3 / MU_KM3S2);       // √μ in ER^1.5 / min
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const MIN_PER_DAY = 1440;
/**
 * Kilometres per scene unit: the PAGE datum (js/upper-atmosphere-datum.js).
 * Every altitude this kernel reports — mean, perigee, apogee, the ladder —
 * is above that same 6371 km sphere, the one drawn and the one the engine's
 * density is read at. (Until 2026-10-04 they were WGS-72 altitudes and the
 * catalogue dots were drawn at 6378.135 km per unit to match; both moved to
 * the page datum together — see that module's header.)
 */
export const SCENE_RE_KM = PAGE_RE_KM;

// ── The catalogue ───────────────────────────────────────────────────────────
// Every id is a group /api/celestrak/tle relays AND the tracker colours; the
// node test parses both files and fails on drift (a suite whose id the route
// does not know loads nothing and would silently show an empty chip).
export const SUITE_CATEGORIES = [
    { id: 'crewed',   label: 'Crewed & stations' },
    { id: 'comms',    label: 'Communications' },
    { id: 'nav',      label: 'Navigation (GNSS)' },
    { id: 'earthobs', label: 'Earth observation' },
    { id: 'science',  label: 'Science' },
    { id: 'geo',      label: 'Geostationary belt' },
    { id: 'debris',   label: 'Debris' },
    { id: 'all',      label: 'Whole catalogue' },
];

export const SAT_SUITES = [
    { id: 'stations',           label: 'Stations',          category: 'crewed',   note: 'ISS, Tiangong and their visiting vehicles' },
    { id: 'starlink',           label: 'Starlink',          category: 'comms',    note: 'SpaceX broadband shells, 340–570 km' },
    { id: 'oneweb',             label: 'OneWeb',            category: 'comms',    note: 'Polar shell at ~1200 km' },
    { id: 'iridium',            label: 'Iridium',           category: 'comms',    note: 'Six polar planes at ~780 km' },
    { id: 'globalstar',         label: 'Globalstar',        category: 'comms',    note: '52° shell at ~1410 km' },
    { id: 'amateur',            label: 'Amateur radio',     category: 'comms',    note: 'Ham and education satellites' },
    { id: 'gps-ops',            label: 'GPS',               category: 'nav',      note: 'Six planes at 20 200 km (MEO)' },
    { id: 'galileo',            label: 'Galileo',           category: 'nav',      note: 'Three planes at 23 222 km (MEO)' },
    { id: 'glonass',            label: 'GLONASS',           category: 'nav',      note: 'Three planes at 19 100 km (MEO)' },
    { id: 'beidou',             label: 'BeiDou',            category: 'nav',      note: 'MEO + inclined GEO + GEO' },
    { id: 'weather',            label: 'Weather',           category: 'earthobs', note: 'GOES, JPSS, Meteosat, Metop' },
    { id: 'resource',           label: 'Earth resources',   category: 'earthobs', note: 'Landsat, Sentinel, sun-synchronous imagers' },
    { id: 'planet',             label: 'Planet Labs',       category: 'earthobs', note: 'Dove / SkySat imagers' },
    { id: 'science',            label: 'Science',           category: 'science',  note: 'Hubble and the observatories' },
    { id: 'geo',                label: 'GEO belt',          category: 'geo',      note: 'Geostationary, 35 786 km' },
    { id: 'fengyun-1c-debris',  label: 'Fengyun-1C (2007)', category: 'debris',   note: 'ASAT test — the largest breakup on record' },
    { id: 'cosmos-1408-debris', label: 'Cosmos 1408 (2021)',category: 'debris',   note: 'ASAT test that crossed the ISS shell' },
    { id: 'iridium-33-debris',  label: 'Iridium 33 (2009)', category: 'debris',   note: 'Collision with Cosmos 2251' },
    { id: 'cosmos-2251-debris', label: 'Cosmos 2251 (2009)',category: 'debris',   note: 'Collision with Iridium 33' },
    { id: 'last-30-days',       label: 'Last 30 days',      category: 'all',      note: 'Everything launched this month' },
    { id: 'active',             label: 'All active',        category: 'all',      note: '~10 000 working satellites (heavy)' },
];

export const SUITE_BY_ID = Object.fromEntries(SAT_SUITES.map((s) => [s.id, s]));

// ── Mean elements ───────────────────────────────────────────────────────────
const num = (v) => (v == null || v === '' ? NaN : Number(v));

/** Epoch (Unix ms) from a TLE line 1 "YYDDD.DDDDDDDD". */
export function tleEpochMs(line1) {
    const yy = Number(line1.slice(18, 20));
    const year = yy < 57 ? 2000 + yy : 1900 + yy;
    const day = Number(line1.slice(20, 32));
    return Date.UTC(year, 0, 1) + (day - 1) * 86400000;
}

/**
 * Mean elements of one catalogue record — the tracker's normalised OMM
 * fields (inclination / raan / eccentricity / arg_perigee / mean_anomaly in
 * degrees, mean_motion in rev/day, epoch_jd) or, failing those, the TLE
 * lines. Returns null for anything that cannot be an orbit.
 */
export function meanElements(rec) {
    if (!rec) return null;
    let incDeg = num(rec.inclination), raanDeg = num(rec.raan), ecc = num(rec.eccentricity);
    let argpDeg = num(rec.arg_perigee), mDeg = num(rec.mean_anomaly), nRevDay = num(rec.mean_motion);
    let epochMs = Number.isFinite(num(rec.epoch_jd)) ? (num(rec.epoch_jd) - 2440587.5) * 86400000 : NaN;
    if (!Number.isFinite(epochMs) && rec.epoch) epochMs = Date.parse(rec.epoch);
    const l1 = rec.line1, l2 = rec.line2;
    const haveOmm = [incDeg, raanDeg, ecc, argpDeg, mDeg, nRevDay, epochMs].every(Number.isFinite);
    if (!haveOmm) {
        if (typeof l1 !== 'string' || typeof l2 !== 'string' || l1.length < 63 || l2.length < 63) return null;
        incDeg  = Number(l2.slice(8, 16));
        raanDeg = Number(l2.slice(17, 25));
        ecc     = Number('0.' + l2.slice(26, 33).trim());
        argpDeg = Number(l2.slice(34, 42));
        mDeg    = Number(l2.slice(43, 51));
        nRevDay = Number(l2.slice(52, 63));
        epochMs = tleEpochMs(l1);
    }
    if (![incDeg, raanDeg, ecc, argpDeg, mDeg, nRevDay, epochMs].every(Number.isFinite)) return null;
    if (nRevDay <= 0 || ecc < 0 || ecc >= 1) return null;

    const inc = incDeg * DEG;
    const n0 = nRevDay * TAU / MIN_PER_DAY;                 // Kozai, rad/min
    // SGP4's recovery of the Brouwer mean motion and semi-major axis.
    const cosi = Math.cos(inc), theta2 = cosi * cosi;
    const beta2 = 1 - ecc * ecc, beta = Math.sqrt(beta2);
    const k2 = 0.5 * J2;
    const a1 = Math.pow(KE / n0, 2 / 3);
    const d1 = 1.5 * k2 * (3 * theta2 - 1) / (a1 * a1 * beta * beta2);
    const a0 = a1 * (1 - d1 / 3 - d1 * d1 - (134 / 81) * d1 * d1 * d1);
    const d0 = 1.5 * k2 * (3 * theta2 - 1) / (a0 * a0 * beta * beta2);
    const n = n0 / (1 + d0);                                 // Brouwer, rad/min
    const aEr = a0 / (1 - d0);
    const aKm = aEr * RE_KM;

    // Secular J2 rates (rad/min) on the Brouwer elements.
    const p = aEr * beta2;
    const f = 1.5 * J2 / (p * p) * n;
    const raanDot = -f * cosi;
    const argpDot = 0.5 * f * (5 * theta2 - 1);
    const mDot = n + 0.5 * f * beta * (3 * theta2 - 1);

    return {
        norad: rec.norad_id ?? (typeof l1 === 'string' ? Number(l1.slice(2, 7)) : null),
        name: rec.name ?? null,
        epochMs, inc, raan0: raanDeg * DEG, ecc, argp0: argpDeg * DEG, m0: mDeg * DEG,
        n, aKm,
        perigeeKm: aKm * (1 - ecc) - PAGE_RE_KM,
        apogeeKm: aKm * (1 + ecc) - PAGE_RE_KM,
        meanAltKm: aKm - PAGE_RE_KM,
        periodMin: TAU / n,
        raanDot, argpDot, mDot,
    };
}

/** Node, perigee and mean anomaly carried to `ms` by the secular J2 rates. */
export function elementsAt(el, ms) {
    const dtMin = (ms - el.epochMs) / 60000;
    return {
        raan: el.raan0 + el.raanDot * dtMin,
        argp: el.argp0 + el.argpDot * dtMin,
        m: (((el.m0 + el.mDot * dtMin) % TAU) + TAU) % TAU,
    };
}

function solveKepler(m, e) {
    let E = e < 0.8 ? m : Math.PI;
    for (let k = 0; k < 12; k++) {
        const d = (E - e * Math.sin(E) - m) / (1 - e * Math.cos(E));
        E -= d;
        if (Math.abs(d) < 1e-12) break;
    }
    return E;
}

/** TEME position (km) at eccentric anomaly E of an orientation (raan, argp, inc). */
function temeAtE(el, raan, argp, E, out, o) {
    const a = el.aKm, e = el.ecc;
    const xp = a * (Math.cos(E) - e);
    const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cO = Math.cos(raan), sO = Math.sin(raan);
    const cw = Math.cos(argp), sw = Math.sin(argp);
    const ci = Math.cos(el.inc), si = Math.sin(el.inc);
    out[o]     = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
    out[o + 1] = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
    out[o + 2] = (sw * si) * xp + (cw * si) * yp;
}

/** The two-body TEME position (km) of the mean elements at `ms`. */
export function meanPositionTeme(el, ms) {
    const { raan, argp, m } = elementsAt(el, ms);
    const out = [0, 0, 0];
    temeAtE(el, raan, argp, solveKepler(m, el.ecc), out, 0);
    return out;
}

/**
 * The orbit ring at `ms`: `n` points evenly spaced in ECCENTRIC anomaly
 * (which bunches samples at perigee, where the curve bends most), TEME km.
 */
export function orbitRingTeme(el, ms, n = 128) {
    const { raan, argp } = elementsAt(el, ms);
    const out = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) temeAtE(el, raan, argp, (i / n) * TAU, out, i * 3);
    return out;
}

// ── Frames ──────────────────────────────────────────────────────────────────
/**
 * GMST (rad) — the page's ONE sidereal clock (js/sun-altitude.js, the copy
 * the globe and the flight kernel turn by; coords.js' tracker copy agrees
 * to ~0.1 arcsec). Not a third implementation.
 */
export function gmstRad(ms) {
    return greenwichSiderealDeg(ms) * DEG;
}

/**
 * TEME km → scene units (1 = SCENE_RE_KM), Earth-fixed at `gmst`. A
 * transcription of coords.js `eciToEcef` + the tracker's km→scene scale.
 */
export function temeToScene(x, y, z, gmst, out = [0, 0, 0], o = 0) {
    const c = Math.cos(gmst), s = Math.sin(gmst);
    const xe = c * x + s * y, ye = -s * x + c * y;
    out[o] = xe / SCENE_RE_KM;
    out[o + 1] = z / SCENE_RE_KM;
    out[o + 2] = -ye / SCENE_RE_KM;
    return out;
}

/** The scene-group rotation that turns a GMST = 0 build into the frame at `gmst`. */
export const ringRotationY = (gmst) => -gmst;

/** A ring in scene units at GMST = 0 (the renderer turns it by `ringRotationY`). */
export function orbitRingInertialScene(el, ms, n = 128) {
    const teme = orbitRingTeme(el, ms, n);
    const out = new Float32Array(n * 3);
    const tmp = [0, 0, 0];
    for (let i = 0; i < n; i++) {
        temeToScene(teme[i * 3], teme[i * 3 + 1], teme[i * 3 + 2], 0, tmp);
        out[i * 3] = tmp[0]; out[i * 3 + 1] = tmp[1]; out[i * 3 + 2] = tmp[2];
    }
    return out;
}

/**
 * The orbit's SHAPE as a table: perifocal (x, y) in km at `n` equal steps of
 * MEAN anomaly. a and e do not drift under secular J2, so this is built once;
 * `inertialSceneAt` then needs one lerp and one rotation per call — what the
 * conjunction screener's ~10⁵ lookups per scan can afford, where a Kepler
 * solve per lookup could not. Linear interpolation over 256 steps sags
 * r·(1 − cos(π/256)) ≈ 0.5 km at LEO (pinned in the node test).
 */
export function perifocalTable(el, n = 256) {
    const out = new Float64Array(n * 2);
    const a = el.aKm, e = el.ecc, b = a * Math.sqrt(1 - e * e);
    for (let i = 0; i < n; i++) {
        const E = solveKepler((i / n) * TAU, e);
        out[i * 2] = a * (Math.cos(E) - e);
        out[i * 2 + 1] = b * Math.sin(E);
    }
    return out;
}

/**
 * Position at `ms` in the page's INERTIAL scene frame (temeToScene at
 * GMST = 0: x, z, −y, scene units) — the frame `_propagateKeplerian` and the
 * globe's probe tables use, so the caller turns it Earth-fixed with the same
 * −GMST rotation as everything else. With `table` it interpolates; without,
 * it solves Kepler exactly.
 */
export function inertialSceneAt(el, ms, table = null, out = [0, 0, 0]) {
    const { raan, argp, m } = elementsAt(el, ms);
    let xp, yp;
    if (table) {
        const n = table.length / 2;
        const f = (m / TAU) * n;
        const k0 = Math.floor(f) % n, k1 = (k0 + 1) % n, t = f - Math.floor(f);
        xp = table[k0 * 2] * (1 - t) + table[k1 * 2] * t;
        yp = table[k0 * 2 + 1] * (1 - t) + table[k1 * 2 + 1] * t;
    } else {
        const E = solveKepler(m, el.ecc);
        xp = el.aKm * (Math.cos(E) - el.ecc);
        yp = el.aKm * Math.sqrt(1 - el.ecc * el.ecc) * Math.sin(E);
    }
    const cO = Math.cos(raan), sO = Math.sin(raan);
    const cw = Math.cos(argp), sw = Math.sin(argp);
    const ci = Math.cos(el.inc), si = Math.sin(el.inc);
    const x = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
    const y = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
    const z = (sw * si) * xp + (cw * si) * yp;
    out[0] = x / SCENE_RE_KM; out[1] = z / SCENE_RE_KM; out[2] = -y / SCENE_RE_KM;
    return out;
}

/** Closed polyline → LineSegments pairs (2 vertices per edge). */
export function ringToSegments(ring, target = null, offset = 0) {
    const n = ring.length / 3;
    const out = target || new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, o = offset + i * 6;
        out[o] = ring[i * 3]; out[o + 1] = ring[i * 3 + 1]; out[o + 2] = ring[i * 3 + 2];
        out[o + 3] = ring[j * 3]; out[o + 4] = ring[j * 3 + 1]; out[o + 5] = ring[j * 3 + 2];
    }
    return out;
}

/** Distance from point p to a closed polyline (same units). */
export function distanceToRing(p, ring) {
    const n = ring.length / 3;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[i * 3], ay = ring[i * 3 + 1], az = ring[i * 3 + 2];
        const bx = ring[j * 3] - ax, by = ring[j * 3 + 1] - ay, bz = ring[j * 3 + 2] - az;
        const px = p[0] - ax, py = p[1] - ay, pz = p[2] - az;
        const bb = bx * bx + by * by + bz * bz;
        const t = bb > 0 ? Math.max(0, Math.min(1, (px * bx + py * by + pz * bz) / bb)) : 0;
        const dx = px - t * bx, dy = py - t * by, dz = pz - t * bz;
        best = Math.min(best, Math.hypot(dx, dy, dz));
    }
    return best;
}

// ── Which members get a ring ────────────────────────────────────────────────
/**
 * Up to `max` members chosen to show the suite's PLANES rather than its most
 * crowded plane: sort by node (at `ms`, after J2) and inclination band, then
 * take evenly spaced picks. Deterministic for a given catalogue.
 */
export function ringSample(elements, max, ms) {
    const list = elements.filter(Boolean);
    if (list.length <= max) return list.slice();
    const keyed = list.map((el) => {
        const raan = ((elementsAt(el, ms).raan % TAU) + TAU) % TAU;
        return { el, k: Math.round(el.inc / DEG / 5) * 1000 + raan };
    }).sort((a, b) => a.k - b.k || (a.el.norad ?? 0) - (b.el.norad ?? 0));
    const out = [];
    for (let i = 0; i < max; i++) out.push(keyed[Math.floor((i + 0.5) * keyed.length / max)].el);
    return out;
}

// ── Regimes & the ladder ────────────────────────────────────────────────────
/** LEO < 2000 km perigee-and-apogee; GEO ≈ 35 786 ± 1000 km, low e; HEO = e > 0.25. */
export function orbitRegime(el) {
    if (!el) return null;
    if (el.ecc > 0.25) return 'HEO';
    if (el.apogeeKm < 2000) return 'LEO';
    if (Math.abs(el.meanAltKm - 35786) < 1000) return 'GEO';
    if (el.meanAltKm > 36786) return 'beyond-GEO';
    return 'MEO';
}

/** The page's layer at an altitude (the engine's table, never re-typed). */
export function layerIdAt(altKm) { return layerAt(altKm)?.id ?? null; }
export const LADDER_LAYERS = ATMOSPHERIC_LAYERS;

/**
 * Bin mean altitudes over [minKm, maxKm) and count what lies outside and in
 * each regime and layer. Non-finite altitudes are SKIPPED, never counted as 0.
 */
export function altitudeLadder(elements, { minKm = 150, maxKm = 2000, binKm = 50 } = {}) {
    const nb = Math.ceil((maxKm - minKm) / binKm);
    const bins = Array.from({ length: nb }, (_, i) => ({
        loKm: minKm + i * binKm, hiKm: Math.min(maxKm, minKm + (i + 1) * binKm), count: 0,
        layer: layerIdAt(minKm + (i + 0.5) * binKm),
    }));
    const regimes = { LEO: 0, MEO: 0, GEO: 0, HEO: 0, 'beyond-GEO': 0 };
    const layers = {};
    let below = 0, above = 0, total = 0;
    for (const el of elements) {
        const h = el?.meanAltKm;
        if (!Number.isFinite(h)) continue;
        total++;
        regimes[orbitRegime(el)]++;
        // Past the engine's last layer (its exosphere ends at 10 000 km) an
        // object is in no layer the page models: counted, and said so.
        const L = layerIdAt(Math.max(0, h)) ?? 'beyond';
        layers[L] = (layers[L] || 0) + 1;
        if (h < minKm) below++;
        else if (h >= maxKm) above++;
        else bins[Math.min(nb - 1, Math.floor((h - minKm) / binKm))].count++;
    }
    const peak = bins.reduce((m, b) => Math.max(m, b.count), 0);
    return { bins, below, above, total, regimes, layers, peak, minKm, maxKm, binKm };
}

/** The `q` quantile of the suite's APOGEE altitudes — its outer shell (km). */
export function outerShellKm(elements, q = 0.95) {
    const a = elements.map((e) => e?.apogeeKm).filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return null;
    return a[Math.min(a.length - 1, Math.floor(q * (a.length - 1) + 0.5))];
}

// ── Framing ─────────────────────────────────────────────────────────────────
/**
 * Camera distance (R⊕ from Earth's centre) at which a sphere of altitude
 * `outerKm` fits the BINDING half-angle of a `fovDeg` (vertical) lens at
 * `aspect`, with `fill` of that half-angle used (0.85 leaves a margin).
 * Clamped to [minR, maxR]; `clamped` says when the camera range, not the
 * shell, decided the answer.
 */
export function framingDistance({ outerKm, fovDeg = 40, aspect = 16 / 9, fill = 0.85, minR = 1.6, maxR = 28 } = {}) {
    const R = 1 + Math.max(0, outerKm || 0) / SCENE_RE_KM;
    const hv = (fovDeg * DEG) / 2;
    const hh = Math.atan(Math.tan(hv) * aspect);
    const half = Math.min(hv, hh) * fill;
    const d = R / Math.sin(half);
    const dist = Math.min(maxR, Math.max(minR, d));
    return { distance: dist, shellR: R, halfAngleRad: half, clamped: dist !== d };
}

/** Regime presets for the framing buttons (outer altitude in km). */
export const FRAME_PRESETS = [
    { id: 'leo', label: 'LEO', outerKm: 2000 },
    { id: 'meo', label: 'MEO', outerKm: 23500 },
    { id: 'geo', label: 'GEO', outerKm: 36500 },
];
