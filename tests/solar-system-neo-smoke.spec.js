import { test, expect } from '@playwright/test';
import {
    parseSbdbQuery, parseCad, parseSentry, parseFireballs,
    composeCatalogResponse, composeWatchResponse,
} from '../api/_lib/neo-sources.js';
import { earthHeliocentric, jdNow } from '../js/horizons.js';
import { precessionLongitudeRad, rotateAboutPole, LD_AU, R2D } from '../js/neo-orbits.js';

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
 *   - a CLICK selects what is under the cursor, a DRAG selects nothing and empty
 *     sky selects nothing — the two halves of the "it picks NEOs at random" bug
 *   - a HOVER names the body a click would take, and marks it
 *   - the population is drawn as SUNLIT BODIES, not additive point sources
 *   - feeds down ⇒ the page says so, draws nothing, and raises no page error
 *
 * The flyby objects are SYNTHESISED at test time from the page's own VSOP87D
 * Earth (rotated back to J2000, the frame elements are published in), so the
 * geometry assertion holds on any date the suite runs.
 */

// Every in-test wait here is 45 s, matching waitForFrames: this page loads a
// three-tier catalogue, spawns a worker and renders a full orrery on whatever
// rasteriser CI has, and under parallel workers a single test was measured at
// 37 s. A 20 s wait inside one of them is a coin flip, not a gate.
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

/**
 * Population loaded AND at least one worker frame APPLIED to it. `rHelio` is
 * the tell: a tier swap rebuilds every buffer and nulls the derived frames
 * (_rebuildPoints), so `tiersPending` can empty a beat before the arrays the
 * assertions read exist. Without this a test reads a half-swapped layer.
 */
async function waitForFrames(page) {
    await page.waitForFunction(() => {
        const L = window.__neoLab?.layer;
        return !!L && L.count > 0 && L.frameJd != null && L.status.tiersPending.length === 0
            && !!L.rHelio && !!L.rGeo;
    }, null, { timeout: 45_000 });
}

/**
 * Every loaded object that is currently DRAWN, with its position in client
 * pixels. The pick contract is stated in pixels (js/neo-layer.js pick()), so a
 * gate that cannot measure pixels cannot check it.
 */
async function drawnPixels(page) {
    return page.evaluate(() => {
        const lab = window.__neoLab, L = lab.layer;
        const r = lab.canvas.getBoundingClientRect();
        const out = [];
        for (let i = 0; i < L.count; i++) {
            if (!(L._alpha[i] > 0.05) && !L._meshed.has(i)) continue;
            const p = L.drawnPosition(i);
            if (!p) continue;
            const c = p.project(lab.camera);
            if (!(c.z > -1 && c.z < 1)) continue;
            out.push({ i, des: L.els[i].des,
                x: r.left + (c.x * 0.5 + 0.5) * r.width,
                y: r.top + (-c.y * 0.5 + 0.5) * r.height });
        }
        return out;
    });
}

/**
 * The most ISOLATED drawn object in the canvas's middle band that the page's own
 * pick paths agree is there and is not behind a planet. Isolation matters: the
 * assertion is about WHICH object a click takes, so a candidate with a neighbour
 * a few pixels away would make a correct pick look like a wrong one.
 */
async function isolatedTarget(page) {
    const pts = (await drawnPixels(page)).filter(p => p.x > 380 && p.x < 940 && p.y > 150 && p.y < 560);
    const ranked = pts.map((a) => {
        let near = Infinity;
        for (const b of pts) if (b !== a) near = Math.min(near, Math.hypot(a.x - b.x, a.y - b.y));
        return { ...a, near };
    }).sort((a, b) => b.near - a.near).slice(0, 8);
    for (const cand of ranked) {
        const probe = await page.evaluate(([x, y]) => window.__neoLab.probeAt(x, y), [cand.x, cand.y]);
        if (!probe.planet && probe.neo != null) return { ...cand, probe };
    }
    return null;
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
        await page.waitForFunction(() => window.__neoLab.layer.inZone.length > 0, null, { timeout: 45_000 });

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
        await page.waitForFunction((jd0) => window.__neoLab.layer.frameJd > jd0 + 25, before.jd, { timeout: 45_000 });
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
        await page.waitForFunction(() => window.__neoLab.layer.inZone.length > 0, null, { timeout: 45_000 });
        // A flyby 3 LD out is a lit rock mesh, and its sprite is suppressed.
        await page.waitForFunction(() => {
            const L = window.__neoLab.layer; const i = L.byDes.get('FLYBY-3LD');
            return L._rockSlots.some(sl => sl.index === i && sl.mesh.visible);
        }, null, { timeout: 45_000 });
        const rocks = await page.evaluate(() => {
            const L = window.__neoLab.layer; const i = L.byDes.get('FLYBY-3LD');
            const slot = L._rockSlots.find(sl => sl.index === i);
            const j = L._localIndices.indexOf(i);
            return { verts: slot.mesh.geometry.attributes.position.count, scale: slot.mesh.scale.x, spriteAlpha: L._lalpha[j],
                atLocal: slot.mesh.position.distanceTo(L.localGroup.position) < 2, meshed: L._meshed.has(i), tails: L.cometTailsActive };
        });
        expect(rocks.verts).toBeGreaterThan(500);
        expect(rocks.scale).toBeGreaterThan(0.009); expect(rocks.scale).toBeLessThan(0.05);
        expect(rocks.spriteAlpha).toBe(0);
        expect(rocks.atLocal).toBe(true);
        expect(rocks.meshed).toBe(true);
        // Encke at perihelion grows tails.
        expect(rocks.tails).toBeGreaterThanOrEqual(1);
        // Selecting Apophis puts a rock at the lock anchor with its real (elongated) family and spin period.
        await page.evaluate(() => { const b = window.__neoLab.layer.selectByDes('99942'); window.__neoLab.selectBody(b); });
        await page.waitForFunction(() => { const L = window.__neoLab.layer; const i = L.byDes.get('99942'); return L._rockSlots.some(sl => sl.index === i && sl.mesh.visible); }, null, { timeout: 45_000 });
        const sel = await page.evaluate(() => {
            const L = window.__neoLab.layer; const i = L.byDes.get('99942'); const slot = L._rockSlots.find(sl => sl.index === i);
            return { atAnchor: slot.mesh.position.distanceTo(L.anchor.position) < 1e-6, shape: slot.shape, periodH: slot.spin.periodH,
                bodyRadius: window.__neoLab.selectedBody.radius, scale: slot.mesh.scale.x };
        });
        expect(sel.atAnchor).toBe(true);
        expect(sel.shape).toBe('elongated');
        expect(sel.periodH).toBe(30.6);
        expect(Math.abs(sel.bodyRadius - sel.scale)).toBeLessThan(1e-9);
        // Meteoroid streams are instanced rock meshes.
        await page.evaluate((v) => { const el = document.getElementById('tc-date-picker'); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); }, '2026-08-12T22:00');
        await page.waitForFunction(() => window.__neoLab.layer._radiants.length > 0, null, { timeout: 45_000 });
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

    test('a click selects what is under the cursor — a drag selects nothing, and empty sky selects nothing', async ({ page }) => {
        // THE REPORTED BUG, twice over. Selection fired on pointerdown, so every
        // camera orbit that began over the population selected whatever was
        // under the press; and the pick radius was a WORLD-space threshold
        // (0.012 x camera range) compared against distanceToRay, so a click on
        // empty sky returned an object hundreds of pixels away. Together they
        // read as the page selecting at random. Both are pinned here.
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForFrames(page);
        await page.waitForFunction(() => window.__neoLab.layer._alpha.some(a => a > 0.05), null, { timeout: 45_000 });

        // 1. A DRAG that starts on a body selects nothing — it belongs to the camera.
        const dragFrom = await isolatedTarget(page);
        expect(dragFrom, 'an isolated drawn object to drag from').not.toBeNull();
        await page.mouse.move(dragFrom.x, dragFrom.y);
        await page.mouse.down();
        await page.mouse.move(dragFrom.x + 46, dragFrom.y + 34, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(400);
        expect(await page.evaluate(() => window.__neoLab.layer.selectedIndex), 'a drag is a camera move, not a selection').toBeNull();

        // 2. A click on empty sky selects nothing. The candidate is chosen with
        //    probeAt (no planet, no NEO there); the assertion is a real click.
        const pts = await drawnPixels(page);
        let empty = null;
        for (let x = 420; x <= 900 && !empty; x += 20) {
            for (let y = 170; y <= 550 && !empty; y += 20) {
                if (pts.some(p => Math.hypot(p.x - x, p.y - y) < 60)) continue;
                const probe = await page.evaluate(([cx, cy]) => window.__neoLab.probeAt(cx, cy), [x, y]);
                if (!probe.planet && probe.neo == null) empty = { x, y };
            }
        }
        expect(empty, 'a patch of empty sky in the middle of the canvas').not.toBeNull();
        await page.mouse.move(empty.x, empty.y);
        await page.mouse.down(); await page.mouse.up();
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => window.__neoLab.layer.selectedIndex), 'empty sky selects nothing').toBeNull();

        // 3. A click ON a body selects THAT body — measured in pixels against the
        //    positions as they were when the click was dispatched (selectBody()
        //    locks the camera, which moves everything afterwards).
        await page.waitForTimeout(400);
        const target = await isolatedTarget(page);
        expect(target, 'an isolated drawn object to click').not.toBeNull();
        const before = await drawnPixels(page);
        await page.mouse.move(target.x, target.y);
        await page.mouse.down(); await page.mouse.up();
        await page.waitForTimeout(400);
        const sel = await page.evaluate(() => ({
            index: window.__neoLab.layer.selectedIndex,
            name: window.__neoLab.selectedBody?.name,
            neoIndex: window.__neoLab.selectedBody?.neoIndex,
        }));
        expect(sel.index, 'a click on a body selects a body').not.toBeNull();
        expect(sel.neoIndex).toBe(sel.index);
        const hit = before.find(p => p.i === sel.index);
        expect(hit, 'the selected object was on screen when it was clicked').toBeTruthy();
        // The accept radius is the DRAWN radius plus GRAB_PX of grace; nothing
        // further from the cursor than that may ever win.
        expect(Math.hypot(hit.x - target.x, hit.y - target.y)).toBeLessThan(16);
        expect(errors).toEqual([]);
    });

    test('hovering names the body a click would take, and marks it', async ({ page }) => {
        // The population is dark bodies a few pixels across, so "what am I about
        // to click?" has to be answerable before the click.
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForFrames(page);
        await page.waitForFunction(() => window.__neoLab.layer._alpha.some(a => a > 0.05), null, { timeout: 45_000 });
        const target = await isolatedTarget(page);
        expect(target).not.toBeNull();
        await page.mouse.move(target.x, target.y);
        await page.waitForTimeout(250);
        const hov = await page.evaluate(() => ({
            index: window.__neoLab.layer.hoverIndex,
            marker: window.__neoLab.layer.hoverMarker.visible,
            tip: document.getElementById('neo-hover-tip').textContent,
            shown: getComputedStyle(document.getElementById('neo-hover-tip')).display,
            cursor: window.__neoLab.canvas.style.cursor,
            selected: window.__neoLab.layer.selectedIndex,
        }));
        expect(hov.index).toBe(target.probe.neo);
        expect(hov.marker).toBe(true);
        expect(hov.shown).not.toBe('none');
        expect(hov.tip).toContain(await page.evaluate((i) => window.__neoLab.layer.els[i].des, target.probe.neo));
        expect(hov.cursor).toBe('pointer');
        expect(hov.selected, 'a hover is not a selection').toBeNull();
        // Off the body: the mark and the tooltip go away.
        await page.mouse.move(target.x + 220, target.y + 150);
        await page.waitForTimeout(250);
        const off = await page.evaluate(() => ({
            index: window.__neoLab.layer.hoverIndex,
            marker: window.__neoLab.layer.hoverMarker.visible,
            shown: getComputedStyle(document.getElementById('neo-hover-tip')).display,
        }));
        if (off.index == null) { expect(off.marker).toBe(false); expect(off.shown).toBe('none'); }
        expect(errors).toEqual([]);
    });

    test('the population is drawn as sunlit bodies, not additive point sources', async ({ page }) => {
        // "Shadows at a distance, not little lights." A rock reflects sunlight;
        // it does not emit it. If this ever goes back to AdditiveBlending the
        // population glows on its own again and 38 000 of them stack into a haze.
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForFrames(page);
        // ONE ATOMIC READ, retried until the layer is consistent. The coma needs
        // a WORKER FRAME, not just a loaded catalogue, and a tier swap rebuilds
        // every attribute array from zero — so waiting for `_coma > 0` and THEN
        // evaluating can still land on a freshly swapped layer and read the
        // zeros back. Wait and read in the same tick. (Caught as a 1-in-30
        // flake on exactly this assertion, twice.)
        const draw = await (await page.waitForFunction(() => {
            const lab = window.__neoLab, L = lab.layer, THREE = lab.THREE;
            const m = L.points.material;
            const iComet = L.byDes.get('2P'), iRock = L.byDes.get('433');
            if (iComet == null || iRock == null || !L._coma || !L._albedo || !L._alpha) return null;
            if (!(L._coma[iComet] > 0)) return null;      // no frame applied to THIS array yet
            const albedo = Array.from(L._albedo.slice(0, L.count));
            return {
                blending: m.blending, normal: THREE.NormalBlending, additive: THREE.AdditiveBlending,
                premultiplied: m.premultipliedAlpha, depthWrite: m.depthWrite,
                sameMaterial: L.localPoints.material === m,
                attrs: Object.keys(L.points.geometry.attributes).sort(),
                albedoMin: Math.min(...albedo), albedoMax: Math.max(...albedo),
                cometAlbedo: L._albedo[iComet], cometComa: L._coma[iComet],
                rockAlpha: L._alpha[iRock],
                fs: m.fragmentShader, vs: m.vertexShader,
            };
        }, null, { timeout: 45_000 })).jsonValue();
        // Not a light source.
        expect(draw.blending).toBe(draw.normal);
        expect(draw.blending).not.toBe(draw.additive);
        expect(draw.premultiplied).toBe(true);
        expect(draw.depthWrite).toBe(false);
        expect(draw.sameMaterial, 'both frames draw the same kind of body').toBe(true);
        // A lit body, shaded from the Sun at the scene origin.
        expect(draw.vs).toContain('viewMatrix * vec4(0.0, 0.0, 0.0, 1.0)');
        expect(draw.fs).not.toContain('spikes');          // the diffraction cross of a point source
        // LOMMEL–SEELIGER, not Lambert: μ₀/(μ₀+μ) is the airless-regolith law,
        // and it is what makes a body read as a disc instead of a shiny ball.
        // The law itself lives ONCE, in js/airless-body.js AIRLESS_GLSL, and is
        // interpolated into this shader — so a moon and a NEO of the same albedo
        // at the same distance are shaded by the same lines of code. Assert on
        // the shared definition and its call, not on a copy of the expression.
        expect(draw.fs).toContain('float lommelSeeliger(float mu0, float mu)');
        expect(draw.fs).toContain('lommelSeeliger(mu0, mu)');
        // THE DISC-INTEGRATED H–G FUNCTION MUST NOT MULTIPLY THE BRDF. Φ(α) is
        // what a whole unresolved disc returns — it ALREADY contains the
        // terminator that Lommel–Seeliger is drawing here, so applying both
        // darkens a crescent twice, which is why the earlier version needed an
        // HG_ALPHA_MAX clamp to stop backlit bodies vanishing entirely. What a
        // BRDF legitimately misses is the shadow-hiding OPPOSITION SURGE, and
        // that is the one phase term the render path keeps (Hapke B(α) =
        // 1 + B₀/(1 + tan(α/2)/h)). phaseHG survives in the kernel, where
        // apparentMagnitudeV needs exactly the disc-integrated quantity.
        expect(draw.vs).toContain('oppositionSurge');
        expect(draw.vs).not.toContain('phaseHG');
        expect(draw.vs).not.toContain('HG_ALPHA_MAX');
        // Size is a RADIUS put through the projection, not a magnitude curve.
        expect(draw.attrs).toContain('aRadius');
        expect(draw.attrs).toContain('aIllum');
        expect(draw.attrs).not.toContain('aG');
        expect(draw.attrs).not.toContain('aSize');
        // Earth's shadow and Earth's reflected light are per-body scalars — the
        // far field cannot be inside a 1.38 M km umbra, so they are only ever
        // non-trivial on the Earth-anchored local frame, but the attribute has
        // to exist on both or the two frames are not the same material.
        expect(draw.attrs).toContain('aShadow');
        expect(draw.attrs).toContain('aShine');
        expect(draw.vs).toContain('projectionMatrix[1][1]');
        // Albedo is the taxonomy's, and a comet nucleus is among the darkest.
        // The attribute is a Float32Array, so 0.04 reads back as 0.0399999991 —
        // compare with a tolerance, not against the literal.
        expect(draw.albedoMin).toBeGreaterThan(0.039);
        expect(draw.albedoMax).toBeLessThan(0.46);
        expect(draw.cometAlbedo).toBeCloseTo(0.04, 3);
        expect(draw.cometComa, '2P/Encke at perihelion has a coma').toBeGreaterThan(0);
        // Alpha is visibility, not magnitude: a drawn body is opaque.
        expect(draw.rockAlpha).toBeCloseTo(1, 5);
        expect(errors).toEqual([]);
    });

    test('photometry is the kernel\'s: albedo, phase slope, inverse-square light, and a size that is an angle', async ({ page }) => {
        // THE ACCURACY CONTRACT. Everything about how a body looks is derived
        // from published quantities through js/neo-orbits.js, and this asserts
        // the page agrees with the kernel object by object — not that it renders
        // some remembered pixel value.
        const errors = collectPageErrors(page);
        await mockJpl(page);
        await openPage(page);
        await waitForFrames(page);
        await page.waitForFunction(() => {
            const L = window.__neoLab.layer;
            return L.rHelio && L._illum && L._illum.some(v => v !== 1);
        }, null, { timeout: 45_000 });

        const K = await import('../js/neo-orbits.js');
        // ONE ATOMIC READ, retried until the layer is consistent. A tier swap
        // rebuilds the attribute arrays and nulls rHelio mid-flight, so a plain
        // evaluate() can land on a half-swapped layer (caught as a 1-in-4 flake
        // reading rHelio[i] off null).
        const objs = await (await page.waitForFunction(() => {
            const L = window.__neoLab.layer;
            if (!L.rHelio || !L._albedo || !L._illum || !L._radius) return null;
            const out = {};
            for (const des of ['433', '101955', '2P', '3200']) {
                const i = L.byDes.get(des);
                if (i == null || !L.els[i]) continue;
                out[des] = { i, albedo: L._albedo[i], illum: L._illum[i], radius: L._radius[i],
                    rHelio: L.rHelio[i], el: { H: L.els[i].H, diam: L.els[i].diam, spec: L.els[i].spec ?? null,
                        albedo: L.els[i].albedo ?? null, flags: L.els[i].flags } };
            }
            return Object.keys(out).length >= 3 ? out : null;
        }, null, { timeout: 45_000 })).jsonValue();
        expect(Object.keys(objs).length).toBeGreaterThanOrEqual(3);
        for (const [des, o] of Object.entries(objs)) {
            const optics = K.opticalProperties(o.el);
            expect(o.albedo, `${des} albedo is the kernel's`).toBeCloseTo(optics.albedo, 5);
            // The kernel still publishes a per-object H–G slope and still uses
            // it for apparentMagnitudeV; the RENDER deliberately does not carry
            // it (see the opposition-surge note above), so there is no longer a
            // `_G` array to compare — assert the kernel's own value instead.
            expect(optics.G, `${des} has a published phase slope`).toBeGreaterThan(0);
            // Illumination is the inverse-square law in the units H is defined
            // in: (1 AU / r)². Uniform light was the bug this replaces.
            expect(o.illum, `${des} is lit as 1/r²`).toBeCloseTo(1 / (o.rHelio * o.rHelio), 4);
            // The drawn radius is the SAME diameter the mesh pool uses, and the
            // diameter is derived through THIS object's albedo when unmeasured.
            const km = K.diameterKm(o.el, optics).km;
            expect(o.radius, `${des} radius is drawnRockRadius(diameterKm)`).toBeCloseTo(0.010 + 0.011 * Math.log10(1 + 10 * km), 5);
        }
        // A dark body is derived BIGGER from the same H — the albedo is inside
        // the square root, and assuming 0.14 for everything is what shrank them.
        expect(K.diameterKm({ H: 20, spec: 'C' }).km).toBeGreaterThan(K.diameterKm({ H: 20, spec: 'S' }).km);

        // ── Size is an ANGLE, and the LOD handoff is continuous ──────────────
        // The impostor and the mesh that replaces it must subtend the same
        // angle, or a body jumps size as it crosses ROCK_RANGE. The mesh's
        // projected diameter is measured here from its own world geometry, so
        // this is not the layer's mirror checking itself.
        await page.evaluate(() => { const b = window.__neoLab.layer.selectByDes('99942'); window.__neoLab.selectBody(b); });
        await page.waitForFunction(() => {
            const L = window.__neoLab.layer, i = L.byDes.get('99942');
            return L._rockSlots.some(sl => sl.index === i && sl.mesh.visible);
        }, null, { timeout: 45_000 });
        const lod = await page.evaluate(() => {
            const lab = window.__neoLab, L = lab.layer, THREE = lab.THREE;
            const i = L.byDes.get('99942');
            const slot = L._rockSlots.find(sl => sl.index === i);
            const cam = lab.camera, h = lab.canvas.getBoundingClientRect().height;
            cam.updateMatrixWorld();
            // Project the mesh's own limb: centre ± radius along the camera RIGHT
            // vector, so the measurement is perpendicular to the view axis.
            const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).normalize();
            const c = slot.mesh.position.clone();
            const a = c.clone().addScaledVector(right, -slot.mesh.scale.x).project(cam);
            const b = c.clone().addScaledVector(right, slot.mesh.scale.x).project(cam);
            const meshPx = Math.abs(b.x - a.x) * 0.5 * lab.canvas.getBoundingClientRect().width;
            // The impostor's size for the SAME object at the SAME depth.
            const view = c.clone().applyMatrix4(cam.matrixWorldInverse);
            const scale = (cam.projectionMatrix.elements[5] * h * 0.5) / Math.max(-view.z, 1e-6);
            const spritePx = 2 * L._radius[i] * scale;
            return { meshPx, spritePx, radius: L._radius[i], meshRadius: slot.mesh.scale.x };
        });
        // (float32 attribute vs float64 mesh scale — the two agree to the
        // attribute's own precision, which is the most that can be asked.)
        expect(lod.meshRadius, 'the mesh is scaled to the same drawn radius').toBeCloseTo(lod.radius, 7);
        expect(lod.meshPx).toBeGreaterThan(2);
        // Same angle, to within the projection's own perspective asymmetry.
        expect(Math.abs(lod.spritePx - lod.meshPx) / lod.meshPx, 'sprite and mesh subtend the same angle').toBeLessThan(0.06);
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
