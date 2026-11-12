#!/usr/bin/env bash
# cachectl-a.sh — control the Option A zero-dep Node cache proxy.
#   ./cachectl-a.sh on | off | stop | stats | status | monitor | explore
#                   setup | run | install | uninstall | -h|--help (full guide: USAGE.md)
# Parses ANTHROPIC_API_KEY_REAL (+ other CACHE_* settings) from ./.env as data.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"
NODE_BIN="$(command -v node || echo node)"
NODE_BIN="$("$NODE_BIN" -p 'process.execPath')"
PROXY="$REPO/proxy-a.mjs"
PIDFILE="$HOME/.llm-cache-a/proxy.pid"
METRICS="$HOME/.llm-cache-a/metrics.jsonl"
LOGFILE="$HOME/.llm-cache-a/proxy.log"

# Treat .env as data. Sourcing wizard answers executes substitutions in credentials.
_load_env() {
  [ -f "$REPO/.env" ] || return 0
  local dump name value
  dump=$(umask 077; mktemp "${TMPDIR:-/tmp}/lcp-env.XXXXXX")
  if ! "$NODE_BIN" "$REPO/lib/controller.mjs" env-read "$REPO/.env" > "$dump"; then
    rm -- "$dump"
    echo "ERROR: invalid .env configuration." >&2
    return 1
  fi
  while IFS= read -r -d '' name && IFS= read -r -d '' value; do
    case "$name" in ANTHROPIC_API_KEY_REAL|CACHE_*) export "$name=$value" ;; esac
  done < "$dump"
  rm -- "$dump"
}

_refresh_settings() {
  PORT="${CACHE_PORT:-4000}"
  local host="${CACHE_HOST:-127.0.0.1}"
  case "$host" in 0.0.0.0) host=127.0.0.1 ;; ::) host=::1 ;; esac
  case "$host" in *:*) host="[$host]" ;; esac
  BASE_URL="http://$host:$PORT"
  AUTH_HDR=()
  [ -z "${CACHE_AUTH_TOKEN:-}" ] || AUTH_HDR=(-H "x-cache-auth: ${CACHE_AUTH_TOKEN}")
}

_curl() { curl --noproxy '*' --connect-timeout 2 --max-time 5 "$@"; }
_owned_pid() {
  local pid="$1"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  [ "$pid" -gt 1 ] || return 1
  "$NODE_BIN" --input-type=module -e '
    import { pathToFileURL } from "node:url";
    const { processCommand, isProxyCommand } = await import(pathToFileURL(process.argv[2]));
    try { process.exit(isProxyCommand(processCommand(Number(process.argv[3])), process.argv[4]) ? 0 : 1); }
    catch { process.exit(1); }
  ' shell-pid "$REPO/lib/controller.mjs" "$pid" "$PROXY"
}

_owned_service() {
  [ -f "$1" ] || return 1
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const [file, script, proxy] = process.argv.slice(1);
    const text = fs.readFileSync(file, "utf8");
    const xml = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\u0027/g, "&apos;");
    const unit = JSON.stringify(script.replace(/%/g, "%%").replace(/\$/g, "$$$$"));
    process.exit(text.includes(">" + xml(script) + "<") || text.includes(unit + " run") || text.includes(" " + proxy + "</string>") ? 0 : 1);
  ' "$1" "$REPO/cachectl-a.sh" "$PROXY"
}

_load_env
_refresh_settings
mkdir -p "$HOME/.llm-cache-a"

_stop() {
  # On macOS with a launchd agent installed, unload the plist first so launchd
  # doesn't immediately restart the process we're about to kill (→ EADDRINUSE race).
  local PL="$HOME/Library/LaunchAgents/com.llm-cache-proxy.plist"
  if command -v launchctl >/dev/null 2>&1 && _owned_service "$PL"; then
    launchctl unload "$PL" 2>/dev/null || true
  fi
  local unit="$HOME/.config/systemd/user/llm-cache-proxy.service"
  if [ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null 2>&1 && _owned_service "$unit"; then
    systemctl --user stop llm-cache-proxy.service || return 1
  fi
  local pid=""
  [ ! -f "$PIDFILE" ] || pid=$(cat "$PIDFILE")
  if _owned_pid "$pid"; then kill "$pid" 2>/dev/null || true; fi
  rm -f "$PIDFILE"
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
    echo "Replacing the configured key; other optional settings will be preserved."
  fi
  printf "Anthropic API key (sk-ant-...): "; read -r -s KEY; printf '\n'
  [ -n "$KEY" ] || { echo "no key entered — aborting." >&2; return 1; }
  printf "Port [4000]: ";               read -r P; P="${P:-4000}"
  printf "Cache TTL seconds [604800]: "; read -r T; T="${T:-604800}"
  printf "Max cache entries [5000]: ";   read -r M; M="${M:-5000}"
  printf "Bind host [127.0.0.1] (0.0.0.0 exposes it to the network — needs a token): "; read -r H; H="${H:-127.0.0.1}"
  case "$P:$T:$M" in *[!0-9:]*) echo "port, TTL, and entry count must be positive integers." >&2; return 1 ;; esac
  if [ "$P" -lt 1 ] || [ "$P" -gt 65535 ] || [ "$T" -lt 1 ] || [ "$M" -lt 1 ]; then
    echo "port must be 1-65535; TTL and entry count must be positive." >&2; return 1
  fi
  TOK=""
  case "$H" in
    127.0.0.1|::1|localhost) ;;
    *) printf "Auth token (required for a non-loopback host) [random]: "; read -r TOK
       [ -n "$TOK" ] || TOK=$("$NODE_BIN" -e 'process.stdout.write(require("crypto").randomBytes(18).toString("hex"))')
       echo "  clients must send x-cache-auth with the configured token." ;;
  esac
  ( umask 077
    printf '%s\0' "$KEY" "$P" "$T" "$M" "$H" "$TOK" | "$NODE_BIN" --input-type=module -e '
      import { pathToFileURL } from "node:url";
      import fs from "node:fs";
      const { parseEnvText, writeEnvFile } = await import(pathToFileURL(process.argv[2]));
      const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
      const values = Buffer.concat(chunks).toString().split("\0");
      const names = ["ANTHROPIC_API_KEY_REAL", "CACHE_PORT", "CACHE_TTL_SEC", "CACHE_MAX_ENTRIES", "CACHE_HOST", "CACHE_AUTH_TOKEN"];
      const previous = fs.existsSync(process.argv[3]) ? parseEnvText(fs.readFileSync(process.argv[3], "utf8")) : {};
      writeEnvFile(process.argv[3], { ...previous, ...Object.fromEntries(names.map((name, i) => [name, values[i]])) });
    ' shell-setup "$REPO/lib/controller.mjs" "$REPO/.env" )
  chmod 600 .env
  echo "Wrote ./.env (chmod 600, gitignored). Start it with:  $0 on"
}

_write_launchd_plist() {
  local plist="$HOME/Library/LaunchAgents/com.llm-cache-proxy.plist"
  mkdir -p "$(dirname "$plist")"
  "$NODE_BIN" - "$plist" "$REPO/cachectl-a.sh" "$LOGFILE" "${1:-0}" "$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin" <<'NODE'
const fs = require('node:fs');
const [file, script, log, mode, toolPath] = process.argv.slice(2);
const xml = value => value.replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[c]));
const args = ['/bin/bash', script, 'run', mode].map(arg => `<string>${xml(arg)}</string>`).join('');
fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.llm-cache-proxy</string>
<key>ProgramArguments</key><array>${args}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(toolPath)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>\n`, {mode: 0o600});
NODE
}

_write_systemd_unit() {
  local unit="$HOME/.config/systemd/user/llm-cache-proxy.service"
  mkdir -p "$(dirname "$unit")"
  "$NODE_BIN" - "$unit" "$REPO" "${1:-0}" "$(dirname "$NODE_BIN"):/usr/bin:/bin" <<'NODE'
const fs = require('node:fs');
const [file, repo, mode, toolPath] = process.argv.slice(2);
const quote = value => JSON.stringify(value.replace(/%/g, '%%'));
const commandArg = value => quote(value.replace(/\$/g, '$$$$'));
fs.writeFileSync(file, `[Unit]
Description=llm-cache-proxy (Anthropic caching reverse proxy)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${quote(repo)}
Environment=${quote('PATH=' + toolPath)}
ExecStart=/bin/bash ${commandArg(repo + '/cachectl-a.sh')} run ${mode}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`, {mode: 0o600});
NODE
}

# Install a boot service that auto-restarts on failure (systemd on Linux, launchd on macOS).
_install() {
  [ -n "${ANTHROPIC_API_KEY_REAL:-}" ] || { echo "set up .env first:  $0 setup" >&2; exit 1; }
  if [ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null 2>&1; then
    _write_systemd_unit
    systemctl --user daemon-reload
    systemctl --user enable --now llm-cache-proxy.service
    loginctl enable-linger "$USER" >/dev/null 2>&1 || true   # let it start at boot before login
    echo "installed systemd user service (start-on-boot + restart-on-failure)."
    echo "  systemctl --user status llm-cache-proxy"
  elif command -v launchctl >/dev/null 2>&1; then
    PL="$HOME/Library/LaunchAgents/com.llm-cache-proxy.plist"; mkdir -p "$(dirname "$PL")"
    _write_launchd_plist
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
      sk-ant-*) echo "  ✓ ANTHROPIC_API_KEY_REAL — set" ;;
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

  local limits_message
  if limits_message=$("$NODE_BIN" --input-type=module -e '
    import { readLimits } from "./lib/proxy-validation.mjs";
    try { readLimits(process.env); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
  ' 2>&1); then
    echo "  ✓ Runtime limits — valid"
  else
    echo "  ✗ Runtime limits — $limits_message"
    errors=$((errors+1))
  fi

  echo "  ✓ CACHE_HOST=${CACHE_HOST:-127.0.0.1}"
  [ -n "${CACHE_AUTH_TOKEN:-}" ] && echo "  ✓ CACHE_AUTH_TOKEN — set (token-gated exposure enabled)"
  case "${CACHE_HOST:-127.0.0.1}" in
    127.0.0.1|::1|localhost) ;;
    *) if [ -z "${CACHE_AUTH_TOKEN:-}" ]; then
         echo "  ✗ CACHE_AUTH_TOKEN — required for a non-loopback host"; errors=$((errors+1))
       fi ;;
  esac

  # normalize.json
  local NORM="$HOME/.llm-cache-a/normalize.json"
  if [ -f "$NORM" ]; then
    local norm_err
    if norm_err=$("$NODE_BIN" -e "
      try {
        const raw = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('must be a JSON object');
        for (const f of ['system_strip','message_strip']) {
          const a = raw[f];
          if (a !== undefined && !Array.isArray(a)) throw new Error(f + ' must be an array');
          if (Array.isArray(a)) a.forEach(p => {
            if (typeof p !== 'string') throw new Error(f + ' patterns must be strings');
            try { new RegExp(p, 'gs'); }
            catch(e) { throw new Error('invalid regex in ' + f + ': ' + JSON.stringify(p)); }
          });
        }
        if (raw.suffix_only !== undefined && typeof raw.suffix_only !== 'boolean') throw new Error('suffix_only must be boolean');
        if (raw.suffix_turns !== undefined && (!Number.isSafeInteger(raw.suffix_turns) || raw.suffix_turns < 1))
          throw new Error('suffix_turns must be a positive integer');
        const sc=(raw.system_strip||[]).length, mc=(raw.message_strip||[]).length;
        process.stdout.write('valid JSON (' + sc + ' system_strip, ' + mc + ' message_strip pattern(s); suffix_only=' + !!raw.suffix_only + ')');
      } catch(e) { process.stderr.write(e.message); process.exit(1); }
    " "$NORM" 2>&1); then
      echo "  ✓ normalize.json — $norm_err"
    else
      echo "  ✗ normalize.json — $norm_err"
      errors=$((errors+1))
    fi
  else
    echo "  ✓ normalize.json — not present (partial caching disabled)"
  fi

  # prices.json
  local PRICES="$HOME/.llm-cache-a/prices.json"
  if [ -f "$PRICES" ]; then
    local prices_out
    if prices_out=$("$NODE_BIN" -e "
      try {
        const raw = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('must be a JSON object');
        for (const [k,v] of Object.entries(raw)) {
          if (!Array.isArray(v)||v.length!==2||v.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0))
            throw new Error('\"' + k + '\" must be [inputPricePerToken, outputPricePerToken]');
        }
        process.stdout.write('valid JSON (' + Object.keys(raw).length + ' model override(s))');
      } catch(e) { process.stderr.write(e.message); process.exit(1); }
    " "$PRICES" 2>&1); then
      echo "  ✓ prices.json — $prices_out"
    else
      echo "  ✗ prices.json — $prices_out"
      errors=$((errors+1))
    fi
  else
    echo "  ✓ prices.json — not present (built-in haiku/sonnet/opus prices used)"
  fi

  # Runtime checks
  echo ""
  echo "Runtime (proxy at :${PORT}):"
  local health_code
  health_code=$(_curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/health" 2>/dev/null || true)
  case "$health_code" in
    200)
      echo "  ✓ GET /health → 200"

      local stats_body stats_code stats_summary
      stats_body=$(_curl -s -w "\n__STATUS__%{http_code}" ${AUTH_HDR[@]+"${AUTH_HDR[@]}"} "${BASE_URL}/stats" 2>/dev/null || echo "")
      stats_code=$(printf '%s' "$stats_body" | grep -o '__STATUS__[0-9]*' | grep -o '[0-9]*' || true)
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
      metrics_code=$(_curl -s -o /dev/null -w "%{http_code}" ${AUTH_HDR[@]+"${AUTH_HDR[@]}"} "${BASE_URL}/metrics" 2>/dev/null || true)
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
    if [ -t 0 ]; then _setup; _load_env; _refresh_settings; fi
    [ -n "${ANTHROPIC_API_KEY_REAL:-}" ] || { echo "ERROR: ANTHROPIC_API_KEY_REAL not set (run: $0 setup)." >&2; exit 1; }
  fi
  _stop
  echo "Starting Option A proxy on :$PORT (cache $1) ..."
  local PL="$HOME/Library/LaunchAgents/com.llm-cache-proxy.plist" ready=0 pid=""
  if [ "$(uname -s)" = Linux ] && command -v systemctl >/dev/null 2>&1 && _owned_service "$HOME/.config/systemd/user/llm-cache-proxy.service"; then
    _write_systemd_unit "$2"
    systemctl --user daemon-reload
    systemctl --user start llm-cache-proxy.service
  elif command -v launchctl >/dev/null 2>&1 && _owned_service "$PL"; then
    # Let one service own the process. Loading after nohup creates two listeners.
    _write_launchd_plist "$2"
    launchctl load -w "$PL"
  else
    CACHE_OFF="$2" nohup "$NODE_BIN" "$PROXY" > "$LOGFILE" 2>&1 &
    echo $! > "$PIDFILE"
  fi
  for i in $(seq 1 10); do
    code=$(_curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health" 2>/dev/null || true)
    [ ! -f "$PIDFILE" ] || pid=$(cat "$PIDFILE")
    if [ "$code" = "200" ] && _owned_pid "$pid"; then
      echo "READY after ${i}s (pid $pid)."; ready=1; break
    fi
    if [ -n "$pid" ] && ! _owned_pid "$pid"; then
      echo "proxy died — see $LOGFILE" >&2; return 1
    fi
    sleep 1
  done
  [ "$ready" -eq 1 ] || { echo "proxy did not become ready — see $LOGFILE" >&2; _stop; return 1; }
  echo "Point Claude Code at it:"
  echo "  export ANTHROPIC_BASE_URL=$BASE_URL"
  echo "  export ANTHROPIC_API_KEY=anything   # Option A ignores client key; uses .env real key"
}

case "${1:-}" in
  help|-h|--help|'-?') _usage; exit 0 ;;
  on)      _start ON "0" ;;
  off)     _start OFF "1" ;;     # bypass: forwards everything, caches nothing
  restart) _stop; _start ON "0" ;;
  validate) _validate ;;
  stop)
    _stop
    echo "stopped." ;;
  stats)
    # Prefer the live /stats endpoint (this-session + all-time); fall back to the metrics log.
    live=$(_curl -s ${AUTH_HDR[@]+"${AUTH_HDR[@]}"} "$BASE_URL/stats" 2>/dev/null || true)
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

    # Never infer ownership from a matching basename or a live, recycled PID.
    pid=""
    [ ! -f "$PIDFILE" ] || pid=$(cat "$PIDFILE")
    if _owned_pid "$pid"; then
      since=$(ps -p "$pid" -o lstart= 2>/dev/null | sed 's/^ *//;s/ *$//' || true)
      echo "process:         RUNNING (pid $pid${since:+, since $since})"
    else
      echo "process:         NOT RUNNING (no verified proxy PID)"
    fi

    # 2) accepting calls? (and 3) cache on/off) — straight from the live endpoints
    live=$(_curl -s ${AUTH_HDR[@]+"${AUTH_HDR[@]}"} "$BASE_URL/stats" 2>/dev/null || true)
    health=$(_curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health" 2>/dev/null || true)
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
      errs=$(grep -Ec '^[^[:space:]]+[[:space:]]+ERR(OR)?([[:space:]]|$)|^ERR(OR)?([[:space:]]|$)' "$LOGFILE" 2>/dev/null || true); errs=${errs:-0}
      echo "errors this run: $errs"
      if [ "$errs" -gt 0 ]; then
        echo "  -- recent errors --"
        grep -E '^[^[:space:]]+[[:space:]]+ERR(OR)?([[:space:]]|$)|^ERR(OR)?([[:space:]]|$)' "$LOGFILE" | tail -n 5 | sed 's/^/  /'
      fi
      echo "  -- recent log (last 15 lines of $LOGFILE) --"
      tail -n 15 "$LOGFILE" | sed 's/^/  /'
    else
      echo "errors this run: (no log file at $LOGFILE — proxy not started via cachectl-a.sh?)"
    fi ;;
  monitor)
    # Realtime view: tail the proxy's /monitor SSE stream, one readable line per call.
    echo "live monitor — $BASE_URL/monitor  (Ctrl-C to stop)"
    curl --noproxy '*' --connect-timeout 2 -sN ${AUTH_HDR[@]+"${AUTH_HDR[@]}"} "$BASE_URL/monitor" | while IFS= read -r line; do
      case "$line" in
        data:*) printf '%s' "${line#data: }" | "$NODE_BIN" -e '
          let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
            let e; try { e = JSON.parse(s); } catch { return; }
            if (e.type === "connected") { console.log("  (connected — waiting for calls)"); return; }
            const terminalSafe = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ch => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`);
            const t = new Date(e.t).toISOString().slice(11, 19);
            const seq = e.seq != null ? `#${terminalSafe(e.seq).padStart(4,"0")}` : "     ";
            const tok = (e.in || 0) + (e.out || 0);
            const usd = e.usd != null ? `  $${(+e.usd).toFixed(5)}` : "";
            const ms  = e.ms  != null ? `  ${terminalSafe(e.ms)}ms` : "";
            const extra = e.type === "ERROR"
              ? `  err: ${terminalSafe(e.err || "?")}`
              : (e.snippet ? `  | ${terminalSafe(e.snippet).slice(0,60)}` : "");
            console.log(`  ${t}  ${seq}  ${terminalSafe(e.type).padEnd(15)} ${terminalSafe(e.model || "?").slice(0, 28).padEnd(28)} ${terminalSafe(tok).padStart(5)}tok${usd}${ms}${extra}`);
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
    [ "$#" -lt 2 ] || export CACHE_OFF="$2"
    echo "$$" > "$PIDFILE"
    exec "$NODE_BIN" "$PROXY" ;;
  '') _usage; exit 1 ;;                              # no command
  *)  echo "unknown command: $1" >&2; _usage; exit 1 ;;   # unknown flag/command -> full guide
esac
