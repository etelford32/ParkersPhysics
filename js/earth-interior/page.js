/**
 * page.js — earth-interior.html wiring. DOM + SVG only; every number comes
 * from page-model.js (and through it the kernels) or from the nowcast.
 *
 * Feeds fail independently and SAY so: a dead observatory relay leaves the
 * structure views working and prints "feed down" with the reason — it never
 * draws a quiet planet. The 3D stage is dynamically imported so a WebGL
 * failure degrades to a message and the charts still render.
 */

import {
    QUANTITIES, QUANTITY_KEYS, SERIES, rampColor, radialTable, legendTicks, LAYER_BANDS, probeAt,
    profileSeries, nowcastRows, sparkline, columnSteps, responseCurve, columnOptions, fmt,
    seismicFan, travelTimeCurves, arrivalsAtDistance, fmtMinSec, FAMILY_COLORS, FAMILY_LABELS, SOURCE_DEPTHS_KM,
} from './page-model.js';
import { R_EARTH_KM } from './prem.js';
import { fetchObservatories } from '../geomag/ingest.js';
import { nowcastFromPayload, NOWCAST_WINDOW_MIN, NOWCAST_LABEL } from './geoelectric-nowcast.js';

const $ = (s) => document.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent = null) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { quantity: 'vp', stage: null, payload: null, nowcast: null, selected: null, overrides: {}, probeDepth: null };

// ── The stage ──────────────────────────────────────────────────────────────

function renderLegend() {
    const q = QUANTITIES[state.quantity], t = radialTable(state.quantity);
    const ticks = legendTicks(t).map(({ f, v }) => `<span style="left:${(f * 100).toFixed(1)}%">${fmt(v)}</span>`).join('');
    // The faces map value → rampColor((v − min)/(max − min)) (log for σ), so the
    // bar sampled at the same fractions IS the faces' colour scale.
    const stops = Array.from({ length: 13 }, (_, i) => { const c = rampColor(i / 12); return `rgb(${c.join(',')}) ${(i / 12 * 100).toFixed(1)}%`; });
    $('#ei-legend').innerHTML = `
        <div class="ei-legend-title">${esc(q.label)} <span class="ei-unit">(${esc(q.unit)}${q.log ? ', log scale' : ''})</span></div>
        <div class="ei-legend-bar" style="background:linear-gradient(90deg,${stops.join(',')})"></div>
        <div class="ei-legend-ticks">${ticks}</div>
        <div class="ei-legend-src">${esc(q.source)}${state.quantity === 'sigma' ? ' · the core value is the model’s 10⁵ S/m half-space' : ''}${state.quantity === 'vs' ? ' · Vs = 0 in the liquid outer core' : ''}</div>`;
    state.stage?.setRadialTable(t);
}

function renderQuantityChips() {
    $('#ei-qchips').innerHTML = QUANTITY_KEYS.map((k) =>
        `<button type="button" class="ei-chip" data-q="${k}" aria-pressed="${k === state.quantity}" title="${esc(QUANTITIES[k].label)}">${esc(QUANTITIES[k].short)}</button>`).join('');
    $('#ei-qchips').onclick = (e) => {
        const b = e.target.closest('[data-q]'); if (!b) return;
        state.quantity = b.dataset.q; renderQuantityChips(); renderLegend();
    };
}

function renderProbe(hit) {
    const box = $('#ei-probe');
    if (!hit) { box.innerHTML = `<span class="ei-muted">${$('#ei-stage')?.classList.contains('is-quakes') ? 'Hover the slice for the structure at any depth · click a dot to show that earthquake' : 'Hover the cut faces for the column at any depth · click a station'}</span>`; setProbeDepth(null); return; }
    if (hit.kind === 'interior') {
        const p = probeAt(hit.rKm);
        setProbeDepth(p.depthKm);
        box.innerHTML = `<b>${fmt(p.depthKm, 4)} km deep</b> · ${esc(p.band)}${p.state === 'fluid' ? ' (liquid)' : ''}
            <span>Vp ${fmt(p.vpKmS)} · Vs ${fmt(p.vsKmS)} km/s</span>
            <span>ρ ${fmt(p.rhoGcc)} g/cm³ · g ${fmt(p.gMS2)} m/s² · p ${fmt(p.pGPa)} GPa</span>
            <span>σ ${fmt(p.sigmaSm)} S/m</span>`;
    } else if (hit.kind === 'surface') {
        setProbeDepth(null);
        box.innerHTML = `<b>${fmt(hit.lat, 3)}°, ${fmt(hit.lon, 4)}°</b> <span class="ei-muted">surface — PREM has no lateral structure; the column below any point is the same until CRUST1.0 / tomography land</span>`;
    } else if (hit.kind === 'station') {
        const r = nowcastRows(state.nowcast).find((x) => x.code === hit.code);
        box.innerHTML = r ? `<b>${esc(r.code)}</b> ${esc(r.name)} · |E| ${fmt(r.eLatestVkm * 1000)} mV/km` : esc(hit.code);
    }
}

function setProbeDepth(d) {
    state.probeDepth = d;
    state.stage?.setProbeRadius(d === null ? null : R_EARTH_KM - d);
    drawProfileCrosshair();
}

// ── Radial profile: small multiples on ONE depth axis ─────────────────────

const PANELS = [
    { keys: ['vp', 'vs'], title: 'Seismic speed', unit: 'km/s' },
    { keys: ['rho'], title: 'Density', unit: 'g/cm³' },
    { keys: ['g'], title: 'Gravity', unit: 'm/s²' },
    { keys: ['p'], title: 'Pressure', unit: 'GPa' },
    { keys: ['sigma'], title: 'Conductivity', unit: 'S/m', log: true },
];

function renderProfile() {
    const host = $('#ei-profile'); host.innerHTML = '';
    // Five multiples share the panel's width (min 140 px each, then it scrolls).
    const W = Math.max(140, Math.floor(((host.clientWidth || 800) - 60) / PANELS.length) - 2), H = 380, top = 28, bot = 26, left = 6, right = 10;
    const ys = (d) => top + (d / R_EARTH_KM) * (H - top - bot);
    // Shared depth axis.
    const axis = el('svg', { viewBox: `0 0 52 ${H}`, class: 'ei-axis', width: 52, height: H }, host);
    for (const d of [0, 1000, 2000, 2891, 4000, 5150, 6371]) {
        el('line', { x1: 46, x2: 52, y1: ys(d), y2: ys(d), class: 'ei-tick' }, axis);
        const t = el('text', { x: 43, y: ys(d) + 4, 'text-anchor': 'end', class: 'ei-ticklab' }, axis); t.textContent = d.toLocaleString('en-US');
    }
    const lab = el('text', { x: 12, y: H / 2, transform: `rotate(-90 12 ${H / 2})`, 'text-anchor': 'middle', class: 'ei-axlab' }, axis); lab.textContent = 'Depth (km)';
    state.profileGeom = { ys, H, svgs: [] };
    for (const panel of PANELS) {
        const pts = profileSeries(panel.keys, 10);
        const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: 'ei-mult' }, host);
        let lo = Infinity, hi = -Infinity;
        for (const p of pts) for (const k of panel.keys) {
            const v = panel.log ? Math.log10(p.values[k]) : p.values[k];
            if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
        }
        if (!panel.log) lo = Math.min(lo, 0);
        const xs = (v) => left + ((panel.log ? Math.log10(v) : v) - lo) / (hi - lo || 1) * (W - left - right);
        // Layer bands: alternate a faint fill so the shared depth axis reads.
        LAYER_BANDS.forEach((b, i) => {
            if (i % 2) el('rect', { x: 0, width: W, y: ys(b.topDepthKm), height: Math.max(0.5, ys(b.bottomDepthKm) - ys(b.topDepthKm)), class: 'ei-band' }, svg);
        });
        const tt = el('text', { x: left, y: 14, class: 'ei-ptitle' }, svg); tt.textContent = panel.title;
        const tu = el('text', { x: left, y: 25, class: 'ei-punit' }, svg); tu.textContent = `${panel.unit}${panel.log ? ' · log' : ''}`;
        // x ticks at min / max
        for (const v of panel.log ? [10 ** lo, 10 ** hi] : [lo, hi]) {
            const t = el('text', { x: xs(v), y: H - 8, 'text-anchor': v === (panel.log ? 10 ** lo : lo) ? 'start' : 'end', class: 'ei-ticklab' }, svg);
            t.textContent = fmt(v, 2);
        }
        panel.keys.forEach((k, si) => {
            const d = pts.map((p, i) => `${i ? 'L' : 'M'}${xs(p.values[k]).toFixed(1)},${ys(p.depthKm).toFixed(1)}`).join('');
            el('path', { d, class: 'ei-line', stroke: si ? SERIES.two : SERIES.one }, svg);
        });
        if (panel.keys.length > 1) {   // direct labels (2 series) — identity never colour alone
            const at = pts.find((p) => p.depthKm >= 1500);
            panel.keys.forEach((k, si) => {
                const t = el('text', { x: xs(at.values[k]) + (si ? -4 : 4), y: ys(1500) - 6, 'text-anchor': si ? 'end' : 'start', class: 'ei-dlab' }, svg);
                t.textContent = QUANTITIES[k].short;
            });
        }
        const cross = el('line', { x1: 0, x2: W, y1: -10, y2: -10, class: 'ei-cross' }, svg);
        const readout = el('text', { x: W - right, y: -10, 'text-anchor': 'end', class: 'ei-xread' }, svg);
        state.profileGeom.svgs.push({ svg, cross, readout, panel, xs });
        svg.addEventListener('pointermove', (e) => {
            const r = svg.getBoundingClientRect();
            const y = (e.clientY - r.top) / r.height * H;
            const d = Math.min(R_EARTH_KM, Math.max(0, (y - top) / (H - top - bot) * R_EARTH_KM));
            setProbeDepth(d);
            renderProbe({ kind: 'interior', rKm: R_EARTH_KM - d });
        });
        svg.addEventListener('pointerleave', () => renderProbe(null));
    }
    drawProfileCrosshair();
}

function drawProfileCrosshair() {
    const g = state.profileGeom; if (!g) return;
    for (const s of g.svgs) {
        if (state.probeDepth === null) { s.cross.setAttribute('y1', -10); s.cross.setAttribute('y2', -10); s.readout.textContent = ''; continue; }
        const y = g.ys(state.probeDepth);
        s.cross.setAttribute('y1', y); s.cross.setAttribute('y2', y);
        const p = probeAt(R_EARTH_KM - state.probeDepth);
        const vals = s.panel.keys.map((k) => fmt(k === 'vp' ? p.vpKmS : k === 'vs' ? p.vsKmS : k === 'rho' ? p.rhoGcc : k === 'g' ? p.gMS2 : k === 'p' ? p.pGPa : p.sigmaSm));
        s.readout.setAttribute('y', Math.max(40, y - 4)); s.readout.textContent = vals.join(' / ');
    }
}

// ── Live geoelectric nowcast ───────────────────────────────────────────────

function setFeedChip(kind, text) {
    const c = $('#ei-feed');
    c.className = `ei-status ei-status--${kind}`;
    c.innerHTML = `<span aria-hidden="true">${kind === 'ok' ? '●' : kind === 'warn' ? '▲' : '■'}</span> ${esc(text)}`;
}

async function refreshNowcast() {
    try {
        const payload = await fetchObservatories({ minutes: NOWCAST_WINDOW_MIN });
        state.payload = payload;
        recomputeNowcast();
        const n = state.nowcast.stations.length;
        setFeedChip(n ? 'ok' : 'warn', n ? `Live · USGS · ${n} observatories · updated ${new Date(payload.data.updated).toUTCString().slice(17, 22)} UTC` : 'Live feed returned no usable stations');
    } catch (err) {
        state.payload = null; state.nowcast = null;
        setFeedChip('down', `Observatory feed down — ${err.message}. Structure views are unaffected.`);
        renderNowcast(); renderColumn();
        state.stage?.setStations([]);
    }
}

function recomputeNowcast() {
    if (!state.payload) return;
    state.nowcast = nowcastFromPayload(state.payload, { columns: state.overrides });
    const rows = nowcastRows(state.nowcast);
    if (!state.selected || !rows.some((r) => r.code === state.selected)) state.selected = rows[0]?.code ?? null;
    renderNowcast(); renderColumn();
    const max = Math.max(1e-12, ...rows.map((r) => r.eLatestVkm ?? 0));
    state.stage?.setStations(rows.map((r) => ({ code: r.code, lat: r.lat, lon: r.lon, emphasis: (r.eLatestVkm ?? 0) / max })), state.selected);
}

function sparkSvg(values) {
    const { max, points } = sparkline(values);
    const W = 120, H = 26;
    let d = '', pen = false;
    for (const p of points) {
        if (!p) { pen = false; continue; }
        d += `${pen ? 'L' : 'M'}${(p[0] * W).toFixed(1)},${(H - 2 - p[1] * (H - 4)).toFixed(1)}`; pen = true;
    }
    return `<svg class="ei-spark" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-label="|E| over the last 12 h, peak ${fmt(max * 1000)} mV/km"><path d="${d}"/></svg>`;
}

function renderNowcast() {
    const body = $('#ei-nowcast-body');
    const rows = nowcastRows(state.nowcast);
    if (!rows.length) { body.innerHTML = `<tr><td colspan="6" class="ei-muted">No observatory data${state.nowcast ? '' : ' — the feed is down'}.</td></tr>`; return; }
    body.innerHTML = rows.map((r) => `
        <tr data-code="${esc(r.code)}" class="${r.code === state.selected ? 'is-sel' : ''}" tabindex="0">
            <td><b>${esc(r.code)}</b><span class="ei-sub">${esc(r.name)} · ${fmt(r.geomagLatDeg, 2)}° mag</span></td>
            <td class="ei-num">${fmt(r.eLatestVkm * 1000)}${r.warmup ? ' <span class="ei-flag" title="Inside the warm-up: missing history">warm-up</span>' : ''}${r.bridged ? ' <span class="ei-flag" title="A short gap was bridged">bridged</span>' : ''}</td>
            <td class="ei-num">${fmt(r.peakVkm === null ? null : r.peakVkm * 1000)}</td>
            <td>${sparkSvg(r.spark)}</td>
            <td><span class="${r.columnBasis === 'global-default' ? 'ei-flagged' : ''}">${esc(r.columnId)}</span><span class="ei-sub">${r.columnBasis === 'global-default' ? 'global default — no local column' : r.columnBasis === 'explicit' ? 'chosen' : 'observatory model'}</span></td>
            <td class="ei-num">${r.benchmarkVkm === null ? '<span class="ei-muted" title="NERC publishes no β for this column">—</span>' : `${fmt(r.overBenchmark * 100, 2)}%<span class="ei-sub">of ${fmt(r.benchmarkVkm, 2)} V/km</span>`}</td>
        </tr>`).join('');
    body.onclick = (e) => { const tr = e.target.closest('tr[data-code]'); if (tr) selectStation(tr.dataset.code); };
    body.onkeydown = (e) => { const tr = e.target.closest('tr[data-code]'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectStation(tr.dataset.code); } };
}

function selectStation(code) {
    state.selected = code;
    recomputeNowcast();
}

// ── Ground column panel ────────────────────────────────────────────────────

function renderColumn() {
    const host = $('#ei-column');
    const st = state.nowcast?.stations.find((s) => s.code === state.selected) ?? null;
    const colId = st?.column.id ?? state.colFallback ?? 'QUE';
    const opts = columnOptions();
    const groups = [['global', 'Global average'], ['usgs', 'USGS physiographic regions'], ['bou', 'USGS observatory'], ['nrcan', 'NRCan observatories'], ['nerc', 'NERC reference']];
    const select = `<select id="ei-colsel" aria-label="Ground column">${groups.map(([k, label]) =>
        `<optgroup label="${label}">${opts.filter((o) => o.kind === k).map((o) => `<option value="${o.id}" ${o.id === colId ? 'selected' : ''}>${esc(o.id)} — ${esc(o.name.slice(0, 60))}${o.beta !== null ? ` (β ${o.beta})` : ''}</option>`).join('')}</optgroup>`).join('')}</select>`;
    host.innerHTML = `
        <div class="ei-colhead">
            <div><b>${st ? esc(st.code) : 'No station'}</b> <span class="ei-muted">${st ? esc(st.name) : 'feed down — pick a column to explore it'}</span></div>
            <label class="ei-colpick">Ground column ${select}</label>
        </div>
        <div class="ei-colinfo ei-muted">${esc(st?.column.source ?? '')}${st?.column.note ? ` · <b>${esc(st.column.note)}</b>` : ''}</div>
        <div class="ei-colcharts"><div id="ei-steps"></div><div id="ei-resp"></div></div>`;
    $('#ei-colsel').onchange = (e) => {
        if (st) { state.overrides[st.code] = e.target.value; recomputeNowcast(); }
        else { state.colFallback = e.target.value; renderColumn(); }
    };
    drawSteps(colId); drawResponse(colId);
}

function logScale(lo, hi, a, b) { const l0 = Math.log10(lo), l1 = Math.log10(hi); return (v) => a + (Math.log10(v) - l0) / (l1 - l0) * (b - a); }

function drawSteps(id) {
    const steps = columnSteps(id, 700);
    const W = 300, H = 230, L = 44, R = 10, T = 22, B = 30;
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ei-chart', width: '100%' });
    const xs = logScale(1e-5, 10, L, W - R), ys = (d) => T + d / 700 * (H - T - B);
    const tt = el('text', { x: L, y: 14, class: 'ei-ptitle' }, svg); tt.textContent = 'Conductivity σ (S/m, log) vs depth';
    for (const v of [1e-5, 1e-3, 1e-1, 10]) {
        el('line', { x1: xs(v), x2: xs(v), y1: T, y2: H - B, class: 'ei-gridline' }, svg);
        const t = el('text', { x: xs(v), y: H - B + 13, 'text-anchor': 'middle', class: 'ei-ticklab' }, svg); t.textContent = fmt(v, 1);
    }
    for (const d of [0, 200, 400, 600]) { const t = el('text', { x: L - 5, y: ys(d) + 4, 'text-anchor': 'end', class: 'ei-ticklab' }, svg); t.textContent = d; }
    const lab = el('text', { x: L - 5, y: H - 4, 'text-anchor': 'end', class: 'ei-ticklab' }, svg); lab.textContent = 'km';
    let d = '';
    steps.forEach((s, i) => {
        const x = xs(Math.min(10, Math.max(1e-5, s.sigma)));
        d += `${i ? 'L' : 'M'}${x.toFixed(1)},${ys(s.topKm).toFixed(1)}L${x.toFixed(1)},${ys(Math.min(700, s.bottomKm)).toFixed(1)}`;
    });
    el('path', { d, class: 'ei-line', stroke: SERIES.one }, svg);
    $('#ei-steps').replaceChildren(svg);
}

function drawResponse(id) {
    const a = responseCurve(id), ref = responseCurve('QUE');
    const W = 300, H = 230, L = 44, R = 12, T = 22, B = 30;
    const all = [...a, ...ref].map((p) => p.eVkm);
    const ylo = Math.min(...all) * 0.8, yhi = Math.max(...all) * 1.25;
    const xs = logScale(10, 86400, L, W - R), ys = logScale(ylo, yhi, H - B, T);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'ei-chart', width: '100%' });
    const tt = el('text', { x: L, y: 14, class: 'ei-ptitle' }, svg); tt.textContent = '|E| per 100 nT vs period (V/km, log)';
    for (const [v, lab] of [[10, '10 s'], [60, '1 min'], [600, '10 min'], [3600, '1 h'], [86400, '1 d']]) {
        el('line', { x1: xs(v), x2: xs(v), y1: T, y2: H - B, class: 'ei-gridline' }, svg);
        const t = el('text', { x: xs(v), y: H - B + 13, 'text-anchor': 'middle', class: 'ei-ticklab' }, svg); t.textContent = lab;
    }
    for (const v of [0.01, 0.1, 1, 10]) if (v > ylo && v < yhi) { const t = el('text', { x: L - 5, y: ys(v) + 4, 'text-anchor': 'end', class: 'ei-ticklab' }, svg); t.textContent = fmt(v, 1); }
    const path = (pts, col) => el('path', { d: pts.map((p, i) => `${i ? 'L' : 'M'}${xs(p.periodS).toFixed(1)},${ys(p.eVkm).toFixed(1)}`).join(''), class: 'ei-line', stroke: col }, svg);
    const series = id === 'QUE' ? [[a, SERIES.one, 'QUE (NERC reference)']] : [[a, SERIES.one, id], [ref, SERIES.two, 'QUE (NERC reference)']];
    series.forEach(([pts, col, name], i) => {
        path(pts, col);
        const p = pts[Math.round(pts.length * (i ? 0.28 : 0.62))];
        const t = el('text', { x: xs(p.periodS), y: ys(p.eVkm) + (i ? 14 : -7), 'text-anchor': 'middle', class: 'ei-dlab' }, svg); t.textContent = name;
    });
    $('#ei-resp').replaceChildren(svg);
    $('#ei-resp-legend').innerHTML = series.map(([, col, name]) => `<span><i style="background:${col}"></i>${esc(name)}</span>`).join('');
}

// ── Seismic rays ───────────────────────────────────────────────────────────

const seis = { wave: 'P', depth: 0, deltaDeg: null };

function renderSeismic() {
    const chips = (host, items, cur, set) => {
        host.innerHTML = items.map(([v, lab]) => `<button type="button" class="ei-chip" data-v="${v}" aria-pressed="${String(v) === String(cur)}">${lab}</button>`).join('');
        host.onclick = (e) => { const b = e.target.closest('button[data-v]'); if (b) set(b.dataset.v); };
    };
    chips($('#ei-seis-wave'), [['P', 'P waves'], ['S', 'S waves']], seis.wave, (v) => { seis.wave = v; renderSeismic(); });
    chips($('#ei-seis-depth'), SOURCE_DEPTHS_KM.map((d) => [d, d === 0 ? 'Surface source' : `${d} km deep`]), seis.depth, (v) => { seis.depth = Number(v); renderSeismic(); });
    const fan = seismicFan({ wave: seis.wave, sourceDepthKm: seis.depth });
    const tt = travelTimeCurves({ wave: seis.wave, sourceDepthKm: seis.depth });
    drawFan(fan, tt); drawTT(tt); renderArrivals(tt);
    const fams = [...new Set(tt.curves.map((c) => c.family))];
    $('#ei-seis-legend').innerHTML = fams.map((f) => `<span><i style="background:${FAMILY_COLORS[f]}"></i>${esc(FAMILY_LABELS[f])}</span>`).join('')
        + `<span><i style="background:#c3c2b7;opacity:.7"></i>${seis.wave === 'P' ? 'P shadow zone (no direct P)' : 'S shadow (no S crosses the liquid core)'}</span>`;
}

function setSeisDelta(d) {
    seis.deltaDeg = d === null ? null : Math.max(0, Math.min(180, d));
    const tt = travelTimeCurves({ wave: seis.wave, sourceDepthKm: seis.depth });
    highlightFan(); moveTTCross(tt); renderArrivals(tt);
}

const FAN = { W: 440, cx: 220, cy: 220, R: 196 };
function drawFan(fan, tt) {
    const { W, cx, cy, R } = FAN, k = R / R_EARTH_KM;
    const P = ([x, y]) => `${(cx + x * k).toFixed(1)},${(cy - y * k).toFixed(1)}`;
    const svg = el('svg', { viewBox: `0 0 ${W} ${W}`, role: 'img', 'aria-label': `Ray fan of ${fan.wave} waves from a ${fan.sourceDepthKm} km deep source through PREM` });
    // Layers: neutral tints (not data colours), from the PREM boundaries.
    const fills = [[R_EARTH_KM, '#18233a'], [3480, '#231d1a'], [1221.5, '#1d2a26']];
    for (const [r, f] of fills) el('circle', { cx, cy, r: r * k, fill: f }, svg);
    for (const r of [R_EARTH_KM - 670, 3480, 1221.5]) el('circle', { cx, cy, r: r * k, fill: 'none', stroke: '#33435f', 'stroke-width': r === R_EARTH_KM - 670 ? 0.8 : 1.2, 'stroke-dasharray': r === R_EARTH_KM - 670 ? '3 3' : null }, svg);
    el('circle', { cx, cy, r: R, fill: 'none', stroke: '#5b6b88', 'stroke-width': 1.2 }, svg);
    const lab = (txt, r, ang) => { const t = el('text', { x: cx - Math.sin(ang) * r * k, y: cy - Math.cos(ang) * r * k, 'text-anchor': 'middle', class: 'ei-layerlab' }, svg); t.textContent = txt; };
    lab('mantle', 5000, 0.9); lab('outer core (liquid)', 2400, 0.62); lab('inner core', 450, 0);
    // The shadow, as an arc on the surface at the distances no direct phase reaches.
    if (tt.shadow) {
        const [a, b] = tt.shadow.map((d) => d * Math.PI / 180), rr = R + 7;
        el('path', { d: `M${cx + rr * Math.sin(a)},${cy - rr * Math.cos(a)} A${rr},${rr} 0 0 1 ${cx + rr * Math.sin(b)},${cy - rr * Math.cos(b)}`, class: 'ei-shadow-arc' }, svg);
    }
    const g = el('g', { id: 'ei-fan-rays' }, svg);
    for (const ray of fan.rays) {
        const path = el('path', { d: `M${ray.points.map(P).join('L')}`, class: `ei-ray${ray.stopped ? ' is-stop' : ''}`, stroke: FAMILY_COLORS[ray.family] }, g);
        path.dataset.delta = ray.deltaDeg ?? '';
    }
    // Distance ticks every 30° on the right half.
    for (let d = 0; d <= 180; d += 30) {
        const a = d * Math.PI / 180;
        el('line', { x1: cx + R * Math.sin(a), y1: cy - R * Math.cos(a), x2: cx + (R + 4) * Math.sin(a), y2: cy - (R + 4) * Math.cos(a), stroke: '#8a91a1' }, svg);
        if (d > 0 && d < 180) { const t = el('text', { x: cx + (R + 16) * Math.sin(a), y: cy - (R + 16) * Math.cos(a) + 3, 'text-anchor': 'middle', class: 'ei-ticklab' }, svg); t.textContent = `${d}°`; }
    }
    const src = fan.sourceDepthKm;
    el('circle', { cx, cy: cy - (R_EARTH_KM - src) * k, r: 4.5, fill: '#fff', stroke: '#05080f', 'stroke-width': 1.5 }, svg);
    el('g', { id: 'ei-fan-mark' }, svg);
    // Hover on the right half picks the distance by angle.
    svg.addEventListener('pointermove', (e) => {
        const b = svg.getBoundingClientRect(), x = (e.clientX - b.left) / b.width * W - cx, y = cy - (e.clientY - b.top) / b.height * W;
        if (x < 0 || Math.hypot(x, y) < R * 0.55) return;
        setSeisDelta(Math.atan2(x, y) * 180 / Math.PI);
    });
    $('#ei-fan').replaceChildren(svg);
    highlightFan();
}

function highlightFan() {
    const g = $('#ei-fan-rays'), mark = $('#ei-fan-mark');
    if (!g) return;
    const d = seis.deltaDeg;
    // The rays nearest the chosen distance, per family, are lit; the rest dim.
    const near = new Set();
    if (d !== null) {
        const best = {};
        for (const p of g.children) {
            const v = parseFloat(p.dataset.delta); if (!Number.isFinite(v)) continue;
            const f = p.getAttribute('stroke'), e = Math.abs(v - d);
            if (e < 6 && (!best[f] || e < best[f].e)) best[f] = { e, p };
        }
        Object.values(best).forEach((b) => near.add(b.p));
    }
    for (const p of g.children) p.setAttribute('class', `ei-ray${p.classList.contains('is-stop') ? ' is-stop' : ''}${d === null ? '' : near.has(p) ? ' is-hot' : ' is-dim'}`);
    mark.replaceChildren();
    if (d !== null) {
        const { cx, cy, R } = FAN, a = d * Math.PI / 180;
        el('path', { d: `M${cx + R * Math.sin(a)},${cy - R * Math.cos(a)} l-5,-9 l10,0 z`, fill: '#fff', transform: `rotate(${d} ${cx + R * Math.sin(a)} ${cy - R * Math.cos(a)})` }, mark);
    }
}

const TT = { W: 520, H: 360, L: 48, R: 14, T: 24, B: 34 };
function drawTT(tt) {
    const { W, H, L, R, T, B } = TT;
    const tMax = Math.ceil(tt.maxTimeS / 60 / 5) * 5;
    const xs = (d) => L + d / 180 * (W - L - R), ys = (s) => H - B - s / 60 / tMax * (H - T - B);
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${tt.wave}-wave travel time against distance` });
    const tt0 = el('text', { x: L, y: 14, class: 'ei-ptitle' }, svg); tt0.textContent = 'Travel time (min) vs distance from the source';
    if (tt.shadow) el('rect', { x: xs(tt.shadow[0]), y: T, width: xs(tt.shadow[1]) - xs(tt.shadow[0]), height: H - T - B, class: 'ei-shadow-band' }, svg);
    for (let d = 0; d <= 180; d += 30) {
        el('line', { x1: xs(d), x2: xs(d), y1: T, y2: H - B, class: 'ei-gridline' }, svg);
        const t = el('text', { x: xs(d), y: H - B + 14, 'text-anchor': 'middle', class: 'ei-ticklab' }, svg); t.textContent = `${d}°`;
    }
    for (let m = 0; m <= tMax; m += 5) {
        el('line', { x1: L, x2: W - R, y1: ys(m * 60), y2: ys(m * 60), class: 'ei-gridline' }, svg);
        const t = el('text', { x: L - 6, y: ys(m * 60) + 3, 'text-anchor': 'end', class: 'ei-ticklab' }, svg); t.textContent = m;
    }
    const ax = el('text', { x: W - R, y: H - 4, 'text-anchor': 'end', class: 'ei-axlab' }, svg); ax.textContent = 'distance Δ (degrees of arc)';
    if (tt.shadow) { const st = el('text', { x: (xs(tt.shadow[0]) + xs(tt.shadow[1])) / 2, y: T + 14, 'text-anchor': 'middle', class: 'ei-ticklab' }, svg); st.textContent = 'shadow'; }
    for (const c of tt.curves) {
        el('path', { d: `M${c.points.map(([d, s]) => `${xs(d).toFixed(1)},${ys(s).toFixed(1)}`).join('L')}`, class: 'ei-line', stroke: FAMILY_COLORS[c.family] }, svg);
        // Direct label at the curve's far end (by distance), nudged inside the plot.
        const end = c.points.reduce((a, q) => (q[0] > a[0] ? q : a));
        const t = el('text', { x: Math.min(xs(end[0]) - 4, W - R - 4), y: ys(end[1]) - 6, 'text-anchor': 'end', class: 'ei-dlab' }, svg);
        t.textContent = c.phase;
    }
    el('g', { id: 'ei-tt-cross' }, svg);
    const pick = (e) => { const b = svg.getBoundingClientRect(); setSeisDelta(((e.clientX - b.left) / b.width * W - L) / (W - L - R) * 180); };
    svg.addEventListener('pointermove', pick); svg.addEventListener('pointerdown', pick);
    $('#ei-tt').replaceChildren(svg);
    moveTTCross(tt);
}

function moveTTCross(tt) {
    const g = $('#ei-tt-cross'); if (!g) return;
    g.replaceChildren();
    const d = seis.deltaDeg; if (d === null) return;
    const { W, H, L, R, T, B } = TT, tMax = Math.ceil(tt.maxTimeS / 60 / 5) * 5;
    const xs = (v) => L + v / 180 * (W - L - R), ys = (s) => H - B - s / 60 / tMax * (H - T - B);
    el('line', { x1: xs(d), x2: xs(d), y1: T, y2: H - B, class: 'ei-cross' }, g);
    for (const a of arrivalsAtDistance(d, tt)) el('circle', { cx: xs(d), cy: ys(a.timeS), r: 3.5, fill: FAMILY_COLORS[a.family], stroke: '#0b1322', 'stroke-width': 1.5 }, g);
}

function renderArrivals(tt) {
    const host = $('#ei-arrivals'), d = seis.deltaDeg;
    if (d === null) { host.innerHTML = '<span class="ei-muted">Hover the chart or the cross-section to read the arrivals at a distance.</span>'; return; }
    const arr = arrivalsAtDistance(d, tt);
    const km = d * Math.PI / 180 * R_EARTH_KM;
    const head = `<b>${fmt(d, 3)}°</b> <span class="ei-muted">(${fmt(km, 3)} km along the surface)</span>`;
    if (!arr.length) { host.innerHTML = `${head}<br><span class="ei-muted">No ${tt.wave === 'P' ? 'direct or core' : 'S'} phase arrives here in ray theory${tt.shadow && d >= tt.shadow[0] && d <= tt.shadow[1] ? ' — this is the shadow zone' : ''}.</span>`; return; }
    host.innerHTML = `${head}<table>${arr.map((a) => `<tr><td><i style="background:${FAMILY_COLORS[a.family]}"></i><b>${esc(a.phase)}</b></td><td class="ei-num">${fmtMinSec(a.timeS)}</td><td class="ei-muted">${fmt(a.p * Math.PI / 180, 3)} s/°</td></tr>`).join('')}</table>`;
}

// ── Boot ──────────────────────────────────────────────────────────────────

async function boot() {
    renderQuantityChips();
    renderLegend();
    renderProfile();
    renderProbe(null);
    renderNowcast();
    renderColumn();
    renderSeismic();
    $('#ei-label').textContent = NOWCAST_LABEL;
    try {
        const { InteriorStage } = await import('./stage.js');
        state.stage = new InteriorStage($('#ei-canvas'), {
            labelLayer: $('#ei-labels'),
            onHover: (hit) => renderProbe(hit),
            onPick: (hit) => { if (hit.kind === 'station') selectStation(hit.code); },
        });
        renderLegend();
        state.stage.loadMap('assets/earth/day-2k.webp').catch(() => { $('#ei-mapnote').textContent = 'Surface map unavailable — plain ocean colour.'; });
    } catch (err) {
        $('#ei-stage').classList.add('is-failed');
        $('#ei-stage-msg').textContent = `3D view unavailable (${err.message}). The charts below still work.`;
    }
    // The LIVE earthquake view is the stage's default mode; its panels work without WebGL too.
    const { mountLiveQuakes } = await import('./live-quakes.js');
    state.live = mountLiveQuakes({ stage: state.stage });
    const setMode = (view) => {
        document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
        $('#ei-stage').classList.toggle('is-quakes', view === 'quakes');
        state.live.setActive(view === 'quakes');
        if (view !== 'quakes') state.stage?.setView(view);
    };
    document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.view)));
    setMode('quakes');
    window.__earthInterior = { state, stage: state.stage, live: state.live };
    let rt = null;
    new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(renderProfile, 150); }).observe($('#ei-profile'));
    await refreshNowcast();
    setInterval(refreshNowcast, 60_000);
}

boot();
