// tests/fixtures/neo-catalog-synthetic.mjs — a SYNTHETIC /api/neo/catalog body
// for the homepage's nearest-NEO widget gate (tests/home-neo-top10.spec.js).
// JPL is egress-blocked from CI, so the body is COMPOSED by the same pure
// library the route uses (api/_lib/neo-sources.js), with objects PLANTED at
// known geocentric distances from the page's own Earth ephemeris — so the
// ranking assertions hold on whatever date the suite runs. Nothing here is a
// real observation except the three named orbits, which are illustrative.
import { parseSbdbQuery, composeCatalogResponse } from '../../api/_lib/neo-sources.js';
import { earthHelioJ2000, LD_AU } from '../../js/neo-space.js';
import { R2D } from '../../js/neo-orbits.js';

export const jdNow = () => Date.now() / 86400e3 + 2440587.5;

/** A circular J2000 orbit passing `au` from Earth's CURRENT position, out of the ecliptic (+north). */
export function plantedElements(des, au, nowJd) {
    const e = earthHelioJ2000(nowJd);
    const r = Math.hypot(e.x, e.y);
    const lon = Math.atan2(e.y, e.x) * R2D;
    const i = Math.asin(Math.min(0.9, au / r)) * R2D;
    return { des, a: r, i, om: ((lon - 90) % 360 + 360) % 360, epoch: nowJd };
}

/** The planted set: distances in LD, nearest first by construction. */
export const PLANTED = Object.freeze([
    { des: 'NEAR-2LD', ld: 2, H: 25.0 },
    { des: 'NEAR-3LD', ld: 3, H: 24.0 },
    { des: 'NEAR-6LD', ld: 6, H: 23.0 },
    { des: 'NEAR-12LD', ld: 12, H: 22.0 },
    { des: 'NEAR-25LD', ld: 25, H: 21.0 },
    { des: 'NEAR-40LD', ld: 40, H: 20.5 },
    { des: 'NEAR-60LD', ld: 60, H: 20.0 },
    { des: 'NEAR-90LD', ld: 90, H: 19.5 },
    { des: 'NEAR-120LD', ld: 120, H: 19.0 },
    { des: 'NEAR-150LD', ld: 150, H: 18.5 },
    { des: 'NEAR-170LD', ld: 170, H: 18.0 },     // the 11th: must NOT make the top ten
]);

export function catalogBody(nowJd = jdNow(), { tier = 'pha' } = {}) {
    const fields = ['pdes', 'full_name', 'H', 'class', 'neo', 'pha', 'e', 'a', 'q', 'i', 'om', 'w', 'ma', 'tp', 'epoch', 'moid', 'diameter'];
    const EPOCH = 2461000.5;
    const planted = (des, au, H, pha = 'N') => {
        const p = plantedElements(des, au, nowJd);
        return [p.des, `(${des})`, String(H), 'APO', 'Y', pha, '0', String(p.a), null, String(p.i), String(p.om), '0', '90', null, String(p.epoch), '.001', null];
    };
    const asteroidRows = [
        ['99942', '99942 Apophis (2004 MN4)', '19.09', 'ATE', 'Y', 'Y', '.1914', '.9224', '.7461', '3.339', '203.96', '126.68', '100.1', null, String(EPOCH), '.000258', '.340'],
        ['101955', '101955 Bennu (1999 RQ36)', '20.2', 'APO', 'Y', 'Y', '.2037', '1.1264', '.8969', '6.035', '2.06', '66.22', '220.5', null, String(EPOCH), '.0032', '.49'],
        ['433', '433 Eros (A898 PA)', '10.4', 'AMO', 'Y', 'N', '.2227', '1.458', '1.133', '10.83', '304.3', '178.9', '12.3', null, String(EPOCH), '.148', '16.8'],
        ...PLANTED.map((p, k) => planted(p.des, p.ld * LD_AU, p.H, k === 0 ? 'Y' : 'N')),
    ];
    const cometRows = [
        ['109P', '109P/Swift-Tuttle', null, 'HTC', 'Y', 'N', '.9632', '26.09', '.9595', '113.45', '139.38', '152.98', '5.1', null, String(EPOCH), '.0009', '26'],
    ];
    return composeCatalogResponse({
        tier,
        asteroids: parseSbdbQuery({ fields, data: asteroidRows }, { kind: 'a' }),
        comets: parseSbdbQuery({ fields, data: cometRows }, { kind: 'c' }),
        interstellar: { ok: false, reason: 'fixture', records: [], count: 0 },
    });
}
