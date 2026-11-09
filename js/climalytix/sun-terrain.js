/**
 * sun-terrain.js — where the terrain puts the Sun: cast shadows, the site's
 * horizon, and the day's Sun path against it. PURE.
 *
 * The slope layers (terrain.js) know how a slope FACES the Sun. They do not
 * know what stands between the slope and the Sun: a north-facing valley floor
 * and a south-facing one are equally dark at 8 a.m. if a ridge is in the way.
 * Three functions, one geometry (a ray from the ground toward the Sun over the
 * DEM grid, with the Earth's curvature — at 50 km the ground has dropped 196 m):
 *
 *   shadowGrid       which grid nodes a ridge shades at one Sun position
 *   horizonProfile   the terrain's elevation angle around one point, per azimuth
 *   sunDay           a day's Sun path judged against that horizon: when the Sun
 *                    actually clears the ridge, and how many hours of direct sun
 *                    the terrain takes away
 *
 * LIMITS, each disclosed where the result is shown:
 *   · terrain is only as fine as the DEM grid handed in (the map's: one node
 *     per 4 px — zoom in for finer) and only as wide as that grid: a ridge
 *     outside the view cannot cast a shadow into it, so a horizon is a LOWER
 *     bound and `reachKm` says how far it could see in each direction
 *   · one Sun position for the whole grid (taken at its centre): across ±4°
 *     the Sun's direction differs by a few degrees
 *   · no refraction, no trees or buildings, the Sun is a point (no penumbra)
 *
 * Node gate: tests/climalytix-sun-terrain.mjs (a wall's shadow length is
 * H / tan α; a ridge's horizon is atan(H / D); curvature on and off).
 */
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const M_PER_DEG = 111_195, R_EARTH = 6_371_000;

function sampler(g) {
    const { nRows, nCols, values } = g;
    return (fi, fj) => {
        if (fi < 0 || fj < 0 || fi > nRows - 1 || fj > nCols - 1) return NaN;
        const i0 = Math.min(nRows - 2, Math.floor(fi)), j0 = Math.min(nCols - 2, Math.floor(fj));
        const a = fi - i0, b = fj - j0;
        const v00 = values[i0 * nCols + j0], v01 = values[i0 * nCols + j0 + 1];
        const v10 = values[(i0 + 1) * nCols + j0], v11 = values[(i0 + 1) * nCols + j0 + 1];
        if (!(Number.isFinite(v00) && Number.isFinite(v01) && Number.isFinite(v10) && Number.isFinite(v11))) return NaN;
        return v00 * (1 - a) * (1 - b) + v01 * (1 - a) * b + v10 * a * (1 - b) + v11 * a * b;
    };
}

/** Metres per grid node, north–south and east–west at latitude `lat`. */
function spacing(g, lat) {
    return { my: g.dlat * M_PER_DEG, mx: g.dlon * M_PER_DEG * Math.max(0.05, Math.cos(lat * D2R)) };
}

function gridMax(g) {
    let m = -Infinity;
    for (let k = 0; k < g.values.length; k++) if (g.values[k] > m) m = g.values[k];
    return m;
}

/**
 * Cast shadows for one Sun position.
 * @returns {{ mask:Uint8Array, lit:number, shaded:number, night:boolean }}
 *   mask[k] 1 = a ridge blocks the Sun here, 0 = the Sun reaches the ground,
 *   255 = no terrain here. `night` (Sun at or below the horizon) shades
 *   nothing: night is not a shadow.
 */
export function shadowGrid(g, sun, { curvature = true } = {}) {
    const n = g.nRows * g.nCols, mask = new Uint8Array(n);
    if (!(sun?.altitudeDeg > 0)) return { mask, lit: 0, shaded: 0, night: true };
    const at = sampler(g), zMax = gridMax(g);
    const tanA = Math.tan(sun.altitudeDeg * D2R), sAz = Math.sin(sun.azimuthDeg * D2R), cAz = Math.cos(sun.azimuthDeg * D2R);
    let lit = 0, shaded = 0;
    for (let i = 0; i < g.nRows; i++) {
        const { mx, my } = spacing(g, g.latN - i * g.dlat);
        const step = Math.min(mx, my);                       // metres per march step: one node along the finer axis
        const di = -(cAz * step) / my, dj = (sAz * step) / mx;   // toward the Sun: north is −i, east is +j
        for (let j = 0; j < g.nCols; j++) {
            const k = i * g.nCols + j, z0 = g.values[k];
            if (!Number.isFinite(z0)) { mask[k] = 255; continue; }
            let blocked = 0;
            for (let s = 1; ; s++) {
                const d = s * step;
                const ray = z0 + d * tanA + (curvature ? d * d / (2 * R_EARTH) : 0);
                if (ray > zMax) break;                       // above everything in the grid
                const z = at(i + s * di, j + s * dj);
                if (Number.isNaN(z)) { if (i + s * di < 0 || j + s * dj < 0 || i + s * di > g.nRows - 1 || j + s * dj > g.nCols - 1) break; continue; }
                if (z > ray) { blocked = 1; break; }
            }
            mask[k] = blocked;
            if (blocked) shaded++; else lit++;
        }
    }
    return { mask, lit, shaded, night: false };
}

/**
 * The terrain horizon around (lat, lon): elevation angle (deg) of the highest
 * ground along each azimuth, seen from `eyeM` above the surface.
 * @returns {{ azStepDeg:number, angles:Float32Array, reachKm:Float32Array, groundM:number }|null}
 */
export function horizonProfile(g, lat, lon, { azStepDeg = 2, eyeM = 2, curvature = true } = {}) {
    const at = sampler(g);
    const fi0 = (g.latN - lat) / g.dlat, fj0 = (lon - g.lonW) / g.dlon;
    const z0 = at(fi0, fj0);
    if (!Number.isFinite(z0)) return null;
    const { mx, my } = spacing(g, lat), step = Math.min(mx, my);
    const nAz = Math.round(360 / azStepDeg);
    const angles = new Float32Array(nAz), reachKm = new Float32Array(nAz);
    for (let a = 0; a < nAz; a++) {
        const az = a * azStepDeg * D2R, di = -(Math.cos(az) * step) / my, dj = (Math.sin(az) * step) / mx;
        let best = 0, s = 1;                                   // a flat, empty horizon is 0°
        for (; ; s++) {
            const fi = fi0 + s * di, fj = fj0 + s * dj;
            if (fi < 0 || fj < 0 || fi > g.nRows - 1 || fj > g.nCols - 1) break;
            const z = at(fi, fj);
            if (!Number.isFinite(z)) continue;
            const d = s * step;
            const ang = Math.atan2(z - (curvature ? d * d / (2 * R_EARTH) : 0) - z0 - eyeM, d) * R2D;
            if (ang > best) best = ang;
        }
        angles[a] = best;
        reachKm[a] = (s - 1) * step / 1000;
    }
    return { azStepDeg, angles, reachKm, groundM: z0 };
}

/** Horizon angle at any azimuth (linear between samples, wrapping at north). */
export function horizonAt(profile, azDeg) {
    if (!profile) return 0;
    const n = profile.angles.length, f = (((azDeg % 360) + 360) % 360) / profile.azStepDeg;
    const a = Math.floor(f) % n, b = (a + 1) % n, w = f - Math.floor(f);
    return profile.angles[a] * (1 - w) + profile.angles[b] * w;
}

/** One day's Sun, sampled every `stepMin` from `dayStartMs`. `sunAt(date, lat, lon)` = sun-altitude.js solarPosition. */
export function sunPath(lat, lon, dayStartMs, sunAt, { stepMin = 5 } = {}) {
    const out = [];
    for (let m = 0; m <= 1440; m += stepMin) {
        const t = dayStartMs + m * 60_000, p = sunAt(new Date(t), lat, lon);
        out.push({ t, az: p.azimuthDeg, alt: p.altitudeDeg });
    }
    return out;
}

/**
 * A day's Sun judged against a horizon (null = open, flat horizon).
 * Times are the first/last SAMPLE on the right side of the line (± one step).
 * `rise/set` astronomical (alt > 0); `clearRise/clearSet` the first/last moment
 * the Sun is above the TERRAIN; `sunMin` minutes above the flat horizon;
 * `directMin` minutes actually above the terrain; `lostMin` their difference.
 */
export function sunDay(path, profile = null) {
    const step = path.length > 1 ? (path[1].t - path[0].t) / 60_000 : 0;
    let rise = null, set = null, clearRise = null, clearSet = null, sunMin = 0, directMin = 0, noon = null;
    for (const p of path) {
        if (!noon || p.alt > noon.alt) noon = p;
        if (!(p.alt > 0)) continue;
        if (rise == null) rise = p.t;
        set = p.t;
        sunMin += step;
        if (p.alt > horizonAt(profile, p.az)) {
            if (clearRise == null) clearRise = p.t;
            clearSet = p.t;
            directMin += step;
        }
    }
    return { rise, set, clearRise, clearSet, sunMin, directMin, lostMin: sunMin - directMin, noon, stepMin: step,
             polar: sunMin === 0 ? 'night' : (path.every((p) => p.alt > 0) ? 'day' : null) };
}
