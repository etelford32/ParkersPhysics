# Earth-interior test oracles — provenance

Both files are copied BYTE-FOR-BYTE from PyPI wheels. They are test oracles,
independent of the kernels' own transcriptions. Never hand-edit them; if a
pin changes, re-extract from the wheel and update this file.

| File | Extracted from | Wheel sha256 | File sha256 |
|---|---|---|---|
| `prem.nd` | `obspy-1.5.2-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl`, path `obspy/taup/data/prem.nd` | `9df9ea5e39efb59930868f18916e8987d3d75d78abed0b70d3cc3d21d619c4a8` | `efd8960973133957f14fad0f98e993e0e9236b045d20dda6be61e4bb73917f45` |
| `Earth_conductivity.dat` | `chaosmagpy-0.16-py3-none-any.whl`, path `chaosmagpy/lib/Earth_conductivity.dat` | `3132122b4516d85a4dee4481007976f5f71901a23c08bf31a2ee33580931364f` | `d3c593176edcaf8e4def3ba69cbfd7e22e2bf82898adf58f95463f1cbdc556ed` |

`prem.nd` is ObsPy's TauP node table of isotropic PREM (Dziewonski &
Anderson 1981) WITHOUT the 3 km ocean: the upper crust runs to the surface.
Its columns are depth (km), Vp, Vs (km/s), ρ (g/cm³), Qα, Qβ. ObsPy is
LGPL-3.0; the numbers are PREM's published values, and the file is used only
by `tests/earth-interior-prem.mjs`, never shipped to the browser.

`Earth_conductivity.dat` is the 1-D mantle conductivity of Grayver et al.
(2017, GRL 44:6074, doi:10.1002/2017GL073446) as distributed with
ChaosMagPy (MIT). Its columns are depth to the TOP of each layer (km) and
σ (S/m); the first layer is the 7 kS ocean conductance spread over 1 km, and
the last (2900 km) is the core.
