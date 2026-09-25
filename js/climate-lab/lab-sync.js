/**
 * climate-lab/lab-sync.js — cross-device sync of the lab's preferences.
 * ═══════════════════════════════════════════════════════════════════════════
 * The same posture and the same table as the space-weather dashboard's D2
 * sync (js/dashboard-sync.js), reused rather than re-decided:
 *   · LOCAL-FIRST — lab-prefs.js boots from localStorage; this reconciles
 *     around it and every failure is quiet (the lab works exactly as before).
 *   · ONE ROW in public.dashboards: (user_id, page = 'climate-lab',
 *     name = 'default'), doc = { prefs }. That table is already applied
 *     (supabase-dashboards-migration.sql, 2026-07-22), has owner-only RLS
 *     and no CHECK on `page` — so no schema change.
 *   · TIER GATE and CONFLICT RULE are imported from dashboard-sync.js
 *     (`tierAllowsSync`: Basic+ / tester / admin, decision #2;
 *     `pickNewer`: last write wins by updated_at). One decision, one copy.
 *   · A newer remote doc lands through `savePrefs(..., {source:'cloud'})`,
 *     whose event every lab surface already re-renders from — so unlike the
 *     layout sync, no page reload is needed.
 *
 * The HOME LOCATION does not ride here — it is account data on
 * user_profiles (lab-home.js), available on every tier.
 */

import { normalizePrefs, loadPrefs, savePrefs, PREFS_META_KEY, PREFS_EVENT, PREFS_VERSION } from './lab-prefs.js';

const PAGE = 'climate-lab';
const NAME = 'default';

function readMeta() {
    try { return JSON.parse(localStorage.getItem(PREFS_META_KEY) || 'null'); } catch { return null; }
}
function writeMeta(updatedAt) {
    try { localStorage.setItem(PREFS_META_KEY, JSON.stringify({ updatedAt })); } catch {}
}

/**
 * Start sync for the signed-in user. Resolves to a small status object
 * (`state` ∈ off:* | ready | synced | error) the lab's footer prints.
 */
export async function startLabSync({ auth } = {}) {
    const sync = { state: 'off', lastError: null };
    try {
        if (!auth?.isSignedIn?.()) { sync.state = 'off:signed-out'; return sync; }
        const uid = auth.getUser?.()?.id;
        if (!uid) { sync.state = 'off:signed-out'; return sync; }
        const [{ tierAllowsSync, pickNewer }, { getSupabase, isConfigured }] = await Promise.all([
            import('../dashboard-sync.js'),
            import('../supabase-config.js'),
        ]);
        const plan = (auth.getPlan?.() || 'free').toLowerCase();
        const role = (auth.getRealRole?.() || auth.getRole?.() || 'user').toLowerCase();
        if (!tierAllowsSync(plan, role)) { sync.state = 'off:tier'; return sync; }
        if (!isConfigured()) { sync.state = 'off:unconfigured'; return sync; }
        const sb = await getSupabase();
        if (!sb) { sync.state = 'off:unconfigured'; return sync; }
        sync.state = 'ready';

        // ── Pull ───────────────────────────────────────────────────────────
        const { data: row, error } = await sb.from('dashboards')
            .select('doc, updated_at').eq('page', PAGE).eq('name', NAME).maybeSingle();
        if (error) throw new Error(error.message);
        if (row && pickNewer(readMeta(), row) === 'remote' && row.doc?.prefs) {
            savePrefs(normalizePrefs(row.doc.prefs), { source: 'cloud' });
            writeMeta(row.updated_at);
        }
        sync.state = 'synced';

        // ── Push (debounced) on every LOCAL save ─────────────────────────────
        let timer = null;
        const push = async () => {
            try {
                const updatedAt = new Date().toISOString();
                const { error: e2 } = await sb.from('dashboards').upsert({
                    user_id: uid, page: PAGE, name: NAME,
                    doc: { prefs: loadPrefs() }, version: PREFS_VERSION, updated_at: updatedAt,
                }, { onConflict: 'user_id,page,name' });
                if (e2) throw new Error(e2.message);
                writeMeta(updatedAt);
                sync.state = 'synced';
            } catch (e) {
                sync.state = 'error';
                sync.lastError = String(e?.message ?? e);
            }
        };
        window.addEventListener(PREFS_EVENT, (ev) => {
            if (ev.detail?.source !== 'local') return;
            clearTimeout(timer);
            timer = setTimeout(push, 1500);
        });
        // No remote row yet but this device has been customised: seed it.
        // (An untouched device has no meta stamp and writes nothing.)
        if (!row && readMeta()) push();
    } catch (e) {
        sync.state = 'error';
        sync.lastError = String(e?.message ?? e);
        console.info('[climate-lab] prefs sync disabled:', sync.lastError);
    }
    return sync;
}
