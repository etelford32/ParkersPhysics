// chicxulub-page.spec.js — browser gate for chicxulub.html
//   npx playwright test tests/chicxulub-page.spec.js
// The page has no feeds: everything it draws comes from js/chicxulub/*.
import { test, expect } from '@playwright/test';

const NOISE = /supabase|Failed to load resource|ERR_|net::|favicon/i;

async function boot(page) {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errors.push(m.text()); });
    await page.goto('/chicxulub.html');
    await page.waitForFunction(() => window.__chicxulub);
    await page.addStyleTag({ content: '.pp-consent-banner{display:none!important}' });
    return errors;
}

test('renders the reconstruction from the kernels, with no errors', async ({ page }) => {
    const errors = await boot(page);
    await expect(page.locator('#chx-tiles .chx-tile')).toHaveCount(7);
    const k = await page.evaluate(() => {
        const c = window.__chicxulub;
        return { d: c.base.diameterKm.med, v: c.base.speedKms.med, rows: c.O.allRows().length };
    });
    await expect(page.locator('#chx-tiles .chx-tile').first()).toContainText(`${Math.round(k.d)} km`);
    await expect(page.locator('#chx-evidence tbody tr:not(.grp)')).toHaveCount(k.rows);
    // both provenance badges are on the page — nothing silently promoted
    expect(await page.locator('#chx-evidence .chx-badge.ok').count()).toBeGreaterThan(20);
    expect(await page.locator('#chx-evidence .chx-badge.no').count()).toBeGreaterThan(5);
    await expect(page.locator('#chx-orbit svg path')).toHaveCount(1);
    await expect(page.locator('#chx-hours rect[data-hr]')).toHaveCount(48);
    await expect(page.locator('#chx-ejecta svg')).toBeVisible();
    await expect(page.locator('#chx-climate svg')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
});

test('the evidence switch changes the answer; all-iridium needs comet speed', async ({ page }) => {
    await boot(page);
    const kv = page.locator('#chx-post-kv');
    const before = await kv.innerText();
    await page.locator('#chx-scenario button[data-v="all-iridium"]').click();
    await expect(kv).not.toHaveText(before);
    await expect(kv).toContainText('all of it (imposed)');
    await expect(page.locator('#chx-post-note')).toContainText('comet');
    await page.locator('#chx-scenario button[data-v="asteroid"]').click();
    await page.locator('#chx-rim button[data-v="190"]').click();
    const d190 = await page.evaluate(() => window.__chicxulub.R.reconstructImpactor({ scenario: 'asteroid', craterKm: 190 }).diameterKm.med);
    await expect(kv).toContainText(`${d190.toFixed(1)} km`);
});

test('trajectory: picking an hour redraws the orbit; a slow arrival constrains nothing', async ({ page }) => {
    await boot(page);
    const kv = page.locator('#chx-orbit-kv');
    const before = await kv.innerText();
    await page.locator('#chx-hours rect[data-hr="15"]').click();
    await expect(page.locator('#chx-hr-o')).toHaveText('15:00');
    await expect(kv).not.toHaveText(before);
    await page.locator('#chx-v').fill('12');
    await expect(page.locator('#chx-traj-note')).toContainText('every hour of the day');
});

test('distance slider reorders the timeline; phone width does not overflow', async ({ page }) => {
    await boot(page);
    await page.locator('#chx-r').fill('0.1');
    const near = await page.locator('#chx-timeline').innerText();
    await page.locator('#chx-r').fill('0.95');
    const far = await page.locator('#chx-timeline').innerText();
    expect(far).not.toEqual(near);
    expect(far).toContain('below the horizon');
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('3-D stage: the asteroid comes down the reconstructed path and the hole opens', async ({ page }) => {
    test.setTimeout(120000);
    const errors = await boot(page);
    await page.waitForFunction(() => window.__chicxulub.stageReady, null, { timeout: 60000 });
    await expect(page.locator('#chx-stage-fail')).toBeHidden();
    const at = (t) => page.evaluate((tt) => {
        const c = window.__chicxulub; c.setStageTime(tt); c.stage.renderNow();
        const st = c.SM.impactorState(c.TL, tt);
        return { p: c.stage.probe(), st, hole: c.SM.surfaceHeightKm(c.TL, 0, tt), clock: document.getElementById('chx-stage-clock').textContent,
                 phase: document.querySelector('#chx-stage-phase b').textContent };
    }, t);
    // before impact: the drawn rock is where the kernel says (east → x, up → y, north → −z), at true radius
    const a = await at(-8);
    expect(a.p.rock.visible).toBe(true);
    expect(a.p.rock.x).toBeCloseTo(a.st.east, 6); expect(a.p.rock.y).toBeCloseTo(a.st.up, 6); expect(a.p.rock.z).toBeCloseTo(-a.st.north, 6);
    expect(a.p.rock.radius).toBeCloseTo(a.st.radiusKm, 6);
    expect(a.p.rock.x).toBeGreaterThan(0); expect(a.p.rock.z).toBeLessThan(0);          // north-east
    expect(a.p.centreY).toBeCloseTo(0, 6); expect(a.p.fireball.visible).toBe(false);
    expect(a.clock).toBe('T−8.0 s');
    // after: the rock is gone, the ground at the centre is the kernel's depth, fire and curtain are up
    const b = await at(40);
    expect(b.p.rock.visible).toBe(false);
    expect(b.p.centreY).toBeCloseTo(b.hole, 4); expect(b.hole).toBeLessThan(-15);
    expect(b.p.fireball.visible).toBe(true); expect(b.p.curtain.visible).toBe(true);
    expect(b.phase).toBe('The hole opens');
    // relief ×5 scales the ground only
    await page.locator('#chx-exag button[data-v="5"]').click();
    const c = await at(40);
    expect(c.p.centreY).toBeCloseTo(5 * b.hole, 3);
    await expect(page.locator('#chx-stage-note')).toContainText('×5');
    await page.locator('#chx-exag button[data-v="1"]').click();
    // the canvas is actually lit (not a black or blown-out frame)
    const lum = await page.evaluate(() => {
        const c = window.__chicxulub; c.stage.fly('crater', { instant: true }); c.setStageTime(230); c.stage.renderNow();
        const gl = c.stage.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * 4);
        gl.readPixels(0, Math.floor(h / 2), w, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let s = 0, white = 0; for (let i = 0; i < w; i++) { const l = (px[4 * i] + px[4 * i + 1] + px[4 * i + 2]) / 3; s += l; if (l > 250) white++; }
        return { mean: s / w, white: white / w };
    });
    expect(lum.mean).toBeGreaterThan(12); expect(lum.white).toBeLessThan(0.2);
    // a preset is a one-shot flight; camera.up never moves
    await page.locator('#chx-view button[data-v="region"]').click();
    await page.waitForFunction(() => !window.__chicxulub.stage.state.flying, null, { timeout: 30000 });
    const p = await page.evaluate(() => window.__chicxulub.stage.probe());
    expect(p.up).toEqual([0, 1, 0]); expect(p.camera[1]).toBeGreaterThan(400);
    expect(errors).toEqual([]);
});

test('3-D stage: play runs the clock forward and the slider takes it back', async ({ page }) => {
    test.setTimeout(120000);
    await boot(page);
    await page.waitForFunction(() => window.__chicxulub.stageReady, null, { timeout: 60000 });
    const t0 = await page.evaluate(() => window.__chicxulub.state.W.t);
    expect(t0).toBe(-20);
    await page.locator('#chx-play').click();
    await page.waitForFunction((t) => window.__chicxulub.state.W.t > t + 2, t0, { timeout: 60000 });
    await page.locator('#chx-play').click();
    await expect(page.locator('#chx-play')).toHaveText('Play');
    await page.locator('#chx-time').fill('1');
    const end = await page.evaluate(() => ({ t: window.__chicxulub.state.W.t, end: window.__chicxulub.SM.LONG_END_S }));
    expect(end.t / end.end).toBeCloseTo(1, 6);
    await expect(page.locator('#chx-stage-phase b')).toHaveText('The long winter');
    await expect(page.locator('#chx-stage-clock')).toHaveText('T+30.0 years');
    await expect(page.locator('#chx-stage-kv')).toContainText('gone');
});

test('constraint lab: scorecard, held-out rows, and sliders that break rows', async ({ page }) => {
    test.setTimeout(120000);
    const errors = await boot(page);
    await page.waitForFunction(() => window.__chicxulub.labReady, null, { timeout: 90000 });
    const k = await page.evaluate(() => { const c = window.__chicxulub; return { chi2: c.FIT.chi2, d: c.FIT.vars.diameterKm, fitted: c.C.FITTED.length, held: c.C.HELD.length, outer: c.FIT.rows.find((r) => r.id === 'outerRing').z }; });
    await expect(page.locator('#chx-score tbody tr[data-row]')).toHaveCount(k.fitted + k.held);
    await expect(page.locator('#chx-chi')).toContainText('this is the best fit');
    await expect(page.locator('#chx-fit')).toBeDisabled();
    // the page prints the kernel's own z for a held-out row, and calls the outer ring a miss
    expect(Number(await page.locator('#chx-score tr[data-row="outerRing"]').getAttribute('data-z'))).toBeCloseTo(k.outer, 2);
    await expect(page.locator('#chx-score tr[data-row="outerRing"]')).toContainText('miss');
    await expect(page.locator('#chx-loo tbody tr')).toHaveCount(k.fitted);
    await expect(page.locator('#chx-loo tr[data-row="iridium"]')).toContainText('nothing else measures it');
    await expect(page.locator('#chx-modes li')).toHaveCount(5);
    await expect(page.locator('#chx-el tbody tr')).toHaveCount(5);
    await expect(page.locator('#chx-prof-diameterKm')).toContainText('km');
    // halve the diameter: the rim and iridium rows break, χ² rises, and Best fit brings it back
    await page.locator('#chx-var-diameterKm').fill('0.4');
    const bad = await page.evaluate(() => window.__chicxulub.C.evaluate(window.__chicxulub.LAB.vars).chi2);
    expect(bad).toBeGreaterThan(k.chi2 + 20);
    await expect(page.locator('#chx-score tr[data-row="rim"]')).toContainText('miss');
    await expect(page.locator('#chx-fit')).toBeEnabled();
    await page.locator('#chx-fit').click();
    await expect(page.locator('#chx-chi')).toContainText('this is the best fit');
    expect(await page.evaluate(() => window.__chicxulub.LAB.vars.diameterKm)).toBeCloseTo(k.d, 6);
    // the pair map is drawn, and choosing the same variable twice is repaired
    const lit = await page.evaluate(() => { const c = document.getElementById('chx-pair'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 2] > 120 && d[i + 2] > d[i] + 40) n++; return n / (d.length / 4); });
    expect(lit).toBeGreaterThan(0.01);
    await page.locator('#chx-px').selectOption('speedKms');
    expect(await page.locator('#chx-py').inputValue()).not.toBe('speedKms');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
});

test('one clock: marks jump the time, the camera follows the story, and the planet shows fronts and darkness', async ({ page }) => {
    test.setTimeout(120000);
    const errors = await boot(page);
    await page.waitForFunction(() => window.__chicxulub.stageReady, null, { timeout: 60000 });
    const settle = () => page.waitForFunction(() => !window.__chicxulub.stage.state.flying, null, { timeout: 30000 });
    const snap = () => page.evaluate(() => { const c = window.__chicxulub; c.stage.renderNow(); return { W: { t: c.state.W.t, follow: c.state.W.follow, view: c.state.W.view }, p: c.stage.probe(), st: c.stage.state, fr: c.SM.frontsAt(c.state.W.t), slider: Number(document.getElementById('chx-time').value) }; });
    await expect(page.locator('#chx-clock-marks button')).toHaveCount(9);
    // a mark sets the clock to the kernel's own event time and the slider to its position
    await page.locator('#chx-clock-marks button[data-ev="crater"]').click();
    await settle();
    let s = await snap();
    const ev = await page.evaluate(() => window.__chicxulub.EVENTS.find((e) => e.id === 'crater'));
    expect(s.W.t).toBeCloseTo(ev.t, 6); expect(s.slider).toBeCloseTo(ev.slider, 3);
    expect(s.W.view).toBe('crater');                                  // followed: approach → crater
    await expect(page.locator('#chx-view button[data-v="crater"]')).toHaveAttribute('aria-pressed', 'true');
    // hours later: the camera pulls back to the planet and the fronts are where the kernel says
    await page.evaluate(() => window.__chicxulub.setStageTime(30000));
    await settle();
    s = await snap();
    expect(s.W.view).toBe('planet'); expect(s.p.camera[1]).toBeGreaterThan(5000);
    expect(s.p.up).toEqual([0, 1, 0]);
    expect(s.p.fronts.seismic.visible).toBe(false);                   // already right round the planet
    expect(s.p.fronts.tsunami.visible).toBe(true); expect(s.p.fronts.blast.visible).toBe(true);
    const R = 6371, ang = (f) => Math.acos((f.y + R) / Math.hypot(f.x, f.y + R, f.z)) * R;
    expect(ang(s.p.fronts.tsunami) / s.fr.tsunami.km).toBeCloseTo(1, 2);
    expect(ang(s.p.fronts.blast) / s.fr.blast.km).toBeCloseTo(1, 2);
    await expect(page.locator('#chx-stage-kv')).toContainText('shaking right round the planet');
    const bright = s.p.globe.tint;
    // the dark years: the planet is drawn dimmer (never black) and the readout carries the number
    await page.locator('#chx-clock-marks button[data-ev="dark"]').click();
    await page.evaluate(() => window.__chicxulub.setStageTime(window.__chicxulub.state.W.t * 3));
    s = await snap();
    expect(s.st.light).toBeLessThan(0.01);
    expect(s.p.globe.tint).toBeLessThan(0.6 * bright); expect(s.p.globe.tint).toBeGreaterThan(0.4);
    await expect(page.locator('#chx-stage-phase b')).toHaveText('Darkness');
    await expect(page.locator('#chx-stage-kv')).toContainText('of normal sunlight');
    // the frame is lit, not black, in the dark years
    const lum = await page.evaluate(() => { window.__chicxulub.stage.renderNow(); const gl = window.__chicxulub.stage.renderer.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, px = new Uint8Array(w * 4); gl.readPixels(0, Math.floor(h * 0.45), w, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); let m = 0; for (let i = 0; i < w; i++) m = Math.max(m, px[4 * i] + px[4 * i + 1] + px[4 * i + 2]); return m / 3; });
    expect(lum).toBeGreaterThan(18);
    // choosing a view by hand hands the camera to the reader: it no longer follows
    await page.locator('#chx-view button[data-v="region"]').click();
    await settle();
    await page.evaluate(() => window.__chicxulub.setStageTime(-5));
    s = await snap();
    expect(s.W.follow).toBe(false); expect(s.W.view).toBe('region');
    await expect(page.locator('#chx-follow')).toHaveAttribute('aria-pressed', 'false');
    // and turning it back on flies to the chapter the clock is in
    await page.locator('#chx-follow').click();
    await settle();
    expect((await snap()).W.view).toBe('approach');
    // a drag on the stage also releases it
    const box = await page.locator('#chx-stage').boundingBox();
    await page.locator('#chx-stage').scrollIntoViewIfNeeded();
    const bb = await page.locator('#chx-stage').boundingBox();
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down(); await page.mouse.move(bb.x + bb.width / 2 + 40, bb.y + bb.height / 2 + 10, { steps: 4 }); await page.mouse.up();
    expect((await snap()).W.follow).toBe(false);
    expect(box.width).toBeGreaterThan(200);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
});
