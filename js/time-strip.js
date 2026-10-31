/**
 * time-strip.js — the EarthView time bar's weather strip (DOM + canvas).
 *
 * EARTHVIEW_WEATHER_TIME_ENGINE_PLAN.md §6 (T4.1 / T4.2), built on the
 * WeatherCube (§3). Geometry comes from the PURE js/time-strip-model.js;
 * this file only measures, paints and listens.
 *
 * What the user gets:
 *   - the next two weeks (and last week) of weather AT ONE PLACE drawn under
 *     the slider: temperature line, rain bars, cloud veil, night shading —
 *     "when does it rain here?" answered before anyone scrubs;
 *   - a band along the bottom saying where each stretch comes from
 *     (observed / in-browser nowcast / NWP forecast), with gaps left empty;
 *   - a 30 px tall drag target that scrubs time — far easier to hit than the
 *     4 px native track, on a phone above all;
 *   - a hover readout with the exact values, local time and source.
 *
 * ONE PATH INTO THE CLOCK: dragging the strip writes the existing range
 * input's value and dispatches its own `input` / `change` events, so the
 * hoisted slider handler in earth.html stays the only writer of the time
 * bus and the resume-on-release rule applies unchanged.
 *
 * Cheap by construction: the meteogram is repainted only when the cube's
 * data version, the place, the strip's size or the "now" pixel changes;
 * per frame the page calls update(simMs), which moves one 1-px cursor
 * element and polls the cube's O(1) version once a second.
 */

import { stripModel, xToTime, timeToX, describeSample } from './time-strip-model.js';
import { PROVENANCE_LABEL } from './weather-cube.js';
import { solarPosition } from './sun-altitude.js';

const SERIES_VARS = ['t2m', 'precip', 'cloudTotal'];
const TIP_VARS = ['t2m', 'precip', 'cloudTotal', 'wind', 'windDirDeg'];
const THUMB_PX = 14;                  // #tc-scrub thumb width (earth.html CSS)
const HOUR_MS = 3_600_000;
const NOW_REPAINT_MS = 5 * 60_000;    // "now" drifts ~1 px per hour on a desktop bar
const VERSION_POLL_MS = 1000;
const SUNSET_ALT_DEG = -0.833;        // refraction + semi-diameter

/**
 * @param {object} o
 * @param {HTMLElement} o.host           the #tc-strip element
 * @param {HTMLInputElement} o.scrubEl   the #tc-scrub range input
 * @param {import('./weather-cube.js').WeatherCube} o.cube
 * @param {() => ({lat:number, lon:number, label:string}|null)} o.getPlace
 * @param {() => number} [o.now]
 */
export function mountTimeStrip({ host, scrubEl, cube, getPlace, now = () => Date.now() }) {
    if (!host || !scrubEl || !cube) return null;

    const canvas = document.createElement('canvas');
    canvas.className = 'tc-strip-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    const cursor = document.createElement('div');
    cursor.className = 'tc-strip-cursor';
    const place = document.createElement('div');
    place.className = 'tc-strip-place';
    const tip = document.createElement('div');
    tip.className = 'tc-strip-tip';
    tip.hidden = true;
    tip.setAttribute('role', 'status');
    host.append(canvas, cursor, place, tip);
    host.setAttribute('role', 'group');
    host.setAttribute('aria-label', 'Weather timeline for the selected place. Drag to move through time.');

    const S = {
        model: null, domain: null, placeKey: '', version: -1, nowPx: NaN,
        lastPoll: 0, lastNowRepaint: 0, pending: false, dragging: false, cursorX: NaN,
        series: null,
    };

    function domainNow() {
        const n = now();
        return { t0: n + Number(scrubEl.min) * 60_000, t1: n + Number(scrubEl.max) * 60_000 };
    }

    /** Thumb travel of the native range input, in strip-local CSS px. */
    function track() {
        const hr = host.getBoundingClientRect();
        const sr = scrubEl.getBoundingClientRect();
        return { hr, x0: sr.left - hr.left + THUMB_PX / 2, x1: sr.right - hr.left - THUMB_PX / 2 };
    }

    function schedule() {
        if (S.pending) return;
        S.pending = true;
        requestAnimationFrame(() => { S.pending = false; paint(); });
    }

    function paint() {
        const { hr, x0, x1 } = track();
        const w = Math.round(hr.width), h = Math.round(hr.height);
        if (w < 40 || h < 8 || !(x1 > x0)) return;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
        }
        const domain = domainNow();
        const p = getPlace();
        const series = p ? cube.series(SERIES_VARS, p.lat, p.lon,
            Math.floor(domain.t0 / HOUR_MS) * HOUR_MS, domain.t1) : null;
        const model = stripModel({
            series: series ?? { t: new Float64Array(0), values: {} },
            coverage: cube.coverage(),
            domain, width: w, height: h, trackX0: x0, trackX1: x1,
            isNight: p ? (t) => solarPosition(new Date(t), p.lat, p.lon).altitudeDeg < SUNSET_ALT_DEG : null,
            dayStart: (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); },
        });
        S.model = model; S.domain = domain; S.series = series;
        S.version = cube.version;
        S.placeKey = p ? `${p.lat.toFixed(2)},${p.lon.toFixed(2)}` : '';
        S.nowPx = Math.round(timeToX(now(), domain, x0, x1));
        S.lastNowRepaint = now();
        draw(model, dpr, p);
        place.textContent = p ? p.label : 'Set a location to see its weather here';
        place.classList.toggle('empty', !p);
    }

    function draw(m, dpr, p) {
        const g = canvas.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, m.width, m.height);
        // night
        g.fillStyle = 'rgba(0,0,20,0.32)';
        for (const n of m.night) g.fillRect(n.x0, 0, Math.max(1, n.x1 - n.x0), m.plotBot);
        // cloud veil from the top (a third of the plot at 100 %)
        const veilH = (m.plotBot - m.plotTop) * 0.34;
        for (const c of m.cloud) {
            g.fillStyle = `rgba(200,210,225,${(0.10 + 0.32 * c.a).toFixed(3)})`;
            g.fillRect(c.x, m.plotTop, c.w + 0.5, veilH * c.a);
        }
        // day boundaries + labels
        g.strokeStyle = 'rgba(255,255,255,0.10)';
        g.lineWidth = 1;
        g.font = '600 8px ui-monospace, monospace';
        g.fillStyle = 'rgba(180,200,215,0.55)';
        g.textBaseline = 'top';
        for (const d of m.days) {
            const x = Math.round(d.x) + 0.5;
            g.beginPath(); g.moveTo(x, 0); g.lineTo(x, m.plotBot); g.stroke();
            if (m.labelDays) {
                const wd = new Date(d.t).toLocaleDateString(undefined, { weekday: 'narrow' });
                g.fillText(wd, x + 2, m.plotBot - 9);
            }
        }
        // precip bars
        g.fillStyle = 'rgba(80,160,255,0.85)';
        for (const b of m.precip) g.fillRect(b.x, b.y, b.w + 0.3, b.h);
        // temperature line
        g.lineWidth = 1.6;
        g.lineCap = 'round';
        for (const s of m.tempSegs) {
            g.strokeStyle = s.color;
            g.beginPath(); g.moveTo(s.x0, s.y0); g.lineTo(s.x1, s.y1); g.stroke();
        }
        // provenance band
        for (const b of m.bands) {
            g.fillStyle = b.color;
            g.fillRect(b.x0, b.y, Math.max(1, b.x1 - b.x0), b.h);
            if (b.stale) {
                g.fillStyle = 'rgba(0,0,0,0.45)';
                for (let x = Math.floor(b.x0); x < b.x1; x += 4) g.fillRect(x, b.y, 2, b.h);
            }
        }
        // now tick
        const nx = Math.round(timeToX(now(), S.domain, m.trackX0, m.trackX1)) + 0.5;
        g.strokeStyle = 'rgba(255,255,255,0.55)';
        g.beginPath(); g.moveTo(nx, 0); g.lineTo(nx, m.height); g.stroke();
        // temperature extremes, so the line has a scale
        if (m.range && p) {
            g.fillStyle = 'rgba(220,230,240,0.7)';
            g.font = '600 8px ui-monospace, monospace';
            g.textBaseline = 'top';
            const label = `${Math.round(m.range.dataMin)}…${Math.round(m.range.dataMax)}°C`;
            g.fillText(label, m.width - g.measureText(label).width - 3, 1);
        }
    }

    // ── per-frame: cursor + cheap invalidation checks ────────────────────
    function update(simMs) {
        const n = now();
        if (n - S.lastPoll > VERSION_POLL_MS) {
            S.lastPoll = n;
            const p = getPlace();
            const key = p ? `${p.lat.toFixed(2)},${p.lon.toFixed(2)}` : '';
            if (cube.version !== S.version || key !== S.placeKey || n - S.lastNowRepaint > NOW_REPAINT_MS) schedule();
        }
        if (!S.model || !S.domain) { if (!S.pending) schedule(); return; }
        const x = timeToX(simMs, domainNow(), S.model.trackX0, S.model.trackX1);
        if (!Number.isFinite(x)) return;
        const cx = Math.max(S.model.trackX0, Math.min(S.model.trackX1, x));
        // Written as !(… < 0.5) so the first call (cursorX = NaN) moves it.
        if (!(Math.abs(cx - S.cursorX) < 0.5)) {
            S.cursorX = cx;
            cursor.style.transform = `translateX(${cx.toFixed(1)}px)`;
        }
    }

    // ── drag to scrub (one path: the slider's own events) ────────────────
    function timeAtClientX(clientX) {
        const { hr, x0, x1 } = track();
        return xToTime(clientX - hr.left, domainNow(), x0, x1);
    }
    function scrubTo(clientX) {
        const t = timeAtClientX(clientX);
        const minutes = Math.round((t - now()) / 60_000);
        const v = Math.max(Number(scrubEl.min), Math.min(Number(scrubEl.max), minutes));
        if (String(v) !== scrubEl.value) {
            scrubEl.value = String(v);
            scrubEl.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    host.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        S.dragging = true;
        try { host.setPointerCapture(e.pointerId); } catch (_) { /* synthetic pointer */ }
        host.classList.add('dragging');
        scrubTo(e.clientX);
        showTip(e.clientX);
        e.preventDefault();
    });
    host.addEventListener('pointermove', (e) => {
        if (S.dragging) scrubTo(e.clientX);
        if (e.pointerType !== 'touch' || S.dragging) showTip(e.clientX);
    });
    const endDrag = (e) => {
        if (!S.dragging) return;
        S.dragging = false;
        host.classList.remove('dragging');
        try { host.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
        scrubEl.dispatchEvent(new Event('change', { bubbles: true }));
        if (e.pointerType === 'touch') tip.hidden = true;
    };
    host.addEventListener('pointerup', endDrag);
    host.addEventListener('pointercancel', endDrag);
    host.addEventListener('pointerleave', () => { if (!S.dragging) tip.hidden = true; });

    // ── hover readout ────────────────────────────────────────────────────
    function showTip(clientX) {
        const p = getPlace();
        const t = timeAtClientX(clientX);
        const tz = new Date(t).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const rel = relLabel(t - now());
        let line = 'no place selected', src = '';
        if (p) {
            const s = cube.sampleMany(TIP_VARS, p.lat, p.lon, t);
            if (!s || s.meta.held) {
                line = 'no weather data loaded for this hour';
            } else {
                const lab = PROVENANCE_LABEL[s.meta.provenance] ?? s.meta.provenance;
                const d = describeSample(s, lab);
                line = d.line;
                src = `${lab}${s.meta.source ? ` · ${s.meta.source}` : ''}${s.meta.stale ? ' · stale feed' : ''}`;
            }
        }
        tip.textContent = '';
        const head = document.createElement('div');
        head.className = 'tc-strip-tip-head';
        head.textContent = `${tz} · ${rel}${p ? ` · ${p.label}` : ''}`;
        const body = document.createElement('div');
        body.textContent = line;
        tip.append(head, body);
        if (src) {
            const foot = document.createElement('div');
            foot.className = 'tc-strip-tip-src';
            foot.textContent = src;
            tip.append(foot);
        }
        tip.hidden = false;
        const hr = host.getBoundingClientRect();
        const x = Math.max(0, Math.min(hr.width - tip.offsetWidth, clientX - hr.left - tip.offsetWidth / 2));
        tip.style.left = `${x}px`;
    }

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    ro?.observe(host);
    ro?.observe(scrubEl);
    schedule();

    return {
        update,
        refresh: schedule,
        /** Test / debug hook: the last model and what fed it. */
        debug: () => ({ model: S.model, domain: S.domain, version: S.version, place: getPlace() }),
    };
}

function relLabel(dt) {
    const a = Math.abs(dt);
    if (a < 30 * 60_000) return 'now';
    const h = a / HOUR_MS;
    const txt = h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(h < 240 ? 1 : 0)} d`;
    return dt < 0 ? `${txt} ago` : `in ${txt}`;
}
