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
            // THE DUSK LINE, WHEREVER IT IS (2026-11-25). The best frame this
            // page makes is the terminator: night-side city lights beside a
            // daylit continent and the Sun's glint on the sea. It moves with
            // the clock, so the camera is aimed at it AT CAPTURE TIME — 70°
            // west of the page's own sub-solar point, 22°N — rather than at a
            // fixed place that is only lit for part of the day. The `?at=` is
            // just the boot framing the eval below replaces.
            url: '/earth.html?verdict=0&at=18,72,9000',
            waitUntil: 'domcontentloaded',
            crop: '#c',
            ready: 'typeof window.__evCloudMode === "function"',
            hide: ['nav', '#hud', '#loc-panel', '#layer-panel', '#info-panel', '#sat-status', '#verdict-host',
                   '#models-panel-host', '#probability-picker-host', '#renewables-panel-host', '#ct-readouts',
                   // These hold canvases (legends, the time strip), so the generic stripper keeps them.
                   '#wx-panel', '#probe-panel', '#time-controls'],
            // The weather layers are OFF for the still: without the live feeds
            // they fall back to a synthetic circulation, and a poster must not
            // present that as weather. What is left is real — NASA's surface
            // map, the city lights and today's terminator from the real Sun.
            shots: [{ eval: 'for (const id of ["lyr-clouds","lyr-wind","lyr-isobars","lyr-obs-sst","lyr-cities","lyr-rotate","lyr-volcanoes-active","lyr-volcanoes-dormant","lyr-volcanoes-inactive","lyr-glacier-flow"]) { const c=document.getElementById(id); if (c && c.checked) c.click(); }', wait: 2500 },
                    { eval: 'const s = window.__evSunDir(); const ls = Math.atan2(-s[2], s[0]); const l = ls - 70 * Math.PI / 180, la = 22 * Math.PI / 180; window.__evSetCamDir(Math.cos(la) * Math.cos(l), Math.sin(la), -Math.cos(la) * Math.sin(l)); window.__evSetCamDist(2.95);', wait: 6000 }],
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
            // No drag: the OBSERVED disk (today's SDO frame) is pinned to the
            // Sun–Earth line, so the camera stays on it and the frame shows
            // the real Sun wherever sdo.gsfc.nasa.gov is reachable.
            // Five notches: the disc fills the frame's height, which also puts the
            // browse JPEG's burned-in caption (drawn by the off-limb layer) out of frame.
            // THE CORONA TODAY (2026-11-25). In white light on a software
            // rasteriser the disc reads as a flat over-exposed yellow; the
            // same page in AIA 193 Å shows the observed frame's real coronal
            // holes and active regions (sdo.gsfc.nasa.gov is reachable at
            // capture). The wind particles, field lines and CME train are
            // switched off for the still: around a full disc they read as
            // speckle, not as structure.
            shots: [{ eval: 'for (const id of ["tog-wind", "tog-fieldlines", "tog-cmetrain"]) { const t = document.getElementById(id); if (t && t.checked) { t.checked = false; t.dispatchEvent(new Event("change", { bubbles: true })); } } const v = document.getElementById("view-mode"); v.value = "3"; v.dispatchEvent(new Event("change", { bubbles: true }));', wait: 4000 },
                    { wheel: -240, n: 5, wait: 800 },
                    // NOAA region markers are click targets (torus rings), not
                    // the Sun — hidden for the still; the regions themselves
                    // are in the observed frame.
                    { eval: 'for (const g of window.__sun.scene.children) if (g.isGroup && g.children.some((c) => c.userData && c.userData.lat !== undefined)) g.visible = false;' }],
            settleMs: 20000,
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
            scale: 2,
            // Ready = the train is RUNNING (the HUD prints an apex), not merely a
            // canvas in the DOM: the page resets its clock when the provider
            // settles, which silently undid a scrub made before that.
            ready: '/AU/.test(document.getElementById("frl-hud-r")?.textContent || "")',
            hide: ['nav'],
            // The replay opens with the leader a speck beside the Sun. Pause, then
            // scrub the page's OWN time slider to +36 h — the leader closing on
            // Earth with the follower in flight behind it — and close in.
            shots: [
                { eval: 'const b = document.getElementById("frl-play"); if (b && b.textContent.trim() !== "▶") b.click(); const t = document.getElementById("frl-time"); if (t) { t.value = "36"; t.dispatchEvent(new Event("input", { bubbles: true })); }', wait: 2000 },
                { wheel: -240, n: 2, wait: 600 },
            ],
            settleMs: 12000,
            clipMs: 7000,
        },
    },
    {
        id: 'bz',
        does: 'Follow the Sun’s field from L1 down to the ground.',
        claim: 'Every minute of wind three L1 spacecraft have measured, drawn where it is now on its way in — then the bow shock, the magnetopause and both GOES magnetometers, each marked measured, estimated or forecast.',
        model: 'Multi-spacecraft L1 fusion · Shue + Farris boundaries',
        data: 'NOAA SWPC RTSW · GOES magnetometers',
        scale: 'L1 → geostationary orbit',
        verb: 'Read the column',
        accent: '#5aa2ff',
        capture: {
            // Needs services.swpc.noaa.gov (L1 + GOES). With it blocked the
            // canvas draws nothing upstream and this stays a plate. USGS ground
            // data is a separate rung and is not in this frame.
            url: '/bz.html',
            crop: '#bz-planet',
            scale: 2,          // a 420 px-tall 2D canvas: shoot it at 2× so the thumbnail is not upsampled
            ready: '!!window.__bzColumn && /nT/.test(document.getElementById("bz-read")?.textContent || "")',
            hide: ['nav', '#bz-planet-tip'],
            settleMs: 5000,
            clipMs: 6000,
        },
    },
    {
        id: 'cme-forecast',
        does: 'See every CME forecast locked before impact — and how it scored.',
        claim: 'Arrival windows are frozen at issue time and never rewritten; each is then scored against the shock L1 actually recorded, beside ENLIL and two baselines on the same events.',
        model: 'Flux-rope ensemble · drag-based + ballistic baselines',
        data: 'NASA DONKI · NOAA SWPC L1 · issue-locked ledger',
        scale: 'Sun → L1, 1–4 days',
        verb: 'Open the ledger',
        accent: '#b48cff',
        capture: {
            // Needs the production skill ledger (/api/cme/skill reads the
            // database). On a machine without it, record that route's real
            // response and pass `--replay <dir>`; with neither the calendar is
            // empty and this stays a plate. The frame is SEPTEMBER 2026 on
            // purpose — the month with scored arrivals — reached with the
            // calendar's own Previous button; it is an archive view and the
            // calendar's own title says which month.
            url: '/cme-forecast.html',
            crop: '#cmef-view-calendar',
            scale: 2,
            ready: 'document.querySelectorAll("#cmef-calendar-grid > *").length > 20 && /Ledger ran/.test(document.getElementById("cmef-feed-label")?.textContent || "")',
            hide: ['nav', '#cmef-tooltip'],
            shots: [
                { eval: 'const t = () => (document.getElementById("cmef-calendar-title")?.textContent || "") + " " + (document.getElementById("cmef-calendar-range")?.textContent || ""); for (let i = 0; i < 6 && !/September 2026/.test(t()); i++) document.getElementById("cmef-calendar-prev")?.click();', wait: 1500 },
            ],
            settleMs: 3000,
            clipMs: 5000,
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
            shots: [{ wheel: 240, n: 5 }, { drag: [0.5, 0.5, 0.42, 0.56], wait: 600 }],
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
            shots: [{ wheel: -240, n: 4 }, { drag: [0.5, 0.5, 0.5, 0.42], wait: 600 }],
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
            // LIFTOFF (2026-11-25). A rocket standing on a pad is a model; the
            // page's best moment is T+5 s — the stack clearing the tower, the
            // plume lighting its own ground cloud. Full-screen stage, 3/4
            // view, high post chain; Liftoff is clicked last (smoke is
            // emitted on MISSION time, and a
            // software frame takes seconds): the last step waits until the
            // page's own mission clock reads T-0 and shoots: on a software
            // rasteriser the next frame lands seconds later, i.e. at liftoff.
            // Clicks are scripted (the main thread is too busy for a real one);
            // the generic overlay stripper has already hidden the toolbars.
            url: '/launch-planner.html?lpfx=high',
            crop: '#lh-vehicle-canvas',
            ready: '!!(window.__lpVehicle3d && window.__lpVehicle3d.renderStats)',
            hide: ['nav'],
            shots: [{ eval: 'document.querySelector("[data-vehicle=starship]").click();', wait: 5000 },
                    { eval: 'document.querySelector("#lh-cam-full").click();', wait: 4000 },
                    { eval: 'document.querySelector(".lh-view[data-view=threequarter]").click();', wait: 5000 },
                    { eval: 'document.querySelector("#lh-liftoff").click(); return new Promise((ok) => { const f = () => (window.__lpVehicle3d.missionT >= 0 ? ok() : requestAnimationFrame(f)); f(); });' }],
            settleMs: 0,
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
            // The in-stage overlays (legend, layer chips, tools) are absolute
            // children of the stage host, which the stripper keeps for its canvas.
            hide: ['nav', '#gw-stage .gw-ov'],
            shots: [{ wheel: -240, n: 2 }, { drag: [0.5, 0.5, 0.58, 0.42], wait: 600 }],
            settleMs: 10000,
            clipMs: 7000,
        },
    },
    {
        id: 'climalytix',
        does: 'Put one place under every dataset at once.',
        claim: 'Our own GFS archive brought down to the real ground: a lapse rate fitted from each run, each slope’s sunlight and shadow, night cold-air pooling — on one clock with the record and the terrain.',
        model: 'GFS 0.25° · fitted lapse rate · terrain sun & shade',
        data: 'NOAA GFS · AWS Terrain Tiles · NASA Blue Marble',
        scale: '30 m terrain → 25 km model',
        verb: 'Analyse a site',
        accent: '#5fd8ff',
        capture: {
            // NEEDS THE GFS ARCHIVE. /api/climalytix/nwp(-field) read R2; with
            // the R2_* variables unset the map has no temperature or wind and
            // the still would be a bare basemap. On a machine without the
            // production secrets: run `python3 scripts/climalytix_ingest/gfs.py
            // --max-lead 48 --out <dir>` (a real run, ~700 MB), then
            // `node scripts/serve-local-r2.mjs <dir>` and start the dev server
            // with the R2_* values that script prints. The frame is that run's
            // forecast for the capture instant — the card's date says which.
            url: '/climalytix.html',
            storage: { ppx_user_location: { lat: 39.74, lon: -105.6, city: 'Front Range, Colorado', displayName: 'Front Range, Colorado' } },
            crop: '#cx-map-stage',
            ready: '/GFS run/.test(document.getElementById("cx-heat-status")?.textContent || "") && /GFS 10 m wind/.test(document.getElementById("cx-flow-status")?.textContent || "")',
            // The on-map key is dropped because the 16:9 thumbnail crop cuts it in
            // half; the card's own caption says what is drawn (2 m temperature + 10 m wind).
            hide: ['nav', '#cx-map-ctl', '#cx-map-attr', '#cx-map-tip', '#cx-map-key', '#cx-map-scale'],
            shots: [{ wheel: -240, n: 1, wait: 2500 }],
            settleMs: 9000,
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
        id: 'earth-interior',
        does: 'Watch an earthquake’s waves cross the planet to you.',
        claim: 'Today’s USGS earthquakes traced through PREM at true radii — every phase, its travel time and its strength — beside the observed core field, the plates and the subducting slabs.',
        model: 'PREM ray tracing · CHAOS-8.1 · Slab2',
        data: 'USGS · PB2002 · Smithsonian GVP',
        scale: 'surface → 6,371 km',
        verb: 'Open the Earth',
        accent: '#5aa2ff',
        capture: {
            url: '/earth-interior.html',
            crop: '#ei-canvas',
            ready: '!!document.querySelector(\'#ei-views [data-view="cutaway"]\')',
            // THE FIELD AT THE CORE (2026-11-26). Driven first: the live view
            // (seismic rays crossing the planet) is the page's best moment but
            // draws nothing without USGS, which is unreachable at capture; the
            // Slab2 sections read as abstract shards at poster size. The
            // magnetic-field view is real data end to end — CHAOS-8.1 on the
            // surface and, through the cut wedge, the field at the core–mantle
            // boundary — and reads at a glance.
            hide: ['nav'],
            shots: [{ wait: 6000 },
                    { eval: 'document.querySelector(\'#ei-views [data-view="field"]\').click();', wait: 10000 },
                    { wheel: -240, n: 1, wait: 3000 }],
            settleMs: 9000,
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
            // THE WHOLE INSTRUMENT, NOT JUST THE MAP (2026-11-26, owner: "more
            // detail"). The map is a PM2.5 field with no basemap, so on its own
            // it reads as coloured blobs; the detail is beside it — the six
            // dirtiest metros' series, the diurnal composite, the six-day
            // exposure timeline. The feeds are CAMS via Open-Meteo (blocked at
            // capture): run with `--replay <dir>` of UNEDITED production
            // /api/air-quality/{centers,grid,history}, /api/weather/grid and
            // /api/wildfires/events bodies, or the page shows its DEMO badge.
            url: '/pollution.html',
            crop: '.pl-main',
            cropHeightOf: '.pl-map-wrap',
            ready: '!!document.querySelector("#pl-map") && document.getElementById("pip-history")?.classList.contains("live")',
            hide: ['nav'],
            settleMs: 6000,
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
            // "Earth's view" puts the camera on the Earth's direction, so the
            // disc shows the capture day's real phase and libration.
            // The still is the SURFACE: the exosphere atoms, sodium tail, quake and
            // anomaly markers and the landing-site plates are switched off (they
            // read as noise at thumbnail size); the page's own toggles do it.
            // 2026-11-25: the grid and the radiation ring off too, and the
            // landmark rings hidden — at hero size they read as a diagram
            // drawn over the Moon, which is what the old still looked like.
            prep: 'for (const id of ["lyr-quakes","lyr-anomalies","lyr-hops","lyr-radiation","lyr-rad-ring","lyr-exo","lyr-natail","lyr-grid","lyr-apollo","lyr-artemis","lyr-colony"]) { const c = document.getElementById(id); if (c && c.checked) c.click(); } document.getElementById("vt-earthview")?.click()',
            shots: [{ eval: 'window.__moonLab.landmarks.group.visible = false;', wait: 1500 }],
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
            // THE WHOLE PLANET, CLEAN (2026-11-25). Driven first: the
            // feature index's Valles Marineris approach is the page's best
            // LIVE moment, but a still of it is limited by the imagery
            // reachable at capture (the bundled 15 km/px Viking mosaic; NASA
            // Trek's streamed tiles sharpen it on the live page) and read as
            // blur. So the poster is the globe — MOLA relief, the real
            // terminator — with every overlay layer (landmarks, grid, rover
            // route, landing sites) switched off by the page's own toggles.
            shots: [{ eval: 'for (const i of document.querySelectorAll("input[data-layer^=landmark-], input[data-layer=grid], input[data-layer=route], input[data-layer=waypoints], input[data-layer=rover], input[data-layer=landing]")) if (i.checked) i.click();', wait: 2500 }],
            settleMs: 6000,
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
            // EARTH'S ORBIT IN THE NEO SWARM (2026-11-26, owner request). The
            // catalogue is JPL's (blocked at capture), so this still needs
            // `--replay <dir>` holding an UNEDITED production
            // /api/neo/catalog body (the PHA tier: 2,766 objects) — without it
            // the page honestly says "feed down" and draws no swarm. Apophis
            // (99942) is selected through the panel's OWN delegated click so
            // its orbit is drawn crossing Earth's; then the camera is freed
            // (F — the lock sits on the rock and frames nothing) and set to
            // the iso preset, pulled in so the inner orbits fill the frame.
            // Synthetic drags never reach this page's controls headless, so
            // the camera is placed through the page's own hooks.
            shots: [{ eval: 'const host = document.querySelector(".neo-toggles").parentElement; const b = document.createElement("button"); b.dataset.des = "99942"; host.appendChild(b); b.click(); b.remove();', wait: 5000 },
                    { key: 'f' },
                    // The near-Earth frame's 1/5/10/20 LD rings stack their labels on
                    // Earth at this distance; the page's own toggle drops them.
                    { eval: 'const t = document.querySelector("[data-vis=local]"); if (t && t.checked) t.click(); document.getElementById("cam-iso").click();', wait: 4000 },
                    { eval: 'window.__solarRender.camera.position.multiplyScalar(0.42);', wait: 4000 }],
            settleMs: 4000,
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
            shots: [{ wheel: -240, n: 5 }, { drag: [0.5, 0.5, 0.56, 0.72], wait: 600 }],
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
            // The toggle row and camera buttons sit inside the canvas wrap.
            hide: ['nav', '.tog-row', '#cam-controls'],
            shots: [{ drag: [0.5, 0.4, 0.44, 0.66] }, { wheel: -240, n: 3, wait: 600 }],
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
            scale: 2,
            ready: '!!globalThis.__bootesLab',
            hide: ['nav'],
            // The vector field's arrows bury the structure at thumbnail size, so the
            // still shows the void itself: tracer galaxies, the filaments and nodes
            // of its wall, the R_eff shell and the catalogued clusters. The page's
            // own layer toggle does it.
            prep: 'const c = document.querySelector(\'[data-bv-control="layer:field"]\'); if (c && c.checked) c.click();',
            shots: [{ drag: [0.5, 0.5, 0.58, 0.44], wait: 800 }],
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
