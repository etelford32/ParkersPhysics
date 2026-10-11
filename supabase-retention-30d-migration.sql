-- supabase-retention-30d-migration.sql
--
-- Parker Physics — 30-day retention for the session / funnel / audit tables
-- (applied 2026-10-11 on the author's go)
--
-- privacy.html §11 (v3.0) promises these windows. Before this migration
-- nothing pruned them, so the policy line was a promise without a job
-- behind it. Each job below is what makes one row of that table true —
-- change a window here and the policy table must move with it.
--
--   user_sessions          30 days   (started_at)
--   client_telemetry       30 days   ALL kinds — funnel, page_flow, consent,
--                                    feature, data_pipeline, and any kind
--                                    added later. The existing 30-day error
--                                    job and 14-day vitals job
--                                    (supabase-client-telemetry-migration.sql)
--                                    stay; this is the catch-all behind them.
--   user_profiles_audit    30 days   security audit of role/plan changes
--   auth_failures          30 days   keyed email hashes of failed sign-ins
--   activation_events     180 days   per-account milestones; same window as
--                                    analytics_events ("usage analytics")
--
-- CONSEQUENCE, accepted on purpose: the admin funnel / A/B / page-flow /
-- consent RPCs accept windows up to 90–365 days (telemetry_*,
-- consent_optin_rate). They keep working but can only ever see 30 days.
-- An A/B test that needs more than 30 days of exposures must be read before
-- its early data ages out. retention_daily_curve (activation_events) clamps
-- to 365 but defaults to 60, inside the 180-day window.
--
-- Minutes 7/12/22/32/42 avoid every pg_cron job live on 2026-10-11
-- (:00 omni refresh, :17/:27/:37/:47/:52 pruners, :20 weather extremes).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        RAISE NOTICE 'pg_cron not installed — skipping schedule. Apply supabase-weather-pgcron-migration.sql first.';
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-user-sessions') THEN
        PERFORM cron.unschedule('prune-user-sessions');
    END IF;
    PERFORM cron.schedule(
        'prune-user-sessions',
        '7 * * * *',
        $cron$
            DELETE FROM public.user_sessions
             WHERE started_at < now() - interval '30 days';
        $cron$
    );

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-client-telemetry-all') THEN
        PERFORM cron.unschedule('prune-client-telemetry-all');
    END IF;
    PERFORM cron.schedule(
        'prune-client-telemetry-all',
        '12 * * * *',
        $cron$
            DELETE FROM public.client_telemetry
             WHERE created_at < now() - interval '30 days';
        $cron$
    );

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-user-profiles-audit') THEN
        PERFORM cron.unschedule('prune-user-profiles-audit');
    END IF;
    PERFORM cron.schedule(
        'prune-user-profiles-audit',
        '22 * * * *',
        $cron$
            DELETE FROM public.user_profiles_audit
             WHERE created_at < now() - interval '30 days';
        $cron$
    );

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-auth-failures') THEN
        PERFORM cron.unschedule('prune-auth-failures');
    END IF;
    PERFORM cron.schedule(
        'prune-auth-failures',
        '32 * * * *',
        $cron$
            DELETE FROM public.auth_failures
             WHERE created_at < now() - interval '30 days';
        $cron$
    );

    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prune-activation-events') THEN
        PERFORM cron.unschedule('prune-activation-events');
    END IF;
    PERFORM cron.schedule(
        'prune-activation-events',
        '42 * * * *',
        $cron$
            DELETE FROM public.activation_events
             WHERE created_at < now() - interval '180 days';
        $cron$
    );
END $$;

-- ── Verify ───────────────────────────────────────────────────────
--   SELECT jobname, schedule, active FROM cron.job
--    WHERE jobname LIKE 'prune-%' ORDER BY jobname;
