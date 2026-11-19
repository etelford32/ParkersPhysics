/**
 * field-model.js — what the stage's MAGNETIC FIELD view draws (PURE: no DOM,
 * no three.js). Every number is CHAOS-8.1 (js/geomag/chaos.js) evaluated by
 * js/geomag/igrf.js; this module only picks quantities, grids and colours.
 *
 * THE QUANTITIES, and why each is drawn where it is:
 *   • CORE (the ball in the cut, r = 3480 km): the RADIAL field B_r at the
 *     core–mantle boundary, n ≤ 13 (CMB_NMAX). Downward continuation is
 *     exact for a potential field in an insulating mantle, but it amplifies
 *     degree n by (a/c)^(n+2) — about 6×10⁵ at n = 20 — and above n ≈ 13 the
 *     crust, not the core, dominates the observed spectrum (the Lowes
 *     crossover; igrf.js lowesSpectrum). Stopping at 13 is the standard
 *     choice and the page says so. Its SECULAR CHANGE ∂B_r/∂t is the motion of
 *     flux patches by the core flow — the field's evolution, observed.
 *   • SURFACE (the globe, the 6371.2 km reference sphere): total intensity
 *     |B| from the core field n ≤ 20 (the South Atlantic Anomaly is its low),
 *     or the static CRUSTAL field n = 21–185 (baked Z grid; magnetised rock,
 *     unchanging on these timescales).
 *
 * FIXED colour ranges, so a scrub through time shows change, never a
 * re-scaled palette: about the 99th percentile of |value| measured from this
 * model (CMB B_r 0.77–0.82 mT, its change 15–18 µT/yr, the crust 187 nT) and
 * pulled in a little so the bulk of the map is not pale; the extremes clamp.
 */
import { chaosCoeffsAt, svSet, coverage, decodeChaos, decimalYear } from '../geomag/chaos.js';
import { fieldGridGeocentric, dipole, findSAA, R_CMB_KM, REF_RADIUS_KM } from '../geomag/igrf.js';

export const CMB_NMAX = 13;
export const SURFACE_NMAX = 20;
export const GRID = { nLat: 90, nLon: 180 };      // 2° cells

// ColorBrewer RdBu (reversed: red = positive / outward) and viridis-like for intensity.
const DIVERGING = ['#2166ac', '#4393c3', '#92c5de', '#d1e5f0', '#f7f7f7', '#fddbc7', '#f4a582', '#d6604d', '#b2182b'];
const SEQUENTIAL = ['#2a0f4f', '#3b3b8f', '#2c6f9e', '#21918c', '#3fb27a', '#93cf4b', '#e6dd3a'];

export const FIELD_QUANTITIES = {
    'cmb-br': { where: 'core', label: 'B_r at the core', unit: 'mT', scale: 1e-6, range: [-0.8e6, 0.8e6], ramp: DIVERGING,
        note: 'Radial field at the core–mantle boundary (3480 km), degree ≤ 13. Red: field pointing out of the core; blue: into it.' },
    'cmb-sv': { where: 'core', label: 'Change ∂B_r/∂t', unit: 'µT/yr', scale: 1e-3, range: [-1.2e4, 1.2e4], ramp: DIVERGING,
        note: 'Secular change of the radial field at the core–mantle boundary, degree ≤ 13 — flux patches carried by the flow in the outer core.' },
    'surf-f': { where: 'surface', label: '|B| at the surface', unit: 'µT', scale: 1e-3, range: [2.0e4, 6.8e4], ramp: SEQUENTIAL,
        note: 'Total intensity of the core field on the 6371.2 km reference sphere, degree ≤ 20. The low over South America is the South Atlantic Anomaly.' },
    'surf-crust': { where: 'surface', label: 'Crustal field', unit: 'nT', scale: 1, range: [-120, 120], ramp: DIVERGING,
        note: 'Static lithospheric field, degree 21–185, downward component Z on the WGS-84 surface: magnetised rock (Kursk, Bangui); the narrowest seafloor stripes are below this resolution.' },
};

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** Colour of value v for quantity q (sRGB bytes); clamps to the range. */
export function rampColor(q, v) {
    const Q = FIELD_QUANTITIES[q], stops = Q.ramp.map(hexRgb);
    const [lo, hi] = Q.range;
    let t = (v - lo) / (hi - lo);
    if (!Number.isFinite(t)) return null;
    t = Math.min(1, Math.max(0, t));
    const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
    return stops[i].map((c, k) => Math.round(c + (stops[i + 1][k] - c) * f));
}

export async function loadChaos(fetchFn = fetch, url = 'data/earth-interior/chaos-8.1.json.gz') {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`CHAOS-8.1: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    // A host that sends Content-Encoding has already decompressed: check the gzip MAGIC, not the URL.
    let text;
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
        const ds = new DecompressionStream('gzip');
        text = await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
    } else text = new TextDecoder().decode(buf);
    return decodeChaos(JSON.parse(text));
}

/** Cell-centred values of quantity q at decimal year y: { values, nLat, nLon, cover } | null. */
export function fieldMap(model, year, q) {
    const Q = FIELD_QUANTITIES[q];
    if (q === 'surf-crust') return crustMap(model.lithosphere);
    const c = chaosCoeffsAt(model, year);
    if (!c) return null;
    let values;
    if (q === 'cmb-br') values = fieldGridGeocentric(c, CMB_NMAX, { rKm: R_CMB_KM, ...GRID }).br;
    else if (q === 'cmb-sv') values = fieldGridGeocentric(svSet(c), CMB_NMAX, { rKm: R_CMB_KM, ...GRID }).br;
    else if (q === 'surf-f') {
        const g = fieldGridGeocentric(c, SURFACE_NMAX, { rKm: REF_RADIUS_KM, ...GRID });
        values = g.br.map((v, k) => Math.hypot(v, g.btheta[k], g.bphi[k]));
    } else throw new Error(`unknown quantity ${q}`);
    return { values, ...GRID, q, unit: Q.unit, cover: coverage(model, year) };
}

/** The baked crustal Z (1° NODES) averaged onto 1° CELLS (each cell = mean of its four corner nodes). */
export function crustMap(L) {
    if (!L) return null;
    const nLat = L.nLat - 1, nLon = L.nLon - 1, values = new Float32Array(nLat * nLon);
    const at = (i, j) => L.z[i * L.nLon + j] * L.scale;
    for (let i = 0; i < nLat; i++) for (let j = 0; j < nLon; j++) values[i * nLon + j] = (at(i, j) + at(i + 1, j) + at(i, j + 1) + at(i + 1, j + 1)) / 4;
    return { values, nLat, nLon, q: 'surf-crust', unit: 'nT', cover: { state: 'static', yearsPast: 0 } };
}

/** RGBA bytes for a map (row 0 = north, the texture orientation the stage uses). */
export function mapRGBA(map, q, alpha = 255) {
    const out = new Uint8Array(4 * map.values.length);
    for (let k = 0; k < map.values.length; k++) {
        const c = rampColor(q, map.values[k]);
        if (c) out.set([c[0], c[1], c[2], alpha], 4 * k);
    }
    return out;
}

/** Bilinear read of a cell-centred map at (lat, lon) — for the hover probe. */
export function sampleMap(map, latDeg, lonDeg) {
    const { nLat, nLon, values } = map;
    const y = (90 - latDeg) / 180 * nLat - 0.5, x = (((lonDeg + 180) % 360 + 360) % 360) / 360 * nLon - 0.5;
    const i0 = Math.max(0, Math.min(nLat - 1, Math.floor(y))), i1 = Math.min(nLat - 1, i0 + 1), fy = Math.max(0, Math.min(1, y - i0));
    const j0 = ((Math.floor(x) % nLon) + nLon) % nLon, j1 = (j0 + 1) % nLon, fx = x - Math.floor(x);
    const v = (i, j) => values[i * nLon + j];
    return (v(i0, j0) * (1 - fx) + v(i0, j1) * fx) * (1 - fy) + (v(i1, j0) * (1 - fx) + v(i1, j1) * fx) * fy;
}

/** The headline numbers at an instant: dipole, SAA (n ≤ 13 minimum of |B|), and what the instant is. */
export function fieldSummary(model, year) {
    const c = chaosCoeffsAt(model, year);
    if (!c) return null;
    const d = dipole(c);
    return {
        year, cover: coverage(model, year),
        momentAm2: d.momentAm2, tiltDeg: d.tiltDeg, poleLatDeg: d.poleLatDeg, poleLonDeg: d.poleLonDeg,
        saa: findSAA(c, CMB_NMAX),
    };
}

/** Yearly track points from the data start to `endYear` (SAA and the geomagnetic north pole). */
export function trackEpochs(model, endYear, stepYears = 1) {
    const out = [];
    for (let y = Math.ceil(model.start * 2) / 2; y <= endYear + 1e-9; y += stepYears) out.push(y);
    if (out.at(-1) < endYear - 1e-6) out.push(endYear);
    return out;
}

/** The CHAOS decimal year of a JS instant (re-exported so the page has one clock). */
export const yearOf = (ms) => decimalYear(ms);
