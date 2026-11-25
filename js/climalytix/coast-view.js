/**
 * climalytix/coast-view.js — the Coast card on climalytix.html. It DRAWS and
 * FETCHES; every number is js/climalytix/coast.js (shore geometry, waves,
 * breaking, tide) on two inputs:
 *
 *   · the ELEVATION around the site — the page's own /api/climalytix/dem
 *     tiles, sampled onto a fixed ±33 km window (independent of where the map
 *     is looking), which is where the shore and the way it faces come from
 *   · /api/climalytix/marine — waves, sea temperature, modelled sea level
 *     (BOOTSTRAP, badged)
 *
 * RULES:
 *   · An INLAND site has no Coast card at all — not an empty one.
 *   · Feeds fail independently and the card says which: no elevation ⇒ the
 *     sea state is still shown but nothing that needs the shore's direction
 *     (wave angle, drift, onshore/offshore) is; no marine data ⇒ the shore
 *     is still described and the sea state says why it is missing. Nothing
 *     is substituted for either.
 *   · Breaking and runup are quoted as a RANGE over coast.js `SLOPE_RANGE`,
 *     because no dataset here resolves a beach's slope.
 *   · Times are the SITE's local time (deps.utcOffsetS), never the reader's.
 *   · Markup is rebuilt only when data changes; there are no inputs inside.
 */

import {
    shoreFromGrid, coastWindow, surfReport, tideNow, tideExtrema, SLOPE_RANGE, COAST_KM, SOURCES, wrap360,
} from './coast.js';
import { marinePath, marineAt, MARINE_MAX_CELL_KM } from './marine-request.js';
import { tilesFor, tileSampler, sampleGrid, demPath, compass16 } from './terrain.js';

const DEM_Z = 9;              // ~300 m pixels: finer than the 690 m grid the shore is read on
const GRID_N = 97;
const H = 3_600_000;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function loadTile(t) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const c = document.createElement('canvas');
                c.width = img.naturalWidth; c.height = img.naturalHeight;
                const cx = c.getContext('2d', { willReadFrequently: true });
                cx.drawImage(img, 0, 0);
                resolve(c.width === 256 && c.height === 256 ? cx.getImageData(0, 0, 256, 256).data : null);
            } catch { resolve(null); }
        };
        img.onerror = () => resolve(null);
        img.src = demPath(t);
    });
}

/** The elevation window around a site, as a terrain.js grid — or null when no tile loaded. */
async function loadCoastGrid(site) {
    const box = coastWindow(site);
    const tiles = tilesFor(box, DEM_Z);
    const data = await Promise.all(tiles.map(loadTile));
    const have = new Map();
    tiles.forEach((t, i) => { if (data[i]) have.set(`${t.z}/${t.x}/${t.y}`, data[i]); });
    if (!have.size) return null;
    return sampleGrid(box, GRID_N, GRID_N, tileSampler(DEM_Z, (z, x, y) => have.get(`${z}/${x}/${y}`) || null));
}

export function mountCoast(root, deps) {
    const C = { token: 0, site: null, shore: null, shoreState: 'idle', marine: null, marineState: 'idle', marineWhy: '' };

    async function setSite(site) {
        const token = ++C.token;
        Object.assign(C, { site, shore: null, shoreState: site ? 'loading' : 'idle', marine: null, marineState: site ? 'loading' : 'idle', marineWhy: '' });
        render();
        if (!site) return;
        loadCoastGrid(site).then((grid) => {
            if (token !== C.token) return;
            C.shore = grid ? shoreFromGrid(grid, site) : null;
            C.shoreState = !grid ? 'down' : C.shore.state;
            render();
        });
        fetch(marinePath(site), { headers: { Accept: 'application/json' } })
            .then((r) => (r.ok ? r.json() : null)).catch(() => null)
            .then((body) => {
                if (token !== C.token) return;
                if (body?.series && Array.isArray(body.times)) { C.marine = body; C.marineState = body.freshness === 'live' ? 'ok' : 'far'; }
                else { C.marineState = 'down'; C.marineWhy = (body?.reasons || [])[0] || 'feed_down'; }
                render();
            });
    }

    /** Is this a coast? Yes if the elevation says so; if elevation is unavailable, a nearby sea cell is the evidence. */
    function visible() {
        if (!C.site) return false;
        if (C.shoreState === 'coastal') return true;
        if (C.shoreState === 'down' || C.shoreState === 'unknown') return C.marineState === 'ok';
        return false;                                      // inland, or still loading
    }

    const hgt = (m) => deps.fmtText('height', m, { dp: 1 });
    const clock = (ms) => {
        const d = new Date(ms + deps.utcOffsetS() * 1000);
        return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    };
    const dir = (deg) => (deg == null ? '—' : `${compass16(wrap360(deg))} (${Math.round(wrap360(deg))}°)`);

    function tideChart(now) {
        const b = C.marine;
        const t0 = now - 6 * H, t1 = now + 42 * H;
        const pts = [];
        b.times.forEach((t, i) => { const v = b.series.seaLevelM[i]; if (t >= t0 && t <= t1) pts.push(v == null ? null : [t, v]); });
        const vals = pts.filter(Boolean).map((p) => p[1]);
        if (vals.length < 6) return '';
        const lo = Math.min(...vals), hi = Math.max(...vals), pad = Math.max(0.05, (hi - lo) * 0.12);
        const W = 640, Ht = 110, x = (t) => ((t - t0) / (t1 - t0)) * W, y = (v) => Ht - 14 - ((v - (lo - pad)) / (hi - lo + 2 * pad)) * (Ht - 24);
        let d = '', pen = false;
        for (const p of pts) { if (!p) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`; pen = true; }
        const marks = tideExtrema(b.times, b.series.seaLevelM).filter((e) => e.t >= t0 && e.t <= t1)
            .map((e) => `<g class="cx-co-ex" data-kind="${e.kind}"><circle cx="${x(e.t).toFixed(1)}" cy="${y(e.level).toFixed(1)}" r="3"/>`
                + `<text x="${Math.min(W - 30, Math.max(30, x(e.t))).toFixed(1)}" y="${(e.kind === 'high' ? y(e.level) - 7 : y(e.level) + 14).toFixed(1)}">${esc(clock(e.t).slice(4))}</text></g>`).join('');
        return `<svg class="cx-co-tide" viewBox="0 0 ${W} ${Ht}" role="img" aria-label="Modelled sea level, 6 hours back to 42 hours ahead, with high and low water marked">`
            + (lo < 0 && hi > 0 ? `<line class="cx-co-zero" x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"/>` : '')
            + `<path class="cx-co-line" d="${d}"/>${marks}`
            + `<line class="cx-co-now" x1="${x(now).toFixed(1)}" x2="${x(now).toFixed(1)}" y1="4" y2="${Ht - 4}"/></svg>`;
    }

    function render() {
        const show = visible();
        root.hidden = !show;
        root.dataset.shore = C.shoreState;
        root.dataset.marine = C.marineState;
        deps.onState?.(state());
        if (!show) return;
        const now = Date.now(), s = C.shore, b = C.marine;
        const normal = s?.normalDeg ?? null;

        // ── the shore ──
        let shore;
        if (C.shoreState === 'coastal') {
            const where = s.onWater ? `on the water, ${deps.fmtText('distance', s.distanceKm * 1000)} from land`
                : s.distanceKm < s.resKm ? 'at the shore' : `${deps.fmtText('distance', s.distanceKm * 1000)} from the shore${s.bearingDeg == null ? '' : `, to the ${compass16(s.bearingDeg)}`}`;
            shore = `<p class="cx-co-lead" data-co="shore">This site is <b>${esc(where)}</b>`
                + (normal == null ? '.' : `; the coast here faces <b>${esc(dir(normal))}</b>.`) + '</p>'
                + `<p class="cx-co-note">Shoreline read from elevation tiles on a ${s.resKm.toFixed(1)} km grid: “water” is ground at or below sea level, so a polder reads as sea and a lake above sea level as land. The facing is the average over a few kilometres of coast, not one beach.</p>`;
        } else {
            shore = '<p class="cx-co-note" data-co="shore">Elevation tiles unavailable — the shore’s position and facing are not shown, and nothing below that needs them is.</p>';
        }

        // ── the sea ──
        let sea = '', tide = '', surf = '';
        if (b) {
            const at = (k) => marineAt(b, k, now);
            const now_ = { waveM: at('waveM'), wavePeriodS: at('wavePeriodS'), waveDirDeg: at('waveDirDeg'), swellM: at('swellM'), swellPeriodS: at('swellPeriodS'), swellDirDeg: at('swellDirDeg'), sstC: at('sstC') };
            const wind = deps.windNow?.() || {};
            const r = surfReport(now_, { normalDeg: normal }, wind);
            const tile = (key, label, value, sub = '') => `<div class="cx-co-tile" data-co="${key}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`;
            sea = '<div class="cx-co-tiles">'
                + tile('wave', 'Waves', esc(hgt(now_.waveM)), now_.wavePeriodS == null ? '' : `${now_.wavePeriodS.toFixed(0)} s · from ${esc(dir(now_.waveDirDeg))}${r.seaState ? ` · ${r.seaState}` : ''}`)
                + tile('swell', 'Swell', esc(hgt(now_.swellM)), now_.swellPeriodS == null ? '' : `${now_.swellPeriodS.toFixed(0)} s · from ${esc(dir(now_.swellDirDeg))}`)
                + tile('sst', 'Sea temperature', esc(deps.fmtText('temp', now_.sstC)))
                + tile('power', 'Wave power', r.fluxKwM == null ? '—' : `${r.fluxKwM < 10 ? r.fluxKwM.toFixed(1) : Math.round(r.fluxKwM)} kW/m`, r.wavelengthM == null ? '' : `deep-water wavelength ${esc(deps.fmtText('height', r.wavelengthM))}`)
                + '</div>';

            const lines = [];
            if (r.breakerM != null) {
                const types = [...new Set(r.perSlope.map((p) => p.type))];
                lines.push(`<li data-co="breaker">Breakers of about <b>${esc(hgt(r.breakerM))}</b>, breaking in roughly ${esc(hgt(r.breakerDepthM))} of water — <b>${types.join(' to ')}</b> across beach slopes of 1:${Math.round(1 / SLOPE_RANGE[0])} to 1:${Math.round(1 / SLOPE_RANGE[1])}.</li>`);
                if (r.runupM) lines.push(`<li data-co="runup">Wave run-up above the still water line: about <b>${esc(hgt(r.runupM[0]))} to ${esc(hgt(r.runupM[1]))}</b> over the same slopes.</li>`);
            }
            if (normal != null && r.wave) {
                lines.push(r.reachesShore
                    ? `<li data-co="angle">The waves arrive <b>${Math.abs(r.wave.angle) < 15 ? 'almost head-on' : `${Math.round(Math.abs(r.wave.angle))}° off head-on`}</b>${r.drift?.towardDeg == null ? '' : `, pushing sand and water along the shore toward the <b>${compass16(r.drift.towardDeg)}</b>`}.</li>`
                    : '<li data-co="angle">The open-sea waves here are travelling <b>away from this coast</b> — it is in their lee, and what reaches the beach is less than the figure above.</li>');
                if (r.wind) lines.push(`<li data-co="wind">The wind is <b>${r.wind}</b>${wind.speedMs == null ? '' : ` at ${esc(deps.fmtText('wind', wind.speedMs))}`} — ${r.wind === 'offshore' ? 'blowing from the land, which holds wave faces up and flattens the chop' : r.wind === 'onshore' ? 'blowing from the sea, which adds chop and pushes water up the beach' : 'blowing along the shore'}.</li>`);
            }
            surf = lines.length ? `<ul class="cx-co-list">${lines.join('')}</ul>` : '';

            const t = tideNow(b.times, b.series.seaLevelM, now);
            if (t) {
                const nx = [t.nextHigh && `high water ${esc(clock(t.nextHigh.t))} (${esc(hgt(t.nextHigh.level))})`, t.nextLow && `low water ${esc(clock(t.nextLow.t))} (${esc(hgt(t.nextLow.level))})`]
                    .filter(Boolean).sort((p, q) => (t.nextHigh && t.nextLow && t.nextLow.t < t.nextHigh.t ? (p.startsWith('low') ? -1 : 1) : 0));
                tide = `<div class="cx-co-tide-wrap" data-co="tide"><p class="cx-co-lead">Sea level is <b>${esc(hgt(t.level))}</b> against mean sea level and <b>${t.trend}</b>`
                    + (nx.length ? ` — next ${nx.join(', then ')}` : '') + (t.range == null ? '' : `; this tide’s range is ${esc(hgt(t.range))}`) + '. Times are local to the site.</p>'
                    + tideChart(now) + '</div>';
            } else {
                tide = '<p class="cx-co-note" data-co="tide">No modelled sea level for this cell — the tide is not shown.</p>';
            }
        }
        const why = { no_marine_data_here: 'the wave model has no sea cell here', feed_down: 'the marine feed is unreachable right now' }[C.marineWhy] || String(C.marineWhy).replace(/_/g, ' ');
        const seaState = C.marineState === 'loading' ? '<p class="cx-co-note" data-co="sea">Loading the sea state…</p>'
            : C.marineState === 'down' ? `<p class="cx-co-warn" data-co="sea">Sea state unavailable — ${esc(why)}. Nothing is substituted for it.</p>`
            : C.marineState === 'far' ? `<p class="cx-co-warn" data-co="sea">The nearest sea cell in the wave model is ${Math.round(b.site.cell_distance_km)} km away (more than ${MARINE_MAX_CELL_KM} km) — read the figures below as the open sea in that direction, not this coast.</p>` : '';

        root.querySelector('#cx-coast-body').innerHTML = shore + seaState + sea + surf + tide
            + (b ? `<p class="cx-co-note" data-co="source">Sea state: ${esc(b.source)} — model output for a sea cell ${b.site.cell_distance_km == null ? 'near' : `${b.site.cell_distance_km} km from`} the site, not a measurement at the beach and not a tide gauge.`
                + ` Breaker height: ${SOURCES.breakerHeight.cite}; breaker type: ${SOURCES.breakerClass.cite}; run-up: ${SOURCES.runup.cite}. These are estimates for an open, straight beach — not a safety forecast.`
                + (b.missing?.length ? ` Not provided by the model here: ${esc(b.missing.join(', '))}.` : '') + '</p>' : '');
    }

    function state() {
        const now = Date.now(), b = C.marine;
        return {
            visible: visible(), shoreState: C.shoreState, marineState: C.marineState, marineWhy: C.marineWhy || null,
            shore: C.shore, coastKm: COAST_KM,
            now: b ? { waveM: marineAt(b, 'waveM', now), wavePeriodS: marineAt(b, 'wavePeriodS', now), waveDirDeg: marineAt(b, 'waveDirDeg', now), sstC: marineAt(b, 'sstC', now) } : null,
            tide: b ? tideNow(b.times, b.series.seaLevelM, now) : null,
        };
    }

    return { setSite, refresh: render, get state() { return state(); } };
}
