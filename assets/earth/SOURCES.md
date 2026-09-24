# assets/earth — the homepage hero's Earth texture set

Built by `scripts/build-hero-earth-textures.py` from the example images shipped
in the `three-globe@2.31.0` npm package — **the same four images `earth.html`
already loads at runtime from unpkg** (`js/earth-skin.js` `EARTH_TEXTURES`).
Self-hosting them for the hero adds no new imagery to the site; it removes a
third-party CDN from the top of the homepage and lets the files be resized and
re-encoded for the hero's ~190 px disc.

| File | Size | Content | Upstream |
|------|------|---------|----------|
| `day-1k/2k/4k.webp` | 80 / 252 / 810 KB | NASA Blue Marble: cloud-free surface reflectance composite with bathymetry (sRGB) | `earth-blue-marble.jpg` (4096×2048) — NASA Visible Earth, public domain |
| `lights-1k/2k.webp` | 15 / 60 KB | City lights only, extracted from the red channel (see the builder's header for the measured floor) | `earth-night.jpg` (4096×2048) — NASA Earth at Night, public domain |
| `water-1k/2k.webp` | 6 / 15 KB | Binary water mask (oceans, lakes, major rivers), lossless | `earth-water.png` (1600×800) |
| `relief-1k/2k.webp` | 14 / 42 KB | Normalised elevation, sea = 0 | `earth-topology.png` (2048×1024) |

The water and relief maps' original provenance is whatever the three-globe
example set credits; they were already in production on `earth.html` before
this copy existed. Verify both on a networked machine if the licence ever needs
to be stated precisely (the build environment cannot reach NASA or GitHub).

## What the hero claims with them (the Mars rule)

**The map is ARCHIVAL, the view is LIVE.** Blue Marble is a years-old cloud-free
composite and the lights are a composite night, so neither shows the present
surface. What is live is the geometry: `js/hero-earth.js` turns the globe so
the REAL sub-solar point faces the scene's Sun, which puts the terminator, the
lit continents, the lights that are on and the seasonal tilt of the poles where
they really are right now.

## Tiers (`js/hero-earth.js` `TEXTURE_TIERS` / `pickTextureTier`)

| Tier | Files | Total | When |
|------|-------|-------|------|
| `boot` | day-1k + water/lights/relief-1k | ~115 KB | always first; the entrance waits for it (capped) |
| `hd`   | day-2k + water/lights/relief-2k | ~369 KB | swapped in after the entrance starts |
| `uhd`  | day-4k + the 2k aux maps | ~927 KB | only when the resting disc needs > 2k texels across its equator and the visitor is not on save-data or a phone |

Rebuild after changing the builder: `npm pack three-globe@2.31.0`, extract
`package/example/img`, then `python3 scripts/build-hero-earth-textures.py <dir>`.
