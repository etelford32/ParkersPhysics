import { test, expect } from '@playwright/test';

/**
 * Browser gate for LETTING GO of a selection on solar-system.html — and for
 * the canvas chrome around it on each form factor (the LAYOUT describes at the
 * bottom: phone HUD collapse, the measured bottom stack, the ribbon fitting).
 *
 * Selecting was well covered (tests/solar-system-neo-smoke.spec.js pins that a
 * click selects, a drag does not, and empty sky selects nothing). Deselecting
 * had no path at all: `selectBody(null)` means "select the Sun", empty sky did
 * nothing, Esc was unbound, and the camera stayed locked on whatever was last
 * touched. The page now has ONE way out, `deselectBody()`, reached three ways,
 * and the two input surfaces are gated separately because they fail
 * differently:
 *
 *   DESKTOP (mouse + keyboard, 1280×720)
 *     - a clean click on empty sky deselects, releases the camera lock WHERE
 *       THE CAMERA IS (no fly-back), and restores the panel + HUD
 *     - a drag across empty sky and a right-click do NOT (both are the camera's)
 *     - Esc deselects; with nothing selected Esc closes the info drawer
 *     - the #sel-chip names the selection and its ✕ deselects
 *
 *   PHONE (touch, 390×844)
 *     - a tap on empty sky deselects; a one-finger drag does not
 *     - a PINCH does not — its second finger used to overwrite the tracked
 *       press, so a pinch whose second finger lifted still read as a tap
 *     - the chip sits in thumb reach, inside the viewport, clear of the time
 *       controls, with a ≥44 px close target, and a tap on it deselects
 *
 * Touch input is SYNTHETIC PointerEvents (pointerType 'touch'), not
 * page.touchscreen: CDP's Input.dispatchTouchEvent blocks on the renderer and
 * spaces down/up by ~900 ms on software GL — past CLICK_MAX_MS, so a real
 * tap would be rejected as a hold (CLAUDE.md, the mars.html note).
 * setPointerCapture is stubbed because OrbitControls captures a pointer id the
 * browser has no record of. Each touch gate carries a POSITIVE control: the
 * same synthetic path, as a plain tap, must deselect — otherwise "did not
 * deselect" could just mean "the event never arrived".
 */

const CONSENT = JSON.stringify({ strict: true, functional: false, analytics: false, ts: 1, version: 1 });

async function openPage(page) {
    // The consent banner covers the bottom third of a phone; it is not under test.
    await page.addInitScript((v) => { try { localStorage.setItem('pp_consent_v1', v); } catch {} }, CONSENT);
    // The NEO feeds are not under test either: answer them "down" so no
    // population is drawn and "empty sky" is decided by the planets alone.
    await page.route('**/api/neo/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"upstream_unavailable"}' }));
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/solar-system.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__neoLab?.bodyPixel, null, { timeout: 45_000 });
    // A couple of rendered frames so meshes sit at their real positions.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    return errors;
}

const state = (page) => page.evaluate(() => {
    const lab = window.__neoLab;
    const chip = document.getElementById('sel-chip');
    return {
        has: lab.hasSelection,
        name: lab.selectedBody?.name ?? (lab.hasSelection ? 'Sun' : null),
        mode: lab.cameraMode,
        chip: getComputedStyle(chip).display !== 'none',
        chipName: document.getElementById('sel-chip-name').textContent,
        hud: document.getElementById('hud-body').textContent,
        panelName: document.getElementById('panel-planet-name').textContent,
    };
});

/**
 * A canvas pixel with NOTHING on it — no planet, no moon, no NEO (probeAt is the
 * page's own two pick paths) — that is not under any DOM chrome a person would
 * be tapping instead (the HUD is pointer-events:none, so elementFromPoint
 * alone would happily return the canvas beneath it).
 */
async function emptySky(page) {
    return page.evaluate(() => {
        const lab = window.__neoLab;
        const cr = lab.canvas.getBoundingClientRect();
        const chrome = ['hud', 'sel-chip', 'time-controls', 'sw-ribbon', 'speed-ctrl', 'btn-center', 'btn-panel-open', 'btn-sw']
            .map(id => document.getElementById(id)).filter(Boolean)
            .map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
        const bodies = ['Sun', 'Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Moon']
            .map(n => lab.bodyPixel(n)).filter(Boolean);
        for (let y = cr.top + 60; y < cr.bottom - 60; y += 23) {
            for (let x = cr.left + 30; x < cr.right - 30; x += 23) {
                if (chrome.some(r => x > r.left - 8 && x < r.right + 8 && y > r.top - 8 && y < r.bottom + 8)) continue;
                if (bodies.some(b => Math.hypot(b.x - x, b.y - y) < 40)) continue;
                if (document.elementFromPoint(x, y) !== lab.canvas) continue;
                const p = lab.probeAt(x, y);
                if (!p.planet && p.neo == null) return { x, y };
            }
        }
        return null;
    });
}

/** The pixel of a named body that the page's own pick agrees is that body. */
async function bodyTarget(page, names) {
    for (const name of names) {
        const at = await page.evaluate((n) => window.__neoLab.bodyPixel(n), name);
        if (!at) continue;
        const probe = await page.evaluate(([x, y]) => window.__neoLab.probeAt(x, y), [at.x, at.y]);
        if (probe.planet === name) return { name, ...at };
    }
    return null;
}

// ── Synthetic touch ─────────────────────────────────────────────────────────

async function installTouchShim(page) {
    await page.evaluate(() => {
        const c = window.__neoLab.canvas;
        c.setPointerCapture = () => {};
        c.releasePointerCapture = () => {};
        c.hasPointerCapture = () => false;
    });
}

/** Dispatch a sequence of [type, pointerId, x, y] touch pointer events. */
async function touch(page, steps) {
    await page.evaluate((seq) => {
        const c = window.__neoLab.canvas;
        for (const [type, id, x, y] of seq) {
            const ev = new PointerEvent(type, {
                pointerId: id, pointerType: 'touch', isPrimary: id === 1,
                clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
                bubbles: true, cancelable: true, composed: true,
            });
            c.dispatchEvent(ev);
        }
    }, steps);
}
const tap = (page, x, y) => touch(page, [['pointerdown', 1, x, y], ['pointerup', 1, x, y]]);

// ═════════════════════════════════════════════════════════════════════════════
test.describe('solar-system.html — deselect on DESKTOP (mouse + keyboard)', () => {
    test.setTimeout(120_000);
    test.use({ viewport: { width: 1280, height: 720 } });

    test('a click on empty sky deselects, releases the lock in place, and restores the panel', async ({ page }) => {
        const errors = await openPage(page);
        const boot = await state(page);
        expect(boot.has, 'nothing is selected on load').toBe(false);
        expect(boot.chip, 'no chip with nothing selected').toBe(false);

        const body = await bodyTarget(page, ['Earth', 'Venus', 'Mars', 'Jupiter', 'Sun']);
        expect(body, 'a planet the pick agrees is under its own pixel').not.toBeNull();
        await page.mouse.click(body.x, body.y);
        await page.waitForTimeout(250);
        const sel = await state(page);
        expect(sel.has).toBe(true);
        expect(sel.name).toBe(body.name);
        expect(sel.chip, 'the chip appears on selection').toBe(true);
        expect(sel.chipName).toBe(body.name);
        if (body.name !== 'Sun') expect(sel.mode, 'selecting a planet locks the camera').toBe('lock');

        const sky = await emptySky(page);
        expect(sky, 'a patch of empty sky').not.toBeNull();
        const camBefore = await page.evaluate(() => window.__neoLab.cameraPosition);
        await page.mouse.click(sky.x, sky.y);
        await page.waitForTimeout(250);
        const after = await state(page);
        expect(after.has, 'empty-sky click deselects').toBe(false);
        expect(after.mode, 'and releases the camera lock').toBe('free');
        expect(after.chip).toBe(false);
        expect(after.hud).toBe('—');
        expect(after.panelName, 'panel back to its boot title').toBe('Solar System');
        // Letting go must not move the view: at 1 s/s the locked body moves
        // ~1e-7 units between these reads, so anything visible is a fly-back.
        const camAfter = await page.evaluate(() => window.__neoLab.cameraPosition);
        expect(Math.hypot(...camAfter.map((v, i) => v - camBefore[i]))).toBeLessThan(1e-3);
        expect(errors).toEqual([]);
    });

    test('a drag across empty sky and a right-click keep the selection', async ({ page }) => {
        await openPage(page);
        await page.evaluate(() => window.__neoLab.selectBody(null));    // the Sun: no lock, view stays put
        const sky = await emptySky(page);
        expect(sky).not.toBeNull();

        await page.mouse.move(sky.x, sky.y);
        await page.mouse.down();
        await page.mouse.move(sky.x + 60, sky.y + 25, { steps: 6 });
        await page.mouse.up();
        await page.waitForTimeout(250);
        expect((await state(page)).has, 'a drag that ends on empty sky is a camera move').toBe(true);

        const sky2 = await emptySky(page);
        await page.mouse.click(sky2.x, sky2.y, { button: 'right' });
        await page.waitForTimeout(250);
        expect((await state(page)).has, 'right button belongs to the camera').toBe(true);

        // Positive control: the same pixel, left-clicked, does deselect.
        await page.mouse.click(sky2.x, sky2.y);
        await page.waitForTimeout(250);
        expect((await state(page)).has).toBe(false);
    });

    test('Esc deselects; with nothing selected Esc closes the info drawer', async ({ page }) => {
        await openPage(page);
        await page.evaluate(() => window.__neoLab.selectBody(null));
        await page.click('#btn-panel-open');
        await expect(page.locator('#panel')).toHaveClass(/open/);

        await page.keyboard.press('Escape');
        expect((await state(page)).has, 'first Esc lets go of the selection').toBe(false);
        await expect(page.locator('#panel'), '…and leaves the drawer alone').toHaveClass(/open/);

        await page.keyboard.press('Escape');
        await expect(page.locator('#panel'), 'second Esc closes the drawer').not.toHaveClass(/open/);

        // [ / ] from nothing start at the ends of the list instead of reading
        // "nothing selected" as "the Sun".
        await page.keyboard.press(']');
        expect((await state(page)).name).toBe('Sun');
        await page.keyboard.press('Escape');
        await page.keyboard.press('[');
        const last = await state(page);
        expect(last.has).toBe(true);
        expect(last.name).not.toBe('Sun');
    });

    test('the chip names the selection, hints the shortcuts, and its ✕ deselects', async ({ page }) => {
        await openPage(page);
        await page.evaluate(() => window.__neoLab.selectBody(null));
        const chip = page.locator('#sel-chip');
        await expect(chip).toBeVisible();
        await expect(page.locator('#sel-chip-name')).toHaveText('Sun');
        await expect(page.locator('#sel-chip-hint'), 'desktop shows how else to deselect').toBeVisible();
        await expect(page.locator('#sel-chip-x')).toHaveAttribute('aria-label', 'Deselect Sun');
        const box = await chip.boundingBox();
        expect(box.y, 'desktop chip docks at the top of the canvas').toBeLessThan(200);
        await page.locator('#sel-chip-x').click();
        await expect(chip).toBeHidden();
        expect((await state(page)).has).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
test.describe('solar-system.html — deselect on PHONE (touch)', () => {
    test.setTimeout(120_000);
    test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

    test('a tap selects, a tap on empty sky deselects, and a one-finger drag does not', async ({ page }) => {
        const errors = await openPage(page);
        await installTouchShim(page);

        const body = await bodyTarget(page, ['Sun', 'Earth', 'Venus', 'Mars']);
        expect(body, 'a body the pick agrees is under its pixel').not.toBeNull();
        await tap(page, body.x, body.y);
        await page.waitForTimeout(250);
        expect((await state(page)).name, 'a tap selects').toBe(body.name);

        const sky = await emptySky(page);
        expect(sky, 'empty sky not under the HUD or the bottom controls').not.toBeNull();
        // A one-finger drag past TOUCH_SLOP_PX (12) that ends on empty sky.
        await touch(page, [
            ['pointerdown', 1, sky.x, sky.y],
            ['pointermove', 1, sky.x + 10, sky.y + 6],
            ['pointermove', 1, sky.x + 30, sky.y + 18],
            ['pointerup',   1, sky.x + 30, sky.y + 18],
        ]);
        await page.waitForTimeout(250);
        expect((await state(page)).has, 'a drag is the camera\'s').toBe(true);

        const sky2 = await emptySky(page);
        await tap(page, sky2.x, sky2.y);
        await page.waitForTimeout(250);
        const after = await state(page);
        expect(after.has, 'a clean tap on empty sky deselects').toBe(false);
        expect(after.mode).toBe('free');
        expect(after.chip).toBe(false);
        expect(errors).toEqual([]);
    });

    test('a pinch never reads as a tap, even when its second finger lifts without moving', async ({ page }) => {
        await openPage(page);
        await installTouchShim(page);
        await page.evaluate(() => window.__neoLab.selectBody(null));
        const sky = await emptySky(page);
        expect(sky).not.toBeNull();
        const a = { x: sky.x, y: sky.y }, b = { x: sky.x + 8, y: sky.y + 70 };

        // Finger 1 spreads, finger 2 stays put and lifts first — the exact
        // shape that used to be scored as a tap at finger 2.
        await touch(page, [
            ['pointerdown', 1, a.x, a.y],
            ['pointerdown', 2, b.x, b.y],
            ['pointermove', 1, a.x, a.y - 20],
            ['pointermove', 1, a.x, a.y - 45],
            ['pointerup',   2, b.x, b.y],
            ['pointerup',   1, a.x, a.y - 45],
        ]);
        await page.waitForTimeout(250);
        expect((await state(page)).has, 'pinch keeps the selection').toBe(true);

        // And the reverse lift order.
        await touch(page, [
            ['pointerdown', 1, a.x, a.y],
            ['pointerdown', 2, b.x, b.y],
            ['pointerup',   1, a.x, a.y],
            ['pointerup',   2, b.x, b.y],
        ]);
        await page.waitForTimeout(250);
        expect((await state(page)).has, 'two-finger tap keeps the selection').toBe(true);

        // Positive control: after the gesture ends, a single tap still works.
        await tap(page, a.x, a.y);
        await page.waitForTimeout(250);
        expect((await state(page)).has, 'the synthetic path does reach the handler').toBe(false);
    });

    test('the chip is in thumb reach, clear of the controls, ≥44 px, and a tap on ✕ deselects', async ({ page }) => {
        await openPage(page);
        await page.evaluate(() => window.__neoLab.selectBody(null));
        const chip = page.locator('#sel-chip');
        await expect(chip).toBeVisible();
        await expect(page.locator('#sel-chip-hint'), 'no keyboard hint on a phone').toBeHidden();

        const geo = await page.evaluate(() => {
            const r = (id) => document.getElementById(id)?.getBoundingClientRect();
            return { chip: r('sel-chip'), x: r('sel-chip-x'), tc: r('time-controls'), hud: r('hud'), vw: innerWidth, vh: innerHeight };
        });
        expect(geo.chip.left).toBeGreaterThanOrEqual(0);
        expect(geo.chip.right).toBeLessThanOrEqual(geo.vw);
        expect(geo.chip.top, 'bottom half of the screen — thumb reach').toBeGreaterThan(geo.vh / 2);
        expect(geo.chip.bottom, 'clears the time controls').toBeLessThanOrEqual(geo.tc.top);
        expect(geo.chip.top, 'clears the HUD').toBeGreaterThanOrEqual(geo.hud.bottom);
        expect(geo.x.width).toBeGreaterThanOrEqual(44);
        expect(geo.x.height).toBeGreaterThanOrEqual(44);

        // The ✕ is what a finger actually hits at its centre.
        const hit = await page.evaluate(({ x }) => document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2)?.id, geo);
        expect(hit).toBe('sel-chip-x');
        await page.locator('#sel-chip-x').tap();
        await expect(chip).toBeHidden();
        expect((await state(page)).has).toBe(false);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// LAYOUT. Every rectangle below is the RENDERED box, so a rule that silently
// loses on cascade order (the first version of the phone HUD rule did, and sat
// under the Weather button) fails here rather than in a screenshot.

const boxes = (page) => page.evaluate(() => {
    const r = (id) => { const e = document.getElementById(id); if (!e || getComputedStyle(e).display === 'none') return null; const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width, h: b.height }; };
    const c = document.getElementById('canvas-wrap').getBoundingClientRect();
    return {
        vw: innerWidth, vh: innerHeight, canvas: { left: c.left, right: c.right, top: c.top, bottom: c.bottom },
        hud: r('hud'), more: r('hud-more'), toggle: r('hud-toggle'), weather: r('btn-sw'), info: r('btn-panel-open'),
        chip: r('sel-chip'), ribbon: r('sw-ribbon'), tc: r('time-controls'), speed: r('speed-ctrl'), center: r('btn-center'),
        ribbonScroll: (() => { const e = document.getElementById('sw-ribbon'); return e.scrollWidth - e.clientWidth; })(),
        hudScrolls: (() => { const e = document.getElementById('hud'); return e.scrollHeight > e.clientHeight + 1; })(),
    };
});
const overlaps = (a, b) => !!a && !!b && a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

function expectBottomStackClear(g) {
    const stack = { chip: g.chip, ribbon: g.ribbon, timeControls: g.tc, speed: g.speed, center: g.center };
    const names = Object.keys(stack).filter(k => stack[k]);
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
        expect(overlaps(stack[names[i]], stack[names[j]]), `${names[i]} overlaps ${names[j]}`).toBe(false);
    }
    for (const k of names) {
        expect(stack[k].left, `${k} inside the left edge`).toBeGreaterThanOrEqual(0);
        expect(stack[k].right, `${k} inside the right edge`).toBeLessThanOrEqual(g.vw + 0.5);
        expect(stack[k].bottom, `${k} on screen`).toBeLessThanOrEqual(g.vh + 0.5);
    }
}

for (const vp of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) {
    test.describe(`solar-system.html — PHONE layout ${vp.width}×${vp.height}`, () => {
        test.setTimeout(120_000);
        test.use({ viewport: vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

        test('the HUD boots collapsed below the button row and leaves the centre of the sky clear', async ({ page }) => {
            const errors = await openPage(page);
            await page.evaluate(() => window.__neoLab.selectBody(null));
            const g = await boxes(page);
            expect(g.more, 'HUD details hidden on boot').toBeNull();
            expect(g.toggle, 'the More toggle is shown').not.toBeNull();
            expect(g.toggle.h, 'toggle meets the 44 px touch floor').toBeGreaterThanOrEqual(44);
            expect(overlaps(g.hud, g.weather), 'HUD clear of ⚡ Weather').toBe(false);
            expect(overlaps(g.hud, g.info), 'HUD clear of ☰ Info').toBe(false);
            const cx = (g.canvas.left + g.canvas.right) / 2, cy = (g.canvas.top + g.canvas.bottom) / 2;
            expect(g.hud.bottom, 'collapsed HUD stays in the top band').toBeLessThan(g.canvas.top + (g.canvas.bottom - g.canvas.top) * 0.35);
            expect(!(cx > g.hud.left && cx < g.hud.right && cy > g.hud.top && cy < g.hud.bottom), 'HUD off the canvas centre').toBe(true);
            // The Sun is drawn at the canvas centre at the default camera; it must be visible, not under the HUD.
            const sun = await page.evaluate(() => window.__neoLab.bodyPixel('Sun'));
            expect(!(sun.x > g.hud.left && sun.x < g.hud.right && sun.y > g.hud.top && sun.y < g.hud.bottom), 'the Sun is not under the HUD').toBe(true);
            expect(errors).toEqual([]);
        });

        test('More opens the HUD inside the space above the bottom controls, and the choice persists', async ({ page }) => {
            await openPage(page);
            await page.evaluate(() => window.__neoLab.selectBody(null));
            await page.locator('#hud-toggle').tap();
            await expect(page.locator('#hud-toggle')).toHaveAttribute('aria-expanded', 'true');
            await expect(page.locator('#tog-wind'), 'the layer toggles are reachable when open').toBeVisible();
            const g = await boxes(page);
            expect(g.more).not.toBeNull();
            expect(g.hud.bottom, 'open HUD stops above the selection chip').toBeLessThanOrEqual(g.chip.top + 0.5);
            expect(overlaps(g.hud, g.ribbon) || overlaps(g.hud, g.tc), 'open HUD clear of the bottom stack').toBe(false);
            if (g.hudScrolls) {
                // Content that does not fit scrolls INSIDE the HUD (it takes pointer events while open).
                await page.evaluate(() => { document.getElementById('hud').scrollTop = 9999; });
                expect(await page.evaluate(() => document.getElementById('hud').scrollTop)).toBeGreaterThan(0);
            }
            await page.reload({ waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => !!window.__neoLab?.bodyPixel, null, { timeout: 45_000 });
            await expect(page.locator('#hud-toggle'), 'opened HUD stays open across a reload').toHaveAttribute('aria-expanded', 'true');
            await page.locator('#hud-toggle').tap();
            await expect(page.locator('#hud-more')).toBeHidden();
        });

        test('ribbon, chip, time controls, speed and Center stack without overlap, all on screen', async ({ page }) => {
            await openPage(page);
            await page.evaluate(() => window.__neoLab.selectBody(null));
            const g = await boxes(page);
            expect(g.ribbonScroll, 'ribbon content fits its box (nothing clipped)').toBeLessThanOrEqual(1);
            expectBottomStackClear(g);
            // Every time-control button is hittable at its centre — the ribbon used to cover the second row.
            const blocked = await page.evaluate(() => [...document.querySelectorAll('#time-controls button, #time-controls input')]
                .filter(el => { const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return hit !== el && !el.contains(hit); })
                .map(el => el.id || el.textContent.trim()));
            expect(blocked, 'time-control buttons covered by something else').toEqual([]);
        });
    });
}

test.describe('solar-system.html — DESKTOP layout 1280×720', () => {
    test.setTimeout(120_000);
    test.use({ viewport: { width: 1280, height: 720 } });

    test('the HUD stays fully open with no toggle, and the bottom stack is clear', async ({ page }) => {
        await openPage(page);
        await page.evaluate(() => window.__neoLab.selectBody(null));
        const g = await boxes(page);
        expect(g.toggle, 'no collapse toggle on desktop').toBeNull();
        expect(g.more, 'HUD details visible on desktop').not.toBeNull();
        expect(g.canvas.bottom, 'canvas ends at the bottom of the screen').toBeLessThanOrEqual(g.vh + 0.5);
        expectBottomStackClear(g);
    });
});

// ═════════════════════════════════════════════════════════════════════════════
// SHOWER LABELS. Fixed-pixel sprites anchored ~1 unit from Earth: at the
// system-wide framing every active shower's label landed on Earth's few pixels
// and printed over the others (reported as garbled text on the opening view).
// The date is PINNED to the Orionids peak so the gate does not depend on which
// showers happen to be active on the day CI runs (Orionids + S. Taurids share a
// patch of sky, which is exactly the overlapping pair that was reported).

async function pinShowerDate(page) {
    // Radiants and object labels are DEFAULT-OFF (owner request, 2026-10-11):
    // this gate is about how the labels behave once a visitor switches them on.
    await page.evaluate(() => window.__neoLab.layer.setVisible({ radiants: true, labels: true }));
    await page.evaluate(() => {
        const el = document.getElementById('tc-date-picker');
        el.value = '2026-10-21T12:00';
        el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => window.__neoLab.layer._radiants.length >= 2, null, { timeout: 45_000 });
}
const radiantLabels = (page) => page.evaluate(() => {
    const lab = window.__neoLab, cam = lab.camera, r = lab.canvas.getBoundingClientRect();
    return lab.layer._radiants.map(q => {
        const p = q.label.getWorldPosition(new lab.THREE.Vector3()).project(cam);
        return { code: q.code, text: q.label.userData.text, visible: q.label.visible,
            x: r.left + (p.x * 0.5 + 0.5) * r.width, y: r.top + (-p.y * 0.5 + 0.5) * r.height,
            onScreen: p.z > -1 && p.z < 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 };
    });
});

for (const [form, use] of [
    ['DESKTOP', { viewport: { width: 1280, height: 720 } }],
    ['PHONE', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
]) {
    test.describe(`solar-system.html — shower labels (${form})`, () => {
        test.setTimeout(120_000);
        test.use(use);

        test('no shower label at the system-wide view; close to Earth they show without overlapping', async ({ page }) => {
            await openPage(page);
            await pinShowerDate(page);
            await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
            const wide = await radiantLabels(page);
            expect(wide.length).toBeGreaterThanOrEqual(2);
            expect(wide.filter(l => l.visible).map(l => l.text), 'no shower label on the opening framing').toEqual([]);

            // Earth View preset: the radiant arrows now span most of the frame.
            await page.evaluate(() => document.getElementById('cam-earth').click());
            if (form === 'DESKTOP') {
                await page.waitForFunction(() => window.__neoLab.layer._radiants.some(q => q.label.visible), null, { timeout: 20_000 });
            } else {
                // A portrait phone's Earth View can leave every radiant label
                // outside the safe box — then NONE is drawn, by design.
                await page.waitForTimeout(800);
            }
            const shown = (await radiantLabels(page)).filter(l => l.visible);
            if (form === 'DESKTOP') expect(shown.length, 'at least one shower named up close').toBeGreaterThan(0);
            // …and never under the page's own chrome.
            const chrome = await page.evaluate(() => ['hud', 'time-controls', 'sw-ribbon', 'speed-ctrl', 'sel-chip', 'btn-center']
                .map(id => document.getElementById(id)).filter(e => e && getComputedStyle(e).display !== 'none')
                .map(e => { const b = e.getBoundingClientRect(); return { id: e.id, left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }));
            for (const l of shown) for (const c of chrome) {
                expect(l.x > c.left && l.x < c.right && l.y > c.top && l.y < c.bottom, `${l.code} label anchored under #${c.id}`).toBe(false);
            }
            // On a portrait phone a radiant can point off the narrow frame; only
            // labels actually on screen can collide.
            const near = shown.filter(l => l.onScreen);
            // Drawn labels are ~19 px tall: any two whose anchors sit closer
            // than a line height and a short word apart would print over each other.
            for (let i = 0; i < near.length; i++) for (let j = i + 1; j < near.length; j++) {
                const dx = Math.abs(near[i].x - near[j].x), dy = Math.abs(near[i].y - near[j].y);
                expect(dx > 60 || dy > 18, `${near[i].code} and ${near[j].code} labels overlap`).toBe(true);
            }

            // Back out to the top view: they go again.
            await page.evaluate(() => document.getElementById('cam-top').click());
            await page.waitForFunction(() => !window.__neoLab.layer._radiants.some(q => q.label.visible), null, { timeout: 20_000 });
        });
    });
}
