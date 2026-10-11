// flux-rope-ledger-real.mjs — the flux-rope-v1 validation loop run on REAL
// data: the production ledger's own locked forecasts (Aug 26 – Sep 16 2026)
// scored against REAL L1 truth (NOAA SWPC RTSW 1-min, as archived in
// sw_geomag_dataset). Pure node, no network:
//
//   node tests/flux-rope-ledger-real.mjs
//
// Every other flux-rope gate runs on synthetic or hand-fit hindcast inputs.
// This one replays what the daily cron actually locked and checks what the
// scoring pipeline does with the storms that actually happened. It pins
// three production bugs found 2026-10-11 (each with a NEGATIVE CONTROL that
// reproduces the old behaviour and must still look wrong), plus the skill
// numbers themselves, so any change to the scoring rules shows up as a
// visible diff in the numbers instead of a silent shift:
//
//   1. Bz truth never resolved — the cron read 48 h of 1-min rows in ONE
//      PostgREST request, which Supabase caps at 1000 rows (~16.7 h), so
//      coverage sat at ~35% < 60% and every arrival stayed 'pending'.
//   2. Leakage — scoring took the LATEST lock, which on 4 of 8 arrived
//      events was issued AFTER the observed shock (the provider had
//      already assimilated it), and 7 locks were postdictions (predicted
//      arrival before issue time). selectScorableLock is the fix.
//   3. The drag inversion refused 8/8 real events (downstream plasma speed
//      ≠ shock speed); the transit-only fallback against the MEASURED
//      upstream wind is the fix.
//
// Fixture integrity: tests/fixtures/flux-rope-ledger-2026-09.json carries
// md5 digests computed SERVER-SIDE in Postgres; they are recomputed here.

import fs from 'node:fs';
import crypto from 'node:crypto';
import {
    ropeArrivalWindow, resolveBzTruth, scoreFluxRopeEvent, aggregateFluxRopeScores,
    selectScorableLock, filterLockableRows, pairedArrivalSkill, FLUX_ROPE_MODEL_ID,
} from '../js/flux-rope-validation.js';
import { retrievedPopulation } from '../js/flux-rope-inversion.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const near = (a, b, tol) => Number.isFinite(a) && Math.abs(a - b) <= tol;
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const fx = JSON.parse(fs.readFileSync(
    new URL('./fixtures/flux-rope-ledger-2026-09.json', import.meta.url), 'utf8'));

// ── 0. Integrity: the committed data IS production's ─────────────────────────
for (const w of fx.bz.windows) {
    check(`fixture: Bz window ${w.name} matches the server-side md5`,
        md5(w.code) === w.md5 && w.code.length === 2 * w.n, `${w.n} min`);
}
{
    const canon = fx.locks.map((f) => [
        f.event_id, Date.parse(f.issued_at), Date.parse(f.predicted_arrival_utc),
        f.inputs.v0_kms, f.inputs.w_eff_kms, Math.round(f.inputs.gamma_eff_per_km * 1e10),
        f.inputs.launch, f.inputs.epoch, f.inputs.p_hit,
    ].join('|')).join('\n');
    check('fixture: 30 flux-rope locks match the server-side digest',
        fx.locks.length === 30 && md5(canon) === fx.locks_md5);
}

// Decode the minute series (2 base64url chars / minute, code 4095 = gap).
const AL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const rows = [];
for (const w of fx.bz.windows) {
    const t0 = Date.parse(w.startIso);
    for (let i = 0; i < w.n; i++) {
        const c = AL.indexOf(w.code[2 * i]) * 64 + AL.indexOf(w.code[2 * i + 1]);
        rows.push({ tMs: t0 + i * w.stepS * 1000, bz: c === 4095 ? NaN : (c - 2048) / 10, v: NaN });
    }
}
const byT = new Map(rows.map((r) => [r.tMs, r]));
for (const [iso, vs] of Object.entries(fx.vFirstHour)) {
    if (iso === 'note') continue;
    vs.forEach((v, i) => {
        const r = byT.get(Date.parse(iso) + i * 60e3);
        if (r && v != null) r.v = v;
    });
}
const isoKey = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');

// ── 1. Bz-structure truth on the real minute data ────────────────────────────
const EXPECT = {   // shock → [min Bz nT, first-hour median v km/s] (real L1)
    '2026-09-09T04:30:00Z': [-6.8, 420],
    '2026-09-15T18:30:00Z': [-12.8, 704],
    '2026-09-16T00:15:00Z': [-5.9, 541],
    '2026-09-16T11:00:00Z': [-4.9, 537],
    '2026-09-17T01:30:00Z': [-4.9, 549],
};
const truthByShock = new Map();
for (const [iso, [bz, v]] of Object.entries(EXPECT)) {
    const shockMs = Date.parse(iso);
    const full = resolveBzTruth({ rows, shockMs });
    check(`truth ${iso}: resolves on the full 48 h window`,
        full.status === 'resolved' && full.minBzNt === bz && full.vAtShockKms === v
        && full.coverage >= 0.92,
        `min Bz ${full.minBzNt} nT, v ${full.vAtShockKms} km/s, coverage ${full.coverage?.toFixed(3)}`);
    // NEGATIVE CONTROL (bug 1): what one capped PostgREST page returned.
    const capped = resolveBzTruth({
        rows: rows.filter((r) => r.tMs >= shockMs - 60e3).slice(0, 1000), shockMs });
    check(`truth ${iso}: a 1000-row page (the old fetch) stays pending`,
        capped.status === 'pending' && capped.coverage < 0.36,
        `coverage ${capped.coverage?.toFixed(3)}`);
    truthByShock.set(iso, {
        minBzNt: full.minBzNt, vAtShockKms: full.vAtShockKms,
        upstreamVKms: fx.upstreamV6h[iso],
    });
}
const truth = new Map();
for (const o of fx.observations) {
    const shockMs = o.shock_arrival_utc ? Date.parse(o.shock_arrival_utc) : NaN;
    truth.set(o.event_id, {
        arrived: o.arrived === true, shockMs,
        ...(o.arrived ? truthByShock.get(isoKey(shockMs)) : {}),
    });
}
check('truth: 8 arrived + 7 false alarms on the ledger',
    [...truth.values()].filter((t) => t.arrived).length === 8
    && [...truth.values()].filter((t) => !t.arrived).length === 7);

// ── 2. Replay: every lock is reproducible from its frozen inputs ─────────────
{
    let worstMin = 0, worstWinMin = 0;
    for (const l of fx.locks) {
        const i = l.inputs, ep = Date.parse(i.epoch);
        const w = ropeArrivalWindow({
            launchOffsetS: (Date.parse(i.launch) - ep) / 1000, v0Kms: i.v0_kms,
            wEffKms: i.w_eff_kms, gammaEffPerKm: i.gamma_eff_per_km, sigV0Kms: i.sig_v0_kms,
        });
        worstMin = Math.max(worstMin,
            Math.abs(ep + w.arrivalS * 1e3 - Date.parse(l.predicted_arrival_utc)) / 60e3);
        worstWinMin = Math.max(worstWinMin,
            Math.abs(ep + w.earlyS * 1e3 - Date.parse(l.arrival_window_early)) / 60e3,
            Math.abs(ep + w.lateS * 1e3 - Date.parse(l.arrival_window_late)) / 60e3);
    }
    // The residual is w_eff being frozen ROUNDED to 1 km/s; minutes, not hours.
    check('replay: all 30 locked arrivals reproduce from frozen inputs',
        worstMin < 3, `worst ${worstMin.toFixed(2)} min`);
    check('replay: all 30 locked ±σ_v0 windows reproduce',
        worstWinMin < 10, `worst ${worstWinMin.toFixed(2)} min`);
}

// ── 3. Lock selection: leakage + postdictions (bug 2) ────────────────────────
const locksByEvent = new Map();
for (const l of fx.locks) {
    if (!locksByEvent.has(l.event_id)) locksByEvent.set(l.event_id, []);
    locksByEvent.get(l.event_id).push(l);
}
const leaked = [], honest = [], unscorable = [];
const rejected = { postdiction: 0, afterShock: 0 };
for (const [eid, ls] of locksByEvent) {
    const t = truth.get(eid);
    const latest = ls.reduce((a, b) => (Date.parse(b.issued_at) > Date.parse(a.issued_at) ? b : a));
    leaked.push(scoreFluxRopeEvent({ forecast: { ...latest, event_id: eid }, truth: t }));
    const s = selectScorableLock(ls, t);
    rejected.postdiction += s.rejected.postdiction;
    rejected.afterShock += s.rejected.afterShock;
    if (s.lock) honest.push(scoreFluxRopeEvent({ forecast: { ...s.lock, event_id: eid }, truth: t }));
    else unscorable.push(eid);
}
check('selection: 4 locks issued after the shock + 7 postdictions rejected',
    rejected.afterShock === 4 && rejected.postdiction === 7, JSON.stringify(rejected));
check('selection: the two CMEs that only had leaked locks are NOT scored',
    unscorable.length === 2 && unscorable.every((e) => e.includes('2026-09-13T')),
    unscorable.join(', '));
check('selection: every scored arrival lock was issued before its shock',
    honest.filter((s) => s.arrived).every((s) => s.leadH > 0),
    `leads ${honest.filter((s) => s.arrived).map((s) => s.leadH.toFixed(0)).join('/')} h`);

const H = aggregateFluxRopeScores(honest);
const L = aggregateFluxRopeScores(leaked);
// NEGATIVE CONTROL: the old "latest lock" rule scores leaked rows, and its
// mean lead time is ~3 h — a forecast issued at the shock is not a forecast.
check('negative control: latest-lock scoring includes leaked rows',
    L.meanLeadH < 5 && near(L.maeHours, 26.43, 0.01),
    `MAE ${L.maeHours.toFixed(2)} h at mean lead ${L.meanLeadH.toFixed(1)} h`);
check('honest skill: 6 arrivals, MAE 18.1 h, bias −17.9 h, 3/6 within ±12 h',
    H.n_forecasts === 13 && H.hits === 3
    && near(H.maeHours, 18.14, 0.01) && near(H.biasHours, -17.94, 0.01),
    `MAE ${H.maeHours.toFixed(2)} bias ${H.biasHours.toFixed(2)} hits ${H.hits}`);
check('honest skill: scored at a real lead time (~2 days)',
    near(H.meanLeadH, 51.1, 0.2), `${H.meanLeadH.toFixed(1)} h`);
check('honest skill: storm-probability Brier scores on real outcomes',
    near(H.brierHit, 0.3029, 0.001) && near(H.brier10, 0.3524, 0.001)
    && near(H.brier20, 0.0322, 0.001) && near(H.minBzMaeNt, 3.98, 0.01),
    `hit ${H.brierHit.toFixed(3)} <−10 ${H.brier10.toFixed(3)} <−20 ${H.brier20.toFixed(3)} minBz MAE ${H.minBzMaeNt.toFixed(2)} nT`);
// The §16 evidence the ledger exists to collect: followers riding a wake
// arrive EARLIER than observed, and more so with interaction ON.
check('§16 evidence: followers early, wake makes it worse (ON vs OFF)',
    near(H.compounding.followerBiasOnH, -16.26, 0.01)
    && near(H.compounding.followerBiasOffH, -13.16, 0.01)
    && H.compounding.arrivalGainH < 0,
    `follower bias ON ${H.compounding.followerBiasOnH.toFixed(1)} h / OFF ${H.compounding.followerBiasOffH.toFixed(1)} h`);

// ── 4. Drag inversion on real events (bug 3) ─────────────────────────────────
{
    const arrived = honest.filter((s) => s.arrived);
    const inv = arrived.map((s) => s.inversion);
    check('inversion: 3/6 retrieve via transit + measured upstream wind',
        H.inversions.length === 3 && H.inversions.every((r) => r.method === 'transit+upstream-w'));
    check('inversion: refusals are honest and say why',
        inv.filter((r) => !r.ok).every((r) => /reachable-band; transit-slower-than-max-drag/.test(r.reason)));
    check('inversion: real CMEs felt ~3.9× the drag the locks flew with',
        near(H.dragRatioMedian, 3.87, 0.01), `median Γ_ret/Γ_lock ${H.dragRatioMedian.toFixed(2)}`);
    // NEGATIVE CONTROL: without the upstream measurement, nothing retrieves.
    const blind = arrived.map((s) => {
        const eid = s.event_id;
        const t = { ...truth.get(eid), upstreamVKms: NaN };
        return scoreFluxRopeEvent({ forecast: { ...selectScorableLock(locksByEvent.get(eid), t).lock, event_id: eid }, truth: t });
    });
    check('negative control: two-observable inversion alone refuses every real event',
        blind.every((s) => s.inversion?.ok === false));
    check('population: still below the 5-retrieval floor (honest, not faked)',
        retrievedPopulation(H.inversions).ok === false);
}

// ── 5. Paired skill against the ledger's baselines ───────────────────────────
{
    const all = [...fx.locks.map((l) => ({ ...l, model_id: FLUX_ROPE_MODEL_ID })), ...fx.baselines];
    const P = pairedArrivalSkill(all, truth);
    const pm = P.paired.models;
    check('paired: the same 5 events scored for all four models',
        P.paired.events.length === 5 && Object.keys(pm).length === 4);
    check('paired MAE: ballistic 19.3 < flux-rope 21.7 < dbm 22.6 < enlil 30.0 h',
        near(pm['ballistic-v1'].maeH, 19.32, 0.01) && near(pm[FLUX_ROPE_MODEL_ID].maeH, 21.65, 0.01)
        && near(pm['dbm-v1'].maeH, 22.60, 0.01) && near(pm.enlil.maeH, 30.04, 0.01),
        Object.entries(pm).map(([m, s]) => `${m} ${s.maeH.toFixed(1)}`).join(', '));
    check('paired bias: every model arrives EARLY on this sample',
        Object.values(pm).every((s) => s.biasH < -15));
    check('per-model: flux-rope scores 6 arrivals (two lost to leaked-only locks)',
        P.models[FLUX_ROPE_MODEL_ID].n === 6 && P.models.enlil.n === 7);
}

// ── 6. Lock guard (the cron side of bug 2) ───────────────────────────────────
{
    const NOW = Date.parse('2026-09-16T06:30:36Z');   // the real 09-16 cron run
    const day = fx.locks.filter((l) => l.issued_at.startsWith('2026-09-16T06:30:36'));
    const resolved = new Set(fx.observations
        .filter((o) => o.arrived && Date.parse(o.shock_arrival_utc) < NOW).map((o) => o.event_id));
    const { rows: kept, dropped } = filterLockableRows(day, { nowMs: NOW, resolvedEventIds: resolved });
    check('lock guard: of the 5 rows the 09-16 run locked, only the 1 genuine forecast survives',
        day.length === 5 && kept.length === 1
        && kept[0].event_id === 'PP-RT-2026-09-14T11:08:00-CME-001'
        && dropped.resolved === 2 && dropped.postdiction === 2, JSON.stringify(dropped));
}

console.log(failures ? `\n${failures} failure(s)` : '\nall real-ledger flux-rope checks passed');
process.exit(failures ? 1 : 0);
