/**
 * tests/bz-l1.mjs — gate for the Bz engine's L1 rung (BZ_ENGINE_PLAN.md B1):
 * js/bz/frames.js, fuse-l1.js, spectrum.js, l1-analysis.js, api/bz/l1.js.
 *
 *   node tests/bz-l1.mjs
 *
 * The fusion is tested against a PLANTED TRUTH: one solar-wind time series
 * carried past three spacecraft as a TILTED PLANE (so each sees it at a known,
 * different time), plus independent instrument noise. Every claim has a
 * negative control that must do worse.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gseToGsmAngleRad, dipoleAxisGse, gseToGsm, gsmToGse, fitRotationAngle, positionAt, RE_KM } from '../js/bz/frames.js';
import { toGrid, pairLag, lagTrack, predictFrom, withheldScore, fuse, robustSigma, causalSigma, advectiveLagMin, latestLags, FLAG, STEP_MS } from '../js/bz/fuse-l1.js';
import { fft, welchPsd, bandPowers, compressibility, BANDS } from '../js/bz/spectrum.js';
import { analyzeL1, flagNames } from '../js/bz/l1-analysis.js';
import { normalizeL1Mag, normalizeEphem } from '../js/bz/feeds.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (name) => { checks++; console.log(`  ✓ ${name}`); };
const DEG = 180 / Math.PI;
const T0 = Date.parse('2026-11-20T00:00:00Z');

// Seeded generator (mulberry32) + Box–Muller.
function rng(seed) {
    let a = seed >>> 0;
    const u = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    return { u, g: () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()) };
}

// ── 1. frames ─────────────────────────────────────────────────────────────
{
    const d = new Date('2026-11-20T14:17:00Z');
    const mu = gseToGsmAngleRad(d);
    // PRODUCTION PIN: the feed's own (GSE, GSM) pairs at 14:16–14:17 UT that day.
    const prod = [
        { by_gse: -0.22, bz_gse: -0.29, by_gsm: -0.30, bz_gsm: -0.21 },   // SOLAR1
        { by_gse: 0.80,  bz_gse: 0.28,  by_gsm: 0.85,  bz_gsm: 0.02 },    // IMAP
        { by_gse: -0.98, bz_gse: -1.48, by_gsm: -1.37, bz_gsm: -1.10 },   // ACE
    ];
    const fit = fitRotationAngle(prod);
    assert.ok(Math.abs(fit.muRad * DEG - (-17.77)) < 0.05, `feed-implied μ ${fit.muRad * DEG}`);
    assert.ok(Math.abs(mu * DEG - fit.muRad * DEG) < 1.0, `computed μ ${(mu * DEG).toFixed(2)}° vs the feed's ${(fit.muRad * DEG).toFixed(2)}°`);
    for (const p of prod) {
        const r = gseToGsm([0, p.by_gse, p.bz_gse], mu);
        assert.ok(Math.abs(r[1] - p.by_gsm) < 0.03 && Math.abs(r[2] - p.bz_gsm) < 0.03, 'our rotation reproduces the published GSM to rounding');
    }
    // Negative control: the opposite sense misses by tens of percent.
    const wrong = gseToGsm([0, -0.98, -1.48], -mu);
    assert.ok(Math.abs(wrong[2] - (-1.10)) > 0.4, 'the wrong rotation sense is visibly wrong');
    ok(`GSE→GSM angle reproduces production (${(mu * DEG).toFixed(2)}° vs feed ${(fit.muRad * DEG).toFixed(2)}°); wrong sense fails`);

    const M = dipoleAxisGse(d);
    assert.ok(Math.abs(Math.hypot(...M) - 1) < 1e-12);
    const Mg = gseToGsm(M, mu);
    assert.ok(Math.abs(Mg[1]) < 1e-12 && Mg[2] > 0, 'the dipole axis has no GSM-y and points to +z');
    const v = [3, -2, 5], back = gsmToGse(gseToGsm(v, mu), mu);
    assert.ok(back.every((x, i) => Math.abs(x - v[i]) < 1e-12), 'round trip');
    assert.ok(Math.abs(Math.hypot(...gseToGsm(v, mu)) - Math.hypot(...v)) < 1e-12, 'a rotation preserves length');
    // μ swings daily (the 9.4° dipole offset) inside an annual envelope.
    let lo = Infinity, hi = -Infinity;
    for (let h = 0; h < 24; h++) { const m = gseToGsmAngleRad(new Date(T0 + h * 3600e3)) * DEG; lo = Math.min(lo, m); hi = Math.max(hi, m); }
    assert.ok(hi - lo > 12 && hi - lo < 25, `daily swing ${(hi - lo).toFixed(1)}°`);
    ok('dipole axis lies in the GSM x–z plane; rotation is orthogonal; daily swing is the dipole offset');

    const eph = [{ t: T0, x: 1.4e6, y: 0, z: 0 }, { t: T0 + 3600e3, x: 1.4e6 + 6371.2, y: 6371.2, z: 0 }];
    const p = positionAt(eph, T0 + 1800e3);
    assert.ok(Math.abs(p.x - (1.4e6 / RE_KM + 0.5)) < 1e-9 && Math.abs(p.y - 0.5) < 1e-9 && !p.held);
    assert.equal(positionAt(eph, T0 + 2 * 3600e3).held, true, 'past the record: held, and says so');
    assert.equal(positionAt(eph, T0 + 10 * 3600e3), null, 'far past the record: null, never a guess');
    assert.equal(positionAt([], T0), null);
    ok('positionAt: linear inside, held-and-flagged just outside, null beyond');
}

// ── 2. the planted solar wind ─────────────────────────────────────────────
// A band-limited random field f(τ); each spacecraft sees f(t − delay_sc) plus
// independent noise. Delays are those of a plane with normal n advected at v.
const V = 400;                                       // km/s
const POS = {                                         // GSE, R_E — the MEASURED 2026-11-20 geometry
    ACE:    { x: 230.25, y: 41.04,  z: 22.02 },
    IMAP:   { x: 227.66, y: -36.79, z: -5.71 },
    SOLAR1: { x: 225.01, y: -48.06, z: -18.29 },
};
function unitNormal(tiltDeg) {                        // tilted in the x–y plane
    const a = tiltDeg / DEG;
    return { x: Math.cos(a), y: Math.sin(a), z: 0 };
}
/** Minutes after the plane passes the origin-side reference that it reaches `p`. */
function arrivalMin(p, n) { return -((p.x * n.x + p.y * n.y + p.z * n.z) * RE_KM) / (V * n.x) / 60; }

function plantedField(seed, minutes) {
    const R = rng(seed);
    const N = minutes + 400;
    const mk = (corr, amp) => {
        const a = new Float64Array(N); let x = 0;
        const phi = Math.exp(-1 / corr);
        for (let i = 0; i < N; i++) { x = phi * x + Math.sqrt(1 - phi * phi) * R.g(); a[i] = amp * x; }
        return a;
    };
    return { bx: mk(40, 2), by: mk(30, 3), bz: mk(25, 4), N };
}
/** Linear read of the truth at fractional minute τ (the truth is continuous; the SPACECRAFT samples are not interpolated). */
function at(arr, tau) {
    const i = Math.floor(tau), f = tau - i;
    if (i < 0 || i + 1 >= arr.length) return NaN;
    return arr[i] * (1 - f) + arr[i + 1] * f;
}
function spacecraftSamples(field, n, minutes, { noise = 0.25, seed = 7, offsetMs = {}, gaps = {}, spikes = {} } = {}) {
    const R = rng(seed);
    const out = {};
    for (const [sc, p] of Object.entries(POS)) {
        const d = arrivalMin(p, n);
        const list = [];
        for (let i = 0; i < minutes; i++) {
            if (gaps[sc]?.(i)) continue;
            const tau = i + 200 - d;
            const bx = at(field.bx, tau) + noise * R.g(), by = at(field.by, tau) + noise * R.g();
            let bz = at(field.bz, tau) + noise * R.g();
            if (spikes[sc]?.(i)) bz += spikes[sc](i);
            list.push({ t: T0 + i * STEP_MS + (offsetMs[sc] ?? 0), bx_gsm: bx, by_gsm: by, bz_gsm: bz,
                bx_gse: bx, by_gse: by, bz_gse: bz, bt: Math.hypot(bx, by, bz) });
        }
        out[sc] = list;
    }
    return out;
}
const TILT = 35;
const NORMAL = unitNormal(TILT);
const FIELD = plantedField(11, 1440);
const TRUE_LAG = (a, b) => arrivalMin(POS[b], NORMAL) - arrivalMin(POS[a], NORMAL);   // b sees it this much later than a

// ── 3. the grid ───────────────────────────────────────────────────────────
{
    const g = toGrid({ A: [{ t: T0, bz_gsm: 1, bx_gsm: 0, by_gsm: 0 }, { t: T0 + 2 * STEP_MS, bz_gsm: null, bx_gsm: 0, by_gsm: 0 }, { t: T0 + 3 * STEP_MS, bz_gsm: 0, bx_gsm: 0, by_gsm: 0 }],
        B: [{ t: T0 + 2000, bz_gsm: 5 }, { t: T0 + STEP_MS + 3000, bz_gsm: 6 }] });
    assert.equal(g.n, 4);
    assert.deepEqual([...g.sc.A.bz].map((v) => (v !== v ? 'gap' : v)), [1, 'gap', 'gap', 0], 'a missing minute and a null are both gaps; a real 0 stays 0');
    assert.deepEqual([...g.sc.B.bz].slice(0, 2), [5, 6], 'an off-minute tag lands in its nearest minute');
    assert.ok(g.sc.B.bz[2] !== g.sc.B.bz[2]);
    assert.equal(toGrid({}).n, 0);
    ok('toGrid: one axis by instant, gaps are NaN, zero is zero');
}

// ── 4. lags ───────────────────────────────────────────────────────────────
const SAMPLES = spacecraftSamples(FIELD, NORMAL, 1440, { offsetMs: { IMAP: 2000 } });
const GRID = toGrid(SAMPLES);
const TRACK = lagTrack(GRID, { positions: POS, speedKms: V });
{
    for (const [a, b] of [['ACE', 'IMAP'], ['ACE', 'SOLAR1'], ['IMAP', 'SOLAR1']]) {
        const est = pairLag(GRID.sc[a], GRID.sc[b], 400, 1000);
        const want = TRUE_LAG(a, b);
        assert.ok(Math.abs(est.lagMin - want) < 0.6, `${a}>${b}: measured ${est.lagMin.toFixed(2)} vs planted ${want.toFixed(2)} min`);
        assert.ok(est.r > 0.95);
        const rev = pairLag(GRID.sc[b], GRID.sc[a], 400, 1000);
        assert.ok(Math.abs(rev.lagMin + est.lagMin) < 0.3, 'antisymmetric');
    }
    assert.ok(Math.abs(TRUE_LAG('ACE', 'SOLAR1')) > 15, 'the planted tilt really does separate arrivals by many minutes');
    // The flat delay (Δx / v) gets this wrong by construction — it is the baseline, not the answer.
    const flat = advectiveLagMin(POS.ACE, POS.SOLAR1, V);
    assert.ok(Math.abs(flat - TRUE_LAG('ACE', 'SOLAR1')) > 10, `flat delay ${flat.toFixed(1)} min vs true ${TRUE_LAG('ACE', 'SOLAR1').toFixed(1)}`);
    assert.ok(Math.abs(flat - (POS.ACE.x - POS.SOLAR1.x) * RE_KM / V / 60) < 1e-12);
    ok(`pairLag recovers the planted lags to < 0.6 min (ACE→SOLAR1 ${TRUE_LAG('ACE', 'SOLAR1').toFixed(1)} min; flat delay says ${flat.toFixed(1)})`);

    // Causal: an estimate at step k never sees data from step k onward.
    const cut = toGrid(Object.fromEntries(Object.entries(SAMPLES).map(([s, l]) => [s, l.filter((p) => p.t < T0 + 600 * STEP_MS)])), { t1: T0 + 1439 * STEP_MS });
    const tCut = lagTrack(cut, { positions: POS, speedKms: V });
    const k = 600 / TRACK.step;
    for (const key of Object.keys(TRACK.pairs)) {
        for (let i = 0; i <= k; i++) assert.equal(TRACK.pairs[key][i].lagMin, tCut.pairs[key][i].lagMin, `${key} step ${i} unchanged by deleting the future`);
    }
    assert.equal(TRACK.pairs['ACE>IMAP'][0].source, 'advective', 'no history yet ⇒ the flat delay, labelled');
    assert.equal(TRACK.pairs['ACE>IMAP'][20].source, 'measured');
    assert.equal(TRACK.pairs['IMAP>ACE'][20].lagMin, -TRACK.pairs['ACE>IMAP'][20].lagMin);
    ok('lagTrack is causal (deleting the future changes nothing before it) and labels its fallback');

    // Uncorrelated spacecraft: no lag is claimed.
    const junk = toGrid({ A: spacecraftSamples(plantedField(1, 600), NORMAL, 600).ACE, B: spacecraftSamples(plantedField(2, 600), NORMAL, 600).ACE });
    const tj = lagTrack(junk, { positions: { A: POS.ACE, B: POS.IMAP }, speedKms: V });
    const last = tj.pairs['A>B'].at(-1);
    assert.equal(last.source, 'advective', 'r below the floor ⇒ fall back, do not invent a lag');
    assert.ok(latestLags(tj)[0].measured_fraction < 0.2);
    ok('two unrelated series: the lag falls back to the flat delay instead of fitting noise');
}

// ── 5. the withheld-spacecraft score ──────────────────────────────────────
{
    const sc = withheldScore(GRID, TRACK);
    for (const s of Object.keys(POS)) {
        assert.ok(sc[s].n > 800, `${s}: scored ${sc[s].n} minutes`);
        assert.ok(sc[s].skill > 0.5, `${s}: lag alignment beats the unshifted mean (skill ${sc[s].skill.toFixed(2)})`);
        assert.ok(sc[s].rmse < sc[s].rmse_unshifted);
        assert.ok(sc[s].coverage68 > 0.55 && sc[s].coverage68 < 0.82, `${s}: 1σ covers ${(sc[s].coverage68 * 100).toFixed(0)} %`);
    }
    // ACE is the far one: with the lags it is predicted nearly to the noise floor.
    assert.ok(sc.ACE.rmse < 1.2, `ACE rmse ${sc.ACE.rmse.toFixed(2)} nT`);
    assert.ok(sc.ACE.rmse_unshifted > 2.5, `ACE unshifted ${sc.ACE.rmse_unshifted.toFixed(2)} nT — the naive mean smears the structure`);
    ok(`withheld score: ACE ${sc.ACE.rmse.toFixed(2)} nT aligned vs ${sc.ACE.rmse_unshifted.toFixed(2)} nT unshifted; 1σ coverage ${Object.values(sc).map((v) => (v.coverage68 * 100).toFixed(0) + '%').join(' / ')}`);

    // A front NORMAL to the flow: the lags are ~Δx/v ≈ 1 min, so alignment buys little — and must not HURT.
    const flatS = spacecraftSamples(FIELD, unitNormal(0), 1440);
    const gF = toGrid(flatS), tF = lagTrack(gF, { positions: POS, speedKms: V });
    const sF = withheldScore(gF, tF);
    for (const s of Object.keys(POS)) assert.ok(sF[s].rmse <= sF[s].rmse_unshifted * 1.05, `${s}: no tilt ⇒ alignment is harmless`);
    ok('untilted front: alignment neither helps much nor hurts');
}

// ── 6. fusion ─────────────────────────────────────────────────────────────
function truthAt(sc, i) { return at(FIELD.bz, i + 200 - arrivalMin(POS[sc], NORMAL)); }
function rmseVsTruth(series, sc, i0, i1, mask = null) {
    let n = 0, s = 0;
    for (let i = i0; i < i1; i++) { const v = series[i], t = truthAt(sc, i); if (v === v && t === t && (!mask || mask(i))) { n++; s += (v - t) ** 2; } }
    return { rmse: Math.sqrt(s / n), n };
}
{
    const f = fuse(GRID, TRACK, 'SOLAR1');
    const full = (i) => f.n[i] === 3;
    const fusedErr = rmseVsTruth(f.bz, 'SOLAR1', 400, 1400, full);
    const singleErr = rmseVsTruth(GRID.sc.SOLAR1.bz, 'SOLAR1', 400, 1400, full);
    assert.ok(fusedErr.n > 700);
    assert.ok(fusedErr.rmse < singleErr.rmse * 0.85, `fused ${fusedErr.rmse.toFixed(3)} nT vs the reference alone ${singleErr.rmse.toFixed(3)} nT`);
    // Negative control: the naive minute-by-minute mean of the three is far WORSE than one spacecraft.
    const naive = new Float64Array(GRID.n);
    for (let i = 0; i < GRID.n; i++) naive[i] = (GRID.sc.ACE.bz[i] + GRID.sc.IMAP.bz[i] + GRID.sc.SOLAR1.bz[i]) / 3;
    const naiveErr = rmseVsTruth(naive, 'SOLAR1', 400, 1400, full);
    assert.ok(naiveErr.rmse > 2 * singleErr.rmse, `naive mean ${naiveErr.rmse.toFixed(2)} nT — worse than using one spacecraft`);
    ok(`fused Bz beats one spacecraft (${fusedErr.rmse.toFixed(3)} vs ${singleErr.rmse.toFixed(3)} nT); the naive mean is ${naiveErr.rmse.toFixed(2)} nT`);

    // SOLAR1 sees the planted structure ~18 min LATER than ACE. In ACE's frame the
    // newest minutes have therefore not reached the other two yet.
    assert.ok(TRUE_LAG('ACE', 'SOLAR1') > 15);
    const fa = fuse(GRID, TRACK, 'ACE');
    assert.equal(fa.n[GRID.n - 1], 1, 'toward "now" a later-seeing spacecraft has no value yet, and n says so');
    assert.ok(fa.flags[GRID.n - 1] & FLAG.SINGLE);
    assert.equal(fa.n[900], 3);
    // …while in SOLAR1's frame (it sees everything last) all three reach "now".
    assert.equal(f.n[GRID.n - 1], 3);
    assert.ok(f.sigma[900] > 0 && f.sigma[900] < 1);
    ok('n falls toward now where a spacecraft has not yet seen the structure — never filled');
}
{
    // One spacecraft glitches (a 12 nT step for 20 minutes): contradicted, excluded, fused unharmed.
    const spk = spacecraftSamples(FIELD, NORMAL, 1440, { spikes: { IMAP: (i) => (i >= 900 && i < 920 ? 12 : 0) } });
    const g = toGrid(spk), t = lagTrack(g, { positions: POS, speedKms: V });
    const f = fuse(g, t, 'SOLAR1');
    const lag = Math.round(TRUE_LAG('SOLAR1', 'IMAP'));
    let flagged = 0, total = 0;
    for (let i = 900 - lag; i < 920 - lag; i++) { total++; if (f.flags[i] & FLAG.CONTRADICTED) flagged++; }
    assert.ok(flagged >= total - 2, `${flagged}/${total} glitch minutes flagged contradicted`);
    assert.ok(f.contradicted.IMAP >= 18 && f.contradicted.ACE < 5 && f.contradicted.SOLAR1 < 5, 'the right spacecraft is blamed');
    // Scored over the minutes the check caught (the window's edge minute can
    // fall either side of the rounded lag).
    const caught = (i) => !!(f.flags[i] & FLAG.CONTRADICTED);
    const during = rmseVsTruth(f.bz, 'SOLAR1', 900 - lag, 920 - lag, caught);
    assert.ok(during.rmse < 0.4, `fused stays on truth through the glitch (${during.rmse.toFixed(2)} nT)`);
    // Negative control: with exclusion off (kOutlier huge) the glitch leaks into the fused value.
    const leaky = fuse(g, t, 'SOLAR1', { kOutlier: 1e9 });
    const leak = rmseVsTruth(leaky.bz, 'SOLAR1', 900 - lag, 920 - lag, caught).rmse;
    assert.ok(leak > 5 * during.rmse, `without the check the glitch leaks in (${leak.toFixed(2)} nT)`);
    assert.deepEqual(flagNames(FLAG.CONTRADICTED | FLAG.LAG_FALLBACK), ['one_contradicted', 'lag_is_flat_delay']);
    ok(`a 12 nT single-spacecraft glitch: ${flagged}/${total} minutes flagged, IMAP blamed, fused error ${during.rmse.toFixed(2)} nT`);
}
{
    // Two spacecraft only, one glitching: DISAGREE is raised, nothing is excluded (no way to know which).
    const two = spacecraftSamples(FIELD, NORMAL, 1440, { spikes: { IMAP: (i) => (i >= 900 && i < 920 ? 12 : 0) } });
    delete two.ACE;
    const g = toGrid(two), t = lagTrack(g, { positions: POS, speedKms: V });
    const f = fuse(g, t, 'SOLAR1');
    const lag = Math.round(TRUE_LAG('SOLAR1', 'IMAP'));
    let dis = 0, sigIn = 0, sigOut = 0;
    for (let i = 900 - lag; i < 920 - lag; i++) { if (f.flags[i] & FLAG.DISAGREE) dis++; sigIn += f.sigma[i]; assert.equal(f.n[i], 2); assert.ok(!(f.flags[i] & FLAG.CONTRADICTED)); }
    for (let i = 700; i < 720; i++) sigOut += f.sigma[i];
    assert.ok(dis >= 18, `${dis}/20 flagged disagree`);
    assert.ok(sigIn > 5 * sigOut, 'σ widens when the two disagree');
    ok('two spacecraft disagreeing: flagged, both kept, σ widens');

    // One spacecraft only: SINGLE, and σ is not invented.
    const one = { SOLAR1: SAMPLES.SOLAR1 };
    const g1 = toGrid(one), t1 = lagTrack(g1, {});
    const f1 = fuse(g1, t1, 'SOLAR1');
    assert.ok(f1.flags[500] & FLAG.SINGLE);
    assert.equal(f1.bz[500], g1.sc.SOLAR1.bz[500], 'one spacecraft passes through unchanged');
    assert.ok(f1.sigma[500] !== f1.sigma[500], 'no second instrument ⇒ no σ claimed');
    ok('one spacecraft: passes through, flagged single, σ withheld');
}
{
    // Gaps: a spacecraft that drops out is simply absent; the fused value continues on the others.
    const gap = spacecraftSamples(FIELD, NORMAL, 1440, { gaps: { SOLAR1: (i) => i >= 1000 && i < 1060 } });
    const g = toGrid(gap), t = lagTrack(g, { positions: POS, speedKms: V });
    const f = fuse(g, t, 'SOLAR1');
    assert.ok(g.sc.SOLAR1.bz[1030] !== g.sc.SOLAR1.bz[1030]);
    assert.equal(f.n[1030], 2);
    assert.ok(Math.abs(f.bz[1030] - truthAt('SOLAR1', 1030)) < 1.2, 'the others carry the reference frame through its own gap');
    assert.ok(robustSigma([1, 2, 3]) !== robustSigma([1, 2, 3]), 'too few values ⇒ NaN, not a number');
    const cs = causalSigma(Float64Array.from({ length: 200 }, (_, i) => (i % 2 ? 1 : -1)), 100, 0.1, 30);
    assert.ok(cs[0] !== cs[0] && cs[100] > 0, 'σ is undefined until residuals exist');
    ok('a dropout in the reference spacecraft is bridged by the others, not interpolated');
}

// ── 7. spectrum ───────────────────────────────────────────────────────────
{
    const re = new Float64Array(8), im = new Float64Array(8);
    for (let i = 0; i < 8; i++) re[i] = Math.cos(2 * Math.PI * i / 8);
    fft(re, im);
    assert.ok(Math.abs(re[1] - 4) < 1e-12 && Math.abs(re[7] - 4) < 1e-12 && Math.abs(re[0]) < 1e-12);
    assert.throws(() => fft(new Float64Array(6), new Float64Array(6)), /power of two/);

    const R = rng(3), N = 8192, white = new Float64Array(N);
    for (let i = 0; i < N; i++) white[i] = 2 * R.g();
    const p = welchPsd(white, 60);
    let integral = 0;
    for (let k = 0; k < p.freq.length; k++) integral += p.psd[k] * p.df * (k === 0 || k === p.freq.length - 1 ? 0.5 : 1);
    assert.ok(Math.abs(integral - 4) < 0.25, `Parseval on white noise: ∫PSD = ${integral.toFixed(3)} nT² (variance 4)`);
    assert.ok(Math.abs(p.nyquist - 1 / 120) < 1e-12);

    // A 4 mHz tone (Pc5) of amplitude 3 nT: power 4.5 nT², in the Pc5 band and nowhere else.
    const tone = new Float64Array(N);
    for (let i = 0; i < N; i++) tone[i] = 3 * Math.sin(2 * Math.PI * 0.004 * i * 60);
    const b = bandPowers(tone, 60);
    const get = (x, id) => x.bands.find((q) => q.id === id);
    assert.ok(Math.abs(get(b, 'pc5').power - 4.5) < 0.15, `Pc5 power ${get(b, 'pc5').power.toFixed(3)} nT²`);
    assert.ok(get(b, 'meso').power < 0.02 && get(b, 'slow').power < 0.02);
    assert.equal(get(b, 'pc4').resolved, false, 'above the 1-minute Nyquist ⇒ unresolved');
    assert.equal(get(b, 'pc4').power, null, '…and null, never zero');
    // The SAME function at 1 s resolves Pc4 and Pc3.
    const fast = new Float64Array(16384);
    for (let i = 0; i < fast.length; i++) fast[i] = 2 * Math.sin(2 * Math.PI * 0.05 * i);
    const bf = bandPowers(fast, 1, { nfft: 4096 });
    assert.ok(get(bf, 'pc3').resolved && Math.abs(get(bf, 'pc3').power - 2) < 0.1, 'a 50 mHz tone lands in Pc3 at 1 s cadence');
    ok(`spectrum: Parseval holds (${integral.toFixed(2)} vs 4), a Pc5 tone lands in Pc5, unresolved bands are null`);

    // Gaps: a segment with a NaN is dropped, never patched.
    const holed = Float64Array.from(tone); holed[300] = NaN;
    const ph = welchPsd(holed, 60), pf = welchPsd(tone, 60);
    assert.equal(ph.segments, pf.segments - 2, 'the two overlapping segments containing the gap are dropped');
    assert.equal(welchPsd(new Float64Array(100).fill(NaN), 60), null);
    assert.equal(bandPowers(new Float64Array(50), 60).segments, 0, 'too short ⇒ no estimate');
    assert.equal(BANDS.length, 5);
    ok('spectrum: gapped segments are dropped; too little data gives no estimate');

    // Compressibility: a pure rotation of constant |B| is 0; a pure magnitude change is 1.
    const rot = { bx: new Float64Array(200), by: new Float64Array(200), bz: new Float64Array(200), bt: new Float64Array(200) };
    const cmp = { bx: new Float64Array(200), by: new Float64Array(200), bz: new Float64Array(200), bt: new Float64Array(200) };
    for (let i = 0; i < 200; i++) {
        rot.by[i] = 5 * Math.cos(i / 9); rot.bz[i] = 5 * Math.sin(i / 9); rot.bt[i] = 5;
        cmp.bz[i] = 5 + 2 * Math.sin(i / 9); cmp.bt[i] = cmp.bz[i];
    }
    assert.ok(compressibility(rot).c < 1e-12);
    assert.ok(Math.abs(compressibility(cmp).c - 1) < 1e-12);
    assert.equal(compressibility({ bx: new Float64Array(4), by: new Float64Array(4), bz: new Float64Array(4), bt: new Float64Array(4) }), null);
    ok('compressibility: 0 for a pure rotation, 1 for a pure magnitude change');
}

// ── 8. the assembly, through the real normalisers ─────────────────────────
function feedPayloads(nowMs) {
    const rows = [], eph = [];
    const shift = nowMs - (T0 + 1439 * STEP_MS);
    for (const [sc, list] of Object.entries(SAMPLES)) {
        for (const s of list) {
            // publish GSE as the inverse rotation of the GSM truth, as the real feed does
            const mu = gseToGsmAngleRad(new Date(s.t + shift));
            const e = gsmToGse([s.bx_gsm, s.by_gsm, s.bz_gsm], mu);
            rows.push({ time_tag: new Date(s.t + shift).toISOString().replace('Z', ''), source: sc, active: sc === 'SOLAR1',
                bx_gsm: s.bx_gsm, by_gsm: s.by_gsm, bz_gsm: s.bz_gsm, bx_gse: e[0], by_gse: e[1], bz_gse: e[2], bt: s.bt, overall_quality: 0 });
        }
        for (let h = -30; h <= 0; h++) eph.push({ time_tag: new Date(nowMs + h * 3600e3).toISOString(), source: sc,
            x_gse: POS[sc].x * RE_KM, y_gse: POS[sc].y * RE_KM, z_gse: POS[sc].z * RE_KM });
    }
    return { rows, eph };
}
{
    const now = Date.parse('2026-11-20T14:20:00Z');
    const { rows, eph } = feedPayloads(now);
    const mag = normalizeL1Mag(rows, { nowMs: now }), ephem = normalizeEphem(eph, { nowMs: now });
    const a = analyzeL1({ mag, ephem, nowMs: now, minutes: 120, speedKms: V });
    assert.equal(a.reference_spacecraft, 'SOLAR1', 'the reference is the feed\'s active spacecraft');
    assert.deepEqual(a.spacecraft.slice().sort(), ['ACE', 'IMAP', 'SOLAR1']);
    assert.equal(a.frame, 'GSM');
    assert.equal(a.latest.kind, 'MEASURED');
    assert.equal(a.latest.sigma_status, 'provisional');
    assert.equal(a.trace.bz.length, 120);
    assert.equal(a.trace.spacecraft.ACE.length, 120);
    assert.ok(Math.abs(a.frame_check.difference_deg) < 0.3, `frame check (μ moves ~0.1° across the 20-min fit window) ${a.frame_check.difference_deg}°`);
    const lag = a.lags.find((l) => l.pair.includes('ACE') && l.pair.includes('SOLAR1'));
    const sign = lag.pair[0] === 'ACE' ? 1 : -1;
    assert.ok(Math.abs(sign * lag.lag_min - TRUE_LAG('ACE', 'SOLAR1')) < 1, 'the report carries the measured lag');
    assert.equal(lag.source, 'measured');
    assert.ok(Math.abs(sign * lag.flat_delay_min - advectiveLagMin(POS.ACE, POS.SOLAR1, V)) < 0.06, '…beside the flat delay it replaces');
    assert.ok(a.withheld_score.ACE.skill_vs_unshifted > 0.5);
    assert.ok(a.flag_census.minutes > 1300 && a.flag_census.n_hist[3] > 1000);
    assert.ok(a.noise.sigma_bg_nt > 1 && a.noise.sigma_hf_nt < a.noise.sigma_bg_nt, 'flux-rope-noise.js is the noise model');
    assert.ok(a.spectrum.fused.bands.find((b) => b.id === 'pc5').resolved);
    assert.ok(a.structure.ACE.compressibility >= 0);
    assert.ok(JSON.stringify({ ...a, trace: null }).length < 9000, 'the summary is small enough to read');
    ok('analyzeL1: reference = active spacecraft, lags beside their flat delays, frame check ≈ 0°, score, spectrum, noise');

    // Negative control for the frame check: a feed that swapped its frames is caught as an angle.
    const swapped = normalizeL1Mag(rows.map((r) => ({ ...r, by_gsm: r.by_gse, bz_gsm: r.bz_gse, by_gse: r.by_gsm, bz_gse: r.bz_gsm })), { nowMs: now });
    const b = analyzeL1({ mag: swapped, ephem, nowMs: now });
    assert.ok(Math.abs(b.frame_check.difference_deg) > 20, `swapped frames show as ${b.frame_check.difference_deg}°`);
    ok('frame check: swapped GSE/GSM columns are caught as a number');

    // No ephemerides: still fuses on measured lags; the fallback delay is 0 and no positions are invented.
    const c = analyzeL1({ mag, ephem: null, nowMs: now });
    assert.deepEqual(c.positions_gse_re, {});
    assert.equal(c.lags[0].flat_delay_min, null);
    assert.ok(c.withheld_score.ACE.skill_vs_unshifted > 0.5);
    assert.equal(analyzeL1({ mag: normalizeL1Mag([], { nowMs: now }), nowMs: now }), null, 'no spacecraft ⇒ null');
    ok('no ephemerides: measured lags still work, no position is invented; no data ⇒ null');

    // ── 9. the route ──────────────────────────────────────────────────────
    const src = readFileSync(join(ROOT, 'api', 'bz', 'l1.js'), 'utf8');
    assert.match(src, /from '\.\.\/\.\.\/js\/bz\/l1-analysis\.js'/);
    assert.ok(!/jsonError\('upstream_unavailable'/.test(src), 'a dead upstream is 200 + freshness, never a 5xx');
    const real = globalThis.fetch;
    try {
        const { default: handler } = await import('../api/bz/l1.js');
        const live = feedPayloads(Date.now());
        globalThis.fetch = async (u) => String(u).includes('rtsw_mag_1m') ? Response.json(live.rows)
            : String(u).includes('ephemerides') ? Response.json(live.eph) : new Response('no', { status: 404 });
        const full = await (await handler(new Request('https://x.test/api/bz/l1?minutes=60'))).json();
        assert.equal(full.freshness, 'fresh');
        assert.equal(full.data.trace.bz.length, 60);
        assert.equal(full.data.reference_spacecraft, 'SOLAR1');
        assert.ok(full.age_seconds >= 0 && full.age_seconds < 3600);
        const sum = await (await handler(new Request('https://x.test/api/bz/l1?summary=1'))).json();
        assert.equal(sum.data.trace, undefined, 'summary=1 drops the trace');
        assert.ok(sum.data.withheld_score.ACE.n > 0);

        globalThis.fetch = async (u) => String(u).includes('rtsw_mag_1m') ? Response.json(live.rows) : new Response('no', { status: 404 });
        const noEph = await (await handler(new Request('https://x.test/api/bz/l1?summary=1'))).json();
        assert.equal(noEph.freshness, 'stale', 'ephemerides down ⇒ degraded, and it says so');
        assert.deepEqual(noEph.reasons, ['ephemerides_unavailable']);
        assert.ok(noEph.data.latest.bz_nt != null);

        globalThis.fetch = async () => new Response('<html>', { status: 403 });
        const dead = await handler(new Request('https://x.test/api/bz/l1'));
        assert.equal(dead.status, 200);
        const db = await dead.json();
        assert.equal(db.freshness, 'expired');
        assert.equal(db.data, null);
        assert.deepEqual(db.reasons, ['l1_mag_unavailable']);
    } finally { globalThis.fetch = real; }
    ok('route: full + summary; ephemerides down ⇒ stale with a reason; magnetometers down ⇒ 200 + expired');
}

console.log(`\nbz-l1: ${checks} checks passed`);
