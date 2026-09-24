/**
 * climate-lab/lab-account.js — the lab's ONLY path to user_profiles writes.
 * ═══════════════════════════════════════════════════════════════════════════
 * Why not `auth.updateProfile()`? Two measured properties of it make it the
 * wrong tool for a control that has to say "Saved" truthfully:
 *   1. It never reports failure — the upsert's `{error}` is not inspected,
 *      so a caller cannot tell a saved Home from a rejected one.
 *   2. It re-sends `plan` on every call; the plan-lockdown trigger
 *      (supabase-plan-lockdown-migration.sql) raises 42501 whenever the
 *      locally cached plan differs from the stored one, silently dropping
 *      an unrelated location or alert save.
 * This is the js/account.js `updateOwnProfile` pattern instead: an UPDATE of
 * only the columns being changed, the error returned to the caller, then
 * `auth.fetchProfile()` so `getAlertPrefs()` / `getUser().location` and the
 * pp_auth mirror converge (fetchProfile dispatches 'auth-changed').
 *
 * The whitelist is the set of columns the lab edits — location and the
 * alert preferences that already exist. Nothing here can touch plan, role,
 * Stripe or seat columns, and no schema is assumed beyond what is live.
 */

// auth.js / supabase-config.js are imported lazily inside updateOwnProfile():
// auth.js touches `window` at import, and the whitelist below must stay
// node-testable (it is the guarantee that the lab never writes plan/role).

export const WRITABLE_COLUMNS = Object.freeze(new Set([
    'location_lat', 'location_lon', 'location_city',
    'notify_aurora', 'notify_storm', 'notify_flare', 'notify_cme', 'notify_temperature',
    'notify_radio_blackout', 'notify_gps', 'notify_power_grid', 'notify_iono_disturbance',
    'notify_recurrence',
    'aurora_kp_threshold', 'storm_g_threshold', 'flare_class_threshold',
    'temp_high_f', 'temp_low_f',
    'radio_r_threshold', 'gnss_risk_threshold', 'power_grid_g_threshold',
    'email_alerts', 'email_min_severity', 'alert_cooldown_min',
]));

/** Keep only whitelisted keys (pure — exported for the node gate). */
export function whitelistPatch(patch) {
    const row = {};
    for (const [k, v] of Object.entries(patch || {})) {
        if (WRITABLE_COLUMNS.has(k) && v !== undefined) row[k] = v;
    }
    return row;
}

/**
 * UPDATE the signed-in user's own profile row.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function updateOwnProfile(patch) {
    const row = whitelistPatch(patch);
    if (!Object.keys(row).length) return { ok: true };
    const [{ auth }, { getSupabase, isConfigured }] = await Promise.all([
        import('../auth.js'), import('../supabase-config.js'),
    ]);
    if (!isConfigured()) return { ok: false, error: 'Account service is not configured' };
    const uid = auth.getUser?.()?.id;
    if (!uid) return { ok: false, error: 'Sign in to save to your account' };
    try {
        const sb = await getSupabase();
        if (!sb) return { ok: false, error: 'Account service unavailable' };
        const { data, error } = await sb
            .from('user_profiles')
            .update({ ...row, updated_at: new Date().toISOString() })
            .eq('id', uid)
            .select('id');
        if (error) return { ok: false, error: error.message };
        // RLS hides a missing row as "0 rows updated, no error" — say so.
        if (Array.isArray(data) && data.length === 0) return { ok: false, error: 'Profile row not found' };
    } catch (e) {
        return { ok: false, error: e?.message || 'Save failed' };
    }
    try { await auth.fetchProfile?.(); } catch { /* the save itself succeeded */ }
    return { ok: true };
}
