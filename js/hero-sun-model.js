/**
 * hero-sun-model.js — PURE model for the homepage hero's live Sun and its
 * "Next 24 h" preview (js/hero-sun.js draws it, js/hero-rope-layer.js owns
 * the scrubber tab that plays it).
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no three.js, no fetch, no ambient time: every function takes its
 * clock explicitly, so `node tests/hero-sun-model.mjs` pins it.
 *
 * ── Frame ──────────────────────────────────────────────────────────────────
 * Everything here is in the FLUX-ROPE FRAME (`js/flux-rope/view.js`
 * `ropeFrame`): heliocentric, +x = Sun→Earth, +z = ecliptic north, +y =
 * +x rotated 90° toward the direction of solar rotation — i.e. Stonyhurst
 * WEST (W90 limb). A heliographic (lat, lon) is
 *     (cos lat cos lon, cos lat sin lon, sin lat)
 * which is exactly `ropeFrame(lon, lat, 0).eDir` — the test pins it — so a
 * region on the drawn Sun and a CME rope launched from it share ONE frame,
 * the identity `js/corridor/corridor-model.js` is built on. The hero maps
 * this frame into its scene with `heroBasis` (hero-rope-layer.js). The
 * solar axis is drawn along ecliptic north: B0 (±7.25°) and the P angle are
 * not modelled, the same simplification the rope frame makes.
 *
 * ── What moves over the 24 h ───────────────────────────────────────────────
 *   · REGIONS CO-ROTATE. A NOAA region's Stonyhurst longitude drifts west at
 *     the SYNODIC rate for its latitude: the sidereal equatorial rate
 *     (25.38 d, flare-geometry.js) times the Snodgrass factor the whole site
 *     uses (`diffRotFactor`, sun-observed.js), minus Earth's orbital motion.
 *     ~13.2°/day at the equator — a region visibly crosses the disc in a
 *     24 h preview, and one near W80 sets behind the limb.
 *   · CMEs DO NOT. Launched ropes are ballistic; the flux-rope KERNEL (WASM,
 *     js/flux-rope-kernel.js) propagates them. This module only chooses
 *     WHICH catalogued CMEs the engine is handed (`activityCmes`) and builds
 *     the engine preset through the provider's own converter
 *     (`donkiToTrainPreset`) — it computes no kinematics.
 *
 * ── What is drawn, and what is only a picture ──────────────────────────────
 * Region POSITIONS are NOAA's. Everything else about a region's look is a
 * SCHEMATIC keyed to its published numbers and labelled as such by the
 * page: the sunspot bipole is laid along Joy's law (flare-geometry
 * `joyTiltRad` — the same PRIOR the flare arcade uses when no field atlas
 * is loaded), its size follows the region's area (√area, so it reads at
 * 150 px), and the coronal loops are nested bipole arcs (`regionLoops`,
 * great-circle footpoints lifted by flare-geometry's own `arcadeLoops`).
 * `activityHeat` is a DISPLAY mapping of SWPC's 24 h M/X probabilities (or
 * of magnetic complexity + area when the probabilities are absent) onto a
 * 0..1 glow — never a probability itself.
 */

import { diffRotFactor } from './sun-observed.js';
import { SUN_SIDEREAL_DAYS, joyTiltRad, arcadeLoops, parseStonyhurst } from './flare-geometry.js';
import { detectProbabilityScale, readProbability } from './farside/flare-climatology.js';
import { donkiToTrainPreset } from './flux-rope-live.js';

const DEG = Math.PI / 180;
const HOUR = 3600e3;
const DAY = 86400e3;
const AU_KM = 1.495978707e8;

/** Earth's mean orbital rate, deg/day — the sidereal→synodic correction. */
export const EARTH_ORBIT_DEG_PER_DAY = 360 / 365.2564;
/** Sidereal equatorial rate, deg/day (flare-geometry's 25.38 d). */
export const SIDEREAL_EQ_DEG_PER_DAY = 360 / SUN_SIDEREAL_DAYS;
/** The preview's horizon. */
export const OUTLOOK_HOURS = 24;
/** Most regions the photosphere shader carries (uniform arrays). */
export const MAX_REGIONS = 12;
/** CMEs older than this are not handed to the engine for the preview. */
export const CME_LOOKBACK_H = 72;
/** A rope whose apex has passed this is out of the drawn scene. */
export const CME_SCENE_AU = 1.35;

// ═══════════════════════════════════════════════════════════════════════════
//  Rotation
// ═══════════════════════════════════════════════════════════════════════════

/** Synodic (Stonyhurst) drift of a surface feature, deg/day, westward. */
export function stonyhurstDriftDegPerDay(latDeg) {
    return SIDEREAL_EQ_DEG_PER_DAY * diffRotFactor((latDeg || 0) * DEG) - EARTH_ORBIT_DEG_PER_DAY;
}

/** Wrap degrees into (−180, 180]. */
export function wrap180(d) {
    let x = ((d + 180) % 360 + 360) % 360 - 180;
    if (x === -180) x = 180;
    return x;
}

/** Heliographic (lat, lon) degrees → unit vector in the flux-rope frame. */
export function helioUnit(latDeg, lonDeg, out = [0, 0, 0]) {
    const la = latDeg * DEG, lo = lonDeg * DEG;
    const cl = Math.cos(la);
    out[0] = cl * Math.cos(lo); out[1] = cl * Math.sin(lo); out[2] = Math.sin(la);
    return out;
}

/**
 * Local tangent directions at (lat, lon) in the flux-rope frame:
 * `west` = ∂/∂lon (the direction of rotation), `north` = ∂/∂lat.
 */
export function tangentAt(latDeg, lonDeg) {
    const la = latDeg * DEG, lo = lonDeg * DEG;
    const sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
    return {
        west: [-so, co, 0],
        north: [-sl * co, -sl * so, cl],
    };
}

/**
 * Joy's-law bipole axis (following → LEADING spot) at (lat, lon): tilted
 * from local west by `joyTiltRad`, leading spot equatorward. Unit, tangent.
 */
export function bipoleAxisAt(latDeg, lonDeg) {
    const { west, north } = tangentAt(latDeg, lonDeg);
    const g = joyTiltRad(latDeg * DEG);
    const c = Math.cos(g), s = Math.sin(g);
    return [west[0] * c + north[0] * s, west[1] * c + north[1] * s, west[2] * c + north[2] * s];
}

// ═══════════════════════════════════════════════════════════════════════════
//  Regions
// ═══════════════════════════════════════════════════════════════════════════

/** 'YYYY-MM-DD' (or any Date.parse-able stamp) → epoch ms, UTC. NaN on junk. */
function stampMs(s) {
    if (s == null) return NaN;
    const str = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return Date.parse(str + 'T00:00:00Z');
    const t = Date.parse(str.includes('T') || str.endsWith('Z') ? str : str.replace(' ', 'T') + 'Z');
    return Number.isFinite(t) ? t : Date.parse(str);
}

/**
 * /api/noaa/regions `data.regions` rows → the regions on the disc NOW, one
 * row per region number.
 *
 * SWPC's solar_regions.json carries a HISTORY (one row per region per
 * report day), so a region appears several times and a region that rotated
 * off days ago is still listed. Keep each region's LATEST report, then keep
 * only regions reported on the feed's newest date. The report's positions
 * are for 00 UTC of `observed_date` (the SRS convention); `anchorMs` is that
 * instant and `regionAt` carries them forward. Probabilities are read with
 * the site's ONE percent/fraction decision (flare-climatology), over the
 * whole feed. Largest regions first, capped at MAX_REGIONS.
 *
 * @param {Array} rows
 * @param {{ fallbackAnchorMs?: number }} [opt] anchor for rows without a date
 */
export function latestRegions(rows, { fallbackAnchorMs = NaN } = {}) {
    const list = Array.isArray(rows) ? rows.filter((r) => r && r.region != null) : [];
    if (!list.length) return [];
    const scale = detectProbabilityScale(list, 'm');
    const byRegion = new Map();
    for (const r of list) {
        const key = String(r.region).trim();
        const t = stampMs(r.observed_date);
        const prev = byRegion.get(key);
        if (!prev || (Number.isFinite(t) && !(t <= prev.t))) byRegion.set(key, { r, t });
    }
    let newest = -Infinity;
    for (const { t } of byRegion.values()) if (Number.isFinite(t) && t > newest) newest = t;
    const out = [];
    for (const [key, { r, t }] of byRegion) {
        if (Number.isFinite(newest) && Number.isFinite(t) && t < newest) continue;   // rotated off / decayed
        let lat = Number(r.latitude_deg), lon = Number(r.stonyhurst_lon_deg);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            const p = parseStonyhurst(r.location);
            if (!p) continue;
            lat = p.latDeg; lon = p.lonDeg;
        }
        const anchorMs = Number.isFinite(t) ? t : fallbackAnchorMs;
        if (!Number.isFinite(anchorMs)) continue;
        // Mount Wilson class, spelled out ("Beta-Gamma-Delta") or as SWPC's
        // short code ("BGD"): γ or δ is what makes a region complex.
        const mag = String(r.mag_class ?? '').trim().toUpperCase();
        const complex = /GAMMA|DELTA/.test(mag) || (/^[ABGD-]{1,5}$/.test(mag) && /[GD]/.test(mag));
        out.push({
            region: key,
            latDeg: lat,
            lonDeg: lon,
            anchorMs,
            area: Math.max(0, Number(r.area) || 0),
            magClass: r.mag_class ?? null,
            spotClass: r.spot_class ?? null,
            complex,
            pM: readProbability(r, 'm', scale),
            pX: readProbability(r, 'x', scale),
        });
    }
    out.sort((a, b) => b.area - a.area);
    return out.slice(0, MAX_REGIONS);
}

/** Where a region is at `tMs`: drifted longitude, and whether it faces Earth. */
export function regionAt(reg, tMs) {
    const dtDays = (tMs - reg.anchorMs) / DAY;
    const lonDeg = wrap180(reg.lonDeg + stonyhurstDriftDegPerDay(reg.latDeg) * dtDays);
    return { latDeg: reg.latDeg, lonDeg, earthFacing: Math.abs(lonDeg) < 90 };
}

/** Rotation angle (rad, about +z) carrying the region from its anchor to `tMs`. */
export function regionTurnRad(reg, tMs) {
    return stonyhurstDriftDegPerDay(reg.latDeg) * ((tMs - reg.anchorMs) / DAY) * DEG;
}

/**
 * When (epoch ms) the region next crosses Stonyhurst lon `limbDeg` (default
 * the W limb, +90) after `fromMs`, or null if it does not within `withinMs`.
 */
export function limbCrossingMs(reg, fromMs, withinMs = OUTLOOK_HOURS * HOUR, limbDeg = 90) {
    const lon0 = regionAt(reg, fromMs).lonDeg;
    if (lon0 >= limbDeg) return null;
    const rate = stonyhurstDriftDegPerDay(reg.latDeg);
    if (!(rate > 0)) return null;
    const t = fromMs + ((limbDeg - lon0) / rate) * DAY;
    return t - fromMs <= withinMs ? t : null;
}

/**
 * Drawn bipole geometry (radians of arc on the unit Sun): half-separation of
 * the two spot centres and the leading umbra radius. √area so a 1000 MSH
 * group reads ~2× a 250 MSH one; floors so a small α region still shows.
 * A picture of the region's size, not a spot-area measurement.
 */
export function bipoleSize(area) {
    const a = Math.max(0, Number(area) || 0);
    return {
        halfSepRad: (2.2 + 0.26 * Math.sqrt(a)) * DEG,
        umbraRad: (0.55 + 0.055 * Math.sqrt(a)) * DEG,
    };
}

/**
 * 0..1 glow for a region — a DISPLAY mapping, not a probability. From SWPC's
 * 24 h M/X probabilities when published; otherwise from complexity + area.
 */
export function activityHeat(reg) {
    const pm = Number.isFinite(reg?.pM) ? reg.pM : null;
    const px = Number.isFinite(reg?.pX) ? reg.pX : null;
    let h;
    if (pm !== null || px !== null) h = 0.18 + 1.1 * (pm ?? 0) + 2.2 * (px ?? 0);
    else h = 0.2 + (reg?.complex ? 0.3 : 0) + 0.35 * Math.min(1, (reg?.area ?? 0) / 800);
    return Math.max(0, Math.min(1, h));
}

/**
 * Coronal loops over a region at its ANCHOR position, in the flux-rope frame
 * on a unit Sun: nested arcs across the polarity-inversion line connecting
 * the following to the leading polarity (the Joy's-law bipole), fanned
 * along the PIL. Footpoints are laid here; the lift is flare-geometry's
 * `arcadeLoops` (great circle + sine profile), run in its SUN frame
 * (+x W, +y N, +z Earth) and permuted back: rope (x, y, z) = sun (z, x, y).
 * Deterministic per region (seeded by the region number).
 * @returns {Array<{pts:number[][], apexR:number, weight:number}>}
 */
export function regionLoops(reg, { n = 9, samples = 28 } = {}) {
    const { halfSepRad } = bipoleSize(reg.area);
    const c = helioUnit(reg.latDeg, reg.lonDeg);
    const ax = bipoleAxisAt(reg.latDeg, reg.lonDeg);            // across the PIL
    const pil = [c[1] * ax[2] - c[2] * ax[1], c[2] * ax[0] - c[0] * ax[2], c[0] * ax[1] - c[1] * ax[0]];
    let seed = 0;
    for (const ch of String(reg.region)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const toSun = (v) => [v[1], v[2], v[0]];
    const fromSun = (v) => [v[2], v[0], v[1]];
    const pairs = [];
    for (let k = 0; k < n; k++) {
        const f = n === 1 ? 0.5 : k / (n - 1);
        const span = halfSepRad * (0.45 + 0.95 * f) * (0.9 + 0.2 * rnd());
        const along = halfSepRad * (rnd() * 2 - 1) * 0.75;
        const shear = halfSepRad * 0.35 * (rnd() - 0.3);
        const foot = (sgn) => {
            const p = [0, 0, 0];
            for (let i = 0; i < 3; i++) p[i] = c[i] + ax[i] * sgn * span + pil[i] * (along + sgn * shear);
            return toSun(p);
        };
        // A dipole line's apex rises about half its footpoint separation.
        const apexR = 1 + span * (0.85 + 0.35 * rnd());
        pairs.push({ a: foot(1), b: foot(-1), apexR });
    }
    const sunC = toSun(c);
    const lat = Math.asin(Math.max(-1, Math.min(1, sunC[1])));
    const lon = Math.atan2(sunC[0], sunC[2]);
    return arcadeLoops({ latRad: lat, lonRad: lon, pairs, samples }).map((l) => ({
        pts: l.pts.map(fromSun),
        apexR: l.apexR,
        weight: l.weight,
    }));
}

// ═══════════════════════════════════════════════════════════════════════════
//  Flares on the bus → sites
// ═══════════════════════════════════════════════════════════════════════════

/**
 * swpc-feed `flares` rows ({ time, cls|parsed.letter, location }) → flare
 * sites with a Stonyhurst position AT FLARE TIME. Rows without a parseable
 * location are dropped (disk centre would read as an Earth-directed event).
 */
export function flareSites(rows) {
    const out = [];
    for (const f of Array.isArray(rows) ? rows : []) {
        const t = f?.time instanceof Date ? f.time.getTime() : stampMs(f?.time);
        const p = parseStonyhurst(f?.location);
        const letter = String(f?.parsed?.letter ?? f?.cls ?? f?.class_letter ?? '').trim().charAt(0).toUpperCase();
        if (!Number.isFinite(t) || !p || !'CMX'.includes(letter) || !letter) continue;
        out.push({ timeMs: t, latDeg: p.latDeg, lonDeg: p.lonDeg, letter });
    }
    return out.sort((a, b) => b.timeMs - a.timeMs).slice(0, 8);
}

/** Flash envelope of one flare at τ: 8-min rise, 20-min e-folding decay (cut at 60 min), class-weighted. */
export function flareFlash(site, tMs) {
    const w = { C: 0.35, M: 0.7, X: 1.0 }[site?.letter] ?? 0;
    const d = tMs - site?.timeMs;
    if (!w || !Number.isFinite(d) || d < -8 * 60e3 || d > 60 * 60e3) return 0;
    return w * (d < 0 ? 1 + d / (8 * 60e3) : Math.exp(-d / (20 * 60e3)));
}

// ═══════════════════════════════════════════════════════════════════════════
//  The 24 h preview window + the CMEs the engine propagates through it
// ═══════════════════════════════════════════════════════════════════════════

/** The preview spans NOW → NOW + 24 h. */
export function outlookWindow(nowMs, hours = OUTLOOK_HOURS) {
    return { t0: nowMs, t1: nowMs + hours * HOUR, launches: [], arrivalMs: null, outlook: true };
}

/**
 * The bus's `recent_cmes` (js/swpc-feed.js: { time, speed, latitude,
 * longitude, halfAngle, earthDirected, cme_id }) → the DONKI rows the engine
 * propagates for the preview: EVERY direction (this is the Sun's activity,
 * not the Earth-relevance filter the forecast provider applies), launched
 * within `lookbackH` and not after `nowMs`, ballistically still inside the
 * scene, newest `max` kept (the kernel's rope cap), launch-ascending.
 * Shape = `parseDonkiCmes` output, so `donkiToTrainPreset` takes it as is.
 */
export function activityCmes(rows, nowMs, { lookbackH = CME_LOOKBACK_H, max = 6 } = {}) {
    const list = [];
    for (const c of Array.isArray(rows) ? rows : []) {
        const iso = c?.time instanceof Date ? c.time.toISOString() : c?.time;
        const t = stampMs(iso);
        const v = Number(c?.speed ?? c?.speed_km_s);
        if (!Number.isFinite(t) || !(v > 0) || t > nowMs || nowMs - t > lookbackH * HOUR) continue;
        // Ballistic reach at the END of the preview — a relevance screen only;
        // the engine's DBM owns the real kinematics.
        const reachAu = 0.1 + (v * ((nowMs + OUTLOOK_HOURS * HOUR - t) / 1000)) / AU_KM;
        if (reachAu > CME_SCENE_AU + 1.2) continue;
        const lat = Number(c.latitude ?? c.latitude_deg), lon = Number(c.longitude ?? c.longitude_deg);
        list.push({
            id: `donki-${new Date(t).toISOString()}`,
            cmeId: c.cme_id ?? null,
            timeIso: new Date(t).toISOString(),
            speedKms: v,
            latDeg: Number.isFinite(lat) ? lat : 0,
            lonDeg: Number.isFinite(lon) ? lon : 0,
            halfAngleDeg: Number.isFinite(Number(c.halfAngle ?? c.half_angle_deg)) ? Number(c.halfAngle ?? c.half_angle_deg) : 30,
            earthDirected: c.earthDirected === true || c.earth_directed === true,
        });
    }
    // Dedupe one CME reported by several analyses (same launch minute).
    const seen = new Set();
    const uniq = list.filter((c) => { const k = c.timeIso.slice(0, 16); if (seen.has(k)) return false; seen.add(k); return true; });
    uniq.sort((a, b) => Date.parse(a.timeIso) - Date.parse(b.timeIso));
    return uniq.slice(Math.max(0, uniq.length - max));
}

/**
 * Forecast-shaped object for the preview (the shape hero-rope-layer draws):
 * the engine preset from `donkiToTrainPreset` (§16 interaction ON — the
 * provider's own converter, so the ropes are seeded exactly as the live
 * pipeline seeds them), loaded onto `kernel`. `null` preset → a valid
 * preview with NO ropes (a quiet catalogue is drawn as quiet).
 */
export function buildOutlookForecast(kernel, cmes, nowMs, { ambientWKms = 400 } = {}) {
    const preset = cmes?.length ? donkiToTrainPreset(cmes, { ambientWKms }) : null;
    if (preset && kernel) {
        kernel.setRopes(preset.ropes);
        if (typeof kernel.setInteraction === 'function') kernel.setInteraction(preset.interaction);
    }
    return {
        idle: !preset,
        outlook: true,
        preset: preset ?? { ropes: [], rope: null },
        launchMs: preset ? Date.parse(preset.launchIso) : nowMs,
        kernel: preset ? kernel : null,
        cmes: preset?.cmes ?? [],
        summary: null,
        builtAtMs: nowMs,
    };
}

/**
 * Scrubber marks for the preview: each Earth-directed rope's apex crossing
 * the L1 radius (the kernel's own `apexKmAt`, scanned at `dtMin`), and each
 * region's W-limb setting — both only when inside the window.
 * @returns {Array<{t:number, kind:'arrive'|'set', label:string}>}
 */
export function outlookMarks(fc, win, regions = [], { dtMin = 15, l1Au = 0.99 } = {}) {
    const marks = [];
    if (!win) return marks;
    const k = fc?.kernel;
    const ropes = fc?.preset?.ropes ?? [];
    if (k && typeof k.apexKmAt === 'function') {
        ropes.forEach((r, i) => {
            if (!fc.cmes?.[i]?.earthDirected) return;
            const launch = fc.launchMs + (r.launchOffsetS ?? 0) * 1000;
            let prev = null;
            for (let t = Math.max(win.t0, launch); t <= win.t1; t += dtMin * 60e3) {
                const au = k.apexKmAt(i, (t - fc.launchMs) / 1000) / AU_KM;
                if (prev !== null && prev < l1Au && au >= l1Au) {
                    marks.push({ t, kind: 'arrive', label: `CME ${i + 1} reaches 1 AU` });
                    break;
                }
                prev = au;
            }
        });
    }
    for (const reg of regions) {
        const t = limbCrossingMs(reg, win.t0, win.t1 - win.t0);
        if (t) marks.push({ t, kind: 'set', label: `AR ${reg.region} sets (W limb)` });
    }
    return marks.sort((a, b) => a.t - b.t);
}
