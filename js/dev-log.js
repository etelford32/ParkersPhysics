/**
 * dev-log.js — the ONE record of what shipped, sprint by sprint
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE data + helpers. No DOM, no fetch, no ambient time (every function that
 * needs "now" takes it as an argument). Consumed by:
 *
 *   - recent-development.html     the public "Recent Development" page
 *                                 (js/recent-development.js renders it)
 *   - feedback.html               its "Recent changes" panel shows the newest
 *                                 few entries from here
 *   - scripts/dev-log-draft.mjs   lists merged PRs that are NOT logged yet and
 *                                 prints a stub entry for each
 *   - tests/dev-log.mjs           structural gate
 *
 * WHY THIS EXISTS
 * ───────────────
 * feedback.html carried a hand-written "Devlog" panel. Its last entry is
 * 2026-05-06; about sixty sprints of simulations, data sets and layers shipped
 * after it and none reached it. Nothing errored — a stale changelog looks
 * exactly like a quiet project. So the log is now data, it is rendered on two
 * pages from one copy, and `node scripts/dev-log-draft.mjs` turns `git log`
 * into the list of PRs still waiting for an entry. Shipping a sprint now ends
 * with: run the draft script, edit the stubs into entries, run the gate.
 *
 * ADDING AN ENTRY (after a PR merges)
 * ───────────────────────────────────
 *   1. `node scripts/dev-log-draft.mjs` — prints a stub per unlogged PR.
 *   2. Paste the stub at the TOP of DEV_LOG (newest first) and write it for a
 *      VISITOR: what can they now open, see, or trust that they could not
 *      before. Physics-first — name the model, the data, the event. No
 *      "AI-powered" copy (CLAUDE.md §7). Do not paste the PR title; PR titles
 *      are written for reviewers.
 *   3. A PR with nothing a visitor can see (test plumbing, a plan document)
 *      goes in UNLOGGED_PRS with a reason instead, so the draft script stops
 *      reporting it.
 *   4. If the date falls after the open sprint's window, close that sprint
 *      (give it an `end`) and open the next one in SPRINTS.
 *   5. `node tests/dev-log.mjs`.
 *
 * Field reference — DEV_LOG entries
 *   id         stable kebab-case anchor (recent-development.html#<id>)
 *   date       'YYYY-MM-DD' — the day it reached production (merge date)
 *   pr         GitHub PR number in etelford32/ParkersPhysics, or null
 *   title      short headline, sentence case, no trailing period
 *   kind       one of KINDS (what sort of change it is)
 *   section    a js/site-sections.js id, or 'platform' for account / ops /
 *              legal work that belongs to no physics section
 *   icon       a js/glyphs.js glyph id
 *   summary    one or two sentences, ends with a period — the only body copy
 *              on the collapsed card
 *   highlights optional bullets shown when the card is expanded
 *   links      [{ href, label? }] — where to go to see it. `href` is a root
 *              page (optionally with ?query / #hash). `label` may be omitted
 *              for catalogued simulations; it is then the catalog title.
 */

import { SITE_SECTIONS } from './site-sections.js';
import { SIMULATIONS } from './simulations-catalog.js';

export const REPO_URL = 'https://github.com/etelford32/ParkersPhysics';

/** What sort of change an entry is. Order = chip order on the page. */
export const KINDS = [
    { id: 'simulation',  label: 'New simulation', short: 'Simulation',
      note: 'A new page or lab you can open.' },
    { id: 'layer',       label: 'New layer / feature', short: 'Layer',
      note: 'Something new inside a simulation that already existed.' },
    { id: 'dataset',     label: 'Data set / feed', short: 'Data',
      note: 'A new catalogue, live feed, or validation record behind the pages.' },
    { id: 'improvement', label: 'Improvement', short: 'Improvement',
      note: 'Visuals, speed, controls, layout.' },
    { id: 'fix',         label: 'Correctness fix', short: 'Fix',
      note: 'Something that was wrong and is now right — and what it was.' },
    { id: 'platform',    label: 'Platform', short: 'Platform',
      note: 'Accounts, pricing, infrastructure, policy.' },
];
export const KIND_IDS = KINDS.map(k => k.id);

/** Sections an entry can belong to: the five site sections + 'platform'. */
export const LOG_SECTIONS = [
    ...SITE_SECTIONS.map(({ id, label }) => ({ id, label })),
    { id: 'platform', label: 'Platform' },
];
export const LOG_SECTION_IDS = LOG_SECTIONS.map(s => s.id);

/**
 * Sprints, newest first. An entry belongs to the sprint whose [start, end]
 * window holds its date (inclusive). The newest sprint may be OPEN
 * (`end: null`) — the page labels it "in progress". Windows must not overlap.
 */
export const SPRINTS = [
    { id: '2026-11-solar-system', start: '2026-11-03', end: null,
      label: 'Solar system, the Moon, and Earth hazards',
      goal: 'Put real ephemerides under every body on the site, give the Moon a measured interior and exosphere, '
          + 'and open an Earth-hazards lab — while moving bulk data out of the database.' },
    { id: '2026-10-earthview', start: '2026-10-26', end: '2026-11-02',
      label: 'EarthView dial-in',
      goal: 'Restore the live weather data EarthView had silently lost, light the globe physically, '
          + 'and make the time scrubber fast enough to drag.' },
    { id: '2026-10-forecast-loops', start: '2026-10-14', end: '2026-10-25',
      label: 'Forecast loops and deep space',
      goal: 'Close the loop on CME forecasting with an eruption outlook, and deepen the deep-space labs '
          + '(Boötes Void dynamics, Star Collider rendering).' },
    { id: '2026-10-builders', start: '2026-10-05', end: '2026-10-13',
      label: 'Builders, the sky, and the data plumbing',
      goal: 'Ship the design-and-fly tools and a live sky chart, and repair the DONKI feed after NASA moved it.' },
    { id: '2026-09-hero-earth', start: '2026-09-20', end: '2026-10-04',
      label: 'The real Earth on the homepage',
      goal: 'Replace the illustrative homepage globe with today\'s Earth and aurora, make Mars explorable, '
          + 'and give the upper atmosphere a flight model.' },
];

/** PRs deliberately left out of the public log (nothing a visitor can see). */
export const UNLOGGED_PRS = {
    1058: 'test-harness plumbing (import resolution)',
    1053: 'plan document only (EARTHVIEW_LOD_UX_PLAN.md)',
    1030: 'test hardening only',
    1021: 'plan document + measured spike only (PRESSURE_OUTLOOK_ENGINE_PLAN.md)',
    1042: 'folded into the flux-rope-ledger entry (#1043) — one change, two PRs',
    1035: 'folded into the legal-refresh entry (#1037)',
    1034: 'folded into the legal-refresh entry (#1037)',
};

// ── The log — newest first ──────────────────────────────────────────────────
export const DEV_LOG = [
    // ══ Sprint: Solar system, the Moon, and Earth hazards ═══════════════════
    { id: 'earth-volcanoes', date: '2026-11-04', pr: 1068,
      title: 'Earth Volcanoes lab', kind: 'simulation', section: 'earth-orbit', icon: 'volcano',
      summary: 'All 2,661 Smithsonian GVP volcanoes on one page and as an EarthView layer, with live eruption status '
             + 'from USGS and NASA EONET, eruption odds, and a Monte-Carlo of volcanic climate forcing.',
      highlights: [
          'Status is a rule on the record — erupting, recent, historical, dormant, unconfirmed, inactive — never a guess.',
          'Eruption odds are an empirical-Bayes onset rate fitted over every Holocene volcano, including the quiet ones.',
          'A VEI-to-climate consequence calculator: Pinatubo through it gives −3.05 W m⁻² and −0.34 K.',
          'If a live feed is down the page says "live status unavailable" — never a quiet planet.',
      ],
      links: [{ href: 'volcanoes.html' }, { href: 'earth.html', label: 'EarthView · Volcanoes layer' }] },
    { id: 'supabase-r2-offload', date: '2026-11-03', pr: 1067,
      title: 'Bulk weather and geomagnetic history moved to object storage', kind: 'platform', section: 'platform',
      icon: 'engine',
      summary: 'Weather frames and sealed days of geomagnetic minute data are archived to R2, and the hourly '
             + 'temperature-extremes pass now runs in 0.04 s instead of 31–36 s.',
      links: [{ href: 'status.html', label: 'System status' }] },
    { id: 'moon-live', date: '2026-11-03', pr: 1066,
      title: 'The Moon, lit by today\'s Sun', kind: 'layer', section: 'local-space', icon: 'moon',
      summary: 'The Moon page now runs on a live lunar ephemeris — phase, libration and terminator are today\'s — and gains '
             + 'a stagnant-lid mantle, a Monte-Carlo exosphere, and a Neukum crater field.',
      highlights: [
          'Phase, synodic age and distance in the HUD come from the same geometry that draws the terminator.',
          '"Earth\'s view" puts the camera where you are standing tonight.',
          'The interior reproduces the measured moment of inertia (0.3930 vs 0.3931).',
          'Exosphere atoms hop, escape, photoionise and cold-trap — argon piles up before dawn, as observed.',
          'Proposed colony sites and Earth-launch windows link straight into the Mission Planner.',
      ],
      links: [{ href: 'moon.html' }, { href: 'colony.html' }, { href: 'mission-planner.html' }] },
    { id: 'hero-sun-neo-board', date: '2026-11-03', pr: 1065,
      title: 'Homepage Sun: flares, prominences, EUV waves — and the ten nearest NEOs', kind: 'improvement',
      section: 'space-weather', icon: 'sun',
      summary: 'Flares on the homepage Sun now release a field-aligned flow and launch EUV waves, prominences come from '
             + 'observed filament detections, and a new board lists the ten nearest near-Earth objects right now.',
      highlights: [
          'Every visual exaggeration on the Sun is printed in its legend.',
          'The NEO board uses the same catalogue and propagator as the orrery and Near-Earth Watch.',
      ],
      links: [{ href: 'index.html', label: 'Homepage' }] },
    { id: 'jupiter-trojans', date: '2026-11-03', pr: 1064,
      title: 'Jupiter Trojan population and proper elements', kind: 'dataset', section: 'local-space',
      icon: 'solar-system',
      summary: 'A catalogue of Jupiter\'s Trojan asteroids integrated under the Sun, Jupiter and Saturn, with '
             + 'frequency-analysed proper elements validated against AstDyS.',
      links: [{ href: 'solar-system.html' }] },
    { id: 'neo-watch-gravity', date: '2026-11-03', pr: 1063,
      title: 'Earth–Moon gravity layer on Near-Earth Watch', kind: 'layer', section: 'earth-orbit', icon: 'gravity',
      summary: 'Lagrange points, Jacobi constants and a zero-velocity map in the live Earth–Moon frame, plus an '
             + 'acceleration budget for every tracked object.',
      links: [{ href: 'neo-watch.html' }] },
    { id: 'horizons-frame-fix', date: '2026-11-03', pr: 1062,
      title: 'Live JPL Horizons positions actually load now', kind: 'fix', section: 'local-space', icon: 'planet',
      summary: 'Every Horizons query had used a parameter the API rejects, so the orrery and space-weather pages '
             + 'had always fallen back to analytic positions. They now get the real ephemeris.',
      links: [{ href: 'solar-system.html' }, { href: 'space-weather.html' }] },
    { id: 'space-missions', date: '2026-11-03', pr: 1061,
      title: 'Space Missions: the live fleet map', kind: 'simulation', section: 'local-space', icon: 'probe',
      summary: 'Every active mission drawn from the best source available — JPL Horizons state vectors, then SGP4, '
             + 'then a labelled model — with upcoming launches and recent rocket bodies alongside.',
      highlights: [
          'Each marker says which source placed it.',
          'L1 sentinels are visible for the first time — they used to sit inside the drawn Earth.',
      ],
      links: [{ href: 'missions.html' }] },

    // ══ Sprint: EarthView dial-in ═══════════════════════════════════════════
    { id: 'launch-planner-night-pad', date: '2026-11-01', pr: 1059,
      title: 'Launch Planner: a floodlit night pad', kind: 'improvement', section: 'earth-orbit', icon: 'rocket',
      summary: 'The 3D vehicle view is now a floodlit night launch pad with simulated exhaust and deluge steam, '
             + 'bloom, and a camera that adapts to your screen shape.',
      links: [{ href: 'launch-planner.html' }] },
    { id: 'weather-time-engine', date: '2026-11-01', pr: 1057,
      title: 'EarthView time scrubber: meteogram strip and smooth scrubbing', kind: 'layer', section: 'earth-orbit',
      icon: 'hourglass',
      summary: 'A meteogram strip under the time slider with event markers, loop playback, and isobar contouring '
             + 'moved off the main thread — a scrub repaint went from 68 ms to 7 ms.',
      links: [{ href: 'earth.html' }] },
    { id: 'earthview-physical-light', date: '2026-10-30', pr: 1056,
      title: 'EarthView: a physically lit globe and regional detail', kind: 'improvement', section: 'earth-orbit',
      icon: 'earth',
      summary: 'Sunlight now reddens through the real atmospheric path, the night side is dark, oceans glint with '
             + 'the live wind, and zooming into a region streams 2 km satellite cloud imagery.',
      highlights: [
          'Fixed: hovering or double-clicking the globe used to pick the point on the opposite side of the Earth.',
          '"Go to a region" and shareable ?region= links.',
      ],
      links: [{ href: 'earth.html' }] },
    { id: 'wind-palette', date: '2026-10-27', pr: 1055,
      title: 'Wind colour: one palette across every altitude', kind: 'improvement', section: 'earth-orbit',
      icon: 'wind',
      summary: 'Brighter means faster and deeper means lower, on the globe and in every legend alike; dense wind '
             + 'no longer washes out to white.',
      links: [{ href: 'earth.html' }] },
    { id: 'earthview-data-restored', date: '2026-10-27', pr: 1054,
      title: 'EarthView\'s live weather data is back', kind: 'fix', section: 'earth-orbit', icon: 'earth',
      summary: 'The primary weather feed had been rejecting our requests for a month and every frame was a coarse '
             + 'fallback. Requests are now sized correctly, pressure is sea-level throughout, and stale data shows '
             + 'an amber marker.',
      links: [{ href: 'earth.html' }, { href: 'status.html', label: 'System status' }] },

    // ══ Sprint: Forecast loops and deep space ═══════════════════════════════
    { id: 'star-collider-hd', date: '2026-10-25', pr: 1052,
      title: 'Star Collider: gas drawn as kernels, HDR bloom', kind: 'improvement', section: 'deep-space',
      icon: 'collider',
      summary: 'Merger gas is now rendered as the SPH kernels themselves, with HDR bloom and new velocity, '
             + 'compression, mixing and shock views read straight from the engine.',
      links: [{ href: 'star-collider.html' }] },
    { id: 'verdict-day-view', date: '2026-10-25', pr: 1051,
      title: 'EarthView: tap a weekday for the whole day', kind: 'layer', section: 'earth-orbit', icon: 'chart',
      summary: 'The verdict card\'s week strip opens a full-screen day view: hour-by-hour conditions, dayparts, '
             + 'and that night\'s sky and aurora odds.',
      links: [{ href: 'earth.html' }] },
    { id: 'orrery-ephemeris', date: '2026-10-20', pr: 1050,
      title: 'Orrery planets placed from the ephemeris', kind: 'fix', section: 'local-space', icon: 'solar-system',
      summary: 'Planets were placed on circles that were only right at page load — Mercury drifted 41° in a month. '
             + 'They now sit on their real ellipses at the simulation date.',
      links: [{ href: 'solar-system.html' }] },
    { id: 'public-test-signup', date: '2026-10-15', pr: 1049,
      title: 'Public test sign-up and two-plan pricing', kind: 'platform', section: 'platform', icon: 'target',
      summary: 'Sign-up is open for testers, with simplified pricing and routing by what you came to do.',
      links: [{ href: 'pricing.html', label: 'Pricing' }, { href: 'signup.html', label: 'Sign up' }] },
    { id: 'decay-time-varying', date: '2026-10-15', pr: 1048,
      title: 'Orbital decay with time-varying solar drivers', kind: 'layer', section: 'earth-orbit',
      icon: 'operations',
      summary: 'Decay forecasts now step through a day-by-day F10.7 and Ap schedule instead of holding today\'s '
             + 'values constant for the whole lifetime.',
      links: [{ href: 'operations.html' }] },
    { id: 'fleet-assessment', date: '2026-10-15', pr: 1047,
      title: 'Storm-Season Fleet Assessment', kind: 'simulation', section: 'platform', icon: 'satellite',
      summary: 'A sample assessment for satellite operators, with an interactive simulator of drag exposure '
             + 'across a storm season.',
      links: [{ href: 'sample-fleet-assessment.html', label: 'Sample Fleet Assessment' }] },
    { id: 'cme-outlook', date: '2026-10-15', pr: 1046,
      title: 'CME Outlook: seven-day eruption probability', kind: 'layer', section: 'space-weather', icon: 'flux-rope',
      summary: 'The chance of an Earth-arriving CME on each of the next seven days, from eruptions that have not '
             + 'happened yet — each visible region\'s flare odds flown through the flux-rope engine.',
      highlights: [
          'Days three and beyond are lower bounds, and say so.',
          'Scored daily against what actually arrives.',
      ],
      links: [{ href: 'cme-forecast.html' }] },
    { id: 'tiga-geospace', date: '2026-10-14', pr: 1045,
      title: 'TIGA: Sun and Moon geospace layer', kind: 'layer', section: 'space-weather', icon: 'dynamo',
      summary: 'The magnetopause and bow shock drawn on the live L1 solar wind, with the Moon\'s monthly passage '
             + 'through Earth\'s magnetotail.',
      links: [{ href: 'tiga.html' }] },

    // ══ Sprint: Builders, the sky, and the data plumbing ════════════════════
    { id: 'bootes-dynamics', date: '2026-10-12', pr: 1044,
      title: 'Boötes Void: galaxy tracker, N-body forecast, force probe', kind: 'layer', section: 'deep-space',
      icon: 'void',
      summary: 'Probe the void\'s gravity at any point, follow its galaxies through cosmic time, and run a '
             + '35,000-particle N-body forecast and reconstruction in your browser.',
      links: [{ href: 'bootes-void.html' }] },
    { id: 'flux-rope-ledger', date: '2026-10-11', pr: 1043,
      title: 'Flux-rope forecasts scored on real arrivals', kind: 'dataset', section: 'research', icon: 'chart',
      summary: 'The daily CME forecast ledger is scored only on forecasts locked before each shock arrived, '
             + 'against real L1 data — the published skill numbers are now an honest record.',
      links: [{ href: 'cme-forecast.html' }, { href: 'flux-rope-live.html' }] },
    { id: 'stage-rebuild', date: '2026-10-11', pr: 1040,
      title: 'Upper Atmosphere: a stage you can arrange', kind: 'improvement', section: 'earth-orbit',
      icon: 'atmosphere',
      summary: 'Every panel over the 3D view is a movable, resizable window, and operational altitude bands '
             + '(VLEO, station, constellation, SSO) are drawn as a ruler you can click.',
      links: [{ href: 'upper-atmosphere.html' }] },
    { id: 'donki-host-move', date: '2026-10-11', pr: 1039,
      title: 'CME data restored after NASA moved DONKI', kind: 'fix', section: 'space-weather', icon: 'flux-rope',
      summary: 'NASA moved its DONKI service and the old addresses began returning a web page instead of data. '
             + 'All CME, flare and notification feeds now use the new host with a fallback.',
      links: [{ href: 'flux-rope-live.html' }, { href: 'space-weather.html' }] },
    { id: 'neo-sizing', date: '2026-10-11', pr: 1038,
      title: 'Near-Earth objects drawn at their real size', kind: 'improvement', section: 'local-space',
      icon: 'solar-system',
      summary: 'Asteroids are lit and sized from published photometry, become 3D rocks when they resolve on '
             + 'screen, and meteor showers are drawn as parallel streaks.',
      links: [{ href: 'solar-system.html' }] },
    { id: 'donki-notification-text', date: '2026-10-11', pr: 1041,
      title: 'Space-weather notifications show NASA\'s real text', kind: 'fix', section: 'space-weather',
      icon: 'space-weather',
      summary: 'DONKI notifications were sometimes rendered as a bare "##" heading. They now show the message '
             + 'NASA actually published, or nothing at all.',
      links: [{ href: 'space-weather.html' }] },
    { id: 'legal-refresh', date: '2026-10-11', pr: 1037,
      title: 'Privacy Policy v3.0, Terms v1.3, and a DPA', kind: 'platform', section: 'platform', icon: 'paper',
      summary: 'Updated privacy and terms pages covering location, analytics and retention, plus a Data '
             + 'Processing Agreement for organisations.',
      links: [{ href: 'privacy.html', label: 'Privacy Policy' }, { href: 'eula.html', label: 'Terms of Service' },
              { href: 'dpa.html', label: 'Data Processing Agreement' }] },
    { id: 'orrery-deselect', date: '2026-10-11', pr: 1036,
      title: 'Orrery: let go of a locked body', kind: 'improvement', section: 'local-space', icon: 'solar-system',
      summary: 'A clear way to deselect a planet, moon or asteroid and return to the free camera, with panels '
             + 'that no longer misjudge their own size.',
      links: [{ href: 'solar-system.html' }] },
    { id: 'spaceship-true-scale', date: '2026-10-06', pr: 1033,
      title: 'Space Ship Designer: real-size engines and a guided ascent', kind: 'improvement',
      section: 'earth-orbit', icon: 'rocket',
      summary: 'Engines are built at their published sizes, each design flies its own optimised two-burn ascent '
             + 'at true scale with winds aloft, and the result card charts the climb.',
      links: [{ href: 'spaceship-designer.html' }] },
    { id: 'temperature-lab-normals', date: '2026-10-05', pr: 1032,
      title: 'Planetary Temperature Lab: 1991–2020 normals', kind: 'dataset', section: 'earth-orbit',
      icon: 'chart',
      summary: 'Climate normals for every grid cell, so "unusually hot" can be measured against the calendar '
             + 'rather than against last month.',
      links: [{ href: 'status.html', label: 'System status' }] },
    { id: 'skyview', date: '2026-10-05', pr: 1031,
      title: 'SkyView: your sky, right now', kind: 'simulation', section: 'local-space', icon: 'sky-dome',
      summary: 'A real-time sky chart for your location that ranks the ten things you can actually see tonight, '
             + 'with a 30-night forecast of the best nights.',
      links: [{ href: 'skyview.html' }] },
    { id: 'satellite-designer', date: '2026-10-05', pr: 1029,
      title: 'Satellite Designer: build a spacecraft that closes', kind: 'simulation', section: 'earth-orbit',
      icon: 'satellite',
      summary: 'Pick a bus and subsystems from a component library, see them placed in 3D, and get an engineering '
             + 'review of mass, power, thermal and drag budgets.',
      links: [{ href: 'satellite-designer.html' }] },
    { id: 'satellite-suites', date: '2026-10-05', pr: 1028,
      title: 'Upper Atmosphere: satellite suites and orbit rings', kind: 'layer', section: 'earth-orbit',
      icon: 'satellite',
      summary: 'Toggle families of real satellites with their orbit rings and an altitude ladder, on the same '
             + 'clock as the atmosphere.',
      links: [{ href: 'upper-atmosphere.html' }] },

    // ══ Sprint: The real Earth on the homepage ══════════════════════════════
    { id: 'upper-atmosphere-camera-cme', date: '2026-09-30', pr: 1027,
      title: 'Upper Atmosphere: camera rig and incoming CMEs', kind: 'layer', section: 'earth-orbit',
      icon: 'atmosphere',
      summary: 'Pan, swivel, change lens and frame any layer edge-on from the limb — and watch an incoming CME\'s '
             + 'flux rope approach Earth.',
      links: [{ href: 'upper-atmosphere.html' }] },
    { id: 'upper-atmosphere-flight', date: '2026-09-29', pr: 1026,
      title: 'Upper Atmosphere: fly through the thermosphere', kind: 'layer', section: 'earth-orbit',
      icon: 'atmosphere',
      summary: 'A flight-dynamics layer with gravity, J2 and drag against the rotating air, and one consistent '
             + 'Earth-fixed frame for the Sun, bulge and satellites.',
      links: [{ href: 'upper-atmosphere.html' }] },
    { id: 'mars-firefox', date: '2026-09-27', pr: 1025,
      title: 'Mars 3D now runs in Firefox', kind: 'fix', section: 'local-space', icon: 'planet',
      summary: 'A script-ordering bug had stopped the Mars 3D engine starting in Firefox for seven weeks.',
      links: [{ href: 'mars.html' }] },
    { id: 'mars-explorable', date: '2026-09-26', pr: 1024,
      title: 'Mars: an explorable map, and the right season', kind: 'improvement', section: 'local-space',
      icon: 'planet',
      summary: 'A searchable feature index, a top-down map view, zoom-through to the surface, and a season '
             + 'computed correctly from JPL.',
      links: [{ href: 'mars.html' }] },
    { id: 'climate-lab', date: '2026-09-25', pr: 1023,
      title: 'Climate Lab dashboard', kind: 'simulation', section: 'platform', icon: 'chart',
      summary: 'Your account dashboard is now an instrument bench: a home weather station, meteogram, alert '
             + 'console and satellite pass tracker.',
      links: [{ href: 'dashboard.html', label: 'Dashboard' }] },
    { id: 'hero-next-24h', date: '2026-09-24', pr: 1022,
      title: 'Homepage: the Sun\'s next 24 hours', kind: 'layer', section: 'space-weather', icon: 'sun',
      summary: 'The homepage opens on today\'s Sun — real NOAA active regions — and plays the next 24 hours of '
             + 'CMEs through the flux-rope engine.',
      links: [{ href: 'index.html', label: 'Homepage' }] },
    { id: 'hero-real-earth', date: '2026-09-23', pr: 1020,
      title: 'Homepage: today\'s Earth and NOAA\'s aurora', kind: 'improvement', section: 'space-weather',
      icon: 'aurora',
      summary: 'The homepage globe is NASA imagery turned to today\'s sunlight and season, with the live OVATION '
             + 'aurora oval on the real magnetic dipole.',
      links: [{ href: 'index.html', label: 'Homepage' }] },
    { id: 'cloud-time-aware', date: '2026-09-23', pr: 1019,
      title: 'EarthView clouds follow the clock', kind: 'layer', section: 'earth-orbit', icon: 'earth',
      summary: 'Scrubbing time now shows archived satellite cloud frames for that moment, a wind-advected '
             + 'nowcast just ahead, and model-only clouds further out.',
      links: [{ href: 'earth.html' }] },
    { id: 'temp-outlook', date: '2026-09-21', pr: 1018,
      title: 'Homepage 30-day temperature outlook', kind: 'layer', section: 'earth-orbit', icon: 'chart',
      summary: 'A daily-candle temperature chart and a 30-day calendar for your location, relaxing from the '
             + 'forecast toward the local normal.',
      links: [{ href: 'index.html', label: 'Homepage' }] },
];

// ── Helpers (PURE) ──────────────────────────────────────────────────────────

const DAY_MS = 86400000;

/** 'YYYY-MM-DD' → UTC midnight ms, or NaN. */
export function dateMs(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return NaN;
    const t = Date.parse(iso + 'T00:00:00Z');
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === iso ? t : NaN;
}

/** Display label for a link: explicit, else the catalog title, else null. */
export function linkLabel(link) {
    if (link.label) return link.label;
    const page = link.href.split(/[?#]/)[0];
    const sim = SIMULATIONS.find(s => s.href === page);
    return sim ? sim.title : null;
}

/** The sprint whose window holds `iso`, or null. */
export function sprintFor(iso, sprints = SPRINTS) {
    const t = dateMs(iso);
    return sprints.find(s => t >= dateMs(s.start) && (s.end == null || t <= dateMs(s.end))) || null;
}

/** Does `entry` match a filter { kind, section, q }? Empty fields match all. */
export function matches(entry, { kind = '', section = '', q = '' } = {}) {
    if (kind && entry.kind !== kind) return false;
    if (section && entry.section !== section) return false;
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    const hay = [entry.title, entry.summary, ...(entry.highlights || []),
                 ...entry.links.map(l => linkLabel(l) || l.href), entry.pr ? `#${entry.pr}` : '']
        .join(' ').toLowerCase();
    return needle.split(/\s+/).every(word => hay.includes(word));
}

/**
 * Entries grouped by sprint, newest sprint first, filter applied.
 * Sprints with no matching entries are dropped.
 */
export function groupBySprint(entries = DEV_LOG, filter = {}, sprints = SPRINTS) {
    return sprints
        .map(sprint => ({ sprint, entries: entries.filter(e => matches(e, filter) && sprintFor(e.date, sprints) === sprint) }))
        .filter(g => g.entries.length > 0);
}

/** Count of entries per kind id. */
export function countByKind(entries = DEV_LOG) {
    const out = Object.fromEntries(KIND_IDS.map(id => [id, 0]));
    for (const e of entries) out[e.kind] = (out[e.kind] || 0) + 1;
    return out;
}

/** True when the entry shipped within `days` of `nowMs`. */
export function isFresh(entry, nowMs, days = 14) {
    const t = dateMs(entry.date);
    return Number.isFinite(t) && nowMs - t >= -DAY_MS && nowMs - t <= days * DAY_MS;
}

/** The newest `n` entries (DEV_LOG is kept newest first; this does not trust that). */
export function latest(n = 3, entries = DEV_LOG) {
    return [...entries].sort((a, b) => dateMs(b.date) - dateMs(a.date)).slice(0, n);
}

/** Human date: '2026-11-04' → 'Nov 4, 2026'. UTC, locale-independent. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDate(iso, { year = true } = {}) {
    const t = dateMs(iso);
    if (!Number.isFinite(t)) return iso;
    const d = new Date(t);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}${year ? `, ${d.getUTCFullYear()}` : ''}`;
}

/** 'Nov 3 – in progress' / 'Oct 26 – Nov 2, 2026'. */
export function sprintRange(sprint) {
    if (sprint.end == null) return `${formatDate(sprint.start)} – in progress`;
    return `${formatDate(sprint.start, { year: false })} – ${formatDate(sprint.end)}`;
}

export function prUrl(pr) { return `${REPO_URL}/pull/${pr}`; }
