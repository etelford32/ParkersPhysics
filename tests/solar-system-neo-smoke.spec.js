import { test, expect } from '@playwright/test';
import {
    parseSbdbQuery, parseCad, parseSentry, parseFireballs,
    composeCatalogResponse, composeWatchResponse,
} from '../api/_lib/neo-sources.js';
import { earthHeliocentric, jdNow } from '../js/horizons.js';
import { precessionLongitudeRad, rotateAboutPole, LD_AU, R2D, helioToScene, logSceneRadius, MAG_DISPLAY } from '../js/neo-orbits.js';
import * as HZ from '../js/horizons.js';

/**
 * Browser gate for the near-Earth object layer on solar-system.html.
 *
 * JPL is MOCKED (ssd-api.jpl.nasa.gov is egress-blocked from CI, and the
 * upstream schemas are unverified anyway — see api/_lib/neo-sources.js). The
 * mock bodies are composed by the SAME pure library the routes use, over
 * fixtures shaped like the documented APIs, so what the browser receives here
 * is byte-for-byte the route's contract. What this suite pins is the client:
 *
 *   - the population loads, the worker answers, the HUD counts it
 *   - the log radial scale in the kernel is the page's own simDist (mirror gate)
 *   - an object 3 LD from Earth is drawn on the Earth-local frame (in-zone,
 *     closest readout, local instance, label) and one at 30 LD is not
 *   - the approach list selects an object, the data card fills, the camera
 *     lock anchor follows, and selecting a planet clears it again
 *   - the time controls move the population (a scrub is a real re-propagation)
 *   - the PLANETS are drawn at their ephemeris positions through the kernel's
 *     helioToScene (not on phased circles), with true-path orbit ribbons
 *   - sprites are sized by APPARENT magnitude and pixel-capped, rocks are true
 *     scale with a disclosed floor, and flyby labels are capped by zoom level
 *   - feeds down ⇒ the page says so, draws nothing, and raises no page error
 *
 * The flyby objects are SYNTHESISED at test time from the page's own VSOP87D
 * Earth (rotated back to J2000, the frame elements are published in), so the
 * geometry assertion holds on any date the suite runs.
 */

const IGNORED_CONSOLE_ERRORS = [
    /fonts\.googleapis\.com/,
    /\/api\/telemetry\//,
    // Every other live feed on this page is unrouted in CI and degrades by
    // design; this file is about the NEO layer alone.
    /\/api\/horizons/, /\/api\/noaa\//, /\/api\/donki\//, /\/api\/solar/, /\/api\/health/,
    /services\.swpc\.noaa\.gov/, /Failed to load resource/, /net::ERR/, /\[swpc-feed\]/, /\[earth-sim-bridge\]/,
    /supabase/i, /WebSocket/,
];

function collectPageErrors(page) {
    const errors = [];
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', message => {
        if (message.type() !== 'error') return;
        const text = message.text();
        const location = message.location?.()?.url || '';
        if (IGNORED_CONSOLE_ERRORS.some(p => p.test(text) || p.test(location))) return;
        errors.push(text);
    });
    return errors;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Circular J2000 orbit through a point `ld` lunar distances above Earth's current position. */
function flybyElements(des, ld, nowJd) {
    const e = earthHeliocentric(nowJd);                         // of date
    const j = rotateAboutPole(e.x_AU, e.y_AU, e.z_AU, -precessionLongitudeRad(nowJd));   // → J2000
    const r = Math.hypot(j.x, j.y);
    const lon = Math.atan2(j.y, j.x) * R2D;
    const i = Math.asin((ld * LD_AU) / r) * R2D;
    return [des, null, 24.0, 'APO', 1, 0, r, null, i, ((lon - 90) % 360 + 360) % 360, 0, 90, null, nowJd, 0.001, null];
}

function catalogBody(nowJd) {
    const fields = ['pdes', 'full_name', 'H', 'class', 'neo', 'pha', 'e', 'a', 'q', 'i', 'om', 'w', 'ma', 'tp', 'epoch', 'moid', 'diameter'];
    const EPOCH = 2461000.5;
    const asteroidRows = [
        ['99942', '99942 Apophis (2004 MN4)', '19.09', 'ATE', 'Y', 'Y', '.1914', '.9224', '.7461', '3.339', '203.96', '126.68', '100.1', null, String(EPOCH), '.000258', '.340'],
        ['101955', '101955 Bennu (1999 RQ36)', '20.2', 'APO', 'Y', 'Y', '.2037', '1.1264', '.8969', '6.035', '2.06', '66.22', '220.5', null, String(EPOCH), '.0032', '.49'],
        ['2024 YR4', '(2024 YR4)', '23.92', 'APO', 'Y', 'N', '.6616', '2.516', '.8514', '3.408', '271.37', '134.36', '32.11', null, String(EPOCH), '.00283', null],
        ['3200', '3200 Phaethon (1983 TB)', '14.3', 'APO', 'Y', 'Y', '.8899', '1.271', '.1399', '22.26', '265.2', '322.2', '45.5', null, String(EPOCH), '.0196', '5.1'],
        ['433', '433 Eros (A898 PA)', '10.4', 'AMO', 'Y', 'N', '.2227', '1.458', '1.133', '10.83', '304.3', '178.9', '12.3', null, String(EPOCH), '.148', '16.8'],
        // Synthetic flybys: one inside the Earth-local frame, one outside it.
        (() => { const f = flybyElements('FLYBY-3LD', 3, nowJd); return [f[0], '(FLYBY-3LD)', String(f[2]), f[3], 'Y', 'N', '0', String(f[6]), null, String(f[8]), String(f[9]), '0', '90', null, String(f[13]), '.001', null]; })(),
        (() => { const f = flybyElements('FLYBY-30LD', 30, nowJd); return [f[0], '(FLYBY-30LD)', String(f[2]), f[3], 'Y', 'N', '0', String(f[6]), null, String(f[8]), String(f[9]), '0', '90', null, String(f[13]), '.05', null]; })(),
    ];
    const cometRows = [
        ['109P', '109P/Swift-Tuttle', null, 'HTC', 'Y', 'N', '.9632', '26.09', '.9595', '113.45', '139.38', '152.98', '5.1', null, String(EPOCH), '.0009', '26'],
        // 2P/Encke at perihelion AT TEST TIME (epoch = now, M = 0): r = 0.34 AU ⇒ active, with tails.
        ['2P', '2P/Encke', null, 'ETc', 'Y', 'N', '.848', '2.215', '.336', '11.78', '334.6', '186.5', '0', null, String(nowJd), '.173', '4.8'],
        ['1P', '1P/Halley', null, 'HTC', 'Y', 'N', '.967', '17.83', '.586', '162.26', '58.42', '111.33', '38.4', null, String(EPOCH), '.0744', '11'],
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
        ['FLYBY-3LD', '1', String(jdOf(nowMs + 2 * 3600e3)), null, '0.0077', '0.0076', '0.0078', '11.2', '11.0', '< 00:01', '24.0', null, '(FLYBY-3LD)'],
        ['99942', '221', String(jdOf(Date.UTC(2029, 3, 13, 21, 46))), null, '0.000254', '0.000253', '0.000255', '7.42', '5.84', '< 00:01', '19.09', '0.340', '99942 Apophis (2004 MN4)'],
        ['2026 ZZ9', '3', String(jdOf(nowMs + 5 * 86400e3)), null, '0.02', '0.019', '0.021', '9.9', '9.8', '00:03', '27.1', null, '(2026 ZZ9)'],
    ];
    const sentry = { data: [
        { des: '2024 YR4', fullname: '(2024 YR4)', ip: '3.8e-2', ps_cum: '-1.3', ps_max: '-1.3', ts_max: '0', range: '2032-2074', last_obs: '2025-05-01', n_imp: '1', h: '23.9', diameter: '0.06', v_inf: '13' },
        { des: '101955', fullname: '101955 Bennu (1999 RQ36)', ip: '3.7e-4', ps_cum: '-1.4', ps_max: '-1.6', ts_max: '0', range: '2178-2290', last_obs: '2024-01-01', n_imp: '157', h: '20.2', diameter: '0.49', v_inf: '5.99' },
        { des: '29075', fullname: '29075 (1950 DA)', ip: '3.9e-4', ps_cum: '-0.9', ps_max: '-0.9', ts_max: '0', range: '2880-2880', last_obs: '2024-11-11', n_imp: '1', h: '17.9', diameter: '1.3', v_inf: '14' },
    ] };
    const fireballs = { fields: ['date', 'energy', 'impact-e', 'lat', 'lat-dir', 'lon', 'lon-dir', 'alt', 'vel'],
        data: [['2026-09-10 12:34:56', '3.2', '0.11', '45.1', 'N', '12.3', 'E', '33.0', '18.2'], ['2026-09-01 01:02:03', '96.0', '2.4', '10.0', 'S', '150.0', 'W', null, null]] };
    return composeWatchResponse({ cad: parseCad({ fields, data: rows }), sentry: parseSentry(sentry), fireballs: parseFireballs(fireballs), nowMs });
}

async function mockJpl(page, { catalogStatus = 200, watchStatus = 200 } = {}) {
    const nowJd = jdNow();
    const counts = { catalog: 0, watch: 0, tiers: [] };
    await page.route('**/api/neo/catalog*', async (route) => {
        counts.catalog += 1;
        counts.tiers.push(new URL(route.request().url()).searchParams.get('tier'));
        if (catalogStatus !== 200) { await route.fulfill({ status: catalogStatus, contentType: 'application/json', body: '{"error":"upstream_unavailable"}' }); return; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(catalogBody(nowJd)) });
    });
    await page.route('**/api/neo/watch*', async (route) => {
        counts.watch += 1;
        if (watchStatus !== 200) { await route.fulfill({ status: watchStatus, contentType: 'application/json', body: '{"error":"upstream_unavailable"}' }); return; }
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(watchBody(Date.now())) });
    });
    return counts;
}

async function openPage(page) {
    await page.goto('/solar-system.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__neoLab, null, { timeout: 30_000 });
}

/** Population loaded AND at least one worker frame applied. */
async function waitForFrames(page) {
    await page.waitForFunction(() => {
        const L = window.__neoLab?.layer;
        return !!L && L.count > 0 && L.frameJd != null && L.status.tiersPending.length === 0;
    }, null, { timeout: 45_000 });
}

test.describe('solar-system.html — near-Earth objects', () => {
    test.setTimeout(120_000);

    test('population loads through the worker, the HUD counts it, and the kernel scale is the page scale', async ({ page }) => {
        const errors = collectPageErrors(page);
        const counts = await mockJpl(page);
        await openPage(page);
        await waitForFrames(page);

        const state = await page.evaluate(async () => {
            const L = window.__neoLab.layer;
            const K = await import('/js/neo-orbits.js');
            return {
                count: L.count, tier: L.tier, worker: L.status.worker, catalog: L.status.catalog,
                drawn: L.points.geometry.drawRange.count,
                kernelEarth: K.logSceneRadius(1), pageEarth: window.__neoLab.simDist(1),
                hudCount: document.getElementById('hud-neo-count').textContent,
                hasComet: L.els.some(e => e.des === '109P'), hasInterstellar: L.els.some(e => e.des === 'C/2025 N1'),
                frameMs: L.status.frameMs,
            };
        });
        expect(state.count).toBe(11);
        expect(state.drawn).toBe(11);
        expect(state.catalog).toBe('ready');
        expect(state.worker).toMatch(/ready/);
        expect(state.hudCount).toBe('11');
        expect(state.hasComet).toBe(true);
        expect(state.hasInterstellar).toBe(true);
        // The kernel's LOG_SCALE mirrors solar-system.html's simDist — drift here fails the gate.
        expect(Math.abs(state.kernelEarth - state.pageEarth)).toBeLessThan(1e-12);
        // The ladder was climbed in order and every tier was requested once.
        expect(counts.tiers).toEqual(['pha', 'bright', 'all']);
        expect(counts.watch).toBe(1);
        expect(errors).toEqual([]);
    });

    test('an object 3 LD out is drawn on the Earth-local frame; one at 30 LD is not', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForFrames(page);
        await page.waitForFunction(() => window.__neoLab.layer.inZone.length > 0, null, { timeout: 20_000 });

        const s = await page.evaluate(() => {
            const L = window.__neoLab.layer;
            const idx3 = L.byDes.get('FLYBY-3LD'), idx30 = L.byDes.get('FLYBY-30LD');
            const ld = (i) => L.rGeo[i] / 0.0025695556;
            return {
                closest: L.els[L.closest.index].des, closestLD: L.closest.dLD,
                inZone: L.inZone.map(i => L.els[i].des),
                ld3: ld(idx3), ld30: ld(idx30),
                localDrawn: L.localPoints.geometry.drawRange.count,
                helioAlpha3: L._alpha[idx3], helioAlpha30: L._alpha[idx30],
                labels: [...L._labels.keys()],
                hudClosest: document.getElementById('hud-neo-closest').textContent,
                closestBox: document.querySelector('#neo-closest .neo-closest')?.textContent ?? '',
                ringNames: L.rings.map(r => r.line.name),
                localAtEarth: L.localGroup.position.distanceTo(window.__neoLab.layer._earthDrawn) < 1e-9,
            };
        });
        expect(s.closest).toBe('FLYBY-3LD');
        expect(s.ld3).toBeGreaterThan(2.5); expect(s.ld3).toBeLessThan(3.5);
        expect(s.ld30).toBeGreaterThan(28); expect(s.ld30).toBeLessThan(32);
        expect(s.inZone).toContain('FLYBY-3LD');
        expect(s.inZone).not.toContain('FLYBY-30LD');
        expect(s.localDrawn).toBeGreaterThanOrEqual(1);
        // Inside the fade band the heliocentric instance is off; outside it is on.
        expect(s.helioAlpha3).toBe(0);
        expect(s.helioAlpha30).toBeGreaterThan(0.3);   // H 24 ⇒ a faint sprite, but ON
        expect(s.labels.some(k => k.startsWith('local:'))).toBe(true);
        expect(s.hudClosest).toContain('FLYBY-3LD');
        expect(s.closestBox).toContain('FLYBY-3LD');
        expect(s.ringNames).toEqual(['neo-ring-1ld', 'neo-ring-5ld', 'neo-ring-10ld', 'neo-ring-20ld']);
        expect(s.localAtEarth).toBe(true);
        expect(errors).toEqual([]);
    });

    test('the approach list selects an object, fills the data card, seats the lock anchor, and a planet clears it', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForFrames(page);
        await page.click('#btn-panel-open');
        await expect(page.locator('#neo-approaches .neo-row')).toHaveCount(3);
        // The catalogue-less row is rendered but cannot select anything.
        const absent = page.locator('#neo-approaches .neo-row[data-des="2026 ZZ9"]');
        await expect(absent).toHaveCount(1);
        await expect(absent).toContainText('not in loaded tier');

        await page.locator('#neo-approaches .neo-row', { hasText: 'Apophis' }).click();
        const sel = await page.evaluate(() => {
            const lab = window.__neoLab, L = lab.layer;
            const b = lab.selectedBody;
            return {
                name: b?.name, neoIndex: b?.neoIndex, type: b?.type,
                panelTitle: document.getElementById('panel-planet-name').textContent,
                card: document.getElementById('planet-table').textContent,
                orbit: !!L.orbitLine, orbitPts: L.orbitLine?.geometry.attributes.position.count,
                markerVisible: L.selectedMarker.visible,
                anchorSeated: L.anchor.position.length() > 1,
                rowSelected: document.querySelectorAll('#neo-approaches .neo-row.sel').length,
            };
        });
        expect(sel.name).toBe('99942 Apophis (2004 MN4)');
        expect(sel.type).toMatch(/Aten/);
        expect(sel.type).toMatch(/potentially hazardous/);
        expect(sel.panelTitle).toBe('99942 Apophis (2004 MN4)');
        expect(sel.card).toContain('Why it matters');
        expect(sel.card).toContain('Distance from Earth');
        expect(sel.card).toContain('Next close approach');
        expect(sel.card).toContain('2029-04-13');
        expect(sel.orbit).toBe(true);
        expect(sel.orbitPts).toBe(360);
        expect(sel.markerVisible).toBe(true);
        expect(sel.anchorSeated).toBe(true);
        expect(sel.rowSelected).toBe(1);

        // Sentry entry shows on the card for a risk-listed object.
        await page.locator('#neo-risk .neo-row', { hasText: 'Bennu' }).click();
        await expect(page.locator('#panel-table, #planet-table')).toContainText('Impact monitor');

        // Selecting a planet clears the NEO selection.
        await page.locator('#planet-btns button', { hasText: 'Earth' }).first().click();
        const cleared = await page.evaluate(() => ({
            sel: window.__neoLab.layer.selectedIndex, orbit: !!window.__neoLab.layer.orbitLine,
            marker: window.__neoLab.layer.selectedMarker.visible, body: window.__neoLab.selectedBody?.name,
        }));
        expect(cleared.sel).toBeNull();
        expect(cleared.orbit).toBe(false);
        expect(cleared.marker).toBe(false);
        expect(cleared.body).toBe('Earth');
        expect(errors).toEqual([]);
    });

    test('time controls re-propagate the population', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForFrames(page);
        const before = await page.evaluate(() => {
            const L = window.__neoLab.layer; const i = L.byDes.get('99942');
            return { jd: L.frameJd, pos: [L._pos[i * 3], L._pos[i * 3 + 1], L._pos[i * 3 + 2]] };
        });
        await page.click('#tc-next-mo');
        await page.waitForFunction((jd0) => window.__neoLab.layer.frameJd > jd0 + 25, before.jd, { timeout: 20_000 });
        const after = await page.evaluate(() => {
            const L = window.__neoLab.layer; const i = L.byDes.get('99942');
            return { jd: L.frameJd, pos: [L._pos[i * 3], L._pos[i * 3 + 1], L._pos[i * 3 + 2]] };
        });
        const moved = Math.hypot(after.pos[0] - before.pos[0], after.pos[1] - before.pos[1], after.pos[2] - before.pos[2]);
        // Apophis covers ~40° of its 0.89-yr orbit in a month: well over a scene unit.
        expect(moved).toBeGreaterThan(0.5);
        expect(errors).toEqual([]);
    });

    test('showers and notables render from the sim date and the loaded catalogue', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForFrames(page);
        await page.click('#btn-panel-open');
        await expect(page.locator('#neo-showers')).toContainText(/Next peak|ZHR/);
        await expect(page.locator('#neo-shower-lon')).toContainText('λ☉');
        const chips = await page.evaluate(() => [...document.querySelectorAll('#neo-notables .neo-chip')].map(c => ({ t: c.textContent, absent: c.classList.contains('absent') })));
        expect(chips.find(c => c.t === 'Apophis')?.absent).toBe(false);
        expect(chips.find(c => c.t === '3I/ATLAS')?.absent).toBe(false);
        expect(chips.find(c => c.t === '1950 DA')?.absent).toBe(true);
        await page.locator('#neo-notables .neo-chip', { hasText: '3I/ATLAS' }).click();
        const inter = await page.evaluate(() => ({
            type: window.__neoLab.selectedBody?.type, card: document.getElementById('planet-table').textContent,
            orbitPts: window.__neoLab.layer.orbitLine?.geometry.attributes.position.count,
        }));
        expect(inter.type).toBe('Interstellar object');
        expect(inter.card).toContain('unbound');
        expect(inter.orbitPts).toBe(201);   // an open hyperbola, not a loop
        await expect(page.locator('#neo-fireballs .neo-row')).toHaveCount(2);
        await expect(page.locator('#sd-neo-table')).toContainText('Apophis');
        expect(errors).toEqual([]);
    });

    test('bodies are meshes up close: selected rock, flyby rocks, instanced meteoroids, comet tails, colour modes', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForFrames(page);
        await page.waitForFunction(() => window.__neoLab.layer.inZone.length > 0, null, { timeout: 20_000 });
        // A flyby 3 LD out is a lit rock mesh, and its sprite is suppressed.
        await page.waitForFunction(() => {
            const L = window.__neoLab.layer; const i = L.byDes.get('FLYBY-3LD');
            return L._rockSlots.some(sl => sl.index === i && sl.mesh.visible);
        }, null, { timeout: 20_000 });
        const rocks = await page.evaluate(() => {
            const L = window.__neoLab.layer; const i = L.byDes.get('FLYBY-3LD');
            const slot = L._rockSlots.find(sl => sl.index === i);
            const j = L._localIndices.indexOf(i);
            const cam = window.__neoLab.camPos; const d = Math.hypot(cam[0] - slot.mesh.position.x, cam[1] - slot.mesh.position.y, cam[2] - slot.mesh.position.z);
            const rk = L._rockRadius(L.els[i], d, i);
            return { verts: slot.mesh.geometry.attributes.position.count, scale: slot.mesh.scale.x, spriteAlpha: L._lalpha[j],
                atLocal: slot.mesh.position.distanceTo(L.localGroup.position) < 2, meshed: L._meshed.has(i), tails: L.cometTailsActive,
                expectR: rk.r, rTrue: rk.rTrue, atFloor: rk.atFloor, camDist: d };
        });
        expect(rocks.verts).toBeGreaterThan(500);
        // True scale with a 5 px screen-space floor: a 60 m rock from any sane camera distance sits AT the floor.
        expect(rocks.atFloor).toBe(true);
        expect(rocks.rTrue).toBeGreaterThan(0); expect(rocks.rTrue).toBeLessThan(1e-5);
        expect(Math.abs(rocks.scale - rocks.expectR) / rocks.expectR).toBeLessThan(0.05);   // one frame of camera motion at most
        expect(rocks.spriteAlpha).toBe(0);
        expect(rocks.atLocal).toBe(true);
        expect(rocks.meshed).toBe(true);
        // Encke at perihelion grows tails.
        expect(rocks.tails).toBeGreaterThanOrEqual(1);
        // Selecting Apophis puts a rock at the lock anchor with its real (elongated) family and spin period.
        await page.evaluate(() => { const b = window.__neoLab.layer.selectByDes('99942'); window.__neoLab.selectBody(b); });
        await page.waitForFunction(() => { const L = window.__neoLab.layer; const i = L.byDes.get('99942'); return L._rockSlots.some(sl => sl.index === i && sl.mesh.visible); }, null, { timeout: 20_000 });
        const sel = await page.evaluate(() => {
            const L = window.__neoLab.layer; const i = L.byDes.get('99942'); const slot = L._rockSlots.find(sl => sl.index === i);
            return { atAnchor: slot.mesh.position.distanceTo(L.anchor.position) < 1e-6, shape: slot.shape, periodH: slot.spin.periodH,
                bodyRadius: window.__neoLab.selectedBody.radius, scale: slot.mesh.scale.x, drawn: L._selectedDraw,
                marks: L._orbitMarks.map(o => o.name), dropVisible: !!L._dropLine?.visible,
                card: window.__neoLab.layer.readout(i) };
        });
        expect(sel.atAnchor).toBe(true);
        expect(sel.shape).toBe('elongated');
        expect(sel.periodH).toBe(30.6);
        // The body's radius is the TRUE one (340 m ⇒ 3.2e-6 units); the mesh is drawn at the 34 px selected floor and the card says by how much.
        expect(sel.bodyRadius).toBeLessThan(1e-5);
        expect(sel.scale).toBeGreaterThan(sel.bodyRadius * 100);
        expect(sel.drawn?.index).toBe(await page.evaluate(() => window.__neoLab.layer.byDes.get('99942')));
        expect(sel.drawn.atFloor).toBe(true);
        expect(sel.card['Drawn size']).toMatch(/^×[\d,.]+ true size/);
        // Analysis marks on the orbit (☊ ☋ q: a dot + a label each) and the drop line to the ecliptic.
        expect(sel.marks.filter(n => n === 'neo-orbit-mark')).toHaveLength(3);
        expect(sel.marks.filter(n => n === 'neo-orbit-mark-label')).toHaveLength(3);
        expect(sel.dropVisible).toBe(true);
        expect(sel.card['Apparent magnitude']).toMatch(/^V \d+\.\d · phase \d+° · elongation \d+°/);
        expect(sel.card['Node crossings']).toMatch(/☊ 1\.0\d\d AU · ☋ 0\.\d\d\d AU — crosses Earth’s orbit at the ascending node/);
        expect(sel.card['Tisserand T_J']).toMatch(/asteroidal/);
        expect(sel.card['Next perihelion']).toMatch(/^\d{4}-\d\d-\d\d · in \d+ d$/);
        expect(sel.card['Speed relative to Earth']).toMatch(/km\/s$/);
        expect(sel.card['Ecliptic position (of date)']).toMatch(/helio λ .* β .* · geo λ/);
        // Meteoroid streams are instanced rock meshes.
        await page.evaluate((v) => { const el = document.getElementById('tc-date-picker'); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, '2026-08-12T22:00');
        await page.waitForFunction(() => window.__neoLab.layer._radiants.length > 0, null, { timeout: 20_000 });
        const stream = await page.evaluate(() => { const r = window.__neoLab.layer._radiants[0]; return { code: r.code, instanced: !!r.rocks.mesh.isInstancedMesh, count: r.rocks.mesh.count, visible: r.rocks.mesh.visible }; });
        expect(stream.code).toBe('PER');
        expect(stream.instanced).toBe(true);
        expect(stream.count).toBeGreaterThan(100);
        expect(stream.visible).toBe(true);
        // Colour modes: natural by default, class palette on request.
        await page.click('#btn-panel-open');
        const before = await page.evaluate(() => { const L = window.__neoLab.layer; const i = L.byDes.get('99942'); return { mode: L.visible.colorMode, rgb: [L._col[i * 3], L._col[i * 3 + 1], L._col[i * 3 + 2]] }; });
        expect(before.mode).toBe('natural');
        await page.check('#neo-toggles input[data-vis="colorMode"]');
        const after = await page.evaluate(() => { const L = window.__neoLab.layer; const i = L.byDes.get('99942'); return { mode: L.visible.colorMode, rgb: [L._col[i * 3], L._col[i * 3 + 1], L._col[i * 3 + 2]] }; });
        expect(after.mode).toBe('class');
        expect(after.rgb).not.toEqual(before.rgb);
        expect(after.rgb[0]).toBeGreaterThan(0.9);   // PHA red
        expect(errors).toEqual([]);
    });

    test('planets ride their ephemerides through the kernel map; sprites are magnitude-sized and pixel-capped; labels cap by zoom', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForFrames(page);
        const s = await page.evaluate(() => {
            const lab = window.__neoLab, L = lab.layer;
            const jd = lab.simJD;
            const planets = lab.planets().map(p => ({ ...p, eph: lab.planetEph[p.name] ? (() => { const e = lab.planetEph[p.name](jd); return [e.x_AU, e.y_AU, e.z_AU]; })() : null }));
            const size = L.points.geometry.attributes.aSize.array;
            let maxAst = 0, maxAll = 0, finiteV = 0;
            for (let k = 0; k < L.count; k++) {
                maxAll = Math.max(maxAll, size[k]);
                if (!(L.els[k].flags & 12) && !L._flybySet?.has(k)) maxAst = Math.max(maxAst, size[k]);   // not comet (4) / interstellar (8) / flyby
                if (Number.isFinite(L.vmag?.[k])) finiteV++;
            }
            const local = [...L._labels.entries()].filter(([k]) => k.startsWith('local:'));
            return { jd, planets, maxAst, maxAll, finiteV, count: L.count, cap: L._labelCap(), level: L._labelVis.level,
                localLabels: local.length, visibleLocal: local.filter(([, sp]) => sp.visible).length, uAtt: L._pointsMat.uniforms.u_att.value };
        });
        // Every planet with an ephemeris sits exactly where helioToScene puts its of-date position (one frame of clock at most).
        for (const p of s.planets) {
            expect(p.eph, p.name).not.toBeNull();
            const exp = helioToScene(...p.eph);
            const err = Math.hypot(p.pos[0] - exp.x, p.pos[1] - exp.y, p.pos[2] - exp.z);
            expect(err, `${p.name} drawn at its ephemeris position`).toBeLessThan(2e-3);
            expect(p.orbitVerts, `${p.name} orbit ribbon`).toBe(512);   // 256 samples × 2 sides
            expect(Math.abs(p.orbitJd - s.jd)).toBeLessThan(3652.5 + 1);
        }
        // Mercury's radius is its TRUE r on the log map (0.31–0.47 AU), not the circle's 0.387.
        const merc = s.planets.find(p => p.name === 'Mercury');
        const mercR = Math.hypot(...merc.pos), mercEph = HZ.mercuryHeliocentric(s.jd);
        expect(Math.abs(mercR - logSceneRadius(mercEph.dist_AU))).toBeLessThan(2e-3);
        expect(s.planets.map(p => p.name)).toContain('Ceres');
        // Sprites: apparent-magnitude sized, capped at MAG_DISPLAY.sizeMaxPx for the population.
        expect(s.finiteV).toBeGreaterThan(5);
        expect(s.maxAst).toBeLessThanOrEqual(MAG_DISPLAY.sizeMaxPx + 1e-6);
        expect(s.maxAll).toBeLessThan(5.0);
        expect(s.uAtt).toBe(12);
        // Flyby labels: built for the nearest few, SHOWN only up to the zoom ladder's cap.
        expect(s.visibleLocal).toBeLessThanOrEqual(s.cap);
        expect(s.cap).toBeLessThanOrEqual(12);
        expect(errors).toEqual([]);
    });

    test('feeds down: the page says so, draws nothing, and raises no page error', async ({ page }) => {
        const errors = collectPageErrors(page);
        await mockJpl(page, { catalogStatus: 503, watchStatus: 503 });
        await openPage(page);
        await page.waitForFunction(() => {
            const L = window.__neoLab.layer;
            return L.status.catalog === 'down' && L.status.watch === 'down' && L.status.tiersPending.length === 0;
        }, null, { timeout: 30_000 });
        await page.click('#btn-panel-open');
        await expect(page.locator('#neo-status')).toContainText('feed down');
        await expect(page.locator('#neo-approaches')).toContainText(/feed down|down/);
        const s = await page.evaluate(() => ({
            count: window.__neoLab.layer.count,
            hud: document.getElementById('hud-neo-count').textContent,
            ledger: document.getElementById('sd-neo-count').textContent,
        }));
        expect(s.count).toBe(0);
        expect(s.hud).toBe('feed down');
        expect(s.ledger).toContain('feed down');
        expect(errors.filter(e => !/api\/neo\//.test(e))).toEqual([]);
    });
});
