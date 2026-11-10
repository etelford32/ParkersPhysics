/**
 * climalytix/page.js — climalytix.html's DOM layer (P0: the Explore timeline).
 * ═══════════════════════════════════════════════════════════════════════════
 * CLIMALYTIX_PLAN.md §10 + §13 P0. This module DRAWS and WIRES; it computes
 * nothing. Numbers come from the PURE kernels (series.js, catalog.js,
 * timeline-model.js) and the Climate Lab modules they import; fetching is
 * loaders.js.
 *
 * Rules this module keeps, each inherited:
 *   · ONE LOCATION STORE. The site is the CURRENT VIEW (`ppx_user_location`,
 *     js/user-location.js); a search is a VISIT through lab-home.js `visit`,
 *     so the dashboard, EarthView and every other card follow the same place
 *     and "Return home" means the account's Home (plan §15.1).
 *   · STABLE CONTROLS. The site search, range buttons and selects are built
 *     once in the HTML; data refreshes re-render the catalogue and panels
 *     only, so a half-typed query is never wiped (the verdict-card lesson).
 *   · ONE DEAD FEED IS ONE RED CHIP. Loaders never reject; if EVERY feed is
 *     down the page says so in words and draws no panels — feeds down must
 *     look down, never quiet (the Compounding Watch rule).
 *   · UNITS CONVERT ONCE, at display, through lab-units `fmt`.
 */

import { DATASETS, PANELS, ROLES, variableSpec, normalizeWorkspace, RANGE_IDS } from './catalog.js';
import {
    RANGES, chooseStep, windowFor, panelModel, panelSvg, timeTicks, readoutAt, msAtX, tickDecimals,
} from './timeline-model.js';
import { DAY_MS } from './series.js';
import { loadDataset, loadField, loadWindField, loadAqField, loadMonitors, loadSlopeForcing, loadThermalField, loadUpdraftField, loadConvectionField } from './loaders.js';
import { fieldWindow } from './point-tile.js';
import { tempControlState, overlayBadge } from './layer-state.js';
import { keyPixels, keyFrac, keyTicks } from './heat-scale.js';
import { lapseText } from './terrain-temp.js';
import { effectPaint, EFFECT_FULL_K } from './sun-temp.js';
import { horizonAt } from './sun-terrain.js';
import { capePaint, CAPE_MIN_JKG, CAPE_FULL_JKG, OUTLOOK_COLORS, TRIGGER_MIN_MS, CIN_WEAK_JKG } from './convection.js';
import { updraftPaint, W_FULL_MS } from './updraft.js';
import { thermalPaint, WSTAR_FLOOR, WSTAR_FULL } from './thermals.js';
import { windRose, prevailing, pollutionRose, ROSE_SPEED_EDGES, FLOW_SPEED_TOP_MS } from './airflow.js';
import { pm25Aqi, alignByInstant } from './aq-field.js';
import { fieldSample } from './map-view.js';
import { AQI_CATEGORIES, AQI_POLLUTANTS, categoryForAqi } from '../aqi-scale.js';
import { windColor } from '../wind-palette.js';
import { mountMap, HEAT_ALPHA_DEFAULT } from './map.js';
import { tempToRampFrac } from '../temp-ramp.js';
import { exposurePaint, EXPOSURE_FULL_LOG2 } from './terrain.js';
import { orographicPaint, formatW, OROGRAPHIC_FULL_MS } from './orographic.js';
import { resolveUnits, fmt, fmtText, fromDisplay, QUANTITIES } from '../climate-lab/lab-units.js';
import { homeState, visit, sameLocation, cleanLoc } from '../climate-lab/lab-home.js';
import { geocodeQuery } from '../user-location.js';

const WS_KEY = 'pp_climalytix_v1';
const WS_EVENT = 'climalytix-workspace';
const PANEL_H = 128;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
    ws: null,
    units: null,
    site: null,          // { lat, lon, city }
    home: null,
    results: new Map(),  // datasetId → loader result
    loading: new Set(),
    utcOffsetS: 0,
    models: [],
    abort: null,
    sync: null,
    map: null,           // the location map (map.js)
    field: null,         // { state, body, note } from loadField
    aq: null,            // { state, body, note } from loadAqField
    roseMode: 'wind',    // 'wind' | 'pm25'
    monKey: '',          // the hour the monitors were fetched for
};

// ── Workspace (local-first) ─────────────────────────────────────────────────

function loadWorkspace() {
    try { return normalizeWorkspace(JSON.parse(localStorage.getItem(WS_KEY) || 'null')); }
    catch { return normalizeWorkspace(null); }
}

function saveWorkspace(ws, { source = 'local' } = {}) {
    S.ws = normalizeWorkspace(ws);
    try { localStorage.setItem(WS_KEY, JSON.stringify(S.ws)); } catch {}
    S.units = resolveUnits(S.ws.units, navigator.language);
    if (source === 'local') window.dispatchEvent(new CustomEvent(WS_EVENT));
}

// ── Site ────────────────────────────────────────────────────────────────────

function resolveSite() {
    const p = new URLSearchParams(location.search);
    const lat = Number(p.get('lat')), lon = Number(p.get('lon'));
    if (p.has('lat') && p.has('lon') && Number.isFinite(lat) && Number.isFinite(lon)) {
        const c = visit({ lat, lon, city: p.get('name') || `${lat.toFixed(2)}, ${lon.toFixed(2)}` });
        if (c) return { site: c, ...homeState({ auth: null }) };
    }
    const st = homeState({ auth: null });
    return { site: st.view || st.home || null, ...st };
}

function renderSiteBar() {
    const s = S.site;
    $('#cx-site-name').textContent = s ? (s.city || 'Unnamed site') : 'No site yet';
    $('#cx-site-coords').textContent = s
        ? `${Math.abs(s.lat).toFixed(3)}°${s.lat >= 0 ? 'N' : 'S'} ${Math.abs(s.lon).toFixed(3)}°${s.lon >= 0 ? 'E' : 'W'}`
        : 'Search for a place to analyse';
    const atHome = !!(S.home && s && sameLocation(S.home, s));
    const badge = $('#cx-site-badge');
    badge.hidden = !s;
    badge.textContent = atHome ? 'HOME' : 'VISITING';
    badge.dataset.kind = atHome ? 'home' : 'visit';
    $('#cx-home-btn').hidden = !(S.home && s && !atHome);
}

async function onSearch(ev) {
    ev.preventDefault();
    const q = $('#cx-search').value.trim();
    if (!q) return;
    const msg = $('#cx-search-msg');
    msg.textContent = 'Searching…';
    try {
        const r = await geocodeQuery(q);
        S.site = visit({ ...r, city: r.city });
        msg.textContent = '';
        renderSiteBar();
        loadAll();
    } catch (e) {
        msg.textContent = e?.message || 'Search failed';
    }
}

function goHome() {
    if (!S.home) return;
    S.site = visit(S.home);
    renderSiteBar();
    loadAll();
}

// ── Loading ─────────────────────────────────────────────────────────────────

function loadAll({ only = null } = {}) {
    if (!S.site) { renderCatalog(); renderPanels(); return; }
    if (!only) { S.abort?.abort(); S.abort = new AbortController(); }
    const signal = S.abort.signal;
    const ids = only ? [only] : DATASETS.map((d) => d.id);
    for (const id of ids) {
        S.loading.add(id);
        if (!only) S.results.delete(id);
    }
    renderCatalog();
    renderPanels();
    const site = S.site;
    if (!only) loadMapField(site, signal);
    for (const id of ids) {
        loadDataset(id, site, S.ws, { signal }).then((r) => {
            if (signal.aborted || S.site !== site) return;
            S.loading.delete(id);
            S.results.set(id, r);
            if ((id === 'era5' || id === 'station') && Number.isFinite(r.utcOffsetS)) S.utcOffsetS = r.utcOffsetS;
            if (id === 'gfs') renderRose();
            renderCatalog();
            renderPanels();
        });
    }
}

// ── Location map + its layers ───────────────────────────────────────────────

function loadMapField(site, signal) {
    S.map?.setSite(site);
    S.field = { state: 'loading', body: null, note: 'Loading the temperature field…' };
    S.map?.setField('loading', null, S.field.note);
    loadField(site, { signal, win: fieldWin(site) }).then((r) => {
        if (signal.aborted || S.site !== site) return;
        S.field = r;
        S.map?.setField(r.state, r.body, r.note);
    });
    S.aq = { state: 'loading', body: null, note: 'Loading the air-quality field…' };
    S.map?.setAq('loading', null, S.aq.note);
    S.monKey = '';
    S.map?.setMonitors('idle', [], '');
    loadAqField(site, { signal }).then((r) => {
        if (signal.aborted || S.site !== site) return;
        S.aq = r;
        S.map?.setAq(r.state, r.body, r.note);
        $('#cx-rose-mode [data-rose="pm25"]').disabled = !r.body;
        if (!r.body && S.roseMode === 'pm25') setRoseMode('wind');
        renderRose();
    });
    S.map?.setWind('loading', null, 'Loading the wind field…');
    S.slopeSite = null;
    requestSlopeForcing();
    S.thermalSite = null;
    requestThermals();
    S.updraftSite = null;
    requestUpdraft();
    S.convectionSite = null;
    requestConvection();
    renderRose();
    loadWindField(site, { signal, win: fieldWin(site) }).then((r) => {
        if (signal.aborted || S.site !== site) return;
        S.map?.setWind(r.state, r.body, r.note);
    });
}

/**
 * The GFS field window for this map (visual pass V2): the full latitude
 * half-width and as much longitude as the stage shows for it, so a fill
 * covers the map instead of a narrow column (point-tile.js fieldWindow).
 * Before the stage has a size, the old square ±4° window.
 */
function fieldWin(site) {
    const sz = S.map?.state?.size;
    return sz?.w > 0 && sz?.h > 0 ? fieldWindow({ aspect: sz.w / sz.h, lat: site.lat }) : null;
}

/**
 * The slope-wind forcing (GFS cloud + 2 m T) is fetched on FIRST enable of
 * the layer, once per site — every other visitor pays nothing for it.
 */
function requestSlopeForcing() {
    if (!$('#cx-layer-slope')?.checked || !S.site || !S.map || S.slopeSite === S.site) return;
    const site = S.site;
    S.slopeSite = site;
    S.map.setSlopeForcing('loading', null, 'Loading the cloud field…', false);
    loadSlopeForcing(site, { win: fieldWin(site) }).then((r) => {
        if (S.site !== site) return;
        S.map.setSlopeForcing(r.state, r.body, r.note, r.cloud);
    });
}

/** Thermal fields are fetched on FIRST enable of the layer, once per site. */
function requestThermals() {
    if (!$('#cx-layer-th')?.checked || !S.site || !S.map || S.thermalSite === S.site) return;
    const site = S.site;
    S.thermalSite = site;
    S.map.setThermals('loading', null, '');
    loadThermalField(site, { win: fieldWin(site) }).then((r) => {
        if (S.site !== site) return;
        S.map.setThermals(r.state, r.body, r.note);
    });
}

/** The vertical-motion field is fetched on FIRST enable of the layer, once per site. */
function requestUpdraft() {
    if (!$('#cx-layer-up')?.checked || !S.site || !S.map || S.updraftSite === S.site) return;
    const site = S.site;
    S.updraftSite = site;
    S.map.setUpdraft('loading', null, '');
    loadUpdraftField(site, { win: fieldWin(site) }).then((r) => {
        if (S.site !== site) return;
        S.map.setUpdraft(r.state, r.body, r.note);
    });
}

/** V4: which rail groups the reader collapsed, per browser (a convenience; never required). */
const GROUPS_KEY = 'cx_rail_groups_v1';
function rememberGroups() {
    let shut = [];
    try { shut = JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]'); } catch { shut = []; }
    for (const g of document.querySelectorAll('#cx-map-layers .cx-group')) {
        if (Array.isArray(shut) && shut.includes(g.id)) g.open = false;
        g.addEventListener('toggle', () => {
            const now = [...document.querySelectorAll('#cx-map-layers .cx-group')].filter((x) => !x.open).map((x) => x.id);
            try { localStorage.setItem(GROUPS_KEY, JSON.stringify(now)); } catch { /* storage unavailable: session only */ }
        });
    }
}

/**
 * ONE KEY PER FILL, ON THE MAP (visual pass V3). The active fill's key is
 * the SAME element the rail built — moved, not copied, so the map shows
 * exactly the bytes the rail used to — into #cx-map-key while its layer is on,
 * and put back where it came from (a comment placeholder marks the spot) when
 * it is not. Fills are one-at-a-time, so at most one key is on the map.
 */
const MAP_KEYS = [
    // `ok`: a key is on the map only while its field is DRAWN (layer-state.js) —
    // a colour key over a map with no temperature on it reads as a broken layer.
    { box: '#cx-layer-temp', key: '#cx-heat-key', ok: () => S.tempCtl?.keyOnMap === true,
      title: () => (S.map?.state.frame?.view === 'sun' ? `Sun, shade & cold-air effect · ${unitSym('temp')} · modelled`
          : `Temperature · 2 m · ${unitSym('temp')}${S.map?.heatScale.mode === 'fit' ? ' · fit to view' : ''}`) },
    { box: '#cx-layer-aq', key: '#cx-aq-key', title: () => 'PM2.5 · US AQI category' },
    { box: '#cx-layer-exp', key: '#cx-exp-key', title: () => 'Sun exposure · vs flat ground' },
    { box: '#cx-layer-oro', key: '#cx-oro-key', title: () => 'Orographic lift · surface' },
    { box: '#cx-layer-th', key: '#cx-th-key', title: () => 'Thermal strength · w*' },
    { box: '#cx-layer-up', key: '#cx-up-key', title: () => 'Vertical motion · GFS 25 km mean' },
    { box: '#cx-layer-cv', key: '#cx-cv-key', title: () => 'Storm ingredients' },
];
const keyHomes = new Map();
function syncMapKey() {
    const host = $('#cx-map-key'), body = host?.querySelector('.cx-mk-body');
    if (!body) return;
    const active = MAP_KEYS.find((k) => $(k.box)?.checked && $(k.key) && (k.ok?.() ?? true));
    for (const k of MAP_KEYS) {
        const el = $(k.key);
        if (!el) continue;
        if (!keyHomes.has(k.key)) { const mark = document.createComment(`key ${k.key}`); el.before(mark); keyHomes.set(k.key, mark); }
        if (k === active) { if (el.parentElement !== body) body.append(el); }
        else if (el.parentElement === body) keyHomes.get(k.key).after(el);
    }
    host.hidden = !active;
    if (active) host.querySelector('.cx-mk-title').textContent = active.title();
}

/** The convection ingredients are fetched on FIRST enable of the layer, once per site. */
function requestConvection() {
    if (!$('#cx-layer-cv')?.checked || !S.site || !S.map || S.convectionSite === S.site) return;
    const site = S.site;
    S.convectionSite = site;
    S.map.setConvection('loading', null, '');
    loadConvectionField(site, { win: fieldWin(site) }).then((r) => {
        if (S.site !== site) return;
        S.map.setConvection(r.state, r.body, r.note);
    });
}

function paintConvectionKey() {
    const px = new Uint8ClampedArray(4), stops = [];
    for (let k = 0; k <= 20; k++) {
        px.fill(0); capePaint(CAPE_MIN_JKG + (CAPE_FULL_JKG - CAPE_MIN_JKG) * k / 20 + 1e-9, px, 0);
        stops.push(`rgba(${px[0]},${px[1]},${px[2]},${(px[3] / 255).toFixed(3)}) ${k * 5}%`);
    }
    $('#cx-cv-key .cx-cv-bar').style.background = `linear-gradient(90deg, ${stops.join(', ')}), #2a3446`;
    const t = $('#cx-cv-key .cx-exp-ticks').children;
    t[0].textContent = `${CAPE_MIN_JKG} J/kg`; t[2].textContent = `${CAPE_FULL_JKG}+`;
    for (const sw of document.querySelectorAll('#cx-cv-cats [data-cat]')) {
        const spec = OUTLOOK_COLORS[sw.dataset.cat];
        sw.querySelector('i').style.background = spec ? `rgba(${spec[0].map((x) => Math.round(x * 255)).join(',')},${spec[1]})` : 'transparent';
    }
}

const CV_WORDS = { none: 'no instability', capped: 'capped', possible: 'possible', likely: 'likely' };
/** Rail status for convection: the ingredients at the site, the next 48 h strip, what is not counted. */
function renderConvectionRail(info) {
    const st = $('#cx-cv-status');
    if (!info || info.state === 'off') { st.textContent = ''; return; }
    st.dataset.state = info.state;
    if (info.state === 'loading') { st.textContent = info.note || 'Loading…'; return; }
    if (info.state === 'down' || info.state === 'notime') { st.textContent = info.note; return; }
    const hhmm = (ms) => new Date(ms + S.utcOffsetS * 1000).toISOString().slice(11, 16);
    const wd = (ms) => new Date(ms + S.utcOffsetS * 1000).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' });
    const r = info.site;
    let site = 'No convection estimate at the site.';
    if (r) {
        const lift = r.best ? `thermals w* ${r.best.w.toFixed(1)} m/s` : 'no thermals';
        const lid = Math.abs(r.cinJkg) <= CIN_WEAK_JKG ? 'a weak lid'
            : `a lid that needs ${r.lid.toFixed(0)} m/s of lift to push through`;
        site = `<b>${esc(hhmm(info.timeMs))} local at the site: storms ${esc(CV_WORDS[r.category])}.</b> `
            + `CAPE ${Math.round(r.capeJkg)} J/kg (${esc(r.capeBand)}), CIN ${Math.round(r.cinJkg)} J/kg — ${esc(lid)}; `
            + (Number.isFinite(r.liK) ? `lifted index ${r.liK.toFixed(1)} K (${esc(r.liBand)}); ` : '')
            + `${esc(lift)}. Parcel ceiling √(2·CAPE) = ${r.wmax.toFixed(0)} m/s — an upper bound; real storm cores reach about half.`;
    }
    const cells = (info.strip || []).map((x) => `<span class="cx-cv-cell" data-cat="${esc(x.category || 'none')}" title="${esc(wd(x.t))} ${esc(hhmm(x.t))}: ${esc(x.category ? CV_WORDS[x.category] : 'no data')}"><b>${esc(hhmm(x.t).slice(0, 2))}</b></span>`).join('');
    st.innerHTML = `${site}<br>Next 48 h at the site (local hour, GFS steps):<div class="cx-cv-strip">${cells}</div>`
        + `An ingredients check (energy · lid · lift), not a probability. Lift counted: thermals (≥ ${TRIGGER_MIN_MS} m/s) only — forced lift over terrain and fronts is not counted yet. ${esc(info.note || '')}`;
}

function paintUpdraftKey() {
    const px = new Uint8ClampedArray(4), stops = [];
    for (let k = 0; k <= 20; k++) {
        const w = (k / 10 - 1) * W_FULL_MS;
        px.fill(0); updraftPaint(w, px, 0);
        stops.push(`rgba(${px[0]},${px[1]},${px[2]},${(px[3] / 255).toFixed(3)}) ${k * 5}%`);
    }
    $('#cx-up-key .cx-up-bar').style.background = `linear-gradient(90deg, ${stops.join(', ')}), #2a3446`;
    const t = $('#cx-up-key .cx-exp-ticks').children;
    t[0].textContent = `−${W_FULL_MS * 100} cm/s sinking`; t[2].textContent = `+${W_FULL_MS * 100} cm/s rising`;
}

/** Rail status for the updraft layer: the level, the mask, and the vertical-motion LIST at the site. */
function renderUpdraftRail(info) {
    const st = $('#cx-up-status');
    if (!info || info.state === 'off') { st.textContent = ''; return; }
    st.dataset.state = info.state;
    if (info.state === 'loading') { st.textContent = info.note || 'Loading…'; return; }
    if (info.state === 'down' || info.state === 'notime') { st.textContent = info.note; return; }
    const hhmm = new Date(info.timeMs + S.utcOffsetS * 1000).toISOString().slice(11, 16);
    const h = (m) => (m == null || !Number.isFinite(m) ? '' : fmtText('height', m, S.units));
    const mask = info.masked === info.nodes ? `${info.level} hPa is below the ground across this whole view — choose a higher level.`
        : info.masked ? `${info.level} hPa is below the ground at ${Math.round(100 * info.masked / info.nodes)} % of the window (left blank).` : '';
    const rows = (info.budget || []).map((r) => {
        const val = r.w == null ? '—' : `${r.w >= 0 ? '+' : '−'}${Math.abs(r.w) >= 1 ? Math.abs(r.w).toFixed(1) + ' m/s' : (Math.abs(r.w) * 100).toFixed(1) + ' cm/s'}`;
        const at = r.heightM == null ? '' : r.kind === 'surface' ? 'at the ground' : `~${h(r.heightM)} up`;
        return `<tr><td>${esc(r.label)}</td><td class="num">${esc(val)}</td><td>${esc(at)}</td></tr>`;
    }).join('');
    st.innerHTML = `<b>${esc(hhmm)} local, ${info.level} hPa.</b> ${esc(mask)}`
        + `<br>Vertical motion at the site — different things at different heights, <b>not added</b>:`
        + `<table class="cx-vm">${rows}</table>${esc(info.note || '')}`;
}

/** The w* key: the map's own painter from 0 to WSTAR_FULL + a margin. */
function paintThermalKey() {
    const px = new Uint8ClampedArray(4), stops = [];
    const top = WSTAR_FULL;
    for (let k = 0; k <= 20; k++) {
        const w = WSTAR_FLOOR + (top - WSTAR_FLOOR) * k / 20;
        px.fill(0); thermalPaint(w + 1e-9, px, 0);
        stops.push(`rgba(${px[0]},${px[1]},${px[2]},${(px[3] / 255).toFixed(3)}) ${k * 5}%`);
    }
    $('#cx-th-key .cx-th-bar').style.background = `linear-gradient(90deg, ${stops.join(', ')}), #2a3446`;
    const ticks = $('#cx-th-key .cx-exp-ticks').children;
    ticks[0].textContent = `${WSTAR_FLOOR} m/s`; ticks[2].textContent = `${WSTAR_FULL}+`;
}

/** Rail status for thermals: the site now, the day's window, the strongest in view. */
function renderThermalRail(info) {
    const st = $('#cx-th-status');
    if (!info || info.state === 'off') { st.textContent = ''; return; }
    st.dataset.state = info.state;
    if (info.state === 'loading') { st.textContent = info.note || 'Loading…'; return; }
    if (info.state === 'down' || info.state === 'notime') { st.textContent = info.note; return; }
    const hhmm = (ms) => new Date(ms + S.utcOffsetS * 1000).toISOString().slice(11, 16);
    const h = (m) => fmtText('height', m, S.units);
    const r = info.site;
    const now = !r ? 'No thermal estimate at the site.'
        : r.regime === 'none' ? 'At the site: no thermals — the ground is not heating the air.'
        : `At the site: w* ${r.wstar.toFixed(1)} m/s (${r.strength}), `
          + (r.regime === 'cu' ? `cumulus base ${h(r.baseM)} above the ground (boundary layer to ${h(r.ziM)}).`
                               : `blue thermals to ${h(r.topM)} above the ground (cloud base would be ${h(r.lclM)}).`);
    const day = info.fromMs != null
        ? `Today: w* ≥ 1 m/s from ${hhmm(info.fromMs)} to ${hhmm(info.toMs)} local${info.peak ? `, peak ${info.peak.wstar.toFixed(1)} m/s in the window ending ${hhmm(info.peak.endMs)}` : ''}.`
        : info.peak ? `Today: weak only — peak ${info.peak.wstar.toFixed(1)} m/s in the window ending ${hhmm(info.peak.endMs)} local.`
        : 'Today: no thermals at the site.';
    const m = info.maxInView;
    const where = m ? ` Strongest in view: ${m.wstar.toFixed(1)} m/s at ${Math.abs(m.lat).toFixed(2)}°${m.lat >= 0 ? 'N' : 'S'} ${Math.abs(m.lon).toFixed(2)}°${m.lon >= 0 ? 'E' : 'W'}.` : '';
    st.innerHTML = `<b>${esc(hhmm(info.timeMs))} local.</b> ${esc(now)}<br>${esc(day)}${esc(where)}<br>${esc(info.note || '')}`;
}

/** Rail status for slope winds: the regime in view, the strongest flow, the forcing's source. */
function renderSlopeRail(info) {
    const st = $('#cx-slope-status');
    if (!info || info.state === 'off') { st.textContent = ''; return; }
    st.dataset.state = info.state;
    if (info.state === 'loading') { st.textContent = info.note || 'Loading…'; return; }
    if (info.state === 'nodem') { st.textContent = 'Elevation tiles unavailable — no slopes, so no slope winds.'; return; }
    const local = new Date(info.timeMs + S.utcOffsetS * 1000);
    const c = info.counts || {};
    const regime = (c.anabatic || 0) > (c.katabatic || 0) ? 'Daytime heating: air is sliding UP the sunlit slopes.'
        : (c.katabatic || 0) > 0 ? 'Cooling: air is draining DOWN the slopes.' : 'No slope wind: heating and cooling balance.';
    const where = (p) => `${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(2)}°${p.lon >= 0 ? 'E' : 'W'}`;
    const sp = (u) => fmtText('wind', Math.abs(u), S.units);
    st.innerHTML = `<b>${esc(local.toUTCString().slice(0, 3))} ${esc(local.toISOString().slice(11, 16))} local.</b> ${esc(regime)}`
        + (info.up ? `<br>Strongest upslope: ${esc(sp(info.up.u))} at ${where(info.up)}.` : '')
        + (info.down ? `<br>Strongest downslope: ${esc(sp(info.down.u))} at ${where(info.down)}.` : '')
        + `<br>${esc(info.forcingNote || '')}`
        + (!info.cloud && !(info.forcingNote || '').includes('UPPER') ? ' The cloud field does not cover this time: clear sky assumed, so these are UPPER bounds.' : '');
}

/** Rail status for the airflow layer. */
function renderFlowRail(info) {
    const st = $('#cx-flow-status');
    setRowBadge('#cx-layer-airflow', overlayBadge({ checked: $('#cx-layer-airflow').checked, state: info.state, t: info.t }));
    if (!$('#cx-layer-airflow').checked) { st.textContent = 'Airflow layer off.'; st.dataset.state = 'off'; return; }
    st.dataset.state = info.state;
    if (info.state === 'loading') { st.textContent = 'Loading the wind field…'; return; }
    if (info.state === 'down') { st.textContent = info.note; return; }
    if (info.t == null) { st.textContent = 'The run does not cover this time — no wind is held past its end.'; st.dataset.state = 'down'; return; }
    const local = new Date(info.timeMs + S.utcOffsetS * 1000);
    st.innerHTML = `<b>Wind at ${esc(local.toUTCString().slice(0, 3))} ${esc(local.toISOString().slice(11, 16))} local</b>`
        + ` · streaks ${esc(info.compressionLabel || '')} of travel<br>${esc(info.note)}`;
}

/**
 * The wind rose of the site's GFS hours (airflow.js windRose): petals point
 * to where the wind comes FROM, stacked by speed class in the ONE wind
 * palette. Drawn on a canvas; the caption says the prevailing direction.
 */
function renderRose() {
    const host = $('#cx-rose'), c = host.querySelector('canvas'), cap = $('#cx-rose-caption');
    const w = S.results.get('gfs')?.wind;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    if (!w) { cap.textContent = S.results.has('gfs') ? 'No wind rose: our archive has no wind for this site.' : 'Wind rose: loading…'; S.rose = null; return; }
    if (S.roseMode === 'pm25' && S.aq?.body) return renderPollutionRose(w, ctx, c, cap);
    const rose = windRose(w.u, w.v);
    S.rose = rose;
    const cx = c.width / 2, cy = c.height / 2, R = c.width / 2 - 16;
    const maxF = Math.max(...rose.freq, 1e-9);
    // Rings at round shares of the hours.
    ctx.strokeStyle = 'rgba(232,241,248,.18)';
    ctx.lineWidth = 1;
    const ringStep = maxF > 0.3 ? 0.1 : maxF > 0.12 ? 0.05 : 0.02;
    for (let f = ringStep; f <= maxF + 1e-9; f += ringStep) {
        ctx.beginPath(); ctx.arc(cx, cy, R * f / maxF, 0, Math.PI * 2); ctx.stroke();
    }
    const width = 2 * Math.PI / rose.sectors;
    rose.counts.forEach((row, k) => {
        const ang = k * width - Math.PI / 2;          // sector k centred on k·22.5° clockwise from north
        let inner = 0;
        row.forEach((cnt, cls) => {
            if (!cnt) return;
            const outer = inner + cnt / rose.n;
            const lo = cls ? ROSE_SPEED_EDGES[cls - 1] : 0, hi = Number.isFinite(ROSE_SPEED_EDGES[cls]) ? ROSE_SPEED_EDGES[cls] : lo + 4;
            const col = windColor(Math.min(1, ((lo + hi) / 2) / FLOW_SPEED_TOP_MS), 0.01);
            ctx.fillStyle = `rgb(${(col[0] * 255) | 0},${(col[1] * 255) | 0},${(col[2] * 255) | 0})`;
            ctx.beginPath();
            ctx.arc(cx, cy, R * outer / maxF, ang - width * 0.42, ang + width * 0.42);
            ctx.arc(cx, cy, R * inner / maxF, ang + width * 0.42, ang - width * 0.42, true);
            ctx.closePath();
            ctx.fill();
            inner = outer;
        });
    });
    ctx.fillStyle = '#e8f1f8';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [lab, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
        const r = a * Math.PI / 180;
        ctx.fillText(lab, cx + (R + 9) * Math.sin(r), cy - (R + 9) * Math.cos(r));
    }
    const p = prevailing(rose);
    const calm = rose.n ? Math.round(100 * rose.calm / rose.n) : 0;
    cap.textContent = p
        ? `Next ${Math.round((w.times.at(-1) - w.times[0]) / 86_400_000)} days (${rose.n} forecast hours): mostly from the ${p.name} (${Math.round(p.freq * 100)} % of hours)${calm ? `, calm ${calm} %` : ''}.`
        : 'Calm through the run.';
}

/**
 * Paint the colour key from the scale the map is drawing with (heat-scale.js):
 * the whole ramp for 'absolute', this run's range stretched along it for
 * 'fit'. Same function, same LUT bytes as the pixels on the map.
 */
let keySig = '';
function paintHeatKey() {
    const sc = S.map.heatScale;
    const view = S.map.state.frame?.view ?? 'temp';
    const sig = `${view}|${sc.mode}|${sc.lo}|${sc.hi}`;
    if (sig === keySig) return false;
    keySig = sig;
    const c = $('#cx-heat-key canvas');
    const img = c.getContext('2d').createImageData(256, 1);
    if (view === 'sun') {
        // The effect's own key: the map's painter from −FULL to +FULL over the dimmed ground's tone.
        for (let k = 0; k < 256; k++) {
            const px = new Uint8ClampedArray(4);
            effectPaint((k / 255 * 2 - 1) * EFFECT_FULL_K, px, 0);
            const a = px[3] / 255, bg = [42, 52, 70];
            img.data.set([px[0] * a + bg[0] * (1 - a), px[1] * a + bg[1] * (1 - a), px[2] * a + bg[2] * (1 - a), 255], k * 4);
        }
        c.getContext('2d').putImageData(img, 0, 0);
        $('#cx-heat-key').dataset.scale = 'effect';
        return true;
    }
    img.data.set(keyPixels(sc, S.map.lut, 256));
    c.getContext('2d').putImageData(img, 0, 0);
    $('#cx-heat-key').dataset.scale = sc.mode;
    return true;
}

/** Ticks at round values IN THE READER'S UNIT, placed on the key's own scale. */
function renderHeatTicks() {
    const sc = S.map.heatScale;
    const conv = { toDisplay: (c) => fmt('temp', c, S.units).value, fromDisplay: (d) => fromDisplay('temp', d, S.units) };
    let ticks;
    if ($('#cx-heat-key').dataset.scale === 'effect') {
        const full = conv.toDisplay(EFFECT_FULL_K) - conv.toDisplay(0);
        ticks = [[`−${full.toFixed(1)}° cooler`, 0.2], [`+${full.toFixed(1)}° warmer`, 0.8]].map(([label, frac]) => ({ label, frac }));
    } else if (sc.mode === 'fit') ticks = keyTicks(sc, conv);
    else {
        const unit = S.units?.temp === 'F' ? 'F' : 'C';
        ticks = (unit === 'F' ? [-40, 0, 40, 80, 120] : [-40, -20, 0, 20, 40])
            .map((d) => ({ label: `${d}°`, frac: tempToRampFrac(conv.fromDisplay(d)) }))
            .filter((t) => t.frac > 0.02 && t.frac < 0.98);
    }
    $('#cx-heat-key .cx-key-ticks').innerHTML = ticks.map((t) => `<span style="left:${(t.frac * 100).toFixed(1)}%">${esc(t.label)}</span>`).join('');
}

/** The Fit / Absolute control follows the map's mode (and a fit that had no range to fit). */
function syncScaleControl() {
    const want = S.map.state.heatScaleMode;
    for (const b of document.querySelectorAll('#cx-heat-scale [data-scale]')) b.setAttribute('aria-pressed', String(b.dataset.scale === want));
}

/**
 * A layer row's badge: its source ("Ours") while it can draw, or a plain
 * statement that there is nothing to draw. The source label is remembered on
 * the element, so the badge always returns to exactly what the markup said.
 */
function setRowBadge(boxSel, badge) {
    const src = $(boxSel)?.closest('.cx-layer')?.querySelector('.cx-layer-src');
    if (!src) return;
    src.dataset.source ??= src.textContent;
    src.textContent = badge ?? src.dataset.source;
    src.classList.toggle('cx-src-down', badge != null && badge !== 'Loading');
}

/**
 * THE TEMPERATURE CONTROLS FOLLOW THE DATA (layer-state.js): the checkbox
 * keeps the reader's intent, while the sub-toggles, the opacity slider, the
 * on-map key and the Retry button are live only while there is a field for
 * them to change. Called from every frame and from every fill switch.
 */
function applyTempControl(info) {
    const ctl = tempControlState({ checked: $('#cx-layer-temp').checked, fieldState: info?.state, frameT: info?.t, note: info?.note });
    const changed = S.tempCtl?.mode !== ctl.mode;
    S.tempCtl = ctl;
    for (const id of ['#cx-layer-iso', '#cx-layer-ext', '#cx-layer-tdetail', '#cx-heat-alpha']) $(id).disabled = !ctl.subEnabled;
    // Sun & shade rides on terrain detail: without the real ground there is no slope to light.
    $('#cx-layer-tsun').disabled = !ctl.subEnabled || !$('#cx-layer-tdetail').checked;
    $('#cx-layer-tpool').disabled = $('#cx-layer-tsun').disabled;      // cold-air pooling needs the real ground too
    const hasEffect = ctl.subEnabled && info?.detail?.state === 'on' && info.detail.effect?.live === true;
    for (const b of document.querySelectorAll('#cx-heat-view [data-view]')) {
        b.disabled = !ctl.subEnabled || (b.dataset.view === 'sun' && !hasEffect);
        b.setAttribute('aria-pressed', String(b.dataset.view === (info?.view ?? 'temp')));
    }
    for (const b of document.querySelectorAll('#cx-heat-scale [data-scale]')) b.disabled = !ctl.subEnabled;
    $('#cx-layer-temp').closest('.cx-layer').dataset.avail = ctl.mode;
    setRowBadge('#cx-layer-temp', ctl.badge);
    $('#cx-heat-retry').hidden = !ctl.canRetry;
    const notice = $('#cx-map-notice');
    notice.hidden = !ctl.notice;
    notice.querySelector('span').textContent = ctl.notice;
    notice.querySelector('button').hidden = !ctl.canRetry;
    if (changed) syncMapKey();
    return ctl;
}

/**
 * Ask our archive again (the Retry buttons): the temperature field, the wind
 * field and the site's GFS series come from the same run, so all three are
 * re-read — and only those; no other feed is re-fetched.
 */
function retryArchive() {
    if (!S.site || !S.map || S.field?.state === 'loading') return;
    const site = S.site, signal = S.abort.signal;
    S.field = { state: 'loading', body: null, note: 'Loading the temperature field…' };
    S.map.setField('loading', null, S.field.note);
    S.map.setWind('loading', null, 'Loading the wind field…');
    loadField(site, { signal, win: fieldWin(site), fresh: true }).then((r) => {
        if (signal.aborted || S.site !== site) return;
        S.field = r;
        S.map.setField(r.state, r.body, r.note);
    });
    loadWindField(site, { signal, win: fieldWin(site), fresh: true }).then((r) => {
        if (signal.aborted || S.site !== site) return;
        S.map.setWind(r.state, r.body, r.note);
    });
    loadAll({ only: 'gfs' });
}

/** The rail under the toggle: status, valid time, the window's range on the key. */
function renderHeatRail(info) {
    // The wind line shares the heat line's clock (local time is known only
    // once a site feed reports its offset — re-render it with every frame).
    if (S.map) renderFlowRail(S.map.state.wind);
    const st = $('#cx-heat-status');
    const win = $('#cx-heat-key .cx-key-win i');
    const ctl = applyTempControl(info);
    if (S.map && paintHeatKey()) { renderHeatTicks(); syncMapKey(); }
    if (ctl.mode === 'off') { st.textContent = 'Temperature layer off.'; st.dataset.state = 'off'; win.hidden = true; return; }
    if (ctl.mode !== 'on') {
        st.dataset.state = ctl.mode === 'loading' ? 'loading' : 'down';
        st.textContent = ctl.mode === 'loading' ? 'Loading the temperature field…'
            : ctl.mode === 'down' ? info.note
            : 'The run does not cover this time — no frame is held past its end.';
        win.hidden = true;
        return;
    }
    st.dataset.state = info.state;
    const local = new Date(info.timeMs + S.utcOffsetS * 1000);
    const when = `${local.toUTCString().slice(0, 3)} ${local.toISOString().slice(11, 16)} local`;
    // The field is interpolated to this minute between two GFS frames; say which.
    const leadH = (ms) => Math.round((ms - S.field.body.runMs) / 3_600_000);
    const bl = info.blend;
    const lead = bl && bl.i0 !== bl.i1 ? `${leadH(bl.t0Ms)} h → +${leadH(bl.t1Ms)} h, interpolated to the minute` : `${leadH(info.timeMs)} h`;
    const live = S.map?.state.timeMs == null;
    const range = info.range ? ` · window ${fmtText('temp', info.range.min, S.units)} – ${fmtText('temp', info.range.max, S.units)}` : '';
    const sc = S.map.heatScale;
    const scaleNote = sc.mode === 'fit'
        ? `Colours fit to this run’s range here, ${fmtText('temp', sc.lo, S.units)} – ${fmtText('temp', sc.hi, S.units)} — compare places with Absolute.`
        : 'Colours on the absolute scale EarthView uses.';
    // A temperature DIFFERENCE in the reader's unit (a 1 K step is 1.8 °F).
    const dT = (k, dp = 0) => { const v = fmt('temp', k, S.units).value - fmt('temp', 0, S.units).value; return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(dp)}`; };
    const d = info.detail;
    const detailNote = !d || d.state === 'off' ? 'Terrain detail off: GFS’s own 25 km field, interpolated.'
        : d.state === 'on' ? `Terrain detail: brought to the real ground with ${lapseText(d.lapse)}`
            + (d.correction ? `; corrections ${dT(d.correction.min)} to ${dT(d.correction.max)} ${unitSym('temp')} in view.` : '.')
        : d.state === 'nofields' ? 'Terrain detail unavailable: this run carries no surface pressure. GFS’s own field is shown.'
        : d.state === 'nodem' ? 'Terrain detail unavailable: elevation tiles did not load. GFS’s own field is shown.'
        : 'Terrain detail: loading elevation…';
    const sn = d?.state === 'on' ? d.sun : null;
    const bounds = sn ? [!sn.cloud && 'no cloud field — clear sky assumed', !sn.wind && 'no wind field — no mixing'].filter(Boolean) : [];
    const sunNote = !sn || sn.state === 'off' ? ''
        : sn.state === 'night' ? 'Sun & shade: the Sun has been down for hours here — no sunlight adjustment.'
        : `Sun & shade (modelled): ${dT(sn.range.min, 1)} to ${dT(sn.range.max, 1)} ${unitSym('temp')} in view — sun-facing slopes warmer, shaded ground cooler, with a ~1.5 h lag`
            + (bounds.length ? `; ${bounds.join(', ')}, so an upper bound.` : '.');
    // Night cold-air pooling (cold-pool.js): the night half of the same idea.
    const pl = d?.state === 'on' ? d.pool : null;
    const pBounds = pl ? [!pl.cloud && 'no cloud field — clear sky assumed', !pl.wind && 'no wind field — calm assumed'].filter(Boolean) : [];
    const poolNote = !pl || pl.state === 'off' ? (d?.state === 'on' && sn?.state === 'night' ? 'Cold-air pooling is switched off: valleys are not cooled at night.' : '')
        : pl.state === 'day' ? 'Cold-air pooling: none now — it builds after sunset and drains through the morning.'
        : `Cold-air pooling (modelled): ${dT(pl.range.min, 1)} to ${dT(pl.range.max, 1)} ${unitSym('temp')} in view — low ground colder, crests and upper slopes milder; ${Math.round(100 * pl.nightFrac)} % of a full night’s build-up`
            + (pBounds.length ? `; ${pBounds.join(', ')}, so an upper bound.` : '.');
    st.innerHTML = `<b>${live ? 'Now · ' : 'Valid '}${esc(when)}</b> (GFS +${lead})${esc(range)}<br>${esc(info.note)}<br>${esc(scaleNote)}<br><span id="cx-heat-detail" data-state="${esc(d?.state ?? 'off')}">${esc(detailNote)}</span>`
        + (sunNote ? `<br><span id="cx-heat-sun" data-state="${esc(sn.state)}">${esc(sunNote)}</span>` : '')
        + (poolNote ? `<br><span id="cx-heat-pool" data-state="${esc(pl.state)}">${esc(poolNote)}</span>` : '');
    if (info.range && info.view !== 'sun') {
        const a = keyFrac(sc, info.range.min), b = keyFrac(sc, info.range.max);
        win.hidden = false;
        win.style.left = `${(a * 100).toFixed(1)}%`;
        win.style.width = `${Math.max(1, (b - a) * 100).toFixed(1)}%`;
    } else win.hidden = true;
}

/**
 * The POLLUTION ROSE: the site's PM2.5 (CAMS, sampled at the site) joined to
 * the GFS wind BY INSTANT, binned by the direction the wind blows FROM.
 * Petal length = share of the joined hours; colour = the EPA category of the
 * sector's mean PM2.5. It answers "which direction brings the dirtiest air"
 * over the forecast window both feeds cover.
 */
function renderPollutionRose(w, ctx, c, cap) {
    const aq = S.aq.body;
    const pmAt = aq.times.map((_, t) => fieldSample(aq, t, S.site.lat, S.site.lon));
    const pm = alignByInstant(aq.times, pmAt, w.times);
    const rose = pollutionRose(w.u, w.v, pm);
    S.rose = rose;
    if (!rose) { cap.textContent = 'No hours where the wind run and the air-quality field overlap.'; return; }
    const cx = c.width / 2, cy = c.height / 2, R = c.width / 2 - 16;
    const maxF = Math.max(...rose.freq, 1e-9);
    ctx.strokeStyle = 'rgba(232,241,248,.18)';
    for (const f of [0.25, 0.5, 0.75, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
    const width = 2 * Math.PI / rose.sectors;
    rose.freq.forEach((f, k) => {
        if (!f) return;
        const cat = categoryForAqi(pm25Aqi(rose.mean[k]));
        const ang = k * width - Math.PI / 2;
        ctx.fillStyle = cat ? `rgb(${cat.rgb.map((x) => Math.round(x * 255)).join(',')})` : '#888';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, R * f / maxF, ang - width * 0.42, ang + width * 0.42);
        ctx.closePath();
        ctx.fill();
        ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(4,10,20,.7)'; ctx.stroke();
    });
    ctx.fillStyle = '#e8f1f8';
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const [lab, a] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
        const r = a * Math.PI / 180;
        ctx.fillText(lab, cx + (R + 9) * Math.sin(r), cy - (R + 9) * Math.cos(r));
    }
    const d = rose.dirtiest, k = rose.cleanest;
    const txt = (x) => `${x.mean.toFixed(1)} µg/m³ (AQI ${pm25Aqi(x.mean)})`;
    cap.textContent = d
        ? `Over ${rose.hours} forecast hours with both wind and PM2.5: the dirtiest air arrives from the ${d.name} (mean ${txt(d)}, ${d.hours} h)`
          + (k && k.sector !== d.sector ? `, the cleanest from the ${k.name} (${txt(k)}, ${k.hours} h).` : '.')
        : `Over ${rose.hours} hours no direction holds two or more hours.`;
}

function setRoseMode(mode) {
    S.roseMode = mode;
    for (const b of document.querySelectorAll('#cx-rose-mode [data-rose]')) b.setAttribute('aria-pressed', String(b.dataset.rose === mode));
    renderRose();
}

/** The EPA category bar, labelled with the PM2.5 breakpoints (µg/m³). */
function paintAqKey() {
    const bp = AQI_POLLUTANTS.pm25.breakpoints;
    $('#cx-aq-key .cx-aq-bands').innerHTML = AQI_CATEGORIES.map((c) =>
        `<i style="background:rgb(${c.rgb.map((x) => Math.round(x * 255)).join(',')})" title="${esc(c.name)}"></i>`).join('');
    $('#cx-aq-key .cx-aq-ticks').innerHTML = bp.map((b) => `<span>${b[0] === 0 ? '0' : b[0]}</span>`).join('');
}

/** The exposure key: the map's own painter across ±EXPOSURE_FULL_LOG2 stops (log axis). */
function paintExposureKey() {
    const px = new Uint8ClampedArray(4);
    const stops = [];
    for (let k = 0; k <= 20; k++) {
        const r = 2 ** ((k / 10 - 1) * EXPOSURE_FULL_LOG2);
        px.fill(0); exposurePaint(r, px, 0);
        stops.push(`rgba(${px[0]},${px[1]},${px[2]},${(px[3] / 255).toFixed(3)}) ${k * 5}%`);
    }
    const lo = (2 ** -EXPOSURE_FULL_LOG2).toFixed(2), hi = (2 ** EXPOSURE_FULL_LOG2).toFixed(2);
    $('#cx-exp-key .cx-exp-ticks').innerHTML = `<span>${lo}× shade</span><span>flat ground</span><span>${hi}× sun</span>`;
    $('#cx-exp-key .cx-exp-bar').style.background = `linear-gradient(90deg, ${stops.join(', ')}), #2a3446`;
}

/** The orographic key: the map's own painter from −FULL to +FULL m/s. */
function paintOroKey() {
    const px = new Uint8ClampedArray(4);
    const stops = [];
    for (let k = 0; k <= 20; k++) {
        const w = (k / 10 - 1) * OROGRAPHIC_FULL_MS;
        px.fill(0); orographicPaint(w, px, 0);
        stops.push(`rgba(${px[0]},${px[1]},${px[2]},${(px[3] / 255).toFixed(3)}) ${k * 5}%`);
    }
    $('#cx-oro-key .cx-oro-bar').style.background = `linear-gradient(90deg, ${stops.join(', ')}), #2a3446`;
    const ticks = $('#cx-oro-key .cx-exp-ticks').children;
    ticks[0].textContent = `−${OROGRAPHIC_FULL_MS} m/s down`; ticks[2].textContent = `+${OROGRAPHIC_FULL_MS} m/s up`;
}

/** Rail status for orographic lift: which wind frame, and the extremes in view. */
function renderOroRail(info) {
    const st = $('#cx-oro-status');
    if (!info || info.state === 'off') { st.textContent = ''; return; }
    st.dataset.state = info.state;
    if (info.state === 'loading') { st.textContent = 'Waiting for the wind field and the elevation tiles…'; return; }
    if (info.state === 'nowind') { st.textContent = `No wind field (${info.note || 'our GFS archive did not answer'}). Nothing stands in for it.`; return; }
    if (info.state === 'notime') { st.textContent = info.note; return; }
    if (info.state === 'nodem') { st.textContent = 'Elevation tiles unavailable — no slope, so no lift is drawn.'; return; }
    const feet = fmt('height', 0, S.units).sym === 'ft';
    const local = new Date(info.timeMs + S.utcOffsetS * 1000);
    const where = (p) => `${Math.abs(p.lat).toFixed(2)}°${p.lat >= 0 ? 'N' : 'S'} ${Math.abs(p.lon).toFixed(2)}°${p.lon >= 0 ? 'E' : 'W'}`;
    st.innerHTML = `<b>10 m wind of ${esc(local.toUTCString().slice(0, 3))} ${esc(local.toISOString().slice(11, 16))} local</b> (the airflow frame).`
        + `<br>Strongest forced ascent in view: ${info.up ? `${esc(formatW(info.up.w, { feet }))} at ${where(info.up)}` : 'none'}.`
        + `<br>Strongest forced descent: ${info.down ? `${esc(formatW(info.down.w, { feet }))} at ${where(info.down)}` : 'none'}.`;
}

/**
 * The Sun at the site today (sun-terrain.js): its path against the terrain
 * horizon on an azimuth × altitude chart, and the shadow count on the map.
 * The chart is centred on the Sun's culmination (south in the northern
 * hemisphere, north in the southern) so the path is one arc.
 */
function renderSunRail(info) {
    const st = $('#cx-sun-status'), box = $('#cx-sun');
    const wantPath = $('#cx-layer-sun').checked, wantShadow = $('#cx-layer-shadow').checked;
    box.hidden = !wantPath || !info?.path;
    st.hidden = !(wantPath || wantShadow);
    if (st.hidden || !info || info.state === 'off') return;
    st.dataset.state = info.state === 'ok' ? 'live' : info.state === 'nodem' ? 'down' : 'loading';
    const hhmm = (ms) => (ms == null ? '—' : new Date(ms + S.utcOffsetS * 1000).toISOString().slice(11, 16));
    const dur = (min) => `${Math.floor(min / 60)} h ${String(Math.round(min % 60)).padStart(2, '0')} min`;
    const parts = [];
    if (wantShadow) {
        const sh = info.shadow;
        parts.push(!sh ? (info.state === 'nodem' ? 'Elevation tiles unavailable — no shadows are drawn.' : 'Loading elevation for the shadows…')
            : sh.night ? `<b>${esc(hhmm(info.timeMs))} local: the Sun is down.</b> Night is not a shadow — nothing is drawn.`
            : `<b>${esc(hhmm(info.timeMs))} local, Sun ${sh.sun.alt.toFixed(0)}° up in the ${esc(compassWord(sh.sun.az))}:</b> terrain shades ${Math.round(100 * sh.shaded / Math.max(1, sh.shaded + sh.lit))} % of the view.`);
    }
    if (wantPath && info.path) {
        const d = info.day, o = info.open;
        if (o.polar === 'night') parts.push('The Sun does not rise at the site today.');
        else {
            parts.push(`Sunrise ${esc(hhmm(o.rise))}, sunset ${esc(hhmm(o.set))} local (flat horizon, ${esc(dur(o.sunMin))}); highest ${o.noon.alt.toFixed(0)}° at ${esc(hhmm(o.noon.t))}.`);
            parts.push(!info.horizon ? (info.state === 'nodem' ? 'Elevation tiles unavailable — the terrain horizon is not drawn.' : 'Loading elevation for the terrain horizon…')
                : d.directMin === 0 ? 'The terrain in view blocks the Sun all day at the site.'
                : d.lostMin < 2 * d.stepMin ? 'The terrain in view does not block the Sun at the site today.'
                : `Over the terrain the Sun is on the site from <b>${esc(hhmm(d.clearRise))}</b> to <b>${esc(hhmm(d.clearSet))}</b>: ${esc(dur(d.directMin))} of direct sun, ${esc(dur(d.lostMin))} taken by the terrain.`);
            if (info.horizon) parts.push(`Horizon from the map’s elevation grid (~${info.resM >= 1000 ? `${(info.resM / 1000).toFixed(1)} km` : `${Math.round(info.resM)} m`} nodes), seen out to at least ${Math.round(info.reachKm)} km — a ridge beyond the view is not counted; zoom out to include it. Times ± ${d.stepMin} min.`);
        }
        drawSunChart(info, hhmm);
    }
    st.innerHTML = parts.join('<br>');
}

const compassWord = (az) => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round((((az % 360) + 360) % 360) / 45) % 8];

function drawSunChart(info, hhmm) {
    const c = $('#cx-sun canvas'), g = c.getContext('2d');
    const W = c.width, H = c.height, L = 34, R = 8, T = 10, B = 28;
    const centre = info.open.noon.az > 90 && info.open.noon.az < 270 ? 180 : 0;      // where the Sun culminates
    const rel = (az) => ((az - centre + 540) % 360) - 180;                           // −180…180 about the centre
    const span = 150;
    const hMax = info.horizon ? Math.max(...info.horizon.angles) : 0;
    const top = Math.max(20, Math.ceil((Math.max(info.open.noon.alt, hMax) + 6) / 10) * 10);
    const X = (az) => L + ((rel(az) + span) / (2 * span)) * (W - L - R), Y = (alt) => H - B - (Math.max(0, alt) / top) * (H - T - B);
    g.clearRect(0, 0, W, H);
    g.font = '11px system-ui, sans-serif';
    g.strokeStyle = 'rgba(232,241,248,.14)'; g.fillStyle = 'rgba(232,241,248,.6)'; g.lineWidth = 1; g.textAlign = 'right'; g.textBaseline = 'middle';
    for (let a = 0; a <= top; a += top > 50 ? 20 : 10) { g.beginPath(); g.moveTo(L, Y(a)); g.lineTo(W - R, Y(a)); g.stroke(); g.fillText(`${a}°`, L - 5, Y(a)); }
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const [lab, off] of centre === 180 ? [['E', -90], ['SE', -45], ['S', 0], ['SW', 45], ['W', 90]] : [['W', -90], ['NW', -45], ['N', 0], ['NE', 45], ['E', 90]]) {
        g.fillText(lab, L + ((off + span) / (2 * span)) * (W - L - R), H - B + 14);
    }
    // The terrain horizon, as a silhouette.
    if (info.horizon) {
        g.beginPath(); g.moveTo(L, Y(0));
        for (let r = -span; r <= span; r += 1) g.lineTo(L + ((r + span) / (2 * span)) * (W - L - R), Y(horizonAt(info.horizon, centre + r)));
        g.lineTo(W - R, Y(0)); g.closePath();
        g.fillStyle = 'rgba(96,118,140,.55)'; g.fill();
        g.strokeStyle = 'rgba(190,210,228,.8)'; g.lineWidth = 1.2; g.stroke();
    }
    // The Sun's path: solid where it clears the terrain, faint where a ridge is in the way.
    const up = info.path.filter((p) => p.alt > 0 && Math.abs(rel(p.az)) <= span);
    for (const clear of [false, true]) {
        g.beginPath();
        let pen = false;
        for (const p of up) {
            const isClear = p.alt > horizonAt(info.horizon, p.az);
            if (isClear !== clear) { pen = false; continue; }
            if (pen) g.lineTo(X(p.az), Y(p.alt)); else g.moveTo(X(p.az), Y(p.alt));
            pen = true;
        }
        g.strokeStyle = clear ? '#ffc23d' : 'rgba(255,194,61,.35)'; g.lineWidth = clear ? 2.4 : 1.6; g.setLineDash(clear ? [] : [3, 3]); g.stroke();
    }
    g.setLineDash([]);
    // Local hours along the path.
    g.fillStyle = 'rgba(232,241,248,.75)'; g.textBaseline = 'bottom';
    for (const p of up) {
        const local = new Date(p.t + S.utcOffsetS * 1000);
        if (local.getUTCMinutes() !== 0 || local.getUTCHours() % 2) continue;
        g.beginPath(); g.arc(X(p.az), Y(p.alt), 2, 0, Math.PI * 2); g.fill();
        g.fillText(String(local.getUTCHours()), X(p.az), Y(p.alt) - 4);
    }
    // The Sun at the instant on the timeline.
    if (info.now.alt > 0 && Math.abs(rel(info.now.az)) <= span) {
        const blocked = info.now.alt <= horizonAt(info.horizon, info.now.az);
        g.beginPath(); g.arc(X(info.now.az), Y(info.now.alt), 6, 0, Math.PI * 2);
        g.fillStyle = blocked ? 'rgba(255,194,61,.35)' : '#ffd66b'; g.fill();
        g.strokeStyle = '#04101e'; g.lineWidth = 1.5; g.stroke();
    }
    $('#cx-sun-caption').textContent = `Today’s Sun at the site, by compass direction and height above the horizon; numbers are local hours. Grey: the terrain horizon. Dot: ${hhmm(info.timeMs)} local${info.now.alt > 0 ? '' : ' (the Sun is down)'}.`;
}

/** Rail status for the terrain layers (elevation contours, sun exposure). */
function renderDemRail(info) {
    const st = $('#cx-dem-status');
    const elev = $('#cx-layer-elev').checked, exp = $('#cx-layer-exp').checked, oro = $('#cx-layer-oro').checked;
    if (!elev && !exp && !oro && !$('#cx-layer-slope').checked && !$('#cx-layer-shadow').checked && !$('#cx-layer-sun').checked) { st.textContent = 'Terrain layers off.'; st.dataset.state = 'off'; return; }
    st.dataset.state = info?.state || 'loading';
    if (!info || info.state === 'idle' || info.state === 'loading') { st.textContent = info?.note || 'Loading elevation…'; return; }
    if (info.state === 'down') { st.textContent = info.note; return; }
    const parts = [info.note];
    if (elev && info.step != null) parts.push(`Contours every ${info.step.toLocaleString('en-US')} ${fmt('height', 0, S.units).sym}.`);
    if (exp) parts.push(info.mode === 'now'
        ? 'Exposure: the Sun at each point at the time on the timeline; night is blank.'
        : 'Exposure: today’s whole Sun track at the map centre, ÷ flat ground.');
    st.textContent = parts.join(' ');
}

/** Rail status for air quality; also asks for monitors for the hour on show. */
function renderAqRail(info) {
    const st = $('#cx-aq-status');
    if (!$('#cx-layer-aq').checked) { st.textContent = 'Air quality off.'; st.dataset.state = 'off'; return; }
    st.dataset.state = info.state;
    if (info.state === 'loading') { st.textContent = 'Loading the air-quality field…'; return; }
    if (info.state === 'down') { st.textContent = `${info.note} Nothing stands in for it.`; return; }
    if (info.t == null) { st.textContent = 'The air-quality field does not cover this time.'; st.dataset.state = 'down'; return; }
    const local = new Date(info.timeMs + S.utcOffsetS * 1000);
    const r = info.range;
    const mon = !$('#cx-layer-mon').checked ? 'Monitors off.'
        : info.monState === 'loading' ? 'Loading monitors…'
        : info.compared ? `${info.compared} monitors vs the model: bias ${info.bias >= 0 ? '+' : ''}${info.bias} µg/m³, mean miss ${info.mae} µg/m³ (model − measured). ${info.monNote}`
        : info.monNote || '';
    st.innerHTML = `<b>PM2.5 at ${esc(local.toUTCString().slice(0, 3))} ${esc(local.toISOString().slice(11, 16))} local</b>`
        + (r ? ` · window ${r.min.toFixed(1)}–${r.max.toFixed(1)} µg/m³` : '') + `<br>${esc(info.note)}<br>${esc(mon)}`;
    requestMonitors(info.timeMs);
}

/**
 * Fetch monitors once per hour on show. Observations exist only for the
 * past, and at "now" the nearest 3-hourly field instant can be up to 90 min
 * AHEAD of the clock — so the monitors are read at the latest hour no later
 * than now; the comparison still pairs them with a field instant ≤ 1.5 h away.
 */
function requestMonitors(shownMs) {
    if (!$('#cx-layer-aq').checked || !$('#cx-layer-mon').checked || !Number.isFinite(shownMs) || !S.site) return;
    const timeMs = Math.min(shownMs, Date.now());
    const key = `${S.site.lat},${S.site.lon},${Math.floor(timeMs / 3_600_000)}`;
    if (S.monKey === key) return;
    S.monKey = key;
    const site = S.site;
    S.map.setMonitors('loading', [], '');
    loadMonitors(site, timeMs).then((r) => {
        if (S.monKey !== key || S.site !== site) return;
        S.map.setMonitors(r.state, r.monitors, r.note);
    });
}

function mountLocationMap() {
    S.map = mountMap($('#cx-map'), {
        formatTemp: (c) => fmtText('temp', c, S.units),
        // A temperature DIFFERENCE in the reader's unit (1 K is 1.8 °F), one decimal.
        formatTempDelta: (k) => { const v = fmt('temp', k, S.units).value - fmt('temp', 0, S.units).value; return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} ${unitSym('temp')}`; },
        // Isotherm levels are chosen in the reader's unit (round °F for a °F reader).
        tempUnits: () => ({
            toDisplay: (c) => fmt('temp', c, S.units).value,
            fromDisplay: (d) => fromDisplay('temp', d, S.units),
            sym: fmt('temp', 0, S.units).sym,
        }),
        onFrame: renderHeatRail,
        formatWind: (ms) => fmtText('wind', ms, S.units),
        onWind: renderFlowRail,
        onAq: renderAqRail,
        onDem: renderDemRail,
        onSun: renderSunRail,
        onOro: renderOroRail,
        onSlope: renderSlopeRail,
        onThermals: renderThermalRail,
        onUpdraft: renderUpdraftRail,
        onConvection: renderConvectionRail,
        utcOffsetS: () => S.utcOffsetS,
        // Elevation levels are chosen in the reader's height unit (round feet for a ft reader).
        heightUnits: () => ({
            toDisplay: (m) => fmt('height', m, S.units).value,
            fromDisplay: (d) => fromDisplay('height', d, S.units),
            sym: fmt('height', 0, S.units).sym,
        }),
        formatHeight: (m) => fmtText('height', m, S.units),
    });
    paintHeatKey();
    renderHeatTicks();
    // ONE opacity: the slider starts where the map draws (it used to sit on a
    // 0.05 step grid that 0.62 is not on, so the thumb read 0.60 over a 0.62 map).
    $('#cx-heat-alpha').value = String(HEAT_ALPHA_DEFAULT);
    // Temperature and Air quality are one-at-a-time: two full-window fields
    // on one map read as neither.
    // Sun exposure is a full-window fill too, so it joins the same group.
    const showField = (which, on) => {
        const pick = (id, key) => (which === key ? on : (on ? false : $(id).checked));
        const temp = pick('#cx-layer-temp', 'temp'), aq = pick('#cx-layer-aq', 'aq'), exp = pick('#cx-layer-exp', 'exp'), oro = pick('#cx-layer-oro', 'oro');
        const th = pick('#cx-layer-th', 'th'), up = pick('#cx-layer-up', 'up'), cv = pick('#cx-layer-cv', 'cv');
        $('#cx-layer-temp').checked = temp; $('#cx-layer-aq').checked = aq; $('#cx-layer-exp').checked = exp; $('#cx-layer-oro').checked = oro;
        $('#cx-layer-th').checked = th; $('#cx-layer-up').checked = up; $('#cx-layer-cv').checked = cv;
        S.map.setLayer('convection', cv);
        $('#cx-cv-key').hidden = !cv; $('#cx-cv-status').hidden = !cv; $('#cx-cv-mode').hidden = !cv;
        if (cv) requestConvection();
        renderConvectionRail(S.map.state.convection);
        S.map.setLayer('updraft', up);
        $('#cx-up-key').hidden = !up; $('#cx-up-status').hidden = !up; $('#cx-up-level').hidden = !up;
        if (up) requestUpdraft();
        renderUpdraftRail(S.map.state.updraft);
        S.map.setLayer('temperature', temp); S.map.setLayer('airquality', aq); S.map.setLayer('exposure', exp); S.map.setLayer('orographic', oro);
        S.map.setLayer('thermals', th);
        $('#cx-th-key').hidden = !th; $('#cx-th-status').hidden = !th;
        if (th) requestThermals();
        renderThermalRail(S.map.state.thermals);
        $('#cx-oro-key').hidden = !oro; $('#cx-oro-status').hidden = !oro;
        renderOroRail(S.map.state.orographic);
        $('#cx-exp-mode').hidden = !exp; $('#cx-exp-key').hidden = !exp;
        renderDemRail(S.map.state.dem);
        renderHeatRail(S.map.state.frame);      // the Temperature controls follow the data (layer-state.js)
        $('#cx-layer-mon').disabled = !aq;
        $('#cx-aq-key').hidden = !aq;
        renderAqRail(S.map.state.aq);
        syncMapKey();
    };
    $('#cx-layer-temp').addEventListener('change', (ev) => showField('temp', ev.target.checked));
    $('#cx-layer-aq').addEventListener('change', (ev) => showField('aq', ev.target.checked));
    $('#cx-layer-exp').addEventListener('change', (ev) => showField('exp', ev.target.checked));
    $('#cx-layer-oro').addEventListener('change', (ev) => showField('oro', ev.target.checked));
    $('#cx-layer-th').addEventListener('change', (ev) => showField('th', ev.target.checked));
    $('#cx-layer-up').addEventListener('change', (ev) => showField('up', ev.target.checked));
    $('#cx-layer-cv').addEventListener('change', (ev) => showField('cv', ev.target.checked));
    $('#cx-cv-mode').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-cv]');
        if (!b) return;
        for (const x of $('#cx-cv-mode').querySelectorAll('[data-cv]')) x.setAttribute('aria-pressed', String(x === b));
        $('#cx-cv-key .cx-cv-bar').parentElement.dataset.mode = b.dataset.cv;
        S.map.setConvectionMode(b.dataset.cv);
    });
    $('#cx-up-level').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-level]');
        if (!b) return;
        for (const x of $('#cx-up-level').querySelectorAll('[data-level]')) x.setAttribute('aria-pressed', String(x === b));
        S.map.setUpdraftLevel(Number(b.dataset.level));
    });
    $('#cx-layer-slope').addEventListener('change', (ev) => {
        S.map.setLayer('slopewind', ev.target.checked);
        $('#cx-slope-key').hidden = !ev.target.checked; $('#cx-slope-status').hidden = !ev.target.checked;
        requestSlopeForcing();
        renderSlopeRail(S.map.state.slopewind);
    });
    $('#cx-layer-elev').addEventListener('change', (ev) => {
        S.map.setLayer('elevation', ev.target.checked);
        renderDemRail(S.map.state.dem);
    });
    $('#cx-exp-mode').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-exp]');
        if (!b) return;
        for (const x of $('#cx-exp-mode').querySelectorAll('[data-exp]')) x.setAttribute('aria-pressed', String(x === b));
        S.map.setExposureMode(b.dataset.exp);
    });
    $('#cx-layer-mon').addEventListener('change', (ev) => {
        S.map.setLayer('monitors', ev.target.checked);
        S.monKey = '';
        renderAqRail(S.map.state.aq);
    });
    $('#cx-rose-mode').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-rose]');
        if (b && !b.disabled) setRoseMode(b.dataset.rose);
    });
    paintAqKey();
    paintExposureKey();
    paintOroKey();
    paintThermalKey();
    paintUpdraftKey();
    paintConvectionKey();
    syncMapKey();
    rememberGroups();
    $('#cx-layer-iso').addEventListener('change', (ev) => S.map.setLayer('isotherms', ev.target.checked));
    $('#cx-layer-tdetail').addEventListener('change', (ev) => S.map.setLayer('tempdetail', ev.target.checked));
    $('#cx-layer-tsun').addEventListener('change', (ev) => S.map.setLayer('tempsun', ev.target.checked));
    $('#cx-layer-tpool').addEventListener('change', (ev) => S.map.setLayer('temppool', ev.target.checked));
    $('#cx-heat-view').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-view]');
        if (!b || b.disabled) return;
        S.map.setHeatView(b.dataset.view);
    });
    $('#cx-layer-shadow').addEventListener('change', (ev) => { S.map.setLayer('shadow', ev.target.checked); renderDemRail(S.map.state.dem); });
    $('#cx-layer-sun').addEventListener('change', (ev) => { S.map.setLayer('sunpath', ev.target.checked); renderDemRail(S.map.state.dem); });
    $('#cx-layer-ext').addEventListener('change', (ev) => S.map.setLayer('extremes', ev.target.checked));
    $('#cx-heat-alpha').addEventListener('input', (ev) => S.map.setHeatAlpha(Number(ev.target.value)));
    $('#cx-heat-scale').addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-scale]');
        if (!b || b.disabled) return;
        S.map.setHeatScale(b.dataset.scale);
        syncScaleControl();
    });
    syncScaleControl();
    $('#cx-heat-retry').addEventListener('click', retryArchive);
    $('#cx-map-notice button').addEventListener('click', retryArchive);
    $('#cx-layer-terrain').addEventListener('change', (ev) => S.map.setLayer('terrain', ev.target.checked));
    $('#cx-layer-labels').addEventListener('change', (ev) => S.map.setLayer('labels', ev.target.checked));
    $('#cx-layer-airflow').addEventListener('change', (ev) => {
        S.map.setLayer('airflow', ev.target.checked);
        renderFlowRail(S.map.state.wind);
    });
}

// ── Catalogue (left rail) ───────────────────────────────────────────────────

const STATE_LABEL = { live: 'Live', stale: 'Degraded', down: 'Down', loading: 'Loading' };

function renderCatalog() {
    const on = new Set(S.ws.on);
    const html = DATASETS.map((d) => {
        const r = S.results.get(d.id);
        const state = S.loading.has(d.id) ? 'loading' : (r?.state || (S.site ? 'loading' : 'down'));
        const fetched = r?.series?.[0]?.provenance?.fetchedAt;
        const vars = d.variables.map((v) => {
            const id = `${d.id}.${v.key}`;
            const have = r?.series?.some((s) => s.id === id);
            return `<label class="cx-var${have ? '' : ' is-missing'}">
                <input type="checkbox" data-series="${esc(id)}" ${on.has(id) ? 'checked' : ''}>
                <span class="cx-swatch cx-bg-s${v.slot}" aria-hidden="true"></span>
                <span class="cx-var-label">${esc(v.label)}</span>
                <span class="cx-var-agg" title="How this series aggregates into coarser buckets">${esc(v.agg)}</span>
            </label>`;
        }).join('');
        return `<section class="cx-ds" data-dataset="${esc(d.id)}">
            <header class="cx-ds-head">
                <span class="cx-ds-name">${esc(d.label)}</span>
                ${ROLES[d.role] ? `<span class="cx-role" data-role="${esc(d.role)}" title="${esc(ROLES[d.role].title)}">${esc(ROLES[d.role].label)}</span>` : ''}
                <span class="cx-chip" data-state="${state}">${STATE_LABEL[state]}</span>
            </header>
            <p class="cx-ds-meta"><span class="cx-kind">${esc(d.kind)}</span> · ${esc(d.source)}</p>
            ${r?.note ? `<p class="cx-ds-note">${esc(r.note)}</p>` : ''}
            ${fetched ? `<p class="cx-ds-note">Fetched ${new Date(fetched).toLocaleTimeString()}</p>` : ''}
            <div class="cx-vars">${vars}</div>
        </section>`;
    }).join('');
    $('#cx-catalog-list').innerHTML = html;
}

function onCatalogChange(ev) {
    const id = ev.target?.dataset?.series;
    if (!id) return;
    const on = new Set(S.ws.on);
    if (ev.target.checked) on.add(id); else on.delete(id);
    saveWorkspace({ ...S.ws, on: [...on] });
    renderPanels();
}

// ── Panels (the Explore timeline) ───────────────────────────────────────────

/** Axis labels: decimals from the tick spacing (tickDecimals), never fewer. */
function fmtTickFor(m) {
    const dp = tickDecimals(m?.yTicks);
    return (v) => v.toFixed(dp).replace('-', '−');
}

/** Readout values: the unit's own display precision (lab-units). */
function fmtValueFor(quantity) {
    const q = QUANTITIES[quantity];
    const u = q?.units[S.units?.[quantity]] || (q && Object.values(q.units)[0]);
    const dp = u?.dp ?? 1;
    return (v) => v.toFixed(dp).replace('-', '−');
}

function unitSym(quantity) {
    return fmt(quantity, 0, S.units).sym;
}

function renderPanels() {
    const host = $('#cx-panels');
    const axis = $('#cx-axis');
    const banner = $('#cx-banner');
    const nowMs = Date.now();
    const all = [...S.results.values()].flatMap((r) => r.series || []);
    const allDown = S.site && !S.loading.size && DATASETS.every((d) => S.results.get(d.id)?.state === 'down');

    banner.hidden = !allDown && !!S.site;
    if (!S.site) {
        banner.dataset.kind = 'info';
        banner.textContent = 'Pick a site to begin — search a city, a zip code or coordinates above. Signed-in users start at their account Home.';
    } else if (allDown) {
        banner.dataset.kind = 'down';
        banner.textContent = 'Every data feed is down right now. Nothing is drawn because there is nothing to draw — this is an outage, not a quiet day.';
    }
    if (!S.site || allDown) {
        host.innerHTML = '';
        axis.innerHTML = '';
        S.models = [];
        $('#cx-step').textContent = '';
        return;
    }

    const earliest = all.reduce((m, s) => (s.t.length ? Math.min(m, s.t[0]) : m), Infinity);
    const { from, to } = windowFor(S.ws.range, nowMs, Number.isFinite(earliest) ? earliest : null);
    const step = chooseStep(to - from);
    const width = Math.max(320, Math.floor(host.clientWidth || 800));
    const on = new Set(S.ws.on);

    const models = [];
    const blocks = [];
    for (const p of PANELS) {
        const list = all.filter((s) => on.has(s.id) && variableSpec(s.id)?.panel === p.id);
        if (!list.length) continue;
        const m = panelModel(list, {
            from, to, nowMs, stepMs: step.ms, width, height: PANEL_H, utcOffsetS: S.utcOffsetS,
            toDisplay: (si) => fmt(p.quantity, si, S.units).value,
        });
        m.panelId = p.id;
        m.quantity = p.quantity;
        models.push(m);
        const svg = panelSvg(m, {
            slotOf: (id) => variableSpec(id)?.slot ?? 0,
            fmtTick: fmtTickFor(m),
            title: p.title,
            labelNow: models.length === 1,
        });
        const legend = m.lines.map((ln) => {
            const spec = variableSpec(ln.id);
            const coarse = ln.tooShort
                ? ` <span class="cx-agg-note cx-short" title="Has data in this window, but less than one ${esc(bucketLabel(ln.drawnMs))} bucket">only ${esc(spanLabel(ln.tooShort.spanMs))} — zoom in</span>`
                : ln.drawnMs > ln.nativeMs
                ? ` <span class="cx-agg-note" title="Aggregated by ${esc(ln.agg)} into ${esc(bucketLabel(ln.drawnMs))} buckets">${esc(ln.agg)} per ${esc(bucketLabel(ln.drawnMs))}</span>` : '';
            return `<span class="cx-key" data-series="${esc(ln.id)}"><i class="cx-swatch cx-bg-s${spec?.slot ?? 0}"></i>${esc(ln.label)}${coarse}</span>`;
        }).join('');
        const sym = unitSym(p.quantity);
        blocks.push(`<figure class="cx-panel" data-panel="${esc(p.id)}">
            <figcaption><b>${esc(p.title)}</b>${sym ? ` <span class="cx-unit">${esc(sym)}</span>` : ''}<span class="cx-legend">${legend}</span></figcaption>
            ${svg}
        </figure>`);
    }
    S.models = models;
    host.innerHTML = blocks.length ? blocks.join('')
        : '<p class="cx-empty-msg">No series selected — tick some in the catalogue.</p>';

    const ticks = timeTicks(from, to, width);
    axis.innerHTML = `<svg viewBox="0 0 ${width} 22" width="${width}" height="22" aria-hidden="true">${
        ticks.map((k) => `<line class="cx-grid" x1="${k.x.toFixed(1)}" x2="${k.x.toFixed(1)}" y1="0" y2="5"/><text class="cx-tick" x="${k.x.toFixed(1)}" y="16" text-anchor="middle">${esc(k.label)}</text>`).join('')
    }</svg>`;
    $('#cx-step').textContent = `${RANGES[S.ws.range].label} · drawn ${step.label}` +
        (step.ms > DAY_MS ? ' (fixed-length buckets, not calendar months)' : '') +
        ' · local day at the site · dashed = projection';
}

function spanLabel(ms) {
    const d = ms / DAY_MS;
    return d >= 2 ? `${Math.round(d)} days` : `${Math.round(ms / 3_600_000)} h`;
}

function bucketLabel(ms) {
    if (ms >= 365 * DAY_MS) return '365-day';
    if (ms >= 30 * DAY_MS) return '30-day';
    if (ms >= 5 * DAY_MS) return '5-day';
    if (ms >= DAY_MS) return 'day';
    return `${Math.round(ms / 3_600_000)} h`;
}

// ── Crosshair ───────────────────────────────────────────────────────────────

function onPointerMove(ev) {
    const svg = ev.target.closest?.('.cx-panel-svg');
    const m0 = S.models[0];
    if (!svg || !m0) return;
    const rect = svg.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) / rect.width) * m0.width;
    const ms = msAtX(m0, x);
    S.map?.setTime(ms);
    const rows = readoutAt(S.models, ms);
    const cross = $('#cx-cross');
    const host = $('#cx-panels');
    const hostRect = host.getBoundingClientRect();
    cross.hidden = false;
    cross.style.left = `${ev.clientX - hostRect.left}px`;
    const byPanel = new Map(S.models.flatMap((m) => m.lines.map((l) => [l.id, m.quantity])));
    const when = new Date(ms);
    $('#cx-readout').innerHTML = `<b>${esc(when.toISOString().slice(0, 16).replace('T', ' '))} UTC${ms > Date.now() ? ' · forecast' : ''}</b>` +
        rows.map((r) => {
            const q = byPanel.get(r.id);
            const spec = variableSpec(r.id);
            const val = r.y == null ? '—' : `${(fmtValueFor(q))(r.y)} ${esc(unitSym(q))}`;
            return `<span class="cx-ro"><i class="cx-swatch cx-bg-s${spec?.slot ?? 0}"></i>${esc(r.label)} <b>${val}</b></span>`;
        }).join('');
}

function onPointerLeave() {
    $('#cx-cross').hidden = true;
    S.map?.setTime(null);
}

// ── Controls ────────────────────────────────────────────────────────────────

function renderControls() {
    for (const b of document.querySelectorAll('[data-range]')) {
        b.setAttribute('aria-pressed', String(b.dataset.range === S.ws.range));
    }
    $('#cx-units').value = S.ws.units.preset;
    $('#cx-from').value = String(S.ws.historyFrom);
}

function wireControls() {
    $('#cx-search-form').addEventListener('submit', onSearch);
    $('#cx-home-btn').addEventListener('click', goHome);
    $('#cx-catalog-list').addEventListener('change', onCatalogChange);
    for (const b of document.querySelectorAll('[data-range]')) {
        if (!RANGE_IDS.includes(b.dataset.range)) continue;
        b.addEventListener('click', () => {
            saveWorkspace({ ...S.ws, range: b.dataset.range });
            renderControls();
            renderPanels();
        });
    }
    $('#cx-units').addEventListener('change', (e) => {
        saveWorkspace({ ...S.ws, units: { preset: e.target.value } });
        renderPanels();
        renderHeatTicks();
        syncMapKey();                     // the on-map key's title carries the unit (it kept the old one)
        S.map?.unitsChanged();            // isotherm levels + tip + rail re-format in the new unit
    });
    $('#cx-from').addEventListener('change', (e) => {
        saveWorkspace({ ...S.ws, historyFrom: Number(e.target.value) });
        loadAll({ only: 'era5' });
    });
    const host = $('#cx-panels');
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerleave', onPointerLeave);
    let t = null;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(renderPanels, 120); }).observe(host);
    window.addEventListener('user-location-changed', (ev) => {
        const c = cleanLoc(ev.detail);
        if (c && S.site && !sameLocation(c, S.site)) {
            S.site = c;
            renderSiteBar();
            loadAll();
        }
    });
}

async function startSync() {
    try {
        const { initDocSync } = await import('../dashboard-sync.js');
        S.sync = initDocSync({
            page: 'climalytix',
            getDoc: () => ({ workspace: S.ws }),
            applyDoc: (doc) => {
                if (!doc?.workspace) return;
                saveWorkspace(doc.workspace, { source: 'cloud' });
                renderControls();
                renderCatalog();
                renderPanels();
            },
            saveEvent: WS_EVENT,
        });
    } catch { S.sync = { state: 'off:error' }; }
    const st = S.sync?.state || 'off';
    $('#cx-sync').textContent = st === 'ready' || st === 'synced'
        ? 'Workspace syncs to your account.'
        : st === 'off:tier' ? 'Workspace saved on this device (account sync is a Basic+ feature).'
        : 'Workspace saved on this device.';
}

// ── Boot ────────────────────────────────────────────────────────────────────

export function boot() {
    saveWorkspace(loadWorkspace(), { source: 'boot' });
    const r = resolveSite();
    S.site = r.site;
    S.home = r.home;
    wireControls();
    renderControls();
    renderSiteBar();
    mountLocationMap();
    loadAll();
    startSync();
    // Test + console hook (inert unless read).
    window.__climalytix = {
        get map() { return S.map; },
        get state() {
            return {
                site: S.site,
                utcOffsetS: S.utcOffsetS,
                workspace: S.ws,
                datasets: Object.fromEntries([...S.results].map(([k, v]) => [k, { state: v.state, series: v.series.map((s) => s.id) }])),
                loading: [...S.loading],
                panels: S.models.map((m) => ({ id: m.panelId, lines: m.lines.map((l) => l.id), hasData: m.hasData })),
                map: S.map?.state ?? null,
                field: S.field && { state: S.field.state, note: S.field.note },
                tempControl: S.tempCtl ?? null,
                sun: S.map?.sun ?? null,
                rose: S.rose && { mode: S.roseMode, n: S.rose.n, calm: S.rose.calm, freq: S.rose.freq, mean: S.rose.mean,
                                  prevailing: prevailing(S.rose), dirtiest: S.rose.dirtiest ?? null, cleanest: S.rose.cleanest ?? null },
                aq: S.aq && { state: S.aq.state, note: S.aq.note },
            };
        },
    };
}

boot();
