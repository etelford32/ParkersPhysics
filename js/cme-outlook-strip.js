/**
 * js/cme-outlook-strip.js — the 7-day ERUPTION OUTLOOK strip on
 * cme-forecast.html, with the coronal-hole recurrence stream overlaid.
 *
 * Two halves:
 *   · `outlookStripModel` — PURE (node-gated by tests/cme-outlook-strip.mjs):
 *     outlook + hole forecasts → seven display cells.
 *   · `mountOutlookStrip` — the DOM. Fetches /api/noaa/regions and
 *     /api/hek/coronal-holes, issues the outlook in the browser
 *     (js/cme-outlook.js, baked response table), renders.
 *
 * THE VISUAL LANGUAGE IS DELIBERATELY NOT THE LEDGER'S (CME_OUTLOOK_PLAN.md
 * §2): no chips, no arrival times, one violet sequential shade per day,
 * labelled "eruptions that haven't happened yet". The calendar above it is
 * the issue-locked arrival ledger and nothing here writes to it.
 *
 * Three feeds fail independently and each says so: no regions feed → the
 * strip prints "unavailable" (never 0 %); no probabilities → same; no
 * coronal-hole feed → the stream row reads "coronal holes · feed down".
 *
 * The stream row is `holeArrivalForecast` (js/ring-current-model.js — the
 * NOAA-style 27-day recurrence the validation cron already scores as the
 * `recurrence` study). It is a different phenomenon from a CME and is drawn
 * as a separate row; the two are never summed into one probability.
 */

const DAY = 86400e3;

/** Display text for a probability; never prints "0 %" for a small number. */
export function formatProbability(p, { lowerBound = false } = {}) {
    if (!Number.isFinite(p)) return '—';
    const pre = lowerBound ? '≥' : '';
    if (p < 0.005) return `${pre}<1%`;
    if (p > 0.995) return `${pre}>99%`;
    return `${pre}${Math.round(p * 100)}%`;
}

/**
 * Pure: seven cells from an issued outlook (or a refusal) plus hole
 * forecasts (holeArrivalForecast output, or null when the feed is down).
 */
export function outlookStripModel(outlook, holeForecasts, nowMs) {
    const day0 = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate());
    const ok = outlook?.ok === true;
    const hss = new Map();   // dayMs → { n, vMin, vMax, record }
    if (Array.isArray(holeForecasts)) {
        for (const h of holeForecasts) {
            const f = h?.forecast;
            if (!f || !Number.isFinite(f.arriveMs)) continue;
            const d = Math.floor((f.arriveMs - day0) / DAY);
            if (d < 0 || d > 6) continue;
            const key = day0 + d * DAY;
            const v = Number.isFinite(f.vUsed) ? f.vUsed : null;
            const cur = hss.get(key) ?? { n: 0, vMin: Infinity, vMax: -Infinity, record: false };
            cur.n++;
            if (v != null) { cur.vMin = Math.min(cur.vMin, v); cur.vMax = Math.max(cur.vMax, v); }
            cur.record ||= f.basis === 'record';
            hss.set(key, cur);
        }
    }
    const cells = [];
    for (let d = 0; d < 7; d++) {
        const dayMs = day0 + d * DAY;
        const o = ok ? outlook.days.find((x) => x.dayMs === dayMs) : null;
        const s = hss.get(dayMs);
        cells.push({
            dayMs,
            lead: d,
            label: d === 0 ? 'Today' : new Date(dayMs).toUTCString().slice(0, 3),
            date: new Date(dayMs).getUTCDate(),
            pArrival: o?.pArrival ?? null,
            pGeo: o?.pGeo ?? null,
            text: o ? formatProbability(o.pArrival, { lowerBound: o.lowerBound }) : '—',
            geoText: o ? formatProbability(o.pGeo, { lowerBound: o.lowerBound }) : '—',
            lowerBound: !!o?.lowerBound,
            // Sequential shade: √ so a 5 % day is visible next to a 40 % one;
            // disclosed in the legend as "shade ∝ √P".
            shade: o ? Math.min(1, Math.sqrt(o.pArrival / 0.5)) : 0,
            topRegions: o?.topRegions ?? [],
            hss: s ? {
                n: s.n,
                text: s.record && Number.isFinite(s.vMin)
                    ? `HSS ~${Math.round((s.vMin + s.vMax) / 2)} km/s`
                    : 'HSS (clim.)',
                basis: s.record ? 'record' : 'climatology',
            } : null,
        });
    }
    return {
        ok,
        reason: ok ? null : (outlook?.reason ?? 'not-issued'),
        holesOk: Array.isArray(holeForecasts),
        regionsUsable: ok ? outlook.coverage.regionsUsable : 0,
        cells,
    };
}

const REASON_TEXT = {
    'no-regions': 'regions feed down',
    'no-probabilities': 'no SWPC flare probabilities',
    'response-table-mismatch': 'response table stale',
    'not-issued': 'loading',
};

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

function render(host, model) {
    const status = model.ok
        ? `${model.regionsUsable} visible region${model.regionsUsable === 1 ? '' : 's'} · SWPC flare odds → flux-rope kernel`
        : `unavailable · ${REASON_TEXT[model.reason] ?? model.reason}`;
    const cells = model.cells.map((c) => {
        const tip = [
            `${new Date(c.dayMs).toUTCString().slice(0, 16)} UTC`,
            model.ok ? `P(CME arrival from a new eruption): ${c.text}` : 'Outlook unavailable',
            model.ok ? `P(Bz below −10 nT): ${c.geoText}` : '',
            c.topRegions.length ? `Main source: AR ${c.topRegions.map((r) => `${r.region} (${Math.round(r.share * 100)}%)`).join(', ')}` : '',
            c.lowerBound ? 'Lower bound: regions not yet on the disc are not included.' : '',
            c.hss ? `Coronal-hole stream: ${c.hss.text}${c.hss.basis === 'climatology' ? ' — no measured record for this hole; 450–650 km/s climatology' : ' — last rotation\'s measured speed'}` : '',
        ].filter(Boolean).join('\n');
        return `<div class="cmef-ol-cell${c.lowerBound ? ' is-lb' : ''}" style="--ol-shade:${c.shade.toFixed(3)}" title="${esc(tip)}" role="listitem" aria-label="${esc(tip.replaceAll('\n', '. '))}">
            <span class="cmef-ol-day">${esc(c.label)} <small>${c.date}</small></span>
            <b class="cmef-ol-p">${esc(c.text)}</b>
            <span class="cmef-ol-geo">Bz&lt;−10 ${esc(c.geoText)}</span>
            <span class="cmef-ol-hss${c.hss ? '' : ' is-empty'}">${c.hss ? `<i aria-hidden="true">≋</i>${esc(c.hss.text)}` : ''}</span>
        </div>`;
    }).join('');
    host.innerHTML = `
        <div class="cmef-ol-head">
            <strong>Eruption outlook</strong>
            <span>P(Earth-arriving CME) from eruptions that haven't happened yet</span>
            <em>${esc(status)}${model.holesOk ? '' : ' · coronal holes · feed down'}</em>
        </div>
        <div class="cmef-ol-row" role="list">${cells}</div>
        <div class="cmef-ol-foot">Model cme-outlook-v0 · shade ∝ √P · ≥ marks lower bounds (unseen regions excluded) · ≋ coronal-hole stream (27-day recurrence, separate phenomenon) · not part of the issue-locked ledger</div>`;
}

/**
 * Mount the strip into `host`. Refreshes every `refreshMs`. Returns a
 * stop() handle. Feeds fail quietly into the honest "unavailable" states.
 */
export function mountOutlookStrip(host, { refreshMs = 30 * 60e3, fetchImpl = fetch } = {}) {
    if (!host) return () => {};
    let stopped = false;
    const getJson = (url) => fetchImpl(url, { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    async function run() {
        const nowMs = Date.now();
        const [{ issueOutlook }, { RESPONSE_CELLS }, { holeArrivalForecast }, regionsPayload, holesPayload] = await Promise.all([
            import('./cme-outlook.js'),
            import('./cme-outlook-response.js'),
            import('./ring-current-model.js'),
            getJson('/api/noaa/regions'),
            getJson('/api/hek/coronal-holes'),
        ]);
        if (stopped) return;
        const outlook = issueOutlook({
            regionRows: regionsPayload?.data?.regions ?? [], cells: RESPONSE_CELLS, nowMs,
        });
        const holes = holesPayload?.data?.holes;
        const holeFc = Array.isArray(holes) ? holeArrivalForecast(holes, nowMs) : null;
        render(host, outlookStripModel(outlook, holeFc, nowMs));
        host.dataset.state = outlook.ok ? 'ok' : outlook.reason;
    }
    render(host, outlookStripModel(null, [], Date.now()));
    run().catch((e) => {
        console.info('cme-forecast: outlook unavailable', e?.message ?? e);
        host.dataset.state = 'error';
    });
    const timer = setInterval(() => run().catch(() => {}), refreshMs);
    return () => { stopped = true; clearInterval(timer); };
}
