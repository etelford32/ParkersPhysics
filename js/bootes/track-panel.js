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
 *
 * THE N-BODY MODE IS A FORECAST, AND ONLY A FORECAST. "N-body forecast" runs
 * every particle — the void's smooth matter and the web's mass — under its
 * own gravity FORWARD from the observed epoch (js/bootes-nbody.js, in a
 * worker via bootes/nbody-runner.js). Before z_obs the track is the shell
 * reconstruction, exactly as in the nonlinear mode: running the past as an
 * N-body needs initial conditions for the web's clumps, an inverse problem
 * this page does not solve (BOOTES_VOID_PLAN.md §4d). The ghost line in this
 * mode is the SHELL tracker, so what the self-gravitating web changes is
 * drawn, not asserted. Until the run finishes the future falls back to the
 * shell tracker and the status line says so.
 *
 * "Reconstruct the past" (js/bootes-reconstruct.js, plan §4d Phase 2) adds the
 * other half: initial conditions at z = 9 that the same N-body evolves into
 * today's model web, run through to the end of the axis. Once it lands, the
 * N-body mode draws THAT run for the whole span — past and future from one
 * simulation, each galaxy shot to where it is observed — and the readout
 * prints how well it reproduces today's gravity.
 */

import {
    buildTimeline, trackGalaxy, epochAt, shellTable, bulkMotion, scaleFactorAtTime,
} from '../bootes-void-tracker.js';
import { drawTrackSeries } from './charts.js';
import { createNbodyRunner } from './nbody-runner.js';

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

/**
 * The band's half-width in tracer bias: ±20 %, the page's own stated error
 * budget (the bias slider's hint, js/bootes-void-model.js header). The band is
 * that ONE systematic run through the whole tracker — profile, web and
 * dynamics rebuilt at b × 0.8 and b × 1.2 — not a statistical interval.
 */
export const BIAS_BAND = 0.2;

export function createTrackPanel({
    root, set, scene, charts, getDerived, rEff, z: zObs,
    getProbePosition = () => null, onArmPick = null,
    getVariant = null, getBias = () => null,
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
    // The exact spherical-shell solution, integrated once per page (~0.1 s):
    // it depends only on the cosmology and z_obs, never on the profile.
    const shells = shellTable({ zObs });

    const state = {
        tGyr: tObs,
        animate: true,
        paths: true,
        tracked: [],            // { key, letter, color, xObsMpc, track, linear, band, retracked }
        playing: false,
        pickArmed: false,
        mode: 'nonlinear',      // or 'linear' (the A/B reference) or 'nbody' (forecast)
        band: true,
        frame: 'comoving',      // or 'proper'
        follow: false,
    };
    let followLast = null;      // scene-space position the camera rig last followed
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

    // ── The N-body forecast ─────────────────────────────────────────────────
    const reconBtn = root.querySelector('#bv-track-recon');
    const runner = createNbodyRunner({
        zObs, rEff, aEnd: scaleFactorAtTime(timeline.tEndGyr),
        onChange: () => {
            if (runner.ready) runner.request(state.tracked.map(t => t.xObsMpc));
            if (runner.reconReady) runner.reconRequest(state.tracked.map(t => t.xObsMpc));
            recomposeNbody();
            schedule();
        },
    });
    function ensureRun() {
        const d = getDerived();
        if (state.mode !== 'nbody' || !d) return;
        runner.start(d, shells, state.tracked.map(t => t.xObsMpc), keyOf(d));
    }
    /**
     * The reconstruction for its whole span once it has landed; otherwise the
     * shell track until z_obs and the forecast record after it (once run).
     */
    function composeNbody(xObsMpc, base) {
        const at = (ep) => {
            if (runner.reconReady && ep.a >= runner.reconAInit) {
                const r = runner.reconSampleFor(xObsMpc, ep);
                if (r) return { ...r, reconstructed: true };
            }
            return (ep.tGyr > tObs + 1e-9 ? runner.sampleFor(xObsMpc, ep) : null) ?? base.at(ep);
        };
        return { ...base, mode: 'nbody', at, samples: timeline.epochs.map(at) };
    }
    function recomposeNbody() {
        if (state.mode !== 'nbody') return;
        for (const t of state.tracked) if (t.linear) t.main = composeNbody(t.xObsMpc, t.linear);
    }

    // ── Tracking ────────────────────────────────────────────────────────────
    const trackWith = (xObsMpc, d, mode) => trackGalaxy(xObsMpc, {
        voidProfile: d.profile, web: d.web, zObs, timeline, mode, table: shells,
    });

    /**
     * Everything one tracked galaxy needs: the track in the chosen mode, the
     * LINEAR track beside it (drawn ghosted, so the nonlinear correction is
     * visible rather than asserted), and the bias band. Each variant starts
     * from the SAME observed position — the galaxy is seen where it is
     * whatever b is; b changes the matter around it.
     */
    function track(xObsMpc) {
        const d = getDerived();
        const nbody = state.mode === 'nbody';
        // In N-body mode the shell tracker is both the past AND the ghost.
        const shellMode = nbody ? 'nonlinear' : state.mode;
        let main = trackWith(xObsMpc, d, shellMode);
        let linear = state.mode === 'nonlinear' ? trackWith(xObsMpc, d, 'linear') : null;
        if (nbody) { linear = main; main = composeNbody(xObsMpc, linear); }
        let band = null;
        if (state.band && getVariant) {
            const b = getBias();
            // The band is the shell model at b ± 20 %. In N-body mode it stops
            // at z_obs: a band on the forecast would need two more runs.
            band = [1 - BIAS_BAND, 1 + BIAS_BAND]
                .map(f => getVariant(b * f))
                .filter(Boolean)
                .map(v => trackWith(xObsMpc, v, shellMode));
            if (band.length !== 2) band = null;
        }
        return { main, linear, band };
    }
    function retrackAll() {
        for (const t of state.tracked) Object.assign(t, track(t.xObsMpc));
        bulk = null;
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
            ...track(xObsMpc),
            retracked: false,
        };
        letterCursor++;
        state.tracked.push(entry);
        if (state.mode === 'nbody') {
            ensureRun();
            runner.request([entry.xObsMpc]);
            runner.reconRequest([entry.xObsMpc]);
        }
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

    function nbodyStatus() {
        if (state.mode !== 'nbody') return 'N-body run: off — choose "N-body forecast" above.';
        const r = runner.state;
        const parts = r.counts
            ? `${(r.counts.smooth + r.counts.web).toLocaleString('en-US')} particles `
              + `(${r.counts.web} of them the web), ${r.counts.galaxies.toLocaleString('en-US')} galaxies as test particles`
            : '';
        if (r.status === 'building') return 'N-body run: building the observed-epoch initial conditions…';
        if (r.status === 'running' && r.stage === 'relax') {
            return `N-body run: settling the sampled matter onto the model's exact field (pass ${r.relaxStep} of ${r.relaxSteps}) · ${parts}`;
        }
        if (r.status === 'running') return `N-body run: step ${r.step} of ${r.steps} · ${parts}`;
        if (r.status === 'error') return `N-body run failed (${r.error}) — the future shown is the shell tracker's.`;
        if (r.status === 'ready') {
            const pend = r.pending.size ? ` · ${r.pending.size} new galaxy(ies) being flown through it` : '';
            return `N-body run: done in ${num(r.ms / 1000, 1)} s · ${parts}${pend}.`;
        }
        return 'N-body run: idle';
    }

    const STAGES = {
        glass: 'settling a uniform glass',
        match: 'matching it to today\'s web',
        '2lpt': 'splitting the displacement into first and second order (2LPT) and correcting for the softened growth',
        run: 'running z = 9 → today → +6 Gyr',
        galaxies: 'landing every galaxy where it is seen',
    };
    function reconStatus() {
        const r = runner.recon;
        if (state.mode !== 'nbody') return 'Reconstruction: N-body mode only.';
        if (r.status === 'unavailable' || !runner.workerAvailable) {
            return 'Reconstruction needs a background worker (~2 min of gravity would freeze this page).';
        }
        if (r.status === 'running') return `Reconstructing: ${STAGES[r.stage] ?? r.stage} (${r.done}/${r.total})…`;
        if (r.status === 'error') return `Reconstruction failed (${r.error}).`;
        if (r.status === 'ready') {
            const dg = r.result.diagnostics;
            const inner = dg.fieldBins.filter(b => b.r1 <= rEff).map(b => b.rel);
            // Past R_eff the void and its wall cancel, so a percentage of the
            // LOCAL field grows towards the rim while the miss itself stays
            // flat (plan §4j): quote the outside against the void's peak pull.
            const peak = Math.max(...dg.fieldBins.map(b => b.field));
            const outer = Math.max(...dg.fieldBins.filter(b => b.r1 > rEff).map(b => b.abs));
            const g = dg.galaxyResidualsMpc[dg.galaxyResidualsMpc.length - 1];
            return `Reconstructed: ${dg.elements.toLocaleString('en-US')} elements from z = 9 `
                + `(${dg.ics === '2lpt' ? '2LPT' : 'Zel\'dovich'} ICs${dg.growthKappa != null ? ', softening-corrected' : ''}) · today's gravity `
                + `reproduced to ${num(100 * Math.max(...inner), 0)} % inside R_eff (${num(100 * dg.fieldError, 0)} % overall); `
                + `outside it the miss stays within ${num(100 * outer / peak, 1)} % of the void's peak pull out to the rim · `
                + `galaxies land within ${num(1000 * g, 0)} kpc · ${num(dg.seconds, 0)} s.`;
        }
        return 'Reconstruction: not run — the past shown is the shell reconstruction.';
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
                ? `${num(state.tGyr - t0, 2)} Gyr after today — a model forecast, not an observation`
                : dt < 0
                    ? `${num(-dt, 2)} Gyr before the light we see left Boötes`
                    : `${num(dt, 2)} Gyr after it (today is t = ${num(t0, 2)} Gyr)`);
        set('trackGrowth', `× ${num(ep.D, 3)}`);
        set('trackGScale', `× ${num(ep.gravity, 3)}`);
        set('trackVScale', `× ${num(ep.velocity, 3)}`);

        const samples = state.tracked.map(t => t.main.at(ep));
        if (state.tracked.length === 0) set('trackRegime', 'Nothing tracked — add a galaxy.');
        else if (state.mode === 'linear') {
            const outside = samples.filter(s => !s.linearOk).length;
            set('trackRegime', outside === 0
                ? 'Linear mode: every tracked galaxy is in the linear range here (|Δ|, |δ| ≤ 0.5).'
                : `Linear mode: ${outside} of ${state.tracked.length} tracked galaxies sit where |Δ| or |δ| > 0.5 — `
                  + 'past where linear theory is accurate. Switch to nonlinear.');
        } else if (state.mode === 'nbody' && runner.reconReady && ep.a >= runner.reconAInit) {
            set('trackRegime', ep.tGyr < tObs - 1e-9
                ? 'Reconstructed N-body, BEFORE the observed epoch: the same self-gravitating run, started '
                  + 'from initial conditions at z = 9 that evolve into today\'s web.'
                : 'Reconstructed N-body: one self-gravitating run from z = 9, through the observed epoch, '
                  + 'into the forecast.');
        } else if (state.mode === 'nbody') {
            set('trackRegime', ep.tGyr > tObs + 1e-9
                ? (runner.ready
                    ? 'N-body forecast: every particle — the void\'s matter and the web — self-gravitating; '
                      + 'the web\'s pull is fully nonlinear here.'
                    : 'N-body forecast still running — the future shown is the shell tracker\'s until it lands.')
                : 'N-body mode, before the observed epoch: this is the shell reconstruction (the N-body '
                  + 'runs forward only).');
        } else {
            const crossed = samples.filter(s => s.shellCrossed).length;
            set('trackRegime', crossed === 0
                ? 'Nonlinear mode: the spherical part is exact here — no tracked galaxy\'s shell has crossed '
                  + 'its neighbour.'
                : `Nonlinear mode: ${crossed} tracked galaxy shell(s) have CROSSED a neighbour — the wall is `
                  + 'forming there and no spherical model holds past this instant.');
        }
        const a = state.tracked[0];
        if (a && a.linear && state.mode === 'nbody') {
            const nb = a.main.at(ep);
            const sh = a.linear.at(ep);
            const dKpc = 1000 * Math.hypot(...nb.positionMpc.map((c, i) => c - sh.positionMpc[i]));
            set('trackNlGain', nb.nbody
                ? `Galaxy ${a.letter}: the self-gravitating web moves it ${num(dKpc, 0)} kpc from the shell `
                  + `tracker's position; ${num(nb.vKms, 0)} km/s vs ${num(sh.vKms, 0)}; `
                  + `|g| ${num(nb.gA, 2)} vs ${num(sh.gA, 2)} km/s/Gyr (ghost line = shell tracker)`
                : `Galaxy ${a.letter}: shell tracker (the N-body takes over after the observed epoch).`);
        } else if (a && a.linear) {
            const nl = a.main.at(ep);
            const li = a.linear.at(ep);
            set('trackNlGain', `Galaxy ${a.letter}: ${num(nl.vKms, 0)} km/s nonlinear vs ${num(li.vKms, 0)} linear `
                + `(${signed((nl.vKms / li.vKms - 1) * 100, 0)} %); |g| ${num(nl.gA, 2)} vs ${num(li.gA, 2)} km/s/Gyr`);
        } else {
            set('trackNlGain', state.mode === 'linear'
                ? 'Linear mode — the reference the nonlinear tracker is compared against.'
                : '—');
        }
        const b = getBias();
        set('trackBand', state.band && Number.isFinite(b)
            ? `b = ${num(b * (1 - BIAS_BAND), 2)} – ${num(b * (1 + BIAS_BAND), 2)} (±${BIAS_BAND * 100} %)`
            : 'off');
        set('trackNbody', nbodyStatus());
        set('trackRecon', reconStatus());
        const reconAcc = state.mode === 'nbody' && runner.reconReady ? runner.reconAccretionAt(ep.a) : null;
        const acc = reconAcc ?? (state.mode === 'nbody' && ep.tGyr > tObs + 1e-9 ? runner.accretionAt(ep.a) : null);
        set('trackAccretion', acc == null
            ? (state.mode === 'nbody' ? 'after z_obs' : 'N-body only')
            : `${signed((acc - 1) * 100, 1)} % vs z_obs${reconAcc != null ? ' (reconstruction)' : ''}`);
        set('trackFrame', state.frame === 'proper'
            ? `proper distances: everything drawn × a(t)/a_obs = ${num(ep.a * (1 + zObs), 3)} — `
              + 'mostly cosmic expansion, which is NOT the void\'s doing'
            : 'comoving distances: cosmic expansion divided out, only the void\'s own motion shows');

        paintTable(samples);
        paintCharts();
        paintStage(ep, atObs, d);
        card?.setAttribute('data-track-ready', '1');
        card?.setAttribute('data-nbody', state.mode === 'nbody' ? runner.state.status : 'off');
        card?.setAttribute('data-recon', runner.recon.status);
        if (reconBtn) {
            reconBtn.disabled = state.mode !== 'nbody' || runner.recon.status === 'running'
                || !runner.canReconstruct;
            reconBtn.textContent = runner.reconReady ? 'Reconstruct again' : 'Reconstruct the past (~2 min)';
        }
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
            const r0 = t.main.samples[0].rMpc;
            const cells = [
                null,
                `${num(s.rMpc, 1)} (${signed(s.rMpc - r0, 1)})`,
                `${num(s.gA, 2)}`,
                `${num(s.voidShare * 100, 0)} %`,
                `${num(s.vKms, 0)} (${signed(s.vRadialKms, 0)})`,
                signed(s.deltaEnclosed, 2),
                s.shellCrossed ? 'crossed' : s.tweb.name,
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
        const lines = (pick) => state.tracked.map((t, i) => ({
            color: t.color,
            points: t.main.samples.map(s => [s.tGyr, pick(s)]),
            band: t.band ? t.main.samples.flatMap((s, k) => {
                if (state.mode === 'nbody' && s.tGyr > tObs + 1e-9) return [];
                const vals = [pick(s), pick(t.band[0].samples[k]), pick(t.band[1].samples[k])]
                    .filter(Number.isFinite);
                return [[s.tGyr, Math.min(...vals), Math.max(...vals)]];
            }) : null,
            // The reference, ghosted, for the FIRST galaxy only — one comparison
            // line reads; three of them are a thicket. Linear theory under the
            // nonlinear mode; the shell tracker under the N-body mode.
            ghost: i === 0 && t.linear ? t.linear.samples.map(s => [s.tGyr, pick(s)]) : null,
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
        const mode = state.mode === 'nbody' ? 'nonlinear' : state.mode;
        const key = `${keyOf(d)}|${mode}`;
        if (bulk && bulk.key === key) return bulk;
        const tracerPts = d.tracers.map(t => t.offsetMpc);
        const nodePts = d.web.nodes.map(n => n.offsetMpc);
        const opts = { voidProfile: d.profile, web: d.web, zObs, mode, table: shells };
        bulk = {
            key,
            tracers: bulkMotion(tracerPts, opts),
            nodes: bulkMotion(nodePts, opts),
            out: new Float32Array(tracerPts.length * 3),
            moved: bulk?.moved ?? false,
        };
        return bulk;
    }

    function paintStage(ep, atObs, d) {
        if (!scene) return;
        // The field and the web: moved only when asked, and put back EXACTLY
        // at the observed epoch.
        if (state.animate && !atObs) {
            const b = ensureBulk(d);
            // After z_obs in N-body mode, the field and the web are the run's
            // own particles; before it (or until it lands), the shell flow.
            const rec = state.mode === 'nbody' && runner.reconReady && ep.a >= runner.reconAInit;
            const nb = !rec && state.mode === 'nbody' && ep.tGyr > tObs + 1e-9 && runner.ready;
            scene.setTracerOffsetsMpc(rec ? runner.reconTracersAt(ep.a, b.out)
                : nb ? runner.tracerPositionsAt(ep.a, b.out) : b.tracers.positionsAt(ep, b.out));
            const nodePos = rec ? runner.reconNodesAt(ep.a)
                : nb ? runner.nodePositionsAt(ep.a) : b.nodes.positionsAt(ep);
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
        // PROPER vs COMOVING. In proper distances the whole drawn universe is
        // scaled by a(t)/a_obs — at t = 1 Gyr it is ~1/5 the size — so the
        // reader sees how much of the growth is cosmic expansion and how much
        // the void's own. At the observed epoch the factor is exactly 1, so
        // that frame and every observed-epoch readout still agree.
        // Pinned to EXACTLY 1 at z_obs: a(t) comes out of a bisection on the
        // cosmic clock and lands at 0.9999999999999998 there, which would put
        // the observed-epoch picture a hair off every readout drawn against it.
        const worldScale = state.frame === 'proper' && !atObs ? ep.a * (1 + zObs) : 1;
        scene.setWorldScale?.(worldScale);

        const k = cursorIndex(state.tGyr);
        // Follow: translate the camera rig by exactly the tracked galaxy's
        // drawn motion — never an eased chase (the star-collider rule: an
        // eased follow trailed its target and read as the target drifting).
        if (state.follow && state.tracked[0]) {
            const p = state.tracked[0].main.at(ep).positionMpc.map(c => c * worldScale);
            if (followLast) scene.translateRigMpc?.(p.map((c, i) => c - followLast[i]));
            followLast = p;
        } else {
            followLast = null;
        }
        scene.tracks.set(state.tracked.map(t => ({
            color: t.color,
            pathMpc: t.main.samples.map(s => s.positionMpc),
            cursorIndex: k,
            currentMpc: t.main.at(ep).positionMpc,
            startMpc: t.main.lagrangianMpc,
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
            else if (key === 'mode') { state.mode = el.value; ensureRun(); retrackAll(); schedule(); }
            else if (key === 'band') { state.band = el.checked; retrackAll(); schedule(); }
            else if (key === 'frame') { state.frame = el.value; schedule(); }
            else if (key === 'follow') {
                state.follow = el.checked;
                followLast = null;
                if (el.checked && state.tracked[0]) {
                    const p = state.tracked[0].main.at(epochAt(state.tGyr, zObs)).positionMpc;
                    scene?.focusOnMpc(p, { distanceMpc: 40 });
                }
                schedule();
            }
        };
        el.addEventListener('input', handler);
        if (el.type === 'checkbox' || el.tagName === 'SELECT') el.addEventListener('change', handler);
    }
    playBtn?.addEventListener('click', () => setPlaying(!state.playing));
    reconBtn?.addEventListener('click', () => {
        if (state.mode !== 'nbody') return;
        ensureRun();
        if (!runner.reconstruct(state.tracked.map(t => t.xObsMpc))) schedule();
    });
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
            ensureRun();
            retrackAll();
            if (changed) for (const t of state.tracked) t.retracked = true;
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
        get shells() { return shells; },
        get nbody() { return runner; },
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
