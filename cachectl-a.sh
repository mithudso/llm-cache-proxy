#!/usr/bin/env bash
# cachectl-a.sh — control the Option A zero-dep Node cache proxy.
#   ./cachectl-a.sh on | off | stop | stats | status
# Reads ANTHROPIC_API_KEY_REAL from ./.env (gitignored).
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && { set -a; . ./.env; set +a; }
PORT="${CACHE_PORT:-4000}"
PIDFILE="$HOME/.llm-cache-a/proxy.pid"
METRICS="$HOME/.llm-cache-a/metrics.jsonl"
LOGFILE="$HOME/.llm-cache-a/proxy.log"
mkdir -p "$HOME/.llm-cache-a"

_stop() { [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; pkill -f 'proxy-a.mjs' 2>/dev/null || true; }

_start() {
  if [ -z "${ANTHROPIC_API_KEY_REAL:-}" ]; then
    echo "ERROR: ANTHROPIC_API_KEY_REAL not set (put it in ./.env)." >&2; exit 1
  fi
  _stop; sleep 1
  echo "Starting Option A proxy on :$PORT (cache $1) ..."
  CACHE_OFF="$2" nohup node proxy-a.mjs > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  for i in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/health" 2>/dev/null || true)
    [ "$code" = "200" ] && { echo "READY after ${i}s (pid $(cat "$PIDFILE"))."; break; }
    kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "proxy died — see $LOGFILE" >&2; cat "$LOGFILE"; return 1; }
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
    # Prefer the live /stats endpoint (this-session + all-time); fall back to the metrics log.
    live=$(curl -s "http://localhost:$PORT/stats" 2>/dev/null || true)
    if [ -n "$live" ]; then
      printf '%s' "$live" | node -e '
        let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
          let j; try { j = JSON.parse(s); } catch { console.log(s); return; }
          const f = (o) => `calls ${o.calls}  hits ${o.hits}  coalesced ${o.coalesced}  misses ${o.misses}  errors ${o.errors}  hit_rate ${o.hit_rate_pct}%\n    tokens_saved ${o.tokens_saved}  usd_saved $${o.usd_saved}  usd_spent $${o.usd_spent}  savings ${o.savings_pct}%`;
          console.log(`cache: ${j.cache}   uptime: ${j.uptime_s}s`);
          console.log(`-- this session --\n    ${f(j.session)}`);
          console.log(`-- all time (incl. restarts) --\n    ${f(j)}`);
        });
      ' && exit 0
    fi
    [ -f "$METRICS" ] || { echo "no metrics yet ($METRICS); proxy not running"; exit 0; }
    echo "(proxy not running — all-time totals from the ledger; start it for live session stats)"
    node -e '
      const fs=require("fs");
      const PR={haiku:[0.8e-6,4e-6],sonnet:[3e-6,15e-6],opus:[15e-6,75e-6]};
      const price=m=>{m=(m||"").toLowerCase();for(const k in PR)if(m.includes(k))return PR[k];return [15e-6,75e-6];};
      const L=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
      const hit=L.filter(x=>x.event==="hit"), miss=L.filter(x=>x.event==="miss"), err=L.filter(x=>x.event==="error");
      const calls=hit.length+miss.length;
      const savedIn=hit.reduce((s,x)=>s+(x.in||0),0), savedOut=hit.reduce((s,x)=>s+(x.out||0),0);
      const savedUsd=hit.reduce((s,x)=>{const[pi,po]=price(x.model);return s+(x.in||0)*pi+(x.out||0)*po;},0);
      console.log(`calls ${calls}  hits ${hit.length}  hit_rate ${calls?(100*hit.length/calls).toFixed(1):0}%  errors ${err.length}`);
      console.log(`tokens_saved ${savedIn+savedOut} (in ${savedIn}/out ${savedOut})  usd_saved(per-model) $${savedUsd.toFixed(4)}`);
    ' "$METRICS" ;;
  status)
    # Live operational snapshot: running? on/off? accepting calls? last call? errors/logs this run.
    echo "== llm-cache-proxy status (:$PORT) =="

    # 1) process up?
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      pid=$(cat "$PIDFILE")
      since=$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//' || true)
      echo "process:         RUNNING (pid $pid${since:+, since $since})"
    else
      echo "process:         NOT RUNNING (no live pid in $PIDFILE)"
    fi

    # 2) accepting calls? (and 3) cache on/off) — straight from the live endpoints
    live=$(curl -s "http://localhost:$PORT/stats" 2>/dev/null || true)
    health=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/health" 2>/dev/null || true)
    if [ "$health" = "200" ]; then
      echo "accepting calls: YES (GET /health -> 200)"
    else
      case "$health" in ""|000) health="no response" ;; esac
      echo "accepting calls: NO (GET /health -> $health)"
    fi
    if [ -n "$live" ]; then
      mode=$(printf '%s' "$live" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).cache)}catch{console.log("unknown")}})' 2>/dev/null || echo unknown)
      echo "cache mode:      ${mode:-unknown}  (on = replaying hits, off = bypass/forward-only)"
    else
      echo "cache mode:      unknown (proxy not reachable)"
    fi

    # 4) last call received — newest timestamp in the metrics ledger
    if [ -s "$METRICS" ]; then
      last_t=$(tail -n 1 "$METRICS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).t||""))}catch{}})' 2>/dev/null || true)
      if [ -n "$last_t" ]; then
        last_iso=$(node -e 'console.log(new Date(+process.argv[1]).toISOString())' "$last_t" 2>/dev/null || true)
        echo "last call:       ${last_iso:-$last_t}"
      else
        echo "last call:       (none recorded)"
      fi
    else
      echo "last call:       (none recorded)"
    fi

    # 5) errors + logs emitted since this process started (proxy.log is truncated on each start)
    if [ -f "$LOGFILE" ]; then
      errs=$(grep -c '^ERR' "$LOGFILE" 2>/dev/null || true); errs=${errs:-0}
      echo "errors this run: $errs"
      if [ "$errs" -gt 0 ]; then
        echo "  -- recent errors --"
        grep '^ERR' "$LOGFILE" | tail -n 5 | sed 's/^/  /'
      fi
      echo "  -- recent log (last 15 lines of $LOGFILE) --"
      tail -n 15 "$LOGFILE" | sed 's/^/  /'
    else
      echo "errors this run: (no log file at $LOGFILE — proxy not started via cachectl-a.sh?)"
    fi ;;
  *) echo "usage: $0 {on|off|stop|stats|status}"; exit 1 ;;
esac
