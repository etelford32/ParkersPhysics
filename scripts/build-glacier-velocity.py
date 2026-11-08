"""
scripts/build-glacier-velocity.py — Glacier Watch's observed-motion bake (NASA ITS_LIVE v2)
═══════════════════════════════════════════════════════════════════════════════════════════
GLACIER_WATCH_PLAN.md P0. Offline, never deployed. Runs anywhere its-live-data.s3.amazonaws.com
is reachable (public bucket, no credentials — reachable from the build sandbox, unlike NSIDC/WGMS).

Usage:
    python scripts/build-glacier-velocity.py [--out data/glaciers] [--only columbia,gulkana]
                                             [--days 365] [--max-pairs 360] [--workers 12]
                                             [--no-reuse] [--keep-going] [--report run.json]

INCREMENTAL by default: a pair already in <id>.json is not downloaded again when the freshly
traced flowline is IDENTICAL to the committed one (`reusable_pairs`); a moved line re-reads
everything. The weekly job (.github/workflows/glacier-refresh.yml) adds --keep-going (a glacier
whose upstream fails keeps its previous entry and is LISTED in --report) and then refuses to
publish a degraded refresh (scripts/check-glacier-refresh.mjs).

Dependencies: numpy, numcodecs, h5py (`pip install numpy numcodecs h5py`). NO zarr: its 2.x
releases break against current numcodecs (cbuffer_sizes import), and the store is plain Zarr v2,
so `Zarr` below is a 40-line reader of consolidated metadata + chunk keys.

WHAT IT BAKES, per glacier (the GLACIERS table is the ONE list):
  1. COVERING TILE — the ITS_LIVE datacube catalogue (catalog_v02.json) point-in-polygon at the
     glacier centre; the tile's annual COMPOSITE (composites/annual/…) is read in a window.
  2. FLOWLINE — a STREAMLINE OF THE OBSERVED 2014–2024 MEAN FIELD (vx0, vy0), seeded at the
     fastest on-ice pixel within the search radius and traced both ways (RK2, 0.5-px steps,
     direction from a Gaussian-smoothed field so pixel noise cannot kink it; magnitude always
     from the raw field). It stops off the land-ice mask, below V_STOP, at the window edge, or
     on a reversal. No RGI outline is needed (NSIDC is egress-blocked here) and the line is by
     construction the path ice actually takes in the data. Resampled to ≤ N_FLOW points.
  3. HISTORY — at every flowline point: the annual mean velocity 1984–2025 (the composites'
     `v`; 2025 is PARTIAL — the cubes end ~May 2025, measured 2026-11-08), the climatology v0,
     the seasonal amplitude/phase (sinusoid fitted by ITS_LIVE to 2014–2024) and the trend.
  4. LAST YEAR — every image pair whose SECOND image is inside the last `--days`, with a time
     separation ≤ DT_MAX_DAYS, from Landsat 8/9, Sentinel-2 and Sentinel-1, discovered by
     listing ONLY the scenes known to see the glacier (path/row, MGRS tile, S1 footprint test),
     and read downloaded whole in parallel worker threads and parsed in memory (see sample_pair for
     why range reads through h5py were rejected). Each point is the 3×3 MEDIAN of the pair's
     `v` (fill −32767 ignored) — the SAME rule js/glacier-pairs.js `samplePair` applies to the
     daily live route, so baked and live pairs are one series.
  5. FIELD — vx0/vy0 + the ice mask, block-averaged to ≤ FIELD_MAX cells per side, int16 m/yr,
     for the page's particle advection (the motion drawn IS the observed mean field).

Outputs (`--out`): glaciers.json (index + flowlines + climatology — what EarthView loads; the
annual series moved out 2026-11-08 when 25 glaciers put the index past its 200 KB budget) and
<id>.json per glacier (annual series + field + last-year pairs — loaded when it is opened).
Arrays are base64 little-endian int16; −32768 = no data. js/glacier-engine.js is the ONE reader.

THE LIVE TAIL: pairs newer than this bake come from /api/glaciers/velocity (daily), which lists
the SAME scenes (`scenes` in the index) and samples the SAME points. Re-run this bake to fold
the tail into the committed history; nothing is lost if it is not re-run.
"""
import argparse, base64, concurrent.futures as cf, datetime as dt, io, itertools, json, math
import os, re, ssl, sys, threading, time, urllib.error, urllib.request
import numpy as np
import numcodecs
import importlib.util as _ilu
_spec = _ilu.spec_from_file_location('glacier_elevation', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'build-glacier-elevation.py'))
ELEV = _ilu.module_from_spec(_spec); _spec.loader.exec_module(ELEV)     # GLO-30 reader (Tile, dem_grid)

BUCKET = 'https://its-live-data.s3.amazonaws.com'
CATALOG = BUCKET + '/datacubes/catalog_v02.json'
DT_MAX_DAYS = 64          # short-baseline pairs only: a 400-day pair is not a "daily" measurement
V_STOP = 3.0              # m/yr — below this a streamline has reached a divide / stagnant ice
SEED_MIN_Z = 30.0         # m a.s.l. — seeds sit on grounded ice, never in a calving lagoon or fjord mélange
V_TRACE_MIN = 15.0        # m/yr — a seed slower than this is inside ITS_LIVE's noise (measured: South Cascade's
                          # 2014–2024 v0 median is 0.6 m/yr, Storglaciären 0.5) — the line comes from the surface instead
N_FLOW = 60               # flowline points kept (resampled uniformly in arc length)
FIELD_MAX = 160           # field grid cells per side (block-averaged)
NODATA = -32768
EPOCH = dt.date(1970, 1, 1)

# id, name, region, country, lat, lon, window half-width km, seed search radius km, kind, note.
# Rough centres only — the flowline is found in the data (§2 above), never typed.
GLACIERS = [
    dict(id='jakobshavn', name='Sermeq Kujalleq (Jakobshavn Isbræ)', region='West Greenland', country='Greenland',
         lat=69.17, lon=-49.70, win_km=45, seek_km=28, kind='ice-sheet outlet',
         note='The fastest-flowing glacier on Earth; drains ~7% of the Greenland Ice Sheet.'),
    dict(id='columbia', name='Columbia Glacier', region='Chugach Mountains, Alaska', country='USA',
         lat=61.17, lon=-147.08, win_km=30, seek_km=16, kind='tidewater',
         note='Textbook tidewater retreat: ~20 km of retreat since the early 1980s.'),
    dict(id='gulkana', name='Gulkana Glacier', region='Alaska Range, Alaska', country='USA',
         lat=63.27, lon=-145.42, win_km=6, seek_km=3, kind='land-terminating',
         note='USGS benchmark glacier; mass balance measured since 1966.'),
    dict(id='south-cascade', name='South Cascade Glacier', region='North Cascades, Washington', country='USA',
         lat=48.36, lon=-121.06, win_km=3.5, seek_km=1.5, kind='land-terminating',
         note='USGS benchmark glacier; mass balance measured since 1959.'),
    dict(id='peyto', name='Peyto Glacier', region='Canadian Rockies, Alberta', country='Canada',
         lat=51.67, lon=-116.55, win_km=5, seek_km=3, kind='land-terminating',
         note='WGMS reference glacier; feeds the Mistaya → North Saskatchewan rivers.'),
    dict(id='aletsch', name='Great Aletsch Glacier', region='Bernese Alps, Valais', country='Switzerland',
         lat=46.48, lon=8.03, win_km=14, seek_km=9, kind='land-terminating',
         note='The largest glacier in the Alps.'),
    dict(id='storglaciaren', name='Storglaciären', region='Kebnekaise, Lapland', country='Sweden',
         lat=67.90, lon=18.57, win_km=3, seek_km=1.5, kind='land-terminating',
         note='Longest continuous glacier mass-balance record on Earth (since 1946).'),
    dict(id='khumbu', name='Khumbu Glacier', region='Everest region, Khumbu', country='Nepal',
         lat=27.97, lon=86.84, win_km=8, seek_km=5, kind='debris-covered',
         note='Flows from the Western Cwm through the Khumbu Icefall; lower tongue debris-covered.'),
    dict(id='perito-moreno', name='Perito Moreno Glacier', region='Southern Patagonian Icefield', country='Argentina',
         lat=-50.50, lon=-73.12, win_km=18, seek_km=12, kind='lake-calving',
         note='One of the few Patagonian outlets near balance; periodically dams Lago Argentino.'),
    dict(id='zongo', name='Zongo Glacier', region='Cordillera Real', country='Bolivia',
         lat=-16.27, lon=-68.14, win_km=3, seek_km=1.5, kind='land-terminating',
         note='Tropical glacier on Huayna Potosí; meltwater for La Paz hydropower.'),
    # ── batch 2 (2026-11-08): WGMS reference glaciers + the fastest-changing outlets ──
    dict(id='hintereisferner', name='Hintereisferner', region='Ötztal Alps, Tyrol', country='Austria',
         lat=46.80, lon=10.77, win_km=5, seek_km=3, kind='land-terminating',
         note='One of the longest glaciological records in the Alps (since 1953).'),
    dict(id='rhone', name='Rhône Glacier', region='Urner Alps, Valais', country='Switzerland',
         lat=46.61, lon=8.39, win_km=6, seek_km=3, kind='land-terminating',
         note='Source of the Rhône; part of its tongue is wrapped in insulating blankets each summer.'),
    dict(id='mer-de-glace', name='Mer de Glace', region='Mont Blanc massif', country='France',
         lat=45.89, lon=6.93, win_km=8, seek_km=5, kind='land-terminating',
         note="France's longest glacier, on the north side of Mont Blanc."),
    dict(id='nigardsbreen', name='Nigardsbreen', region='Jostedalsbreen', country='Norway',
         lat=61.70, lon=7.11, win_km=8, seek_km=5, kind='land-terminating',
         note="Outlet of Jostedalsbreen, mainland Europe's largest ice cap."),
    dict(id='wolverine', name='Wolverine Glacier', region='Kenai Mountains, Alaska', country='USA',
         lat=60.41, lon=-148.91, win_km=6, seek_km=3, kind='land-terminating',
         note='USGS benchmark glacier in a wet maritime climate.'),
    dict(id='lemon-creek', name='Lemon Creek Glacier', region='Juneau Icefield, Alaska', country='USA',
         lat=58.38, lon=-134.35, win_km=4, seek_km=2, kind='land-terminating',
         note='Juneau Icefield glacier with a mass-balance record since 1953.'),
    dict(id='chhota-shigri', name='Chhota Shigri Glacier', region='Lahaul–Spiti, Himachal Pradesh', country='India',
         lat=32.23, lon=77.51, win_km=6, seek_km=3, kind='land-terminating',
         note='Benchmark glacier of the western Himalaya.'),
    dict(id='brewster', name='Brewster Glacier', region='Southern Alps', country='New Zealand',
         lat=-44.07, lon=169.44, win_km=3, seek_km=1.5, kind='land-terminating',
         note='One of the few glaciers in New Zealand with a field mass-balance record.'),
    dict(id='pasterze', name='Pasterze', region='Hohe Tauern, Carinthia', country='Austria',
         lat=47.08, lon=12.71, win_km=6, seek_km=4, kind='land-terminating',
         note="Austria's largest glacier, below the Grossglockner."),
    dict(id='helheim', name='Helheim Glacier', region='Sermilik Fjord, East Greenland', country='Greenland',
         lat=66.40, lon=-38.40, win_km=30, seek_km=20, kind='ice-sheet outlet',
         note="One of East Greenland's largest outlets; it sped up sharply in the mid-2000s."),
    dict(id='thwaites', name='Thwaites Glacier', region='Amundsen Sea, West Antarctica', country='Antarctica',
         lat=-75.30, lon=-106.50, win_km=50, seek_km=40, kind='ice-sheet outlet',
         note='Drains into the Amundsen Sea; the ice it holds could raise sea level by ~65 cm.'),
    dict(id='pine-island', name='Pine Island Glacier', region='Amundsen Sea, West Antarctica', country='Antarctica',
         lat=-75.10, lon=-100.50, win_km=45, seek_km=35, kind='ice-sheet outlet',
         note='With Thwaites, the fastest-changing glacier in West Antarctica.'),
    dict(id='hubbard', name='Hubbard Glacier', region='Yakutat Bay, Alaska', country='USA',
         lat=60.02, lon=-139.47, win_km=25, seek_km=15, kind='tidewater',
         note="North America's largest tidewater glacier — and, unusually, advancing."),
    dict(id='baltoro', name='Baltoro Glacier', region='Karakoram, Gilgit-Baltistan', country='Pakistan',
         lat=35.74, lon=76.40, win_km=25, seek_km=15, kind='debris-covered',
         note='About 63 km long below K2: one of the longest glaciers outside the polar regions.'),
    dict(id='breidamerkurjokull', name='Breiðamerkurjökull', region='Vatnajökull', country='Iceland',
         lat=64.17, lon=-16.33, win_km=15, seek_km=7, kind='lake-calving',
         note='Vatnajökull outlet calving into the Jökulsárlón lagoon.'),
    # ── batch 3 (2026-11-08): WGMS field programmes on every continent + the great outlets ──
    dict(id='silvretta', name='Silvretta Glacier', region='Silvretta Alps, Graubünden', country='Switzerland',
         lat=46.85, lon=10.08, win_km=3, seek_km=1.5, kind='land-terminating',
         note='Mass balance measured since 1919 — one of the two longest series anywhere.'),
    dict(id='claridenfirn', name='Claridenfirn', region='Glarus Alps', country='Switzerland',
         lat=46.84, lon=8.89, win_km=3.5, seek_km=2, kind='land-terminating',
         note='The longest glaciological series on Earth: stakes read every year since 1914.'),
    dict(id='allalin', name='Allalin Glacier', region='Saas valley, Valais', country='Switzerland',
         lat=46.05, lon=7.93, win_km=4, seek_km=2, kind='land-terminating',
         note='Its 1965 tongue collapse killed 88 workers at the Mattmark dam site.'),
    dict(id='taku', name='Taku Glacier', region='Juneau Icefield, Alaska', country='USA',
         lat=58.62, lon=-134.17, win_km=25, seek_km=12, kind='land-terminating',
         note='Advanced for a century while its neighbours retreated; turned to retreat around 2018.'),
    dict(id='storbreen', name='Storbreen', region='Jotunheimen', country='Norway',
         lat=61.57, lon=8.13, win_km=3.5, seek_km=1.5, kind='land-terminating',
         note='Continental-climate Norwegian glacier, measured since 1949.'),
    dict(id='engabreen', name='Engabreen', region='Svartisen, Nordland', country='Norway',
         lat=66.65, lon=13.89, win_km=6, seek_km=3, kind='land-terminating',
         note='Svartisen outlet with a hydropower laboratory tunnelled beneath its bed.'),
    dict(id='midtre-lovenbreen', name='Midtre Lovénbreen', region='Kongsfjorden, Svalbard', country='Norway (Svalbard)',
         lat=78.88, lon=12.07, win_km=4, seek_km=2, kind='land-terminating',
         note='High-Arctic valley glacier beside Ny-Ålesund, measured since 1968.'),
    dict(id='kongsvegen', name='Kongsvegen', region='Kongsfjorden, Svalbard', country='Norway (Svalbard)',
         lat=78.80, lon=13.15, win_km=18, seek_km=10, kind='tidewater',
         note='A surge-type glacier, quiescent and slow since its 1948 surge.'),
    dict(id='white', name='White Glacier', region='Axel Heiberg Island, Nunavut', country='Canada',
         lat=79.45, lon=-90.67, win_km=8, seek_km=4, kind='land-terminating',
         note='The longest mass-balance record in the Canadian High Arctic (since 1960).'),
    dict(id='urumqi-no1', name='Urumqi Glacier No. 1', region='Tien Shan, Xinjiang', country='China',
         lat=43.11, lon=86.81, win_km=2.5, seek_km=1.2, kind='land-terminating',
         note="China's reference glacier; it split into two branches in 1993."),
    dict(id='tuyuksu', name='Tuyuksu Glacier', region='Zailiysky Alatau', country='Kazakhstan',
         lat=43.05, lon=77.08, win_km=3, seek_km=1.5, kind='land-terminating',
         note='Above Almaty; the longest record in Central Asia (since 1957).'),
    dict(id='abramov', name='Abramov Glacier', region='Pamir-Alay', country='Kyrgyzstan',
         lat=39.62, lon=71.56, win_km=5, seek_km=3, kind='land-terminating',
         note='Its research station was abandoned in 1999; measurements resumed in 2011.'),
    dict(id='echaurren-norte', name='Echaurren Norte', region='Central Andes', country='Chile',
         lat=-33.58, lon=-70.13, win_km=2, seek_km=1, kind='land-terminating',
         note="The Southern Hemisphere's longest series; feeds Santiago's water supply."),
    dict(id='djankuat', name='Djankuat Glacier', region='Elbrus region, Caucasus', country='Russia',
         lat=43.20, lon=42.76, win_km=3.5, seek_km=2, kind='land-terminating',
         note='Caucasus reference glacier, measured since 1968.'),
    dict(id='yala', name='Yala Glacier', region='Langtang, Bagmati', country='Nepal',
         lat=28.23, lon=85.62, win_km=2.5, seek_km=1.2, kind='land-terminating',
         note='Small clean-ice Himalayan glacier; one of the few measured in Nepal.'),
    dict(id='bahia-del-diablo', name='Bahía del Diablo Glacier', region='Vega Island, Antarctic Peninsula', country='Antarctica',
         lat=-63.82, lon=-57.43, win_km=5, seek_km=3, kind='land-terminating',
         note='The only long field mass-balance record on the Antarctic Peninsula.'),
    dict(id='athabasca', name='Athabasca Glacier', region='Columbia Icefield, Alberta', country='Canada',
         lat=52.19, lon=-117.25, win_km=6, seek_km=3, kind='land-terminating',
         note='The most visited glacier in North America, beside the Icefields Parkway.'),
    dict(id='franz-josef', name='Franz Josef Glacier / Kā Roimata o Hine Hukatere', region='Westland, Southern Alps', country='New Zealand',
         lat=-43.48, lon=170.22, win_km=8, seek_km=4, kind='land-terminating',
         note='Steep, fast and maritime: it once descended into temperate rainforest.'),
    dict(id='petermann', name='Petermann Glacier', region='Nares Strait, Northwest Greenland', country='Greenland',
         lat=80.60, lon=-60.20, win_km=60, seek_km=35, kind='ice-sheet outlet',
         note='Ends in a floating ice tongue that calved 260 km² islands in 2010 and 2012.'),
    dict(id='kangerlussuaq', name='Kangerlussuaq Glacier', region='Kangerlussuaq Fjord, East Greenland', country='Greenland',
         lat=68.65, lon=-33.10, win_km=40, seek_km=22, kind='ice-sheet outlet',
         note="One of East Greenland's three largest outlets; it sped up sharply around 2005."),
    dict(id='lambert', name='Lambert Glacier', region='Amery Ice Shelf, East Antarctica', country='Antarctica',
         lat=-72.50, lon=68.50, win_km=70, seek_km=40, kind='ice-sheet outlet',
         note='Often called the largest glacier on Earth: it drains ~8% of the Antarctic Ice Sheet.'),
    dict(id='malaspina', name='Malaspina Glacier', region='Saint Elias Mountains, Alaska', country='USA',
         lat=59.95, lon=-140.45, win_km=30, seek_km=15, kind='land-terminating',
         note='The largest piedmont glacier on Earth, a lobe of ice spread onto the coastal plain.'),
    dict(id='fedchenko', name='Fedchenko Glacier', region='Pamir', country='Tajikistan',
         lat=38.80, lon=72.25, win_km=40, seek_km=20, kind='land-terminating',
         note='About 77 km long: the longest glacier outside the polar regions.'),
]

# ── HTTP ──────────────────────────────────────────────────────────────────────────────────────
_CA = os.environ.get('SSL_CERT_FILE') or ('/root/.ccr/ca-bundle.crt' if os.path.exists('/root/.ccr/ca-bundle.crt') else None)
_CTX = ssl.create_default_context(cafile=_CA) if _CA else ssl.create_default_context()

def http(url, rng=None, tries=4):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={'Range': f'bytes={rng[0]}-{rng[1]}'} if rng else {})
            with urllib.request.urlopen(req, context=_CTX, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 404): raise KeyError(url)
            if k == tries - 1: raise
        except Exception:
            if k == tries - 1: raise
        time.sleep(1.5 * 2 ** k)

def s3_list(prefix):
    """Every key under prefix (S3 ListObjectsV2, paginated)."""
    keys, token = [], None
    while True:
        q = f'{BUCKET}/?list-type=2&prefix={urllib.parse.quote(prefix)}' + (f'&continuation-token={urllib.parse.quote(token)}' if token else '')
        body = http(q).decode()
        keys += re.findall(r'<Key>([^<]+)</Key>', body)
        m = re.search(r'<NextContinuationToken>([^<]+)</NextContinuationToken>', body)
        if not m: return keys
        token = m.group(1)

import urllib.parse  # noqa: E402  (used by s3_list)

# ── Zarr v2 (consolidated) ───────────────────────────────────────────────────────────────────
class Zarr:
    def __init__(self, base):
        self.base = base.rstrip('/')
        self.meta = json.loads(http(self.base + '/.zmetadata'))['metadata']
    def attrs(self, k): return self.meta.get(k + '/.zattrs', {})
    def read(self, k, sel=None):
        a = self.meta[k + '/.zarray']; shape, ch, dtp = a['shape'], a['chunks'], np.dtype(a['dtype'])
        codec = numcodecs.get_codec(a['compressor']) if a['compressor'] else None
        sep = a.get('dimension_separator', '.')
        sel = sel or [slice(0, n) for n in shape]
        sel = [slice(max(0, s.start), min(n, s.stop)) for s, n in zip(sel, shape)]
        out = np.full([s.stop - s.start for s in sel], np.nan if dtp.kind == 'f' else 0, dtype=dtp)
        for idx in itertools.product(*[range(s.start // c, (s.stop - 1) // c + 1) for s, c in zip(sel, ch)]):
            try: raw = http(f'{self.base}/{k}/{sep.join(map(str, idx))}')
            except KeyError: continue
            arr = np.frombuffer(codec.decode(raw) if codec else raw, dtype=dtp).reshape(ch)
            src, dst = [], []
            for d, (i, c, s) in enumerate(zip(idx, ch, sel)):
                lo, hi = max(s.start, i * c), min(s.stop, (i + 1) * c, shape[d])
                src.append(slice(lo - i * c, hi - i * c)); dst.append(slice(lo - s.start, hi - s.start))
            out[tuple(dst)] = arr[tuple(src)]
        fv = a.get('fill_value')
        if fv not in (None, 'NaN') and dtp.kind == 'f': out[out == float(fv)] = np.nan
        return out

# ── geometry ─────────────────────────────────────────────────────────────────────────────────
def inside(pt, poly):
    x, y = pt; c = False
    for (x1, y1), (x2, y2) in zip(poly, poly[1:] + poly[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1: c = not c
    return c

def transformer(epsg):
    from pyproj import Transformer
    return Transformer.from_crs(4326, epsg, always_xy=True), Transformer.from_crs(epsg, 4326, always_xy=True)

def gauss_smooth(a, sigma):
    r = int(3 * sigma); k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2); k /= k.sum()
    m = np.isfinite(a); z = np.where(m, a, 0.0)
    def conv(u):
        u = np.apply_along_axis(lambda v: np.convolve(v, k, 'same'), 0, u)
        return np.apply_along_axis(lambda v: np.convolve(v, k, 'same'), 1, u)
    w = conv(m.astype(float))
    with np.errstate(invalid='ignore', divide='ignore'):
        return np.where(w > 0.2, conv(z) / w, np.nan)

def bilinear(a, fi, fj):
    i0, j0 = int(math.floor(fi)), int(math.floor(fj))
    if i0 < 0 or j0 < 0 or i0 + 1 >= a.shape[0] or j0 + 1 >= a.shape[1]: return math.nan
    di, dj = fi - i0, fj - j0
    q = a[i0:i0 + 2, j0:j0 + 2]
    if not np.all(np.isfinite(q)):
        v = q[np.isfinite(q)]; return float(v.mean()) if v.size else math.nan
    return float(q[0, 0] * (1 - di) * (1 - dj) + q[0, 1] * (1 - di) * dj + q[1, 0] * di * (1 - dj) + q[1, 1] * di * dj)

def trace(vx, vy, ice, sx, sy, i0, j0, sign, vstop, max_steps=4000):
    """Streamline in pixel coords. vx,vy are in map axes (x→j, y→−i because y decreases with i)."""
    pts = [(i0, j0)]; fi, fj = float(i0), float(j0); prev = None
    for _ in range(max_steps):
        def dirn(i, j):
            u, w = bilinear(sx, i, j), bilinear(sy, i, j)
            if not (math.isfinite(u) and math.isfinite(w)): return None
            n = math.hypot(u, w)
            return None if n < 1e-6 else (sign * -w / n, sign * u / n)   # (di, dj)
        d1 = dirn(fi, fj)
        if d1 is None: break
        d2 = dirn(fi + 0.25 * d1[0], fj + 0.25 * d1[1])
        if d2 is None: break
        if prev and d2[0] * prev[0] + d2[1] * prev[1] < 0.2: break        # reversal / kink
        ni, nj = fi + 0.5 * d2[0], fj + 0.5 * d2[1]
        ii, jj = int(round(ni)), int(round(nj))
        if not (0 <= ii < ice.shape[0] and 0 <= jj < ice.shape[1]) or not ice[ii, jj]: break
        sp = math.hypot(bilinear(vx, ni, nj), bilinear(vy, ni, nj))
        if not math.isfinite(sp) or sp < vstop: break
        fi, fj, prev = ni, nj, d2; pts.append((fi, fj))
    return pts, prev

def trace_topo(gzi, gzj, ice, fi, fj, sign, prev, slope_min=0.5, max_steps=4000):
    """Continue a line along the smoothed SURFACE: sign +1 = steepest DESCENT (downstream),
    −1 = ascent (upstream). Ice flows downhill — this is where a flowline goes when the
    observed velocity is below the satellites' noise. slope_min is m per pixel (120 m)."""
    pts = []
    for _ in range(max_steps):
        def dirn(i, j):
            a, b = bilinear(gzi, i, j), bilinear(gzj, i, j)
            if not (math.isfinite(a) and math.isfinite(b)): return None
            n = math.hypot(a, b)
            return None if n < slope_min else (-sign * a / n, -sign * b / n)
        d1 = dirn(fi, fj)
        if d1 is None: break
        d2 = dirn(fi + 0.25 * d1[0], fj + 0.25 * d1[1])
        if d2 is None: break
        if prev and d2[0] * prev[0] + d2[1] * prev[1] < 0.2: break
        ni, nj = fi + 0.5 * d2[0], fj + 0.5 * d2[1]
        ii, jj = int(round(ni)), int(round(nj))
        if not (0 <= ii < ice.shape[0] and 0 <= jj < ice.shape[1]) or not ice[ii, jj]: break
        fi, fj, prev = ni, nj, d2; pts.append((fi, fj))
    return pts

def b64(a):
    a = np.asarray(a)
    q = np.where(np.isfinite(a), np.clip(np.round(a), -32767, 32767), NODATA).astype('<i2')
    return base64.b64encode(q.tobytes()).decode()

# ── pair discovery + sampling ─────────────────────────────────────────────────────────────────
PAIR_RE = re.compile(r'^(?P<id1>.+?)_X_(?P<id2>.+?)_G0120V02_P(?P<p>\d{3})\.nc$')

def pair_dates(name):
    """(date1, date2) from a granule name — Landsat ids carry YYYYMMDD at field 4, S1/S2 at the first 8-digit T stamp."""
    m = PAIR_RE.match(name)
    if not m: return None
    def d(id_):
        if id_.startswith('L'): s = id_.split('_')[3]
        else: s = re.search(r'_(\d{8})T\d{6}', id_).group(1)
        return dt.date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    try: return d(m['id1']), d(m['id2']), int(m['p'])
    except Exception: return None

def scene_key(name):
    """The listing key a granule belongs to: Landsat 'LPPPRRR', S2 MGRS tile 'Txxxxx', S1 None (footprint-tested)."""
    if name.startswith('L'): return 'L' + name.split('_')[2]
    m = re.search(r'_(T\d{2}[A-Z]{3})_', name)
    return m.group(1) if (m and name.startswith('S2')) else None

def discover_scenes(cube, lon, lat, folders_hint):
    """Scenes that SEE the glacier: from the cube's newest 12 000 granule URLs, footprint-tested once per scene."""
    n = cube.meta['granule_url/.zarray']['shape'][0]
    # the newest 12 000 granule URLs: 3 000 missed scenes on a tile shared by many glaciers (Hubbard found 2 scenes, kept 3 pairs)
    urls = [str(u) for u in cube.read('granule_url', [slice(max(0, n - 12000), n)])]
    by_scene = {}
    for u in urls:
        parts = u.split('/'); sensor, folder, name = parts[4], parts[6], parts[7]
        k = scene_key(name)
        if k and (sensor, folder, k) not in by_scene: by_scene[(sensor, folder, k)] = u
    scenes = []
    for (sensor, folder, k), u in sorted(by_scene.items()):
        try: sp = http(u + '.spatial').decode().split()
        except KeyError: continue
        poly = [(float(sp[i]), float(sp[i + 1])) for i in range(0, len(sp) - 1, 2)]
        if inside((lon, lat), poly): scenes.append(dict(sensor=sensor, folder=folder, key=k))
    # Sentinel-1 has no fixed scene key: keep every S1 folder the cube has ever used (footprints tested per pair).
    for u in urls:
        parts = u.split('/')
        if parts[4] == 'sentinel1':
            s = dict(sensor='sentinel1', folder=parts[6], key=None)
            if s not in scenes: scenes.append(s)
    return scenes

def month_prefixes(d0, d1):
    out, y, m = [], d0.year, d0.month
    while (y, m) <= (d1.year, d1.month):
        out.append(f'{y:04d}{m:02d}'); m += 1
        if m == 13: y, m = y + 1, 1
    return out

def list_pairs(scenes, lon, lat, cutoff, today, workers=12):
    """Granule URLs whose second image is ≥ cutoff and whose separation ≤ DT_MAX_DAYS."""
    months = month_prefixes(cutoff - dt.timedelta(days=DT_MAX_DAYS), today)
    found = {}
    for s in scenes:
        base = f"velocity_image_pair/{s['sensor']}/v02/{s['folder']}/"
        if s['sensor'] == 'landsatOLI':
            pr = s['key'][1:]
            prefixes = [f'{sat}_{lvl}_{pr}_{ym}' for sat in ('LC08', 'LC09') for lvl in ('L1TP', 'L1GT') for ym in months]
        elif s['sensor'] == 'sentinel2':
            prefixes = [f'{sat}_MSIL1C_{ym}' for sat in ('S2A', 'S2B', 'S2C') for ym in months]
        else:
            prefixes = [f'{sat}_IW_SLC__1SDH_{ym}' for sat in ('S1A', 'S1B', 'S1C') for ym in months] + \
                       [f'{sat}_IW_SLC__1SDV_{ym}' for sat in ('S1A', 'S1B', 'S1C') for ym in months]
        with cf.ThreadPoolExecutor(workers) as ex:
            listed = [k for ks in ex.map(lambda p: s3_list(base + p), prefixes) for k in ks]
        for key in listed:
            if not key.endswith('.nc'): continue
            name = key.rsplit('/', 1)[1]
            if s['sensor'] == 'sentinel2' and f"_{s['key']}_" not in name: continue
            pd = pair_dates(name)
            if not pd: continue
            d1, d2, pct = pd
            if d2 < cutoff or (d2 - d1).days > DT_MAX_DAYS or (d2 - d1).days < 1 or pct < 1: continue
            found[name] = (BUCKET + '/' + key, s['sensor'], d1, d2, pct)
    if any(s['sensor'] == 'sentinel1' for s in scenes):     # footprint test for S1
        keep = {}
        for name, v in found.items():
            if v[1] != 'sentinel1': keep[name] = v; continue
            try: sp = http(v[0] + '.spatial').decode().split()
            except KeyError: continue
            poly = [(float(sp[i]), float(sp[i + 1])) for i in range(0, len(sp) - 1, 2)]
            if inside((lon, lat), poly): keep[name] = v
        found = keep
    return found

def select_pairs(found, cutoff, today, max_pairs):
    """Spread the cap EVENLY over the year (by the pair's centre week), and within a week prefer
    granules with more valid pixels (the P### in the name) and longer baselines — a 5-day pair on
    a 20 m/yr glacier is all noise, a 48-day one is not. The live route adds every NEW pair."""
    weeks = {}
    for name, v in found.items():
        url, sensor, d1, d2, pct = v
        c = d1 + (d2 - d1) / 2
        weeks.setdefault((c - cutoff).days // 7, []).append((pct * min((d2 - d1).days, 32) / 32, name, v))
    per = max(1, math.ceil(max_pairs / max(1, len(weeks))))
    pick = []
    for w in sorted(weeks):
        pick += [(n, v) for _, n, v in sorted(weeks[w], reverse=True)[:per]]
    return sorted(pick, key=lambda kv: kv[1][3], reverse=True)[:max_pairs]

def sample_pair(url, xs, ys, epsg_expected):
    """3×3 median of `v` (+ v_error) at each (x, y) — mirrors js/glacier-pairs.js sampleGrid.

    The granule is downloaded WHOLE in the worker thread and parsed from memory. Range-reading
    through h5py was tried first and is WRONG here: h5py holds a global lock for every call, so
    network I/O inside its reads serialised all workers onto one socket (and one slow socket
    froze the bake outright — measured 2026-11-08), and its 256 KB block reads fetched ~10 MB
    per polar granule, more than the file."""
    import h5py
    raw = http(url)
    with h5py.File(io.BytesIO(raw), 'r') as f:
        epsg = int(f['mapping'].attrs.get('spatial_epsg', 0))
        if epsg != epsg_expected: return None, f'epsg {epsg}', len(raw)
        x = f['x'][:]; y = f['y'][:]
        dx, dy = x[1] - x[0], y[1] - y[0]
        jj = np.round((np.asarray(xs) - x[0]) / dx).astype(int); ii = np.round((np.asarray(ys) - y[0]) / dy).astype(int)
        ok = (ii >= 1) & (ii < len(y) - 1) & (jj >= 1) & (jj < len(x) - 1)
        if not ok.any(): return None, 'outside', len(raw)
        i0, i1 = ii[ok].min() - 1, ii[ok].max() + 2; j0, j1 = jj[ok].min() - 1, jj[ok].max() + 2
        V = f['v'][0, i0:i1, j0:j1].astype(float); E = f['v_error'][0, i0:i1, j0:j1].astype(float)
    V[V == -32767] = np.nan; E[E == -32767] = np.nan
    out_v = np.full(len(xs), np.nan); out_e = np.full(len(xs), np.nan)
    for k in np.flatnonzero(ok):
        a = V[ii[k] - i0 - 1:ii[k] - i0 + 2, jj[k] - j0 - 1:jj[k] - j0 + 2]
        e = E[ii[k] - i0 - 1:ii[k] - i0 + 2, jj[k] - j0 - 1:jj[k] - j0 + 2]
        if np.isfinite(a).sum() >= 5:                                     # majority of the 3×3
            out_v[k] = np.nanmedian(a); out_e[k] = np.nanmedian(e)
    return (out_v, out_e), None, len(raw)

# ── per glacier ──────────────────────────────────────────────────────────────────────────────
def unb64(s_):
    q = np.frombuffer(base64.b64decode(s_), dtype='<i2').astype(float)
    q[q == NODATA] = np.nan
    return q

def reusable_pairs(prev_index, prev_detail, fx, fy):
    """THE INCREMENTAL REFRESH: a pair already sampled at EXACTLY these flowline points is not
    downloaded again (a weekly refresh otherwise re-reads ~6 000 granules to add ~150 new ones).
    Reuse is all-or-nothing per glacier and keyed on the flowline itself: the line is re-traced
    every bake from the composite + DEM, and if a single point moved (a new composite release,
    a changed seed rule) every stored sample is at the wrong place and ALL pairs are re-read.
    The x/y are compared at the precision the index stores them (0.1 m)."""
    if not prev_index or not prev_detail: return {}
    fl = prev_index.get('flowline') or {}
    px, py = fl.get('x') or [], fl.get('y') or []
    if len(px) != len(fx) or len(py) != len(fy): return {}
    if any(round(float(a), 1) != b for a, b in zip(fx, px)) or any(round(float(a), 1) != b for a, b in zip(fy, py)): return {}
    return {**{k: dict(rejected=w) for k, w in (prev_detail.get('rejected') or {}).items()},
            **{q['id']: q for q in prev_detail.get('pairs', [])}}

def bake(g, catalog, days, max_pairs, workers, log, dem_cache='scripts/.cache/glo30', prev=None):
    feats = [f for f in catalog['features'] if f['properties'].get('datacube_exist') and inside((g['lon'], g['lat']), f['geometry']['coordinates'][0])]
    if not feats: raise RuntimeError('no ITS_LIVE cube covers ' + g['id'])
    p = max(feats, key=lambda f: f['properties']['granule_count'])['properties']
    epsg = int(p['epsg']); fwd, inv = transformer(epsg)
    comp, cube = Zarr(p['composite_zarr_url']), Zarr(p['zarr_url'])
    x, y = comp.read('x'), comp.read('y'); t = comp.read('time')
    cx, cy = fwd.transform(g['lon'], g['lat'])
    res = abs(x[1] - x[0]); half = int(g['win_km'] * 1000 / res)
    ci, cj = int(np.argmin(abs(y - cy))), int(np.argmin(abs(x - cx)))
    win = [slice(max(0, ci - half), min(len(y), ci + half + 1)), slice(max(0, cj - half), min(len(x), cj + half + 1))]
    X, Y = x[win[1]], y[win[0]]
    vx0, vy0, v0 = comp.read('vx0', win), comp.read('vy0', win), comp.read('v0', win)
    ice = comp.read('landice', win).astype(bool)
    amp, ph, trend = [comp.read(k, win).astype(float) for k in ('v_amp', 'v_phase', 'dv_dt')]
    amp[amp >= 32767] = np.nan; ph[ph >= 32767] = np.nan
    # seed: fastest SMOOTHED on-ice pixel within the search radius (smoothing rejects lone outliers)
    sm = gauss_smooth(v0, 1.5)
    ii, jj = np.mgrid[0:len(Y), 0:len(X)]
    rr = np.hypot((X[jj] - cx), (Y[ii] - cy))
    # the SURFACE, for where the velocity runs out (GLO-30 on this grid, smoothed 2 px) — computed BEFORE
    # the seed, because a seed must also be GROUNDED ice: > SEED_MIN_Z above sea level. The fastest pixel of
    # a lake- or sea-calving glacier is otherwise its calving front / mélange (Breiðamerkurjökull seeded in
    # the Jökulsárlón lagoon: a 3.7 km line at 0–20 m and 0 usable pairs).
    LON, LAT = inv.transform(*np.meshgrid(X, Y))
    zraw = ELEV.dem_grid(LAT, LON, dem_cache)
    zs = gauss_smooth(zraw, 2.0)
    gzi, gzj = np.gradient(zs)
    inner = (ii >= 4) & (jj >= 4) & (ii < len(Y) - 4) & (jj < len(X) - 4) & (np.nan_to_num(zraw, nan=-1) > SEED_MIN_Z)   # never seed on the window edge: a glacier near
    cand = np.where(ice & inner & np.isfinite(sm) & (rr <= g['seek_km'] * 1000), sm, -np.inf)   # its ITS_LIVE tile edge (Perito Moreno) clips
    si, sj = np.unravel_index(np.argmax(cand), cand.shape)                           # the window, and an edge seed traced 0 steps
    vel_ok = float(sm[si, sj]) >= V_TRACE_MIN
    if not vel_ok:      # motion below detection everywhere: seed at the on-ice pixel nearest the stated centre
        si, sj = np.unravel_index(np.argmin(np.where(ice & inner, rr, np.inf)), rr.shape)
    sx, sy = gauss_smooth(vx0, 2.0), gauss_smooth(vy0, 2.0)
    vstop = max(V_STOP, 0.01 * float(sm[si, sj]))
    if vel_ok:
        up, pu = trace(vx0, vy0, ice, sx, sy, si, sj, -1, vstop)
        down, pd = trace(vx0, vy0, ice, sx, sy, si, sj, +1, vstop)
    else:
        up, pu, down, pd = [(si, sj)], None, [(si, sj)], None
    up_t = trace_topo(gzi, gzj, ice, *up[-1], -1, pu)
    down_t = trace_topo(gzi, gzj, ice, *down[-1], +1, pd)
    line = (up + up_t)[::-1] + (down + down_t)[1:]
    kinds = ['t'] * len(up_t) + ['v' if vel_ok else 't'] * len(up) + ['v' if vel_ok else 't'] * (len(down) - 1) + ['t'] * len(down_t)
    up = (up + up_t)          # seed index bookkeeping below uses len(up)
    pts = np.array(line)
    seg = np.hypot(np.diff(pts[:, 0]), np.diff(pts[:, 1])) * res
    s = np.concatenate([[0], np.cumsum(seg)])
    n = int(min(N_FLOW, max(8, s[-1] // res)))
    sq = np.linspace(0, s[-1], n)
    fi = np.interp(sq, s, pts[:, 0]); fj = np.interp(sq, s, pts[:, 1])
    fx = np.interp(fj, np.arange(len(X)), X); fy = np.interp(fi, np.arange(len(Y)), Y)
    kind_at = lambda sv: kinds[min(len(kinds) - 1, int(np.searchsorted(s, sv, side='right')) - 1)]
    traced = ''.join(kind_at(v) for v in sq)
    lon, lat = inv.transform(fx, fy)
    samp = lambda a: np.array([bilinear(a, a_, b_) for a_, b_ in zip(fi, fj)])
    near = lambda a: np.array([a[int(round(a_)), int(round(b_))] for a_, b_ in zip(fi, fj)])
    years = [int((EPOCH + dt.timedelta(days=int(d))).year) for d in t]
    with cf.ThreadPoolExecutor(workers) as ex:      # 42 full-tile chunks (~1.4 MB each): read in parallel
        annual = np.array(list(ex.map(lambda k: samp(comp.read('v', [slice(k, k + 1), win[0], win[1]])[0]), range(len(t)))))
    # field (block-averaged)
    blk = max(1, int(math.ceil(max(len(X), len(Y)) / FIELD_MAX)))
    def block(a, frac=False):
        h, w = (a.shape[0] // blk) * blk, (a.shape[1] // blk) * blk
        b = a[:h, :w].reshape(h // blk, blk, w // blk, blk).astype(float)
        with np.errstate(invalid='ignore'), __import__('warnings').catch_warnings():
            __import__('warnings').simplefilter('ignore', RuntimeWarning)
            return np.nanmean(b, axis=(1, 3))
    fvx, fvy, fice, fz = block(vx0), block(vy0), block(ice.astype(float)), block(zraw)
    fX = X[:(len(X) // blk) * blk].reshape(-1, blk).mean(1); fY = Y[:(len(Y) // blk) * blk].reshape(-1, blk).mean(1)
    # last-year pairs
    today = dt.date.today(); cutoff = today - dt.timedelta(days=days)
    scenes = discover_scenes(cube, g['lon'], g['lat'], None)
    found = list_pairs(scenes, g['lon'], g['lat'], cutoff, today, workers)
    order = select_pairs(found, cutoff, today, max_pairs)
    log(f"  scenes {len(scenes)}  pairs listed {len(found)}  sampling {len(order)}")
    pairs, fetched, skipped, errs = [], [0], {}, []
    reuse = reusable_pairs(*(prev or (None, None)), fx, fy)
    reused, rejected = [0], {}
    lock = threading.Lock()
    def work(item):
        name, (url, sensor, d1, d2, _pct) = item
        old = reuse.get(name[:-3])
        if old is not None and 'rejected' in old:   # read before and found sparse / outside: the granule has not changed
            with lock:
                reused[0] += 1; rejected[name[:-3]] = old['rejected']
                skipped[old['rejected']] = skipped.get(old['rejected'], 0) + 1
            return
        if old is not None:          # same granule, same points: the stored int16 samples ARE the result
            with lock:
                reused[0] += 1
                errs.append(unb64(old['e']))
                pairs.append(dict(id=old['id'], sensor=old['sensor'], d1=old['d1'], d2=old['d2'], v=old['v'], e=old['e']))
            return
        try:
            r, why, nbytes = sample_pair(url, fx, fy, epsg)
        except Exception as e:
            r, why, nbytes = None, type(e).__name__, 0
        with lock:
            fetched[0] += nbytes
            # only a DETERMINISTIC rejection is remembered — a network error is retried next run
            if r is None:
                skipped[why] = skipped.get(why, 0) + 1
                if why == 'outside' or why.startswith('epsg'): rejected[name[:-3]] = why
                return
            v, e = r
            if np.isfinite(v).sum() < max(3, 0.1 * len(v)):
                skipped['sparse'] = skipped.get('sparse', 0) + 1; rejected[name[:-3]] = 'sparse'; return
            errs.append(e)
            pairs.append(dict(id=name[:-3], sensor=sensor, d1=d1.isoformat(), d2=d2.isoformat(),
                              v=b64(v), e=b64(e)))
    with cf.ThreadPoolExecutor(workers) as ex: list(ex.map(work, order))
    pairs.sort(key=lambda q: (q['d1'], q['d2'], q['id']))
    log(f"  kept {len(pairs)} pairs ({reused[0]} reused), skipped {skipped}, fetched {fetched[0] / 1e6:.0f} MB")
    index = dict(
        id=g['id'], name=g['name'], region=g['region'], country=g['country'], kind=g['kind'], note=g['note'],
        lat=g['lat'], lon=g['lon'], epsg=epsg, cube=p['zarr_url'], composite=p['composite_zarr_url'],
        flowline=dict(n=n, length_m=round(float(s[-1])), seed_index=int(np.argmin(abs(sq - s[len(up) - 1]))),
                      traced=traced, velocity_traceable=vel_ok,
                      lat=[round(v, 5) for v in lat], lon=[round(v, 5) for v in lon],
                      x=[round(float(v), 1) for v in fx], y=[round(float(v), 1) for v in fy],
                      s_m=[round(float(v)) for v in sq]),
        climatology=dict(period='2014-2024', v0=b64(samp(v0)),
                         amp=b64(near(amp)), phase_doy=b64(near(ph)),
                         pair_err=b64(np.nanmedian(np.array(errs), axis=0) if errs else np.full(n, np.nan)),   # median ITS_LIVE error of the kept pairs
                         trend=b64(samp(trend) * 10)),           # trend stored ×10 (0.1 m/yr²)
        annual_span=[years[0], years[-1]],      # the series itself lives in <id>.json (the index stays small as glaciers are added)
        scenes=scenes, pairs_cutoff=cutoff.isoformat(), baked=today.isoformat(), pairs_count=len(pairs),
        pairs_listed=len(found), pairs_sampled=len(order), pairs_reused=reused[0],
    )
    detail = dict(id=g['id'], epsg=epsg, annual=dict(years=years, partial_last=True, v=[b64(a) for a in annual]),
                  field=dict(nx=len(fX), ny=len(fY), x0=float(fX[0]), y0=float(fY[0]), dx=float(fX[1] - fX[0]), dy=float(fY[1] - fY[0]),
                             vx=b64(fvx), vy=b64(fvy), ice=b64(fice * 100), z=b64(fz)),   # z: GLO-30 surface, m (block mean)
                  pairs=pairs, dt_max_days=DT_MAX_DAYS, baked=today.isoformat(), skipped=skipped,
                  rejected=dict(sorted(rejected.items())))   # granules read and found unusable: not re-read while the flowline holds
    return index, detail

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='data/glaciers'); ap.add_argument('--only', default='')
    ap.add_argument('--days', type=int, default=365); ap.add_argument('--max-pairs', type=int, default=360)
    ap.add_argument('--workers', type=int, default=12); ap.add_argument('--dem-cache', default='scripts/.cache/glo30')
    ap.add_argument('--no-reuse', action='store_true', help='re-read every pair (default: reuse samples at an unchanged flowline)')
    ap.add_argument('--keep-going', action='store_true',
                    help='a glacier that fails keeps its previous archive entry and is listed in --report (the weekly job)')
    ap.add_argument('--report', default='', help='write a JSON run report here (per-glacier outcome, pairs, reuse, failures)')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    catalog = json.loads(http(CATALOG))
    only = set(filter(None, a.only.split(',')))
    idx_path = os.path.join(a.out, 'glaciers.json')
    prev = {g['id']: g for g in json.load(open(idx_path))['glaciers']} if os.path.exists(idx_path) else {}
    report = dict(started=dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), glaciers={}, failed=[])
    for g in GLACIERS:
        if only and g['id'] not in only: continue
        t0 = time.time(); print(g['id'], flush=True)
        det_path = os.path.join(a.out, g['id'] + '.json')
        prev_detail = None
        if not a.no_reuse and g['id'] in prev and os.path.exists(det_path):
            try: prev_detail = json.load(open(det_path))
            except ValueError: prev_detail = None
        try:
            index, detail = bake(g, catalog, a.days, a.max_pairs, a.workers, lambda m: print(m, flush=True), a.dem_cache,
                                 prev=(prev.get(g['id']), prev_detail))
        except Exception as e:  # noqa: BLE001 — any upstream failure; the entry is kept and REPORTED, never silently aged
            if not a.keep_going: raise
            msg = f'{type(e).__name__}: {e}'[:300]
            print(f'  FAILED ({msg}) — keeping the previous entry', flush=True)
            report['failed'].append(g['id'])
            report['glaciers'][g['id']] = dict(ok=False, error=msg, kept_baked=(prev.get(g['id']) or {}).get('baked'))
            continue
        prev[g['id']] = index
        json.dump(detail, open(det_path, 'w'), separators=(',', ':'))
        report['glaciers'][g['id']] = dict(ok=True, baked=index['baked'], pairs=index['pairs_count'], listed=index['pairs_listed'],
                                           reused=index['pairs_reused'], flowline_km=round(index['flowline']['length_m'] / 1000, 1),
                                           seconds=round(time.time() - t0))
        print(f"  flowline {index['flowline']['n']} pts / {index['flowline']['length_m'] / 1000:.1f} km   {time.time() - t0:.0f} s", flush=True)
    out = dict(format='glacier-watch-v1', source='NASA ITS_LIVE v2 (doi:10.5067/JQ6337239C96)',
               nodata=NODATA, glaciers=[prev[g['id']] for g in GLACIERS if g['id'] in prev])
    json.dump(out, open(idx_path, 'w'), separators=(',', ':'))
    if a.report:
        report['finished'] = dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
        json.dump(report, open(a.report, 'w'), indent=1)

if __name__ == '__main__':
    main()
