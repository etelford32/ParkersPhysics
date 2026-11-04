/**
 * api/_lib/volcano-activity.js — PURE normalizers for /api/volcanoes/activity
 * ═══════════════════════════════════════════════════════════════════════════
 * Two upstreams, both keyless, both UNVERIFIED from the build sandbox
 * (volcanoes.usgs.gov and eonet.gsfc.nasa.gov are egress-blocked there):
 *
 *   USGS HANS  — the Volcano Hazards Program's elevated-volcano list: every
 *                US volcano currently above NORMAL/GREEN, WITH its GVP volcano
 *                number (`vnum`), so it joins the catalogue exactly.
 *   NASA EONET — open "volcanoes" events (curated mostly from the Smithsonian/
 *                USGS Weekly Volcanic Activity Report): GLOBAL, but carries
 *                only a title + coordinates, so the client joins it to the
 *                catalogue by position (js/volcano-engine.js `matchActivity`).
 *
 * Because neither schema could be checked here, every field resolves from an
 * ordered CANDIDATE list and the route self-reports `field_map` (which key
 * answered) and `unmapped` (keys it received but did not read) — the
 * noaa-regions / neo-sources pattern. One production request settles it:
 *   curl -s https://parkersphysics.com/api/volcanoes/activity | jq .sources
 * then trim the candidate lists to the winners.
 */

// VERIFIED 2026-11-04 on the PR #1068 Vercel preview: the first URL answered
// and every HANS field resolved from its FIRST candidate spelling (vnum,
// volcano_name, color_code, alert_level, sent_utc, obs_abbr, notice_url);
// unmapped: notice_data, notice_identifier, notice_type_cd, obs_fullname,
// sent_unixtime. The fallbacks stay as a hedge against a USGS rename.
export const HANS_URLS = [
    'https://volcanoes.usgs.gov/hans-public/api/volcano/getElevatedVolcanoes',
    'https://volcanoes.usgs.gov/hans2/api/volcano/getElevatedVolcanoes',
];
export const EONET_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?category=volcanoes&status=open&days=120';

// EONET leaves some events open for months; older than this we stop calling
// them "current" (the client still fades by age).
export const EONET_MAX_AGE_DAYS = 120;

export const HANS_FIELDS = {
    num:        ['vnum', 'volcano_number', 'vNum', 'gvp_number', 'volcanoNumber'],
    name:       ['volcano_name', 'vName', 'volcanoName', 'name'],
    colorCode:  ['color_code', 'colorCode', 'aviation_color_code', 'aviationColorCode'],
    alertLevel: ['alert_level', 'alertLevel', 'volcano_alert_level'],
    sent:       ['sent_utc', 'sentUtc', 'sentRFC', 'sent_unixtime', 'sentUnixtime', 'statusRFC'],
    link:       ['notice_url', 'noticeUrl', 'url'],
    observatory:['obs_abbr', 'obsAbbr', 'obs_fullname', 'observatory'],
};

const USED = Symbol('used');
function pick(row, cands, fieldMap, key) {
    for (const c of cands) {
        if (row[c] != null && row[c] !== '') {
            fieldMap[key] ??= c;
            (fieldMap[USED] ??= new Set()).add(c);
            return row[c];
        }
    }
    return null;
}
function toMs(v) {
    if (v == null) return NaN;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) { const n = Number(s); return n < 1e12 ? n * 1000 : n; }
    // HANS prints "2026-11-03 18:22:00" (UTC, no zone) on some routes
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
    return Date.parse(iso);
}

const COLOR_RANK = { GREEN: 0, YELLOW: 1, ORANGE: 2, RED: 3 };
const LEVEL_RANK = { NORMAL: 0, ADVISORY: 1, WATCH: 2, WARNING: 3 };

/** USGS HANS elevated list → normalised items. */
export function parseHansElevated(payload, nowMs) {
    const rows = Array.isArray(payload) ? payload
        : Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.volcanoes) ? payload.volcanoes : null;
    if (!rows) throw new Error(`HANS: no row array in payload (keys: ${Object.keys(payload ?? {}).join(',') || typeof payload})`);
    const fieldMap = {};
    const seenKeys = new Set();
    const items = [];
    for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        for (const k of Object.keys(r)) seenKeys.add(k);
        const numRaw = pick(r, HANS_FIELDS.num, fieldMap, 'num');
        const num = Number(String(numRaw ?? '').replace(/\D/g, '')) || null;
        const name = pick(r, HANS_FIELDS.name, fieldMap, 'name');
        if (!num && !name) continue;
        const color = String(pick(r, HANS_FIELDS.colorCode, fieldMap, 'colorCode') ?? '').toUpperCase() || null;
        const level = String(pick(r, HANS_FIELDS.alertLevel, fieldMap, 'alertLevel') ?? '').toUpperCase() || null;
        const t = toMs(pick(r, HANS_FIELDS.sent, fieldMap, 'sent'));
        items.push({
            source: 'usgs-hans',
            id: `hans-${num ?? name}`,
            num, name: name ? String(name).trim() : null,
            lat: null, lon: null,
            colorCode: color in COLOR_RANK ? color : null,
            alertLevel: level in LEVEL_RANK ? level : null,
            observatory: pick(r, HANS_FIELDS.observatory, fieldMap, 'observatory'),
            lastUpdate: Number.isFinite(t) ? new Date(t).toISOString() : null,
            ageDays: Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 864e4) / 10) : null,
            link: pick(r, HANS_FIELDS.link, fieldMap, 'link'),
        });
    }
    const used = fieldMap[USED] ?? new Set();
    delete fieldMap[USED];
    return { items, fieldMap, unmapped: [...seenKeys].filter(k => !used.has(k)).sort() };
}

/** "Etna Volcano, Italy" → "Etna"; "Kilauea Volcano, Hawaii, United States" → "Kilauea". */
export function eonetVolcanoName(title) {
    const head = String(title ?? '').split(',')[0];
    return head.replace(/\b(Volcano|Volcanic Complex|Volcanic Field)\b/gi, '').replace(/\s+/g, ' ').trim() || null;
}

/** NASA EONET open volcano events → normalised items (latest point). */
export function parseEonetVolcanoes(payload, nowMs) {
    const events = payload?.events;
    if (!Array.isArray(events)) throw new Error('EONET: no events array');
    const items = [];
    let droppedStale = 0, noPoint = 0;
    for (const ev of events) {
        const pts = (ev.geometry ?? [])
            .filter(g => g?.type === 'Point' && Array.isArray(g.coordinates))
            .map(g => ({ lon: Number(g.coordinates[0]), lat: Number(g.coordinates[1]), t: Date.parse(g.date) }))
            .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.t))
            .sort((a, b) => a.t - b.t);
        if (!pts.length) { noPoint++; continue; }
        const last = pts[pts.length - 1];
        const ageDays = (nowMs - last.t) / 86_400_000;
        if (ageDays > EONET_MAX_AGE_DAYS) { droppedStale++; continue; }
        items.push({
            source: 'eonet',
            id: ev.id ?? `eonet-${items.length}`,
            num: null,
            name: eonetVolcanoName(ev.title),
            title: ev.title ?? null,
            lat: last.lat, lon: last.lon,
            colorCode: null, alertLevel: null,
            startedAt: new Date(pts[0].t).toISOString(),
            lastUpdate: new Date(last.t).toISOString(),
            ageDays: Math.max(0, Math.round(ageDays * 10) / 10),
            link: ev.link ?? (ev.sources?.[0]?.url ?? null),
            via: (ev.sources ?? []).map(s => s?.id).filter(Boolean),
        });
    }
    // received / dropped are self-reported so an empty list can say WHICH
    // empty it is: EONET had nothing open, or our age cut removed it.
    return { items: items.sort((a, b) => a.ageDays - b.ageDays),
             received: events.length, droppedStale, noPoint };
}

/** Fold per-source outcomes into one response body (never a 5xx). */
export function composeActivity({ hans, eonet, nowMs }) {
    const items = [...(hans.ok ? hans.items : []), ...(eonet.ok ? eonet.items : [])];
    const reasons = [];
    if (!hans.ok) reasons.push('usgs-hans-down');
    if (!eonet.ok) reasons.push('eonet-down');
    return {
        updated: new Date(nowMs).toISOString(),
        freshness: reasons.length ? 'stale' : 'live',
        ...(reasons.length ? { reasons, note: hans.ok || eonet.ok
            ? 'one activity source is down — the list is PARTIAL (USGS covers US volcanoes only; EONET is global)'
            : 'both activity sources are down — no live eruption status; the catalogue status still stands' } : {}),
        count: items.length,
        items,
        sources: {
            usgs_hans: { ok: hans.ok, count: hans.ok ? hans.items.length : 0, url: hans.url ?? null,
                tried: hans.tried ?? [], field_map: hans.fieldMap ?? null, unmapped: hans.unmapped ?? null,
                ...(hans.ok ? {} : { error: hans.error }) },
            eonet: { ok: eonet.ok, count: eonet.ok ? eonet.items.length : 0,
                ...(eonet.ok ? { received: eonet.received, dropped_stale: eonet.droppedStale, no_point: eonet.noPoint,
                                 max_age_days: EONET_MAX_AGE_DAYS } : { error: eonet.error }) },
        },
    };
}
