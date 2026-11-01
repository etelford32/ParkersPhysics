/**
 * weather-scrub-bridge.js — main-thread façade for js/weather-scrub-worker.js.
 *
 * TWO LANES, two Worker instances of the same script: 'decode' (the
 * resolver's look-ahead) and 'isobars' (the contour layer). Separate workers
 * so a 58 ms contour never delays the next frame's decode, and vice versa.
 *
 * Same contract as js/weather-forecast-worker-bridge.js: lazy spawn, requests
 * tracked by id, and any spawn/runtime failure flips available() to false so
 * every caller falls back to its inline path — a dead worker must never make
 * a layer disappear. `?scrubworker=0` (handled by the page) is the A/B.
 */

const WORKER_URL = new URL('./weather-scrub-worker.js', import.meta.url);

class Lane {
    constructor(name) {
        this.name = name;
        this.worker = null;
        this.failed = false;
        this.nextId = 1;
        this.pending = new Map();
    }
    ensure() {
        if (this.worker || this.failed) return this.worker;
        if (typeof Worker === 'undefined') { this.failed = true; return null; }
        try {
            const w = new Worker(WORKER_URL, { type: 'module' });
            w.onmessage = (e) => {
                const m = e.data;
                if (!m || m.id == null) return;           // 'ready'
                const p = this.pending.get(m.id);
                if (!p) return;
                this.pending.delete(m.id);
                if (m.error) p.reject(new Error(m.error));
                else p.resolve(m.trio ?? m.result ?? null);
            };
            w.onerror = (e) => this.die(e?.message || 'scrub worker error');
            this.worker = w;
        } catch (err) {
            this.die(err?.message || String(err));
        }
        return this.worker;
    }
    die(reason) {
        this.failed = true;
        for (const p of this.pending.values()) p.reject(new Error(reason));
        this.pending.clear();
        try { this.worker?.terminate(); } catch (_) { /* ignore */ }
        this.worker = null;
    }
    request(msg, transfer = []) {
        const w = this.ensure();
        if (!w) return Promise.reject(new Error(`scrub worker (${this.name}) unavailable`));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try { w.postMessage({ ...msg, id }, transfer); }
            catch (err) { this.pending.delete(id); reject(err); }
        });
    }
    get busy() { return this.pending.size; }
}

export class WeatherScrubBridge {
    constructor() {
        this._decode = new Lane('decode');
        this._isobars = new Lane('isobars');
    }

    /** True while at least one lane can still be used. */
    available() {
        return typeof Worker !== 'undefined' && !(this._decode.failed && this._isobars.failed);
    }
    decodeAvailable()  { return typeof Worker !== 'undefined' && !this._decode.failed; }
    isobarsAvailable() { return typeof Worker !== 'undefined' && !this._isobars.failed; }

    /**
     * Decode a coarse frame off-thread. The coarse array is COPIED (it belongs
     * to the history ring, and a transfer would detach it there).
     * @returns {Promise<{weatherBuf, windBuf, cloudBuf}>}
     */
    decode(coarse, gridW, gridH) {
        const copy = new Float32Array(coarse);
        return this._decode.request({ type: 'decode', coarse: copy, gridW, gridH }, [copy.buffer]);
    }

    /** Contour a weather buffer off-thread. The buffer is transferred — pass a copy. */
    isobars(buf) {
        return this._isobars.request({ type: 'isobars', buf }, [buf.buffer]);
    }

    get decodeBusy() { return this._decode.busy; }

    stop() { this._decode.die('stopped'); this._isobars.die('stopped'); }
}

/** Adapter so IsobarLayer.setWorker() sees the isobar lane's own availability. */
export function isobarLane(bridge) {
    return { available: () => bridge.isobarsAvailable(), isobars: (b) => bridge.isobars(b) };
}

export default WeatherScrubBridge;
