// @ts-check
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    // Screenshot baselines (only tests/sun-visual.spec.js uses them; opt-in via
    // SUN_GPU=1 on real hardware — see that spec's header). Kept project- and
    // platform-agnostic on purpose: one baseline per scene, captured on the GPU
    // the plan's progress log names.
    snapshotPathTemplate: '{testDir}/__visual__/{testFileName}/{arg}{ext}',
    timeout: 60_000,
    retries: 1,
    use: {
        baseURL: process.env.TEST_BASE_URL || 'http://localhost:8000',
        headless: true,
        screenshot: 'only-on-failure',
        trace: 'on-first-retry',
        viewport: { width: 1280, height: 720 },
    },
    projects: [
        // Chromium runs the full suite (unchanged baseline).
        { name: 'chromium', use: { browserName: 'chromium' } },
        // Firefox + WebKit run ONLY the cross-browser auth E2E suite, so the
        // heavy WASM/simulator specs don't balloon the matrix while the auth
        // flows still get true three-engine coverage. See tests/auth-e2e.spec.js.
        { name: 'firefox-auth', use: { browserName: 'firefox' }, testMatch: /auth-e2e\.spec\.js/ },
        { name: 'webkit-auth',  use: { browserName: 'webkit'  }, testMatch: /auth-e2e\.spec\.js/ },
        // The launch planner's render-health gate is engine-sensitive (it is
        // a WebGL + post-processing failure that reached users while the
        // Chromium suite was green), so it alone also runs on Firefox and
        // WebKit. See .github/workflows/launch-planner-visuals.yml.
        // Firefox on a GPU-less CI runner had NO WebGL: its blocklist refused
        // the software GL ("AllowWebgl2:false"), and with that forced past,
        // HEADLESS Firefox still had no display to open a native GL context on
        // ("tryNativeGL", "Exhausted GL driver options"). With no WebGL the
        // page drops its canvas and every test waited out its budget. So the
        // force prefs, plus HEADED under Xvfb when PW_FIREFOX_XVFB=1 (the
        // workflow sets it and wraps the run in xvfb-run): Firefox then draws
        // through GLX on Mesa's software rasteriser, the way Chromium uses
        // SwiftShader.
        { name: 'firefox-visual', testMatch: /launch-planner-render-health\.spec\.js/,
          use: { browserName: 'firefox', headless: process.env.PW_FIREFOX_XVFB !== '1',
                 launchOptions: { firefoxUserPrefs: {
              'webgl.force-enabled': true, 'webgl.disabled': false, 'webgl.enable-webgl2': true,
          } } } },
        { name: 'webkit-visual',  use: { browserName: 'webkit'  }, testMatch: /launch-planner-render-health\.spec\.js/ },
    ],
    webServer: {
        command: 'PORT=8000 node dev-server.mjs',
        port: 8000,
        reuseExistingServer: !process.env.CI,
        timeout: 30_000,
    },
});
