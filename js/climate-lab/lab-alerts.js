/**
 * climate-lab/lab-alerts.js — AL-01, the dashboard's alert console.
 * ═══════════════════════════════════════════════════════════════════════════
 * Two kinds of alert, side by side and never blurred together:
 *
 *   ACCOUNT ALERTS (left column) — the EXISTING user_profiles notify_* and
 *   threshold columns, edited in place: the same store settings.html and
 *   account.html write, read by js/alert-engine.js. No second threshold
 *   store (the threshold-profile.js rule). Saved through lab-account.js,
 *   which reports failure instead of pretending. Gated by plan exactly as
 *   the engine gates evaluation (canUseAlerts / canUseAdvancedAlerts).
 *
 *   LAB WATCHES (right column) — per-user forecast watches on the home
 *   station for the conditions no server-side alert covers (gusts, rain,
 *   UV, AQI, fog, heat, freeze). Evaluated in the browser by lab-watches.js
 *   on every station refresh; optionally a browser notification while the
 *   tab is open. Available on every plan, stored with the lab prefs.
 *
 * THE DELIVERY NOTE IS PART OF THE UI, NOT FINE PRINT. The alert engine runs
 * in the visitor's open tab; four operations alerts read the Space Weather
 * dashboard's forecast engine and only evaluate there; satellite-pass
 * alerts (`notify_sat_pass`) are a stub in the engine, so this console does
 * not offer them — the satellite tracker's in-browser pass reminders do the
 * job honestly instead. Say what happens; never imply an email that the
 * system cannot send.
 */

import { updateOwnProfile } from './lab-account.js';
import { loadPrefs, savePrefs, normalizePrefs, WATCH_KINDS, WATCH_HORIZONS, PREFS_EVENT, MAX_WATCHES } from './lab-prefs.js';
import { evaluateWatches, newlyTriggered } from './lab-watches.js';
import { resolveUnits, fmtText, fromDisplay, QUANTITIES } from './lab-units.js';
import { esc, toDisplay } from './lab-charts.js';

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const SEEN_KEY = 'pp_lab_watch_seen';

const range = (a, b, f = (v) => [v, String(v)]) => Array.from({ length: b - a + 1 }, (_, i) => f(a + i));

/** Account alert rows — column names are the live user_profiles schema. */
const ACCOUNT_ALERTS = Object.freeze([
    { col: 'notify_aurora', name: 'Aurora visible', desc: 'Kp reaches your threshold and the oval reaches your latitude after dark.',
      thr: { col: 'aurora_kp_threshold', label: 'Kp ≥', options: range(3, 9) } },
    { col: 'notify_storm', name: 'Geomagnetic storm', desc: 'NOAA G-scale storm conditions.',
      thr: { col: 'storm_g_threshold', label: 'At least', options: range(1, 5, (v) => [v, `G${v}`]) } },
    { col: 'notify_flare', name: 'Solar flare', desc: 'GOES X-ray flare class.',
      thr: { col: 'flare_class_threshold', label: 'Class ≥', options: [['C', 'C'], ['M', 'M'], ['X', 'X']] } },
    { col: 'notify_cme', name: 'Earth-directed CME', desc: 'A coronal mass ejection forecast to reach Earth, with its ETA.' },
    { col: 'notify_radio_blackout', pro: true, needsSw: true, name: 'Radio blackout', desc: 'HF fade-outs on the sunlit side.',
      thr: { col: 'radio_r_threshold', label: 'At least', options: range(1, 5, (v) => [v, `R${v}`]) } },
    { col: 'notify_gps', pro: true, needsSw: true, name: 'GPS / GNSS', desc: 'Ionospheric scintillation risk for navigation.',
      thr: { col: 'gnss_risk_threshold', label: 'Risk ≥', options: [[1, 'Moderate'], [2, 'High'], [3, 'Severe']] } },
    { col: 'notify_power_grid', pro: true, needsSw: true, name: 'Power grid', desc: 'Geomagnetically induced current risk.',
      thr: { col: 'power_grid_g_threshold', label: 'At least', options: range(2, 5, (v) => [v, `G${v}`]) } },
    { col: 'notify_iono_disturbance', pro: true, needsSw: true, name: 'Ionospheric disturbance', desc: 'Sudden ionospheric disturbances.' },
    { col: 'notify_recurrence', pro: true, name: '27-day recurrence', desc: 'A recurring coronal-hole stream is due back.' },
]);

const f2c = (f) => (f - 32) * 5 / 9;
const c2f = (c) => c * 9 / 5 + 32;

function watchQuantity(kind) {
    const q = WATCH_KINDS[kind]?.quantity;
    return q === 'pct' || q === 'index' ? null : q;
}
function watchDisplay(kind, siValue, units) {
    const q = watchQuantity(kind);
    const v = q ? toDisplay(q, siValue, units) : siValue;
    if (!isNum(v)) return '';
    const dp = q === 'temp' || q === 'wind' ? 0 : q === 'precip' ? (units.precip === 'in' ? 2 : 1) : q === 'distance' ? 1 : 0;
    return String(Number(v.toFixed(dp)));
}
function watchUnitSym(kind, units) {
    const q = watchQuantity(kind);
    if (q) {
        const Q = QUANTITIES[q];
        return (Q.units[units[q]] || Object.values(Q.units)[0]).sym;
    }
    return WATCH_KINDS[kind]?.quantity === 'pct' ? '%' : '';
}

export function mountAlertConsole({ host, auth, demo = false } = {}) {
    if (!host) throw new Error('alert console: host missing');
    const S = {
        prefs: loadPrefs(),
        units: null,
        obs: null, air: null, results: [],
        home: null,
        dirty: false,   // unsaved account edits — a background re-render must not wipe them
        seen: new Set((() => { try { return JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]'); } catch { return []; } })()),
    };
    S.units = resolveUnits(S.prefs.units, navigator.language);

    const signedIn = () => !demo && !!auth?.isSignedIn?.();
    const canAlert = () => signedIn() && !!auth?.canUseAlerts?.();
    const canPro = () => signedIn() && !!auth?.canUseAdvancedAlerts?.();

    host.innerHTML = `
    <header class="cl-module-head">
        <span class="cl-code">AL-01</span>
        <h2 class="cl-module-title" id="cl-alerts-title">Alert console</h2>
        <span class="cl-head-meta" data-role="summary"></span>
    </header>
    <div class="cl-alert-grid">
        <section class="cl-alert-col" aria-labelledby="cl-acct-h">
            <h3 class="cl-sub" id="cl-acct-h">Space weather · delivered to your account</h3>
            <div data-role="gate"></div>
            <div class="cl-alert-list" data-role="acct"></div>
            <h3 class="cl-sub">Weather · delivered to your account</h3>
            <div class="cl-alert-list" data-role="temp"></div>
            <h3 class="cl-sub">Delivery</h3>
            <div class="cl-alert-list" data-role="delivery"></div>
            <div class="cl-save-row">
                <button type="button" class="cl-btn cl-btn-accent" data-role="save">Save account alerts</button>
                <span class="cl-status-line" data-role="save-status" role="status" aria-live="polite"></span>
            </div>
            <details class="cl-disclosure">
                <summary>How account alerts are delivered</summary>
                <p>Alerts are evaluated by the alert engine in your open Parkers Physics tab (this dashboard or Space Weather), recorded in your alert history and the 🔔 bell, and — with email on — emailed when they meet your minimum severity (at most 10 emails an hour). Radio, GPS, grid and ionosphere alerts read the Space Weather dashboard’s forecast engine, so they are evaluated while that page is open.</p>
            </details>
        </section>
        <section class="cl-alert-col" aria-labelledby="cl-watch-h">
            <h3 class="cl-sub" id="cl-watch-h">Lab watches · at your home station</h3>
            <p class="cl-muted cl-small">Forecast watches the lab checks against your station every refresh — on every plan. They light up here and, if you allow it, as a browser notification while this tab is open. They are not emailed.</p>
            <div class="cl-watch-list" data-role="watches"></div>
            <div class="cl-watch-add">
                <label class="cl-visually-hidden" for="cl-watch-kind">Watch type</label>
                <select id="cl-watch-kind" data-role="add-kind">${Object.entries(WATCH_KINDS).map(([k, w]) => `<option value="${k}">${esc(w.label)}</option>`).join('')}</select>
                <button type="button" class="cl-btn" data-role="add">＋ Add watch</button>
            </div>
            <div class="cl-notify-row" data-role="notify"></div>
        </section>
    </div>`;
    const q = (role) => host.querySelector(`[data-role="${role}"]`);

    // ── Account alerts ──────────────────────────────────────────────────────
    function prefsNow() {
        try { return auth?.getAlertPrefs?.() || {}; } catch { return {}; }
    }

    function renderAccount() {
        const P = prefsNow();
        const disabled = !canAlert();
        const gate = q('gate');
        gate.innerHTML = !signedIn()
            ? `<div class="cl-gate">${demo ? 'Demo mode —' : ''} <a href="signup.html">Create a free account</a> to save alert settings. Lab watches on the right work right now.</div>`
            : !canAlert()
                ? `<div class="cl-gate">Account alerts come with <a href="pricing.html">Basic and above</a>. Lab watches on the right work on your plan.</div>`
                : '';
        q('acct').innerHTML = ACCOUNT_ALERTS.map((a) => {
            const locked = disabled || (a.pro && !canPro());
            const on = !!P[a.col];
            const thr = a.thr ? `<label class="cl-thr"><span>${esc(a.thr.label)}</span><select data-col="${a.thr.col}" ${locked ? 'disabled' : ''}>${a.thr.options.map(([v, l]) =>
                `<option value="${esc(v)}" ${String(P[a.thr.col]) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>` : '';
            return `<div class="cl-alert-row${locked ? ' is-locked' : ''}">
                <label class="cl-switch"><input type="checkbox" data-col="${a.col}" ${on ? 'checked' : ''} ${locked ? 'disabled' : ''}><span class="cl-switch-ui" aria-hidden="true"></span>
                    <span class="cl-alert-name">${esc(a.name)}${a.pro ? ' <span class="cl-tag">PRO</span>' : ''}</span></label>
                ${thr}
                <div class="cl-alert-desc">${esc(a.desc)}${a.needsSw ? ' <span class="cl-muted">Evaluated while Space Weather is open.</span>' : ''}</div>
            </div>`;
        }).join('');

        const tSym = S.units.temp === 'F' ? '°F' : '°C';
        const toUserT = (f) => (isNum(f) ? String(Math.round(S.units.temp === 'F' ? f : f2c(f))) : '');
        q('temp').innerHTML = `<div class="cl-alert-row${disabled ? ' is-locked' : ''}">
            <label class="cl-switch"><input type="checkbox" data-col="notify_temperature" ${P.notify_temperature ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span class="cl-switch-ui" aria-hidden="true"></span>
                <span class="cl-alert-name">Temperature extremes</span></label>
            <span class="cl-thr-pair">
                <label class="cl-thr"><span>High ≥</span><input type="number" step="1" inputmode="numeric" data-temp="temp_high_f" data-unit="${S.units.temp}" value="${toUserT(P.temp_high_f)}" placeholder="—" ${disabled ? 'disabled' : ''}><span>${tSym}</span></label>
                <label class="cl-thr"><span>Low ≤</span><input type="number" step="1" inputmode="numeric" data-temp="temp_low_f" data-unit="${S.units.temp}" value="${toUserT(P.temp_low_f)}" placeholder="—" ${disabled ? 'disabled' : ''}><span>${tSym}</span></label>
            </span>
            <div class="cl-alert-desc">Tomorrow’s forecast high or low crosses your limits at home (checked every 30 min).</div>
        </div>`;

        const cool = P.alert_cooldown_min ?? 60;
        q('delivery').innerHTML = `<div class="cl-alert-row${disabled ? ' is-locked' : ''}">
            <label class="cl-switch"><input type="checkbox" data-col="email_alerts" ${P.email_alerts ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span class="cl-switch-ui" aria-hidden="true"></span>
                <span class="cl-alert-name">Email me</span></label>
            <label class="cl-thr"><span>At least</span><select data-col="email_min_severity" ${disabled ? 'disabled' : ''}>
                ${[['info', 'Info'], ['warning', 'Warning'], ['critical', 'Critical']].map(([v, l]) => `<option value="${v}" ${(P.email_min_severity || 'warning') === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
            <label class="cl-thr"><span>Quiet period</span><select data-col="alert_cooldown_min" ${disabled ? 'disabled' : ''}>
                ${[15, 30, 60, 120, 360, 720].map((v) => `<option value="${v}" ${Number(cool) === v ? 'selected' : ''}>${v < 60 ? v + ' min' : v / 60 + ' h'}</option>`).join('')}
            </select></label>
            <div class="cl-alert-desc">Sent to ${esc(auth?.getUser?.()?.email || 'your account email')}. The quiet period stops the same alert repeating.</div>
        </div>`;
        q('save').disabled = disabled;
        renderSummary();
    }

    function collectPatch() {
        const patch = {};
        host.querySelectorAll('[data-col]').forEach((el) => {
            if (el.disabled) return;
            const k = el.dataset.col;
            if (el.type === 'checkbox') patch[k] = el.checked;
            else if (el.tagName === 'SELECT') patch[k] = /^\d+$/.test(el.value) ? Number(el.value) : el.value;
        });
        host.querySelectorAll('[data-temp]').forEach((el) => {
            if (el.disabled) return;
            const raw = el.value.trim();
            if (raw === '') { patch[el.dataset.temp] = null; return; }   // 0 is a real threshold
            const v = Number(raw);
            if (!isNum(v)) return;
            // Convert with the unit the field was RENDERED in (data-unit),
            // not the current preference — they differ if units flipped mid-edit.
            patch[el.dataset.temp] = Math.round((el.dataset.unit === 'F' ? v : c2f(v)) * 10) / 10;
        });
        return patch;
    }

    q('save').addEventListener('click', async () => {
        const btn = q('save'), st = q('save-status');
        btn.disabled = true; st.textContent = 'Saving…'; st.dataset.tone = 'info';
        const res = await updateOwnProfile(collectPatch());
        btn.disabled = !canAlert();
        st.textContent = res.ok ? 'Saved to your account.' : `Not saved — ${res.error}`;
        st.dataset.tone = res.ok ? 'ok' : 'warn';
        if (res.ok) {
            S.dirty = false;
            renderAccount();
            import('../telemetry.js').then((m) => m.telemetry?.recordFeature?.('climate_lab', 'alerts_saved')).catch(() => {});
            import('../activation.js').then((m) => m.logActivation?.(m.EVENTS?.FIRST_ALERT_CONFIGURED, { source: 'dashboard_console' })).catch(() => {});
        }
    });

    // ── Lab watches ─────────────────────────────────────────────────────────
    function evaluate() {
        S.results = S.obs ? evaluateWatches(S.prefs.watches, S.obs, { nowMs: Date.now(), air: S.air }) : [];
        const fresh = newlyTriggered(S.results, S.seen);
        try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...S.seen].slice(-200))); } catch {}
        if (fresh.length && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            for (const r of fresh) {
                const w = S.prefs.watches.find((x) => x.id === r.id);
                try {
                    new Notification(`Lab watch: ${WATCH_KINDS[r.kind].label} ${watchDisplay(r.kind, w.threshold, S.units)} ${watchUnitSym(r.kind, S.units)}`.trim(), {
                        body: `${statusText(r, w)}${S.home ? ` · ${S.home.city}` : ''}`,
                        tag: `lab-watch-${r.id}`,
                    });
                } catch { /* some browsers require a service worker; the console still shows it */ }
            }
        }
    }

    function whenText(ms) {
        if (!isNum(ms)) return '';
        const off = S.obs?.station?.utcOffsetS ?? 0;
        const d = new Date(ms + off * 1000);
        const day = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
        return `${day} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
    }
    function statusText(r, w) {
        if (!r || r.state === 'off') return 'Off';
        if (r.state === 'nodata') return w?.kind === 'aqi' ? 'Waiting for air-quality data' : 'Waiting for the station forecast';
        const val = `${watchDisplay(r.kind, r.value, S.units)}${watchUnitSym(r.kind, S.units) ? ' ' + watchUnitSym(r.kind, S.units) : ''}`;
        const peakWord = r.kind === 'precip' ? 'total' : WATCH_KINDS[r.kind].cmp === '>=' ? 'peak' : 'low';
        return r.state === 'triggered'
            ? `Triggered from ${whenText(r.firstAt)} · ${peakWord} ${val}`
            : `Clear · ${peakWord} ${val} ${r.kind === 'precip' ? '' : 'at ' + whenText(r.at)}`.trim();
    }

    function renderWatches() {
        const list = q('watches');
        // Someone is typing in a watch: refresh the status chips only.
        if (list.contains(document.activeElement) && list.children.length === S.prefs.watches.length) {
            for (const w of S.prefs.watches) {
                const r = S.results.find((x) => x.id === w.id);
                const chipEl = list.querySelector(`[data-watch="${CSS.escape(w.id)}"] .cl-watch-status .cl-chip`);
                if (chipEl?.lastChild) chipEl.lastChild.textContent = statusText(r, w);
            }
            renderSummary();
            return;
        }
        if (!S.prefs.watches.length) {
            list.innerHTML = '<div class="cl-empty">No watches yet — add one below.</div>';
        } else {
            list.innerHTML = S.prefs.watches.map((w) => {
                const r = S.results.find((x) => x.id === w.id);
                const k = WATCH_KINDS[w.kind];
                const tone = !w.on ? 'neutral' : r?.state === 'triggered' ? 'warning' : r?.state === 'clear' ? 'good' : 'neutral';
                const icon = tone === 'warning' ? '▲' : tone === 'good' ? '●' : '○';
                const sym = watchUnitSym(w.kind, S.units);
                return `<div class="cl-watch" data-watch="${esc(w.id)}" data-state="${esc(r?.state || 'off')}">
                    <label class="cl-switch"><input type="checkbox" data-w="on" ${w.on ? 'checked' : ''}><span class="cl-switch-ui" aria-hidden="true"></span>
                        <span class="cl-alert-name">${esc(k.label)}</span></label>
                    <label class="cl-thr"><span class="cl-visually-hidden">Threshold</span><input type="number" data-w="threshold" step="any" value="${esc(watchDisplay(w.kind, w.threshold, S.units))}">${sym ? `<span>${esc(sym)}</span>` : ''}</label>
                    <label class="cl-thr"><span>within</span><select data-w="horizonH">${WATCH_HORIZONS.map((h) => `<option value="${h}" ${w.horizonH === h ? 'selected' : ''}>${h} h</option>`).join('')}</select></label>
                    <button type="button" class="cl-btn cl-btn-icon" data-w="remove" aria-label="Remove ${esc(k.label)} watch">×</button>
                    <div class="cl-watch-status"><span class="cl-chip" data-tone="${tone}"><span class="cl-chip-icon" aria-hidden="true">${icon}</span>${esc(statusText(r, w))}</span></div>
                </div>`;
            }).join('');
        }
        q('add').disabled = S.prefs.watches.length >= MAX_WATCHES;
        renderNotify();
        renderSummary();
    }

    function renderNotify() {
        const el = q('notify');
        if (typeof Notification === 'undefined') { el.innerHTML = '<span class="cl-muted cl-small">This browser does not support notifications — watches show here only.</span>'; return; }
        const p = Notification.permission;
        el.innerHTML = p === 'granted'
            ? '<span class="cl-small"><span class="cl-chip" data-tone="good"><span class="cl-chip-icon" aria-hidden="true">●</span>Browser notifications on</span> while this tab is open.</span>'
            : p === 'denied'
                ? '<span class="cl-muted cl-small">Browser notifications are blocked for this site — watches show here only.</span>'
                : '<button type="button" class="cl-btn cl-btn-ghost" data-role="notify-btn">Notify me in this browser</button>';
    }

    function renderSummary() {
        const P = prefsNow();
        const nAcct = ACCOUNT_ALERTS.filter((a) => P[a.col]).length + (P.notify_temperature ? 1 : 0);
        const nWatch = S.prefs.watches.filter((w) => w.on).length;
        const trig = S.results.filter((r) => r.state === 'triggered').length;
        q('summary').textContent = `${canAlert() ? `${nAcct} account alert${nAcct === 1 ? '' : 's'} on${P.email_alerts ? ' · email on' : ''}` : 'Account alerts off'} · ${nWatch} watch${nWatch === 1 ? '' : 'es'}${trig ? ` · ${trig} triggered` : ''}`;
    }

    function saveWatches(mutator, action) {
        const p = normalizePrefs(S.prefs);
        mutator(p);
        S.prefs = savePrefs(p);
        import('../telemetry.js').then((m) => m.telemetry?.recordFeature?.('climate_lab', action)).catch(() => {});
    }

    const markDirty = (e) => { if (e.target.closest?.('[data-col],[data-temp]')) S.dirty = true; };
    host.addEventListener('input', markDirty);
    host.addEventListener('change', (e) => {
        markDirty(e);
        const t = e.target;
        const row = t.closest?.('[data-watch]');
        if (!row) return;
        const id = row.dataset.watch;
        saveWatches((p) => {
            const w = p.watches.find((x) => x.id === id);
            if (!w) return;
            if (t.dataset.w === 'on') w.on = t.checked;
            if (t.dataset.w === 'horizonH') w.horizonH = Number(t.value);
            if (t.dataset.w === 'threshold') {
                const v = Number(t.value);
                const qn = watchQuantity(w.kind);
                if (isNum(v)) w.threshold = qn ? fromDisplay(qn, v, S.units) : v;
            }
        }, 'watch_edit');
    });
    host.addEventListener('click', async (e) => {
        const rm = e.target.closest?.('[data-w="remove"]');
        if (rm) {
            const id = rm.closest('[data-watch]').dataset.watch;
            saveWatches((p) => { p.watches = p.watches.filter((x) => x.id !== id); }, 'watch_remove');
            return;
        }
        if (e.target.closest?.('[data-role="add"]')) {
            const kind = q('add-kind').value;
            const k = WATCH_KINDS[kind];
            saveWatches((p) => {
                p.watches.push({ id: `w-${kind}-${Date.now().toString(36)}`, kind, threshold: k.def, horizonH: 24, on: true });
            }, 'watch_add');
            return;
        }
        if (e.target.closest?.('[data-role="notify-btn"]')) {
            try { await Notification.requestPermission(); } catch {}
            renderNotify();
        }
    });

    // ── Feeds ───────────────────────────────────────────────────────────────
    window.addEventListener('climate-lab-station', (ev) => {
        S.obs = ev.detail?.obs || null;
        S.home = ev.detail?.home || null;
        evaluate(); renderWatches();
    });
    window.addEventListener('climate-lab-air', (ev) => { S.air = ev.detail || null; evaluate(); renderWatches(); });
    window.addEventListener(PREFS_EVENT, (ev) => {
        S.prefs = ev.detail?.prefs || loadPrefs();
        S.units = resolveUnits(S.prefs.units, navigator.language);
        evaluate(); renderWatches();
        if (!S.dirty) renderAccount(); else renderSummary();
    });
    window.addEventListener('auth-changed', () => { if (!S.dirty) renderAccount(); else renderSummary(); });

    renderAccount();
    renderWatches();
    return { refresh() { evaluate(); renderWatches(); renderAccount(); } };
}
