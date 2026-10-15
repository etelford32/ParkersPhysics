// tests/cme-outlook-strip.mjs — the pure half of js/cme-outlook-strip.js.
//   node tests/cme-outlook-strip.mjs

import { outlookStripModel, formatProbability } from '../js/cme-outlook-strip.js';
import { issueOutlook } from '../js/cme-outlook.js';
import { RESPONSE_CELLS } from '../js/cme-outlook-response.js';
import { holeArrivalForecast, carringtonL0 } from '../js/ring-current-model.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

check('never prints 0%', formatProbability(0) === '<1%' && formatProbability(0.004) === '<1%');
check('lower bound prefix', formatProbability(0.12, { lowerBound: true }) === '≥12%');
check('null is a dash, not 0', formatProbability(null) === '—');

const NOW = Date.UTC(2026, 9, 14, 6);
const outlook = issueOutlook({
    regionRows: [{ region: 14321, observed_date: '2026-10-14', location: 'N12E05', area: 400,
        m_flare_probability: 60, x_flare_probability: 15 }],
    cells: RESPONSE_CELLS, nowMs: NOW,
});
// A hole ON the central meridian now: its stream (550 km/s climatology
// midpoint) reaches L1 in ~3.1 days — it must land on the day-3 cell only.
const holes = [{ lat_deg: 5, lon_carrington_deg: carringtonL0(NOW).L0 }];
const m = outlookStripModel(outlook, holeArrivalForecast(holes, NOW), NOW);
check('seven cells from today', m.ok && m.cells.length === 7 && m.cells[0].label === 'Today'
    && m.cells[0].dayMs === Date.UTC(2026, 9, 14));
check('cells carry the outlook numbers', m.cells.every((c, i) => c.pArrival === outlook.days[i].pArrival));
check('shade monotone in P', (() => {
    const s = [...m.cells].sort((a, b) => a.pArrival - b.pArrival);
    return s.every((c, i) => i === 0 || c.shade >= s[i - 1].shade);
})());
check('lower-bound days marked', m.cells.slice(3).every((c) => c.lowerBound && c.text.startsWith('≥')));
const hssDays = m.cells.filter((c) => c.hss);
check('coronal-hole stream lands on its forecast day', hssDays.length === 1 && hssDays[0].lead === 3,
    hssDays.map((c) => c.lead).join(','));
check('hole with no record is labelled climatology', hssDays.every((c) => c.hss.basis === 'climatology'));

const refused = outlookStripModel({ ok: false, reason: 'no-regions' }, null, NOW);
check('refusal: no numbers, reason kept', !refused.ok && refused.reason === 'no-regions'
    && refused.cells.every((c) => c.text === '—' && c.pArrival === null));
check('holes feed down is reported, not empty', refused.holesOk === false);

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\ncme-outlook-strip: all checks passed');
