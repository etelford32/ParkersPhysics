/**
 * climalytix/airflow.js — the location map's AIRFLOW layer, PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no ambient time or randomness (tests/climalytix-airflow.mjs
 * pins every rule); map.js draws what this returns.
 *
 * THE FIELD is our own GFS 10 m wind (u east, v north, m/s) on the same grid
 * window the temperature layer reads — `/api/climalytix/nwp-field?vars=uMs,vMs`
 * — at the SAME time index the heat layer shows (the timeline's crosshair, or
 * now). Nothing stands in for it: no field ⇒ no airflow, and the rail says why.
 *
 * MOTION IS REAL WIND, TIME-COMPRESSED, AND THE COMPRESSION IS PRINTED. A
 * particle moves u·Δt east and v·Δt north with Δt = wall seconds ×
 * FLOW_COMPRESSION (one wall second = one hour of travel), converted to
 * degrees with the cos φ of the PARTICLE's own latitude (an east–west metre
 * is 1/cos φ wider in degrees away from the equator — the gate's negative
 * control drops it and measures the error). The field is held at one
 * forecast instant while particles move: these are STREAKLINES OF A FROZEN
 * FIELD, i.e. the instantaneous airflow pattern, not air-parcel trajectories
 * through time — the rail says so. Back-trajectories that integrate through
 * the run's own times are the smoke layer's job (the next step) and will use
 * `windAt` with a fractional time index.
 *
 * Particles live only INSIDE the data window (the node extent): a particle
 * that leaves it, lands on a gap, or outlives its age is reborn at a seeded
 * random point inside. Seeded (mulberry32) so the same view draws the same
 * picture and the browser gate can compare frames.
 *
 * REDUCED MOTION gets STREAMLINES instead of animation: the same integrator
 * traced from a seeded jittered grid of seeds, drawn once (`streamlines`).
 *
 * THE WIND ROSE is the site's own forecast hours binned by the direction the
 * wind blows FROM (meteorological convention: u > 0 is a WESTERLY, 270°) —
 * the classic sign trap, pinned both ways by the gate. `windRose` takes an
 * optional co-located value series and returns its mean per sector too: that
 * is the POLLUTION ROSE (PM2.5 by arrival direction) once an air-quality
 * series exists, with no change here.
 */

import { wrapNear } from './map-view.js';

/** Default: one wall second of animation = this many seconds of air travel. */
export const FLOW_COMPRESSION = 3600;
/** The compressions the map may choose from (seconds of travel per wall second). */
export const FLOW_COMPRESSIONS = Object.freeze([900, 1800, 3600, 7200, 10800, 21600, 43200, 86400]);
/** A 10 m/s wind should cross about this many CSS px per wall second. */
export const FLOW_TARGET_PX_S = 45;

/**
 * The time compression for a map scale (CSS px per metre on the ground): the
 * listed value whose on-screen speed for a 10 m/s wind is nearest
 * FLOW_TARGET_PX_S in log terms. Zoomed in, an hour of wind crosses the whole
 * map; zoomed out it is a few pixels — so the compression follows the zoom,
 * and the page PRINTS the value in use (`compressionLabel`).
 */
export function compressionFor(pxPerMetre) {
    const ideal = FLOW_TARGET_PX_S / (10 * pxPerMetre);
    let best = FLOW_COMPRESSIONS[0];
    for (const c of FLOW_COMPRESSIONS) if (Math.abs(Math.log(c / ideal)) < Math.abs(Math.log(best / ideal))) best = c;
    return best;
}

/** "1 s = 1 h of travel" style label. */
export function compressionLabel(c) {
    const h = c / 3600;
    return h >= 1 ? `1 s = ${h} h` : `1 s = ${Math.round(h * 60)} min`;
}
/** Speed (m/s) mapped to the top of the wind ramp. */
export const FLOW_SPEED_TOP_MS = 20;
/** The wind palette's altitude for a 10 m field. */
export const FLOW_ALT_KM = 0.01;
export const ROSE_SECTORS = 16;
/** Speed classes for the rose (m/s), Beaufort-like, upper edges. */
export const ROSE_SPEED_EDGES = [2, 5, 8, 12, Infinity];
/** Below this speed a direction is not meaningful: counted as CALM. */
export const CALM_MS = 0.5;

const M_PER_DEG = 111_320;
const COS_FLOOR = 0.15;

/** Seeded PRNG (mulberry32) → () => [0, 1). */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** The node extent of a field: { north, south, west, east } (west/east continuous). */
export function fieldBox(f) {
    return {
        north: f.latN, south: f.latN - (f.nRows - 1) * f.dlat,
        west: f.lonW, east: f.lonW + (f.nCols - 1) * f.dlon,
    };
}

/**
 * Bilinear wind at (lat, lon) for time index t (integer, or fractional to
 * interpolate linearly between the run's times). f = { latN, lonW, dlat,
 * dlon, nRows, nCols, u, v } with u/v laid out [time][row][col] (null/NaN
 * gaps). Returns { u, v } or null outside the nodes / on a gap corner.
 */
export function windAt(f, t, lat, lon) {
    if (!f?.u || !f?.v || t == null || !Number.isFinite(t)) return null;
    const nt = f.u.length / (f.nRows * f.nCols);
    if (t < 0 || t > nt - 1) return null;
    const t0 = Math.min(Math.floor(t), nt - 1), t1 = Math.min(t0 + 1, nt - 1), ft = t - t0;
    const a = at(f, t0, lat, lon);
    if (!a) return null;
    if (ft === 0 || t1 === t0) return a;
    const b = at(f, t1, lat, lon);
    if (!b) return null;
    return { u: a.u + (b.u - a.u) * ft, v: a.v + (b.v - a.v) * ft };
}

function at(f, t, lat, lon) {
    const y = (f.latN - lat) / f.dlat;
    const x = (wrapNear(lon, f.lonW + 180) - f.lonW) / f.dlon;
    if (!(y >= 0 && x >= 0 && y <= f.nRows - 1 && x <= f.nCols - 1)) return null;
    const i = Math.min(Math.floor(y), f.nRows - 2), j = Math.min(Math.floor(x), f.nCols - 2);
    const fy = y - i, fx = x - j;
    const plane = f.nRows * f.nCols, base = t * plane;
    const idx = [base + i * f.nCols + j, base + i * f.nCols + j + 1, base + (i + 1) * f.nCols + j, base + (i + 1) * f.nCols + j + 1];
    const g = (arr) => {
        const q = idx.map((k) => arr[k]);
        if (q.some((x2) => x2 == null || !Number.isFinite(x2))) return null;
        return (q[0] * (1 - fx) + q[1] * fx) * (1 - fy) + (q[2] * (1 - fx) + q[3] * fx) * fy;
    };
    const u = g(f.u), v = g(f.v);
    return u == null || v == null ? null : { u, v };
}

/**
 * Move a point by wind (u, v) m/s for `seconds` of air travel.
 * opts.cosLat false = the NEGATIVE CONTROL (ignores the latitude stretch).
 */
export function displace(lat, lon, u, v, seconds, { cosLat = true } = {}) {
    const c = cosLat ? Math.max(COS_FLOOR, Math.cos(lat * Math.PI / 180)) : 1;
    return { lat: lat + v * seconds / M_PER_DEG, lon: lon + u * seconds / (M_PER_DEG * c) };
}

/** Wind speed → 0‥1 on the ramp. */
export function speed01(u, v) {
    return Math.min(1, Math.hypot(u, v) / FLOW_SPEED_TOP_MS);
}

/** Direction the wind blows FROM, degrees clockwise from north, [0, 360). */
export function fromDirection(u, v) {
    const d = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
    return d === 360 ? 0 : d + 0;
}

/**
 * A particle system over one field. Returns
 *   { particles: [{lat, lon, age, life, prevLat, prevLon, s}], step(dtWall, t), reseed() }
 * `step` advances every particle by dtWall × FLOW_COMPRESSION seconds through
 * the field at time index t; a particle that leaves the box (or `region`,
 * clipped to the box) or lands on a gap is reborn (its prev = its new
 * position, so no streak jumps across the map).
 */
export function createFlow(f, { count = 600, seed = 1, lifeS = [2.5, 5], compression = FLOW_COMPRESSION, region = null } = {}) {
    // Particles live in `region` (the visible part of the data box; default
    // the whole box) so density on screen does not fall as the map zooms in.
    const full = fieldBox(f);
    const box = region ? {
        north: Math.min(full.north, region.north), south: Math.max(full.south, region.south),
        west: Math.max(full.west, region.west), east: Math.min(full.east, region.east),
    } : full;
    if (!(box.north > box.south && box.east > box.west)) return { particles: [], box, step() {}, reseed() {} };
    const rand = rng(seed);
    const spawn = (p) => {
        p.lat = box.south + rand() * (box.north - box.south);
        p.lon = box.west + rand() * (box.east - box.west);
        p.prevLat = p.lat; p.prevLon = p.lon;
        p.age = 0;
        p.life = lifeS[0] + rand() * (lifeS[1] - lifeS[0]);
        p.s = 0; p.born = true;
        return p;
    };
    const particles = Array.from({ length: count }, () => spawn({}));
    // Stagger ages so the field does not pulse in unison.
    for (const p of particles) p.age = rand() * p.life;
    return {
        particles, box,
        step(dtWall, t) {
            const secs = dtWall * compression;
            for (const p of particles) {
                p.born = false;
                p.age += dtWall;
                const w = windAt(f, t, p.lat, p.lon);
                if (!w || p.age > p.life) { spawn(p); continue; }
                const n = displace(p.lat, p.lon, w.u, w.v, secs);
                p.prevLat = p.lat; p.prevLon = p.lon;
                p.lat = n.lat; p.lon = n.lon; p.s = speed01(w.u, w.v);
                if (p.lat > box.north || p.lat < box.south || p.lon < box.west || p.lon > box.east) spawn(p);
            }
        },
        reseed() { for (const p of particles) spawn(p); },
    };
}

/**
 * Streamlines of the field at time index t, for reduced motion: seeds on a
 * jittered n×n grid inside the box, each traced forward `steps` times by
 * `stepS` seconds of travel (midpoint rule). Returns [{ pts:[{lat,lon,s}] }].
 */
export function streamlines(f, t, { n = 14, steps = 24, stepS = 900, seed = 7 } = {}) {
    const box = fieldBox(f);
    const rand = rng(seed);
    const out = [];
    for (let a = 0; a < n; a++) {
        for (let b = 0; b < n; b++) {
            let lat = box.south + (a + 0.2 + 0.6 * rand()) / n * (box.north - box.south);
            let lon = box.west + (b + 0.2 + 0.6 * rand()) / n * (box.east - box.west);
            const pts = [];
            for (let k = 0; k <= steps; k++) {
                const w = windAt(f, t, lat, lon);
                if (!w) break;
                pts.push({ lat, lon, s: speed01(w.u, w.v) });
                const mid = displace(lat, lon, w.u, w.v, stepS / 2);
                const wm = windAt(f, t, mid.lat, mid.lon);
                if (!wm) break;
                ({ lat, lon } = displace(lat, lon, wm.u, wm.v, stepS));
            }
            if (pts.length >= 3) out.push({ pts });
        }
    }
    return out;
}

/**
 * Wind rose: u[], v[] (m/s, aligned; null gaps skipped) binned by the
 * direction the wind blows FROM into `sectors` sectors centred on N, and by
 * speed class. Optional `value[]` (e.g. PM2.5, aligned) gives its mean per
 * sector — the POLLUTION ROSE.
 * Returns { sectors, n, calm, counts[sector][speedClass], freq[sector],
 *           mean[sector] | null, edges }.
 */
export function windRose(u, v, { sectors = ROSE_SECTORS, edges = ROSE_SPEED_EDGES, value = null } = {}) {
    const counts = Array.from({ length: sectors }, () => new Array(edges.length).fill(0));
    const vs = new Array(sectors).fill(0), vn = new Array(sectors).fill(0);
    let n = 0, calm = 0;
    const width = 360 / sectors;
    for (let k = 0; k < u.length; k++) {
        const a = u[k], b = v[k];
        if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
        n++;
        const sp = Math.hypot(a, b);
        if (sp < CALM_MS) { calm++; continue; }
        const sec = Math.floor(((fromDirection(a, b) + width / 2) % 360) / width);
        const cls = edges.findIndex((e) => sp < e);
        counts[sec][cls]++;
        const x = value?.[k];
        if (x != null && Number.isFinite(x)) { vs[sec] += x; vn[sec]++; }
    }
    const freq = counts.map((row) => (n ? row.reduce((s, c) => s + c, 0) / n : 0));
    return {
        sectors, n, calm, counts, freq, edges,
        mean: value ? vs.map((s, i) => (vn[i] ? s / vn[i] : null)) : null,
    };
}

export const SECTOR_NAMES_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** The prevailing sector of a rose: { name, deg, freq } or null. */
export function prevailing(rose) {
    if (!rose?.n) return null;
    let best = 0;
    rose.freq.forEach((x, i) => { if (x > rose.freq[best]) best = i; });
    if (!rose.freq[best]) return null;
    const deg = best * 360 / rose.sectors;
    return { name: rose.sectors === 16 ? SECTOR_NAMES_16[best] : `${deg}°`, deg, freq: rose.freq[best] };
}

/**
 * The POLLUTION ROSE: only the hours where wind AND the value exist (aligned
 * by instant beforehand), binned by FROM direction, with the mean value per
 * sector. `dirtiest`/`cleanest` are the sectors with the highest/lowest mean
 * among those holding at least `minHours` hours (a single hour is an
 * anecdote, not a direction). Returns the windRose shape plus
 * { hours, dirtiest, cleanest } or null when no hour has both.
 */
export function pollutionRose(u, v, value, { minHours = 2, sectors = ROSE_SECTORS } = {}) {
    const keep = [];
    for (let k = 0; k < u.length; k++) {
        const ok = [u[k], v[k], value[k]].every((x) => x != null && Number.isFinite(x));
        if (ok) keep.push(k);
    }
    if (!keep.length) return null;
    const rose = windRose(keep.map((k) => u[k]), keep.map((k) => v[k]), { sectors, value: keep.map((k) => value[k]) });
    const counts = rose.counts.map((row) => row.reduce((s, c) => s + c, 0));
    const name = (i) => (sectors === 16 ? SECTOR_NAMES_16[i] : `${i * 360 / sectors}°`);
    let hi = null, lo = null;
    rose.mean.forEach((m, i) => {
        if (m == null || counts[i] < minHours) return;
        if (!hi || m > hi.mean) hi = { name: name(i), sector: i, mean: m, hours: counts[i] };
        if (!lo || m < lo.mean) lo = { name: name(i), sector: i, mean: m, hours: counts[i] };
    });
    return { ...rose, hours: keep.length, dirtiest: hi, cleanest: lo };
}
