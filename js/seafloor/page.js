/**
 * page.js — sea-floor.html's controller. DOM + drawing only: every number it prints comes from
 * page-model.js (`siteSummaries`, `siteDetail`), which assembles the PURE kernels. Do not grow
 * physics here (tests/seafloor-kernels.mjs greps this file for it).
 *
 * State is one object `S`; `select(id)` loads a site's grid, `refresh()` re-derives the detail and
 * redraws every panel. Tables update rows IN PLACE where the row set is unchanged.
 */
import { SEAFLOOR_SITES } from './sites.js';
import { loadIndex, loadCasts, loadGrid, loadWorld, loadDiveGrid } from './load.js';
import { siteSummaries, siteDetail, KIND_STYLE, DEPTH_RAMP, depthColor, fmt, sitePoint, customSite, castsNear, cameraReport, ambientColor, worldTexture } from './page-model.js';
import { BEAMS } from './sounder.js';
import { MODEL_GAP_WARN_M } from './profile.js';
import { GRID_VERTICAL_UNCERTAINTY_M, sampleDepth, worldElevationAt } from './bathy.js';
import { DIVE_MAX_LAT } from './free-dive.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NS = 'http://www.w3.org/2000/svg';
const S = { index: null, casts: null, world: null, rows: [], grids: new Map(), id: null, at: null, castId: null, beam: BEAMS[2].deg, nominal: 1500, detail: null, stage: null, globe: null, mode: 'globe', custom: null, pick: null, diveWhenReady: false, sort: { key: 'gridDepth', dir: -1 }, pingShown: false };
window.__seaFloor = S;

// ── tiny SVG helpers ─────────────────────────────────────────────────────────
function el(name, attrs = {}, text = null) { const e = document.createElementNS(NS, name); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; }
function ticks(lo, hi, n = 5) {
    const span = hi - lo; if (!(span > 0)) return [lo];
    const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), m = [1, 2, 2.5, 5, 10].find((k) => k * p >= raw) * p;
    const out = []; for (let v = Math.ceil(lo / m - 1e-9) * m; v <= hi + 1e-9; v += m) out.push(Math.abs(v) < 1e-12 ? 0 : v); return out;
}
const tickText = (v, step) => { const d = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9)); return v.toFixed(d); };
function shape(kind, x, y, r, attrs = {}) {
    const st = KIND_STYLE[kind];
    const base = { fill: st.color, stroke: '#0b1120', 'stroke-width': 2, ...attrs };
    if (st.shape === 'circle') return el('circle', { cx: x, cy: y, r, ...base });
    if (st.shape === 'square') return el('rect', { x: x - r * 0.9, y: y - r * 0.9, width: r * 1.8, height: r * 1.8, ...base });
    const pts = st.shape === 'triangle' ? [[x, y - r * 1.15], [x + r, y + r * 0.85], [x - r, y + r * 0.85]] : [[x, y - r * 1.2], [x + r * 1.2, y], [x, y + r * 1.2], [x - r * 1.2, y]];
    return el('polygon', { points: pts.map((p) => p.join(',')).join(' '), ...base });
}
function kindKeys() {
    return Object.entries(KIND_STYLE).map(([k, st]) => {
        const svg = el('svg', { width: 14, height: 14, viewBox: '0 0 14 14' }); svg.appendChild(shape(k, 7, 7, 4.5, { 'stroke-width': 0 }));
        return `<span>${svg.outerHTML}${esc(st.label)}</span>`;
    }).join('');
}
const tip = (node, html, e) => { node.innerHTML = html; node.hidden = false; const w = node.offsetWidth, h = node.offsetHeight; node.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, e.clientX + 14)) + 'px'; node.style.top = Math.max(6, Math.min(window.innerHeight - h - 6, e.clientY + 14)) + 'px'; };

/** The current selection: a named site, or the open-ocean point last dived at. */
function cur() {
    if (S.id === 'custom' && S.custom) return { site: S.custom.site, meta: S.custom.meta, grid: S.custom.grid, casts: castsNear(S.casts, S.custom.site.lat, S.custom.site.lon) };
    return { site: SEAFLOOR_SITES.find((s) => s.id === S.id), meta: S.index.sites.find((m) => m.id === S.id), grid: S.grids.get(S.id), casts: S.casts && S.casts.sites[S.id] ? S.casts.sites[S.id].casts : [] };
}
const kindLabel = (site) => site.kind === 'custom' ? 'Open ocean' : KIND_STYLE[site.kind].label;

// ── boot ─────────────────────────────────────────────────────────────────────
async function boot() {
    for (const b of BEAMS) $('sf-beam').add(new Option(b.label, b.deg, false, b.deg === S.beam));
    try {
        S.index = await loadIndex();
        $('sf-chip-bathy').dataset.state = 'ok';
        $('sf-chip-bathy').textContent = `Bathymetry: ${S.index.sites.length} sites, ETOPO1 / GEBCO 2014`;
        $('sf-baked').textContent = S.index.baked || 'recorded in the data index';
    } catch (e) {
        $('sf-chip-bathy').dataset.state = 'down'; $('sf-chip-bathy').textContent = 'Bathymetry: could not be loaded';
        $('sf-table-note').textContent = 'The bathymetry index could not be loaded, so nothing can be shown. Nothing is substituted.';
        return;
    }
    try {
        S.casts = await loadCasts();
        const n = Object.values(S.casts.sites).reduce((a, s) => a + s.casts.length, 0);
        $('sf-chip-casts').dataset.state = 'ok'; $('sf-chip-casts').textContent = `Temperature casts: ${n} from NOAA World Ocean Database`;
    } catch (e) {
        S.casts = null; $('sf-chip-casts').dataset.state = 'down'; $('sf-chip-casts').textContent = 'Temperature casts: could not be loaded';
    }
    S.rows = siteSummaries(S.index, S.casts);
    renderTable(); renderCompare();
    $('sf-map-keys').innerHTML = kindKeys() + `<span class="sf-ramp">0 m <canvas id="sf-ramp" width="140" height="8"></canvas> 11 km deep</span>`;
    drawRamp();
    drawMap();
    wire();
    const q = new URLSearchParams(location.search), want = q.get('site'), at = (q.get('at') || '').split(',').map(Number);
    select(S.rows.some((r) => r.id === want) ? want : 'mariana', { show: S.rows.some((r) => r.id === want) });
    loadWorld(S.index).then(async (w) => {
        S.world = w; drawMap();
        const m = await import('./globe.js');
        S.globe = m.createGlobe($('sf-globe-host'), { onPickPoint: pickPoint, onPickSite: (id, o) => select(id, { show: o.double }), onHover: globeHover, onDive: diveAt });
        if (!S.globe) { globeDown(); return; }
        window.__seaFloorGlobe = S.globe;
        S.globe.setWorld(w, worldTexture(w)); S.globe.setSites(S.rows); S.globe.setSelected(S.id);
        stageNote();
        if (at.length === 2 && at.every(Number.isFinite)) diveAt({ lat: at[0], lon: at[1] });
    }).catch((e) => { console.warn('sea-floor globe unavailable:', e && e.message); globeDown(); });
    import('./stage.js').then((m) => {
        S.stage = m.createStage($('sf-stage-host'), { onPick: (p) => { S.at = p; S.pingShown = false; refresh(); }, onCamera: renderHud, ambient: ambientColor });
        if (!S.stage) { $('sf-stage-fallback').hidden = false; return; }
        window.__seaFloorStage = S.stage;
        pushStage(true);
    }).catch(() => { $('sf-stage-fallback').hidden = false; });
}
/** No globe (no WebGL, or the planet grid failed to load): the sea-floor block and the flat map still work. */
function globeDown() { $('sf-mode-globe').disabled = true; $('sf-dive-here').disabled = true; if (S.mode === 'globe') setMode('local'); }

function wire() {
    $('sf-beam').addEventListener('change', (e) => { S.beam = +e.target.value; S.pingShown = false; refresh(); });
    $('sf-nominal').addEventListener('change', (e) => { S.nominal = +e.target.value; refresh(); });
    $('sf-cast').addEventListener('change', (e) => { S.castId = +e.target.value; refresh(); });
    $('sf-exag').addEventListener('input', (e) => { $('sf-exag-val').textContent = e.target.value + '×'; S.stage && S.stage.setExaggeration(+e.target.value); stageNote(); });
    for (const b of document.querySelectorAll('#sf-stage-tools [data-view]')) b.addEventListener('click', () => S.stage && S.stage.view(b.dataset.view));
    $('sf-reset-point').addEventListener('click', () => { S.at = null; S.pingShown = false; refresh(); });
    $('sf-ping').addEventListener('click', firePing);
    $('sf-mode-globe').addEventListener('click', () => setMode('globe'));
    $('sf-mode-local').addEventListener('click', () => setMode('local'));
    $('sf-globe-exag').addEventListener('input', (e) => { $('sf-globe-exag-val').textContent = e.target.value + '×'; S.globe && S.globe.setExaggeration(+e.target.value); stageNote(); });
    $('sf-water').addEventListener('change', (e) => { S.globe && S.globe.setWater(e.target.checked); });
    $('sf-dive-here').addEventListener('click', () => { if (S.pick) diveAt(S.pick); else { setMode('local'); diveNow(); } });
    $('sf-dive').addEventListener('click', () => { if (S.stage && S.stage.state.underwater) S.stage.view('oblique'); else diveNow(); });
    const map = $('sf-map');
    map.addEventListener('pointermove', (e) => { const r = mapHit(e); if (r) tip($('sf-map-tip'), mapTip(r), e); else $('sf-map-tip').hidden = true; map.style.cursor = r ? 'pointer' : 'default'; });
    map.addEventListener('pointerleave', () => { $('sf-map-tip').hidden = true; });
    map.addEventListener('click', (e) => { const r = mapHit(e); if (r) select(r.id, { show: true }); });
    new ResizeObserver(() => drawMap()).observe($('sf-map-wrap'));
    let rt = 0; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.detail) { renderSection(); renderColumn(); } renderCompare(); }, 150); });
}

// ── world map ────────────────────────────────────────────────────────────────
const MAP_LAT = 84;                                   // drawn ±84°: the Mercator source ends at 85° (see index.world)
let mapImg = null;
function mapXY(lat, lon, w, h) { return [(lon + 180) / 360 * w, (MAP_LAT - lat) / (2 * MAP_LAT) * h]; }
function drawMap() {
    const c = $('sf-map'), wrap = $('sf-map-wrap'), dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(200, wrap.clientWidth), h = Math.max(100, wrap.clientHeight);
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#060b16'; g.fillRect(0, 0, w, h);
    if (S.world) {
        if (!mapImg) {
            const W = S.world, j0 = Math.round((90 - MAP_LAT) / W.step), rows = W.ny - 2 * j0;
            const off = document.createElement('canvas'); off.width = W.nx; off.height = rows;
            const og = off.getContext('2d'), im = og.createImageData(W.nx, rows);
            for (let j = 0; j < rows; j++) for (let i = 0; i < W.nx; i++) {
                const col = depthColor(-W.z[(j + j0) * W.nx + i]), k = (j * W.nx + i) * 4;
                // the map sits behind markers: the ramp is drawn at reduced lightness so the site marks carry the contrast
                im.data[k] = col[0] * 0.62; im.data[k + 1] = col[1] * 0.62; im.data[k + 2] = col[2] * 0.62; im.data[k + 3] = 255;
            }
            og.putImageData(im, 0, 0); mapImg = off;
        }
        g.imageSmoothingEnabled = true; g.drawImage(mapImg, 0, 0, w, h);
    }
    for (const r of S.rows) {
        const [x, y] = mapXY(r.lat, r.lon, w, h), st = KIND_STYLE[r.kind], sel = r.id === S.id, rad = sel ? 7 : 5;
        g.beginPath();
        if (st.shape === 'circle') g.arc(x, y, rad, 0, 6.2832);
        else if (st.shape === 'square') g.rect(x - rad * 0.9, y - rad * 0.9, rad * 1.8, rad * 1.8);
        else if (st.shape === 'triangle') { g.moveTo(x, y - rad * 1.15); g.lineTo(x + rad, y + rad * 0.85); g.lineTo(x - rad, y + rad * 0.85); g.closePath(); }
        else { g.moveTo(x, y - rad * 1.2); g.lineTo(x + rad * 1.2, y); g.lineTo(x, y + rad * 1.2); g.lineTo(x - rad * 1.2, y); g.closePath(); }
        g.fillStyle = st.color; g.fill(); g.lineWidth = sel ? 2.5 : 1.5; g.strokeStyle = sel ? '#ffffff' : '#0b1120'; g.stroke();
        if (sel) { g.font = '600 11px system-ui'; g.fillStyle = '#fff'; g.textBaseline = 'middle'; const right = x < w - 150; g.textAlign = right ? 'left' : 'right'; g.fillText(r.deep || r.name, x + (right ? 11 : -11), y); }
    }
}
function mapHit(e) {
    const r = $('sf-map').getBoundingClientRect(); let best = null, bd = 16;
    for (const row of S.rows) { const [x, y] = mapXY(row.lat, row.lon, r.width, r.height); const d = Math.hypot(e.clientX - r.left - x, e.clientY - r.top - y); if (d < bd) { bd = d; best = row; } }
    return best;
}
function tempCell(r) { return r.floorKind ? `${fmt.t(r.floorT)} <span class="sf-badge" data-kind="${r.floorKind}">${fmt.kind(r.floorKind)}</span>` : '<small>no cast nearby</small>'; }
function mapTip(r) { return `<b>${esc(r.deep ? `${r.deep} · ${r.name}` : r.name)}</b><br><small>${esc(KIND_STYLE[r.kind].label)} · ${esc(r.ocean)}</small><br>${fmt.m(r.gridDepth)} <small>${r.kind === 'plain' ? 'typical floor' : 'deepest grid cell'}</small><br>Bottom water ${tempCell(r)}`; }
function drawRamp() {
    const c = $('sf-ramp'); if (!c) return; const g = c.getContext('2d'), max = DEPTH_RAMP[DEPTH_RAMP.length - 1][0];
    for (let x = 0; x < c.width; x++) { const k = depthColor(Math.max(1, x / (c.width - 1) * max)); g.fillStyle = `rgb(${k[0]},${k[1]},${k[2]})`; g.fillRect(x, 0, 1, c.height); }
}

// ── table ────────────────────────────────────────────────────────────────────
const COLS = [
    { key: 'name', label: 'Site', text: (r) => `${esc(r.name)}${r.deep ? ` <small>${esc(r.deep)}</small>` : ''}` },
    { key: 'kind', label: 'Type', text: (r) => esc(KIND_STYLE[r.kind].label) },
    { key: 'gridDepth', label: 'Depth (grid)', n: 1, text: (r) => `${fmt.m(r.gridDepth)}${r.kind === 'plain' ? ' <small>typical</small>' : ''}` },
    { key: 'published', label: 'Commonly quoted', n: 1, text: (r) => r.published ? `${fmt.m(r.published)} <small>unchecked</small>` : '<small>—</small>' },
    { key: 'floorDbar', label: 'Pressure', n: 1, text: (r) => `${Math.round(r.floorDbar / 10.1325 + 1).toLocaleString('en-US')} atm` },
    { key: 'floorT', label: 'Bottom temperature', n: 1, text: tempCell },
    { key: 'castDepth', label: 'Deepest cast', n: 1, val: (r) => r.cast ? r.cast.maxDepth : -1, text: (r) => r.cast ? `${fmt.m(r.cast.maxDepth)} <small>${esc(r.cast.date.slice(0, 4))}</small>` : '<small>—</small>' },
];
function renderTable() {
    const head = $('sf-table').tHead, body = $('sf-table').tBodies[0];
    if (!head.rows.length) {
        const tr = head.insertRow();
        for (const c of COLS) { const th = document.createElement('th'); th.textContent = c.label; th.dataset.key = c.key; if (c.n) th.className = 'n'; th.tabIndex = 0; th.addEventListener('click', () => { S.sort = { key: c.key, dir: S.sort.key === c.key ? -S.sort.dir : (c.n ? -1 : 1) }; renderTable(); }); tr.appendChild(th); }
    }
    for (const th of head.rows[0].cells) th.setAttribute('aria-sort', th.dataset.key === S.sort.key ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none');
    const col = COLS.find((c) => c.key === S.sort.key), val = col.val || ((r) => r[col.key]);
    const rows = S.rows.slice().sort((a, b) => { const x = val(a), y = val(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * S.sort.dir; });
    const order = rows.map((r) => r.id).join('|');
    if (body.dataset.order !== order) {
        body.textContent = '';
        for (const r of rows) { const tr = body.insertRow(); tr.dataset.id = r.id; tr.tabIndex = 0; for (const c of COLS) { const td = tr.insertCell(); if (c.n) td.className = 'n'; td.innerHTML = c.text(r); } tr.addEventListener('click', () => select(r.id, { show: true })); tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') select(r.id, { show: true }); }); }
        body.dataset.order = order;
    }
    for (const tr of body.rows) tr.setAttribute('aria-selected', tr.dataset.id === S.id ? 'true' : 'false');
    const measured = S.rows.filter((r) => r.floorKind === 'measured').length, model = S.rows.filter((r) => r.floorKind === 'model').length, none = S.rows.length - measured - model;
    $('sf-table-note').innerHTML = `Depth is each window's deepest grid cell (± about ${GRID_VERTICAL_UNCERTAINTY_M} m for a grid of this kind); for an abyssal plain it is the window's typical floor. `
        + `Bottom temperature is <b>measured</b> at ${measured} site${measured === 1 ? '' : 's'} (a cast reached the grid's floor), <b>modelled</b> at ${model} (continued below the deepest cast)`
        + (none ? `, and absent at ${none} where no archived cast within 150 km reaches 2 km.` : '.')
        + (S.casts ? '' : ' <b>The cast archive could not be loaded, so no temperatures are shown.</b>');
}

// ── selection ────────────────────────────────────────────────────────────────
async function select(id, { show = false } = {}) {
    if (!S.rows.some((r) => r.id === id)) return;
    S.id = id; S.at = null; S.castId = null; S.pingShown = false; S.pick = null;
    const site = SEAFLOOR_SITES.find((s) => s.id === id), row = S.rows.find((r) => r.id === id);
    titles(site, row.lat, row.lon);
    renderTable(); drawMap();
    if (S.globe) { S.globe.setSelected(id); if (S.mode === 'globe' && !show) S.globe.flyTo(row.lat, row.lon); }
    const u = new URL(location.href); u.searchParams.set('site', id); u.searchParams.delete('at'); history.replaceState(null, '', u);
    if (!S.grids.has(id)) {
        try { S.grids.set(id, await loadGrid(S.index.sites.find((m) => m.id === id))); }
        catch (e) { if (S.id === id) { S.detail = null; $('sf-stage-readout').textContent = 'This site\'s bathymetry could not be loaded.'; $('sf-sound-body').innerHTML = '<div class="sf-empty">This site\'s bathymetry could not be loaded.</div>'; } return; }
    }
    if (S.id !== id) return;
    refresh(true);
    if (show) setMode('local');
}
function titles(site, lat, lon) {
    $('sf-site-title').textContent = site.kind === 'custom' ? 'Open ocean' : (site.deep ? `${site.deep}, ${site.name}` : site.name);
    $('sf-site-sub').textContent = `${kindLabel(site)}${site.ocean ? ' · ' + site.ocean : ''} · ${fmt.latlon(lat, lon)}`;
}

// ── the globe: read a depth anywhere, dive anywhere ──────────────────────────
function pickPoint(p) {
    S.pick = p; S.globe && S.globe.setSelected(S.id, p); renderReadout();
}
function globeHover(h, e) {
    const tipEl = $('sf-map-tip');
    if (!h) { tipEl.hidden = true; return; }
    if (h.site) { tip(tipEl, mapTip(S.rows.find((r) => r.id === h.site)) + '<br><small>click to select · double-click to go there</small>', e); return; }
    const el = h.elevation;
    tip(tipEl, `${fmt.latlon(h.point.lat, h.point.lon)}<br>${el < 0 ? `<b>${fmt.m(-el)}</b> deep <small>25 km overview grid</small>` : `land, ${fmt.m(el)} above sea level`}`, e);
}
let diveSeq = 0;
async function diveAt(p) {
    const seq = ++diveSeq, say = (t) => { $('sf-stage-readout').innerHTML = t; };
    if (Math.abs(p.lat) > DIVE_MAX_LAT) { say(`Dives stop at ${DIVE_MAX_LAT}° of latitude: the sea-floor tiles end near the poles.`); return; }
    if (S.world && worldElevationAt(S.world, p.lat, p.lon) >= 0) { S.pick = p; S.globe && S.globe.setSelected(S.id, p); say(`${fmt.latlon(p.lat, p.lon)} is land. Pick a point on the ocean to dive.`); return; }
    S.pick = p; S.globe && S.globe.setSelected(S.id, p);
    say(`Reading the sea floor at ${fmt.latlon(p.lat, p.lon)}…`);
    if (S.globe && S.mode === 'globe') S.globe.flyTo(p.lat, p.lon, 1.6, 1100);
    let got;
    try { got = await loadDiveGrid(p.lat, p.lon); }
    catch (e) { if (seq === diveSeq) say(`The sea floor at ${fmt.latlon(p.lat, p.lon)} could not be read just now, so there is nothing to dive into. Nothing is drawn in its place.`); return; }
    if (seq !== diveSeq) return;
    if (!(sampleDepth(got.grid, p.lat, p.lon) > 0)) { say(`${fmt.latlon(p.lat, p.lon)} is land on the detailed grid. Pick a point further from the coast.`); return; }
    S.custom = { site: customSite(p.lat, p.lon), meta: got.meta, grid: got.grid };
    S.id = 'custom'; S.at = null; S.castId = null; S.pingShown = false; S.pick = null;
    titles(S.custom.site, p.lat, p.lon); renderTable(); drawMap();
    S.globe && S.globe.setSelected(null, p);
    const u = new URL(location.href); u.searchParams.delete('site'); u.searchParams.set('at', `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`); history.replaceState(null, '', u);
    refresh(true);
    setMode('local'); diveNow();
}
/** Fly under the surface at the sounding point (as soon as the block is on screen). */
function diveNow() {
    if (!S.stage || !S.detail || !(S.detail.point.depth > 0)) { S.diveWhenReady = true; return; }
    S.diveWhenReady = false;
    const ax = S.detail.axis;
    requestAnimationFrame(() => S.stage.dive({ lat: S.detail.point.lat, lon: S.detail.point.lon, depth: S.detail.point.depth, alongDeg: ax && ax.defined ? ax.azimuthDeg : null }));
}
function setMode(m) {
    if (m === 'globe' && (!S.globe)) m = 'local';
    S.mode = m; $('sf-stage').dataset.mode = m;
    $('sf-mode-globe').setAttribute('aria-pressed', m === 'globe'); $('sf-mode-local').setAttribute('aria-pressed', m === 'local');
    $('sf-dive-hud').hidden = m !== 'local';
    if (m === 'globe' && S.detail) S.globe.flyTo(S.detail.point.lat, S.detail.point.lon);
    renderReadout(); stageNote();
}
function renderHud(cam) {
    const hud = $('sf-dive-hud'), c = cur();
    if (!S.detail || !c.grid) return;
    const r = cameraReport(S.detail, c.grid, cam);
    $('sf-dive').textContent = r.underwater ? 'Surface ▲' : 'Dive ▼';
    if (!r.underwater) { hud.innerHTML = `You are <b>${fmt.m(-cam.depthM)}</b> above the sea surface. <small>Press Dive, or zoom in, to go under.</small>`; return; }
    hud.innerHTML = `<span class="sf-zone">${esc(r.zone.name)}</span> <small>${esc(r.zone.note)}</small><br>`
        + `You are <b>${fmt.m(r.depthM)}</b> below the surface`
        + (r.aboveFloorM != null ? `, <b>${fmt.m(Math.max(0, r.aboveFloorM))}</b> above the sea floor` : '') + `<br>`
        + `Pressure <b>${Math.round(r.atm).toLocaleString('en-US')} atm</b> · ${fmt.light(r.light)}<br>`
        + (r.t != null ? `Water <b>${fmt.t(r.t)}</b> <small>${fmt.kind(r.tKind)}, from the cast at the sounding point${r.kmFromPoint > 30 ? `, which is ${Math.round(r.kmFromPoint)} km from you` : ''}</small>`
            : `<small>${S.detail.column ? 'No temperature at this depth: the column here does not reach it.' : 'No temperature: no archived cast within 150 km of this point.'}</small>`);
}
function refresh(newSite = false) {
    const c = cur();
    if (!c.grid) return;
    const args = { site: c.site, meta: c.meta, grid: c.grid, casts: c.casts, beamDeg: S.beam, nominal: S.nominal, castId: S.castId };
    S.detail = siteDetail({ ...args, at: S.at });
    if (S.detail.land) { S.at = null; S.detail = siteDetail({ ...args, at: null }); }
    if (S.detail.land) return;
    renderCastPicker(); renderSection(); renderSound(); renderColumn(); renderReadout(); pushStage(newSite);
    if (S.diveWhenReady) diveNow();
}
function pushStage(newSite) {
    if (!S.stage || !S.detail) return;
    const d = S.detail, c = cur();
    if (newSite) S.stage.setGrid(c.grid, sitePoint(c.site, c.meta));
    S.stage.setCasts(d.casts.map((k) => ({ ...k, selected: d.cast && k.wod_cast === d.cast.wod_cast })));
    S.stage.setMarks({ section: d.section, point: d.point, beamDeg: S.beam, hit: S.pingShown && d.echo ? d.echo.hit : null });
    stageNote();
}
function stageNote() {
    if (S.mode === 'globe') {
        const x = +$('sf-globe-exag').value;
        $('sf-stage-note').innerHTML = `Relief exaggerated <b>${x}×</b>${x === 1 ? ' (true scale: the deepest trench is 0.17 % of Earth\'s radius)' : ''}; darker blue is deeper. Drag to turn, scroll to zoom. `
            + `Click the ocean to read its depth, then <b>Dive here</b> (or double-click) to go under the surface at that spot. Marked sites have real temperature casts. Untick Water to drain the ocean. The globe's grid is about 25 km; a dive loads 1.8 km detail.`;
        return;
    }
    const x = +$('sf-exag').value;
    $('sf-stage-note').innerHTML = `Vertical scale exaggerated <b>${x}×</b>${x === 1 ? ' (true scale)' : ''}. Drag to orbit, scroll to zoom, W A S D or the arrow keys to travel along the sea floor (click the view first), click the sea floor to move the sounding point. `
        + `Under water the sea is drawn clear, with a light haze for distance, and the floor is lit artificially: real sea water lets you see only tens of metres, and below about 1,000 m there is no sunlight. The background colour follows the light at your depth. `
        + `Coloured strings are real casts (pale = warm, dark = cold); the white line is the cross-section. Grid cells are about 1.8 km.`;
}
function renderReadout() {
    const out = $('sf-stage-readout');
    if (S.mode === 'globe') {
        if (S.pick && S.world) {
            const el = worldElevationAt(S.world, S.pick.lat, S.pick.lon);
            out.innerHTML = el < 0 ? `<b>${fmt.m(-el)}</b> deep at ${fmt.latlon(S.pick.lat, S.pick.lon)} <small>25 km overview grid</small><br><small>Press <b>Dive here</b> to load the detailed sea floor and go under.</small>`
                : `${fmt.latlon(S.pick.lat, S.pick.lon)} is land, ${fmt.m(el)} above sea level. <small>Pick a point on the ocean.</small>`;
            return;
        }
        if (!S.detail) { out.textContent = ''; return; }
    }
    const d = S.detail; if (!d) return;
    const p = d.point, site = cur().site;
    out.innerHTML = `<b>${fmt.m(p.depth)}</b> deep at ${fmt.latlon(p.lat, p.lon)} <small>${p.custom ? 'your point' : (site.kind === 'plain' ? 'window centre' : 'deepest grid cell')}</small><br>`
        + (d.floor ? `Bottom water ${fmt.t(d.floor.t)} <small>${fmt.kind(d.floor.kind)}</small> · ` : `${S.casts ? 'No cast within 150 km' : 'Casts not loaded'} · `)
        + (d.pressure ? `${Math.round(d.pressure.atm).toLocaleString('en-US')} atm` : '');
}

// ── sounding ─────────────────────────────────────────────────────────────────
function firePing() {
    const d = S.detail; if (!d) return;
    S.pingShown = true; renderSound(); pushStage(false);
    if (S.stage && d.echo) S.stage.ping({ lat: d.point.lat, lon: d.point.lon, depth: d.point.depth, hit: d.echo.hit.offKm > 0.05 ? d.echo.hit : null });
}
function renderSound() {
    const d = S.detail, out = [];
    $('sf-sound-sub').textContent = `${fmt.latlon(d.point.lat, d.point.lon)} · grid depth ${fmt.m(d.point.depth)}`;
    if (d.ping) {
        const g = d.ping, short = g.depthM < d.point.depth - 1;
        out.push(`<div class="sf-inst"><h3>1 · Echo time <small>a sounder measures seconds, not metres</small></h3>
          <div class="sf-big">${g.twoWayS.toFixed(3)} s <small style="font-size:.72rem;font-weight:400;color:var(--sf-ink-3)">there and back${short ? ` to ${fmt.m(g.depthM)}` : ''}</small></div>
          <dl class="sf-dl"><dt>At an assumed ${g.nominal.toFixed(0)} m/s</dt><dd>${fmt.m(g.naiveDepth)} <small>${Math.abs(Math.round(g.errorM)).toLocaleString('en-US')} m too ${g.errorM < 0 ? 'shallow' : 'deep'}</small></dd>
          <dt>Real mean sound speed</dt><dd>${g.meanSpeed.toFixed(1)} m/s <small>from this column's temperature, salinity and pressure</small></dd>
          <dt>Corrected depth</dt><dd>${fmt.m(g.depthM)} <small>± ${Math.round(g.speedUncertaintyM)} m from the sound-speed formula alone</small></dd></dl>
          ${short ? `<div class="sf-note">The column here ends at ${fmt.m(g.depthM)}; the echo is timed only through water the column describes.</div>` : ''}</div>`);
    } else out.push(`<div class="sf-inst"><h3>1 · Echo time</h3><div class="sf-empty">No temperature cast near this point, so there is no sound-speed profile to time an echo through. Nothing is assumed in its place.</div></div>`);
    if (d.echo) {
        const e = d.echo, side = e.hit.offKm > 0.05;
        out.push(`<div class="sf-inst"><h3>2 · Beam <small>the first echo comes from the nearest sea floor in the cone</small></h3>
          <dl class="sf-dl"><dt>Footprint at this depth</dt><dd>${fmt.km(e.footprintM / 1000, e.footprintM < 2000 ? 2 : 1)} across <small>${e.beamDeg}° beam</small></dd>
          <dt>First return</dt><dd>${side ? `${fmt.m(e.apparentDepth)} <small>a side echo from ${fmt.km(e.hit.offKm)} away, ${Math.abs(Math.round(e.biasM)).toLocaleString('en-US')} m too shallow</small>` : `${fmt.m(e.apparentDepth)} <small>from directly below: no side echo on this grid</small>`}</dd></dl>
          <div class="sf-note">${S.pingShown ? (side ? 'The orange line in the 3D block is that side echo.' : 'The pulse went straight down and back.') : 'Press <b>Ping</b> on the 3D block to watch it.'}</div></div>`);
    }
    if (d.pressure) out.push(`<div class="sf-inst"><h3>3 · Pressure gauge <small>how landers and submersibles do it</small></h3>
          <dl class="sf-dl"><dt>Pressure on the floor</dt><dd>${Math.round(d.pressure.dbar).toLocaleString('en-US')} dbar <small>${d.pressure.MPa.toFixed(1)} MPa · ${Math.round(d.pressure.atm).toLocaleString('en-US')} atmospheres</small></dd>
          <dt>Converts back to</dt><dd>${fmt.m(d.pressure.depthM)} <small>standard-ocean formula, good to about 0.1–0.2 %</small></dd></dl></div>`);
    $('sf-sound-body').innerHTML = out.join('');
}

// ── cross-section ────────────────────────────────────────────────────────────
function renderSection() {
    const d = S.detail, host = $('sf-section-chart'), W = Math.max(320, host.clientWidth || 560), H = 300, m = { l: 52, r: 12, t: 10, b: 32 };
    const sec = d.section.filter((p) => p.depth != null);
    $('sf-section-sub').textContent = `240 km along bearing ${Math.round(d.sectionAzimuth)}°${d.axis && d.axis.defined ? ', across the deepest line' : ''}`;
    host.textContent = '';
    if (sec.length < 3) { host.innerHTML = '<div class="sf-empty">The section leaves this window.</div>'; return; }
    const maxD = Math.max(1000, Math.ceil(Math.max(...sec.map((p) => p.depth)) / 1000) * 1000), minD = Math.min(0, Math.floor(Math.min(...sec.map((p) => p.depth)) / 1000) * 1000);
    const x = (s) => m.l + (s + 120) / 240 * (W - m.l - m.r), y = (dep) => m.t + (dep - minD) / (maxD - minD) * (H - m.t - m.b);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Depth along the cross-section' });
    for (const v of ticks(minD, maxD, 5)) { svg.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: 'var(--sf-grid)' })); svg.appendChild(el('text', { x: m.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, v === 0 ? 'sea level' : `${(v / 1000).toFixed(0)} km`)); }
    for (const v of [-100, -50, 0, 50, 100]) svg.appendChild(el('text', { x: x(v), y: H - m.b + 14, 'text-anchor': 'middle' }, `${v} km`));
    svg.appendChild(el('rect', { x: m.l, y: y(Math.max(0, minD)), width: W - m.l - m.r, height: y(maxD) - y(Math.max(0, minD)), fill: 'rgba(57,135,229,.10)' }));
    let path = `M${x(sec[0].s)},${y(maxD)}`; for (const p of sec) path += `L${x(p.s).toFixed(1)},${y(p.depth).toFixed(1)}`; path += `L${x(sec[sec.length - 1].s)},${y(maxD)}Z`;
    svg.appendChild(el('path', { d: path, fill: '#1c2740', stroke: 'none' }));
    svg.appendChild(el('path', { d: 'M' + sec.map((p) => `${x(p.s).toFixed(1)},${y(p.depth).toFixed(1)}`).join('L'), fill: 'none', stroke: 'var(--sf-s1)', 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    if (maxD > 6000) { svg.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y(6000), y2: y(6000), stroke: '#8f98ad', 'stroke-dasharray': '3 4' })); svg.appendChild(el('text', { x: W - m.r - 2, y: y(6000) - 4, 'text-anchor': 'end' }, 'hadal zone below 6 km')); }
    svg.appendChild(el('line', { x1: x(0), x2: x(0), y1: y(Math.max(0, minD)), y2: y(d.point.depth), stroke: '#9fe8ff' }));
    svg.appendChild(el('circle', { cx: x(0), cy: y(d.point.depth), r: 4.5, fill: '#9fe8ff', stroke: '#0b1120', 'stroke-width': 2 }));
    const cross = el('line', { y1: m.t, y2: H - m.b, stroke: '#e3eaf6', 'stroke-opacity': .5, visibility: 'hidden' }); svg.appendChild(cross);
    const hit = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }); svg.appendChild(hit);
    const ve = ((W - m.l - m.r) / 240) / ((H - m.t - m.b) / ((maxD - minD) / 1000));
    const base = `Deepest on this line ${fmt.m(Math.max(...sec.map((p) => p.depth)))} · steepest slope ${d.steepest.deg.toFixed(0)}° <small>between 1 km samples</small>`;
    $('sf-section-read').innerHTML = base;
    hit.addEventListener('pointermove', (e) => { const r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) / r.width * W, s = (sx - m.l) / (W - m.l - m.r) * 240 - 120; let b = sec[0]; for (const p of sec) if (Math.abs(p.s - s) < Math.abs(b.s - s)) b = p; cross.setAttribute('x1', x(b.s)); cross.setAttribute('x2', x(b.s)); cross.setAttribute('visibility', 'visible'); $('sf-section-read').innerHTML = `${b.s.toFixed(0)} km: <b>${fmt.m(b.depth)}</b> <small>${fmt.latlon(b.lat, b.lon)}</small>`; });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); $('sf-section-read').innerHTML = base; });
    host.appendChild(svg);
    $('sf-section-note').innerHTML = `Drawn ${(1 / ve).toFixed(0)}× taller than true scale. `
        + (d.axis && d.axis.defined ? `The line runs across the direction along which the floor is deepest. ` : `No clear trench axis in this window, so the line runs east–west. `)
        + `Within this window ${Math.round(d.hyps.hadalAreaKm2).toLocaleString('en-US')} km² of floor lies below 6 km.`;
}

// ── water column: three small multiples on ONE depth axis ────────────────────
function renderCastPicker() {
    const d = S.detail, sel = $('sf-cast'), ids = d.casts.map((c) => c.wod_cast).join('|');
    if (sel.dataset.ids !== S.id + ':' + ids) {
        sel.textContent = '';
        for (const c of d.casts.slice().sort((a, b) => b.max_depth_m - a.max_depth_m)) sel.add(new Option(`${c.date} · to ${Math.round(c.max_depth_m).toLocaleString('en-US')} m · ${Math.round(c.km)} km away`, c.wod_cast));
        sel.dataset.ids = S.id + ':' + ids;
    }
    sel.disabled = !d.casts.length;
    if (d.cast) sel.value = d.cast.wod_cast;
    const c = d.cast;
    $('sf-cast-meta').innerHTML = c ? `<small>${esc(c.platform ? c.platform.split('(')[0].trim() : 'platform not recorded')}${c.country ? ', ' + esc(c.country) : ''} · ${c.dataset === 'ctd' ? 'CTD' : c.dataset === 'pfl' ? 'profiling float' : 'bottle cast'} · WOD cast ${c.wod_cast}</small>` : '';
}
function renderColumn() {
    const d = S.detail, host = $('sf-column-chart'); host.textContent = '';
    $('sf-column-table').textContent = '';
    if (!d.column) {
        $('sf-column-sub').textContent = ''; $('sf-column-keys').textContent = ''; $('sf-column-read').textContent = '';
        host.innerHTML = `<div class="sf-empty">${S.casts ? (S.id === 'custom' ? 'No archived cast in this page\'s set lies within 150 km of this point, so there is no temperature profile here. Nothing is invented in its place.' : 'No archived cast within 150 km of this site reaches 2 km depth, so there is no profile to show. Nothing is invented in its place.') : 'The cast archive could not be loaded.'}</div>`;
        $('sf-column-note').textContent = ''; return;
    }
    const col = d.column, L = col.levels.filter((l) => l.z <= d.reach + 1e-6), hasS = col.salinity !== 'assumed';
    const W = Math.max(320, host.clientWidth || 900), narrow = W < 640, H = narrow ? 420 : 380, m = { l: 50, r: 10, t: 22, b: 30 }, gap = 26;
    const panels = [
        { key: 't', title: 'Temperature, °C', color: 'var(--sf-s1)' },
        ...(hasS ? [{ key: 's', title: 'Salinity', color: 'var(--sf-s4)' }] : []),
        { key: 'c', title: 'Sound speed, m/s', color: 'var(--sf-s2)' },
    ];
    const pw = (W - m.l - m.r - gap * (panels.length - 1)) / panels.length;
    const maxZ = Math.max(1000, Math.ceil(d.floorDepth / 1000) * 1000), y = (z) => m.t + z / maxZ * (H - m.t - m.b);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Temperature, salinity and sound speed against depth' });
    for (const v of ticks(0, maxZ, 6)) svg.appendChild(el('text', { x: m.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, v === 0 ? '0' : `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} km`));
    const scales = [];
    panels.forEach((p, k) => {
        const x0 = m.l + k * (pw + gap);
        // temperature panel: the deep sea is the subject, so the axis is the range BELOW 1 km (the warm surface runs off-scale and says so)
        const src = p.key === 't' ? L.filter((l) => l.z >= 1000) : (p.key === 's' ? L.filter((l) => l.sKind === 'measured') : L);
        let vals = src.map((l) => l[p.key]); if (p.key === 't') vals = vals.concat(src.map((l) => l.theta));
        let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.08 || 0.05; lo -= pad; hi += pad;
        const x = (v) => x0 + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * pw;
        scales.push({ p, x0, x, lo, hi });
        svg.appendChild(el('rect', { x: x0, y: m.t, width: pw, height: H - m.t - m.b, fill: 'rgba(140,190,255,.03)', stroke: 'var(--sf-grid)' }));
        svg.appendChild(el('text', { x: x0, y: 12, class: 't-strong' }, p.title + (p.key === 't' ? ' (scale set below 1 km)' : '')));
        const tk = ticks(lo, hi, narrow ? 2 : 4), step = tk.length > 1 ? tk[1] - tk[0] : 1;
        for (const v of tk) { svg.appendChild(el('line', { x1: x(v), x2: x(v), y1: m.t, y2: H - m.b, stroke: 'var(--sf-grid)' })); svg.appendChild(el('text', { x: x(v), y: H - m.b + 14, 'text-anchor': 'middle' }, tickText(v, step))); }
        for (const v of ticks(0, maxZ, 6)) svg.appendChild(el('line', { x1: x0, x2: x0 + pw, y1: y(v), y2: y(v), stroke: 'var(--sf-grid)' }));
        if (d.floorDepth <= maxZ) svg.appendChild(el('line', { x1: x0, x2: x0 + pw, y1: y(d.floorDepth), y2: y(d.floorDepth), stroke: '#8f98ad', 'stroke-width': 1.5 }));
        const line = (pts, attrs) => pts.length > 1 && svg.appendChild(el('path', { d: 'M' + pts.map((l) => `${x(l[attrs.f || p.key]).toFixed(1)},${y(l.z).toFixed(1)}`).join('L'), fill: 'none', 'stroke-linejoin': 'round', ...attrs.a }));
        const meas = L.filter((l) => l.kind === 'measured'), mod = L.filter((l) => l.kind === 'model');
        if (p.key === 't') line(L, { f: 'theta', a: { stroke: 'var(--sf-s3)', 'stroke-width': 1.5 } });
        if (p.key === 's') line(meas.filter((l) => l.sKind === 'measured'), { a: { stroke: p.color, 'stroke-width': 2 } });
        else {
            line(meas, { a: { stroke: p.color, 'stroke-width': 2 } });
            if (mod.length) line([meas[meas.length - 1], ...mod], { a: { stroke: p.color, 'stroke-width': 2, 'stroke-dasharray': '5 4' } });
        }
    });
    const tx = scales[0], bottom = L[L.length - 1];
    svg.appendChild(el('circle', { cx: tx.x(bottom.t), cy: y(bottom.z), r: 4.5, fill: 'var(--sf-s1)', stroke: '#0b1120', 'stroke-width': 2 }));
    svg.appendChild(el('text', { x: tx.x(bottom.t) + (tx.x(bottom.t) > tx.x0 + pw * 0.6 ? -8 : 8), y: y(bottom.z) - 6, 'text-anchor': tx.x(bottom.t) > tx.x0 + pw * 0.6 ? 'end' : 'start', class: 't-strong' }, `${bottom.t.toFixed(2)} °C at the floor`));
    if (d.tMin && !d.tMin.atFloor && d.tMin.z <= d.reach) { svg.appendChild(el('circle', { cx: tx.x(d.tMin.t), cy: y(d.tMin.z), r: 3.5, fill: '#0b1120', stroke: 'var(--sf-s1)', 'stroke-width': 2 })); svg.appendChild(el('text', { x: tx.x(d.tMin.t) + 8, y: y(d.tMin.z) + 3 }, `coldest ${d.tMin.t.toFixed(2)} °C`)); }
    const cross = el('line', { x1: m.l, x2: W - m.r, stroke: '#e3eaf6', 'stroke-opacity': .5, visibility: 'hidden' }); svg.appendChild(cross);
    const hit = el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent' }); svg.appendChild(hit);
    const base = `Bottom water <b>${fmt.t(d.floor.t)}</b> <small>${fmt.kind(d.floor.kind)}</small>` + (d.tMin && !d.tMin.atFloor ? ` · coldest ${fmt.t(d.tMin.t)} at ${fmt.m(d.tMin.z)}, <b>${(bottom.t - d.tMin.t).toFixed(2)} °C warmer at the floor</b>` : '') + (d.sofar && d.sofar.interior ? ` · sound channel at ${fmt.m(d.sofar.z)}` : '');
    $('sf-column-read').innerHTML = base;
    hit.addEventListener('pointermove', (e) => {
        const r = svg.getBoundingClientRect(), z = ((e.clientY - r.top) / r.height * H - m.t) / (H - m.t - m.b) * maxZ; let b = L[0]; for (const l of L) if (Math.abs(l.z - z) < Math.abs(b.z - z)) b = l;
        cross.setAttribute('y1', y(b.z)); cross.setAttribute('y2', y(b.z)); cross.setAttribute('visibility', 'visible');
        $('sf-column-read').innerHTML = `${fmt.m(b.z)} <small>${b.kind === 'model' ? 'modelled' : 'measured'}</small>: <b>${fmt.t(b.t, 3)}</b> · potential ${fmt.t(b.theta, 3)}${hasS ? ` · salinity ${b.s.toFixed(3)}${b.sKind === 'measured' ? '' : ' <small>(' + b.sKind + ')</small>'}` : ''} · sound ${b.c.toFixed(1)} m/s · ${Math.round(b.p).toLocaleString('en-US')} dbar`;
    });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); $('sf-column-read').innerHTML = base; });
    host.appendChild(svg);
    $('sf-column-sub').textContent = `measured to ${fmt.m(Math.min(col.measuredTo, d.reach))}${d.floor.kind === 'model' ? `, modelled for the last ${fmt.m(d.reach - col.measuredTo)}` : ', all the way to the floor'}`;
    const ln = (c, dash, label) => `<span><svg width="22" height="8"><line x1="0" y1="4" x2="22" y2="4" stroke="${c}" stroke-width="2" ${dash ? 'stroke-dasharray="5 4"' : ''}/></svg>${label}</span>`;
    $('sf-column-keys').innerHTML = ln('var(--sf-s1)', 0, 'Temperature, measured') + (d.floor.kind === 'model' ? ln('var(--sf-s1)', 1, 'Temperature, modelled (adiabat)') : '') + ln('var(--sf-s3)', 0, 'Potential temperature (compression removed)') + ln('#8f98ad', 0, 'Sea floor');
    const notes = [];
    notes.push(`The blue line is what a thermometer reads. The green line removes the heating from compression: where it runs straight down, the water is one mass and the blue line's warming with depth is pressure alone.`);
    if (d.withheld) { const w = d.withheld; notes.push(`<b>Model check on this cast:</b> hiding everything below ${fmt.m(w.cutDepth)} and predicting it, the adiabat is off by ${w.rms.adiabat.toFixed(3)} °C (rms over ${w.n} levels); holding temperature constant is off by ${w.rms.isothermal.toFixed(3)} °C, and extending the gradient above the cut by ${w.rms.gradient.toFixed(3)} °C.` + (w.rms.adiabat > w.rms.isothermal ? ` <b>Here the model loses:</b> the water below the cut is a different, colder mass, which the adiabat cannot know about.` : '')); }
    if (col.flags.includes('model-from-shallow')) notes.push(`<b>Caution:</b> this cast stops at ${fmt.m(col.measuredTo)}, above where deep water is reliably one mass. On real casts the model started this shallow is often too warm, because colder bottom water can lie underneath.`);
    if (col.flags.includes('long-model-gap')) notes.push(`<b>Caution:</b> more than ${fmt.m(MODEL_GAP_WARN_M)} of this column is modelled. Different water may lie below the cast.`);
    if (col.flags.includes('cast-deeper-than-grid')) notes.push(`This cast went deeper than the grid's floor here. The cast is the finer measurement; the grid cell is an average over about 1.8 km.`);
    if (col.flags.includes('outside-fitted-range')) notes.push(`Part of this column lies outside the range the seawater formulas were fitted on (0–40 °C, to 10,000 dbar); values there are a small extrapolation.`);
    if (col.salinity === 'assumed') notes.push(`This cast carries no usable salinity; 34.7 is assumed for sound speed and the adiabat.`); else if (col.salinity === 'partly') notes.push(`Salinity is missing at some levels and is bridged between measured ones.`);
    if (d.cast && d.cast.kmFromPoint > 30) notes.push(`The cast was taken ${Math.round(d.cast.kmFromPoint)} km from this point on ${d.cast.date}.`);
    $('sf-column-note').innerHTML = notes.join(' ');
    const step = Math.max(1, Math.ceil(L.length / 60));
    $('sf-column-table').innerHTML = `<table><thead><tr><th>Depth m</th><th>dbar</th><th>T °C</th><th>θ °C</th><th>Salinity</th><th>Sound m/s</th><th>Kind</th></tr></thead><tbody>`
        + L.filter((l, i) => i % step === 0 || i === L.length - 1).map((l) => `<tr><td>${l.z.toFixed(0)}</td><td>${l.p.toFixed(0)}</td><td>${l.t.toFixed(3)}</td><td>${l.theta.toFixed(3)}</td><td>${l.s.toFixed(3)}${l.sKind === 'measured' ? '' : '*'}</td><td>${l.c.toFixed(1)}</td><td>${l.kind}</td></tr>`).join('') + `</tbody></table>`;
}

// ── compare: floor temperature against depth ─────────────────────────────────
function renderCompare() {
    const host = $('sf-compare-chart'); host.textContent = '';
    const rows = S.rows.filter((r) => r.floorKind);
    $('sf-compare-keys').innerHTML = kindKeys() + '<span><svg width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="#aab6cc" stroke-width="1.5" stroke-dasharray="2 2"/></svg>hollow = modelled bottom temperature</span>';
    if (!rows.length) { host.innerHTML = '<div class="sf-empty">No bottom temperatures to compare.</div>'; $('sf-compare-note').textContent = ''; return; }
    const W = Math.max(320, host.clientWidth || 900), H = 340, m = { l: 46, r: 16, t: 12, b: 34 };
    const cold = rows.filter((r) => r.floorT < 5), lo = Math.floor(Math.min(...rows.map((r) => r.floorT)) - 0.3), hi = Math.ceil(Math.max(...cold.map((r) => r.floorT)) + 0.3);
    const x = (z) => m.l + (z - 4000) / (11500 - 4000) * (W - m.l - m.r), y = (t) => m.t + (hi - Math.min(hi, t)) / (hi - lo) * (H - m.t - m.b);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Bottom temperature against depth for every site' });
    for (const v of ticks(lo, hi, 5)) { svg.appendChild(el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: 'var(--sf-grid)' })); svg.appendChild(el('text', { x: m.l - 6, y: y(v) + 3, 'text-anchor': 'end' }, `${v} °C`)); }
    for (let v = 4000; v <= 11000; v += 1000) svg.appendChild(el('text', { x: x(v), y: H - m.b + 14, 'text-anchor': 'middle' }, `${v / 1000} km`));
    svg.appendChild(el('text', { x: W - m.r, y: H - 4, 'text-anchor': 'end' }, 'depth of the floor'));
    const labelled = new Set(W < 560 ? ['mariana', 'south-sandwich', 'weddell', 'cayman'] : ['mariana', 'tonga', 'puerto-rico', 'south-sandwich', 'weddell', 'banda', 'cayman']);
    const warm = rows.filter((r) => r.floorT >= hi);
    let offN = 0;
    for (const r of rows) {
        const off = r.floorT >= hi, cx = x(Math.max(4000, r.gridDepth)), cy = off ? m.t + 4 + 16 * offN++ : y(r.floorT), st = KIND_STYLE[r.kind];
        const mk = shape(r.kind, cx, cy, 5.5, r.floorKind === 'model' ? { fill: '#0b1120', stroke: st.color, 'stroke-width': 2 } : {});
        const t = el('title', {}, `${r.name}: ${fmt.t(r.floorT)} ${fmt.kind(r.floorKind)} at ${fmt.m(r.gridDepth)}`); mk.appendChild(t);
        mk.style.cursor = 'pointer'; mk.addEventListener('click', () => { select(r.id, { show: true }); $('sf-stage-panel').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
        mk.addEventListener('pointermove', (e) => tip($('sf-chart-tip'), mapTip(r), e)); mk.addEventListener('pointerleave', () => { $('sf-chart-tip').hidden = true; });
        svg.appendChild(mk);
        if (labelled.has(r.id) || off) svg.appendChild(el('text', { x: cx + (cx > W - 120 ? -9 : 9), y: cy + (cx > W - 120 ? -7 : 3), 'text-anchor': cx > W - 120 ? 'end' : 'start', class: 't-strong' }, (r.deep || r.name).replace(' Abyssal Plain', ' plain') + (off ? ` ${r.floorT.toFixed(1)} °C ↑` : '')));
    }
    host.appendChild(svg);
    $('sf-compare-note').innerHTML = `Open-ocean trenches climb to the right: their floors are warmer than the abyssal plains above them, by compression alone. `
        + (warm.length ? `${warm.map((r) => esc(r.name)).join(' and ')} sit${warm.length === 1 ? 's' : ''} off the top of the scale: a shallow sill keeps cold deep water out, so the basin fills with the warmer water at sill depth. ` : '')
        + `Polar sites sit lowest. Filled marks are measured; hollow marks are continued by the model.`;
}

boot();
