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

const NONE = ['jakobshavn', 'columbia', 'khumbu', 'perito-moreno', 'helheim', 'thwaites', 'pine-island', 'hubbard', 'baltoro', 'breidamerkurjokull'];

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
    const ii = col('glacier_id'), iy = col('year'), ia = col('annual_balance');
    const out = new Map();
    for (const r of rows) {
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
        const file = `mbdata_WGMS-${String(s.wgms).padStart(5, '0')}.csv`;
        const r = await fetch(`${BASE}/mbdata/${file}`);
        if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
        const text = await r.text();
        const h = createHash('sha256').update(text).digest('hex');
        if (h !== s.sha256) throw new Error(`${file}: sha256 ${h} ≠ pinned ${s.sha256} — the mirror changed; review before re-pinning`);
        const p = parseSeries(text);
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
