/**
 * climate-lab/lab-sat-geo.js — pure geometry for the lab's satellite map.
 * ═══════════════════════════════════════════════════════════════════════════
 * No propagation here (that is satellite-tracker.js / pass-predictor.js, the
 * site's one SGP4 path); only the spherical geometry the 2D map draws, so it
 * is node-testable without three.js or WASM.
 */

const DEG = Math.PI / 180;
export const R_EARTH_KM = 6378.135;   // WGS-72, matches the SGP4 path

/**
 * Half-angle (degrees of arc on the ground) of the region from which a
 * satellite at `altKm` is above the horizon (0° elevation): cos λ = Re/(Re+h).
 * With `minElDeg` > 0 it is the region where it clears that elevation:
 *   λ = acos(Re·cos e / (Re+h)) − e.
 */
export function footprintRadiusDeg(altKm, minElDeg = 0) {
    if (!(altKm > 0)) return 0;
    const e = minElDeg * DEG;
    return (Math.acos((R_EARTH_KM * Math.cos(e)) / (R_EARTH_KM + altKm)) - e) / DEG;
}

/** Point at great-circle distance `distDeg` and bearing `brgDeg` from (lat, lon). */
export function destination(lat, lon, distDeg, brgDeg) {
    const p1 = lat * DEG, l1 = lon * DEG, d = distDeg * DEG, b = brgDeg * DEG;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
    const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    return { lat: p2 / DEG, lon: ((l2 / DEG + 540) % 360) - 180 };
}

/** Visibility-circle polygon (closed) for drawing on a plate-carrée map. */
export function footprintPoints(lat, lon, altKm, { stepDeg = 6, minElDeg = 0 } = {}) {
    const r = footprintRadiusDeg(altKm, minElDeg);
    if (!(r > 0)) return [];
    const pts = [];
    for (let b = 0; b <= 360; b += stepDeg) pts.push(destination(lat, lon, r, b));
    return pts;
}

/** Great-circle distance in degrees of arc. */
export function arcDeg(a, b) {
    const s = Math.sin(a.lat * DEG) * Math.sin(b.lat * DEG)
        + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.cos((b.lon - a.lon) * DEG);
    return Math.acos(Math.min(1, Math.max(-1, s))) / DEG;
}

/** "ISS (ZARYA)" → "ISS", "NOAA 20 (JPSS-1)" → "NOAA 20" — a map label. */
export function shortSatName(name) {
    const s = String(name || '').replace(/\s*\(.*$/, '').trim();
    return (s || String(name || '')).slice(0, 14);
}

/** Circular-orbit speed estimate (km/s) from the vis-viva equation. */
export function orbitalSpeedKms(rKm, smaKm) {
    const MU = 398600.4418;
    if (!(rKm > 0)) return NaN;
    const a = smaKm > 0 ? smaKm : rKm;
    return Math.sqrt(MU * (2 / rKm - 1 / a));
}
