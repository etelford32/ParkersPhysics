/**
 * fleet-assessment-view.js — DOM/SVG renderers for the fleet assessment
 * (sample-fleet-assessment.html: the sample Gannon chart AND the interactive
 * simulator draw through these, so the two read as one product).
 *
 * Computes NOTHING: every value arrives from js/fleet-assessment.js results.
 * Styling uses the page's own tokens (--c-data, --c-grid, .sa-tip, .axis,
 * .lbl, .val) so it inherits the page's dark palette.
 */

const SVG = 'http://www.w3.org/2000/svg';

export const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const kmOrM = (k) => !Number.isFinite(k) ? '—' : Math.abs(k) >= 1 ? `${k.toFixed(1)} km` : `${Math.round(k * 1000)} m`;
export const fmtLife = (d) => d == null || !Number.isFinite(d) ? '>100 y' : d < 365.25 ? `${Math.round(d)} d` : `${(d / 365.25).toFixed(1)} y`;

export function svgEl(tag, attrs = {}, parent) {
    const n = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
}

/**
 * Horizontal bars with ±σ whiskers, one row per spacecraft.
 * rows: [{ label, shortLabel?, value, lo, hi, tipHtml }]
 * Sizes itself to the host so type stays at its CSS size on a phone.
 */
export function renderLossBars(host, rows, { ariaLabel = 'Extra altitude lost per satellite' } = {}) {
    host.replaceChildren();
    const W = Math.max(330, Math.min(760, host.clientWidth || 760));
    const narrow = W < 520;
    const rowH = 34, padL = narrow ? 120 : 200, padR = 64, padT = 8;
    const H = padT + rows.length * rowH + 26;
    const max = Math.max(1e-6, ...rows.map(r => r.hi));
    const x = (v) => padL + (Math.max(0, v) / max) * (W - padL - padR);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': ariaLabel }, host);
    const ticks = narrow ? 2 : 4;
    const ax = svgEl('g', { class: 'axis' }, svg);
    for (let i = 0; i <= ticks; i++) {
        const v = max * i / ticks;
        svgEl('line', { x1: x(v), x2: x(v), y1: padT, y2: H - 22, stroke: 'var(--c-grid)' }, ax);
        svgEl('text', { x: x(v), y: H - 6, 'text-anchor': 'middle' }, ax).textContent = kmOrM(v);
    }
    const tip = document.createElement('div'); tip.className = 'sa-tip'; host.appendChild(tip);
    rows.forEach((r, i) => {
        const y = padT + i * rowH + 8, bh = rowH - 16;
        svgEl('text', { x: padL - 10, y: y + bh / 2 + 4, 'text-anchor': 'end', class: 'lbl' }, svg)
            .textContent = narrow && r.shortLabel ? r.shortLabel : r.label;
        const w = Math.max(2, x(r.value) - padL);
        const rr = Math.min(4, w / 2);
        svgEl('path', { d: `M${padL},${y} h${w - rr} a${rr},${rr} 0 0 1 ${rr},${rr} v${bh - 2 * rr} a${rr},${rr} 0 0 1 ${-rr},${rr} h${-(w - rr)} z`, fill: 'var(--c-data)', opacity: .85 }, svg);
        svgEl('line', { x1: x(r.lo), x2: x(r.hi), y1: y + bh / 2, y2: y + bh / 2, stroke: 'var(--fg-2)', 'stroke-width': 1.5 }, svg);
        for (const v of [r.lo, r.hi]) svgEl('line', { x1: x(v), x2: x(v), y1: y + 3, y2: y + bh - 3, stroke: 'var(--fg-2)', 'stroke-width': 1.5 }, svg);
        svgEl('text', { x: x(r.hi) + 8, y: y + bh / 2 + 4, class: 'val' }, svg).textContent = kmOrM(r.value);
        const hit = svgEl('rect', { x: 0, y: y - 6, width: W, height: rowH, fill: 'transparent' }, svg);
        hit.addEventListener('pointerenter', () => {
            tip.innerHTML = r.tipHtml;
            const box = host.getBoundingClientRect(), sb = svg.getBoundingClientRect();
            tip.style.left = `${Math.max(0, Math.min(box.width - 240, (x(r.hi) / W) * sb.width + 12))}px`;
            tip.style.top = `${(y / H) * sb.height - 6}px`;
            tip.classList.add('on');
        });
        hit.addEventListener('pointerleave', () => tip.classList.remove('on'));
    });
    return svg;
}

/**
 * The storm itself: 3-hourly Ap as a compact column strip with the NOAA
 * G-scale thresholds (Ap 48 ≈ G1 … Ap 400 = G5 via Kp) as reference lines.
 */
export function renderApStrip(host, event) {
    host.replaceChildren();
    const W = Math.max(330, Math.min(760, host.clientWidth || 760));
    const H = 120, padL = 40, padR = 10, padT = 10, padB = 22;
    const n = event.ap.length;
    const yMax = 420;
    const bw = (W - padL - padR) / n;
    const y = (v) => padT + (1 - v / yMax) * (H - padT - padB);
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `3-hourly Ap index, ${event.label}` }, host);
    const ax = svgEl('g', { class: 'axis' }, svg);
    for (const [v, g] of [[48, 'G1'], [400, 'G5']]) {
        svgEl('line', { x1: padL, x2: W - padR, y1: y(v), y2: y(v), stroke: 'var(--c-grid)', 'stroke-dasharray': '3 3' }, ax);
        svgEl('text', { x: padL - 6, y: y(v) + 4, 'text-anchor': 'end' }, ax).textContent = g;
    }
    const t0 = Date.parse(event.startIso);
    const days = Math.round(n * event.stepHours / 24);
    for (let d = 0; d <= days; d += (W < 520 ? 2 : 1)) {
        svgEl('text', { x: padL + d * (24 / event.stepHours) * bw, y: H - 6, 'text-anchor': 'middle' }, ax)
            .textContent = new Date(t0 + d * 86400e3).toISOString().slice(5, 10);
    }
    event.ap.forEach((v, i) => {
        svgEl('rect', { x: padL + i * bw + 0.5, y: y(v), width: Math.max(1, bw - 1), height: Math.max(1, y(0) - y(v)),
            fill: 'var(--c-data)', opacity: .8 }, svg);
    });
    return svg;
}
