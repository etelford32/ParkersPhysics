/**
 * live-volcanoes.js — the world's volcanoes on the Inner Earth live stage, in
 * step with the earthquake view. DOM + wiring only.
 *
 *   · the glyphs are js/earth-volcano-layer.js — the SAME layer EarthView
 *     draws, so status classes, colours, the live alert join and the eruption
 *     odds are js/volcano-engine.js's numbers on every page; only the Active
 *     group is shown by default (2 661 glyphs carpet the Pacific rim);
 *   · the wedge the stage cuts for an earthquake hides the volcanoes over it
 *     (`setClip` — the same {x·n̂ > 0, x·ê₂ > 0} test as the surface shader);
 *   · "today" is /api/volcanoes/activity (USGS HANS aviation colour codes +
 *     NASA EONET open events), refreshed every 30 min by the layer; a dead feed
 *     keeps the catalogue drawn and SAYS live status is unavailable — never a
 *     quiet planet;
 *   · the join with the quake feed is volcano-quakes.js (PURE): a quake within
 *     30 km of a Holocene volcano and shallower than 40 km is tagged NEAR it —
 *     a proximity flag, never a claim that it is volcanic.
 */
import * as THREE from 'three';
import { EarthVolcanoLayer } from '../earth-volcano-layer.js';
import { latLonToVec } from './stage.js';
import { volcanoNearQuake, quakesNearVolcano, liveVolcanoRows, NEAR_KM, NEAR_DEPTH_KM } from './volcano-quakes.js';
import { HAZARD_WINDOW_FROM } from '../volcano-engine.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtYear = (y) => (y == null ? 'unknown' : y < 0 ? `${-y} BCE` : `${y} CE`);
const pct = (p) => (p == null ? '—' : p < 0.001 ? '< 0.1 %' : `${(100 * p).toFixed(p < 0.1 ? 1 : 0)} %`);
const CC_COLOR = { RED: '#ff3b1f', ORANGE: '#ff8a3d', YELLOW: '#ffd23d', GREEN: '#5fd17a' };

export function mountLiveVolcanoes({ stage, getQuakes = () => [], selectQuake = () => {}, onChange = () => {} } = {}) {
    const S = { on: !/[?&]volcanoes=0\b/.test(location.search), selected: null, status: { state: 'idle' }, plane: null };
    const layer = new EarthVolcanoLayer(THREE, {
        geoToXYZ: (lat, lon) => latLonToVec(lat, lon),
        radius: 1.004,
        onStatus: (state, detail) => { S.status = { state, ...(detail ?? {}) }; render(); onChange(); },
    });
    layer.setGroupVisible('dormant', false);
    layer.setGroupVisible('inactive', false);
    stage?.scene.add(layer.group);
    stage?.onFrame((now) => {
        const pxScale = stage.renderer.domElement.height / (2 * Math.tan(stage.camera.fov * Math.PI / 360));
        layer.tick(now / 1000, pxScale);
    });
    stage?.addPicker((ray) => {
        if (!layer.visible) return null;
        const d = layer.getHovered(ray);
        return d ? { kind: 'volcano', index: d.index, html: probeHtml(d) } : null;
    });

    function setActive(on) { layer.setVisible(on && S.on); }
    function setSlice(plane) {
        S.plane = plane;
        if (plane) layer.setClip(plane.n, plane.e2); else layer.setClip(null);
    }
    function setOn(on) { S.on = !!on; layer.setVisible(S.on); render(); }

    const live = () => layer.live ?? new Map();
    const volcanoes = () => layer.cat?.volcanoes ?? [];

    function liveLine(lv) {
        if (!lv) return '';
        const src = [...new Set(lv.items.map((i) => (i.source === 'usgs-hans' ? 'USGS' : 'NASA EONET')))].join(' + ');
        return `<span class="ei-vlive">● ${lv.colorCode ? `aviation <b style="color:${CC_COLOR[lv.colorCode] ?? '#fff'}">${esc(lv.colorCode)}</b>` : 'open activity event'}${lv.alertLevel ? ` · ${esc(lv.alertLevel)}` : ''} · ${esc(src)}</span>`;
    }
    function probeHtml(d) {
        const v = d.volcano, last = d.last;
        return `<b>${esc(v.name)}</b> <span class="ei-muted">${esc(v.country ?? '')}</span>
            <span>${esc(d.statusLabel)} · last eruption ${fmtYear(last?.year)}${last?.vei != null ? ` (VEI ${last.vei})` : ''}</span>
            ${d.live ? liveLine(d.live) : ''}<span class="ei-muted">click for its card</span>`;
    }

    /** "near Kīlauea (12 km)" for a quake row or the event header — or ''. */
    function nearTag(quake, { long = false } = {}) {
        const hit = volcanoNearQuake(quake, volcanoes(), live());
        if (!hit) return '';
        const lv = hit.live ? ` <b class="ei-live">${hit.live.colorCode ? esc(hit.live.colorCode) : 'active today'}</b>` : '';
        return long
            ? `<span class="ei-vtag" title="Within ${NEAR_KM} km of a Holocene volcano and shallower than ${NEAR_DEPTH_KM} km — a proximity flag, not a determination that the earthquake is volcanic">▲ ${hit.km.toFixed(0)} km from <button type="button" class="ei-linkbtn" data-vidx="${hit.volcano.i}">${esc(hit.volcano.name)}</button>${lv}</span>`
            : `<span class="ei-vtag" title="Within ${NEAR_KM} km of this Holocene volcano">▲ near ${esc(hit.volcano.name)}${lv}</span>`;
    }

    function selectVolcano(i, { fly = true } = {}) {
        const v = volcanoes()[i]; if (!v) return;
        S.selected = i;
        layer.setHighlight(i);
        if (fly && stage) stage.flyToDirection(latLonToVec(v.lat, v.lon), { fill: 0.9 });
        render();
        $('#ei-vcard')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    function render() {
        const st = $('#ei-vstatus');
        if (st) {
            const s = S.status, f = layer.liveState;
            st.innerHTML = !S.on ? 'Volcanoes hidden on the globe — the list still works.'
                : s.state === 'error' ? `<span class="ei-warn">Volcano catalogue unavailable (${esc(s.error ?? 'error')})</span>`
                : !layer.cat ? 'Loading the GVP catalogue…'
                    : `${layer.cat.volcanoes.length.toLocaleString('en-US')} volcanoes (GVP ${esc(layer.cat.source?.version ?? '')}) · globe shows the <b>active</b> group · live status ${f.freshness === 'live' ? `from USGS HANS + NASA EONET${f.updated ? `, ${new Date(f.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}` : `<span class="ei-warn">${f.freshness ? 'partial or stale' : 'unavailable'}${f.reasons?.length ? ` (${esc(f.reasons.join(', '))})` : ''}</span>`}`;
        }
        const list = $('#ei-vlist');
        if (list) {
            const rows = layer.cat ? liveVolcanoRows(live(), getQuakes()) : [];
            list.innerHTML = rows.length ? rows.map((r) => `<tr data-vidx="${r.volcano.i}" tabindex="0" class="${r.volcano.i === S.selected ? 'is-sel' : ''}">
                    <td><span class="ei-cc" style="background:${CC_COLOR[r.colorCode] ?? '#5b6b88'}">${esc(r.colorCode ?? 'event')}</span></td>
                    <td><b>${esc(r.volcano.name)}</b><span class="ei-sub">${esc(r.volcano.country ?? '')}${r.openSince ? ` · open since ${new Date(r.openSince).toLocaleDateString([], { month: 'short', year: 'numeric' })}` : ''} · ${esc(r.sources.join(' + '))}</span></td>
                    <td class="ei-num">${r.nearbyQuakes ? `<b>${r.nearbyQuakes}</b>` : '<span class="ei-muted">0</span>'}</td></tr>`).join('')
                : `<tr><td colspan="3" class="ei-muted">${!layer.cat ? 'Loading…' : layer.liveState.freshness ? 'No volcano is listed as elevated or erupting today.' : 'Live volcano status unavailable — the catalogue is still drawn.'}</td></tr>`;
            const pickRow = (e) => { const tr = e.target.closest('tr[data-vidx]'); if (tr) selectVolcano(Number(tr.dataset.vidx)); };
            list.onclick = pickRow;
            list.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickRow(e); } };
        }
        renderCard();
    }

    function renderCard() {
        const host = $('#ei-vcard'); if (!host) return;
        const d = S.selected != null ? layer.describe(S.selected) : null;
        if (!d) { host.innerHTML = '<p class="ei-muted">Pick a volcano on the globe or in the list.</p>'; return; }
        const v = d.volcano, near = quakesNearVolcano(v, getQuakes());
        const p = S.plane, x = latLonToVec(v.lat, v.lon);
        const inWedge = p && x.dot(new THREE.Vector3(...p.n)) > 0 && x.dot(new THREE.Vector3(...p.e2)) > 0;
        host.innerHTML = `<div class="ei-colhead"><div><b>${esc(v.name)}</b> <span class="ei-muted">${esc([v.country, v.type].filter(Boolean).join(' · '))}</span></div>
                <a class="ei-btn" href="volcanoes.html?v=${encodeURIComponent(v.num)}">Open in Earth Volcanoes</a></div>
            <ul class="ei-mech-list">
                <li>${esc(d.statusLabel)} · last known eruption <b>${fmtYear(d.last?.year)}</b>${d.last?.vei != null ? ` (VEI ${d.last.vei})` : ''} · ${v.lat.toFixed(2)}°, ${v.lon.toFixed(2)}° · ${v.elev != null ? `${v.elev.toLocaleString('en-US')} m` : 'elevation unknown'}</li>
                ${d.live ? `<li>Today: ${liveLine(d.live)}</li>` : '<li class="ei-muted">Not listed as elevated or erupting today.</li>'}
                <li>Chance of a new eruption starting in 10 years: <b>${pct(d.p10)}</b> <span class="ei-muted">(its onsets since ${HAZARD_WINDOW_FROM}, shrunk toward all Holocene volcanoes — a base rate, not a forecast)</span></li>
                <li>${near.length ? `<b>${near.length}</b> feed earthquake${near.length === 1 ? '' : 's'} within ${NEAR_KM} km, shallower than ${NEAR_DEPTH_KM} km:` : `No feed earthquake within ${NEAR_KM} km in the feed window (M2.5+ past day, M4.5+ past week).`}</li>
                ${inWedge ? '<li class="ei-muted">It sits over the wedge cut out for the selected earthquake, so its glyph is hidden — pick another quake or switch to Structure to see it.</li>' : ''}
            </ul>
            ${near.length ? `<div class="ei-table-wrap"><table class="ei-table"><tbody>${near.slice(0, 12).map(({ quake: q, km }) => `<tr data-qid="${esc(q.id)}" tabindex="0"><td class="ei-num"><b>M${q.mag.toFixed(1)}</b></td><td>${esc(q.place ?? '')}<span class="ei-sub">${new Date(q.timeMs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${q.depthKm.toFixed(0)} km deep · ${km.toFixed(0)} km away</span></td></tr>`).join('')}</tbody></table></div>` : ''}`;
        host.querySelector('tbody')?.addEventListener('click', (e) => { const tr = e.target.closest('tr[data-qid]'); if (tr) selectQuake(tr.dataset.qid); });
    }

    // Clicks on the stage: a volcano glyph opens its card (the quake-dot pick runs in live-quakes).
    stage?.canvas.addEventListener('pointerup', (e) => {
        if (!layer.visible) return;
        const r = stage.canvas.getBoundingClientRect();
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), stage.camera);
        const d = layer.getHovered(ray);
        if (d) selectVolcano(d.index, { fly: false });
    });
    // A "▲ 12 km from X" button anywhere on the page opens that volcano.
    document.addEventListener('click', (e) => { const b = e.target.closest('[data-vidx].ei-linkbtn'); if (b) selectVolcano(Number(b.dataset.vidx)); });
    $('#ei-vtoggle')?.addEventListener('click', (e) => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', String(on)); setOn(on); });
    $('#ei-vtoggle')?.setAttribute('aria-pressed', String(S.on));

    if (!stage) layer.setVisible(true);          // no WebGL: nothing is drawn, but the list and cards still load
    render();
    return { setActive, setSlice, setOn, nearTag, render, selectVolcano, layer, state: S };
}
