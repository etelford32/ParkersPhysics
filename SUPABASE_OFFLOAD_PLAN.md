# SUPABASE_OFFLOAD_PLAN.md — take compute (and bulk data) out of Supabase

> Status: **PLAN, nothing applied.** Written 2026-11-03 from live measurements
> of project `aijsboodkivnhzfstvdq`. Every number in §1 is reproducible with
> the queries in §7. No migration in here has been run against production.

## 0. The one-paragraph answer

Supabase is **not** compute-starved today. The dashboard's "Compute 63 %" is
the MAX of CPU / memory / disk-IO, and the 63 % is **memory** — on a 1 GB
instance (`shared_buffers` = 224 MB) Postgres is supposed to hold most of
RAM as cache; that number does not go down by doing less work. **CPU is
19 %** and the **disk-IO burst balance is 98 %** (nearly full = healthy).
So the goal of this plan is not to rescue a dying database; it is to make
Supabase what it is good at — **auth, the row-level-secured account tables
and the anonymous telemetry surface** — and move everything that is really
*a batch job, an archive or a file* to places that cost nothing per query:
the Vercel cron layer, R2 object storage behind the CDN, and Elliot's own
machines for heavy/offline work.

One honest constraint shapes the whole plan: **personal computers are not
always on.** Anything a live page needs within the hour (solar wind, the
weather grid, aurora alerts) must stay on always-on infrastructure (Vercel
cron + R2). The workstation takes batch, archival, research and analytics
work whose output can be published as a file and be a few hours late.

---

## 1. What actually uses the database (measured 2026-11-02/03)

### 1.1 CPU inside Postgres

| Source | Cost | Notes |
|---|---|---|
| **pg_cron `weather-extremes-hourly`** → `compute_weather_extremes(30, 1)` | **36.3 s avg / 45.5 s max, every hour ≈ 14.5 core-min/day** | Re-parses the whole 30-day `weather_grid_cache` (286 frames × 2 592 cells, **48 MB of JSONB in TOAST**) with `jsonb_array_elements` and 13 `percentile_cont`s per cell, every hour, to compare ONE new frame against statistics that move by a hair per hour. **This is >90 % of all scheduled in-DB CPU.** |
| pg_cron `omni_hourly_refresh` | 0.83 s/h | Fine. |
| 10 prune jobs (`DELETE … < now() - interval`) | ~0.6 s/h total | Fine; one `prune-auth-failures` run took 43.7 s once (lock wait). Could be one job. |
| PostgREST schema-cache reloads (`WITH -- Recursively get the base types…`) | ~1.3 s each, 10× in 4 h | Fired by DDL / `NOTIFY pgrst` and restarts. Every migration and every Studio schema edit pays it. |
| Supabase Studio itself (`SELECT name FROM pg_timezone_names`, 6.8 s each) | 20 s in 4 h | **Having the dashboard open costs CPU.** Close the Infrastructure / Table editor tabs when you're not using them. |
| `session_heartbeat` RPC from browsers | ~357 ms mean (cold cache after the 19:27 UTC restart) | Anonymous telemetry; volume is low (≈100 sessions/30 d). |

### 1.2 Writes (WAL, dead tuples, autovacuum)

| Writer | Cadence | What it writes |
|---|---|---|
| `api/cron/refresh-solar-wind` | **every minute** (1 440×/day) | `record_solar_wind_sample` + `record_pipeline_success` (a heartbeat UPDATE per minute) + trims |
| `api/cron/sync-dataset` | every 10 min | upserts 180 minute-rows into `sw_geomag_dataset` (no-op updates already suppressed by trigger — `supabase-write-amplification-migration.sql`) |
| `api/cron/refresh-weather-grid` | hourly | one ~170 KB JSONB frame into `weather_grid_cache` |
| `api/cron/aurora-*`, `farside-ingest`, `validation-rerun`, digests | 15 min – daily | small |
| Browser telemetry (`analytics_events`, `client_telemetry`, `user_sessions`) | per visit | small, anon-write by design (CLAUDE.md §4.2) |

### 1.3 Storage (DB = 167 MB of the 500 MB free-tier cap; WAL another 128 MB)

| Table | Size | Rows | Really is… |
|---|---|---|---|
| `weather_grid_cache` | **64 MB** (62 MB TOAST) | 286 | a stack of hourly **files** |
| `sw_geomag_dataset` | **55 MB** | 162 549 | a 180-day minute **archive** (append-mostly time series) |
| `client_telemetry` | 11 MB | 6 567 | event log |
| `geomag_indices` | 5 MB | 35 966 | raw index archive |
| `analytics_events` | 5 MB | 7 892 | event log |
| `solar_wind_samples` | 3 MB | 9 826 | live ring (keep) |
| `forecast_log` | 2.7 MB | 9 464 | forecast ledger (already archived to R2 by `archive-forecasts`) |
| `omni_hourly` | 1.2 MB | 10 047 | static-ish archive |
| everything account-shaped (`user_profiles` 11 rows, `dashboards`, invites…) | < 1 MB | — | **this is what Supabase is for** |

**~75 % of the database is two tables that are files and archives, not
relational data.** That is also the history behind the 2026-09-18 HTTP 402
outage (`supabase-storage-reclaim-migration.sql`): the bulk tables, not the
product tables, are what push against free-tier quotas (size and egress).

---

## 2. Target architecture — who owns what

```
┌───────────────── SUPABASE (keep) ─────────────────┐
│ auth.*  user_profiles  dashboards  invites/class  │
│ alert prefs/subscribers  stripe ids               │
│ anon telemetry INSERT surface (RLS as-is)         │
│ small live rings: solar_wind_samples (7 d),       │
│   pipeline_heartbeat, forecast_log (recent),      │
│   cme_* ledgers, *_cache single-row answers       │
└───────────────────────────────────────────────────┘
┌──────────── VERCEL CRON (always-on compute) ──────┐
│ fetch upstreams, decode, compute derived products │
│ (extremes, temperature lab, aurora outlook)       │
│ write FILES to R2, write a POINTER/summary row    │
└───────────────────────────────────────────────────┘
┌──────────── R2 + CDN (bulk data, $0/query) ───────┐
│ weather/grid/YYYY/MM/DD/HH.json.gz                │
│ weather/extremes/latest.json                      │
│ dataset/sw-geomag/YYYY-MM-DD.ndjson.gz (+parquet) │
│ archive/geomag-indices/, omni/, telemetry exports │
└───────────────────────────────────────────────────┘
┌──────────── ELLIOT'S MACHINES (batch / offline) ──┐
│ nightly pull: telemetry + archives → DuckDB       │
│ admin analytics funnels, LSTM/ML training,        │
│ hindcasts (SWMF/DSMC, already there), validation  │
│ re-baking, local Supabase for dev & Playwright    │
│ publish results → R2 (never writes prod DB live)  │
└───────────────────────────────────────────────────┘
```

Rules that keep this honest:

1. **Postgres stores rows people own and rows a page needs in one indexed
   lookup.** A JSONB blob > 10 KB that is only ever read whole is a file.
2. **Derived products are computed where the input already is.** The
   weather cron has the new frame in memory; the extremes comparison belongs
   there, not in a pg_cron job that re-reads 30 days to see it.
3. **The workstation never sits on a live path.** If it is off for a week the
   site keeps working; only batch products (analytics, retrains, hindcasts)
   go stale, and they carry their own `generated_at`.
4. **Every move keeps the existing route contract** (`/api/weather/grid`,
   `/api/weather/extremes`, `freshness`, `age_seconds`, the pipeline
   registry) so no page changes in the same PR as a storage move.
5. R2 is already wired (`api/_lib/r2-client.js`, used by
   `api/cron/archive-forecasts.js` and `scripts/build-density-mirror.mjs`).
   No new vendor.

---

## 3. Phases (ranked by CPU / storage saved per hour of work)

### Phase A — stop the hourly 30-day re-scan (biggest CPU win, ~1 day)

`compute_weather_extremes` is **the** compute load. Two options; do A1 now,
A2 when Phase B lands.

- **A1 (in-DB, small):** split it into
  - `compute_weather_cell_stats(30)` — the percentile pass, writes a
    `weather_cell_stats` table (2 592 rows), scheduled **once a day**
    (03:20 UTC). Percentiles over 30 days move by <1/720 of their sample
    per hour; recomputing them hourly buys nothing.
  - `compute_weather_extremes()` — hourly, reads ONLY the newest frame
    (one row) and joins it to `weather_cell_stats`. Cost ≈ one frame parse
    (~0.1 s) instead of 286.
  - **Saves ≈ 23/24 of the job → ~14 core-min/day → ~0.6 core-min/day.**
  - Output table `weather_extremes_cache` and `/api/weather/extremes`
    unchanged. Gate: run old and new side by side for one day and diff the
    ranked rows (they must match to the percentile's own rounding, since the
    stats window shifts by ≤ 23 h — state that in the migration header).
  - Watch for: the `p_decimate = 1` load-bearing note in
    `supabase-storage-reclaim-migration.sql` §2 still applies to the daily
    pass.
- **A2 (out of DB):** once frames live in R2 (Phase B), the daily stats pass
  moves to a Vercel cron (or the workstation, published to R2 —
  it's a daily product and may be hours late), and the hourly comparison
  moves into `api/cron/refresh-weather-grid.js`, which already holds the new
  frame. pg_cron job deleted. In-DB CPU for weather → 0.
- `compute_temperature_lab()` (`supabase-temperature-lab-migration.sql`,
  **written, not applied**) has the same shape — **do not apply it as
  written**; build it on A2 instead so it never becomes a second hourly
  30-day re-scan.

### Phase B — weather grid frames → R2 (biggest storage win, ~1–2 days)

- `refresh-weather-grid` writes `weather/grid/<ISO hour>.json.gz` to R2 and a
  tiny `weather_grid_index(fetched_at, source, r2_key, bytes, pressure_kind)`
  row. `weather_grid_cache` keeps the **latest 1–3 frames only** (fallback if
  R2 is down) → **64 MB → ~0.5 MB**.
- `/api/weather/grid` range mode (up to 72 frames ≈ 4 MB per response)
  reads from R2/CDN instead of PostgREST — this is also the largest
  **egress** item, the quota suspected in the September 402.
- Retention/decimation policy (`trim_weather_grid_cache`) moves to an R2
  lifecycle + the index table; keep the lockstep rule documented there.
- Readers to update: `api/weather/grid.js`, `api/temperature/snapshot.js`,
  `compute_weather_extremes` (via A2). Gate: `node tests/weather-grid-pipeline.mjs`
  + the EarthView gates listed in CLAUDE.md for that route.

### Phase C — the minute dataset → daily files (~1–2 days)

- `sw_geomag_dataset` keeps a **rolling 3–7 days** (the self-healing window
  is 3 h; nothing live reads further back).
- A daily job (first `sync-dataset` run of the UTC day already does the
  24 h deep rebuild) seals **yesterday** into
  `dataset/sw-geomag/YYYY-MM-DD.ndjson.gz` on R2; `/api/ring-current/dataset`
  serves history from the files (CDN-cached forever — a sealed day never
  changes). **55 MB → ~3 MB**, and autovacuum on that table nearly stops.
- Same treatment for `geomag_indices` older than 30 d and `omni_hourly`
  (already a static archive — publish once, keep a 30-day hot slice).
- The workstation can additionally convert the daily NDJSON to Parquet for
  DuckDB/pandas; that is an *extra* artifact, not the source of truth.

### Phase D — cut the per-minute chatter (~half a day)

- `refresh-solar-wind` every minute is correct for freshness, but it writes a
  `pipeline_heartbeat` UPDATE every minute (1 440 dead tuples/day on a hot
  row). Change the solar-wind caller to write the success heartbeat **on
  state change or at most every 3 min** — NOT 10: `HEARTBEAT_PIPELINES` in
  `js/pipeline-registry.js` sets `solar_wind` `warnMin: 5`, so a 10-min
  heartbeat would paint status.html amber on a healthy feed. (Or raise
  `warnMin` deliberately — but then a genuine 5–10 min outage goes unseen.)
  Failures always write immediately. Saves ~1 100 hot-row UPDATEs/day.
- Fold the 10 hourly prune jobs into ONE `prune_all()` at a quiet minute
  (fewer cron rows, fewer `cron.job_run_details` writes, no overlapping lock
  waits like the 43.7 s `prune-auth-failures`).
- `prewarm-hot` hits `/api/solar-wind/latest` every 5 min; with
  `s-maxage=30` each prewarm is a guaranteed DB read. Raise to 60 s
  (matches the writer cadence) — check `api/solar-wind/latest.js` header
  reasoning first.

### Phase E — analytics & admin compute → the workstation (~2–3 days)

- The admin pages call ~15 heavy `telemetry_*` RPCs
  (`telemetry_auth_funnel_*`, `telemetry_page_flow_*`,
  `telemetry_experiment_*`, `feature_return_rates`) that aggregate over the
  event tables on every admin page view.
- Add `scripts/export-telemetry.mjs` (service key, run on the workstation
  nightly via cron/launchd): pages `analytics_events`, `client_telemetry`,
  `user_sessions`, `activation_events`, `auth_failures` (already hashed) into
  local Parquet/DuckDB. Re-implement the funnels as DuckDB SQL there, publish
  `admin/analytics/<date>.json` to R2 (private bucket path, signed URL,
  admin-gated route).
- Then **shorten DB retention** on the event tables to 14–30 days (the
  workstation holds history). The anon INSERT surface and its RLS stay
  exactly as CLAUDE.md §4.2 requires — only the *reading* moves.
- Privacy: exports contain no plaintext emails (auth_failures is HMAC'd);
  keep the export dir out of git and out of any synced folder you share.

### Phase F — local Supabase for development (~half a day)

- `js/supabase-config.js` hard-codes the production URL, so every local
  `node dev-server.mjs` session and every Playwright run with network access
  that signs in, heartbeats or logs activation **writes to production**.
- Add a host switch: on `localhost`/`127.0.0.1` (and when
  `navigator.webdriver` is true) read an override from
  `localStorage['pp_supabase_url']` / `?sb=local`, defaulting to a local
  stack started with `supabase start` (Docker; the CLI baseline already
  exists in `supabase/migrations/`, plus the top-level `supabase-*-migration.sql`
  files applied in header order — see the storage-reclaim header for why
  the baseline is not a live mirror).
- **Do NOT edit `supabase/migrations/`** to do this: Git branching spins up a
  preview database per commit for any PR that touches it (storage-reclaim
  header). Local-only seed scripts go under `scripts/local-supabase/`.
- Check first which browser gates assert real Supabase behaviour
  (`tests/auth-e2e.spec.js`, `tests/auth-funnel.spec.js`); they keep the prod
  path explicitly.

### Phase G — long-running physics stays where it already is

SWMF/BATS-R-US, DSMC, the Gannon hindcast and LSTM training already run on
the workstation and publish through R2 (`NEW_COMPUTER_RUNBOOK.md`). Nothing
there touches Supabase compute; keep it that way — publish artifacts to R2,
write at most one ledger row per run.

---

## 4. Expected result

| | Today | After A1+D | After A–F |
|---|---|---|---|
| Scheduled in-DB CPU | ~15 core-min/day | ~1 core-min/day | ~0.3 core-min/day |
| DB size | 167 MB | 167 MB | **~30–40 MB** |
| Largest egress (weather range reads) | PostgREST | PostgREST | R2/CDN |
| Writes/min from crons | ~3 | ~1.2 | ~1.2 |
| What breaks if the workstation is off | — | — | admin analytics & retrains go stale (dated), site unaffected |

Memory will still read 50–65 % on the dashboard after all of this. That is
the page cache doing its job and is the expected steady state; judge success
by CPU, disk-IO balance, DB size and egress on **Org → Usage**, not by the
memory bar.

## 5. What we are NOT moving (and why)

- **Auth, `user_profiles`, RLS, the SECURITY DEFINER telemetry functions** —
  this is the part of Supabase you are paying for; replicating it on your own
  machines would trade a managed security boundary for a home server.
- **Anon telemetry INSERTs** — required by design (CLAUDE.md §4.2).
- **`solar_wind_samples`, `pipeline_heartbeat`, the CME ledgers** — small,
  hot, read by indexed lookups; Postgres is the right tool.
- **Read replicas** (shown on the Infrastructure page) — not needed; they
  would add a second always-on instance to serve load the primary has 80 %
  CPU headroom for.
- **A compute-size upgrade** — not justified by these numbers.

## 6. Order of work / decisions needed

1. **A1 + D** first: pure efficiency, no new infrastructure, one migration
   each, reversible. Needs your go to apply to production.
2. **B, then A2, then C**: the R2 moves; each keeps its route contract and
   ships with its existing gates.
3. **E and F** whenever you want the workstation pipeline; E needs you to
   pick where the nightly job runs (which machine, launchd vs cron).

## 7. Reproduce the measurements

```sql
-- top statements since last reset
select left(query,160), calls, total_exec_time/1000 s, mean_exec_time ms
from extensions.pg_stat_statements order by total_exec_time desc limit 40;

-- pg_cron cost per job, last 7 days
select j.jobname, count(*), avg(extract(epoch from end_time-start_time))
from cron.job j join cron.job_run_details d using (jobid)
where d.start_time > now() - interval '7 days' group by 1 order by 3 desc;

-- table sizes
select relname, pg_size_pretty(pg_total_relation_size(relid)), n_live_tup, n_dead_tup
from pg_stat_user_tables order by pg_total_relation_size(relid) desc limit 20;
```
