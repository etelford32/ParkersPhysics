/**
 * home-showcase-slides.js — the ONE list of simulations the homepage
 * Simulation Showcase features, plus the recipe that captures each.
 * ═══════════════════════════════════════════════════════════════════════════
 * Consumed by:
 *   - js/home-showcase.js                   the runtime (cards, filters, loops)
 *   - scripts/capture-home-showcase.mjs     the Playwright capture (url / crop /
 *                                           ready / hide) that writes the
 *                                           poster + clip + manifest under
 *                                           assets/home/showcase/
 *   - tests/home-showcase.mjs               drift gate — every id must be a
 *                                           catalogued simulation, every capture
 *                                           url must exist on disk, every
 *                                           manifest entry must point at a real
 *                                           file inside the media budget
 *
 * ONE SOURCE OF TRUTH FOR WHAT A SIMULATION IS
 * ────────────────────────────────────────────
 * `id` is a js/simulations-catalog.js id. Title, href, section, tier, icon
 * and the catalogue blurb come from THERE at runtime (`resolveSlides`) —
 * this file adds only what the showcase says on top: what you can DO on the
 * page, the physics claim, the named model, the data it runs on, the verb on
 * the card, and the capture recipe. Rename a page in the catalogue and the
 * card follows; the gate fails if an id here is not catalogued.
 *
 * WHY CAPTURES, NOT LIVE EMBEDS
 * ─────────────────────────────
 * Every sim here is a full three.js app. The 2026-09 funnel work measured
 * that two live iframes below the hero were the reason only ~7% of visitors
 * reached the capture band. So each card is a poster (JPEG) that plays a
 * short muted loop (WebM) on hover — one decoding at a time — and the ONLY
 * live scene on the homepage is the magnetosphere canvas the hero already
 * pays for. (The 2026-09 background carousel cycled these same captures
 * BEHIND the hero copy; the owner judged it janky on 2026-11-09 and it was
 * retired — see js/home-showcase.js.)
 *
 * HONESTY
 * ───────
 * A capture is an archive, not an observation. The manifest carries a
 * `capturedAt` and a `renderer` per slide and the card prints them — the
 * same archival-vs-live split the Mars tile layer discloses. Do not drop
 * the date to tidy the card. Captures made on a software rasteriser say so;
 * re-run the capture script with --gpu on real hardware to replace them.
 *
 * Fields
 *   id          a js/simulations-catalog.js id; also the media basename
 *   does        what the visitor can DO there — one imperative sentence
 *   claim       one line, what the sim actually computes — physics-first
 *   model       the named model(s) behind it (kicker, mono)
 *   data        the data it runs on (chip)
 *   scale       optional: the spatial / temporal range it covers (chip)
 *   verb        the card's call to action ("Fly to your sky")
 *   accent      card accent colour (hex)
 *   capture     { url, crop, ready, hide, prep, settleMs, clipMs, stripOverlays }
 *                url      page to capture (root-relative, query allowed)
 *                crop     selector of the element to crop to (falls back to
 *                         the viewport when it has no box)
 *                ready    JS expression evaluated in the page until truthy
 *                hide     selectors to display:none before capture (page
 *                         chrome that would otherwise sit in the shot)
 *                prep     optional JS run once ready (toggle an in-scene
 *                         layer, pick a camera) before the settle wait
 *                stripOverlays  default true: the capture also hides every
 *                         fixed/absolute element that is not (and does not
 *                         contain) a canvas — panels, tickers, tips — so a
 *                         page can add chrome without breaking its shot
 *                settleMs how long to let the scene run before the poster
 *                clipMs   loop length recorded after the poster
 */
import { SIMULATIONS } from './simulations-catalog.js';

export const MEDIA_DIR = 'assets/home/showcase/';
export const MANIFEST_URL = MEDIA_DIR + 'manifest.json';

/** Showcase-specific copy + capture recipes, in display order. */
export const SHOWCASE_ENTRIES = Object.freeze([
    {
        id: 'earth',
        does: 'Fly to your sky and scrub the week ahead.',
        claim: 'Live radar, hurricane tracks, NWS alerts and tonight’s aurora oval on one globe — the troposphere drawn to scale and the surface lit by the real Sun.',
        model: 'NWP · OVATION · Cox–Munk glint',
        data: 'NOAA SWPC · NWS · Open-Meteo · GIBS',
        scale: 'surface → 2,000 km',
        verb: 'Fly to your sky',
        accent: '#2eff9e',
        capture: {
            url: '/earth.html?verdict=0',
            crop: '#c',
            ready: 'typeof window.__evCloudMode === "function"',
            hide: ['nav', '#hud', '#loc-panel', '#layer-panel', '#info-panel', '#sat-status', '#verdict-host',
                   '#models-panel-host', '#probability-picker-host', '#renewables-panel-host', '#ct-readouts',
                   // These hold canvases (legends, the time strip), so the generic stripper keeps them.
                   '#wx-panel', '#probe-panel', '#time-controls'],
            settleMs: 10000,
            clipMs: 7000,
        },
    },
    {
        id: 'sun',
        does: 'Watch today’s active regions, flares and coronal loops on a live Sun.',
        claim: 'SDO/AIA frames fused onto a modelled photosphere, PFSS arcades marched through a volumetric corona, nanoflare heating as a measured power law.',
        model: 'PFSS · nanoflare population · flare DEM',
        data: 'NASA SDO · NOAA SWPC · HEK',
        verb: 'Watch the Sun',
        accent: '#ffb830',
        capture: {
            url: '/sun.html',
            crop: '#canvas-wrap',
            ready: 'window.__sun && window.__sun.ready && window.__sun.frames > 5',
            // The HUD, the NOAA timestamp and the daily summary are in-flow
            // children of the canvas wrap, so the generic stripper keeps them.
            hide: ['nav', '#hud', '#sw-noaa-ts', '#sun-daily-summary', '#canvas-wrap > :not(canvas)'],
            // Default framing leaves the disc a third of the frame; close in
            // so the photosphere and the loop arcades carry the card.
            prep: 'const S=window.__sun; if(S&&S.camera){S.camera.position.multiplyScalar(0.72); S.controls?.update?.();}',
            settleMs: 12000,
            clipMs: 7000,
        },
    },
    {
        id: 'flux-rope-live',
        does: 'Follow every CME in flight to Earth, with its Bz forecast.',
        claim: 'Magnetic flux ropes launched from real DONKI events, CME-on-CME interaction modelled in transit, arrival and Bz as an ensemble — hindcast on the 2015 and 2024 superstorms.',
        model: 'Flux-rope kernel (Rust → WASM) · particle filter',
        data: 'NASA DONKI · DSCOVR L1',
        scale: 'Sun → 1 AU',
        verb: 'Watch it live',
        accent: '#ff5cb8',
        capture: {
            url: '/flux-rope-live.html',
            crop: '#frl-gl',
            ready: '!!document.querySelector("#frl-gl")',
            hide: ['nav'],
            settleMs: 12000,
            clipMs: 7000,
        },
    },
    {
        id: 'upper-atmosphere',
        does: 'Dive from orbit to 80 km and see what a storm does to the air.',
        claim: 'Thermosphere density from 80 to 2,000 km under live NOAA drivers — the number that decides satellite drag, launch windows and orbit decay.',
        model: 'NRLMSISE-00 · Jacchia-71 bulge',
        data: 'NOAA SWPC · CelesTrak',
        scale: '80 → 2,000 km',
        verb: 'Open the simulator',
        accent: '#4ddc99',
        capture: {
            url: '/upper-atmosphere.html',
            crop: '#ua-globe',
            ready: '!!window.__ua',
            hide: ['nav'],
            settleMs: 14000,
            clipMs: 7000,
        },
    },
    {
        id: 'ring-current',
        does: 'Build a geomagnetic storm’s main phase, particle by particle.',
        claim: 'Bounce-averaged ion transport, charge-exchange loss and the Dst it produces, driven by the solar wind measured at L1.',
        model: 'Bounce-averaged transport · Dst twin',
        data: 'DSCOVR L1 · Kyoto Dst',
        verb: 'Run the storm',
        accent: '#ff8c5a',
        capture: {
            url: '/ring-current.html',
            crop: '#rc-stage',
            ready: '!!window.rcGlobe',
            hide: ['nav', '#rc-dock', '#rc-legend', '.rc-simtime', '.rc-views', '.rc-insp', '.rc-perf',
                   '.rc-gosee', '.rc-stage-hint', '.rc-descent', '.rc-heat-panel', '.rc-ena-cap'],
            // The ENA imager panel is an in-scene mesh, not DOM — switch the
            // layer off so the ring itself is the picture.
            prep: 'document.querySelector(".rc-ena-toggle.rc-on")?.click()',
            settleMs: 9000,
            clipMs: 7000,
        },
    },
    {
        id: 'tiga',
        does: 'Trace the core field from the core–mantle boundary to a live storm estimate.',
        claim: 'IGRF-14 continued down to the core–mantle boundary, and a sequential Bayesian estimator that publishes its own uncertainty.',
        model: 'IGRF-14 · sequential Bayes',
        data: 'USGS magnetometers · DSCOVR L1',
        verb: 'Open TIGA',
        accent: '#b765ff',
        capture: {
            url: '/tiga.html',
            crop: '#tg-stage',
            ready: '!!document.querySelector("#tg-stage canvas")',
            hide: ['nav'],
            settleMs: 9000,
            clipMs: 7000,
        },
    },
    {
        id: 'launch-planner',
        does: 'Walk a floodlit pad and check a launch window.',
        claim: 'Upcoming launches with weather Go/No-Go for every pad, and the vehicles built to their published dimensions with a physical exhaust and steam model.',
        model: 'Pad weather rules · smoke kernel',
        data: 'Launch feed · Open-Meteo',
        verb: 'Visit the pad',
        accent: '#8ff0ff',
        capture: {
            url: '/launch-planner.html?lpfx=low',
            crop: '#lh-vehicle-canvas',
            ready: '!!(window.__lpVehicle3d && window.__lpVehicle3d.renderStats)',
            hide: ['nav'],
            settleMs: 12000,
            clipMs: 7000,
        },
    },
    {
        id: 'glacier-watch',
        does: 'Watch 48 glaciers move, measured from orbit.',
        claim: 'ITS_LIVE image pairs give each glacier’s surface speed within weeks of the pass; a shallow-ice inversion gives the thickness underneath, labelled as a model.',
        model: 'Shallow-ice inversion',
        data: 'NASA ITS_LIVE · Copernicus DEM · WGMS',
        verb: 'Watch the ice',
        accent: '#9ad8ff',
        capture: {
            url: '/glacier-watch.html',
            crop: '#gw-stage-host',
            ready: '!!window.__glacierWatch && !!document.querySelector("#gw-stage-host canvas")',
            hide: ['nav'],
            settleMs: 10000,
            clipMs: 7000,
        },
    },
    {
        id: 'volcanoes',
        does: 'Find every volcano on Earth and what it would do to the climate.',
        claim: '2,661 Smithsonian GVP volcanoes with live eruption status, an empirical-Bayes eruption rate, and a VEI-to-climate chain — Pinatubo through it gives −0.34 K.',
        model: 'Gamma–Poisson onset rate · one-box EBM',
        data: 'Smithsonian GVP · USGS · NASA EONET',
        verb: 'Open the lab',
        accent: '#ff7a3d',
        capture: {
            url: '/volcanoes.html',
            crop: '#vx-map',
            ready: '!!window.__volcanoLab',
            hide: ['nav'],
            settleMs: 8000,
            clipMs: 6000,
        },
    },
    {
        id: 'pollution',
        does: 'Scrub a week of PM2.5 back, and a week ahead.',
        claim: 'PM2.5 interpolated across ~105 cities on one shared time axis, hotspots clustered, plumes advected by the wind field.',
        model: 'IDW field · semi-Lagrangian transport',
        data: 'CAMS via Open-Meteo',
        verb: 'Open the lab',
        accent: '#ffd23f',
        capture: {
            url: '/pollution.html',
            crop: '#pl-map',
            ready: '!!document.querySelector("#pl-map")',
            hide: ['nav'],
            settleMs: 9000,
            clipMs: 7000,
        },
    },
    {
        id: 'moon',
        does: 'Stand on real lunar relief under today’s Sun.',
        claim: 'LRO-derived terrain displaced on the sphere, a live ephemeris for phase and libration, a Monte-Carlo exosphere and an interior that reproduces the measured moment of inertia.',
        model: 'Meeus ephemeris · Neukum crater field',
        data: 'NASA LRO · Apollo seismology',
        verb: 'Land on the Moon',
        accent: '#d9d4c7',
        capture: {
            url: '/moon.html',
            crop: '#c',
            ready: '!!window.__moonLab',
            hide: ['nav', '#hud', '#info-panel', '#descent-hud', '#view-toggle', '.view-toggle', '#synth-legend'],
            // Default framing looks at the terminator; swing the camera to
            // the sunlit hemisphere so the relief and maria read.
            prep: 'const L=window.__moonLab; if(L){const d=L.camera.position.length(); L.camera.position.set(1,0.15,0.3).normalize().multiplyScalar(d); L.controls?.update?.();}',
            settleMs: 9000,
            clipMs: 7000,
        },
    },
    {
        id: 'mars',
        does: 'Explore Mars at the real hour, season and lighting.',
        claim: 'JPL ephemeris rotation, MOLA relief, a modelled climate field and NASA Trek imagery streamed on approach — the map is archival, the view is live.',
        model: 'Mars24 clock · MOLA relief',
        data: 'JPL Horizons · NASA Trek',
        verb: 'Explore Mars',
        accent: '#ff8c5a',
        capture: {
            url: '/mars.html',
            crop: '#mars-canvas',
            ready: '!!window.__marsLab',
            hide: ['nav', '#landmark-card', '.loader-status', '#climate-controls', '.mars-header', '.mission-strip',
                   '.camera-dock', '.mission-panel', '.layers-panel', '.data-dock', '.feature-index', '#climate-legend',
                   '#climate-readout'],
            settleMs: 10000,
            clipMs: 7000,
        },
    },
    {
        id: 'solar-system',
        does: 'Place every planet where it is tonight.',
        claim: 'Planets from VSOP87 at the simulation instant, tens of thousands of near-Earth objects drawn as lit bodies, and CMEs drawn as the same flux-rope surface the forecast uses.',
        model: 'VSOP87 · Kepler NEO kernel',
        data: 'JPL Horizons · JPL SBDB',
        verb: 'Open the orrery',
        accent: '#c080ff',
        capture: {
            url: '/solar-system.html',
            crop: '#canvas-wrap',
            ready: '!!window.__solarRender',
            hide: ['nav'],
            // The default framing shows the whole system small; close in so
            // the inner orbits and the Sun fill the frame.
            prep: 'const R=window.__solarRender; if(R&&R.camera){R.camera.position.multiplyScalar(0.55); R.camera.updateProjectionMatrix();}',
            settleMs: 12000,
            clipMs: 7000,
        },
    },
    {
        id: 'neo-watch',
        does: 'See what is around Earth right now, out to half an AU.',
        claim: 'JPL’s own orbital elements propagated by the site’s kernel; Earth’s Hill sphere and sphere of influence drawn as the model’s own limits.',
        model: 'Two-body + Hill / SOI · CR3BP gates',
        data: 'JPL SBDB · JPL CAD',
        scale: '1 LD → 0.5 AU',
        verb: 'Open the watch',
        accent: '#8ff0ff',
        capture: {
            url: '/neo-watch.html',
            crop: '#nw-canvas',
            ready: '!!window.__neoWatch',
            hide: ['nav'],
            settleMs: 12000,
            clipMs: 7000,
        },
    },
    {
        id: 'galactic-map',
        does: 'Fly from the Sun to the galactic centre.',
        claim: 'Catalogued stars, clusters, remnants and black holes on a Milky Way you can turn — the same catalogue SkyView ranks for tonight.',
        model: 'Galactic (l, b) catalogue · Hipparcos identities',
        data: 'Hipparcos · published distances',
        scale: '8 kpc',
        verb: 'Fly the galaxy',
        accent: '#9a85ff',
        capture: {
            url: '/galactic-map.html',
            crop: '#canvas-wrap',
            ready: '!!document.querySelector("#canvas-wrap canvas")',
            hide: ['nav'],
            settleMs: 9000,
            clipMs: 7000,
        },
    },
    {
        id: 'star-collider',
        does: 'Merge two neutron stars and read what the remnant becomes.',
        claim: 'A nuclear equation of state sets the radius, tides are written into the last gravitational-wave cycles, SPH in WASM does the merger, and Bauswein’s threshold decides the remnant.',
        model: 'TOV · 2.5PN radiation reaction · SPH (Rust → WASM)',
        data: 'GW170817 · SXS calibration',
        verb: 'Run a merger',
        accent: '#4ddbff',
        capture: {
            url: '/star-collider.html?detail=standard',
            crop: '#sc-stage',
            ready: '!!window.__starCollider',
            hide: ['nav'],
            prep: 'window.__starCollider.buildAndRun && window.__starCollider.buildAndRun()',
            settleMs: 16000,
            clipMs: 7000,
        },
    },
    {
        id: 'bootes-void',
        does: 'Ask how far an empty region’s gravity reaches.',
        claim: 'A million cubic megaparsecs of almost nothing: density to peculiar velocity to tidal shear, with an N-body forecast and a reconstructed past that is measured, not inferred.',
        model: 'ΛCDM shell ODE · quadrupole tree N-body · 2LPT',
        data: 'Kirshner et al. 1981/87 · cluster catalogue',
        scale: '230 Mpc',
        verb: 'Enter the void',
        accent: '#b0a6ff',
        capture: {
            url: '/bootes-void.html',
            crop: '#bv-stage',
            ready: '!!globalThis.__bootesLab',
            hide: ['nav'],
            settleMs: 10000,
            clipMs: 7000,
        },
    },
]);

/**
 * Join each entry with its catalogue record. PURE. Entries whose id is not
 * catalogued are DROPPED (the node gate fails on them, so this only matters
 * if the catalogue moves under a deployed page) — a card must never point
 * at a page that does not exist.
 */
export function resolveSlides(entries = SHOWCASE_ENTRIES, catalog = SIMULATIONS) {
    const byId = new Map(catalog.map((s) => [s.id, s]));
    const out = [];
    for (const e of entries) {
        const c = byId.get(e.id);
        if (!c) continue;
        out.push({
            ...e,
            title: c.title,
            href: c.href,
            section: c.category,
            tier: c.tier,
            icon: c.icon,
            blurb: c.blurb,
        });
    }
    return out;
}

/** Every showcase slide in display order, catalogue fields resolved. */
export const SHOWCASE_SLIDES = Object.freeze(resolveSlides());
