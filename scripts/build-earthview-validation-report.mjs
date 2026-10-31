#!/usr/bin/env node
/**
 * build-earthview-validation-report.mjs — tests/earthview-validation.spec.js's
 * evidence as one page.
 *
 *   npx playwright test tests/earthview-validation.spec.js --workers=1
 *   node scripts/build-earthview-validation-report.mjs [dir]
 *
 * Reads <dir>/manifest.json (default validation-output/earthview) and
 * writes <dir>/report/index.html with its images beside it: full frames as
 * WebP (q 88, via Python PIL when present — a 1280×720 PNG of a globe is
 * ~1 MB), enlarged crops as the lossless PNGs the gates measured. The page
 * is self-contained apart from Google Fonts and needs no build step.
 *
 * It prints what the manifest says and nothing else: every number on the
 * page is a measured value or a gate limit from the spec.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';

const DIR = process.argv[2] || 'validation-output/earthview';
const OUT = join(DIR, 'report');
const IMG = join(OUT, 'img');
mkdirSync(IMG, { recursive: true });
const m = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));

// ── images ──────────────────────────────────────────────────────────────────
let pil = true;
try { execFileSync('python3', ['-c', 'import PIL']); } catch { pil = false; }
function asset(file, { crop = false } = {}) {
    const src = join(DIR, file);
    if (!existsSync(src)) return null;
    if (crop || !pil) { copyFileSync(src, join(IMG, file)); return `img/${file}`; }
    const dst = basename(file, '.png') + '.webp';
    execFileSync('python3', ['-c',
        'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], "WEBP", quality=88, method=6)',
        src, join(IMG, dst)]);
    return `img/${dst}`;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : (Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3))) : esc(v));
const OPS = { '<': '&lt;', '>': '&gt;', '=': '=' };

function figure(f, caption, { crop = false, wide = false } = {}) {
    if (!f) return '';
    const src = asset(f.file, { crop });
    if (!src) return '';
    return `<figure class="${crop ? 'crop' : 'frame'}${wide ? ' wide' : ''}"><img src="${src}" alt="${esc(caption)}" loading="lazy"${crop ? ' class="px"' : ''}><figcaption>${caption}</figcaption></figure>`;
}
const find = (c, pred) => c.frames.find(pred);

function gateTable(c) {
    const rows = c.gates.map((g) => `<tr class="${g.pass ? 'ok' : 'bad'}">
        <td>${esc(g.name)}${g.control ? ' <span class="chip ctl">negative control</span>' : ''}</td>
        <td class="num">${fmt(g.value)}</td>
        <td class="num">${OPS[g.op]} ${fmt(g.limit)}</td>
        <td><span class="verdict ${g.pass ? 'ok' : 'bad'}">${g.pass ? 'pass' : 'fail'}</span></td></tr>`).join('');
    return `<div class="tablewrap"><table><thead><tr><th>Gate</th><th class="num">Measured</th><th class="num">Pass when</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ── the falloff chart (lighting) ────────────────────────────────────────────
function falloffChart(c) {
    const curve = c.metrics?.curve;
    if (!curve) return '';
    const W = 640, H = 300, L = 48, R = 16, T = 16, B = 42;
    const x0 = -0.4, x1 = 1;
    const sx = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
    const sy = (v) => T + (1 - v / 255) * (H - T - B);
    const thin = (pts) => pts.filter((_, i) => i % Math.max(1, Math.ceil(pts.length / 1400)) === 0);
    const dots = (pts, cls) => thin(pts).filter(([mu]) => mu >= x0).map(([mu, l]) => `<circle class="${cls}" cx="${sx(mu).toFixed(1)}" cy="${sy(l).toFixed(1)}" r="1.4"/>`).join('');
    const line = (bins, cls) => {
        const p = bins.filter((b) => b.L != null).map((b) => `${sx(b.mu0).toFixed(1)},${sy(b.L).toFixed(1)}`).join(' ');
        return `<polyline class="${cls}" points="${p}"/>` + bins.filter((b) => b.L != null).map((b) => `<circle class="${cls}-pt" cx="${sx(b.mu0).toFixed(1)}" cy="${sy(b.L).toFixed(1)}" r="3.5"/>`).join('');
    };
    const xt = [-0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8, 1].map((v) => `<line class="grid" x1="${sx(v)}" x2="${sx(v)}" y1="${T}" y2="${H - B}"/><text class="tick" x="${sx(v)}" y="${H - B + 16}" text-anchor="middle">${v.toFixed(1)}</text>`).join('');
    const yt = [0, 64, 128, 192, 255].map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/><text class="tick" x="${L - 8}" y="${sy(v) + 4}" text-anchor="end">${v}</text>`).join('');
    return `<figure class="chart wide">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Pixel brightness against the cosine of the Sun's zenith angle, physical and legacy shaders">
        ${xt}${yt}
        <line class="axis0" x1="${sx(0)}" x2="${sx(0)}" y1="${T}" y2="${H - B}"/>
        <text class="tick" x="${sx(0) + 6}" y="${T + 12}">terminator</text>
        ${dots(curve.legacy, 'dot-leg')}${dots(curve.physical, 'dot-phys')}
        ${line(c.metrics.legacy.bins, 'ln-leg')}${line(c.metrics.physical.bins, 'ln-phys')}
        <text class="axl" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">μ₀ = cos(solar zenith angle) at the pixel</text>
        <text class="axl" x="12" y="${(T + H - B) / 2}" text-anchor="middle" transform="rotate(-90 12 ${(T + H - B) / 2})">displayed luma</text>
      </svg>
      <figcaption><span class="key phys"></span>physical &nbsp; <span class="key leg"></span>legacy. Dots are 5 184 pixels of the terminator frame; lines are the means in μ₀ bins. Lambert's law puts the light on a line through the origin (before the display curve); the legacy shader stays half-lit at the terminator and lights the night side.</figcaption>
    </figure>`;
}

// ── one section per check ───────────────────────────────────────────────────
function body(c) {
    const fr = (pred, cap, o) => figure(find(c, pred), cap, o);
    const M = c.metrics || {};
    switch (c.id) {
    case 'lighting': return `
        ${falloffChart(c)}
        <div class="grid3 head"><span></span><span>Physical (shipped)</span><span>Legacy (control)</span></div>
        ${['day', 'terminator', 'night'].map((v) => `<div class="grid3">
            <span class="rowlabel">${{ day: 'Sun 20° north of the camera', terminator: 'Sun 60° east: the terminator in view', night: 'Sun behind the globe' }[v]}</span>
            ${fr((f) => f.mode === 'physical' && f.view === v, `physical · ${v}`)}
            ${fr((f) => f.mode === 'legacy' && f.view === v, `legacy · ${v}`)}</div>`).join('')}`;
    case 'relief': return `<div class="grid2">
            ${fr((f) => f.mode === 'shipped' && f.crop, `Sobel (shipped) · Sahara at a low Sun, 3× · roughness ${fmt(M.shipped?.roughness)}, 4-px relief ${fmt(M.shipped?.relief4px)}`, { crop: true })}
            ${fr((f) => f.mode === 'forward' && f.crop, `forward difference (control) · same crop · roughness ${fmt(M.forward?.roughness)}, 4-px relief ${fmt(M.forward?.relief4px)}`, { crop: true })}
            ${fr((f) => f.mode === 'shipped' && !f.crop, 'Sobel · full frame')}
            ${fr((f) => f.mode === 'forward' && !f.crop, 'forward · full frame')}</div>`;
    case 'glint': return `<div class="grid2">
            ${fr((f) => f.mode === 'physical', `physical · peak ${fmt(M.physical?.peak)}, median ${fmt(M.physical?.median)}`)}
            ${fr((f) => f.mode === 'legacy', `legacy · peak ${fmt(M.legacy?.peak)}, median ${fmt(M.legacy?.median)}`)}</div>`;
    case 'limb': return `
        ${fr((f) => f.level === 'auto' && !f.crop, `The view: ${fmt(M.camera?.altitudeKm)} km up, looking ${fmt(M.camera?.dipDeg)}° below level at the horizon; the Sun overhead at the limb`, { wide: true })}
        <div class="stack">${['auto', '47', '15', '6'].map((l) => fr((f) => f.level === l && f.crop,
            `${l === 'auto' ? `shipped (LOD chose level ${M.auto?.detail})` : `forced level ${l}${l === '6' ? ' — before this pass (control)' : ''}`} · mean ${fmt(M[l]?.meanDevPx)} px, 95th percentile ${fmt(M[l]?.p95DevPx)} px from the true limb`, { crop: true })).join('')}</div>`;
    case 'seam': return `<div class="grid2">
            ${fr((f) => f.mode === 'fixed' && !f.crop, 'fixed (shipped)')}
            ${fr((f) => f.mode === 'legacy' && !f.crop, 'legacy UV (control)')}
            ${fr((f) => f.mode === 'fixed' && f.crop, `fixed · top band at the 180° meridian, 6× · excess ${fmt(M.fixed?.seam)}`, { crop: true })}
            ${fr((f) => f.mode === 'legacy' && f.crop, `legacy · same crop · excess ${fmt(M.legacy?.seam)}`, { crop: true })}</div>`;
    case 'window': return `<div class="grid2">
            ${fr((f) => f.mode === 'window' && !f.crop, `regional window · ${fmt(M.window?.kmPerPx)} km/px · ${esc((M.window?.used || []).join(', '))}`)}
            ${fr((f) => f.mode === 'global' && !f.crop, 'global frame only (control)')}
            ${fr((f) => f.mode === 'window' && f.crop, `window · centre, 3× · ${M.window?.north} stripe edges north, ${M.window?.south} south`, { crop: true })}
            ${fr((f) => f.mode === 'global' && f.crop, `global · same crop · ${M.global?.north} north, ${M.global?.south} south`, { crop: true })}</div>`;
    case 'regions': return `
        ${fr((f) => f.view === 'page', `The page after choosing “${esc(M.region)}” · readout: ${esc(M.readout)}`, { wide: true })}
        ${fr((f) => f.view === 'readout', 'The picker and readout', { crop: true })}
        <dl class="facts">
          <dt>Screen-centre pick (shipped)</dt><dd>${fmt(M.pick?.analytic?.lat)}°, ${fmt(M.pick?.analytic?.lon)}°</dd>
          <dt>Region centre</dt><dd>${fmt(M.pick?.regionCentre?.lat)}°, ${fmt(M.pick?.regionCentre?.lon)}°</dd>
          <dt>Old mesh-UV pick (control)</dt><dd>${fmt(M.pick?.meshUv?.lat)}°, ${fmt(M.pick?.meshUv?.lon)}° — the antipode</dd>
          <dt>Globe mesh, far → near</dt><dd>level ${M.globeDetail?.far} → ${M.globeDetail?.near}</dd>
        </dl>`;
    case 'deeplink': return `${fr((f) => f.view === 'page', `?region=japan-and-korea on load · pick ${fmt(M.pick?.lat)}°, ${fmt(M.pick?.lon)}°`, { wide: true })}`;
    default: return c.frames.map((f) => figure(f, f.file, { crop: f.crop })).join('');
    }
}

// Optional <dir>/findings.json: [{ title, text, frame? }] — things SEEN in the
// frames that no gate measures yet. Kept apart from the gates on purpose: a
// finding is a judgement by eye, a gate is a number with a control.
const findings = existsSync(join(DIR, 'findings.json')) ? JSON.parse(readFileSync(join(DIR, 'findings.json'), 'utf8')) : [];
const findingsHtml = findings.length ? `
<section id="findings">
  <header class="sec"><h2>Open findings</h2><span class="verdict open">not gated</span></header>
  <p class="claim">Seen in these frames by eye. No gate measures them yet, so they are listed here rather than counted above.</p>
  <ol class="findings">${findings.map((f) => `<li><h3>${esc(f.title)}</h3><p>${esc(f.text)}</p>${f.frame ? figure({ file: f.frame }, esc(f.caption ?? f.title), { wide: true }) : ''}</li>`).join('')}</ol>
</section>` : '';

const nGates = m.checks.reduce((a, c) => a + c.gates.length, 0);
const nPass = m.checks.reduce((a, c) => a + c.gates.filter((g) => g.pass).length, 0);
const nCtl = m.checks.reduce((a, c) => a + c.gates.filter((g) => g.control).length, 0);
const allPass = nPass === nGates;
const when = new Date(m.generatedAt);

const sections = m.checks.map((c) => `
<section id="${esc(c.id)}">
  <header class="sec">
    <h2>${esc(c.title)}</h2>
    <span class="verdict ${c.pass ? 'ok' : 'bad'}">${c.pass ? 'pass' : 'fail'}</span>
  </header>
  <p class="claim">${esc(c.claim)}</p>
  ${c.control ? `<p class="control"><span class="chip ctl">negative control</span> ${esc(c.control)}</p>` : ''}
  ${c.notes?.length ? c.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('') : ''}
  ${body(c)}
  ${gateTable(c)}
</section>`).join('');

const html = `<title>EarthView Validation</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
/* Layout: a single instrument log — summary strip, then one section per claim: what it says, what disproves it, the frames, the gates. */
:root {
  --bg: #f4f7f9; --panel: #ffffff; --ink: #0e1a22; --muted: #52626d; --rule: #d5dee4;
  --accent: #0085b0; --amber: #b8641c; --ok: #1d7a4a; --bad: #b42318; --ok-bg: #e3f3ea; --bad-bg: #fbe4e1; --ctl-bg: #fdf0e3;
  --f-display: "IBM Plex Sans Condensed", "Arial Narrow", sans-serif;
  --f-body: "IBM Plex Sans", system-ui, sans-serif;
  --f-mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0a1117; --panel: #0f1920; --ink: #dbe7ee; --muted: #8aa0ad; --rule: #1f2f3a;
  --accent: #00c6ff; --amber: #ffb066; --ok: #4cc38a; --bad: #ff7b6b; --ok-bg: #10291d; --bad-bg: #33130f; --ctl-bg: #2d1f10; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #0a1117; --panel: #0f1920; --ink: #dbe7ee; --muted: #8aa0ad; --rule: #1f2f3a;
  --accent: #00c6ff; --amber: #ffb066; --ok: #4cc38a; --bad: #ff7b6b; --ok-bg: #10291d; --bad-bg: #33130f; --ctl-bg: #2d1f10; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font: 15px/1.55 var(--f-body); }
main { max-width: 1180px; margin: 0 auto; padding-block: 28px 64px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 40px; }
h1, h2 { font-family: var(--f-display); font-weight: 600; text-wrap: balance; margin: 0; letter-spacing: .01em; }
h1 { font-size: clamp(28px, 4vw, 40px); }
h2 { font-size: 24px; }
.top { display: grid; gap: 14px; }
.eyebrow { font: 500 12px var(--f-mono); letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
.lede { max-width: 68ch; color: var(--muted); margin: 0; }
.summary { display: flex; flex-wrap: wrap; gap: 10px 22px; align-items: center; padding: 14px 16px; background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; font: 13px var(--f-mono); font-variant-numeric: tabular-nums; }
.summary b { font-weight: 500; }
.toc { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 14px; }
.toc a { color: var(--accent); text-decoration: none; display: inline-flex; gap: 6px; align-items: center; }
.toc a:hover, .toc a:focus-visible { text-decoration: underline; }
section { display: grid; gap: 14px; padding-top: 28px; border-top: 1px solid var(--rule); }
header.sec { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.claim { margin: 0; max-width: 72ch; }
.control, .note { margin: 0; max-width: 80ch; color: var(--muted); font-size: 14px; }
.verdict { font: 500 12px var(--f-mono); text-transform: uppercase; letter-spacing: .06em; padding: 2px 8px; border-radius: 999px; }
.verdict.ok { color: var(--ok); background: var(--ok-bg); }
.verdict.bad { color: var(--bad); background: var(--bad-bg); }
.verdict.open { color: var(--amber); background: var(--ctl-bg); }
ol.findings { margin: 0; padding-left: 1.4em; display: grid; gap: 22px; max-width: 980px; }
ol.findings h3 { font: 600 17px var(--f-display); margin: 0 0 4px; }
ol.findings p { margin: 0 0 10px; max-width: 76ch; }
.chip.ctl { font: 500 11px var(--f-mono); text-transform: uppercase; letter-spacing: .05em; color: var(--amber); background: var(--ctl-bg); padding: 1px 7px; border-radius: 4px; white-space: nowrap; }
figure { margin: 0; display: grid; gap: 6px; min-width: 0; }
figure img { width: 100%; height: auto; border-radius: 4px; background: #000; display: block; }
img.px { image-rendering: pixelated; }
figcaption { font-size: 13px; color: var(--muted); }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.grid3 { display: grid; grid-template-columns: 150px repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
.grid3.head { font: 500 12px var(--f-mono); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
.rowlabel { font-size: 13px; color: var(--muted); padding-top: 4px; }
.stack { display: grid; gap: 14px; max-width: 980px; }
.wide { max-width: 980px; }
.chart svg { width: 100%; height: auto; background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; }
.chart .grid { stroke: var(--rule); stroke-width: 1; }
.chart .axis0 { stroke: var(--muted); stroke-dasharray: 3 3; }
.chart .tick, .chart .axl { fill: var(--muted); font: 11px var(--f-mono); }
.chart .dot-phys { fill: var(--accent); opacity: .35; }
.chart .dot-leg { fill: var(--amber); opacity: .3; }
.chart .ln-phys { fill: none; stroke: var(--accent); stroke-width: 2.5; }
.chart .ln-leg { fill: none; stroke: var(--amber); stroke-width: 2.5; }
.chart .ln-phys-pt { fill: var(--accent); }
.chart .ln-leg-pt { fill: var(--amber); }
.key { display: inline-block; width: 10px; height: 10px; border-radius: 50%; vertical-align: -1px; margin-right: 4px; }
.key.phys { background: var(--accent); } .key.leg { background: var(--amber); }
.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; background: var(--panel); border: 1px solid var(--rule); border-radius: 6px; }
th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { font: 500 12px var(--f-mono); text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
td.num, th.num { text-align: right; font-family: var(--f-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
tr:last-child td { border-bottom: 0; }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; font-size: 14px; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; font-family: var(--f-mono); font-variant-numeric: tabular-nums; }
@media (max-width: 720px) {
  .grid2 { grid-template-columns: 1fr; }
  .grid3 { grid-template-columns: 1fr 1fr; }
  .grid3 > .rowlabel, .grid3.head > span:first-child { grid-column: 1 / -1; }
  dl.facts { grid-template-columns: 1fr; }
}
</style>
<main>
  <div class="top">
    <span class="eyebrow">ParkersPhysics · EarthView</span>
    <h1>EarthView validation</h1>
    <p class="lede">Each claim below is rendered twice: the shipped code and a negative control that puts the old behaviour back. Every gate is a number measured from the pixels, and every control has to fail, which is how we know the test can see the bug. Frames come from Chromium's software renderer with test data served locally, so they show what the shaders compute; how a GPU filters them is still to be checked.</p>
    <div class="summary">
      <span class="verdict ${allPass ? 'ok' : 'bad'}">${allPass ? 'all gates pass' : `${nGates - nPass} failing`}</span>
      <span><b>${m.checks.length}</b> checks · <b>${nPass}/${nGates}</b> gates · <b>${nCtl}</b> negative controls</span>
      <span>commit <b>${esc(m.commit ?? '—')}</b></span>
      <span>${esc(when.toISOString().slice(0, 16).replace('T', ' '))} UTC</span>
      <span>${esc(m.renderer)} · ${m.viewport.width}×${m.viewport.height}</span>
    </div>
    <nav class="toc" aria-label="Checks">${m.checks.map((c) => `<a href="#${esc(c.id)}"><span class="verdict ${c.pass ? 'ok' : 'bad'}">${c.pass ? 'pass' : 'fail'}</span>${esc(c.title)}</a>`).join('')}${findings.length ? `<a href="#findings"><span class="verdict open">${findings.length}</span>Open findings</a>` : ''}</nav>
  </div>
  ${sections}
  ${findingsHtml}
</main>
`;
writeFileSync(join(OUT, 'index.html'), html);
console.log(`report: ${join(OUT, 'index.html')} — ${m.checks.length} checks, ${nPass}/${nGates} gates pass`);
