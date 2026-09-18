/**
 * neo-watch/panels.js — the readouts for neo-watch.html
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE-FREE ON PURPOSE. Every number printed here is a field of a row that
 * js/neo-space.js `buildObjectRow` already derived, or a field of a JPL feed
 * row exactly as `/api/neo/watch` shipped it. This module formats and nothing
 * else — so a distance in a table and the same distance on the stage cannot
 * disagree, and so the whole readout layer stays testable without a GPU.
 *
 * ── The honesty rules this file enforces ──────────────────────────────────
 *  1. A FEED THAT IS DOWN LOOKS DOWN. Each panel takes a `state` of
 *     'live' | 'stale' | 'loading' | 'down' and renders the empty case as a
 *     stated reason, never as an empty table that reads like "nothing is
 *     happening". A quiet sky and a dead feed are different claims.
 *  2. OURS AND THEIRS ARE LABELLED. The close-approach table is JPL's
 *     integrated orbits; the live board is our two-body propagation. Where
 *     both exist for one object the disagreement is printed, because that is
 *     the honest way to draw a flyby at all (neo-space.js `compareApproach`).
 *  3. AN ESTIMATE SAYS IT IS ONE. Sizes derived from absolute magnitude carry
 *     the albedo assumption; magnitudes past the H,G fit limit are absent
 *     rather than extrapolated; comets get no H,G magnitude at all.
 */

import { formatRelativeTime, impactEnergy, DENSITY, LD_KM, AU_KM } from '../neo-space.js';

/** Lunar distance in AU — the unit every miss distance here is printed in. */
const LD_IN_AU = LD_KM / AU_KM;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

/** The one place an empty panel decides what it is allowed to say. */
export function emptyState(state, emptyMessage) {
    if (state === 'loading') return '<p class="nw-empty">Loading…</p>';
    if (state === 'down') return '<p class="nw-empty nw-empty--down">Feed unavailable — nothing is listed rather than a guess.</p>';
    if (state === 'stale') return '<p class="nw-empty nw-empty--down">Feed degraded upstream — this list may be incomplete.</p>';
    return `<p class="nw-empty">${esc(emptyMessage)}</p>`;
}

/** Colour band for a row, by what the object is. */
function rowClass(row) {
    if (row.isInterstellar) return 'nw-row--interstellar';
    if (row.isComet) return 'nw-row--comet';
    if (row.isPHA) return 'nw-row--pha';
    return '';
}

function tagFor(row) {
    if (row.isInterstellar) return '<span class="nw-tag nw-tag--interstellar">interstellar</span>';
    if (row.isComet) return '<span class="nw-tag nw-tag--comet">comet</span>';
    if (row.isPHA) return '<span class="nw-tag nw-tag--pha">PHA</span>';
    return '';
}

/**
 * The live board: what is nearest to Earth right now, by our own propagation.
 * `rows` are `buildObjectRow` outputs, already sorted.
 */
export function renderNearest(el, rows, { state = 'live', selected = null, observer = null } = {}) {
    if (!rows || !rows.length) {
        el.innerHTML = emptyState(state, 'Nothing inside the view horizon at this instant.');
        return;
    }
    const head = `
        <tr>
            <th>Object</th><th class="nw-num">Distance</th><th class="nw-num">Size</th>
            <th class="nw-num">Mag</th>${observer ? '<th class="nw-num">Alt</th>' : ''}
        </tr>`;
    const body = rows.map((r) => {
        const sel = r.index === selected ? ' nw-row--sel' : '';
        const up = r.sky ? (r.sky.up
            ? `<span class="nw-up">${num(r.sky.altDeg, 0)}°&nbsp;${esc(r.sky.compass)}</span>`
            : `<span class="nw-down">below</span>`) : '—';
        return `
        <tr class="nw-row ${rowClass(r)}${sel}" data-index="${r.index}" tabindex="0">
            <td class="nw-name">${esc(r.name)} ${tagFor(r)}</td>
            <td class="nw-num">${esc(r.distLabel)}</td>
            <td class="nw-num" title="${esc(r.sizeSource || '')}">${esc(r.sizeLabel)}</td>
            <td class="nw-num">${r.mag == null ? '—' : num(r.mag, 1)}</td>
            ${observer ? `<td class="nw-num">${up}</td>` : ''}
        </tr>`;
    }).join('');
    el.innerHTML = `<table class="nw-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/**
 * JPL's close-approach table. This is the authoritative list — our two-body
 * propagation draws where things are BETWEEN these rows and never decides
 * which rows exist.
 */
export function renderApproaches(el, approaches, { state = 'live', nowMs = Date.now(), selectedDes = null } = {}) {
    if (!approaches || !approaches.length) {
        el.innerHTML = emptyState(state, 'No catalogued approach inside 0.05 AU in the window.');
        return;
    }
    const body = approaches.map((a) => {
        const dDays = (a.t_ms - nowMs) / 86400e3;
        const ld = a.dist_au / LD_IN_AU;
        const sel = a.des === selectedDes ? ' nw-row--sel' : '';
        const closest = ld < 1 ? ' nw-row--pha' : '';
        return `
        <tr class="nw-row${closest}${sel}" data-des="${esc(a.des)}" data-t="${a.t_ms}" tabindex="0">
            <td class="nw-name">${esc(a.name || a.des)}</td>
            <td class="nw-num">${esc(formatRelativeTime(dDays))}</td>
            <td class="nw-num">${num(ld, 2)} LD</td>
            <td class="nw-num">${num(a.v_rel_kms, 1)} km/s</td>
            <td class="nw-num">${a.H == null ? '—' : num(a.H, 1)}</td>
        </tr>`;
    }).join('');
    el.innerHTML = `
        <table class="nw-table">
            <thead><tr><th>Object</th><th class="nw-num">When</th><th class="nw-num">Miss</th>
            <th class="nw-num">Speed</th><th class="nw-num">H</th></tr></thead>
            <tbody>${body}</tbody>
        </table>`;
}

/**
 * The impact monitor. Torino first, then cumulative Palermo — JPL's own sort.
 * The energy column is computed here from the published diameter and v∞ and
 * is labelled as the estimate it is.
 */
export function renderSentry(el, objects, { state = 'live', total = 0 } = {}) {
    if (!objects || !objects.length) {
        el.innerHTML = emptyState(state, 'No object on the risk list.');
        return;
    }
    const body = objects.slice(0, 12).map((o) => {
        const e = impactEnergy(o.diam_km, o.v_inf_kms, DENSITY.stony);
        const torino = o.ts_max > 0 ? `<span class="nw-torino">Torino ${o.ts_max}</span>` : '';
        return `
        <tr class="nw-row${o.ts_max > 0 ? ' nw-row--pha' : ''}">
            <td class="nw-name">${esc(o.name || o.des)} ${torino}</td>
            <td class="nw-num">${o.ip == null ? '—' : `1 in ${Math.round(1 / o.ip).toLocaleString('en-US')}`}</td>
            <td class="nw-num">${o.ps_cum == null ? '—' : num(o.ps_cum, 2)}</td>
            <td class="nw-num">${e ? `${num(e.megatons, e.megatons < 10 ? 1 : 0)} Mt` : '—'}</td>
        </tr>`;
    }).join('');
    el.innerHTML = `
        <table class="nw-table">
            <thead><tr><th>Object</th><th class="nw-num">Odds</th>
            <th class="nw-num">Palermo</th><th class="nw-num">Energy</th></tr></thead>
            <tbody>${body}</tbody>
        </table>
        <p class="nw-note">${objects.length} of ${total} tracked objects shown, highest Torino/Palermo first.
        Energy assumes a ${DENSITY.stony} kg/m³ stony body at the published v∞ — an order-of-magnitude figure.</p>`;
}

/** Bolides that actually arrived, newest first, each drawn on the globe. */
export function renderFireballs(el, events, { state = 'live', nowMs = Date.now() } = {}) {
    if (!events || !events.length) {
        el.innerHTML = emptyState(state, 'No bolide reported in the current window.');
        return;
    }
    const body = events.slice(0, 10).map((f) => {
        const dDays = (f.t_ms - nowMs) / 86400e3;
        const where = (Number.isFinite(f.lat) && Number.isFinite(f.lon))
            ? `${Math.abs(f.lat).toFixed(1)}°${f.lat < 0 ? 'S' : 'N'} ${Math.abs(f.lon).toFixed(1)}°${f.lon < 0 ? 'W' : 'E'}`
            : 'position not reported';
        return `
        <tr class="nw-row">
            <td class="nw-name">${esc(where)}</td>
            <td class="nw-num">${esc(formatRelativeTime(dDays))}</td>
            <td class="nw-num">${f.impact_kt == null ? '—' : `${num(f.impact_kt, f.impact_kt < 1 ? 2 : 1)} kt`}</td>
            <td class="nw-num">${f.vel_kms == null ? '—' : `${num(f.vel_kms, 1)} km/s`}</td>
        </tr>`;
    }).join('');
    el.innerHTML = `
        <table class="nw-table">
            <thead><tr><th>Where</th><th class="nw-num">When</th>
            <th class="nw-num">Energy</th><th class="nw-num">Speed</th></tr></thead>
            <tbody>${body}</tbody>
        </table>
        <p class="nw-note">US Government sensor detections, pinned on the globe at the reported
        latitude and longitude. Energy is the total impact energy in kilotons TNT.</p>`;
}

/**
 * The selected object's card. `row` is a `buildObjectRow` output; `approach`
 * is the matching JPL CAD row when there is one, and `comparison` is
 * neo-space.js `compareApproach` — the disagreement between the two, printed
 * rather than hidden.
 */
export function renderSelected(el, row, { approach = null, comparison = null, nowMs = Date.now() } = {}) {
    if (!row) {
        el.innerHTML = '<p class="nw-empty">Click an object on the stage, or a row in any list.</p>';
        return;
    }
    const stat = (label, value, title = '') =>
        `<div class="nw-stat" ${title ? `title="${esc(title)}"` : ''}>
            <span class="nw-stat-k">${esc(label)}</span><span class="nw-stat-v">${value}</span></div>`;

    const parts = [
        `<h3 class="nw-sel-name">${esc(row.name)} ${tagFor(row)}</h3>`,
        row.classLabel ? `<p class="nw-sel-class">${esc(row.classLabel)}</p>` : '',
        '<div class="nw-stats">',
        stat('Distance', esc(row.distLabel), `${row.distLD.toFixed(3)} lunar distances`),
        stat('Size', esc(row.sizeLabel), row.sizeSource || ''),
        stat('Magnitude', row.mag == null ? '—' : `${row.mag.toFixed(1)}${row.magBand ? ` · ${esc(row.magBand.label)}` : ''}`, row.magNote || ''),
        stat('RA / Dec', esc(row.raDecLabel), 'J2000, geocentric'),
        row.sky ? stat('Altitude', row.sky.up
            ? `${row.sky.altDeg.toFixed(0)}° ${esc(row.sky.compass)}`
            : `below horizon (${row.sky.altDeg.toFixed(0)}°)`, 'topocentric, equinox of date') : '',
        row.rateDegPerHour != null ? stat('Sky motion', `${row.rateDegPerHour.toFixed(2)}°/h`) : '',
        row.angularArcsec != null && row.angularArcsec > 0.001
            ? stat('Angular size', `${row.angularArcsec.toFixed(3)}″`) : '',
        row.moid != null ? stat('Earth MOID', `${(row.moid / LD_IN_AU).toFixed(2)} LD`,
            'Minimum orbit intersection distance — the closest the two ORBITS come, not the object') : '',
        '</div>',
    ];

    if (approach) {
        const ld = approach.dist_au / LD_IN_AU;
        parts.push(`<div class="nw-approach">
            <h4>JPL close approach</h4>
            <p><strong>${esc(formatRelativeTime((approach.t_ms - nowMs) / 86400e3))}</strong> ·
            ${ld.toFixed(3)} LD · ${num(approach.v_rel_kms, 1)} km/s</p>`);
        if (comparison) {
            // The point of this block: OUR number next to THEIRS. Two-body
            // propagation of osculating elements drifts, most of all across an
            // encounter, and saying so is the only honest way to draw one.
            const dl = comparison.dDistLD;
            parts.push(`<p class="nw-compare">
                Our two-body pass: <strong>${comparison.oursAU / LD_IN_AU < 100
                    ? (comparison.oursAU / LD_IN_AU).toFixed(3) + ' LD' : '—'}</strong>,
                ${Math.abs(dl) < 0.005 ? 'agreeing with' : `${Math.abs(dl).toFixed(3)} LD ${dl > 0 ? 'wide of' : 'inside'}`}
                JPL's integrated orbit${comparison.dTimeHours != null
                    ? `, ${Math.abs(comparison.dTimeHours).toFixed(1)} h ${comparison.dTimeHours > 0 ? 'late' : 'early'}` : ''}.
                JPL's is the one to believe.</p>`);
        }
        parts.push('</div>');
    }

    if (row.elementsNote) parts.push(`<p class="nw-note">${esc(row.elementsNote)}.</p>`);
    if (row.magNote) parts.push(`<p class="nw-note">${esc(row.magNote)}.</p>`);
    el.innerHTML = parts.join('');
}

/** A short line naming what each feed is currently doing. */
export function renderFeedChips(el, feeds) {
    el.innerHTML = feeds.map((f) => {
        const cls = f.state === 'live' ? 'nw-chip--live'
            : f.state === 'loading' ? 'nw-chip--loading' : 'nw-chip--down';
        return `<span class="nw-chip ${cls}" title="${esc(f.detail || '')}">${esc(f.label)}: ${esc(f.text)}</span>`;
    }).join('');
}
