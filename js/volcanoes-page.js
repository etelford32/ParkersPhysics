/**
 * volcanoes-page.js — the Earth Volcanoes lab (volcanoes.html).
 *
 * DOM + canvas only. Every number on the page comes from js/volcano-engine.js
 * (status, onset odds, VEI chains, the simulation, the live join); this file
 * draws them and wires controls. It computes no volcanology of its own.
 *
 * The map is a 2-D equirectangular canvas over the self-hosted Blue Marble
 * (assets/earth/day-2k.webp — archival imagery, disclosed), NOT a second 3-D
 * globe: EarthView (earth.html → Layers → Volcanoes) is the globe, and this
 * page is the instrument. Taps are pointerup within TAP_PX / TAP_MS on
 * event.timeStamp (the mars.html double-tap lesson).
 *
 * Test hook: window.__volcanoLab (state + select(num) + runSimulation()).
 */

import {
    decodeCatalog, buildHazardModel, onsetProbability, meanRate, matchActivity,
    prepareSimulation, simulateFuture, replayRecord, eruptionConsequences, forcingSeries,
    globalVeiDistribution, veiDistribution, lastKnownEruption, largestEruption, exposureRanking,
    countByStatus, queryVolcanoes, normaliseName,
    STATUS, STATUS_ORDER, STATUS_COLORS, GROUPS, VEI_TABLE, HAZARD_WINDOW_FROM,
} from './volcano-engine.js';

const CATALOG_URL = '/data/volcanoes/volcanoes-catalog.json';
const ACTIVITY_URL = '/api/volcanoes/activity';
const BASEMAP_URL = '/assets/earth/day-2k.webp';
const TAP_PX = 6, TAP_MS = 600;
const PICK_PX = 11;
const TABLE_PAGE = 60;

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
};

export function fmtYear(y) {
    if (y == null) return 'unknown';
    return y < 0 ? `${(-y).toLocaleString()} BCE` : `${y} CE`;
}
export function fmtPct(p) {
    if (p == null || !Number.isFinite(p)) return '—';
    if (p < 0.001) return '<0.1%';
    if (p >= 0.995) return '>99%';
    return `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
}
function fmtPop(n) {
    if (n == null) return '—';
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)} M`;
    if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
    return String(n);
}
function fmtSo2(tg) { return tg >= 1 ? `${tg.toFixed(1)} Tg` : tg >= 0.01 ? `${(tg * 1000).toFixed(0)} kt` : '<0.01 Tg'; }

// sequential ramps (one hue, dark → bright on the dark map) for the two
// magnitude colour modes
const ODDS_RAMP = ['#3b2414', '#6b3712', '#a34f0e', '#d9700f', '#ff9a2e', '#ffc98a'];
const VEI_RAMP = ['#20263a', '#2c3c66', '#3b5a99', '#4f7fd0', '#79a9f2', '#b9d4ff'];
function rampColor(ramp, x) {
    const k = Math.max(0, Math.min(ramp.length - 1, Math.round(x * (ramp.length - 1))));
    return ramp[k];
}

class VolcanoLab {
    constructor(root) {
        this.root = root;
        this.cat = null;
        this.hazard = null;
        this.globalVei = null;
        this.prep = null;
        this.live = new Map();
        this.liveState = { freshness: null };
        this.unmatched = [];
        this.show = new Set(STATUS_ORDER);
        this.colorMode = 'status';
        this.selected = null;
        this.hover = null;
        this.tableText = '';
        this.tableLimit = TABLE_PAGE;
        this.view = { lon0: 0, lat0: 10, k: 0 };
        this.img = null;
        this.sim = null;
        this.replay = null;
    }

    async boot() {
        this._chip('#vx-chip-cat', 'loading', 'Catalogue: loading…');
        const img = new Image();
        img.decoding = 'async';
        img.onload = () => { this.img = img; this.draw(); };
        img.onerror = () => { this._setText('#vx-map-note', 'Basemap unavailable — volcano positions are still exact.'); };
        img.src = BASEMAP_URL;

        let raw;
        try {
            const r = await fetch(CATALOG_URL);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            raw = await r.json();
        } catch (e) {
            this._chip('#vx-chip-cat', 'down', `Catalogue unavailable (${e.message})`);
            $('#vx-status-line').textContent = 'The volcano catalogue could not be loaded — nothing below can be drawn.';
            return;
        }
        this.cat = decodeCatalog(raw);
        this.hazard = buildHazardModel(this.cat);
        this.globalVei = globalVeiDistribution(this.cat);
        this._chip('#vx-chip-cat', 'live',
            `GVP Volcanoes of the World ${this.cat.source.version} · lists ${this.cat.source.listsDownloaded}`);
        this._buildFilters();
        this._buildHeadline();
        this._wireMap();
        this._wireTable();
        this._wireSim();
        this.renderExposure();
        this.renderTable();
        this.renderReplay();
        this.resize();
        new ResizeObserver(() => this.resize()).observe($('#vx-map-wrap'));

        const q = new URLSearchParams(location.search).get('v');
        const pre = q ? this.cat.volcanoes.find(v => String(v.num) === q) : null;
        this.select(pre ?? this.cat.volcanoes.find(v => v.name === 'Etna'), { fly: !!pre, push: false });

        this.loadActivity();
        // the simulation starts after first paint so the page is usable first
        setTimeout(() => this.runSimulation(), 60);
    }

    _chip(sel, state, text) {
        const c = $(sel); if (!c) return;
        c.dataset.state = state; c.textContent = text;
    }
    _setText(sel, t) { const e = $(sel); if (e) e.textContent = t; }

    // ── headline + filters ──────────────────────────────────────────────
    _buildHeadline() {
        const c = countByStatus(this.cat.volcanoes);
        const g = k => GROUPS[k].statuses.reduce((s, x) => s + c[x], 0);
        $('#vx-stat-total').textContent = this.cat.volcanoes.length.toLocaleString();
        $('#vx-stat-active').textContent = g('active').toLocaleString();
        $('#vx-stat-dormant').textContent = g('dormant').toLocaleString();
        $('#vx-stat-inactive').textContent = g('inactive').toLocaleString();
        $('#vx-stat-rate').textContent = this.hazard.globalOnsetsPerYear.toFixed(0);
    }

    _buildFilters() {
        const host = $('#vx-filters');
        host.textContent = '';
        const counts = countByStatus(this.cat.volcanoes);
        for (const [gk, g] of Object.entries(GROUPS)) {
            const box = el('div', { class: 'vx-fgroup' });
            const allOn = () => g.statuses.every(s => this.show.has(s));
            const head = el('button', { class: 'vx-fhead', type: 'button', 'aria-pressed': 'true', text: g.label,
                onclick: () => {
                    const on = !allOn();
                    for (const s of g.statuses) on ? this.show.add(s) : this.show.delete(s);
                    this._syncFilters(); this.draw(); this.renderTable();
                } });
            box.append(head);
            for (const s of g.statuses) {
                box.append(el('button', { class: 'vx-chip-f', type: 'button', 'data-status': s, 'aria-pressed': 'true',
                    title: STATUS[s].rule,
                    onclick: () => {
                        this.show.has(s) ? this.show.delete(s) : this.show.add(s);
                        this._syncFilters(); this.draw(); this.renderTable();
                    } },
                    el('span', { class: 'vx-tri', style: `color:${STATUS_COLORS[s]}` }),
                    el('span', { text: STATUS[s].label }),
                    el('b', { text: counts[s].toLocaleString() })));
            }
            box.dataset.group = gk;
            host.append(box);
        }
        $('#vx-color').addEventListener('change', e => { this.colorMode = e.target.value; this._legend(); this.draw(); });
        this._legend();
        this._syncFilters();
    }
    _syncFilters() {
        for (const b of document.querySelectorAll('.vx-chip-f')) b.setAttribute('aria-pressed', this.show.has(b.dataset.status) ? 'true' : 'false');
        for (const box of document.querySelectorAll('.vx-fgroup')) {
            const g = GROUPS[box.dataset.group];
            box.querySelector('.vx-fhead').setAttribute('aria-pressed', g.statuses.every(s => this.show.has(s)) ? 'true' : 'false');
        }
    }
    _legend() {
        const lg = $('#vx-legend');
        lg.textContent = '';
        if (this.colorMode === 'status') {
            lg.append(el('span', { class: 'vx-muted', text: 'Colour = status (filters above name each class)' }));
            return;
        }
        const ramp = this.colorMode === 'odds' ? ODDS_RAMP : VEI_RAMP;
        const [lo, hi] = this.colorMode === 'odds' ? ['<0.1%', '>90%'] : ['VEI 0', 'VEI 7+'];
        lg.append(el('span', { text: this.colorMode === 'odds' ? 'Chance a new eruption begins within 10 yr (model, log scale)' : 'Largest known eruption (VEI)' }));
        const bar = el('span', { class: 'vx-ramp' });
        for (const c of ramp) bar.append(el('i', { style: `background:${c}` }));
        lg.append(el('span', { text: lo }), bar, el('span', { text: hi }));
        if (this.colorMode === 'vei') lg.append(el('span', { class: 'vx-muted', text: '· no VEI on record: grey' }));
    }

    colorOf(v) {
        if (this.colorMode === 'status') return STATUS_COLORS[v.status];
        if (this.colorMode === 'odds') {
            const p = onsetProbability(this.hazard, v, 10);
            const x = (Math.log10(Math.max(p, 1e-3)) + 3) / (Math.log10(0.9) + 3);
            return rampColor(ODDS_RAMP, Math.min(1, x));
        }
        const big = largestEruption(v);
        return big ? rampColor(VEI_RAMP, Math.min(7, big.vei) / 7) : '#3a3f4a';
    }

    // ── map ────────────────────────────────────────────────────────────
    resize() {
        const wrap = $('#vx-map-wrap'), cv = $('#vx-map');
        const w = wrap.clientWidth, h = Math.max(220, Math.round(Math.min(w / 2, window.innerHeight * 0.66)));
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
        cv.style.width = `${w}px`; cv.style.height = `${h}px`;
        this.W = w; this.H = h; this.dpr = dpr;
        const kMin = Math.max(w / 360, h / 180);
        if (!(this.view.k >= kMin)) this.view.k = kMin;
        this.kMin = kMin;
        this._clampView();
        this.draw();
    }
    _clampView() {
        const v = this.view;
        v.k = Math.max(this.kMin, Math.min(this.kMin * 40, v.k));
        const hw = this.W / (2 * v.k), hh = this.H / (2 * v.k);
        v.lon0 = Math.max(-180 + hw, Math.min(180 - hw, v.lon0));
        v.lat0 = Math.max(-90 + hh, Math.min(90 - hh, v.lat0));
        $('#vx-map').style.touchAction = v.k > this.kMin * 1.01 ? 'none' : 'pan-y';
    }
    project(lat, lon) {
        const v = this.view;
        return [(lon - v.lon0) * v.k + this.W / 2, (v.lat0 - lat) * v.k + this.H / 2];
    }
    unproject(x, y) {
        const v = this.view;
        return [v.lat0 - (y - this.H / 2) / v.k, v.lon0 + (x - this.W / 2) / v.k];
    }

    draw() {
        const cv = $('#vx-map'); if (!cv || !this.W) return;
        const ctx = cv.getContext('2d');
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.fillStyle = '#070b16'; ctx.fillRect(0, 0, this.W, this.H);
        const [x0, y0] = this.project(90, -180);
        if (this.img) {
            ctx.globalAlpha = 0.9;
            ctx.drawImage(this.img, x0, y0, 360 * this.view.k, 180 * this.view.k);
            ctx.globalAlpha = 1;
            // darken so the status colours, not the oceans, carry the eye
            ctx.fillStyle = 'rgba(4,8,18,.42)'; ctx.fillRect(0, 0, this.W, this.H);
        }
        // graticule
        ctx.strokeStyle = 'rgba(140,170,220,.12)'; ctx.lineWidth = 1;
        ctx.beginPath();
        for (let lon = -180; lon <= 180; lon += 30) { const [x] = this.project(0, lon); ctx.moveTo(x, 0); ctx.lineTo(x, this.H); }
        for (let lat = -60; lat <= 60; lat += 30) { const [, y] = this.project(lat, 0); ctx.moveTo(0, y); ctx.lineTo(this.W, y); }
        ctx.stroke();
        if (!this.cat) return;

        const zoom = Math.sqrt(this.view.k / this.kMin);
        const base = [7.5, 6.5, 5.5, 5, 4.5, 3.6];
        // draw quiet → active so the erupting ones sit on top
        const order = this._drawOrder ??= this.cat.volcanoes.slice().sort((a, b) => STATUS[b.status].rank - STATUS[a.status].rank);
        for (const v of order) {
            if (!this.show.has(v.status)) continue;
            const [x, y] = this.project(v.lat, v.lon);
            if (x < -10 || y < -10 || x > this.W + 10 || y > this.H + 10) continue;
            const s = base[STATUS[v.status].rank] * Math.min(2.2, zoom * 0.9 + 0.1);
            tri(ctx, x, y, s, this.colorOf(v), v.status === 'inactive' ? 0.75 : 1);
        }
        // live halos
        const t = (performance.now() / 1000) % 1000;
        for (const [i, lv] of this.live) {
            const v = this.cat.volcanoes[i];
            if (!this.show.has(v.status)) continue;
            const [x, y] = this.project(v.lat, v.lon);
            ctx.strokeStyle = lv.colorCode === 'RED' ? '#ff3b1f' : '#ffb35c';
            ctx.lineWidth = 1.6;
            ctx.beginPath(); ctx.arc(x, y - 1, 9 + 2 * Math.sin(t * 3 + i), 0, Math.PI * 2); ctx.stroke();
        }
        for (const [v, ring] of [[this.hover, 'rgba(255,255,255,.7)'], [this.selected, '#ffffff']]) {
            if (!v) continue;
            const [x, y] = this.project(v.lat, v.lon);
            ctx.strokeStyle = ring; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(x, y - 1, 12, 0, Math.PI * 2); ctx.stroke();
        }
        if (this.selected) {
            const [x, y] = this.project(this.selected.lat, this.selected.lon);
            ctx.font = '600 12px system-ui, sans-serif';
            ctx.fillStyle = '#f2f5ff'; ctx.strokeStyle = 'rgba(4,8,18,.85)'; ctx.lineWidth = 3;
            const tx = Math.min(this.W - 6 - ctx.measureText(this.selected.name).width, x + 15);
            ctx.strokeText(this.selected.name, tx, y - 12); ctx.fillText(this.selected.name, tx, y - 12);
        }
        if (this.live.size && !this._anim) {
            this._anim = requestAnimationFrame(() => { this._anim = null; if (!document.hidden && this._mapVisible !== false) this.draw(); });
        }
    }

    pick(x, y) {
        let best = null, bd = PICK_PX * PICK_PX;
        for (const v of this.cat.volcanoes) {
            if (!this.show.has(v.status)) continue;
            const [px, py] = this.project(v.lat, v.lon);
            const d = (px - x) ** 2 + (py - y) ** 2;
            // ties go to the more recently active class
            if (d < bd || (best && d === bd && STATUS[v.status].rank < STATUS[best.status].rank)) { bd = d; best = v; }
        }
        return best;
    }

    _wireMap() {
        const cv = $('#vx-map');
        const tip = $('#vx-tip');
        const local = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        let drag = null;
        cv.addEventListener('pointerdown', e => {
            const [x, y] = local(e);
            drag = { x, y, x0: x, y0: y, t0: e.timeStamp, lon0: this.view.lon0, lat0: this.view.lat0, id: e.pointerId, moved: false };
        });
        cv.addEventListener('pointermove', e => {
            const [x, y] = local(e);
            if (drag && drag.id === e.pointerId) {
                if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) > TAP_PX) {
                    drag.moved = true;
                    try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
                }
                if (drag.moved && this.view.k > this.kMin * 1.01) {
                    this.view.lon0 = drag.lon0 - (x - drag.x0) / this.view.k;
                    this.view.lat0 = drag.lat0 + (y - drag.y0) / this.view.k;
                    this._clampView(); this.draw();
                }
                if (drag.moved) return;
            }
            const v = this.cat ? this.pick(x, y) : null;
            if (v !== this.hover) { this.hover = v; this.draw(); }
            cv.style.cursor = v ? 'pointer' : (this.view.k > this.kMin * 1.01 ? 'grab' : '');
            if (v) {
                const p = onsetProbability(this.hazard, v, 10);
                tip.hidden = false;
                tip.innerHTML = '';
                tip.append(el('b', { text: v.name }),
                    el('div', { text: `${STATUS[v.status].label} · ${v.country ?? ''}` }),
                    el('div', { class: 'vx-muted', text: `Last eruption ${fmtYear(lastKnownEruption(v)?.year ?? null)} · 10-yr odds ${fmtPct(p)}` }));
                const r = $('#vx-map-wrap').getBoundingClientRect();
                const cr = cv.getBoundingClientRect();
                tip.style.left = `${Math.min(cr.left - r.left + x + 14, r.width - 220)}px`;
                tip.style.top = `${cr.top - r.top + y + 12}px`;
            } else tip.hidden = true;
        });
        cv.addEventListener('pointerleave', () => { $('#vx-tip').hidden = true; if (this.hover) { this.hover = null; this.draw(); } });
        cv.addEventListener('pointerup', e => {
            const d = drag; drag = null;
            if (!d || d.moved || e.timeStamp - d.t0 > TAP_MS) return;
            const [x, y] = local(e);
            const v = this.pick(x, y);
            if (v) this.select(v);
        });
        cv.addEventListener('pointercancel', () => { drag = null; });
        cv.addEventListener('wheel', e => {
            e.preventDefault();
            const [x, y] = local(e);
            this.zoomAt(x, y, Math.exp(-e.deltaY * 0.0015));
        }, { passive: false });
        $('#vx-zoom-in').addEventListener('click', () => this.zoomAt(this.W / 2, this.H / 2, 1.6));
        $('#vx-zoom-out').addEventListener('click', () => this.zoomAt(this.W / 2, this.H / 2, 1 / 1.6));
        $('#vx-zoom-reset').addEventListener('click', () => { this.view = { lon0: 0, lat0: 0, k: this.kMin }; this._clampView(); this.draw(); });
        new IntersectionObserver(es => { this._mapVisible = es[0].isIntersecting; if (this._mapVisible) this.draw(); }).observe(cv);
    }
    zoomAt(x, y, f) {
        const [lat, lon] = this.unproject(x, y);
        this.view.k *= f;
        this._clampView();
        // keep the point under the cursor fixed
        this.view.lon0 = lon - (x - this.W / 2) / this.view.k;
        this.view.lat0 = lat + (y - this.H / 2) / this.view.k;
        this._clampView(); this.draw();
    }
    flyTo(v) {
        this.view.k = Math.max(this.view.k, this.kMin * 4);
        this.view.lon0 = v.lon; this.view.lat0 = v.lat;
        this._clampView(); this.draw();
    }

    // ── selection + card ───────────────────────────────────────────────
    select(v, { fly = false, push = true } = {}) {
        if (!v) return;
        this.selected = v;
        if (fly) this.flyTo(v);
        if (push) {
            const u = new URL(location.href); u.searchParams.set('v', v.num);
            history.replaceState(null, '', u);
        }
        this.renderCard();
        this.draw();
    }

    renderCard() {
        const v = this.selected, host = $('#vx-card');
        host.textContent = '';
        const lv = this.live.get(v.i);
        const last = lastKnownEruption(v), big = largestEruption(v);
        const post = this.hazard.perVolcano.get(v.i);
        host.append(
            el('div', { class: 'vx-card-head' },
                el('span', { class: 'vx-tri vx-tri-lg', style: `color:${STATUS_COLORS[v.status]}` }),
                el('div', {},
                    el('h3', { text: v.name }),
                    el('div', { class: 'vx-muted vx-card-sub', text: `${v.country ?? '—'} · ${v.region ?? ''} · GVP #${v.num}` }))),
            el('div', { class: 'vx-status-pill', 'data-status': v.status, text: STATUS[v.status].label }),
            lv ? el('div', { class: 'vx-live-pill', text: `● Live today: ${lv.colorCode ? `aviation ${lv.colorCode}` : 'open activity event'}${lv.alertLevel ? ` · ${lv.alertLevel}` : ''} · ${[...new Set(lv.items.map(i => i.source === 'usgs-hans' ? 'USGS' : 'NASA EONET'))].join(' + ')}` }) : null,
        );
        const dl = el('dl', { class: 'vx-dl' });
        const row = (k, val) => dl.append(el('dt', { text: k }), el('dd', { text: val ?? '—' }));
        row('Type', `${v.type ?? '—'}${v.landform ? ` (${v.landform})` : ''}`);
        row('Summit', v.elev != null ? `${v.elev.toLocaleString()} m` : '—');
        row('Position', `${Math.abs(v.lat).toFixed(3)}°${v.lat >= 0 ? 'N' : 'S'} ${Math.abs(v.lon).toFixed(3)}°${v.lon >= 0 ? 'E' : 'W'}`);
        row('Tectonic setting', v.tectonic);
        row('Dominant rock', v.rock);
        row('Evidence', v.epoch === 'P' ? 'No known Holocene eruption (Pleistocene list)' : v.evidence);
        row('Last known eruption', `${fmtYear(last?.year ?? null)}${last?.vei != null ? ` · VEI ${last.vei}` : ''}${last?.source === 'list' ? ' (GVP list)' : ''}`);
        row('Largest on record', big ? `VEI ${big.vei} · ${fmtYear(big.year)}` : '—');
        row('Confirmed eruptions', v.epoch === 'P' ? '0 in the Holocene' : `${v.eruptions.length.toLocaleString()} (table to ${this.cat.tableThrough})`);
        if (v.pop) row('People within 10 / 30 / 100 km', `${fmtPop(v.pop.km10)} / ${fmtPop(v.pop.km30)} / ${fmtPop(v.pop.km100)}`);
        host.append(dl);

        // onset odds
        const odds = el('div', { class: 'vx-odds' });
        for (const yrs of [1, 10, 50]) {
            odds.append(el('div', { class: 'vx-odds-tile' },
                el('b', { text: fmtPct(onsetProbability(this.hazard, v, yrs)) }),
                el('span', { text: `within ${yrs} yr` })));
        }
        host.append(el('h4', { text: 'Chance a NEW eruption begins (model)' }), odds,
            el('p', { class: 'vx-fine', text: v.epoch === 'P'
                ? `No eruption in the ${(this.cat.epoch + 9700).toFixed(0)} years of the Holocene — Jeffreys posterior for zero events; an upper-bound style estimate, not a forecast.`
                : `${post.onsets} onset${post.onsets === 1 ? '' : 's'} since ${HAZARD_WINDOW_FROM}, shrunk toward the population of all Holocene volcanoes (empirical-Bayes Gamma–Poisson). Mean repose ≈ ${fmtRepose(1 / meanRate(this.hazard, v))}. A decades-long eruption counts once.` }));

        // eruption history (since 1500): stems at VEI height
        if (v.eruptions.length) host.append(el('h4', { text: 'Eruption record' }), historyChart(v, this.cat));

        // what-if
        const vd = veiDistribution(v, this.globalVei.p);
        const defVei = big?.vei ?? Math.max(3, vd.p.indexOf(Math.max(...vd.p.slice(3))));
        const wi = el('div', { class: 'vx-whatif' });
        const out = el('div', { class: 'vx-whatif-out' });
        const slider = el('input', { type: 'range', min: 0, max: 8, step: 1, value: defVei, id: 'vx-vei', 'aria-label': 'Volcanic Explosivity Index for the scenario' });
        const lab = el('output', { for: 'vx-vei' });
        const upd = () => {
            const vei = Number(slider.value);
            lab.textContent = `VEI ${vei} · ${VEI_TABLE[vei].name} · P(this size | eruption) ${fmtPct(vd.p[vei])}`;
            out.textContent = '';
            out.append(...scenarioRows(v, vei));
        };
        slider.addEventListener('input', upd);
        wi.append(el('label', { for: 'vx-vei', text: 'If it erupted at…' }), slider, lab, out);
        host.append(el('h4', { text: 'What would an eruption here do? (model chain)' }), wi);
        upd();
        host.append(el('div', { class: 'vx-card-links' },
            el('a', { href: `earth.html?at=${v.lat.toFixed(3)},${v.lon.toFixed(3)},1500`, text: 'See it on EarthView →' })));
    }

    // ── live activity ──────────────────────────────────────────────────
    async loadActivity() {
        this._chip('#vx-chip-live', 'loading', 'Live activity: loading…');
        let body;
        try {
            const r = await fetch(ACTIVITY_URL);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            body = await r.json();
        } catch (e) {
            body = { freshness: 'stale', reasons: ['activity-route-unreachable'], note: e.message, items: [] };
        }
        const { live, unmatched } = matchActivity(this.cat, body.items ?? []);
        this.live = live; this.unmatched = unmatched; this.liveState = body;
        const n = live.size;
        if (body.freshness === 'live') this._chip('#vx-chip-live', 'live', `Live: ${n} volcano${n === 1 ? '' : 'es'} elevated or erupting`);
        else this._chip('#vx-chip-live', n ? 'partial' : 'down', n ? `Live: PARTIAL — ${n} reported (${(body.reasons ?? []).join(', ')})` : `Live status unavailable (${(body.reasons ?? ['unknown']).join(', ')})`);
        this.renderLive();
        this.draw();
        if (this.selected) this.renderCard();
    }
    renderLive() {
        const host = $('#vx-live'); host.textContent = '';
        if (this.liveState.freshness !== 'live') {
            host.append(el('p', { class: 'vx-warn', text: this.liveState.note
                ?? 'The live feeds did not answer. The catalogue status (erupting in 2025–26, recent, …) still stands; today\'s alerts are unknown.' }));
        }
        const rows = [...this.live.values()].sort((a, b) => colorRank(b.colorCode) - colorRank(a.colorCode) || a.volcano.name.localeCompare(b.volcano.name));
        if (!rows.length) { host.append(el('p', { class: 'vx-muted', text: 'No live reports joined to the catalogue.' })); return; }
        const ul = el('ul', { class: 'vx-live-list' });
        for (const r of rows) {
            // HANS rows carry the notice time ("N d ago"); EONET pins an event
            // once at its START and keeps it open, so its date is "open since".
            const hans = r.items.filter(i => i.source === 'usgs-hans');
            const age = Math.min(...hans.map(i => i.ageDays ?? Infinity));
            const since = r.items.filter(i => i.source === 'eonet' && i.startedAt).map(i => i.startedAt).sort()[0];
            const when = Number.isFinite(age) ? ` ${age < 1 ? 'today' : `${Math.round(age)} d ago`}`
                : since ? ` open since ${new Date(since).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}` : '';
            ul.append(el('li', {},
                el('button', { type: 'button', class: 'vx-linkbtn', text: r.volcano.name, onclick: () => this.select(r.volcano, { fly: true }) }),
                el('span', { class: 'vx-muted', text: ` ${r.volcano.country ?? ''}` }),
                r.colorCode ? el('span', { class: 'vx-cc', 'data-cc': r.colorCode, text: r.colorCode }) : el('span', { class: 'vx-cc', text: 'event' }),
                el('span', { class: 'vx-muted', text: when })));
        }
        host.append(ul);
        if (this.unmatched.length) host.append(el('p', { class: 'vx-fine', text: `${this.unmatched.length} report(s) did not match a catalogued summit (e.g. an unnamed submarine vent) and are listed by the feed only.` }));
    }

    // ── exposure ───────────────────────────────────────────────────────
    renderExposure() {
        const rows = exposureRanking(this.cat, this.hazard, { years: 10, limit: 15 });
        const tb = $('#vx-exposure tbody'); tb.textContent = '';
        rows.forEach((r, k) => tb.append(el('tr', {},
            el('td', { text: String(k + 1) }),
            el('td', {}, el('button', { type: 'button', class: 'vx-linkbtn', text: r.v.name, onclick: () => this.select(r.v, { fly: true }) })),
            el('td', { text: r.v.country ?? '' }),
            el('td', { class: 'num', text: fmtPct(r.p) }),
            el('td', { class: 'num', text: fmtPop(r.people) }))));
    }

    // ── table ──────────────────────────────────────────────────────────
    _wireTable() {
        $('#vx-search').addEventListener('input', e => { this.tableText = e.target.value; this.tableLimit = TABLE_PAGE; this.renderTable(); });
        $('#vx-search').addEventListener('keydown', e => {
            if (e.key !== 'Enter') return;
            const first = this._tableRows?.[0];
            if (first) this.select(first, { fly: true });
        });
        $('#vx-more').addEventListener('click', () => { this.tableLimit += TABLE_PAGE; this.renderTable(); });
    }
    renderTable() {
        if (!this.cat) return;
        const rows = queryVolcanoes(this.cat.volcanoes, { statuses: [...this.show], text: this.tableText })
            .sort((a, b) => STATUS[a.status].rank - STATUS[b.status].rank
                || ((lastKnownEruption(b)?.year ?? -1e9) - (lastKnownEruption(a)?.year ?? -1e9))
                || a.name.localeCompare(b.name));
        this._tableRows = rows;
        const tb = $('#vx-table tbody'); tb.textContent = '';
        for (const v of rows.slice(0, this.tableLimit)) {
            tb.append(el('tr', {},
                el('td', {}, el('button', { type: 'button', class: 'vx-linkbtn', text: v.name, onclick: () => this.select(v, { fly: true }) })),
                el('td', { text: v.country ?? '' }),
                el('td', {}, el('span', { class: 'vx-tri', style: `color:${STATUS_COLORS[v.status]}` }), document.createTextNode(STATUS[v.status].label)),
                el('td', { text: v.type ?? '' }),
                el('td', { class: 'num', text: fmtYear(lastKnownEruption(v)?.year ?? null) }),
                el('td', { class: 'num', text: v.elev != null ? v.elev.toLocaleString() : '—' })));
        }
        $('#vx-table-count').textContent = `${Math.min(rows.length, this.tableLimit).toLocaleString()} of ${rows.length.toLocaleString()} shown`;
        $('#vx-more').hidden = rows.length <= this.tableLimit;
    }

    // ── simulation ─────────────────────────────────────────────────────
    _wireSim() {
        $('#vx-sim-run').addEventListener('click', () => this.runSimulation());
    }
    runSimulation() {
        if (!this.cat) return;
        const years = Number($('#vx-sim-years').value), members = Number($('#vx-sim-members').value);
        const seed = Math.max(1, Math.floor(Number($('#vx-sim-seed').value) || 1));
        const btn = $('#vx-sim-run');
        btn.disabled = true; btn.textContent = 'Running…';
        $('#vx-sim-status').textContent = `Simulating ${members} futures × ${years} years…`;
        // yield a frame so the button state paints before the synchronous run
        requestAnimationFrame(() => setTimeout(() => {
            const t0 = performance.now();
            this.prep ??= prepareSimulation(this.cat, { hazard: this.hazard });
            this.sim = simulateFuture(this.prep, { years, members, seed });
            const ms = performance.now() - t0;
            btn.disabled = false; btn.textContent = 'Run simulation';
            $('#vx-sim-status').textContent = `${members} futures · seed ${seed} · ${this.sim.spinUpYears}-yr statistical spin-up · ${ms.toFixed(0)} ms`;
            this.renderSim();
        }, 0));
    }
    renderSim() {
        const s = this.sim;
        const tiles = $('#vx-sim-tiles'); tiles.textContent = '';
        const tile = (big, small) => tiles.append(el('div', { class: 'vx-tile' }, el('b', { text: big }), el('span', { text: small })));
        tile(`${s.onsetsPerYear.median.toFixed(0)}/yr`, `new eruptions (90%: ${s.onsetsPerYear.p05.toFixed(0)}–${s.onsetsPerYear.p95.toFixed(0)})`);
        for (const k of [5, 6, 7]) tile(fmtPct(s.pAtLeastVei[k]), `chance of ≥ 1 VEI ${k}+ in ${s.years} yr`);
        tile(`${s.background.forcing.toFixed(2)} W m⁻²`, `background forcing (mean of all futures)`);
        tile(`${s.minTemperature.median.toFixed(2)} K`, `coolest month, median future`);
        tile(`${s.minTemperature.worst.toFixed(2)} K`, `coolest month, worst of ${s.members}`);
        const t = Array.from(s.bands.t);
        bandChart($('#vx-sim-forcing'), { t, lo: s.bands.forcing[0], mid: s.bands.forcing[1], hi: s.bands.forcing[2],
            title: 'Volcanic radiative forcing (W m⁻²)', fmt: x => x.toFixed(2), yMinFloor: -4 });
        bandChart($('#vx-sim-temp'), { t, lo: s.bands.temperature[0], mid: s.bands.temperature[1], hi: s.bands.temperature[2],
            title: 'Global-mean temperature response (K)', fmt: x => x.toFixed(2), yMinFloor: -0.6 });
        const ul = $('#vx-sim-big'); ul.textContent = '';
        const big = s.exampleRuns.worst.big.filter(e => e.vei >= 5).slice(0, 8);
        if (!big.length) ul.append(el('li', { class: 'vx-muted', text: 'No VEI 5+ eruption in this member.' }));
        for (const e of big) ul.append(el('li', {}, el('b', { text: `${e.t.toFixed(1)}` }), document.createTextNode(` ${e.name} · VEI ${e.vei} · ${fmtSo2(e.stratSo2Tg)} SO₂ to the stratosphere`)));
    }
    renderReplay() {
        this.replay = replayRecord(this.cat);
        const s = this.replay.series;
        const t = Array.from(s.t);
        const labels = [];
        for (const inj of this.replay.injections.filter(i => i.vei >= 6 || (i.vei >= 5 && ['Agung', 'Chichon, El'].includes(i.name)))) {
            labels.push({ t: inj.t, text: `${inj.name.replace('Chichon, El', 'El Chichón')} ${Math.floor(inj.t)}` });
        }
        lineChart($('#vx-replay'), { t, y: Array.from(s.forcing), title: 'Forcing from the catalogued 1900–2020 eruptions (W m⁻², model chain)', fmt: x => x.toFixed(2), labels });
        $('#vx-replay-note').textContent = `${this.replay.injections.length} eruptions of VEI ≥ 3 with a known VEI; ${this.replay.skippedUnknownVei} with no VEI on record are not counted. Onsets placed mid-year (the exported table carries the year).`;
    }
}

function colorRank(c) { return { RED: 3, ORANGE: 2, YELLOW: 1, GREEN: 0 }[c] ?? -1; }
function fmtRepose(y) {
    if (!Number.isFinite(y)) return '—';
    if (y < 2) return `${(y * 12).toFixed(0)} months`;
    if (y < 1000) return `${y.toFixed(0)} yr`;
    return `${(y / 1000).toFixed(1)} kyr`;
}

function tri(ctx, x, y, s, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(3,6,14,.85)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.92, y + s * 0.6); ctx.lineTo(x - s * 0.92, y + s * 0.6); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.globalAlpha = 1;
}

/** The scenario rows for the card (engine numbers only). */
function scenarioRows(v, vei) {
    const c = eruptionConsequences({ vei, lat: v.lat, elevM: v.elev });
    const ser = forcingSeries([{ t: 0.01, peakAod: c.peakAod, residenceYr: c.residenceYr }], { t0: 0, t1: 8 });
    let minT = 0; for (const x of ser.temperature) minT = Math.min(minT, x);
    const rows = [
        ['Erupted volume (bulk)', `${fmtVol(c.column.bulkM3)}`],
        ['Column height above vent', `${c.column.heightKm.toFixed(1)} km${c.column.method === 'mastin-2009' ? ` (Mastin 2009, ${c.column.durationH} h climax)` : ' (Newhall & Self range)'}${c.column.capped ? ', capped' : ''}`],
        ['Plume top vs tropopause', `${c.plumeTopKm.toFixed(1)} km vs ${c.tropopauseKm.toFixed(1)} km → ${fmtPct(c.stratosphericFraction)} of the SO₂ reaches the stratosphere`],
        ['SO₂ released (typical for VEI)', fmtSo2(c.so2Tg)],
        ['Peak global aerosol optical depth', c.peakAod < 0.001 ? '<0.001' : c.peakAod.toFixed(3)],
        ['Peak forcing · peak cooling', `${c.peakForcingWm2.toFixed(2)} W m⁻² · ${minT.toFixed(2)} K`],
    ];
    const dl = el('dl', { class: 'vx-dl vx-dl-tight' });
    for (const [k, val] of rows) dl.append(el('dt', { text: k }), el('dd', { text: val }));
    return [dl];
}
function fmtVol(m3) {
    const sig = x => Number(x.toPrecision(2)).toLocaleString();
    if (m3 >= 1e9) return `${sig(m3 / 1e9)} km³`;
    if (m3 >= 1e6) return `${sig(m3 / 1e6)} million m³`;
    return `${sig(m3)} m³`;
}

// ── charts (SVG, one axis each, hover crosshair) ────────────────────────────
const SVGNS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

function niceTicks(lo, hi, n = 4) {
    const span = hi - lo || 1;
    const step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) ?? step0;
    const out = [];
    for (let x = Math.ceil(lo / step) * step; x <= hi + 1e-9; x += step) out.push(+x.toFixed(10));
    return out;
}

function chartFrame(host, { title, t, yLo, yHi }) {
    host.textContent = '';
    const W = Math.max(280, host.clientWidth || 600), H = 170;
    const m = { l: 44, r: 12, t: 24, b: 22 };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': title });
    const tx = x => m.l + (x - t[0]) / (t[t.length - 1] - t[0]) * (W - m.l - m.r);
    const ty = y => m.t + (yHi - y) / (yHi - yLo) * (H - m.t - m.b);
    const ttl = sv('text', { x: m.l, y: 14, class: 'vx-ch-title' }); ttl.textContent = title; svg.append(ttl);
    for (const y of niceTicks(yLo, yHi)) {
        svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: ty(y), y2: ty(y), class: y === 0 ? 'vx-ch-zero' : 'vx-ch-grid' }));
        const lb = sv('text', { x: m.l - 6, y: ty(y) + 3, class: 'vx-ch-tick', 'text-anchor': 'end' }); lb.textContent = y; svg.append(lb);
    }
    for (const x of niceTicks(t[0], t[t.length - 1], 6)) {
        const lb = sv('text', { x: tx(x), y: H - 6, class: 'vx-ch-tick', 'text-anchor': 'middle' }); lb.textContent = Math.round(x); svg.append(lb);
    }
    host.append(svg);
    return { svg, tx, ty, W, H, m };
}

function addHover(host, f, t, describe) {
    const { svg, tx, m, H } = f;
    const line = sv('line', { y1: m.t, y2: H - m.b, class: 'vx-ch-cross' }); line.style.display = 'none';
    const dot = sv('circle', { r: 4, class: 'vx-ch-dot' }); dot.style.display = 'none';
    svg.append(line, dot);
    const tip = document.createElement('div'); tip.className = 'vx-ch-tip'; tip.hidden = true; host.append(tip);
    svg.addEventListener('pointermove', e => {
        const r = svg.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width * f.W;
        let k = Math.round((x - m.l) / (f.W - m.l - m.r) * (t.length - 1));
        k = Math.max(0, Math.min(t.length - 1, k));
        const { y, html } = describe(k);
        line.setAttribute('x1', tx(t[k])); line.setAttribute('x2', tx(t[k])); line.style.display = '';
        dot.setAttribute('cx', tx(t[k])); dot.setAttribute('cy', f.ty(y)); dot.style.display = '';
        tip.hidden = false; tip.textContent = html;
        tip.style.left = `${Math.min(r.width - 170, Math.max(0, tx(t[k]) / f.W * r.width + 10))}px`;
    });
    svg.addEventListener('pointerleave', () => { line.style.display = 'none'; dot.style.display = 'none'; tip.hidden = true; });
}

function bandChart(host, { t, lo, mid, hi, title, fmt, yMinFloor }) {
    let yLo = Math.min(yMinFloor ?? 0, ...lo), yHi = Math.max(0.02 * Math.abs(yLo), ...hi);
    const f = chartFrame(host, { title, t, yLo, yHi });
    const { tx, ty, svg } = f;
    let dBand = '';
    for (let k = 0; k < t.length; k++) dBand += `${k ? 'L' : 'M'}${tx(t[k]).toFixed(1)},${ty(hi[k]).toFixed(1)}`;
    for (let k = t.length - 1; k >= 0; k--) dBand += `L${tx(t[k]).toFixed(1)},${ty(lo[k]).toFixed(1)}`;
    svg.append(sv('path', { d: dBand + 'Z', class: 'vx-ch-band' }));
    let d = '';
    for (let k = 0; k < t.length; k++) d += `${k ? 'L' : 'M'}${tx(t[k]).toFixed(1)},${ty(mid[k]).toFixed(1)}`;
    svg.append(sv('path', { d, class: 'vx-ch-line' }));
    const key = sv('text', { x: f.W - f.m.r, y: 14, class: 'vx-ch-tick', 'text-anchor': 'end' });
    key.textContent = 'line: median future · band: 5–95% of futures';
    svg.append(key);
    addHover(host, f, t, k => ({ y: mid[k], html: `${t[k].toFixed(1)} · median ${fmt(mid[k])} · 90%: ${fmt(lo[k])} to ${fmt(hi[k])}` }));
}

function lineChart(host, { t, y, title, fmt, labels = [] }) {
    const yLo = Math.min(-0.5, ...y), yHi = Math.max(0.1, ...y) + 0.3;
    const f = chartFrame(host, { title, t, yLo, yHi });
    const { tx, ty, svg } = f;
    let d = '';
    for (let k = 0; k < t.length; k++) d += `${k ? 'L' : 'M'}${tx(t[k]).toFixed(1)},${ty(y[k]).toFixed(1)}`;
    svg.append(sv('path', { d, class: 'vx-ch-line' }));
    // selective direct labels at each labelled eruption's trough
    let lastX = -1e9;
    for (const lb of labels.sort((a, b) => a.t - b.t)) {
        const k0 = t.findIndex(x => x >= lb.t);
        if (k0 < 0) continue;
        let kmin = k0; for (let k = k0; k < Math.min(t.length, k0 + 24); k++) if (y[k] < y[kmin]) kmin = k;
        const x = tx(t[kmin]);
        if (x - lastX < 62) continue;
        lastX = x;
        const tt = sv('text', { x, y: ty(y[kmin]) + 13, class: 'vx-ch-label', 'text-anchor': 'middle' }); tt.textContent = lb.text;
        svg.append(tt);
    }
    addHover(host, f, t, k => ({ y: y[k], html: `${t[k].toFixed(1)} · ${fmt(y[k])} W m⁻²` }));
}

/** Eruption record since 1500 as stems at VEI height (unknown VEI: hollow
 *  tick on the axis). One axis, one series — the title names it. */
function historyChart(v, cat) {
    const host = el('div', { class: 'vx-hist' });
    const from = 1500, to = Math.ceil(cat.epoch);
    const W = 340, H = 92, m = { l: 26, r: 6, t: 8, b: 16 };
    const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, role: 'img', 'aria-label': `Eruptions of ${v.name} since ${from}` });
    const tx = x => m.l + (x - from) / (to - from) * (W - m.l - m.r);
    const ty = y => m.t + (6 - y) / 6 * (H - m.t - m.b);
    for (const y of [0, 2, 4, 6]) {
        svg.append(sv('line', { x1: m.l, x2: W - m.r, y1: ty(y), y2: ty(y), class: 'vx-ch-grid' }));
        const lb = sv('text', { x: m.l - 4, y: ty(y) + 3, class: 'vx-ch-tick', 'text-anchor': 'end' }); lb.textContent = y; svg.append(lb);
    }
    for (const x of [1500, 1600, 1700, 1800, 1900, 2000]) {
        const lb = sv('text', { x: tx(x), y: H - 3, class: 'vx-ch-tick', 'text-anchor': 'middle' }); lb.textContent = x; svg.append(lb);
    }
    let n = 0, older = 0;
    for (const e of v.eruptions) {
        if (e.year < from) { older++; continue; }
        n++;
        const x = tx(e.year);
        if (e.vei == null) svg.append(sv('circle', { cx: x, cy: ty(0) - 3, r: 2.2, class: 'vx-ch-unk' }));
        else {
            svg.append(sv('line', { x1: x, x2: x, y1: ty(0), y2: ty(Math.min(6, e.vei)), class: 'vx-ch-stem' }));
            const c = sv('circle', { cx: x, cy: ty(Math.min(6, e.vei)), r: 2.6, class: 'vx-ch-dot2' });
            const tt = sv('title'); tt.textContent = `${fmtYear(e.year)} · VEI ${e.vei}`; c.append(tt);
            svg.append(c);
        }
    }
    host.append(svg, el('div', { class: 'vx-fine', text: `VEI of each eruption since ${from} (${n}); hollow = VEI not recorded.${older ? ` ${older} older eruption${older === 1 ? '' : 's'} not shown.` : ''}` }));
    return host;
}

// boot
if (typeof window !== 'undefined' && document.getElementById('vx-app')) {
    const lab = new VolcanoLab(document.getElementById('vx-app'));
    window.__volcanoLab = lab;
    lab.boot();
    // exposed helpers for the browser gate
    lab.selectNum = (num) => { const v = lab.cat?.volcanoes.find(x => x.num === Number(num)); if (v) lab.select(v, { fly: true }); return !!v; };
    lab.normaliseName = normaliseName;
}
