/**
 * satellite-feed.js — Real-time global cloud imagery (GIBS mosaic), on the
 * shared clock.
 *
 * Polling wrapper around js/cloud-imagery.js. The mosaic compositor stitches
 * four geostationary satellites (GOES-East, GOES-West, Himawari, Meteosat)
 * with MODIS Cloud_Optical_Thickness as polar/gap fill. Every product is
 * normalized to cloudiness+confidence BEFORE compositing and disc edges are
 * feathered (see cloud-imagery.js header for the seam post-mortem), so the
 * texture handed to the shader has one physical meaning everywhere.
 *
 * ── The mosaic follows the time bus (2026-09) ────────────────────────────
 * Before this, the feed fetched "now" every ten minutes and nothing else.
 * The Open-Meteo coverage grid replayed with the scrubber while the sharpest
 * cloud signal on the globe stayed pinned to wall-clock — scrub back six
 * hours and the observed clouds did not move; scrub forward and today's
 * frame was painted over a forecast. `setTime(simTimeMs)` fixes that:
 *
 *   • js/cloud-time.js resolves the instant to a MODE and a 10-min frame
 *     (live / replay / nowcast / model / unavailable — see its header).
 *   • Frames are fetched by explicit UTC timestamp and held in a small LRU
 *     keyed on the frame time, so scrubbing back over a frame is instant.
 *   • Network work waits for the scrub to SETTLE (the EarthObsFeed pattern)
 *     with a leading-edge cap so playback that never settles (600×) still
 *     advances a frame every few seconds instead of never.
 *   • The event carries `mode`, `weight`, `frameTimeMs` and `leadMs`, and a
 *     second event ('satellite-time') fires when only the timing changes —
 *     the shaders advect the frame by the lead and scale its confidence by
 *     the weight, and the page discloses which mode it is showing.
 *   • A replay frame the archive cannot serve is reported as 'unavailable'
 *     (weight 0), never substituted with a nearer one: an observation of
 *     the wrong instant under a labelled time is worse than none.
 *   • The 10-min poll keeps refreshing the live frame ONLY while the view is
 *     at or ahead of wall clock (live / nowcast — the nowcast advects the
 *     newest frame, so it wants the poll too). Parked in the past, the poll
 *     burns no bandwidth.
 *
 * Telemetry: each fetch emits one 'data_pipeline' event (name
 * 'cloud_mosaic') carrying which layers loaded, fallback depth, imagery
 * age, composite coverage, and the widest residual coverage gap. This is
 * the evidence trail for diagnosing seam/staleness reports from the field
 * — the pipeline's failure modes (layer-ID rot, snapshot endpoint changes,
 * regional CDN issues) only manifest in real browsers, not in CI.
 *
 * Event API (back-compat with earth.html, plus the timing fields):
 *   window dispatches 'satellite-update' with detail {
 *     compositeTex: THREE.Texture,    // the mosaic for the resolved frame
 *     goesTex:      null,             // legacy fields kept for the
 *     modisTex:     null,             //   shape-stable consumer at
 *     source:       string,           // earth.html
 *     time:         Date,             // acquisition time (real timestamp
 *                                     //   when known, else composite date)
 *     goesTime:     Date | null,      // mosaic acquisition time
 *     modisDate:    string | null,    // YYYY-MM-DD of polar fill
 *     mosaic:       boolean,          // false = MODIS fallback
 *     regions:      string[],         // ['GOES-East','Himawari',...]
 *     layers:       string[],         // full GIBS layer IDs used
 *     diag:         object,           // fetch/composite diagnostics (v2)
 *     frameTimeMs:  number | null,    // the frame's own UTC instant
 *     requestedMs:  number,           // the sim instant it stands in for
 *     mode:         string,           // cloud-time.js mode
 *     weight:       number,           // confidence scale [0,1]
 *     leadMs:       number,           // requestedMs − frameTimeMs
 *     describe:     string,           // human-readable disclosure
 *   }
 *   window dispatches 'satellite-time' with detail {
 *     frameTimeMs, requestedMs, mode, weight, leadMs, describe
 *   } whenever the timing changes without a texture swap (a scrub into the
 *   future, the nowcast weight decaying, a frame that failed to fetch).
 */

import * as THREE from 'three';
import { fetchCloudImagery } from './cloud-imagery.js';
import { telemetry } from './telemetry.js';
import { resolveMosaicTime, describeMosaicMode } from './cloud-time.js';

// Refresh cadence — GOES, Himawari and Meteosat all publish ~10-min frames,
// so polling more often wastes bytes; less often risks stale clouds during
// fast-evolving weather. Matches the legacy 10-min GOES poll.
const REFRESH_MS = 10 * 60_000;
// Snapshot resolution. 2048×1024 ≈ 0.18°/px equirectangular — resolves
// hurricane bands and cold fronts without exceeding the GIBS server-side
// reprojection limits.
const SAT_W = 2048;
// Decoded frames held for instant re-scrub. Each is a 2048×1024 RGBA8
// DataTexture ≈ 8 MB on the GPU, so this is a deliberate small number; the
// current frame and the one it is cross-fading from are never evicted.
const FRAME_CACHE = 4;
// Scrub settle before a network round-trip (same as EarthObsFeed), and the
// leading-edge cap: at 600× the target frame changes every second and a
// pure debounce would never fire.
const TIME_SETTLE_MS   = 550;
const TIME_MAX_WAIT_MS = 3000;
// A frame that failed is not retried while the clock keeps emitting the
// same request; after this long a scrub back onto it may try again.
const FAIL_RETRY_MS = 90_000;

/** Squeeze a diag object into a telemetry-safe summary (<4 KB, no URLs). */
function diagToTelemetry(diag, gotTexture) {
    const failures = diag.attempts.filter(a => !a.ok);
    return {
        severity: gotTexture && diag.mode === 'mosaic' ? 'info' : 'warning',
        ok:       gotTexture,
        mode:     diag.mode,
        ms:       diag.ms,
        // Explicit (scrubbed) instant, when the fetch was one. Lets the
        // field data say whether misses cluster at replay times.
        requested: diag.requestedMs == null ? null : new Date(diag.requestedMs).toISOString().slice(0, 16),
        regions:  diag.regions.map(r =>
            `${r.name}=${r.layer}@${r.ageMin != null ? r.ageMin + 'm' : r.time}`),
        polar:    diag.polar ? `${diag.polar.layer}@${diag.polar.date}` : null,
        attempts: diag.attempts.length,
        failures: failures.length,
        // First few failures name the rotting layer/time directly; the
        // full list stays on window.__cloudDiag for interactive debugging.
        failed:   failures.slice(0, 5).map(a => `${a.region}:${a.layer}@${a.time}`),
        coverage:        diag.composite?.coverage ?? null,
        mean_cloudiness: diag.composite?.meanCloudiness ?? null,
        gap_max_deg:     diag.composite?.gapMaxDeg ?? null,
        gap_center_lon:  diag.composite?.gapCenterLon ?? null,
    };
}

const LIVE_KEY = 'live';

export class SatelliteFeed {
    constructor() {
        this._timer        = null;
        this._compositeTex = null;
        this._lastHit      = null;   // metadata from the most recent ACTIVATED frame
        this.lastDiag      = null;   // full diagnostics, refreshed every fetch

        // Frame cache: key → { texture, hit, frameMs, usedAt }. Insertion
        // order is recency (delete + re-set on touch), like the resolver LRU.
        this._frames   = new Map();
        this._inflight = new Map();  // key → Promise
        this._failedAt = new Map();  // key → wall ms of the last miss
        this._liveKey  = null;       // frame key of the newest live hit

        // Timeline state.
        this._viewTimeMs = Date.now();
        this._timing     = null;     // last resolveMosaicTime() result
        this._current    = { key: null, mode: null, weight: null };
        this._prevKey    = null;     // the frame the page is cross-fading FROM
        this._timeTimer  = null;
        this._pendingKey = null;
        this._pendingSince = 0;
    }

    start() {
        this._refresh();
        this._timer = setInterval(() => this._pollLive(), REFRESH_MS);
        return this;
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
        clearTimeout(this._timeTimer);
        this._timeTimer = null;
    }

    // Read-accessors retained for any external probe that pre-dates this
    // refactor. compositeTex is the only one that's actually populated now.
    get goesTex()      { return null; }
    get modisTex()     { return null; }
    get compositeTex() { return this._compositeTex; }
    /** Current timing (mode / weight / frame) — for the page's disclosure. */
    get timing()       { return this._timing; }

    // ── Timeline ────────────────────────────────────────────────────────────

    /**
     * Follow the shared EarthView time bus. Cheap when nothing changed; a
     * frame already in the cache activates immediately; a new frame is
     * fetched once the scrub settles (or after TIME_MAX_WAIT_MS of the
     * request continuously changing, so playback still advances).
     */
    setTime(simTimeMs, { immediate = false } = {}) {
        if (!Number.isFinite(simTimeMs)) return;
        this._viewTimeMs = simTimeMs;
        const r = resolveMosaicTime({ simTimeMs, nowMs: Date.now() });
        this._timing = r;

        // No frame can stand in for this instant (deep future / beyond the
        // archive): clear any pending fetch and disclose. The texture is
        // left in place — the shaders read its weight, which is 0 — so a
        // scrub back into observed time needs no re-upload.
        if (r.frameMs == null) {
            this._clearPending();
            this._emitTiming();
            return;
        }

        const key = this._keyFor(r);
        if (key && this._frames.has(key)) {
            this._clearPending();
            if (this._current.key !== key) this._activate(key);
            else this._emitTiming();
            return;
        }

        // Live / nowcast without a live frame yet: the poll delivers it.
        if (r.mode === 'live' || r.mode === 'nowcast') {
            this._clearPending();
            this._emitTiming();
            if (!this._inflight.has(LIVE_KEY)) this._refresh();
            return;
        }

        // Replay frame not held: schedule a fetch for when the drag settles.
        if (this._inflight.has(key)) { this._emitTiming({ pending: true }); return; }
        const failed = this._failedAt.get(key);
        if (failed && Date.now() - failed < FAIL_RETRY_MS) {
            // Known miss, recently: report 'unavailable' rather than loop.
            this._emitTiming({ unavailable: true });
            return;
        }
        const now = Date.now();
        if (this._pendingKey !== key) {
            this._pendingKey = key;
            if (!this._pendingSince) this._pendingSince = now;
            clearTimeout(this._timeTimer);
            this._timeTimer = setTimeout(() => this._syncTime(), immediate ? 0 : TIME_SETTLE_MS);
        } else if (!this._timeTimer) {
            this._timeTimer = setTimeout(() => this._syncTime(), immediate ? 0 : TIME_SETTLE_MS);
        }
        if (now - this._pendingSince > TIME_MAX_WAIT_MS) this._syncTime();
        // While the fetch is pending the page keeps the previous frame at
        // its (now wrong) lead; disclose the interim honestly.
        this._emitTiming({ pending: true });
    }

    _keyFor(r) {
        if (!r || r.frameMs == null) return null;
        // Live and nowcast both draw the newest frame the poll fetched —
        // which may be a fallback candidate a step older than the ideal
        // key, so they resolve to whatever the live poll last delivered.
        if (r.mode === 'live' || r.mode === 'nowcast') return this._liveKey;
        return r.key;
    }

    _clearPending() {
        clearTimeout(this._timeTimer);
        this._timeTimer = null;
        this._pendingKey = null;
        this._pendingSince = 0;
    }

    _syncTime() {
        this._timeTimer = null;
        const key = this._pendingKey;
        this._pendingKey = null;
        this._pendingSince = 0;
        const r = this._timing;
        // The clock may have moved on since the timer was armed; fetch the
        // frame the CURRENT instant wants, not the one that started the wait.
        if (!r || r.frameMs == null || r.mode === 'live' || r.mode === 'nowcast') return;
        if (r.key !== key) {
            // Re-arm for the new target rather than fetching a stale one.
            this.setTime(this._viewTimeMs, { immediate: true });
            return;
        }
        this._fetchFrame(r.frameMs, r.key);
    }

    _pollLive() {
        // Only while the view is at or ahead of wall clock does the newest
        // frame matter (nowcast advects it). Parked in the past: no traffic.
        const m = this._timing?.mode;
        if (m && m !== 'live' && m !== 'nowcast') return;
        this._refresh();
    }

    // ── Fetching ────────────────────────────────────────────────────────────

    async _fetchFrame(frameMs, key) {
        if (this._inflight.has(key)) return this._inflight.get(key);
        const p = this._fetchInto(key, { width: SAT_W, timestampMs: frameMs });
        this._inflight.set(key, p);
        try { await p; } finally { this._inflight.delete(key); }
    }

    /** The live poll — freshest frame, full fallback ladder. */
    async _refresh() {
        if (this._inflight.has(LIVE_KEY)) return this._inflight.get(LIVE_KEY);
        const p = this._fetchInto(LIVE_KEY, { width: SAT_W });
        this._inflight.set(LIVE_KEY, p);
        try { await p; } finally { this._inflight.delete(LIVE_KEY); }
    }

    async _fetchInto(key, opts) {
        // fetchCloudImagery handles the timestamp/layer fallback chain
        // internally and returns null only when EVERY source fails. onDiag
        // fires even on total failure, so the telemetry event and
        // window.__cloudDiag exist precisely when things break.
        let diag = null;
        const hit = await fetchCloudImagery(THREE, { ...opts, onDiag: d => { diag = d; } });

        this.lastDiag = diag;
        if (diag) {
            try {
                telemetry.recordPipeline('cloud_mosaic', diagToTelemetry(diag, !!hit));
            } catch { /* telemetry must never break the feed */ }
            // Fires on EVERY fetch, success or total failure — unlike
            // 'satellite-update', which only fires when there's a texture.
            // earth.html mirrors this onto window.__cloudDiag so a viewer
            // with a broken feed still has the evidence in the console.
            window.dispatchEvent(new CustomEvent('cloud-mosaic-diag', { detail: diag }));
        }

        if (!hit) {
            if (key === LIVE_KEY) {
                // Stale beats a black globe for LIVE: keep whatever frame is
                // showing (the shaders still know its real time and lead).
                console.warn('[SatelliteFeed] mosaic + MODIS fallback both failed; retaining previous texture', diag);
            } else {
                // A replay miss is reported, not papered over.
                this._failedAt.set(key, Date.now());
                console.warn(`[SatelliteFeed] no archived frame for ${key}`, diag);
                if (this._timing?.key === key) this._emitTiming({ unavailable: true });
            }
            return;
        }

        // Cache under the frame's OWN time so a live hit also serves a
        // replay request for the same instant later.
        const frameMs  = hit.timestampMs ?? (hit.date ? Date.parse(`${hit.date}T00:00:00Z`) : Date.now());
        const frameKey = key === LIVE_KEY
            ? new Date(frameMs).toISOString().slice(0, 16) + 'Z'
            : key;
        this._store(frameKey, { texture: hit.texture, hit, frameMs });
        if (key === LIVE_KEY) this._liveKey = frameKey;

        const cov   = diag?.composite ? ` cov ${(diag.composite.coverage * 100).toFixed(0)}%` : '';
        const label = hit.mosaic
            ? `mosaic · ${hit.regions.join('+')}${hit.polar ? '+polar' : ''}`
            : `MODIS · ${hit.layers[0]?.replace(/^MODIS=/, '') ?? 'fallback'}`;
        console.info(`[SatelliteFeed] cloud texture ${key === LIVE_KEY ? 'refreshed' : 'archived ' + frameKey} — ${label} ${hit.date}${cov}`);

        // Activate only if this frame is still what the clock wants.
        const wanted = this._keyFor(this._timing) ?? (this._timing ? null : frameKey);
        if (wanted === frameKey || (!this._timing && key === LIVE_KEY)) {
            this._activate(frameKey);
        } else if (this._timing?.frameMs == null && key === LIVE_KEY && !this._current.key) {
            // First-ever frame while the clock sits in the deep future:
            // activate so a scrub back has something to show at weight 0.
            this._activate(frameKey);
        }
    }

    // ── Cache ───────────────────────────────────────────────────────────────

    _store(key, frame) {
        const old = this._frames.get(key);
        if (old && old.texture !== frame.texture) old.texture.dispose();
        this._frames.delete(key);
        this._frames.set(key, frame);
        this._failedAt.delete(key);
        this._evict();
    }

    _evict() {
        // Never evict the frame on screen or the one it cross-fades from —
        // a disposed texture bound as u_sat_prev would re-upload 8 MB
        // mid-fade at best.
        const keep = new Set([this._current.key, this._prevKey, this._liveKey]);
        for (const [k, f] of this._frames) {
            if (this._frames.size <= FRAME_CACHE) break;
            if (keep.has(k)) continue;
            f.texture.dispose();
            this._frames.delete(k);
        }
    }

    _activate(key) {
        const f = this._frames.get(key);
        if (!f) return;
        // Touch for recency.
        this._frames.delete(key);
        this._frames.set(key, f);
        this._prevKey      = this._current.key;
        this._compositeTex = f.texture;
        this._lastHit      = f.hit;
        this._current.key  = key;
        this._dispatch(f);
        this._evict();
    }

    // ── Events ──────────────────────────────────────────────────────────────

    _timingDetail(flags = {}) {
        const r = this._timing;
        const cur = this._current.key ? this._frames.get(this._current.key) : null;
        let mode = r?.mode ?? 'live';
        let weight = r?.weight ?? 1;
        let frameMs = cur?.frameMs ?? null;
        if (flags.unavailable || (r && r.frameMs != null && cur && r.mode === 'replay' && this._current.key !== r.key && !flags.pending)) {
            mode = 'unavailable'; weight = 0;
        }
        if (flags.pending) {
            // A frame is on its way; the one on screen is from another
            // instant. Show it at reduced weight so the scrub does not go
            // blank, and say so.
            weight = Math.min(weight, 0.5);
        }
        // Lead is against the frame ON SCREEN, which is what gets advected.
        const leadMs = frameMs == null ? 0 : this._viewTimeMs - frameMs;
        const describe = flags.pending
            ? `Fetching observed frame for ${r?.key ?? '—'}…`
            : describeMosaicMode(r ? { ...r, mode, weight, frameMs } : null);
        return { frameTimeMs: frameMs, requestedMs: this._viewTimeMs, mode, weight, leadMs, describe };
    }

    _emitTiming(flags = {}) {
        const d = this._timingDetail(flags);
        // Emit on a material change only: the bus ticks at up to 10 Hz.
        const c = this._current;
        if (c.mode === d.mode && c.weight != null && Math.abs(c.weight - d.weight) < 0.01
                && c.frameTimeMs === d.frameTimeMs && c.describe === d.describe) return;
        c.mode = d.mode; c.weight = d.weight; c.frameTimeMs = d.frameTimeMs; c.describe = d.describe;
        window.dispatchEvent(new CustomEvent('satellite-time', { detail: d }));
    }

    _dispatch(frame) {
        const hit = frame?.hit ?? this._lastHit;
        if (!hit) return;
        const source = hit.mosaic
            ? `Mosaic: ${hit.regions.join(' + ')}${hit.polar ? ' + polar' : ''}`
            : 'MODIS Terra GIBS';
        // Real acquisition timestamp when the snapshot carried one; date
        // midnight otherwise (daily composites) — downstream "minutes ago"
        // formatters need a Date either way.
        const time = hit.timestampMs != null
            ? new Date(hit.timestampMs)
            : hit.date ? new Date(`${hit.date}T00:00:00Z`) : new Date();

        const t = this._timingDetail();
        const c = this._current;
        c.mode = t.mode; c.weight = t.weight; c.frameTimeMs = t.frameTimeMs; c.describe = t.describe;

        window.dispatchEvent(new CustomEvent('satellite-update', {
            detail: {
                compositeTex: this._compositeTex,
                goesTex:      null,
                modisTex:     null,
                source,
                time,
                goesTime:     hit.mosaic ? time : null,
                modisDate:    hit.polar  || !hit.mosaic ? hit.date : null,
                mosaic:       hit.mosaic,
                regions:      hit.regions,
                layers:       hit.layers,
                diag:         hit.diag ?? this.lastDiag,
                ...t,
            },
        }));
    }
}
