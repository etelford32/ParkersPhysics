/**
 * upper-atmosphere-cme-panel.js — the incoming-CME controls (DOM only)
 * ═══════════════════════════════════════════════════════════════════════════
 * Drives the globe's CME API (`setCmeLayerEnabled`, `getCmeLayer`,
 * `flyToCmeView`) and prints what the layer reports. Computes nothing.
 *
 * The status chip is the honesty surface: LIVE only when the shared
 * provider has an Earth-relevant train; otherwise REPLAY · MAY 2024 G5 with
 * the reason (quiet catalogue / feed down), or the failure. The disclosure
 * says what is compressed, by how much, and what is true scale.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (n) => `#${(n >>> 0).toString(16).padStart(6, '0')}`;
const fmtUtc = (ms) => Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z' : '—';
function fmtRel(ms, ref) {
    if (!Number.isFinite(ms) || !Number.isFinite(ref)) return '';
    const h = (ms - ref) / 3600e3;
    const a = Math.abs(h);
    return `T${h < 0 ? '−' : '+'}${a >= 48 ? (a / 24).toFixed(1) + ' d' : a.toFixed(1) + ' h'}`;
}
const fmtLoc = (lat, lon) => (!Number.isFinite(lat) || !Number.isFinite(lon)) ? '—'
    : `${lat < 0 ? 'S' : 'N'}${String(Math.round(Math.abs(lat))).padStart(2, '0')}${lon < 0 ? 'E' : 'W'}${String(Math.round(Math.abs(lon))).padStart(2, '0')}`;

export class CmePanel {
    constructor({ host, globe }) {
        this.globe = globe;
        this.host = host;
        if (!host) return;
        host.innerHTML = `
            <div class="ua-cme">
                <div class="ua-rig-row">
                    <button type="button" class="ua-xp-chip" data-act="toggle" aria-pressed="false"
                            title="Draw the flux-rope forecast's CMEs coming from the Sun (loads the shared provider and the WASM kernel on first use)">☄ show incoming CMEs</button>
                    <span class="ua-cme-chip" data-f="chip">off</span>
                </div>
                <div class="ua-cme-body" data-f="body" hidden>
                    <div class="ua-rig-row ua-rig-row--chips">
                        <button type="button" class="ua-xp-chip" data-act="live" title="The shared provider's live Earth-relevant train">live train</button>
                        <button type="button" class="ua-xp-chip" data-act="replay" title="The validated Gannon May 2024 G5 train, on the kernel with interaction on">Gannon replay</button>
                    </div>
                    <div class="ua-rig-row">
                        <button type="button" class="ua-xp-mini" data-act="play" title="Play the CME clock">⏵</button>
                        <input type="range" min="0" max="1000" step="1" data-f="tau" aria-label="CME clock"
                               title="The CME clock. Scrubbing moves ONLY the rope layer — the page's satellites, Sun and atmosphere stay at the page's own instant.">
                        <button type="button" class="ua-xp-mini" data-act="now" title="Follow the page clock again (live train only)">now</button>
                    </div>
                    <div class="ua-cme-tau" data-f="tauv">—</div>
                    <div class="ua-rig-row ua-rig-row--chips">
                        <span class="ua-rig-k">view</span>
                        <button type="button" class="ua-xp-chip" data-view="approach" title="Side-on to the whole corridor: the drawn Sun, Earth and the ropes between (compressed map)">approach</button>
                        <button type="button" class="ua-xp-chip" data-view="upstream" title="30 R⊕ up the Sun line, looking back at Earth: the incoming flux meeting the magnetosphere (true scale)">upstream</button>
                        <button type="button" class="ua-xp-chip" data-view="side" title="Abeam, on the dusk side: the field lines sweeping past the magnetopause (true scale)">side-on</button>
                    </div>
                    <div class="ua-cme-earth" data-f="earth">—</div>
                    <div class="ua-cme-ropes" data-f="ropes"></div>
                    <details class="ua-cme-note">
                        <summary>what is drawn, and at what scale</summary>
                        <p data-f="note"></p>
                    </details>
                </div>
            </div>`;
        this._el = host.querySelector('.ua-cme');
        this._f = {};
        this._el.querySelectorAll('[data-f]').forEach((n) => { this._f[n.dataset.f] = n; });
        this._el.addEventListener('click', (e) => this._onClick(e));
        this._f.tau.addEventListener('input', () => {
            const L = this.globe.getCmeLayer?.();
            const w = L?.getWindow?.();
            if (!L || !w) return;
            L.setPlaying(false);
            L.setTau(w.t0 + (w.t1 - w.t0) * Number(this._f.tau.value) / 1000);
            this.refresh();
        });
        this._timer = setInterval(() => this.refresh(), 250);
    }

    dispose() { clearInterval(this._timer); }

    async _onClick(e) {
        const g = this.globe;
        const a = e.target.closest('[data-act]');
        const v = e.target.closest('[data-view]');
        if (v) { g.flyToCmeView?.(v.dataset.view); return; }
        if (!a) return;
        const L = g.getCmeLayer?.();
        switch (a.dataset.act) {
            case 'toggle': {
                const on = !g.isCmeLayerEnabled?.();
                a.setAttribute('aria-pressed', String(on));
                this._f.body.hidden = !on;
                await g.setCmeLayerEnabled?.(on);
                break;
            }
            case 'live': if (L && !L.useLive()) this._flash('no Earth-relevant train from the provider right now'); break;
            case 'replay': L?.useReplay(null); break;
            case 'play': L?.setPlaying(!L.getState().playing); break;
            case 'now': if (L && !L.followPageClock()) this._flash('the page clock only drives a live train'); break;
            default: break;
        }
        this.refresh();
    }

    _flash(msg) {
        this._flashMsg = msg;
        this._flashUntil = Date.now() + 3500;
    }

    refresh() {
        if (!this._el) return;
        const g = this.globe;
        const on = !!g.isCmeLayerEnabled?.();
        const toggle = this._el.querySelector('[data-act="toggle"]');
        toggle?.setAttribute('aria-pressed', String(on));
        this._f.body.hidden = !on;
        const L = g.getCmeLayer?.();
        if (!on || !L) { this._f.chip.textContent = 'off'; this._f.chip.dataset.state = 'off'; return; }
        const s = L.getState();
        const st = s.status || {};
        const chip = this._f.chip;
        chip.dataset.state = st.state || 'loading';
        const n = s.ropes?.length ?? 0;
        chip.textContent = st.state === 'live' ? `LIVE · ${n > 1 ? `${n}-CME train` : 'CME'}`
            : st.state === 'replay' ? `REPLAY · MAY 2024 G5${st.reason && st.reason !== 'chosen' ? ` · ${st.reason}` : ''}`
            : st.state === 'failed' ? `unavailable · ${st.reason ?? ''}`
            : 'loading the flux-rope forecast…';
        chip.title = st.state === 'replay'
            ? 'The validated Gannon May 2024 train on the flux-rope kernel with CME–CME interaction on. Shown because ' + (st.reason ?? 'you chose it') + '.'
            : st.state === 'live' ? (s.label ?? 'The shared provider\'s live train') : chip.textContent;
        this._el.querySelector('[data-act="live"]')?.setAttribute('aria-pressed', String(st.source === 'live'));
        this._el.querySelector('[data-act="replay"]')?.setAttribute('aria-pressed', String(st.source === 'replay'));
        this._el.querySelector('[data-act="play"]').textContent = s.playing ? '⏸' : '⏵';

        // Clock.
        const w = s.window;
        if (w && Number.isFinite(s.tauMs) && document.activeElement !== this._f.tau) {
            this._f.tau.value = String(Math.round(1000 * (s.tauMs - w.t0) / Math.max(1, w.t1 - w.t0)));
        }
        const flash = this._flashUntil > Date.now() ? ` · <em>${esc(this._flashMsg)}</em>` : '';
        this._f.tauv.innerHTML = Number.isFinite(s.tauMs)
            ? `τ ${fmtUtc(s.tauMs)} <span class="ua-rig-dim">${fmtRel(s.tauMs, s.launchMs)} from first launch${s.follow ? ' · following the page clock' : ''}</span>${flash}`
            : `—${flash}`;

        // At Earth.
        const E = s.atEarth;
        const sum = s.summary;
        const arr = Number.isFinite(sum?.arrivalP50Ms)
            ? ` · ${sum.observed ? 'observed arrival' : 'modelled arrival P50'} ${fmtUtc(sum.arrivalP50Ms)}` : '';
        if (E?.inside && E.gse) {
            const [bx, by, bz] = E.gse;
            this._f.earth.innerHTML = `<b>Earth is inside the rope</b>${E.count > 1 ? ` (${E.count} overlap)` : ''} —
                B<sub>GSE</sub> = (${bx.toFixed(1)}, ${by.toFixed(1)}, <span style="color:${bz < 0 ? '#ff7a5a' : '#58b8ff'}">${bz.toFixed(1)}</span>) nT,
                |B| ${E.bmag.toFixed(1)} nT · Bz ${bz < 0 ? 'SOUTHWARD — reconnection on' : 'northward'}${arr}`;
        } else {
            this._f.earth.innerHTML = `Earth is outside every rope at τ${E?.lines ? ` · ${E.lines} field lines in the ±40 R⊕ box (${esc(E.reference)} edge)` : ''}${arr}`;
        }

        // Ropes.
        const rows = s.ropes || [];
        const ids = rows.map((r) => r.index).join(',');
        if (ids !== this._ropeIds) {
            this._ropeIds = ids;
            this._f.ropes.innerHTML = rows.map((r) => `
                <div class="ua-cme-rope" data-i="${r.index}">
                    <span class="ua-cme-sw" style="background:${hex(r.color)}"></span>
                    <span class="ua-cme-rn">rope ${r.index + 1}</span>
                    <span class="ua-cme-rv" data-r="v"></span>
                </div>`).join('');
        }
        for (const r of rows) {
            const el = this._f.ropes.querySelector(`[data-i="${r.index}"] [data-r="v"]`);
            if (!el) continue;
            el.textContent = !r.launched
                ? `launches ${fmtUtc(r.launchMs)} · ${fmtLoc(r.latDeg, r.lonDeg)} · tilt ${Math.round(r.tiltDeg)}°`
                : `${fmtLoc(r.latDeg, r.lonDeg)} · tilt ${Math.round(r.tiltDeg)}° · apex ${r.apexAu.toFixed(2)} AU`
                  + (Number.isFinite(r.speedKms) ? ` · ${Math.round(r.speedKms)} km/s` : '')
                  + (r.etaH === 0 ? ' · past 1 AU' : Number.isFinite(r.etaH) ? ` · 1 AU in ${r.etaH.toFixed(1)} h` : '')
                  + (r.oracle === 'mirror' ? ' · mirror' : '');
        }

        // Disclosure (numbers from the layer, never retyped).
        if (!this._noteSet || this._noteComp !== s.compressionAt1Au) {
            this._noteSet = true;
            this._noteComp = s.compressionAt1Au;
            this._f.note.innerHTML = `
                <b>Ropes (compressed).</b> The surfaces are the flux-rope kernel's own geometry
                (its apex and cross-section probes) on the Stage's radial map: the drawn Sun sits
                ${s.sunRe} R⊕ up the Sun line and 1 AU lands exactly on Earth, so near Earth distance
                is compressed about ×${Math.round(s.compressionAt1Au)}; the Sun is drawn ×${Math.round(s.sunExaggeration)} its
                size on that map. Directions are true; the dashed line's ticks are true AU.
                Skins are the kernel's B<sub>z</sub> just inside the boundary — red south, blue north.
                Ropes fade within ~10 R⊕ of Earth and of the camera so they never paint over the atmosphere.<br>
                <b>Field lines (true scale).</b> Within 40 R⊕ of Earth nothing is compressed: the lines
                trace the kernel's field at real positions. A rope is thousands of R⊕ across, so here
                they are nearly straight — what changes as it passes is their DIRECTION, which is what
                the magnetosphere sees. They stop where the rope stops, and at the magnetopause: the
                kernel's field is the undisturbed rope, so draping around the magnetosphere is not
                modelled — the lines are clipped, never bent by hand. The arrow upstream is B at Earth.<br>
                <b>Clocks.</b> A live train follows the page clock; scrubbing moves only this layer.
                The replay has its own clock; the Earth and Sun line are the page's instant.`;
        }
    }
}
