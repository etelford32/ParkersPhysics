/**
 * sgp4-vallado.mjs — the COMMITTED SGP4 WASM against Vallado's vectors.
 * ═══════════════════════════════════════════════════════════════════════════
 * `cargo test` in rust-sgp4/ pins the Rust source; this pins the binary the
 * browser actually loads (js/sgp4-wasm/sgp4_wasm_bg.wasm), so a stale or
 * mis-built artifact fails even when the source is right.
 *
 * Until 2026-09-24 that binary was a hand-rolled SGP4 that missed Vallado
 * case 00005 by 5 260 km AT EPOCH (1.2e8 km at worst across the set) and gave
 * 47-49 minute ISS "passes"; it is now the `sgp4` crate (Vallado's reference
 * transcribed to Rust). Vectors: tests/fixtures/sgp4/SOURCES.md.
 *
 * Checks, through the real wasm-bindgen exports:
 *   · propagate_tle at EVERY published row of all 33 cases: |dr| ≤ 1 m,
 *     |dv| ≤ 1 mm/s
 *   · propagate_batch returns the same rows in one call
 *   · propagate_omm (the catalogue path, CelesTrak OMM) agrees with the TLE
 *     path on every case
 *   · 33334 t=0 is REFUSED (throws), never a silently different number — the
 *     one documented divergence from the C reference (see the Rust test)
 *
 * Run: node tests/sgp4-vallado.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const here = (p) => new URL(p, import.meta.url);
const wasm = await import('../js/sgp4-wasm/sgp4_wasm.js');
await wasm.default({ module_or_path: await readFile(here('../js/sgp4-wasm/sgp4_wasm_bg.wasm')) });

const TLE_TEXT = await readFile(here('./fixtures/sgp4/SGP4-VER.TLE'), 'utf8');
const OUT_TEXT = await readFile(here('./fixtures/sgp4/tcppver.out'), 'utf8');
const KNOWN_REFUSALS = new Set(['33334@0']);
const TOL_R_KM = 1e-3, TOL_V_KMS = 1e-6;

const lines = TLE_TEXT.split('\n').filter((l) => !l.startsWith('#'));
const tles = [];
for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].startsWith('1 ') && lines[i + 1].startsWith('2 ')) {
        tles.push([lines[i].slice(0, 69), lines[i + 1].slice(0, 69)]);
        i++;
    }
}
const cases = [];
for (const line of OUT_TEXT.split('\n')) {
    const tok = line.trim().split(/\s+/);
    if (tok.length === 2 && tok[1] === 'xx') cases.push({ norad: Number(tok[0]), rows: [] });
    else if (tok.length >= 7) cases.at(-1).rows.push(tok.slice(0, 7).map(Number));
}
assert.equal(cases.length, tles.length, 'one reference case per TLE');
assert.ok(cases.length >= 30, 'the full verification set');

// Epoch JD from the TLE's YYDDD.DDDDDDDD, for the OMM cross-check.
function epochJd(l1) {
    const yy = Number(l1.slice(18, 20));
    const year = yy < 57 ? 2000 + yy : 1900 + yy;
    const jan0 = Date.UTC(year, 0, 1) / 86400000 + 2440587.5 - 1;   // JD of "day 0"
    return jan0 + Number(l1.slice(20, 32));
}
const tleFloat = (s) => {
    const t = s.trim();
    const m = t.match(/^([+-]?)(\d+)([+-]\d)$/);
    return m ? Number(`${m[1]}0.${m[2]}e${m[3]}`) : Number(t);
};

let rows = 0, worstR = 0, worstV = 0;
const failures = [];
const err = (s, r) => [
    Math.hypot(s[0] - r[1], s[1] - r[2], s[2] - r[3]),
    Math.hypot(s[3] - r[4], s[4] - r[5], s[5] - r[6]),
];

for (let k = 0; k < cases.length; k++) {
    const { norad, rows: ref } = cases[k];
    const [l1, l2] = tles[k];
    assert.equal(Number(l1.slice(2, 7)), norad, 'cases stay aligned');
    const checked = [];
    for (const r of ref) {
        const key = `${norad}@${r[0]}`;
        if (KNOWN_REFUSALS.has(key)) {
            let answered = true;
            try { wasm.propagate_tle(l1, l2, r[0]); } catch { answered = false; }
            if (answered) failures.push(`${key}: must be refused (non-physical elements), was answered`);
            continue;
        }
        let s;
        try { s = wasm.propagate_tle(l1, l2, r[0]); } catch (e) {
            failures.push(`${key}: threw (${e}) but the reference has a row`);
            continue;
        }
        const [dr, dv] = err(s, r);
        worstR = Math.max(worstR, dr); worstV = Math.max(worstV, dv); rows++;
        if (!(dr <= TOL_R_KM && dv <= TOL_V_KMS)) failures.push(`${key}: |dr| ${dr.toFixed(6)} km, |dv| ${dv.toExponential(3)} km/s`);
        checked.push(r);
    }
    if (!checked.length) continue;

    // Batch export: same numbers, one call. (A time the kernel cannot reach
    // comes back NaN there, and none of these can.)
    const batch = wasm.propagate_batch(l1, l2, new Float64Array(checked.map((r) => r[0])));
    const stride = batch.length / checked.length;
    assert.ok(stride >= 6 && Number.isInteger(stride), `batch stride ${stride}`);
    checked.forEach((r, i) => {
        const [dr, dv] = err(Array.from(batch.slice(i * stride, i * stride + 6)), r);
        if (!(dr <= TOL_R_KM && dv <= TOL_V_KMS)) failures.push(`${norad}@${r[0]} (batch): |dr| ${dr.toFixed(6)} km`);
    });

    // OMM path: the same elements as numbers (how CelesTrak OMM arrives).
    const omm = [
        norad, epochJd(l1), tleFloat(l1.slice(53, 61)),
        Number(l2.slice(8, 16)), Number(l2.slice(17, 25)), Number(`0.${l2.slice(26, 33).trim()}`),
        Number(l2.slice(34, 42)), Number(l2.slice(43, 51)), Number(l2.slice(52, 63)), 0,
    ];
    const t = checked.at(-1)[0];
    const viaOmm = wasm.propagate_omm(...omm, t);
    const viaTle = wasm.propagate_tle(l1, l2, t);
    const d = Math.hypot(viaOmm[0] - viaTle[0], viaOmm[1] - viaTle[1], viaOmm[2] - viaTle[2]);
    if (!(d < 1e-3)) failures.push(`${norad}@${t}: OMM path differs from TLE path by ${d.toFixed(6)} km`);
}

console.log(`  cases ${cases.length}, rows ${rows}, worst |dr| ${worstR.toExponential(3)} km, worst |dv| ${worstV.toExponential(3)} km/s`);
if (failures.length) {
    console.error(`sgp4-vallado: ${failures.length} FAILED, first 10:\n  ${failures.slice(0, 10).join('\n  ')}`);
    process.exit(1);
}
assert.ok(rows > 600, `compared ${rows} rows`);
console.log('sgp4-vallado: ALL PASS');
