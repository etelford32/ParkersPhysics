/**
 * lasco-sources.js — where a SOHO/LASCO browse frame comes from. PURE, tiny.
 * ═══════════════════════════════════════════════════════════════════════════
 * The ONE copy of the LASCO channel names, the upstream path and the freshness
 * thresholds. Two consumers, and it is dependency-free BECAUSE of the first:
 *
 *   • api/solar/aia.js (edge)   — `channel=c2|c3` on the solar image proxy
 *   • js/sun-coronagraph.js     — the observed outer-corona layer on sun.html
 *
 * It lives in js/ and NOT api/_lib/ for the reason js/suvi-geometry.js records:
 * api/ is the serverless directory and is not served statically, so a browser
 * import of it 404s and — sun.html being one module — takes the whole page
 * down as a boot timeout. It imports NOTHING so the edge function does not
 * pull the coronagraph layer's kernel (and through it the disk-fusion kernel)
 * into its bundle just to learn a URL.
 *
 * ── The path ───────────────────────────────────────────────────────────────
 * https://soho.nascom.nasa.gov/data/realtime/<c2|c3>/<512|1024>/latest.jpg
 * These are the same files the SDO Live drawer already loads as <img> sources
 * (js/soho-feed.js), so the PATH is known to resolve in production. What a
 * build here cannot check — nasa.gov is egress-blocked — is everything about
 * the frame's CONTENT: js/sun-coronagraph.js's header lists those unknowns.
 * Only 512 and 1024 exist; the proxy maps any other `res` to 1024.
 *
 * ── Why the freshness thresholds are not AIA's ─────────────────────────────
 * SOHO is a 1995 spacecraft on shared DSN time: realtime frames routinely
 * arrive tens of minutes to a few hours after exposure, and during the
 * quarterly "keyhole" weeks the gaps are longer. Scoring it on AIA's
 * 30 / 90 minute thresholds would paint it amber most of the time and teach
 * everyone to ignore the row. 3 h / 24 h says: a few hours late is this
 * feed's normal, a day late is a gap.
 */

/** Proxy channel → instrument id. */
export const LASCO_CHANNELS = Object.freeze({ c2: 'c2', c3: 'c3' });

/** The browse sizes SOHO actually publishes. */
export const LASCO_SIZES = Object.freeze([512, 1024]);

/** Edge cache TTL, seconds. C2 and C3 both run at 12–24 min cadence. */
export const LASCO_CACHE_S = 1200;

/** Freshness thresholds, seconds — see the header. */
export const LASCO_WARN_S = 3 * 3600;
export const LASCO_CRIT_S = 24 * 3600;

/** `c2` / `c3` (any case) → the instrument id, else null. */
export function parseLascoChannel(channel) {
    const k = String(channel ?? '').trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(LASCO_CHANNELS, k) ? LASCO_CHANNELS[k] : null;
}

/** Snap a requested size to one SOHO publishes (512 stays 512; all else 1024). */
export function lascoSize(res) {
    return Number(res) === 512 ? 512 : 1024;
}

/** The upstream browse-frame URL. */
export function lascoUrl(instrument, res = 1024) {
    const id = parseLascoChannel(instrument);
    if (!id) throw new Error(`not a LASCO channel: ${instrument}`);
    return `https://soho.nascom.nasa.gov/data/realtime/${id}/${lascoSize(res)}/latest.jpg`;
}

/** live · stale · expired from the frame's age in seconds. */
export function lascoFreshness(ageS) {
    if (!Number.isFinite(ageS)) return 'expired';
    return ageS > LASCO_CRIT_S ? 'expired' : ageS > LASCO_WARN_S ? 'stale' : 'live';
}
