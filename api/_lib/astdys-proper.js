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
 * from the file's OWN header comment line (never by position), the libration
 * column's UNIT is detected and reported, and `meta=1` on the route probes
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
export const ASTDYS_FILES = Object.freeze(['tro.syn', 'trojan.syn', 'trojans.syn']);
/** Every candidate URL, primary host first for each file name. */
export const ASTDYS_CANDIDATES = Object.freeze(
    ASTDYS_FILES.flatMap(f => ASTDYS_HOSTS.map(h => h + f)));

/** Header-token candidates, matched case-insensitively after stripping units/punctuation. */
const COLUMN_CANDIDATES = Object.freeze({
    name:  ['name', 'asteroid', 'number', 'num', 'id', 'desig'],
    H:     ['mag', 'h', 'absmag', 'hmag'],
    lib:   ['d', 'dp', 'da', 'dap', 'lib', 'dlib', 'libamp', 'ampl', 'delta'],
    e:     ['e', 'ep', 'eprop'],
    sinI:  ['sini', 'sinip', 'sin', 'sinip'],
    f:     ['f', 'freq', 'flib', 'libfreq', 'fl', 'n'],
    g:     ['g'],
    s:     ['s'],
    lce:   ['lce', 'lyap', 'lyapunov'],
});

const norm = (t) => String(t).toLowerCase().replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]/g, '');

/** Designations compared without spaces: AstDyS writes "2001QR322", SBDB "2001 QR322". */
export function normaliseDesignation(d) {
    return d == null ? null : String(d).replace(/\s+/g, '').replace(/^\((.*)\)$/, '$1').toUpperCase();
}

/**
 * Parse a .syn text body.
 * @returns {{ ok, reason?, rows, columns, field_map, header_line, lib_unit, sample_lines, count }}
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
    const headers = lines.filter(isComment).map(l => l.replace(/^\s*[%#!;]+/, '').trim().split(/\s+/).filter(Boolean));
    const header = [...headers].reverse().find(h => h.length === width) ?? null;
    if (!header) return { ok: false, reason: `no_header_matching_${width}_columns`, rows: [], count: 0, sample_lines: sample };
    const tokens = header.map(norm);
    const map = {};
    for (const [key, names] of Object.entries(COLUMN_CANDIDATES)) {
        const i = tokens.findIndex((t, k) => names.includes(t) && !Object.values(map).includes(k));
        if (i >= 0) map[key] = i;
    }
    if (map.name == null || map.lib == null) {
        return { ok: false, reason: `missing_columns:${['name', 'lib'].filter(k => map[k] == null).join(',')}`,
            rows: [], count: 0, header_line: header.join(' '), sample_lines: sample, field_map: fieldMap(header, map) };
    }
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const rows = [];
    for (const l of data) {
        const c = l.trim().split(/\s+/);
        if (c.length !== width) continue;
        rows.push({
            des: normaliseDesignation(c[map.name]),
            H: map.H != null ? num(c[map.H]) : null,
            lib: num(c[map.lib]),
            e: map.e != null ? num(c[map.e]) : null,
            sinI: map.sinI != null ? num(c[map.sinI]) : null,
            f: map.f != null ? num(c[map.f]) : null,
            g: map.g != null ? num(c[map.g]) : null,
            s: map.s != null ? num(c[map.s]) : null,
            lce: map.lce != null ? num(c[map.lce]) : null,
        });
    }
    return { ok: rows.length > 0, rows, count: rows.length, header_line: header.join(' '),
        field_map: fieldMap(header, map), lib_unit: libUnit(header[map.lib], rows), sample_lines: sample,
        ...(rows.length ? {} : { reason: 'no_parseable_rows' }) };
}

function fieldMap(header, map) {
    return Object.fromEntries(Object.entries(map).map(([k, i]) => [k, header[i]]));
}

/**
 * The libration amplitude is published either as an ANGLE (D, degrees) or as
 * a semimajor-axis amplitude (AU). The header token decides when it can; else
 * the values do (a Trojan's D is degrees to tens of degrees; its δa is
 * ≲ 0.3 AU — the separatrix).
 */
export function libUnit(token, rows) {
    const t = String(token ?? '').toLowerCase();
    if (/deg|°/.test(t)) return 'deg';
    if (/au|da/.test(t)) return 'au';
    const v = rows.map(r => r.lib).filter(x => x != null && x > 0).sort((a, b) => a - b);
    if (!v.length) return null;
    return v[Math.floor(v.length / 2)] > 0.5 ? 'deg' : 'au';
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
        columns: ['des', 'H', 'lib', 'e', 'sinI', 'f', 'g', 's', 'lce'],
        lib_unit: parsed?.lib_unit ?? null,
        header_line: parsed?.header_line ?? null,
        field_map: parsed?.field_map ?? {},
        count: parsed?.count ?? 0,
        rows: (parsed?.rows ?? []).map(r => [r.des, r.H, r.lib, r.e, r.sinI, r.f, r.g, r.s, r.lce]),
        freshness: ok ? 'live' : 'stale',
        ...(ok ? {} : { degraded_reason: parsed?.reason ?? 'unreachable', sample_lines: parsed?.sample_lines ?? [] }),
    };
}
