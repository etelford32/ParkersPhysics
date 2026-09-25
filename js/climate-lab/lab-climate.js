/**
 * climate-lab/lab-climate.js — "is today normal here?"
 * ═══════════════════════════════════════════════════════════════════════════
 * The Climate Lab's climate-context card. It answers three questions about
 * the HOME STATION from its own history, and computes none of the history
 * itself — every climatological number comes from code the homepage's
 * Temperature tab already ships and node-tests:
 *
 *   · the archive       home-conditions.js `fetchClimate` — ~3 years of ERA5
 *                       daily max/min/mean + shortwave radiation (°F), one
 *                       direct archive-api call the homepage already makes
 *   · the normals       temp-outlook.js `climatologyByDoy` / `climAt` —
 *                       per-day-of-year means, circular ±7-day window
 *   · persistence       temp-outlook.js `anomalyPersistence` — the AR(1)
 *                       e-folding time τ of a daily-mean anomaly HERE
 *   · seasonal lag      home-conditions.js `buildTempModel(...).arc.lagDays`
 *                       — days from the insolation peak to the temperature
 *                       peak (the ocean/land thermal-inertia signature)
 *
 * WHAT IT IS NOT: a 30-year WMO climate normal. Three years × ±7 days is ~45
 * samples per calendar date — enough for a percentile, not for a trend, and
 * the card prints the archive years and the sample count every time so
 * nobody reads "94th percentile" as a century-scale record.
 *
 * PURE except `loadStationClimate` (browser: fetch + lazy import).
 * Temperatures leave this module in °C, like the rest of the lab.
 */

import { climatologyByDoy, climAt, dayOfYearLocal, anomalyPersistence } from '../temp-outlook.js';
import { climatePosition } from './lab-physics.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const f2c = (f) => (f - 32) * 5 / 9;
const HALF_WINDOW_DAYS = 7;

/**
 * Archive samples of `field` within ±halfWindow calendar days of the day
 * containing `t` (circular across New Year). Uses temp-outlook's own
 * day-of-year convention so it selects exactly the days climatologyByDoy
 * averaged — the percentile and the normal describe the same population.
 */
export function seasonalSamples(pts, t, { halfWindow = HALF_WINDOW_DAYS, field = 'hiF' } = {}) {
    if (!Array.isArray(pts) || !isNum(t)) return [];
    const target = dayOfYearLocal(t);
    const out = [];
    for (const p of pts) {
        if (!p || !isNum(p.t) || !isNum(p[field])) continue;
        const d = dayOfYearLocal(p.t);
        const dist = Math.min(Math.abs(d - target), 366 - Math.abs(d - target));
        if (dist <= halfWindow) out.push(p[field]);
    }
    return out;
}

/**
 * The card's model.
 * @param {object}   a
 * @param {Array}    a.pts          normalizeClimate().pts ({t, tempF, hiF, loF, radMJ})
 * @param {string}   a.stationDate  'YYYY-MM-DD' — the STATION's today
 * @param {number}   a.todayHighC   forecast high for that day (°C)
 * @param {number}   a.todayLowC    forecast low (°C)
 * @param {number?}  a.lagDays      from buildTempModel().arc (optional)
 * @returns {object|null}
 */
export function climateContext({ pts, stationDate, todayHighC, todayLowC, lagDays = null } = {}) {
    if (!Array.isArray(pts) || pts.length < 300 || typeof stationDate !== 'string') return null;
    // Same noon-anchored convention normalizeClimate uses for archive days.
    const t = Date.parse(`${stationDate}T12:00`);
    if (!isNum(t)) return null;
    const clim = climatologyByDoy(pts, { halfWindow: HALF_WINDOW_DAYS });
    const normal = climAt(clim, t);
    const highsC = seasonalSamples(pts, t, { field: 'hiF' }).map(f2c);
    const lowsC = seasonalSamples(pts, t, { field: 'loF' }).map(f2c);
    const persistence = anomalyPersistence(pts, clim);
    return {
        years: clim?.years ?? null,
        nDays: clim?.nDays ?? pts.length,
        normalHighC: isNum(normal?.hi) ? f2c(normal.hi) : null,
        normalLowC: isNum(normal?.lo) ? f2c(normal.lo) : null,
        high: climatePosition(todayHighC, highsC),
        low: climatePosition(todayLowC, lowsC),
        highsC, lowsC,
        todayHighC: isNum(todayHighC) ? todayHighC : null,
        todayLowC: isNum(todayLowC) ? todayLowC : null,
        tauDays: isNum(persistence?.tau) ? persistence.tau : null,
        // σ of a temperature ANOMALY is a difference: scale only, no offset.
        sigmaC: isNum(persistence?.sigmaF) ? persistence.sigmaF * 5 / 9 : null,
        lagDays: isNum(lagDays) ? lagDays : null,
    };
}

/** Plain-language line for a climatePosition class. */
export function positionWords(pos) {
    if (!pos) return null;
    return {
        'much-below': 'Much colder than usual',
        below: 'Colder than usual',
        near: 'Near normal',
        above: 'Warmer than usual',
        'much-above': 'Much warmer than usual',
    }[pos.cls] ?? null;
}

// ── Browser loader ──────────────────────────────────────────────────────────

const _cache = new Map();   // "lat,lon" (2 dp) → Promise<{pts, lagDays}|null>

/**
 * Fetch the station archive once per ~1 km per page life. Resolves to
 * `{ pts, lagDays }` or null (archive unreachable / too short) — never throws.
 */
export function loadStationClimate(lat, lon) {
    if (!isNum(lat) || !isNum(lon)) return Promise.resolve(null);
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (_cache.has(key)) return _cache.get(key);
    const p = (async () => {
        try {
            const hc = await import('../home-conditions.js');
            const climate = await hc.fetchClimate({ lat, lon });
            if (!climate?.pts) return null;
            let lagDays = null;
            try {
                // buildTempModel only needs `current` to exist to compute the
                // year arc; the arc is the one thing read from it here.
                const m = hc.buildTempModel({ current: {}, hourly: [], daily: [] }, climate, Date.now());
                lagDays = m?.arc?.lagDays ?? null;
            } catch { /* arc is optional */ }
            return { pts: climate.pts, lagDays };
        } catch {
            _cache.delete(key);   // a failed fetch may be retried next mount
            return null;
        }
    })();
    _cache.set(key, p);
    return p;
}

/** 1 → "1st", 12 → "12th", 23 → "23rd". */
export function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = Math.abs(Math.round(n)) % 100;
    return `${Math.round(n)}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
