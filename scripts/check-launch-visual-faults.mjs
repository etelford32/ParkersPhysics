/** Prove the pixel gate rejects three visual faults, not unrelated boot errors. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const cases = [
    ['smoke', 'falcon9-launch-tplus3'],
    ['lighting', 'shuttle-desktop-threequarter'],
    ['bloom', 'starship-desktop-engines'],
];
const summary = [];
for (const [fault, scene] of cases) {
    const output = join(root, 'validation-output/launch-visual', `fault-${fault}`);
    mkdirSync(output, { recursive: true });
    const run = spawnSync(process.execPath, [
        join(root, 'node_modules/@playwright/test/cli.js'), 'test',
        '--config=playwright.launch-visual.config.js', '--grep', scene,
    ], {
        cwd: root, encoding: 'utf8', timeout: 240_000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LAUNCH_VISUAL_FAULT: fault, LAUNCH_VISUAL_OUTPUT_DIR: output },
    });
    writeFileSync(join(output, 'run.log'), (run.stdout || '') + (run.stderr || ''));
    assert.ifError(run.error);
    assert.equal(run.status, 1, `${fault}: the screenshot comparison must fail`);
    const report = JSON.parse(readFileSync(join(output, 'results.json'), 'utf8'));
    const results = [];
    function walk(suite) {
        for (const spec of suite.specs || []) for (const test of spec.tests) results.push(...test.results);
        for (const child of suite.suites || []) walk(child);
    }
    report.suites.forEach(walk);
    assert.equal(results.length, 1, `${fault}: exactly one executed result, no retries`);
    const result = results[0];
    assert.equal(result.status, 'failed');
    assert.match(result.error?.message || '', /toHaveScreenshot/);
    assert(result.attachments.some(a => a.name.endsWith('-diff.png')), `${fault}: a real pixel diff is required`);
    const item = { fault, scene, detected: true, durationMs: result.duration, report: `${output}/report/index.html` };
    summary.push(item);
    console.log(`Detected ${fault} regression (${scene}); expected / actual / diff saved.`);
}
writeFileSync(join(root, 'validation-output/launch-visual/fault-summary.json'), JSON.stringify(summary, null, 2) + '\n');
