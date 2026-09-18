/**
 * neo-panel.js — the "Near-Earth Objects" panel section + HUD lines for
 * solar-system.html. DOM only; every number it prints comes from
 * js/neo-layer.js (which gets it from the kernel or from JPL's own tables).
 *
 * Sections, in order of how often a visitor wants them:
 *   status     what is loaded, which frame conventions are on, feed health
 *   closest    the closest known object to Earth RIGHT NOW (propagated)
 *   approaches JPL's close-approach table for the watch window (past 7 d →
 *              next 60 d, ≤ 0.05 AU) — click to select and lock the camera
 *   showers    meteor showers active at the sim date + the next peak
 *   risk       Sentry impact monitor, top entries
 *   fireballs  bolides reported by US Government sensors
 *   notables   named objects visitors ask about (Apophis, Bennu, 3I/ATLAS…)
 *   legend     what the colours mean, and the two-frame disclosure
 *
 * Feeds that are down say so in their own section; nothing is invented.
 */

import { FLAG, LD_AU, formatLD, formatSize, diameterKmFromH, NOTABLES, findNotable } from './neo-orbits.js';
import { NEO_COLORS, NATURAL_COLORS, displayName } from './neo-layer.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (n) => '#' + n.toString(16).padStart(6, '0');

function fmtRel(ms, nowMs) {
    const d = (ms - nowMs) / 86400e3;
    if (Math.abs(d) < 1 / 24) return 'now';
    if (Math.abs(d) < 1) { const h = Math.round(Math.abs(d) * 24); return d < 0 ? `${h} h ago` : `in ${h} h`; }
    const dd = Math.abs(d) < 10 ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d));
    return d < 0 ? `${dd} d ago` : `in ${dd} d`;
}
function fmtUtc(ms) {
    const d = new Date(ms);
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export const PANEL_CSS = `
.neo-status { font-size:10px; color:#8a8f9a; line-height:1.5; margin-bottom:6px }
.neo-status b { color:#ffd700; font-weight:600 }
.neo-status .down { color:#ff7a5c }
.neo-toggles { display:flex; flex-wrap:wrap; gap:4px 10px; margin:4px 0 6px; font-size:10px; color:#999 }
.neo-toggles label { cursor:pointer; display:flex; align-items:center; gap:4px; white-space:nowrap }
.neo-toggles input { accent-color:#ffd700; cursor:pointer }
.neo-toggles select { background:rgba(0,0,0,.4); color:#ddc; border:1px solid rgba(255,200,0,.25); border-radius:4px; font-size:10px; padding:1px 4px }
.neo-h { font-size:9px; color:#665; text-transform:uppercase; letter-spacing:.5px; margin:9px 0 4px; display:flex; justify-content:space-between }
.neo-h span:last-child { color:#556; text-transform:none; letter-spacing:0 }
.neo-list { display:flex; flex-direction:column; gap:2px; max-height:220px; overflow-y:auto; padding-right:2px }
.neo-list::-webkit-scrollbar { width:4px } .neo-list::-webkit-scrollbar-thumb { background:rgba(255,200,0,.3); border-radius:2px }
.neo-row { display:grid; grid-template-columns:1fr auto; gap:1px 8px; padding:4px 6px; border-radius:5px; background:rgba(255,255,255,.025);
           border:1px solid transparent; cursor:pointer; text-align:left; color:#ccc; font:inherit; font-size:10.5px; line-height:1.3; width:100% }
.neo-row:hover { background:rgba(255,200,0,.08); border-color:rgba(255,200,0,.25) }
.neo-row.sel { border-color:#ffd700; background:rgba(255,200,0,.12) }
.neo-row.static { cursor:default } .neo-row.static:hover { background:rgba(255,255,255,.025); border-color:transparent }
.neo-row .n { color:#eee; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.neo-row .d { color:#8fb8e8; font-variant-numeric:tabular-nums; white-space:nowrap; text-align:right }
.neo-row .s { grid-column:1 / -1; color:#778; font-size:9.5px }
.neo-row.now .d { color:#ffe9a8 } .neo-row.now { border-color:rgba(255,233,168,.35) }
.neo-row.risk .d { color:#ff9d7a }
.neo-chip { display:inline-block; padding:1px 6px; border-radius:8px; font-size:9px; font-weight:600; margin:0 3px 3px 0; cursor:pointer;
            border:1px solid rgba(255,255,255,.15); background:rgba(255,255,255,.05); color:#ddd; font-family:inherit }
.neo-chip:hover { border-color:#ffd700; color:#fff } .neo-chip.absent { opacity:.4; cursor:default }
.neo-legend { display:flex; flex-wrap:wrap; gap:3px 9px; font-size:9.5px; color:#889; margin-top:4px }
.neo-legend i { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:4px; vertical-align:middle }
.neo-note { font-size:9.5px; color:#667; line-height:1.45; margin-top:6px }
.neo-closest { padding:6px 8px; border-radius:6px; background:rgba(143,184,232,.07); border:1px solid rgba(143,184,232,.2); font-size:10.5px; cursor:pointer; color:#ccd }
.neo-closest:hover { border-color:#8fb8e8 }
.neo-closest b { color:#fff } .neo-closest .d { color:#8fb8e8; font-weight:700 }
`;

export class NeoPanel {
    /**
     * @param {{ layer: import('./neo-layer.js').NeoLayer, root: HTMLElement, hud?: { count?: HTMLElement, closest?: HTMLElement },
     *           onSelect: (body:object|null)=>void, getSimMs: ()=>number, dataCard?: HTMLElement }} opts
     */
    constructor(opts) {
        this.layer = opts.layer;
        this.root = opts.root;
        this.hud = opts.hud ?? {};
        this.onSelect = opts.onSelect;
        this.getSimMs = opts.getSimMs ?? (() => Date.now());
        this.dataCard = opts.dataCard ?? null;
        this._lastRender = 0;
        if (!document.getElementById('neo-panel-css')) {
            const st = document.createElement('style'); st.id = 'neo-panel-css'; st.textContent = PANEL_CSS; document.head.appendChild(st);
        }
        this.root.innerHTML = `
            <div class="neo-status" id="neo-status">loading…</div>
            <div class="neo-toggles" id="neo-toggles">
                <label><input type="checkbox" data-vis="asteroids" checked> Asteroids</label>
                <label><input type="checkbox" data-vis="comets" checked> Comets</label>
                <label><input type="checkbox" data-vis="local" checked> Near-Earth frame</label>
                <label><input type="checkbox" data-vis="radiants" checked> Meteor radiants</label>
                <label><input type="checkbox" data-vis="orbit" checked> Selected orbit</label>
                <label title="Natural tints (S/C-type greys, blue-white comets) or the data-viz class palette"><input type="checkbox" data-vis="colorMode"> Colour by class</label>
                <label>Show <select data-pop>
                    <option value="all">every object loaded</option>
                    <option value="bright">≥140 m + PHAs</option>
                    <option value="pha">PHAs only</option>
                </select></label>
            </div>
            <div id="neo-closest"></div>
            <div class="neo-h"><span>Close approaches</span><span id="neo-approach-window"></span></div>
            <div class="neo-list" id="neo-approaches"></div>
            <div class="neo-h"><span>Meteor showers</span><span id="neo-shower-lon"></span></div>
            <div class="neo-list" id="neo-showers" style="max-height:150px"></div>
            <div class="neo-h"><span>Impact monitor (Sentry)</span><span id="neo-risk-note"></span></div>
            <div class="neo-list" id="neo-risk" style="max-height:150px"></div>
            <div class="neo-h"><span>Recent fireballs</span><span>US Gov sensors</span></div>
            <div class="neo-list" id="neo-fireballs" style="max-height:120px"></div>
            <div class="neo-h"><span>Notable objects</span></div>
            <div id="neo-notables"></div>
            <div class="neo-h"><span>Legend</span></div>
            <div class="neo-legend" id="neo-legend"></div>
            <div class="neo-note" id="neo-note"></div>`;
        this.$ = (id) => this.root.querySelector('#' + id);
        this._wire();
        this._renderLegend();
        this.layer.on('catalog', () => this.renderStatus());
        this.layer.on('population', () => { this.renderStatus(); this.renderNotables(); this.renderApproaches(); this.renderRisk(); });
        this.layer.on('watch', () => { this.renderStatus(); this.renderApproaches(); this.renderRisk(); this.renderFireballs(); });
        this.layer.on('frame', () => this.renderClosest());
        this.layer.on('select', () => this._markSelected());
        this.renderStatus(); this.renderApproaches(); this.renderShowers(); this.renderRisk(); this.renderFireballs(); this.renderNotables();
    }

    _wire() {
        this.root.addEventListener('change', (ev) => {
            const t = ev.target;
            if (t.dataset.vis === 'colorMode') { this.layer.setVisible({ colorMode: t.checked ? 'class' : 'natural' }); this._renderLegend(); return; }
            if (t.dataset.vis) this.layer.setVisible({ [t.dataset.vis]: t.checked });
            if (t.hasAttribute('data-pop')) this.layer.setVisible({ population: t.value });
        });
        this.root.addEventListener('click', (ev) => {
            const el = ev.target.closest('[data-des], [data-index]');
            if (!el) return;
            let body = null;
            if (el.dataset.index != null && el.dataset.index !== '') body = this.layer.select(Number(el.dataset.index));
            else if (el.dataset.des) body = this.layer.selectByDes(el.dataset.des);
            if (body) this.onSelect?.(body);
        });
    }

    _markSelected() {
        const sel = this.layer.selectedIndex;
        this.root.querySelectorAll('.neo-row').forEach(r => {
            r.classList.toggle('sel', sel != null && r.dataset.index === String(sel));
        });
    }

    renderStatus() {
        const s = this.layer.status;
        const cat = s.catalog === 'down' ? `<span class="down">${esc(s.catalogNote)}</span>` : `<b>${this.layer.count.toLocaleString()}</b> objects loaded (${esc(s.tierLoaded ?? '…')}${s.tiersPending.length ? ' → ' + s.tiersPending.join(' → ') : ''})`;
        const nPha = this.layer.els.reduce((n, el) => n + ((el.flags & FLAG.PHA) ? 1 : 0), 0);
        const nCom = this.layer.els.reduce((n, el) => n + ((el.flags & FLAG.COMET) ? 1 : 0), 0);
        const nInt = this.layer.els.reduce((n, el) => n + ((el.flags & FLAG.INTERSTELLAR) ? 1 : 0), 0);
        const watch = s.watch === 'down' ? `<span class="down">${esc(s.watchNote)}</span>` : esc(s.watchNote);
        this.$('neo-status').innerHTML = `${cat}<br>${nPha.toLocaleString()} PHAs · ${nCom} comets · ${nInt} interstellar · JPL SBDB elements, two-body propagation<br>Watch: ${watch}`;
        if (this.hud.count) this.hud.count.textContent = s.catalog === 'down' ? 'feed down' : this.layer.count.toLocaleString();
        this.renderNote();
    }

    renderClosest() {
        const c = this.layer.closest;
        const box = this.$('neo-closest');
        if (!c) { box.innerHTML = ''; if (this.hud.closest) this.hud.closest.textContent = '—'; return; }
        const el = this.layer.els[c.index];
        const now = performance.now();
        if (now - this._lastRender < 250) return;
        this._lastRender = now;
        const name = displayName(el);
        const d = c.dLD < 10 ? c.dLD.toFixed(2) : c.dLD.toFixed(1);
        box.innerHTML = `<div class="neo-closest" data-index="${c.index}" title="Select and lock the camera">Closest known object right now: <b>${esc(name)}</b> at <span class="d">${d} LD</span> (${(c.dAU).toFixed(4)} AU) — click to track</div>`;
        if (this.hud.closest) { this.hud.closest.textContent = `${name} · ${d} LD`; }
    }

    renderApproaches() {
        const list = this.$('neo-approaches');
        const w = this.layer.watch;
        const nowMs = this.getSimMs();
        this.$('neo-approach-window').textContent = w.window ? `≤ ${(w.window.dist_max_au / LD_AU).toFixed(1)} LD · JPL CAD` : '';
        if (this.layer.status.watch === 'down') { list.innerHTML = `<div class="neo-row static"><span class="s">${esc(this.layer.status.watchNote)}</span></div>`; return; }
        if (!w.approaches.length) { list.innerHTML = `<div class="neo-row static"><span class="s">No close approaches in the window.</span></div>`; return; }
        const rows = w.approaches.slice().sort((a, b) => Math.abs(a.t_ms - nowMs) - Math.abs(b.t_ms - nowMs)).slice(0, 40)
            .sort((a, b) => a.t_ms - b.t_ms);
        list.innerHTML = rows.map(a => {
            const size = a.diam_km != null ? formatSize(a.diam_km) : (a.H != null ? formatSize(diameterKmFromH(a.H)) : '—');
            const isNow = Math.abs(a.t_ms - nowMs) < 86400e3;
            const idx = a.index;
            const absent = idx == null;
            return `<button class="neo-row${isNow ? ' now' : ''}" ${absent ? `data-des="${esc(a.des)}"` : `data-index="${idx}"`} title="${absent ? 'Not in the loaded catalogue tier yet' : 'Select and lock the camera'}">
                <span class="n">${esc(a.name)}</span><span class="d">${formatLD(a.dist_au)}</span>
                <span class="s">${fmtUtc(a.t_ms)} UTC · ${fmtRel(a.t_ms, nowMs)} · ${a.v_rel_kms != null ? a.v_rel_kms.toFixed(1) + ' km/s · ' : ''}${size}${absent ? ' · not in loaded tier' : ''}</span></button>`;
        }).join('');
        this._markSelected();
    }

    renderShowers() {
        const list = this.$('neo-showers');
        const sh = this.layer.showers();
        if (sh.solarLon == null) { list.innerHTML = `<div class="neo-row static"><span class="s">—</span></div>`; return; }
        this.$('neo-shower-lon').textContent = `λ☉ ${sh.solarLon.toFixed(1)}°`;
        const rows = sh.active.map(x => {
            const s = x.shower;
            const idx = s.parentDes ? this.layer.byDes.get(s.parentDes) : null;
            const pct = Math.round(x.activity * 100);
            return `<button class="neo-row${x.activity > 0.5 ? ' now' : ''}" ${idx != null ? `data-index="${idx}"` : 'data-none="1"'} title="${idx != null ? 'Select the parent body' : 'Parent not in the loaded catalogue'}">
                <span class="n">☄ ${esc(s.name)}</span><span class="d">ZHR ~${Math.round(s.zhr * x.activity)}</span>
                <span class="s">${pct}% of peak · ${s.vKms} km/s · parent ${esc(s.parent)}${idx != null ? ' → click to show its orbit' : ''}${s.note ? ' · ' + esc(s.note) : ''}</span></button>`;
        });
        if (!rows.length) rows.push(`<div class="neo-row static"><span class="s">No major shower active at this date.</span></div>`);
        if (sh.next) rows.push(`<div class="neo-row static"><span class="n">Next peak: ${esc(sh.next.shower.name)}</span><span class="d">in ${Math.round(sh.next.daysAhead)} d</span><span class="s">ZHR ~${sh.next.shower.zhr} · parent ${esc(sh.next.shower.parent)}</span></div>`);
        list.innerHTML = rows.join('');
        this._markSelected();
    }

    renderRisk() {
        const list = this.$('neo-risk');
        const w = this.layer.watch;
        if (!w.sentry.length) {
            const src = this.layer.status.watchMeta?.sources?.sentry;
            list.innerHTML = `<div class="neo-row static"><span class="s">${src && !src.ok ? 'Sentry feed down — ' + esc(src.reason) : 'No entries.'}</span></div>`;
            this.$('neo-risk-note').textContent = '';
            return;
        }
        this.$('neo-risk-note').textContent = `${this.layer.status.watchMeta?.sources?.sentry?.total ?? w.sentry.length} objects monitored`;
        list.innerHTML = w.sentry.slice(0, 12).map(s => {
            const idx = s.index;
            return `<button class="neo-row risk" ${idx != null ? `data-index="${idx}"` : `data-des="${esc(s.des)}"`}>
                <span class="n">${esc(s.name)}</span><span class="d">Torino ${s.ts_max} · PS ${s.ps_cum ?? '—'}</span>
                <span class="s">P(impact) ${s.ip != null ? Number(s.ip).toExponential(1) : '—'} · ${esc(s.range ?? '')} · ${s.diam_km != null ? formatSize(s.diam_km) : (s.H != null ? formatSize(diameterKmFromH(s.H)) : '—')}${idx == null ? ' · not in loaded tier' : ''}</span></button>`;
        }).join('');
        this._markSelected();
    }

    renderFireballs() {
        const list = this.$('neo-fireballs');
        const w = this.layer.watch;
        if (!w.fireballs.length) {
            const src = this.layer.status.watchMeta?.sources?.fireballs;
            list.innerHTML = `<div class="neo-row static"><span class="s">${src && !src.ok ? 'Fireball feed down — ' + esc(src.reason) : 'No recent events.'}</span></div>`;
            return;
        }
        list.innerHTML = w.fireballs.slice(0, 8).map(f => {
            const where = f.lat != null && f.lon != null ? `${Math.abs(f.lat).toFixed(1)}°${f.lat < 0 ? 'S' : 'N'} ${Math.abs(f.lon).toFixed(1)}°${f.lon < 0 ? 'W' : 'E'}` : 'location n/a';
            return `<div class="neo-row static"><span class="n">${fmtUtc(f.t_ms)} UTC</span><span class="d">${f.impact_kt != null ? f.impact_kt + ' kt' : '—'}</span>
                <span class="s">${where}${f.vel_kms != null ? ' · ' + f.vel_kms + ' km/s' : ''}${f.alt_km != null ? ' · peak at ' + f.alt_km + ' km' : ''}</span></div>`;
        }).join('');
    }

    renderNotables() {
        const box = this.$('neo-notables');
        const seen = new Set();
        const chips = [];
        for (const n of NOTABLES) {
            if (seen.has(n.label)) continue;
            seen.add(n.label);
            let idx = n.des != null ? this.layer.byDes.get(n.des) : null;
            if (idx == null && n.nameIncludes) idx = this.layer.els.findIndex(el => findNotable(el)?.label === n.label);
            const present = idx != null && idx >= 0;
            chips.push(`<button class="neo-chip${present ? '' : ' absent'}" ${present ? `data-index="${idx}"` : ''} title="${esc(n.why)}${present ? '' : ' — not in the loaded catalogue'}">${esc(n.label)}</button>`);
        }
        box.innerHTML = chips.join('');
    }

    _renderLegend() {
        const classItems = [
            ['pha', 'Potentially hazardous'], ['APO', 'Apollo'], ['ATE', 'Aten'], ['AMO', 'Amor'], ['IEO', 'Atira'],
            ['comet', 'Comet'], ['interstellar', 'Interstellar'], ['flyby', 'Flyby within ±7 d (reticle)'], ['ring', 'LD rings around Earth'], ['radiant', 'Meteor stream (inbound)'],
        ].map(([k, l]) => [NEO_COLORS[k], l]);
        const naturalItems = [
            [NATURAL_COLORS.sType, 'S-type asteroid (reddish grey)'], [NATURAL_COLORS.cType, 'C-type asteroid (dark neutral)'],
            [NATURAL_COLORS.pha, 'Potentially hazardous (warm bias)'], [NATURAL_COLORS.comet, 'Comet · blue ion tail anti-sunward, warm dust tail lagging'],
            [NATURAL_COLORS.interstellar, 'Interstellar'], [NATURAL_COLORS.flyby, 'Flyby within ±7 d (reticle)'],
            [NEO_COLORS.ring, 'LD rings around Earth'], [NEO_COLORS.radiant, 'Meteor stream (inbound)'],
        ];
        const items = this.layer.visible.colorMode === 'class' ? classItems : naturalItems;
        this.$('neo-legend').innerHTML = items.map(([c, l]) => `<span><i style="background:${hex(c)}"></i>${l}</span>`).join('')
            + `<span style="flex-basis:100%;color:#667">Bodies are drawn SUNLIT, not self-luminous — the phase angle is real, so an object
               between you and the Sun is a crescent. Drawn size follows absolute magnitude (H) and tone follows albedo (S-type 0.20 →
               C-type 0.045), both compressed to stay visible at a few pixels; a comet's coma and tails are the light that is real, and
               scale as 1/r². A ring around a body is the page pointing at it, never the body being bright.</span>`;
    }

    renderNote() {
        const meta = this.layer.status.catalogMeta;
        const epochNote = meta?.generated_at ? `Catalogue fetched ${meta.generated_at.slice(0, 10)}.` : '';
        this.$('neo-note').innerHTML = `Two frames, both disclosed: far from Earth each object sits at its true heliocentric position on the orrery's log
            radial scale (ecliptic of date). Inside 20 lunar distances it moves to an Earth-anchored frame drawn on the Moon's own
            compression — the 1 LD ring passes through the drawn Moon — and the two cross-fade between 14 and 20 LD. Planets ride
            mean-motion circles; flyby geometry uses Earth's true VSOP87D position. Close-approach rows are JPL's integrated orbits;
            drawn positions are two-body from JPL osculating elements. ${epochNote}`;
    }

    /** Called from the page's animate loop at low cadence (~1 Hz) for the sim-date-dependent sections. */
    tick() {
        const now = performance.now();
        if (now - (this._tickAt ?? 0) < 1000) return;
        this._tickAt = now;
        this.renderShowers();
        const nowMs = this.getSimMs();
        if (Math.abs(nowMs - (this._approachMs ?? 0)) > 3600e3) { this._approachMs = nowMs; this.renderApproaches(); }
    }
}
