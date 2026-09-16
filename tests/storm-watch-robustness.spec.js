/**
 * storm-watch-robustness.spec.js — the Storm Watch panel must never lie
 * about the feed it is drawing.
 *
 * Companion to storm-watch-visibility.spec.js. That file pins WHERE the
 * panel is; this one pins WHAT IT SAYS. Both exist because of the same
 * user report — "storm watch isn't showing up" — which turned out to have
 * two independent causes, and only the first had been fixed.
 *
 * The second cause: /api/storms answers 200 with an empty list when both
 * upstreams are down (deliberate — the page must not break), the client
 * treated any 200 as healthy, and the panel therefore rendered
 *
 *     "No active tropical cyclones worldwide right now. 🌊"
 *     "Source: NOAA NHC + NASA EONET · updated 01:13 PM"
 *
 * …over a feed that had returned nothing at all, with a timestamp read
 * from the wall clock. In mid-September that is indistinguishable from a
 * broken panel, because it IS one. See js/storm-feed.js's header.
 *
 * Every test here mocks /api/storms, so no live network is needed — which
 * is also the only way to exercise the outage paths at all, since the real
 * feeds are reachable exactly when we don't need them to fail.
 */
import { test, expect } from '@playwright/test';

const PANEL   = '#storm-watch-panel';
const LIST    = '#storm-watch-panel-list';
const HEALTH  = '#storm-watch-panel-health';
const FOOT    = '#storm-watch-panel-foot';
const COUNT   = '#storm-watch-panel-count';

// earth.html boots a full WebGL globe on a software rasteriser here.
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const STORM = {
    id: 'al072026', name: 'HURRICANE IMELDA', basin: 'ATLANTIC',
    classification: 'HU', lat: 24.6, lon: -71.2,
    intensityKt: 95, pressureHpa: 958,
    movementDir: 315, movementKt: 12, hemisphere: 'N',
    source: 'nhc', lastUpdate: '2026-09-16T09:00:00Z',
};

/** Serve a fixed /api/storms payload for the whole page lifetime. */
async function mockStorms(page, body, { status = 200 } = {}) {
    await page.route('**/api/storms', route => {
        if (status !== 200) return route.fulfill({ status, body: 'upstream error' });
        return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(body),
        });
    });
}

async function openPanel(page) {
    await page.goto('/earth.html', { waitUntil: 'load' });
    await page.waitForSelector(PANEL, { timeout: 60_000 });
    // The first storm-update lands shortly after boot; wait for the panel
    // to move off its mount-time "connecting" placeholder.
    await expect(page.locator(FOOT)).not.toHaveText(/connecting/, { timeout: 30_000 });
}

test.describe('storm watch feed honesty', () => {
    test('healthy feed: storms render and the footer shows the FEED time', async ({ page }) => {
        const updated = '2026-09-16T09:30:00.000Z';
        await mockStorms(page, {
            updated, count: 1, freshness: 'live', coverage: 1, missingBasins: [],
            storms: [STORM],
            sources: { nhc: { ok: true, count: 1 }, eonet: { ok: true, count: 0 } },
        });
        await openPanel(page);

        await expect(page.locator(`${LIST} .sw-card`)).toHaveCount(1);
        await expect(page.locator(`${LIST} .sw-name`)).toContainText('imelda');
        await expect(page.locator(COUNT)).toContainText('1 active');
        // Healthy → the disclosure banner stays out of the way entirely.
        await expect(page.locator(HEALTH)).toBeHidden();

        // The footer must print the payload's own timestamp. Rendering
        // 09:30Z in the runner's locale is what the panel does, so compare
        // against that rather than a hard-coded string.
        const expected = await page.evaluate(u =>
            new Date(u).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), updated);
        await expect(page.locator(FOOT)).toContainText(expected);
        await expect(page.locator(FOOT)).not.toContainText('no new data');
    });

    test('both upstreams down: the panel refuses to claim the tropics are quiet', async ({ page }) => {
        await mockStorms(page, {
            updated: new Date().toISOString(), count: 0,
            freshness: 'stale', coverage: 0,
            missingBasins: ['ATLANTIC', 'EPAC', 'CPAC', 'WPAC', 'IO', 'SH'],
            note: 'Both upstream cyclone feeds (NOAA NHC and NASA EONET) are unreachable — '
                + 'this list is empty because nothing could be read, not because no storms are active.',
            storms: [],
            sources: { nhc: { ok: false, count: 0, error: 'timeout' },
                       eonet: { ok: false, count: 0, error: 'HTTP 503' } },
        });
        await openPanel(page);

        // THE REGRESSION: this sentence must not appear over a dead feed.
        await expect(page.locator(LIST)).not.toContainText('No active tropical cyclones worldwide');
        await expect(page.locator(LIST)).toContainText(/unreachable/i);
        await expect(page.locator(LIST)).toContainText(/not a report that the tropics are quiet/i);

        // And the failure is announced, not merely absent.
        await expect(page.locator(HEALTH)).toBeVisible();
        await expect(page.locator(HEALTH)).toContainText(/Storm feeds unreachable/i);

        // The health dot must not read "live".
        await expect(page.locator('#storm-watch-panel-pulse')).toHaveClass(/stale|offline/);

        // No storms were ever received → no invented timestamp.
        await expect(page.locator(FOOT)).toContainText(/no data received|no new data since/i);
    });

    test('partial coverage: the list renders but names the basins it cannot see', async ({ page }) => {
        await mockStorms(page, {
            updated: new Date().toISOString(), count: 1,
            freshness: 'degraded', coverage: 0.5,
            missingBasins: ['WPAC', 'IO', 'SH'],
            note: 'NASA EONET is unreachable — West Pacific, Indian Ocean and '
                + 'Southern Hemisphere cyclones are missing from this list.',
            storms: [STORM],
            sources: { nhc: { ok: true, count: 1 }, eonet: { ok: false, count: 0, error: 'HTTP 500' } },
        });
        await openPanel(page);

        // A partial list is the dangerous case: it LOOKS complete.
        await expect(page.locator(`${LIST} .sw-card`)).toHaveCount(1);
        await expect(page.locator(HEALTH)).toBeVisible();
        await expect(page.locator(HEALTH)).toContainText(/Partial coverage/i);
        await expect(page.locator(HEALTH)).toContainText(/West Pacific/);
        // The count must not assert a worldwide total it cannot support.
        await expect(page.locator(COUNT)).toContainText('visible');
        await expect(page.locator(COUNT)).not.toContainText('active');
    });

    test('endpoint 500: degrades without claiming absence, and ↻ retries', async ({ page }) => {
        await mockStorms(page, null, { status: 500 });
        await openPanel(page);

        await expect(page.locator(LIST)).not.toContainText('No active tropical cyclones worldwide');
        await expect(page.locator(HEALTH)).toBeVisible();
        await expect(page.locator('#storm-watch-panel-pulse')).toHaveClass(/stale|offline/);

        // The retry button must actually hit the endpoint again — a dead
        // control on a dead feed is how a user concludes the panel is broken.
        let hits = 0;
        await page.route('**/api/storms', route => {
            hits++;
            return route.fulfill({ status: 500, body: 'still down' });
        });
        await page.click('#storm-watch-panel-retry');
        await expect.poll(() => hits, { timeout: 15_000 }).toBeGreaterThan(0);
    });

    test('a payload predating the freshness contract is read from its sources block', async ({ page }) => {
        // An edge cache can outlive a deploy by its TTL, so the client must
        // still detect an outage in the OLD response shape (no `freshness`).
        await mockStorms(page, {
            updated: new Date().toISOString(), count: 0, storms: [],
            sources: { nhc: { ok: false, count: 0, error: 'boom' },
                       eonet: { ok: false, count: 0, error: 'boom' } },
        });
        await openPanel(page);

        await expect(page.locator(LIST)).not.toContainText('No active tropical cyclones worldwide');
        await expect(page.locator(HEALTH)).toBeVisible();
    });

    test('a hung request cannot strand the panel on "connecting" forever', async ({ page }) => {
        // No timeout on the client fetch meant a hung connection never
        // settled: no event, no error, and the panel sat on its mount-time
        // placeholder indefinitely. StormFeed now bounds every request.
        await page.route('**/api/storms', async route => {
            await new Promise(r => setTimeout(r, 60_000));   // never answers in time
            return route.abort();
        });
        await page.goto('/earth.html', { waitUntil: 'load' });
        await page.waitForSelector(PANEL, { timeout: 60_000 });

        // Within the client's request timeout the panel must reach a
        // reported failure state rather than staying blank.
        await expect(page.locator(HEALTH)).toBeVisible({ timeout: 30_000 });
        await expect(page.locator(LIST)).not.toContainText('No active tropical cyclones worldwide');
    });
});
