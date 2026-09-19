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

import {
    formatRelativeTime, impactEnergy, DENSITY, LD_KM, AU_KM,
    hillRadiusKm, soiRadiusKm, escapeSpeedKms, REGIME_LABELS, formatGeoDistance,
} from '../neo-space.js';

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

/** Altitude cell content for a row — the one dynamic column that has markup. */
function altCell(r) {
    if (!r.sky) return '—';
    return r.sky.up
        ? `<span class="nw-up">${num(r.sky.altDeg, 0)}°&nbsp;${esc(r.sky.compass)}</span>`
        : '<span class="nw-down">below</span>';
}

/**
 * The live board: what is nearest to Earth right now, by our own propagation.
 * `rows` are `buildObjectRow` outputs, already sorted.
 *
 * IT UPDATES IN PLACE. The board redraws three times a second, and rebuilding
 * the table's innerHTML each time detaches every `<tr>` under the cursor: a
 * click that lands between two redraws hits a node that is already gone, which
 * Playwright reports as "element was detached from the DOM, retrying" and a
 * visitor experiences as a row that sometimes just does not respond. So the
 * DOM is rebuilt ONLY when the set of rows or their order changes, and the
 * numbers are written into the existing cells otherwise. Same rule, and the
 * same reason, as the EarthView verdict card's stable-header split
 * (CLAUDE.md §4.4).
 */
export function renderNearest(el, rows, { state = 'live', selected = null, observer = null } = {}) {
    if (!rows || !rows.length) {
        el.dataset.nwSig = '';
        el.innerHTML = emptyState(state, 'Nothing inside the view horizon at this instant.');
        return;
    }

    // The signature covers everything the MARKUP depends on: which objects, in
    // what order, and whether the altitude column exists at all.
    const sig = `${observer ? 'o' : '-'}|${rows.map(r => r.index).join(',')}`;
    const body = el.querySelector('tbody');

    if (body && el.dataset.nwSig === sig && body.children.length === rows.length) {
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const tr = body.children[i];
            const td = tr.children;
            // Name and size are fixed for a given object; distance, magnitude
            // and altitude are not.
            td[1].textContent = r.distLabel;
            td[2].textContent = r.vGeoKms == null ? '—' : `${r.vGeoKms.toFixed(1)}`;
            td[4].textContent = r.mag == null ? '—' : num(r.mag, 1);
            if (observer && td[5]) td[5].innerHTML = altCell(r);
            tr.classList.toggle('nw-row--sel', r.index === selected);
        }
        return;
    }

    const head = `
        <tr>
            <th>Object</th><th class="nw-num">Distance</th><th class="nw-num">Speed</th>
            <th class="nw-num">Size</th><th class="nw-num">Mag</th>${observer ? '<th class="nw-num">Alt</th>' : ''}
        </tr>`;
    const html = rows.map((r) => {
        const sel = r.index === selected ? ' nw-row--sel' : '';
        return `
        <tr class="nw-row ${rowClass(r)}${sel}" data-index="${r.index}" tabindex="0">
            <td class="nw-name">${esc(r.name)} ${tagFor(r)}</td>
            <td class="nw-num">${esc(r.distLabel)}</td>
            <td class="nw-num" title="geocentric speed, km/s">${r.vGeoKms == null ? '—' : r.vGeoKms.toFixed(1)}</td>
            <td class="nw-num" title="${esc(r.sizeSource || '')}">${esc(r.sizeLabel)}</td>
            <td class="nw-num">${r.mag == null ? '—' : num(r.mag, 1)}</td>
            ${observer ? `<td class="nw-num">${altCell(r)}</td>` : ''}
        </tr>`;
    }).join('');
    el.dataset.nwSig = sig;
    el.innerHTML = `<table class="nw-table"><thead>${head}</thead><tbody>${html}</tbody></table>`;
}

/**
 * JPL's close-approach table. This is the authoritative list — our two-body
 * propagation draws where things are BETWEEN these rows and never decides
 * which rows exist.
 */
export function renderApproaches(el, approaches, { state = 'live', nowMs = Date.now(), selectedDes = null } = {}) {
    if (!approaches || !approaches.length) {
        el.dataset.nwSig = '';
        el.innerHTML = emptyState(state, 'No catalogued approach inside 0.05 AU in the window.');
        return;
    }

    // In place while the list is the same list — see renderNearest. Only the
    // "when" column and the selection change as the clock moves.
    const sig = approaches.map(a => a.des).join(',');
    const tbody = el.querySelector('tbody');
    if (tbody && el.dataset.nwSig === sig && tbody.children.length === approaches.length) {
        for (let i = 0; i < approaches.length; i++) {
            const a = approaches[i];
            const tr = tbody.children[i];
            tr.children[1].textContent = formatRelativeTime((a.t_ms - nowMs) / 86400e3);
            tr.classList.toggle('nw-row--sel', a.des === selectedDes);
        }
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
    el.dataset.nwSig = sig;
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

/**
 * The Moon card. Everything here is the kernel's (`moonPhase`, `moonApsides`)
 * — this renders it and derives nothing.
 *
 * The Moon earns a card of its own rather than a row in the board because it
 * is the stage's RULER: it is the one object a visitor already has a distance
 * intuition for, so its numbers are what make the compressed radial map
 * readable at all.
 */
export function renderMoon(el, phase, apsides, { jd = null } = {}) {
    if (!el) return;
    if (!phase) { el.innerHTML = emptyState('loading', ''); return; }

    const stat = (k, v, title = '') =>
        `<div class="nw-stat" ${title ? `title="${esc(title)}"` : ''}>
            <span class="nw-stat-k">${esc(k)}</span><span class="nw-stat-v">${v}</span></div>`;

    // A little disc that shows the actual phase, drawn from the illuminated
    // fraction and the waxing flag — the same two numbers the text quotes, so
    // the picture and the words cannot disagree.
    const f = Math.max(0, Math.min(1, phase.illuminated));
    const rx = Math.abs(1 - 2 * f) * 13;
    const sweepOuter = phase.waxing ? 1 : 0;
    const sweepInner = (f > 0.5) === phase.waxing ? 1 : 0;
    const disc = `
        <svg class="nw-moon-disc" viewBox="0 0 30 30" width="30" height="30" aria-hidden="true">
            <circle cx="15" cy="15" r="13" fill="#1b1f2e"/>
            ${f > 0.004 ? `<path d="M15 2 A 13 13 0 0 ${sweepOuter} 15 28 A ${rx.toFixed(2)} 13 0 0 ${sweepInner} 15 2 Z" fill="#d8d5cc"/>` : ''}
            <circle cx="15" cy="15" r="13" fill="none" stroke="rgba(216,213,204,.35)"/>
        </svg>`;

    const rows = [
        `<div class="nw-moon-head">${disc}
            <div>
                <div class="nw-moon-name">${esc(phase.name)}</div>
                <div class="nw-moon-sub">${(phase.illuminated * 100).toFixed(0)}% lit ·
                ${phase.ageDays.toFixed(1)} d into the lunation ·
                ${phase.waxing ? 'waxing' : 'waning'}</div>
            </div>
        </div>`,
        '<div class="nw-stats">',
        stat('Distance', `${Math.round(phase.distKm).toLocaleString('en-US')} km`,
            `${(phase.distKm / LD_KM).toFixed(4)} lunar distances — this IS the lunar distance`),
        stat('Apparent size', `${(phase.angularDiameterDeg * 60).toFixed(1)}′`, 'angular diameter as seen from Earth’s centre'),
        stat('Elongation', `${phase.elongationDeg.toFixed(0)}°`, 'Sun–Earth–Moon angle: how far from the Sun in the sky'),
        stat('Phase angle', `${phase.phaseAngleDeg.toFixed(0)}°`, 'Sun–Moon–Earth angle: the argument of the illumination law'),
        '</div>',
    ];

    if (apsides?.perigee && apsides?.apogee) {
        const when = (a) => (jd == null ? '' : ` ${formatRelativeTime(a.jd - jd)}`);
        rows.push(`<p class="nw-note">
            Next <b>perigee</b> ${Math.round(apsides.perigee.km).toLocaleString('en-US')} km${when(apsides.perigee)} ·
            <b>apogee</b> ${Math.round(apsides.apogee.km).toLocaleString('en-US')} km${when(apsides.apogee)}.
            Both are marked on the drawn path; they differ by
            ${(100 * (apsides.apogee.km / apsides.perigee.km - 1)).toFixed(0)}%, which is what a circle would hide.
        </p>`);
    }
    rows.push(`<p class="nw-note">
        Drawn at true size relative to Earth (radius ratio 0.273) and lit by the
        Lommel–Seeliger law, so the phase on the stage is the real Sun direction
        rather than a drawn crescent. The disc above follows the northern-hemisphere
        convention — lit limb to the right while waxing; from the southern
        hemisphere it appears the other way up. Position and path are Meeus ch. 47,
        good to about 100 km.
    </p>`);
    el.innerHTML = rows.join('');
}

/**
 * EARTH'S GRAVITATIONAL REACH — the page's answer to "what could actually get
 * here", and to where its own model stops being the right one.
 *
 * Three questions, three different kinds of answer, and the card keeps them
 * apart because conflating them is the whole trap:
 *
 *   WHERE IS THE BOUNDARY   pure physics from the live Earth distance. Certain.
 *   WHO IS INSIDE IT NOW    our two-body propagation. Good far out, and
 *                           explicitly NOT good inside the SOI, which the card
 *                           says out loud rather than quietly drawing anyway.
 *   WHO COULD EVER BE       the Earth MOID — a property of the ORBITS, so it is
 *                           a hard filter over the whole catalogue and says
 *                           nothing at all about timing.
 */
export function renderGravity(el, { earthRAU = 1, nearest = null, inside = [], screen = null, tierLabel = '', state = 'live' } = {}) {
    if (!el) return;
    const hillKm = hillRadiusKm(earthRAU);
    const soiKm = soiRadiusKm(earthRAU);
    const escHill = escapeSpeedKms(hillKm);

    const stat = (k, v, title = '') =>
        `<div class="nw-stat" ${title ? `title="${esc(title)}"` : ''}>
            <span class="nw-stat-k">${esc(k)}</span><span class="nw-stat-v">${v}</span></div>`;

    const out = [
        '<div class="nw-stats">',
        stat('Hill sphere', `${(hillKm / LD_KM).toFixed(2)} LD`,
            `${Math.round(hillKm).toLocaleString('en-US')} km — where Earth's pull beats the Sun's tide. Nothing can orbit Earth beyond it.`),
        stat('Sphere of influence', `${(soiKm / LD_KM).toFixed(2)} LD`,
            `${Math.round(soiKm).toLocaleString('en-US')} km — inside this, an encounter is better modelled about Earth than about the Sun.`),
        stat('Escape at Hill', `${escHill.toFixed(2)} km/s`,
            'The speed an object must be under, out there, to be bound to Earth at all.'),
        '</div>',
    ];

    // ── Who is inside, right now ────────────────────────────────────────────
    if (state === 'down' || state === 'loading') {
        out.push(emptyState(state, ''));
    } else if (inside.length) {
        out.push(`<p class="nw-grav-hit"><b>${inside.length}</b> object${inside.length === 1 ? '' : 's'}
            inside the Hill sphere right now.</p>`);
        out.push(`<table class="nw-table"><thead><tr><th>Object</th>
            <th class="nw-num">Range</th><th class="nw-num">Speed</th><th class="nw-num">State</th></tr></thead><tbody>${
            inside.slice(0, 6).map(r => `
            <tr class="nw-row ${rowClass(r)}" data-index="${r.index}" tabindex="0">
                <td class="nw-name">${esc(r.name)}</td>
                <td class="nw-num">${esc(r.distLabel)}</td>
                <td class="nw-num">${r.vGeoKms == null ? '—' : `${r.vGeoKms.toFixed(1)} km/s`}</td>
                <td class="nw-num">${r.encounter?.bound ? '<span class="nw-up">bound</span>' : 'passing'}</td>
            </tr>`).join('')}</tbody></table>`);
    } else {
        out.push(`<p class="nw-note">Nothing catalogued is inside the Hill sphere at this instant —
            the ordinary state of affairs. A pass inside ${(hillKm / LD_KM).toFixed(1)} LD happens
            a few times a year among known objects.</p>`);
    }

    // ── The nearest object's encounter, in full ─────────────────────────────
    if (nearest?.encounter) {
        const e = nearest.encounter;
        const lines = [
            `<h4>Nearest object · ${esc(nearest.name)}</h4>`,
            `<p>${esc(nearest.distLabel)} away at
             <b>${nearest.vGeoKms == null ? '—' : `${nearest.vGeoKms.toFixed(2)} km/s`}</b> relative to Earth
             — ${esc(REGIME_LABELS[e.regime] || e.regime)}.</p>`,
        ];
        if (e.vInfKms != null) {
            const f = e.focusing;
            lines.push(`<p class="nw-note">Hyperbolic excess <b>${e.vInfKms.toFixed(2)} km/s</b>: it is
                ${e.captureMarginKms.toFixed(2)} km/s faster than escape at this range, so Earth cannot hold it.
                ${f ? `At that speed Earth's focused collision cross-section is <b>${f.enhancement.toFixed(1)}×</b>
                its geometric one — an impact corridor ${Math.round(f.bMaxKm).toLocaleString('en-US')} km wide,
                against a miss of ${esc(formatGeoDistance(e.distKm))}.` : ''}</p>`);
        } else if (e.bound) {
            lines.push(`<p class="nw-note">Its geocentric energy is <b>negative</b> — at this instant it is
                bound to Earth. That is what a temporarily captured object, a "minimoon", is.</p>`);
        }
        if (!e.modelValid) {
            lines.push(`<p class="nw-warn">It is inside the sphere of influence, so <b>this page's own
                position for it is no longer the right model</b> — we propagate two-body orbits about the
                Sun and Earth is deflecting it. The close-approach table beside this is JPL's integrated
                orbit and is the one to believe.</p>`);
        }
        out.push(`<div class="nw-grav-near">${lines.join('')}</div>`);
    }

    // ── Who could ever be ───────────────────────────────────────────────────
    if (screen?.counts) {
        const c = screen.counts;
        out.push(`<div class="nw-grav-screen">
            <h4>Which orbits can reach us at all</h4>
            <p>Of <b>${c.withMoid.toLocaleString('en-US')}</b> loaded objects with a published Earth MOID,
            <b>${c.hill.toLocaleString('en-US')}</b> have orbits that pass within the Hill sphere,
            <b>${c.soi.toLocaleString('en-US')}</b> within the sphere of influence, and
            <b>${c.impact.toLocaleString('en-US')}</b> within one Earth radius of our orbit.</p>
            <p class="nw-note">MOID is the minimum distance between the two <em>orbits</em>, not the two
            bodies, so this is a hard ceiling — an object whose MOID exceeds the Hill radius cannot enter
            it wherever it is in its orbit. The converse does <em>not</em> follow: a small MOID means the
            orbits pass close, not that the bodies do. Timing is what the approach table is for.
            ${tierLabel ? `Screening the loaded population: ${esc(tierLabel)}.` : ''}</p>
        </div>`);
        if (screen.closest?.length) {
            out.push(`<table class="nw-table"><thead><tr><th>Closest orbits</th>
                <th class="nw-num">Earth MOID</th><th class="nw-num">H</th></tr></thead><tbody>${
                screen.closest.slice(0, 6).map(o => `
                <tr class="nw-row" data-index="${o.index}" tabindex="0">
                    <td class="nw-name">${esc(o.name || o.des)}</td>
                    <td class="nw-num">${(o.moid * AU_KM / LD_KM).toFixed(3)} LD</td>
                    <td class="nw-num">${o.H == null ? '—' : o.H.toFixed(1)}</td>
                </tr>`).join('')}</tbody></table>`);
        }
    }

    el.innerHTML = out.join('');
}

/** A short line naming what each feed is currently doing. */
export function renderFeedChips(el, feeds) {
    el.innerHTML = feeds.map((f) => {
        const cls = f.state === 'live' ? 'nw-chip--live'
            : f.state === 'loading' ? 'nw-chip--loading' : 'nw-chip--down';
        return `<span class="nw-chip ${cls}" title="${esc(f.detail || '')}">${esc(f.label)}: ${esc(f.text)}</span>`;
    }).join('');
}
