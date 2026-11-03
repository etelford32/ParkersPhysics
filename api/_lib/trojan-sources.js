/**
 * api/_lib/trojan-sources.js — PURE adapters behind /api/trojans/catalog.
 * Gate: `node tests/trojan-sources.mjs`.
 *
 * The Jupiter Trojan population is TWO JPL products joined at ONE instant:
 *
 *   sbdb_query.api   osculating heliocentric elements for every object JPL
 *                    files under orbit class TJN ("Jupiter Trojan"), in ONE
 *                    request — the same service, field list and parser the
 *                    NEO catalogue uses (api/_lib/neo-sources.js), whose
 *                    schema is VERIFIED in production (2026-11-03: every core
 *                    and photometry column mapped, `unmapped: ['spec_T']`).
 *   horizons.api     the Sun-centred state vectors of JUPITER and SATURN at
 *                    the catalogue's own osculating epoch. A Trojan is
 *                    defined by its mean longitude RELATIVE TO JUPITER's, so
 *                    Jupiter must be in the SAME frame (J2000 ecliptic), at
 *                    the SAME instant, osculating rather than mean — anything
 *                    else biases every resonant angle by the difference.
 *                    Saturn is the integrator's second perturber.
 *
 * ── TJN IS A SEMIMAJOR-AXIS BOX, NOT A DYNAMICAL CLASS ─────────────────────
 * JPL's class is a cut in (a, e) around 5.2 AU. Whether an object actually
 * LIBRATES about L4/L5 is a property of its motion, decided downstream by
 * js/trojan-dynamics.js. The route ships the population as filed and never
 * pretends the filing is the physics.
 *
 * ── PRECISION ──────────────────────────────────────────────────────────────
 * By default sbdb_query rounds each element to its "expected" precision (the
 * production NEO body shows e = 0.827, a = 1.078). A resonant angle is
 * λ − λ_J and a libration estimate needs (a − a_J)/a_J to ~1e-4, so this
 * route asks for `full-prec=true`. VERIFIED in production 2026-11-03 (the
 * body read `precision: 'full'`, Hektor e = 0.0243449, a = 5.2769861); the
 * 4xx ladder stays as defence and the body keeps self-reporting.
 *
 * ── SSRF story ─────────────────────────────────────────────────────────────
 * No client parameter reaches an upstream URL. The SBDB query is frozen; the
 * Horizons query takes only the epoch JPL itself returned, validated as a
 * finite Julian date inside a sane window and formatted by this module.
 */

import { SBDB_QUERY_BASE, SBDB_FIELDS, SBDB_FIELDS_CORE, parseSbdbQuery, compactRows } from './neo-sources.js';
import { NEO_ROW_COLUMNS } from '../../js/neo-orbits.js';

export const HORIZONS_BASE = 'https://ssd.jpl.nasa.gov/api/horizons.api';
export const TROJAN_CLASS = 'TJN';

/** Horizons body ids of the perturbers the kernel needs, in the order shipped. */
export const PERTURBERS = Object.freeze([
    { key: 'jupiter', command: '599' },
    { key: 'saturn',  command: '699' },
]);

/**
 * Orbit-QUALITY columns — the difference between "this object is dynamically
 * unstable" and "this object's orbit is not known well enough to say". The
 * first full run (2026-11-03) found most of its non-librating rows were
 * single-opposition 2014 discoveries; without these columns the analysis
 * cannot tell the two apart. VERIFIED in production 2026-11-03 (all three
 * matched, attached to 16 445 / 16 445 rows); they still ride their own
 * first-to-drop rung of the ladder (`quality_fields: 'dropped'`).
 */
export const SBDB_FIELDS_QUALITY = Object.freeze(['condition_code', 'data_arc', 'n_obs_used']);
/** Extra wire columns the Trojan route appends AFTER the shared NEO columns. */
export const TROJAN_EXTRA_COLUMNS = Object.freeze(['cc', 'arc_d', 'n_obs']);

/** Julian dates outside this window are refused rather than sent upstream. */
export const EPOCH_WINDOW = Object.freeze({ min: 2415020.5 /* 1900 */, max: 2488069.5 /* 2100 */ });

/**
 * The SBDB query for the whole TJN population.
 * @param {{ photometry?: boolean, fullPrecision?: boolean }} [opts]
 */
export function sbdbTrojanUrl({ photometry = true, fullPrecision = true, quality = false } = {}) {
    const u = new URL(SBDB_QUERY_BASE);
    const fields = [...(photometry ? SBDB_FIELDS : SBDB_FIELDS_CORE), ...(quality ? SBDB_FIELDS_QUALITY : [])];
    u.searchParams.set('fields', fields.join(','));
    u.searchParams.set('sb-kind', 'a');
    u.searchParams.set('sb-class', TROJAN_CLASS);
    if (fullPrecision) u.searchParams.set('full-prec', 'true');
    return u.toString();
}

/** Formats a validated JD for Horizons, or returns null (never a guess). */
export function horizonsJd(jd) {
    const n = Number(jd);
    if (!Number.isFinite(n) || n < EPOCH_WINDOW.min || n > EPOCH_WINDOW.max) return null;
    return `JD${n.toFixed(5)}`;
}

/**
 * Sun-centred J2000-ecliptic state vector of one perturber at `jd` (TDB).
 * START/STOP/STEP is the request shape api/health.js already proves against
 * production; the FIRST row is the epoch. Vector tables are in TDB, which is
 * also SBDB's epoch scale.
 */
export function horizonsVectorUrl(command, jd) {
    const body = PERTURBERS.find(p => p.command === command);
    const t0 = horizonsJd(jd);
    if (!body || !t0) return null;
    const t1 = horizonsJd(Number(jd) + 1);
    const q = (v) => `'${v}'`;
    const params = {
        format: 'json',
        COMMAND: q(command),
        OBJ_DATA: q('NO'),
        MAKE_EPHEM: q('YES'),
        EPHEM_TYPE: q('VECTORS'),
        CENTER: q('500@10'),          // Sun body centre — SBDB elements are heliocentric
        REF_PLANE: q('ECLIPTIC'),
        REF_SYSTEM: q('ICRF'),        // ICRF ecliptic ≡ J2000 ecliptic at this precision
        VEC_TABLE: q('2'),            // state vector only
        OUT_UNITS: q('AU-D'),
        CSV_FORMAT: q('YES'),
        START_TIME: q(t0),
        STOP_TIME: q(t1),
        STEP_SIZE: q('1 d'),
    };
    const u = new URL(HORIZONS_BASE);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
}

/**
 * Parse a Horizons VECTORS (CSV, table 2) body.
 * @returns {{ ok:true, jd:number, r:number[], v:number[] } | { ok:false, reason:string }}
 */
export function parseHorizonsVector(json) {
    const text = typeof json === 'string' ? json : json?.result;
    if (typeof text !== 'string') return { ok: false, reason: json?.error ? `horizons_error:${String(json.error).slice(0, 120)}` : 'no_result_text' };
    const soe = text.indexOf('$$SOE'), eoe = text.indexOf('$$EOE');
    if (soe < 0 || eoe < soe) return { ok: false, reason: 'no_ephemeris_block' };
    const line = text.slice(soe + 5, eoe).split('\n').map(s => s.trim()).find(Boolean);
    if (!line) return { ok: false, reason: 'empty_ephemeris_block' };
    const cells = line.split(',').map(s => s.trim());
    // JDTDB, Calendar Date (TDB), X, Y, Z, VX, VY, VZ,
    const nums = [cells[0], ...cells.slice(2, 8)].map(Number);
    if (nums.length < 7 || !nums.every(Number.isFinite)) return { ok: false, reason: 'unparseable_row' };
    const [jd, x, y, z, vx, vy, vz] = nums;
    if (Math.hypot(x, y, z) < 1 || Math.hypot(x, y, z) > 20) return { ok: false, reason: 'implausible_radius' };
    return { ok: true, jd, r: [x, y, z], v: [vx, vy, vz] };
}

/** The epoch most rows share — the instant everything else is joined at. */
export function modalEpoch(records) {
    const counts = new Map();
    for (const r of records) if (Number.isFinite(r.epoch)) counts.set(r.epoch, (counts.get(r.epoch) || 0) + 1);
    let best = null, n = 0;
    for (const [ep, c] of counts) if (c > n || (c === n && ep > best)) { best = ep; n = c; }
    return { epoch: best, shared: n, distinct: counts.size };
}

const QUALITY_CANDIDATES = Object.freeze({
    cc:    ['condition_code', 'cc', 'u'],
    arc_d: ['data_arc', 'arc', 'data_arc_d'],
    n_obs: ['n_obs_used', 'n_obs', 'nobs'],
});

/**
 * Parse the TJN query with the NEO parser (one parser, one verified schema),
 * then attach the optional quality columns by designation. Reports
 * `quality.columns` (what matched) so production settles the spellings.
 */
export function parseTrojanQuery(json) {
    const parsed = parseSbdbQuery(json, { kind: 'a' });
    const fields = Array.isArray(json?.fields) ? json.fields.map(f => String(f).toLowerCase()) : [];
    const idx = {};
    for (const [k, names] of Object.entries(QUALITY_CANDIDATES)) {
        const i = names.map(n => fields.indexOf(n.toLowerCase())).find(i => i >= 0);
        if (i != null) idx[k] = i;
    }
    const desIdx = fields.indexOf('pdes');
    const columns = Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, json.fields[i]]));
    if (!Object.keys(idx).length || desIdx < 0 || !Array.isArray(json?.data)) {
        return { ...parsed, unmapped: parsed.unmapped, quality: { columns, attached: 0 } };
    }
    const byDes = new Map();
    for (const row of json.data) if (Array.isArray(row)) byDes.set(String(row[desIdx]).trim(), row);
    let attached = 0;
    const toNum = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
    for (const rec of parsed.records) {
        const row = byDes.get(rec.des);
        if (!row) continue;
        const ccRaw = idx.cc != null ? row[idx.cc] : null;
        rec.cc = ccRaw == null || ccRaw === '' ? null : String(ccRaw).trim();
        rec.arc_d = idx.arc_d != null ? toNum(row[idx.arc_d]) : null;
        rec.n_obs = idx.n_obs != null ? toNum(row[idx.n_obs]) : null;
        attached++;
    }
    const quality = new Set(Object.values(columns).map(c => c.toLowerCase()));
    return { ...parsed, unmapped: parsed.unmapped.filter(u => !quality.has(String(u).toLowerCase())), quality: { columns, attached } };
}

/**
 * Compose the /api/trojans/catalog body.
 *
 * Freshness: 'live' needs the population AND Jupiter. Without Jupiter the
 * rows still ship (they are real) but no resonant angle can be computed in
 * Jupiter's own frame — the client falls back to mean elements and says so —
 * so the body is 'stale'. Without the population it is 'stale' and empty.
 */
export function composeTrojanResponse({ sbdb, precision, photometry, quality, epochInfo, perturbers, generatedAt = new Date().toISOString() }) {
    const records = sbdb?.records ?? [];
    const jup = perturbers?.jupiter, sat = perturbers?.saturn;
    const ok = !!sbdb?.ok && records.length > 0 && !!jup?.ok;
    const vec = (p) => (p?.ok ? { jd: p.jd, r: p.r, v: p.v } : null);
    const degraded = !sbdb?.ok || !records.length ? (sbdb?.reason ?? 'sbdb_unavailable')
        : !jup?.ok ? `jupiter_vector_unavailable: ${jup?.reason ?? 'not_fetched'}` : null;
    return {
        source: 'jpl-sbdb+horizons',
        upstream: 'JPL SBDB query API (class TJN) · JPL Horizons (599, 699)',
        generated_at: generatedAt,
        orbit_class: TROJAN_CLASS,
        elements_frame: 'heliocentric ecliptic J2000, osculating at `epoch` (JD TDB)',
        perturber_frame: 'Sun-centred ecliptic J2000 (ICRF), AU and AU/day, TDB',
        // APPEND-ONLY, like NEO_ROW_COLUMNS: the shared NEO columns first (so
        // js/neo-orbits.js rowToRecord still reads a row), then the Trojan
        // extras. Readers resolve the extras BY NAME from this list.
        columns: [...NEO_ROW_COLUMNS, ...TROJAN_EXTRA_COLUMNS],
        count: records.length,
        epoch: epochInfo ?? modalEpoch(records),
        precision: precision ?? null,
        photometry_fields: photometry ?? null,
        quality_fields: quality ?? null,
        perturbers: { jupiter: vec(jup), saturn: vec(sat) },
        rows: compactRows(records).map((row, k) => [...row, ...TROJAN_EXTRA_COLUMNS.map(c => records[k][c] ?? null)]),
        sources: {
            sbdb: { ok: !!sbdb?.ok, count: records.length, reason: sbdb?.reason ?? null,
                field_map: sbdb?.field_map ?? {}, unmapped: sbdb?.unmapped ?? [], dropped: sbdb?.dropped ?? {},
                photometry: sbdb?.photometry ?? null,
                // Query refinements JPL refused before the one that answered
                // (e.g. 'full/requested: HTTP 400' ⇒ full-prec is misspelt).
                refused: sbdb?.refused ?? [],
                quality: sbdb?.quality ?? null },
            jupiter: { ok: !!jup?.ok, reason: jup?.ok ? null : (jup?.reason ?? 'not_fetched') },
            saturn:  { ok: !!sat?.ok, reason: sat?.ok ? null : (sat?.reason ?? 'not_fetched') },
        },
        freshness: ok ? 'live' : 'stale',
        ...(degraded ? { degraded_reason: degraded } : {}),
    };
}
