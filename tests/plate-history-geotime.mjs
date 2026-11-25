/**
 * tests/plate-history-geotime.mjs — the time-scale table names times correctly (js/plate-history/geotime.js).
 * Contiguity (no gaps or overlaps inside each table), lookups at boundaries and in the middle, the
 * age labels the readout prints. The boundary VALUES are ICS v2023/09 from memory (VERIFIED is
 * false); this gate checks only that the table is internally consistent.
 *
 * Run: node tests/plate-history-geotime.mjs
 */
import { EONS, ERAS, PERIODS, LITERATURE_SUPERCONTINENTS, unitsAt, formatAge, VERIFIED } from '../js/plate-history/geotime.js';

let fails = 0;
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

for (const [name, table] of [['eons', EONS], ['eras', ERAS], ['periods', PERIODS]]) {
    let ok = table[0][2] === 0;
    for (let i = 1; i < table.length; i++) ok = ok && table[i][2] === table[i - 1][1] && table[i][1] > table[i][2];
    check(ok, `${name}: start today and tile time with no gap or overlap (${table.length} units)`);
}
check(unitsAt(0).period.name === 'Quaternary' && unitsAt(0).eon.name === 'Phanerozoic', 'today is Quaternary, Phanerozoic');
check(unitsAt(250).period.name === 'Triassic' || unitsAt(250).period.name === 'Permian', '250 Ma is at the Permian–Triassic boundary');
check(unitsAt(500).period.name === 'Cambrian', '500 Ma is Cambrian');
check(unitsAt(1450).era.name === 'Mesoproterozoic' && unitsAt(1450).period.name === 'Calymmian', '1450 Ma is Calymmian, Mesoproterozoic');
check(unitsAt(1800).period.name === 'Statherian' || unitsAt(1800).period.name === 'Orosirian', '1800 Ma is at the Statherian base');
check(formatAge(0) === 'today' && formatAge(250) === '250 Ma' && formatAge(1450) === '1.45 Ga' && formatAge(1800) === '1.8 Ga' && formatAge(2.5) === '2.5 Ma', 'age labels');
check(LITERATURE_SUPERCONTINENTS.every((s) => s.assembled > s.brokeUp && s.cite), 'literature windows are ordered and cited');
check(VERIFIED === false, 'the table still says it is unverified (flip only after checking stratigraphy.org)');

console.log(fails ? `\n${fails} FAILED` : '\nall plate-history geotime gates passed');
process.exit(fails ? 1 : 0);
