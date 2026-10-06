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
import { loadSkyCatalog, evaluateSky, galacticKey } from './sky-catalog.js';
import {
    buildNightGrid, forecastVisibility, fixedTarget, bodyTarget, pathSamples, sameTimeSamples,
    seasonPeakJd, nightNoonJd, NIGHTLY_DRIFT_DEG, NIGHTLY_EARLIER_MIN, DEFAULT_MIN_ALT_DEG,
} from './sky-predict.js';
import { renderForecastChart, sparklineSvg, describeWindow, clockOf, nightDate } from './skyview-forecast-ui.js';
import { createView, unprojectAltAz } from './sky-projection.js';
import { SkyRenderer, findObject } from './sky-renderer.js';
import { loadUserLocation, saveUserLocation, geocodeQuery } from '../user-location.js';

export const TOP_N_CHART = 100;
export const TOP_N_LIST = 10;
const TAP_PX = 6, TAP_MS = 650;
const LIVE_TICK_MS = 15_000;
const DEFAULT_LOCATION = Object.freeze({ lat: 51.4779, lon: -0.0015, city: 'Greenwich (default)', isDefault: true });
const LS_PREFS = 'pp_skyview_v1';

/** How far ahead the forecast looks (nights). */
export const FORECAST_NIGHTS = 30;
/**
 * Tracked objects. Colour is assigned to the OBJECT when it is tracked and kept
 * until it is untracked (colour follows the entity, never its rank). Three
 * slots — the dataviz palette's first three, which are the ones that validate
 * ALL-PAIRS for colour-vision deficiency on this dark sky (run 2026-10-05:
 * worst CVD ΔE 9.4, normal 20.9, all ≥ 3:1). A fourth would put yellow beside
 * orange, which fails; so the cap is a colour rule, not a whim.
 */
export const TRACK_COLORS = Object.freeze(['#3987e5', '#d95926', '#199e70']);
export const MAX_TRACKS = TRACK_COLORS.length;

/** Slider spans, in minutes from the forecast start, and how many nights of same-time dots to draw. */
export const RANGES = Object.freeze({
    tonight: { label: 'Tonight',   min: -720, max: 36 * 60,  step: 5,  nights: 7 },
    week:    { label: '7 nights',  min: -720, max: 7 * 1440, step: 10, nights: 7 },
    month:   { label: '30 nights', min: -720, max: 30 * 1440, step: 30, nights: 30 },
});
/** Playback speeds. `perNight` steps one CLOCK day at a time: the same moment each night. */
export const SPEEDS = Object.freeze({
    '10m':   { label: '10 min / s', rate: 600 },
    '1h':    { label: '1 h / s', rate: 3600 },
    '4h':    { label: '4 h / s', rate: 14_400 },
    night:   { label: 'Nightly (same clock time)', perNight: true, secondsPerNight: 0.7 },
});
const BODY_KINDS = new Set(['sun', 'moon', 'planet']);

const FILTERS = Object.freeze({
    all:   { label: 'All',          test: () => true },
    solar: { label: 'Solar system', test: (o) => o.kind === 'planet' || o.kind === 'moon' || o.kind === 'sun' },
    stars: { label: 'Stars',        test: (o) => o.kind === 'star' },
    deep:  { label: 'Deep sky',     test: (o) => !['planet', 'moon', 'sun', 'star'].includes(o.kind) },
    galaxy: { label: 'Galaxy map',  test: (o) => !!o.galactic },
});

const GAL_FILTERS = Object.freeze({
    all:        { label: 'All',            test: () => true },
    eye:        { label: 'Naked eye',      test: (o) => Number.isFinite(o.mag) && o.mag <= 6.5 },
    instrument: { label: 'Instrument only', test: (o) => !(Number.isFinite(o.mag) && o.mag <= 6.5) },
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
        this.range = RANGES[params.get('range')] ? params.get('range') : 'tonight';
        this.speed = SPEEDS[prefs.speed] ? prefs.speed : '1h';
        this.playing = false;
        this.minAltDeg = [0, 10, 20, 30].includes(prefs.minAlt) ? prefs.minAlt : DEFAULT_MIN_ALT_DEG;
        this.galFilter = 'all';
        // Tracks: ?track=a,b (keys) > saved > the galactic centre, so a first
        // visit shows the core of the galaxy wheeling across tonight's sky.
        const urlTracks = params.get('track');
        const saved = Array.isArray(prefs.tracks) ? prefs.tracks : null;
        const keys = (urlTracks != null ? urlTracks.split(',').filter(Boolean) : saved ?? ['gal:sgr_a']).slice(0, MAX_TRACKS);
        this.tracked = keys.map((key, i) => ({ key, color: TRACK_COLORS[i] }));
        this.layers.trackArc ??= true;
        this.layers.trackNights ??= true;
        this._nightCache = new Map();
        this._forecast = null;          // { key, grid, byKey: Map }
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
        this._scheduleForecast();
        this._liveTimer = setInterval(() => {
            if (this.live && !this.playing && !document.hidden) {
                this.timeMs = Date.now(); this.anchorMs = this.timeMs;
                this.recompute();
                this._scheduleForecast();
            }
        }, LIVE_TICK_MS);
        this.ready = true;
        this.doc.body.dataset.skyviewReady = '1';
    }

    // ── state changes ────────────────────────────────────────────────────────

    setLocation(loc, { save = true } = {}) {
        this.loc = { ...loc, isDefault: false };
        if (save) saveUserLocation({ lat: loc.lat, lon: loc.lon, city: loc.city, displayName: loc.displayName ?? loc.city });
        this._eventsCache.clear();
        this._nightCache.clear();
        this._syncControls();
        this.recompute();
        this._scheduleForecast();
    }

    /**
     * Move the clock. `anchor` re-bases the slider (and therefore the 30-night
     * forecast) on this instant; scrubbing inside the range never does, so a
     * month-long scrub never rebuilds the forecast it is reading.
     */
    setTime(ms, { live = false, anchor = live } = {}) {
        this.live = live;
        this.timeMs = ms;
        if (anchor) this.anchorMs = ms;
        if (live) this.pause();
        this._syncControls();
        this.recompute();
        if (anchor) this._scheduleForecast();
    }

    setRange(id) {
        if (!RANGES[id]) return;
        this.range = id;
        const r = RANGES[id];
        const off = (this.timeMs - this.anchorMs) / 60000;
        if (off < r.min || off > r.max) this.timeMs = this.anchorMs + Math.max(r.min, Math.min(r.max, off)) * 60000;
        feature('range', { range: id });
        this._syncControls();
        this.recompute();
    }

    /** Step by hours or by whole nights (one CLOCK day = the same moment next night). */
    step(minutes) {
        this.live = false;
        this.timeMs += minutes * 60000;
        const r = RANGES[this.range];
        const off = (this.timeMs - this.anchorMs) / 60000;
        if (off > r.max || off < r.min) this.setRange(off > RANGES.week.max || off < RANGES.week.min ? 'month' : 'week');
        this._syncControls();
        this.recompute();
    }

    play() {
        if (this.playing) return;
        this.playing = true;
        this.live = false;
        const r = RANGES[this.range];
        if ((this.timeMs - this.anchorMs) / 60000 >= r.max - r.step) this.timeMs = this.anchorMs;   // replay from the start
        feature('play', { speed: this.speed, range: this.range });
        let last = null, acc = 0, lastCompute = 0;
        const tick = (ts) => {
            if (!this.playing) return;
            if (last == null) last = ts;
            const dt = Math.min(0.25, (ts - last) / 1000);
            last = ts;
            const sp = SPEEDS[this.speed];
            if (sp.perNight) {
                acc += dt;
                while (acc >= sp.secondsPerNight) { this.timeMs += 86_400_000; acc -= sp.secondsPerNight; }
            } else {
                this.timeMs += dt * sp.rate * 1000;
            }
            const rr = RANGES[this.range];
            if ((this.timeMs - this.anchorMs) / 60000 > rr.max) {
                this.timeMs = this.anchorMs + rr.max * 60000;
                this.pause();
            }
            if (ts - lastCompute > 60 || !this.playing) {
                lastCompute = ts;
                this._syncControls();
                this.recompute();
            }
            if (this.playing) this._raf = requestAnimationFrame(tick);
        };
        this._syncControls();
        this._raf = requestAnimationFrame(tick);
    }

    pause() {
        this.playing = false;
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
        this._syncControls?.();
    }

    isTracked(key) { return this.tracked.some((t) => t.key === key); }

    /** Track / untrack. Colour stays with the object; a 4th track drops the oldest. */
    toggleTrack(key) {
        if (!key) return;
        if (this.isTracked(key)) {
            this.tracked = this.tracked.filter((t) => t.key !== key);
        } else {
            if (this.tracked.length >= MAX_TRACKS) this.tracked.shift();
            const used = new Set(this.tracked.map((t) => t.color));
            this.tracked.push({ key, color: TRACK_COLORS.find((c) => !used.has(c)) });
            feature('track', { key: key.slice(0, 40) });
        }
        writePrefs({ ...readPrefs(), tracks: this.tracked.map((t) => t.key) });
        this.recompute({ geometryOnly: true });
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
        this.tracks = this._computeTracks();
        this._draw();
        this._renderEnv();
        this._renderTop();
        this._renderCard();
        this._renderGalactic();
        this._renderTracks();
    }

    // ── prediction ───────────────────────────────────────────────────────────

    _site() { return { latDeg: this.loc.lat, lonDeg: this.loc.lon }; }

    /** A sky-predict target for a sky object: moving bodies by ephemeris, everything else fixed. */
    _targetFor(o) {
        return BODY_KINDS.has(o.kind) ? bodyTarget(o.id, this._site()) : fixedTarget(o.raDeg, o.decDeg);
    }

    /** The one-night grid for the night containing `jd` (dusk/dawn for tonight's arc). */
    _nightOf(jd) {
        const noon = nightNoonJd(jd, this.loc.lon);
        const k = `${this.loc.lat}|${this.loc.lon}|${noon.toFixed(5)}`;
        if (!this._nightCache.has(k)) {
            this._nightCache.set(k, buildNightGrid(this._site(), jd, 1).nights[0]);
            if (this._nightCache.size > 40) this._nightCache.delete(this._nightCache.keys().next().value);
        }
        return this._nightCache.get(k);
    }

    _computeTracks() {
        if (!this.tracked.length) return [];
        const jd = jdFromMs(this.timeMs);
        const night = this._nightOf(jd);
        const from = night.twilightStart ?? night.noonJd + 0.25;
        const to = night.twilightEnd ?? night.noonJd + 0.75;
        const nights = RANGES[this.range].nights;
        const out = [];
        for (const t of this.tracked) {
            const o = findObject(this.sky, t.key);
            if (!o) continue;
            const target = this._targetFor(o);
            const arc = pathSamples(this._site(), target, from, to, { stepMin: 10 });
            // Ticks on whole hours of the DEVICE clock (what you set an alarm by).
            const ticks = [];
            const d = new Date((from - 2440587.5) * 86_400_000);
            d.setMinutes(0, 0, 0);
            for (let ms = d.getTime() + 3_600_000; ms <= (to - 2440587.5) * 86_400_000; ms += 3_600_000) {
                const tj = jdFromMs(ms);
                const p = pathSamples(this._site(), target, tj, tj)[0];
                ticks.push({ ...p, label: `${new Date(ms).getHours()}h` });
            }
            const nightly = sameTimeSamples(this._site(), target, jd, nights).map((p, k) => ({
                ...p,
                label: k > 0 && (k % 7 === 0 || k === nights - 1)
                    ? new Date((p.jd - 2440587.5) * 86_400_000).toLocaleDateString([], { month: 'short', day: 'numeric' })
                    : null,
            }));
            out.push({ key: t.key, color: t.color, name: o.name, arc, ticks, nightly });
        }
        return out;
    }

    /** Build (or reuse) the 30-night forecast for the slider's anchor, off the input path. */
    _scheduleForecast() {
        if (!this.cat) return;
        const jdA = jdFromMs(this.anchorMs);
        const key = `${this.loc.lat}|${this.loc.lon}|${nightNoonJd(jdA, this.loc.lon).toFixed(5)}|${this.minAltDeg}`;
        if (this._forecast?.key === key) return;
        clearTimeout(this._forecastTimer);
        this._forecastTimer = setTimeout(() => {
            const t0 = performance.now();
            const grid = buildNightGrid(this._site(), jdA, FORECAST_NIGHTS);
            this._forecast = { key, grid, byKey: new Map(), builtMs: performance.now() - t0 };
            this._galacticForecast();
            this._renderCard();
            this._renderGalactic();
            this.doc.body.dataset.skyviewForecast = '1';
        }, 30);
    }

    /** Forecast for one object key, cached on the current grid. */
    _forecastFor(key) {
        const F = this._forecast;
        if (!F) return null;
        if (F.byKey.has(key)) return F.byKey.get(key);
        const o = findObject(this.sky, key);
        if (!o) return null;
        const f = forecastVisibility(F.grid, this._targetFor(o), { minAltDeg: this.minAltDeg });
        F.byKey.set(key, f);
        return f;
    }

    _galacticForecast() {
        for (const g of this.cat.galactic) this._forecastFor(galacticKey(g));
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
            tracks: this.tracks,
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

    /**
     * Galactic targets: every Galaxy Map object, ranked by how long it is up
     * in the dark TONIGHT, then by how soon it will be — with its 30-night
     * shape as a sparkline and its season (when it crosses the meridian at
     * midnight). Invisible objects are pointing targets, labelled as such.
     */
    _renderGalactic() {
        const host = this.$('sv-galactic');
        if (!host || !this.sky) return;
        const F = this._forecast;
        if (!F) { host.innerHTML = '<p class="sv-muted">Forecasting the next 30 nights…</p>'; return; }
        const filt = GAL_FILTERS[this.galFilter] ?? GAL_FILTERS.all;
        const rows = [];
        for (const g of this.cat.galactic) {
            const key = galacticKey(g);
            const o = findObject(this.sky, key);
            const f = F.byKey.get(key);
            if (!o || !f || !filt.test(o)) continue;
            const first = f.nights.findIndex((n) => n.hours > 0);
            rows.push({ g, o, f, key, tonight: f.nights[0].hours, first });
        }
        rows.sort((a, b) => (b.tonight - a.tonight) || ((a.first < 0 ? 1e9 : a.first) - (b.first < 0 ? 1e9 : b.first)) || (b.f.totalHours - a.f.totalHours));
        const maxH = Math.max(...F.grid.nights.map((n) => n.darkHours), 1);
        const upTonight = rows.filter((r) => r.tonight > 0).length;
        this.$('sv-galactic-count').textContent = `${upTonight} of ${rows.length} above ${this.minAltDeg}° in tonight's dark`;
        host.innerHTML = `<ul class="sv-gal-list">${rows.map(({ g, o, f, key, first }) => {
            const n0 = f.nights[0];
            const when = n0.hours > 0 ? describeWindow(n0, this.minAltDeg)
                : first > 0 ? `from ${nightDate(f.nights[first])}`
                : `not above ${this.minAltDeg}° for 30 nights`;
            const tracked = this.tracked.find((t) => t.key === key);
            const inst = !(Number.isFinite(o.mag) && o.mag <= 6.5);
            return `<li class="sv-gal-row${key === this.selectedKey ? ' is-selected' : ''}" data-key="${esc(key)}" tabindex="0" role="button">
              <span class="sv-gal-main">
                <span class="sv-gal-name">${esc(g.name)}</span>
                <span class="sv-gal-sub">${esc(formatLy(g.distLy))}${inst ? ' · instrument' : ''} · ${esc(when)}</span>
              </span>
              ${sparklineSvg(f.nights, { maxHours: maxH })}
              <button type="button" class="sv-track-btn${tracked ? ' is-on' : ''}" data-track="${esc(key)}"
                aria-pressed="${tracked ? 'true' : 'false'}" title="${tracked ? 'Stop tracking' : 'Track its path across your sky'}"
                ${tracked ? `style="--trk:${tracked.color}"` : ''}>${tracked ? '●' : '○'}</button>
            </li>`;
        }).join('')}</ul>`;
    }

    _renderTracks() {
        const host = this.$('sv-tracks');
        if (!host) return;
        if (!this.tracked.length) {
            host.innerHTML = '<span class="sv-muted">Nothing tracked — use ○ on a galactic target or “Track path” on a card.</span>';
            return;
        }
        host.innerHTML = this.tracked.map((t) => {
            const o = this.sky && findObject(this.sky, t.key);
            return `<span class="sv-trk-chip"><i style="background:${t.color}"></i><button type="button" data-key="${esc(t.key)}" class="sv-trk-name">${esc(o?.name ?? t.key)}</button>
              <button type="button" class="sv-trk-x" data-track="${esc(t.key)}" aria-label="Stop tracking ${esc(o?.name ?? t.key)}">×</button></span>`;
        }).join('');
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
            this._renderCardForecast(null);
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
        const trk = this.tracked.find((x) => x.key === o.key);
        const trackBtn = `<button type="button" class="sv-btn sv-card-track${trk ? ' is-on' : ''}" data-track="${esc(o.key)}" aria-pressed="${trk ? 'true' : 'false'}">${trk ? '● Tracking' : '○ Track path'}</button>`;
        card.innerHTML = `
          <div class="sv-card-head">
            <h3>${esc(o.name)}</h3>${trackBtn}
            <span class="sv-card-kind">${esc(KIND_LABEL[o.kind] ?? o.kind)}${o.designation ? ` · ${esc(o.designation)}` : ''}${g?.type && o.kind !== 'landmark' ? ` · ${esc(g.type)}` : ''}</span>
          </div>
          ${warn}
          <dl class="sv-card-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
          ${g?.desc ? `<p class="sv-card-desc">${esc(g.desc)}</p>` : ''}
          ${links.length ? `<div class="sv-card-links">${links.join('')}</div>` : ''}`;
        this._renderCardForecast(o);
    }

    /**
     * The selected object's next 30 nights: a summary line (best night, its
     * season, how it moves night to night) and the visibility calendar. Re-
     * rendered only when its inputs change, so hovering it survives the clock.
     */
    _renderCardForecast(o) {
        const host = this.$('sv-card-fc');
        if (!host) return;
        if (!o) { host.replaceChildren(); this._fcSig = ''; return; }
        const F = this._forecast;
        const nowJd = jdFromMs(this.timeMs);
        const f = F ? this._forecastFor(o.key) : null;
        const nowIdx = F ? F.grid.nights.findIndex((n) => nowJd >= n.noonJd && nowJd < n.noonJd + 1) : -1;
        const sig = `${o.key}|${F?.key}|${nowIdx}|${Math.round(nowJd * 96)}`;
        if (sig === this._fcSig) return;
        this._fcSig = sig;
        if (!f) { host.innerHTML = '<p class="sv-muted">Forecasting the next 30 nights…</p>'; return; }
        const moving = BODY_KINDS.has(o.kind);
        const best = f.best >= 0 ? f.nights[f.best] : null;
        const lines = [];
        lines.push(best
            ? `<b>Best night: ${esc(nightDate(best))}</b> — ${best.hours.toFixed(1)} h above ${f.minAltDeg}° in the dark, peaking ${Math.round(best.peakAltDeg)}° at ${esc(clockOf(best.peakJd))}; Moon ${Math.round(best.moonIllum * 100)}% lit.`
            : `<b>Not above ${f.minAltDeg}° in darkness on any of the next ${f.nights.length} nights</b> from here.`);
        if (!moving && o.kind !== 'sun') {
            const peak = seasonPeakJd(o.raDeg, nowJd - 182.6);
            if (peak != null) {
                const d = new Date((peak - 2440587.5) * 86_400_000).toLocaleDateString([], { month: 'long', day: 'numeric' });
                lines.push(`Its season peaks around <b>${esc(d)}</b>, when it crosses the meridian at local midnight.`);
            }
            lines.push(`Fixed among the stars: at the same clock time it sits ${NIGHTLY_DRIFT_DEG.toFixed(2)}° further west each night and rises ${NIGHTLY_EARLIER_MIN.toFixed(1)} min earlier — the Earth's orbit, not the object, is moving.`);
        } else if (o.kind === 'moon') {
            lines.push('The Moon moves ~13° east against the stars every day, so it rises ~50 min later each night.');
        } else if (o.kind === 'planet') {
            lines.push('A planet moves against the stars as well as with them — its same-time dots drift differently from the stars around it.');
        }
        host.innerHTML = `<h4 class="sv-fc-h">Next ${f.nights.length} nights <small>above ${f.minAltDeg}° in darkness</small></h4>
          <p class="sv-fc-sum">${lines.join(' ')}</p><div id="sv-fc-chart"></div>
          <p class="sv-fc-note">Columns are nights; time runs down (local solar time at the site). Bands: twilight, then full dark. Blue: usable. Dots: Moon brightness. Tap a night to jump there.</p>`;
        renderForecastChart(this.$('sv-fc-chart'), f, {
            nowJd, name: o.name,
            onPick: (n) => {
                const t = n.windows.length ? (n.windows[0].start + n.windows[n.windows.length - 1].end) / 2 : n.midnightJd;
                feature('forecast_pick', { night: n.index });
                if (this.range !== 'month') this.range = 'month';
                this.setTime(msFromJd(t));
            },
        });
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
        // Time machine.
        const r = RANGES[this.range];
        slider.min = String(r.min); slider.max = String(r.max); slider.step = String(r.step);
        slider.value = String(Math.max(r.min, Math.min(r.max, offMin)));
        for (const b of this.doc.querySelectorAll('[data-range]')) {
            const on = b.dataset.range === this.range;
            b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', String(on));
        }
        const scale = $('sv-slider-scale');
        if (scale.dataset.range !== this.range || scale.dataset.anchor !== String(this.anchorMs)) {
            scale.dataset.range = this.range; scale.dataset.anchor = String(this.anchorMs);
            const marks = this.range === 'tonight' ? [-12, 0, 12, 24, 36].map((h) => [h * 60, h === 0 ? 'start' : `${h > 0 ? '+' : '−'}${Math.abs(h)} h`])
                : [0, 0.25, 0.5, 0.75, 1].map((f) => {
                    const m = r.min + f * (r.max - r.min);
                    return [m, new Date(this.anchorMs + m * 60000).toLocaleDateString([], { month: 'short', day: 'numeric' })];
                });
            scale.innerHTML = marks.map(([, l]) => `<span>${esc(l)}</span>`).join('');
        }
        const pb = $('sv-play');
        pb.textContent = this.playing ? '❚❚ Pause' : '▶ Play';
        pb.setAttribute('aria-pressed', String(this.playing));
        pb.classList.toggle('is-on', this.playing);
        $('sv-speed').value = this.speed;
        $('sv-minalt').value = String(this.minAltDeg);
        for (const b of this.doc.querySelectorAll('[data-galfilter]')) b.classList.toggle('is-on', b.dataset.galfilter === this.galFilter);
        $('sv-time-offset').textContent = (() => {
            const d = (this.timeMs - this.anchorMs) / 86_400_000;
            if (this.live) return '';
            if (Math.abs(d) < 1) return `${d >= 0 ? '+' : '−'}${Math.abs(d * 24).toFixed(1)} h from start`;
            return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} days from start`;
        })();
    }

    // ── controls ─────────────────────────────────────────────────────────────

    _wireControls() {
        const $ = this.$;
        $('sv-time-live').addEventListener('click', () => { feature('live'); this.setTime(Date.now(), { live: true }); });
        $('sv-time-slider').addEventListener('input', (e) => {
            this.pause();
            this.live = false;
            this.timeMs = this.anchorMs + Number(e.target.value) * 60000;
            this._syncControls();
            if (!this._scrubRaf) this._scrubRaf = requestAnimationFrame(() => { this._scrubRaf = 0; this.recompute(); });
        });
        $('sv-time-tonight').addEventListener('click', () => this.goTonight());
        for (const b of this.doc.querySelectorAll('[data-range]')) b.addEventListener('click', () => this.setRange(b.dataset.range));
        $('sv-play').addEventListener('click', () => (this.playing ? this.pause() : this.play()));
        $('sv-speed').addEventListener('change', (e) => {
            this.speed = e.target.value;
            writePrefs({ ...readPrefs(), speed: this.speed });
            if (SPEEDS[this.speed].perNight && this.range === 'tonight') this.setRange('month');
        });
        for (const b of this.doc.querySelectorAll('[data-step]')) b.addEventListener('click', () => { this.pause(); this.step(Number(b.dataset.step)); });
        $('sv-minalt').addEventListener('change', (e) => {
            this.minAltDeg = Number(e.target.value);
            writePrefs({ ...readPrefs(), minAlt: this.minAltDeg });
            this._fcSig = '';
            this._scheduleForecast();
        });
        for (const b of this.doc.querySelectorAll('[data-galfilter]')) {
            b.addEventListener('click', () => { this.galFilter = b.dataset.galfilter; this._syncControls(); this._renderGalactic(); });
        }
        // Track toggles anywhere in the sidebar (list rows, chips, the card).
        $('sv-side').addEventListener('click', (e) => {
            const btn = e.target.closest('[data-track]');
            if (!btn) return;
            e.stopPropagation();
            this.toggleTrack(btn.dataset.track);
        }, true);
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
        for (const id of ['sv-top-list', 'sv-galactic', 'sv-tracks']) {
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
        this.pause();
        this.anchorMs = Date.now();
        this.setTime(target);
        this._scheduleForecast();
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
