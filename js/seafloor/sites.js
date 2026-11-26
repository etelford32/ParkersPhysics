/**
 * sites.js — the ONE list of sea-floor sites (trenches, deeps, sill-isolated basins, abyssal plains).
 *
 * PURE data. `lat`/`lon` are only the CENTRE OF THE SEARCH WINDOW: the deepest point of each
 * site is FOUND in the baked bathymetry grid by scripts/build-seafloor-bathymetry.py and written
 * to data/seafloor/index.json — nothing on the page reads a depth from this file.
 *
 * `published` is the commonly quoted maximum depth (m), written FROM MEMORY of the literature
 * (Stewart & Jamieson 2019 "The five deeps"; Gardner et al. 2014 for Challenger Deep; GEBCO
 * gazetteer) with no access to the papers at build time — every row is `verified: false` and the
 * page prints it only as "commonly quoted", beside the grid's own value. Checking a row against
 * its source and flipping the flag is real work; correct the number when you do.
 *
 * `kind`:  trench | fracture (transform/fracture-zone deep) | basin (sill-isolated deep basin) |
 *          plain (abyssal plain — the ordinary deep sea floor, the control for the trenches)
 */
export const SEAFLOOR_SITES = Object.freeze([
    { id: 'mariana',        name: 'Mariana Trench',          deep: 'Challenger Deep',   ocean: 'Pacific',  kind: 'trench',   lat: 11.35,  lon: 142.40,  published: 10925 },
    { id: 'tonga',          name: 'Tonga Trench',            deep: 'Horizon Deep',      ocean: 'Pacific',  kind: 'trench',   lat: -23.25, lon: -174.75, published: 10820 },
    { id: 'philippine',     name: 'Philippine Trench',       deep: 'Emden Deep',        ocean: 'Pacific',  kind: 'trench',   lat: 10.30,  lon: 126.65,  published: 10540 },
    { id: 'kuril',          name: 'Kuril–Kamchatka Trench',  deep: null,                ocean: 'Pacific',  kind: 'trench',   lat: 44.20,  lon: 150.40,  published: 9600 },
    { id: 'kermadec',       name: 'Kermadec Trench',         deep: 'Scholl Deep',       ocean: 'Pacific',  kind: 'trench',   lat: -31.90, lon: -177.30, published: 10050 },
    { id: 'izu-bonin',      name: 'Izu–Ogasawara Trench',    deep: null,                ocean: 'Pacific',  kind: 'trench',   lat: 29.80,  lon: 142.70,  published: 9780 },
    { id: 'japan',          name: 'Japan Trench',            deep: null,                ocean: 'Pacific',  kind: 'trench',   lat: 38.60,  lon: 144.10,  published: 8410 },
    { id: 'yap',            name: 'Yap Trench',              deep: null,                ocean: 'Pacific',  kind: 'trench',   lat: 8.50,   lon: 137.90,  published: 8530 },
    { id: 'new-britain',    name: 'New Britain Trench',      deep: 'Planet Deep',       ocean: 'Pacific',  kind: 'trench',   lat: -6.50,  lon: 153.50,  published: 9140 },
    { id: 'ryukyu',         name: 'Ryukyu Trench',           deep: null,                ocean: 'Pacific',  kind: 'trench',   lat: 25.00,  lon: 128.20,  published: 7460 },
    { id: 'aleutian',       name: 'Aleutian Trench',         deep: null,                ocean: 'Pacific',  kind: 'trench',   lat: 51.00,  lon: -178.00, published: 7680 },
    { id: 'atacama',        name: 'Peru–Chile Trench',       deep: 'Richards Deep',     ocean: 'Pacific',  kind: 'trench',   lat: -23.40, lon: -71.40,  published: 8065 },
    { id: 'middle-america', name: 'Middle America Trench',   deep: null,                ocean: 'Pacific',  kind: 'trench',   lat: 14.00,  lon: -93.60,   published: 6670 },
    { id: 'puerto-rico',    name: 'Puerto Rico Trench',      deep: 'Brownson Deep',     ocean: 'Atlantic', kind: 'trench',   lat: 19.80,  lon: -66.60,  published: 8380 },
    { id: 'south-sandwich', name: 'South Sandwich Trench',   deep: 'Meteor Deep',       ocean: 'Atlantic', kind: 'trench',   lat: -55.80, lon: -25.60,  published: 8265 },
    { id: 'cayman',         name: 'Cayman Trough',           deep: null,                ocean: 'Atlantic', kind: 'fracture', lat: 19.00,  lon: -80.50,  published: 7690 },
    { id: 'romanche',       name: 'Romanche Fracture Zone',  deep: 'Vema Deep',         ocean: 'Atlantic', kind: 'fracture', lat: -0.20,  lon: -18.40,  published: 7760 },
    { id: 'java',           name: 'Java (Sunda) Trench',     deep: null,                ocean: 'Indian',   kind: 'trench',   lat: -11.10, lon: 114.90,  published: 7190 },
    { id: 'diamantina',     name: 'Diamantina Fracture Zone', deep: 'Dordrecht Deep',   ocean: 'Indian',   kind: 'fracture', lat: -33.50, lon: 101.40,  published: 7020 },
    { id: 'banda',          name: 'Banda Sea',               deep: 'Weber Deep',        ocean: 'Pacific',  kind: 'basin',    lat: -5.80,  lon: 131.00,  published: 7350 },
    { id: 'sulu',           name: 'Sulu Sea',                deep: null,                ocean: 'Pacific',  kind: 'basin',    lat: 8.30,   lon: 120.60,  published: 5580 },
    { id: 'hellenic',       name: 'Hellenic Trench',         deep: 'Calypso Deep',      ocean: 'Mediterranean', kind: 'trench', lat: 36.40, lon: 21.40, published: 5110 },
    { id: 'molloy',         name: 'Fram Strait',             deep: 'Molloy Deep',       ocean: 'Arctic',   kind: 'fracture', lat: 79.10,  lon: 2.80,    published: 5550 },
    { id: 'sohm',           name: 'Sohm Abyssal Plain',      deep: null,                ocean: 'Atlantic', kind: 'plain',    lat: 36.00,  lon: -55.00,  published: null },
    { id: 'argentine',      name: 'Argentine Abyssal Plain', deep: null,                ocean: 'Atlantic', kind: 'plain',    lat: -46.00, lon: -48.00,  published: null },
    { id: 'weddell',        name: 'Weddell Abyssal Plain',   deep: null,                ocean: 'Southern', kind: 'plain',    lat: -65.00, lon: -25.00,  published: null },
    { id: 'ne-pacific',     name: 'Northeast Pacific Basin', deep: null,                ocean: 'Pacific',  kind: 'plain',    lat: 30.00,  lon: -150.00, published: null },
    { id: 'wharton',        name: 'Wharton Basin',           deep: null,                ocean: 'Indian',   kind: 'plain',    lat: -20.00, lon: 100.00,  published: null },
].map((s) => Object.freeze({ ...s, verified: false })));

export const SITE_KINDS = Object.freeze({
    trench:   'Subduction trench',
    fracture: 'Fracture-zone / transform deep',
    basin:    'Sill-isolated deep basin',
    plain:    'Abyssal plain',
});

/** Half-width of every baked window, degrees of latitude (longitude half-width = this / cos φ, capped). */
export const WINDOW_HALF_DEG = 2;
/** Baked grid step, arc-minutes. The ocean in the source tiles is ETOPO1 (1′) — never bake finer. */
export const GRID_ARCMIN = 1;
