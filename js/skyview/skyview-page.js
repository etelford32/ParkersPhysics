/**
 * skyview-page.js — the SkyView page controller (skyview.html)
 * ═══════════════════════════════════════════════════════════════════════════
 * Glue only: location, clock, view, input, panels. Astronomy lives in
 * sky-engine.js, the catalogue in sky-catalog.js, pixels in sky-renderer.js.
 *
 * ONE EVALUATION PER INSTANT. `recompute()` builds the frame and runs
 * `evaluateSky` once; the chart, the top-10, the top-100 labels, the landmark
 * list and the card all read that one result. Nothing re-derives an altitude.
 *
 * LOCATION is the site-wide current view (`ppx_user_location` via
 * js/user-location.js — the same store every page reads) so setting it here
 * also sets it for EarthView, AurOracle and the dashboard, and vice versa.
 * URL ?lat=&lon= override it for one visit (shareable links, and the browser
 * gate's determinism) without writing it.
 *
 * TAPS ARE POINTERUP within TAP_PX / TAP_MS on `event.timeStamp` — the
 * mars.html / neo-watch rule: a drag that ends on a star is a pan, not a pick,
 * and `performance.now()` in the handler is when the event RAN, not when it
 * happened.
 */

import {
    jdFromMs, msFromJd, skyFrame, horizontalOf, solarSystemObjects, horizonEvents, nextDarkness,
    compassPoint, formatRa, formatDec, formatMag, equatorialToGalactic, SKY_QUALITY,
    DEFAULT_SKY_QUALITY, VISIBILITY_STATUS, BINOCULAR_GAIN,
} from './sky-engine.js';
import { loadSkyCatalog, evaluateSky } from './sky-catalog.js';
import { createView, unprojectAltAz } from './sky-projection.js';
import { SkyRenderer, findObject } from './sky-renderer.js';
import { loadUserLocation, saveUserLocation, geocodeQuery } from '../user-location.js';

export const TOP_N_CHART = 100;
export const TOP_N_LIST = 10;
const TAP_PX = 6, TAP_MS = 650;
const LIVE_TICK_MS = 15_000;
const DEFAULT_LOCATION = Object.freeze({ lat: 51.4779, lon: -0.0015, city: 'Greenwich (default)', isDefault: true });
const LS_PREFS = 'pp_skyview_v1';

const FILTERS = Object.freeze({
    all:   { label: 'All',          test: () => true },
    solar: { label: 'Solar system', test: (o) => o.kind === 'planet' || o.kind === 'moon' || o.kind === 'sun' },
    stars: { label: 'Stars',        test: (o) => o.kind === 'star' },
    deep:  { label: 'Deep sky',     test: (o) => !['planet', 'moon', 'sun', 'star'].includes(o.kind) },
});

const KIND_LABEL = Object.freeze({
    sun: 'Star (our Sun)', moon: 'Moon', planet: 'Planet', star: 'Star',
    galaxy: 'Galaxy', nebula: 'Nebula', 'open-cluster': 'Open cluster', globular: 'Globular cluster',
    asterism: 'Asterism', landmark: 'Galaxy-map object',
});

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function feature(action, meta = {}) {
    import('../telemetry.js').then((m) => m.telemetry.recordFeature('skyview', action, meta)).catch(() => {});
}

function readPrefs() {
    try { return JSON.parse(localStorage.getItem(LS_PREFS) || '{}') || {}; } catch { return {}; }
}
function writePrefs(p) {
    try { localStorage.setItem(LS_PREFS, JSON.stringify(p)); } catch { /* private mode */ }
}

/** "2.3 kly", "4.24 ly", "10.4 Gly" — galaxy-map distances are in light-years. */
export function formatLy(ly) {
    if (!Number.isFinite(ly) || ly <= 0) return '—';
    if (ly < 100) return `${ly.toFixed(ly < 10 ? 2 : 1)} ly`;
    if (ly < 1e5) return `${Math.round(ly).toLocaleString()} ly`;
    if (ly < 1e8) return `${(ly / 1e6).toFixed(ly < 1e7 ? 2 : 1)} million ly`;
    return `${(ly / 1e9).toFixed(ly < 1e10 ? 2 : 1)} billion ly`;
}

// Times are in THIS DEVICE's zone and say which (there is no time-zone database
// for an arbitrary lat/lon here) — a bare "3:47 PM" for a place three zones away
// would read as that place's local time.
function formatClock(ms, withDate = false) {
    const d = new Date(ms);
    const t = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
    return withDate ? `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${t}` : t;
}
function formatRelative(ms, nowMs) {
    const m = Math.round((ms - nowMs) / 60000);
    if (Math.abs(m) < 1) return 'now';
    const a = Math.abs(m), h = Math.floor(a / 60), mm = a % 60;
    const s = h ? `${h} h ${String(mm).padStart(2, '0')} m` : `${mm} m`;
    return m > 0 ? `in ${s}` : `${s} ago`;
}

export class SkyViewPage {
    constructor(doc = document) {
        this.doc = doc;
        this.$ = (id) => doc.getElementById(id);
        const params = new URLSearchParams(location.search);
        const prefs = readPrefs();
        const plat = parseFloat(params.get('lat')), plon = parseFloat(params.get('lon'));
        const stored = loadUserLocation();
        this.loc = Number.isFinite(plat) && Number.isFinite(plon)
            ? { lat: plat, lon: plon, city: params.get('place') || `${plat.toFixed(2)}, ${plon.toFixed(2)}`, fromUrl: true }
            : (stored && Number.isFinite(stored.lat) ? stored : { ...DEFAULT_LOCATION });
        const t = Date.parse(params.get('t') ?? '');
        this.live = !Number.isFinite(t);
        this.timeMs = Number.isFinite(t) ? t : Date.now();
        this.anchorMs = this.timeMs;                     // the slider's zero
        this.skyQuality = SKY_QUALITY[params.get('sky')] ? params.get('sky') : (SKY_QUALITY[prefs.sky] ? prefs.sky : DEFAULT_SKY_QUALITY);
        this.viewMode = params.get('view') === 'look' ? 'look' : 'dome';
        this.look = {
            alt: Number.isFinite(parseFloat(params.get('alt'))) ? parseFloat(params.get('alt')) : 25,
            az: Number.isFinite(parseFloat(params.get('az'))) ? parseFloat(params.get('az')) : 180,
            fov: Number.isFinite(parseFloat(params.get('fov'))) ? parseFloat(params.get('fov')) : 80,
        };
        this.layers = {
            constellations: true, labels: true, grid: false, milkyWay: true,
            landmarks: true, ecliptic: false, galactic: false, ...(prefs.layers ?? {}),
        };
        this.filter = 'all';
        this.selectedKey = params.get('select') || null;
        this.hoverKey = null;
        this.cat = null;
        this.sky = null;
        this._eventsCache = new Map();
    }

    async start() {
        this.renderer = new SkyRenderer(this.$('sv-canvas'));
        this._wireControls();
        this._wireCanvas();
        this._syncControls();
        this._resize();
        new ResizeObserver(() => this._resize()).observe(this.$('sv-canvas-wrap'));
        window.addEventListener('user-location-changed', (e) => {
            if (e.detail && Number.isFinite(e.detail.lat) && !this.loc.fromUrl) this.setLocation(e.detail, { save: false });
        });
        try {
            this.cat = await loadSkyCatalog();
        } catch (err) {
            this._status(`Could not load the star catalogue (${esc(err.message)}). Reload to try again.`, true);
            return;
        }
        this._status('');
        this.recompute();
        this._liveTimer = setInterval(() => { if (this.live && !document.hidden) { this.timeMs = Date.now(); this.anchorMs = this.timeMs; this.recompute(); } }, LIVE_TICK_MS);
        this.ready = true;
        this.doc.body.dataset.skyviewReady = '1';
    }

    // ── state changes ────────────────────────────────────────────────────────

    setLocation(loc, { save = true } = {}) {
        this.loc = { ...loc, isDefault: false };
        if (save) saveUserLocation({ lat: loc.lat, lon: loc.lon, city: loc.city, displayName: loc.displayName ?? loc.city });
        this._eventsCache.clear();
        this._syncControls();
        this.recompute();
    }

    setTime(ms, { live = false } = {}) {
        this.live = live;
        this.timeMs = ms;
        if (live) this.anchorMs = ms;
        this._syncControls();
        this.recompute();
    }

    select(key, { fly = false } = {}) {
        this.selectedKey = key;
        if (key && fly && this.viewMode === 'look') {
            const o = this.sky && findObject(this.sky, key);
            if (o) { this.look.az = o.azDeg; this.look.alt = Math.max(5, o.altDeg); }
        }
        if (key) feature('select', { key: key.slice(0, 40) });
        this.recompute({ geometryOnly: true });
    }

    setViewMode(mode) {
        this.viewMode = mode;
        this._syncControls();
        this._draw();
    }

    // ── evaluation + drawing ─────────────────────────────────────────────────

    recompute({ geometryOnly = false } = {}) {
        if (!this.cat) return;
        if (!geometryOnly || !this.sky) {
            this.frame = skyFrame(jdFromMs(this.timeMs), this.loc.lat, this.loc.lon);
            this.sky = evaluateSky(this.cat, this.frame, { skyQuality: this.skyQuality });
            this.top = this.sky.ranked.slice(0, TOP_N_CHART);
            this.topKeys = new Map(this.top.map((o) => [o.key, o.rank]));
        }
        this._draw();
        this._renderEnv();
        this._renderTop();
        this._renderCard();
        this._renderLandmarks();
    }

    _view() {
        const { w, h } = this._size;
        return createView({
            mode: this.viewMode, width: w, height: h,
            centerAltDeg: this.look.alt, centerAzDeg: this.look.az, fovDeg: this.look.fov,
        });
    }

    _draw() {
        if (!this.sky || !this._size) return;
        this.view = this._view();
        this.renderer.draw({
            view: this.view, frame: this.frame, cat: this.cat, sky: this.sky, layers: this.layers,
            topKeys: this.topKeys, selectedKey: this.selectedKey, hoverKey: this.hoverKey,
        });
    }

    _resize() {
        const wrap = this.$('sv-canvas-wrap');
        const w = Math.max(200, Math.floor(wrap.clientWidth));
        const h = Math.max(200, Math.floor(wrap.clientHeight));
        this._size = { w, h };
        this.renderer.resize(w, h);
        this._draw();
    }

    // ── panels ───────────────────────────────────────────────────────────────

    _status(msg, isError = false) {
        const el = this.$('sv-status');
        el.textContent = msg;
        el.hidden = !msg;
        el.classList.toggle('is-error', isError);
    }

    _renderEnv() {
        const { env } = this.sky;
        const moon = env.moon;
        const lim = env.limit;
        const who = env.regime === 'day' ? 'daylight'
            : env.twilight < env.site - env.moonPenalty ? 'twilight'
            : env.moonPenalty > 0.25 ? 'moonlight' : `${SKY_QUALITY[this.skyQuality].label.toLowerCase()} sky`;
        this.$('sv-env').innerHTML = `
          <div class="sv-env-row"><span>Sky</span><b>${esc(env.regime)}</b></div>
          <div class="sv-env-row" title="The faintest magnitude your eye can reach at the zenith right now: the brighter of the twilight ceiling and your site's dark-sky limit, minus moonlight. Empirical, not a radiative-transfer model.">
            <span>Faintest visible</span><b>mag ${formatMag(lim)}</b><em>set by ${esc(who)}</em></div>
          <div class="sv-env-row"><span>Sun</span><b>${env.sunAltDeg.toFixed(1)}°</b><em>${env.sunAltDeg > 0 ? 'up' : 'below horizon'}</em></div>
          <div class="sv-env-row"><span>Moon</span><b>${moon.altDeg.toFixed(1)}°</b><em>${esc(moon.phaseName)} · ${Math.round(moon.illuminated * 100)}% lit</em></div>`;
        this.$('sv-hero-limit').textContent = `faintest visible: mag ${formatMag(lim)}`;
        this.$('sv-hero-regime').textContent = env.regime;
    }

    _statusChip(o) {
        const st = o.vis.status;
        const label = VISIBILITY_STATUS[st]?.label ?? st;
        return `<span class="sv-chip sv-chip--${st}">${esc(label)}</span>`;
    }

    _renderTop() {
        const list = this.$('sv-top-list');
        const f = FILTERS[this.filter] ?? FILTERS.all;
        const rows = this.sky.ranked.filter(f.test).slice(0, TOP_N_LIST);
        if (!rows.length) {
            list.innerHTML = `<li class="sv-empty">Nothing in this group is above your horizon right now.</li>`;
            return;
        }
        list.innerHTML = rows.map((o) => `
          <li class="sv-top-item${o.key === this.selectedKey ? ' is-selected' : ''}" data-key="${esc(o.key)}" tabindex="0" role="button"
              aria-label="${esc(o.name)}, magnitude ${formatMag(o.mag)}, ${o.altDeg.toFixed(0)} degrees up in the ${compassPoint(o.azDeg)}">
            <span class="sv-rank">${o.rank}</span>
            <span class="sv-top-main">
              <span class="sv-top-name">${esc(o.name)}</span>
              <span class="sv-top-sub">${esc(KIND_LABEL[o.kind] ?? o.kind)} · mag ${formatMag(o.mag)} · ${o.altDeg.toFixed(0)}° ${compassPoint(o.azDeg)}</span>
            </span>
            ${this._statusChip(o)}
          </li>`).join('');
        const count = this.sky.ranked.filter((o) => o.vis.margin >= 0).length;
        this.$('sv-top-count').textContent = `${count} naked-eye object${count === 1 ? '' : 's'} up · chart labels the top ${Math.min(TOP_N_CHART, this.sky.ranked.length)}`;
    }

    _renderLandmarks() {
        const up = this.sky.landmarks.filter((o) => o.altDeg > 0)
            .sort((a, b) => (a.galactic.distLy ?? 0) - (b.galactic.distLy ?? 0));
        const el = this.$('sv-landmarks');
        if (!up.length) { el.innerHTML = '<p class="sv-muted">None of the galaxy map\'s invisible objects are above your horizon right now.</p>'; return; }
        el.innerHTML = `<ul class="sv-lm-list">${up.map((o) => `
          <li data-key="${esc(o.key)}" tabindex="0" role="button" class="${o.key === this.selectedKey ? 'is-selected' : ''}">
            <span class="sv-lm-name">${esc(o.name)}</span>
            <span class="sv-lm-sub">${esc(formatLy(o.galactic.distLy))} · ${o.altDeg.toFixed(0)}° ${compassPoint(o.azDeg)}</span>
          </li>`).join('')}</ul>`;
    }

    _events(o) {
        // Rise / culmination / set over the next 24 h, cached per object per 10 min.
        const bucket = Math.floor(this.timeMs / 600_000);
        const ck = `${o.key}|${bucket}|${this.loc.lat}|${this.loc.lon}`;
        if (this._eventsCache.has(ck)) return this._eventsCache.get(ck);
        const lat = this.loc.lat, lon = this.loc.lon;
        const solar = o.kind === 'sun' || o.kind === 'moon' || o.kind === 'planet';
        const altFn = solar
            ? (jd) => { const f = skyFrame(jd, lat, lon); const b = solarSystemObjects(f).find((x) => x.id === o.id); return horizontalOf(f, b.raDeg, b.decDeg).altDeg; }
            : (jd) => horizontalOf(skyFrame(jd, lat, lon), o.raDeg, o.decDeg).altDeg;
        // Geometric altitude of the CENTRE at the standard rise: −0.5667° (refraction)
        // for points, −0.8333° (refraction + semidiameter) for the Sun and Moon. The
        // Moon's position is already topocentric, so no parallax term is added.
        const h0 = o.kind === 'sun' || o.kind === 'moon' ? -0.8333 : -0.5667;
        const ev = horizonEvents(altFn, jdFromMs(this.timeMs), { spanDays: 1, h0, stepMin: solar ? 20 : 15 });
        this._eventsCache.set(ck, ev);
        if (this._eventsCache.size > 60) this._eventsCache.delete(this._eventsCache.keys().next().value);
        return ev;
    }

    _renderCard() {
        const card = this.$('sv-card');
        const o = this.selectedKey && this.sky ? findObject(this.sky, this.selectedKey) : null;
        if (!o) {
            card.innerHTML = '<p class="sv-muted">Tap anything on the chart — or a row in the list — to see where it is, when it rises and sets, and what it is.</p>';
            return;
        }
        const g = o.galactic;
        const gal = equatorialToGalactic(o.raDeg, o.decDeg);
        const ev = this._events(o);
        const t = (jd) => jd == null ? '—' : `${formatClock(msFromJd(jd))} <em>${formatRelative(msFromJd(jd), this.timeMs)}</em>`;
        const rows = [];
        rows.push(['Where', o.altDeg > 0
            ? `<b>${o.altDeg.toFixed(1)}°</b> up, toward the <b>${compassPoint(o.azDeg)}</b> (az ${o.azDeg.toFixed(0)}°)`
            : `Below your horizon (${o.altDeg.toFixed(1)}°)`]);
        if (Number.isFinite(o.mag)) {
            rows.push(['Brightness', `mag ${formatMag(o.mag)}${o.vis.extinction > 0.05 ? ` · ${formatMag(o.vis.mObs)} through ${o.vis.extinction.toFixed(1)} mag of air` : ''}`]);
            if (Number.isFinite(o.vis.margin)) {
                const m = o.vis.margin;
                rows.push(['Visibility', m >= 0
                    ? `${this._statusChip(o)} ${m.toFixed(1)} mag above tonight's limit`
                    : `${this._statusChip(o)} ${(-m).toFixed(1)} mag too faint for the eye${-m <= BINOCULAR_GAIN ? ' — binoculars reach it' : ''}`]);
            }
        } else if (o.kind === 'landmark') {
            rows.push(['Visibility', `<span class="sv-chip sv-chip--nomag">Invisible to the eye</span> ${g?.magNote ? `(${esc(g.magNote)})` : ''}`]);
        }
        if (ev.circumpolar) rows.push(['Rise / set', 'Never sets from here (circumpolar)']);
        else if (ev.neverRises) rows.push(['Rise / set', 'Never rises from here today']);
        else rows.push(['Rises', t(ev.rise)], ['Sets', t(ev.set)]);
        if (ev.transit && !ev.neverRises) rows.push(['Highest', `${ev.transit.altDeg.toFixed(0)}° at ${t(ev.transit.jd)}`]);
        rows.push(['RA / Dec', `${formatRa(o.raDeg)} · ${formatDec(o.decDeg)} <em>J2000</em>`]);
        rows.push(['Galactic', `l ${gal.lDeg.toFixed(2)}° · b ${gal.bDeg.toFixed(2)}°`]);
        if (o.kind === 'moon') rows.push(['Phase', `${esc(o.phaseName)} · ${Math.round(o.illuminated * 100)}% lit · ${Math.round(o.distKm).toLocaleString()} km`]);
        if (o.kind === 'planet') rows.push(['Distance', `${o.distAU.toFixed(3)} AU · ${(o.angDiamArcsec).toFixed(1)}″ across · ${Math.round(o.illuminated * 100)}% lit`]);
        if (o.kind === 'planet' && o.id === 'saturn') rows.push(['Rings', `tilted ${Math.abs(o.ringTiltDeg).toFixed(1)}° toward us`]);
        if (g?.distLy != null && o.kind !== 'sun') rows.push(['Distance', esc(formatLy(g.distLy))]);
        const links = [];
        if (g?.link) links.push(`<a class="sv-link" href="${esc(g.link)}">Open the ${esc(g.abbr ?? g.name)} simulation ›</a>`);
        if (g) links.push(`<a class="sv-link" href="galactic-map.html?focus=${encodeURIComponent(g.id)}">See it in the Galaxy Map ›</a>`);
        if (o.kind === 'sun') links.push('<a class="sv-link" href="sun.html">Open the live Sun ›</a>');
        if (o.kind === 'moon') links.push('<a class="sv-link" href="moon.html">Open the Moon ›</a>');
        if (o.id === 'mars') links.push('<a class="sv-link" href="mars.html">Open Real-Time Mars ›</a>');
        if (['jupiter', 'saturn', 'uranus', 'neptune'].includes(o.id)) links.push(`<a class="sv-link" href="${o.id}-system.html">Open the ${esc(o.name)} system ›</a>`);
        const warn = o.kind === 'sun' ? '<p class="sv-warn">Never look at the Sun directly or through binoculars or a telescope without a certified solar filter.</p>' : '';
        card.innerHTML = `
          <div class="sv-card-head">
            <h3>${esc(o.name)}</h3>
            <span class="sv-card-kind">${esc(KIND_LABEL[o.kind] ?? o.kind)}${o.designation ? ` · ${esc(o.designation)}` : ''}${g?.type && o.kind !== 'landmark' ? ` · ${esc(g.type)}` : ''}</span>
          </div>
          ${warn}
          <dl class="sv-card-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
          ${g?.desc ? `<p class="sv-card-desc">${esc(g.desc)}</p>` : ''}
          ${links.length ? `<div class="sv-card-links">${links.join('')}</div>` : ''}`;
    }

    _syncControls() {
        const $ = this.$;
        $('sv-loc-label').textContent = this.loc.city || `${this.loc.lat.toFixed(2)}, ${this.loc.lon.toFixed(2)}`;
        $('sv-loc-coords').textContent = `${Math.abs(this.loc.lat).toFixed(2)}°${this.loc.lat >= 0 ? 'N' : 'S'} · ${Math.abs(this.loc.lon).toFixed(2)}°${this.loc.lon >= 0 ? 'E' : 'W'}`;
        $('sv-loc-note').hidden = !this.loc.isDefault;
        $('sv-time-live').classList.toggle('is-on', this.live);
        $('sv-time-live').setAttribute('aria-pressed', String(this.live));
        const offMin = Math.round((this.timeMs - this.anchorMs) / 60000);
        const slider = $('sv-time-slider');
        slider.value = String(Math.max(Number(slider.min), Math.min(Number(slider.max), offMin)));
        $('sv-time-label').textContent = formatClock(this.timeMs, true);
        $('sv-time-utc').textContent = `${new Date(this.timeMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        $('sv-hero-live').textContent = this.live ? 'LIVE' : 'TIME-SHIFTED';
        $('sv-hero-live').classList.toggle('is-shifted', !this.live);
        $('sv-quality').value = this.skyQuality;
        for (const b of this.doc.querySelectorAll('[data-view]')) {
            const on = b.dataset.view === this.viewMode;
            b.classList.toggle('is-on', on);
            b.setAttribute('aria-pressed', String(on));
        }
        $('sv-look-tools').hidden = this.viewMode !== 'look';
        for (const b of this.doc.querySelectorAll('[data-filter]')) b.classList.toggle('is-on', b.dataset.filter === this.filter);
        for (const i of this.doc.querySelectorAll('input[data-layer]')) i.checked = !!this.layers[i.dataset.layer];
    }

    // ── controls ─────────────────────────────────────────────────────────────

    _wireControls() {
        const $ = this.$;
        $('sv-time-live').addEventListener('click', () => { feature('live'); this.setTime(Date.now(), { live: true }); });
        $('sv-time-slider').addEventListener('input', (e) => {
            this.live = false;
            this.timeMs = this.anchorMs + Number(e.target.value) * 60000;
            this._syncControls();
            if (!this._scrubRaf) this._scrubRaf = requestAnimationFrame(() => { this._scrubRaf = 0; this.recompute(); });
        });
        $('sv-time-tonight').addEventListener('click', () => this.goTonight());
        $('sv-quality').addEventListener('change', (e) => {
            this.skyQuality = e.target.value;
            writePrefs({ ...readPrefs(), sky: this.skyQuality });
            feature('sky_quality', { q: this.skyQuality });
            this.recompute();
        });
        for (const i of this.doc.querySelectorAll('input[data-layer]')) {
            i.addEventListener('change', () => {
                this.layers[i.dataset.layer] = i.checked;
                writePrefs({ ...readPrefs(), layers: this.layers });
                this._draw();
            });
        }
        for (const b of this.doc.querySelectorAll('[data-view]')) {
            b.addEventListener('click', () => { feature('view', { mode: b.dataset.view }); this.setViewMode(b.dataset.view); });
        }
        for (const b of this.doc.querySelectorAll('[data-face]')) {
            b.addEventListener('click', () => { this.look.az = Number(b.dataset.face); this.look.alt = 25; this._draw(); });
        }
        $('sv-zoom-in').addEventListener('click', () => this._zoom(1 / 1.35));
        $('sv-zoom-out').addEventListener('click', () => this._zoom(1.35));
        for (const b of this.doc.querySelectorAll('[data-filter]')) {
            b.addEventListener('click', () => { this.filter = b.dataset.filter; this._syncControls(); this._renderTop(); });
        }
        const pickRow = (e) => {
            const li = e.target.closest('[data-key]');
            if (!li) return;
            if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            this.select(li.dataset.key, { fly: true });
        };
        for (const id of ['sv-top-list', 'sv-landmarks']) {
            $(id).addEventListener('click', pickRow);
            $(id).addEventListener('keydown', pickRow);
        }
        const doSearch = async () => {
            const q = $('sv-loc-input').value.trim();
            if (!q) return;
            $('sv-loc-msg').textContent = 'Searching…';
            try {
                const r = await geocodeQuery(q);
                $('sv-loc-msg').textContent = '';
                feature('locate', { via: 'search' });
                this.setLocation({ lat: r.lat, lon: r.lon, city: r.city, displayName: r.displayName });
            } catch (err) {
                $('sv-loc-msg').textContent = err.message;
            }
        };
        $('sv-loc-search').addEventListener('click', doSearch);
        $('sv-loc-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
        $('sv-loc-gps').addEventListener('click', () => {
            if (!navigator.geolocation) { $('sv-loc-msg').textContent = 'This browser cannot share a location.'; return; }
            $('sv-loc-msg').textContent = 'Asking your browser…';
            navigator.geolocation.getCurrentPosition((pos) => {
                $('sv-loc-msg').textContent = '';
                feature('locate', { via: 'gps' });
                this.setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, city: 'My location' });
            }, (err) => { $('sv-loc-msg').textContent = err.code === 1 ? 'Location permission was declined.' : 'Could not get a location.'; },
            { enableHighAccuracy: false, timeout: 12_000, maximumAge: 600_000 });
        });
        this.doc.addEventListener('keydown', (e) => {
            if (this.viewMode !== 'look' || e.target.closest('input, select, textarea')) return;
            const step = this.look.fov / 12;
            const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
            if (k) { e.preventDefault(); this.look.az = (this.look.az + k[0] + 360) % 360; this.look.alt = Math.max(0, Math.min(89, this.look.alt + k[1])); this._draw(); }
            else if (e.key === '+' || e.key === '=') this._zoom(1 / 1.35);
            else if (e.key === '-') this._zoom(1.35);
        });
    }

    goTonight() {
        const jd = jdFromMs(Date.now());
        let dk = null, depth = null;
        for (const lim of [-18, -12, -6]) {
            dk = nextDarkness(jd, this.loc.lat, this.loc.lon, { sunLimitDeg: lim, spanDays: 1.5 });
            if (dk) { depth = lim; break; }
        }
        feature('tonight', { depth });
        if (!dk) { this.$('sv-time-msg').textContent = 'The Sun does not set far enough tonight for a dark sky here.'; return; }
        // An hour into the darkness (or now, if it is already dark).
        const target = dk.alreadyDark ? Date.now() : msFromJd(dk.start) + 3_600_000;
        this.$('sv-time-msg').textContent = depth === -18 ? ''
            : `No full darkness here tonight — showing ${depth === -12 ? 'nautical' : 'civil'} twilight, the darkest it gets.`;
        this.anchorMs = Date.now();
        this.setTime(target);
    }

    _zoom(f) {
        if (this.viewMode !== 'look') { this.setViewMode('look'); return; }
        this.look.fov = Math.max(8, Math.min(150, this.look.fov * f));
        this._draw();
    }

    _wireCanvas() {
        const cv = this.$('sv-canvas');
        const tip = this.$('sv-tip');
        let down = null;
        const local = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
        cv.addEventListener('pointerdown', (e) => {
            const p = local(e);
            down = { ...p, t: e.timeStamp, id: e.pointerId, moved: false, alt0: this.look.alt, az0: this.look.az };
            try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        });
        cv.addEventListener('pointermove', (e) => {
            const p = local(e);
            if (down && e.pointerId === down.id) {
                if (Math.hypot(p.x - down.x, p.y - down.y) > TAP_PX) down.moved = true;
                if (down.moved && this.viewMode === 'look' && this.view) {
                    const dpp = this.look.fov / Math.min(this.view.width, this.view.height);
                    this.look.az = (down.az0 - (p.x - down.x) * dpp + 360) % 360;
                    this.look.alt = Math.max(0, Math.min(89, down.alt0 + (p.y - down.y) * dpp));
                    this._draw();
                }
                return;
            }
            if (this._hoverRaf) return;
            this._hoverRaf = requestAnimationFrame(() => {
                this._hoverRaf = 0;
                const key = this.renderer.pick(p.x, p.y, 14);
                if (key !== this.hoverKey) { this.hoverKey = key; this._draw(); }
                const o = key && this.sky ? findObject(this.sky, key) : null;
                if (o) {
                    tip.hidden = false;
                    tip.style.left = `${p.x + 14}px`;
                    tip.style.top = `${p.y + 12}px`;
                    tip.innerHTML = `<b>${esc(o.name)}</b><span>${esc(KIND_LABEL[o.kind] ?? o.kind)}${Number.isFinite(o.mag) ? ` · mag ${formatMag(o.mag)}` : ''} · ${o.altDeg.toFixed(0)}° ${compassPoint(o.azDeg)}</span>`;
                    cv.style.cursor = 'pointer';
                } else {
                    tip.hidden = true;
                    cv.style.cursor = this.viewMode === 'look' ? 'grab' : 'default';
                    const aa = this.view ? unprojectAltAz(this.view, p.x, p.y) : null;
                    this.$('sv-cursor').textContent = aa && aa.altDeg >= 0 ? `alt ${aa.altDeg.toFixed(0)}° · az ${aa.azDeg.toFixed(0)}° ${compassPoint(aa.azDeg)}` : '';
                }
            });
        });
        const end = (e) => {
            if (!down || e.pointerId !== down.id) return;
            const p = local(e);
            const tap = !down.moved && (e.timeStamp - down.t) < TAP_MS;
            down = null;
            if (!tap) return;
            const key = this.renderer.pick(p.x, p.y, 18);
            this.select(key);
        };
        cv.addEventListener('pointerup', end);
        cv.addEventListener('pointercancel', () => { down = null; });
        cv.addEventListener('pointerleave', () => { tip.hidden = true; if (this.hoverKey) { this.hoverKey = null; this._draw(); } });
        cv.addEventListener('dblclick', (e) => {
            const p = local(e);
            const aa = unprojectAltAz(this.view, p.x, p.y);
            if (aa.altDeg < 0) return;
            this.look = { alt: Math.max(5, aa.altDeg), az: aa.azDeg, fov: this.viewMode === 'look' ? Math.max(8, this.look.fov / 2) : 60 };
            this.setViewMode('look');
        });
        cv.addEventListener('wheel', (e) => {
            if (this.viewMode !== 'look') return;
            e.preventDefault();
            this._zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15);
        }, { passive: false });
    }
}
