/**
 * Vercel Edge Function: /api/solar/aia?channel=193[&res=1024][&t=<iso>]
 *
 * Story 1.2 proxy. Streams NASA SDO's "latest" full-disk image for one of
 * the six AIA EUV passbands (or the HMI continuum for `white`) so the
 * browser never hits nasa.gov directly — the demo-killing rate limits and
 * the no-CORS texture taint both go away. Cached at the edge for 12 min
 * (AIA's native cadence) with a generous stale-while-revalidate so a slow
 * upstream never blanks the Sun.
 *
 * `t` (an ISO timestamp from the timeline scrubber) is accepted but, for
 * now, still resolves to the latest frame — historical JP2 retrieval via
 * Helioviewer is a deferred follow-up. We set `X-AIA-Mode: live` so the
 * client can honestly label a scrubbed view "[live] — historical view"
 * rather than pass a stale frame off as the requested time.
 *
 * Provenance (SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 1): the image response
 * carries `X-SDO-Observed-At` (the upstream `Last-Modified`, i.e. when NASA
 * last wrote the browse frame — the closest thing to the observation time
 * the "latest" JPEGs expose) plus `X-SDO-Fetched-At`. sun.html's chip prints
 * the first and derives the frame age from it.
 *
 * ── GOES/SUVI channels (`channel=suvi304`, Phase 3e) ─────────────────
 *
 * The six SUVI bands are served through this same route, namespaced `suvi###`
 * so the SDO disk path is untouched — SUVI is an ADDED LAYER for the off-limb
 * annulus, never a swap of the disk's frame (js/suvi-geometry.js explains why:
 * 2.5″/px would trade a sharp disk for a soft one, and what SUVI actually buys
 * is field of view — 1.667 R☉ on axis against AIA's 1.280).
 *
 * services.swpc.noaa.gov is unreachable from this repo's build environment, so
 * the exact path is UNVERIFIED and resolves from an ordered CANDIDATE LIST
 * (`candidateUrls`). Two different policies, on purpose:
 *   • the IMAGE path is the hot path — it tries candidates in order and stops
 *     at the first that answers, then names it in `X-SUVI-Source`.
 *   • `meta=1` is the diagnostic — it probes EVERY candidate in parallel and
 *     reports each one's status, so ONE production request settles the URL:
 *
 *       curl -s '…/api/solar/aia?channel=suvi304&meta=1' | jq '.source_id, .candidates'
 *
 * Record the winner in js/suvi-geometry.js's SOURCES table, move it to the head
 * of the list, and delete the candidates that never hit. Until then this
 * degrades honestly: no candidate answers ⇒ no SUVI frame ⇒ the off-limb layer
 * stays on SDO and says so. It never invents a corona.
 *
 * ── SOHO/LASCO channels (`channel=c2`, `channel=c3`) ───────────────────────
 *
 * The white-light coronagraphs js/sun-coronagraph.js draws beyond the EUV
 * annulus (2.2–6 R☉ and 4–27 R☉). Upstream is SOHO's realtime browse frame,
 * `soho.nascom.nasa.gov/data/realtime/<c2|c3>/<512|1024>/latest.jpg` — the same
 * files the SDO Live drawer already loads as <img> sources, so the path is
 * known; js/lasco-sources.js is the one copy of it. Three things differ from
 * the SDO branch, each on purpose:
 *   • `X-SOHO-Instrument` names the instrument. The client REQUIRES it: an
 *     unknown channel on this route has always fallen back to the HMI disc, so
 *     a deploy that predates c2/c3 would otherwise hand the coronagraph layer a
 *     photosphere labelled `X-AIA-Channel: c2`.
 *   • only 512 and 1024 exist; any other `res` is served as 1024.
 *   • freshness is scored on LASCO's own thresholds (3 h / 24 h) — SOHO is a
 *     1995 spacecraft on shared DSN time and its realtime frames are routinely
 *     an hour or two behind; AIA's 30 / 90 min would paint it amber for ever.
 * A 200 that is not an image is rejected (NASA's error page is HTML). `meta=1`
 * never 5xxs: a dead upstream is `freshness: 'expired'` + `error`.
 *
 * `meta=1` answers JSON instead of the image — `{ channel, observed_at,
 * fetched_at, age_seconds, freshness, mode }` from a HEAD against upstream —
 * so the status page can score this route (js/pipeline-registry.js
 * `solar-aia` probes it). A failed HEAD is a 200 with `freshness: 'expired'`
 * and an `error` field, never a 5xx: status.html must show the feed as DOWN,
 * not the route as broken.
 */
import { fetchWithTimeout, CORS_HEADERS } from '../_lib/responses.js';
// The SUVI kernel lives in js/ and NOT api/_lib/ — api/ is the serverless
// directory and is not served statically, so a browser import of it 404s and
// (sun.html being one module) takes the WHOLE PAGE down as a boot timeout.
// That scar is recorded in SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 3d.
import { parseSuviChannel, candidateUrls, SUVI_CHANNELS } from '../../js/suvi-geometry.js';
// Dependency-free on purpose (see its header): the edge bundle learns the
// LASCO path without pulling in the coronagraph layer's kernel.
import { parseLascoChannel, lascoUrl, lascoSize, lascoFreshness, LASCO_CACHE_S } from '../../js/lasco-sources.js';

export const config = { runtime: 'edge' };

// channel → SDO "latest_<res>_<code>.jpg" code
const CODE = {
    white: 'HMIIC',
    mag:   'HMIB',    // S8: LOS magnetogram — the Stage's polarity layer
    94:  '0094', 131: '0131', 171: '0171',
    193: '0193', 211: '0211', 304: '0304',
};

const CACHE_S = 720;   // 12 min — AIA native cadence
// SUVI's operational cadence is 4 min per band; cache to that rather than
// inheriting AIA's 12 min, or the off-limb layer's whole reason for being
// (watching a prominence erupt) is served three-frames stale.
const SUVI_CACHE_S = 240;
const SWR_S   = 600;   // serve slightly-stale up to 10 min while revalidating

// Freshness thresholds mirror js/pipeline-registry.js `solar-aia` and
// js/sun-observed.js FRESH_WARN_S / FRESH_CRIT_S — change all three together.
const WARN_S = 30 * 60;
const CRIT_S = 90 * 60;

export function upstreamUrl(channel, res) {
    const code = CODE[channel] ?? CODE.white;
    return `https://sdo.gsfc.nasa.gov/assets/img/latest/latest_${res}_${code}.jpg`;
}

/**
 * Per-candidate timeout, and a TOTAL budget for the walk.
 *
 * Both are needed. The per-candidate timeout alone does not bound the request:
 * five candidates × 6 s is 30 s, past the edge runtime's own limit, so a total
 * miss — exactly the case the candidate list exists for — would be killed by
 * the platform and surface as a 5xx instead of the honest 502-with-the-walk
 * this route promises. The budget makes the miss diagnosable: candidates not
 * reached are reported as `budget_exhausted` rather than silently omitted, so
 * the one production request that settles the URL can tell "this path 404s"
 * from "we never got to this path".
 */
const SUVI_CANDIDATE_TIMEOUT_MS = 6000;
const SUVI_TOTAL_BUDGET_MS = 14000;

/**
 * Try a SUVI band's candidates IN ORDER, stop at the first that answers.
 * `method` is 'GET' for the image path, 'HEAD' for a probe.
 * Returns { ok, response, source, tried } — `tried` records every candidate
 * attempted and why it was rejected, so a total miss is diagnosable.
 */
async function resolveSuvi(band, method = 'GET') {
    const tried = [];
    const deadline = Date.now() + SUVI_TOTAL_BUDGET_MS;
    for (const cand of candidateUrls(band)) {
        if (Date.now() >= deadline) {
            tried.push({ id: cand.id, url: cand.url, status: null, ok: false, reject: 'budget_exhausted' });
            continue;
        }
        try {
            const r = await fetchWithTimeout(cand.url, {
                method,
                timeoutMs: Math.max(500, Math.min(SUVI_CANDIDATE_TIMEOUT_MS, deadline - Date.now())),
                headers: { Accept: 'image/png,image/jpeg,image/*' },
            });
            const type = r.headers.get('content-type') || '';
            // A 200 that is not an image is SWPC's HTML error page, not a frame.
            const isImage = /^image\//i.test(type);
            tried.push({ id: cand.id, url: cand.url, status: r.status, content_type: type || null,
                         ok: r.ok && isImage,
                         ...(r.ok && !isImage ? { reject: 'not_an_image' } : {}) });
            if (r.ok && isImage) return { ok: true, response: r, source: cand, tried };
        } catch (e) {
            tried.push({ id: cand.id, url: cand.url, status: null, ok: false, reject: String(e?.message ?? e) });
        }
    }
    return { ok: false, response: null, source: null, tried };
}

function parseHttpDate(s) {
    const t = s ? Date.parse(s) : NaN;
    return Number.isFinite(t) ? t : null;
}

export function freshnessOf(ageS) {
    if (!Number.isFinite(ageS)) return 'expired';
    return ageS > CRIT_S ? 'expired' : ageS > WARN_S ? 'stale' : 'live';
}

export default async function handler(req) {
    const url     = new URL(req.url);
    const channel = String(url.searchParams.get('channel') ?? 'white');
    const resReq  = parseInt(url.searchParams.get('res') ?? '1024', 10);
    const res     = [512, 1024, 2048, 4096].includes(resReq) ? resReq : 1024;
    const historicalRequested = !!url.searchParams.get('t');
    const wantMeta = url.searchParams.get('meta') === '1';

    const suviBand = parseSuviChannel(channel);
    const lasco    = parseLascoChannel(channel);
    const upstream = (suviBand || lasco) ? null : upstreamUrl(channel, res);

    // ── SOHO/LASCO branch ───────────────────────────────────────────────
    if (lasco) {
        const size = lascoSize(resReq);
        const src  = lascoUrl(lasco, size);
        const mode = historicalRequested ? 'live-fallback' : 'live';
        if (wantMeta) {
            const fetchedAt = Date.now();
            let observedAt = null, error = null, upstreamStatus = null, type = null;
            try {
                const head = await fetchWithTimeout(src, { method: 'HEAD', timeoutMs: 9000 });
                upstreamStatus = head.status;
                type = head.headers.get('content-type') || null;
                if (!head.ok) throw new Error(`upstream HTTP ${head.status}`);
                if (!/^image\//i.test(type || '')) throw new Error('not_an_image');
                observedAt = parseHttpDate(head.headers.get('last-modified'));
            } catch (e) {
                error = String(e?.message ?? e);
            }
            const ageS = observedAt != null ? Math.max(0, Math.round((fetchedAt - observedAt) / 1000)) : null;
            return new Response(JSON.stringify({
                source: 'soho-lasco', channel, instrument: lasco, res: size, upstream: src,
                // Last-Modified is when NASA WROTE the file; the exposure time
                // is burned into the frame's pixels and is not parsed here.
                observed_at: observedAt != null ? new Date(observedAt).toISOString() : null,
                observed_at_basis: 'upstream Last-Modified',
                fetched_at: new Date(fetchedAt).toISOString(),
                age_seconds: ageS,
                // No Last-Modified on a good image answer is "age unknown",
                // which cannot be called live.
                freshness: error ? 'expired' : lascoFreshness(ageS ?? NaN),
                mode,
                ...(error ? { error: 'lasco_unavailable', detail: error, upstream_status: upstreamStatus, content_type: type } : {}),
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': `public, s-maxage=${error ? 30 : 300}, stale-while-revalidate=60`,
                    ...CORS_HEADERS,
                },
            });
        }
        try {
            const up = await fetchWithTimeout(src, { timeoutMs: 9000, headers: { Accept: 'image/jpeg,image/*' } });
            if (!up.ok) throw new Error(`upstream HTTP ${up.status}`);
            const type = up.headers.get('content-type') || '';
            // A 200 that is not an image is an error page, not a frame.
            if (!/^image\//i.test(type)) throw new Error('not_an_image');
            const buf = await up.arrayBuffer();
            const observedAt = parseHttpDate(up.headers.get('last-modified'));
            return new Response(buf, {
                status: 200,
                headers: {
                    'Content-Type': type,
                    'Cache-Control': `public, s-maxage=${LASCO_CACHE_S}, stale-while-revalidate=${SWR_S}`,
                    'X-AIA-Channel': String(channel),
                    'X-AIA-Mode': mode,
                    'X-SOHO-Instrument': lasco,
                    'X-SOHO-Upstream': src,
                    ...(observedAt != null ? { 'X-SDO-Observed-At': new Date(observedAt).toISOString() } : {}),
                    'X-SDO-Fetched-At': new Date().toISOString(),
                    'Access-Control-Expose-Headers':
                        'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At, X-SDO-Fetched-At, X-SOHO-Instrument, X-SOHO-Upstream',
                    ...CORS_HEADERS,
                },
            });
        } catch (e) {
            // Same contract as the SDO and SUVI image paths: no placeholder
            // frame. The coronagraph layer draws nothing and says so.
            return new Response(JSON.stringify({ error: 'lasco_unavailable', channel, instrument: lasco, detail: String(e?.message ?? e) }), {
                status: 502,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=30', ...CORS_HEADERS },
            });
        }
    }

    // ── GOES/SUVI branch ────────────────────────────────────────────────
    // `res` is accepted and IGNORED here: SWPC publishes one browse size per
    // band (1280², SUVI's native frame), so there is nothing to select. The
    // client may still send it — the off-limb layer sends the same URL shape
    // for both sources — and it costs only a duplicate cache entry, never a
    // wrong frame, because the disk is MEASURED from the decoded image rather
    // than assumed from the requested size (js/sun-observed.js resolveDiskGeometry).
    if (suviBand) {
        const ch = SUVI_CHANNELS[suviBand];
        if (wantMeta) {
            // The DIAGNOSTIC call: probe EVERY candidate in parallel so one
            // production request settles the URL (header). Never a 5xx — a
            // total miss must read as a DOWN feed on status.html, not a
            // broken route.
            const fetchedAt = Date.now();
            const probes = await Promise.all(candidateUrls(suviBand).map(async (cand) => {
                try {
                    const r = await fetchWithTimeout(cand.url, { method: 'HEAD', timeoutMs: SUVI_CANDIDATE_TIMEOUT_MS });
                    const type = r.headers.get('content-type') || '';
                    const isImage = /^image\//i.test(type);
                    return {
                        id: cand.id, url: cand.url, satellite: cand.satellite,
                        status: r.status, content_type: type || null, ok: r.ok && isImage,
                        last_modified: r.headers.get('last-modified') ?? null,
                        ...(r.ok && !isImage ? { reject: 'not_an_image' } : {}),
                    };
                } catch (e) {
                    return { id: cand.id, url: cand.url, satellite: cand.satellite,
                             status: null, ok: false, reject: String(e?.message ?? e) };
                }
            }));
            const win = probes.find(p => p.ok) ?? null;
            const observedAt = win ? parseHttpDate(win.last_modified) : null;
            const ageS = observedAt != null ? Math.max(0, Math.round((fetchedAt - observedAt) / 1000)) : null;
            return new Response(JSON.stringify({
                source: 'goes-suvi', channel, band: suviBand, wavelength_angstrom: Number(suviBand),
                ion: ch.ion, label: ch.label,
                source_id: win?.id ?? null, satellite: win?.satellite ?? null, upstream: win?.url ?? null,
                observed_at: observedAt != null ? new Date(observedAt).toISOString() : null,
                fetched_at: new Date(fetchedAt).toISOString(),
                age_seconds: ageS,
                freshness: win ? freshnessOf(ageS) : 'expired',
                mode: historicalRequested ? 'live-fallback' : 'live',
                candidates: probes,
                ...(win ? {} : {
                    error: 'suvi_unresolved',
                    note: 'No SUVI candidate answered with an image. The path is UNVERIFIED '
                        + '(services.swpc.noaa.gov is egress-blocked at build time) — read '
                        + 'candidates[] for each status, then record the winner in js/suvi-geometry.js.',
                }),
            }), {
                status: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': `public, s-maxage=${win ? 300 : 30}, stale-while-revalidate=60`,
                    ...CORS_HEADERS,
                },
            });
        }

        // The HOT path: first candidate that answers wins.
        const got = await resolveSuvi(suviBand, 'GET');
        if (!got.ok) {
            // Same contract as the SDO branch: no placeholder frame. The
            // off-limb layer keeps its SDO source and says SUVI is down.
            return new Response(JSON.stringify({
                error: 'suvi_unavailable', channel, band: suviBand, tried: got.tried,
            }), {
                status: 502,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, s-maxage=30', ...CORS_HEADERS },
            });
        }
        const buf = await got.response.arrayBuffer();
        const observedAt = parseHttpDate(got.response.headers.get('last-modified'))
                        ?? parseHttpDate(got.response.headers.get('date'));
        return new Response(buf, {
            status: 200,
            headers: {
                'Content-Type': got.response.headers.get('content-type') || 'image/png',
                'Cache-Control': `public, s-maxage=${SUVI_CACHE_S}, stale-while-revalidate=${SWR_S}`,
                'X-AIA-Channel': String(channel),
                'X-AIA-Mode': historicalRequested ? 'live-fallback' : 'live',
                'X-SUVI-Band': String(suviBand),
                'X-SUVI-Source': got.source.id,
                'X-SUVI-Satellite': got.source.satellite,
                'X-SUVI-Upstream': got.source.url,
                ...(observedAt != null ? { 'X-SDO-Observed-At': new Date(observedAt).toISOString() } : {}),
                'X-SDO-Fetched-At': new Date().toISOString(),
                'Access-Control-Expose-Headers':
                    'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At, X-SDO-Fetched-At, '
                    + 'X-SUVI-Band, X-SUVI-Source, X-SUVI-Satellite, X-SUVI-Upstream',
                ...CORS_HEADERS,
            },
        });
    }

    if (wantMeta) {
        const fetchedAt = Date.now();
        let observedAt = null, error = null, upstreamStatus = null;
        try {
            const head = await fetchWithTimeout(upstream, { method: 'HEAD', timeoutMs: 9000 });
            upstreamStatus = head.status;
            if (!head.ok) throw new Error(`upstream HTTP ${head.status}`);
            observedAt = parseHttpDate(head.headers.get('last-modified')) ?? parseHttpDate(head.headers.get('date'));
        } catch (e) {
            error = String(e?.message ?? e);
        }
        const ageS = observedAt != null ? Math.max(0, Math.round((fetchedAt - observedAt) / 1000)) : null;
        const body = {
            source: 'sdo-latest', channel, res, upstream,
            observed_at: observedAt != null ? new Date(observedAt).toISOString() : null,
            fetched_at: new Date(fetchedAt).toISOString(),
            age_seconds: ageS,
            freshness: error ? 'expired' : freshnessOf(ageS),
            mode: historicalRequested ? 'live-fallback' : 'live',
            ...(error ? { error: 'aia_unavailable', detail: error, upstream_status: upstreamStatus } : {}),
        };
        return new Response(JSON.stringify(body), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': `public, s-maxage=${error ? 30 : 300}, stale-while-revalidate=60`,
                ...CORS_HEADERS,
            },
        });
    }

    try {
        const up = await fetchWithTimeout(upstream, {
            timeoutMs: 9000,
            headers: { Accept: 'image/jpeg,image/*' },
        });
        if (!up.ok) throw new Error(`upstream HTTP ${up.status}`);
        const buf = await up.arrayBuffer();
        const observedAt = parseHttpDate(up.headers.get('last-modified')) ?? parseHttpDate(up.headers.get('date'));
        return new Response(buf, {
            status: 200,
            headers: {
                'Content-Type': 'image/jpeg',
                'Cache-Control': `public, s-maxage=${CACHE_S}, stale-while-revalidate=${SWR_S}`,
                'X-AIA-Channel': String(channel),
                'X-AIA-Mode': historicalRequested ? 'live-fallback' : 'live',
                ...(observedAt != null ? { 'X-SDO-Observed-At': new Date(observedAt).toISOString() } : {}),
                'X-SDO-Fetched-At': new Date().toISOString(),
                'Access-Control-Expose-Headers': 'X-AIA-Channel, X-AIA-Mode, X-SDO-Observed-At, X-SDO-Fetched-At',
                ...CORS_HEADERS,
            },
        });
    } catch (e) {
        // No placeholder image — signal failure so the client falls back to
        // the synthetic DEM render (which already honours the channel).
        return new Response(JSON.stringify({ error: 'aia_unavailable', detail: String(e?.message ?? e) }), {
            status: 502,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, s-maxage=30',
                ...CORS_HEADERS,
            },
        });
    }
}
