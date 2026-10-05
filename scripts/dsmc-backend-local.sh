#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# dsmc-backend-local.sh — the DSMC API for tests/upper-atmosphere-e2e.spec.js,
# WITHOUT Docker.
#
# The e2e suite runs in CI against dsmc/docker-compose.ci.yml (see
# .github/workflows/dsmc-e2e.yml). On a machine with no Docker daemon (a cloud
# sandbox, a laptop without Docker Desktop) this does the same two steps
# natively: seed the MSIS bootstrap SPARTA tables on the CI's small grid, then
# serve pipeline.serve_drag on :8001 with the same environment.
#
#   scripts/dsmc-backend-local.sh            # start in the background, wait for /health
#   scripts/dsmc-backend-local.sh stop       # stop it
#   npx playwright test tests/upper-atmosphere-e2e.spec.js
#
# State lives in $DSMC_LOCAL_DIR (default: .dsmc-local/, git-ignored): the
# venv, the seeded tables, the pid file and the log.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${DSMC_LOCAL_DIR:-$ROOT/.dsmc-local}"
PORT="${DSMC_PORT:-8001}"
VENV="$DIR/venv"
TABLES="$DIR/tables"
PIDFILE="$DIR/api.pid"
LOG="$DIR/api.log"

# The CI compose's environment (dsmc/docker-compose.ci.yml), verbatim.
export TZ=UTC LOG_LEVEL=INFO ALLOW_ORIGINS='*' API_KEYS=''
export SPARTA_TABLES_DIR="$TABLES"
export SPARTA_GRID_ALTS="200 400 600 900"
export SPARTA_GRID_F107="100 150 200"
export SPARTA_GRID_AP="10 30 100"

if [[ "${1:-start}" == "stop" ]]; then
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        pid="$(cat "$PIDFILE")"
        # uvicorn's graceful shutdown waits on the in-process Belay ingest
        # loop, which (with NOAA unreachable) can hold it open indefinitely:
        # ask nicely, then insist.
        kill "$pid" 2>/dev/null || true
        for _ in $(seq 1 10); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
        echo "stopped DSMC API (pid $pid)"
    else
        echo "DSMC API not running"
    fi
    rm -f "$PIDFILE"
    exit 0
fi

if curl -fs "http://localhost:$PORT/health" >/dev/null 2>&1; then
    echo "DSMC API already answering on :$PORT"
    exit 0
fi

mkdir -p "$DIR" "$TABLES"
if [[ ! -x "$VENV/bin/python" ]]; then
    echo "creating venv in $VENV"
    python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q -r "$ROOT/dsmc/pipeline/requirements.txt"

if ! ls "$TABLES"/*.csv >/dev/null 2>&1; then
    echo "seeding bootstrap SPARTA tables (MSIS fallback)"
    (cd "$ROOT/dsmc" && "$VENV/bin/python" sparta/generate_tables.py --use-msis-fallback) >>"$LOG" 2>&1
fi

echo "starting DSMC API on :$PORT (log: $LOG)"
# `exec` so the background job IS the server: $! is then uvicorn's own pid
# (without it the pid file named a wrapper subshell and `stop` missed the
# server), and no fd of this script's stdout survives in it — a caller piping
# this script (`… | tail`) would otherwise wait on the server forever.
( cd "$ROOT/dsmc" && exec "$VENV/bin/python" -m uvicorn pipeline.serve_drag:app \
    --host 127.0.0.1 --port "$PORT" >>"$LOG" 2>&1 </dev/null ) &
echo $! >"$PIDFILE"

for _ in $(seq 1 60); do
    if curl -fs "http://localhost:$PORT/health" >/dev/null 2>&1; then
        echo "DSMC API up (pid $(cat "$PIDFILE"))"
        exit 0
    fi
    sleep 1
done
echo "DSMC API did not answer /health within 60 s — see $LOG" >&2
exit 1
