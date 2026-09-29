/**
 * upper-atmosphere-flight-panel.js — the launch panel (Controls pane)
 * ═══════════════════════════════════════════════════════════════════════════
 * Where a flight starts. Three ways in, all of which end in one globe
 * call so the deck, the ribbon and the clock never disagree:
 *
 *   • PRESETS — the kernel's FLIGHT_PRESETS (nine flights that each show
 *     one thing), launched at the page's sim time. Picking one also
 *     fills the custom sliders, so "start from the ISS and steepen the
 *     entry" is two clicks.
 *   • TRACK A SATELLITE — a reference probe's LIVE TLE (or the catalogue
 *     point the analyzer is looking at) seeded through Rust SGP4 and then
 *     carried by the kernel through the live atmosphere. Needs a live TLE:
 *     the mean-element fallback probes are visualisation-grade and the
 *     panel says "waiting for live TLE" rather than integrating them.
 *   • CUSTOM — lat / lon / altitude / speed / flight-path angle / heading /
 *     BC / L/D, with "pick site on the globe" (a click on the planet
 *     through the globe's own probeScreenRay), an inertial-or-airspeed
 *     switch, and a horizon.
 *
 * DOM only. No physics, no three.js.
 */

import { FLIGHT_PRESETS, circularSpeedKms, headingForInclination } from './upper-atmosphere-flight.js';
import { sceneToLatLon } from './upper-atmosphere-column.js';

const SLIDERS = [
    ['latDeg',   'launch latitude',   -89,  89, 0.1,  '°',    0],
    ['lonDeg',   'launch longitude', -180, 180, 0.1,  '°',  -60],
    ['altKm',    'altitude',           80, 2000, 1,   ' km', 400],
    ['speedKms', 'speed',              0.5, 11.5, 0.01, ' km/s', 7.66],
    ['fpaDeg',   'flight-path angle', -30,  60, 0.1,  '°',    0],
    ['headingDeg','heading',            0, 360, 0.5,  '°',   38.4],
    ['bcM2PerKg','BC = CdA/m',      0.002, 0.10, 0.001, ' m²/kg', 0.02],
    ['liftToDrag','L/D (unbanked)',     0,   3, 0.05, '',     0],
];
const HORIZONS = [[3600, '1 h'], [3 * 3600, '3 h'], [86400, '24 h'], [3 * 86400, '3 d'], [7 * 86400, '7 d']];

export class FlightPanel {
    constructor({ host, globe }) {
        this._host = host;
        this._globe = globe;
        this._armed = false;
        this._lastAnalyzed = null;
        this._build();
        this._unsubClick = globe.onCanvasClick?.(({ nx, ny }) => this._onCanvasClick(nx, ny));
        window.addEventListener('ua-analyze-sat', this._onAnalyze = (e) => {
            if (!e.detail?.line1) return;
            this._lastAnalyzed = e.detail;
            const b = this.el.querySelector('.ua-fp-track-analyzed');
            b.hidden = false;
            b.textContent = `Fly ${e.detail.name || 'analyzer target'}`;
        });
        window.addEventListener('ua-flight-launched', () => this._refreshStatus());
        this._statusTimer = setInterval(() => this._refreshStatus(), 1000);
    }

    _build() {
        const el = document.createElement('div');
        el.className = 'ua-fp';
        const groups = [['orbit', 'orbits'], ['transfer', 'transfers'], ['flight', 'flight & entry']];
        el.innerHTML = `
            <div class="ua-fp-presets">
                ${groups.map(([g, label]) => `
                    <div class="ua-fp-group"><span class="ua-fp-grouplabel">${label}</span>
                    ${FLIGHT_PRESETS.filter(p => p.group === g).map(p =>
                        `<button type="button" class="ua-chip ua-fp-preset" data-preset="${p.id}" title="${p.blurb.replace(/"/g, '&quot;')}">${p.name}</button>`).join('')}
                    </div>`).join('')}
            </div>
            <div class="ua-fp-track">
                <select class="ua-fp-sat" aria-label="Satellite to track"></select>
                <button type="button" class="ua-chip ua-chip--live ua-fp-track-btn" title="Seed from the live TLE through Rust SGP4, then integrate through the live atmosphere">▶ Track</button>
                <button type="button" class="ua-chip ua-fp-track-analyzed" hidden title="Fly the satellite the trajectory analyzer is looking at"></button>
            </div>
            <details class="ua-fp-custom">
                <summary>Custom launch</summary>
                <div class="ua-fp-sliders">
                ${SLIDERS.map(([k, label, min, max, step, unit, v]) => `
                    <div class="ua-slider-row">
                        <div class="ua-slider-hd"><label for="ua-fp-${k}">${label}</label><span class="ua-val" data-val="${k}">${v}${unit}</span></div>
                        <input id="ua-fp-${k}" type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-k="${k}" data-unit="${unit}">
                    </div>`).join('')}
                </div>
                <div class="ua-fp-row">
                    <label class="ua-chip" title="Speed relative to the rotating ground (an airspeed) instead of inertial"><input type="checkbox" class="ua-fp-ground"> airspeed</label>
                    <button type="button" class="ua-chip ua-fp-pick" title="Then click the planet to set the launch latitude / longitude">⌖ pick site on globe</button>
                    <button type="button" class="ua-chip ua-fp-circ" title="Set speed to circular orbital speed at this altitude">v = v_circ</button>
                    <select class="ua-fp-horizon" aria-label="Integration horizon">
                        ${HORIZONS.map(([s, l]) => `<option value="${s}" ${s === 86400 ? 'selected' : ''}>${l}</option>`).join('')}
                    </select>
                </div>
                <div class="ua-fp-row">
                    <button type="button" class="ua-chip ua-chip--live ua-fp-launch">🚀 Launch</button>
                    <span class="ua-fp-inc" title="Inclination this heading + latitude produce"></span>
                </div>
            </details>
            <div class="ua-fp-status ua-dim"></div>`;
        this._host.appendChild(el);
        this.el = el;

        el.querySelectorAll('.ua-fp-preset').forEach(b => b.addEventListener('click', () => {
            const p = FLIGHT_PRESETS.find(x => x.id === b.dataset.preset);
            if (!p) return;
            this._fillFrom(p);
            this._globe.launchPreset?.(p.id);
            this._globe.frameFlight?.();
            el.querySelectorAll('.ua-fp-preset').forEach(x => x.classList.toggle('ua-chip--on', x === b));
            this._setStatus(`${p.name} launched at the sim clock — ${p.blurb}`);
        }));
        el.querySelectorAll('input[type=range]').forEach(inp => inp.addEventListener('input', () => {
            el.querySelector(`[data-val="${inp.dataset.k}"]`).textContent = `${inp.value}${inp.dataset.unit}`;
            this._refreshInclination();
        }));
        el.querySelector('.ua-fp-circ').addEventListener('click', () => {
            const alt = Number(el.querySelector('#ua-fp-altKm').value);
            this._set('speedKms', circularSpeedKms(alt).toFixed(2));
            el.querySelector('.ua-fp-ground').checked = false;
        });
        el.querySelector('.ua-fp-pick').addEventListener('click', () => {
            this._armed = !this._armed;
            el.querySelector('.ua-fp-pick').classList.toggle('ua-chip--on', this._armed);
            this._setStatus(this._armed ? 'Click the planet to set the launch site.' : '');
        });
        el.querySelector('.ua-fp-launch').addEventListener('click', () => this.launchCustom());
        el.querySelector('.ua-fp-track-btn').addEventListener('click', () => this.trackSelected());
        el.querySelector('.ua-fp-track-analyzed').addEventListener('click', () => {
            if (this._lastAnalyzed) this._track(this._lastAnalyzed);
        });
        this._refreshSatList();
        window.addEventListener('ua-tle-update', () => this._refreshSatList());
        setTimeout(() => this._refreshSatList(), 4000);
        this._refreshInclination();
    }

    _set(k, v) {
        const inp = this.el.querySelector(`#ua-fp-${k}`);
        if (!inp) return;
        inp.value = String(v);
        this.el.querySelector(`[data-val="${k}"]`).textContent = `${inp.value}${inp.dataset.unit}`;
    }
    _fillFrom(p) {
        for (const k of ['latDeg', 'lonDeg', 'altKm', 'speedKms', 'fpaDeg', 'headingDeg']) {
            const v = p.launch[k];
            if (Number.isFinite(v)) this._set(k, k === 'speedKms' ? v.toFixed(2) : +v.toFixed(1));
        }
        this._set('bcM2PerKg', p.bcM2PerKg);
        this._set('liftToDrag', p.liftToDrag);
        this.el.querySelector('.ua-fp-ground').checked = !!p.launch.groundRelative;
        this.el.querySelector('.ua-fp-horizon').value = String(p.horizonS);
        this._refreshInclination();
    }
    _read() {
        const o = {};
        for (const [k] of SLIDERS) o[k] = Number(this.el.querySelector(`#ua-fp-${k}`).value);
        o.groundRelative = this.el.querySelector('.ua-fp-ground').checked;
        o.horizonS = Number(this.el.querySelector('.ua-fp-horizon').value);
        return o;
    }
    _refreshInclination() {
        const o = this._read();
        const cosI = Math.cos(o.latDeg * Math.PI / 180) * Math.sin(o.headingDeg * Math.PI / 180);
        const inc = Math.acos(Math.max(-1, Math.min(1, cosI))) * 180 / Math.PI;
        const vc = circularSpeedKms(o.altKm);
        this.el.querySelector('.ua-fp-inc').textContent =
            `i ≈ ${inc.toFixed(1)}° · v_circ ${vc.toFixed(2)} km/s${headingForInclination(51.6, o.latDeg) == null ? '' : ''}`;
    }

    launchCustom() {
        const o = this._read();
        this._globe.launchFromSite?.(
            { latDeg: o.latDeg, lonDeg: o.lonDeg, altKm: o.altKm, speedKms: o.speedKms,
              fpaDeg: o.fpaDeg, headingDeg: o.headingDeg, groundRelative: o.groundRelative },
            { bcM2PerKg: o.bcM2PerKg, liftToDrag: o.liftToDrag, horizonS: o.horizonS, name: 'custom probe' });
        this._globe.frameFlight?.();
        this.el.querySelectorAll('.ua-fp-preset').forEach(x => x.classList.remove('ua-chip--on'));
        this._setStatus('Custom probe launched at the sim clock.');
    }

    _refreshSatList() {
        const sel = this.el.querySelector('.ua-fp-sat');
        const states = this._globe.getSatelliteStates?.() || [];
        const cur = sel.value;
        sel.innerHTML = states.map(s => {
            const meta = this._globe.getProbeMeta?.(s.id);
            const live = !!meta?.tleLines;
            return `<option value="${s.id}" ${live ? '' : 'disabled'}>${s.name}${live ? '' : ' (waiting for live TLE)'}</option>`;
        }).join('') || '<option value="">no satellites</option>';
        if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
    }
    async trackSelected() {
        const id = this.el.querySelector('.ua-fp-sat').value;
        const meta = this._globe.getProbeMeta?.(id);
        if (!meta?.tleLines) { this._setStatus('No live TLE for that satellite yet — the mean-element marker is visualisation-grade and is not integrated.'); return; }
        await this._track({ ...meta.tleLines, name: meta.name, noradId: meta.noradId, color: meta.color });
    }
    async _track({ line1, line2, name, noradId, color }) {
        try {
            this._setStatus(`Seeding ${name} from SGP4…`);
            await this._globe.trackFlightFromTle?.({ line1, line2, name, noradId, color,
                                                     bcM2PerKg: Number(this.el.querySelector('#ua-fp-bcM2PerKg').value) });
            this.el.querySelectorAll('.ua-fp-preset').forEach(x => x.classList.remove('ua-chip--on'));
            this._globe.frameFlight?.();
            this._setStatus(`${name} seeded from its live TLE via SGP4 at the sim clock; the kernel carries it through the live atmosphere from here.`);
        } catch (err) {
            this._setStatus(`Could not seed ${name}: ${err?.message || err}`);
        }
    }

    _onCanvasClick(nx, ny) {
        if (!this._armed) return false;
        const q = this._globe.probeScreenRay?.(nx, ny);
        if (!q?.hitsPlanet) { this._setStatus('Click ON the planet to set the site (that ray missed it).'); return true; }
        const ll = sceneToLatLon([q.point.x, q.point.y, q.point.z]);
        this._set('latDeg', ll.latDeg.toFixed(1));
        this._set('lonDeg', ll.lonDeg.toFixed(1));
        this._armed = false;
        this.el.querySelector('.ua-fp-pick').classList.remove('ua-chip--on');
        this.el.querySelector('.ua-fp-custom').open = true;
        this._refreshInclination();
        this._setStatus(`Launch site set to ${ll.latDeg.toFixed(1)}°, ${ll.lonDeg.toFixed(1)}°.`);
        return true;
    }

    _setStatus(msg) { this.el.querySelector('.ua-fp-status').textContent = msg; }
    _refreshStatus() {
        const layer = this._globe.getFlightLayer?.();
        const f = layer?.getFlight?.();
        if (!f) return;
        const st = this.el.querySelector('.ua-fp-status');
        if (!f.done) st.textContent = `${f.name}: integrating… ${Math.round(f.tEndS / 3600)} h so far, ${f.n.toLocaleString()} samples.`;
    }

    dispose() {
        this._unsubClick?.();
        clearInterval(this._statusTimer);
        window.removeEventListener('ua-analyze-sat', this._onAnalyze);
        this.el.remove();
    }
}
