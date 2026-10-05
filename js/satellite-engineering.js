/**
 * satellite-engineering.js — the Design Bay's engineering review
 * ════════════════════════════════════════════════════════════════════════════
 *
 * PURE. Takes a build + an orbit and returns the subsystem budgets a real
 * design review walks through, plus a list of PASS / WARN / FAIL checks:
 *
 *   mass        itemised by subsystem (massBreakdown — the flight model's own
 *               dry mass, not a second estimate)
 *   power       sunlit generation vs orbit-average load through eclipse;
 *               battery depth of discharge per orbit
 *   thermal     single-node hot / cold equilibrium, radiator sizing
 *   comms       downlink rate per radio (link budget at 10° elevation),
 *               contact time per ground station, data generated per day
 *   ADCS        aero / gravity-gradient / solar-pressure / magnetic
 *               disturbance torques → momentum per orbit vs the wheels;
 *               30° slew time; thrust-misalignment torque from the CG offset
 *   propulsion  tank capacity, Δv, drag make-up per year, natural decay
 *               lifetime and the 5-yr (FCC 2022) / 25-yr (IADC) disposal rules
 *
 * Every model is a stated first-order approximation (SMAD-style closed
 * forms), named where it is used. The flight model is 2-D and does not fly
 * eclipses or temperatures — this review is where those consequences live.
 * Density is INJECTED (`rhoAt(altKm)`) so this module never re-implements the
 * thermosphere: the page passes satellite-designer-engine.airDensity, which
 * is the site's ONE density model at the current F10.7 / Ap.
 */

import { BODIES, PAYLOADS, THRUSTER_UNITS, faceArea, deriveDesign } from './satellite-builder.js';
import {
    SUBSYSTEMS, SUBSYSTEM_ORDER, EXTRAS, FINISHES, BATTERIES, ADCS_UNITS, OBC_UNITS,
    MLI_EPS_STAR, OSR, BODY_CELL, payloadScale, propellantFor, bodyClass,
} from './satellite-components.js';
import { layoutBuild, massProperties } from './satellite-layout.js';

export const MU = 3.986004418e14;
export const R_E = 6_371_000;
export const G0 = 9.80665;
const SIGMA = 5.670374e-8;
const YEAR_S = 3.15576e7;
const K_DB = 228.6;              // −10·log10(Boltzmann)

// ── Orbit geometry ───────────────────────────────────────────────────────────
/** Circular orbit at altitude h (km). Eclipse at β = 0 (the worst case). */
export function orbitGeometry(altKm) {
    const r = R_E + altKm * 1000;
    const periodS = 2 * Math.PI * Math.sqrt(r ** 3 / MU);
    const eclipseFrac = Math.asin(R_E / r) / Math.PI;
    return { r, altKm, periodS, vMs: Math.sqrt(MU / r), eclipseFrac,
             eclipseS: eclipseFrac * periodS, sunS: (1 - eclipseFrac) * periodS,
             earthViewF: (1 - Math.sqrt(1 - (R_E / r) ** 2)) / 2 };
}

/** Slant range (m) to a ground station at elevation `elDeg`. */
export function slantRange(altKm, elDeg = 10) {
    const r = R_E + altKm * 1000, e = elDeg * Math.PI / 180;
    return Math.sqrt(r * r - (R_E * Math.cos(e)) ** 2) - R_E * Math.sin(e);
}

/** Ground-station G/T (dB/K) assumed per band — a typical commercial station. */
export const GROUND_GT = { UHF: -14, S: 13, X: 29, Ka: 39 };
const LINK_LOSSES_DB = { UHF: 3, S: 3, X: 3, Ka: 6 };   // pointing, polarisation, atmosphere/rain
const EBN0_REQ_DB = 4.0;     // coded (LDPC-class) at BER 1e-6
const LINK_MARGIN_DB = 3.0;

/** Antenna gain (dBi) from a parabolic diameter (η = 0.6). */
export function dishGainDbi(D, fHz) {
    const lambda = 2.998e8 / fHz;
    return 10 * Math.log10(0.6 * (Math.PI * D / lambda) ** 2);
}

/**
 * Downlink budget for one radio at a slant range. Returns the achievable
 * information rate (bps) — capped at the modem ceiling — and the C/N0.
 */
export function linkBudget(x, rangeM) {
    const lambda = 2.998e8 / x.f;
    const g = x.dishD ? dishGainDbi(x.dishD, x.f) : x.gainDbi;
    const eirp = 10 * Math.log10(x.txW) + g;
    const fspl = 20 * Math.log10(4 * Math.PI * rangeM / lambda);
    const cn0 = eirp - fspl - (LINK_LOSSES_DB[x.band] ?? 3) + (GROUND_GT[x.band] ?? 0) + K_DB;
    const rateDb = cn0 - EBN0_REQ_DB - LINK_MARGIN_DB;
    const raw = 10 ** (rateDb / 10);
    return { gainDbi: g, eirpDbw: eirp, fsplDb: fspl, cn0, rawBps: raw, rateBps: Math.min(raw, x.maxBps) };
}

/**
 * Daily contact with ONE mid-latitude (55°) station at ≥10° elevation:
 * passes/day from the swath fraction of the latitude circle the ground track
 * crosses twice a revolution; mean pass = 70 % of an overhead pass.
 */
export function stationContact(altKm, elDeg = 10, latDeg = 55) {
    const g = orbitGeometry(altKm);
    const e = elDeg * Math.PI / 180;
    const lam = Math.acos(R_E * Math.cos(e) / g.r) - e;          // Earth central half-angle
    const revs = 86400 / g.periodS;
    const passes = Math.min(revs, revs * 2 * (2 * lam) / (2 * Math.PI * Math.cos(latDeg * Math.PI / 180)));
    const maxPassS = 2 * lam / (2 * Math.PI / g.periodS);
    return { passesPerDay: passes, maxPassS, contactSPerDay: passes * maxPassS * 0.7, halfAngleRad: lam };
}

/**
 * Natural decay lifetime (years) from altKm to 150 km for a circular orbit:
 * da/dt = −ρ·(Cd·A/m)·√(μ a), integrated in 5 km steps with the injected
 * density held at the current space weather. Capped at `capYr`.
 */
export function decayLifetimeYears(altKm, cdA_over_m, rhoAt, capYr = 1000) {
    if (!(cdA_over_m > 0) || typeof rhoAt !== 'function') return capYr;
    let t = 0;
    for (let h = altKm; h > 150; h -= 5) {
        const hm = h - 2.5;
        const a = R_E + hm * 1000;
        const rho = Math.max(1e-20, rhoAt(hm));
        const dadt = rho * cdA_over_m * Math.sqrt(MU * a);           // m/s
        t += 5000 / dadt;
        if (t / YEAR_S > capYr) return capYr;
    }
    return t / YEAR_S;
}

/** Δv (m/s) to drop a circular orbit's perigee to `toKm` (one burn). */
export function deorbitDv(altKm, toKm = 200) {
    if (altKm <= toKm) return 0;
    const r = R_E + altKm * 1000, rp = R_E + toKm * 1000;
    return Math.sqrt(MU / r) - Math.sqrt(MU * (2 / r - 2 / (r + rp)));
}

// ── Thermal (single node) ───────────────────────────────────────────────────
/**
 * Surfaces of the bus as { area, alpha, eps, sunlit } groups. Radiators sit on
 * ±Y and are assumed sun-avoiding (no direct solar term) — the standard
 * placement; everything else sees the orientation-averaged Sun (A/4).
 */
export function thermalSurfaces(rb, radiatorFrac = rb.radiator) {
    const body = BODIES[rb.body];
    const fin = FINISHES[rb.finish];
    const skin = fin.mli
        ? { alpha: MLI_EPS_STAR * fin.alpha / fin.eps, eps: MLI_EPS_STAR }
        : { alpha: fin.alpha, eps: fin.eps };
    const cellEff = { alpha: BODY_CELL.alpha - BODY_CELL.eta, eps: BODY_CELL.eps };
    const out = [];
    for (const f of ['+X', '-X', '+Y', '-Y', '+Z', '-Z']) {
        const A = faceArea(body, f);
        const radA = (f === '+Y' || f === '-Y') ? A * radiatorFrac : 0;
        const rest = A - radA;
        if (radA > 0) out.push({ kind: 'radiator', area: radA, ...OSR, sunlit: false });
        if (rb.bodyCells.includes(f)) {
            out.push({ kind: 'cells', area: rest * BODY_CELL.packing, ...cellEff, sunlit: true });
            out.push({ kind: 'skin', area: rest * (1 - BODY_CELL.packing), ...skin, sunlit: true });
        } else {
            out.push({ kind: 'skin', area: rest, ...skin, sunlit: true });
        }
    }
    const nRad = rb.extras.filter(e => e.k === 'deploy_rad').length;
    if (nRad) out.push({ kind: 'radiator', area: nRad * EXTRAS.deploy_rad.radArea, ...OSR, sunlit: false });
    return out;
}

/**
 * Orbit-average equilibrium temperature (K) of the node. A bus has hours of
 * thermal time constant, so it never reaches the 35-minute eclipse's own
 * steady state — the standard hot / cold cases are ORBIT AVERAGES:
 *   hot  = high β (no eclipse), summer Sun, max dissipation
 *   cold = β = 0 (max eclipse), winter Sun, min dissipation
 * `sunFrac` is the sunlit fraction of the orbit.
 */
export function nodeTemp(surfs, qInt, { S, albedo, ir, F, sunFrac }) {
    let qAbs = 0, epsA = 0;
    for (const s of surfs) {
        if (s.sunlit) qAbs += s.alpha * S * sunFrac * s.area / 4;
        qAbs += s.alpha * albedo * S * F * s.area * 0.5 * sunFrac;   // albedo ~ half the lit orbit
        qAbs += s.eps * ir * F * s.area;
        epsA += s.eps * s.area;
    }
    return { T: ((qInt + qAbs) / (SIGMA * Math.max(epsA, 1e-6))) ** 0.25, qAbs, epsA };
}
const HOT = { S: 1414, albedo: 0.35, ir: 258 };
const COLD = { S: 1322, albedo: 0.25, ir: 218 };
export const T_MIN_K = 263.15;    // −10 °C: survival heaters hold the node here
export const T_TARGET_K = 298.15; // +25 °C: radiator sizing target

/** Orbit-average payload duty — imagers and SAR switch on over targets. */
export const PAYLOAD_DUTY = { optical_cam: 0.25, wide_imager: 0.25, sar_radar: 0.12,
                              commsat_dish: 1, phased_array: 1, mass_driver: 0.05, none: 0 };

// ── The review ───────────────────────────────────────────────────────────────
/**
 * @param {object} build   bay build (auto slots allowed)
 * @param {object} opts    { presets, tierMods, altKm, rhoAt(altKm) }
 */
export function reviewDesign(build, opts = {}) {
    const altKm = Math.max(120, +opts.altKm || 400);
    const d = deriveDesign(build, opts.presets || null, opts.tierMods || null);
    const rb = d.resolved;
    const body = BODIES[rb.body];
    const pl = PAYLOADS[rb.payload];
    const plS = d.payloadScale;
    const lay = layoutBuild(rb, opts.tierMods || null);
    const orbit = orbitGeometry(altKm);
    const fuel = rb.fuelKg;
    const wet = d.dryMass + fuel;
    const checks = [];
    const chk = (area, id, sev, title, detail) => checks.push({ area, id, sev, title, detail });

    // ── Mass ──────────────────────────────────────────────────────────────
    const bySub = Object.fromEntries(SUBSYSTEM_ORDER.map(k => [k, 0]));
    for (const it of d.breakdown) bySub[it.subsystem] = (bySub[it.subsystem] || 0) + it.mass;
    const launch = bodyClass(rb.body) === 'cubesat' && wet <= 30 ? 'CubeSat dispenser'
        : wet <= 220 ? 'ESPA port (≤ 220 kg)'
        : wet <= 465 ? 'ESPA Grande (≤ 465 kg)'
        : wet <= 1500 ? 'Rideshare primary / dedicated small launcher'
        : 'Dedicated launch';
    const mass = { dry: d.dryMass, fuel, wet, bySubsystem: bySub, items: d.breakdown,
                   withMargin: d.dryMass * 1.15, launch };
    chk('mass', 'mass.launch', 'pass', `Launch class: ${launch}`,
        `${fmt(wet, 1)} kg wet. Carry a 15 % system margin at this design stage → ${fmt(d.dryMass * 1.15, 1)} kg dry.`);

    // ── Packaging (from the layout) ──────────────────────────────────────
    for (const is of lay.issues) {
        chk('layout', is.id, is.sev, is.sev === 'fail' ? 'Packaging clash' : 'Packaging', is.msg);
    }
    if (!lay.issues.some(i => i.sev === 'fail')) {
        chk('layout', 'layout.ok', 'pass', 'Everything fits',
            `${lay.parts.filter(p => p.internal && !p.hidden).length} internal units and ${rb.extras.length} external parts packed without clashes.`);
    }

    // ── Thermal → power coupling ─────────────────────────────────────────
    // Thermal runs first: the survival heaters it sizes are a power load.
    const surfs = thermalSurfaces(rb);
    const duty = PAYLOAD_DUTY[rb.payload] ?? 1;
    const payloadAvgW = d.payloadPower * duty;
    const busAvgW = d.fixedLoad - d.payloadPower + payloadAvgW;        // orbit-average electrical load
    const thrHeat = d.electric ? 0.3 * 0.45 * d.thrusterPowerW * d.powerFrac : 0;
    const commsW = rb.extras.reduce((s, e) => s + (EXTRAS[e.k].subsystem === 'comms' ? EXTRAS[e.k].powerW : 0), 0);
    const qHot = busAvgW + thrHeat;
    const qCold = d.housekeepingW + OBC_UNITS[rb.obc].powerW + ADCS_UNITS[rb.adcs].powerW + 0.3 * commsW;
    const F = orbit.earthViewF;
    const hotEnv = { ...HOT, F, sunFrac: 1 }, coldEnv = { ...COLD, F, sunFrac: 1 - orbit.eclipseFrac };
    const hot = nodeTemp(surfs, qHot, hotEnv);
    const cold = nodeTemp(surfs, qCold, coldEnv);
    const radMax = faceArea(body, '+Y') + faceArea(body, '-Y');
    const radNow = surfs.filter(s => s.kind === 'radiator').reduce((a, s) => a + s.area, 0);
    // Radiator coverage that puts the hot case at +25 °C (bisection on the
    // same node model — monotone in coverage).
    const tHot = (frac) => nodeTemp(thermalSurfaces(rb, frac), qHot, hotEnv).T;
    let radRecFrac = null;
    if (tHot(0) > T_TARGET_K && tHot(1) <= T_TARGET_K) {
        let lo = 0, hi = 1;
        for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (tHot(m) > T_TARGET_K) lo = m; else hi = m; }
        radRecFrac = hi;
    } else if (tHot(0) <= T_TARGET_K) radRecFrac = 0;
    const hotC = hot.T - 273.15, coldC = cold.T - 273.15;
    // Survival heaters: whatever it takes to hold the cold case at −10 °C.
    const heaterW = cold.T < T_MIN_K
        ? Math.max(0, SIGMA * cold.epsA * T_MIN_K ** 4 - cold.qAbs - qCold) : 0;
    const bat = BATTERIES[rb.battery];
    const thermal = { hotC, coldC, radAreaM2: radNow, radMaxM2: radMax, radRecFrac,
                      qHotW: qHot, qColdW: qCold, heaterW, surfaces: surfs };

    // ── Power ────────────────────────────────────────────────────────────
    const loadSun = busAvgW + heaterW;
    const loadEcl = busAvgW + heaterW;
    const eta = 0.85;                         // battery round-trip
    const requiredSun = loadSun + loadEcl * orbit.eclipseS / (orbit.sunS * eta);
    const margin = d.power - requiredSun;
    const dod = loadEcl * orbit.eclipseS / 3600 / bat.wh;
    const power = { genSunW: d.power, wingW: d.wingPower, cellW: d.cellPower, loadSunW: loadSun,
                    payloadDuty: duty, payloadAvgW, busAvgW,
                    loadEclW: loadEcl, heaterW, requiredSunW: requiredSun, marginW: margin,
                    marginFrac: margin / Math.max(requiredSun, 1e-9), orbitAvgGenW: d.power * (1 - orbit.eclipseFrac),
                    batteryWh: bat.wh, dod, thrusterW: d.thrusterPowerW, powerFrac: d.powerFrac };
    if (margin < 0) chk('power', 'power.balance', 'fail', 'Power-negative orbit',
        `Arrays make ${fmt(d.power, 0)} W in sunlight but the bus needs ${fmt(requiredSun, 0)} W to run ${fmt(loadSun, 0)} W and recharge for a ${fmt(orbit.eclipseS / 60, 0)} min eclipse. Add array area or cut load.`);
    else if (margin / requiredSun < 0.1) chk('power', 'power.balance', 'warn', 'Thin power margin',
        `${fmt(margin, 0)} W (${fmt(100 * margin / requiredSun, 0)} %) over the orbit-average need — aim for ≥ 10 % end-of-life margin (cells degrade 2–3 %/yr).`);
    else chk('power', 'power.balance', 'pass', 'Power-positive orbit',
        `${fmt(margin, 0)} W (${fmt(100 * margin / requiredSun, 0)} %) above the ${fmt(requiredSun, 0)} W sunlit need.`);
    const dodPct = dod * 100;
    chk('power', 'power.dod', dod > 0.6 ? 'fail' : dod > 0.3 ? 'warn' : 'pass',
        `Battery depth of discharge ${fmt(dodPct, 0)} %`,
        dod > 0.6 ? `The ${bat.label} is drained ${fmt(dodPct, 0)} % every eclipse — it will not survive. Fit a bigger pack.`
        : dod > 0.3 ? `LEO Li-ion lasts ~30 000 cycles only below ~30 % DoD (≈5 yr at 15 orbits/day). Consider a larger pack.`
        : `${fmt(loadEcl * orbit.eclipseS / 3600, 0)} Wh drawn per ${fmt(orbit.eclipseS / 60, 0)} min eclipse from ${bat.wh} Wh.`);
    if (d.electric) {
        const eclWh = d.thrusterPowerW * d.powerFrac * orbit.eclipseS / 3600;
        chk('power', 'power.ep', d.powerFrac === 0 ? 'fail' : d.powerFrac < 1 ? 'warn' : 'pass',
            d.powerFrac === 0 ? 'Electric thruster unpowered' : d.powerFrac < 1 ? `Thruster power-starved (${fmt(100 * d.powerFrac, 0)} %)` : 'Thruster fully powered in sunlight',
            d.powerFrac === 0 ? `${fmt(d.thrusterPowerW, 0)} W needed; nothing left after the bus load.`
            : `${fmt(d.thrusterPowerW, 0)} W at rated thrust. Firing through eclipse would need ${fmt(eclWh, 0)} Wh more battery — EP spacecraft normally thrust in sunlight only.`);
    }

    // ── Thermal checks ───────────────────────────────────────────────────
    chk('thermal', 'thermal.hot', hotC > 60 ? 'fail' : hotC > 40 ? 'warn' : 'pass',
        `Hot case ${fmt(hotC, 0)} °C`,
        hotC > 40 ? `Batteries and electronics want < 40 °C. Raise radiator coverage${radRecFrac != null ? ` to ~${fmt(100 * radRecFrac, 0)} %` : ''}, add a deployable radiator, or switch to a reflective finish.`
        : `${fmt(qHot, 0)} W dissipated (orbit average), ${fmt(radNow, 2)} m² of radiator.`);
    const heatFrac = heaterW / Math.max(busAvgW, 1e-9);
    chk('thermal', 'thermal.cold', heatFrac > 0.5 ? 'fail' : heatFrac > 0.2 ? 'warn' : 'pass',
        heaterW > 0 ? `Cold case needs ${fmt(heaterW, heaterW < 10 ? 1 : 0)} W of heaters` : `Cold case ${fmt(coldC, 0)} °C`,
        heaterW > 0
          ? `Unheated, the bus would settle at ${fmt(coldC, 0)} °C. Holding −10 °C costs ${fmt(100 * heatFrac, 0)} % of the bus load (budgeted in the power line)`
            + (heatFrac > 0.2 ? `. Too much radiator for this dissipation${radRecFrac != null ? ` — ~${fmt(100 * radRecFrac, 0)} % coverage balances it` : ''}, or add MLI.` : '.')
          : 'Runs warm enough without survival heaters.');

    // ── Comms ────────────────────────────────────────────────────────────
    const range = slantRange(altKm, 10);
    const contact = stationContact(altKm);
    const links = [];
    for (const e of rb.extras) {
        const x = EXTRAS[e.k];
        if (x.subsystem !== 'comms') continue;
        if (x.link === 'crosslink') {
            links.push({ key: e.k, label: x.label, band: x.band, rateBps: x.maxBps,
                         capacityGBd: x.maxBps * 86400 * 0.5 / 8e9, crosslink: true });
        } else {
            const lb = linkBudget(x, range);
            links.push({ key: e.k, label: x.label, band: x.band, ...lb,
                         capacityGBd: lb.rateBps * contact.contactSPerDay / 8e9 });
        }
    }
    const best = links.slice().sort((a, b) => b.capacityGBd - a.capacityGBd)[0] || null;
    const dataGBd = (pl.dataGBd || 0) * plS * plS + 0.05;
    const stations = best ? Math.ceil(dataGBd / Math.max(best.capacityGBd, 1e-9)) : Infinity;
    const comms = { links, best, contact, rangeKm: range / 1000, dataGBd, stations };
    if (!links.length) chk('comms', 'comms.radio', 'fail', 'No radio',
        'Nothing on board can talk to the ground. Add at least an S-band or UHF antenna.');
    else if (best.crosslink && !links.some(l => !l.crosslink)) chk('comms', 'comms.radio', 'warn', 'Crosslink only',
        'An optical terminal needs a relay constellation; add a ground radio for commanding and safe mode.');
    else chk('comms', 'comms.radio', 'pass', `Best link: ${best.label}`,
        `${fmtRate(best.rateBps)} at 10° elevation (${fmt(range / 1000, 0)} km slant), ${fmt(contact.contactSPerDay / 60, 0)} min/day per station.`);
    if (links.length) {
        chk('comms', 'comms.volume', stations > 6 ? 'fail' : stations > 2 ? 'warn' : 'pass',
            `${fmt(dataGBd, dataGBd < 1 ? 2 : 0)} GB/day to downlink`,
            stations > 6 ? `Needs ${isFinite(stations) ? stations : '∞'} ground stations at ${fmt(best.capacityGBd, 2)} GB/day each — add a faster radio (X/Ka-band) or a laser crosslink.`
            : stations > 2 ? `Needs ${stations} ground stations at ${fmt(best.capacityGBd, 1)} GB/day each — plan a station network (KSAT / AWS Ground Station class).`
            : `One station clears ${fmt(best.capacityGBd, 1)} GB/day.`);
    }

    // ── Mass properties + ADCS ───────────────────────────────────────────
    const mpWet = massProperties(lay, fuel);
    const mpDry = massProperties(lay, 0);
    const [Imin, , Imax] = mpWet.principal;
    const ad = ADCS_UNITS[rb.adcs];
    const rho = typeof opts.rhoAt === 'function' ? opts.rhoAt(altKm) : 0;
    const v = orbit.vMs;
    const Taero = 0.5 * rho * v * v * d.cd * d.area * d.copOffset;
    const Tgg = 3 * MU / (2 * orbit.r ** 3) * Math.abs(Imax - Imin) * Math.sin(2 * 5 * Math.PI / 180);
    const Tsrp = 4.56e-6 * (d.bodyArea + d.panelArea) * 1.6 * d.copOffset;
    const Bfield = 2 * 7.96e15 / orbit.r ** 3;
    const Tmag = 1e-3 * d.dryMass * Bfield;
    const hCyc = (Tgg + Tmag) * orbit.periodS * 0.707 / 4;
    const hSec = (Taero + Tsrp) * orbit.periodS;
    const hNeed = hCyc + hSec;
    const tauDump = ad.dipole * Bfield * 0.5;           // orbit-average magnetic dump torque
    const rcsTorque = d.rcs ? d.rcsThrust * Math.max(...body.dims) / 2 : 0;
    const ctrlTorque = Math.max(ad.torque, ad.hNms === 0 ? ad.dipole * Bfield : 0) + rcsTorque;
    // 30° slew: bang-bang with a rate cap of H / I.
    const th = 30 * Math.PI / 180;
    let slewS = Infinity, peakRate = 0;
    if (ctrlTorque > 0) {
        const wMax = ad.hNms > 0 ? ad.hNms * 0.8 / Imax : Infinity;
        const tri = 2 * Math.sqrt(th * Imax / ctrlTorque);
        const wTri = ctrlTorque * tri / 2 / Imax;
        if (wTri <= wMax) { slewS = tri; peakRate = wTri; }
        else { slewS = th / wMax + wMax * Imax / ctrlTorque; peakRate = wMax; }
    }
    const fineNeed = !!(pl.fine || rb.extras.some(e => EXTRAS[e.k].kind === 'laser' || EXTRAS[e.k].kind === 'kadish'));
    const hasStar = rb.extras.some(e => e.k === 'star_tracker');
    // Thrust-axis CG offset (worst of wet and dry) → misalignment torque.
    const lat = (mp) => Math.hypot(mp.cg[0], mp.cg[1]);
    const cgLat = Math.max(lat(mpWet), lat(mpDry));
    const thrust = d.thrust || 0;
    const tThr = thrust * cgLat;
    const L = Math.abs(-body.dims[2] / 2 - mpWet.cg[2]);
    const trim = d.gimbalDeg > 0 ? thrust * L * Math.sin(d.gimbalDeg * Math.PI / 180) : 0;
    const residual = Math.max(0, tThr - trim);
    const adcs = { torques: { aero: Taero, gg: Tgg, srp: Tsrp, mag: Tmag }, Bfield, hCycNms: hCyc, hSecNms: hSec,
                   hNeedNms: hNeed, hCapNms: ad.hNms, dumpTorque: tauDump, ctrlTorque, slewS, peakRateDegS: peakRate * 180 / Math.PI,
                   fineNeed, hasStar, unit: ad.label, rho };
    const massProps = { cgWet: mpWet.cg, cgDry: mpDry.cg, cgLateralM: cgLat, I: mpWet.I, principal: mpWet.principal,
                        thrustTorque: tThr, gimbalTrim: trim, residualTorque: residual };
    if (ad.hNms > 0) {
        const sev = hNeed <= 0.8 * ad.hNms ? 'pass'
            : (tauDump >= 1.2 * (Taero + Tsrp) || d.rcs) ? 'warn' : 'fail';
        chk('adcs', 'adcs.momentum', sev,
            sev === 'pass' ? 'Wheels absorb an orbit of disturbance' : sev === 'warn' ? 'Wheels saturate within an orbit' : 'Wheels cannot hold attitude',
            `${fmtSci(hNeed)} N·m·s builds up per orbit (aero ${fmtSci(Taero)} · gravity-gradient ${fmtSci(Tgg)} · SRP ${fmtSci(Tsrp)} N·m) against ${fmtSci(ad.hNms)} N·m·s of storage.`
            + (sev === 'warn' ? ` Continuous ${d.rcs && tauDump < 1.2 * (Taero + Tsrp) ? 'RCS' : 'magnetic'} desaturation keeps up.` : '')
            + (sev === 'fail' ? ' Magnetorquers cannot dump it fast enough — fit bigger wheels or reduce the drag lever arm.' : ''));
    } else {
        const sev = ctrlTorque >= 2 * (Taero + Tgg + Tsrp + Tmag) ? 'warn' : 'fail';
        chk('adcs', 'adcs.momentum', sev, sev === 'warn' ? 'Coarse pointing only' : 'Magnetorquers overpowered',
            sev === 'warn' ? `Magnetorquers alone point to a few degrees — fine for comms, not for imaging.`
            : `${fmtSci(Taero + Tgg + Tsrp + Tmag)} N·m of disturbance vs ${fmtSci(ctrlTorque)} N·m of magnetic control. Add reaction wheels.`);
    }
    if (fineNeed) chk('adcs', 'adcs.pointing', hasStar && ad.hNms > 0 ? 'pass' : 'warn',
        hasStar && ad.hNms > 0 ? 'Fine pointing: star tracker + wheels' : 'Payload needs fine pointing',
        hasStar && ad.hNms > 0 ? 'Arc-second-class attitude knowledge supports the imager / narrow beam.'
        : `${!hasStar ? 'No star tracker — sun sensors and a magnetometer give ~1° knowledge. ' : ''}${ad.hNms === 0 ? 'Magnetorquers cannot hold a target.' : ''}`);
    if (isFinite(slewS)) chk('adcs', 'adcs.slew', 'pass', `30° slew in ${fmt(slewS, 0)} s`,
        `Peak ${fmt(peakRate * 180 / Math.PI, 2)} °/s with ${ad.label}${d.rcs ? ' + RCS' : ''}; I_max ${fmt(Imax, 1)} kg·m².`);
    if (thrust > 0) {
        const sev = residual <= 0.5 * ctrlTorque ? 'pass' : residual <= ctrlTorque ? 'warn' : 'fail';
        chk('adcs', 'adcs.thrust', sev,
            sev === 'pass' ? 'Thrust line through the CG' : sev === 'warn' ? 'Thrust torque near the control limit' : 'Engine will tumble the craft',
            `CG sits ${fmt(cgLat * 1000, 1)} mm off the thrust axis → ${fmtSci(tThr)} N·m at ${fmt(thrust, thrust < 1 ? 3 : 0)} N`
            + (trim > 0 ? `; ${fmt(d.gimbalDeg, 0)}° gimbal trims ${fmtSci(trim)} N·m` : '')
            + `. Control torque ${fmtSci(ctrlTorque)} N·m.`
            + (sev === 'fail' ? ' Re-balance: move heavy parts toward the axis or add mass opposite them.' : ''));
    }

    // ── Propulsion / lifetime / disposal ─────────────────────────────────
    const isp = d.isp || 0;
    const dv = isp > 0 && fuel > 0 ? isp * G0 * Math.log(wet / d.dryMass) : 0;
    const aDrag = 0.5 * rho * v * v * d.cd * d.area / wet;
    const dvPerYr = aDrag * YEAR_S;
    const dvDeorbit = deorbitDv(altKm);
    const lifeYr = decayLifetimeYears(altKm, d.cd * d.area / d.dryMass, opts.rhoAt);
    const capKg = d.tankCapacityKg;
    const skYr = dvPerYr > 0 ? Math.max(0, dv - (lifeYr > 5 ? dvDeorbit : 0)) / dvPerYr : Infinity;
    const prop = { capacityKg: capKg, fuelKg: fuel, fill: capKg > 0 ? fuel / capKg : Infinity,
                   propellant: d.propellant, dv, dvPerYr, dvDeorbit, lifetimeYr: lifeYr,
                   stationKeepYr: skYr, burnTimeS: thrust > 0 ? fuel * isp * G0 / thrust : Infinity,
                   ballistic: d.dryMass / (d.cd * d.area) };
    chk('propulsion', 'prop.capacity', fuel > capKg * 1.0001 ? 'fail' : 'pass',
        fuel > capKg * 1.0001 ? 'Propellant overflows the tanks' : `Tanks ${fmt(100 * fuel / Math.max(capKg, 1e-9), 0)} % full`,
        `${fmt(fuel, fuel < 10 ? 2 : 0)} kg of ${d.propellant} in ${rb.tankCount}× ${lay.parts.find(p => p.slot === 'tank')?.label} (${fmt(capKg, capKg < 10 ? 2 : 0)} kg usable).`
        + (fuel > capKg ? ' Pick bigger tanks (or Auto) or load less.' : ''));
    if (propellantFor(rb.thruster).storage === 'biprop' && rb.tankCount % 2 === 1) {
        chk('propulsion', 'prop.biprop', 'warn', 'Biprop on an odd tank count',
            'Fuel and oxidiser need separate tanks (or a common-bulkhead tank) — use an even count.');
    }
    const thrIt = THRUSTER_UNITS[rb.thruster];
    if (lifeYr <= 5) chk('propulsion', 'prop.disposal', 'pass', `Re-enters naturally in ~${fmtYr(lifeYr)}`,
        `Meets the FCC 5-year post-mission rule without a burn (density held at today's F10.7/Ap — real lifetimes average over the solar cycle).`);
    else if (dv >= dvDeorbit) chk('propulsion', 'prop.disposal', 'pass', 'Propulsive disposal available',
        `Natural decay ~${fmtYr(lifeYr)}, so keep ${fmt(dvDeorbit, 0)} m/s in reserve to drop perigee to 200 km (you carry ${fmt(dv, 0)} m/s).`);
    else if (lifeYr <= 25) chk('propulsion', 'prop.disposal', 'warn', 'Misses the FCC 5-year rule',
        `Natural decay ~${fmtYr(lifeYr)} meets the 25-year IADC guideline but not FCC 2022's 5 years; ${fmt(dvDeorbit, 0)} m/s of deorbit Δv needed, ${fmt(dv, 0)} m/s carried.`);
    else chk('propulsion', 'prop.disposal', 'fail', 'Becomes long-lived debris',
        `Natural decay ~${fmtYr(lifeYr)} and only ${fmt(dv, 0)} of the ${fmt(dvDeorbit, 0)} m/s needed to deorbit. Fly lower, add propellant, or a drag device.`);
    if (dvPerYr > 0 && dv > 0) chk('propulsion', 'prop.stationkeep', skYr < 1 ? 'warn' : 'pass',
        `Drag make-up: ${fmt(dvPerYr, dvPerYr < 10 ? 1 : 0)} m/s per year`,
        `${isFinite(skYr) ? `Propellant holds this altitude for ~${fmtYr(skYr)}` : 'Negligible drag'}${lifeYr > 5 ? ' after the deorbit reserve' : ''} with ${thrIt.label}.`);

    const counts = { pass: 0, warn: 0, fail: 0 };
    for (const c of checks) counts[c.sev]++;
    return { altKm, orbit, design: d, layout: lay, mass, power, thermal, comms, adcs, massProps, prop, checks, counts };
}

// ── formatting helpers (used in the check copy) ─────────────────────────────
function fmt(v, dp = 0) {
    if (!isFinite(v)) return '∞';
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
export function fmtSci(v) {
    if (!isFinite(v)) return '∞';
    if (v === 0) return '0';
    const e = Math.floor(Math.log10(Math.abs(v)));
    if (e >= -2 && e < 4) return v.toPrecision(2);
    return `${(v / 10 ** e).toFixed(1)}e${e}`;
}
export function fmtRate(bps) {
    if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
    if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbps`;
    if (bps >= 1e3) return `${(bps / 1e3).toFixed(1)} kbps`;
    return `${bps.toFixed(0)} bps`;
}
function fmtYr(y) {
    if (y >= 1000) return '> 1000 yr';
    if (y >= 2) return `${y.toFixed(0)} yr`;
    if (y >= 0.2) return `${y.toFixed(1)} yr`;
    return `${(y * 365.25).toFixed(0)} days`;
}
export { SUBSYSTEMS };
