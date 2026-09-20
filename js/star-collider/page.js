/**
 * star-collider/page.js — state, controls and wiring for star-collider.html
 * ═══════════════════════════════════════════════════════════════════════════
 * The only module on the page that touches the DOM and the only one that owns
 * mutable state. It computes nothing itself: stars come from tov.js, orbits
 * and waves from inspiral.js, aftermaths from remnant.js, real objects from
 * catalog.js, the hydrodynamics from the WASM kernel behind sph-worker.js,
 * and pixels from scene.js / charts.js.
 *
 * TWO ENGINES, ONE PAIR. Every change to the pair (objects, EOS, masses,
 * separation, spins, distance) runs `recompute()` — the ANALYTIC engine:
 * TOV structure → PN inspiral → fate/ejecta/kilonova — and pushes every
 * readout and chart from one derived state; the stage previews the pair
 * live from the same numbers. The SPH engine is built from the same pair,
 * in the same units, and its diagnostics stream into the HUD + the
 * waveform/energy charts. The two are never mixed in one number: the
 * aftermath panel is the calibrated fits, the HUD is the simulation, and
 * the "SPH vs fit" row prints both.
 *
 * EVERY CONTROL IS ONE OF TWO KINDS, AND THE CONSOLE SAYS WHICH. LIVE
 * controls (viscosity, Γ_th, the PN terms) go to the worker as parameter
 * EVENTS on the run's chunk clock the moment they change — the stage
 * answers on the next chunk, and a rewind through the change replays it.
 * STRUCTURAL controls (objects, masses, radii, spins, EOS, separation,
 * eccentricity, tidal lock, resolution, seed) define the build; while a run
 * exists and "apply changes live" is on, a structural change rebuilds the
 * run from t = 0 after a short debounce — the preview moves at once, the
 * particles a moment later. The distance to Earth is neither: it scales
 * the strain readouts and nothing in the kernel.
 *
 * THE CLOCK IS THE WORKER'S (sph-worker.js header): a chunk index with a
 * checkpoint timeline. This module only drives it — transport buttons,
 * the scrubber, keys — and displays it: the cursor chunk vs the head,
 * sim time in ms, whether the shown frame is a bit-exact replay or a
 * recorded frame, and the timeline's resolution. The GW and energy series
 * are the HEAD's history and only grow from live head frames; a review
 * draws a cursor over them, and a branch truncates them at the branch
 * time. Trails are cleared whenever the shown time goes backwards.
 *
 * THE DOM CONTRACT is `data-sc="<key>"` for a readout, `data-sc-control`
 * for an input, `data-sc-chart` for a canvas. Keys are looked up once at
 * init; a key present in the markup but never written, or written but
 * absent, is caught by tests/star-collider-page.mjs, which parses the HTML
 * and diffs the two sets (the Boötes page's gate, reused).
 *
 * UNITS. Everything handed to the kernel is GEOMETRIC (M☉, G M☉/c², so
 * c = 1): masses as they are, radii ÷ GEOM_KM, time × GEOM_S back to
 * seconds, densities × RHO_GEOM to g/cm³. `toCode`/`fromCode` are the only
 * two conversions and they live here.
 */

import { createEos, EOS_IDS, EOS_TABLE, GEOM_KM, GEOM_S, RHO_GEOM, DEFAULT_EOS } from './eos.js';
import { thresholdMass } from './tov.js';
import {
    inspiral, chirpMass, combinedTidal, effectiveSpin, gwFrequencyAtSeparationHz, mergerTimePeters,
    semiMajorAxisKm, formatDuration, MPC_GEOM,
} from './inspiral.js';
import {
    bbhRemnant, bnsOutcome, nsbhOutcome, wdOutcome, kilonova, magneticInteraction, classifyPair,
} from './remnant.js';
import { OBJECTS, PAIRS, objectById, pairById, resolveProfile, eosSequence, KIND_LABEL } from './catalog.js';
import { drawMassRadius, drawWaveform, drawFrequencyTrack, drawKilonova, drawEnergy } from './charts.js';

const PARTICLE_CHOICES = [150, 300, 600, 1000, 1500, 2500];
const WARP_CHOICES = [
    { id: 'max', label: 'as fast as possible', warp: 1e12 },
    { id: 'rt2000', label: '1 ms of merger / 2 s', warp: 1e-3 / GEOM_S / 2 },
    { id: 'rt10000', label: '1 ms of merger / 10 s', warp: 1e-3 / GEOM_S / 10 },
    { id: 'rt50000', label: '1 ms of merger / 50 s', warp: 1e-3 / GEOM_S / 50 },
];
const DEFAULT_DISTANCE_MPC = 40;
const DEFAULT_SEED = 7;
const REBUILD_MS = 650;      // debounce for structural changes while a run exists
const CHUNK_STEPS = 4;       // one clock chunk = CHUNK_STEPS × dt_max of sim time
const SCRUB_THROTTLE_MS = 50;

const fmt = {
    num: (v, d = 2) => Number.isFinite(v) ? (+v).toFixed(d) : '—',
    sci: (v, d = 2) => Number.isFinite(v) && v !== 0 ? v.toExponential(d) : (v === 0 ? '0' : '—'),
    sig: (v, d = 3) => Number.isFinite(v) ? (+v).toPrecision(d) : '—',
    km: (v) => Number.isFinite(v) ? (v >= 1e4 ? `${(v / 1e3).toPrecision(3)} × 10³ km` : `${v.toFixed(v < 100 ? 2 : 0)} km`) : '—',
    msun: (v, d = 3) => Number.isFinite(v) ? `${(+v).toFixed(d)} M☉` : '—',
    pct: (v) => Number.isFinite(v) ? `${(100 * v).toFixed(1)} %` : '—',
    hz: (v) => Number.isFinite(v) ? (v >= 1000 ? `${(v / 1000).toPrecision(3)} kHz` : v >= 1 ? `${v.toPrecision(3)} Hz` : `${(v * 1000).toPrecision(3)} mHz`) : '—',
    ms: (tCode) => Number.isFinite(tCode) ? `${(tCode * GEOM_S * 1e3).toFixed(3)} ms` : '—',
    bytes: (b) => b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`,
};

export function initStarColliderPage(doc = document) {
    const $ = (sel) => doc.querySelector(sel);
    const readouts = new Map();
    for (const el of doc.querySelectorAll('[data-sc]')) readouts.set(el.getAttribute('data-sc'), el);
    const controls = new Map();
    for (const el of doc.querySelectorAll('[data-sc-control]')) controls.set(el.getAttribute('data-sc-control'), el);
    const charts = new Map();
    for (const el of doc.querySelectorAll('[data-sc-chart]')) charts.set(el.getAttribute('data-sc-chart'), el);
    const set = (key, value) => { const el = readouts.get(key); if (el && el.textContent !== value) el.textContent = value; };
    const ctl = (key) => controls.get(key);
    const val = (key) => { const el = ctl(key); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
    const num = (key, fallback = 0) => { const v = parseFloat(val(key)); return Number.isFinite(v) ? v : fallback; };
    const enable = (key, on) => { const el = ctl(key); if (el) el.disabled = !on; };

    // ── State ───────────────────────────────────────────────────────────────
    const state = {
        eos: DEFAULT_EOS,
        bodies: [
            { source: 'gw170817a', custom: null },
            { source: 'gw170817b', custom: null },
        ],
        pair: 'gw170817',
        separationKm: null,      // null → default from radii
        eccentricity: 0,
        distanceMpc: DEFAULT_DISTANCE_MPC,
        chiOverride: [null, null],
        profiles: [null, null],
        derived: null,
        sim: {
            // status: idle | building | ready | error. Everything finer (running / paused / review /
            // replay) is the worker's clock.mode, mirrored in `clock`.
            status: 'idle', engine: 'loading', n: 0, frames: 0, diag: null, bodies: null, gw: [], energy: [],
            codePerKm: 1 / GEOM_KM, e0: null, merged: false, builtAt: 0, perf: null, frame: null, frameStride: 6,
            clock: null, lastFrameTime: -1, seed: DEFAULT_SEED, dtMax: 1, chunkDt: CHUNK_STEPS, autoRun: true,
            previewExtent: 0, previewFramed: false, note: '', noteAt: 0,
        },
    };

    // ── Populate selects ────────────────────────────────────────────────────
    const fillSelect = (el, items, selected) => {
        if (!el) return;
        el.innerHTML = '';
        for (const it of items) {
            const o = doc.createElement('option');
            o.value = it.value; o.textContent = it.label;
            if (it.value === selected) o.selected = true;
            el.appendChild(o);
        }
    };
    const objectItems = [{ value: 'custom', label: 'Custom object' }]
        .concat(OBJECTS.map(o => ({ value: o.id, label: `${o.name} · ${KIND_LABEL[o.kind]} · ${o.mass.value} M☉` })));
    fillSelect(ctl('bodyA'), objectItems, state.bodies[0].source);
    fillSelect(ctl('bodyB'), objectItems, state.bodies[1].source);
    fillSelect(ctl('eos'), EOS_IDS.map(id => ({ value: id, label: `${id} — M_max ${EOS_TABLE[id].mmax} M☉, R₁.₄ ${EOS_TABLE[id].r14} km` })), state.eos);
    fillSelect(ctl('pair'), [{ value: '', label: 'Pick a real pair…' }].concat(PAIRS.map(p => ({ value: p.id, label: p.name }))), state.pair);
    fillSelect(ctl('particles'), PARTICLE_CHOICES.map(n => ({ value: String(n), label: `${n} per star` })), '600');
    fillSelect(ctl('warp'), WARP_CHOICES.map(w => ({ value: w.id, label: w.label })), 'max');
    if (ctl('seed') && !val('seed')) ctl('seed').value = String(DEFAULT_SEED);

    // ── Body resolution ─────────────────────────────────────────────────────
    function bodySpec(i) {
        const b = state.bodies[i];
        if (b.source === 'custom' && b.custom) return b.custom;
        const o = objectById(b.source);
        if (!o) return { kind: 'ns', mass: 1.4, name: 'Custom' };
        return b.custom ? { ...o, ...b.custom } : o;
    }
    function resolveBodies() {
        for (let i = 0; i < 2; i++) {
            const spec = bodySpec(i);
            const p = resolveProfile(spec, state.eos);
            if (state.chiOverride[i] !== null && Number.isFinite(state.chiOverride[i])) { p.chi = state.chiOverride[i]; p.chiSource = 'set in console'; }
            state.profiles[i] = p;
        }
    }

    function defaultSeparationKm(A, B) {
        const rs = A.radiusKm + B.radiusKm;
        if (A.kind === 'bh' && B.kind === 'bh') return 10 * (A.M + B.M) * GEOM_KM;
        return 1.9 * rs;
    }

    // ── The analytic engine ─────────────────────────────────────────────────
    function recompute() {
        resolveBodies();
        const [A, B] = state.profiles;
        const sepKm = state.separationKm ?? defaultSeparationKm(A, B);
        state.separationKm = sepKm;
        const cls = classifyPair(A.kind, B.kind);
        const M = A.M + B.M;
        const fStart = gwFrequencyAtSeparationHz(sepKm, M);
        const insp = inspiral({
            m1: A.M, m2: B.M, lambda1: A.kind === 'bh' ? 0 : Math.min(A.Lambda, 1e5), lambda2: B.kind === 'bh' ? 0 : Math.min(B.Lambda, 1e5),
            chi1: A.chi, chi2: B.chi, r1Km: A.kind === 'bh' ? 0 : A.radiusKm, r2Km: B.kind === 'bh' ? 0 : B.radiusKm,
            fStartHz: Math.max(fStart, 1e-4), distanceMpc: state.distanceMpc, tailSeconds: cls === 'bbh' ? 0.25 * (M / 65) : 0.02,
        });
        // Aftermath
        let outcome = null, kn = null, magnetic = null, bbh = null;
        const eos = createEos(state.eos);
        const seq = eosSequence(state.eos);
        const mth = thresholdMass(seq.mmax);
        if (cls === 'bbh') {
            bbh = bbhRemnant(A.M, B.M, A.chi, B.chi);
            outcome = { ...bbh, ejecta: { dynamical: 0, disk: 0, wind: 0, total: 0 } };
        } else if (cls === 'bns') {
            outcome = bnsOutcome(A.star, B.star, seq.mmax, mth);
        } else if (cls === 'nsbh') {
            const bh = A.kind === 'bh' ? A : B, ns = A.kind === 'bh' ? B : A;
            outcome = nsbhOutcome(bh.M, bh.chi, ns.star);
        } else {
            const wd = A.kind === 'wd' ? A : B, comp = A.kind === 'wd' ? B : A;
            outcome = wdOutcome({ M: wd.M, R: wd.radiusKm }, { M: comp.M, kind: comp.kind, chi: comp.chi, R: comp.radiusKm });
        }
        kn = kilonova(outcome.ejecta, state.distanceMpc);
        const mag = [A, B].find(p => p.kind === 'ns' && p.bFieldG);
        if (mag) {
            const other = mag === A ? B : A;
            magnetic = magneticInteraction({ B: mag.bFieldG, rKm: mag.radiusKm, periodS: mag.spinPeriodS || 0, M: mag.M, mComp: other.M,
                B2: other.kind === 'ns' ? (other.bFieldG || 0) : 0, r2Km: other.radiusKm, aKm: A.radiusKm + B.radiusKm });
        }
        // Real orbit (catalog pair) merger time
        const pair = pairById(state.pair);
        let realOrbit = null;
        if (pair && pair.orbit && pair.a === state.bodies[0].source && pair.b === state.bodies[1].source) {
            const aKm = semiMajorAxisKm(pair.orbit.periodS, M);
            realOrbit = { aKm, e: pair.orbit.e, tS: mergerTimePeters({ m1: A.M, m2: B.M, aKm, e: pair.orbit.e }), published: pair.orbit.mergerMyr };
        }
        state.derived = { cls, M, sepKm, fStart, insp, outcome, kn, magnetic, realOrbit, eos, seq, mth, bbh, pair };
        render();
    }

    // ── Rendering the analytic state ────────────────────────────────────────
    function render() {
        const d = state.derived; if (!d) return;
        const [A, B] = state.profiles;
        const { insp, outcome, kn } = d;
        const clsLabel = { bbh: 'Binary black hole', bns: 'Binary neutron star', nsbh: 'Neutron star – black hole', wdbh: 'White dwarf – black hole', wdns: 'White dwarf – neutron star', wdwd: 'Double white dwarf' }[d.cls] || d.cls;
        set('pairClass', clsLabel);
        set('chirpMass', fmt.msun(insp.chirpMass));
        set('massRatio', fmt.num(Math.min(A.M, B.M) / Math.max(A.M, B.M), 3));
        set('totalMass', fmt.msun(d.M));
        set('lambdaTilde', d.cls === 'bbh' ? '0 (black holes)' : (insp.lambdaTilde > 1e5 ? fmt.sci(insp.lambdaTilde, 1) : fmt.num(insp.lambdaTilde, 0)));
        set('chiEff', fmt.num(effectiveSpin(A.M, B.M, A.chi, B.chi), 3));
        set('fStart', fmt.hz(d.fStart));
        set('separationOut', fmt.km(d.sepKm));
        if (insp.valid) {
            set('fEnd', fmt.hz(insp.fEndHz));
            set('endReason', { contact: 'contact (1PN separation = R₁ + R₂)', isco: 'Schwarzschild ISCO (x = 1/6)', series: 'PN series broke down', steps: 'step guard' }[insp.endReason] || insp.endReason);
            set('timeToMerger', formatDuration(insp.timeToMergerS));
            set('gwCycles', fmt.num(insp.gwCycles, 1));
            set('strainPeak', fmt.sci(insp.strainAtEnd, 2));
        } else {
            set('fEnd', '—'); set('endReason', insp.reason || 'invalid'); set('timeToMerger', '—'); set('gwCycles', '—'); set('strainPeak', '—');
        }
        set('distanceOut', `${fmt.sig(state.distanceMpc, 3)} Mpc`);
        set('realOrbit', d.realOrbit
            ? `a = ${fmt.km(d.realOrbit.aKm)}, e = ${d.realOrbit.e}: merges in ${formatDuration(d.realOrbit.tS)} (published ~${d.realOrbit.published} Myr)`
            : 'not a catalogued orbit — the collider starts at the separation you set');
        // Bodies
        for (const [p, s] of [[A, 'A'], [B, 'B']]) {
            set(`name${s}`, p.name);
            set(`kind${s}Out`, KIND_LABEL[p.kind] + (p.massSource === 'assumed' ? ' · mass assumed' : ''));
            set(`mass${s}Out`, fmt.msun(p.M));
            set(`radius${s}Out`, `${fmt.km(p.radiusKm)} (${{ measured: 'measured', eos: `from ${state.eos}`, horizon: 'event horizon r₊', custom: 'custom', scaled: 'M^{-1/3} scaling' }[p.radiusSource] || p.radiusSource})`);
            set(`compact${s}`, p.kind === 'bh' ? '0.5 (horizon)' : fmt.num(p.compactness, 4));
            set(`lambda${s}`, p.kind === 'bh' ? '0' : (p.Lambda > 1e5 ? fmt.sci(p.Lambda, 2) : fmt.num(p.Lambda, 0)));
            set(`k2${s}`, p.kind === 'bh' ? '0' : fmt.num(p.k2, 4));
            set(`chi${s}Out`, `${fmt.num(p.chi, 3)} (${p.chiSource})`);
            set(`extra${s}`, p.kind === 'bh' ? `ISCO ${fmt.km(p.iscoKm)} · horizon ${fmt.km(p.horizonKm)}`
                : p.kind === 'wd' ? `Newtonian polytrope n = 1.5`
                : `ρ_c ${fmt.sci(p.rhoCcgs, 2)} g/cm³ · M_b ${fmt.msun(p.Mb)} · I ${fmt.sci(p.I_cgs, 2)} g cm²${p.bFieldG ? ` · B ${fmt.sci(p.bFieldG, 1)} G` : ''}`);
            set(`note${s}`, p.eosSupported
                ? (p.notes[0] || (p.kind === 'ns' ? `No independent radius measurement — R, Λ and k₂ are ${state.eos}'s prediction at this mass.` : p.kind === 'bh' ? 'A black hole has no structure to model: χ, the horizon and the ISCO are the whole description.' : 'Newtonian white dwarf; the measured radius is used directly.'))
                : p.notes.join(' '));
            const noteEl = readouts.get(`note${s}`);
            if (noteEl) noteEl.classList.toggle('sc-warn', !p.eosSupported);
        }
        // Aftermath
        set('fate', outcome.fate + (outcome.marginal ? ' (marginal)' : ''));
        set('fateDetail', outcome.detail || (outcome.notes ? outcome.notes[0] : ''));
        if (d.cls === 'bbh') {
            set('remnant', `${fmt.msun(outcome.finalMass)}, χ_f = ${fmt.num(outcome.finalSpin, 3)} — ${fmt.msun(outcome.radiatedMass)} radiated (${fmt.pct(outcome.radiatedFraction)}, ${fmt.sci(outcome.radiatedErg, 1)} erg)`);
        } else if (d.cls === 'bns') {
            set('remnant', `${outcome.lifetime} · M_th = ${fmt.msun(outcome.thresholdMass, 2)} · M_max(${state.eos}) = ${fmt.msun(outcome.maxMass, 2)}`);
        } else if (d.cls === 'nsbh') {
            set('remnant', `${fmt.msun(outcome.remnantBaryonMass)} of baryons outside the horizon · final BH ${fmt.msun(outcome.finalMass)} · ISCO ${fmt.km(outcome.rIscoKm)} vs tidal radius ${fmt.km(outcome.rTidalKm)}`);
        } else {
            set('remnant', `Roche-lobe overflow at ${fmt.km(outcome.aRlofKm)} vs ${outcome.innerLabel} ${fmt.km(outcome.innerKm)} · f_GW there ${fmt.hz(outcome.fGwRlofHz)}`);
        }
        const ej = outcome.ejecta;
        set('ejectaDyn', ej.dynamical > 0 ? fmt.msun(ej.dynamical, 4) : '0');
        set('ejectaDisk', ej.disk > 0 ? fmt.msun(ej.disk, 4) : '0');
        set('ejectaWind', ej.wind > 0 ? fmt.msun(ej.wind, 4) : '0');
        if (kn.visible) {
            set('knPeak', `${fmt.sci(kn.peakL, 2)} erg/s at ${fmt.num(kn.tPeakDays, 1)} d`);
            set('knMag', `M_bol ${fmt.num(kn.peakAbsoluteMag, 1)} → m_bol ${fmt.num(kn.peakApparentMag, 1)} at ${fmt.sig(state.distanceMpc, 3)} Mpc`);
            set('knColour', `blue peak ${fmt.num(kn.blue.tPeakDays, 1)} d at ${fmt.num(kn.blue.tempAtPeak, 0)} K · red peak ${fmt.num(kn.red.tPeakDays, 1)} d at ${fmt.num(kn.red.tempAtPeak, 0)} K`);
        } else {
            set('knPeak', 'none — nothing was ejected'); set('knMag', '—'); set('knColour', '—');
        }
        set('magnetic', d.magnetic
            ? `spin-down ${fmt.sci(d.magnetic.spinDownErgS, 1)} erg/s · E_B ${fmt.sci(d.magnetic.magneticEnergyErg, 1)} erg · dipole–dipole / orbital binding at contact = ${fmt.sci(d.magnetic.magneticToGravity, 1)} · field at companion ${fmt.sci(d.magnetic.fieldAtCompanionG, 1)} G`
            : 'no magnetised neutron star in this pair');
        set('sphVsFit', sphVsFitText());
        drawCharts();
        renderCatalog();
        renderPreview();
        syncControlsFromState();
    }

    function sphVsFitText() {
        const d = state.derived, s = state.sim;
        if (!d) return '—';
        const fitEj = d.outcome.ejecta.total;
        if (!s.diag) return `fit: ${fmt.msun(fitEj, 4)} ejected · SPH: not run yet`;
        const unb = s.diag.mUnbound;
        const acc = s.diag.accretedA + s.diag.accretedB;
        return `fit: ${fmt.msun(fitEj, 4)} ejected · SPH so far: ${fmt.msun(unb, 4)} unbound${acc > 0 ? `, ${fmt.msun(acc, 4)} accreted by the black hole` : ''} (${s.n} particles, ${fmt.msun(s.n ? (d.M / s.n) : NaN, 4)} each — the resolution floor)`;
    }

    // ── Charts ──────────────────────────────────────────────────────────────
    /** The review position in code units, or null when the shown frame is the head. */
    function cursorTimeCode() {
        const c = state.sim.clock;
        if (!c || c.chunk >= c.head) return null;
        return c.time;
    }
    function drawCharts() {
        const d = state.derived; if (!d) return;
        const [A, B] = state.profiles;
        const mr = charts.get('massRadius');
        if (mr) {
            const curves = EOS_IDS.map(id => ({ id, active: id === state.eos, points: eosSequence(id).points.map(p => ({ rKm: p.rKm, M: p.M, stable: p.stable })) }));
            const objects = OBJECTS.filter(o => o.kind === 'ns' && o.radiusKm).map(o => ({ name: o.name.replace('PSR ', ''), rKm: o.radiusKm.value, M: o.mass.value, plus: o.radiusKm.plus, minus: o.radiusKm.minus, sigma: o.mass.sigma }));
            drawMassRadius(mr, { curves, objects, bodies: [{ name: 'A', rKm: A.radiusKm, M: A.M, kind: A.kind }, { name: 'B', rKm: B.radiusKm, M: B.M, kind: B.kind }], bands: { mmaxObserved: 2.08 } });
        }
        drawWaveformChart();
        const ft = charts.get('frequency');
        if (ft && d.insp.valid) drawFrequencyTrack(ft, { track: d.insp.track, timeToMergerS: d.insp.timeToMergerS, fEndHz: d.insp.fEndHz, endReason: d.insp.endReason });
        const kc = charts.get('kilonova');
        if (kc) drawKilonova(kc, d.kn, d.cls === 'bbh' ? 'black holes eject nothing' : '');
        drawEnergyChart();
    }
    function drawEnergyChart() {
        const ec = charts.get('energy');
        if (ec) drawEnergy(ec, state.sim.energy, cursorTimeCode());
    }
    function drawWaveformChart() {
        const wf = charts.get('waveform'); const d = state.derived;
        if (!wf || !d) return;
        const s = state.sim;
        if (s.gw.length > 50) {
            const D = state.distanceMpc * MPC_GEOM;
            const sph = s.gw.map(g => ({ t: g.t * GEOM_S, hp: g.hp / D }));
            const ct = cursorTimeCode();
            drawWaveform(wf, { tail: null, sph, label: `SPH quadrupole strain at ${fmt.sig(state.distanceMpc, 3)} Mpc (face-on)`, cursorT: ct === null ? null : ct * GEOM_S });
        } else if (d.insp.valid) {
            drawWaveform(wf, { tail: d.insp.tail, label: `PN inspiral, last ${fmt.sig(d.insp.tail.t[d.insp.tail.t.length - 1] * 1000, 2)} ms before ${d.insp.endReason}` });
        }
    }

    // ── Catalog rail ────────────────────────────────────────────────────────
    const rail = $('#sc-catalog');
    function renderCatalog() {
        if (!rail) return;
        if (!rail.dataset.built) {
            rail.innerHTML = '';
            for (const o of OBJECTS) {
                const card = doc.createElement('article');
                card.className = 'sc-card';
                card.dataset.objectId = o.id;
                card.innerHTML = `
                    <div class="sc-card-head"><span class="sc-kind sc-kind-${o.kind}">${KIND_LABEL[o.kind]}</span><strong>${o.name}</strong></div>
                    <div class="sc-card-short">${o.short}</div>
                    <div class="sc-card-props" data-props></div>
                    <p class="sc-card-blurb">${o.blurb}</p>
                    <div class="sc-card-actions">
                        <button type="button" data-load="0">Load as A</button>
                        <button type="button" data-load="1">Load as B</button>
                    </div>
                    <div class="sc-card-src">${o.sources.join(' · ')}</div>`;
                card.querySelectorAll('[data-load]').forEach(btn => btn.addEventListener('click', () => {
                    const i = +btn.dataset.load;
                    state.bodies[i] = { source: o.id, custom: null };
                    state.chiOverride[i] = null;
                    state.separationKm = null;
                    state.pair = '';
                    const sel = ctl(i === 0 ? 'bodyA' : 'bodyB'); if (sel) sel.value = o.id;
                    recompute();
                    onStructural(`${o.name} loaded as ${i === 0 ? 'A' : 'B'}`);
                }));
                rail.appendChild(card);
            }
            rail.dataset.built = '1';
        }
        for (const card of rail.querySelectorAll('.sc-card')) {
            const o = objectById(card.dataset.objectId);
            const p = resolveProfile(o, state.eos);
            const props = [];
            props.push(`M ${p.M}${o.mass.sigma ? ` ± ${o.mass.sigma}` : ''} M☉ <em>${o.mass.source}</em>`);
            if (p.kind === 'bh') props.push(`χ ${fmt.num(p.chi, 2)} · r₊ ${fmt.km(p.horizonKm)} · ISCO ${fmt.km(p.iscoKm)}`);
            else if (p.kind === 'wd') props.push(`R ${fmt.km(p.radiusKm)} · C ${fmt.sci(p.compactness, 1)}`);
            else props.push(`R ${fmt.km(p.radiusKm)} <em>${p.radiusSource}</em> · C ${fmt.num(p.compactness, 3)} · Λ ${p.eosSupported ? fmt.num(p.Lambda, 0) : '—'} · χ ${fmt.num(p.chi, 3)}${p.bFieldG ? ` · B ${fmt.sci(p.bFieldG, 0)} G` : ''}`);
            if (p.kind === 'ns' && !p.eosSupported) props.push(`<span class="sc-warn">exceeds M_max of ${state.eos}</span>`);
            if (o.distanceKpc) props.push(`d ${o.distanceKpc >= 1000 ? `${fmt.sig(o.distanceKpc / 1000, 3)} Mpc` : `${fmt.sig(o.distanceKpc, 3)} kpc`}`);
            card.querySelector('[data-props]').innerHTML = props.join('<br>');
            card.classList.toggle('sc-card-a', state.bodies[0].source === o.id);
            card.classList.toggle('sc-card-b', state.bodies[1].source === o.id);
        }
    }

    // ── Controls ────────────────────────────────────────────────────────────
    let syncing = false;
    function syncControlsFromState() {
        syncing = true;
        const [A, B] = state.profiles;
        for (const [p, s, i] of [[A, 'A', 0], [B, 'B', 1]]) {
            const sel = ctl(`body${s}`); if (sel) sel.value = state.bodies[i].source;
            const kind = ctl(`kind${s}`); if (kind) kind.value = p.kind;
            const mass = ctl(`mass${s}`); if (mass && doc.activeElement !== mass) mass.value = fmt.sig(p.M, 4);
            const radius = ctl(`radius${s}`); if (radius && doc.activeElement !== radius) { radius.value = fmt.sig(p.radiusKm, 4); radius.disabled = p.kind === 'bh'; }
            const chi = ctl(`chi${s}`); if (chi && doc.activeElement !== chi) chi.value = fmt.num(p.chi, 3);
        }
        const sep = ctl('separation'); if (sep && doc.activeElement !== sep) sep.value = fmt.sig(state.separationKm, 4);
        const dist = ctl('distance'); if (dist && doc.activeElement !== dist) dist.value = fmt.sig(state.distanceMpc, 3);
        const ecc = ctl('eccentricity'); if (ecc) ecc.value = String(state.eccentricity);
        set('eccentricityOut', fmt.num(state.eccentricity, 2));
        const pairSel = ctl('pair'); if (pairSel) pairSel.value = state.pair || '';
        syncing = false;
    }

    function customFromControls(i) {
        const s = i === 0 ? 'A' : 'B';
        const p = state.profiles[i];
        const kind = val(`kind${s}`) || p.kind;
        const mass = num(`mass${s}`, p.M);
        const radius = num(`radius${s}`, p.radiusKm);
        const base = bodySpec(i);
        const custom = { ...base, id: base.id || 'custom', name: base.name && state.bodies[i].source !== 'custom' ? `${base.name} (edited)` : 'Custom', kind, mass, kindOverride: kind };
        if (kind !== 'bh' && Number.isFinite(radius) && radius > 0 && (kind === 'wd' || Math.abs(radius - (p.eosRadiusKm || radius)) > 1e-6)) custom.radiusKm = radius;
        else delete custom.radiusKm;
        if (kind === 'bh') { custom.chi = num(`chi${s}`, p.chi); }
        state.bodies[i] = { source: 'custom', custom };
        if (kind !== 'bh') state.chiOverride[i] = num(`chi${s}`, p.chi);
        state.pair = '';
    }

    const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
    const recomputeSoon = debounce(recompute, 120);

    // A structural change while a run exists: rebuild it (debounced) when auto-apply is on.
    const rebuildSoon = debounce(() => {
        if (!simActive() || !val('autoApply')) return;
        buildAndRun({ run: true, reason: 'auto' });
    }, REBUILD_MS);
    function onStructural(what) {
        if (!simActive()) { setNote(`${what} — preview updated; Build & run to simulate`); return; }
        if (val('autoApply')) { setNote(`${what} — rebuilding the run from t = 0…`); rebuildSoon(); }
        else setNote(`${what} — the running sim keeps its build; Build & run to apply`);
    }
    function setNote(text) { state.sim.note = text; state.sim.noteAt = performance.now(); set('applyNote', text); }

    ctl('bodyA')?.addEventListener('change', () => { if (syncing) return; loadBody(0, val('bodyA')); });
    ctl('bodyB')?.addEventListener('change', () => { if (syncing) return; loadBody(1, val('bodyB')); });
    function loadBody(i, id) {
        if (id === 'custom') { customFromControls(i); }
        else { state.bodies[i] = { source: id, custom: null }; state.chiOverride[i] = null; }
        state.separationKm = null; state.pair = '';
        recompute();
        onStructural(`body ${i === 0 ? 'A' : 'B'} changed`);
    }
    for (const s of ['A', 'B']) {
        const i = s === 'A' ? 0 : 1;
        const apply = (label) => { if (syncing) return; customFromControls(i); state.separationKm = null; recompute(); onStructural(label); };
        ctl(`kind${s}`)?.addEventListener('change', () => apply(`kind of ${s} changed`));
        // Number fields respond as you type (debounced) so the preview and the
        // readouts track the value; syncControlsFromState leaves a focused field alone.
        for (const k of ['mass', 'radius', 'chi']) {
            const el = ctl(`${k}${s}`);
            if (!el) continue;
            const soon = debounce(() => apply(`${k} of ${s} changed`), 250);
            el.addEventListener('input', () => { if (syncing) return; if (Number.isFinite(parseFloat(el.value))) soon(); });
            el.addEventListener('change', () => { if (syncing) return; apply(`${k} of ${s} changed`); });
        }
    }
    ctl('eos')?.addEventListener('change', () => { state.eos = val('eos'); state.separationKm = null; recompute(); onStructural(`EOS → ${state.eos}`); });
    ctl('separation')?.addEventListener('input', () => { if (syncing) return; const v = num('separation', NaN); if (v > 0) { state.separationKm = v; recomputeSoon(); onStructural('separation changed'); } });
    ctl('eccentricity')?.addEventListener('input', () => { state.eccentricity = num('eccentricity', 0); set('eccentricityOut', fmt.num(state.eccentricity, 2)); onStructural(`eccentricity ${fmt.num(state.eccentricity, 2)}`); });
    ctl('distance')?.addEventListener('input', () => { if (syncing) return; const v = num('distance', NaN); if (v > 0) { state.distanceMpc = v; recomputeSoon(); } });
    ctl('corotate')?.addEventListener('change', () => onStructural(val('corotate') ? 'tidal lock on' : 'tidal lock off'));
    ctl('particles')?.addEventListener('change', () => onStructural(`${val('particles')} particles per star`));
    ctl('seed')?.addEventListener('change', () => onStructural(`seed ${num('seed', DEFAULT_SEED) | 0}`));
    ctl('pair')?.addEventListener('change', () => { if (syncing) return; loadPair(val('pair')); onStructural('pair loaded'); });
    function loadPair(id) {
        const p = pairById(id);
        if (!p) { state.pair = ''; recompute(); return; }
        state.pair = id;
        state.bodies[0] = { source: p.a, custom: null };
        state.bodies[1] = { source: p.b, custom: null };
        state.chiOverride = [null, null];
        state.separationKm = null;
        if (p.event?.distanceMpc) state.distanceMpc = p.event.distanceMpc;
        recompute();
    }
    // Live parameters: an event on the running clock, effective from the next chunk.
    function liveParams() {
        const alpha = num('viscosity', 1);
        return { c: 1, alpha, beta: 2 * alpha, gammaTh: num('gammaTh', 1.75), pn1: !!val('pn1'), pn25: !!val('pn25'), sinkFactor: 1.5 };
    }
    function onLiveParam(what) {
        if (!simActive() || !worker) { setNote(`${what} — applies when the run is built`); return; }
        const c = state.sim.clock;
        // `at` pins the change to the review cursor. While the run is LIVE the page's last
        // frame lags the worker's head by up to a frame interval, so no position is sent and
        // the worker applies the event at its own head — sending the stale chunk made every
        // live tweak branch the run a few chunks back (measured in the browser gate).
        const reviewing = c && c.chunk < c.head && c.mode !== 'running';
        worker.postMessage(reviewing ? { type: 'params', params: liveParams(), at: c.chunk } : { type: 'params', params: liveParams() });
        setNote(reviewing ? `${what} — applied at chunk ${c.chunk}: the run branches here` : `${what} — applied live at the head`);
    }
    for (const k of ['viscosity', 'gammaTh']) {
        const el = ctl(k); if (!el) continue;
        const soon = debounce(() => onLiveParam(k === 'viscosity' ? `α = ${fmt.num(num('viscosity', 1), 2)}` : `Γ_th = ${fmt.num(num('gammaTh', 1.75), 2)}`), 200);
        el.addEventListener('input', () => { if (Number.isFinite(parseFloat(el.value))) soon(); });
    }
    ctl('pn25')?.addEventListener('change', () => onLiveParam(`2.5PN ${val('pn25') ? 'on' : 'off'}`));
    ctl('pn1')?.addEventListener('change', () => onLiveParam(`1PN ${val('pn1') ? 'on' : 'off'}`));
    ctl('autoApply')?.addEventListener('change', () => setNote(val('autoApply') ? 'structural changes rebuild the run live' : 'structural changes wait for Build & run'));
    ctl('autorotate')?.addEventListener('change', () => scene?.setAutoRotate(val('autorotate')));
    ctl('warp')?.addEventListener('change', () => sendWarp());
    ctl('run')?.addEventListener('click', () => buildAndRun({ run: true, reason: 'button' }));
    ctl('reset')?.addEventListener('click', () => resetSim());

    // ── Transport ───────────────────────────────────────────────────────────
    const clockOf = () => state.sim.clock;
    const post = (msg) => { if (worker && simActive()) worker.postMessage(msg); };
    function transport(cmd) {
        const c = clockOf(); if (!c) return;
        const at = c.mode === 'running' ? undefined : c.chunk;   // a live run's position is the worker's, not the last frame's
        switch (cmd) {
            case 'toStart': post({ type: 'seek', chunk: 0, exact: true }); break;
            case 'toHead': post({ type: 'live', run: false }); break;
            case 'stepBack': post({ type: 'step', dir: -1, at }); break;
            case 'stepFwd': post({ type: 'step', dir: 1, at }); break;
            case 'branch': post({ type: 'branch', run: true, at }); break;
            case 'replay': post({ type: 'replay', on: true, at }); break;
            case 'togglePause':
                if (c.mode === 'running') post({ type: 'pause' });
                else if (c.mode === 'replay') post({ type: 'replay', on: false });
                else if (c.chunk < c.head) post({ type: 'replay', on: true, at: c.chunk });
                else post({ type: 'run', warp: warpValue(), budgetMs: 28 });
                break;
            default: break;
        }
    }
    ctl('tStart')?.addEventListener('click', () => transport('toStart'));
    ctl('tBack')?.addEventListener('click', () => transport('stepBack'));
    ctl('tPlay')?.addEventListener('click', () => transport('togglePause'));
    ctl('tFwd')?.addEventListener('click', () => transport('stepFwd'));
    ctl('tHead')?.addEventListener('click', () => transport('toHead'));
    ctl('tReplay')?.addEventListener('click', () => transport('replay'));
    ctl('tBranch')?.addEventListener('click', () => transport('branch'));
    let scrubbing = false, scrubLast = 0, scrubPending = null, scrubTimer = 0;
    const scrub = ctl('scrub');
    if (scrub) {
        const flush = () => { scrubTimer = 0; if (scrubPending !== null) { post({ type: 'seek', chunk: scrubPending, exact: false }); scrubPending = null; scrubLast = performance.now(); } };
        scrub.addEventListener('pointerdown', () => { scrubbing = true; });
        scrub.addEventListener('input', () => {
            scrubbing = true;
            const k = Math.round(parseFloat(scrub.value));
            if (performance.now() - scrubLast > SCRUB_THROTTLE_MS && !scrubTimer) { post({ type: 'seek', chunk: k, exact: false }); scrubLast = performance.now(); }
            else { scrubPending = k; if (!scrubTimer) scrubTimer = setTimeout(flush, SCRUB_THROTTLE_MS); }
        });
        scrub.addEventListener('change', () => {
            scrubbing = false; scrubPending = null; if (scrubTimer) { clearTimeout(scrubTimer); scrubTimer = 0; }
            post({ type: 'seek', chunk: Math.round(parseFloat(scrub.value)), exact: true });
        });
        scrub.addEventListener('pointerup', () => { scrubbing = false; });
        scrub.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { scrubbing = false; post({ type: 'seek', chunk: Math.round(parseFloat(scrub.value)), exact: true }); } });
    }

    // ── The SPH engine ──────────────────────────────────────────────────────
    let worker = null, scene = null;
    const stageEl = $('#sc-stage'), fallback = $('#sc-stage-fallback');
    const simActive = () => (state.sim.status === 'ready' || state.sim.status === 'building') && state.sim.engine === 'wasm';
    try {
        if (stageEl) {
            import('./scene.js').then(({ createColliderScene }) => {
                scene = createColliderScene(stageEl, { onCommand: onSceneCommand });
                scene.setAutoRotate(!!val('autorotate'));
                scene.setColorMode(val('colorMode') || 'density');
                scene.setFollow(val('follow') || 'system');
                scene.setTrails(val('trails') !== false && val('trails') !== null ? !!val('trails') : true);
                scene.setPointScale(num('pointScale', 1));
                scene.setCorotating(!!val('frameCorotating'));
                if (fallback) fallback.hidden = true;
                if (state.sim.frame) pushFrameToScene(state.sim.frame, state.sim.diag, state.sim.bodies);
                else renderPreview();
                scene.setView('oblique', { animate: false });
                renderViewState();
            }).catch(err => {
                console.warn('[star-collider] stage unavailable', err);
                if (fallback) { fallback.hidden = false; fallback.textContent = 'WebGL is unavailable in this browser — the analytic engine still runs below.'; }
            });
        }
    } catch (err) {
        if (fallback) { fallback.hidden = false; }
    }
    try {
        worker = new Worker(new URL('./sph-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = onWorkerMessage;
        worker.onerror = (e) => { state.sim.engine = 'unavailable'; state.sim.status = 'error'; set('simEngine', 'worker error'); console.warn('[star-collider] worker error', e.message); renderHud(); };
        worker.postMessage({ type: 'init', wasmUrl: new URL('./wasm/star_collider_kernel.wasm', import.meta.url).href });
    } catch (err) {
        state.sim.engine = 'unavailable';
        console.warn('[star-collider] no worker', err);
    }

    function warpValue() { return (WARP_CHOICES.find(w => w.id === val('warp')) || WARP_CHOICES[0]).warp; }
    function sendWarp() { worker?.postMessage({ type: 'warp', warp: warpValue() }); }

    /** Build the SPH run from the current pair. Every input is read here, once — the run is a pure function of them plus the seed. */
    function buildAndRun({ run = true, reason = 'button' } = {}) {
        const d = state.derived; if (!d || !worker || state.sim.engine === 'unavailable') return;
        const [A, B] = state.profiles;
        const nPer = parseInt(val('particles'), 10) || 600;
        const toCode = (km) => km / GEOM_KM;
        const bodies = [A, B].map(p => p.kind === 'bh'
            ? { kind: 'bh', mass: p.M, radius: 2 * p.M, gamma: 2, n: 0 }
            : { kind: 'star', mass: p.M, radius: toCode(p.radiusKm), gamma: p.kind === 'wd' ? 5 / 3 : 2, n: nPer });
        const sepCode = toCode(d.sepKm);
        const smallest = bodies.filter(b => b.kind === 'star').sort((a, b) => a.radius - b.radius)[0];
        const dyn = smallest ? Math.sqrt(smallest.radius ** 3 / smallest.mass) : Math.sqrt(sepCode ** 3 / d.M) / 60;
        const dtMax = smallest ? 0.12 * dyn : dyn;
        const chunkDt = CHUNK_STEPS * dtMax;
        const corotate = !!val('corotate');
        const omega = Math.sqrt(d.M / sepCode ** 3);
        const seed = Math.max(0, Math.floor(num('seed', DEFAULT_SEED))) >>> 0;
        state.sim = { ...state.sim, status: 'building', n: 0, frames: 0, diag: null, bodies: null, gw: [], energy: [], e0: null, merged: false, dtMax, chunkDt, seed,
            builtAt: performance.now(), frame: null, perf: null, clock: null, lastFrameTime: -1, autoRun: run, buildReason: reason };
        renderHud();
        worker.postMessage({
            type: 'setup', seed,
            params: liveParams(),
            bodies, orbit: { sep: sepCode, ecc: state.eccentricity, spinA: corotate && bodies[0].kind === 'star' ? omega : 0, spinB: corotate && bodies[1].kind === 'star' ? omega : 0, pnCirc: !!val('pn1') },
            relax: { steps: 60, dtMax: 0.5 * dtMax, damping: 0.05 },
            clock: { chunkDt, dtMax },
        });
        if (scene) {
            const extent = sepCode + bodies[0].radius + bodies[1].radius;
            scene.setScale(extent / 8, sepCode / 2);
            const spacing = smallest ? smallest.radius * Math.cbrt(4 * Math.PI / 3 / nPer) : extent / 60;
            scene.setPointSize(Math.max(1.1 * spacing / (extent / 8), 0.02));
            set('stageScale', `ring = ${fmt.km(d.sepKm / 2)} · ${fmt.km(extent / 8 * GEOM_KM)} per grid unit`);
        }
    }
    function resetSim() {
        worker?.postMessage({ type: 'pause' });
        state.sim = { ...state.sim, status: 'idle', n: 0, diag: null, bodies: null, gw: [], energy: [], e0: null, merged: false, frame: null, perf: null, clock: null, lastFrameTime: -1, previewFramed: false };
        scene?.clear();
        renderPreview();
        setNote('run discarded — the preview shows the configured pair');
        renderHud(); drawCharts(); set('sphVsFit', sphVsFitText());
    }
    function truncateSeries(tCode) {
        const s = state.sim;
        s.gw = s.gw.filter(g => g.t <= tCode);
        s.energy = s.energy.filter(e => e.t <= tCode);
    }
    function onWorkerMessage(ev) {
        const msg = ev.data;
        const s = state.sim;
        if (msg.type === 'ready') { s.engine = 'wasm'; s.frameStride = msg.frameStride || 6; renderHud(); return; }
        if (msg.type === 'error') { s.status = 'error'; s.error = msg.message; renderHud(); return; }
        if (msg.type === 'built') {
            s.n = msg.n; s.status = 'ready'; s.bodies = msg.bodies; s.diag = msg.diag; s.frame = msg.frame;
            s.e0 = msg.diag.eTotal; s.relaxMs = msg.relaxMs; s.frameStride = msg.frameStride || s.frameStride || 6;
            s.clock = clockFrom(msg); s.lastFrameTime = 0;
            scene?.clearTrails();
            pushFrameToScene(msg.frame, msg.diag, msg.bodies);
            scene?.frameSystem({ animate: false });
            if (s.autoRun) worker.postMessage({ type: 'run', warp: warpValue(), budgetMs: 28 });
            setNote(s.buildReason === 'auto' ? `rebuilt from t = 0 with the new settings (${msg.n} particles, relaxed in ${msg.relaxMs.toFixed(0)} ms)` : `built ${msg.n} particles · relaxed in ${msg.relaxMs.toFixed(0)} ms · seed ${s.seed}`);
            renderHud();
            return;
        }
        if (msg.type === 'branched') {
            truncateSeries(msg.time);
            s.merged = false;
            setNote(`branched at chunk ${msg.chunk} (t = ${fmt.ms(msg.time)}) — the timeline after it is discarded`);
            drawWaveformChart(); drawEnergyChart();
            return;
        }
        if (msg.type === 'frame') {
            if (s.status !== 'ready') return;   // a late frame from a run that was reset
            s.clock = clockFrom(msg);
            s.diag = msg.diag; s.bodies = msg.bodies; s.frames++; if (msg.perf) s.perf = msg.perf;
            const liveHead = msg.chunk === msg.head && msg.exact !== false && (msg.mode === 'running' || msg.mode === 'paused');
            if (msg.gw && msg.gw.length) {
                for (const g of msg.gw) if (!s.gw.length || g.t > s.gw[s.gw.length - 1].t) s.gw.push(g);
                if (s.gw.length > 6000) s.gw = s.gw.slice(-6000);
            }
            if (liveHead && (!s.energy.length || msg.diag.time > s.energy[s.energy.length - 1].t) && (s.frames % 2 === 0 || !s.energy.length)) {
                s.energy.push({ t: msg.diag.time, eKin: msg.diag.eKin, eThermal: msg.diag.eThermal, ePot: msg.diag.ePot, eTotal: msg.diag.eTotal, eGw: msg.diag.eGw });
                if (s.energy.length > 1500) s.energy = s.energy.filter((_, i) => i % 2 === 0);
            }
            if (msg.frame) {
                if (msg.time < s.lastFrameTime - 1e-12) scene?.clearTrails();
                s.frame = msg.frame; s.lastFrameTime = msg.time;
                pushFrameToScene(msg.frame, msg.diag, msg.bodies);
            }
            if (msg.paramsApplied) setNote(msg.branched ? `parameters changed behind the head — branched at chunk ${msg.chunk}` : `parameters applied at chunk ${msg.chunk}: α = ${fmt.num(msg.paramsApplied.alpha, 2)}, Γ_th = ${fmt.num(msg.paramsApplied.gammaTh, 2)}, 2.5PN ${msg.paramsApplied.pn25 ? 'on' : 'off'}, 1PN ${msg.paramsApplied.pn1 ? 'on' : 'off'}`);
            if (liveHead) {
                const [A, B] = state.profiles;
                const rsum = (A.kind === 'bh' ? 2 * A.M : A.radiusKm / GEOM_KM) + (B.kind === 'bh' ? 2 * B.M : B.radiusKm / GEOM_KM);
                if (!s.merged && msg.diag.separation < 0.5 * rsum) s.merged = true;
                if (A.kind === 'bh' && B.kind === 'bh' && msg.diag.separation < rsum && msg.mode === 'running') {
                    s.bbhDone = true; worker.postMessage({ type: 'pause' }); setNote('horizons touching — the point-mass run stops here; see the aftermath fits');
                }
            }
            renderHud();
            const reviewing = msg.chunk < msg.head;
            if (s.frames % 6 === 0 || reviewing) { drawWaveformChart(); drawEnergyChart(); set('sphVsFit', sphVsFitText()); }
        }
    }
    const clockFrom = (msg) => ({ chunk: msg.chunk, head: msg.head, mode: msg.mode, time: msg.time, headTime: msg.headTime, exact: msg.exact !== false, kernelChunk: msg.kernelChunk, timeline: msg.timeline || null });
    const bodyKinds = (bodies) => bodies.map((b, i) => ({ ...b, kind: state.profiles[i].kind === 'bh' ? 'bh' : 'star' }));

    // ── Stage: frames, preview, camera state ────────────────────────────────
    /** Hand a kernel frame + its diagnostics to the stage (meta drives follow/corotation/trails). */
    function pushFrameToScene(frame, diag, bodies) {
        if (!scene || !frame) return;
        const [A, B] = state.profiles;
        const meta = diag ? {
            cmA: [diag.cmAx, diag.cmAy, diag.cmAz], cmB: [diag.cmBx, diag.cmBy, diag.cmBz],
            mA: A.kind === 'bh' ? diag.massA : diag.aliveMassA, mB: B.kind === 'bh' ? diag.massB : diag.aliveMassB,
            sep: diag.separation, omega: diag.omega, time: diag.time,
        } : null;
        scene.setFrame(frame, state.sim.n, bodyKinds(bodies || state.sim.bodies || []), meta, state.sim.frameStride || 6);
    }
    /** Before a run: the configured pair as wire spheres at the configured separation. Re-framed when the extent moves by more than a quarter. */
    function renderPreview() {
        if (!scene || !state.derived) return;
        if (state.sim.status !== 'idle' && state.sim.frame) return;
        const [A, B] = state.profiles;
        const d = state.derived;
        const toCode = (km) => km / GEOM_KM;
        const rA = A.kind === 'bh' ? 2 * A.M : toCode(A.radiusKm);
        const rB = B.kind === 'bh' ? 2 * B.M : toCode(B.radiusKm);
        const sepCode = toCode(d.sepKm);
        const M = A.M + B.M;
        const extent = sepCode + rA + rB;
        scene.setScale(extent / 8, sepCode / 2);
        scene.setPreview([
            { kind: A.kind === 'bh' ? 'bh' : 'star', radius: rA, pos: [-B.M / M * sepCode, 0, 0] },
            { kind: B.kind === 'bh' ? 'bh' : 'star', radius: rB, pos: [A.M / M * sepCode, 0, 0] },
        ]);
        set('stageScale', `ring = ${fmt.km(d.sepKm / 2)} · ${fmt.km(extent / 8 * GEOM_KM)} per grid unit · preview of the configured pair`);
        const moved = state.sim.previewExtent > 0 && Math.abs(extent - state.sim.previewExtent) / state.sim.previewExtent > 0.25;
        if (!state.sim.previewFramed || moved) { scene.frameSystem({ animate: state.sim.previewFramed }); state.sim.previewFramed = true; state.sim.previewExtent = extent; }
    }
    const FOLLOW_LABEL = { system: 'following the system barycentre', A: 'following core A', B: 'following core B', none: 'fixed on the origin' };
    const COLOUR_LABEL = {
        density: 'log₁₀ ρ, top 3 decades · shock heat → orange', heat: 'shock heating u · blue → white → red',
        body: 'body A cyan · body B magenta', bound: 'bound dim · unbound ejecta green (Bernoulli, same flag as M_unbound)',
    };
    function renderViewState() {
        if (!scene) { set('stageFrame', 'stage unavailable'); set('stageColour', '—'); return; }
        const v = scene.state;
        set('stageFrame', `${v.corotating ? 'corotating frame (cores held on x)' : 'inertial frame'} · ${FOLLOW_LABEL[v.follow] || v.follow} · ${v.view} view${v.trails ? ' · trails' : ''}`);
        set('stageColour', COLOUR_LABEL[v.colorMode] || v.colorMode);
        set('pointScaleOut', `${v.pointScale.toFixed(1)}×`);
        const sync = (key, value) => { const el = ctl(key); if (el && document.activeElement !== el) { if (el.type === 'checkbox') el.checked = !!value; else el.value = String(value); } };
        sync('follow', v.follow); sync('colorMode', v.colorMode); sync('frameCorotating', v.corotating); sync('trails', v.trails); sync('pointScale', v.pointScale);
        for (const [key, name] of [['viewTop', 'top'], ['viewEdge', 'edge'], ['viewOblique', 'oblique']]) ctl(key)?.classList.toggle('sc-on', v.view === name);
    }
    function onSceneCommand(cmd) {
        if (['togglePause', 'stepBack', 'stepFwd', 'toStart', 'toHead'].includes(cmd)) { transport(cmd); return; }
        renderViewState();
    }
    ctl('viewTop')?.addEventListener('click', () => scene?.setView('top'));
    ctl('viewEdge')?.addEventListener('click', () => scene?.setView('edge'));
    ctl('viewOblique')?.addEventListener('click', () => scene?.setView('oblique'));
    ctl('frameSystem')?.addEventListener('click', () => scene?.frameSystem());
    ctl('follow')?.addEventListener('change', () => scene?.setFollow(val('follow')));
    ctl('colorMode')?.addEventListener('change', () => scene?.setColorMode(val('colorMode')));
    ctl('frameCorotating')?.addEventListener('change', () => scene?.setCorotating(!!val('frameCorotating')));
    ctl('trails')?.addEventListener('change', () => scene?.setTrails(!!val('trails')));
    ctl('pointScale')?.addEventListener('input', () => { scene?.setPointScale(num('pointScale', 1)); set('pointScaleOut', `${num('pointScale', 1).toFixed(1)}×`); });

    // ── HUD + transport readouts ────────────────────────────────────────────
    const MODE_LABEL = { running: 'LIVE · RUNNING', paused: 'LIVE · PAUSED', review: 'REVIEW', replay: 'REPLAY', seeking: 'SEEKING' };
    function statusText() {
        const s = state.sim, c = s.clock;
        if (s.status === 'idle') return 'idle — Build & run to start';
        if (s.status === 'building') return `building ${parseInt(val('particles'), 10) || 600} particles per star + relaxing…`;
        if (s.status === 'error') return `error: ${s.error || ''}`;
        if (!c) return 'ready';
        const phase = s.merged ? 'merged' : 'inspiral';
        if (s.bbhDone && c.chunk === c.head) return 'merged — horizons touching; see the aftermath fits';
        if (c.mode === 'running') return `running · ${phase}`;
        if (c.mode === 'paused') return `paused at the head · ${phase}`;
        if (c.mode === 'replay') return `replaying the recorded timeline · chunk ${c.chunk} of ${c.head}`;
        if (c.mode === 'seeking') return `seeking · replaying from the nearest checkpoint to chunk ${c.chunk}…`;
        return `review · chunk ${c.chunk} of ${c.head} · ${c.exact ? 'bit-exact replay' : 'recorded frame'}`;
    }
    function renderTransport() {
        const s = state.sim, c = s.clock;
        const root = $('#sc-transport');
        const active = simActive() && !!c;
        if (root) root.dataset.mode = active ? (s.bbhDone && c.mode === 'paused' ? 'done' : c.mode) : (s.status === 'building' ? 'building' : 'idle');
        set('clockMode', active ? (MODE_LABEL[c.mode] || c.mode.toUpperCase()) : s.status === 'building' ? 'BUILDING' : 'NO RUN');
        set('clockTime', active ? fmt.ms(c.time) : '—');
        set('clockChunk', active ? `${c.chunk} / ${c.head}` : '—');
        set('clockSteps', active && s.diag ? `${s.diag.steps | 0}` : '—');
        set('clockTimeline', active && c.timeline
            ? `${c.timeline.entries} frames every ${c.timeline.every} chunk${c.timeline.every === 1 ? '' : 's'} · ${c.timeline.snapshots} checkpoints · ${fmt.bytes(c.timeline.bytes)} · head ${fmt.ms(c.headTime)}`
            : '—');
        set('clockDet', active ? `seed ${s.seed} · chunk = ${CHUNK_STEPS} × dt_max = ${(s.chunkDt * GEOM_S * 1e6).toFixed(2)} µs of merger · same settings + seed ⇒ same run, bit for bit` : `seed ${num('seed', DEFAULT_SEED) | 0} · chunk = ${CHUNK_STEPS} × dt_max`);
        set('playGlyph', active && (c.mode === 'running' || c.mode === 'replay') ? '❚❚' : '▶');
        const playEl = ctl('tPlay');
        if (playEl) playEl.title = !active ? 'Build & run first' : c.mode === 'running' ? 'pause (space)' : c.mode === 'replay' ? 'stop the replay (space)' : c.chunk < c.head ? 'replay the recorded timeline from here (space)' : 'run from the head (space)';
        enable('tStart', active && c.chunk > 0);
        enable('tBack', active && c.chunk > 0);
        enable('tPlay', active);
        enable('tFwd', active);
        enable('tHead', active && !(c.chunk === c.head && c.exact));
        enable('tReplay', active && c.head > 0 && c.mode !== 'replay');
        enable('tBranch', active && c.chunk < c.head);
        if (scrub) {
            scrub.disabled = !active;
            const max = active ? Math.max(c.head, 1) : 1;
            if (String(max) !== scrub.max) scrub.max = String(max);
            if (!scrubbing) scrub.value = String(active ? c.chunk : 0);
        }
        set('consoleStatus', active ? (c.mode === 'running' ? 'running' : c.mode === 'paused' ? 'paused' : c.mode) : s.status);
    }
    function renderHud() {
        const s = state.sim, d = s.diag;
        set('simEngine', { loading: 'loading kernel…', wasm: 'WASM · Rust SPH kernel', unavailable: 'unavailable — analytic engine only' }[s.engine] || s.engine);
        set('simStatus', statusText());
        renderTransport();
        if (!d) { for (const k of ['simTime', 'simSep', 'simFreq', 'simN', 'simSteps', 'simRate', 'simUnbound', 'simAccreted', 'simRhoMax', 'simHeat', 'simEgw', 'simDrift', 'simPn']) set(k, '—'); return; }
        set('simTime', fmt.ms(d.time));
        set('simSep', fmt.km(d.separation * GEOM_KM));
        set('simFreq', fmt.hz(Math.abs(d.omega) / Math.PI / GEOM_S));
        set('simN', `${d.nAlive | 0} / ${s.n}`);
        set('simSteps', `${d.steps | 0}`);
        set('simRate', s.perf ? `${s.perf.stepsPerSec.toFixed(0)} steps/s · ${s.perf.msPerStep.toFixed(1)} ms/step` : '—');
        set('simUnbound', fmt.msun(d.mUnbound, 4));
        set('simAccreted', fmt.msun(d.accretedA + d.accretedB, 4));
        const [A, B] = state.profiles;
        const exact = [A, B].filter(p => p.kind === 'ns').map(p => Math.PI * p.M / (4 * (p.radiusKm / GEOM_KM) ** 3));
        set('simRhoMax', `${fmt.sci(d.rhoMax * RHO_GEOM, 2)} g/cm³${exact.length ? ` (${fmt.num(d.rhoMax / Math.max(...exact), 2)}× the n=1 central density)` : ''}`);
        set('simHeat', `${fmt.sci(d.uMax, 2)} c² (${fmt.sci(d.uMax * 8.98755e20 * 1.66054e-24 / 1.380649e-16, 1)} K per nucleon-equivalent)`);
        set('simEgw', `${fmt.sci(d.eGw, 2)} M☉c² (${fmt.sci(d.eGw * 1.98847e33 * 8.98755e20, 2)} erg)`);
        set('simDrift', s.e0 ? fmt.pct((d.eTotal + d.eGw - s.e0) / Math.abs(s.e0)) : '—');
        set('simPn', d.pnWeight > 0 ? `radiation reaction on (weight ${fmt.num(d.pnWeight, 2)})` : (s.merged ? 'faded — bodies overlap' : 'off'));
    }

    // ── Boot ────────────────────────────────────────────────────────────────
    loadPair(state.pair);
    setNote('preview of the configured pair — every control updates it; Build & run starts the particles');
    renderHud();
    renderViewState();
    window.addEventListener('resize', debounce(drawCharts, 150));

    // Test hook
    window.__starCollider = {
        state, recompute, buildAndRun, resetSim, loadPair, transport,
        get scene() { return scene; }, get worker() { return worker; },
    };
    return window.__starCollider;
}
