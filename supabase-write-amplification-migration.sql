-- ═══════════════════════════════════════════════════════════════
-- WRITE AMPLIFICATION — applied 2026-09-19 to aijsboodkivnhzfstvdq
--
-- Companion to supabase-storage-reclaim-migration.sql. That one
-- reclaimed 119 MB of SPACE; this one stops the churn that was
-- regenerating bloat and WAL underneath it.
--
-- THE SHAPE OF THE BUG, in both cases: a pipeline re-upserts a window
-- of already-settled rows on every tick. An upsert whose values are
-- identical to what is already stored STILL writes a new tuple version
-- — Postgres does not compare, it just writes — so each no-op leaves a
-- dead tuple behind and a full row in WAL. Measured before the fix:
--
--   sw_geomag_dataset  n_tup_upd/n_live_tup = 1,714,801/98,179 = 17.5x
--   omni_hourly        n_tup_upd/n_live_tup = 1,265,912/9,013  = 140x
--
-- Table bloat was 27.8% on sw_geomag_dataset, and WAL sat at 128 MB.
--
-- WHAT IS *NOT* THE FIX: shrinking the windows. sync-dataset's 3 h
-- window is a DESIGNED self-healing property ("missed ticks <=3 h leave
-- no scar" — see the api/cron/sync-dataset.js header), and OMNI's
-- 45-day window exists because CDAWeb revises history. Narrowing either
-- trades away correctness to buy writes. The fix is to keep the windows
-- and stop writing when nothing changed.
-- ═══════════════════════════════════════════════════════════════

-- ── 1. sw_geomag_dataset ──────────────────────────────────────
-- Written by api/cron/sync-dataset.js through PostgREST with
-- Prefer: resolution=merge-duplicates. PostgREST's DO UPDATE SET only
-- touches columns present in the payload, and the app NEVER sends
-- synced_at (it is DB-default only) — verified in the data: 180 rows in
-- the trailing 3 h carried just 18 distinct synced_at values, i.e. each
-- row kept its FIRST insert time across ~17 re-upserts. So a settled
-- minute re-upserts byte-identical, and the built-in suppressor catches
-- every one of them.
--
-- VERIFIED before adopting (ctid/xmin, not pg_stat, which lags):
--   no trigger, no-op update  -> ctid (3359,1) -> (3570,20)  REWRITTEN
--   trigger,    no-op update  -> ctid (3570,20) unchanged     SUPPRESSED
--   trigger,    real change   -> ctid (3570,21)               LANDS
-- The third line is the one that matters: revisions must still apply,
-- because a suppressor that ate them would silently freeze the dataset.

CREATE TRIGGER sw_geomag_dataset_suppress_noop
    BEFORE UPDATE ON public.sw_geomag_dataset
    FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger();

-- ── 2. omni_hourly ────────────────────────────────────────────
-- omni_refresh() re-ingests a 45-DAY window EVERY HOUR (~1080 rows), of
-- which only the last few are ever revised — hence 140x.
--
-- A trigger cannot help here: omni_ingest sets ingested_at=now() in its
-- own DO UPDATE, so NEW never equals OLD and suppress_redundant_updates
-- would fire on every row and suppress nothing. The fix has to be the
-- ON CONFLICT ... WHERE clause instead, comparing only the DATA columns.
--
-- This changes ingested_at's meaning from "when we last looked" to "when
-- the value last actually changed", and makes omni_ingest's return count
-- changed rows rather than touched rows. Both are safe here: nothing in
-- the repo reads ingested_at or omni_refresh's return value, and
-- omni_refresh updates pipeline_heartbeat UNCONDITIONALLY, so freshness
-- monitoring does not depend on the count being non-zero.
--
-- NOTE — REPO DRIFT: omni_ingest/omni_refresh existed ONLY in the
-- database; no .sql file in this repo defined them before this one.
-- The whole function is reproduced here so the definition is version
-- controlled, not just the one clause that changed.
--
-- VERIFIED: identical re-ingest -> ctid unchanged AND ingested_at
-- untouched; a dst_nt revision (-4 -> 3) rewrote the tuple and landed.

CREATE OR REPLACE FUNCTION public.omni_ingest(tmin text, tmax text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $fn$
declare
  url  text;
  resp public.http_response;
  cnt  integer := 0;
begin
  perform http_set_curlopt('CURLOPT_TIMEOUT','55');
  url := 'https://cdaweb.gsfc.nasa.gov/hapi/data?id=OMNI2_H0_MRG1HR'
       ||'&parameters=Time,BZ_GSM1800,N1800,V1800,DST1800'
       ||'&time.min='||tmin||'&time.max='||tmax||'&format=csv';
  resp := http_get(url);
  if resp.status <> 200 then
    raise notice 'HAPI HTTP % for % .. %', resp.status, tmin, tmax;
    return 0;
  end if;

  with lines as (
    select string_to_array(line, ',') c
    from unnest(string_to_array(resp.content, E'\r\n')) as line
    where line ~ '^[0-9]{4}-'
  ), parsed as (
    select (c[1])::timestamptz as t,
           case when c[2]::float8 >=  999   then null else c[2]::float8 end as bz,
           case when c[3]::float8 >=  999   then null else c[3]::float8 end as dens,
           case when c[4]::float8 >= 9999   then null else c[4]::float8 end as v,
           case when abs(c[5]::float8) >= 99990 then null else c[5]::float8 end as dst
    from lines where array_length(c,1) = 5
  )
  insert into public.omni_hourly(t,bz_nt,n_cc,v_km_s,dst_nt)
  select t,bz,dens,v,dst from parsed
  on conflict (t) do update
    set bz_nt=excluded.bz_nt, n_cc=excluded.n_cc,
        v_km_s=excluded.v_km_s, dst_nt=excluded.dst_nt,
        ingested_at=now()
  -- Only write when the DATA differs. Row-wise IS DISTINCT FROM is
  -- NULL-safe per field, which matters because every one of these
  -- columns is nullable by design (OMNI fill values parse to NULL).
  where (omni_hourly.bz_nt, omni_hourly.n_cc, omni_hourly.v_km_s, omni_hourly.dst_nt)
     is distinct from
        (excluded.bz_nt, excluded.n_cc, excluded.v_km_s, excluded.dst_nt);
  get diagnostics cnt = row_count;
  return cnt;
end $fn$;

-- ── Reclaim the bloat these two had already produced ──────────
-- Outside a transaction block, one statement per call:
--   VACUUM (FULL, ANALYZE) public.sw_geomag_dataset;
--   VACUUM (FULL, ANALYZE) public.omni_hourly;

-- ── STILL OUTSTANDING ─────────────────────────────────────────
-- sw_geomag_dataset KEEP_DAYS = 180 (api/cron/sync-dataset.js) with only
-- 68 days accumulated: ~259k rows / ~98 MB at steady state, enough to
-- breach the free tier again on its own. Retention is a product
-- decision, so it is deliberately NOT changed here.
