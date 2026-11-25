#!/usr/bin/env node
/**
 * climalytix-pitch.mjs — node gate for js/climalytix/places-pitch.js (the ONE
 * rule book for what Climalytix says about remembering places and when it asks
 * for a sign-up), plus the search-box helpers added with it in places.js
 * (match highlighting, first-visit examples, the save-intent that survives the
 * trip to sign in).
 *
 * The pitch is a product decision written as a pure function, so the gate
 * pins the DECISIONS, each with the rule it replaces as a negative control:
 *   · the ask is EARNED — a first-time visitor never gets the card
 *   · "Not now" holds until there is more to lose, then re-arms once per step
 *   · the page never says "in your account" unless a sync has landed
 *   · the copy is the reader's own numbers and names, grammatical at 1 and N
 *
 *   node tests/climalytix-pitch.mjs
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pitch, listNames, stepReached, cardArmed, gateNote, PITCH_STEPS } from '../js/climalytix/places-pitch.js';
import {
    highlightParts, exampleRows, EXAMPLE_CITIES, makeSaveIntent, validSaveIntent, SAVE_INTENT_TTL_MS, matchRank, suggest,
} from '../js/climalytix/places.js';
import { MAJOR_CITIES } from '../js/data/major-cities.js';

let passed = 0;
const ok = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const names = (n) => Array.from({ length: n }, (_, i) => `Place ${i + 1}`);
const out = (n, extra = {}) => pitch({ scope: 'session', kept: 'session', recent: names(n), ...extra });
const T0 = Date.UTC(2026, 10, 22, 12);

console.log('climalytix pitch — the sign-up ladder');

ok('a first-time visitor gets ONE quiet line, never the card', () => {
    const p = out(0);
    assert.equal(p.stage, 'invite');
    assert.equal(p.kind, 'line');
    assert.equal(p.cta.action, 'signup');
    assert.equal(p.signin, true, 'a returning user always has a way in');
    assert.ok(!p.dismiss && !p.headline);
});

ok('1–2 places: still a line, now naming what is at stake', () => {
    for (const n of [1, 2]) {
        const p = out(n);
        assert.equal(p.stage, 'session');
        assert.equal(p.kind, 'line');
        assert.match(p.body, /this session only/);
        assert.match(p.body, /tab closes/);
    }
    assert.match(out(1).body, /^1 place kept/);
    assert.match(out(2).body, /^2 places kept/);
    assert.match(out(1).cta.label, /keep it$/);
    assert.match(out(2).cta.label, /keep them$/);
});

ok('the card appears exactly at the first step — earned, not immediate', () => {
    assert.equal(PITCH_STEPS[0], 3);
    assert.equal(out(PITCH_STEPS[0] - 1).kind, 'line');
    const p = out(PITCH_STEPS[0]);
    assert.equal(p.stage, 'ownership');
    assert.equal(p.kind, 'card');
    assert.equal(p.headline, 'Keep your 3 places?');
    assert.match(p.body, /Place 1, Place 2 and Place 3 are only kept until this tab closes/);
    assert.match(p.cta.label, /free$/);
    assert.deepEqual(p.dismiss, { label: 'Not now', step: 3 });
});

ok('“Not now” holds until the NEXT step, re-arms once there, and never after the last', () => {
    const shown = [];
    let dismissedAt = 0;
    for (let n = 0; n <= 14; n++) {
        const p = out(n, { dismissedAt });
        if (p.kind === 'card') { shown.push(n); dismissedAt = p.dismiss.step; }   // the reader says "Not now" every time
    }
    assert.deepEqual(shown, [...PITCH_STEPS], 'one ask per step, none between, none past the last');
    // NEGATIVE CONTROL: a card that ignores the dismissal nags on every visit from the first step on.
    const nag = [];
    for (let n = 0; n <= 14; n++) if (out(n, { dismissedAt: 0 }).kind === 'card') nag.push(n);
    assert.equal(nag.length, 12);
    // A dismissal is never undone by the collection SHRINKING (history cleared).
    assert.equal(out(4, { dismissedAt: 6 }).kind, 'line');
    assert.equal(stepReached(0), 0);
    assert.equal(stepReached(5), 3);
    assert.equal(stepReached(99), 10);
    assert.equal(cardArmed(6, 3), true);
    assert.equal(cardArmed(5, 3), false);
});

ok('saved places count, lead the list, and are never listed twice', () => {
    const p = pitch({ scope: 'session', kept: 'session', saved: ['Cabin'], recent: ['Cabin', 'Tokyo', 'Lima'] });
    assert.deepEqual(p.names, ['Cabin', 'Tokyo', 'Lima']);
    assert.equal(p.count, 3);
});

ok('names read as a sentence at every length', () => {
    assert.equal(listNames([]), '');
    assert.equal(listNames(['Tokyo']), 'Tokyo');
    assert.equal(listNames(['Tokyo', 'Paris']), 'Tokyo and Paris');
    assert.equal(listNames(['Tokyo', 'Paris', 'Lima']), 'Tokyo, Paris and Lima');
    assert.equal(listNames(['Tokyo', 'Paris', 'Lima', 'Oslo']), 'Tokyo, Paris and 2 more');
    assert.equal(listNames(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'a, b and 5 more');
    assert.equal(listNames([' ', null, 'Tokyo']), 'Tokyo', 'blanks dropped');
    // the count in "and N more" always adds up
    for (let n = 4; n < 12; n++) {
        const m = /and (\d+) more$/.exec(listNames(names(n)));
        assert.equal(Number(m[1]) + 2, n);
    }
});

ok('after the email: “check your inbox”, with the reader’s own count, and no second ask', () => {
    const p = pitch({ scope: 'pending', kept: 'device', recent: ['Tokyo', 'Paris'] });
    assert.equal(p.stage, 'pending');
    assert.match(p.body, /your 2 places are kept on this device/);
    assert.ok(!p.cta, 'they already signed up — do not ask again');
    assert.match(pitch({ scope: 'pending', kept: 'device', recent: ['Tokyo'] }).body, /your 1 place is kept/);
});

ok('signed in: “in your account” ONLY once a sync has landed', () => {
    const synced = pitch({ scope: 'account', kept: 'account', syncState: 'synced', recent: ['Tokyo'] });
    assert.equal(synced.stage, 'account');
    assert.match(synced.body, /kept in your account/);
    for (const syncState of [null, 'ready', 'error', 'off:no-session', 'migration-pending']) {
        const p = pitch({ scope: 'account', kept: 'device', syncState, recent: ['Tokyo'] });
        assert.equal(p.stage, 'device', syncState);
        assert.doesNotMatch(p.body, /in your account/, `${syncState}: no account claim`);
        assert.match(p.body, /on this device/);
    }
    assert.equal(pitch({ scope: 'account', kept: 'device', syncState: 'error', recent: ['x'] }).tone, 'warn');
    assert.equal(pitch({ scope: 'account', kept: 'device', syncState: 'ready', recent: ['x'] }).tone, 'info');
    assert.equal(pitch({ scope: 'account', kept: 'account', recent: [] }).kind, 'none', 'nothing to say about nothing');
});

ok('the welcome: once, with what was adopted and what was saved-as-asked, and honest about sync', () => {
    const w = pitch({ scope: 'account', kept: 'account', syncState: 'synced', adopted: 3, resumed: 'Tokyo', recent: ['Tokyo', 'Paris', 'Lima'] });
    assert.equal(w.stage, 'welcome');
    assert.equal(w.kind, 'card');
    assert.equal(w.tone, 'good');
    assert.match(w.body, /3 places from before you signed in are now in your account/);
    assert.match(w.body, /Tokyo is saved, as you asked/);
    assert.equal(w.dismiss.label, 'Got it');
    assert.ok(!w.cta, 'no ask on a welcome');
    assert.match(pitch({ scope: 'account', kept: 'account', adopted: 1, recent: ['x'] }).body, /1 place from before you signed in is now/);
    // sync down: say so, and do not promise the account
    const down = pitch({ scope: 'account', kept: 'device', syncState: 'error', adopted: 2, recent: ['a', 'b'] });
    assert.equal(down.stage, 'welcome');
    assert.equal(down.tone, 'warn');
    assert.doesNotMatch(down.body, /in your account/);
    assert.match(down.body, /account sync is unavailable/);
    // seen once
    assert.equal(pitch({ scope: 'account', kept: 'account', adopted: 3, welcomeSeen: true, recent: ['a'] }).stage, 'account');
    // nothing adopted, nothing resumed ⇒ no welcome at all
    assert.equal(pitch({ scope: 'account', kept: 'account', adopted: 0, recent: ['a'] }).stage, 'account');
});

ok('every stage is a complete, well-formed message (table sweep)', () => {
    const scopes = [['session', 'session'], ['pending', 'device'], ['account', 'device'], ['account', 'account']];
    const stages = new Set();
    for (const [scope, kept] of scopes) for (const n of [0, 1, 2, 3, 5, 6, 10, 30]) for (const adopted of [0, 2]) for (const dismissedAt of [0, 3, 10]) {
        const p = pitch({ scope, kept, recent: names(n), adopted, dismissedAt, syncState: kept === 'account' ? 'synced' : 'ready' });
        stages.add(p.stage);
        assert.ok(['line', 'card', 'none'].includes(p.kind));
        assert.ok(['ask', 'info', 'good', 'warn'].includes(p.tone));
        assert.equal(typeof p.body, 'string');
        assert.ok(p.body.length > 10 && !/undefined|NaN|null/.test(p.body), p.body);
        if (p.kind === 'card') assert.ok(p.headline && p.dismiss && p.label, `${p.stage}: a card is named and can always be put away`);
        if (p.cta) assert.equal(scope, 'session', 'only a signed-out reader is ever asked to sign up');
        if (scope !== 'session') assert.ok(!p.signin);
        assert.equal(p.count, n);
    }
    assert.deepEqual([...stages].sort(), ['account', 'device', 'invite', 'ownership', 'pending', 'session', 'welcome']);
});

ok('garbage in is a signed-out invite, never a throw', () => {
    for (const junk of [undefined, null, {}, { scope: 'weird' }, { saved: 'x', recent: 7 }]) {
        const p = pitch(junk ?? undefined);
        assert.equal(p.stage, 'invite');
    }
});

ok('the dialog’s note names what will be kept — the place being saved first', () => {
    assert.equal(gateNote([]), '');
    assert.equal(gateNote(['Tokyo']), 'Tokyo will be waiting in your account.');
    assert.equal(gateNote(['Paris', 'Lima'], { saving: 'Tokyo' }), 'Tokyo, Paris and Lima will be waiting in your account.');
    assert.equal(gateNote(['Tokyo', 'Paris'], { saving: 'Tokyo' }), 'Tokyo and Paris will be waiting in your account.', 'not listed twice');
    assert.equal(gateNote([], { saving: 'Tokyo' }), 'Tokyo will be waiting in your account.');
});

console.log('search-box helpers');

ok('highlighting marks exactly what matched, and the parts rebuild the label', () => {
    const cases = [['Reykjavík, Iceland', 'reyk ice'], ['São Paulo', 'sao pa'], ['New York', 'york'], ['Tokyo', 'zz'], ['Tromsø', 'trom'], ['Boulder, CO', 'b c'], ['', 'x'], ['Tokyo', '']];
    for (const [label, q] of cases) {
        const parts = highlightParts(label, q);
        assert.equal(parts.map((p) => p.text).join(''), label, `${label}: lossless`);
        for (let i = 1; i < parts.length; i++) assert.notEqual(parts[i].hit, parts[i - 1].hit, 'adjacent parts are merged');
    }
    const hits = (label, q) => highlightParts(label, q).filter((p) => p.hit).map((p) => p.text);
    assert.deepEqual(hits('Reykjavík, Iceland', 'reyk ice'), ['Reyk', 'Ice']);
    assert.deepEqual(hits('São Paulo', 'sao pa'), ['São', 'Pa'], 'an accented letter is one letter');
    assert.deepEqual(hits('New York', 'york'), ['York']);
    assert.deepEqual(hits('New York', 'ork'), [], 'no mid-word marks — the same rule as matchRank');
    assert.deepEqual(hits('Tokyo', 'zz'), []);
    // decomposed input (e + combining acute) keeps the mark with its letter
    assert.deepEqual(hits('México', 'me'), ['Mé']);
    // AGREEMENT with the matcher: whenever a label matches, every query token lit something
    for (const c of MAJOR_CITIES.slice(0, 120)) {
        const q = c.n.slice(0, 3);
        if (matchRank(q, c.n) < 0) continue;
        assert.ok(hits(c.n, q).length > 0, `${c.n} / ${q}`);
    }
});

ok('highlight output is plain text parts — markup in a name stays text', () => {
    const parts = highlightParts('<img src=x onerror=1>', 'img');
    assert.equal(parts.map((p) => p.text).join(''), '<img src=x onerror=1>');
    assert.deepEqual(parts.filter((p) => p.hit).map((p) => p.text), ['img']);
});

ok('first-visit examples come from the city list (no network), one row each', () => {
    const rows = exampleRows(MAJOR_CITIES);
    assert.equal(rows.length, EXAMPLE_CITIES.length, 'every example exists in the city list');
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
    for (const r of rows) {
        assert.equal(r.kind, 'example');
        assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lon) && r.city);
    }
    assert.deepEqual(exampleRows([]), []);
    // and a reader with places of their own is offered THEIRS (suggest), not examples
    assert.equal(suggest('', { cities: MAJOR_CITIES }).length, 0);
});

ok('a save-intent is honoured for 30 minutes and never from the future', () => {
    const tokyo = { lat: 35.6762, lon: 139.6503, city: 'Tokyo', detail: 'Japan' };
    const intent = makeSaveIntent(tokyo, T0);
    assert.equal(intent.at, T0);
    assert.equal(validSaveIntent(intent, T0 + 60_000).city, 'Tokyo');
    assert.equal(validSaveIntent(intent, T0 + SAVE_INTENT_TTL_MS).city, 'Tokyo');
    assert.equal(validSaveIntent(intent, T0 + SAVE_INTENT_TTL_MS + 1), null, 'stale');
    assert.equal(validSaveIntent(intent, T0 - 1), null, 'a clock that went backwards');
    for (const junk of [null, {}, { lat: 1, lon: 2 }, { ...intent, lat: 999 }, { ...intent, at: 'soon' }, 'x']) {
        assert.equal(validSaveIntent(junk, T0 + 1), null, JSON.stringify(junk));
    }
    assert.equal(makeSaveIntent({ lat: 'x' }, T0), null);
    assert.equal(makeSaveIntent(tokyo, NaN), null);
});

console.log('source rules');

const page = readFileSync(new URL('../js/climalytix/page.js', import.meta.url), 'utf8');
const store = readFileSync(new URL('../js/climalytix/places-store.js', import.meta.url), 'utf8');
const gate = readFileSync(new URL('../js/gate-modal.js', import.meta.url), 'utf8');

ok('the page holds no pitch copy or thresholds of its own', () => {
    const render = page.slice(page.indexOf('function renderPitch'), page.indexOf('async function openPlacesGate'));
    assert.ok(render.includes('currentPitch()'));
    assert.doesNotMatch(render, /this session only|tab closes|Keep your|free account saves/i, 'copy belongs to places-pitch.js');
    assert.doesNotMatch(page, /PITCH_STEPS|>= ?3\b.*place/, 'thresholds belong to places-pitch.js');
});

ok('telemetry never carries what the reader typed or where they looked', () => {
    const calls = [...page.matchAll(/note\('([a-z_]+)'(?:,\s*(\{[^}]*\}))?\)/g)];
    assert.ok(calls.length >= 8, `found ${calls.length} telemetry calls`);
    for (const [, action, meta = ''] of calls) {
        assert.doesNotMatch(meta, /\b(q|query|city|lat|lon|name|email|value)\b\s*[:,}]/, `${action}: ${meta}`);
    }
    const actions = new Set(calls.map((c) => c[1]));
    for (const a of ['visit', 'gate', 'gate_unlocked', 'pitch_view', 'pitch_cta', 'pitch_dismiss', 'adopted', 'save', 'unsave', 'clear']) {
        assert.ok(actions.has(a), `funnel step ${a} is instrumented`);
    }
});

ok('no place name, query or pitch text is interpolated into markup unescaped', () => {
    const a = page.indexOf('function renderSuggest'), b = page.indexOf('function onPlacesClick');
    const ui = page.slice(a, b);
    assert.ok(ui.includes('function renderPlaces') && ui.includes('function renderPitch'));
    // say(…) writes textContent, never markup — every other line here builds HTML.
    const html = ui.split('\n').filter((l) => !/\bsay\(/.test(l)).join('\n');
    const raw = [...html.matchAll(/\$\{\s*(?:[a-zA-Z]+\.)?(city|detail|body|headline|label|displayName|q)\s*\}/g)].map((m) => m[0]);
    assert.deepEqual(raw, [], 'wrap these in esc()');
    assert.match(page, /const marked = \(label, q\) => highlightParts\(label, q\)\.map\(\(p\) => \(p\.hit \? `<mark>\$\{esc\(p\.text\)\}<\/mark>` : esc\(p\.text\)\)\)/);
});

ok('the gate dialog escapes and bounds the note; the store keeps the save-intent out of localStorage', () => {
    assert.match(gate, /esc\(String\(opts\.note\)\.slice\(0, 240\)\)/);
    assert.ok(gate.includes("'save-places': {"));
    assert.match(store, /write\(sessionStorage, INTENT_KEY/);
    assert.doesNotMatch(store, /write\(localStorage, INTENT_KEY/, 'an intent must die with the tab');
    assert.match(store, /const REQUIRE_PAID_SYNC = false;/, 'the gate is sign-up, not payment (owner decision)');
});

console.log(`\n${passed} passed`);
