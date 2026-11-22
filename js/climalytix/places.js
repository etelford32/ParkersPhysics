/**
 * climalytix/places.js — the PURE kernel behind Climalytix's location search:
 * the places a reader has been (history), the ones they keep (saved), and how
 * a typed query is turned into suggestions.
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS NOT. It is not a location store. The site being analysed is
 * still the CURRENT VIEW (`ppx_user_location`) and Home is still
 * `user_profiles.location_*` (lab-home.js) — this module only REMEMBERS where
 * the view has been pointed, and offers those places back. Nothing here reads
 * storage, the DOM, the network or the clock: every function takes `now`.
 *
 * ONE DOCUMENT, { v, clearedAt, places: [...] }, and one record per place:
 *   id      'p_<lat .2f>_<lon .2f>'  — ~1 km, so a re-search of the same city
 *           is the same place (lab-home's `sameLocation` tolerance)
 *   at, n   last visit (ms) and visit count
 *   pin, pinAt   saved? and WHEN that was last decided (save or un-save)
 *   del     "forget this" stamp (ms). A place is in the history only while
 *           at > max(del, clearedAt) — so a later visit brings it back.
 *
 * WHY STAMPS INSTEAD OF DELETIONS. The document syncs between devices and is
 * MERGED, not last-write-wins: two devices that each visited somewhere must
 * both keep their visit. A union merge resurrects anything that was simply
 * deleted, so removal is a newer stamp that wins the merge (`del`, `pinAt`,
 * `clearedAt`). `mergePlaces` is commutative and idempotent — the node gate
 * checks both — which is what lets a pull-then-push never fight itself.
 *
 * SEARCH. `suggest` ranks WITHOUT the network: coordinates the reader typed,
 * Home, saved places, history, then the site's own city list
 * (js/data/major-cities.js). The geocoder is only asked when the reader
 * SUBMITS — Nominatim's usage policy forbids type-ahead against it, and that
 * is a rule, not a preference (do not "improve" this into per-keystroke
 * geocoding).
 */

export const PLACES_VERSION = 1;
export const MAX_RECENT = 12;
export const MAX_SAVED = 24;
export const MAX_HIDDEN = 24;      // stamped-but-invisible records kept so a merge cannot resurrect them

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ms = (v) => (isNum(v) && v > 0 ? Math.floor(v) : 0);
const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Stable id for a spot, rounded to 0.01° (never "-0.00"). */
export function placeId(lat, lon) {
    const r = (x) => (Math.round(Number(x) * 100) / 100 + 0).toFixed(2);
    return `p_${r(lat)}_${r(lon)}`;
}

/** A valid place record or null. Coordinates decide the id — never the stored one. */
export function cleanPlace(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.lat == null || raw.lon == null || raw.lat === '' || raw.lon === '') return null;
    const lat = Number(raw.lat), lon = Number(raw.lon);
    if (!isNum(lat) || !isNum(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    const city = text(raw.city, 80) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    const detail = text(raw.detail, 120);
    const out = {
        id: placeId(lat, lon),
        lat: Math.round(lat * 1e4) / 1e4,
        lon: Math.round(lon * 1e4) / 1e4,
        city,
        at: ms(raw.at),
        n: Math.min(9999, Math.max(0, Math.floor(isNum(raw.n) ? raw.n : 0))),
        pin: raw.pin ? 1 : 0,
        pinAt: ms(raw.pinAt),
        del: ms(raw.del),
    };
    if (detail && detail !== city) out.detail = detail;
    return out;
}

export function emptyPlaces() { return { v: PLACES_VERSION, clearedAt: 0, places: [] }; }

const inHistory = (p, clearedAt) => p.at > Math.max(p.del, clearedAt);
const byNewest = (key) => (a, b) => (b[key] - a[key]) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The gate every document passes through — from storage, from the cloud, from
 * a merge. Drops junk, collapses duplicates, and applies the caps
 * deterministically (ties break on id, so two devices trim the same way).
 */
export function normalizePlaces(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const clearedAt = ms(r.clearedAt);
    const byId = new Map();
    for (const item of Array.isArray(r.places) ? r.places : []) {
        const p = cleanPlace(item);
        if (!p) continue;
        byId.set(p.id, byId.has(p.id) ? joinRecords(byId.get(p.id), p) : p);
    }
    const all = [...byId.values()];
    const saved = all.filter((p) => p.pin).sort(byNewest('pinAt')).slice(0, MAX_SAVED);
    const rest = all.filter((p) => !p.pin);
    const recent = rest.filter((p) => inHistory(p, clearedAt)).sort(byNewest('at'));
    const kept = recent.slice(0, MAX_RECENT);
    const keptIds = new Set(kept.map((p) => p.id));
    // Invisible records survive only while they carry a decision a merge needs.
    const stamp = (p) => Math.max(p.del, p.pinAt);
    // A forget stamp older than the last clear is redundant (the clear covers
    // it); an un-save stamp is not, whatever its age.
    const hidden = rest.filter((p) => !keptIds.has(p.id) && (p.pinAt > 0 || p.del > clearedAt))
        .sort((a, b) => (stamp(b) - stamp(a)) || (a.id < b.id ? -1 : 1)).slice(0, MAX_HIDDEN);
    const places = [...saved, ...kept, ...hidden].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { v: PLACES_VERSION, clearedAt, places };
}

/** Two records of the SAME place: every stamp takes its newest value. */
function joinRecords(a, b) {
    const key = (p) => `${p.city}|${p.detail || ''}|${p.lat}|${p.lon}`;
    const newer = (a.at > b.at) || (a.at === b.at && key(a) <= key(b)) ? a : b;
    const pinFrom = a.pinAt > b.pinAt ? a : b.pinAt > a.pinAt ? b : (a.pin >= b.pin ? a : b);
    const out = {
        id: a.id, lat: newer.lat, lon: newer.lon, city: newer.city,
        at: Math.max(a.at, b.at), n: Math.max(a.n, b.n),
        pin: pinFrom.pin, pinAt: Math.max(a.pinAt, b.pinAt),
        del: Math.max(a.del, b.del),
    };
    if (newer.detail) out.detail = newer.detail;
    return out;
}

/** Union of two documents. Commutative and idempotent (gated). */
export function mergePlaces(a, b) {
    const A = normalizePlaces(a), B = normalizePlaces(b);
    return normalizePlaces({ clearedAt: Math.max(A.clearedAt, B.clearedAt), places: [...A.places, ...B.places] });
}

/** Same content? (Used to decide whether a merge needs to be pushed.) */
export function samePlaces(a, b) {
    return JSON.stringify(normalizePlaces(a)) === JSON.stringify(normalizePlaces(b));
}

const find = (doc, id) => doc.places.find((p) => p.id === id) || null;
const put = (doc, rec) => normalizePlaces({ ...doc, places: [...doc.places.filter((p) => p.id !== rec.id), rec] });

/** The view was pointed at `loc`. */
export function recordVisit(doc, loc, now) {
    const d = normalizePlaces(doc);
    const c = cleanPlace(loc);
    if (!c || !isNum(now)) return d;
    const old = find(d, c.id);
    const rec = { ...(old || c), city: c.city, lat: c.lat, lon: c.lon, at: Math.max(ms(now), old?.at || 0, (old?.del || 0) + 1, d.clearedAt + 1), n: (old?.n || 0) + 1 };
    if (c.detail) rec.detail = c.detail; else if (!old?.detail) delete rec.detail;
    return put(d, rec);
}

/** Save or un-save a place (creating its record if it has never been visited). */
export function setSaved(doc, loc, saved, now) {
    const d = normalizePlaces(doc);
    const c = cleanPlace(loc);
    if (!c || !isNum(now)) return d;
    const old = find(d, c.id);
    if (!old && !saved) return d;
    return put(d, { ...(old || c), pin: saved ? 1 : 0, pinAt: Math.max(ms(now), (old?.pinAt || 0) + 1) });
}

/** Take one place out of the history (a saved place stays saved). */
export function forgetPlace(doc, id, now) {
    const d = normalizePlaces(doc);
    const old = find(d, id);
    if (!old || !isNum(now)) return d;
    return put(d, { ...old, del: Math.max(ms(now), old.at) });
}

/** Clear the whole history. Saved places are not history and stay. */
export function clearHistory(doc, now) {
    const d = normalizePlaces(doc);
    if (!isNum(now)) return d;
    return normalizePlaces({ ...d, clearedAt: Math.max(d.clearedAt, ms(now), ...d.places.map((p) => p.at)) });
}

/** Saved places, in the order they were saved. */
export function savedPlaces(doc) {
    return normalizePlaces(doc).places.filter((p) => p.pin).sort((a, b) => (a.pinAt - b.pinAt) || (a.id < b.id ? -1 : 1));
}

/** History, newest first. Saved places are listed once, under Saved. */
export function recentPlaces(doc, { includeSaved = false } = {}) {
    const d = normalizePlaces(doc);
    return d.places.filter((p) => inHistory(p, d.clearedAt) && (includeSaved || !p.pin)).sort(byNewest('at'))
        .slice(0, includeSaved ? MAX_RECENT + MAX_SAVED : MAX_RECENT);
}

export function isSaved(doc, loc) {
    const c = cleanPlace(loc);
    return !!(c && find(normalizePlaces(doc), c.id)?.pin);
}

// ── Search ──────────────────────────────────────────────────────────────────

/** Lower-case, accents folded, punctuation to spaces: "Reykjavík" → "reykjavik". */
export function fold(s) {
    return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ').trim();
}

const COORD = String.raw`([+-]?\d{1,3}(?:\.\d+)?)\s*°?\s*(?:(\d{1,2}(?:\.\d+)?)\s*['′]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:"|″|'')\s*)?([NSEWnsew])?`;
const COORD_PAIR = new RegExp(`^\\s*${COORD}\\s*([,;\\s])\\s*${COORD}\\s*$`);

/**
 * Coordinates typed into the search box, or null.
 *   "40.015, -105.27" · "40.015 -105.27" · "40.015N 105.27W" · "105.27W, 40.015N"
 *   · 40°0'54"N 105°16'14"W
 * Two bare integers need a comma ("10 20" is more likely part of an address),
 * and one number is never a coordinate (a zip code must reach the geocoder).
 */
export function parseCoordinates(q) {
    const m = COORD_PAIR.exec(String(q ?? ''));
    if (!m) return null;
    const part = (i) => {
        const deg = Number(m[i]), min = m[i + 1] ? Number(m[i + 1]) : 0, sec = m[i + 2] ? Number(m[i + 2]) : 0;
        if (min >= 60 || sec >= 60) return null;
        const hemi = (m[i + 3] || '').toUpperCase();
        const sign = deg < 0 || m[i].trim().startsWith('-') ? -1 : 1;
        let v = sign * (Math.abs(deg) + min / 60 + sec / 3600);
        if (hemi === 'S' || hemi === 'W') v = -Math.abs(v);
        if (hemi === 'N' || hemi === 'E') v = Math.abs(v);
        return { v, hemi, marked: !!hemi || /°/.test(m[0]) || m[i].includes('.') || !!m[i + 1] };
    };
    const a = part(1), b = part(6);
    if (!a || !b) return null;
    if (m[5] !== ',' && m[5] !== ';' && !(a.marked && b.marked)) return null;
    const aIsLon = a.hemi === 'E' || a.hemi === 'W', bIsLat = b.hemi === 'N' || b.hemi === 'S';
    if ((aIsLon && b.hemi && !bIsLat) || (bIsLat && a.hemi && !aIsLon)) return null;   // two lats or two lons
    const [lat, lon] = aIsLon || bIsLat ? [b.v, a.v] : [a.v, b.v];
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
}

/** "40.015°N 105.271°W" */
export function formatCoords(lat, lon, digits = 3) {
    return `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(digits)}°${lon >= 0 ? 'E' : 'W'}`;
}

/**
 * Every query token must begin some word of the label. Returns a rank (lower
 * is better) or -1: 0 = the label starts with the query, 1 = a later word does.
 */
export function matchRank(query, label) {
    const q = fold(query), l = fold(label);
    if (!q || !l) return -1;
    const words = l.split(' ');
    for (const t of q.split(' ')) if (!words.some((w) => w.startsWith(t))) return -1;
    return l.startsWith(q) ? 0 : 1;
}

/**
 * Suggestions for the search box — no network.
 * @param {string} query
 * @param {{home?:object, doc?:object, cities?:Array<{n,c,lat,lon,p}>, limit?:number}} src
 * @returns {Array<{kind:'coords'|'home'|'saved'|'recent'|'city', id, lat, lon, city, detail?:string}>}
 *
 * Empty query: Home, saved places, history — "where was I?".
 * With a query: typed coordinates first, then the reader's OWN places that
 * match (theirs outrank a bigger city of the same name), then cities by
 * prefix-before-word match and population. One row per place.
 */
export function suggest(query, { home = null, doc = null, cities = [], limit = 8 } = {}) {
    const q = String(query ?? '').trim();
    const out = [];
    const seen = new Set();
    const add = (kind, loc) => {
        const c = cleanPlace(loc);
        if (!c || seen.has(c.id)) return;
        // The city list's centre and a geocoder's centre for the SAME city are
        // a few km apart (different ids): same name within ~30 km is one row.
        if (kind === 'city' && out.some((o) => fold(o.city) === fold(c.city)
            && Math.abs(o.lat - c.lat) < 0.3 && Math.abs(o.lon - c.lon) < 0.3)) return;
        seen.add(c.id);
        const row = { kind, id: c.id, lat: c.lat, lon: c.lon, city: c.city };
        if (c.detail) row.detail = c.detail;
        out.push(row);
    };
    const own = [
        ...(home ? [['home', home]] : []),
        ...savedPlaces(doc).map((p) => ['saved', p]),
        ...recentPlaces(doc).map((p) => ['recent', p]),
    ];
    if (!q) {
        for (const [kind, p] of own) add(kind, p);
        return out.slice(0, limit);
    }
    const xy = parseCoordinates(q);
    if (xy) add('coords', { ...xy, city: formatCoords(xy.lat, xy.lon), detail: 'Coordinates' });
    for (const rank of [0, 1]) {
        for (const [kind, p] of own) if (matchRank(q, `${p.city} ${p.detail || ''}`) === rank) add(kind, p);
    }
    for (const rank of [0, 1]) {
        const hits = cities.filter((c) => matchRank(q, `${c.n} ${c.c}`) === rank)
            .sort((a, b) => (b.p || 0) - (a.p || 0));
        for (const c of hits) add('city', { lat: c.lat, lon: c.lon, city: c.n, detail: c.c });
    }
    return out.slice(0, limit);
}

/**
 * Which characters of `label` a query matched, for the suggestion list:
 * [{ text, hit }] in order, covering the label exactly. A hit is the leading
 * part of a word that some query token begins (the `matchRank` rule), found
 * through the same folding — so "reyk" lights "Reyk" in "Reykjavík".
 */
export function highlightParts(label, query) {
    const s = String(label ?? '');
    const tokens = fold(query).split(' ').filter(Boolean).sort((a, b) => b.length - a.length);
    if (!tokens.length || !s) return s ? [{ text: s, hit: false }] : [];
    const out = [];
    const push = (text, hit) => {
        if (!text) return;
        const last = out[out.length - 1];
        if (last && last.hit === hit) last.text += text; else out.push({ text, hit });
    };
    let at = 0;
    for (const m of s.matchAll(/[\p{L}\p{N}\p{M}]+/gu)) {
        push(s.slice(at, m.index), false);
        const word = m[0];
        const t = tokens.find((tok) => fold(word).replace(/ /g, '').startsWith(tok));
        let cut = 0;
        if (t) {
            for (let n = 0; cut < word.length && n < t.length; cut++) n += fold(word[cut]).length;
            while (cut < word.length && !fold(word[cut]).length && /\p{M}/u.test(word[cut])) cut++;   // keep a combining mark with its letter
        }
        push(word.slice(0, cut), true);
        push(word.slice(cut), false);
        at = m.index + word.length;
    }
    push(s.slice(at), false);
    return out;
}

/** Places to offer a first-time reader with nothing of their own: one per climate, from the city list. */
export const EXAMPLE_CITIES = Object.freeze(['Reykjavík', 'Denver', 'Singapore', 'Nairobi', 'Sydney']);
export function exampleRows(cities = [], names = EXAMPLE_CITIES) {
    const out = [];
    for (const n of names) {
        const c = cities.find((x) => fold(x.n) === fold(n));
        const p = c && cleanPlace({ lat: c.lat, lon: c.lon, city: c.n, detail: c.c });
        if (p) out.push({ kind: 'example', id: p.id, lat: p.lat, lon: p.lon, city: p.city, detail: p.detail });
    }
    return out;
}

// ── "Save this when I'm signed in" ──────────────────────────────────────────

export const SAVE_INTENT_TTL_MS = 30 * 60 * 1000;

/**
 * A reader pressed Save while signed out and went off to sign in. The intent
 * is honoured only if it is recent — an hour-old one would save a place they
 * have long since moved on from, on an account they may not have meant.
 */
export function makeSaveIntent(loc, now) {
    const c = cleanPlace(loc);
    return c && isNum(now) ? { lat: c.lat, lon: c.lon, city: c.city, ...(c.detail ? { detail: c.detail } : {}), at: ms(now) } : null;
}
export function validSaveIntent(raw, now, ttlMs = SAVE_INTENT_TTL_MS) {
    const c = cleanPlace(raw);
    const at = ms(raw?.at);
    if (!c || !at || !isNum(now) || now < at || now - at > ttlMs) return null;
    return c;
}
