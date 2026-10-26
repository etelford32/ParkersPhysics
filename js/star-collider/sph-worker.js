/**
 * star-collider/sph-worker.js — the merger engine's Web Worker host
 * ═══════════════════════════════════════════════════════════════════════════
 * The main thread owns rendering, charts and the console; this worker owns
 * the O(N²) SPH stepping through kernel.js. It runs the engine in wall-clock
 * budgeted chunks so the page never blocks, and posts render frames at a
 * capped rate with the positions as a transferable Float32Array.
 *
 * Protocol (structured clone + transferables):
 *   → { type:'init', wasmUrl }
 *   ← { type:'ready' } | { type:'error', message }
 *   → { type:'setup', seed, params, bodies:[{kind,mass,radius,gamma,n}×2],
 *       orbit:{sep,ecc,spinA,spinB,pnCirc}, relax:{steps,dtMax,damping} }
 *   ← { type:'built', n, nA, nB, relaxMs, bodies:[state×2], diag }
 *   → { type:'run', warp (sim units per real second), budgetMs, dtMax }
 *   → { type:'pause' } | { type:'resume' } | { type:'warp', warp }
 *   ← { type:'frame', frame(Float32Array, transferred), diag, bodies, gw:[{t,hp,hx}…],
 *       perf:{stepsPerSec, msPerStep} }
 *
 * Frames may also carry `aux` (Float32Array, AUX_STRIDE per particle: v, h,
 * ∇·v, mixing, viscous heating rate), `links` (A–B kernel pairs, stride 4)
 * and `interactions` (the summary) — js/star-collider/interactions.js run on
 * the kernel's own raw state at ≤ AUX_HZ, so the main thread never does a
 * neighbour search. `aux` is indexed by KERNEL particle index, like `frame`.
 *
 * The GW samples are the quadrupole second derivative read off the kernel
 * after every chunk: hp ∝ Q̈xx − Q̈yy, hx ∝ 2 Q̈xy (face-on observer on +z),
 * in code units — the page scales them by 1/D.
 */

import { loadKernel } from './kernel.js';
import { computeInteractions, packInteractions } from './interactions.js';

const AUX_HZ = 8;
let lastAux = 0;
let simParams = { alpha: 1, beta: 2, gammaTh: 1.75 };
let bodyGamma = [2, 2];

/** The interaction diagnostics on the kernel's current raw state. */
function interactions() {
    const n = kernel.n();
    const state = {
        n, pos: kernel.pos(), vel: kernel.vel(), h: kernel.h(), mass: kernel.mass(), rho: kernel.rho(),
        u: kernel.u(), star: kernel.star(), alive: kernel.alive(),
        bodies: [{ k: kernel.bodyK(0), gamma: bodyGamma[0] }, { k: kernel.bodyK(1), gamma: bodyGamma[1] }],
    };
    const r = computeInteractions(state, simParams, { maxLinks: 3000 });
    const { aux, links } = packInteractions(state, r);
    return { aux, links, summary: r.summary };
}

let kernel = null;
let running = false;
let warp = 200;          // sim time units per real second
let budgetMs = 28;       // compute per tick
let dtMax = 1.0;
let lastTick = 0;
let lastFrame = 0;
let stepsAccum = 0, msAccum = 0;
let gwBuffer = [];
let timer = null;

function post(msg, transfer) { self.postMessage(msg, transfer || []); }

function snapshot(includeFrame) {
    const diag = kernel.diagnostics();
    const bodies = [kernel.bodyState(0), kernel.bodyState(1)];
    const msg = { type: 'frame', diag, bodies, gw: gwBuffer, perf: { stepsPerSec: msAccum > 0 ? stepsAccum / (msAccum / 1000) : 0, msPerStep: stepsAccum > 0 ? msAccum / stepsAccum : 0 } };
    gwBuffer = [];
    if (includeFrame) {
        const frame = kernel.frame();
        msg.frame = frame;
        const transfer = [frame.buffer];
        const now = performance.now();
        if (now - lastAux > 1000 / AUX_HZ) {
            lastAux = now;
            const ia = interactions();
            msg.aux = ia.aux; msg.links = ia.links; msg.interactions = ia.summary;
            transfer.push(ia.aux.buffer, ia.links.buffer);
        }
        post(msg, transfer);
    } else {
        post(msg);
    }
}

function tick() {
    timer = null;
    if (!running || !kernel) return;
    const now = performance.now();
    const wall = Math.min((now - lastTick) / 1000, 0.1);
    lastTick = now;
    const target = Math.max(warp * wall, dtMax * 0.5);
    const t0 = performance.now();
    let steps = 0;
    // Advance in small pieces so the budget is respected even when one step is slow.
    while (performance.now() - t0 < budgetMs) {
        const before = kernel.time();
        steps += kernel.advance(Math.min(target / 4, target), 4, dtMax);
        const d = kernel.diagnostics();
        // hp/hx: face-on strain; qxx…qzz: the full traceless Q̈ in the orbital
        // plane, which the stage's ripple sheet projects onto every in-plane
        // direction at retarded time.
        gwBuffer.push({ t: d.time, hp: d.qxx - d.qyy, hx: 2 * d.qxy, sep: d.separation, qxx: d.qxx, qyy: d.qyy, qzz: d.qzz, qxy: d.qxy, omega: d.omega });
        if (kernel.time() - before <= 0) break;
        if (kernel.time() >= before + target) break;
    }
    const spent = performance.now() - t0;
    stepsAccum += steps; msAccum += spent;
    if (stepsAccum > 400) { stepsAccum = Math.round(stepsAccum / 2); msAccum /= 2; }
    if (gwBuffer.length > 4000) gwBuffer = gwBuffer.slice(-4000);
    if (now - lastFrame > 33) { lastFrame = now; snapshot(true); }
    timer = setTimeout(tick, 0);
}

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
            running = false;
            if (timer) { clearTimeout(timer); timer = null; }
            kernel.init();
            kernel.setParams(msg.params || {});
            simParams = { alpha: msg.params?.alpha ?? 1, beta: msg.params?.beta ?? 2, gammaTh: msg.params?.gammaTh ?? 1.75 };
            bodyGamma = [msg.bodies[0].gamma ?? 2, msg.bodies[1].gamma ?? 2];
            kernel.setBody(0, msg.bodies[0]);
            kernel.setBody(1, msg.bodies[1]);
            const n = kernel.build(msg.bodies[0].n | 0, msg.bodies[1].n | 0, msg.seed | 0);
            const t0 = performance.now();
            const rl = msg.relax || { steps: 60, dtMax: 0.5, damping: 0.05 };
            kernel.relax(rl.steps, rl.dtMax, rl.damping);
            const relaxMs = performance.now() - t0;
            const o = msg.orbit;
            kernel.setOrbit(o.sep, o.ecc || 0, o.spinA || 0, o.spinB || 0, o.pnCirc !== false);
            gwBuffer = [];
            stepsAccum = 0; msAccum = 0;
            const diag = kernel.diagnostics();
            const frame = kernel.frame();
            const ia = interactions();
            lastAux = performance.now();
            post({ type: 'built', n, nA: kernel.bodyCount(0), nB: kernel.bodyCount(1), relaxMs, frameStride: kernel.frameStride,
                bodies: [kernel.bodyState(0), kernel.bodyState(1)], diag, frame, aux: ia.aux, links: ia.links, interactions: ia.summary },
                [frame.buffer, ia.aux.buffer, ia.links.buffer]);
            return;
        }
        if (msg.type === 'run') {
            warp = msg.warp ?? warp; budgetMs = msg.budgetMs ?? budgetMs; dtMax = msg.dtMax ?? dtMax;
            running = true; lastTick = performance.now(); lastFrame = 0;
            if (!timer) timer = setTimeout(tick, 0);
            return;
        }
        if (msg.type === 'pause') { running = false; return; }
        if (msg.type === 'resume') { running = true; lastTick = performance.now(); if (!timer) timer = setTimeout(tick, 0); return; }
        if (msg.type === 'warp') { warp = msg.warp; if (msg.dtMax) dtMax = msg.dtMax; return; }
        if (msg.type === 'snapshot') { snapshot(true); return; }
    } catch (err) {
        post({ type: 'error', message: String(err && err.message || err) });
    }
};
