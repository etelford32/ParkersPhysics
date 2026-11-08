/**
 * glacier-watch-page.js — the Glacier Watch page controller (glacier-watch.html).
 *
 * Wires data → engine → views and computes nothing about glaciers itself. Sources, each
 * failing independently and each with its own chip (a dead feed must LOOK dead, never quiet):
 *   ARCHIVE  data/glaciers/glaciers.json + <id>.json (ITS_LIVE bake), massbalance.json (WGMS),
 *            elevation.json (GLO-30)
 *   DAILY    /api/glaciers/velocity?g=  — pairs published since the bake (merged by id)
 *   WEATHER  Open-Meteo archive + forecast at each gauge's elevation (js/glacier-weather.js)
 *   STATIONS /api/glaciers/stations?g= — USGS outlet discharge + SNOTEL (US glaciers)
 *
 * Deep link: glacier-watch.html?g=<id>. Test hook: window.__glacierWatch.
 */
import * as E from './glacier-engine.js';
import { loadGlacierWeather, seasonCompare, degreeDays, hydroStart } from './glacier-weather.js';
import { mountChart, extent, fmtDate, fmtNum } from './glacier-charts.js';
import { FlowMap, rampColor } from './glacier-flowmap.js';
import { Glacier3D, LAYERS, rampAt, webglAvailable } from './glacier-3d.js';

const SENSOR = {
    landsatOLI: { label: 'Landsat 8/9', color: '#3987e5', shape: 'circle' },
    sentinel2: { label: 'Sentinel-2', color: '#d95926', shape: 'square' },
    sentinel1: { label: 'Sentinel-1', color: '#199e70', shape: 'triangle' },
};
const INK = '#e3eaf6', INK2 = '#aab6cc', INK3 = '#7e8ba3', ACCENT = '#f2b84b';
const POS = '#3987e5', NEG = '#d95926';         // diverging poles (balance gain / loss)
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const speed = (v) => (!Number.isFinite(v) ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} km/yr` : `${v.toFixed(0)} m/yr`);
const DAY = 864e5;

const S = {
    nowMs: Date.now(), index: null, glaciers: [], mb: null, elev: null,
    sel: null, gaugeId: 'middle', detail: {}, models: {}, live: {}, weather: {}, stations: {}, charts: {}, perf: { marks: {} },
};
S.E = E;                       // test hook: the engine, for gates that must agree with it
window.__glacierWatch = S;
const mark = (k) => { S.perf.marks[k] = Math.round(performance.now()); };

async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}
function chip(id, state, text) { const el = $(id); el.dataset.state = state; el.textContent = text; }

// ── boot ─────────────────────────────────────────────────────────────────────
async function boot() {
    mark('boot');
    setupStage();
    for (const id of ['year', 'profile', 'decades', 'mb', 'weather', 'stations']) S.charts[id] = mountChart($(`gw-${id}-chart`), { height: id === 'year' ? 340 : 280 });
    let idx;
    try {
        [idx, S.mb, S.elev] = await Promise.all([
            getJson('/data/glaciers/glaciers.json'),
            getJson('/data/glaciers/massbalance.json').catch(() => null),
            getJson('/data/glaciers/elevation.json').catch(() => null),
        ]);
    } catch (e) {
        chip('gw-chip-bake', 'down', 'Archive: unavailable');
        $('gw-now-body').innerHTML = `<div class="gw-empty">The glacier archive could not be loaded (${esc(e.message)}).</div>`;
        return;
    }
    S.index = idx; S.glaciers = E.decodeIndex(idx);
    const baked = S.glaciers[0]?.baked;
    chip('gw-chip-bake', 'live', `Archive: ITS_LIVE to ${baked}`);
    $('gw-baked').textContent = baked;
    mark('index');
    renderPicker();
    const want = new URLSearchParams(location.search).get('g');
    select(S.glaciers.find(g => g.id === want) ? want : 'columbia', { push: false });
}

// ── the stage ────────────────────────────────────────────────────────────────
function setupStage() {
    const host = $('gw-stage-host');
    S.has3d = webglAvailable();
    if (S.has3d) {
        try { S.g3d = new Glacier3D(host, { onHover: stageHover, onStats: stageStats }); }
        catch (e) { S.has3d = false; console.warn('3D unavailable:', e.message); }
    }
    const c2 = document.createElement('canvas');
    c2.id = 'gw-map'; c2.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:none';
    host.appendChild(c2);
    S.flow = new FlowMap(c2, { tip: $('gw-map-tip'), onStats: flowStats });
    S.view = S.has3d ? '3d' : '2d';
    if (!S.has3d) { $('gw-view-3d').disabled = true; $('gw-view-3d').title = 'WebGL is not available in this browser'; }
    $('gw-stage-layers').innerHTML = Object.entries(LAYERS).map(([k, L]) => `<button data-layer="${k}" aria-pressed="${k === 'speed'}" title="${esc(L.source)}">${esc(L.label)}</button>`).join('');
    $('gw-stage-layers').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-layer]'); if (!b || !S.g3d) return;
        for (const x of $('gw-stage-layers').children) x.setAttribute('aria-pressed', String(x === b));
        S.g3d.setLayer(b.dataset.layer);
    });
    $('gw-view-3d').onclick = () => setView('3d');
    $('gw-view-2d').onclick = () => setView('2d');
    $('gw-flow-toggle').onclick = () => toggleFlow();
    $('gw-section-toggle').onclick = () => { const on = $('gw-section-toggle').getAttribute('aria-pressed') !== 'true'; $('gw-section-toggle').setAttribute('aria-pressed', String(on)); S.g3d?.setSection(on); };
    $('gw-exag').oninput = (e) => { $('gw-exag-val').textContent = `${e.target.value}×`; clearTimeout(S.exagT); S.exagT = setTimeout(() => S.g3d?.setExaggeration(+e.target.value), 60); };
    for (const b of document.querySelectorAll('[data-cam]')) b.onclick = () => S.g3d?.frame(b.dataset.cam);
    $('gw-size-seg').onclick = (e) => {
        const b = e.target.closest('button[data-size]'); if (!b) return;
        $('gw-stage').style.height = ''; $('gw-stage').dataset.size = b.dataset.size;
        for (const x of $('gw-size-seg').children) x.setAttribute('aria-pressed', String(x === b));
    };
    $('gw-fullscreen').onclick = () => toggleFullscreen();
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) $('gw-stage').classList.remove('gw-fs'); fsLabel(); });
    document.addEventListener('keydown', (e) => {
        if (/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement?.tagName || '')) { if (e.key === 'Escape') exitFs(); return; }
        if (e.code === 'Space') { e.preventDefault(); toggleFlow(); }
        else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
        else if (e.key === 'Escape') exitFs();
    });
    setView(S.view);
}

function setView(v) {
    if (v === '3d' && !S.has3d) v = '2d';
    S.view = v;
    $('gw-view-3d').setAttribute('aria-pressed', String(v === '3d')); $('gw-view-2d').setAttribute('aria-pressed', String(v === '2d'));
    if (S.g3d) S.g3d.renderer.domElement.style.display = v === '3d' ? 'block' : 'none';
    $('gw-map').style.display = v === '2d' ? 'block' : 'none';
    for (const id of ['gw-stage-layers', 'gw-section-toggle', 'gw-exag']) { const el = $(id); (el.closest('label') || el).style.display = v === '3d' ? '' : 'none'; }
    for (const b of document.querySelectorAll('[data-cam]')) b.style.display = v === '3d' ? '' : 'none';
    S.flow.setRunning(v === '2d' && $('gw-flow-toggle').getAttribute('aria-pressed') === 'true');
    if (v === '2d') S.flow._resize(); else S.g3d?.resize();
    if (S.sel) { stageLegend(); stageNote(); }
}

function toggleFlow() {
    const on = $('gw-flow-toggle').getAttribute('aria-pressed') !== 'true';
    $('gw-flow-toggle').setAttribute('aria-pressed', String(on));
    $('gw-flow-toggle').textContent = on ? 'Flow ▶' : 'Flow ❚❚';
    if (S.view === '2d') S.flow.setRunning(on); else S.g3d?.setFlow(on);
}

function toggleFullscreen() {
    const st = $('gw-stage');
    if (document.fullscreenElement || st.classList.contains('gw-fs')) return exitFs();
    if (st.requestFullscreen) st.requestFullscreen().catch(() => st.classList.add('gw-fs')); else st.classList.add('gw-fs');   // CSS fallback (iPhone)
    st.classList.add('gw-fs'); fsLabel();
}
function exitFs() { const st = $('gw-stage'); if (document.fullscreenElement) document.exitFullscreen?.(); st.classList.remove('gw-fs'); fsLabel(); }
function fsLabel() { const on = !!document.fullscreenElement || $('gw-stage').classList.contains('gw-fs'); $('gw-fullscreen').textContent = on ? '✕ Exit full screen' : '⛶ Full screen'; }

const fmtQ = (v, unit) => (!Number.isFinite(v) ? '—' : unit === 'm/yr' ? speed(v) : unit === 'm²/yr' ? (v >= 1e6 ? `${(v / 1e6).toFixed(2)} km²/yr` : `${fmtNum(v)} m²/yr`) : `${fmtNum(v)} ${unit}`);

function stageStats(st) { S.stage = st; stageLegend(); stageReadout(); stageNote(); }

function stageLegend() {
    const el = $('gw-stage-legend');
    if (S.view === '2d') {
        el.innerHTML = `<b>Mean surface speed 2014–2024</b> <span>(observed, log scale)</span><canvas width="220" height="10"></canvas><div style="display:flex;justify-content:space-between"><span>${speed(S.flow.vLo)}</span><span>${speed(S.flow.vHi)}</span></div>`;
        const c = el.querySelector('canvas').getContext('2d');
        for (let i = 0; i < 220; i++) { const [r, g, b] = rampColor(i / 219); c.fillStyle = `rgb(${r | 0},${g | 0},${b | 0})`; c.fillRect(i, 0, 1, 10); }
        return;
    }
    const st = S.stage; if (!st) return;
    el.innerHTML = `<b>${esc(st.label)}</b> <span>· ${esc(st.source)}${st.log ? ' · log scale' : ''}</span><canvas width="220" height="10"></canvas>` +
        `<div style="display:flex;justify-content:space-between"><span>${fmtQ(st.lo, st.unit)}</span><span>${fmtQ(st.hi, st.unit)}</span></div>` +
        `<div style="margin-top:3px">Vertical exaggeration <b>${st.exag}×</b> · terrain under the ice is the estimated bed</div>`;
    const c = el.querySelector('canvas').getContext('2d');
    for (let i = 0; i < 220; i++) { const [r, g, b] = rampAt(st.ramp, i / 219); c.fillStyle = `rgb(${r * 255 | 0},${g * 255 | 0},${b * 255 | 0})`; c.fillRect(i, 0, 1, 10); }
}

function stageReadout() {
    const st = S.stage, el = $('gw-stage-readout');
    if (!st || S.view === '2d') { el.style.display = 'none'; return; }
    el.style.display = '';
    el.innerHTML = `<b>Ice in this window — density analysis</b><br>` +
        `<span class="big">${st.volumeKm3 >= 10 ? st.volumeKm3.toFixed(0) : st.volumeKm3.toFixed(2)} km³</span> · ${st.massGt >= 10 ? st.massGt.toFixed(0) : st.massGt.toFixed(2)} Gt of ice<br>` +
        `area ${st.iceAreaKm2.toFixed(st.iceAreaKm2 > 100 ? 0 : 1)} km² · mean thickness ${st.meanH.toFixed(0)} m · max ${st.maxH.toFixed(0)} m<br>` +
        `<span style="color:${INK3}">model: shallow-ice inversion of the observed speed; plastic cap binding on ${(100 * st.cappedFraction).toFixed(0)} % of cells (sliding ice)</span>`;
}

function stageNote() {
    const g = S.sel; if (!g) return;
    const d = S.view === '2d' ? S.daysPerSecond : S.stage?.daysPerSecond;
    const t = !Number.isFinite(d) ? '' : `Time is compressed for the parcels: <b>1 s ≈ ${d >= 60 ? (d / 30.4).toFixed(1) + ' months' : d.toFixed(0) + ' days'}</b> of real flow. `;
    $('gw-stage-note').innerHTML = (S.view === '3d'
        ? `Drag to orbit, right-drag or two fingers to pan, wheel or pinch to zoom; hover the ice for numbers. North is up the screen. ${t}` +
          `The surface and the motion are observed (GLO-30, ITS_LIVE); the ice body underneath — thickness, bed, stress, flux — is a model, labelled as such. ` +
          `The window is ${(Math.abs(S.detail[g.id].field.nx * S.detail[g.id].field.dx) / 1000).toFixed(0)} km across; an ice-sheet outlet continues beyond it.`
        : `Ice parcels drift through the observed 2014–2024 mean velocity field (ITS_LIVE, EPSG:${g.epsg}), rotated so north is up. ${t}Distances are true.`) +
        ` <span style="color:${INK3}">Keys: Space = flow, F = full screen, Esc = exit.</span>`;
}

function stageHover(h) {
    const tip = $('gw-stage-tip');
    if (!h) { tip.style.display = 'none'; return; }
    tip.innerHTML = h.onIce
        ? `<b>${speed(h.speed)}</b> surface speed (observed)<br>surface ${h.z.toFixed(0)} m · bed ${h.bed.toFixed(0)} m (model)<br>thickness ${h.H.toFixed(0)} m · slope ${h.slope.toFixed(1)}°<br>flux ${fmtQ(h.q, 'm²/yr')} · stress ${h.tau.toFixed(0)} kPa`
        : `off the ice · ${h.z.toFixed(0)} m a.s.l.`;
    tip.style.display = 'block';
    const st = $('gw-stage').getBoundingClientRect();
    tip.style.left = Math.min(st.width - tip.offsetWidth - 8, h.x + 14) + 'px';
    tip.style.top = Math.max(4, h.y - tip.offsetHeight - 10) + 'px';
}

function flowStats({ daysPerSecond }) { S.daysPerSecond = daysPerSecond; if (S.view === '2d') { stageLegend(); stageNote(); } }

// ── picker ───────────────────────────────────────────────────────────────────
function renderPicker() {
    $('gw-picker').innerHTML = S.glaciers.map(g => `<button class="gw-name" data-id="${g.id}" aria-pressed="false" aria-describedby="gw-name-tip"><i id="gw-dot-${g.id}"></i>${esc(g.name.replace(/ \(.*\)/, ''))}</button>`).join('');
    $('gw-picker-count').textContent = `${S.glaciers.length} glaciers · hover or focus a name for details`;
    const tip = $('gw-name-tip');
    const show = (b) => {
        const g = S.glaciers.find(q => q.id === b.dataset.id); if (!g) return;
        const mb = S.mb?.glaciers?.[g.id];
        tip.innerHTML = `<b>${esc(g.name)}</b><br>${esc(g.region)} · ${esc(g.country)}<div style="margin:5px 0;color:${INK}">${esc(g.note)}</div>` +
            `<div class="r"><span>Type</span><span>${esc(g.kind)}</span></div>` +
            `<div class="r"><span>Flowline</span><span>${(g.flowline.length_m / 1000).toFixed(1)} km</span></div>` +
            `<div class="r"><span>Pairs in 12 months</span><span>${g.pairs_count} kept of ${g.pairs_listed ?? '—'}</span></div>` +
            `<div class="r"><span>Field mass balance</span><span>${mb ? `${mb.starts}–${mb.ends} (WGMS)` : 'none'}</span></div>` +
            `<div class="r"><span>Velocity record</span><span>${g.annual.years[0]}–2025</span></div>`;
        tip.style.display = 'block';
        const r = b.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
        tip.style.left = Math.max(12, Math.min(innerWidth - tw - 12, r.left)) + 'px';
        tip.style.top = (r.top - th - 8 > 8 ? r.top - th - 8 : r.bottom + 8) + 'px';
    };
    const hide = () => { tip.style.display = 'none'; };
    $('gw-picker').addEventListener('pointerover', (e) => { const b = e.target.closest('.gw-name'); if (b && e.pointerType === 'mouse') show(b); });
    $('gw-picker').addEventListener('pointerout', (e) => { if (e.target.closest('.gw-name') && e.pointerType === 'mouse') hide(); });
    $('gw-picker').addEventListener('focusin', (e) => { const b = e.target.closest('.gw-name'); if (b) show(b); });
    $('gw-picker').addEventListener('focusout', hide);
    $('gw-picker').addEventListener('click', (e) => {
        const b = e.target.closest('.gw-name'); if (!b) return;
        select(b.dataset.id);
        if (matchMedia('(hover: none)').matches) { show(b); clearTimeout(S.tipT); S.tipT = setTimeout(hide, 3500); }   // touch: show briefly after a tap
    });
    addEventListener('scroll', hide, { passive: true });
}

async function select(id, { push = true } = {}) {
    const g = S.glaciers.find(q => q.id === id);
    if (!g) return;
    S.sel = g;
    for (const b of document.querySelectorAll('.gw-name')) b.setAttribute('aria-pressed', String(b.dataset.id === id));
    if (push) history.replaceState(null, '', `?g=${id}`);
    $('gw-map-title').textContent = g.name;
    $('gw-map-sub').textContent = `${g.region} · ${g.kind} · flowline ${(g.flowline.length_m / 1000).toFixed(1)} km`;
    S.gauges = E.gauges(g);
    renderGaugeSeg();
    if (!S.detail[id]) {
        try { S.detail[id] = E.decodeDetail(await getJson(`/data/glaciers/${id}.json`)); }
        catch (e) { $('gw-now-body').innerHTML = `<div class="gw-empty">This glacier's archive file failed to load (${esc(e.message)}).</div>`; return; }
    }
    if (S.sel !== g) return;
    mark('detail');
    S.flow.setGlacier(g, S.detail[id], S.gauges.map(q => ({ ...q, selected: q.id === S.gaugeId })));
    if (S.g3d && S.detail[id].field.z) { try { S.g3d.setGlacier(g, S.detail[id]); } catch (e) { console.warn(e.message); setView('2d'); } }
    else if (S.view === '3d') setView('2d');
    setView(S.view);
    renderAll();
    mark('first-render');
    loadLive(g); loadWeather(g); loadStations(g);
}

function renderGaugeSeg() {
    $('gw-gauge-seg').innerHTML = S.gauges.filter(q => q.id !== 'fastest').map(q =>
        `<button data-g="${q.id}" aria-pressed="${q.id === S.gaugeId}">${esc(q.label)}</button>`).join('');
    $('gw-gauge-seg').onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        S.gaugeId = b.dataset.g;
        for (const x of $('gw-gauge-seg').children) x.setAttribute('aria-pressed', String(x.dataset.g === S.gaugeId));
        S.flow.gauges = S.gauges.map(q => ({ ...q, selected: q.id === S.gaugeId })); if (S.view === '2d') { S.flow._kick(); S.flow._overlay(); }
        renderYear(); renderNow(); renderDecades();
    };
}

const pairsFor = (id) => E.mergePairs(S.detail[id]?.pairs || [], S.live[id]?.pairs || []);
const gauge = () => S.gauges.find(q => q.id === S.gaugeId) || S.gauges[1];

function renderAll() { renderNow(); renderYear(); renderProfile(); renderDecades(); renderMassBalance(); renderWeather(); renderStations(); }

// ── right now ────────────────────────────────────────────────────────────────
function renderNow() {
    const g = S.sel, pairs = pairsFor(g.id);
    const rows = S.gauges.filter(q => q.id !== 'fastest').map(q => ({ q, st: E.currentState(E.gaugeRecord(g, pairs, q.idx), S.nowMs, { detect: E.detectable(g, q.idx) }) }));
    const newest = pairs.reduce((a, p) => (!a || p.d2 > a.d2 ? p : a), null);
    const last30 = pairs.filter(p => p.mid >= S.nowMs - 30 * DAY);
    const bySensor = {};
    for (const p of pairs) bySensor[p.sensor] = (bySensor[p.sensor] || 0) + 1;
    const cur = rows.find(r => r.q.id === S.gaugeId)?.st;
    const arrow = (s) => (s === 'faster' ? '▲' : s === 'slower' ? '▼' : s === 'undetectable' ? '○' : '●');
    $('gw-now-sub').textContent = newest ? `newest pair ends ${fmtDate(newest.d2)}` : '';
    $('gw-now-body').innerHTML = `
      <div class="gw-big">${cur?.latest ? speed(cur.latest.v) : '—'}</div>
      <div style="font-size:.74rem;color:${INK2}">${esc(gauge().label)} · latest pair ${cur?.latest ? `${fmtDate(cur.latest.d1)} → ${fmtDate(cur.latest.d2)} (${cur.latest.dtDays} d, ${SENSOR[cur.latest.sensor]?.label || cur.latest.sensor})` : 'none with data here'}</div>
      <h3>Compared with the usual seasonal rhythm (last 45 days)</h3>
      ${rows.map(({ q, st }) => `<div class="gw-row"><span>${esc(q.label)}</span><span class="gw-state-pill" data-state="${st.state}">${arrow(st.state)} ${esc(st.state === 'unknown' ? 'no recent pairs' : st.label)}${st.n ? ` <span style="color:${INK3};font-weight:400">(${st.n})</span>` : ''}</span></div>`).join('')}
      <h3>Measurements</h3>
      <div class="gw-row"><span>Pairs in the last 12 months</span><span>${pairs.length}</span></div>
      <div class="gw-row"><span>…in the last 30 days</span><span>${last30.length}</span></div>
      ${Object.entries(bySensor).map(([k, n]) => `<div class="gw-row"><span>${SENSOR[k]?.label || k}</span><span>${n}</span></div>`).join('')}
      <div class="gw-row"><span>Available upstream (all, before quality cut)</span><span>${g.pairs_listed ?? '—'}</span></div>
      <h3>About</h3>
      <div style="font-size:.74rem;color:${INK2};line-height:1.5">${esc(g.note)}</div>`;
    const st = rows.find(r => r.q.id === 'middle')?.st;
    const dot = $(`gw-dot-${g.id}`);
    if (dot && st) { dot.dataset.state = st.state; dot.title = st.label; }
}

// ── last 12 months ───────────────────────────────────────────────────────────
function renderYear() {
    const g = S.sel, q = gauge(), rec = E.gaugeRecord(g, pairsFor(g.id), q.idx);
    const from = Date.parse(g.pairs_cutoff), to = S.nowMs + 3 * DAY;
    const daily = E.dailySeries(rec, { fromMs: from, toMs: S.nowMs });
    const expPts = [];
    for (let t = from; t <= to; t += 2 * DAY) expPts.push([t, E.seasonalExpected(rec.v0, rec.amp, rec.phaseDoy, t)]);
    const pts = rec.points.map(p => ({
        x: p.t, y: p.v, e: p.e, shape: SENSOR[p.sensor]?.shape, color: SENSOR[p.sensor]?.color || INK2, hollow: p.outlier,
        tip: () => `<b>${speed(p.v)}</b> ± ${Number.isFinite(p.e) ? p.e.toFixed(0) : '—'}${p.outlier ? ' · <i>flagged outlier</i>' : ''}${p.live ? ' · <b>new</b>' : ''}<br>${fmtDate(p.d1)} → ${fmtDate(p.d2)} (${p.dtDays} d) · ${SENSOR[p.sensor]?.label}<br><span style="color:${INK2}">usual for these dates: ${speed(p.expected)}</span>`,
    }));
    const vals = [...rec.points.filter(p => !p.outlier).map(p => p.v), ...expPts.map(p => p[1])];
    const [ylo, yhi] = extent(vals, { pad: 0.12, zero: false });
    S.charts.year.render({
        x: { min: from, max: to, type: 'time' },
        ariaLabel: `Surface speed at the ${q.label} of ${g.name} over the last 12 months`,
        panels: [{ y: { min: Math.max(0, ylo), max: yhi, label: 'surface speed, m/yr' }, layers: [
            { type: 'line', pts: expPts, color: INK3, width: 2, dash: [6, 4], tip: (t, v) => `usual (2014–2024 sinusoid): ${speed(v)}`, endLabel: () => 'usual' },
            { type: 'points', pts, size: 8 },
            { type: 'line', pts: daily.t.map((t, i) => [t, daily.v[i]]), color: INK, width: 2.5, tip: (t, v) => `${fmtDate(t)} · 30-day estimate ${speed(v)}`, endLabel: (v) => speed(v) },
            { type: 'vline', x: S.nowMs, label: 'today' },
            { type: 'vline', x: g.bakedMs, label: 'archive baked', color: 'rgba(140,190,255,.25)' },
        ] }],
    });
    const present = [...new Set(rec.points.map(p => p.sensor))];
    $('gw-year-legend').innerHTML = present.map(k => `<span><i style="background:${SENSOR[k].color};border-radius:${SENSOR[k].shape === 'circle' ? '50%' : '2px'}"></i>${SENSOR[k].label}</span>`).join('') +
        `<span><i style="height:2px;background:${INK}"></i>30-day estimate</span><span><i style="height:0;border-top:2px dashed ${INK3}"></i>usual for the season</span><span><i style="border:1.5px solid ${INK2};border-radius:50%;background:none"></i>flagged outlier</span>`;
    $('gw-year-sub').textContent = `${q.label} · ${rec.points.length} pairs with data here`;
    const amp = rec.amp, ph = rec.phaseDoy, det = E.detectable(g, q.idx);
    if (!det.ok) {
        $('gw-year-note').innerHTML = `<b>Below detection here.</b> The 2014–2024 mean speed at this point (${speed(det.v0)}) is smaller than twice the typical error of a single pair (±${speed(det.err)}), ` +
            `so these marks are measurement noise around ~zero, not a record of the ice. Small, slow glaciers move metres a year; a 120 m feature-tracking grid needs months of averaging to see that. ` +
            `This glacier's daily signal is in its weather, river and snow panels below.`;
        return;
    }
    $('gw-year-note').textContent = `Each mark is one image pair: the average speed between its two acquisitions, plotted at the midpoint, error bar = ITS_LIVE's own uncertainty. ` +
        (Number.isFinite(amp) ? `Here the ice usually peaks around day ${ph.toFixed(0)} (${new Date(Date.UTC(2025, 0, 1) + (ph - 1) * DAY).toUTCString().slice(5, 11)}), ±${speed(amp)} around a mean of ${speed(rec.v0)}. ` : '') +
        `Gaps are real: clouds, polar night and snow hide the surface from the optical satellites.`;
}

// ── profile ──────────────────────────────────────────────────────────────────
function renderProfile() {
    const g = S.sel, fl = g.flowline, km = fl.s_m.map(s => s / 1000);
    const z = S.elev?.glaciers?.[g.id]?.z_m || [];
    const pairs = pairsFor(g.id).filter(p => p.mid >= S.nowMs - 60 * DAY);
    const recent = km.map((_, k) => { const v = pairs.map(p => p.v[k]).filter(Number.isFinite).sort((a, b) => a - b); return v.length >= 2 ? v[v.length >> 1] : null; });
    const v0 = Array.from(g.climatology.v0);
    const [vlo, vhi] = extent([...v0, ...recent], { zero: true });
    // the ice body in cross-section: modelled thickness (engine iceModel) under the observed surface
    const det = S.detail[g.id], f = det?.field;
    if (f?.z && !S.models[g.id]) S.models[g.id] = E.iceModel(f);
    const mdl = S.models[g.id];
    const Hk = fl.x.map((x, k) => {
        if (!mdl) return null;
        const j = Math.round((x - f.x0) / f.dx), i = Math.round((fl.y[k] - f.y0) / f.dy);
        const v = (i >= 0 && j >= 0 && i < f.ny && j < f.nx) ? mdl.H[i * f.nx + j] : NaN;
        return Number.isFinite(v) && v > 0 ? v : null;
    });
    const bedK = z.map((zz, k) => (zz !== null && Hk[k] !== null ? zz - Hk[k] : null));
    const [zlo, zhi] = extent([...z.filter(v => v !== null), ...bedK.filter(v => v !== null)]);
    const panels = [];
    if (z.length) panels.push({ weight: 1, y: { min: zlo, max: zhi, label: 'elevation, m — observed surface (GLO-30) over the modelled bed' }, layers: [
        { type: 'band', lo: km.map((x, k) => [x, bedK[k]]), hi: km.map((x, k) => [x, bedK[k] === null ? null : z[k]]), color: '#a9dcfa', alpha: 0.28 },
        { type: 'line', pts: km.map((x, k) => [x, bedK[k]]), color: '#a68ae0', width: 2, dash: [5, 3], endLabel: () => 'bed (model)',
          tip: (x, y) => { const k = km.findIndex(v => v === x); return `bed ≈ ${y.toFixed(0)} m · ice ≈ ${Hk[k]?.toFixed(0) ?? '—'} m thick (model)`; } },
        { type: 'line', pts: km.map((x, k) => [x, z[k]]), color: '#e3eaf6', width: 2, endLabel: () => 'surface', tip: (x, y) => `${x.toFixed(1)} km · surface ${y.toFixed(0)} m` },
    ] });
    panels.push({ y: { min: vlo, max: vhi, label: 'surface speed, m/yr' }, layers: [
        { type: 'line', pts: km.map((x, k) => [x, v0[k]]), color: INK3, width: 2, tip: (x, y) => `${x.toFixed(1)} km · 2014–24 mean ${speed(y)}` },
        { type: 'points', size: 7, pts: km.map((x, k) => ({ x, y: recent[k], color: ACCENT, shape: 'circle', tip: () => `${x.toFixed(1)} km · last 60 days (median of pairs): <b>${speed(recent[k])}</b><br>2014–24 mean ${speed(v0[k])}` })) },
    ] });
    S.charts.profile.render({ x: { min: 0, max: km.at(-1), type: 'linear', label: 'km from head' }, panels, height: 380, ariaLabel: `Elevation and speed along the flowline of ${g.name}` });
    $('gw-profile-note').innerHTML = `Top: the ice in cross-section — observed surface over the MODELLED bed (shallow-ice inversion of the observed speed; see the method notes). ` +
        `Bottom: grey line = the 2014–2024 mean speed; gold dots = the median of the last 60 days of pairs at each point. ` +
        (g.kind === 'tidewater' || g.kind === 'ice-sheet outlet' || g.kind === 'lake-calving' ? 'Speed rises toward a calving front, where the ice is pulled into the water. ' : '') +
        `The DEM is a 2011–2015 surface; fast-changing tongues have thinned since.`;
}

// ── decades ──────────────────────────────────────────────────────────────────
function renderDecades() {
    const g = S.sel, q = gauge();
    const ann = E.annualAt(g, q.idx, { includePartial: true });
    const full = ann.filter(a => !a.partial);
    const tr = E.linearTrend(full, 2014, 2024);
    const [ylo, yhi] = extent(ann.map(a => a.v), { zero: true });
    const layers = [
        { type: 'line', pts: full.map(a => [a.year, a.v]), color: '#62b6ec', width: 2, endLabel: (v) => speed(v) },
        { type: 'points', size: 8, pts: ann.map(a => ({ x: a.year, y: a.v, color: '#62b6ec', hollow: a.partial, shape: 'circle', tip: () => `<b>${a.year}</b>: ${speed(a.v)}${a.partial ? ' (partial year — the archive ends May 2025)' : ''}` })) },
    ];
    if (tr) layers.push({ type: 'line', pts: [[tr.from, tr.intercept + tr.slope * tr.from], [tr.to, tr.intercept + tr.slope * tr.to]], color: ACCENT, width: 2, dash: [4, 3] });
    const y0 = (ann[0]?.year ?? g.annual.years[0]) - 0.5;
    S.charts.decades.render({ x: { min: y0, max: 2025.5, type: 'linear', fmt: (v) => String(Math.round(v)) }, panels: [{ y: { min: ylo, max: yhi, label: `annual mean speed at the ${q.label.toLowerCase()}, m/yr` }, layers }], height: 320 });
    $('gw-decades-sub').textContent = `${ann.length ? ann[0].year : '—'}–2025 · ${q.label}`;
    $('gw-decades-note').innerHTML = (tr ? `2014–2024 trend: <b>${tr.slope >= 0 ? '+' : ''}${fmtNum(tr.slope)} m/yr per year</b> (± ${fmtNum(2 * tr.seSlope)}, 2σ). ` : '') +
        `Early years are Landsat 4/5 only and sparse — a missing year is a gap in the archive, not a stopped glacier. 2025 (hollow) is partial.`;
}

// ── mass balance ─────────────────────────────────────────────────────────────
function renderMassBalance() {
    const g = S.sel, mb = S.mb?.glaciers?.[g.id];
    if (!mb) {
        S.charts.mb.render(null);
        $('gw-mb-note').innerHTML = `<div class="gw-empty">${esc(g.name)} has no glaciological mass-balance series: ${g.kind === 'debris-covered' ? 'its debris-covered tongue cannot be staked like a clean glacier' : 'a calving glacier loses most of its ice at the front, which stakes on the surface cannot measure'}. Satellite (geodetic) estimates are planned.</div>`;
        $('gw-mb-sub').textContent = 'none for this glacier';
        return;
    }
    const rows = mb.rows.filter(r => r.annual !== null), cum = E.cumulativeBalance(rows);
    const [alo, ahi] = extent(rows.map(r => r.annual), { zero: true });
    const [clo, chi] = extent(cum.map(c => c.cumulative), { zero: true });
    S.charts.mb.render({
        x: { min: mb.starts - 1, max: 2026, type: 'linear', fmt: (v) => String(Math.round(v)) }, height: 290,
        panels: [
            { y: { min: alo, max: ahi, label: 'annual balance, m w.e.', fmt: (v) => v.toFixed(1) }, layers: [
                { type: 'bars', width: 1, pts: rows.map(r => ({ x: r.year, y: r.annual, color: r.annual >= 0 ? POS : NEG, tip: () => `<b>${r.year}</b>: ${r.annual >= 0 ? '+' : ''}${r.annual.toFixed(2)} m w.e.${r.winter !== null ? `<br>winter +${r.winter.toFixed(2)} · summer ${r.summer?.toFixed(2)}` : ''}` })) },
                { type: 'vline', x: mb.ends + 0.5, label: `copy ends ${mb.ends}` },
            ] },
            { weight: 0.8, y: { min: clo, max: chi, label: `cumulative since ${mb.starts}, m w.e.`, fmt: (v) => v.toFixed(0) }, layers: [
                { type: 'line', pts: cum.map(c => [c.year, c.cumulative]), color: INK, width: 2.5, tip: (x, y) => `${x}: ${y.toFixed(1)} m w.e. since ${mb.starts}`, endLabel: (y) => `${y.toFixed(1)} m w.e.` },
            ] },
        ],
    });
    $('gw-mb-sub').textContent = `WGMS ${mb.starts}–${mb.ends} · ${mb.n_years} years`;
    $('gw-mb-note').innerHTML = `Metres of water equivalent averaged over the glacier: −1 m w.e. ≈ 1.1 m of ice thickness lost everywhere. ` +
        `<b>${mb.ends + 1}–2025 are not in this copy yet</b>: WGMS has published them, and they will be added when the archive refresh pulls the current release.`;
}

// ── weather ──────────────────────────────────────────────────────────────────
async function loadWeather(g) {
    const z = S.elev?.glaciers?.[g.id]?.z_m;
    const pts = S.gauges.filter(q => q.id !== 'fastest').map(q => ({ id: q.id, lat: g.flowline.lat[q.idx], lon: g.flowline.lon[q.idx], elev: z?.[q.idx] ?? null }));
    if (pts.some(p => !Number.isFinite(p.elev))) { chip('gw-chip-weather', 'down', 'Weather at the ice: no elevations'); return; }
    chip('gw-chip-weather', 'loading', 'Weather at the ice: loading…');
    try {
        const w = await loadGlacierWeather(pts, { nowMs: S.nowMs });
        S.weather[g.id] = { ...w, pts };
        chip('gw-chip-weather', w.failed.length ? 'stale' : 'live', w.failed.length ? `Weather: ${w.failed.join(' + ')} failed` : 'Weather at the ice: ERA5 + forecast');
    } catch (e) { S.weather[g.id] = { error: e.message }; chip('gw-chip-weather', 'down', 'Weather at the ice: unavailable'); }
    if (S.sel === g) renderWeather();
}

function renderWeather() {
    const g = S.sel, w = S.weather[g.id];
    const empty = w && !w.error && !(w.points || []).some(p => p.days.length);
    if (!w || w.error || empty) {
        S.charts.weather.render(null);
        $('gw-weather-note').innerHTML = `<div class="gw-empty">${w?.error || empty ? `Weather at the ice is unavailable right now${w?.failed?.length ? ` (${w.failed.join(' and ')} request failed)` : ''}. Nothing is drawn rather than a guess.` : 'Loading weather at the glacier…'}</div>`;
        return;
    }
    const k = Math.max(0, w.pts.findIndex(p => p.id === 'middle')), days = w.points[k].days;
    const start = hydroStart(S.nowMs, g.lat), cmp = seasonCompare(days, S.nowMs, g.lat);
    const doy = (t, s) => (t - s) / DAY;
    const thisYear = degreeDays(days, start, S.nowMs + 17 * DAY).series;
    const obs = thisYear.filter(p => p.t <= cmp.uptoMs), fc = thisYear.filter(p => p.t >= cmp.uptoMs);
    const pastLines = [];
    for (let y = 1; y <= 10; y++) {
        const s = Date.UTC(new Date(start).getUTCFullYear() - y, new Date(start).getUTCMonth(), 1);
        const ser = degreeDays(days, s, s + 365 * DAY).series;
        if (ser.length > 300) pastLines.push({ y: new Date(s).getUTCFullYear() + 1, ser: ser.map(p => [doy(p.t, s), p.pdd]), snow: ser.map(p => [doy(p.t, s), p.snow]) });
    }
    const maxPdd = Math.max(1, ...pastLines.flatMap(l => l.ser.map(p => p[1])), ...thisYear.map(p => p.pdd));
    const maxSnow = Math.max(1, ...pastLines.flatMap(l => l.snow.map(p => p[1])), ...thisYear.map(p => p.snow));
    const past = (key) => pastLines.map(l => ({ type: 'line', pts: l[key], color: INK3, width: 1, alpha: 0.45 }));
    const label = (s) => `${fmtDate(start + s * DAY)}`;
    S.charts.weather.render({
        x: { min: 0, max: 365, type: 'linear', label: 'days into the hydrological year', fmt: (v) => String(Math.round(v)) }, height: 290,
        panels: [
            { y: { min: 0, max: maxPdd * 1.05, label: 'positive degree-days, °C·d (melt driver)' }, layers: [
                ...past('ser'),
                { type: 'line', pts: obs.map(p => [doy(p.t, start), p.pdd]), color: ACCENT, width: 2.5, tip: (x, v) => `${label(x)} · this year ${v.toFixed(0)} °C·d`, endLabel: (v) => `${v.toFixed(0)} °C·d` },
                { type: 'line', pts: fc.map(p => [doy(p.t, start), p.pdd]), color: ACCENT, width: 2, dash: [4, 3], tip: (x, v) => `${label(x)} · forecast ${v.toFixed(0)} °C·d` },
            ] },
            { weight: 0.8, y: { min: 0, max: maxSnow * 1.05, label: 'snowfall, cm (cumulative)' }, layers: [
                ...past('snow'),
                { type: 'line', pts: obs.map(p => [doy(p.t, start), p.snow]), color: '#9fd8ff', width: 2.5, tip: (x, v) => `${label(x)} · this year ${v.toFixed(0)} cm`, endLabel: (v) => `${v.toFixed(0)} cm` },
                { type: 'line', pts: fc.map(p => [doy(p.t, start), p.snow]), color: '#9fd8ff', width: 2, dash: [4, 3], tip: (x, v) => `${label(x)} · forecast ${v.toFixed(0)} cm` },
            ] },
        ],
    });
    $('gw-weather-sub').textContent = `mid glacier · ${w.pts[k].elev.toFixed(0)} m a.s.l.`;
    $('gw-weather-note').innerHTML = `Hydrological year from ${fmtDate(start)} (${cmp.days} days so far): <b>${cmp.pdd.toFixed(0)} °C·d</b> of melt-driving warmth ` +
        `(rank ${cmp.rankPdd} of ${cmp.of}, warmest = 1; 10-year mean ${Number.isFinite(cmp.meanPdd) ? cmp.meanPdd.toFixed(0) : '—'}) and <b>${cmp.snow.toFixed(0)} cm</b> of snow ` +
        `(rank ${cmp.rankSnow} of ${cmp.of}). Gold/blue: this year, dashed = 16-day forecast. Grey: the previous ten years, same source and altitude. ERA5 reanalysis, lapse-corrected — a driver, not a measurement on the ice.`;
}

// ── stations ─────────────────────────────────────────────────────────────────
async function loadStations(g) {
    chip('gw-chip-stations', 'loading', 'Gauges & snow: loading…');
    try {
        const s = await getJson(`/api/glaciers/stations?g=${g.id}`);
        S.stations[g.id] = s;
        const anyOk = s.streamflow?.ok || s.snow?.ok;
        chip('gw-chip-stations', s.freshness === 'stale' ? 'stale' : anyOk ? 'live' : 'loading', anyOk ? `Gauges & snow: ${[s.streamflow?.ok && 'river', s.snow?.ok && 'snow'].filter(Boolean).join(' + ')}` : 'Gauges & snow: none near this glacier');
    } catch (e) { S.stations[g.id] = { error: e.message }; chip('gw-chip-stations', 'down', 'Gauges & snow: unavailable'); }
    if (S.sel === g) renderStations();
}

function renderStations() {
    const g = S.sel, s = S.stations[g.id];
    if (!s) { S.charts.stations.render(null); $('gw-stations-note').innerHTML = '<div class="gw-empty">Loading…</div>'; return; }
    const panels = [];
    const q = s.streamflow, sn = s.snow;
    const from = S.nowMs - 400 * DAY;
    if (q?.ok && q.daily?.length) {
        const [lo, hi] = extent(q.daily.map(p => p.q_cms), { zero: true });
        panels.push({ y: { min: lo, max: hi, label: `${q.site_name || 'outlet stream'} — discharge, m³/s (USGS ${q.gauge_used})`, fmt: (v) => v.toFixed(v < 10 ? 1 : 0) }, layers: [
            { type: 'line', pts: q.daily.map(p => [p.t, p.q_cms]), color: '#62b6ec', width: 2, tip: (t, v) => `${fmtDate(t)} · ${v.toFixed(2)} m³/s`, endLabel: (v) => `${v.toFixed(1)} m³/s` }] });
    }
    if (sn?.ok) for (const st of sn.stations) {
        const swe = st.series?.WTEQ || [];
        if (!swe.length) continue;
        const [lo, hi] = extent([...swe.map(p => p.v), ...swe.map(p => p.median)], { zero: true });
        panels.push({ weight: 0.8, y: { min: lo, max: hi, label: `${st.name || st.triplet} (${st.km} km) — snow-water equivalent, in.` }, layers: [
            { type: 'line', pts: swe.map(p => [p.t, p.median]), color: INK3, width: 1.5, dash: [4, 3], tip: (t, v) => `median ${v?.toFixed(1)} in.` },
            { type: 'line', pts: swe.map(p => [p.t, p.v]), color: '#9fd8ff', width: 2, tip: (t, v) => `${fmtDate(t)} · ${v.toFixed(1)} in. SWE`, endLabel: (v) => `${v.toFixed(1)} in.` }] });
    }
    if (!panels.length) {
        S.charts.stations.render(null);
        $('gw-stations-note').innerHTML = `<div class="gw-empty">${esc([q?.error && `River gauge: ${q.error}`, sn?.error && `Snow stations: ${sn.error}`].filter(Boolean).join(' · ') || 'No in-situ stations near this glacier.')}</div>`;
        $('gw-stations-sub').textContent = '';
        return;
    }
    S.charts.stations.render({ x: { min: from, max: S.nowMs, type: 'time' }, panels, height: 140 + 120 * panels.length });
    $('gw-stations-sub').textContent = esc(s.note || '');
    $('gw-stations-note').innerHTML = `In summer most of the water in a glacier's outlet stream is melt, so discharge is a daily readout of melting. SNOTEL stations sit off the ice, at similar altitudes. Sources: USGS NWIS, NRCS AWDB. Units as published.`;
}

// ── the daily tail ───────────────────────────────────────────────────────────
async function loadLive(g) {
    chip('gw-chip-live', 'loading', 'Daily pairs: checking…');
    try {
        const r = await getJson(`/api/glaciers/velocity?g=${g.id}`);
        S.live[g.id] = { ...r, pairs: (r.pairs || []).map(p => E.decodePair({ ...p, live: true })) };
        const n = S.live[g.id].pairs.length;
        chip('gw-chip-live', r.freshness === 'stale' ? 'stale' : 'live', r.freshness === 'stale' ? 'Daily pairs: listing failed' : n ? `Daily pairs: +${n} new since ${g.baked}` : `Daily pairs: up to date (${r.newest_pair_end || g.baked})`);
    } catch (e) { S.live[g.id] = { error: e.message, pairs: [] }; chip('gw-chip-live', 'down', 'Daily pairs: unavailable'); }
    if (S.sel === g) { renderNow(); renderYear(); renderProfile(); }
}

boot();
