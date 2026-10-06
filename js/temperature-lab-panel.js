/**
 * temperature-lab-panel.js — the Planetary Temperature Lab's DOM
 * (PLANETARY_TEMPERATURE_LAB_PLAN.md §5–§7). Draws what
 * /api/temperature/snapshot returned; computes no scorecard (that is
 * js/temperature-lab-model.js, run server-side) and fetches nothing (that is
 * js/temperature-lab-feed.js and the page controller).
 *
 *   mountTemperatureLab(host, { variant, unit, ...callbacks }) → handle
 *     handle.render(body)              a snapshot body (live, stale or expired)
 *     handle.setAccess(access, limits) the js/temperature-lab-access.js rung
 *     handle.setPlace(place)           the "your place" card's model
 *     handle.setUnit('C' | 'F')        display only — every value stays °C / K
 *
 * `variant: 'page'` draws the map; `'earthview'` (Phase 5) omits it because
 * the globe is the map. CSS is namespaced `.tl-*` and injected once.
 *
 * HONESTY RULES this file enforces (plan §3.6–§3.7, R10):
 *   • a stale or expired body LOOKS stale or expired: the status chip names
 *     the reason in words, a fallback window puts the understatement note
 *     on the cards, and an expired body draws no card at all
 *   • a gap is a gap — no data is transparent on the map and "—" in a row,
 *     never painted as normal
 *   • rows never say "hottest place on Earth" or "record"; they say what the
 *     model says: hottest of the grid points we sample, beyond 1991–2020 in
 *     ERA5 for the date
 *   • locked content is VISIBLE (blurred, with a 🔒 chip) and opens a gate
 *     only on a click — never on load (§7.3)
 */

import {
    buildAnomalyLUTPixels, anomalyToFrac, percentileToFrac, anomalyCss, inkOn, rampColorAt,
} from './temp-anomaly-ramp.js';
import { buildTempLUTPixels, tempToRampFrac } from './temp-ramp.js';
import { cellIndex } from './temperature-normals.js';
import { monthCalendarHtml, CALENDAR_CSS } from './temp-calendar-view.js';

const STYLE_ID = 'tl-styles';
const W = 72, H = 36;
const CANVAS_W = 1440, CANVAS_H = 720;
const COAST_SRC = 'assets/earth/water-1k.webp';

export const MAP_MODES = Object.freeze([
    { id: 'anomaly', label: 'Anomaly' },
    { id: 'temperature', label: 'Temperature' },
    { id: 'rarity', label: 'Rarity' },
]);

export const CARD_DEFS = Object.freeze([
    { key: 'hottest', title: 'Hottest now', what: 'highest 24-h maximum', stat: 'max' },
    { key: 'coldest', title: 'Coldest now', what: 'lowest 24-h minimum', stat: 'min' },
    { key: 'above', title: 'Most above normal', what: 'rarest warm 24-h mean for the date', stat: 'mean' },
    { key: 'below', title: 'Most below normal', what: 'rarest cold 24-h mean for the date', stat: 'mean' },
    { key: 'swings', title: 'Biggest 24-h swings', what: 'change in the 24-h mean, day over day', stat: 'mean' },
]);

const CLASS_WORDS = Object.freeze({
    'much-above': 'much above normal', above: 'above normal', near: 'near normal',
    below: 'below normal', 'much-below': 'much below normal',
});

const REASON_WORDS = Object.freeze({
    'fallback-source': 'built on a coarse fallback field, which understates extremes',
    'window-old': 'the newest frame is more than 3 h old',
    'low-coverage': 'part of the planet has no data in this window',
    'no-aggregate': 'the live aggregate is not available yet',
    'normals-unavailable': 'the 1991–2020 normals failed to load',
    'fetch-failed': 'the snapshot could not be reached',
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Units: everything arrives in °C / K and is converted ONLY here ─────────
export const toUnit = (c, unit) => (unit === 'F' ? c * 9 / 5 + 32 : c);
export const dToUnit = (k, unit) => (unit === 'F' ? k * 9 / 5 : k);
export function fmtTemp(c, unit, digits = 1) {
    return isNum(c) ? `${toUnit(c, unit).toFixed(digits)}°${unit}` : '—';
}
export function fmtDelta(k, unit, digits = 1) {
    if (!isNum(k)) return '—';
    const v = dToUnit(k, unit);
    const s = Math.abs(v) < 0.05 ? '±' : v > 0 ? '+' : '−';
    return `${s}${Math.abs(v).toFixed(digits)}°${unit}`;
}

/** "warmer than 97 % of Oct 6ths, 1991–2020" — the rarity in words (R5). */
export function rarityPhrase(percentile, dateIso) {
    if (!isNum(percentile)) return '';
    const d = new Date(dateIso);
    const day = Number.isFinite(d.getTime())
        ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
        : 'this date';
    const warm = percentile >= 50;
    const p = warm ? percentile : 100 - percentile;
    const pct = p >= 99.95 ? '>99.9' : p >= 99 ? p.toFixed(1) : Math.round(p);
    return `${warm ? 'warmer' : 'colder'} than ${pct}% of ${day}s, 1991–2020`;
}

/** Where a row is: the nearest major city when one is near, else the region. */
export function rowPlace(row) {
    if (row?.place?.name) return { name: row.place.name, sub: row.region };
    return { name: row?.region ?? '—', sub: `${Math.abs(row.lat).toFixed(1)}°${row.lat >= 0 ? 'N' : 'S'} ${Math.abs(row.lon).toFixed(1)}°${row.lon >= 0 ? 'E' : 'W'}` };
}

/** Status chip model for a body. */
export function statusOf(body, nowMs = Date.now()) {
    const fr = body?.freshness ?? 'expired';
    const reasons = Array.isArray(body?.reasons) ? body.reasons : [];
    const words = reasons.map(r => REASON_WORDS[r] ?? r);
    const age = body?.window?.to ? Math.max(0, Math.round((nowMs - Date.parse(body.window.to)) / 60_000)) : null;
    const ageTxt = age == null ? '' : age < 90 ? `${age} min ago` : `${Math.round(age / 60)} h ago`;
    if (fr === 'live') return { level: 'live', label: 'Live', text: ageTxt ? `newest frame ${ageTxt}` : '' };
    if (fr === 'stale') return { level: 'stale', label: 'Degraded', text: words.join(' · ') + (ageTxt ? ` · newest frame ${ageTxt}` : '') };
    return { level: 'expired', label: 'Unavailable', text: words.join(' · ') || 'no data' };
}

// ── Styles ──────────────────────────────────────────────────────────────────
const CSS = `
.tl-root{--tl-bg:#060a14;--tl-panel:rgba(10,18,32,.86);--tl-s2:#111c30;--tl-border:rgba(120,170,230,.16);
  --tl-ink:#e8f0fb;--tl-ink2:#bcc9dc;--tl-ink3:#8193ae;--tl-ink4:#5f7192;--tl-accent:#6fd3ff;
  --tl-live:#4eff91;--tl-warn:#ffb347;--tl-err:#ff6b6b;
  position:relative;color:var(--tl-ink);font-family:'Segoe UI',system-ui,-apple-system,sans-serif;container-type:inline-size}
.tl-root *{box-sizing:border-box}
.tl-root [hidden]{display:none!important}
.tl-sec{background:var(--tl-panel);border:1px solid var(--tl-border);border-radius:14px;padding:14px 16px;margin:0 0 14px}
.tl-sec h2{margin:0 0 2px;font-size:.95rem;letter-spacing:.03em;color:#f3f8ff}
.tl-sub{margin:0 0 10px;font-size:.74rem;color:var(--tl-ink3);line-height:1.45}
.tl-status{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:.76rem;color:var(--tl-ink2);margin:0 0 12px}
.tl-chip{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-weight:650;font-size:.72rem;
  border:1px solid currentColor;letter-spacing:.03em}
.tl-chip i{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block}
.tl-chip.live{color:var(--tl-live)}.tl-chip.stale{color:var(--tl-warn)}.tl-chip.expired{color:var(--tl-err)}
.tl-units{margin-left:auto;display:inline-flex;border:1px solid var(--tl-border);border-radius:999px;overflow:hidden}
.tl-units button,.tl-seg button{background:transparent;border:0;color:var(--tl-ink3);font:inherit;font-size:.72rem;padding:4px 10px;cursor:pointer}
.tl-units button[aria-pressed="true"],.tl-seg button[aria-pressed="true"]{background:var(--tl-s2);color:var(--tl-ink)}
.tl-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.tl-tile{background:var(--tl-s2);border-radius:10px;padding:10px 12px;min-width:0}
.tl-tile .k{font-size:.64rem;letter-spacing:.09em;text-transform:uppercase;color:var(--tl-ink4)}
.tl-tile .v{font-size:1.25rem;font-weight:700;margin:3px 0 2px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl-tile .b{font-size:.68rem;color:var(--tl-ink3);line-height:1.35}
.tl-maphead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px}
.tl-seg{display:inline-flex;border:1px solid var(--tl-border);border-radius:999px;overflow:hidden}
.tl-mapwrap{position:relative;border-radius:10px;overflow:hidden;background:#040a16;aspect-ratio:2/1}
.tl-mapwrap canvas{display:block;width:100%;height:100%}
.tl-pulse{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid #fff;
  box-shadow:0 0 0 2px rgba(0,0,0,.5);pointer-events:none;animation:tl-pulse 1.4s ease-out 3}
@keyframes tl-pulse{0%{transform:scale(.6);opacity:1}100%{transform:scale(2.2);opacity:0}}
@media (prefers-reduced-motion:reduce){.tl-pulse{animation:none}}
.tl-legend{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:.68rem;color:var(--tl-ink3);flex-wrap:wrap}
.tl-legend canvas{width:min(340px,100%);height:10px;border-radius:3px;display:block}
.tl-legend .ticks{position:relative;height:14px;width:min(340px,100%)}
.tl-legend .ticks span{position:absolute;transform:translateX(-50%);white-space:nowrap;font-variant-numeric:tabular-nums}
.tl-tip{position:absolute;z-index:8;pointer-events:none;background:#0e1830;border:1px solid var(--tl-border);border-radius:9px;
  padding:7px 10px;font-size:.72rem;line-height:1.45;color:var(--tl-ink);white-space:pre-line;max-width:280px;box-shadow:0 6px 20px rgba(0,0,0,.45)}
.tl-controls{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:0 0 10px;font-size:.74rem;color:var(--tl-ink3)}
.tl-controls select{background:var(--tl-s2);color:var(--tl-ink);border:1px solid var(--tl-border);border-radius:8px;padding:4px 8px;font:inherit;font-size:.74rem;max-width:220px}
.tl-note{font-size:.74rem;color:var(--tl-warn);background:rgba(255,179,71,.08);border:1px solid rgba(255,179,71,.3);
  border-radius:9px;padding:7px 10px;margin:0 0 10px;line-height:1.45}
.tl-empty{font-size:.8rem;color:var(--tl-ink3);padding:18px 4px;text-align:center}
.tl-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
.tl-card{background:var(--tl-s2);border-radius:12px;padding:10px 12px 8px;min-width:0;position:relative}
.tl-card h3{margin:0;font-size:.86rem;display:flex;align-items:center;gap:8px}
.tl-card h3 i{width:4px;height:14px;border-radius:2px;display:inline-block}
.tl-card .what{font-size:.68rem;color:var(--tl-ink4);margin:2px 0 6px}
.tl-rows{list-style:none;margin:0;padding:0}
.tl-row{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:2px 8px;align-items:center;padding:6px 4px;border-top:1px solid rgba(255,255,255,.05);
  border-radius:6px;cursor:pointer}
.tl-row:hover,.tl-row:focus-visible{background:rgba(255,255,255,.04);outline:none}
.tl-row .n{font-size:.68rem;color:var(--tl-ink4);font-variant-numeric:tabular-nums}
.tl-row .p{min-width:0}
.tl-row .p b{display:block;font-size:.8rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl-row .p small{display:block;font-size:.66rem;color:var(--tl-ink4);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl-row .v{text-align:right;font-variant-numeric:tabular-nums;font-size:.8rem;font-weight:650;white-space:nowrap}
.tl-row .r{grid-column:2/4;font-size:.66rem;color:var(--tl-ink3);display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.tl-d{display:inline-block;padding:1px 6px;border-radius:5px;font-weight:650;font-variant-numeric:tabular-nums}
.tl-rec{color:#ffd27a;border:1px solid rgba(255,210,122,.45);border-radius:5px;padding:0 5px}
.tl-locked{position:relative}
.tl-locked > .tl-frost{filter:blur(5px);opacity:.55;pointer-events:none;user-select:none}
.tl-lock{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:2}
.tl-lock button{background:rgba(9,16,30,.92);color:var(--tl-ink);border:1px solid rgba(111,211,255,.5);border-radius:999px;
  padding:6px 14px;font:inherit;font-size:.74rem;font-weight:650;cursor:pointer}
.tl-lock button:hover{border-color:var(--tl-accent)}
.tl-place form{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}
.tl-place input{flex:1 1 200px;background:var(--tl-s2);border:1px solid var(--tl-border);border-radius:999px;color:var(--tl-ink);padding:6px 12px;font:inherit;font-size:.8rem}
.tl-place form button{background:var(--tl-s2);border:1px solid var(--tl-border);border-radius:999px;color:var(--tl-ink);padding:6px 14px;font:inherit;font-size:.78rem;cursor:pointer}
.tl-today{display:flex;gap:12px;flex-wrap:wrap;align-items:baseline;margin:0 0 10px}
.tl-today .big{font-size:1.6rem;font-weight:700;font-variant-numeric:tabular-nums}
.tl-today .what{font-size:.74rem;color:var(--tl-ink3);line-height:1.45}
.tl-days{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px;margin:0 0 6px}
.tl-day{background:var(--tl-s2);border-radius:9px;padding:6px 4px;text-align:center;font-size:.7rem;color:var(--tl-ink3);min-width:0}
.tl-day b{display:block;color:var(--tl-ink);font-size:.82rem;font-variant-numeric:tabular-nums;margin:2px 0}
.tl-days-wrap{position:relative}
.tl-cal{--sc-s2:#111c30;--sc-ink:#e8f0fb;--sc-ink2:#bcc9dc;--sc-ink3:#8193ae;--sc-ink4:#5f7192;--sc-accent:#6fd3ff;container-type:inline-size;margin-top:10px}
.tl-cal-mock{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.tl-cal-mock span{min-height:44px;border-radius:7px;background:#111c30}
.tl-cal-mock span:nth-child(3n){background:color-mix(in srgb,#ff8c5a 22%,#111c30)}
.tl-cal-mock span:nth-child(5n){background:color-mix(in srgb,#6ea8ff 22%,#111c30)}
.tl-fine{font-size:.66rem;color:var(--tl-ink4);line-height:1.45;margin:6px 0 0}
@container (max-width:560px){.tl-days{grid-template-columns:repeat(4,minmax(0,1fr))}.tl-tile .v{font-size:1.05rem}}
${CALENDAR_CSS}
`;

function injectStyles(doc) {
    if (doc.getElementById(STYLE_ID)) return;
    const el = doc.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    doc.head.appendChild(el);
}

// ── Map pixels (pure-ish: write into an ImageData-shaped buffer) ────────────

/** Paint the 72×36 field for a mode into `data` (RGBA, row 0 = NORTH). */
export function paintField(grid, mode, data, luts) {
    const lut = mode === 'temperature' ? luts.temp : luts.anomaly;
    for (let j = 0; j < H; j++) {
        for (let i = 0; i < W; i++) {
            const c = j * W + i;                 // cell index counts from the SOUTH
            const o = ((H - 1 - j) * W + i) * 4;
            let f = null;
            if (mode === 'temperature') f = isNum(grid?.tmeanC?.[c]) ? tempToRampFrac(grid.tmeanC[c]) : null;
            else if (mode === 'rarity') f = percentileToFrac(grid?.percentile?.[c]);
            else f = anomalyToFrac(grid?.anomalyK?.[c]);
            if (f === null) { data[o + 3] = 0; continue; }     // a gap stays a gap
            const k = Math.round(f * 255) * 4;
            data[o] = lut[k]; data[o + 1] = lut[k + 1]; data[o + 2] = lut[k + 2]; data[o + 3] = 235;
        }
    }
    return data;
}

// ── Mount ───────────────────────────────────────────────────────────────────

/**
 * @param {HTMLElement} host
 * @param {object} o
 * @param {'page'|'earthview'} [o.variant]
 * @param {'C'|'F'} [o.unit]
 * @param {(want: string) => void} [o.onLocked]   a locked control was clicked
 * @param {(row: object, card: string) => void} [o.onRow]
 * @param {(q: {surface?: string, region?: string|null}) => void} [o.onFilter]
 * @param {(unit: 'C'|'F') => void} [o.onUnit]
 * @param {(query: string) => void} [o.onPlaceQuery]
 * @param {(action: string, meta?: object) => void} [o.onAction]  telemetry
 * @param {string[]} [o.regions]  names for the region filter
 */
export function mountTemperatureLab(host, {
    variant = 'page', unit = 'C', onLocked = () => {}, onRow = () => {}, onFilter = () => {},
    onUnit = () => {}, onPlaceQuery = () => {}, onAction = () => {}, regions = [],
} = {}) {
    const doc = host.ownerDocument;
    injectStyles(doc);
    const state = {
        body: null, access: 'teaser', limits: { rows: 3, filters: false, outlookDays: 3, calendar: false },
        unit, mode: 'anomaly', place: null, surface: 'land', region: null,
    };
    const showMap = variant === 'page';

    host.classList.add('tl-root');
    host.innerHTML = `
      <div class="tl-status" data-tl="status"></div>
      <section class="tl-sec" aria-labelledby="tl-strip-h">
        <h2 id="tl-strip-h">The planet right now</h2>
        <p class="tl-sub">Trailing 24 hours against the 1991–2020 normal for the date (ERA5). Each number carries the value it would have in a normal climate.</p>
        <div class="tl-strip" data-tl="strip"></div>
      </section>
      ${showMap ? `
      <section class="tl-sec" aria-labelledby="tl-map-h">
        <div class="tl-maphead">
          <h2 id="tl-map-h" style="margin:0">Where it is unusual</h2>
          <div class="tl-seg" role="group" aria-label="Map mode" data-tl="modes">
            ${MAP_MODES.map(m => `<button type="button" data-mode="${m.id}" aria-pressed="${m.id === 'anomaly'}">${m.label}</button>`).join('')}
          </div>
        </div>
        <p class="tl-sub" data-tl="mapsub"></p>
        <div class="tl-mapwrap" data-tl="mapwrap">
          <canvas width="${CANVAS_W}" height="${CANVAS_H}" data-tl="map" role="img" aria-label="World map of today's temperature departure from normal"></canvas>
        </div>
        <div class="tl-legend" data-tl="legend"></div>
      </section>` : ''}
      <section class="tl-sec" aria-labelledby="tl-cards-h">
        <h2 id="tl-cards-h">Scorecards</h2>
        <p class="tl-sub">Of the grid points we sample. Rows are at least 1,500 km apart so one hot spell is one row; "most unusual" ranks by how RARE the day is for that place and date, not by degrees.</p>
        <div class="tl-controls" data-tl="controls">
          <div class="tl-seg" role="group" aria-label="Surface" data-tl="surface">
            <button type="button" data-surface="land" aria-pressed="true">Land</button>
            <button type="button" data-surface="ocean" aria-pressed="false">Ocean</button>
            <button type="button" data-surface="all" aria-pressed="false">All</button>
          </div>
          <label>Region <select data-tl="region"><option value="">Whole planet</option>
            ${regions.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select></label>
        </div>
        <div data-tl="cardnote"></div>
        <div class="tl-cards" data-tl="cards"></div>
      </section>
      <section class="tl-sec tl-place" aria-labelledby="tl-place-h">
        <h2 id="tl-place-h">Your place</h2>
        <form data-tl="placeform" role="search">
          <input type="search" name="q" placeholder="City, zip, or address" aria-label="Find a place" autocomplete="off">
          <button type="submit">Show</button>
        </form>
        <div data-tl="place"><p class="tl-empty">Pick a place to see how its day compares with normal.</p></div>
      </section>
      <div class="tl-tip" data-tl="tip" hidden></div>`;

    const $ = (k) => host.querySelector(`[data-tl="${k}"]`);
    const tip = $('tip');
    const luts = { anomaly: buildAnomalyLUTPixels(), temp: buildTempLUTPixels() };

    // ── tips (map hover + any [data-tip] in the panel, textContent only) ────
    function showTip(text, x, y) {
        tip.textContent = text;
        tip.hidden = false;
        const hb = host.getBoundingClientRect();
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let left = x - hb.left + 14, top = y - hb.top + 14;
        if (left + tw > hb.width - 4) left = x - hb.left - tw - 14;
        if (top + th > hb.height - 4) top = y - hb.top - th - 14;
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = `${Math.max(4, top)}px`;
    }
    const hideTip = () => { tip.hidden = true; };
    host.addEventListener('pointerover', (e) => {
        const t = e.target.closest?.('[data-tip]');
        if (t && host.contains(t)) showTip(t.getAttribute('data-tip'), e.clientX, e.clientY);
    });
    host.addEventListener('pointerout', (e) => { if (e.target.closest?.('[data-tip]')) hideTip(); });
    host.addEventListener('focusin', (e) => {
        const t = e.target.closest?.('[data-tip]');
        if (t) { const r = t.getBoundingClientRect(); showTip(t.getAttribute('data-tip'), r.left, r.bottom); }
    });
    host.addEventListener('focusout', hideTip);

    // ── map ─────────────────────────────────────────────────────────────────
    let ctx = null, cellCanvas = null, cellCtx = null, coast = null, coastTried = false;
    if (showMap) {
        const canvas = $('map');
        ctx = canvas.getContext('2d');
        cellCanvas = doc.createElement('canvas');
        cellCanvas.width = W; cellCanvas.height = H;
        cellCtx = cellCanvas.getContext('2d');
        $('modes').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-mode]');
            if (!b || b.dataset.mode === state.mode) return;
            state.mode = b.dataset.mode;
            for (const x of $('modes').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
            drawMap(); drawLegend();
            onAction('mode', { mode: state.mode });
        });
        canvas.addEventListener('pointermove', (e) => {
            const g = state.body?.grid;
            if (!g) return;
            const r = canvas.getBoundingClientRect();
            const lon = ((e.clientX - r.left) / r.width) * 360 - 180;
            const lat = 90 - ((e.clientY - r.top) / r.height) * 180;
            const c = cellIndex(Math.max(-89.9, Math.min(89.9, lat)), lon);
            showTip(cellTip(g, c, lat, lon), e.clientX, e.clientY);
        });
        canvas.addEventListener('pointerleave', hideTip);
        loadCoast();
    }

    function loadCoast() {
        if (coastTried) return;
        coastTried = true;
        const img = new Image();
        img.onload = () => {
            try {
                const off = doc.createElement('canvas');
                off.width = CANVAS_W; off.height = CANVAS_H;
                const oc = off.getContext('2d', { willReadFrequently: true });
                oc.drawImage(img, 0, 0, CANVAS_W, CANVAS_H);
                const src = oc.getImageData(0, 0, CANVAS_W, CANVAS_H).data;
                const out = oc.createImageData(CANVAS_W, CANVAS_H);
                const water = (x, y) => src[(y * CANVAS_W + x) * 4] > 127;
                for (let y = 1; y < CANVAS_H - 1; y++) {
                    for (let x = 1; x < CANVAS_W - 1; x++) {
                        const w = water(x, y);
                        if (w !== water(x + 1, y) || w !== water(x, y + 1)) {
                            const o = (y * CANVAS_W + x) * 4;
                            out.data[o] = 6; out.data[o + 1] = 10; out.data[o + 2] = 20; out.data[o + 3] = 170;
                        }
                    }
                }
                oc.putImageData(out, 0, 0);
                coast = off;
            } catch (_) { coast = null; }
            drawMap();
        };
        img.onerror = () => { coast = null; drawMap(); };
        img.src = COAST_SRC;
    }

    function cellTip(g, c, lat, lon) {
        const u = state.unit;
        const where = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'} · 5° grid point`;
        const t = g.tmeanC?.[c], a = g.anomalyK?.[c], p = g.percentile?.[c];
        if (!isNum(t)) return `${where}\nNo data in this window.`;
        const normal = isNum(a) ? t - a : null;
        return `${where}\n24-h mean ${fmtTemp(t, u)} · normal ${fmtTemp(normal, u)}\n${fmtDelta(a, u)} · ${rarityPhrase(p, state.body?.windowMidpoint)}`;
    }

    function drawMap() {
        if (!ctx) return;
        ctx.fillStyle = '#040a16';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
        const g = state.body?.grid;
        if (g) {
            const im = cellCtx.createImageData(W, H);
            paintField(g, state.mode, im.data, luts);
            cellCtx.putImageData(im, 0, 0);
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(cellCanvas, 0, 0, CANVAS_W, CANVAS_H);
        }
        ctx.strokeStyle = 'rgba(255,255,255,.07)';
        ctx.lineWidth = 1;
        for (let lon = -150; lon <= 150; lon += 30) {
            const x = (lon + 180) / 360 * CANVAS_W;
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
        }
        for (let lat = -60; lat <= 60; lat += 30) {
            const y = (90 - lat) / 180 * CANVAS_H;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
        }
        if (coast) ctx.drawImage(coast, 0, 0);
        const sub = $('mapsub');
        if (sub) {
            sub.textContent = state.mode === 'temperature'
                ? '24-h mean air temperature at 2 m. Smoothed between 5° grid points; a gap is left dark.'
                : state.mode === 'rarity'
                    ? 'Where today sits in the 1991–2020 distribution for the date: white is the middle, deep red is warmer than 99 % of those days, deep blue colder than 99 %.'
                    : 'Departure of the 24-h mean from the 1991–2020 normal for the date. The scale is denser near zero (most of the planet sits within ±3°) — the legend shows where.';
        }
    }

    function drawLegend() {
        const el = $('legend');
        if (!el) return;
        const u = state.unit;
        let ticks, lut;
        if (state.mode === 'temperature') {
            lut = luts.temp;
            ticks = [-40, -20, 0, 20, 40].map(c => [tempToRampFrac(c), `${Math.round(toUnit(c, u))}°`]);
        } else if (state.mode === 'rarity') {
            lut = luts.anomaly;
            ticks = [1, 10, 50, 90, 99].map(p => [percentileToFrac(p), `p${p}`]);
        } else {
            lut = luts.anomaly;
            ticks = [-8, -3, 0, 3, 8].map(k => [anomalyToFrac(k), fmtDelta(k, u, 0).replace(`°${u}`, '°')]);
        }
        el.innerHTML = `<div><canvas width="256" height="1" data-tl="lut"></canvas><div class="ticks">${
            ticks.map(([f, t]) => `<span style="left:${(f * 100).toFixed(1)}%">${esc(t)}</span>`).join('')}</div></div>
            <span>${state.mode === 'rarity' ? 'percentile for the date, 1991–2020' : `°${u}${state.mode === 'anomaly' ? ' vs normal' : ''}`}</span>`;
        const lc = el.querySelector('canvas').getContext('2d');
        const im = lc.createImageData(256, 1);
        im.data.set(lut);
        lc.putImageData(im, 0, 0);
    }

    // ── status + strip ──────────────────────────────────────────────────────
    function drawStatus() {
        const s = statusOf(state.body);
        const u = state.unit;
        $('status').innerHTML = `<span class="tl-chip ${s.level}" data-freshness="${s.level}"><i></i>${esc(s.label)}</span>
            <span>${esc(s.text)}</span>
            <span class="tl-units" role="group" aria-label="Units">
              <button type="button" data-unit="C" aria-pressed="${u === 'C'}">°C</button>
              <button type="button" data-unit="F" aria-pressed="${u === 'F'}">°F</button>
            </span>`;
        if (state.body?.note) $('status').title = state.body.note;
    }
    $('status').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-unit]');
        if (!b || b.dataset.unit === state.unit) return;
        handle.setUnit(b.dataset.unit);
        onUnit(state.unit);
    });

    function tile(k, v, b, color) {
        return `<div class="tl-tile"><div class="k">${esc(k)}</div><div class="v"${color ? ` style="color:${color}"` : ''}>${esc(v)}</div><div class="b">${b}</div></div>`;
    }
    function drawStrip() {
        const p = state.body?.planet, u = state.unit;
        if (!p) { $('strip').innerHTML = `<p class="tl-empty">${esc(statusOf(state.body).text || 'No data yet.')}</p>`; return; }
        const pct = (v) => (isNum(v) ? `${Math.round(v * 100)}%` : '—');
        const hot = p.hottest ? rowPlace(p.hottest) : null, cold = p.coldest ? rowPlace(p.coldest) : null;
        $('strip').innerHTML = [
            tile('Global mean vs normal', fmtDelta(p.anomalyK, u, 2),
                `land ${esc(fmtDelta(p.landAnomalyK, u))} · ocean ${esc(fmtDelta(p.oceanAnomalyK, u))} · area-weighted, ${pct(p.coverage)} of the planet has data`,
                isNum(p.anomalyK) ? anomalyCss(p.anomalyK) : null),
            tile('Land in its top decile', pct(p.landTopDecile),
                `warmer than 90 % of 1991–2020 for the date · <b>normal: ${Math.round(p.decileExpected * 100)}%</b>`),
            tile('Land in its bottom decile', pct(p.landBottomDecile),
                `colder than 90 % of 1991–2020 for the date · <b>normal: ${Math.round(p.decileExpected * 100)}%</b>`),
            tile('Hottest sampled point', p.hottest ? fmtTemp(p.hottest.valueC, u) : '—',
                hot ? `${esc(hot.name)} · 24-h max` : 'no data'),
            tile('Coldest sampled point', p.coldest ? fmtTemp(p.coldest.valueC, u) : '—',
                cold ? `${esc(cold.name)} · 24-h min` : 'no data'),
            tile('Beyond 1991–2020 · hot / cold', `${p.recordHighCells ?? 0} / ${p.recordLowCells ?? 0}`,
                'land grid points past anything in ERA5 1991–2020 for the date — not station records'),
        ].join('');
    }

    // ── cards ───────────────────────────────────────────────────────────────
    function rowHtml(row, i, def) {
        const u = state.unit, pl = rowPlace(row);
        const isSwing = def.key === 'swings';
        const delta = isSwing ? row.changeK : row.anomalyK;
        const [r, g, b] = isNum(delta) ? rampColorAt(anomalyToFrac(delta)) : [40, 50, 70];
        const chip = `<span class="tl-d" style="background:rgb(${r},${g},${b});color:${inkOn([r, g, b])}">${esc(fmtDelta(delta, u))}${isSwing ? ' day over day' : ''}</span>`;
        const rec = row.beyondRecord ? `<span class="tl-rec" title="beyond 1991–2020 in ERA5 for the date at this grid point">beyond 1991–2020</span>` : '';
        const tipText = `${pl.name} (${pl.sub})\n${def.stat === 'max' ? '24-h max' : def.stat === 'min' ? '24-h min' : '24-h mean'} ${fmtTemp(row.valueC, u)} · normal ${fmtTemp(row.normalC, u)}\n${rarityPhrase(row.percentile, state.body?.windowMidpoint)}${row.cls ? ` · ${CLASS_WORDS[row.cls]}` : ''}`;
        return `<li class="tl-row" tabindex="0" data-card="${def.key}" data-i="${i}" data-tip="${esc(tipText)}">
            <span class="n">${i + 1}</span>
            <span class="p"><b>${esc(pl.name)}</b><small>${esc(pl.sub)}</small></span>
            <span class="v">${esc(fmtTemp(row.valueC, u))}</span>
            <span class="r">${chip}<span>${esc(def.key === 'above' || def.key === 'below' ? rarityPhrase(row.percentile, state.body?.windowMidpoint) : `normal ${fmtTemp(row.normalC, u)}`)}</span>${rec}</span>
          </li>`;
    }

    function drawCards() {
        const cards = state.body?.cards;
        const note = state.body?.disclosure?.note;
        $('cardnote').innerHTML = note ? `<p class="tl-note">${esc(note)}</p>` : '';
        if (!cards) {
            $('cards').innerHTML = `<p class="tl-empty">${esc(statusOf(state.body).text || 'No data yet.')} The cards return as soon as the live aggregate does.</p>`;
            return;
        }
        const n = state.limits.rows;
        const nextRung = state.access === 'teaser' ? 'See the top 10 — free' : state.access === 'free' ? null : null;
        $('cards').innerHTML = CARD_DEFS.map((def) => {
            const rows = cards[def.key] ?? [];
            const shown = rows.slice(0, n);
            const frosted = nextRung ? rows.slice(n, n + 2) : [];
            const hue = def.key === 'hottest' || def.key === 'above' ? '#d6604d' : def.key === 'swings' ? '#f0a343' : '#4393c3';
            return `<article class="tl-card" data-card="${def.key}">
                <h3><i style="background:${hue}"></i>${esc(def.title)}</h3>
                <div class="what">${esc(def.what)} · ${esc(universeWords())}</div>
                ${rows.length ? `<ol class="tl-rows">${shown.map((r, i) => rowHtml(r, i, def)).join('')}</ol>` : '<p class="tl-empty">No grid point qualifies in this selection.</p>'}
                ${frosted.length ? `<div class="tl-locked"><ol class="tl-rows tl-frost" aria-hidden="true">${frosted.map((r, i) => rowHtml(r, n + i, def)).join('')}</ol>
                    <div class="tl-lock"><button type="button" data-lock="rows">🔒 ${esc(nextRung)}</button></div></div>` : ''}
              </article>`;
        }).join('');
    }

    function universeWords() {
        const s = state.surface === 'ocean' ? 'ocean' : state.surface === 'all' ? 'land and ocean' : 'land';
        return state.region ? `${s} · ${state.region}` : s;
    }

    $('cards').addEventListener('click', (e) => {
        const lock = e.target.closest('[data-lock]');
        if (lock) { onLocked(lock.dataset.lock); return; }
        const li = e.target.closest('.tl-row');
        if (!li) return;
        const row = state.body?.cards?.[li.dataset.card]?.[Number(li.dataset.i)];
        if (!row) return;
        pulseAt(row.lat, row.lon);
        onRow(row, li.dataset.card);
        onAction('fly_to', { card: li.dataset.card, rank: Number(li.dataset.i) + 1 });
    });
    $('cards').addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('tl-row')) { e.preventDefault(); e.target.click(); }
    });

    $('surface').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-surface]');
        if (!b) return;
        if (!state.limits.filters) { onLocked('filters'); return; }
        if (b.dataset.surface === state.surface) return;
        state.surface = b.dataset.surface;
        for (const x of $('surface').querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
        onFilter({ surface: state.surface });
        onAction('filter', { surface: state.surface });
    });
    $('region').addEventListener('pointerdown', (e) => {
        if (!state.limits.filters) { e.preventDefault(); onLocked('filters'); }
    });
    $('region').addEventListener('keydown', (e) => {
        if (!state.limits.filters && e.key !== 'Tab') { e.preventDefault(); onLocked('filters'); }
    });
    $('region').addEventListener('change', (e) => {
        if (!state.limits.filters) { e.target.value = ''; onLocked('filters'); return; }
        state.region = e.target.value || null;
        onFilter({ region: state.region });
        onAction('filter', { region: state.region });
    });

    function pulseAt(lat, lon) {
        const wrap = $('mapwrap');
        if (!wrap) return;
        wrap.querySelector('.tl-pulse')?.remove();
        const p = doc.createElement('span');
        p.className = 'tl-pulse';
        p.style.left = `${((lon + 180) / 360) * 100}%`;
        p.style.top = `${((90 - lat) / 180) * 100}%`;
        wrap.appendChild(p);
        setTimeout(() => p.remove(), 4400);
    }

    // ── your place ──────────────────────────────────────────────────────────
    $('placeform').addEventListener('submit', (e) => {
        e.preventDefault();
        const q = new FormData(e.target).get('q')?.toString().trim();
        if (q) { onPlaceQuery(q); onAction('place', { via: 'search' }); }
    });

    /** The place cell's today, from the snapshot grid (the MAP's normal). */
    function placeToday() {
        const loc = state.place?.loc, g = state.body?.grid;
        if (!loc || !g) return null;
        const c = cellIndex(loc.lat, loc.lon);
        const t = g.tmeanC?.[c], a = g.anomalyK?.[c], p = g.percentile?.[c];
        return isNum(t) ? { tmeanC: t, anomalyK: a, percentile: p, normalC: isNum(a) ? t - a : null } : null;
    }

    function drawPlace() {
        const el = $('place');
        const pl = state.place;
        if (!pl?.loc) { el.innerHTML = '<p class="tl-empty">Pick a place to see how its day compares with normal.</p>'; return; }
        const u = state.unit;
        const today = placeToday();
        const name = pl.loc.city || pl.loc.displayName || `${pl.loc.lat.toFixed(2)}, ${pl.loc.lon.toFixed(2)}`;
        let html = `<div class="tl-today"><span class="big">${today ? esc(fmtTemp(today.tmeanC, u)) : '—'}</span>
            <span class="what"><b>${esc(name)}</b>${pl.loc.approx ? ' <small>(from your time zone — search to set your place)</small>' : ''} · last 24 h at the nearest 5° grid point<br>${today
                ? `normal ${esc(fmtTemp(today.normalC, u))} · <span class="tl-d" style="background:${anomalyCss(today.anomalyK, '#223')};color:${isNum(today.anomalyK) ? inkOn(rampColorAt(anomalyToFrac(today.anomalyK))) : '#fff'}">${esc(fmtDelta(today.anomalyK, u))}</span> · ${esc(rarityPhrase(today.percentile, state.body?.windowMidpoint))}`
                : 'no live value for this grid point right now'}</span></div>`;

        const temp = pl.temp;
        if (pl.status === 'error' && pl.error && temp?.available) html += `<p class="tl-note">${esc(pl.error)}</p>`;
        if (pl.status === 'loading') html += '<p class="tl-fine">Loading the outlook…</p>';
        else if (!temp?.available) html += `<p class="tl-fine">The outlook is unavailable right now${pl.error ? ` (${esc(pl.error)})` : ''}.</p>`;
        else {
            const days = (temp.outlook?.days ?? []).slice(0, 7);
            const open = state.limits.outlookDays;
            const years = temp.clim?.years ? `${temp.clim.years[0]}–${temp.clim.years[1]}` : null;
            const dayCell = (d) => {
                const wd = d.lead === 0 ? 'Today' : new Date(d.t).toLocaleDateString(undefined, { weekday: 'short' });
                const hi = isNum(d.hiF) ? Math.round(toUnit((d.hiF - 32) * 5 / 9, u)) : '—';
                const lo = isNum(d.loF) ? Math.round(toUnit((d.loF - 32) * 5 / 9, u)) : '—';
                const an = isNum(d.anomF) ? (d.anomF * 5 / 9) : null;
                const bg = isNum(an) ? anomalyCss(an) : 'transparent';
                const tipText = `${new Date(d.t).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}\nHigh ${hi}° · Low ${lo}°${isNum(an) && years ? `\n${fmtDelta(an, u)} vs the ${years} normal at this point` : ''}`;
                return `<div class="tl-day" data-tip="${esc(tipText)}" tabindex="0">${esc(wd)}<b>${hi}°/${lo}°</b><span class="tl-d" style="background:${bg};color:${isNum(an) ? inkOn(rampColorAt(anomalyToFrac(an))) : 'inherit'}">${isNum(an) ? esc(fmtDelta(an, u, 0)) : '—'}</span></div>`;
            };
            html += `<div class="tl-days-wrap"><div class="tl-days">${days.slice(0, open).map(dayCell).join('')}`;
            if (open < days.length) {
                html += `</div><div class="tl-locked"><div class="tl-days tl-frost" aria-hidden="true">${days.slice(open).map(dayCell).join('')}</div>
                    <div class="tl-lock"><button type="button" data-lock="outlook">🔒 See all 7 days — free</button></div></div>`;
            } else html += '</div>';
            html += `</div><p class="tl-fine">The week is Open-Meteo's forecast; its departures are against ${years ? `the ${years} normal at this point (Open-Meteo archive)` : 'this point\'s recent normal'} — a different normal from the map's 1991–2020 ERA5, and labelled so.</p>`;
            html += `<h3 style="margin:14px 0 0;font-size:.86rem">30-day outlook</h3>`;
            if (state.limits.calendar) {
                html += `<div class="tl-cal">${monthCalendarHtml(temp, { unit: u })}</div>
                    <p class="tl-fine">Days 1–16: model forecast. Beyond: the normal for the date plus the model's departure fading on a time constant fitted from this place's own history${isNum(temp.outlook?.tau) ? ` (τ ${temp.outlook.tau.toFixed(1)} d)` : ''}. Dashed days carry a typical miss in their tip.</p>`;
            } else {
                html += `<div class="tl-cal tl-locked"><div class="tl-cal-mock tl-frost" aria-hidden="true">${'<span></span>'.repeat(35)}</div>
                    <div class="tl-lock"><button type="button" data-lock="calendar">🔒 30-day outlook · Basic</button></div></div>`;
            }
        }
        el.innerHTML = html;
    }
    $('place').addEventListener('click', (e) => {
        const lock = e.target.closest('[data-lock]');
        if (lock) onLocked(lock.dataset.lock);
    });

    function renderAll() {
        drawStatus(); drawStrip(); drawCards(); drawPlace();
        if (showMap) { drawMap(); drawLegend(); }
        host.dataset.freshness = state.body?.freshness ?? 'none';
    }

    const handle = {
        render(body) { state.body = body; renderAll(); },
        setAccess(access, limits) {
            state.access = access; state.limits = limits;
            host.dataset.access = access;
            drawCards(); drawPlace();
        },
        setPlace(place) { state.place = place; drawPlace(); },
        setUnit(next) {
            state.unit = next === 'F' ? 'F' : 'C';
            renderAll();
        },
        get state() { return { ...state }; },
        destroy() { host.innerHTML = ''; host.classList.remove('tl-root'); },
    };
    renderAll();
    return handle;
}
