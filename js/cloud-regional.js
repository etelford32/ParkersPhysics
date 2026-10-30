/**
 * cloud-regional.js — the regional cloud window (Tier B of the cloud LOD ladder)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * EARTHVIEW_LOD_UX_PLAN.md §5.3. The global cloud mosaic is one 2048×1024
 * frame — ~20 km per pixel at every zoom — so zoomed to a region a texel
 * spans tens of screen pixels and the weather is a blur. When the camera
 * footprint narrows to ≤ 45° (the imagery inset's threshold) this controller
 * asks the SAME snapshot service for the SAME layers at the SAME frame times
 * over just that box, at the instrument's own 2 km, and hands the result to
 * the shaders as u_sat_detail + bounds; SAT_DETAIL_GLSL (cloud-mosaic-core)
 * feathers it over the global frame in the decal, the march and the ground
 * shadow alike.
 *
 * THREE RULES, each the reason this is not a second cloud field:
 *  1. ONE INSTANT. The window re-fetches the global frame's own sources
 *     (`discs` / `fill` on the 'satellite-update' event: layer, time, per-disc
 *     age). When the global frame changes — a refresh or a scrub — the window
 *     is switched OFF at once and re-fetched for the new frame; a window from
 *     another time is never drawn over this one.
 *  2. ONE DECODE. Pixels go through cloud-mosaic-core's MosaicAccumulator with
 *     the regional bounds, the same normaliser and feathering as the globe.
 *  3. CAMERA-SETTLED. Plans are made from focus-footprint events but fetched
 *     only after `settleMs` without a new plan (a fling fetches nothing), and
 *     the plan is snapped to a √2 span ladder and a quarter-window grid
 *     (planRegionalDetail) so small pans and slow zooms reuse the window.
 *
 * The PURE half (planning, coverage, GLSL) lives in cloud-mosaic-core.js and
 * is node-gated by tests/cloud-regional.mjs; this module only sequences.
 * Events: dispatches 'cloud-detail-change' on document with `state()`.
 */

import { planRegionalDetail } from './cloud-mosaic-core.js';

const KM_PER_DEG = 111.195;

export class RegionalCloudDetail {
    /**
     * @param {object} o
     * @param {object} o.THREE
     * @param {{u_sat_detail:{value}, u_sat_detail_bounds:{value}, u_sat_detail_on:{value}}} o.uniforms
     * @param {Function} o.fetch          (THREE, {plan, discs, fill, isStale}) → result | null
     * @param {() => boolean} [o.isActive] layer / quality gate, checked before every fetch
     * @param {number} [o.settleMs=1500]
     */
    constructor({ THREE, uniforms, fetch, isActive = () => true, settleMs = 1500 }) {
        this.THREE = THREE;
        this.u = uniforms;
        this._fetch = fetch;
        this._isActive = isActive;
        this.settleMs = settleMs;
        this._fp = null;
        this._sources = null;      // { discs, fill, key }
        this._plan = null;         // the plan we WANT
        this._shown = null;        // { planKey, sourceKey, used, plan }
        this._timer = null;
        this._gen = 0;
        this._status = 'off';      // off | waiting | loading | live | failed
        this._lastDiag = null;
    }

    /** focus-footprint-change detail (or null). */
    setFootprint(fp) {
        this._fp = fp;
        this._replan();
    }

    /** 'satellite-update' detail: the global frame's per-source identity. */
    setSources(detail) {
        const discs = Array.isArray(detail?.discs) ? detail.discs : [];
        const fill = detail?.fill ?? null;
        const key = discs.map(d => `${d.name}@${d.time}`).join('|') + `|fill@${fill?.time ?? '-'}`;
        if (this._sources?.key === key) return;
        this._sources = { discs, fill, key };
        // Rule 1: never draw a window from another instant over this frame.
        if (this._shown && this._shown.sourceKey !== key) this._hide('waiting');
        this._replan();
    }

    /** Re-evaluate after the gate (layer toggle, quality tier) changed. */
    refresh() { this._replan(); }

    state() {
        const p = this._shown?.plan ?? this._plan;
        return {
            status:   this._status,
            key:      this._shown?.planKey ?? null,
            used:     this._shown?.used ?? [],
            bounds:   p?.bounds ?? null,
            kmPerPx:  p ? p.degPerPx * KM_PER_DEG : null,
            diag:     this._lastDiag,
            tex:      this._shown ? this._texInfo() : null,
        };
    }

    /** Test probe: what was uploaded (dims, orientation) and a CPU read of it. */
    _texInfo() {
        const t = this.u.u_sat_detail.value;
        const img = t?.image;
        if (!img?.data) return null;
        const rowMean = (row) => {
            let s = 0;
            for (let x = 0; x < img.width; x++) s += img.data[(row * img.width + x) * 4];
            return s / img.width;
        };
        return { w: img.width, h: img.height, flipY: t.flipY, bytes: img.data.length,
                 rowMeans: [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(rowMean(Math.min(img.height - 1, Math.floor(f * img.height))))) };
    }

    _replan() {
        const active = this._isActive() && !!this._sources;
        const plan = active ? planRegionalDetail(this._fp) : null;
        this._plan = plan;
        clearTimeout(this._timer);
        if (!plan) {
            this._gen++;                    // drop anything in flight
            this._hide(this._sources ? 'off' : 'off');
            return;
        }
        if (this._shown && this._shown.planKey === plan.key && this._shown.sourceKey === this._sources.key) {
            this._setStatus('live');
            return;
        }
        // A plan we cannot show yet keeps the CURRENT window only if it is
        // still this frame's: the shader feathers it over the global field,
        // and a nearby pan inside it is still a correct sample.
        if (this._status !== 'loading') this._setStatus('waiting');
        this._timer = setTimeout(() => this._load(plan), this.settleMs);
    }

    async _load(plan) {
        if (!this._sources || plan !== this._plan) return;
        const gen = ++this._gen;
        const src = this._sources;
        this._setStatus('loading');
        let res = null;
        try {
            res = await this._fetch(this.THREE, {
                plan, discs: src.discs, fill: src.fill,
                isStale: () => gen !== this._gen,
            });
        } catch (e) {
            res = { texture: null, diag: { error: String(e?.message ?? e) } };
        }
        if (gen !== this._gen) { res?.texture?.dispose?.(); return; }
        this._lastDiag = res?.diag ?? null;
        if (!res?.texture) { this._hide('failed'); return; }
        const old = this.u.u_sat_detail.value;
        const b = plan.bounds;
        this.u.u_sat_detail.value = res.texture;
        this.u.u_sat_detail_bounds.value.set(b.lonMin, b.latMin, b.lonSpan, b.latSpan);
        this.u.u_sat_detail_on.value = 1;
        if (old && old !== res.texture && old.isDataTexture && old.image?.width > 1) old.dispose?.();
        this._shown = { planKey: plan.key, sourceKey: src.key, used: res.used ?? [], plan };
        this._setStatus('live');
    }

    _hide(status) {
        this.u.u_sat_detail_on.value = 0;
        this._shown = null;
        this._setStatus(status);
    }

    _setStatus(s) {
        if (this._status === s) return;
        this._status = s;
        try {
            document.dispatchEvent(new CustomEvent('cloud-detail-change', { detail: this.state() }));
        } catch { /* node / no DOM */ }
    }
}
