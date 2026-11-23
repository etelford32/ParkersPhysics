/**
 * climalytix/places-glance.js — "your places right now": one row per saved
 * place, read from OUR GFS archive. PURE: a route body in, a row out.
 * ═══════════════════════════════════════════════════════════════════════════
 * The board answers one question — which of my places is warm, windy or wet
 * right now — without opening each one. Rules, each gated
 * (tests/climalytix-glance.mjs):
 *
 *   · ONE SOURCE, NO STAND-IN. A row is `/api/climalytix/nwp` for that place
 *     (two byte-range reads), the same archive the page's first series comes
 *     from. Archive down or unpublished ⇒ the row SAYS why; the bootstrap
 *     feed is never substituted (the page's own rule for `gfs`).
 *   · "NOW" IS INTERPOLATED BY INSTANT between the two 3-hourly frames that
 *     bracket it (the map's rule, `timeBlend`); a gap in either frame is a
 *     gap, and outside the run nothing is held or extrapolated.
 *   · Wind is interpolated as u and v COMPONENTS, then turned into a speed —
 *     never an interpolated speed (two opposed winds do not average to calm
 *     air moving at their mean speed).
 *   · The 24-hour range is over the frames in [now, now + 24 h] that HAVE a
 *     value; fewer than half of them ⇒ no range, never a range of what
 *     happened to be there.
 *   · Values stay SI; the page converts once, at display.
 */

import { cleanPlace, savedPlaces, placeName } from './places.js';

export const GLANCE_MAX = 8;
export const GLANCE_TTL_MS = 15 * 60 * 1000;
const H = 3_600_000;

const REASONS = Object.freeze({
    r2_not_configured: 'our archive is not published yet',
    no_run_published: 'no GFS run has been ingested yet',
    run_ended: 'the run has ended — waiting for the next one',
    run_not_started: 'the run has not reached this hour',
    no_values: 'this run has no value here',
    feed_down: 'our archive is unreachable right now',
});
export const glanceReason = (r) => REASONS[r] || String(r || 'unavailable').replace(/:.*$/, '').replace(/_/g, ' ');

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Bracketing frames for an instant, or null outside the run. */
export function bracket(times, ms) {
    if (!Array.isArray(times) || times.length < 1 || !Number.isFinite(ms)) return null;
    if (ms < times[0] || ms > times[times.length - 1]) return null;
    let i = 0;
    while (i < times.length - 2 && times[i + 1] <= ms) i++;
    if (times.length === 1) return { i0: 0, i1: 0, w: 0 };
    const span = times[i + 1] - times[i];
    return { i0: i, i1: i + 1, w: span > 0 ? (ms - times[i]) / span : 0 };
}

const at = (arr, b) => {
    const a = num(arr?.[b.i0]), c = num(arr?.[b.i1]);
    if (b.w === 0) return a;
    if (b.w === 1) return c;
    return a == null || c == null ? null : a + (c - a) * b.w;
};

/**
 * @param {object|null} body   /api/climalytix/nwp body (or null when the fetch failed)
 * @param {number} nowMs
 * @returns {{state:'ok'|'none', reason?:string, tempC, windMs, windDirDeg, hiC, loC, precipMm, run, ageS}}
 */
export function glanceFromNwp(body, nowMs) {
    const none = (reason) => ({ state: 'none', reason, tempC: null, windMs: null, windDirDeg: null, hiC: null, loC: null, precipMm: null, run: body?.run ?? null, ageS: num(body?.age_seconds) });
    if (!body || typeof body !== 'object') return none('feed_down');
    const times = body.times, s = body.series || {};
    if (!Array.isArray(times) || !times.length) return none((body.reasons || [])[0] || 'no_run_published');
    const b = bracket(times, nowMs);
    if (!b) return none(nowMs > times[times.length - 1] ? 'run_ended' : 'run_not_started');
    const tempC = at(s.tempC, b);
    const u = at(s.uMs, b), v = at(s.vMs, b);
    const windMs = u == null || v == null ? null : Math.hypot(u, v);
    const windDirDeg = windMs == null || windMs === 0 ? null : (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;   // FROM
    // Next 24 h: the frames from the one in force now to now + 24 h.
    let hi = null, lo = null, n = 0, have = 0, rain = null, rainN = 0;
    for (let i = b.i0; i < times.length && times[i] <= nowMs + 24 * H; i++) {
        n++;
        const t = num(s.tempC?.[i]);
        if (t != null) { have++; hi = hi == null ? t : Math.max(hi, t); lo = lo == null ? t : Math.min(lo, t); }
        const r = num(s.precipMm?.[i]);
        if (r != null && times[i] >= nowMs - 3 * H) { rain = (rain || 0) + r; rainN++; }
    }
    const enough = n > 0 && have * 2 >= n;
    if (tempC == null && windMs == null && !enough) return none('no_values');
    return {
        state: 'ok', tempC, windMs, windDirDeg,
        hiC: enough ? hi : null, loC: enough ? lo : null,
        precipMm: rainN * 2 >= n ? rain : null,
        run: body.run ?? null, ageS: num(body.age_seconds),
    };
}

/** Which places the board shows: Home first, then saved places in the order saved; one row per place. */
export function glancePlan(doc, home = null, max = GLANCE_MAX) {
    const out = [], seen = new Set();
    const add = (p, kind) => {
        const c = cleanPlace(p);
        if (!c || seen.has(c.id) || out.length >= max) return;
        seen.add(c.id);
        out.push({ id: c.id, lat: c.lat, lon: c.lon, city: c.city, name: kind === 'home' ? c.city : placeName(c), kind });
    };
    if (home) add(home, 'home');
    for (const p of savedPlaces(doc)) add(p, 'saved');
    return out;
}

/** Sixteen-point compass for a FROM direction. */
export function compass(deg) {
    if (deg == null || !Number.isFinite(deg)) return '';
    return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}
