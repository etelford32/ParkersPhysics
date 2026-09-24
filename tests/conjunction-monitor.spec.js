/**
 * conjunction-monitor.spec.js — the alert engine's conjunction screen runs.
 * ═══════════════════════════════════════════════════════════════════════════
 * js/alert-engine.js starts a ConjunctionMonitor for advanced-alert users. The
 * monitor builds a HEADLESS SatelliteTracker (`new SatelliteTracker(null, …)`)
 * — and until 2026-09-24 the tracker's constructor called `parent.add(...)`
 * unconditionally, threw a TypeError, the monitor caught it as a console.warn
 * and returned, and not one conjunction was ever screened for anyone.
 *
 * This runs the REAL monitor end to end in a browser: a stubbed signed-in
 * advanced user (tests/fixtures/supabase-session.mjs) with one satellite_alerts
 * subscription (the ISS, 25 km), and a stubbed CelesTrak catalogue with a
 * positive and a negative control in the ISS's own orbit:
 *   · CHASER NEAR — 0.04° of mean anomaly behind (~4.7 km): must alert
 *   · SAME SHELL FAR — a quarter orbit away: shares the shell, never closes
 * The page is a bare harness (just the import map `three` needs), so nothing
 * else on a real page can mask a monitor failure. The SGP4 WASM is not loaded
 * on it, which is how this also caught the SECOND bug under the first: the
 * JS-fallback screen built its target track with Float64Array#map and returned
 * [] for every query (tests/conjunction-screen.mjs pins that in Node).
 */
import { test, expect } from '@playwright/test';
import { stubSupabaseSession } from './fixtures/supabase-session.mjs';
import { issRecord } from './fixtures/climate-lab-fixtures.mjs';

test.describe.configure({ timeout: 120_000 });

const HARNESS = `<!doctype html><html><head><meta charset="utf-8">
<script type="importmap">{"imports":{"three":"/js/vendor/three-0.160.0/three.module.js","three/addons/":"/js/vendor/three-0.160.0/jsm/"}}</script>
</head><body>conjunction harness</body></html>`;

test('an advanced user\'s subscription is screened and a close approach alerts', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
    const warnings = [];
    page.on('console', (m) => { if (/ConjunctionMonitor/.test(m.text())) warnings.push(m.text()); });

    await stubSupabaseSession(page, {
        plan: 'advanced', role: 'user',
        tables: { satellite_alerts: [{ norad_id: 25544, satellite_name: 'ISS (ZARYA)', threshold_km: 25, active: true }] },
    });
    const now = Date.now();
    const target = issRecord(now);
    const near = issRecord(now, { norad: 90001, name: 'CHASER NEAR', meanAnomaly: 270.0 - 0.04 });
    const far = issRecord(now, { norad: 90002, name: 'SAME SHELL FAR', meanAnomaly: 180.0 });
    await page.route('**/api/celestrak/tle**', (route) => {
        const u = new URL(route.request().url());
        const sats = u.searchParams.get('group') === 'active' ? [target, near, far]
            : u.searchParams.get('norad') === '25544' ? [target] : [];
        return route.fulfill({ json: { satellites: sats, count: sats.length } });
    });
    await page.route('**/__conj-harness.html', (r) => r.fulfill({ contentType: 'text/html', body: HARNESS }));
    await page.goto('/__conj-harness.html');

    const out = await page.evaluate(async () => {
        const { auth } = await import('/js/auth.js');
        await auth.ready();
        const { ConjunctionMonitor } = await import('/js/conjunction-alert.js');
        const events = [];
        addEventListener('conjunction-alert', (e) => events.push(e.detail));
        const m = new ConjunctionMonitor();
        await m._scan();
        return {
            signedIn: auth.isSignedIn(), advanced: auth.canUseAdvancedAlerts(),
            trackerBuilt: !!m._tracker,
            headless: m._tracker?._headless ?? null,
            worker: m._tracker ? m._tracker._worker : 'no tracker',
            results: m.getResults(), events,
        };
    });

    expect(out.signedIn && out.advanced, 'the stubbed user is a signed-in advanced user').toBe(true);
    expect(out.trackerBuilt, `the headless tracker was built (monitor said: ${warnings.join(' | ')})`).toBe(true);
    expect(out.headless).toBe(true);
    expect(out.worker, 'a headless tracker spawns no render-propagation worker').toBeNull();

    const chasers = out.results.map((r) => r.chaser_norad);
    expect(chasers, JSON.stringify(out.results)).toContain(90001);
    expect(chasers, 'a same-shell object a quarter orbit away never closes to 25 km').not.toContain(90002);
    const hit = out.results.find((r) => r.chaser_norad === 90001);
    expect(hit.target_norad).toBe(25544);
    expect(hit.dist_km).toBeGreaterThan(1);
    expect(hit.dist_km).toBeLessThan(10);                // ~4.7 km along-track
    expect(out.events.map((e) => e.chaser_norad)).toEqual(chasers);
    expect(errors, errors.join('\n')).toEqual([]);
});
