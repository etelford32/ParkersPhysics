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
import { loadDataset, loadField } from './loaders.js';
import { mountMap } from './map.js';
import { tempToRampFrac } from '../temp-ramp.js';
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
    loadField(site, { signal }).then((r) => {
        if (signal.aborted || S.site !== site) return;
        S.field = r;
        S.map?.setField(r.state, r.body, r.note);
    });
}

/** Paint the colour key ONCE from the site-wide temperature LUT bytes. */
function paintHeatKey() {
    const c = $('#cx-heat-key canvas');
    const img = c.getContext('2d').createImageData(256, 1);
    img.data.set(S.map.lut);
    c.getContext('2d').putImageData(img, 0, 0);
}

/** Ticks at round values IN THE READER'S UNIT, placed on the °C ramp. */
function renderHeatTicks() {
    const unit = S.units?.temp === 'F' ? 'F' : 'C';
    const ticks = unit === 'F' ? [-40, 0, 40, 80, 120] : [-40, -20, 0, 20, 40];
    $('#cx-heat-key .cx-key-ticks').innerHTML = ticks.map((d) => {
        const c = fromDisplay('temp', d, S.units);
        const f = tempToRampFrac(c);
        return f > 0.02 && f < 0.98 ? `<span style="left:${(f * 100).toFixed(1)}%">${d}°</span>` : '';
    }).join('');
}

/** The rail under the toggle: status, valid time, the window's range on the key. */
function renderHeatRail(info) {
    const st = $('#cx-heat-status');
    const on = $('#cx-layer-temp').checked;
    const win = $('#cx-heat-key .cx-key-win i');
    if (!on) { st.textContent = 'Temperature layer off.'; st.dataset.state = 'off'; win.hidden = true; return; }
    if (info.state === 'loading' || info.state === 'down' || info.t == null) {
        st.dataset.state = info.state === 'loading' ? 'loading' : 'down';
        st.textContent = info.state === 'loading' ? 'Loading the temperature field…'
            : info.state === 'down' ? info.note
            : 'The run does not cover this time — no frame is held past its end.';
        win.hidden = true;
        return;
    }
    st.dataset.state = info.state;
    const local = new Date(info.timeMs + S.utcOffsetS * 1000);
    const when = `${local.toUTCString().slice(0, 3)} ${local.toISOString().slice(11, 16)} local`;
    const lead = Math.round((info.timeMs - S.field.body.runMs) / 3_600_000);
    const range = info.range ? ` · window ${fmtText('temp', info.range.min, S.units)} – ${fmtText('temp', info.range.max, S.units)}` : '';
    st.innerHTML = `<b>Valid ${esc(when)}</b> (GFS +${lead} h)${esc(range)}<br>${esc(info.note)}`;
    if (info.range) {
        const a = tempToRampFrac(info.range.min), b = tempToRampFrac(info.range.max);
        win.hidden = false;
        win.style.left = `${(a * 100).toFixed(1)}%`;
        win.style.width = `${Math.max(1, (b - a) * 100).toFixed(1)}%`;
    } else win.hidden = true;
}

function mountLocationMap() {
    S.map = mountMap($('#cx-map'), {
        formatTemp: (c) => fmtText('temp', c, S.units),
        // Isotherm levels are chosen in the reader's unit (round °F for a °F reader).
        tempUnits: () => ({
            toDisplay: (c) => fmt('temp', c, S.units).value,
            fromDisplay: (d) => fromDisplay('temp', d, S.units),
            sym: fmt('temp', 0, S.units).sym,
        }),
        onFrame: renderHeatRail,
    });
    paintHeatKey();
    renderHeatTicks();
    $('#cx-layer-temp').addEventListener('change', (ev) => {
        S.map.setLayer('temperature', ev.target.checked);
        for (const id of ['#cx-layer-iso', '#cx-layer-ext']) $(id).disabled = !ev.target.checked;
    });
    $('#cx-layer-iso').addEventListener('change', (ev) => S.map.setLayer('isotherms', ev.target.checked));
    $('#cx-layer-ext').addEventListener('change', (ev) => S.map.setLayer('extremes', ev.target.checked));
    $('#cx-heat-alpha').addEventListener('input', (ev) => S.map.setHeatAlpha(Number(ev.target.value)));
    $('#cx-layer-terrain').addEventListener('change', (ev) => S.map.setLayer('terrain', ev.target.checked));
    $('#cx-layer-labels').addEventListener('change', (ev) => S.map.setLayer('labels', ev.target.checked));
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
        get state() {
            return {
                site: S.site,
                workspace: S.ws,
                datasets: Object.fromEntries([...S.results].map(([k, v]) => [k, { state: v.state, series: v.series.map((s) => s.id) }])),
                loading: [...S.loading],
                panels: S.models.map((m) => ({ id: m.panelId, lines: m.lines.map((l) => l.id), hasData: m.hasData })),
                map: S.map?.state ?? null,
                field: S.field && { state: S.field.state, note: S.field.note },
            };
        },
    };
}

boot();
