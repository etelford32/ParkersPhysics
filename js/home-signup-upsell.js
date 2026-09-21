/**
 * home-signup-upsell.js — the homepage's passwordless sign-up upsell
 * (index.html, under the primary CTA in the hero's left column).
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE email field, ONE button: "Send my magic link". Submitting calls
 * js/auth.js `signInWithMagicLink(email, { createUser: true })`, so a new
 * visitor gets an account on the first link click with no password to
 * invent, and a returning one simply signs in. Supabase answers success
 * either way (anti-enumeration), so the sent state never says which.
 *
 * ── The 2026-09-06 ONE ASK decision, and why this exists anyway ──────────
 * index.html's "ONE ASK" note records that the previous hero email
 * capture drew 0 submissions in 60 days and was removed. This upsell was
 * re-added on 2026-09-21 at the author's explicit request as a DIFFERENT
 * ask: passwordless, one field, framed as "your sky by email" rather than
 * "create an account". It carries its own funnel ids
 * (`hero_magic_link` on the button, `magic_link_sent` on success) so the
 * next funnel read can judge it on its own numbers. If they come back at
 * zero again, remove it — do not tweak the copy for a third try.
 *
 * ── Behaviour ─────────────────────────────────────────────────────────────
 *   • Hidden for signed-in visitors (the pp_auth localStorage mirror at
 *     mount, then 'auth-changed'), same read as the console's chip.
 *   • auth.js is imported LAZILY on the first submit — the hero's boot
 *     path pays nothing for Supabase.
 *   • Client-side email check is deliberately loose (`looksLikeEmail`):
 *     the server decides; we only stop obvious typos before a round trip.
 *   • States: idle → sending → sent (with a 60 s resend leash, the
 *     signin.html convention) | error (message from auth.js, never a
 *     stack). Reduced motion disables the glow pulse.
 *
 * Node gate: `node tests/home-signup-upsell.mjs` (looksLikeEmail, the
 * state reducer). Browser gate: tests/home-hero-stage.spec.js.
 */

const CSS = `
.hsu{position:relative;z-index:1;margin:18px 0 0;padding:14px 16px 13px;border-radius:16px;
  background:linear-gradient(180deg,rgba(20,8,52,.82),rgba(8,3,26,.82));border:1px solid rgba(154,133,255,.26);
  box-shadow:0 12px 40px rgba(2,0,10,.45),inset 0 1px 0 rgba(255,255,255,.08);backdrop-filter:blur(8px);color:var(--fg-2,#cdd8f0)}
.hsu[hidden]{display:none}
.hsu-k{font-family:var(--font-mono,monospace);font-size:.6rem;letter-spacing:.14em;text-transform:uppercase;color:#8ff0ff;margin-bottom:4px}
.hsu-t{font-family:var(--font-display,inherit);font-weight:700;font-size:.95rem;color:#fff;letter-spacing:.01em;margin:0 0 3px}
.hsu-d{font-size:.76rem;line-height:1.45;color:var(--fg-3,#8b94ad);margin:0 0 10px}
.hsu-form{display:flex;gap:8px;flex-wrap:wrap}
.hsu-form input{flex:1 1 200px;min-width:0;padding:11px 14px;border-radius:12px;font:inherit;font-size:.86rem;color:#fff;
  background:rgba(4,1,16,.75);border:1px solid rgba(154,133,255,.32);outline:none;
  box-shadow:inset 0 2px 6px rgba(0,0,0,.5),inset 0 -1px 0 rgba(255,255,255,.05)}
.hsu-form input::placeholder{color:var(--fg-4,#6b7390)}
.hsu-form input:focus{border-color:#8ff0ff;box-shadow:inset 0 2px 6px rgba(0,0,0,.5),0 0 0 3px rgba(143,240,255,.18)}
.hsu-btn{flex:0 0 auto;padding:11px 18px;border-radius:12px;border:0;cursor:pointer;font-family:var(--font-display,inherit);
  font-weight:700;font-size:.74rem;letter-spacing:.1em;text-transform:uppercase;color:#fff;white-space:nowrap;
  background:linear-gradient(180deg,#b765ff 0%,#9d3aff 45%,#7b00ee 100%);
  box-shadow:0 1px 0 rgba(255,255,255,.35) inset,0 -3px 0 rgba(60,0,140,.9) inset,0 6px 0 #4a0a9a,0 10px 24px rgba(157,58,255,.45);
  transition:transform .08s,box-shadow .12s,filter .2s}
.hsu-btn:hover{filter:brightness(1.1);transform:translateY(-1px);
  box-shadow:0 1px 0 rgba(255,255,255,.4) inset,0 -3px 0 rgba(60,0,140,.9) inset,0 7px 0 #4a0a9a,0 14px 30px rgba(157,58,255,.55)}
.hsu-btn:active{transform:translateY(4px);box-shadow:0 1px 0 rgba(255,255,255,.2) inset,0 -1px 0 rgba(60,0,140,.9) inset,0 2px 0 #4a0a9a,0 4px 12px rgba(157,58,255,.35)}
.hsu-btn[disabled]{opacity:.6;cursor:default;transform:none}
.hsu-btn:focus-visible{outline:2px solid #8ff0ff;outline-offset:3px}
.hsu-note{font-size:.66rem;color:var(--fg-4,#6b7390);margin:8px 0 0;line-height:1.4}
.hsu-note b{color:var(--fg-3,#8b94ad);font-weight:600}
.hsu-msg{font-size:.78rem;margin:8px 0 0;line-height:1.45}
.hsu[data-state="sent"] .hsu-msg{color:#2eff9e}
.hsu[data-state="error"] .hsu-msg{color:#ff8c5a}
.hsu[data-state="sent"] .hsu-form,.hsu[data-state="sent"] .hsu-note{display:none}
.hsu-resend{background:none;border:0;color:#8ff0ff;font:inherit;font-size:.76rem;cursor:pointer;padding:0;text-decoration:underline}
.hsu-resend[disabled]{color:var(--fg-4,#6b7390);cursor:default;text-decoration:none}
@media (prefers-reduced-motion:no-preference){
  .hsu::before{content:'';position:absolute;inset:-1px;border-radius:17px;pointer-events:none;
    background:linear-gradient(120deg,transparent 30%,rgba(143,240,255,.18) 50%,transparent 70%);
    background-size:220% 100%;animation:hsu-sheen 6s ease-in-out infinite;mix-blend-mode:screen}
  @keyframes hsu-sheen{0%,60%{background-position:120% 0}100%{background-position:-120% 0}}}
@media (max-width:640px){.hsu{padding:12px 14px}.hsu-btn{flex:1 1 100%}}
`;

/** Loose, client-side only — the server is the judge. */
export function looksLikeEmail(v) {
    const s = String(v ?? '').trim();
    if (s.length < 6 || s.length > 254) return false;
    const at = s.indexOf('@');
    if (at < 1 || at !== s.lastIndexOf('@')) return false;
    const domain = s.slice(at + 1);
    return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.') && !/\s/.test(s);
}

/**
 * Pure state reducer for the widget (node-tested).
 * @param {{state:string, email:string, resendAt:number}} st
 * @param {{type:string, email?:string, error?:string, now?:number}} ev
 */
export function reduce(st, ev) {
    switch (ev.type) {
        case 'submit':
            if (!looksLikeEmail(ev.email)) return { ...st, state: 'error', error: 'That does not look like an email address.' };
            return { ...st, state: 'sending', email: ev.email.trim(), error: null };
        case 'sent':
            return { ...st, state: 'sent', error: null, resendAt: (ev.now ?? Date.now()) + 60_000 };
        case 'fail':
            return { ...st, state: 'error', error: ev.error || 'Could not send the link. Try again in a moment.' };
        case 'reset':
            return { state: 'idle', email: st.email, error: null, resendAt: 0 };
        default:
            return st;
    }
}

function signedIn() {
    try {
        const raw = localStorage.getItem('pp_auth') || sessionStorage.getItem('pp_auth');
        if (!raw) return false;
        const j = JSON.parse(raw);
        return !!(j && (j.email || j.user?.email || j.id));
    } catch { return false; }
}

/**
 * @param {HTMLElement} host
 * @param {{ track?: function(string, object):void, authLoader?: function():Promise<any> }} [opts]
 */
export function mountSignupUpsell(host, opts = {}) {
    if (!host) return null;
    if (!document.getElementById('hsu-styles')) {
        const s = document.createElement('style'); s.id = 'hsu-styles'; s.textContent = CSS; document.head.appendChild(s);
    }
    const track = opts.track ?? (() => {});
    const authLoader = opts.authLoader ?? (() => import('./auth.js').then((m) => m.auth ?? m.default ?? m));

    const el = document.createElement('section');
    el.className = 'hsu';
    el.id = 'hero-signup';
    el.setAttribute('aria-label', 'Get your sky by email');
    el.dataset.state = 'idle';
    el.innerHTML = `
        <div class="hsu-k">Your sky, in your inbox</div>
        <h2 class="hsu-t">Storm alerts for your location — no password</h2>
        <p class="hsu-d">One email. Click the link and your free account is ready: saved location, aurora and storm alerts, your dashboards.</p>
        <form class="hsu-form" novalidate>
            <input type="email" name="email" inputmode="email" autocomplete="email" placeholder="you@example.com" aria-label="Email address" required>
            <button type="submit" class="hsu-btn" data-funnel-cta="hero_magic_link">Send my magic link →</button>
        </form>
        <p class="hsu-note"><b>Free forever</b> · one link, no password to invent · no credit card · unsubscribe any time</p>
        <p class="hsu-msg" role="status" aria-live="polite"></p>`;
    host.appendChild(el);

    const form = el.querySelector('form');
    const input = el.querySelector('input');
    const btn = el.querySelector('.hsu-btn');
    const msg = el.querySelector('.hsu-msg');
    let st = { state: 'idle', email: '', error: null, resendAt: 0 };
    let resendTimer = 0;

    function render() {
        el.dataset.state = st.state;
        btn.disabled = st.state === 'sending';
        btn.textContent = st.state === 'sending' ? 'Sending…' : 'Send my magic link →';
        if (st.state === 'sent') {
            const left = Math.max(0, Math.ceil((st.resendAt - Date.now()) / 1000));
            msg.innerHTML = `Check your inbox — we sent a sign-in link to <b>${escapeHtml(st.email)}</b>. `
                + `<button type="button" class="hsu-resend" ${left > 0 ? 'disabled' : ''}>${left > 0 ? `Resend (${left}s)` : 'Resend'}</button>`;
            msg.querySelector('.hsu-resend')?.addEventListener('click', () => { st = reduce(st, { type: 'reset' }); render(); input.value = st.email; input.focus(); });
            clearTimeout(resendTimer);
            if (left > 0) resendTimer = setTimeout(render, 1000);
        } else if (st.state === 'error') {
            msg.textContent = st.error;
        } else {
            msg.textContent = '';
        }
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        st = reduce(st, { type: 'submit', email: input.value });
        render();
        if (st.state !== 'sending') return;
        try {
            const auth = await authLoader();
            const res = await auth.signInWithMagicLink(st.email, { createUser: true });
            if (res?.success) {
                st = reduce(st, { type: 'sent' });
                track('magic_link_sent', { surface: 'hero' });
            } else {
                st = reduce(st, { type: 'fail', error: res?.error });
            }
        } catch (err) {
            st = reduce(st, { type: 'fail', error: err?.message });
        }
        render();
    });

    function applyAuth() { el.hidden = signedIn(); }
    applyAuth();
    window.addEventListener('auth-changed', applyAuth);

    return {
        el,
        get state() { return { ...st, hidden: el.hidden }; },
        dispose() { clearTimeout(resendTimer); window.removeEventListener('auth-changed', applyAuth); el.remove(); },
    };
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
