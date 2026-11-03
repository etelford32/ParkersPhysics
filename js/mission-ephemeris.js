/**
 * mission-ephemeris.js — PURE half of the live mission positions.
 *
 * Builds the JPL Horizons query, parses its CSV vector table, interpolates a
 * sampled state to any instant, and plans which spacecraft to ask for. Shared
 * by /api/missions/ephemeris (server fan-out) and js/missions-3d.js (client
 * read) so the two cannot disagree about the sample shape. No fetch, no DOM.
 * Gate: tests/mission-ephemeris.mjs.
 *
 * Sample shape, everywhere: [jd_tdb, x, y, z, vx, vy, vz] — AU and AU/day,
 * ECLIPJ2000, Sun-centred (CENTER='500@10'). A window is WINDOW_HOURS wide at
 * STEP_HOURS, starting an hour before the request so a CDN-cached response
 * (1 h) always brackets "now". Beyond the window the state is extrapolated
 * linearly for up to EXTRAPOLATE_MAX_HOURS and then declared expired, so a
 * stale tab degrades to the analytic model instead of flying off the page.
 *
 * Interpolation is cubic Hermite on position with the sampled velocities:
 * Parker at perihelion moves 190 km/s and turns 34° in a 6 h step — linear
 * interpolation chords that by 0.002 AU, Hermite on 1 h samples is < 1e-6 AU.
 *
 * Horizons specifics that bit while writing this:
 *   • a name that matches several bodies returns a LIST, not a table — no
 *     $$SOE — so a candidate is "resolved" only when a table parses;
 *   • the first line of a CSV row is the TDB JD, the second the calendar
 *     string (contains commas? no — but it contains spaces and 'A.D.'), then
 *     X Y Z VX VY VZ LT RG RR; we read by index, never by regex on labels;
 *   • the `error` key is set for malformed queries and the result string
 *     still comes back 200.
 */

export const STEP_HOURS = 1;
export const WINDOW_HOURS = 26;
export const EXTRAPOLATE_MAX_HOURS = 24;
export const KM_PER_AU = 149597870.7;
export const LIGHT_MIN_PER_AU = 8.316746;   // 499.004784 s

/** Host bodies the route always resolves alongside spacecraft. */
export const HOST_COMMANDS = Object.freeze({
    earth: '399', moon: '301', mars: '499', jupiter: '599', saturn: '699',
    mercury: '199', venus: '299',
});

/** Floor a JD to the hour, minus one hour (the window start). */
export function windowStartJd(nowJd) {
    const hours = Math.floor(nowJd * 24);
    return (hours - 1) / 24;
}

/** Calendar string Horizons accepts: 'YYYY-MM-DD HH:MM'. */
export function horizonsTime(jd) {
    const ms = (jd - 2440587.5) * 86400000;
    const d = new Date(Math.round(ms / 60000) * 60000);
    return d.toISOString().slice(0, 16).replace('T', ' ');
}

/** URLSearchParams for one spacecraft/body vector table. */
export function horizonsQuery(command, startJd, { hours = WINDOW_HOURS, stepHours = STEP_HOURS } = {}) {
    return new URLSearchParams({
        format:     'json',
        COMMAND:    `'${command}'`,
        EPHEM_TYPE: 'VECTORS',
        CENTER:     "'500@10'",
        START_TIME: `'${horizonsTime(startJd)}'`,
        STOP_TIME:  `'${horizonsTime(startJd + hours / 24)}'`,
        STEP_SIZE:  `'${stepHours}h'`,
        VEC_TABLE:  '2',
        REF_FRAME:  'ECLIPJ2000',
        OUT_UNITS:  'AU-D',
        CSV_FORMAT: 'YES',
        VEC_LABELS: 'NO',
        OBJ_DATA:   'NO',
    });
}

/**
 * Parse a Horizons result string into samples. Throws with a short reason
 * when no table is present (name list, no match, error page).
 */
export function parseHorizonsVectors(text) {
    if (typeof text !== 'string') throw new Error('no-result');
    const soe = text.indexOf('$$SOE');
    const eoe = text.indexOf('$$EOE');
    if (soe < 0 || eoe < 0 || eoe < soe) throw new Error(classifyMiss(text));
    const samples = [];
    for (const line of text.slice(soe + 5, eoe).split('\n')) {
        const f = line.split(',').map(s => s.trim());
        if (f.length < 8) continue;
        const row = [f[0], f[2], f[3], f[4], f[5], f[6], f[7]].map(Number);
        if (row.every(Number.isFinite)) samples.push(row);
    }
    if (samples.length < 2) throw new Error('too-few-rows');
    return samples;
}

/** Why a Horizons answer carried no table — short, log-safe. */
export function classifyMiss(text) {
    const t = String(text || '');
    if (/Multiple major-bodies match/i.test(t) || /Number of matches/i.test(t)) return 'ambiguous-name';
    if (/No matches found/i.test(t) || /Cannot find/i.test(t)) return 'no-match';
    if (/No ephemeris for target/i.test(t)) return 'no-ephemeris-in-window';
    if (/Cannot interpret/i.test(t) || /Unknown/i.test(t)) return 'bad-query';
    return 'no-table';
}

/** Cubic Hermite between two samples a, b at fraction t ∈ [0,1]. */
function hermite(a, b, t, dtDays) {
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2,    h11 = t3 - t2;
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
        out[i] = h00 * a[1 + i] + h10 * dtDays * a[4 + i] + h01 * b[1 + i] + h11 * dtDays * b[4 + i];
    }
    return out;
}

/**
 * State at `jd` from a sample array. Returns
 *   { x_AU, y_AU, z_AU, vx, vy, vz, mode: 'interpolated'|'extrapolated' }
 * or null when `jd` is more than EXTRAPOLATE_MAX_HOURS outside the window.
 */
export function interpolateState(samples, jd) {
    if (!Array.isArray(samples) || samples.length === 0) return null;
    const first = samples[0], last = samples[samples.length - 1];
    const maxOut = EXTRAPOLATE_MAX_HOURS / 24;
    if (jd < first[0] - maxOut || jd > last[0] + maxOut) return null;
    if (jd <= first[0] || jd >= last[0] || samples.length === 1) {
        const s = jd <= first[0] ? first : last;
        const dt = jd - s[0];
        return {
            x_AU: s[1] + s[4] * dt, y_AU: s[2] + s[5] * dt, z_AU: s[3] + s[6] * dt,
            vx: s[4], vy: s[5], vz: s[6], mode: dt === 0 ? 'interpolated' : 'extrapolated',
        };
    }
    // binary search for the bracketing pair
    let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (samples[mid][0] <= jd) lo = mid; else hi = mid;
    }
    const a = samples[lo], b = samples[hi];
    const dtDays = b[0] - a[0];
    const t = (jd - a[0]) / dtDays;
    const p = hermite(a, b, t, dtDays);
    return {
        x_AU: p[0], y_AU: p[1], z_AU: p[2],
        vx: a[4] + (b[4] - a[4]) * t, vy: a[5] + (b[5] - a[5]) * t, vz: a[6] + (b[6] - a[6]) * t,
        mode: 'interpolated',
    };
}

/** Missions that carry Horizons candidates, in roster order. */
export function missionsWithHorizons(missions) {
    return missions.filter(m => Array.isArray(m.horizons) && m.horizons.length > 0);
}

/**
 * Split a mission list into request batches of ≤ `size` ids, each carrying
 * the hosts its members need. Batches keep roster order so a CDN key is
 * stable across reloads.
 */
export function planBatches(missions, size = 12) {
    const withH = missionsWithHorizons(missions);
    const batches = [];
    for (let i = 0; i < withH.length; i += size) {
        const slice = withH.slice(i, i + size);
        const hosts = new Set(['earth']);
        for (const m of slice) if (m.host && HOST_COMMANDS[m.host]) hosts.add(m.host);
        batches.push({ ids: slice.map(m => m.id), hosts: [...hosts] });
    }
    return batches;
}

export function distanceAU(a, b) {
    return Math.hypot(a.x_AU - b.x_AU, a.y_AU - b.y_AU, a.z_AU - b.z_AU);
}
export function lightTimeMinutes(au) { return au * LIGHT_MIN_PER_AU; }
export function speedKms(v) { return Math.hypot(v.vx, v.vy, v.vz) * KM_PER_AU / 86400; }

/** Count a live-state map by source for the HUD chip. */
export function provenanceSummary(items) {
    const n = { horizons: 0, sgp4: 0, model: 0, none: 0 };
    for (const it of items) n[it.source in n ? it.source : 'none']++;
    return n;
}
