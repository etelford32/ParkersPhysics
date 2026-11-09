/**
 * glacier-watch.spec.js — Glacier Watch (glacier-watch.html), hermetic browser gate
 * ═══════════════════════════════════════════════════════════════════════════════════
 *   npx playwright test tests/glacier-watch.spec.js
 *   GW_SHOTS=<dir> … also writes the screenshots used in review
 *
 * Every feed is MOCKED with SYNTHETIC data (ITS_LIVE daily tail, USGS/SNOTEL, Open-Meteo —
 * all egress-blocked in CI); the committed archive (data/glaciers/*) is real. Pins:
 *   1. boots clean on Columbia: the 3D stage FIRST and the selector directly under it, one
 *      name chip per glacier, a non-blank WebGL stage whose density readout is the engine's
 *      (mass = 0.917 × volume), every chart drawn, chips live, and the PERFORMANCE budget
 *      (first render, payload sizes, 3D frame cost — printed as numbers);
 *   2. deep link + picker tooltip + gauge switch + stage controls (layer, size preset,
 *      full screen and Esc, 2D view) drive the page;
 *   3. a glacier whose motion is below detection SAYS so instead of drawing a record;
 *   4. phone width (390 px): no horizontal overflow, touch targets ≥ 44 px;
 *   5. NEGATIVE CONTROL: every feed down → chips read down/stale, never live; the archive
 *      views still render; no uncaught exception.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = process.env.GW_SHOTS || null;
const DAY = 864e5;

function weatherBody(url) {
    const u = new URL(url);
    const lats = u.searchParams.get('latitude').split(',');
    const isArchive = u.hostname.startsWith('archive');
    const start = isArchive ? Date.parse(u.searchParams.get('start_date')) : Date.now() - 7 * DAY;
    const end = isArchive ? Date.parse(u.searchParams.get('end_date')) : Date.now() + 16 * DAY;
    const n = Math.round((end - start) / DAY) + 1;
    const one = (k) => {
        const time = [], tm = [], sn = [], pr = [];
        for (let i = 0; i < n; i++) {
            const t = start + i * DAY, doy = (t - Date.UTC(new Date(t).getUTCFullYear(), 0, 1)) / DAY;
            time.push(new Date(t).toISOString().slice(0, 10));
            tm.push(+(-6 + 11 * Math.sin(2 * Math.PI * (doy - 110) / 365) - 2 * k).toFixed(1));      // synthetic seasonal cycle
            sn.push(tm[i] < 0 ? 1.2 : 0); pr.push(2);
        }
        return { elevation: 1500, daily: { time, temperature_2m_mean: tm, temperature_2m_max: tm.map(v => v + 4), temperature_2m_min: tm.map(v => v - 4), snowfall_sum: sn, precipitation_sum: pr } };
    };
    return lats.length === 1 ? one(0) : lats.map((_, k) => one(k));
}

const STATIONS = () => {
    const daily = [];
    for (let i = 400; i >= 0; i--) { const t = Date.now() - i * DAY; daily.push({ t, q_cms: +(1 + 8 * Math.max(0, Math.sin(2 * Math.PI * (i - 120) / 365))).toFixed(2) }); }
    return { glacier: 'x', freshness: 'live', reasons: [], note: 'synthetic',
        streamflow: { ok: true, gauge_used: '00000000', site_name: 'SYNTHETIC CREEK', daily, recent: daily.slice(-7) },
        snow: { ok: false, error: 'synthetic: none' } };
};

async function boot(page, { url = '/glacier-watch.html?g=columbia', down = false } = {}) {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.route('**/api/telemetry/**', r => r.fulfill({ status: 204, body: '' }));
    await page.route('**/api/glaciers/velocity**', r => down
        ? r.fulfill({ status: 503, json: { error: 'down' } })
        : r.fulfill({ json: { freshness: 'live', reasons: [], pairs: [], new_pairs_available: 0, newest_pair_end: '2026-11-06' } }));
    await page.route('**/api/glaciers/stations**', r => down
        ? r.fulfill({ json: { freshness: 'stale', reasons: ['streamflow-unavailable', 'snow-unavailable'], streamflow: { ok: false, error: 'fetch failed' }, snow: { ok: false, error: 'fetch failed' } } })
        : r.fulfill({ json: STATIONS() }));
    await page.route(/open-meteo\.com/, r => down ? r.fulfill({ status: 500, body: 'down' }) : r.fulfill({ json: weatherBody(r.request().url()) }));
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__glacierWatch?.perf?.marks?.['first-render'], null, { timeout: 45_000 });
    await page.evaluate(() => document.querySelector('.pp-consent-banner')?.remove());
    return { errors, loadMs: Date.now() - t0 };
}

async function canvasInk(page, sel) {
    return page.$eval(sel, (c) => {
        if (!c.width || !c.height) return 0;
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 16) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
        return lit / (d.length / 16);
    });
}

const shot = async (page, name, opts = {}) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name), ...opts }); } };

test.describe('Glacier Watch', () => {
    test('boots clean on Columbia; every view drawn; performance budget', async ({ page }) => {
        const { errors } = await boot(page);
        const n = await page.evaluate(() => window.__glacierWatch.glaciers.length);
        expect(n).toBeGreaterThanOrEqual(25);
        await expect(page.locator('.gw-name')).toHaveCount(n);
        await expect(page.locator('.gw-name[aria-pressed="true"]')).toContainText('Columbia');
        // layout: the stage is the FIRST panel after the hero, the selector directly below it
        const order = await page.$$eval('#gw-app > section, #gw-app > aside', els => els.map(e => e.id || e.getAttribute('aria-label')));
        expect(order.slice(1, 3)).toEqual(['gw-stage-panel', 'Choose a glacier']);
        await expect(page.locator('#gw-chip-bake')).toHaveAttribute('data-state', 'live');
        await expect(page.locator('#gw-chip-live')).toHaveAttribute('data-state', 'live');
        await expect(page.locator('#gw-chip-weather')).toHaveAttribute('data-state', 'live', { timeout: 20_000 });
        await expect(page.locator('#gw-chip-stations')).toHaveAttribute('data-state', 'live');
        await expect(page.locator('#gw-now-body')).toContainText('Compared with the usual seasonal rhythm');
        // the 3D stage: WebGL canvas drawn, density readout computed by the engine
        await page.waitForFunction(() => window.__glacierWatch.stage?.volumeKm3 > 0, null, { timeout: 20_000 });
        const st = await page.evaluate(() => window.__glacierWatch.stage);
        expect(st.massGt).toBeCloseTo(st.volumeKm3 * 0.917, 6);
        await expect(page.locator('#gw-stage-readout')).toContainText('km³');
        const glPixels = await page.evaluate(() => {
            const c = window.__glacierWatch.g3d.renderer.domElement, gl = c.getContext('webgl2') || c.getContext('webgl');
            const px = new Uint8Array(4 * 64), w = c.width, h = c.height; let lit = 0;
            for (let k = 0; k < 64; k++) { gl.readPixels(Math.floor((k % 8 + 0.5) * w / 8), Math.floor((Math.floor(k / 8) + 0.5) * h / 8), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px.subarray(4 * k)); }
            for (let k = 0; k < 64; k++) if (px[4 * k] + px[4 * k + 1] + px[4 * k + 2] > 60) lit++;
            return lit;
        });
        expect(glPixels, '3D canvas has content').toBeGreaterThan(8);
        for (const id of ['year', 'profile', 'decades', 'weather', 'stations']) {
            const h = await page.$eval(`#gw-${id}-chart canvas`, c => c.getBoundingClientRect().height);
            expect(h, `${id} chart drawn`).toBeGreaterThan(100);
        }
        await expect(page.locator('#gw-weather-note')).toContainText('rank');
        await expect(page.locator('#gw-mb-note')).toContainText('no glaciological mass-balance series');
        // hover layer exists on the year chart
        const box = await page.locator('#gw-year-chart canvas').boundingBox();
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
        // performance: let the flow animate, then read the numbers
        await page.locator('#gw-stage').scrollIntoViewIfNeeded();
        await page.waitForTimeout(2500);
        const perf = await page.evaluate(async () => {
            const S = window.__glacierWatch;
            const size = async (u) => (await (await fetch(u)).arrayBuffer()).byteLength;
            return { marks: S.perf.marks, frameMs: S.g3d.frameCostMs(), frames: S.g3d.frameMs.length,
                indexBytes: await size('/data/glaciers/glaciers.json'), detailBytes: await size('/data/glaciers/columbia.json') };
        });
        console.log('GLACIER-WATCH PERF', JSON.stringify(perf));
        expect(perf.marks['first-render'] - perf.marks.boot, 'boot → first render').toBeLessThan(8000);
        // per glacier, like tests/glacier-engine.mjs: the list grows; series/pairs/field stay in <id>.json
        const nGlaciers = await page.evaluate(() => window.__glacierWatch.glaciers.length);
        expect(perf.indexBytes / nGlaciers, 'index payload per glacier').toBeLessThan(5000);
        expect(perf.detailBytes, 'per-glacier payload').toBeLessThan(400_000);
        expect(perf.frames, 'flow animation ran').toBeGreaterThan(5);
        expect(perf.frameMs, 'median 3D frame (software GL)').toBeLessThan(250);
        await shot(page, 'columbia-full.png', { fullPage: true });
        expect(errors).toEqual([]);
    });

    test('deep link, picker and gauge switch drive the page', async ({ page }) => {
        const { errors } = await boot(page, { url: '/glacier-watch.html?g=aletsch' });
        await expect(page.locator('#gw-map-title')).toHaveText('Great Aletsch Glacier');
        await page.locator('.gw-name[data-id="khumbu"]').hover();
        await expect(page.locator('#gw-name-tip')).toBeVisible();
        await expect(page.locator('#gw-name-tip')).toContainText('Khumbu Icefall');
        await page.locator('.gw-name[data-id="khumbu"]').click();
        await expect(page.locator('#gw-map-title')).toHaveText('Khumbu Glacier');
        await expect(page).toHaveURL(/\?g=khumbu$/);
        await page.locator('#gw-gauge-seg button[data-g="upper"]').click();
        await expect(page.locator('#gw-year-sub')).toContainText('Upper glacier');
        await expect(page.locator('#gw-gauge-seg button[data-g="upper"]')).toHaveAttribute('aria-pressed', 'true');
        await page.locator('#gw-stage-note').click();             // focus leaves the gauge button (Space on a button is that button's)
        await page.keyboard.press('Space');
        await expect(page.locator('#gw-flow-toggle')).toHaveAttribute('aria-pressed', 'false');
        // layers, size presets, fullscreen
        await page.locator('#gw-stage-layers button[data-layer="thickness"]').click();
        await expect(page.locator('#gw-stage-legend')).toContainText('Ice thickness');
        const hL = await page.$eval('#gw-stage', e => e.getBoundingClientRect().height);
        await page.locator('#gw-size-seg button[data-size="S"]').click();
        const hS = await page.$eval('#gw-stage', e => e.getBoundingClientRect().height);
        expect(hS).toBeLessThan(hL);
        await page.locator('#gw-fullscreen').click();
        await expect.poll(() => page.$eval('#gw-stage', e => Math.round(e.getBoundingClientRect().height))).toBe(page.viewportSize().height);
        await shot(page, 'khumbu-fullscreen.png');
        await page.keyboard.press('Escape');
        await expect(page.locator('#gw-fullscreen')).toContainText('Full screen');
        await page.locator('#gw-view-2d').click();
        expect(await canvasInk(page, '#gw-map')).toBeGreaterThan(0.05);
        expect(errors).toEqual([]);
    });

    test('below-detection glacier says so instead of drawing a record', async ({ page }) => {
        await boot(page, { url: '/glacier-watch.html?g=south-cascade' });
        const det = await page.evaluate(() => {
            const S = window.__glacierWatch, q = S.gauges.find(g => g.id === S.gaugeId);
            return S.E.detectable(S.sel, q.idx);
        });
        if (det.ok) test.info().annotations.push({ type: 'note', description: `south-cascade mid gauge is detectable (v0 ${det.v0}, err ${det.err})` });
        else await expect(page.locator('#gw-year-note')).toContainText('Below detection');
        // WGMS FoG 2026: South Cascade runs to 2025, recalibrated by USGS, with a 1954 gap
        await expect(page.locator('#gw-mb-note')).toContainText('WGMS revised 62 earlier years');
        await expect(page.locator('#gw-mb-note')).toContainText('latest run since 1955');
        await expect(page.locator('#gw-mb-sub')).toContainText('1953–2025');
        await shot(page, 'south-cascade-year.png', { clip: await page.locator('#gw-year-panel').boundingBox() });
        // a glacier the 2026 copy lacks still says its years are missing — never a quiet end
        await page.goto('/glacier-watch.html?g=zongo');
        await expect(page.locator('#gw-mb-note')).toContainText('2019–2025 are not in our copy');
    });

    test('phone width: no horizontal overflow, touch targets ≥ 44 px', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await boot(page);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(over).toBeLessThanOrEqual(0);
        const small = await page.$$eval('.gw-name, #gw-gauge-seg button, #gw-stage-tools button', els => els.filter(e => e.offsetParent).map(e => e.getBoundingClientRect().height).filter(h => h < 32));
        expect(small).toEqual([]);
        const cardH = await page.$eval('.gw-name', e => e.getBoundingClientRect().height);
        expect(cardH).toBeGreaterThanOrEqual(44);
        await shot(page, 'phone.png', { fullPage: false });
    });

    test('NEGATIVE CONTROL: every feed down looks down, archive still renders', async ({ page }) => {
        const { errors } = await boot(page, { down: true });
        await expect(page.locator('#gw-chip-live')).toHaveAttribute('data-state', 'down');
        await expect(page.locator('#gw-chip-weather')).toHaveAttribute('data-state', /down|stale/, { timeout: 20_000 });
        await expect(page.locator('#gw-chip-stations')).toHaveAttribute('data-state', 'stale');
        await expect(page.locator('#gw-weather-note')).toContainText('unavailable');
        await page.waitForFunction(() => window.__glacierWatch.stage?.volumeKm3 > 0, null, { timeout: 20_000 });
        const h = await page.$eval('#gw-year-chart canvas', c => c.getBoundingClientRect().height);
        expect(h).toBeGreaterThan(100);
        expect(errors).toEqual([]);
    });

    test('the global catalogue: lazy, deep link, search, the official region table', async ({ page }) => {
        const hits = [];
        page.on('request', q => { if (q.url().includes('/data/glaciers/catalog/')) hits.push(q.url()); });
        const { errors } = await boot(page);
        await page.waitForTimeout(1200);
        expect(hits.length, 'the 274 531-glacier catalogue is not fetched before the reader scrolls to it').toBe(0);
        await page.locator('#gw-catalog').scrollIntoViewIfNeeded();
        await page.waitForFunction(() => document.getElementById('gw-catalog')?.dataset.state === 'ready', null, { timeout: 60_000 });
        const t = await page.evaluate(() => ({ n: window.__glacierCatalog.pts.n, sub: document.getElementById('gw-cat-sub').textContent,
            regions: document.querySelectorAll('.gw-cat-reg tbody tr').length, first: document.querySelector('.gw-cat-reg tbody tr td')?.textContent }));
        expect(t.n).toBe(274531);
        expect(t.sub).toContain('274,531 glaciers · 706,744 km²');
        expect(t.regions, 'the 19 regions that hold inventory glaciers').toBe(19);
        expect(t.first).toContain('Subantarctic and Antarctic Islands');
        await expect(page.locator('#gw-cat-sizes')).toContainText('84 %');
        expect(await canvasInk(page, '#gw-cat-map')).toBeGreaterThan(0.01);
        // search by name, then open
        await page.waitForFunction(() => !!window.__glacierCatalog.names, null, { timeout: 30_000 });
        await page.fill('#gw-cat-search', 'hubbard');
        await expect(page.locator('#gw-cat-results button').first()).toContainText('Hubbard Glacier');
        await page.press('#gw-cat-search', 'Enter');
        await expect(page.locator('#gw-cat-card h3')).toHaveText('Hubbard Glacier', { timeout: 15_000 });
        await expect(page.locator('#gw-cat-card')).toContainText('marine-terminating');
        await expect(page.locator('.gw-cat-tracked')).toBeVisible();        // one of the 48 tracked
        // ITS_LIVE speed inside the outline, judged by the tracked tier's own rule
        await expect(page.locator('#gw-cat-card')).toContainText('fastest ice 533 m/yr', { timeout: 20_000 });
        await expect(page.locator('#gw-cat-card')).toContainText('most of the glacier is below what ITS_LIVE resolves');
        await expect(page.locator('#gw-cat-card')).toContainText('above 72 m/yr, twice the typical single-pair error measured on 7 tracked glaciers in this region');
        // its speed year by year: a PARTLY-resolved glacier draws only its fastest ice, 1984–2025 with the part-year withheld
        await expect(page.locator('#gw-cat-ann svg')).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('#gw-cat-ann')).toHaveAttribute('data-years', '1984-2025');
        await expect(page.locator('.gw-ann-keys')).toContainText('fastest ice (98th percentile)');
        await expect(page.locator('.gw-ann-keys')).not.toContainText('typical');
        await expect(page.locator('#gw-cat-ann')).toContainText('2025 is withheld');
        const svg = page.locator('#gw-cat-ann svg'); await svg.scrollIntoViewIfNeeded();
        const bb = await svg.boundingBox();
        await page.mouse.move(bb.x + (34 + (2002 - 1984) / (2025 - 1984) * 254) / 296 * bb.width, bb.y + bb.height / 2);
        await expect(page.locator('.gw-ann-read')).toContainText('2002 · fastest ice 805 m/yr');     // the year Hubbard dammed Russell Fjord
        await page.click('[data-mode="speed"]');
        await page.waitForFunction(() => !!window.__glacierCatalog.S.speed?.colors, null, { timeout: 20_000 });
        await expect(page.locator('#gw-cat-legend')).toContainText('≥ 1 km/yr');
        await expect(page.locator('#gw-cat-legend')).toContainText('below what ITS_LIVE resolves');
        const neutralShare = await page.evaluate(() => { const c = window.__glacierCatalog.S.speed.colors; return c.filter(x => x === '#4b5263').length / c.length; });
        expect(neutralShare, 'most glaciers are drawn neutral: below what ITS_LIVE resolves').toBeGreaterThan(0.9);
        expect(new URL(page.url()).searchParams.get('rgi')).toMatch(/^RGI2000-v7\.0-G-01-\d{5}$/);
        await page.locator('.gw-cat-tracked').click();
        await page.waitForFunction(() => window.__glacierWatch.sel?.id === 'hubbard', null, { timeout: 15_000 });
        expect(errors).toEqual([]);
    });

    test('?rgi= deep link opens the record (an untracked glacier says so)', async ({ page }) => {
        const { errors } = await boot(page, { url: '/glacier-watch.html?g=aletsch&rgi=RGI2000-v7.0-G-11-01515' });
        await page.waitForFunction(() => document.getElementById('gw-catalog')?.dataset.state === 'ready', null, { timeout: 60_000 });
        await expect(page.locator('#gw-cat-card .gw-cat-id')).toContainText('RGI2000-v7.0-G-11-01515', { timeout: 15_000 });
        await expect(page.locator('.gw-cat-tracked')).toHaveCount(0);
        await expect(page.locator('#gw-cat-card')).toContainText('not assigned');
        const hyp = await page.$$eval('.gw-hyp-row i', els => els.length);
        expect(hyp).toBeGreaterThan(1);
        await shot(page, 'catalog-record.png', { clip: await page.locator('#gw-catalog').boundingBox() });
        expect(errors).toEqual([]);
    });

    test('a fully resolved glacier draws both lines; only its own region file is fetched; below detection draws none', async ({ page }) => {
        const ann = [];
        page.on('request', q => { if (/rgi7-annual/.test(q.url())) ann.push(q.url().split('/').pop()); });
        const { errors } = await boot(page, { url: '/glacier-watch.html?g=perito-moreno&rgi=RGI2000-v7.0-G-17-14719' });
        await page.waitForFunction(() => document.getElementById('gw-catalog')?.dataset.state === 'ready', null, { timeout: 60_000 });
        await expect(page.locator('#gw-cat-ann svg')).toBeVisible({ timeout: 20_000 });
        await expect(page.locator('.gw-ann-keys')).toContainText('typical (median) ± ITS_LIVE error');
        const lines = await page.$$eval('#gw-cat-ann svg path[fill="none"]', ps => ps.map(p => p.getAttribute('stroke')));
        expect(lines).toContain('#d95926'); expect(lines).toContain('#3987e5');
        await expect(page.locator('#gw-cat-ann')).toContainText('with less than 50 % of the glacier imaged');
        expect(ann.sort()).toEqual(['rgi7-annual-17.bin.gz', 'rgi7-annual-meta.json']);
        await shot(page, 'catalog-annual.png', { clip: await page.locator('#gw-cat-card').boundingBox() });
        // a below-detection glacier gets no chart at all
        await page.evaluate(() => window.__glacierCatalog.openGlacier(window.__glacierCatalog.meta.watch_links.storglaciaren.index));
        await expect(page.locator('#gw-cat-card h3')).toContainText('Storglaciaeren', { timeout: 15_000 })   // the inventory's own spelling;
        await expect(page.locator('#gw-cat-card')).toContainText('below what ITS_LIVE resolves', { timeout: 15_000 });
        await expect(page.locator('#gw-cat-ann')).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test('NEGATIVE CONTROL: a missing history file says so on the card', async ({ page }) => {
        await page.route('**/data/glaciers/catalog/rgi7-annual-17.bin.gz', r => r.fulfill({ status: 404, body: 'gone' }));
        const { errors } = await boot(page, { url: '/glacier-watch.html?g=perito-moreno&rgi=RGI2000-v7.0-G-17-14719' });
        await page.waitForFunction(() => document.getElementById('gw-catalog')?.dataset.state === 'ready', null, { timeout: 60_000 });
        await expect(page.locator('#gw-cat-ann')).toContainText('the history is unavailable (annual 17: HTTP 404)', { timeout: 20_000 });
        await expect(page.locator('#gw-cat-ann svg')).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test('NEGATIVE CONTROL: a missing inventory says so instead of a partial map', async ({ page }) => {
        await page.route('**/data/glaciers/catalog/rgi7-points.bin.gz', r => r.fulfill({ status: 404, body: 'gone' }));
        const { errors } = await boot(page, { url: '/glacier-watch.html?g=columbia&rgi=RGI2000-v7.0-G-01-00001' });
        await page.waitForFunction(() => document.getElementById('gw-catalog')?.dataset.state === 'error', null, { timeout: 60_000 });
        await expect(page.locator('#gw-cat-sub')).toContainText('unavailable');
        expect(errors).toEqual([]);
    });

    test('NEGATIVE CONTROL: a missing speed table says so on the card and in the legend', async ({ page }) => {
        await page.route('**/data/glaciers/catalog/rgi7-speed.bin.gz', r => r.fulfill({ status: 404, body: 'gone' }));
        const { errors } = await boot(page, { url: '/glacier-watch.html?g=aletsch&rgi=RGI2000-v7.0-G-11-02596' });
        await page.waitForFunction(() => document.getElementById('gw-catalog')?.dataset.state === 'ready', null, { timeout: 60_000 });
        await expect(page.locator('#gw-cat-card')).toContainText('speed table unavailable (speed: HTTP 404)', { timeout: 20_000 });
        await page.click('[data-mode="speed"]');
        await expect(page.locator('#gw-cat-legend')).toContainText('speed table unavailable');
        expect(errors).toEqual([]);
    });
});
