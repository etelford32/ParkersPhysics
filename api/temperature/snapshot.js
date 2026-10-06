/**
 * Edge route: /api/temperature/snapshot[?surface=land|ocean|all][&region=<name>]
 *
 * The Planetary Temperature Lab's one live answer (PLANETARY_TEMPERATURE_LAB_PLAN.md
 * §4.5): where Earth is hottest, coldest, and most unusual for the date right now,
 * against the 1991–2020 ERA5 normal. The lab page and the EarthView panel both
 * read it, so a scorecard means the same thing on both.
 *
 *   1. the newest temperature_lab_cache row — the trailing-24-h aggregate that
 *      compute_temperature_lab() builds in Postgres hourly at :25 from
 *      weather_grid_cache (supabase-temperature-lab-migration.sql). No new
 *      upstream call: the grid is already fetched once an hour
 *   2. the shipped normals (assets/temperature/*.bin), fetched from this
 *      deployment's own origin once per isolate and kept in module scope
 *   3. js/temperature-lab-model.js buildLabModel — the ONE definition of the
 *      cards and the planet strip (also imported by the page and the tests)
 *
 * NEVER A 5xx FOR A DEGRADED ANSWER (CLAUDE.md §8): a missing aggregate or
 * missing normals is a 200 with `freshness: 'expired'` and the reason, a
 * fallback source / thin coverage / an old window is `freshness: 'stale'` —
 * so status.html shows a degraded lab as degraded instead of scoring a 200
 * healthy. The pure half (row validation, freshness, encoding) is
 * api/_lib/temperature-snapshot.js, node-tested by
 * tests/temperature-snapshot-route.mjs.
 *
 * ── Env vars ────────────────────────────────────────────────────────
 *   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_KEY / SUPABASE_SECRET_KEY — or the publishable key: the
 *   table has an anon SELECT policy (derived public analysis), the
 *   weather_extremes_cache precedent
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { parseNormalsAsset } from '../../js/temperature-normals.js';
import { buildLabModel } from '../../js/temperature-lab-model.js';
import { REGION_NAMES } from '../../js/geo-regions.js';
import { encodeResponse, freshnessOf, normalizeLabRow } from '../_lib/temperature-snapshot.js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
    || process.env.SUPABASE_SECRET_KEY
    || process.env.SUPABASE_PUBLISHABLE_KEY
    || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY
    || '';

const CACHE_TTL = 900;     // the aggregate changes hourly
const CACHE_SWR = 600;
const SURFACES = new Set(['land', 'ocean', 'all']);
// Only a name from the shared table reaches the model — the cache key space
// stays bounded and nothing user-typed is echoed back unvalidated.
const REGION_SET = new Set(REGION_NAMES);
const ASSET_FILES = Object.freeze({
    daily: 'normals-1991-2020.bin',
    quantiles: 'quantiles-1991-2020.bin',
    records: 'records-1991-2020.bin',
});

// One load per isolate. A failure clears the promise so the next request
// retries instead of caching the failure for the isolate's whole life.
let assetsPromise = null;
function loadAssets(origin) {
    if (!assetsPromise) {
        assetsPromise = (async () => {
            const out = {};
            for (const [key, file] of Object.entries(ASSET_FILES)) {
                const res = await fetchWithTimeout(new URL(`/assets/temperature/${file}`, origin), { timeoutMs: 8000 });
                if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
                out[key] = parseNormalsAsset(new Uint8Array(await res.arrayBuffer()));
            }
            return out;
        })().catch((err) => { assetsPromise = null; throw err; });
    }
    return assetsPromise;
}

async function readLatestRow() {
    const url = `${SUPABASE_URL}/rest/v1/temperature_lab_cache`
        + `?select=computed_at,frame_from,frame_to,n_frames,sources,payload`
        + `&order=computed_at.desc&limit=1`;
    const res = await fetchWithTimeout(url, {
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export default async function handler(request) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError('supabase_not_configured',
            'SUPABASE_URL / SUPABASE_SERVICE_KEY (or a publishable key) missing', { status: 500 });
    }
    const url = new URL(request.url);
    const surface = SURFACES.has(url.searchParams.get('surface')) ? url.searchParams.get('surface') : 'land';
    const region = REGION_SET.has(url.searchParams.get('region')) ? url.searchParams.get('region') : null;
    const nowMs = Date.now();

    let snapshot = null, rowError = null;
    try {
        snapshot = normalizeLabRow(await readLatestRow());
    } catch (err) {
        rowError = err.message;
    }

    let model = null, normalsOk = false, normalsError = null;
    if (snapshot) {
        try {
            const assets = await loadAssets(url.origin);
            normalsOk = true;
            model = buildLabModel(snapshot, assets, { surface, region });
        } catch (err) {
            normalsError = err.message;
        }
    }

    const fresh = freshnessOf({ snapshot, model, normalsOk, nowMs });
    const body = encodeResponse({ snapshot, model, fresh });
    if (!snapshot) {
        body.note = rowError
            ? `temperature_lab_cache unreadable (${rowError}) — is supabase-temperature-lab-migration.sql applied?`
            : 'temperature_lab_cache has no usable row yet — compute_temperature_lab() runs hourly at :25';
    } else if (normalsError) {
        body.note = `normals unavailable (${normalsError})`;
    }
    // A degraded answer is cached briefly so recovery shows up fast.
    const maxAge = fresh.freshness === 'expired' ? 60 : CACHE_TTL;
    return jsonOk(body, { maxAge, swr: fresh.freshness === 'expired' ? 60 : CACHE_SWR });
}
