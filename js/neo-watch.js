/**
 * neo-watch.js — controller for neo-watch.html (Near-Earth Watch)
 * ═══════════════════════════════════════════════════════════════════════════
 * Joins four things and computes none of them:
 *
 *   the catalogue   /api/neo/catalog  → js/neo-worker.js  → geocentric vectors
 *   the watch list  /api/neo/watch    → JPL's own approach / risk / bolide rows
 *   the geometry    js/neo-space.js   → distances, RA/Dec, magnitude, horizon
 *   the picture     js/neo-watch/stage.js + panels.js
 *
 * ── The clock ─────────────────────────────────────────────────────────────
 * REAL TIME is the default and the resting state: with warp at ×1 and no
 * scrub, the page shows now, and `_jdNow()` reads the wall clock every frame
 * rather than integrating a delta — a page that claims to be live must not be
 * able to drift from the clock it claims to follow. Warp and scrub are an
 * OFFSET on top of that, so returning to ×1 with a zero scrub returns to now
 * exactly, and the "LIVE" chip is on precisely when that offset is zero.
 *
 * ── Tier ladder ───────────────────────────────────────────────────────────
 * `pha` loads first because it is small and it is the population anyone came
 * for; `bright` replaces it; `all` is offered but never forced, and is skipped
 * on a save-data connection. Tiers NEST, so each load is a clean replacement
 * (`reset: true`) rather than a merge — the orrery's rule, for the same reason.
 *
 * ── Degradation ───────────────────────────────────────────────────────────
 * Both routes answer 200 with `freshness:'stale'` rather than 5xx, so "the
 * feed is down" arrives as data and has to be rendered as data. Every panel
 * takes a state and says what is missing. The stage draws NOTHING it was not
 * given: no catalogue means no points, never a placeholder population.
 */

import {
    AU_KM, HORIZONS, DEFAULT_HORIZON,
    earthHelioJ2000, buildObjectRow, findApproach, compareApproach,
    formatGeoDistance, subSolarPoint, gmstRad,
} from './neo-space.js';
import { rowToRecord, prepareColumns, propagateColumns, deriveGeocentric } from './neo-orbits.js';
import { EARTH_TEXTURES } from './earth-skin.js';
import { MOON_TEXTURES } from './moon-skin.js';
import { NeoStage } from './neo-watch/stage.js';
import {
    renderNearest, renderApproaches, renderSentry, renderFireballs,
    renderSelected, renderFeedChips, renderMoon,
} from './neo-watch/panels.js';

const WORKER_URL = new URL('./neo-worker.js', import.meta.url);
const JD_UNIX_0 = 2440587.5;
const msToJd = (ms) => ms / 86400000 + JD_UNIX_0;
const jdToMs = (jd) => (jd - JD_UNIX_0) * 86400000;

/** How many rows the live board shows. */
const BOARD_ROWS = 14;
/** Panel refresh rate. The stage runs at frame rate; the DOM does not need to. */
const PANEL_HZ = 3;
/** Warp settings offered, in simulated seconds per real second. */
const WARPS = [1, 60, 600, 3600, 21600, 86400];

export class NeoWatch {
    constructor(root = document) {
        this.root = root;
        this.$ = (id) => root.getElementById(id);

        this.warp = 1;
        this.offsetDays = 0;          // scrub, in days from now
        this.paused = false;
        this._warpAnchor = null;      // { realMs, jd } while warp > 1
        this.horizonKm = (HORIZONS.find(h => h.id === DEFAULT_HORIZON) || HORIZONS[0]).km;
        this.tier = 'pha';
        this.observer = null;
        this.selected = null;
        this.selectedDes = null;

        this.catalog = { state: 'loading', count: 0, note: '', freshness: null };
        this.watch = { state: 'loading', approaches: [], sentry: [], sentryTotal: 0, fireballs: [], freshness: null };

        this.meta = new Map();        // catalogue index → element metadata
        this.frame = null;            // { jd, geo, rHelio, rGeo, count }
        this.prevFrame = null;        // previous sample, for the sky-motion rate
        this._inFlight = false;
        this._metaWanted = new Set();
        this._approachCheck = null;   // { des, ours } once refined
        this._lastPanelMs = 0;

        this._mountStage();
        this._wireControls();
        this._startWorker();
        this._loadCatalog('pha', { autoUpgrade: true });
        this._loadWatch();
        this._tick = this._tick.bind(this);
        requestAnimationFrame(this._tick);

        // The watch list slides with the clock; an hour is well inside the
        // resolution the panel shows.
        this._watchTimer = setInterval(() => this._loadWatch(), 30 * 60 * 1000);
    }

    // ── Clock ───────────────────────────────────────────────────────────────

    /**
     * The simulated instant, as a Julian Day. At warp 1 with no scrub this is
     * the wall clock, read fresh — see the header.
     */
    _jdNow() {
        const realMs = Date.now();
        if (this.paused && this._pausedJd != null) return this._pausedJd;
        let jd;
        if (this.warp === 1 || !this._warpAnchor) {
            jd = msToJd(realMs);
        } else {
            const elapsedMs = realMs - this._warpAnchor.realMs;
            jd = this._warpAnchor.jd + (elapsedMs / 86400000) * this.warp;
        }
        return jd + this.offsetDays;
    }

    /** True when the page is showing the present moment and nothing else. */
    get isLive() { return !this.paused && this.warp === 1 && Math.abs(this.offsetDays) < 1e-9; }

    _setWarp(w) {
        const jd = this._jdNow();
        this.warp = w;
        this._warpAnchor = w === 1 ? null : { realMs: Date.now(), jd: jd - this.offsetDays };
        this._syncClockUi();
    }

    _setOffsetDays(d) {
        // Re-anchor so a scrub while warped does not also jump the warp origin.
        if (this.warp !== 1) this._warpAnchor = { realMs: Date.now(), jd: this._jdNow() - this.offsetDays };
        this.offsetDays = d;
        this._syncClockUi();
    }

    _goLive() {
        this.paused = false;
        this._pausedJd = null;
        this.warp = 1;
        this._warpAnchor = null;
        this.offsetDays = 0;
        const scrub = this.$('nw-scrub');
        if (scrub) scrub.value = '0';
        this._syncClockUi();
    }

    // ── Feeds ───────────────────────────────────────────────────────────────

    /** True on a connection the visitor has asked us not to spend. */
    _saveData() {
        return typeof navigator !== 'undefined' && !!navigator.connection?.saveData;
    }

    async _loadCatalog(tier, { autoUpgrade = false } = {}) {
        // `all` is ~38 000 objects and ~3.4 MB on the wire. On a save-data
        // connection that is not ours to spend; the page says what it did
        // rather than silently serving a smaller population.
        if (tier === 'all' && this._saveData()) {
            this.catalog = { ...this.catalog, note: 'full catalogue skipped (save-data)' };
            const sel = this.$('nw-tier');
            if (sel) sel.value = this.tier;
            this._renderChips();
            return;
        }
        this.tier = tier;
        const sel = this.$('nw-tier');
        if (sel && sel.value !== tier) sel.value = tier;
        this.catalog = { ...this.catalog, state: 'loading' };
        this._renderChips();
        let body;
        try {
            const res = await fetch(`/api/neo/catalog?tier=${encodeURIComponent(tier)}`, { cache: 'no-cache' });
            body = await res.json();
        } catch (err) {
            this.catalog = { state: 'down', count: 0, note: err?.message || 'request failed', freshness: null };
            this._renderChips();
            return;
        }
        if (!body || !Array.isArray(body.rows) || body.freshness !== 'live') {
            // A 200 with freshness:'stale' is the routes' contract for "JPL is
            // not answering". It is not an error, and it must not render green.
            this.catalog = {
                state: body?.rows?.length ? 'stale' : 'down',
                count: body?.rows?.length ?? 0,
                note: body?.degraded_reason || 'upstream unavailable',
                freshness: body?.freshness ?? null,
            };
        } else {
            this.catalog = { state: 'live', count: body.rows.length, note: body.tier_label || tier, freshness: 'live' };
        }
        const records = (body.rows || []).map(rowToRecord);
        this._loadRecords(records);
        this._renderChips();

        // The ladder: `pha` is small and is the population anyone came for, so
        // it goes up first and the page is usable in a second; `bright` (the
        // ≥140 m completeness class) replaces it once it arrives. Tiers NEST,
        // so the replacement is exact rather than a merge. `all` stays manual.
        if (autoUpgrade && this.catalog.state === 'live' && tier === 'pha' && !this._saveData()) {
            this._loadCatalog('bright');
        }
    }

    async _loadWatch() {
        try {
            const res = await fetch('/api/neo/watch', { cache: 'no-cache' });
            const body = await res.json();
            this.watch = {
                state: body?.freshness === 'live' ? 'live' : (body?.approaches?.length ? 'stale' : 'down'),
                approaches: body?.approaches ?? [],
                sentry: body?.sentry ?? [],
                sentryTotal: body?.sentry_total ?? 0,
                fireballs: body?.fireballs ?? [],
                freshness: body?.freshness ?? null,
            };
        } catch {
            this.watch = { state: 'down', approaches: [], sentry: [], sentryTotal: 0, fireballs: [], freshness: null };
        }
        this.stage?.setFireballs(this.watch.fireballs);
        this._renderWatchPanels();
        this._renderChips();
    }

    // ── Worker ──────────────────────────────────────────────────────────────

    _startWorker() {
        try {
            this.worker = new Worker(WORKER_URL, { type: 'module' });
        } catch (err) {
            console.warn('[neo-watch] module worker unsupported, propagating on main thread:', err?.message || err);
            this.worker = null;
            this.workerState = 'main-thread';
            return;
        }
        this.workerState = 'starting';
        this.worker.addEventListener('message', (ev) => this._onWorkerMsg(ev.data));
        this.worker.addEventListener('error', (err) => {
            console.warn('[neo-watch] worker error, falling back to the main thread:', err?.message || err);
            this.worker.terminate();
            this.worker = null;
            this.workerState = 'main-thread';
            this._inFlight = false;
        });
    }

    _loadRecords(records) {
        this.meta.clear();
        this._metaWanted.clear();
        if (this.worker) {
            this.worker.postMessage({ type: 'load', id: 1, records, reset: true });
        } else {
            // Main-thread fallback: the same kernel, at 1 Hz on purpose.
            const prep = prepareColumns(records);
            this._cols = prep.cols;
            this._els = prep.els;
            this._helio = new Float64Array(prep.cols.count * 3);
            for (let k = 0; k < prep.els.length; k++) this.meta.set(k, { index: k, ...prep.els[k] });
        }
    }

    _onWorkerMsg(msg) {
        if (!msg) return;
        if (msg.type === 'ready') { this.workerState = 'ready'; return; }
        if (msg.type === 'loaded') {
            this.workerState = `${msg.count.toLocaleString('en-US')} objects`;
            this.meta.clear();
            this._metaWanted.clear();
            this._renderChips();
            return;
        }
        if (msg.type === 'geoframe') {
            this._inFlight = false;
            this.prevFrame = this.frame;
            this.frame = { jd: msg.jd, geo: msg.geo, rHelio: msg.rHelio, rGeo: msg.rGeo, count: msg.count };
            this.stage.setPopulation({ geo: msg.geo, rGeo: msg.rGeo, count: msg.count });
            this._requestMetaForVisible();
            return;
        }
        if (msg.type === 'meta') {
            for (const o of msg.objects) this.meta.set(o.index, o);
            this.stage.setMeta(msg.objects);
            if (this.selectedDes == null && Number.isInteger(this.selected)) {
                this.selectedDes = this.meta.get(this.selected)?.des ?? null;
            }
            return;
        }
        if (msg.type === 'geotrack') {
            this._onGeoTrack(msg);
        }
    }

    /**
     * Ask for metadata only for the objects a readout can actually name: the
     * board's rows, the selection, and whatever the stage is drawing as a mesh.
     * Shipping 38 000 names to the main thread to label 14 of them is what the
     * worker exists to avoid.
     */
    _requestMetaForVisible() {
        if (!this.worker || !this.frame) return;
        const order = this._nearestIndices(BOARD_ROWS + 16);
        const want = order.filter(k => !this.meta.has(k) && !this._metaWanted.has(k));
        if (Number.isInteger(this.selected) && !this.meta.has(this.selected)) want.push(this.selected);
        if (!want.length) return;
        for (const k of want) this._metaWanted.add(k);
        this.worker.postMessage({ type: 'meta', id: 2, indices: want });
    }

    _nearestIndices(limit) {
        const f = this.frame;
        if (!f) return [];
        const horizonAU = this.horizonKm / AU_KM;
        const idx = [];
        for (let k = 0; k < f.count; k++) if (f.rGeo[k] <= horizonAU) idx.push(k);
        idx.sort((a, b) => f.rGeo[a] - f.rGeo[b]);
        return idx.slice(0, limit);
    }

    // ── The frame loop ──────────────────────────────────────────────────────

    _tick() {
        if (this._stopped) return;
        requestAnimationFrame(this._tick);
        const jd = this._jdNow();
        this.stage.setEpoch(jd);
        this._requestPropagation(jd);
        this.stage.render();

        const now = performance.now();
        if (now - this._lastPanelMs > 1000 / PANEL_HZ) {
            this._lastPanelMs = now;
            this._renderLive(jd);
            this._syncClockUi();
        }
    }

    _requestPropagation(jd) {
        const earth = earthHelioJ2000(jd);
        if (this.worker) {
            if (this._inFlight) return;
            this._inFlight = true;
            this.worker.postMessage({ type: 'geoframe', id: 3, jd, earth: [earth.x, earth.y, earth.z] });
            return;
        }
        // Main-thread fallback — 1 Hz, deliberately. Same kernel calls.
        if (!this._cols || (this._lastMainMs && performance.now() - this._lastMainMs < 1000)) return;
        this._lastMainMs = performance.now();
        const N = this._cols.count;
        const geo = new Float32Array(N * 3), rHelio = new Float32Array(N), rGeo = new Float32Array(N);
        propagateColumns(this._cols, jd, this._helio);
        deriveGeocentric(this._helio, N, [earth.x, earth.y, earth.z], geo, rHelio, rGeo);
        this.prevFrame = this.frame;
        this.frame = { jd, geo, rHelio, rGeo, count: N };
        this.stage.setPopulation({ geo, rGeo, count: N });
        this.stage.setMeta(this._nearestIndices(BOARD_ROWS + 16).map(k => this.meta.get(k)).filter(Boolean));
    }

    // ── Rows ────────────────────────────────────────────────────────────────

    /** Build one row through the kernel. The ONE derivation, per the kernel header. */
    _rowFor(index, jd, earthRAU) {
        const f = this.frame;
        const el = this.meta.get(index);
        if (!f || !el || !Number.isInteger(index) || index >= f.count) return null;
        const o = index * 3;
        const prev = this.prevFrame && this.prevFrame.count === f.count
            ? [this.prevFrame.geo[o], this.prevFrame.geo[o + 1], this.prevFrame.geo[o + 2]]
            : null;
        return buildObjectRow(el, {
            index,
            geo: [f.geo[o], f.geo[o + 1], f.geo[o + 2]],
            rHelioAU: f.rHelio[index],
            earthRAU,
            jd,
            observer: this.observer,
            prevGeo: prev,
            prevDtDays: prev ? f.jd - this.prevFrame.jd : 0,
        });
    }

    _renderLive(jd) {
        const earth = earthHelioJ2000(jd);
        const rows = this._nearestIndices(BOARD_ROWS)
            .map(k => this._rowFor(k, jd, earth.rAU))
            .filter(Boolean);

        const boardState = this.catalog.state === 'down' ? 'down'
            : this.catalog.state === 'loading' ? 'loading'
            : this.catalog.state === 'stale' ? 'stale' : 'live';
        renderNearest(this.$('nw-nearest'), rows, {
            state: boardState, selected: this.selected, observer: this.observer,
        });

        const selRow = Number.isInteger(this.selected) ? this._rowFor(this.selected, jd, earth.rAU) : null;
        const approach = selRow ? this.watch.approaches.find(a => a.des === selRow.des) : null;
        const cmp = approach && this._approachCheck && this._approachCheck.des === selRow.des
            ? compareApproach(this._approachCheck.ours, approach.dist_au, msToJd(approach.t_ms))
            : null;
        renderSelected(this.$('nw-selected'), selRow, { approach, comparison: cmp, nowMs: jdToMs(jd) });

        // Headline counters.
        const inView = this.frame ? this._countInView() : 0;
        this._setText('nw-count-view', inView.toLocaleString('en-US'));
        this._setText('nw-count-total', this.catalog.count.toLocaleString('en-US'));
        const closest = rows[0];
        this._setText('nw-closest', closest ? formatGeoDistance(closest.distKm) : '—');
        this._setText('nw-closest-name', closest ? closest.name : '');
        if (this._lastWatchJd == null || Math.abs(jd - this._lastWatchJd) > 0.02) {
            this._lastWatchJd = jd;
            this._renderWatchPanels();
        }

        // The Moon card. Phase and apsides are computed by the stage each time
        // it places the Moon, so this prints the same numbers the stage drew
        // rather than evaluating the ephemeris a second time.
        renderMoon(this.$('nw-moon'), this.stage.phase, this.stage.apsides, { jd });

        const sub = subSolarPoint(jd);
        this._setText('nw-subsolar',
            `${Math.abs(sub.latDeg).toFixed(1)}°${sub.latDeg < 0 ? 'S' : 'N'} ${Math.abs(sub.lonDeg).toFixed(1)}°${sub.lonDeg < 0 ? 'W' : 'E'}`);
        this._setText('nw-gmst', `${(gmstRad(jd) * 12 / Math.PI).toFixed(3)} h`);
    }

    _countInView() {
        const horizonAU = this.horizonKm / AU_KM;
        let n = 0;
        for (let k = 0; k < this.frame.count; k++) if (this.frame.rGeo[k] <= horizonAU) n++;
        return n;
    }

    _renderWatchPanels() {
        const nowMs = jdToMs(this._jdNow());
        renderApproaches(this.$('nw-approaches'), this.watch.approaches, {
            state: this.watch.state, nowMs, selectedDes: this.selectedDes,
        });
        renderSentry(this.$('nw-sentry'), this.watch.sentry, {
            state: this.watch.state, total: this.watch.sentryTotal,
        });
        renderFireballs(this.$('nw-fireballs'), this.watch.fireballs, { state: this.watch.state, nowMs });
    }

    _renderChips() {
        const el = this.$('nw-feeds');
        if (!el) return;
        const catText = this.catalog.state === 'live' ? `${this.catalog.count.toLocaleString('en-US')} objects`
            : this.catalog.state === 'loading' ? 'loading' : 'unavailable';
        const watchText = this.watch.state === 'live' ? `${this.watch.approaches.length} approaches`
            : this.watch.state === 'loading' ? 'loading' : 'unavailable';
        renderFeedChips(el, [
            { label: 'Catalogue', text: catText, state: this.catalog.state, detail: this.catalog.note },
            { label: 'JPL watch', text: watchText, state: this.watch.state },
            { label: 'Propagation', text: this.workerState || 'starting', state: this.worker ? 'live' : 'stale',
              detail: this.worker ? 'off the render thread' : 'main thread, 1 Hz' },
            { label: 'Imagery', text: this.stage?.texturesReady ? 'loaded' : 'procedural globe',
              state: this.stage?.texturesReady ? 'live' : 'stale',
              detail: 'Blue Marble day/night; the procedural skin is a placeholder, not geography' },
        ]);
    }

    _setText(id, text) {
        const el = this.$(id);
        if (el && el.textContent !== text) el.textContent = text;
    }

    // ── Selection and the approach comparison ───────────────────────────────

    /** Select a catalogue index, the string 'moon', or null to clear. */
    select(sel) {
        this.selected = sel;
        this.selectedDes = Number.isInteger(sel) ? (this.meta.get(sel)?.des ?? null) : null;
        this.stage.select(sel);
        this._approachCheck = null;
        if (Number.isInteger(sel)) {
            this._requestMetaForVisible();
            this._checkApproach(sel);
        }
        this._renderWatchPanels();
    }

    /** Select by JPL designation — how a click in the approach list arrives. */
    selectByDes(des) {
        for (const [k, m] of this.meta) if (m.des === des) { this.select(k); return true; }
        // Not in the loaded tier. Say so rather than selecting something else:
        // most close approachers are small and only exist in `all`.
        this.selectedDes = des;
        this.selected = null;
        this.stage.select(null);
        this._renderWatchPanels();
        return false;
    }

    /**
     * Ask the worker for the object's geocentric distance across the JPL
     * approach window, so `findApproach` can refine OUR minimum and the card
     * can print the disagreement. Nothing here overrides JPL's row.
     */
    _checkApproach(index) {
        const des = this.meta.get(index)?.des;
        const a = des && this.watch.approaches.find(x => x.des === des);
        if (!a || !this.worker) return;
        const jdA = msToJd(a.t_ms);
        // ±1 day at 2-minute resolution. Fine enough that interpolating between
        // samples cannot round a close pass outward, and short enough that an
        // encounter our two-body propagation puts more than a day from JPL's
        // simply falls off the window — where `findApproach` returns null and
        // the card prints no comparison, rather than a comparison to an edge.
        const steps = 721, days = 1;
        const earthAt = [];
        for (let k = 0; k < steps; k++) {
            const e = earthHelioJ2000(jdA - days + (2 * days) * (k / (steps - 1)));
            earthAt.push([e.x, e.y, e.z]);
        }
        this._pendingApproach = { des, jd: jdA, days };
        this.worker.postMessage({ type: 'geotrack', id: 4, index, jd: jdA, days, steps, earthAt });
    }

    _onGeoTrack(msg) {
        const p = this._pendingApproach;
        if (!p) return;
        const steps = msg.geo.length / 3;
        // Sample the shipped track, then refine between samples with the same
        // interpolation the coarse scan used — the minimum of a sampled curve.
        const distAt = (jd) => {
            const t = (jd - msg.jd0) / msg.dtDays;
            const i = Math.max(0, Math.min(steps - 2, Math.floor(t)));
            const f = Math.max(0, Math.min(1, t - i));
            const a = i * 3, b = (i + 1) * 3;
            const x = msg.geo[a] + (msg.geo[b] - msg.geo[a]) * f;
            const y = msg.geo[a + 1] + (msg.geo[b + 1] - msg.geo[a + 1]) * f;
            const z = msg.geo[a + 2] + (msg.geo[b + 2] - msg.geo[a + 2]) * f;
            return Math.hypot(x, y, z);
        };
        const ours = findApproach(distAt, p.jd, p.days * 0.95, 480, 1e-6);
        this._approachCheck = ours ? { des: p.des, ours } : null;
        this._pendingApproach = null;
    }

    // ── Controls ────────────────────────────────────────────────────────────

    _mountStage() {
        const canvas = this.$('nw-canvas');
        this.stage = new NeoStage(canvas, {
            onPick: (sel) => this.select(sel),
            // Both texture tables are the repo's ONE copy of those pinned CDN
            // URLs (js/earth-skin.js, js/moon-skin.js). Both are optional: the
            // stage never claims imagery it did not receive.
            textures: [EARTH_TEXTURES.day, EARTH_TEXTURES.night],
            moonTexture: MOON_TEXTURES.surface,
        });
        this.stage.setHorizon(this.horizonKm);
        this.stage.frameAll();
        addEventListener('resize', () => this.stage.resize());
    }

    _wireControls() {
        const on = (id, ev, fn) => { const el = this.$(id); if (el) el.addEventListener(ev, fn); };

        // Horizon.
        const hsel = this.$('nw-horizon');
        if (hsel) {
            hsel.innerHTML = HORIZONS.map(h =>
                `<option value="${h.id}"${h.id === DEFAULT_HORIZON ? ' selected' : ''}>${h.label}</option>`).join('');
            hsel.addEventListener('change', () => {
                const h = HORIZONS.find(x => x.id === hsel.value) || HORIZONS[0];
                this.horizonKm = h.km;
                this.stage.setHorizon(h.km);
            });
        }

        // Tier.
        on('nw-tier', 'change', (e) => this._loadCatalog(e.target.value));

        // Clock.
        const warp = this.$('nw-warp');
        if (warp) {
            warp.innerHTML = WARPS.map(w =>
                `<option value="${w}">${w === 1 ? 'real time' : w >= 3600 ? `×${(w / 3600).toFixed(0)} h/s` : `×${w}`}</option>`).join('');
            warp.addEventListener('change', () => this._setWarp(Number(warp.value) || 1));
        }
        on('nw-scrub', 'input', (e) => this._setOffsetDays(Number(e.target.value) || 0));
        on('nw-live', 'click', () => this._goLive());
        on('nw-pause', 'click', () => {
            this.paused = !this.paused;
            this._pausedJd = this.paused ? this._jdNow() : null;
            if (!this.paused) this._warpAnchor = { realMs: Date.now(), jd: this._pausedJd - this.offsetDays };
            this._syncClockUi();
        });

        // View.
        on('nw-true-scale', 'change', (e) => this.stage.setTrueScale(e.target.checked));
        on('nw-grid', 'change', (e) => this.stage.setGrid(e.target.checked));
        on('nw-fireballs-on', 'change', (e) => this.stage.setFireballsVisible(e.target.checked));
        on('nw-frame-all', 'click', () => this.stage.frameAll());
        on('nw-frame-earth', 'click', () => this.stage.frameEarth());
        on('nw-frame-sel', 'click', () => this.stage.focusSelected());

        // Observer.
        on('nw-locate', 'click', () => this._locate());
        on('nw-observer-apply', 'click', () => this._applyObserverFromInputs());

        // Row clicks. Delegated, because the tables are re-rendered wholesale.
        const delegate = (id, handler) => {
            const el = this.$(id);
            if (!el) return;
            el.addEventListener('click', (ev) => {
                const tr = ev.target.closest('tr[data-index], tr[data-des]');
                if (tr) handler(tr);
            });
            el.addEventListener('keydown', (ev) => {
                if (ev.key !== 'Enter' && ev.key !== ' ') return;
                const tr = ev.target.closest('tr[data-index], tr[data-des]');
                if (tr) { ev.preventDefault(); handler(tr); }
            });
        };
        delegate('nw-nearest', (tr) => this.select(Number(tr.dataset.index)));
        delegate('nw-approaches', (tr) => {
            this.selectByDes(tr.dataset.des);
            // Move the clock to the approach — the one place a list row drives
            // the simulation, and the reason the scrub exists.
            const t = Number(tr.dataset.t);
            if (Number.isFinite(t)) {
                const days = (msToJd(t) - msToJd(Date.now()));
                this._setOffsetDays(days);
                const scrub = this.$('nw-scrub');
                if (scrub) scrub.value = String(Math.max(-90, Math.min(90, days)));
            }
        });
    }

    _locate() {
        if (!navigator.geolocation) { this._setText('nw-observer-note', 'Geolocation is unavailable in this browser.'); return; }
        this._setText('nw-observer-note', 'Asking the browser…');
        navigator.geolocation.getCurrentPosition(
            (pos) => this._setObserver(pos.coords.latitude, pos.coords.longitude, 'from your browser'),
            (err) => this._setText('nw-observer-note', `Location declined (${err.code === 1 ? 'permission' : 'unavailable'}) — type one instead.`),
            { timeout: 8000, maximumAge: 600000 },
        );
    }

    _applyObserverFromInputs() {
        const lat = Number(this.$('nw-lat')?.value);
        const lon = Number(this.$('nw-lon')?.value);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            this._setText('nw-observer-note', 'Enter a latitude in ±90 and a longitude in ±180.');
            return;
        }
        this._setObserver(lat, lon, 'entered');
    }

    _setObserver(latDeg, lonDeg, source) {
        this.observer = { latDeg, lonDeg };
        const latI = this.$('nw-lat'), lonI = this.$('nw-lon');
        if (latI) latI.value = latDeg.toFixed(3);
        if (lonI) lonI.value = lonDeg.toFixed(3);
        this.stage.setObserver(this.observer);
        this._setText('nw-observer-note',
            `Horizon at ${Math.abs(latDeg).toFixed(2)}°${latDeg < 0 ? 'S' : 'N'} ${Math.abs(lonDeg).toFixed(2)}°${lonDeg < 0 ? 'W' : 'E'} (${source}). Altitude and azimuth are topocentric.`);
    }

    _syncClockUi() {
        const jd = this._jdNow();
        const d = new Date(jdToMs(jd));
        this._setText('nw-clock', d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC');
        const live = this.$('nw-live');
        if (live) live.classList.toggle('nw-live--on', this.isLive);
        this._setText('nw-live-state', this.isLive ? 'LIVE' : 'OFFSET');
        const pause = this.$('nw-pause');
        if (pause) pause.textContent = this.paused ? 'Resume' : 'Pause';
        const off = this.$('nw-offset');
        if (off) {
            off.textContent = Math.abs(this.offsetDays) < 1e-9 ? 'now'
                : `${this.offsetDays > 0 ? '+' : '−'}${Math.abs(this.offsetDays).toFixed(2)} d`;
        }
    }

    destroy() {
        this._stopped = true;
        clearInterval(this._watchTimer);
        this.worker?.terminate();
        this.stage?.dispose();
    }
}

export default NeoWatch;
