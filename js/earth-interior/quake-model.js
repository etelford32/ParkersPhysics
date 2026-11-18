/**
 * quake-model.js — the LIVE seismic view, as pure numbers.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no fetch, no ambient clock (every function takes nowMs).
 * Gate: `tests/earth-interior-quakes.mjs`.
 *
 * What it does with a real earthquake from USGS's real-time feed and the
 * viewer's location:
 *   · parses the feed (a gap is a gap: a row without coordinates, time or a
 *     magnitude is DROPPED, never defaulted to 0 / the equator / now);
 *   · picks the quake to show — one whose waves are STILL CROSSING THE EARTH
 *     wins (that is what "live" means here), else the newest large one;
 *   · arrival times at the viewer for every phase phases.js traces, each with
 *     its ellipticity correction (ellipticity.js), the station-elevation
 *     correction when the site's elevation is known, a wall-clock instant, and
 *     its ray-theory STRENGTH relative to the strongest arrival in its own
 *     recorded band (amplitude.js);
 *   · the great-circle SLICE through the epicentre, the viewer and the centre
 *     — the one plane every ray between them lies in — and the wavefronts
 *     in it at any instant, from the rays' own sampled paths.
 *
 * The numbers are ray theory in PREM for the CATALOGUE location and depth
 * (USGS's own, revised as the event is reviewed). Not modelled: amplitudes
 * (a phase listed here may be too weak to see), 3-D structure, station
 * elevation. The feed is USGS's public real-time summary; when it is down the
 * view says so and draws no quake — never a fabricated one.
 */

import { R_EARTH_KM } from './prem.js';
import { travelTimeTable, arrivals, premPhaseModel, PHASE_INFO } from './phases.js';
import { ellipticityCorrection, pathGeometry, geocentricLatDeg } from './ellipticity.js';
import { phaseAmplitude, visibility, elevationCorrection } from './amplitude.js';

export const USGS_FEEDS = Object.freeze({
    day: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson',     // updated every minute
    week: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson',   // the larger events
});
/** After this long every phase drawn here has reached the far side (SS at 180° ≈ 44 min). */
export const WAVE_WINDOW_S = 60 * 60;
/** The phases whose fronts are drawn crossing the slice. */
export const FRONT_PHASES = Object.freeze(['P', 'p', 'PKP', 'PKIKP', 'PcP', 'PP', 'pP', 'S', 's', 'SKS', 'ScS', 'SS', 'sS']);
/** If the viewer has never set a location: USGS's National Earthquake Information Center, Golden, CO — and the page says so. */
export const FALLBACK_SITE = Object.freeze({ lat: 39.7547, lon: -105.2212, name: 'Golden, CO (USGS NEIC) — set your location', fallback: true });
const DEG = Math.PI / 180;

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));

/** USGS GeoJSON → [{ id, lat, lon, depthKm, mag, magType, place, timeMs, updatedMs, url, tsunami, alert, status }]. */
export function parseUsgsFeed(json) {
    const out = [];
    for (const f of json?.features ?? []) {
        const c = f?.geometry?.coordinates, pr = f?.properties ?? {};
        if (!Array.isArray(c) || c.length < 3) continue;
        const lon = num(c[0]), lat = num(c[1]), depthKm = num(c[2]), mag = num(pr.mag), timeMs = num(pr.time);
        if (![lon, lat, depthKm, mag, timeMs].every(Number.isFinite)) continue;
        if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
        out.push({
            id: String(f.id ?? `${timeMs}:${lat}:${lon}`), lat, lon,
            // A few events carry a small negative depth (above sea level); the model's surface is the floor.
            depthKm: Math.max(0, depthKm), depthReportedKm: depthKm,
            mag, magType: pr.magType ?? null, place: pr.place ?? null, timeMs,
            updatedMs: Number.isFinite(num(pr.updated)) ? num(pr.updated) : null,
            url: typeof pr.url === 'string' ? pr.url : null,
            tsunami: pr.tsunami === 1, alert: pr.alert ?? null, status: pr.status ?? null,
        });
    }
    return out;
}

/** Union of feeds by id (the newest `updatedMs` wins), newest event first. */
export function mergeQuakes(...lists) {
    const by = new Map();
    for (const l of lists) for (const q of l ?? []) {
        const o = by.get(q.id);
        if (!o || (q.updatedMs ?? 0) >= (o.updatedMs ?? 0)) by.set(q.id, q);
    }
    return [...by.values()].sort((a, b) => b.timeMs - a.timeMs);
}

/**
 * The quake to open on. A quake whose waves are still in the Earth (and big
 * enough to be recorded across it, M ≥ 4.5) is LIVE and wins; else the newest
 * M ≥ 6 in the list; else the newest M ≥ 4.5; else the newest of all.
 * Returns { quake, reason } or { quake: null }.
 */
export function pickDefaultQuake(quakes, nowMs) {
    if (!quakes?.length) return { quake: null, reason: 'none' };
    const age = (q) => (nowMs - q.timeMs) / 1000;
    const live = quakes.filter((q) => q.mag >= 4.5 && age(q) >= 0 && age(q) < WAVE_WINDOW_S);
    if (live.length) return { quake: live.reduce((a, b) => (b.mag > a.mag ? b : a)), reason: 'live' };
    for (const [m, reason] of [[6, 'recent-large'], [4.5, 'recent']]) {
        const q = quakes.find((x) => x.mag >= m);
        if (q) return { quake: q, reason };
    }
    return { quake: quakes[0], reason: 'recent' };
}

/** A stored location (`ppx_user_location`: { lat, lon, city?, displayName? }) → a site, or the flagged fallback. */
export function siteFromLocation(loc) {
    const lat = num(loc?.lat), lon = num(loc?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return { ...FALLBACK_SITE };
    return { lat, lon: ((lon + 540) % 360) - 180, name: loc.city || loc.displayName || `${lat.toFixed(2)}°, ${lon.toFixed(2)}°`, fallback: false };
}

/**
 * Arrivals at the site: the FIRST arrival of each phase (later branches of a
 * triplication are counted, not listed), spherical time + ellipticity
 * correction, and the wall-clock instant. `table` is travelTimeTable(depth).
 */
export function arrivalsAt(quake, site, table, { model = premPhaseModel(), correct = true, amplitudes = true } = {}) {
    const geo = pathGeometry(quake.lat, quake.lon, site.lat, site.lon);
    const all = arrivals(geo.deltaDeg, table);
    // Station elevation (km above PREM's sea-level surface); unknown ⇒ no correction, and the row says so.
    const hKm = Number.isFinite(site.elevationM) ? site.elevationM / 1000 : null;
    const rows = [], seen = new Map();
    for (const a of all) {
        if (seen.has(a.phase)) { seen.get(a.phase).laterBranches++; continue; }
        const info = PHASE_INFO[a.phase];
        const ray = correct || amplitudes ? rayFor(a, quake.depthKm, model) : null;
        let corrS = null, elevS = null, amp = null, ampReason = null;
        if (correct && ray) {
            // A ray that went the LONG way round (Δ_ray > 180°) leaves along the opposite azimuth.
            corrS = ellipticityCorrection(ray, model, { thetaS: geo.thetaS, azimuthRad: a.deltaRay > 180 ? geo.azimuthRad + Math.PI : geo.azimuthRad });
        }
        // The wave the station RECORDS is the last leg's (SKS arrives as S, ScP as P).
        const lastSet = ray?.legs.at(-1)?.set;
        const recorded = lastSet ? (lastSet === 'P' ? 'P' : 'S') : (a.phase.endsWith('diff') ? a.phase[0] : info.wave);
        if (correct && hKm !== null) elevS = elevationCorrection(a.p, recorded, hKm);
        if (amplitudes && ray) {
            const r = phaseAmplitude(ray, { model, sourceDepthKm: quake.depthKm });
            amp = r.amp; ampReason = r.reason ?? null;
        } else if (amplitudes) ampReason = 'no ray';
        const totalS = a.timeS + (corrS ?? 0) + (elevS ?? 0);
        const row = { phase: a.phase, kind: info.kind, family: info.family, wave: info.wave, recorded, p: a.p, slownessSDeg: a.p * DEG,
            deltaRay: a.deltaRay, timeS: a.timeS, corrS, elevS, totalS, arriveMs: quake.timeMs + totalS * 1000, laterBranches: 0,
            amp, ampReason, db: null, strength: null };
        seen.set(a.phase, row); rows.push(row);
    }
    rows.sort((x, y) => x.totalS - y.totalS);
    // Strength is ranked WITHIN each recorded band (P read at 1 Hz on the vertical, S at 0.2 Hz on
    // the horizontals) — comparing across bands would compare two different instruments' readings.
    for (const band of ['P', 'S']) {
        const inBand = rows.filter((r) => r.recorded === band && r.amp > 0);
        const ref = Math.max(0, ...inBand.map((r) => r.amp));
        for (const r of inBand) { const v = visibility(r.amp, ref); r.db = v.db; r.strength = v.label; }
    }
    return { geometry: geo, rows, elevationKm: hKm };
}

/** The ray behind an interpolated arrival (diffracted phases carry their arc). */
export function rayFor(a, depthKm, model = premPhaseModel()) {
    if (a.phase === 'Pdiff' || a.phase === 'Sdiff') {
        const g = model.diffractedRay(a.phase, 0, { sourceDepthKm: depthKm });
        return g ? model.diffractedRay(a.phase, Math.max(0, (a.deltaRay - g.deltaDeg) * DEG), { sourceDepthKm: depthKm }) : null;
    }
    return model.phaseRay(a.phase, a.p, { sourceDepthKm: depthKm });
}

/** Canonical frame (+X Greenwich, +Y north, −Z = 90°E), GEOCENTRIC latitude. */
export function geoVec(latDeg, lonDeg) {
    const la = geocentricLatDeg(latDeg) * DEG, lo = lonDeg * DEG, c = Math.cos(la);
    return [c * Math.cos(lo), Math.sin(la), -c * Math.sin(lo)];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(...a); return a.map((x) => x / l); };

/**
 * The great-circle slice: e1 = epicentre, e2 = in-plane toward the site,
 * n = e1 × e2 (the side the camera looks from). A site at the epicentre or
 * its antipode has no unique plane; the meridian through the epicentre is used.
 */
export function slicePlane(quake, site) {
    const e1 = geoVec(quake.lat, quake.lon), u = geoVec(site.lat, site.lon);
    let w = u.map((x, i) => x - dot(u, e1) * e1[i]);
    let degenerate = false;
    if (Math.hypot(...w) < 1e-6) {
        degenerate = true;
        const north = [0, 1, 0];
        w = north.map((x, i) => x - dot(north, e1) * e1[i]);
        if (Math.hypot(...w) < 1e-6) w = [1, 0, 0];
    }
    const e2 = unit(w), n = cross(e1, e2);
    return { e1, e2, n, degenerate, siteAngleRad: Math.atan2(dot(u, e2), dot(u, e1)) };
}

/** A point in the slice, (r km, φ from the epicentre toward the site) → unit-radius world vector. */
export function planePoint(plane, rKm, phi) {
    const s = rKm / R_EARTH_KM, c = Math.cos(phi), d = Math.sin(phi);
    return [0, 1, 2].map((i) => s * (c * plane.e1[i] + d * plane.e2[i]));
}

/**
 * The ray FAN for the wavefronts: rays of every FRONT_PHASES branch, thinned to
 * ~`perSegment` per branch, each sampled along its path and PACKED as a
 * Float64Array of [rKm, deltaRad, tS, wave(0 = P, 1 = S)] per node — so a
 * Worker can hand it over by transfer. `wave` is the wave type ON that
 * stretch (SKS runs as P through the liquid core).
 */
export function buildFan(table, depthKm, { model = premPhaseModel(), perSegment = 36 } = {}) {
    const fan = [];
    for (const name of FRONT_PHASES) {
        for (const seg of table[name] ?? []) {
            const step = Math.max(1, Math.floor(seg.length / perSegment));
            const rays = [];
            for (let i = 0; i < seg.length; i += step) rays.push(seg[i]);
            if (rays.at(-1) !== seg.at(-1)) rays.push(seg.at(-1));
            fan.push({ phase: name, rays: rays.map((r) => packPath(sampleRay(r, model))) });
        }
    }
    return fan;
}

/** A ray's path in travel order: [{ rKm, deltaRad, tS, wave }]. */
export function sampleRay(ray, model = premPhaseModel()) {
    const { nodes } = model.samplePath(ray, { sub: 1 });
    // Tag each node with the wave it travels as: walk the legs again by radius order.
    const out = [];
    let li = 0, legStartT = 0;
    const legs = ray.legs;
    for (let k = 0; k < nodes.length; k++) {
        const nd = nodes[k];
        while (li < legs.length - 1 && legEndsAt(legs[li], nodes, k, legStartT)) { li++; legStartT = nd.tS; }
        const l = legs[li], set = l.set;
        const wave = set === 'K' ? (nd.rKm < model.cmbKm - 1e-6 ? 'P' : 'S') : set;
        out.push({ rKm: nd.rKm, deltaRad: nd.deltaRad, tS: nd.tS, wave });
    }
    return out;
    function legEndsAt(leg, ns, k) {
        // A leg ends when the path reaches its far radius (down: lo, up: hi) — or for an arc, after its angle.
        const prev = ns[k - 1];
        if (!prev) return false;
        if (leg.arc) return false;
        const end = leg.dir < 0 ? leg.lo : leg.hi;
        return Math.abs(prev.rKm - end) < 1e-6 && k > 1;
    }
}

export const FAN_STRIDE = 4;
/** Path nodes → Float64Array [r, δ, t, wave] × n. */
export function packPath(nodes) {
    const a = new Float64Array(FAN_STRIDE * nodes.length);
    nodes.forEach((n, i) => { a[4 * i] = n.rKm; a[4 * i + 1] = n.deltaRad; a[4 * i + 2] = n.tS; a[4 * i + 3] = n.wave === 'S' ? 1 : 0; });
    return a;
}

/** Where along a packed path the wave is at time t: { rKm, deltaRad, wave } or null (not yet left / already arrived). */
export function positionAt(path, tS) {
    const n = path.length / FAN_STRIDE;
    if (n < 2 || tS < 0 || tS > path[4 * (n - 1) + 2]) return null;
    let a = 0, b = n - 1;
    while (b - a > 1) { const m = (a + b) >> 1; if (path[4 * m + 2] <= tS) a = m; else b = m; }
    const ta = path[4 * a + 2], tb = path[4 * b + 2], f = tb > ta ? (tS - ta) / (tb - ta) : 0;
    return {
        rKm: path[4 * a] + f * (path[4 * b] - path[4 * a]),
        deltaRad: path[4 * a + 1] + f * (path[4 * b + 1] - path[4 * a + 1]),
        wave: (f < 0.5 ? path[4 * a + 3] : path[4 * b + 3]) ? 'S' : 'P',
    };
}

/**
 * The wavefronts at time t: per fan branch, polylines of { rKm, phi, wave } on
 * BOTH sides of the epicentre (a wave leaves in every direction; the slice
 * shows φ and −φ). A front breaks where a ray has not started or has already
 * surfaced. A ray that ran past 180° keeps going round: φ = Δ wraps.
 */
export function wavefronts(fan, tS) {
    const out = [];
    for (const br of fan) {
        for (const side of [1, -1]) {
            let cur = [];
            for (const path of br.rays) {
                const q = positionAt(path, tS);
                if (q) cur.push({ rKm: q.rKm, phi: side * q.deltaRad, wave: q.wave });
                else if (cur.length) { if (cur.length > 1) out.push({ phase: br.phase, points: cur }); cur = []; }
            }
            if (cur.length > 1) out.push({ phase: br.phase, points: cur });
        }
    }
    return out;
}

/** A ray to the site in the slice: [{ rKm, phi, tS, wave }], φ toward the site (or the long way round). */
export function rayToSite(arrival, quake, model = premPhaseModel()) {
    const ray = rayFor(arrival, quake.depthKm, model);
    if (!ray) return null;
    const side = arrival.deltaRay > 180 ? -1 : 1;
    return sampleRay(ray, model).map((n) => ({ rKm: n.rKm, phi: side * n.deltaRad, tS: n.tS, wave: n.wave }));
}

/** The live state of the view at nowMs: elapsed seconds, which arrivals are past, the next one. */
export function liveState(quake, rows, nowMs) {
    const t = (nowMs - quake.timeMs) / 1000;
    const next = rows.find((r) => r.arriveMs > nowMs) ?? null;
    return { elapsedS: t, inFlight: t >= 0 && t < (rows.at(-1)?.totalS ?? 0) + 30, arrived: rows.filter((r) => r.arriveMs <= nowMs).length, next };
}

/** "3 min 07 s" / "in 3 min 07 s" / "4 h ago" for the countdowns. */
export function fmtDuration(s) {
    if (!Number.isFinite(s)) return '—';
    const a = Math.abs(s);
    if (Math.round(a) < 60) return `${Math.round(a)} s`;          // 59.6 s is "1 min 00 s", never "60 s"
    if (a < 3600) { const m = Math.floor(a / 60), r = Math.round(a - 60 * m); return r === 60 ? `${m + 1} min 00 s` : `${m} min ${String(r).padStart(2, '0')} s`; }
    if (a < 86400 * 2) return `${(a / 3600).toFixed(a < 36000 ? 1 : 0)} h`;
    return `${Math.round(a / 86400)} d`;
}

/** Depth bins for the quake LIST's quick first-arrival estimate (the selected quake gets its exact depth). */
export const LIST_DEPTHS_KM = Object.freeze([0, 10, 20, 35, 50, 70, 100, 150, 200, 300, 400, 500, 600, 700]);
const FIRST_NAMES = ['P', 'p', 'PKP', 'PKIKP', 'Pdiff'];
/**
 * First P-type arrival at the site, INTERPOLATED in depth between the two
 * tabulated depths that bracket the event (nearest-bin rounding missed by up
 * to 3.8 s at 233 km — measured; the gate holds the interpolation to the
 * page's stated ~0.5 s). Labelled ≈ on the page.
 */
export function quickFirstArrival(quake, site, { tableAt = (d) => travelTimeTable(d, { names: FIRST_NAMES }) } = {}) {
    const z = Math.max(0, Math.min(LIST_DEPTHS_KM.at(-1), quake.depthKm));
    let i = LIST_DEPTHS_KM.findIndex((d) => d >= z); if (i <= 0) i = 1;
    const d0 = LIST_DEPTHS_KM[i - 1], d1 = LIST_DEPTHS_KM[i], w = (z - d0) / (d1 - d0);
    const geo = pathGeometry(quake.lat, quake.lon, site.lat, site.lon);
    const a0 = arrivals(geo.deltaDeg, tableAt(d0))[0] ?? null, a1 = arrivals(geo.deltaDeg, tableAt(d1))[0] ?? null;
    const a = a0 && a1 ? { phase: w < 0.5 ? a0.phase : a1.phase, timeS: a0.timeS + w * (a1.timeS - a0.timeS) } : (a0 ?? a1);
    return { deltaDeg: geo.deltaDeg, phase: a?.phase ?? null, timeS: a?.timeS ?? null, arriveMs: a ? quake.timeMs + a.timeS * 1000 : null, depthsKm: [d0, d1] };
}

/**
 * Attach a DEM elevation (metres, Terrarium; null when the tiles could not be
 * read) to a site. Below sea level (open ocean, a basin) the station is taken
 * AT sea level — PREM's surface — and the note says so; an unknown elevation
 * is left unknown (no correction), never 0.
 */
export function siteWithElevation(site, hM, source = 'Terrain Tiles (AWS Open Data)') {
    if (!Number.isFinite(hM)) return { ...site, elevationM: null, elevationNote: 'elevation unknown — no station correction' };
    if (hM < 0) return { ...site, elevationM: 0, elevationNote: `ground ${Math.round(hM)} m (below sea level / water) — station taken at sea level` };
    return { ...site, elevationM: hM, elevationNote: `${Math.round(hM).toLocaleString('en-US')} m above sea level (${source})` };
}
