/**
 * bootes/nbody-worker.js — runs js/bootes-nbody.js off the main thread
 * ═══════════════════════════════════════════════════════════════════════════
 * A thin shell: every number comes from the PURE kernel, which the node gate
 * (tests/bootes-nbody.mjs) runs directly. The page's run is ~7 s of tree
 * gravity in V8; here it cannot freeze the stage.
 *
 * Messages in:
 *   { type: 'run', id, ic, aEnd, steps, sim, record, accretion, relax }
 *       ic = { pos, vel, mass, group, nMassive, nBackground, aStart, softening, background }
 *       relax = { tables, iterations, rate } — relax the smooth matter onto the
 *       exact model field first (bootes-nbody.js createRelaxer, plan §4i)
 *   { type: 'replay', id, keys, points, velocities }   — against the LAST run
 *   { type: 'reconstruct', id, args }   — js/bootes-reconstruct.js reconstructRun
 *   { type: 'recon-replay', id, keys, points }        — galaxies through it
 * Messages out:
 *   { type: 'progress', id, stage, step, steps }  — stage 'relax' | 'run'
 *   { type: 'done', id, result, ms }              — typed arrays transferred;
 *       result.observedPos is the RELAXED massive state (the reconstruction's target)
 *   { type: 'replay', id, keys, rec }
 *   { type: 'recon-progress', id, stage, done, total }
 *   { type: 'recon-done', id, result }
 *   { type: 'recon-replay', id, keys, rec }
 *   { type: 'error' | 'recon-error', id, message }
 *
 * The last run's massive snapshots stay here (~8 MB) so a galaxy tracked
 * after the run can be flown through the same matter without re-running it —
 * bitwise the same path an inline test particle would have taken (gated).
 */

import {
    createSimulation, createRun, buildSchedule, replayTestParticles, createRelaxer,
} from '../bootes-nbody.js';
import { reconstructRun, shootGalaxies, interpolateDisplacement } from '../bootes-reconstruct.js';

let last = null;
let recon = null;           // the last reconstruction's matter, for galaxy replays

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
            const ic = { ...m.ic };
            let relaxInfo = null;
            if (m.relax) {
                const rl = createRelaxer({ ...ic, tables: m.relax.tables, iterations: m.relax.iterations, rate: m.relax.rate, ...m.sim });
                const total = rl.iterations;
                self.postMessage({ type: 'progress', id: m.id, stage: 'relax', step: 0, steps: total });
                while (rl.step()) self.postMessage({ type: 'progress', id: m.id, stage: 'relax', step: rl.stepsDone, steps: total });
                const out = rl.result();
                ic.pos = out.pos; ic.vel = out.vel;
                relaxInfo = { history: out.history, shiftRmsMpc: out.shiftRmsMpc };
            }
            const observedPos = Float64Array.from(ic.pos.subarray(0, 3 * ic.nMassive));
            const sim = createSimulation({ ...ic, ...m.sim });
            const schedule = buildSchedule({ aStart: ic.aStart, aEnd: m.aEnd, steps: m.steps });
            const run = createRun(sim, schedule, {
                record: m.record, keepSnapshots: true, background: ic.background, accretion: m.accretion,
            });
            while (run.step()) self.postMessage({ type: 'progress', id: m.id, stage: 'run', step: run.stepsDone, steps: m.steps });
            self.postMessage({ type: 'progress', id: m.id, stage: 'run', step: run.stepsDone, steps: m.steps });
            const { snapshots, ...rest } = run.result();
            const result = { ...rest, observedPos, relax: relaxInfo };
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
        } else if (m.type === 'reconstruct') {
            const out = reconstructRun({
                ...m.args,
                onProgress: (stage, done, total) => self.postMessage({
                    type: 'recon-progress', id: m.id, stage, done, total,
                }),
            });
            recon = {
                snapshots: out.snapshots, schedule: out.schedule, mass: out.mass, group: out.group,
                nMassive: out.nMassive, softening: out.softening, background: out.background,
                matched: out.matched, psi: out.psi, spacing: out.spacing, aObs: m.args.aObs, sim: m.args.sim,
            };
            const result = {
                frames: out.frames, nTest: out.nTest, N: out.N, a: out.a, obsFrame: out.obsFrame,
                testPos: out.testPos, rec: out.rec, nRec: out.nRec, accreted: out.accreted,
                diagnostics: out.diagnostics,
            };
            self.postMessage({ type: 'recon-done', id: m.id, result }, transferablesOf(result));
        } else if (m.type === 'recon-replay') {
            if (!recon) throw new Error('no reconstruction to replay against');
            const psi0 = interpolateDisplacement(m.points, recon.matched, recon.psi, 2 * recon.spacing);
            const gal = shootGalaxies({
                snapshots: recon.snapshots, schedule: recon.schedule, mass: recon.mass, group: recon.group,
                nMassive: recon.nMassive, softening: recon.softening, background: recon.background,
                targets: m.points, psi0, aObs: recon.aObs, ...recon.sim,
            });
            const rec = { ...gal.rec, split: false };
            self.postMessage({ type: 'recon-replay', id: m.id, keys: m.keys, rec }, transferablesOf(rec));
        }
    } catch (err) {
        self.postMessage({
            type: String(m.type).startsWith('recon') ? 'recon-error' : 'error',
            id: m.id, message: String(err?.message ?? err),
        });
    }
};
