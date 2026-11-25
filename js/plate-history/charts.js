/**
 * charts.js — the planet's tectonic vital signs on ONE time axis (DOM/SVG renderer).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PLATE_HISTORY_PLAN.md. Draws data/plate-history/series.json (OUR kernel's numbers, derived by
 * scripts/build-plate-history-series.mjs) beside Merdith et al. (2021)'s PUBLISHED SM3 tables
 * (dashed, same hue — same quantity, other source; their model version v1.0, ours Cao et al.).
 * Small multiples, never a second y scale; colour follows the quantity (ridges blue, trenches
 * orange — the globe's own colours), validated on #0b1322. One crosshair across all panels;
 * click scrubs the page's time. A table view sits under the charts.
 */
import { BOUNDARY_COLORS, SPEED_COLORS } from './globe.js';
import { LITERATURE_SUPERCONTINENTS, formatAge } from './geotime.js';

const NS = 'http://www.w3.org/2000/svg';
const INK = { primary: '#f0efec', secondary: '#c3c2b7', muted: '#8a91a1', grid: '#1c2740', axis: '#2a3a58', now: '#f0efec' };

const PANELS = [
    { id: 'len', title: 'Plate-boundary length', unit: 'thousand km', series: [
        { key: 'ridgeKm', label: 'Spreading ridges', color: BOUNDARY_COLORS.MidOceanRidge, k: 1e-3, pub: (p) => p.mor?.[1] },
        { key: 'trenchKm', label: 'Subduction zones', color: BOUNDARY_COLORS.SubductionZone, k: 1e-3, pub: (p) => p.sub?.[1] },
    ] },
    { id: 'crust', title: 'Sea floor made and destroyed', unit: 'km² per year', series: [
        { key: 'productionKm2PerMa', label: 'Made at ridges', color: BOUNDARY_COLORS.MidOceanRidge, k: 1e-6, pub: (p) => p.mor?.[2] },
        { key: 'consumptionKm2PerMa', label: 'Destroyed at trenches', color: BOUNDARY_COLORS.SubductionZone, k: 1e-6, pub: (p) => p.sub?.[2] },
    ] },
    { id: 'speed', title: 'Plate speed (area-weighted RMS)', unit: 'mm per year', series: [
        { key: 'rmsSpeedMmYr', label: 'All plates', color: SPEED_COLORS.all, k: 1 },
        { key: 'continentalRmsMmYr', label: 'Continents', color: SPEED_COLORS.continents, k: 1 },
    ] },
    { id: 'sc', title: 'Supercontinent index', unit: '0 = spread · 1 = one mass', bands: true, series: [
        { key: 'supercontinentIndex', label: 'Continental clustering', color: SPEED_COLORS.continents, k: 1 },
    ] },
    { id: 'plates', title: 'Number of plates', unit: 'in the model', series: [
        { key: 'plates', label: 'Plates', color: INK.secondary, k: 1 },
    ] },
];

function el(tag, attrs = {}, parent = null) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
}
const niceStep = (raw) => { const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-12))), f = raw / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p; };
const fmt = (v) => (v == null || !Number.isFinite(v) ? '—' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

/**
 * @param {HTMLElement} host
 * @param {{ rows, published: Map<t, {mor, sub}>, tMax, onScrub(t) }} o
 */
export function renderCharts(host, { rows, published, tMax, onScrub }) {
    host.innerHTML = '';
    const panels = [];
    const byT = new Map(rows.map((r) => [r.t, r]));
    const gapTimes = rows.filter((r) => r.noPlateFrac > 0.02).map((r) => r.t);

    for (const P of PANELS) {
        const wrap = document.createElement('div'); wrap.className = 'pt-chart';
        const head = document.createElement('div'); head.className = 'pt-chart-head';
        const h = document.createElement('h3'); h.textContent = P.title;
        const u = document.createElement('span'); u.className = 'pt-unit'; u.textContent = P.unit; h.append(' ', u);
        const leg = document.createElement('div'); leg.className = 'pt-legend';
        if (P.series.length > 1 || P.series.some((s) => s.pub)) {
            for (const s of P.series) leg.insertAdjacentHTML('beforeend', `<span><i style="background:${s.color}"></i>${s.label}</span>`);
            if (P.series.some((s) => s.pub)) leg.insertAdjacentHTML('beforeend', '<span><i class="pt-dash"></i>Merdith et al. 2021, published (their v1.0)</span>');
        }
        if (P.bands) leg.insertAdjacentHTML('beforeend', '<span><i class="pt-band"></i>Literature ages of supercontinents</span>');
        head.append(h, leg);
        const svg = el('svg', { class: 'pt-svg', role: 'img', 'aria-label': `${P.title} through time` });
        const tip = document.createElement('div'); tip.className = 'pt-tip'; tip.hidden = true;
        wrap.append(head, svg, tip);
        host.appendChild(wrap);
        panels.push({ P, svg, tip, wrap });
    }

    const H = 128, M = { l: 50, r: 14, t: 8, b: 20 };
    let W = 600, x = null, cur = 0;

    function draw() {
        W = Math.max(320, host.clientWidth);
        x = (t) => M.l + (1 - t / tMax) * (W - M.l - M.r);
        for (const p of panels) {
            const { P, svg } = p;
            svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
            svg.innerHTML = '';
            let hi = 0;
            for (const s of P.series) for (const r of rows) {
                const v = r[s.key] * s.k; if (Number.isFinite(v)) hi = Math.max(hi, v);
                const pv = s.pub && published.get(r.t); const q = pv && s.pub(pv);
                if (q != null) hi = Math.max(hi, q * s.k);
            }
            if (P.id === 'sc') hi = Math.max(hi, 0.8);
            const step = niceStep(hi / 4), top = Math.ceil(hi / step) * step || 1;
            const y = (v) => M.t + (1 - v / top) * (H - M.t - M.b);
            p.y = y; p.top = top;
            // Bands (literature supercontinents) and topology gaps, under everything.
            if (P.bands) for (const L of LITERATURE_SUPERCONTINENTS) {
                el('rect', { x: x(L.assembled), y: M.t, width: x(L.brokeUp) - x(L.assembled), height: H - M.t - M.b, fill: '#c3c2b7', opacity: 0.08 }, svg);
                const tx = el('text', { x: (x(L.assembled) + x(L.brokeUp)) / 2, y: M.t + 11, 'text-anchor': 'middle', fill: INK.muted, 'font-size': 10 }, svg);
                tx.textContent = L.name;
            }
            for (const g of gapTimes) el('rect', { x: x(g + 2.5), y: M.t, width: Math.max(2, x(g - 2.5) - x(g + 2.5)), height: H - M.t - M.b, fill: '#e66767', opacity: 0.18 }, svg);
            // Grid + y ticks.
            for (let v = 0; v <= top + 1e-9; v += step) {
                el('line', { x1: M.l, x2: W - M.r, y1: y(v), y2: y(v), stroke: v === 0 ? INK.axis : INK.grid, 'stroke-width': 1 }, svg);
                const tx = el('text', { x: M.l - 6, y: y(v) + 3.5, 'text-anchor': 'end', fill: INK.muted, 'font-size': 10 }, svg);
                tx.textContent = step < 0.1 ? v.toFixed(2) : step < 1 ? v.toFixed(1) : v.toLocaleString();
            }
            // X ticks every 200 Myr.
            for (let t = 0; t <= tMax; t += 200) {
                el('line', { x1: x(t), x2: x(t), y1: H - M.b, y2: H - M.b + 3, stroke: INK.axis }, svg);
                const tx = el('text', { x: x(t), y: H - 5, 'text-anchor': t === tMax ? 'start' : t === 0 ? 'end' : 'middle', fill: INK.muted, 'font-size': 10 }, svg);
                tx.textContent = t === 0 ? 'today' : t >= 1000 ? `${t / 1000} Ga` : `${t} Ma`;
            }
            // Published (dashed), then ours (solid).
            for (const s of P.series) if (s.pub) {
                let d = '', pen = false;
                for (const r of rows) {
                    const pv = published.get(r.t), q = pv && s.pub(pv);
                    if (q == null) { pen = false; continue; }
                    d += `${pen ? 'L' : 'M'}${x(r.t).toFixed(1)},${y(q * s.k).toFixed(1)}`; pen = true;
                }
                el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 1.4, 'stroke-dasharray': '4 3', opacity: 0.8 }, svg);
            }
            for (const s of P.series) {
                let d = '', pen = false;
                for (const r of rows) {
                    const v = r[s.key] * s.k;
                    if (!Number.isFinite(v) || r.noPlateFrac > 0.02) { pen = false; continue; }
                    d += `${pen ? 'L' : 'M'}${x(r.t).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
                }
                el('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
            }
            p.now = el('line', { x1: 0, x2: 0, y1: M.t, y2: H - M.b, stroke: INK.now, 'stroke-width': 1.25, opacity: 0.85 }, svg);
            p.hair = el('line', { x1: 0, x2: 0, y1: M.t, y2: H - M.b, stroke: INK.secondary, 'stroke-width': 1, 'stroke-dasharray': '2 2', visibility: 'hidden' }, svg);
            el('rect', { x: M.l, y: 0, width: W - M.l - M.r, height: H, fill: 'transparent', class: 'pt-hit' }, svg);
        }
        setTime(cur);
    }

    function nearestRow(t) { const k = Math.round(t / 5) * 5; return byT.get(Math.max(0, Math.min(tMax, k))); }
    function tAt(svg, ev) {
        const r = svg.getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * W;
        return Math.max(0, Math.min(tMax, (1 - (px - M.l) / (W - M.l - M.r)) * tMax));
    }
    function hover(t, owner) {
        const row = nearestRow(t);
        for (const p of panels) {
            p.hair.setAttribute('x1', x(row.t)); p.hair.setAttribute('x2', x(row.t)); p.hair.setAttribute('visibility', 'visible');
            if (p !== owner) { p.tip.hidden = true; continue; }
            const pub = published.get(row.t);
            const lines = p.P.series.map((s) => {
                const q = s.pub && pub && s.pub(pub);
                return `<div><i style="background:${s.color}"></i>${s.label} <b>${fmt(row[s.key] * s.k)}</b>${q != null ? ` <span class="pt-muted">(published ${fmt(q * s.k)})</span>` : ''}</div>`;
            });
            if (row.noPlateFrac > 0.02) lines.push(`<div class="pt-warn">Model topology gap: ${(100 * row.noPlateFrac).toFixed(0)} % of the globe in no plate</div>`);
            p.tip.innerHTML = `<div class="pt-tip-t">${formatAge(row.t)}</div>${lines.join('')}`;
            p.tip.hidden = false;
            const px = (x(row.t) / W) * p.svg.getBoundingClientRect().width;
            p.tip.style.left = `${Math.min(px + 12, p.wrap.clientWidth - 230)}px`;
        }
    }
    for (const p of panels) {
        p.svg.addEventListener('pointermove', (ev) => hover(tAt(p.svg, ev), p));
        p.svg.addEventListener('pointerleave', () => { for (const q of panels) { q.hair.setAttribute('visibility', 'hidden'); q.tip.hidden = true; } });
        p.svg.addEventListener('click', (ev) => onScrub && onScrub(Math.round(tAt(p.svg, ev))));
    }

    function setTime(t) {
        cur = t;
        for (const p of panels) if (p.now) { p.now.setAttribute('x1', x(t)); p.now.setAttribute('x2', x(t)); }
    }
    new ResizeObserver(() => draw()).observe(host);
    draw();
    return { setTime };
}

/** A plain table of the series every 50 Myr (the charts' table view). */
export function renderTable(host, rows) {
    const keep = rows.filter((r) => r.t % 50 === 0);
    const head = ['Time', 'Plates', 'Ridges (km)', 'Trenches (km)', 'Made (km²/yr)', 'Destroyed (km²/yr)', 'RMS speed (mm/yr)', 'Continents (mm/yr)', 'Supercontinent index'];
    const body = keep.map((r) => [formatAge(r.t), r.plates, r.ridgeKm.toLocaleString(), r.trenchKm.toLocaleString(),
        (r.productionKm2PerMa / 1e6).toFixed(2), (r.consumptionKm2PerMa / 1e6).toFixed(2), r.rmsSpeedMmYr, r.continentalRmsMmYr, r.supercontinentIndex.toFixed(2)]);
    host.innerHTML = `<table class="pt-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
        body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
