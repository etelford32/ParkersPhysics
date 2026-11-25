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
 * SURFACE: the plates tinted for identity (default), or the AGE OF THE OCEAN FLOOR everywhere —
 * Seton et al. (2020), baked by scripts/build-seafloor-age.mjs and read through the PURE
 * seafloor-age.js. The boundaries' "seafloor age" colouring and the age surface share ONE ramp
 * (seafloor-age.js AGE_RAMP), so a ridge and the floor beside it read the same for the same age.
 * The grid is fetched on first use of the age surface or of the probe on this view, never at boot.
 *
 * INSIDE (default on): the crust turns to glass and the plates are followed
 * DOWN — USGS Slab2's 27 subducting slabs at true depth, the 660 km
 * transition zone, and the live feed's hypocentres where they really are
 * (slab-layer.js over the PURE slabs.js). The probe then names the slab under
 * the pointer and, for an earthquake, where it sits relative to that slab.
 */
import * as THREE from 'three';
import { decodePlates, plateAt, plateVelocity, stepMotions, boundarySummary, stepGeometry, STEP_CLASSES } from './plates.js';
import { FAMILY_STYLE, stepFamily, velocityArrows, nearestStep, depthAge, plateCentroids, plateRGBA, ARROW_DEG_PER_MM_YR } from './plates-model.js';
import { GlowLines } from './glow-lines.js';
import { latLonToVec } from './stage.js';
import { mountSlabLayer, DEPTH_RAMP, DEPTH_MAX_KM } from './slab-layer.js';
import { loadSeafloorAge, ageAt, ageRGBA, ageColor, areaAgeDistribution, AGE_RAMP, AGE_RAMP_MAX_MYR } from './seafloor-age.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
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
    const S = { active: false, model: null, error: null, frame: 'nnr', colorBy: 'kind', arrows: true, inside: !/[?&]slabs=0\b/.test(location.search), labels: [],
        surface: /[?&]psurface=age\b/.test(location.search) ? 'age' : 'plates', age: null, ageError: null, ageLoading: null, ageRgba: null };
    // The ocean-floor age grid (Seton et al. 2020): loaded on first need, never at boot.
    const ensureAge = () => {
        if (S.age || S.ageLoading) return S.ageLoading;
        S.ageLoading = loadSeafloorAge().then(({ meta, grid }) => {
            S.age = { meta, grid, dist: areaAgeDistribution(grid) };
            applySurface(); renderHud(); renderPanel();
        }).catch((err) => { S.ageError = err.message; renderHud(); renderPanel(); });
        return S.ageLoading;
    };
    const applySurface = () => {
        if (!stage || !S.active) return;
        if (S.surface === 'age') {
            if (!S.age) { stage.setSurfaceOverlay(null); ensureAge(); return; }
            S.ageRgba = S.ageRgba || ageRGBA(S.age.grid);
            stage.setSurfaceOverlay(S.ageRgba, 1800, 900);
        } else if (S.model) stage.setSurfaceOverlay(plateRGBA(S.model), S.model.raster.nLon, S.model.raster.nLat);
    };
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
            ? `<div class="ei-fkey"><span>Seafloor age at the boundary (Müller et al. 1997, via Bird)</span><i style="background:linear-gradient(90deg,${AGE_RAMP.join(',')})"></i><span class="ei-fkey-ends"><span>0</span><span>${AGE_RAMP_MAX_MYR}+ Myr</span></span></div>`
            : `<div class="ei-pfam">${Object.values(FAMILY_STYLE).map((f) => `<span><i style="background:${f.hex}"></i>${esc(f.label)}</span>`).join('')}</div>`;
        if (key && S.surface === 'age') key.innerHTML += S.age
            ? `<div class="ei-fkey"><span>Age of the ocean floor (Seton et al. 2020) — continents uncoloured</span><i style="background:linear-gradient(90deg,${AGE_RAMP.join(',')})"></i><span class="ei-fkey-ends"><span>0</span><span>${AGE_RAMP_MAX_MYR}+ Myr</span></span></div>`
            : `<div class="ei-fkey"><span>${S.ageError ? `Ocean-floor age unavailable (${esc(S.ageError)}).` : 'Loading the ocean-floor age grid…'}</span></div>`;
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
        </div>${depthAgeChart()}${areaAgeChart()}`;
    }

    // The whole ocean floor: how much of it is how old (Seton et al. 2020), and how it compares with
    // Bird's tabulated Müller (1997) ages at the same boundary steps.
    function areaAgeChart() {
        if (S.ageError) return `<h3 class="ei-h3">How old is the ocean floor?</h3><p class="ei-muted ei-small">The ocean-floor age grid could not be loaded (${esc(S.ageError)}).</p>`;
        if (!S.age) return `<h3 class="ei-h3">How old is the ocean floor?</h3><p class="ei-muted ei-small">Loading the ocean-floor age grid (Seton et al. 2020)…</p>`;
        const A = S.age.dist, bins = A.bins.filter((b) => b.from < 200);
        const W = 560, H = 210, L = 52, R = 14, T = 12, B = 34, top = Math.ceil(Math.max(...bins.map((b) => b.areaKm2)) / 1e6 / 10) * 10;
        const xs = (a) => L + a / 200 * (W - L - R), ys = (m) => T + (1 - m / top) * (H - T - B);
        const bars = bins.map((b) => { const x = xs(b.from) + 1, w = xs(b.to) - xs(b.from) - 2, c = ageColor(b.from + 5).map((v) => Math.round(v * 255)).join(',');
            return `<rect x="${x.toFixed(1)}" y="${ys(b.areaKm2 / 1e6).toFixed(1)}" width="${w.toFixed(1)}" height="${(ys(0) - ys(b.areaKm2 / 1e6)).toFixed(1)}" fill="rgb(${c})" rx="1.5"><title>${b.from}–${b.to} Myr: ${(b.areaKm2 / 1e6).toFixed(1)} million km²</title></rect>`; }).join('');
        const xt = [0, 40, 80, 120, 160, 200].map((a) => `<text x="${xs(a)}" y="${H - 16}" class="ei-ticklab" text-anchor="middle">${a}</text>`).join('');
        const yt = []; for (let m = 0; m <= top; m += 10) yt.push(`<text x="${L - 6}" y="${ys(m) + 4}" class="ei-ticklab" text-anchor="end">${m}</text><line x1="${L}" x2="${W - R}" y1="${ys(m)}" y2="${ys(m)}" class="ei-gridline"/>`);
        // Seton 2020 vs Müller 1997 at Bird's oceanic-transform steps (two independent age products).
        const diffs = [];
        for (const st of S.model?.steps || []) {
            if (st.cls !== 'OTF' || st.ageMa == null) continue;
            const { mid } = stepGeometry(st.lat1, st.lon1, st.lat2, st.lon2);
            const a = ageAt(S.age.grid, mid.lat, mid.lon);
            if (a != null) diffs.push(Math.abs(a - st.ageMa));
        }
        diffs.sort((x, y) => x - y);
        const o = S.age.meta.oldestNode;
        return `<h3 class="ei-h3">How old is the ocean floor?</h3>
            <svg viewBox="0 0 ${W} ${H}" class="ei-dachart" role="img" aria-label="Area of ocean floor in each 10-million-year age band">
                ${yt.join('')}${xt}${bars}<text x="${(L + W - R) / 2}" y="${H - 2}" class="ei-ticklab" text-anchor="middle">age of the ocean floor, Myr</text>
                <text x="12" y="${(T + H - B) / 2}" class="ei-ticklab" text-anchor="middle" transform="rotate(-90 12 ${(T + H - B) / 2})">million km²</text>
            </svg>
            <p class="ei-muted ei-small">Oceanic crust covers ${(100 * A.globeFraction).toFixed(0)} % of the planet (${(A.oceanAreaKm2 / 1e6).toFixed(0)} million km²). Its mean age is ${A.meanMyr.toFixed(0)} Myr and half of it is younger than ${A.medianMyr.toFixed(0)} Myr; only ${(100 * A.olderThan[180]).toFixed(1)} % is older than 180 Myr. The area shrinks steadily with age because subduction consumes old and young floor alike, so the ocean floor is continually recycled. The oldest node in the grid is ${o.ageMyr.toFixed(0)} Myr old, in the eastern Mediterranean (${o.lat.toFixed(1)}°N ${o.lon.toFixed(1)}°E).
            Measured on the whole grid, each node weighted by its true area. Where both products have an age, at ${diffs.length} of Bird's oceanic-transform steps, the two disagree by a median ${diffs.length ? diffs[diffs.length >> 1].toFixed(1) : '—'} Myr (Seton et al. 2020 against Müller et al. 1997).
            Data: Seton, Müller, Zahirovic et al. (2020), <i>G³</i> 21, e2020GC009214, release 2020.1 (GTS2012 timescale), CC BY 4.0 — every second node of their 6-arc-minute grid (0.2°), unaveraged. The ages between magnetic anomalies are the authors' interpolation, and their release notes list artefacts around microplates, along some fracture zones and on highly oblique ridges.</p>`;
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
            <p class="ei-muted ei-small">Dots: depth (ETOPO5) and seafloor age (Müller et al. 1997) at each of Bird's ${d.points.length} oceanic-transform boundary steps; rings: medians. Line: the plate-cooling depth of Parsons &amp; Sclater (1977), d = 2.5 km + 0.35 km·√(age/Myr) to 70 Myr, flattening after. New seafloor is made hot and buoyant at the ridges and contracts as it cools. Transforms sit in fracture-zone troughs and are not a random sample of the seafloor, so read this as a comparison, not a fit. The whole-ocean age map is below, and on the globe under "Surface: Seafloor age".</p>`;
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
        for (const b of document.querySelectorAll('[data-psurface]')) b.setAttribute('aria-pressed', String(b.dataset.psurface === S.surface));
        $('#ei-parrows')?.setAttribute('aria-pressed', String(S.arrows));
        $('#ei-pinside')?.setAttribute('aria-pressed', String(S.inside));
    }
    function wire() {
        for (const b of document.querySelectorAll('[data-pframe]')) b.addEventListener('click', () => { S.frame = b.dataset.pframe; chips(); drawArrows(); renderHud(); });
        for (const b of document.querySelectorAll('[data-pcolor]')) b.addEventListener('click', () => { S.colorBy = b.dataset.pcolor; chips(); drawBoundaries(); renderHud(); });
        for (const b of document.querySelectorAll('[data-psurface]')) b.addEventListener('click', () => { S.surface = b.dataset.psurface; chips(); applySurface(); renderHud(); });
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
            applySurface();
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
                applySurface();
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
        if (on) { renderHud(); ensureModel(); ensureAge(); }
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
        let sea = '';
        if (S.age) {
            const a = ageAt(S.age.grid, hit.lat, hit.lon);
            sea = a == null ? '<span>No oceanic crust here in Seton et al. (2020) — continental or undated.</span>'
                : `<span>Ocean floor here: <b>${a < 10 ? a.toFixed(1) : a.toFixed(0)} Myr old</b> (Seton et al. 2020)</span>`;
        }
        let under = '';
        const d = S.inside ? slabs?.describe(hit) : null;
        if (d?.beneath?.length) under = d.beneath.map((u) => `<span>Below: the ${esc(u.slab.name)} slab, its top ${u.depthKm.toFixed(0)} km down${Number.isFinite(u.uncKm) ? ` (±${u.uncKm.toFixed(0)} km)` : ''}</span>`).join('');
        return `<b>${esc(plate.name)} plate · ${Math.abs(hit.lat).toFixed(1)}°${hit.lat < 0 ? 'S' : 'N'} ${Math.abs(hit.lon).toFixed(1)}°${hit.lon < 0 ? 'W' : 'E'}</b>
            <span>Moving ${v.speed.toFixed(0)} mm/yr toward ${compass(v.azimuth)} (${v.azimuth.toFixed(0)}°) — ${S.frame === 'nnr' ? 'no-net-rotation frame' : 'relative to the Pacific plate'}</span>${sea}${b}${under}`;
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
