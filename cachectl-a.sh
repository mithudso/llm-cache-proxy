#!/usr/bin/env bash
# cachectl-a.sh — control the Option A zero-dep Node cache proxy.
#   ./cachectl-a.sh on | off | stop | stats | status | monitor | explore
#                   setup | run | install | uninstall | -h|--help (full guide: USAGE.md)
# Reads ANTHROPIC_API_KEY_REAL (+ other CACHE_* settings) from ./.env (gitignored).
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] && { set -a; . ./.env; set +a; }
PORT="${CACHE_PORT:-4000}"
PIDFILE="$HOME/.llm-cache-a/proxy.pid"
METRICS="$HOME/.llm-cache-a/metrics.jsonl"
LOGFILE="$HOME/.llm-cache-a/proxy.log"
REPO="$(cd "$(dirname "$0")" && pwd)"
PROXY="$REPO/proxy-a.mjs"
NODE_BIN="$(command -v node || echo node)"
# control-plane curls must carry the auth token when one is configured (proxy enforces it)
AUTH_HDR=(); [ -n "${CACHE_AUTH_TOKEN:-}" ] && AUTH_HDR=(-H "x-cache-auth: ${CACHE_AUTH_TOKEN}")
mkdir -p "$HOME/.llm-cache-a"

_stop() {
  # On macOS with a launchd agent installed, unload the plist first so launchd
  # doesn't immediately restart the process we're about to kill (→ EADDRINUSE race).
  local PL="$HOME/Library/LaunchAgents/com.llm-cache-proxy.plist"
  if command -v launchctl >/dev/null 2>&1 && [ -f "$PL" ]; then
    launchctl unload "$PL" 2>/dev/null || true
  fi
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
  pkill -f 'proxy-a.mjs' 2>/dev/null || true
  # Wait up to 5s for the port to be free before returning
  for _i in 1 2 3 4 5; do
    lsof -ti :"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
  done
}

# First-run wizard: prompt for the key + core settings and write a chmod-600 .env.
_setup() {
  echo "== llm-cache-proxy setup =="
  if [ -f .env ] && grep -q '^ANTHROPIC_API_KEY_REAL=' .env; then
    echo ".env already has ANTHROPIC_API_KEY_REAL (edit ./.env to change). Nothing to do."; return 0
  fi
  printf "Anthropic API key (sk-ant-...): "; read -r KEY
  [ -n "$KEY" ] || { echo "no key entered — aborting." >&2; return 1; }
  printf "Port [4000]: ";               read -r P; P="${P:-4000}"
  printf "Cache TTL seconds [604800]: "; read -r T; T="${T:-604800}"
  printf "Max cache entries [5000]: ";   read -r M; M="${M:-5000}"
  printf "Bind host [127.0.0.1] (0.0.0.0 exposes it to the network — needs a token): "; read -r H; H="${H:-127.0.0.1}"
  TOK=""
  case "$H" in
    127.0.0.1|::1|localhost) ;;
    *) printf "Auth token (required for a non-loopback host) [random]: "; read -r TOK
       [ -n "$TOK" ] || TOK=$("$NODE_BIN" -e 'process.stdout.write(require("crypto").randomBytes(18).toString("hex"))')
       echo "  clients must send  x-cache-auth: $TOK" ;;
  esac
  ( umask 077
    {
      echo "ANTHROPIC_API_KEY_REAL=$KEY"
      echo "CACHE_PORT=$P"
      echo "CACHE_TTL_SEC=$T"
      echo "CACHE_MAX_ENTRIES=$M"
      echo "CACHE_HOST=$H"
      [ -n "$TOK" ] && echo "CACHE_AUTH_TOKEN=$TOK"
      echo "# CACHE_LOG_LEVEL=info     # silent|error|info|debug"
      echo "# CACHE_LOG_FILE=$HOME/.llm-cache-a/proxy.log   # or 'none'"
    } > .env )
  chmod 600 .env
  echo "Wrote ./.env (chmod 600, gitignored). Start it with:  $0 on"
}

# Install a boot service that auto-restarts on failure (systemd on Linux, launchd on macOS).
_install() {
  [ -n "${ANTHROPIC_API_KEY_REAL:-}" ] || { echo "set up .env first:  $0 setup" >&2; exit 1; }
  if command -v systemctl >/dev/null 2>&1; then
    UNIT="$HOME/.config/systemd/user/llm-cache-proxy.service"; mkdir -p "$(dirname "$UNIT")"
    cat > "$UNIT" <<U
[Unit]
Description=llm-cache-proxy (Anthropic caching reverse proxy)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO
EnvironmentFile=$REPO/.env
ExecStart=$NODE_BIN $PROXY
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
U
    systemctl --user daemon-reload
    systemctl --user enable --now llm-cache-proxy.service
    loginctl enable-linger "$USER" >/dev/null 2>&1 || true   # let it start at boot before login
    echo "installed systemd user service (start-on-boot + restart-on-failure)."
    echo "  systemctl --user status llm-cache-proxy"
  elif command -v launchctl >/dev/null 2>&1; then
    PL="$HOME/Library/LaunchAgents/com.llm-cache-proxy.plist"; mkdir -p "$(dirname "$PL")"
    cat > "$PL" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.llm-cache-proxy</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>-lc</string><string>cd $REPO && set -a && . ./.env && set +a && echo \$\$ > $HOME/.llm-cache-a/proxy.pid && exec $NODE_BIN $PROXY</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$LOGFILE</string>
  <key>StandardErrorPath</key><string>$LOGFILE</string>
</dict></plist>
P
    launchctl unload "$PL" 2>/dev/null || true
    launchctl load -w "$PL"
    echo "installed launchd agent (RunAtLoad + restart-on-failure)."
    echo "  launchctl list | grep llm-cache-proxy"
  else
    echo "no systemctl or launchctl on this OS — cannot install a boot service." >&2; exit 1
  fi
}

_uninstall() {
  UNIT="$HOME/.config/systemd/user/llm-cache-proxy.service"
  PL="$HOME/Library/LaunchAgents/com.llm-cache-proxy.plist"
  if command -v systemctl >/dev/null 2>&1 && [ -f "$UNIT" ]; then
    systemctl --user disable --now llm-cache-proxy.service 2>/dev/null || true
    rm -f "$UNIT"; systemctl --user daemon-reload; echo "removed systemd user service."
  elif command -v launchctl >/dev/null 2>&1 && [ -f "$PL" ]; then
    launchctl unload "$PL" 2>/dev/null || true; rm -f "$PL"; echo "removed launchd agent."
  else
    echo "no installed service found."
  fi
}

# Validate config files for syntax + run quick liveness checks if the proxy is up.
_validate() {
  local errors=0 warns=0
  echo "== llm-cache-proxy validate =="
  echo ""
  echo "Config:"

  # .env
  local env_path="$REPO/.env"
  [ -f "$env_path" ] && echo "  env file: $env_path" || echo "  env file: (not found at $env_path)"

  if [ -z "${ANTHROPIC_API_KEY_REAL:-}" ]; then
    echo "  ✗ ANTHROPIC_API_KEY_REAL — not set (run: $0 setup)"
    errors=$((errors+1))
  else
    case "${ANTHROPIC_API_KEY_REAL}" in
      sk-ant-*) echo "  ✓ ANTHROPIC_API_KEY_REAL — set (${ANTHROPIC_API_KEY_REAL:0:14}****)" ;;
      *)        echo "  ! ANTHROPIC_API_KEY_REAL — set but doesn't start with sk-ant-..."
                warns=$((warns+1)) ;;
    esac
  fi

  local cache_port="${CACHE_PORT:-4000}"
  case "$cache_port" in
    ''|*[!0-9]*) echo "  ✗ CACHE_PORT=$cache_port — not a number" ; errors=$((errors+1)) ;;
    *) if [ "$cache_port" -ge 1 ] 2>/dev/null && [ "$cache_port" -le 65535 ] 2>/dev/null; then
         echo "  ✓ CACHE_PORT=$cache_port"
       else
         echo "  ✗ CACHE_PORT=$cache_port — out of range (1-65535)" ; errors=$((errors+1))
       fi ;;
  esac

  echo "  ✓ CACHE_HOST=${CACHE_HOST:-127.0.0.1}"
  [ -n "${CACHE_AUTH_TOKEN:-}" ] && echo "  ✓ CACHE_AUTH_TOKEN — set (token-gated exposure enabled)"

  # normalize.json
  local NORM="$HOME/.llm-cache-a/normalize.json"
  if [ -f "$NORM" ]; then
    local norm_err
    norm_err=$("$NODE_BIN" -e "
      try {
        const raw = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
        for (const f of ['system_strip','message_strip']) {
          const a = raw[f];
          if (a !== undefined && !Array.isArray(a)) throw new Error(f + ' must be an array');
          if (Array.isArray(a)) a.forEach(p => {
            try { new RegExp(p, 'gs'); }
            catch(e) { throw new Error('invalid regex in ' + f + ': ' + JSON.stringify(p)); }
          });
        }
        if (raw.suffix_turns !== undefined && (typeof raw.suffix_turns !== 'number' || raw.suffix_turns < 1))
          throw new Error('suffix_turns must be a positive number');
        const sc=(raw.system_strip||[]).length, mc=(raw.message_strip||[]).length;
        process.stdout.write('valid JSON (' + sc + ' system_strip, ' + mc + ' message_strip pattern(s); suffix_only=' + !!raw.suffix_only + ')');
      } catch(e) { process.stderr.write(e.message); process.exit(1); }
    " "$NORM" 2>/tmp/llm_validate_err)
    if [ $? -eq 0 ]; then
      echo "  ✓ normalize.json — $norm_err"
    else
      echo "  ✗ normalize.json — $(cat /tmp/llm_validate_err 2>/dev/null)"
      errors=$((errors+1))
    fi
    rm -f /tmp/llm_validate_err
  else
    echo "  ✓ normalize.json — not present (partial caching disabled)"
  fi

  # prices.json
  local PRICES="$HOME/.llm-cache-a/prices.json"
  if [ -f "$PRICES" ]; then
    local prices_out prices_err
    prices_out=$("$NODE_BIN" -e "
      try {
        const raw = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
        if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('must be a JSON object');
        for (const [k,v] of Object.entries(raw)) {
          if (!Array.isArray(v)||v.length!==2||v.some(n=>typeof n!=='number'))
            throw new Error('\"' + k + '\" must be [inputPricePerToken, outputPricePerToken]');
        }
        process.stdout.write('valid JSON (' + Object.keys(raw).length + ' model override(s))');
      } catch(e) { process.stderr.write(e.message); process.exit(1); }
    " "$PRICES" 2>/tmp/llm_validate_err)
    if [ $? -eq 0 ]; then
      echo "  ✓ prices.json — $prices_out"
    else
      echo "  ✗ prices.json — $(cat /tmp/llm_validate_err 2>/dev/null)"
      errors=$((errors+1))
    fi
    rm -f /tmp/llm_validate_err
  else
    echo "  ✓ prices.json — not present (built-in haiku/sonnet/opus prices used)"
  fi

  # Runtime checks
  echo ""
  echo "Runtime (proxy at :${PORT}):"
  local health_code
  health_code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${PORT}/health" 2>/dev/null || echo "000")
  case "$health_code" in
    200)
      echo "  ✓ GET /health → 200"

      local stats_body stats_code stats_summary
      stats_body=$(curl -s -w "\n__STATUS__%{http_code}" ${AUTH_HDR[@]+"${AUTH_HDR[@]}"} "http://localhost:${PORT}/stats" 2>/dev/null || echo "")
      stats_code=$(printf '%s' "$stats_body" | grep -o '__STATUS__[0-9]*' | grep -o '[0-9]*')
      if [ "$stats_code" = "200" ]; then
        stats_summary=$(printf '%s' "$stats_body" | grep -v '__STATUS__' | "$NODE_BIN" -e '
          let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
            try { const j=JSON.parse(s); process.stdout.write(j.calls+" calls, "+j.hits+" hits, "+j.hit_rate_pct+"% hit rate, cache "+j.cache); }
            catch { process.stdout.write("(parse error)"); }
          });
        ' 2>/dev/null || echo "(parse error)")
        echo "  ✓ GET /stats → 200 ($stats_summary)"
      else
        echo "  ✗ GET /stats → ${stats_code:-no response}"
        errors=$((errors+1))
      fi

      local metrics_code
      metrics_code=$(curl -s -o /dev/null -w "%{http_code}" ${AUTH_HDR[@]+"${AUTH_HDR[@]}"} "http://localhost:${PORT}/metrics" 2>/dev/null || echo "000")
      if [ "$metrics_code" = "200" ]; then
        echo "  ✓ GET /metrics → 200 (Prometheus format)"
      else
        echo "  ✗ GET /metrics → ${metrics_code:-no response}"
        errors=$((errors+1))
      fi ;;
    000)
      echo "  - proxy not running (skipping runtime checks)" ;;
    *)
      echo "  ✗ GET /health → $health_code"
      errors=$((errors+1)) ;;
  esac

  echo ""
  if [ "$errors" -eq 0 ] && [ "$warns" -eq 0 ]; then
    echo "Result: all checks passed ✓"
  elif [ "$errors" -eq 0 ]; then
    echo "Result: $warns warning(s) — review above"
  else
    echo "Result: $errors error(s), $warns warning(s)"
  fi
  [ "$errors" -eq 0 ]
}

# Show the full usage guide (USAGE.md), paged on a TTY; fall back to a one-liner if it's missing.
_usage() {
  if [ -f "$REPO/USAGE.md" ]; then
    if [ -t 1 ] && command -v less >/dev/null 2>&1; then less -R "$REPO/USAGE.md"; else cat "$REPO/USAGE.md"; fi
  else
    echo "usage: $0 {on|off|restart|stop|validate|stats|status|monitor|explore|setup|run|install|uninstall}" >&2
    echo "  (full guide USAGE.md not found next to the script)" >&2
  fi
}

_start() {
  if [ -z "${ANTHROPIC_API_KEY_REAL:-}" ]; then
    if [ -t 0 ]; then _setup; [ -f .env ] && { set -a; . ./.env; set +a; }; fi
    [ -n "${ANTHROPIC_API_KEY_REAL:-}" ] || { echo "ERROR: ANTHROPIC_API_KEY_REAL not set (run: $0 setup)." >&2; exit 1; }
  fi
  _stop
  echo "Starting Option A proxy on :$PORT (cache $1) ..."
  CACHE_OFF="$2" nohup node proxy-a.mjs > "$LOGFILE" 2>&1 &
  echo $! > "$PIDFILE"
  for i in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/health" 2>/dev/null || true)
    [ "$code" = "200" ] && { echo "READY after ${i}s (pid $(cat "$PIDFILE"))."; break; }
    kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "proxy died — see $LOGFILE" >&2; cat "$LOGFILE"; return 1; }
    sleep 1
  done
  # Re-enable the launchd agent so crash-restart still works (we unloaded it in _stop).
  local PL="$HOME/Library/LaunchAgents/com.llm-cache-proxy.plist"
  if command -v launchctl >/dev/null 2>&1 && [ -f "$PL" ]; then
    launchctl load -w "$PL" 2>/dev/null || true
  fi
  echo "Point Claude Code at it:"
  echo "  export ANTHROPIC_BASE_URL=http://localhost:$PORT"
  echo "  export ANTHROPIC_API_KEY=anything   # Option A ignores client key; uses .env real key"
}

case "${1:-}" in
  help|-h|--help|'-?') _usage; exit 0 ;;
  on)      _start ON "0" ;;
  off)     _start OFF "1" ;;     # bypass: forwards everything, caches nothing
  restart) _stop; _start ON "0" ;;
  validate) _validate ;;
  stop)
    # Also unload the launchd agent so it doesn't restart after kill (use 'install' to re-enable at boot).
    PL="$HOME/Library/LaunchAgents/com.llm-cache-proxy.plist"
    command -v launchctl >/dev/null 2>&1 && [ -f "$PL" ] && launchctl unload "$PL" 2>/dev/null || true
    _stop
    echo "stopped." ;;
  stats)
    # Prefer the live /stats endpoint (this-session + all-time); fall back to the metrics log.
    live=$(curl -s ${AUTH_HDR[@]+"${AUTH_HDR[@]}"} "http://localhost:$PORT/stats" 2>/dev/null || true)
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

    # 1) process up? — check pidfile first; fall back to pgrep (catches launchd-managed restarts
    #    where the pidfile holds a stale pre-reboot PID)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      pid=$(cat "$PIDFILE")
      since=$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//' || true)
      echo "process:         RUNNING (pid $pid${since:+, since $since})"
    else
      live_pid=$(pgrep -f 'proxy-a.mjs' 2>/dev/null | head -1 || true)
      if [ -n "$live_pid" ]; then
        since=$(ps -p "$live_pid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//' || true)
        echo "process:         RUNNING via launchd (pid $live_pid${since:+, since $since}) — pidfile stale; run '$0 on' to re-register"
        echo "$live_pid" > "$PIDFILE"   # update pidfile so future status/stop calls are correct
      else
        echo "process:         NOT RUNNING"
      fi
    fi

    # 2) accepting calls? (and 3) cache on/off) — straight from the live endpoints
    live=$(curl -s ${AUTH_HDR[@]+"${AUTH_HDR[@]}"} "http://localhost:$PORT/stats" 2>/dev/null || true)
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
  monitor)
    # Realtime view: tail the proxy's /monitor SSE stream, one readable line per call.
    echo "live monitor — http://localhost:$PORT/monitor  (Ctrl-C to stop)"
    curl -sN ${AUTH_HDR[@]+"${AUTH_HDR[@]}"} "http://localhost:$PORT/monitor" | while IFS= read -r line; do
      case "$line" in
        data:*) printf '%s' "${line#data: }" | node -e '
          let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
            let e; try { e = JSON.parse(s); } catch { return; }
            if (e.type === "connected") { console.log("  (connected — waiting for calls)"); return; }
            const t = new Date(e.t).toISOString().slice(11, 19);
            const seq = e.seq != null ? `#${String(e.seq).padStart(4,"0")}` : "     ";
            const tok = (e.in || 0) + (e.out || 0);
            const usd = e.usd != null ? `  $${(+e.usd).toFixed(5)}` : "";
            const ms  = e.ms  != null ? `  ${e.ms}ms` : "";
            const extra = e.type === "ERROR"
              ? `  err: ${e.err || "?"}`
              : (e.snippet ? `  | ${e.snippet.replace(/\n/g," ").slice(0,60)}` : "");
            console.log(`  ${t}  ${seq}  ${String(e.type).padEnd(15)} ${String(e.model || "?").slice(0, 28).padEnd(28)} ${String(tok).padStart(5)}tok${usd}${ms}${extra}`);
          });' ;;
      esac
    done ;;
  setup)     _setup ;;
  install)   _install ;;
  uninstall) _uninstall ;;
  explore)   exec "$NODE_BIN" "$REPO/cache-explorer.mjs" "${@:2}" ;;   # TUI by default; pass --list/--json/--invalidate <key>
  run)
    # Foreground exec for a service manager (systemd/launchd ExecStart).
    [ -n "${ANTHROPIC_API_KEY_REAL:-}" ] || { echo "ANTHROPIC_API_KEY_REAL not set (run: $0 setup)." >&2; exit 1; }
    exec "$NODE_BIN" "$PROXY" ;;
  '') _usage; exit 1 ;;                              # no command
  *)  echo "unknown command: $1" >&2; _usage; exit 1 ;;   # unknown flag/command -> full guide
esac
