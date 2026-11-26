#!/usr/bin/env python3
"""
paleo_oracle.py — the INDEPENDENT reference for js/paleo/*: the same plate
model run through pyGPlates (the EarthByte group's own reconstruction
library), written as a fixture the node gate compares against.

    python3 -m venv venv && venv/bin/pip install pygplates
    venv/bin/python -I scripts/paleo_oracle.py --dir <unzipped archive> [--model muller2019|merdith2021]

Nothing here is shipped to the browser. It writes
tests/fixtures/paleo/pygplates-oracle.json (Müller 2019) or
tests/fixtures/paleo/pygplates-oracle-merdith2021.json (Merdith 2021 — run on
the archive's FULL 1000 Ma rotation file, so the bake's 250 Ma trim is tested
too, and on its GPML static polygons, read by pyGPlates itself):

  rotations   the total rotation of every plate the baked files use,
              relative to anchor 0, at a fixed set of ages (on and off the
              file's own row ages), as pygplates.RotationModel returns it.
              A plate/age pyGPlates has no rotation for is recorded as null
              (use_identity_for_missing_plate_ids=False), so a refusal can
              be checked too.
  partition   [lat, lon, plate id, the chosen polygon's appearance age]: the plate id pyGPlates' PlatePartitioner assigns to ~4000
              Fibonacci-sphere points at the present day from the model's
              static polygons, under its DEFAULT order (plate id, highest
              first) — the rule js/paleo/plates.js reproduces.
  sites       the Chicxulub sites at 66.04 Ma, reconstructed by pyGPlates (for
              Merdith, on the plate ITS partitioner gives each site).

The gate is in tests/paleo-rotations.mjs (§ pyGPlates oracle).
"""
import argparse, json, math, os, sys
import pygplates

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = {
    'muller2019': {
        'rot': 'Muller_etal_2019_PlateMotionModel_v2.0_Tectonics_Updated/Global_250-0Ma_Rotations_2019_v2.rot',
        'static': 'Muller_etal_2019_PlateMotionModel_v2.0_Tectonics_Updated/StaticGeometries/StaticPolygons/Global_EarthByte_GPlates_PresentDay_StaticPlatePolygons_2019_v1.shp',
        'baked': 'data/paleo/muller2019-rotations.json',
        'out': 'tests/fixtures/paleo/pygplates-oracle.json',
    },
    'merdith2021': {
        'rot': 'SM2-Merdith_et_al_1_Ga_reconstruction_v1.2.4/1000_0_rotfile_Merdith_et_al.rot',
        'static': 'SM2-Merdith_et_al_1_Ga_reconstruction_v1.2.4/shapes_static_polygons_Merdith_et_al.gpml',
        'baked': 'data/paleo/merdith2021-rotations.json',
        'out': 'tests/fixtures/paleo/pygplates-oracle-merdith2021.json',
    },
}
AGES = [0.0, 0.5, 7.25, 10.0, 33.3, 45.0, 66.04, 83.5, 100.0, 120.4, 145.7, 170.0, 200.0, 230.0, 249.9, 250.0]
N_POINTS = 4000
DISTANT_PAST = 4600.0                      # = scripts/build-paleo-merdith.py


def fib(n):
    g = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        z = 1 - 2 * (i + 0.5) / n
        lon = math.degrees((i * g) % (2 * math.pi))
        if lon > 180:
            lon -= 360
        yield math.degrees(math.asin(z)), lon


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True, help='the unzipped model archive')
    ap.add_argument('--model', default='muller2019', choices=sorted(MODELS))
    a = ap.parse_args()
    cfg = MODELS[a.model]
    ROT, STATIC = cfg['rot'], cfg['static']
    rot_file, static_file = os.path.join(a.dir, ROT), os.path.join(a.dir, STATIC)
    model = pygplates.RotationModel(rot_file)
    static = pygplates.FeatureCollection(static_file)

    baked = json.load(open(os.path.join(ROOT, cfg['baked']), encoding='utf-8'))
    plates = sorted({s[0] for s in baked['sequences']} | {f.get_reconstruction_plate_id() for f in static})
    rotations = []
    for plate in plates:
        for age in AGES:
            r = model.get_rotation(age, plate, anchor_plate_id=0, use_identity_for_missing_plate_ids=False)
            if r is None:
                rotations.append([plate, age, None])
                continue
            if r.represents_identity_rotation():
                rotations.append([plate, age, [90.0, 0.0, 0.0]])
                continue
            la, lo, ang = r.get_lat_lon_euler_pole_and_angle_degrees()
            rotations.append([plate, age, [la, lo, ang]])

    recon = []
    pygplates.reconstruct(static, model, recon, 0)
    part = pygplates.PlatePartitioner(recon, model)              # default order: plate id, highest first
    partition = []
    for lat, lon in fib(N_POINTS):
        g = part.partition_point(pygplates.PointOnSphere(lat, lon))
        if g is None:
            partition.append([round(lat, 6), round(lon, 6), None, None])
        else:
            f = g.get_feature()
            begin = f.get_valid_time()[0]
            if math.isinf(begin):
                begin = DISTANT_PAST                # the bake's own encoding of 'distantPast'
            partition.append([round(lat, 6), round(lon, 6), f.get_reconstruction_plate_id(), begin])

    sites = json.load(open(os.path.join(ROOT, 'data/paleo/muller2019-sites.json'), encoding='utf-8'))['sites']
    site_out = {}
    for key, s in sites.items():
        g = part.partition_point(pygplates.PointOnSphere(s['lat'], s['lon']))
        pp = g.get_feature().get_reconstruction_plate_id()
        plate = s['plate'] if a.model == 'muller2019' else pp
        r = model.get_rotation(66.04, plate, anchor_plate_id=0)
        la, lo = (r * pygplates.PointOnSphere(s['lat'], s['lon'])).to_lat_lon()
        site_out[key] = {'plate': plate, 'presentLat': s['lat'], 'presentLon': s['lon'], 'lat': la, 'lon': lo, 'partitionPlate': pp}

    out = {
        'meta': {'model': a.model, 'pygplates': str(pygplates.Version.get_imported_version()), 'rotationFile': ROT.split('/')[-1],
                 'staticPolygons': STATIC.split('/')[-1], 'ages': AGES, 'points': N_POINTS,
                 'rotation': '[pole lat, pole lon, angle deg] (pyGPlates Euler pole), or null where it has no rotation', 'partitionOrder': 'pygplates default: plate id, highest first'},
        'rotations': rotations, 'partition': partition, 'sites': site_out,
    }
    path = os.path.join(ROOT, cfg['out'])
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, 'w', encoding='utf-8').write(json.dumps(out, separators=(',', ':'), allow_nan=False) + '\n')
    nulls = sum(1 for r in rotations if r[2] is None)
    print(f'{len(plates)} plates × {len(AGES)} ages ({nulls} refused), {len(partition)} points → {os.path.relpath(path, ROOT)}')


if __name__ == '__main__':
    main()
