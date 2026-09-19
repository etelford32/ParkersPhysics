-- ═══════════════════════════════════════════════════════════════
-- STORAGE RECLAIM — applied 2026-09-19 to project aijsboodkivnhzfstvdq
--
-- CONTEXT: the site was returning HTTP 402 at the Supabase edge gateway
-- on every Data API and Auth request from 2026-09-18 22:00 UTC. The
-- gateway rejects before PostgREST, which is why postgrest_logs and
-- auth_logs went silent while edge_logs kept flowing. pg_cron, which
-- runs inside the database, never stopped — so "the pipelines died" was
-- a red herring: every heartbeat those pipelines write is itself a
-- Supabase call, so they all went dark together.
--
-- The database measured 235 MB at the time. WAL was another 128 MB.
-- This migration reclaims 119 MB of it (235 -> 116 MB).
--
-- NOTE ON WHAT THIS DOES *NOT* ESTABLISH: 235 MB is under the free
-- tier's 500 MB database limit, so the 402 was never proven to be a
-- database-size breach — egress could not be measured from the logs
-- (the content_length attribute is not populated). If the project is
-- still 402ing after this, the quota that tripped is NOT space and the
-- next place to look is Org -> Usage, egress line.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. weather_grid_cache: 137 MB -> 49 MB ────────────────────
-- Deletes the frames nothing reads. See the header on
-- trim_weather_grid_cache() in supabase-weather-cache-migration.sql
-- for the full rationale, the lockstep rule, and the measured
-- rejection of payload slimming. Run the trim function itself rather
-- than duplicating the predicate — one copy of the policy.

SELECT public.trim_weather_grid_cache();

-- ── 2. The extremes job must stop decimating a decimated archive ──
-- LOAD-BEARING: at the old default (p_decimate = 3) this would sample
-- the 3-hourly tail at 9-hourly and quietly thin the percentile sample.
-- Guarded so a fresh environment without the job does not fail here.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weather-extremes-hourly') THEN
        PERFORM cron.alter_job(
            (SELECT jobid FROM cron.job WHERE jobname = 'weather-extremes-hourly'),
            command => 'select public.compute_weather_extremes(30, 1)');
    END IF;
END $$;

-- ── 3. cron.job_run_details: 18 MB -> 88 kB ───────────────────
-- pg_cron NEVER prunes its own run history. 98,866 rows had accumulated
-- since 2026-04-19. The table that records the six pruning jobs was the
-- only unpruned one on the instance.

DELETE FROM cron.job_run_details WHERE start_time < now() - interval '7 days';

SELECT cron.schedule('prune-cron-run-details', '17 * * * *',
    $job$DELETE FROM cron.job_run_details WHERE start_time < now() - interval '7 days'$job$);

-- ── 4. Exact-duplicate indexes ────────────────────────────────
-- Each of these had a byte-identical twin (same column, same opclass)
-- that stays. Dropping one of a duplicate pair cannot change a plan:
-- the survivor serves every query the dropped one would. The twin kept
-- is in each case the one with the higher idx_scan count.

DROP INDEX IF EXISTS public.idx_analytics_user;      -- twin: idx_analytics_events_user
DROP INDEX IF EXISTS public.idx_analytics_created;   -- twin: idx_analytics_events_created
DROP INDEX IF EXISTS public.idx_analytics_session;   -- twin: idx_analytics_events_session
DROP INDEX IF EXISTS public.idx_sessions_session_id; -- twin: user_sessions_session_id_key (UNIQUE)

-- ── 5. Reclaim bloat to the OS ────────────────────────────────
-- DELETE only marks tuples dead; VACUUM FULL is what returns pages.
-- Measured overhead before: weather_grid_cache 16%, sw_geomag_dataset
-- 27.8% (the latter from the 18x re-upsert documented below).
--
-- ORDER MATTERS: delete FIRST, then VACUUM FULL. VACUUM FULL rewrites
-- the table and needs scratch space equal to the LIVE data — running it
-- before the deletes would have needed 137 MB free on a disk that was
-- the thing we were short of.
--
-- Run these OUTSIDE a transaction block, one statement per call
-- ("VACUUM cannot run inside a transaction block").
--
--   VACUUM (FULL, ANALYZE) public.weather_grid_cache;
--   VACUUM (FULL, ANALYZE) public.sw_geomag_dataset;
--   VACUUM (FULL, ANALYZE) public.client_telemetry;
--   VACUUM (FULL, ANALYZE) public.analytics_events;
--   VACUUM (FULL, ANALYZE) public.geomag_indices;
--   VACUUM (FULL, ANALYZE) public.solar_wind_samples;
--   VACUUM (FULL, ANALYZE) public.omni_hourly;
--   VACUUM (FULL, ANALYZE) cron.job_run_details;
--
-- VACUUM FULL generates WAL for everything it rewrites (128 -> 176 MB
-- here). That is transient and recycles on the next checkpoint; the
-- dashboard role has no pg_checkpoint grant, so it cannot be forced.

-- ── STILL OUTSTANDING (not fixed here) ────────────────────────
-- sw_geomag_dataset carries a WRITE-AMPLIFICATION bug that is the real
-- WAL driver: api/cron/sync-dataset.js runs every 10 min over a 180-min
-- window (WINDOW_MIN = 180), so every minute-row is re-upserted ~18x.
-- Measured n_tup_upd / n_live_tup = 1,714,781 / 98,179 = 17.5. That
-- needs a code change + deploy, so it is not in this SQL migration.
--
-- Same table: KEEP_DAYS = 180 but only 68 days had accumulated. At
-- 1-minute cadence the steady state is ~259k rows / ~98 MB — on its own
-- enough to breach the tier again. Decide a real retention before it
-- gets there.
