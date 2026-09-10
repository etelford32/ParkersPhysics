/**
 * earth-time-controls-position.spec.js — the EarthView time bar lives on
 * the TOP rail, and nothing on that rail sits on top of anything else.
 *
 * #time-controls moved from bottom-centre to the top of #app in 2026-09.
 * The move is one CSS block, but the reason this gate exists is that the
 * bar shares its lane with five other absolutely-positioned things, and
 * every one of the collisions below was MEASURED on the live page rather
 * than reasoned about:
 *
 *   · #layer-panel — top-right, 230px + a 10px gutter. Centred on the
 *     VIEWPORT the 585px bar reaches x=805 in a 1025px window while the
 *     panel starts at x=785, both at top:10px. The bar is therefore
 *     centred in the band LEFT of the panel (left:10 / right:250 /
 *     margin-inline:auto over width:fit-content), not on the viewport.
 *   · the verdict card — 400px on the left, home top:110px → y=192,
 *     against a bar bottom of exactly 192. Zero clearance, and the bar
 *     grows ~21px whenever #tc-forecast-status is in flight, so the z70
 *     card would have painted over the z60 speed buttons for the length
 *     of every forecast fetch. The card's home is max(110px, bar + 20).
 *   · #hud — only rendered on the ?verdict=0 / card-boot-failure path,
 *     so its 190px lane is reserved only then (and on phones, where it
 *     is full-width, it moves BELOW the bar instead).
 *   · #feed-error-banner / #trip-hud / #iss-hud — the three transient
 *     top-centre overlays, all previously at top:10px.
 *   · #sw-bar — the bar used to cover its top 14px at every width,
 *     because bottom:10px + ~72px tall overlaps a bottom:0 / 24px strip.
 *     That one the move simply fixes.
 *
 * Every offset above derives from --ev-timebar-h, published from the
 * bar's MEASURED height (earth.html, next to the scrub wiring). The bar
 * is 72–114px tall depending on breakpoint, on whether #tc-buttons-row
 * wrapped, and on whether the forecast-status row is in flight — this
 * spec has measured both 79px and 100px at the same viewport across two
 * runs, which is precisely why a constant would rot.
 *
 * Also pinned: the bar must not overflow its band. Docked at the bottom
 * it rendered 487px wide inside a 390px viewport (x=-49 .. 439) and
 * #app's overflow:hidden ate the −1w edge label and half the clock,
 * silently, on every phone.
 *
 * No live network needed — this asserts chrome geometry only.
 */
import { test, expect } from '@playwright/test';

// Widths chosen from the measured collision boundaries, not roundness:
// 1025 is the worst case for the layer-panel lane (the bar is at its
// full 585px and the panel is at its leftmost desktop position), 1280 is
// the worst case for the verdict-card lane, 390 is the phone that used
// to clip.
const DESKTOP = [
    { width: 1920, height: 1080 },
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 1025, height: 800 },
    { width: 1024, height: 768 },
];

/** Boxes of the chrome that shares the top rail, plus the bar itself. */
async function railProbe(page) {
    return page.evaluate(() => {
        const box = (el) => {
            if (!el) return null;
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return null;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return null;
            return {
                x: r.left, y: r.top, r: r.right, b: r.bottom,
                w: r.width, h: r.height, z: Number(cs.zIndex) || 0,
            };
        };
        const ids = ['time-controls', 'layer-panel', 'hud', 'sw-bar',
                     'mobile-toolbar', 'ev-verdict-card',
                     // Both home in the 110–130px band the bar now
                     // reaches into when it wraps; #loc-panel only renders
                     // on the ?verdict=0 path.
                     'loc-panel', 'storm-watch-panel'];
        const boxes = {};
        for (const id of ids) boxes[id] = box(document.getElementById(id));

        const bar = boxes['time-controls'];
        const overlaps = [];
        for (const [id, o] of Object.entries(boxes)) {
            if (id === 'time-controls' || !o || !bar) continue;
            if (bar.x < o.r && o.x < bar.r && bar.y < o.b && o.y < bar.b) {
                overlaps.push(id);
            }
        }
        const app = document.getElementById('app').getBoundingClientRect();
        return {
            boxes, overlaps,
            app: { x: app.left, y: app.top, r: app.right, b: app.bottom, h: app.height },
            barVar: getComputedStyle(document.documentElement)
                .getPropertyValue('--ev-timebar-h').trim(),
        };
    });
}

/** The bar publishes its height, so wait for the first observation. */
async function gotoEarth(page, query = '') {
    await page.goto(`/earth.html${query}`, { waitUntil: 'load' });
    await page.waitForSelector('#time-controls', { timeout: 30_000 });
    await page.waitForFunction(
        () => getComputedStyle(document.documentElement)
            .getPropertyValue('--ev-timebar-h').trim() !== '',
        null, { timeout: 30_000 },
    );
}

test.describe('EarthView time bar — top rail', () => {
    // One test per width: earth.html is a heavy first load, and a single
    // test looping five navigations spends its whole budget on boot.
    for (const vp of DESKTOP) {
        test(`desktop ${vp.width}×${vp.height}: docked at the top, clear of every neighbour`, async ({ page }) => {
            await page.setViewportSize(vp);
            await gotoEarth(page);
            // The verdict card mounts on window.load; give it its beat so
            // the overlap check actually sees the card.
            await page.waitForSelector('#ev-verdict-card', { timeout: 30_000 });

            const p = await railProbe(page);
            const bar = p.boxes['time-controls'];

            expect(bar, 'bar present').not.toBeNull();
            // Top rail: the bar starts within 20px of #app's top edge and
            // sits entirely in the upper third — not "somewhere above the
            // middle", which a bottom-docked bar would also satisfy on a
            // short viewport.
            expect(bar.y - p.app.y, 'bar hugs the top of #app').toBeLessThanOrEqual(20);
            expect(bar.b, 'bar stays in the top third')
                .toBeLessThan(p.app.y + p.app.h / 3);

            // Nothing on the rail overlaps anything else.
            expect(p.overlaps, 'bar overlaps chrome').toEqual([]);

            // The bar fits its band — never clipped by #app's overflow.
            expect(bar.x, 'bar left inside #app').toBeGreaterThanOrEqual(p.app.x);
            expect(bar.r, 'bar right inside #app').toBeLessThanOrEqual(p.app.r);

            // And --ev-timebar-h tracks what was actually rendered.
            expect(Math.abs(parseFloat(p.barVar) - bar.h), '--ev-timebar-h')
                .toBeLessThanOrEqual(1);
        });
    }

    test('phone: bar fits the viewport and the verdict card starts below it', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await gotoEarth(page);
        await page.waitForSelector('#ev-verdict-card', { timeout: 30_000 });

        const p = await railProbe(page);
        const bar = p.boxes['time-controls'];
        const card = p.boxes['ev-verdict-card'];

        // The pre-move bug: 487px of bar inside a 390px viewport.
        expect(bar.x).toBeGreaterThanOrEqual(p.app.x);
        expect(bar.r).toBeLessThanOrEqual(p.app.r);
        expect(bar.w).toBeLessThanOrEqual(390);

        // The card is the page's default dashboard and is full-width on a
        // phone — it must start below the bar, not on top of it.
        expect(card).not.toBeNull();
        expect(card.y).toBeGreaterThanOrEqual(bar.b);
        expect(p.overlaps).toEqual([]);
    });

    test('?verdict=0 desktop: the legacy #hud gets its own lane', async ({ page }) => {
        // #hud is top-LEFT here, so the bar's band starts after it. 900px
        // is the measured worst case: the band is narrow enough that the
        // bar wraps to 114px and reaches the 110px-home panels below.
        await page.setViewportSize({ width: 900, height: 800 });
        await gotoEarth(page, '?verdict=0');
        const p = await railProbe(page);
        expect(p.boxes['hud'], 'hud renders on the opt-out path').not.toBeNull();
        expect(p.overlaps).toEqual([]);
        expect(p.boxes['time-controls'].x)
            .toBeGreaterThanOrEqual(p.boxes['hud'].r);
    });

    test('?verdict=0 phone: the full-width #hud moves below the bar', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await gotoEarth(page, '?verdict=0');
        const p = await railProbe(page);
        expect(p.boxes['hud']).not.toBeNull();
        expect(p.boxes['hud'].y)
            .toBeGreaterThanOrEqual(p.boxes['time-controls'].b);
        expect(p.overlaps).toEqual([]);
    });

    test('the transient top-centre overlays stack under the bar', async ({ page }) => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoEarth(page);

        const probe = await page.evaluate(() => {
            // All three are display:none until their trigger fires; this
            // asserts the geometry they WOULD land in.
            document.getElementById('feed-error-banner').style.display = 'block';
            document.getElementById('trip-hud').classList.add('show');
            document.getElementById('iss-hud').classList.add('visible');
            const barBottom = document.getElementById('time-controls')
                .getBoundingClientRect().bottom;
            const tops = {};
            for (const id of ['feed-error-banner', 'trip-hud', 'iss-hud']) {
                tops[id] = document.getElementById(id).getBoundingClientRect().top;
            }
            return { barBottom, tops };
        });

        for (const [id, top] of Object.entries(probe.tops)) {
            expect(top, `${id} clears the time bar`)
                .toBeGreaterThanOrEqual(probe.barBottom);
        }
    });

    test('the bar no longer covers the space-weather bar', async ({ page }) => {
        // Pre-move this overlapped at EVERY viewport: bottom:10px + a
        // ~72px bar against #sw-bar's bottom:0 / 24px strip, with the bar
        // at z60 over the strip's z50.
        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoEarth(page);
        const p = await railProbe(page);
        expect(p.overlaps).not.toContain('sw-bar');
    });
});
