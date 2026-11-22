/**
 * home-google-signup.js — the homepage's one-click sign-up (index.html #hero)
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE button: "Sign up with Google". A click starts Supabase's OAuth flow
 * through js/auth.js `signInWithProvider('google')` — the same call the
 * sign-in / sign-up pages make via js/oauth-buttons.js — and Google hands
 * the visitor back to /auth-callback.html signed in. A first-time Google
 * account is CREATED by that round trip, so this is a sign-up with no form;
 * a returning one is simply signed in.
 *
 * Why it is not js/oauth-buttons.js mounted here: that module renders its own
 * dark provider buttons into a mount and imports auth.js at the top. This
 * button is static markup in the first paint (it must be there before any
 * module arrives, styled as part of the header), so this module only WIRES
 * it, and imports auth.js + the funnel on the CLICK — it adds nothing to the
 * first screen's own module graph. (js/nav.js loads auth.js on its own
 * schedule, so by the time anyone clicks it is normally already cached.)
 *
 * Added 2026-11-22 at the owner's request, over the 2026-09-06 "ONE ASK"
 * note (60 days of funnel: 0 clicks on "Get started free", 0 hero email
 * submissions). It is a DIFFERENT ask — no field, no password, one tap —
 * with its own funnel id (`launchpad_signup_google`, plus the shared
 * `oauth_button_clicked` step with source 'home'), so the next funnel read
 * can judge it alone. If it reads zero again, remove it.
 *
 * Behaviour
 *   • Hidden for signed-in visitors (the pp_auth mirror at mount, then
 *     'auth-changed') together with anything marked [data-signup-only].
 *   • If Google is not in js/config.js SOCIAL_PROVIDERS, or the flow cannot
 *     start, the visitor is SENT TO signup.html — a dead button is the one
 *     outcome this must never have.
 *   • Double clicks cannot double-fire: the button disables on the first.
 *
 * Contract: mountGoogleSignup(button, { source, deps }) → { state }
 *   `deps` ({ loadAuth, loadFunnel, providers, navigate }) exists for the
 *   node gate (tests/home-google-signup.mjs); the page passes none.
 */
export const SIGNUP_FALLBACK = 'signup.html';

export function isSignedIn(storage) {
    for (const s of storage) {
        try {
            const raw = s?.getItem('pp_auth');
            if (raw && JSON.parse(raw)?.signedIn) return true;
        } catch {}
    }
    return false;
}

/**
 * The click, with every side effect injected. Resolves to
 * 'redirecting' | 'fallback'.
 */
export async function startGoogleSignup({ source = 'home', origin, loadAuth, loadFunnel, providers, navigate }) {
    let funnel = null;
    try { funnel = await loadFunnel(); } catch {}
    try { funnel?.step('oauth_button_clicked', { provider: 'google', source }); } catch {}
    const fallback = (reason) => {
        try { funnel?.step('oauth_start_failed', { provider: 'google', source, reason: String(reason || 'unknown').slice(0, 120) }); } catch {}
        navigate(`${SIGNUP_FALLBACK}?from=${encodeURIComponent(source)}`);
        return 'fallback';
    };
    try {
        const list = await providers();
        if (!Array.isArray(list) || !list.includes('google')) return fallback('google_not_enabled');
        const auth = await loadAuth();
        const res = await auth.signInWithProvider('google', {
            redirectTo: `${origin}/auth-callback.html?from=${encodeURIComponent(source)}`,
        });
        if (!res?.success) return fallback(res?.error || 'oauth_start_failed');
        return 'redirecting';
    } catch (err) {
        return fallback(err?.message);
    }
}

export function mountGoogleSignup(button, opts = {}) {
    if (!button) return null;
    const source = opts.source || 'home';
    const deps = {
        loadAuth:   () => import('./auth.js').then((m) => m.auth),
        loadFunnel: () => import('./auth-funnel.js').then((m) => m.funnel),
        providers:  () => import('./config.js').then((m) => m.SOCIAL_PROVIDERS),
        navigate:   (href) => { window.location.href = href; },
        ...(opts.deps || {}),
    };
    const scope = button.closest('[data-signup-scope]') || document;
    const signupOnly = () => [button, ...scope.querySelectorAll('[data-signup-only]')];
    const sync = () => {
        const inn = isSignedIn([window.localStorage, window.sessionStorage]);
        for (const n of signupOnly()) n.hidden = inn;
    };
    sync();
    window.addEventListener('auth-changed', sync);

    const ctl = { state: 'idle' };
    const label = button.querySelector('[data-label]');
    const idleText = label?.textContent;
    button.addEventListener('click', async () => {
        if (ctl.state !== 'idle') return;
        ctl.state = 'starting';
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        if (label) label.textContent = 'Redirecting to Google…';
        ctl.state = await startGoogleSignup({ source, origin: window.location.origin, ...deps });
        if (ctl.state === 'fallback') {            // navigating to signup.html; restore in case of bfcache return
            button.disabled = false; button.removeAttribute('aria-busy');
            if (label && idleText) label.textContent = idleText;
            ctl.state = 'idle';
        }
    });
    return ctl;
}
