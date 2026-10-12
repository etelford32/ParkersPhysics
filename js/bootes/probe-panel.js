/**
 * bootes/probe-panel.js — the force probe's controls and readouts
 * ═══════════════════════════════════════════════════════════════════════════
 * The DOM half of the force probe. It owns the probe's position and toggles,
 * asks js/bootes-force-probe.js for every number, and pushes the result to
 * three places: the readout card (through page.js's `set`, so the
 * `data-bv` contract and its gate cover these keys too), the probe-ray chart,
 * and the stage glyphs (bootes/probe-layer.js).
 *
 * IT COMPUTES NO PHYSICS. Formatting, slider geometry (r/az/el ↔ a position)
 * and "which model node is nearest this point" are the only arithmetic here;
 * the last one is geometry on the web's own node list, not a force.
 *
 * ONE PROBE, MANY INPUTS. The sliders, the jump list, a contributor's "go"
 * button, and Shift-drag / the armed tool on the stage all call `place()`, and
 * `place()` is the only writer of the position. Evaluation is coalesced to one
 * per animation frame, so a drag that fires 120 pointermoves a second costs one
 * ~4 ms evaluation per painted frame (probe 0.2 ms, ray sweep 1.2 ms,
 * streamline 2.2 ms — measured in node).
 *
 * THE PROBE FOLLOWS THE MODEL. `refresh()` is called by page.js after every
 * recompute, so moving the bias or re-rolling the web re-evaluates the probe
 * where it stands: the void rows move with the bias, the web rows move with the
 * seed, and the reader can watch which is which.
 */

import {
    probeAt, radialSweep, traceStreamline, accelerationField,
    toKmsPerGyr, DEFAULT_TWEB_THRESHOLD, TIDAL_ROD_MPC,
} from '../bootes-force-probe.js';
import { drawProbeRay } from './charts.js';

const DEG = 180 / Math.PI;
const num = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const signed = (v, d = 1) => (Number.isFinite(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}` : '—');
const kg = (gSI) => toKmsPerGyr(gSI);
const sci = (v) => (Number.isFinite(v) ? (v === 0 ? '0' : v.toExponential(0)) : '—');

/** r (Mpc), azimuth and elevation (deg) in the STAGE's convention (bootes/camera-math.js). */
export function positionFromSpherical(rMpc, azDeg, elDeg) {
    const az = azDeg / DEG;
    const el = elDeg / DEG;
    return [rMpc * Math.cos(el) * Math.sin(az), rMpc * Math.sin(el), rMpc * Math.cos(el) * Math.cos(az)];
}

export function sphericalFromPosition(p) {
    const r = Math.hypot(p[0], p[1], p[2]);
    if (r < 1e-9) return { r: 0, az: 0, el: 0 };
    let az = Math.atan2(p[0], p[2]) * DEG;
    if (az < 0) az += 360;
    return { r, az, el: Math.asin(Math.max(-1, Math.min(1, p[1] / r))) * DEG };
}

export function createProbePanel({
    root, set, scene, charts, getDerived, rEff, z, anchors = [], losUnit = [0, 0, 1],
}) {
    const card = root.querySelector('#bv-probe-card');
    const toolBtn = root.querySelector('#bv-probe-tool');
    const list = root.querySelector('#bv-probe-contrib');
    const controls = {};
    root.querySelectorAll('[data-bv-probe]').forEach(el => {
        controls[el.getAttribute('data-bv-probe')] = el;
    });

    const state = {
        // Default: just inside the wall, on the sightline towards us — the
        // point a peculiar-velocity survey of Boötes would actually sample.
        positionMpc: losUnit.map(c => c * rEff * 0.8),
        visible: true,
        axes: true,
        stream: true,
        twebThreshold: DEFAULT_TWEB_THRESHOLD,
    };
    let last = null;
    let frameRequested = false;
    let sweepKey = '';
    let sweep = null;

    // ── Jump list ───────────────────────────────────────────────────────────
    const jumps = {
        centre: () => [0, 0, 0],
        'los-in': () => losUnit.map(c => c * rEff * 0.5),
        'los-wall': () => losUnit.map(c => c * rEff),
        'los-out': () => losUnit.map(c => c * rEff * 1.8),
        'los-far': () => losUnit.map(c => -c * rEff),
    };
    for (const a of anchors) jumps[`anchor:${a.id}`] = () => [...a.offsetMpc];
    const jumpSelect = controls.jump;
    if (jumpSelect && anchors.length) {
        const group = document.createElement('optgroup');
        group.label = 'Catalogued clusters (measured positions)';
        for (const a of anchors) {
            const o = document.createElement('option');
            o.value = `anchor:${a.id}`;
            o.textContent = `${a.name} — ${Math.round(a.radiusMpc)} Mpc out`;
            group.appendChild(o);
        }
        jumpSelect.appendChild(group);
    }

    // ── Evaluation ──────────────────────────────────────────────────────────
    function evaluate() {
        frameRequested = false;
        const derived = getDerived();
        if (!derived) return;
        const { profile, web } = derived;
        const p = state.positionMpc;
        last = probeAt(p, {
            voidProfile: profile, web, z, anchors, topN: 6, twebThreshold: state.twebThreshold,
        });

        // The ray sweep only depends on the DIRECTION and the model; skip it
        // when a drag moved the probe along its own ray.
        const dir = last.radialUnit ?? losUnit;
        const key = `${derived.web.seed}|${derived.web.clumpiness}|${profile.params.deltaC}|`
            + dir.map(c => c.toFixed(3)).join(',');
        if (key !== sweepKey) {
            sweep = radialSweep(dir, { voidProfile: profile, web, z, rMaxMpc: rEff * 2.6, samples: 90 });
            sweepKey = key;
        }

        let streamline = null;
        if (state.stream) {
            streamline = traceStreamline(p, accelerationField({ voidProfile: profile, web, z }), {
                stepMpc: 3, maxSteps: 160, rMaxMpc: Math.max(rEff * 2.8, Math.hypot(...p) * 1.1),
            });
        }
        last.streamline = streamline;
        paint(derived);
    }

    function schedule() {
        if (frameRequested) return;
        frameRequested = true;
        (globalThis.requestAnimationFrame ?? ((fn) => setTimeout(fn, 16)))(evaluate);
    }

    // ── Painting ────────────────────────────────────────────────────────────
    // [|g|, radial, tangential] in km/s per Gyr, formatted. The keys are
    // written out LITERALLY below rather than built from a prefix, because
    // tests/bootes-void-page.mjs finds them by matching set('…') in the source
    // and a computed key is invisible to it.
    const row = (term) => [num(kg(term.magnitude), 2), signed(kg(term.radial), 2), num(kg(term.tangential), 2)];

    function nearestNode(web, q) {
        let best = null;
        let bestD = Infinity;
        for (const n of web.nodes) {
            const d = Math.hypot(n.offsetMpc[0] - q[0], n.offsetMpc[1] - q[1], n.offsetMpc[2] - q[2]);
            if (d < bestD) { bestD = d; best = n; }
        }
        return best ? { node: best, distanceMpc: bestD } : null;
    }

    const pathLength = (pts) => {
        let s = 0;
        for (let i = 1; i < pts.length; i++) {
            s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
        }
        return s;
    };

    function describeStream(web, leg, word) {
        const len = pathLength(leg.points);
        const end = leg.points[leg.points.length - 1];
        const rEnd = Math.hypot(...end);
        if (leg.reason === 'sink') {
            const nn = nearestNode(web, end);
            const where = nn && nn.distanceMpc < 3 * web.softeningMpc
                ? `on model node #${nn.node.index}${nn.node.anchorId ? ` (placed toward ${anchorName(nn.node.anchorId)})` : ''}`
                : (rEnd < 0.15 * rEff ? 'at the void centre' : `${num(rEnd, 0)} Mpc from the centre`);
            return `${word} converges after ${num(len, 0)} Mpc, ${where}`;
        }
        if (leg.reason === 'range') return `${word} leaves the modelled region after ${num(len, 0)} Mpc`;
        if (leg.reason === 'weak') return `${word} stalls after ${num(len, 0)} Mpc where the field vanishes`;
        return `${word} runs ${num(len, 0)} Mpc without settling`;
    }

    const anchorName = (id) => anchors.find(a => a.id === id)?.name ?? id;

    function paint(derived) {
        const pr = last;
        const { r, az, el } = sphericalFromPosition(pr.positionMpc);
        set('probePos', `r = ${num(r, 0)} Mpc (${num(r / rEff, 2)} R_eff) · az ${num(az, 0)}° · el ${signed(el, 0)}°`);
        set('probeDelta', `${signed(pr.deltaLocal, 3)}`);

        const gv = row(pr.forces.void);
        set('probeGVoid', gv[0]); set('probeGVoidR', gv[1]); set('probeGVoidT', gv[2]);
        const gs = row(pr.forces.wall);
        set('probeGWall', gs[0]); set('probeGWallR', gs[1]); set('probeGWallT', gs[2]);
        const gw = row(pr.forces.web);
        set('probeGWeb', gw[0]); set('probeGWebR', gw[1]); set('probeGWebT', gw[2]);
        const ga = row(pr.forces.A);
        set('probeGA', ga[0]); set('probeGAR', ga[1]); set('probeGAT', ga[2]);
        const gc = row(pr.forces.clumping);
        set('probeGClump', gc[0]); set('probeGClumpR', gc[1]); set('probeGClumpT', gc[2]);
        set('probeVoidShare', `${num(pr.voidShare * 100, 0)} %`);

        set('probeVel', `${num(pr.velocity.A.magnitude, 0)} km/s`);
        set('probeVelRadial', `${signed(pr.velocity.A.radial, 0)} km/s radial · `
            + `${num(pr.velocity.void.magnitude, 0)} km/s from the void alone`);
        set('probePhi', `${signed(pr.potential.A / 1e6, 2)} × 10⁶ km²/s²`);
        set('probePhiVoid', `${signed(pr.potential.void / 1e6, 2)} × 10⁶ km²/s²`);

        const axisText = (ax) => `${signed(ax.lambda, 3)} · ${ax.sense} · `
            + `${signed(ax.rodKmsPerGyr, 2)} km/s/Gyr across ${TIDAL_ROD_MPC} Mpc`
            + (ax.radialCos == null ? '' : ` · ${num(ax.radialCos * 100, 0)} % radial`);
        set('probeL1', axisText(pr.tidal.axes[0]));
        set('probeL2', axisText(pr.tidal.axes[1]));
        set('probeL3', axisText(pr.tidal.axes[2]));
        set('probeTweb', `${pr.tidal.tweb.name} (${pr.tidal.tweb.count} of 3 axes collapsing)`);
        set('probeTwebSmooth', pr.tidal.twebSmooth.name);
        set('probeTwebTh', num(state.twebThreshold, 2));
        set('probeSoftening', `${num(pr.softeningMpc, 1)} Mpc`);

        const s = pr.streamline;
        set('probeStream', s
            ? `${describeStream(derived.web, s.forward, 'Downstream, the flow')}. `
              + `${describeStream(derived.web, s.backward, 'Upstream, it')}.`
            : 'Streamline off.');

        set('probeCheck', `Σ structures − web ${sci(pr.checks.contributors)} · `
            + `Σ shares − 1 ${sci(pr.checks.shares)} · tr T − δ ${sci(pr.checks.trace)}`);
        set('probeHud', `|g| ${num(kg(pr.forces.A.magnitude), 1)} km/s/Gyr · T-web ${pr.tidal.tweb.name}`);

        paintContributors(pr);
        paintChart();
        syncSliders();

        scene?.probe.set({
            positionMpc: pr.positionMpc,
            forces: { void: pr.forces.void.vector, web: pr.forces.web.vector, A: pr.forces.A.vector },
            axes: state.axes ? pr.tidal.axes : null,
            streamline: s,
        });
        scene?.probe.setEnabled(state.visible);
        card?.setAttribute('data-probe-ready', '1');
    }

    function paintContributors(pr) {
        if (!list) return;
        list.replaceChildren();
        for (const c of pr.contributors.top) {
            const li = document.createElement('li');
            const label = document.createElement('span');
            const name = c.kind === 'node'
                ? `Model node #${c.index}${c.anchorName ? ` — placed toward ${c.anchorName}` : ''}`
                : c.kind === 'filament' ? `Model filament #${c.a}–#${c.b}` : 'Other';
            label.textContent = name;
            const meta = document.createElement('em');
            meta.textContent = `${num(kg(c.magnitude), 2)} km/s/Gyr · ${num(c.share * 100, 0)} % of the web's pull`
                + ` · ${num(c.distanceMpc, 0)} Mpc away`;
            const go = document.createElement('button');
            go.type = 'button';
            go.className = 'bv-probe-go';
            go.textContent = 'go';
            go.title = 'Move the probe to this structure';
            go.addEventListener('click', () => place(c.positionMpc));
            li.append(label, meta, go);
            list.appendChild(li);
        }
    }

    function paintChart() {
        const c = (key) => charts.get(key);
        if (c('probeRay') && sweep && last) {
            drawProbeRay(c('probeRay'), { sweep, rEff, probeR: last.rMpc });
        }
    }

    function syncSliders() {
        const { r, az, el } = sphericalFromPosition(state.positionMpc);
        const put = (key, v) => {
            const el2 = controls[key];
            if (el2 && document.activeElement !== el2) el2.value = String(v);
        };
        put('r', (r / rEff).toFixed(2));
        if (r > 1e-6) { put('az', Math.round(az)); put('el', Math.round(el)); }
        set('probeRVal', `${num(r / rEff, 2)} R_eff`);
        set('probeAzVal', `${num(az, 0)}°`);
        set('probeElVal', `${signed(el, 0)}°`);
    }

    // ── Inputs ──────────────────────────────────────────────────────────────
    function place(positionMpc) {
        const r = Math.hypot(...positionMpc);
        // Keep the probe inside the modelled region: 2.6 R_eff (the reach of
        // every chart on the page) or just past the farthest model node,
        // whichever is larger — the wall's r⁻³ tail places a few nodes beyond
        // 2.6 R_eff, and clamping at the chart edge silently stopped a "go"
        // short of the structure it named (caught by the browser gate).
        const nodes = getDerived()?.web?.nodes ?? [];
        const rMax = Math.max(rEff * 2.6, ...nodes.map(n => n.radiusMpc * 1.05));
        state.positionMpc = r > rMax ? positionMpc.map(c => c * rMax / r) : [...positionMpc];
        schedule();
    }

    function fromSliders() {
        const rr = Number(controls.r?.value ?? 0.8) * rEff;
        const az = Number(controls.az?.value ?? 0);
        const el = Number(controls.el?.value ?? 0);
        place(positionFromSpherical(rr, az, el));
    }

    for (const [key, el] of Object.entries(controls)) {
        const handler = () => {
            if (key === 'r' || key === 'az' || key === 'el') fromSliders();
            else if (key === 'tweb') { state.twebThreshold = Number(el.value); schedule(); }
            else if (key === 'visible') {
                state.visible = el.checked;
                scene?.probe.setEnabled(el.checked);
                if (!el.checked) setArmed(false);
            } else if (key === 'axes') { state.axes = el.checked; schedule(); }
            else if (key === 'stream') { state.stream = el.checked; schedule(); }
            else if (key === 'jump') {
                const fn = jumps[el.value];
                if (fn) place(fn());
                el.value = '';
            }
        };
        el.addEventListener('input', handler);
        if (el.tagName === 'SELECT' || el.type === 'checkbox') el.addEventListener('change', handler);
    }

    function setArmed(on) {
        scene?.probe.setArmed(on);
        toolBtn?.setAttribute('aria-pressed', String(!!on));
    }
    toolBtn?.addEventListener('click', () => {
        const on = !(scene?.probe.armed);
        if (on && !state.visible) {
            state.visible = true;
            if (controls.visible) controls.visible.checked = true;
            scene?.probe.setEnabled(true);
        }
        setArmed(on);
    });
    if (!scene && toolBtn) toolBtn.hidden = true;

    scene?.probe.onPlace((mpc, { phase }) => {
        if (mpc) place(mpc);
        card?.setAttribute('data-probe-dragging', phase === 'end' ? '0' : '1');
    });

    return {
        refresh() { sweepKey = ''; schedule(); },
        /** Synchronous evaluation — for tests and for the first paint. */
        evaluateNow() { evaluate(); return last; },
        place,
        paintChart,
        setArmed,
        get state() { return { ...state, positionMpc: [...state.positionMpc] }; },
        get last() { return last; },
    };
}
