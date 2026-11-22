#!/usr/bin/env node
/**
 * climalytix-places.mjs — node gate for js/climalytix/places.js (the PURE
 * kernel behind Climalytix's location search: history, saved places, the
 * device↔account merge, and network-free suggestions) and for the geocoder
 * row mapper in js/user-location.js.
 *
 * Every check is against something independent of the code under test: a
 * hand-worked coordinate, a brute-force property (merge order must not
 * matter), or a NEGATIVE CONTROL that puts the naive rule back:
 *   · deletion-by-removal (no stamp) is resurrected by a merge — the stamps
 *     are why `forget` / un-save / clear survive a second device
 *   · last-write-wins loses one device's visits — the merge keeps both
 *
 *   node tests/climalytix-places.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    placeId, cleanPlace, emptyPlaces, normalizePlaces, mergePlaces, samePlaces,
    recordVisit, setSaved, forgetPlace, clearHistory, savedPlaces, recentPlaces, isSaved,
    fold, parseCoordinates, formatCoords, matchRank, suggest,
    MAX_RECENT, MAX_SAVED,
} from '../js/climalytix/places.js';
import { nominatimPlace } from '../js/user-location.js';
import { sameLocation } from '../js/climate-lab/lab-home.js';
import { MAJOR_CITIES } from '../js/data/major-cities.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);
const BOULDER = { lat: 40.015, lon: -105.271, city: 'Boulder, CO' };
const TOKYO = { lat: 35.6762, lon: 139.6503, city: 'Tokyo', detail: 'Japan' };
const PARIS = { lat: 48.8566, lon: 2.3522, city: 'Paris', detail: 'Île-de-France, France' };
const names = (list) => list.map((p) => p.city);

console.log('climalytix places');

ok('a place is its coordinates to ~1 km; junk is refused, never placed at 0,0', () => {
    assert.equal(placeId(40.015, -105.271), placeId(40.0151, -105.2713));
    assert.notEqual(placeId(40.015, -105.271), placeId(40.035, -105.271));
    assert.equal(placeId(-0.001, 0.001), 'p_0.00_0.00', 'no "-0.00" id');
    assert.equal(sameLocation(BOULDER, { lat: 40.0151, lon: -105.2713 }), true, 'agrees with lab-home sameLocation');
    for (const bad of [null, {}, { lat: null, lon: null }, { lat: '', lon: '' }, { lat: 91, lon: 0 }, { lat: 0, lon: 181 }, { lat: 'x', lon: 1 }]) {
        assert.equal(cleanPlace(bad), null, JSON.stringify(bad));
    }
    assert.equal(cleanPlace({ lat: 10, lon: 20 }).city, '10.00, 20.00');
    assert.equal(cleanPlace({ ...TOKYO, id: 'p_evil' }).id, placeId(TOKYO.lat, TOKYO.lon), 'the id is derived, never trusted');
});

ok('visits build a newest-first history; a re-visit moves a place up and counts', () => {
    let d = emptyPlaces();
    d = recordVisit(d, TOKYO, T0);
    d = recordVisit(d, PARIS, T0 + 1000);
    assert.deepEqual(names(recentPlaces(d)), ['Paris', 'Tokyo']);
    d = recordVisit(d, { ...TOKYO, lat: 35.6771 }, T0 + 2000);
    assert.deepEqual(names(recentPlaces(d)), ['Tokyo', 'Paris']);
    assert.equal(recentPlaces(d)[0].n, 2);
    assert.equal(recentPlaces(d)[0].detail, 'Japan');
    assert.equal(d.places.length, 2, 'one record per place');
});

ok('saved places are not history: listed once, kept through a clear, in the order saved', () => {
    let d = recordVisit(recordVisit(emptyPlaces(), TOKYO, T0), PARIS, T0 + 1);
    d = setSaved(d, PARIS, true, T0 + 2);
    d = setSaved(d, BOULDER, true, T0 + 3);              // saved without ever being visited
    assert.deepEqual(names(savedPlaces(d)), ['Paris', 'Boulder, CO']);
    assert.deepEqual(names(recentPlaces(d)), ['Tokyo']);
    assert.equal(isSaved(d, PARIS), true);
    d = clearHistory(d, T0 + 10);
    assert.deepEqual(names(recentPlaces(d)), []);
    assert.deepEqual(names(savedPlaces(d)), ['Paris', 'Boulder, CO']);
    d = setSaved(d, PARIS, false, T0 + 20);
    assert.equal(isSaved(d, PARIS), false);
    assert.deepEqual(names(recentPlaces(d)), [], 'un-saving a cleared place does not put it back in the history');
});

ok('forget hides one place; a later visit brings it back', () => {
    let d = recordVisit(recordVisit(emptyPlaces(), TOKYO, T0), PARIS, T0 + 1);
    d = forgetPlace(d, placeId(TOKYO.lat, TOKYO.lon), T0 + 5);
    assert.deepEqual(names(recentPlaces(d)), ['Paris']);
    d = recordVisit(d, TOKYO, T0 + 9);
    assert.deepEqual(names(recentPlaces(d)), ['Tokyo', 'Paris']);
    // A device whose clock runs behind must still be able to bring a place back.
    d = forgetPlace(d, placeId(TOKYO.lat, TOKYO.lon), T0 + 50);
    d = recordVisit(d, TOKYO, T0 + 20);
    assert.equal(names(recentPlaces(d))[0], 'Tokyo');
});

ok('caps hold and trim the OLDEST', () => {
    let d = emptyPlaces();
    for (let i = 0; i < MAX_RECENT + 5; i++) d = recordVisit(d, { lat: i, lon: i, city: `c${i}` }, T0 + i);
    const r = recentPlaces(d);
    assert.equal(r.length, MAX_RECENT);
    assert.equal(r[0].city, `c${MAX_RECENT + 4}`);
    assert.equal(r.at(-1).city, 'c5');
    for (let i = 0; i < MAX_SAVED + 3; i++) d = setSaved(d, { lat: -i - 1, lon: i, city: `s${i}` }, true, T0 + 100 + i);
    assert.equal(savedPlaces(d).length, MAX_SAVED);
    assert.deepEqual(normalizePlaces(normalizePlaces(d)), normalizePlaces(d), 'normalising is idempotent');
});

ok('merge keeps BOTH devices’ visits (last-write-wins is the negative control)', () => {
    const a = recordVisit(emptyPlaces(), TOKYO, T0);
    const b = recordVisit(emptyPlaces(), PARIS, T0 + 5);
    assert.deepEqual(names(recentPlaces(mergePlaces(a, b))), ['Paris', 'Tokyo']);
    const lww = b;                                        // the newer document alone
    assert.deepEqual(names(recentPlaces(lww)), ['Paris'], 'control: LWW drops the other device’s Tokyo');
});

ok('merge is commutative and idempotent over a seeded random history', () => {
    let seed = 20261122;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const spots = Array.from({ length: 20 }, (_, i) => ({ lat: i * 3 - 30, lon: i * 7 - 70, city: `spot ${i}` }));
    const play = (steps) => {
        let d = emptyPlaces();
        for (let k = 0; k < steps; k++) {
            const s = spots[Math.floor(rnd() * spots.length)], t = T0 + Math.floor(rnd() * 1e6), op = rnd();
            d = op < 0.55 ? recordVisit(d, s, t) : op < 0.75 ? setSaved(d, s, rnd() < 0.6, t)
                : op < 0.95 ? forgetPlace(d, placeId(s.lat, s.lon), t) : clearHistory(d, t);
        }
        return d;
    };
    for (let trial = 0; trial < 40; trial++) {
        const a = play(30), b = play(30);
        const ab = mergePlaces(a, b), ba = mergePlaces(b, a);
        assert.deepEqual(ab, ba, `trial ${trial}: order must not matter`);
        assert.deepEqual(mergePlaces(ab, a), ab, `trial ${trial}: re-merging a side changes nothing`);
        assert.deepEqual(mergePlaces(ab, ab), ab);
        assert.equal(samePlaces(ab, ba), true);
    }
});

ok('a removal on one device survives the merge (deleting the record is the negative control)', () => {
    const both = recordVisit(recordVisit(emptyPlaces(), TOKYO, T0), PARIS, T0 + 1);
    const tid = placeId(TOKYO.lat, TOKYO.lon);
    // forget
    assert.deepEqual(names(recentPlaces(mergePlaces(forgetPlace(both, tid, T0 + 5), both))), ['Paris']);
    const naive = { ...both, places: both.places.filter((p) => p.id !== tid) };
    assert.deepEqual(names(recentPlaces(mergePlaces(naive, both))), ['Paris', 'Tokyo'], 'control: an unstamped delete comes back');
    // un-save
    const pinned = setSaved(both, TOKYO, true, T0 + 2);
    assert.equal(isSaved(mergePlaces(setSaved(pinned, TOKYO, false, T0 + 6), pinned), TOKYO), false);
    // …even after the un-saved place has aged out of this device's history
    let aged = setSaved(pinned, TOKYO, false, T0 + 6);
    for (let i = 0; i < MAX_RECENT + 2; i++) aged = recordVisit(aged, { lat: i, lon: 100 + i, city: `x${i}` }, T0 + 100 + i);
    assert.equal(recentPlaces(aged).some((p) => p.city === 'Tokyo'), false);
    assert.equal(isSaved(mergePlaces(aged, pinned), TOKYO), false, 'the un-save stamp outlives the history cap');
    // a save made AFTER the other device's un-save wins
    assert.equal(isSaved(mergePlaces(setSaved(pinned, TOKYO, false, T0 + 6), setSaved(pinned, TOKYO, true, T0 + 9)), TOKYO), true);
    // clear history
    const cleared = clearHistory(both, T0 + 10);
    assert.deepEqual(names(recentPlaces(mergePlaces(cleared, both))), []);
    assert.deepEqual(names(recentPlaces(mergePlaces(cleared, recordVisit(both, PARIS, T0 + 20)))), ['Paris'], 'a visit after the clear is kept');
});

ok('a corrupt or foreign document degrades to an empty one, field by field', () => {
    for (const junk of [null, 7, 'x', [], { places: 'no' }, { places: [null, 3, { lat: 999, lon: 0 }] }]) {
        assert.deepEqual(normalizePlaces(junk), emptyPlaces());
    }
    const d = normalizePlaces({ clearedAt: 'soon', places: [{ ...TOKYO, at: T0, n: -4, pin: 'yes', city: 'x'.repeat(500) }] });
    assert.equal(d.clearedAt, 0);
    assert.equal(d.places[0].n, 0);
    assert.equal(d.places[0].pin, 1);
    assert.equal(d.places[0].city.length, 80);
});

console.log('search');

ok('coordinates: decimal, hemisphere letters, DMS, lon-first — against hand-worked values', () => {
    assert.deepEqual(parseCoordinates('40.015, -105.271'), { lat: 40.015, lon: -105.271 });
    assert.deepEqual(parseCoordinates('40.015 -105.271'), { lat: 40.015, lon: -105.271 });
    assert.deepEqual(parseCoordinates('  -33.87;151.21 '), { lat: -33.87, lon: 151.21 });
    assert.deepEqual(parseCoordinates('40.015N 105.271W'), { lat: 40.015, lon: -105.271 });
    assert.deepEqual(parseCoordinates('105.271°W, 40.015°N'), { lat: 40.015, lon: -105.271 });
    assert.deepEqual(parseCoordinates('33.87 S, 151.21 E'), { lat: -33.87, lon: 151.21 });
    // 40°0'54"N = 40 + 0/60 + 54/3600 = 40.015 ; 105°16'15.6"W = −(105 + 16/60 + 15.6/3600) = −105.271
    assert.deepEqual(parseCoordinates(`40°0'54"N 105°16'15.6"W`), { lat: 40.015, lon: -105.271 });
    assert.deepEqual(parseCoordinates('10, 20'), { lat: 10, lon: 20 });
    assert.deepEqual(parseCoordinates('-0.5, 0.5'), { lat: -0.5, lon: 0.5 });
});

ok('…and what is NOT a coordinate reaches the geocoder', () => {
    for (const q of ['80301', '10 20', 'Boulder', '1600 Pennsylvania Ave', '91, 10', '10, 181', '40N 50N', '10E 20W', '40.0', '', '12 Main St, 80301']) {
        assert.equal(parseCoordinates(q), null, q);
    }
});

ok('formatCoords round-trips through parseCoordinates', () => {
    for (const [lat, lon] of [[40.015, -105.271], [-33.87, 151.21], [0, 0], [-89.5, -179.5]]) {
        assert.deepEqual(parseCoordinates(formatCoords(lat, lon)), { lat, lon });
    }
});

ok('matching folds accents and needs every token to begin a word', () => {
    assert.equal(fold('Reykjavík'), 'reykjavik');
    assert.equal(matchRank('reyk', 'Reykjavík Iceland'), 0);
    assert.equal(matchRank('sao pa', 'São Paulo Brazil'), 0);
    assert.equal(matchRank('york', 'New York USA'), 1);
    assert.equal(matchRank('ork', 'New York USA'), -1, 'no mid-word matches');
    assert.equal(matchRank('new tokyo', 'New York USA'), -1);
    assert.equal(matchRank('', 'x'), -1);
});

ok('empty query offers the reader’s own places: Home, saved, then history', () => {
    let d = recordVisit(recordVisit(emptyPlaces(), TOKYO, T0), PARIS, T0 + 1);
    d = setSaved(d, PARIS, true, T0 + 2);
    const rows = suggest('', { home: BOULDER, doc: d, cities: MAJOR_CITIES });
    assert.deepEqual(rows.map((r) => `${r.kind}:${r.city}`), ['home:Boulder, CO', 'saved:Paris', 'recent:Tokyo']);
    assert.deepEqual(suggest('', { cities: MAJOR_CITIES }), [], 'nothing of their own ⇒ nothing invented');
});

ok('a query ranks own places over cities, prefix over word, bigger city first, one row per place', () => {
    const d = recordVisit(emptyPlaces(), { lat: 37.21, lon: -93.29, city: 'Springfield', detail: 'Missouri, United States' }, T0);
    const rows = suggest('s', { doc: d, cities: MAJOR_CITIES, limit: 5 });
    assert.equal(rows[0].kind, 'recent');
    assert.equal(rows[0].city, 'Springfield');
    assert.equal(rows.length, 5);
    const cityRows = rows.filter((r) => r.kind === 'city');
    const pop = (r) => MAJOR_CITIES.find((c) => c.n === r.city).p;
    for (let i = 1; i < cityRows.length; i++) assert.ok(pop(cityRows[i - 1]) >= pop(cityRows[i]), 'cities by population');
    const tokyo = suggest('tok', { doc: recordVisit(emptyPlaces(), TOKYO, T0), cities: MAJOR_CITIES });
    assert.equal(tokyo.filter((r) => r.city === 'Tokyo').length, 1, 'the visited Tokyo and the city-list Tokyo are one row');
    assert.equal(tokyo[0].kind, 'recent');
    const york = suggest('york', { cities: MAJOR_CITIES });
    assert.equal(york[0].city, 'New York', 'a later word still matches');
    assert.equal(suggest('zzzz', { cities: MAJOR_CITIES }).length, 0);
});

ok('typed coordinates are the first suggestion', () => {
    const rows = suggest('40.015, -105.271', { cities: MAJOR_CITIES });
    assert.equal(rows[0].kind, 'coords');
    assert.equal(rows[0].city, '40.015°N 105.271°W');
    assert.equal(rows[0].lat, 40.015);
});

ok('the geocoder row mapper names the region that tells two Springfields apart', () => {
    const il = nominatimPlace({ lat: '39.7990', lon: '-89.6440', display_name: 'Springfield, Sangamon County, Illinois, United States',
        address: { city: 'Springfield', state: 'Illinois', country: 'United States' } }, 'springfield');
    assert.deepEqual([il.city, il.detail, il.lat], ['Springfield', 'Illinois, United States', 39.799]);
    const tokyo = nominatimPlace({ lat: '35.6762', lon: '139.6503', display_name: 'Tokyo, Japan', address: { city: 'Tokyo' } });
    assert.deepEqual([tokyo.city, tokyo.detail], ['Tokyo', '']);
    const state = nominatimPlace({ lat: '39', lon: '-105.5', address: { state: 'Colorado', country: 'United States' } });
    assert.deepEqual([state.city, state.detail], ['Colorado', 'United States'], 'detail never repeats the name');
    assert.equal(nominatimPlace({ lat: 'x', lon: '1' }), null);
});

ok('SOURCE: the page geocodes on submit only, never per keystroke', () => {
    const src = readFileSync(new URL('../js/climalytix/page.js', import.meta.url), 'utf8');
    const calls = [...src.matchAll(/geocodeCandidates\(/g)].length;
    assert.equal(calls, 1, 'one geocoder call site');
    const onSearch = src.slice(src.indexOf('async function onSearch'), src.indexOf('function onSearchKey'));
    assert.ok(onSearch.includes('geocodeCandidates('), '…and it is in the submit handler');
    assert.ok(!/addEventListener\('input'[^\n]*geocode/.test(src));
});

console.log(`\n${passed} passed`);
