# jsfive 0.4.0 (vendored)

`jsfive-0.4.0.mjs` is the UNMODIFIED `dist/esm/index.mjs` of the npm package
[jsfive@0.4.0](https://www.npmjs.com/package/jsfive) — a pure-JavaScript, read-only HDF5
reader. Glacier Watch uses it in `api/glaciers/velocity.js` to read NASA ITS_LIVE
velocity granules (NetCDF4 = HDF5) without Python in production.

sha256: `36731427f64b529ddba9ee152f67e61dba8573bfd3f291b9bb6ed84b91b1e1d2`

Vendored rather than added to `package.json`, matching `README-supabase-js.md`: no build step,
one auditable file, importable by both the browser and Vercel functions.

## Licences

jsfive is in the public domain. It is based in large part on the pyfive library
(https://github.com/jjhelmus/pyfive), Copyright (c) 2016 Jonathan J. Helmus, All rights
reserved, distributed under the BSD 3-Clause licence.
