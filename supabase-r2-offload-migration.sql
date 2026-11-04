-- ═══════════════════════════════════════════════════════════════
-- supabase-r2-offload-migration.sql
-- SUPABASE_OFFLOAD_PLAN.md Phases B (weather frames → R2), C (sealed
-- sw_geomag_dataset days → R2) and A2 (the daily percentile pass out of
-- Postgres). Written 2026-11-04.
--
-- SAFE TO APPLY BEFORE THE CODE IS DEPLOYED AND BEFORE THE R2 SECRETS EXIST.
-- Every delete below is gated on an INDEX row that only
-- api/cron/archive-sweep.js writes, and it writes one only AFTER the R2 PUT
-- succeeded. No index rows ⇒ the trims behave exactly as before. That is
-- also the failure posture forever after: if R2 goes away, Postgres simply
-- stops shrinking.
--
-- Three switches, each gated on a measurable condition, none on a date:
--   1. A weather frame older than 24 h is deleted only when it is indexed
--      AND the R2 stats pass has succeeded within 30 h (otherwise Postgres
--      must keep 30 days because the SQL pass is still the stats source).
--   2. compute_weather_cell_stats() (the pg_cron 03:10 job) skips while the
--      R2 pass is fresh, and REFUSES — leaving the last good stats in place —
--      once Postgres no longer holds the window, instead of computing
--      percentiles over one day and calling them 30-day percentiles.
--   3. A sw_geomag_dataset UTC day older than 14 days is deleted only when
--      it is sealed (indexed). The 180-day ceiling is kept as it was.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Index tables (service-role-only: RLS on, zero policies — the
--       CLAUDE.md §4.2 pattern; the advisor INFO flag is expected) ───────

create table if not exists public.weather_grid_archive (
    fetched_at    timestamptz primary key,   -- the weather_grid_cache row it copies
    source        text,
    pressure_kind text,
    r2_key        text        not null unique,
    bytes         int         not null,
    sha256        text        not null,
    archived_at   timestamptz not null default now()
);
alter table public.weather_grid_archive enable row level security;
revoke all on public.weather_grid_archive from anon, authenticated;

create table if not exists public.sw_geomag_archive (
    day        date        primary key,      -- UTC day
    r2_key     text        not null unique,
    rows       int         not null,
    first_t    timestamptz,
    last_t     timestamptz,
    bytes      int         not null,
    sha256     text        not null,
    sealed_at  timestamptz not null default now()
);
alter table public.sw_geomag_archive enable row level security;
revoke all on public.sw_geomag_archive from anon, authenticated;


-- ── 2. Where the stats came from ─────────────────────────────────

alter table public.weather_cell_stats
    add column if not exists stats_source text not null default 'postgres';

-- Atomic replace, called ONLY by api/cron/weather-cell-stats.js with the
-- R2-computed rows. One transaction: compute_weather_extremes() never sees
-- a half-written table.
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

    delete from weather_cell_stats;

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


-- ── 3. The SQL stats pass becomes the FALLBACK ────────────────────
-- Returns: number of cells written, -1 = skipped (the R2 pass is fresh),
-- -2 = refused (Postgres no longer holds the window; the last good stats
-- stay in place and compute_weather_extremes() keeps using them — its
-- payload carries stats_computed_at so the age is visible).

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

    delete from weather_cell_stats;

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


-- ── 4. Weather trim: the old retention, PLUS archived frames > 24 h ──
-- The old predicate is unchanged (it is still what keeps the table bounded
-- when R2 is not in play). The new arm needs BOTH an index row (the frame
-- is in R2) AND a fresh R2 stats run (nothing in Postgres still needs the
-- 30-day history). 24 h stays local: the newest frame for /api/weather/grid
-- and compute_weather_extremes(), plus a day of range reads that survive an
-- R2 outage.

create or replace function public.trim_weather_grid_cache()
returns void
language sql
set search_path = public, pg_temp
as $$
    with anchor as (select max(fetched_at) as newest from public.weather_grid_cache),
    r2_ready as (
        select exists (select 1 from public.weather_cell_stats
                       where stats_source = 'r2'
                         and computed_at > now() - interval '30 hours') as ok
    )
    delete from public.weather_grid_cache w
    using anchor a, r2_ready r
    where w.fetched_at < a.newest - interval '30 days'
       or not (
             w.fetched_at > a.newest - interval '72 hours'
          or extract(hour from date_trunc('hour', w.fetched_at))::int % 3 = 0
       )
       or (    r.ok
           and w.fetched_at < a.newest - interval '24 hours'
           and exists (select 1 from public.weather_grid_archive x
                       where x.fetched_at = w.fetched_at));
$$;
-- Only the service-role cron calls it. (It was anon-executable; harmless —
-- invoker rights + RLS — but not part of the telemetry surface.)
revoke execute on function public.trim_weather_grid_cache() from public, anon, authenticated;


-- ── 5. sw_geomag_dataset trim: + sealed days older than 14 d ─────
-- Whole UTC days only (a day is all-in-Postgres or all-in-R2, which is what
-- lets the readers decide per day). 14 d covers the validation ledger's
-- recent truth windows without an R2 read; older windows come from the
-- sealed files through api/_lib/sw-geomag-store.js.

create or replace function public.trim_sw_geomag_dataset(p_keep_days int default 180)
returns bigint
language sql
security definer
set search_path = public, pg_temp
as $$
    with gone as (
        delete from public.sw_geomag_dataset d
        where d.t < now() - make_interval(days => greatest(7, p_keep_days))
           or (    d.t < date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - interval '14 days'
               and exists (select 1 from public.sw_geomag_archive s
                           where s.day = (d.t at time zone 'UTC')::date))
        returning 1
    )
    select count(*) from gone;
$$;
revoke execute on function public.trim_sw_geomag_dataset(int) from public, anon, authenticated;


-- ── DOWN-MIGRATION ─────────────────────────────────────────────
-- Restore trim_weather_grid_cache() from supabase-weather-cache-migration.sql,
-- trim_sw_geomag_dataset() from supabase-sync-dataset-migration.sql and
-- compute_weather_cell_stats() from supabase-compute-offload-migration.sql,
-- then: drop function public.replace_weather_cell_stats(jsonb,int,int,int,timestamptz);
-- The index tables and the R2 objects can stay: nothing reads them once the
-- routes are reverted. Frames / days already trimmed live ONLY in R2 — read
-- them back through the index before dropping it.
