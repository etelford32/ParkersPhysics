import { test, expect } from '@playwright/test';
import {
    parseSbdbQuery, parseCad, parseSentry, parseFireballs,
    composeCatalogResponse, composeWatchResponse,
} from '../api/_lib/neo-sources.js';
import {
    earthHelioJ2000, LD_AU, geoSceneRadius, MOON_SCENE, EARTH_RADIUS_KM, LD_KM,
    MOON_RADIUS_KM, bodySceneRadius, moonPhase,
} from '../js/neo-space.js';
import { R2D } from '../js/neo-orbits.js';

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
 *   - an object planted 3 LD away is inside the default horizon and is drawn;
 *     one planted at 0.4 AU is inside the map but OUTSIDE the default horizon
 *   - the live board ranks by distance and the nearest row is the nearest object
 *   - the live board updates IN PLACE, so a row is not detached mid-click
 *   - selecting a row selects on the stage, and the card fills
 *   - a JPL approach row moves the clock (LIVE turns off, the offset is the
 *     encounter) and comes back with "Now"
 *   - an observer position produces an altitude column and a drawn horizon
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
        // Two planted objects: one well inside the default horizon, one outside.
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

        // NEAR-3LD is planted at 3 LD and FAR-04AU at 0.4 AU. The default
        // horizon is 0.2 AU, so exactly one of them is inside it.
        //
        // The near one is found by name; the far one CANNOT be, and that is
        // itself the design: metadata is only fetched for objects a readout can
        // name, so an object outside the horizon has none. It is identified by
        // its planted distance instead.
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

        // Widening the horizon brings the far object in.
        await page.selectOption('#nw-horizon', 'au05');
        await page.waitForTimeout(600);
        const nowDrawn = await page.evaluate((idx) => window.__neoWatch.stage._visible.includes(idx), planted.far[0].index);
        expect(nowDrawn).toBe(true);
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
