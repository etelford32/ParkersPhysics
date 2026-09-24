/**
 * supabase-session.mjs — a signed-in browser session with NO real backend.
 * ═══════════════════════════════════════════════════════════════════════════
 * The tests/auth-e2e.spec.js pattern, shared: a structurally valid unsigned
 * JWT seeded where supabase-js looks for it, and every /auth/v1 and /rest/v1
 * call answered locally. The pp_auth mock that tests/auth-tier-redirect.spec.js
 * seeds only applies when the Supabase client FAILS to initialise; the client
 * is self-hosted and initialises offline, finds no session and bounces to
 * sign-in (measured 2026-09-24).
 *
 *   await stubSupabaseSession(page, { plan: 'advanced', role: 'user',
 *       tables: { satellite_alerts: [...] } });
 *
 * `tables` answers GET /rest/v1/<table> with those rows (every other table:
 * []). Routes are registered in the order Playwright needs: it matches in
 * REVERSE registration order, so the catch-alls go first.
 */

const PROJECT_REF = 'aijsboodkivnhzfstvdq';
const USER_ID = '00000000-0000-0000-0000-0000000abcde';
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (sub) => `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, role: 'authenticated', aud: 'authenticated', exp: 9999999999 })}.sig`;
const json = (obj, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(obj) });

export async function stubSupabaseSession(page, { plan = 'free', role = 'user', tables = {} } = {}) {
    const user = {
        id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'links@playwright.test',
        user_metadata: { full_name: 'Link Tester' }, app_metadata: { provider: 'email' },
    };
    const session = {
        access_token: fakeJwt(USER_ID), token_type: 'bearer', expires_in: 3600,
        expires_at: 9999999999, refresh_token: 'fake-refresh-token', user,
    };
    const profile = { id: USER_ID, email: user.email, plan, role, full_name: 'Link Tester' };
    await page.route('**/rest/v1/**', (r) => r.fulfill(json([])));
    for (const [table, rows] of Object.entries(tables)) {
        await page.route(`**/rest/v1/${table}**`, (r) => r.fulfill(json(rows)));
    }
    await page.route('**/auth/v1/**', (r) => r.fulfill(json({})));
    await page.route('**/auth/v1/user**', (r) => r.fulfill(json(user)));
    await page.route('**/auth/v1/token**', (r) => r.fulfill(json(session)));
    // auth.js reads the profile with .single(), which asks PostgREST for an
    // OBJECT (Accept: application/vnd.pgrst.object+json). Answering with an
    // array leaves role undefined and the admin gate refuses — answer in the
    // shape that was asked for.
    await page.route('**/rest/v1/user_profiles**', (r) => {
        const one = /vnd\.pgrst\.object/.test(r.request().headers().accept || '');
        return r.fulfill(json(one ? profile : [profile]));
    });
    await page.route('**/rest/v1/rpc/**', (r) => r.fulfill(json(plan)));
    await page.addInitScript(({ key, session }) => {
        localStorage.setItem(key, JSON.stringify(session));
        localStorage.setItem('pp_consent_v1', JSON.stringify({ strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
        localStorage.setItem('pp_tour_completed', '1');
    }, { key: `sb-${PROJECT_REF}-auth-token`, session });
    return { userId: USER_ID };
}
