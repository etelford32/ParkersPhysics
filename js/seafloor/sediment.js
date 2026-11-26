/**
 * sediment.js — the sediment on the incoming plate, and its weight taken off. PURE.
 *
 * DATA: GlobSed (Straume et al. 2019, G-cubed, doi:10.1029/2018GC008115), total sediment thickness at 5′, baked
 * by scripts/build-seafloor-sediment.py into one window per trench site (`<id>.sed.bin.gz`, `sediment-index.json`)
 * from a sha-pinned COPY (NOAA's own hosts are egress-blocked) — read through age.js's `sampleGrid` / `profileStack`,
 * the ONE bilinear, no-data-aware sampler and the ONE line stack, so sediment and age sit under the same points.
 *
 * THE MODEL IS AIRY ISOSTASY, exactly as Zhang et al. 2018 write it (their eq. 1): a sediment column H stands
 * the sea floor higher than bare crust by
 *
 *     ΔT_iso = H · (ρ_m − ρ_s) / (ρ_m − ρ_w)
 *
 * with ρ_s = 2000, ρ_m = 3300, ρ_w = 1030 kg/m³ — their Table 1, transcribed (`SEDIMENT.verified: true`; the
 * mantle and water densities are the SAME numbers as trench-model.js `ELASTIC`, gated). Removing it ("unloading")
 * deepens each point by ΔT_iso: 0.573 m per metre of sediment. Both published trench studies do this before
 * fitting; Zhang also removes crustal-thickness changes, which this page cannot (no crustal model is baked).
 *
 * WHAT IT DOES NOT DO: one density for the whole column (real sediment compacts with depth, so a thick pile is
 * denser at its base and its true correction is SMALLER than this); local Airy isostasy, not flexural (a load
 * this broad is close to Airy, but a trench-fill wedge is not — the published studies make the same choice);
 * GlobSed itself is a compilation of seismic profiles interpolated across gaps, coarser near margins than here.
 */
import { sampleGrid, profileStack, AGE_NO_DATA } from './age.js';

/** Zhang et al. 2018 Table 1 (transcribed): densities in kg/m³. */
export const SEDIMENT = Object.freeze({ rhoSediment: 2000, rhoMantle: 3300, rhoWater: 1030, verified: true, source: 'Zhang et al. 2018, Table 1 and eq. 1' });
export const SED_NO_DATA = AGE_NO_DATA;

/** Metres the sea floor stands higher because of H metres of sediment (Airy). */
export function sedimentLift(hM, k = SEDIMENT) { return hM * (k.rhoMantle - k.rhoSediment) / (k.rhoMantle - k.rhoWater); }

/** A sediment window from its sediment-index.json entry and its decoded int16 values (whole metres). */
export function makeSedimentGrid(meta, int16) {
    if (int16.length !== meta.nx * meta.ny) throw new Error(`sediment grid ${meta.id}: ${int16.length} values for ${meta.nx}×${meta.ny}`);
    return { id: meta.id, nx: meta.nx, ny: meta.ny, north: meta.north, west: meta.west, step: meta.step_deg, q: int16 };
}
export function sampleSediment(g, lat, lon) { return sampleGrid(g, lat, lon, 1); }
/** Sediment thickness (m) under each point of a stacked profile: the mean of the same lines the depth was stacked from. */
export function profileSediment(grid, profile, opts = {}) { return profileStack(grid, profile, sampleSediment, opts); }

/**
 * A profile with the sediment's isostatic load REMOVED: each point deepened by `sedimentLift(H)`. A point with no
 * sediment value is DROPPED, never treated as zero sediment; `sedCoverage` is the share of the input's seaward
 * depth points that kept a value. Keeps every field (and the profile's geometry) so the age correction can follow.
 */
export function removeSediment(profile, sed, k = SEDIMENT) {
    if (!profile || !sed) return null;
    const withDepth = profile.filter((p) => p.depth != null && p.x >= 0).length, out = [];
    for (let i = 0; i < profile.length; i++) { const p = profile[i], h = sed[i]; if (p.depth == null || h == null) continue; out.push({ ...p, sediment: h, depth: p.depth + sedimentLift(h, k) }); }
    const sea = out.filter((p) => p.x >= 0);
    return Object.assign(out, { axisS: profile.axisS, origin: profile.origin, seaBearingDeg: profile.seaBearingDeg, axisOffsetKm: profile.axisOffsetKm,
        sedCoverage: withDepth ? sea.length / withDepth : 0, sedRange: sea.length ? [Math.min(...sea.map((p) => p.sediment)), Math.max(...sea.map((p) => p.sediment))] : null });
}
