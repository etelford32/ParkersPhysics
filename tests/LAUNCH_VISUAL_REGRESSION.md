# Launch planner pixel regression gate

This suite supplements `launch-planner-visuals.spec.js`,
`launch-planner-camera.spec.js`, `launch-smoke-sim.mjs` and
`launch-camera-layout.mjs`. Those files and every production file are unchanged.
The baseline scene is the rendering merged in PR #1059,
`e6d361a6c98091c1f41d69f75d5a638506c485c4`.

## Run

Use Ubuntu 24.04, the lockfile's Playwright 1.56.0 / Chromium 141.0.7390.37,
and the config's explicit ANGLE SwiftShader flags. Install with `npm ci` and
`npx playwright install --with-deps chromium`. The local server is started by
Playwright. Fonts at initial capture: DejaVu Sans / DejaVu Sans Mono.
Install `fonts-dejavu-core`; `fc-match -f '%{family}' system-ui` must resolve
to `DejaVu Sans`, and `monospace` to `DejaVu Sans Mono`. The workflow checks
these before running; a font mismatch is an environment issue, not a reason
to loosen the pixel threshold or regenerate references.

```sh
node tests/launch-smoke-sim.mjs
node tests/launch-camera-layout.mjs
npx playwright test tests/launch-planner-visuals.spec.js tests/launch-planner-camera.spec.js --project=chromium --workers=1 --retries=0
npx playwright test --config=playwright.launch-visual.config.js --repeat-each=2
node scripts/check-launch-visual-faults.mjs
npx playwright show-report validation-output/launch-visual/report
```

The default Playwright config skips this **new** suite because it does not pin
the pixel environment. The dedicated workflow runs it explicitly, without
changing or skipping any existing test. Missing snapshots fail; CI never
creates or updates references. Every passing capture attaches its actual PNG
and JSON (vehicle, clock, viewport, camera, smoke counts, quality and renderer).
Failures also have Playwright's expected / actual / diff images and trace.

## Coverage

| Snapshot | Vehicle / state | View / layout | Quality |
| --- | --- | --- | --- |
| shuttle-desktop-threequarter | Shuttle, resting pad | 3/4, 1280×800 | low |
| falcon9-desktop-front | Falcon 9 Block 5, resting pad | front, 1280×800 | low |
| falcon-heavy-desktop-wide | Falcon Heavy, resting pad | wide, 1280×800 | low |
| starship-desktop-side-high | Starship V2, steel / tiles | side, 1280×800 | high |
| starship-desktop-engines | Starship V2, static plume on | engines, 1280×800 | low |
| falcon9-launch-tplus3 | Falcon 9, kerolox smoke / flame / glow | 3/4, T+3 s | low |
| shuttle-launch-tplus2 | Shuttle, solid-motor exhaust / ground cloud | 3/4, T+2 s | low |
| starship-mobile-portrait | Starship V2, default camera | Auto, 390×844, touch | low |
| falcon9-mobile-landscape | Falcon 9, default camera | Auto, 844×390, touch | low |

The entire stage is compared, including toolbars, camera dock and launch HUD.
The real "Reject non-essential" consent button is clicked before capture;
a nine-point hit-test also refuses a stage obscured by an external overlay.
No vehicle, smoke, lighting or control is masked. Unrelated live feed cards
outside the stage do not enter the comparison. The high case exercises HDR
MSAA and the larger shadow map; it still runs on software GL, not real hardware.

## Determinism and tolerance

Only the test context supplies a fixed date, seeded `Math.random`, fixed DPR,
locale, timezone, viewport, empty launch feed and blocked external services.
It queues rAF callbacks and advances the Playwright clock 100 ms per app frame.
This makes camera tweens, plume flicker, stars, beacons and smoke reproducible
even when a software frame takes seconds. Smoke uses the shipped kernel's
internal ≤50 ms integration steps. Its independent 30/120 fps kernel check
remains in place; these images do not validate physical accuracy or frame rate.

The final application time is held while taking screenshots. CSS animations
are disabled by the screenshot call, without removing controls or changing
layout rules. Button handlers are invoked through DOM clicks so a paused rAF
does not stall Playwright actionability; the original interaction suite still
uses actual pointer, keyboard and touch events.

Pixelmatch's perceptual threshold is **0.12**, with **0.1%** of pixels allowed
to differ beyond that threshold. This tolerates minor raster/antialias and
±1-level temporal-dither noise while preserving scene-level differences.
Do not widen this just to pass on a different browser, font or driver. The
recorded renderer must contain SwiftShader. Use a separate reviewed baseline
if intentionally adding another environment; never compare arbitrary GPUs
against this one.

## Prove the gate and review a change

`check-launch-visual-faults.mjs` injects three faults into the served module in
isolated browser contexts: hide smoke while counts remain nonzero, set the
floodlight key to zero, and turn bloom strength off while post remains active.
No source file is edited. It demands an actual screenshot assertion failure
and a diff PNG for each case; a timeout, shader error or boot failure cannot
count as detection. Results go into separate `fault-*` directories.

For an intended visual change, first run without update mode and inspect the
expected / actual / diff. Then, on the pinned environment only:

```sh
npx playwright test --config=playwright.launch-visual.config.js --update-snapshots
npx playwright test --config=playwright.launch-visual.config.js --repeat-each=2
node scripts/check-launch-visual-faults.mjs
```

Review all nine PNGs and the source change together. Generation is **not** a
regression pass; only the subsequent comparison validates the references.
Never update with `LAUNCH_VISUAL_FAULT` set (the suite explicitly refuses it).
Submit the baseline changes in the same PR as the intentional rendering change.

## Limits

These are software-rendered regression references, not a claim of hardware-GPU
visual parity, Safari/Firefox coverage, measured frame-time performance or CFD
validation. The flight sequence remains the existing illustrative timeline.
Manual review is still needed for intended visual changes, and real-device
checks remain useful for driver-specific rendering and touch behaviour.
