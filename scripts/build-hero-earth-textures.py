#!/usr/bin/env python3
"""Build the self-hosted Earth texture set the homepage hero loads.

    npm pack three-globe@2.31.0          # the SAME images earth.html loads from unpkg
    tar xzf three-globe-2.31.0.tgz package/example/img
    python3 scripts/build-hero-earth-textures.py package/example/img

Writes assets/earth/*.webp (see assets/earth/SOURCES.md for provenance). The
hero (js/hero-space-weather.js) picks a tier with js/hero-earth.js
`pickTextureTier`; the tier table there and the file names here move together.

WHY FOUR SEPARATE FILES, NOT ONE PACKED "AUX" IMAGE
    Lossy WebP stores Y at full resolution and U/V at half (4:2:0), so three
    independent fields packed into R/G/B bleed into each other and lose half
    their resolution. Lossless packing keeps them clean but measured 800 KB at
    2k (the anti-aliased water mask dominates). Two lossy GRAYSCALE files plus
    a lossless BINARY water mask are ~117 KB at 2k with no cross-talk.

WHAT EACH FILE IS
    day-*      NASA Blue Marble (surface reflectance composite + bathymetry),
               sRGB. The hero decodes it to linear and lights it itself.
    water-*    1 = water (oceans, lakes, major rivers), 0 = land. Drives the
               sun glint, so a glint can only ever land on real water.
               Thresholded to BINARY and stored lossless: 15 KB at 2k versus
               112 KB for the anti-aliased source as lossy WebP (measured) —
               the GPU's bilinear + mip filtering softens the edge anyway.
    lights-*   city lights ONLY. The source night image is NASA's Earth-at-night
               composite, whose base is a moonlit, snow-bright BLUE land/ocean
               (R <= ~13 everywhere, measured) with the lights on top
               (R ~= 80-95 in city cores, measured: London 91, Tokyo 94,
               Nile delta 82). The red channel minus that floor is therefore a
               clean lights map; the hero draws the night-side ground itself.
    relief-*   normalised elevation (sea = 0). The hero shades slopes from its
               gradient; it never displaces geometry (Everest is 0.27 px at
               the hero's ~190 px disc).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "earth"

LIGHTS_FLOOR = 16.0    # R codes: just above the moonlit base's max (~13)
LIGHTS_SPAN = 90.0     # R codes from the floor to a saturated city core

DAY_Q, GRAY_Q = 86, 82


def save(img: Image.Image, name: str, quality: int | None) -> None:
    path = OUT / name
    if quality is None:
        img.save(path, format="WEBP", lossless=True, method=6)
    else:
        img.save(path, format="WEBP", quality=quality, method=6)
    print(f"  {name:18s} {img.size[0]}x{img.size[1]}  {path.stat().st_size // 1024:5d} KB")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = Path(sys.argv[1])
    OUT.mkdir(parents=True, exist_ok=True)

    day = Image.open(src / "earth-blue-marble.jpg").convert("RGB")      # 4096x2048
    night = np.asarray(Image.open(src / "earth-night.jpg").convert("RGB")).astype(np.float32)
    water = Image.open(src / "earth-water.png").convert("L")           # 1600x800
    relief = Image.open(src / "earth-topology.png").convert("L")       # 2048x1024

    lights_f = np.clip((night[..., 0] - LIGHTS_FLOOR) / LIGHTS_SPAN, 0.0, 1.0)
    lights = Image.fromarray((lights_f * 255.0 + 0.5).astype(np.uint8), "L")

    def at(img: Image.Image, w: int) -> Image.Image:
        return img if img.size[0] == w else img.resize((w, w // 2), Image.LANCZOS)

    for w, tag in ((1024, "1k"), (2048, "2k"), (4096, "4k")):
        save(at(day, w), f"day-{tag}.webp", DAY_Q)

    def binary(img: Image.Image) -> Image.Image:
        a = np.asarray(img)
        return Image.fromarray(np.where(a >= 128, 255, 0).astype(np.uint8), "L")

    for w, tag in ((1024, "1k"), (2048, "2k")):
        save(binary(at(water, w)), f"water-{tag}.webp", None)
        save(at(lights, w), f"lights-{tag}.webp", GRAY_Q)
        save(at(relief, w), f"relief-{tag}.webp", GRAY_Q)


if __name__ == "__main__":
    main()
