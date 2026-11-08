#!/usr/bin/env python3
"""gfs.py — ingest one NOAA GFS run into the Climalytix point-tile archive.

    python3 scripts/climalytix_ingest/gfs.py                 # newest complete run
    python3 scripts/climalytix_ingest/gfs.py --run 2026110700 --max-lead 24 --out /tmp/cx

CLIMALYTIX_PLAN.md §17 (P-1). Runs on GitHub Actions
(.github/workflows/climalytix-ingest.yml), zero GPU, public data only: the
NOAA Open Data Dissemination copy of GFS on AWS (noaa-gfs-bdp-pds — public,
no key, no egress fee). Per lead it reads the `.idx` sidecar, fetches only
the nine messages in tiles.GFS_VARS by HTTP Range (idx.py), decodes them with
ECMWF's eccodes, puts each into the canonical orientation (grid.py), converts
to the stored unit, de-accumulates precipitation, quantises into one
cube[nj, ni, var, time], then writes point tiles → manifest → latest pointer
(store.py's commit order) and prunes runs past --keep.

A lead that cannot be read is a GAP recorded in the manifest's `missing`,
never a zero and never a repeated frame. More than --max-missing-frac of the
cube missing refuses to publish (exit 2): a run that is mostly holes must not
replace a good one as `latest`.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.request

import numpy as np

import grid as G
import idx as I
import store as S
import tiles as T

BUCKET_URL = 'https://noaa-gfs-bdp-pds.s3.amazonaws.com'
ARCHIVE_ROOT = 'climalytix/nwp/gfs'
GENERATOR = 'scripts/climalytix_ingest/gfs.py v1'


def file_url(run, grid_id, lead):
    ymd, hh = run.strftime('%Y%m%d'), run.strftime('%H')
    return f'{BUCKET_URL}/gfs.{ymd}/{hh}/atmos/gfs.t{hh}z.pgrb2.{grid_id}.f{lead:03d}'


def http_get(url, rng=None, retries=4, timeout=60):
    req = urllib.request.Request(url, headers={'Range': rng} if rng else {})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            err = e
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            err = e
        if attempt < retries:
            time.sleep(2 ** (attempt + 1))
    raise RuntimeError(f'GET {url} failed: {err}')


def http_exists(url):
    req = urllib.request.Request(url, method='HEAD')
    try:
        with urllib.request.urlopen(req, timeout=30):
            return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise


def newest_complete_run(grid_id, max_lead, now=None, lookback_h=48):
    """The newest run whose LAST lead's idx exists (NOAA writes in lead order)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= dt.timedelta(hours=t.hour % 6)
    for _ in range(lookback_h // 6 + 1):
        if http_exists(file_url(t, grid_id, max_lead) + '.idx'):
            return t
        t -= dt.timedelta(hours=6)
    return None


def fetch_lead(run, grid_id, lead, step):
    """Download one lead: its idx and every message this run needs from it.
    Returns {'lead', 'inst': {var_id: bytes}, 'acc': {(a,b): bytes}, 'plan', 'err'}."""
    url = file_url(run, grid_id, lead)
    out = {'lead': lead, 'inst': {}, 'acc': {}, 'plan': None, 'err': None}
    text = http_get(url + '.idx')
    if text is None:
        out['err'] = 'idx-missing'
        return out
    entries = I.parse_idx(text.decode('ascii', 'replace'))
    wanted = []
    for v in T.GFS_VARS:
        var, level = v['grib']
        if v['kind'] == 'inst':
            e = I.find_instant(entries, var, level, lead)
            if e:
                wanted.append(('inst', v['id'], e))
        else:
            plan = I.plan_accumulation(entries, var, level, lead, step)
            out['plan'] = plan
            if plan:
                wanted.append(('acc', plan['take'], plan['entry']))
    for start, end, members in I.merge_ranges([w[2] for w in wanted]):
        blob = http_get(url, I.range_header(start, end))
        if blob is None:
            continue
        for kind, key, e in wanted:
            if e in members:
                lo = e['offset'] - start
                hi = None if e['end'] is None else e['end'] - start
                (out['inst'] if kind == 'inst' else out['acc'])[key] = blob[lo:hi]
    return out


def decode(msg_bytes, ec):
    h = ec.codes_new_from_message(msg_bytes)
    try:
        return G.from_handle(h, ec)
    finally:
        ec.codes_release(h)


def run_ingest(args):
    import eccodes as ec

    run = (dt.datetime.strptime(args.run, '%Y%m%d%H').replace(tzinfo=dt.timezone.utc)
           if args.run else newest_complete_run(args.grid, args.max_lead))
    if run is None:
        print('no complete GFS run found in the lookback window', file=sys.stderr)
        return 3
    leads = list(range(0, args.max_lead + 1, args.step))
    run_iso = run.strftime('%Y-%m-%dT%H:%MZ')
    run_ms = int(run.timestamp() * 1000)
    prefix = f"{ARCHIVE_ROOT}/{args.grid}/{run.strftime('%Y%m%dT%HZ')}"
    store, why_local = S.open_store(args.out)
    print(f'GFS {run_iso} {args.grid} leads 0..{args.max_lead} step {args.step} → {store.kind}'
          + (f' ({why_local}: dry run into {args.out})' if why_local else ''))

    nvar, ntime = len(T.GFS_VARS), len(leads)
    cube = meta = None
    missing, clipped, notes = [], {v['id']: 0 for v in T.GFS_VARS}, []
    prev_take = {}
    var_index = {v['id']: k for k, v in enumerate(T.GFS_VARS)}
    acc_var = next(v for v in T.GFS_VARS if v['kind'] == 'acc')
    t0 = time.time()

    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(fetch_lead, run, args.grid, L, args.step) for L in leads]
        for ti, fut in enumerate(futures):        # decode in LEAD ORDER (de-accumulation needs it)
            got = fut.result()
            L = got['lead']
            if got['err']:
                missing += [{'var': v['id'], 'leadH': L, 'reason': got['err']} for v in T.GFS_VARS]
                prev_take = {}
                continue
            for v in T.GFS_VARS:
                k = var_index[v['id']]
                field = None
                if v['kind'] == 'inst':
                    raw = got['inst'].get(v['id'])
                    if raw is None:
                        missing.append({'var': v['id'], 'leadH': L, 'reason': 'not-in-file'})
                        continue
                    field, m = decode(raw, ec)
                else:
                    plan = got['plan']
                    if not plan or plan['take'] not in got['acc']:
                        missing.append({'var': v['id'], 'leadH': L,
                                        'reason': 'no-window' if L == 0 else 'acc-window-missing'})
                        prev_take = {}
                        continue
                    cum, m = decode(got['acc'][plan['take']], ec)
                    if plan['minus'] is None:
                        field = cum
                    elif plan['minus'] in prev_take:
                        field = cum - prev_take[plan['minus']]
                        neg = int(np.count_nonzero(field < -0.05))
                        if neg:
                            notes.append(f'precip lead {L}h: {neg} cells < -0.05 mm after de-accumulation (clamped to 0)')
                        field = np.maximum(field, 0.0)
                    else:
                        missing.append({'var': v['id'], 'leadH': L, 'reason': 'deaccumulation-window-unavailable'})
                    prev_take = {plan['take']: cum}
                    if field is None:
                        continue
                if meta is None:
                    meta = m
                    cube = np.full((m['nj'], m['ni'], nvar, ntime), T.NODATA, dtype='<i2')
                elif (m['ni'], m['nj'], m['lat0'], m['lon0'], m['dlat'], m['dlon']) != \
                        (meta['ni'], meta['nj'], meta['lat0'], meta['lon0'], meta['dlat'], meta['dlon']):
                    raise RuntimeError(f'grid changed at {v["id"]} lead {L}: {m} vs {meta}')
                q, c = T.quantise(T.convert(field, v['convert']), v['scale'], v['offset'])
                clipped[v['id']] += c
                cube[:, :, k, ti] = q
            print(f'  f{L:03d} decoded ({time.time() - t0:.0f}s)', flush=True)

    if cube is None:
        print('nothing decoded — refusing to publish', file=sys.stderr)
        return 2
    frac = len(missing) / (nvar * ntime)
    expected_missing = 1   # precip has no window at f000, by definition
    if len(missing) > expected_missing and frac > args.max_missing_frac:
        print(f'{len(missing)} var-leads missing ({frac:.1%}) > {args.max_missing_frac:.0%} — refusing to publish',
              file=sys.stderr)
        return 2

    n = args.tile
    trs, tcs = T.tile_grid(meta['nj'], meta['ni'], n)
    jobs = [(tr, tc) for tr in range(trs) for tc in range(tcs)]
    total = 0

    def put_tile(job):
        tr, tc = job
        b = T.tile_bytes(cube, tr, tc, n)
        store.put(T.tile_key(prefix, tr, tc), b)
        return len(b)

    with cf.ThreadPoolExecutor(max_workers=args.upload_workers) as pool:
        for nbytes in pool.map(put_tile, jobs):
            total += nbytes
    print(f'  {len(jobs)} tiles, {total / 1e6:.0f} MB written ({time.time() - t0:.0f}s)')

    times = [run_ms + L * 3_600_000 for L in leads]
    notes.insert(0, f"precipMm at lead L is the {args.step} h amount over (L-{args.step}, L]; "
                    'readers stamp it at the interval START so day sums land in the right day')
    man = T.manifest(
        source='gfs', grid_id=args.grid, run_iso=run_iso, run_ms=run_ms, meta=meta, n=n,
        vars_=T.GFS_VARS, times_ms=times, leads_h=leads, prefix=prefix, missing=missing,
        clipped=clipped, generator=GENERATOR,
        created_iso=dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), notes=notes,
    )
    man['intervalH'] = {acc_var['id']: args.step}
    man['upstream'] = f'{BUCKET_URL}/gfs.{run.strftime("%Y%m%d")}/{run.strftime("%H")}/atmos (NOAA ODP, public domain)'
    store.put(f'{prefix}/manifest.json.gz', S.gz(T.dumps(man)), 'application/gzip')
    pointer = {'schema': 'climalytix.latest.v1', 'run': run_iso, 'runMs': run_ms,
               'manifest': f'{prefix}/manifest.json.gz', 'writtenAt': man['createdAt']}
    store.put(f'{ARCHIVE_ROOT}/{args.grid}/latest.json.gz', S.gz(T.dumps(pointer)), 'application/gzip')
    print(f'  published {prefix} as latest')

    prune(store, f'{ARCHIVE_ROOT}/{args.grid}/', prefix + '/', args.keep)
    print(json.dumps({'run': run_iso, 'store': store.kind, 'tiles': len(jobs), 'bytes': total,
                      'missing': len(missing), 'clipped': sum(clipped.values()),
                      'seconds': round(time.time() - t0)}))
    return 0


def prune(store, root, current, keep):
    """Keep the newest `keep` PUBLISHED runs (current included); delete older
    runs and any orphan (no manifest) older than the current run. Never the
    current run, never anything newer than it (a concurrent ingest)."""
    runs = [p for p in store.list_prefixes(root) if p[len(root):-1][:8].isdigit()]
    older = [p for p in runs if p < current]
    published = [p for p in older if store.get(f'{p}manifest.json.gz') is not None]
    survivors = set(sorted(published)[-(keep - 1):]) if keep > 1 else set()
    for p in older:
        if p not in survivors:
            store.delete_prefix(p)
            print(f'  pruned {p}')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--run', help='YYYYMMDDHH (default: newest complete run)')
    ap.add_argument('--grid', default='0p25', choices=['0p25', '0p50', '1p00'])
    ap.add_argument('--max-lead', type=int, default=240)
    ap.add_argument('--step', type=int, default=3)
    ap.add_argument('--tile', type=int, default=20, help='cells per tile edge (ni must divide)')
    ap.add_argument('--keep', type=int, default=2, help='published runs to keep')
    ap.add_argument('--workers', type=int, default=8, help='parallel lead downloads')
    ap.add_argument('--upload-workers', type=int, default=32)
    ap.add_argument('--max-missing-frac', type=float, default=0.05)
    ap.add_argument('--out', default='climalytix-out', help='local dir when R2 is not configured')
    return run_ingest(ap.parse_args(argv))


if __name__ == '__main__':
    sys.exit(main())
