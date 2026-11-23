/**
 * home-launchpad-model.js — what the homepage's first screen shows, and why
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE: no DOM, no fetch, no ambient time (anything that needs "now" takes it
 * as an argument). The renderer is js/home-launchpad.js; the markup it
 * enhances is index.html #hero. Node gate: `node tests/home-launchpad.mjs`.
 *
 * THE FIRST SCREEN IS A LAUNCHPAD (2026-11-22, owner decision). It replaced
 * the live magnetosphere + personal sky console (now live-sky.html) with
 * three things whose only job is to send a visitor INTO a simulation:
 *
 *   1. RECENT — a carousel of the simulations most recently built or improved
 *      that have a cinematic capture (`carouselEligible`: a real photograph,
 *      and not one of the instrument pages in CAROUSEL_EXCLUDE).
 *      It is DERIVED FROM THE BUILD LOG (js/dev-log.js DEV_LOG): one slide per
 *      simulation, carrying that simulation's NEWEST log entry. Nothing is
 *      curated here. Shipping a sprint already ends with a log entry
 *      (CLAUDE.md, the Recent Development row) — that entry is what moves a
 *      simulation to the front of the homepage. There is no second list to
 *      keep in step, on purpose: the hand-written devlog this site had before
 *      silently stopped for six months.
 *
 *   2. FIXTURES — six real-time simulations that are ALWAYS there, in the
 *      owner's order (FIXTURE_IDS). Their tiles are static markup in
 *      index.html (in the first paint, working with no JavaScript); the node
 *      gate pins that markup to this list and to the catalogue. Each tile
 *      also shows its simulation's newest log entry, so a permanent door
 *      still says what changed behind it.
 *
 *   3. THE LOG — the newest few entries of any kind, linking to their anchors
 *      on recent-development.html.
 *
 * RULES, each deliberate
 *   • An entry belongs to the FIRST of its links that is a catalogued
 *     simulation. Entries are written with the page the change is about
 *     first; a later link is "also see".
 *   • 'platform' entries (accounts, pricing, infrastructure) never make a
 *     carousel slide even when they link a simulation — a database move is
 *     not a reason to open EarthView. They still appear in the log strip.
 *   • A fixture may ALSO be a carousel slide when its newest change is recent
 *     enough to rank: "EarthView got a physically lit globe" is news, and the
 *     tile beside it is the permanent door. They answer different questions.
 *   • `fresh` is relative to the `nowMs` handed in — never the build clock.
 */
import { DEV_LOG, dateMs, isFresh } from './dev-log.js';
import { SIMULATIONS, SIM_COUNT } from './simulations-catalog.js';
import { SITE_SECTIONS } from './site-sections.js';
import { LAUNCHPAD_MEDIA } from './home-launchpad-media.js';

/** The permanent real-time simulations, in display order (owner's list). */
export const FIXTURE_IDS = Object.freeze([
    'galactic-map', 'solar-system', 'earth', 'climalytix', 'mars', 'sun',
]);

/**
 * One line per fixture saying what is REAL-TIME about it. Short on purpose —
 * it sits on a 280 px tile. index.html carries the same text statically and
 * the node gate compares them.
 */
export const FIXTURE_LIVE = Object.freeze({
    'galactic-map': 'A 3D map of the Milky Way’s stars — and where tonight’s sky sits in it.',
    'solar-system': 'Every planet placed from the ephemeris at this instant, with near-Earth objects and CMEs in flight.',
    'earth':        'Live weather, wind, clouds and tonight’s aurora oval on one physically lit globe.',
    'climalytix':   'One location, every dataset on one clock: the forecast, the record, the terrain, the air.',
    'mars':         'MOLA terrain you can descend to, with today’s season and local time from JPL.',
    'sun':          'Today’s solar disk from SDO, NOAA’s active regions, and flares and CMEs as they launch.',
});

/**
 * Pages that never FRONT the carousel (owner, 2026-11-23: the carousel opened
 * on Bz Column's line diagram and "looks like shit"). The carousel's job is to
 * pull a visitor into a simulation, and a chart, a calendar or a table does not
 * do that at hero size — these pages stay in the catalogue, the showcase and
 * the build-log strip, they just never lead the first screen. Each entry says
 * why. Add a page here when its screen is an instrument, not a scene.
 */
export const CAROUSEL_EXCLUDE = Object.freeze({
    'bz':           'a 2D instrument diagram (field arrows on a line), not a scene',
    'cme-forecast': 'an arrival calendar — a table of dates, not a scene',
});

/**
 * May this simulation front a carousel slide? Only with a real capture (a
 * glyph plate is fine for a tile, not for the hero) and only if it is not an
 * instrument page. `media` is injectable for the gate.
 */
export function carouselEligible(sim, media = LAUNCHPAD_MEDIA) {
    return !!sim && !!media[sim.id] && !CAROUSEL_EXCLUDE[sim.id];
}

/** Carousel length. Eight is a carousel; twenty is a second catalogue. */
export const RECENT_MAX = 8;
/** Log-strip length. */
export const LOG_MAX = 4;

const pageOf = (href) => String(href || '').split(/[?#]/)[0];

/** Catalogue row for a link href, or null. */
export function simForHref(href, catalog = SIMULATIONS) {
    const page = pageOf(href);
    return catalog.find((s) => s.href === page) || null;
}

/** The simulation an entry is ABOUT: its first link that is catalogued. */
export function simForEntry(entry, catalog = SIMULATIONS) {
    for (const link of entry.links || []) {
        const sim = simForHref(link.href, catalog);
        if (sim) return { sim, href: link.href };
    }
    return null;
}

const newestFirst = (log) => [...log].sort((a, b) => dateMs(b.date) - dateMs(a.date));

/**
 * The carousel: one slide per simulation, newest log entry first.
 * @returns {{ sim, entry, href, fresh }[]}
 */
export function recentSlides({ log = DEV_LOG, catalog = SIMULATIONS, max = RECENT_MAX, nowMs = NaN, eligible = carouselEligible } = {}) {
    const seen = new Set();
    const out = [];
    for (const entry of newestFirst(log)) {
        if (entry.kind === 'platform') continue;
        const hit = simForEntry(entry, catalog);
        if (!hit || seen.has(hit.sim.id) || !eligible(hit.sim)) continue;
        seen.add(hit.sim.id);
        out.push({ sim: hit.sim, entry, href: hit.href, fresh: Number.isFinite(nowMs) && isFresh(entry, nowMs) });
        if (out.length >= max) break;
    }
    return out;
}

/**
 * Newest non-platform entry that is ABOUT `simId` (its first catalogued link),
 * or null. Not "mentions": Glacier Watch links EarthView second (it is also a
 * globe layer) and must not become EarthView's latest change.
 */
export function latestEntryFor(simId, { log = DEV_LOG, catalog = SIMULATIONS } = {}) {
    return newestFirst(log).find((e) => e.kind !== 'platform'
        && simForEntry(e, catalog)?.sim.id === simId) || null;
}

/** The six permanent tiles, resolved against the catalogue. Throws on an unknown id. */
export function fixtures({ log = DEV_LOG, catalog = SIMULATIONS } = {}) {
    return FIXTURE_IDS.map((id) => {
        const sim = catalog.find((s) => s.id === id);
        if (!sim) throw new Error(`home-launchpad: fixture "${id}" is not in js/simulations-catalog.js`);
        return { sim, live: FIXTURE_LIVE[id], latest: latestEntryFor(id, { log, catalog }) };
    });
}

/** The newest entries of ANY kind, for the log strip. */
export function logStrip({ log = DEV_LOG, max = LOG_MAX } = {}) {
    return newestFirst(log).slice(0, max);
}

/** The five section hubs, as the nav names them. */
export function sectionDoors(sections = SITE_SECTIONS, catalog = SIMULATIONS) {
    return sections.map((s) => ({
        id: s.id, label: s.label, href: s.href, icon: s.icon,
        count: catalog.filter((sim) => sim.category === s.id).length,
    }));
}

/**
 * The header's telemetry strip: four numbers, all DERIVED (catalogue + log).
 * `recent` counts entries of any kind within `days` of `nowMs`; with no clock
 * it counts back from the newest entry, so the number never depends on when a
 * build ran.
 */
export function launchpadStats({ log = DEV_LOG, catalog = SIMULATIONS, sections = SITE_SECTIONS, nowMs = NaN, days = 30 } = {}) {
    const sorted = newestFirst(log);
    const last = sorted[0] || null;
    const ref = Number.isFinite(nowMs) ? nowMs : (last ? dateMs(last.date) : NaN);
    const span = days * 86400000;
    const inWindow = sorted.filter((e) => { const t = dateMs(e.date); return ref - t >= -86400000 && ref - t <= span; });
    return {
        simulations: catalog.length,
        sections: sections.length,
        recent: inWindow.length,
        recentNew: inWindow.filter((e) => e.kind === 'simulation').length,
        days,
        lastDate: last ? last.date : null,
    };
}

export { SIM_COUNT };
