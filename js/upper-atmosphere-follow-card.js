/**
 * upper-atmosphere-follow-card.js — what you are chasing, and the tour
 * ═══════════════════════════════════════════════════════════════════════════
 * DOM only. A card under the camera readout that appears while the camera
 * follows a spacecraft (a named probe or any catalogue dot) and prints what
 * `globe.getFollowInfo()` reports: name · NORAD · altitude · speed · period
 * · inclination, the chase range and framing, and THE DISCLOSURE — the
 * avatar is drawn at a symbolic scale (kernel `modelScale`, the factor
 * printed) against the object's true span. Its buttons run the altitude
 * tour (next higher / next lower, kernel `altitudeNeighbour`), reframe the
 * chase and release it. It computes nothing: every number is the globe's.
 *
 * Refreshes at 4 Hz like the readout; the card's shell is built once and
 * its text nodes are updated in place (a re-rendered card detaches the
 * button under the cursor — the verdict card's stable-header rule).
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }) : '—');

export class FollowCard {
    /**
     * @param {object} o
     * @param {HTMLElement} o.host   where the card mounts (the camera dock)
     * @param {object} o.globe       the UpperAtmosphereGlobe
     * @param {number} [o.hz=4]
     */
    constructor({ host, globe, hz = 4 }) {
        this.host = host;
        this.globe = globe;
        this.el = document.createElement('section');
        this.el.id = 'ua-follow-card';
        this.el.className = 'ua-fc';
        this.el.hidden = true;
        this.el.setAttribute('aria-live', 'polite');
        this.el.innerHTML =
            `<header class="ua-fc-head">`
            + `<span class="ua-fc-kicker">following</span>`
            + `<b class="ua-fc-name" data-f="name">—</b>`
            + `<span class="ua-fc-norad" data-f="norad"></span>`
            + `<button type="button" class="ua-fc-x" data-act="release" title="Release the chase (Esc)" aria-label="Release">✕</button>`
            + `</header>`
            + `<div class="ua-fc-grid">`
            + `<span class="ua-fc-k">alt</span><span class="ua-fc-v" data-f="alt">—</span>`
            + `<span class="ua-fc-k">v</span><span class="ua-fc-v" data-f="speed">—</span>`
            + `<span class="ua-fc-k">period</span><span class="ua-fc-v" data-f="period">—</span>`
            + `<span class="ua-fc-k">incl</span><span class="ua-fc-v" data-f="incl">—</span>`
            + `<span class="ua-fc-k">camera</span><span class="ua-fc-v ua-fc-v--wide" data-f="cam">—</span>`
            + `</div>`
            + `<div class="ua-fc-tour" role="group" aria-label="Altitude tour">`
            + `<button type="button" data-act="lower" title="Chase the next spacecraft BELOW this one (,)">▼ lower</button>`
            + `<button type="button" data-act="higher" title="Chase the next spacecraft ABOVE this one (.)">▲ higher</button>`
            + `<button type="button" data-act="reframe" title="Back behind and above the target at the default range">⟲ reframe</button>`
            + `</div>`
            + `<p class="ua-fc-note" data-f="note"></p>`;
        host.appendChild(this.el);
        this._f = {};
        for (const n of this.el.querySelectorAll('[data-f]')) this._f[n.dataset.f] = n;
        this.el.addEventListener('click', (e) => {
            const b = e.target.closest('[data-act]');
            if (!b) return;
            e.stopPropagation();
            const act = b.dataset.act;
            if (act === 'release') this.globe.stopFollowing?.();
            else if (act === 'lower') this.globe.followNeighbourByAltitude?.(-1);
            else if (act === 'higher') this.globe.followNeighbourByAltitude?.(1);
            else if (act === 'reframe') this.globe.reframeFollow?.();
            this.refresh();
        });
        this._timer = setInterval(() => this.refresh(), 1000 / hz);
        this.refresh();
    }

    refresh() {
        const info = this.globe.getFollowInfo?.();
        if (!info) {
            if (!this.el.hidden) { this.el.hidden = true; this._lastKey = null; }
            return;
        }
        if (this.el.hidden) this.el.hidden = false;
        const f = this._f;
        const key = `${info.kind}:${info.id}`;
        if (key !== this._lastKey) {
            f.name.textContent = info.name || '—';
            f.norad.textContent = info.noradId != null ? `NORAD ${info.noradId}` : '';
            this.el.dataset.kind = info.kind;
            this.el.dataset.family = info.family || 'generic';
            this._lastKey = key;
        }
        f.alt.textContent = Number.isFinite(info.altKm) ? `${fmt(info.altKm)} km` : '—';
        f.speed.textContent = Number.isFinite(info.speedKmS) ? `${fmt(info.speedKmS, 2)} km/s` : '—';
        f.period.textContent = Number.isFinite(info.periodMin) ? `${fmt(info.periodMin, 1)} min` : '—';
        f.incl.textContent = Number.isFinite(info.inclinationDeg) ? `${fmt(info.inclinationDeg, 1)}°` : '—';
        const c = info.chase;
        if (info.flying && !c) {
            f.cam.textContent = 'flying in…';
            f.note.textContent = '';
        } else if (c) {
            const where = Math.abs(c.azDeg) > 135 ? 'behind' : Math.abs(c.azDeg) < 45 ? 'ahead of' : 'beside';
            const upDown = c.elDeg >= 0 ? `${fmt(c.elDeg)}° above` : `${fmt(-c.elDeg)}° below`;
            f.cam.textContent = `${fmt(c.distKm, c.distKm < 100 ? 1 : 0)} km ${where} · ${upDown} the orbit plane`;
            const sc = c.modelScale;
            const factor = (c.drawnSpanKm * 1000) / Math.max(0.1, c.trueSpanM);
            f.note.textContent = `symbolic model: drawn ${fmt(c.drawnSpanKm, c.drawnSpanKm < 10 ? 1 : 0)} km across`
                + ` (×${fmt(factor)} its true ≈${fmt(c.trueSpanM)} m span${sc < 0.999 ? ', held in angle as you close in' : ''})`
                + ' · wheel / W S zoom · drag / A D Q E orbit · , . tour';
        } else {
            f.cam.textContent = '—';
            f.note.textContent = '';
        }
    }

    destroy() { clearInterval(this._timer); this.el.remove(); }
}
