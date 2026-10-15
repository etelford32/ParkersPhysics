/**
 * tests/public-test.mjs — gate for the public-test sign-up rules.
 *
 * Run: node tests/public-test.mjs
 *
 * js/public-test.js has two copies it must agree with, and a mismatch in
 * either fails SILENTLY in production:
 *   - supabase-public-test-signup-migration.sql: the trigger whitelists
 *     personas / fleet sizes and decides the plan. A persona the page
 *     offers but the trigger does not know is stored as NULL with no error.
 *   - pricing.html: prints the post-test prices. A price that drifts from
 *     PRICES promises a number checkout will not charge.
 * Plus the safety rule the whole feature rests on: the client never sends,
 * and the trigger never reads, `plan` or `role`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    PUBLIC_TEST, PRICES, PERSONAS, PERSONA_IDS, FLEET_SIZES,
    planFamily, personaFamily, isOperatorPersona, familyFromParams,
    normalizeSignupMeta, monthlyLabel,
} from '../js/public-test.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };
const eq = (a, b, msg) => check(JSON.stringify(a) === JSON.stringify(b), `${msg}: got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/* ── 1. Plan families: six stored ids fold into two public plans ─────── */
eq(planFamily('basic'), 'intro', 'basic → intro');
eq(planFamily('educator'), 'intro', 'educator → intro');
eq(planFamily('advanced'), 'advanced', 'advanced → advanced');
eq(planFamily('institution'), 'advanced', 'institution → advanced');
eq(planFamily('enterprise'), 'advanced', 'enterprise → advanced');
for (const p of ['free', 'tester', '', null, 'bogus']) eq(planFamily(p), null, `planFamily(${p})`);

/* ── 2. URL → family (new ?tier= and every legacy ?plan= link) ───────── */
const P = (q) => new URLSearchParams(q);
eq(familyFromParams(P('tier=intro')), 'intro', '?tier=intro');
eq(familyFromParams(P('tier=advanced')), 'advanced', '?tier=advanced');
eq(familyFromParams(P('plan=basic-annual')), 'intro', '?plan=basic-annual');
eq(familyFromParams(P('plan=auroracle')), 'intro', '?plan=auroracle');
eq(familyFromParams(P('plan=intro')), 'intro', '?plan=intro (legacy invite alias)');
eq(familyFromParams(P('plan=institution')), 'advanced', '?plan=institution');
eq(familyFromParams(P('plan=free')), null, '?plan=free');
eq(familyFromParams(P('tier=bogus&plan=advanced')), 'advanced', 'unknown tier falls back to plan');
eq(familyFromParams(null), null, 'null params');

/* ── 3. Metadata whitelist: plan/role never leave the page ───────────── */
const hostile = normalizeSignupMeta({
    persona: 'operator', org_name: '  Orbit   Ops ', fleet_size: '2-10',
    tester_updates: true, plan: 'enterprise', role: 'superadmin',
});
eq(hostile, { persona: 'operator', org_name: 'Orbit Ops', fleet_size: '2-10', tester_updates: true },
    'operator meta keeps only whitelisted keys');
check(!('plan' in hostile) && !('role' in hostile), 'plan/role must be stripped');
eq(normalizeSignupMeta({ persona: 'teacher', org_name: 'School', fleet_size: '1' }),
    { persona: 'teacher', tester_updates: false }, 'non-operator persona drops org + fleet');
eq(normalizeSignupMeta({ persona: 'wizard', fleet_size: 'lots' }), { tester_updates: false }, 'unknown persona dropped');
eq(normalizeSignupMeta({ persona: 'operator', fleet_size: '1000+' }), { persona: 'operator', tester_updates: false }, 'unknown fleet bucket dropped');
eq(normalizeSignupMeta({ persona: 'operator', org_name: 'x'.repeat(300) }).org_name.length, 120, 'org_name capped at 120');
eq(normalizeSignupMeta({ tester_updates: 'true' }).tester_updates, false, 'tester_updates must be a real boolean');

/* ── 4. Personas ─────────────────────────────────────────────────────── */
eq(PERSONA_IDS.length, new Set(PERSONA_IDS).size, 'persona ids unique');
check(PERSONAS.every(p => p.family === 'intro' || p.family === 'advanced'), 'every persona maps to a plan family');
check(isOperatorPersona('operator') && isOperatorPersona('mission_planner'), 'operator personas');
check(!isOperatorPersona('analyst') && personaFamily('nope') === null, 'non-operator personas');

/* ── 5. Lockstep with the migration (the trigger is the enforcer) ────── */
const sql = read('supabase-public-test-signup-migration.sql');
const fn = sql.slice(sql.indexOf('FUNCTION public.handle_new_user'), sql.indexOf('$$;', sql.indexOf('FUNCTION public.handle_new_user')));
check(fn.length > 0, 'handle_new_user body not found in migration');
check(!/->>\s*'plan'/.test(fn), "trigger must NEVER read ->>'plan' from client metadata");
check(!/->>\s*'role'/.test(fn), "trigger must NEVER read ->>'role' from client metadata");
const sqlList = (s) => s.split(',').map(x => x.trim().replace(/^'|'$/g, ''));
const personaChecks = [...sql.matchAll(/\('learner'[^)]*\)/g)].map(m => sqlList(m[0].slice(1, -1)));
check(personaChecks.length >= 2, 'expected the persona list in both the CHECK and the trigger');
for (const list of personaChecks) eq(list, [...PERSONA_IDS], 'SQL persona list == PERSONA_IDS');
const fleetChecks = [...sql.matchAll(/\('1','2-10'[^)]*\)/g)].map(m => sqlList(m[0].slice(1, -1)));
check(fleetChecks.length >= 2, 'expected the fleet list in both the CHECK and the trigger');
for (const list of fleetChecks) eq(list, [...FLEET_SIZES], 'SQL fleet list == FLEET_SIZES');
const opList = fn.match(/NOT IN \('operator','mission_planner'\)/);
eq(!!opList, true, 'trigger operator-persona list present');
eq(PERSONAS.filter(p => p.family === 'advanced').map(p => p.id), ['operator', 'mission_planner'], 'operator personas == trigger list');
const sqlTest = sql.match(/FUNCTION public\.public_test_active\(\)[\s\S]*?AS \$\$ SELECT (true|false) \$\$/);
check(!!sqlTest, 'public_test_active() not found');
if (sqlTest) eq(sqlTest[1] === 'true', PUBLIC_TEST, 'public_test_active() == PUBLIC_TEST');

/* ── 6. Prices printed on pricing.html == PRICES ─────────────────────── */
const pricing = read('pricing.html');
for (const fam of ['intro', 'advanced']) {
    const m = pricing.match(new RegExp(`data-price="${fam}">([^<]+)<`));
    check(!!m, `pricing.html: no data-price="${fam}" element`);
    if (m) eq(m[1], monthlyLabel(fam), `pricing.html ${fam} price`);
}
check(pricing.includes(`$${PRICES.intro.yearlyUsd}/yr`), 'pricing.html must show the Intro yearly price');
check(!/data-checkout=/.test(pricing.replace(/\/\/.*$/gm, '')) || !PUBLIC_TEST,
    'no checkout buttons on pricing.html while the public test runs');
eq(monthlyLabel('intro'), '$9.99/mo', 'monthlyLabel intro');
eq(monthlyLabel('advanced'), '$100/mo', 'monthlyLabel advanced');

/* ── 7. auth.js forwards ONLY the persona keys ───────────────────────── */
const authSrc = read('js/auth.js');
const keyLine = authSrc.match(/for \(const k of \[([^\]]+)\]\)/);
check(!!keyLine, 'auth.signUp meta key list not found');
if (keyLine) eq(sqlList(keyLine[1].replace(/'/g, '')), ['persona', 'org_name', 'fleet_size', 'tester_updates'], 'auth.signUp forwarded keys');

if (fail.length) {
    console.error(`✗ public-test: ${fail.length} failure(s)`);
    for (const f of fail) console.error('  - ' + f);
    process.exit(1);
}
console.log('✓ public-test: plan families, URL mapping, metadata whitelist, SQL + pricing lockstep');
