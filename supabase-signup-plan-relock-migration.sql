-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Re-lock the signup plan (2026-10-15)
-- ═══════════════════════════════════════════════════════════════
--
-- Applied to production 2026-10-15.
--
-- WHAT WAS WRONG
-- ──────────────
-- `supabase-schema-hardening-followup-migration.sql` already fixed
-- this once: `handle_new_user()` must NEVER read `plan` from
-- `raw_user_meta_data`, because that object is whatever the client
-- passed to `supabase.auth.signUp({ options: { data } })`. On
-- 2026-10-15 the LIVE function still read
--
--     COALESCE(v_meta->>'plan', 'free')
--
-- (verified with pg_get_functiondef), so any signup could mint its
-- own `enterprise` account. The UPDATE-side guards
-- (`trg_lock_user_profile_protected`, `trg_guard_user_profile_self_update`)
-- were live; only the INSERT path had regressed. 0 of the 10 accounts
-- that existed at the time had a non-free plan they were not granted.
--
-- This file replays the hardening-followup body with the live
-- function's `SET search_path` pinned, so a later edit of either
-- migration cannot silently drop it. `supabase-public-test-signup-
-- migration.sql` supersedes this body (it adds the tester default and
-- the persona fields) and keeps the same rule: the PLAN is decided
-- here, never by the client.
--
-- Idempotent. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_meta  JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
    v_first TEXT  := NULLIF(TRIM(v_meta->>'given_name'),  '');
    v_last  TEXT  := NULLIF(TRIM(v_meta->>'family_name'), '');
    v_full  TEXT;
    v_name  TEXT;
BEGIN
    v_full := CASE
        WHEN v_first IS NOT NULL AND v_last IS NOT NULL THEN v_first || ' ' || v_last
        WHEN v_first IS NOT NULL                         THEN v_first
        WHEN v_last  IS NOT NULL                         THEN v_last
        ELSE NULL
    END;

    v_name := COALESCE(
        NULLIF(TRIM(v_meta->>'name'),         ''),     -- our manual signup
        NULLIF(TRIM(v_meta->>'full_name'),    ''),     -- Google
        NULLIF(TRIM(v_meta->>'display_name'), ''),     -- Apple (rare)
        v_full,                                        -- Google fallback
        split_part(NEW.email, '@', 1)                  -- last resort
    );

    INSERT INTO public.user_profiles (id, email, display_name, plan, role)
    VALUES (
        NEW.id,
        NEW.email,
        v_name,
        'free',   -- HARD-CODED. Never read from raw_user_meta_data (client-controlled).
        'user'    -- HARD-CODED. Admin grants happen post-signup.
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;

-- Verify (expect the function body to contain no "->>'plan'"):
--   SELECT pg_get_functiondef('public.handle_new_user'::regproc) ~ '->>''plan''';  -- false
