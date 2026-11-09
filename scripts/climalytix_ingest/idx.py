"""idx.py — NOAA GRIB2 `.idx` sidecar parser and byte-range planner.

PURE (no network, no eccodes). CLIMALYTIX_PLAN.md §17: we never download a
whole GRIB2 file; the `.idx` sidecar names every message and its byte offset,
so one HTTP Range request fetches exactly the field we want.

TWO THINGS HERE WERE MEASURED ON REAL FILES (2026-11-08, GFS 2026110700) AND
EACH FAILS SILENTLY IF IGNORED — the fixtures under tests/fixtures/climalytix/gfs/
are those real files and the gate pins both. (The offset is read as the field
just before `d=` rather than "field 2" so a wgrib2-style inventory with
sub-message numbers parses the same way; both GFS grids use `n:offset:d=…`.)

  1. A FIELD CAN APPEAR TWICE WITH DIFFERENT MEANINGS. Every forecast file
     lists TCDC "entire atmosphere" as an instantaneous value AND as an
     average over the bucket, and APCP twice (f009: "6-9 hour acc" and
     "0-9 hour acc"). First-match on var+level picks whichever NCEP printed
     first. Selection is by the full time descriptor.

  2. PRECIPITATION IS ACCUMULATED IN RESETTING BUCKETS. f003 = 0-3 h,
     f006 = 0-6 h, f009 = 6-9 h, f012 = 6-12 h; past f120 the buckets are
     6 h but the files are still 3-hourly (f237 = 234-237, f240 = 234-240),
     and f240 also carries "0-10 day acc". The 3-hour amount ending at lead L
     is the window (a, L) with the LATEST start a ≤ L − step, minus the
     previous file's (a, L − step) when a < L − step. `plan_accumulation`
     returns that subtraction explicitly so the caller cannot forget it.

  3. FLUXES ARE AVERAGED IN THE SAME RESETTING BUCKETS (SHTFL, DSWRF: f003
     "0-3 hour ave", f006 "0-6 hour ave", f009 "6-9 hour ave"…). An AVERAGE
     is not an amount: the 3-hour mean over (3, 6] is (6·avg(0-6) −
     3·avg(0-3)) / 3, NOT avg(0-6) − avg(0-3) — the plain difference is the
     gate's negative control. `plan_accumulation(kind='ave')` plans the same
     windows and `step_value` does the arithmetic for either kind.
"""

from __future__ import annotations

import re

_FCST_INST = re.compile(r'^(\d+) hour fcst$')
_FCST_WIN = re.compile(r'^(\d+)-(\d+) (hour|day) (acc|ave|max|min) fcst$')


def parse_idx(text):
    """Parse an .idx file into entries ordered as written.

    Each entry: {n, offset, end, date, var, level, fcst}. `end` is the byte
    AFTER the message (exclusive) or None for the last message (open range).
    Messages that share an offset (sub-messages) get the next LARGER offset as
    their end, so a range never comes back empty.
    """
    rows = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split(':')
        try:
            di = next(i for i, p in enumerate(parts) if p.startswith('d='))
        except StopIteration:
            raise ValueError(f'idx line without d= field: {line!r}')
        if di < 2:
            raise ValueError(f'idx line has no offset before d=: {line!r}')
        rows.append({
            'n': parts[0],
            'offset': int(parts[di - 1]),
            'date': parts[di][2:],
            'var': parts[di + 1],
            'level': parts[di + 2],
            'fcst': parts[di + 3] if len(parts) > di + 3 else '',
        })
    offsets = sorted({r['offset'] for r in rows})
    nxt = {o: (offsets[i + 1] if i + 1 < len(offsets) else None) for i, o in enumerate(offsets)}
    for r in rows:
        r['end'] = nxt[r['offset']]
    return rows


def describe(fcst):
    """Classify a time descriptor: ('anl', 0, 0) · ('inst', L, L) ·
    (kind, a_h, b_h) for windows ('acc' | 'ave' | 'max' | 'min'), hours."""
    if fcst == 'anl':
        return ('anl', 0, 0)
    m = _FCST_INST.match(fcst)
    if m:
        h = int(m.group(1))
        return ('inst', h, h)
    m = _FCST_WIN.match(fcst)
    if m:
        mul = 24 if m.group(3) == 'day' else 1
        return (m.group(4), int(m.group(1)) * mul, int(m.group(2)) * mul)
    return ('other', None, None)


def find_instant(entries, var, level, lead_h):
    """The INSTANTANEOUS message for var/level at lead (the analysis at 0)."""
    for e in entries:
        if e['var'] != var or e['level'] != level:
            continue
        kind, a, b = describe(e['fcst'])
        if lead_h == 0 and kind == 'anl':
            return e
        if kind == 'inst' and b == lead_h:
            return e
    return None


def windows(entries, var, level, kind='acc'):
    """{(a_h, b_h): first entry} for every `kind` window of var/level."""
    out = {}
    for e in entries:
        if e['var'] != var or e['level'] != level:
            continue
        k, a, b = describe(e['fcst'])
        if k == kind and (a, b) not in out:
            out[(a, b)] = e
    return out


def plan_accumulation(entries, var, level, lead_h, step_h, kind='acc'):
    """How to get the `step_h` amount (kind 'acc') or mean ('ave') ending at lead_h.

    Returns {'take': (a, L), 'minus': (a, L - step) | None, 'entry': e} or
    None when the file carries no usable window (f000 has no APCP at all).
    The `minus` window lives in the PREVIOUS lead's file.
    """
    if lead_h - step_h < 0:
        return None
    wins = windows(entries, var, level, kind)
    start = lead_h - step_h
    cands = [(a, b) for (a, b) in wins if b == lead_h and a <= start]
    if not cands:
        return None
    a, b = max(cands)   # the LATEST start: the bucket that resets most recently
    return {'take': (a, b), 'minus': None if a == start else (a, start), 'entry': wins[(a, b)]}


def step_value(take_val, take, minus_val, minus, kind, step_h):
    """The `step_h` value ending at the take window's end, from a plan.

    'acc': take − minus (amounts subtract).  'ave': averages are turned back
    into integrals first — (take·len(take) − minus·len(minus)) / step_h.
    Works on scalars or numpy arrays. `minus` None ⇒ the take window IS the
    step and its value is returned as is.
    """
    if minus is None:
        return take_val
    a, b = take
    a2, b2 = minus
    if a2 != a or (b - a) - (b2 - a2) != step_h:
        raise ValueError(f'windows {take} and {minus} do not differ by one {step_h} h step')
    if kind == 'acc':
        return take_val - minus_val
    if kind == 'ave':
        return (take_val * (b - a) - minus_val * (b2 - a2)) / step_h
    raise ValueError(f'unknown window kind {kind!r}')


def merge_ranges(entries, gap=0):
    """Byte ranges covering `entries`, merging touching/adjacent messages.

    Returns [(start, end_exclusive_or_None, [entries…])] sorted by start. A
    gap > 0 also merges ranges whose separation is ≤ gap bytes (fewer
    requests for a little extra transfer).
    """
    uniq = sorted({e['offset']: e for e in entries}.values(), key=lambda e: e['offset'])
    out = []
    for e in uniq:
        if out and out[-1][1] is not None and e['offset'] - out[-1][1] <= gap:
            s, _, members = out[-1]
            out[-1] = (s, e['end'], members + [e])
        else:
            out.append((e['offset'], e['end'], [e]))
    return out


def range_header(start, end):
    """HTTP Range header value; `end` is exclusive (None = to end of file)."""
    return f'bytes={start}-' if end is None else f'bytes={start}-{end - 1}'
