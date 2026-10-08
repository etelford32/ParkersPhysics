/**
 * upper-atmosphere-explore-hud.js — the explorer's instruments (DOM only)
 * ═══════════════════════════════════════════════════════════════════════════
 * Everything here reads the globe's explore API and the kernel; it computes
 * no physics and no geometry of its own.
 *
 *   • ALTITUDE COLUMN (left edge of the canvas). The whole 80–2000 km band
 *     on a LOG scale (`gaugeFraction`), coloured by the canonical layer
 *     schema, with every boundary ticked, every point of interest marked at
 *     its altitude, and the camera on it. Click anywhere on the column to
 *     go to that altitude: a dive from above the band, a ride down the
 *     local vertical from inside it. It is also the answer to "where am I
 *     in the atmosphere" at a glance, which the numeric readout is not.
 *
 *   • TOASTS for boundary crossings, discoveries and transitions — the
 *     moment you pass through a layer is the event, so it gets said.
 *
 *   • POI LABELS pinned to the beacons, clickable (dive there). Hidden when
 *     the point is behind the camera or behind the planet (analytic ray-
 *     sphere test against the unit sphere — the same test the membrane
 *     shader uses).
 *
 *   • THE READOUT'S NAV ROWS: heading, cruise speed next to the circular
 *     orbital speed (a navigation speed must never read as a spacecraft's),
 *     position. And the mode chip / buttons, kept honest by polling the
 *     controller's mode rather than trusting whichever button was clicked.
 *
 *   • THE PANEL (Controls column): the point-of-interest list with where
 *     the model put each one, the discovery log, the controls, and the
 *     grid / beacon / immersive toggles. Rows are built ONCE per id set and
 *     updated in place (the neo-watch lesson: re-rendering a list under the
 *     cursor at a few Hz eats the click).
 *
 *   • IMMERSIVE: the canvas card fills the window (CSS), and goes true
 *     fullscreen where the Fullscreen API allows it.
 */

import { ATMOSPHERIC_LAYER_SCHEMA } from './upper-atmosphere-layers.js';
import { OPS_BANDS, hexCss as opsHex } from './upper-atmosphere-ops-bands.js';
import {
    BOUNDARIES, MILESTONES, gaugeFraction, gaugeAltitude, EXPLORE,
    MODEL_FLOOR_KM, MODEL_CEIL_KM,
} from './upper-atmosphere-explore-model.js';

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKm = (km) => !Number.isFinite(km) ? '—' : km >= 10000 ? `${Math.round(km / 1000)}k km` : `${Math.round(km)} km`;
const fmtSpeed = (v) => !Number.isFinite(v) ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)}k km/s` : `${Math.round(v)} km/s`;
const fmtLat = (d) => `${Math.abs(d).toFixed(1)}°${d >= 0 ? 'N' : 'S'}`;
const fmtLon = (d) => `${Math.abs(d).toFixed(1)}°${d >= 0 ? 'E' : 'W'}`;

const SHORT = {
    'mesosphere|lower-thermosphere': 'mesopause',
    'karman': 'Kármán',
    'lower-thermosphere|upper-thermosphere': '',
    'upper-thermosphere|inner-exosphere': '',
    'inner-exosphere|outer-exosphere': '',
    'ceiling': 'ceiling',
};

export class ExploreHud {
    /**
     * @param {object} o
     * @param {HTMLElement} o.wrap        the globe card (#ua-globe-wrap)
     * @param {object} o.globe            UpperAtmosphereGlobe
     * @param {HTMLElement} [o.panelHost] where the explore panel mounts
     */
    constructor({ wrap, globe, panelHost = null }) {
        this.wrap = wrap;
        this.globe = globe;
        this._lastMode = null;
        this._poiKey = '';
        this._toastTimer = null;
        this._buildGauge();
        this._buildToast();
        this._buildLabels();
        if (panelHost) this._buildPanel(panelHost);
        this._bindImmersive();

        this._onExplore = (e) => this._handleEvent(e.detail || {});
        window.addEventListener('ua-explore', this._onExplore);
        this._tick = this._tick.bind(this);
        this._lastTick = 0;
        this._raf = requestAnimationFrame(this._tick);
        this._panelTimer = setInterval(() => this._refreshPanel(), 2000);
        this._refreshPanel();
    }

    // ── Altitude column ──────────────────────────────────────────────────
    _buildGauge() {
        const g = document.createElement('div');
        g.className = 'ua-xg';
        g.id = 'ua-explore-gauge';
        g.setAttribute('role', 'slider');
        g.setAttribute('aria-label', 'Altitude — click to go there');
        g.setAttribute('aria-valuemin', String(MODEL_FLOOR_KM));
        g.setAttribute('aria-valuemax', String(MODEL_CEIL_KM));
        g.tabIndex = 0;
        g.title = 'The 80–2000 km band on a log scale. Click an altitude to go there (a dive from above, a ride down the vertical from inside).';
        const bands = ATMOSPHERIC_LAYER_SCHEMA.map(L => {
            const lo = gaugeFraction(Math.max(MODEL_FLOOR_KM, L.minKm)), hi = gaugeFraction(Math.min(MODEL_CEIL_KM, L.maxKm));
            return `<div class="ua-xg-band" style="bottom:${(lo * 100).toFixed(2)}%;height:${((hi - lo) * 100).toFixed(2)}%;`
                 + `background:linear-gradient(to top, ${hex(L.colorLow)}, ${hex(L.colorHigh)})" title="${esc(L.name)} · ${L.minKm}–${L.maxKm} km"></div>`;
        }).join('');
        const ticks = BOUNDARIES.map(b => `<div class="ua-xg-tick${b.kind === 'line' ? ' ua-xg-tick--line' : ''}" style="bottom:${(gaugeFraction(b.km) * 100).toFixed(2)}%">`
            + `<span>${b.km}${SHORT[b.id] ? ` <em>${esc(SHORT[b.id])}</em>` : ''}</span></div>`).join('');
        // The OPS strip beside the physics bar: the operational bands
        // (js/upper-atmosphere-ops-bands.js) on the same log scale, each
        // named at its mid-height when it is tall enough to carry a label
        // (the low bands are a few pixels at this scale; their colour still
        // matches the ring on the limb).
        const ops = OPS_BANDS.map(b => {
            const lo = gaugeFraction(b.minKm), hi = gaugeFraction(b.maxKm);
            return `<i style="bottom:${(lo * 100).toFixed(2)}%;height:${((hi - lo) * 100).toFixed(2)}%;--c:${opsHex(b.colorHex)}" title="${esc(b.name)} · ${b.minKm}–${b.maxKm} km"></i>`
                 + `<span class="ua-xg-opsname" data-band="${b.id}" style="bottom:${(((lo + hi) / 2) * 100).toFixed(2)}%;--c:${opsHex(b.colorHex)}">${esc(b.short)}</span>`;
        }).join('');
        g.innerHTML = `<div class="ua-xg-cap">ALT</div><div class="ua-xg-bar">${bands}${ticks}`
            + `<div class="ua-xg-ops" aria-hidden="true">${ops}</div>`
            + `<div class="ua-xg-pois"></div>`
            + `<div class="ua-xg-cam" style="bottom:100%"><span class="ua-xg-cam-v">—</span></div></div>`;
        this.wrap.appendChild(g);
        this._gauge = g;
        this._gaugeBar = g.querySelector('.ua-xg-bar');
        // A band name only where the band is tall enough to carry it.
        this._fitOpsNames = () => {
            const h = this._gaugeBar.clientHeight;
            for (const el of g.querySelectorAll('.ua-xg-opsname')) {
                const b = OPS_BANDS.find(x => x.id === el.dataset.band);
                const px = b ? (gaugeFraction(b.maxKm) - gaugeFraction(b.minKm)) * h : 0;
                el.hidden = px < 11;
            }
        };
        this._fitOpsNames();
        new ResizeObserver(this._fitOpsNames).observe(g);
        this._gaugeCam = g.querySelector('.ua-xg-cam');
        this._gaugeCamV = g.querySelector('.ua-xg-cam-v');
        this._gaugePois = g.querySelector('.ua-xg-pois');

        const go = (clientY) => {
            const r = this._gaugeBar.getBoundingClientRect();
            if (!r.height) return;
            const f = 1 - (clientY - r.top) / r.height;
            const alt = gaugeAltitude(f);
            this.globe.goToAltitude?.(alt);
            this.toast('GOING TO', fmtKm(alt), this._layerNameAt(alt));
        };
        // Clicks only: the canvas under the gauge must not see this press.
        g.addEventListener('mousedown', (e) => e.stopPropagation());
        g.addEventListener('click', (e) => { e.stopPropagation(); go(e.clientY); });
        g.addEventListener('keydown', (e) => {
            const cur = this.globe.getCameraAltitudeKm?.();
            if (!Number.isFinite(cur)) return;
            const f = gaugeFraction(Math.min(MODEL_CEIL_KM, cur));
            let next = null;
            if (e.key === 'ArrowUp' || e.key === 'PageUp') next = gaugeAltitude(f + 0.08);
            if (e.key === 'ArrowDown' || e.key === 'PageDown') next = gaugeAltitude(f - 0.08);
            if (next != null) { e.preventDefault(); e.stopPropagation(); this.globe.goToAltitude?.(next); }
        });
    }

    _layerNameAt(alt) {
        const L = ATMOSPHERIC_LAYER_SCHEMA.find(x => alt >= x.minKm && alt < x.maxKm);
        return L ? L.name : '';
    }

    // ── Toast ────────────────────────────────────────────────────────────
    _buildToast() {
        const t = document.createElement('div');
        t.className = 'ua-xt';
        t.id = 'ua-explore-toast';
        t.setAttribute('role', 'status');
        t.setAttribute('aria-live', 'polite');
        t.innerHTML = '<div class="ua-xt-k"></div><div class="ua-xt-t"></div><div class="ua-xt-s"></div>';
        this.wrap.appendChild(t);
        this._toast = t;
    }
    /** Show a toast: kicker, title, subtitle, accent colour. */
    toast(kicker, title, sub = '', color = null) {
        const t = this._toast;
        t.querySelector('.ua-xt-k').textContent = kicker;
        t.querySelector('.ua-xt-t').textContent = title;
        t.querySelector('.ua-xt-s').textContent = sub;
        t.style.setProperty('--ua-xt-accent', color || '#5fd8ff');
        t.classList.remove('on');
        // Restart the fade-in.
        void t.offsetWidth;
        t.classList.add('on');
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => t.classList.remove('on'), 3200);
        this._lastToast = { kicker, title, sub };
    }
    getLastToast() { return this._lastToast || null; }

    _handleEvent(ev) {
        const g = this.globe;
        if (ev.kind === 'cross') {
            const b = ev.boundary;
            const col = b ? hex(b.colorHex) : null;
            const kick = ev.direction === 'down' ? '↓ ENTERING' : '↑ ENTERING';
            this.toast(kick, ev.entered, b ? `${b.km} km · ${b.name}` : '', col);
        } else if (ev.kind === 'discover') {
            const poi = g.getPointsOfInterest?.().find(p => p.id === ev.id);
            const fact = poi?.facts?.[0] ? `${poi.facts[0][0]} ${poi.facts[0][1]}` : '';
            this.toast(ev.milestone ? 'MILESTONE' : 'DISCOVERED', ev.name || ev.id,
                `${ev.found?.length ?? '?'} / ${ev.total ?? '?'}${fact ? ' · ' + fact : ''}`,
                poi ? hex(poi.colorHex) : '#ffd36b');
            this._refreshPanel(true);
        } else if (ev.kind === 'dive-start') {
            const poi = ev.poiId ? g.getPointsOfInterest?.().find(p => p.id === ev.poiId) : null;
            this.toast('DIVING TO', poi ? poi.name : `${fmtLat(ev.target.latDeg)} ${fmtLon(ev.target.lonDeg)}`,
                `${fmtKm(ev.target.altKm)} · any key or drag takes over`, poi ? hex(poi.colorHex) : null);
        } else if (ev.kind === 'dive-arrive') {
            this.toast('ARRIVED', `${fmtKm(ev.target.altKm)} · ${this._layerNameAt(ev.target.altKm)}`,
                'W/S fly · A/D turn · Q/E climb · drag to look');
        } else if (ev.kind === 'climb-start') {
            this.toast('LEAVING THE ATMOSPHERE', 'Climbing to orbit', 'any key or drag takes over');
        }
    }

    // ── POI labels ───────────────────────────────────────────────────────
    _buildLabels() {
        const l = document.createElement('div');
        l.className = 'ua-xl';
        l.id = 'ua-explore-labels';
        this.wrap.appendChild(l);
        this._labels = l;
        this._labelEls = new Map();
        l.addEventListener('click', (e) => {
            const b = e.target.closest('[data-poi]');
            if (!b) return;
            e.stopPropagation();
            this.globe.diveToPoi?.(b.dataset.poi);
        });
        l.addEventListener('mousedown', (e) => { if (e.target.closest('[data-poi]')) e.stopPropagation(); });
    }

    /** Chrome the POI labels must not sit on (canvas-relative rects). */
    _chromeRects() {
        const wb = this.wrap.getBoundingClientRect();
        const out = [];
        for (const q of ['#ua-camera-hud > *', '#ua-atmo-controls', '#ua-globe-legend', '#ua-time-dock', '#ua-explore-gauge', '#ua-flight-deck']) {
            for (const el of this.wrap.querySelectorAll(q)) {
                if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue;
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) out.push({ x: r.left - wb.left, y: r.top - wb.top, w: r.width, h: r.height });
            }
        }
        return out;
    }

    _placeLabels(pois) {
        const g = this.globe;
        const cam = g._camera?.position;
        const on = g.getBeaconsVisible?.() !== false;
        const seen = new Set();
        // Labels under the HUD, the toolbar, the dock or the column are
        // hidden rather than drawn through them (they used to print across
        // the readout's numbers). The beacon on the globe still shows where
        // the point is; the panel lists every one by name.
        const chrome = this._chromeRects();
        const covered = (x, y, w, h) => chrome.some(r => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
        for (const p of pois) {
            if (!p.scenePos) continue;
            let el = this._labelEls.get(p.id);
            if (!el) {
                el = document.createElement('button');
                el.type = 'button';
                el.className = 'ua-xl-tag';
                el.dataset.poi = p.id;
                this._labels.appendChild(el);
                this._labelEls.set(p.id, el);
            }
            seen.add(p.id);
            const [x, y, z] = p.scenePos;
            let visible = on && !!cam;
            if (visible) {
                // Behind the planet? Ray from the camera to the point vs the unit sphere.
                const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
                const L = Math.hypot(dx, dy, dz);
                const ux = dx / L, uy = dy / L, uz = dz / L;
                const b = cam.x * ux + cam.y * uy + cam.z * uz;
                const c = cam.x * cam.x + cam.y * cam.y + cam.z * cam.z - 1;
                const disc = b * b - c;
                if (disc > 0) {
                    const t0 = -b - Math.sqrt(disc);
                    if (t0 > 0 && t0 < L) visible = false;
                }
                // Too close to label usefully (you are there).
                if (L < 0.02) visible = false;
            }
            const scr = visible ? g.projectToScreen?.(x, y, z) : null;
            const w = this.wrap.clientWidth, h = this.wrap.clientHeight;
            if (!scr || scr.behind || scr.x < 0 || scr.y < 0 || scr.x > w || scr.y > h) {
                if (!el.hidden) el.hidden = true;
                continue;
            }
            const text = `${p.discovered ? '✓ ' : ''}${p.name} · ${fmtKm(p.altKm)}`;
            if (el.textContent !== text) el.textContent = text;
            const lx = Math.round(scr.x + 10), ly = Math.round(scr.y - 9);
            const lw = el.offsetWidth || 120, lh = el.offsetHeight || 18;
            if (covered(lx, ly, lw, lh)) { if (!el.hidden) el.hidden = true; continue; }
            el.hidden = false;
            el.style.transform = `translate(${lx}px, ${ly}px)`;
            el.style.setProperty('--ua-xl-c', hex(p.colorHex));
            el.classList.toggle('ua-xl-tag--found', !!p.discovered);
            el.title = `${p.blurb}\n\nPlaced by: ${p.placedBy}\nClick to dive here.`;
        }
        for (const [id, el] of this._labelEls) if (!seen.has(id)) { el.remove(); this._labelEls.delete(id); }
    }

    // ── Per-frame (throttled) ────────────────────────────────────────────
    _tick(now) {
        this._raf = requestAnimationFrame(this._tick);
        if (now - this._lastTick < 90) return;
        this._lastTick = now;
        const g = this.globe;
        const alt = g.getCameraAltitudeKm?.();

        // Gauge marker.
        if (Number.isFinite(alt)) {
            const above = alt > MODEL_CEIL_KM;
            const f = gaugeFraction(Math.min(MODEL_CEIL_KM, Math.max(MODEL_FLOOR_KM, alt)));
            this._gaugeCam.style.bottom = `${(f * 100).toFixed(2)}%`;
            this._gaugeCam.classList.toggle('ua-xg-cam--above', above);
            const v = above ? `↑ ${fmtKm(alt)}` : fmtKm(alt);
            if (this._gaugeCamV.textContent !== v) this._gaugeCamV.textContent = v;
            this._gauge.setAttribute('aria-valuenow', String(Math.round(alt)));
        }

        // POIs on the gauge + labels.
        const pois = g.getPointsOfInterest?.() || [];
        const key = pois.map(p => `${p.id}:${Math.round(p.altKm)}:${p.discovered ? 1 : 0}`).join('|');
        if (key !== this._poiKey) {
            this._poiKey = key;
            this._gaugePois.innerHTML = pois.map(p => `<i class="ua-xg-poi${p.discovered ? ' ua-xg-poi--found' : ''}" `
                + `style="bottom:${(gaugeFraction(p.altKm) * 100).toFixed(2)}%;--c:${hex(p.colorHex)}" title="${esc(p.name)} · ${fmtKm(p.altKm)}"></i>`).join('');
        }
        this._placeLabels(pois);

        // Mode chip / buttons / nav rows.
        const mode = g.getCameraMode?.();
        const diving = !!g.isTransitioning?.();
        const modeKey = `${mode}|${diving}`;
        if (modeKey !== this._lastMode) {
            this._lastMode = modeKey;
            this._paintMode(mode, diving);
        }
        const info = g.getExploreInfo?.();
        const navRow = document.getElementById('ua-cam-nav');
        const posRow = document.getElementById('ua-cam-pos');
        if (navRow) navRow.hidden = !info;
        if (posRow) posRow.hidden = !info;
        if (info) {
            const nav = document.getElementById('ua-cam-nav-v');
            const pos = document.getElementById('ua-cam-pos-v');
            const hdg = Number.isFinite(info.headingDeg) ? `${String(Math.round(info.headingDeg) % 360).padStart(3, '0')}° ${info.compass}` : '— pole';
            if (nav) nav.textContent = `${hdg} · ${fmtSpeed(info.speedKmS)} (×${Math.round(info.orbitalMultiple)} v_orb)`;
            if (pos) pos.textContent = `${fmtLat(info.latDeg)} ${fmtLon(info.lonDeg)}`;
        }
    }

    _paintMode(mode, diving) {
        const chip = document.getElementById('ua-cam-mode');
        const hint = document.getElementById('ua-cam-hint');
        const following = this.globe._controls?.isFollowing?.();
        for (const [id, m] of [['ua-cam-orbit', 'orbit'], ['ua-cam-fly', 'fly'], ['ua-cam-explore', 'explore']]) {
            document.getElementById(id)?.classList.toggle('ua-cam-on', !diving && mode === m);
        }
        document.getElementById('ua-cam-explore')?.classList.toggle('ua-cam-live', diving);
        if (following) return;               // the follow chip owns the text
        if (chip) {
            chip.classList.remove('ua-cam-mode--follow');
            chip.textContent = diving ? 'transition' : mode;
        }
        if (hint) {
            hint.textContent = diving ? 'any key, drag or wheel takes over'
                : mode === 'explore' ? 'W/S fly where you look · A/D turn · Q/E climb · Shift boost · drag to look'
                : mode === 'fly' ? 'WASD move · Q/E down/up · Shift fast · drag to look'
                : 'drag to rotate · scroll to zoom · double-click the globe to dive';
        }
    }

    // ── Panel ────────────────────────────────────────────────────────────
    _buildPanel(host) {
        host.innerHTML = `
            <div class="ua-xp">
                <div class="ua-xp-head">
                    <span class="ua-xp-count" data-f="count">0 / 0 found</span>
                    <button type="button" class="ua-xp-mini" data-act="reset" title="Forget what you have found (stored in this browser only)">reset log</button>
                </div>
                <div class="ua-xp-list" data-f="list"></div>
                <div class="ua-xp-mile" data-f="mile"></div>
                <div class="ua-xp-toggles">
                    <button type="button" class="ua-xp-chip" data-act="explore" title="Dive into the band under the camera (or fly level where you are)">⇣ explore here</button>
                    <button type="button" class="ua-xp-chip" data-act="orbit" title="Climb out of the atmosphere to the orbit view">⇡ back to orbit</button>
                    <button type="button" class="ua-xp-chip" data-act="grid" aria-pressed="true" title="Boundary grids — markers for the layer boundaries, the Kármán line and the model ceiling; not physical surfaces">grids</button>
                    <button type="button" class="ua-xp-chip" data-act="beacons" aria-pressed="true" title="Beacons and labels at every point of interest">beacons</button>
                    <button type="button" class="ua-xp-chip" data-act="aurora" aria-pressed="true" title="Auroral curtains on the page's statistical oval for the live Kp (100–300 km; brightness and folds symbolic). They appear as you come down toward the band.">aurora</button>
                    <button type="button" class="ua-xp-chip" data-act="immersive" aria-pressed="false" title="Fill the window with the view">⛶ immersive</button>
                </div>
                <div class="ua-xp-keys">
                    <b>W/S</b> fly where you look · <b>A/D</b> turn · <b>Q/E</b> climb / descend ·
                    <b>Shift</b> boost · <b>Ctrl</b> crawl · <b>drag</b> look ·
                    <b>double-click</b> the globe to dive there · click the altitude column to change height ·
                    any key or drag takes over a dive.
                </div>
                <p class="ua-xp-note">Every point of interest is placed by this page's own
                model (the line under each says how). Cruise speed is a
                <em>navigation</em> speed — 1.2 × altitude per second, shown next to
                the circular orbital speed — and the boundary grids mark surfaces that are
                not physical. The auroral curtains sit on the page's statistical oval
                for the live Kp; their brightness and folds are symbolic. Found points
                are remembered in this browser only.</p>
            </div>`;
        this._panel = host.querySelector('.ua-xp');
        this._pf = {};
        this._panel.querySelectorAll('[data-f]').forEach(n => { this._pf[n.dataset.f] = n; });
        this._panel.addEventListener('click', (e) => {
            const go = e.target.closest('[data-go]');
            if (go) { this.globe.diveToPoi?.(go.dataset.go); return; }
            const a = e.target.closest('[data-act]');
            if (!a) return;
            const g = this.globe;
            const act = a.dataset.act;
            if (act === 'reset') { g.resetExploreDiscoveries?.(); this._refreshPanel(true); }
            else if (act === 'explore') g.enterExplore?.();
            else if (act === 'orbit') g.climbToOrbit?.();
            else if (act === 'grid') { const on = !g.getMembranesVisible?.(); g.setMembranesVisible?.(on); a.setAttribute('aria-pressed', String(on)); }
            else if (act === 'beacons') { const on = !g.getBeaconsVisible?.(); g.setBeaconsVisible?.(on); a.setAttribute('aria-pressed', String(on)); }
            else if (act === 'aurora') { const on = !g.getAuroraCurtainsVisible?.(); g.setAuroraCurtainsVisible?.(on); a.setAttribute('aria-pressed', String(on)); }
            else if (act === 'immersive') this.setImmersive(!this.isImmersive());
        });
    }

    _refreshPanel(force = false) {
        if (!this._panel) return;
        const g = this.globe;
        const pois = g.getPointsOfInterest?.() || [];
        const disc = g.getExploreDiscoveries?.() || { found: [], total: 0 };
        const found = new Set(disc.found);
        this._pf.count.textContent = `${disc.found.length} / ${disc.total} found`;
        const ids = pois.map(p => p.id).join(',');
        if (ids !== this._rowIds || force) {
            this._rowIds = ids;
            this._pf.list.innerHTML = pois.map(p => `
                <div class="ua-xp-row" data-row="${esc(p.id)}" style="--c:${hex(p.colorHex)}">
                    <span class="ua-xp-dot"></span>
                    <span class="ua-xp-main">
                        <span class="ua-xp-name"><span data-r="found"></span>${esc(p.name)}</span>
                        <span class="ua-xp-where" data-r="where"></span>
                        <span class="ua-xp-fact" data-r="fact"></span>
                        <span class="ua-xp-by">${esc(p.placedBy)}</span>
                    </span>
                    <button type="button" class="ua-xp-go" data-go="${esc(p.id)}" title="${esc(p.blurb)}">Dive</button>
                </div>`).join('');
        }
        for (const p of pois) {
            const row = this._pf.list.querySelector(`[data-row="${CSS.escape(p.id)}"]`);
            if (!row) continue;
            const set = (k, v) => { const n = row.querySelector(`[data-r="${k}"]`); if (n && n.textContent !== v) n.textContent = v; };
            set('found', found.has(p.id) ? '✓ ' : '');
            set('where', `${fmtKm(p.altKm)} · ${fmtLat(p.latDeg)} ${fmtLon(p.lonDeg)}`);
            set('fact', (p.facts || []).map(([k, v]) => `${k} ${v}`).join(' · '));
            row.classList.toggle('ua-xp-row--found', found.has(p.id));
        }
        const mile = MILESTONES.map(m => `<span class="${found.has(m.id) ? 'on' : ''}">${found.has(m.id) ? '✓' : '○'} ${esc(m.name)}</span>`).join('');
        if (this._pf.mile.innerHTML !== mile) this._pf.mile.innerHTML = mile;
    }

    // ── Immersive ────────────────────────────────────────────────────────
    _bindImmersive() {
        const btn = document.getElementById('ua-cam-immersive');
        btn?.addEventListener('click', () => this.setImmersive(!this.isImmersive()));
        this._onFs = () => {
            if (!document.fullscreenElement && this.isImmersive() && this._fsRequested) {
                this._fsRequested = false;
                this.setImmersive(false);
            }
        };
        document.addEventListener('fullscreenchange', this._onFs);
        // Esc always leaves: in true fullscreen the browser also exits on its
        // own (and fullscreenchange lands here too), but a key it does not
        // consume — or the CSS-only fill — must not strand the view.
        this._onKey = (e) => {
            if (e.key === 'Escape' && this.isImmersive()) { this.setImmersive(false); return; }
            // F toggles full screen (not while typing, not with a modifier).
            if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const tag = (e.target?.tagName || '').toLowerCase();
                if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
                e.preventDefault();
                this.setImmersive(!this.isImmersive());
            }
        };
        window.addEventListener('keydown', this._onKey);
    }
    isImmersive() { return this.wrap.classList.contains('ua-immersive'); }
    setImmersive(on) {
        on = !!on;
        this.wrap.classList.toggle('ua-immersive', on);
        document.body.classList.toggle('ua-immersive-on', on);
        const fsBtn = document.getElementById('ua-cam-immersive');
        if (fsBtn) {
            fsBtn.classList.toggle('ua-cam-on', on);
            fsBtn.setAttribute('aria-pressed', String(on));
            const lbl = fsBtn.querySelector('.ua-cam-fs-label');
            if (lbl) lbl.textContent = on ? 'Exit full screen' : 'Full screen';
        }
        this._panel?.querySelector('[data-act="immersive"]')?.setAttribute('aria-pressed', String(on));
        try {
            if (on && this.wrap.requestFullscreen && !document.fullscreenElement) {
                this._fsRequested = true;
                const p = this.wrap.requestFullscreen();
                p?.catch?.(() => { this._fsRequested = false; });   // the CSS fill stands on its own
            } else if (!on && document.fullscreenElement === this.wrap) {
                this._fsRequested = false;
                document.exitFullscreen?.().catch?.(() => {});
            }
        } catch (_) { /* no Fullscreen API: the CSS fill stands on its own */ }
    }

    dispose() {
        cancelAnimationFrame(this._raf);
        clearInterval(this._panelTimer);
        clearTimeout(this._toastTimer);
        window.removeEventListener('ua-explore', this._onExplore);
        window.removeEventListener('keydown', this._onKey);
        document.removeEventListener('fullscreenchange', this._onFs);
        this._gauge?.remove(); this._toast?.remove(); this._labels?.remove();
    }
}
