/**
 * scripts/lib/sdo-synth.mjs — SYNTHETIC SDO-like full-disk frames for tests
 * ═══════════════════════════════════════════════════════════════════════════
 * Renders stand-in frames with the SAME geometry as the NASA browse images
 * (`latest_<res>_<code>.jpg`): a centred disk whose radius is the instrument's
 * fraction of the frame, limb darkening (HMI) or limb brightening + faint
 * off-limb corona (AIA), and PLANTED features at known heliographic
 * coordinates so `tests/sun-observed.mjs` can check the projection against a
 * ground truth the generator wrote down. These are NOT observations and every
 * consumer labels them synthetic; `scripts/fetch-sdo-fixtures.mjs` replaces
 * them with real frames on a machine that can reach nasa.gov.
 *
 * Pure: no DOM, no three. Exports a renderer + a minimal PNG encoder (zlib).
 */
import { deflateSync } from 'node:zlib';
import { heliographicToVec, projectDiskUV, DISK_FRACTION, CHANNELS } from '../../js/sun-observed.js';
import { parseSuviChannel } from '../../js/suvi-geometry.js';
import { coronagraph, expectedRsunFrac, positionAngleDeg } from '../../js/sun-coronagraph.js';

/** Planted features shared by every synthetic channel: heliographic degrees. */
export const PLANTED = Object.freeze([
    { id: 'AR-A', latDeg: 15, lonDeg: 20,  areaMh: 420, polarity: +1 },
    { id: 'AR-B', latDeg: -12, lonDeg: -35, areaMh: 260, polarity: -1 },
    { id: 'AR-C', latDeg: 22, lonDeg: -60, areaMh: 140, polarity: +1 },
]);

/**
 * Planted OFF-LIMB features, in PLANE-OF-SKY coordinates (R☉ from disk centre,
 * +x image right, +y image up) — the frame the off-limb annulus layer works in
 * (js/sun-offlimb.js). Ground truth for `tests/sun-smoke.spec.js`: the annulus
 * must be bright where the generator put a feature and dark a quadrant away,
 * which is what pins the plane→frame mapping. Heliographic coordinates would
 * be the wrong frame here — an off-limb pixel is a line integral and does not
 * belong to a point on the sphere.
 */
export const PLANTED_OFFLIMB = Object.freeze([
    // A 304 Å prominence off the EAST limb (image left), the classic bright arc.
    { id: 'PROM-E', channel: '304', x: -1.18, y: 0.10, sigma: 0.075, amp: 0.85 },
    // A 131 Å post-flare loop arcade off the WEST limb (image right).
    { id: 'ARCADE-W', channel: '131', x: 1.14, y: -0.22, sigma: 0.060, amp: 0.90 },
    // ── The coverage probe (Phase 3e) ──────────────────────────────────────
    // Planted ON THE +x AXIS at 1.45 R☉, which is deliberately BETWEEN the two
    // instruments' on-axis reach: AIA's half-frame stops at 1.280 R☉ so this
    // feature is not in an AIA frame AT ALL, while SUVI's reaches 1.667 so it
    // is. Nothing special is done to arrange that — the render loop only walks
    // the frame, so the feature's presence or absence falls out of the plate
    // scale. It is what lets the browser gate prove the 66 %-vs-100 % claim on
    // pixels rather than on arithmetic. See js/suvi-geometry.js.
    // POSITION AND WIDTH ARE BOTH SIZED, not picked. The AIA frame's on-axis
    // edge is 1.280 R☉; at x = 1.50 with σ = 0.040 that is 5.5σ away, so the
    // Gaussian contributes 6e-5 of a code value there. That is what makes the
    // AIA fixture BYTE-IDENTICAL to the one that shipped before this feature
    // existed — "absent from the AIA frame" is then a property of the file, not
    // a claim about it. Two earlier sizings are recorded because each was
    // wrong in an instructive way: σ=0.070 put 10.7 counts at the frame edge
    // (the feature was faintly VISIBLE in AIA, quietly contradicting the whole
    // point), and σ=0.045 put 0.16 counts there — which still moved 30 samples
    // by one count, because a sub-quantisation contribution ADDED TO THE
    // EXISTING HALO can still cross a rounding boundary. Estimating the
    // contribution alone is not enough; the fixture has to be diffed.
    // 3σ out is 1.620 R☉, inside SUVI's 1.667 reach, so SUVI gets all of it.
    { id: 'PROM-FAR-W', channel: '304', x: 1.50, y: 0.00, sigma: 0.040, amp: 0.80 },
]);

/**
 * Per-channel off-limb corona: amplitude at the limb and an e-folding height.
 * These are SYNTHETIC stand-ins, but they are the right order for a browse
 * product: 304 carries a bright narrow limb ring (spicule forest + prominence
 * material), the coronal channels a fainter, deeper corona, and the flare
 * channels least of all when nothing is flaring. The first version of this
 * generator used ONE faint halo (0.10·e^(−6(ρ−1))) for every AIA channel,
 * which put the 304 reference shell within a code value or two of black —
 * so js/sun-offlimb.js's calibration refused the frame and the browser gate
 * failed on 304 while passing on 131. A fixture that cannot exercise the
 * layer is not a fixture.
 */
const OFFLIMB_CORONA = Object.freeze({
    '304': { amp: 0.42, scale: 0.13 },
    '171': { amp: 0.26, scale: 0.20 },
    '193': { amp: 0.24, scale: 0.22 },
    '211': { amp: 0.22, scale: 0.22 },
    '131': { amp: 0.14, scale: 0.26 },
    '94':  { amp: 0.12, scale: 0.26 },
});

/** Fixture epoch → B0 is what the projection must apply; keep it non-zero. */
export const FIXTURE_EPOCH_ISO = '2026-09-06T12:00:00Z';

function hash2(x, y) {
    const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return s - Math.floor(s);
}
function vnoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
    return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
}

/**
 * Render one channel. Returns { width, height, rgb: Uint8Array(w*h*3), meta }.
 * meta.geom is the disk geometry in image fractions (y down) + b0Rad.
 */
export function renderSyntheticDisk(channel, { size = 512, b0Deg = -4.0 } = {}) {
    const ch = CHANNELS[String(channel)];
    if (!ch) throw new Error(`unknown channel ${channel}`);
    // A SUVI channel draws the SAME LINE as its AIA namesake (304 is He II in
    // both), so the corona profile, the planted features and the tint are
    // looked up by BAND while the geometry comes from the instrument. That
    // split is the whole fixture: same physics, different field of view.
    const band = parseSuviChannel(channel) ?? String(channel);
    const r = DISK_FRACTION[ch.instrument];
    const geom = { cx: 0.5, cy: 0.5, r, b0Rad: b0Deg * Math.PI / 180 };
    const rgb = new Uint8Array(size * size * 3);
    const spots = PLANTED.map(f => {
        const p = heliographicToVec(f.latDeg, f.lonDeg);
        const q = projectDiskUV(p, geom);
        return { ...f, px: q.u * size, py: (1 - q.v) * size, visible: q.visible,
                 radiusPx: Math.sqrt(f.areaMh / 1000) * 0.04 * size * r * 2 };
    });
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = (x + 0.5) / size - geom.cx, dy = (y + 0.5) / size - geom.cy;
            const rho = Math.sqrt(dx * dx + dy * dy) / r;          // 0 centre → 1 limb
            let R = 0, G = 0, B = 0;
            if (ch.kind === 0) {                                     // HMI continuum
                if (rho < 1) {
                    const mu = Math.sqrt(Math.max(0, 1 - rho * rho));
                    let I = 0.30 + 0.70 * mu;                          // Eddington-ish limb darkening
                    I *= 0.94 + 0.12 * (vnoise(x * 0.35, y * 0.35) - 0.5);   // granulation-ish speckle
                    for (const s of spots) {
                        if (!s.visible) continue;
                        const d = Math.hypot(x - s.px, y - s.py) / s.radiusPx;
                        if (d < 1.0) I *= 0.12 + 0.38 * Math.max(0, d - 0.5) * 2;   // umbra → penumbra
                    }
                    R = G = B = Math.round(255 * Math.min(1, I));
                }
            } else if (ch.kind === 2) {                              // HMI LOS magnetogram
                if (rho < 1) {
                    let m = 0.5 + 0.02 * (vnoise(x * 0.5, y * 0.5) - 0.5);
                    for (const s of spots) {
                        if (!s.visible) continue;
                        const d = Math.hypot(x - s.px, y - s.py) / s.radiusPx;
                        const w = Math.exp(-d * d);
                        const lead = (x - s.px) > 0 ? 1 : -1;
                        m += 0.45 * w * lead * s.polarity;
                    }
                    R = G = B = Math.round(255 * Math.min(1, Math.max(0, m)));
                }
            } else {                                                  // AIA EUV
                // Off-limb corona + any planted off-limb feature. Optically
                // thin emission is plane-of-sky, so both are drawn in ρ (the
                // plane-of-sky radius) and never projected onto the sphere.
                const oc = OFFLIMB_CORONA[band] || { amp: 0.18, scale: 0.20 };
                let halo = 0;
                if (rho >= 1) {
                    halo = oc.amp * Math.exp(-(rho - 1) / oc.scale);
                    for (const f of PLANTED_OFFLIMB) {
                        if (f.channel !== band) continue;
                        // Plane-of-sky offset in R☉: +x image right, +y image up.
                        const fx = dx / r - f.x, fy = -(dy / r) - f.y;
                        halo += f.amp * Math.exp(-(fx * fx + fy * fy) / (2 * f.sigma * f.sigma));
                    }
                }
                let I = halo;
                if (rho < 1) {
                    const mu = Math.sqrt(Math.max(0, 1 - rho * rho));
                    I = 0.30 + 0.14 * vnoise(x * 0.25, y * 0.25) + 0.30 * Math.pow(1 - mu, 3); // limb brightening
                    for (const s of spots) {
                        if (!s.visible) continue;
                        const d = Math.hypot(x - s.px, y - s.py) / (s.radiusPx * 2.2);
                        I += 0.75 * Math.exp(-d * d);                 // bright AR loops
                    }
                }
                I = Math.min(1, I);
                const tint = band === '304' ? [1.0, 0.42, 0.16]
                           : band === '171' ? [0.95, 0.72, 0.22]
                           : band === '193' ? [0.80, 0.72, 0.30]
                           : band === '195' ? [0.80, 0.72, 0.30]
                           : band === '211' ? [0.72, 0.40, 0.92]
                           : band === '284' ? [0.72, 0.40, 0.92]
                           : band === '131' ? [0.25, 0.80, 0.82]
                           :                     [0.50, 0.85, 0.50];
                R = Math.round(255 * I * tint[0]); G = Math.round(255 * I * tint[1]); B = Math.round(255 * I * tint[2]);
            }
            const o = (y * size + x) * 3;
            rgb[o] = R; rgb[o + 1] = G; rgb[o + 2] = B;
        }
    }
    return {
        width: size, height: size, rgb,
        meta: {
            synthetic: true, channel: String(channel), code: ch.code, instrument: ch.instrument,
            epoch: FIXTURE_EPOCH_ISO, b0Deg, geom: { cx: geom.cx, cy: geom.cy, r },
            planted: spots.map(s => ({ id: s.id, latDeg: s.latDeg, lonDeg: s.lonDeg, px: s.px, py: s.py, visible: s.visible })),
            band,
            plantedOffLimb: PLANTED_OFFLIMB.filter(f => f.channel === band)
                .map(f => ({ id: f.id, x: f.x, y: f.y, sigma: f.sigma })),
        },
    };
}

// ── SOHO/LASCO coronagraph frames (js/sun-coronagraph.js) ──────────────────

/**
 * ONE synthetic corona, in PLANE-OF-SKY coordinates, seen by both coronagraphs.
 * It has to be one corona: js/sun-coronagraph.js level-matches C3 to C2 on the
 * shell they share, which only means something if both frames were rendered
 * from the same sky. Position angles are the solar convention — 0 = north,
 * counter-clockwise through EAST (image left).
 *
 *   streamers — angular Gaussians riding the radial falloff
 *   cmes      — bright fronts at a known PA and radius. CME-NW sits inside
 *               C2's field (and at C3's inner edge); CME-NE is far outside
 *               C2's 6 R☉ reach, so it exists in the C3 frame only — the
 *               coronagraph analogue of the off-limb layer's PROM-FAR-W probe.
 */
export const PLANTED_CORONA = Object.freeze({
    streamers: Object.freeze([
        { id: 'STREAMER-E',  paDeg: 82,  halfWidthDeg: 7,  amp: 1.6 },
        { id: 'STREAMER-W',  paDeg: 263, halfWidthDeg: 9,  amp: 1.9 },
        { id: 'STREAMER-SW', paDeg: 215, halfWidthDeg: 5,  amp: 1.1 },
    ]),
    cmes: Object.freeze([
        { id: 'CME-NW', paDeg: 318, rho: 4.4,  sigmaRho: 0.22, halfWidthDeg: 24, amp: 2.4 },
        { id: 'CME-NE', paDeg: 48,  rho: 13.5, sigmaRho: 0.9,  halfWidthDeg: 30, amp: 3.0 },
    ]),
});

/**
 * What NASA's pipeline paints on a realtime browse frame, as this build
 * understands it (UNVERIFIED — see js/sun-coronagraph.js's header): the Sun is
 * NOT at the frame centre, the occulted region is a flat-colour disc with a
 * white circle at the solar limb, C3 has the occulter pylon to the south-east,
 * and a timestamp sits in the bottom-left corner. The occulter radii are
 * deliberately NOT the kernel's nominal 2.0 / 3.7 so the test can tell a
 * measured mask edge from a typed one.
 */
export const PLANTED_CORONAGRAPH = Object.freeze({
    c2: Object.freeze({ cx: 0.5046, cy: 0.5071, occulterRsun: 2.12, pylonPaDeg: null,
                        maskRgb: [118, 38, 16], ped: 0.10, span: 0.80, gamma: 0.55, refRho: 2.5 }),
    c3: Object.freeze({ cx: 0.5063, cy: 0.5189, occulterRsun: 3.95, pylonPaDeg: 135, pylonHalfWidthRsun: 0.55,
                        maskRgb: [28, 58, 138], ped: 0.07, span: 0.85, gamma: 0.50, refRho: 4.5 }),
});

/** Timestamp block, frame fractions (y down): bottom-left corner. */
export const CORONAGRAPH_TIMESTAMP_BOX = Object.freeze({ x0: 0.012, y0: 0.962, x1: 0.300, y1: 0.990 });

function angDiffDeg(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }

/** The synthetic corona's brightness at a plane-of-sky point, arbitrary units. */
export function syntheticCoronaAt(x, y) {
    const rho = Math.hypot(x, y);
    const pa = positionAngleDeg(x, y);
    let b = Math.pow(Math.max(rho, 1.2), -2.6);
    let s = 1;
    for (const st of PLANTED_CORONA.streamers) {
        const d = angDiffDeg(pa, st.paDeg) / st.halfWidthDeg;
        s += st.amp * Math.exp(-d * d);
    }
    b *= s;
    for (const c of PLANTED_CORONA.cmes) {
        const dr = (rho - c.rho) / c.sigmaRho, da = angDiffDeg(pa, c.paDeg) / c.halfWidthDeg;
        b += c.amp * Math.pow(c.rho, -2.6) * Math.exp(-0.5 * dr * dr) * Math.exp(-da * da);
    }
    return b;
}

/**
 * Render one coronagraph browse frame. Returns { width, height, rgb, meta }.
 * meta.geom is in frame fractions (y down); meta carries every planted truth.
 */
export function renderSyntheticCoronagraph(id, { size = 512, epoch = FIXTURE_EPOCH_ISO } = {}) {
    const inst = coronagraph(id);
    const P = PLANTED_CORONAGRAPH[inst.id];
    const r = expectedRsunFrac(inst.id, new Date(epoch));        // R☉ as a fraction of the frame
    const rgb = new Uint8Array(size * size * 3);
    const lineHalf = Math.max(0.55, 0.8 * size / 1024);          // limb circle half-width, px
    const refB = Math.pow(P.refRho, -2.6);
    const tb = CORONAGRAPH_TIMESTAMP_BOX;
    const blue = inst.id === 'c3';
    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            const u = (px + 0.5) / size, v = (py + 0.5) / size;
            const x = (u - P.cx) / r, y = (P.cy - v) / r;           // plane of sky, R☉, north up
            const rho = Math.hypot(x, y);
            let R, G, B;
            if (rho < P.occulterRsun) {
                [R, G, B] = P.maskRgb;
                // White limb circle, antialiased.
                const dPx = Math.abs(rho - 1) * r * size;
                const cov = Math.min(1, Math.max(0, lineHalf + 0.5 - dPx));
                R += (255 - R) * cov; G += (255 - G) * cov; B += (255 - B) * cov;
            } else {
                let I = P.ped + P.span * Math.min(1, Math.pow(syntheticCoronaAt(x, y) / refB, P.gamma) * 0.9);
                I *= 0.985 + 0.03 * vnoise(px * 0.21 * 512 / size, py * 0.21 * 512 / size);
                if (P.pylonPaDeg != null) {
                    // The pylon: a dark band of constant half-width along one PA.
                    const a = (positionAngleDeg(x, y) - P.pylonPaDeg) * Math.PI / 180;
                    const along = rho * Math.cos(a), across = Math.abs(rho * Math.sin(a));
                    if (along > 0 && across < P.pylonHalfWidthRsun) I = P.ped * 0.35;
                }
                I = Math.min(1, Math.max(0, I));
                if (blue) { R = 255 * Math.pow(I, 1.8) * 0.75; G = 255 * Math.pow(I, 1.2) * 0.85; B = 255 * Math.pow(I, 0.55); }
                else      { R = 255 * Math.pow(I, 0.60);       G = 255 * Math.pow(I, 1.1) * 0.85; B = 255 * Math.pow(I, 2.2) * 0.60; }
                // A few stars in the wide field (C3 really does show them).
                if (blue && hash2(px * 1.7 + 3.1, py * 2.3 + 9.7) > 0.9994 * (1 - 0.0002 * 512 / size)) { R = G = B = 235; }
            }
            // Timestamp-like block: white glyph bars on the frame, bottom-left.
            if (u >= tb.x0 && u <= tb.x1 && v >= tb.y0 && v <= tb.y1) {
                const col = Math.floor((u - tb.x0) / (tb.x1 - tb.x0) * 48);
                if (col % 3 !== 2 && hash2(col, 7.0) > 0.25) { R = G = B = 250; }
            }
            const o = (py * size + px) * 3;
            rgb[o] = Math.round(R); rgb[o + 1] = Math.round(G); rgb[o + 2] = Math.round(B);
        }
    }
    return {
        width: size, height: size, rgb,
        meta: {
            synthetic: true, channel: inst.id, instrument: 'lasco', label: inst.label,
            epoch, geom: { cx: P.cx, cy: P.cy, r },
            occulterRsun: P.occulterRsun, pylonPaDeg: P.pylonPaDeg,
            timestampBox: { ...tb },
            streamers: PLANTED_CORONA.streamers.map(s => ({ ...s })),
            cmes: PLANTED_CORONA.cmes.map(c => ({ ...c })),
        },
    };
}

/** RGB (3 bytes/px) → RGBA (4 bytes/px), the layout the kernels read. */
export function toRgba(rgb, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let i = 0, j = 0; j < w * h; i += 3, j++) { out[j * 4] = rgb[i]; out[j * 4 + 1] = rgb[i + 1]; out[j * 4 + 2] = rgb[i + 2]; out[j * 4 + 3] = 255; }
    return out;
}

/** Luminance array from an rgb buffer (Rec.601). */
export function toGray(rgb, w, h) {
    const g = new Float32Array(w * h);
    for (let i = 0, j = 0; j < g.length; i += 3, j++) g[j] = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2];
    return g;
}

// ── Minimal PNG encoder (8-bit RGB, no filter) ─────────────────────────────
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
    return Buffer.concat([len, td, crc]);
}
export function encodePng({ width, height, rgb }) {
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0;                                   // filter: none
        Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
