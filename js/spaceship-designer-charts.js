/**
 * spaceship-designer-charts.js — the Flight Result's ASCENT PROFILE charts.
 *
 * Two halves:
 *   chartModel(result)   PURE: the series the charts draw, node-tested by
 *                        tests/spaceship-designer.mjs (phase segments, the
 *                        through-the-air window, the peaks — which must equal
 *                        the result's own headline numbers, so the chart and
 *                        the card can never disagree).
 *   renderAscentCharts   DOM: inline SVG + one hover layer.
 *
 * Forms (dataviz method): the trajectory is altitude vs downrange, coloured by
 * guidance phase (three categorical slots, legend + direct labels). The loads
 * are SMALL MULTIPLES on one shared x — altitude through the air — never a
 * dual axis: dynamic pressure, bending load q·α, and the wind the vehicle met
 * (along / cross track, same unit, so one chart). Limits are dashed reference
 * lines in muted ink, labelled; the one direct value label per chart is its
 * peak. Hover is a shared crosshair: one altitude, every multiple.
 *
 * Palette: slots 1–3 of the reference categorical order, DARK steps (this page
 * is dark-only), validated on the panel surface #0b1120 — worst adjacent CVD
 * ΔE 9.4, normal-vision 26.5, all ≥ 3:1. Text never wears a series colour.
 */

export const PHASES = [
    { id: 'ascent', name: 'Powered ascent', slot: 1 },
    { id: 'coast', name: 'Coast to apoapsis', slot: 2 },
    { id: 'circularize', name: 'Circularisation burn', slot: 3 },
];
const phaseOf = (p) => (p.phase === 'coast' ? 'coast' : p.phase === 'circularize' ? 'circularize' : 'ascent');

/** Altitude (km) by which q has fallen below 5 % of max-Q for good. */
function airWindowKm(traj, maxQ) {
    if (!(maxQ > 0)) return 0;
    let last = 0;
    for (const p of traj) if (p.q_kPa > 0.05 * maxQ) last = Math.max(last, p.alt_km);
    return niceCeil(last * 1.05);
}

/** Pure model of everything the charts draw. */
export function chartModel(result) {
    const traj = (result?.trajectory || []).filter((p) => Number.isFinite(p.alt_km) && Number.isFinite(p.downrange_km));
    // Trajectory: contiguous runs of one phase. Each run repeats the previous
    // run's last point so the line has no gap at a phase change.
    const segments = [];
    for (const p of traj) {
        const cur = segments[segments.length - 1];
        // The terminal 'done' sample belongs to whatever phase ended the flight.
        const ph = p.phase === 'done' && cur ? cur.phase : phaseOf(p);
        const pt = { x: Math.max(0, p.downrange_km), y: p.alt_km, t: p.t, v: p.v_kms, phase: ph };
        if (!cur || cur.phase !== ph) {
            const seg = { phase: ph, points: cur ? [cur.points[cur.points.length - 1]] : [] };
            seg.points.push(pt);
            segments.push(seg);
        } else cur.points.push(pt);
    }
    const staging = (result?.staging_events || []).map((e) => {
        const p = traj.reduce((b, q) => (Math.abs(q.t - e.t) < Math.abs(b.t - e.t) ? q : b), traj[0] || { t: 0 });
        return { stage: e.stage, t: e.t, x: Math.max(0, p?.downrange_km ?? 0), y: p?.alt_km ?? 0 };
    });

    // The two insertion events, so a 0.6 s trim burn is still SEEN.
    const firstOf = (ph) => segments.find((g) => g.phase === ph)?.points[1] ?? segments.find((g) => g.phase === ph)?.points[0];
    const ins = result?.insertion || {};
    const events = [];
    const meco = firstOf('coast');
    if (meco) events.push({ kind: 'meco', x: meco.x, y: meco.y, label: 'MECO-1' });
    const circ = firstOf('circularize');
    if (circ) events.push({ kind: 'circ', x: circ.x, y: circ.y,
        label: `circularise ${((ins.circ_dv_kms ?? 0) * 1000).toFixed(0)} m/s` });

    // Through the air: up to where q is gone, on the climb only (altitude is
    // the shared x, so it must be single-valued).
    const maxQ = result?.max_q_kPa ?? 0;
    const xMax = airWindowKm(traj, maxQ);
    const air = [];
    let hi = -Infinity;
    for (const p of traj) {
        if (p.alt_km > xMax) break;
        if (p.alt_km < hi) continue;          // a sag below a level already drawn
        hi = p.alt_km;
        air.push({ x: p.alt_km, t: p.t, q: p.q_kPa ?? 0, qa: p.qalpha ?? 0, alpha: p.alpha_deg ?? 0,
                   along: p.wind_along_ms ?? 0, cross: p.wind_cross_ms ?? 0, mach: p.mach ?? 0 });
    }
    // Peaks are the RESULT's own (every integrator step), not re-derived from
    // the 1 s samples — so the label on the chart is the number on the card.
    const L = result?.loads;
    return {
        segments, staging, events,
        target_km: result?.target_alt_km ?? null,
        hasAir: xMax > 0 && air.length > 2,
        air, airMax_km: xMax,
        q: { limit: result?.q_limit_kPa || null, peak: maxQ > 0 ? { x: result.max_q_alt_km, q: maxQ } : null },
        qa: { limit: L?.limit_kPa_deg ?? null, peak: L?.max_qalpha_kPa_deg > 0 ? { x: L.alt_km, qa: L.max_qalpha_kPa_deg } : null },
        wind: { setting: result?.loads?.wind ?? null },
    };
}

// ── Scales + ticks ──────────────────────────────────────────────────────────
export function niceCeil(x) {
    if (!(x > 0)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(x)));
    for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * e >= x - 1e-9) return m * e;
    return 10 * e;
}
export function ticks(lo, hi, n = 4) {
    const span = hi - lo;
    if (!(span > 0)) return [lo];
    const raw = span / n, e = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * e).find((s) => s >= raw) || 10 * e;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(10));
    return out;
}
/** Ticks for a √ axis: round numbers, spaced ≥ 9 % of the width in √-space. */
export function sqrtTicks(max) {
    const cand = [0, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 20000, 40000, 80000];
    const out = [];
    for (const v of cand) {
        if (v > max * 1.0001) break;
        if (!out.length || Math.sqrt(v / max) - Math.sqrt(out[out.length - 1] / max) >= 0.09) out.push(v);
    }
    return out;
}
const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(0) : +v.toFixed(1) + '');

// ── SVG ─────────────────────────────────────────────────────────────────────
const W = 640, M = { l: 46, r: 14, t: 14, b: 28 };

function frame(h, xs, ys, xLabel, yLabel, { sqrtX = false } = {}) {
    const pw = W - M.l - M.r, ph = h - M.t - M.b;
    const X = sqrtX
        ? (v) => M.l + Math.sqrt(Math.max(0, v) / xs[1]) * pw
        : (v) => M.l + ((v - xs[0]) / (xs[1] - xs[0])) * pw;
    const Y = (v) => M.t + ph - ((v - ys[0]) / (ys[1] - ys[0])) * ph;
    let g = '';
    for (const v of ticks(ys[0], ys[1], 4)) {
        g += `<line class="grid" x1="${M.l}" x2="${W - M.r}" y1="${Y(v)}" y2="${Y(v)}"/>`
           + `<text class="tick" x="${M.l - 6}" y="${Y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`;
    }
    for (const v of (sqrtX ? sqrtTicks(xs[1]) : ticks(xs[0], xs[1], 6))) {
        g += `<text class="tick" x="${X(v)}" y="${h - M.b + 15}" text-anchor="middle">${fmt(v)}</text>`;
    }
    g += `<line class="axis" x1="${M.l}" x2="${W - M.r}" y1="${M.t + ph}" y2="${M.t + ph}"/>`;
    g += `<text class="axlab" x="${W - M.r}" y="${h - 2}" text-anchor="end">${xLabel}</text>`;
    g += `<text class="axlab" x="${M.l - 40}" y="${M.t - 3}">${yLabel}</text>`;
    return { X, Y, g, pw, ph };
}
const path = (pts, X, Y, fx, fy) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(fx(p)).toFixed(1)},${Y(fy(p)).toFixed(1)}`).join('');

function refLine(f, y, label) {
    return `<line class="ref" x1="${M.l}" x2="${W - M.r}" y1="${f.Y(y)}" y2="${f.Y(y)}"/>`
         + `<text class="reflab" x="${W - M.r - 2}" y="${f.Y(y) - 4}" text-anchor="end">${label}</text>`;
}

function trajectorySvg(m) {
    const pts = m.segments.flatMap((s) => s.points);
    const xMax = niceCeil(Math.max(1, ...pts.map((p) => p.x)));
    const yMax = niceCeil(Math.max(1, m.target_km || 0, ...pts.map((p) => p.y)) * 1.08);
    const h = 220;
    // √ downrange: a 45-minute coast carries the vehicle 20 000 km downrange
    // while the climb happens in the first few hundred — on a linear axis the
    // whole ascent is a vertical line against the left edge.
    const f = frame(h, [0, xMax], [0, yMax], 'downrange (km, √ scale)', 'altitude (km)', { sqrtX: true });
    let s = f.g;
    if (m.target_km) s += refLine(f, m.target_km, `target ${m.target_km} km`);
    for (const seg of m.segments) {
        const slot = PHASES.find((p) => p.id === seg.phase)?.slot || 1;
        s += `<path class="line s${slot}" d="${path(seg.points, f.X, f.Y, (p) => p.x, (p) => p.y)}"/>`;
    }
    for (const e of m.events) {
        const cx = f.X(e.x), cy = f.Y(e.y);
        const left = cx > W - M.r - 150;
        s += `<circle class="mk" cx="${cx}" cy="${cy}" r="4"/>`
           + `<text class="lab" x="${cx + (left ? -8 : 8)}" y="${cy + 15}" text-anchor="${left ? 'end' : 'start'}">${e.label}</text>`;
    }
    for (const e of m.staging) {
        s += `<circle class="mk" cx="${f.X(e.x)}" cy="${f.Y(e.y)}" r="4"/>`
           + `<text class="lab" x="${f.X(e.x) + 7}" y="${f.Y(e.y) + 12}">S${e.stage} sep</text>`;
    }
    return { svg: s, h, f, pts };
}

function multipleSvg(m, key, unit, title, limit, extra = '') {
    const h = 150;
    const pk0 = m[key === 'q' ? 'q' : 'qa'].peak;
    const vals = m.air.map((p) => p[key]).concat(pk0 ? [pk0[key]] : []);
    const yMax = niceCeil(Math.max(1e-6, ...vals, limit ? limit * 1.1 : 0));
    const f = frame(h, [0, m.airMax_km], [0, yMax], 'altitude (km)', `${title} (${unit})`);
    let s = f.g;
    if (limit) s += refLine(f, limit, `limit ${fmt(limit)}`);
    s += `<path class="line s1" d="${path(m.air, f.X, f.Y, (p) => p.x, (p) => p[key])}"/>`;
    const pk = m[key === 'q' ? 'q' : 'qa'].peak;
    if (pk) {
        const cx = f.X(pk.x), cy = f.Y(pk[key]);
        s += `<circle class="mk s1" cx="${cx}" cy="${cy}" r="4"/>`
           + `<text class="lab" x="${cx + 7}" y="${cy - 6}">max ${fmt(pk[key])} ${unit} at ${pk.x.toFixed(1)} km</text>`;
    }
    return { svg: s + extra, h, f };
}

function windSvg(m) {
    const h = 150;
    const vals = m.air.flatMap((p) => [p.along, p.cross]);
    const lim = niceCeil(Math.max(5, ...vals.map(Math.abs)));
    const f = frame(h, [0, m.airMax_km], [-lim, lim], 'altitude (km)', 'wind met (m/s)');
    let s = f.g + `<line class="zero" x1="${M.l}" x2="${W - M.r}" y1="${f.Y(0)}" y2="${f.Y(0)}"/>`;
    s += `<path class="line s1" d="${path(m.air, f.X, f.Y, (p) => p.x, (p) => p.along)}"/>`;
    s += `<path class="line s2" d="${path(m.air, f.X, f.Y, (p) => p.x, (p) => p.cross)}"/>`;
    // Direct labels at the right end (≤ 4 series: legend AND labels).
    const last = m.air[m.air.length - 1];
    if (last) {
        const ya = f.Y(last.along), yc = f.Y(last.cross);
        const sep = Math.abs(ya - yc) < 14 ? (ya <= yc ? -7 : 7) : 0;
        s += `<text class="lab" x="${W - M.r - 2}" y="${ya - 5 + sep}" text-anchor="end">along track</text>`;
        s += `<text class="lab" x="${W - M.r - 2}" y="${yc - 5 - sep}" text-anchor="end">cross track</text>`;
    }
    return { svg: s, h, f };
}

const legend = (items) => `<div class="ssd-viz-legend">${items.map(([slot, name]) =>
    `<span><i class="sw s${slot}"></i>${name}</span>`).join('')}</div>`;

/**
 * Render into `el`. Returns the model (handy for tests and debugging).
 */
export function renderAscentCharts(el, result) {
    const m = chartModel(result);
    if (!m.segments.length) { el.innerHTML = ''; return m; }
    const tr = trajectorySvg(m);
    const usedPhases = PHASES.filter((p) => m.segments.some((s) => s.phase === p.id));
    let html = `<figure class="ssd-viz"><figcaption>Trajectory — the shape of the climb</figcaption>
      ${legend(usedPhases.map((p) => [p.slot, p.name]))}
      <svg viewBox="0 0 ${W} ${tr.h}" role="img" aria-label="Altitude against downrange distance, coloured by guidance phase" data-chart="trajectory">${tr.svg}
        <g class="hover" visibility="hidden"><circle class="hv" r="5"/></g>
        <rect class="hit" x="${M.l}" y="${M.t}" width="${tr.f.pw}" height="${tr.f.ph}"/></svg></figure>`;
    let multiples = [];
    if (m.hasAir) {
        multiples = [
            multipleSvg(m, 'q', 'kPa', 'dynamic pressure q', m.q.limit),
            multipleSvg(m, 'qa', 'kPa·°', 'bending load q·α', m.qa.limit),
            windSvg(m),
        ];
        const names = ['q', 'qa', 'wind'];
        html += `<figure class="ssd-viz"><figcaption>Through the air — loads on the airframe and the wind that made them</figcaption>
          ${multiples.map((c, i) => `${i === 2 ? legend([[1, 'along track (+ = tailwind)'], [2, 'cross track']]) : ''}<svg viewBox="0 0 ${W} ${c.h}" role="img" data-chart="${names[i]}"
             aria-label="${['Dynamic pressure', 'Bending load q times alpha', 'Wind along and across the track'][i]} against altitude">${c.svg}
             <line class="xhair" visibility="hidden" y1="${M.t}" y2="${c.h - M.b}"/>
             <rect class="hit" x="${M.l}" y="${M.t}" width="${c.f.pw}" height="${c.f.ph}"/></svg>`).join('')}
          <div class="ssd-note">Winds are a REPRESENTATIVE profile for this world plus seeded turbulence — not a forecast.
            The steering flies into the wind it has measured (2.5 s loop); q·α is what it could not fly out.</div></figure>`;
    }
    html += `<details class="ssd-viz-table"><summary>Data table</summary>${dataTable(result)}</details>`;
    html += `<div class="ssd-viz-tip" hidden></div>`;
    el.innerHTML = html;

    // ── Hover ─────────────────────────────────────────────────────────────
    const tip = el.querySelector('.ssd-viz-tip');
    const place = (evt, text) => {
        tip.hidden = false; tip.textContent = '';
        for (const line of text) { const d = document.createElement('div'); d.textContent = line; tip.appendChild(d); }
        const box = el.getBoundingClientRect();
        tip.style.left = Math.min(box.width - 190, evt.clientX - box.left + 12) + 'px';
        tip.style.top = (evt.clientY - box.top + 12) + 'px';
    };
    const svgX = (svg, evt) => {
        const r = svg.getBoundingClientRect();
        return ((evt.clientX - r.left) / r.width) * W;
    };
    const tsvg = el.querySelector('svg[data-chart="trajectory"]');
    const tHit = tsvg.querySelector('.hit'), hov = tsvg.querySelector('.hover'), dot = tsvg.querySelector('.hv');
    tHit.addEventListener('pointermove', (evt) => {
        const xv = svgX(tsvg, evt);
        const p = tr.pts.reduce((b, q) => (Math.abs(tr.f.X(q.x) - xv) < Math.abs(tr.f.X(b.x) - xv) ? q : b), tr.pts[0]);
        dot.setAttribute('cx', tr.f.X(p.x)); dot.setAttribute('cy', tr.f.Y(p.y));
        hov.setAttribute('visibility', 'visible');
        place(evt, [`T+${p.t.toFixed(0)} s · ${PHASES.find((x) => x.id === p.phase).name}`,
            `altitude ${p.y.toFixed(1)} km`, `downrange ${p.x.toFixed(0)} km`, `speed ${(p.v ?? 0).toFixed(2)} km/s`]);
    });
    tHit.addEventListener('pointerleave', () => { hov.setAttribute('visibility', 'hidden'); tip.hidden = true; });

    if (multiples.length) {
        const svgs = [...el.querySelectorAll('svg[data-chart="q"], svg[data-chart="qa"], svg[data-chart="wind"]')];
        const f0 = multiples[0].f;
        const show = (evt, svg) => {
            const xv = svgX(svg, evt);
            const p = m.air.reduce((b, q) => (Math.abs(f0.X(q.x) - xv) < Math.abs(f0.X(b.x) - xv) ? q : b), m.air[0]);
            for (const s of svgs) {
                const l = s.querySelector('.xhair');
                l.setAttribute('x1', f0.X(p.x)); l.setAttribute('x2', f0.X(p.x)); l.setAttribute('visibility', 'visible');
            }
            place(evt, [`${p.x.toFixed(1)} km · T+${p.t.toFixed(0)} s · Mach ${p.mach.toFixed(2)}`,
                `q ${p.q.toFixed(1)} kPa`, `q·α ${p.qa.toFixed(0)} kPa·° (α ${p.alpha.toFixed(2)}°)`,
                `wind ${p.along.toFixed(0)} along · ${p.cross.toFixed(0)} cross m/s`]);
        };
        for (const s of svgs) {
            const hit = s.querySelector('.hit');
            hit.addEventListener('pointermove', (evt) => show(evt, s));
            hit.addEventListener('pointerleave', () => {
                for (const s2 of svgs) s2.querySelector('.xhair').setAttribute('visibility', 'hidden');
                tip.hidden = true;
            });
        }
    }
    return m;
}

function dataTable(result) {
    const rows = [];
    let next = 0;
    for (const p of result.trajectory || []) {
        if (p.t + 1e-6 < next && !p.final) continue;
        next = p.t + (p.alt_km < 80 ? 10 : 60);
        rows.push(`<tr><td class="n">${p.t.toFixed(0)}</td><td>${PHASES.find((x) => x.id === phaseOf(p)).name}</td>
          <td class="n">${p.alt_km.toFixed(1)}</td><td class="n">${Math.max(0, p.downrange_km).toFixed(0)}</td>
          <td class="n">${p.v_kms.toFixed(2)}</td><td class="n">${(p.q_kPa ?? 0).toFixed(1)}</td>
          <td class="n">${(p.qalpha ?? 0).toFixed(0)}</td></tr>`);
    }
    return `<table class="ssd-table"><thead><tr><th class="n">T+ (s)</th><th>Phase</th><th class="n">Alt (km)</th>
      <th class="n">Downrange (km)</th><th class="n">Speed (km/s)</th><th class="n">q (kPa)</th><th class="n">q·α (kPa·°)</th></tr></thead>
      <tbody>${rows.join('')}</tbody></table>`;
}
