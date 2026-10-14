-- supabase-cme-outlook-migration.sql
-- Issue-locked daily ledger for the CME ERUPTION OUTLOOK (cme-outlook-v0):
-- P(an Earth-arriving CME on valid_day) from eruptions that had NOT
-- happened at issue time. Design: CME_OUTLOOK_PLAN.md §5.
--
-- STATUS: WRITTEN, NOT APPLIED (2026-10-14) — needs the author's go.
-- Until it is applied, api/cron/validation-rerun.js logs
-- `outlook: { reason: 'table_missing' }` and the rest of the run is
-- unaffected.
--
-- Why its own table and not cme_arrival_forecasts: an outlook is a
-- probability per DAY for CMEs that do not exist yet, not an arrival time
-- for a catalogued CME. Putting it in the arrival ledger would let it be
-- plotted or scored as one (CME_OUTLOOK_PLAN.md §2 rule 1).
--
-- ACCESS MODEL (CLAUDE.md §4.2, same as cme_arrival_forecasts): RLS enabled
-- with ZERO policies. Written and read by the cron (service role). The
-- advisor flag is a known false positive; do not add permissive policies.
--
-- RECORD-BEFORE-PREDICT: one issue per (model, UTC issue day, valid day).
-- The cron inserts with `resolution=ignore-duplicates`, so the FIRST issue
-- of a day is the record and a re-run can never rewrite it. Only the
-- resolution columns (obs_*, resolved_at) are ever updated.

CREATE TABLE IF NOT EXISTS public.cme_outlook_issues (
    id            BIGSERIAL PRIMARY KEY,
    model_id      TEXT NOT NULL,                      -- 'cme-outlook-v0'
    issued_at     TIMESTAMPTZ NOT NULL,
    issue_day     DATE NOT NULL,                      -- UTC day of issued_at
    valid_day     DATE NOT NULL,                      -- UTC day the probability is for
    lead_days     SMALLINT NOT NULL CHECK (lead_days BETWEEN 0 AND 30),
    p_arrival     REAL NOT NULL CHECK (p_arrival BETWEEN 0 AND 1),
    p_geo         REAL CHECK (p_geo BETWEEN 0 AND 1), -- P(min Bz < −10 nT)
    expected      REAL,                               -- Poisson μ behind p_arrival
    lower_bound   BOOLEAN NOT NULL DEFAULT FALSE,     -- unseen regions excluded
    inputs        JSONB,                              -- regions + assumptions (lead 0 row only)
    -- Resolution (cron, ≥ 2 days after valid_day):
    obs_arrival   BOOLEAN,     -- an observed arrival on valid_day of a CME launched after issued_at
    obs_geo       BOOLEAN,     -- …and its observed min Bz < −10 nT (NULL = Bz unknown)
    resolved_at   TIMESTAMPTZ,
    resolve_note  TEXT,        -- e.g. 'l1-coverage-gap' when left unresolved
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (model_id, issue_day, valid_day)
);

CREATE INDEX IF NOT EXISTS cme_outlook_issues_pending
    ON public.cme_outlook_issues (valid_day) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS cme_outlook_issues_model_lead
    ON public.cme_outlook_issues (model_id, lead_days, valid_day DESC);

ALTER TABLE public.cme_outlook_issues ENABLE ROW LEVEL SECURITY;
-- (no policies — service-role only, by design)
