/**
 * sun-flare-director.js — ONE flare event, from any feed, played one way (PURE)
 * ═══════════════════════════════════════════════════════════════════════════
 * SUN_VISUALS_WORLD_CLASS_PLAN.md, 2026-11 cinematic pass. No three, no DOM,
 * no fetch, no ambient clock. Gate: `node tests/sun-flare-director.mjs`.
 *
 * ── Why it exists ────────────────────────────────────────────────────────
 * sun.html could start a flare from FIVE places — the live SWPC handler's
 * `new_major_flare` branch, its recent-flares loop, a click on the flare
 * list, the analysis popup, and the test hook — and each did a different
 * subset of the same nine things (site, class, ribbon clock, cooling clock,
 * ribbons refresh, flash, prominence, plume, camera). A flare from the list
 * got no flash; a live one restarted the cooling track at zero even when
 * NOAA reported it twenty minutes late; none of them told the viewer which
 * passband the plasma was in. This module is the ONE description of an event
 * and of where it is in its life, so the page has ONE `playFlare()`.
 *
 * It decides nothing about GEOMETRY (js/flare-geometry.js) or about how
 * plasma COOLS (js/flare-dem.js) — it reads both.
 *
 * ── What it claims, and what it does not ─────────────────────────────────
 * • A flare WITHOUT a location is never placed. `located: false` events are
 *   listed, never drawn at disc centre (the orrery's rule: "a flare list
 *   without a location leaves the arcade dark").
 * • Stonyhurst is WEST-positive, through `parseStonyhurst` only.
 * • The phase boundaries are not typed. They are the times at which the hot
 *   (131 Å) and cool (171 Å) channels PEAK along this flare's own cooling
 *   track — `channelPeakTimes`, the function tests/flare-dem.mjs already
 *   measures the AIA order out of — so the phases move with the class
 *   instead of being one script. MEASURED (the gate pins it): an X5 holds its
 *   hot phase longer than an M1 (131 Å peaks at ~216 s against ~60 s) but
 *   reaches its 171 Å arcade SOONER (~1290 s against ~1510 s), because the
 *   RTV loop it starts in is denser and radiates faster. The first draft of
 *   this comment asserted the opposite from intuition.
 * • A REPLAY is labelled a replay. `ageS` is how old the event really is;
 *   `replay: true` means the page is re-running it from onset, and every
 *   caption carries that word.
 */
import { parseStonyhurst } from './flare-geometry.js';
import { goesFluxOf, goesClassOf, channelPeakTimes, flareDemState, coolingTrack } from './flare-dem.js';

/**
 * sim units of `u_flare_t` per REAL second of flare age — the conversion the
 * page has always used to place a late-reported flare on its ribbon clock
 * (`simAge = min(800, ageS × 0.35)`), now in one place.
 */
export const SIM_UNITS_PER_S = 0.35;
export const SIM_AGE_CAP = 800;
export function simAgeFor(ageS) { return Math.min(SIM_AGE_CAP, Math.max(0, ageS) * SIM_UNITS_PER_S); }

/** A flare this much older than its peak is history, not an event to cut to. */
export const LIVE_WINDOW_S = 3 * 3600;
/** Classes that may take the camera in Cinematic mode / raise the Watch prompt. */
export const DIRECTOR_CLASSES = Object.freeze(['M', 'X']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : null;
function ms(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).trim();
    // DONKI "2026-11-20T14:02Z" parses; SWPC "2026-11-20 14:02:00" needs the T and the Z.
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) s = s.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z';
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

/** 'X2.3' / 'm1' / 'C' → { cls: 'X2.3', letter: 'X', flux } or null. */
export function parseClass(v) {
    const m = /^\s*([ABCMX])\s*(\d+(?:\.\d+)?)?/i.exec(String(v ?? ''));
    if (!m) return null;
    const letter = m[1].toUpperCase();
    const cls = letter + (m[2] ?? '');
    const flux = goesFluxOf(m[2] ? cls : letter + '1');
    return { cls: m[2] ? cls : letter, letter, flux };
}

/**
 * ONE event shape from any of the page's flare sources:
 *   DONKI FLR   { flrID, beginTime, peakTime, endTime, classType, sourceLocation, activeRegionNum }
 *   SWPC feed   { time, cls, location, parsed:{letter}, active_region }
 *   page list   { time, cls, loc, reg }
 *   test hook   { cls, latDeg, lonDeg }
 * @returns {object|null} null when there is no class to speak of
 */
export function normalizeFlare(raw, { nowMs, source } = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const c = parseClass(raw.classType ?? raw.cls ?? raw.class ?? raw.flare_class ?? raw.parsed?.letter);
    if (!c) return null;
    const locStr = raw.sourceLocation ?? raw.location ?? raw.loc ?? raw.begin_location ?? null;
    let latDeg = num(raw.latDeg), lonDeg = num(raw.lonDeg);
    if (latDeg == null || lonDeg == null) {
        const p = typeof locStr === 'string' ? parseStonyhurst(locStr) : null;
        latDeg = p ? p.latDeg ?? p.lat ?? null : null;
        lonDeg = p ? p.lonDeg ?? p.lon ?? null : null;
    }
    const located = latDeg != null && lonDeg != null && Math.abs(latDeg) <= 90 && Math.abs(lonDeg) <= 180;
    const beginMs = ms(raw.beginTime ?? raw.begin_time ?? raw.begin);
    const peakMs  = ms(raw.peakTime ?? raw.max_time ?? raw.peak ?? raw.time) ?? beginMs;
    const endMs   = ms(raw.endTime ?? raw.end_time ?? raw.end);
    const region  = raw.activeRegionNum ?? raw.active_region ?? raw.active_region_num ?? raw.reg ?? null;
    const regionStr = (region == null || region === '' || region === '—') ? null : String(region);
    const onsetMs = beginMs ?? peakMs;
    const ageS = (num(nowMs) != null && onsetMs != null) ? Math.max(0, (nowMs - onsetMs) / 1000) : null;
    return {
        id: raw.flrID ?? `${c.cls}|${peakMs ?? 'na'}|${located ? `${latDeg.toFixed(0)},${lonDeg.toFixed(0)}` : 'unlocated'}`,
        cls: c.cls, letter: c.letter, flux: c.flux,
        located, latDeg: located ? latDeg : null, lonDeg: located ? lonDeg : null,
        // Behind the limb as seen from Earth: its arcade can still stand above the limb.
        nearSide: located ? Math.abs(lonDeg) <= 90 : null,
        locationText: located ? (typeof locStr === 'string' && locStr.trim() ? locStr.trim() : null) : null,
        beginMs, peakMs, endMs, onsetMs, ageS,
        // Did the source link a CME to this flare? true / false when it says (DONKI's linkedEvents, or the
        // relay's linked_cme), null when the source carries no such field (SWPC's list, a test flare).
        linkedCme: typeof raw.linked_cme === 'boolean' ? raw.linked_cme
            : Array.isArray(raw.linkedEvents) ? raw.linkedEvents.some((e) => /CME/.test(String(e?.activityID ?? e ?? '')))
            : typeof raw.linkedCme === 'boolean' ? raw.linkedCme : null,
        // An explicit statement (a test, a replay of a known event) beats everything.
        eruptiveStated: typeof raw.eruptive === 'boolean' ? raw.eruptive : null,
        region: regionStr,
        source: source ?? raw.source ?? (raw.flrID ? 'NASA DONKI' : 'NOAA SWPC'),
    };
}

// ── Is this flare ERUPTIVE? ─────────────────────────────────────────────────
/**
 * Not every flare launches a CME — confined flares exist at every class. The
 * page draws an erupting flux rope only when it has a reason to, and SAYS which:
 *
 *   'stated'           the caller said so (a test flare, a replay of a known event);
 *   'cme-reported'     the flare's source linked a CME to it (DONKI linkedEvents);
 *   'no-cme-reported'  the source links CMEs, has had CME_REPORT_LAG_S to do so, and
 *                      has not — the flare is drawn CONFINED, whatever its class;
 *   'class-prior'      nothing is known: the CME association rate of flares this
 *                      size decides, and the rope is drawn only when a CME is more
 *                      likely than not by a margin (ERUPTIVE_PRIOR_MIN).
 *
 * CME_ASSOCIATION is the association rate against peak soft-X-ray flux as
 * recalled from Yashiro et al. (2005, JGR 110, A12S05; 2006, ApJ 650, L143):
 * about 20 % for C-class, 50 % for M, 90 % for X, all of them above ~X3.
 * UNVERIFIED — written from memory in a sandbox without the papers, like the
 * ranges in js/flare-realism.js. It is a prior and is captioned as one.
 */
export const CME_ASSOCIATION = Object.freeze([[1e-6, 0.20], [1e-5, 0.50], [1e-4, 0.90], [3e-4, 1.00]]);
export const ERUPTIVE_PRIOR_MIN = 0.60;
export const CME_REPORT_LAG_S = 3 * 3600;

/** P(a CME accompanies a flare of this peak flux): piecewise-linear in log10(flux), clamped at both ends. */
export function cmeAssociation(flux) {
    if (!(flux > 0)) return 0;
    const T = CME_ASSOCIATION, x = Math.log10(flux);
    if (x <= Math.log10(T[0][0])) return T[0][1];
    for (let i = 1; i < T.length; i++) {
        const x0 = Math.log10(T[i - 1][0]), x1 = Math.log10(T[i][0]);
        if (x <= x1) return T[i - 1][1] + (T[i][1] - T[i - 1][1]) * (x - x0) / (x1 - x0);
    }
    return T[T.length - 1][1];
}

/** @returns {{ eruptive: boolean, basis: string, p: number }} — see the block comment above. */
export function eruptionCall(ev) {
    const p = ev ? cmeAssociation(ev.flux) : 0;
    if (!ev) return { eruptive: false, basis: 'class-prior', p };
    if (ev.eruptiveStated != null) return { eruptive: ev.eruptiveStated, basis: 'stated', p };
    if (ev.linkedCme === true) return { eruptive: true, basis: 'cme-reported', p };
    if (ev.linkedCme === false && ev.ageS != null && ev.ageS >= CME_REPORT_LAG_S) return { eruptive: false, basis: 'no-cme-reported', p };
    return { eruptive: p >= ERUPTIVE_PRIOR_MIN, basis: 'class-prior', p };
}

/** The caption's clause for an eruption call ('' when there is nothing to say). */
export function eruptionClause(call) {
    if (!call) return '';
    if (call.basis === 'cme-reported') return 'CME reported · rope modelled';
    if (call.basis === 'no-cme-reported') return 'no CME reported · confined';
    if (call.basis === 'stated') return call.eruptive ? 'eruptive · rope modelled' : 'confined';
    return call.eruptive ? `eruption modelled · no CME report yet (CME in ~${Math.round(call.p * 100)} % of flares this size)` : '';
}

/** Bigger and fresher first. A decade of flux outweighs ~2.3 h of age. */
export function flareScore(ev, nowMs) {
    if (!ev || !(ev.flux > 0)) return -Infinity;
    const ageH = ev.onsetMs != null && num(nowMs) != null ? Math.max(0, (nowMs - ev.onsetMs) / 3.6e6) : 24;
    return Math.log10(ev.flux) - ageH / 2.3;
}

export function rankFlares(list, nowMs) {
    return [...(list || [])].filter(Boolean).sort((a, b) => flareScore(b, nowMs) - flareScore(a, nowMs));
}

/** De-duplicate by id, keeping the record that knows more (a location beats none). */
export function mergeFlares(...lists) {
    const by = new Map();
    for (const l of lists) for (const ev of (l || [])) {
        if (!ev) continue;
        // The same event from two feeds: same class letter, peaks within 10 min.
        let key = ev.id;
        for (const [k, o] of by) {
            if (o.letter === ev.letter && o.peakMs != null && ev.peakMs != null && Math.abs(o.peakMs - ev.peakMs) <= 600e3) { key = k; break; }
        }
        const prev = by.get(key);
        if (!prev || (!prev.located && ev.located) || (prev.located === ev.located && ev.source === 'NASA DONKI' && prev.source !== 'NASA DONKI')) {
            by.set(key, prev ? { ...ev, id: prev.id } : ev);
        }
    }
    return [...by.values()];
}

/**
 * May `incoming` take over from the flare being played? Only a located M/X
 * event inside the live window, and only if it outranks what is on screen —
 * a C-class must never cut away from an X-class arcade.
 */
export function shouldCutTo(incoming, current, nowMs) {
    if (!incoming || !incoming.located) return false;
    if (!DIRECTOR_CLASSES.includes(incoming.letter)) return false;
    if (incoming.ageS != null && incoming.ageS > LIVE_WINDOW_S) return false;
    if (!current) return true;
    if (current.id === incoming.id) return false;
    return flareScore(incoming, nowMs) > flareScore(current, nowMs);
}

/**
 * When each AIA channel peaks for this flare — the cooling track's own
 * answer. `channels` / `response` are js/corona-volumetric.js EUV_CHANNELS /
 * channelResponseAt, injected so this module stays a leaf.
 * @returns {{hotS:number, coolS:number, peaks:Record<string,number>, order:string[]}}
 */
export function channelClock(flux, channels, response) {
    // channelPeakTimes reports { tPeak, value } per channel; a channel the
    // track never reaches (304 Å — js/flare-dem.js reports it UNREACHABLE
    // rather than extrapolating) has no peak and is left out, not guessed.
    const raw = channelPeakTimes(flux, channels, response);
    const peaks = {};
    for (const [k, v] of Object.entries(raw)) if (v && v.tPeak >= 0 && v.value > 1e-3) peaks[k] = v.tPeak;
    const order = Object.keys(peaks).sort((a, b) => peaks[a] - peaks[b]);
    const hotS = peaks['131'] ?? peaks['94'] ?? 60;
    const coolS = peaks['171'] ?? (order.length ? peaks[order[order.length - 1]] : 1400);
    return { hotS, coolS, peaks, order };
}

/**
 * Where a flare is in its life at `elapsedS` seconds after onset.
 *   impulsive — before the hot channel peaks: kernel, ribbons, the HXR burst
 *   hot       — the hot loops (131/94 Å) are at or just past their peak
 *   cooling   — the loop is passing through 211 → 193
 *   arcade    — the 171 Å post-flare arcade
 *   faded     — past twice the cool channel's peak
 * `channel` is the passband with the largest response × emission measure NOW.
 */
export function phaseAt(elapsedS, clock, { flux, channels, response, track } = {}) {
    const t = Math.max(0, elapsedS);
    const { hotS, coolS } = clock;
    let id;
    if (t < hotS * 0.85) id = 'impulsive';
    else if (t < hotS + 0.25 * (coolS - hotS)) id = 'hot';
    else if (t < coolS * 0.85) id = 'cooling';
    else if (t < coolS * 2.0) id = 'arcade';
    else id = 'faded';
    let channel = null, best = 0;
    if (flux && channels && response) {
        const st = flareDemState(flux, t, track ? { track } : {});
        for (const [key, ch] of Object.entries(channels)) {
            if (!(ch.sigma > 1e-3)) continue;
            const v = response(st.logT, ch) * st.amp;
            if (v > best) { best = v; channel = key; }
        }
    }
    const span = id === 'impulsive' ? [0, hotS * 0.85]
        : id === 'hot' ? [hotS * 0.85, hotS + 0.25 * (coolS - hotS)]
        : id === 'cooling' ? [hotS + 0.25 * (coolS - hotS), coolS * 0.85]
        : id === 'arcade' ? [coolS * 0.85, coolS * 2.0] : [coolS * 2.0, coolS * 2.0 + 1];
    return { id, channel, response: best, progress: Math.min(1, (t - span[0]) / Math.max(span[1] - span[0], 1e-6)) };
}

export const PHASE_LABEL = Object.freeze({
    impulsive: 'Impulsive phase',
    hot: 'Hot loops',
    cooling: 'Cooling',
    arcade: 'Post-flare arcade',
    faded: 'Faded',
});

/** mm:ss or h:mm:ss. */
export function fmtElapsed(s) {
    const t = Math.max(0, Math.round(s));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), ss = t % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${m}:${String(ss).padStart(2, '0')}`;
}

/**
 * The caption the page prints while a flare plays. Every clause is a fact the
 * modules above computed; nothing here is decoration.
 */
export function caption(ev, phase, elapsedS, { replay = false, simSpeed = 1, eruption = null } = {}) {
    if (!ev) return '';
    const where = ev.located
        ? (ev.locationText ?? `${ev.latDeg >= 0 ? 'N' : 'S'}${Math.abs(Math.round(ev.latDeg))}${ev.lonDeg >= 0 ? 'W' : 'E'}${Math.abs(Math.round(ev.lonDeg))}`)
        : 'location not reported';
    const parts = [`${ev.cls} flare`, where];
    if (ev.region) parts.push(`AR ${ev.region}`);
    parts.push(ev.source);
    const head = (replay ? 'REPLAY · ' : '') + parts.join(' · ');
    const tail = [`T+${fmtElapsed(elapsedS)}`, PHASE_LABEL[phase.id] ?? phase.id];
    if (phase.channel && phase.id !== 'faded') tail.push(`brightest in ${phase.channel} Å (model)`);
    const er = eruptionClause(eruption);
    if (er) tail.push(er);
    if (simSpeed && Math.abs(simSpeed - 1) > 1e-6) tail.push(`×${simSpeed} time`);
    return `${head} — ${tail.join(' · ')}`;
}

/** The cooling track for an event, built once and reused per frame. */
export function trackFor(ev) { return coolingTrack(ev.flux ?? goesFluxOf('C1')); }

export { goesClassOf };
