/**
 * neo-worker.js — module Web Worker that propagates the whole near-Earth
 * object catalogue for solar-system.html, off the render thread.
 *
 * Holds the population as struct-of-arrays columns (js/neo-orbits.js
 * `prepareColumns`) and, on every `frame` request, solves Kepler for every
 * object at the requested Julian Day and ships back three transferable
 * typed arrays: scene positions (the page's log radial scale, ecliptic of
 * date, axis-swapped), heliocentric distance, and geocentric distance. The
 * main thread does no orbital arithmetic for the population at all — 38 000
 * Newton solves per frame would cost it 30–60 ms.
 *
 * The frame rotation (J2000 elements → the orrery's ecliptic of date) is
 * applied HERE via `precessionLongitudeRad`, once per frame, so the main
 * thread's Earth (VSOP87D, of date) and every object share a frame — see the
 * kernel header for why that is 2.5 lunar distances of flyby geometry.
 *
 * ── Messages ───────────────────────────────────────────────────────────────
 *   in  { type:'load', id, records:[…], reset?:boolean }
 *       Append (or replace, with reset) a batch of catalogue records.
 *   out { type:'loaded', id, count, rejected:{reason:n}, ms }
 *
 *   in  { type:'frame', id, jd, earth:[x,y,z] }         Earth: AU, ecliptic OF DATE
 *   out { type:'frame', id, jd, count, scene:Float32Array(3N), rHelio:Float32Array(N),
 *         rGeo:Float32Array(N), ms }                     buffers transferred, not copied
 *
 *   in  { type:'track', id, index, jd, days, steps, earthAt:[[x,y,z]…] }
 *       Geocentric track of ONE object: `steps` samples across ±`days` around
 *       jd, Earth's of-date position supplied per sample by the main thread
 *       (VSOP87D lives there; the worker stays kernel-only).
 *   out { type:'track', id, index, geo:Float32Array(3·steps), jd0, dtDays }
 *
 *   out { type:'ready' }        on start
 *   out { type:'error', id, error }
 *
 * The worker is stateless with respect to time: the same (catalogue, jd,
 * earth) always yields the same bytes.
 */

import {
    prepareColumns, propagateColumns, deriveFrames, precessionLongitudeRad,
    perifocalBasis, perifocalState,
} from './neo-orbits.js';

let els = [];               // surviving element records, index-aligned with cols
let cols = null;            // typed columns
let helio = null;           // Float64Array(3N), J2000 AU — reused across frames
let rejectedTotal = {};

function rebuild(records) {
    const prep = prepareColumns(records);
    els = prep.els;
    cols = prep.cols;
    helio = new Float64Array(cols.count * 3);
    rejectedTotal = prep.rejected;
}

function onLoad(msg) {
    const t0 = performance.now();
    const incoming = Array.isArray(msg.records) ? msg.records : [];
    if (msg.reset || !cols) {
        rebuild(incoming);
    } else {
        // Append: re-prepare the union. Simpler than growing typed arrays
        // in place, and loads are rare (one per tier).
        const merged = els.map(el => el).concat(incoming);
        const prep = prepareColumns(merged);
        for (const [k, v] of Object.entries(prep.rejected)) rejectedTotal[k] = (rejectedTotal[k] || 0) + v;
        els = prep.els; cols = prep.cols; helio = new Float64Array(cols.count * 3);
    }
    postMessage({ type: 'loaded', id: msg.id, count: cols.count, rejected: { ...rejectedTotal }, ms: performance.now() - t0 });
}

function onFrame(msg) {
    const t0 = performance.now();
    const N = cols ? cols.count : 0;
    const scene = new Float32Array(N * 3);
    const rHelio = new Float32Array(N);
    const rGeo = new Float32Array(N);
    if (N) {
        propagateColumns(cols, msg.jd, helio);
        deriveFrames(helio, N, msg.earth, scene, rHelio, rGeo, precessionLongitudeRad(msg.jd));
    }
    postMessage(
        { type: 'frame', id: msg.id, jd: msg.jd, count: N, scene, rHelio, rGeo, ms: performance.now() - t0 },
        [scene.buffer, rHelio.buffer, rGeo.buffer],
    );
}

function onTrack(msg) {
    const el = els[msg.index];
    const steps = Math.max(2, msg.steps | 0);
    const geo = new Float32Array(steps * 3);
    if (el) {
        const B = perifocalBasis(el.i, el.om, el.w);
        const dt = (2 * msg.days) / (steps - 1);
        const jd0 = msg.jd - msg.days;
        for (let k = 0; k < steps; k++) {
            const jd = jd0 + k * dt;
            const s = perifocalState(el, jd);
            const x0 = B.Px * s.xp + B.Qx * s.yp;
            const y0 = B.Py * s.xp + B.Qy * s.yp;
            const z  = B.Pz * s.xp + B.Qz * s.yp;
            const p = precessionLongitudeRad(jd);
            const c = Math.cos(p), sn = Math.sin(p);
            const x = c * x0 - sn * y0, y = sn * x0 + c * y0;
            const e = msg.earthAt[k] || msg.earthAt[msg.earthAt.length - 1] || [0, 0, 0];
            geo[k * 3] = x - e[0]; geo[k * 3 + 1] = y - e[1]; geo[k * 3 + 2] = z - e[2];
        }
        postMessage({ type: 'track', id: msg.id, index: msg.index, geo, jd0, dtDays: dt }, [geo.buffer]);
    } else {
        postMessage({ type: 'track', id: msg.id, index: msg.index, geo, jd0: msg.jd, dtDays: 0 }, [geo.buffer]);
    }
}

self.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    try {
        if (msg.type === 'load') onLoad(msg);
        else if (msg.type === 'frame') onFrame(msg);
        else if (msg.type === 'track') onTrack(msg);
    } catch (err) {
        postMessage({ type: 'error', id: msg.id, error: err?.message || String(err) });
    }
});

postMessage({ type: 'ready' });
