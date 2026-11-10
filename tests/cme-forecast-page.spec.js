// cme-forecast-page.spec.js — deterministic browser gate for the public
// issue-time forecast surface. The route is mocked so the test asserts the
// page contract without depending on Supabase, NOAA, or wall-clock events.
//
// Beyond the data contract this also gates the two layout promises the page
// makes: the calendar is a real 42-cell month grid, and on a desktop
// viewport the whole surface fits ABOVE THE FOLD. Both have regressed here
// before — the page shipped at 4204 px tall with a 7-day strip.

import { test, expect } from '@playwright/test';

const ENV_NOISE = /Failed to load resource|ERR_TUNNEL|ERR_FAILED|ERR_NAME|Supabase|favicon/;

test.describe('CME Forecast public page', () => {
    let errors;

    test.beforeEach(async ({ page }) => {
        errors = [];
        page.on('console', (message) => {
            if (message.type() === 'error' && !ENV_NOISE.test(message.text())) errors.push(message.text());
        });
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.addInitScript(() => {
            try {
                localStorage.setItem('pp_consent_v1', JSON.stringify(
                    { strict: true, functional: true, analytics: false, ts: Date.now(), version: 1 }));
            } catch { /* ignore */ }
        });
    });

    test('renders locked windows, live stats, skill, and navigation', async ({ page }) => {
        const now = Date.now();
        const iso = (hours) => new Date(now + hours * 3600e3).toISOString();
        await page.route('**/api/cme/skill**', (route) => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ data: {
                updated: iso(-.25),
                models: [
                    { model_id: 'flux-rope-v1', is_hindcast: false, n_scored: 5, mae_hours: 7.6, bias_hours: -1.4, hits_12h: 4 },
                    { model_id: 'dbm-v1', is_hindcast: false, n_scored: 12, mae_hours: 10.2, bias_hours: 2.3, hits_12h: 7 },
                ],
                events: [
                    {
                        event_id: 'PP-LIVE-X12', donki_id: '2026-08-19T12:00-CME-001', launch: iso(-15), speed_kms: 1180,
                        forecasts: { 'flux-rope-v1': {
                            issued_at: iso(-14.5), predicted: iso(31), early: iso(24), late: iso(39),
                            p_hit: .82, p10: .63, p20: .36, min_bz_p50: -17, min_bz_p5: -34, n_train: 2,
                            flare: { class: 'X1.2', region: 14126 },
                        } },
                        truth: null,
                    },
                    {
                        event_id: 'PP-SCORED-M84', donki_id: '2026-08-12T05:00-CME-004', launch: iso(-180), speed_kms: 840,
                        forecasts: { 'flux-rope-v1': {
                            issued_at: iso(-179), predicted: iso(-128), early: iso(-136), late: iso(-120),
                            p_hit: .71, min_bz_p50: -11, min_bz_p5: -24,
                            flare: { class: 'M8.4', region: 14111 },
                        } },
                        truth: { arrived: true, shock: iso(-130), min_bz_nt: -14, v_kms: 690 },
                    },
                ],
            } }),
        }));

        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });

        await expect(page.locator('nav a').first()).toBeVisible({ timeout: 15_000 });
        await expect(page.locator('h1')).toContainText('CME Forecast');
        // The brand belongs to the PAGE, not only to the shared nav.
        await expect(page.locator('.cmef-brand')).toContainText('Parkers Physics');
        await expect(page.locator('.cmef-brand img')).toHaveAttribute('src', '/icons/logo-mark.svg');
        await expect(page.locator('#cmef-feed-label')).toContainText('Issue-time ledger');
        await expect(page.locator('#cmef-active-count')).toHaveText('1');
        await expect(page.locator('#cmef-next-phit')).toHaveText('82%');
        await expect(page.locator('#cmef-bz')).toHaveText('-17 nT');
        await expect(page.locator('#cmef-event-list .cmef-ledger-card')).toHaveCount(2);
        await expect(page.locator('#cmef-event-list')).toContainText('X1.2 · AR14126');
        await expect(page.locator('#cmef-event-list')).toContainText('Outcome pending');
        await expect(page.locator('#cmef-event-list')).toContainText('L1 error +2.0 h');
        await expect(page.locator('#cmef-skill-grid')).toContainText('7.6 h');
        await expect(page.locator('#cmef-timeline')).toHaveAttribute('data-ready', 'true');

        // A real month calendar: six weeks of cells, Sunday-first, with the
        // full arrival record on the selected day.
        await expect(page.locator('#cmef-calendar-grid .cmef-day')).toHaveCount(42);
        await expect(page.locator('.cmef-cal-dow span').first()).toHaveText('Sun');
        await expect(page.locator('#cmef-calendar-range')).toContainText(
            new Date(now).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }));
        await expect(page.locator('#cmef-calendar-grid .cmef-day.is-today')).toHaveCount(1);
        await expect(page.locator('#cmef-calendar-detail')).toContainText('X1.2 · AR14126');
        await expect(page.locator('#cmef-calendar-detail')).toContainText('P(Bz ≤ −20)');
        await expect(page.locator('#cmef-detail-count')).toContainText('window');

        const openDay = page.locator('#cmef-calendar-grid .cmef-day[aria-expanded="true"]');
        await expect(openDay).toHaveCount(1);
        await openDay.click();
        await expect(page.locator('#cmef-calendar-detail')).toContainText('No day selected');

        // Month paging moves the grid a whole month and keeps 42 cells.
        const month = await page.locator('#cmef-calendar-range').textContent();
        await page.locator('#cmef-calendar-prev').click();
        await expect(page.locator('#cmef-calendar-range')).not.toHaveText(String(month));
        await expect(page.locator('#cmef-calendar-grid .cmef-day')).toHaveCount(42);
        await page.locator('#cmef-calendar-today').click();
        await expect(page.locator('#cmef-calendar-range')).toHaveText(String(month));

        await page.locator('[data-cmef-range="30d"]').click();
        await expect(page.locator('[data-cmef-range="30d"]')).toHaveAttribute('aria-pressed', 'true');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('fits one desktop screen, and never scrolls sideways on a phone', async ({ page }) => {
        await page.route('**/api/cme/skill**', (route) => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ data: { updated: new Date().toISOString(), models: [], events: [] } }),
        }));

        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#cmef-timeline')).toHaveAttribute('data-ready', 'true');

        // The page's own surface — nav excluded — must end at the fold. The
        // shared nav parks hidden dropdown panels below it on EVERY page, so
        // documentElement.scrollHeight is not the measurement that matters.
        const fold = await page.evaluate(() => {
            const r = document.querySelector('.cmef').getBoundingClientRect();
            return { bottom: Math.round(r.bottom), viewport: document.documentElement.clientHeight };
        });
        expect(fold.bottom).toBeLessThanOrEqual(fold.viewport);

        await page.setViewportSize({ width: 390, height: 844 });
        await page.waitForTimeout(300);
        const horizontal = await page.evaluate(() => {
            const de = document.documentElement;
            const m = document.querySelector('.cmef').getBoundingClientRect();
            return { overflow: Math.round(m.right - de.clientWidth), width: de.clientWidth };
        });
        expect(horizontal.overflow).toBeLessThanOrEqual(0);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('fails visibly when the ledger is unavailable', async ({ page }) => {
        await page.route('**/api/cme/skill**', (route) => route.abort());
        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });

        await expect(page.locator('#cmef-feed-label')).toHaveText('Forecast ledger unavailable');
        await expect(page.locator('#cmef-event-list')).toContainText('No forecast records available');
        await expect(page.locator('#cmef-event-list')).toContainText('does not manufacture demo arrivals');
        await expect(page.locator('#cmef-timeline')).toHaveAttribute('data-ready', 'true');
        await expect(page.locator('#cmef-calendar-grid .cmef-day')).toHaveCount(42);
        await expect(page.locator('#cmef-calendar-detail')).toContainText('No issue-locked CME arrival window');
        await expect(page.locator('#cmef-skill-grid')).toContainText('Prospective skill is maturing');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });
    // The DAILY LAYER (2026-11-09, js/cme-ledger-status.js): a quiet calendar
    // must say "checked, nothing coming", a missed run must look like a gap,
    // and a glancing CME the baselines timed is drawn hollow — never as a
    // Parkers Physics forecast. Before this a healthy-but-quiet ledger and a
    // dead cron rendered the same blank month.
    const DAY = 86400e3;
    const dayIso = (offset) => new Date(Math.floor(Date.now() / DAY) * DAY + offset * DAY).toISOString().slice(0, 10);
    const dailyPayload = ({ lastRunH = -3, runOffsets = [-4, -3, -1, 0], failing = false } = {}) => {
        const days = [];
        for (let o = -4; o <= 6; o++) {
            days.push({ day: dayIso(o), issue_day: dayIso(Math.min(o, 0)), lead_days: Math.max(o, 0),
                p_arrival: o < 0 ? 0.002 : 0.04 * (o + 1), p_geo: 0.01, lower_bound: o >= 3,
                resolved: o <= -3, obs_arrival: o <= -3 ? false : null, obs_geo: null });
        }
        const at = (h) => new Date(Date.now() + h * 3600e3).toISOString();
        return { freshness: failing || lastRunH < -26 ? 'stale' : 'fresh', data: {
            updated: at(lastRunH),
            ledger: { last_run: at(lastRunH), age_h: -lastRunH, state: lastRunH < -26 ? 'stale' : 'fresh',
                summary: failing ? null : '44 CMEs screened · 2 Earth-relevant · 0 new locks · flux-rope idle (no Earth-directed CME) · outlook issued',
                consecutive_fail: failing ? 2 : 0, last_failure_at: failing ? at(lastRunH) : null,
                last_failure_reason: failing ? 'lock_resolve_failed: DONKI' : null, basis: 'heartbeat' },
            outlook: { model: 'cme-outlook-v0', days, run_days: runOffsets.map(dayIso) },
            models: [],
            events: [{ event_id: 'PP-RT-GLANCE', donki_id: 'GLANCE', launch: at(-60), speed_kms: 357,
                half_deg: 27, lat_deg: 7, lon_deg: 31,
                forecasts: { 'dbm-v1': { issued_at: at(-50), predicted: `${dayIso(1)}T07:10:00Z` },
                             'ballistic-v1': { issued_at: at(-50), predicted: `${dayIso(1)}T12:44:00Z` } },
                truth: null }],
        } };
    };
    const mockDaily = async (page, opts) => {
        await page.route('**/api/cme/skill**', (route) => route.fulfill({
            contentType: 'application/json', body: JSON.stringify(dailyPayload(opts)) }));
        await page.route('**/api/noaa/regions**', (route) => route.abort());
        await page.route('**/api/hek/coronal-holes**', (route) => route.abort());
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });
        await expect(page.locator('#cmef-feed-dot')).not.toHaveAttribute('data-mode', 'loading', { timeout: 15_000 });
    };
    const cell = (page, offset) => page.locator(
        `#cmef-calendar-grid [data-calendar-day="${Math.floor(Date.now() / DAY) * DAY + offset * DAY}"]`);

    test('daily layer: run record, locked odds, and a glancing CME on a quiet ledger', async ({ page }) => {
        await mockDaily(page);
        // The feed label is the cron's own account of its last run.
        await expect(page.locator('#cmef-feed-label')).toContainText('Ledger ran');
        await expect(page.locator('#cmef-feed-label')).toContainText('44 CMEs screened');
        await expect(page.locator('#cmef-feed-dot')).toHaveAttribute('data-mode', 'live');
        // Offsets can fall in the neighbouring month's grid rows; every one
        // asserted here is within ±6 days, so page to it when it is not shown.
        const show = async (offset) => {
            if (!(await cell(page, offset).count())) {
                await page.locator(offset < 0 ? '#cmef-calendar-prev' : '#cmef-calendar-next').click();
            }
            return cell(page, offset);
        };
        // Today: checked, with its locked odds.
        await expect((await show(0)).locator('.cmef-run.is-checked')).toHaveCount(1);
        await expect((await show(0)).locator('.cmef-odds')).toHaveText('4%');
        // Three days out: a lower bound, and says so.
        await expect((await show(3)).locator('.cmef-odds')).toHaveText('≥16%');
        // The glancing CME: hollow chip, no probability, not a forecast chip.
        const glance = (await show(1)).locator('.cmef-chip.is-screened');
        await expect(glance).toHaveCount(1);
        await expect(glance).toContainText('07:10');
        await expect(page.locator('#cmef-calendar-grid .cmef-chip:not(.is-screened)')).toHaveCount(0);
        await expect(page.locator('#cmef-event-list')).toContainText('No forecast records available');
        await (await show(1)).click();
        const detail = page.locator('#cmef-calendar-detail');
        await expect(detail).toContainText('Glancing CME');
        await expect(detail).toContainText('not a Parkers Physics forecast');
        await expect(detail).toContainText('32° off the Sun–Earth line');
        // NEGATIVE CONTROL built into the fixture: offset −2 has no run on
        // record while −3 and −1 do — it must be drawn as a gap, and say so.
        await expect((await show(-2)).locator('.cmef-run.is-missed')).toHaveCount(1);
        await expect((await show(-1)).locator('.cmef-run.is-missed')).toHaveCount(0);
        await (await show(-2)).click();
        await expect(detail).toContainText('No ledger run is on record for this day');
        await (await show(0)).click();
        await expect(detail).toContainText('44 CMEs screened');
        // Still one screen.
        const fold = await page.evaluate(() => ({
            bottom: Math.round(document.querySelector('.cmef').getBoundingClientRect().bottom),
            viewport: document.documentElement.clientHeight,
        }));
        expect(fold.bottom).toBeLessThanOrEqual(fold.viewport);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('daily layer: an overdue or failing run turns the feed amber and says why', async ({ page }) => {
        await mockDaily(page, { lastRunH: -40, runOffsets: [-4, -3, -2] });
        await expect(page.locator('#cmef-feed-dot')).toHaveAttribute('data-mode', 'stale');
        await expect(page.locator('#cmef-feed-label')).toContainText('daily run overdue');
        await page.unroute('**/api/cme/skill**');
        await mockDaily(page, { failing: true });
        await expect(page.locator('#cmef-feed-dot')).toHaveAttribute('data-mode', 'stale');
        await expect(page.locator('#cmef-feed-label')).toContainText('Ledger run failing');
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    // The eruption outlook (js/cme-outlook-strip.js): its OWN strip, its own
    // feeds, never chips. Live: seven cells with numbers; feeds down: an
    // honest "unavailable" — never a 0 %.
    test('eruption outlook strip: live and feeds-down', async ({ page }) => {
        await page.route('**/api/cme/skill**', (route) => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ data: { updated: new Date().toISOString(), models: [], events: [] } }),
        }));
        const today = new Date().toISOString().slice(0, 10);
        await page.route('**/api/noaa/regions**', (route) => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ data: { regions: [
                { region: 14321, observed_date: today, location: 'N12E05', area: 420,
                  m_flare_probability: 60, x_flare_probability: 15 },
                { region: 14322, observed_date: today, location: 'S18E40', area: 150,
                  m_flare_probability: 20, x_flare_probability: 1 },
            ] } }),
        }));
        await page.route('**/api/hek/coronal-holes**', (route) => route.abort());
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });

        const strip = page.locator('#cmef-outlook');
        await expect(strip).toHaveAttribute('data-state', 'ok', { timeout: 15_000 });
        await expect(strip.locator('.cmef-ol-cell')).toHaveCount(7);
        await expect(strip).toContainText('2 visible regions');
        await expect(strip).toContainText('coronal holes · feed down');
        await expect(strip.locator('.cmef-ol-cell.is-lb')).toHaveCount(4);
        const texts = await strip.locator('.cmef-ol-p').allTextContents();
        expect(texts.every((t) => /%$/.test(t)), texts.join(' ')).toBe(true);
        expect(texts.some((t) => t === '0%')).toBe(false);
        // Outlook never writes into the ledger's calendar.
        await expect(page.locator('#cmef-calendar-grid .cmef-chip')).toHaveCount(0);
        // Still one screen with the strip in place.
        const fold = await page.evaluate(() => ({
            bottom: Math.round(document.querySelector('.cmef').getBoundingClientRect().bottom),
            viewport: document.documentElement.clientHeight,
        }));
        expect(fold.bottom).toBeLessThanOrEqual(fold.viewport);
        expect(errors, errors.join('\n')).toHaveLength(0);
    });

    test('eruption outlook says unavailable when the regions feed is down', async ({ page }) => {
        await page.route('**/api/cme/skill**', (route) => route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({ data: { updated: new Date().toISOString(), models: [], events: [] } }),
        }));
        await page.route('**/api/noaa/regions**', (route) => route.abort());
        await page.route('**/api/hek/coronal-holes**', (route) => route.abort());
        await page.goto('/cme-forecast.html', { waitUntil: 'domcontentloaded' });
        const strip = page.locator('#cmef-outlook');
        await expect(strip).toHaveAttribute('data-state', 'no-regions', { timeout: 15_000 });
        await expect(strip).toContainText('unavailable · regions feed down');
        await expect(strip.locator('.cmef-ol-p')).toHaveText(Array(7).fill('—'));
        expect(errors, errors.join('\n')).toHaveLength(0);
    });
});
