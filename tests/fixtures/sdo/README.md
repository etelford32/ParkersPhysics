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


## SOHO/LASCO coronagraph frames (`synthetic_c2.png`, `synthetic_c3.png`)

Added with the observed outer-corona layer (`js/sun-coronagraph.js`). These are
a DIFFERENT PRODUCT from everything above — white-light coronagraph browse
frames, not full-disk images — and they have their own renderer
(`renderSyntheticCoronagraph` in `scripts/lib/sdo-synth.mjs`):

- **One synthetic corona, two instruments.** `PLANTED_CORONA` (three streamers
  and two CME fronts, in plane-of-sky position angle and R☉) is rendered through
  C2's geometry (11.9″/px) and C3's (56.0″/px). It has to be one sky: the layer
  level-matches C3 to C2 on the shell both see, which only means something if
  both frames show the same corona. Each is byte-scaled differently on purpose
  so that match has work to do.
- **The browse product's furniture**, as this build understands it: the Sun is
  NOT at the frame centre (`PLANTED_CORONAGRAPH.*.cx/cy`), the occulted region
  is a flat-colour disc with a white circle at the solar limb, C3 carries the
  occulter pylon to the south-east (PA 135°), and a timestamp-like block sits in
  the bottom-left corner. The occulter radii (2.12 and 3.95 R☉) are deliberately
  not the kernel's nominal 2.0 / 3.7, so the test can tell a measured mask edge
  from a typed one.
- **`CME-NE` is the coverage probe**: planted at 13.5 R☉, more than twice C2's
  reach, so it exists in the C3 frame only — the coronagraph analogue of
  `PROM-FAR-W`. `CME-NW` (4.4 R☉) is inside C2's field.

`tests/sun-coronagraph.mjs` re-renders both and fails if the committed PNGs have
drifted from the generator. Regenerate just these two, leaving every other file
and manifest entry untouched, with:

    node scripts/make-sdo-synthetic-fixtures.mjs --only=c2,c3

**None of the furniture is verified against a real frame** — nasa.gov is
egress-blocked from the build sandbox. `node scripts/fetch-sdo-fixtures.mjs`
writes `real_c2.jpg` / `real_c3.jpg` on a machine with egress; one look at those
settles the list in `js/sun-coronagraph.js`'s header. Position angles follow the
solar convention: 0° = north, counter-clockwise through EAST, and east is image
LEFT.

## The REAL set (`real_*`, fetched 2026-11-20)

`real_<channel>.jpg|png` are real browse frames as served by NASA SDO, SOHO
and NOAA SWPC, written by `scripts/fetch-sdo-fixtures.mjs` on a machine that
can reach those hosts; `real-manifest.json` records each upstream URL,
Last-Modified, byte count and sha256. `real_<channel>_256.png` are 256²
lossless copies made by `python3 scripts/bake-sdo-real-thumbs.py` — node has
no JPEG decoder, and 256² is the readback the page itself calibrates on, so
these are what the node gates read (`--check` fails on a stale copy).

**Never hand-edit these.** Re-fetch, re-bake, commit together.

`real_c3_dropout.jpg` is KEPT on purpose (`"kept": true` in the manifest, so a
re-fetch preserves it): the SOHO/LASCO C3 frame served on 2026-11-20 with the
right half of its field missing. It is the negative control for
`frameIntegrity` in `js/sun-coronagraph.js`.

What reads them: `tests/sun-offlimb.mjs` (the limb-glow reference vs the old
rule; the caption mask), `tests/sun-coronagraph.mjs` (frame integrity),
`tests/sun-real-frames.spec.js` (the page, on pixels), and
`tests/sun-visual.spec.js` (the opt-in GPU baseline prefers this set).
