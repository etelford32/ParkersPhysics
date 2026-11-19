/**
 * plates-layer.js — the stage's PLATES view: Bird's PB2002 plates, their
 * boundaries and how fast they move. Renderer + DOM only; the numbers are
 * plates.js / plates-model.js.
 *
 * The globe is drawn WHOLE (no cut — the plates are a surface story), each
 * plate faintly tinted (identity only), the 5,819 boundary steps coloured by
 * what the boundary does (or, on request, by the age of the seafloor there),
 * and arrows of each plate's velocity in the chosen frame: NO-NET-ROTATION
 * (default; the frame with no average spin of the lithosphere) or
 * PACIFIC-FIXED (Bird's own). Relative motion across a boundary is the same in
 * both — only the arrows change — and the probe says so.
 *
 * INSIDE (default on): the crust turns to glass and the plates are followed
 * DOWN — USGS Slab2's 27 subducting slabs at true depth, the 660 km
 * transition zone, and the live feed's hypocentres where they really are
 * (slab-layer.js over the PURE slabs.js). The probe then names the slab under
 * the pointer and, for an earthquake, where it sits relative to that slab.
 */
import * as THREE from 'three';
import { decodePlates, plateAt, plateVelocity, stepMotions, boundarySummary, STEP_CLASSES } from './plates.js';
import { FAMILY_STYLE, stepFamily, velocityArrows, nearestStep, depthAge, plateCentroids, plateRGBA, ARROW_DEG_PER_MM_YR } from './plates-model.js';
import { GlowLines } from './glow-lines.js';
import { latLonToVec } from './stage.js';
import { mountSlabLayer, DEPTH_RAMP, DEPTH_MAX_KM } from './slab-layer.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const AGE_RAMP = ['#fff3b0', '#f6b26b', '#d9663a', '#8c2d5a', '#3b1f5c'];   // young → old (0 → 180 Ma)
const ageColor = (a) => {
    const t = Math.min(1, Math.max(0, a / 180)) * (AGE_RAMP.length - 1), i = Math.min(AGE_RAMP.length - 2, Math.floor(t)), f = t - i;
    const p = hexRgb(AGE_RAMP[i]), q = hexRgb(AGE_RAMP[i + 1]);
    return p.map((v, k) => v + (q[k] - v) * f);
};
const compass = (az) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
const LABEL_MIN_KM2 = 8e6;

export async function loadPlates(fetchFn = fetch, url = 'data/earth-interior/plates-pb2002.json.gz') {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`PB2002: HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = buf[0] === 0x1f && buf[1] === 0x8b
        ? await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
        : new TextDecoder().decode(buf);
    return decodePlates(JSON.parse(text));
}

export function mountPlates({ stage, getQuakes = () => [] }) {
    const S = { active: false, model: null, error: null, frame: 'nnr', colorBy: 'kind', arrows: true, inside: !/[?&]slabs=0\b/.test(location.search), labels: [] };
    let slabs = null;
    const ensureSlabs = () => {
        if (!stage || slabs) return slabs;
        slabs = mountSlabLayer({ stage, getQuakes });
        slabs.state.onLoad = () => { renderHud(); renderSlabPanel(); fillSections(); };
        return slabs;
    };
    let bounds = null, arrows = null;
    if (stage) {
        bounds = new GlowLines({ width: 2.2, gain: 1.05 });
        arrows = new GlowLines({ width: 1.3, gain: 0.8 });
        for (const o of [bounds, arrows]) { o.mesh.visible = false; stage.scene.add(o.mesh); stage.onResize(({ w, h, dpr }) => o.setResolution(w, h, dpr)); }
        stage.onFrame(() => { if (S.active) placeLabels(); });
    }
    const P = (lat, lon, lift = 1.0035) => latLonToVec(lat, lon).multiplyScalar(lift).toArray();
    // With a cross-section open, a surface line must not hang over the removed quarter: split it there.
    const clipLines = (lines) => {
        if (!slabs?.state?.section) return lines;
        const out = [];
        for (const l of lines) {
            let cur = null;
            l.points.forEach((p, i) => {
                if (slabs.isRemoved(p)) { cur = null; return; }
                if (!cur) { cur = { ...l, points: [], colors: l.colors ? [] : undefined }; out.push(cur); }
                cur.points.push(p); if (l.colors) cur.colors.push(l.colors[i]);
            });
        }
        return out;
    };

    function drawBoundaries() {
        if (!stage || !S.model) return;
        const lines = [];
        let cur = null;
        for (const s of S.model.steps) {
            const col = S.colorBy === 'age' ? (s.ageMa == null ? [0.32, 0.34, 0.38] : ageColor(s.ageMa)) : hexRgb(FAMILY_STYLE[stepFamily(s)].hex);
            const cont = cur && Math.abs(cur.end[0] - s.lat1) < 1e-6 && Math.abs(cur.end[1] - s.lon1) < 1e-6;
            if (!cont) { cur = { points: [P(s.lat1, s.lon1)], colors: [col], end: null }; lines.push(cur); }
            cur.points.push(P(s.lat2, s.lon2)); cur.colors.push(col);
            cur.end = [s.lat2, s.lon2];
        }
        bounds.set(clipLines(lines));
    }
    function drawArrows() {
        if (!stage || !S.model) return;
        if (!S.arrows) { arrows.set([]); return; }
        const list = velocityArrows(S.model, S.frame, { plateAt });
        const lines = [];
        for (const a of list) {
            const c = [0.86, 0.92, 1.0], al = Math.min(1, 0.35 + a.speed / 90);
            lines.push({ points: a.shaft.map((p) => P(p.lat, p.lon, 1.006)), color: c, alpha: al });
            for (const h of a.head) lines.push({ points: h.map((p) => P(p.lat, p.lon, 1.006)), color: c, alpha: al });
        }
        arrows.set(clipLines(lines));
    }
    function makeLabels() {
        const layer = stage?.labelLayer; if (!layer) return;
        for (const l of S.labels) l.el.remove();
        const cents = plateCentroids(S.model);
        S.labels = S.model.plates.filter((p) => p.areaKm2 > LABEL_MIN_KM2).map((p) => {
            const el = document.createElement('div');
            el.className = 'ei-mlabel ei-plabel'; el.textContent = p.name;
            layer.appendChild(el);
            return { el, v: latLonToVec(cents[p.index].lat, cents[p.index].lon) };
        });
    }
    function placeLabels() {
        const w = stage.canvas.clientWidth, h = stage.canvas.clientHeight, cam = stage.camera.position.clone().normalize();
        for (const l of S.labels) {
            const front = l.v.dot(cam) > 0.25;
            l.el.style.display = front ? '' : 'none';
            if (!front) continue;
            const s = l.v.clone().multiplyScalar(1.01).project(stage.camera);
            l.el.style.transform = `translate(-50%, -50%) translate(${((s.x + 1) / 2 * w).toFixed(1)}px, ${((1 - s.y) / 2 * h).toFixed(1)}px)`;
        }
    }

    function renderHud() {
        const hud = $('#ei-platehud'); if (!hud) return;
        if (S.error) { hud.innerHTML = `<b>Tectonic plates</b><span>PB2002 unavailable (${esc(S.error)}).</span>`; return; }
        if (!S.model) { hud.innerHTML = '<b>Tectonic plates</b><span>Loading Bird (2003)…</span>'; return; }
        const pa = S.model.byId.get('PA').nnrPole;
        hud.innerHTML = `<b>Tectonic plates · PB2002</b><span>${S.model.plates.length} plates · arrows: ${S.frame === 'nnr' ? 'no-net-rotation frame' : 'Pacific held fixed'}</span>
            <span class="ei-muted">Pacific plate, NNR: ${pa.rateDegMa.toFixed(3)}°/Myr about ${Math.abs(pa.lat).toFixed(1)}°S ${pa.lon.toFixed(1)}°E</span>${insideLine()}`;
        const key = $('#ei-pkeys');
        if (key) key.innerHTML = S.colorBy === 'age'
            ? `<div class="ei-fkey"><span>Seafloor age at the boundary (Müller et al. 1997, via Bird)</span><i style="background:linear-gradient(90deg,${AGE_RAMP.join(',')})"></i><span class="ei-fkey-ends"><span>0</span><span>180 Ma</span></span></div>`
            : `<div class="ei-pfam">${Object.values(FAMILY_STYLE).map((f) => `<span><i style="background:${f.hex}"></i>${esc(f.label)}</span>`).join('')}</div>`;
        if (key && S.inside) key.innerHTML += `<div class="ei-fkey"><span>Slab surface and earthquake depth (Slab2 · USGS)</span><i style="background:linear-gradient(90deg,${DEPTH_RAMP.join(',')})"></i><span class="ei-fkey-ends"><span>0</span><span>${DEPTH_MAX_KM} km</span></span></div>`;
        const ak = $('#ei-parrowkey');
        if (ak) ak.textContent = S.arrows ? `Arrows: plate velocity (${S.frame === 'nnr' ? 'no-net-rotation' : 'Pacific-fixed'} frame), length ${ARROW_DEG_PER_MM_YR}° of arc per mm/yr — a display scale.` : '';
    }

    function insideLine() {
        if (!S.inside) return '';
        const st = slabs?.state;
        if (st?.error) return `<span>Slabs unavailable (${esc(st.error)}).</span>`;
        if (!st?.model) return '<span>Loading Slab2…</span>';
        if (st.section) {
            const x = st.section;
            return `<span>Cut across the <b>${esc(x.slab.name)}</b> slab along its own dip direction (toward ${x.azimuthDeg.toFixed(0)}°, ${x.dipDeg.toFixed(0)}° dip at ${x.anchor.depthKm.toFixed(0)} km): the wall shows its top surface down to ${Math.max(...x.profile.filter((p) => p.depthKm != null).map((p) => p.depthKm)).toFixed(0)} km on PREM density, the faint arc is the 660 km boundary.</span>`;
        }
        return `<span>Inside: ${st.model.slabs.length} subducting slabs (Slab2) · ${st.quakes.length} earthquakes at their true depth · crust drawn as glass</span>`;
    }

    // The slabs, as a table: how deep each goes, and what is above them.
    function renderSlabPanel() {
        const host = $('#ei-pslabs'), m = slabs?.state?.model; if (!host || !m) return;
        const rows = [...m.slabs].sort((a, b) => b.maxDepthKm - a.maxDepthKm).map((s) => `<tr><td><i class="ei-sw" style="background:${depthCss(s.maxDepthKm)}"></i>${esc(s.name)}</td><td class="ei-num">${s.maxDepthKm.toFixed(0)} km</td></tr>`).join('');
        host.innerHTML = `<h3 class="ei-h3">Where the plates go down</h3>
            <div class="ei-table-wrap ei-qlist-wrap"><table class="ei-table"><thead><tr><th>Slab (Slab2)</th><th class="ei-num">Deepest mapped</th></tr></thead><tbody>${rows}</tbody></table></div>
            <p class="ei-muted ei-small">USGS Slab2 (Hayes et al. 2018): the depth of the top of each subducting plate under 27 zones, mapped from earthquakes, seismic surveys and tomography, with a 1σ uncertainty per point (shown in the probe). We keep Slab2's own values on a 0.2° grid; they reproduce Slab2's published depth contours to a median 0.2 km. Slabs stop at or near the 660 km transition zone, drawn as a glass shell; four of them (Izu–Bonin, Kermadec, Manila, Solomon) fold back on themselves at depth, and those overturned parts are not drawn. Measured against the GVP volcano catalogue: under the 776 Holocene volcanoes that stand above a slab, its surface is a median 104 km down (half of them between 88 and 123 km) — the depth at which the sinking plate releases the water that melts the mantle above it. That is the classic arc result, and it falls out of two independent datasets here.</p>`;
    }
    const depthCss = (d) => { const t = Math.min(1, d / DEPTH_MAX_KM) * (DEPTH_RAMP.length - 1), i = Math.round(t); return DEPTH_RAMP[i]; };

    function renderPanel() {
        const host = $('#ei-ppanel'); if (!host || !S.model) return;
        const sum = boundarySummary(stepMotions(S.model));
        const order = ['OSR', 'CRB', 'OTF', 'CTF', 'SUB', 'OCB', 'CCB'];
        const rateLabel = (c) => (c === 'OSR' || c === 'CRB' ? 'opening' : c === 'OTF' || c === 'CTF' ? 'slip' : 'closing');
        const rows = order.filter((c) => sum[c]).map((c) => `<tr><td><i class="ei-sw" style="background:${FAMILY_STYLE[{ OSR: 'spreading', CRB: 'spreading', OTF: 'sliding', CTF: 'sliding', OCB: 'closing', CCB: 'closing', SUB: 'subduction' }[c]].hex}"></i>${esc(STEP_CLASSES[c])}</td><td class="ei-num">${Math.round(sum[c].lengthKm / 1000).toLocaleString()}k km</td><td class="ei-num">${sum[c].meanRate.toFixed(0)} mm/yr ${rateLabel(c)}</td></tr>`).join('');
        const big = [...S.model.plates].sort((a, b) => b.areaKm2 - a.areaKm2).slice(0, 12);
        const cents = plateCentroids(S.model);
        const prow = big.map((p) => {
            const c = cents[p.index], v = plateVelocity(p.wNnr, c.lat, c.lon);
            return `<tr><td>${esc(p.name)}</td><td class="ei-num">${(p.areaKm2 / 1e6).toFixed(1)}</td><td class="ei-num">${v.speed.toFixed(0)} ${compass(v.azimuth)}</td><td class="ei-num">${p.nnrPole.rateDegMa.toFixed(3)}</td></tr>`;
        }).join('');
        host.innerHTML = `<div class="ei-pgrid">
            <div><h3 class="ei-h3">Boundaries by what they do</h3><div class="ei-table-wrap"><table class="ei-table"><thead><tr><th>Kind</th><th class="ei-num">Length</th><th class="ei-num">Mean rate</th></tr></thead><tbody>${rows}</tbody></table></div>
                <p class="ei-muted ei-small">Rates are length-weighted means of the relative velocity across each boundary step (full spreading rate, not half), from the Euler poles.</p></div>
            <div><h3 class="ei-h3">The largest plates</h3><div class="ei-table-wrap"><table class="ei-table"><thead><tr><th>Plate</th><th class="ei-num">Mkm²</th><th class="ei-num" title="Speed at the plate's area centroid, no-net-rotation frame">mm/yr at centre</th><th class="ei-num" title="Rotation rate about its no-net-rotation Euler pole">°/Myr</th></tr></thead><tbody>${prow}</tbody></table></div></div>
        </div>${depthAgeChart()}`;
    }

    // The ocean floor: depth vs age along the transforms, against the plate-cooling curve.
    function depthAgeChart() {
        const d = depthAge(S.model), W = 560, H = 230, L = 52, R = 14, T = 12, B = 34;
        const xs = (a) => L + a / 180 * (W - L - R), ys = (m) => T + (m - 1500) / (7000 - 1500) * (H - T - B);
        const pts = d.points.map((p) => `<circle cx="${xs(p.age).toFixed(1)}" cy="${ys(p.depth).toFixed(1)}" r="1.6" class="ei-da-pt"/>`).join('');
        const curve = d.curve.map((p) => `${xs(p.age).toFixed(1)},${ys(p.depth).toFixed(1)}`).join(' ');
        const bins = d.bins.map((b) => `<circle cx="${xs(b.age).toFixed(1)}" cy="${ys(b.depth).toFixed(1)}" r="4" class="ei-da-bin"><title>${b.n} steps · median ${b.age} Ma, ${b.depth} m</title></circle>`).join('');
        const xt = [0, 30, 60, 90, 120, 150, 180].map((a) => `<text x="${xs(a)}" y="${H - 16}" class="ei-ticklab" text-anchor="middle">${a}</text>`).join('');
        const yt = [2000, 3000, 4000, 5000, 6000, 7000].map((m) => `<text x="${L - 6}" y="${ys(m) + 4}" class="ei-ticklab" text-anchor="end">${m / 1000}</text><line x1="${L}" x2="${W - R}" y1="${ys(m)}" y2="${ys(m)}" class="ei-gridline"/>`).join('');
        return `<h3 class="ei-h3">The ocean floor sinks as it ages</h3>
            <svg viewBox="0 0 ${W} ${H}" class="ei-dachart" role="img" aria-label="Seafloor depth against age along oceanic transform faults, with the plate-cooling curve">
                ${yt}${xt}<text x="${(L + W - R) / 2}" y="${H - 2}" class="ei-ticklab" text-anchor="middle">seafloor age, Myr</text>
                <text x="12" y="${(T + H - B) / 2}" class="ei-ticklab" text-anchor="middle" transform="rotate(-90 12 ${(T + H - B) / 2})">depth, km</text>
                ${pts}<polyline points="${curve}" class="ei-da-curve"/>${bins}
            </svg>
            <p class="ei-muted ei-small">Dots: depth (ETOPO5) and seafloor age (Müller et al. 1997) at each of Bird's ${d.points.length} oceanic-transform boundary steps; rings: medians. Line: the plate-cooling depth of Parsons &amp; Sclater (1977), d = 2.5 km + 0.35 km·√(age/Myr) to 70 Myr, flattening after. New seafloor is made hot and buoyant at the ridges and contracts as it cools. Transforms sit in fracture-zone troughs and are not a random sample of the seafloor, so read this as a comparison, not a fit. A global seafloor-age map (Seton et al. 2020, CC BY 4.0) is planned; its host is not reachable from our build machines yet.</p>`;
    }

    function fillSections() {
        const sel = $('#ei-psection'), m = slabs?.state?.model; if (!sel || !m) return;
        const opts = [...m.slabs].filter((x) => x.maxDepthKm >= 120).sort((a, b) => a.name.localeCompare(b.name));
        sel.innerHTML = '<option value="">Cut across a slab…</option>' + opts.map((x) => `<option value="${x.code}">${esc(x.name)} (to ${x.maxDepthKm.toFixed(0)} km)</option>`).join('');
        sel.disabled = false;
    }
    function openSection(code) {
        if (!stage) return;
        ensureSlabs();
        if (code && !S.inside) { S.inside = true; slabs.setVisible(true, { glass: false }); chips(); }
        const sec = slabs.setSection(code || null);
        const sel = $('#ei-psection'); if (sel) sel.value = sec ? code : '';
        S.section = sec;
        drawBoundaries(); drawArrows(); renderHud();
        if (!sec) { stage.flyToDirection(latLonToVec(8, 160), { fill: 0.92 }); slabs.setVisible(S.inside); }
    }

    function chips() {
        for (const b of document.querySelectorAll('[data-pframe]')) b.setAttribute('aria-pressed', String(b.dataset.pframe === S.frame));
        for (const b of document.querySelectorAll('[data-pcolor]')) b.setAttribute('aria-pressed', String(b.dataset.pcolor === S.colorBy));
        $('#ei-parrows')?.setAttribute('aria-pressed', String(S.arrows));
        $('#ei-pinside')?.setAttribute('aria-pressed', String(S.inside));
    }
    function wire() {
        for (const b of document.querySelectorAll('[data-pframe]')) b.addEventListener('click', () => { S.frame = b.dataset.pframe; chips(); drawArrows(); renderHud(); });
        for (const b of document.querySelectorAll('[data-pcolor]')) b.addEventListener('click', () => { S.colorBy = b.dataset.pcolor; chips(); drawBoundaries(); renderHud(); });
        $('#ei-parrows')?.addEventListener('click', () => { S.arrows = !S.arrows; chips(); drawArrows(); renderHud(); });
        $('#ei-pinside')?.addEventListener('click', () => {
            S.inside = !S.inside; chips();
            if (!S.inside && S.section) openSection(null);
            if (S.active && stage) { ensureSlabs(); slabs.setVisible(S.inside); }
            renderHud();
        });
        $('#ei-psection')?.addEventListener('change', (e) => openSection(e.target.value));
        chips();
    }

    async function ensureModel() {
        if (S.model || S.loading) return S.loading;
        S.loading = loadPlates().then((m) => {
            S.model = m;
            $('#ei-pstatus') && ($('#ei-pstatus').textContent = `PB2002 (Bird 2003): ${m.plates.length} plates, ${m.steps.length.toLocaleString()} boundary steps.`);
            drawBoundaries(); drawArrows(); makeLabels(); renderHud(); renderPanel(); renderSlabPanel();
            if (stage && S.active) stage.setSurfaceOverlay(plateRGBA(m), m.raster.nLon, m.raster.nLat);
            for (const l of S.labels) l.el.style.display = S.active ? '' : 'none';
        }).catch((err) => { S.error = err.message; renderHud(); $('#ei-pstatus') && ($('#ei-pstatus').textContent = `PB2002 unavailable: ${err.message}`); });
        return S.loading;
    }

    function setActive(on) {
        S.active = on;
        if (stage) {
            bounds.mesh.visible = arrows.mesh.visible = on;
            for (const l of S.labels) l.el.style.display = on ? '' : 'none';
            if (on) {
                stage.setCut('none');
                if (S.model) stage.setSurfaceOverlay(plateRGBA(S.model), S.model.raster.nLon, S.model.raster.nLat);
                // The western Pacific: the Ring of Fire's deepest slabs (Tonga, Izu–Bonin, Kuril) and the Pacific plate feeding them.
                stage.flyToDirection(latLonToVec(8, 160), { fill: 0.92 });
                if (S.inside) { ensureSlabs(); slabs.setVisible(true); }
            } else {
                if (S.section) { slabs.setSection(null); S.section = null; const sel = $('#ei-psection'); if (sel) sel.value = ''; }
                slabs?.setVisible(false);
                stage.setSurfaceOverlay(null);
                stage.setCut('octant');
            }
        }
        if (on) { renderHud(); ensureModel(); }
    }

    function probe(hit) {
        if (!S.active || !S.model || !hit) return null;
        if (hit.kind === 'hypocentre') return quakeProbe(hit);
        if (hit.kind !== 'surface') return null;
        const k = plateAt(S.model.raster, hit.lat, hit.lon), plate = S.model.plates[k];
        const v = plateVelocity(S.frame === 'nnr' ? plate.wNnr : plate.w, hit.lat, hit.lon);
        const near = nearestStep(S.model, hit.lat, hit.lon);
        let b = '';
        if (near && near.km < 400) {
            const m = near.motion, c = near.step.cls;
            const what = c === 'OSR' || c === 'CRB' ? `opening at ${Math.max(0, m.divergent).toFixed(0)} mm/yr`
                : c === 'OTF' || c === 'CTF' ? `sliding ${Math.abs(m.rightLateral).toFixed(0)} mm/yr ${m.rightLateral >= 0 ? 'right' : 'left'}-laterally`
                : `closing at ${Math.max(0, -m.divergent).toFixed(0)} mm/yr`;
            const down = near.down ? ` · the ${esc(near.down.name)} plate goes down` : '';
            const sea = near.step.ageMa != null ? ` · seafloor ${near.step.ageMa} Myr old, ${(-near.step.elevationM / 1000).toFixed(1)} km deep` : '';
            b = `<span>${near.km.toFixed(0)} km from the ${esc(near.step.left.name)}–${esc(near.step.right.name)} boundary: ${esc(near.className)}, ${what}${down}${sea}</span>`;
        }
        let under = '';
        const d = S.inside ? slabs?.describe(hit) : null;
        if (d?.beneath?.length) under = d.beneath.map((u) => `<span>Below: the ${esc(u.slab.name)} slab, its top ${u.depthKm.toFixed(0)} km down${Number.isFinite(u.uncKm) ? ` (±${u.uncKm.toFixed(0)} km)` : ''}</span>`).join('');
        return `<b>${esc(plate.name)} plate · ${Math.abs(hit.lat).toFixed(1)}°${hit.lat < 0 ? 'S' : 'N'} ${Math.abs(hit.lon).toFixed(1)}°${hit.lon < 0 ? 'W' : 'E'}</b>
            <span>Moving ${v.speed.toFixed(0)} mm/yr toward ${compass(v.azimuth)} (${v.azimuth.toFixed(0)}°) — ${S.frame === 'nnr' ? 'no-net-rotation frame' : 'relative to the Pacific plate'}</span>${b}${under}`;
    }

    function quakeProbe(hit) {
        const q = hit.quake, d = slabs?.describe(hit), c = d?.ctx;
        const when = Number.isFinite(q.timeMs) ? new Date(q.timeMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '';
        const rel = !c ? '<span>No Slab2 slab beneath it.</span>'
            : `<span>The ${esc(c.slab.name)} slab's top is ${c.slabDepthKm.toFixed(0)} km down here (±${Math.max(c.tolKm, 0).toFixed(0)} km): this hypocentre is ${c.relation === 'near' ? '<b>on the slab surface</b>, within that' : c.relation === 'above' ? `<b>${Math.abs(c.dzKm).toFixed(0)} km above it</b> (the plate above / mantle wedge)` : `<b>${c.dzKm.toFixed(0)} km below its top</b> (inside or under the slab)`}.</span>
               <span class="ei-muted">A comparison of depths, not a fault-type call — that needs the mechanism.</span>`;
        return `<b>M${(q.mag ?? 0).toFixed(1)} · ${esc(q.place ?? '')}</b><span>${q.depthKm.toFixed(0)} km deep · ${when}</span>${rel}`;
    }

    wire();
    renderHud();
    return { setActive, probe, openSection, get state() { return S; } };
}
