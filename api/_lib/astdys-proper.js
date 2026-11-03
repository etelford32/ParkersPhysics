/**
 * api/_lib/astdys-proper.js — PURE adapter for AstDyS's SYNTHETIC PROPER
 * ELEMENTS of the Jupiter Trojans, the external validation set for
 * js/trojan-dynamics.js `properLibration` (TROJAN_PLAN.md §4 item 1).
 * Gate: `node tests/astdys-proper.mjs`.
 *
 * AstDyS (Knežević & Milani; the Trojan method is Milani 1993, Celest. Mech.
 * 57, 59) publishes, per numbered Trojan, a proper libration amplitude, proper
 * eccentricity and proper sin I plus the libration and secular frequencies,
 * computed by frequency analysis of a multi-Myr integration with the four
 * outer planets. Our D_p is the same KIND of quantity measured on a much
 * shorter run, which is exactly why it is worth comparing.
 *
 * ── UNVERIFIED LAYOUT ──────────────────────────────────────────────────────
 * The AstDyS hosts are egress-blocked from the build sandbox, so the file
 * path and its column layout are CANDIDATES (the api/_lib/noaa-regions.js /
 * SUVI pattern): every candidate URL is tried in order, the columns are mapped
 * from the file's OWN header comment line (never by position), and `meta=1`
 * on the route probes
 * every candidate in parallel and returns each one's status and first lines —
 * ONE production request settles it; then trim the lists.
 *
 * ── SSRF story ─────────────────────────────────────────────────────────────
 * The URLs are a frozen table; the route's only parameter is the boolean
 * `meta`, which changes the response shape and never an upstream URL.
 */

export const ASTDYS_HOSTS = Object.freeze([
    'https://newton.spacedys.com/~astdys2/propsynth/',
    'https://hamilton.dm.unipi.it/~astdys2/propsynth/',
]);
// VERIFIED 2026-11-03 (preview ?meta=1): newton.spacedys.com/…/tro.syn answers
// ("Synthetic proper elements Knezevic Jun 2024: 11867 numbered & multiopp.
// Trojans", 925 785 bytes); trojan.syn / trojans.syn 404 there and the Pisa
// mirror was unreachable from Vercel. The mirror stays as the fallback.
export const ASTDYS_FILES = Object.freeze(['tro.syn']);
/** Every candidate URL, primary host first for each file name. */
export const ASTDYS_CANDIDATES = Object.freeze(
    ASTDYS_FILES.flatMap(f => ASTDYS_HOSTS.map(h => h + f)));

/**
 * Header-token candidates, matched case-insensitively after stripping units
 * and punctuation. The VERIFIED production header (2026-11-03) is
 *   %Name  H  da(AU)  D(deg)  f(deg/y)  e  g("/y)  sin I  s("/y)  L  My
 * — both libration forms, the libration frequency in deg/yr, the secular
 * frequencies in arcsec/yr, the integration span in Myr (`My`, 5 or 50) and
 * an integer quality column `L` relayed as published.
 */
const COLUMN_CANDIDATES = Object.freeze({
    name:  ['name', 'asteroid', 'number', 'num', 'id', 'desig'],
    H:     ['h', 'mag', 'absmag', 'hmag'],
    da:    ['da', 'dap', 'dau'],
    D:     ['d', 'dp', 'dlib', 'libamp', 'ampl'],
    f:     ['f', 'freq', 'flib', 'libfreq', 'fl'],
    e:     ['e', 'ep', 'eprop'],
    g:     ['g'],
    sinI:  ['sini', 'sinip'],
    s:     ['s'],
    L:     ['l', 'lce', 'lyap'],
    My:    ['my', 'myr', 'span'],
});

const norm = (t) => String(t).toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');

/** Designations compared without spaces: AstDyS writes "2001QR322", SBDB "2001 QR322". */
export function normaliseDesignation(d) {
    return d == null ? null : String(d).replace(/\s+/g, '').replace(/^\((.*)\)$/, '$1').toUpperCase();
}

/**
 * Parse a .syn text body.
 * @returns {{ ok, reason?, rows, field_map, header_line, sample_lines, count }}
 */
export function parseSyn(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'empty_body', rows: [], count: 0, sample_lines: [] };
    if (/^\s*<(!doctype|html)/i.test(text)) return { ok: false, reason: 'html_not_data', rows: [], count: 0, sample_lines: text.split('\n').slice(0, 3) };
    const lines = text.split(/\r?\n/);
    const isComment = (l) => /^\s*[%#!;]/.test(l);
    const data = lines.filter(l => l.trim() && !isComment(l));
    const sample = lines.slice(0, 6);
    if (!data.length) return { ok: false, reason: 'no_data_rows', rows: [], count: 0, sample_lines: sample };
    const width = data[0].trim().split(/\s+/).length;
    // The header is the last comment line whose token count matches the data.
    // "sin I" is ONE column written as two tokens in the real header.
    const headers = lines.filter(isComment).map(l => l.replace(/^\s*[%#!;]+/, '').replace(/sin\s+I/gi, 'sinI').trim().split(/\s+/).filter(Boolean));
    // The header is the last comment line that matches the data width AND
    // names a designation column — the title line of the real file happens
    // to have exactly as many words as a data row (measured), so width alone
    // picked it.
    const namesName = (h) => h.some(t => COLUMN_CANDIDATES.name.includes(norm(t)));
    const header = [...headers].reverse().find(h => h.length === width && namesName(h)) ?? null;
    if (!header) return { ok: false, reason: `no_header_matching_${width}_columns`, rows: [], count: 0, sample_lines: sample };
    const tokens = header.map(norm);
    const map = {};
    for (const [key, names] of Object.entries(COLUMN_CANDIDATES)) {
        const i = tokens.findIndex((t, k) => names.includes(t) && !Object.values(map).includes(k));
        if (i >= 0) map[key] = i;
    }
    if (map.name == null || (map.D == null && map.da == null)) {
        return { ok: false, reason: `missing_columns:${[map.name == null ? 'name' : null, map.D == null && map.da == null ? 'D|da' : null].filter(Boolean).join(',')}`,
            rows: [], count: 0, header_line: header.join(' '), sample_lines: sample, field_map: fieldMap(header, map) };
    }
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const rows = [];
    for (const l of data) {
        const c = l.trim().split(/\s+/);
        if (c.length !== width) continue;
        const get = (k) => (map[k] != null ? num(c[map[k]]) : null);
        rows.push({
            des: normaliseDesignation(c[map.name]),
            H: get('H'), da: get('da'), D: get('D'), f: get('f'),
            e: get('e'), g: get('g'), sinI: get('sinI'), s: get('s'), L: get('L'), My: get('My'),
        });
    }
    return { ok: rows.length > 0, rows, count: rows.length, header_line: header.join(' '),
        field_map: fieldMap(header, map), sample_lines: sample,
        ...(rows.length ? {} : { reason: 'no_parseable_rows' }) };
}

function fieldMap(header, map) {
    return Object.fromEntries(Object.entries(map).map(([k, i]) => [k, header[i]]));
}

/** Compose the /api/trojans/proper body. */
export function composeProperResponse({ parsed, source, attempts, generatedAt = new Date().toISOString() }) {
    const ok = !!parsed?.ok;
    return {
        source: 'astdys',
        upstream: 'AstDyS synthetic proper elements (Jupiter Trojans)',
        generated_at: generatedAt,
        source_url: source ?? null,
        attempts: attempts ?? [],
        // Units as AstDyS publishes them: da AU, D deg, f deg/yr, g and s
        // arcsec/yr, My = integration span in Myr; L relayed as published.
        columns: ['des', 'H', 'da', 'D', 'f', 'e', 'g', 'sinI', 's', 'L', 'My'],
        header_line: parsed?.header_line ?? null,
        field_map: parsed?.field_map ?? {},
        count: parsed?.count ?? 0,
        rows: (parsed?.rows ?? []).map(r => [r.des, r.H, r.da, r.D, r.f, r.e, r.g, r.sinI, r.s, r.L, r.My]),
        freshness: ok ? 'live' : 'stale',
        ...(ok ? {} : { degraded_reason: parsed?.reason ?? 'unreachable', sample_lines: parsed?.sample_lines ?? [] }),
    };
}
