/**
 * temperature-lab-page.js — controller for temperature-lab.html
 * (PLANETARY_TEMPERATURE_LAB_PLAN.md §5). Wires the four pieces and owns
 * nothing else:
 *
 *   feed    js/temperature-lab-feed.js     /api/temperature/snapshot → event
 *   panel   js/temperature-lab-panel.js    the DOM
 *   access  js/temperature-lab-access.js   teaser / free / intro ladder
 *   place   js/home-conditions.js          the SAME fetch + buildTempModel the
 *                                          homepage's Temperature tab uses, so
 *                                          the 30-day calendar is one engine
 *                                          (js/temp-outlook.js projectDays)
 *
 * The place is the shared current view (`ppx_user_location`, written by
 * saveUserLocation and announced as 'user-location-changed') — never a second
 * store. Before the visitor picks one, the browser time zone's city stands in
 * and the card says so (the homepage's tzGuessLocation).
 *
 * Gates open on REACH, never on load (plan §7.3): every locked control calls
 * onLocked, and the gate it opens is chosen by the visitor's rung
 * (gateFor). A free-gate email submit unlocks the free rung live.
 *
 * `window.__tempLab` exposes { panel, feed, access } for the browser gate.
 */

import { auth } from './auth.js';
import { telemetry } from './telemetry.js';
import { openGate, hasProvisionalAccount, consumeResume } from './gate-modal.js';
import { createAccessController, gateFor } from './temperature-lab-access.js';
import { startTemperatureLabFeed, EVENT } from './temperature-lab-feed.js';
import { mountTemperatureLab } from './temperature-lab-panel.js';
import { REGION_NAMES } from './geo-regions.js';
import { loadUserLocation, saveUserLocation, geocodeQuery } from './user-location.js';
import { fetchConditions, fetchClimate, buildTempModel, tzGuessLocation } from './home-conditions.js';

const UNIT_KEY = 'tl_unit';     // a per-viewer convenience, nothing more

function initialUnit() {
    try {
        const saved = localStorage.getItem(UNIT_KEY);
        if (saved === 'C' || saved === 'F') return saved;
    } catch (_) { /* private mode */ }
    try {
        // °F where it is the everyday unit (US + territories, Liberia), °C elsewhere.
        const region = new Intl.Locale(navigator.language || 'en').maximize().region;
        return ['US', 'PR', 'GU', 'VI', 'AS', 'MP', 'LR'].includes(region) ? 'F' : 'C';
    } catch (_) { return 'C'; }
}

const track = (action, meta = {}) => {
    try { telemetry.recordFeature('temp_lab', action, meta); } catch (_) { /* best effort */ }
};

export function bootTemperatureLab(host) {
    let access = null;
    let placeSeq = 0;
    let feed = null;

    const panel = mountTemperatureLab(host, {
        variant: 'page',
        unit: initialUnit(),
        regions: REGION_NAMES,
        onLocked(want) {
            const key = gateFor(access?.access ?? 'teaser', want);
            if (!key) return;
            openGate(key, {
                resume: 'temperature-lab',
                onUnlock: () => { access?.unlockFree(); },
            });
        },
        onFilter(q) { feed?.setQuery(q); },
        onUnit(u) { try { localStorage.setItem(UNIT_KEY, u); } catch (_) { /* fine */ } track('unit', { unit: u }); },
        onRow(row) {
            const map = host.querySelector('[data-tl="mapwrap"]');
            const r = map?.getBoundingClientRect();
            if (r && (r.bottom < 60 || r.top > window.innerHeight)) map.scrollIntoView({ behavior: 'smooth', block: 'center' });
        },
        async onPlaceQuery(q) {
            try {
                const found = await geocodeQuery(q);
                saveUserLocation(found);       // fires user-location-changed → loadPlace
            } catch (err) {
                panel.setPlace({ loc: currentLoc, status: 'error', error: err?.message || 'place not found', temp: lastTemp });
            }
        },
        onAction: track,
    });

    access = createAccessController({
        auth, hasProvisional: hasProvisionalAccount, target: document.body,
        onChange: (a, limits) => { panel.setAccess(a, limits); },
    });
    access.refresh();
    auth.ready?.().then(() => {
        access.refresh();
        try { consumeResume(access.access === 'intro' ? 'temp-lab-outlook-30day' : 'temp-lab-scorecards'); } catch (_) {}
    }).catch(() => {});
    window.addEventListener('auth-changed', () => access.refresh());

    window.addEventListener(EVENT, (e) => panel.render(e.detail));
    feed = startTemperatureLabFeed();

    // ── your place ──────────────────────────────────────────────────────────
    let currentLoc = null, lastTemp = null;
    async function loadPlace(loc) {
        const mine = ++placeSeq;
        currentLoc = loc;
        lastTemp = null;
        if (!loc) { panel.setPlace(null); return; }
        panel.setPlace({ loc, status: 'loading' });
        let wx = null;
        try { wx = (await fetchConditions(loc)).wx; } catch (_) { wx = null; }
        if (mine !== placeSeq) return;
        if (!wx) { panel.setPlace({ loc, status: 'error', error: 'forecast unreachable' }); return; }
        lastTemp = buildTempModel(wx, null);
        panel.setPlace({ loc, status: 'ready', temp: lastTemp });
        // The archive (≈3 years of dailies) gives the week its departures and
        // the calendar its normals; it is the slow half, so it lands second.
        try {
            const climate = await fetchClimate(loc);
            if (mine !== placeSeq) return;
            lastTemp = buildTempModel(wx, climate);
            panel.setPlace({ loc, status: 'ready', temp: lastTemp });
        } catch (_) { /* the week still shows; departures stay "—" */ }
    }
    const guess = () => {
        try { return tzGuessLocation(Intl.DateTimeFormat().resolvedOptions().timeZone); } catch (_) { return null; }
    };
    loadPlace(loadUserLocation() ?? guess());
    window.addEventListener('user-location-changed', (e) => loadPlace(e.detail ?? loadUserLocation() ?? guess()));

    track('open', { access: access.access });
    window.__tempLab = { panel, feed, access };
    return window.__tempLab;
}
