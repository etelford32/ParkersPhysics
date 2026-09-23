// tests/fixtures/ovation-synthetic.mjs — a SYNTHETIC /api/noaa/aurora-grid body
//
// NOAA SWPC is egress-blocked at build time, so the browser gates cannot see a
// real OVATION grid. This builds one in the route's exact shape
// ({ data: { updated, north_gw, south_gw, cells: [[lonEast, lat, prob%]] } },
// every 2nd longitude, |lat| ≥ 40, prob ≥ 4, brightest first, ≤ 700 cells)
// on the REAL IGRF dipole and the REAL sub-solar point at `now`: an oval that
// is brighter and further equatorward at magnetic midnight, as OVATION draws
// one. It is a fixture, never data — nothing on the site may import it.
import { toDipole, dipoleBasisForYear, decimalYear } from '../../js/geomag/dipole.js';
import { subSolarPoint } from '../../js/sun-altitude.js';

/**
 * @param {Date} now
 * @param {{ ringLat?: number, shift?: number, peak?: number, day?: number }} [o]
 *   ringLat: dipole latitude of the oval at magnetic noon; shift: how much
 *   further equatorward it sits at midnight; peak/day: probability (%) at
 *   midnight / noon.
 */
export function synthOvation(now, { ringLat = 69, shift = 4, peak = 22, day = 5 } = {}) {
    const basis = dipoleBasisForYear(decimalYear(now));
    const ss = subSolarPoint(now);
    const sunDipLon = toDipole(ss.lat, ss.lon, basis).lonDeg;
    const cells = [];
    let north = 0, south = 0;
    for (let lon = 0; lon < 360; lon++) {
        for (let lat = -90; lat <= 90; lat++) {
            const md = toDipole(lat, lon, basis);
            const night = 0.5 - 0.5 * Math.cos((md.lonDeg - sunDipLon) * Math.PI / 180);
            const ring = ringLat - shift * night;
            const amp = day + (peak - day) * night;
            const p = amp * Math.exp(-(((Math.abs(md.latDeg) - ring) / 3.2) ** 2));
            const w = p * Math.cos(lat * Math.PI / 180);
            if (lat >= 0) north += w; else south += w;
            if (Math.abs(lat) < 40 || p < 4 || lon % 2) continue;
            cells.push([lon, lat, Math.round(p)]);
        }
    }
    cells.sort((a, b) => b[2] - a[2]);
    const capped = cells.slice(0, 700);
    return {
        source: 'SYNTHETIC test fixture (tests/fixtures/ovation-synthetic.mjs)',
        age_seconds: 0,
        data: {
            updated: now.toISOString(),
            north_gw: north * 0.025, south_gw: south * 0.025, activity: 'test',
            cells: capped, cell_count: capped.length,
        },
    };
}
