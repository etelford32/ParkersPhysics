# SGP4 verification vectors

These two files are the standard SGP4 verification set from

> D. A. Vallado, P. Crawford, R. Hujsak, T. S. Kelso,
> "Revisiting Spacetrack Report #3", AIAA 2006-6753.

- `SGP4-VER.TLE`: the 33 test TLEs. Each line 2 carries the start/stop/step
  (minutes) of its test run after column 69. Several cases are **deliberate
  failures** (decay, bad eccentricity, and 33333-33335 are the error-path
  cases).
- `tcppver.out`: the reference output of Vallado's C++ SGP4 (WGS-72, AFSPC
  operations mode) for those runs. Each case starts with `<norad> xx`, then
  one row per time: `t_min x y z vx vy vz [...]`, in km and km/s, TEME.

They are copied unmodified from the `sgp4` Python package 2.24 (Brandon
Rhodes, MIT licence), which ships them as its own test data. The same files
are published by CelesTrak with the paper.

Consumers:
- `rust-sgp4/src/lib.rs`: `cargo test` pins the kernel to them.
- `tests/sgp4-vallado.mjs`: pins the COMMITTED `js/sgp4-wasm/*.wasm` to them,
  so a stale or broken build fails even if the Rust source is right.
