"""
scripts/plate_history_oracle.py — pygplates answers for the plate-history gates (tests only)
═══════════════════════════════════════════════════════════════════════════════════════════
Writes tests/fixtures/plate-history/pygplates-oracle.json from the SAME pinned model zip that
scripts/build-plate-history.py bakes. Our JS rotation kernel (js/plate-history/rotations.js) is
an independent implementation of the PLATES4 rotation hierarchy; this file is what it is held to:

  totals      the total rotation of a plate relative to the anchor (0) at a time — random
              (plate, time) pairs, plus every awkward time: exact sample times, the 1000 Ma seam
              between the two rotation files, 0 and 1800 Ma, and plates/times with no sequence.
  velocities  pygplates.calculate_velocities over the stage rotation t+1 → t (GPlates' default
              velocity convention), at random points on random plates, in km/Myr = mm/yr.
  reconstructed  pygplates.reconstruct of whole continent FEATURES at several times: each
              feature's reconstructed exterior-ring centroid (a 3-D mean of vertices, unit-normed).
              The JS side reconstructs the BAKED (simplified) polygon, so this checks the plate id,
              the valid-time window and the composition end to end, to the simplification tolerance.

Deterministic (seeded). Usage: python3 scripts/plate_history_oracle.py [--cache DIR]
"""
import argparse, importlib.util, json, math, os, random

import pygplates

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('bph', os.path.join(HERE, 'build-plate-history.py'))
bph = importlib.util.module_from_spec(spec); spec.loader.exec_module(bph)

OUT = os.path.join(HERE, '..', 'tests', 'fixtures', 'plate-history', 'pygplates-oracle.json')


def quat(fr):
    if fr.represents_identity_rotation():
        return [1.0, 0.0, 0.0, 0.0]
    pole, ang = fr.get_euler_pole_and_angle()
    ax = pole.to_xyz(); h = math.sin(ang / 2)
    w, x, y, z = math.cos(ang / 2), ax[0] * h, ax[1] * h, ax[2] * h
    if w < 0:
        w, x, y, z = -w, -x, -y, -z
    return [round(v, 12) for v in (w, x, y, z)]


def centroid(pts):
    s = [0.0, 0.0, 0.0]
    for la, lo in pts:
        v = bph.xyz(la, lo)
        s = [s[0] + v[0], s[1] + v[1], s[2] + v[2]]
    n = math.sqrt(sum(c * c for c in s))
    return [c / n for c in s]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cache', default=os.path.join(HERE, '.cache', 'plate-history'))
    a = ap.parse_args()
    base, _ = bph.fetch(a.cache)
    rot = pygplates.RotationModel([os.path.join(base, f) for f in bph.ROTATION_FILES])
    seqs = bph.parse_rotations(base)
    rng = random.Random(20261123)

    moving = sorted({s['m'] for s in seqs})
    samples = sorted({t for s in seqs for t in s['t']})
    totals = []
    pairs = [(rng.choice(moving), round(rng.uniform(0, 1800), 3)) for _ in range(600)]
    pairs += [(rng.choice(moving), t) for t in rng.sample(samples, 150)]
    pairs += [(rng.choice(moving), t) for t in (0.0, 999.999, 1000.0, 1000.001, 1799.9, 1800.0) for _ in range(8)]
    pairs += [(424242, 100.0), (101, 2500.0), (0, 500.0)]     # unknown plate, beyond the model, anchor
    # Laurentia across three COMMENTED (999) poles, 1480 → 1600 Ma: the sequence must continue
    # through them (ending it there broke every plate on Laurentia — the first parser did).
    pairs += [(p, t) for p in (101, 201, 714) for t in (1485.0, 1510.0, 1555.0, 1590.0, 1599.9)]
    for pid, t in pairs:
        fr = rot.get_rotation(t, pid, anchor_plate_id=0)
        totals.append(dict(p=pid, t=t, q=quat(fr)))

    vel = []
    for _ in range(300):
        pid, t = rng.choice(moving), round(rng.uniform(0, 1799), 2)
        la, lo = round(math.degrees(math.asin(rng.uniform(-1, 1))), 4), round(rng.uniform(-180, 180), 4)
        stage = rot.get_rotation(t, pid, t + 1.0, anchor_plate_id=0)
        p = pygplates.PointOnSphere(la, lo)
        v = pygplates.calculate_velocities([p], stage, 1.0, pygplates.VelocityUnits.kms_per_my)[0]
        # convert_from_geocentric_to_north_east_down returns local (north, east, down).
        north, east, _down = pygplates.LocalCartesian.convert_from_geocentric_to_north_east_down([p], [v])[0].to_xyz()
        vel.append(dict(p=pid, t=t, lat=la, lon=lo, north=round(north, 9), east=round(east, 9)))

    # Each feature's FIRST exterior-ring vertex: the baker's simplification always keeps it, so
    # the JS side can match the baked ring exactly (a vertex-mean centroid moves with vertex
    # density and could not). `absent` lists picks pygplates does NOT reconstruct at t. Each
    # carries its begin time: a few features share plate, name AND first vertex and differ
    # only in when they appear.
    recon, absent = [], []
    feats = [f for f in pygplates.FeatureCollection(os.path.join(base, bph.CONTINENT_FILE))
             if len(f.get_geometries()) == 1 and isinstance(f.get_geometry(), pygplates.PolygonOnSphere)]
    for t in (0.0, 100.0, 250.0, 520.0, 900.0, 1300.0, 1750.0):
        picks = rng.sample(feats, 40)
        out = []
        pygplates.reconstruct(picks, rot, out, t)
        seen = set()
        for rf in out:
            g = rf.get_reconstructed_geometry()
            ft = rf.get_feature()
            seen.add(ft.get_feature_id().get_string())
            first0 = ft.get_geometry().get_exterior_ring_points()[0].to_lat_lon()
            first = g.get_exterior_ring_points()[0].to_lat_lon()
            recon.append(dict(t=t, p=ft.get_reconstruction_plate_id(), name=ft.get_name() or '',
                              begin=bph.valid(ft)[0], present=[round(c, 6) for c in first0], at=[round(c, 6) for c in first]))
        for ft in picks:
            if ft.get_feature_id().get_string() not in seen:
                first0 = ft.get_geometry().get_exterior_ring_points()[0].to_lat_lon()
                absent.append(dict(t=t, p=ft.get_reconstruction_plate_id(), name=ft.get_name() or '',
                                   begin=bph.valid(ft)[0], present=[round(c, 6) for c in first0]))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc = dict(note='pygplates answers for tests/plate-history-*.mjs; written by scripts/plate_history_oracle.py — never hand-edit',
               pygplates=pygplates.__version__, model_sha256=bph.MODEL['sha256'],
               totals=totals, velocities=vel, reconstructed=recon, absent=absent)
    with open(OUT, 'w') as f:
        json.dump(doc, f, separators=(',', ':'), sort_keys=True)
        f.write('\n')
    print('wrote', OUT, len(totals), 'totals', len(vel), 'velocities', len(recon), 'reconstructions')


if __name__ == '__main__':
    main()
