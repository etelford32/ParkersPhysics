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
 * readout and chart from one derived state. The SPH engine is started
 * explicitly ("Build & run") from the same pair, in the same units, and
 * its diagnostics stream into the HUD + the waveform/energy charts. The two
 * are never mixed in one number: the aftermath panel is the calibrated fits,
 * the HUD is the simulation, and the "SPH vs fit" row prints both.
 *
 * THE DOM CONTRACT is `data-sc="<key>"` for a readout, `data-sc-control` for
 * an input, `data-sc-chart` for a canvas. Keys are looked up once at init; a
 * key present in the markup but never written, or written but absent, is
 * caught by tests/star-collider-page.mjs, which parses the HTML and diffs
 * the two sets (the Boötes page's gate, reused).
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
    { id: 'max', label: 'as fast as the hardware allows', warp: 1e12 },
    { id: 'rt2000', label: '1 ms of merger per 2 s', warp: 1e-3 / GEOM_S / 2 },
    { id: 'rt10000', label: '1 ms of merger per 10 s', warp: 1e-3 / GEOM_S / 10 },
    { id: 'rt50000', label: '1 ms of merger per 50 s', warp: 1e-3 / GEOM_S / 50 },
];
const DEFAULT_DISTANCE_MPC = 40;

const fmt = {
    num: (v, d = 2) => Number.isFinite(v) ? (+v).toFixed(d) : '—',
    sci: (v, d = 2) => Number.isFinite(v) && v !== 0 ? v.toExponential(d) : (v === 0 ? '0' : '—'),
    sig: (v, d = 3) => Number.isFinite(v) ? (+v).toPrecision(d) : '—',
    km: (v) => Number.isFinite(v) ? (v >= 1e4 ? `${(v / 1e3).toPrecision(3)} × 10³ km` : `${v.toFixed(v < 100 ? 2 : 0)} km`) : '—',
    msun: (v, d = 3) => Number.isFinite(v) ? `${(+v).toFixed(d)} M☉` : '—',
    pct: (v) => Number.isFinite(v) ? `${(100 * v).toFixed(1)} %` : '—',
    hz: (v) => Number.isFinite(v) ? (v >= 1000 ? `${(v / 1000).toPrecision(3)} kHz` : v >= 1 ? `${v.toPrecision(3)} Hz` : `${(v * 1000).toPrecision(3)} mHz`) : '—',
};

export function initStarColliderPage(doc = document) {
    const $ = (sel) => doc.querySelector(sel);
    const readouts = new Map();
    for (const el of doc.querySelectorAll('[data-sc]')) readouts.set(el.getAttribute('data-sc'), el);
    const controls = new Map();
    for (const el of doc.querySelectorAll('[data-sc-control]')) controls.set(el.getAttribute('data-sc-control'), el);
    const charts = new Map();
    for (const el of doc.querySelectorAll('[data-sc-chart]')) charts.set(el.getAttribute('data-sc-chart'), el);
    const set = (key, value) => { const el = readouts.get(key); if (el) el.textContent = value; };
    const ctl = (key) => controls.get(key);
    const val = (key) => { const el = ctl(key); return el ? (el.type === 'checkbox' ? el.checked : el.value) : null; };
    const num = (key, fallback = 0) => { const v = parseFloat(val(key)); return Number.isFinite(v) ? v : fallback; };

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
            status: 'idle', engine: 'loading', n: 0, frames: 0, diag: null, bodies: null, gw: [], energy: [],
            codePerKm: 1 / GEOM_KM, e0: null, merged: false, builtAt: 0, perf: null,
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
        const ec = charts.get('energy');
        if (ec) drawEnergy(ec, state.sim.energy);
    }
    function drawWaveformChart() {
        const wf = charts.get('waveform'); const d = state.derived;
        if (!wf || !d) return;
        const s = state.sim;
        if (s.gw.length > 50) {
            const D = state.distanceMpc * MPC_GEOM;
            const sph = s.gw.map(g => ({ t: g.t * GEOM_S, hp: g.hp / D }));
            drawWaveform(wf, { tail: null, sph, label: `SPH quadrupole strain at ${fmt.sig(state.distanceMpc, 3)} Mpc (face-on)` });
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
        delete custom.mass?.value;
        state.bodies[i] = { source: 'custom', custom };
        if (kind !== 'bh') state.chiOverride[i] = num(`chi${s}`, p.chi);
        state.pair = '';
    }

    const debounce = (fn, ms) => { let t = 0; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
    const recomputeSoon = debounce(recompute, 120);

    ctl('bodyA')?.addEventListener('change', () => { if (syncing) return; loadBody(0, val('bodyA')); });
    ctl('bodyB')?.addEventListener('change', () => { if (syncing) return; loadBody(1, val('bodyB')); });
    function loadBody(i, id) {
        if (id === 'custom') { customFromControls(i); }
        else { state.bodies[i] = { source: id, custom: null }; state.chiOverride[i] = null; }
        state.separationKm = null; state.pair = '';
        recompute();
    }
    for (const s of ['A', 'B']) {
        const i = s === 'A' ? 0 : 1;
        for (const k of ['kind', 'mass', 'radius', 'chi']) {
            ctl(`${k}${s}`)?.addEventListener('change', () => { if (syncing) return; customFromControls(i); state.separationKm = null; recompute(); });
        }
    }
    ctl('eos')?.addEventListener('change', () => { state.eos = val('eos'); state.separationKm = null; recompute(); });
    ctl('separation')?.addEventListener('input', () => { if (syncing) return; const v = num('separation', NaN); if (v > 0) { state.separationKm = v; recomputeSoon(); } });
    ctl('eccentricity')?.addEventListener('input', () => { state.eccentricity = num('eccentricity', 0); set('eccentricityOut', fmt.num(state.eccentricity, 2)); });
    ctl('distance')?.addEventListener('input', () => { if (syncing) return; const v = num('distance', NaN); if (v > 0) { state.distanceMpc = v; recomputeSoon(); } });
    ctl('pair')?.addEventListener('change', () => { if (syncing) return; loadPair(val('pair')); });
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
    ctl('autorotate')?.addEventListener('change', () => scene?.setAutoRotate(val('autorotate')));
    ctl('warp')?.addEventListener('change', () => sendWarp());
    ctl('run')?.addEventListener('click', () => buildAndRun());
    ctl('pause')?.addEventListener('click', () => { worker?.postMessage({ type: 'pause' }); state.sim.status = 'paused'; renderHud(); });
    ctl('resume')?.addEventListener('click', () => { if (state.sim.status === 'paused') { worker?.postMessage({ type: 'resume' }); state.sim.status = 'running'; renderHud(); } });
    ctl('reset')?.addEventListener('click', () => resetSim());

    // ── The SPH engine ──────────────────────────────────────────────────────
    let worker = null, scene = null;
    const stageEl = $('#sc-stage'), fallback = $('#sc-stage-fallback');
    try {
        if (stageEl) {
            import('./scene.js').then(({ createColliderScene }) => {
                scene = createColliderScene(stageEl, {});
                scene.setAutoRotate(!!val('autorotate'));
                if (fallback) fallback.hidden = true;
                if (state.sim.frame) scene.setFrame(state.sim.frame, state.sim.n, state.sim.bodies);
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
    function sendWarp() { worker?.postMessage({ type: 'warp', warp: warpValue(), dtMax: state.sim.dtMax }); }

    function buildAndRun() {
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
        const corotate = !!val('corotate');
        const omega = Math.sqrt(d.M / sepCode ** 3);
        state.sim = { ...state.sim, status: 'building', n: 0, frames: 0, diag: null, bodies: null, gw: [], energy: [], e0: null, merged: false, dtMax, builtAt: performance.now(), frame: null, perf: null };
        renderHud();
        worker.postMessage({
            type: 'setup', seed: 7,
            params: { c: 1, alpha: num('viscosity', 1), beta: 2 * num('viscosity', 1), gammaTh: num('gammaTh', 1.75), pn1: !!val('pn1'), pn25: !!val('pn25'), sinkFactor: 1.5 },
            bodies, orbit: { sep: sepCode, ecc: state.eccentricity, spinA: corotate && bodies[0].kind === 'star' ? omega : 0, spinB: corotate && bodies[1].kind === 'star' ? omega : 0, pnCirc: !!val('pn1') },
            relax: { steps: 60, dtMax: 0.5 * dtMax, damping: 0.05 },
        });
        if (scene) {
            const extent = sepCode + bodies[0].radius + bodies[1].radius;
            scene.setScale(extent / 8, sepCode / 2);
            const spacing = smallest ? smallest.radius * Math.cbrt(4 * Math.PI / 3 / nPer) : extent / 60;
            scene.setPointSize(Math.max(1.1 * spacing / (extent / 8), 0.02));
            scene.frameAll(13);
            set('stageScale', `ring = ${fmt.km(d.sepKm / 2)} · ${fmt.km(extent / 8 * GEOM_KM)} per grid unit`);
        }
    }
    function resetSim() {
        worker?.postMessage({ type: 'pause' });
        state.sim = { ...state.sim, status: 'idle', n: 0, diag: null, bodies: null, gw: [], energy: [], e0: null, merged: false, frame: null, perf: null };
        scene?.clear();
        renderHud(); drawCharts(); set('sphVsFit', sphVsFitText());
    }
    function onWorkerMessage(ev) {
        const msg = ev.data;
        if (msg.type === 'ready') { state.sim.engine = 'wasm'; renderHud(); return; }
        if (msg.type === 'error') { state.sim.status = 'error'; state.sim.error = msg.message; renderHud(); return; }
        if (msg.type === 'built') {
            state.sim.n = msg.n; state.sim.status = 'running'; state.sim.bodies = msg.bodies; state.sim.diag = msg.diag; state.sim.frame = msg.frame;
            state.sim.e0 = msg.diag.eTotal; state.sim.relaxMs = msg.relaxMs;
            scene?.setFrame(msg.frame, msg.n, bodyKinds(msg.bodies));
            worker.postMessage({ type: 'run', warp: warpValue(), budgetMs: 28, dtMax: state.sim.dtMax });
            renderHud();
            return;
        }
        if (msg.type === 'frame') {
            const s = state.sim;
            s.diag = msg.diag; s.bodies = msg.bodies; s.frames++; s.perf = msg.perf;
            if (msg.frame) { s.frame = msg.frame; scene?.setFrame(msg.frame, s.n, bodyKinds(msg.bodies)); }
            for (const g of msg.gw) s.gw.push(g);
            if (s.gw.length > 6000) s.gw = s.gw.slice(-6000);
            if (s.frames % 2 === 0) {
                s.energy.push({ t: msg.diag.time, eKin: msg.diag.eKin, eThermal: msg.diag.eThermal, ePot: msg.diag.ePot, eTotal: msg.diag.eTotal, eGw: msg.diag.eGw });
                if (s.energy.length > 1500) s.energy = s.energy.filter((_, i) => i % 2 === 0);
            }
            const [A, B] = state.profiles;
            const rsum = (A.kind === 'bh' ? 2 * A.M : A.radiusKm / GEOM_KM) + (B.kind === 'bh' ? 2 * B.M : B.radiusKm / GEOM_KM);
            if (!s.merged && msg.diag.separation < 0.5 * rsum) s.merged = true;
            if (A.kind === 'bh' && B.kind === 'bh' && msg.diag.separation < rsum && s.status === 'running') {
                s.status = 'merged'; worker.postMessage({ type: 'pause' });
            }
            renderHud();
            if (s.frames % 6 === 0) { drawWaveformChart(); const ec = charts.get('energy'); if (ec) drawEnergy(ec, s.energy); set('sphVsFit', sphVsFitText()); }
        }
    }
    const bodyKinds = (bodies) => bodies.map((b, i) => ({ ...b, kind: state.profiles[i].kind === 'bh' ? 'bh' : 'star' }));

    function renderHud() {
        const s = state.sim, d = s.diag;
        set('simEngine', { loading: 'loading kernel…', wasm: 'WASM · Rust SPH kernel', unavailable: 'unavailable — analytic engine only' }[s.engine] || s.engine);
        set('simStatus', { idle: 'idle — Build & run to start', building: `building ${parseInt(val('particles'), 10) || 600} particles per star + relaxing…`, running: s.merged ? 'running · merged' : 'running · inspiral', paused: 'paused', merged: 'merged — horizons touching; see the aftermath fits', error: `error: ${s.error || ''}` }[s.status] || s.status);
        if (!d) { for (const k of ['simTime', 'simSep', 'simFreq', 'simN', 'simSteps', 'simRate', 'simUnbound', 'simAccreted', 'simRhoMax', 'simHeat', 'simEgw', 'simDrift', 'simPn']) set(k, '—'); return; }
        set('simTime', `${(d.time * GEOM_S * 1e3).toFixed(3)} ms`);
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
    renderHud();
    window.addEventListener('resize', debounce(drawCharts, 150));

    // Test hook
    window.__starCollider = {
        state, recompute, buildAndRun, resetSim, loadPair,
        get scene() { return scene; }, get worker() { return worker; },
    };
    return window.__starCollider;
}
