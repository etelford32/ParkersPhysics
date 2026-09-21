// tests/home-signup-upsell.mjs — pure half of js/home-signup-upsell.js
import assert from 'node:assert/strict';
import { looksLikeEmail, reduce } from '../js/home-signup-upsell.js';

for (const ok of ['a@b.co', 'first.last+tag@sub.example.org', '  x@y.io ']) assert.ok(looksLikeEmail(ok), ok);
for (const bad of ['', 'plain', '@x.com', 'a@b', 'a@@b.com', 'a b@c.com', 'a@.com', 'a@com.', null, undefined])
    assert.ok(!looksLikeEmail(bad), String(bad));

let st = { state: 'idle', email: '', error: null, resendAt: 0 };
st = reduce(st, { type: 'submit', email: 'nope' });
assert.equal(st.state, 'error'); assert.match(st.error, /email/);
st = reduce(st, { type: 'submit', email: ' me@parkersphysics.com ' });
assert.equal(st.state, 'sending'); assert.equal(st.email, 'me@parkersphysics.com'); assert.equal(st.error, null);
st = reduce(st, { type: 'sent', now: 1000 });
assert.equal(st.state, 'sent'); assert.equal(st.resendAt, 61_000, '60 s resend leash');
st = reduce(st, { type: 'reset' });
assert.equal(st.state, 'idle'); assert.equal(st.email, 'me@parkersphysics.com', 'email survives a reset');
st = reduce({ ...st, state: 'sending' }, { type: 'fail' });
assert.equal(st.state, 'error'); assert.match(st.error, /Try again/);
st = reduce(st, { type: 'fail', error: 'Rate limited' });
assert.equal(st.error, 'Rate limited', 'server message wins');
assert.equal(reduce(st, { type: 'bogus' }), st, 'unknown events are no-ops');
console.log('home-signup-upsell: all assertions passed');
