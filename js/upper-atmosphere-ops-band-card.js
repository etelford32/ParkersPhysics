/**
 * upper-atmosphere-ops-band-card.js — the selected band's card (DOM only)
 * ═══════════════════════════════════════════════════════════════════════════
 * What a selected operational band IS, printed beside the canvas: its
 * name, extent and what it means for planning (the kernel's table), the
 * assets that live there, and the live numbers for it under the page's
 * own F10.7 / Ap — density, scale height, circular speed, period, drag
 * deceleration, height lost per orbit and the King–Hele decay estimate
 * at the disclosed reference B (`bandMetrics`, the ONE engine). Two ways
 * in: "Go there" rides the camera to the band's reference altitude
 * (`goToAltitude`), "Limb view" frames the band across the limb through
 * the camera rig's layer lens (`flyToLimb`). ‹ › step through the ladder.
 *
 * It computes nothing and owns no state: the globe's selection is the
 * truth ('ua-ops-band' events), and the card re-prints its numbers every
 * 2 s while open because the indices can be live. Mounted inside the
 * camera dock under the readout, so it never competes with the readout
 * for the same corner.
 */

import { OPS_BANDS, bandMetrics, hexCss, REF_BALLISTIC_KG_M2 } from './upper-atmosphere-ops-bands.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtRho = (v) => Number.isFinite(v) ? v.toExponential(2).replace('e-', 'e−') + ' kg/m³' : '—';
const fmtDecel = (a) => !Number.isFinite(a) ? '—' : a >= 1e-3 ? `${a.toExponential(1)} m/s²` : `${(a * 1e6).toFixed(a * 1e6 >= 10 ? 0 : 1)} µm/s²`;
const fmtDrop = (m) => !Number.isFinite(m) ? '—' : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : m >= 1 ? `${m.toFixed(m >= 10 ? 0 : 1)} m` : `${(m * 100).toFixed(1)} cm`;

export class OpsBandCard {
    /**
     * @param {object} o
     * @param {HTMLElement} o.host    where to mount (the camera dock)
     * @param {object} o.globe
     * @param {() => {f107:number, ap:number}} o.getState
     */
    constructor({ host, globe, getState }) {
        this.globe = globe;
        this.getState = getState;
        this._id = null;
        const el = document.createElement('div');
        el.id = 'ua-band-card';
        el.className = 'ua-bc';
        el.hidden = true;
        el.setAttribute('role', 'region');
        el.setAttribute('aria-label', 'Selected operational band');
        host.appendChild(el);
        this.el = el;
        el.addEventListener('click', (e) => {
            const b = e.target.closest('[data-act]');
            if (!b) return;
            const act = b.dataset.act;
            const band = this.band;
            if (act === 'close') globe.selectOpsBand?.(null);
            else if (act === 'prev' || act === 'next') {
                const i = OPS_BANDS.findIndex(x => x.id === this._id);
                const j = Math.max(0, Math.min(OPS_BANDS.length - 1, i + (act === 'next' ? 1 : -1)));
                globe.selectOpsBand?.(OPS_BANDS[j].id);
            } else if (act === 'go' && band) globe.goToAltitude?.(band.refKm);
            else if (act === 'limb' && band) globe.flyToLimb?.({ layerId: 'band', siteId: 'dusk', minKm: band.minKm, maxKm: band.maxKm });
        });
        this._onBand = (e) => { if (e.detail?.kind === 'select') this.set(e.detail.id); };
        window.addEventListener('ua-ops-band', this._onBand);
        this._timer = setInterval(() => { if (!this.el.hidden) this._paintMetrics(); }, 2000);
        this.set(globe.getSelectedOpsBand?.()?.id ?? null);
    }

    get band() { return this._id ? OPS_BANDS.find(b => b.id === this._id) || null : null; }

    set(id) {
        this._id = id || null;
        const band = this.band;
        this.el.hidden = !band;
        if (!band) return;
        const i = OPS_BANDS.indexOf(band);
        const c = hexCss(band.colorHex);
        this.el.style.setProperty('--c', c);
        this.el.innerHTML = `
            <div class="ua-bc-head">
                <i class="ua-bc-sw"></i>
                <div class="ua-bc-title">
                    <b>${esc(band.name)}</b>
                    <span class="ua-bc-range">${band.minKm}–${band.maxKm} km · ${esc(band.short)}</span>
                </div>
                <button type="button" class="ua-bc-ico" data-act="prev" title="Band below" ${i === 0 ? 'disabled' : ''}>‹</button>
                <button type="button" class="ua-bc-ico" data-act="next" title="Band above" ${i === OPS_BANDS.length - 1 ? 'disabled' : ''}>›</button>
                <button type="button" class="ua-bc-ico" data-act="close" title="Deselect (Esc)">✕</button>
            </div>
            <p class="ua-bc-ops">${esc(band.ops)}</p>
            <div class="ua-bc-ex">${band.examples.map(x => `<span>${esc(x)}</span>`).join('')}</div>
            <div class="ua-bc-grid" data-metrics></div>
            <div class="ua-bc-foot">
                <button type="button" data-act="go" title="Ride the camera to ${band.refKm} km, inside this band">⇣ Go there</button>
                <button type="button" data-act="limb" title="Frame this band across the limb through the layer lens">◐ Limb view</button>
                <span class="ua-bc-note">decay = King–Hele at B ${REF_BALLISTIC_KG_M2} kg/m², order of magnitude · shell drawn at its true extent, √-stretched</span>
            </div>`;
        this._paintMetrics();
    }

    _paintMetrics() {
        const band = this.band, host = this.el.querySelector('[data-metrics]');
        if (!band || !host) return;
        const st = this.getState?.() || {};
        const m = bandMetrics(band, { f107Sfu: st.f107 ?? 150, ap: st.ap ?? 15 });
        const rows = [
            ['ρ @' + band.refKm + ' km', fmtRho(m.rhoKgM3)],
            ['scale height', `${m.scaleHeightKm.toFixed(0)} km`],
            ['v circular', `${m.vKmS.toFixed(2)} km/s`],
            ['period', `${m.periodMin.toFixed(1)} min`],
            ['drag decel', fmtDecel(m.decelMS2)],
            ['drop / orbit', fmtDrop(m.decayPerOrbitM)],
            ['decay', `~${m.lifetime.text}`],
            ['T local', `${m.T.toFixed(0)} K`],
        ];
        host.innerHTML = rows.map(([k, v]) => `<span class="ua-bc-k">${esc(k)}</span><span class="ua-bc-v" data-cls="${k === 'decay' ? m.lifetime.cls : ''}">${esc(v)}</span>`).join('');
    }

    destroy() {
        window.removeEventListener('ua-ops-band', this._onBand);
        clearInterval(this._timer);
        this.el.remove();
    }
}
