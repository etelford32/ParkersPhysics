/**
 * bootes/track-panel.js — the galaxy tracker's controls, readouts and playback
 * ═══════════════════════════════════════════════════════════════════════════
 * The DOM half of the galaxy tracker. Every number comes from
 * js/bootes-void-tracker.js; this module owns WHICH galaxies are tracked, the
 * scrubbed instant, playback, and pushing the result to the readouts (through
 * page.js's `set`, so the data-bv gate covers these keys), the three charts and
 * the stage (bootes/track-layer.js + the tracer field + the web).
 *
 * A TRACKED GALAXY IS ITS OBSERVED POSITION. It is stored as the comoving point
 * where the model galaxy sits at the observed epoch, not as an index into the
 * tracer array — re-rolling the web re-samples the tracers, and an index would
 * silently start following a different galaxy. After a re-roll the same point
 * is re-tracked through the new web, and the table row says "re-tracked".
 *
 * ONE INSTANT EVERYWHERE. The scrubber sets one cosmic time; the readouts, the
 * chart crosshairs, the rings on the stage and (with "move every galaxy" on)
 * all 3 500 tracers and the web's nodes are drawn at that instant. At the
 * observed epoch the stage is put back EXACTLY as the rest of the page drew it
 * (`setTracerOffsetsMpc(null)` + the original web), so every other readout on
 * the page — which is an observed-epoch claim — stays true of the picture.
 */

import {
    buildTimeline, trackGalaxy, epochAt, displacementField, displacedPositions,
} from '../bootes-void-tracker.js';
import { drawTrackSeries } from './charts.js';

/**
 * One colour per tracked galaxy, bound to the GALAXY (a removed galaxy frees
 * its colour; the others keep theirs). Chosen to stay clear of the page's
 * term palette — void blue, web orange, clumping green, total violet — which
 * the probe arrows use on the same stage.
 */
export const TRACK_COLORS = Object.freeze(['#f5c542', '#f07ab8', '#b8f0ff']);
export const MAX_TRACKED = TRACK_COLORS.length;
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const signed = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}` : '—');

/** Play speed: Gyr of cosmic time per second of wall clock. */
const PLAY_GYR_PER_S = 1.6;

export function createTrackPanel({
    root, set, scene, charts, getDerived, rEff, z: zObs,
    getProbePosition = () => null, onArmPick = null,
}) {
    const card = root.querySelector('#bv-track-card');
    const table = root.querySelector('#bv-track-rows');
    const playBtn = root.querySelector('#bv-track-play');
    const pickBtn = root.querySelector('#bv-track-pick');
    const controls = {};
    root.querySelectorAll('[data-bv-track]').forEach(el => {
        controls[el.getAttribute('data-bv-track')] = el;
    });

    const timeline = buildTimeline({ zObs, tStartGyr: 1, samples: 140 });
    const tObs = timeline.tObsGyr;
    const t0 = timeline.t0Gyr;

    const state = {
        tGyr: tObs,
        animate: true,
        paths: true,
        tracked: [],            // { key, letter, color, xObsMpc, track, retracked }
        playing: false,
        pickArmed: false,
    };
    let letterCursor = 0;
    let bulk = null;            // { key, tracerPts, nodePts, psiTracers, psiNodes }
    let derivedKey = '';
    let frameRequested = false;
    let booted = false;

    if (controls.t) {
        controls.t.min = String(timeline.tStartGyr);
        controls.t.max = String(timeline.tEndGyr.toFixed(2));
        controls.t.step = '0.01';
        controls.t.value = String(tObs);
    }

    const keyOf = (d) => `${d.web.seed}|${d.web.clumpiness}|${d.profile.params.deltaC}|${d.profile.params.rsMpc}`;

    // ── Tracking ────────────────────────────────────────────────────────────
    function track(xObsMpc) {
        const d = getDerived();
        return trackGalaxy(xObsMpc, { voidProfile: d.profile, web: d.web, zObs, timeline });
    }

    function add(xObsMpc) {
        if (!getDerived()) return null;
        if (state.tracked.length >= MAX_TRACKED) state.tracked.shift();
        const used = new Set(state.tracked.map(t => t.color));
        const color = TRACK_COLORS.find(c => !used.has(c)) ?? TRACK_COLORS[0];
        const entry = {
            key: `${letterCursor}`,
            letter: LETTERS[letterCursor % LETTERS.length],
            color,
            xObsMpc: [...xObsMpc],
            track: track(xObsMpc),
            retracked: false,
        };
        letterCursor++;
        state.tracked.push(entry);
        paint();
        return entry;
    }

    function remove(key) {
        state.tracked = state.tracked.filter(t => t.key !== key);
        paint();
    }

    /** Model tracers inside R_eff, nearest the centre first, not yet tracked. */
    function voidGalaxies() {
        const d = getDerived();
        if (!d) return [];
        return d.tracers
            .map((t, i) => ({ i, r: t.radiusMpc, p: t.offsetMpc }))
            .filter(t => t.r < rEff)
            .filter(t => !state.tracked.some(s => Math.hypot(...s.xObsMpc.map((c, k) => c - t.p[k])) < 1e-6))
            .sort((a, b) => a.r - b.r);
    }

    // ── Painting ────────────────────────────────────────────────────────────
    function schedule() {
        if (frameRequested) return;
        frameRequested = true;
        (globalThis.requestAnimationFrame ?? ((fn) => setTimeout(fn, 16)))(() => {
            frameRequested = false;
            paint();
        });
    }

    function cursorIndex(t) {
        const eps = timeline.epochs;
        let k = 0;
        for (let i = 0; i < eps.length; i++) if (eps[i].tGyr <= t) k = i;
        return k;
    }

    function paint() {
        const d = getDerived();
        if (!d) return;
        const ep = epochAt(state.tGyr, zObs);
        const atObs = Math.abs(state.tGyr - tObs) < 1e-6;

        // Readouts for the instant.
        set('trackTime', `t = ${num(state.tGyr, 2)} Gyr · z = ${num(ep.z, ep.z < 0.1 ? 4 : 2)}`);
        const dt = state.tGyr - tObs;
        set('trackEpoch', atObs
            ? 'the observed epoch — when the light we see left Boötes'
            : state.tGyr > t0
                ? `${num(state.tGyr - t0, 2)} Gyr after today — a linear-theory forecast`
                : dt < 0
                    ? `${num(-dt, 2)} Gyr before the light we see left Boötes`
                    : `${num(dt, 2)} Gyr after it (today is t = ${num(t0, 2)} Gyr)`);
        set('trackGrowth', `× ${num(ep.D, 3)}`);
        set('trackGScale', `× ${num(ep.gravity, 3)}`);
        set('trackVScale', `× ${num(ep.velocity, 3)}`);

        const samples = state.tracked.map(t => t.track.at(ep));
        const nonlinear = samples.filter(s => !s.linearOk).length;
        set('trackLinear', state.tracked.length === 0
            ? 'Nothing tracked — add a galaxy.'
            : nonlinear === 0
                ? 'Every tracked galaxy is in the linear range here (|δ| ≤ 0.5).'
                : `${nonlinear} of ${state.tracked.length} tracked galaxies sit where |δ| > 0.5 — past where `
                  + 'linear theory is accurate; read their curves as indicative.');

        paintTable(samples);
        paintCharts();
        paintStage(ep, atObs, d);
        card?.setAttribute('data-track-ready', '1');
        card?.setAttribute('data-track-t', state.tGyr.toFixed(4));
    }

    function paintTable(samples) {
        if (!table) return;
        table.replaceChildren();
        state.tracked.forEach((t, i) => {
            const s = samples[i];
            const tr = document.createElement('tr');
            // Drift since the first epoch on the axis — the honest scale of the
            // motion: void galaxies move a few to ~15 Mpc in 18 Gyr, which is
            // why the stage needs "fly to" to show it rather than a magnified
            // displacement.
            const r0 = t.track.samples[0].rMpc;
            const cells = [
                null,
                `${num(s.rMpc, 1)} (${signed(s.rMpc - r0, 1)})`,
                `${num(s.gA, 2)}`,
                `${num(s.voidShare * 100, 0)} %`,
                `${num(s.vKms, 0)} (${signed(s.vRadialKms, 0)})`,
                signed(s.delta, 2),
                s.tweb.name,
            ];
            const name = document.createElement('td');
            const sw = document.createElement('span');
            sw.className = 'bv-sw';
            sw.style.background = t.color;
            name.append(sw, document.createTextNode(`Galaxy ${t.letter}${t.retracked ? ' (re-tracked)' : ''}`));
            tr.appendChild(name);
            for (const text of cells.slice(1)) {
                const td = document.createElement('td');
                td.textContent = text;
                tr.appendChild(td);
            }
            const tdBtn = document.createElement('td');
            tdBtn.style.whiteSpace = 'nowrap';
            const fly = document.createElement('button');
            fly.type = 'button';
            fly.className = 'bv-probe-go';
            fly.textContent = 'fly to';
            fly.title = `Fly the camera to galaxy ${t.letter} at this instant`;
            fly.addEventListener('click', () => {
                scene?.focusOnMpc(s.positionMpc, { distanceMpc: Math.max(25, 3 * Math.abs(s.rMpc - r0) + 20) });
            });
            if (scene) tdBtn.appendChild(fly);
            const rm = document.createElement('button');
            rm.type = 'button';
            rm.className = 'bv-probe-go';
            rm.textContent = '×';
            rm.title = `Stop tracking galaxy ${t.letter}`;
            rm.addEventListener('click', () => remove(t.key));
            tdBtn.appendChild(rm);
            tr.appendChild(tdBtn);
            table.appendChild(tr);
        });
    }

    function paintCharts() {
        const c = (key) => charts.get(key);
        const marks = [
            { x: tObs, label: 'light left', color: 'rgba(79,195,247,.5)' },
            { x: t0, label: 'today', color: 'rgba(255,255,255,.35)' },
        ];
        const common = { tMin: timeline.tStartGyr, tMax: timeline.tEndGyr, cursorT: state.tGyr, marks };
        const lines = (pick) => state.tracked.map(t => ({
            color: t.color,
            points: t.track.samples.map(s => [s.tGyr, pick(s)]),
        }));
        if (c('trackG')) {
            drawTrackSeries(c('trackG'), { ...common, series: lines(s => s.gA),
                yLabel: '|g| on the galaxy  (km/s per Gyr)' });
        }
        if (c('trackV')) {
            drawTrackSeries(c('trackV'), { ...common, series: lines(s => s.vKms),
                yLabel: 'peculiar speed  (km/s)' });
        }
        if (c('trackR')) {
            drawTrackSeries(c('trackR'), { ...common, series: lines(s => s.rMpc),
                yLabel: 'distance from the void centre  (comoving Mpc)', includeZero: false });
        }
    }

    function ensureBulk(d) {
        const key = keyOf(d);
        if (bulk && bulk.key === key) return bulk;
        const tracerPts = d.tracers.map(t => t.offsetMpc);
        const nodePts = d.web.nodes.map(n => n.offsetMpc);
        bulk = {
            key, tracerPts, nodePts,
            psiTracers: displacementField(tracerPts, { voidProfile: d.profile, web: d.web, zObs }),
            psiNodes: displacementField(nodePts, { voidProfile: d.profile, web: d.web, zObs }),
            out: new Float32Array(tracerPts.length * 3),
            moved: false,
        };
        return bulk;
    }

    function paintStage(ep, atObs, d) {
        if (!scene) return;
        // The field and the web: moved only when asked, and put back EXACTLY
        // at the observed epoch.
        if (state.animate && !atObs) {
            const b = ensureBulk(d);
            scene.setTracerOffsetsMpc(displacedPositions(b.tracerPts, b.psiTracers, ep.D, b.out));
            const nodePos = displacedPositions(b.nodePts, b.psiNodes, ep.D);
            scene.buildWeb({
                nodes: d.web.nodes.map((n, i) => ({
                    ...n, offsetMpc: [nodePos[i * 3], nodePos[i * 3 + 1], nodePos[i * 3 + 2]],
                })),
                filaments: d.web.filaments,
            });
            b.moved = true;
        } else if (bulk?.moved) {
            scene.setTracerOffsetsMpc(null);
            scene.buildWeb(d.web);
            bulk.moved = false;
        }
        const k = cursorIndex(state.tGyr);
        scene.tracks.set(state.tracked.map(t => ({
            color: t.color,
            pathMpc: t.track.samples.map(s => s.positionMpc),
            cursorIndex: k,
            currentMpc: t.track.at(ep).positionMpc,
            startMpc: t.track.lagrangianMpc,
        })), { paths: state.paths });
    }

    // ── Time ────────────────────────────────────────────────────────────────
    function setTime(t) {
        state.tGyr = Math.max(timeline.tStartGyr, Math.min(timeline.tEndGyr, t));
        if (controls.t && document.activeElement !== controls.t) controls.t.value = String(state.tGyr);
        schedule();
    }

    let lastStamp = null;
    function step(stamp) {
        if (!state.playing) return;
        if (lastStamp != null) {
            const dtS = Math.min(0.1, (stamp - lastStamp) / 1000);
            const next = state.tGyr + dtS * PLAY_GYR_PER_S;
            if (next >= timeline.tEndGyr) { setTime(timeline.tEndGyr); setPlaying(false); return; }
            setTime(next);
        }
        lastStamp = stamp;
        requestAnimationFrame(step);
    }
    function setPlaying(on) {
        state.playing = !!on;
        playBtn?.setAttribute('aria-pressed', String(state.playing));
        if (playBtn) playBtn.textContent = state.playing ? '❚❚ Pause' : '▶ Play';
        if (state.playing) {
            if (state.tGyr >= timeline.tEndGyr - 1e-6) setTime(timeline.tStartGyr);
            lastStamp = null;
            requestAnimationFrame(step);
        }
    }

    // ── Inputs ──────────────────────────────────────────────────────────────
    for (const [key, el] of Object.entries(controls)) {
        const handler = () => {
            if (key === 't') { setPlaying(false); setTime(Number(el.value)); }
            else if (key === 'animate') { state.animate = el.checked; schedule(); }
            else if (key === 'paths') { state.paths = el.checked; schedule(); }
        };
        el.addEventListener('input', handler);
        if (el.type === 'checkbox') el.addEventListener('change', handler);
    }
    playBtn?.addEventListener('click', () => setPlaying(!state.playing));
    root.querySelector('#bv-track-obs')?.addEventListener('click', () => { setPlaying(false); setTime(tObs); });
    root.querySelector('#bv-track-now')?.addEventListener('click', () => { setPlaying(false); setTime(t0); });
    root.querySelector('#bv-track-add-deep')?.addEventListener('click', () => {
        const g = voidGalaxies()[0];
        if (g) add(g.p);
    });
    root.querySelector('#bv-track-add-random')?.addEventListener('click', () => {
        const list = voidGalaxies();
        if (list.length) add(list[Math.floor(Math.random() * list.length)].p);
    });
    root.querySelector('#bv-track-add-probe')?.addEventListener('click', () => {
        const p = getProbePosition();
        if (p) add(p);
    });
    root.querySelector('#bv-track-clear')?.addEventListener('click', () => {
        state.tracked = [];
        paint();
    });

    // Pick tool: a TAP on the stage (pointerup within 6 px / 600 ms of its
    // pointerdown, on event.timeStamp — the mars.html rule) picks the nearest
    // drawn galaxy. A drag still orbits; the tool never captures the pointer.
    const canvas = root.querySelector('#bv-stage');
    let down = null;
    function setPickArmed(on) {
        state.pickArmed = !!on && !!scene;
        pickBtn?.setAttribute('aria-pressed', String(state.pickArmed));
        if (state.pickArmed) onArmPick?.();
    }
    pickBtn?.addEventListener('click', () => setPickArmed(!state.pickArmed));
    if (!scene && pickBtn) pickBtn.hidden = true;
    canvas?.addEventListener('pointerdown', (e) => {
        down = state.pickArmed && e.button === 0 && !e.shiftKey
            ? { x: e.clientX, y: e.clientY, t: e.timeStamp } : null;
    });
    canvas?.addEventListener('pointerup', (e) => {
        if (!down) return;
        const tap = Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 6 && e.timeStamp - down.t <= 600;
        down = null;
        if (!tap) return;
        const i = scene.pickTracer(e.clientX, e.clientY);
        const d = getDerived();
        if (i >= 0 && d?.tracers[i]) add(d.tracers[i].offsetMpc);
    });

    return {
        /** After every recompute: re-track every galaxy at its observed point. */
        refresh() {
            const d = getDerived();
            if (!d) return;
            const key = keyOf(d);
            const changed = key !== derivedKey && derivedKey !== '';
            derivedKey = key;
            bulk = null;
            for (const t of state.tracked) {
                t.track = track(t.xObsMpc);
                if (changed) t.retracked = true;
            }
            // First boot only: start with the deepest void galaxy so the card
            // never opens on an empty table. A reader who clears it keeps it
            // cleared across later recomputes.
            if (!booted) {
                booted = true;
                const g = voidGalaxies()[0];
                if (g) { add(g.p); return; }
            }
            paint();
        },
        paintCharts,
        setTime,
        setPlaying,
        setPickArmed,
        add,
        get timeline() { return timeline; },
        get state() {
            return { ...state, tracked: state.tracked.map(t => ({ letter: t.letter, color: t.color, xObsMpc: [...t.xObsMpc] })) };
        },
        get tracked() { return state.tracked; },
        /**
         * page.js repainted the stage at the observed epoch (a field-mode or
         * redshift-space toggle rebuilds the tracers and the web without a
         * recompute). Whatever this panel had moved is back at z_obs now, so
         * re-apply the scrubbed instant.
         */
        onScenePainted() {
            if (bulk) bulk.moved = false;
            schedule();
        },
    };
}
