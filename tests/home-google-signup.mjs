/**
 * home-google-signup.mjs — node gate for js/home-google-signup.js, the
 * homepage's one-tap sign-up. Every side effect is injected, so the click is
 * run here end to end with no browser and no Supabase.
 *
 *   node tests/home-google-signup.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { startGoogleSignup, isSignedIn, SIGNUP_FALLBACK } = await import(path.join(ROOT, 'js/home-google-signup.js'));

let failures = 0;
const check = (name, cond, extra = '') => { if (cond) console.log('  ✓ ' + name); else { failures++; console.error('  ✗ ' + name + (extra ? ' — ' + extra : '')); } };

function rig(over = {}) {
    const log = { steps: [], nav: [], calls: [] };
    const deps = {
        source: 'home', origin: 'https://parkersphysics.com',
        loadFunnel: async () => ({ step: (name, props) => log.steps.push([name, props]) }),
        providers: async () => ['google', 'apple'],
        loadAuth: async () => ({ signInWithProvider: async (p, o) => { log.calls.push([p, o]); return { success: true }; } }),
        navigate: (href) => log.nav.push(href),
        ...over,
    };
    return { log, deps };
}

{   // the happy path: Google's OAuth is started, aimed at the callback, and nothing navigates here
    const { log, deps } = rig();
    const out = await startGoogleSignup(deps);
    check('starts Google OAuth and reports redirecting', out === 'redirecting');
    check('one provider call, to google', log.calls.length === 1 && log.calls[0][0] === 'google');
    check('redirectTo is the auth callback, tagged with the source',
        log.calls[0][1].redirectTo === 'https://parkersphysics.com/auth-callback.html?from=home', log.calls[0]?.[1]?.redirectTo);
    check('the shared oauth_button_clicked step fires with source home',
        log.steps.length === 1 && log.steps[0][0] === 'oauth_button_clicked' && log.steps[0][1].provider === 'google' && log.steps[0][1].source === 'home');
    check('no local navigation on success (Supabase redirects)', log.nav.length === 0);
}
{   // the click is counted BEFORE auth loads, so an outage still leaves the datapoint
    const order = [];
    const { deps } = rig({
        loadFunnel: async () => ({ step: (n) => order.push(n) }),
        loadAuth: async () => { order.push('auth'); return { signInWithProvider: async () => ({ success: true }) }; },
    });
    await startGoogleSignup(deps);
    check('funnel step precedes the auth import', order.join() === 'oauth_button_clicked,auth', order.join());
}
// Every failure ends on signup.html — the button is never dead.
for (const [name, over, reason] of [
    ['Google not enabled in SOCIAL_PROVIDERS', { providers: async () => ['apple'] }, 'google_not_enabled'],
    ['auth.js fails to load', { loadAuth: async () => { throw new Error('chunk 404'); } }, 'chunk 404'],
    ['Supabase refuses to start the flow', { loadAuth: async () => ({ signInWithProvider: async () => ({ success: false, error: 'Supabase client not configured' }) }) }, 'Supabase client not configured'],
    ['the provider list cannot be read', { providers: async () => { throw new Error('config 404'); } }, 'config 404'],
]) {
    const { log, deps } = rig(over);
    const out = await startGoogleSignup(deps);
    check(`${name} → falls back to ${SIGNUP_FALLBACK}`, out === 'fallback' && log.nav.length === 1 && log.nav[0] === 'signup.html?from=home', JSON.stringify(log.nav));
    const failed = log.steps.find((s) => s[0] === 'oauth_start_failed');
    check(`${name} → records why`, !!failed && failed[1].reason === reason, failed?.[1]?.reason);
}
{   // a dead funnel must not stop a sign-up
    const { log, deps } = rig({ loadFunnel: async () => { throw new Error('blocked'); } });
    check('a funnel that cannot load does not block the flow', await startGoogleSignup(deps) === 'redirecting' && log.calls.length === 1);
}
{   // the signed-in read is the pp_auth mirror, and tolerates junk
    const store = (v) => ({ getItem: (k) => (k === 'pp_auth' ? v : null) });
    check('signed in via localStorage mirror', isSignedIn([store('{"signedIn":true}'), store(null)]));
    check('signed in via sessionStorage mirror', isSignedIn([store(null), store('{"signedIn":true}')]));
    check('signed out', !isSignedIn([store('{"signedIn":false}'), store(null)]));
    check('corrupt mirror reads as signed out', !isSignedIn([store('{nope'), { getItem() { throw new Error('denied'); } }]));
}
console.log(failures ? `\n❌ ${failures} failure(s)` : '\n✅ home google sign-up');
process.exit(failures ? 1 : 0);
