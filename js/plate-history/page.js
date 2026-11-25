/**
 * page.js — plate-tectonics.html: the time bar, the readout, the probe, the views (DOM only).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PLATE_HISTORY_PLAN.md. ONE time `t` (Ma) drives everything: setTime(t) → the globe or map,
 * the chart cursor, the readout and the URL (?t=). Every number shown comes from the kernel
 * (js/plate-history/{rotations,frames,diagnostics}.js) or from data/plate-history/series.json,
 * which the kernel derived. Time runs LEFT = past → RIGHT = present on the scrubber and charts.
 */
import { createRotationModel, qRotate, qConj, unit, latLon } from './rotations.js';
import { decodeFrames, decodeShapes, frameIndexAt, plateAt, shapesAt } from './frames.js';
import { supercontinentIndex } from './diagnostics.js';
import { unitsAt, formatAge, ERAS, EONS } from './geotime.js';
import { renderCharts, renderTable } from './charts.js';

const BASE = 'data/plate-history/';
const $ = (id) => document.getElementById(id);
const state = { t: 0, view: 'globe', playing: false, dir: -1, rate: 40, lastFrame: 0 };

async function gzJson(name) {
    const r = await fetch(BASE + name);
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    // A host that sends Content-Encoding: gzip has already decompressed it: the MAGIC decides.
    const bytes = buf[0] === 0x1f && buf[1] === 0x8b
        ? new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
        : buf;
    return JSON.parse(new TextDecoder().decode(bytes));
}
async function csv(name) {
    const r = await fetch(BASE + 'published/' + name);
    if (!r.ok) return [];
    return (await r.text()).trim().split('\n').slice(1).map((l) => l.split(',').map(Number));
}

function setStatus(msg, err = false) {
    const s = $('pt-status');
    if (!s) return;
    s.textContent = msg; s.hidden = !msg; s.classList.toggle('is-err', err);
}

async function boot() {
    setStatus('Loading 1.8 billion years of plate motion…');
    const [rotDoc, framesDoc, shapesDoc, seriesDoc, meta, sub, mor] = await Promise.all([
        gzJson('rotations.json.gz'), gzJson('frames.json.gz'), gzJson('continents.json.gz'),
        fetch(BASE + 'series.json').then((r) => r.json()), fetch(BASE + 'meta.json').then((r) => r.json()),
        csv('SM3a_SUB_stats.csv'), csv('SM3b_MOR_stats.csv'),
    ]);
    const model = createRotationModel(rotDoc);
    const fr = decodeFrames(framesDoc);
    const shapes = decodeShapes(shapesDoc);
    const rows = seriesDoc.rows;
    const byT = new Map(rows.map((r) => [r.t, r]));
    const tMax = fr.tMaxMa;
    const published = new Map();
    for (const r of mor) published.set(r[0], { ...(published.get(r[0]) || {}), mor: r });
    for (const r of sub) published.set(r[0], { ...(published.get(r[0]) || {}), sub: r });

    // Views: the globe needs WebGL; without it the map is the page.
    let globe = null;
    const { PlateMap } = await import('./map.js');
    const map = new PlateMap($('pt-map'), { model, fr, shapes });
    try {
        const { PlateGlobe } = await import('./globe.js');
        globe = new PlateGlobe($('pt-globe'), { model, fr, shapes });
    } catch (e) {
        console.warn('plate-tectonics: no WebGL globe —', e);
        state.view = 'map';
        $('pt-view-globe').disabled = true;
        $('pt-view-globe').title = 'This browser could not start WebGL — the flat map shows the same reconstruction.';
    }
    const views = () => [globe, map].filter(Boolean);
    window.__plates = { model, fr, shapes, rows, globe, map, state, setTime: (t) => setTime(t) };

    // ── charts + table ──
    const charts = renderCharts($('pt-charts'), { rows, published, tMax, onScrub: (t) => { stop(); setTime(t); } });
    renderTable($('pt-table'), rows);

    // ── the scrubber (left = past) ──
    const slider = $('pt-slider');
    slider.max = String(tMax);
    slider.addEventListener('input', () => { stop(); setTime(tMax - Number(slider.value)); });
    buildEraBand($('pt-eras'), tMax);
    // Aim the globe at the continents' area-weighted centre at t — one-shot, on load and on a jump.
    const aimAtContinents = (t) => {
        if (!globe) return;
        const c = supercontinentIndex(shapesAt(model, shapes.continents, t)).centroid;
        if (c) { const ll = latLon(c); globe.lookAt(Math.max(-50, Math.min(50, ll.lat)), ll.lon); }
    };
    for (const b of document.querySelectorAll('[data-jump]')) b.addEventListener('click', () => { stop(); setTime(Number(b.dataset.jump)); aimAtContinents(state.t); });
    $('pt-play').addEventListener('click', () => (state.playing ? stop() : play()));
    $('pt-dir').addEventListener('click', () => {
        state.dir = -state.dir;
        $('pt-dir').textContent = state.dir < 0 ? 'Forward in time →' : '← Back in time';
        $('pt-dir').setAttribute('aria-label', state.dir < 0 ? 'Playing toward the present; switch to play into the past' : 'Playing into the past; switch to play toward the present');
    });
    $('pt-rate').addEventListener('change', () => { state.rate = Number($('pt-rate').value); });

    // ── layers + view switch ──
    for (const c of document.querySelectorAll('[data-layer]')) c.addEventListener('change', () => { for (const v of views()) v.setLayer(c.dataset.layer, c.checked); });
    const showView = (v) => {
        state.view = v;
        $('pt-globe').hidden = v !== 'globe'; $('pt-map').hidden = v !== 'map';
        $('pt-view-globe').setAttribute('aria-pressed', String(v === 'globe'));
        $('pt-view-map').setAttribute('aria-pressed', String(v === 'map'));
        $('pt-reset').hidden = v !== 'globe';
        (v === 'globe' ? globe : map)?.setTime(state.t);
    };
    $('pt-view-globe').addEventListener('click', () => globe && showView('globe'));
    $('pt-view-map').addEventListener('click', () => showView('map'));
    $('pt-reset').addEventListener('click', () => globe && globe.resetView());

    // ── probe ──
    let pinned = null;
    const probe = (h, pin = false) => {
        if (pin) pinned = h;
        const p = h || pinned;
        renderProbe(p);
        map.setMarker(p);
    };
    function renderProbe(p) {
        const box = $('pt-probe');
        if (!p) { box.hidden = true; return; }
        const frame = fr.frames[frameIndexAt(fr, state.t)];
        const pl = plateAt(fr, frame, p.lat, p.lon);
        const fmtLL = (la, lo) => `${Math.abs(la).toFixed(1)}°${la >= 0 ? 'N' : 'S'} ${Math.abs(lo).toFixed(1)}°${lo >= 0 ? 'E' : 'W'}`;
        let html = `<div class="pt-probe-h">${fmtLL(p.lat, p.lon)} <span class="pt-muted">at ${formatAge(state.t)}</span></div>`;
        if (!pl) {
            html += '<div class="pt-warn">No plate here in the model at this time — its plate topology does not close (the model\'s own gap, not filled in).</div>';
        } else {
            const v = model.velocity(pl.p, state.t, p.lat, p.lon);
            const iv = model.velocityInterval(pl.p, state.t);
            html += `<div><b>${escapeHtml(pl.n || 'Unnamed plate')}</b> <span class="pt-muted">plate ${pl.p}</span></div>`;
            html += Number.isFinite(v.speed)
                ? `<div>Moving <b>${v.speed.toFixed(0)} mm/yr</b> toward ${compass(v.azimuth)} (${v.azimuth.toFixed(0)}°)${iv.side === 'older' || iv.side === 'younger' ? ' <span class="pt-muted">· taken beside a rotation jump</span>' : ''}</div>`
                : '<div class="pt-muted">Velocity undefined here: the rotation jumps on both sides of this instant.</div>';
            html += `<div>Palaeolatitude <b>${Math.abs(p.lat).toFixed(1)}°${p.lat >= 0 ? 'N' : 'S'}</b> <span class="pt-muted">(constrained by palaeomagnetism)</span></div>`;
            if (state.t > 0) {
                const now = latLon(qRotate(qConj(model.total(pl.p, state.t)), unit(p.lat, p.lon)));
                html += `<div class="pt-muted">This plate carries the point to ${fmtLL(now.lat, now.lon)} today — if the crust survives (ocean floor older than ~200 Ma has all been subducted).</div>`;
            }
        }
        box.innerHTML = html; box.hidden = false;
    }
    for (const v of views()) { v.onHover = (h) => probe(h); v.onPick = (h) => probe(h, true); }

    // ── time ──
    let urlTimer = 0;
    function setTime(t) {
        t = Math.max(0, Math.min(tMax, Math.round(t * 10) / 10));
        state.t = t;
        slider.value = String(tMax - t);
        slider.setAttribute('aria-valuetext', formatAge(t));
        (state.view === 'globe' ? globe : map)?.setTime(t);
        charts.setTime(t);
        renderReadout(t);
        if (pinned) renderProbe(pinned);
        clearTimeout(urlTimer);
        urlTimer = setTimeout(() => { const u = new URL(location.href); u.searchParams.set('t', String(Math.round(t))); history.replaceState(null, '', u); }, 250);
    }
    function renderReadout(t) {
        const u = unitsAt(t), row = byT.get(Math.round(t / 5) * 5);
        $('pt-age').textContent = formatAge(t);
        $('pt-unit').textContent = [u.period?.name, u.era?.name, u.eon?.name].filter(Boolean).join(' · ');
        const cells = [
            ['Plates', row.plates], ['Spreading ridges', `${row.ridgeKm.toLocaleString()} km`], ['Subduction zones', `${row.trenchKm.toLocaleString()} km`],
            ['Plate speed (RMS)', `${row.rmsSpeedMmYr} mm/yr`], ['Supercontinent index', row.supercontinentIndex.toFixed(2)],
        ];
        $('pt-stats').innerHTML = cells.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
        const gap = row.noPlateFrac > 0.02;
        $('pt-gap').hidden = !gap;
        if (gap) $('pt-gap').textContent = `Model topology gap at ${row.t} Ma: ${(100 * row.noPlateFrac).toFixed(0)} % of the globe in no plate (hatched).`;
    }

    // ── playback (wall clock; Myr per second) ──
    function play() {
        if (state.dir < 0 && state.t <= 0) setTime(tMax);
        if (state.dir > 0 && state.t >= tMax) setTime(0);
        state.playing = true; state.lastFrame = performance.now();
        $('pt-play').textContent = 'Pause'; $('pt-play').setAttribute('aria-pressed', 'true');
        requestAnimationFrame(step);
    }
    function stop() {
        state.playing = false;
        $('pt-play').textContent = 'Play'; $('pt-play').setAttribute('aria-pressed', 'false');
    }
    function step(now) {
        if (!state.playing) return;
        const dt = Math.min(0.25, (now - state.lastFrame) / 1000); state.lastFrame = now;
        const t = state.t + state.dir * state.rate * dt;
        setTime(t);
        if (t <= 0 || t >= tMax) { stop(); return; }
        requestAnimationFrame(step);
    }
    document.addEventListener('keydown', (ev) => {
        if (ev.target.closest('input, select, textarea, button')) return;
        if (ev.key === ' ') { ev.preventDefault(); state.playing ? stop() : play(); }
    });

    // Provenance line from the bake's own meta.
    $('pt-prov').textContent = `Reconstruction: Cao et al. 1.8 Ga full-plate model, extending Merdith et al. (2021) — ${meta.source.licence}. `
        + `Baked with pygplates ${meta.pygplates} every ${meta.stepMa} Myr (${meta.counts.frames} frames, ${meta.counts.rotationSequences} rotation sequences, ${meta.counts.continents} continental polygons).`;

    const q = Number(new URL(location.href).searchParams.get('t'));
    showView(state.view);
    setTime(Number.isFinite(q) && q > 0 ? q : 0);
    aimAtContinents(state.t);
    setStatus('');
    document.body.dataset.ptReady = '1';
}

function buildEraBand(host, tMax) {
    const pct = (t) => (100 * (1 - t / tMax)).toFixed(3);
    const rows = [['pt-eon', EONS], ['pt-era', ERAS]];
    host.innerHTML = rows.map(([cls, table]) => `<div class="pt-band-row ${cls}">${table.filter((r) => r[2] < tMax).map((r) => {
        const base = Math.min(r[1], tMax), top = r[2];
        const left = pct(base), width = (100 * (base - top) / tMax).toFixed(3);
        return `<span style="left:${left}%;width:${width}%" title="${r[0]} ${formatAge(base)}–${formatAge(top)}">${width > 7 ? r[0] : ''}</span>`;
    }).join('')}</div>`).join('');
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (az) => COMPASS[Math.round(az / 22.5) % 16];
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

boot().catch((e) => {
    console.error(e);
    setStatus(`The reconstruction could not load (${e.message}). Nothing is drawn rather than a guess.`, true);
    document.body.dataset.ptReady = 'error';
});
