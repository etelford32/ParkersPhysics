// Isolated pixel gate: the existing browser and kernel suites keep their config.
import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

const output = process.env.LAUNCH_VISUAL_OUTPUT_DIR || 'validation-output/launch-visual';

export default defineConfig({
    ...base,
    testMatch: /launch-planner-screenshots\.spec\.js/,
    snapshotPathTemplate: '{testDir}/__visual__/launch-planner/{projectName}/{platform}/{arg}{ext}',
    outputDir: `${output}/results`,
    reporter: [
        ['line'],
        ['html', { outputFolder: `${output}/report`, open: 'never' }],
        ['json', { outputFile: `${output}/results.json` }],
    ],
    timeout: 180_000,
    retries: 0,
    workers: 1,
    // A missing baseline must fail. Only the explicit update command may write it.
    updateSnapshots: 'none',
    use: {
        ...base.use,
        locale: 'en-US',
        timezoneId: 'UTC',
        colorScheme: 'dark',
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
        serviceWorkers: 'block',
        trace: 'retain-on-failure',
        launchOptions: { args: [
            '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
            '--force-color-profile=srgb',
        ] },
    },
    projects: [{ name: 'launch-swiftshader', use: { browserName: 'chromium' } }],
});
