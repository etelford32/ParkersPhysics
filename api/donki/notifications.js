/**
 * Vercel Edge Function: /api/donki/notifications
 *
 * Proxies NASA DONKI all-event notifications endpoint.
 * NASA API key is server-side only (NASA_API_KEY env var).
 *
 * T3 endpoint (15-minute cadence).
 *
 * Returns the last 7 days of notifications, sorted newest-first.
 * FREE plan: last 5 notifications.
 * PRO plan:  full list.
 *
 * `body` is the message text (Summary section first, ≤400 chars) or null
 * when upstream carries none; `body_source` / `body_coverage` / `item_keys`
 * (and `note` on a total miss) say which — api/_lib/donki-notifications.js.
 */
import { jsonOk, jsonError, isoTag } from '../_lib/responses.js';
import { fetchDonki, nasaApiKey } from '../_lib/donki-upstream.js';
import { mapNotifications } from '../_lib/donki-notifications.js';

export const config = { runtime: 'edge' };

const CACHE_TTL         = 900;
// Long SWR (30 min, matching the prewarm-medium cadence) — same rationale
// as cme.js: api.nasa.gov is slow cold; with SWR >= the prewarm interval
// the CDN always has a serveable copy and refreshes in background.
const CACHE_SWR         = 1800;
const DEFAULT_DAYS      = 7;
const FREE_LIMIT        = 5;

function isPro(request) {
    const auth   = request.headers.get('Authorization') ?? '';
    const token  = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const secret = (typeof process !== 'undefined' && process.env?.PRO_SECRET) ?? '';
    return secret.length > 0 && token === secret;
}

export default async function handler(request) {
    const nasaKey = nasaApiKey();
    const pro     = isPro(request);

    const now   = new Date();
    const start = new Date(now.getTime() - DEFAULT_DAYS * 86_400_000);
    const fmt   = d => d.toISOString().slice(0, 10);

    // CCMC origin raced against the api.nasa.gov gateway — see donki-upstream.js.
    let raw, upstream;
    try {
        ({ data: raw, host: upstream } = await fetchDonki('notifications',
            { type: 'all', startDate: fmt(start), endDate: fmt(now) }));
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'NASA DONKI' });
    }

    if (!Array.isArray(raw)) {
        return jsonError('parse_error', 'Unexpected DONKI notifications format', { source: 'NASA DONKI' });
    }

    // Body text resolves from a candidate list and self-reports where it came
    // from — the new CCMC host served `messageBody: "## "` (see the module).
    const { notes, report } = mapNotifications(raw, { isoTag });

    const limited = pro ? notes : notes.slice(0, FREE_LIMIT);

    return jsonOk({
        source:    'NASA DONKI notifications via Vercel Edge',
        key_mode:  nasaKey === 'DEMO_KEY' ? 'demo' : 'configured',
        upstream,
        plan:      pro ? 'pro' : 'free',
        ...report,
        data: {
            updated:       new Date().toISOString(),
            total_count:   notes.length,
            shown_count:   limited.length,
            notifications: limited,
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
