#!/usr/bin/env node
/**
 * scripts/build-glacier-massbalance.mjs — Glacier Watch's observed mass-balance record.
 *
 * Bakes data/glaciers/massbalance.json from the World Glacier Monitoring Service
 * glaciological series (winter / summer / annual balance, mm w.e. → m w.e.) for the
 * Glacier Watch glaciers that HAVE a field programme. Source: the WGMS
 * Fluctuations-of-Glaciers extracts that OGGM mirrors for its reference glaciers
 * (github.com/OGGM/oggm-sample-data, wgms/mbdata/mbdata_WGMS-NNNNN.csv + the
 * WGMS↔RGI link table), sha256-pinned below. wgms.ch is egress-blocked from the
 * build sandbox, which is why the mirror — the same reason the Volcanoes baker
 * uses GitHub copies of GVP's exports.
 *
 * TWO RELEASES, ONE CALIBRATION PER GLACIER (2026-11-08). OGGM's extract is the
 * 2022 FoG release (series end 2018–2020, winter + summer + annual). The CURRENT
 * release, WGMS FoG 2026-02-10 (doi:10.5904/wgms-fog-2026-02-10, years to 2025),
 * reaches us as the first five columns of its data/mass_balance.csv (country,
 * glacier_name, glacier_id, year, annual_balance — m w.e.), copied whole into
 * github.com/ledpup/ClimateExplorer's test fixtures (8 944 rows, the release's own
 * count, per that repo's design note), commit- and sha256-pinned below. WGMS
 * REVISES old years between releases — the four USGS benchmark glaciers were
 * recalibrated over their whole record (Gulkana 54 of 55 years moved, up to
 * 0.36 m w.e.) — so 2021–2025 are NOT appended to the 2022 values: `mergeRelease`
 * takes the ANNUAL balance from the newer release wherever it has the year, keeps
 * the 2022 winter/summer split ONLY for years whose annual is unchanged
 * (≤ 0.005 m w.e.), and WITHHOLDS the split for revised years (it would no
 * longer add up to the annual). Years only in the older copy keep it (`src`).
 * A glacier the newer copy lacks (Zongo) keeps the 2022 series and its printed
 * gap. Great Aletsch's glaciological series is 1940–1999 + 2020–2025: the gap
 * between is WGMS's, and is printed, never filled. Khumbu, Columbia, Perito Moreno and Sermeq
 * Kujalleq — and Helheim, Thwaites, Pine Island, Hubbard, Baltoro, Breiðamerkurjökull — have NO
 * glaciological series (calving / debris / ice-sheet) and get
 * `null` — geodetic estimates come later (GLACIER_WATCH_PLAN.md §3.2).
 *
 * Usage: node scripts/build-glacier-massbalance.mjs [--check]
 *   --check  re-download, verify hashes and that the committed JSON is identical.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = 'https://raw.githubusercontent.com/OGGM/oggm-sample-data/master/wgms';
const OUT = new URL('../data/glaciers/massbalance.json', import.meta.url);

// Glacier Watch id → WGMS id (from rgi_wgms_links_20220112.csv; the "COLUMBIA (2057)"
// in that table is a different glacier, in Washington — ours has no field series).
const SERIES = {
    gulkana:         { wgms: 90,   sha256: 'eae9a4a3c2ae3ccff49b131cb171701a849ea99fa175515fe4441bb09c437324' },
    'south-cascade': { wgms: 205,  sha256: '75a873c607b20c8e6aba118a71613504fde5b47571a478a482f1bc279b7eeece' },
    peyto:           { wgms: 57,   sha256: '311c65d35e0a9b7efe0566c0d1503a7cf4ee9fe2839cf7a0e01b7ea3363e2961' },
    aletsch:         { wgms: 360,  sha256: 'a029e2173df6b56febbb6f20020d50d2616e5f70f2b6485a44ce5eb57fd146c6' },
    storglaciaren:   { wgms: 332,  sha256: '74479691e88e2c0c0116e10342f3936da10d6158f4fd20e14076697f068ae12c' },
    zongo:           { wgms: 1503, sha256: '589b647af2819d567811db82b78b318284b6c657fe2f775e7c5d5e22c8476c98' },
    hintereisferner: { wgms: 491,  sha256: '702abba89146d4ff53f89295321e17e72d4a44d699f7a11a828243f25817e9f8' },
    rhone:           { wgms: 473,  sha256: '2e655b13baaf9c11e27cc2da653a5c06e935756d0ad523f63c4d4a2e43c091df' },
    'mer-de-glace':  { wgms: 353,  sha256: '17d09c204cbcec01d2716f1746e1bdc7c342bcbf066f2cd53d5899aaf8d5075d' },
    nigardsbreen:    { wgms: 290,  sha256: 'd4341d75d255cbd655cb70fb677c25c37ceea88e8ca93cc87b8fcdc6650db6a7' },
    wolverine:       { wgms: 94,   sha256: '2f944618679d729d6e908a8505021777cd0e0e3016a067ceede575fdd5e1ada0' },
    'lemon-creek':   { wgms: 3334, sha256: 'db8ed80f6f0dcda637df446edfcefd8bcc03b26719150513c49dde1d86e8b48a' },
    'chhota-shigri': { wgms: 2921, sha256: 'db7ad353daa99959f686bf96a1025e3fb884e6ca7c40522268d57febf93084c3' },
    brewster:        { wgms: 1597, sha256: '69e055a7f437b2337bb49b58eac94204f879815dda158a8b758466075b252acc' },
    pasterze:        { wgms: 566,  sha256: '4b136b4fc91cb6bf60860acca825c4327c68df35fcb490f5a68f7fd1320f0e95' },
    // ── batch 3 (2026-11-08) ── `sha256: null` = not in OGGM's 2022 extract: annual-only, from the 2026 release
    silvretta:            { wgms: 408,  sha256: '551df5315cb2f8a5b7ea205cc2de6b234fb19ceadbe904802f9e5d7e59b4285a' },
    claridenfirn:         { wgms: 2660, sha256: '7a8185f1220738bc54644623fbd157bdc8575334da0365aed69ea52322a0781a' },
    gries:                { wgms: 359,  sha256: '613f0ed220c7fbc9883c04cb0dc5b1e16eef34e459b76f048ecd90fa23ec1d88' },
    taku:                 { wgms: 124,  sha256: 'd18bf0fc75304038d885faead72a0e7d608defd71ad0b301cbf249248ae3fa6c' },
    storbreen:            { wgms: 302,  sha256: 'a1309545758e154d2e86cd517523a72b10156f80c914e9ccfb92a5cac2481c8e' },
    engabreen:            { wgms: 298,  sha256: '2c41456ebd76011eb86c243a48e68bd0ff7dfdd2bfdec31e6216de442864a6ee' },
    'midtre-lovenbreen':  { wgms: 291,  sha256: '7428d1ee3b368849fb2ab10d38926eb28d544ea94c46b587f5b22f6a5dea280a' },
    kongsvegen:           { wgms: 1456, sha256: 'a458ec9546db3ca66d24a385755b2682e4b81b518110c816c3a7b7eff1af72c9' },
    white:                { wgms: 0,    sha256: '13195d4db982427da0375d3d81d7422df0486a6d17e54d7fefbb8d5aa3e43f0c' },
    'urumqi-no1':         { wgms: 853,  sha256: null },
    tuyuksu:              { wgms: 817,  sha256: '89e036d50701f5ffcf29a6a2a5e50f6d5b1213d05544a7bb306d99d564ef41de' },
    abramov:              { wgms: 732,  sha256: 'f3f7b54f76259909b8641b1fc64a3d7f2e62d1f6f8485ce13b08d841ff2609e0' },
    'echaurren-norte':    { wgms: 1344, sha256: 'a97011b1a4023491a323a9cba24b22e282abe4cc3e9a04a89ebc269a027f6491' },
    djankuat:             { wgms: 726,  sha256: '9f8f318c0896de5b6da81ccdbf901177e8231b8ba1cd3703f17377f8555d9d1e' },
    yala:                 { wgms: 912,  sha256: '7cf3a83b4e87a9950950cf71bd1af175ea9fe8134934ec2b620bb596f84005aa' },
    'bahia-del-diablo':   { wgms: 2665, sha256: 'fdcda3f9c6b4e3740745be2f451f95f178985d7d023a135cbea9b285ece25bd0' },
    athabasca:            { wgms: 7,    sha256: null },
};
// The current release (see header). The column subset lacks winter/summer, which is why the
// 2022 split is kept where it is still consistent.
const FOG = {
    release: 'WGMS FoG 2026-02-10',
    doi: '10.5904/wgms-fog-2026-02-10',
    url: 'https://raw.githubusercontent.com/ledpup/ClimateExplorer/1b4b428c656add148dced220d43835dda7eaceb2/ClimateExplorer.WebApi.UnitTests/GlacierFixtures/mass_balance_all_glaciers.csv',
    sha256: 'd493a48f73726f8b8169a8f0c071253db6f7cae7661be25e2dcf97e1e724560d',
};
const SAME = 0.005;   // m w.e.: the two releases agree on a year (both are given to 0.01 or finer)

const NONE = ['jakobshavn', 'columbia', 'khumbu', 'perito-moreno', 'helheim', 'thwaites', 'pine-island', 'hubbard', 'baltoro', 'breidamerkurjokull',
              'franz-josef', 'petermann', 'kangerlussuaq', 'lambert', 'malaspina', 'fedchenko'];

export function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
            else if (c === '"') q = false;
            else cell += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell); cell = '';
            if (row.length > 1 || row[0] !== '') rows.push(row);
            row = [];
        } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
}

const num = (s) => (s === undefined || String(s).trim() === '' ? null : Number(s));

export function parseSeries(text) {
    const [head, ...rows] = parseCsv(text);
    const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`missing column ${name}`); return i; };
    const iy = col('YEAR'), iw = col('WINTER_BALANCE'), is = col('SUMMER_BALANCE'), ia = col('ANNUAL_BALANCE'), iA = col('AREA'), iN = col('NAME'), iR = col('RGI_ID');
    const mwe = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v) / 1000);
    const out = rows.map(r => ({ year: Number(r[iy]), winter: mwe(num(r[iw])), summer: mwe(num(r[is])), annual: mwe(num(r[ia])), area_km2: num(r[iA]) }))
        .filter(r => Number.isFinite(r.year)).sort((a, b) => a.year - b.year);
    return { name: rows[0]?.[iN] ?? null, rgi: rows[0]?.[iR] ?? null, rows: out };
}

/** The current release's column subset → Map(glacier_id → Map(year → annual m w.e.)). */
export function parseFog(text) {
    const [head, ...rows] = parseCsv(text);
    const col = (name) => { const i = head.indexOf(name); if (i < 0) throw new Error(`missing column ${name}`); return i; };
    const ii = col('glacier_id'), iy = col('year'), ia = col('annual_balance'), iN = col('glacier_name');
    const out = new Map();
    out.names = new Map();
    for (const r of rows) {
        if (Number.isFinite(Number(r[ii])) && !out.names.has(Number(r[ii]))) out.names.set(Number(r[ii]), r[iN]);
        const a = num(r[ia]), y = Number(r[iy]), id = Number(r[ii]);
        if (a === null || !Number.isFinite(a) || !Number.isFinite(y) || !Number.isFinite(id)) continue;
        if (!out.has(id)) out.set(id, new Map());
        out.get(id).set(y, a);
    }
    return out;
}

/**
 * PURE. Older-release rows (winter/summer/annual/area) + the newer release's annual by year
 * → one series on the NEWER calibration. Each row says where its annual came from (`src`),
 * and `revised` years carry the older value (`annual_prev`) with the seasonal split withheld.
 */
export function mergeRelease(oldRows, newAnnual, { same = SAME } = {}) {
    const byYear = new Map(oldRows.map(r => [r.year, r]));
    const years = [...new Set([...byYear.keys(), ...(newAnnual ? newAnnual.keys() : [])])].sort((a, b) => a - b);
    let revised = 0, added = 0;
    const rows = years.map(y => {
        const o = byYear.get(y), n = newAnnual?.get(y);
        if (n === undefined) return o.annual === null ? { ...o } : { ...o, src: 'fog-2022' };
        if (!o || o.annual === null) { added++; return { year: y, winter: null, summer: null, annual: n, area_km2: o?.area_km2 ?? null, src: 'fog-2026' }; }
        if (Math.abs(o.annual - n) <= same) return { ...o, annual: n, src: 'fog-2026' };
        revised++;
        return { year: y, winter: null, summer: null, annual: n, area_km2: o.area_km2, src: 'fog-2026', revised: true, annual_prev: o.annual };
    });
    return { rows, revised, added };
}

async function main() {
    const check = process.argv.includes('--check');
    const glaciers = {};
    const fr = await fetch(FOG.url);
    if (!fr.ok) throw new Error(`${FOG.release} copy: HTTP ${fr.status}`);
    const fogText = await fr.text();
    const fh = createHash('sha256').update(fogText).digest('hex');
    if (fh !== FOG.sha256) throw new Error(`${FOG.release} copy: sha256 ${fh} ≠ pinned ${FOG.sha256} — review before re-pinning`);
    const fog = parseFog(fogText);
    for (const [id, s] of Object.entries(SERIES)) {
        let p = { name: fog.names.get(s.wgms) ?? null, rgi: null, rows: [] };
        if (s.sha256) {
            const file = `mbdata_WGMS-${String(s.wgms).padStart(5, '0')}.csv`;
            const r = await fetch(`${BASE}/mbdata/${file}`);
            if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
            const text = await r.text();
            const h = createHash('sha256').update(text).digest('hex');
            if (h !== s.sha256) throw new Error(`${file}: sha256 ${h} ≠ pinned ${s.sha256} — the mirror changed; review before re-pinning`);
            p = parseSeries(text);
        } else if (!fog.has(s.wgms)) throw new Error(`${id}: WGMS ${s.wgms} is in neither release`);
        const m = mergeRelease(p.rows, fog.get(s.wgms) ?? null);
        const years = m.rows.filter(q => q.annual !== null).map(q => q.year);
        glaciers[id] = { wgms_id: s.wgms, wgms_name: p.name, rgi_id: p.rgi, starts: years[0], ends: years[years.length - 1], n_years: years.length,
                         release: fog.has(s.wgms) ? FOG.release : 'WGMS FoG 2022 (OGGM extract)', revised: m.revised, added: m.added, rows: m.rows };
    }
    for (const id of NONE) glaciers[id] = null;
    const body = {
        format: 'glacier-watch-mb-v2',
        source: `World Glacier Monitoring Service, Fluctuations of Glaciers (glaciological series): annual balance from ${FOG.release} (doi:${FOG.doi}; data/mass_balance.csv column subset via github.com/ledpup/ClimateExplorer), winter/summer split from the 2022 release via OGGM oggm-sample-data wgms/mbdata`,
        citation: `WGMS (2026): Fluctuations of Glaciers Database. World Glacier Monitoring Service, Zurich, Switzerland. doi:${FOG.doi}`,
        units: 'm w.e. (metres of water equivalent over the glacier area)',
        note: 'Annual balances are the 2026 release, which revised some earlier years (USGS benchmark glaciers recalibrated over their whole record). The winter/summer split is shown only for years whose annual balance is unchanged since the 2022 release; `revised` rows carry the earlier value in annual_prev. Gaps are WGMS\'s and are not filled.',
        glaciers,
    };
    const json = JSON.stringify(body, null, 1) + '\n';
    if (check) {
        const now = readFileSync(OUT, 'utf8');
        if (now !== json) { console.error('massbalance.json drifted from its sources'); process.exit(1); }
        console.log('massbalance.json matches its pinned sources');
        return;
    }
    writeFileSync(OUT, json);
    for (const [id, g] of Object.entries(glaciers)) console.log(id.padEnd(15), g ? `${g.starts}–${g.ends} (${g.n_years} yrs, ${g.release}; ${g.added} added, ${g.revised} revised)` : 'no glaciological series');
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e.message); process.exit(1); });
