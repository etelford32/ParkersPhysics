/**
 * Vercel Edge Function: /api/missions/ephemeris
 *
 * Live heliocentric state vectors for the missions roster, from JPL Horizons.
 * One call fans out to Horizons (one request per body — Horizons has no
 * multi-target vector query), parses each table with the SAME kernel the
 * browser interpolates with (js/mission-ephemeris.js), and returns a 26 h
 * window of hourly samples per spacecraft plus the host planets the
 * client needs for local (geocentric / areocentric) offsets.
 *
 * Query params:
 *   ?ids=a,b,c     mission ids from js/space-missions.js (≤ MAX_IDS). Default
 *                  is the heliophysics core set so a probe is cheap.
 *   ?hosts=earth,mars   extra host bodies (earth is always included)
 *
 * Response (200 ALWAYS — a dead upstream is `freshness:'stale'`, never a 5xx,
 * so status.html reads the feed as down instead of the route as broken):
 *   { source:'jpl-horizons', fetched_at, window:{start_jd, hours, step_h},
 *     freshness:'live'|'stale', resolved, requested,
 *     hosts:{ earth:{command, samples}, … },
 *     spacecraft:[{ id, ok, command_used, tried:[{command, reason}], samples }],
 *     note? }
 *
 * CANDIDATE COMMANDS ARE UNVERIFIED. ssd.jpl.nasa.gov is egress-blocked at
 * build time, so each mission's `horizons` list is tried IN ORDER and the
 * first command that yields a vector table wins; `command_used` names it and
 * `tried` records why the others missed. One production request —
 *   curl 'https://parkersphysics.com/api/missions/ephemeris?ids=hera,escapade,roman' | jq '.spacecraft[]|{id,ok,command_used,tried}'
 * — settles the ids; then trim the lists in js/space-missions.js.
 *
 * Budget: Horizons SPK lookups answer in 1–4 s; calls run HORIZONS_CONCURRENCY
 * at a time (Horizons 503s under a burst — measured) under a per-call timeout
 * (HORIZONS_TIMEOUT_MS), one retry per 503. The CDN caches a success for an
 * hour (the window is 26 h, so a cached answer always brackets now).
 *
 * MEASURED ON THE FIRST DEPLOY (2026-11-03): every call answered HTTP 400
 * "one or more query parameter was not recognized" — `REF_FRAME` is not a
 * Horizons API parameter; the frame is `REF_PLANE=ECLIPTIC` (see the kernel
 * header). A 400's `message` is now carried in the per-candidate `reason`
 * so the next schema miss is readable from the self-report.
 */

import { jsonOk, fetchWithTimeout } from '../_lib/responses.js';
import { ALL_MISSIONS } from '../../js/space-missions.js';
import {
    HOST_COMMANDS, WINDOW_HOURS, STEP_HOURS,
    windowStartJd, horizonsQuery, horizonsQueryString, parseHorizonsVectors, classifyMiss,
} from '../../js/mission-ephemeris.js';

export const config = { runtime: 'edge' };

export const HORIZONS_BASE = 'https://ssd.jpl.nasa.gov/api/horizons.api';
export const HORIZONS_TIMEOUT_MS = 9000;
export const MAX_IDS = 16;
/** Horizons answers 503 when busy; ~20 parallel calls from one edge
 *  invocation provoked it on the first deployed build. Four at a time, one
 *  retry per 503 after a short pause. */
export const HORIZONS_CONCURRENCY = 4;
export const RETRY_503_DELAY_MS = 1200;
const CACHE_TTL = 3600;
const CACHE_SWR = 900;
const STALE_TTL = 120;

export const DEFAULT_IDS = Object.freeze([
    'parker-solar-probe', 'solar-orbiter', 'stereo-a', 'soho', 'ace', 'wind', 'dscovr', 'imap',
]);

function jdNow() { return Date.now() / 86400000 + 2440587.5; }

// ── A small concurrency gate shared by every call in one invocation ────────
let _active = 0;
const _waiters = [];
async function withSlot(fn) {
    if (_active >= HORIZONS_CONCURRENCY) await new Promise(r => _waiters.push(r));
    _active++;
    try { return await fn(); }
    finally { _active--; const next = _waiters.shift(); if (next) next(); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Short, log-safe excerpt of an upstream error body (Horizons' JSON `message`). */
function errorExcerpt(text) {
    let msg = '';
    try { msg = JSON.parse(text)?.message || ''; } catch (_) { msg = String(text || ''); }
    msg = msg.replace(/\s+/g, ' ').trim().slice(0, 80);
    return msg ? ` (${msg})` : '';
}

/** One Horizons table → samples, or throw a short reason. Exported for tests. */
export async function fetchTable(command, startJd) {
    const url = `${HORIZONS_BASE}?${horizonsQueryString(horizonsQuery(command, startJd))}`;
    const once = () => fetchWithTimeout(url, {
        headers: { Accept: 'application/json' },
        timeoutMs: HORIZONS_TIMEOUT_MS,
    }).catch(e => { throw new Error(`fetch:${(e && e.name === 'TimeoutError') ? 'timeout' : 'network'}`); });
    let res = await withSlot(once);
    if (res.status === 503) {
        await sleep(RETRY_503_DELAY_MS);
        res = await withSlot(once);
    }
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`http-${res.status}${errorExcerpt(body)}`);
    }
    let json;
    try { json = await res.json(); }
    catch (_) { throw new Error('not-json'); }
    if (json && json.error) throw new Error(`api-error:${classifyMiss(String(json.error))}`);
    return parseHorizonsVectors(json && json.result);
}

/** Walk a mission's candidate commands in order; first table wins. */
export async function resolveSpacecraft(mission, startJd) {
    const tried = [];
    for (const command of mission.horizons) {
        try {
            const samples = await fetchTable(command, startJd);
            return { id: mission.id, ok: true, command_used: command, tried, samples };
        } catch (e) {
            tried.push({ command, reason: e.message || 'unknown' });
        }
    }
    return { id: mission.id, ok: false, command_used: null, tried, samples: null };
}

function parseList(raw, max) {
    return String(raw || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, max);
}

export default async function handler(request, { now = jdNow() } = {}) {
    const url = new URL(request.url);
    const wanted = parseList(url.searchParams.get('ids'), MAX_IDS);
    const ids = wanted.length ? wanted : [...DEFAULT_IDS];
    const missions = ids.map(id => ALL_MISSIONS.find(m => m.id === id)).filter(m => m && m.horizons?.length);
    const unknown = ids.filter(id => !missions.some(m => m.id === id));

    const hosts = new Set(['earth']);
    for (const m of missions) if (m.host && HOST_COMMANDS[m.host]) hosts.add(m.host);
    for (const h of parseList(url.searchParams.get('hosts'), 8)) if (HOST_COMMANDS[h]) hosts.add(h);

    const startJd = windowStartJd(now);

    const [scSettled, hostSettled] = await Promise.all([
        Promise.allSettled(missions.map(m => resolveSpacecraft(m, startJd))),
        Promise.allSettled([...hosts].map(async h => ({ host: h, command: HOST_COMMANDS[h], samples: await fetchTable(HOST_COMMANDS[h], startJd) }))),
    ]);

    const spacecraft = scSettled.map((r, i) => r.status === 'fulfilled'
        ? r.value
        : { id: missions[i].id, ok: false, command_used: null, tried: [{ command: '*', reason: r.reason?.message || 'threw' }], samples: null });
    const hostOut = {};
    const hostMisses = [];
    hostSettled.forEach((r, i) => {
        const h = [...hosts][i];
        if (r.status === 'fulfilled') hostOut[h] = { command: r.value.command, samples: r.value.samples };
        else hostMisses.push({ host: h, reason: r.reason?.message || 'threw' });
    });

    const resolved = spacecraft.filter(s => s.ok).length;
    const live = resolved > 0 && !!hostOut.earth;
    const body = {
        source: 'jpl-horizons',
        fetched_at: new Date().toISOString(),
        window: { start_jd: startJd, hours: WINDOW_HOURS, step_h: STEP_HOURS },
        freshness: live ? 'live' : 'stale',
        requested: missions.length,
        resolved,
        hosts: hostOut,
        spacecraft,
    };
    if (unknown.length) body.unknown_ids = unknown;
    if (hostMisses.length) body.host_misses = hostMisses;
    if (!live) body.note = resolved === 0
        ? 'JPL Horizons returned no vector table for any requested spacecraft; the client draws the analytic model.'
        : 'Earth host vector missing — local offsets cannot be anchored; the client draws the analytic model.';
    return jsonOk(body, { maxAge: live ? CACHE_TTL : STALE_TTL, swr: live ? CACHE_SWR : 60 });
}
