/**
 * js/bz-engine-provider.js — the ONE shared provider of the Bz column.
 *
 * BZ_ENGINE_PLAN.md §5 (the flux-rope-forecast pattern): every page that wants
 * the altitude ladder calls `startBzProvider()` and listens; nobody fetches
 * /api/bz/column on their own, and nobody re-runs the analysis per consumer.
 *
 *   import { startBzProvider } from './js/bz-engine-provider.js';
 *   startBzProvider();
 *   window.addEventListener('bz-column', (e) => render(e.detail));
 *   // or, late subscribers:  window.__bzColumn
 *
 * The published object is { ok, freshness, reasons, column, fetchedAt, error }.
 * RULES:
 *   • A failed or dead feed is PUBLISHED as such (ok:false, the last good
 *     column kept under `column` with `stale:true`) — feeds down must look
 *     down, never quiet and never frozen-but-unlabelled.
 *   • One poll loop per page however many callers start it.
 *   • It polls only while the document is visible.
 *   • No physics here: the column is js/bz/column.js's, built server-side.
 *
 * `createBzProvider` is the testable core (fetch, clock and timers injected);
 * `startBzProvider` binds it to the browser.
 */

export const BZ_COLUMN_EVENT = 'bz-column';
export const BZ_COLUMN_PATH = '/api/bz/column';
export const BZ_POLL_MS = 60_000;

/**
 * @param {{ fetchImpl: Function, publish: (state:object) => void, now?: () => number, path?: string }} deps
 * @returns {{ refresh: () => Promise<object>, state: () => object|null }}
 */
export function createBzProvider({ fetchImpl, publish, now = () => Date.now(), path = BZ_COLUMN_PATH }) {
    let state = null, lastGood = null, inFlight = null;
    const emit = (s) => { state = s; publish(s); return s; };
    async function refresh() {
        if (inFlight) return inFlight;
        inFlight = (async () => {
            try {
                const res = await fetchImpl(path, { headers: { Accept: 'application/json' } });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const body = await res.json();
                if (!body || !body.data || !Array.isArray(body.data.rungs)) throw new Error('unexpected response shape');
                lastGood = { column: body.data, at: now() };
                return emit({ ok: true, freshness: body.freshness ?? 'expired', reasons: body.reasons ?? [],
                    column: body.data, stale: false, fetchedAt: now(), error: null });
            } catch (e) {
                return emit({ ok: false, freshness: 'expired', reasons: ['provider_fetch_failed'],
                    column: lastGood?.column ?? null, stale: !!lastGood, lastGoodAt: lastGood?.at ?? null,
                    fetchedAt: now(), error: String(e?.message ?? e).slice(0, 120) });
            } finally { inFlight = null; }
        })();
        return inFlight;
    }
    return { refresh, state: () => state };
}

let started = null;
/** Start (once) the page's provider. Safe to call from any number of modules. */
export function startBzProvider({ pollMs = BZ_POLL_MS } = {}) {
    if (started) return started;
    const provider = createBzProvider({
        fetchImpl: (...a) => fetch(...a),
        publish: (s) => {
            window.__bzColumn = s;
            window.dispatchEvent(new CustomEvent(BZ_COLUMN_EVENT, { detail: s }));
        },
    });
    let timer = null;
    const tick = () => { if (document.visibilityState !== 'hidden') provider.refresh(); };
    const arm = () => { if (timer == null) timer = setInterval(tick, pollMs); };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
    provider.refresh();
    arm();
    started = { ...provider, stop: () => { clearInterval(timer); timer = null; started = null; } };
    return started;
}
