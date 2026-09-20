/**
 * star-collider/sph-worker.js — the merger engine's Web Worker host
 * ═══════════════════════════════════════════════════════════════════════════
 * The main thread owns rendering, charts and the console; this worker owns
 * the O(N²) SPH stepping through kernel.js AND the run's clock: a chunk
 * index, a checkpoint timeline, and the rewind/replay/branch machinery the
 * page's transport bar drives.
 *
 * THE CLOCK IS THE CHUNK INDEX, NOT THE WALL CLOCK. A chunk is
 * `kernel.advance(chunkDt, CHUNK_MAX_STEPS, dtMax)` — a fixed request in
 * sim time with a fixed substep cap — so state(k) is a pure function of the
 * build, the seed, and the parameter events at chunks < k. Wall time only
 * decides HOW MANY chunks run per tick (the pace/warp), never what a chunk
 * does. The first version advanced `warp × wallDt` split four ways inside
 * a millisecond budget: the substep boundaries then depended on the
 * machine's speed, and two runs of the same setup could not agree past the
 * first frame, let alone be rewound.
 *
 * PARAMETER CHANGES ARE EVENTS ON THAT CLOCK. A live change to viscosity /
 * Γ_th / the PN terms is recorded as {chunk, params} and applied before the
 * chunk it names — on the live run and again on every replay through it —
 * so a run that was tuned mid-flight rewinds to exactly the states it had.
 * A change made while REVIEWING (the cursor behind the head) cannot be
 * folded into history without falsifying the recorded frames after it, so
 * it BRANCHES the run at the cursor (the page says so): the timeline and
 * the events after the cursor are dropped and the head becomes the cursor.
 *
 * THE TIMELINE. Every `every` chunks an entry records the packed frame and
 * the diagnostics (what the stage and HUD showed); every `snapEvery`-th
 * entry also carries a kernel snapshot (the complete integrator state —
 * kernel.js `snapshot()`, bit-exact on restore). Seeking to chunk k shows
 * the nearest recorded frame at once and, when asked for an exact seek,
 * restores the nearest snapshot ≤ k and replays forward (or replays from
 * the kernel's current state when that is nearer) — the frame posted then
 * is the frame the live run produced at k, to the bit. The store is
 * capped in bytes and entries; over the cap it THINS by dropping every
 * other entry and doubling `every` (snapshots stay on the entries whose
 * chunk is a multiple of every × snapEvery), so the timeline always covers
 * the whole run at a resolution the frame tells the page about. While the
 * cursor is behind the head the head's own state is held in `headSnap`
 * so "Live" returns to it exactly.
 *
 * Protocol (structured clone + transferables):
 *   → { type:'init', wasmUrl }
 *   ← { type:'ready', maxParticles, frameStride }
 *   → { type:'setup', seed, params, bodies:[{kind,mass,radius,gamma,n}×2],
 *       orbit:{sep,ecc,spinA,spinB,pnCirc}, relax:{steps,dtMax,damping},
 *       clock:{chunkDt, dtMax} }
 *   ← { type:'built', n, nA, nB, relaxMs, frameStride, bodies, diag, frame, …clockFields }
 *   → { type:'run', warp?, budgetMs? }          run live from the head
 *   → { type:'pause' }
 *   → { type:'warp', warp }                      sim units per wall second (1e12 = as fast as possible)
 *   → { type:'params', params }                  live parameter event (branches if reviewing)
 *   → { type:'seek', chunk, exact }              move the cursor; exact ⇒ replay to it
 *   → { type:'step', dir:±1 }                    one chunk back / forward (forward at the head computes)
 *   → { type:'live', run }                       cursor back to the head
 *   → { type:'branch', run }                     make the cursor the head
 *   → { type:'replay', on }                      play the RECORDED timeline forward from the cursor at the pace
 *   → { type:'snapshot' }                        post the current frame
 *   ← { type:'frame', frame?, diag, bodies, gw:[{t,hp,hx,sep}…], perf, …clockFields }
 *   ← { type:'branched', chunk, time }
 *   ← { type:'error', message }
 *   clockFields = { chunk, head, mode:'running'|'paused'|'review'|'replay'|'seeking', time, headTime,
 *                   exact, timeline:{ entries, every, snapEvery, snapshots, bytes, chunkDt } }
 *
 * The GW samples are the quadrupole second derivative after each chunk:
 * hp ∝ Q̈xx − Q̈yy, hx ∝ 2 Q̈xy (face-on observer on +z), in code units — the
 * page scales them by 1/D. They are posted only for LIVE chunks; a replay
 * re-shows frames, it does not re-append the series.
 */

import { loadKernel } from './kernel.js';

const CHUNK_MAX_STEPS = 64;   // substep cap per chunk: deterministic, and a violent phase cannot hang a tick
const MAX_DEBT = 4;           // paced mode never owes more than this many chunks after a stall
const CAP_BYTES = 40 * 1024 * 1024;
const CAP_ENTRIES = 600;
const SNAP_EVERY = 4;

let kernel = null;
let mode = 'idle';
let warp = 1e12;
let budgetMs = 28;
let lastTick = 0, lastFrame = 0, debt = 0;
let stepsAccum = 0, msAccum = 0;
let gwBuffer = [];
let timer = null;

const clock = {
    chunkDt: 1, dtMax: 1,
    chunk: 0,          // index of the state the KERNEL holds right now — always truthful
    cursor: 0,         // index the page is LOOKING at (a recorded frame during a scrub/replay; == chunk after an exact seek)
    head: 0,           // furthest computed state
    headTime: 0,
    events: [],        // [{chunk, params}] ascending by chunk
    baseParams: {},
    timeline: [],      // [{chunk, time, steps, frame, diag, bodies, snap|null}]
    every: 1,
    bytes: 0,
    headSnap: null,    // the head's integrator state while the kernel is behind it
    replayCursor: 0,
};

function post(msg, transfer) { self.postMessage(msg, transfer || []); }
const clampChunk = (k) => Math.max(0, Math.min(Math.round(k), clock.head));

function paramsAt(chunk) {
    let p = clock.baseParams;
    for (const e of clock.events) { if (e.chunk <= chunk) p = e.params; else break; }
    return p;
}

function clockFields(extra = {}) {
    let snapshots = 0;
    for (const e of clock.timeline) if (e.snap) snapshots++;
    return {
        chunk: clock.cursor, kernelChunk: clock.chunk, head: clock.head, mode, time: kernel ? kernel.time() : 0, headTime: clock.headTime,
        exact: clock.cursor === clock.chunk,
        timeline: { entries: clock.timeline.length, every: clock.every, snapEvery: SNAP_EVERY, snapshots, bytes: clock.bytes, chunkDt: clock.chunkDt },
        ...extra,
    };
}

function currentDiagBodies() {
    return { diag: kernel.diagnostics(), bodies: [kernel.bodyState(0), kernel.bodyState(1)] };
}

/** Post the KERNEL's state (exact by definition). */
function postFrame(includeFrame = true, extra = {}) {
    clock.cursor = clock.chunk;
    const { diag, bodies } = currentDiagBodies();
    const msg = { type: 'frame', diag, bodies, gw: gwBuffer, perf: { stepsPerSec: msAccum > 0 ? stepsAccum / (msAccum / 1000) : 0, msPerStep: stepsAccum > 0 ? msAccum / stepsAccum : 0 }, ...clockFields(extra) };
    gwBuffer = [];
    if (includeFrame) {
        const frame = kernel.frame();
        msg.frame = frame;
        post(msg, [frame.buffer]);
    } else post(msg);
}

/** Post a RECORDED entry (no kernel work) — the instant response to a scrub. Moves the cursor, never the kernel. */
function postEntry(entry, extra = {}) {
    clock.cursor = entry.chunk;
    const frame = new Float32Array(entry.frame);
    post({ type: 'frame', frame, diag: entry.diag, bodies: entry.bodies, gw: [], perf: null,
        ...clockFields({ time: entry.time, ...extra }) }, [frame.buffer]);
}

// ── Timeline ────────────────────────────────────────────────────────────────
function entryBytes(e) { return e.frame.byteLength + (e.snap ? e.snap.byteLength : 0) + 1024; }

function makeEntry(withSnap) {
    const { diag, bodies } = currentDiagBodies();
    return { chunk: clock.chunk, time: kernel.time(), steps: diag.steps, frame: kernel.frame(), diag, bodies, snap: withSnap ? kernel.snapshot() : null };
}

function recordEntry() {
    const k = clock.chunk;
    if (k % clock.every !== 0) return;
    const e = makeEntry(k % (clock.every * SNAP_EVERY) === 0);
    clock.timeline.push(e);
    clock.bytes += entryBytes(e);
    while ((clock.bytes > CAP_BYTES || clock.timeline.length > CAP_ENTRIES) && clock.every < 1 << 20) thinTimeline();
}

function thinTimeline() {
    clock.every *= 2;
    const keep = [];
    let bytes = 0;
    for (const e of clock.timeline) {
        if (e.chunk % clock.every !== 0) continue;
        if (e.snap && e.chunk % (clock.every * SNAP_EVERY) !== 0) e.snap = null;
        keep.push(e); bytes += entryBytes(e);
    }
    clock.timeline = keep; clock.bytes = bytes;
}

function truncateTimeline(chunk) {
    const keep = [];
    let bytes = 0;
    for (const e of clock.timeline) if (e.chunk <= chunk) { keep.push(e); bytes += entryBytes(e); }
    clock.timeline = keep; clock.bytes = bytes;
    clock.events = clock.events.filter(e => e.chunk <= chunk);
}

function nearestEntry(chunk) {
    let best = null;
    for (const e of clock.timeline) { if (e.chunk <= chunk) best = e; else break; }
    return best || clock.timeline[0] || null;
}

function nearestSnapshotEntry(chunk) {
    let best = null;
    for (const e of clock.timeline) { if (e.chunk > chunk) break; if (e.snap) best = e; }
    return best;
}

// ── Stepping ────────────────────────────────────────────────────────────────
/** Advance the kernel by one chunk from the state it holds. Live chunks extend the head and record; replayed chunks only move the kernel. */
function advanceChunk(live) {
    kernel.setParams(paramsAt(clock.chunk));
    const t0 = performance.now();
    const steps = kernel.advance(clock.chunkDt, CHUNK_MAX_STEPS, clock.dtMax);
    const spent = performance.now() - t0;
    stepsAccum += steps; msAccum += spent;
    if (stepsAccum > 400) { stepsAccum = Math.round(stepsAccum / 2); msAccum /= 2; }
    clock.chunk += 1;
    clock.cursor = clock.chunk;
    if (live) {
        clock.head = clock.chunk;
        clock.headTime = kernel.time();
        const d = kernel.diagnostics();
        gwBuffer.push({ t: d.time, hp: d.qxx - d.qyy, hx: 2 * d.qxy, sep: d.separation });
        if (gwBuffer.length > 4000) gwBuffer = gwBuffer.slice(-4000);
        recordEntry();
    }
    return steps;
}

/** Put the KERNEL at chunk `target` (≤ head) exactly, replaying from the cheapest exact state. */
function seekExact(target) {
    target = clampChunk(target);
    if (target === clock.chunk) { clock.cursor = target; return true; }
    if (target === clock.head && clock.headSnap) {
        if (!kernel.restore(clock.headSnap)) return false;
        clock.chunk = clock.cursor = clock.head; clock.headSnap = null;
        return true;
    }
    if (clock.chunk === clock.head && !clock.headSnap) clock.headSnap = kernel.snapshot();
    const snapEntry = nearestSnapshotEntry(target);
    const fromKernel = clock.chunk <= target && (!snapEntry || clock.chunk >= snapEntry.chunk);
    if (!fromKernel) {
        if (!snapEntry || !kernel.restore(snapEntry.snap)) return false;
        clock.chunk = snapEntry.chunk;
    }
    while (clock.chunk < target) advanceChunk(false);
    clock.cursor = clock.chunk;
    if (clock.chunk === clock.head) clock.headSnap = null;
    return true;
}

function goLive() {
    if (clock.chunk !== clock.head) {
        if (clock.headSnap) { kernel.restore(clock.headSnap); clock.chunk = clock.head; }
        else seekExact(clock.head);
    }
    clock.headSnap = null;
    clock.cursor = clock.chunk;
}

/** Make the kernel's current chunk the head: everything recorded after it is discarded. */
function branchHere() {
    const k = clock.chunk;
    truncateTimeline(k);
    clock.head = k; clock.headTime = kernel.time(); clock.headSnap = null; clock.cursor = k;
    if (!clock.timeline.length || clock.timeline[clock.timeline.length - 1].chunk !== k) {
        // The cursor may sit between entries: give the new head a snapshot entry so the
        // branch point is itself rewindable.
        const e = makeEntry(true);
        clock.timeline.push(e); clock.bytes += entryBytes(e);
    }
    post({ type: 'branched', chunk: k, time: kernel.time() });
}

function startRunning() {
    mode = 'running'; debt = 0; lastTick = performance.now(); lastFrame = 0;
    schedule(0);
}

// ── The tick loop ───────────────────────────────────────────────────────────
function schedule(delay = 0) { if (!timer) timer = setTimeout(tick, delay); }

function tick() {
    timer = null;
    if (!kernel) return;
    const now = performance.now();
    const wall = Math.min((now - lastTick) / 1000, 0.25);
    lastTick = now;
    if (mode === 'running') {
        const unpaced = warp >= 1e11;
        debt = unpaced ? Infinity : Math.min(debt + wall * warp / clock.chunkDt, MAX_DEBT);
        const t0 = performance.now();
        let did = 0;
        while (debt >= 1 && performance.now() - t0 < budgetMs) { advanceChunk(true); if (!unpaced) debt -= 1; did++; }
        if (now - lastFrame > 33 && did) { lastFrame = now; postFrame(true); }
        schedule(did ? 0 : 8);
        return;
    }
    if (mode === 'replay') {
        const unpaced = warp >= 1e11;
        const rate = unpaced ? 30 * clock.every : warp / clock.chunkDt; // chunks per wall second
        clock.replayCursor += wall * rate;
        if (clock.replayCursor >= clock.head) {
            goLive();
            postFrame(true);
            startRunning();
            return;
        }
        const e = nearestEntry(Math.floor(clock.replayCursor));
        if (e && e.chunk !== clock.cursor) postEntry(e);
        schedule(16);
    }
}

// ── Messages ────────────────────────────────────────────────────────────────
self.onmessage = async (ev) => {
    const msg = ev.data;
    try {
        if (msg.type === 'init') {
            kernel = await loadKernel(msg.wasmUrl);
            post({ type: 'ready', maxParticles: kernel.maxParticles, frameStride: kernel.frameStride });
            return;
        }
        if (!kernel) { post({ type: 'error', message: 'kernel not loaded' }); return; }
        if (msg.type === 'setup') {
            mode = 'idle';
            if (timer) { clearTimeout(timer); timer = null; }
            kernel.init();
            clock.baseParams = { ...(msg.params || {}) };
            kernel.setParams(clock.baseParams);
            kernel.setBody(0, msg.bodies[0]);
            kernel.setBody(1, msg.bodies[1]);
            const n = kernel.build(msg.bodies[0].n | 0, msg.bodies[1].n | 0, msg.seed | 0);
            const t0 = performance.now();
            const rl = msg.relax || { steps: 60, dtMax: 0.5, damping: 0.05 };
            kernel.relax(rl.steps, rl.dtMax, rl.damping);
            const relaxMs = performance.now() - t0;
            const o = msg.orbit;
            kernel.setOrbit(o.sep, o.ecc || 0, o.spinA || 0, o.spinB || 0, o.pnCirc !== false);
            const ck = msg.clock || {};
            clock.dtMax = ck.dtMax > 0 ? ck.dtMax : 1;
            clock.chunkDt = ck.chunkDt > 0 ? ck.chunkDt : 4 * clock.dtMax;
            clock.chunk = 0; clock.cursor = 0; clock.head = 0; clock.headTime = 0; clock.events = []; clock.timeline = []; clock.every = 1; clock.bytes = 0; clock.headSnap = null;
            gwBuffer = []; stepsAccum = 0; msAccum = 0; debt = 0;
            recordEntry();
            mode = 'paused';
            const { diag, bodies } = currentDiagBodies();
            const frame = kernel.frame();
            post({ type: 'built', n, nA: kernel.bodyCount(0), nB: kernel.bodyCount(1), relaxMs, frameStride: kernel.frameStride, bodies, diag, frame, ...clockFields() }, [frame.buffer]);
            return;
        }
        if (mode === 'idle') return;
        // Where the page is looking: an explicit `at` from the page, else the cursor. A RUNNING
        // kernel is at its head by definition — the page's copy of the chunk index lags by a
        // frame interval, and honouring it would branch every live tweak a few chunks back.
        const at = mode === 'running' ? clock.head : (Number.isFinite(msg.at) ? clampChunk(msg.at) : clock.cursor);
        switch (msg.type) {
            case 'run': {
                warp = msg.warp ?? warp; budgetMs = msg.budgetMs ?? budgetMs;
                goLive();
                postFrame(true);
                startRunning();
                return;
            }
            case 'pause': {
                if (mode === 'running') { mode = 'paused'; postFrame(false); }
                else if (mode === 'replay') { mode = 'review'; }
                return;
            }
            case 'warp': { warp = msg.warp ?? warp; return; }
            case 'params': {
                // A change at the head is an event; a change behind the head is a branch.
                if (mode === 'replay') mode = 'review';
                const wasRunning = mode === 'running';
                if (!seekExact(at)) return;
                const behind = clock.chunk < clock.head;
                if (behind) branchHere();
                const params = { ...paramsAt(clock.chunk), ...msg.params };
                clock.events = clock.events.filter(e => e.chunk < clock.chunk);
                clock.events.push({ chunk: clock.chunk, params });
                kernel.setParams(params);
                if (behind) mode = 'paused';
                postFrame(false, { paramsApplied: params, branched: behind });
                if (wasRunning && !behind) schedule(0);
                return;
            }
            case 'seek': {
                const target = clampChunk(msg.chunk);
                if (mode === 'running' || mode === 'replay') mode = 'review';
                if (!msg.exact) {
                    const e = nearestEntry(target);
                    if (e) { if (target !== clock.head || clock.chunk !== clock.head) mode = 'review'; postEntry(e); }
                    return;
                }
                const e = nearestEntry(target);
                if (e && e.chunk !== target && e.chunk !== clock.chunk) postEntry(e, { mode: 'seeking' });
                if (!seekExact(target)) { post({ type: 'error', message: 'seek failed: no checkpoint covers that chunk' }); return; }
                mode = clock.chunk === clock.head ? 'paused' : 'review';
                postFrame(true);
                return;
            }
            case 'step': {
                if (mode === 'running' || mode === 'replay') mode = 'review';
                const dir = msg.dir < 0 ? -1 : 1;
                if (dir > 0 && at === clock.head) {
                    // Forward at the head computes a new chunk and stays paused.
                    goLive();
                    advanceChunk(true); mode = 'paused'; postFrame(true);
                    return;
                }
                if (!seekExact(at + dir)) return;
                mode = clock.chunk === clock.head ? 'paused' : 'review';
                postFrame(true);
                return;
            }
            case 'live': {
                goLive();
                mode = 'paused';
                postFrame(true);
                if (msg.run) startRunning();
                return;
            }
            case 'branch': {
                if (mode === 'replay') mode = 'review';
                if (!seekExact(at)) return;
                if (clock.chunk !== clock.head) branchHere();
                mode = 'paused';
                postFrame(true);
                if (msg.run) startRunning();
                return;
            }
            case 'replay': {
                if (!msg.on) { if (mode === 'replay') { mode = 'review'; postFrame(false, { chunk: clock.cursor }); } return; }
                if (mode === 'running') mode = 'review';
                if (clock.chunk === clock.head && !clock.headSnap) clock.headSnap = kernel.snapshot();
                clock.replayCursor = at >= clock.head ? 0 : at;
                mode = 'replay'; lastTick = performance.now();
                const e = nearestEntry(Math.floor(clock.replayCursor));
                if (e) postEntry(e);
                schedule(0);
                return;
            }
            case 'snapshot': { postFrame(true); return; }
            default: return;
        }
    } catch (err) {
        post({ type: 'error', message: String(err && err.message || err) });
    }
};
