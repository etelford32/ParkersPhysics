-- ═══════════════════════════════════════════════════════════════
-- supabase-compute-offload-migration.sql
-- SUPABASE_OFFLOAD_PLAN.md Phase A1 + Phase D (in-database half).
-- Written 2026-11-03; applied to aijsboodkivnhzfstvdq on the author's go
-- (see the APPLY LOG at the bottom for the measured before/after).
--
-- Three independent changes, each reversible (down-migration at the end):
--
--   1. compute_weather_extremes() stops re-scanning 30 days every hour.
--      The per-cell percentile pass moves to compute_weather_cell_stats(),
--      run ONCE A DAY into public.weather_cell_stats (2 592 rows). The
--      hourly job now parses ONLY the newest frame and joins it to those
--      stats. Measured before: 36.3 s avg / 45.5 s max per run, >90 % of
--      all scheduled in-DB CPU (~14.5 core-min/day).
--
--   2. record_pipeline_success() writes at most every 150 s per pipeline
--      while healthy. Only solar_wind calls it faster than that (every
--      minute); it was 1 440 UPDATEs/day on one hot row.
--
--   3. The ten hourly prune-* pg_cron jobs become ONE job calling
--      prune_housekeeping(), with a lock timeout per statement.
--
-- Output contracts are unchanged: weather_extremes_cache keeps the same
-- columns and payload keys (plus one ADDITIVE key, stats_computed_at),
-- /api/weather/extremes and the Storm Watch panel need no change, and
-- pipeline_heartbeat keeps its columns.
-- ═══════════════════════════════════════════════════════════════


-- ── 1a. The daily statistics table ─────────────────────────────
-- RLS enabled with ZERO policies: service-role-only, the same intentional
-- pattern as weather_grid_cache / weather_extremes_cache (CLAUDE.md §4.2 —
-- the advisor's rls_enabled_no_policy flag on it is expected).

create table if not exists public.weather_cell_stats (
    lat            numeric     not null,
    lon            numeric     not null,
    n_t            bigint      not null,
    t_mean         double precision,
    t_p01          double precision,
    t_p05          double precision,
    t_p95          double precision,
    t_p99          double precision,
    t_min          real,
    t_max          real,
    w_p95          double precision,
    w_p99          double precision,
    w_max          real,
    pr_p95         double precision,
    pr_p99         double precision,
    pr_max         real,
    window_days    int         not null,
    decimate       int         not null,
    frames_sampled int         not null,
    history_end    timestamptz not null,   -- the newest frame the stats EXCLUDE
    computed_at    timestamptz not null default now(),
    primary key (lat, lon)
);

alter table public.weather_cell_stats enable row level security;
revoke all on public.weather_cell_stats from anon, authenticated;


-- ── 1b. The daily pass (the OLD hourly body's stats CTE, verbatim) ──
-- LOAD-BEARING (supabase-storage-reclaim-migration.sql §2): call it with
-- p_decimate = 1. The archive is already decimated (hourly for 72 h,
-- 3-hourly older); decimating again thins the 3-hourly tail to 9-hourly.
--
-- History EXCLUDES the newest frame at the time of the run, exactly as the
-- old hourly function did, so "exceeds window max" is still a record
-- against history the current frame is not part of.

create or replace function public.compute_weather_cell_stats(
    p_window_days int default 30,
    p_decimate    int default 1
) returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_latest  timestamptz;
    v_frames  int;
    v_cells   int;
begin
    select max(fetched_at) into v_latest from weather_grid_cache;
    if v_latest is null then
        return 0;
    end if;

    -- Counting the sampled frames reads no TOAST (no payload), so it is
    -- cheap to do separately from the parse below.
    select count(*) into v_frames
    from (
        select row_number() over (order by fetched_at desc) as rn
        from weather_grid_cache
        where fetched_at > now() - make_interval(days => p_window_days)
          and fetched_at < v_latest
    ) h
    where rn % p_decimate = 0;

    delete from weather_cell_stats;

    insert into weather_cell_stats
        (lat, lon, n_t, t_mean, t_p01, t_p05, t_p95, t_p99, t_min, t_max,
         w_p95, w_p99, w_max, pr_p95, pr_p99, pr_max,
         window_days, decimate, frames_sampled, history_end)
    select lat, lon,
           count(t),
           avg(t),
           percentile_cont(0.01) within group (order by t),
           percentile_cont(0.05) within group (order by t),
           percentile_cont(0.95) within group (order by t),
           percentile_cont(0.99) within group (order by t),
           min(t), max(t),
           percentile_cont(0.95) within group (order by wind),
           percentile_cont(0.99) within group (order by wind),
           max(wind),
           percentile_cont(0.95) within group (order by precip),
           percentile_cont(0.99) within group (order by precip),
           max(precip),
           p_window_days, p_decimate, v_frames, v_latest
    from (
        -- Key cells by (lat, lon), NOT array position (see the original
        -- migration: the two writers' ordering is an implementation detail).
        select round((c->>'latitude')::numeric,  2) as lat,
               round((c->>'longitude')::numeric, 2) as lon,
               (c->'current'->>'temperature_2m')::real as t,
               (c->'current'->>'wind_speed_10m')::real as wind,
               (c->'current'->>'precipitation')::real  as precip
        from (
            select payload
            from (
                select payload,
                       row_number() over (order by fetched_at desc) as rn
                from weather_grid_cache
                where fetched_at > now() - make_interval(days => p_window_days)
                  and fetched_at < v_latest
            ) h
            where rn % p_decimate = 0
        ) s, jsonb_array_elements(s.payload) as c
    ) hist_cells
    group by lat, lon;

    get diagnostics v_cells = row_count;
    return v_cells;
end;
$$;

revoke execute on function public.compute_weather_cell_stats(int, int)
    from public, anon, authenticated;


-- ── 1c. The hourly job: newest frame × stored stats ─────────────
-- Same signature, same pg_cron command ('select public.compute_weather_
-- extremes(30, 1)'), same output row. The flag/rank/summary SQL below is
-- the old function's, unchanged — only `stats` now reads the table.
--
-- SELF-HEALING: if the stats are missing, older than 26 h (the daily job
-- did not run), or were built for a different window/decimation, the
-- stats pass runs inline first — so a dead daily job degrades to the old
-- cost, never to a stale or empty answer.
--
-- WHAT CHANGED SEMANTICALLY (disclosed, not hidden): the history window
-- now ends at the stats run (≤ 24 h before the frame being judged) instead
-- of one hour before it. Hours between the daily run and "now" are not in
-- the baseline. Over a 30-day window that moves a percentile by at most
-- 1/30 of its sample; the payload carries stats_computed_at so it can be
-- shown.

-- Defaults kept as originally declared (30, 3) — CREATE OR REPLACE may
-- not change them, and pg_cron passes (30, 1) explicitly anyway.
create or replace function public.compute_weather_extremes(
    p_window_days int default 30,
    p_decimate    int default 3
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_latest       timestamptz;
    v_stats_at     timestamptz;
    v_stats_window int;
    v_stats_dec    int;
    v_frames       int;
begin
    select max(fetched_at) into v_latest from weather_grid_cache;
    if v_latest is null then
        return;
    end if;

    select max(computed_at), max(window_days), max(decimate), max(frames_sampled)
      into v_stats_at, v_stats_window, v_stats_dec, v_frames
      from weather_cell_stats;

    if v_stats_at is null
       or v_stats_at < now() - interval '26 hours'
       or v_stats_window is distinct from p_window_days
       or v_stats_dec    is distinct from p_decimate then
        perform compute_weather_cell_stats(p_window_days, p_decimate);
        select max(computed_at), max(frames_sampled)
          into v_stats_at, v_frames
          from weather_cell_stats;
    end if;

    with cur as (
        select round((c->>'latitude')::numeric,  2) as lat,
               round((c->>'longitude')::numeric, 2) as lon,
               (c->'current'->>'temperature_2m')::real as t,
               (c->'current'->>'wind_speed_10m')::real as wind,
               (c->'current'->>'precipitation')::real  as precip
        from weather_grid_cache w, jsonb_array_elements(w.payload) as c
        where w.fetched_at = v_latest
    ),
    joined as (
        select cur.lat, cur.lon, cur.t, cur.wind, cur.precip,
               s.n_t, s.t_mean, s.t_p01, s.t_p05, s.t_p95, s.t_p99,
               s.t_min, s.t_max, s.w_p95, s.w_p99, s.w_max,
               s.pr_p95, s.pr_p99, s.pr_max
        from cur
        join weather_cell_stats s using (lat, lon)
        where s.n_t >= 24
    ),
    heat as (
        select coalesce(jsonb_agg(jsonb_build_object(
                   'lat', lat, 'lon', lon,
                   'value', round(t::numeric, 1),
                   'p95',   round(t_p95::numeric, 1),
                   'p99',   round(t_p99::numeric, 1),
                   'wmax',  round(t_max::numeric, 1),
                   'mean',  round(t_mean::numeric, 1),
                   'sev',   case when t > t_max then 3
                                 when t >= t_p99 then 2 else 1 end
               ) order by (t - t_p95) desc), '[]'::jsonb) as j
        from (
            select * from joined
            where t is not null and t >= t_p95 and t >= 25
            order by (t - t_p95) desc limit 20
        ) q
    ),
    cold as (
        select coalesce(jsonb_agg(jsonb_build_object(
                   'lat', lat, 'lon', lon,
                   'value', round(t::numeric, 1),
                   'p05',   round(t_p05::numeric, 1),
                   'p01',   round(t_p01::numeric, 1),
                   'wmin',  round(t_min::numeric, 1),
                   'mean',  round(t_mean::numeric, 1),
                   'sev',   case when t < t_min then 3
                                 when t <= t_p01 then 2 else 1 end
               ) order by (t_p05 - t) desc), '[]'::jsonb) as j
        from (
            select * from joined
            where t is not null and t <= t_p05 and t <= 0
            order by (t_p05 - t) desc limit 20
        ) q
    ),
    wind_x as (
        select coalesce(jsonb_agg(jsonb_build_object(
                   'lat', lat, 'lon', lon,
                   'value', round(wind::numeric, 1),
                   'p95',   round(w_p95::numeric, 1),
                   'p99',   round(w_p99::numeric, 1),
                   'wmax',  round(w_max::numeric, 1),
                   'sev',   case when wind > w_max then 3
                                 when wind >= w_p99 then 2 else 1 end
               ) order by (wind - w_p95) desc), '[]'::jsonb) as j
        from (
            select * from joined
            where wind is not null and wind >= w_p95 and wind >= 15
            order by (wind - w_p95) desc limit 20
        ) q
    ),
    precip_x as (
        select coalesce(jsonb_agg(jsonb_build_object(
                   'lat', lat, 'lon', lon,
                   'value', round(precip::numeric, 2),
                   'p95',   round(pr_p95::numeric, 2),
                   'p99',   round(pr_p99::numeric, 2),
                   'wmax',  round(pr_max::numeric, 2),
                   'sev',   case when precip > pr_max then 3
                                 when precip >= pr_p99 then 2 else 1 end
               ) order by (precip - pr_p95) desc), '[]'::jsonb) as j
        from (
            select * from joined
            where precip is not null and precip >= pr_p95 and precip >= 2
            order by (precip - pr_p95) desc limit 20
        ) q
    ),
    summary as (
        select jsonb_build_object(
            'cells',          count(*),
            'heat_p95_cells', count(*) filter (where t    >= t_p95  and t >= 25),
            'cold_p05_cells', count(*) filter (where t    <= t_p05  and t <= 0),
            'wind_p95_cells', count(*) filter (where wind >= w_p95  and wind >= 15),
            'precip_p95_cells', count(*) filter (where precip >= pr_p95 and precip >= 2),
            'record_cells',   count(*) filter (where t > t_max or t < t_min
                                               or wind > w_max or precip > pr_max)
        ) as j
        from joined
    )
    insert into weather_extremes_cache
        (frame_time, window_days, frames_sampled, payload)
    select v_latest,
           p_window_days,
           coalesce(v_frames, 0),
           jsonb_build_object(
               'heat',    (select j from heat),
               'cold',    (select j from cold),
               'wind',    (select j from wind_x),
               'precip',  (select j from precip_x),
               'summary', (select j from summary),
               'units',   jsonb_build_object(
                   't', '°C', 'wind', 'm/s', 'precip', 'mm'),
               'stats_computed_at', v_stats_at
           );

    delete from weather_extremes_cache
    where id not in (
        select id from weather_extremes_cache
        order by computed_at desc limit 48
    );
end;
$$;

revoke execute on function public.compute_weather_extremes(int, int)
    from public, anon, authenticated;

-- Daily stats at 03:10 UTC, ten minutes before that hour's :20 extremes
-- run, so the 03:20 run reads fresh stats instead of self-healing.
select cron.schedule(
    'weather-cell-stats-daily',
    '10 3 * * *',
    $$select public.compute_weather_cell_stats(30, 1)$$
);


-- ── 2. Heartbeat: write while something CHANGED or ≥150 s passed ──
-- The conflict WHERE skips the UPDATE (no new tuple, no WAL) only when the
-- row is already healthy, from the same source, and fresh. A success after
-- any failure ALWAYS writes (consecutive_fail > 0), which keeps the
-- failure-then-success ordering in api/cron/refresh-weather-grid.js
-- intact. 150 s with a 1-min solar-wind cron means a write every 3rd
-- minute: last_success_at is at most ~3 min old, under solar_wind's
-- warnMin 5 (js/pipeline-registry.js HEARTBEAT_PIPELINES) and far under
-- the stall detector's 10-min threshold. Every other pipeline calls this
-- at ≥10-min intervals and is unaffected. If you lower a warnMin below
-- 4 min, lower this interval with it.

create or replace function public.record_pipeline_success(
    p_name   text,
    p_source text default null
) returns void
language sql
security definer
set search_path = public, extensions, pg_temp
as $$
    insert into public.pipeline_heartbeat as h
        (pipeline_name, last_success_at, last_source, consecutive_fail, updated_at)
    values
        (p_name, now(), p_source, 0, now())
    on conflict (pipeline_name) do update set
        last_success_at  = now(),
        last_source      = coalesce(excluded.last_source, h.last_source),
        consecutive_fail = 0,
        updated_at       = now()
    where h.consecutive_fail <> 0
       or h.last_success_at is null
       or h.last_success_at < now() - interval '150 seconds'
       or (excluded.last_source is not null
           and excluded.last_source is distinct from h.last_source);
$$;

revoke all on function public.record_pipeline_success(text, text) from public;
revoke all on function public.record_pipeline_success(text, text) from anon, authenticated;


-- ── 3. One housekeeping job instead of ten ─────────────────────
-- Same predicates and retentions as the ten jobs it replaces, except the
-- old prune-client-telemetry-errors (kind IN error/auth_failure/not_found/
-- redirect, 30 d), which was a strict subset of prune-client-telemetry-all
-- (every kind, 30 d) and deleted nothing the other did not.
-- Each delete runs in its own sub-block with lock_timeout 5 s: one table
-- that is busy (prune-auth-failures once waited 43.7 s) is skipped and
-- retried next hour instead of stalling or aborting the rest.

create or replace function public.prune_housekeeping()
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_out   jsonb := '{}'::jsonb;
    v_n     bigint;
    r       record;
begin
    perform set_config('lock_timeout', '5s', true);

    for r in
        select * from (values
            ('analytics_events',
             $q$delete from public.analytics_events   where created_at < now() - interval '180 days'$q$),
            ('alert_history',
             $q$delete from public.alert_history      where created_at < now() - interval '90 days'$q$),
            ('client_telemetry_vitals',
             $q$delete from public.client_telemetry   where kind in ('web_vital','app_perf') and created_at < now() - interval '14 days'$q$),
            ('client_telemetry_all',
             $q$delete from public.client_telemetry   where created_at < now() - interval '30 days'$q$),
            ('user_sessions',
             $q$delete from public.user_sessions      where started_at < now() - interval '30 days'$q$),
            ('user_profiles_audit',
             $q$delete from public.user_profiles_audit where created_at < now() - interval '30 days'$q$),
            ('auth_failures',
             $q$delete from public.auth_failures      where created_at < now() - interval '30 days'$q$),
            ('activation_events',
             $q$delete from public.activation_events  where created_at < now() - interval '180 days'$q$),
            ('cron_job_run_details',
             $q$delete from cron.job_run_details      where start_time < now() - interval '7 days'$q$)
        ) as t(name, sql)
    loop
        begin
            execute r.sql;
            get diagnostics v_n = row_count;
            v_out := v_out || jsonb_build_object(r.name, v_n);
        exception when others then
            v_out := v_out || jsonb_build_object(r.name, 'skipped: ' || sqlstate);
        end;
    end loop;

    return v_out;
end;
$$;

revoke execute on function public.prune_housekeeping() from public, anon, authenticated;

do $$
declare j text;
begin
    foreach j in array array[
        'prune-analytics-events', 'prune-alert-history',
        'prune-client-telemetry-vitals', 'prune-client-telemetry-errors',
        'prune-client-telemetry-all', 'prune-user-sessions',
        'prune-user-profiles-audit', 'prune-auth-failures',
        'prune-activation-events', 'prune-cron-run-details']
    loop
        if exists (select 1 from cron.job where jobname = j) then
            perform cron.unschedule(j);
        end if;
    end loop;
end $$;

select cron.schedule('prune-housekeeping', '37 * * * *',
    $$select public.prune_housekeeping()$$);


-- ── DOWN-MIGRATION ─────────────────────────────────────────────
-- 1. Restore the single-pass hourly body from
--    supabase-weather-extremes-migration.sql (it is unchanged there), then:
--      select cron.unschedule('weather-cell-stats-daily');
--      drop function if exists public.compute_weather_cell_stats(int, int);
--      drop table    if exists public.weather_cell_stats;
-- 2. Re-run record_pipeline_success from
--    supabase/migrations/20200101000000_baseline.sql (no WHERE clause).
-- 3. select cron.unschedule('prune-housekeeping');
--    then re-schedule the ten prune-* jobs from
--    supabase-retention-cron-migration.sql, supabase-retention-30d-
--    migration.sql, supabase-client-telemetry-migration.sql and
--    supabase-storage-reclaim-migration.sql §3.


-- ── APPLY LOG (2026-11-03/04, project aijsboodkivnhzfstvdq) ────
-- Applied in three MCP migrations, in this file's order:
--   compute_offload_weather_cell_stats          (§1a + §1b)
--   compute_offload_weather_extremes_hourly     (§1c + the daily schedule)
--   compute_offload_heartbeat_and_housekeeping  (§2 + §3 function)
--   compute_offload_one_prune_job               (§3 cron swap)
--
-- A/B GATE, §1: the old single-pass stats CTE was run inline against
-- weather_cell_stats on the same frame (23:01 UTC, 285 history frames):
-- 2 592 / 2 592 cells IDENTICAL on all 14 statistics (exact equality, not
-- a tolerance). The flag/rank/summary SQL is copied unchanged, so equal
-- stats give an equal payload.
--
-- COST, §1 (measured):
--   old hourly run    31.4 s mean over 31 calls (pg_stat_statements),
--                     36.3 s avg / 45.5 s max over 7 days (cron history)
--   new hourly run    0.043 s
--   daily stats pass  ~35 s, once a day
--   => ~14.5 core-min/day -> ~0.6 core-min/day
--
-- §3: prune_housekeeping() ran once by hand before the swap: all nine
-- deletes executed, none skipped, 0.17 s. pg_cron now holds four jobs:
-- omni_hourly_refresh, prune-housekeeping, weather-cell-stats-daily,
-- weather-extremes-hourly.
