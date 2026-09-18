/**
 * neo-worker.js — module Web Worker that propagates the whole near-Earth
 * object catalogue off the render thread, for BOTH consumers that want it.
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
 *   in  { type:'geoframe', id, jd, earth:[x,y,z] }      Earth: AU, ecliptic J2000
 *   out { type:'geoframe', id, jd, count, geo:Float32Array(3N), rHelio:Float32Array(N),
 *         rGeo:Float32Array(N), ms }                     buffers transferred, not copied
 *
 *       The GEOCENTRIC answer, for neo-watch.html. Note the frame difference
 *       in the request: `frame` takes Earth OF DATE and rotates the objects
 *       forward to meet it (the orrery's planets are VSOP87D, of date);
 *       `geoframe` takes Earth already rotated BACK to J2000 (js/neo-space.js
 *       `earthHelioJ2000`) and rotates nothing, because a geocentric stage has
 *       no of-date content in it to match. Same propagation, same catalogue,
 *       one load — the two pages differ only in what they ask for at the end.
 *
 *   in  { type:'track', id, index, jd, days, steps, earthAt:[[x,y,z]…] }
 *       Geocentric track of ONE object: `steps` samples across ±`days` around
 *       jd, Earth's of-date position supplied per sample by the main thread
 *       (VSOP87D lives there; the worker stays kernel-only).
 *   out { type:'track', id, index, geo:Float32Array(3·steps), jd0, dtDays }
 *
 *   in  { type:'geotrack', id, index, jd, days, steps, earthAt:[[x,y,z]…] }
 *       The same track with Earth supplied in J2000 and no forward rotation —
 *       the sampled distance curve neo-space.js `findApproach` minimises.
 *   out { type:'geotrack', id, index, geo:Float32Array(3·steps), jd0, dtDays }
 *
 *   in  { type:'meta', id, indices:[…] }
 *       Element metadata (H, class, diameter, flags, epoch) for selected
 *       objects, so a consumer can rank and label a row without the main
 *       thread holding a second copy of the catalogue.
 *   out { type:'meta', id, objects:[{ index, des, name, H, cls, … }] }
 *
 *   out { type:'ready' }        on start
 *   out { type:'error', id, error }
 *
 * The worker is stateless with respect to time: the same (catalogue, jd,
 * earth) always yields the same bytes.
 */

// Everything here comes from the ONE kernel. In particular `deriveGeocentric`
// lives in neo-orbits.js beside `deriveFrames` rather than in the geocentric
// kernel that owns the rest of neo-watch.html's rules, precisely so this
// worker's dependency graph does not grow: js/neo-space.js pulls in the
// VSOP87D + Meeus ephemeris modules (73 KB) that a worker propagating
// osculating elements has no use for. neo-space.js re-exports it.
import {
    prepareColumns, propagateColumns, deriveFrames, deriveGeocentric,
    precessionLongitudeRad, perifocalBasis, perifocalState,
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

/**
 * The geocentric answer. Identical propagation to `onFrame`; the difference is
 * entirely at the end, where the objects are differenced against a J2000 Earth
 * instead of being rotated forward to meet an of-date one.
 */
function onGeoFrame(msg) {
    const t0 = performance.now();
    const N = cols ? cols.count : 0;
    const geo = new Float32Array(N * 3);
    const rHelio = new Float32Array(N);
    const rGeo = new Float32Array(N);
    if (N) {
        propagateColumns(cols, msg.jd, helio);
        deriveGeocentric(helio, N, msg.earth, geo, rHelio, rGeo);
    }
    postMessage(
        { type: 'geoframe', id: msg.id, jd: msg.jd, count: N, geo, rHelio, rGeo, ms: performance.now() - t0 },
        [geo.buffer, rHelio.buffer, rGeo.buffer],
    );
}

/**
 * Metadata for the objects the caller has selected, by index into `els`.
 * The geocentric page needs H, class, diameter and the flags to draw and rank
 * a row, and re-shipping the whole catalogue to the main thread to get them
 * would defeat the point of holding it here.
 */
function onMeta(msg) {
    const out = [];
    for (const idx of (msg.indices || [])) {
        const el = els[idx];
        if (!el) continue;
        out.push({
            index: idx, des: el.des, name: el.name, H: el.H, cls: el.cls,
            flags: el.flags, moid: el.moid, diam: el.diam, epoch: el.epoch,
            e: el.e, a: el.a, q: el.q, Q: el.Q, i: el.i, per_y: el.per_y,
        });
    }
    postMessage({ type: 'meta', id: msg.id, objects: out });
}

/**
 * Geocentric distance of ONE object across a window — the input to
 * neo-space.js `findApproach`. Earth's J2000 position is supplied per sample
 * by the main thread, which is where the ephemeris lives.
 */
function onGeoTrack(msg) {
    const el = els[msg.index];
    const steps = Math.max(2, msg.steps | 0);
    const geo = new Float32Array(steps * 3);
    const dt = (2 * msg.days) / (steps - 1);
    const jd0 = msg.jd - msg.days;
    if (el) {
        const B = perifocalBasis(el.i, el.om, el.w);
        for (let k = 0; k < steps; k++) {
            const s = perifocalState(el, jd0 + k * dt);
            const x = B.Px * s.xp + B.Qx * s.yp;
            const y = B.Py * s.xp + B.Qy * s.yp;
            const z = B.Pz * s.xp + B.Qz * s.yp;
            const e = msg.earthAt[k] || msg.earthAt[msg.earthAt.length - 1] || [0, 0, 0];
            geo[k * 3] = x - e[0]; geo[k * 3 + 1] = y - e[1]; geo[k * 3 + 2] = z - e[2];
        }
    }
    postMessage({ type: 'geotrack', id: msg.id, index: msg.index, geo, jd0, dtDays: dt }, [geo.buffer]);
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
        else if (msg.type === 'geoframe') onGeoFrame(msg);
        else if (msg.type === 'track') onTrack(msg);
        else if (msg.type === 'geotrack') onGeoTrack(msg);
        else if (msg.type === 'meta') onMeta(msg);
    } catch (err) {
        postMessage({ type: 'error', id: msg.id, error: err?.message || String(err) });
    }
});

postMessage({ type: 'ready' });
