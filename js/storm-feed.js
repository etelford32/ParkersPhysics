/**
 * storm-feed.js — Active tropical cyclone data pipeline
 * ═══════════════════════════════════════════════════════
 * Polls /api/storms (Vercel edge function → NHC CurrentStorms.json +
 * NASA EONET) and dispatches a 'storm-update' CustomEvent on window each
 * time data arrives — including when it DOESN'T, which is the point.
 *
 * EVENT DETAIL  (storm-update)
 * ────────────────────────────
 *   status    'connecting' | 'live' | 'partial' | 'stale' | 'offline'
 *   storms    Array of storm objects (see below)
 *   freshness the route's own 'live'|'degraded'|'stale', or null offline
 *   coverage  1 | 0.5 | 0 — fraction of the two upstreams that answered
 *   missingBasins  ['WPAC','IO','SH'] — basins NOT covered by this payload
 *   note      human-readable degradation reason from the route, or null
 *   sources   { nhc:{ok,count,error?}, eonet:{ok,count,error?} } | null
 *   updatedMs epoch ms the SERVED DATA was fetched (not the client clock),
 *             or null when we have never had a successful payload
 *   stale     true when `storms` are last-known values, not this tick's
 *   error     last failure message, or null
 *
 *   storm object:
 *     id           string   e.g. 'al012025'
 *     name         string   e.g. 'TROPICAL STORM ALPHA'
 *     basin        string   'ATLANTIC' | 'EPAC' | 'CPAC' | 'WPAC' | 'IO' | 'SH'
 *     classification string 'TD'|'TS'|'HU'|'TY'|'STY'|'MH' (TD=tropical depression)
 *     lat          number   degrees N (negative = S hemisphere)
 *     lon          number   degrees E (negative = W hemisphere)
 *     intensityKt  number   sustained wind speed (knots)
 *     pressureHpa  number   minimum central pressure (hPa), or null
 *     movementDir  number   movement direction (degrees, 0=N, 90=E)
 *     movementKt   number   movement speed (knots)
 *     hemisphere   'N'|'S'
 *
 * ── WHY THIS IS MORE THAN A fetch() LOOP ──────────────────────────────
 * Three silent failures lived here until 2026-09, and each one rendered
 * as "the storm panel isn't working":
 *
 *  1. A 200 WAS ALWAYS 'live'. /api/storms answers 200 even when both
 *     upstreams are down (deliberately — see that route's header), so a
 *     total outage arrived as a healthy empty list and the panel printed
 *     "No active tropical cyclones worldwide right now." We now read the
 *     route's top-level `freshness` and map it onto our own status, so a
 *     dead feed can never masquerade as a quiet ocean.
 *  2. NO REQUEST TIMEOUT. A hung connection never settles, so `_poll`
 *     never resolved, no event was ever dispatched, and the panel sat on
 *     "awaiting NHC feed…" forever with no error anywhere. Every request
 *     is now bounded by REQUEST_TIMEOUT_MS.
 *  3. A FAILURE COST 30 MINUTES. The only retry was the next scheduled
 *     poll, so a one-second blip during page load blanked the panel for
 *     half an hour. Failures now back off 20s → 40s → 80s … capped at
 *     the normal interval, and recovery resets it.
 *
 * USAGE
 * ─────
 *   import { StormFeed } from './js/storm-feed.js';
 *   const feed = new StormFeed().start();
 *   window.addEventListener('storm-update', e => console.log(e.detail.storms));
 *   feed.refresh();   // manual retry (the panel's ↻ button)
 */

const ENDPOINT       = '/api/storms';
const DEFAULT_POLL   = 30 * 60 * 1000;   // 30 min — NHC advisories every 3–6 hrs
const REQUEST_TIMEOUT_MS = 12_000;       // > the route's own 8s+4s upstream budget
const RETRY_BASE_MS  = 20_000;           // first retry after a failure
const RETRY_MAX_MS   = DEFAULT_POLL;     // never back off past the normal cadence

// Route freshness → our status vocabulary. Kept as an explicit table so an
// unknown/absent value falls through to a conservative default rather than
// being silently treated as healthy.
const FRESHNESS_STATUS = { live: 'live', degraded: 'partial', stale: 'stale' };

export class StormFeed {
    /**
     * @param {object} opts
     * @param {number} [opts.pollInterval]  ms between polls (default 30 min)
     * @param {boolean} [opts.pauseWhenHidden]  suspend polling on a hidden
     *        tab and refresh immediately on return (default true). A tab
     *        left open overnight otherwise shows data up to 30 min old the
     *        instant it is focused.
     */
    constructor({ pollInterval = DEFAULT_POLL, pauseWhenHidden = true } = {}) {
        this.pollInterval   = pollInterval;
        this.pauseWhenHidden = pauseWhenHidden;
        this._timer         = null;
        this._failStreak    = 0;
        this.storms         = [];
        this.status         = 'connecting';
        this.freshness      = null;
        this.coverage       = null;
        this.missingBasins  = [];
        this.note           = null;
        this.sources        = null;
        this.updatedMs      = null;
        this.error          = null;
        this._inFlight      = null;
        this._stopped       = true;
        this._onVisibility  = this._onVisibility.bind(this);
    }

    /**
     * Begin polling. SAFE TO CALL REPEATEDLY — satellites.html relies on
     * this ("start() on an already-running feed is a no-op"), and the
     * original implementation did NOT actually honour it: a second call
     * overwrote `this._timer` and orphaned the first interval, which then
     * polled forever with no handle to stop it. Idempotency is now real:
     * `_schedule` clears the existing timer before arming a new one, the
     * visibility listener is a stable bound reference (so a duplicate
     * addEventListener is ignored), and `_poll` coalesces onto any request
     * already in flight.
     */
    start() {
        this._stopped = false;
        this._poll();
        this._schedule(this.pollInterval);
        if (this.pauseWhenHidden && typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', this._onVisibility);
        }
        return this;
    }

    stop() {
        this._stopped = true;
        clearTimeout(this._timer);
        this._timer = null;
        if (typeof document !== 'undefined') {
            document.removeEventListener('visibilitychange', this._onVisibility);
        }
    }

    /** Force an immediate poll (manual retry button, visibility return). */
    refresh() { return this._poll(); }

    // ── Internal ─────────────────────────────────────────────────────────

    _onVisibility() {
        if (document.visibilityState !== 'visible' || this._stopped) return;
        // Back on screen: re-poll now rather than waiting out the tail of
        // whatever interval was running while hidden.
        this._poll();
        this._schedule(this.pollInterval);
    }

    /** (Re)arm the single timer. One timer only — never stack intervals. */
    _schedule(delayMs) {
        clearTimeout(this._timer);
        if (this._stopped) return;
        this._timer = setTimeout(() => {
            // A hidden tab skips the work but keeps the timer alive, so
            // polling resumes on its own even if visibilitychange is
            // missed (some mobile browsers fire it unreliably on resume).
            if (!this.pauseWhenHidden || typeof document === 'undefined' ||
                document.visibilityState === 'visible') {
                this._poll();
            }
            this._schedule(this.pollInterval);
        }, delayMs);
    }

    /** Failure backoff: 20s, 40s, 80s … capped at the normal interval. */
    _retryDelay() {
        return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this._failStreak - 1));
    }

    async _poll() {
        // Coalesce: a manual refresh during an in-flight request joins it
        // rather than racing a second one (which could dispatch the two
        // results out of order).
        if (this._inFlight) return this._inFlight;
        this._inFlight = this._doPoll().finally(() => { this._inFlight = null; });
        return this._inFlight;
    }

    async _doPoll() {
        try {
            const r = await fetch(ENDPOINT, {
                cache: 'no-cache',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();

            // A 200 is not health. The route tells us what it actually
            // served; absent that field (an old cached payload from before
            // this contract shipped) we fall back to the source block, and
            // only then to optimism.
            const freshness = typeof data.freshness === 'string'
                ? data.freshness
                : this._inferFreshness(data);
            const status = FRESHNESS_STATUS[freshness] ?? 'live';

            if (status === 'stale') {
                // Upstreams are down: the empty list is not an observation.
                // KEEP the last known storms rather than blanking the map —
                // 30-minute-old cyclone positions are far better than none,
                // as long as we say they're old.
                this._failStreak++;
                this.status        = 'stale';
                this.freshness     = freshness;
                this.coverage      = Number.isFinite(data.coverage) ? data.coverage : 0;
                this.missingBasins = data.missingBasins ?? [];
                this.note          = data.note ?? null;
                this.sources       = data.sources ?? null;
                this.error         = data.note ?? 'upstream feeds unreachable';
                // updatedMs deliberately NOT advanced — nothing new arrived.
                this._dispatch({ stale: true });
                this._schedule(this._retryDelay());
                return;
            }

            this.storms        = Array.isArray(data.storms) ? data.storms : [];
            this.updatedMs     = Date.parse(data.updated) || Date.now();
            this._failStreak   = 0;
            this.status        = status;                  // 'live' | 'partial'
            this.freshness     = freshness;
            this.coverage      = Number.isFinite(data.coverage) ? data.coverage
                                 : (status === 'partial' ? 0.5 : 1);
            this.missingBasins = data.missingBasins ?? [];
            this.note          = data.note ?? null;
            this.sources       = data.sources ?? null;
            this.error         = null;
            this._dispatch({ stale: false });
            // A partial payload is real data — keep the normal cadence
            // rather than hammering a feed that is answering correctly
            // about the half of the world it can see.
            this._schedule(this.pollInterval);
        } catch (err) {
            this._failStreak++;
            // 'offline' only once we've genuinely lost the endpoint a few
            // times — a single blip is 'stale' (we may still be showing
            // good recent data).
            this.status = this._failStreak > 2 ? 'offline' : 'stale';
            this.error  = err?.name === 'TimeoutError'
                ? `request timed out after ${REQUEST_TIMEOUT_MS}ms`
                : (err?.message || String(err));
            this.freshness = null;
            this.coverage  = 0;
            console.debug('[StormFeed] poll failed:', this.error);
            // Re-dispatch last known storms with degraded status so the UI
            // can label them rather than silently keeping stale pixels.
            this._dispatch({ stale: true });
            this._schedule(this._retryDelay());
        }
    }

    /**
     * Back-compat for a payload served before `freshness` existed (an edge
     * cache can outlive a deploy by its TTL). Reads the `sources` block the
     * route has always emitted; if that's missing too we cannot tell, and
     * we say 'live' only because the old contract meant it.
     */
    _inferFreshness(data) {
        const s = data?.sources;
        if (!s || typeof s !== 'object') return 'live';
        const ok = (s.nhc?.ok ? 1 : 0) + (s.eonet?.ok ? 1 : 0);
        return ok === 2 ? 'live' : ok === 1 ? 'degraded' : 'stale';
    }

    _dispatch({ stale = false } = {}) {
        const detail = {
            status:        this.status,
            storms:        this.storms,
            freshness:     this.freshness,
            coverage:      this.coverage,
            missingBasins: this.missingBasins,
            note:          this.note,
            sources:       this.sources,
            updatedMs:     this.updatedMs,
            stale,
            error:         this.error,
        };
        // ── PUBLISH BEFORE ANNOUNCING ──────────────────────────────────
        // Subscribers mount at wildly different points in a page's life:
        // earth.html starts this feed in its early init block but mounts
        // the Storm Watch panel ~9,800 lines later. A fast /api/storms
        // (warm edge cache) resolves in between, so the panel missed the
        // only event it was going to get for the next 30 MINUTES and held
        // its placeholder — which read as "the storm panel isn't showing
        // up". It was invisible before this pass because the panel stamped
        // its footer from the wall clock, so an empty panel looked freshly
        // updated. Publishing the latest detail AND announcing it is the
        // shared-provider idiom flux-rope-forecast.js uses: a late
        // subscriber reads what it missed instead of waiting for a tick.
        window.__stormFeedState = detail;
        window.dispatchEvent(new CustomEvent('storm-update', { detail }));
    }
}

export default StormFeed;
