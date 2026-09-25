/**
 * climate-lab/lab-satellites.js — SAT-01, the dashboard's satellite tracker.
 * ═══════════════════════════════════════════════════════════════════════════
 * A watch list of satellites, their live sub-points and ground tracks on the
 * lab's day/night map, and the passes over the HOME STATION for the next
 * 72 h — which ones you can actually see — with a sky chart of each pass.
 *
 * ONE PROPAGATOR, AND WHICH ONE IS A MEASURED CHOICE. Positions, ground
 * tracks, passes and sky charts all come from ONE propagator (PROPAGATOR
 * below) through geo/coords.js + pass-predictor.js `nextPasses` — the
 * modules the 3D tracker and earth.html's ISS card use. It is the SGP4 WASM
 * (the `sgp4` crate since 2026-09-24, pinned to every Vallado et al. 2006
 * verification row by tests/sgp4-vallado.mjs), with the Kepler + J2 JS path
 * only if the WASM cannot load. Until that date the WASM was a broken
 * hand-rolled SGP4 — 5 260 km off at epoch on Vallado case 00005, 49-minute
 * ISS passes — and this module ran on Kepler + J2 instead ('kepler-j2' is
 * kept as the switch). ONE propagator per session is load-bearing: a pass
 * predicted by one and drawn by the other collapsed the sky chart to a
 * point, and tracker.propagate silently uses the JS path until the WASM has
 * arrived — so loadKit WAITS for the WASM load to settle (capped at
 * WASM_WAIT_MS) before anything is computed. Everything is lazy-imported on mount; TLEs come
 * from the existing `/api/celestrak/tle?norad=` edge route (2 h cache).
 *
 * WHAT IS HONEST ABOUT REMINDERS. `notify_sat_pass` exists as a column but
 * the alert engine's rule is a stub that never fires (surveyed 2026-09-24),
 * so this card does NOT offer "email me before a pass". Its pass reminder is
 * in-browser — a notification (or an on-page banner) while the tab is open —
 * and the label says exactly that.
 *
 * The map uses the EMPHASIS form: the selected satellite in the accent, the
 * rest as labelled context — never a generated hue per satellite.
 */

import { createWorldMap } from './lab-map.js';
import { skyDomeSvg, esc } from './lab-charts.js';
import { loadPrefs, savePrefs, normalizePrefs, PREFS_EVENT, MAX_SATELLITES } from './lab-prefs.js';
import { footprintPoints, shortSatName, orbitalSpeedKms, R_EARTH_KM } from './lab-sat-geo.js';
import { issMagEstimate } from '../verdict-engine.js';
import { compass16 } from '../sun-altitude.js';
import { loadUserLocation } from '../user-location.js';

const MIN = 60_000, HOUR = 3_600_000;
const PASS_HORIZON_H = 72;
const PASS_RECALC_MS = 10 * MIN;
const QUICK_PICKS = Object.freeze([
    [25544, 'ISS'], [48274, 'Tiangong'], [20580, 'Hubble'],
    [43013, 'NOAA-20'], [25994, 'Terra'], [49260, 'Landsat 9'],
]);
const REMIND_KEY = 'pp_lab_pass_reminded';
/** 'sgp4-wasm' (satellite-tracker.js propagate) | 'kepler-j2' (jsFallbackPropagate). See header. */
const PROPAGATOR = 'sgp4-wasm';
/** Longest the kit waits for the SGP4 WASM before settling on Kepler + J2. */
const WASM_WAIT_MS = 6000;
const ISS = 25544;

let _kit = null;
/** The orbit toolkit, loaded once: three (for geo's Vector3), geo, one propagator, passes. */
function loadKit() {
    if (_kit) return _kit;
    _kit = Promise.all([
        import('three'), import('../geo/coords.js'), import('../satellite-tracker.js'), import('../pass-predictor.js'),
    ]).then(async ([THREE, coords, tracker, pp]) => {
        let propagate = tracker.jsFallbackPropagate;
        if (PROPAGATOR === 'sgp4-wasm') {
            // Settle the WASM load FIRST so every pass, track and sky chart
            // this session comes from the same propagator (see header).
            await Promise.race([tracker.whenWasmSettled(), new Promise((r) => setTimeout(r, WASM_WAIT_MS))]);
            if (tracker.isWasmLoaded()) propagate = tracker.propagate;
        }
        return {
            THREE, geo: coords.geo, RAD: coords.RAD,
            propagate, tleEpochToJd: tracker.tleEpochToJd,
            nextPasses: (tle, obs, opts) => pp.nextPasses(tle, obs, { ...opts, propagate }),
            lookAngle: pp.lookAngle,
        };
    });
    return _kit;
}

const _tle = new Map();   // norad → Promise<record|null>
function fetchTle(id) {
    if (_tle.has(id)) return _tle.get(id);
    const p = fetch(`/api/celestrak/tle?norad=${encodeURIComponent(id)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => (Array.isArray(j?.satellites) && j.satellites[0]) || null)
        .catch(() => null);
    _tle.set(id, p);
    p.then((rec) => { if (!rec) _tle.delete(id); });   // allow a retry later
    return p;
}

export function mountSatelliteTracker({ host } = {}) {
    if (!host) throw new Error('satellite tracker: host missing');
    host.innerHTML = `
    <header class="cl-module-head">
        <span class="cl-code">SAT-01</span>
        <h2 class="cl-module-title" id="cl-sat-title">Satellite tracker</h2>
        <span class="cl-led" data-role="led" data-state="loading" aria-hidden="true"></span>
        <span class="cl-head-meta" data-role="meta">Loading orbits…</span>
    </header>
    <div class="cl-sat-grid">
        <figure class="cl-map-figure cl-sat-map">
            <canvas class="cl-map cl-map-lg" data-role="map" aria-label="World map with tracked satellites, their ground tracks and the selected satellite's visibility circle"></canvas>
            <figcaption class="cl-caption">Live positions from the latest CelesTrak elements (Kepler + J2 propagation) over NASA Blue Marble (archival) · the ring is where the selected satellite is above the horizon</figcaption>
        </figure>
        <div class="cl-sat-side">
            <div class="cl-sat-list" data-role="list" role="list"></div>
            <div class="cl-sat-add">
                <label class="cl-visually-hidden" for="cl-sat-q">Add a satellite by NORAD number or name</label>
                <input class="cl-input" id="cl-sat-q" data-role="q" type="text" maxlength="40" autocomplete="off" placeholder="Add by NORAD # or name…">
                <button type="button" class="cl-btn" data-role="add">＋</button>
            </div>
            <div class="cl-sat-results" data-role="results"></div>
            <div class="cl-sat-picks" data-role="picks"></div>
        </div>
    </div>
    <div class="cl-sat-detail" data-role="detail"></div>
    <div class="cl-sat-remind" data-role="remind"></div>`;
    const q = (role) => host.querySelector(`[data-role="${role}"]`);

    const S = {
        prefs: loadPrefs(), kit: null,
        recs: new Map(),            // norad → TLE record
        pos: new Map(),             // norad → {lat, lon, altKm, speedKms}
        tracks: new Map(),          // norad → [{lat, lon}]
        passes: new Map(),          // norad → Pass[]
        passesAt: 0, passesFor: null,
        selected: null, selectedPass: 0,
        map: null, error: null,
        reminded: new Set((() => { try { return JSON.parse(sessionStorage.getItem(REMIND_KEY) || '[]'); } catch { return []; } })()),
    };
    const home = () => {
        const l = loadUserLocation();
        return l && Number.isFinite(l.lat) && Number.isFinite(l.lon) ? l : null;
    };

    // ── Orbit math (through the site's one SGP4 path) ─────────────────────
    const scratch = {};
    function subPoint(rec, ms) {
        const K = S.kit;
        const jd = ms / 86400000 + 2440587.5;
        const t = K.propagate(rec, (jd - K.tleEpochToJd(rec)) * 1440);
        scratch.eci ??= new K.THREE.Vector3(); scratch.ecef ??= new K.THREE.Vector3();
        scratch.eci.set(t.x, t.y, t.z);
        K.geo.eciToEcef(scratch.eci, K.geo.greenwichSiderealTimeFromJD(jd), scratch.ecef);
        const ll = K.geo.positionToLatLon(scratch.ecef);
        const r = ll.radiusUnits;
        return { lat: ll.lat * K.RAD, lon: ll.lon * K.RAD, altKm: r - R_EARTH_KM, speedKms: orbitalSpeedKms(r, rec.sma_km) };
    }
    function groundTrack(rec, ms) {
        const period = Number(rec.period_min) || 95;
        const half = Math.min(period, 200) / 2;
        const pts = [];
        for (let m = -half; m <= half; m += 1) {
            try { pts.push(subPoint(rec, ms + m * MIN)); } catch { pts.push(null); }
        }
        return pts;
    }
    function skyTrack(rec, pass) {
        const K = S.kit, out = [];
        const home0 = home();
        if (!home0) return out;
        const t0 = pass.rise.time.getTime(), t1 = pass.set.time.getTime();
        for (let t = t0; t <= t1; t += 15_000) {
            const jd = t / 86400000 + 2440587.5;
            const teme = K.propagate(rec, (jd - K.tleEpochToJd(rec)) * 1440);
            const la = K.lookAngle(teme, home0, K.geo.greenwichSiderealTimeFromJD(jd));
            out.push({ azDeg: la.azimuthDeg, elDeg: la.elevationDeg });
        }
        return out;
    }

    // ── Rendering ─────────────────────────────────────────────────────────
    const fmtWhen = (d) => d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    const relIn = (ms) => {
        const m = Math.round(ms / MIN);
        if (m < 1) return 'now';
        if (m < 60) return `in ${m} min`;
        const h = Math.floor(m / 60);
        return h < 24 ? `in ${h} h ${String(m % 60).padStart(2, '0')} m` : `in ${Math.floor(h / 24)} d ${h % 24} h`;
    };
    function nextOf(id, visibleOnly = false) {
        const now = Date.now();
        return (S.passes.get(id) || []).find((p) => p.set.time.getTime() > now && (!visibleOnly || p.visible)) || null;
    }
    const visBadge = (p) => p.visible
        ? '<span class="cl-chip" data-tone="good"><span class="cl-chip-icon" aria-hidden="true">✦</span>Visible</span>'
        : !p.observerDark ? '<span class="cl-chip" data-tone="neutral"><span class="cl-chip-icon" aria-hidden="true">☀</span>Daylight</span>'
        : '<span class="cl-chip" data-tone="neutral"><span class="cl-chip-icon" aria-hidden="true">◐</span>In Earth’s shadow</span>';

    function renderList() {
        const el = q('list');
        const ids = S.prefs.satellites;
        if (!ids.length) { el.innerHTML = '<div class="cl-empty">No satellites tracked — add one below.</div>'; return; }
        el.innerHTML = ids.map((id) => {
            const rec = S.recs.get(id), p = S.pos.get(id);
            const name = rec ? shortSatName(rec.name) : `NORAD ${id}`;
            const nx = nextOf(id), nv = nextOf(id, true);
            const line = !rec ? (S.recs.has(id) ? 'Orbit unavailable' : 'Loading orbit…')
                : !home() ? 'Set a home station for passes'
                : nv ? `Next visible ${relIn(nv.rise.time - Date.now())} · ${Math.round(nv.peak.elDeg)}° high`
                : nx ? `Next pass ${relIn(nx.rise.time - Date.now())} (not visible) · ${Math.round(nx.peak.elDeg)}°`
                : `No pass above 10° in ${PASS_HORIZON_H} h`;
            return `<div class="cl-sat${S.selected === id ? ' is-selected' : ''}" role="listitem">
                <button type="button" class="cl-sat-main" data-sat="${id}" aria-pressed="${S.selected === id}">
                    <span class="cl-sat-name">${esc(name)} <span class="cl-muted cl-mono">#${id}</span></span>
                    <span class="cl-sat-stats cl-mono">${p ? `${Math.round(p.altKm).toLocaleString()} km · ${p.speedKms.toFixed(2)} km/s` : ''}</span>
                    <span class="cl-sat-next">${esc(line)}</span>
                </button>
                <button type="button" class="cl-btn cl-btn-icon" data-remove="${id}" aria-label="Stop tracking ${esc(name)}">×</button>
            </div>`;
        }).join('');
    }

    function renderPicks() {
        const have = new Set(S.prefs.satellites);
        const picks = QUICK_PICKS.filter(([id]) => !have.has(id));
        q('picks').innerHTML = picks.length && S.prefs.satellites.length < MAX_SATELLITES
            ? `<span class="cl-muted cl-small">Quick add</span>${picks.map(([id, n]) => `<button type="button" class="cl-place" data-pick="${id}">${esc(n)}</button>`).join('')}`
            : '';
    }

    function renderDetail() {
        const el = q('detail');
        const id = S.selected;
        const rec = id != null ? S.recs.get(id) : null;
        if (!rec) { el.innerHTML = ''; return; }
        const hm = home();
        const passes = (S.passes.get(id) || []).filter((p) => p.set.time.getTime() > Date.now());
        if (!hm) { el.innerHTML = '<div class="cl-empty">Set a home station to predict passes over it.</div>'; return; }
        if (!passes.length) {
            el.innerHTML = `<h3 class="cl-sub">${esc(rec.name)} over ${esc(hm.city || 'home')}</h3><div class="cl-empty">No pass reaches 10° above your horizon in the next ${PASS_HORIZON_H} hours${(rec.inclination ?? 90) < Math.abs(hm.lat) - 5 ? ' — its orbit is inclined too low to rise this far from the equator' : ''}.</div>`;
            return;
        }
        const sel = Math.min(S.selectedPass, passes.length - 1);
        const P = passes[sel];
        const rows = passes.slice(0, 8).map((p, i) => {
            const mag = id === ISS && p.visible ? ` · mag ≈ ${issMagEstimate(p.peak.rangeKm).toFixed(1)}` : '';
            return `<tr class="${i === sel ? 'is-selected' : ''}">
                <th scope="row"><button type="button" class="cl-linkbtn" data-pass="${i}" aria-pressed="${i === sel}">${esc(fmtWhen(p.rise.time))}</button></th>
                <td>${Math.round(p.durationMin)} min</td>
                <td>${Math.round(p.peak.elDeg)}°</td>
                <td>${compass16(p.rise.azDeg)} → ${compass16(p.set.azDeg)}</td>
                <td>${visBadge(p)}${mag}</td>
            </tr>`;
        }).join('');
        let dome = '';
        try { dome = skyDomeSvg(skyTrack(rec, P), { label: `${rec.name} pass at ${fmtWhen(P.rise.time)}` }); } catch {}
        el.innerHTML = `<h3 class="cl-sub">${esc(rec.name)} over ${esc(hm.city || 'home')} · next ${PASS_HORIZON_H} h</h3>
        <div class="cl-sat-detail-grid">
            <div class="cl-table-wrap"><table class="cl-table cl-pass-table">
                <caption class="cl-visually-hidden">Upcoming passes; select one to draw its sky track</caption>
                <thead><tr><th scope="col">Rises</th><th scope="col">Lasts</th><th scope="col">Max elev.</th><th scope="col">Path</th><th scope="col">Sky</th></tr></thead>
                <tbody>${rows}</tbody></table></div>
            <figure class="cl-dome-fig">${dome}
                <figcaption class="cl-caption">Sky chart looking up: rim = horizon, centre = overhead. Peak ${Math.round(P.peak.elDeg)}° in the ${compass16(P.peak.azDeg)} at ${esc(P.peak.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))}.</figcaption>
            </figure>
        </div>
        <p class="cl-small cl-muted">“Visible” = the satellite is sunlit while your sky is dark (sun more than 6° below the horizon), tested at the pass peak. Times come from Kepler + J2 propagation of the latest elements: good to seconds today, drifting toward a minute by day three.</p>`;
    }

    function renderRemind() {
        const r = S.prefs.passReminder;
        const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
        q('remind').innerHTML = `<label class="cl-switch"><input type="checkbox" data-role="remind-on" ${r.on ? 'checked' : ''}><span class="cl-switch-ui" aria-hidden="true"></span>
            <span class="cl-alert-name">Remind me before ${r.visibleOnly ? 'visible ' : ''}passes</span></label>
            <label class="cl-thr"><select data-role="remind-lead">${[5, 10, 15, 30].map((m) => `<option value="${m}" ${r.leadMin === m ? 'selected' : ''}>${m} min before</option>`).join('')}</select></label>
            <label class="cl-thr"><input type="checkbox" data-role="remind-vis" ${r.visibleOnly ? 'checked' : ''}> visible only</label>
            <span class="cl-muted cl-small">In this browser while the dashboard is open${perm === 'denied' || perm === 'unsupported' ? ' (as an on-page banner — browser notifications are unavailable)' : ''}. Not emailed.</span>`;
    }

    function drawMap() {
        if (!S.map) return;
        const sel = S.selected;
        S.map.setOverlay((ctx, api) => {
            const dpr = api.dpr;
            // Context tracks first, the selected one last and on top.
            const order = [...S.prefs.satellites].sort((a, b) => (a === sel) - (b === sel));
            for (const id of order) {
                const tr = S.tracks.get(id);
                if (!tr) continue;
                ctx.lineWidth = (id === sel ? 2 : 1) * dpr;
                ctx.strokeStyle = id === sel ? 'rgba(255,176,102,0.95)' : 'rgba(210,225,240,0.35)';
                api.path(tr); ctx.stroke();
            }
            const p = S.pos.get(sel);
            if (p) {
                ctx.lineWidth = 1.5 * dpr;
                ctx.strokeStyle = 'rgba(255,176,102,0.75)';
                api.path(footprintPoints(p.lat, p.lon, p.altKm));
                ctx.stroke();
            }
            const hm = home();
            if (hm) {
                const h = api.project(hm.lat, hm.lon);
                ctx.beginPath(); ctx.arc(h.x, h.y, 6 * dpr, 0, Math.PI * 2); ctx.fillStyle = 'rgba(4,8,18,0.85)'; ctx.fill();
                ctx.beginPath(); ctx.arc(h.x, h.y, 4.5 * dpr, 0, Math.PI * 2); ctx.fillStyle = '#5fffd0'; ctx.fill();
            }
            ctx.font = `${11 * dpr}px system-ui, sans-serif`;
            for (const id of order) {
                const pos = S.pos.get(id), rec = S.recs.get(id);
                if (!pos || !rec) continue;
                const c = api.project(pos.lat, pos.lon), isSel = id === sel;
                ctx.beginPath(); ctx.arc(c.x, c.y, (isSel ? 6 : 4.5) * dpr, 0, Math.PI * 2); ctx.fillStyle = 'rgba(4,8,18,0.9)'; ctx.fill();
                ctx.beginPath(); ctx.arc(c.x, c.y, (isSel ? 4.5 : 3) * dpr, 0, Math.PI * 2);
                ctx.fillStyle = isSel ? '#ffb066' : '#dfe9f5'; ctx.fill();
                const label = shortSatName(rec.name);
                const tx = Math.min(c.x + 8 * dpr, ctx.canvas.width - ctx.measureText(label).width - 4 * dpr);
                ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(4,8,18,0.85)';
                ctx.strokeText(label, tx, c.y - 6 * dpr);
                ctx.fillStyle = isSel ? '#ffd9b0' : 'rgba(230,238,248,0.9)';
                ctx.fillText(label, tx, c.y - 6 * dpr);
            }
        });
    }

    function renderMeta() {
        const hm = home();
        const n = S.prefs.satellites.length;
        q('meta').textContent = S.error ? S.error
            : `${n} tracked${hm ? ` · passes over ${hm.city || 'home'}, next ${PASS_HORIZON_H} h` : ''}`;
        q('led').dataset.state = S.error ? 'error' : S.kit ? 'live' : 'loading';
    }

    function renderAll() {
        const safe = (fn) => { try { fn(); } catch (e) { console.warn('[climate-lab] satellite render failed:', e); } };
        safe(renderMeta); safe(renderList); safe(renderPicks); safe(renderDetail); safe(renderRemind); safe(drawMap);
    }

    // ── Data ──────────────────────────────────────────────────────────────
    function tickPositions() {
        if (!S.kit) return;
        const now = Date.now();
        for (const id of S.prefs.satellites) {
            const rec = S.recs.get(id);
            if (!rec) continue;
            try { S.pos.set(id, subPoint(rec, now)); } catch { S.pos.delete(id); }
        }
    }
    let lastTrackAt = 0;
    function refreshTracks(force = false) {
        if (!S.kit || (!force && Date.now() - lastTrackAt < MIN)) return;
        lastTrackAt = Date.now();
        for (const id of S.prefs.satellites) {
            const rec = S.recs.get(id);
            if (rec) { try { S.tracks.set(id, groundTrack(rec, lastTrackAt)); } catch {} }
        }
    }
    /** Passes are the expensive part: one satellite per idle slice. Resolves
     *  once every satellite is done and the list/detail have re-rendered. */
    function recomputePasses() {
        const hm = home();
        if (!S.kit || !hm) { S.passes.clear(); return Promise.resolve(); }
        S.passesAt = Date.now();
        S.passesFor = `${hm.lat.toFixed(3)},${hm.lon.toFixed(3)}`;
        const ids = S.prefs.satellites.filter((id) => S.recs.get(id));
        const idle = window.requestIdleCallback || ((f) => setTimeout(f, 16));
        return new Promise((resolve) => {
            const step = (i) => {
                if (i >= ids.length) { renderList(); renderDetail(); resolve(); return; }
                const id = ids[i];
                try {
                    S.passes.set(id, S.kit.nextPasses(S.recs.get(id), { lat: hm.lat, lon: hm.lon },
                        { from: new Date(), horizonH: PASS_HORIZON_H, minPeakDeg: 10, maxPasses: 12 }));
                } catch { S.passes.set(id, []); }
                idle(() => step(i + 1));
            };
            step(0);
        });
    }

    async function loadRecords() {
        await Promise.all(S.prefs.satellites.map(async (id) => {
            if (S.recs.get(id)) return;
            const rec = await fetchTle(id);
            S.recs.set(id, rec);   // null = unavailable (rendered as such)
        }));
        if (!S.selected || !S.prefs.satellites.includes(S.selected)) S.selected = S.prefs.satellites[0] ?? null;
        tickPositions(); refreshTracks(true); recomputePasses(); renderAll();
    }

    function checkReminders() {
        const r = S.prefs.passReminder;
        if (!r.on) return;
        const now = Date.now();
        for (const id of S.prefs.satellites) {
            for (const p of S.passes.get(id) || []) {
                const dt = p.rise.time.getTime() - now;
                if (dt < 0 || dt > r.leadMin * MIN || (r.visibleOnly && !p.visible)) continue;
                const key = `${id}@${Math.floor(p.rise.time.getTime() / MIN)}`;
                if (S.reminded.has(key)) continue;
                S.reminded.add(key);
                try { sessionStorage.setItem(REMIND_KEY, JSON.stringify([...S.reminded].slice(-100))); } catch {}
                const name = shortSatName(S.recs.get(id)?.name || `#${id}`);
                const msg = `${name} rises ${relIn(dt)} in the ${compass16(p.rise.azDeg)}, peaking ${Math.round(p.peak.elDeg)}° in the ${compass16(p.peak.azDeg)}.`;
                let shown = false;
                if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
                    try { new Notification(`${name} pass${p.visible ? ' — visible' : ''}`, { body: msg, tag: key }); shown = true; } catch {}
                }
                if (!shown) {
                    const b = document.createElement('div');
                    b.className = 'cl-toast'; b.setAttribute('role', 'status');
                    b.textContent = `🛰 ${msg}`;
                    document.body.appendChild(b);
                    setTimeout(() => b.remove(), 20_000);
                }
            }
        }
    }

    // ── Events ────────────────────────────────────────────────────────────
    function commit(mut, action) {
        const p = normalizePrefs(S.prefs); mut(p); S.prefs = savePrefs(p);
        import('../telemetry.js').then((m) => m.telemetry?.recordFeature?.('climate_lab', action)).catch(() => {});
    }
    async function addSat(id) {
        id = Number.parseInt(id, 10);
        if (!Number.isInteger(id) || id <= 0) return;
        if (S.prefs.satellites.includes(id)) { S.selected = id; renderAll(); return; }
        if (S.prefs.satellites.length >= MAX_SATELLITES) { q('results').textContent = `Tracking the maximum of ${MAX_SATELLITES}.`; return; }
        q('results').textContent = 'Fetching orbit…';
        const rec = await fetchTle(id);
        if (!rec) { q('results').textContent = `No current orbit for NORAD ${id}.`; return; }
        q('results').textContent = '';
        S.recs.set(id, rec); S.selected = id;
        commit((p) => { p.satellites.push(id); }, 'sat_add');
    }
    async function search() {
        const text = q('q').value.trim();
        if (!text) return;
        if (/^\d{1,9}$/.test(text)) { await addSat(text); q('q').value = ''; return; }
        const out = q('results');
        out.textContent = 'Searching…';
        try {
            const r = await fetch(`/api/celestrak/tle?search=${encodeURIComponent(text)}`);
            const j = r.ok ? await r.json() : null;
            const sats = (j?.satellites || []).slice(0, 8);
            out.innerHTML = sats.length
                ? sats.map((s) => `<button type="button" class="cl-place" data-pick="${Number(s.norad_id)}">${esc(shortSatName(s.name))} <span class="cl-mono cl-muted">#${Number(s.norad_id)}</span></button>`).join('')
                : 'No satellite by that name.';
            for (const s of sats) if (!_tle.has(Number(s.norad_id))) _tle.set(Number(s.norad_id), Promise.resolve(s));
        } catch { out.textContent = 'Search is unavailable right now.'; }
    }
    q('add').addEventListener('click', search);
    q('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
    host.addEventListener('click', (e) => {
        const t = e.target;
        const pick = t.closest?.('[data-pick]');
        if (pick) { addSat(pick.dataset.pick); q('q').value = ''; return; }
        const rm = t.closest?.('[data-remove]');
        if (rm) {
            const id = Number(rm.dataset.remove);
            commit((p) => { p.satellites = p.satellites.filter((x) => x !== id); }, 'sat_remove');
            if (S.selected === id) S.selected = null;
            return;
        }
        const sel = t.closest?.('[data-sat]');
        if (sel) { S.selected = Number(sel.dataset.sat); S.selectedPass = 0; renderAll(); return; }
        const ps = t.closest?.('[data-pass]');
        if (ps) { S.selectedPass = Number(ps.dataset.pass); renderDetail(); }
    });
    host.addEventListener('change', async (e) => {
        const role = e.target.dataset.role;
        if (role === 'remind-on') {
            const on = e.target.checked;
            if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
                try { await Notification.requestPermission(); } catch {}
            }
            commit((p) => { p.passReminder.on = on; }, 'pass_reminder');
        } else if (role === 'remind-lead') commit((p) => { p.passReminder.leadMin = Number(e.target.value); }, 'pass_reminder_lead');
        else if (role === 'remind-vis') commit((p) => { p.passReminder.visibleOnly = e.target.checked; }, 'pass_reminder_vis');
    });

    window.addEventListener(PREFS_EVENT, (ev) => {
        const before = S.prefs.satellites.join(',');
        S.prefs = ev.detail?.prefs || loadPrefs();
        if (S.prefs.satellites.join(',') !== before) loadRecords(); else renderAll();
    });
    window.addEventListener('user-location-changed', () => { recomputePasses(); renderAll(); });

    // ── Boot ──────────────────────────────────────────────────────────────
    try { S.map = createWorldMap(q('map')); } catch (e) { console.info('[climate-lab] satellite map unavailable:', e?.message || e); }
    renderAll();
    loadKit().then((k) => { S.kit = k; return loadRecords(); }).catch((e) => {
        S.error = 'Orbit toolkit failed to load';
        console.warn('[climate-lab] orbit kit failed:', e);
        renderAll();
    });

    // 1 Hz positions while on screen; tracks every minute; passes every 10 min.
    let onScreen = true;
    const io = typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((es) => { onScreen = es.some((x) => x.isIntersecting); }) : null;
    io?.observe(host);
    let ticks = 0;
    const timer = setInterval(() => {
        ticks++;
        if (document.hidden || !S.kit) return;
        if (Date.now() - S.passesAt > PASS_RECALC_MS) recomputePasses();
        checkReminders();
        if (!onScreen) return;
        tickPositions(); refreshTracks(); S.map?.draw();
        if (ticks % 30 === 0) renderList();   // relative "in N min" labels
    }, 1000);

    return {
        get state() { return S; },
        /** Re-run the pass search now (the browser gate uses it after the SGP4
         *  WASM has loaded — see tests/dashboard-climate-lab.spec.js). */
        recompute: () => recomputePasses(),
        destroy() { clearInterval(timer); io?.disconnect(); S.map?.destroy(); },
    };
}
