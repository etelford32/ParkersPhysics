-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Public test sign-up (Founding Testers)
-- ═══════════════════════════════════════════════════════════════
--
-- While the public test runs, every new account is a TESTER
-- (plan 'tester', already in the plan CHECK via
-- supabase-tester-tier-migration.sql, and already mapped to PRO by
-- js/config.js planToTier()). Sign-up also records WHO the person is
-- (persona) so the welcome path and operator follow-up can route on it.
--
-- THE PLAN IS STILL DECIDED HERE, NEVER BY THE CLIENT.
-- handle_new_user() reads ONLY the whitelisted persona fields from
-- raw_user_meta_data (client-controlled) and re-validates each one.
-- It never reads `plan` or `role` from it — see
-- supabase-signup-plan-relock-migration.sql for the regression that
-- rule exists to prevent.
--
-- LOCKSTEP WITH js/public-test.js (tests/public-test.mjs reads this file):
--   public_test_active()   ↔ PUBLIC_TEST
--   persona whitelist      ↔ PERSONA_IDS
--   fleet_size whitelist   ↔ FLEET_SIZES
--
-- TO END THE TEST: make public_test_active() return false here AND set
-- PUBLIC_TEST = false in js/public-test.js, in one commit.
--
-- Additive + idempotent. Safe to re-run. Run AFTER
-- supabase-tester-tier-migration.sql.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Columns ───────────────────────────────────────────────────
ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS persona               TEXT,
    ADD COLUMN IF NOT EXISTS org_name              TEXT,
    ADD COLUMN IF NOT EXISTS fleet_size            TEXT,
    ADD COLUMN IF NOT EXISTS tester_since          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notify_tester_updates BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS tester_reward         TEXT    NOT NULL DEFAULT 'none';

ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_persona_check;
ALTER TABLE public.user_profiles ADD  CONSTRAINT user_profiles_persona_check
    CHECK (persona IS NULL OR persona IN
        ('learner','teacher','enthusiast','analyst','operator','mission_planner'));

ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_fleet_size_check;
ALTER TABLE public.user_profiles ADD  CONSTRAINT user_profiles_fleet_size_check
    CHECK (fleet_size IS NULL OR fleet_size IN ('1','2-10','11-100','100+'));

ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_org_name_check;
ALTER TABLE public.user_profiles ADD  CONSTRAINT user_profiles_org_name_check
    CHECK (org_name IS NULL OR length(org_name) <= 120);

-- tester_reward: what a tester has EARNED through feedback, awarded by
-- an admin. 'discount' = permanent discount at launch, 'free' = keeps
-- their plan free. Applied at launch as a Stripe coupon / comp plan.
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_tester_reward_check;
ALTER TABLE public.user_profiles ADD  CONSTRAINT user_profiles_tester_reward_check
    CHECK (tester_reward IN ('none','discount','free'));


-- ── 2. The public-test switch (mirrors js/public-test.js PUBLIC_TEST) ──
CREATE OR REPLACE FUNCTION public.public_test_active()
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$ SELECT true $$;


-- ── 3. Sign-up trigger: tester plan + validated persona fields ──────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_meta    JSONB := COALESCE(NEW.raw_user_meta_data, '{}'::jsonb);
    v_first   TEXT  := NULLIF(TRIM(v_meta->>'given_name'),  '');
    v_last    TEXT  := NULLIF(TRIM(v_meta->>'family_name'), '');
    v_full    TEXT;
    v_name    TEXT;
    v_test    BOOLEAN := public.public_test_active();
    v_persona TEXT  := NULLIF(TRIM(v_meta->>'persona'), '');
    v_org     TEXT  := NULLIF(LEFT(TRIM(regexp_replace(COALESCE(v_meta->>'org_name', ''), '\s+', ' ', 'g')), 120), '');
    v_fleet   TEXT  := NULLIF(TRIM(v_meta->>'fleet_size'), '');
    v_updates BOOLEAN := lower(COALESCE(v_meta->>'tester_updates', '')) = 'true';
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

    -- Client-supplied values are re-validated here: an unknown persona
    -- or fleet bucket becomes NULL rather than failing the sign-up (a
    -- failed trigger would block account creation entirely).
    IF v_persona IS NOT NULL AND v_persona NOT IN
        ('learner','teacher','enthusiast','analyst','operator','mission_planner') THEN
        v_persona := NULL;
    END IF;
    IF v_persona IS NULL OR v_persona NOT IN ('operator','mission_planner') THEN
        v_org   := NULL;
        v_fleet := NULL;
    END IF;
    IF v_fleet IS NOT NULL AND v_fleet NOT IN ('1','2-10','11-100','100+') THEN
        v_fleet := NULL;
    END IF;

    INSERT INTO public.user_profiles
        (id, email, display_name, plan, role,
         persona, org_name, fleet_size, tester_since, notify_tester_updates)
    VALUES (
        NEW.id,
        NEW.email,
        v_name,
        CASE WHEN v_test THEN 'tester' ELSE 'free' END,  -- NEVER from v_meta
        'user',                                          -- NEVER from v_meta
        v_persona,
        v_org,
        v_fleet,
        CASE WHEN v_test THEN now() ELSE NULL END,
        v_updates
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;


-- ── 4. Testers cannot award themselves a reward ─────────────────────
-- Replays the live guard_user_profile_self_update() body (2026-10-15)
-- with tester_reward + tester_since added to the protected list.
-- persona / org_name / fleet_size / notify_tester_updates stay
-- self-editable on purpose (account settings).
CREATE OR REPLACE FUNCTION public.guard_user_profile_self_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_role TEXT;
BEGIN
    -- Trusted SECURITY DEFINER paths set this flag for the duration
    -- of the transaction. Cleared automatically at COMMIT.
    IF current_setting('pp.privileged_update', true) = '1' THEN
        RETURN NEW;
    END IF;

    -- Service-role context (no auth.uid()) bypasses entirely. The
    -- Stripe webhook runs as service_role through PostgREST.
    IF auth.uid() IS NULL THEN
        RETURN NEW;
    END IF;

    -- Admins can comp users freely.
    SELECT role INTO v_role
      FROM public.user_profiles
     WHERE id = auth.uid();
    IF v_role IN ('admin', 'superadmin') THEN
        RETURN NEW;
    END IF;

    -- Non-admins must keep these privileged columns identical across
    -- an UPDATE. Each comparison uses IS DISTINCT FROM so NULL-ish
    -- transitions count too.
    IF NEW.plan                   IS DISTINCT FROM OLD.plan                   THEN RAISE EXCEPTION 'plan_change_forbidden'        USING ERRCODE = 'check_violation'; END IF;
    IF NEW.role                   IS DISTINCT FROM OLD.role                   THEN RAISE EXCEPTION 'role_change_forbidden'        USING ERRCODE = 'check_violation'; END IF;
    IF NEW.stripe_customer_id     IS DISTINCT FROM OLD.stripe_customer_id     THEN RAISE EXCEPTION 'stripe_change_forbidden'      USING ERRCODE = 'check_violation'; END IF;
    IF NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id THEN RAISE EXCEPTION 'stripe_change_forbidden'      USING ERRCODE = 'check_violation'; END IF;
    IF NEW.stripe_price_id        IS DISTINCT FROM OLD.stripe_price_id        THEN RAISE EXCEPTION 'stripe_change_forbidden'      USING ERRCODE = 'check_violation'; END IF;
    IF NEW.subscription_status    IS DISTINCT FROM OLD.subscription_status    THEN RAISE EXCEPTION 'subscription_change_forbidden' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.subscription_period_end IS DISTINCT FROM OLD.subscription_period_end THEN RAISE EXCEPTION 'subscription_change_forbidden' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.classroom_seats        IS DISTINCT FROM OLD.classroom_seats        THEN RAISE EXCEPTION 'seats_change_forbidden'       USING ERRCODE = 'check_violation'; END IF;
    IF NEW.attribution_required   IS DISTINCT FROM OLD.attribution_required   THEN RAISE EXCEPTION 'seats_change_forbidden'       USING ERRCODE = 'check_violation'; END IF;
    IF NEW.parent_account_id      IS DISTINCT FROM OLD.parent_account_id      THEN RAISE EXCEPTION 'seats_change_forbidden'       USING ERRCODE = 'check_violation'; END IF;
    IF NEW.branding               IS DISTINCT FROM OLD.branding               THEN RAISE EXCEPTION 'branding_change_forbidden'    USING ERRCODE = 'check_violation'; END IF;
    IF NEW.tester_reward          IS DISTINCT FROM OLD.tester_reward          THEN RAISE EXCEPTION 'tester_reward_change_forbidden' USING ERRCODE = 'check_violation'; END IF;
    IF NEW.tester_since           IS DISTINCT FROM OLD.tester_since           THEN RAISE EXCEPTION 'tester_reward_change_forbidden' USING ERRCODE = 'check_violation'; END IF;

    RETURN NEW;
END;
$$;


-- ═══════════════════════════════════════════════════════════════
-- Verify:
--   SELECT public.public_test_active();                         -- true
--   SELECT pg_get_functiondef('public.handle_new_user'::regproc) ~ '->>''plan''';  -- false
--   -- Sign up with options.data = { persona:'operator', org_name:'X',
--   --   fleet_size:'2-10', plan:'enterprise', role:'admin' }, then:
--   SELECT plan, role, persona, org_name, fleet_size, tester_since IS NOT NULL
--     FROM public.user_profiles WHERE email = '<that email>';
--   -- Expect: tester, user, operator, X, 2-10, true
-- ═══════════════════════════════════════════════════════════════
