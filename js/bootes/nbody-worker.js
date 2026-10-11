/**
 * bootes/nbody-worker.js — runs js/bootes-nbody.js off the main thread
 * ═══════════════════════════════════════════════════════════════════════════
 * A thin shell: every number comes from the PURE kernel, which the node gate
 * (tests/bootes-nbody.mjs) runs directly. The page's run is ~7 s of tree
 * gravity in V8; here it cannot freeze the stage.
 *
 * Messages in:
 *   { type: 'run', id, ic, aEnd, steps, sim, record, accretion }
 *       ic = { pos, vel, mass, group, nMassive, aStart, softening, background }
 *   { type: 'replay', id, keys, points, velocities }   — against the LAST run
 * Messages out:
 *   { type: 'progress', id, step, steps }
 *   { type: 'done', id, result, ms }              — typed arrays transferred
 *   { type: 'replay', id, keys, rec }
 *   { type: 'error', id, message }
 *
 * The last run's massive snapshots stay here (~8 MB) so a galaxy tracked
 * after the run can be flown through the same matter without re-running it —
 * bitwise the same path an inline test particle would have taken (gated).
 */

import {
    createSimulation, createRun, buildSchedule, replayTestParticles,
} from '../bootes-nbody.js';

let last = null;

const transferablesOf = (obj) => {
    const out = [];
    const walk = (v) => {
        if (!v) return;
        if (ArrayBuffer.isView(v)) { if (!out.includes(v.buffer)) out.push(v.buffer); return; }
        if (typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(obj);
    return out;
};

self.onmessage = (e) => {
    const m = e.data;
    try {
        if (m.type === 'run') {
            const t0 = performance.now();
            const { ic } = m;
            const sim = createSimulation({ ...ic, ...m.sim });
            const schedule = buildSchedule({ aStart: ic.aStart, aEnd: m.aEnd, steps: m.steps });
            const run = createRun(sim, schedule, {
                record: m.record, keepSnapshots: true, background: ic.background, accretion: m.accretion,
            });
            while (run.step()) self.postMessage({ type: 'progress', id: m.id, step: run.stepsDone, steps: m.steps });
            self.postMessage({ type: 'progress', id: m.id, step: run.stepsDone, steps: m.steps });
            const { snapshots, ...result } = run.result();
            last = {
                snapshots, schedule, mass: ic.mass, group: ic.group, nMassive: ic.nMassive,
                softening: ic.softening, background: ic.background, sim: m.sim,
            };
            const ms = performance.now() - t0;
            self.postMessage({ type: 'done', id: m.id, result, ms }, transferablesOf(result));
        } else if (m.type === 'replay') {
            if (!last) throw new Error('no finished run to replay against');
            const rec = replayTestParticles({
                snapshots: last.snapshots, schedule: last.schedule, mass: last.mass, group: last.group,
                nMassive: last.nMassive, points: m.points, velocities: m.velocities,
                softening: last.softening, background: last.background, ...last.sim,
            });
            self.postMessage({ type: 'replay', id: m.id, keys: m.keys, rec }, transferablesOf(rec));
        }
    } catch (err) {
        self.postMessage({ type: 'error', id: m.id, message: String(err?.message ?? err) });
    }
};
