/**
 * api/_lib/neo-sources.js — PURE adapters for JPL's Solar System Dynamics
 * small-body services, shared by /api/neo/catalog and /api/neo/watch.
 * Gate: `node tests/neo-sources.mjs`.
 *
 * Four upstreams, all on ssd-api.jpl.nasa.gov, none needing a key:
 *
 *   sbdb_query.api   orbital elements for a whole population in ONE request
 *                    (the NEO catalogue: ~38 000 asteroids + ~130 comets)
 *   cad.api          close-approach table (which object passes Earth when,
 *                    how close, how fast) — JPL's own integrated orbits, so
 *                    the page never has to trust two-body propagation for
 *                    the approach list itself
 *   sentry.api       the impact-risk monitor (Palermo / Torino scales)
 *   fireball.api     bolides reported by US Government sensors — the
 *                    "meteors" that actually hit
 *
 * ── UNVERIFIED SCHEMAS ─────────────────────────────────────────────────────
 * ssd-api.jpl.nasa.gov is egress-blocked from the build sandbox (403 at the
 * proxy, same as NASA for sun.html), so every field name below is a CANDIDATE
 * LIST from the published API docs, not an observed response. Each parser
 * resolves columns by name, reports `field_map` (what it matched) and
 * `unmapped` (what the upstream sent that nothing here understands), and
 * returns ok:false on a total miss so the route can emit freshness:'stale'
 * instead of scoring an empty 200 as healthy. ONE production request settles
 * the schema: read the route's self-report, then trim the lists. This is the
 * api/_lib/noaa-regions.js / api/_lib/mars-tiles.js pattern.
 *
 * ── SSRF story ─────────────────────────────────────────────────────────────
 * The URL builders take a TIER NAME (catalog) or nothing at all (watch) and
 * rebuild the upstream query from frozen tables. No client parameter reaches
 * an upstream URL. tests/neo-sources.mjs asserts that.
 */

import { NEO_ROW_COLUMNS, recordToRow, FLAG, neoClass } from '../../js/neo-orbits.js';

export const SBDB_QUERY_BASE = 'https://ssd-api.jpl.nasa.gov/sbdb_query.api';
export const CAD_BASE        = 'https://ssd-api.jpl.nasa.gov/cad.api';
export const SENTRY_BASE     = 'https://ssd-api.jpl.nasa.gov/sentry.api';
export const FIREBALL_BASE   = 'https://ssd-api.jpl.nasa.gov/fireball.api';

/** Hard ceiling on rows a catalogue response may carry (memory + payload bound). */
export const MAX_CATALOG_ROWS = 80_000;

// ── Catalogue tiers ─────────────────────────────────────────────────────────
// The page loads `pha` first (small, the objects anyone cares about), then
// `bright` (the George E. Brown Act completeness class, H ≤ 22 ≈ ≥140 m),
// and offers `all` on demand. Each is ONE SBDB query; comets and the
// interstellar extras are separate small queries merged in by the route.
export const CATALOG_TIERS = Object.freeze({
    pha:    { label: 'Potentially hazardous asteroids (MOID ≤ 0.05 AU, H ≤ 22)', group: 'pha', constraint: null },
    bright: { label: 'Near-Earth asteroids with H ≤ 22 (≳140 m)',               group: 'neo', constraint: 'H|LE|22' },
    all:    { label: 'Every catalogued near-Earth asteroid',                     group: 'neo', constraint: null },
});
export const DEFAULT_TIER = 'bright';

/** Fields requested from sbdb_query.api, in the order we want them back. */
export const SBDB_FIELDS = Object.freeze([
    'pdes', 'full_name', 'H', 'class', 'neo', 'pha',
    'e', 'a', 'q', 'i', 'om', 'w', 'ma', 'tp', 'epoch', 'moid', 'diameter',
]);

/** Objects with e above this are treated as interstellar (1I 1.20, 2I 3.36, 3I 6.14). */
export const INTERSTELLAR_E_MIN = 1.1;

function sbdbUrl(params) {
    const u = new URL(SBDB_QUERY_BASE);
    u.searchParams.set('fields', SBDB_FIELDS.join(','));
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
    return u.toString();
}

/** Asteroid query for a named tier. Unknown tiers return null — never a guess. */
export function sbdbAsteroidUrl(tier) {
    const t = CATALOG_TIERS[tier];
    if (!t) return null;
    return sbdbUrl({
        'sb-kind': 'a',
        'sb-group': t.group,
        'sb-cdata': t.constraint ? JSON.stringify({ AND: [t.constraint] }) : null,
    });
}
/** Near-Earth comets (q < 1.3 AU, P < 200 yr — all elliptic). */
export function sbdbCometUrl() {
    return sbdbUrl({ 'sb-kind': 'c', 'sb-group': 'neo' });
}
/** Interstellar visitors: anything with e > INTERSTELLAR_E_MIN, either kind. */
export function sbdbInterstellarUrl() {
    return sbdbUrl({ 'sb-cdata': JSON.stringify({ AND: [`e|GT|${INTERSTELLAR_E_MIN}`] }) });
}

// ── Column resolution ───────────────────────────────────────────────────────

function resolveColumns(fields, candidates) {
    const lower = fields.map(f => String(f).toLowerCase());
    const map = {}, used = new Set();
    for (const [key, names] of Object.entries(candidates)) {
        for (const n of names) {
            const idx = lower.indexOf(n.toLowerCase());
            if (idx >= 0) { map[key] = { index: idx, field: fields[idx] }; used.add(idx); break; }
        }
    }
    const unmapped = fields.filter((_, i) => !used.has(i));
    return { map, unmapped };
}

/** Accepts {fields, data:[[…]]} OR {data:[{…}]} and yields row accessors. */
function tabulate(json, candidates) {
    if (!json || typeof json !== 'object') return { ok: false, reason: 'not_an_object' };
    const data = Array.isArray(json.data) ? json.data : null;
    if (!data) return { ok: false, reason: 'no_data_array' };
    let fields = Array.isArray(json.fields) ? json.fields : null;
    if (!fields && data.length && data[0] && !Array.isArray(data[0]) && typeof data[0] === 'object') {
        fields = Object.keys(data[0]);
        const { map, unmapped } = resolveColumns(fields, candidates);
        const get = (row, key) => (map[key] ? row[map[key].field] : undefined);
        return { ok: true, rows: data, get, fieldMap: map, unmapped, shape: 'objects' };
    }
    if (!fields) return { ok: false, reason: 'no_fields' };
    const { map, unmapped } = resolveColumns(fields, candidates);
    const get = (row, key) => (map[key] ? row[map[key].index] : undefined);
    return { ok: true, rows: data, get, fieldMap: map, unmapped, shape: 'columns' };
}

const numOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
};
const round = (v, dp) => (v == null ? null : Number(v.toFixed(dp)));
const yes = (v) => v === true || v === 'Y' || v === 'y' || v === 1 || v === '1' || v === 'true';

function fieldMapReport(map) {
    const out = {};
    for (const [k, v] of Object.entries(map)) out[k] = v.field;
    return out;
}

// ── SBDB query → catalogue records ──────────────────────────────────────────

const SBDB_CANDIDATES = Object.freeze({
    des:   ['pdes', 'des', 'designation', 'primary_designation'],
    name:  ['full_name', 'fullname', 'name'],
    H:     ['H', 'h', 'abs_mag'],
    cls:   ['class', 'orbit_class', 'class_code'],
    neo:   ['neo'],
    pha:   ['pha'],
    e:     ['e', 'ecc'],
    a:     ['a', 'sma'],
    q:     ['q', 'perihelion'],
    i:     ['i', 'incl', 'inc'],
    om:    ['om', 'node', 'raan', 'Omega'],
    w:     ['w', 'peri', 'argp', 'omega'],
    ma:    ['ma', 'M', 'mean_anomaly'],
    tp:    ['tp', 'tp_jd', 'perihelion_time'],
    epoch: ['epoch', 'epoch_jd', 'epoch_tdb'],
    moid:  ['moid', 'moid_au', 'earth_moid'],
    diam:  ['diameter', 'diam', 'diameter_km'],
});

/**
 * @param {object} json         raw sbdb_query.api body
 * @param {{ kind?: 'a'|'c', interstellar?: boolean }} [opts]
 * @returns {{ ok:boolean, records:object[], count:number, dropped:object, field_map:object, unmapped:string[], reason?:string }}
 */
export function parseSbdbQuery(json, opts = {}) {
    const t = tabulate(json, SBDB_CANDIDATES);
    if (!t.ok) return { ok: false, reason: t.reason, records: [], count: 0, dropped: {}, field_map: {}, unmapped: [] };
    const need = ['e', 'i', 'om', 'w'];
    const missing = need.filter(k => !t.fieldMap[k]);
    if (missing.length || !(t.fieldMap.a || t.fieldMap.q)) {
        return { ok: false, reason: `missing_columns:${[...missing, ...(t.fieldMap.a || t.fieldMap.q ? [] : ['a|q'])].join(',')}`,
            records: [], count: 0, dropped: {}, field_map: fieldMapReport(t.fieldMap), unmapped: t.unmapped };
    }
    const records = [];
    const dropped = {};
    const drop = (why) => { dropped[why] = (dropped[why] || 0) + 1; };
    for (const row of t.rows) {
        if (records.length >= MAX_CATALOG_ROWS) { drop('over_cap'); continue; }
        const e = numOrNull(t.get(row, 'e'));
        const a = numOrNull(t.get(row, 'a'));
        const q = numOrNull(t.get(row, 'q'));
        const i = numOrNull(t.get(row, 'i'));
        const om = numOrNull(t.get(row, 'om'));
        const w = numOrNull(t.get(row, 'w'));
        const ma = numOrNull(t.get(row, 'ma'));
        const tp = numOrNull(t.get(row, 'tp'));
        const epoch = numOrNull(t.get(row, 'epoch'));
        if (e == null || i == null || om == null || w == null) { drop('missing_elements'); continue; }
        if (a == null && q == null) { drop('missing_elements'); continue; }
        if (Math.abs(e - 1) < 1e-3) { drop('parabolic'); continue; }
        if (e < 1 && (ma == null || epoch == null) && tp == null) { drop('no_time_anchor'); continue; }
        if (e >= 1 && tp == null) { drop('no_time_anchor'); continue; }
        const desRaw = t.get(row, 'des');
        const des = desRaw == null ? null : String(desRaw).trim();
        const nameRaw = t.get(row, 'name');
        const name = nameRaw == null ? des : String(nameRaw).replace(/\s+/g, ' ').trim();
        if (!des && !name) { drop('unnamed'); continue; }
        const isComet = opts.kind === 'c';
        const interstellar = opts.interstellar === true || e > INTERSTELLAR_E_MIN;
        let flags = 0;
        if (yes(t.get(row, 'neo'))) flags |= FLAG.NEO;
        if (yes(t.get(row, 'pha'))) flags |= FLAG.PHA;
        if (isComet) flags |= FLAG.COMET;
        if (interstellar) flags |= FLAG.INTERSTELLAR;
        const clsRaw = t.get(row, 'cls');
        const cls = clsRaw ? String(clsRaw).trim() : (neoClass(a ?? q / (1 - e), e) ?? null);
        // "(2024 YR4)" is just the designation in parentheses — ship null and
        // let the client print the designation; only real names cost bytes.
        const bare = name ? name.replace(/^\((.*)\)$/, '$1').trim() : null;
        records.push({
            des: des ?? name,
            name: !name || bare === des ? null : name,
            H: round(numOrNull(t.get(row, 'H')), 2),
            cls, flags,
            e: round(e, 7),
            a: a == null ? null : round(a, 7),
            q: e >= 1 || a == null ? round(q, 7) : null,   // derivable for ellipses
            i: round(i, 4), om: round(om, 4), w: round(w, 4),
            ma: e < 1 && ma != null ? round(ma, 4) : null,
            tp: e >= 1 || ma == null || epoch == null ? round(tp, 4) : null,
            epoch: epoch == null ? null : round(epoch, 2),
            moid: round(numOrNull(t.get(row, 'moid')), 5),
            diam: round(numOrNull(t.get(row, 'diam')), 3),
        });
    }
    return { ok: records.length > 0 || t.rows.length === 0, records, count: records.length, dropped,
        field_map: fieldMapReport(t.fieldMap), unmapped: t.unmapped };
}

/** Wire rows (NEO_ROW_COLUMNS order) from records. */
export function compactRows(records) {
    return records.map(recordToRow);
}

// ── Close-approach data ─────────────────────────────────────────────────────

const CAD_CANDIDATES = Object.freeze({
    des:      ['des', 'designation'],
    orbit_id: ['orbit_id'],
    jd:       ['jd', 'cd_jd'],
    cd:       ['cd', 'close_approach_date', 'date'],
    dist:     ['dist', 'distance', 'miss_distance'],
    dist_min: ['dist_min'],
    dist_max: ['dist_max'],
    v_rel:    ['v_rel', 'vrel', 'relative_velocity'],
    v_inf:    ['v_inf', 'vinf'],
    t_sigma:  ['t_sigma_f', 't_sigma'],
    H:        ['h', 'H'],
    diam:     ['diameter', 'diam'],
    name:     ['fullname', 'full_name', 'name'],
});

const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** "2026-Sep-14 03:12" → epoch ms (UTC); also accepts ISO. */
export function parseCadDate(cd) {
    if (cd == null) return null;
    const s = String(cd).trim();
    const m = s.match(/^(\d{4})-([A-Za-z]{3})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
        const mon = MON[m[2].toLowerCase()];
        if (mon == null) return null;
        return Date.UTC(+m[1], mon, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    }
    const t = Date.parse(s.endsWith('Z') || /[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`);
    return Number.isFinite(t) ? t : null;
}

export function parseCad(json) {
    const t = tabulate(json, CAD_CANDIDATES);
    if (!t.ok) return { ok: false, reason: t.reason, approaches: [], count: 0, field_map: {}, unmapped: [] };
    if (!t.fieldMap.des || !t.fieldMap.dist || !(t.fieldMap.jd || t.fieldMap.cd)) {
        return { ok: false, reason: 'missing_columns', approaches: [], count: 0, field_map: fieldMapReport(t.fieldMap), unmapped: t.unmapped };
    }
    const approaches = [];
    for (const row of t.rows) {
        const dist = numOrNull(t.get(row, 'dist'));
        const jd = numOrNull(t.get(row, 'jd'));
        let tMs = jd != null ? Math.round((jd - 2440587.5) * 86400e3) : parseCadDate(t.get(row, 'cd'));
        if (dist == null || tMs == null) continue;
        const desRaw = t.get(row, 'des');
        const des = desRaw == null ? null : String(desRaw).trim();
        if (!des) continue;
        const nameRaw = t.get(row, 'name');
        approaches.push({
            des,
            name: nameRaw ? String(nameRaw).replace(/\s+/g, ' ').trim() : des,
            t_ms: tMs,
            jd: jd ?? tMs / 86400e3 + 2440587.5,
            dist_au: round(dist, 7),
            dist_min_au: round(numOrNull(t.get(row, 'dist_min')), 7),
            dist_max_au: round(numOrNull(t.get(row, 'dist_max')), 7),
            v_rel_kms: round(numOrNull(t.get(row, 'v_rel')), 3),
            v_inf_kms: round(numOrNull(t.get(row, 'v_inf')), 3),
            H: round(numOrNull(t.get(row, 'H')), 2),
            diam_km: round(numOrNull(t.get(row, 'diam')), 4),
        });
    }
    approaches.sort((x, y) => x.t_ms - y.t_ms);
    return { ok: true, approaches, count: approaches.length, field_map: fieldMapReport(t.fieldMap), unmapped: t.unmapped };
}

/** CAD query window: 7 days back (what just flew by) to 60 days ahead, inside 0.05 AU. */
export const CAD_WINDOW = Object.freeze({ backDays: 7, aheadDays: 60, distMaxAU: 0.05 });
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
export function cadUrl(nowMs = Date.now()) {
    const u = new URL(CAD_BASE);
    u.searchParams.set('date-min', iso(nowMs - CAD_WINDOW.backDays * 86400e3));
    u.searchParams.set('date-max', iso(nowMs + CAD_WINDOW.aheadDays * 86400e3));
    u.searchParams.set('dist-max', String(CAD_WINDOW.distMaxAU));
    u.searchParams.set('sort', 'date');
    u.searchParams.set('fullname', 'true');
    u.searchParams.set('diameter', 'true');
    return u.toString();
}

// ── Sentry impact monitor ───────────────────────────────────────────────────

const SENTRY_CANDIDATES = Object.freeze({
    des:    ['des', 'designation'],
    name:   ['fullname', 'full_name', 'name'],
    ip:     ['ip', 'impact_probability'],
    ps_cum: ['ps_cum', 'palermo_cum', 'ps'],
    ps_max: ['ps_max', 'palermo_max'],
    ts_max: ['ts_max', 'torino_max', 'ts'],
    range:  ['range', 'years'],
    n_imp:  ['n_imp', 'impacts'],
    H:      ['h', 'H'],
    diam:   ['diameter', 'diam'],
    v_inf:  ['v_inf', 'vinf'],
    last_obs: ['last_obs', 'last_observation'],
});
export const SENTRY_KEEP = 40;

export function sentryUrl() { return SENTRY_BASE; }

export function parseSentry(json) {
    const t = tabulate(json, SENTRY_CANDIDATES);
    if (!t.ok) return { ok: false, reason: t.reason, objects: [], count: 0, total: 0, field_map: {}, unmapped: [] };
    if (!t.fieldMap.des || !(t.fieldMap.ps_cum || t.fieldMap.ip)) {
        return { ok: false, reason: 'missing_columns', objects: [], count: 0, total: 0, field_map: fieldMapReport(t.fieldMap), unmapped: t.unmapped };
    }
    const objects = [];
    for (const row of t.rows) {
        const desRaw = t.get(row, 'des');
        const des = desRaw == null ? null : String(desRaw).trim();
        if (!des) continue;
        const nameRaw = t.get(row, 'name');
        const ts = numOrNull(t.get(row, 'ts_max'));
        objects.push({
            des,
            name: nameRaw ? String(nameRaw).replace(/\s+/g, ' ').trim() : des,
            ip: numOrNull(t.get(row, 'ip')),
            ps_cum: round(numOrNull(t.get(row, 'ps_cum')), 2),
            ps_max: round(numOrNull(t.get(row, 'ps_max')), 2),
            ts_max: ts == null ? 0 : ts,
            range: t.get(row, 'range') ?? null,
            n_imp: numOrNull(t.get(row, 'n_imp')),
            H: round(numOrNull(t.get(row, 'H')), 2),
            diam_km: round(numOrNull(t.get(row, 'diam')), 4),
            v_inf_kms: round(numOrNull(t.get(row, 'v_inf')), 2),
            last_obs: t.get(row, 'last_obs') ?? null,
        });
    }
    const total = objects.length;
    // Torino > 0 always survives the trim; the rest by cumulative Palermo scale.
    objects.sort((x, y) => (y.ts_max - x.ts_max) || ((y.ps_cum ?? -99) - (x.ps_cum ?? -99)));
    return { ok: true, objects: objects.slice(0, SENTRY_KEEP), count: Math.min(total, SENTRY_KEEP), total,
        field_map: fieldMapReport(t.fieldMap), unmapped: t.unmapped };
}

// ── Fireballs ───────────────────────────────────────────────────────────────

const FIREBALL_CANDIDATES = Object.freeze({
    date:     ['date', 'datetime', 'time'],
    energy:   ['energy', 'radiated_energy'],
    impact_e: ['impact-e', 'impact_e', 'impact_energy'],
    lat:      ['lat', 'latitude'],
    lat_dir:  ['lat-dir', 'lat_dir'],
    lon:      ['lon', 'longitude'],
    lon_dir:  ['lon-dir', 'lon_dir'],
    alt:      ['alt', 'altitude'],
    vel:      ['vel', 'velocity'],
});
export const FIREBALL_LIMIT = 20;
export function fireballUrl() {
    const u = new URL(FIREBALL_BASE);
    u.searchParams.set('limit', String(FIREBALL_LIMIT));
    return u.toString();
}

export function parseFireballs(json) {
    const t = tabulate(json, FIREBALL_CANDIDATES);
    if (!t.ok) return { ok: false, reason: t.reason, events: [], count: 0, field_map: {}, unmapped: [] };
    if (!t.fieldMap.date || !(t.fieldMap.impact_e || t.fieldMap.energy)) {
        return { ok: false, reason: 'missing_columns', events: [], count: 0, field_map: fieldMapReport(t.fieldMap), unmapped: t.unmapped };
    }
    const events = [];
    for (const row of t.rows) {
        const tMs = parseCadDate(t.get(row, 'date'));
        if (tMs == null) continue;
        const lat = numOrNull(t.get(row, 'lat')), lon = numOrNull(t.get(row, 'lon'));
        const latDir = String(t.get(row, 'lat_dir') ?? 'N').toUpperCase();
        const lonDir = String(t.get(row, 'lon_dir') ?? 'E').toUpperCase();
        events.push({
            t_ms: tMs,
            impact_kt: round(numOrNull(t.get(row, 'impact_e')), 4),          // kilotons TNT
            radiated_j: (() => { const e = numOrNull(t.get(row, 'energy')); return e == null ? null : e * 1e10; })(),
            lat: lat == null ? null : (latDir === 'S' ? -lat : lat),
            lon: lon == null ? null : (lonDir === 'W' ? -lon : lon),
            alt_km: round(numOrNull(t.get(row, 'alt')), 1),
            vel_kms: round(numOrNull(t.get(row, 'vel')), 1),
        });
    }
    events.sort((x, y) => y.t_ms - x.t_ms);
    return { ok: true, events, count: events.length, field_map: fieldMapReport(t.fieldMap), unmapped: t.unmapped };
}

// ── Response composition (shared with the smoke test's mocks) ───────────────

/** Strip a parser result down to the operator-facing self-report. */
function report(r, extra = {}) {
    return { ok: !!r.ok, count: r.count ?? 0, reason: r.reason ?? null, field_map: r.field_map ?? {}, unmapped: r.unmapped ?? [], ...extra };
}

/**
 * Compose the /api/neo/catalog body. `groups` holds the three parser results
 * (each may be { ok:false, reason }). Only the asteroid group decides
 * freshness: comets and interstellar extras are bonuses.
 */
export function composeCatalogResponse({ tier, asteroids, comets, interstellar, generatedAt = new Date().toISOString() }) {
    const records = [];
    const seen = new Set();
    const push = (r) => { for (const rec of (r?.records ?? [])) { const k = rec.des ?? rec.name; if (seen.has(k)) continue; seen.add(k); records.push(rec); } };
    push(asteroids); push(comets); push(interstellar);
    const ok = !!asteroids?.ok;
    return {
        source: 'jpl-sbdb',
        upstream: 'JPL SBDB query API',
        generated_at: generatedAt,
        tier,
        tier_label: CATALOG_TIERS[tier]?.label ?? tier,
        tiers: Object.fromEntries(Object.entries(CATALOG_TIERS).map(([k, v]) => [k, v.label])),
        elements_frame: 'heliocentric ecliptic J2000, osculating at `epoch` (JD TDB)',
        columns: [...NEO_ROW_COLUMNS],
        count: records.length,
        rows: compactRows(records),
        groups: {
            asteroids:    report(asteroids ?? { ok: false, reason: 'not_fetched' }, { dropped: asteroids?.dropped ?? {} }),
            comets:       report(comets ?? { ok: false, reason: 'not_fetched' }, { dropped: comets?.dropped ?? {} }),
            interstellar: report(interstellar ?? { ok: false, reason: 'not_fetched' }, { dropped: interstellar?.dropped ?? {} }),
        },
        freshness: ok ? 'live' : 'stale',
        ...(ok ? {} : { degraded_reason: asteroids?.reason ?? 'sbdb_unavailable', note: 'Asteroid population unavailable — page shows nothing rather than a stale invention.' }),
    };
}

/** Compose the /api/neo/watch body from the three parser results. */
export function composeWatchResponse({ cad, sentry, fireballs, nowMs = Date.now(), generatedAt = new Date(nowMs).toISOString() }) {
    const ok = !!cad?.ok;
    return {
        source: 'jpl-ssd',
        upstream: 'JPL SSD cad.api · sentry.api · fireball.api',
        generated_at: generatedAt,
        window: {
            from: new Date(nowMs - CAD_WINDOW.backDays * 86400e3).toISOString(),
            to: new Date(nowMs + CAD_WINDOW.aheadDays * 86400e3).toISOString(),
            dist_max_au: CAD_WINDOW.distMaxAU,
            body: 'Earth',
        },
        approaches: cad?.approaches ?? [],
        sentry: sentry?.objects ?? [],
        sentry_total: sentry?.total ?? 0,
        fireballs: fireballs?.events ?? [],
        sources: {
            cad:       report(cad ?? { ok: false, reason: 'not_fetched' }),
            sentry:    report(sentry ?? { ok: false, reason: 'not_fetched' }, { total: sentry?.total ?? 0 }),
            fireballs: report(fireballs ?? { ok: false, reason: 'not_fetched' }),
        },
        freshness: ok ? 'live' : 'stale',
        ...(ok ? {} : { degraded_reason: cad?.reason ?? 'cad_unavailable', note: 'Close-approach table unavailable — the page lists nothing rather than a guess.' }),
    };
}
