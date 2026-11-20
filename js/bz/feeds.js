/**
 * js/bz/feeds.js — the Bz engine's FEED CATALOGUE and normalisers (PURE).
 *
 * BZ_ENGINE_PLAN.md phase B0. This is the ONE record of where the engine's
 * raw observations come from and how an upstream payload becomes rows. It has
 * no DOM, no fetch and no ambient time (`nowMs` is always an input), so every
 * rule in it is node-gated by tests/bz-feeds.mjs.
 *
 * It lives in js/ and NOT api/_lib/ on purpose: the browser imports it too
 * (SWPC is CORS-enabled and its WAF often 403s the Vercel edge, so the
 * browser-direct path is the PRIMARY one for the swpc feeds — see
 * api/health.js), and api/ is not served statically.
 *
 * ── WHY EVERYTHING IS A CANDIDATE LIST ───────────────────────────────────
 * services.swpc.noaa.gov and geomag.usgs.gov are both egress-blocked at build
 * time, so every URL and every field spelling was UNVERIFIED until one
 * production request had been made. The house pattern (api/_lib/noaa-regions,
 * the SUVI source list) applies:
 *
 *   • each feed has an ordered list of candidate URLs — the data path stops
 *     at the first one that normalises to at least one row;
 *   • each field resolves from a list of candidate key spellings, and the
 *     result carries `field_map` (which key fed each field) and `unmapped`
 *     (keys we did not claim), so one response settles the schema;
 *   • `describePayload` reports shape / cadence / sources for EVERY
 *     candidate (the route's `meta=1`), so one request also settles which
 *     candidates exist at all.
 *
 * When production has answered: record the winners in the `verified` field
 * of FEEDS, then trim the lists. Do not trim before. (Done 2026-11-20 for
 * four of the five feeds — see each entry; `l1-mag-fast` is still open.)
 *
 * ── RULES THE NORMALISERS ENFORCE ────────────────────────────────────────
 *   • A gap is null, never 0. `num()` is the only number reader:
 *     null / '' / NaN / fill values (|v| ≥ FILL_ABS) → null.
 *   • Nothing is interpolated, re-sampled or re-framed here. GSE and GSM
 *     components are carried side by side exactly as published; the frame
 *     rotation belongs to js/bz/frames.js (phase B1).
 *   • Rows are grouped by SPACECRAFT. The whole point of the engine's rung 0
 *     is that ACE and DSCOVR are two instruments, not one feed.
 *   • Cadence is MEASURED from the time tags (median spacing), never assumed
 *     from the file name.
 */

const SWPC = 'https://services.swpc.noaa.gov';
const USGS = 'https://geomag.usgs.gov/ws/data/';

/** |value| at or above this is an upstream fill value (-9999, 99999, 1e31…). */
export const FILL_ABS = 9990;

/**
 * The catalogue. `kind` selects the normaliser. `verified` is null until a
 * production response has been recorded for that feed.
 */
export const FEEDS = Object.freeze({
    // Rung 0 — L1 magnetometer, 1-minute, every spacecraft in the file (three, measured).
    'l1-mag': {
        kind: 'l1-mag',
        label: 'L1 IMF, every spacecraft, 1-min',
        upstream: 'NOAA SWPC RTSW',
        cadence_s: 60,
        // MEASURED 2026-11-20 on a Vercel preview (edge, iad1 — NOT 403'd):
        // the file carries THREE spacecraft, and DSCOVR is not one of them.
        // IMAP's time tags are NOT on the minute (…:16:02, …:20:03) — align
        // by instant, never by array position or by string equality.
        // products/solar-wind/mag-{2-hour,1-day}.json answered 404 and
        // json/ace/mag/ace_mag_1h.json is HOURLY with gse_bz/gsm_bz spellings
        // — all three were dropped from the list.
        verified: {
            on: '2026-11-20', candidate: 'rtsw-mag-1m', cadence_s: 60, window_h: 24,
            spacecraft: ['SOLAR1', 'IMAP', 'ACE'], active: 'SOLAR1',
            frames: ['gsm', 'gse'], overlap_minutes: 1383,
            unclaimed: ['range', 'scale', 'sensitivity', 'manual_mode', 'sample_size',
                'theta_gse', 'phi_gse', 'theta_gsm', 'phi_gsm', 'max_telemetry_flag', 'max_data_flag'],
        },
        candidates: [
            { id: 'rtsw-mag-1m', url: `${SWPC}/json/rtsw/rtsw_mag_1m.json` },
        ],
    },
    // Rung 0 — L1 plasma (speed, density, velocity vector), per spacecraft.
    // B2 needs the speed for every delay and the density for the bow-shock
    // standoff. MEASURED 2026-11-20 on a Vercel preview: the file carries all
    // THREE spacecraft at 1 minute, but velocity COMPONENTS (GSE and GSM) are
    // published for SOLAR1 only — ACE and IMAP give scalar speed. Alpha
    // moments exist (alpha_*) and are not read yet. The second candidate was
    // never reached and was dropped.
    'l1-plasma': {
        kind: 'l1-plasma',
        label: 'L1 plasma, every spacecraft, 1-min',
        upstream: 'NOAA SWPC RTSW',
        cadence_s: 60,
        verified: {
            on: '2026-11-20', candidate: 'rtsw-wind-1m', cadence_s: 60,
            spacecraft: ['ACE', 'SOLAR1', 'IMAP'], vector_velocity: ['SOLAR1'], frames: ['gse', 'gsm'],
            unclaimed: ['proton_sample_size', 'alpha_speed', 'alpha_temperature', 'alpha_density',
                'alpha_vx_gse', 'alpha_vy_gse', 'alpha_vz_gse', 'alpha_vx_gsm', 'alpha_vy_gsm', 'alpha_vz_gsm',
                'alpha_sample_size', 'max_convergence_flag', 'max_data_flag', 'max_error_count_flag',
                'max_processing_flag', 'max_range_flag', 'max_sample_count_flag', 'max_telemetry_flag'],
        },
        candidates: [
            { id: 'rtsw-wind-1m', url: `${SWPC}/json/rtsw/rtsw_wind_1m.json` },
        ],
    },
    // Rung 0 — is there a sub-minute real-time L1 magnetometer product at all?
    // These names are GUESSES (plan §4.1). MEASURED 2026-11-20: all four are
    // 404. That rules out these four names, NOT the existence of a sub-minute
    // product elsewhere (NCEI, the IMAP I-ALiRT service) — `verified` stays
    // null and the engine runs on the 1-minute floor until one is found.
    'l1-mag-fast': {
        kind: 'l1-mag',
        label: 'L1 IMF, sub-minute (existence check)',
        upstream: 'NOAA SWPC RTSW',
        cadence_s: 1,
        verified: null,
        candidates: [
            { id: 'rtsw-mag-1s',   url: `${SWPC}/json/rtsw/rtsw_mag_1s.json` },
            { id: 'rtsw-mag',      url: `${SWPC}/json/rtsw/rtsw_mag.json` },
            { id: 'dscovr-mag-1s', url: `${SWPC}/json/dscovr/dscovr_mag_1s.json` },
            { id: 'products-mag-5m', url: `${SWPC}/products/solar-wind/mag-5-minute.json` },
        ],
    },
    // Rung 0 — where the spacecraft are (needed for the two-point lag, §4.2).
    'l1-ephem': {
        kind: 'ephem',
        label: 'L1 spacecraft ephemerides',
        upstream: 'NOAA SWPC RTSW',
        cadence_s: 3600,
        // MEASURED 2026-11-20: hourly, KILOMETRES, GSE + GSM + GCI positions
        // AND velocities, ~31 days, the same three spacecraft. The other two
        // candidates answered 404 and were dropped.
        verified: {
            on: '2026-11-20', candidate: 'rtsw-ephem-1h', cadence_s: 3600, unit: 'km',
            spacecraft: ['ACE', 'IMAP', 'SOLAR1'], frames: ['gse', 'gsm', 'gci'],
            unclaimed: ['active', 'cadence', 'x_gci', 'y_gci', 'z_gci', 'vx_gci', 'vy_gci', 'vz_gci',
                'vx_gse', 'vy_gse', 'vz_gse', 'vx_gsm', 'vy_gsm', 'vz_gsm'],
        },
        candidates: [
            { id: 'rtsw-ephem-1h', url: `${SWPC}/json/rtsw/rtsw_ephemerides_1h.json` },
        ],
    },
    // Rung 3 — GOES magnetometers at geosynchronous orbit, both longitudes.
    'geo-mag': {
        kind: 'geo-mag',
        label: 'GOES magnetometers (East + West)',
        upstream: 'NOAA GOES MAG',
        cadence_s: 60,
        // MEASURED 2026-11-20: all four files answer; primary = GOES-19,
        // secondary = GOES-18, 1-minute, He/Hp/Hn/total + arcjet_flag, no
        // unclaimed keys. GOES-19 had 74 arcjet-flagged minutes in 24 h —
        // the flag is not a rarity. The 1-day files are supersets of the
        // 6-hour ones, so only they are requested.
        verified: {
            on: '2026-11-20', candidate: 'goes-primary-1d+goes-secondary-1d', cadence_s: 60,
            satellites: { primary: 'GOES-19', secondary: 'GOES-18' }, arcjet_flag: true,
        },
        // Primary AND secondary are both wanted (two longitudes), so this
        // feed MERGES every candidate that answers instead of stopping.
        merge: true,
        // B4 added the 7-day files: the geo-filter learns a local-time
        // baseline and one day is too short for it. UNVERIFIED at the time of
        // writing — the merge keeps the LONGER record per satellite, so if
        // they 404 the 1-day files carry on and the route's candidate report
        // says which answered.
        candidates: [
            { id: 'goes-primary-7d',   url: `${SWPC}/json/goes/primary/magnetometers-7-day.json` },
            { id: 'goes-secondary-7d', url: `${SWPC}/json/goes/secondary/magnetometers-7-day.json` },
            { id: 'goes-primary-1d',   url: `${SWPC}/json/goes/primary/magnetometers-1-day.json` },
            { id: 'goes-secondary-1d', url: `${SWPC}/json/goes/secondary/magnetometers-1-day.json` },
        ],
    },
    // Rung 7 — does USGS serve 1-second variation data in real time, and how
    // late is it? One station, ten minutes: an existence + latency check.
    // The URL is built by `groundProbeUrl` (it needs a time window).
    'ground-1s': {
        kind: 'ground',
        label: 'USGS 1-second variation (existence + latency)',
        upstream: 'USGS Geomagnetism Program',
        cadence_s: 1,
        // MEASURED 2026-11-20: 1-second variation data IS served in real
        // time. X/Y arrived 129 s behind the clock and Z 73 s, identically at
        // BOU and FRD (a batch cadence upstream, not a station property); the
        // 60 s product was 147 s behind. So 1-second ground data is a LIVE
        // input with a ~2 min horizon.
        verified: {
            on: '2026-11-20', candidate: 'usgs-bou-1s', cadence_s: 1,
            latency_s: { horizontal: 129, vertical: 73, minute_product: 147 },
        },
        candidates: [
            { id: 'usgs-bou-1s',  station: 'BOU', samplingPeriod: 1 },
            { id: 'usgs-frd-1s',  station: 'FRD', samplingPeriod: 1 },
            { id: 'usgs-bou-60s', station: 'BOU', samplingPeriod: 60 },   // control: the cadence TIGA already uses
        ],
    },
});

export const FEED_IDS = Object.freeze(Object.keys(FEEDS));

// ── primitives ────────────────────────────────────────────────────────────

/** The ONE number reader. Gaps and fill values are null, never 0. */
export function num(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n) || Math.abs(n) >= FILL_ABS) return null;
    return n;
}

/**
 * Epoch ms of an upstream time tag, or null. SWPC writes both
 * '2026-11-20T12:34:00Z' and '2026-11-20 12:34:00.000' (no zone — it is UTC).
 */
export function timeMs(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(' ', 'T');
    if (!/(Z|[+-]\d{2}:?\d{2})$/.test(s)) s += 'Z';
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

/**
 * SWPC publishes the same table two ways: an array of objects, or a 2-D array
 * whose first row is the header. Both become an array of plain objects.
 * Anything else is [] — the caller reports it, it does not guess.
 */
export function toRecords(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    if (Array.isArray(raw[0])) {
        const head = raw[0].map(String);
        return raw.slice(1).filter(Array.isArray).map((r) => {
            const o = {};
            for (let i = 0; i < head.length; i++) o[head[i]] = r[i];
            return o;
        });
    }
    if (raw[0] && typeof raw[0] === 'object') return raw.filter((r) => r && typeof r === 'object');
    return [];
}

/** Median spacing of ascending-sorted epoch-ms values, in seconds (null if < 2). */
export function measureCadenceS(timesMs) {
    const t = timesMs.filter(Number.isFinite).slice().sort((a, b) => a - b);
    const d = [];
    for (let i = 1; i < t.length; i++) if (t[i] > t[i - 1]) d.push(t[i] - t[i - 1]);
    if (!d.length) return null;
    d.sort((a, b) => a - b);
    const m = d.length >> 1;
    return (d.length % 2 ? d[m] : 0.5 * (d[m - 1] + d[m])) / 1000;
}

/**
 * Resolve each wanted field to the first candidate key present in `keys`
 * (case-insensitive). Returns { map: field → actual key | null, unmapped }.
 */
export function resolveFields(keys, candidates) {
    const lower = new Map(keys.map((k) => [String(k).toLowerCase(), k]));
    const map = {};
    const claimed = new Set();
    for (const [field, names] of Object.entries(candidates)) {
        map[field] = null;
        for (const n of names) {
            const hit = lower.get(n.toLowerCase());
            if (hit !== undefined) { map[field] = hit; claimed.add(hit); break; }
        }
    }
    return { map, unmapped: keys.filter((k) => !claimed.has(k)) };
}

function unionKeys(records, limit = 200) {
    const seen = new Set();
    for (let i = 0; i < records.length && i < limit; i++) for (const k of Object.keys(records[i])) seen.add(k);
    // …and the last rows too: SWPC appends columns over a file's life.
    for (let i = Math.max(0, records.length - 20); i < records.length; i++) for (const k of Object.keys(records[i])) seen.add(k);
    return [...seen];
}

function round(v, p) { return v == null ? null : Math.round(v * p) / p; }

// ── L1 magnetometer ───────────────────────────────────────────────────────

export const L1_MAG_FIELDS = Object.freeze({
    time:    ['time_tag', 'time', 'timestamp'],
    source:  ['source', 'spacecraft', 'satellite'],
    active:  ['active'],
    bx_gsm:  ['bx_gsm'],
    by_gsm:  ['by_gsm'],
    bz_gsm:  ['bz_gsm'],
    bx_gse:  ['bx_gse'],
    by_gse:  ['by_gse'],
    bz_gse:  ['bz_gse'],
    bt:      ['bt', 'b_total', 'btotal'],
    quality: ['overall_quality', 'quality', 'dsflag'],
});

function truthy(v) {
    return v === true || v === 1 || v === '1' || (typeof v === 'string' && v.toLowerCase() === 'true');
}

/**
 * @param {any} raw            upstream JSON
 * @param {{ nowMs?: number, defaultSource?: string }} [opts]
 * @returns {{
 *   rows: number, spacecraft: Record<string, {
 *     n: number, cadence_s: number|null, first: string|null, last: string|null,
 *     active_fraction: number|null, bz_gsm_valid: number, bz_gse_valid: number,
 *     samples: Array<{t:number, bx_gsm,by_gsm,bz_gsm,bx_gse,by_gse,bz_gse,bt, active:boolean|null, quality:any}>
 *   }>,
 *   active_spacecraft: string|null, frames: {gsm:boolean, gse:boolean},
 *   overlap_minutes: number, field_map: object, unmapped: string[], age_s: number|null
 * }}
 */
export function normalizeL1Mag(raw, opts = {}) {
    const recs = toRecords(raw);
    const keys = unionKeys(recs);
    const { map, unmapped } = resolveFields(keys, L1_MAG_FIELDS);
    const fallbackSource = opts.defaultSource ?? 'unknown';

    const bySc = new Map();
    for (const r of recs) {
        const t = timeMs(map.time ? r[map.time] : null);
        if (t == null) continue;
        const sc = map.source && r[map.source] != null && r[map.source] !== ''
            ? String(r[map.source]).toUpperCase() : fallbackSource;
        const s = {
            t,
            bx_gsm: map.bx_gsm ? num(r[map.bx_gsm]) : null,
            by_gsm: map.by_gsm ? num(r[map.by_gsm]) : null,
            bz_gsm: map.bz_gsm ? num(r[map.bz_gsm]) : null,
            bx_gse: map.bx_gse ? num(r[map.bx_gse]) : null,
            by_gse: map.by_gse ? num(r[map.by_gse]) : null,
            bz_gse: map.bz_gse ? num(r[map.bz_gse]) : null,
            bt:     map.bt ? num(r[map.bt]) : null,
            active: map.active ? truthy(r[map.active]) : null,
            quality: map.quality ? (r[map.quality] ?? null) : null,
        };
        if (!bySc.has(sc)) bySc.set(sc, []);
        bySc.get(sc).push(s);
    }

    const spacecraft = {};
    let newest = null, activeSc = null, activeT = -Infinity;
    const minuteSets = [];
    for (const [sc, list] of bySc) {
        list.sort((a, b) => a.t - b.t);
        // A time tag published twice keeps its LAST row (SWPC re-issues).
        const dedup = [];
        for (const s of list) {
            if (dedup.length && dedup[dedup.length - 1].t === s.t) dedup[dedup.length - 1] = s;
            else dedup.push(s);
        }
        const withActive = dedup.filter((s) => s.active != null);
        const last = dedup[dedup.length - 1];
        spacecraft[sc] = {
            n: dedup.length,
            cadence_s: measureCadenceS(dedup.map((s) => s.t)),
            first: new Date(dedup[0].t).toISOString(),
            last: new Date(last.t).toISOString(),
            active_fraction: withActive.length
                ? round(withActive.filter((s) => s.active).length / withActive.length, 1000) : null,
            bz_gsm_valid: dedup.filter((s) => s.bz_gsm != null).length,
            bz_gse_valid: dedup.filter((s) => s.bz_gse != null).length,
            samples: dedup,
        };
        if (newest == null || last.t > newest) newest = last.t;
        for (let i = dedup.length - 1; i >= 0; i--) {
            if (dedup[i].active) { if (dedup[i].t > activeT) { activeT = dedup[i].t; activeSc = sc; } break; }
        }
        minuteSets.push(new Set(dedup.filter((s) => s.bz_gsm != null || s.bz_gse != null)
            .map((s) => Math.floor(s.t / 60000))));
    }

    // Minutes on which at least TWO spacecraft carry a valid Bz — the raw
    // material of the two-point fusion (plan §4.2). 0 means the file holds
    // one instrument and the fusion has nothing to fuse.
    let overlap = 0;
    if (minuteSets.length >= 2) {
        const count = new Map();
        for (const set of minuteSets) for (const m of set) count.set(m, (count.get(m) ?? 0) + 1);
        for (const c of count.values()) if (c >= 2) overlap++;
    }

    return {
        rows: [...bySc.values()].reduce((a, l) => a + l.length, 0),
        spacecraft,
        active_spacecraft: activeSc,
        frames: { gsm: !!map.bz_gsm, gse: !!map.bz_gse },
        overlap_minutes: overlap,
        field_map: map,
        unmapped,
        age_s: newest != null && Number.isFinite(opts.nowMs) ? Math.round((opts.nowMs - newest) / 1000) : null,
    };
}

// ── L1 plasma ─────────────────────────────────────────────────────────────

export const L1_PLASMA_FIELDS = Object.freeze({
    time:        ['time_tag', 'time'],
    source:      ['source', 'spacecraft', 'satellite'],
    active:      ['active'],
    speed:       ['proton_speed', 'speed', 'bulk_speed'],
    density:     ['proton_density', 'density'],
    temperature: ['proton_temperature', 'temperature'],
    vx_gse:      ['proton_vx_gse', 'vx_gse'],
    vy_gse:      ['proton_vy_gse', 'vy_gse'],
    vz_gse:      ['proton_vz_gse', 'vz_gse'],
    vx_gsm:      ['proton_vx_gsm', 'vx_gsm'],
    vy_gsm:      ['proton_vy_gsm', 'vy_gsm'],
    vz_gsm:      ['proton_vz_gsm', 'vz_gsm'],
    quality:     ['overall_quality', 'quality', 'dsflag'],
});

/** A positive physical quantity: gaps, fills, zeros and negatives are null. */
function pos(v, max) {
    const n = num0(v);
    return n != null && n > 0 && n < max ? n : null;
}

/**
 * Per-spacecraft plasma moments. Speed and density must be POSITIVE to count
 * (SWPC writes 0 and negative fills as well as -9999); temperature has its own
 * ceiling because a real 3e5 K is far above FILL_ABS.
 */
export function normalizeL1Plasma(raw, opts = {}) {
    const recs = toRecords(raw);
    const keys = unionKeys(recs);
    const { map, unmapped } = resolveFields(keys, L1_PLASMA_FIELDS);
    const bySc = new Map();
    for (const r of recs) {
        const t = timeMs(map.time ? r[map.time] : null);
        if (t == null) continue;
        const sc = map.source && r[map.source] != null && r[map.source] !== ''
            ? String(r[map.source]).toUpperCase() : (opts.defaultSource ?? 'unknown');
        const comp = (k) => { const v = map[k] ? num(r[map[k]]) : null; return v; };
        const s = {
            t,
            speed: map.speed ? pos(r[map.speed], 5000) : null,
            density: map.density ? pos(r[map.density], 1000) : null,
            temperature: map.temperature ? pos(r[map.temperature], 1e8) : null,
            vx_gse: comp('vx_gse'), vy_gse: comp('vy_gse'), vz_gse: comp('vz_gse'),
            vx_gsm: comp('vx_gsm'), vy_gsm: comp('vy_gsm'), vz_gsm: comp('vz_gsm'),
            active: map.active ? truthy(r[map.active]) : null,
        };
        if (!bySc.has(sc)) bySc.set(sc, []);
        bySc.get(sc).push(s);
    }
    const spacecraft = {};
    let newest = null, activeSc = null, activeT = -Infinity;
    for (const [sc, list] of bySc) {
        list.sort((a, b) => a.t - b.t);
        const dedup = [];
        for (const s of list) {
            if (dedup.length && dedup[dedup.length - 1].t === s.t) dedup[dedup.length - 1] = s;
            else dedup.push(s);
        }
        const last = dedup[dedup.length - 1];
        spacecraft[sc] = {
            n: dedup.length,
            cadence_s: measureCadenceS(dedup.map((s) => s.t)),
            first: new Date(dedup[0].t).toISOString(),
            last: new Date(last.t).toISOString(),
            speed_valid: dedup.filter((s) => s.speed != null).length,
            density_valid: dedup.filter((s) => s.density != null).length,
            vector_valid: dedup.filter((s) => s.vx_gse != null || s.vx_gsm != null).length,
            samples: dedup,
        };
        // newest VALID speed decides the age: a file can run on with empty rows
        for (let i = dedup.length - 1; i >= 0; i--) {
            if (dedup[i].speed != null) { if (newest == null || dedup[i].t > newest) newest = dedup[i].t; break; }
        }
        for (let i = dedup.length - 1; i >= 0; i--) {
            if (dedup[i].active) { if (dedup[i].t > activeT) { activeT = dedup[i].t; activeSc = sc; } break; }
        }
    }
    return {
        rows: [...bySc.values()].reduce((a, l) => a + l.length, 0),
        spacecraft,
        active_spacecraft: activeSc,
        vectors: { gse: !!map.vx_gse, gsm: !!map.vx_gsm },
        field_map: map,
        unmapped,
        age_s: newest != null && Number.isFinite(opts.nowMs) ? Math.round((opts.nowMs - newest) / 1000) : null,
    };
}

// ── GOES magnetometer ─────────────────────────────────────────────────────

export const GEO_MAG_FIELDS = Object.freeze({
    time:      ['time_tag', 'time'],
    satellite: ['satellite', 'spacecraft', 'source'],
    he:        ['He', 'he'],
    hp:        ['Hp', 'hp'],
    hn:        ['Hn', 'hn'],
    total:     ['total', 'Total', 'ht'],
    arcjet:    ['arcjet_flag', 'arcjet'],
});

/**
 * GOES field in the spacecraft's own E/P/N frame, exactly as published
 * (P ≈ parallel to Earth's spin axis, E earthward, N eastward — the rotation
 * to GSM needs the satellite longitude and is js/bz/geo-residual.js, phase B3).
 * An arcjet-flagged sample is KEPT and flagged, never dropped silently: the
 * consumer must exclude it from any score (plan §9).
 */
export function normalizeGeoMag(raw, opts = {}) {
    const recs = toRecords(raw);
    const keys = unionKeys(recs);
    const { map, unmapped } = resolveFields(keys, GEO_MAG_FIELDS);
    const bySat = new Map();
    for (const r of recs) {
        const t = timeMs(map.time ? r[map.time] : null);
        if (t == null) continue;
        const sat = map.satellite && r[map.satellite] != null && r[map.satellite] !== ''
            ? `GOES-${String(r[map.satellite]).replace(/^goes[- ]?/i, '')}` : (opts.defaultSatellite ?? 'unknown');
        const s = {
            t,
            he: map.he ? num(r[map.he]) : null,
            hp: map.hp ? num(r[map.hp]) : null,
            hn: map.hn ? num(r[map.hn]) : null,
            total: map.total ? num(r[map.total]) : null,
            arcjet: map.arcjet ? truthy(r[map.arcjet]) : null,
        };
        if (!bySat.has(sat)) bySat.set(sat, []);
        bySat.get(sat).push(s);
    }
    const satellites = {};
    let newest = null;
    for (const [sat, list] of bySat) {
        list.sort((a, b) => a.t - b.t);
        const last = list[list.length - 1];
        satellites[sat] = {
            n: list.length,
            cadence_s: measureCadenceS(list.map((s) => s.t)),
            first: new Date(list[0].t).toISOString(),
            last: new Date(last.t).toISOString(),
            hp_valid: list.filter((s) => s.hp != null).length,
            arcjet_flagged: list.filter((s) => s.arcjet === true).length,
            samples: list,
        };
        if (newest == null || last.t > newest) newest = last.t;
    }
    return {
        rows: [...bySat.values()].reduce((a, l) => a + l.length, 0),
        satellites,
        field_map: map,
        unmapped,
        age_s: newest != null && Number.isFinite(opts.nowMs) ? Math.round((opts.nowMs - newest) / 1000) : null,
    };
}

/** Merge several normalizeGeoMag results (primary + secondary) by satellite. */
export function mergeGeoMag(parts, opts = {}) {
    const satellites = {};
    const field_map = {};
    const unmapped = new Set();
    let newest = null;
    for (const p of parts) {
        for (const [sat, v] of Object.entries(p.satellites)) {
            // The 6-hour and 1-day files overlap: keep the longer record.
            if (!satellites[sat] || v.n > satellites[sat].n) satellites[sat] = v;
        }
        for (const [k, v] of Object.entries(p.field_map)) if (v != null || !(k in field_map)) field_map[k] = v ?? field_map[k] ?? null;
        for (const u of p.unmapped) unmapped.add(u);
    }
    for (const v of Object.values(satellites)) {
        const t = Date.parse(v.last);
        if (newest == null || t > newest) newest = t;
    }
    return {
        rows: Object.values(satellites).reduce((a, s) => a + s.n, 0),
        satellites,
        field_map,
        unmapped: [...unmapped],
        age_s: newest != null && Number.isFinite(opts.nowMs) ? Math.round((opts.nowMs - newest) / 1000) : null,
    };
}

// ── L1 ephemerides ────────────────────────────────────────────────────────

export const EPHEM_FIELDS = Object.freeze({
    time:   ['time_tag', 'time'],
    source: ['source', 'spacecraft', 'satellite'],
    x_gse:  ['x_gse', 'gse_x', 'xgse'],
    y_gse:  ['y_gse', 'gse_y', 'ygse'],
    z_gse:  ['z_gse', 'gse_z', 'zgse'],
    x_gsm:  ['x_gsm', 'gsm_x', 'xgsm'],
    y_gsm:  ['y_gsm', 'gsm_y', 'ygsm'],
    z_gsm:  ['z_gsm', 'gsm_z', 'zgsm'],
});

const RE_KM = 6371.2;

/**
 * Spacecraft positions. The UNIT is not known in advance (SWPC has published
 * both km and R_E), so it is INFERRED from the magnitude and reported:
 * L1 is ~1.5e6 km = ~235 R_E, and nothing in between is plausible.
 */
export function normalizeEphem(raw, opts = {}) {
    const recs = toRecords(raw);
    const keys = unionKeys(recs);
    const { map, unmapped } = resolveFields(keys, EPHEM_FIELDS);
    const frame = map.x_gse ? 'gse' : (map.x_gsm ? 'gsm' : null);
    const bySc = new Map();
    for (const r of recs) {
        const t = timeMs(map.time ? r[map.time] : null);
        if (t == null || !frame) continue;
        const x = num0(r[map[`x_${frame}`]]), y = num0(r[map[`y_${frame}`]]), z = num0(r[map[`z_${frame}`]]);
        if (x == null || y == null || z == null) continue;
        const sc = map.source && r[map.source] != null && r[map.source] !== ''
            ? String(r[map.source]).toUpperCase() : (opts.defaultSource ?? 'unknown');
        if (!bySc.has(sc)) bySc.set(sc, []);
        bySc.get(sc).push({ t, x, y, z });
    }
    const spacecraft = {};
    let newest = null;
    for (const [sc, list] of bySc) {
        list.sort((a, b) => a.t - b.t);
        const last = list[list.length - 1];
        const r = Math.hypot(last.x, last.y, last.z);
        const unit = r > 5e4 ? 'km' : (r > 50 && r < 1000 ? 'Re' : 'unknown');
        const k = unit === 'km' ? 1 / RE_KM : 1;
        spacecraft[sc] = {
            n: list.length,
            cadence_s: measureCadenceS(list.map((s) => s.t)),
            last: new Date(last.t).toISOString(),
            unit_inferred: unit,
            last_re: unit === 'unknown' ? null
                : { x: round(last.x * k, 100), y: round(last.y * k, 100), z: round(last.z * k, 100) },
            samples: list,
        };
        if (newest == null || last.t > newest) newest = last.t;
    }
    // Pairwise separations at each spacecraft's latest position, R_E, in the
    // file's frame — what makes a multi-point phase-front fit well or badly
    // conditioned (plan §9). EVERY pair: with three spacecraft the baselines
    // are very unequal (measured 2026-11-20: ACE–SOLAR1 ~98 R_E, mostly
    // across the Sun–Earth line; IMAP–SOLAR1 ~17 R_E).
    const withPos = Object.entries(spacecraft).filter(([, s]) => s.last_re);
    const separations_re = [];
    for (let i = 0; i < withPos.length; i++) {
        for (let j = i + 1; j < withPos.length; j++) {
            const a = withPos[i][1].last_re, c = withPos[j][1].last_re;
            separations_re.push({
                pair: [withPos[i][0], withPos[j][0]],
                dx: round(a.x - c.x, 100), dy: round(a.y - c.y, 100), dz: round(a.z - c.z, 100),
                r: round(Math.hypot(a.x - c.x, a.y - c.y, a.z - c.z), 100),
            });
        }
    }
    const separation_re = separations_re[0] ?? null;
    return {
        rows: [...bySc.values()].reduce((a, l) => a + l.length, 0),
        spacecraft, frame, separation_re, separations_re, field_map: map, unmapped,
        age_s: newest != null && Number.isFinite(opts.nowMs) ? Math.round((opts.nowMs - newest) / 1000) : null,
    };
}

/** Positions are ~1.5e6 km, far above FILL_ABS, so they need their own reader. */
function num0(v) {
    if (v == null || v === '') return null;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && Math.abs(n) < 1e9 ? n : null;
}

// ── USGS ground ───────────────────────────────────────────────────────────

/** ISO second, `secondsBefore` before `nowMs`. */
function isoSecond(nowMs, secondsBefore) {
    return new Date(Math.floor((nowMs - secondsBefore * 1000) / 1000) * 1000)
        .toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The probe URL for a ground candidate. Built ONLY from the catalogue's own
 * station code and sampling period — there is no passthrough parameter.
 */
export function groundProbeUrl(candidate, nowMs, windowS = 600) {
    const sp = candidate.samplingPeriod === 1 ? 1 : 60;
    const win = sp === 1 ? windowS : Math.max(windowS, 3600);
    return `${USGS}?id=${encodeURIComponent(candidate.station)}`
        + `&type=variation&elements=X,Y,Z&sampling_period=${sp}&format=json`
        + `&starttime=${encodeURIComponent(isoSecond(nowMs, win))}`
        + `&endtime=${encodeURIComponent(isoSecond(nowMs, 0))}`;
}

/**
 * One USGS IAGA-JSON payload → cadence, completeness and LATENCY. Latency is
 * (now − newest NON-NULL sample): USGS pads the requested window with nulls
 * up to "now", so the last time tag says nothing about how late the data is.
 */
export function normalizeGround(payload, opts = {}) {
    const times = Array.isArray(payload?.times) ? payload.times.map(timeMs) : [];
    const series = Array.isArray(payload?.values) ? payload.values : [];
    const elements = {};
    let newestValid = null;
    for (const s of series) {
        const id = String(s?.id ?? s?.metadata?.element ?? '').toUpperCase();
        const vals = Array.isArray(s?.values) ? s.values : [];
        if (!id) continue;
        let valid = 0, lastIdx = -1;
        // IAGA fill values are 99999 / 88888; USGS JSON normally sends null.
        for (let i = 0; i < vals.length; i++) {
            const v = num0(vals[i]);
            if (v != null && Math.abs(v) < 88888) { valid++; lastIdx = i; }
        }
        elements[id] = { n: vals.length, valid,
            latency_s: lastIdx >= 0 && times[lastIdx] != null && Number.isFinite(opts.nowMs)
                ? Math.round((opts.nowMs - times[lastIdx]) / 1000) : null };
        if (lastIdx >= 0 && times[lastIdx] != null && (newestValid == null || times[lastIdx] > newestValid)) newestValid = times[lastIdx];
    }
    const n = times.length;
    const x = elements.X ?? elements.H ?? null;
    return {
        rows: n,
        station: payload?.metadata?.station?.id ?? opts.station ?? null,
        cadence_s: measureCadenceS(times.filter((t) => t != null)),
        elements,
        completeness: x && x.n ? round(x.valid / x.n, 1000) : null,
        newest_valid: newestValid != null ? new Date(newestValid).toISOString() : null,
        // The HORIZONTAL component's latency: X/Y and Z arrive on different
        // delays (measured), and dB/dt and the equivalent currents need X/Y.
        latency_s: x?.latency_s ?? null,
        age_s: newestValid != null && Number.isFinite(opts.nowMs) ? Math.round((opts.nowMs - newestValid) / 1000) : null,
    };
}

// ── dispatch + the candidate report ───────────────────────────────────────

/** Normalise `raw` for a feed kind. Throws on an unknown kind (a code bug). */
export function normalizeFeed(kind, raw, opts = {}) {
    switch (kind) {
        case 'l1-mag':  return normalizeL1Mag(raw, opts);
        case 'l1-plasma': return normalizeL1Plasma(raw, opts);
        case 'geo-mag': return normalizeGeoMag(raw, opts);
        case 'ephem':   return normalizeEphem(raw, opts);
        case 'ground':  return normalizeGround(raw, opts);
        default: throw new Error(`unknown feed kind: ${kind}`);
    }
}

/** The candidate's fetch URL (ground candidates need the clock). */
export function candidateUrl(feed, candidate, nowMs) {
    return feed.kind === 'ground' ? groundProbeUrl(candidate, nowMs) : candidate.url;
}

/**
 * Strip the per-sample arrays out of a normalised result — what `meta=1`
 * and the browser probe print. Everything that settles the schema stays.
 */
export function summarize(norm) {
    const out = { ...norm };
    for (const group of ['spacecraft', 'satellites']) {
        if (!norm[group]) continue;
        out[group] = {};
        for (const [k, v] of Object.entries(norm[group])) {
            const { samples, ...rest } = v;
            out[group][k] = { ...rest, latest: samples?.length ? samples[samples.length - 1] : null };
        }
    }
    return out;
}

/**
 * One candidate's row in the report.
 * @param {{ ok:boolean, status:number|null, contentType?:string|null, error?:string|null, body?:any }} res
 */
export function candidateReport(feed, candidate, res, nowMs) {
    const row = {
        id: candidate.id,
        ok: false,
        http_status: res.status ?? null,
        content_type: res.contentType ?? null,
        error: res.error ?? null,
        rows: 0,
    };
    if (!res.ok || res.body == null) return row;
    try {
        const norm = normalizeFeed(feed.kind, res.body, { nowMs, station: candidate.station });
        row.rows = norm.rows;
        row.ok = norm.rows > 0;
        if (!row.ok) row.error = 'parsed, but no rows with a time tag';
        row.summary = summarize(norm);
    } catch (e) {
        row.error = `normalise: ${String(e?.message ?? e).slice(0, 120)}`;
    }
    return row;
}

/**
 * Freshness of a normalised result against its feed's cadence:
 * 'fresh' within max(10·cadence, 15 min), 'stale' within 6 h, else 'expired'.
 * No rows / unknown age is 'expired' — a 200 must never read as healthy.
 */
export function feedFreshness(feed, norm) {
    if (!norm || !norm.rows || norm.age_s == null) return 'expired';
    const freshS = Math.max(10 * feed.cadence_s, 15 * 60);
    if (norm.age_s <= freshS) return 'fresh';
    return norm.age_s <= 6 * 3600 ? 'stale' : 'expired';
}

/**
 * Run a feed end to end with an injected fetch. Used by the edge route, by
 * scripts/probe-bz-feeds.mjs and, browser-direct, by any page.
 *
 * @param {string} feedId
 * @param {{ fetchJson: (url:string) => Promise<{ok:boolean,status:number|null,contentType?:string|null,error?:string|null,body?:any}>,
 *           nowMs: number, meta?: boolean }} deps
 * @returns {Promise<{ feed:string, source_id:string|null, data:any|null,
 *                     candidates:Array, freshness:string, reasons:string[] }>}
 */
export async function runFeed(feedId, { fetchJson, nowMs, meta = false }) {
    const feed = FEEDS[feedId];
    if (!feed) throw new Error(`unknown feed: ${feedId}`);
    const probeAll = meta || feed.merge;
    const reports = [];
    const norms = [];
    const fetchOne = async (c) => {
        let res;
        try { res = await fetchJson(candidateUrl(feed, c, nowMs)); }
        catch (e) { res = { ok: false, status: null, error: String(e?.message ?? e).slice(0, 120) }; }
        const rep = candidateReport(feed, c, res, nowMs);
        let norm = null;
        if (rep.ok) norm = normalizeFeed(feed.kind, res.body, { nowMs, station: c.station });
        return { rep, norm };
    };

    if (probeAll) {
        const all = await Promise.all(feed.candidates.map(fetchOne));
        for (const { rep, norm } of all) { reports.push(rep); if (norm) norms.push({ id: rep.id, norm }); }
    } else {
        for (const c of feed.candidates) {
            const { rep, norm } = await fetchOne(c);
            reports.push(rep);
            if (norm) { norms.push({ id: rep.id, norm }); break; }
        }
    }

    let data = null, sourceId = null;
    if (norms.length) {
        if (feed.merge && feed.kind === 'geo-mag') {
            data = mergeGeoMag(norms.map((n) => n.norm), { nowMs });
            sourceId = norms.map((n) => n.id).join('+');
        } else {
            data = norms[0].norm;
            sourceId = norms[0].id;
        }
    }
    const freshness = feedFreshness(feed, data);
    const reasons = [];
    if (!data) reasons.push('no_candidate_answered');
    else if (freshness !== 'fresh') reasons.push(`newest_sample_${data.age_s}s_old`);
    return { feed: feedId, source_id: sourceId, data, candidates: reports, freshness, reasons };
}
