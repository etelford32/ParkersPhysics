/**
 * tests/bz-geo.mjs — gate for the Bz engine's geosynchronous rung
 * (BZ_ENGINE_PLAN.md B3): js/bz/geo-residual.js, geo-analysis.js, api/bz/geo.js.
 *
 *   node tests/bz-geo.mjs
 *
 * The frame convention and the slots are pinned to PRODUCTION numbers
 * (2026-11-20). The ledger is tested against a planted magnetosphere whose
 * response to the arrived wind is known, with a scrambled wind as the
 * negative control.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOES_SLOTS, MEAD, GEO_DEFAULTS, GEO_RADIUS_RE, igrfEpn, meadEpn, residualSeries, scoreVariation, arrivedValue, localTimeH, xSmRe, diurnalPeakUtH } from '../js/bz/geo-residual.js';
import { analyzeGeo } from '../js/bz/geo-analysis.js';
import { analyzeFlux } from '../js/bz/flux-analysis.js';
import { normalizeL1Mag, normalizeEphem, normalizeL1Plasma, normalizeGeoMag } from '../js/bz/feeds.js';
import { boundaryModel, NOMINAL_WIND } from '../js/geomag/geospace.js';
import { rng, unitNormal, plantedField, plantedFeeds } from './helpers/bz-planted-wind.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (name) => { checks++; console.log(`  ✓ ${name}`); };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} got ${a}, want ${b} ± ${tol}`);
const D = new Date('2026-11-20T14:18:00Z');

// ── 1. the frame and the slots, against production ────────────────────────
{
    // Measured 2026-11-20 ~14:18 UT (He, Hp, Hn), nT.
    const g19 = { he: 32.56, hp: 100.43, hn: 0.36 }, g18 = { he: 14.35, hp: 91.45, hn: 14.10 };
    const i19 = igrfEpn(GOES_SLOTS['GOES-19'].lonEastDeg, D), i18 = igrfEpn(GOES_SLOTS['GOES-18'].lonEastDeg, D);
    close(i19.he, g19.he, 2.5, 'GOES-19 He'); close(i19.hn, g19.hn, 2.5, 'GOES-19 Hn');
    close(i18.he, g18.he, 2.5, 'GOES-18 He'); close(i18.hn, g18.hn, 2.5, 'GOES-18 Hn');
    // The Hp difference is the SIGNAL, and it is the size external currents make at 6.6 R_E.
    assert.ok(Math.abs(g19.hp - i19.hp) < 15 && Math.abs(g18.hp - i18.hp) < 15);
    // Negative control: the two slots swapped — He is ~18 nT wrong on both.
    assert.ok(Math.abs(i18.he - g19.he) > 12 && Math.abs(i19.he - g18.he) > 12, 'a swapped slot is exposed by He');
    // Negative control: E taken radially OUTWARD flips He's sign.
    assert.ok(Math.abs(-i19.he - g19.he) > 50, 'the earthward sign of E is confirmed by the data');
    close(Math.hypot(i19.he, i19.hp, i19.hn), 30000 / GEO_RADIUS_RE ** 3, 6, 'about a dipole at 6.6 R_E');
    ok(`EPN frame + slots reproduce production: GOES-19 He ${i19.he.toFixed(1)} vs 32.6, GOES-18 He ${i18.he.toFixed(1)} vs 14.4; swapped slots and flipped E fail`);
}

// ── 2. geometry ───────────────────────────────────────────────────────────
{
    // Local noon at 75.2°W is ~17.0 UT; in late November the equation of time is ~+14 min.
    close(localTimeH(-75.2, new Date('2026-11-20T17:00:00Z')), 12.2, 0.15, 'local time');
    close(localTimeH(-137.2, new Date('2026-11-20T21:09:00Z')), 12.2, 0.15);
    const noon = new Date('2026-11-20T17:00:00Z'), midnight = new Date('2026-11-20T05:00:00Z');
    assert.ok(xSmRe(-75.2, noon) > 6.2 && xSmRe(-75.2, noon) <= GEO_RADIUS_RE + 1e-9);
    assert.ok(xSmRe(-75.2, midnight) < -6.2);
    // Mead at r0 = 10 R_E: 25 + 2.1·x.
    const mN = meadEpn(10, -75.2, noon), mM = meadEpn(10, -75.2, midnight);
    close(mN.along, 25 + 2.1 * xSmRe(-75.2, noon), 1e-9);
    assert.ok(mN.along > 38 && mM.along < 12, `noon ${mN.along.toFixed(1)} nT, midnight ${mM.along.toFixed(1)} nT`);
    close(meadEpn(8, -75.2, noon).along, 25 * 1.25 ** 3 + 2.1 * 1.25 ** 4 * xSmRe(-75.2, noon), 1e-9, 'r0⁻³ and r0⁻⁴');
    assert.ok(mN.hp > 0.97 * mN.along && mN.hp <= mN.along, 'P is within ~10° of the dipole axis');
    assert.ok(Math.abs(mN.he) < 0.2 * mN.along && Math.abs(mN.hn) < 0.2 * mN.along);
    assert.equal(meadEpn(NaN, -75.2, noon), null);
    assert.equal(MEAD.verified, false);
    assert.equal(mN.coefficients_verified, false, 'every result says the coefficients are unverified');
    ok('local time, SM sunward coordinate and the magnetopause-current term (noon 39 nT, midnight 11 nT at r₀ = 10) — flagged unverified');
}

// ── 3. residual series and arcjets ────────────────────────────────────────
const T0 = Date.parse('2026-11-19T14:20:00Z');
{
    const ig = igrfEpn(-75.2, D);
    const samples = Array.from({ length: 300 }, (_, i) => ({ t: T0 + i * 60e3, he: ig.he + 1, hp: ig.hp - 5, hn: ig.hn + 0.5, arcjet: i >= 100 && i < 105 }));
    samples[200].hp = null;
    samples[50] = { ...samples[50], he: ig.he + 1, hp: ig.hp + 400, arcjet: false };   // a real excursion with no flag is kept
    const r = residualSeries(samples, -75.2);
    assert.equal(r.arcjet, 5);
    assert.equal(r.guarded, 2 * GEO_DEFAULTS.arcjetGuardMin, 'ten minutes either side');
    assert.equal(r.gaps, 1);
    assert.equal(r.valid, 300 - 5 - 20 - 1);
    assert.ok(r.hp[102] !== r.hp[102] && r.hp[95] !== r.hp[95] && r.hp[112] !== r.hp[112], 'flagged and guarded minutes are NaN');
    assert.ok(r.hp[89] === r.hp[89] && r.hp[115] === r.hp[115]);
    close(r.hp[10], -5, 1e-3); close(r.he[10], 1, 1e-3); close(r.hn[10], 0.5, 1e-3);   // the core field itself drifts ~1e-4 nT in a day
    close(r.hp[50], 400, 1e-3, 'an unflagged excursion is data');
    assert.ok(r.hp[200] !== r.hp[200], 'a null is a gap, not a −98 nT residual');
    assert.equal(residualSeries([], -75.2), null);
    ok('residualSeries: measured − IGRF; arcjet minutes + a 10-min guard are excluded and counted; nulls are gaps');
}

// ── 4. scoring and the arrival read ───────────────────────────────────────
{
    const R = rng(4), n = 600;
    const sig = Float64Array.from({ length: n }, (_, i) => 6 * Math.sin(i / 40));
    const obs = sig.map((x) => x - 22 + 0.5 * R.g()), pred = sig.map((x) => x + 3), flat = new Float64Array(n).fill(1);
    const s = scoreVariation(obs, pred, flat);
    assert.ok(s.skill > 0.95 && s.r > 0.98);
    close(s.offset, -25, 0.3, 'the constant the model omits is reported, not scored');
    close(s.rmse, 0.5, 0.1);
    const bad = scoreVariation(obs, sig.map((x) => -x), flat);
    assert.ok(bad.skill < -2 && bad.r < -0.9, 'an anti-correlated prediction scores below the baseline');
    assert.equal(scoreVariation(obs.subarray(0, 50), pred.subarray(0, 50), flat.subarray(0, 50)).skill, null, 'too few minutes ⇒ no score');
    const holed = Float64Array.from(obs); holed[5] = NaN;
    assert.equal(scoreVariation(holed, pred, flat).n, n - 1);
    ok('scoreVariation: scores variation, reports the unmodelled level, refuses a thin sample');

    const arr = [1000, 2000, 3000, 10000], val = [1, 2, 3, 4], c = { i: 0 };
    assert.equal(arrivedValue(arr, val, 2500, 0, 5000, c), 2);
    assert.equal(arrivedValue(arr, val, 3500, 1000, 5000, c), 2, 'the lag is subtracted');
    assert.ok(Number.isNaN(arrivedValue(arr, val, 9500, 0, 5000, c)), 'held no longer than holdMs');
    assert.ok(Number.isNaN(arrivedValue(arr, val, 500, 0, 5000, c)), 'nothing has arrived yet');
    assert.equal(arrivedValue(arr, val, 2100, 0, 5000, c), 2, 'the cursor may be asked to go back');
    assert.ok(Number.isNaN(arrivedValue([], [], 1, 0, 1)));
    ok('arrivedValue: newest arrival at or before t − lag, held briefly, never invented');

    // Diurnal peak: a series peaking at local noon of 75.2°W (17.0 UT) vs 137.2°W (21.1 UT).
    const t = Float64Array.from({ length: 1440 }, (_, i) => T0 + i * 60e3);
    const mk = (noonUt) => t.map((ms) => 10 * Math.cos(2 * Math.PI * (((ms / 3600e3) % 24) - noonUt) / 24));
    close(diurnalPeakUtH(t, mk(17.0)), 17.0, 0.6); close(diurnalPeakUtH(t, mk(21.1)), 21.1, 0.7);
    assert.equal(diurnalPeakUtH(t.subarray(0, 600), mk(17).subarray(0, 600)), null, 'needs most of a day');
    ok('diurnalPeakUtH separates GOES-East from GOES-West by local noon');
}

// ── 5. the ledger on a planted magnetosphere ──────────────────────────────
const NOW = Date.parse('2026-11-20T14:20:00Z');
function plant({ responseLagMin = 9, scramble = false, noWind = false, extraSat = false, arcjetAt = [600, 660] } = {}) {
    // A wind whose density steps up and down — the standoff moves, so the compression changes.
    const dens = (i) => (i > 500 && i < 800 ? 14 : (i > 1000 && i < 1150 ? 2 : 5));
    const f = plantedFeeds({ field: plantedField(11, 1440), normal: unitNormal(20), speedKms: 420, densityCc: dens, nowMs: NOW });
    const mag = normalizeL1Mag(f.mag, { nowMs: NOW }), ephem = normalizeEphem(f.eph, { nowMs: NOW }), plasma = normalizeL1Plasma(f.wind, { nowMs: NOW });
    const flux = analyzeFlux({ mag, ephem, plasma, nowMs: NOW });
    const w = flux._series;
    const r0 = w.arrivalMs.map((_, i) => boundaryModel({ speedKms: w.speed[i], densityCc: w.density[i], bzNt: w.bz[i] }).r0Re);
    const R = rng(21), rows = [];
    for (const [name, slot] of Object.entries(GOES_SLOTS)) {
        const cur = { i: 0 };
        for (let i = 0; i < 1438; i++) {
            const t = NOW - 120e3 - (1437 - i) * 60e3, date = new Date(t);
            const ig = igrfEpn(slot.lonEastDeg, date);
            const r = arrivedValue(w.arrivalMs, r0, t, responseLagMin * 60e3, 30 * 60e3, cur);
            const m = meadEpn(r === r ? r : boundaryModel(NOMINAL_WIND).r0Re, slot.lonEastDeg, date);
            rows.push({ time_tag: date.toISOString(), satellite: Number(name.slice(5)),
                He: ig.he + m.he + 0.3 * R.g(), Hp: ig.hp + m.hp - 24 + 0.3 * R.g(), Hn: ig.hn + m.hn + 0.3 * R.g(),
                total: 100, arcjet_flag: name === 'GOES-19' && i >= arcjetAt[0] && i < arcjetAt[1] });
        }
    }
    if (extraSat) rows.push({ time_tag: new Date(NOW - 120e3).toISOString(), satellite: 16, He: 30, Hp: 100, Hn: 0, total: 104, arcjet_flag: false });
    const geo = normalizeGeoMag(rows, { nowMs: NOW });
    let wind = noWind ? null : w;
    if (scramble) {
        // Same wind values, arrival order reversed in time: right statistics, wrong timing.
        wind = { ...w, speed: w.speed.slice().reverse(), density: w.density.slice().reverse(), bz: w.bz.slice().reverse() };
    }
    return { geo, wind, f, raw: rows };
}
{
    const { geo, wind } = plant();
    const a = analyzeGeo({ geo, wind, nowMs: NOW, minutes: 120 });
    for (const name of ['GOES-19', 'GOES-18']) {
        const s = a.satellites[name], L = s.ledger;
        assert.ok(L.vs_nominal_wind.skill > 0.6, `${name}: the arrived wind beats a nominal wind (skill ${L.vs_nominal_wind.skill})`);
        assert.ok(L.vs_nominal_wind.r > 0.9);
        close(L.unmodelled_offset_nt, -24, 1.0, `${name}: the planted ring/tail level is recovered as the unmodelled offset`);
        assert.equal(L.response.status, 'measured');
        close(L.response.lag_min, 9, 2, `${name}: the planted 9-min response lag is measured`);
        assert.equal(L.coefficients_verified, false);
        assert.ok(s.checks.he_residual_median_abs_nt < 6 && s.checks.hn_residual_median_abs_nt < 6);
        assert.equal(s.latest.kind, 'MEASURED');
        assert.equal(s.latest.predicted_hp_variation.kind, 'ESTIMATED');
        assert.equal(s.trace.hp_residual.length, 120);
        assert.equal(s.longitude_source, 'nominal operational slot');
    }
    assert.equal(a.satellites['GOES-19'].slot, 'GOES-East');
    assert.equal(a.satellites['GOES-19'].minutes.arcjet_flagged, 60);
    assert.equal(a.satellites['GOES-19'].minutes.arcjet_guard, 20);
    assert.equal(a.satellites['GOES-18'].minutes.arcjet_flagged, 0);
    assert.equal(a.mead_verified, false);
    const sk = a.satellites['GOES-18'].ledger;
    ok(`planted magnetosphere: skill vs nominal wind ${a.satellites['GOES-19'].ledger.vs_nominal_wind.skill} / ${sk.vs_nominal_wind.skill}, lag ${sk.response.lag_min} min (planted 9), offset ${sk.unmodelled_offset_nt} nT (planted −24)`);

    // Negative control: the same wind values at the wrong times do NOT earn the skill.
    const b = analyzeGeo({ ...plant({ scramble: true }), nowMs: NOW });
    for (const name of ['GOES-19', 'GOES-18']) {
        assert.ok(b.satellites[name].ledger.vs_nominal_wind.skill < 0.1, `${name}: scrambled wind skill ${b.satellites[name].ledger.vs_nominal_wind.skill}`);
        assert.notEqual(b.satellites[name].ledger.response.status, 'measured');
    }
    ok('negative control: the right wind at the wrong times earns no skill and no measured lag');

    // No wind: the measurement stands, the ledger is empty, nothing nominal is passed off as live.
    const c = analyzeGeo({ ...plant({ noWind: true }), nowMs: NOW });
    const s = c.satellites['GOES-18'];
    assert.ok(s.latest.residual_nt.hp != null);
    assert.equal(s.latest.predicted_hp_variation, null);
    assert.equal(s.ledger.vs_nominal_wind.skill, null);
    assert.equal(s.ledger.response.status, 'no_wind');

    // A satellite with no known slot gets no residual — never a guessed longitude.
    const d = analyzeGeo({ ...plant({ extraSat: true }), nowMs: NOW });
    assert.deepEqual(d.unknown_satellites, ['GOES-16']);
    assert.equal(d.satellites['GOES-16'], undefined);
    ok('no wind ⇒ measurement only; an unknown satellite gets no residual');
}

// ── 6. the route ──────────────────────────────────────────────────────────
{
    const src = readFileSync(join(ROOT, 'api', 'bz', 'geo.js'), 'utf8');
    assert.match(src, /from '\.\.\/\.\.\/js\/bz\/geo-analysis\.js'/);
    assert.ok(!/jsonError\('upstream_unavailable'/.test(src));
    const real = globalThis.fetch, realNow = Date.now;
    try {
        Date.now = () => NOW;
        const { default: handler } = await import('../api/bz/geo.js');
        const p = plant();
        const serve = (omit = []) => async (u) => {
            const s = String(u);
            if (s.includes('goes/primary') && !omit.includes('geo')) return Response.json(p.raw.filter((r) => r.satellite === 19));
            if (s.includes('goes/secondary') && !omit.includes('geo')) return Response.json(p.raw.filter((r) => r.satellite === 18));
            if (s.includes('rtsw_mag_1m') && !omit.includes('l1')) return Response.json(p.f.mag);
            if (s.includes('rtsw_wind_1m') && !omit.includes('l1')) return Response.json(p.f.wind);
            if (s.includes('ephemerides') && !omit.includes('l1')) return Response.json(p.f.eph);
            return new Response('no', { status: 404 });
        };
        globalThis.fetch = serve();
        const full = await (await handler(new Request('https://x.test/api/bz/geo?minutes=60'))).json();
        assert.equal(full.freshness, 'fresh');
        assert.equal(full.data.satellites['GOES-19'].trace.hp_residual.length, 60);
        assert.ok(full.data.satellites['GOES-18'].ledger.vs_nominal_wind.skill > 0.6);
        assert.equal(full.data.upstream.reference_spacecraft, 'SOLAR1');
        const sum = await (await handler(new Request('https://x.test/api/bz/geo?summary=1'))).json();
        assert.equal(sum.data.satellites['GOES-19'].trace, undefined);
        assert.ok(JSON.stringify(sum).length < 6000, 'the summary is readable by hand');

        globalThis.fetch = serve(['l1']);
        const noL1 = await (await handler(new Request('https://x.test/api/bz/geo?summary=1'))).json();
        assert.equal(noL1.freshness, 'stale');
        assert.deepEqual(noL1.reasons, ['l1_mag_unavailable']);
        assert.ok(noL1.data.satellites['GOES-19'].latest.residual_nt.hp != null, 'the measurement survives the L1 chain being down');
        assert.equal(noL1.data.satellites['GOES-19'].ledger.vs_nominal_wind.skill, null);

        globalThis.fetch = serve(['geo']);
        const dead = await handler(new Request('https://x.test/api/bz/geo'));
        assert.equal(dead.status, 200);
        const db = await dead.json();
        assert.equal(db.freshness, 'expired');
        assert.deepEqual(db.reasons, ['goes_mag_unavailable']);
    } finally { globalThis.fetch = real; Date.now = realNow; }
    ok('route: full + summary; L1 down ⇒ stale, measurement kept, ledger empty; GOES down ⇒ expired');
}

console.log(`\nbz-geo: ${checks} checks passed`);
