/**
 * sky-catalog.js — SkyView's catalogue: unpack once, evaluate per instant
 * ═══════════════════════════════════════════════════════════════════════════
 * PURE except `loadSkyCatalog` (one fetch). The data file is baked by
 * scripts/build-skyview-catalog.mjs from d3-celestial (Hipparcos) and from
 * galactic-map.html's own CATALOG — read that header for provenance.
 *
 * `evaluateSky(cat, frame, opts)` is the ONE place a catalogue object becomes
 * a sky object: apparent altitude (refraction), azimuth, and the visibility
 * verdict from sky-engine. The ranked list, the chart's labels and the card
 * all read its output, so a star cannot be "up" in the list and "down" on the
 * chart.
 *
 * Galaxy-map objects are MERGED into their sky counterpart (Sirius the
 * Hipparcos star carries the map's description, distance and page link) and
 * the ones with no counterpart become LANDMARKS — drawn, never ranked. A black
 * hole 10 billion light-years away has no naked-eye magnitude, and inventing
 * one to get it into a top-10 would be the opposite of what the page is for.
 */

import {
    raDecToVec, toEnu, enuToAltAz, refractionDeg, assessVisibility,
    solarSystemObjects, limitingMagnitude, rankByVisibility, angularSeparationDeg,
    DEFAULT_SKY_QUALITY, DEFAULT_EXTINCTION_K, D2R,
} from './sky-engine.js';

export const CATALOG_URL = '/data/skyview/sky-catalog.json';

/** Stars brighter than this are rank candidates (the top 100 never reaches it). */
export const RANK_STAR_MAG = 4.5;

/** Decode the Milky Way run-length grid. */
export function decodeMilkyWay(mw) {
    const grid = new Uint8Array(mw.width * mw.height);
    let k = 0;
    for (let i = 0; i < mw.rle.length; i += 2) {
        grid.fill(mw.rle[i], k, k + mw.rle[i + 1]);
        k += mw.rle[i + 1];
    }
    if (k !== grid.length) throw new Error(`milky way grid: decoded ${k} of ${grid.length} cells`);
    return { width: mw.width, height: mw.height, levels: mw.levels, grid };
}

/** Display name for a Hipparcos star: proper name, else Bayer/Flamsteed + constellation. */
export function starLabel(names, hip) {
    const n = names[hip];
    if (!n) return `HIP ${hip}`;
    if (n[0]) return n[0];
    return n[1] ? `${n[1]} ${n[2]}` : `HIP ${hip}`;
}

/** Turn the baked JSON into the in-memory catalogue (unit vectors precomputed). */
export function unpackCatalog(json) {
    if (!json || json.version !== 1) throw new Error('sky catalogue: unsupported version');
    const s = json.stars;
    const n = s.hip.length;
    const vec = new Float64Array(n * 3);
    for (let i = 0; i < n; i++) {
        const v = raDecToVec(s.ra[i], s.dec[i]);
        vec[i * 3] = v[0]; vec[i * 3 + 1] = v[1]; vec[i * 3 + 2] = v[2];
    }
    const hipIndex = new Map(s.hip.map((h, i) => [h, i]));
    const galacticByHip = new Map();
    const galacticByDso = new Map();
    for (const g of json.galactic) {
        if (g.hip != null && !galacticByHip.has(g.hip)) galacticByHip.set(g.hip, g);
        if (g.dso != null && !galacticByDso.has(g.dso)) galacticByDso.set(g.dso, g);
    }
    const constellations = json.constellations.map((c) => ({
        ...c, labelVec: raDecToVec(c.labelRa, c.labelDec),
        lineVecs: c.lines.map((flat) => {
            const pts = [];
            for (let i = 0; i < flat.length; i += 2) pts.push(raDecToVec(flat[i], flat[i + 1]));
            return pts;
        }),
    }));
    return {
        attribution: json.attribution,
        counts: json.counts,
        stars: { ...s, n, vec },
        starNames: json.starNames,
        hipIndex,
        constellations,
        dsos: json.dsos.map((d) => ({ ...d, vec: raDecToVec(d.ra, d.dec) })),
        galactic: json.galactic.map((g) => ({ ...g, vec: raDecToVec(g.ra, g.dec) })),
        galacticByHip, galacticByDso,
        milkyWay: decodeMilkyWay(json.milkyWay),
    };
}

export async function loadSkyCatalog(url = CATALOG_URL, fetchImpl = globalThis.fetch) {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`sky catalogue: HTTP ${res.status}`);
    return unpackCatalog(await res.json());
}

/** Geometric ENU → apparent (refracted) altitude + azimuth. */
function apparent(enu, atm) {
    const { altDeg, azDeg } = enuToAltAz(enu[0], enu[1], enu[2]);
    return { trueAltDeg: altDeg, altDeg: altDeg + refractionDeg(altDeg, atm), azDeg };
}

/**
 * Everything in the sky at `frame`, assessed. Returns:
 *   env        the limiting-magnitude breakdown + Sun/Moon state
 *   objects    rankable sky objects (solar system, stars ≤ RANK_STAR_MAG, deep sky)
 *   ranked     `objects` sorted by visibility margin, with `rank`
 *   landmarks  galaxy-map objects with no naked-eye counterpart (drawn, unranked)
 *   starAlt / starAz   Float32Arrays for EVERY catalogue star (the chart's field)
 */
export function evaluateSky(cat, frame, {
    skyQuality = DEFAULT_SKY_QUALITY, k = DEFAULT_EXTINCTION_K, atm = {},
} = {}) {
    const solar = solarSystemObjects(frame);
    const sun = solar.find((o) => o.id === 'sun');
    const moon = solar.find((o) => o.id === 'moon');
    const place = (o) => Object.assign(o, apparent(toEnu(frame, raDecToVec(o.raDeg, o.decDeg)), atm));
    place(sun); place(moon);
    const lim = limitingMagnitude({
        sunAltDeg: sun.trueAltDeg, moonAltDeg: moon.altDeg,
        moonIllum: moon.illuminated, skyQuality,
    });
    const env = { ...lim, k, sunAltDeg: sun.trueAltDeg, sun, moon, skyQuality };
    const elongation = (o) => angularSeparationDeg(o.raDeg, o.decDeg, sun.raDeg, sun.decDeg);

    const objects = [];
    for (const o of solar) {
        if (o !== sun && o !== moon) place(o);
        o.key = o.id;
        if (o.kind === 'moon') o.elongationDeg = elongation(o);
        o.vis = assessVisibility(o, env);
        objects.push(o);
    }

    // Stars: every star gets a position (the chart), bright ones get a verdict.
    const S = cat.stars;
    const starAlt = new Float32Array(S.n), starAz = new Float32Array(S.n);
    for (let i = 0; i < S.n; i++) {
        const v = [S.vec[i * 3], S.vec[i * 3 + 1], S.vec[i * 3 + 2]];
        const a = apparent(toEnu(frame, v), atm);
        starAlt[i] = a.altDeg; starAz[i] = a.azDeg;
        if (S.mag[i] > RANK_STAR_MAG) continue;
        const hip = S.hip[i];
        const o = {
            key: `hip:${hip}`, id: `hip:${hip}`, hip, kind: 'star',
            name: starLabel(cat.starNames, hip),
            designation: cat.starNames[hip]?.[1] ? `${cat.starNames[hip][1]} ${cat.starNames[hip][2]}` : '',
            constellation: cat.starNames[hip]?.[2] ?? '',
            raDeg: S.ra[i], decDeg: S.dec[i], mag: S.mag[i], bv: S.bv[i],
            ...a, galactic: cat.galacticByHip.get(hip) ?? null, starIndex: i,
        };
        o.vis = assessVisibility(o, env);
        objects.push(o);
    }

    for (const d of cat.dsos) {
        const o = {
            key: `dso:${d.id}`, id: d.id, kind: d.kind, name: d.name,
            designation: [d.messier, d.desig].filter((x) => x && x !== d.name).join(' · '),
            raDeg: d.ra, decDeg: d.dec, mag: d.mag ?? NaN, dimArcmin: d.dim,
            ...apparent(toEnu(frame, d.vec), atm), galactic: cat.galacticByDso.get(d.id) ?? null,
        };
        o.elongationDeg = elongation(o);
        o.vis = assessVisibility(o, env);
        objects.push(o);
    }

    const landmarks = [];
    for (const g of cat.galactic) {
        if (g.hip != null || g.dso != null) continue;
        const o = {
            key: `gal:${g.id}`, id: g.id, kind: 'landmark', name: g.name,
            designation: g.type, raDeg: g.ra, decDeg: g.dec, mag: NaN,
            ...apparent(toEnu(frame, g.vec), atm), galactic: g,
        };
        o.vis = { status: o.altDeg > 0 ? 'nomag' : 'below', margin: -Infinity, mObs: NaN };
        landmarks.push(o);
    }

    return { env, objects, ranked: rankByVisibility(objects), landmarks, starAlt, starAz };
}

/** Apparent alt of a single J2000 position at a frame (for the rise/set sampler). */
export function apparentAltitudeOf(frame, raDeg, decDeg, atm = {}) {
    return apparent(toEnu(frame, raDecToVec(raDeg, decDeg)), atm).altDeg;
}

/** B−V colour index → display RGB (Ballesteros 2012 temperature + a blackbody fit). */
export function bvToRgb(bv) {
    const b = Number.isFinite(bv) ? Math.max(-0.4, Math.min(2.0, bv)) : 0.6;
    const T = 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
    // Tanner Helland's blackbody → sRGB fit, softened toward white (stars read
    // nearly white to the eye; full saturation looks like Christmas lights).
    const t = T / 100;
    let r, g, bl;
    if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; }
    else { r = 329.70 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); }
    if (t >= 66) bl = 255; else if (t <= 19) bl = 0; else bl = 138.52 * Math.log(t - 10) - 305.04;
    const c = (x) => Math.round(Math.max(0, Math.min(255, 0.55 * x + 0.45 * 255)));
    return [c(r), c(g), c(bl)];
}

export { D2R };
