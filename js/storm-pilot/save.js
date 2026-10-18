/**
 * storm-pilot/save.js — progress is saved for SIGNED-IN players only.
 *
 *   · Guests: progress lives in sessionStorage for this tab and is gone when
 *     it closes. The title screen says so and offers a free account.
 *   · Signed in: the record is one row in public.dashboards
 *     (page 'storm-pilot', name 'progress'; RLS = owner only), mirrored to a
 *     per-user localStorage cache so the page boots instantly and offline.
 *   · Signing in MERGES the guest run into the account (best stars win), so
 *     the stars someone earned before creating an account are not lost.
 *
 * Every cloud path is fail-quiet: a missing table, a blocked network or an
 * RLS error leaves the local cache working and logs one console.info.
 */
import { auth } from '../auth.js';
import { getSupabase, isConfigured } from '../supabase-config.js';
import { emptyProgress, normalizeProgress, mergeProgress } from './levels.js';

const GUEST_KEY = 'pp_storm_pilot_guest';
const userKey = (uid) => `pp_storm_pilot.${uid}`;
const PAGE = 'storm-pilot', NAME = 'progress';

const read = (store, key) => { try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; } };
const write = (store, key, v) => { try { store.setItem(key, JSON.stringify(v)); } catch { /* storage blocked */ } };

export class ProgressStore {
    constructor() {
        this.user = null;
        this.progress = normalizeProgress(read(sessionStorage, GUEST_KEY));
        this.listeners = new Set();
        this.cloud = 'off';                      // 'off' | 'ok' | 'unavailable'
    }
    get signedIn() { return !!this.user; }
    get() { return this.progress; }
    onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    _emit() { for (const fn of this.listeners) { try { fn(this.progress); } catch (e) { console.warn(e); } } }

    async init() {
        if (!isConfigured()) return;
        try { await auth.ready(); } catch { return; }
        await this._sync();
        window.addEventListener('auth-changed', () => { this._sync(); });
    }

    async _sync() {
        const u = auth.isSignedIn() ? auth.getUser() : null;
        if (!u?.id) { this.user = null; this._emit(); return; }
        this.user = u;
        const guest = read(sessionStorage, GUEST_KEY);
        let merged = mergeProgress(read(localStorage, userKey(u.id)), guest);
        const remote = await this._pull();
        if (remote) merged = mergeProgress(merged, remote);
        this.progress = merged;
        write(localStorage, userKey(u.id), merged);
        try { sessionStorage.removeItem(GUEST_KEY); } catch { /* ignore */ }
        this._emit();
        await this._push();
    }

    /** Record a finished level / Endless run; keeps the best result. */
    async record(res, levelId = null, planetId = null) {
        const add = emptyProgress();
        if (levelId != null && res.stars > 0) add.stars[levelId] = res.stars;
        if (res.endless && planetId) add.best[planetId] = res.t;
        this.progress = mergeProgress(this.progress, add);
        if (this.user) { write(localStorage, userKey(this.user.id), this.progress); await this._push(); }
        else write(sessionStorage, GUEST_KEY, this.progress);
        this._emit();
    }

    async _pull() {
        try {
            const sb = await getSupabase();
            const { data, error } = await sb.from('dashboards').select('doc, updated_at')
                .eq('user_id', this.user.id).eq('page', PAGE).eq('name', NAME).maybeSingle();
            if (error) throw error;
            this.cloud = 'ok';
            return data?.doc || null;
        } catch (e) { this._cloudDown(e); return null; }
    }
    async _push() {
        if (!this.user || this.cloud === 'unavailable') return;
        try {
            const sb = await getSupabase();
            const { error } = await sb.from('dashboards').upsert({
                user_id: this.user.id, page: PAGE, name: NAME, doc: this.progress, version: 1,
                updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id,page,name' });
            if (error) throw error;
            this.cloud = 'ok';
        } catch (e) { this._cloudDown(e); }
    }
    _cloudDown(e) {
        if (this.cloud !== 'unavailable') console.info('[storm-pilot] cloud save unavailable; keeping progress on this device.', e?.message || e);
        this.cloud = 'unavailable';
    }
}
