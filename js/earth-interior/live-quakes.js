/**
 * live-quakes.js — earth-interior.html's LIVE earthquake view (the default
 * stage mode). DOM + wiring only: every number is quake-model.js / phases.js
 * / ellipticity.js, computed in quake-worker.js.
 *
 *   · USGS's real-time feeds, polled (the day feed every minute, the week's
 *     larger events every 10 min), fetched browser-direct (CORS-enabled, no key);
 *   · the viewer's location is the SITE ONE store `ppx_user_location`
 *     (js/user-location.js) — the same place every other page reads; with
 *     none set the flagged NEIC fallback is used and the HUD says so;
 *   · the stage opens on the viewer: the slice through epicentre, viewer and
 *     centre, seen from above the viewer's side; the Earth never spins;
 *   · the clock is the WALL clock (waves drawn where they are right now) or a
 *     replay from the origin at ×1 / ×10 / ×60. Scrubbing pauses it.
 * A dead feed draws NO quake and says so — never a demo dressed as live.
 */

import { USGS_FEEDS, parseUsgsFeed, mergeQuakes, pickDefaultQuake, siteFromLocation, slicePlane, liveState, fmtDuration, WAVE_WINDOW_S, geoVec } from './quake-model.js';
import { seismicSliceTable } from './page-model.js';
import { loadUserLocation, saveUserLocation, geocodeQuery } from '../user-location.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KIND_LABEL = { direct: 'direct', upgoing: 'direct (up-going)', core: 'through the core', reflected: 'reflected', diffracted: 'diffracted along the core', depth: 'surface reflection near the source', multiple: 'surface bounce' };
const POLL_DAY_MS = 60_000, POLL_WEEK_MS = 600_000;

export function mountLiveQuakes({ stage, onActive = () => {} } = {}) {
    const S = {
        quakes: [], feeds: { day: null, week: null }, errors: {}, selected: null, reason: null, userPicked: false,
        site: siteFromLocation(loadUserLocation()), payload: null, list: new Map(), active: false,
        clock: { mode: 'live', speed: 1, anchorWall: 0, anchorT: 0, paused: false }, reqId: 0,
    };
    const worker = new Worker(new URL('./quake-worker.js', import.meta.url), { type: 'module' });
    let layer = null;
    if (stage) {
        import('./seismic-layer.js').then(({ SeismicLayer }) => {
            layer = new SeismicLayer(stage, { labelLayer: $('#ei-labels') });
            stage.onFrame((now) => tick(now));
            if (S.active) apply();
        });
    }

    worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'list') {
            if (m.ok) { S.list = new Map(m.rows.map((r) => [r.id, r])); renderList(); }
            return;
        }
        if (m.id !== S.reqId) return;                 // a newer selection superseded it
        if (!m.ok) { S.payload = null; $('#ei-arrivals-live').innerHTML = `<p class="ei-muted">Ray tracing failed: ${esc(m.error)}</p>`; return; }
        S.payload = m;
        renderArrivals(); apply();
    };

    // ── Feeds ──
    async function poll(which) {
        try {
            const r = await fetch(USGS_FEEDS[which], { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            S.feeds[which] = parseUsgsFeed(await r.json()); delete S.errors[which];
        } catch (err) { S.errors[which] = err.message || String(err); }
        S.quakes = mergeQuakes(S.feeds.day, S.feeds.week);
        if (!S.userPicked || !S.quakes.some((q) => q.id === S.selected?.id)) {
            const pick = pickDefaultQuake(S.quakes, Date.now());
            if (pick.quake?.id !== S.selected?.id) select(pick.quake, pick.reason, false);
        } else S.selected = S.quakes.find((q) => q.id === S.selected.id);   // a revision (location/depth/mag) replaces it
        requestList(); renderFeed(); renderList();
        if (!S.selected) renderHud(0, Date.now());       // the frame tick only runs with a quake; a dead feed must still say so
        layer?.setOthers(S.quakes.filter((q) => q.id !== S.selected?.id));
    }
    poll('week').then(() => poll('day'));
    setInterval(() => poll('day'), POLL_DAY_MS);
    setInterval(() => poll('week'), POLL_WEEK_MS);

    function requestList() {
        const qs = S.quakes.filter((q) => q.mag >= 4).slice(0, 60);
        worker.postMessage({ type: 'list', id: 0, quakes: qs, site: S.site });
    }

    function select(quake, reason = 'picked', byUser = true) {
        S.selected = quake ?? null; S.reason = reason; S.userPicked = byUser || S.userPicked; S.payload = null;
        S.clock = { mode: 'live', speed: 1, anchorWall: 0, anchorT: 0, paused: false };
        // An event whose waves have all arrived opens as a REPLAY from the origin; a live one tracks the wall clock.
        if (quake && (Date.now() - quake.timeMs) / 1000 > WAVE_WINDOW_S) S.clock = { mode: 'replay', speed: 10, anchorWall: Date.now(), anchorT: 0, paused: false };
        renderArrivals(); renderList(); renderTimebar();
        if (!quake) { apply(); return; }
        S.reqId++;
        worker.postMessage({ type: 'select', id: S.reqId, quake, site: S.site });
        if (S.active) aim();
    }

    // ── Location ──
    window.addEventListener('user-location-changed', (e) => {
        S.site = siteFromLocation(e.detail); renderSite(); requestList();
        if (S.selected) select(S.selected, S.reason, S.userPicked);
    });

    // ── Clock ──
    const tNow = (now) => {
        const c = S.clock;
        if (!S.selected) return 0;
        if (c.mode === 'live') return (now - S.selected.timeMs) / 1000;
        return c.paused ? c.anchorT : c.anchorT + (now - c.anchorWall) / 1000 * c.speed;
    };
    let lastHud = 0;
    function tick(now) {
        if (!S.active || !layer || !S.payload || !S.selected) return;
        let t = tNow(now);
        if (S.clock.mode === 'replay' && !S.clock.paused && t > WAVE_WINDOW_S) { S.clock.anchorT = 0; S.clock.anchorWall = now; t = 0; }   // replays loop
        layer.setTime(t);
        if (now - lastHud > 250) { lastHud = now; renderHud(t, now); }
    }

    function plane() { return S.selected ? slicePlane(S.selected, S.site) : null; }
    function aim() {
        const p = plane(); if (!p || !stage) return;
        // Open on the VIEWER: above the viewer's side of the slice, tilted so the cut face shows.
        const u = siteVec(), n = p.n;
        const dir = u.map((x, i) => 0.45 * x + 0.89 * n[i]);
        stage.flyToDirection(dir, { fill: 0.92 });
    }
    const siteVec = () => geoVec(S.site.lat, S.site.lon);

    function apply() {
        if (!stage || !layer) return;
        layer.setVisible(S.active);
        if (!S.active) { stage.setSlice(null); return; }
        const p = plane();
        stage.setSlice(p, seismicSliceTable());
        if (p && S.payload) layer.setScene({ quake: S.selected, site: S.site, plane: p, rays: S.payload.rays, fan: S.payload.fan, arrivals: S.payload.arrivals.rows });
        layer.setOthers(S.quakes.filter((q) => q.id !== S.selected?.id));
    }

    // ── DOM ──
    function renderFeed() {
        const n = S.quakes.length, errs = Object.entries(S.errors);
        const chip = $('#ei-qfeed');
        if (!chip) return;
        if (!n && errs.length) { chip.className = 'ei-status ei-status--down'; chip.innerHTML = `<span>●</span> USGS feed down — ${esc(errs[0][1])}. No earthquake is drawn.`; return; }
        chip.className = `ei-status ${errs.length ? 'ei-status--warn' : 'ei-status--ok'}`;
        chip.innerHTML = `<span>●</span> USGS real-time feed · ${n} events (M2.5+ day, M4.5+ week)${errs.length ? ` · ${errs.map(([k]) => k).join(', ')} feed down` : ''}`;
    }
    function renderSite() {
        $('#ei-site-name').textContent = S.site.name;
        $('#ei-site-name').classList.toggle('ei-flagged', !!S.site.fallback);
    }
    function localTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
    function localDateTime(ms) { return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

    function renderList() {
        const body = $('#ei-qlist'); if (!body) return;
        const now = Date.now();
        const qs = S.quakes.filter((q) => q.mag >= 4).slice(0, 40);
        if (!qs.length) { body.innerHTML = `<tr><td colspan="6" class="ei-muted">${S.quakes.length ? 'No M4+ events in the feed window.' : Object.keys(S.errors).length ? 'Feed down.' : 'Loading…'}</td></tr>`; return; }
        body.innerHTML = qs.map((q) => {
            const f = S.list.get(q.id), age = (now - q.timeMs) / 1000;
            const live = age >= 0 && age < WAVE_WINDOW_S && q.mag >= 4.5;
            return `<tr data-qid="${esc(q.id)}" class="${q.id === S.selected?.id ? 'is-sel' : ''}" tabindex="0">
                <td class="ei-num"><b>${q.mag.toFixed(1)}</b></td>
                <td>${esc(q.place ?? '—')}<span class="ei-sub">${localDateTime(q.timeMs)} · ${fmtDuration(age)} ago · ${q.depthKm.toFixed(0)} km deep${live ? ' · <b class="ei-live">waves in the Earth</b>' : ''}</span></td>
                <td class="ei-num">${f ? `${f.deltaDeg.toFixed(1)}°` : '…'}</td>
                <td class="ei-num">${f?.timeS != null ? `≈ ${fmtDuration(f.timeS)}<span class="ei-sub">${esc(f.phase)} at ${localTime(f.arriveMs)}</span>` : f ? '<span class="ei-muted">—</span>' : '…'}</td>
            </tr>`;
        }).join('');
        body.onclick = (e) => { const tr = e.target.closest('tr[data-qid]'); if (tr) select(S.quakes.find((q) => q.id === tr.dataset.qid)); };
        body.onkeydown = (e) => { const tr = e.target.closest('tr[data-qid]'); if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(S.quakes.find((q) => q.id === tr.dataset.qid)); } };
    }

    function renderArrivals() {
        const host = $('#ei-arrivals-live'); if (!host) return;
        const q = S.selected;
        if (!q) { host.innerHTML = '<p class="ei-muted">No earthquake selected.</p>'; return; }
        const head = `<div class="ei-colhead"><div><b>M${q.mag.toFixed(1)} ${esc(q.place ?? '')}</b> <span class="ei-muted">${new Date(q.timeMs).toISOString().replace('T', ' ').slice(0, 19)} UTC · ${q.depthKm.toFixed(1)} km deep${q.status ? ` · ${esc(q.status)}` : ''}</span></div>${q.url ? `<a class="ei-btn" href="${esc(q.url)}" target="_blank" rel="noopener">USGS event page</a>` : ''}</div>`;
        if (!S.payload) { host.innerHTML = `${head}<p class="ei-muted">Tracing rays through PREM…</p>`; return; }
        const { geometry, rows } = S.payload.arrivals, now = Date.now();
        host.innerHTML = `${head}
            <p class="ei-muted">${geometry.deltaDeg.toFixed(2)}° (${(geometry.deltaRad * 6371).toFixed(0)} km) from ${esc(S.site.name)} · times from the origin, with each phase's ellipticity correction</p>
            <div class="ei-table-wrap"><table class="ei-table"><thead><tr><th>Phase</th><th>Path</th><th class="ei-num">Travel time</th><th class="ei-num">Ellipticity</th><th class="ei-num">Arrives (local)</th><th class="ei-num">Status</th></tr></thead><tbody>
            ${rows.map((r) => `<tr><td><i class="ei-wave" style="background:${r.wave === 'S' ? '#d95926' : '#3987e5'}"></i><b>${esc(r.phase)}</b>${r.laterBranches ? ` <span class="ei-flag" title="A triplication: ${r.laterBranches} later branch arrival(s) of this phase">+${r.laterBranches}</span>` : ''}</td>
                <td>${esc(KIND_LABEL[r.kind] ?? r.kind)}</td>
                <td class="ei-num">${fmtDuration(r.totalS)}</td>
                <td class="ei-num">${r.corrS == null ? '—' : `${r.corrS >= 0 ? '+' : '−'}${Math.abs(r.corrS).toFixed(2)} s`}</td>
                <td class="ei-num">${localTime(r.arriveMs)}</td>
                <td class="ei-num">${r.arriveMs <= now ? '<span class="ei-muted">arrived</span>' : `in ${fmtDuration((r.arriveMs - now) / 1000)}`}</td></tr>`).join('')}
            </tbody></table></div>`;
    }

    function renderHud(t, now) {
        const hud = $('#ei-quakehud'); if (!hud) return;
        const q = S.selected;
        if (!q) { hud.innerHTML = `<b>No earthquake</b><span>${Object.keys(S.errors).length ? 'USGS feed down — nothing is drawn' : 'Waiting for the USGS feed…'}</span>`; return; }
        const rows = S.payload?.arrivals.rows ?? [];
        const ls = liveState(q, rows, now);
        const replay = S.clock.mode === 'replay';
        const at = q.timeMs + t * 1000;
        const next = rows.find((r) => r.totalS > t);
        hud.innerHTML = `<b>M${q.mag.toFixed(1)} · ${esc(q.place ?? '')}</b>
            <span>${replay ? `<b class="ei-replay">REPLAY ×${S.clock.speed}${S.clock.paused ? ' · paused' : ''}</b>` : ls.inFlight ? '<b class="ei-live">LIVE</b> waves in the Earth now' : '<b>LIVE</b> — every phase has arrived'} · ${fmtDuration(t)} after the origin</span>
            <span>${next ? `Next at ${esc(S.site.fallback ? 'NEIC' : 'you')}: <b>${esc(next.phase)}</b> in ${fmtDuration(next.totalS - t)}${replay ? '' : ` (${localTime(q.timeMs + next.totalS * 1000)})`}` : rows.length ? `All ${rows.length} phases have reached ${S.site.fallback ? 'NEIC' : 'you'}` : 'Tracing rays…'}</span>
            <span class="ei-muted">${replay ? `Replay clock ${new Date(at).toISOString().slice(11, 19)} UTC` : ''}${S.site.fallback ? ' Location not set — showing USGS NEIC, Golden CO.' : ''}</span>`;
        const sl = $('#ei-tscrub');
        if (sl && document.activeElement !== sl) sl.value = String(Math.max(0, Math.min(WAVE_WINDOW_S, t)));
        const tl = $('#ei-tlabel'); if (tl) tl.textContent = `${fmtDuration(Math.max(0, t))}`;
    }

    function renderTimebar() {
        const bar = $('#ei-timebar'); if (!bar) return;
        bar.querySelectorAll('[data-clock]').forEach((b) => {
            const v = b.dataset.clock;
            b.setAttribute('aria-pressed', String(v === 'live' ? S.clock.mode === 'live' : S.clock.mode === 'replay' && String(S.clock.speed) === v && !S.clock.paused));
        });
    }
    $('#ei-timebar')?.addEventListener('click', (e) => {
        const b = e.target.closest('[data-clock]'); if (!b) return;
        const now = Date.now(), v = b.dataset.clock;
        if (v === 'live') S.clock = { mode: 'live', speed: 1, anchorWall: 0, anchorT: 0, paused: false };
        else {
            const t0 = S.clock.mode === 'replay' ? tNow(now) : 0;
            S.clock = { mode: 'replay', speed: Number(v), anchorWall: now, anchorT: t0 > WAVE_WINDOW_S - 5 ? 0 : t0, paused: false };
        }
        renderTimebar();
    });
    $('#ei-tscrub')?.addEventListener('input', (e) => {
        S.clock = { mode: 'replay', speed: S.clock.speed > 1 ? S.clock.speed : 10, anchorWall: Date.now(), anchorT: Number(e.target.value), paused: true };
        renderTimebar();
    });

    // Location controls.
    $('#ei-site-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const qv = $('#ei-site-q').value.trim(); if (!qv) return;
        const msg = $('#ei-site-msg'); msg.textContent = 'Searching…';
        try {
            const loc = await geocodeQuery(qv);
            if (!loc) { msg.textContent = 'No place found.'; return; }
            saveUserLocation(loc); msg.textContent = '';
        } catch (err) { msg.textContent = `Search failed: ${err.message}`; }
    });
    $('#ei-site-gps')?.addEventListener('click', () => {
        const msg = $('#ei-site-msg');
        if (!navigator.geolocation) { msg.textContent = 'This browser has no location service.'; return; }
        msg.textContent = 'Asking the browser…';
        navigator.geolocation.getCurrentPosition(
            (p) => { saveUserLocation({ lat: p.coords.latitude, lon: p.coords.longitude, city: 'Your location' }); msg.textContent = ''; },
            (err) => { msg.textContent = `Location unavailable: ${err.message}`; },
            { timeout: 15_000, maximumAge: 600_000 });
    });

    // Stage picks of a surface quake dot.
    stage?.canvas.addEventListener('pointerup', (e) => {
        if (!S.active || !layer) return;
        const r = stage.canvas.getBoundingClientRect();
        const id = layer.pickQuake({ px: e.clientX - r.left, py: e.clientY - r.top });
        if (id) select(S.quakes.find((q) => q.id === id));
    });

    renderSite(); renderFeed(); renderList(); renderArrivals(); renderTimebar();
    setInterval(() => { renderList(); if (S.payload) renderArrivals(); }, 15_000);

    const api = {
        setActive(on) { S.active = on; apply(); if (on) aim(); onActive(on); },
        get state() { return S; },
        select: (id) => select(S.quakes.find((q) => q.id === id)),
    };
    return api;
}

