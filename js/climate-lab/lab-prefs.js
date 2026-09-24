/**
 * climate-lab/lab-prefs.js — the Climate Lab's personalization store.
 * ═══════════════════════════════════════════════════════════════════════════
 * What a user can customise about the lab — display units, which instruments
 * sit on the bench and in what order, whether the dashboard opens at Home,
 * the meteogram span, the satellite watch list, and their "lab watches"
 * (in-app weather watches) — lives in ONE versioned document.
 *
 * WHAT IS NOT IN HERE, ON PURPOSE:
 *   · The HOME LOCATION. That is account data, `user_profiles.location_*`,
 *     the same columns the welcome wizard and the alert engine already read
 *     (lab-home.js). A second copy here would be a second location store.
 *   · ALERT THRESHOLDS that are delivered by email. Those are the existing
 *     `notify_*` / `*_threshold` columns (the alert console edits them in
 *     place). Lab watches are the in-app layer on top, and say so.
 *
 * STORAGE: local-first (`pp_climate_lab_v1`), exactly the dashboard-sync
 * posture — the page always boots from localStorage and works with no
 * network. Cloud sync (lab-sync.js) reconciles this document with a
 * `public.dashboards` row (page = 'climate-lab'); no schema change.
 *
 * `normalizePrefs` is the gate every document passes through — from
 * storage, from the cloud, from the settings drawer — so a corrupted or
 * future-versioned doc degrades to defaults field-by-field instead of
 * throwing in the middle of the dashboard's boot.
 */

export const PREFS_VERSION = 1;
export const PREFS_KEY = 'pp_climate_lab_v1';
export const PREFS_META_KEY = 'pp_climate_lab_v1.meta';
export const PREFS_EVENT = 'climate-lab-prefs';

/**
 * The instrument catalogue — id, bench name, the physical instrument it
 * stands for, and a one-line purpose for the customise drawer. Order here is
 * the DEFAULT bench order.
 */
export const INSTRUMENTS = Object.freeze([
    { id: 'thermo',  name: 'Thermometer',     glyph: '🌡️', what: 'Air temperature, feels-like, today’s range' },
    { id: 'hygro',   name: 'Hygrometer',      glyph: '💧', what: 'Relative humidity, dew point, comfort' },
    { id: 'baro',    name: 'Barometer',       glyph: '🧭', what: 'Sea-level pressure and 3-hour tendency' },
    { id: 'anemo',   name: 'Anemometer',      glyph: '🌬️', what: 'Wind, gusts, direction, Beaufort force' },
    { id: 'rain',    name: 'Rain gauge',      glyph: '☔', what: 'Precipitation chance and totals' },
    { id: 'sun',     name: 'Radiometer',      glyph: '☀️', what: 'UV index, solar radiation, sun angle' },
    { id: 'sky',     name: 'Sky & visibility', glyph: '☁️', what: 'Cloud cover, cloud base, visibility' },
    { id: 'psychro', name: 'Psychrometer',    glyph: '🧪', what: 'Wet-bulb, vapour-pressure deficit, moisture content' },
    { id: 'density', name: 'Air density',     glyph: '⚖️', what: 'Moist-air density and density altitude' },
    { id: 'air',     name: 'Air quality',     glyph: '🫁', what: 'US AQI, PM2.5, ozone' },
    { id: 'hazard',  name: 'Hazard indices',  glyph: '⚠️', what: 'Heat index, wind chill, fire weather, frost' },
    { id: 'degree',  name: 'Degree days',     glyph: '📈', what: 'Growing, heating and cooling degree days' },
    { id: 'soil',    name: 'Soil probe',      glyph: '🌱', what: 'Surface soil temperature, moisture, evapotranspiration' },
]);
const INSTRUMENT_IDS = new Set(INSTRUMENTS.map((i) => i.id));

/** Terrestrial lab-watch kinds: metric, comparison, SI unit, sane bounds. */
export const WATCH_KINDS = Object.freeze({
    heat:   { label: 'Heat above',          metric: 'tempMax',   cmp: '>=', quantity: 'temp',   min: -50, max: 60,  step: 0.5, def: 32 },
    freeze: { label: 'Temperature below',   metric: 'tempMin',   cmp: '<=', quantity: 'temp',   min: -60, max: 40,  step: 0.5, def: 0 },
    gust:   { label: 'Wind gusts above',    metric: 'gustMax',   cmp: '>=', quantity: 'wind',   min: 1,   max: 90,  step: 0.5, def: 17 },
    rain:   { label: 'Rain chance above',   metric: 'popMax',    cmp: '>=', quantity: 'pct',    min: 5,   max: 100, step: 5,   def: 70 },
    precip: { label: 'Precipitation above', metric: 'precipSum', cmp: '>=', quantity: 'precip', min: 0.5, max: 300, step: 0.5, def: 10 },
    uv:     { label: 'UV index above',      metric: 'uvMax',     cmp: '>=', quantity: 'index',  min: 1,   max: 15,  step: 1,   def: 8 },
    aqi:    { label: 'US AQI above',        metric: 'aqiMax',    cmp: '>=', quantity: 'index',  min: 25,  max: 500, step: 25,  def: 100 },
    fog:    { label: 'Visibility below',    metric: 'visMin',    cmp: '<=', quantity: 'distance', min: 100, max: 10000, step: 100, def: 1000 },
});

export const WATCH_HORIZONS = Object.freeze([6, 12, 24, 48]);
export const MAX_WATCHES = 12;
export const MAX_SATELLITES = 12;

/** ISS (ZARYA), Tiangong (CSS), Hubble — bright, famous, always visible. */
export const DEFAULT_SATELLITES = Object.freeze([25544, 48274, 20580]);

export const DEFAULT_PREFS = Object.freeze({
    v: PREFS_VERSION,
    units: Object.freeze({ preset: 'auto', overrides: Object.freeze({}) }),
    bench: Object.freeze({
        order: Object.freeze(INSTRUMENTS.map((i) => i.id)),
        hidden: Object.freeze(['degree', 'soil']),
    }),
    openAt: 'home',            // 'home' | 'last'
    meteogramHours: 48,        // 24 | 48 | 72
    satellites: Object.freeze([...DEFAULT_SATELLITES]),
    // In-browser reminder before a pass (the engine's notify_sat_pass is a
    // stub — see lab-satellites.js); visibleOnly = sunlit sat, dark sky.
    passReminder: Object.freeze({ on: false, leadMin: 10, visibleOnly: true }),
    watches: Object.freeze([
        Object.freeze({ id: 'w-heat', kind: 'heat', threshold: 32, horizonH: 24, on: false }),
        Object.freeze({ id: 'w-gust', kind: 'gust', threshold: 17, horizonH: 24, on: false }),
    ]),
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function cleanWatch(w, i) {
    if (!w || typeof w !== 'object') return null;
    const kind = WATCH_KINDS[w.kind];
    if (!kind) return null;
    const threshold = isNum(w.threshold) ? clamp(w.threshold, kind.min, kind.max) : kind.def;
    const horizonH = WATCH_HORIZONS.includes(w.horizonH) ? w.horizonH : 24;
    const id = typeof w.id === 'string' && /^[\w-]{1,40}$/.test(w.id) ? w.id : `w-${w.kind}-${i}`;
    return { id, kind: w.kind, threshold, horizonH, on: w.on === true };
}

/**
 * Coerce anything into a valid prefs document. Unknown instrument ids are
 * dropped, new catalogue instruments are appended (so a release that adds an
 * instrument shows it without wiping anyone's order), duplicates collapse.
 */
export function normalizePrefs(raw) {
    const r = (raw && typeof raw === 'object') ? raw : {};
    const out = {
        v: PREFS_VERSION,
        units: { preset: 'auto', overrides: {} },
        bench: { order: [], hidden: [] },
        openAt: r.openAt === 'last' ? 'last' : 'home',
        meteogramHours: [24, 48, 72].includes(r.meteogramHours) ? r.meteogramHours : 48,
        satellites: [],
        passReminder: {
            on: r.passReminder?.on === true,
            leadMin: [5, 10, 15, 30].includes(r.passReminder?.leadMin) ? r.passReminder.leadMin : 10,
            visibleOnly: r.passReminder?.visibleOnly !== false,
        },
        watches: [],
    };

    const presets = ['auto', 'metric', 'imperial', 'si', 'aviation', 'custom'];
    if (presets.includes(r.units?.preset)) out.units.preset = r.units.preset;
    const ov = r.units?.overrides;
    if (ov && typeof ov === 'object') {
        for (const [k, v] of Object.entries(ov)) {
            if (typeof v === 'string' && /^[A-Za-z]{1,5}$/.test(v)
                && ['temp', 'wind', 'pressure', 'precip', 'distance', 'height'].includes(k)) {
                out.units.overrides[k] = v;
            }
        }
    }

    const seen = new Set();
    for (const id of Array.isArray(r.bench?.order) ? r.bench.order : []) {
        if (INSTRUMENT_IDS.has(id) && !seen.has(id)) { seen.add(id); out.bench.order.push(id); }
    }
    for (const { id } of INSTRUMENTS) if (!seen.has(id)) out.bench.order.push(id);
    const hidden = Array.isArray(r.bench?.hidden) ? r.bench.hidden : DEFAULT_PREFS.bench.hidden;
    out.bench.hidden = [...new Set(hidden.filter((id) => INSTRUMENT_IDS.has(id)))];

    const sats = Array.isArray(r.satellites) ? r.satellites : DEFAULT_PREFS.satellites;
    for (const s of sats) {
        const id = Number.parseInt(s, 10);
        if (Number.isInteger(id) && id > 0 && id < 1_000_000 && !out.satellites.includes(id)) {
            out.satellites.push(id);
        }
        if (out.satellites.length >= MAX_SATELLITES) break;
    }

    const watches = Array.isArray(r.watches) ? r.watches : DEFAULT_PREFS.watches;
    const wIds = new Set();
    watches.forEach((w, i) => {
        const c = cleanWatch(w, i);
        if (c && !wIds.has(c.id) && out.watches.length < MAX_WATCHES) {
            wIds.add(c.id); out.watches.push(c);
        }
    });
    return out;
}

/** Visible instruments in bench order. */
export function visibleInstruments(prefs) {
    const p = normalizePrefs(prefs);
    const hidden = new Set(p.bench.hidden);
    return p.bench.order.filter((id) => !hidden.has(id));
}

/** Move an instrument one slot left (-1) or right (+1). Returns new prefs. */
export function moveInstrument(prefs, id, dir) {
    const p = normalizePrefs(prefs);
    const i = p.bench.order.indexOf(id);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= p.bench.order.length) return p;
    [p.bench.order[i], p.bench.order[j]] = [p.bench.order[j], p.bench.order[i]];
    return p;
}

// ── Storage (browser) ──────────────────────────────────────────────────────

export function loadPrefs() {
    try {
        const raw = localStorage.getItem(PREFS_KEY);
        return normalizePrefs(raw ? JSON.parse(raw) : null);
    } catch { return normalizePrefs(null); }
}

/**
 * Persist, stamp the local meta (last-write-wins clock for lab-sync.js) and
 * announce. Every consumer re-renders from the event detail, so there is one
 * apply path whether the change came from the drawer or from the cloud.
 */
export function savePrefs(prefs, { source = 'local' } = {}) {
    const p = normalizePrefs(prefs);
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(p));
        if (source === 'local') {
            localStorage.setItem(PREFS_META_KEY, JSON.stringify({ updatedAt: new Date().toISOString() }));
        }
    } catch {}
    try {
        window.dispatchEvent(new CustomEvent(PREFS_EVENT, { detail: { prefs: p, source } }));
    } catch {}
    return p;
}
