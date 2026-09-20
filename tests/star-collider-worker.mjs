#!/usr/bin/env node
/**
 * star-collider-worker.mjs — the clock contract of js/star-collider/sph-worker.js.
 *
 * Run: node tests/star-collider-worker.mjs
 *
 * The worker is driven here exactly as the page drives it, through a fake
 * `self` (postMessage captured, onmessage called), on the COMMITTED WASM.
 * What is pinned:
 *   1. State is a function of the chunk index: an exact seek to chunk k
 *      reproduces the frame and diagnostics the live run posted at k, bit
 *      for bit — from a checkpoint, from the kernel's current state, and
 *      after the timeline has thinned.
 *   2. A parameter change at the head is an event that replays: rewinding
 *      past it and seeking forward again gives the same states.
 *   3. A parameter change behind the head BRANCHES (timeline truncated,
 *      head moved) and the page is told.
 *   4. Two setups with the same seed produce the same chunk 0 and chunk 5.
 *   5. Pace never changes a chunk: warp only decides how many run per tick.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const wasm = await readFile(fileURLToPath(new URL('../js/star-collider/wasm/star_collider_kernel.wasm', import.meta.url)));

// ── Fake worker host ────────────────────────────────────────────────────────
const inbox = [];
globalThis.self = { postMessage: (m) => inbox.push(m), onmessage: null };
await import('../js/star-collider/sph-worker.js');
const send = (msg) => self.onmessage({ data: msg });
const drain = () => inbox.splice(0, inbox.length);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const sameDiag = (a, b) => Object.keys(a).every(k => Object.is(a[k], b[k]));

let passed = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); passed++; };

send({ type: 'init', wasmUrl: wasm });
await sleep(50);
assert.equal(drain()[0]?.type, 'ready');

const setup = (seed = 7, extra = {}) => ({
    type: 'setup', seed,
    params: { c: 1, alpha: 1, beta: 2, gammaTh: 1.75, pn1: false, pn25: true, sinkFactor: 1.5 },
    bodies: [{ kind: 'star', mass: 1.4, radius: 8, gamma: 2, n: 60 }, { kind: 'star', mass: 1.4, radius: 8, gamma: 2, n: 60 }],
    orbit: { sep: 26, ecc: 0, spinA: 0, spinB: 0, pnCirc: true },
    relax: { steps: 20, dtMax: 0.5, damping: 0.05 },
    clock: { chunkDt: 4, dtMax: 1 },
    ...extra,
});

// ── 1. Live run, then exact seeks reproduce the live frames ────────────────
send(setup());
const built = drain()[0];
assert.equal(built.type, 'built');
assert.equal(built.chunk, 0); assert.equal(built.head, 0); assert.equal(built.mode, 'paused');
assert.equal(built.timeline.entries, 1);
ok('setup posts built at chunk 0 with one timeline entry');

// Step forward at the head 12 times: deterministic chunks, each recorded.
const live = new Map();
live.set(0, { frame: built.frame, diag: built.diag });
for (let k = 1; k <= 12; k++) {
    send({ type: 'step', dir: 1 });
    const f = drain().find(m => m.type === 'frame');
    assert.equal(f.chunk, k); assert.equal(f.head, k); assert.equal(f.mode, 'paused'); assert.equal(f.exact, true);
    live.set(k, { frame: f.frame, diag: f.diag });
}
assert.ok(live.get(12).diag.steps > 24, `chunks actually step (${live.get(12).diag.steps} steps)`);
ok('12 forward steps at the head, each exact and recorded');

// Exact seek back to 5 (restores the chunk-4 snapshot and replays one chunk).
send({ type: 'seek', chunk: 5, exact: true });
let msgs = drain();
let f5 = msgs.filter(m => m.type === 'frame').pop();
assert.equal(f5.chunk, 5); assert.equal(f5.mode, 'review'); assert.equal(f5.exact, true);
assert.ok(same(f5.frame, live.get(5).frame), 'frame at 5 bit-identical');
assert.ok(sameDiag(f5.diag, live.get(5).diag), 'diag at 5 bit-identical');
ok('exact seek to 5 from a checkpoint reproduces the live frame bit for bit');

// Step forward from 5 → 6 replays from the kernel's own state (cheaper than the snapshot).
send({ type: 'step', dir: 1 });
let f6 = drain().filter(m => m.type === 'frame').pop();
assert.equal(f6.chunk, 6); assert.equal(f6.head, 12);
assert.ok(same(f6.frame, live.get(6).frame) && sameDiag(f6.diag, live.get(6).diag));
send({ type: 'step', dir: -1 });
let f5b = drain().filter(m => m.type === 'frame').pop();
assert.equal(f5b.chunk, 5);
assert.ok(same(f5b.frame, live.get(5).frame));
ok('stepping forward and back in review stays bit-exact');

// A non-exact scrub answers instantly with the nearest recorded entry and leaves the kernel alone.
send({ type: 'seek', chunk: 9, exact: false });
let f9 = drain().filter(m => m.type === 'frame').pop();
assert.equal(f9.chunk, 9); assert.equal(f9.kernelChunk, 5); assert.equal(f9.mode, 'review');
assert.ok(same(f9.frame, live.get(9).frame), 'recorded entry is the live frame');
ok('non-exact scrub returns the recorded frame without moving the kernel');

// Back to live: the head's state is restored exactly.
send({ type: 'live', run: false });
let fh = drain().filter(m => m.type === 'frame').pop();
assert.equal(fh.chunk, 12); assert.equal(fh.mode, 'paused'); assert.equal(fh.exact, true);
assert.ok(same(fh.frame, live.get(12).frame) && sameDiag(fh.diag, live.get(12).diag));
ok('live restores the head bit for bit');

// ── 2. A parameter event at the head replays ───────────────────────────────
send({ type: 'params', params: { alpha: 2.5, beta: 5 } });
let pf = drain().filter(m => m.type === 'frame').pop();
assert.equal(pf.branched, false); assert.equal(pf.paramsApplied.alpha, 2.5);
for (let k = 13; k <= 16; k++) { send({ type: 'step', dir: 1 }); const f = drain().filter(m => m.type === 'frame').pop(); live.set(k, { frame: f.frame, diag: f.diag }); }
send({ type: 'seek', chunk: 10, exact: true });
let f10 = drain().filter(m => m.type === 'frame').pop();
assert.ok(same(f10.frame, live.get(10).frame), 'pre-event chunk unchanged by the event');
send({ type: 'seek', chunk: 15, exact: true });
let f15 = drain().filter(m => m.type === 'frame').pop();
assert.ok(same(f15.frame, live.get(15).frame) && sameDiag(f15.diag, live.get(15).diag), 'post-event replay re-applies the event');
ok('a parameter change at the head is an event: replay through it is bit-exact');

// The event changed the run: chunk 13 with α = 2.5 differs from what α = 1 would have given.
send(setup());
drain();
for (let k = 1; k <= 13; k++) { send({ type: 'step', dir: 1 }); }
const alt13 = drain().filter(m => m.type === 'frame').pop();
assert.ok(!same(alt13.frame, live.get(13).frame), 'α = 1 and α = 2.5 runs differ at chunk 13');
assert.ok(same(alt13.frame, live.get(13).frame) === false);
ok('the event really changed the physics (a fresh α = 1 run differs at chunk 13)');

// ── 4. Same seed ⇒ same states ─────────────────────────────────────────────
for (let k = 14; k <= 16; k++) send({ type: 'step', dir: 1 });
drain();
send({ type: 'seek', chunk: 5, exact: true });
const rerun5 = drain().filter(m => m.type === 'frame').pop();
assert.ok(same(rerun5.frame, live.get(5).frame) && sameDiag(rerun5.diag, live.get(5).diag));
ok('a second setup with the same seed reproduces chunk 5 bit for bit');

// ── 3. A change behind the head branches ───────────────────────────────────
send({ type: 'seek', chunk: 8, exact: true });
drain();
send({ type: 'params', params: { gammaTh: 1.4 } });
msgs = drain();
const branched = msgs.find(m => m.type === 'branched');
assert.ok(branched && branched.chunk === 8, 'branched message at 8');
const bf = msgs.filter(m => m.type === 'frame').pop();
assert.equal(bf.head, 8); assert.equal(bf.branched, true); assert.equal(bf.mode, 'paused');
send({ type: 'step', dir: 1 });
const nf = drain().filter(m => m.type === 'frame').pop();
assert.equal(nf.chunk, 9); assert.equal(nf.head, 9);
assert.ok(!same(nf.frame, live.get(9).frame), 'the branch diverges from the original timeline');
ok('a parameter change behind the head branches: timeline truncated, head moved, physics diverges');

// ── 5. Pace does not change a chunk; the run loop advances the head ────────
send(setup(3));
drain();
send({ type: 'run', warp: 1e12, budgetMs: 10 });
await sleep(250);
send({ type: 'pause' });
await sleep(30);
msgs = drain();
const last = msgs.filter(m => m.type === 'frame').pop();
assert.ok(last.head >= 3, `the run loop advanced the head (${last.head})`);
assert.ok(msgs.some(m => m.type === 'frame' && m.gw && m.gw.length), 'GW samples posted for live chunks');
const head1 = last.head;
send({ type: 'seek', chunk: 3, exact: true });
const a3 = drain().filter(m => m.type === 'frame').pop();
// Same seed, paced run: chunk 3 must be the same state.
send(setup(3));
drain();
send({ type: 'run', warp: 40, budgetMs: 10 }); // 10 chunks per second at chunkDt = 4
await sleep(450);
send({ type: 'pause' });
await sleep(30);
msgs = drain();
const paced = msgs.filter(m => m.type === 'frame').pop();
assert.ok(paced.head >= 3 && paced.head < head1 + 40, `paced run advanced ${paced.head} chunks`);
send({ type: 'seek', chunk: 3, exact: true });
const b3 = drain().filter(m => m.type === 'frame').pop();
assert.ok(same(a3.frame, b3.frame) && sameDiag(a3.diag, b3.diag), 'chunk 3 identical across paces');
ok('warp changes how many chunks run per tick, never what a chunk is');

// ── 6. Thinning keeps the timeline exact ───────────────────────────────────
// 20 + 20 particles at one substep per chunk: 700 chunks in a couple of
// seconds, past the 600-entry cap, so the store thins (every → 2) and the
// odd chunks lose their recorded frames. An exact seek to one of them must
// still reproduce the live frame — from the nearest surviving checkpoint.
send(setup(5, { bodies: [{ kind: 'star', mass: 1.4, radius: 8, gamma: 2, n: 20 }, { kind: 'star', mass: 1.4, radius: 8, gamma: 2, n: 20 }], clock: { chunkDt: 0.25, dtMax: 0.25 } }));
drain();
const early = new Map();
let lastTl = null;
for (let k = 1; k <= 700; k++) {
    send({ type: 'step', dir: 1 });
    const f = drain().filter(m => m.type === 'frame').pop();
    if (k === 333 || k === 601 || k === 700) early.set(k, f);
    lastTl = f.timeline;
}
assert.ok(lastTl.every >= 2 && lastTl.entries <= 600, `thinned: ${JSON.stringify(lastTl)}`);
send({ type: 'seek', chunk: 333, exact: true });
const s333 = drain().filter(m => m.type === 'frame').pop();
assert.equal(s333.chunk, 333); assert.equal(s333.exact, true);
assert.ok(same(s333.frame, early.get(333).frame) && sameDiag(s333.diag, early.get(333).diag), 'chunk 333 exact after thinning');
send({ type: 'seek', chunk: 601, exact: false });
const r601 = drain().filter(m => m.type === 'frame').pop();
assert.ok(r601.chunk <= 601 && r601.chunk >= 601 - lastTl.every, 'a non-exact scrub lands on the nearest surviving entry');
send({ type: 'seek', chunk: 601, exact: true });
const s601 = drain().filter(m => m.type === 'frame').pop();
assert.ok(same(s601.frame, early.get(601).frame), 'chunk 601 exact after thinning');
send({ type: 'live', run: false });
const l700 = drain().filter(m => m.type === 'frame').pop();
assert.ok(l700.chunk === 700 && same(l700.frame, early.get(700).frame), 'head intact after review');
ok(`thinning: ${lastTl.entries} entries every ${lastTl.every} chunks, ${lastTl.snapshots} checkpoints, ${(lastTl.bytes / 1024).toFixed(0)} KB — exact seeks survive it`);

console.log(`✅ star-collider-worker: ${passed} checks passed`);
process.exit(0);
