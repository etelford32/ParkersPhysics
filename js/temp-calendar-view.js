/**
 * temp-calendar-view.js — the ONE 30-day temperature calendar renderer
 * (PLANETARY_TEMPERATURE_LAB_PLAN.md §8.1). Extracted verbatim from
 * js/home-sky-console.js so the homepage's Temperature tab and the
 * Planetary Temperature Lab's Intro card draw one calendar from one
 * `buildMonthCalendar` (js/temp-outlook.js) result. PURE string building —
 * no DOM, no fetch — so it is importable from node.
 *
 * The homepage gate `tests/home-temp-outlook.spec.js` is the regression test
 * for this extraction; with `unit: 'F'` (the default) the markup is the
 * pre-extraction markup byte for byte.
 *
 * Styling: CALENDAR_CSS is the `.sc-cal` block, and it reads the console's
 * `--sc-*` custom properties (s2, ink…ink4, accent). A host that is not the
 * sky console must define those on an ancestor — the lab does on `.tl-cal`.
 *
 * Units: `projectDays` rows are °F by legacy. `unit: 'C'` converts at THIS
 * seam for display only; nothing is stored in °C or °F here. The cell
 * background is always scaled on the °F departure so a unit switch never
 * changes a colour.
 */

const isNum = (v) => Number.isFinite(v);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Warming / cooling: the tab's own accent for a day that warms across
// midnight, a blue for one that cools. The pair validates for CVD and
// normal-vision separation and for contrast on the console surface
// (dataviz validator, 2026-09-21); the lightness band it fails is the
// console's deliberate neon-on-black house style, shared by every colour
// on this card.
export const WARM_COL = '#ff8c5a', COOL_COL = '#6ea8ff';
export const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtSigned = (v) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(Math.round(v))}°`;

/** A temperature (°F in) in the display unit. */
const tOut = (vF, unit) => (unit === 'C' ? (vF - 32) * 5 / 9 : vF);
/** A temperature DIFFERENCE (°F in) in the display unit. */
const dOut = (dF, unit) => (unit === 'C' ? dF * 5 / 9 : dF);

/** Cell background: departure from the date's normal, warm or cool, magnitude → mix. */
export function anomalyStyle(anomF) {
    if (!isNum(anomF)) return '';
    const pct = Math.round(clamp01(Math.abs(anomF) / 12) * 55);
    if (pct < 4) return '';
    return ` style="background:color-mix(in srgb,${anomF > 0 ? WARM_COL : COOL_COL} ${pct}%,var(--sc-s2))"`;
}

export function calendarCellTip(c, temp, { unit = 'F' } = {}) {
    const date = new Date(c.t).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const years = temp.clim ? `${temp.clim.years[0]}–${temp.clim.years[1]}` : '';
    const anom = isNum(c.anomF) ? `\n${fmtSigned(dOut(c.anomF, unit))} vs the ${years} normal for the date` : '';
    if (c.past) {
        if (c.hiF == null) return `${date}\nNo record for this day.`;
        return `${date}\nObserved high ${Math.round(tOut(c.hiF, unit))}° · low ${Math.round(tOut(c.loF, unit))}°${anom}\n${c.source === 'archive' ? 'ERA5 reanalysis archive' : 'Model analysis — the archive publishes ~2 days behind'}`;
    }
    const when = c.lead === 0 ? 'today' : c.lead === 1 ? 'tomorrow' : `in ${c.lead} days`;
    if (c.source === 'none') return `${date} · ${when}\nNo outlook yet — the archive normals are still loading.`;
    const val = `High ${Math.round(tOut(c.hiF, unit))}° · Low ${Math.round(tOut(c.loF, unit))}°`;
    if (c.source === 'nwp') {
        return `${date} · ${when}\n${val}${anom}\n${c.tier === 'nwp-near' ? 'Model forecast — day-to-day skill' : 'Extended model run — skill fades past ~10 days'}`;
    }
    const tau = temp.outlook?.tau;
    const trend = c.rho > 0.05 ? `the model's day-16 departure at ${Math.round(c.rho * 100)}%` : 'no model trend left';
    return `${date} · ${when}\n${val}${anom}\nNormal for the date + ${trend}${isNum(tau) ? ` (τ ${tau.toFixed(1)} d)` : ''}`
        + (isNum(c.sigmaF) ? `\nTypical miss ±${Math.round(dOut(c.sigmaF, unit))}°` : '');
}

/** The 30-day calendar: this month's page through today + 30. */
export function monthCalendarHtml(temp, { unit = 'F' } = {}) {
    const cal = temp.calendar;
    if (!cal?.weeks?.length) return '';
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let g = `<div class="sc-cal" role="grid" aria-label="30-day temperature outlook calendar">`
        + `<div class="sc-cal-head" role="row">${DOW.map((d) => `<span role="columnheader">${d}</span>`).join('')}</div>`;
    for (const week of cal.weeks) {
        g += '<div class="sc-cal-grid" role="row">';
        for (const c of week) {
            if (c.pad) { g += '<div class="d pad" role="gridcell" aria-hidden="true"></div>'; continue; }
            const dn = c.monthStart ? `<b>${MONTH_SHORT[c.month]} ${c.day}</b>` : c.isToday ? `<b>${c.day}</b>` : String(c.day);
            const hl = c.hiF != null && c.loF != null ? `${Math.round(tOut(c.hiF, unit))}<small>/${Math.round(tOut(c.loF, unit))}</small>` : '<small>—</small>';
            const cls = `d${c.past ? ' past' : ''}${c.isToday ? ' today' : ''}`;
            const tip = calendarCellTip(c, temp, { unit });
            g += `<div class="${cls}" role="gridcell" tabindex="0" data-key="${c.key}" data-tier="${c.tier}" data-src="${c.source}" data-lead="${c.lead}"`
                + `${anomalyStyle(c.anomF)} aria-label="${esc(tip.replace(/\n/g, '. '))}" data-tip="${esc(tip)}">`
                + `<span class="dn">${dn}</span><span class="hl">${hl}</span></div>`;
        }
        g += '</div>';
    }
    g += '</div>';
    return g;
}

/** The `.sc-cal` rules (read the host's --sc-* custom properties). */
export const CALENDAR_CSS = `/* month calendar */
.sc-cal{margin-top:6px}
.sc-cal-head{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;font-size:.6rem;letter-spacing:.08em;text-transform:uppercase;
  color:var(--sc-ink4);text-align:center;margin-bottom:3px}
.sc-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
.sc-cal .d{position:relative;min-height:50px;border-radius:7px;background:var(--sc-s2);border:1px solid transparent;padding:4px 5px 3px;
  font-size:.7rem;line-height:1.25;color:var(--sc-ink3);display:flex;flex-direction:column;justify-content:space-between;cursor:default;outline:none;min-width:0}
.sc-cal .d.pad{background:transparent}
.sc-cal .d .dn{font-size:.66rem;color:var(--sc-ink3);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-cal .d .dn b{color:var(--sc-ink2);font-weight:650}
.sc-cal .d .hl{font-variant-numeric:tabular-nums;color:var(--sc-ink);font-weight:650;white-space:nowrap;font-size:.76rem}
.sc-cal .d .hl small{color:var(--sc-ink3);font-weight:500;font-size:.9em}
.sc-cal .d.past{opacity:.74}
.sc-cal .d.past .hl{font-weight:500;color:var(--sc-ink2)}
.sc-cal .d.today{border-color:var(--sc-accent);box-shadow:0 0 0 1px var(--sc-accent) inset;opacity:1}
.sc-cal .d[data-tier="nwp-ext"] .hl{font-weight:560}
.sc-cal .d[data-tier="blend"]{border-style:dashed;border-color:rgba(154,133,255,.3)}
.sc-cal .d[data-tier="blend"] .hl{font-weight:500;color:var(--sc-ink2)}
.sc-cal .d[data-tier="none"] .hl{color:var(--sc-ink4);font-weight:400}
.sc-cal .d:not(.pad):hover,.sc-cal .d:not(.pad):focus{border-color:rgba(255,255,255,.4)}
@container (max-width:520px){.sc-cal .d{min-height:40px;padding:3px 3px 2px;font-size:.62rem}.sc-cal .d .dn{font-size:.56rem}}`;
