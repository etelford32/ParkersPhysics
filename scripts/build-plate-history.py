"""
scripts/build-plate-history.py — tectonic plates through time, 1800 Ma → today (offline bake)
═══════════════════════════════════════════════════════════════════════════════════════════
PLATE_HISTORY_PLAN.md. Never deployed; the outputs under data/plate-history/ are committed and
read by js/plate-history/*.js (PURE) on plate-tectonics.html.

SOURCE. Cao, Merdith, Williams, Müller et al., the 1.8 Ga full-plate model ("1.8Ga_model_submit",
EarthByte Data_Collections/Cao_etal_2023), which extends Merdith et al. (2021, Earth-Science
Reviews 214, 103477, "A continuous, kinematic full-plate motion model from 1 Ga to present") back
to 1.8 Ga. Both are distributed by the EarthByte group under CC BY 4.0 (Data_Collections/License.txt,
read 2026-11-23). The zip is fetched from EarthByte's own WebDAV and sha256-pinned; nothing is
written if the hash differs.

WHAT THE MODEL IS — and is not. A KINEMATIC reconstruction: a rotation file (finite rotations of
every plate relative to its parent, back to an absolute frame defined by palaeomagnetism) plus
time-dependent plate-boundary TOPOLOGIES drawn by geologists. It is constrained by palaeomagnetic
poles, geology and (since ~200 Ma) the ocean floor's magnetic isochrons. Before ~200 Ma there is no
surviving ocean floor, so OCEANIC plates and ridges are INFERRED from the continents' motion —
the model's own readme says the Panthalassa ocean is poorly constrained. Palaeomagnetism fixes
latitude, not longitude. Every surface on the page says this.

WHAT IS WRITTEN (data/plate-history/):
  rotations.json.gz   the rotation model, parsed: one record per (moving, fixed) sequence in FILE
                      ORDER (the 1.8–1.0 Ga file first, as the model's .gproj loads it), each with
                      its sample times and poles. js/plate-history/rotations.js composes them;
                      tests/plate-history-rotations.mjs pins that kernel against pygplates.
  continents.json.gz  present-day continental polygons and coastlines (exterior rings, simplified
                      in 3-D to TOL_DEG), each with its reconstruction plate id and valid time. The
                      page rotates them with the kernel at ANY instant — they move continuously.
  frames.json.gz      the resolved plate topologies every STEP_MA: per frame, the plates (id,
                      name, area), a 1° plate raster (run-length coded; index into the frame's
                      plate list, 255 = no plate) and every shared boundary sub-segment (feature
                      type, the feature's own plate id — so the page can carry it between frames —
                      the plates on its left/right, and for a trench the overriding/subducting
                      plates). Coordinates are 0.01° integers, delta-coded per line.
  meta.json           provenance (every hash), the feature-type table, per-frame topology checks
                      (Σ plate area ÷ 4π: > 1 is overlap, < 1 a gap — the model's own, reported,
                      never repaired) and the output files' hashes.

Deterministic: gzip mtime 0, sorted keys, fixed separators. `--check` rebuilds in memory and
compares bytes with the committed files.

Usage: python3 scripts/build-plate-history.py [--cache DIR] [--out data/plate-history] [--check]
Dependencies: pygplates (PyPI, 1.0.0 used), numpy.
"""
import argparse, gzip, hashlib, io, json, math, os, sys, urllib.request, zipfile

import numpy as np
import pygplates

MODEL = dict(
    url='https://www.earthbyte.org/webdav/ftp/Data_Collections/Cao_etal_2023/1.8Ga_model_submit.zip',
    sha256='e9f5861cce8006c563a6acdf202fd1060e36c6c3ebfa7e6724489e8cb1adc5a9',
    root='1.8Ga_model_submit/',
    licence='CC BY 4.0 (EarthByte Data_Collections/License.txt)',
    citation=('Cao, X., Merdith, A. S., Williams, S. E., Müller, R. D. et al. A 1.8 Ga full-plate tectonic '
              'reconstruction (EarthByte Data_Collections/Cao_etal_2023), extending Merdith, A. S., Williams, '
              'S. E., Collins, A. S., Tetley, M. G. et al. (2021) A continuous, kinematic full-plate motion '
              'model from 1 Ga to present. Earth-Science Reviews 214, 103477.'),
)
ROTATION_FILES = ['Rotation_file_1800_1000_no_ncc_new_SaoFrancisco.rot',
                  '1000_0_rotfile_Merdith_et_al_Cao_new_ncc.rot']
TOPOLOGY_FILES = ['1800-1000Ma-plate-boundary_new_valid_time_and_subduction_polarity.gpml',
                  '1000-410-Topologies_Merdith_et_al_Cao.gpml', '1000-410-Convergence_Merdith_et_al_Cao.gpml',
                  '1000-410-Divergence_Merdith_et_al_Cao.gpml', '1000-410-Transforms_Merdith_et_al_Cao.gpml',
                  '410-250_plate_boundaries_Merdith_et_al.gpml', '250-0_plate_boundaries_Merdith_et_al.gpml',
                  'TopologyBuildingBlocks_Merdith_et_al.gpml']
CONTINENT_FILE = 'shapes_continents_Cao.gpmlz'
COAST_FILE = 'shapes_coasts_Cao.gpmlz'

T_MAX_MA = 1800
STEP_MA = 5
RASTER_DEG = 1
TOL_DEG = 0.05          # 3-D Douglas–Peucker tolerance for continents/coasts (~5.6 km)
Q = 100                 # coordinate quantum: 0.01°
FOREVER = 10000         # stands in for an infinite begin time (distant past)
USER_AGENT = 'parkersphysics-plate-history-bake/1.0 (+https://parkersphysics.com)'


def sha256(b):
    return hashlib.sha256(b).hexdigest()


def fetch(cache):
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, os.path.basename(MODEL['url']))
    if not os.path.exists(path):
        print('downloading', MODEL['url'], file=sys.stderr)
        # EarthByte answers 403 to Python's default 'Python-urllib/x.y' User-Agent (measured
        # 2026-11-25 on the CI runner and here; a named client gets the file), so name ours.
        req = urllib.request.Request(MODEL['url'], headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=300) as r, open(path, 'wb') as f:
            f.write(r.read())
    raw = open(path, 'rb').read()
    if sha256(raw) != MODEL['sha256']:
        sys.exit(f'sha256 mismatch for {path}: {sha256(raw)}')
    out = os.path.join(cache, 'model')
    if not os.path.isdir(os.path.join(out, MODEL['root'])):
        zipfile.ZipFile(io.BytesIO(raw)).extractall(out)
    return os.path.join(out, MODEL['root']), raw


def file_hashes(base, names):
    return {n: sha256(open(os.path.join(base, n), 'rb').read()) for n in names}


# ── rotations ────────────────────────────────────────────────────────────────────────────────
def parse_rotations(base):
    """Parse the PLATES4 .rot text exactly as written: moving, time, lat, lon, angle, fixed.
    Sequences break whenever the (moving, fixed) pair changes between consecutive lines. Lines
    with moving plate 999 are the format's comment convention: skipped, WITHOUT ending the
    sequence they sit in (pygplates too)."""
    seqs = []
    for fname in ROTATION_FILES:
        cur = None
        for line in open(os.path.join(base, fname), encoding='utf-8', errors='replace'):
            body = line.split('!', 1)[0].split()
            if len(body) < 6:
                continue
            try:
                mov = int(body[0]); t = float(body[1]); la = float(body[2]); lo = float(body[3])
                ang = float(body[4]); fix = int(body[5])
            except ValueError:
                continue
            if mov == 999:
                # The format's comment line. It does NOT end the sequence: pygplates keeps
                # interpolating across it (Laurentia 101→000 runs 1480 → 1600 Ma over three
                # commented poles). Ending the sequence here broke the circuit for every
                # plate on Laurentia between 1480 and 1600 Ma (measured, 170° off).
                continue
            if cur is None or cur['m'] != mov or cur['f'] != fix:
                cur = dict(m=mov, f=fix, t=[], lat=[], lon=[], a=[])
                seqs.append(cur)
            cur['t'].append(t); cur['lat'].append(la); cur['lon'].append(lo); cur['a'].append(ang)
    return seqs


# ── geometry helpers ─────────────────────────────────────────────────────────────────────────
def xyz(lat, lon):
    a, b = math.radians(lat), math.radians(lon)
    return (math.cos(a) * math.cos(b), math.cos(a) * math.sin(b), math.sin(a))


def simplify(pts, tol_deg):
    """Douglas–Peucker on the sphere: distance = angle from the chord's great circle."""
    if len(pts) < 3:
        return pts
    v = np.array([xyz(a, b) for a, b in pts])
    keep = np.zeros(len(pts), bool); keep[0] = keep[-1] = True
    tol = math.sin(math.radians(tol_deg))
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        n = np.cross(v[i], v[j]); nn = np.linalg.norm(n)
        seg = v[i + 1:j]
        if nn < 1e-12:
            d = np.linalg.norm(seg - v[i], axis=1)
        else:
            d = np.abs(seg @ (n / nn))
        k = int(np.argmax(d))
        if d[k] > tol:
            m = i + 1 + k
            keep[m] = True
            stack.append((i, m)); stack.append((m, j))
    return [p for p, k in zip(pts, keep) if k]


def encode_line(pts):
    """[lat0, lon0, dlat1, dlon1, …] in 0.01° integers."""
    out, pl, po = [], 0, 0
    for la, lo in pts:
        qa, qo = int(round(la * Q)), int(round(lo * Q))
        out.append(qa - pl); out.append(qo - po)
        pl, po = qa, qo
    return out


def valid(ft):
    b, e = ft.get_valid_time()
    b = FOREVER if b == float('inf') or b > FOREVER else round(b, 3)
    e = -FOREVER if e == float('-inf') else round(e, 3)
    return b, e


def shapes(base, fname):
    out = []
    for ft in pygplates.FeatureCollection(os.path.join(base, fname)):
        b, e = valid(ft)
        for g in ft.get_geometries():
            if not isinstance(g, pygplates.PolygonOnSphere):
                continue
            pts = [p.to_lat_lon() for p in g.get_exterior_ring_points()]
            s = simplify(pts + [pts[0]], TOL_DEG)[:-1]
            if len(s) < 3:
                continue
            out.append(dict(p=ft.get_reconstruction_plate_id(), b=b, e=e, n=ft.get_name() or '',
                            r=encode_line(s)))
    out.sort(key=lambda d: (d['p'], -d['b'], d['r'][:4], d['n']))
    return out


# ── frames ───────────────────────────────────────────────────────────────────────────────────
def resolve_frame(fc, rot, t, cell_pts, types):
    res, sec = [], []
    pygplates.resolve_topologies(fc, rot, res, t, sec)
    key = lambda r: r.get_feature().get_feature_id().get_string()
    order = sorted(res, key=lambda r: (r.get_feature().get_reconstruction_plate_id(), key(r)))
    idx = {key(r): i for i, r in enumerate(order)}
    plates = [dict(p=r.get_feature().get_reconstruction_plate_id(), n=r.get_feature().get_name() or '',
                   a=round(r.get_resolved_geometry().get_area() / (4 * math.pi), 6)) for r in order]
    part = pygplates.PlatePartitioner(res, rot)
    cells = []
    for p in cell_pts:
        r = part.partition_point(p)
        cells.append(255 if r is None else idx[key(r)])
    rle, prev, run = [], cells[0], 0
    for c in cells:
        if c == prev:
            run += 1
        else:
            rle += [prev, run]; prev, run = c, 1
    rle += [prev, run]

    segs = []
    for s in sec:
        ftype = s.get_topological_section_feature().get_feature_type().get_name()
        if ftype not in types:
            types.append(ftype)
        ti = types.index(ftype)
        for ss in s.get_shared_sub_segments():
            pts = [p.to_lat_lon() for p in ss.get_resolved_geometry().get_points()]
            if len(pts) < 2:
                continue
            left = right = -1
            for r, on_left in zip(ss.get_sharing_resolved_topologies(),
                                  ss.get_sharing_resolved_topology_on_left_flags()):
                pid = r.get_feature().get_reconstruction_plate_id()
                if on_left:
                    left = pid
                else:
                    right = pid
            over = sub = -1
            os_ = ss.get_overriding_and_subducting_plates()
            if os_ is not None:
                over = os_[0].get_feature().get_reconstruction_plate_id()
                sub = os_[1].get_feature().get_reconstruction_plate_id()
            segs.append([ti, ss.get_feature().get_reconstruction_plate_id(), left, right, over, sub,
                         encode_line(pts)])
    segs.sort(key=lambda s: (s[0], s[1], s[2], s[3], s[6][:4]))
    area = sum(pl['a'] for pl in plates)
    return dict(t=t, plates=plates, raster=rle, segs=segs), round(area, 6)


def gz(obj):
    raw = json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=9) as g:
        g.write(raw)
    return buf.getvalue()


def build(base, zip_raw):
    rot = pygplates.RotationModel([os.path.join(base, f) for f in ROTATION_FILES])
    fc = [pygplates.FeatureCollection(os.path.join(base, f)) for f in TOPOLOGY_FILES]

    seqs = parse_rotations(base)
    # validToMa: the model's stated span. Some sequences carry samples past it (1900 Ma, 10 000);
    # the kernel never differences a velocity beyond it (there every plate is at identity).
    rotations = dict(anchor=0, files=ROTATION_FILES, seqs=seqs, validToMa=T_MAX_MA)

    continents = dict(tolDeg=TOL_DEG, q=Q, forever=FOREVER,
                      continents=shapes(base, CONTINENT_FILE), coasts=shapes(base, COAST_FILE))

    n = 180 // RASTER_DEG
    lats = [90 - RASTER_DEG * (i + 0.5) for i in range(n)]
    lons = [-180 + RASTER_DEG * (j + 0.5) for j in range(2 * n)]
    cell_pts = [pygplates.PointOnSphere(la, lo) for la in lats for lo in lons]

    types, frames, checks = [], [], []
    for t in range(0, T_MAX_MA + 1, STEP_MA):
        fr, area = resolve_frame(fc, rot, float(t), cell_pts, types)
        frames.append(fr)
        checks.append(dict(t=t, plates=len(fr['plates']), segs=len(fr['segs']), areaOver4pi=area,
                           unassigned=sum(fr['raster'][k + 1] for k in range(0, len(fr['raster']), 2)
                                          if fr['raster'][k] == 255)))
        if t % 100 == 0:
            print(f'  {t} Ma: {len(fr["plates"])} plates, {len(fr["segs"])} segments, Σarea/4π {area}',
                  file=sys.stderr)
    frames_doc = dict(stepMa=STEP_MA, tMaxMa=T_MAX_MA, rasterDeg=RASTER_DEG, q=Q, types=types,
                      raster='rows north→south from 90°N, columns west→east from 180°W; RLE [value, run]',
                      segFields=['type', 'featurePlate', 'leftPlate', 'rightPlate', 'overridingPlate',
                                 'subductingPlate', 'line'],
                      frames=frames)

    outs = {'rotations.json.gz': gz(rotations), 'continents.json.gz': gz(continents),
            'frames.json.gz': gz(frames_doc)}
    meta = dict(
        source=dict(url=MODEL['url'], sha256=MODEL['sha256'], licence=MODEL['licence'], citation=MODEL['citation'],
                    files=file_hashes(base, ROTATION_FILES + TOPOLOGY_FILES + [CONTINENT_FILE, COAST_FILE])),
        pygplates=pygplates.__version__, stepMa=STEP_MA, tMaxMa=T_MAX_MA, rasterDeg=RASTER_DEG, tolDeg=TOL_DEG,
        types=types, topologyChecks=checks,
        counts=dict(rotationSequences=len(seqs), continents=len(continents['continents']),
                    coasts=len(continents['coasts']), frames=len(frames)),
        outputs={k: dict(sha256=sha256(v), bytes=len(v)) for k, v in outs.items()},
    )
    outs['meta.json'] = (json.dumps(meta, sort_keys=True, indent=1, ensure_ascii=False) + '\n').encode('utf-8')
    return outs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(os.path.dirname(__file__), '.cache', 'plate-history'))
    ap.add_argument('--out', default=os.path.join(os.path.dirname(__file__), '..', 'data', 'plate-history'))
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    base, raw = fetch(a.cache)
    outs = build(base, raw)
    if a.check:
        bad = [k for k, v in outs.items()
               if not os.path.exists(os.path.join(a.out, k)) or open(os.path.join(a.out, k), 'rb').read() != v]
        if bad:
            sys.exit('stale: ' + ', '.join(bad))
        print('plate-history: all outputs reproduce byte-for-byte')
        return
    os.makedirs(a.out, exist_ok=True)
    for k, v in outs.items():
        open(os.path.join(a.out, k), 'wb').write(v)
        print(f'wrote {k} ({len(v):,} bytes)')


if __name__ == '__main__':
    main()
