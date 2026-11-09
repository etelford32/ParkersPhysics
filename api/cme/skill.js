/**
 * Vercel Edge Function: /api/cme/skill
 *
 * Public read of the CME validation program's per-model skill ledger
 * (CME_FORECAST_VALIDATION_PLAN.md Phase 3): the cme_model_skill view
 * (timing MAE/bias, ≤12 h hits, false alarms, misses — split hindcast vs
 * realtime) plus the most recent realtime events with their issue-time-
 * locked forecasts and resolved L1 truth. This is what the space-weather
 * CME calendar renders as the prediction scorecard: skill shown, not
 * claimed — every number traces to a forecast row locked BEFORE arrival.
 *
 * The underlying tables are service-role-only (zero-policy RLS, CLAUDE.md
 * §4.2); this endpoint is the deliberate public window. Per-event rows
 * expose only forecast/observation times of public NASA-catalogued CMEs.
 *
 * Query params:
 *   ?events=N   recent realtime events to include (default 24, max 60)
 *
 * Cache: 10 min CDN (the tables change at cron cadence).
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { selectScorableLock } from '../../js/flux-rope-validation.js';
import { LEDGER_PIPELINE, ledgerFreshness, outlookByDay } from '../../js/cme-ledger-status.js';

const OUTLOOK_MODEL = 'cme-outlook-v0';
const OUTLOOK_LOOKBACK_DAYS = 62;      // two calendar months of locked daily odds

export const config = { runtime: 'edge' };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY || '';

export default async function handler(request) {
    if (!SUPABASE_URL || !SUPABASE_KEY) {
        return jsonError('not_configured', 'supabase env missing', { status: 503 });
    }
    const nEvents = Math.max(1, Math.min(60,
        parseInt(new URL(request.url).searchParams.get('events') ?? '24', 10) || 24));

    const headers = {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Accept: 'application/json',
    };
    const get = async (path) => {
        const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1/${path}`,
            { timeoutMs: 8000, headers });
        if (!res.ok) throw new Error(`${path.split('?')[0]} HTTP ${res.status}`);
        return res.json();
    };

    // Optional reads: a failure here must degrade the calendar's daily
    // layer, never take the forecast ledger down with it.
    const soft = (path) => get(path).catch(() => null);
    const sinceDay = new Date(Date.now() - OUTLOOK_LOOKBACK_DAYS * 86400e3).toISOString().slice(0, 10);

    let skill, events, heartbeat, outlookRows;
    try {
        // PostgREST embeds forecasts + truth through the FKs in one call.
        [skill, events, heartbeat, outlookRows] = await Promise.all([
            get('cme_model_skill?select=*'),
            get('cme_events?is_hindcast=eq.false' +
                '&select=event_id,donki_id,launch_time_utc,speed_kms_3d,' +
                'half_width_deg,direction_lat_deg,direction_lon_deg,' +
                'cme_arrival_forecasts(model_id,issued_at,predicted_arrival_utc,' +
                'arrival_window_early,arrival_window_late,predicted_kp_max,' +
                'predicted_speed_at_l1,inputs),' +
                'cme_l1_observations(arrived,shock_arrival_utc,observed_bz_min_nt,observed_speed_kms)' +
                `&order=launch_time_utc.desc&limit=${nEvents}`),
            soft(`pipeline_heartbeat?pipeline_name=eq.${LEDGER_PIPELINE}` +
                '&select=last_success_at,last_failure_at,last_failure_reason,last_source,consecutive_fail'),
            // 62 d × 7 leads = 434 rows — under PostgREST's 1000-row cap.
            soft(`cme_outlook_issues?model_id=eq.${OUTLOOK_MODEL}&valid_day=gte.${sinceDay}` +
                '&select=issue_day,valid_day,lead_days,p_arrival,p_geo,lower_bound,' +
                'obs_arrival,obs_geo,resolved_at,issued_at&order=issued_at.desc&limit=1000'),
        ]);
    } catch (e) {
        return jsonError('upstream_unavailable', e.message, { source: 'supabase' });
    }

    // Trim events: ONE forecast per model, truth flattened. The one shown
    // is the latest that was still a FORECAST — issued before its own
    // predicted arrival and before the observed shock (selectScorableLock,
    // the same rule the cron scores with). "Latest row" used to be shown
    // here, and the daily re-run kept locking after the CME had hit: on the
    // 2026-09 ledger 4 of 8 arrived events displayed a row issued AFTER the
    // shock as the model's forecast (tests/flux-rope-ledger-real.mjs).
    const trimmed = (events ?? []).map(ev => {
        const truth = (ev.cme_l1_observations ?? [])[0]
            ?? (ev.cme_l1_observations && !Array.isArray(ev.cme_l1_observations)
                ? ev.cme_l1_observations : null);   // 1:1 FK may embed as object
        const sel = {
            arrived: truth?.arrived === true,
            shockMs: truth?.shock_arrival_utc ? Date.parse(truth.shock_arrival_utc) : NaN,
        };
        const rowsByModel = {};
        for (const f of ev.cme_arrival_forecasts ?? []) {
            (rowsByModel[f.model_id] ??= []).push(f);
        }
        const byModel = {};
        for (const [m, rows] of Object.entries(rowsByModel)) {
            const { lock } = selectScorableLock(rows, sel);
            if (lock) byModel[m] = lock;
        }
        return {
            event_id: ev.event_id,
            donki_id: ev.donki_id,
            launch: ev.launch_time_utc,
            speed_kms: ev.speed_kms_3d,
            // Direction lets the page say WHY an event has baseline rows but
            // no flux-rope forecast (it sits outside its own cone).
            half_deg: ev.half_width_deg ?? null,
            lat_deg: ev.direction_lat_deg ?? null,
            lon_deg: ev.direction_lon_deg ?? null,
            forecasts: Object.fromEntries(Object.entries(byModel).map(([m, f]) => [m, {
                issued_at: f.issued_at,
                predicted: f.predicted_arrival_utc,
                early: f.arrival_window_early,
                late: f.arrival_window_late,
                kp_max: f.predicted_kp_max,
                v_l1: f.predicted_speed_at_l1 ?? null,
                // flux-rope-v1 rows carry probabilistic content in the
                // frozen inputs — expose the COMPACT subset the ledger
                // renders (never the full replay payload).
                ...(m === 'flux-rope-v1' && f.inputs ? {
                    p_hit: f.inputs.p_hit ?? null,
                    p10: f.inputs.p10 ?? null,
                    p20: f.inputs.p20 ?? null,
                    min_bz_p50: f.inputs.min_bz_p50 ?? null,
                    min_bz_p5: f.inputs.min_bz_p5 ?? null,
                    n_train: Array.isArray(f.inputs.train) ? f.inputs.train.length : 1,
                    flare: f.inputs.flare ?? null,
                    // §16 counterfactual (trains): this rope's interaction
                    // arrival shift + the train-level ON-vs-OFF deltas —
                    // the compact face of the locked compounding block.
                    wake_delta_h: f.inputs.wake?.delta_arrival_h ?? null,
                    ...(f.inputs.compounding ? { compounding: {
                        min_bz_p50_on: f.inputs.compounding.on?.min_bz_p50 ?? null,
                        min_bz_p50_off: f.inputs.compounding.off?.min_bz_p50 ?? null,
                        delta_min_bz: f.inputs.compounding.delta?.min_bz_p50 ?? null,
                        delta_p20: f.inputs.compounding.delta?.p20 ?? null,
                        amp_pred: f.inputs.compounding.amp_pred ?? null,
                    } } : {}),
                } : {}),
            }])),
            truth: truth ? {
                arrived: truth.arrived === true,
                shock: truth.shock_arrival_utc ?? null,
                min_bz_nt: truth.observed_bz_min_nt ?? null,
                v_kms: truth.observed_speed_kms ?? null,
            } : null,
        };
    });

    // ── The daily-run record. `updated` used to be the REQUEST time, which
    //    made this route (and the page's "updated …" label, and status.html)
    //    fresh by construction: four quiet weeks and a dead cron looked the
    //    same. It is now the last time the cron actually ran. The heartbeat
    //    row is authoritative; before the first heartbeat lands (the deploy
    //    that introduced it) the newest locked outlook issue stands in.
    const outlook = outlookByDay(outlookRows ?? []);
    const hb = Array.isArray(heartbeat) ? heartbeat[0] ?? null : null;
    const newestIssueAt = (outlookRows ?? [])[0]?.issued_at ?? null;
    // "Ran" = the cron executed and recorded an outcome, success or not.
    const ranAt = [hb?.last_success_at, hb?.last_failure_at, newestIssueAt]
        .map((t) => Date.parse(t ?? '')).filter(Number.isFinite);
    const lastRunMs = ranAt.length ? Math.max(...ranAt) : NaN;
    const nowMs = Date.now();
    const failing = Number(hb?.consecutive_fail) > 0;
    const fresh = ledgerFreshness(lastRunMs, nowMs);
    const freshness = fresh.state === 'fresh' ? (failing ? 'stale' : 'fresh')
        : fresh.state === 'stale' ? 'stale' : 'expired';
    const ledger = {
        last_run: Number.isFinite(lastRunMs) ? new Date(lastRunMs).toISOString() : null,
        age_h: fresh.ageH === null ? null : Math.round(fresh.ageH * 10) / 10,
        state: fresh.state,
        // The run's own one-line account ("44 CMEs screened · 2 Earth-
        // relevant · 0 new locks · flux-rope idle (…) · outlook issued").
        summary: failing ? null : hb?.last_source ?? null,
        consecutive_fail: Number(hb?.consecutive_fail) || 0,
        last_failure_at: hb?.last_failure_at ?? null,
        last_failure_reason: failing ? hb?.last_failure_reason ?? null : null,
        basis: hb ? 'heartbeat' : newestIssueAt ? 'outlook-issue' : 'none',
        schedule: 'daily 06:30 UT',
    };

    return jsonOk({
        source: 'cme_model_skill + cme_events (issue-time-locked forecasts)',
        freshness,
        data: {
            updated: ledger.last_run,
            served: new Date(nowMs).toISOString(),
            ledger,
            outlook: { model: OUTLOOK_MODEL, ...outlook },
            models: skill ?? [],
            events: trimmed,
        },
    }, { maxAge: 600, swr: 120 });
}
