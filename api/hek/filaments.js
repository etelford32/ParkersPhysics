/**
 * Vercel Edge Function: /api/hek/filaments
 *
 * Source: HEK (Heliophysics Event Knowledgebase) — http://www.lmsal.com/hek
 *         event types FI (filament), FA (filament activation), PG (prominence)
 *
 * Feeds the COOL-MATERIAL channel of sun.html's volumetric corona: the dark
 * filaments seen on the disk in 171/193/211 and the bright prominences seen
 * off the limb in 304 are the same plasma, and a raymarcher that carries it as
 * a density gets absorption, emission, occlusion and parallax from one field.
 *
 * WHY THIS IS AN OBSERVED FEED AND NOT DERIVED FROM THE FIELD MODEL. The
 * channel was designed to be filled from MAGNETIC DIPS in the PFSS-lite atlas,
 * which is where real prominence material collects. That was measured and the
 * atlas has ZERO dips in every configuration — because it is a POTENTIAL
 * field, and dips deep enough to hold material require field-aligned currents.
 * See js/hek-filaments.js's header and rust-sunfield/examples/dip_scan.rs.
 *
 * Normalization, the candidate-list field resolution and the de-duplication
 * all live in js/hek-filaments.js — read that header before touching the
 * candidate lists. This route only fetches, calls it, and reports.
 *
 * DEGRADES, NEVER 5xx on a thin answer: a window with no detections is a
 * legitimate quiet day and returns 200 with an empty list; a window we could
 * not READ (no position field resolved) returns 200 with `freshness: 'stale'`
 * and a note, so status.html flags it instead of scoring an empty 200 healthy.
 * Only an unreachable or unparseable upstream is an error.
 *
 * Response shape (success):
 *   {
 *     source: 'HEK filament/prominence catalog (LMSAL)',
 *     freshness?: 'stale',
 *     data: {
 *       updated: ISO8601, window_hours: int, count: int,
 *       filaments: [{ event_type, lat_deg, lon_deg, lon_carrington_deg,
 *                     length_deg, tilt_deg, chirality, frm_name, time,
 *                     detections }],
 *       field_map, unmapped_keys, counts, detectors, length_clamped, dropped
 *     }
 *   }
 */
import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { normalizeHekFilaments, dedupeFilaments, REQUIRED_FIELDS, EVENT_TYPES } from '../../js/hek-filaments.js';

export const config = { runtime: 'edge' };

const HEK_BASE   = 'https://www.lmsal.com/hek/her';
const CACHE_TTL  = 1800;    // 30 min — detections are produced a few times a day
const CACHE_SWR  = 300;
// Quiescent filaments live for weeks, but a detector only re-publishes every
// few hours, so a short window would show an empty Sun on a perfectly ordinary
// day. 48 h is long enough to catch every active detector at least once.
const WINDOW_H   = 48;
const MAX_ROWS   = 200;
/** Merge radius for detections of the same structure, degrees on the sphere. */
const DEDUPE_DEG = 8;
/** Cap what the client receives — the volume rasteriser does not need more. */
const MAX_OUT    = 40;

export default async function handler() {
    // HEK timestamps need second resolution and NO trailing milliseconds
    // (the upstream parser is finicky) — same as /api/hek/coronal-holes.
    const end   = new Date();
    const start = new Date(end.getTime() - WINDOW_H * 3600 * 1000);
    const fmt   = (d) => d.toISOString().replace(/\.\d{3}Z$/, '');

    const params = new URLSearchParams({
        cmd:             'search',
        type:            'column',
        event_type:      EVENT_TYPES.join(',').toLowerCase(),
        event_starttime: fmt(start),
        event_endtime:   fmt(end),
        result_limit:    String(MAX_ROWS),
        cosec:           '2',
    });
    // NOTE: no `return=` whitelist here, unlike the coronal-hole route. The
    // filament-specific column names are UNVERIFIED (egress-blocked at build
    // time), and a whitelist of guessed names would return rows with those
    // columns MISSING — which is indistinguishable from a feed that does not
    // publish them. Taking every column is what makes `unmapped_keys` able to
    // tell us the real spellings from one production request.

    let raw;
    try {
        const res = await fetchWithTimeout(`${HEK_BASE}?${params.toString()}`, {
            headers: { Accept: 'application/json' },
            timeoutMs: 16000,        // HEK is regularly >8 s cold
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        raw = await res.json();
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'HEK' });
    }

    let norm;
    try {
        norm = normalizeHekFilaments(raw);
    } catch (e) {
        return jsonError('parse_error', e.message, { source: 'HEK' });
    }

    const merged = dedupeFilaments(norm.filaments, DEDUPE_DEG).slice(0, MAX_OUT);

    // A window with no detections is a quiet day, which is fine. A window
    // where we could not resolve a POSITION field is a schema miss on our
    // side, and it must not be scored as a healthy empty answer.
    const missing = REQUIRED_FIELDS.filter((f) => !norm.field_map[f]);
    const schemaMiss = missing.length > 0 && Array.isArray(raw?.result) && raw.result.length > 0;

    const body = {
        source: 'HEK filament/prominence catalog (LMSAL)',
        data: {
            updated:       new Date().toISOString(),
            window_hours:  WINDOW_H,
            count:         merged.length,
            filaments:     merged,
            field_map:     norm.field_map,
            unmapped_keys: norm.unmapped_keys,
            counts:        norm.counts,
            detectors:     norm.detectors,
            length_clamped: norm.length_clamped,
            dropped:       norm.dropped,
            raw_rows:      Array.isArray(raw?.result) ? raw.result.length : 0,
        },
    };
    if (schemaMiss) {
        body.freshness = 'stale';
        body.note = `HEK returned ${raw.result.length} rows but no position field resolved `
                  + `(missing: ${missing.join(', ')}). Check data.unmapped_keys for the real `
                  + `spellings and add them to FIELD_CANDIDATES in js/hek-filaments.js.`;
    }
    // Every length on a clamp bound is the signature of a unit mistake, not of
    // a Sun covered in identical filaments. Say so rather than drawing them.
    if (norm.length_clamped > 0 && norm.length_clamped === merged.length && merged.length > 2) {
        body.freshness = 'stale';
        body.note = (body.note ? body.note + ' ' : '')
                  + `Every filament length hit a clamp bound (${norm.length_clamped}); the upstream `
                  + `length unit is probably not arcsec.`;
    }

    return jsonOk(body, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
