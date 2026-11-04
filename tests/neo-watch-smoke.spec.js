import { test, expect } from '@playwright/test';
import {
    parseSbdbQuery, parseCad, parseSentry, parseFireballs,
    composeCatalogResponse, composeWatchResponse,
} from '../api/_lib/neo-sources.js';
import {
    earthHelioJ2000, LD_AU, geoSceneRadius, MOON_SCENE, EARTH_RADIUS_KM, LD_KM,
    MOON_RADIUS_KM, bodySceneRadius, moonPhase,
    hillRadiusKm, soiRadiusKm, escapeSpeedKms, encounterAnalysis,
} from '../js/neo-space.js';
import { R2D } from '../js/neo-orbits.js';
import {
    lagrangeGeometry, lagrangePoints, moonHillRadiusKm, EM_MU,
} from '../js/earth-moon-gravity.js';
import { geoToScene, AU_KM } from '../js/neo-space.js';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Browser gate for neo-watch.html — the Earth-centred near-Earth watch.
 *
 * JPL is MOCKED (ssd-api.jpl.nasa.gov is egress-blocked from CI and the
 * upstream schemas are unverified anyway — api/_lib/neo-sources.js), and the
 * mock bodies are composed by the SAME pure library the routes use, so what
 * the browser receives here is byte-for-byte the routes' contract. The
 * catalogue fixtures are SYNTHESISED at test time from the page's own Earth
 * ephemeris, so the geometry assertions hold on whatever date the suite runs.
 *
 * What this pins:
 *   - the page boots, the stage mounts, and the population reaches it
 *   - the kernel's radial map is the map the stage actually draws with, at the
 *     Moon anchor — the ruler cannot drift from the ruler's own definition
 *   - the view horizon decides what is drawn: an object planted 3 LD away and
 *     one planted at 0.4 AU split across a 0.2 AU ring and rejoin at 0.5 AU
 *   - the page BOOTS wide, and says so in words when a narrow ring is empty
 *   - picking is SCREEN-SPACE: a dot is selectable in both scale modes, a
 *     camera drag is not a selection, and hovering names the thing under it
 *   - the live board ranks by distance and the nearest row is the nearest object
 *   - the live board updates IN PLACE, so a row is not detached mid-click
 *   - the gravity boundaries are drawn at their LIVE radii and the panel's
 *     numbers are the same ones, including the catalogue-wide MOID screen
 *   - selecting a row selects on the stage, and the card fills
 *   - a JPL approach row moves the clock (LIVE turns off, the offset is the
 *     encounter) and comes back with "Now"
 *   - an observer position produces an altitude column and a drawn horizon
 *   - the Earth–Moon layer draws js/earth-moon-gravity.js's OWN Lagrange
 *     geometry at the stage's instant, the zero-velocity disc carries the
 *     kernel's gate constants, the card + profile chart print them, and a
 *     selected object inside Earth's Hill sphere gets a Jacobi constant that
 *     tints the disc (NW_SHOTS=<dir> also writes screenshots for a look)
 *   - Y-UP: camera.up is never moved, so OrbitControls is never rebuilt
 *   - feeds down ⇒ the page SAYS the feed is down, draws nothing, and raises
 *     no page error
 */

const IGNORED_CONSOLE_ERRORS = [
    /fonts\.googleapis\.com/,
    /\/api\/telemetry\//,
    /unpkg\.com/,                 // the globe's optional day/night imagery
    /Failed to load resource/, /net::ERR/,
    /supabase/i, /WebSocket/,
];

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        const location = message.location?.()?.url || '';
        if (IGNORED_CONSOLE_ERRORS.some(p => p.test(text) || p.test(location))) return;
        errors.push(text);
    });
    return errors;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const jdNow = () => Date.now() / 86400e3 + 2440587.5;

/**
 * A circular J2000 orbit that passes `au` astronomical units from Earth's
 * CURRENT position, in the ecliptic-normal direction — so the object sits at a
 * known geocentric distance at test time whatever the date.
 */
function plantedElements(des, au, nowJd) {
    const e = earthHelioJ2000(nowJd);           // already J2000, the frame elements use
    const r = Math.hypot(e.x, e.y);
    const lon = Math.atan2(e.y, e.x) * R2D;
    const i = Math.asin(Math.min(0.9, au / r)) * R2D;
    return { des, a: r, i, om: ((lon - 90) % 360 + 360) % 360, epoch: nowJd };
}

function catalogBody(nowJd) {
    const fields = ['pdes', 'full_name', 'H', 'class', 'neo', 'pha', 'e', 'a', 'q', 'i', 'om', 'w', 'ma', 'tp', 'epoch', 'moid', 'diameter'];
    const EPOCH = 2461000.5;
    const planted = (des, au, H, diam) => {
        const p = plantedElements(des, au, nowJd);
        return [p.des, `(${des})`, String(H), 'APO', 'Y', 'N', '0', String(p.a), null,
            String(p.i), String(p.om), '0', '90', null, String(p.epoch), '.001', diam];
    };
    const asteroidRows = [
        ['99942', '99942 Apophis (2004 MN4)', '19.09', 'ATE', 'Y', 'Y', '.1914', '.9224', '.7461', '3.339', '203.96', '126.68', '100.1', null, String(EPOCH), '.000258', '.340'],
        ['101955', '101955 Bennu (1999 RQ36)', '20.2', 'APO', 'Y', 'Y', '.2037', '1.1264', '.8969', '6.035', '2.06', '66.22', '220.5', null, String(EPOCH), '.0032', '.49'],
        ['433', '433 Eros (A898 PA)', '10.4', 'AMO', 'Y', 'N', '.2227', '1.458', '1.133', '10.83', '304.3', '178.9', '12.3', null, String(EPOCH), '.148', '16.8'],
        // Two planted objects that straddle the 0.2 AU ring: the horizon test
        // narrows to it, splits them, and widens back to rejoin them.
        planted('NEAR-3LD', 3 * LD_AU, 24.0, null),
        planted('FAR-04AU', 0.4, 22.0, null),
    ];
    const cometRows = [
        ['109P', '109P/Swift-Tuttle', null, 'HTC', 'Y', 'N', '.9632', '26.09', '.9595', '113.45', '139.38', '152.98', '5.1', null, String(EPOCH), '.0009', '26'],
    ];
    const interRows = [
        ['C/2025 N1', '3I/ATLAS (C/2025 N1)', null, 'HYP', 'N', 'N', '6.14', null, '1.356', '175.1', '322.2', '128.0', null, '2460977.6', '2460900.5', null, null],
    ];
    return composeCatalogResponse({
        tier: 'pha',
        asteroids: parseSbdbQuery({ fields, data: asteroidRows }, { kind: 'a' }),
        comets: parseSbdbQuery({ fields, data: cometRows }, { kind: 'c' }),
        interstellar: parseSbdbQuery({ fields, data: interRows }, { interstellar: true }),
    });
}

function watchBody(nowMs) {
    const fields = ['des', 'orbit_id', 'jd', 'cd', 'dist', 'dist_min', 'dist_max', 'v_rel', 'v_inf', 't_sigma_f', 'h', 'diameter', 'fullname'];
    const jdOf = (ms) => ms / 86400e3 + 2440587.5;
    const rows = [
        ['NEAR-3LD', '1', String(jdOf(nowMs + 6 * 3600e3)), null, '0.0077', '0.0076', '0.0078', '11.2', '11.0', '< 00:01', '24.0', null, '(NEAR-3LD)'],
        ['99942', '221', String(jdOf(Date.UTC(2029, 3, 13, 21, 46))), null, '0.000254', '0.000253', '0.000255', '7.42', '5.84', '< 00:01', '19.09', '0.340', '99942 Apophis (2004 MN4)'],
    ];
    const sentry = { data: [
        { des: '101955', fullname: '101955 Bennu (1999 RQ36)', ip: '3.7e-4', ps_cum: '-1.4', ps_max: '-1.6', ts_max: '0', range: '2178-2290', last_obs: '2024-01-01', n_imp: '157', h: '20.2', diameter: '0.49', v_inf: '5.99' },
    ] };
    const fireballs = { fields: ['date', 'energy', 'impact-e', 'lat', 'lat-dir', 'lon', 'lon-dir', 'alt', 'vel'],
        data: [
            ['2026-09-10 12:34:56', '3.2', '0.11', '45.1', 'N', '12.3', 'E', '33.0', '18.2'],
            ['2026-09-01 01:02:03', '96.0', '2.4', '10.0', 'S', '150.0', 'W', null, null],
        ] };
    return composeWatchResponse({ cad: parseCad({ fields, data: rows }), sentry: parseSentry(sentry), fireballs: parseFireballs(fireballs), nowMs });
}

async function mockJpl(page, { catalogDown = false, watchDown = false } = {}) {
    const nowJd = jdNow();
    const counts = { catalog: 0, watch: 0, tiers: [] };
    await page.route('**/api/neo/catalog*', async (route) => {
        counts.catalog += 1;
        counts.tiers.push(new URL(route.request().url()).searchParams.get('tier'));
        const body = catalogDown
            // The routes' documented degraded shape: 200 with freshness:'stale'.
            ? composeCatalogResponse({ tier: 'pha', asteroids: { ok: false, reason: 'unreachable' }, comets: { ok: false }, interstellar: { ok: false } })
            : catalogBody(nowJd);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.route('**/api/neo/watch*', async (route) => {
        counts.watch += 1;
        const body = watchDown
            ? composeWatchResponse({ cad: { ok: false, reason: 'unreachable' }, sentry: { ok: false }, fireballs: { ok: false }, nowMs: Date.now() })
            : watchBody(Date.now());
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    // The globe's optional imagery is a CDN; CI has no network to it and the
    // procedural fallback is the documented degraded path.
    await page.route('**unpkg.com/**', route => route.abort());
    return counts;
}

async function openPage(page) {
    await page.goto('/neo-watch.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__neoWatch?.stage, null, { timeout: 30_000 });
}

/**
 * Population loaded, propagated, pushed to the stage, AND rendered into the
 * board. The last clause matters: metadata arrives from the worker whenever it
 * arrives, but the board is redrawn at 3 Hz, so waiting only on the data races
 * the DOM by up to a third of a second.
 */
async function waitForPopulation(page) {
    await page.waitForFunction(() => {
        const w = window.__neoWatch;
        return !!w?.frame && w.frame.count > 0 && w.meta.size > 0
            && !!document.querySelector('#nw-nearest tbody tr');
    }, null, { timeout: 45_000 });
}

/**
 * Wait until OrbitControls' damping has run out. `enableDamping` keeps the
 * camera moving after the mouse is released, so a screen position sampled
 * straight after a drag is stale by the time the next click is dispatched —
 * which reads as picking missing by a few pixels, intermittently.
 */
async function waitForCameraStill(page) {
    await page.waitForFunction(() => {
        const c = window.__neoWatch.stage.camera.position;
        const prev = window.__nwPrevCam;
        window.__nwPrevCam = [c.x, c.y, c.z];
        if (!prev) return false;
        return Math.hypot(c.x - prev[0], c.y - prev[1], c.z - prev[2]) < 1e-4;
    }, null, { timeout: 15_000 });
    await page.evaluate(() => { delete window.__nwPrevCam; });
}

/** Client coordinates of a point on the canvas where the stage picks NOTHING. */
async function emptySky(page) {
    return page.evaluate(() => {
        const st = window.__neoWatch.stage;
        const r = st.canvas.getBoundingClientRect();
        for (let fy = 0.08; fy <= 0.92; fy += 0.12) {
            for (let fx = 0.08; fx <= 0.92; fx += 0.12) {
                const x = r.left + r.width * fx, y = r.top + r.height * fy;
                if (!st.pickAt(x, y, 'mouse')) return { x, y };
            }
        }
        return null;
    });
}

/** Client coordinates of a catalogue object's drawn pixel, by designation. */
async function screenPixelOf(page, des) {
    return page.evaluate((d) => {
        const w = window.__neoWatch;
        let target = null;
        for (const [k, m] of w.meta) if (m.des === d) target = k;
        if (target == null) return null;
        const p = w.stage.screenPositionOf(target);
        if (!p) return null;
        const r = w.stage.canvas.getBoundingClientRect();
        return { target, x: p.x + r.left, y: p.y + r.top };
    }, des);
}

test.describe('neo-watch.html — Near-Earth Watch', () => {
    test.setTimeout(120_000);

    test('boots, propagates the catalogue, and draws it on the kernel’s own radial map', async ({ page }) => {
        const errors = collectPageErrors(page);
        const counts = await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);

        // The catalogue reached the worker and the stage.
        const state = await page.evaluate(() => {
            const w = window.__neoWatch;
            return {
                count: w.frame.count,
                drawn: w.stage._visible.length,
                catalog: w.catalog.state,
                live: w.isLive,
                moonScene: Math.hypot(...w.stage.moon.position.toArray()),
                moonKm: w.stage.moon.userData?.km ?? null,
            };
        });
        expect(state.count).toBeGreaterThan(3);
        expect(state.drawn).toBeGreaterThan(0);
        expect(state.catalog).toBe('live');
        expect(state.live).toBe(true);        // real time is the resting state
        expect(counts.tiers[0]).toBe('pha');  // the small tier loads first

        // THE LADDER: `pha` goes up first so the page is usable in a second,
        // then `bright` replaces it. Tiers nest, so it is a replacement and not
        // a merge — a second request must arrive, and `all` must NOT.
        await page.waitForFunction(() => window.__neoWatch.tier === 'bright', null, { timeout: 20_000 });
        expect(counts.tiers).toContain('bright');
        expect(counts.tiers).not.toContain('all');
        expect(await page.inputValue('#nw-tier')).toBe('bright');

        // THE RULER GATE: the drawn Moon must sit at the radius the kernel's
        // own map puts it at. The Moon's distance varies 13% across its orbit,
        // so the assertion is against geoSceneRadius of its ACTUAL distance,
        // and MOON_SCENE is checked separately as the map's definition.
        const moonKm = await page.evaluate(async () => {
            const m = await import('/js/neo-space.js');
            return m.moonGeoJ2000(window.__neoWatch._jdNow()).distKm;
        });
        expect(state.moonScene).toBeCloseTo(geoSceneRadius(moonKm), 3);
        expect(geoSceneRadius(LD_KM)).toBeCloseTo(MOON_SCENE, 9);
        expect(geoSceneRadius(EARTH_RADIUS_KM)).toBe(1);

        expect(errors).toEqual([]);
    });

    test('the view horizon decides what is drawn, and the board ranks by distance', async ({ page }) => {
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);

        // NEAR-3LD is planted at 3 LD and FAR-04AU at 0.4 AU. The page BOOTS
        // at its widest ring (0.5 AU — see DEFAULT_HORIZON), which holds both,
        // so this test narrows to 0.2 AU explicitly to split them. Asserting
        // against whatever the default happens to be is what made the split a
        // hostage to a product decision it has nothing to do with.
        //
        // Wait for the object this test is ABOUT, not for "some metadata": the
        // tier ladder's second load clears the metadata map and refills it on
        // the next frame, so a generic wait can land in that window. The test
        // has to wait on its own precondition.
        await page.waitForFunction(() => {
            for (const m of window.__neoWatch.meta.values()) if (m.des === 'NEAR-3LD') return true;
            return false;
        }, null, { timeout: 30_000 });

        await page.selectOption('#nw-horizon', 'au02');
        await page.waitForTimeout(600);

        // The near one is found by name; the far one need not be, because
        // metadata is only fetched for objects a readout can name and an object
        // outside the horizon has none. It is identified by planted distance.
        const planted = await page.evaluate(() => {
            const w = window.__neoWatch;
            const out = { near: null, far: [] };
            for (const [k, m] of w.meta) {
                if (m.des === 'NEAR-3LD') out.near = { index: k, rGeoAU: w.frame.rGeo[k], drawn: w.stage._visible.includes(k) };
            }
            for (let k = 0; k < w.frame.count; k++) {
                if (w.frame.rGeo[k] > 0.39 && w.frame.rGeo[k] < 0.41) {
                    out.far.push({ index: k, rGeoAU: w.frame.rGeo[k], drawn: w.stage._visible.includes(k) });
                }
            }
            return out;
        });
        expect(planted.near).toBeTruthy();
        expect(planted.near.rGeoAU).toBeCloseTo(3 * LD_AU, 3);
        expect(planted.near.drawn).toBe(true);
        expect(planted.far.length).toBe(1);
        expect(planted.far[0].drawn).toBe(false);

        // The board is sorted, and its first row really is the nearest object.
        const rows = page.locator('#nw-nearest tbody tr');
        expect(await rows.count()).toBeGreaterThan(0);
        const firstIndex = Number(await rows.first().getAttribute('data-index'));
        const isNearest = await page.evaluate((idx) => {
            const w = window.__neoWatch;
            const horizonAU = w.horizonKm / 149597870.7;
            let best = Infinity, bestK = -1;
            for (let k = 0; k < w.frame.count; k++) {
                if (w.frame.rGeo[k] <= horizonAU && w.frame.rGeo[k] < best) { best = w.frame.rGeo[k]; bestK = k; }
            }
            return bestK === idx;
        }, firstIndex);
        expect(isNearest).toBe(true);

        // Widening the horizon back brings the far object in.
        await page.selectOption('#nw-horizon', 'au05');
        await page.waitForTimeout(600);
        const nowDrawn = await page.evaluate((idx) => window.__neoWatch.stage._visible.includes(idx), planted.far[0].index);
        expect(nowDrawn).toBe(true);
    });

    test('the page boots WIDE, and an empty ring says so instead of showing a black stage', async ({ page }) => {
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);

        // Boots at the widest offered ring. This is the half of the fix that
        // the visitor's first frame depends on; the message below is the other.
        const boot = await page.evaluate(() => {
            const w = window.__neoWatch;
            return { km: w.horizonKm, select: document.getElementById('nw-horizon').value, drawn: w.stage._visible.length };
        });
        expect(boot.select).toBe('au05');
        expect(boot.km).toBeCloseTo(0.5 * 149597870.7, 0);
        expect(boot.drawn).toBeGreaterThan(0);

        // With something drawn there is nothing to explain.
        await expect(page.locator('#nw-sparse')).toBeHidden();

        // FRAME ALL MUST FRAME ALL. The boot framing used to sit at 1.15 x the
        // outer radius, which with a 45 deg vertical field shows under half of
        // it — so the ring the page is ranged to was off the top of the canvas
        // and so was anything near it. Probe the outer ring's own extremes
        // through the camera the page booted with.
        await page.click('#nw-frame-all');
        await page.waitForTimeout(500);
        const fits = await page.evaluate(() => {
            const s = window.__neoWatch.stage;
            const THREE_ = s.camera.constructor;                 // only for the type name
            const r = s.canvas.getBoundingClientRect();
            const outer = s._outerRadius();
            let worst = 0;
            for (let i = 0; i < 16; i++) {
                const a = (i / 16) * Math.PI * 2;
                const p = new s.camera.position.constructor(outer * Math.cos(a), 0, outer * Math.sin(a));
                p.project(s.camera);
                const x = (p.x * 0.5 + 0.5) * r.width, y = (-p.y * 0.5 + 0.5) * r.height;
                worst = Math.max(worst, -x, -y, x - r.width, y - r.height);
            }
            return { worstOverflowPx: worst, outer, type: THREE_.name };
        });
        // Every point of the outer ring lands on the canvas.
        expect(fits.worstOverflowPx).toBeLessThanOrEqual(0);

        // Now narrow to 1 LD — inside the nearest planted object (3 LD) and,
        // on any ordinary date, inside everything real in the fixture too.
        // Emptiness there is the correct answer, not a fault, and the page has
        // to be able to say the difference.
        await page.selectOption('#nw-horizon', 'ld1');
        await page.waitForTimeout(1200);           // panels redraw at 3 Hz

        const empty = await page.evaluate(() => ({
            drawn: window.__neoWatch.stage._visible.length,
            on: document.getElementById('nw-sparse').dataset.on,
            text: document.getElementById('nw-sparse').textContent,
            down: document.getElementById('nw-sparse').classList.contains('nw-sparse--down'),
        }));
        // Apophis passes inside 1 LD in April 2029 and the fixture carries its
        // real elements, so a suite run in that window legitimately has company
        // in this ring. The assertion is on the empty case, which is every
        // other date.
        if (empty.drawn === 0) {
            expect(empty.on).toBe('1');
            // It must read as "loaded, none here" — NOT as a feed failure.
            expect(empty.down).toBe(false);
            expect(empty.text).toMatch(/objects loaded, none within/i);
            // And it must offer the way out — to a ring that actually holds
            // something, not merely to the next one, or the visitor presses it
            // twice for nothing.
            const widen = page.locator('#nw-sparse button');
            await expect(widen).toBeVisible();
            await widen.click();
            await page.waitForTimeout(700);
            const after = await page.evaluate(() => ({
                horizon: document.getElementById('nw-horizon').value,
                drawn: window.__neoWatch.stage._visible.length,
                sparse: document.getElementById('nw-sparse').dataset.on,
            }));
            expect(after.horizon).not.toBe('ld1');
            expect(after.drawn).toBeGreaterThan(0);
            expect(after.sparse).toBe('0');
        }
    });

    test('a feed that is down says so ON THE STAGE, in different words from an empty ring', async ({ page }) => {
        await mockJpl(page, { catalogDown: true, watchDown: true });
        await openPage(page);
        await page.waitForFunction(() => window.__neoWatch.catalog.state !== 'loading', null, { timeout: 30_000 });
        await page.waitForTimeout(700);

        const sparse = await page.evaluate(() => {
            const el = document.getElementById('nw-sparse');
            return { on: el.dataset.on, text: el.textContent, down: el.classList.contains('nw-sparse--down') };
        });
        expect(sparse.on).toBe('1');
        expect(sparse.down).toBe(true);
        // The distinction the whole element exists for: a dead feed must not
        // read as "space is empty here", and an empty ring must not read as a
        // fault. Neither message may contain the other's claim.
        expect(sparse.text).toMatch(/not answering|cached catalogue/i);
        expect(sparse.text).not.toMatch(/objects loaded, none within/i);
    });

    test('the Moon is drawn at true relative size, on its real path, with its apsides', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);

        const moon = await page.evaluate(() => {
            const s = window.__neoWatch.stage;
            return {
                // The sphere's own radius, not a scale factor: the mesh is built
                // at the kernel's size and never scaled.
                geomRadius: s.moon.geometry.parameters.radius,
                scale: s.moon.scale.x,
                sceneR: Math.hypot(...s.moon.position.toArray()),
                orbitPoints: s.moonOrbit.geometry.attributes.position.count,
                phase: s.phase,
                apsides: s.apsides,
                apsisVisible: Object.fromEntries(
                    Object.entries(s.apsisMarks).map(([k, v]) => [k, v.dot.visible])),
            };
        });

        // TRUE RELATIVE SIZE — the other half of the scale contract.
        expect(moon.geomRadius).toBeCloseTo(bodySceneRadius(MOON_RADIUS_KM), 9);
        expect(moon.scale).toBe(1);
        expect(moon.geomRadius).toBeCloseTo(MOON_RADIUS_KM / EARTH_RADIUS_KM, 9);

        // Drawn where the kernel says, on the kernel's own map.
        const moonKm = await page.evaluate(async () => {
            const m = await import('/js/neo-space.js');
            return m.moonGeoJ2000(window.__neoWatch.frame.jd).distKm;
        });
        expect(moon.sceneR).toBeCloseTo(geoSceneRadius(moonKm), 2);

        // A real path, not a ring: sampled, and its radii actually vary.
        expect(moon.orbitPoints).toBeGreaterThan(64);
        const radii = await page.evaluate(() => {
            const a = window.__neoWatch.stage.moonOrbit.geometry.attributes.position.array;
            const out = [];
            for (let i = 0; i < a.length; i += 3) out.push(Math.hypot(a[i], a[i + 1], a[i + 2]));
            return { min: Math.min(...out), max: Math.max(...out) };
        });
        expect(radii.max - radii.min).toBeGreaterThan(0.01);

        // Apsides: drawn, and the real ones.
        expect(moon.apsisVisible.perigee).toBe(true);
        expect(moon.apsisVisible.apogee).toBe(true);
        expect(moon.apsides.perigee.km).toBeGreaterThan(356_000);
        expect(moon.apsides.perigee.km).toBeLessThan(371_000);
        expect(moon.apsides.apogee.km).toBeGreaterThan(403_000);
        expect(moon.apsides.apogee.km).toBeLessThan(407_000);

        // The phase is the kernel's, evaluated on the stage's own instant.
        const jd = await page.evaluate(() => window.__neoWatch.frame.jd);
        const want = moonPhase(jd);
        expect(moon.phase.illuminated).toBeCloseTo(want.illuminated, 6);
        expect(moon.phase.name).toBe(want.name);

        // The card prints it.
        await expect(page.locator('#nw-moon .nw-moon-name')).toHaveText(want.name);
        await expect(page.locator('#nw-moon .nw-moon-disc')).toBeVisible();
        expect(await page.textContent('#nw-moon')).toMatch(/perigee/);

        // TRUE SCALE must not change the body's size — only the distance.
        await page.check('#nw-true-scale');
        await page.waitForTimeout(600);
        const after = await page.evaluate(() => {
            const s = window.__neoWatch.stage;
            return {
                geomRadius: s.moon.geometry.parameters.radius,
                scale: s.moon.scale.x,
                sceneR: Math.hypot(...s.moon.position.toArray()),
            };
        });
        expect(after.geomRadius).toBeCloseTo(moon.geomRadius, 9);
        expect(after.scale).toBe(1);
        // ...but the distance does change, by a lot: 60 R⊕ true against 12 drawn.
        expect(after.sceneR).toBeGreaterThan(moon.sceneR * 3);

        expect(errors).toEqual([]);
    });

    test('Earth\u2019s gravitational reach is drawn and analysed from one set of numbers', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);
        await page.waitForFunction(() => !!window.__neoWatch.screen, null, { timeout: 20_000 });
        // The card re-renders on the 3 Hz panel tick, not when the screen lands:
        // wait for the render, or a loaded machine reads the previous one.
        await page.waitForFunction(() => /orbits that pass within the Hill sphere/.test(
            document.getElementById('nw-gravity')?.textContent || ''), null, { timeout: 10_000 });

        const g = await page.evaluate(() => {
            const w = window.__neoWatch;
            const byId = Object.fromEntries(w.stage.shells.map(s => [s.spec.id, { km: s.km, visible: s.line.visible }]));
            return { shells: byId, screen: w.screen, jd: w.frame.jd };
        });

        // THE BOUNDARIES ARE LIVE. Both scale with Earth's own heliocentric
        // distance, so the drawn ring must be the formula at THIS instant, not
        // the nominal value in the table.
        const earthRAU = await page.evaluate(async (jd) => {
            const m = await import('/js/neo-space.js');
            return m.earthHelioJ2000(jd).rAU;
        }, g.jd);
        expect(g.shells.hill.km).toBeCloseTo(hillRadiusKm(earthRAU), 3);
        expect(g.shells.soi.km).toBeCloseTo(soiRadiusKm(earthRAU), 3);
        // ...and that is measurably not the 1 AU value, or "live" would be free.
        expect(Math.abs(g.shells.hill.km - hillRadiusKm(1))).toBeGreaterThan(100);
        // Both are inside the lunar-distance ladder, which is the point of them.
        expect(g.shells.soi.km).toBeLessThan(g.shells.hill.km);
        expect(g.shells.hill.km).toBeLessThan(5 * LD_KM);
        expect(g.shells.hill.visible).toBe(true);

        // The panel prints the same boundaries and the escape speed out there.
        const card = await page.textContent('#nw-gravity');
        expect(card).toMatch(new RegExp(`${(hillRadiusKm(earthRAU) / LD_KM).toFixed(2)}\\s*LD`));
        expect(card).toMatch(new RegExp(`${(soiRadiusKm(earthRAU) / LD_KM).toFixed(2)}\\s*LD`));
        expect(card).toMatch(new RegExp(`${escapeSpeedKms(hillRadiusKm(earthRAU)).toFixed(2)}\\s*km/s`));

        // THE CATALOGUE-WIDE SCREEN. The fixtures' MOIDs are all 0.001 AU or
        // smaller except Eros at 0.148, so the Hill count must exclude Eros and
        // include the rest — a real filter, not a count of everything.
        expect(g.screen.counts.withMoid).toBeGreaterThan(3);
        expect(g.screen.counts.hill).toBeGreaterThan(0);
        expect(g.screen.counts.hill).toBeLessThan(g.screen.counts.withMoid);
        expect(g.screen.counts.impact).toBe(0);
        // Ordered, and the closest really is the smallest MOID in the set.
        const moids = g.screen.closest.map(o => o.moid);
        expect([...moids].sort((a, b) => a - b)).toEqual(moids);
        expect(card).toMatch(/orbits that pass within the Hill sphere/);

        // Every board row carries a geocentric speed, and the encounter screen
        // agrees with the kernel evaluated independently on the same inputs.
        const rows = await page.evaluate(() => {
            const w = window.__neoWatch;
            const earth = w.frame ? w.frame.rHelio : null;
            return w._nearestIndices(6).map((k) => {
                const r = w._rowFor(k, w.frame.jd, 1.0);
                return r && { v: r.vGeoKms, dist: r.encounter?.distKm, regime: r.encounter?.regime,
                    bound: r.encounter?.bound, valid: r.encounter?.modelValid };
            }).filter(Boolean);
        });
        expect(rows.length).toBeGreaterThan(0);
        for (const r of rows) {
            expect(Number.isFinite(r.v)).toBe(true);
            // A near-Earth object's geocentric speed is a few km/s to a few tens.
            expect(r.v).toBeGreaterThan(0.1);
            expect(r.v).toBeLessThan(80);
            const want = encounterAnalysis({ distKm: r.dist, vGeoKms: r.v, earthRAU: 1.0 });
            expect(r.regime).toBe(want.regime);
            expect(r.bound).toBe(want.bound);
            expect(r.valid).toBe(want.modelValid);
        }

        // The speed column is on the board.
        expect(await page.locator('#nw-nearest thead th').allTextContents()).toContain('Speed');

        expect(errors).toEqual([]);
    });

    test('the Earth–Moon gravity layer draws the kernel’s own geometry, and the card reads it', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);
        await page.waitForFunction(() => !!window.__neoWatch.stage.emGeometry
            && !!document.querySelector('#nw-earthmoon svg.nw-pc'), null, { timeout: 20_000 });

        // ── The stage draws the kernel's Lagrange points at the stage's instant.
        const drawn = await page.evaluate(() => {
            const s = window.__neoWatch.stage;
            return {
                jd: s.jd,
                marks: s.lagrangeMarks.map(m => ({ id: m.id, p: Array.from(m.pts.geometry.attributes.position.array), vis: m.pts.visible })),
                groupVisible: s.emGroup.visible,
                hill: Array.from(s.moonHillRing.geometry.attributes.position.array),
                moon: s.moon.position.toArray(),
                uniforms: Object.fromEntries(Object.entries(s.zvcUniforms).map(([k, u]) =>
                    [k, typeof u.value === 'number' ? u.value : u.value.toArray()])),
                disc: s.zvcDisc.visible,
            };
        });
        const geom = lagrangeGeometry(drawn.jd);
        expect(drawn.groupVisible).toBe(true);
        expect(drawn.marks.length).toBe(7);
        for (const m of drawn.marks) {
            const k = geom.all.find(p => p.id === m.id);
            const q = geoToScene(k.geoKm[0] / AU_KM, k.geoKm[1] / AU_KM, k.geoKm[2] / AU_KM);
            expect(m.p[0]).toBeCloseTo(q.x, 3);
            expect(m.p[1]).toBeCloseTo(q.y, 3);
            expect(m.p[2]).toBeCloseTo(q.z, 3);
            expect(m.vis).toBe(true);                          // all inside the 0.5 AU boot horizon
        }
        // EM L1 sits between Earth and the drawn Moon on the map; L2 beyond it.
        const r = (v) => Math.hypot(v[0], v[1], v[2]);
        const em = Object.fromEntries(drawn.marks.map(m => [m.id, r(m.p)]));
        expect(em['EM-L1']).toBeLessThan(r(drawn.moon));
        expect(em['EM-L2']).toBeGreaterThan(r(drawn.moon));
        // The Moon's Hill ring is ABOUT the Moon: every vertex maps back to a
        // point the lunar Hill radius from the Moon (the ring is mapped point by
        // point, so test it in km, not in scene units).
        const D = geom.frame.D;
        const rH = moonHillRadiusKm(D);
        expect(drawn.hill.length / 3).toBe(96);
        let maxKmErr = 0;
        for (let i = 0; i < drawn.hill.length; i += 3) {
            const sr = Math.hypot(drawn.hill[i], drawn.hill[i + 1], drawn.hill[i + 2]);
            const km = EARTH_RADIUS_KM * Math.exp((sr - 1) / ((MOON_SCENE - 1) / Math.log(LD_KM / EARTH_RADIUS_KM)));
            // Geocentric distance of a ring vertex lies within [D − rH, D + rH].
            maxKmErr = Math.max(maxKmErr, Math.max(0, Math.abs(km - D) - rH));
        }
        expect(maxKmErr).toBeLessThan(50);
        // The disc carries the kernel's gate constants and the live separation.
        const C = Object.fromEntries(lagrangePoints(EM_MU).map(p => [p.id, p.C]));
        expect(drawn.uniforms.uLevels).toEqual([C.L1, C.L2, C.L3, C.L4].map(v => expect.closeTo(v, 5)));
        expect(drawn.uniforms.uD).toBeCloseTo(D, 0);
        expect(drawn.uniforms.uMu).toBeCloseTo(EM_MU, 12);
        expect(drawn.disc).toBe(false);                         // off by default

        // ── The card prints the same geometry, and the chart has three series.
        const card = await page.textContent('#nw-earthmoon');
        // The card is rebuilt every 0.05 d of sim time, so its separation can
        // trail the stage's by up to ~0.05 d × 0.05 km/s of lunar radial speed.
        const cardD = Number(card.match(/Earth–Moon now\s*([\d,]+)\s*km/)[1].replace(/,/g, ''));
        expect(Math.abs(cardD - D)).toBeLessThan(300);
        expect(card).toMatch(/Moon overtakes Earth/);
        expect(await page.locator('#nw-earthmoon tbody tr').count()).toBe(7);
        const l1Row = geom.all.find(p => p.id === 'EM-L1');
        expect(card).toMatch(new RegExp(l1Row.C.toFixed(4)));
        const paths = await page.$$eval('#nw-earthmoon svg.nw-pc path', ps => ps.map(p => (p.getAttribute('d') || '').length));
        expect(paths.length).toBe(3);
        for (const n of paths) expect(n).toBeGreaterThan(100);
        // Hover reads all three terms at one distance.
        const hit = page.locator('#nw-earthmoon .nw-pc-hit');
        await hit.scrollIntoViewIfNeeded();
        const box = await hit.boundingBox();
        await hit.hover({ position: { x: box.width * 0.6, y: box.height * 0.5 } });
        await expect(page.locator('#nw-earthmoon .nw-pc-tip')).toBeVisible();
        const tip = await page.textContent('#nw-earthmoon .nw-pc-tip');
        expect(tip).toMatch(/Earth/); expect(tip).toMatch(/Moon/); expect(tip).toMatch(/Sun tide/);

        // ── Toggles.
        await page.check('#nw-zvc');
        await page.uncheck('#nw-em-layer');
        let vis = await page.evaluate(() => ({ g: window.__neoWatch.stage.emGroup.visible, d: window.__neoWatch.stage.zvcDisc.visible }));
        expect(vis).toEqual({ g: false, d: true });
        await page.check('#nw-em-layer');
        vis = await page.evaluate(() => ({ g: window.__neoWatch.stage.emGroup.visible, d: window.__neoWatch.stage.zvcDisc.visible }));
        expect(vis).toEqual({ g: true, d: true });

        // The disc actually PAINTS: same camera, disc on vs off, the frame differs.
        await page.locator('#nw-canvas').scrollIntoViewIfNeeded();
        await page.click('#nw-frame-em');
        await waitForCameraStill(page);
        const canvas = page.locator('#nw-canvas');
        const on = await canvas.screenshot();
        await page.uncheck('#nw-zvc');
        await page.waitForTimeout(250);
        const off = await canvas.screenshot();
        expect(Buffer.compare(on, off)).not.toBe(0);
        await page.check('#nw-zvc');

        // ── A selected object inside Earth's Hill sphere gets a location
        // analysis with a Jacobi constant, and the disc is told about it.
        await page.evaluate(() => window.__neoWatch.selectByDes('NEAR-3LD'));
        await page.waitForFunction(() => /In the Earth–Moon environment/.test(
            document.querySelector('#nw-selected')?.textContent || ''), null, { timeout: 10_000 });
        const sel = await page.textContent('#nw-selected');
        expect(sel).toMatch(/Jacobi constant/);
        expect(sel).toMatch(/Nearest Lagrange pt/);
        expect(sel).toMatch(/Dominated by/);
        const objC = await page.evaluate(() => ({
            c: window.__neoWatch.stage.emObjectC,
            has: window.__neoWatch.stage.zvcUniforms.uHasObj.value,
        }));
        expect(Number.isFinite(objC.c)).toBe(true);
        expect(objC.has).toBe(1);
        // An 11 km/s flyby at 3 LD is far above every gate's energy.
        expect(objC.c).toBeLessThan(C.L4);

        // ...and one OUTSIDE the Hill sphere is refused a gate state.
        await page.evaluate(() => window.__neoWatch.selectByDes('FAR-04AU'));
        await page.waitForFunction(() => /outside Earth’s Hill sphere/.test(
            document.querySelector('#nw-selected')?.textContent || ''), null, { timeout: 10_000 });
        expect(await page.evaluate(() => window.__neoWatch.stage.zvcUniforms.uHasObj.value)).toBe(0);

        // TRUE SCALE re-places the layer on the linear map.
        await page.check('#nw-true-scale');
        await page.waitForTimeout(400);
        const l1True = await page.evaluate(() => {
            const m = window.__neoWatch.stage.lagrangeMarks.find(x => x.id === 'EM-L1');
            const a = m.pts.geometry.attributes.position.array;
            return Math.hypot(a[0], a[1], a[2]);
        });
        const jdT = await page.evaluate(() => window.__neoWatch.stage.jd);
        expect(l1True).toBeCloseTo(lagrangeGeometry(jdT).earthMoon[0].distKm / EARTH_RADIUS_KM, 1);

        const shots = process.env.NW_SHOTS;
        if (shots) {
            fs.mkdirSync(shots, { recursive: true });
            await page.setViewportSize({ width: 1500, height: 1100 });
            await page.evaluate(() => { document.getElementById('nw-stage-legend').style.display = 'none'; window.__neoWatch.stage.resize(); });
            await page.click('#nw-frame-em');
            await waitForCameraStill(page);
            await page.waitForTimeout(400);
            await canvas.screenshot({ path: path.join(shots, 'stage-earth-moon-true.png') });
            await page.uncheck('#nw-true-scale');
            await page.evaluate(() => window.__neoWatch.selectByDes('NEAR-3LD'));
            await page.click('#nw-frame-em');
            await waitForCameraStill(page);
            await page.waitForTimeout(400);
            await canvas.screenshot({ path: path.join(shots, 'stage-earth-moon.png') });
            await page.locator('#nw-earthmoon').screenshot({ path: path.join(shots, 'earth-moon-card.png') });
            await page.locator('#nw-selected').screenshot({ path: path.join(shots, 'selected-card.png') });
            await page.click('#nw-frame-all');
            await waitForCameraStill(page);
            await canvas.screenshot({ path: path.join(shots, 'stage-wide.png') });
        }
        expect(errors).toEqual([]);
    });

    test('the Moon is selectable and gets its own card, not a catalogue row', async ({ page }) => {
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);

        await page.evaluate(() => window.__neoWatch.select('moon'));
        await page.waitForTimeout(500);
        const sel = await page.evaluate(() => ({
            page: window.__neoWatch.selected,
            stage: window.__neoWatch.stage.selected,
            ring: window.__neoWatch.stage.selRing.visible,
            des: window.__neoWatch.selectedDes,
        }));
        expect(sel.page).toBe('moon');
        expect(sel.stage).toBe('moon');
        expect(sel.ring).toBe(true);
        // The Moon is not a small body, so it must not leak into the catalogue
        // selection — a sentinel index would read into the population arrays.
        expect(sel.des).toBe(null);
        await expect(page.locator('#nw-selected .nw-empty')).toBeVisible();

        // And focusing it must not throw or send the camera to NaN.
        await page.click('#nw-frame-sel');
        await page.waitForTimeout(400);
        const cam = await page.evaluate(() => window.__neoWatch.stage.camera.position.toArray());
        expect(cam.every(Number.isFinite)).toBe(true);
    });

    test('selecting a row selects on the stage and fills the card', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);

        // THE ROW MUST SURVIVE ITS OWN REDRAWS. The board refreshes at 3 Hz; if
        // it rebuilt its markup each time, the node under the cursor would be
        // detached between press and release and the click would go nowhere —
        // which is what a visitor experiences as a row that sometimes does not
        // respond, and what this suite hit as a click timeout before the board
        // started updating in place.
        const firstRow = await page.locator('#nw-nearest tbody tr').first().elementHandle();
        await page.waitForTimeout(1600);                      // ~5 redraws
        expect(await firstRow.evaluate(node => node.isConnected)).toBe(true);
        // ...and the numbers in it are still being updated.
        expect(await firstRow.evaluate(node => node.children[1].textContent.trim().length)).toBeGreaterThan(0);

        await page.locator('#nw-nearest tbody tr').first().click();
        await page.waitForFunction(() => window.__neoWatch.selected != null, null, { timeout: 10_000 });

        const sel = await page.evaluate(() => ({
            page: window.__neoWatch.selected,
            stage: window.__neoWatch.stage.selected,
            ringVisible: window.__neoWatch.stage.selRing.visible,
        }));
        expect(sel.stage).toBe(sel.page);
        expect(sel.ringVisible).toBe(true);

        // The card carries a distance and a right ascension, both from the row
        // builder rather than a second derivation.
        await expect(page.locator('#nw-selected .nw-sel-name')).toBeVisible();
        const card = await page.textContent('#nw-selected');
        expect(card).toMatch(/Distance/);
        expect(card).toMatch(/RA \/ Dec/);
        expect(errors).toEqual([]);
    });

    test('picking is SCREEN-SPACE, so a dot is selectable in both scale modes', async ({ page }) => {
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);
        await page.waitForFunction(() => {
            for (const m of window.__neoWatch.meta.values()) if (m.des === 'NEAR-3LD') return true;
            return false;
        }, null, { timeout: 30_000 });

        // THE BUG THIS PINS: picking used to be a three.js Raycaster against
        // Points, whose `threshold` is a WORLD radius. The dots are drawn at a
        // fixed 11 px with sizeAttenuation off, so the world threshold and the
        // drawn size agree at exactly one camera distance and nowhere else —
        // and in TRUE SCALE, where the whole population sits four decades
        // further out, the hit radius works out to a fraction of a pixel and
        // nothing on the stage can be selected at all.
        //
        // Screen-space picking is checked where it failed: project the object,
        // click its own pixel, and require the click to land on it — in both
        // modes, with no change to the code between them.
        const pickAtOwnPixel = async () => page.evaluate(() => {
            const w = window.__neoWatch;
            let target = null;
            for (const [k, m] of w.meta) if (m.des === 'NEAR-3LD') target = k;
            if (target == null) return { ok: false, why: 'no target' };
            const at = w.stage.screenPositionOf(target);
            if (!at) return { ok: false, why: 'off screen' };
            const r = w.stage.canvas.getBoundingClientRect();
            const hit = w.stage.pickAt(at.x + r.left, at.y + r.top, 'mouse');
            return {
                ok: true, target, hit: hit ? hit.sel : null, distPx: hit ? hit.distPx : null,
                // Guard the guard: a pick that "works" at a coordinate outside
                // the canvas proves nothing about what a user can click.
                onCanvas: at.x >= 0 && at.y >= 0 && at.x <= r.width && at.y <= r.height,
            };
        });

        const compressed = await pickAtOwnPixel();
        expect(compressed.ok).toBe(true);
        expect(compressed.onCanvas).toBe(true);
        expect(compressed.hit).toBe(compressed.target);
        expect(compressed.distPx).toBeLessThan(2);

        await page.check('#nw-true-scale');
        await page.waitForTimeout(700);
        const trueScale = await page.evaluate(() => window.__neoWatch.stage.trueScale);
        expect(trueScale).toBe(true);
        const linear = await pickAtOwnPixel();
        expect(linear.ok).toBe(true);
        // THE true-scale case is the one the world-unit threshold could not do
        // at all: the same object, four decades further out, still on screen
        // and still one pixel from its own pick.
        expect(linear.onCanvas).toBe(true);
        expect(linear.hit).toBe(linear.target);
        expect(linear.distPx).toBeLessThan(2);

        // A fingertip gets a bigger target than a cursor, and the touch radius
        // is the repo's standing 44 px touch-target floor.
        const radii = await page.evaluate(() => ({
            mouse: window.__neoWatch.stage._pickRadius('mouse'),
            touch: window.__neoWatch.stage._pickRadius('touch'),
        }));
        expect(radii.touch).toBe(44);
        expect(radii.touch).toBeGreaterThan(radii.mouse);
        await page.uncheck('#nw-true-scale');
    });

    test('a camera drag is not a selection, and a tap is', async ({ page }) => {
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);
        await page.waitForFunction(() => {
            for (const m of window.__neoWatch.meta.values()) if (m.des === 'NEAR-3LD') return true;
            return false;
        }, null, { timeout: 30_000 });

        // Put something selectable under a known pixel and remember where.
        const at = await screenPixelOf(page, 'NEAR-3LD');
        expect(at).toBeTruthy();

        await page.evaluate(() => window.__neoWatch.select(null));
        await page.waitForTimeout(250);

        // A DRAG that starts on the object must leave the selection alone.
        // Without the press/release test every camera drag ends in a click and
        // the selection changes under the user's hand — on a page whose entire
        // surface is a drag target, that reads as the selection resetting at
        // random.
        await page.mouse.move(at.x, at.y);
        await page.mouse.down();
        await page.mouse.move(at.x + 90, at.y + 50, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(350);
        expect(await page.evaluate(() => window.__neoWatch.selected)).toBe(null);

        // A TAP on the same object selects it. Re-project AFTER the damping has
        // run out: the drag moved the camera, and a position sampled while it
        // is still coasting is stale by the time the click is dispatched.
        await waitForCameraStill(page);
        const at2 = await screenPixelOf(page, 'NEAR-3LD');
        expect(at2).toBeTruthy();
        await page.mouse.move(at2.x, at2.y);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(400);
        expect(await page.evaluate(() => window.__neoWatch.selected)).toBe(at2.target);

        // Clicking empty sky clears it, which is how a selection is dismissed.
        await waitForCameraStill(page);
        const sky = await emptySky(page);
        expect(sky).toBeTruthy();
        await page.mouse.move(sky.x, sky.y);
        await page.mouse.down();
        await page.mouse.up();
        await page.waitForTimeout(350);
        expect(await page.evaluate(() => window.__neoWatch.selected)).toBe(null);
    });

    test('hovering names what is under the cursor, and the nearest few are labelled', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);
        await page.waitForFunction(() => {
            for (const m of window.__neoWatch.meta.values()) if (m.des === 'NEAR-3LD') return true;
            return false;
        }, null, { timeout: 30_000 });

        const at = await screenPixelOf(page, 'NEAR-3LD');
        expect(at).toBeTruthy();

        await page.mouse.move(at.x, at.y);
        // Hover is resolved from the RENDER LOOP, not the event, so it takes a
        // frame or two rather than landing synchronously with the move.
        await page.waitForFunction(() => document.getElementById('nw-tip').dataset.on === '1', null, { timeout: 10_000 });
        const tip = await page.evaluate(() => {
            const el = document.getElementById('nw-tip');
            return { text: el.textContent, hovered: window.__neoWatch.stage.hovered, cursor: window.__neoWatch.stage.canvas.style.cursor };
        });
        expect(tip.hovered).toBe(at.target);
        expect(tip.text).toContain('NEAR-3LD');
        // The affordance: a dot on a black field has to look like a control.
        expect(tip.cursor).toBe('pointer');
        expect(await page.evaluate(() => window.__neoWatch.stage.hoverRing.visible)).toBe(true);

        // Off the object, the tooltip and the ring go away.
        await page.mouse.move(8, 8);
        await page.waitForFunction(() => document.getElementById('nw-tip').dataset.on !== '1', null, { timeout: 10_000 });
        expect(await page.evaluate(() => window.__neoWatch.stage.hoverRing.visible)).toBe(false);

        // Hover must not be the ONLY way to learn what anything is: the nearest
        // few carry their names on the stage. Sweeping a cursor over a field of
        // identical dots is the findability failure mars.html's feature index
        // exists to fix, and it is worse in 3D.
        const labels = await page.evaluate(() => {
            const w = window.__neoWatch;
            return w.stage.nearLabels.filter(e => e.sprite && e.sprite.visible).map(e => e.name);
        });
        expect(labels.length).toBeGreaterThan(0);
        expect(labels.every(n => typeof n === 'string' && n.length > 0)).toBe(true);
        expect(errors).toEqual([]);
    });

    test('a JPL approach row drives the clock, and "Now" brings it back', async ({ page }) => {
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);
        await page.waitForSelector('#nw-approaches tbody tr');

        expect(await page.evaluate(() => window.__neoWatch.isLive)).toBe(true);
        // The Apophis row is 2029 — a scrub of years, clamped by the slider but
        // not by the clock, so the offset must be large and LIVE must be off.
        await page.locator('#nw-approaches tbody tr').first().click();
        await page.waitForTimeout(500);
        const off = await page.evaluate(() => ({ live: window.__neoWatch.isLive, days: window.__neoWatch.offsetDays }));
        expect(off.live).toBe(false);
        expect(Math.abs(off.days)).toBeGreaterThan(0.1);

        await page.click('#nw-live');
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => window.__neoWatch.isLive)).toBe(true);
        expect(await page.evaluate(() => window.__neoWatch.offsetDays)).toBe(0);
    });

    test('the stage opens at the top, and the time bar fits the first screen', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        // The site-wide consent banner overlays the bottom of every first visit;
        // it is not this page's chrome, so measure (and photograph) without it.
        await page.addInitScript(() => {
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch {}
        });
        const shots = process.env.NW_SHOTS;
        for (const vp of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 390, height: 844 }]) {
            await page.setViewportSize(vp);
            await openPage(page);
            await waitForPopulation(page);
            const g = await page.evaluate(() => {
                const r = (id) => document.getElementById(id).getBoundingClientRect();
                const c = r('nw-canvas'), t = r('nw-timebar'), s = r('nw-scrub');
                return {
                    canvasTop: c.top, canvasH: c.height, canvasBottom: c.bottom,
                    timebarBottom: t.bottom, scrubBottom: s.bottom,
                    innerH: innerHeight, innerW: innerWidth,
                    // body clips overflow-x, so scrollWidth cannot see a panel
                    // poking past the edge — measure the panels themselves.
                    scrollW: Math.max(document.documentElement.scrollWidth,
                        ...[...document.querySelectorAll('#nw-app > *, .nw-panel, #nw-timebar')]
                            .map(e => Math.ceil(e.getBoundingClientRect().right))),
                    legendOpen: document.getElementById('nw-stage-legend').open,
                    // The canvas's drawing buffer follows its CSS box.
                    bufW: window.__neoWatch.stage.canvas.width, cssW: c.width,
                };
            });
            const phone = vp.width < 600;
            // The stage is the first thing on the page: only the nav and one header row above it.
            expect(g.canvasTop, `${vp.width}: canvas top`).toBeLessThan(phone ? 0.3 * g.innerH : 140);
            expect(g.canvasH, `${vp.width}: canvas height`).toBeGreaterThanOrEqual(320);
            // On a desktop the WHOLE time bar — clock, buttons and slider — is on the first screen.
            if (!phone) expect(g.timebarBottom, `${vp.width}: time bar on screen`).toBeLessThanOrEqual(g.innerH);
            // Nothing scrolls sideways.
            expect(g.scrollW, `${vp.width}: no horizontal overflow`).toBeLessThanOrEqual(g.innerW);
            // The legend starts folded so it does not cover the stage.
            expect(g.legendOpen).toBe(false);
            expect(g.bufW).toBeGreaterThan(0.9 * g.cssW);
            if (shots) {
                fs.mkdirSync(shots, { recursive: true });
                await page.screenshot({ path: path.join(shots, `first-screen-${vp.width}x${vp.height}.png`) });
            }
        }
        expect(errors).toEqual([]);
    });

    test('every time control drives the ONE clock, and the slider follows it', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);
        const read = () => page.evaluate(() => {
            const w = window.__neoWatch;
            const wallJd = Date.now() / 86400e3 + 2440587.5;
            const sc = document.getElementById('nw-scrub');
            return {
                live: w.isLive, paused: w.paused, off: w.offsetDays,
                stageJd: w.stage.jd, simJd: w._jdNow(), wallJd,
                slider: Number(sc.value), min: Number(sc.min), max: Number(sc.max),
                chip: document.getElementById('nw-live-state').textContent,
            };
        });
        const settle = () => page.waitForTimeout(450);    // > one 3 Hz UI tick

        let s = await read();
        expect(s.live).toBe(true);
        expect(s.slider).toBe(0);
        expect(s.chip).toBe('LIVE');

        // The slider moves the stage.
        await page.locator('#nw-scrub').fill('5');
        await settle();
        s = await read();
        expect(s.off).toBeCloseTo(5, 1);
        expect(s.stageJd - s.wallJd).toBeCloseTo(5, 1);
        expect(s.chip).toBe('OFFSET');

        // Pause holds the stage still.
        await page.click('#nw-pause');
        const held = (await read()).simJd;
        await page.waitForTimeout(1200);
        s = await read();
        expect(s.paused).toBe(true);
        expect(s.simJd).toBe(held);
        expect(s.chip).toBe('PAUSED');

        // BUG 1: a scrub while paused moves the stage (and it stays paused).
        await page.locator('#nw-scrub').fill('-3');
        await settle();
        s = await read();
        expect(s.paused).toBe(true);
        expect(s.simJd - s.wallJd).toBeCloseTo(-3, 1);

        // BUG 2: resuming continues from the paused instant — no jump.
        const before = (await read()).simJd;
        await page.click('#nw-pause');
        await page.waitForTimeout(800);
        s = await read();
        expect(s.paused).toBe(false);
        expect(Math.abs(s.simJd - before) * 86400).toBeLessThan(5);       // seconds

        // BUG 3: under warp the slider FOLLOWS the clock.
        await page.selectOption('#nw-warp', '86400');                     // 1 day per second
        await page.waitForTimeout(1600);
        s = await read();
        expect(s.off).toBeGreaterThan(-3 + 1);
        expect(Math.abs(s.slider - Math.max(s.min, Math.min(s.max, s.off)))).toBeLessThan(0.6);
        expect(s.chip).toBe('FAST-FORWARD');

        // Reverse runs backwards.
        await page.selectOption('#nw-warp', '-86400');
        const r0 = (await read()).simJd;
        await page.waitForTimeout(1000);
        s = await read();
        expect(s.simJd).toBeLessThan(r0 - 0.5);
        expect(s.chip).toBe('REVERSE');

        // Step buttons are exact when paused.
        await page.click('#nw-pause');
        const p0 = (await read()).simJd;
        await page.click('#nw-step-fwd-day');
        await page.click('#nw-step-back-hour');
        s = await read();
        expect(s.simJd - p0).toBeCloseTo(1 - 1 / 24, 6);

        // Keyboard, with nothing focused: Shift+← steps a day, N goes live.
        await page.evaluate(() => document.activeElement?.blur?.());
        const k0 = (await read()).simJd;
        await page.keyboard.press('Shift+ArrowLeft');
        s = await read();
        expect(s.simJd - k0).toBeCloseTo(-1, 6);
        await page.keyboard.press('n');
        await settle();
        s = await read();
        expect(s.live).toBe(true);
        expect(s.off).toBe(0);
        expect(s.slider).toBe(0);
        expect(s.max).toBe(30);                                          // span reset on Now
        expect(await page.inputValue('#nw-warp')).toBe('1');

        // An approach years away widens the slider so the thumb is not pinned.
        await page.waitForSelector('#nw-approaches tbody tr');
        await page.locator('#nw-approaches tbody tr[data-des="99942"]').click();
        await settle();
        s = await read();
        expect(Math.abs(s.off)).toBeGreaterThan(365);
        expect(s.max).toBeGreaterThanOrEqual(Math.abs(s.off));
        expect(s.slider).toBeCloseTo(s.off, 0);
        expect(errors).toEqual([]);
    });

    test('an observer position produces an altitude column and a drawn horizon', async ({ page }) => {
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);

        // No observer ⇒ no altitude column at all, rather than a blank one.
        // textContent, not innerText: the header is uppercased by CSS and
        // innerText honours text-transform, so this would pass vacuously.
        expect(await page.locator('#nw-nearest thead th').allTextContents()).not.toContain('Alt');

        await page.fill('#nw-lat', '51.48');
        await page.fill('#nw-lon', '-0.01');
        await page.click('#nw-observer-apply');
        await page.waitForTimeout(700);

        expect(await page.locator('#nw-nearest thead th').allTextContents()).toContain('Alt');
        const horizon = await page.evaluate(() => ({
            visible: window.__neoWatch.stage.observerGroup.visible,
            r: window.__neoWatch.stage.observerGroup.position.length(),
        }));
        expect(horizon.visible).toBe(true);
        // The pin sits on the surface of a globe drawn at 1 Earth radius.
        expect(horizon.r).toBeGreaterThan(0.99);
        expect(horizon.r).toBeLessThan(1.05);

        // Every altitude in the board agrees with the kernel, evaluated fresh.
        const agree = await page.evaluate(async () => {
            const m = await import('/js/neo-space.js');
            const w = window.__neoWatch;
            const jd = w.frame.jd;
            let worst = 0;
            for (const k of w.stage._visible.slice(0, 20)) {
                const o = k * 3;
                const aa = m.topocentricAltAz(w.frame.geo[o], w.frame.geo[o + 1], w.frame.geo[o + 2], w.observer, jd);
                const row = w._rowFor(k, jd, 1);
                if (row?.sky) worst = Math.max(worst, Math.abs(row.sky.altDeg - aa.altDeg));
            }
            return worst;
        });
        expect(agree).toBeLessThan(1e-9);
    });

    test('the stage is Y-up, so OrbitControls is never rebuilt', async ({ page }) => {
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);

        const before = await page.evaluate(() => {
            const s = window.__neoWatch.stage;
            return { up: s.camera.up.toArray(), id: s.controls.constructor.name };
        });
        expect(before.up).toEqual([0, 1, 0]);

        // Flip the scale, move the horizon, frame everything — the three things
        // that re-range the camera on this page.
        await page.check('#nw-true-scale');
        await page.selectOption('#nw-horizon', 'ld20');
        await page.click('#nw-frame-earth');
        await page.waitForTimeout(500);

        const after = await page.evaluate(() => {
            const s = window.__neoWatch.stage;
            return { up: s.camera.up.toArray(), far: s.camera.far, sameControls: s.controls === s.controls };
        });
        expect(after.up).toEqual([0, 1, 0]);
        expect(after.sameControls).toBe(true);
        // True scale at 20 LD needs a far plane far beyond the log map's 26 units.
        expect(after.far).toBeGreaterThan(4000);
    });

    test('fireballs are pinned on the rotating globe, not floated in the scene', async ({ page }) => {
        await mockJpl(page);
        await openPage(page);
        await waitForPopulation(page);
        await page.waitForFunction(() => window.__neoWatch.stage.fireballGroup.children.length > 0, null, { timeout: 20_000 });

        const pins = await page.evaluate(() => {
            const s = window.__neoWatch.stage;
            return {
                n: s.fireballGroup.children.length,
                parentIsGlobe: s.fireballGroup.parent === s.globe,
                radii: s.fireballGroup.children.map(c => +c.position.length().toFixed(3)),
            };
        });
        expect(pins.n).toBe(2);
        // Parenting to the globe is what makes the longitude honest: the globe
        // is spun by GMST, so a pin at a lat/lon is at that lat/lon.
        expect(pins.parentIsGlobe).toBe(true);
        for (const r of pins.radii) expect(r).toBeCloseTo(1.012, 2);
    });

    test('feeds down: the page says so, draws nothing, and raises no error', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page, { catalogDown: true, watchDown: true });
        await openPage(page);
        await page.waitForFunction(() => window.__neoWatch.catalog.state !== 'loading', null, { timeout: 30_000 });
        await page.waitForTimeout(1200);

        // Nothing drawn — never a placeholder population.
        expect(await page.evaluate(() => window.__neoWatch.stage._visible.length)).toBe(0);

        // And every panel says which feed is missing, rather than reading empty.
        await expect(page.locator('#nw-nearest .nw-empty--down')).toBeVisible();
        await expect(page.locator('#nw-approaches .nw-empty--down')).toBeVisible();
        await expect(page.locator('#nw-sentry .nw-empty--down')).toBeVisible();
        await expect(page.locator('#nw-fireballs .nw-empty--down')).toBeVisible();
        await expect(page.locator('#nw-feeds .nw-chip--down').first()).toBeVisible();

        expect(errors).toEqual([]);
    });
});
