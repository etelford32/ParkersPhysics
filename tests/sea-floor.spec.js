/**
 * sea-floor.spec.js — the Sea Floor page (sea-floor.html)
 *
 *   npx playwright test tests/sea-floor.spec.js
 *
 * No network: the page reads the baked data/seafloor/* files, and a dive at an open-ocean point
 * reads elevation tiles through /api/climalytix/dem, which is MOCKED here with a synthetic sea
 * floor (real Terrarium PNGs of a known function). Pins: boots without console
 * errors; the table, map, 3D block, cross-section, water column and sounding all draw the page
 * model's numbers; a deep link selects a site; Ping reveals the side echo; picking a point on the
 * block moves the sounding; and the NEGATIVE CONTROLS — the cast archive missing ⇒ depths stay,
 * no temperature is shown anywhere and the chip says so; the index missing ⇒ nothing is drawn.
 */
import { test, expect } from '@playwright/test';
import { demTilePng } from './fixtures/climalytix-mocks.mjs';

/** The synthetic sea floor every mocked tile is cut from: ~4.2 km deep with a gentle swell. */
const seaFloor = (lat, lon) => -4200 - 600 * Math.sin(lat * 0.7) * Math.cos(lon * 0.5);
async function mockTiles(page, { down = false } = {}) {
    await page.route('**/api/climalytix/dem**', (r) => {
        if (down) return r.fulfill({ status: 503, body: '' });
        const q = new URL(r.request().url()).searchParams;
        return r.fulfill({ status: 200, contentType: 'image/png', body: demTilePng(+q.get('z'), +q.get('x'), +q.get('y'), seaFloor) });
    });
}

test.describe.configure({ timeout: 120_000 });

function recorder(page) {
    const errors = [];
    // third-party hosts (fonts, auth, analytics) are unreachable in CI: a failed RESOURCE is noise, a thrown error is not
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(e.message));
    return errors;
}
async function boot(page, url = '/sea-floor.html', opts = {}) {
    await mockTiles(page, opts);
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__seaFloor?.detail && document.querySelector('#sf-section-chart svg'), null, { timeout: 60_000 });
    await page.evaluate(() => document.querySelector('.pp-consent-banner')?.remove());
}

test('boots clean and every panel draws the model', async ({ page }) => {
    const errors = recorder(page);
    await boot(page);
    await expect(page.locator('#sf-chip-bathy')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#sf-chip-casts')).toHaveAttribute('data-state', 'ok');
    await expect(page.locator('#sf-table tbody tr')).toHaveCount(28);
    await expect(page.locator('#sf-site-title')).toContainText('Challenger Deep');
    const s = await page.evaluate(() => { const d = window.__seaFloor.detail; return { depth: d.point.depth, floorT: d.floor.t, kind: d.floor.kind, err: d.ping.errorM, mean: d.ping.meanSpeed, rows: window.__seaFloor.rows.length }; });
    expect(s.depth).toBeGreaterThan(10600);
    expect(s.floorT).toBeGreaterThan(1.8); expect(s.floorT).toBeLessThan(2.9);
    expect(s.err).toBeLessThan(-250);
    // the printed numbers ARE the model's
    await expect(page.locator('#sf-stage-readout')).toContainText(Math.round(s.depth).toLocaleString('en-US') + ' m');
    await expect(page.locator('#sf-sound-body')).toContainText(s.mean.toFixed(1) + ' m/s');
    await expect(page.locator('#sf-sound-body')).toContainText('too shallow');
    await expect(page.locator('#sf-column-read')).toContainText(s.floorT.toFixed(2) + ' °C');
    await expect(page.locator('#sf-column-chart svg path')).not.toHaveCount(0);
    await expect(page.locator('#sf-compare-chart svg')).toBeVisible();
    await expect(page.locator('#sf-column-note')).toContainText('Model check on this cast');
    // the page opens on the GLOBE: the whole planet's relief, with the 28 sites marked
    await page.waitForFunction(() => window.__seaFloorGlobe?.state.frames > 0 && window.__seaFloorGlobe.state.vertices > 100000, null, { timeout: 60_000 });
    expect(await page.evaluate(() => ({ mode: window.__seaFloor.mode, sites: window.__seaFloorGlobe.state.sites, exag: window.__seaFloorGlobe.state.exaggeration }))).toEqual({ mode: 'globe', sites: 28, exag: 30 });
    await expect(page.locator('#sf-stage-note')).toContainText('Relief exaggerated 30×');
    await page.locator('#sf-globe-exag').fill('1');
    await expect(page.locator('#sf-stage-note')).toContainText('true scale');
    await page.uncheck('#sf-water');
    expect(await page.evaluate(() => window.__seaFloorGlobe.state.water)).toBe(false);
    // and the sea-floor block at the selected site is one click away
    await page.click('#sf-mode-local');
    await page.waitForFunction(() => window.__seaFloorStage?.state.frames > 0 && window.__seaFloorStage.state.vertices > 10000, null, { timeout: 60_000 });
    // no horizontal overflow
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
});

test('deep link, table selection, ping, exaggeration, and a picked point', async ({ page }) => {
    const errors = recorder(page);
    await boot(page, '/sea-floor.html?site=puerto-rico');
    await expect(page.locator('#sf-site-title')).toContainText('Puerto Rico');
    expect(await page.evaluate(() => window.__seaFloor.mode)).toBe('local');         // a site deep link opens on its sea floor
    await expect(page.locator('#sf-table tr[aria-selected="true"]')).toContainText('Puerto Rico');
    await page.locator('#sf-table tbody tr[data-id="tonga"]').click();
    await page.waitForFunction(() => window.__seaFloor.id === 'tonga' && window.__seaFloor.detail?.point.depth > 10000);
    await expect(page).toHaveURL(/site=tonga/);
    await page.waitForFunction(() => window.__seaFloorStage?.state.vertices > 10000, null, { timeout: 60_000 });
    // wide historic beam ⇒ a side echo; Ping reveals it and flies the pulse
    await page.selectOption('#sf-beam', '60');
    const echo = await page.evaluate(() => window.__seaFloor.detail.echo);
    expect(echo.biasM).toBeLessThan(0);
    await page.click('#sf-ping');
    await expect(page.locator('#sf-sound-body')).toContainText('orange line');
    expect(await page.evaluate(() => window.__seaFloor.pingShown)).toBe(true);
    // NEGATIVE CONTROL for the beam: a 1° beam on this grid has no side echo
    await page.selectOption('#sf-beam', '1');
    await expect(page.locator('#sf-sound-body')).toContainText('no side echo');
    // exaggeration is printed and reaches the stage
    await page.locator('#sf-exag').fill('1');
    await expect(page.locator('#sf-stage-note')).toContainText('true scale');
    expect(await page.evaluate(() => window.__seaFloorStage.state.exaggeration)).toBe(1);
    // move the sounding point (the stage's own pick path, at a projected sea-floor point)
    const moved = await page.evaluate(() => {
        const S = window.__seaFloor, st = window.__seaFloorStage, p = S.detail.point;
        const target = { lat: p.lat + 0.4, lon: p.lon + 0.3 };
        const scr = st.toScreen(target.lat, target.lon, 6000), hit = st.pickAt(scr.x, scr.y);
        return hit;
    });
    expect(moved).not.toBeNull();
    await page.evaluate((hit) => { const S = window.__seaFloor; S.at = hit; document.getElementById('sf-nominal').dispatchEvent(new Event('change')); }, moved);
    await expect(page.locator('#sf-stage-readout')).toContainText('your point');
    await page.click('#sf-reset-point');
    await expect(page.locator('#sf-stage-readout')).toContainText('deepest grid cell');
    expect(errors).toEqual([]);
});

test('globe: read a depth anywhere, dive under the surface there', async ({ page }) => {
    const errors = recorder(page);
    await boot(page);
    await page.waitForFunction(() => window.__seaFloorGlobe?.state.frames > 0, null, { timeout: 60_000 });
    // a point in the open western Pacific, picked on the globe itself (the page's own pick path)
    const target = { lat: 2, lon: 165 };
    await page.evaluate((t) => window.__seaFloorGlobe.flyTo(t.lat, t.lon, 3.3, 50), target);
    await page.waitForFunction(() => !window.__seaFloorGlobe.state.flying);
    const hit = await page.evaluate((t) => { const g = window.__seaFloorGlobe, s = g.screenOf(t.lat, t.lon), p = g.pointAt(s.x, s.y); return { s, p }; }, target);
    expect(hit.s.facing).toBe(true);
    expect(Math.abs(hit.p.lat - target.lat)).toBeLessThan(0.2);          // analytic pick ≡ the projection, on the near side
    expect(Math.abs(hit.p.lon - target.lon)).toBeLessThan(0.2);
    await page.mouse.click(hit.s.x, hit.s.y);
    await expect(page.locator('#sf-stage-readout')).toContainText('overview grid');
    await expect(page.locator('#sf-stage-readout')).toContainText('Dive here');
    expect(await page.evaluate(() => window.__seaFloor.id)).toBe('mariana');        // reading a depth does not change the selection
    await page.click('#sf-dive-here');
    await page.waitForFunction(() => window.__seaFloor.id === 'custom' && window.__seaFloor.mode === 'local' && window.__seaFloorStage?.state.underwater, null, { timeout: 60_000 });
    await expect(page).toHaveURL(/at=[12]\.\d+(,|%2C)16[45]\.\d+/);
    await expect(page.locator('#sf-site-title')).toHaveText('Open ocean');
    // the block is the MOCKED sea floor (~4.2 km), and the HUD reports the water at the camera
    const d = await page.evaluate(() => ({ depth: window.__seaFloor.detail.point.depth, cam: window.__seaFloorStage.camera(), column: window.__seaFloor.detail.column }));
    expect(d.depth).toBeGreaterThan(3500); expect(d.depth).toBeLessThan(4900);
    expect(d.cam.depthM).toBeGreaterThan(0); expect(d.cam.depthM).toBeLessThan(d.depth);
    expect(d.column).toBeNull();
    const hud = page.locator('#sf-dive-hud');
    await expect(hud).toContainText('below the surface');
    await expect(hud).toContainText('above the sea floor');
    await expect(hud).toContainText('atm');
    await expect(hud).toContainText('no archived cast within 150 km');             // no temperature is invented in mid-ocean
    await expect(hud).not.toContainText('°C');
    await expect(page.locator('#sf-dive')).toHaveText('Surface ▲');
    await expect(page.locator('#sf-sound-body')).toContainText('Pressure on the floor');
    // back up, and back to the globe
    await page.click('#sf-dive');
    await page.waitForFunction(() => !window.__seaFloorStage.state.underwater);
    await expect(hud).toContainText('above the sea surface');
    await page.click('#sf-mode-globe');
    expect(await page.evaluate(() => window.__seaFloor.mode)).toBe('globe');
    // NEGATIVE CONTROL: land is not dived into
    await page.evaluate(() => { const g = window.__seaFloorGlobe; return g.flyTo(39, -100, 3.3, 50); });
    await page.waitForFunction(() => !window.__seaFloorGlobe.state.flying);
    const land = await page.evaluate(() => window.__seaFloorGlobe.screenOf(39, -100));
    await page.mouse.dblclick(land.x, land.y);
    await expect(page.locator('#sf-stage-readout')).toContainText('is land');
    expect(await page.evaluate(() => window.__seaFloor.mode)).toBe('globe');
    expect(errors).toEqual([]);
});

test('diving at a named site shows the measured water on the way down', async ({ page }) => {
    await boot(page, '/sea-floor.html?site=mariana');
    await page.waitForFunction(() => window.__seaFloor.mode === 'local' && window.__seaFloorStage?.state.vertices > 10000, null, { timeout: 60_000 });
    await page.click('#sf-dive');
    await page.waitForFunction(() => window.__seaFloorStage.state.underwater && !window.__seaFloorStage.state.flying, null, { timeout: 60_000 }).catch(async () => {
        throw new Error('dive did not settle: ' + JSON.stringify(await page.evaluate(() => ({ s: { ...window.__seaFloorStage.state }, cam: window.__seaFloorStage.camera(), btn: document.querySelector('#sf-dive').textContent, mode: window.__seaFloor.mode, when: window.__seaFloor.diveWhenReady, y: window.scrollY, vis: document.visibilityState, focus: document.hasFocus() }))));
    });
    const hud = page.locator('#sf-dive-hud');
    await expect(hud).toContainText('°C');
    await expect(hud).toContainText(/measured|modelled/);
    const cam = await page.evaluate(() => window.__seaFloorStage.camera());
    expect(cam.depthM).toBeGreaterThan(6000);                                        // inside the trench, in the hadal zone — not pushed up over its wall
    await expect(hud).toContainText('Hadal zone');
    // the deep link survives: ?at= dives at an arbitrary point on load
    await page.goto('/sea-floor.html?at=2.000,165.000', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__seaFloor?.id === 'custom' && window.__seaFloor.mode === 'local', null, { timeout: 60_000 });
});

test('NEGATIVE CONTROL: elevation tiles down ⇒ no dive, nothing drawn in their place', async ({ page }) => {
    await boot(page, '/sea-floor.html', { down: true });
    await page.waitForFunction(() => window.__seaFloorGlobe?.state.frames > 0, null, { timeout: 60_000 });
    await page.evaluate(() => window.__seaFloorGlobe.flyTo(2, 165, 3.3, 50));
    await page.waitForFunction(() => !window.__seaFloorGlobe.state.flying);
    const s = await page.evaluate(() => window.__seaFloorGlobe.screenOf(2, 165));
    await page.mouse.dblclick(s.x, s.y);
    await expect(page.locator('#sf-stage-readout')).toContainText('could not be read');
    expect(await page.evaluate(() => ({ id: window.__seaFloor.id, mode: window.__seaFloor.mode }))).toEqual({ id: 'mariana', mode: 'globe' });
});

test('NEGATIVE CONTROL: no cast archive ⇒ depths stay, no temperature is invented', async ({ page }) => {
    await page.route('**/data/seafloor/casts.json.gz', (r) => r.fulfill({ status: 503, body: '' }));
    await boot(page);
    await expect(page.locator('#sf-chip-casts')).toHaveAttribute('data-state', 'down');
    await expect(page.locator('#sf-table tbody tr')).toHaveCount(28);
    await expect(page.locator('#sf-table tbody')).not.toContainText('°C');
    await expect(page.locator('#sf-stage-readout')).not.toContainText('°C');
    await expect(page.locator('#sf-column-chart')).toContainText('could not be loaded');
    await expect(page.locator('#sf-sound-body')).toContainText('Nothing is assumed');
    await expect(page.locator('#sf-compare-chart svg')).toHaveCount(0);
});

test('NEGATIVE CONTROL: no index ⇒ nothing drawn, and the page says so', async ({ page }) => {
    await page.route('**/data/seafloor/index.json', (r) => r.fulfill({ status: 503, body: '' }));
    await page.goto('/sea-floor.html', { waitUntil: 'load' });
    await expect(page.locator('#sf-chip-bathy')).toHaveAttribute('data-state', 'down');
    await expect(page.locator('#sf-table tbody tr')).toHaveCount(0);
    await expect(page.locator('#sf-table-note')).toContainText('Nothing is substituted');
});

// settled = plate model in, and (where the site has a wide window and a bending plate) that window in or failed
const tectonics = (page) => page.waitForFunction(() => { const s = window.__seaFloor; if (!s || s.tectonics === 'loading') return false; if (s.tectonics !== 'ok') return true;
    if (!s.trench) return false; const meta = s.index.sites.find((m) => m.id === s.id); if (s.custom || !meta?.wide || !s.trench.profile) return true;
    const w = s.wides.get(s.id); return !!w && w !== 'loading' && (w === 'down' || s.trench.wide); }, null, { timeout: 60_000 });
const stateOf = (page, name) => page.evaluate((n) => { const o = window[n]; return typeof o.state === 'function' ? o.state() : o.state; }, name);

test('plates: boundaries on the globe and the block, the bending plate, the slab', async ({ page }) => {
    await boot(page, '/sea-floor.html?site=kuril'); await tectonics(page);
    const t = await page.evaluate(() => { const t = window.__seaFloor.trench, a = t.along, te = a.stations.filter((s) => s.flexure?.quality === 'good').map((s) => s.flexure.elastic.teKm).sort((x, y) => x - y);
        return { fam: t.setting.family, down: t.setting.down.name, slab: t.slab.code, reach: t.flexure.reachKm, wide: t.wide, n: a.stations.length, good: a.good, quotable: a.quotable, med: a.teMedian, te, masked: t.flexure.masked.length, slope: t.flexure.slope }; });
    expect(t.fam).toBe('subduction'); expect(t.down).toBe('Pacific'); expect(t.slab).toBe('kur');
    expect(t.wide).toBe(true); expect(t.reach).toBeGreaterThan(450);                                    // the fit ran on the wide window
    expect(t.n).toBe(5); expect(t.quotable).toBe(true); expect(t.good).toBeGreaterThanOrEqual(3);
    // the page prints the kernel's MEDIAN over the passing stations, with their range
    const facts = page.locator('#sf-plates-facts');
    await expect(facts).toContainText('Effective plate thickness');
    await expect(facts).toContainText(`${Math.round(t.med)} km`);
    await expect(facts).toContainText(`${t.good} of 5 cross-sections`);
    await expect(facts).toContainText(`${Math.round(t.te[0])}–${Math.round(t.te[t.te.length - 1])} km`);
    await expect(facts).toContainText('Regional slope');
    await expect(facts).toContainText('Published, near the trench'); await expect(facts).toContainText('Garcia et al. 2019'); await expect(facts).toContainText('within the published range');
    await expect(facts).toContainText('Published, before it bends'); await expect(facts).toContainText('Sea-floor age');
    await expect(page.locator('#sf-flex-read')).toContainText('wider, coarser window');
    // five stations; the passing ones are marked; choosing one redraws ITS section
    const chips = page.locator('#sf-flex-stations button');
    await expect(chips).toHaveCount(5); await expect(page.locator('#sf-flex-stations button.ok')).toHaveCount(t.good);
    await expect(page.locator('#sf-flex-stations button[aria-pressed="true"]')).toHaveText(/here/);
    await expect(page.locator('#sf-flex-chart .sf-masked')).toHaveCount(t.masked);                      // what was left out as seamounts is drawn
    const before = await page.locator('#sf-flex-chart svg path').last().getAttribute('d');
    await chips.first().click();
    await expect(page.locator('#sf-flex-stations button[aria-pressed="true"]')).toHaveText(/160 km/);
    expect(await page.locator('#sf-flex-chart svg path').last().getAttribute('d')).not.toBe(before);
    await expect(page.locator('#sf-flex-read')).toContainText('read from the wider, coarser window');
    await chips.nth(2).click();
    await expect(page.locator('#sf-flex-chart svg path')).toHaveCount(2);                            // sea floor + model
    await expect(page.locator('#sf-deep-chart svg path')).toHaveCount(2);                            // sea floor + slab top
    await expect(page.locator('#sf-plate-keys')).toContainText('Bird 2003');
    await page.waitForFunction(() => window.__seaFloorGlobe && window.__seaFloorStage);
    expect((await stateOf(page, '__seaFloorGlobe')).boundarySegments).toBeGreaterThan(5000);
    await page.locator('#sf-mode-globe').click();                                                     // the tick-box belongs to the globe view
    await page.locator('#sf-plates').uncheck(); expect((await stateOf(page, '__seaFloorGlobe')).boundaries).toBe(false);
    await page.locator('#sf-mode-local').click();
    await expect.poll(async () => (await stateOf(page, '__seaFloorStage')).boundaryLines).toBeGreaterThan(3);
    // the table carries each site's plate motion
    await expect(page.locator('#sf-table tbody tr', { hasText: 'Tonga' }).first()).toContainText('closing');

    // a trench whose fit is REJECTED says why and prints no thickness
    await page.goto('/sea-floor.html?site=mariana', { waitUntil: 'load' }); await tectonics(page);
    await expect(page.locator('#sf-flex-read')).toContainText('No stiffness is quoted here');
    await expect(page.locator('#sf-plates-facts')).toContainText('none of 5 cross-sections');
    await expect(page.locator('#sf-flex-stations button.ok')).toHaveCount(0);
    // RECORDED: one clean section is not enough — Izu–Bonin's centre passes, only 2 of its 5 stations do, and no thickness is quoted
    await page.goto('/sea-floor.html?site=izu-bonin', { waitUntil: 'load' }); await tectonics(page);
    await expect(page.locator('#sf-plates-facts')).toContainText('not quoted');
    await expect(page.locator('#sf-plates-facts')).toContainText('only 2 of 5 cross-sections');
    await expect(page.locator('#sf-flex-read')).toContainText('The curve fits to');
    // a transform fault has no bending plate and no slab
    await page.goto('/sea-floor.html?site=romanche', { waitUntil: 'load' }); await tectonics(page);
    await expect(page.locator('#sf-flex-chart')).toContainText('no plate sinks');
    await expect(page.locator('#sf-flex-chart svg')).toHaveCount(0);
});

test('NEGATIVE CONTROL: wide window down ⇒ the Kuril plate is not fitted, and the page says the window is missing', async ({ page }) => {
    await boot(page, '/sea-floor.html?site=kuril'); await tectonics(page);
    await expect(page.locator('#sf-plates-facts')).toContainText('cross-sections that pass');         // with the window: a thickness
    await page.route('**/data/seafloor/kuril.wide.bin.gz', (r) => r.fulfill({ status: 503, body: '' }));
    await page.goto('/sea-floor.html?site=kuril', { waitUntil: 'load' }); await tectonics(page);
    await expect(page.locator('#sf-plates-facts')).not.toContainText('Effective plate thickness');
    await expect(page.locator('#sf-flex-stations button')).toHaveCount(0);
    await expect(page.locator('#sf-flex-read')).toContainText('wider window could not be loaded');
    await expect(page.locator('#sf-flex-read')).toContainText('110 km is needed');
});

test('NEGATIVE CONTROL: plate model down ⇒ no motions, no boundaries, depths untouched', async ({ page }) => {
    await page.route('**/data/earth-interior/plates-pb2002.json.gz', (r) => r.fulfill({ status: 503, body: '' }));
    await boot(page, '/sea-floor.html?site=tonga'); await tectonics(page);
    await expect(page.locator('#sf-plates-facts')).toContainText('could not be loaded');
    await expect(page.locator('#sf-flex-chart svg')).toHaveCount(0); await expect(page.locator('#sf-deep-chart svg')).toHaveCount(0);
    await expect(page.locator('#sf-plates')).toBeDisabled();
    await page.waitForFunction(() => window.__seaFloorGlobe);
    expect((await stateOf(page, '__seaFloorGlobe')).boundarySegments || 0).toBe(0);
    await expect(page.locator('#sf-section-chart svg')).toHaveCount(1);
});

test('phone width: no overflow, panels stack', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.locator('#sf-column-chart svg')).toBeVisible();
});
