/**
 * climalytix/places-store.js — where the places document (places.js) LIVES.
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SIGN-UP LINE. Remembering where you have been is what an account is for:
 *
 *   signed out   sessionStorage — history works, and is gone when the tab
 *                closes. The page says so and offers the account.
 *   provisional  the visitor has submitted an email through the gate
 *                (gate-modal's `pp_gate_member`) but has not clicked the magic
 *                link yet. The link may open in ANOTHER tab, which cannot see
 *                this tab's sessionStorage, so the document moves to a
 *                localStorage "pending" key to survive the hop.
 *   signed in    localStorage, keyed by user id, and synced to the account:
 *                ONE row in public.dashboards (page 'climalytix-places'),
 *                through dashboard-sync's `initDocSync`.
 *
 * NOT PLAN-GATED, ON PURPOSE (owner decision 2026-11-22: the gate is SIGN-UP,
 * not payment). Places are account data like the Home location, so the sync
 * passes `requireTier: false`. The workspace sync next door (page.js) keeps
 * its Basic+ line; flip `REQUIRE_PAID_SYNC` to put places behind it too.
 *
 * ADOPTION. The first signed-in boot MERGES whatever the session / pending
 * stores hold into the account document and clears them — the places a
 * visitor collected before signing up are the first thing their account
 * remembers. Merge, not replace: `mergePlaces` is commutative, so adopting
 * and then pulling the cloud row cannot lose either side.
 *
 * NEVER CLAIM A SAVE THAT DID NOT LAND (the lab-home rule): `status()` reports
 * 'account' only once a pull or push has actually succeeded; until then, and
 * on any failure, it says 'device'.
 */

import {
    emptyPlaces, normalizePlaces, mergePlaces, samePlaces,
    recordVisit, setSaved, forgetPlace, clearHistory,
} from './places.js';

export const PLACES_KEY = 'pp_climalytix_places_v1';
export const PLACES_PENDING_KEY = `${PLACES_KEY}.pending`;
export const PLACES_EVENT = 'climalytix-places';        // anything changed → re-render
const SAVE_EVENT = 'climalytix-places-save';            // a LOCAL change → push
const SYNC_PAGE = 'climalytix-places';
const REQUIRE_PAID_SYNC = false;

const read = (store, key) => { try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; } };
const write = (store, key, v) => { try { v == null ? store.removeItem(key) : store.setItem(key, JSON.stringify(v)); } catch {} };

/** The signed-in account from the pp_auth mirror (what dashboard-sync reads), or null. */
export function accountFromMirror() {
    const a = read(localStorage, 'pp_auth') || read(sessionStorage, 'pp_auth');
    return a?.signedIn && a.id ? { id: String(a.id) } : null;
}

const provisional = () => { try { return !!localStorage.getItem('pp_gate_member'); } catch { return false; } };

const T = {
    scope: 'session',      // 'session' | 'pending' | 'account'
    userId: null,
    doc: emptyPlaces(),
    sync: null,
};

function slot() {
    if (T.scope === 'account') return [localStorage, `${PLACES_KEY}.${T.userId}`];
    if (T.scope === 'pending') return [localStorage, PLACES_PENDING_KEY];
    return [sessionStorage, PLACES_KEY];
}

function land(doc, { local = true } = {}) {
    T.doc = normalizePlaces(doc);
    const [store, key] = slot();
    write(store, key, T.doc);
    try {
        window.dispatchEvent(new CustomEvent(PLACES_EVENT));
        if (local && T.scope === 'account') window.dispatchEvent(new CustomEvent(SAVE_EVENT));
    } catch {}
    return T.doc;
}

/**
 * (Re)open the store for whoever is signed in right now. Safe to call again on
 * every 'auth-changed'; it only does work when the scope actually moved.
 */
export function openPlaces() {
    const acct = accountFromMirror();
    const scope = acct ? 'account' : provisional() ? 'pending' : 'session';
    if (scope === T.scope && (acct?.id ?? null) === T.userId && T.opened) return T.doc;
    const was = { scope: T.scope, userId: T.userId, synced: T.sync?.state === 'synced' };

    // Signed out of an account whose document is safely in the cloud: do not
    // leave a location history behind on a shared machine.
    if (T.opened && was.scope === 'account' && scope !== 'account' && was.synced) {
        write(localStorage, `${PLACES_KEY}.${was.userId}`, null);
    }

    T.scope = scope;
    T.userId = acct?.id ?? null;
    T.sync = null;
    T.opened = true;

    const carried = mergePlaces(read(sessionStorage, PLACES_KEY), read(localStorage, PLACES_PENDING_KEY));
    if (scope === 'account') {
        const own = normalizePlaces(read(localStorage, `${PLACES_KEY}.${T.userId}`));
        const adopted = carried.places.length > 0;
        T.doc = adopted ? mergePlaces(own, carried) : own;
        write(sessionStorage, PLACES_KEY, null);
        write(localStorage, PLACES_PENDING_KEY, null);
        write(localStorage, `${PLACES_KEY}.${T.userId}`, T.doc);
        T.adopted = adopted ? carried.places.length : 0;
        startSync();
    } else {
        T.doc = carried;
        T.adopted = 0;
        if (scope === 'pending') { write(sessionStorage, PLACES_KEY, null); write(localStorage, PLACES_PENDING_KEY, T.doc); }
    }
    try { window.dispatchEvent(new CustomEvent(PLACES_EVENT)); } catch {}
    return T.doc;
}

async function startSync() {
    const userId = T.userId;
    try {
        const { initDocSync } = await import('../dashboard-sync.js');
        if (T.userId !== userId || T.scope !== 'account') return;
        T.sync = initDocSync({
            page: SYNC_PAGE,
            requireTier: REQUIRE_PAID_SYNC,
            saveEvent: SAVE_EVENT,
            getDoc: () => ({ places: T.doc }),
            reconcile: (remote) => {
                if (T.userId !== userId || T.scope !== 'account') return false;
                const theirs = normalizePlaces(remote?.places);
                const merged = mergePlaces(T.doc, theirs);
                if (!samePlaces(merged, T.doc)) land(merged, { local: false });
                return !samePlaces(merged, theirs);
            },
            onState: () => { try { window.dispatchEvent(new CustomEvent(PLACES_EVENT)); } catch {} },
        });
    } catch { T.sync = { state: 'error' }; }
    try { window.dispatchEvent(new CustomEvent(PLACES_EVENT)); } catch {}
}

export const placesDoc = () => T.doc;

/**
 * What the page may say about where the document is kept.
 * @returns {{scope:'session'|'pending'|'account', kept:'session'|'device'|'account', adopted:number}}
 */
export function placesStatus() {
    const kept = T.scope === 'account' ? (T.sync?.state === 'synced' ? 'account' : 'device')
        : T.scope === 'pending' ? 'device' : 'session';
    return { scope: T.scope, kept, adopted: T.adopted || 0, syncState: T.sync?.state ?? null };
}

export const rememberVisit = (loc, now = Date.now()) => land(recordVisit(T.doc, loc, now));
export const savePlace = (loc, saved, now = Date.now()) => land(setSaved(T.doc, loc, saved, now));
export const forget = (id, now = Date.now()) => land(forgetPlace(T.doc, id, now));
export const clearRecent = (now = Date.now()) => land(clearHistory(T.doc, now));
