// tests/cme-outlook.mjs — gates js/cme-outlook.js + the baked response table.
//
//   1. TABLE DRIFT: sample cells recomputed against the COMMITTED flux-rope
//      WASM through the same seeding must equal the baked values exactly. A
//      kernel rebuild or a donkiToPreset change fails here until
//      `node scripts/build-cme-outlook-table.mjs` is re-run.
//   2. Lookup + CDF identities.
//   3. The outlook: refusals, Poisson identity, rotation behaviour,
//      monotonicity — and an INDEPENDENT brute-force Monte Carlo of the same
//      chain that the quadrature must agree with.
//   4. Brier scoring.
//
//   node tests/cme-outlook.mjs

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadFluxRopeKernel } from '../js/flux-rope-kernel.js';
import {
    RESPONSE_GRID, buildResponseCell, responseAt, arrivalCdf, issueOutlook,
    bandRates, brierByLead, CME_ASSOCIATION, CME_SPEED,
    outlookIssueRows, resolveOutlookRow,
} from '../js/cme-outlook.js';
import { RESPONSE_CELLS } from '../js/cme-outlook-response.js';
import { regionAt } from '../js/hero-sun-model.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}
const G = RESPONSE_GRID;
const nO = G.lonDeg.length, nV = G.v0Kms.length;
const cellIdx = (ai, oi, vi) => (ai * nO + oi) * nV + vi;

// ── 1. Table drift ───────────────────────────────────────────────────────────
check('table size matches grid', RESPONSE_CELLS.length === G.latDeg.length * nO * nV,
    `${RESPONSE_CELLS.length} cells`);
{
    const wasm = await readFile(fileURLToPath(new URL('../js/flux-rope-wasm/flux_rope_core.wasm', import.meta.url)));
    const k = await loadFluxRopeKernel(wasm);
    for (const [ai, oi, vi] of [[4, 9, 2], [4, 9, 0], [5, 12, 3], [2, 4, 5], [7, 15, 1], [0, 0, 0]]) {
        const fresh = buildResponseCell(k, { lonDeg: G.lonDeg[oi], latDeg: G.latDeg[ai], v0Kms: G.v0Kms[vi] });
        const baked = RESPONSE_CELLS[cellIdx(ai, oi, vi)];
        check(`cell (lat ${G.latDeg[ai]}, lon ${G.lonDeg[oi]}, v ${G.v0Kms[vi]}) matches WASM`,
            JSON.stringify([fresh.h, fresh.g, fresh.q]) === JSON.stringify(baked),
            `fresh ${JSON.stringify([fresh.h, fresh.g, fresh.q?.[2]])} baked ${JSON.stringify([baked[0], baked[1], baked[2]?.[2]])}`);
    }
}
// Physical sanity of what the kernel says (not tuned — read off the table).
{
    const c = (lat, lon, v) => responseAt(RESPONSE_CELLS, lon, lat, v);
    check('head-on hits more than W60', c(0, 0, 1200).h > 3 * c(0, 60, 1200).h);
    check('fast CMEs arrive sooner', c(0, 0, 2400).q[2] < c(0, 0, 850).q[2]
        && c(0, 0, 850).q[2] < c(0, 0, 400).q[2]);
    check('fast CMEs are more geoeffective', c(0, 0, 2400).g > c(0, 0, 400).g);
}

// ── 2. Lookup + CDF ──────────────────────────────────────────────────────────
{
    const node = responseAt(RESPONSE_CELLS, G.lonDeg[9], G.latDeg[4], G.v0Kms[2]);
    const b = RESPONSE_CELLS[cellIdx(4, 9, 2)];
    check('lookup exact at a grid node', node.h === b[0] && node.g === b[1]
        && node.q.every((x, i) => Math.abs(x - b[2][i]) < 1e-9));
    check('no response behind the limb', responseAt(RESPONSE_CELLS, 120, 0, 900).h === 0);
    const q = [40, 48, 55, 63, 72];
    let mono = true, prev = -1;
    for (let t = 0; t < 120; t += 0.5) { const f = arrivalCdf(q, t); if (f < prev - 1e-12) mono = false; prev = f; }
    check('CDF monotone 0→1', mono && arrivalCdf(q, 0) === 0 && arrivalCdf(q, 200) === 1);
    check('CDF hits its quantiles', G.qLevels.every((l, i) => Math.abs(arrivalCdf(q, q[i]) - l) < 1e-12));
}

// ── 3. The outlook ───────────────────────────────────────────────────────────
const NOW = Date.UTC(2026, 9, 14, 6, 0, 0);
const row = (region, location, m, x, extra = {}) => ({
    region, observed_date: '2026-10-14', location, area: 300,
    m_flare_probability: m, x_flare_probability: x, ...extra,
});
const cells = RESPONSE_CELLS;

check('refuses with no regions', issueOutlook({ regionRows: [], cells, nowMs: NOW }).reason === 'no-regions');
check('refuses with no probabilities',
    issueOutlook({ regionRows: [{ region: 1, observed_date: '2026-10-14', location: 'N10W00', area: 100 }], cells, nowMs: NOW })
        .reason === 'no-probabilities');
check('refuses a mismatched table', issueOutlook({ regionRows: [row(1, 'N10W00', 50, 10)], cells: [], nowMs: NOW })
    .reason === 'response-table-mismatch');

const centre = issueOutlook({ regionRows: [row(14321, 'N12E05', 60, 15)], cells, nowMs: NOW });
check('centre region: outlook issued', centre.ok && centre.days.length === 7);
check('Poisson identity', centre.days.every((d) => Math.abs(d.pArrival - (1 - Math.exp(-d.expected))) < 2e-4));
check('day 0 small (transit lag)', centre.days[0].pArrival < centre.days[2].pArrival,
    centre.days.map((d) => d.pArrival.toFixed(3)).join(' '));
check('later days flagged lower bound', centre.days.slice(3).every((d) => d.lowerBound) && !centre.days[0].lowerBound);
check('top region attributed', centre.days[2].topRegions[0].region === '14321');

// Rotation: a W60 region rotates off; an E80 region rotates on.
{
    const west = issueOutlook({ regionRows: [row(1, 'N12W60', 60, 15)], cells, nowMs: NOW });
    const east = issueOutlook({ regionRows: [row(2, 'N12E80', 60, 15)], cells, nowMs: NOW });
    const w = west.days.map((d) => d.expected), e = east.days.map((d) => d.expected);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const c = centre.days.map((d) => d.expected);
    // A W60 region is past the geoeffective band and rotates behind the limb
    // in ~2 days: its whole-horizon contribution is a small fraction of the
    // same region at central meridian (late days carry its slow CMEs' tail).
    check('western region contributes little (rotating off)', sum(w) < 0.15 * sum(c),
        `W60 ${sum(w).toFixed(3)} vs centre ${sum(c).toFixed(3)}`);
    check('eastern region grows as it rotates on', e[6] > e[1], e.map((x) => x.toFixed(3)).join(' '));
}
// Monotone in the flare probability; X matters more than M per unit rate.
{
    const lo = issueOutlook({ regionRows: [row(1, 'N12E05', 20, 0)], cells, nowMs: NOW });
    const hi = issueOutlook({ regionRows: [row(1, 'N12E05', 60, 0)], cells, nowMs: NOW });
    check('more flare probability ⇒ more outlook', hi.days[3].expected > lo.days[3].expected);
    const rM = bandRates({ pM: 0.3, pX: 0 }), rX = bandRates({ pM: 0.3, pX: 0.3 });
    check('band split: X rate carved out of M', rX.M === 0 && rX.X > 0 && rM.M > 0);
    check('p = 1 refuses rather than exploding', bandRates({ pM: 1, pX: 0 }) === null);
}

// Independent brute force: sample flares (Poisson, constant rate), bands,
// speeds (log-normal), hit (Bernoulli h), arrival (inverse CDF of the same
// quantiles) and count arrivals per day. Same chain, no quadrature, no
// launch-step midpoint rule — must agree with the outlook's expected counts.
{
    let seed = 12345;
    const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
    const reg = { region: '9', latDeg: 12, lonDeg: -20, anchorMs: Date.parse('2026-10-14T00:00:00Z') };
    const rates = bandRates({ pM: 0.6, pX: 0.15 });
    const day0 = Date.UTC(2026, 9, 14);
    const horizonEnd = day0 + 7 * 86400e3;
    const counts = new Array(7).fill(0);
    const trials = 6000;
    const invCdf = (q, u) => { let lo = -50, hi = 400; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (arrivalCdf(q, m) < u) lo = m; else hi = m; } return (lo + hi) / 2; };
    for (let t = 0; t < trials; t++) {
        for (const band of ['M', 'X']) {
            const lam = rates[band] * CME_ASSOCIATION[band] * (horizonEnd - NOW) / 86400e3;
            // Poisson count by inversion.
            let n = 0, p = Math.exp(-lam), s = p; const u = rnd();
            while (u > s) { n++; p *= lam / n; s += p; }
            for (let j = 0; j < n; j++) {
                const tf = NOW + rnd() * (horizonEnd - NOW);
                const pos = regionAt(reg, tf);
                const v = CME_SPEED[band].medianKms * Math.exp(CME_SPEED[band].sigLn * gauss());
                const r = responseAt(cells, pos.lonDeg, pos.latDeg, v);
                if (!r.q || rnd() >= r.h) continue;
                const arr = tf + (20.5 * 695700 / v) * 1000 + invCdf(r.q, rnd()) * 3600e3;
                const d = Math.floor((arr - day0) / 86400e3);
                if (d >= 0 && d < 7 && arr >= NOW) counts[d]++;
            }
        }
    }
    const mc = counts.map((c) => c / trials);
    const out = issueOutlook({ regionRows: [{ region: 9, observed_date: '2026-10-14', location: 'N12E20', area: 300, m_flare_probability: 60, x_flare_probability: 15 }], cells, nowMs: NOW });
    const ex = out.days.map((d) => d.expected);
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    check('brute force agrees on total (±5 %)', Math.abs(sum(mc) - sum(ex)) / sum(ex) < 0.05,
        `MC ${sum(mc).toFixed(3)} vs quadrature ${sum(ex).toFixed(3)}`);
    const worst = Math.max(...ex.map((x, i) => Math.abs(x - mc[i])));
    check('brute force agrees per day (abs ≤ 0.03)', worst <= 0.03,
        `MC ${mc.map((x) => x.toFixed(3)).join(' ')} | Q ${ex.map((x) => x.toFixed(3)).join(' ')}`);
}

// ── 4. Brier ─────────────────────────────────────────────────────────────────
{
    const rows = [
        { lead_days: 1, p: 0.8, obs: true }, { lead_days: 1, p: 0.2, obs: false },
        { lead_days: 2, p: 0.5, obs: true }, { lead_days: 2, p: 0.5, obs: null },
    ];
    const b = brierByLead(rows, 0.1);
    check('Brier per lead', Math.abs(b[0].brier - 0.04) < 1e-12 && b[0].n === 2);
    check('climatology reference + BSS', Math.abs(b[0].brierClim - (0.81 + 0.01) / 2) < 1e-12
        && Math.abs(b[0].bss - (1 - 0.04 / 0.41)) < 1e-12);
    check('unresolved rows skipped', b[1].n === 1);
}

// ── 5. Ledger rows + resolution ──────────────────────────────────────────────
{
    const rows = outlookIssueRows(centre);
    check('seven rows, one issue day', rows.length === 7 && new Set(rows.map((r) => r.issue_day)).size === 1
        && rows[0].issue_day === '2026-10-14' && rows[6].valid_day === '2026-10-20');
    check('inputs only on lead 0', rows[0].inputs?.regions?.length === 1 && rows.slice(1).every((r) => r.inputs === null));
    check('refused outlook ⇒ no rows', outlookIssueRows({ ok: false }).length === 0);

    const base = { validDay: '2026-10-16', issuedAt: '2026-10-14T06:30:00Z' };
    const day = Date.parse('2026-10-16T00:00:00Z');
    const late = day + 5 * 86400e3;
    check('too early ⇒ pending', resolveOutlookRow({ ...base, nowMs: day + 86400e3, coverage: 1 }).status === 'pending');
    check('quiet day with coverage ⇒ NO', (() => {
        const r = resolveOutlookRow({ ...base, nowMs: late, coverage: 0.9 });
        return r.status === 'resolved' && r.obsArrival === false && r.obsGeo === false;
    })());
    check('quiet day with an L1 gap ⇒ pending, not NO',
        resolveOutlookRow({ ...base, nowMs: late, coverage: 0.3 }).note === 'l1-coverage-gap');
    const arr = (launchIso, bz) => ({ shockMs: day + 10 * 3600e3, launchMs: Date.parse(launchIso), minBzNt: bz });
    check('arrival of a CME launched BEFORE issue does not count',
        resolveOutlookRow({ ...base, nowMs: late, coverage: 0.9, arrivals: [arr('2026-10-13T00:00:00Z', -20)] }).obsArrival === false);
    check('arrival launched after issue, Bz −15 ⇒ YES / geo YES', (() => {
        const r = resolveOutlookRow({ ...base, nowMs: late, arrivals: [arr('2026-10-14T12:00:00Z', -15)] });
        return r.obsArrival === true && r.obsGeo === true;
    })());
    check('arrival with Bz −4 ⇒ geo NO', resolveOutlookRow({ ...base, nowMs: late, arrivals: [arr('2026-10-14T12:00:00Z', -4)] }).obsGeo === false);
    check('arrival with Bz pending waits', resolveOutlookRow({ ...base, nowMs: late, arrivals: [arr('2026-10-14T12:00:00Z', null)] }).note === 'bz-pending');
    check('…then closes with geo unknown', (() => {
        const r = resolveOutlookRow({ ...base, nowMs: day + 12 * 86400e3, arrivals: [arr('2026-10-14T12:00:00Z', null)] });
        return r.status === 'resolved' && r.obsArrival === true && r.obsGeo === null;
    })());
}

// ── 6. Today's REAL Sun (production relay snapshot, 2026-10-14) ──────────────
{
    const { readFileSync } = await import('node:fs');
    const { normalizeSolarRegions } = await import('../api/_lib/noaa-regions.js');
    const fx = JSON.parse(readFileSync(new URL('./fixtures/noaa-solar-regions-2026-10-14.json', import.meta.url), 'utf8'));
    const real = issueOutlook({ regionRows: normalizeSolarRegions(fx.rows).regions, cells: RESPONSE_CELLS,
        nowMs: Date.parse('2026-10-14T18:00:00Z') });
    check('real snapshot: outlook issued from 10 regions', real.ok && real.coverage.regionsUsable === 10);
    // AR 4551 (S15E07, BGD, M 25 % / X 10 %) is rotating INTO the
    // geoeffective band, so the outlook must grow over days 1–4 and name it.
    // Mirrored longitudes (the pre-fix relay) put it at W07 rotating out.
    check('real snapshot: rises as AR 4551 rotates in', real.days[4].pArrival > real.days[1].pArrival
        && real.days[4].topRegions[0].region === '4551',
        real.days.map((d) => d.pArrival.toFixed(3)).join(' '));
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\ncme-outlook: all checks passed');
