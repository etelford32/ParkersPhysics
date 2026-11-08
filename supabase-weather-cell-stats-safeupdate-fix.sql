-- ═══════════════════════════════════════════════════════════════
-- supabase-weather-cell-stats-safeupdate-fix.sql
-- Fixes replace_weather_cell_stats() (supabase-r2-offload-migration.sql §2)
-- under Supabase's pg_safeupdate. Written 2026-11-08. NOT APPLIED — apply on
-- the author's go.
--
-- THE FAILURE (heartbeat 'weather_cell_stats', 2026-11-08 03:05 UTC):
--   rpc replace_weather_cell_stats 400: {"code":"21000",
--     "message":"DELETE requires a WHERE clause"}
--
-- WHY: the `authenticator` role (every PostgREST request, including the
-- service-role RPC that api/cron/weather-cell-stats.js makes) carries
-- `session_preload_libraries=safeupdate`, which rejects an UPDATE/DELETE
-- with no WHERE clause at parse time, whatever the row count. pg_cron runs as
-- `postgres` without it, which is why compute_weather_cell_stats() — the same
-- bare `delete from weather_cell_stats` — has never failed.
--
-- WHY ONLY NOW: 2026-11-04 → 11-07 the cron took its COVERAGE-GATE path
-- (heartbeat source on 11-07: `skipped:coverage 259/260`), which records a
-- success without calling the RPC. 2026-11-08 was the first run whose archive
-- covered the window, i.e. the FIRST time the RPC ever executed. No harm was
-- done: the RPC failed before writing, and the 03:10 pg_cron fallback rebuilt
-- the stats from Postgres (2592 cells, stats_source 'postgres').
--
-- THE FIX: qualify the delete on the primary key. `lat` is NOT NULL (PK), so
-- `where lat is not null` deletes every row — same semantics as before, still
-- inside the one transaction compute_weather_extremes() relies on. TRUNCATE
-- was rejected: it takes ACCESS EXCLUSIVE (blocks the hourly reader against
-- authenticator's 8 s lock_timeout) and needs the TRUNCATE privilege on top of
-- what this INVOKER function already uses. Signature, search_path and grants
-- are unchanged. Everything else in the body is verbatim.
-- ═══════════════════════════════════════════════════════════════

create or replace function public.replace_weather_cell_stats(
    p_rows           jsonb,
    p_window_days    int,
    p_decimate       int,
    p_frames         int,
    p_history_end    timestamptz
) returns int
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_n int;
begin
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
        raise exception 'replace_weather_cell_stats: empty row set refused';
    end if;

    -- Qualified for pg_safeupdate (PostgREST sessions). lat is the PK's
    -- leading NOT NULL column, so this is every row.
    delete from weather_cell_stats where lat is not null;

    insert into weather_cell_stats
        (lat, lon, n_t, t_mean, t_p01, t_p05, t_p95, t_p99, t_min, t_max,
         w_p95, w_p99, w_max, pr_p95, pr_p99, pr_max,
         window_days, decimate, frames_sampled, history_end, stats_source)
    select r.lat, r.lon, r.n_t, r.t_mean, r.t_p01, r.t_p05, r.t_p95, r.t_p99,
           r.t_min, r.t_max, r.w_p95, r.w_p99, r.w_max, r.pr_p95, r.pr_p99, r.pr_max,
           p_window_days, p_decimate, p_frames, p_history_end, 'r2'
    from jsonb_to_recordset(p_rows) as r(
        lat numeric, lon numeric, n_t bigint, t_mean double precision,
        t_p01 double precision, t_p05 double precision, t_p95 double precision,
        t_p99 double precision, t_min real, t_max real,
        w_p95 double precision, w_p99 double precision, w_max real,
        pr_p95 double precision, pr_p99 double precision, pr_max real);

    get diagnostics v_n = row_count;
    return v_n;
end;
$$;
revoke execute on function public.replace_weather_cell_stats(jsonb, int, int, int, timestamptz)
    from public, anon, authenticated;

-- Verify after applying (no write):
--   select prosrc ~ 'where lat is not null' from pg_proc
--    where proname = 'replace_weather_cell_stats';
-- Then trigger the cron once with ?dry=0 (or wait for 03:05 UTC) and expect
-- heartbeat source `r2 N frames · 2592 cells` and stats_source = 'r2'.
