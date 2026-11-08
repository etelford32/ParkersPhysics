/**
 * js/glacier-catalog-view.js — "Every glacier on Earth" on glacier-watch.html (RGI 7.0)
 * ═══════════════════════════════════════════════════════════════════════════════════
 * DOM + 2D canvas over the PURE js/glacier-catalog.js; computes nothing of its own. Dynamically
 * imported by js/glacier-watch-page.js when the section nears the viewport (or `?rgi=` asks for
 * a glacier), so the 48-glacier page never pays for 274 531 rows it may not scroll to.
 *
 *   • THE MAP is equirectangular over the dimmed NASA day map (assets/earth, the hero's own),
 *     drag to pan, wheel / pinch / ± to zoom about the cursor. Dots are TRUE SIZE wherever the
 *     glacier is wider than ~a pixel and floored below that — the legend says so. Drawn smallest
 *     first so the big ones stay on top.
 *   • TWO COLOUR JOBS, never mixed: median elevation is ONE sequential hue (dark → light = low →
 *     high, the reference blue steps 600 → 100, validated on #0b1120); terminus & surge is
 *     categorical (slot 1 marine-terminating, slot 2 surge evidence) over a neutral grey that
 *     means NOT ASSIGNED — RGI 7.0 assigns only the marine class, so grey is never "land".
 *   • PICKING is the kernel's great-circle `nearest` within PICK_PX of the cursor (converted to km
 *     at the current zoom), never a canvas colour readback; a click opens the glacier's region
 *     shard and prints everything RGI records about it, and says when it is one of the 48 tracked.
 *   • A RESOLVED glacier's card adds its YEAR-BY-YEAR speed (the kernel's `annualSeries` /
 *     `annualChartModel`, one region file fetched on demand): fastest ice always, typical speed only
 *     when that too is resolved, gaps where under half the glacier was imaged, crosshair + readout.
 */
import * as C from './glacier-catalog.js';

const PICK_PX = 9;
const { ELEV_BANDS, CLASS_COLORS } = C;   // the ONE palette (js/glacier-catalog.js), shared with EarthView
const fmtN = (v) => Math.round(v).toLocaleString('en-US');
const fmtA = (a) => (a >= 100 ? fmtN(a) : a >= 1 ? a.toFixed(1) : a.toFixed(2));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const compass = (deg) => (deg == null ? '—' : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8]);

export async function mountCatalog(root, { onOpenTracked = null, initialRgi = null } = {}) {
    root.innerHTML = `
      <div class="gw-cat-head">
        <h2>Every glacier on Earth</h2>
        <small id="gw-cat-sub">loading the Randolph Glacier Inventory…</small>
      </div>
      <div class="gw-cat-grid">
        <div class="gw-cat-mapwrap">
          <div class="gw-cat-tools" role="toolbar" aria-label="Catalogue map">
            <div class="gw-seg" role="group" aria-label="Colour by">
              <button type="button" data-mode="elev" aria-pressed="true">Median elevation</button>
              <button type="button" data-mode="class" aria-pressed="false">Terminus &amp; surges</button>
              <button type="button" data-mode="speed" aria-pressed="false">Surface speed</button>
            </div>
            <input id="gw-cat-search" type="search" placeholder="Search by name or RGI id" aria-label="Search the catalogue" autocomplete="off">
            <button type="button" data-zoom="1" aria-label="Zoom in">+</button><button type="button" data-zoom="-1" aria-label="Zoom out">−</button><button type="button" data-zoom="0">World</button>
          </div>
          <div id="gw-cat-results" hidden></div>
          <canvas id="gw-cat-map" aria-label="Map of every glacier in RGI 7.0" role="img"></canvas>
          <div id="gw-cat-tip" role="tooltip" hidden></div>
          <div id="gw-cat-legend"></div>
        </div>
        <aside id="gw-cat-card" aria-live="polite"><div class="gw-empty">Hover the map for a glacier, click it for everything the inventory records — or search by name.</div></aside>
      </div>
      <div class="gw-cat-grid2">
        <div><h3>The size story</h3><div id="gw-cat-sizes"></div></div>
        <div><h3>By region</h3><div id="gw-cat-regions"></div></div>
      </div>
      <p class="gw-cat-note" id="gw-cat-note"></p>`;
    const $ = (id) => root.querySelector('#' + id);

    let cat, names = null, grid;
    try {
        cat = await C.loadCatalog();
    } catch (e) {
        $('gw-cat-sub').textContent = `the catalogue is unavailable (${e.message}) — nothing is drawn rather than a partial map`;
        root.dataset.state = 'error';
        return null;
    }
    const { meta, pts } = cat;
    grid = C.buildGrid(pts);
    C.loadNames().then(n => { names = n; if (S.sel !== null) openGlacier(S.sel); }).catch(() => { /* search says so */ });

    const S = { mode: 'elev', cx: 0, cy: 20, scale: 0, sel: null, hover: null, shards: {}, dpr: 1, w: 0, h: 0, speed: null, speedErr: null };
    // the speed table (~1–2 MB) loads only when the speed view or a record card first asks for it
    let speedLoading = null;
    // the year-by-year history: the meta once, then one ~10–60 KB file per RGI region, on the first card that needs it
    let annMeta = null; const annShards = {};
    const ensureAnnual = async (o1) => {
        annMeta ||= C.loadAnnualMeta();
        const am = await annMeta;
        if (!(o1 in annShards)) annShards[o1] = C.loadAnnual(am, o1);
        return { ameta: am, dec: await annShards[o1] };
    };
    const o1At = (i) => meta.o2[pts.o2[i]].slice(0, 2);
    const ensureSpeed = () => (speedLoading ||= C.loadSpeed().then(r => {
        // one verdict per glacier, ONCE — never 274 k speedOf() calls per frame
        r.colors = Array.from({ length: pts.n }, (_, i) => C.speedColor(C.speedOf(r.spd, r.smeta, i, o1At(i))));
        S.speed = r; draw(); if (S.sel !== null) openGlacier(S.sel); return r; })
        // the card must leave "loading…" on failure too, or a dead table reads as a slow one
        .catch(e => { S.speedErr = e.message; draw(); if (S.sel !== null) openGlacier(S.sel); return null; }));
    const tracked = new Map(Object.entries(meta.watch_links).filter(([, L]) => L.index !== null).map(([id, L]) => [L.index, id]));
    // smallest first, so a large glacier is never buried under the dots of its neighbours
    const order = Uint32Array.from({ length: pts.n }, (_, i) => i).sort((a, b) => pts.area[a] - pts.area[b]);
    const colorOf = (i) => (S.mode === 'class' ? C.classColor(pts.flags[i])
        : S.mode === 'speed' ? (S.speed ? S.speed.colors[i] : C.SPEED_NEUTRAL)
        : C.elevColor(pts.zmed[i]));

    $('gw-cat-sub').textContent = `RGI 7.0 · ${fmtN(meta.n)} glaciers · ${fmtN(meta.official.o1region.Global.area_km2)} km² of ice outside the two ice sheets`;
    $('gw-cat-note').innerHTML =
        `An INVENTORY, not a measurement of today: each outline is dated by the image it was drawn from (median year 2002). It says where every glacier is and how big. "Surface speed" adds NASA ITS_LIVE's 2014–2024 MEAN speed inside each outline, counted as resolved only above twice the typical single-pair error the tracked glaciers measure — a decade's average, not today (a resolved glacier's card adds its year-by-year history); today's motion, pair by pair, is what the 48 tracked glaciers above measure. ` +
        `The Greenland and Antarctic ice sheets are not glaciers in this inventory, so their outlets (Jakobshavn, Helheim, Thwaites…) have no outline here. ` +
        `RGI 7.0 marks only <b>marine-terminating</b> fronts; every other terminus is "not assigned", not "on land". Names are the inventory's, cleaned by the data mirror (most glaciers have none). ` +
        `Source: ${esc(meta.citation)} Read from an unofficial mirror that reproduces the Consortium's own region tables exactly (checked at every build).`;

    // ── base map ──────────────────────────────────────────────────────────
    const base = new Image();
    base.decoding = 'async';
    base.onload = () => draw();
    base.src = '/assets/earth/day-2k.webp';

    const canvas = $('gw-cat-map'), ctx = canvas.getContext('2d');
    const fitWorld = () => { S.cx = 0; S.cy = 15; S.scale = Math.max(S.w / 360, S.h / 165); };
    const toPx = (lon, lat) => [S.w / 2 + (lon - S.cx) * S.scale, S.h / 2 - (lat - S.cy) * S.scale];
    const toLL = (x, y) => [S.cx + (x - S.w / 2) / S.scale, S.cy - (y - S.h / 2) / S.scale];
    const clampView = () => {
        S.scale = Math.min(Math.max(S.scale, S.w / 360), 2400);
        const halfW = S.w / 2 / S.scale, halfH = S.h / 2 / S.scale;
        S.cx = Math.min(180 - halfW, Math.max(-180 + halfW, S.cx));
        S.cy = halfH >= 90 ? 0 : Math.min(90 - halfH, Math.max(-90 + halfH, S.cy));
    };
    function resize() {
        const r = canvas.getBoundingClientRect();
        S.dpr = Math.min(2, devicePixelRatio || 1);
        S.w = r.width; S.h = r.height;
        canvas.width = Math.round(r.width * S.dpr); canvas.height = Math.round(r.height * S.dpr);
        if (!S.scale) fitWorld();
        clampView(); draw();
    }
    let raf = 0;
    const draw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
    function render() {
        const t0 = performance.now();
        ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
        ctx.fillStyle = '#060a14'; ctx.fillRect(0, 0, S.w, S.h);
        if (base.complete && base.naturalWidth) {
            const [x0, y0] = toPx(-180, 90), [x1, y1] = toPx(180, -90);
            ctx.globalAlpha = 0.34; ctx.filter = 'saturate(0.35)';
            ctx.drawImage(base, x0, y0, x1 - x0, y1 - y0);
            ctx.globalAlpha = 1; ctx.filter = 'none';
        }
        const kmPerPx = 111.32 / S.scale;
        const [lonA, latB] = toLL(-8, S.h + 8), [lonB, latA] = toLL(S.w + 8, -8);
        // BATCHED: one path per colour for the sub-pixel dots (a fillStyle change per dot cost 334 ms
        // for the world view on a software rasteriser), then the few resolved discs, smallest first
        const paths = new Map(), big = [];
        let drawn = 0;
        for (let k = 0; k < order.length; k++) {
            const i = order[k], lat = pts.lat[i], lon = pts.lon[i];
            if (lat < latB || lat > latA || lon < lonA || lon > lonB) continue;
            const x = S.w / 2 + (lon - S.cx) * S.scale, y = S.h / 2 - (lat - S.cy) * S.scale;
            // true radius of an equal-area disc, in pixels (drawn at the latitude scale)
            const rTrue = Math.sqrt(pts.area[i] / Math.PI) / kmPerPx;
            drawn++;
            if (rTrue >= 1.1) { big.push(i, x, y, rTrue); continue; }
            const c = colorOf(i);
            let path = paths.get(c);
            if (!path) paths.set(c, path = new Path2D());
            const sz = Math.max(1.1, rTrue * 2);
            path.rect(x - sz / 2, y - sz / 2, sz, sz);
        }
        for (const [c, path] of paths) { ctx.fillStyle = c; ctx.fill(path); }
        for (let k = 0; k < big.length; k += 4) {
            ctx.fillStyle = colorOf(big[k]); ctx.beginPath(); ctx.arc(big[k + 1], big[k + 2], big[k + 3], 0, 6.2832); ctx.fill();
        }
        for (const [i, col] of [[S.hover, '#ffffff'], [S.sel, '#ffd166']]) {
            if (i === null) continue;
            const [x, y] = toPx(pts.lon[i], pts.lat[i]);
            const r = Math.max(7, Math.sqrt(pts.area[i] / Math.PI) / kmPerPx + 4);
            ctx.strokeStyle = '#060a14'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.stroke();
            ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.stroke();
        }
        S.lastDrawn = drawn; S.lastMs = performance.now() - t0;
        renderLegend(kmPerPx);
    }
    function renderLegend(kmPerPx) {
        const items = S.mode === 'elev'
            ? ELEV_BANDS.map(b => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join('')
            : S.mode === 'speed'
            ? C.SPEED_BANDS.map(b => `<span><i style="background:${b.color}"></i>${b.label}</span>`).join('') + `<span><i style="background:${C.SPEED_NEUTRAL}"></i>below what ITS_LIVE resolves / no data</span>`
            : `<span><i style="background:${CLASS_COLORS.marine}"></i>marine-terminating</span><span><i style="background:${CLASS_COLORS.surge}"></i>surge evidence</span><span><i style="background:${CLASS_COLORS.none}"></i>not assigned</span>`;
        const floorKm2 = Math.PI * (0.55 * kmPerPx) ** 2;
        const what = S.mode === 'elev' ? 'median glacier elevation'
            : S.mode === 'speed' ? (S.speedErr ? `speed table unavailable (${esc(S.speedErr)})` : S.speed ? 'fastest ice of each glacier (98th percentile inside its outline), NASA ITS_LIVE 2014–2024 mean; grey = below what ITS_LIVE resolves (2× the typical pair error) or no data' : 'loading ITS_LIVE speeds…')
            : 'RGI 7.0 assigns only the marine class';
        $('gw-cat-legend').innerHTML = `<div class="gw-cat-keys">${items}</div><small>${what} · dots true size above ~${fmtA(floorKm2)} km², a pixel below · ${fmtN(S.lastDrawn || 0)} in view</small>`;
    }

    // ── interaction ───────────────────────────────────────────────────────
    const pick = (x, y) => {
        const [lon, lat] = toLL(x, y);
        const km = PICK_PX * 111.32 / S.scale;
        return C.nearest(pts, grid, lat, lon, Math.max(km, 0.05))?.index ?? null;
    };
    const tip = $('gw-cat-tip');
    const label = (i) => names?.byIndex.get(i) ?? (tracked.has(i) ? 'tracked glacier' : 'unnamed glacier');
    function hover(e) {
        const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        const i = pick(x, y);
        if (i !== S.hover) { S.hover = i; draw(); }
        if (i === null) { tip.hidden = true; canvas.style.cursor = drag ? 'grabbing' : 'grab'; return; }
        canvas.style.cursor = 'pointer';
        const o2 = meta.o2[pts.o2[i]];
        tip.innerHTML = `<b>${esc(label(i))}</b><br>${fmtA(pts.area[i])} km² · median ${fmtN(pts.zmed[i])} m<br><small>${esc(meta.official.o2region[o2]?.name ?? o2)} · ${C.rgiId(meta, i)}${tracked.has(i) ? ' · tracked in Glacier Watch' : ''}</small>`;
        tip.hidden = false;
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        tip.style.left = `${Math.min(r.width - tw - 6, x + 14)}px`; tip.style.top = `${y + 14 + th > r.height ? y - th - 10 : y + 14}px`;
    }
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cx: S.cx, cy: S.cy, t: e.timeStamp, moved: 0 }; canvas.setPointerCapture?.(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
        if (drag) {
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
            if (drag.moved > 4) { S.cx = drag.cx - dx / S.scale; S.cy = drag.cy + dy / S.scale; clampView(); tip.hidden = true; draw(); return; }
        }
        hover(e);
    });
    canvas.addEventListener('pointerup', (e) => {
        const d = drag; drag = null;
        if (d && d.moved <= 5 && e.timeStamp - d.t < 600) {   // a click, not the end of a pan (event.timeStamp — the mars.html rule)
            const r = canvas.getBoundingClientRect(), i = pick(e.clientX - r.left, e.clientY - r.top);
            if (i !== null) openGlacier(i);
        }
    });
    canvas.addEventListener('pointerleave', () => { tip.hidden = true; if (S.hover !== null) { S.hover = null; draw(); } });
    const zoomAt = (x, y, f) => {
        const [lon, lat] = toLL(x, y);
        S.scale *= f; clampView();
        const [x2, y2] = toPx(lon, lat);
        S.cx += (x2 - x) / S.scale; S.cy -= (y2 - y) / S.scale; clampView(); draw();
    };
    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015)));
    }, { passive: false });
    canvas.addEventListener('dblclick', (e) => { const r = canvas.getBoundingClientRect(); zoomAt(e.clientX - r.left, e.clientY - r.top, 2.5); });
    root.querySelectorAll('[data-zoom]').forEach(b => b.addEventListener('click', () => {
        const z = Number(b.dataset.zoom);
        if (z === 0) { fitWorld(); clampView(); draw(); } else zoomAt(S.w / 2, S.h / 2, z > 0 ? 2 : 0.5);
    }));
    root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
        S.mode = b.dataset.mode;
        root.querySelectorAll('[data-mode]').forEach(q => q.setAttribute('aria-pressed', String(q === b)));
        if (S.mode === 'speed') ensureSpeed();
        draw();
    }));

    // ── search ────────────────────────────────────────────────────────────
    const input = $('gw-cat-search'), results = $('gw-cat-results');
    let hits = [];
    input.addEventListener('input', () => {
        const q = input.value.trim();
        if (!q) { results.hidden = true; return; }
        if (!names && !/^RGI/i.test(q)) { results.innerHTML = '<div class="gw-empty">the name index is still loading…</div>'; results.hidden = false; return; }
        hits = C.search(meta, pts, names || { list: [], byIndex: new Map() }, q, 10);
        results.innerHTML = hits.length
            ? hits.map((i, k) => `<button type="button" data-hit="${k}"><b>${esc(label(i))}</b> <small>${fmtA(pts.area[i])} km² · ${esc(meta.official.o1region[C.o1Of(meta, i)]?.name ?? '')}</small></button>`).join('')
            : '<div class="gw-empty">no glacier by that name or id</div>';
        results.hidden = false;
    });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && hits.length) { openGlacier(hits[0], { fly: true }); results.hidden = true; }
        if (e.key === 'Escape') { input.value = ''; results.hidden = true; }
    });
    results.addEventListener('click', (e) => { const b = e.target.closest('[data-hit]'); if (b) { openGlacier(hits[Number(b.dataset.hit)], { fly: true }); results.hidden = true; } });

    // ── the card ──────────────────────────────────────────────────────────
    async function openGlacier(i, { fly = false } = {}) {
        S.sel = i;
        if (fly) {
            const kmWide = Math.max(60, 12 * Math.sqrt(pts.area[i]));
            S.scale = S.w / (kmWide / 111.32); S.cx = pts.lon[i]; S.cy = pts.lat[i]; clampView();
        }
        draw();
        const o1 = C.o1Of(meta, i);
        const card = $('gw-cat-card');
        card.innerHTML = `<div class="gw-empty">opening ${C.rgiId(meta, i)}…</div>`;
        let shard;
        try { shard = S.shards[o1] ||= await C.loadShard(o1); }
        catch (e) { card.innerHTML = `<div class="gw-empty">the details for this region are unavailable (${esc(e.message)})</div>`; return; }
        if (S.sel !== i) return;
        ensureSpeed();
        const d = C.detailFor(meta, pts, shard, i, names);
        const sp = S.speed ? C.speedOf(S.speed.spd, S.speed.smeta, i, o1At(i)) : null;
        const spd = (v) => !Number.isFinite(v) ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} km/yr` : v >= 10 ? `${Math.round(v)} m/yr` : `${v.toFixed(1)} m/yr`;
        const speedRow = S.speedErr ? `<dt>Surface speed</dt><dd><small>speed table unavailable (${esc(S.speedErr)})</small></dd>`
            : !sp ? `<dt>Surface speed</dt><dd><small>loading ITS_LIVE…</small></dd>`
            : sp.state === 'no-tile' || sp.state === 'no-data' ? `<dt>Surface speed</dt><dd>— <small>(${esc(sp.label)})</small></dd>`
            : `<dt>Surface speed</dt><dd>${sp.state === 'below' ? '<b>below what ITS_LIVE resolves</b>' : sp.state === 'partly' ? `fastest ice ${spd(sp.p98)} <small>(most of the glacier is below what ITS_LIVE resolves)</small>` : `typical ${spd(sp.med)} · fastest ice ${spd(sp.p98)}`}
                 <small><br>resolved = above ${spd(sp.threshold)}, twice the typical single-pair error measured on ${sp.pairError.scope === 'region' ? `${sp.pairError.n} tracked glacier${sp.pairError.n > 1 ? 's' : ''} in this region` : `the ${sp.pairError.n} tracked glaciers (none in this region)`}${sp.state === 'below' && Number.isFinite(sp.p98) ? ` — its fastest ice reads ${spd(sp.p98)} in the composite, which a 120 m grid cannot separate from zero` : ''}
                 ${Number.isFinite(sp.dvdt) && Math.abs(sp.dvdt) >= 0.1 && sp.state !== 'below' ? ` · trend ${sp.dvdt >= 0 ? '+' : ''}${sp.dvdt.toFixed(1)} m/yr per year` : ''}
                 <br>NASA ITS_LIVE 2014–2024 mean over ${sp.subpixel ? 'the nearest 120 m pixel (the glacier is smaller than one)' : `${sp.npix >= 65535 ? 'more than 65,000' : fmtN(sp.npix)} pixels inside the outline${sp.coverage != null && sp.coverage < 80 ? ` — only ${sp.coverage} % of it (it runs off the satellite tile)` : ''}`}</small></dd>`;
        const tr = tracked.get(i);
        const hmax = Math.max(...d.hypsometry.map(h => h.frac), 1e-9);
        const rowH = Math.max(2, Math.min(7, Math.floor(220 / Math.max(1, d.hypsometry.length))));   // the chart stays ≤ ~240 px for a 3 km-tall glacier
        const bars = d.hypsometry.slice().reverse().map(h =>
            `<div class="gw-hyp-row" style="height:${rowH}px" title="${fmtN(h.z - 25)}–${fmtN(h.z + 25)} m: ${(100 * h.frac).toFixed(1)} % of the area"><span>${(h.z - 25) % (d.hypsometry.length > 30 ? 500 : 250) === 0 ? fmtN(h.z - 25) : ''}</span><i style="width:${(100 * h.frac / hmax).toFixed(1)}%"></i></div>`).join('');
        card.innerHTML = `
          <h3>${esc(d.name || 'Unnamed glacier')}</h3>
          <div class="gw-cat-id">${d.rgi_id}${d.rgi6 ? ` · RGI 6: ${esc(d.rgi6)}` : ''}</div>
          ${tr ? `<button type="button" class="gw-cat-tracked" data-open="${tr}">Tracked in Glacier Watch — open its live speed ▸</button>` : ''}
          <dl>
            <dt>Region</dt><dd>${esc(d.subregion)} <small>(${esc(d.region)})</small></dd>
            <dt>Area</dt><dd>${fmtA(d.area_km2)} km²</dd>
            <dt>Elevation</dt><dd>${fmtN(d.zmin)}–${fmtN(d.zmax)} m <small>(median ${fmtN(d.zmed)})</small></dd>
            <dt>Longest flowline</dt><dd>${d.lmax_m ? (d.lmax_m / 1000).toFixed(1) + ' km' : '—'}</dd>
            <dt>Mean slope</dt><dd>${d.slope_deg != null ? d.slope_deg.toFixed(1) + '°' : '—'} · faces ${compass(d.aspect_deg)}</dd>
            <dt>Terminus</dt><dd>${d.marine ? 'marine-terminating' : 'not assigned <small>(RGI 7.0 marks only marine fronts)</small>'}</dd>
            <dt>Surging</dt><dd>${esc(d.surgeLabel)}${d.surge ? ' evidence' : ''}</dd>
            <dt>Outline</dt><dd>${d.year ?? '—'} imagery · ${esc(d.dem)} elevations</dd>
            ${speedRow}
          </dl>
          ${sp && (sp.state === 'moving' || sp.state === 'partly') ? `<div class="gw-ann" id="gw-cat-ann"><div class="gw-hyp-title">Speed year by year</div><small>loading the ITS_LIVE history…</small></div>` : ''}
          <div class="gw-hyp" aria-label="Area by elevation"><div class="gw-hyp-title">Area by elevation (50 m bands)</div>${bars}</div>
          <div class="gw-cat-links"><a href="earth.html?at=${d.lat.toFixed(3)},${d.lon.toFixed(3)},${Math.round(Math.max(300, 25 * Math.sqrt(d.area_km2)))}">Fly to it on EarthView ▸</a></div>`;
        card.querySelector('[data-open]')?.addEventListener('click', (e) => onOpenTracked?.(e.currentTarget.dataset.open));
        const url = new URL(location.href); url.searchParams.set('rgi', d.rgi_id); history.replaceState(null, '', url);
        if (sp && (sp.state === 'moving' || sp.state === 'partly')) {
            const el = card.querySelector('#gw-cat-ann');
            try {
                const { ameta, dec } = await ensureAnnual(o1);
                if (S.sel !== i || !el.isConnected) return;
                renderAnnual(el, C.annualSeries(dec, ameta, i), sp, ameta);
            } catch (e) {
                if (S.sel === i && el.isConnected) el.innerHTML = `<div class="gw-hyp-title">Speed year by year</div><small>the history is unavailable (${esc(e.message)})</small>`;
            }
        }
    }

    // ── the year-by-year chart (one axis: both lines are m/yr; colour = identity, kernel ANNUAL_COLORS) ──
    function renderAnnual(el, rows, sp, ameta) {
        const title = '<div class="gw-hyp-title">Speed year by year <small>(NASA ITS_LIVE annual composites)</small></div>';
        if (!rows || !rows.some(r => r.drawn)) {
            el.innerHTML = title + `<small>${rows ? `no year has ${ameta.cover_min} % of the glacier imaged` : 'no annual history for this glacier in the bake'}</small>`;
            return;
        }
        const both = sp.state === 'moving';              // a partly-resolved glacier's TYPICAL speed is noise — not drawn
        const M = C.annualChartModel(rows, { threshold: sp.threshold, width: 296, height: 156 });
        const { x, y, pad } = M, col = C.ANNUAL_COLORS, f = (v) => v.toFixed(1);
        const spd = (v) => !Number.isFinite(v) ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} km/yr` : v >= 10 ? `${Math.round(v)} m/yr` : `${v.toFixed(1)} m/yr`;
        const path = (run, k) => run.map((r, j) => `${j ? 'L' : 'M'}${f(x(r.year))},${f(y(r[k]))}`).join('');
        const band = (run) => run.length < 2 || !run.every(r => Number.isFinite(r.err)) ? ''
            : `<path d="${run.map((r, j) => `${j ? 'L' : 'M'}${f(x(r.year))},${f(y(r.med + r.err))}`).join('')}${run.slice().reverse().map(r => `L${f(x(r.year))},${f(y(Math.max(0, r.med - r.err)))}`).join('')}Z" fill="${col.typical}" opacity=".18"/>`;
        const dots = (k, c) => rows.filter(r => r.drawn).map(r => `<circle cx="${f(x(r.year))}" cy="${f(y(r[k]))}" r="${r.partial ? 3.2 : 2.4}" fill="${r.partial ? '#0a101e' : c}" stroke="${c}" stroke-width="${r.partial ? 1.5 : 0}"/>`).join('');
        const last = rows.filter(r => r.drawn).at(-1);
        const gapTicks = rows.filter(r => !r.drawn).map(r => `<line x1="${f(x(r.year))}" x2="${f(x(r.year))}" y1="${M.height - pad.b}" y2="${M.height - pad.b + 4}" stroke="#7d869c"/>`).join('');
        el.innerHTML = title + `
          <svg class="gw-ann-svg" viewBox="0 0 ${M.width} ${M.height}" width="100%" role="img" aria-label="Surface speed of this glacier each year, ${M.y0}–${M.y1}">
            ${M.ticks.map(v => `<line x1="${pad.l}" x2="${M.width - pad.r}" y1="${f(y(v))}" y2="${f(y(v))}" stroke="#1d2840" stroke-width="1"/><text x="${pad.l - 4}" y="${f(y(v) + 3)}" text-anchor="end">${v >= 1000 ? (v / 1000) + 'k' : v}</text>`).join('')}
            ${M.yearTicks.map(yr => `<text x="${f(x(yr))}" y="${M.height - 5}" text-anchor="middle">${yr}</text>`).join('')}
            ${gapTicks}
            <line x1="${pad.l}" x2="${M.width - pad.r}" y1="${f(y(sp.threshold))}" y2="${f(y(sp.threshold))}" stroke="#7d869c" stroke-dasharray="3 3" stroke-width="1"/>
            ${both ? M.runs.map(band).join('') + M.runs.map(run => `<path d="${path(run, 'med')}" fill="none" stroke="${col.typical}" stroke-width="2" stroke-linejoin="round"/>`).join('') + dots('med', col.typical) : ''}
            ${M.runs.map(run => `<path d="${path(run, 'p98')}" fill="none" stroke="${col.fastest}" stroke-width="2" stroke-linejoin="round"/>`).join('')}
            ${dots('p98', col.fastest)}
            <line class="gw-ann-x" x1="0" x2="0" y1="${pad.t}" y2="${M.height - pad.b}" stroke="#c3c2b7" stroke-width="1" visibility="hidden"/>
            <rect x="${pad.l}" y="0" width="${M.width - pad.l - pad.r}" height="${M.height}" fill="transparent" class="gw-ann-hit"/>
          </svg>
          <div class="gw-ann-keys"><span><i style="background:${col.fastest}"></i>fastest ice (98th percentile)</span>${both ? `<span><i style="background:${col.typical}"></i>typical (median) ± ITS_LIVE error</span>` : ''}<span><i class="dash"></i>resolved above ${spd(sp.threshold)}</span></div>
          <div class="gw-ann-read" aria-live="polite"></div>
          <small>${both ? '' : 'Most of this glacier moves slower than ITS_LIVE resolves, so only its fastest ice is drawn. '}Each year is that calendar year's ITS_LIVE fit with the seasonal cycle removed, over the same pixels as the speed above. ${M.gaps ? `${M.gaps} year${M.gaps > 1 ? 's' : ''} with less than ${ameta.cover_min} % of the glacier imaged ${M.gaps > 1 ? 'are' : 'is'} left as gaps (ticks on the axis), never drawn. ` : ''}${last.partial ? `${last.year} (hollow) is a partial year. ` : ''}</small>`;
        const read = el.querySelector('.gw-ann-read'), cross = el.querySelector('.gw-ann-x'), svg = el.querySelector('svg');
        const say = (r) => {
            if (!r.drawn) { read.innerHTML = `<b>${r.year}</b> · only ${r.cov} % of the glacier imaged — not drawn`; return; }
            read.innerHTML = `<b>${r.year}${r.partial ? ' (partial)' : ''}</b> · fastest ice <b>${spd(r.p98)}</b>${both ? ` · typical ${spd(r.med)}${Number.isFinite(r.err) ? ` ± ${spd(r.err)}` : ''}` : ''} · ${r.cov} % imaged`;
        };
        const rest = () => { cross.setAttribute('visibility', 'hidden'); say(rows.filter(r => r.drawn && !r.partial).at(-1) || last); };
        const at = (e) => {
            const b = svg.getBoundingClientRect(), sx = (e.clientX - b.left) * M.width / b.width;
            let best = rows[0]; for (const r of rows) if (Math.abs(x(r.year) - sx) < Math.abs(x(best.year) - sx)) best = r;
            cross.setAttribute('x1', f(x(best.year))); cross.setAttribute('x2', f(x(best.year))); cross.setAttribute('visibility', 'visible');
            say(best);
        };
        svg.addEventListener('pointermove', at); svg.addEventListener('pointerdown', at); svg.addEventListener('pointerleave', rest);
        rest();
        el.dataset.years = `${M.y0}-${M.y1}`;
    }

    // ── the size story + regions ──────────────────────────────────────────
    const hist = meta.size_classes.filter(h => h.n > 0);
    const totN = hist.reduce((s, h) => s + h.n, 0), totA = hist.reduce((s, h) => s + h.area_km2, 0);
    const rng = (h) => `${h.lo < 1 ? h.lo : fmtN(h.lo)}–${h.hi === null ? '' : h.hi < 1 ? h.hi : fmtN(h.hi)} km²`.replace(/–$/, '+ km²').replace(/–(\d[\d,]*) km²$/, '–$1 km²');
    $('gw-cat-sizes').innerHTML = `
      <p class="gw-cat-lede"><b>${Math.round(100 * hist.filter(h => h.hi !== null && h.hi <= 1).reduce((s, h) => s + h.n, 0) / totN)} %</b> of glaciers are smaller than 1 km² — but the <b>${fmtN(hist.filter(h => h.lo >= 100).reduce((s, h) => s + h.n, 0))}</b> larger than 100 km² hold <b>${Math.round(100 * hist.filter(h => h.lo >= 100).reduce((s, h) => s + h.area_km2, 0) / totA)} %</b> of the ice area.</p>
      <table class="gw-cat-size"><thead><tr><th>size</th><th>share of glaciers</th><th>share of area</th></tr></thead><tbody>${hist.map(h => `
        <tr><td>${rng(h)}</td>
          <td><div class="gw-bar"><i style="width:${(100 * h.n / totN).toFixed(1)}%"></i></div><small>${fmtN(h.n)}</small></td>
          <td><div class="gw-bar"><i style="width:${(100 * h.area_km2 / totA).toFixed(1)}%"></i></div><small>${fmtN(h.area_km2)} km²</small></td></tr>`).join('')}</tbody></table>`;
    const rows = C.regionRows(meta).filter(r => r.n > 0).sort((a, b) => b.area_km2 - a.area_km2);
    $('gw-cat-regions').innerHTML = `<div class="gw-cat-tablewrap"><table class="gw-cat-reg"><thead><tr><th>region</th><th class="n">glaciers</th><th class="n">area km²</th><th>largest glacier</th><th class="n">marine</th><th class="n">surge</th></tr></thead><tbody>${rows.map(r => `
      <tr><td>${esc(r.name)}<div class="gw-bar thin"><i style="width:${(100 * r.share / rows[0].share).toFixed(1)}%"></i></div></td>
        <td class="n">${fmtN(r.n)}</td><td class="n">${fmtN(r.area_km2)}</td>
        <td><button type="button" class="gw-linkish" data-goto="${r.largest.index}">${esc(r.largest.name || 'unnamed')}</button> <small>${fmtN(r.largest.area_km2)} km²</small></td>
        <td class="n">${fmtN(r.marine)}</td><td class="n">${fmtN(r.surge[1] + r.surge[2] + r.surge[3])}</td></tr>`).join('')}</tbody></table></div>
      <small>Counts and areas are the RGI Consortium's own; "surge" counts possible, probable and observed evidence; Region 20 (the Antarctic mainland) is ice sheet and holds no inventory glaciers.</small>`;
    $('gw-cat-regions').addEventListener('click', (e) => { const b = e.target.closest('[data-goto]'); if (b) openGlacier(Number(b.dataset.goto), { fly: true }); });

    new ResizeObserver(resize).observe(canvas);
    resize();
    if (initialRgi) { const i = C.indexOfRgiId(meta, initialRgi); if (i !== null) openGlacier(i, { fly: true }); }
    root.dataset.state = 'ready';
    const api = { meta, pts, S, openGlacier, pick, toPx, render: () => render(), get names() { return names; } };
    window.__glacierCatalog = api;
    return api;
}
