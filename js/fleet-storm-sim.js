/**
 * fleet-storm-sim.js — the interactive Storm-Season Fleet Assessment
 * simulator on sample-fleet-assessment.html (#simulate).
 *
 * A visitor builds a fleet (spacecraft class + altitude) or pastes TLEs,
 * picks a REAL historical storm, and the replay runs IN THEIR BROWSER:
 *   js/fleet-assessment.js       assessSpacecraft (the ONE kernel)
 *   js/fleet-assessment-msis.js  the ONE NRLMSISE-00 profile provider
 *   js/sgp4-wasm                 the committed NRLMSISE-00 WASM
 *   data/marketing/storm-replay-events.json  real 3-hourly Ap (baked)
 * so a simulator number and a sample-bake number for the same inputs are
 * the same number (tests/fleet-assessment.mjs pins that).
 *
 * The WASM loads LAZILY on the first Run — the page never pays for it
 * unless someone simulates. Pasted TLEs never leave the browser; only a
 * text summary is handed to request-access.html, and only on the CTA click.
 */

import {
    assessSpacecraft, ballisticFromSpacecraft, parseTleBlock, SPACECRAFT_CLASSES,
} from './fleet-assessment.js';
import { makeMsisProfileProvider } from './fleet-assessment-msis.js';
import { renderLossBars, renderApStrip, esc, kmOrM, fmtLife } from './fleet-assessment-view.js';

export const MAX_SATS = 25;
export const ALT_MIN_KM = 250;
export const ALT_MAX_KM = 800;
export const SOLAR_LEVELS = Object.freeze([
    { key: 'low',  f107: 90,  label: 'Solar minimum (F10.7 90)' },
    { key: 'mid',  f107: 150, label: 'Typical (F10.7 150)' },
    { key: 'high', f107: 200, label: 'Solar maximum (F10.7 200)' },
]);
// Same reference date as the sample bake — season/UT only.
const REF_MS = Date.parse('2026-10-15T00:00:00Z');
const BASELINE_AP = 7;
const HANDOFF_KEY = 'pp_fleet_sim_summary';

let _profilePromise = null;
function loadProfileProvider() {
    if (!_profilePromise) {
        _profilePromise = (async () => {
            const wasm = await import('./sgp4-wasm/sgp4_wasm.js');
            await wasm.default();
            return makeMsisProfileProvider(wasm, REF_MS);
        })().catch((err) => { _profilePromise = null; throw err; });
    }
    return _profilePromise;
}

/** Catalogue event → kernel event ({ key, label, series:[{tMs, ap}] }). */
export function eventSeries(ev) {
    const t0 = Date.parse(ev.startIso);
    const step = (ev.stepHours || 3) * 3600e3;
    return { key: ev.key, label: ev.label, series: ev.ap.map((ap, i) => ({ tMs: t0 + i * step, ap })) };
}

/** Builder rows → kernel spacecraft. Invalid rows are dropped with a reason. */
export function fleetFromRows(rows) {
    const sats = [], problems = [];
    rows.forEach((r, i) => {
        const c = SPACECRAFT_CLASSES[r.cls];
        const alt = Number(r.altKm);
        if (!c) { problems.push(`Row ${i + 1}: pick a spacecraft class`); return; }
        if (!(alt >= ALT_MIN_KM && alt <= ALT_MAX_KM)) { problems.push(`Row ${i + 1}: altitude must be ${ALT_MIN_KM}–${ALT_MAX_KM} km`); return; }
        sats.push({
            id: `SAT-${String(i + 1).padStart(2, '0')}`, name: null, cls: c.label,
            perigeeKm: alt, apogeeKm: alt,
            bc: ballisticFromSpacecraft(c), bcSigmaFrac: 0.25, bcSource: 'class-typical',
        });
    });
    return { sats, problems };
}

/** Run the assessment for one storm. Pure given a profile provider. */
export function runSimulation(sats, { profileFor, event, f107 }) {
    const baseline = { f107, ap: BASELINE_AP };
    return sats.map(sc => {
        const r = assessSpacecraft(sc, { profileFor, baseline, events: [eventSeries(event)] });
        return { ...r, bcSource: sc.bcSource, e: r.events[0] };
    });
}

export function mountFleetStormSim(root, { events }) {
    const $ = (sel) => root.querySelector(sel);
    const state = {
        mode: 'build',
        rows: [{ cls: '3u', altKm: 400 }, { cls: '6u', altKm: 450 }, { cls: '12u', altKm: 520 }],
        eventKey: 'gannon',
        solar: 'mid',
        last: null,
    };

    // ── storm chips + solar select ─────────────────────────────────────
    const chips = $('[data-sim="storms"]');
    chips.innerHTML = events.map(e => `
      <label class="sim-chip"><input type="radio" name="sim-storm" value="${esc(e.key)}" ${e.key === state.eventKey ? 'checked' : ''}>
        <span>${esc(e.label)} <b>${esc(e.scale)}</b></span></label>`).join('');
    chips.addEventListener('change', (ev) => { state.eventKey = ev.target.value; });
    const solar = $('[data-sim="solar"]');
    solar.innerHTML = SOLAR_LEVELS.map(s => `<option value="${s.key}" ${s.key === state.solar ? 'selected' : ''}>${esc(s.label)}</option>`).join('');
    solar.addEventListener('change', () => { state.solar = solar.value; });

    // ── mode tabs ──────────────────────────────────────────────────────
    const tabs = root.querySelectorAll('[data-sim-tab]');
    tabs.forEach(t => t.addEventListener('click', () => {
        state.mode = t.dataset.simTab;
        tabs.forEach(x => x.setAttribute('aria-selected', String(x === t)));
        $('[data-sim="build"]').hidden = state.mode !== 'build';
        $('[data-sim="paste"]').hidden = state.mode !== 'paste';
    }));

    // ── fleet builder ──────────────────────────────────────────────────
    const list = $('[data-sim="rows"]');
    const classOptions = (sel) => Object.entries(SPACECRAFT_CLASSES)
        .map(([k, c]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
    function renderRows() {
        list.innerHTML = state.rows.map((r, i) => `
          <div class="sim-row" data-i="${i}">
            <span class="sim-row-n">${i + 1}</span>
            <select aria-label="Spacecraft class, satellite ${i + 1}" data-f="cls">${classOptions(r.cls)}</select>
            <label class="sim-alt"><input type="number" inputmode="numeric" min="${ALT_MIN_KM}" max="${ALT_MAX_KM}" step="5"
              value="${esc(r.altKm)}" aria-label="Altitude in km, satellite ${i + 1}" data-f="altKm"><span>km</span></label>
            <button type="button" class="sim-x" data-f="remove" aria-label="Remove satellite ${i + 1}" ${state.rows.length <= 1 ? 'disabled' : ''}>×</button>
          </div>`).join('');
        $('[data-sim="add"]').disabled = state.rows.length >= MAX_SATS;
    }
    list.addEventListener('input', (ev) => {
        const row = ev.target.closest('.sim-row'); if (!row) return;
        const f = ev.target.dataset.f;
        if (f === 'cls' || f === 'altKm') state.rows[+row.dataset.i][f] = ev.target.value;
    });
    list.addEventListener('click', (ev) => {
        if (ev.target.dataset.f !== 'remove') return;
        state.rows.splice(+ev.target.closest('.sim-row').dataset.i, 1);
        renderRows();
    });
    $('[data-sim="add"]').addEventListener('click', () => {
        const last = state.rows[state.rows.length - 1] ?? { cls: '3u', altKm: 450 };
        state.rows.push({ cls: last.cls, altKm: Math.min(ALT_MAX_KM, Number(last.altKm) + 25) });
        renderRows();
    });
    renderRows();

    // ── TLE paste ──────────────────────────────────────────────────────
    const paste = $('[data-sim="tle"]');
    const pasteNote = $('[data-sim="tle-note"]');
    paste.addEventListener('input', () => {
        const { sats, rejected } = parseTleBlock(paste.value);
        pasteNote.textContent = paste.value.trim()
            ? `${sats.length} satellite${sats.length === 1 ? '' : 's'} read${rejected ? `, ${rejected} line${rejected === 1 ? '' : 's'} skipped` : ''}.`
            : '';
    });

    // ── run ────────────────────────────────────────────────────────────
    const status = $('[data-sim="status"]');
    const runBtn = $('[data-sim="run"]');
    const out = $('[data-sim="results"]');
    runBtn.addEventListener('click', async () => {
        let sats, problems = [];
        if (state.mode === 'paste') {
            const p = parseTleBlock(paste.value);
            sats = p.sats.map((s, i) => ({ ...s, id: s.id ?? `TLE-${i + 1}` }));
            if (!sats.length) problems.push('Paste at least one TLE (two lines starting with "1 " and "2 ").');
            sats = sats.filter(s => {
                const ok = s.perigeeKm >= 120 && s.perigeeKm <= 1400;
                if (!ok) problems.push(`${s.name ?? s.id}: perigee ${Math.round(s.perigeeKm)} km is outside the LEO drag range`);
                return ok;
            });
        } else {
            ({ sats, problems } = fleetFromRows(state.rows));
        }
        if (sats.length > MAX_SATS) { problems.push(`Up to ${MAX_SATS} satellites per run; using the first ${MAX_SATS}.`); sats = sats.slice(0, MAX_SATS); }
        status.className = 'sim-status';
        if (!sats.length) { status.classList.add('err'); status.textContent = problems.join(' '); return; }

        runBtn.disabled = true;
        status.textContent = 'Loading the NRLMSISE-00 density model…';
        let profileFor;
        try {
            profileFor = await loadProfileProvider();
        } catch (err) {
            console.warn('[fleet-storm-sim] WASM load failed:', err);
            status.classList.add('err');
            status.textContent = 'The density model failed to load. Please reload the page and try again.';
            runBtn.disabled = false;
            return;
        }
        status.textContent = `Replaying the storm on ${sats.length} satellite${sats.length === 1 ? '' : 's'}…`;
        await new Promise(r => setTimeout(r, 30));   // let the status paint
        const event = events.find(e => e.key === state.eventKey);
        const f107 = SOLAR_LEVELS.find(s => s.key === state.solar).f107;
        const t0 = performance.now();
        const results = runSimulation(sats, { profileFor, event, f107 });
        const ms = performance.now() - t0;
        state.last = { results, event, f107, mode: state.mode };
        renderResults(out, state.last);
        status.textContent = problems.length ? problems.join(' ') : `Done in ${ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`}, in your browser.`;
        runBtn.disabled = false;
        root.dispatchEvent(new CustomEvent('fleet-sim-run', { bubbles: true, detail: { n: sats.length, event: event.key, mode: state.mode } }));
    });

    // ── hand-off to request-access ─────────────────────────────────────
    $('[data-sim="cta"]').addEventListener('click', () => {
        if (!state.last) return;
        const { results, event, f107, mode } = state.last;
        const lines = results.map(r => `- ${r.name ?? r.cls ?? r.id}${r.id && /^\d+$/.test(r.id) ? ` (NORAD ${r.id})` : ''} at ${Math.round(r.perigeeKm)} km: `
            + `${kmOrM(r.e.extraLossKm)} extra loss in ${event.label}`);
        const summary = `From the fleet simulator (${mode === 'paste' ? 'pasted TLEs' : 'fleet builder'}, ${event.label}, F10.7 ${f107}):\n${lines.join('\n')}`;
        try { sessionStorage.setItem(HANDOFF_KEY, summary.slice(0, 3000)); } catch (_) { /* private mode: the link still works */ }
    });

    return { state, run: () => runBtn.click() };
}

function renderResults(out, { results, event }) {
    out.hidden = false;
    const worst = results.reduce((a, r) => r.e.extraLossKm > a.e.extraLossKm ? r : a);
    const lifeLost = Math.max(...results.map(r => r.e.lifetimeLostDays ?? 0));
    const reentered = results.filter(r => r.e.reenteredInWindow);
    out.querySelector('[data-sim="kpis"]').innerHTML = `
      <div class="sa-kpi"><b>${kmOrM(worst.e.extraLossKm)}</b><span>most extra altitude lost (${esc(worst.name ?? worst.cls)} at ${Math.round(worst.perigeeKm)} km)</span></div>
      <div class="sa-kpi"><b>×${Math.max(...results.map(r => r.e.dragRatioPeak)).toFixed(1)}</b><span>peak drag versus quiet, anywhere in your fleet</span></div>
      <div class="sa-kpi"><b>${reentered.length ? `${reentered.length} reentered` : `${lifeLost.toFixed(1)} days`}</b><span>${reentered.length ? 'during the storm window' : 'of orbital life lost, worst satellite'}</span></div>`;
    renderApStrip(out.querySelector('[data-sim="ap"]'), event);
    out.querySelector('[data-sim="ap-caption"]').textContent =
        `${event.label}: real 3-hourly Ap from ${event.startIso.slice(0, 10)}, peak Ap ${Math.max(...event.ap)}.`;
    const short = (c) => (c ?? '').replace(' CubeSat', '').replace('100 kg microsat', 'microsat').replace('250 kg smallsat', 'smallsat');
    renderLossBars(out.querySelector('[data-sim="bars"]'), results.map(r => {
        const name = r.name ?? r.cls ?? r.id;
        const [lo, hi] = r.e.extraLossBandKm;
        return {
            label: `${name.length > 22 ? name.slice(0, 21) + '…' : name} · ${Math.round(r.perigeeKm)} km`,
            shortLabel: `${(r.name ? r.name.slice(0, 10) : short(r.cls))} · ${Math.round(r.perigeeKm)}`,
            value: r.e.extraLossKm, lo, hi,
            tipHtml: `<b>${esc(name)}</b> · ${Math.round(r.perigeeKm)} km<br><span>extra loss</span> ${kmOrM(r.e.extraLossKm)} (${kmOrM(lo)}–${kmOrM(hi)})`
                + `<br><span>life lost</span> ${(r.e.lifetimeLostDays ?? 0).toFixed(1)} d · <span>peak drag</span> ×${r.e.dragRatioPeak.toFixed(1)}`,
        };
    }), { ariaLabel: `Extra altitude lost per satellite, ${event.label}` });
    const srcLabel = { 'class-typical': 'class', 'tle-bstar': 'TLE B*', default: 'default' };
    out.querySelector('[data-sim="table"]').innerHTML = `<thead><tr>
        <th>Satellite</th><th>Altitude<br>km</th><th>B, m²/kg<br><small>source</small></th><th>Quiet<br>lifetime</th>
        <th>Extra loss<br><small>range</small></th><th>Life<br>lost</th><th>Peak drag<br>× quiet</th></tr></thead><tbody>`
        + results.map(r => `<tr>
          <td class="sa-name">${esc(r.name ?? r.cls)}${r.id && /^\d+$/.test(r.id) ? ` <small>${esc(r.id)}</small>` : ''}</td>
          <td>${Math.round(r.perigeeKm)}${r.apogeeKm - r.perigeeKm > 5 ? `<small>×${Math.round(r.apogeeKm)}</small>` : ''}</td>
          <td>${r.bc.toFixed(4)} <small>${srcLabel[r.bcSource] ?? ''} ±${Math.round(r.bcSigmaFrac * 100)}%</small></td>
          <td>${fmtLife(r.quiet.lifetimeDays)}</td>
          <td>${r.e.reenteredInWindow ? '<b>reentered</b>' : `${kmOrM(r.e.extraLossKm)} <small>${kmOrM(r.e.extraLossBandKm[0])}–${kmOrM(r.e.extraLossBandKm[1])}</small>`}</td>
          <td>${r.e.lifetimeLostDays == null ? '—' : `${r.e.lifetimeLostDays.toFixed(1)} d`}</td>
          <td>×${r.e.dragRatioPeak.toFixed(1)}</td></tr>`).join('') + '</tbody>';
}
