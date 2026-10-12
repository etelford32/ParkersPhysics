/**
 * bootes/nbody-runner.js — owns the galaxy tracker's N-body forecast run
 * ═══════════════════════════════════════════════════════════════════════════
 * Builds the observed-epoch initial conditions on the main thread (~0.3 s:
 * the quiet start + the web's linear velocities), hands them to
 * bootes/nbody-worker.js, and serves the finished frames to the track panel.
 * It computes no physics of its own: initial state, interpolation and the
 * per-galaxy sample all come from js/bootes-nbody.js (node-gated).
 *
 * ONE RUN PER MODEL STATE. The run is keyed on the derived model (profile,
 * bias, seed, clumpiness); a re-roll or a slider move starts a fresh one and
 * a stale run's messages are dropped by id. Tracked galaxies are recorded in
 * the run itself; one tracked AFTER it finished is replayed through the
 * worker's stored snapshots instead of re-running the matter.
 *
 * NO WORKER (a sandboxed iframe, an old engine): the same steppable run
 * executes on the page one step per macrotask, so the stage stays live and
 * the result is identical — the kernel does not know where it runs.
 *
 * THE RECONSTRUCTION (js/bootes-reconstruct.js, plan §4d Phase 2) is a second,
 * opt-in run on the SAME model state: the forecast's observed massive state
 * is copied before it is handed to the worker and becomes the target the
 * glass is matched to. It needs ~2 minutes of tree gravity, so it runs ONLY in
 * a Worker — on the page it would freeze the stage for that long, and the
 * status says so instead of doing it.
 */

import {
    PAGE_CONFIG, buildInitialConditions, observedState, createSimulation, createRun,
    buildSchedule, replayTestParticles, locateFrame, interpolateRows, recordSampleAt,
    relaxTables, createRelaxer,
} from '../bootes-nbody.js';
import { RECON_CONFIG, NODE_RADIUS_MPC } from '../bootes-reconstruct.js';
import { toKmsPerGyr } from '../bootes-force-probe.js';

/**
 * Smooth matter within this radius of a node counts as "on" it — the SAME
 * radius the reconstruction's node history uses, so the forecast's and the
 * reconstruction's "matter on the nodes" mean one thing.
 */
export const ACCRETION_RADIUS_MPC = NODE_RADIUS_MPC;

const pointKey = (x) => x.map(c => c.toPrecision(10)).join(',');

export function createNbodyRunner({ zObs, rEff, aEnd, onChange = () => {} }) {
    let worker = null;
    let workerBroken = typeof Worker === 'undefined';
    let seq = 0;
    let local = null;           // the no-Worker path's own run state
    const st = {
        status: 'idle',         // idle | building | running | ready | error
        key: null,
        id: 0,
        step: 0,
        steps: PAGE_CONFIG.steps,
        stage: null,            // 'relax' | 'run' while running
        relaxStep: 0,
        relaxSteps: PAGE_CONFIG.relax.iterations,
        relax: null,            // { history, shiftRmsMpc } of the finished run
        ms: null,
        error: null,
        counts: null,           // { smooth, web, galaxies }
        result: null,
        nTracers: 0,
        nNodes: 0,
        recs: new Map(),        // pointKey → { rec, nRec, k }
        pending: new Set(),
        derived: null,
        table: null,
        observed: null,         // the forecast's RELAXED massive state at z_obs, once the run is done
        observedMeta: null,
    };
    const rc = {
        status: 'idle',         // idle | running | ready | error | unavailable
        id: 0,
        key: null,
        stage: null, done: 0, total: 0,
        result: null,
        error: null,
        recs: new Map(),
        pending: new Set(),
        testKeys: [],
    };

    function ensureWorker() {
        if (worker || workerBroken) return worker;
        try {
            worker = new Worker(new URL('./nbody-worker.js', import.meta.url), { type: 'module' });
            worker.onmessage = (e) => handle(e.data);
            worker.onerror = (e) => {
                // A module worker that fails to LOAD reports here, not via a
                // message: fall back to the page and re-issue the current run.
                e.preventDefault?.();
                worker.terminate();
                worker = null;
                workerBroken = true;
                if (st.status === 'running' && st.derived) {
                    const { derived, table, key } = st;
                    st.key = null;
                    start(derived, table, [...st.pending].map(k => k.split(',').map(Number)), key);
                }
            };
        } catch {
            workerBroken = true;
            worker = null;
        }
        return worker;
    }

    function handle(m) {
        if (String(m.type).startsWith('recon')) { handleRecon(m); return; }
        if (m.id !== st.id) return;                       // a stale run
        if (m.type === 'progress') {
            st.stage = m.stage ?? 'run';
            if (st.stage === 'relax') { st.relaxStep = m.step; st.relaxSteps = m.steps; } else st.step = m.step;
            onChange(st);
        } else if (m.type === 'done') {
            st.result = m.result;
            st.ms = m.ms;
            st.relax = m.result.relax ?? null;
            // The reconstruction matches THIS state — the relaxed one the
            // forecast actually ran (plan §4i), not the raw quiet start.
            st.observed = { pos: m.result.observedPos, ...st.observedMeta };
            st.status = 'ready';
            const nRec = m.result.record.length;
            st.recordKeys.forEach((key, k) => st.recs.set(key, { rec: m.result.rec, nRec, k }));
            st.pending.clear();
            onChange(st);
        } else if (m.type === 'replay') {
            const nRec = m.keys.length;
            m.keys.forEach((key, k) => { st.recs.set(key, { rec: m.rec, nRec, k }); st.pending.delete(key); });
            onChange(st);
        } else if (m.type === 'error') {
            // A failed REPLAY leaves the run intact: those galaxies keep the
            // shell tracker's future, and the status line says why.
            if (st.status === 'ready') st.pending.clear();
            else st.status = 'error';
            st.error = m.message;
            onChange(st);
        }
    }

    function handleRecon(m) {
        if (m.id !== rc.id) return;
        if (m.type === 'recon-progress') {
            rc.stage = m.stage; rc.done = m.done; rc.total = m.total;
        } else if (m.type === 'recon-done') {
            rc.result = m.result;
            rc.status = 'ready';
            rc.testKeys.forEach((key, k) => {
                if (key) rc.recs.set(key, { rec: m.result.rec, nRec: m.result.nRec, k });
            });
            rc.pending.clear();
        } else if (m.type === 'recon-replay') {
            const nRec = m.keys.length;
            m.keys.forEach((key, k) => { rc.recs.set(key, { rec: m.rec, nRec, k }); rc.pending.delete(key); });
        } else if (m.type === 'recon-error') {
            if (rc.status === 'ready') rc.pending.clear();
            else rc.status = 'error';
            rc.error = m.message;
        }
        onChange(st);
    }

    /**
     * Reconstruct the initial conditions of the CURRENT model state and run
     * it from z = 9 to the end of the axis. `trackedPts` are recorded too.
     */
    function reconstruct(trackedPts = []) {
        if (!st.observed || !st.derived) return false;
        const w = ensureWorker();
        if (!w) { rc.status = 'unavailable'; onChange(st); return false; }
        rc.id = ++seq;
        rc.key = st.key;
        rc.status = 'running';
        rc.stage = 'glass'; rc.done = 0; rc.total = RECON_CONFIG.glassIterations;
        rc.result = null; rc.error = null;
        rc.recs.clear(); rc.pending.clear();
        const tracerPts = st.derived.tracers.flatMap(t => t.offsetMpc);
        const nodePts = st.derived.web.nodes.flatMap(n => n.offsetMpc);
        const keys = [];
        const extra = [];
        for (const p of trackedPts) {
            const k = pointKey(p);
            if (keys.includes(k)) continue;
            keys.push(k);
            extra.push(...p);
        }
        // Row k of the result is test point k: tracers, then nodes, then the
        // tracked galaxies (only those carry keys).
        rc.testKeys = [...new Array(st.nTracers + st.nNodes).fill(null), ...keys];
        keys.forEach(k => rc.pending.add(k));
        const { radius, spacing, refineRadius } = RECON_CONFIG.layout(rEff);
        w.postMessage({
            type: 'reconstruct', id: rc.id,
            args: {
                observed: st.observed,
                config: { radius, spacing, refineRadius },
                testPoints: Float64Array.from([...tracerPts, ...nodePts, ...extra]),
                nodeMarkers: { from: st.nTracers, count: st.nNodes },
                aObs: 1 / (1 + zObs), aEnd, sim: { ...PAGE_CONFIG.sim },
            },
        });
        onChange(st);
        return true;
    }

    /** Fly galaxies tracked after the reconstruction through it. */
    function reconRequest(points) {
        if (rc.status !== 'ready' || !worker) return;
        const keys = [], flat = [];
        for (const p of points) {
            const k = pointKey(p);
            if (rc.recs.has(k) || rc.pending.has(k) || keys.includes(k)) continue;
            keys.push(k);
            flat.push(...p);
        }
        if (!keys.length) return;
        keys.forEach(k => rc.pending.add(k));
        worker.postMessage({ type: 'recon-replay', id: rc.id, keys, points: Float64Array.from(flat) });
    }

    /**
     * Start (or keep) the run for this model state. `derived` is the page's
     * model ({ profile, web, tracers }); `trackedPts` the galaxies to record.
     */
    function start(derived, table, trackedPts = [], key = null) {
        if (key && key === st.key && st.status !== 'error') { request(trackedPts); return; }
        local = null;
        if (rc.key !== key) {
            // A new model state: any reconstruction belonged to the old one.
            rc.id = ++seq; rc.status = 'idle'; rc.result = null; rc.recs.clear(); rc.pending.clear();
            rc.key = null;
        }
        st.observed = null;
        st.key = key;
        st.id = ++seq;
        st.status = 'building';
        st.step = 0;
        st.result = null;
        st.error = null;
        st.recs.clear();
        st.pending.clear();
        st.derived = derived;
        st.table = table;
        onChange(st);
        const id = st.id;
        // Yield once so the "building" status paints before the ~0.3 s build.
        setTimeout(() => {
            if (id !== st.id) return;
            try {
                const tracerPts = derived.tracers.flatMap(t => t.offsetMpc);
                const uniq = [];
                const keys = [];
                for (const p of trackedPts) {
                    const k = pointKey(p);
                    if (keys.includes(k)) continue;
                    keys.push(k);
                    uniq.push(...p);
                }
                const testPoints = Float64Array.from([...tracerPts, ...uniq]);
                const ic = buildInitialConditions({
                    voidProfile: derived.profile, web: derived.web, table, zObs, testPoints,
                    ...PAGE_CONFIG.ic(rEff),
                });
                // The reconstruction's target arrives with the finished run
                // (the relaxed positions); its masses/groups are copied now,
                // before the buffers are transferred to the worker.
                st.observed = null;
                st.observedMeta = {
                    mass: Float64Array.from(ic.mass), group: Uint8Array.from(ic.group),
                    softening: ic.softening,
                };
                const tables = relaxTables({
                    voidProfile: derived.profile, web: derived.web, table, zObs,
                    rMax: PAGE_CONFIG.ic(rEff).radius * 1.02,
                });
                st.nTracers = derived.tracers.length;
                st.nNodes = derived.web.nodes.length;
                st.counts = { smooth: ic.nBackground, web: ic.nWeb, galaxies: ic.nTest };
                st.recordKeys = keys;
                keys.forEach(k => st.pending.add(k));
                const record = Int32Array.from(keys, (_, k) => st.nTracers + k);
                // The web's nodes are its first particles (bootes-web-model.js
                // pushes them first); their massive indices follow the smooth
                // matter's.
                const accretion = {
                    nodes: Int32Array.from({ length: st.nNodes }, (_, j) => ic.nBackground + j),
                    radiusMpc: ACCRETION_RADIUS_MPC,
                };
                const msg = {
                    type: 'run', id,
                    ic: {
                        pos: ic.pos, vel: ic.vel, mass: ic.mass, group: ic.group, nMassive: ic.nMassive,
                        nBackground: ic.nBackground, aStart: ic.aStart, softening: ic.softening, background: ic.background,
                    },
                    aEnd, steps: PAGE_CONFIG.steps, sim: { ...PAGE_CONFIG.sim }, record, accretion,
                    relax: { tables, ...PAGE_CONFIG.relax },
                };
                st.stage = 'relax'; st.relaxStep = 0; st.step = 0;
                st.status = 'running';
                onChange(st);
                const w = ensureWorker();
                if (w) {
                    w.postMessage(msg, [ic.pos.buffer, ic.vel.buffer]);
                } else {
                    runLocally(msg);
                }
            } catch (err) {
                st.status = 'error';
                st.error = String(err?.message ?? err);
                onChange(st);
            }
        }, 0);
    }

    /** The no-Worker path: the identical steppable run, one step per task. */
    function runLocally(msg) {
        const t0 = performance.now();
        const ic = { ...msg.ic };
        // The same relaxation as the worker's, one pass per task.
        const rl = msg.relax
            ? createRelaxer({ ...ic, tables: msg.relax.tables, iterations: msg.relax.iterations, rate: msg.relax.rate, ...msg.sim })
            : null;
        const relaxTick = () => {
            if (msg.id !== st.id) return;
            if (rl && rl.step()) {
                handle({ type: 'progress', id: msg.id, stage: 'relax', step: rl.stepsDone, steps: rl.iterations });
                setTimeout(relaxTick, 0);
                return;
            }
            let relaxInfo = null;
            if (rl) {
                const out = rl.result();
                ic.pos = out.pos; ic.vel = out.vel;
                relaxInfo = { history: out.history, shiftRmsMpc: out.shiftRmsMpc };
            }
            startRun(relaxInfo);
        };
        const startRun = (relaxInfo) => {
        const observedPos = Float64Array.from(ic.pos.subarray(0, 3 * ic.nMassive));
        const sim = createSimulation({ ...ic, ...msg.sim });
        const schedule = buildSchedule({ aStart: ic.aStart, aEnd: msg.aEnd, steps: msg.steps });
        const run = createRun(sim, schedule, {
            record: msg.record, keepSnapshots: true, background: ic.background, accretion: msg.accretion,
        });
        const tick = () => {
            if (msg.id !== st.id) return;
            const more = run.step();
            handle({ type: 'progress', id: msg.id, step: run.stepsDone, steps: msg.steps });
            if (more) { setTimeout(tick, 0); return; }
            const { snapshots, ...rest } = run.result();
            local = { snapshots, schedule, ic, sim: msg.sim };
            handle({ type: 'done', id: msg.id, result: { ...rest, observedPos, relax: relaxInfo }, ms: performance.now() - t0 });
        };
        setTimeout(tick, 0);
        };
        setTimeout(relaxTick, 0);
    }

    /** Make sure every point has a record; replay the ones that do not. */
    function request(points) {
        if (st.status !== 'ready' || !st.derived) return;
        const keys = [], flat = [];
        for (const p of points) {
            const k = pointKey(p);
            if (st.recs.has(k) || st.pending.has(k) || keys.includes(k)) continue;
            keys.push(k);
            flat.push(...p);
        }
        if (!keys.length) return;
        keys.forEach(k => st.pending.add(k));
        const init = observedState(Float64Array.from(flat), {
            voidProfile: st.derived.profile, web: st.derived.web, table: st.table, zObs,
        });
        if (worker) {
            worker.postMessage({ type: 'replay', id: st.id, keys, points: init.pos, velocities: init.vel });
        } else if (local) {
            const id = st.id;
            setTimeout(() => {
                if (id !== st.id) return;
                const rec = replayTestParticles({
                    snapshots: local.snapshots, schedule: local.schedule, mass: local.ic.mass,
                    group: local.ic.group, nMassive: local.ic.nMassive, points: init.pos,
                    velocities: init.vel, softening: local.ic.softening, background: local.ic.background,
                    ...local.sim,
                });
                handle({ type: 'replay', id, rec, keys });
            }, 0);
        }
    }

    const ready = () => st.status === 'ready' && st.result;

    return {
        state: st,
        start,
        request,
        get ready() { return !!ready(); },
        /** A tracked galaxy's N-body sample at epoch `ep`, or null if not run yet. */
        sampleFor(xObs, ep) {
            if (!ready()) return null;
            const r = st.recs.get(pointKey(xObs));
            if (!r) return null;
            return recordSampleAt(r.rec, r.nRec, r.k, st.result.N, ep, toKmsPerGyr);
        },
        /** Every tracer at scale factor a (Float32Array 3·nTracers), or null. */
        tracerPositionsAt(a, out) {
            if (!ready()) return null;
            const res = st.result;
            return interpolateRows(res.testPos, res.nTest, 3, locateFrame(res.N, a),
                out ?? new Float32Array(st.nTracers * 3), 0, st.nTracers);
        },
        /** The web's node positions at scale factor a (Float32Array 3·nNodes). */
        nodePositionsAt(a) {
            if (!ready()) return null;
            const res = st.result;
            const nWeb = res.webIndices.length;
            return interpolateRows(res.webPos, nWeb, 3, locateFrame(res.N, a),
                new Float32Array(st.nNodes * 3), 0, st.nNodes);
        },
        /** Smooth mass within ACCRETION_RADIUS_MPC of the nodes, ÷ its z_obs value. */
        accretionAt(a) {
            if (!ready() || !st.result.accreted) return null;
            const res = st.result;
            const v = interpolateRows(res.accreted, 1, 1, locateFrame(res.N, a), new Float64Array(1));
            return v[0] / res.accreted[0];
        },
        get aStart() { return ready() ? st.result.a[0] : null; },

        // ── The reconstruction ──
        recon: rc,
        reconstruct,
        reconRequest,
        get canReconstruct() { return !!st.observed && !workerBroken; },
        get workerAvailable() { return !workerBroken; },
        get reconReady() { return rc.status === 'ready' && !!rc.result; },
        get reconAInit() { return rc.result ? rc.result.a[0] : null; },
        reconSampleFor(xObs, ep) {
            if (!(rc.status === 'ready' && rc.result)) return null;
            const r = rc.recs.get(pointKey(xObs));
            if (!r) return null;
            return recordSampleAt(r.rec, r.nRec, r.k, rc.result.N, ep, toKmsPerGyr);
        },
        reconTracersAt(a, out) {
            if (!(rc.status === 'ready' && rc.result)) return null;
            const res = rc.result;
            return interpolateRows(res.testPos, res.nTest, 3, locateFrame(res.N, a),
                out ?? new Float32Array(st.nTracers * 3), 0, st.nTracers);
        },
        reconNodesAt(a) {
            if (!(rc.status === 'ready' && rc.result)) return null;
            const res = rc.result;
            return interpolateRows(res.testPos, res.nTest, 3, locateFrame(res.N, a),
                new Float32Array(st.nNodes * 3), st.nTracers, st.nNodes);
        },
        /** Matter within NODE_RADIUS of the node markers, ÷ its z_obs value. */
        reconAccretionAt(a) {
            if (!(rc.status === 'ready' && rc.result?.accreted)) return null;
            const res = rc.result;
            const v = interpolateRows(res.accreted, 1, 1, locateFrame(res.N, a), new Float64Array(1));
            return v[0] / res.accreted[res.obsFrame];
        },
    };
}
