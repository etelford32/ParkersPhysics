-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Weather Grid Cache (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Creates a shared hourly cache of Open-Meteo grid data so every
-- visitor reads from one row instead of each browser hitting the
-- upstream API. Safe to re-run (IF NOT EXISTS).
--
--   weather_grid_cache — history of hourly grid snapshots
--     id           BIGSERIAL primary key
--     fetched_at   when the upstream fetch completed
--     source       provider label (open-meteo, etc.)
--     payload      JSONB array of per-location current-weather objects
--                  (same shape as Open-Meteo's multi-location response;
--                  originally 648 points, 2592 since the Vercel-cron
--                  writer took over)
--
-- Writer history: originally Supabase pg_cron (see
-- supabase-weather-pgcron-migration.sql); superseded by the Vercel cron
-- api/cron/refresh-weather-grid.js (hourly, sole writer, vercel.json).
-- /api/weather/grid returns the newest row to browsers via the CDN.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.weather_grid_cache (
    id          BIGSERIAL PRIMARY KEY,
    fetched_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    source      TEXT        NOT NULL DEFAULT 'open-meteo',
    payload     JSONB       NOT NULL
);

CREATE INDEX IF NOT EXISTS weather_grid_cache_fetched_at_idx
    ON public.weather_grid_cache (fetched_at DESC);

-- RLS: table is server-only. The refresh/grid edge functions use the
-- service_role key (bypasses RLS). Block all anon/authenticated access so
-- browsers must go through the cached edge endpoint.
ALTER TABLE public.weather_grid_cache ENABLE ROW LEVEL SECURITY;

-- No policies = no rows visible to anon/authenticated roles.
-- (service_role bypasses RLS entirely, so the edge fns still work.)

-- Retention: 30 days, but DECIMATED — the last 72 h stay hourly and
-- everything older is thinned to 3-hourly (~288 rows, ~47 MB).
--
-- WHY, and do NOT "restore" the flat 720 (2026-09-19): flat hourly made
-- this table 137 MB — 58% of a 235 MB database on a 500 MB free tier —
-- and 489 of those frames were read by NOTHING. The only consumers are
-- /api/weather/grid (newest row; range read capped at 72 by
-- RANGE_MAX_LIMIT, an Edge response-body limit) and
-- compute_weather_extremes(), which decimates by 3 and whose own ledger
-- recorded frames_sampled = 231 of 720. 3-hourly beyond 72 h therefore
-- keeps the full 30-day span at the resolution anything actually reads,
-- and the extremes job now samples MORE frames than it did before.
--
-- The anchor is max(fetched_at), NOT now(): during the 2026-09-18 API
-- outage the newest frame was 15 h old, and a now()-anchored window
-- would have eaten most of the hourly tail it is supposed to protect.
--
-- LOAD-BEARING LOCKSTEP: pg_cron job 'weather-extremes-hourly' must
-- pass p_decimate = 1 (it calls compute_weather_extremes(30, 1)). At the
-- old default of 3 it would decimate an ALREADY-decimated archive to
-- 9-hourly, thinning the per-cell sample toward the n_t >= 24 guard and
-- dropping cells out of percentile scoring with nothing erroring.
-- Change the retention and that argument together.
--
-- Payload slimming was MEASURED AND REJECTED: every cell repeats an
-- identical current_units object, 37% of the raw JSON, but stripping it
-- moves the STORED row only 163 kB -> 148 kB (9%) because pglz already
-- compresses the repetition; even a minimal lat/lon/current payload is
-- 141 kB. Row count is the only lever that pays.
--
-- Called opportunistically from the refresh endpoint after each insert.
CREATE OR REPLACE FUNCTION public.trim_weather_grid_cache()
RETURNS void AS $$
    WITH anchor AS (SELECT max(fetched_at) AS newest FROM public.weather_grid_cache)
    DELETE FROM public.weather_grid_cache w
    USING anchor a
    WHERE w.fetched_at < a.newest - interval '30 days'
       OR NOT (
             w.fetched_at > a.newest - interval '72 hours'
          OR extract(hour FROM date_trunc('hour', w.fetched_at))::int % 3 = 0
       );
$$ LANGUAGE sql
SET search_path = public, pg_temp;
