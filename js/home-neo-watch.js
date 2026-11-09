/**
 * home-neo-watch.js — the homepage's "10 nearest near-Earth objects, right
 * now" widget: a geocentric PLAN VIEW + a live table, on the SAME catalogue,
 * kernel and worker the solar-system orrery and the Near-Earth Watch use.
 * ═══════════════════════════════════════════════════════════════════════════
 *   the catalogue   /api/neo/catalog (JPL SBDB, tiered)  → js/neo-worker.js
 *   positions       worker `geoframe` (Kepler on osculating elements, J2000)
 *   every number    js/neo-space.js `buildObjectRow` — distance, RA/Dec,
 *                   magnitude, size, the encounter screen, your alt/az
 *   ranking / map   js/home-neo-model.js (PURE; `node tests/home-neo-model.mjs`)
 *
 * NOT an iframe of solar-system.html: the 2026-09 funnel work measured the
 * two live WebGL iframes below the hero as the reason only ~7 % of visitors
 * reached the capture band (js/home-showcase-slides.js header). This is a 2D canvas
 * and a table — the orrery's own numbers, at a fraction of the cost — with
 * links into the Near-Earth Watch (3D, geocentric) and the orrery (3D,
 * heliocentric) for the full picture.
 *
 * ── Honesty ────────────────────────────────────────────────────────────────
 * · The LIST is "nearest by our two-body propagation at this instant" and
 *   the caption says so; JPL's close-approach table (integrated orbits) is
 *   the authority on flybys and is one link away. Inside Earth's sphere of
 *   influence a heliocentric two-body position is the wrong model and the
 *   row says so (`encounter.regime`, the Near-Earth Watch's own rule).
 * · The plan view's radius is LOGARITHMIC (neo-space `geoSceneRadius`,
 *   Earth's surface = 1, the Moon at 12), DISCLOSED under the map and ruled
 *   by labelled rings; out-of-plane distance is an elevation glyph, never
 *   hidden. Bodies are not drawn to size (they are dots).
 * · A dead or stale catalogue says so in the chip and draws nothing
 *   invented. A row's size carries its assumption (H + albedo, or measured).
 * · The clock is the visitor's wall clock; positions refresh every
 *   `FRAME_MS`, and the worker is idle while the widget is off screen.
 *
 * Mount: `mountHomeNeoWatch(host, opts)`. Test hook: `window.__homeNeo`
 * under ?debug=1. Browser gate: tests/home-neo-top10.spec.js (JPL mocked).
 */

import { rowToRecord, propagate } from './neo-orbits.js';
import {
    earthHelioJ2000, earthVelocityJ2000, AU_PER_DAY_TO_KMS, buildObjectRow, moonGeoJ2000,
    sunGeoDirectionJ2000, soiRadiusKm, hillRadiusKm,
} from './neo-space.js';
import {
    TOP_N, HORIZON_AU, TIER_LADDER, nearestIndices, planPoint, PLAN_RINGS, planExtent,
    approachTrend, rowSummary, tintFor, tierLabel, AU_KM, LD_KM, MOON_SCENE,
} from './home-neo-model.js';
import { loadUserLocation } from './user-location.js';

const WORKER_URL = new URL('./neo-worker.js', import.meta.url);
/** Positions are re-propagated this often while on screen (they move slowly). */
export const FRAME_MS = 2000;
/** The clock line ticks every second. */
const CLOCK_MS = 1000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const msToJd = (ms) => ms / 86400e3 + 2440587.5;

const CSS = `
.hnw{--hnw-ink:#e9e4ff;--hnw-dim:#9d92c8;--hnw-line:rgba(157,146,200,.18);--hnw-amber:#ffd23f;--hnw-red:#ff5a3c;--hnw-ok:#2eff9e;
  max-width:1060px;margin:0 auto;text-align:left;color:var(--hnw-ink);font-family:var(--font-sans,'Space Grotesk',system-ui,sans-serif)}
.hnw-head{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;margin-bottom:12px;font-size:.78rem;color:var(--hnw-dim)}
.hnw-chip{display:inline-flex;align-items:center;gap:7px;padding:4px 10px;border-radius:999px;border:1px solid var(--hnw-line);background:rgba(7,2,26,.7);font-family:var(--font-mono,ui-monospace,monospace);font-size:.7rem;letter-spacing:.04em;text-transform:uppercase;color:var(--hnw-ink)}
.hnw-chip::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--hnw-dim)}
.hnw-chip.live::before{background:var(--hnw-ok);box-shadow:0 0 6px var(--hnw-ok)}
.hnw-chip.stale::before{background:var(--hnw-amber);box-shadow:0 0 6px var(--hnw-amber)}
.hnw-chip.down::before{background:var(--hnw-red);box-shadow:0 0 6px var(--hnw-red)}
.hnw-clock{font-family:var(--font-mono,ui-monospace,monospace);font-variant-numeric:tabular-nums}
.hnw-grid{display:grid;grid-template-columns:minmax(260px,420px) 1fr;gap:18px;align-items:start}
.hnw-map{position:relative;aspect-ratio:1/1;border-radius:14px;overflow:hidden;background:radial-gradient(circle at 50% 50%,#0d0626 0%,#05010f 70%);border:1px solid var(--hnw-line)}
.hnw-map canvas{display:block;width:100%;height:100%}
.hnw-map-note{position:absolute;left:10px;right:10px;bottom:8px;font-size:.66rem;line-height:1.35;color:var(--hnw-dim);pointer-events:none}
.hnw-map-note b{color:var(--hnw-ink);font-weight:600}
.hnw-table{width:100%;border-collapse:collapse;font-size:.8rem;line-height:1.3}
.hnw-table th{font-family:var(--font-mono,ui-monospace,monospace);font-weight:600;font-size:.62rem;letter-spacing:.08em;text-transform:uppercase;color:var(--hnw-dim);text-align:left;padding:4px 8px;border-bottom:1px solid var(--hnw-line);white-space:nowrap}
.hnw-table td{padding:6px 8px;border-bottom:1px solid var(--hnw-line);vertical-align:top;font-variant-numeric:tabular-nums}
.hnw-table tr.hnw-row{cursor:pointer;transition:background .15s}
.hnw-table tr.hnw-row:hover,.hnw-table tr.hnw-row.sel{background:rgba(157,58,255,.12)}
.hnw-table .n{display:flex;align-items:center;gap:7px;font-weight:600;color:var(--hnw-ink);white-space:nowrap}
.hnw-table .n i{width:9px;height:9px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 6px currentColor}
.hnw-table .n a{color:inherit;text-decoration:none;border-bottom:1px dotted var(--hnw-line)}
.hnw-table .n a:hover{color:#8ff0ff}
.hnw-table .s{color:var(--hnw-dim);font-size:.7rem;display:block;margin-top:2px;white-space:nowrap}
.hnw-table .d{color:#8fb8e8;white-space:nowrap}
.hnw-table [data-c="trend"],.hnw-table [data-c="radec"],.hnw-table [data-c="size"]{white-space:nowrap}
.hnw-table .d .s.soi{color:var(--hnw-amber);white-space:normal}
.hnw-table .pha{color:var(--hnw-red);font-size:.62rem;font-weight:700;letter-spacing:.06em;margin-left:4px}
.hnw-table .soi{color:var(--hnw-amber)}
.hnw-empty{padding:18px 10px;color:var(--hnw-dim);font-size:.85rem;line-height:1.5}
.hnw-foot{margin-top:12px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:baseline;font-size:.72rem;color:var(--hnw-dim);line-height:1.5}
.hnw-foot a{color:#8ff0ff;font-weight:600;white-space:nowrap}
.hnw-foot a:hover{text-decoration:underline}
.hnw-foot .hnw-links{margin-left:auto;display:inline-flex;gap:16px}
@media (max-width:860px){.hnw-grid{grid-template-columns:1fr}.hnw-map{max-width:420px;margin:0 auto}.hnw-table th:nth-child(5),.hnw-table td:nth-child(5){display:none}}
@media (max-width:560px){.hnw-table th:nth-child(4),.hnw-table td:nth-child(4){display:none}.hnw-foot .hnw-links{margin-left:0}}
/* LIGHT THEME (html.theme-light — js/theme-light.css holds the --pl-* palette):
   the board's chrome and table go navy-on-white; the 2D plan view is a dark
   space plot by nature and stays dark inside its frame (its overlay note keeps
   the dark-ink values it is drawn against). */
html.theme-light .hnw{--hnw-ink:var(--pl-text-1);--hnw-dim:var(--pl-text-4);--hnw-line:var(--pl-border);
  --hnw-amber:var(--pl-warn);--hnw-red:var(--pl-danger);--hnw-ok:var(--pl-ok)}
html.theme-light .hnw-chip{background:var(--pl-card);box-shadow:0 1px 2px rgba(11,31,58,.05)}
html.theme-light .hnw-chip::before{box-shadow:none!important}
html.theme-light .hnw-map{--hnw-ink:#e9e4ff;--hnw-dim:#9d92c8;border-color:var(--pl-border-strong);box-shadow:var(--pl-shadow-hover)}
html.theme-light .hnw-table tr.hnw-row:hover,html.theme-light .hnw-table tr.hnw-row.sel{background:var(--pl-blue-soft)}
html.theme-light .hnw-table .n i{box-shadow:0 0 0 1px rgba(11,31,58,.18)}
html.theme-light .hnw-table .n a:hover{color:var(--pl-blue)}
html.theme-light .hnw-table .d{color:var(--pl-blue-deep)}
html.theme-light .hnw-foot a{color:var(--pl-blue)}
`;

/**
 * @param {HTMLElement} host
 * @param {object} [opts]
 * @param {string} [opts.catalogUrl='/api/neo/catalog']
 * @param {string[]} [opts.tiers=TIER_LADDER]  loaded in order; the last one wins
 * @param {number} [opts.limit=TOP_N]
 */
export function mountHomeNeoWatch(host, { catalogUrl = '/api/neo/catalog', tiers = TIER_LADDER, limit = TOP_N } = {}) {
    if (!host) return null;
    if (!document.getElementById('hnw-styles')) {
        const st = document.createElement('style'); st.id = 'hnw-styles'; st.textContent = CSS; document.head.appendChild(st);
    }
    host.innerHTML = `
      <div class="hnw" id="hnw">
        <div class="hnw-head">
          <span class="hnw-chip" data-chip>loading catalogue…</span>
          <span class="hnw-clock" data-clock></span>
          <span data-observer></span>
        </div>
        <div class="hnw-grid">
          <div class="hnw-map"><canvas aria-label="Plan view of the ten nearest near-Earth objects"></canvas>
            <div class="hnw-map-note" data-mapnote></div></div>
          <div>
            <table class="hnw-table" aria-live="off">
              <thead><tr><th>#</th><th>Object</th><th>Distance</th><th>Motion</th><th>Size · class</th><th>Where</th></tr></thead>
              <tbody data-rows></tbody>
            </table>
            <div class="hnw-empty" data-empty hidden></div>
          </div>
        </div>
        <div class="hnw-foot">
          <span data-caption></span>
          <span class="hnw-links">
            <a href="neo-watch.html" data-funnel-cta="home_neo_watch">Open the Near-Earth Watch →</a>
            <a href="solar-system.html" data-funnel-cta="home_neo_orrery">See them in the Solar System →</a>
          </span>
        </div>
      </div>`;
    const $ = (sel) => host.querySelector(sel);
    const chip = $('[data-chip]'), clockEl = $('[data-clock]'), obsEl = $('[data-observer]');
    const canvas = $('canvas'), mapNote = $('[data-mapnote]');
    const tbody = $('[data-rows]'), emptyEl = $('[data-empty]'), caption = $('[data-caption]');

    const S = {
        catalog: { state: 'loading', tier: null, count: 0, note: null },
        worker: null, workerState: 'off',
        frame: null, prevFrame: null, inFlight: false,
        meta: new Map(), metaWanted: new Set(),
        rows: [], selected: null,
        observer: null,
        visible: false, stopped: false,
        lastFrameAt: 0, lastClockAt: 0, raf: 0,
        points: [],
    };

    // ── Observer (the saved location every console on the site reads) ──
    function readObserver() {
        const loc = loadUserLocation();
        S.observer = loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lon))
            ? { latDeg: Number(loc.lat), lonDeg: Number(loc.lon), name: loc.city || loc.name || loc.displayName || null }
            : null;
        obsEl.textContent = S.observer ? `sky column for ${S.observer.name || `${S.observer.latDeg.toFixed(1)}°, ${S.observer.lonDeg.toFixed(1)}°`}` : 'save a location in the console above for your sky';
    }
    readObserver();
    window.addEventListener('user-location-changed', () => { readObserver(); renderRows(); });

    // ── Catalogue ──
    async function loadTier(tier) {
        let body;
        try {
            const res = await fetch(`${catalogUrl}?tier=${encodeURIComponent(tier)}`, { cache: 'no-cache' });
            body = await res.json();
        } catch (err) {
            if (!S.catalog.count) S.catalog = { state: 'down', tier, count: 0, note: err?.message || 'request failed' };
            renderChip();
            return false;
        }
        const rows = Array.isArray(body?.rows) ? body.rows : [];
        if (!rows.length || body.freshness !== 'live') {
            // The routes' contract for "JPL is not answering": 200 + freshness:'stale'.
            if (!S.catalog.count || rows.length) {
                S.catalog = { state: rows.length ? 'stale' : 'down', tier, count: rows.length, note: body?.degraded_reason || 'upstream unavailable' };
            }
            if (!rows.length) { renderChip(); return false; }
        } else {
            S.catalog = { state: 'live', tier, count: rows.length, note: body.tier_label || tierLabel(tier) };
        }
        loadRecords(rows.map(rowToRecord));
        renderChip();
        return true;
    }
    async function loadCatalogue() {
        for (const tier of tiers) {
            const ok = await loadTier(tier);
            if (!ok && tier === tiers[0]) break;         // the first tier failing: say so, do not hammer
            if (S.stopped) return;
        }
    }

    // ── Worker ──
    function startWorker() {
        try {
            S.worker = new Worker(WORKER_URL, { type: 'module' });
        } catch (err) {
            console.warn('[home-neo] module worker unsupported:', err?.message || err);
            S.worker = null; S.workerState = 'unsupported';
            return;
        }
        S.workerState = 'starting';
        S.worker.addEventListener('message', (ev) => onWorkerMsg(ev.data));
        S.worker.addEventListener('error', (err) => {
            console.warn('[home-neo] worker error:', err?.message || err);
            S.worker.terminate(); S.worker = null; S.workerState = 'failed'; S.inFlight = false;
            renderChip();
        });
    }
    function loadRecords(records) {
        S.meta.clear(); S.metaWanted.clear();
        if (!S.worker) return;
        S.worker.postMessage({ type: 'load', id: 1, records, reset: true });
    }
    function onWorkerMsg(msg) {
        if (!msg) return;
        if (msg.type === 'ready') { S.workerState = 'ready'; return; }
        if (msg.type === 'loaded') { S.workerState = 'loaded'; S.frame = null; S.prevFrame = null; S.lastFrameAt = 0; renderChip(); return; }
        if (msg.type === 'geoframe') {
            S.inFlight = false;
            S.prevFrame = S.frame;
            S.frame = { jd: msg.jd, geo: msg.geo, rHelio: msg.rHelio, rGeo: msg.rGeo, count: msg.count };
            requestMeta();
            buildRows();
            return;
        }
        if (msg.type === 'meta') {
            for (const o of msg.objects) S.meta.set(o.index, o);
            buildRows();
        }
    }
    function requestMeta() {
        if (!S.worker || !S.frame) return;
        const want = nearestIndices(S.frame, limit + 6, HORIZON_AU).filter((k) => !S.meta.has(k) && !S.metaWanted.has(k));
        if (!want.length) return;
        for (const k of want) S.metaWanted.add(k);
        S.worker.postMessage({ type: 'meta', id: 2, indices: want });
    }
    function requestFrame(jd) {
        if (!S.worker || S.inFlight || S.workerState !== 'loaded') return;
        S.inFlight = true;
        const e = earthHelioJ2000(jd);
        S.worker.postMessage({ type: 'geoframe', id: 3, jd, earth: [e.x, e.y, e.z] });
    }

    // ── Rows (every number through the kernel) ──
    function geocentricSpeed(el, jd) {
        if (!Number.isFinite(el?.om) || !Number.isFinite(el?.n) || !Number.isFinite(el?.t0)) return null;
        const p = propagate(el, jd, true);
        const ev = earthVelocityJ2000(jd);
        return Math.hypot(p.vx - ev.x, p.vy - ev.y, p.vz - ev.z) * AU_PER_DAY_TO_KMS;
    }
    function buildRows() {
        const f = S.frame;
        if (!f) return;
        const earth = earthHelioJ2000(f.jd);
        const rows = [];
        for (const k of nearestIndices(f, limit, HORIZON_AU)) {
            const el = S.meta.get(k);
            if (!el) continue;
            const o = k * 3;
            const geo = [f.geo[o], f.geo[o + 1], f.geo[o + 2]];
            const prev = S.prevFrame && S.prevFrame.count === f.count ? [S.prevFrame.geo[o], S.prevFrame.geo[o + 1], S.prevFrame.geo[o + 2]] : null;
            const row = buildObjectRow(el, {
                index: k, geo, rHelioAU: f.rHelio[k], earthRAU: earth.rAU, jd: f.jd,
                observer: S.observer, prevGeo: prev, prevDtDays: prev ? f.jd - S.prevFrame.jd : 0,
                vGeoKms: geocentricSpeed(el, f.jd),
            });
            const trend = prev ? approachTrend(Math.hypot(...prev) * AU_KM, row.distKm, f.jd - S.prevFrame.jd) : null;
            rows.push({ row, trend, summary: rowSummary(row, trend), plan: planPoint(geo[0], geo[1], geo[2]), tint: tintFor(row) });
        }
        S.rows = rows;
        renderRows();
        drawMap();
    }

    // ── DOM ──
    function renderChip() {
        const c = S.catalog;
        chip.className = 'hnw-chip ' + (c.state === 'live' ? 'live' : c.state === 'stale' ? 'stale' : c.state === 'down' ? 'down' : '');
        const n = c.count ? `${c.count.toLocaleString('en-US')} objects` : '';
        chip.textContent = c.state === 'loading' ? 'loading catalogue…'
            : c.state === 'down' ? `catalogue down · ${c.note || 'JPL unreachable'}`
                : c.state === 'stale' ? `stale · ${n}`
                    : S.workerState === 'unsupported' || S.workerState === 'failed' ? `live · ${n} · propagation unavailable`
                        : `live · JPL SBDB · ${n}`;
        caption.textContent = c.state === 'down'
            ? 'No positions are drawn while the catalogue is unreachable — nothing here is invented.'
            : `The ${limit} nearest of ${c.count ? c.count.toLocaleString('en-US') : '…'} catalogued ${c.tier ? tierLabel(c.tier) : 'objects'}, by two-body propagation of JPL's osculating elements at this instant (the same kernel the Solar System orrery and the Near-Earth Watch run). JPL's close-approach table remains the authority on flybys. Sizes from H assume a 0.14 albedo unless measured. Inside Earth's sphere of influence (${(soiRadiusKm(1) / LD_KM).toFixed(1)} LD) a heliocentric two-body position is the wrong model, and the row says so.`;
        mapNote.innerHTML = `<b>Plan view, ecliptic (J2000), Earth at the centre.</b> Radius is LOGARITHMIC — Earth's surface 1, the Moon ${MOON_SCENE} — so the Moon and 0.2 AU fit one frame; rings are the ruler. ▲ above / ▼ below the ecliptic. Dots are not to size.`;
        if (c.state === 'down' || (c.state !== 'loading' && !S.rows.length && S.frame)) {
            emptyEl.hidden = false;
            emptyEl.textContent = c.state === 'down' ? `Catalogue unreachable (${c.note || 'no answer'}).`
                : `${c.count.toLocaleString('en-US')} objects loaded, none inside ${HORIZON_AU} AU right now.`;
        } else emptyEl.hidden = true;
    }
    function renderRows() {
        const rows = S.rows;
        if (!rows.length) { tbody.innerHTML = ''; renderChip(); return; }
        emptyEl.hidden = true;
        // Update in place when the row SET is unchanged (a rebuild detaches the
        // row under the cursor — the Near-Earth Watch's own rule).
        const key = rows.map((r) => r.row.index).join(',');
        if (tbody.dataset.key !== key) {
            tbody.dataset.key = key;
            tbody.innerHTML = rows.map((r, i) => `
              <tr class="hnw-row${S.selected === r.row.index ? ' sel' : ''}" data-index="${r.row.index}" data-des="${esc(r.row.des)}">
                <td>${i + 1}</td>
                <td><span class="n"><i style="color:${r.tint};background:${r.tint}"></i><a href="neo-watch.html" title="Open in the Near-Earth Watch">${esc(r.row.name)}</a>${r.summary.hazard ? '<span class="pha">PHA</span>' : ''}</span><span class="s" data-c="cls"></span></td>
                <td class="d"><span data-c="dist"></span><span class="s" data-c="ld"></span></td>
                <td><span data-c="trend"></span><span class="s" data-c="v"></span></td>
                <td><span data-c="size"></span><span class="s" data-c="sizenote"></span></td>
                <td><span data-c="radec"></span><span class="s" data-c="sky"></span></td>
              </tr>`).join('');
            tbody.querySelectorAll('tr.hnw-row').forEach((tr) => {
                tr.addEventListener('click', (ev) => {
                    if (ev.target.closest('a')) return;
                    S.selected = Number(tr.dataset.index);
                    tbody.querySelectorAll('tr.hnw-row').forEach((t) => t.classList.toggle('sel', Number(t.dataset.index) === S.selected));
                    drawMap();
                });
            });
        }
        const trs = tbody.querySelectorAll('tr.hnw-row');
        rows.forEach((r, i) => {
            const tr = trs[i]; if (!tr) return;
            const s = r.summary;
            const set = (c, v) => { const el = tr.querySelector(`[data-c="${c}"]`); if (el && el.textContent !== v) el.textContent = v; };
            set('cls', s.cls);
            set('dist', s.dist);
            // Inside Earth's gravitational domain a heliocentric two-body position is the wrong model: say so on the row.
            const grip = r.row.encounter?.regime && r.row.encounter.regime !== 'heliocentric';
            set('ld', grip ? `${s.ld} LD · inside Earth's grip — two-body position unreliable` : `${s.ld} LD`);
            tr.querySelector('[data-c="ld"]').classList.toggle('soi', !!grip);
            set('trend', s.trend);
            set('v', r.row.vGeoKms != null ? `${r.row.vGeoKms.toFixed(1)} km/s rel. Earth` : '');
            set('size', s.size); set('sizenote', s.sizeNote ?? '');
            set('radec', s.radec);
            set('sky', s.sky ?? (s.mag ? `V ${s.mag}` : ''));

        });
    }

    // ── The plan view ──
    const ctx = canvas.getContext('2d');
    function drawMap() {
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const W = Math.max(1, Math.round(rect.width * dpr)), H = Math.max(1, Math.round(rect.height * dpr));
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const cx = W / 2, cy = H / 2;
        const extent = planExtent(S.rows.map((r) => r.plan));
        const k = (Math.min(W, H) * 0.46) / extent;       // scene units → px
        const px = (x) => cx + x * k, py = (y) => cy - y * k;   // +y (ecliptic) up
        const jd = S.frame?.jd ?? msToJd(Date.now());

        // Rings (the ruler) + labels.
        ctx.lineWidth = 1 * dpr;
        ctx.font = `${10 * dpr}px ${getComputedStyle(canvas).fontFamily}`;
        ctx.textBaseline = 'bottom';
        for (const ring of PLAN_RINGS) {
            if (ring.scene > extent) continue;
            ctx.beginPath(); ctx.arc(cx, cy, ring.scene * k, 0, Math.PI * 2);
            ctx.strokeStyle = ring.id === 'ld1' ? 'rgba(143,184,232,.45)' : 'rgba(157,146,200,.22)';
            ctx.setLineDash(ring.id === 'au005' ? [4 * dpr, 4 * dpr] : []);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(157,146,200,.75)';
            ctx.textAlign = 'left';
            ctx.fillText(ring.label, cx + ring.scene * k * 0.707 + 3 * dpr, cy - ring.scene * k * 0.707 - 2 * dpr);
        }
        // Sun direction.
        const sd = sunGeoDirectionJ2000(jd);
        const sh = Math.hypot(sd.x, sd.y) || 1;
        const sx = sd.x / sh, sy = sd.y / sh;
        ctx.strokeStyle = 'rgba(255,210,63,.55)'; ctx.lineWidth = 1.2 * dpr;
        ctx.beginPath(); ctx.moveTo(px(sx * 1.4), py(sy * 1.4)); ctx.lineTo(px(sx * extent * 0.98), py(sy * extent * 0.98)); ctx.stroke();
        ctx.fillStyle = 'rgba(255,210,63,.9)'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('☉ Sun', px(sx * extent * 0.9) - sy * 12 * dpr, py(sy * extent * 0.9) - sx * 12 * dpr);
        // Earth and the Moon (the Moon drawn at 0.2727 of the Earth: true ratio).
        ctx.fillStyle = '#4fa8ff';
        ctx.beginPath(); ctx.arc(cx, cy, Math.max(3 * dpr, 1 * k), 0, Math.PI * 2); ctx.fill();
        const m = moonGeoJ2000(jd);
        const mp = planPoint(m.x, m.y, m.z);
        ctx.fillStyle = '#d8d4c8';
        ctx.beginPath(); ctx.arc(px(mp.x), py(mp.y), Math.max(2 * dpr, 0.2727 * k), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(216,212,200,.8)'; ctx.textAlign = 'left';
        ctx.fillText('Moon', px(mp.x) + 6 * dpr, py(mp.y));
        // Gravity boundaries (live radii).
        const eR = earthHelioJ2000(jd).rAU;
        for (const [km, label] of [[soiRadiusKm(eR), 'SOI'], [hillRadiusKm(eR), 'Hill']]) {
            const r = planPoint(km / AU_KM, 0, 0).r;
            if (r > extent) continue;
            ctx.strokeStyle = 'rgba(255,210,63,.3)'; ctx.setLineDash([2 * dpr, 5 * dpr]);
            ctx.beginPath(); ctx.arc(cx, cy, r * k, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
            ctx.fillStyle = 'rgba(255,210,63,.6)'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
            ctx.fillText(label, cx - r * k * 0.707 - 3 * dpr, cy + r * k * 0.707 + 2 * dpr);
        }
        // The objects.
        S.points = [];
        ctx.textBaseline = 'middle';
        S.rows.forEach((r, i) => {
            const x = px(r.plan.x), y = py(r.plan.y);
            const sel = S.selected === r.row.index;
            ctx.fillStyle = r.tint; ctx.strokeStyle = r.tint; ctx.lineWidth = 1.2 * dpr;
            const rad = (sel ? 5 : 3.5) * dpr;
            ctx.beginPath();
            if (r.plan.above) { ctx.moveTo(x, y - rad * 1.3); ctx.lineTo(x + rad * 1.2, y + rad * 0.9); ctx.lineTo(x - rad * 1.2, y + rad * 0.9); ctx.closePath(); }
            else { ctx.moveTo(x, y + rad * 1.3); ctx.lineTo(x + rad * 1.2, y - rad * 0.9); ctx.lineTo(x - rad * 1.2, y - rad * 0.9); ctx.closePath(); }
            ctx.fill();
            if (sel) { ctx.beginPath(); ctx.arc(x, y, rad * 2.4, 0, Math.PI * 2); ctx.stroke(); }
            ctx.fillStyle = 'rgba(233,228,255,.9)'; ctx.textAlign = 'left';
            ctx.fillText(`${i + 1}`, x + rad * 1.6, y);
            S.points.push({ x, y, index: r.row.index });
        });
    }
    canvas.addEventListener('click', (ev) => {
        const rect = canvas.getBoundingClientRect();
        const dpr = canvas.width / Math.max(1, rect.width);
        const x = (ev.clientX - rect.left) * dpr, y = (ev.clientY - rect.top) * dpr;
        let best = null, bd = 18 * dpr;
        for (const p of S.points) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
        S.selected = best ? best.index : null;
        tbody.querySelectorAll('tr.hnw-row').forEach((t) => t.classList.toggle('sel', Number(t.dataset.index) === S.selected));
        drawMap();
    });

    // ── The loop: only while on screen ──
    function tick() {
        if (S.stopped) return;
        S.raf = 0;
        if (!S.visible) return;
        const now = performance.now();
        if (now - S.lastClockAt >= CLOCK_MS) {
            S.lastClockAt = now;
            clockEl.textContent = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
        }
        if (now - S.lastFrameAt >= FRAME_MS) { S.lastFrameAt = now; requestFrame(msToJd(Date.now())); }
        S.raf = requestAnimationFrame(tick);
    }
    const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
        for (const e of entries) {
            S.visible = e.isIntersecting;
            if (S.visible && !S.raf) { S.lastFrameAt = 0; tick(); }
        }
    }, { rootMargin: '200px 0px' }) : null;
    if (io) io.observe(host); else { S.visible = true; tick(); }
    window.addEventListener('resize', () => { if (S.visible) drawMap(); }, { passive: true });

    startWorker();
    renderChip();
    loadCatalogue();

    const handle = {
        get state() {
            return {
                catalog: { ...S.catalog }, workerState: S.workerState, visible: S.visible,
                frameJd: S.frame?.jd ?? null, count: S.frame?.count ?? 0,
                rows: S.rows.map((r) => ({ index: r.row.index, des: r.row.des, name: r.row.name, distLD: r.row.distLD, distKm: r.row.distKm,
                    above: r.plan.above, elevDeg: r.plan.elevDeg, planR: r.plan.r, regime: r.row.encounter?.regime ?? null, tint: r.tint, sky: r.row.sky })),
                selected: S.selected, observer: S.observer, points: S.points.length,
            };
        },
        refresh() { S.lastFrameAt = 0; S.visible = true; if (!S.raf) tick(); },
        select(index) { S.selected = index; renderRows(); drawMap(); },
        dispose() { S.stopped = true; io?.disconnect(); if (S.raf) cancelAnimationFrame(S.raf); S.worker?.terminate(); },
    };
    if (/[?&]debug=1(?:&|$)/.test(location.search)) window.__homeNeo = handle;
    return handle;
}
