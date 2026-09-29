/**
 * upper-atmosphere-flight-deck.js — the flight deck (DOM, three-free)
 * ═══════════════════════════════════════════════════════════════════════════
 * The on-canvas instrument for a flight: every number it prints is a
 * column of the kernel's interpolated sample at the head (or a kernel
 * function of it — `orbitalElements`, the engine's `pointPhysics`), so
 * the deck is node-verifiable through `tests/upper-atmosphere-flight.mjs`
 * without a GPU. It imports NO three.js: the only geometry it needs — where
 * the head is on screen, for the name tag — comes through the globe's
 * `projectToScreen` hook, the same discipline as the limb probe.
 *
 * Two clocks are on the deck and it says which is running: LIVE (mission
 * time follows the page bus) or its own transport (rates up to 3600×, a
 * scrub bar over the integrated span). The globe pins the sun to the
 * deck's clock while it is detached, so scrubbing a day sweeps the
 * terminator and the bulge under the orbit.
 *
 * Every derived quantity that is a proxy says so on the deck: the heating
 * number is Sutton–Graves for a 1 m nose, the arrow lengths are log-scaled,
 * lift is unbanked, and a flight that reaches the 80 km floor is reported
 * as having left the modelled band, not as having landed.
 */

import { COL, STRIDE, orbitalElements, describeStatus } from './upper-atmosphere-flight.js';
import { COLOR_MODES } from './upper-atmosphere-flight-layer.js';
import { pointPhysics } from './upper-atmosphere-physics.js';

const RATES = [1, 10, 60, 600, 3600];
const KM = (v, d = 0) => Number.isFinite(v) ? `${v.toFixed(d)} km` : '—';
const EXP = (v, d = 2) => Number.isFinite(v) && v !== 0 ? v.toExponential(d) : (v === 0 ? '0' : '—');
const FIX = (v, d = 2, unit = '') => Number.isFinite(v) ? `${v.toFixed(d)}${unit}` : '—';

export function fmtMissionTime(tS) {
    if (!Number.isFinite(tS)) return 'T+ —';
    const sign = tS < 0 ? '−' : '+';
    let s = Math.abs(Math.round(tS));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `T${sign}${d ? d + 'd ' : ''}${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Pretty-print an accel in m/s² with a sensible unit ladder. */
export function fmtAccel(a) {
    if (!Number.isFinite(a)) return '—';
    if (a === 0) return '0';
    if (a >= 0.1) return `${a.toFixed(3)} m/s²`;
    if (a >= 1e-4) return `${(a * 1e3).toFixed(3)} mm/s²`;
    if (a >= 1e-7) return `${(a * 1e6).toFixed(3)} µm/s²`;
    return `${a.toExponential(2)} m/s²`;
}

const ROWS = [
    ['alt',     'altitude'],
    ['speed',   '|v| inertial'],
    ['vrel',    '|v_rel| air'],
    ['rho',     'ρ local'],
    ['rhoratio','local ÷ global'],
    ['q',       'q = ½ρv²'],
    ['adrag',   'a_drag'],
    ['agrav',   'g'],
    ['gload',   'load'],
    ['energy',  'ε specific'],
    ['hmag',    '|h| specific'],
    ['dedt',    'dε/dt'],
    ['dadt',    'da/dt'],
    ['heat',    'heating*'],
    ['latlon',  'lat · lon'],
    ['lst',     'local solar'],
    ['regime',  'flow regime'],
    ['elems',   'a · e · i'],
    ['apsides', 'perigee · apogee'],
    ['period',  'period'],
];

export class FlightDeck {
    /**
     * @param {object} o
     * @param {HTMLElement} o.host    the globe wrap (positioned)
     * @param {object} o.globe        AtmosphereGlobe
     * @param {Function} [o.getState] () => ({ f107, ap })
     */
    constructor({ host, globe, getState }) {
        this._host = host;
        this._globe = globe;
        this._getState = getState || (() => ({ f107: 150, ap: 15 }));
        this._lastSparkKey = '';
        this._summary = null;
        this._summaryAt = 0;
        this._build();
        this._timer = setInterval(() => this._paint(), 125);
        this._raf = requestAnimationFrame(this._tagLoop = this._tagLoop.bind(this));
        window.addEventListener('ua-flight-launched', this._onLaunched = () => {
            this._summary = null;
            this._lastSparkKey = '';
            this.el.hidden = false;
            this._paint();
        });
    }

    _build() {
        const el = document.createElement('div');
        el.id = 'ua-flight-deck';
        el.className = 'ua-fd';
        el.dataset.open = '1';
        el.hidden = true;
        el.innerHTML = `
            <div class="ua-fd-head">
                <span class="ua-fd-dot"></span>
                <span class="ua-fd-name">flight</span>
                <span class="ua-fd-status" data-f="status">—</span>
                <button type="button" class="ua-fd-btn ua-fd-toggle" aria-expanded="true" title="Collapse / expand the deck">▾</button>
                <button type="button" class="ua-fd-btn ua-fd-close" title="End this flight">×</button>
            </div>
            <div class="ua-fd-body">
                <div class="ua-fd-transport" role="group" aria-label="Mission clock">
                    <button type="button" class="ua-fd-btn" data-act="restart" title="Back to launch (T+0)">⏮</button>
                    <button type="button" class="ua-fd-btn" data-act="playpause" title="Play / pause the mission clock">⏸</button>
                    ${RATES.map(r => `<button type="button" class="ua-fd-btn ua-fd-rate" data-rate="${r}" title="Mission clock at ${r}× wall time">${r}×</button>`).join('')}
                    <button type="button" class="ua-fd-btn ua-fd-live" data-act="live" title="Lock the mission clock to the page's live sim clock">LIVE</button>
                    <span class="ua-fd-tplus" data-f="tplus">T+00:00:00</span>
                </div>
                <div class="ua-fd-scrubrow">
                    <input type="range" class="ua-fd-scrub" min="0" max="1000" value="0" step="1" aria-label="Scrub mission time">
                    <span class="ua-fd-span" data-f="span">—</span>
                </div>
                <div class="ua-fd-grid">
                    ${ROWS.map(([k, label]) => `<span class="ua-fd-k">${label}</span><span class="ua-fd-v" data-f="${k}">—</span>`).join('')}
                </div>
                <canvas class="ua-fd-spark" width="300" height="56" aria-label="altitude and drag pressure over the flight"></canvas>
                <div class="ua-fd-chips" data-role="color">
                    <span class="ua-fd-chiplabel">colour</span>
                    ${Object.entries(COLOR_MODES).map(([id, m]) => `<button type="button" class="ua-fd-chip" data-color="${id}" title="Colour the ribbon by ${m.label} (${m.log ? 'log' : 'linear'} ${m.min}–${m.max} ${m.unit})">${m.label}</button>`).join('')}
                </div>
                <div class="ua-fd-chips" data-role="layers">
                    <span class="ua-fd-chiplabel">show</span>
                    <button type="button" class="ua-fd-chip" data-opt="vectors" title="Velocity (green), gravity (cyan), drag (red), lift (violet). Arrow length is log₁₀|a| over 1e-8…10 m/s²; the true values are above.">vectors</button>
                    <button type="button" class="ua-fd-chip" data-opt="groundTrack" title="The sub-satellite track on the surface (Earth-fixed, so it precesses with the real orbit)">ground track</button>
                    <button type="button" class="ua-fd-chip" data-opt="wake" title="Heating wake — a symbol scaled by the Sutton–Graves proxy, not a plasma render">wake</button>
                    <button type="button" class="ua-fd-chip" data-opt="future" title="Draw the not-yet-flown path, dashed by time (one dash = 2 min of flight)">future</button>
                    <button type="button" class="ua-fd-chip" data-act="chase" title="Chase camera on the probe (Orbit / Fly / Reset releases it)">chase cam</button>
                    <button type="button" class="ua-fd-chip" data-act="focus" title="Quiet the field lines, conjunction chords and orbit loops while the flight is on; their own settings are restored when it ends">focus</button>
                </div>
                <div class="ua-fd-note" data-f="note"></div>
            </div>`;
        this._host.appendChild(el);
        this.el = el;

        const tag = document.createElement('div');
        tag.className = 'ua-fd-tag';
        tag.hidden = true;
        this._host.appendChild(tag);
        this._tag = tag;

        this._f = {};
        el.querySelectorAll('[data-f]').forEach(n => { this._f[n.dataset.f] = n; });
        this._spark = el.querySelector('.ua-fd-spark');
        this._scrub = el.querySelector('.ua-fd-scrub');

        el.querySelector('.ua-fd-toggle').addEventListener('click', () => {
            const open = el.dataset.open !== '1';
            el.dataset.open = open ? '1' : '0';
            el.querySelector('.ua-fd-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        el.querySelector('.ua-fd-close').addEventListener('click', () => {
            this._globe.clearFlight?.();
            el.hidden = true;
            tag.hidden = true;
        });
        el.addEventListener('click', (e) => {
            const b = e.target.closest('button');
            if (!b) return;
            const layer = this._globe.getFlightLayer?.();
            if (!layer?.hasFlight()) return;
            if (b.dataset.rate) { layer.setRate(Number(b.dataset.rate)); layer.play(); }
            else if (b.dataset.act === 'restart') { layer.seek(0); layer.play(); }
            else if (b.dataset.act === 'playpause') { layer.getClock().playing && layer.getClock().mode === 'own' ? layer.pause() : layer.play(); }
            else if (b.dataset.act === 'live') { layer.setClockMode('live'); }
            else if (b.dataset.color) { layer.setColorMode(b.dataset.color); }
            else if (b.dataset.opt) { const o = layer.getOptions(); layer.setOptions({ [b.dataset.opt]: !o[b.dataset.opt] }); }
            else if (b.dataset.act === 'focus') { this._globe.setFlightFocus?.(!this._globe.getFlightFocus?.()); }
            else if (b.dataset.act === 'chase') {
                const following = this._globe.getFollowTarget?.()?.kind === 'flight';
                if (following) this._globe.stopFollowing?.(); else this._globe.followFlight?.();
            }
            this._paint();
        });
        let scrubbing = false;
        this._scrub.addEventListener('input', () => {
            scrubbing = true;
            const layer = this._globe.getFlightLayer?.();
            if (!layer?.hasFlight()) return;
            const c = layer.getClock();
            layer.seek((Number(this._scrub.value) / 1000) * c.tEndS);
        });
        this._scrub.addEventListener('change', () => { scrubbing = false; });
        this._isScrubbing = () => scrubbing;
    }

    _paint() {
        const layer = this._globe.getFlightLayer?.();
        const f = layer?.getFlight?.();
        if (!layer || !f) { if (!this.el.hidden) { this.el.hidden = true; this._tag.hidden = true; } return; }
        if (this.el.hidden) this.el.hidden = false;
        const F = this._f;
        const c = layer.getClock();
        const s = layer.currentSample();

        this.el.querySelector('.ua-fd-name').textContent = f.name;
        F.status.textContent = c.done ? f.status : 'integrating';
        F.status.dataset.status = f.status;
        F.tplus.textContent = fmtMissionTime(c.tS);
        F.span.textContent = c.done ? `of ${fmtMissionTime(c.tEndS).slice(1)}` : `${fmtMissionTime(c.tEndS).slice(1)} so far…`;
        if (!this._isScrubbing()) {
            this._scrub.value = String(Math.max(0, Math.min(1000, Math.round(1000 * (c.tEndS > 0 ? c.tS / c.tEndS : 0)))));
        }
        const live = c.mode === 'live';
        this.el.querySelector('.ua-fd-live').classList.toggle('ua-fd-chip--on', live);
        this.el.querySelectorAll('.ua-fd-rate').forEach(b => b.classList.toggle('ua-fd-chip--on', !live && Number(b.dataset.rate) === c.rate));
        this.el.querySelector('[data-act=playpause]').textContent = (live || c.playing) ? '⏸' : '▶';
        this.el.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('ua-fd-chip--on', b.dataset.color === layer.getColorMode()));
        const opts = layer.getOptions();
        this.el.querySelectorAll('[data-opt]').forEach(b => b.classList.toggle('ua-fd-chip--on', !!opts[b.dataset.opt]));
        this.el.querySelector('[data-act=chase]').classList.toggle('ua-fd-chip--on', this._globe.getFollowTarget?.()?.kind === 'flight');
        this.el.querySelector('[data-act=focus]').classList.toggle('ua-fd-chip--on', !!this._globe.getFlightFocus?.());

        if (!s) {
            for (const [k] of ROWS) F[k].textContent = c.tS < 0 ? 'not launched yet' : '—';
            F.note.textContent = c.tS < 0
                ? 'The page clock is before the launch instant — scrub forward or press LIVE.'
                : 'Past the integrated span.';
            return;
        }
        const alt = s[COL.ALT];
        F.alt.textContent = KM(alt, alt < 200 ? 2 : 1);
        F.speed.textContent = FIX(s[COL.SPEED], 3, ' km/s');
        F.vrel.textContent = FIX(s[COL.VREL], 3, ' km/s');
        F.rho.textContent = `${EXP(s[COL.RHO])} kg/m³`;
        const fld = f.sampler?.fieldAt?.(Math.max(80, alt), s[COL.LAT], s[COL.LON], f.t0Ms + c.tS * 1000);
        F.rhoratio.textContent = fld && alt <= 2000 ? `${fld.rhoRatio.toFixed(2)}× · T∞ ${Math.round(fld.Tinf)} K` : (alt > 2000 ? 'above the model' : '—');
        F.q.textContent = s[COL.Q] >= 1e-3 ? `${(s[COL.Q] * 1e3).toFixed(2)} mPa` : `${EXP(s[COL.Q])} Pa`;
        F.adrag.textContent = fmtAccel(s[COL.ADRAG]);
        F.agrav.textContent = `${s[COL.AGRAV].toFixed(3)} m/s²`;
        F.gload.textContent = s[COL.GLOAD] >= 0.01 ? `${s[COL.GLOAD].toFixed(3)} g` : `${EXP(s[COL.GLOAD])} g`;
        F.energy.textContent = `${s[COL.ENERGY].toFixed(3)} km²/s² ${s[COL.ENERGY] < 0 ? '(bound)' : '(unbound)'}`;
        F.hmag.textContent = `${s[COL.HMAG].toFixed(1)} km²/s`;
        F.dedt.textContent = Math.abs(s[COL.DEDT]) >= 0.1 ? `${s[COL.DEDT].toFixed(2)} W/kg` : `${EXP(s[COL.DEDT])} W/kg`;
        F.dadt.textContent = Number.isFinite(s[COL.DADT]) ? `${s[COL.DADT].toFixed(3)} km/day` : 'unbound';
        F.heat.textContent = s[COL.HEAT] >= 0.01 ? `${s[COL.HEAT].toFixed(2)} W/cm²` : `${EXP(s[COL.HEAT])} W/cm²`;
        F.latlon.textContent = `${s[COL.LAT].toFixed(2)}° · ${s[COL.LON].toFixed(2)}°`;
        F.lst.textContent = Number.isFinite(s[COL.LST]) ? `${s[COL.LST].toFixed(1)} h` : '—';
        try {
            const st = this._getState();
            const ph = alt >= 80 && alt <= 2000
                ? pointPhysics({ altitudeKm: alt, f107Sfu: st.f107, ap: st.ap }) : null;
            F.regime.textContent = ph ? `${ph.regime} · Kn ${ph.knudsen >= 100 ? ph.knudsen.toExponential(1) : ph.knudsen.toFixed(2)}` : 'outside the band';
        } catch (_) { F.regime.textContent = '—'; }
        const el = orbitalElements([s[COL.RX], s[COL.RY], s[COL.RZ]], [s[COL.VX], s[COL.VY], s[COL.VZ]]);
        F.elems.textContent = el.bound
            ? `${el.aKm.toFixed(0)} km · ${el.e.toFixed(4)} · ${el.incDeg.toFixed(1)}°`
            : `hyperbolic · e ${el.e.toFixed(3)} · ${el.incDeg.toFixed(1)}°`;
        F.apsides.textContent = el.bound ? `${KM(el.perigeeAltKm)} · ${KM(el.apogeeAltKm)}` : `${KM(el.perigeeAltKm)} · —`;
        F.period.textContent = el.bound ? `${el.periodMin.toFixed(2)} min` : '—';

        // Summary (1 Hz — it walks every sample).
        const now = performance.now();
        if (!this._summary || now - this._summaryAt > 1000 || f.done !== this._summaryDone) {
            this._summary = f.summary();
            this._summaryAt = now;
            this._summaryDone = f.done;
        }
        const sm = this._summary;
        const parts = [describeStatus(f.status)];
        if (sm.floor) parts.push(`floor at T+${Math.round(sm.floor.tS)} s over ${sm.floor.latDeg.toFixed(1)}°, ${sm.floor.lonDeg.toFixed(1)}° at ${sm.floor.speedKms.toFixed(2)} km/s`);
        if (sm.perigeePasses > 1 && Number.isFinite(sm.decayPerOrbitKm)) parts.push(`Δa ${sm.decayPerOrbitKm.toFixed(3)} km per orbit`);
        parts.push(`peak q ${sm.maxQPa >= 1e-3 ? (sm.maxQPa * 1e3).toFixed(2) + ' mPa' : sm.maxQPa.toExponential(2) + ' Pa'} · peak load ${sm.maxG.toFixed(3)} g · peak heating ${sm.maxHeatWcm2.toFixed(2)} W/cm²`);
        parts.push('*Sutton–Graves for a 1 m nose, a proxy. Gravity + J2, drag against the co-rotating air through the live (F10.7, Ap) field'
            + (f.liftToDrag > 0 ? `, unbanked lift L/D ${f.liftToDrag}` : '') + '. ' + (sm.n).toLocaleString() + ' samples.');
        F.note.textContent = parts.join(' · ');

        this._paintSpark(f, c);
    }

    _paintSpark(f, c) {
        const cv = this._spark;
        if (!cv) return;
        const key = `${f.n}|${Math.round(c.tS)}|${f.status}`;
        if (key === this._lastSparkKey) return;
        this._lastSparkKey = key;
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth || 300, h = cv.clientHeight || 56;
        if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
        const g = cv.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, h);
        const n = f.n;
        if (n < 2) return;
        const d = f.data, S = STRIDE;
        const tEnd = Math.max(1, f.tEndS);
        let aMin = Infinity, aMax = -Infinity, qMax = -Infinity, qMin = Infinity;
        for (let i = 0; i < n; i++) {
            const a = d[i * S + COL.ALT], q = d[i * S + COL.Q];
            if (a < aMin) aMin = a; if (a > aMax) aMax = a;
            if (q > 0) { const lq = Math.log10(q); if (lq > qMax) qMax = lq; if (lq < qMin) qMin = lq; }
        }
        const pad = 3;
        const xOf = (t) => pad + (w - 2 * pad) * (t / tEnd);
        const yAlt = (a) => h - pad - (h - 2 * pad) * ((a - aMin) / Math.max(1e-9, aMax - aMin));
        const yQ = (lq) => h - pad - (h - 2 * pad) * ((lq - qMin) / Math.max(1e-9, qMax - qMin));
        // q (log) — dim red fill.
        g.strokeStyle = 'rgba(255,110,110,.65)'; g.lineWidth = 1;
        g.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
            const q = d[i * S + COL.Q]; if (!(q > 0)) continue;
            const x = xOf(d[i * S + COL.T]), y = yQ(Math.log10(q));
            if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
        }
        g.stroke();
        // altitude — cyan.
        g.strokeStyle = '#5fd8ff'; g.lineWidth = 1.5;
        g.beginPath();
        for (let i = 0; i < n; i++) {
            const x = xOf(d[i * S + COL.T]), y = yAlt(d[i * S + COL.ALT]);
            if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
        // now cursor
        const xn = xOf(Math.max(0, Math.min(tEnd, c.tS)));
        g.strokeStyle = 'rgba(255,255,255,.75)';
        g.beginPath(); g.moveTo(xn, 0); g.lineTo(xn, h); g.stroke();
        g.fillStyle = 'rgba(190,210,235,.7)';
        g.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        g.fillText(`${Math.round(aMax)} km`, pad + 2, 9);
        g.fillText(`${Math.round(aMin)} km`, pad + 2, h - 4);
        g.textAlign = 'right';
        g.fillStyle = 'rgba(255,140,140,.8)';
        g.fillText('q (log)', w - pad - 2, 9);
    }

    _tagLoop() {
        this._raf = requestAnimationFrame(this._tagLoop);
        const layer = this._globe.getFlightLayer?.();
        if (!layer?.hasFlight() || !layer.isLaunched()) { if (!this._tag.hidden) this._tag.hidden = true; return; }
        const p = layer.getHeadPosition();
        const scr = this._globe.projectToScreen?.(p.x, p.y, p.z);
        if (!scr || scr.behind) { this._tag.hidden = true; return; }
        const s = layer.currentSample();
        this._tag.hidden = false;
        this._tag.style.left = `${Math.round(scr.x + 12)}px`;
        this._tag.style.top = `${Math.round(scr.y - 14)}px`;
        const alt = s ? s[COL.ALT] : NaN;
        this._tag.textContent = `${layer.getFlight().name} · ${Number.isFinite(alt) ? Math.round(alt) + ' km' : ''}`;
    }

    dispose() {
        clearInterval(this._timer);
        cancelAnimationFrame(this._raf);
        window.removeEventListener('ua-flight-launched', this._onLaunched);
        this.el.remove(); this._tag.remove();
    }
}
