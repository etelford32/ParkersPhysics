// node tests/donki-notifications.mjs — gates api/_lib/donki-notifications.js
// and the /api/donki/notifications route that uses it (fixtures, no network).
//
// After the 2026-09-30 CCMC move the route served `body: "## "` for every
// notification (26/26, Vercel preview 2026-10-11). These pin: a body that is
// only heading markers is null and never "## "; a total miss says so in a
// `note`; the text resolves from the candidate list and the route reports
// which key supplied it; the SWRC header block gives way to the Summary.
import assert from 'node:assert/strict';
import {
    BODY_CANDIDATES, BODY_MAX_CHARS, normalizeBody, extractBody, mapNotifications,
} from '../api/_lib/donki-notifications.js';

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('  ok', name); };

// The pre-move template, verbatim structure (api.nasa.gov, 2024).
const LEGACY_BODY = [
    '## NASA Goddard Space Flight Center, Space Weather Research Center ( SWRC )',
    '## Message Type: Space Weather Notification - CME (Earth-directed)',
    '##',
    '## Message Issue Date: 2024-05-10T12:34:56Z',
    '## Message ID: 20240510-AL-001',
    '##',
    '## Disclaimer:',
    '## NOAA\'s Space Weather Prediction Center is the United States Government official source for space weather forecasts.',
    '',
    '',
    '## Summary:',
    '',
    'Multiple CMEs detected beginning at 2024-05-09T09:24Z. Estimated speed: ~1100 km/s.',
    '',
    '## Notes:',
    'SCORE CME typification system: C-type.',
].join('\n');

const row = (over = {}) => ({
    messageType: 'CME', messageID: '20241010-AL-001',
    messageURL: 'https://ccmc.gsfc.nasa.gov/DONKI/view/Alert/1/1',
    messageIssueTime: '2026-10-10T12:00Z', messageBody: LEGACY_BODY, ...over,
});

await t('heading markers alone are not text', () => {
    for (const s of ['## ', '##', '## \n##\n## ', '', '   ', '#']) {
        assert.equal(normalizeBody(s), null, JSON.stringify(s));
    }
    assert.equal(normalizeBody(null), null);
    assert.equal(normalizeBody(42), null);
    assert.equal(normalizeBody({ a: 1 }), null);
});

await t('legacy SWRC template: body starts at the Summary', () => {
    const b = normalizeBody(LEGACY_BODY);
    assert.ok(b.startsWith('Multiple CMEs detected beginning at 2024-05-09T09:24Z.'), b);
    assert.ok(!b.includes('##'));
    assert.ok(!b.includes('Space Weather Research Center'));
    assert.ok(b.includes('Notes:\nSCORE CME typification system'));
});

await t('no Summary section: whole message, markers stripped', () => {
    assert.equal(normalizeBody('## Message Type: Report\n##\n## Weekly summary text here.'),
        'Message Type: Report\nWeekly summary text here.');
    // An empty Summary does not throw the rest away.
    assert.equal(normalizeBody('## Header line\n## Summary:\n##'), 'Header line\nSummary:');
});

await t('inline "Summary: text" and markdown-bold Summary heading', () => {
    assert.equal(normalizeBody('## Hdr\n## Summary: An M2 flare.'), 'An M2 flare.');
    assert.equal(normalizeBody('## Hdr\n**Summary**\n\nAn X1 flare.'), 'An X1 flare.');
});

await t('CRLF and HTML bodies', () => {
    assert.equal(normalizeBody('## Summary:\r\n\r\nLine one.\r\nLine two.'), 'Line one.\nLine two.');
    assert.equal(normalizeBody('<h2>Summary:</h2><p>Flare &amp; CME.</p><p>Second.</p>'),
        'Flare & CME.\nSecond.');
});

await t('array-of-lines bodies are joined', () => {
    assert.equal(normalizeBody(['## Summary:', 'Text A.', 'Text B.']), 'Text A.\nText B.');
});

await t('extractBody walks the candidates past an empty messageBody', () => {
    assert.equal(BODY_CANDIDATES[0], 'messageBody');
    assert.deepEqual(extractBody({ messageBody: '## ', messageText: '## Summary:\nReal text.' }),
        { text: 'Real text.', key: 'messageText' });
    assert.deepEqual(extractBody({ messageBody: '## ' }), { text: null, key: null });
    assert.deepEqual(extractBody(null), { text: null, key: null });
});

await t('mapNotifications: shape, sort, trim, self-report', () => {
    const long = '## Summary:\n' + 'x'.repeat(1000);
    const { notes, report } = mapNotifications([
        row({ messageIssueTime: '2026-10-09T00:00Z', messageID: 'old' }),
        row({ messageIssueTime: '2026-10-11T00:00Z', messageID: 'new', messageBody: long }),
        { messageType: 'FLR' },                                   // no issue time: dropped
    ], { isoTag: (s) => s.replace('Z', ':00Z') });
    assert.deepEqual(notes.map((n) => n.id), ['new', 'old']);
    assert.equal(notes[0].issue_time, '2026-10-11T00:00:00Z');
    assert.equal(notes[0].body.length, BODY_MAX_CHARS);
    assert.deepEqual(Object.keys(notes[1]), ['type', 'issue_time', 'id', 'url', 'body']);
    assert.equal(notes[1].url, 'https://ccmc.gsfc.nasa.gov/DONKI/view/Alert/1/1');
    assert.deepEqual(report.body_source, { messageBody: 2 });
    assert.equal(report.body_coverage, '2/2');
    assert.deepEqual(report.item_keys,
        ['messageBody', 'messageID', 'messageIssueTime', 'messageType', 'messageURL']);
    assert.equal(report.note, undefined);
});

await t('the measured regression: every body "## " → null + note, never "## "', () => {
    const raw = Array.from({ length: 26 }, (_, i) => row({ messageID: `m${i}`, messageBody: '## ' }));
    const { notes, report } = mapNotifications(raw);
    assert.equal(notes.length, 26);
    assert.ok(notes.every((n) => n.body === null));
    assert.equal(report.body_coverage, '0/26');
    assert.deepEqual(report.body_source, {});
    assert.match(report.note, /no message text/);
    assert.match(report.note, /url/);
});

await t('empty window: no note (nothing to be missing)', () => {
    const { notes, report } = mapNotifications([]);
    assert.equal(notes.length, 0);
    assert.equal(report.body_coverage, '0/0');
    assert.equal(report.note, undefined);
});

// ── The route end to end, with fetch stubbed (CCMC JSON, gateway HTML). ──
const realFetch = globalThis.fetch;
async function callRoute(rows) {
    globalThis.fetch = async (url) => {
        const ccmc = String(url).startsWith('https://ccmc.gsfc');
        const text = ccmc ? JSON.stringify(rows) : '<html><body>Announcements</body></html>';
        return { ok: true, status: 200, text: async () => text,
            headers: { get: () => (ccmc ? 'application/json' : 'text/html') } };
    };
    try {
        const { default: handler } = await import('../api/donki/notifications.js');
        const res = await handler(new Request('https://x.test/api/donki/notifications'));
        return { status: res.status, body: await res.json() };
    } finally {
        globalThis.fetch = realFetch;
    }
}

await t('route: real text flows through with the self-report', async () => {
    const { status, body } = await callRoute([row()]);
    assert.equal(status, 200);
    assert.equal(body.upstream, 'ccmc');
    assert.equal(body.body_coverage, '1/1');
    assert.deepEqual(body.body_source, { messageBody: 1 });
    assert.ok(Array.isArray(body.item_keys));
    const n = body.data.notifications[0];
    assert.ok(n.body.startsWith('Multiple CMEs detected'), n.body);
    assert.equal(n.type, 'CME');
});

await t('route: "## " bodies ship as null with a note', async () => {
    const { status, body } = await callRoute([row({ messageBody: '## ' })]);
    assert.equal(status, 200);
    assert.equal(body.data.notifications[0].body, null);
    assert.match(body.note, /no message text/);
    assert.ok(!JSON.stringify(body).includes('"## "'));
});

console.log(`donki-notifications: ${pass} passed`);
