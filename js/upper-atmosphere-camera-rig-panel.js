/**
 * upper-atmosphere-camera-rig-panel.js — the camera rig's controls (DOM only)
 * ═══════════════════════════════════════════════════════════════════════════
 * Reads and drives the globe's rig API (`setCameraDragTool`, `setCameraFov`,
 * `flyToLimb`, `setParticleSolo`, `recenterCameraPivot`, `getCameraRig`)
 * and the page's ONE physics sampler (`layerPhysics`). It computes no
 * geometry and no physics of its own.
 *
 *   • DRAG TOOL — what a left drag / one finger does in orbit mode:
 *     orbit · pan · swivel. Mirrored by the three chips in the camera HUD
 *     (both follow the globe, polled — never trust whichever was clicked).
 *   • LENS — vertical field of view 2°–90°, printed as a 35 mm-equivalent
 *     focal length; three presets.
 *   • PIVOT — where the camera orbits, and a button to orbit the planet again.
 *   • LAYER LENS — a telephoto view ACROSS the atmosphere at a model-placed
 *     site's limb, framing one layer (the only view in which a 35 km layer
 *     spans the frame), with an option to show ONLY that layer's particle
 *     population, and the population itself: the engine's number fractions,
 *     density, temperature, mean free path, thermal speed and Knudsen number
 *     at the layer's peak.
 *
 * Rows are built ONCE and updated in place (the neo-watch lesson: a list
 * re-rendered under the cursor at a few Hz eats the click).
 */

import { ATMOSPHERIC_LAYER_SCHEMA } from './upper-atmosphere-layers.js';
import { layerPhysics, SPECIES_COLOR_HEX } from './upper-atmosphere-physics.js';
import { RIG, focalLengthMm } from './upper-atmosphere-camera-rig.js';

const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtKm = (km) => !Number.isFinite(km) ? '—' : Math.abs(km) >= 10000 ? `${(km / 1000).toFixed(0)}k km` : `${Math.round(km)} km`;
const fmtLen = (km) => !Number.isFinite(km) ? '∞' : km >= 1 ? `${km >= 100 ? km.toFixed(0) : km.toFixed(1)} km`
    : km >= 1e-3 ? `${(km * 1000).toFixed(km >= 0.01 ? 0 : 1)} m` : `${(km * 1e6).toFixed(0)} mm`;

// Lens slider runs on log(fov) so the telephoto end is not crammed into a few pixels.
const LOG_MIN = Math.log(RIG.fovMinDeg), LOG_MAX = Math.log(RIG.fovMaxDeg);
const sliderToFov = (v) => Math.exp(LOG_MIN + (LOG_MAX - LOG_MIN) * (v / 1000));
const fovToSlider = (f) => Math.round(1000 * (Math.log(f) - LOG_MIN) / (LOG_MAX - LOG_MIN));

const BANDS = [
    ...ATMOSPHERIC_LAYER_SCHEMA.map((L) => ({ id: L.id, name: L.name, minKm: L.minKm, maxKm: L.maxKm, lo: L.colorLow, hi: L.colorHigh })),
    { id: 'band', name: 'Whole band', minKm: 80, maxKm: 2000, lo: 0x6e9bff, hi: 0xb47cff },
];

export class CameraRigPanel {
    /**
     * @param {object} o
     * @param {HTMLElement} o.host       where the panel mounts (Controls column)
     * @param {object} o.globe           the AtmosphereGlobe
     * @param {() => {f107:number, ap:number}} o.getState  the page's drivers
     * @param {HTMLElement} [o.hudToolHost]  the camera HUD's drag-tool chip row
     */
    constructor({ host, globe, getState, hudToolHost = null }) {
        this.globe = globe;
        this.getState = getState;
        this.host = host;
        this.hudToolHost = hudToolHost;
        this._layer = 'lower-thermosphere';
        this._site = 'dusk';
        this._solo = false;
        if (host) this._build(host);
        if (hudToolHost) this._bindHudTools(hudToolHost);
        this._timer = setInterval(() => this.refresh(), 300);
        this.refresh(true);
    }

    dispose() { clearInterval(this._timer); }

    _build(host) {
        host.innerHTML = `
            <div class="ua-rig">
                <div class="ua-rig-row">
                    <span class="ua-rig-k">drag</span>
                    <span class="ua-rig-seg" role="group" aria-label="Drag tool" data-f="tools">
                        <button type="button" data-tool="orbit" title="Left drag orbits the pivot (right drag pans)">⟲ orbit</button>
                        <button type="button" data-tool="pan" title="Left drag pans the pivot across the view (right drag orbits)">✥ pan</button>
                        <button type="button" data-tool="swivel" title="Left drag turns the view about the camera — a tripod head. Alt + drag does this with any tool.">◎ swivel</button>
                    </span>
                </div>
                <div class="ua-rig-row">
                    <span class="ua-rig-k">lens</span>
                    <input type="range" min="0" max="1000" step="1" data-f="fov" aria-label="Field of view (log scale)"
                           title="Vertical field of view — narrower is a longer lens: the band magnifies without the camera moving through it">
                    <span class="ua-rig-v" data-f="fovv">—</span>
                </div>
                <div class="ua-rig-row ua-rig-row--chips">
                    <button type="button" class="ua-xp-chip" data-fov="75" title="Wide — 75°">wide</button>
                    <button type="button" class="ua-xp-chip" data-fov="40" title="The page's normal lens — 40°">normal</button>
                    <button type="button" class="ua-xp-chip" data-fov="12" title="Telephoto — 12°">tele</button>
                    <button type="button" class="ua-xp-chip" data-fov="4" title="Super-telephoto — 4°">super-tele</button>
                </div>
                <div class="ua-rig-row">
                    <span class="ua-rig-k">pivot</span>
                    <span class="ua-rig-v ua-rig-v--wide" data-f="pivot">—</span>
                    <button type="button" class="ua-xp-mini" data-act="recenter" title="Orbit the planet's centre again from where the camera is">⌖ planet</button>
                </div>

                <div class="ua-rig-sub">Layer lens <span class="ua-rig-dim">— a telephoto view across the atmosphere at the limb</span></div>
                <div class="ua-rig-row">
                    <span class="ua-rig-k">site</span>
                    <select class="ua-rig-select" data-f="site" title="Where on the planet to look across the limb. Noon / dusk / midnight / dawn come from the sub-solar point; the bulge, the trough and the aurora are placed by the page's own model right now."></select>
                </div>
                <div class="ua-rig-layers" data-f="layers">
                    ${BANDS.map((b) => `
                        <button type="button" class="ua-rig-layer" data-layer="${b.id}"
                                title="Frame the ${esc(b.name)} (${b.minKm}–${b.maxKm} km) across the limb at the chosen site">
                            <span class="ua-rig-sw" style="background:linear-gradient(90deg,${hex(b.lo)},${hex(b.hi)})"></span>
                            <span class="ua-rig-ln">${esc(b.name)}</span>
                            <span class="ua-rig-lb">${b.minKm}–${b.maxKm}</span>
                        </button>`).join('')}
                </div>
                <label class="ua-rig-check" title="Hide every other layer's particles, so the population you are looking at is the only one drawn">
                    <input type="checkbox" data-f="solo"> show only this layer's particles
                </label>
                <div class="ua-rig-pop" data-f="pop"></div>

                <div class="ua-xp-keys">
                    Orbit mode, pointer over the globe: <b>←/→/↑/↓</b> orbit · <b>Shift+arrows</b> pan ·
                    <b>+/−</b> zoom to the pivot · <b>[ / ]</b> lens · <b>right-drag</b> or <b>Shift+drag</b> pan ·
                    <b>Alt+drag</b> swivel · <b>scroll</b> zoom · two fingers pinch / pan.
                </div>
                <p class="ua-xp-note">A layer view puts the camera in the tangent plane of the site, so the
                site sits on the limb and the layer is seen edge-on — the way the airglow is
                photographed from orbit. It then orbits the LIMB POINT about the local vertical:
                drag sideways to walk round it (it stays on the limb), up to look down on it.
                The ground limb is kept in frame as the altitude reference. Particles are symbols
                (one dot is not one molecule); the population card is the engine's number at the
                layer's peak for the page's F10.7 / Ap.</p>
            </div>`;
        this._el = host.querySelector('.ua-rig');
        this._f = {};
        this._el.querySelectorAll('[data-f]').forEach((n) => { this._f[n.dataset.f] = n; });

        this._el.addEventListener('click', (e) => {
            const tool = e.target.closest('[data-tool]');
            if (tool) { this.globe.setCameraDragTool?.(tool.dataset.tool); this.refresh(); return; }
            const fov = e.target.closest('[data-fov]');
            if (fov) { this.globe.setCameraFov?.(Number(fov.dataset.fov)); this.refresh(); return; }
            const L = e.target.closest('[data-layer]');
            if (L) { this.selectLayer(L.dataset.layer, { fly: true }); return; }
            const a = e.target.closest('[data-act]');
            if (a?.dataset.act === 'recenter') { this.globe.recenterCameraPivot?.(); }
        });
        this._f.fov.addEventListener('input', () => {
            this.globe.setCameraFov?.(sliderToFov(Number(this._f.fov.value)));
            this._paintLens();
        });
        this._f.site.addEventListener('change', () => { this._site = this._f.site.value; });
        this._f.solo.addEventListener('change', () => {
            this._solo = this._f.solo.checked;
            this.globe.setParticleSolo?.(this._solo && this._layer !== 'band' ? this._layer : null);
        });
    }

    _bindHudTools(host) {
        host.addEventListener('click', (e) => {
            const b = e.target.closest('[data-tool]');
            if (!b) return;
            this.globe.setCameraDragTool?.(b.dataset.tool);
            this.refresh();
        });
    }

    /** Pick a layer (and optionally fly the camera to its limb view). */
    selectLayer(id, { fly = false } = {}) {
        this._layer = id;
        if (this._solo) this.globe.setParticleSolo?.(id !== 'band' ? id : null);
        if (fly) this.globe.flyToLimb?.({ layerId: id, siteId: this._site });
        this.refresh(true);
    }

    refresh(force = false) {
        const g = this.globe;
        const tool = g.getCameraDragTool?.() ?? 'orbit';
        for (const host of [this._f?.tools, this.hudToolHost]) {
            host?.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
        }
        if (!this._el) return;
        this._paintLens();
        this._paintPivot();
        this._paintSites(force);
        this._el.querySelectorAll('[data-layer]').forEach((b) =>
            b.setAttribute('aria-pressed', String(b.dataset.layer === this._layer)));
        const t = Date.now();
        if (force || !this._popAt || t - this._popAt > 2000) { this._popAt = t; this._paintPopulation(); }
    }

    _paintLens() {
        const f = this.globe.getCameraFov?.();
        if (!Number.isFinite(f) || !this._f?.fov) return;
        if (document.activeElement !== this._f.fov) this._f.fov.value = String(fovToSlider(f));
        this._f.fovv.textContent = `${f.toFixed(f < 10 ? 1 : 0)}° · ${Math.round(focalLengthMm(f))} mm`;
    }

    _paintPivot() {
        const r = this.globe.getCameraRig?.();
        if (!r || !this._f?.pivot) return;
        const frame = r.planetFrame ? 'Earth centre'
            : r.pivotAltKm < 2500 ? `${fmtKm(r.pivotAltKm)} alt · ${fmtKm(r.pivotRangeKm)} away`
            : `${fmtKm(r.pivotRangeKm)} away`;
        this._f.pivot.textContent = `${frame}${r.mode !== 'orbit' ? ` (${r.mode})` : ''}`;
    }

    _paintSites(force) {
        const sel = this._f?.site;
        if (!sel) return;
        const t = Date.now();
        if (!force && this._sitesAt && t - this._sitesAt < 5000) return;
        this._sitesAt = t;
        const sites = this.globe.getLimbSites?.() || [];
        const ids = sites.map((s) => s.id).join(',');
        if (ids !== this._siteIds) {
            this._siteIds = ids;
            sel.innerHTML = sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
        }
        for (const s of sites) {
            const o = sel.querySelector(`option[value="${s.id}"]`);
            if (o) o.title = `${s.latDeg.toFixed(1)}°, ${s.lonDeg.toFixed(1)}° — placed by ${s.placedBy}`;
        }
        if (!sites.some((s) => s.id === this._site)) this._site = sites[0]?.id ?? 'dusk';
        if (sel.value !== this._site) sel.value = this._site;
    }

    _paintPopulation() {
        const box = this._f?.pop;
        if (!box) return;
        const { f107 = 150, ap = 15 } = this.getState?.() || {};
        const L = ATMOSPHERIC_LAYER_SCHEMA.find((x) => x.id === this._layer);
        if (!L) {
            box.innerHTML = `<div class="ua-rig-dim">Pick a layer to see its particle population.</div>`;
            return;
        }
        let p;
        try { p = layerPhysics(L, { f107Sfu: f107, ap }); } catch (_) { p = null; }
        if (!p) { box.innerHTML = ''; return; }
        const fr = Object.entries(p.fractions || {}).filter(([, v]) => v > 0.001).sort((a, b) => b[1] - a[1]);
        const bar = fr.map(([sp, v]) =>
            `<span style="flex:${v.toFixed(4)};background:${hex(SPECIES_COLOR_HEX[sp] ?? 0x888888)}" title="${sp} ${(100 * v).toFixed(1)} %"></span>`).join('');
        const legend = fr.slice(0, 5).map(([sp, v]) =>
            `<span><i style="background:${hex(SPECIES_COLOR_HEX[sp] ?? 0x888888)}"></i>${sp} ${(100 * v).toFixed(v < 0.1 ? 1 : 0)}%</span>`).join('');
        box.innerHTML = `
            <div class="ua-rig-pop-h"><b>${esc(L.name)}</b> population at ${L.peakKm} km
                <span class="ua-rig-regime ua-rig-regime--${esc(p.regime)}">${esc(p.regime)}</span></div>
            <div class="ua-rig-bar">${bar}</div>
            <div class="ua-rig-leg">${legend}</div>
            <div class="ua-rig-grid">
                <span>n</span><b>${p.n.toExponential(2)} m⁻³</b>
                <span>ρ</span><b>${p.ρ.toExponential(2)} kg/m³</b>
                <span>T</span><b>${p.T.toFixed(0)} K</b>
                <span>λ</span><b>${fmtLen(p.mfp_km)}</b>
                <span>v_th</span><b>${Number.isFinite(p.vth_m_s) ? Math.round(p.vth_m_s) + ' m/s' : '—'}</b>
                <span>Kn</span><b>${Number.isFinite(p.knudsen) ? (p.knudsen >= 100 ? p.knudsen.toExponential(1) : p.knudsen.toFixed(2)) : '∞'}</b>
            </div>`;
    }
}
