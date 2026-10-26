/**
 * verdict-day-view.js — the full-screen forecast for ONE day of the
 * EarthView verdict card's week strip. Tapping a weekday on the card opens
 * it; ‹ › / ←→ / a horizontal swipe / the day tabs move between the seven
 * days; ✕ / Esc / the backdrop close it and return focus to the card.
 *
 * Split of responsibilities (same as the card):
 *   - js/verdict-engine.js `dayForecast` — PURE model of the day (every
 *     number, the dayparts, the night block, the summary sentence)
 *   - this file                          — DOM, styles, charts, keyboard
 *
 * MOUNTS ON <body>, NEVER INSIDE THE CARD: the card carries
 * `backdrop-filter`, which makes it the containing block for every
 * `position:fixed` descendant — an overlay inside it would be trapped in
 * the card's 400 px box instead of covering the screen.
 *
 * Charts are SMALL MULTIPLES on one shared hour axis (temperature line,
 * precipitation-chance bars) with ONE crosshair across both — never a dual
 * axis. Each chart is a single series, so the title names it and there is
 * no legend box. The SVG is laid out at the measured container width (a
 * scaled viewBox shrinks the axis text to ~5 px on a phone) and re-laid
 * out on resize.
 *
 * The card refreshes this view on its own ≥5 s cadence via update(); a
 * refresh while a pointer is down here is deferred to pointerup, the card's
 * own rule, so a re-render never lands mid-tap.
 */

import { dayForecast, fmtClock, fmtClockShort } from './verdict-engine.js';

const STYLE_ID = 'ev-day-styles';
const HOUR_MS = 3_600_000;

const CSS = `
html.ev-day-open,html.ev-day-open body{overflow:hidden}
.ev-day{position:fixed;inset:0;z-index:2000;display:flex;flex-direction:column;
  background:radial-gradient(120% 80% at 50% 0%,rgba(10,40,70,.97),rgba(3,10,20,.985) 70%);
  color:#c2d4ee;font-family:var(--font-sans,'Space Grotesk',system-ui,sans-serif);
  backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.ev-day[hidden]{display:none}
.ev-day button{font-family:inherit;cursor:pointer;touch-action:manipulation;color:inherit}
.ev-day::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;
  background:linear-gradient(100deg,#4ddbff 0%,#1f8fff 34%,#bfe3ff 52%,#2eff9e 80%,#a8e63c 100%);opacity:.85}

.ev-day-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid rgba(77,219,255,.13)}
.ev-day-nav,.ev-day-close{flex:0 0 auto;min-width:44px;min-height:44px;border-radius:11px;
  border:1px solid rgba(77,219,255,.28);background:rgba(1,4,9,.5);font-size:1.1rem;line-height:1}
.ev-day-nav:hover:not(:disabled),.ev-day-close:hover{border-color:rgba(77,219,255,.65);color:#f0f6ff}
.ev-day-nav:disabled{opacity:.3;cursor:default}
.ev-day-tabs{flex:1;min-width:0;display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
.ev-day-tab{min-height:44px;padding:5px 2px;border-radius:10px;border:1px solid rgba(77,219,255,.11);
  background:rgba(1,4,9,.45);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px}
.ev-day-tab:hover{border-color:rgba(77,219,255,.45)}
.ev-day-tab[aria-selected="true"]{border-color:rgba(77,219,255,.75);background:rgba(31,143,255,.16);
  box-shadow:0 0 16px rgba(31,143,255,.25)}
.ev-day-tab .n{font-family:var(--font-display,'Orbitron',sans-serif);font-size:.52rem;letter-spacing:.08em;
  text-transform:uppercase;color:#8ba3c7}
.ev-day-tab[aria-selected="true"] .n{color:#f0f6ff}
.ev-day-tab .g{font-size:.95rem;line-height:1.1}
.ev-day-tab .t{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.56rem;color:#8ba3c7}

.ev-day-scroll{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch}
.ev-day-body{max-width:1100px;margin:0 auto;padding:22px 20px 36px;display:flex;flex-direction:column;gap:22px}
.ev-day-mini{font-family:var(--font-display,'Orbitron',sans-serif);font-size:.6rem;letter-spacing:.18em;
  text-transform:uppercase;color:#4ddbff;margin-bottom:10px}

.ev-day-hero{display:grid;grid-template-columns:auto 1fr auto;gap:22px;align-items:center}
.ev-day-glyph{font-size:4.2rem;line-height:1;filter:drop-shadow(0 0 18px rgba(77,219,255,.35))}
.ev-day-label{font-family:var(--font-display,'Orbitron',sans-serif);font-size:1.5rem;font-weight:800;
  letter-spacing:.06em;text-transform:uppercase;color:#f0f6ff}
.ev-day-date{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.74rem;color:#5f7597;margin-top:4px}
.ev-day-cond{font-size:1.05rem;color:#f0f6ff;margin-top:8px}
.ev-day-sum{font-size:.88rem;line-height:1.5;color:#c2d4ee;margin-top:6px;max-width:60ch}
.ev-day-temps{text-align:right;font-family:var(--font-mono,'JetBrains Mono',monospace)}
.ev-day-hi{font-size:3rem;font-weight:700;color:#f0f6ff;line-height:1}
.ev-day-lo{font-size:1.5rem;color:#8ba3c7}
.ev-day-feels{font-size:.68rem;color:#5f7597;margin-top:6px}

.ev-day-stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
.ev-day-stat{background:rgba(1,4,9,.45);border:1px solid rgba(77,219,255,.11);border-radius:13px;padding:12px 14px}
.ev-day-stat .k{font-size:.66rem;letter-spacing:.06em;text-transform:uppercase;color:#5f7597}
.ev-day-stat .v{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:1.15rem;color:#f0f6ff;margin-top:4px}
.ev-day-stat .s{font-size:.7rem;color:#8ba3c7;margin-top:3px;line-height:1.4}

.ev-day-charts{background:rgba(1,4,9,.4);border:1px solid rgba(77,219,255,.11);border-radius:14px;padding:14px 14px 8px;position:relative}
.ev-day-chart{position:relative}
.ev-day-chart+.ev-day-chart{margin-top:6px}
.ev-day-ctitle{font-size:.7rem;color:#8ba3c7;margin:0 0 2px 2px}
.ev-day-chart svg{display:block;width:100%;overflow:visible}
.ev-day-ax{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:10px;fill:#5f7597}
.ev-day-lab{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:11px;font-weight:600;fill:#c2d4ee}
.ev-day-tip{position:absolute;pointer-events:none;z-index:2;padding:7px 10px;border-radius:9px;
  background:rgba(3,12,24,.96);border:1px solid rgba(77,219,255,.35);font-size:.72rem;line-height:1.45;
  color:#c2d4ee;white-space:nowrap;box-shadow:0 6px 20px rgba(0,0,0,.4);display:none}
.ev-day-tip b{color:#f0f6ff;font-family:var(--font-mono,'JetBrains Mono',monospace)}
.ev-day-empty{padding:18px;text-align:center;font-size:.8rem;color:#5f7597}

.ev-day-hours{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;scrollbar-width:thin}
.ev-day-hour{flex:0 0 58px;text-align:center;background:rgba(1,4,9,.45);border:1px solid rgba(77,219,255,.09);
  border-radius:10px;padding:8px 2px}
.ev-day-hour.now{border-color:rgba(46,255,158,.5)}
.ev-day-hour .h{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.6rem;color:#5f7597}
.ev-day-hour .g{font-size:1rem;margin:4px 0}
.ev-day-hour .t{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.74rem;color:#f0f6ff}
.ev-day-hour .p{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.58rem;color:#8ba3c7;margin-top:2px}

.ev-day-parts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.ev-day-part{background:rgba(1,4,9,.45);border:1px solid rgba(77,219,255,.11);border-radius:13px;padding:12px;text-align:center}
.ev-day-part .n{font-size:.68rem;letter-spacing:.06em;text-transform:uppercase;color:#5f7597}
.ev-day-part .g{font-size:1.6rem;margin:6px 0 2px}
.ev-day-part .c{font-size:.74rem;color:#c2d4ee;min-height:1.1em}
.ev-day-part .t{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:1rem;color:#f0f6ff;margin-top:4px}
.ev-day-part .p{font-size:.68rem;color:#8ba3c7;margin-top:2px}

.ev-day-night{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.ev-day-nrow{display:flex;gap:12px;align-items:center;background:rgba(1,4,9,.45);
  border:1px solid rgba(77,219,255,.11);border-radius:13px;padding:12px 14px}
.ev-day-nrow .i{font-size:1.4rem;flex:0 0 auto}
.ev-day-nrow .b{min-width:0}
.ev-day-nrow .tt{font-size:.84rem;font-weight:600;color:#f0f6ff}
.ev-day-nrow .d{font-size:.72rem;color:#8ba3c7;margin-top:2px;line-height:1.4}
.ev-day-state{display:inline-flex;align-items:center;gap:5px;font-size:.62rem;letter-spacing:.06em;
  text-transform:uppercase;padding:2px 7px;border-radius:999px;border:1px solid rgba(139,163,199,.35);color:#8ba3c7;margin-left:6px}
.ev-day-state.go{border-color:rgba(46,255,158,.5);color:#2eff9e}
.ev-day-state.maybe{border-color:rgba(255,210,63,.5);color:#ffd23f}

.ev-day-prov{font-family:var(--font-mono,'JetBrains Mono',monospace);font-size:.6rem;color:#3d4f6b;line-height:1.6}

@media(max-width:820px){
  .ev-day-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ev-day-stats .ev-day-stat:last-child{grid-column:1/-1}
  .ev-day-parts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .ev-day-night{grid-template-columns:1fr}
}
@media(max-width:640px){
  .ev-day-bar{padding:10px 10px;gap:6px}
  .ev-day-nav{display:none}
  .ev-day-tab .t{display:none}
  .ev-day-body{padding:16px 14px 28px;gap:18px}
  .ev-day-hero{grid-template-columns:auto 1fr;gap:14px}
  .ev-day-glyph{font-size:3rem}
  .ev-day-label{font-size:1.15rem}
  .ev-day-temps{grid-column:1/-1;text-align:left;display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
  .ev-day-hi{font-size:2.4rem}
}
@media(prefers-reduced-motion:reduce){.ev-day *{transition:none!important;animation:none!important}}`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dash = (v, unit = '') => (v == null || !Number.isFinite(v) ? '--' : `${v}${unit}`);

function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.appendChild(el);
}

export class DayView {
    /**
     * @param {object} [opts]
     * @param {(action:string, meta?:object) => void} [opts.record] telemetry
     * @param {() => string|null} [opts.getLocName] location name for the footer
     * @param {(index:number) => Element|null} [opts.focusTarget] where focus
     *        returns on close. The card re-renders its body every ≥5 s, so
     *        the button that opened the view is usually DETACHED by then —
     *        the card hands back the CURRENT button for that day instead.
     */
    constructor(opts = {}) {
        this._record = opts.record || (() => {});
        this._getLocName = opts.getLocName || (() => null);
        this._focusTarget = opts.focusTarget || null;
        this._index = -1;
        this._inputs = null;
        this._returnFocus = null;
        this._pointerActive = false;
        this._pendingUpdate = false;
        this._hours = [];
        ensureStyles();
        this._mount();
    }

    get isOpen() { return this._index >= 0; }
    get index() { return this._index; }

    _mount() {
        const root = document.createElement('div');
        root.className = 'ev-day';
        root.id = 'ev-day-view';
        root.hidden = true;
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-labelledby', 'ev-day-title');
        root.innerHTML = `
            <div class="ev-day-bar">
                <button class="ev-day-nav" data-evd="prev" aria-label="Previous day">‹</button>
                <div class="ev-day-tabs" role="tablist" aria-label="Days this week" data-evd="tabs"></div>
                <button class="ev-day-nav" data-evd="next" aria-label="Next day">›</button>
                <button class="ev-day-close" data-evd="close" aria-label="Close forecast">✕</button>
            </div>
            <div class="ev-day-scroll" data-evd="scroll"><div class="ev-day-body" data-evd="body"></div></div>`;
        document.body.appendChild(root);
        this._root = root;
        this._tabs = root.querySelector('[data-evd="tabs"]');
        this._body = root.querySelector('[data-evd="body"]');
        this._scroll = root.querySelector('[data-evd="scroll"]');

        root.addEventListener('click', (e) => {
            const tab = e.target.closest('[data-evd-tab]');
            if (tab) { this._go(+tab.getAttribute('data-evd-tab'), 'tab'); return; }
            const act = e.target.closest('[data-evd]')?.getAttribute('data-evd');
            if (act === 'close') this.close('button');
            else if (act === 'prev') this._go(this._index - 1, 'arrow');
            else if (act === 'next') this._go(this._index + 1, 'arrow');
        });
        root.addEventListener('keydown', (e) => this._onKey(e));

        // Never re-render under a finger (the card's pointer rule).
        root.addEventListener('pointerdown', () => { this._pointerActive = true; });
        const release = () => {
            this._pointerActive = false;
            if (this._pendingUpdate) { this._pendingUpdate = false; this._render(); }
        };
        root.addEventListener('pointerup', release);
        root.addEventListener('pointercancel', release);

        // Horizontal swipe → previous / next day (phones hide the arrows).
        let sx = null, sy = null;
        root.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1 || e.target.closest('.ev-day-hours, .ev-day-charts')) { sx = null; return; }
            sx = e.touches[0].clientX; sy = e.touches[0].clientY;
        }, { passive: true });
        root.addEventListener('touchend', (e) => {
            if (sx == null) return;
            const dx = e.changedTouches[0].clientX - sx;
            const dy = e.changedTouches[0].clientY - sy;
            sx = null;
            if (Math.abs(dx) > 60 && Math.abs(dy) < 45) this._go(this._index + (dx < 0 ? 1 : -1), 'swipe');
        }, { passive: true });

        this._onResize = () => {
            clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => { if (this.isOpen) this._renderCharts(); }, 120);
        };
    }

    /** Open on day `index` (0 = today) with the card's current inputs. */
    open(index, inputs, source = 'week') {
        this._inputs = inputs;
        if (!dayForecast(inputs, index)) return false;
        const wasOpen = this.isOpen;
        this._index = index;
        if (!wasOpen) {
            this._returnFocus = document.activeElement;
            this._openedIndex = index;
            this._root.hidden = false;
            document.documentElement.classList.add('ev-day-open');
            window.addEventListener('resize', this._onResize);
        }
        this._render();
        this._scroll.scrollTop = 0;
        if (!wasOpen) this._root.querySelector('[data-evd="close"]').focus({ preventScroll: true });
        this._record('day_open', { offset: index, source });
        return true;
    }

    close(source = 'button') {
        if (!this.isOpen) return;
        this._record('day_close', { offset: this._index, source });
        this._index = -1;
        this._root.hidden = true;
        document.documentElement.classList.remove('ev-day-open');
        window.removeEventListener('resize', this._onResize);
        let back = this._returnFocus;
        this._returnFocus = null;
        if (!back?.isConnected && this._focusTarget) back = this._focusTarget(this._openedIndex);
        if (back && back.isConnected) back.focus({ preventScroll: true });
    }

    /** Fresh card inputs (the card's ≥5 s refresh). No-op while closed. */
    update(inputs) {
        this._inputs = inputs;
        if (!this.isOpen) return;
        if (!dayForecast(inputs, this._index)) { this.close('data'); return; }
        if (this._pointerActive) { this._pendingUpdate = true; return; }
        this._render();
    }

    destroy() {
        this.close('destroy');
        this._root?.remove();
        this._root = null;
    }

    _go(index, source) {
        if (!this.isOpen || index === this._index) return;
        if (!dayForecast(this._inputs, index)) return;
        this._index = index;
        this._render();
        this._scroll.scrollTop = 0;
        this._root.querySelector(`[data-evd-tab="${index}"]`)?.focus({ preventScroll: true });
        this._record('day_nav', { offset: index, source });
    }

    _onKey(e) {
        if (e.key === 'Escape') {
            // The view owns this Escape: stop it reaching document-level
            // handlers. js/nav.js used to focus its burger on EVERY Escape and
            // stole the focus close() just returned to the card (fixed there
            // too — this keeps the view independent of what else listens).
            e.preventDefault();
            e.stopPropagation();
            this.close('escape');
            return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            // Leave arrow keys alone inside the scrollable hourly strip.
            if (e.target.closest?.('.ev-day-hours')) return;
            e.preventDefault();
            this._go(this._index + (e.key === 'ArrowRight' ? 1 : -1), 'key');
            return;
        }
        if (e.key === 'Tab') {
            // Focus trap — aria-modal promises the page behind is inert.
            const f = [...this._root.querySelectorAll('button:not([disabled]), [tabindex="0"]')]
                .filter(el => el.offsetParent !== null);
            if (!f.length) return;
            const first = f[0], last = f[f.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    _render() {
        const now = Date.now();
        const inputs = this._inputs || {};
        const tz = inputs.loc?.tz;
        const days = [];
        for (let i = 0; i < 7; i++) days.push(dayForecast(inputs, i, now));
        const m = days[this._index];
        if (!m) return;

        this._tabs.innerHTML = days.map((d, i) => d ? `
            <button class="ev-day-tab" role="tab" data-evd-tab="${i}" aria-selected="${i === this._index}"
                    tabindex="${i === this._index ? 0 : -1}"
                    aria-label="${esc(d.dateLabel)}${d.hi != null ? `, high ${d.hi}°, low ${d.lo}°` : ''}">
                <span class="n">${esc(i === 0 ? 'Today' : d.dateLabel.slice(0, 3))}</span>
                <span class="g" aria-hidden="true">${d.glyph}</span>
                <span class="t">${dash(d.hi, '°')}/${dash(d.lo, '°')}</span>
            </button>` : '<span></span>').join('');
        this._root.querySelector('[data-evd="prev"]').disabled = !days[this._index - 1];
        this._root.querySelector('[data-evd="next"]').disabled = !days[this._index + 1];

        const p = m.precip, w = m.wind;
        const precipSub = [
            p.totalIn != null ? `${p.totalIn.toFixed(2)} in total` : null,
            p.hours ? `${p.hours} h of precip` : null,
            p.snowIn ? `${p.snowIn} in snow` : null,
            p.wettest ? `peaks ${fmtClockShort(p.wettest.t, tz)}` : null,
        ].filter(Boolean).join(' · ') || 'no precipitation expected';
        const dl = m.sun.dayLengthH;
        const dayLen = dl != null ? `${Math.floor(dl)}h ${String(Math.round((dl % 1) * 60)).padStart(2, '0')}m of daylight` : '';

        const stat = (k, v, s) => `<div class="ev-day-stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;

        const nowIdx = m.isToday ? m.hours.findIndex(h => now >= h.t && now < h.t + HOUR_MS) : -1;
        const night = m.night;
        const issTxt = night.issPasses.length
            ? night.issPasses.map(x => `${fmtClock(x.rise, tz)}${Number.isFinite(x.peakAlt) ? ` · peak ${Math.round(x.peakAlt)}°` : ''}`).join('; ')
            : 'No visible pass ≥ 20° predicted.';
        const auroraCls = night.aurora.state === 'go' ? 'go' : night.aurora.state === 'maybe' ? 'maybe' : '';
        const auroraWord = { go: 'go', maybe: 'maybe', no: 'no', unknown: 'n/a' }[night.aurora.state] || 'n/a';

        this._body.innerHTML = `
            <section class="ev-day-hero">
                <div class="ev-day-glyph" aria-hidden="true">${m.glyph}</div>
                <div>
                    <div class="ev-day-label" id="ev-day-title">${esc(m.label)}</div>
                    <div class="ev-day-date">${esc(m.dateLabel)}${inputs.loc?.name ? ' · ' + esc(inputs.loc.name) : ''}</div>
                    <div class="ev-day-cond">${esc(m.condition || 'Forecast')}</div>
                    <p class="ev-day-sum">${esc(m.summary)}</p>
                </div>
                <div class="ev-day-temps">
                    <div class="ev-day-hi" aria-label="High">${dash(m.hi, '°')}</div>
                    <div class="ev-day-lo" aria-label="Low">${dash(m.lo, '°')}</div>
                    ${m.feelsHi != null ? `<div class="ev-day-feels">feels ${m.feelsHi}° / ${dash(m.feelsLo, '°')}</div>` : ''}
                </div>
            </section>

            <section class="ev-day-stats" aria-label="Day details">
                ${stat('Precipitation', dash(p.probMax, '%'), precipSub)}
                ${stat('Wind', w.maxMph != null ? `${w.dir ? w.dir + ' ' : ''}${w.maxMph} mph` : '--', w.gustMph != null ? `gusts to ${w.gustMph} mph` : 'max sustained')}
                ${stat('UV index', m.uv.max != null ? String(m.uv.max) : '--', m.uv.word ? `${m.uv.word}${m.uv.peakT ? ' · peak ' + fmtClockShort(m.uv.peakT, tz) : ''}` : '')}
                ${stat('Humidity', m.humidity.min != null ? `${m.humidity.min}–${m.humidity.max}%` : '--', 'relative, hourly range')}
                ${stat('Sun', m.sun.rise != null ? `↑${fmtClockShort(m.sun.rise, tz)} ↓${fmtClockShort(m.sun.set, tz)}` : '--', dayLen)}
            </section>

            <section aria-label="Hourly forecast">
                <div class="ev-day-mini">Hour by hour${m.partial && m.hours.length ? ' · partial day' : ''}</div>
                <div class="ev-day-charts" data-evd="charts"></div>
                ${m.hours.length ? `
                <div class="ev-day-hours" tabindex="0" aria-label="Hourly table" style="margin-top:10px">
                    ${m.hours.map((h, i) => `
                    <div class="ev-day-hour${i === nowIdx ? ' now' : ''}">
                        <div class="h">${i === nowIdx ? 'Now' : esc(fmtClockShort(h.t, tz).replace(':00', ''))}</div>
                        <div class="g" aria-hidden="true">${h.glyph}</div>
                        <div class="t">${h.tempF != null ? Math.round(h.tempF) + '°' : '--'}</div>
                        <div class="p">💧${h.precipProb != null ? Math.round(h.precipProb) + '%' : '--'}</div>
                    </div>`).join('')}
                </div>` : ''}
            </section>

            <section aria-label="Parts of the day">
                <div class="ev-day-mini">Through the day</div>
                <div class="ev-day-parts">
                    ${m.dayparts.map(d => `
                    <div class="ev-day-part">
                        <div class="n">${esc(d.label)}</div>
                        <div class="g" aria-hidden="true">${d.glyph}</div>
                        <div class="c">${esc(d.condition || '')}</div>
                        <div class="t">${dash(d.tempF, '°')}</div>
                        <div class="p">${d.precipProb != null ? `${d.precipProb}% precip` : '--'}${d.cloudPct != null ? ` · ${d.cloudPct}% cloud` : ''}</div>
                    </div>`).join('')}
                </div>
            </section>

            <section aria-label="Night sky">
                <div class="ev-day-mini">${m.index === 0 ? "Tonight's sky" : 'That night'}</div>
                <div class="ev-day-night">
                    <div class="ev-day-nrow"><div class="i" aria-hidden="true">${night.moon.glyph}</div><div class="b">
                        <div class="tt">${esc(night.moon.name)} · ${night.moon.illumPct}% lit</div>
                        <div class="d">Dark-sky cloud cover ${night.cloudPct != null ? `${night.cloudPct}% — ${night.clear ? 'mostly clear' : 'mostly cloudy'}` : 'unknown'}.</div></div></div>
                    <div class="ev-day-nrow"><div class="i" aria-hidden="true">🌌</div><div class="b">
                        <div class="tt">${esc(night.aurora.title)}<span class="ev-day-state ${auroraCls}">${auroraWord}</span></div>
                        <div class="d">${esc(night.aurora.desc)}${night.kp != null ? ` (Kp ${night.kp.toFixed(1)})` : ''}</div></div></div>
                    <div class="ev-day-nrow"><div class="i" aria-hidden="true">🛰️</div><div class="b">
                        <div class="tt">ISS ${night.issPasses.length ? `· ${night.issPasses.length} pass${night.issPasses.length > 1 ? 'es' : ''}` : ''}</div>
                        <div class="d">${esc(issTxt)}</div></div></div>
                </div>
            </section>

            <p class="ev-day-prov">Open-Meteo point forecast${this._getLocName() ? ' for ' + esc(this._getLocName()) : ''} · times ${tz ? 'in ' + esc(tz) : 'local'} · aurora from NOAA SWPC Kp forecast (≈3 days) · ISS from CelesTrak elements · ← → or swipe to change day, Esc to close</p>`;

        this._hours = m.hours;
        this._nowT = m.isToday ? now : null;
        this._tz = tz;
        this._renderCharts();
    }

    /**
     * Two small multiples on ONE hour axis: temperature (line) and chance of
     * precipitation (bars). One crosshair + tooltip spans both. Laid out at
     * the measured width so axis text stays legible on a phone.
     */
    _renderCharts() {
        const host = this._body.querySelector('[data-evd="charts"]');
        if (!host) return;
        const hours = this._hours.filter(h => h.tempF != null);
        if (hours.length < 2) {
            host.innerHTML = '<div class="ev-day-empty">No hourly data for this day yet.</div>';
            return;
        }
        const tz = this._tz;
        const W = Math.max(280, host.clientWidth - 28);
        const PADL = 34, PADR = 10;
        const t0 = this._hours[0].t, t1 = this._hours[this._hours.length - 1].t;
        const span = Math.max(HOUR_MS, t1 - t0);
        const x = (t) => PADL + (t - t0) / span * (W - PADL - PADR);

        // ── Temperature ──
        const TH = 150, TT = 16, TB = 128;
        const temps = hours.map(h => h.tempF);
        let lo = Math.min(...temps), hi = Math.max(...temps);
        if (hi - lo < 6) { const mid = (hi + lo) / 2; lo = mid - 3; hi = mid + 3; }
        const pad = (hi - lo) * 0.12;
        lo -= pad; hi += pad;
        const yT = (v) => TB - (v - lo) / (hi - lo) * (TB - TT);
        const gridT = niceTicks(lo, hi, 4).map(v => `
            <line x1="${PADL}" x2="${W - PADR}" y1="${yT(v).toFixed(1)}" y2="${yT(v).toFixed(1)}" stroke="rgba(139,163,199,.12)"/>
            <text class="ev-day-ax" x="${PADL - 6}" y="${(yT(v) + 3.5).toFixed(1)}" text-anchor="end">${Math.round(v)}°</text>`).join('');
        const path = hours.map((h, i) => `${i ? 'L' : 'M'}${x(h.t).toFixed(1)},${yT(h.tempF).toFixed(1)}`).join(' ');
        let iMax = 0, iMin = 0;
        hours.forEach((h, i) => { if (h.tempF > hours[iMax].tempF) iMax = i; if (h.tempF < hours[iMin].tempF) iMin = i; });
        const lab = (i, above) => {
            const h = hours[i];
            const lx = clampN(x(h.t), PADL + 14, W - PADR - 14);
            return `<circle cx="${x(h.t).toFixed(1)}" cy="${yT(h.tempF).toFixed(1)}" r="4" fill="#4ddbff" stroke="#06121f" stroke-width="2"/>
                <text class="ev-day-lab" x="${lx.toFixed(1)}" y="${(yT(h.tempF) + (above ? -9 : 17)).toFixed(1)}" text-anchor="middle">${Math.round(h.tempF)}°</text>`;
        };

        // ── Precipitation chance ──
        const PH = 96, PT = 8, PB = 74;
        const yP = (v) => PB - v / 100 * (PB - PT);
        const slot = (W - PADL - PADR) / Math.max(1, this._hours.length);
        const bw = Math.max(2, Math.min(18, slot - 2));
        const bars = this._hours.filter(h => h.precipProb != null && h.precipProb > 0).map(h => {
            const top = yP(h.precipProb), bx = x(h.t) - bw / 2;
            const r = Math.min(4, bw / 2, PB - top);
            return `<path d="M${bx.toFixed(1)},${PB} V${(top + r).toFixed(1)} Q${bx.toFixed(1)},${top.toFixed(1)} ${(bx + r).toFixed(1)},${top.toFixed(1)} H${(bx + bw - r).toFixed(1)} Q${(bx + bw).toFixed(1)},${top.toFixed(1)} ${(bx + bw).toFixed(1)},${(top + r).toFixed(1)} V${PB} Z" fill="#1f8fff" fill-opacity=".85"/>`;
        }).join('');
        const anyPrecip = this._hours.some(h => h.precipProb != null);
        const gridP = [0, 50, 100].map(v => `
            <line x1="${PADL}" x2="${W - PADR}" y1="${yP(v)}" y2="${yP(v)}" stroke="rgba(139,163,199,${v === 0 ? '.3' : '.12'})"/>
            <text class="ev-day-ax" x="${PADL - 6}" y="${yP(v) + 3.5}" text-anchor="end">${v}%</text>`).join('');

        // Shared hour axis (under the bottom chart).
        const ticks = this._hours.filter((h, i) => i % 3 === 0).map(h => `
            <text class="ev-day-ax" x="${x(h.t).toFixed(1)}" y="${PH - 6}" text-anchor="middle">${esc(fmtClockShort(h.t, tz).replace(':00', ''))}</text>`).join('');
        const nowLine = (H, top, bot) => this._nowT != null && this._nowT >= t0 && this._nowT <= t1
            ? `<line x1="${x(this._nowT).toFixed(1)}" x2="${x(this._nowT).toFixed(1)}" y1="${top}" y2="${bot}" stroke="#2eff9e" stroke-width="1.5" stroke-dasharray="3 3"/>` : '';
        const nowTag = this._nowT != null && this._nowT >= t0 && this._nowT <= t1
            ? `<text class="ev-day-ax" x="${x(this._nowT).toFixed(1)}" y="${TT - 5}" text-anchor="middle" style="fill:#2eff9e">now</text>` : '';
        const cross = (top, bot) => `<line data-evd-cross x1="0" x2="0" y1="${top}" y2="${bot}" stroke="#c2d4ee" stroke-opacity=".55" stroke-width="1" style="display:none"/>`;

        host.innerHTML = `
            <div class="ev-day-chart">
                <div class="ev-day-ctitle">Temperature (°F)</div>
                <svg viewBox="0 0 ${W} ${TH}" height="${TH}" role="img"
                     aria-label="Temperature from ${Math.round(hours[iMin].tempF)}° to ${Math.round(hours[iMax].tempF)}°">
                    ${gridT}${nowLine(TH, TT, TB)}${nowTag}
                    <path d="${path}" fill="none" stroke="#4ddbff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
                    ${lab(iMax, true)}${iMin !== iMax ? lab(iMin, false) : ''}
                    ${cross(TT, TB)}
                    <circle data-evd-dot r="4" fill="#4ddbff" stroke="#06121f" stroke-width="2" style="display:none"/>
                </svg>
            </div>
            <div class="ev-day-chart">
                <div class="ev-day-ctitle">Chance of precipitation</div>
                ${anyPrecip ? `
                <svg viewBox="0 0 ${W} ${PH}" height="${PH}" role="img" aria-label="Hourly chance of precipitation">
                    ${gridP}${bars}${nowLine(PH, PT, PB)}${ticks}${cross(PT, PB)}
                </svg>` : '<div class="ev-day-empty">No precipitation-chance series for this day.</div>'}
            </div>
            <div class="ev-day-tip" data-evd="tip"></div>`;

        // Hover / touch crosshair across both charts.
        const tip = host.querySelector('[data-evd="tip"]');
        const crosses = host.querySelectorAll('[data-evd-cross]');
        const dot = host.querySelector('[data-evd-dot]');
        const svg0 = host.querySelector('svg');
        const show = (clientX) => {
            const r = svg0.getBoundingClientRect();
            const sx = (clientX - r.left) * (W / r.width);
            let best = null;
            for (const h of this._hours) if (!best || Math.abs(x(h.t) - sx) < Math.abs(x(best.t) - sx)) best = h;
            if (!best) return;
            const cx = x(best.t);
            crosses.forEach(c => { c.setAttribute('x1', cx); c.setAttribute('x2', cx); c.style.display = ''; });
            if (best.tempF != null) {
                dot.setAttribute('cx', cx); dot.setAttribute('cy', yT(best.tempF)); dot.style.display = '';
            } else dot.style.display = 'none';
            tip.innerHTML = `<b>${esc(fmtClock(best.t, tz))}</b><br>`
                + `${best.glyph} ${best.tempF != null ? Math.round(best.tempF) + '°F' : '--'}`
                + `${best.feelsF != null ? ` · feels ${Math.round(best.feelsF)}°` : ''}<br>`
                + `💧 ${best.precipProb != null ? Math.round(best.precipProb) + '%' : '--'}`
                + `${best.precipIn ? ` · ${best.precipIn.toFixed(2)} in` : ''}`
                + `${best.cloudPct != null ? ` · ☁ ${Math.round(best.cloudPct)}%` : ''}`
                + `${best.windMph != null ? ` · 💨 ${Math.round(best.windMph)} mph` : ''}`;
            tip.style.display = 'block';
            const hostR = host.getBoundingClientRect();
            const px = r.left - hostR.left + cx * (r.width / W);
            const tw = tip.offsetWidth;
            tip.style.left = `${clampN(px - tw / 2, 4, hostR.width - tw - 4)}px`;
            tip.style.top = '30px';
        };
        const hide = () => {
            tip.style.display = 'none';
            dot.style.display = 'none';
            crosses.forEach(c => { c.style.display = 'none'; });
        };
        // A resize re-lays out the SAME host — drop the previous listeners
        // (their closures hold the old width) before wiring the new ones.
        this._chartAbort?.abort();
        this._chartAbort = new AbortController();
        const opt = { signal: this._chartAbort.signal };
        host.addEventListener('pointermove', (e) => show(e.clientX), opt);
        host.addEventListener('pointerdown', (e) => show(e.clientX), opt);
        host.addEventListener('pointerleave', hide, opt);
    }
}

function clampN(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/** ~n round-number ticks inside [lo, hi]. */
function niceTicks(lo, hi, n) {
    const raw = (hi - lo) / n;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 5, 10].map(k => k * mag).find(s => s >= raw) || raw;
    const out = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
    return out;
}

export default DayView;
