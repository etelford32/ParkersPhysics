/**
 * tests/temperature-lab-access.mjs — the lab's Free / Intro ladder (plan §7)
 *
 *   node tests/temperature-lab-access.mjs
 *
 * Gates: the three rungs map from auth the way AurOracle's do; the limits only
 * ever GROW up the ladder; each locked reach picks the gate for the visitor's
 * rung (never a paid gate for something a free account would open); the
 * controller fires onChange only on a REAL change and keeps exactly one rung
 * class on the target.
 */
import assert from 'node:assert/strict';
import {
    ACCESS_LEVELS, LIMITS, accessFor, classesFor, gateFor, createAccessController,
} from '../js/temperature-lab-access.js';

let passed = 0;
function ok(name, fn) { fn(); passed++; console.log(`  ✓ ${name}`); }
console.log('temperature-lab-access.mjs');

ok('rungs: signed out → teaser (provisional → free); free → free; basic and up → intro', () => {
    assert.equal(accessFor({ signedIn: false }), 'teaser');
    assert.equal(accessFor({ signedIn: false, provisional: true }), 'free');
    assert.equal(accessFor({ signedIn: true, plan: 'free' }), 'free');
    for (const plan of ['basic', 'educator', 'advanced', 'institution', 'enterprise', 'tester']) {
        assert.equal(accessFor({ signedIn: true, plan }), 'intro', plan);
    }
    assert.equal(accessFor({ signedIn: true, plan: 'free', role: 'admin' }), 'intro');
});

ok('limits only grow up the ladder; the 30-day calendar is Intro only', () => {
    for (let i = 1; i < ACCESS_LEVELS.length; i++) {
        const lo = LIMITS[ACCESS_LEVELS[i - 1]], hi = LIMITS[ACCESS_LEVELS[i]];
        assert.ok(hi.rows > lo.rows);
        assert.ok(hi.outlookDays >= lo.outlookDays);
        for (const k of ['filters', 'calendar']) assert.ok(!lo[k] || hi[k], `${k} never lost`);
    }
    assert.equal(LIMITS.intro.rows, 25, 'the snapshot carries exactly the top 25');
    assert.deepEqual(ACCESS_LEVELS.map(a => LIMITS[a].calendar), [false, false, true]);
});

ok('gateFor: the gate follows the visitor\'s rung, never a paywall for a free reward', () => {
    assert.equal(gateFor('teaser', 'rows'), 'temp-lab-scorecards');
    assert.equal(gateFor('teaser', 'filters'), 'temp-lab-scorecards');
    assert.equal(gateFor('teaser', 'outlook'), 'temp-lab-outlook-week');
    assert.equal(gateFor('teaser', 'calendar'), 'temp-lab-outlook-30day');
    assert.equal(gateFor('free', 'rows'), null);
    assert.equal(gateFor('free', 'calendar'), 'temp-lab-outlook-30day');
    for (const w of ['rows', 'filters', 'outlook', 'calendar']) assert.equal(gateFor('intro', w), null);
});

ok('controller: one class at a time, onChange only on a real change', () => {
    const cls = new Set();
    const target = { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) } };
    const who = { signedIn: false, plan: 'free' };
    const auth = { isSignedIn: () => who.signedIn, getPlan: () => who.plan, getRole: () => '' };
    const seen = [];
    const ctl = createAccessController({ auth, target, onChange: (a, l) => seen.push([a, l.rows]) });
    assert.equal(ctl.refresh(), true);
    assert.deepEqual([...cls], ['tl-teaser']);
    assert.equal(ctl.refresh(), false, 'a no-op auth-changed does not re-render');
    who.signedIn = true;
    ctl.refresh();
    who.plan = 'basic';
    ctl.refresh();
    assert.deepEqual([...cls], ['tl-intro']);
    assert.deepEqual(seen, [['teaser', 3], ['free', 10], ['intro', 25]]);
    assert.equal(ctl.unlockFree(), false, 'an optimistic free unlock never demotes Intro');
});

ok('controller: a throwing auth fails to the teaser (or free when provisional), never open', () => {
    const auth = { isSignedIn: () => { throw new Error('boom'); } };
    assert.equal((() => { const c = createAccessController({ auth }); c.refresh(); return c.access; })(), 'teaser');
    const c2 = createAccessController({ auth, hasProvisional: () => true });
    c2.refresh();
    assert.equal(c2.access, 'free');
    assert.deepEqual(classesFor('free'), { 'tl-teaser': false, 'tl-free': true, 'tl-intro': false });
});

console.log(`\n${passed} passed`);
