# Upper Atmosphere Simulator — showing the atmosphere

Status doc for the visual + on-canvas-analysis layer of `upper-atmosphere.html`.
Read this before touching `js/upper-atmosphere-{column,volume,instruments}.js`.

---

## 1. What changed and why

The page always had a real density model — `upper-atmosphere-engine.js`, a
Bates T(z) profile with per-species diffusive equilibrium, mirroring the
DSMC pipeline's Python. What it did not have was a **rendering of that
model**. The atmosphere was drawn as five discrete spheres, each shaded a
flat per-layer colour by the local ρ at its own mid-altitude, with hard
boundaries at 85 / 250 / 600 / 1200 km.

Two things were wrong with that, and both are physics rather than taste:

1. **The boundaries are names, not features.** 85 km is where we start
   calling it the thermosphere. Nothing happens there. Drawing a hard edge
   at a naming convention makes the render assert a structure the model
   does not contain.

2. **Limb brightening is geometric and a per-layer shader cannot produce
   it.** A ray tangent at 400 km traverses ≈1600 km of equivalent local
   atmosphere — about 27 scale heights — because the geometry stretches
   the exponential into a √(2πrH) chord. That factor *is* the bright band
   around the edge of every photograph of Earth from orbit. Shading by
   local ρ gives you a ring of constant brightness instead, which is why
   the old render read as concentric sci-fi rings.

The fix is to integrate the column and to let the model's own asymmetry
show. Three new modules:

| module | what it is | tested by |
|---|---|---|
| `js/upper-atmosphere-column.js` | PURE kernel: the T∞ field, the column integrals, the airglow layers, the renderer's LUTs | `node tests/upper-atmosphere-column.mjs` (51 assertions) |
| `js/upper-atmosphere-volume.js` | the continuous volumetric renderer | `npx playwright test tests/upper-atmosphere-volume.spec.js` |
| `js/upper-atmosphere-instruments.js` | the on-canvas ruler / limb probe / diurnal compass | same spec |

---

## 2. Load-bearing decisions

### 2.1 There is still exactly ONE density model

The kernel never re-implements density. It computes a **T∞ field** —
scalar exospheric temperature varying with local solar time, latitude and
magnetic activity — and feeds it back into the engine's own `density()`
through a new optional `TinfK` argument. Composition, scale heights, the
heavy/light differential expansion when a storm inflates the thermosphere:
all still the engine's.

If you find yourself writing a barometric exponential in the kernel, stop.

### 2.2 Both spatial terms are area-mean-preserving

- The Jacchia-71 diurnal ratio is divided by **its own global area
  average** (exact quadrature, cached per solar declination).
- The auroral term has **zero area mean** by construction, because the
  engine's `3·Ap` already carries the global geomagnetic response and a
  second positive Ap term here would double-count it.

So turning the field on moves **no number the page already reports**. It
only says where that number is high and where it is low. Two tests gate
this. If a future session wants the global mean to move, that belongs in
`exosphereTempK`, not here.

### 2.3 Density and airglow are separate claims and must stay separate

Above 80 km there is essentially no Rayleigh scattering. The neutral
atmosphere **emits no visible light of its own**. So:

- the **density** render is a data visualisation of ∫ρ dl, and the legend
  says you could not see it;
- the **airglow** render is the emission layers at their observed
  altitudes, and that is what an eye actually records.

They are independently toggleable and separately coloured. Merging them
into one prettier term would make the page imply that the first is a
photograph. Don't.

### 2.4 The display transform is disclosed, always

The column spans **ten decades** from an 80 km tangent ray to a 1950 km
one. Brightness is `((log₁₀(column/column_ref) + D)/D)^γ` over D display
decades — the same log axis the page's own density plot uses, so render
and plot agree by construction. `getScaleInfo()` reports D and γ and the
legend prints them.

### 2.5 The shader mirrors the kernel; the kernel is the oracle

`VOLUME_FRAG` re-implements three kernel functions in GLSL:
`geoFromVectors`, `jacchiaDiurnalRatio`, `auroralHeatingK`. Change one,
change the other in the same commit, and re-run the node test — which
checks the JS version against an independent derivation, so the GLSL
inherits a verified answer rather than a second guess.

---

## 3. Measured rejections — do not re-litigate without re-running these

Each of these was built the "obvious" way first and measured worse.

### 3.1 Importance sampling is worse than uniform sampling (CPU)

Quadratic node spacing about the tangent point is textbook importance
sampling for an exponential integrand. Measured against a 6000-step
reference:

| tangent alt | uniform-64 | quadratic-64 |
|---|---|---|
| 85 km | 0.003 % | 0.163 % |
| 100 km | 0.011 % | 0.159 % |
| 400 km | 0.000 % | 0.050 % |

Euler–Maclaurin: the integrand decays smoothly to zero at both ends with
all its derivatives, so equally spaced trapezoid loses its boundary terms
and converges superalgebraically. Unequal spacing destroys that and drops
back to O(h²). `rayColumn` therefore marches **uniformly**.

### 3.2 …but the SHADER samples quadratically anyway, for a different reason

The shader is not trying to be accurate, it is trying not to **alias**.
The visible airglow band is 10 km FWHM; a limb ray crosses the volume in
~10 000 km, so uniform 64-step sampling lands ~160 km apart and the band
strobes as the camera moves. Tangent-centred quadratic spacing puts the
near-tangent samples ~5 km apart. A 0.2 % quadrature error behind a log
display stretch is invisible; a flickering airglow band is not.

**The two schemes differ on purpose and the reason is per-consumer.**

### 3.3 asinh is the wrong stretch here

The standard astronomical asinh stretch is built for a few decades above a
noise floor. At every gain that kept the limb from clipping, everything
above ~200 km mapped to pure black and the render was a hard white ring on
nothing. Replaced with the log stretch in §2.4.

### 3.4 Normalising the stretch at 150 km clipped a 70 km white band

The reference is now the model floor — the brightest ray the render can
produce — so nothing clips.

### 3.5 VER-weighted airglow colour comes out ORANGE

OH Meinel outshines every other airglow layer by an order of magnitude in
total photons, and ~98 % of that is at 1.5–2.0 µm. Layers therefore carry
a `visibleFraction`, and the display colour is weighted by **visible**
photons. Weighted that way the band is green-dominant at 92–105 km over a
dim red-brown base at 87 km, which is what it looks like in astronaut
photographs. `airglowAt` returns both `total` (physical) and
`visibleTotal`, plus `rgb` (visible) and `rgbPhysical`.

### 3.6 A column-average colour washes out the composition

The density term takes its colour from the ray's **lowest point**, so the
stratification (N₂/O₂ blue → atomic-O amber → He pink → H yellow) is
visible. The airglow term takes its colour from the **emission-weighted
integral**, because its band is one or two pixels at whole-globe framing
and what a camera records there is the integral. Both are argued in the
module header.

### 3.7 γ = 1.45 crushed the exosphere

Measured displayed brightness at D=10, γ=1.15, gain 0.90: 80 km → 0.90,
400 km → 0.34, 1000 km → 0.13, 1950 km → 0.02. That ramp is the halo.

---

## 4. The auroral term is a parameterisation and the page must not claim otherwise

A Gaussian in magnetic latitude: centre 67°, width 13°, amplitude
saturating in Ap. The centre and width track the statistical auroral oval;
the amplitude is anchored so the isolated auroral density enhancement at
400 km reaches ~1.6–1.7× at strong-storm Ap, the conservative end of what
was inferred during the May-2024 Gannon storm.

**It is not MSIS.** The magnetic latitude is a centred-dipole coordinate,
not a field evaluation — `js/geomag/igrf.js` remains the site's single
source of truth for field values, and this is deliberately not that.

The enhancement is **not monotonic in Ap**: it peaks near ap ≈ 200 and
eases at ap ≈ 400, because the scale height grows with T∞ and heating
loses leverage (dρ/ρ ≈ (z−z₀)/H · dT/T). Absolute density keeps rising
throughout. That is physics, not a fit artefact, and the test asserts it
so nobody tunes it away.

---

## 5. The on-canvas instruments

The side panel already reports the global model: one ρ, one T, one Kn, at
one altitude — the spherically symmetric answer. The whole point of the
volumetric render is that the atmosphere is *not* spherically symmetric,
and the operator's real question ("what is the density where my spacecraft
is") is a question about a **place**. A place is something you point at.

- **Altitude ruler** — ticks at 100/200/400/800/1200/2000 km hung on the
  actual limb. Ticks sit at the true radius; only the *labels* are pushed
  apart to a measured minimum separation, with leaders, because at
  whole-globe framing 100/200/400 land a few pixels apart.
- **Limb probe** — tangent altitude, ρ local **and** ρ model as two
  separate rows (they are different claims; one number would hide which),
  their ratio as the local drag multiplier, T/T∞, the column, the limb
  path equivalent, Kn and regime, plus a mini ρ(z) profile with the
  tangent altitude marked and the airglow band overlaid.
- **Diurnal compass** — sub-solar meridian, the bulge (which lags it by
  ~2 h), and the day/night density ratio at the selected altitude.

`upper-atmosphere-instruments.js` **does not import three.js**. It takes
three geometry hooks from the globe (`projectToScreen`, `probeScreenRay`,
`limbTicks`) and everything else from the pure kernel, so every number it
prints traces to a node-tested function. Keep it that way: if you need a
`Vector3` in there, add a hook to the globe instead.

### 5.1 Two disclosures the probe must never lose

- A ray can pass **above** the modelled band. The engine does not
  extrapolate above 2000 km, so the sample clamps to the ceiling — and the
  card says `ABOVE THE MODEL / ceiling values` rather than printing 2000 km
  physics beside a 3472 km tangent altitude. (Found by the browser gate.)
- **Below 120 km the engine's density does not depend on T∞ at all** —
  turbulent mixing clamps it — so `local / model` is exactly 1.00 down
  there. Without the note it reads as a dead instrument.

### 5.2 Layout constraints that were each a bug

- The overlay canvas is `pointer-events: none`. OrbitControls and the
  raycaster both listen on the WebGL canvas underneath; an overlay that
  swallowed pointer events would kill orbiting. Gated.
- The probe card avoids **every** piece of page chrome over the canvas,
  measured live from the elements. The camera HUD's time-warp row spans
  nearly the full width, so when the pointer is up there no near-cursor
  placement is clean and the card parks, joined by a leader.
- The legend and control row are lifted above the time scrubber via
  `--ua-atmo-floor`, measured from the scrubber's own height. Anchored to
  `bottom: 14px` they drew *on top of* it at 1280×720.
- Labels are not `text-transform: uppercase`: CSS uppercases `ρ` to a
  capital rho, drawn identically to a Latin P, so the button read
  "P COLUMN".

---

## 6. Also fixed here

`SUN_FRAG` in `upper-atmosphere-globe.js` declared a variable named
`active` — a **reserved word in GLSL ES**. The shader had never compiled
and the Sun had been rendering on three.js's error-fallback material since
it shipped. Nothing in the page's own output said so. The browser gate now
asserts zero WebGL errors, which is how a failure like that gets caught
rather than lived with.

---

## 7. What is still open

- **Storm-time equatorward propagation.** Auroral Joule heating launches
  travelling atmospheric disturbances that carry the density enhancement
  toward the equator over hours. The field is currently static in that
  respect — the oval brightens in place. This is the most physically
  interesting next step and it has a natural home: the T∞ field already
  takes a time argument everywhere it matters.
- **Semiannual / seasonal density variation.** Real and sizeable
  (~×2 at 400 km between the April/October maxima and the solstice
  minima); not modelled.
- **The 0–80 km band.** The render clamps to the model floor rather than
  extrapolating, which is correct but means a ray tangent below 80 km is
  slightly under-bright. A proper stitch to a standard-atmosphere fit
  would fix it.
- **Airglow radiance.** The volume emission rates are order-of-magnitude
  typical values used for *relative* brightness. This is not a radiance
  calculation and the page must not present it as one.
