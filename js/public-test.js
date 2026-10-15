/**
 * public-test.js — the ONE copy of the public-test sign-up rules.
 *
 * PURE: no DOM, no fetch, no ambient time. Read by pricing.html,
 * signup.html and tests/public-test.mjs.
 *
 * THE MODEL (2026-10, PRICING_TESTER_PLAN in the session artifact):
 *   - The pricing page shows TWO public plans, Intro and Advanced. The six
 *     stored plan ids (free/basic/educator/advanced/institution/enterprise)
 *     are NOT changed — CLAUDE.md §6 forbids touching the plan enum without
 *     coordinating planToTier(). `planFamily()` folds them for display.
 *   - While PUBLIC_TEST is on, EVERY sign-up is a tester (plan 'tester',
 *     which planToTier() already maps to PRO = full access). The PLAN is
 *     decided by the database trigger, never by the client: the client
 *     only sends the persona fields below, and the trigger re-validates
 *     them against its own copy of PERSONA_IDS / FLEET_SIZES.
 *
 * TWO COPIES, KEPT IN LOCKSTEP (tests/public-test.mjs reads the SQL text):
 *   - PUBLIC_TEST          ↔ public.public_test_active()  in
 *                            supabase-public-test-signup-migration.sql
 *   - PERSONA_IDS          ↔ the persona CHECK + trigger whitelist there
 *   - FLEET_SIZES          ↔ the fleet_size CHECK + trigger whitelist there
 * Flip PUBLIC_TEST in BOTH places when the test ends, or the page will
 * promise "free" while the database creates 'free'-plan accounts (or the
 * reverse).
 */

/** True while the public test runs: sign-up is free and makes a tester. */
export const PUBLIC_TEST = true;

/**
 * Post-test prices, shown struck through during the test. These are the
 * live Stripe prices of the plans each family maps to (basic / advanced),
 * so the page never shows a number checkout would not charge.
 */
export const PRICES = Object.freeze({
    intro:    Object.freeze({ monthlyUsd: 9.99, yearlyUsd: 59, checkoutPlan: 'basic' }),
    advanced: Object.freeze({ monthlyUsd: 100,  yearlyUsd: null, checkoutPlan: 'advanced' }),
});

/** Who each family is for. Order is display order. */
export const PERSONAS = Object.freeze([
    Object.freeze({ id: 'learner',         label: 'Learning',         sub: 'student, self-study',  family: 'intro' }),
    Object.freeze({ id: 'teacher',         label: 'Teaching',         sub: 'class or outreach',    family: 'intro' }),
    Object.freeze({ id: 'enthusiast',      label: 'Enthusiast',       sub: 'aurora, sky, space',   family: 'intro' }),
    Object.freeze({ id: 'analyst',         label: 'Analysis',         sub: 'research, industry',   family: 'intro' }),
    Object.freeze({ id: 'operator',        label: 'Satellite ops',    sub: 'I fly spacecraft',     family: 'advanced' }),
    Object.freeze({ id: 'mission_planner', label: 'Mission planning', sub: 'launch, design',       family: 'advanced' }),
]);
export const PERSONA_IDS = Object.freeze(PERSONAS.map(p => p.id));

/** Fleet-size buckets for operator personas. */
export const FLEET_SIZES = Object.freeze(['1', '2-10', '11-100', '100+']);

/** Limits mirrored by the trigger (it truncates; the client trims first). */
export const ORG_NAME_MAX = 120;

/**
 * Fold a stored plan id into the public family it is sold as.
 * Unknown / free / tester → null (not a paid family).
 */
export function planFamily(plan) {
    switch (String(plan || '').toLowerCase()) {
        case 'basic':
        case 'educator':    return 'intro';
        case 'advanced':
        case 'institution':
        case 'enterprise':  return 'advanced';
        default:            return null;
    }
}

/** The family a persona id belongs to, or null for an unknown id. */
export function personaFamily(personaId) {
    const p = PERSONAS.find(x => x.id === personaId);
    return p ? p.family : null;
}

/** True for personas that get the operator follow-up (org, fleet, pilot). */
export function isOperatorPersona(personaId) {
    return personaFamily(personaId) === 'advanced';
}

/**
 * Read the family a visitor arrived for from sign-up URL params.
 * Accepts the new `?tier=intro|advanced` and every legacy `?plan=` link
 * (basic, basic-annual, educator, auroracle, intro, advanced, …) so old
 * marketing links keep landing on the right card.
 */
export function familyFromParams(params) {
    const get = (k) => {
        try { return String(params?.get?.(k) || '').toLowerCase().trim(); } catch { return ''; }
    };
    const tier = get('tier');
    if (tier === 'intro' || tier === 'advanced') return tier;
    const plan = get('plan').replace(/-(annual|yearly)$/, '');
    if (plan === 'intro' || plan === 'auroracle') return 'intro';
    return planFamily(plan);
}

/**
 * Whitelist the persona fields a sign-up sends as Supabase user metadata.
 * Everything else is dropped — in particular `plan` and `role`, which the
 * trigger ignores anyway (defence in depth: never even send them).
 * Returns a NEW object containing only valid keys.
 */
export function normalizeSignupMeta(input = {}) {
    const out = {};
    const persona = String(input.persona || '');
    if (PERSONA_IDS.includes(persona)) out.persona = persona;

    if (out.persona && isOperatorPersona(out.persona)) {
        const org = String(input.org_name || '').replace(/\s+/g, ' ').trim().slice(0, ORG_NAME_MAX);
        if (org) out.org_name = org;
        const fleet = String(input.fleet_size || '');
        if (FLEET_SIZES.includes(fleet)) out.fleet_size = fleet;
    }

    out.tester_updates = input.tester_updates === true;
    return out;
}

/** "$9.99/mo" style label for a family's monthly price. */
export function monthlyLabel(family) {
    const p = PRICES[family];
    if (!p) return '';
    const n = Number.isInteger(p.monthlyUsd) ? String(p.monthlyUsd) : p.monthlyUsd.toFixed(2);
    return `$${n}/mo`;
}
