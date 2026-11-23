/**
 * home-title-variants.js — the homepage launchpad's headline copy, per variant
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE data. The experiment is `home_title` in js/experiments.js (ids here
 * must match its variants — tests/home-launchpad.mjs gates both directions).
 * index.html's inline title script applies one of these to #hero's <h1> and
 * sub line; `control` is ALSO the static markup, so a visitor with no
 * JavaScript, or in the control arm, sees the 2026-07 experiment winner
 * exactly as before.
 *
 *   a    the headline's first line
 *   b    the second, accented line (kept short — it is the punch)
 *   sub  one sentence under it. `{n}` becomes the live simulation count.
 *
 * Copy rules (CLAUDE.md §7): physics-first, name real things the site runs,
 * no "AI-powered" framing, and nothing a page cannot back up — every noun in
 * these lines is a page in js/simulations-catalog.js.
 */
export const TITLE_EXPERIMENT = 'home_title';

export const TITLE_VARIANTS = Object.freeze({
    control: {
        a: 'Watch space weather happen.',
        b: 'Live.',
        sub: 'Fly down to Mars, follow a solar storm to Earth, scrub tomorrow’s weather on a live globe — <em>real NASA and NOAA data, free to explore</em>.',
    },
    scale: {
        a: 'From Earth’s core to the cosmic web.',
        b: 'Running live.',
        sub: 'Earthquakes crossing the planet, the Sun as it is right now, the pull of the Boötes Void — <em>{n} physics simulations on real NASA and NOAA data</em>, newest builds first.',
    },
    universe: {
        a: 'Step inside the working universe.',
        b: 'Every model live.',
        sub: 'Not videos — <em>{n} running models on live NASA and NOAA data</em>, each one named, sourced and open to inspect. Start with the newest builds.',
    },
});

/** Copy for a variant id; anything unknown is `control`. */
export function titleFor(variant, count) {
    const v = TITLE_VARIANTS[variant] || TITLE_VARIANTS.control;
    const n = Number.isFinite(count) && count > 0 ? String(count) : 'dozens of';
    return { a: v.a, b: v.b, sub: v.sub.replace('{n}', n) };
}
