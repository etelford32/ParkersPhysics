// tests/cme-source-prior.mjs — gates js/cme-source-prior.js.
//
// Two layers:
//   1. The pure laws (cycle table, Hale, hemispheric rule, Joy via
//      flare-geometry, the construction's algebra).
//   2. THE KERNEL CHECK: the derived (γ, H) is fed to the COMMITTED
//      flux-rope WASM and the field it produces at L1 must match what the
//      header claims — the axis along â, the leading edge along the
//      overlying field p̂. Without this the sign conventions (ê_E = west,
//      t̂(π) = −ê_p) would be a remembered fact; here they are measured.
//
//   node tests/cme-source-prior.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
    solarCycleAt, leadingPolarity, hemisphericHandedness, ropeOrientation,
    sourceRopePrior, applySourcePriors, P_FLIP_HEMISPHERIC,
} from '../js/cme-source-prior.js';
import { donkiToTrainPreset } from '../js/flux-rope-live.js';
import { loadFluxRopeKernel } from '../js/flux-rope-kernel.js';
import { computeFluxRopeForecast } from '../js/flux-rope-forecast.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── 1. Laws ──────────────────────────────────────────────────────────────────
check('cycle 24 in 2014', solarCycleAt(Date.UTC(2014, 0, 1)) === 24);
check('cycle 25 in 2026', solarCycleAt(Date.UTC(2026, 9, 14)) === 25);
check('cycle unknown before table', solarCycleAt(Date.UTC(1990, 0, 1)) === null);
check('cycle unknown far past last onset', solarCycleAt(Date.UTC(2040, 0, 1)) === null);
check('Hale: cycle 25 north leads +', leadingPolarity(15, 25) === 1);
check('Hale: cycle 25 south leads −', leadingPolarity(-15, 25) === -1);
check('Hale: cycle 24 north leads −', leadingPolarity(15, 24) === -1);
check('Hale: equator refuses', leadingPolarity(0, 25) === null);
check('helicity: north left-handed', hemisphericHandedness(10) === -1);
check('helicity: south right-handed', hemisphericHandedness(-10) === 1);

for (const lat of [-30, -12, 8, 25]) {
    for (const leading of [1, -1]) {
        for (const handedness of [1, -1]) {
            const o = ropeOrientation(lat, { leading, handedness });
            const [pw, pn] = o.overlying, [aw, an] = o.axial;
            check(`unit, orthogonal (lat ${lat}, L ${leading}, H ${handedness})`,
                close(Math.hypot(pw, pn), 1) && close(Math.hypot(aw, an), 1)
                && close(pw * aw + pn * an, 0));
            // γ reproduces â through the kernel convention t̂(π) = −ê_p.
            const g = o.tiltDeg * Math.PI / 180;
            check(`γ realises â (lat ${lat}, L ${leading}, H ${handedness})`,
                close(-Math.cos(g), aw, 1e-12) && close(-Math.sin(g), an, 1e-12));
        }
    }
}
// Joy: low tilt ⇒ overlying field ≈ east–west ⇒ axis ≈ north–south.
{
    const o = ropeOrientation(10, { leading: 1, handedness: -1 });
    check('low-latitude AR ⇒ high-inclination rope', Math.abs(o.axial[1]) > 0.98,
        `â_N ${o.axial[1].toFixed(3)}`);
}

const NOW = Date.UTC(2026, 9, 14);
const pN = sourceRopePrior({ sourceLocation: 'N18W05', atMs: NOW });
const pS = sourceRopePrior({ sourceLocation: 'S14E10 (AR 14321)', atMs: NOW });
check('prior ok (north)', pN.ok && pN.handedness === -1 && pN.pFlip === P_FLIP_HEMISPHERIC);
check('prior ok (south)', pS.ok && pS.handedness === 1);
check('no location ⇒ refuse', sourceRopePrior({ atMs: NOW }).reason === 'no-source-location');
check('equator ⇒ refuse', sourceRopePrior({ latDeg: 0, atMs: NOW }).reason === 'equatorial-source');
check('unknown cycle ⇒ refuse', sourceRopePrior({ latDeg: 10, atMs: Date.UTC(2045, 0, 1) }).reason === 'cycle-unknown');

// applySourcePriors: a mixed train keeps the wide pFlip; all-sourced narrows.
{
    const cmes = [
        { id: 'a', timeIso: '2026-10-10T00:00:00Z', speedKms: 900, latDeg: 0, lonDeg: 0, halfAngleDeg: 40, earthDirected: true },
        { id: 'b', timeIso: '2026-10-10T08:00:00Z', speedKms: 1100, latDeg: 5, lonDeg: 5, halfAngleDeg: 40, earthDirected: true },
    ];
    const base = donkiToTrainPreset(cmes);
    const mixed = applySourcePriors(base, [pN, null]);
    check('mixed train: one rope sourced', mixed.applied === 1
        && mixed.preset.ropes[0].tiltDeg === pN.tiltDeg && mixed.preset.ropes[1].tiltDeg === base.ropes[1].tiltDeg);
    check('mixed train keeps pFlip 0.5', mixed.preset.spreads.pFlip === 0.5);
    const all = applySourcePriors(base, [pN, pS]);
    check('all-sourced train narrows pFlip', all.preset.spreads.pFlip === P_FLIP_HEMISPHERIC);
    check('input preset not mutated', base.ropes[0].tiltDeg === 0 && base.spreads.pFlip === 0.5);
}

// ── 2. Kernel check ──────────────────────────────────────────────────────────
// Head-on rope (Earth at 0,0), sheath off, from each hemisphere. In GSE:
// Bz = +B·ê_N, By = −B·ê_E (spec §2) and ê_E = local west Ŵ.
const wasmPath = fileURLToPath(new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url));
const k = await loadFluxRopeKernel(await readFile(wasmPath));
for (const [label, p] of [['north', pN], ['south', pS]]) {
    const o = ropeOrientation(p.basis.sourceLatDeg,
        { leading: p.basis.leadingPolarity, handedness: p.handedness });
    k.setRope({ tiltDeg: p.tiltDeg, handedness: p.handedness, v0Kms: 900, lonDeg: 0, latDeg: 0 });
    const s = k.series(0, 600, 1400);
    const inside = [];
    for (let i = 0; i < s.inside.length; i++) if (s.inside[i] > 0) inside.push(i);
    check(`${label}: rope crosses L1`, inside.length > 20, `${inside.length} samples`);
    // Axis: closest approach ≈ the middle of the crossing ⇒ field ∥ â.
    const mid = inside[Math.floor(inside.length / 2)];
    const bMid = Math.hypot(s.by[mid], s.bz[mid]);
    const axN = s.bz[mid] / bMid, axW = -s.by[mid] / bMid;
    check(`${label}: mid-crossing field ∥ axial â`,
        axN * o.axial[1] + axW * o.axial[0] > 0.9,
        `kernel (W,N)=(${axW.toFixed(2)},${axN.toFixed(2)}) vs â (${o.axial[0].toFixed(2)},${o.axial[1].toFixed(2)})`);
    // Leading edge: first inside sample ⇒ field leans toward p̂.
    const f = inside[0];
    const bF = Math.hypot(s.by[f], s.bz[f]);
    const lpN = s.bz[f] / bF, lpW = -s.by[f] / bF;
    check(`${label}: leading edge leans along overlying p̂`,
        lpN * o.overlying[1] + lpW * o.overlying[0] > 0.3,
        `cos ${(lpN * o.overlying[1] + lpW * o.overlying[0]).toFixed(2)}`);
}

// ── 3. Provider opt-in ───────────────────────────────────────────────────────
// Default path (flux-rope-v1) must be untouched; opt-in moves the rope and the
// fan; a CME with no associated flare keeps the cone-fit defaults.
{
    const wasm = await readFile(wasmPath);
    const LAUNCH = '2026-10-12T06:00:00Z';
    const cme = { id: 'fx', timeIso: LAUNCH, speedKms: 1100, latDeg: 0, lonDeg: 0,
        halfAngleDeg: 45, earthDirected: true };
    const flares = [{ flrID: 'f1', classType: 'X1.2', peakMs: Date.parse(LAUNCH) - 3600e3,
        beginMs: null, sourceLocation: 'S16W08', activeRegionNum: 14321 }];
    const nowMs = Date.parse(LAUNCH) + 6 * 3600e3;
    const base = await computeFluxRopeForecast({ sources: { cmes: [cme], rtsw: null, wasm, flares }, nowMs });
    const src = await computeFluxRopeForecast({ sources: { cmes: [cme], rtsw: null, wasm, flares }, nowMs, sourcePrior: true });
    const none = await computeFluxRopeForecast({ sources: { cmes: [cme], rtsw: null, wasm, flares: [] }, nowMs, sourcePrior: true });
    check('default: no priors, cone defaults', base.sourcePriors === null
        && base.preset.ropes[0].tiltDeg === 0 && base.preset.spreads.pFlip === 0.5);
    check('opt-in: rope takes the source prior', src.sourcePriors[0].ok
        && src.preset.ropes[0].tiltDeg === src.sourcePriors[0].tiltDeg
        && src.preset.ropes[0].handedness === 1 && src.preset.spreads.pFlip === P_FLIP_HEMISPHERIC,
        `γ ${src.preset.ropes[0].tiltDeg}°`);
    check('opt-in: fan differs from v1', src.summary.minBzP50 !== base.summary.minBzP50,
        `min Bz p50 ${base.summary.minBzP50?.toFixed?.(1)} → ${src.summary.minBzP50?.toFixed?.(1)} nT`);
    check('opt-in without a flare ⇒ cone defaults', none.sourcePriors[0].ok === false
        && none.sourcePriors[0].reason === 'no-associated-flare'
        && none.preset.ropes[0].tiltDeg === 0 && none.summary.minBzP50 === base.summary.minBzP50);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\ncme-source-prior: all checks passed');
