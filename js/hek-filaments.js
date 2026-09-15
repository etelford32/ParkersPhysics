/**
 * js/hek-filaments.js — normalize HEK filament / prominence detections.
 *
 * PURE. No fetch, no edge APIs, no ambient time — so /api/hek/filaments,
 * sun.html and tests/hek-filaments.mjs all run exactly the same code.
 *
 * IT LIVES IN js/ AND NOT IN api/_lib/ FOR A REASON. `api/` is the serverless
 * function directory: Vercel (and dev-server.mjs) do not serve it as static
 * files, so a browser `import './api/_lib/…'` is a 404 — and because sun.html
 * is one module, that 404 takes the WHOLE PAGE down, not just the feature. It
 * cost a full browser-suite run to find, as a boot timeout rather than as an
 * error. The repo's own convention is this one: the shared kernel lives in
 * `js/` and the edge route imports it (see api/_lib/neo-sources.js →
 * js/neo-orbits.js, and twenty other routes).
 *
 * ── Why this feed exists ──────────────────────────────────────────────────
 *
 * sun.html's volumetric corona wanted a COOL-MATERIAL channel: the dark
 * filaments you see on the disk in 171/193/211 and the bright prominences you
 * see off the limb in 304 are the same plasma, and a raymarcher that carries
 * it as a density gets both for free — absorption on the disk, emission at the
 * limb, with real occlusion and parallax.
 *
 * The obvious source was the PFSS-lite atlas: real prominence material
 * collects in MAGNETIC DIPS, so fill the channel where the traced lines dip.
 * That was measured (rust-sunfield `examples/dip_scan.rs`, 2026-09-15) and the
 * field has **ZERO dips** — not few, none — in every configuration tried: one
 * α region, one δ-spot region, three planted ARs, and two adjacent
 * opposite-polarity regions, which is the classic filament-channel geometry.
 *
 * That is not a bug in the tracer. It is what a POTENTIAL field is. Dips deep
 * enough to hold material against gravity require field-aligned currents —
 * shear or twist — which is precisely why every prominence model is
 * non-potential (Kuperus & Raadu 1974's flux rope; Antiochos' sheared arcade).
 * A potential-field extrapolation cannot produce them, and a channel filled
 * from its dips would be permanently empty.
 *
 * So the channel is filled from OBSERVATIONS instead, which is strictly more
 * honest than dips in a field that has none: HEK's automated filament and
 * prominence detections give real positions, real lengths and real
 * orientations, and the page says which detector supplied them.
 *
 * ── Schema confidence, and where it runs out ──────────────────────────────
 *
 * www.lmsal.com is egress-blocked from this repo's build environment, so the
 * usual rule applies (see api/_lib/noaa-regions.js): every field resolves from
 * a CANDIDATE LIST and the route self-reports `field_map` / `unmapped_keys`,
 * so one production request settles the schema instead of a guess failing
 * silently. Two things temper that here:
 *
 *   • The POSITION fields are already proven. /api/hek/coronal-holes has been
 *     in production against this same endpoint using `hgs_x` / `hgs_y` /
 *     `hgc_x` / `hgc_y` / `frm_name` / `event_starttime`, so those names are
 *     known-good and lead their candidate lists.
 *   • The FILAMENT-SPECIFIC fields (`fi_length`, `fi_tilt`, `fi_chirality`)
 *     are NOT verified. A wrong `fi_tilt` only ROTATES a filament in place,
 *     which is a far smaller error than a wrong position; a wrong `fi_length`
 *     is caught by the sanity clamp below.
 *
 * ── Units, and the clamp that catches a unit mistake ──────────────────────
 *
 * HEK's spatial quantities are arcseconds, so a length converts through the
 * solar radius in arcsec (R_SUN_ARCSEC). Real filaments run 50 000–800 000 km,
 * i.e. 4°–66° of arc. `LENGTH_CLAMP_DEG` accepts 2°–80° and the result reports
 * `length_clamped` — a detector publishing Mm instead of arcsec would land
 * every row on a clamp bound, which shows up as a count rather than as a sky
 * full of identical filaments.
 */

/** Solar radius as seen from 1 AU, arcseconds. */
export const R_SUN_ARCSEC = 959.63;

/** Filament angular length is clamped to this range; the count is reported. */
export const LENGTH_CLAMP_DEG = Object.freeze({ min: 2, max: 80 });

/**
 * HEK event types this feed accepts.
 *   FI — filament (the cool structure seen dark on the disk)
 *   FA — filament activation
 *   PG — prominence (the same structure seen bright off the limb)
 * Both names describe the same plasma; which one a detector emits depends on
 * where the structure happens to be, which is exactly why the renderer treats
 * them as one channel.
 */
export const EVENT_TYPES = Object.freeze(['FI', 'FA', 'PG']);

/**
 * Candidate upstream keys per output field, most-expected first.
 * The first four are proven in production by /api/hek/coronal-holes.
 */
export const FIELD_CANDIDATES = Object.freeze({
    lat_deg:             ['hgs_y', 'hgs_lat', 'event_coord2'],
    lon_deg:             ['hgs_x', 'hgs_lon', 'event_coord1'],
    lon_carrington_deg:  ['hgc_x', 'hgc_lon'],
    lat_carrington_deg:  ['hgc_y', 'hgc_lat'],
    frm_name:            ['frm_name', 'frm_identifier', 'frm_humanflag'],
    time:                ['event_starttime', 'event_peaktime', 'kb_archivdate'],
    event_type:          ['event_type', 'eventtype'],
    // Unverified — see the header.
    length_arcsec:       ['fi_length', 'fl_length', 'event_length', 'length'],
    tilt_deg:            ['fi_tilt', 'event_tilt', 'tilt'],
    chirality:           ['fi_chirality', 'chirality'],
    // Some detectors publish a spine or bounding chain-code as WKT. Resolved
    // so it shows up in field_map when present; not parsed yet (recorded in
    // the plan as the obvious upgrade once we can see a real payload).
    boundcc:             ['hgs_boundcc', 'hpc_boundcc', 'hgs_bbox'],
});

const NUMERIC_FIELDS = new Set([
    'lat_deg', 'lon_deg', 'lon_carrington_deg', 'lat_carrington_deg',
    'length_arcsec', 'tilt_deg', 'chirality',
]);

/** First candidate key actually present (not null/undefined/'') on a row. */
function resolveKey(row, candidates) {
    for (const key of candidates) {
        const v = row?.[key];
        if (v !== undefined && v !== null && v !== '') return key;
    }
    return null;
}

/** Coerce to a finite number, or null. HEK publishes numeric strings. */
function toNumber(v) {
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : null;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Normalize an HEK `result` array of FI / FA / PG rows.
 *
 * @param {any} raw the parsed HEK payload (`{ result: [...] }`) or the array
 * @returns {{
 *   filaments: object[], field_map: Record<string,string|null>,
 *   unmapped_keys: string[], counts: Record<string, number>,
 *   detectors: string[], length_clamped: number, dropped: number,
 * }}
 * @throws {TypeError} when the payload is not an array-bearing shape — the
 *   caller turns that into a parse_error rather than serving an empty list,
 *   which would render as "the Sun has no filaments today".
 */
export function normalizeHekFilaments(raw) {
    const list = Array.isArray(raw) ? raw : raw?.result;
    if (!Array.isArray(list)) throw new TypeError('HEK payload carries no result array');

    // Resolve each output field ONCE against the first row that offers a
    // candidate — per-row resolution lets a ragged feed report a different
    // schema per filament, which is the confusion this is meant to remove.
    const fieldMap = {};
    for (const [out, candidates] of Object.entries(FIELD_CANDIDATES)) {
        fieldMap[out] = null;
        for (const row of list) {
            const key = resolveKey(row, candidates);
            if (key) { fieldMap[out] = key; break; }
        }
    }

    const claimed = new Set(Object.values(fieldMap).filter(Boolean));
    const unmapped = new Set();
    for (const row of list) {
        for (const key of Object.keys(row || {})) if (!claimed.has(key)) unmapped.add(key);
    }

    const counts = {};
    const detectors = new Set();
    let lengthClamped = 0, dropped = 0;
    const filaments = [];

    for (const row of list) {
        if (!row) { dropped++; continue; }
        const get = (name) => {
            const key = fieldMap[name];
            if (!key) return null;
            const v = row[key];
            if (v === undefined || v === null || v === '') return null;
            return NUMERIC_FIELDS.has(name) ? toNumber(v) : v;
        };

        const type = String(get('event_type') || '').toUpperCase().slice(0, 2);
        counts[type || 'other'] = (counts[type || 'other'] || 0) + 1;
        if (type && !EVENT_TYPES.includes(type)) { dropped++; continue; }

        const lat = get('lat_deg');
        const lon = get('lon_deg');
        // A detection with no position is not a detection. Dropping it is the
        // honest outcome; placing it at (0,0) would put a filament at disk
        // centre every time HEK published a row we could not read.
        if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) { dropped++; continue; }

        const lenArcsec = get('length_arcsec');
        let lengthDeg = null;
        if (lenArcsec !== null && lenArcsec > 0) {
            // arcsec → R☉ → degrees of arc along the surface (R = 1).
            const raw = (lenArcsec / R_SUN_ARCSEC) * (180 / Math.PI);
            lengthDeg = clamp(raw, LENGTH_CLAMP_DEG.min, LENGTH_CLAMP_DEG.max);
            if (lengthDeg !== raw) lengthClamped++;
        }

        const frm = get('frm_name');
        if (frm) detectors.add(String(frm));

        filaments.push({
            event_type: type || null,
            lat_deg: lat,
            lon_deg: lon,
            lon_carrington_deg: get('lon_carrington_deg'),
            length_deg: lengthDeg,
            tilt_deg: get('tilt_deg'),
            chirality: get('chirality'),
            frm_name: frm ? String(frm) : null,
            time: get('time') ? String(get('time')) : null,
        });
    }

    return {
        filaments,
        field_map: fieldMap,
        unmapped_keys: [...unmapped].sort(),
        counts,
        detectors: [...detectors].sort(),
        length_clamped: lengthClamped,
        dropped,
    };
}

/** Fields the cool-material channel cannot be built without. */
export const REQUIRED_FIELDS = Object.freeze(['lat_deg', 'lon_deg']);

/**
 * De-duplicate detections of the SAME structure.
 *
 * Several detectors run over the same frames and each publishes its own row,
 * and every detector re-publishes the same long-lived filament every few
 * hours. Splatting all of them stacks 5–10 copies of one structure into the
 * volume and makes it many times denser than a filament nobody happened to
 * detect twice — i.e. the render would encode how much ATTENTION a structure
 * got rather than how much material it has.
 *
 * Merge rule: within `tolDeg` on the sphere, keep the row with the most
 * complete geometry (a length beats no length), and carry the number merged so
 * the consumer can say how many detections stand behind a drawn filament.
 */
export function dedupeFilaments(filaments, tolDeg = 8) {
    const out = [];
    const DEG = Math.PI / 180;
    const vec = (f) => {
        const la = f.lat_deg * DEG, lo = f.lon_deg * DEG;
        return [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
    };
    const cosTol = Math.cos(tolDeg * DEG);
    for (const f of filaments) {
        const v = vec(f);
        let merged = false;
        for (const o of out) {
            const w = o._v;
            if (v[0] * w[0] + v[1] * w[1] + v[2] * w[2] >= cosTol) {
                o.detections++;
                // Prefer the more completely described row.
                const score = (x) => (x.length_deg != null ? 2 : 0) + (x.tilt_deg != null ? 1 : 0);
                if (score(f) > score(o)) {
                    Object.assign(o, f, { _v: vec(f), detections: o.detections });
                }
                merged = true;
                break;
            }
        }
        if (!merged) out.push({ ...f, _v: v, detections: 1 });
    }
    return out.map(({ _v, ...rest }) => rest);
}

// ── Spine geometry ─────────────────────────────────────────────────────────

/** Default half-length when a detector publishes no length, degrees. */
export const DEFAULT_HALF_LENGTH_DEG = 8;

/**
 * Height range cool material sits at, R☉ above the photosphere.
 * Quiescent filaments and prominences are observed at ~10 000–50 000 km
 * (0.014–0.072 R☉); the spine is placed in that band, low for an on-disk
 * filament and higher for a limb prominence, because a PG detection is one
 * that was seen ABOVE the limb.
 */
export const HEIGHT_RSUN = Object.freeze({ filament: 0.018, prominence: 0.045 });

/** Thickness of the material tube, R☉. Filaments are ~5 000–10 000 km across. */
export const SPINE_RADIUS_RSUN = 0.012;

/**
 * The spine of one filament as a scene-frame polyline (units: R☉, the page's
 * own convention — +y is the rotation axis, lon = atan2(x, z)).
 *
 * A filament is a line on the surface of angular length L at position angle
 * `tilt_deg`, measured here from the local EAST direction toward NORTH. That
 * convention is UNVERIFIED against HEK (see the module header); getting it
 * wrong rotates a filament in place rather than moving it, which is why it is
 * an acceptable risk while the position fields are the proven ones.
 *
 * @param {object} fil normalized filament
 * @param {{samples?:number, height?:number}} [opts]
 * @returns {number[][]} polyline of [x, y, z]
 */
export function filamentSpine(fil, opts = {}) {
    const DEG = Math.PI / 180;
    const n = Math.max(2, opts.samples ?? 12);
    const height = opts.height ?? (fil.event_type === 'PG' ? HEIGHT_RSUN.prominence : HEIGHT_RSUN.filament);
    const half = ((fil.length_deg ?? DEFAULT_HALF_LENGTH_DEG * 2) / 2) * DEG;
    const lat = fil.lat_deg * DEG, lon = fil.lon_deg * DEG;
    const tilt = (fil.tilt_deg ?? 0) * DEG;

    // Local frame at the centre. Same convention as the page: the centre
    // direction is (cos lat sin lon, sin lat, cos lat cos lon).
    const c = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
    const east = [Math.cos(lon), 0, -Math.sin(lon)];
    const north = [
        -Math.sin(lat) * Math.sin(lon),
        Math.cos(lat),
        -Math.sin(lat) * Math.cos(lon),
    ];
    const dir = [
        Math.cos(tilt) * east[0] + Math.sin(tilt) * north[0],
        Math.cos(tilt) * east[1] + Math.sin(tilt) * north[1],
        Math.cos(tilt) * east[2] + Math.sin(tilt) * north[2],
    ];

    const r = 1 + height;
    const pts = [];
    for (let i = 0; i < n; i++) {
        const s = (i / (n - 1) - 0.5) * 2 * half;          // −half … +half, radians of arc
        // Great-circle step from the centre along `dir` — NOT a tangent-plane
        // offset, which would push a 60° filament off the sphere entirely.
        const cs = Math.cos(s), sn = Math.sin(s);
        pts.push([
            (c[0] * cs + dir[0] * sn) * r,
            (c[1] * cs + dir[1] * sn) * r,
            (c[2] * cs + dir[2] * sn) * r,
        ]);
    }
    return pts;
}

/**
 * Every filament's spine, ready for the volume rasteriser.
 * @returns {{points:number[][], radius:number, weight:number}[]}
 */
export function coolMaterialLines(filaments, opts = {}) {
    return (filaments || []).map((f) => ({
        points: filamentSpine(f, opts),
        radius: opts.radius ?? SPINE_RADIUS_RSUN,
        // Weight is per STRUCTURE, never per detection — see dedupeFilaments.
        weight: 1,
        eventType: f.event_type ?? null,
    }));
}

// ── Joining the atlas the prominence bundles draw ──────────────────────────

/**
 * Atlas meta stride. MIRRORS js/field-atlas.js — the layout is documented
 * there; this copy exists because that module imports three.js and is
 * therefore unreachable from a node test. tests/hek-filaments.mjs gates the
 * two against each other by reading the other file's source.
 */
export const ATLAS_META_STRIDE = 8;

/**
 * Append OBSERVED filament spines to a traced atlas, as PIL-seeded closed
 * lines the prominence classifier already understands.
 *
 * WHY. The bundle renderer draws `seedKind === 2` (PIL) closed lines, and the
 * Rust tracer only ever produces those around an ACTIVE REGION — it walks the
 * Br = 0 contour near each AR. So the page could only ever show active-region
 * filaments: the long quiescent polar-crown filaments, which are most of what
 * is actually on the Sun most of the time, had nowhere to come from. HEK's
 * FI/FA/PG detections (js/hek-filaments.js) supply them.
 *
 * The appended lines carry `arIndex = -1`, which is how a consumer tells an
 * observed filament from a traced one — nothing here pretends a detection came
 * out of the field model.
 *
 * Every line in an atlas must have the SAME samplesPerLine (the textures are
 * a rectangular grid), so the caller must generate spines at that count.
 *
 * @param {object} atlas   a traced atlas, or null/empty for observed-only
 * @param {{points:number[][]}[]} lines  spines in scene R☉ coordinates
 * @param {{samplesPerLine?:number}} [opts]
 * @returns {object} a NEW atlas; the input is not mutated
 */
export function appendObservedFilaments(atlas, lines, opts = {}) {
    const usable = (lines || []).filter(l => l?.points?.length >= 2);
    if (!usable.length) return atlas;
    const n = atlas?.samplesPerLine || opts.samplesPerLine || 32;
    const base = atlas?.lineCount || 0;
    const total = base + usable.length;

    const positions = new Float32Array(total * n * 3);
    const tangents  = new Float32Array(total * n * 3);
    const meta      = new Float32Array(total * ATLAS_META_STRIDE);
    if (base) {
        positions.set(atlas.positions.subarray(0, base * n * 3));
        if (atlas.tangents?.length) tangents.set(atlas.tangents.subarray(0, base * n * 3));
        meta.set(atlas.meta.subarray(0, base * ATLAS_META_STRIDE));
    }

    usable.forEach((line, k) => {
        const li = base + k;
        const pts = line.points;
        let apex = 0, length = 0;
        for (let sIdx = 0; sIdx < n; sIdx++) {
            // Resample the spine to exactly n points so every line in the
            // atlas has the same stride.
            const t = (sIdx / (n - 1)) * (pts.length - 1);
            const i0 = Math.min(pts.length - 2, Math.floor(t));
            const f = t - i0;
            const a = pts[i0], b = pts[i0 + 1];
            const x = a[0] + (b[0] - a[0]) * f;
            const y = a[1] + (b[1] - a[1]) * f;
            const z = a[2] + (b[2] - a[2]) * f;
            const o = (li * n + sIdx) * 3;
            positions[o] = x; positions[o + 1] = y; positions[o + 2] = z;
            apex = Math.max(apex, Math.hypot(x, y, z) - 1);
        }
        // Tangents from the resampled curve, as the tracer does.
        for (let sIdx = 0; sIdx < n; sIdx++) {
            const oA = ((li * n) + Math.max(0, sIdx - 1)) * 3;
            const oB = ((li * n) + Math.min(n - 1, sIdx + 1)) * 3;
            const dx = positions[oB] - positions[oA];
            const dy = positions[oB + 1] - positions[oA + 1];
            const dz = positions[oB + 2] - positions[oA + 2];
            const len = Math.hypot(dx, dy, dz) || 1;
            const o = (li * n + sIdx) * 3;
            tangents[o] = dx / len; tangents[o + 1] = dy / len; tangents[o + 2] = dz / len;
            if (sIdx > 0) {
                const oP = (li * n + sIdx - 1) * 3;
                length += Math.hypot(positions[o] - positions[oP],
                                     positions[o + 1] - positions[oP + 1],
                                     positions[o + 2] - positions[oP + 2]);
            }
        }
        const first = (li * n) * 3;
        const m = li * ATLAS_META_STRIDE;
        meta[m]     = 0;            // topology: closed
        meta[m + 1] = 2;            // seedKind: PIL — what the classifier draws
        meta[m + 2] = -1;           // arIndex: OBSERVED, not from any traced AR
        meta[m + 3] = apex;
        meta[m + 4] = length;
        meta[m + 5] = Math.asin(Math.max(-1, Math.min(1, positions[first + 1] / (Math.hypot(positions[first], positions[first + 1], positions[first + 2]) || 1))));
        meta[m + 6] = Math.atan2(positions[first], positions[first + 2]);
        meta[m + 7] = 0;            // twist: a detection carries none
    });

    return { lineCount: total, samplesPerLine: n, positions, tangents, meta, observedFilaments: usable.length };
}
