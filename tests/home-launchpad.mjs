/**
 * home-launchpad.mjs — node gate for the homepage's first screen
 * (js/home-launchpad-model.js + the static markup in index.html #hero).
 *
 *   node tests/home-launchpad.mjs
 *
 *   1. The carousel is DERIVED from the build log: one slide per simulation,
 *      newest logged change first, no platform entries, every slide resolves
 *      to a catalogued page and an existing log anchor.
 *      NEGATIVE CONTROLS: a synthetic newer entry moves its simulation to the
 *      front (the "updates with the site" claim); a newer PLATFORM entry does
 *      not; a second entry for the same simulation does not add a slide.
 *   2. An entry belongs to its FIRST catalogued link — Glacier Watch (which
 *      also links EarthView) must not become EarthView's latest change.
 *   3. The six permanent tiles in index.html are the model's FIXTURE_IDS, in
 *      order, with the catalogue's href + title and the model's copy.
 *   4. The section doors are js/site-sections.js's hubs.
 *   5. Thumbnails: scripts/build-launchpad-thumbs.py is current with the
 *      showcase manifest; every statically referenced thumbnail exists; a
 *      fixture with no capture carries a plate, not an <img>.
 *   6. The page: mounts the launchpad, no longer wires the live hero (which
 *      lives on live-sky.html, and still does), and preloads no three.js.
 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = await import(path.join(ROOT, 'js/home-launchpad-model.js'));
const { DEV_LOG } = await import(path.join(ROOT, 'js/dev-log.js'));
const { SIMULATIONS } = await import(path.join(ROOT, 'js/simulations-catalog.js'));
const { SITE_SECTIONS } = await import(path.join(ROOT, 'js/site-sections.js'));
const { LAUNCHPAD_MEDIA } = await import(path.join(ROOT, 'js/home-launchpad-media.js'));

let failures = 0;
const fail = (m) => { failures++; console.error('  ✗ ' + m); };
const ok = (m) => console.log('  ✓ ' + m);
const section = (n, f) => { const before = failures; f(); if (failures === before) ok(n); };

// ── 1. the carousel ─────────────────────────────────────────────────────────
section('carousel: one slide per simulation, newest first, derived from the build log', () => {
    const slides = M.recentSlides();
    if (slides.length < 4 || slides.length > M.RECENT_MAX) fail(`expected 4–${M.RECENT_MAX} slides, got ${slides.length}`);
    const ids = slides.map((s) => s.sim.id);
    if (new Set(ids).size !== ids.length) fail('a simulation appears on two slides: ' + ids.join(','));
    for (let i = 1; i < slides.length; i++) if (slides[i].entry.date > slides[i - 1].entry.date) fail(`slides out of date order at ${i}`);
    for (const s of slides) {
        if (s.entry.kind === 'platform') fail(`platform entry ${s.entry.id} made a slide`);
        if (!SIMULATIONS.includes(s.sim)) fail(`${s.sim.id} is not a catalogue row`);
        if (!existsSync(path.join(ROOT, s.sim.href))) fail(`${s.sim.href} does not exist`);
        if (!DEV_LOG.includes(s.entry)) fail(`${s.entry.id} is not a DEV_LOG entry`);
        if (s.href.split(/[?#]/)[0] !== s.sim.href) fail(`slide href ${s.href} is not ${s.sim.href}`);
        if (s.fresh !== false) fail('fresh must be false when no clock is handed in');
    }
    // The newest simulation-bearing log entry leads.
    const lead = [...DEV_LOG].sort((a, b) => (a.date < b.date ? 1 : -1)).find((e) => e.kind !== 'platform' && M.simForEntry(e));
    if (slides[0].entry !== lead) fail(`lead slide is ${slides[0].entry.id}, newest eligible entry is ${lead.id}`);
});

section('carousel follows the log: a new entry moves its simulation to the front (with controls)', () => {
    const base = M.recentSlides();
    const last = base[base.length - 1].sim;
    const mk = (over) => ({ id: 'synthetic', date: '2099-01-01', pr: null, title: 't', kind: 'layer', section: last.category,
                            icon: 'earth', summary: 's.', links: [{ href: last.href }], ...over });
    const moved = M.recentSlides({ log: [mk({}), ...DEV_LOG] });
    if (moved[0].sim.id !== last.id || moved[0].entry.id !== 'synthetic') fail('a newer entry did not move its simulation to the front');
    if (moved.filter((s) => s.sim.id === last.id).length !== 1) fail('the moved simulation appears twice');
    // A simulation that was NOT in the carousel enters it.
    const outsider = SIMULATIONS.find((s) => !base.some((b) => b.sim.id === s.id));
    const entered = M.recentSlides({ log: [mk({ links: [{ href: outsider.href }] }), ...DEV_LOG] });
    if (entered[0].sim.id !== outsider.id) fail('a newly logged simulation did not enter the carousel');
    // CONTROL: a newer platform entry changes nothing.
    const plat = M.recentSlides({ log: [mk({ kind: 'platform' }), ...DEV_LOG] });
    if (plat.map((s) => s.entry.id).join() !== base.map((s) => s.entry.id).join()) fail('a platform entry changed the carousel');
    // CONTROL: an entry whose links are not simulations changes nothing.
    const none = M.recentSlides({ log: [mk({ links: [{ href: 'pricing.html', label: 'Pricing' }] }), ...DEV_LOG] });
    if (none.map((s) => s.entry.id).join() !== base.map((s) => s.entry.id).join()) fail('a non-simulation entry changed the carousel');
    // fresh is relative to the clock handed in.
    const t = Date.parse('2099-01-05T00:00:00Z');
    const f = M.recentSlides({ log: [mk({}), ...DEV_LOG], nowMs: t });
    if (f[0].fresh !== true || f[1].fresh !== false) fail('fresh flag does not follow nowMs');
});

// ── 2. first catalogued link wins ───────────────────────────────────────────
section('an entry belongs to its FIRST catalogued link', () => {
    const e = { id: 'x', date: '2099-01-01', kind: 'simulation', links: [{ href: 'glacier-watch.html' }, { href: 'earth.html?x=1#y' }] };
    if (M.simForEntry(e)?.sim.id !== 'glacier-watch') fail('simForEntry did not take the first link');
    if (M.latestEntryFor('earth', { log: [e, ...DEV_LOG] })?.id === 'x') fail('a second-link mention became EarthView\'s latest change');
    if (M.latestEntryFor('glacier-watch', { log: [e, ...DEV_LOG] })?.id !== 'x') fail('latestEntryFor missed the newest entry');
    if (M.simForHref('earth.html?verdict=0#top')?.id !== 'earth') fail('simForHref does not strip ?query/#hash');
    if (M.latestEntryFor('no-such-sim') !== null) fail('unknown simulation should have no latest entry');
});

// ── 3. the permanent tiles ──────────────────────────────────────────────────
const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
const tiles = [...html.matchAll(/<a class="lp-fix"[^>]*href="([^"]+)"[^>]*data-lp-fixture="([^"]+)"[^>]*data-funnel-cta="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((m) => ({ href: m[1], id: m[2], cta: m[3], body: m[4] }));
section('permanent tiles: the six fixtures, in order, pinned to the catalogue and the model', () => {
    const want = ['galactic-map', 'solar-system', 'earth', 'climalytix', 'mars', 'sun'];
    if (M.FIXTURE_IDS.join() !== want.join()) fail('FIXTURE_IDS changed — that list is an owner decision: ' + M.FIXTURE_IDS.join());
    if (tiles.map((t) => t.id).join() !== M.FIXTURE_IDS.join()) fail('index.html tiles are ' + tiles.map((t) => t.id).join() + ', model says ' + M.FIXTURE_IDS.join());
    const fx = M.fixtures();
    for (const f of fx) {
        const t = tiles.find((x) => x.id === f.sim.id);
        if (!t) continue;
        if (t.href !== f.sim.href) fail(`${f.sim.id}: tile href ${t.href} ≠ catalogue ${f.sim.href}`);
        if (t.cta !== 'launchpad_fixture_' + f.sim.id) fail(`${f.sim.id}: funnel id ${t.cta}`);
        if (!decode(t.body).includes(`<b>${f.sim.title}</b>`)) fail(`${f.sim.id}: tile title is not the catalogue title "${f.sim.title}"`);
        if (!f.live || !decode(t.body).includes(f.live)) fail(`${f.sim.id}: tile copy differs from FIXTURE_LIVE`);
        if (!/data-lp-latest hidden/.test(t.body)) fail(`${f.sim.id}: tile has no hidden [data-lp-latest] slot`);
        if ((f.sim.tier !== 'public') !== /class="lp-tier"/.test(t.body)) fail(`${f.sim.id}: tier chip does not match catalogue tier "${f.sim.tier}"`);
        if (f.latest && M.simForEntry(f.latest).sim.id !== f.sim.id) fail(`${f.sim.id}: latest entry is about another simulation`);
    }
    if (Object.keys(M.FIXTURE_LIVE).sort().join() !== [...M.FIXTURE_IDS].sort().join()) fail('FIXTURE_LIVE keys ≠ FIXTURE_IDS');
    let threw = false;
    try { M.fixtures({ catalog: SIMULATIONS.filter((s) => s.id !== 'mars') }); } catch { threw = true; }
    if (!threw) fail('fixtures() must throw when a fixture leaves the catalogue');
});

// ── 4. section doors ────────────────────────────────────────────────────────
section('section doors are the site sections\' hub pages', () => {
    const doors = M.sectionDoors();
    if (doors.length !== SITE_SECTIONS.length) fail('door count');
    for (const d of doors) {
        const re = new RegExp(`<a class="lp-door" href="${d.href.replace('.', '\\.')}" data-funnel-cta="launchpad_section_${d.id}">([^<]+)</a>`);
        const m = html.match(re);
        if (!m) fail(`no door for ${d.id} → ${d.href}`);
        else if (decode(m[1]) !== d.label) fail(`door label "${decode(m[1])}" ≠ "${d.label}"`);
        if (!(d.count > 0)) fail(`${d.id} has no simulations`);
    }
});

// ── 5. thumbnails ───────────────────────────────────────────────────────────
section('thumbnails are current with the showcase manifest and every referenced file exists', () => {
    try { execFileSync('python3', [path.join(ROOT, 'scripts/build-launchpad-thumbs.py'), '--check'], { stdio: 'pipe' }); }
    catch (e) { fail('build-launchpad-thumbs.py --check: ' + String(e.stdout || e.message).trim()); }
    for (const t of tiles) {
        const img = t.body.match(/<img src="([^"]+)"/);
        if (LAUNCHPAD_MEDIA[t.id]) {
            if (!img) fail(`${t.id} has a capture but its tile shows no thumbnail`);
            else if (img[1] !== `assets/home/launchpad/${t.id}-480.jpg`) fail(`${t.id}: thumbnail path ${img[1]}`);
            else if (!existsSync(path.join(ROOT, img[1]))) fail(`${img[1]} missing`);
        } else {
            if (img) fail(`${t.id} has no capture but its tile references ${img[1]}`);
            if (!/class="lp-plate"/.test(t.body)) fail(`${t.id} has no capture and no plate`);
        }
    }
    for (const s of M.recentSlides()) {
        if (LAUNCHPAD_MEDIA[s.sim.id] && !existsSync(path.join(ROOT, `assets/home/launchpad/${s.sim.id}-960.jpg`))) fail(`carousel thumbnail for ${s.sim.id} missing`);
    }
});

// ── 6. the page ─────────────────────────────────────────────────────────────
section('index.html mounts the launchpad and no longer boots the live hero; live-sky.html does', () => {
    if (!/import\('\.\/js\/home-launchpad\.js'\)/.test(html)) fail('index.html does not import js/home-launchpad.js');
    for (const hook of ['data-lp-recent', 'data-lp-log', 'data-lp-count']) if (!html.includes(hook)) fail(`index.html has no [${hook}]`);
    if (!/<section id="hero"/.test(html)) fail('the first screen must keep id="hero" (the CTA rail observes it)');
    if (!/<h1 class="hero-h1">Watch space weather happen\. Live\.<\/h1>/.test(html)) fail('the H1 is an experiment winner — do not reword it without a new experiment');
    // Mentions inside comments (which explain the move) are fine; live markup is not.
    const live = html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const gone of ['hero-space-weather.js', 'home-sky-console.js', 'id="hero-canvas"', 'three.module.js" crossorigin']) {
        if (live.includes(gone)) fail(`index.html still carries ${gone}`);
    }
    const sky = readFileSync(path.join(ROOT, 'live-sky.html'), 'utf8');
    for (const need of ['id="hero-canvas"', 'id="sky-console-host"', 'id="hero-stage"', "import('./js/hero-space-weather.js')", 'initSkyConsole(']) {
        if (!sky.includes(need)) fail(`live-sky.html lost ${need}`);
    }
    if (!/rel="canonical" href="https:\/\/parkersphysics\.com\/live-sky\.html"/.test(sky)) fail('live-sky.html canonical');
    if (!html.includes('href="live-sky.html"')) fail('the homepage does not link live-sky.html');
});

console.log(failures ? `\n❌ ${failures} failure(s)` : '\n✅ home launchpad');
process.exit(failures ? 1 : 0);
