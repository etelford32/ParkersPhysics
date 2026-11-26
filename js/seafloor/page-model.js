/**
 * page-model.js — everything sea-floor.html prints, assembled from the kernels. PURE (no DOM,
 * no fetch): the page and the 3D stage draw these numbers and compute none of their own.
 *
 * Every temperature carries `kind`: 'measured' (an instrument's own level), 'model' (the adiabat
 * below the deepest level — profile.js), or null (no cast near the site: nothing is invented).
 */
import { SEAFLOOR_SITES, SITE_KINDS } from './sites.js';
import { buildColumn, floorTemperature, referenceCast, temperatureMinimum, soundChannelAxis, withheldTest, columnAt } from './profile.js';
import { sounding, firstReturn, pressureSounding, BEAMS, NOMINAL_SPEEDS } from './sounder.js';
import { sampleDepth, section, trenchAxis, steepest, hypsometry, GRID_VERTICAL_UNCERTAINTY_M, distanceKm, R_EARTH_KM } from './bathy.js';
import { zoneAt, sunlightFraction, ambientColor } from './light.js';
import { pressureFromDepth } from './seawater.js';

/** Categorical slots 1–4 of the dataviz reference (dark steps, validated on #0b1120); shape is the second encoding. */
export const KIND_STYLE = Object.freeze({
    trench:   { color: '#3987e5', shape: 'circle',   label: SITE_KINDS.trench },
    fracture: { color: '#d95926', shape: 'triangle', label: SITE_KINDS.fracture },
    basin:    { color: '#199e70', shape: 'square',   label: SITE_KINDS.basin },
    plain:    { color: '#c98500', shape: 'diamond',  label: SITE_KINDS.plain },
});

/** Depth ramp: ONE hue, light (shallow) → dark (deep). Stops in metres of depth. */
export const DEPTH_RAMP = Object.freeze([
    [0, [214, 236, 255]], [2000, [140, 190, 240]], [4000, [70, 135, 215]], [6000, [36, 88, 180]], [8500, [22, 52, 138]], [11000, [14, 28, 92]],
]);
export const LAND_COLOR = Object.freeze([86, 92, 84]);
export function depthColor(depthM) {
    if (!(depthM > 0)) return LAND_COLOR;
    const R = DEPTH_RAMP;
    if (depthM >= R[R.length - 1][0]) return R[R.length - 1][1];
    let k = 1;
    while (R[k][0] < depthM) k++;
    const f = (depthM - R[k - 1][0]) / (R[k][0] - R[k - 1][0]);
    return R[k - 1][1].map((v, i) => Math.round(v + f * (R[k][1][i] - v)));
}

/** Temperature ramp for the 3D cast strings: one hue (amber), dark = cold. log-ish in °C because the deep sea lives in 0–4 °C. */
export function temperatureColor(tC) {
    const f = Math.max(0, Math.min(1, Math.log1p(Math.max(tC, -2) + 2) / Math.log1p(32)));
    const a = [92, 40, 16], b = [255, 226, 160];
    return a.map((v, i) => Math.round(v + f * (b[i] - v)));
}

/** The point a site is measured at: its deepest baked cell, or — for an abyssal plain — the window centre. */
export function sitePoint(site, meta) {
    if (site.kind === 'custom') return { lat: site.lat, lon: site.lon, depth: null, basis: 'your point' };
    if (site.kind === 'plain') return { lat: site.lat, lon: site.lon, depth: null, basis: 'window centre' };
    return { lat: meta.deepest.lat, lon: meta.deepest.lon, depth: meta.deepest.depth_m, basis: 'deepest grid cell' };
}

/**
 * One table row per site from the index + casts alone (no grid needed, so the table renders at boot).
 * For a plain the floor depth is the window's MEDIAN ocean depth (the plain itself), never its deepest hole.
 */
export function siteSummaries(index, casts) {
    const metaById = new Map(index.sites.map((m) => [m.id, m]));
    return SEAFLOOR_SITES.filter((s) => metaById.has(s.id)).map((site) => {
        const meta = metaById.get(site.id);
        const pt = sitePoint(site, meta);
        const floorDepth = site.kind === 'plain' ? meta.median_depth_m : meta.deepest.depth_m;
        const list = (casts && casts.sites[site.id] && casts.sites[site.id].casts) || [];
        const ref = referenceCast(list);
        const column = ref ? buildColumn({ z: ref.z, t: ref.t, s: ref.s, lat: pt.lat, floorDepthM: floorDepth }) : null;
        const floor = column ? floorTemperature(column) : null;
        return {
            id: site.id, name: site.name, deep: site.deep, ocean: site.ocean, kind: site.kind,
            lat: pt.lat, lon: pt.lon, pointBasis: pt.basis,
            gridDepth: floorDepth, gridDeepest: meta.deepest.depth_m, gridUncertainty: GRID_VERTICAL_UNCERTAINTY_M,
            published: site.published, publishedVerified: site.verified,
            casts: list.length, cast: ref && { id: ref.wod_cast, date: ref.date, platform: ref.platform, country: ref.country, dataset: ref.dataset, maxDepth: ref.max_depth_m, km: ref.km },
            floorT: floor && floor.t, floorTheta: floor && floor.theta, floorKind: floor ? floor.kind : null,
            gapM: floor && floor.gapM, floorDbar: pressureSounding(floorDepth, pt.lat).dbar,
            flags: column ? column.flags : ['no-cast'], salinity: column ? column.salinity : null,
        };
    });
}

/** Everything the selected-site panels draw. `at` (optional {lat, lon}) is the sounding point; default the site point. */
export function siteDetail({ site, meta, grid, casts, at = null, beamDeg = BEAMS[2].deg, nominal = NOMINAL_SPEEDS.metric, castId = null, sectionAzimuth = null }) {
    const pt = sitePoint(site, meta);
    const point = at || pt;
    const depthHere = sampleDepth(grid, point.lat, point.lon);
    const list = (casts || []).map((c) => ({ ...c, kmFromPoint: distanceKm(point.lat, point.lon, c.lat, c.lon) }));
    const ref = (castId != null && list.find((c) => c.wod_cast === castId)) || referenceCast(list);
    const floorDepth = site.kind === 'plain' && !at ? meta.median_depth_m : depthHere;
    if (!(depthHere > 0)) {
        // dry land (or outside the window): nothing to sound, and the page says so
        return { point: { lat: point.lat, lon: point.lon, depth: depthHere, custom: !!at || site.kind === 'custom' }, floorDepth: null, column: null, cast: null, casts: list, reach: null, floor: null,
            tMin: null, sofar: null, axis: null, sectionAzimuth: 90, section: section(grid, point.lat, point.lon, 90, 120, 241), steepest: { deg: 0, s: null }, ping: null, echo: null, pressure: null, hyps: hypsometry(grid), withheld: null, land: true };
    }
    const column = ref && floorDepth > 0 ? buildColumn({ z: ref.z, t: ref.t, s: ref.s, lat: point.lat, floorDepthM: floorDepth }) : null;
    // a cast deeper than the floor at THIS point is read only down to the floor
    const reach = column ? Math.min(floorDepth, column.floorDepth) : null;
    const axis = trenchAxis(grid, pt.lat, pt.lon);
    const az = sectionAzimuth != null ? sectionAzimuth : (axis && axis.defined ? axis.acrossDeg : 90);
    const sec = section(grid, point.lat, point.lon, az, 120, 241);
    const ping = column ? sounding(column, reach, { nominal }) : null;
    const echo = depthHere > 0 ? firstReturn(grid, point.lat, point.lon, beamDeg) : null;
    let withheld = null;
    if (ref && ref.max_depth_m >= 6000) withheld = withheldTest({ z: ref.z, t: ref.t, s: ref.s, lat: ref.lat }, Math.max(4500, ref.max_depth_m - 2000));
    return {
        point: { lat: point.lat, lon: point.lon, depth: depthHere, custom: !!at || site.kind === 'custom' },
        floorDepth, column, cast: ref, casts: list, reach,
        floor: column ? { t: columnAt(column, reach, 't'), theta: columnAt(column, reach, 'theta'), c: columnAt(column, reach, 'c'), kind: reach > column.measuredTo + 1e-6 ? 'model' : 'measured' } : null,
        tMin: column && temperatureMinimum(column), sofar: column && soundChannelAxis(column),
        axis, sectionAzimuth: az, section: sec, steepest: steepest(sec),
        ping, echo, pressure: depthHere > 0 ? pressureSounding(depthHere, point.lat) : null,
        hyps: hypsometry(grid), withheld,
    };
}

/** A dive point that is not one of the named sites. */
export function customSite(lat, lon) {
    return { id: 'custom', kind: 'custom', name: 'Open ocean', deep: null, ocean: null, lat, lon, published: null, verified: false };
}

/** Every archived cast (from any site's set) taken within radiusKm of a point, nearest first. */
export function castsNear(castsDoc, lat, lon, radiusKm = 150) {
    if (!castsDoc) return [];
    const out = [], seen = new Set();
    for (const id in castsDoc.sites) for (const c of castsDoc.sites[id].casts) {
        if (seen.has(c.wod_cast)) continue;
        const km = distanceKm(lat, lon, c.lat, c.lon);
        if (km <= radiusKm) { seen.add(c.wod_cast); out.push({ ...c, km: +km.toFixed(1) }); }
    }
    return out.sort((a, b) => a.km - b.km);
}

/**
 * What the water is like at a depth below a detail's sounding point — the dive HUD's numbers.
 * Pressure and light exist everywhere; temperature only where a column does and only down to
 * where it reaches (null otherwise — never borrowed from somewhere else).
 */
export function waterAt(detail, depthM) {
    const d = Math.max(0, depthM), col = detail && detail.column;
    const inCol = col && d >= col.levels[0].z && d <= detail.reach;
    const p = pressureFromDepth(d, detail ? detail.point.lat : 0);
    return {
        depthM: d, zone: zoneAt(d), light: sunlightFraction(d),
        dbar: p, atm: p / 10.1325 + 1,
        t: inCol ? columnAt(col, d, 't') : null, tKind: inCol ? (d > col.measuredTo + 1e-6 ? 'model' : 'measured') : null,
        floorDepth: detail ? detail.point.depth : null, aboveFloorM: detail && detail.point.depth > 0 ? detail.point.depth - d : null,
    };
}
export { ambientColor };

/** The dive HUD for a camera at (lat, lon, depthM) over a grid: the water there and the floor BELOW THE CAMERA. */
export function cameraReport(detail, grid, cam) {
    const w = waterAt(detail, cam.depthM);
    const floor = sampleDepth(grid, cam.lat, cam.lon);
    return { ...w, underwater: cam.depthM > 0, lat: cam.lat, lon: cam.lon, floorDepth: floor, aboveFloorM: floor != null && floor > 0 ? floor - Math.max(0, cam.depthM) : null,
        kmFromPoint: detail ? distanceKm(cam.lat, cam.lon, detail.point.lat, detail.point.lon) : null };
}

/**
 * The globe's surface image: RGBA bytes, nx × ny, row 0 = north. Ocean = the ONE depth ramp, land
 * = a neutral grey that lightens with height, both multiplied by a hillshade (Sobel on a 2-cell
 * baseline, cos φ spacing, light from the north-west, `vertical`× — cartographic, disclosed).
 */
export const GLOBE_SHADE = Object.freeze({ vertical: 12, azimuthDeg: 315, altitudeDeg: 45 });
export function worldTexture(w) {
    const { nx, ny, z, step } = w, out = new Uint8ClampedArray(nx * ny * 4);
    const az = GLOBE_SHADE.azimuthDeg * Math.PI / 180, alt = GLOBE_SHADE.altitudeDeg * Math.PI / 180;
    const lx = Math.sin(az) * Math.cos(alt), ly = Math.cos(az) * Math.cos(alt), lz = Math.sin(alt);
    const dyM = step * Math.PI / 180 * R_EARTH_KM * 1000;
    const at = (i, j) => z[Math.min(ny - 1, Math.max(0, j)) * nx + ((i % nx) + nx) % nx];
    for (let j = 0; j < ny; j++) {
        const lat = 90 - (j + 0.5) * step, dxM = dyM * Math.max(Math.cos(lat * Math.PI / 180), 0.05);
        for (let i = 0; i < nx; i++) {
            const gx = ((at(i + 2, j - 2) + 2 * at(i + 2, j) + at(i + 2, j + 2)) - (at(i - 2, j - 2) + 2 * at(i - 2, j) + at(i - 2, j + 2))) / (16 * dxM) * GLOBE_SHADE.vertical;
            const gy = ((at(i - 2, j - 2) + 2 * at(i, j - 2) + at(i + 2, j - 2)) - (at(i - 2, j + 2) + 2 * at(i, j + 2) + at(i + 2, j + 2))) / (16 * dyM) * GLOBE_SHADE.vertical;
            const n = 1 / Math.hypot(gx, gy, 1);
            // flat ground is exactly 1; slopes facing the light brighten, slopes facing away darken
            const shade = Math.max(0.3, Math.min(1.45, 0.35 + 0.65 * Math.max(0, (-gx * lx - gy * ly + lz) * n) / lz));
            const h = z[j * nx + i];
            const c = h < 0 ? depthColor(-h) : landColor(h);
            const k = (j * nx + i) * 4;
            out[k] = c[0] * shade; out[k + 1] = c[1] * shade; out[k + 2] = c[2] * shade; out[k + 3] = 255;
        }
    }
    return out;
}
export function landColor(elevM) {
    const f = Math.max(0, Math.min(1, elevM / 5000));
    return [Math.round(70 + 60 * f), Math.round(76 + 56 * f), Math.round(66 + 62 * f)];
}

export const fmt = Object.freeze({
    m: (v) => v == null || !Number.isFinite(v) ? '—' : `${Math.round(v).toLocaleString('en-US')} m`,
    km: (v, d = 1) => v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)} km`,
    t: (v, d = 2) => v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)} °C`,
    latlon: (lat, lon) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? 'E' : 'W'}`,
    kind: (k) => k === 'measured' ? 'measured' : k === 'model' ? 'modelled' : 'no cast',
    light: (f) => f >= 0.995 ? 'full sunlight' : f >= 0.01 ? `about ${(f * 100).toFixed(f < 0.1 ? 1 : 0)} % of surface light` : f >= 1e-6 ? 'less than 1 % of surface light' : 'no sunlight',
});
