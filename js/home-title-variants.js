/**
 * home-title-variants.js — the homepage launchpad's headline copy, per variant
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE data. The experiment is `home_title_v2` in js/experiments.js (ids here
 * must match its variants — tests/home-launchpad.mjs gates both directions).
 * index.html's inline title script applies one of these to #hero's <h1> and
 * sub line; `control` is ALSO the static markup, so a visitor with no
 * JavaScript, or in the control arm, sees exactly the static line.
 *
 * v2 (2026-11-25, owner: "the title is terrible"): `home_title` tested the old
 * 2026-07 line "Watch space weather happen. Live." — a dashboard slogan on a
 * page that is now a door into simulations — against two abstract challengers
 * ("From Earth's core to the cosmic web", "the working universe"). All three
 * were retired unconcluded; v2 is a new experiment id so no exposure from the
 * old copy is ever charted against the new. Every v2 line says what you can
 * DO in the first minute, with things the page can show.
 *
 *   a    the headline's first line
 *   b    the second, accented line (kept short — it is the punch)
 *   sub  one sentence under it. `{n}` becomes the live simulation count.
 *
 * Copy rules (CLAUDE.md §7): physics-first, name real things the site runs,
 * no "AI-powered" framing, and nothing a page cannot back up — every noun in
 * these lines is a page in js/simulations-catalog.js.
 */
export const TITLE_EXPERIMENT = 'home_title_v2';

export const TITLE_VARIANTS = Object.freeze({
    control: {
        a: 'Explore the universe',
        b: 'as it is right now.',
        sub: 'Fly over Mars, watch today’s Sun erupt, follow a solar storm out to Earth — <em>{n} simulations running on live NASA and NOAA data</em>. Free, in your browser.',
    },
    verbs: {
        a: 'Fly to Mars. Chase a solar storm.',
        b: 'Free, right now.',
        sub: 'Drop to the floor of Jezero Crater, scrub a CME’s path to Earth, look up at tonight’s sky — <em>{n} live simulations on real NASA and NOAA data</em>, no download.',
    },
    real: {
        a: 'The real Sun, Earth and Mars,',
        b: 'running live.',
        sub: 'Not renders, not videos: <em>{n} physics simulations fed by NASA and NOAA every few minutes</em>. Open one and steer it — free, in your browser.',
    },
});

/** Copy for a variant id; anything unknown is `control`. */
export function titleFor(variant, count) {
    const v = TITLE_VARIANTS[variant] || TITLE_VARIANTS.control;
    const n = Number.isFinite(count) && count > 0 ? String(count) : 'dozens of';
    return { a: v.a, b: v.b, sub: v.sub.replace('{n}', n) };
}
