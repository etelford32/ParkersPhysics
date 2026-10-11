-- supabase-validation-runs-migration.sql
-- Storage + data plumbing for the DAILY validation re-run
-- (api/cron/validation-rerun.js): each run re-scores the back-mapping
-- attribution and the 27-day recurrence hindcast over the rolling
-- solar_wind_samples window and appends one row per study.
--
-- ACCESS MODEL (same as forecast_log / solar_wind_samples — documented in
-- CLAUDE.md §4.2): RLS enabled with ZERO policies, deliberately. The table
-- is written by the cron (service role) and read by the edge endpoint
-- /api/ring-current/validation (service role). Do NOT add permissive
-- policies; the advisor flag is a known false positive here.

CREATE TABLE IF NOT EXISTS public.validation_runs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ran_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    kind          TEXT NOT NULL CHECK (kind IN ('backmap', 'recurrence')),
    window_start  TIMESTAMPTZ NOT NULL,
    window_end    TIMESTAMPTZ NOT NULL,
    -- Headline numbers, queryable without unpacking jsonb:
    n_forecasts   INTEGER,
    hits          INTEGER,
    hit_rate      DOUBLE PRECISION,
    mae_days      DOUBLE PRECISION,   -- recurrence timing MAE (null for backmap)
    skill         DOUBLE PRECISION,   -- vs chance (backmap ±20°) / vs random (recurrence)
    -- Full study output for the reports/endpoint:
    metrics       JSONB NOT NULL DEFAULT '{}'::jsonb,
    detail        JSONB
);

CREATE INDEX IF NOT EXISTS validation_runs_kind_ran_at
    ON public.validation_runs (kind, ran_at DESC);

ALTER TABLE public.validation_runs ENABLE ROW LEVEL SECURITY;
-- No policies: service-role-only by design (see header).

-- 6-hour median wind buckets over the last p_days days — the exact input
-- shape the scoring engine takes. SECURITY DEFINER so the cron can call it
-- through PostgREST RPC; NOT part of the anonymous telemetry surface, so
-- EXECUTE is revoked from anon/authenticated (CLAUDE.md §8).
CREATE OR REPLACE FUNCTION public.validation_wind_buckets(p_days INTEGER DEFAULT 16)
RETURNS TABLE (bucket TIMESTAMPTZ, v_med DOUBLE PRECISION, n BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT date_trunc('day', observed_at)
             + make_interval(hours => 6 * floor(extract(hour FROM observed_at) / 6)::int) AS bucket,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY speed_km_s) AS v_med,
           count(*) AS n
    FROM solar_wind_samples
    WHERE observed_at > now() - make_interval(days => GREATEST(1, LEAST(60, p_days)))
      AND speed_km_s BETWEEN 150 AND 1200
    GROUP BY 1
    ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION public.validation_wind_buckets(INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.validation_wind_buckets(INTEGER) FROM authenticated;

-- ── Addendum (applied as migration validation_runs_cme_kind) ────────────────
-- Third self-scoring loop: CME arrival verification (predicted ETA —
-- WSA-ENLIL preferred, ballistic cross-check — vs the actual Pdyn shock
-- detection). kind gains 'cme'; validation_pdyn_series feeds the shock
-- detector with 15-min dynamic-pressure medians (Pdyn = 1.6726e-6·n·v²,
-- the same constant as js/ring-current-model.js PHYS.MP_FACTOR).

ALTER TABLE public.validation_runs DROP CONSTRAINT IF EXISTS validation_runs_kind_check;
ALTER TABLE public.validation_runs
    ADD CONSTRAINT validation_runs_kind_check CHECK (kind IN ('backmap', 'recurrence', 'cme'));

CREATE OR REPLACE FUNCTION public.validation_pdyn_series(p_days INTEGER DEFAULT 16)
RETURNS TABLE (bucket TIMESTAMPTZ, pdyn_med DOUBLE PRECISION, n BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT date_trunc('hour', observed_at)
             + make_interval(mins => 15 * floor(extract(minute FROM observed_at) / 15)::int) AS bucket,
           percentile_cont(0.5) WITHIN GROUP (
               ORDER BY 1.6726e-6 * density_cc * speed_km_s * speed_km_s) AS pdyn_med,
           count(*) AS n
    FROM solar_wind_samples
    WHERE observed_at > now() - make_interval(days => GREATEST(1, LEAST(60, p_days)))
      AND speed_km_s BETWEEN 150 AND 1200
      AND density_cc BETWEEN 0.05 AND 200
    GROUP BY 1
    ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION public.validation_pdyn_series(INTEGER) FROM anon;
REVOKE EXECUTE ON FUNCTION public.validation_pdyn_series(INTEGER) FROM authenticated;

-- ── Addendum (migration validation_runs_flux_rope_kind, written 2026-10-11) ──
-- Fourth loop: the flux-rope-v1 per-flare ledger (FLUX_ROPE_SIMULATOR_PLAN.md
-- "daily validation"). api/cron/validation-rerun.js has inserted
-- kind='flux-rope' rows since 2026-07-28, but this CHECK was never widened,
-- so EVERY insert failed with 23514 (first logged scored run: 2026-09-16,
-- 10 events) and the model's real-data skill was thrown away. Pure widening:
-- no existing row changes, nothing reads the constraint.
ALTER TABLE public.validation_runs DROP CONSTRAINT IF EXISTS validation_runs_kind_check;
ALTER TABLE public.validation_runs
    ADD CONSTRAINT validation_runs_kind_check
    CHECK (kind IN ('backmap', 'recurrence', 'cme', 'flux-rope'));

-- Same migration: the public leaderboard view scores ONE honest lock per
-- (event, model) — the latest that was still a forecast when issued
-- (predicted arrival after issue) AND, for an arrival, issued before the
-- observed shock. The original view averaged EVERY row, and the daily
-- re-run kept appending rows after a CME had hit (the provider had already
-- assimilated the shock from live L1): on the 2026-09 ledger flux-rope-v1
-- read MAE 26.4 h over 8 events from leaked rows vs 18.1 h over the 6 with
-- an honest lock. Mirrors js/flux-rope-validation.js selectScorableLock
-- (api/cme/skill.js uses it for the per-event rows; the cron scores with it).
CREATE OR REPLACE VIEW public.cme_model_skill
WITH (security_invoker = false) AS
WITH honest AS (
    SELECT DISTINCT ON (f.event_id, f.model_id) f.*
    FROM public.cme_arrival_forecasts f
    JOIN public.cme_l1_observations o USING (event_id)
    WHERE f.predicted_arrival_utc > f.issued_at
      AND (NOT o.arrived OR o.shock_arrival_utc IS NULL OR f.issued_at < o.shock_arrival_utc)
    ORDER BY f.event_id, f.model_id, f.issued_at DESC
)
SELECT
    f.model_id,
    e.is_hindcast,
    count(*)                                   AS n_scored,
    count(*) FILTER (WHERE o.arrived AND f.predicted_hit
        AND abs(extract(epoch FROM (f.predicted_arrival_utc - o.shock_arrival_utc))) <= 43200)
                                               AS hits_12h,
    avg(abs(extract(epoch FROM (f.predicted_arrival_utc - o.shock_arrival_utc))) / 3600.0)
        FILTER (WHERE o.arrived AND o.shock_arrival_utc IS NOT NULL)
                                               AS mae_hours,
    avg(extract(epoch FROM (f.predicted_arrival_utc - o.shock_arrival_utc)) / 3600.0)
        FILTER (WHERE o.arrived AND o.shock_arrival_utc IS NOT NULL)
                                               AS bias_hours,   -- + = predicted late
    count(*) FILTER (WHERE f.predicted_hit AND NOT o.arrived)   AS false_alarms,
    count(*) FILTER (WHERE NOT f.predicted_hit AND o.arrived)   AS misses
FROM honest f
JOIN public.cme_events e USING (event_id)
JOIN public.cme_l1_observations o USING (event_id)
GROUP BY f.model_id, e.is_hindcast;

REVOKE ALL ON public.cme_model_skill FROM anon;
REVOKE ALL ON public.cme_model_skill FROM authenticated;
