/**
 * js/bz/archive.js — the Bz engine's own minute archive (PURE).
 *
 * BZ_ENGINE_PLAN.md §21. The 131-day hindcast (§20) could test only the Dst
 * model, because the site keeps ONE merged L1 stream and no GOES magnetometer
 * history. This is the record the other two claims need:
 *
 *   l1_mag     every L1 spacecraft SEPARATELY (GSM and GSE as published, the
 *              active flag) — the fusion and the tilted-front delay need
 *              independent instruments, so they are never merged here
 *   l1_plasma  speed / density / temperature / velocity components, per spacecraft
 *   l1_ephem   where each spacecraft was (hourly, km GSE as published)
 *   geo_mag    each GOES magnetometer in its own E/P/N frame, arcjet flag kept
 *
 * One JSON document per UTC DAY (R2 key `dayKey(day)`), written by
 * api/cron/bz-archive.js every six hours and read back through
 * /api/bz/archive. This module is the format, the split and the merge; it
 * does no I/O and reads no clock.
 *
 * RULES (each gated in tests/bz-archive.mjs):
 *   • VALUES ARE STORED AS NORMALISED, UNROUNDED. js/bz/feeds.js already
 *     turned fill values and blanks into null; nothing is re-derived here.
 *   • A GAP IS A GAP. A null is stored as null and a missing minute is simply
 *     absent — no row is invented to make a day look complete.
 *   • MERGE NEVER LOSES A MEASUREMENT. The feeds are sliding windows that
 *     overlap from run to run (L1 ≈ 24 h, GOES 7 days). Per (stream, id,
 *     instant, column): a new non-null value replaces the old one (SWPC
 *     re-issues); a new NULL never erases a stored value.
 *   • KEYED BY INSTANT, in whole seconds from the day's 00:00 UT — IMAP's time
 *     tags are off the minute, so a minute index would collide or drift.
 *   • A row belongs to the UTC day of its OWN time tag. A run that spans
 *     midnight writes two documents.
 *   • The document says what it holds (`summary`) so a reader never has to
 *     guess coverage from file size.
 */

export const ARCHIVE_VERSION = 1;
export const ARCHIVE_PREFIX = 'datasets/bz/days/';
export const INDEX_KEY = 'datasets/bz/index.json.gz';
const DAY_MS = 86_400_000;

/** The four streams: where each lives in a normalised feed, and which columns are kept. */
export const STREAMS = Object.freeze({
    l1_mag:    { feed: 'l1-mag',    group: 'spacecraft', columns: ['bx_gsm', 'by_gsm', 'bz_gsm', 'bx_gse', 'by_gse', 'bz_gse', 'bt', 'active'] },
    l1_plasma: { feed: 'l1-plasma', group: 'spacecraft', columns: ['speed', 'density', 'temperature', 'vx_gse', 'vy_gse', 'vz_gse'] },
    l1_ephem:  { feed: 'l1-ephem',  group: 'spacecraft', columns: ['x', 'y', 'z'] },
    geo_mag:   { feed: 'geo-mag',   group: 'satellites', columns: ['he', 'hp', 'hn', 'total', 'arcjet'] },
});

export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const dayStartMs = (day) => Date.parse(`${day}T00:00:00Z`);
export const isDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(dayStartMs(s)) && dayOf(dayStartMs(s)) === s;
export function dayKey(day) {
    if (!isDay(day)) throw new Error(`not a UTC day: ${String(day).slice(0, 20)}`);
    return `${ARCHIVE_PREFIX}${day.slice(0, 4)}/${day}.json.gz`;
}

const stored = (v) => (v === true ? 1 : v === false ? 0 : (typeof v === 'number' && Number.isFinite(v) ? v : null));

/**
 * Normalised feeds → rows per day.
 * @param {Record<string, object|null>} feeds  keyed by FEED id ('l1-mag', …); a missing/failed feed is simply absent
 * @returns {Record<string, Record<string, Record<string, Array<Array<number|null>>>>>}  day → stream → id → [tSec, …columns]
 */
export function splitByDay(feeds) {
    const out = {};
    for (const [stream, spec] of Object.entries(STREAMS)) {
        const groups = feeds?.[spec.feed]?.[spec.group];
        if (!groups) continue;
        for (const [id, g] of Object.entries(groups)) {
            for (const s of g?.samples ?? []) {
                if (!Number.isFinite(s?.t)) continue;
                const day = dayOf(s.t), tSec = Math.round((s.t - dayStartMs(day)) / 1000);
                const row = [tSec, ...spec.columns.map((c) => stored(s[c]))];
                if (row.slice(1).every((v) => v == null)) continue; // an all-null row carries nothing
                (((out[day] ??= {})[stream] ??= {})[id] ??= []).push(row);
            }
        }
    }
    return out;
}

export function emptyDay(day) {
    if (!isDay(day)) throw new Error(`not a UTC day: ${String(day).slice(0, 20)}`);
    return { v: ARCHIVE_VERSION, day, updated: null, runs: 0,
        note: 'Bz engine minute archive — per-spacecraft L1 and per-satellite GOES, as normalised by js/bz/feeds.js, unrounded; nulls are gaps',
        columns: Object.fromEntries(Object.entries(STREAMS).map(([k, s]) => [k, ['t_s', ...s.columns]])),
        streams: {}, summary: {} };
}

/**
 * Merge one run's rows for a day into the stored document.
 * @returns {{ doc:object, added:number, changed:number, kept:number }}  kept = stored values a new null did NOT erase
 */
export function mergeDay(existing, day, incoming, { nowMs }) {
    const doc = existing && existing.v === ARCHIVE_VERSION && existing.day === day ? structuredClone(existing) : emptyDay(day);
    let added = 0, changed = 0, kept = 0;
    for (const [stream, ids] of Object.entries(incoming ?? {})) {
        if (!STREAMS[stream]) continue;
        const width = STREAMS[stream].columns.length + 1;
        for (const [id, rows] of Object.entries(ids)) {
            const have = new Map(((doc.streams[stream] ??= {})[id] ?? []).map((r) => [r[0], r]));
            for (const row of rows) {
                if (row.length !== width || !(row[0] >= 0 && row[0] < 86400)) continue; // not this day's row: refused, never coerced
                const old = have.get(row[0]);
                if (!old) { have.set(row[0], row.slice()); added++; continue; }
                for (let k = 1; k < width; k++) {
                    if (row[k] == null) { if (old[k] != null) kept++; continue; }
                    if (old[k] !== row[k]) { old[k] = row[k]; changed++; }
                }
            }
            doc.streams[stream][id] = [...have.values()].sort((a, b) => a[0] - b[0]);
        }
    }
    if (added || changed || !doc.updated) { doc.updated = new Date(nowMs).toISOString(); doc.runs = (doc.runs ?? 0) + 1; }
    doc.summary = summarize(doc);
    return { doc, added, changed, kept };
}

/** What a day document holds: rows, first/last instant and non-null count of the headline column, per stream and id. */
export function summarize(doc) {
    const head = { l1_mag: 'bz_gsm', l1_plasma: 'speed', l1_ephem: 'x', geo_mag: 'hp' };
    const out = {};
    for (const [stream, ids] of Object.entries(doc.streams ?? {})) {
        const k = STREAMS[stream].columns.indexOf(head[stream]) + 1;
        out[stream] = {};
        for (const [id, rows] of Object.entries(ids)) {
            if (!rows.length) continue;
            const t0 = dayStartMs(doc.day);
            out[stream][id] = { rows: rows.length, valid: rows.filter((r) => r[k] != null).length,
                first: new Date(t0 + rows[0][0] * 1000).toISOString(), last: new Date(t0 + rows[rows.length - 1][0] * 1000).toISOString() };
        }
    }
    return out;
}

/** The archive's index: one line per day. Updated in place; never lists a day that was not written. */
export function updateIndex(index, docs, { nowMs }) {
    const out = index && index.v === ARCHIVE_VERSION ? structuredClone(index) : { v: ARCHIVE_VERSION, updated: null, days: {} };
    for (const doc of docs) {
        const line = { updated: doc.updated };
        for (const [stream, ids] of Object.entries(doc.summary)) line[stream] = Object.fromEntries(Object.entries(ids).map(([id, s]) => [id, s.valid]));
        out.days[doc.day] = line;
    }
    out.days = Object.fromEntries(Object.entries(out.days).sort(([a], [b]) => (a < b ? -1 : 1)));
    out.updated = new Date(nowMs).toISOString();
    const days = Object.keys(out.days);
    out.first = days[0] ?? null; out.last = days[days.length - 1] ?? null; out.count = days.length;
    return out;
}

/** How fresh the archive is, from its index. The cron runs every 6 h. */
export function archiveFreshness(index, nowMs) {
    if (!index?.updated) return { freshness: 'expired', reasons: ['no_archive_yet'], age_s: null };
    const age = (nowMs - Date.parse(index.updated)) / 1000;
    return { freshness: age <= 7.5 * 3600 ? 'fresh' : age <= 13 * 3600 ? 'stale' : 'expired', reasons: age <= 7.5 * 3600 ? [] : ['archive_run_overdue'], age_s: Math.round(age) };
}

/**
 * Read one column of one id back out of a set of day documents as {t, v} points (ms, value|null).
 * The reader a hindcast uses; days that are missing contribute nothing (a gap, not a zero).
 */
export function readSeries(docs, stream, id, column) {
    const k = (STREAMS[stream]?.columns.indexOf(column) ?? -1) + 1;
    if (k < 1) throw new Error(`unknown column ${stream}.${column}`);
    const out = [];
    for (const doc of [...docs].filter(Boolean).sort((a, b) => (a.day < b.day ? -1 : 1))) {
        const t0 = dayStartMs(doc.day);
        for (const r of doc.streams?.[stream]?.[id] ?? []) out.push({ t: t0 + r[0] * 1000, v: r[k] });
    }
    return out;
}

/** Days a time window touches (UTC), for readers. */
export function daysCovering(startMs, endMs) {
    const out = [];
    for (let t = dayStartMs(dayOf(startMs)); t <= endMs; t += DAY_MS) out.push(dayOf(t));
    return out;
}
