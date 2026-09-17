# tests/fixtures/sdo — full-disk frames for the Sun page tests

**`synthetic_*.png` are NOT observations.** They are rendered by
`scripts/make-sdo-synthetic-fixtures.mjs` with the same geometry as NASA's
`latest_<res>_<code>.jpg` browse frames (centred disk, HMI ≈ 0.465 / AIA ≈ 0.390
of the frame radius, limb darkening / brightening, faint off-limb corona) and
three PLANTED active regions at heliographic coordinates recorded in
`manifest.json`. `tests/sun-observed.mjs` uses that ground truth to pin the
disk→sphere projection and the disk measurement; `tests/sun-smoke.spec.js`
serves them in place of `/api/solar/aia` so CI never needs nasa.gov.

The build sandbox cannot reach nasa.gov, which is why real frames are not
committed here. On a machine that can, `node scripts/fetch-sdo-fixtures.mjs`
writes `real_<channel>.jpg` + `real-manifest.json`; `tests/sun-visual.spec.js`
(the `@gpu` screenshot baseline) prefers the real set when it exists. Real
frames are public-domain NASA imagery.

Do not hand-edit the PNGs; regenerate them.


## GOES/SUVI frames (`synthetic_suvi304.png`, `synthetic_suvi131.png`)

Added with SUN_VISUALS_WORLD_CLASS_PLAN.md Phase 3e. Same two lines as the AIA
304 / 131 frames beside them — He II 304 and Fe XXI/Fe VIII 131 really are the
same lines in both instruments — rendered at **SUVI's own plate scale**, so the
disk is 0.2999 of the frame instead of AIA's 0.390.

That difference is the point. `js/sun-offlimb.js` draws a 1.0–1.6 R☉ annulus
and its shader draws nothing outside the frame; an AIA half-frame stops at
1.280 R☉ on axis, so it supplies only 65.9 % of that ring, while SUVI reaches
1.667 R☉ and supplies all of it.

**`PROM-FAR-W` is the probe that makes this measurable.** It is planted on the
+x axis at 1.50 R☉ — deliberately *between* the two instruments' on-axis reach.
Nothing in the generator special-cases it: the render loop only walks the frame,
so the feature is simply absent from `synthetic_304.png` — which stays
BYTE-IDENTICAL to the frame that shipped before the probe existed — and present in
`synthetic_suvi304.png`. `tests/sun-suvi-layer.spec.js` samples that scene point
under both sources, with a control probe at 1.15 R☉ that both frames cover.

These remain SYNTHETIC stand-ins. The real SUVI browse path is UNVERIFIED —
services.swpc.noaa.gov is egress-blocked from the build sandbox, which is why
`js/suvi-geometry.js` resolves it from a candidate list. Note that a real SUVI
browse frame is 1280² where these are 512², so the disk is measured here to
~0.7 % rather than the ~0.1 % the AIA fixtures reach; that is the fixture's
resolution, not the model's accuracy.
