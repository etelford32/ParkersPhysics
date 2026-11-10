/**
 * Node gate for js/climalytix/layer-state.js — what the Temperature controls
 * may claim, given the data behind them.
 *
 * The bug it pins (production, 2026-11-09): with our GFS archive unpublished
 * the rail showed Temperature ticked with live Isotherms / Warmest-coldest
 * toggles, a live opacity slider and a colour key on the map — over a map
 * with no temperature drawn. The rule: a control is live only while it can
 * change what is drawn; the checkbox alone keeps the reader's intent.
 */
import assert from 'node:assert/strict';
import { tempControlState, overlayBadge, BADGES } from '../js/climalytix/layer-state.js';

const DOWN_NOTE = 'No heat map: no GFS run has been ingested yet. Nothing is substituted for our archive.';

// ── on: data and a frame ⇒ everything live, nothing said ────────────────────
for (const fieldState of ['live', 'stale']) {
    assert.deepEqual(tempControlState({ checked: true, fieldState, frameT: 2, note: 'GFS run …' }), {
        mode: 'on', drawable: true, subEnabled: true, keyOnMap: true, canRetry: false, badge: null, notice: '',
    }, `${fieldState}: a served run (even an old one) is drawable`);
}
assert.equal(tempControlState({ checked: true, fieldState: 'live', frameT: 0 }).mode, 'on', 'frame index 0 is a frame');

// ── down: ticked, but nothing to change ─────────────────────────────────────
{
    const s = tempControlState({ checked: true, fieldState: 'down', frameT: null, note: DOWN_NOTE });
    assert.equal(s.mode, 'down');
    assert.equal(s.subEnabled, false, 'Isotherms / Warmest-coldest / opacity cannot change an absent field');
    assert.equal(s.keyOnMap, false, 'no colour key over a map with no temperature on it');
    assert.equal(s.canRetry, true);
    assert.equal(s.badge, BADGES.down);
    assert.equal(s.notice, 'Temperature is not drawn — no GFS run has been ingested yet. Nothing is substituted for our archive.',
        'the notice carries the loader\'s reason once, without a doubled lead-in');
    assert.match(tempControlState({ checked: true, fieldState: 'down', frameT: null }).notice, /our archive did not answer/,
        'a missing note still says something');
}

// ── notime: a run, but not at this instant ──────────────────────────────────
{
    const s = tempControlState({ checked: true, fieldState: 'live', frameT: null });
    assert.equal(s.mode, 'notime');
    assert.deepEqual([s.subEnabled, s.keyOnMap, s.canRetry], [false, false, false], 'retrying cannot extend a run');
    assert.match(s.notice, /does not cover this time/);
    assert.equal(tempControlState({ checked: true, fieldState: 'live', frameT: undefined }).mode, 'notime');
}

// ── loading: not a failure, not yet a field ─────────────────────────────────
for (const fieldState of ['loading', undefined]) {
    const s = tempControlState({ checked: true, fieldState, frameT: null });
    assert.equal(s.mode, 'loading');
    assert.deepEqual([s.subEnabled, s.keyOnMap, s.canRetry, s.notice], [false, false, false, '']);
}

// ── off: the reader's choice — never a notice, never a red badge ────────────
for (const fieldState of ['live', 'down', 'loading']) {
    const s = tempControlState({ checked: false, fieldState, frameT: fieldState === 'live' ? 3 : null, note: DOWN_NOTE });
    assert.deepEqual([s.mode, s.subEnabled, s.keyOnMap, s.canRetry, s.badge, s.notice], ['off', false, false, false, null, ''],
        `${fieldState}: unticked is just off`);
}

// ── invariants over the whole input space ───────────────────────────────────
for (const checked of [true, false]) for (const fieldState of ['loading', 'live', 'stale', 'down', undefined]) for (const frameT of [null, 0, 5]) {
    const s = tempControlState({ checked, fieldState, frameT, note: 'x' });
    assert.equal(s.subEnabled, s.drawable);
    assert.equal(s.keyOnMap, s.drawable);
    assert.equal(s.drawable, s.mode === 'on');
    assert.equal(Boolean(s.notice), s.mode === 'down' || s.mode === 'notime', 'a notice exactly when a ticked layer cannot draw');
    if (s.canRetry) assert.equal(s.mode, 'down');
}

// ── overlayBadge (Airflow) ──────────────────────────────────────────────────
assert.equal(overlayBadge({ checked: true, state: 'live', t: 2 }), null);
assert.equal(overlayBadge({ checked: true, state: 'down', t: null }), 'No data');
assert.equal(overlayBadge({ checked: true, state: 'loading', t: null }), 'Loading');
assert.equal(overlayBadge({ checked: true, state: 'live', t: null }), 'No frame');
assert.equal(overlayBadge({ checked: false, state: 'down', t: null }), null, 'an unticked layer keeps its source label');

console.log('climalytix-layer-state: on / down / notime / loading / off, invariants and the overlay badge passed');
