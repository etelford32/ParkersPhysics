/**
 * climate-lab/lab-home.js — HOME BASE: the dashboard's default view.
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MODEL. A user has ONE home station, and it is ACCOUNT data:
 * `user_profiles.location_lat/lon/city` — the columns the welcome wizard
 * writes at onboarding and the alert engine already falls back to. It is not
 * plan-gated (free accounts have zero `user_locations` rows but can always
 * have a home). The device store `ppx_user_location` (js/user-location.js)
 * stays what it has always been: the CURRENT VIEW that every card on every
 * page reads, announced by 'user-location-changed'.
 *
 * "HOME IS THE DEFAULT VIEW" is then one rule, applied once at boot and
 * BEFORE any card mounts: if the lab opens at Home (prefs.openAt, default)
 * and the stored view is somewhere else, the view is moved back to Home.
 * Looking at another place — a saved location, a search — is a VISIT: it
 * writes the view, the whole dashboard follows, and the next visit to the
 * dashboard opens at Home again. No second location store and no second
 * event contract exist; the sw-location-box rule, kept.
 *
 * Precedence when resolving Home (pure `resolveHome`, node-gated):
 *   account (user_profiles via the auth module / pp_auth mirror)
 *   > device (ppx_user_location — "not saved to your account yet")
 *   > demo sample (demo mode only) > none.
 */

import { loadUserLocation, saveUserLocation } from '../user-location.js';
// lab-account.js (→ auth.js, which touches `window` at import) is loaded
// lazily inside setHome() so the pure rules above it stay node-testable.

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** A usable {lat, lon, city} or null. */
export function cleanLoc(loc) {
    if (!loc) return null;
    const lat = Number(loc.lat), lon = Number(loc.lon);
    if (!isNum(lat) || !isNum(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
    const city = typeof loc.city === 'string' && loc.city.trim() ? loc.city.trim().slice(0, 80)
        : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    return { lat, lon, city };
}

/** Same place to ~1 km (0.01°) — a re-geocode of the same city is not a visit. */
export function sameLocation(a, b, tolDeg = 0.01) {
    const A = cleanLoc(a), B = cleanLoc(b);
    if (!A || !B) return false;
    return Math.abs(A.lat - B.lat) <= tolDeg && Math.abs(A.lon - B.lon) <= tolDeg;
}

/**
 * @param {{account?:object, device?:object, demo?:object}} src
 * @returns {{home:object|null, source:'account'|'device'|'demo'|null}}
 */
export function resolveHome({ account = null, device = null, demo = null } = {}) {
    const a = cleanLoc(account);
    if (a) return { home: a, source: 'account' };
    const d = cleanLoc(device);
    if (d) return { home: d, source: 'device' };
    const m = cleanLoc(demo);
    if (m) return { home: m, source: 'demo' };
    return { home: null, source: null };
}

// ── Browser glue ────────────────────────────────────────────────────────────

/** Account home from the live auth module, else the pp_auth mirror. */
export function accountHome(auth) {
    try {
        const live = auth?.getUser?.()?.location;
        if (cleanLoc(live)) return cleanLoc(live);
    } catch {}
    try {
        const raw = localStorage.getItem('pp_auth') || sessionStorage.getItem('pp_auth');
        return cleanLoc(raw ? JSON.parse(raw)?.location : null);
    } catch { return null; }
}

/** Remembers the device location that was Home before any visit this boot. */
let _bootDevice = null;

/**
 * Boot rule — call ONCE, before the dashboard's cards mount.
 * @returns {{home, source, view, visiting:boolean}}
 */
export function anchorAtHome({ auth, openAt = 'home', demo = null } = {}) {
    const device = cleanLoc(loadUserLocation());
    _bootDevice = device;
    const { home, source } = resolveHome({ account: accountHome(auth), device, demo });
    let view = device;
    if (home && openAt === 'home' && !sameLocation(home, device)) {
        saveUserLocation({ ...home, displayName: home.city });
        view = home;
    } else if (!view && home) {
        saveUserLocation({ ...home, displayName: home.city });
        view = home;
    }
    return { home, source, view, visiting: !!(home && view && !sameLocation(home, view)) };
}

/** Current state, recomputed from the stores (cheap; call on every change). */
export function homeState({ auth, demo = null } = {}) {
    const view = cleanLoc(loadUserLocation());
    const acct = accountHome(auth);
    const { home, source } = resolveHome({ account: acct, device: acct ? null : (_bootDevice || view), demo });
    return { home, source, view, visiting: !!(home && view && !sameLocation(home, view)) };
}

/** Look at another place without changing Home. */
export function visit(loc) {
    const c = cleanLoc(loc);
    if (c) saveUserLocation({ ...c, displayName: loc.displayName || c.city });
    return c;
}

/**
 * Make a place Home. Writes the view immediately (every card follows) and,
 * when signed in, the account columns. Resolves with what actually happened
 * so the UI never claims an account save that did not land.
 * @returns {Promise<{ok:boolean, scope:'account'|'device', error?:string}>}
 */
export async function setHome(loc, { signedIn = false } = {}) {
    const c = cleanLoc(loc);
    if (!c) return { ok: false, scope: 'device', error: 'Invalid location' };
    _bootDevice = c;
    saveUserLocation({ ...c, displayName: loc.displayName || c.city });
    if (!signedIn) return { ok: true, scope: 'device' };
    const { updateOwnProfile } = await import('./lab-account.js');
    const res = await updateOwnProfile({ location_lat: c.lat, location_lon: c.lon, location_city: c.city });
    return res.ok ? { ok: true, scope: 'account' } : { ok: false, scope: 'device', error: res.error };
}
