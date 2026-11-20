/**
 * js/bz-page.js — bz.html's renderer.
 *
 * BZ_ENGINE_PLAN.md phases B6 + B7. It DRAWS ONLY what js/bz/page-model.js,
 * js/bz/planet-view.js and js/bz/forecast-join.js return:
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
import { sceneModel } from './bz/planet-view.js';
import { mountPlanet, PLANET_COLORS } from './bz-planet-canvas.js';
import { ropeSeries, joinForecast, scoreRope } from './bz/forecast-join.js';
import { KINDS, VERDICTS, SERIES_COLORS, INK, UNVERIFIED_NAMES, ladderRows, scorecard, chartDomain, traceSeries, fluxSeries, yExtent, ticks, linePath, nearest, num, relTime, hindcastTable } from './bz/page-model.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { column: null, columnState: null, l1: null, flux: null, geo: null, ground: null, errors: {}, charts: [], dom: null,
    fc: null, rope: ropeSeries(null), join: null, l1Long: null, ropeScore: null, planet: null };

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
    const sc = scorecard({ l1: S.l1, geo: S.geo, ground: S.ground?.ground, ring: S.ground?.ring_current, rope: S.ropeScore });
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


// ── B7: the forecast past the L1 horizon, and the stage ───────────────────
// The rope forecast is the ONE shared provider's (js/sun-flux-rope.js publishes it); this page
// only joins it on (js/bz/forecast-join.js) and draws the result.
function computeJoin() {
    S.join = joinForecast({ trace: S.flux?.flux?.trace ?? null, rope: S.rope, nowMs: Date.now() });
    S.ropeScore = S.rope.state === 'pending' ? { status: 'pending' }
        : scoreRope({ rope: S.rope, l1: S.l1Long?.trace ? { t0: S.l1Long.trace.t0, step_s: S.l1Long.trace.step_s, bz: S.l1Long.trace.bz } : null, nowMs: Date.now() });
}
const buildScene = (nowMs) => sceneModel({ column: S.column, fluxTrace: S.flux?.flux?.trace ?? null, join: S.join, nowMs });

function renderRead() {
    const rung = (id) => (S.column?.rungs ?? []).find((r) => r.id === id);
    const l1 = rung('l1'), sh = rung('bow_shock'), j = S.join, now = Date.now();
    const item = (label, value, small = '', kind = '') => `<div data-kind="${kind}"><dt>${esc(label)}</dt><dd>${esc(value)}${small ? `<small>${esc(small)}</small>` : ''}</dd></div>`;
    let last = '';
    if (!j || j.status === 'pending') last = item('Beyond the L1 horizon', 'Checking for a CME in flight…', '', 'none');
    else if (j.status === 'joined') last = item(`Beyond that — CME forecast (${j.rope.cmes} CME${j.rope.cmes > 1 ? 's' : ''})`,
        `deepest median Bz ${num(j.deepest?.p50_nt, 1, { sign: true })} nT`, `${j.deepest ? relTime(new Date(j.deepest.t).toISOString(), now) : ""} · 1-in-20 case ${num(j.deepest?.p5_nt, 1, { sign: true })} nT · forecast, not measured`);
    else if (j.status === 'rope_beyond' && j.silentSteps) last = item('Beyond the L1 horizon', 'A CME is in flight; its forecast does not reach Earth inside the next 24 hours.', '', 'none');
    else last = item('Beyond the L1 horizon', j.statusText.charAt(0).toUpperCase() + j.statusText.slice(1) + '.', '', j.status === 'rope_down' ? 'down' : 'none');
    $('bz-read').innerHTML = [
        item('Measured at L1', l1?.values ? `Bz ${num(l1.values.bz_nt, 2, { sign: true })} ± ${num(l1.sigma?.bz_nt, 2)} nT` : '—', l1?.time ? relTime(l1.time, now) : 'no L1 measurement'),
        item('Reaching the bow shock now', sh?.values ? `Bz ${num(sh.values.bz_nt, 2, { sign: true })} nT` : '—', sh?.values ? `${num(sh.values.speed_kms, 0)} km/s · estimated from L1` : ''),
        item('Last wind L1 has seen', sh?.forecast ? `Bz ${num(sh.forecast.bz_nt, 2, { sign: true })} nT` : '—', sh?.forecast ? `arrives ${relTime(sh.forecast.time, now)}` : ''),
        last,
    ].join('');
}

function renderStage() {
    computeJoin();
    if (!S.planet) S.planet = mountPlanet($('bz-planet'), $('bz-planet-tip'), buildScene); else S.planet.refresh();
    const sc = S.planet.scene();
    renderRead();
    $('bz-key-hollow').hidden = !(sc?.forecast.length);
    $('bz-key-scale').textContent = sc ? `longest arrow = ${num(sc.arrowFullNt, 0)} nT` : '';
    $('bz-stage-note').textContent = sc ? `${sc.disclosures.join(' ')} The thin streaks only show the flow direction.` : '';
    renderOutlook();
}

// The joined forecast as a chart, drawn ONLY when a CME forecast exists. Its time axis (−3 h … +24 h)
// is its own, which is why it lives in this card and not among the three charts that share one.
function renderOutlook() {
    const j = S.join, host = $('bz-outlook');
    host.hidden = !(j && j.status === 'joined');
    if (host.hidden) return;
    const svg = $('bz-chart-outlook'), now = j.nowMs, t0 = now - 3 * 3600e3, t1 = j.endMs;
    const w = Math.max(300, Math.min(Math.round(host.clientWidth || 900), 1200)), h = 200, m = { l: 40, r: 12, t: 12, b: 24 };
    const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (w - m.l - m.r);
    const pts = (a) => a.filter((p) => p.t >= t0).map((p) => ({ t: p.t, v: p.bz }));
    const arrived = pts(j.arrived), transit = pts(j.transit), med = j.prior.map((p) => ({ t: p.t, v: p.p50 }));
    const [lo, hi] = yExtent([arrived, transit, j.prior.map((p) => ({ v: p.p5 })), j.prior.map((p) => ({ v: p.p95 }))]);
    const y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (h - m.t - m.b);
    const CME = SERIES_COLORS[2];
    let g = '';
    for (const v of ticks(lo, hi)) g += `<line x1="${m.l}" x2="${w - m.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="${v === 0 ? INK.axis : INK.grid}"/><text x="${m.l - 6}" y="${(y(v) + 3.5).toFixed(1)}" text-anchor="end" class="bz-tick">${num(v, 0)}</text>`;
    const stepH = w < 560 ? 6 : 3;
    for (let k = Math.ceil(t0 / 3600e3); k * 3600e3 <= t1; k++) {
        const t = k * 3600e3, hr = new Date(t).getUTCHours();
        if (hr % stepH) continue;
        g += `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${h - m.b}" y2="${h - m.b + 4}" stroke="${INK.axis}"/><text x="${x(t).toFixed(1)}" y="${h - 6}" text-anchor="middle" class="bz-tick">${String(hr).padStart(2, '0')}:00</text>`;
    }
    const band = (a, b, op) => `<path d="M${j.prior.map((p) => `${x(p.t).toFixed(1)},${y(p[b]).toFixed(1)}`).join('L')}L${j.prior.slice().reverse().map((p) => `${x(p.t).toFixed(1)},${y(p[a]).toFixed(1)}`).join('L')}Z" fill="${CME}" opacity="${op}"/>`;
    g += band('p5', 'p95', 0.13) + band('p25', 'p75', 0.2);
    const mark = (t, label, anchor = 'start') => `<line x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${m.t}" y2="${h - m.b}" stroke="${INK.muted}" stroke-dasharray="2 3"/><text x="${(x(t) + (anchor === 'start' ? 4 : -4)).toFixed(1)}" y="${m.t + 9}" text-anchor="${anchor}" class="bz-tick">${label}</text>`;
    g += mark(now, 'now', 'end') + mark(j.l1HorizonMs, 'L1 has seen up to here');
    g += `<path d="${linePath(arrived, x, y)}" fill="none" stroke="${INK.primary}" stroke-width="2" stroke-linejoin="round"/>`;
    g += `<path d="${linePath(transit, x, y)}" fill="none" stroke="${INK.primary}" stroke-width="2" stroke-dasharray="5 4"/>`;
    g += `<path d="${linePath(med, x, y)}" fill="none" stroke="${CME}" stroke-width="2" stroke-dasharray="2 4" stroke-linecap="round"/>`;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`); svg.innerHTML = g;
    $('bz-legend-outlook').innerHTML = `<span><i style="background:${INK.primary}"></i>From L1 (solid: arrived · dashed: in transit)</span><span><i style="background:${CME}"></i>CME forecast: median, with its 50 % and 90 % bands</span>`;
    const s = j.seam;
    $('bz-outlook-note').textContent = [
        s ? `Where the two meet, L1's last value is ${num(s.l1_bz_nt, 1, { sign: true })} nT and the CME forecast's median is ${num(s.rope_p50_nt, 1, { sign: true })} nT${s.l1_inside_rope_band === false ? ' — L1 is outside the forecast\'s 90 % band there' : ''}; the step is shown, not smoothed.` : '',
        ...j.caveats.map((c) => c.charAt(0).toUpperCase() + c.slice(1) + '.'),
    ].filter(Boolean).join(' ');
}

async function onRope(fc) {
    S.fc = fc; S.rope = ropeSeries(fc);
    // The score needs a longer L1 record than the charts do; fetched only when there is a rope to score.
    if (S.rope.state === 'ok') await load('l1Long', '/api/bz/l1?minutes=1440');
    renderStage(); renderScore();
}
window.addEventListener('flux-rope-forecast', (e) => onRope(e.detail));
import('./sun-flux-rope.js').then((m) => { if (window.__fluxRopeForecast) onRope(window.__fluxRopeForecast); m.startFluxRopeProvider({ delayMs: 600 }); })
    .catch((e) => onRope({ idle: true, failed: true, reason: `forecast module failed to load: ${e?.message ?? e}` }));


// ── the archive hindcast: a baked result (scripts/bz-hindcast.mjs), drawn as it is ───────────
async function renderHindcast() {
    const body = $('bz-hind-body');
    let h = null;
    try { const r = await fetch('./data/bz/hindcast-dst.json'); if (r.ok) h = await r.json(); } catch { /* shown below */ }
    const t = hindcastTable(h);
    if (!t.rows.length) { body.innerHTML = '<tr><td colspan="4" class="bz-empty">The archive result could not be loaded.</td></tr>'; return; }
    const cell = (c) => (c.skill == null ? '<td data-verdict="unscored">—</td>'
        : `<td data-verdict="${c.verdict}"><span class="bz-glyph" aria-hidden="true">${VERDICTS[c.verdict].glyph}</span>${esc(num(c.skill, 2, { sign: true }))}<small>${c.lo == null ? '' : `${esc(num(c.lo, 2, { sign: true }))} to ${esc(num(c.hi, 2, { sign: true }))}`} · ${esc(c.verdict)}</small></td>`);
    body.innerHTML = t.rows.map((r) => `<tr><th scope="row">${r.lead_h} h</th>${cell(r.given)}${cell(r.storm)}${cell(r.forecast)}</tr>`).join('');
    const one = t.rows.find((r) => r.lead_h === 1), day = t.rows[t.rows.length - 1];
    const d = (iso) => (iso ? iso.slice(0, 10) : '');
    $('bz-hind-note').textContent = [
        `${t.windows} 24-hour windows over ${t.days} days (${d(t.from)} to ${d(t.to)}), ${t.disturbed} of them disturbed (Dst below ${num(t.disturbedBelow, 0)} nT; the deepest hour in the record is ${num(t.deepest, 0)} nT, so no severe storm is in it).`,
        `The first two columns drive the model with wind measured after the start time, so they test the model, not a forecast. The third column is the forecast.`,
        day?.given?.bias != null ? `The model runs low: its mean error grows to ${num(day.given.bias, 1, { sign: true })} nT by ${day.lead_h} hours.` : '',
        one?.given_centre?.skill != null ? `At one hour the answer depends on how an hourly index is time-stamped: ${num(one.given.skill, 2, { sign: true })} comparing at the hour mark, ${num(one.given_centre.skill, 2, { sign: true })} comparing with the hour's mean.` : '',
        t.notHindcast.length ? `Not tested here: ${t.notHindcast.join('; ')}.` : '',
    ].filter(Boolean).join(' ');
}
renderHindcast();

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
    renderStage(); renderCharts(); renderScore(); renderStatus();
}

window.addEventListener(BZ_COLUMN_EVENT, (e) => {
    S.columnState = e.detail;
    if (e.detail.column) S.column = e.detail.column;
    renderLadder(); renderStage(); renderStatus();
});
wireHover();
renderStatus();
startBzProvider();
refreshTraces();
setInterval(refreshTraces, 60_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshTraces(); });
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { renderCharts(); renderOutlook(); }, 150); });
window.__bzPage = { state: S, refresh: refreshTraces };
