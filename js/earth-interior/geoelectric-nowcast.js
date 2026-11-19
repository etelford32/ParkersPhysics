/**
 * geoelectric-nowcast.js — live geoelectric field at the USGS observatories,
 * from the SAME payload TIGA reads (`/api/geomag/observatories`).
 * Pure apart from the injectable fetch. Gate: `tests/earth-interior-geoelectric.mjs`.
 *
 * ── WHAT A NUMBER HERE MEANS ─────────────────────────────────────────────
 * "The surface E field this 1-D ground column would carry under the field
 * measured at this observatory." Three things it is NOT, each said on every
 * station record (`label`, `column.note`):
 *   • not E at a power line away from the observatory (B is measured only
 *     here; interpolating it between observatories is the next step — SECS);
 *   • not a measured E (no electrodes; the ground is a modelled column);
 *   • not the ground's real 3-D response (coasts and basins change E by
 *     factors; a 1-D column is the TPL-007 planning method, no more).
 *
 * ── WHICH COLUMN A STATION GETS ──────────────────────────────────────────
 * Never inferred from a coordinate (the TIGA rule: a coordinate-to-anything
 * table typed from memory cost 9.35° once). A station gets a column by ID:
 *   1. the caller's explicit `columns[IAGA]`, else
 *   2. a published model NAMED for that observatory (BOU has one), else
 *   3. GRAYVER-LAND — the global average — flagged `columnBasis:'global-default'`.
 * USGS's region polygons (which model applies where) are not baked; until
 * they are, (3) is the honest default and the record says so.
 *
 * The field is the observatory VARIATION record: E depends only on changes,
 * so TIGA's provisional trailing-median baseline does not enter at all.
 */

import { fetchObservatories } from '../geomag/ingest.js';
import { toDipole, dipoleBasisForYear, decimalYear } from '../geomag/dipole.js';
import {
    geoelectricSeries, groundColumnInfo, tpl007Planning, WARMUP_SAMPLES,
} from './geoelectric.js';
import { GROUND_MODELS } from './ground-models.js';

/** Minutes of history to request: WARMUP_SAMPLES of warm-up + 8 h of usable E. */
export const NOWCAST_WINDOW_MIN = 720;
/** "Recent peak" window, minutes. */
export const PEAK_WINDOW_MIN = 60;

export const NOWCAST_LABEL = 'Modelled: 1-D ground column × observatory magnetometer. '
    + 'Not a measured E, not E away from the observatory, not a 3-D ground response.';

/** Which column a station gets, and why. */
export function columnFor(iaga, columns = {}) {
    if (columns[iaga]) return { id: columns[iaga], basis: 'explicit' };
    if (GROUND_MODELS.some((m) => m.id === iaga)) return { id: iaga, basis: 'observatory-model' };
    return { id: 'GRAYVER-LAND', basis: 'global-default' };
}

/**
 * One station's nowcast record from a normalised relay station.
 * @returns record, or { code, skipped: reason } when E cannot be computed.
 */
export function stationNowcast(st, { columns = {}, dtS = 60, epoch = null } = {}) {
    const code = st.iaga;
    if (!Array.isArray(st.x) || !Array.isArray(st.y)) return { code, skipped: 'no-east-component' };
    const col = columnFor(code, columns);
    const info = groundColumnInfo(col.id);
    if (!info) return { code, skipped: `unknown-column:${col.id}` };
    const ser = geoelectricSeries({ bNorthNt: st.x, bEastNt: st.y, column: col.id, dtS });
    const n = st.times.length;
    let last = -1;
    for (let i = n - 1; i >= 0; i--) if (ser.eMagVkm[i] !== null) { last = i; break; }
    if (last < 0) return { code, skipped: 'no-data' };
    let peak = null, peakAt = null;
    for (let i = Math.max(0, last - PEAK_WINDOW_MIN + 1); i <= last; i++) {
        const v = ser.eMagVkm[i];
        if (v !== null && !ser.warmup[i] && (peak === null || v > peak)) { peak = v; peakAt = st.times[i]; }
    }
    const when = epoch ?? new Date(st.times[last]);
    const dip = toDipole(st.geodeticLatitude, st.geodeticLongitude, dipoleBasisForYear(decimalYear(when)));
    const plan = tpl007Planning(col.id, dip.latDeg);
    const latest = ser.eMagVkm[last];
    return {
        code, name: st.name ?? code,
        geodeticLatitude: st.geodeticLatitude, geodeticLongitude: st.geodeticLongitude,
        geomagLatDeg: dip.latDeg,
        column: { ...info, basis: col.basis,
                  note: col.basis === 'global-default'
                      ? 'No regional column assigned: global-average ground. Local E can differ by several times.'
                      : (info.note ?? null) },
        latest: {
            time: st.times[last], eNorthVkm: ser.eNorthVkm[last], eEastVkm: ser.eEastVkm[last], eMagVkm: latest,
            warmup: !!ser.warmup[last], bridged: !!ser.bridged[last],
        },
        peakLastHourVkm: peak, peakLastHourAt: peakAt,
        tpl007: plan ? { ...plan, latestOverBenchmark: latest / plan.benchmarkVkm } : null,
        series: { times: st.times, eNorthVkm: ser.eNorthVkm, eEastVkm: ser.eEastVkm, eMagVkm: ser.eMagVkm,
                  warmup: ser.warmup, bridged: ser.bridged },
        label: NOWCAST_LABEL,
    };
}

/** Every station in a relay payload. */
export function nowcastFromPayload(payload, opts = {}) {
    const stations = payload?.data?.stations ?? [];
    const records = stations.map((s) => stationNowcast(s, opts));
    return {
        updated: payload?.data?.updated ?? null,
        stations: records.filter((r) => !r.skipped),
        skipped: records.filter((r) => r.skipped).map((r) => ({ code: r.code, reason: r.skipped })),
        missing: payload?.data?.missing ?? [],
        warmupMinutes: WARMUP_SAMPLES,
        label: NOWCAST_LABEL,
    };
}

/** Fetch + compute. `fetchImpl` injectable (the gate runs offline). */
export async function fetchGeoelectricNowcast({ columns = {}, fetchImpl = null, endpoint, signal } = {}) {
    const payload = await fetchObservatories({ minutes: NOWCAST_WINDOW_MIN, fetchImpl, endpoint, signal });
    return nowcastFromPayload(payload, { columns });
}
