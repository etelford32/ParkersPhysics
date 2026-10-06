/**
 * temperature-lab-feed.js — the browser half of /api/temperature/snapshot
 * (PLANETARY_TEMPERATURE_LAB_PLAN.md §4.6). I/O only: it fetches, it never
 * computes a scorecard — buildLabModel ran on the server, and the page and
 * the EarthView panel draw what it returned.
 *
 * Every result — a fresh body, or a fetch that failed — is dispatched on
 * `window` as 'temperature-lab-update' with the body as `detail`, so the page
 * and any panel on it stay on ONE copy. A network failure becomes a body
 * shaped like the route's own degraded answer (`freshness: 'expired'`, a
 * reason and a note), never a thrown error and never a silent keep-the-old:
 * a feed that is down must LOOK down (the Compounding Watch rule).
 *
 * The aggregate changes hourly and the route caches 15 min, so polling is
 * every 15 min while the tab is visible and once on return to it.
 */

const ENDPOINT = '/api/temperature/snapshot';
export const POLL_MS = 15 * 60_000;
export const EVENT = 'temperature-lab-update';

/** The query for a surface / region pair (region omitted when null). */
export function snapshotUrl({ surface = 'land', region = null } = {}) {
    const q = new URLSearchParams({ surface });
    if (region) q.set('region', region);
    return `${ENDPOINT}?${q}`;
}

/** A failed fetch, in the route's own degraded shape. */
export function failureBody(message) {
    return {
        freshness: 'expired', reasons: ['fetch-failed'], updated: null, window: null, sources: {},
        planet: null, cards: null, grid: null, disclosure: null,
        note: `snapshot unreachable (${message})`,
    };
}

/**
 * @param {{surface?: string, region?: string|null, fetchImpl?: typeof fetch,
 *          target?: EventTarget, pollMs?: number}} [opts]
 */
export function startTemperatureLabFeed({
    surface = 'land', region = null, fetchImpl = (...a) => fetch(...a),
    target = typeof window !== 'undefined' ? window : null, pollMs = POLL_MS,
} = {}) {
    const q = { surface, region };
    let latest = null, timer = null, seq = 0, stopped = false;

    async function refresh() {
        const mine = ++seq;
        let body;
        try {
            const res = await fetchImpl(snapshotUrl(q), { headers: { accept: 'application/json' } });
            body = res.ok ? await res.json() : failureBody(`HTTP ${res.status}`);
        } catch (err) {
            body = failureBody(err?.message || 'network error');
        }
        // A newer request (a filter changed mid-flight) wins; never let a slow
        // answer for the OLD filter overwrite the new one.
        if (mine !== seq || stopped) return latest;
        latest = { ...body, query: { ...q } };
        target?.dispatchEvent?.(new CustomEvent(EVENT, { detail: latest }));
        return latest;
    }

    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    timer = setInterval(() => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') refresh();
    }, pollMs);
    refresh();

    return {
        get latest() { return latest; },
        get query() { return { ...q }; },
        refresh,
        /** Change the cards' universe; re-fetches at once. */
        setQuery(next = {}) {
            if ('surface' in next) q.surface = next.surface || 'land';
            if ('region' in next) q.region = next.region || null;
            return refresh();
        },
        stop() {
            stopped = true;
            clearInterval(timer);
            if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
        },
    };
}
