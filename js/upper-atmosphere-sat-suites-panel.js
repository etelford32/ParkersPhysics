/**
 * upper-atmosphere-sat-suites-panel.js — the "Satellite suites" panel (DOM)
 * ═══════════════════════════════════════════════════════════════════════════
 * Replaces the eight-checkbox "Live catalog overlay" bar with the whole
 * catalogue the site relays, grouped by what the satellites are FOR
 * (js/upper-atmosphere-sat-suites.js `SAT_SUITES`), plus:
 *
 *   • Orbit rings — the visible suites' planes (globe.setSuiteRingsVisible)
 *   • Frame LEO / MEO / GEO / Fit shown — one-shot camera flights
 *     (globe.frameSatellites); from the home view GPS and GEO are BEHIND the
 *     camera, so without these the MEO/GEO suites "load" and show nothing
 *   • The altitude ladder — where the shown objects sit against the page's
 *     own layers, read from MEAN elements (globe.getSuiteLadder). One series
 *     (count), one hue, no legend; the layer bands are labelled directly and
 *     the summary line under it is the table view of the same numbers.
 *
 * The chips keep the old markup contract (`#ua-catalog-toggles` holding
 * `label[data-group] > input[type=checkbox]`, `#ua-catalog-status`) so a
 * reader of the old bar still finds it. A group that FAILED to load is
 * forgotten and re-fetched on the next tick of its box (it used to be
 * "shown" forever as an empty, invisible group).
 */

import { SAT_SUITES, SUITE_CATEGORIES, FRAME_PRESETS, LADDER_LAYERS } from './upper-atmosphere-sat-suites.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

export class SatSuitesPanel {
    /**
     * @param {HTMLElement} host   the panel body to render into
     * @param {object} globe       UpperAtmosphereGlobe
     */
    constructor(host, globe) {
        this.host = host;
        this.globe = globe;
        this._colors = {};
        this._render();
        this._bind();
        // Swatches use the tracker's OWN group colours (lazy: the tracker
        // module pulls three.js, which the page already has loaded).
        import('./satellite-tracker.js').then((m) => {
            for (const s of SAT_SUITES) this._colors[s.id] = m.getGroupColorHex(s.id);
            for (const el of this.host.querySelectorAll('[data-swatch]')) {
                el.style.background = this._colors[el.dataset.swatch] || '#0cc';
            }
        }).catch(() => {});
        this._onLoaded = () => this.refresh();
        window.addEventListener('satellites-loaded', this._onLoaded);
        window.addEventListener('satellites-load-failed', (e) => {
            const g = e.detail?.group;
            this._setChip(g, false);
            this._status(`${g || 'group'} failed to load — ${e.detail?.error || 'see console'} · tick it again to retry`, 'error');
        });
        this.refresh();
    }

    _render() {
        const cats = SUITE_CATEGORIES.map((c) => {
            const chips = SAT_SUITES.filter((s) => s.category === c.id).map((s) => `
                <label data-group="${esc(s.id)}" title="${esc(s.note)}">
                    <input type="checkbox"><span class="ua-ss-sw" data-swatch="${esc(s.id)}" aria-hidden="true"></span>${esc(s.label)}<span class="ua-ss-n" data-count="${esc(s.id)}"></span>
                </label>`).join('');
            return `<div class="ua-ss-cat"><div class="ua-ss-catlabel">${esc(c.label)}</div><div class="ua-ss-chips">${chips}</div></div>`;
        }).join('');
        const frames = FRAME_PRESETS.map((p) => `<button type="button" class="ua-ss-btn" data-frame="${p.id}" title="Fly out until the whole ${p.label} shell fits the view">${p.label}</button>`).join('');
        this.host.innerHTML = `
            <div class="ua-catalog-toggles ua-ss-cats" id="ua-catalog-toggles">${cats}</div>
            <div class="ua-ss-row">
                <label class="ua-ss-ringtog" title="Draw the orbit of a sample of each shown suite, chosen across its planes">
                    <input type="checkbox" id="ua-ss-rings"> Orbit rings
                </label>
                <span class="ua-ss-framelabel">Frame</span>${frames}
                <button type="button" class="ua-ss-btn" data-frame="visible" title="Fit the shells of the suites you are showing">Fit shown</button>
            </div>
            <div class="ua-catalog-status" id="ua-catalog-status" role="status" aria-live="polite">no suites loaded · tick any suite to begin</div>
            <figure class="ua-ss-ladder" id="ua-ss-ladder" aria-label="Altitude ladder of the shown satellites"></figure>
            <p class="ua-ss-note">Dots: live SGP4 at the simulation clock. Rings: each member's mean orbit with J2 drift — the satellite rides within ~10 km of it. Altitudes on this page are above the 6371 km sphere the globe draws; catalogue figures (above WGS-72's 6378 km) read 7 km lower for the same orbit.</p>`;
    }

    _bind() {
        const bar = this.host.querySelector('#ua-catalog-toggles');
        bar.addEventListener('change', async (e) => {
            const inp = e.target;
            const label = inp?.closest?.('label[data-group]');
            if (!label) return;
            const group = label.dataset.group;
            label.classList.toggle('on', inp.checked);
            this._status(inp.checked ? `loading ${group}…` : `hiding ${group}…`);
            try {
                if (inp.checked) {
                    const s = this.globe.getCatalogStatus?.();
                    const known = s?.groups?.find((g) => g.name === group);
                    if (known && !known.error && known.count > 0) this.globe.showCatalogGroup?.(group);
                    else {
                        if (known) this.globe.forgetCatalogGroup?.(group);
                        const r = await this.globe.enableCatalogGroup(group);
                        if (r && !r.ok) { this._setChip(group, false); this._status(`${group}: ${r.reason}`, 'error'); return; }
                    }
                } else this.globe.disableCatalogGroup(group);
            } catch (err) {
                console.warn('[suites]', group, err);
            }
            this.refresh();
        });
        this.host.querySelector('#ua-ss-rings').addEventListener('change', (e) => {
            this.globe.setSuiteRingsVisible?.(e.target.checked);
            this.refresh();
        });
        this.host.addEventListener('click', (e) => {
            const b = e.target.closest?.('[data-frame]');
            if (!b) return;
            const f = this.globe.frameSatellites?.(b.dataset.frame);
            if (!f && b.dataset.frame === 'visible') this._status('show a suite first, then Fit shown frames it');
        });
    }

    _setChip(group, on) {
        const label = this.host.querySelector(`label[data-group="${CSS.escape(group || '')}"]`);
        if (!label) return;
        label.querySelector('input').checked = on;
        label.classList.toggle('on', on);
    }

    _status(text, kind = '') {
        const el = this.host.querySelector('#ua-catalog-status');
        if (!el) return;
        el.textContent = text;
        el.dataset.kind = kind;
    }

    refresh() {
        const s = this.globe.getCatalogStatus?.() || { total: 0, groups: [] };
        for (const g of s.groups) {
            const n = this.host.querySelector(`[data-count="${CSS.escape(g.name)}"]`);
            if (n) n.textContent = g.count ? ` ${fmt(g.count)}` : '';
        }
        const shown = s.groups.filter((g) => g.visible && g.count > 0);
        if (!s.total) this._status('no suites loaded · tick any suite to begin');
        else {
            const rings = this.globe.getSuiteRingState?.();
            this._status(`${fmt(shown.reduce((a, g) => a + g.count, 0))} shown of ${fmt(s.total)} loaded`
                + (rings?.on ? ` · ${rings.count} orbit rings` : ''), 'ok');
        }
        this._drawLadder();
    }

    _drawLadder() {
        const fig = this.host.querySelector('#ua-ss-ladder');
        const L = this.globe.getSuiteLadder?.();
        if (!fig) return;
        if (!L || !L.total) { fig.innerHTML = ''; fig.hidden = true; return; }
        fig.hidden = false;
        const W = 300, H = 170, padL = 44, padR = 8, padT = 6, padB = 16;
        const y = (km) => padT + (H - padT - padB) * (1 - (km - L.minKm) / (L.maxKm - L.minKm));
        const x = (n) => padL + (W - padL - padR) * (L.peak ? n / L.peak : 0);
        const bands = [];
        // Band edges are the ENGINE's layer table, never typed here.
        for (const layer of LADDER_LAYERS) {
            const id = layer.id;
            const lo = Math.max(L.minKm, layer.minKm), hi = Math.min(L.maxKm, layer.maxKm);
            if (hi <= lo) continue;
            bands.push(`<rect x="${padL}" y="${y(hi).toFixed(1)}" width="${W - padL - padR}" height="${(y(lo) - y(hi)).toFixed(1)}" class="ua-ss-band ua-ss-band--${id}"/>`
                + `<text x="${W - padR - 2}" y="${(y(hi) + 10).toFixed(1)}" class="ua-ss-bandlabel" text-anchor="end">${id}</text>`);
        }
        const bars = L.bins.filter((b) => b.count > 0).map((b) => {
            const y0 = y(b.hiKm) + 1, h = Math.max(1, y(b.loKm) - y(b.hiKm) - 2);
            return `<rect class="ua-ss-bar" x="${padL}" y="${y0.toFixed(1)}" width="${Math.max(2, x(b.count) - padL).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5"><title>${b.loKm}–${b.hiKm} km: ${fmt(b.count)} objects (${b.layer})</title></rect>`;
        }).join('');
        const ticks = [200, 600, 1000, 1500, 2000].filter((k) => k >= L.minKm && k <= L.maxKm)
            .map((k) => `<text x="${padL - 4}" y="${(y(k) + 3).toFixed(1)}" text-anchor="end" class="ua-ss-tick">${k}</text>`
                + `<line x1="${padL}" x2="${W - padR}" y1="${y(k).toFixed(1)}" y2="${y(k).toFixed(1)}" class="ua-ss-grid"/>`).join('');
        const r = L.regimes;
        const beyond = [r.MEO && `MEO ${fmt(r.MEO)}`, r.GEO && `GEO ${fmt(r.GEO)}`, r.HEO && `HEO ${fmt(r.HEO)}`,
            r['beyond-GEO'] && `beyond GEO ${fmt(r['beyond-GEO'])}`].filter(Boolean).join(' · ');
        fig.innerHTML = `
            <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Objects per ${L.binKm} km of mean altitude, ${L.minKm}–${L.maxKm} km">
                ${bands.join('')}${ticks}${bars}
                <text x="4" y="${padT + 8}" class="ua-ss-tick" text-anchor="start">km</text>
                <text x="${W - padR}" y="${H - 3}" class="ua-ss-tick" text-anchor="end">peak ${fmt(L.peak)} per ${L.binKm} km</text>
            </svg>
            <figcaption>
                <span>thermosphere ${fmt(L.layers.thermosphere || 0)}</span> ·
                <span>exosphere ${fmt(L.layers.exosphere || 0)}</span>${L.layers.beyond ? ` · <span>past the model top ${fmt(L.layers.beyond)}</span>` : ''}
                ${L.above ? `<br>above ${L.maxKm} km: ${beyond || fmt(L.above)}` : ''}${L.below ? ` · below ${L.minKm} km: ${fmt(L.below)}` : ''}
            </figcaption>`;
    }

    dispose() { window.removeEventListener('satellites-loaded', this._onLoaded); }
}
