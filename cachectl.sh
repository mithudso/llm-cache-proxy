#!/usr/bin/env bash
# cachectl.sh — control the local LiteLLM Anthropic cache.
#   ./cachectl.sh on      start proxy WITH caching   (config.yaml)
#   ./cachectl.sh off     start proxy WITHOUT caching (bypass, config.nocache.yaml)
#   ./cachectl.sh stop    stop the proxy
#   ./cachectl.sh stats   print hit-rate + tokens/$ saved from metrics.db
#
# Requires ANTHROPIC_API_KEY_REAL in the environment (your real Anthropic key).
set -euo pipefail
cd "$(dirname "$0")"
# Load the real Anthropic key from a gitignored .env (single source of truth).
# Put ANTHROPIC_API_KEY_REAL=sk-ant-... in ./.env once; no need to re-export.
[ -f .env ] && { set -a; . ./.env; set +a; }
PORT="${CACHE_PORT:-4000}"
PIDFILE="$HOME/.llm-cache/proxy.pid"
DB="$HOME/.llm-cache/metrics.db"
mkdir -p "$HOME/.llm-cache"

_start() {
  local cfg="$1"
  if [ -z "${ANTHROPIC_API_KEY_REAL:-}" ]; then
    echo "ERROR: set ANTHROPIC_API_KEY_REAL (your real Anthropic key) first." >&2
    exit 1
  fi
  _stop_quiet
  echo "Starting LiteLLM proxy on :$PORT with $cfg (litellm startup takes ~60-90s) ..."
  # LITELLM_LOCAL_MODEL_COST_MAP=True skips a blocking GitHub fetch on startup
  # (the ~87s import hang); feedback box off for clean logs.
  PYTHONPATH=. LITELLM_LOCAL_MODEL_COST_MAP=True LITELLM_DONT_SHOW_FEEDBACK_BOX=True \
    nohup ./.venv/bin/litellm --config "$cfg" --port "$PORT" \
    >"$HOME/.llm-cache/proxy.log" 2>&1 &
  echo $! > "$PIDFILE"
  # Wait for the port to actually bind (real readiness, not a bogus sleep).
  for i in $(seq 1 120); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/health/liveliness" 2>/dev/null)
    [ -n "$code" ] && [ "$code" != "000" ] && { echo "Proxy READY after ${i}s (pid $(cat "$PIDFILE"))."; break; }
    kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "Proxy process died on startup — see $HOME/.llm-cache/proxy.log" >&2; return 1; }
    sleep 1
  done
  echo "Point Claude Code at it:"
  echo "  export ANTHROPIC_BASE_URL=http://localhost:$PORT"
  echo "  export ANTHROPIC_API_KEY=sk-local-cache"
}

_stop_quiet() { [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; }

case "${1:-}" in
  on)   _start config.yaml ;;
  off)  _start config.nocache.yaml ;;
  stop) _stop_quiet; echo "Proxy stopped." ;;
  stats)
    [ -f "$DB" ] || { echo "No metrics yet ($DB)."; exit 0; }
    sqlite3 "$DB" <<'SQL'
.mode column
.headers on
SELECT
  COUNT(*)                                  AS calls,
  SUM(cache_hit)                            AS hits,
  printf('%.1f%%', 100.0*SUM(cache_hit)/COUNT(*)) AS hit_rate,
  SUM(saved_in+saved_out)                   AS tokens_saved,
  printf('$%.2f', SUM(saved_usd))           AS usd_saved
FROM calls;
SELECT kind, COUNT(DISTINCT seg_hash) AS uniq, COUNT(*) AS seen,
       printf('%.0f', AVG(tok)) AS avg_tok
FROM segments GROUP BY kind;
SQL
    ;;
  *) echo "usage: $0 {on|off|stop|stats}"; exit 1 ;;
esac
