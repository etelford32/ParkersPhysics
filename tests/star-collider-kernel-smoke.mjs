// star-collider-kernel-smoke.mjs — loads the COMMITTED WASM binary through the
// same kernel.js the page's worker uses and drives two short scenarios. This is
// the gate that the shipped artifact (not just the Rust source) behaves: if
// someone rebuilds the kernel and forgets to commit the wasm, or the extern-C
// surface drifts from kernel.js, this fails.
//
//   node tests/star-collider-kernel-smoke.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadKernel } from '../js/star-collider/kernel.js';

const wasmPath = fileURLToPath(new URL('../js/star-collider/wasm/star_collider_kernel.wasm', import.meta.url));

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

const kernel = await loadKernel(await readFile(wasmPath));
check('max particles ≥ 8192', kernel.maxParticles >= 8192, `${kernel.maxParticles}`);
check('diag slots = 40', kernel.diagSlots === 40, `${kernel.diagSlots}`);

// ── Scenario 1: two point black holes, 2.5PN only → Peters decay ────────────
kernel.init();
kernel.setParams({ c: 1, pn1: false, pn25: true });
kernel.setBody(0, { kind: 'bh', mass: 1.4, radius: 1 });
kernel.setBody(1, { kind: 'bh', mass: 1.4, radius: 1 });
check('BH build has no particles', kernel.build(0, 0, 1) === 0);
const a0 = 60, M = 2.8, eta = 0.25;
kernel.setOrbit(a0, 0, 0, 0, false);
const T = 2 * Math.PI * Math.sqrt(a0 ** 3 / M);
let d0 = kernel.diagnostics();
check('BH separation set', Math.abs(d0.separation - a0) < 1e-6, `${d0.separation}`);
let t0 = performance.now();
let first = 0, nf = 0, last = 0, nl = 0;
while (kernel.time() < 3 * T) {
    kernel.advance(T / 50, 100000, T / 400);
    const d = kernel.diagnostics();
    if (d.time < T) { first += d.separation; nf++; }
    if (d.time > 2 * T) { last += d.separation; nl++; }
}
const dadt = (last / nl - first / nf) / (2 * T);
const peters = -(64 / 5) * eta * M ** 3 / a0 ** 3;
check('BH orbit decays at Peters\' rate (±25 %)', Math.abs((dadt - peters) / peters) < 0.25, `${dadt.toExponential(3)} vs ${peters.toExponential(3)}`);
check('E_gw accounted > 0', kernel.diagnostics().eGw > 0, `${kernel.diagnostics().eGw.toExponential(3)}`);
console.log(`      (BH scenario ${(performance.now() - t0).toFixed(0)} ms)`);

// ── Scenario 2: two neutron stars, 200 particles each ───────────────────────
kernel.init();
kernel.setParams({ c: 1, pn25: true });
kernel.setBody(0, { kind: 'star', mass: 1.4, radius: 8, gamma: 2 });
kernel.setBody(1, { kind: 'star', mass: 1.4, radius: 8, gamma: 2 });
const n = kernel.build(200, 200, 7);
check('built ~400 particles', n >= 380 && n <= 420, `${n}`);
check('body counts', kernel.bodyCount(0) + kernel.bodyCount(1) === n);
check('body kinds', kernel.bodyKind(0) === 'star' && kernel.bodyKind(1) === 'star');
t0 = performance.now();
kernel.relax(60, 0.5, 0.05);
const relaxMs = performance.now() - t0;
kernel.setOrbit(26, 0, 0, 0, true);
const dStart = kernel.diagnostics();
check('NS separation set', Math.abs(dStart.separation - 26) < 0.5, `${dStart.separation.toFixed(3)}`);
check('polytrope K positive', kernel.bodyK(0) > 0, `${kernel.bodyK(0).toFixed(3)}`);
// At 200 particles per star the softened SPH resolves ~60 % of the exact
// central density (Plummer ε = h ≈ 0.2 R); 600 gets ~80 %. The page reports
// this ratio as its resolution indicator. Here: within a factor of two.
const rhoRatio = dStart.rhoMax / (Math.PI * 1.4 / (4 * 512));
check('central density within 2× of πM/4R³ at N=200', rhoRatio > 0.5 && rhoRatio < 2, `ratio ${rhoRatio.toFixed(3)}`);
t0 = performance.now();
let steps = 0;
while (kernel.time() < 900) steps += kernel.advance(50, 100000, 1.0);
const ms = performance.now() - t0;
const dEnd = kernel.diagnostics();
check('NS pair inspirals (separation falls)', dEnd.separation < dStart.separation - 4, `${dStart.separation.toFixed(2)} → ${dEnd.separation.toFixed(2)}`);
check('all diagnostics finite', Object.values(dEnd).every(Number.isFinite));
check('shock heating recorded', dEnd.uMax > 0, `u_max ${dEnd.uMax.toExponential(2)}`);
check('GW energy > 0', dEnd.eGw > 0, `${dEnd.eGw.toExponential(3)}`);
check('quadrupole Q̈ nonzero', Math.abs(dEnd.qxx - dEnd.qyy) > 0 || Math.abs(dEnd.qxy) > 0);
// Momentum conservation (exact by construction).
const pos = kernel.pos(), vel = kernel.vel(), mass = kernel.mass(), alive = kernel.alive();
let px = 0, py = 0;
for (let i = 0; i < n; i++) if (alive[i]) { px += mass[i] * vel[3 * i]; py += mass[i] * vel[3 * i + 1]; }
check('Σ m v ≈ 0', Math.abs(px) < 1e-9 && Math.abs(py) < 1e-9, `${px.toExponential(2)}, ${py.toExponential(2)}`);
const frame = kernel.frame();
check('frame stride is 6 (x,y,z,logρ,u,flags)', kernel.frameStride === 6, `${kernel.frameStride}`);
check('frame packed × n', frame.length === n * kernel.frameStride && Number.isFinite(frame[0]) && Number.isFinite(frame[3]));
{
    let okFlags = true, seenA = false, seenB = false;
    for (let i = 0; i < n; i++) { const f = frame[i * kernel.frameStride + 5]; if (![0, 1, 2, 3].includes(f)) okFlags = false; if (f === 0 || f === 2) seenA = true; if (f === 1 || f === 3) seenB = true; }
    check('flags ∈ {0,1,2,3} and both stars present', okFlags && seenA && seenB);
    let unboundFlagged = 0; for (let i = 0; i < n; i++) if (frame[i * kernel.frameStride + 5] >= 2) unboundFlagged += mass[i];
    check('flagged unbound mass equals the M_unbound diagnostic', Math.abs(unboundFlagged - dEnd.mUnbound) < 1e-9, `${unboundFlagged.toExponential(3)} vs ${dEnd.mUnbound.toExponential(3)}`);
}
check('frame is a copy, not a view', frame.buffer !== kernel.pos().buffer);
console.log(`      (NS scenario: relax ${relaxMs.toFixed(0)} ms, ${steps} steps in ${ms.toFixed(0)} ms → ${(ms / steps).toFixed(2)} ms/step at N=${n})`);
check('body state readable', Number.isFinite(kernel.bodyState(0).pos[0]));
check('positions finite', Number.isFinite(pos[0]));

// ── Scenario 3: the rewind clock — restore + advance is bit-exact ──────────
// The page's transport bar restores a checkpoint and replays to the scrub
// point; the replayed frame must be the frame the live run produced, not a
// close one. Exact equality on the packed frame, every diagnostic slot and
// the raw positions — never a tolerance (a tolerance is how a drifting
// replay would ship unnoticed).
{
    const snap = kernel.snapshot();
    check('snapshot is a Float64Array copy of the documented length', snap instanceof Float64Array && snap.length === 32 + 64 + 17 * n && snap.buffer !== kernel.pos().buffer, `${snap.length}`);
    check('snapshotBytes matches the copy', kernel.snapshotBytes() === snap.byteLength, `${kernel.snapshotBytes()} vs ${snap.byteLength}`);
    const CH = 4, DT = 1.0;
    const stepsBefore = kernel.diagnostics().steps;
    for (let k = 0; k < 6; k++) kernel.advance(CH, 64, DT);
    const liveFrame = kernel.frame(), liveDiag = kernel.diagnostics(), livePos = Float64Array.from(kernel.pos());
    check('the live window actually stepped', liveDiag.steps > stepsBefore + 6, `${stepsBefore} → ${liveDiag.steps}`);
    check('restore accepts its own snapshot', kernel.restore(snap) === true);
    check('restored time/steps match the snapshot instant', kernel.diagnostics().steps === stepsBefore);
    for (let k = 0; k < 6; k++) kernel.advance(CH, 64, DT);
    const replayFrame = kernel.frame(), replayDiag = kernel.diagnostics(), replayPos = kernel.pos();
    let frameExact = replayFrame.length === liveFrame.length;
    for (let i = 0; i < liveFrame.length && frameExact; i++) if (!Object.is(liveFrame[i], replayFrame[i])) frameExact = false;
    check('replayed frame is bit-identical to the live frame', frameExact);
    let posExact = true;
    for (let i = 0; i < livePos.length && posExact; i++) if (!Object.is(livePos[i], replayPos[i])) posExact = false;
    check('replayed positions are bit-identical', posExact);
    const diagDiff = Object.keys(liveDiag).filter(k => !Object.is(liveDiag[k], replayDiag[k]));
    check('every diagnostic slot is bit-identical after replay', diagDiff.length === 0, diagDiff.join(',') || 'all 40');
    // Refusals leave the state alone.
    const tBefore = kernel.time();
    check('restore refuses a foreign length', kernel.restore(new Float64Array(10)) === false && kernel.time() === tBefore);
    const bad = Float64Array.from(snap); bad[1] = n + 1;
    check('restore refuses another build (n mismatch)', kernel.restore(bad) === false && kernel.time() === tBefore);
}

if (failures) { console.error(`\n❌ star-collider-kernel-smoke: ${failures} failure(s)`); process.exit(1); }
console.log('✅ star-collider-kernel-smoke: all checks passed');
