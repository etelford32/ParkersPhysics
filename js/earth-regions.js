/**
 * earth-regions.js — "show me the weather over …": named regions as camera poses
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PURE (no DOM, no THREE) — `node tests/earth-regions.mjs`.
 *
 * The regions are js/geo-regions.js REGIONS — the site's ONE table of named
 * boxes (it labels Storm Watch extremes and the Temperature Lab). This module
 * never adds a box of its own: it turns a box into somewhere to stand.
 *
 * FRAMING IS SPHERE GEOMETRY, not a typed distance per region. A ground arc
 * of half-angle θ (radians of great circle from the sub-camera point) seen
 * from distance d (Earth radii, from the centre) subtends a half-angle α with
 * tan α = sin θ / (d − cos θ); so it just fills a half-fov α at
 *
 *        d = cos θ + sin θ / tan α .
 *
 * The box is fitted on BOTH screen axes (vertical fov; horizontal = aspect ×
 * tan(vfov/2)) and the farther stand-off wins — the neo-watch `frameAll`
 * rule (the binding half-angle is the smaller one, so the phone case cannot
 * be read off the desktop one). East-west extent is ARC, i.e. Δlon·cos(lat).
 *
 * The same numbers name the LOD tier the page is in: the footprint latitude
 * span the regional layers activate at (cloud window and imagery inset ≤ 45°,
 * the weather patch ≤ 32°), so "Regional detail" on screen is the state the
 * data layers are actually in, not a separate guess.
 */

import { REGIONS } from './geo-regions.js';
import { REGIONAL_DETAIL } from './cloud-mosaic-core.js';

const DEG = Math.PI / 180;
export const EARTH_RADIUS_KM = 6371;

/** Tier thresholds on the focus-footprint LAT span (degrees). */
export const VIEW_TIERS = Object.freeze([
    Object.freeze({ id: 'global',   label: 'Global view',     maxSpanDeg: Infinity }),
    // The regional window's own activation span — ONE number, so the word on
    // screen is the state the cloud window (and the imagery inset, same 45°)
    // is in, not a second threshold that can drift from it.
    Object.freeze({ id: 'regional', label: 'Regional detail', maxSpanDeg: REGIONAL_DETAIL.activateSpanDeg }),
    Object.freeze({ id: 'local',    label: 'Local detail',    maxSpanDeg: 12 }),
]);

export function slugify(name) {
    return String(name).toLowerCase().normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// A full-longitude band is viewed from just off its pole, never ON it:
// EarthView's OrbitControls orbits about world +Y, which IS the polar axis,
// and a camera on that axis sits at the controls' singularity. 10° off is
// invisible framing-wise (the span pad covers it).
export const POLAR_VIEW_LAT = 80;

const SEA_WORDS = /\b(ocean|sea|gulf|bay|caribbean|atlantic|pacific|arctic)\b/i;

/** Which optgroup a region belongs in — by its own name and centre. */
export function regionGroup(r) {
    if (SEA_WORDS.test(r.name)) return 'Seas & oceans';
    if (r.lat < -60 || (r.polar && !SEA_WORDS.test(r.name))) return 'Polar';
    if (r.lon < -25) return 'Americas';
    if (r.lon < 60)  return 'Europe, Africa & Middle East';
    return 'Asia & Oceania';
}

/** REGIONS box → { id, name, lat, lon, latSpan, lonSpan, polar, group }. */
export function regionFromBox([latMin, latMax, lonMin, lonMax, name]) {
    const lonSpan = lonMin <= lonMax ? lonMax - lonMin : lonMax - lonMin + 360;
    const ring = lonSpan >= 359.9;
    let lat, latSpan;
    if (ring) {
        // A full-longitude band is framed from above its pole: the Arctic is
        // a disc around 90°N, not a strip along a meridian (stood off the
        // axis by POLAR_VIEW_LAT, and the span widened by the offset).
        const north = latMax > 0 && latMax >= -latMin;
        lat = north ? POLAR_VIEW_LAT : -POLAR_VIEW_LAT;
        latSpan = 2 * (90 - Math.min(Math.abs(latMin), Math.abs(latMax))) + 2 * (90 - POLAR_VIEW_LAT);
    } else {
        lat = (latMin + latMax) / 2;
        latSpan = latMax - latMin;
    }
    let lon = ring ? 0 : lonMin + lonSpan / 2;
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    const r = { id: slugify(name), name, lat, lon, latSpan, lonSpan: ring ? latSpan : lonSpan, polar: ring };
    r.group = regionGroup(r);
    return r;
}

let _list = null;
/** Every region, sorted by name within its group (stable, cached). */
export function regionList() {
    if (!_list) {
        _list = Object.freeze(REGIONS.map(regionFromBox)
            .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name)));
    }
    return _list;
}

export function regionById(id) {
    const want = slugify(id ?? '');
    return regionList().find(r => r.id === want) ?? null;
}

/** d = cos θ + sin θ / tan α — the distance at which arc half-angle θ fills half-fov α. */
export function standoffForArc(thetaRad, tanHalfFov) {
    const t = Math.min(Math.PI / 2 - 1e-3, Math.max(1e-4, thetaRad));
    return Math.cos(t) + Math.sin(t) / Math.max(1e-6, tanHalfFov);
}

/**
 * Camera pose that frames a region (or any {lat, lon, latSpan, lonSpan}).
 * @param {object} r
 * @param {{fovDeg?:number, aspect?:number, pad?:number, minDist?:number, maxDist?:number}} [o]
 * @returns {{lat:number, lon:number, dist:number}}
 */
export function regionView(r, { fovDeg = 40, aspect = 16 / 9, pad = 1.12, minDist = 1.02, maxDist = 4.2 } = {}) {
    const tv = Math.tan((fovDeg * DEG) / 2);
    const th = tv * Math.max(0.2, aspect);
    const coslat = r.polar ? 1 : Math.max(0.05, Math.cos(r.lat * DEG));
    const thetaV = (r.latSpan / 2) * pad * DEG;
    const thetaH = (r.lonSpan / 2) * coslat * pad * DEG;
    const dist = Math.max(standoffForArc(thetaV, tv), standoffForArc(thetaH, th));
    return { lat: r.lat, lon: r.lon, dist: Math.min(maxDist, Math.max(minDist, dist)) };
}

/**
 * `?at=lat,lon[,altKm]` → { lat, lon, dist } or null. Altitude is above the
 * surface in km (what the page prints); default 1500 km, a regional view.
 */
export function parseAtParam(s, { defaultAltKm = 1500, minDist = 1.004, maxDist = 10 } = {}) {
    if (typeof s !== 'string') return null;
    const parts = s.split(',').map(x => Number(x.trim()));
    if (parts.length < 2 || !parts.slice(0, 2).every(Number.isFinite)) return null;
    const [lat, lon] = parts;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 360) return null;
    const altKm = Number.isFinite(parts[2]) && parts[2] > 0 ? parts[2] : defaultAltKm;
    const dist = Math.min(maxDist, Math.max(minDist, 1 + altKm / EARTH_RADIUS_KM));
    return { lat, lon: ((((lon + 180) % 360) + 360) % 360) - 180, dist };
}

/** The tier the footprint latitude span puts the page in. */
export function viewTier(spanLatDeg) {
    let t = VIEW_TIERS[0];
    for (const tier of VIEW_TIERS) if (Number.isFinite(spanLatDeg) && spanLatDeg <= tier.maxSpanDeg) t = tier;
    return t;
}

/**
 * Ground distance one screen pixel spans at the sub-camera point (km), for a
 * camera at `dist` Earth radii with vertical fov `fovDeg` over `heightPx`.
 * Flat-ground at nadir — the scale bar's number, not a projection.
 */
export function groundKmPerPx(dist, fovDeg, heightPx) {
    const h = Math.max(0, dist - 1) * EARTH_RADIUS_KM;
    return (2 * h * Math.tan((fovDeg * DEG) / 2)) / Math.max(1, heightPx);
}

/** "1 240 km" / "38 km" / "3.2 Mm" — the altitude string the HUD already prints, one copy. */
export function formatAltitude(altKm) {
    if (!Number.isFinite(altKm)) return '—';
    if (altKm > 1000) return `${(altKm / 1000).toFixed(1)} Mm`;
    return `${Math.round(altKm)} km`;
}

/** "2.1 km/px" / "350 m/px". */
export function formatScale(kmPerPx) {
    if (!Number.isFinite(kmPerPx) || kmPerPx <= 0) return '—';
    if (kmPerPx < 1) return `${Math.round(kmPerPx * 1000 / 10) * 10} m/px`;
    return `${kmPerPx < 10 ? kmPerPx.toFixed(1) : Math.round(kmPerPx)} km/px`;
}
