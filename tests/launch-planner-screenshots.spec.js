/**
 * Pixel comparisons supplement launch-planner-{visuals,camera}.spec.js.
 * Run ONLY with playwright.launch-visual.config.js (pinned Linux SwiftShader).
 * No screenshot masks: vehicles, smoke, lights and stage controls all count.
 * See tests/LAUNCH_VISUAL_REGRESSION.md for baseline review and capture limits.
 */
import { test, expect } from '@playwright/test';
import { bootCapture, prepareScene, captureState, STAGE, PIXELS } from './helpers/launch-capture.js';

export const SCENES = [
    { name: 'shuttle-desktop-threequarter', vehicle: 'shuttle', view: 'threequarter' },
    { name: 'falcon9-desktop-front', vehicle: 'falcon9', variant: 'block5', view: 'front' },
    { name: 'falcon-heavy-desktop-wide', vehicle: 'falcon9', variant: 'heavy', view: 'wide' },
    { name: 'starship-desktop-side-high', vehicle: 'starship', variant: 'v2', view: 'side', quality: 'high' },
    { name: 'starship-desktop-engines', vehicle: 'starship', variant: 'v2', view: 'closeup', plume: true },
    { name: 'falcon9-launch-tplus3', vehicle: 'falcon9', variant: 'block5', view: 'threequarter', missionT: 3 },
    { name: 'shuttle-launch-tplus2', vehicle: 'shuttle', view: 'threequarter', missionT: 2 },
    { name: 'starship-mobile-portrait', vehicle: 'starship', variant: 'v2', view: 'auto', mobile: true, viewport: { width: 390, height: 844 } },
    { name: 'falcon9-mobile-landscape', vehicle: 'falcon9', variant: 'block5', view: 'auto', mobile: true, viewport: { width: 844, height: 390 } },
];

for (const scene of SCENES) {
    test.describe(scene.name, () => {
        test.use({ viewport: scene.viewport || { width: 1280, height: 800 }, isMobile: !!scene.mobile, hasTouch: !!scene.mobile });
        test('matches the reviewed scene', async ({ page, browser }, testInfo) => {
            test.skip(testInfo.project.name !== 'launch-swiftshader', 'use playwright.launch-visual.config.js for the pinned pixel gate');
            if (process.env.LAUNCH_VISUAL_FAULT) {
                expect(testInfo.config.updateSnapshots, 'never update a baseline with a fault injected').toBe('none');
            }
            const errors = await bootCapture(page, scene);
            await prepareScene(page, scene);
            const state = await captureState(page);
            expect(state.unobscured, 'the stage must not be hidden under a consent banner or other overlay').toBe(true);
            expect(state.overflowX).toBeLessThanOrEqual(0);
            expect(state.stats.cameraY).toBeGreaterThan(2);
            expect(errors).toEqual([]);
            await testInfo.attach('capture-state', {
                body: JSON.stringify({ scene, browser: browser.version(), ...state }, null, 2),
                contentType: 'application/json',
            });
            // Keep a real image even on passes, alongside Playwright's automatic
            // expected/actual/diff attachments when a comparison fails.
            const stage = page.locator(STAGE);
            const actual = await stage.screenshot({ animations: 'disabled', caret: 'hide', scale: 'css' });
            await testInfo.attach('actual', { body: actual, contentType: 'image/png' });
            await expect(stage).toHaveScreenshot(`${scene.name}.png`, {
                ...PIXELS, animations: 'disabled', caret: 'hide', scale: 'css', timeout: 15_000,
            });
            expect(errors).toEqual([]);
        });
    });
}
