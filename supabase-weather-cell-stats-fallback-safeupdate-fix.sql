-- ═══════════════════════════════════════════════════════════════
-- supabase-weather-cell-stats-fallback-safeupdate-fix.sql
-- Companion to supabase-weather-cell-stats-safeupdate-fix.sql. Written
-- 2026-11-08. NOT APPLIED — apply on the author's go.
--
-- Qualifies the full-table delete in compute_weather_cell_stats() (the SQL
-- fallback pass, last defined in supabase-r2-offload-migration.sql §3) for
-- pg_safeupdate. Today it only runs from pg_cron ('weather-cell-stats-daily',
-- as postgres, no safeupdate) and from compute_weather_extremes()'s inline
-- self-heal (also pg_cron), so it has never failed — but the bare delete is
-- the same statement that broke replace_weather_cell_stats() on 2026-11-08,
-- and any call that reaches it through PostgREST would fail the same way.
--
-- One line changes: `delete from weather_cell_stats where lat is not null`
-- (lat is NOT NULL, part of the PK ⇒ every row). Signature, defaults,
-- search_path, INVOKER security, the -1/-2 guards and the revoke are verbatim
-- from the production definition (checked with pg_get_functiondef on
-- 2026-11-08 against supabase-r2-offload-migration.sql §3).
-- ═══════════════════════════════════════════════════════════════

create or replace function public.compute_weather_cell_stats(
    p_window_days int default 30,
    p_decimate    int default 1
) returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_latest  timestamptz;
    v_oldest  timestamptz;
    v_frames  int;
    v_cells   int;
begin
    if exists (select 1 from weather_cell_stats
               where stats_source = 'r2' and computed_at > now() - interval '20 hours') then
        return -1;
    end if;

    select max(fetched_at) into v_latest from weather_grid_cache;
    if v_latest is null then
        return 0;
    end if;

    select min(fetched_at) into v_oldest
    from weather_grid_cache
    where fetched_at > now() - make_interval(days => p_window_days);
    if v_oldest is null
       or v_oldest > v_latest - make_interval(days => greatest(1, p_window_days - 2)) then
        return -2;
    end if;

    select count(*) into v_frames
    from (
        select row_number() over (order by fetched_at desc) as rn
        from weather_grid_cache
        where fetched_at > now() - make_interval(days => p_window_days)
          and fetched_at < v_latest
    ) h
    where rn % p_decimate = 0;

    -- Qualified for pg_safeupdate, which every PostgREST (authenticator)
    -- session preloads. pg_cron runs this as postgres without it, so the bare
    -- delete worked there — but compute_weather_extremes() calls this inline
    -- to self-heal, and any PostgREST path into either would hit 21000.
    -- lat is the PK's leading NOT NULL column, so this is every row.
    delete from weather_cell_stats where lat is not null;

    insert into weather_cell_stats
        (lat, lon, n_t, t_mean, t_p01, t_p05, t_p95, t_p99, t_min, t_max,
         w_p95, w_p99, w_max, pr_p95, pr_p99, pr_max,
         window_days, decimate, frames_sampled, history_end, stats_source)
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
           p_window_days, p_decimate, v_frames, v_latest, 'postgres'
    from (
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

-- Verify after applying (no write):
--   select prosrc ~ 'where lat is not null' from pg_proc
--    where proname = 'compute_weather_cell_stats';
