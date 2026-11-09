/**
 * status-page.spec.js — browser gate for the superadmin System Status page.
 *
 * Hermetic: every feed is mocked (the page probes ~70 /api routes, Supabase,
 * /api/health, NOAA and NASA GIBS; CI has no outbound network and a real
 * probe would make the gate time-dependent). Auth is the shared stubbed
 * Supabase session (tests/fixtures/supabase-session.mjs), so the page's real
 * server-side role check runs against the fixture's user_profiles row.
 *
 * What it pins:
 *   · a non-superadmin never sees the board (the gate stays up, no probes run)
 *   · EVERY registry endpoint gets a row — none is dropped for its category —
 *     and every heartbeat pipeline, upstream host and GIBS layer too
 *   · the overview counts match the tables, and lists each unhealthy feed
 *     WITH ITS REASON: the Climalytix archive's `no_run_published` is printed
 *     with the hint naming the ingest job (it read a bare "freshness=expired")
 *   · NEGATIVE CONTROL: with every feed healthy the issue list is empty and
 *     the page says all clear
 *   · a browser-direct NOAA feed is scored by THIS browser's fetch, not by
 *     the edge's expected 403 — and goes red when the browser cannot reach it
 *   · "issues only" hides healthy rows and whole healthy categories, and a
 *     refresh keeps the filter
 *   · probes are sent a few at a time, never all at once
 *   · phone width: no horizontal page scroll
 */
import { test, expect } from '@playwright/test';
import { PIPELINES, CATEGORIES, HEARTBEAT_PIPELINES } from '../js/pipeline-registry.js';
import { stubSupabaseSession } from './fixtures/supabase-session.mjs';

test.describe.configure({ timeout: 90_000 });
test.use({ viewport: { width: 1366, height: 900 } });

const NWP_DOWN = {
    source: 'climalytix-gfs', role: 'archive', grid: '0p25', freshness: 'expired', reasons: ['no_run_published'],
    series: null, note: 'Our own GFS archive is unavailable for this request; nothing is substituted.',
};
const UPSTREAMS = [
    { source: 'swpc-kp', ok: false, http_status: 403, latency_ms: 40, edge_authoritative: false,
      browser_url: 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json' },
    { source: 'swpc-xray', ok: false, http_status: 403, latency_ms: 41, edge_authoritative: false,
      browser_url: 'https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json' },
    { source: 'donki-cme', ok: true, http_status: 200, latency_ms: 300, edge_authoritative: true },
    { source: 'jpl-horizons', ok: false, http_status: 503, latency_ms: 900, edge_authoritative: true },
];

/**
 * @param {object} o
 * @param {'superadmin'|'user'} [o.role]
 * @param {boolean} [o.healthy]  true = every feed answers healthy (negative control)
 */
async function boot(page, { role = 'superadmin', healthy = false } = {}) {
    const errors = [];
    const probes = { inFlight: 0, peak: 0, seen: new Set() };
    let retiredLayer = null;   // the first GIBS layer probed plays "retired by NASA" (earth-obs-feed.js imports three — not loadable here)
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    const nowIso = () => new Date().toISOString();
    const json = (route, body, status = 200) => route.fulfill({
        status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body),
    });

    await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === 'localhost') {
            if (!url.pathname.startsWith('/api/')) return route.continue();
            if (url.pathname === '/api/health') {
                return json(route, { ok: healthy, checked_at: nowIso(),
                    upstreams: healthy ? UPSTREAMS.map((u) => ({ ...u, ok: u.edge_authoritative ? true : u.ok })) : UPSTREAMS,
                    credentials: { nasa_api_key: { status: 'ok', note: 'configured' }, r2_mirror: { status: 'degraded', note: 'not set' } } });
            }
            probes.seen.add(url.pathname);
            probes.peak = Math.max(probes.peak, ++probes.inFlight);
            await new Promise((r) => setTimeout(r, 15));
            probes.inFlight--;
            if (!healthy) {
                if (url.pathname.startsWith('/api/climalytix/nwp')) return json(route, { ...NWP_DOWN, generated_at: nowIso() });
                if (url.pathname === '/api/weather/grid') return json(route, { fetched_at: nowIso(), freshness: 'stale', reasons: ['fallback-source'], source: 'met-norway:72x36' });
                if (url.pathname === '/api/noaa/dst') return json(route, { error: 'cache_empty', message: 'no rows' }, 503);
            }
            return json(route, { fetched_at: nowIso(), source: 'fixture' });
        }
        if (url.hostname === 'wvs.earthdata.nasa.gov') {
            retiredLayer ??= url.searchParams.get('LAYERS');
            const retired = !healthy && url.searchParams.get('LAYERS') === retiredLayer;
            return route.fulfill({ status: retired ? 404 : 200, headers: { 'access-control-allow-origin': '*' }, contentType: 'image/png', body: '' });
        }
        if (url.hostname === 'services.swpc.noaa.gov') {
            if (!healthy && url.pathname.includes('xrays')) return route.abort();
            return json(route, []);
        }
        return route.abort();
    });

    // The heartbeat table, and a REAL (stubbed) Supabase session: the page's
    // gate verifies the role against user_profiles, so the fixture answers it.
    const rows = HEARTBEAT_PIPELINES.map((p) => ({
        pipeline_name: p.key, last_success_at: nowIso(), last_failure_at: null, last_failure_reason: null,
        last_source: p.primarySource ? `${p.primarySource}:720x360` : 'primary', consecutive_fail: 0,
    }));
    if (!healthy) {
        Object.assign(rows.find((r) => r.pipeline_name === 'weather_grid'), { last_source: 'met-norway:72x36', last_failure_reason: 'chunk 1200 HTTP 429' });
        Object.assign(rows.find((r) => r.pipeline_name === 'r2_archive'), { last_success_at: null, last_failure_at: nowIso(), last_failure_reason: 'r2_not_configured', consecutive_fail: 9 });
        rows.push({ pipeline_name: 'brand_new_job', last_success_at: nowIso(), last_failure_at: null, last_failure_reason: null, last_source: 'x', consecutive_fail: 0 });
    }
    await stubSupabaseSession(page, { plan: 'enterprise', role, tables: { pipeline_heartbeat: rows } });
    await page.goto('/status.html', { waitUntil: 'domcontentloaded' });
    return { errors, probes };
}

const settle = (page) => page.waitForFunction(() => window.__status && Object.values(window.__status.feeds).every((g) => Array.isArray(g)), null, { timeout: 60_000 });
const chip = (page, level) => page.locator(`#feed-counts [data-level="${level}"] b`);

test('a signed-in non-superadmin never sees the board and no feed is probed', async ({ page }) => {
    const { probes } = await boot(page, { role: 'user' });
    await expect(page.locator('#auth-gate')).toBeVisible();
    await expect(page.locator('#auth-gate')).toContainText(/Superadmin required|Superadmin Access Required/);
    await expect(page.locator('#status-main')).toBeHidden();
    await page.waitForTimeout(500);
    expect(probes.seen.size).toBe(0);
});

test('every incoming feed has a row, and each unhealthy one says why', async ({ page }) => {
    const { errors, probes } = await boot(page);
    await expect(page.locator('#status-main')).toBeVisible();
    await settle(page);

    // Every registry endpoint is probed and drawn — none lost to its category.
    const drawn = await page.locator('#rt-proxies tr[data-feed]').evaluateAll((rows) => rows.map((r) => r.dataset.feed.slice('endpoint:'.length)));
    expect(drawn.sort()).toEqual(PIPELINES.map((p) => p.id).sort());
    expect(await page.locator('#rt-proxies .rt-cat').count()).toBe(CATEGORIES.filter((c) => PIPELINES.some((p) => p.category === c.id)).length);
    // Probes were paced.
    expect(probes.peak).toBeGreaterThan(1);
    expect(probes.peak).toBeLessThanOrEqual(8);

    // Heartbeats: every registered pipeline, plus the unregistered row.
    await expect(page.locator('#rt-heartbeat tr[data-feed]')).toHaveCount(HEARTBEAT_PIPELINES.length + 1);
    await expect(page.locator('#rt-heartbeat tr[data-feed="heartbeat:weather_grid"]')).toHaveAttribute('data-level', 'warn');
    await expect(page.locator('#rt-heartbeat tr[data-feed="heartbeat:weather_grid"] .rt-why')).toContainText('met-norway:72x36, not open-meteo');
    await expect(page.locator('#rt-heartbeat tr[data-feed="heartbeat:r2_archive"] .rt-why')).toContainText('r2_not_configured');
    await expect(page.locator('#rt-heartbeat tr[data-feed="heartbeat:brand_new_job"]')).toHaveAttribute('data-level', 'ok');

    // The Climalytix archive: red, with its own reason and the fix.
    const nwp = page.locator('#rt-proxies tr[data-feed="endpoint:climalytix-nwp"]');
    await expect(nwp).toHaveAttribute('data-level', 'crit');
    await expect(nwp.locator('.rt-status')).toContainText('freshness=expired');
    await expect(nwp.locator('.rt-why')).toContainText('no_run_published');
    await expect(nwp.locator('.rt-why')).toContainText('climalytix-ingest');
    await expect(page.locator('#rt-proxies tr[data-feed="endpoint:weather-grid"] .rt-why')).toContainText('fallback-source');
    await expect(page.locator('#rt-proxies tr[data-feed="endpoint:noaa-dst"] .rt-status')).toContainText('HTTP 503 · cache_empty');

    // Upstreams: ALL of them, and the browser-direct ones scored from here.
    await expect(page.locator('#rt-upstreams tr[data-feed]')).toHaveCount(UPSTREAMS.length);
    await expect(page.locator('#rt-upstreams tr[data-feed="upstream:swpc-kp"]')).toHaveAttribute('data-level', 'ok');
    await expect(page.locator('#rt-upstreams tr[data-feed="upstream:swpc-kp"]')).toContainText('this browser');
    await expect(page.locator('#rt-upstreams tr[data-feed="upstream:swpc-xray"]')).toHaveAttribute('data-level', 'crit');
    await expect(page.locator('#rt-upstreams tr[data-feed="upstream:jpl-horizons"]')).toHaveAttribute('data-level', 'crit');
    await expect(page.locator('#rt-upstreams tr[data-feed="upstream:donki-cme"]')).toHaveAttribute('data-level', 'ok');

    const gibsLayers = await page.evaluate(async () => (await import('/js/earth-obs-feed.js')).EARTH_OBS_LAYERS.length);
    expect(gibsLayers).toBeGreaterThan(3);
    await expect(page.locator('#rt-gibs tr[data-feed]')).toHaveCount(gibsLayers);
    await expect(page.locator('#rt-gibs tr[data-level="crit"]')).toHaveCount(1);

    // The overview is the tables, counted.
    const count = async (level) => page.locator(`#rt-heartbeat tr[data-level="${level}"], #rt-proxies tr[data-level="${level}"], #rt-upstreams tr[data-level="${level}"], #rt-gibs tr[data-level="${level}"]`).count();
    const crit = await count('crit'), warn = await count('warn'), ok = await count('ok');
    await expect(chip(page, 'crit')).toHaveText(String(crit));
    await expect(chip(page, 'warn')).toHaveText(String(warn));
    await expect(chip(page, 'ok')).toHaveText(String(ok));
    await expect(chip(page, 'total')).toHaveText(String(PIPELINES.length + HEARTBEAT_PIPELINES.length + 1 + UPSTREAMS.length + gibsLayers));
    const nwpRoutes = PIPELINES.filter((p) => (p.probePath ?? p.endpoint).startsWith('/api/climalytix/nwp')).length;
    expect(crit).toBe(nwpRoutes + 1 /* noaa-dst */ + 1 /* r2_archive */ + 2 /* swpc-xray, jpl-horizons */ + 1 /* gibs */);
    expect(warn).toBe(2);   // weather grid: the route and its heartbeat
    await expect(page.locator('#feed-issue-table tbody tr')).toHaveCount(crit + warn);
    // Down first; each row carries the reason.
    await expect(page.locator('#feed-issue-table tbody tr').first()).toHaveAttribute('data-level', 'crit');
    await expect(page.locator('#feed-issue-table tr[data-feed="endpoint:climalytix-nwp"]')).toContainText('no_run_published');
    await expect(page.locator('#feed-issue-table tr[data-feed="heartbeat:r2_archive"]')).toContainText('r2_not_configured');
    await expect(page.locator('.feed-pending')).toHaveCount(0);

    // Issues only: healthy rows and wholly healthy categories go; a refresh keeps it.
    await page.locator('#rt-filter').click();
    await expect(page.locator('#rt-filter')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#rt-proxies tr[data-level="ok"]:visible')).toHaveCount(0);
    await expect(page.locator('#rt-proxies tr[data-feed]:visible')).toHaveCount(nwpRoutes + 2);
    await expect(page.locator('#rt-proxies .rt-cat[data-issues="0"]:visible')).toHaveCount(0);
    await page.locator('#rt-refresh-proxies').click();
    await settle(page);
    await expect(page.locator('#rt-proxies tr[data-feed]:visible')).toHaveCount(nwpRoutes + 2);
    await page.locator('#rt-filter').click();
    await expect(page.locator('#rt-proxies tr[data-level="ok"]:visible').first()).toBeVisible();
    expect(errors).toEqual([]);
});

test('NEGATIVE CONTROL: with every feed healthy the issue list is empty', async ({ page }) => {
    const { errors } = await boot(page, { healthy: true });
    await settle(page);
    await expect(chip(page, 'crit')).toHaveText('0');
    await expect(chip(page, 'warn')).toHaveText('0');
    await expect(page.locator('#feed-issue-table')).toHaveCount(0);
    await expect(page.locator('#feed-all-clear')).toContainText('scored feeds are healthy');
    await expect(page.locator('#k-api')).toHaveText(`${PIPELINES.length}/${PIPELINES.length}`);
    await expect(page.locator('#k-pipes')).toHaveText(`${HEARTBEAT_PIPELINES.length}/${HEARTBEAT_PIPELINES.length}`);
    expect(errors).toEqual([]);
});

test.describe('phone width', () => {
    test.use({ viewport: { width: 390, height: 844 } });
    test('the feed board fits: no horizontal page scroll', async ({ page }) => {
        await boot(page);
        await settle(page);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        expect(over).toBeLessThanOrEqual(1);
        await expect(page.locator('#feed-issue-table')).toBeVisible();
    });
});
