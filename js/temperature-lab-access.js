/**
 * temperature-lab-access.js — who sees how much of the Planetary Temperature
 * Lab (PLANETARY_TEMPERATURE_LAB_PLAN.md §7). The AurOracle ladder, three
 * rungs:
 *
 *   'teaser'  signed out             top 3 per card, 3-day outlook
 *   'free'    a free account         top 10 + land/ocean/region filters,
 *             (or a provisional one) 7-day outlook
 *   'intro'   tierLevel ≥ 2          top 25 + the 30-day calendar
 *             (basic, educator, advanced+, tester, admin)
 *
 * EVERYTHING THAT OBSERVES THE PRESENT IS FREE; what predicts or analyses in
 * depth is Intro. The planet strip and the maps are on every rung.
 *
 * Gating is CLIENT-SIDE on purpose (§7.4, D8): the data is public analysis,
 * the snapshot already carries the top 25, and the routes are cached, so a
 * bypass costs no upstream budget. This module only decides what to SHOW.
 *
 * Kept free of auth.js / gate-modal.js imports so node can test it: the page
 * injects `auth` and `hasProvisional` into createAccessController.
 */

import { tierLevel } from './tier-config.js';

export const ACCESS_LEVELS = Object.freeze(['teaser', 'free', 'intro']);

export const LIMITS = Object.freeze({
    teaser: Object.freeze({ rows: 3,  filters: false, outlookDays: 3, calendar: false }),
    free:   Object.freeze({ rows: 10, filters: true,  outlookDays: 7, calendar: false }),
    intro:  Object.freeze({ rows: 25, filters: true,  outlookDays: 7, calendar: true }),
});

/**
 * @param {{signedIn: boolean, plan?: string, role?: string, provisional?: boolean}} who
 * @returns {'teaser'|'free'|'intro'}
 */
export function accessFor({ signedIn, plan, role, provisional = false }) {
    if (!signedIn) return provisional ? 'free' : 'teaser';
    return tierLevel(plan, role) >= 2 ? 'intro' : 'free';
}

/** The body classes for a rung: exactly one of tl-teaser / tl-free / tl-intro. */
export function classesFor(access) {
    return Object.fromEntries(ACCESS_LEVELS.map(a => [`tl-${a}`, a === access]));
}

/**
 * The gate a locked control opens, chosen by where the visitor sits on the
 * ladder, not by which control they clicked (the AurOracle rule): a teaser
 * is one free account away from the next rung, a free account one Intro away.
 * @param {'teaser'|'free'|'intro'} access
 * @param {'rows'|'filters'|'outlook'|'calendar'} want
 * @returns {string|null} a GATE_VARIANTS key, or null when nothing is locked
 */
export function gateFor(access, want) {
    if (access === 'intro') return null;
    if (want === 'calendar') return 'temp-lab-outlook-30day';
    if (access === 'teaser') return want === 'outlook' ? 'temp-lab-outlook-week' : 'temp-lab-scorecards';
    return null;   // a free account already has rows / filters / the week
}

/**
 * Wire the ladder to the page. `auth` is js/auth.js's singleton (or a fake
 * in tests); `hasProvisional` is gate-modal.js's; `target` gets the classes.
 * Calls `onChange(access, limits)` once on start and again on every real
 * change (sign-in, sign-out, plan change) — never on a no-op auth-changed.
 */
export function createAccessController({ auth, hasProvisional = () => false, target, onChange = () => {} }) {
    let current = null;
    const read = () => {
        try {
            return accessFor({
                signedIn: !!auth?.isSignedIn?.(),
                plan: auth?.getPlan?.(), role: auth?.getRole?.(),
                provisional: !!hasProvisional(),
            });
        } catch (_) { return hasProvisional() ? 'free' : 'teaser'; }
    };
    const apply = (next) => {
        if (next === current) return false;
        current = next;
        if (target?.classList) for (const [cls, on] of Object.entries(classesFor(next))) target.classList.toggle(cls, on);
        onChange(next, LIMITS[next]);
        return true;
    };
    return {
        get access() { return current; },
        get limits() { return LIMITS[current ?? 'teaser']; },
        /** Re-read auth; true when the rung changed. */
        refresh: () => apply(read()),
        /** Promote optimistically after a free-gate email submit. */
        unlockFree: () => apply(current === 'intro' ? 'intro' : 'free'),
    };
}
