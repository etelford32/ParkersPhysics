/**
 * js/bz-page.js — bz.html's renderer.
 *
 * BZ_ENGINE_PLAN.md phase B6. It DRAWS ONLY what js/bz/page-model.js returns:
 * no number on the page is computed here. The column arrives through the ONE
 * shared provider (js/bz-engine-provider.js); the three traces the charts
 * need (/api/bz/l1, /flux, /geo) are fetched here once a minute while the tab
 * is visible.
 *
 * Rules this file keeps:
 *   • Feeds down must LOOK down: a failed fetch turns the status line amber
 *     and names what failed; the last good picture stays, labelled stale.
 *   • The ladder is rebuilt per update but every <details> keeps its open
 *     state by rung id (a re-render must not snap a caveat list shut under
 *     the reader's cursor).
 *   • The three charts share ONE time axis and one crosshair. Each has its
 *     own y axis because each is a different quantity — small multiples,
 *     never two scales on one plot.
 *   • Text is set with textContent / escaped; nothing from a feed is HTML.
 */
import { startBzProvider, BZ_COLUMN_EVENT } from './bz-engine-provider.js';
import { KINDS, VERDICTS, SERIES_COLORS, INK, UNVERIFIED_NAMES, ladderRows, scorecard, chartDomain, traceSeries, fluxSeries, yExtent, ticks, linePath, nearest, num } from './bz/page-model.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { column: null, columnState: null, l1: null, flux: null, geo: null, ground: null, errors: {}, charts: [], dom: null };

// ── status line ───────────────────────────────────────────────────────────
function renderStatus() {
    const el = $('bz-status');
    const st = S.columnState;
    const failed = Object.keys(S.errors).filter((k) => S.errors[k]);
    let level = 'ok', text = 'Live';
    if (!st) { level = 'wait'; text = 'Loading the column…'; }
    else if (!st.ok) { level = 'down'; text = st.column ? 'Engine unreachable — showing the last good column' : 'Engine unreachable'; }
    else if (st.freshness === 'expired') { level = 'down'; text = 'Both measured ends are down'; }
    else if (st.freshness === 'stale') { level = 'warn'; text = `Degraded — ${(st.reasons ?? []).map((r) => r.replace(/_/g, ' ')).join('; ') || 'a feed is behind'}`; }
    if (failed.length && level === 'ok') { level = 'warn'; text = `Chart data unavailable: ${failed.join(', ')}`; }
    el.dataset.level = level;
    el.querySelector('.bz-status-text').textContent = text;
    const t = S.column?.updated ? new Date(S.column.updated) : null;
    $('bz-updated').textContent = t ? `newest L1 minute ${t.toISOString().slice(11, 16)} UT` : '';
}

// ── the ladder ────────────────────────────────────────────────────────────
function renderLadder() {
    const host = $('bz-ladder');
    if (!S.column) return;
    const open = new Set([...host.querySelectorAll('details[open]')].map((d) => d.dataset.rung));
    const rows = ladderRows(S.column, Date.now());
    host.innerHTML = rows.map((r) => `
        <li class="bz-rung" data-rung="${esc(r.id)}" data-kind="${esc(r.kind)}">
            <div class="bz-rung-where"><span class="bz-rung-label">${esc(r.label)}</span><span class="bz-rung-alt">${esc(r.where)}</span></div>
            <div class="bz-rung-kind" title="${esc(KINDS[r.kind]?.note ?? '')}"><span class="bz-mark" data-kind="${esc(r.kind)}" aria-hidden="true"></span>${esc(r.kindLabel)}</div>
            <div class="bz-rung-value">
                <div class="bz-headline">${esc(r.headline)}${r.time ? `<span class="bz-when">${esc(r.time)}</span>` : ''}</div>
                ${r.sub ? `<div class="bz-sub">${esc(r.sub)}</div>` : ''}
                ${r.forecast ? `<div class="bz-fc"><span class="bz-mark" data-kind="FORECAST" aria-hidden="true"></span>Forecast: ${esc(r.forecast)}</div>` : ''}
                <details data-rung="${esc(r.id)}"${open.has(r.id) ? ' open' : ''}>
                    <summary>Where this comes from</summary>
                    <p>${esc(r.basis)}${r.href ? ` <a href="${esc(r.href)}">Open it →</a>` : ''}</p>
                    ${r.caveats.length ? `<ul>${r.caveats.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
                </details>
            </div>
        </li>`).join('');
    const un = S.column.unverified ?? [];
    $('bz-unverified').hidden = !un.length;
    $('bz-unverified-list').textContent = un.map((u) => UNVERIFIED_NAMES[u] ?? u.replace(/_/g, ' ')).join('; ');
}

// ── the scorecard ─────────────────────────────────────────────────────────
function renderScore() {
    const sc = scorecard({ l1: S.l1, geo: S.geo, ground: S.ground?.ground, ring: S.ground?.ring_current });
    const body = $('bz-score-body');
    if (!sc.rows.length) { body.innerHTML = '<tr><td colspan="5" class="bz-empty">No scores yet.</td></tr>'; return; }
    body.innerHTML = sc.rows.map((r) => `
        <tr data-verdict="${r.verdict}">
            <th scope="row">${esc(r.claim)}${r.note ? `<span class="bz-note">${esc(r.note)}</span>` : ''}</th>
            <td class="bz-n">${r.ours == null ? '—' : `${num(r.ours, r.unit.startsWith('s') ? 0 : 2)} ${esc(r.unit)}`}</td>
            <td class="bz-n">${r.control == null ? '—' : num(r.control, 2)}<span class="bz-note">${esc(r.controlName)}</span></td>
            <td><span class="bz-verdict"><span class="bz-glyph" aria-hidden="true">${VERDICTS[r.verdict].glyph}</span>${esc(VERDICTS[r.verdict].label)}</span></td>
            <td class="bz-n">${r.coverage == null ? '—' : `${Math.round(r.coverage * 100)} %`}</td>
        </tr>`).join('');
    $('bz-score-tally').textContent = `${sc.tally.ahead} ahead · ${sc.tally.level} level · ${sc.tally.behind} behind · ${sc.tally.unscored} not scored`;
}

// ── charts ────────────────────────────────────────────────────────────────
// The charts are drawn at the column's REAL pixel width (a fixed viewBox scaled down to a
// phone made every tick ~3 px tall). Narrow charts drop the direct labels — the legend above
// each chart still names every series.
let W = 760;
const H = 190, M = { l: 46, r: 96, t: 10, b: 24 };
function measure() {
    const w = Math.round($('bz-charts').clientWidth || 760);
    W = Math.max(300, Math.min(w, 1000));
    M.r = W < 560 ? 10 : 96;
    M.l = W < 560 ? 34 : 46;
}
const xOf = (dom) => (t) => M.l + ((t - dom.t0) / (dom.t1 - dom.t0)) * (W - M.l - M.r);

function drawChart(id, { series, bands = [], unit }) {
    const svg = $(id);
    const dom = S.dom, x = xOf(dom);
    const [lo, hi] = yExtent(series.map((s) => s.points));
    const y = (v) => M.t + (1 - (v - lo) / (hi - lo)) * (H - M.t - M.b);
    let g = '';
    for (const v of ticks(lo, hi)) g += `<line x1="${M.l}" x2="${W - M.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${v === 0 ? INK.axis : INK.grid}" stroke-width="1"/><text x="${M.l - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" class="bz-tick">${num(v, Math.abs(hi - lo) < 5 ? 1 : 0)}</text>`;
    for (let h = Math.ceil(dom.t0 / 3600e3); h * 3600e3 <= dom.t1; h++) {
        if (W < 560 && h % 2) continue;
        const t = h * 3600e3;
        g += `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${H - M.b}" y2="${H - M.b + 4}" stroke="${INK.axis}"/><text x="${x(t).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="bz-tick">${String(new Date(t).getUTCHours()).padStart(2, '0')}:00</text>`;
    }
    // "now": everything to its right has not happened yet.
    g += `<rect x="${x(dom.now).toFixed(1)}" y="${M.t}" width="${(W - M.r - x(dom.now)).toFixed(1)}" height="${H - M.t - M.b}" fill="${INK.primary}" opacity="0.035"/>`;
    g += `<line x1="${x(dom.now).toFixed(1)}" x2="${x(dom.now).toFixed(1)}" y1="${M.t}" y2="${H - M.b}" stroke="${INK.muted}" stroke-dasharray="2 3"/><text x="${(x(dom.now) + 4).toFixed(1)}" y="${M.t + 10}" class="bz-tick">now</text>`;
    for (const b of bands) {
        const up = b.points.filter((p) => p.v != null && p.s != null);
        if (up.length > 1) g += `<path d="M${up.map((p) => `${x(p.t).toFixed(1)},${y(p.v + p.s).toFixed(1)}`).join('L')}L${up.slice().reverse().map((p) => `${x(p.t).toFixed(1)},${y(p.v - p.s).toFixed(1)}`).join('L')}Z" fill="${b.color}" opacity="0.14"/>`;
    }
    const labels = [];
    for (const s of series) {
        g += `<path d="${linePath(s.points, x, y)}" fill="none" stroke="${s.color}" stroke-width="${s.width ?? 2}" stroke-linejoin="round" stroke-linecap="round"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`;
        const last = [...s.points].reverse().find((p) => p.v != null);
        if (last && s.label && M.r > 40) labels.push({ y: y(last.v), x: x(last.t), s });
    }
    // Direct labels at the line ends, nudged apart so they never overprint.
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 12) labels[i].y = labels[i - 1].y + 12;
    for (const l of labels) g += `<circle cx="${l.x.toFixed(1)}" cy="${l.y.toFixed(1)}" r="2.5" fill="${l.s.color}"/><text x="${(W - M.r + 8).toFixed(1)}" y="${(l.y + 3.5).toFixed(1)}" class="bz-dl"><tspan fill="${l.s.color}">■ </tspan>${esc(l.s.label)}</text>`;
    g += `<line class="bz-cross" x1="0" x2="0" y1="${M.t}" y2="${H - M.b}" stroke="${INK.secondary}" stroke-width="1" visibility="hidden"/>`;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = g;
    return { id, series, unit, x };
}

function renderCharts() {
    const dom = S.dom = chartDomain(Date.now());
    S.charts = [];
    measure();
    if (S.l1?.trace) {
        const tr = S.l1.trace;
        const fused = traceSeries(tr, tr.bz, dom), sig = traceSeries(tr, tr.sigma, dom);
        const band = fused.map((p, i) => ({ t: p.t, v: p.v, s: sig[i]?.v ?? null }));
        const sc = Object.keys(tr.spacecraft).slice(0, SERIES_COLORS.length);
        S.charts.push(drawChart('bz-chart-l1', { unit: 'nT', bands: [{ points: band, color: INK.primary }], series: [
            ...sc.map((name, i) => ({ label: name, color: SERIES_COLORS[i], width: 1.25, points: traceSeries(tr, tr.spacecraft[name], dom) })),
            { label: 'Fused', color: INK.primary, width: 2, points: fused },
        ] }));
        $('bz-legend-l1').innerHTML = [...sc.map((n, i) => `<span><i style="background:${SERIES_COLORS[i]}"></i>${esc(n)}</span>`), `<span><i style="background:${INK.primary}"></i>Fused, with its 1σ band</span>`].join('');
    }
    if (S.flux?.flux?.trace) {
        const a = fluxSeries(S.flux.flux.trace, dom, 'milan_kv'), b = fluxSeries(S.flux.flux.trace, dom, 'newell_scaled_kv');
        S.charts.push(drawChart('bz-chart-flux', { unit: 'kV', series: [
            { label: 'Newell form', color: SERIES_COLORS[1], width: 1.25, points: [...b.estimated, ...b.forecast.slice(1)] },
            { label: 'Milan 2012', color: SERIES_COLORS[0], width: 2, points: a.estimated },
            { label: null, color: SERIES_COLORS[0], width: 2, dash: '5 4', points: a.forecast },
        ] }));
        $('bz-legend-flux').innerHTML = `<span><i style="background:${SERIES_COLORS[0]}"></i>Milan 2012 (solid: arrived · dashed: still in transit)</span><span><i style="background:${SERIES_COLORS[1]}"></i>Newell 2007 form, scaled</span>`;
    }
    if (S.geo?.satellites) {
        const names = Object.keys(S.geo.satellites).slice(0, 2), series = [];
        names.forEach((n, i) => {
            const s = S.geo.satellites[n], tr = s.trace;
            if (!tr) return;
            series.push({ label: s.slot ?? n, color: SERIES_COLORS[i], width: 2, points: traceSeries(tr, tr.hp_residual, dom) });
            series.push({ label: null, color: SERIES_COLORS[i], width: 1.25, dash: '5 4', points: traceSeries(tr, tr.filter_pred, dom) });
        });
        if (series.length) S.charts.push(drawChart('bz-chart-geo', { unit: 'nT', series }));
        $('bz-legend-geo').innerHTML = names.map((n, i) => `<span><i style="background:${SERIES_COLORS[i]}"></i>${esc(S.geo.satellites[n].slot ?? n)} (solid: measured · dashed: predicted 30 min earlier)</span>`).join('');
    }
    for (const id of ['l1', 'flux', 'geo']) $(`bz-chart-${id}`).closest('.bz-chart').dataset.empty = S.charts.some((c) => c.id === `bz-chart-${id}`) ? '0' : '1';
}

// One crosshair across the three charts, one readout.
function wireHover() {
    const col = $('bz-charts'), tip = $('bz-tip');
    const hide = () => { tip.hidden = true; col.querySelectorAll('.bz-cross').forEach((l) => l.setAttribute('visibility', 'hidden')); };
    col.addEventListener('pointerleave', hide);
    col.addEventListener('pointermove', (ev) => {
        const svg = ev.target.closest?.('svg.bz-svg');
        if (!svg || !S.dom) return hide();
        const r = svg.getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * W;
        if (px < M.l || px > W - M.r) return hide();
        const t = S.dom.t0 + ((px - M.l) / (W - M.l - M.r)) * (S.dom.t1 - S.dom.t0);
        let html = `<b>${new Date(t).toISOString().slice(11, 16)} UT${t > S.dom.now ? ' · not yet happened' : ''}</b>`;
        for (const c of S.charts) {
            const cross = $(c.id).querySelector('.bz-cross');
            cross.setAttribute('x1', px.toFixed(1)); cross.setAttribute('x2', px.toFixed(1)); cross.setAttribute('visibility', 'visible');
            for (const s of c.series) {
                const p = s.label ? nearest(s.points, t) : null;
                if (p) html += `<div><i style="background:${s.color}"></i>${esc(s.label)} <span>${num(p.v, 2, { sign: true })} ${c.unit}</span></div>`;
            }
        }
        tip.innerHTML = html; tip.hidden = false;
        const cr = col.getBoundingClientRect();
        tip.style.left = `${Math.min(ev.clientX - cr.left + 14, cr.width - tip.offsetWidth - 4)}px`;
        tip.style.top = `${ev.clientY - cr.top + 14}px`;
    });
}

// ── data ──────────────────────────────────────────────────────────────────
async function load(key, url) {
    try {
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        S[key] = body.data ?? null;
        S.errors[key] = !body.data;
    } catch { S.errors[key] = true; }
}
async function refreshTraces() {
    if (document.visibilityState === 'hidden') return;
    await Promise.all([load('l1', '/api/bz/l1?minutes=260'), load('flux', '/api/bz/flux?minutes=330'), load('geo', '/api/bz/geo?minutes=260'), load('ground', '/api/bz/ground?summary=1')]);
    renderCharts(); renderScore(); renderStatus();
}

window.addEventListener(BZ_COLUMN_EVENT, (e) => {
    S.columnState = e.detail;
    if (e.detail.column) S.column = e.detail.column;
    renderLadder(); renderStatus();
});
wireHover();
renderStatus();
startBzProvider();
refreshTraces();
setInterval(refreshTraces, 60_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshTraces(); });
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderCharts, 150); });
window.__bzPage = { state: S, refresh: refreshTraces };
