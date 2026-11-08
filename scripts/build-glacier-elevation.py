"""
scripts/build-glacier-elevation.py — surface elevation along every Glacier Watch flowline
════════════════════════════════════════════════════════════════════════════════════════
Reads the flowlines baked by scripts/build-glacier-velocity.py (data/glaciers/glaciers.json)
and samples the Copernicus GLO-30 DEM (public S3, copernicus-dem-30m — reachable from the
build sandbox) at every point, bilinearly. Writes data/glaciers/elevation.json.

Why: the daily melt index (js/glacier-weather.js) asks Open-Meteo for temperature AT the
glacier's own altitude (its `elevation=` parameter applies the lapse-rate correction), and the
page draws the longitudinal profile. GLO-30 is a ~2011–2015 TanDEM-X surface — the ice has
thinned since, by tens of metres on the fastest-changing tongues; that is disclosed with the
profile, and it is irrelevant at the precision a degree-day index needs.

Usage: python scripts/build-glacier-elevation.py [--index data/glaciers/glaciers.json]
                                                 [--out data/glaciers/elevation.json] [--cache DIR]
Dependencies: numpy, tifffile, imagecodecs.
Citation: Copernicus DEM — GLO-30 (2021) © DLR e.V. 2010–2014 and © Airbus 2014–2018,
provided under COPERNICUS by the European Union and ESA; all rights reserved. Free use with
this attribution.
"""
import argparse, json, math, os, ssl, urllib.request
import numpy as np
import tifffile

URL = 'https://copernicus-dem-30m.s3.amazonaws.com/{n}/{n}.tif'
_CA = os.environ.get('SSL_CERT_FILE') or ('/root/.ccr/ca-bundle.crt' if os.path.exists('/root/.ccr/ca-bundle.crt') else None)
_CTX = ssl.create_default_context(cafile=_CA) if _CA else ssl.create_default_context()

def tile_name(lat, lon):
    la, lo = math.floor(lat), math.floor(lon)
    return 'Copernicus_DSM_COG_10_{}{:02d}_00_{}{:03d}_00_DEM'.format('N' if la >= 0 else 'S', abs(la), 'E' if lo >= 0 else 'W', abs(lo))

class Tile:
    def __init__(self, name, cache):
        path = os.path.join(cache, name + '.tif')
        if not os.path.exists(path):
            with urllib.request.urlopen(URL.format(n=name), context=_CTX, timeout=180) as r, open(path, 'wb') as f:
                f.write(r.read())
        with tifffile.TiffFile(path) as t:
            p = t.pages[0]
            self.z = p.asarray().astype(float)
            tie = p.tags['ModelTiepointTag'].value; sc = p.tags['ModelPixelScaleTag'].value
        self.lon0, self.lat0, self.dlon, self.dlat = tie[3], tie[4], sc[0], sc[1]
        self.area_or_point = 'area'          # GLO-30 COGs are PixelIsArea: tiepoint = pixel corner

    def sample_many(self, lat, lon):
        """Vectorised bilinear sample; NaN outside this tile."""
        lat = np.asarray(lat, float); lon = np.asarray(lon, float)
        fj = (lon - self.lon0) / self.dlon - 0.5; fi = (self.lat0 - lat) / self.dlat - 0.5
        i = np.floor(fi).astype(int); j = np.floor(fj).astype(int)
        ok = (i >= 0) & (j >= 0) & (i + 1 < self.z.shape[0]) & (j + 1 < self.z.shape[1])
        out = np.full(lat.shape, np.nan)
        ii, jj = i[ok], j[ok]
        a, b = fj[ok] - jj, fi[ok] - ii
        z = self.z
        out[ok] = z[ii, jj] * (1 - a) * (1 - b) + z[ii, jj + 1] * a * (1 - b) + z[ii + 1, jj] * (1 - a) * b + z[ii + 1, jj + 1] * a * b
        return out

    def sample(self, lat, lon):
        fj = (lon - self.lon0) / self.dlon - 0.5
        fi = (self.lat0 - lat) / self.dlat - 0.5
        i, j = int(math.floor(fi)), int(math.floor(fj))
        if i < 0 or j < 0 or i + 1 >= self.z.shape[0] or j + 1 >= self.z.shape[1]: return math.nan
        a, b = fj - j, fi - i
        q = self.z[i:i + 2, j:j + 2]
        return float(q[0, 0] * (1 - a) * (1 - b) + q[0, 1] * a * (1 - b) + q[1, 0] * (1 - a) * b + q[1, 1] * a * b)

def dem_grid(lat, lon, cache):
    """GLO-30 elevation at every (lat, lon) of a grid (any shape), across as many tiles as it touches."""
    lat = np.asarray(lat, float); lon = np.asarray(lon, float)
    out = np.full(lat.shape, np.nan)
    keys = set(zip(np.floor(lat).astype(int).ravel().tolist(), np.floor(lon).astype(int).ravel().tolist()))
    os.makedirs(cache, exist_ok=True)
    for la, lo in keys:
        try: t = Tile(tile_name(la + 0.5, lo + 0.5), cache)
        except Exception: continue                       # ocean tiles do not exist in GLO-30
        m = (np.floor(lat) == la) & (np.floor(lon) == lo)
        out[m] = t.sample_many(lat[m], lon[m])
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--index', default='data/glaciers/glaciers.json')
    ap.add_argument('--out', default='data/glaciers/elevation.json')
    ap.add_argument('--cache', default='scripts/.cache/glo30')
    a = ap.parse_args()
    os.makedirs(a.cache, exist_ok=True)
    idx = json.load(open(a.index))
    tiles, out = {}, {}
    for g in idx['glaciers']:
        fl = g['flowline']; z = []
        for la, lo in zip(fl['lat'], fl['lon']):
            n = tile_name(la, lo)
            if n not in tiles: tiles[n] = Tile(n, a.cache)
            z.append(tiles[n].sample(la, lo))
        z = [None if not math.isfinite(v) else round(v, 1) for v in z]
        fin = [v for v in z if v is not None]
        out[g['id']] = dict(z_m=z, zmin=min(fin) if fin else None, zmax=max(fin) if fin else None,
                            tiles=sorted({tile_name(la, lo) for la, lo in zip(fl['lat'], fl['lon'])}))
        print(g['id'].ljust(15), f"{out[g['id']]['zmin']}–{out[g['id']]['zmax']} m", flush=True)
    json.dump(dict(format='glacier-watch-elev-v1', source='Copernicus DEM GLO-30 (copernicus-dem-30m S3), bilinear at the flowline points',
                   epoch='TanDEM-X acquisitions 2011–2015 (surface has thinned since on fast-changing tongues)',
                   citation='Copernicus DEM GLO-30 © DLR e.V. 2010–2014 and © Airbus 2014–2018, provided under COPERNICUS by the EU and ESA',
                   glaciers=out), open(a.out, 'w'), separators=(',', ':'))

if __name__ == '__main__':
    main()
