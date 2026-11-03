/**
 * missions-manifest.js — PURE model for the two launch rails on missions.html.
 *
 *   manifestRows(launches, nowMs)   → upcoming launches (LL2 via
 *                                     /api/launches/upcoming) as sorted,
 *                                     countdown-ready rows
 *   recentObjects(records, nowMs)   → objects catalogued in the last 30 days
 *                                     (CelesTrak group=last-30-days) tagged
 *                                     payload / rocket body / debris, newest
 *                                     first, with the orbit class from the
 *                                     normalized OMM shape
 *   fmtCountdown(ms)                → 'T−3d 04h' / 'T+2h 10m' strings
 *
 * No DOM, no fetch — tests/missions-manifest.mjs gates it. The page owns the
 * rendering and the 1 Hz tick; the live SGP4 position per recent object is
 * the shared tracker's (`propagate`), evaluated by the page, never here.
 */

const DAY = 86400000;

/** 'T−3d 04h', 'T−00:41:12' inside the last hour, 'T+1h 05m' after. */
export function fmtCountdown(ms) {
    const sign = ms < 0 ? '+' : '−';
    const a = Math.abs(ms);
    if (a < 3600000) {
        const s = Math.floor(a / 1000);
        const hh = String(Math.floor(s / 3600)).padStart(2, '0');
        const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        return `T${sign}${hh}:${mm}:${ss}`;
    }
    if (a < DAY) {
        const h = Math.floor(a / 3600000), m = Math.floor((a % 3600000) / 60000);
        return `T${sign}${h}h ${String(m).padStart(2, '0')}m`;
    }
    const d = Math.floor(a / DAY), h = Math.floor((a % DAY) / 3600000);
    return `T${sign}${d}d ${String(h).padStart(2, '0')}h`;
}

/** LL2 status abbreviations → a short class for the pip. */
export function launchStatusClass(abbrev) {
    const s = String(abbrev || '').toUpperCase();
    if (s === 'GO') return 'go';
    if (s === 'TBC') return 'tbc';
    if (s === 'TBD') return 'tbd';
    if (s === 'HOLD') return 'hold';
    if (s === 'SUCCESS') return 'success';
    if (s === 'FAILURE' || s === 'PARTIAL FAILURE') return 'failure';
    if (s === 'IN FLIGHT' || s === 'IN_FLIGHT') return 'inflight';
    return 'other';
}

/**
 * Upcoming launches → rows. Keeps launches whose NET is after `nowMs − graceMs`
 * (a launch in the last 6 h still shows as T+), sorted by NET. `limit` caps
 * the rail; the hero stat reads `.length` of the UNcapped set via `total`.
 */
export function manifestRows(launches, nowMs, { limit = 12, graceMs = 6 * 3600000, horizonDays = 30 } = {}) {
    const rows = [];
    for (const l of Array.isArray(launches) ? launches : []) {
        const net = Date.parse(l.net_iso || '');
        if (!Number.isFinite(net)) continue;
        if (net < nowMs - graceMs) continue;
        if (net > nowMs + horizonDays * DAY) continue;
        rows.push({
            id: l.id || l.slug || l.name,
            name: l.name || 'TBD',
            vehicle: l.vehicle || 'Unknown',
            provider: l.provider || 'Unknown',
            pad: [l.pad?.name, l.pad?.location].filter(Boolean).join(' · '),
            pad_lat: Number.isFinite(l.pad?.lat) ? l.pad.lat : null,
            pad_lon: Number.isFinite(l.pad?.lon) ? l.pad.lon : null,
            net_ms: net,
            status: l.status || 'TBD',
            status_class: launchStatusClass(l.status),
            orbit: l.orbit || '',
            mission_type: l.mission_type || '',
            mission: l.mission || '',
            probability_pct: Number.isFinite(l.probability_pct) ? l.probability_pct : null,
            info_url: l.info_url || '',
            countdown: fmtCountdown(net - nowMs),
        });
    }
    rows.sort((a, b) => a.net_ms - b.net_ms);
    return { rows: rows.slice(0, limit), total: rows.length };
}

/** Rocket body / debris / payload from the catalogue name (CelesTrak convention). */
export function classifyObject(name) {
    const n = String(name || '').toUpperCase();
    if (/\bR\/B\b/.test(n)) return 'rocket-body';
    if (/\bDEB\b/.test(n)) return 'debris';
    return 'payload';
}

/** Orbit class from the normalized OMM shape (km, minutes). */
export function orbitClass(rec) {
    const per = Number(rec.perigee_km), apo = Number(rec.apogee_km), e = Number(rec.eccentricity);
    if (!Number.isFinite(per) || !Number.isFinite(apo)) return '—';
    if (apo < 2000) return 'LEO';
    if (apo > 300000) return 'beyond GEO';
    if (per < 2000 && apo > 30000) return e > 0.5 ? 'GTO' : 'HEO';
    if (apo >= 35000 && apo <= 36500 && per >= 35000) return 'GEO';
    if (per > 2000 && apo < 35000) return 'MEO';
    return 'HEO';
}

/** International designator → launch date (YYYY-DDD part). */
export function launchDateFromObjectId(objectId) {
    const m = /^(\d{4})-(\d{3})/.exec(String(objectId || ''));
    if (!m) return null;
    return Date.UTC(Number(m[1]), 0, 1) + (Number(m[2]) - 1) * DAY;
}

/**
 * Recently catalogued objects → rows, newest launch first, grouped by launch
 * (one row per object; `launch_key` groups siblings). Objects older than
 * `maxAgeDays` are dropped even if the upstream group still lists them.
 */
export function recentObjects(records, nowMs, { limit = 40, maxAgeDays = 30 } = {}) {
    const rows = [];
    for (const r of Array.isArray(records) ? records : []) {
        if (!r || !Number.isFinite(Number(r.norad_id))) continue;
        const launchMs = launchDateFromObjectId(r.object_id);
        if (launchMs != null && nowMs - launchMs > maxAgeDays * DAY) continue;
        rows.push({
            norad_id: Number(r.norad_id),
            name: r.name || `NORAD ${r.norad_id}`,
            object_id: r.object_id || null,
            launch_key: r.object_id ? String(r.object_id).slice(0, 8) : `n${r.norad_id}`,
            launch_ms: launchMs,
            kind: classifyObject(r.name),
            orbit_class: orbitClass(r),
            perigee_km: Number.isFinite(Number(r.perigee_km)) ? Number(r.perigee_km) : null,
            apogee_km: Number.isFinite(Number(r.apogee_km)) ? Number(r.apogee_km) : null,
            inclination: Number.isFinite(Number(r.inclination)) ? Number(r.inclination) : null,
            period_min: Number.isFinite(Number(r.period_min)) ? Number(r.period_min) : null,
            epoch_ms: Number.isFinite(Number(r.epoch_ms)) ? Number(r.epoch_ms) : null,
            tle: r,
        });
    }
    // newest launch first; within a launch payloads before rocket bodies before
    // debris, then catalogue order (piece A, B, …)
    const KIND_RANK = { payload: 0, 'rocket-body': 1, debris: 2 };
    rows.sort((a, b) => (b.launch_ms ?? 0) - (a.launch_ms ?? 0)
        || KIND_RANK[a.kind] - KIND_RANK[b.kind]
        || a.norad_id - b.norad_id);
    const counts = { payload: 0, 'rocket-body': 0, debris: 0, launches: new Set(rows.map(r => r.launch_key)).size };
    for (const r of rows) counts[r.kind]++;
    return { rows: rows.slice(0, limit), total: rows.length, counts };
}

/** Geodetic-ish sub-satellite point from a TEME vector + GMST (deg). */
export function subPoint(temeKm, gmstDeg) {
    const r = Math.hypot(temeKm.x, temeKm.y, temeKm.z);
    const lat = Math.asin(temeKm.z / r) * 180 / Math.PI;
    let lon = (Math.atan2(temeKm.y, temeKm.x) * 180 / Math.PI - gmstDeg) % 360;
    if (lon > 180) lon -= 360; if (lon < -180) lon += 360;
    return { lat, lon, alt_km: r - 6371 };
}

/** GMST in degrees for a JD (IAU 1982, enough for a sub-point readout). */
export function gmstDeg(jd) {
    const T = (jd - 2451545.0) / 36525;
    let g = 280.46061837 + 360.98564736629 * (jd - 2451545.0) + 0.000387933 * T * T - T * T * T / 38710000;
    g %= 360; if (g < 0) g += 360;
    return g;
}
