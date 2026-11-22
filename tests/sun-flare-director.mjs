/**
 * tests/sun-flare-director.mjs — pins js/sun-flare-director.js
 *
 *   node tests/sun-flare-director.mjs
 *
 * One event shape from every feed; west-positive; an unlocated flare is never
 * placed; the phases come out of the cooling track (not typed numbers); a
 * small flare cannot take the camera from a big one.
 */
import assert from 'node:assert/strict';
import {
    SIM_UNITS_PER_S, SIM_AGE_CAP, simAgeFor, LIVE_WINDOW_S, parseClass, normalizeFlare, flareScore, rankFlares,
    mergeFlares, shouldCutTo, channelClock, phaseAt, PHASE_LABEL, fmtElapsed, caption, trackFor,
} from '../js/sun-flare-director.js';
import { CME_ASSOCIATION, ERUPTIVE_PRIOR_MIN, CME_REPORT_LAG_S, cmeAssociation, eruptionCall, eruptionClause } from '../js/sun-flare-director.js';
import { goesFluxOf, flareDemState } from '../js/flare-dem.js';
const pick = ({ eruptive, basis }) => ({ eruptive, basis });
import { EUV_CHANNELS, channelResponseAt } from '../js/corona-volumetric.js';
import { readFileSync } from 'node:fs';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('sun-flare-director.mjs');
const NOW = Date.UTC(2026, 10, 20, 15, 0, 0);

ok('classes parse to a flux on the GOES scale', () => {
    assert.deepEqual(parseClass('X2.3'), { cls: 'X2.3', letter: 'X', flux: goesFluxOf('X2.3') });
    assert.equal(parseClass('m1').cls, 'M1');
    assert.equal(parseClass('C').flux, 1e-6);
    assert.equal(parseClass('quiet'), null);
    assert.equal(parseClass(null), null);
});

ok('DONKI, SWPC, the page list and the test hook normalise to ONE shape', () => {
    const donki = normalizeFlare({ flrID: '2026-11-20T14:02:00-FLR-001', beginTime: '2026-11-20T14:02Z', peakTime: '2026-11-20T14:11Z',
        endTime: '2026-11-20T14:25Z', classType: 'M5.2', sourceLocation: 'N14W28', activeRegionNum: 14321 }, { nowMs: NOW });
    assert.equal(donki.id, '2026-11-20T14:02:00-FLR-001');
    assert.deepEqual([donki.cls, donki.letter, donki.latDeg, donki.lonDeg, donki.region, donki.source], ['M5.2', 'M', 14, 28, '14321', 'NASA DONKI']);
    assert.equal(donki.ageS, 58 * 60);                       // age runs from ONSET, not peak
    assert.equal(donki.peakMs - donki.beginMs, 9 * 60e3);
    const swpc = normalizeFlare({ time: new Date(NOW - 600e3), cls: 'X1.0', location: 'S05E34 (AR 14101)', active_region: '14101' }, { nowMs: NOW });
    assert.deepEqual([swpc.letter, swpc.latDeg, swpc.lonDeg, swpc.source, swpc.ageS], ['X', -5, -34, 'NOAA SWPC', 600]);
    const list = normalizeFlare({ time: '2026-11-20 14:40:00', cls: 'C3.1', loc: 'N20W95', reg: '—' }, { nowMs: NOW });
    assert.equal(list.peakMs, Date.UTC(2026, 10, 20, 14, 40, 0), 'a SWPC "YYYY-MM-DD hh:mm:ss" stamp is UTC');
    assert.deepEqual([list.located, list.nearSide, list.region], [true, false, null]);
    const hook = normalizeFlare({ cls: 'X', latDeg: 14, lonDeg: 28 }, { nowMs: NOW, source: 'test' });
    assert.deepEqual([hook.located, hook.cls, hook.source, hook.ageS], [true, 'X', 'test', null]);
    assert.equal(normalizeFlare({ location: 'N10W10' }, { nowMs: NOW }), null, 'no class ⇒ no event');
});

ok('WEST IS POSITIVE, and a flare with no location is never placed', () => {
    assert.equal(normalizeFlare({ cls: 'M1', location: 'N10W30' }, {}).lonDeg, 30);
    assert.equal(normalizeFlare({ cls: 'M1', location: 'N10E30' }, {}).lonDeg, -30);
    for (const loc of [undefined, '', '—', 'unknown']) {
        const ev = normalizeFlare({ cls: 'X1', location: loc, time: NOW }, { nowMs: NOW });
        assert.deepEqual([ev.located, ev.latDeg, ev.lonDeg, ev.nearSide], [false, null, null, null], `loc=${loc}`);
        assert.equal(shouldCutTo(ev, null, NOW), false, 'an unlocated X-class still does not take the camera');
        assert.ok(caption(ev, { id: 'hot', channel: '131' }, 30).includes('location not reported'));
    }
});

ok('the ribbon-clock conversion is the page\'s one constant', () => {
    assert.equal(SIM_UNITS_PER_S, 0.35);
    assert.equal(simAgeFor(100), 35);
    assert.equal(simAgeFor(1e9), SIM_AGE_CAP);
    assert.equal(simAgeFor(-5), 0);
    const html = readFileSync(new URL('../sun.html', import.meta.url), 'utf8');
    assert.ok(!/\(ageMs \/ 1000\) \* 0\.35/.test(html), 'sun.html no longer carries its own copy of the 0.35');
});

ok('ranking: a decade of flux outweighs a couple of hours; merge keeps the located record', () => {
    const big = normalizeFlare({ cls: 'X1', location: 'N10W10', time: NOW - 2 * 3600e3 }, { nowMs: NOW });
    const small = normalizeFlare({ cls: 'M1', location: 'N10W10', time: NOW - 60e3 }, { nowMs: NOW });
    const tiny = normalizeFlare({ cls: 'C2', location: 'S10E10', time: NOW - 30e3 }, { nowMs: NOW });
    assert.deepEqual(rankFlares([tiny, small, big], NOW).map((e) => e.cls), ['X1', 'M1', 'C2']);
    assert.ok(flareScore(big, NOW) > flareScore(small, NOW));
    // The same M5.2 from SWPC (no location yet) and DONKI (located), 4 minutes apart in peak time.
    const a = normalizeFlare({ cls: 'M5.2', time: NOW - 900e3 }, { nowMs: NOW });
    const b = normalizeFlare({ flrID: 'F1', classType: 'M5.2', peakTime: new Date(NOW - 900e3 + 240e3), sourceLocation: 'N14W28' }, { nowMs: NOW });
    const m = mergeFlares([a, tiny], [b]);
    assert.equal(m.length, 2);
    const kept = m.find((e) => e.letter === 'M');
    assert.ok(kept.located && kept.lonDeg === 28 && kept.id === a.id, 'located record wins, first id is kept so it is not replayed');
});

ok('who may take the camera', () => {
    const ev = (cls, ageS, extra = {}) => normalizeFlare({ cls, location: 'N10W20', time: NOW - ageS * 1000, ...extra }, { nowMs: NOW });
    assert.equal(shouldCutTo(ev('M1', 60), null, NOW), true);
    assert.equal(shouldCutTo(ev('C9', 60), null, NOW), false, 'C-class never cuts');
    assert.equal(shouldCutTo(ev('X1', LIVE_WINDOW_S + 1), null, NOW), false, 'history is not an event');
    const x = ev('X2', 600);
    assert.equal(shouldCutTo(ev('M1', 30), x, NOW), false, 'an M1 must not cut away from an X2');
    assert.equal(shouldCutTo(ev('X9', 30), x, NOW), true);
    assert.equal(shouldCutTo(x, x, NOW), false, 'the same event is not a new one');
});

ok('phases come out of the cooling track: hot channel first, 171 arcade last, and the clock moves with the class', () => {
    const cM = channelClock(goesFluxOf('M1'), EUV_CHANNELS, channelResponseAt);
    const cX = channelClock(goesFluxOf('X5'), EUV_CHANNELS, channelResponseAt);
    for (const c of [cM, cX]) {
        assert.ok(c.hotS > 0 && c.coolS > c.hotS * 3, `hot ${c.hotS}s, cool ${c.coolS}s`);
        assert.ok(c.order.indexOf('131') < c.order.indexOf('171') && c.order.indexOf('94') < c.order.indexOf('193'));
    }
    // The clock is the TRACK's, so it moves with the class. Measured direction
    // (js/flare-dem.js: a hotter flare starts in a denser RTV loop, which
    // radiates faster): the hot phase lasts longer, the 171 arcade comes sooner.
    assert.ok(cX.hotS > cM.hotS * 2, `X5 hot ${cX.hotS}s vs M1 ${cM.hotS}s`);
    assert.ok(cX.coolS < cM.coolS && cM.coolS - cX.coolS > 60, `X5 cool ${cX.coolS}s vs M1 ${cM.coolS}s`);
    assert.ok(!('304' in cM.peaks), '304 Å is unreachable on the track and is left out, not guessed');
    const flux = goesFluxOf('M5'), clock = channelClock(flux, EUV_CHANNELS, channelResponseAt), track = trackFor({ flux });
    const at = (t) => phaseAt(t, clock, { flux, channels: EUV_CHANNELS, response: channelResponseAt, track });
    const seq = [5, clock.hotS, 0.5 * (clock.hotS + clock.coolS), clock.coolS, clock.coolS * 3].map((t) => at(t).id);
    assert.deepEqual(seq, ['impulsive', 'hot', 'cooling', 'arcade', 'faded']);
    // The channel named is the one the raymarcher's own table says is brightest at that instant.
    for (const t of [clock.hotS, clock.coolS]) {
        const st = flareDemState(flux, t, { track });
        let best = null, bv = 0;
        for (const [k, ch] of Object.entries(EUV_CHANNELS)) { const v = channelResponseAt(st.logT, ch) * st.amp; if (v > bv) { bv = v; best = k; } }
        assert.equal(at(t).channel, best);
    }
    assert.equal(at(clock.coolS).channel, '171');
    assert.ok(['131', '94'].includes(at(clock.hotS).channel));
    // Progress runs 0 → 1 inside a phase and every phase has a label.
    assert.ok(at(1).progress < 0.1 && at(clock.hotS * 0.84).progress > 0.9);
    for (const id of ['impulsive', 'hot', 'cooling', 'arcade', 'faded']) assert.ok(PHASE_LABEL[id]);
});

ok('the caption says what is known — and says REPLAY when it is one', () => {
    const ev = normalizeFlare({ flrID: 'F9', classType: 'X2.3', sourceLocation: 'N14W28', activeRegionNum: 14321, beginTime: NOW - 400e3 }, { nowMs: NOW });
    const live = caption(ev, { id: 'hot', channel: '131' }, 400);
    assert.equal(live, 'X2.3 flare · N14W28 · AR 14321 · NASA DONKI — T+6:40 · Hot loops · brightest in 131 Å (model)');
    const rep = caption(ev, { id: 'arcade', channel: '171' }, 3725, { replay: true, simSpeed: 60 });
    assert.ok(rep.startsWith('REPLAY · X2.3 flare') && rep.includes('T+1:02:05') && rep.includes('×60 time'));
    assert.ok(!caption(ev, { id: 'faded', channel: '171' }, 9000).includes('brightest'));
    assert.equal(fmtElapsed(59.6), '1:00');
    assert.equal(caption(null, { id: 'hot' }, 0), '');
});

ok('is it eruptive? a statement beats a CME report, a report beats the class prior — and a confined X flare draws no rope', () => {
    const now = Date.parse('2026-11-21T12:00:00Z');
    const ev = (raw) => normalizeFlare({ classType: 'X2.0', sourceLocation: 'N12W30', beginTime: '2026-11-21T06:00Z', ...raw }, { nowMs: now });
    // The association prior: rises with class, pinned at its table, clamped at both ends.
    for (const [f, p] of CME_ASSOCIATION) assert.ok(Math.abs(cmeAssociation(f) - p) < 1e-12);
    assert.equal(cmeAssociation(1e-8), CME_ASSOCIATION[0][1]); assert.equal(cmeAssociation(1e-2), 1);
    let prev = 0; for (let x = -7; x <= -3; x += 0.1) { const p = cmeAssociation(10 ** x); assert.ok(p >= prev - 1e-12); prev = p; }
    assert.equal(cmeAssociation(0), 0); assert.equal(cmeAssociation(NaN), 0);
    // DONKI linked a CME (either spelling of the field): eruptive, and the basis says so.
    assert.deepEqual(pick(eruptionCall(ev({ linkedEvents: [{ activityID: '2026-11-21T06:36:00-CME-001' }] }))), { eruptive: true, basis: 'cme-reported' });
    assert.deepEqual(pick(eruptionCall(ev({ linked_cme: true }))), { eruptive: true, basis: 'cme-reported' });
    // The source links CMEs, has had six hours, and linked none: CONFINED — even at X2.
    assert.deepEqual(pick(eruptionCall(ev({ linkedEvents: [{ activityID: '2026-11-21T06:10:00-SEP-001' }] }))), { eruptive: false, basis: 'no-cme-reported' });
    assert.deepEqual(pick(eruptionCall(ev({ linked_cme: false }))), { eruptive: false, basis: 'no-cme-reported' });
    // …but twenty minutes after onset its silence is not evidence yet: the class prior decides.
    const young = normalizeFlare({ classType: 'X2.0', sourceLocation: 'N12W30', beginTime: '2026-11-21T11:40Z', linked_cme: false }, { nowMs: now });
    assert.ok(young.ageS < CME_REPORT_LAG_S);
    assert.deepEqual(pick(eruptionCall(young)), { eruptive: true, basis: 'class-prior' });
    // No link field at all (SWPC's list): the prior, by class. C and M1 are not drawn; M5 and X are.
    const sw = (cls) => eruptionCall(normalizeFlare({ cls, latDeg: 10, lonDeg: 20 }, { nowMs: now }));
    assert.equal(sw('C5.0').eruptive, false); assert.equal(sw('M1.0').eruptive, false);
    assert.equal(sw('M5.0').eruptive, true); assert.equal(sw('X1.0').eruptive, true);
    for (const c of ['C5.0', 'M1.0', 'M5.0', 'X1.0']) { const r = sw(c); assert.equal(r.basis, 'class-prior'); assert.equal(r.eruptive, r.p >= ERUPTIVE_PRIOR_MIN); }
    // A statement beats everything, both ways.
    assert.deepEqual(pick(eruptionCall(ev({ linked_cme: true, eruptive: false }))), { eruptive: false, basis: 'stated' });
    assert.deepEqual(pick(eruptionCall(normalizeFlare({ cls: 'C1.0', latDeg: 0, lonDeg: 0, eruptive: true }, { nowMs: now }))), { eruptive: true, basis: 'stated' });
    assert.equal(eruptionCall(null).eruptive, false);
    // The caption says which basis the rope stands on — and says nothing when there is no rope and no report.
    assert.match(eruptionClause(eruptionCall(ev({ linked_cme: true }))), /CME reported/);
    assert.match(eruptionClause(eruptionCall(ev({ linked_cme: false }))), /no CME reported · confined/);
    assert.match(eruptionClause(sw('X1.0')), /eruption modelled · no CME report yet \(CME in ~90 % of flares this size\)/);
    assert.equal(eruptionClause(sw('C5.0')), '');
    const ph = { id: 'impulsive', channel: '131' };
    assert.match(caption(ev({ linked_cme: true }), ph, 30, { eruption: eruptionCall(ev({ linked_cme: true })) }), /CME reported · rope modelled/);
    assert.ok(!/rope|CME/.test(caption(ev({}), ph, 30, {})), 'no eruption passed, nothing claimed');
});

console.log(`${passed} checks passed (sun-flare-director)`);
