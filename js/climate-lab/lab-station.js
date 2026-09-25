/**
 * climate-lab/lab-station.js — the Climate Lab's weather side.
 * ═══════════════════════════════════════════════════════════════════════════
 * Mounts four dashboard modules from ONE station feed:
 *   WX-01 HOME STATION   the home base hero: where, when, now, sun & moon,
 *                        a live day/night map, Home / visiting controls
 *   WX-02 INSTRUMENTS    the customisable bench of instrument tiles
 *   WX-03 METEOGRAM      small multiples on one time axis + probe + table
 *   CL-01 CLIMATE        today against this place's own recent climate
 * plus the CUSTOMISE drawer (units, bench, open-at, meteogram span).
 *
 * Rules this module keeps (and each exists because the site has hit it):
 *   · Draw, never compute. Numbers come from lab-readings / lab-physics /
 *     lab-climate (pure, node-gated); this file formats and places them.
 *   · STABLE CONTROLS. The station search box, GPS and customise controls
 *     are built once; data refreshes re-render the readouts only, so a
 *     half-typed query is never wiped (the verdict-card lesson, §4.4).
 *   · ONE location store. Visiting a place writes ppx_user_location through
 *     lab-home.js; this module then follows 'user-location-changed' like
 *     every other card on the page.
 *   · Every render is fault-isolated per module: one broken tile prints a
 *     quiet empty state, never a dead dashboard.
 */

import { geocodeQuery, loadUserLocation } from '../user-location.js';
import { sunTimes, solarPosition } from '../sun-altitude.js';
import { moonPhase, weatherGlyph } from '../verdict-engine.js';
import { WMO_LABELS } from '../local-sky.js';
import { fetchLabStation, hourlyWindow, stationDateKey } from './lab-feed.js';
import { buildReadings } from './lab-readings.js';
import { resolveUnits, fmt, fmtText, PRESETS, QUANTITIES } from './lab-units.js';
import {
    INSTRUMENTS, loadPrefs, savePrefs, normalizePrefs, moveInstrument, visibleInstruments,
    PREFS_EVENT, DEFAULT_PREFS,
} from './lab-prefs.js';
import { sparkSvg, meterSvg, compassSvg, layersSvg, stripSvg, meteogramSvg, esc, toDisplay } from './lab-charts.js';
import { homeState, visit, setHome, sameLocation } from './lab-home.js';
import { climateContext, positionWords, loadStationClimate, ordinal } from './lab-climate.js';
import { createWorldMap } from './lab-map.js';

const HOUR = 3_600_000;
const REFRESH_MS = 15 * 60_000;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function track(action, meta) {
    import('../telemetry.js').then((m) => m.telemetry?.recordFeature?.('climate_lab', action, meta)).catch(() => {});
}

/** Station-local clock text, via the IANA zone when the browser knows it. */
function stationClock(ms, station, opts = {}) {
    const o = { hour: '2-digit', minute: '2-digit', hour12: false, ...opts };
    try {
        if (station?.tz) return new Intl.DateTimeFormat('en-GB', { ...o, timeZone: station.tz }).format(new Date(ms));
    } catch { /* fall through to the fixed offset */ }
    const d = new Date(ms + (station?.utcOffsetS || 0) * 1000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}
function stationDay(ms, station) {
    try {
        if (station?.tz) return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: station.tz }).format(new Date(ms));
    } catch {}
    return new Date(ms + (station?.utcOffsetS || 0) * 1000).toUTCString().slice(0, 11);
}
function latLonText(lat, lon) {
    return `${Math.abs(lat).toFixed(3)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(3)}°${lon >= 0 ? 'E' : 'W'}`;
}
function durText(s) {
    if (!isNum(s)) return '—';
    const m = Math.round(s / 60);
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m`;
}
function agoText(ms, now) {
    if (!isNum(ms)) return '';
    const m = Math.round((now - ms) / 60_000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}
/** Conventional phase name from verdict-engine's phase fraction (0 = new). */
function moonName(phase) {
    if (!isNum(phase)) return '';
    const p = ((phase % 1) + 1) % 1;
    return p < 0.03 || p > 0.97 ? 'New moon' : p < 0.22 ? 'Waxing crescent' : p < 0.28 ? 'First quarter'
        : p < 0.47 ? 'Waxing gibbous' : p < 0.53 ? 'Full moon' : p < 0.72 ? 'Waning gibbous'
        : p < 0.78 ? 'Last quarter' : 'Waning crescent';
}
const chip = (st) => st
    ? `<span class="cl-chip" data-tone="${esc(st.tone)}"><span class="cl-chip-icon" aria-hidden="true">${esc(st.icon)}</span>${esc(st.label)}</span>`
    : '';

// ── Skeletons (built once) ──────────────────────────────────────────────────

function moduleHead(code, title, id, extra = '') {
    return `<header class="cl-module-head">
        <span class="cl-code">${esc(code)}</span>
        <h2 class="cl-module-title" id="${id}">${esc(title)}</h2>
        ${extra}
    </header>`;
}

function stationSkeleton() {
    return `${moduleHead('WX-01', 'Home station', 'cl-station-title', `
        <span class="cl-led" data-role="led" data-state="loading" aria-hidden="true"></span>
        <span class="cl-head-meta" data-role="updated" aria-live="polite">Connecting…</span>
        <div class="cl-head-actions">
            <button type="button" class="cl-btn cl-btn-ghost" data-role="customize-btn" aria-expanded="false" aria-controls="cl-customize">⚙ Customize lab</button>
        </div>`)}
    <div class="cl-station-grid">
        <div class="cl-station-id">
            <div data-role="identity"></div>
            <div class="cl-station-controls">
                <label class="cl-visually-hidden" for="cl-station-search">Find a place</label>
                <input class="cl-input" id="cl-station-search" data-role="search" type="text" maxlength="80" autocomplete="off" placeholder="Find a city, zip, or address…">
                <button type="button" class="cl-btn" data-role="search-go" aria-label="Look up this place">↵</button>
                <button type="button" class="cl-btn" data-role="gps" title="Use my current position" aria-label="Use my current position">⊕</button>
            </div>
            <div class="cl-status-line" data-role="status" role="status" aria-live="polite"></div>
            <div class="cl-places" data-role="places"></div>
        </div>
        <div class="cl-station-now" data-role="now"></div>
        <div class="cl-station-sky">
            <div data-role="sky"></div>
            <figure class="cl-map-figure">
                <canvas class="cl-map" data-role="map" aria-label="World map with your home station and today's day/night terminator"></canvas>
                <figcaption class="cl-caption">NASA Blue Marble (archival imagery) · live day/night terminator</figcaption>
            </figure>
        </div>
    </div>
    <div class="cl-customize" id="cl-customize" data-role="customize" hidden></div>`;
}

function benchSkeleton() {
    return `${moduleHead('WX-02', 'Instrument bench', 'cl-bench-title', `
        <span class="cl-head-meta" data-role="bench-meta"></span>`)}
    <div class="cl-bench" data-role="bench" aria-live="off"></div>`;
}

function meteogramSkeleton() {
    return `${moduleHead('WX-03', 'Meteogram', 'cl-mg-title', `
        <span class="cl-head-meta" data-role="mg-meta"></span>
        <div class="cl-head-actions">
            <div class="cl-seg" role="group" aria-label="Meteogram span" data-role="mg-span">
                <button type="button" data-h="24">24 h</button><button type="button" data-h="48">48 h</button><button type="button" data-h="72">72 h</button>
            </div>
            <button type="button" class="cl-btn cl-btn-ghost" data-role="mg-table-btn" aria-pressed="false">Table view</button>
        </div>`)}
    <div class="cl-probe" data-role="probe" aria-live="polite">Move across the chart (or focus it and use ← →) to read every instrument at one hour.</div>
    <div class="cl-mg-wrap" data-role="mg"></div>
    <div class="cl-mg-legend" aria-hidden="true">
        <span><i class="cl-key cl-key-temp"></i>Temperature</span>
        <span><i class="cl-key cl-key-dew"></i>Dew point</span>
        <span><i class="cl-key cl-key-pop"></i>Precipitation chance</span>
        <span><i class="cl-key cl-key-wind"></i>Wind (band = gusts)</span>
        <span><i class="cl-key cl-key-press"></i>Pressure</span>
        <span><i class="cl-key cl-key-night"></i>Night</span>
        <span><i class="cl-key cl-key-now"></i>Now — model past to the left, forecast to the right</span>
    </div>`;
}

function climateSkeleton() {
    return `${moduleHead('CL-01', 'Climate context', 'cl-climate-title', `
        <span class="cl-head-meta" data-role="clim-meta"></span>`)}
    <div class="cl-climate" data-role="climate"><div class="cl-empty">Loading this place’s recent climate…</div></div>`;
}

// ── Renderers ───────────────────────────────────────────────────────────────

function rowHtml(r, units) {
    let val;
    if (r.pair) val = r.pair.map((p) => esc(fmtText(p.q, p.v, units))).join(' <span class="cl-sep">/</span> ');
    else if (r.text != null) val = esc(r.text);
    else val = esc(fmtText(r.q, r.v, units, { signed: !!r.signed }));
    return `<div class="cl-row"><dt>${esc(r.label)}</dt><dd>${val}${r.note ? `<span class="cl-row-note">${esc(r.note)}</span>` : ''}</dd></div>`;
}

function tileHtml(id, reading, units) {
    const meta = INSTRUMENTS.find((i) => i.id === id);
    const head = `<header class="cl-tile-head">
            <span class="cl-tile-glyph" aria-hidden="true">${meta.glyph}</span>
            <h3 class="cl-tile-name" id="cl-t-${id}">${esc(meta.name)}</h3>
            ${reading?.ok ? chip(reading.status) : ''}
        </header>`;
    if (!reading?.ok) {
        return `<article class="cl-tile is-empty" data-inst="${id}" aria-labelledby="cl-t-${id}">${head}
            <p class="cl-empty">${esc(reading?.missing || 'Waiting for data…')}</p></article>`;
    }
    const p = reading.primary;
    let primary = '';
    if (p) {
        const f = fmt(p.q, p.v, units);
        primary = `<div class="cl-tile-primary"><span class="cl-tile-value">${esc(f.text)}</span><span class="cl-tile-unit">${esc(f.sym)}</span></div>
            <div class="cl-tile-label" data-role="probe">${esc(p.label)}</div>`;
    }
    let visual = '';
    if (reading.visual?.kind === 'compass') visual = `<div class="cl-tile-visual cl-tile-visual-dial">${compassSvg(reading.visual)}</div>`;
    else if (reading.visual?.kind === 'layers') visual = `<div class="cl-tile-visual">${layersSvg(reading.visual)}</div>`;
    else if (reading.meter) visual = `<div class="cl-tile-visual">${meterSvg(reading.meter)}</div>`;
    const spark = reading.spark ? sparkSvg(reading.spark, { units }) : '';
    return `<article class="cl-tile" data-inst="${id}" aria-labelledby="cl-t-${id}">
        ${head}
        ${primary}
        ${visual}
        ${spark ? `<div class="cl-tile-spark" data-role="spark" tabindex="0" aria-label="${esc(reading.spark.label)} trace; use arrow keys to read hours">${spark}</div>` : ''}
        <dl class="cl-tile-rows">${reading.rows.map((r) => rowHtml(r, units)).join('')}</dl>
        <footer class="cl-tile-method">${esc(reading.method || '')}</footer>
    </article>`;
}

function customizeHtml(prefs, syncState, signedIn) {
    const presets = ['auto', ...Object.keys(PRESETS), 'custom'];
    const presetLabel = (id) => id === 'auto' ? 'Auto (from your language)' : id === 'custom' ? 'Custom' : PRESETS[id].label;
    const custom = prefs.units.preset === 'custom';
    const qSel = (q) => {
        const cur = prefs.units.overrides?.[q] || '';
        const opts = Object.entries(QUANTITIES[q].units).map(([k, u]) =>
            `<option value="${k}" ${cur === k ? 'selected' : ''}>${esc(u.sym)}</option>`).join('');
        return `<label class="cl-field"><span>${esc(QUANTITIES[q].label)}</span><select data-unit="${q}"><option value="">Default</option>${opts}</select></label>`;
    };
    const hidden = new Set(prefs.bench.hidden);
    const rows = prefs.bench.order.map((id, i) => {
        const m = INSTRUMENTS.find((x) => x.id === id);
        return `<li class="cl-inst-row">
            <label><input type="checkbox" data-inst-toggle="${id}" ${hidden.has(id) ? '' : 'checked'}> <span aria-hidden="true">${m.glyph}</span> <strong>${esc(m.name)}</strong> <span class="cl-muted">${esc(m.what)}</span></label>
            <span class="cl-inst-move">
                <button type="button" class="cl-btn cl-btn-icon" data-inst-move="${id}" data-dir="-1" aria-label="Move ${esc(m.name)} earlier" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button type="button" class="cl-btn cl-btn-icon" data-inst-move="${id}" data-dir="1" aria-label="Move ${esc(m.name)} later" ${i === prefs.bench.order.length - 1 ? 'disabled' : ''}>↓</button>
            </span></li>`;
    }).join('');
    const syncLine = syncState === 'synced' ? 'Synced to your account — these settings follow you to any device.'
        : syncState === 'off:tier' ? 'Saved on this device. Cross-device sync comes with Basic and above.'
        : !signedIn ? 'Saved on this device.'
        : syncState === 'error' ? 'Saved on this device (cloud sync is unavailable right now).'
        : 'Saved on this device.';
    return `<div class="cl-customize-grid">
        <section>
            <h3 class="cl-sub">Units</h3>
            <label class="cl-field"><span>Unit system</span><select data-role="preset">${presets.map((p) =>
                `<option value="${p}" ${prefs.units.preset === p ? 'selected' : ''}>${esc(presetLabel(p))}</option>`).join('')}</select></label>
            <div class="cl-unit-grid" ${custom ? '' : 'hidden'}>${['temp', 'wind', 'pressure', 'precip', 'distance', 'height'].map(qSel).join('')}</div>
            <h3 class="cl-sub">When the dashboard opens</h3>
            <label class="cl-radio"><input type="radio" name="cl-openat" value="home" ${prefs.openAt === 'home' ? 'checked' : ''}> Show my home station</label>
            <label class="cl-radio"><input type="radio" name="cl-openat" value="last" ${prefs.openAt === 'last' ? 'checked' : ''}> Show the last place I looked at</label>
            <p class="cl-muted cl-small">${esc(syncLine)}</p>
            <button type="button" class="cl-btn cl-btn-ghost" data-role="reset">Reset lab to defaults</button>
        </section>
        <section>
            <h3 class="cl-sub">Instruments on the bench</h3>
            <ul class="cl-inst-list">${rows}</ul>
        </section>
    </div>`;
}

// ── Mount ───────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {{station:HTMLElement, bench?:HTMLElement, meteogram?:HTMLElement, climate?:HTMLElement}} o.hosts
 * @param {object} o.auth      the auth singleton
 * @param {object} [o.demo]    demo-mode sample location
 * @param {function} [o.listPlaces]  async () => saved user_locations rows
 */
export function mountClimateLab({ hosts, auth, demo = null, listPlaces = null } = {}) {
    const H = hosts || {};
    if (!H.station) throw new Error('climate lab: station host missing');
    H.station.innerHTML = stationSkeleton();
    if (H.bench) H.bench.innerHTML = benchSkeleton();
    if (H.meteogram) H.meteogram.innerHTML = meteogramSkeleton();
    if (H.climate) H.climate.innerHTML = climateSkeleton();
    const q = (host, role) => host?.querySelector(`[data-role="${role}"]`);

    const S = {
        prefs: loadPrefs(),
        units: null,
        hs: homeState({ auth, demo }),
        obs: null, fetchedAt: null, readings: null, error: null, loading: false,
        air: null, climate: null, climateFor: null, arch: undefined,
        places: [], tableView: false, probeIdx: null, mgLayout: null, mgWindow: null,
        syncState: 'off', map: null, abort: null,
        userMoved: false,   // any deliberate visit / set-home this page life
    };
    const signedIn = () => !!auth?.isSignedIn?.();
    S.units = resolveUnits(S.prefs.units, navigator.language);

    // ── Status line ─────────────────────────────────────────────────────────
    const statusEl = q(H.station, 'status');
    let statusTimer = null;
    function say(msg, tone = 'info', holdMs = 6000) {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.dataset.tone = tone;
        clearTimeout(statusTimer);
        if (holdMs) statusTimer = setTimeout(() => { statusEl.textContent = ''; }, holdMs);
    }

    // ── Station hero ───────────────────────────────────────────────────────
    function renderIdentity() {
        const el = q(H.station, 'identity');
        const { home, source, view, visiting } = S.hs;
        const place = view || home;
        if (!place) {
            el.innerHTML = `<div class="cl-setup">
                <div class="cl-station-name">Set up your home station</div>
                <p class="cl-muted">Search for your town or use ⊕ to set <strong>Home</strong> — every instrument, forecast and alert on this dashboard is measured there, and the dashboard opens there by default.</p></div>`;
            return;
        }
        const st = S.obs?.station;
        const elev = isNum(st?.elevationM) ? ` · ${esc(fmtText('height', st.elevationM, S.units))} elevation` : '';
        const badge = visiting
            ? '<span class="cl-badge cl-badge-visit">Visiting</span>'
            : '<span class="cl-badge cl-badge-home">⌂ Home</span>';
        let note = '';
        if (visiting) {
            note = `<div class="cl-visit-bar">Home is <strong>${esc(home.city)}</strong>.
                <button type="button" class="cl-btn cl-btn-small" data-act="go-home">⌂ Return home</button>
                <button type="button" class="cl-btn cl-btn-small cl-btn-accent" data-act="make-home">★ Make ${esc(place.city)} home</button></div>`;
        } else if (source === 'device' && signedIn()) {
            note = `<div class="cl-visit-bar">Home is saved on this device only.
                <button type="button" class="cl-btn cl-btn-small cl-btn-accent" data-act="save-home">Save to my account</button></div>`;
        } else if (source === 'demo') {
            note = '<div class="cl-visit-bar">Sample station for the demo — sign up to keep your own home.</div>';
        }
        el.innerHTML = `<div class="cl-station-name">${badge}<span>${esc(place.city)}</span></div>
            <div class="cl-mono cl-muted">${esc(latLonText(place.lat, place.lon))}${elev}</div>
            <div class="cl-station-clock"><span data-role="clock">${esc(stationClock(Date.now(), st))}</span>
                <span class="cl-muted">${esc(stationDay(Date.now(), st))}${st?.tzAbbr ? ' · ' + esc(st.tzAbbr) : ''}</span></div>
            ${note}`;
    }

    function renderPlaces() {
        const el = q(H.station, 'places');
        if (!el) return;
        const { home, view } = S.hs;
        const chips = [];
        if (home) chips.push({ label: '⌂ Home', loc: home, active: sameLocation(home, view) });
        for (const p of S.places.slice(0, 8)) {
            if (home && sameLocation(p, home)) continue;
            chips.push({ label: p.label || p.city, loc: { lat: p.lat, lon: p.lon, city: p.city || p.label }, active: sameLocation(p, view) });
        }
        if (chips.length < 2) { el.innerHTML = ''; return; }
        el.innerHTML = `<span class="cl-muted cl-small">Your places</span>`
            + chips.map((c, i) => `<button type="button" class="cl-place${c.active ? ' is-active' : ''}" data-place="${i}" aria-pressed="${c.active}">${esc(c.label)}</button>`).join('')
            + '<a class="cl-small cl-link" href="settings.html#saved-locations">Manage ›</a>';
        el._chips = chips;
    }

    function renderNow() {
        const el = q(H.station, 'now');
        const cur = S.readings?.cur, day = S.readings?.day;
        if (!S.obs || !cur) {
            el.innerHTML = S.error
                ? `<div class="cl-empty">Station feed unavailable — ${esc(S.error)}. <button type="button" class="cl-btn cl-btn-small" data-act="retry">Retry</button></div>`
                : `<div class="cl-empty">${S.hs.view || S.hs.home ? 'Reading the instruments…' : 'No station yet.'}</div>`;
            return;
        }
        const hero = fmt('temp', cur.tempC, S.units, { dp: 0 });
        const label = WMO_LABELS[cur.code] || '—';
        const feels = S.readings.readings.thermo?.rows?.[0];
        el.innerHTML = `<div class="cl-hero">
                <span class="cl-hero-glyph" aria-hidden="true">${weatherGlyph(cur.code)}</span>
                <span class="cl-hero-value">${esc(hero.text)}</span><span class="cl-hero-unit">${esc(hero.sym)}</span>
            </div>
            <div class="cl-hero-cond">${esc(label)}</div>
            <dl class="cl-hero-rows">
                ${feels?.q ? `<div><dt>Feels like</dt><dd>${esc(fmtText('temp', feels.v, S.units, { dp: 0 }))}</dd></div>` : ''}
                <div><dt>High / low</dt><dd>${esc(fmtText('temp', day?.highC, S.units, { dp: 0 }))} / ${esc(fmtText('temp', day?.lowC, S.units, { dp: 0 }))}</dd></div>
                <div><dt>Humidity</dt><dd>${esc(fmtText('pct', cur.rhPct, S.units))}</dd></div>
                <div><dt>Wind</dt><dd>${esc(fmtText('wind', cur.windMs, S.units))}</dd></div>
            </dl>
            ${sparkSvg(S.readings.readings.thermo?.spark, { units: S.units, w: 220, h: 38 })}
            <div class="cl-caption">Temperature, past 24 h (solid) and next 24 h (dashed)</div>`;
    }

    function renderSky() {
        const el = q(H.station, 'sky');
        const place = S.hs.view || S.hs.home;
        if (!place) { el.innerHTML = ''; return; }
        const now = Date.now();
        const st = S.obs?.station;
        const day = S.readings?.day;
        const t = sunTimes(new Date(now), place.lat, place.lon);
        const rise = day?.sunrise ?? t.sunrise?.getTime();
        const set = day?.sunset ?? t.sunset?.getTime();
        const pos = solarPosition(new Date(now), place.lat, place.lon);
        const moon = moonPhase(now);
        el.innerHTML = `<dl class="cl-sky-rows">
            <div><dt>Sunrise</dt><dd>${isNum(rise) ? esc(stationClock(rise, st)) : (t.polar === 'day' ? 'Up all day' : 'No sunrise')}</dd></div>
            <div><dt>Sunset</dt><dd>${isNum(set) ? esc(stationClock(set, st)) : (t.polar === 'day' ? 'No sunset' : '—')}</dd></div>
            <div><dt>Daylight</dt><dd>${esc(durText(day?.daylightS ?? t.dayLengthH * 3600))}</dd></div>
            <div><dt>Sun now</dt><dd>${esc(pos.altitudeDeg.toFixed(1))}° elevation</dd></div>
            <div><dt>Moon</dt><dd><span aria-hidden="true">${moon.glyph}</span> ${esc(moonName(moon.phase))}<span class="cl-row-note">${moon.illumPct}% lit</span></dd></div>
        </dl>`;
    }

    function drawMap() {
        if (!S.map) return;
        S.map.setOverlay((ctx, api) => {
            const dpr = api.dpr;
            const pin = (loc, fill, r) => {
                const p = api.project(loc.lat, loc.lon);
                ctx.beginPath(); ctx.arc(p.x, p.y, r * dpr + 2 * dpr, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(4,8,18,0.85)'; ctx.fill();
                ctx.beginPath(); ctx.arc(p.x, p.y, r * dpr, 0, Math.PI * 2);
                ctx.fillStyle = fill; ctx.fill();
            };
            for (const p of S.places) pin(p, 'rgba(200,220,240,0.75)', 2.5);
            if (S.hs.visiting && S.hs.view) pin(S.hs.view, '#ffb066', 4);
            if (S.hs.home) pin(S.hs.home, '#5fffd0', 4.5);
        });
    }

    // ── Bench ───────────────────────────────────────────────────────────────
    function renderBench() {
        const el = q(H.bench, 'bench');
        if (!el) return;
        const ids = visibleInstruments(S.prefs);
        const meta = q(H.bench, 'bench-meta');
        if (meta) meta.textContent = `${ids.length} of ${INSTRUMENTS.length} instruments · ${S.units.preset === 'custom' ? 'custom units' : (PRESETS[S.units.preset]?.label || 'auto') + ' units'}`;
        if (!S.readings) {
            el.innerHTML = `<div class="cl-empty">${S.error ? 'Instruments offline — the station feed did not answer.' : (S.hs.view || S.hs.home) ? 'Calibrating instruments…' : 'Set a home station to switch the instruments on.'}</div>`;
            return;
        }
        el.innerHTML = ids.map((id) => {
            try { return tileHtml(id, S.readings.readings[id], S.units); }
            catch { return tileHtml(id, { ok: false, missing: 'This instrument failed to render' }, S.units); }
        }).join('') || '<div class="cl-empty">Every instrument is hidden — switch some back on in Customize lab.</div>';
    }

    /** Sparkline probe: read the hour under the pointer / arrow keys. */
    function sparkProbe(tileEl, idx) {
        const id = tileEl?.dataset?.inst;
        const r = S.readings?.readings?.[id];
        const lbl = tileEl?.querySelector('[data-role="probe"]');
        if (!r?.spark || !lbl) return;
        const { values, t, nowIdx } = r.spark;
        if (idx == null) { lbl.textContent = r.primary?.label || ''; tileEl._probe = null; return; }
        const i = Math.max(0, Math.min(values.length - 1, idx));
        tileEl._probe = i;
        const when = isNum(t[i]) ? `${stationDay(t[i], S.obs?.station)} ${stationClock(t[i], S.obs?.station)}` : '';
        lbl.textContent = `${i <= nowIdx ? 'Was' : 'Forecast'} ${when}: ${fmtText(r.spark.q, values[i], S.units)}`;
    }

    // ── Meteogram ───────────────────────────────────────────────────────────
    function renderMeteogram() {
        const wrap = q(H.meteogram, 'mg');
        if (!wrap) return;
        H.meteogram.querySelectorAll('[data-role="mg-span"] button').forEach((b) =>
            b.setAttribute('aria-pressed', String(Number(b.dataset.h) === S.prefs.meteogramHours)));
        if (!S.obs) {
            wrap.innerHTML = `<div class="cl-empty">${S.error ? 'Meteogram offline.' : 'Waiting for the station feed…'}</div>`;
            return;
        }
        const now = Date.now();
        const W = hourlyWindow(S.obs, now - 12 * HOUR, now + S.prefs.meteogramHours * HOUR);
        S.mgWindow = W;
        const meta = q(H.meteogram, 'mg-meta');
        if (S.tableView) {
            S.mgLayout = null;
            wrap.innerHTML = meteogramTable(W);
            if (meta) meta.textContent = `${W.t.length} hourly rows`;
            return;
        }
        // The viewBox tracks the container so text stays ~1:1 on a phone
        // instead of shrinking with a fixed-width drawing.
        const width = Math.max(320, Math.min(1100, Math.round(wrap.clientWidth || 720)));
        const { svg, layout } = meteogramSvg(W, { nowMs: now, utcOffsetS: S.obs.station.utcOffsetS, units: S.units, width });
        S.mgLayout = layout;
        wrap.innerHTML = svg || '<div class="cl-empty">Not enough hourly data to draw.</div>';
        if (meta) meta.textContent = `Station time (${S.obs.station.tzAbbr || 'local'}) · past 12 h + next ${S.prefs.meteogramHours} h`;
        if (S.probeIdx != null) probeAt(S.probeIdx);
    }

    function meteogramTable(W) {
        const st = S.obs.station, u = S.units;
        const now = Date.now();
        const head = ['Time', `Temp (${fmt('temp', 0, u).sym})`, `Dew (${fmt('temp', 0, u).sym})`, 'Chance', `Precip (${fmt('precip', 0, u).sym})`,
            `Wind (${fmt('wind', 0, u).sym})`, `Gust (${fmt('wind', 0, u).sym})`, 'From', `Pressure (${fmt('pressure', 0, u).sym})`, 'Cloud'];
        const rows = W.t.map((t, i) => {
            const cells = [
                `${stationDay(t, st)} ${stationClock(t, st)}`,
                fmt('temp', W.tempC[i], u).text, fmt('temp', W.dewC[i], u).text,
                isNum(W.pop[i]) ? `${Math.round(W.pop[i])}%` : '—',
                fmt('precip', W.precipMm[i], u).text,
                fmt('wind', W.windMs[i], u).text, fmt('wind', W.gustMs[i], u).text,
                isNum(W.windDir[i]) ? `${Math.round(W.windDir[i])}°` : '—',
                fmt('pressure', W.mslHpa[i], u).text,
                isNum(W.cloudPct[i]) ? `${Math.round(W.cloudPct[i])}%` : '—',
            ];
            return `<tr class="${t > now ? 'is-fc' : ''}">${cells.map((c, j) => j === 0 ? `<th scope="row">${esc(c)}</th>` : `<td>${esc(c)}</td>`).join('')}</tr>`;
        }).join('');
        return `<div class="cl-table-wrap" tabindex="0" role="region" aria-label="Hourly meteogram values"><table class="cl-table">
            <caption class="cl-visually-hidden">Hourly station values; rows after now are forecast</caption>
            <thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>${rows}</tbody></table></div>`;
    }

    function probeAt(idx) {
        const L = S.mgLayout, W = S.mgWindow;
        const svg = H.meteogram?.querySelector('svg.cl-mg');
        const out = q(H.meteogram, 'probe');
        if (!L || !W || !svg || !out) return;
        const i = Math.max(0, Math.min(L.n - 1, idx));
        S.probeIdx = i;
        const line = svg.querySelector('.cl-mg-probe');
        if (line) { line.setAttribute('x1', L.xs[i]); line.setAttribute('x2', L.xs[i]); line.setAttribute('visibility', 'visible'); }
        const u = S.units, st = S.obs.station;
        const t = W.t[i];
        const parts = [
            `<strong>${esc(stationDay(t, st))} ${esc(stationClock(t, st))}</strong>${t > Date.now() ? ' <span class="cl-muted">forecast</span>' : ''}`,
            `${esc(fmtText('temp', W.tempC[i], u))} <span class="cl-muted">air</span>`,
            `${esc(fmtText('temp', W.dewC[i], u))} <span class="cl-muted">dew</span>`,
            `${isNum(W.pop[i]) ? Math.round(W.pop[i]) + '%' : '—'} <span class="cl-muted">chance</span> ${esc(fmtText('precip', W.precipMm[i], u))}`,
            `${esc(fmtText('wind', W.windMs[i], u))} <span class="cl-muted">gust</span> ${esc(fmtText('wind', W.gustMs[i], u))}`,
            `${esc(fmtText('pressure', W.mslHpa[i], u))}`,
            `${isNum(W.cloudPct[i]) ? Math.round(W.cloudPct[i]) + '%' : '—'} <span class="cl-muted">cloud</span>`,
        ];
        out.innerHTML = parts.join('<span class="cl-dot" aria-hidden="true">·</span>');
    }

    // ── Climate ─────────────────────────────────────────────────────────────
    // The archive is fetched once per place (lab-climate caches it); the
    // context is recomputed on every refresh so a new station day re-ranks.
    async function loadClimate() {
        const place = S.hs.view || S.hs.home;
        if (!H.climate || !place || !S.obs) return;
        const key = `${place.lat.toFixed(2)},${place.lon.toFixed(2)}`;
        if (S.climateFor !== key) { S.climateFor = key; S.arch = undefined; S.climate = null; renderClimate(); }
        if (!S.arch) {
            const arch = await loadStationClimate(place.lat, place.lon);
            if (S.climateFor !== key) return;   // the view moved on meanwhile
            S.arch = arch;
        }
        const day = S.readings?.day;
        S.climate = S.arch ? climateContext({
            pts: S.arch.pts, lagDays: S.arch.lagDays,
            stationDate: stationDateKey(Date.now(), S.obs.station.utcOffsetS),
            todayHighC: day?.highC, todayLowC: day?.lowC,
        }) : null;
        renderClimate(!S.arch);
    }

    function renderClimate(failed = false) {
        const el = q(H.climate, 'climate');
        if (!el) return;
        const c = S.climate, u = S.units;
        const meta = q(H.climate, 'clim-meta');
        if (!c) {
            el.innerHTML = `<div class="cl-empty">${failed ? 'The climate archive did not answer — context will return on the next refresh.' : 'Loading this place’s recent climate…'}</div>`;
            if (meta) meta.textContent = '';
            return;
        }
        if (meta) meta.textContent = c.years ? `ERA5 archive ${c.years[0]}–${c.years[1]} · ±7-day window` : '';
        const hi = c.high;
        const words = positionWords(hi);
        const pct = hi ? ordinal(Math.round(hi.percentile)) : null;
        el.innerHTML = `<div class="cl-climate-grid">
            <div>
                <div class="cl-climate-head">${words ? esc(words) : 'Not enough history for this date'}</div>
                <p class="cl-climate-text">${hi
                    ? `Today’s forecast high of <strong>${esc(fmtText('temp', c.todayHighC, u))}</strong> sits at the <strong>${esc(pct)} percentile</strong> of ${hi.n} highs recorded here within a week of this date, <strong>${esc(fmtText('tempDelta', hi.anomaly, u, { signed: true }))}</strong> from their mean.${hi.beyondRecord ? ` It is ${hi.beyondRecord === 'high' ? 'above every' : 'below every'} value in that sample.` : ''}`
                    : 'The archive for this place is too short to rank today.'}</p>
                ${stripSvg({ samplesC: c.highsC, valueC: c.todayHighC, normalC: c.normalHighC, units: u, label: 'Today’s high' })}
                <div class="cl-caption">Each dot is one archive day’s high near this date; the bar is the mean, the ring is today’s forecast.</div>
            </div>
            <dl class="cl-climate-rows">
                <div><dt>Normal high / low</dt><dd>${esc(fmtText('temp', c.normalHighC, u))} / ${esc(fmtText('temp', c.normalLowC, u))}</dd></div>
                <div><dt>Seasonal lag</dt><dd>${isNum(c.lagDays) ? `${Math.round(c.lagDays)} days` : '—'}<span class="cl-row-note">from peak sunshine to peak warmth here</span></dd></div>
                <div><dt>Warm/cold spell memory</dt><dd>${isNum(c.tauDays) ? `τ ≈ ${c.tauDays.toFixed(1)} days` : '—'}<span class="cl-row-note">how fast a temperature anomaly fades (AR(1) e-folding)</span></dd></div>
                <div><dt>Typical day-to-day swing</dt><dd>${isNum(c.sigmaC) ? `± ${esc(fmtText('tempDelta', c.sigmaC, u))}` : '—'}<span class="cl-row-note">σ of the daily-mean anomaly</span></dd></div>
                <div><dt>Sample</dt><dd>${hi ? hi.n : 0} days · ${c.nDays} in archive</dd></div>
            </dl>
        </div>
        <p class="cl-small cl-muted">A 3-year reanalysis baseline, not a 30-year climate normal — good for “is today unusual for the season”, not for trends.</p>`;
    }

    // ── Customize drawer ────────────────────────────────────────────────────
    function renderCustomize() {
        const el = q(H.station, 'customize');
        if (!el || el.hidden) return;
        el.innerHTML = customizeHtml(S.prefs, S.syncState, signedIn());
    }
    function commitPrefs(next, action, meta) {
        S.prefs = savePrefs(next);
        track(action, meta);
    }

    // ── Everything ──────────────────────────────────────────────────────────
    function renderAll() {
        const safe = (label, fn) => { try { fn(); } catch (e) { console.warn(`[climate-lab] ${label} render failed:`, e); } };
        safe('identity', renderIdentity);
        safe('places', renderPlaces);
        safe('now', renderNow);
        safe('sky', renderSky);
        safe('map', drawMap);
        safe('bench', renderBench);
        safe('meteogram', renderMeteogram);
        safe('customize', renderCustomize);
        const led = q(H.station, 'led'), upd = q(H.station, 'updated');
        if (led) led.dataset.state = S.error ? 'error' : S.loading && !S.obs ? 'loading' : S.obs ? 'live' : 'idle';
        if (upd) upd.textContent = S.error && !S.obs ? 'Feed unavailable'
            : S.fetchedAt ? `Model data · updated ${agoText(S.fetchedAt, Date.now())}${S.error ? ' · refresh failed' : ''}`
            : S.loading ? 'Connecting…' : '';
    }

    function rebuildReadings() {
        if (!S.obs) { S.readings = null; return; }
        S.readings = buildReadings(S.obs, { nowMs: Date.now(), air: S.air });
    }

    async function load({ quiet = false } = {}) {
        const place = S.hs.view || S.hs.home;
        if (!place) { S.obs = null; S.readings = null; renderAll(); return; }
        S.abort?.abort();
        const ac = new AbortController();
        S.abort = ac;
        S.loading = true;
        if (!quiet) renderAll();
        try {
            const { obs, fetchedAt } = await fetchLabStation(place.lat, place.lon, { signal: ac.signal });
            if (ac.signal.aborted) return;
            S.obs = obs; S.fetchedAt = fetchedAt; S.error = null;
        } catch (e) {
            if (ac.signal.aborted) return;
            S.error = e?.message || 'unavailable';
        } finally {
            if (S.abort === ac) S.loading = false;
        }
        rebuildReadings();
        renderAll();
        startAir(place);
        loadClimate().catch(() => {});
        window.dispatchEvent(new CustomEvent('climate-lab-station', { detail: { obs: S.obs, home: S.hs.home, view: S.hs.view } }));
    }

    // Air quality: the verdict card's per-location feed (EPA NowCast via
    // aqi-scale.js). Optional — the air tile says so when it is absent.
    let airFeed = null;
    async function startAir(place) {
        try {
            if (!airFeed) {
                const { AirQualityFeed } = await import('../air-quality-feed.js');
                airFeed = new AirQualityFeed();
                window.addEventListener('ev-air-update', (ev) => {
                    S.air = ev.detail;
                    rebuildReadings();
                    try { renderBench(); } catch {}
                    window.dispatchEvent(new CustomEvent('climate-lab-air', { detail: S.air }));
                });
                airFeed.start(place);
            } else {
                airFeed.setLocation(place);
            }
        } catch (e) {
            console.info('[climate-lab] air-quality feed unavailable:', e?.message || e);
        }
    }

    async function loadPlaces() {
        if (!listPlaces || !signedIn()) return;
        try {
            const rows = await listPlaces();
            S.places = (rows || []).filter((r) => isNum(r.lat) && isNum(r.lon));
            renderPlaces(); drawMap();
        } catch { /* chips are optional */ }
    }

    // ── Events ──────────────────────────────────────────────────────────────
    const searchEl = q(H.station, 'search');
    async function doSearch() {
        const text = (searchEl?.value || '').trim();
        if (!text) return;
        const btn = q(H.station, 'search-go');
        btn.disabled = true; say('Looking up…', 'info', 0);
        try {
            const loc = await geocodeQuery(text);
            S.userMoved = true;
            if (!S.hs.home) {
                const res = await setHome(loc, { signedIn: signedIn() });
                say(res.scope === 'account' ? `Home set to ${loc.city} and saved to your account.`
                    : res.error ? `Home set on this device — account save failed (${res.error}).`
                    : `Home set to ${loc.city} on this device.`, res.error ? 'warn' : 'ok');
                track('set_home', { via: 'search', scope: res.scope });
            } else {
                visit(loc);
                say(`Visiting ${loc.city}. Your home station stays ${S.hs.home.city}.`, 'ok');
                track('visit', { via: 'search' });
            }
            searchEl.value = '';
        } catch (e) {
            say(e?.message || 'Could not find that place.', 'warn');
        } finally { btn.disabled = false; }
    }
    q(H.station, 'search-go')?.addEventListener('click', doSearch);
    searchEl?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

    q(H.station, 'gps')?.addEventListener('click', () => {
        const btn = q(H.station, 'gps');
        if (!navigator.geolocation) { say('This browser cannot share a position.', 'warn'); return; }
        btn.disabled = true; say('Finding your position…', 'info', 0);
        navigator.geolocation.getCurrentPosition(async (pos) => {
            const { latitude: lat, longitude: lon } = pos.coords;
            let city = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
            try {
                const r = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`, { headers: { 'Accept-Language': 'en' } });
                if (r.ok) {
                    const a = (await r.json())?.address ?? {};
                    city = a.city || a.town || a.village || a.county || a.state || city;
                }
            } catch { /* coordinates are enough */ }
            const loc = { lat, lon, city };
            S.userMoved = true;
            if (!S.hs.home) {
                const res = await setHome(loc, { signedIn: signedIn() });
                say(res.scope === 'account' ? `Home set to ${city} and saved to your account.` : `Home set to ${city} on this device.`, 'ok');
                track('set_home', { via: 'gps', scope: res.scope });
            } else {
                visit(loc);
                say(`Showing your current position (${city}). Home stays ${S.hs.home.city}.`, 'ok');
                track('visit', { via: 'gps' });
            }
            btn.disabled = false;
        }, (err) => {
            btn.disabled = false;
            say({ 1: 'Location permission was denied.', 2: 'Position unavailable.', 3: 'Position request timed out.' }[err.code] || 'Could not get a position.', 'warn');
        }, { timeout: 10_000 });
    });

    H.station.addEventListener('click', async (e) => {
        const act = e.target.closest?.('[data-act]')?.dataset.act;
        const chipBtn = e.target.closest?.('[data-place]');
        if (chipBtn) {
            const c = q(H.station, 'places')?._chips?.[Number(chipBtn.dataset.place)];
            if (c) { S.userMoved = true; visit(c.loc); track('visit', { via: 'chip' }); }
            return;
        }
        if (!act) return;
        if (act !== 'retry') S.userMoved = true;
        if (act === 'go-home' && S.hs.home) { visit(S.hs.home); track('return_home'); }
        if (act === 'retry') load();
        if (act === 'make-home' || act === 'save-home') {
            const place = act === 'make-home' ? S.hs.view : S.hs.home;
            if (!place) return;
            const res = await setHome(place, { signedIn: signedIn() });
            say(res.scope === 'account' ? `${place.city} is now your home station (saved to your account).`
                : res.error ? `Home set on this device — account save failed (${res.error}).`
                : `${place.city} is now your home station on this device.`, res.error ? 'warn' : 'ok');
            track('set_home', { via: act, scope: res.scope });
            S.hs = homeState({ auth, demo });
            renderAll();
        }
    });

    // Customize drawer (delegated — its markup is re-rendered on change).
    const custBtn = q(H.station, 'customize-btn');
    const custEl = q(H.station, 'customize');
    custBtn?.addEventListener('click', () => {
        custEl.hidden = !custEl.hidden;
        custBtn.setAttribute('aria-expanded', String(!custEl.hidden));
        renderCustomize();
        if (!custEl.hidden) track('customize_open');
    });
    custEl?.addEventListener('change', (e) => {
        const t = e.target;
        const p = normalizePrefs(S.prefs);
        if (t.matches('[data-role="preset"]')) { p.units.preset = t.value; commitPrefs(p, 'units', { preset: t.value }); }
        else if (t.dataset.unit) {
            if (t.value) p.units.overrides[t.dataset.unit] = t.value; else delete p.units.overrides[t.dataset.unit];
            commitPrefs(p, 'units_override', { q: t.dataset.unit, u: t.value });
        } else if (t.dataset.instToggle) {
            const id = t.dataset.instToggle;
            p.bench.hidden = t.checked ? p.bench.hidden.filter((x) => x !== id) : [...p.bench.hidden, id];
            commitPrefs(p, 'instrument_toggle', { id, on: t.checked });
        } else if (t.name === 'cl-openat') { p.openAt = t.value; commitPrefs(p, 'open_at', { v: t.value }); }
    });
    custEl?.addEventListener('click', (e) => {
        const mv = e.target.closest?.('[data-inst-move]');
        if (mv) { commitPrefs(moveInstrument(S.prefs, mv.dataset.instMove, Number(mv.dataset.dir)), 'instrument_move', { id: mv.dataset.instMove }); return; }
        if (e.target.closest?.('[data-role="reset"]')) {
            commitPrefs(normalizePrefs({ ...DEFAULT_PREFS, satellites: S.prefs.satellites, watches: S.prefs.watches }), 'reset');
        }
    });

    // Bench sparkline probe (delegated).
    const benchEl = q(H.bench, 'bench');
    benchEl?.addEventListener('pointermove', (e) => {
        const sp = e.target.closest?.('[data-role="spark"]');
        if (!sp) return;
        const tile = sp.closest('.cl-tile');
        const r = S.readings?.readings?.[tile?.dataset.inst];
        if (!r?.spark) return;
        const box = sp.getBoundingClientRect();
        const f = (e.clientX - box.left) / Math.max(1, box.width);
        sparkProbe(tile, Math.round(f * (r.spark.values.length - 1)));
    });
    // pointerout bubbles; only reset when the pointer really left the trace
    // (moving between the trace's own <path>/<circle> children must not).
    benchEl?.addEventListener('pointerout', (e) => {
        const sp = e.target.closest?.('[data-role="spark"]');
        if (sp && !sp.contains(e.relatedTarget)) sparkProbe(sp.closest('.cl-tile'), null);
    });
    benchEl?.addEventListener('focusout', (e) => { const t = e.target.closest?.('.cl-tile'); if (t) sparkProbe(t, null); });
    benchEl?.addEventListener('keydown', (e) => {
        const sp = e.target.closest?.('[data-role="spark"]');
        if (!sp || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
        e.preventDefault();
        const tile = sp.closest('.cl-tile');
        const r = S.readings?.readings?.[tile.dataset.inst];
        const cur = tile._probe ?? r?.spark?.nowIdx ?? 0;
        sparkProbe(tile, cur + (e.key === 'ArrowRight' ? 1 : -1));
    });

    // Meteogram controls + probe.
    H.meteogram?.querySelector('[data-role="mg-span"]')?.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-h]');
        if (!b) return;
        const p = normalizePrefs(S.prefs); p.meteogramHours = Number(b.dataset.h);
        S.probeIdx = null;
        commitPrefs(p, 'meteogram_span', { h: p.meteogramHours });
    });
    q(H.meteogram, 'mg-table-btn')?.addEventListener('click', (e) => {
        S.tableView = !S.tableView;
        e.currentTarget.setAttribute('aria-pressed', String(S.tableView));
        e.currentTarget.textContent = S.tableView ? 'Chart view' : 'Table view';
        renderMeteogram();
    });
    const mgWrap = q(H.meteogram, 'mg');
    mgWrap?.addEventListener('pointermove', (e) => {
        const svg = e.target.closest?.('svg.cl-mg');
        if (!svg || !S.mgLayout) return;
        const box = svg.getBoundingClientRect();
        const x = ((e.clientX - box.left) / Math.max(1, box.width)) * S.mgLayout.width;
        let best = 0;
        S.mgLayout.xs.forEach((xi, i) => { if (Math.abs(xi - x) < Math.abs(S.mgLayout.xs[best] - x)) best = i; });
        probeAt(best);
    });
    mgWrap?.addEventListener('keydown', (e) => {
        if (!e.target.closest?.('svg.cl-mg') || !S.mgLayout) return;
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const start = S.probeIdx ?? S.mgWindow.t.findIndex((t) => t > Date.now());
        probeAt((start < 0 ? 0 : start) + (e.key === 'ArrowRight' ? 1 : -1));
    });

    // Stores → state.
    window.addEventListener('user-location-changed', () => {
        S.hs = homeState({ auth, demo });
        S.climate = null; S.climateFor = null; S.probeIdx = null;
        renderAll();
        load();
    });
    window.addEventListener(PREFS_EVENT, (ev) => {
        S.prefs = ev.detail?.prefs || loadPrefs();
        S.units = resolveUnits(S.prefs.units, navigator.language);
        renderAll();
        renderClimate();
    });
    window.addEventListener('auth-changed', () => {
        const before = S.hs.home;
        S.hs = homeState({ auth, demo });
        // The ACCOUNT home can land after boot (fetchProfile is async, or Home
        // was changed on another device). If nobody has navigated yet and the
        // lab opens at Home, follow it — that is what "default view" means.
        if (!S.userMoved && S.prefs.openAt === 'home' && S.hs.source === 'account'
            && S.hs.home && !sameLocation(S.hs.home, S.hs.view)) {
            visit(S.hs.home);   // → 'user-location-changed' → reload
            return;
        }
        if (!sameLocation(before, S.hs.home)) renderAll();
        loadPlaces();
    });
    window.addEventListener('saved-locations-changed', loadPlaces);

    // Re-lay the meteogram when its column changes width materially.
    if (mgWrap && typeof ResizeObserver !== 'undefined') {
        let lastW = 0, t = null;
        new ResizeObserver(() => {
            const w = mgWrap.clientWidth;
            if (Math.abs(w - lastW) < 40) return;
            lastW = w; clearTimeout(t);
            t = setTimeout(() => { try { renderMeteogram(); } catch {} }, 150);
        }).observe(mgWrap);
    }

    // Map (lazy — the canvas only costs anything once it is on screen).
    try {
        const canvas = q(H.station, 'map');
        if (canvas) { S.map = createWorldMap(canvas); drawMap(); }
    } catch (e) { console.info('[climate-lab] map unavailable:', e?.message || e); }

    // Clocks: station time + "updated" every 30 s; readings roll forward
    // with the hour; data refresh every 15 min (or on return to the tab).
    let lastHour = Math.floor(Date.now() / HOUR);
    const tick = setInterval(() => {
        if (document.hidden) return;
        const clock = q(H.station, 'clock');
        if (clock) clock.textContent = stationClock(Date.now(), S.obs?.station);
        const upd = q(H.station, 'updated');
        if (upd && S.fetchedAt) upd.textContent = `Model data · updated ${agoText(S.fetchedAt, Date.now())}`;
        const hr = Math.floor(Date.now() / HOUR);
        if (hr !== lastHour) { lastHour = hr; rebuildReadings(); renderAll(); }
        if (S.fetchedAt && Date.now() - S.fetchedAt > REFRESH_MS && !S.loading) load({ quiet: true });
        S.map?.draw();
    }, 30_000);
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && S.fetchedAt && Date.now() - S.fetchedAt > REFRESH_MS) load({ quiet: true });
    });

    // Signed-in extras: saved places + cross-device prefs sync.
    loadPlaces();
    if (signedIn()) {
        import('./lab-sync.js').then(({ startLabSync }) => startLabSync({ auth }))
            .then((s) => { S.syncState = s?.state || 'off'; renderCustomize(); })
            .catch(() => {});
    }

    renderAll();
    load();

    return {
        get state() { return S; },
        refresh: () => load(),
        destroy() { clearInterval(tick); S.abort?.abort(); airFeed?.stop?.(); S.map?.destroy(); },
    };
}
