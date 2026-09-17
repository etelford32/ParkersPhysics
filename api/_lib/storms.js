/**
 * api/_lib/storms.js — PURE kernel for the global tropical-cyclone feed.
 *
 * Extracted from api/storms.js (2026-09) so the normalisation AND the
 * feed-health assessment are node-testable without an edge runtime or a
 * live upstream. `api/storms.js` keeps the fetching; everything that
 * decides what the payload MEANS lives here. Gate: tests/storms-feed.mjs.
 *
 * ── WHY THE HEALTH ASSESSMENT IS THE POINT ────────────────────────────
 * Two feeds cover disjoint halves of the planet:
 *
 *   NHC   → ATLANTIC, EPAC, CPAC   (authoritative; pressure + official
 *                                   movement)
 *   EONET → WPAC, IO, SH           (JTWC-sourced; the only keyless public
 *                                   JSON carrying the other hemisphere)
 *
 * So "no storms" is THREE different claims wearing one face:
 *   1. both feeds answered, genuinely nothing active  → a real quiet spell
 *   2. one feed died                                  → half the planet unseen
 *   3. both died                                      → we know nothing
 *
 * Until 2026-09 all three rendered identically: 200, `count: 0`, a fresh
 * `updated` stamp, and a UI that said "No active tropical cyclones
 * worldwide right now. 🌊". That is a POSITIVE CLAIM OF ABSENCE built on
 * no data, and it is what the "storm watch isn't showing up" report
 * actually was — the panel looked broken because a dead feed and a quiet
 * ocean are the same picture. It also scored GREEN on status.html, since
 * a 200 with no top-level freshness is healthy by default (CLAUDE.md §8).
 *
 * `assessFeed()` is the fix: it turns the two upstream outcomes into a
 * top-level `freshness` the whole stack reads, and NAMES the basins that
 * went dark. Partial coverage is the dangerous case and gets its own
 * state — an Atlantic-only list during a West Pacific super typhoon is
 * worse than an empty one, because it looks complete.
 *
 * Nothing here fetches, reads a clock it wasn't handed, or throws.
 */

// Classification codes used by NHC and JTWC
export const CLASSIFICATIONS = new Set(['TD', 'TS', 'HU', 'TY', 'STY', 'TC', 'MH', 'SD', 'SS', 'EX']);

// NHC codes that need remapping into the client vocabulary
const NHC_CLASS_REMAP = { PTC: 'EX', PC: 'TD', STD: 'SD', STS: 'SS' };

// Which basins each upstream is the ONLY source for. Drives the
// disclosure text when one of them drops — the client names these to the
// user so a half-world list can never read as a whole-world list.
export const BASIN_COVERAGE = Object.freeze({
    nhc:   Object.freeze(['ATLANTIC', 'EPAC', 'CPAC']),
    eonet: Object.freeze(['WPAC', 'IO', 'SH']),
});

export const BASIN_LABEL = Object.freeze({
    ATLANTIC: 'Atlantic',
    EPAC:     'East Pacific',
    CPAC:     'Central Pacific',
    WPAC:     'West Pacific',
    IO:       'Indian Ocean',
    SH:       'Southern Hemisphere',
    UNKNOWN:  'Unknown basin',
});

// Ignore events whose newest track point is older than this — EONET
// occasionally keeps dissipated systems "open" for days.
export const EONET_MAX_AGE_MS = 48 * 3600 * 1000;

// ── Shared helpers ───────────────────────────────────────────────────────────

/** "15.4N" / "113.5W" → signed float, or null. */
export function parseCoord(str) {
    if (typeof str !== 'string') return null;
    const m = str.trim().match(/^(-?\d+(?:\.\d+)?)\s*([NSEW])?$/i);
    if (!m) return null;
    let v = parseFloat(m[1]);
    const h = (m[2] || '').toUpperCase();
    if (h === 'S' || h === 'W') v = -Math.abs(v);
    return Number.isFinite(v) ? v : null;
}

/** Great-circle distance in nautical miles. */
export function distanceNm(lat1, lon1, lat2, lon2) {
    const R = 3440.065; // Earth radius, nm
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

/** Initial great-circle bearing, degrees 0–360 (0 = N, 90 = E). */
export function bearingDeg(lat1, lon1, lat2, lon2) {
    const toRad = d => d * Math.PI / 180;
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// ── NHC (Atlantic / East+Central Pacific) ────────────────────────────────────

/**
 * CRITICAL — NHC field names: CurrentStorms.json provides
 * `latitudeNumeric`/`longitudeNumeric` (numbers), `latitude`/`longitude`
 * (strings like "15.4N"), and camelCase `movementDir`/`movementSpeed`.
 * There are NO `lat`/`lon`/`movement_dir` fields. A previous version of
 * this parser read those non-existent names, so the filter dropped every
 * storm and the watch list was permanently empty. Verified against the
 * live feed 2026-07-15 (TS Elida, EP5).
 */
export function parseNHCStorms(data) {
    const raw = data?.activeStorms ?? [];
    if (!Array.isArray(raw)) return [];
    return raw
        .map(s => {
            const lat = Number.isFinite(s.latitudeNumeric)
                ? s.latitudeNumeric : parseCoord(s.latitude);
            const lon = Number.isFinite(s.longitudeNumeric)
                ? s.longitudeNumeric : parseCoord(s.longitude);
            if (lat == null || lon == null) return null;

            const rawClass = String(s.classification ?? '').toUpperCase();
            const classification = CLASSIFICATIONS.has(rawClass)
                ? rawClass
                : (NHC_CLASS_REMAP[rawClass] ?? 'TS');

            // Basin from the storm id prefix: al012026 / ep052026 / cp022026
            const prefix = String(s.id ?? '').slice(0, 2).toLowerCase();
            const basin = { al: 'ATLANTIC', ep: 'EPAC', cp: 'CPAC' }[prefix] ?? 'UNKNOWN';

            return {
                id:             s.id ?? 'unknown',
                name:           s.name ?? 'Unnamed',
                basin,
                classification,
                lat,
                lon,
                intensityKt:    parseInt(s.intensity, 10) || 35,
                pressureHpa:    s.pressure ? parseInt(s.pressure, 10) : null,
                movementDir:    Number.isFinite(s.movementDir) ? s.movementDir
                                  : parseInt(s.movementDir, 10) || 0,
                movementKt:     Number.isFinite(s.movementSpeed) ? s.movementSpeed
                                  : parseInt(s.movementSpeed, 10) || 0,
                hemisphere:     lat >= 0 ? 'N' : 'S',
                source:         'nhc',
                lastUpdate:     s.lastUpdate ?? null,
            };
        })
        .filter(Boolean);
}

// ── EONET (global, JTWC-sourced) ─────────────────────────────────────────────

// "Super Typhoon Bavi" → { classification: 'STY', name: 'Bavi' }
const EONET_TITLE_CLASSES = [
    [/^super\s+typhoon\s+/i,       'STY'],
    [/^typhoon\s+/i,               'TY'],
    [/^major\s+hurricane\s+/i,     'MH'],
    [/^hurricane\s+/i,             'HU'],
    [/^tropical\s+storm\s+/i,      'TS'],
    [/^tropical\s+depression\s+/i, 'TD'],
    [/^subtropical\s+storm\s+/i,   'SS'],
    [/^tropical\s+cyclone\s+/i,    'TC'],
    [/^cyclone\s+/i,               'TC'],
];

export function classifyEONETTitle(title) {
    for (const [re, code] of EONET_TITLE_CLASSES) {
        if (re.test(title)) return { classification: code, name: title.replace(re, '').trim() };
    }
    return { classification: 'TS', name: title.trim() };
}

/** Basin from the JTWC product URL (wp0926.tcw → WPAC), else from position. */
export function eonetBasin(sources, lat, lon) {
    for (const src of sources ?? []) {
        const m = String(src.url ?? '').match(/\/(al|ep|cp|wp|io|sh)\d+/i);
        if (m) {
            return { al: 'ATLANTIC', ep: 'EPAC', cp: 'CPAC',
                     wp: 'WPAC', io: 'IO', sh: 'SH' }[m[1].toLowerCase()];
        }
    }
    if (lat < 0) return 'SH';
    const e = ((lon % 360) + 360) % 360;             // 0–360 east
    if (e >= 100 && e < 200) return 'WPAC';
    if (e >= 30  && e < 100) return 'IO';
    if (e >= 200 && e < 240) return 'CPAC';
    if (e >= 240 && e < 290) return 'EPAC';
    return 'ATLANTIC';
}

export function parseEONETStorms(data, nowMs) {
    const events = data?.events ?? [];
    if (!Array.isArray(events)) return [];
    const out = [];

    for (const ev of events) {
        const pts = (ev.geometry ?? [])
            .filter(g => g.type === 'Point' && Array.isArray(g.coordinates))
            .map(g => ({
                lon: g.coordinates[0],
                lat: g.coordinates[1],
                t:   Date.parse(g.date),
                kt:  Number.isFinite(g.magnitudeValue) ? g.magnitudeValue : null,
            }))
            .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t))
            .sort((a, b) => a.t - b.t);

        if (!pts.length) continue;
        const last = pts[pts.length - 1];
        if (nowMs - last.t > EONET_MAX_AGE_MS) continue;   // dissipated / stale

        // Movement from the last two distinct points (JTWC points are 6 h apart)
        let movementDir = 0, movementKt = 0;
        for (let i = pts.length - 2; i >= 0; i--) {
            const prev = pts[i];
            const dtH = (last.t - prev.t) / 3600e3;
            if (dtH <= 0) continue;
            const nm = distanceNm(prev.lat, prev.lon, last.lat, last.lon);
            if (nm < 1) continue;                          // stationary fix
            movementDir = Math.round(bearingDeg(prev.lat, prev.lon, last.lat, last.lon));
            movementKt  = Math.round(nm / dtH);
            break;
        }

        // Latest known intensity anywhere on the track (some points omit it)
        let intensityKt = last.kt;
        if (intensityKt == null) {
            for (let i = pts.length - 2; i >= 0 && intensityKt == null; i--) {
                intensityKt = pts[i].kt;
            }
        }

        const { classification, name } = classifyEONETTitle(String(ev.title ?? 'Unnamed'));

        out.push({
            id:             ev.id ?? 'eonet-unknown',
            name,
            basin:          eonetBasin(ev.sources, last.lat, last.lon),
            classification,
            lat:            last.lat,
            lon:            last.lon,
            intensityKt:    intensityKt ?? 35,
            pressureHpa:    null,                          // EONET carries no pressure
            movementDir,
            movementKt,
            hemisphere:     last.lat >= 0 ? 'N' : 'S',
            source:         'eonet',
            lastUpdate:     new Date(last.t).toISOString(),
        });
    }
    return out;
}

// ── Merge ────────────────────────────────────────────────────────────────────

/** NHC wins on overlap: same name (case-insensitive) or within ~3° great circle. */
export function mergeStorms(nhc, eonet) {
    const names = new Set(nhc.map(s => s.name.toLowerCase()));
    const merged = [...nhc];
    for (const s of eonet) {
        if (names.has(s.name.toLowerCase())) continue;
        const dup = nhc.some(n =>
            Math.abs(n.lat - s.lat) < 3 &&
            Math.abs(((n.lon - s.lon + 540) % 360) - 180) < 3);
        if (dup) continue;
        merged.push(s);
    }
    return merged.sort((a, b) => b.intensityKt - a.intensityKt);
}

// ── Feed health ──────────────────────────────────────────────────────────────

/** Join basin codes into prose: "Atlantic, East Pacific and Central Pacific". */
function basinProse(codes) {
    const names = codes.map(c => BASIN_LABEL[c] ?? c);
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Turn the two upstream outcomes into the payload's health block.
 *
 * @param {{ok:boolean, count:number, error?:string}} nhc
 * @param {{ok:boolean, count:number, error?:string}} eonet
 * @returns {{freshness:'live'|'degraded'|'stale', coverage:number,
 *            missingBasins:string[], note:string|null}}
 *
 * `coverage` is the fraction of the two independent sources that
 * answered — deliberately NOT a fraction of storms found, because the
 * denominator there is exactly the thing we cannot observe when a feed
 * is down. `missingBasins` is what the UI needs to say something true.
 */
export function assessFeed(nhc, eonet) {
    const nhcOk   = !!nhc?.ok;
    const eonetOk = !!eonet?.ok;
    const okCount = (nhcOk ? 1 : 0) + (eonetOk ? 1 : 0);

    const missingBasins = [
        ...(nhcOk   ? [] : BASIN_COVERAGE.nhc),
        ...(eonetOk ? [] : BASIN_COVERAGE.eonet),
    ];

    if (okCount === 2) {
        return { freshness: 'live', coverage: 1, missingBasins: [], note: null };
    }
    if (okCount === 0) {
        return {
            freshness: 'stale',
            coverage: 0,
            missingBasins,
            // Both down: the empty list means NOTHING. Say so in the
            // payload so no consumer has to infer it from count === 0.
            note: 'Both upstream cyclone feeds (NOAA NHC and NASA EONET) are unreachable — '
                + 'this list is empty because nothing could be read, not because no storms are active.',
        };
    }
    // Exactly one source answered. The list is real but PARTIAL, and a
    // partial list is the dangerous case: it looks complete.
    const deadLabel = nhcOk ? 'NASA EONET' : 'NOAA NHC';
    return {
        freshness: 'degraded',
        coverage: 0.5,
        missingBasins,
        note: `${deadLabel} is unreachable — ${basinProse(missingBasins)} `
            + 'cyclones are missing from this list.',
    };
}

/**
 * Build the whole response body from already-fetched upstream results.
 * Kept pure (nowMs is injected) so tests can pin the EONET age filter.
 *
 * @param {{ok:boolean, data?:any, error?:string}} nhcRes
 * @param {{ok:boolean, data?:any, error?:string}} eonetRes
 * @param {number} nowMs
 */
export function buildStormsPayload(nhcRes, eonetRes, nowMs) {
    const nhcStorms   = nhcRes?.ok   ? parseNHCStorms(nhcRes.data)              : [];
    const eonetStorms = eonetRes?.ok ? parseEONETStorms(eonetRes.data, nowMs)   : [];
    const storms      = mergeStorms(nhcStorms, eonetStorms);

    const sources = {
        nhc: {
            ok: !!nhcRes?.ok, count: nhcStorms.length,
            ...(nhcRes?.ok ? {} : { error: nhcRes?.error ?? 'unreachable' }),
        },
        eonet: {
            ok: !!eonetRes?.ok, count: eonetStorms.length,
            ...(eonetRes?.ok ? {} : { error: eonetRes?.error ?? 'unreachable' }),
        },
    };

    const health = assessFeed(sources.nhc, sources.eonet);

    return {
        // `updated` is when WE ASKED, not when the data was observed —
        // it stays honest only because `freshness` travels beside it.
        updated: new Date(nowMs).toISOString(),
        count:   storms.length,
        freshness:     health.freshness,
        coverage:      health.coverage,
        missingBasins: health.missingBasins,
        ...(health.note ? { note: health.note } : {}),
        storms,
        sources,
    };
}
