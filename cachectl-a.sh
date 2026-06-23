#!/usr/bin/env bash
# cachectl-a.sh — control the Option A zero-dep Node cache proxy.
#   ./cachectl-a.sh on | off | stop | stats
# Reads ANTHROPIC_API_KEY_REAL from ./.env (gitignored).
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && { set -a; . ./.env; set +a; }
PORT="${CACHE_PORT:-4000}"
PIDFILE="$HOME/.llm-cache-a/proxy.pid"
METRICS="$HOME/.llm-cache-a/metrics.jsonl"
mkdir -p "$HOME/.llm-cache-a"

_stop() { [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; pkill -f 'proxy-a.mjs' 2>/dev/null || true; }

_start() {
  if [ -z "${ANTHROPIC_API_KEY_REAL:-}" ]; then
    echo "ERROR: ANTHROPIC_API_KEY_REAL not set (put it in ./.env)." >&2; exit 1
  fi
  _stop; sleep 1
  echo "Starting Option A proxy on :$PORT (cache $1) ..."
  CACHE_OFF="$2" nohup node proxy-a.mjs > "$HOME/.llm-cache-a/proxy.log" 2>&1 &
  echo $! > "$PIDFILE"
  for i in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/health" 2>/dev/null || true)
    [ "$code" = "200" ] && { echo "READY after ${i}s (pid $(cat "$PIDFILE"))."; break; }
    kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "proxy died — see ~/.llm-cache-a/proxy.log" >&2; cat "$HOME/.llm-cache-a/proxy.log"; return 1; }
    sleep 1
  done
  echo "Point Claude Code at it:"
  echo "  export ANTHROPIC_BASE_URL=http://localhost:$PORT"
  echo "  export ANTHROPIC_API_KEY=anything   # Option A ignores client key; uses .env real key"
}

case "${1:-}" in
  on)   _start ON "0" ;;
  off)  _start OFF "1" ;;     # bypass: forwards everything, caches nothing
  stop) _stop; echo "stopped." ;;
  stats)
    [ -f "$METRICS" ] || { echo "no metrics yet ($METRICS)"; exit 0; }
    node -e '
      const fs=require("fs");
      const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const hit=L.filter(x=>x.event==="hit"), miss=L.filter(x=>x.event==="miss"), err=L.filter(x=>x.event==="error");
      const calls=hit.length+miss.length;
      const savedIn=hit.reduce((s,x)=>s+(x.in||0),0), savedOut=hit.reduce((s,x)=>s+(x.out||0),0);
      const usd=savedIn*15e-6+savedOut*75e-6;  // Opus list; adjust per model
      console.log(`calls ${calls}  hits ${hit.length}  hit_rate ${calls?(100*hit.length/calls).toFixed(1):0}%  errors ${err.length}`);
      console.log(`tokens_saved ${savedIn+savedOut} (in ${savedIn}/out ${savedOut})  ~usd_saved(Opus) $${usd.toFixed(4)}`);
    ' "$METRICS" ;;
  *) echo "usage: $0 {on|off|stop|stats}"; exit 1 ;;
esac
