#!/usr/bin/env node
/**
 * climalytix-glance.mjs — node gate for js/climalytix/places-glance.js ("your
 * places right now"), the place LABELS added to js/climalytix/places.js, and
 * the share link.
 *
 * Checked against hand-worked values and, for the route body, against the
 * REAL route assembler (point-tile.js `siteBody` / `degradedNwp`) so the board
 * cannot drift from what /api/climalytix/nwp actually answers. Negative
 * controls put the naive rules back:
 *   · nearest-frame instead of interpolation is up to 90 min stale
 *   · interpolating wind SPEED invents wind where two frames oppose
 *   · a 24-hour range over whatever frames happen to exist
 *
 *   node tests/climalytix-glance.mjs
 */

import assert from 'node:assert/strict';
import { glanceFromNwp, glancePlan, glanceReason, bracket, compass, GLANCE_MAX } from '../js/climalytix/places-glance.js';
import {
    emptyPlaces, recordVisit, setSaved, setLabel, mergePlaces, savedPlaces, recentPlaces, placeName, placeId, suggest,
    normalizePlaces, shareUrl,
} from '../js/climalytix/places.js';
import { pitch } from '../js/climalytix/places-pitch.js';
import { siteBody, degradedNwp, parseSite, SCHEMA } from '../js/climalytix/point-tile.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const H = 3_600_000;
const T0 = Date.UTC(2026, 10, 22, 12);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);
const times = Array.from({ length: 17 }, (_, i) => T0 + i * 3 * H);            // a 48-hour run, 3-hourly
const body = (series, extra = {}) => ({ run: '2026-11-22T12:00Z', age_seconds: 7 * 3600, freshness: 'fresh', times, series, ...extra });
const TOKYO = { lat: 35.6762, lon: 139.6503, city: 'Tokyo', detail: 'Japan' };
const PARIS = { lat: 48.8566, lon: 2.3522, city: 'Paris' };
const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };

console.log('climalytix glance');

ok('“now” is interpolated by instant between the bracketing frames', () => {
    const tempC = times.map((_, i) => 10 + 2 * i);
    const g = glanceFromNwp(body({ tempC }), T0 + 4.5 * H);                   // halfway through frame 1→2
    assert.equal(g.state, 'ok');
    near(g.tempC, 13, 1e-9);                                                  // (12 + 14) / 2
    near(glanceFromNwp(body({ tempC }), T0).tempC, 10, 1e-9, 'exactly on a frame');
    near(glanceFromNwp(body({ tempC }), times.at(-1)).tempC, 42, 1e-9, 'exactly on the last frame');
    // NEGATIVE CONTROL: the nearest frame, 80 min before the next one, is off by most of a step.
    const t = T0 + 3 * H + 100 * 60_000;
    const nearest = tempC[1];
    assert.ok(Math.abs(glanceFromNwp(body({ tempC }), t).tempC - nearest) > 1, 'nearest-frame is stale');
    assert.deepEqual(bracket(times, T0 + 4.5 * H), { i0: 1, i1: 2, w: 0.5 });
});

ok('outside the run nothing is held or extrapolated', () => {
    const tempC = times.map(() => 10);
    const late = glanceFromNwp(body({ tempC }), times.at(-1) + 1);
    assert.equal(late.state, 'none');
    assert.equal(late.reason, 'run_ended');
    assert.equal(late.tempC, null);
    assert.equal(glanceFromNwp(body({ tempC }), T0 - 1).reason, 'run_not_started');
    assert.equal(bracket(times, T0 - 1), null);
    assert.equal(bracket([], T0), null);
});

ok('a gap in either bracketing frame is a gap — never a one-sided value', () => {
    const tempC = times.map((_, i) => (i === 2 ? null : 10 + i));
    assert.equal(glanceFromNwp(body({ tempC }), T0 + 4.5 * H).tempC, null);
    near(glanceFromNwp(body({ tempC }), T0 + 1.5 * H).tempC, 10.5, 1e-9, 'unaffected frames still interpolate');
});

ok('wind is interpolated as COMPONENTS (interpolated speed is the negative control)', () => {
    const uMs = times.map((_, i) => (i % 2 ? -8 : 8)), vMs = times.map(() => 0);
    const g = glanceFromNwp(body({ tempC: times.map(() => 1), uMs, vMs }), T0 + 1.5 * H);
    near(g.windMs, 0, 1e-9, 'a west wind turning east passes through calm');
    assert.equal(g.windDirDeg, null, 'calm air has no direction');
    const naive = (Math.hypot(uMs[0], vMs[0]) + Math.hypot(uMs[1], vMs[1])) / 2;
    assert.equal(naive, 8, 'control: interpolated speed reads a steady 8 m/s');
    // Direction is where the wind comes FROM: u > 0 is a westerly (270°), v > 0 a southerly (180°).
    near(glanceFromNwp(body({ uMs: times.map(() => 5), vMs: times.map(() => 0) }), T0).windDirDeg, 270, 1e-9);
    near(glanceFromNwp(body({ uMs: times.map(() => 0), vMs: times.map(() => 5) }), T0).windDirDeg, 180, 1e-9);
    assert.equal(compass(270), 'W');
    assert.equal(compass(0), 'N');
    assert.equal(compass(359), 'N');
    assert.equal(compass(202.5), 'SSW');
    assert.equal(compass(null), '');
});

ok('the next-24-hour range covers the frame in force now through now + 24 h', () => {
    const tempC = times.map((_, i) => i);                                    // 0,1,2,… per 3 h
    const g = glanceFromNwp(body({ tempC }), T0 + 4 * H);                     // in frame 1; +24 h is T0+28 h → frames 1..9
    assert.equal(g.loC, 1);
    assert.equal(g.hiC, 9);
    // Fewer than half the frames have a value ⇒ no range (control: the range of what happened to be there).
    const sparse = times.map((_, i) => (i === 1 || i === 2 ? i : null));
    const s = glanceFromNwp(body({ tempC: sparse }), T0 + 4 * H);
    assert.equal(s.hiC, null);
    assert.equal(s.loC, null);
    const naiveHi = Math.max(...sparse.filter((x) => x != null));
    assert.equal(naiveHi, 2, 'control would print 1 … 2 as “the next 24 h”');
});

ok('precipitation is the sum of the next 24 h of amounts; all-missing is unknown, not dry', () => {
    const precipMm = times.map((_, i) => (i === 0 ? null : 0.5));
    const g = glanceFromNwp(body({ tempC: times.map(() => 5), precipMm }), T0 + 4 * H);
    near(g.precipMm, 4.5, 1e-9);                                              // frames 1..9
    assert.equal(glanceFromNwp(body({ tempC: times.map(() => 5), precipMm: times.map(() => null) }), T0 + 4 * H).precipMm, null);
    assert.equal(glanceFromNwp(body({ tempC: times.map(() => 5), precipMm: times.map(() => 0) }), T0 + 4 * H).precipMm, 0, 'a measured zero is dry');
});

ok('archive down, unpublished or empty: the row says why and carries no numbers', () => {
    assert.equal(glanceFromNwp(null, T0).reason, 'feed_down');
    const q = parseSite({ lat: '35.68', lon: '139.65' });
    for (const reason of ['r2_not_configured', 'no_run_published']) {
        const g = glanceFromNwp(degradedNwp(q, '0p25', reason, T0), T0);     // the ROUTE's own degraded body
        assert.equal(g.state, 'none');
        assert.equal(g.reason, reason);
        assert.equal(g.tempC, null);
    }
    assert.equal(glanceFromNwp(body({}), T0 + H).reason, 'no_values');
    assert.match(glanceReason('no_run_published'), /no GFS run/);
    assert.match(glanceReason('r2_not_configured'), /not published/);
    assert.equal(glanceReason('some_new_reason: detail'), 'some new reason');
    assert.equal(glanceReason(undefined), 'unavailable');
});

ok('it reads the REAL route body (point-tile siteBody)', () => {
    const man = { schema: SCHEMA, source: 'gfs', grid: '0p25', run: '2026-11-22T12:00Z', runMs: T0, dlat: 0.25, dlon: 0.25,
        vars: ['tempC', 'uMs', 'vMs', 'precipMm'].map((id) => ({ id, unit: '-' })), times, leadsH: times.map((_, i) => i * 3), intervalH: { precipMm: 3 }, missing: [], notes: [] };
    const v = { tempC: times.map((_, i) => 4 + i), uMs: times.map(() => 3), vMs: times.map(() => 4), precipMm: times.map((_, i) => (i ? 1 : null)) };
    const b = siteBody(man, { nodeLat: 35.75, nodeLon: 139.5 }, v, { lat: 35.68, lon: 139.65, nowMs: T0 + 7.5 * H });
    const g = glanceFromNwp(b, T0 + 7.5 * H);
    assert.equal(g.state, 'ok');
    near(g.tempC, 6.5, 1e-6);
    near(g.windMs, 5, 1e-6);                                                  // 3-4-5
    assert.equal(g.run, '2026-11-22T12:00Z');
    assert.ok(Number.isFinite(g.ageS));
});

ok('the board lists Home first, then saved places in the order saved — never history, never twice', () => {
    let d = recordVisit(emptyPlaces(), TOKYO, T0);
    d = setSaved(d, PARIS, true, T0 + 1);
    d = setSaved(d, TOKYO, true, T0 + 2);
    d = recordVisit(d, { lat: -12.05, lon: -77.04, city: 'Lima' }, T0 + 3);  // visited, not saved
    d = setSaved(d, BOULDER, true, T0 + 4);                                   // Home is also saved
    const rows = glancePlan(d, BOULDER);
    assert.deepEqual(rows.map((r) => `${r.kind}:${r.name}`), ['home:Boulder, CO', 'saved:Paris', 'saved:Tokyo']);
    assert.deepEqual(glancePlan(d, null).map((r) => r.name), ['Paris', 'Tokyo', 'Boulder, CO']);
    let many = emptyPlaces();
    for (let i = 0; i < 20; i++) many = setSaved(many, { lat: i, lon: i, city: `p${i}` }, true, T0 + i);
    assert.equal(glancePlan(many, BOULDER).length, GLANCE_MAX);
    assert.deepEqual(glancePlan(emptyPlaces(), null), []);
});

console.log('labels');

ok('a saved place can be named; the name is shown everywhere and the place keeps its own', () => {
    let d = setSaved(recordVisit(emptyPlaces(), TOKYO, T0), TOKYO, true, T0 + 1);
    const id = placeId(TOKYO.lat, TOKYO.lon);
    d = setLabel(d, id, '  Grandma’s   house ', T0 + 2);
    const p = savedPlaces(d)[0];
    assert.equal(p.label, 'Grandma’s house');
    assert.equal(p.city, 'Tokyo');
    assert.equal(placeName(p), 'Grandma’s house');
    assert.equal(glancePlan(d, null)[0].name, 'Grandma’s house');
    assert.equal(glancePlan(d, null)[0].city, 'Tokyo', 'the board still fetches the place, not the label');
    // the pitch and its dialog use the reader's own name for it
    assert.deepEqual(pitch({ scope: 'pending', kept: 'device', saved: savedPlaces(d).map(placeName) }).names, ['Grandma’s house']);
    // clearing: empty text, or typing the place's own name back
    assert.equal(placeName(savedPlaces(setLabel(d, id, '', T0 + 3))[0]), 'Tokyo');
    assert.equal(savedPlaces(setLabel(d, id, 'Tokyo', T0 + 3))[0].label, undefined);
    assert.deepEqual(setLabel(d, 'p_9.99_9.99', 'Nowhere', T0 + 3), normalizePlaces(d), 'an unknown place cannot be named');
    assert.equal(savedPlaces(setLabel(d, id, 'x'.repeat(200), T0 + 3))[0].label.length, 40);
});

ok('search finds a place by its label, and a later visit does not wipe the label', () => {
    let d = setSaved(recordVisit(emptyPlaces(), TOKYO, T0), TOKYO, true, T0 + 1);
    d = setLabel(d, placeId(TOKYO.lat, TOKYO.lon), 'Cabin', T0 + 2);
    const rows = suggest('cab', { doc: d, cities: [] });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].label, 'Cabin');
    assert.equal(rows[0].city, 'Tokyo');
    assert.equal(suggest('tok', { doc: d, cities: [] })[0].label, 'Cabin', 'still found by its real name');
    d = recordVisit(d, { ...TOKYO, city: 'Tokyo' }, T0 + 9);
    assert.equal(savedPlaces(d)[0].label, 'Cabin');
});

ok('labels merge like every other decision: newest stamp wins, a CLEARED label too, in either order', () => {
    const base = setSaved(recordVisit(emptyPlaces(), TOKYO, T0), TOKYO, true, T0 + 1);
    const id = placeId(TOKYO.lat, TOKYO.lon);
    const a = setLabel(base, id, 'Cabin', T0 + 5);
    const b = setLabel(base, id, 'Office', T0 + 9);
    assert.equal(savedPlaces(mergePlaces(a, b))[0].label, 'Office');
    assert.deepEqual(mergePlaces(a, b), mergePlaces(b, a));
    assert.equal(savedPlaces(mergePlaces(a, base))[0].label, 'Cabin', 'a device that never named it does not erase the name');
    const cleared = setLabel(a, id, '', T0 + 20);
    assert.equal(savedPlaces(mergePlaces(cleared, a))[0].label, undefined, 'clearing survives the merge');
    assert.deepEqual(mergePlaces(cleared, a), mergePlaces(a, cleared));
    // NEGATIVE CONTROL: clearing by deleting the field (no stamp) is resurrected.
    const naive = { ...a, places: a.places.map((p) => { const q = { ...p }; delete q.label; delete q.labelAt; return q; }) };
    assert.equal(savedPlaces(mergePlaces(naive, a))[0].label, 'Cabin');
    assert.deepEqual(mergePlaces(mergePlaces(a, b), a), mergePlaces(a, b), 'idempotent');
    assert.equal(recentPlaces(mergePlaces(a, b)).length, 0);
});

console.log('share link');

ok('a share link opens THIS place for anyone — Home included — and drops private parameters', () => {
    const u = new URL(shareUrl('https://parkersphysics.com/climalytix.html?resume=save&theme=light#x', TOKYO));
    assert.equal(u.pathname, '/climalytix.html');
    assert.equal(u.searchParams.get('lat'), '35.6762');
    assert.equal(u.searchParams.get('lon'), '139.6503');
    assert.equal(u.searchParams.get('name'), 'Tokyo');
    assert.equal(u.searchParams.has('resume'), false);
    assert.equal(u.searchParams.get('theme'), 'light', 'unrelated parameters are kept');
    assert.equal(u.hash, '');
    // a bare page URL (the reader is at Home) still names the place
    assert.match(shareUrl('https://parkersphysics.com/climalytix.html', BOULDER), /lat=40\.0150&lon=-105\.2710&name=Boulder/);
    // the label is the reader's own word for it and is NOT shared
    assert.doesNotMatch(shareUrl('https://x.test/climalytix.html', { ...TOKYO, label: 'Grandma' }), /Grandma/);
    // names with markup or ampersands survive as data
    const odd = new URL(shareUrl('https://x.test/c.html', { lat: 1, lon: 2, city: 'A & B <b>' }));
    assert.equal(odd.searchParams.get('name'), 'A & B <b>');
    assert.equal(shareUrl('https://x.test/c.html?lat=9&lon=9&name=Old', null), 'https://x.test/c.html');
});

console.log(`\n${passed} passed`);
