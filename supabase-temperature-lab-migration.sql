-- ═══════════════════════════════════════════════════════════════════════════
-- supabase-temperature-lab-migration.sql
--
-- The Planetary Temperature Lab's live aggregate (PLANETARY_TEMPERATURE_LAB_PLAN.md
-- §4.3, Phase 2). NOT YET APPLIED — apply on the author's go (CLAUDE.md §9 spirit:
-- schema changes to project aijsboodkivnhzfstvdq are the author's call).
--
-- Both functions read ONLY weather_grid_cache, which the hourly Vercel cron
-- already writes — this adds no upstream call. Their SELECT bodies were run
-- read-only against production on 2026-10-06 before this file was committed:
-- 24 frames in the window, all 2592 cells mapped by lat/lon rounding (no cell
-- collided with another), the previous 24 h fully covered.
--
-- WHAT THIS ADDS
--   • temperature_lab_cache — one row per hourly run, 48 kept. Derived PUBLIC
--     analysis (the same arrays /api/temperature/snapshot serves everyone), so
--     anon/authenticated may SELECT it — the weather_extremes_cache precedent.
--   • compute_temperature_lab() — per cell, over the newest 24 hourly frames:
--     max / min / mean of 2 m temperature, the newest frame's value, the mean
--     of the PREVIOUS 24 h (for the day-over-day swing card), and the frame
--     count. A cell with fewer than 18 of 24 frames is NULL, never zero.
--   • temperature_daily_cells — the lab's OWN consistent-source daily archive:
--     one row per UTC date, per cell the LOCAL SOLAR day's max / min / mean.
--     Service-role-only (RLS on, zero policies — the forecast_log /
--     weather_grid_cache pattern; the advisor flag is intentional, CLAUDE.md
--     §4.2). It outlives the grid cache's 30-day retention, and it is what the
--     plan's later phases verify against (representativeness offset, forecast
--     skill, the monthly harness check against C3S). ~31 KB/day, 800 kept.
--   • rollup_temperature_daily(p_date) — fills that archive for one UTC date.
--   • pg_cron: 'temperature-lab-hourly' at :25 (the grid lands at :00, the
--     extremes job runs at :20) and 'temperature-daily-rollup' at 13:30 UTC
--     (every longitude's local solar day for yesterday has ended by 12:00 UTC).
--
-- CONVENTIONS — each mirrors js/temperature-normals.js, which the lab scores
-- these arrays against:
--   • cell index j*72 + i with j = round((lat + 87.5)/5) from the SOUTH and
--     i = round((lon + 177.5)/5) mod 72. Keyed by COORDINATES, never by array
--     position (the extremes migration's rule): Open-Meteo returns its own
--     snapped grid coordinates, the MET Norway fallback the target centres, and
--     rounding to the nearest 5° centre is robust to both
--   • local solar day offset = floor(lon/15 + 0.5) hours at the cell CENTRE —
--     NOT round(): numpy/JS/Postgres disagree on halves and the centres hit
--     exact halves at 7.5° and −22.5°
--   • °C rounded to 0.01; arrays are 2592 long, ordered by cell index
--
-- Down-migration:
--   select cron.unschedule('temperature-lab-hourly');
--   select cron.unschedule('temperature-daily-rollup');
--   drop function if exists public.compute_temperature_lab();
--   drop function if exists public.rollup_temperature_daily(date);
--   drop table if exists public.temperature_lab_cache;
--   drop table if exists public.temperature_daily_cells;
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the hourly aggregate ────────────────────────────────────────────────────
create table if not exists public.temperature_lab_cache (
    id          bigint generated always as identity primary key,
    computed_at timestamptz not null default now(),
    frame_from  timestamptz not null,
    frame_to    timestamptz not null,
    n_frames    int         not null,
    sources     jsonb       not null,
    payload     jsonb       not null
);
create index if not exists temperature_lab_cache_computed_at_idx
    on public.temperature_lab_cache (computed_at desc);
alter table public.temperature_lab_cache enable row level security;
drop policy if exists temperature_lab_public_read on public.temperature_lab_cache;
create policy temperature_lab_public_read
    on public.temperature_lab_cache
    for select
    to anon, authenticated
    using (true);

create or replace function public.compute_temperature_lab()
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_to      timestamptz;
    v_from    timestamptz;
    v_n       int;
    v_sources jsonb;
    v_payload jsonb;
begin
    select max(fetched_at) into v_to from weather_grid_cache;
    if v_to is null then
        return;   -- empty archive; nothing to aggregate
    end if;

    select min(fetched_at), count(*) into v_from, v_n
    from weather_grid_cache
    where fetched_at > v_to - interval '23 hours 30 minutes' and fetched_at <= v_to;

    select coalesce(jsonb_object_agg(source, n), '{}'::jsonb) into v_sources
    from (
        select source, count(*) as n
        from weather_grid_cache
        where fetched_at > v_to - interval '23 hours 30 minutes' and fetched_at <= v_to
        group by source
    ) s;

    with win as (
        select fetched_at, payload from weather_grid_cache
        where fetched_at > v_to - interval '23 hours 30 minutes' and fetched_at <= v_to
    ),
    prev as (
        select payload from weather_grid_cache
        where fetched_at > v_to - interval '47 hours 30 minutes'
          and fetched_at <= v_to - interval '23 hours 30 minutes'
    ),
    cells as (
        select (round(((c->>'latitude')::numeric + 87.5) / 5))::int * 72
             + ((round(((c->>'longitude')::numeric + 177.5) / 5))::int % 72 + 72) % 72 as idx,
               (c->'current'->>'temperature_2m')::real as t,
               w.fetched_at
        from win w, jsonb_array_elements(w.payload) c
    ),
    pcells as (
        select (round(((c->>'latitude')::numeric + 87.5) / 5))::int * 72
             + ((round(((c->>'longitude')::numeric + 177.5) / 5))::int % 72 + 72) % 72 as idx,
               (c->'current'->>'temperature_2m')::real as t
        from prev p, jsonb_array_elements(p.payload) c
    ),
    agg as (
        select idx, max(t) as tmax, min(t) as tmin, avg(t) as tmean, count(t) as n
        from cells group by idx
    ),
    nowc as (
        select idx, avg(t) as tnow from cells where fetched_at = v_to group by idx
    ),
    pagg as (
        select idx, avg(t) as pmean, count(t) as pn from pcells group by idx
    ),
    grid as (
        select g.idx, a.tmax, a.tmin, a.tmean, coalesce(a.n, 0) as n, nw.tnow, p.pmean, coalesce(p.pn, 0) as pn
        from generate_series(0, 2591) as g(idx)
        left join agg  a  using (idx)
        left join nowc nw using (idx)
        left join pagg p  using (idx)
    )
    select jsonb_build_object(
        't24max',     jsonb_agg(case when n  >= 18 then round(tmax::numeric,  2) end order by idx),
        't24min',     jsonb_agg(case when n  >= 18 then round(tmin::numeric,  2) end order by idx),
        't24mean',    jsonb_agg(case when n  >= 18 then round(tmean::numeric, 2) end order by idx),
        'tnow',       jsonb_agg(round(tnow::numeric, 2) order by idx),
        'prev24mean', jsonb_agg(case when pn >= 18 then round(pmean::numeric, 2) end order by idx),
        'n24',        jsonb_agg(n order by idx),
        'units',      '°C',
        'min_frames', 18
    ) into v_payload
    from grid;

    insert into temperature_lab_cache (frame_from, frame_to, n_frames, sources, payload)
    values (v_from, v_to, v_n, v_sources, v_payload);

    delete from temperature_lab_cache
    where id not in (select id from temperature_lab_cache order by computed_at desc limit 48);
end;
$$;

-- NOT part of the anonymous-telemetry surface — cron (postgres role) and
-- service_role only, per the CLAUDE.md §8 SECURITY DEFINER heuristics.
revoke execute on function public.compute_temperature_lab() from public, anon, authenticated;

-- ── the daily archive ───────────────────────────────────────────────────────
create table if not exists public.temperature_daily_cells (
    utc_date    date        primary key,
    computed_at timestamptz not null default now(),
    sources     jsonb       not null,
    tmax        real[]      not null,
    tmin        real[]      not null,
    tmean       real[]      not null,
    n           smallint[]  not null
);
alter table public.temperature_daily_cells enable row level security;
-- (zero policies on purpose: service-role-only, like forecast_log)

create or replace function public.rollup_temperature_daily(
    p_date date default ((now() at time zone 'utc')::date - 1)
) returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_day int := (p_date - date '1970-01-01');   -- local solar day index
begin
    with frames as (
        -- every frame that can belong to some longitude's local day p_date
        select date_trunc('hour', fetched_at) as hr, source, payload
        from weather_grid_cache
        where fetched_at >= (p_date::timestamp - interval '13 hours') at time zone 'utc'
          and fetched_at <  (p_date::timestamp + interval '37 hours') at time zone 'utc'
    ),
    cells as (
        select (round(((c->>'latitude')::numeric + 87.5) / 5))::int * 72
             + ((round(((c->>'longitude')::numeric + 177.5) / 5))::int % 72 + 72) % 72 as idx,
               (c->'current'->>'temperature_2m')::real as t,
               f.hr
        from frames f, jsonb_array_elements(f.payload) c
    ),
    local_day as (
        -- floor(lon/15 + 0.5) at the CELL CENTRE, lon = −177.5 + 5·(idx % 72)
        select idx, t,
               floor((extract(epoch from hr) / 3600
                      + floor((-177.5 + 5 * (idx % 72)) / 15.0 + 0.5)) / 24)::int as dayidx
        from cells
    ),
    agg as (
        select idx, max(t) as tmax, min(t) as tmin, avg(t) as tmean, count(t) as n
        from local_day where dayidx = v_day group by idx
    ),
    grid as (
        select g.idx, a.tmax, a.tmin, a.tmean, coalesce(a.n, 0) as n
        from generate_series(0, 2591) as g(idx) left join agg a using (idx)
    )
    insert into temperature_daily_cells (utc_date, computed_at, sources, tmax, tmin, tmean, n)
    select p_date, now(),
           (select coalesce(jsonb_object_agg(source, k), '{}'::jsonb)
              from (select source, count(*) as k from frames group by source) s),
           array_agg(case when n >= 18 then round(tmax::numeric,  2)::real end order by idx),
           array_agg(case when n >= 18 then round(tmin::numeric,  2)::real end order by idx),
           array_agg(case when n >= 18 then round(tmean::numeric, 2)::real end order by idx),
           array_agg(n::smallint order by idx)
    from grid
    on conflict (utc_date) do update set
        computed_at = excluded.computed_at, sources = excluded.sources,
        tmax = excluded.tmax, tmin = excluded.tmin, tmean = excluded.tmean, n = excluded.n;

    delete from temperature_daily_cells where utc_date < p_date - 800;
end;
$$;

revoke execute on function public.rollup_temperature_daily(date) from public, anon, authenticated;

-- ── schedules (cron.schedule upserts by jobname, so re-running is safe) ─────
select cron.schedule(
    'temperature-lab-hourly',
    '25 * * * *',
    $$select public.compute_temperature_lab()$$
);
select cron.schedule(
    'temperature-daily-rollup',
    '30 13 * * *',
    $$select public.rollup_temperature_daily()$$
);
