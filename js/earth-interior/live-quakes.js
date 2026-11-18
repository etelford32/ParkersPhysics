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
 *     replay from the origin at ×1 / ×10 / ×60. Scrubbing pauses it;
 *   · the selected event's MECHANISM comes from its USGS detail record
 *     (properties.detail, browser-direct): the moment-tensor product, else a
 *     focal mechanism (radiation.js parseMechanism). When it lands the event is
 *     re-traced with its own radiation pattern; none published ⇒ the
 *     focal-sphere average, and the panel says which.
 * A dead feed draws NO quake and says so — never a demo dressed as live.
 */

import { USGS_FEEDS, parseUsgsFeed, mergeQuakes, pickDefaultQuake, siteFromLocation, slicePlane, liveState, fmtDuration, WAVE_WINDOW_S, geoVec, siteWithElevation } from './quake-model.js';
import { tileXY, tileSampler, demPath, TILE_PX } from '../climalytix/terrain.js';
import { seismicSliceTable } from './page-model.js';
import { loadUserLocation, saveUserLocation, geocodeQuery } from '../user-location.js';
import { parseMechanism } from './radiation.js';
import { drawBeachball } from './beachball-view.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const KIND_LABEL = { direct: 'direct', upgoing: 'direct, up-going', core: 'through the core', reflected: 'reflected', diffracted: 'along the core', depth: 'near-source bounce', multiple: 'surface bounce' };
const POLL_DAY_MS = 60_000, POLL_WEEK_MS = 600_000;
// On an exact nodal plane the point-source amplitude is a numerical zero (−320 dB); a few degrees of
// take-off error put it tens of dB higher, so anything below this floor is shown as a bound, never a number.
const DB_FLOOR = -60;

export function mountLiveQuakes({ stage, onActive = () => {} } = {}) {
    const S = {
        quakes: [], feeds: { day: null, week: null }, errors: {}, selected: null, reason: null, userPicked: false,
        site: siteFromLocation(loadUserLocation()), payload: null, list: new Map(), active: false,
        clock: { mode: 'live', speed: 1, anchorWall: 0, anchorT: 0, paused: false }, reqId: 0,
        mechs: new Map(),                      // event id → { state: 'loading'|'ok'|'none'|'error', mech, note }
    };
    const worker = new Worker(new URL('./quake-worker.js', import.meta.url), { type: 'module' });
    let layer = null;
    if (stage) {
        import('./seismic-layer.js').then(({ SeismicLayer }) => {
            layer = new SeismicLayer(stage, { labelLayer: $('#ei-labels') });
            S.layer = layer;   // the browser gate and the perf probe read lastBuildMs
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

    // The quake the worker traces carries its mechanism (only the decomposed numbers it needs).
    function trace() {
        const q = S.selected; if (!q) return;
        const m = S.mechs.get(q.id);
        const mechanism = m?.state === 'ok' ? { mHat: m.mech.mHat } : null;
        S.reqId++;
        worker.postMessage({ type: 'select', id: S.reqId, quake: { ...q, mechanism }, site: S.site });
    }
    async function loadMechanism(q) {
        if (!q?.detail || S.mechs.has(q.id)) { if (!q?.detail && q && !S.mechs.has(q.id)) S.mechs.set(q.id, { state: 'none', note: 'no USGS detail record' }); return; }
        S.mechs.set(q.id, { state: 'loading' });
        let entry;
        try {
            const r = await fetch(q.detail, { signal: AbortSignal.timeout(20_000) });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const mech = parseMechanism(await r.json());
            entry = mech.kind ? { state: 'ok', mech } : { state: 'none', note: mech.reason };
        } catch (err) { entry = { state: 'error', note: err.message || String(err) }; }
        S.mechs.set(q.id, entry);
        if (S.selected?.id !== q.id) return;
        renderArrivals();
        if (entry.state === 'ok') trace();
    }

    function select(quake, reason = 'picked', byUser = true) {
        S.selected = quake ?? null; S.reason = reason; S.userPicked = byUser || S.userPicked; S.payload = null;
        S.clock = { mode: 'live', speed: 1, anchorWall: 0, anchorT: 0, paused: false };
        // An event whose waves have all arrived opens as a REPLAY from the origin; a live one tracks the wall clock.
        if (quake && (Date.now() - quake.timeMs) / 1000 > WAVE_WINDOW_S) S.clock = { mode: 'replay', speed: 10, anchorWall: Date.now(), anchorT: 0, paused: false };
        renderArrivals(); renderList(); renderTimebar();
        if (!quake) { apply(); return; }
        trace(); loadMechanism(quake);
        if (S.active) aim();
    }

    // ── Location ──
    window.addEventListener('user-location-changed', (e) => {
        S.site = siteFromLocation(e.detail); renderSite(); requestList();
        if (S.selected) select(S.selected, S.reason, S.userPicked);
        elevate();
    });

    // The station's elevation, from the SAME Terrain Tiles route Climalytix reads
    // (/api/climalytix/dem, one z-11 tile, ~80 m pixels). When it lands, the selected
    // event is re-traced with the elevation correction; when it cannot be read the
    // site says "elevation unknown" and no correction is applied — never 0.
    async function readTile(z, x, y) {
        const r = await fetch(demPath({ z, x, y }), { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`DEM HTTP ${r.status}`);
        const bmp = await createImageBitmap(await r.blob());
        const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(TILE_PX, TILE_PX) : Object.assign(document.createElement('canvas'), { width: TILE_PX, height: TILE_PX });
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(bmp, 0, 0, TILE_PX, TILE_PX);
        return g.getImageData(0, 0, TILE_PX, TILE_PX).data;
    }
    async function elevate() {
        const want = S.site, z = 11;
        let h = null;
        try {
            const t = tileXY(want.lat, want.lon, z), tiles = new Map();
            const need = new Set();
            for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
                const px = t.x * TILE_PX + dx, py = t.y * TILE_PX + dy;
                need.add(`${Math.floor(px / TILE_PX) % (2 ** z)},${Math.floor(py / TILE_PX)}`);
            }
            await Promise.all([...need].map(async (k) => { const [x, y] = k.split(',').map(Number); tiles.set(k, await readTile(z, x, y)); }));
            h = tileSampler(z, (zz, x, y) => tiles.get(`${x},${y}`) ?? null)(want.lat, want.lon);
        } catch { h = null; }
        if (S.site !== want) return;                         // the viewer moved meanwhile
        S.site = siteWithElevation(want, h);
        renderSite();
        if (S.selected) trace();
    }
    elevate();

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
        // 0.62 / 0.78: the cut face still reads, and the lit globe behind it shows as a body, not a sliver.
        const dir = u.map((x, i) => 0.62 * x + 0.78 * n[i]);
        stage.flyToDirection(dir, { fill: 0.9 });
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
        const el = $('#ei-site-elev');
        if (el) el.textContent = S.site.elevationNote ? `· ${S.site.elevationNote}` : '· elevation loading…';
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
        const { geometry, rows, radiationSource } = S.payload.arrivals, now = Date.now();
        const byMech = radiationSource === 'mechanism';
        host.innerHTML = `${head}
            ${mechanismBlock(q, rows, byMech)}
            <p class="ei-muted">${geometry.deltaDeg.toFixed(2)}° (${(geometry.deltaRad * 6371).toFixed(0)} km) from ${esc(S.site.name)} · times from the origin with ellipticity${S.payload.arrivals.elevationKm != null ? ` and station elevation (${Math.round(S.payload.arrivals.elevationKm * 1000).toLocaleString('en-US')} m)` : ''} corrected · strength = ray-theory amplitude against the strongest arrival in the same band, ${byMech ? 'with <b>this event’s radiation pattern</b>' : 'with the focal-sphere <b>average</b> radiation (no mechanism yet)'}</p>
            <div class="ei-table-wrap"><table class="ei-table"><thead><tr><th>Phase</th><th>Path</th><th>Strength</th><th class="ei-num">Travel time</th><th class="ei-num" title="Ellipticity + station elevation">Corrections</th><th class="ei-num">Arrives (local)</th><th class="ei-num">Status</th></tr></thead><tbody>
            ${rows.map((r) => `<tr class="${r.strength === 'very weak' ? 'ei-faint' : ''}"><td><i class="ei-wave" style="background:${r.recorded === 'S' ? '#d95926' : '#3987e5'}" title="Recorded as ${r.recorded === 'S' ? 'S (horizontal)' : 'P (vertical)'}"></i><b>${esc(r.phase)}</b>${r.laterBranches ? ` <span class="ei-flag" title="A triplication: ${r.laterBranches} later branch arrival(s) of this phase">+${r.laterBranches}</span>` : ''}</td>
                <td>${esc(KIND_LABEL[r.kind] ?? r.kind)}</td>
                <td>${strengthCell(r)}</td>
                <td class="ei-num">${fmtDuration(r.totalS)}</td>
                <td class="ei-num">${corrCell(r)}</td>
                <td class="ei-num">${localTime(r.arriveMs)}</td>
                <td class="ei-num">${r.arriveMs <= now ? '<span class="ei-muted">arrived</span>' : `in ${fmtDuration((r.arriveMs - now) / 1000)}`}</td></tr>`).join('')}
            </tbody></table></div>`;
        const cv = host.querySelector('#ei-beachball');
        const m = S.mechs.get(q.id);
        if (cv && m?.state === 'ok') {
            const marks = byMech ? rows.filter((r) => r.radiation).map((r) => ({ phase: r.phase, recorded: r.recorded, takeoffRad: r.radiation.takeoffRad, azimuthRad: r.radiation.azimuthRad })) : [];
            drawBeachball(cv, m.mech.mHat, marks);
        }
    }

    const f0 = (x) => `${Math.round(x)}°`;
    function mechanismBlock(q, rows, byMech) {
        const m = S.mechs.get(q.id);
        if (!m || m.state === 'loading') return '<p class="ei-muted ei-mech-note">Fetching this event’s focal mechanism from USGS…</p>';
        if (m.state !== 'ok') {
            const why = m.state === 'error' ? `USGS detail unavailable (${esc(m.note)})` : 'No moment tensor or focal mechanism published for this event yet (USGS usually publishes one for larger events, roughly M5 and up, within hours)';
            return `<p class="ei-muted ei-mech-note">${why} — strengths use the focal-sphere average, so a station near a nodal plane may see far less than listed.</p>`;
        }
        const x = m.mech, [a, b] = x.planes;
        const P = rows.find((r) => r.phase === 'P' || r.phase === 'p');
        const pol = P?.polarity ? `<li>First motion of <b>${esc(P.phase)}</b> here: <b>${P.polarity === 'up' ? 'up (compression)' : 'down (dilatation)'}</b>${P.nearNodal ? ' — near a nodal plane, so it may read either way' : ''}</li>` : '';
        const nodal = rows.filter((r) => r.nearNodal).map((r) => r.phase);
        return `<div class="ei-mech">
            <canvas id="ei-beachball" role="img" aria-label="Focal mechanism: nodal planes ${f0(a.strike)}/${f0(a.dip)}/${f0(a.rake)} and ${f0(b.strike)}/${f0(b.dip)}/${f0(b.rake)}"></canvas>
            <div><b>${esc(mechType(a))}</b> <span class="ei-muted">· ${x.kind === 'tensor' ? 'moment tensor' : 'focal mechanism (double couple)'}${x.source ? ` · ${esc(x.source)}` : ''}${x.method ? ` · ${esc(x.method)}` : ''}</span>
            <ul class="ei-mech-list">
                <li>Nodal planes (strike/dip/rake) <b>${f0(a.strike)}/${f0(a.dip)}/${f0(a.rake)}</b> and <b>${f0(b.strike)}/${f0(b.dip)}/${f0(b.rake)}</b></li>
                ${x.mw ? `<li>M0 ${x.m0.toExponential(2)} N·m · Mw ${x.mw.toFixed(2)}${x.kind === 'tensor' ? ` · ${Math.round(Math.max(0, x.percentDC))} % double couple` : ''}</li>` : ''}
                ${pol}
                ${nodal.length ? `<li class="ei-warn">Near a nodal plane at this station: <b>${nodal.map(esc).join(', ')}</b> — predicted weak, but a few degrees of take-off error swings it far in dB</li>` : ''}
            </ul>
            <span class="ei-muted">Lower hemisphere, equal area, north up; shaded = compression. Dots: where each arrival’s ray leaves the focus (<span style="color:#3987e5">●</span> recorded as P, <span style="color:#d95926">○</span> as S; up-going rays at their antipode). Point source, PREM take-offs.</span></div>
        </div>`;
    }
    // A plain-language class from the rake (Frohlich-style bins on one plane — a label, not a measurement).
    function mechType(pl) {
        const r = ((pl.rake + 180) % 360 + 360) % 360 - 180;
        if (Math.abs(r) <= 30 || Math.abs(r) >= 150) return 'Strike-slip fault';
        if (r >= 60 && r <= 120) return 'Thrust (reverse) fault';
        if (r <= -60 && r >= -120) return 'Normal fault';
        return r > 0 ? 'Oblique thrust' : 'Oblique normal fault';
    }

    function strengthCell(r) {
        if (r.db == null) return `<span class="ei-muted" title="${esc(r.ampReason ?? '')}">${/caustic|focus/.test(r.ampReason ?? '') ? 'focused — not sized' : /diffract/.test(r.ampReason ?? '') ? 'diffracted — fades' : '—'}</span>`;
        const w = Math.max(4, Math.min(100, (r.db + 60) / 60 * 100)), dbTxt = r.db < DB_FLOOR ? `< ${DB_FLOOR} dB` : `${Math.round(r.db) || 0} dB`;
        const band = r.recorded === 'S' ? 'S band · 0.2 Hz' : 'P band · 1 Hz';
        const extra = (r.nearNodal ? ' <span class="ei-flag" title="Near a nodal plane of this event: predicted weak, but sensitive to the take-off angle">nodal</span>' : '')
            + (r.polarity ? ` <span class="ei-pol" title="First motion: ${r.polarity === 'up' ? 'up (compression)' : 'down (dilatation)'}">${r.polarity === 'up' ? '↑' : '↓'}</span>` : '');
        return `<span class="ei-strength" title="${dbTxt} against the strongest ${band} arrival"><span class="ei-sbar"><span style="width:${w.toFixed(0)}%;background:${r.recorded === 'S' ? '#d95926' : '#3987e5'}"></span></span>${esc(r.strength)} <span class="ei-muted">${dbTxt}</span>${extra}</span>`;
    }
    const sgn = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`;
    function corrCell(r) {
        const parts = [];
        if (r.corrS != null) parts.push(`<span title="Ellipticity">${sgn(r.corrS)}</span>`);
        if (r.elevS != null) parts.push(`<span title="Station elevation">${sgn(r.elevS)}</span>`);
        return parts.length ? `${parts.join(' ')} s` : '—';
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

