/**
 * skyview-forecast-ui.js — SkyView's forecast views (DOM only)
 * ═══════════════════════════════════════════════════════════════════════════
 * Draws what js/skyview/sky-predict.js computed; computes no astronomy.
 *
 *   renderForecastChart  the 30-night VISIBILITY CALENDAR for one object:
 *                        one column per night, time of night running down.
 *                        Bands = how dark the sky is (civil twilight, then
 *                        astronomical darkness); the coloured bar = when the
 *                        object is above the altitude floor IN the dark; the
 *                        dot above each column = the Moon's lit fraction.
 *   sparklineSvg         the same per-night hours, as 30 tiny bars, for lists.
 *
 * Chart rules followed (the dataviz method): one series ⇒ no legend box (the
 * heading names it); one y-axis; thin marks with a 2 px gap between columns;
 * recessive bands and axes; every value also reachable WITHOUT hover (the
 * table view); tooltip text written with textContent.
 *
 * The vertical axis is LOCAL MEAN SOLAR TIME AT THE SITE (0h = the Sun's
 * lowest), because a night is a property of the place; tooltips and the table
 * print the device clock with its zone name, which is what you set an alarm by.
 */

export const SERIES_COLOR = '#3987e5';            // dataviz slot 1 (dark), validated on this surface
const BAND_TWILIGHT = '#141c33';
const BAND_DARK = '#212b4d';
const INK = '#cfd6ea', INK_MUTED = '#8792ad';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}) => {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
};
const msFromJd = (jd) => (jd - 2440587.5) * 86_400_000;

export function clockOf(jd) {
    return new Date(msFromJd(jd)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}
export function shortClock(jd) {
    return new Date(msFromJd(jd)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
export function nightDate(night) {
    return new Date(msFromJd(night.noonJd)).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** "21:40–02:10 · peak 54°" | "not above 20° in the dark" */
export function describeWindow(night, minAltDeg) {
    if (!night.windows.length) return `not above ${minAltDeg}° in the dark`;
    const first = night.windows[0], last = night.windows[night.windows.length - 1];
    const peak = night.peakAltDeg != null ? ` · peak ${Math.round(night.peakAltDeg)}°` : '';
    return `${shortClock(first.start)}–${shortClock(last.end)}${peak}`;
}

/** Thirty tiny bars of usable hours (one series, no axis — a shape, with a title for the numbers). */
export function sparklineSvg(nights, { width = 92, height = 22, maxHours = 12 } = {}) {
    const n = nights.length;
    const cw = width / n;
    let bars = '';
    nights.forEach((nt, i) => {
        const h = Math.max(0, Math.min(1, nt.hours / maxHours)) * (height - 2);
        if (h <= 0.2) {
            bars += `<rect x="${(i * cw + 0.5).toFixed(2)}" y="${height - 1}" width="${Math.max(1, cw - 1).toFixed(2)}" height="1" fill="#2a3354"/>`;
        } else {
            bars += `<rect x="${(i * cw + 0.5).toFixed(2)}" y="${(height - h).toFixed(2)}" width="${Math.max(1, cw - 1).toFixed(2)}" height="${h.toFixed(2)}" rx="1" fill="${SERIES_COLOR}"/>`;
        }
    });
    const tot = nights.reduce((a, b) => a + b.hours, 0);
    return `<svg class="sv-spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${tot.toFixed(0)} usable hours over ${n} nights">${bars}</svg>`;
}

/**
 * The visibility calendar. `onPick(night)` fires on a column click (the page
 * jumps the clock there). `nowJd` draws the current instant if it falls inside.
 */
export function renderForecastChart(host, forecast, { nowJd = null, onPick = null, name = '' } = {}) {
    host.replaceChildren();
    const nights = forecast.nights;
    if (!nights.length) return;
    const W = 360, H = 176, L = 30, R = 6, T = 16, B = 20;
    const plotH = H - T - B, cw = (W - L - R) / nights.length;

    // Vertical range: the twilight envelope across all nights, ±0.5 h.
    let lo = Infinity, hi = -Infinity;
    for (const n of nights) {
        if (n.twilightStart != null) lo = Math.min(lo, (n.twilightStart - n.midnightJd) * 24);
        if (n.twilightEnd != null) hi = Math.max(hi, (n.twilightEnd - n.midnightJd) * 24);
    }
    if (!Number.isFinite(lo)) { lo = -6; hi = 6; }
    lo = Math.max(-12, Math.floor(lo - 0.5)); hi = Math.min(12, Math.ceil(hi + 0.5));
    const y = (n, jd) => T + ((jd - n.midnightJd) * 24 - lo) / (hi - lo) * plotH;

    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', role: 'img',
        'aria-label': `When ${name} is above ${forecast.minAltDeg}° in darkness, each of the next ${nights.length} nights` });
    svg.classList.add('sv-fc-svg');

    // Axis (recessive): hour gridlines every 3 h of local solar time.
    for (let h = Math.ceil(lo / 3) * 3; h <= hi; h += 3) {
        const yy = T + (h - lo) / (hi - lo) * plotH;
        svg.append(el('line', { x1: L, x2: W - R, y1: yy, y2: yy, stroke: '#1a2238', 'stroke-width': 1 }));
        const t = el('text', { x: L - 4, y: yy + 3, 'text-anchor': 'end', 'font-size': 9, fill: INK_MUTED });
        t.textContent = `${((h % 24) + 24) % 24}h`;
        svg.append(t);
    }

    nights.forEach((n, i) => {
        const x = L + i * cw + 1, w = Math.max(1, cw - 2);          // 2 px surface gap between columns
        if (n.twilightStart != null && n.twilightEnd != null) {
            svg.append(el('rect', { x, y: y(n, n.twilightStart), width: w, height: Math.max(0, y(n, n.twilightEnd) - y(n, n.twilightStart)), fill: BAND_TWILIGHT }));
        }
        if (n.dusk != null && n.dawn != null) {
            svg.append(el('rect', { x, y: y(n, n.dusk), width: w, height: Math.max(0, y(n, n.dawn) - y(n, n.dusk)), fill: BAND_DARK }));
        }
        for (const win of n.windows) {
            const y0 = y(n, win.start), y1 = y(n, win.end);
            svg.append(el('rect', { x, y: y0, width: w, height: Math.max(1.5, y1 - y0), rx: Math.min(2, w / 2), fill: SERIES_COLOR }));
        }
        // The Moon: lit fraction as opacity of a small dot above the column.
        svg.append(el('circle', { cx: x + w / 2, cy: T - 8, r: Math.min(3, w / 2), fill: '#e9e6dc', 'fill-opacity': (0.12 + 0.88 * n.moonIllum).toFixed(2) }));
        if (i % 7 === 0) {
            const t = el('text', { x: x + w / 2, y: H - 6, 'text-anchor': 'middle', 'font-size': 9, fill: INK_MUTED });
            t.textContent = nightDate(n);
            svg.append(t);
        }
    });

    // Best night: a caret under the column, labelled.
    if (forecast.best >= 0) {
        const bx = L + forecast.best * cw + cw / 2;
        svg.append(el('path', { d: `M${bx - 4},${H - B + 7} L${bx + 4},${H - B + 7} L${bx},${H - B + 2} Z`, fill: INK }));
    }
    // Now.
    if (nowJd != null) {
        const k = nights.findIndex((n) => nowJd >= n.noonJd && nowJd < n.noonJd + 1);
        if (k >= 0) {
            const n = nights[k];
            const yy = y(n, nowJd);
            if (yy >= T && yy <= T + plotH) {
                svg.append(el('line', { x1: L + k * cw - 2, x2: L + (k + 1) * cw + 2, y1: yy, y2: yy, stroke: '#ffffff', 'stroke-width': 2 }));
            }
            svg.append(el('rect', { x: L + k * cw + 0.5, y: T, width: Math.max(1, cw - 1), height: plotH, fill: 'none', stroke: 'rgba(255,255,255,0.45)', 'stroke-width': 1 }));
        }
    }

    // Hit targets: whole columns (bigger than the marks), one tooltip.
    const tip = document.createElement('div');
    tip.className = 'sv-fc-tip';
    tip.hidden = true;
    const hover = el('rect', { x: 0, y: T, width: Math.max(1, cw - 1), height: plotH, fill: 'rgba(127,208,255,0.10)', visibility: 'hidden' });
    svg.append(hover);
    nights.forEach((n, i) => {
        const hit = el('rect', { x: L + i * cw, y: 0, width: cw, height: H, fill: 'transparent' });
        hit.style.cursor = onPick ? 'pointer' : 'default';
        const show = (ev) => {
            hover.setAttribute('x', L + i * cw + 0.5);
            hover.setAttribute('visibility', 'visible');
            tip.replaceChildren();
            const b = document.createElement('b');
            b.textContent = n.hours > 0 ? `${n.hours.toFixed(1)} h usable` : 'not usable';
            const lines = [
                `${nightDate(n)} night`,
                n.windows.length ? `up ≥${forecast.minAltDeg}°: ${shortClock(n.windows[0].start)}–${shortClock(n.windows[n.windows.length - 1].end)}` : `never ≥${forecast.minAltDeg}° in the dark`,
                n.peakAltDeg != null ? `peak in dark: ${Math.round(n.peakAltDeg)}° at ${clockOf(n.peakJd)}` : '',
                n.dusk != null ? `dark: ${shortClock(n.dusk)}–${shortClock(n.dawn)}` : 'no astronomical darkness',
                `Moon ${Math.round(n.moonIllum * 100)}% lit${n.moonSepDeg != null ? `, ${Math.round(n.moonSepDeg)}° away` : ''}`,
            ].filter(Boolean);
            tip.append(b);
            for (const l of lines) { const d = document.createElement('div'); d.textContent = l; tip.append(d); }
            tip.hidden = false;
            const r = host.getBoundingClientRect();
            const px = (ev?.clientX ?? (r.left + (L + i * cw) * r.width / W)) - r.left;
            tip.style.left = `${Math.min(r.width - 170, Math.max(0, px + 10))}px`;
            tip.style.top = '4px';
        };
        hit.addEventListener('pointermove', show);
        hit.addEventListener('pointerleave', () => { tip.hidden = true; hover.setAttribute('visibility', 'hidden'); });
        if (onPick) hit.addEventListener('click', () => onPick(n));
        svg.append(hit);
    });

    const wrap = document.createElement('div');
    wrap.className = 'sv-fc-wrap';
    wrap.append(svg, tip);

    // Table view — every value without a pointer.
    const det = document.createElement('details');
    det.className = 'sv-fc-table';
    const sum = document.createElement('summary');
    sum.textContent = 'Table';
    const table = document.createElement('table');
    const head = table.insertRow();
    for (const h of ['Night', `≥${forecast.minAltDeg}° in dark`, 'Hours', 'Peak', 'Moon']) {
        const th = document.createElement('th'); th.textContent = h; head.append(th);
    }
    for (const n of nights) {
        const row = table.insertRow();
        for (const v of [
            nightDate(n),
            n.windows.length ? `${shortClock(n.windows[0].start)}–${shortClock(n.windows[n.windows.length - 1].end)}` : '—',
            n.hours.toFixed(1),
            n.peakAltDeg != null ? `${Math.round(n.peakAltDeg)}°` : '—',
            `${Math.round(n.moonIllum * 100)}%`,
        ]) row.insertCell().textContent = v;
    }
    det.append(sum, table);
    host.append(wrap, det);
}
