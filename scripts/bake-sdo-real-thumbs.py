#!/usr/bin/env python3
"""
scripts/bake-sdo-real-thumbs.py — 256² PNG thumbnails of the REAL browse frames

    python3 scripts/bake-sdo-real-thumbs.py          # write
    python3 scripts/bake-sdo-real-thumbs.py --check  # fail if a thumbnail is stale

Why this exists. tests/fixtures/sdo/real_*.jpg are real NASA / NOAA browse
frames (scripts/fetch-sdo-fixtures.mjs). The browser gates decode them
natively, but the NODE gates cannot: node has no JPEG decoder and this repo
has no dependencies to add one. The page itself measures a frame on a 256²
readback (js/sun-observed.js readFrame), so a 256² lossless copy is exactly the
input the kernels see — and a PNG is something tests can read with zlib alone
(scripts/lib/sdo-synth.mjs decodePng).

Each thumbnail is a BOX downsample of the decoded frame in display (sRGB)
space, which is what a canvas drawImage does. real-manifest.json gains, per
frame, `thumb` and the sha256 of the SOURCE file it was made from; --check
recomputes both and fails on drift, so a re-fetched frame with a stale
thumbnail cannot pass a gate.

Needs Pillow. Nothing here is imported by the site.
"""
import hashlib, json, sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'tests' / 'fixtures' / 'sdo'
SIZE = 256

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()

def thumb_bytes(src):
    im = Image.open(src).convert('RGB').resize((SIZE, SIZE), Image.BOX)
    tmp = OUT / '.thumb.tmp.png'
    im.save(tmp, format='PNG', optimize=True)
    b = tmp.read_bytes(); tmp.unlink()
    return b

def main():
    check = '--check' in sys.argv
    mpath = OUT / 'real-manifest.json'
    m = json.loads(mpath.read_text())
    bad = []
    for ch, f in m['frames'].items():
        src = OUT / f['file']
        name = f"real_{ch}_{SIZE}.png"
        want = thumb_bytes(src)
        if check:
            have = (OUT / name).read_bytes() if (OUT / name).exists() else b''
            if have != want or f.get('sha256') != sha(src) or f.get('thumb') != name:
                bad.append(ch)
            continue
        (OUT / name).write_bytes(want)
        f['thumb'] = name
        f['thumbSize'] = SIZE
        f['sha256'] = sha(src)
        print(f"wrote {name} ({len(want)} B) from {f['file']}")
    if check:
        if bad:
            print('stale thumbnails: ' + ', '.join(bad)); sys.exit(1)
        print(f"{len(m['frames'])} real-frame thumbnails are current")
        return
    mpath.write_text(json.dumps(m, indent=2) + '\n')

if __name__ == '__main__':
    main()
