// playwright.sandbox.config.mjs — the cloud-sandbox Playwright config.
// The repo pins @playwright/test 1.56 while the sandbox container ships
// chromium-1243 (1.63) and forbids `playwright install`, so this points at the
// installed binary and assumes `PORT=8000 node dev-server.mjs` is already up.
// Use: `npx playwright test -c playwright.sandbox.config.mjs <spec>`.
// CI and local machines keep using playwright.config.js.
import { defineConfig } from '@playwright/test';
export default defineConfig({
    testDir: './tests',
    timeout: 60_000,
    retries: 0,
    use: {
        baseURL: 'http://localhost:8000',
        headless: true,
        screenshot: 'only-on-failure',
        viewport: { width: 1280, height: 720 },
        launchOptions: { executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] },
    },
    projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
